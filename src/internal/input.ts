/**
 * The input interpreter: a line discipline for the DOM.
 *
 * Wire items -- keystrokes, SGR mouse reports, paste bodies -- come in here
 * and DOM events go out; what one means to the DOM (key names to keyCodes,
 * report bits to buttons) is decoded here, where the events are built. No
 * escape syntax reaches this far; the wire has already spelled it out.
 *
 * Interpretation is stateful, because a gesture is spread over reports: a
 * click is a press and a release on one element, a dblclick is two clicks
 * close in time, a drag is a press whose motion means selection rather than
 * hover. That transient state is this module's, held for as long as the
 * gesture lasts and no longer.
 *
 * Named for Blink's EventHandler, which is the same object: one class turning
 * platform input into DOM events, owning the interaction state interpretation
 * needs -- the mouse-down target, the drag anchors, the hover chain, the
 * scroll gesture -- and running the user-agent behavior the resulting events
 * trigger.
 *
 * What the engine keeps is what touches the frame: the camera, the wire's
 * reporting modes, the paint. Those arrive as collaborators, so nothing here
 * reaches into rendering.
 *
 * Start at EventHandler. Its dispatch is the one door every wire item comes
 * in through, and the gestures it runs are the functions below the class.
 */

import {getComputedValue} from "./cssom.js";
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
	setHoveredElement,
	setUASelection,
	topmostModalDialog,
} from "./dom.js";
import type {WireKey, WireMouse, WirePaste} from "./exchange.js";
import type {LayoutEngine} from "./layout.js";
import {
	kLayoutEngine,
	kScreen,
	kStyleManager,
	render,
	type TermDOM,
} from "./termdom.js";

/* -------------------------------------------------- what a wire item means */

/**
 * The keys a terminal names, and the legacy `keyCode` each one carries. That
 * number is long deprecated in the DOM and still what plenty of code reads, so
 * every keyboard event has one. The roster is also the answer to which key
 * names are physical identities, which is what domCodeFor asks of it.
 */
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

/**
 * The DOM `code` for a resolved key name -- physical key identity, independent
 * of modifiers. A named key is its own code, Space excepted, since the escape
 * sequence the wire read it from identifies the physical key exactly. So is a
 * letter or digit, under the near-universal assumption of a US QWERTY layout.
 * Not exact for punctuation: a terminal only ever tells us the character a key
 * combination *produced* ("!" from Shift+1 on US layout, but a different
 * physical key entirely on others), never which physical key+modifiers
 * produced it -- there is no protocol-level signal for that, unlike the
 * modifier bits an event's `ctrlKey`/`altKey`/`shiftKey` come from. Falls back
 * to `Key<uppercased character>`, which is a guess.
 */
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

/**
 * The legacy `keyCode` for a resolved key name: the number for a named key,
 * and for a single character the uppercase character's code -- which is the
 * letter's own keyCode, so Ctrl+A and a typed "a" agree. 0 for anything else,
 * an escape sequence this engine does not name being the only such thing.
 */
function legacyKeyCode(keyName: string): number {
	const named = NAMED_KEY_NUMBERS[keyName];
	if (named !== undefined) {
		return named;
	}
	return keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0;
}

/* -------------------------------------------------------- focus navigation */

// What Tab traverses and what a mousedown focuses -- one definition of
// "focusable" for both.
//
// `a[href]` is in the list because an anchor WITH an href is focusable and
// sequentially reachable per HTML, and an anchor without one is not -- the
// attribute qualifier draws that line for free, and link-shaped navigation
// stays reachable by keyboard.
const FOCUSABLE_SELECTOR =
	'a[href], input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), details > summary:first-of-type, [tabindex]:not([tabindex="-1"])';

/**
 * One stop in the sequential order. `barrier` names the nearest scope
 * owner with a negative tabindex above it, if any: such a stop cannot be
 * tabbed into from outside, but focus scripted inside the owner's scope
 * still navigates among stops sharing the barrier and exits past it.
 */
interface SequentialEntry {
	element: Element;
	barrier: Element | null;
}

