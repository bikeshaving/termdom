import {type Cascade, getComputedValue} from "./cssom.js";
import {
	closeTopmost,
	dispatchAsUserAgent,
	elementAtDocumentPoint,
	type EngineWindow,
	fieldCaretOffset,
	flatParentElement,
	getShadowRoot,
	keyboardActivation,
	lightDismissPress,
	lightDismissRelease,
	lockDataTransfer,
	parkFieldCaret,
	setDocumentFocusVisible,
	setHoveredElement,
	setUASelection,
	topmostModalDialog,
} from "./dom.js";
import type {WireKey, WireMouse, WirePaste} from "./exchange.js";
import type {Layout} from "./layout.js";
import type {Screen} from "./screen.js";
import {render, type TermDOM} from "./termdom.js";

// The keys a terminal names, with the legacy keyCode plenty of code
// still reads. Also the list of names that are physical key identities.
const NAMED_KEY_NUMBERS: Record<string, number> = {
	Enter: 13,
	Tab: 9,
	Backspace: 8,
	Escape: 27,
	ArrowUp: 38,
	ArrowDown: 40,
	ArrowRight: 39,
	ArrowLeft: 37,
	Home: 36,
	End: 35,
	Insert: 45,
	Delete: 46,
	PageUp: 33,
	PageDown: 34,
	F1: 112,
	F2: 113,
	F3: 114,
	F4: 115,
	F5: 116,
	F6: 117,
	F7: 118,
	F8: 119,
	F9: 120,
	F10: 121,
	F11: 122,
	F12: 123,
};

// The DOM `code`, assuming a US layout. A terminal only says what
// character a key produced, never which key, so punctuation is a guess.
function domCodeFor(keyName: string): string {
	if (keyName === " ") {
		return "Space";
	}
	if (keyName in NAMED_KEY_NUMBERS) {
		return keyName;
	}
	if (keyName.length === 1) {
		const upper = keyName.toUpperCase();
		if (upper >= "A" && upper <= "Z") {
			return `Key${upper}`;
		}
		if (keyName >= "0" && keyName <= "9") {
			return `Digit${keyName}`;
		}
	}
	return `Key${keyName.toUpperCase()}`;
}

// The uppercase code for a character, so Ctrl+A and a typed "a" agree.
function legacyKeyCode(keyName: string): number {
	const named = NAMED_KEY_NUMBERS[keyName];
	if (named !== undefined) {
		return named;
	}
	return keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0;
}

// What Tab traverses and what a mousedown focuses.
const FOCUSABLE_SELECTOR =
	'a[href], input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), details > summary:first-of-type, [tabindex]:not([tabindex="-1"])';

// `barrier` is the nearest scope owner above with a negative tabindex.
// The stop cannot be tabbed into from outside, but focus scripted inside
// still navigates among stops behind the same barrier and exits past
// it.
interface SequentialEntry {
	element: Element;
	barrier: Element | null;
}

