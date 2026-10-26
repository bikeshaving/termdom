import {
	type Cascade,
	getComputedValue,
	handleActiveChange,
	handleFocusChange,
	handleHoverChange,
} from "./cssom.ts";
import {
	commitRangeThumb,
	constructInternal,
	dispatchAsUserAgent,
	elementAtDocumentPoint,
	flatParentElement,
	flushLayout,
	type FocusStartingPoint,
	getActiveElement,
	getEditingHost,
	getFocusedElement,
	getKeyboardActivation,
	getPointerState,
	getScrollOffset,
	getShadowRoot,
	getTextControlCaretOffset,
	getTextControlValueText,
	getUnitBounds,
	handleCloseRequest,
	HTMLInputElement,
	HTMLLabelElement,
	HTMLTextAreaElement,
	lightDismissPress,
	lightDismissRelease,
	lockDataTransfer,
	MOUSE_POINTER_ID,
	moveRangeThumb,
	placeTextControlCaret,
	requestRender,
	runControlDefaultAction,
	scrollDocumentTo,
	type SelectionUnit,
	selectUnits,
	setActiveElement,
	setDocumentFocusVisible,
	setDocumentVisible,
	setHoveredElement,
	setUASelection,
	takeFocusStartingPoint,
	topmostModalDialog,
	type Window,
} from "./dom.ts";
import {requestEditingInsert} from "./editing.ts";
import type {WireKey, WireMouse, WirePaste} from "./exchange.ts";
import {type Framebuffer, repaintAll, requestFrame} from "./framebuffer.ts";
import type {Layout} from "./layout.ts";
import {isPlatformObject} from "./slots.ts";
import {
	getAttributeValue,
	getHTMLLocalName,
	getLocalName,
	getNodeType,
	hasAttributeByName,
	nodeContains,
} from "./tree.ts";
import {pxFromCells} from "./units.ts";

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

// The US-layout key each punctuation character sits on, shifted or not.
const PUNCTUATION_CODES: Record<string, string> = {
	"`": "Backquote",
	"~": "Backquote",
	"-": "Minus",
	_: "Minus",
	"=": "Equal",
	"+": "Equal",
	"[": "BracketLeft",
	"{": "BracketLeft",
	"]": "BracketRight",
	"}": "BracketRight",
	"\\": "Backslash",
	"|": "Backslash",
	";": "Semicolon",
	":": "Semicolon",
	"'": "Quote",
	'"': "Quote",
	",": "Comma",
	"<": "Comma",
	".": "Period",
	">": "Period",
	"/": "Slash",
	"?": "Slash",
	"!": "Digit1",
	"@": "Digit2",
	"#": "Digit3",
	$: "Digit4",
	"%": "Digit5",
	"^": "Digit6",
	"&": "Digit7",
	"*": "Digit8",
	"(": "Digit9",
	")": "Digit0",
};

// The DOM `code`, assuming a US layout. A terminal only says what
// character a key produced, never which key, so punctuation is a guess
// and a character off the US layout has no code at all.
function getDOMCode(keyName: string): string {
	if (keyName === " ") {
		return "Space";
	}
	if (keyName in NAMED_KEY_NUMBERS) {
		return keyName;
	}
	if (/^[a-z]$/i.test(keyName)) {
		return `Key${keyName.toUpperCase()}`;
	}
	if (/^[0-9]$/.test(keyName)) {
		return `Digit${keyName}`;
	}
	return PUNCTUATION_CODES[keyName] ?? "";
}

// The legacy keyCode of each punctuation key on a US layout, which a
// browser reports on keydown whether or not Shift is held.
const PUNCTUATION_KEY_NUMBERS: Record<string, number> = {
	Space: 32,
	Semicolon: 186,
	Equal: 187,
	Comma: 188,
	Minus: 189,
	Period: 190,
	Slash: 191,
	Backquote: 192,
	BracketLeft: 219,
	Backslash: 220,
	BracketRight: 221,
	Quote: 222,
};

// A key's keyCode is the key's, not the character's: a letter's upper
// case, a digit key's digit whatever Shift makes it, and a punctuation
// key's number. A character on no known key has none.
function getLegacyKeyCode(keyName: string): number {
	const named = NAMED_KEY_NUMBERS[keyName];
	if (named !== undefined) {
		return named;
	}
	const code = getDOMCode(keyName);
	if (/^Key[A-Z]$/.test(code)) {
		return code.charCodeAt(3);
	}
	if (/^Digit\d$/.test(code)) {
		return code.charCodeAt(5);
	}
	return PUNCTUATION_KEY_NUMBERS[code] ?? 0;
}

// What Tab traverses and what a mousedown focuses.
const FOCUSABLE_SELECTOR =
	'a[href], input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), details > summary:first-of-type, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

// `barrier` is the nearest scope owner above with a negative tabindex.
// The stop cannot be tabbed into from outside, but focus scripted inside
// still navigates among stops behind the same barrier and exits past
// it.
interface SequentialEntry {
	element: Element;
	barrier: Element | null;
}