function getTabIndex(element: Element): number {
	const parsed = parseInt(element.getAttribute("tabindex") || "0", 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Every sequential focus stop under a root, barred ones included, in
 * scoped tab order.
 */
function sequentialFocusEntries(
	root: Document | Element,
	layoutEngine: LayoutEngine,
): SequentialEntry[] {
	const isRendered = (element: Element): boolean => {
		// Browsers keep unrendered elements out of tab order: a hidden
		// edit-row checkbox must not swallow a Tab press invisibly. An
		// element is rendered when nothing on its flat-tree chain is
		// display:none and it produced boxes.
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
			return layoutEngine.getRects(element).length > 0;
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
		// One entry per element, or per scope owner standing for its whole
		// expanded scope. The owner's tabindex positions the entry among its
		// siblings; the expansion is already in its own scope's order.
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
				// A negative tabindex on the owner bars the whole expansion
				// from outside entry; inside it, order still holds.
				const innerBarrier =
					ownerTabindex < 0 ? (barrier ?? element) : barrier;
				// The host's light children surface through the shadow's
				// slots or nowhere; they are not this scope's to walk.
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

/* ------------------------------------------------------------ the document */

const kTermDOM = Symbol("termDOM");

/* --------------------------------------------------------- the interpreter */

const kDocument = Symbol("document");

/**
 * The scroll box a wheel tick over `target` belongs to: the nearest flat-tree
 * ancestor (the target included) whose overflow-y makes it a scroll
 * container -- auto or scroll; hidden and visible don't take the wheel, as
 * in a browser -- and that can still move in the tick's direction. None
 * means the tick chains past every element scroller to the document camera.
 */
function wheelScrollerFor(
	handler: EventHandler,
	target: Element,
	deltaY: number,
): Element | null {
	const document = handler[kDocument];
	const layout = handler[kTermDOM][kLayoutEngine];
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

/**
 * The interpreter itself: the collaborators it was built with, the gesture
 * state a chunk of input leaves behind it, and the doors that input comes in
 * through.
 */
export class EventHandler {
	// Self-heals a yield that a keystroke never reclaims: while yielded, wheel
	// activity produces literally no signal (that's the entire mechanism --
	// the terminal is handling it, not us), so there's no way to reset this on
	// continued scrolling the way a real debounce would. It's a flat window
	// from the moment of yielding, not "N ms since the last wheel tick" --
	// which is exactly why this can't be too short: a real wheel/trackpad
	// doesn't tick perfectly continuously, and any gap between ticks longer
	// than this window re-enables capture mid-scroll, which the very next
	// tick immediately re-yields -- a disable/enable toggle on every gap for
	// as long as the user keeps scrolling, not just a one-time early
	// re-enable.
	static readonly [kScrollChainTimeoutMs] = 3000;

	// The target and time of the last completed click, to detect a second one
	// close enough behind it to be a dblclick -- browsers' own double-click
	// interval varies by OS/user setting; 500ms is the common default.
	static readonly [kDblclickIntervalMs] = 500;
	declare [kDocument]: Document;
	declare [kWindow]: EngineWindow;
	declare [kTermDOM]: TermDOM;

	// The last position a mouse event was dispatched at, which is what the
	// spec's movementX/movementY measure from. The first report has nothing
	// to move from.
	declare [kLastMouse]: {x: number; y: number} | null;
	// The last motion report's position, coalesced: however many reports a
	// chunk delivers, the frame hit-tests once, here. `quiet` marks a drag's
	// motion, whose mousemove the report itself already dispatched.
	declare [kPendingHover]: {
		x: number;
		y: number;
		shiftKey: boolean;
		altKey: boolean;
		ctrlKey: boolean;
		quiet: boolean;
	} | null;

	// The element under the pointer, which :hover styling and the boundary
	// events (mouseover/out/enter/leave) are both diffed against.
	declare [kHoverElement]: Element | null;
	// Scroll chaining yielded the mouse back to the terminal: the camera hit
	// the document top and the user kept scrolling up, so the wheel now
	// belongs to the terminal's own scrollback. Cleared by the next keystroke
	// -- terminals snap to the live screen on input, which is exactly the
	// moment the wheel should become ours again -- or, failing that, by
	// kScrollChainTimeoutMs of silence (see kScrollChainTimer).
	declare [kMouseCaptureYielded]: boolean;
	declare [kScrollChainTimer]: ReturnType<typeof setTimeout> | null;
	// Where the last mousedown landed, so a mouseup on the same element
	// becomes a click. (Browsers dispatch click at the nearest common
	// ancestor; the same-element case is the one that matters on a cell grid.)
	declare [kMouseDownTarget]: Element | null;
	// The popover the last mousedown belonged to, which light dismiss compares
	// the release against.
	declare [kPopoverPressTarget]: Element | null;
	// Where a left-button drag started selecting text, as a caret position --
	// the selection's anchor. The focus end follows the drag; both feed
	// Selection.setBaseAndExtent, which handles backward drags itself.
	declare [kSelectionDragAnchor]: {node: Text; offset: number} | null;
	// A drag that started inside a text field extends the FIELD's own
	// selection (selectionStart/End, bounded to the field) rather than the
	// document selection -- the browser's exact split. The anchor is a
	// value offset; the focus end follows the pointer, clamped into the
	// field.
	declare [kFieldDragAnchor]: {
		element: HTMLInputElement | HTMLTextAreaElement;
		offset: number;
	} | null;

	declare [kLastClickTarget]: Element | null;
	declare [kLastClickTime]: number;

	constructor(termDOM: TermDOM) {
		this[kDocument] = termDOM.document;
		this[kWindow] = termDOM.document.defaultView as unknown as EngineWindow;
		this[kTermDOM] = termDOM;
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

	/**
	 * Whether the wheel currently belongs to the terminal rather than the
	 * document. The engine reads it to decide the reporting modes.
	 */
	get mouseCaptureYielded(): boolean {
		return this[kMouseCaptureYielded];
	}

	/** Drop the gesture timers, so none of them keeps the event loop open. */
	dispose(): void {
		if (this[kScrollChainTimer] !== null) {
			clearTimeout(this[kScrollChainTimer]);
			this[kScrollChainTimer] = null;
		}
	}

	/**
	 * The one door input comes in through: a batch of keystrokes, a mouse
	 * report, or a paste, each delivered to the document as its own events.
	 *
	 * Input dirties the frame wholesale -- reactive pseudo-state and the
	 * selection move without a mutation record, and no cheaper answer than the
	 * paint exists -- so anything arriving here invalidates the screen first.
	 */
	dispatch(item: WireKey[] | WireMouse | WirePaste): void {
		this[kTermDOM][kScreen].invalidate();
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
	 * Resolve the frame's coalesced motion: one hit-test at the last reported
	 * position, then whatever moved -- the hover chain re-styled, the boundary
	 * events, a mousemove -- from that one answer.
	 *
	 * Runs at the top of the interactive frame, before it takes its mutation
	 * records: a listener's synchronous mutations land in this frame, and the
	 * `:hover` invalidation precedes the style resolution that repaints it.
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
			this[kTermDOM][kStyleManager].handleHoverChange(previous, target);
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
			// UI Events' boundary order: out, then leave from the exited element
			// up, then over, then enter from the outermost entered ancestor
			// down; the mousemove in the entered element follows them.
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
		// A drag's motion already dispatched its own mousemove, report by
		// report; only buttonless motion owes one here.
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

/**
 * A mouse report from the terminal: the code byte, the 1-based cell, and
 * whether the button went up. These only arrive while capture is on.
 *
 * Reports become the DOM's own mouse events, dispatched at the element
 * under the cell (document.elementFromPoint is layout-true), with the
 * browser's default actions: wheel scrolls the camera, mousedown moves
 * focus, mouseup on the mousedown target is a click.
 */
function deliverMouseReport(
	handler: EventHandler,
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

	const {x, y, inDocument} = documentPointAt(handler, col, row);

	// Motion arrives at cell granularity -- with 1003 on, a report per cell
	// crossed -- so it is COALESCED: the frame hit-tests the last position
	// once and updates the hover chain there (see resolvePendingHover),
	// instead of paying a hit-test per report. A drag's motion (base <= 2)
	// falls through besides: its per-report mousemove and selection updates
	// predate hover and keep their timing.
	if (isMotion) {
		handler[kPendingHover] = {
			x,
			y,
			shiftKey,
			altKey,
			ctrlKey,
			quiet: base <= 2,
		};
		if (base > 2) {
			void render(handler[kTermDOM]);
			return;
		}
	}

	// Already document-relative -- go straight to the shared hit-test rather
	// than through the public elementFromPoint, which expects viewport-
	// relative input and would convert it right back.
	const target =
		(inDocument && elementAtDocumentPoint(handler[kDocument], x, y)) ||
		handler[kDocument].body;

	if (wheelDeltaY !== null) {
		const notCanceled = dispatchAsUserAgent(
			target,
			new handler[kWindow].WheelEvent("wheel", {
				deltaY: wheelDeltaY,
				deltaMode: 1, // DOM_DELTA_LINE
				clientX: x,
				clientY: y,
				shiftKey,
				altKey,
				ctrlKey,
				bubbles: true,
				cancelable: true,
			}),
		);
		if (notCanceled && scrollByWheel(handler, target, wheelDeltaY)) {
			// Scroll chaining, the browser default: the camera is at the
			// document top, so the scroll escapes to the parent scroller --
			// here, the terminal's own scrollback. Yield the mouse so the
			// next wheel tick scrolls the shell history natively; the next
			// keystroke reclaims it, and kScrollChainTimeoutMs of silence
			// reclaims it too, in case the user scrolls back down without
			// ever pressing a key -- wheel activity while yielded produces no
			// signal we could otherwise catch that on. An app opts out the
			// same way it would in a browser: preventDefault on the wheel
			// event.
			handler[kMouseCaptureYielded] = true;
			void render(handler[kTermDOM]);
			if (handler[kScrollChainTimer] !== null) {
				clearTimeout(handler[kScrollChainTimer]);
			}
			handler[kScrollChainTimer] = setTimeout(() => {
				handler[kScrollChainTimer] = null;
				reclaimMouseCapture(handler);
			}, EventHandler[kScrollChainTimeoutMs]);
		}
		return;
	}

	// Buttons: 0/1/2 = left/middle/right. 3 is "no button" in the legacy
	// encoding; SGR names the button even on release, so 3 carries nothing.
	if (base > 2) {
		return;
	}
	const last = handler[kLastMouse];
	const eventInit = {
		button,
		buttons,
		clientX: x,
		clientY: y,
		// The spec's delta from the previous mousemove; the first report
		// has nothing to move from.
		movementX: last === null ? 0 : x - last.x,
		movementY: last === null ? 0 : y - last.y,
		shiftKey,
		altKey,
		ctrlKey,
		bubbles: true,
		cancelable: true,
	};
	handler[kLastMouse] = {x, y};

	if (isMotion) {
		dispatchAsUserAgent(
			target,
			new handler[kWindow].MouseEvent("mousemove", eventInit),
		);
		dragTo(handler, x, y, inDocument);
		return;
	}

	if (!isRelease) {
		press(handler, target, base, x, y, inDocument, eventInit);
		return;
	}

	release(handler, target, eventInit);
}

/**
 * Deliver a paste as a `paste` event carrying the text, at the focused
 * element or at the body when nothing is focused. A paste nobody cancels
 * runs its default action: into a text field, an `insertFromPaste`
 * beforeinput whose listener does the edit. Anywhere else the event is the
 * whole of it, and an application that wants the text reads it off
 * `clipboardData`.
 */
function deliverPaste(handler: EventHandler, text: string): void {
	// A terminal transmits a pasted line break as CR -- the byte Enter
	// sends (tmux's paste-buffer documents the LF-to-CR replacement) --
	// while the DOM's paste carries newlines as LF. Converted here, at the
	// boundary, so a multi-line paste into a textarea is multi-line and
	// a field's own handlers never see a bare CR.
	text = text.replace(/\r\n?/g, "\n");
	const focused = handler[kDocument].activeElement;
	const target =
		focused && focused !== handler[kDocument].body
			? focused
			: handler[kDocument].body;
	const clipboardData = new handler[kWindow].DataTransfer();
	clipboardData.setData("text/plain", text);
	lockDataTransfer(clipboardData);
	const proceed = dispatchAsUserAgent(
		target,
		new handler[kWindow].ClipboardEvent("paste", {
			clipboardData,
			bubbles: true,
			cancelable: true,
		}),
	);
	const tag = target.tagName;
	if (proceed && (tag === "INPUT" || tag === "TEXTAREA")) {
		dispatchAsUserAgent(
			target,
			new handler[kWindow].InputEvent("beforeinput", {
				inputType: "insertFromPaste",
				data: text,
				bubbles: true,
				cancelable: true,
			}),
		);
	}
	void render(handler[kTermDOM]);
}

/**
 * One chunk's keystrokes, as the wire's reader decoded them. A keystroke
 * also means the user is back at the live screen -- terminals snap to
 * the bottom on input -- so it takes the mouse back from a
 * scroll-chaining yield.
 */
function deliverKeys(handler: EventHandler, keys: WireKey[]): void {
	if (handler[kMouseCaptureYielded]) {
		reclaimMouseCapture(handler);
	}
	for (const key of keys) {
		dispatchKey(handler, key);
	}
}

/**
 * Decode one SGR mouse report's code byte into its modifiers, phase, and button
 * mapping. The report's row/column and the dispatch itself stay with the
 * caller, which owns the hit-test and the render loop.
 */
function decodeMouseReport(code: number, isRelease: boolean): {
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;

	/** A motion report (a drag or hover), rather than a press/release. */
	isMotion: boolean;

	/** The button/wheel code with the modifier and motion bits stripped. */
	base: number;

	/**
	 * The wheel notch in DOM_DELTA_LINE rows (one notch = three rows, the
	 * browser's line-mode convention), or null when the report is not a wheel.
	 */
	wheelDeltaY: number | null;

	/** The MouseEvent `button`, valid when base <= 2. */
	button: number;

	/** The MouseEvent `buttons` bitmask for this phase, valid when base <= 2. */
	buttons: number;
} {
	const shiftKey = (code & 4) !== 0;
	const altKey = (code & 8) !== 0;
	const ctrlKey = (code & 16) !== 0;
	const isMotion = (code & 32) !== 0;
	const base = code & ~(4 | 8 | 16 | 32);

	// Wheel: 64 = up, 65 = down.
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

/**
 * The document point under a 1-based terminal cell. The camera decides: in
 * fullscreen the region starts at the alternate screen's row zero; in flow
 * it starts at the command-start row, scrolled by the camera.
 */
function documentPointAt(
	handler: EventHandler,
	col: number,
	row: number,
): {
	x: number;
	y: number;

	/** False for a row above the painted region -- a shell prompt's rows. */
	inDocument: boolean;
} {
	const screen = handler[kTermDOM][kScreen];
	const documentRow =
		handler[kDocument].fullscreenElement !== null
			? row - 1 + screen.anchorScrollTop
			: row - 1 - screen.documentTop + screen.scrollTop;
	const inDocument = documentRow >= 0;
	return {x: col - 1, y: inDocument ? documentRow : 0, inDocument};
}

/**
 * Scroll a wheel tick nothing canceled: the innermost scroll box that can
 * still move, else the camera. True when the tick escaped past both, which
 * is where scroll chaining hands the wheel to the terminal.
 */
function scrollByWheel(
	handler: EventHandler,
	target: Element,
	deltaY: number,
): boolean {
	const scroller = wheelScrollerFor(handler, target, deltaY);
	if (scroller) {
		scroller.scrollTop += deltaY;
		return false;
	}
	const termDOM = handler[kTermDOM];
	if (
		deltaY < 0 &&
		termDOM[kScreen].scrollTop === 0 &&
		handler[kDocument].fullscreenElement === null
	) {
		return true;
	}
	termDOM[kScreen].scrollTo(termDOM[kScreen].scrollTop + deltaY);
	void render(termDOM);
	return false;
}

/* -------------------------------------------- gestures and default actions */

/**
 * End a scroll-chaining yield, from whichever of the two triggers reaches it
 * first -- a keystroke (the common case) or the fallback timer (see
 * kScrollChainTimer). Both need the same cleanup, so this is the one place
 * that does it: clear the pending timer (the other trigger firing later would
 * be a harmless no-op, but there is no reason to let it) and restore mouse
 * capture.
 */
function reclaimMouseCapture(handler: EventHandler): void {
	if (handler[kScrollChainTimer] !== null) {
		clearTimeout(handler[kScrollChainTimer]);
		handler[kScrollChainTimer] = null;
	}
	handler[kMouseCaptureYielded] = false;
	void render(handler[kTermDOM]);
}

/**
 * A drag's motion: the anchor set by the press says which selection the
 * pointer is extending, the field's own or the document's.
 */
function dragTo(
	handler: EventHandler,
	x: number,
	y: number,
	inDocument: boolean,
): void {
	// A field drag extends the field's own selection to the offset
	// under the pointer -- clamped into the field, whichever element
	// the pointer is over now (the field holds the capture).
	if (handler[kFieldDragAnchor] && inDocument) {
		const {element: fieldElement, offset: anchor} = handler[kFieldDragAnchor];
		const focus = fieldCaretOffset(fieldElement, x, y);
		if (focus !== null) {
			setUASelection(
				fieldElement,
				Math.min(anchor, focus),
				Math.max(anchor, focus),
				focus < anchor ? "backward" : "forward",
			);
			void render(handler[kTermDOM]);
		}
		return;
	}
	// Dragging with the anchor set extends the document selection to
	// the caret position under the pointer. setBaseAndExtent handles a
	// backward drag itself; over a textless stretch -- or user-select:
	// none content -- the focus simply stays where it last was.
	if (
		handler[kSelectionDragAnchor] && handler[kMouseDownTarget] && inDocument
	) {
		const focus = textPositionAt(handler, x, y);
		if (focus && selectable(handler, focus)) {
			const anchor = handler[kSelectionDragAnchor];
			handler[kWindow]
				.getSelection()
				?.setBaseAndExtent(
					anchor.node,
					anchor.offset,
					focus.node,
					focus.offset,
				);
			void render(handler[kTermDOM]);
		}
	}
}

/**
 * A button press: the gesture the release will be measured against, then
 * mousedown, then the default actions a browser runs on it -- moving
 * focus, parking a field's caret, collapsing the document selection.
 */
function press(
	handler: EventHandler,
	target: Element,
	base: number,
	x: number,
	y: number,
	inDocument: boolean,
	eventInit: object,
): void {
	handler[kMouseDownTarget] = target;
	// The popover a press belongs to, which the release compares
	// against: light dismiss is a press and a release in the same
	// place, so a drag out of a popover does not close it.
	handler[kPopoverPressTarget] = lightDismissPress(target);
	handler[kFieldDragAnchor] = null;
	// A pointer press suppresses the :focus-visible ring.
	if (handler[kTermDOM][kStyleManager].setFocusVisible(false)) {
		handler[kTermDOM][kStyleManager].handleFocusChange(
			handler[kDocument].activeElement,
		);
		void render(handler[kTermDOM]);
	}
	const notCanceled = dispatchAsUserAgent(
		target,
		new handler[kWindow].MouseEvent("mousedown", eventInit),
	);
	if (!notCanceled) {
		return;
	}
	// Default action: mousedown moves focus, exactly as in a browser --
	// to the nearest focusable ancestor, or away from the active element
	// when the click lands on nothing focusable.
	const focusable = target.closest(FOCUSABLE_SELECTOR);
	const active = handler[kDocument].activeElement;
	if (focusable && focusable !== active) {
		(focusable as HTMLElement).focus();
		void render(handler[kTermDOM]);
	} else if (!focusable && active && active !== handler[kDocument].body) {
		(active as HTMLElement).blur();
		void render(handler[kTermDOM]);
	}

	// A select's press-to-open and option-row commit are the select
	// widget's own mousedown listener, run during dispatch above --
	// the un-retargeted option row it needs comes from the rows' own
	// document rects, not a renderer hit-test here.

	// Default action: a press in a text field parks the caret at
	// the pressed character and anchors a FIELD drag there -- the
	// field's own bounded selectionStart/End world, never the
	// document selection: the same split a browser makes.
	const parked =
		base === 0 && inDocument ? parkFieldCaret(target, x, y) : null;
	if (parked) {
		handler[kFieldDragAnchor] = {
			element: parked.field as HTMLInputElement | HTMLTextAreaElement,
			offset: parked.offset,
		};
		// The DOCUMENT selection still clears on entry -- a page
		// selection doesn't stay highlighted behind a field click
		// in a browser either. The two worlds just never merge:
		// getSelection() cannot see inside the field, per spec.
		const docSelection = handler[kWindow].getSelection();
		if (docSelection && !docSelection.isCollapsed) {
			docSelection.removeAllRanges();
		}
		void render(handler[kTermDOM]);
	}

	// Default action: mousedown collapses the document selection at
	// the pressed caret position and anchors a possible drag there,
	// as in a browser. Left button only -- and preventDefault on
	// mousedown suppresses it, which is exactly how apps that want
	// the drag events for themselves opt out.
	const selection = handler[kWindow].getSelection();
	if (base === 0 && selection && !handler[kFieldDragAnchor]) {
		let anchor = inDocument ? textPositionAt(handler, x, y) : null;
		// user-select: none refuses the anchor: a press on it clears
		// the selection and starts no drag.
		if (anchor && !selectable(handler, anchor)) {
			anchor = null;
		}
		const hadSelection = !selection.isCollapsed;
		handler[kSelectionDragAnchor] = anchor;
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
			void render(handler[kTermDOM]);
		}
	}
}

/**
 * A button release: mouseup, light dismiss, and -- unless the gesture
 * turned out to be a selecting drag -- the click and dblclick it
 * completes.
 */
function release(
	handler: EventHandler,
	target: Element,
	eventInit: object,
): void {
	dispatchAsUserAgent(
		target,
		new handler[kWindow].MouseEvent("mouseup", eventInit),
	);
	// LIGHT DISMISS runs before the click, as in a browser; the gesture
	// state is the press target remembered at mousedown.
	lightDismissRelease(target, handler[kPopoverPressTarget]);
	handler[kPopoverPressTarget] = null;
	// A selection is only a selection: writing the clipboard is a
	// deliberate act, through navigator.clipboard. The terminal's own
	// select-to-copy remains available as Shift+drag, which bypasses
	// mouse reporting.
	let selectedByDrag = false;
	handler[kFieldDragAnchor] = null;
	if (handler[kSelectionDragAnchor]) {
		handler[kSelectionDragAnchor] = null;
		const text = handler[kWindow].getSelection()?.toString() ?? "";
		if (text.length > 0) {
			selectedByDrag = true;
		}
	}
	// A drag that selected text is not a click: browsers suppress
	// activation after a selecting gesture, and without this a drag
	// released over a <label> would activate it -- toggling its checkbox,
	// which in a framework app re-renders the very nodes the fresh
	// selection points into, destroying it on the spot.
	if (selectedByDrag) {
		handler[kMouseDownTarget] = null;
		return;
	}
	if (handler[kMouseDownTarget] === target) {
		dispatchAsUserAgent(
			target,
			new handler[kWindow].MouseEvent("click", {...eventInit, buttons: 0}),
		);
		// A checkbox/radio's .checked already flipped -- the activation
		// behavior handles that directly, and forwards it from a <label
		// for> or wrapping label the same way (honoring preventDefault in
		// both cases) -- but that's a property change, invisible to the
		// MutationObserver that would otherwise repaint it, same as .value
		// on a text input. Focus also needs an explicit push here for the
		// label case: a real browser's "focusing steps" move focus to the
		// label's associated control, which the activation behavior alone
		// does not simulate (the direct-click case is already focused via
		// mousedown's own default action above, so this is a harmless
		// no-op there).
		const isCheckable = (el: unknown): el is HTMLInputElement =>
			el instanceof (handler[kWindow] as any).HTMLInputElement &&
			((el as HTMLInputElement).type === "checkbox" ||
				(el as HTMLInputElement).type === "radio");
		const control = isCheckable(target)
			? target
			: target instanceof (handler[kWindow] as any).HTMLLabelElement &&
				isCheckable((target as any).control)
				? ((target as any).control as HTMLInputElement)
				: null;
		if (control) {
			control.focus();
			void render(handler[kTermDOM]);
		}

		// A second click on the same target within the double-click interval
		// is also a dblclick -- in addition to, not instead of, its own click
		// (a browser fires both). Reset after firing so a third quick click
		// starts a fresh pair rather than double-firing again immediately.
		const now = performance.now();
		if (
			handler[kLastClickTarget] === target &&
			now - handler[kLastClickTime] <= EventHandler[kDblclickIntervalMs]
		) {
			dispatchAsUserAgent(
				target,
				new handler[kWindow].MouseEvent("dblclick", {
					...eventInit,
					buttons: 0,
				}),
			);
			handler[kLastClickTarget] = null;
			handler[kLastClickTime] = 0;
		} else {
			handler[kLastClickTarget] = target;
			handler[kLastClickTime] = now;
		}
	}
	handler[kMouseDownTarget] = null;
}

/**
 * One keystroke, as the wire decoded it: keydown at the focused element, the
 * close request Escape carries whether or not a listener took the keydown,
 * then the default actions a live keydown leaves -- Tab, an activation, the
 * keypress a character-producing key owes -- and keyup.
 */
function dispatchKey(handler: EventHandler, stroke: WireKey): void {
	const {key: keyName, char, shiftKey, ctrlKey, altKey, metaKey} = stroke;
	const keyCode = legacyKeyCode(keyName);

	// Keyboard input warrants the :focus-visible ring; repaint if it flipped.
	if (handler[kTermDOM][kStyleManager].setFocusVisible(true)) {
		handler[kTermDOM][kStyleManager].handleFocusChange(
			handler[kDocument].activeElement,
		);
		void render(handler[kTermDOM]);
	}

	// Find the focused element. document.activeElement defaults to body when
	// nothing is focused, so it can't be used with `||` to detect "nothing
	// focused". In fullscreen, a browser moves focus to the fullscreen
	// element as part of entering it -- but focus() only takes
	// elements that are already focusable (tabindex, form controls, etc.),
	// so an arbitrary fullscreen container is otherwise unreachable here.
	// Fall back to it, before document.body, so keydown still lands on it --
	// but prefer an explicitly focused descendant, an input inside the
	// fullscreen element being the case that matters.
	const active = handler[kDocument].activeElement;
	const targetElement =
		active && active !== handler[kDocument].body
			? active
			: handler[kDocument].fullscreenElement || handler[kDocument].body;

	const keydownEvent = new handler[kWindow].KeyboardEvent("keydown", {
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

	// Escape is a CLOSE REQUEST on whatever is on top of the top layer and
	// answers one: a modal dialog fires cancel and closes unless a
	// listener takes it, an auto popover closes outright (nothing cancels
	// a popover, which is why a manual one -- answering no close request
	// -- is the way to keep one up). Whichever entered the layer last is
	// the one the key reaches, so a popover over a dialog closes first.
	// Fullscreen does not intercept the key on the way. Unlike Tab below,
	// a preventDefault on keydown does not suppress it.
	// It does NOT exit fullscreen. The browser's guarantee exists because
	// requestFullscreen takes the user's screen; the alt screen takes
	// nothing -- the emulator, the multiplexer and the signals stay the
	// user's -- and terminal convention gives Escape to the app, where a
	// modal editor or a cancel affordance spends it. A fullscreen app exits
	// by its own affordance or document.exitFullscreen().
	if (keyName === "Escape") {
		if (closeTopmost(handler[kDocument])) {
			void render(handler[kTermDOM]);
			return;
		}
	}

	if (notCanceled) {
		if (keyName === "Tab") {
			moveFocus(handler, shiftKey);
		}

		// Field editing (input and textarea) is each widget's own keydown
		// listener, run during dispatch above -- not a default action here.
		// Which elements a key activates is the DOM's, beside the activation
		// behaviors it runs. Without this default action a focused button and
		// a focused link took focus and painted :focus while doing nothing,
		// advertising an affordance they did not have.
		const activation = keyboardActivation(targetElement);
		if (activation) {
			if (
				(keyName === "Enter" && activation.enter) ||
				(keyName === " " && activation.space)
			) {
				// The user agent's own click, not click()'s synthetic one: it
				// is trusted, as the click a browser generates for keyboard
				// activation is, and dispatching it runs the element's full
				// activation behavior, so a submit button submits its form and
				// a link follows its href, exactly as a mouse click would.
				dispatchAsUserAgent(
					targetElement,
					new handler[kWindow].PointerEvent("click", {
						bubbles: true,
						cancelable: true,
						composed: true,
					}),
				);
				void render(handler[kTermDOM]);
			}
		}
		// A select's editing (open/navigate/commit) is the select widget's
		// own keydown listener, run during dispatch above -- not here.
	}

	// A character-producing key fires keypress between keydown and keyup,
	// and inserting the character is that event's default action -- so a
	// field's `input` arrives after keypress, as it does in a browser, and a
	// keypress a listener cancels inserts nothing. Which keystrokes produce a
	// character is the wire's answer; charCode is that character's own code.
	if (notCanceled && char !== "") {
		const charCode = char.codePointAt(0)!;
		const keypressEvent = new handler[kWindow].KeyboardEvent("keypress", {
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
			insertText(handler, targetElement, char);
		}
	}

	const keyupEvent = new handler[kWindow].KeyboardEvent("keyup", {
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

/**
 * Deliver a typed character to a field as an `insertText` beforeinput; its
 * own listener does the edit.
 *
 * This is the keypress default action, and it runs where a default action
 * runs: after the dispatch it belongs to. That is what puts a field's
 * `input` after its `keypress` rather than between keydown and it. Only a
 * field takes text -- nothing else in this engine is an editing host.
 */
function insertText(
	handler: EventHandler,
	target: Element,
	text: string,
): void {
	const tag = target.tagName;
	if (tag !== "INPUT" && tag !== "TEXTAREA") {
		return;
	}
	dispatchAsUserAgent(
		target,
		new handler[kWindow].InputEvent("beforeinput", {
			inputType: "insertText",
			data: text,
			bubbles: true,
			cancelable: true,
		}),
	);
}

/** Focus the next or previous focusable element. */
function moveFocus(handler: EventHandler, reverse: boolean): void {
	// A modal dialog makes the rest of the document inert, and the visible
	// half of inertness is that Tab cannot leave the dialog: the sequential
	// order is the dialog's own, and it wraps within it.
	const scope = topmostModalDialog(handler[kDocument]) ?? handler[kDocument];
	const entries = sequentialFocusEntries(
		scope,
		handler[kTermDOM][kLayoutEngine],
	);

	// activeElement retargets to the shadow host at document scope; the
	// walk needs the innermost focused element, so follow each root's own
	// activeElement down.
	let current = handler[kDocument].activeElement;
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
	// A stop behind a barrier is only reachable while focus already sits
	// behind the same barrier -- script put it there; Tab may continue
	// within and out, but never in.
	const currentBarrier =
		currentIndex === -1 ? null : entries[currentIndex].barrier;
	// From open ground only open stops are reachable; from behind a
	// barrier, only stops behind the same one -- crossing out is the tree
	// exit below, and crossing in never happens.
	const reachable = (index: number): boolean =>
		entries[index].barrier === currentBarrier;
	const step = reverse ? -1 : 1;
	let nextIndex = -1;
	if (currentIndex === -1) {
		// From the blurred stop, Tab enters at the first element and
		// Shift+Tab at the last, as from a browser's chrome.
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

	// Leaving a barred subtree continues at the barrier owner's tree
	// successor, whatever its tabindex: the owner opted its subtree out of
	// the tab order, so the exit rejoins plain tree order beside it.
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
			// Of everything on the wanted side, the tree-nearest stop wins:
			// forward takes the earliest follower, backward the latest
			// preceder.
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
		// Backward entry into a scope owner's expansion lands on its last
		// stop, not the owner: blocks are contiguous in the flat order, so
		// extend through the run of the owner's shadow-including
		// descendants.
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

	// Tab past the last focusable (or Shift+Tab before the first) rests on
	// nothing. That is the leg of a browser's cycle where focus walks the
	// chrome and the page sees activeElement fall back to body; a terminal
	// has no chrome, so the blurred stop stands in for it. It is also what
	// keeps a scope with a single focusable element escapable -- a pure
	// wrap would cycle Tab onto it forever.
	if (nextIndex === -1) {
		if (current !== null) {
			(current as HTMLElement).blur();
		}
		return;
	}

	const next = entries[nextIndex].element as HTMLElement;
	next.focus();
	// A control the camera is not looking at cannot be typed into, so the
	// move brings it into view -- what a browser does when focus leaves the
	// scrollport, and what makes tabbing through a form longer than the
	// screen work at all.
	next.scrollIntoView({block: "nearest"});

	// Focus is not a DOM mutation, so no observer will schedule a frame -- but
	// :focus styling and the caret (the real terminal cursor, parked in the
	// focused field) both need one to move.
	void render(handler[kTermDOM]);
}

/**
 * The caret position under a document point: the element it hit-tests to,
 * asked of the layout.
 *
 * Null over a form control, whose value is not document text -- its
 * selection is the control's own bounded world, which fieldOffsetAt asks
 * about instead. The two never merge: getSelection() cannot see inside a
 * control, per spec.
 */
function textPositionAt(
	handler: EventHandler,
	x: number,
	y: number,
): {node: Text; offset: number} | null {
	const window = handler[kWindow];
	const element = elementAtDocumentPoint(handler[kDocument], x, y);
	if (
		!element ||
		element instanceof (window as any).HTMLInputElement ||
		element instanceof (window as any).HTMLTextAreaElement
	) {
		return null;
	}
	return handler[kTermDOM][kLayoutEngine].caretPositionFromPoint(x, y, element);
}

/** Whether the text at a caret position may enter the document selection. */
function selectable(
	handler: EventHandler,
	position: {node: Text; offset: number},
): boolean {
	const parent = flatParentElement<Element>(position.node);
	return parent === null ||
		handler[kTermDOM][kStyleManager].isSelectable(parent);
}