function getTabIndex(element: Element): number {
	const parsed = parseInt(element.getAttribute("tabindex") || "0", 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

// Every stop under the root, barred ones included, in scoped tab order.
function sequentialFocusEntries(
	root: Document | Element,
	layout: Layout,
): SequentialEntry[] {
	const isRendered = (element: Element): boolean => {
		// A hidden element must not swallow a Tab press invisibly.
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			if (getComputedValue(ancestor, "display") === "none") {
				return false;
			}
		}
		try {
			return layout.getRects(element).length > 0;
		} catch (_err) {
			return false;
		}
	};
	const isInert = (element: Element): boolean => {
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			if (ancestor.hasAttribute("inert")) {
				return true;
			}
		}
		return false;
	};
	const isFocusable = (element: Element): boolean =>
		element.matches(FOCUSABLE_SELECTOR) &&
		getTabIndex(element) >= 0 &&
		!isInert(element) &&
		isRendered(element);

	const buildScope = (
		contents: Iterable<Node>,
		barrier: Element | null,
	): SequentialEntry[] => {
		// A scope owner is one entry representing its whole expansion, placed
		// among its siblings by its own tabindex.
		const entries: Array<{
			tabindex: number;
			sequence: number;
			elements: SequentialEntry[];
		}> = [];
		let sequence = 0;
		const push = (tabindex: number, elements: SequentialEntry[]): void => {
			if (elements.length > 0) {
				entries.push({tabindex, sequence: sequence++, elements});
			}
		};
		const visit = (node: Node): void => {
			if (node.nodeType !== 1) {
				return;
			}
			const element = node as Element;
			const ownerTabindex = getTabIndex(element);
			const shadow = getShadowRoot<ShadowRoot>(element);
			if (shadow !== null) {
				const innerBarrier =
					ownerTabindex < 0 ? (barrier ?? element) : barrier;
				// The host's light children appear through slots or not at all.
				const inner = buildScope(shadow.children, innerBarrier);
				let expansion = inner;
				if (shadow.delegatesFocus !== true && isFocusable(element)) {
					expansion = [{element, barrier}, ...inner];
				}
				push(ownerTabindex, expansion);
				return;
			}
			if (element.localName === "slot") {
				const innerBarrier =
					ownerTabindex < 0 ? (barrier ?? element) : barrier;
				const assigned = (element as HTMLSlotElement).assignedNodes();
				const slotContents =
					assigned.length > 0 ? assigned : element.childNodes;
				const inner = buildScope(
					slotContents as Iterable<Node>,
					innerBarrier,
				);
				const expansion = isFocusable(element)
					? [{element, barrier}, ...inner]
					: inner;
				push(ownerTabindex, expansion);
				return;
			}
			if (isFocusable(element)) {
				push(ownerTabindex, [{element, barrier}]);
			}
			for (const child of element.children) {
				visit(child);
			}
		};
		for (const node of contents) {
			visit(node);
		}
		entries.sort((a, b) => {
			const aTab = a.tabindex > 0 ? a.tabindex : Infinity;
			const bTab = b.tabindex > 0 ? b.tabindex : Infinity;
			if (aTab !== bTab) {
				return aTab - bTab;
			}
			return a.sequence - b.sequence;
		});
		return entries.flatMap((entry) => entry.elements);
	};

	const roots =
		root.nodeType === 9
			? ((root as Document).documentElement
				? [(root as Document).documentElement as Element]
				: [])
			: Array.from((root as Element).children);
	return buildScope(roots, null);
}

const kTermDOM = Symbol("termDOM");
const kLayout = Symbol("layout");
const kCascade = Symbol("cascade");
const kScreen = Symbol("screen");

const kDocument = Symbol("document");

// The nearest scroll container (overflow auto or scroll; hidden does
// not take the wheel) that can still move in the tick's direction, or
// null when the tick chains to the camera.
function wheelScrollerFor(
	input: Input,
	target: Element,
	deltaY: number,
): Element | null {
	const document = input[kDocument];
	const layout = input[kLayout];
	for (
		let element: Element | null = target;
		element &&
		element !== document.body &&
		element !== document.documentElement;
		element = flatParentElement<Element>(element)
	) {
		const overflowY =
			getComputedValue(element, "overflow-y") ||
			getComputedValue(element, "overflow");
		if (overflowY !== "auto" && overflowY !== "scroll") {
			continue;
		}
		if (deltaY < 0) {
			if (element.scrollTop > 0) {
				return element;
			}
			continue;
		}
		const extent = layout.scrollExtentOf(element);
		const port = layout.contentRect(element);
		if (!extent || !port) {
			continue;
		}
		if (element.scrollTop < extent.height - Math.round(port.height)) {
			return element;
		}
	}
	return null;
}

const kWindow = Symbol("window");
const kLastMouse = Symbol("lastMouse");
const kPendingHover = Symbol("pendingHover");
const kHoverElement = Symbol("hoverElement");
const kMouseCaptureYielded = Symbol("mouseCaptureYielded");
const kScrollChainTimer = Symbol("scrollChainTimer");
const kScrollChainTimeoutMs = Symbol("scrollChainTimeoutMs");
const kMouseDownTarget = Symbol("mouseDownTarget");
const kPopoverPressTarget = Symbol("popoverPressTarget");
const kSelectionDragAnchor = Symbol("selectionDragAnchor");
const kFieldDragAnchor = Symbol("fieldDragAnchor");
const kLastClickTarget = Symbol("lastClickTarget");
const kLastClickTime = Symbol("lastClickTime");
const kDblclickIntervalMs = Symbol("dblclickIntervalMs");