function getTabIndex(element: Element): number {
	const parsed = parseInt(getAttributeValue(element, "tabindex") || "0", 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

// Every stop under the root, barred ones included, in scoped tab order.
function getSequentialFocusEntries(
	root: Document | Element,
	layout: Layout,
): SequentialEntry[] {
	const isRendered = (element: Element): boolean => {
		// A hidden element must not swallow a Tab press invisibly.
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = flatParentElement(ancestor)
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
			ancestor = flatParentElement(ancestor)
		) {
			if (hasAttributeByName(ancestor, "inert")) {
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
			if (getNodeType(node) !== 1) {
				return;
			}
			const element = node as Element;
			const ownerTabindex = getTabIndex(element);
			const shadow = getShadowRoot(element);
			if (shadow !== null) {
				const innerBarrier = ownerTabindex < 0 ? (barrier ?? element) : barrier;
				// The host's light children appear through slots or not at all.
				const inner = buildScope(shadow.children, innerBarrier);
				let expansion = inner;
				if (shadow.delegatesFocus !== true && isFocusable(element)) {
					expansion = [{element, barrier}, ...inner];
				}
				push(ownerTabindex, expansion);
				return;
			}
			if (getLocalName(element) === "slot") {
				const innerBarrier = ownerTabindex < 0 ? (barrier ?? element) : barrier;
				const assigned = (element as HTMLSlotElement).assignedNodes();
				const slotContents = assigned.length > 0
					? assigned
					: element.childNodes;
				const inner = buildScope(slotContents as Iterable<Node>, innerBarrier);
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

	const roots = getNodeType(root) === 9
		? ((root as Document).documentElement
			? [(root as Document).documentElement as Element]
			: [])
		: Array.from((root as Element).children);
	return buildScope(roots, null);
}

// The nearest scroll container (overflow auto or scroll; hidden does
// not take the wheel) that can still move in the tick's direction, or
// null when the tick chains to the document scroll.
function getWheelScroller(
	input: Input,
	target: Element,
	delta: number,
	axis: "top" | "left",
): Element | null {
	const document = input.document;
	const layout = input.layout;
	for (
		let element: Element | null = target;
		element &&
		element !== document.body &&
		element !== document.documentElement;
		element = flatParentElement(element)
	) {
		const overflow =
			getComputedValue(element, axis === "top" ? "overflow-y" : "overflow-x") ||
			getComputedValue(element, "overflow");
		if (overflow !== "auto" && overflow !== "scroll") {
			continue;
		}
		if (delta < 0) {
			if (getScrollOffset(element, axis) > 0) {
				return element;
			}
			continue;
		}
		const room = layout.scrollRange(element, axis);
		if (room !== null && getScrollOffset(element, axis) < room) {
			return element;
		}
	}
	return null;
}

const DBLCLICK_INTERVAL_MS = 500;

export class Input {
	document: Document;
	window: Window;
	layout: Layout;
	cascade: Cascade;
	framebuffer: Framebuffer;
	// Ctrl+Z's default action: hand the terminal back, as a shell's job
	// control does, where the transport can.
	suspend: () => void;
	// What movementX/movementY measure from.
	lastMouse: {x: number; y: number} | null;
	// Motion coalesced to one hit-test per frame. `quiet` marks a drag's
	// motion, whose mousemove the report already dispatched.
	pendingHover: {
		x: number;
		y: number;
		shiftKey: boolean;
		altKey: boolean;
		ctrlKey: boolean;
		quiet: boolean;
	} | null;

	hoverElement: Element | null;
	// The document scroll hit its top and the user kept scrolling up, so
	// the wheel belongs to the terminal's scrollback until the next
	// keystroke: terminals snap to the live screen on input, and none
	// says when the user has scrolled back down by hand. The document is
	// hidden meanwhile, as a page in a background tab is.
	captureYielded: boolean;
	// A mouseup on the same element is a click.
	mouseDownTarget: Element | null;
	popoverPressTarget: Element | null;
	// The document selection's anchor while a left-button drag selects.
	selectionDragAnchor: {node: Text; offset: number} | null;
	// A drag begun in a text control extends the text control's own bounded
	// selection, not the document's. The two never merge.
	textControlDragAnchor: {
		element: HTMLInputElement | HTMLTextAreaElement;
		offset: number;
	} | null;

	// A press on a range input's slider moves its thumb until the release.
	rangeDrag: Element | null;
	// A double click selects by word and a triple click by paragraph, and
	// the drag that follows extends a whole unit at a time.
	selectionUnit: SelectionUnit | null;

	// UI Events' click count: mousedown, mouseup and click carry it as
	// `detail`, and a dblclick is every even click.
	lastClickPoint: {x: number; y: number} | null;
	lastClickTime: number;
	clickCount: number;
	lastClickButton: number;
	// A canceled pointerdown withholds the mouse events of that press,
	// through the release of its last button.
	mouseEventsSuppressed: boolean;

	constructor(
		document: Document,
		layout: Layout,
		styles: Cascade,
		framebuffer: Framebuffer,
		suspend: () => void = () => {},
	) {
		this.document = document;
		this.window = document.defaultView as unknown as Window;
		this.layout = layout;
		this.cascade = styles;
		this.framebuffer = framebuffer;
		this.suspend = suspend;
		this.lastMouse = null;
		this.pendingHover = null;
		this.hoverElement = null;
		this.mouseDownTarget = null;
		this.popoverPressTarget = null;
		this.selectionDragAnchor = null;
		this.textControlDragAnchor = null;
		this.rangeDrag = null;
		this.selectionUnit = null;
		this.captureYielded = false;
		this.lastClickPoint = null;
		this.lastClickTime = 0;
		this.clickCount = 0;
		this.lastClickButton = 0;
		this.mouseEventsSuppressed = false;
	}

	get mouseCaptureYielded(): boolean {
		return this.captureYielded;
	}

	dispose(): void {}
}

export function dispatchInput(
	input: Input,
	item: WireKey[] | WireMouse | WirePaste,
): void {
	// Pseudo-state and the selection move with no mutation record. Each
	// names the rows it changes.
	requestFrame(input.framebuffer);
	if (Array.isArray(item)) {
		deliverKeys(input, item);
		return;
	}
	if (item.kind === "mouse") {
		deliverMouseReport(input, item);
		return;
	}
	deliverPaste(input, item.text);
}

/**
 * One hit-test at the last reported position, at the start of the frame.
 */
export function resolvePendingHover(input: Input): void {
	const pending = input.pendingHover;
	if (pending === null) {
		return;
	}
	input.pendingHover = null;
	const {x, y, shiftKey, altKey, ctrlKey} = pending;
	processPendingPointerCapture(input);
	const buttons = getPointerState(input.document).buttons;
	const target =
		getPointerState(input.document).active ??
		(elementAtDocumentPoint(input.document, x, y, null) || input.document.body);
	const previous = input.hoverElement;
	const init = {
		button: 0,
		buttons,
		...getClientPoint(input, x, y),
		...getScreenPoint(input, x, y),
		shiftKey,
		altKey,
		ctrlKey,
	};
	if (target !== previous) {
		input.hoverElement = target;
		setHoveredElement(input.document, target);
		handleHoverChange(input.cascade, previous, target);
		const getChain = (element: Element | null): Element[] => {
			const chain: Element[] = [];
			for (
				let node: Element | null = element; node; node = flatParentElement(node)
			) {
				chain.push(node);
			}
			return chain;
		};
		const previousChain = getChain(previous);
		const targetChain = getChain(target);
		const previousSet = new Set(previousChain);
		const targetSet = new Set(targetChain);
		const leaving = previousChain.filter((node) => !targetSet.has(node));
		const entering = targetChain.filter((node) => !previousSet.has(node));
		// Pointer Events' order, then UI Events' compatibility mouse
		// events in the same order: out, leave (exited element up), over,
		// enter (outermost entered ancestor down), then the move.
		for (const kind of ["pointer", "mouse"] as const) {
			const fire = (type: string, node: Element, extra: object): void => {
				dispatchMouseLike(input, kind, `${kind}${type}`, node, {
					...init,
					...extra,
				});
			};
			if (previous !== null) {
				fire("out", previous, {
					bubbles: true,
					cancelable: true,
					composed: true,
					relatedTarget: target,
				});
				for (const node of leaving) {
					fire("leave", node, {relatedTarget: target});
				}
			}
			fire("over", target, {
				bubbles: true,
				cancelable: true,
				composed: true,
				relatedTarget: previous,
			});
			for (let i = entering.length - 1; i >= 0; i--) {
				fire("enter", entering[i], {relatedTarget: previous});
			}
		}
	}
	if (!pending.quiet) {
		const last = input.lastMouse;
		const moveInit = {
			...init,
			...getMovement(input, x, y, last),
			bubbles: true,
			cancelable: true,
			composed: true,
		};
		dispatchMouseLike(input, "pointer", "pointermove", target, {
			...moveInit,
			button: -1,
		});
		dispatchMouseLike(input, "mouse", "mousemove", target, moveInit);
		input.lastMouse = {x, y};
	}
}

// Every pointer event the mouse fires carries the same pointer. A
// button held down presses at half pressure, as a browser reports a
// mouse that cannot sense it.
function dispatchMouseLike(
	input: Input,
	kind: "pointer" | "mouse",
	type: string,
	target: Element,
	init: MouseEventInit,
): boolean {
	const event = kind === "mouse"
		? constructInternal(() => new input.window.MouseEvent(type, init))
		: constructInternal(() =>
			new input.window.PointerEvent(type, {
				...init,
				detail: type.startsWith("pointer") ? 0 : init.detail,
				pointerId: MOUSE_POINTER_ID,
				pointerType: "mouse",
				isPrimary: true,
				pressure: (init.buttons ?? 0) === 0 ? 0 : 0.5,
			}),
		);
	return dispatchAsUserAgent(target, event);
}

// The capture setPointerCapture asked for takes effect before the next
// pointer event. An element that left the document loses it, and the
// document hears that.
function processPendingPointerCapture(input: Input): void {
	const state = getPointerState(input.document);
	if (state.pending !== null && !state.pending.isConnected) {
		state.pending = null;
	}
	if (state.active === state.pending) {
		return;
	}
	const lost = state.active;
	state.active = state.pending;
	const init = {
		pointerId: MOUSE_POINTER_ID,
		pointerType: "mouse",
		isPrimary: true,
		bubbles: true,
		composed: true,
	};
	if (lost !== null) {
		dispatchAsUserAgent(
			lost.isConnected ? lost : input.document,
			constructInternal(() =>
				new input.window.PointerEvent("lostpointercapture", init),
			),
		);
	}
	if (state.active !== null) {
		dispatchAsUserAgent(
			state.active,
			constructInternal(() =>
				new input.window.PointerEvent("gotpointercapture", init),
			),
		);
	}
}

// MouseEvent.buttons' bit for each MouseEvent.button.
const BUTTON_BITS = [1, 4, 2];

function deliverMouseReport(input: Input, {
	button: code,
	col,
	row,
	release: isRelease,
	ticks,
}: WireMouse): void {
	const {
		shiftKey,
		altKey,
		ctrlKey,
		isMotion,
		base,
		wheelDeltaY,
		wheelDeltaX,
		button,
		buttons,
	} = decodeMouseReport(code, isRelease, ticks);

	const {x, y, isInDocument} = getDocumentPoint(input, col, row);

	// A report arrives per cell crossed, so motion is coalesced to one
	// hit-test per frame. A drag's motion also falls through. Its mousemove
	// and selection updates are per report.
	if (isMotion) {
		input.pendingHover = {x, y, shiftKey, altKey, ctrlKey, quiet: base <= 2};
		if (base > 2) {
			requestRender(input.document);
			return;
		}
	}

	const hit =
		(isInDocument && elementAtDocumentPoint(input.document, x, y, null)) ||
		input.document.body;

	if (wheelDeltaY !== null) {
		const notCanceled = dispatchAsUserAgent(
			hit,
			constructInternal(() =>
				new input.window.WheelEvent("wheel", {
					deltaY: wheelDeltaY,
					deltaMode: 1,
					...getClientPoint(input, x, y),
					...getScreenPoint(input, x, y),
					shiftKey,
					altKey,
					ctrlKey,
					bubbles: true,
					cancelable: true,
					composed: true,
				}),
			),
		);
		if (notCanceled && scrollByWheel(input, hit, wheelDeltaY)) {
			// Scroll chaining. The parent scroller is the terminal's own
			// scrollback, so the mouse is yielded to it. preventDefault on
			// the wheel event opts out, as in a browser.
			input.captureYielded = true;
			setDocumentVisible(input.document, false);
			requestRender(input.document);
		}
		return;
	}

	if (wheelDeltaX !== null) {
		const notCanceled = dispatchAsUserAgent(
			hit,
			constructInternal(() =>
				new input.window.WheelEvent("wheel", {
					deltaX: wheelDeltaX,
					deltaMode: 1,
					...getClientPoint(input, x, y),
					...getScreenPoint(input, x, y),
					shiftKey,
					altKey,
					ctrlKey,
					bubbles: true,
					cancelable: true,
					composed: true,
				}),
			),
		);
		// The document never scrolls sideways, so a notch no box takes
		// goes nowhere.
		const scroller = notCanceled
			? getWheelScroller(input, hit, wheelDeltaX, "left")
			: null;
		if (scroller !== null) {
			scroller.scrollLeft += pxFromCells(wheelDeltaX, false, input.document);
		}
		return;
	}

	// SGR names the button even on release, so 3 (no button) carries
	// nothing.
	if (base > 2) {
		return;
	}
	// The report names one button. The buttons held are tracked here, so a
	// chord reports all of them, and only the first press and the last
	// release are a pointerdown and a pointerup.
	const state = getPointerState(input.document);
	const bit = BUTTON_BITS[button];
	const before = state.buttons;
	state.buttons = isMotion
		? before || buttons
		: isRelease ? before & ~bit : before | bit;
	const last = input.lastMouse;
	let detail = 0;
	if (!isMotion) {
		if (!isRelease) {
			// A browser counts clicks by where and when, not by what was
			// under the pointer: a second press on the same cell within the
			// interval is a double-click even if the first click moved the
			// element out from under it. Another button starts a new count.
			const now = performance.now();
			const lastPoint = input.lastClickPoint;
			input.clickCount =
				lastPoint !== null &&
				lastPoint.x === x &&
				lastPoint.y === y &&
				input.lastClickButton === button &&
				now - input.lastClickTime <= DBLCLICK_INTERVAL_MS
					? input.clickCount + 1
					: 1;
			input.lastClickPoint = {x, y};
			input.lastClickTime = now;
			input.lastClickButton = button;
		}
		detail = input.clickCount;
	}
	const eventInit = {
		detail,
		button,
		buttons: state.buttons,
		...getClientPoint(input, x, y),
		...getScreenPoint(input, x, y),
		...getMovement(input, x, y, last),
		shiftKey,
		altKey,
		ctrlKey,
		bubbles: true,
		cancelable: true,
		composed: true,
	};
	input.lastMouse = {x, y};

	processPendingPointerCapture(input);
	const target = state.active ?? hit;
	if (isMotion) {
		dispatchMouseLike(input, "pointer", "pointermove", target, {
			...eventInit,
			button: -1,
		});
		if (!input.mouseEventsSuppressed) {
			dispatchMouseLike(input, "mouse", "mousemove", target, eventInit);
		}
		dragTo(input, x, y, isInDocument);
		return;
	}

	if (!isRelease) {
		if (before === 0) {
			input.mouseEventsSuppressed = !dispatchMouseLike(
				input,
				"pointer",
				"pointerdown",
				target,
				eventInit,
			);
		} else {
			dispatchMouseLike(input, "pointer", "pointermove", target, eventInit);
		}
		dispatchPress(input, target, base, x, y, isInDocument, eventInit, detail);
		// The menu itself is the browser's, and a terminal has none to open.
		if (button === 2) {
			dispatchMouseLike(input, "pointer", "contextmenu", target, eventInit);
		}
		return;
	}

	if (state.buttons === 0) {
		dispatchMouseLike(input, "pointer", "pointerup", target, eventInit);
		// Capture ends with the press that set it.
		state.pending = null;
		processPendingPointerCapture(input);
	} else {
		dispatchMouseLike(input, "pointer", "pointermove", target, eventInit);
	}
	dispatchRelease(input, target, button, eventInit);
	if (state.buttons === 0) {
		input.mouseEventsSuppressed = false;
	}
}

function deliverPaste(input: Input, text: string): void {
	// A terminal pastes line breaks as CR (tmux documents the replacement).
	// The DOM's paste carries LF.
	text = text.replace(/\r\n?/g, "\n");
	const focused = getFocusedElement(input.document);
	const target = focused && focused !== input.document.body
		? focused
		: input.document.body;
	const clipboardData = new input.window.DataTransfer();
	clipboardData.setData("text/plain", text);
	lockDataTransfer(clipboardData);
	const proceed = dispatchAsUserAgent(
		target,
		constructInternal(() =>
			new input.window.ClipboardEvent("paste", {
				clipboardData,
				bubbles: true,
				composed: true,
				cancelable: true,
			}),
		),
	);
	const tag = getHTMLLocalName(target);
	if (proceed && (tag === "input" || tag === "textarea")) {
		const event = constructInternal(() =>
			new input.window.InputEvent("beforeinput", {
				inputType: "insertFromPaste",
				data: text,
				bubbles: true,
				composed: true,
				cancelable: true,
			}),
		);
		dispatchAsUserAgent(target, event);
		runControlDefaultAction(target, event);
	} else if (proceed) {
		requestEditingInsert(target, "insertFromPaste", text);
	}
	requestRender(input.document);
}

// A keystroke also means the terminal has snapped back to the live
// screen, so the mouse is taken back before the key is delivered.
function deliverKeys(input: Input, keys: WireKey[]): void {
	if (input.captureYielded) {
		input.captureYielded = false;
		setDocumentVisible(input.document, true);
		requestRender(input.document);
	}
	for (const key of keys) {
		dispatchKey(input, key);
	}
}

function decodeMouseReport(code: number, isRelease: boolean, ticks: number): {
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	isMotion: boolean;
	// The button or wheel code without the modifier and motion bits.
	base: number;
	// One notch is three rows or columns, the browser's line-mode
	// convention. Wheel buttons 66 and 67 tilt sideways, and Shift turns a
	// vertical notch sideways, as a browser does.
	wheelDeltaY: number | null;
	wheelDeltaX: number | null;
	// Valid when base <= 2.
	button: number;
	buttons: number;
} {
	const shiftKey = (code & 4) !== 0;
	const altKey = (code & 8) !== 0;
	const ctrlKey = (code & 16) !== 0;
	const isMotion = (code & 32) !== 0;
	const base = code & ~(4 | 8 | 16 | 32);

	const notch = 3 * ticks;
	const vertical = base === 64 ? -notch : base === 65 ? notch : null;
	const sideways = base === 66 ? -notch : base === 67 ? notch : null;
	const wheelDeltaY = shiftKey ? null : vertical;
	const wheelDeltaX = sideways ?? (shiftKey ? vertical : null);

	const button = base === 1 ? 1 : base === 2 ? 2 : 0;
	const buttons = isRelease ? 0 : base === 1 ? 4 : base === 2 ? 2 : 1;

	return {
		shiftKey,
		altKey,
		ctrlKey,
		isMotion,
		base,
		wheelDeltaY,
		wheelDeltaX,
		button,
		buttons,
	};
}

function getDocumentPoint(input: Input, col: number, row: number): {
	x: number;
	y: number;
	// False above the painted region, meaning a shell prompt's rows.
	isInDocument: boolean;
} {
	// Fullscreen paints from the alternate screen's first row, whatever row
	// the command started on.
	const framebuffer = input.framebuffer;
	const top = input.document.fullscreenElement === null
		? framebuffer.documentTop
		: 0;
	const documentRow = row - 1 - top + framebuffer.scrollTop;
	const isInDocument = documentRow >= 0;
	return {x: col - 1, y: isInDocument ? documentRow : 0, isInDocument};
}

// The cell a report named, at its top left corner in CSS pixels, so a
// point read back from an event hits the same cell.
function getClientPoint(
	input: Input,
	x: number,
	y: number,
): {clientX: number; clientY: number} {
	return {
		clientX: pxFromCells(x, false, input.document),
		clientY: pxFromCells(y - input.framebuffer.scrollTop, true, input.document),
	};
}

function getMovement(
	input: Input,
	x: number,
	y: number,
	last: {x: number; y: number} | null,
): {movementX: number; movementY: number} {
	return last === null
		? {movementX: 0, movementY: 0}
		: {
			movementX: pxFromCells(x - last.x, false, input.document),
			movementY: pxFromCells(y - last.y, true, input.document),
		};
}

// The terminal's window is the screen, so screenX and screenY are the
// cell the report named, counted from 0.
function getScreenPoint(
	input: Input,
	x: number,
	y: number,
): {screenX: number; screenY: number} {
	const framebuffer = input.framebuffer;
	const top = input.document.fullscreenElement === null
		? framebuffer.documentTop
		: 0;
	return {
		screenX: pxFromCells(x, false, input.document),
		screenY: pxFromCells(y - framebuffer.scrollTop + top, true, input.document),
	};
}

// The nearest scroller that can move takes the tick, else the document
// scroll does. True when the tick escaped past both. A document taller
// than the screen is a scrolling surface that keeps the wheel, and its
// top is a stop, as an editor's is; one that fits has nothing to scroll,
// so the wheel goes to the terminal's scrollback. Fullscreen has no
// document scroll to move, so a tick past every scroller does nothing.
function scrollByWheel(input: Input, target: Element, deltaY: number): boolean {
	const scroller = getWheelScroller(input, target, deltaY, "top");
	if (scroller) {
		scroller.scrollTop += pxFromCells(deltaY, true, input.document);
		return false;
	}
	if (input.document.fullscreenElement !== null) {
		return false;
	}
	if (deltaY < 0 && input.framebuffer.scrollTop === 0) {
		return input.layout.documentPaintHeight() <= input.framebuffer.rows;
	}
	scrollDocumentTo(input.document, input.framebuffer.scrollTop + deltaY);
	return false;
}

const KEYLESS_INPUTS = new Set([
	"checkbox",
	"button",
	"submit",
	"reset",
	"color",
	"file",
	"image",
]);

// Elements whose own keys a scrolling key would take: controls that edit,
// step or pick with them, and editable content.
function takesKeys(element: Element, key: string): boolean {
	const tag = getHTMLLocalName(element);
	if (tag === "input") {
		const type = (element as HTMLInputElement).type;
		if (type === "radio") {
			return key.startsWith("Arrow");
		}
		return !KEYLESS_INPUTS.has(type);
	}
	return (
		tag === "textarea" || tag === "select" || getEditingHost(element) !== null
	);
}

/**
 * A browser's scrolling keys, as the default action of a keydown nothing
 * canceled: the arrows a row, PageUp, PageDown and Space a page, Home and
 * End to an edge. They move the nearest scroller around the focus that can
 * go that way, and the document otherwise. A page keeps one row of the
 * last in view.
 */
function scrollByKey(input: Input, target: Element, key: string): void {
	const direction = key === "ArrowUp" || key === "PageUp" || key === "Home"
		? -1
		: key === "ArrowDown" || key === "PageDown" || key === " " || key === "End"
			? 1
			: 0;
	if (direction === 0) {
		return;
	}
	const document = input.document;
	const edge = key === "Home" || key === "End";
	const page = key === "PageUp" || key === "PageDown" || key === " ";
	const scroller = getWheelScroller(input, target, direction, "top");
	if (scroller) {
		const rowPx = pxFromCells(1, true, document);
		if (edge) {
			scroller.scrollTop = direction < 0 ? 0 : scroller.scrollHeight;
		} else {
			const rows = page
				? Math.max(1, Math.round(scroller.clientHeight / rowPx) - 1)
				: 1;
			scroller.scrollTop += direction * rows * rowPx;
		}
		requestRender(document);
		return;
	}
	if (document.fullscreenElement !== null) {
		return;
	}
	const top = input.framebuffer.scrollTop;
	const rows = page ? Math.max(1, input.framebuffer.rows - 1) : 1;
	scrollDocumentTo(
		document,
		edge
			? (direction < 0 ? 0 : Number.MAX_SAFE_INTEGER)
			: top + direction * rows,
	);
}

/**
 * What a multi-click selects in a text control: a word, the line in a
 * textarea, or an input's whole value. A password's word is its whole
 * value too, since its characters say nothing about where words break.
 */
function getControlUnitBounds(
	element: HTMLInputElement | HTMLTextAreaElement,
	offset: number,
	unit: SelectionUnit,
): [number, number] {
	const text = getTextControlValueText(element)?.data ?? "";
	if (
		isPlatformObject(element, HTMLInputElement) &&
		(unit === "paragraph" || element.type === "password")
	) {
		return [0, text.length];
	}
	return getUnitBounds(text, offset, unit);
}

function dragTo(
	input: Input,
	x: number,
	y: number,
	isInDocument: boolean,
): void {
	if (input.rangeDrag && isInDocument) {
		moveRangeThumb(input.rangeDrag, x, false);
		requestRender(input.document);
		return;
	}
	// Clamped into the text control, whichever element the pointer is over now.
	if (input.textControlDragAnchor && isInDocument) {
		const {element: textControlElement, offset: anchor} =
			input.textControlDragAnchor;
		const focus = getTextControlCaretOffset(textControlElement, x, y);
		const unit = input.selectionUnit;
		if (focus !== null && unit !== null) {
			// A whole unit at a time, from the unit the click selected.
			const [anchorStart, anchorEnd] = getControlUnitBounds(
				textControlElement,
				anchor,
				unit,
			);
			const [focusStart, focusEnd] = getControlUnitBounds(
				textControlElement,
				focus,
				unit,
			);
			const forward = focus >= anchor;
			setUASelection(
				textControlElement,
				forward ? anchorStart : Math.min(focusStart, anchorStart),
				forward ? Math.max(focusEnd, anchorEnd) : anchorEnd,
				forward ? "forward" : "backward",
			);
			requestRender(input.document);
		} else if (focus !== null) {
			setUASelection(
				textControlElement,
				Math.min(anchor, focus),
				Math.max(anchor, focus),
				focus < anchor ? "backward" : "forward",
			);
			requestRender(input.document);
		}
		return;
	}
	// Over a textless stretch or user-select: none, the focus stays put.
	if (input.selectionDragAnchor && input.mouseDownTarget && isInDocument) {
		const focus = getTextPosition(input, x, y);
		if (focus && isSelectable(input, focus)) {
			const anchor = input.selectionDragAnchor;
			const unit = input.selectionUnit;
			if (unit !== null) {
				selectUnits(input.document, anchor, focus, unit);
			} else {
				input.window
					.getSelection()
					?.setBaseAndExtent(
						anchor.node,
						anchor.offset,
						focus.node,
						focus.offset,
					);
			}
			requestRender(input.document);
		}
	}
}

// :active holds from the press to the release, wherever the release lands.
function setPressed(input: Input, target: Element | null): void {
	const document = input.document;
	const previous = getActiveElement(document) as Element | null;
	if (previous === target) {
		return;
	}
	setActiveElement(document, target);
	handleActiveChange(input.cascade, previous, target);
	requestRender(document);
}

function dispatchPress(
	input: Input,
	target: Element,
	base: number,
	x: number,
	y: number,
	isInDocument: boolean,
	eventInit: object,
	clicks: number,
): void {
	input.mouseDownTarget = target;
	input.rangeDrag = null;
	input.selectionUnit = null;
	setPressed(input, target);
	// Light dismiss is a press and a release in the same place, so a drag
	// out of a popover does not close it.
	input.popoverPressTarget = lightDismissPress(target);
	input.textControlDragAnchor = null;
	if (setDocumentFocusVisible(input.document, false)) {
		handleFocusChange(input.cascade, getFocusedElement(input.document));
		requestRender(input.document);
	}
	const mousedown = constructInternal(() =>
		new input.window.MouseEvent("mousedown", eventInit),
	);
	const notCanceled =
		input.mouseEventsSuppressed || dispatchAsUserAgent(target, mousedown);
	if (!notCanceled) {
		return;
	}
	// Default action: focus the nearest focusable ancestor, or blur. A
	// press in editable content focuses its editing host, unless what it
	// found is part of that content, a field inside it, say. Focus from a
	// press does not scroll, as in browsers, or the page would move under
	// the pointer before the button comes up.
	let focusable: Element | null = target;
	while (focusable !== null && !focusable.matches(FOCUSABLE_SELECTOR)) {
		focusable = flatParentElement(focusable);
	}
	const host = getEditingHost(target);
	if (host !== null && (focusable === null || !nodeContains(host, focusable))) {
		focusable = host;
	}
	const active = getFocusedElement(input.document);
	if (focusable && focusable !== active) {
		(focusable as HTMLElement).focus({preventScroll: true});
		requestRender(input.document);
	} else if (!focusable && active && active !== input.document.body) {
		(active as HTMLElement).blur();
		requestRender(input.document);
	}
	runControlDefaultAction(target, mousedown);

	// Default action: a press on a slider moves its thumb to the press, and
	// a drag carries it along.
	if (base === 0 && isInDocument && moveRangeThumb(target, x, true)) {
		input.rangeDrag = target;
		requestRender(input.document);
		return;
	}

	// Default action: a press in a text control places the caret and anchors a
	// text control drag. The select UA shadow tree's own mousedown listener ran
	// above.
	const parked = base === 0 && isInDocument
		? placeTextControlCaret(target, x, y)
		: null;
	const unit: SelectionUnit | null = base !== 0
		? null
		: clicks >= 3 ? "paragraph" : clicks === 2 ? "word" : null;
	if (parked) {
		const element = parked.textControl as HTMLInputElement |
			HTMLTextAreaElement;
		input.textControlDragAnchor = {element, offset: parked.offset};
		// A double or triple click selects the unit around the press.
		if (unit !== null) {
			input.selectionUnit = unit;
			const [start, end] = getControlUnitBounds(element, parked.offset, unit);
			setUASelection(element, start, end, "forward");
		}
		// The document selection still clears, as in a browser.
		const docSelection = input.window.getSelection();
		if (docSelection && !docSelection.isCollapsed) {
			docSelection.removeAllRanges();
		}
		requestRender(input.document);
	}

	// Default action: collapse the document selection at the press and
	// anchor a drag there. Left button only. preventDefault opts out.
	const selection = input.window.getSelection();
	if (base === 0 && selection && !input.textControlDragAnchor) {
		let anchor = isInDocument ? getTextPosition(input, x, y) : null;
		if (anchor && !isSelectable(input, anchor)) {
			anchor = null;
		}
		const hadSelection = !selection.isCollapsed;
		input.selectionDragAnchor = anchor;
		if (anchor && unit !== null) {
			// A double or triple click selects the unit around the press.
			input.selectionUnit = unit;
			selectUnits(input.document, anchor, anchor, unit);
			requestRender(input.document);
		} else if (anchor) {
			selection.setBaseAndExtent(
				anchor.node,
				anchor.offset,
				anchor.node,
				anchor.offset,
			);
		} else if (isInDocument && collapseInEmptyLine(input, selection, x, y)) {
			requestRender(input.document);
		} else if (selection.rangeCount > 0) {
			selection.removeAllRanges();
		}
		if (hadSelection) {
			requestRender(input.document);
		}
	}
}

function getCommonInclusiveAncestor(a: Element, b: Element): Element | null {
	const ancestors = new Set<Element>();
	for (let node: Element | null = a;
		node !== null;
		node = flatParentElement(node)) {
		ancestors.add(node);
	}
	for (let node: Element | null = b;
		node !== null;
		node = flatParentElement(node)) {
		if (ancestors.has(node)) {
			return node;
		}
	}
	return null;
}

function dispatchRelease(
	input: Input,
	target: Element,
	button: number,
	eventInit: MouseEventInit,
): void {
	setPressed(input, null);
	if (!input.mouseEventsSuppressed) {
		dispatchMouseLike(input, "mouse", "mouseup", target, eventInit);
	}
	// Before the click, as in a browser.
	lightDismissRelease(target, input.popoverPressTarget);
	input.popoverPressTarget = null;
	let selectedByDrag = false;
	input.textControlDragAnchor = null;
	if (input.rangeDrag !== null) {
		commitRangeThumb(input.rangeDrag);
		input.rangeDrag = null;
	}
	// A word or paragraph a multi-click selected is the click's own work,
	// not a drag's, so the click and dblclick still fire.
	const unit = input.selectionUnit;
	input.selectionUnit = null;
	if (input.selectionDragAnchor) {
		input.selectionDragAnchor = null;
		const text = input.window.getSelection()?.toString() ?? "";
		if (text.length > 0 && unit === null) {
			selectedByDrag = true;
		}
	}
	// A selecting drag is not a click. Released over a label, the click
	// would toggle its checkbox and a framework's re-render would destroy
	// the selection just made.
	if (selectedByDrag) {
		input.mouseDownTarget = null;
		return;
	}
	// UI Events: a press and a release on different elements click their
	// nearest common ancestor, so a click still lands when the press moved
	// the element under the pointer.
	const pressed = input.mouseDownTarget;
	const clickTarget = pressed === null
		? null
		: getCommonInclusiveAncestor(pressed, target);
	// Only the main button clicks. The others fire auxclick, and no
	// activation behavior follows it.
	if (clickTarget !== null && button !== 0) {
		dispatchMouseLike(input, "pointer", "auxclick", clickTarget, eventInit);
	} else if (clickTarget !== null) {
		target = clickTarget;
		dispatchMouseLike(input, "pointer", "click", target, eventInit);
		// A label's click focuses its control (the browser's focusing steps,
		// which activation alone does not do), and a .checked flip is a
		// property change no mutation record repaints.
		const isCheckable = (el: unknown): el is HTMLInputElement =>
			isPlatformObject(el, HTMLInputElement) &&
			(el.type === "checkbox" || el.type === "radio");
		const control = isCheckable(target)
			? target
			: isPlatformObject(target, HTMLLabelElement) &&
				isCheckable(target.control)
				? target.control
				: null;
		if (control) {
			control.focus({preventScroll: true});
			requestRender(input.document);
		}

		// In addition to its own click, on every second click.
		if (input.clickCount % 2 === 0) {
			dispatchMouseLike(input, "mouse", "dblclick", target, eventInit);
		}
	}
	input.mouseDownTarget = null;
}

function dispatchKey(input: Input, stroke: WireKey): void {
	const {key: keyName, char, shiftKey, ctrlKey, altKey, metaKey} = stroke;
	const keyCode = getLegacyKeyCode(keyName);

	if (setDocumentFocusVisible(input.document, true)) {
		handleFocusChange(input.cascade, getFocusedElement(input.document));
		requestRender(input.document);
	}

	// A fullscreen element is usually not focusable, so keydown falls back
	// to it before the body.
	const active = getFocusedElement(input.document);
	const targetElement = active && active !== input.document.body
		? active
		: input.document.fullscreenElement || input.document.body;

	const keydownEvent = constructInternal(() =>
		new input.window.KeyboardEvent("keydown", {
			key: keyName,
			code: getDOMCode(keyName),
			keyCode,
			charCode: 0,
			which: keyCode,
			ctrlKey,
			shiftKey,
			altKey,
			metaKey,
			bubbles: true,
			composed: true,
			cancelable: true,
		}),
	);

	dispatchAsUserAgent(targetElement, keydownEvent);
	runControlDefaultAction(targetElement, keydownEvent);
	const notCanceled = !keydownEvent.defaultPrevented;

	// A close request on the top of the top layer, whether or not keydown
	// was canceled. It does not exit fullscreen. The alternate screen takes
	// nothing from the user, and terminal convention gives Escape to the
	// app.
	if (keyName === "Escape") {
		if (handleCloseRequest(input.document)) {
			requestRender(input.document);
			return;
		}
	}

	if (notCanceled) {
		if (keyName === "Tab") {
			moveFocus(input, shiftKey);
		}
		// A terminal program's redraw, for a screen stray output scribbled
		// on: clear what shows and paint the whole document again.
		if (keyName === "l" && ctrlKey && !altKey && !shiftKey && !metaKey) {
			repaintAll(input.framebuffer);
			requestRender(input.document);
		}
		if (keyName === "z" && ctrlKey && !altKey && !shiftKey && !metaKey) {
			input.suspend();
		}

		// A control's own editing ran above, and claimed its keys.
		const activation = getKeyboardActivation(targetElement);
		if (
			!ctrlKey &&
			!altKey &&
			!metaKey &&
			!(keyName === " " && activation?.space) &&
			!takesKeys(targetElement, keyName)
		) {
			scrollByKey(input, targetElement, keyName);
		}
		if (activation) {
			if (
				(keyName === "Enter" && activation.enter) ||
				(keyName === " " && activation.space)
			) {
				// A trusted click, so the full activation behavior runs.
				dispatchAsUserAgent(
					targetElement,
					constructInternal(() =>
						new input.window.PointerEvent("click", {
							pointerId: -1,
							bubbles: true,
							cancelable: true,
							composed: true,
						}),
					),
				);
				requestRender(input.document);
			}
		}
	}

	// Inserting the character is keypress's default action, so a text control's
	// input event follows keypress, as in a browser.
	if (notCanceled && char !== "") {
		const charCode = char.codePointAt(0)!;
		const keypressEvent = constructInternal(() =>
			new input.window.KeyboardEvent("keypress", {
				key: char,
				code: getDOMCode(char),
				keyCode: charCode,
				charCode,
				which: charCode,
				ctrlKey,
				shiftKey,
				altKey,
				metaKey,
				bubbles: true,
				composed: true,
				cancelable: true,
			}),
		);
		if (dispatchAsUserAgent(targetElement, keypressEvent)) {
			insertText(input, targetElement, char);
		}
	}

	const keyupEvent = constructInternal(() =>
		new input.window.KeyboardEvent("keyup", {
			key: keyName,
			code: getDOMCode(keyName),
			keyCode,
			charCode: 0,
			which: keyCode,
			ctrlKey,
			shiftKey,
			altKey,
			metaKey,
			bubbles: true,
			composed: true,
			cancelable: true,
		}),
	);
	dispatchAsUserAgent(targetElement, keyupEvent);
}

function insertText(input: Input, target: Element, text: string): void {
	const tag = getHTMLLocalName(target);
	if (tag !== "input" && tag !== "textarea") {
		requestEditingInsert(target, "insertText", text);
		return;
	}
	const event = constructInternal(() =>
		new input.window.InputEvent("beforeinput", {
			inputType: "insertText",
			data: text,
			bubbles: true,
			composed: true,
			cancelable: true,
		}),
	);
	dispatchAsUserAgent(target, event);
	runControlDefaultAction(target, event);
}

// The stop Tab reaches from the place a removed focused element left:
// positive tab indexes come first by value, then the rest in tree order,
// and the point sits among them at its own tab index.
function getIndexPastPoint(
	entries: ReadonlyArray<{element: Element; barrier: Element | null}>,
	point: FocusStartingPoint,
	reverse: boolean,
): number {
	const FOLLOWING = 4;
	const CONTAINED_BY = 16;
	const key = (tabIndex: number): number =>
		tabIndex > 0 ? tabIndex : Number.POSITIVE_INFINITY;
	const pointKey = key(point.tabIndex);
	const next = point.next !== null && point.next.isConnected
		? point.next
		: null;
	const isAfter = (element: Element): boolean => {
		if (next !== null) {
			return (element as unknown as Node) === next ||
				(next.compareDocumentPosition(element) & (FOLLOWING | CONTAINED_BY)) !==
					0;
		}
		const relation = point.parent.compareDocumentPosition(element);
		return (relation & FOLLOWING) !== 0 && (relation & CONTAINED_BY) === 0;
	};
	const beyond = (element: Element): boolean => {
		const at = key((element as HTMLElement).tabIndex);
		if (at !== pointKey) {
			return reverse ? at < pointKey : at > pointKey;
		}
		return reverse ? !isAfter(element) : isAfter(element);
	};
	const step = reverse ? -1 : 1;
	for (
		let i = reverse ? entries.length - 1 : 0;
		i >= 0 && i < entries.length;
		i += step
	) {
		if (entries[i].barrier === null && beyond(entries[i].element)) {
			return i;
		}
	}
	return -1;
}

function moveFocus(input: Input, reverse: boolean): void {
	// Which elements are focusable depends on what renders, so the layout
	// is brought up to date first, whether or not a frame has painted it.
	flushLayout(input.document);
	// Tab cannot leave a modal dialog.
	const scope = topmostModalDialog(input.document) ?? input.document;
	const entries = getSequentialFocusEntries(scope, input.layout);

	const current = getFocusedElement(input.document);
	const currentIndex = entries.findIndex((entry) => entry.element === current);
	const currentBarrier = currentIndex === -1
		? null
		: entries[currentIndex].barrier;
	// Crossing out of a barrier is the tree exit below. Crossing in never
	// happens.
	const reachable = (index: number): boolean =>
		entries[index].barrier === currentBarrier;
	const step = reverse ? -1 : 1;
	let nextIndex = -1;
	const point = currentIndex === -1
		? takeFocusStartingPoint(input.document)
		: null;
	if (point !== null) {
		nextIndex = getIndexPastPoint(entries, point, reverse);
	}
	if (nextIndex === -1 && currentIndex === -1) {
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
	} else if (nextIndex === -1) {
		for (
			let i = currentIndex + step; i >= 0 && i < entries.length; i += step
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
					ancestor = flatParentElement(ancestor)
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
	requestRender(input.document);
}

// Null over a form control. Its value is not document text.
function getTextPosition(
	input: Input,
	x: number,
	y: number,
): {node: Text; offset: number} | null {
	// The deepest element, as a pointer event targets: text a user drags
	// across in a shadow tree is still text they can select.
	const element = elementAtDocumentPoint(input.document, x, y, null);
	if (
		!element ||
		isPlatformObject(element, HTMLInputElement) ||
		isPlatformObject(element, HTMLTextAreaElement)
	) {
		return null;
	}
	const layout = input.layout;
	const exact = layout.caretPositionFromPoint(x, y, element);
	if (exact !== null || isEmptyEditableLine(element)) {
		return exact;
	}
	// Off the text, in padding, a margin or the space past the content, a
	// press lands on the nearest line of the nearest box that has one, as
	// in a browser.
	for (
		let box: Element | null = element;
		box !== null;
		box = flatParentElement(box)
	) {
		const near = layout.caretPositionFromPoint(x, y, box, true);
		if (near !== null) {
			return near;
		}
	}
	return null;
}

function isEmptyEditableLine(element: Element): boolean {
	return (element as HTMLElement).isContentEditable &&
		(element.textContent ?? "") === "";
}

// An editable line with no text, one holding only its placeholder <br>,
// is still somewhere the caret can go: its start, where typing would put
// text.
function collapseInEmptyLine(
	input: Input,
	selection: Selection,
	x: number,
	y: number,
): boolean {
	const element = elementAtDocumentPoint(input.document, x, y, null);
	if (element === null || !isEmptyEditableLine(element)) {
		return false;
	}
	selection.collapse(element, 0);
	return true;
}

function isSelectable(
	input: Input,
	position: {node: Text; offset: number},
): boolean {
	const parent = flatParentElement(position.node);
	return parent === null || input.cascade.isSelectable(parent);
}