export class Input {
	// Reclaims a yield no keystroke reclaimed. A flat window from the
	// yield, not a debounce. Wheel activity while yielded produces no
	// signal, and a gap between ticks longer than this would re-yield on
	// the next tick.
	static readonly [kScrollChainTimeoutMs] = 3000;
	static readonly [kDblclickIntervalMs] = 500;
	declare [kDocument]: Document;
	declare [kWindow]: EngineWindow;
	declare [kTermDOM]: TermDOM;
	declare [kLayout]: Layout;
	declare [kCascade]: Cascade;
	declare [kScreen]: Screen;
	// What movementX/movementY measure from.
	declare [kLastMouse]: {x: number; y: number} | null;
	// Motion coalesced to one hit-test per frame. `quiet` marks a drag's
	// motion, whose mousemove the report already dispatched.
	declare [kPendingHover]: {
		x: number;
		y: number;
		shiftKey: boolean;
		altKey: boolean;
		ctrlKey: boolean;
		quiet: boolean;
	} | null;

	declare [kHoverElement]: Element | null;
	// The camera hit the document top and the user kept scrolling up, so
	// the wheel belongs to the terminal's scrollback until the next
	// keystroke (terminals snap to the live screen on input) or the timer.
	declare [kMouseCaptureYielded]: boolean;
	declare [kScrollChainTimer]: ReturnType<typeof setTimeout> | null;
	// A mouseup on the same element is a click.
	declare [kMouseDownTarget]: Element | null;
	declare [kPopoverPressTarget]: Element | null;
	// The document selection's anchor while a left-button drag selects.
	declare [kSelectionDragAnchor]: {node: Text; offset: number} | null;
	// A drag begun in a field extends the field's own bounded selection,
	// not the document's. The two never merge.
	declare [kFieldDragAnchor]: {
		element: HTMLInputElement | HTMLTextAreaElement;
		offset: number;
	} | null;

	declare [kLastClickTarget]: Element | null;
	declare [kLastClickTime]: number;

	constructor(
		termDOM: TermDOM,
		layout: Layout,
		styles: Cascade,
		screen: Screen,
	) {
		this[kDocument] = termDOM.document;
		this[kWindow] = termDOM.document.defaultView as unknown as EngineWindow;
		this[kTermDOM] = termDOM;
		this[kLayout] = layout;
		this[kCascade] = styles;
		this[kScreen] = screen;
		this[kLastMouse] = null;
		this[kPendingHover] = null;
		this[kHoverElement] = null;
		this[kMouseCaptureYielded] = false;
		this[kScrollChainTimer] = null;
		this[kMouseDownTarget] = null;
		this[kPopoverPressTarget] = null;
		this[kSelectionDragAnchor] = null;
		this[kFieldDragAnchor] = null;
		this[kLastClickTarget] = null;
		this[kLastClickTime] = 0;
	}

	get mouseCaptureYielded(): boolean {
		return this[kMouseCaptureYielded];
	}

	dispose(): void {
		if (this[kScrollChainTimer] !== null) {
			clearTimeout(this[kScrollChainTimer]);
			this[kScrollChainTimer] = null;
		}
	}

	dispatch(item: WireKey[] | WireMouse | WirePaste): void {
		// Pseudo-state and the selection move with no mutation record.
		this[kScreen].invalidate();
		if (Array.isArray(item)) {
			deliverKeys(this, item);
			return;
		}
		if (item.kind === "mouse") {
			deliverMouseReport(this, item);
			return;
		}
		deliverPaste(this, item.text);
	}

	/**
	 * One hit-test at the last reported position, at the start of the frame.
	 */
	resolvePendingHover(): void {
		const pending = this[kPendingHover];
		if (pending === null) {
			return;
		}
		this[kPendingHover] = null;
		const {x, y, shiftKey, altKey, ctrlKey} = pending;
		const target = elementAtDocumentPoint(this[kDocument], x, y) ||
			this[kDocument].body;
		const previous = this[kHoverElement];
		if (target !== previous) {
			this[kHoverElement] = target;
			setHoveredElement(this[kDocument], target);
			this[kCascade].handleHoverChange(previous, target);
			const chainOf = (element: Element | null): Element[] => {
				const chain: Element[] = [];
				for (
					let node: Element | null = element;
					node;
					node = flatParentElement<Element>(node)
				) {
					chain.push(node);
				}
				return chain;
			};
			const previousChain = chainOf(previous);
			const targetChain = chainOf(target);
			const previousSet = new Set(previousChain);
			const targetSet = new Set(targetChain);
			const boundaryInit = {
				button: 0,
				buttons: 0,
				clientX: x,
				clientY: y,
				shiftKey,
				altKey,
				ctrlKey,
			};
			// UI Events' order: out, leave (exited element up), over, enter
			// (outermost entered ancestor down), then mousemove.
			if (previous !== null) {
				dispatchAsUserAgent(
					previous,
					new this[kWindow].MouseEvent("mouseout", {
						...boundaryInit,
						bubbles: true,
						cancelable: true,
						relatedTarget: target,
					}),
				);
				for (const node of previousChain) {
					if (!targetSet.has(node)) {
						dispatchAsUserAgent(
							node,
							new this[kWindow].MouseEvent("mouseleave", {
								...boundaryInit,
								relatedTarget: target,
							}),
						);
					}
				}
			}
			dispatchAsUserAgent(
				target,
				new this[kWindow].MouseEvent("mouseover", {
					...boundaryInit,
					bubbles: true,
					cancelable: true,
					relatedTarget: previous,
				}),
			);
			const entering = targetChain.filter((node) => !previousSet.has(node));
			for (let i = entering.length - 1; i >= 0; i--) {
				dispatchAsUserAgent(
					entering[i],
					new this[kWindow].MouseEvent("mouseenter", {
						...boundaryInit,
						relatedTarget: previous,
					}),
				);
			}
		}
		if (!pending.quiet) {
			const last = this[kLastMouse];
			dispatchAsUserAgent(
				target,
				new this[kWindow].MouseEvent("mousemove", {
					button: 0,
					buttons: 0,
					clientX: x,
					clientY: y,
					movementX: last === null ? 0 : x - last.x,
					movementY: last === null ? 0 : y - last.y,
					shiftKey,
					altKey,
					ctrlKey,
					bubbles: true,
					cancelable: true,
				}),
			);
			this[kLastMouse] = {x, y};
		}
	}
}

function deliverMouseReport(
	input: Input,
	{button: code, col, row, release: isRelease}: WireMouse,
): void {
	const {
		shiftKey,
		altKey,
		ctrlKey,
		isMotion,
		base,
		wheelDeltaY,
		button,
		buttons,
	} = decodeMouseReport(code, isRelease);

	const {x, y, inDocument} = documentPointAt(input, col, row);

	// A report arrives per cell crossed, so motion is coalesced to one
	// hit-test per frame. A drag's motion also falls through. Its mousemove
	// and selection updates are per report.
	if (isMotion) {
		input[kPendingHover] = {
			x,
			y,
			shiftKey,
			altKey,
			ctrlKey,
			quiet: base <= 2,
		};
		if (base > 2) {
			void render(input[kTermDOM]);
			return;
		}
	}

	const target =
		(inDocument && elementAtDocumentPoint(input[kDocument], x, y)) ||
		input[kDocument].body;

	if (wheelDeltaY !== null) {
		const notCanceled = dispatchAsUserAgent(
			target,
			new input[kWindow].WheelEvent("wheel", {
				deltaY: wheelDeltaY,
				deltaMode: 1,
				clientX: x,
				clientY: y,
				shiftKey,
				altKey,
				ctrlKey,
				bubbles: true,
				cancelable: true,
			}),
		);
		if (notCanceled && scrollByWheel(input, target, wheelDeltaY)) {
			// Scroll chaining. The parent scroller is the terminal's own
			// scrollback, so the mouse is yielded to it. preventDefault on the
			// wheel event opts out, as in a browser.
			input[kMouseCaptureYielded] = true;
			void render(input[kTermDOM]);
			if (input[kScrollChainTimer] !== null) {
				clearTimeout(input[kScrollChainTimer]);
			}
			input[kScrollChainTimer] = setTimeout(() => {
				input[kScrollChainTimer] = null;
				reclaimMouseCapture(input);
			}, Input[kScrollChainTimeoutMs]);
		}
		return;
	}

	// SGR names the button even on release, so 3 (no button) carries
	// nothing.
	if (base > 2) {
		return;
	}
	const last = input[kLastMouse];
	const eventInit = {
		button,
		buttons,
		clientX: x,
		clientY: y,
		movementX: last === null ? 0 : x - last.x,
		movementY: last === null ? 0 : y - last.y,
		shiftKey,
		altKey,
		ctrlKey,
		bubbles: true,
		cancelable: true,
	};
	input[kLastMouse] = {x, y};

	if (isMotion) {
		dispatchAsUserAgent(
			target,
			new input[kWindow].MouseEvent("mousemove", eventInit),
		);
		dragTo(input, x, y, inDocument);
		return;
	}

	if (!isRelease) {
		press(input, target, base, x, y, inDocument, eventInit);
		return;
	}

	release(input, target, eventInit);
}

function deliverPaste(input: Input, text: string): void {
	// A terminal pastes line breaks as CR (tmux documents the replacement).
	// The DOM's paste carries LF.
	text = text.replace(/\r\n?/g, "\n");
	const focused = input[kDocument].activeElement;
	const target =
		focused && focused !== input[kDocument].body
			? focused
			: input[kDocument].body;
	const clipboardData = new input[kWindow].DataTransfer();
	clipboardData.setData("text/plain", text);
	lockDataTransfer(clipboardData);
	const proceed = dispatchAsUserAgent(
		target,
		new input[kWindow].ClipboardEvent("paste", {
			clipboardData,
			bubbles: true,
			cancelable: true,
		}),
	);
	const tag = target.tagName;
	if (proceed && (tag === "INPUT" || tag === "TEXTAREA")) {
		dispatchAsUserAgent(
			target,
			new input[kWindow].InputEvent("beforeinput", {
				inputType: "insertFromPaste",
				data: text,
				bubbles: true,
				cancelable: true,
			}),
		);
	}
	void render(input[kTermDOM]);
}

// A keystroke also means the terminal has snapped back to the live
// screen.
function deliverKeys(input: Input, keys: WireKey[]): void {
	if (input[kMouseCaptureYielded]) {
		reclaimMouseCapture(input);
	}
	for (const key of keys) {
		dispatchKey(input, key);
	}
}

function decodeMouseReport(code: number, isRelease: boolean): {
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	isMotion: boolean;
	// The button or wheel code without the modifier and motion bits.
	base: number;
	// One notch is three rows, the browser's line-mode convention.
	wheelDeltaY: number | null;
	// Valid when base <= 2.
	button: number;
	buttons: number;
} {
	const shiftKey = (code & 4) !== 0;
	const altKey = (code & 8) !== 0;
	const ctrlKey = (code & 16) !== 0;
	const isMotion = (code & 32) !== 0;
	const base = code & ~(4 | 8 | 16 | 32);

	const wheelDeltaY = base === 64 ? -3 : base === 65 ? 3 : null;

	const button = base === 1 ? 1 : base === 2 ? 2 : 0;
	const buttons = isRelease ? 0 : base === 1 ? 4 : base === 2 ? 2 : 1;

	return {
		shiftKey,
		altKey,
		ctrlKey,
		isMotion,
		base,
		wheelDeltaY,
		button,
		buttons,
	};
}

function documentPointAt(
	input: Input,
	col: number,
	row: number,
): {
	x: number;
	y: number;
	// False above the painted region, meaning a shell prompt's rows.
	inDocument: boolean;
} {
	const screen = input[kScreen];
	const documentRow =
		input[kDocument].fullscreenElement !== null
			? row - 1 + screen.anchorScrollTop
			: row - 1 - screen.documentTop + screen.scrollTop;
	const inDocument = documentRow >= 0;
	return {x: col - 1, y: inDocument ? documentRow : 0, inDocument};
}

// True when the tick escaped past every scroller and the camera.
function scrollByWheel(
	input: Input,
	target: Element,
	deltaY: number,
): boolean {
	const scroller = wheelScrollerFor(input, target, deltaY);
	if (scroller) {
		scroller.scrollTop += deltaY;
		return false;
	}
	const termDOM = input[kTermDOM];
	if (
		deltaY < 0 &&
		input[kScreen].scrollTop === 0 &&
		input[kDocument].fullscreenElement === null
	) {
		return true;
	}
	input[kScreen].scrollTo(input[kScreen].scrollTop + deltaY);
	void render(termDOM);
	return false;
}

function reclaimMouseCapture(input: Input): void {
	if (input[kScrollChainTimer] !== null) {
		clearTimeout(input[kScrollChainTimer]);
		input[kScrollChainTimer] = null;
	}
	input[kMouseCaptureYielded] = false;
	void render(input[kTermDOM]);
}

function dragTo(
	input: Input,
	x: number,
	y: number,
	inDocument: boolean,
): void {
	// Clamped into the field, whichever element the pointer is over now.
	if (input[kFieldDragAnchor] && inDocument) {
		const {element: fieldElement, offset: anchor} = input[kFieldDragAnchor];
		const focus = fieldCaretOffset(fieldElement, x, y);
		if (focus !== null) {
			setUASelection(
				fieldElement,
				Math.min(anchor, focus),
				Math.max(anchor, focus),
				focus < anchor ? "backward" : "forward",
			);
			void render(input[kTermDOM]);
		}
		return;
	}
	// Over a textless stretch or user-select: none, the focus stays put.
	if (
		input[kSelectionDragAnchor] && input[kMouseDownTarget] && inDocument
	) {
		const focus = textPositionAt(input, x, y);
		if (focus && selectable(input, focus)) {
			const anchor = input[kSelectionDragAnchor];
			input[kWindow]
				.getSelection()
				?.setBaseAndExtent(
					anchor.node,
					anchor.offset,
					focus.node,
					focus.offset,
				);
			void render(input[kTermDOM]);
		}
	}
}

function press(
	input: Input,
	target: Element,
	base: number,
	x: number,
	y: number,
	inDocument: boolean,
	eventInit: object,
): void {
	input[kMouseDownTarget] = target;
	// Light dismiss is a press and a release in the same place, so a drag
	// out of a popover does not close it.
	input[kPopoverPressTarget] = lightDismissPress(target);
	input[kFieldDragAnchor] = null;
	if (setDocumentFocusVisible(input[kDocument], false)) {
		input[kCascade].handleFocusChange(
			input[kDocument].activeElement,
		);
		void render(input[kTermDOM]);
	}
	const notCanceled = dispatchAsUserAgent(
		target,
		new input[kWindow].MouseEvent("mousedown", eventInit),
	);
	if (!notCanceled) {
		return;
	}
	// Default action: focus the nearest focusable ancestor, or blur.
	const focusable = target.closest(FOCUSABLE_SELECTOR);
	const active = input[kDocument].activeElement;
	if (focusable && focusable !== active) {
		(focusable as HTMLElement).focus();
		void render(input[kTermDOM]);
	} else if (!focusable && active && active !== input[kDocument].body) {
		(active as HTMLElement).blur();
		void render(input[kTermDOM]);
	}

	// Default action: a press in a field places the caret and anchors a
	// field drag. The select widget's own mousedown listener ran above.
	const parked =
		base === 0 && inDocument ? parkFieldCaret(target, x, y) : null;
	if (parked) {
		input[kFieldDragAnchor] = {
			element: parked.field as HTMLInputElement | HTMLTextAreaElement,
			offset: parked.offset,
		};
		// The document selection still clears, as in a browser.
		const docSelection = input[kWindow].getSelection();
		if (docSelection && !docSelection.isCollapsed) {
			docSelection.removeAllRanges();
		}
		void render(input[kTermDOM]);
	}

	// Default action: collapse the document selection at the press and
	// anchor a drag there. Left button only. preventDefault opts out.
	const selection = input[kWindow].getSelection();
	if (base === 0 && selection && !input[kFieldDragAnchor]) {
		let anchor = inDocument ? textPositionAt(input, x, y) : null;
		if (anchor && !selectable(input, anchor)) {
			anchor = null;
		}
		const hadSelection = !selection.isCollapsed;
		input[kSelectionDragAnchor] = anchor;
		if (anchor) {
			selection.setBaseAndExtent(
				anchor.node,
				anchor.offset,
				anchor.node,
				anchor.offset,
			);
		} else if (selection.rangeCount > 0) {
			selection.removeAllRanges();
		}
		if (hadSelection) {
			void render(input[kTermDOM]);
		}
	}
}

function release(
	input: Input,
	target: Element,
	eventInit: object,
): void {
	dispatchAsUserAgent(
		target,
		new input[kWindow].MouseEvent("mouseup", eventInit),
	);
	// Before the click, as in a browser.
	lightDismissRelease(target, input[kPopoverPressTarget]);
	input[kPopoverPressTarget] = null;
	let selectedByDrag = false;
	input[kFieldDragAnchor] = null;
	if (input[kSelectionDragAnchor]) {
		input[kSelectionDragAnchor] = null;
		const text = input[kWindow].getSelection()?.toString() ?? "";
		if (text.length > 0) {
			selectedByDrag = true;
		}
	}
	// A selecting drag is not a click. Released over a label, the click
	// would toggle its checkbox and a framework's re-render would destroy
	// the selection just made.
	if (selectedByDrag) {
		input[kMouseDownTarget] = null;
		return;
	}
	if (input[kMouseDownTarget] === target) {
		dispatchAsUserAgent(
			target,
			new input[kWindow].MouseEvent("click", {...eventInit, buttons: 0}),
		);
		// A label's click focuses its control (the browser's focusing steps,
		// which activation alone does not do), and a .checked flip is a
		// property change no mutation record repaints.
		const isCheckable = (el: unknown): el is HTMLInputElement =>
			el instanceof (input[kWindow] as any).HTMLInputElement &&
			((el as HTMLInputElement).type === "checkbox" ||
				(el as HTMLInputElement).type === "radio");
		const control = isCheckable(target)
			? target
			: target instanceof (input[kWindow] as any).HTMLLabelElement &&
				isCheckable((target as any).control)
				? ((target as any).control as HTMLInputElement)
				: null;
		if (control) {
			control.focus();
			void render(input[kTermDOM]);
		}

		// In addition to its own click. Reset so a third click starts a pair.
		const now = performance.now();
		if (
			input[kLastClickTarget] === target &&
			now - input[kLastClickTime] <= Input[kDblclickIntervalMs]
		) {
			dispatchAsUserAgent(
				target,
				new input[kWindow].MouseEvent("dblclick", {
					...eventInit,
					buttons: 0,
				}),
			);
			input[kLastClickTarget] = null;
			input[kLastClickTime] = 0;
		} else {
			input[kLastClickTarget] = target;
			input[kLastClickTime] = now;
		}
	}
	input[kMouseDownTarget] = null;
}

function dispatchKey(input: Input, stroke: WireKey): void {
	const {key: keyName, char, shiftKey, ctrlKey, altKey, metaKey} = stroke;
	const keyCode = legacyKeyCode(keyName);

	if (setDocumentFocusVisible(input[kDocument], true)) {
		input[kCascade].handleFocusChange(
			input[kDocument].activeElement,
		);
		void render(input[kTermDOM]);
	}

	// A fullscreen element is usually not focusable, so keydown falls back
	// to it before the body.
	const active = input[kDocument].activeElement;
	const targetElement =
		active && active !== input[kDocument].body
			? active
			: input[kDocument].fullscreenElement || input[kDocument].body;

	const keydownEvent = new input[kWindow].KeyboardEvent("keydown", {
		key: keyName,
		code: domCodeFor(keyName),
		keyCode,
		charCode: 0,
		which: keyCode,
		ctrlKey,
		shiftKey,
		altKey,
		metaKey,
		bubbles: true,
		cancelable: true,
	});

	const notCanceled = dispatchAsUserAgent(targetElement, keydownEvent);

	// A close request on the top of the top layer, whether or not keydown
	// was canceled. It does not exit fullscreen. The alternate screen takes
	// nothing from the user, and terminal convention gives Escape to the
	// app.
	if (keyName === "Escape") {
		if (closeTopmost(input[kDocument])) {
			void render(input[kTermDOM]);
			return;
		}
	}

	if (notCanceled) {
		if (keyName === "Tab") {
			moveFocus(input, shiftKey);
		}

		// Field editing is each widget's own keydown listener, run above.
		const activation = keyboardActivation(targetElement);
		if (activation) {
			if (
				(keyName === "Enter" && activation.enter) ||
				(keyName === " " && activation.space)
			) {
				// A trusted click, so the full activation behavior runs.
				dispatchAsUserAgent(
					targetElement,
					new input[kWindow].PointerEvent("click", {
						bubbles: true,
						cancelable: true,
						composed: true,
					}),
				);
				void render(input[kTermDOM]);
			}
		}
	}

	// Inserting the character is keypress's default action, so a field's
	// input event follows keypress, as in a browser.
	if (notCanceled && char !== "") {
		const charCode = char.codePointAt(0)!;
		const keypressEvent = new input[kWindow].KeyboardEvent("keypress", {
			key: char,
			code: domCodeFor(char),
			keyCode: charCode,
			charCode,
			which: charCode,
			ctrlKey,
			shiftKey,
			altKey,
			metaKey,
			bubbles: true,
			cancelable: true,
		});
		if (dispatchAsUserAgent(targetElement, keypressEvent)) {
			insertText(input, targetElement, char);
		}
	}

	const keyupEvent = new input[kWindow].KeyboardEvent("keyup", {
		key: keyName,
		code: domCodeFor(keyName),
		keyCode,
		charCode: 0,
		which: keyCode,
		ctrlKey,
		shiftKey,
		altKey,
		metaKey,
		bubbles: true,
		cancelable: true,
	});
	dispatchAsUserAgent(targetElement, keyupEvent);
}

function insertText(
	input: Input,
	target: Element,
	text: string,
): void {
	const tag = target.tagName;
	if (tag !== "INPUT" && tag !== "TEXTAREA") {
		return;
	}
	dispatchAsUserAgent(
		target,
		new input[kWindow].InputEvent("beforeinput", {
			inputType: "insertText",
			data: text,
			bubbles: true,
			cancelable: true,
		}),
	);
}

function moveFocus(input: Input, reverse: boolean): void {
	// Tab cannot leave a modal dialog.
	const scope = topmostModalDialog(input[kDocument]) ?? input[kDocument];
	const entries = sequentialFocusEntries(
		scope,
		input[kLayout],
	);

	// activeElement retargets to the shadow host. Follow it down.
	let current = input[kDocument].activeElement;
	while (current !== null) {
		const shadow = getShadowRoot<ShadowRoot>(current);
		const inner = shadow?.activeElement ?? null;
		if (inner === null) {
			break;
		}
		current = inner;
	}
	const currentIndex = entries.findIndex(
		(entry) => entry.element === current,
	);
	const currentBarrier =
		currentIndex === -1 ? null : entries[currentIndex].barrier;
	// Crossing out of a barrier is the tree exit below. Crossing in never
	// happens.
	const reachable = (index: number): boolean =>
		entries[index].barrier === currentBarrier;
	const step = reverse ? -1 : 1;
	let nextIndex = -1;
	if (currentIndex === -1) {
		for (
			let i = reverse ? entries.length - 1 : 0;
			i >= 0 && i < entries.length;
			i += step
		) {
			if (reachable(i)) {
				nextIndex = i;
				break;
			}
		}
	} else {
		for (
			let i = currentIndex + step;
			i >= 0 && i < entries.length;
			i += step
		) {
			if (reachable(i)) {
				nextIndex = i;
				break;
			}
		}
	}

	// Leaving a barred subtree rejoins plain tree order beside its owner.
	if (nextIndex === -1 && currentBarrier !== null) {
		const FOLLOWING = 4;
		const PRECEDING = 2;
		const wanted = reverse ? PRECEDING : FOLLOWING;
		for (let i = 0; i < entries.length; i++) {
			if (
				entries[i].barrier !== null ||
				(currentBarrier.compareDocumentPosition(entries[i].element) &
					wanted) ===
					0
			) {
				continue;
			}
			if (nextIndex === -1) {
				nextIndex = i;
				continue;
			}
			const beats =
				(entries[i].element.compareDocumentPosition(
					entries[nextIndex].element,
				) &
				wanted) !==
				0;
			if (beats) {
				nextIndex = i;
			}
		}
		// Backward entry into an expansion lands on its last stop.
		if (reverse && nextIndex !== -1) {
			const owner = entries[nextIndex].element;
			const within = (element: Element): boolean => {
				for (
					let ancestor: Element | null = element;
					ancestor;
					ancestor = flatParentElement<Element>(ancestor)
				) {
					if (ancestor === owner) {
						return true;
					}
				}
				return false;
			};
			while (
				nextIndex + 1 < entries.length &&
				entries[nextIndex + 1].barrier === null &&
				within(entries[nextIndex + 1].element)
			) {
				nextIndex++;
			}
		}
	}

	// Past the ends focus rests on nothing, which stands in for the browser
	// chrome. It also keeps a single-stop scope escapable.
	if (nextIndex === -1) {
		if (current !== null) {
			(current as HTMLElement).blur();
		}
		return;
	}

	const next = entries[nextIndex].element as HTMLElement;
	next.focus();
	next.scrollIntoView({block: "nearest"});
	// No mutation record describes a focus move.
	void render(input[kTermDOM]);
}

// Null over a form control. Its value is not document text.
function textPositionAt(
	input: Input,
	x: number,
	y: number,
): {node: Text; offset: number} | null {
	const window = input[kWindow];
	const element = elementAtDocumentPoint(input[kDocument], x, y);
	if (
		!element ||
		element instanceof (window as any).HTMLInputElement ||
		element instanceof (window as any).HTMLTextAreaElement
	) {
		return null;
	}
	return input[kLayout].caretPositionFromPoint(
		x,
		y,
		element,
	);
}

function selectable(
	input: Input,
	position: {node: Text; offset: number},
): boolean {
	const parent = flatParentElement<Element>(position.node);
	return parent === null ||
		input[kCascade].isSelectable(parent);
}
