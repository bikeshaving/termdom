/**
 * The input interpreter: a line discipline for the DOM.
 *
 * Decoded wire items -- key chunks, SGR mouse reports, paste bodies -- come in
 * here and DOM events go out. Interpretation is stateful, because a gesture is
 * spread over reports: a click is a press and a release on one element, a
 * dblclick is two clicks close in time, a drag is a press whose motion means
 * selection rather than hover. That transient state is this module's, held for
 * as long as the gesture lasts and no longer.
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
 */

import type {
	Event,
	InputEvent,
	KeyboardEvent,
	UAToolkit,
} from "./dom.js";
import type {EngineWindow} from "./termdom.js";
import type {LayoutEngine} from "./layout.js";
import {type StyleManager, computedStyleOf} from "./cascade.js";
import {decodeKey, decodeMouseReport, domCodeFor, tokenizeInput} from
	"./wire.js";

/* -------------------------------------------------------- focus navigation */

// What Tab traverses and what a mousedown focuses -- one definition of
// "focusable" for both.
//
// `a[href]` is in the list because an anchor WITH an href is focusable and
// sequentially reachable per HTML, and an anchor without one is not -- the
// attribute qualifier draws that line for free. Leaving links out made
// navigation link-shaped UI (TodoMVC's All/Active/Completed filters) reachable
// only by mouse.
const FOCUSABLE_SELECTOR =
	'a[href], input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), details > summary:first-of-type, [tabindex]:not([tabindex="-1"])';

/** What a slot looks like from a module that must not import DOM classes. */
interface SlotLike extends Element {
	assignedNodes(): Node[];
}

interface ShadowRootLike {
	children: ArrayLike<Element> & Iterable<Element>;
	delegatesFocus?: boolean;
}

/**
 * One entry in a focus navigation scope: a single element, or a scope
 * owner standing for its whole expanded scope. The owner's tabindex
 * positions the entry among its siblings; the expansion is already in
 * its own scope's order.
 */
interface ScopeEntry {
	tabindex: number;
	sequence: number;
	elements: SequentialEntry[];
}

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

function tabindexOf(element: Element): number {
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
	toolkit: UAToolkit,
): SequentialEntry[] {
	const isRendered = (element: Element): boolean => {
		// Browsers keep unrendered elements out of tab order: a hidden
		// edit-row checkbox must not swallow a Tab press invisibly. An
		// element is rendered when nothing on its flat-tree chain is
		// display:none and it produced boxes.
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = toolkit.flatParentElement<Element>(ancestor)
		) {
			if (computedStyleOf(ancestor).computedValueOf("display") === "none") {
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
			ancestor = toolkit.flatParentElement<Element>(ancestor)
		) {
			if (ancestor.hasAttribute("inert")) {
				return true;
			}
		}
		return false;
	};
	const isFocusable = (element: Element): boolean =>
		element.matches(FOCUSABLE_SELECTOR) &&
		tabindexOf(element) >= 0 &&
		!isInert(element) &&
		isRendered(element);

	const buildScope = (
		contents: Iterable<Node>,
		barrier: Element | null,
	): SequentialEntry[] => {
		const entries: ScopeEntry[] = [];
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
			const ownerTabindex = tabindexOf(element);
			const shadow = toolkit.shadowRootOf(element) as
				| ShadowRootLike |
				null;
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
				const assigned = (element as SlotLike).assignedNodes();
				const slotContents =
					assigned.length > 0 ? assigned : element.childNodes;
				const inner = buildScope(
					slotContents as Iterable<Node>,
					innerBarrier,
				);
				const expansion = isFocusable(element) ?
						[{element, barrier}, ...inner] :
					inner;
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
		root.nodeType === 9 ?
				((root as Document).documentElement ?
						[(root as Document).documentElement as Element] :
						[]) :
				Array.from((root as Element).children);
	return buildScope(roots, null);
}

/**
 * The `autofocus` default action: an element with the attribute set gets
 * focused as soon as it's connected, the same as a browser does at initial
 * page load -- generalized here to any insertion, which is what lets a
 * dynamically-created element (e.g. an edit input that only exists while
 * editing) still autofocus itself. Scoped to newly added nodes only, not
 * later attribute changes, matching the spec's "insertion" trigger. If a
 * batch inserts more than one autofocus element, the later mutation wins
 * (processed in order, each call simply moves focus again) -- same
 * ambiguity a real page with more than one autofocus element already has.
 */
export function focusAutofocusedNodes(mutations: MutationRecord[]): void {
	for (const record of mutations) {
		for (const node of record.addedNodes) {
			if (node.nodeType !== node.ELEMENT_NODE) {
				continue;
			}
			const element = node as Element;
			const candidate = (element as any).autofocus ?
				element :
					element.querySelector("[autofocus]");
			(candidate as HTMLElement | null)?.focus();
		}
	}
}

/** Input types that are buttons rather than fields. */
const BUTTON_INPUT_TYPES = new Set(["button", "image", "reset", "submit"]);

/**
 * The keys that are a modifier and nothing else, which a user pressing them
 * has not yet asked for anything with.
 */
const BARE_MODIFIER_KEYS = new Set([
	"Alt",
	"AltGraph",
	"CapsLock",
	"Control",
	"Fn",
	"FnLock",
	"Hyper",
	"Meta",
	"NumLock",
	"ScrollLock",
	"Shift",
	"Super",
	"Symbol",
	"SymbolLock",
]);

/**
 * Whether an event is activation-triggering: the user asking for something,
 * rather than something happening to them.
 *
 * These are the spec's -- a key that is neither Escape nor a bare modifier, a
 * mouse press, release or click, a paste. A paste's default action carries
 * the text on to a field as a beforeinput, which is activation-triggering
 * too: a listener that sees the gesture only there still has the gate open.
 * A resize, a focus move, pointer motion and a wheel tick are the user
 * agent's events too, and none of them is a request.
 */
export function isActivationTriggering(event: Event): boolean {
	switch (event.type) {
		case "keydown": {
			const key = (event as KeyboardEvent).key;
			return key !== "Escape" && !BARE_MODIFIER_KEYS.has(key);
		}
		case "mousedown":
		case "mouseup":
		case "click":
		case "pointerup":
		case "paste":
			return true;
		case "beforeinput":
			return (event as InputEvent).inputType === "insertFromPaste";
		default:
			return false;
	}
}

/**
 * Does a keypress on this element activate it, the way a click would?
 *
 * Buttons do, on Enter and on Space. Links do, on Enter only -- Space scrolls
 * the page in a browser rather than following the link, and the difference is
 * observable enough to be worth keeping.
 */
function keyboardActivation(
	element: Element,
): {enter: boolean; space: boolean} | null {
	const tag = element.tagName;
	if (tag === "BUTTON") {
		return {enter: true, space: true};
	}
	if (tag === "INPUT") {
		const type = (element as HTMLInputElement).type;
		return BUTTON_INPUT_TYPES.has(type) ? {enter: true, space: true} : null;
	}
	if (tag === "A" && element.hasAttribute("href")) {
		return {enter: true, space: false};
	}
	// A summary activates on both keys, and activation is what opens the
	// disclosure; whether this summary is its details' summary is the
	// activation behavior's own question.
	if (tag === "SUMMARY") {
		return {enter: true, space: true};
	}
	return null;
}

/* ------------------------------------------------------------ collaborators */

/** A point in document space, and whether the cell it came from is in one. */
export interface DocumentPoint {
	x: number;
	y: number;
	/** False for a row above the painted region -- a shell prompt's rows. */
	inDocument: boolean;
}

/**
 * The document events are built in and dispatched into, and the frame that
 * paints what a dispatch changed.
 */
export interface EventView {
	readonly document: Document;
	readonly window: EngineWindow;
	/**
	 * Dispatch as the user agent: trusted, and counted as a user activation
	 * where the event is one of the gestures that grants it.
	 */
	fireAsUserAgent(target: unknown, event: unknown): boolean;
	/**
	 * Ask for a frame. Reactive pseudo-state, the document selection and the
	 * caret all move without a mutation record, so interpretation says when
	 * the screen owes an answer.
	 */
	requestRender(): void;
}

/** Where a reported cell lands in the document, and what is under it. */
export interface HitTester {
	/** The document point under a 1-based terminal cell. */
	documentPointAt(col: number, row: number): DocumentPoint;
	/** The element at a document point, against fresh layout. */
	elementAt(x: number, y: number): Element | null;
}

/**
 * The user-agent behaviors a dispatched event triggers that belong to the
 * frame rather than to interpretation: scrolling, the top layer, the wire's
 * reporting modes.
 */
export interface UADefaultActions {
	/**
	 * Scroll a wheel tick nothing canceled -- the innermost scroll box that
	 * can still move, else the camera. True when the tick escaped past both,
	 * which is where scroll chaining hands the wheel to the terminal.
	 */
	scrollByWheel(target: Element, deltaY: number): boolean;
	/** Mouse capture was yielded or reclaimed; re-decide the wire's modes. */
	mouseCaptureChanged(): void;
	/** The pointer is over a different element than it was. */
	hoverMoved(target: Element | null): void;
	/** The showing modal dialog Tab is confined to, if one is up. */
	modalScope(): Element | null;
	/** What Escape closes: the topmost modal dialog or auto popover. */
	closeRequestTarget(): Element | null;
	/** The fullscreen element, which keystrokes fall back to. */
	fullscreenTarget(): Element | null;
}

/* ----------------------------------------------------------- the interpreter */

const kView = Symbol("view");
const kHitTest = Symbol("hitTest");
const kDefaults = Symbol("defaults");
const kToolkit = Symbol("toolkit");
const kStyleManager = Symbol("styleManager");
const kLayout = Symbol("layout");
const kLastMouse = Symbol("lastMouse");
const kPendingHover = Symbol("pendingHover");
const kHoverElement = Symbol("hoverElement");
const kMouseCaptureYielded = Symbol("mouseCaptureYielded");
const kScrollChainTimer = Symbol("scrollChainTimer");
const kSCROLL_CHAIN_TIMEOUT_MS = Symbol("SCROLL_CHAIN_TIMEOUT_MS");
const kMouseDownTarget = Symbol("mouseDownTarget");
const kPopoverPressTarget = Symbol("popoverPressTarget");
const kSelectionDragAnchor = Symbol("selectionDragAnchor");
const kFieldDragAnchor = Symbol("fieldDragAnchor");
const kLastClickTarget = Symbol("lastClickTarget");
const kLastClickTime = Symbol("lastClickTime");
const kDBLCLICK_INTERVAL_MS = Symbol("DBLCLICK_INTERVAL_MS");

export class EventHandler {
	declare [kView]: EventView;
	declare [kHitTest]: HitTester;
	declare [kDefaults]: UADefaultActions;
	declare [kToolkit]: UAToolkit;
	declare [kStyleManager]: StyleManager;
	declare [kLayout]: LayoutEngine;

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
	// #SCROLL_CHAIN_TIMEOUT_MS of silence (see kScrollChainTimer).
	declare [kMouseCaptureYielded]: boolean;
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
	static readonly [kSCROLL_CHAIN_TIMEOUT_MS] = 3000;
	declare [kScrollChainTimer]: ReturnType<typeof setTimeout> | null;
	// Where the last mousedown landed, so a mouseup on the same element
	// becomes a click. (Browsers dispatch click at the nearest common
	// ancestor; the same-element case is the one that matters on a cell grid.)
	declare [kMouseDownTarget]: Element | null;
	// The popover the last mousedown belonged to, which light dismiss compares
	// the release against.
	declare [kPopoverPressTarget]: object | null;
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

	// The target and time of the last completed click, to detect a second one
	// close enough behind it to be a dblclick -- browsers' own double-click
	// interval varies by OS/user setting; 500ms is the common default.
	static readonly [kDBLCLICK_INTERVAL_MS] = 500;
	declare [kLastClickTarget]: Element | null;
	declare [kLastClickTime]: number;

	constructor(deps: {
		view: EventView;
		hitTest: HitTester;
		defaults: UADefaultActions;
		toolkit: UAToolkit;
		styleManager: StyleManager;
		layout: LayoutEngine;
	}) {
		this[kView] = deps.view;
		this[kHitTest] = deps.hitTest;
		this[kDefaults] = deps.defaults;
		this[kToolkit] = deps.toolkit;
		this[kStyleManager] = deps.styleManager;
		this[kLayout] = deps.layout;
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

	/**
	 * End a scroll-chaining yield, from whichever of the two triggers reaches
	 * it first -- a keystroke (the common case) or the fallback timer (see
	 * kScrollChainTimer). Both need the same cleanup, so this is the one place
	 * that does it: clear the pending timer (the other trigger firing later
	 * would be a harmless no-op, but there is no reason to let it) and restore
	 * mouse capture.
	 */
	reclaimMouseCapture(): void {
		if (this[kScrollChainTimer] !== null) {
			clearTimeout(this[kScrollChainTimer]);
			this[kScrollChainTimer] = null;
		}
		this[kMouseCaptureYielded] = false;
		this[kDefaults].mouseCaptureChanged();
	}

	/** Drop the gesture timers, so none of them keeps the event loop open. */
	dispose(): void {
		if (this[kScrollChainTimer] !== null) {
			clearTimeout(this[kScrollChainTimer]);
			this[kScrollChainTimer] = null;
		}
	}

	/**
	 * A mouse report from the terminal (SGR encoding: `CSI < code ; col ; row
	 * M/m`). These only arrive while capture is on.
	 *
	 * Reports become the DOM's own mouse events, dispatched at the element
	 * under the cell (document.elementFromPoint is layout-true), with the
	 * browser's default actions: wheel scrolls the camera, mousedown moves
	 * focus, mouseup on the mousedown target is a click.
	 */
	handleMouseReport(
		code: number,
		col: number,
		row: number,
		isRelease: boolean,
	): void {
		const view = this[kView];
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

		const {x, y, inDocument} = this[kHitTest].documentPointAt(col, row);

		// Motion arrives at cell granularity -- with 1003 on, a report per cell
		// crossed -- so it is COALESCED: the frame hit-tests the last position
		// once and updates the hover chain there (see resolvePendingHover),
		// instead of paying a hit-test per report. A drag's motion (base <= 2)
		// falls through besides: its per-report mousemove and selection updates
		// predate hover and keep their timing.
		if (isMotion) {
			this[kPendingHover] = {
				x,
				y,
				shiftKey,
				altKey,
				ctrlKey,
				quiet: base <= 2,
			};
			if (base > 2) {
				view.requestRender();
				return;
			}
		}

		// Already document-relative -- go straight to the shared hit-test rather
		// than through the public elementFromPoint, which expects viewport-
		// relative input and would convert it right back.
		const target =
			(inDocument && this[kHitTest].elementAt(x, y)) || view.document.body;

		if (wheelDeltaY !== null) {
			const notCanceled = view.fireAsUserAgent(
				target,
				new view.window.WheelEvent("wheel", {
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
			if (notCanceled && this[kDefaults].scrollByWheel(
				target as Element,
				wheelDeltaY,
			)) {
				// Scroll chaining, the browser default: the camera is at the
				// document top, so the scroll escapes to the parent scroller --
				// here, the terminal's own scrollback. Yield the mouse so the
				// next wheel tick scrolls the shell history natively; the next
				// keystroke reclaims it, and #SCROLL_CHAIN_TIMEOUT_MS of silence
				// reclaims it too, in case the user scrolls back down without
				// ever pressing a key -- wheel activity while yielded produces no
				// signal we could otherwise catch that on. An app opts out the
				// same way it would in a browser: preventDefault on the wheel
				// event.
				this[kMouseCaptureYielded] = true;
				this[kDefaults].mouseCaptureChanged();
				if (this[kScrollChainTimer] !== null) {
					clearTimeout(this[kScrollChainTimer]);
				}
				this[kScrollChainTimer] = setTimeout(() => {
					this[kScrollChainTimer] = null;
					this.reclaimMouseCapture();
				}, EventHandler[kSCROLL_CHAIN_TIMEOUT_MS]);
			}
			return;
		}

		// Buttons: 0/1/2 = left/middle/right. 3 is "no button" in the legacy
		// encoding; SGR names the button even on release, so 3 carries nothing.
		if (base > 2) {
			return;
		}
		const last = this[kLastMouse];
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
		this[kLastMouse] = {x, y};

		if (isMotion) {
			view.fireAsUserAgent(
				target,
				new view.window.MouseEvent("mousemove", eventInit),
			);
			dragTo(this, x, y, inDocument);
			return;
		}

		if (!isRelease) {
			press(this, target, base, x, y, inDocument, eventInit);
			return;
		}

		release(this, target, eventInit);
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
		const view = this[kView];
		const {x, y, shiftKey, altKey, ctrlKey} = pending;
		const target = this[kHitTest].elementAt(x, y) || view.document.body;
		const previous = this[kHoverElement];
		if (target !== previous) {
			this[kHoverElement] = target;
			this[kDefaults].hoverMoved(target);
			this[kStyleManager].handleHoverChange(previous, target);
			const chainOf = (element: Element | null): Element[] => {
				const chain: Element[] = [];
				for (
					let node: Element | null = element;
					node;
					node = this[kToolkit].flatParentElement<Element>(node)
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
				view.fireAsUserAgent(
					previous,
					new view.window.MouseEvent("mouseout", {
						...boundaryInit,
						bubbles: true,
						cancelable: true,
						relatedTarget: target,
					}),
				);
				for (const node of previousChain) {
					if (!targetSet.has(node)) {
						view.fireAsUserAgent(
							node,
							new view.window.MouseEvent("mouseleave", {
								...boundaryInit,
								relatedTarget: target,
							}),
						);
					}
				}
			}
			view.fireAsUserAgent(
				target,
				new view.window.MouseEvent("mouseover", {
					...boundaryInit,
					bubbles: true,
					cancelable: true,
					relatedTarget: previous,
				}),
			);
			const entering = targetChain.filter((node) => !previousSet.has(node));
			for (let i = entering.length - 1; i >= 0; i--) {
				view.fireAsUserAgent(
					entering[i],
					new view.window.MouseEvent("mouseenter", {
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
			view.fireAsUserAgent(
				target,
				new view.window.MouseEvent("mousemove", {
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

	/**
	 * Deliver a paste as a `paste` event carrying the text, at the focused
	 * element or at the body when nothing is focused. A paste nobody cancels
	 * runs its default action: into a text field, an `insertFromPaste`
	 * beforeinput whose listener does the edit. Anywhere else the event is the
	 * whole of it, and an application that wants the text reads it off
	 * `clipboardData`.
	 */
	handlePaste(text: string): void {
		const view = this[kView];
		// A terminal transmits a pasted line break as CR -- the byte Enter
		// sends (tmux's paste-buffer documents the LF-to-CR replacement) --
		// while the DOM's paste carries newlines as LF. Converted here, at the
		// boundary, so a multi-line paste into a textarea is multi-line and
		// a field's own handlers never see a bare CR.
		text = text.replace(/\r\n?/g, "\n");
		const focused = view.document.activeElement;
		const target =
			focused && focused !== view.document.body ?
				focused :
				view.document.body;
		const clipboardData = new view.window.DataTransfer();
		clipboardData.setData("text/plain", text);
		this[kToolkit].lockDataTransfer(clipboardData);
		const proceed = view.fireAsUserAgent(
			target,
			new view.window.ClipboardEvent("paste", {
				clipboardData,
				bubbles: true,
				cancelable: true,
			}),
		);
		const tag = target.tagName;
		if (proceed && (tag === "INPUT" || tag === "TEXTAREA")) {
			view.fireAsUserAgent(
				target,
				new view.window.InputEvent("beforeinput", {
					inputType: "insertFromPaste",
					data: text,
					bubbles: true,
					cancelable: true,
				}),
			);
		}
		view.requestRender();
	}

	/**
	 * A chunk of decoded keystrokes. A keystroke also means the user is back
	 * at the live screen -- terminals snap to the bottom on input -- so it
	 * takes the mouse back from a scroll-chaining yield.
	 */
	handleKeys(keyInput: string): void {
		if (this[kMouseCaptureYielded]) {
			this.reclaimMouseCapture();
		}
		dispatchKey(this, keyInput);
	}
}

/* -------------------------------------------- gestures and default actions */

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
	const view = handler[kView];
	// A field drag extends the field's own selection to the offset
	// under the pointer -- clamped into the field, whichever element
	// the pointer is over now (the field holds the capture).
	if (handler[kFieldDragAnchor] && inDocument) {
		const {element: fieldElement, offset: anchor} = handler[kFieldDragAnchor];
		const focus = fieldOffsetAt(handler, fieldElement, x, y);
		if (focus !== null) {
			handler[kToolkit].setSelection(
				fieldElement,
				Math.min(anchor, focus),
				Math.max(anchor, focus),
				focus < anchor ? "backward" : "forward",
			);
			view.requestRender();
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
			view.window
				.getSelection()
				?.setBaseAndExtent(
					anchor.node,
					anchor.offset,
					focus.node,
					focus.offset,
				);
			view.requestRender();
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
	const view = handler[kView];
	handler[kMouseDownTarget] = target;
	// The popover a press belongs to, which the release compares
	// against: light dismiss is a press and a release in the same
	// place, so a drag out of a popover does not close it.
	handler[kPopoverPressTarget] = handler[kToolkit].topmostClickedPopover(
		target,
	);
	handler[kFieldDragAnchor] = null;
	// A pointer press suppresses the :focus-visible ring.
	if (handler[kStyleManager].setFocusVisible(false)) {
		handler[kStyleManager].handleFocusChange(view.document.activeElement);
		view.requestRender();
	}
	const notCanceled = view.fireAsUserAgent(
		target,
		new view.window.MouseEvent("mousedown", eventInit),
	);
	if (!notCanceled) {
		return;
	}
	// Default action: mousedown moves focus, exactly as in a browser --
	// to the nearest focusable ancestor, or away from the active element
	// when the click lands on nothing focusable.
	const focusable = target.closest?.(FOCUSABLE_SELECTOR);
	const active = view.document.activeElement;
	if (focusable && focusable !== active) {
		(focusable as HTMLElement).focus();
		view.requestRender();
	} else if (!focusable && active && active !== view.document.body) {
		(active as HTMLElement).blur();
		view.requestRender();
	}

	// A select's press-to-open and option-row commit are the select
	// widget's own mousedown listener, run during dispatch above --
	// the un-retargeted option row it needs comes from the rows' own
	// document rects, not a renderer hit-test here.

	// Default action: a press in a text field parks the caret at
	// the pressed character and anchors a FIELD drag there -- the
	// field's own bounded selectionStart/End world, never the
	// document selection: the same split a browser makes.
	const field =
		base === 0 && inDocument && handler[kToolkit].isTextField(target) ?
				(target as HTMLInputElement | HTMLTextAreaElement) :
			null;
	if (field) {
		const offset = fieldOffsetAt(handler, field, x, y);
		if (offset !== null) {
			handler[kToolkit].setSelection(field, offset, offset);
			handler[kFieldDragAnchor] = {element: field, offset};
			// The DOCUMENT selection still clears on entry -- a page
			// selection doesn't stay highlighted behind a field click
			// in a browser either. The two worlds just never merge:
			// getSelection() cannot see inside the field, per spec.
			const docSelection = view.window.getSelection();
			if (docSelection && !docSelection.isCollapsed) {
				docSelection.removeAllRanges();
			}
			view.requestRender();
		}
	}

	// Default action: mousedown collapses the document selection at
	// the pressed caret position and anchors a possible drag there,
	// as in a browser. Left button only -- and preventDefault on
	// mousedown suppresses it, which is exactly how apps that want
	// the drag events for themselves opt out.
	const selection = view.window.getSelection();
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
			view.requestRender();
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
	const view = handler[kView];
	view.fireAsUserAgent(
		target,
		new view.window.MouseEvent("mouseup", eventInit),
	);
	// LIGHT DISMISS: a release closes every auto popover the released
	// point is not inside of and did not open -- the invoker of a popover
	// counts as part of it, so the click that follows toggles rather than
	// reopens what this closed. It runs before the click, where a browser
	// runs it, and no listener can prevent it.
	const dismissAncestor = handler[kToolkit].topmostClickedPopover(target);
	const samePopoverPress = dismissAncestor === handler[kPopoverPressTarget];
	handler[kPopoverPressTarget] = null;
	if (samePopoverPress && handler[kToolkit].topmostAutoPopover() !== null) {
		handler[kToolkit].hidePopoversUntil(dismissAncestor, false, true);
	}
	// A selection is only a selection: writing the clipboard is a
	// deliberate act, through navigator.clipboard. The terminal's own
	// select-to-copy remains available as Shift+drag, which bypasses
	// mouse reporting.
	let selectedByDrag = false;
	if (handler[kFieldDragAnchor]) {
		handler[kFieldDragAnchor] = null;
	}
	if (handler[kSelectionDragAnchor]) {
		handler[kSelectionDragAnchor] = null;
		const text = view.window.getSelection()?.toString() ?? "";
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
		view.fireAsUserAgent(
			target,
			new view.window.MouseEvent("click", {...eventInit, buttons: 0}),
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
			el instanceof (view.window as any).HTMLInputElement &&
			((el as HTMLInputElement).type === "checkbox" ||
				(el as HTMLInputElement).type === "radio");
		const control = isCheckable(target) ?
			target :
			target instanceof (view.window as any).HTMLLabelElement &&
			isCheckable((target as any).control) ?
					((target as any).control as HTMLInputElement) :
				null;
		if (control) {
			control.focus();
			view.requestRender();
		}

		// A second click on the same target within the double-click interval
		// is also a dblclick -- in addition to, not instead of, its own click
		// (a browser fires both). Reset after firing so a third quick click
		// starts a fresh pair rather than double-firing again immediately.
		const now = performance.now();
		if (
			handler[kLastClickTarget] === target &&
			now - handler[kLastClickTime] <= EventHandler[kDBLCLICK_INTERVAL_MS]
		) {
			view.fireAsUserAgent(
				target,
				new view.window.MouseEvent("dblclick", {
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

function dispatchKey(handler: EventHandler, key: string): void {
	const view = handler[kView];
	// Tokenize multi-key chunks and dispatch each token on its own.
	const tokens = Array.from(tokenizeInput(key));
	if (tokens.length > 1) {
		for (const token of tokens) {
			dispatchKey(handler, token);
		}
		return;
	}

	// A cursor position report with no query outstanding is a late or
	// duplicate terminal reply, not a keystroke: decodeKey returns null and
	// nothing is dispatched.
	const stroke = decodeKey(key);
	if (!stroke) {
		return;
	}
	const {keyName, keyCode, charCode, shiftKey, ctrlKey, altKey, metaKey} =
		stroke;

	// Keyboard input warrants the :focus-visible ring; repaint if it flipped.
	if (handler[kStyleManager].setFocusVisible(true)) {
		handler[kStyleManager].handleFocusChange(view.document.activeElement);
		view.requestRender();
	}

	// Find the focused element. document.activeElement defaults to body when
	// nothing is focused, so it can't be used with `||` to detect "nothing
	// focused". In fullscreen, a browser moves focus to the fullscreen
	// element as part of entering it -- but focus() only takes
	// elements that are already focusable (tabindex, form controls, etc.),
	// so an arbitrary fullscreen container is otherwise unreachable here.
	// Fall back to it (before document.body) so keydown still lands on it,
	// the same as the dedicated fullscreen dispatch this replaced -- but
	// still prefer an explicitly focused descendant (e.g. an input inside
	// the fullscreen element), which the old dispatch ignored.
	const active = view.document.activeElement;
	const targetElement =
		active && active !== view.document.body ?
			active :
			handler[kDefaults].fullscreenTarget() || view.document.body;

	// Escape does NOT exit fullscreen. The browser's guarantee exists
	// because requestFullscreen takes the user's screen; the alt screen
	// takes nothing -- the emulator, the multiplexer and the signals stay
	// the user's -- and terminal convention gives Escape to the app, where
	// a modal editor or a cancel affordance spends it. A fullscreen app
	// exits by its own affordance or document.exitFullscreen().

	const keydownEvent = new view.window.KeyboardEvent("keydown", {
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

	const notCanceled = view.fireAsUserAgent(targetElement, keydownEvent);

	// Escape is a CLOSE REQUEST on whatever is on top of the top layer and
	// answers one: a modal dialog fires cancel and closes unless a
	// listener takes it, an auto popover closes outright (nothing cancels
	// a popover, which is why a manual one -- answering no close request
	// -- is the way to keep one up). Whichever entered the layer last is
	// the one the key reaches, so a popover over a dialog closes first.
	// Fullscreen does not intercept the key on the way. Unlike Tab below,
	// a preventDefault on keydown does not suppress it.
	if (keyName === "Escape") {
		const target = handler[kDefaults].closeRequestTarget();
		if (target !== null) {
			if (handler[kToolkit].isShowingPopover(target)) {
				handler[kToolkit].closePopover(target);
			} else {
				(target as HTMLDialogElement).requestClose();
			}
			view.requestRender();
			return;
		}
	}

	if (notCanceled) {
		if (keyName === "Tab") {
			moveFocus(handler, shiftKey);
		}

		// Field editing (input and textarea) is each widget's own keydown
		// listener, run during dispatch above -- not a default action here.
		const activation = keyboardActivation(targetElement);
		if (activation) {
			// A focused button activates on Enter and on Space, and a link on
			// Enter, per HTML's activation behavior. Without this, both took
			// focus and painted :focus while doing nothing -- advertising an
			// affordance they did not have. `input[type=submit|button]`
			// activate here; text inputs never match keyboardActivation.
			if (
				(keyName === "Enter" && activation.enter) ||
				(key === " " && activation.space)
			) {
				// The user agent's own click, not click()'s synthetic one: it
				// is trusted, as the click a browser generates for keyboard
				// activation is, and dispatching it runs the element's full
				// activation behavior, so a submit button submits its form and
				// a link follows its href, exactly as a mouse click would.
				view.fireAsUserAgent(
					targetElement,
					new view.window.PointerEvent("click", {
						bubbles: true,
						cancelable: true,
						composed: true,
					}),
				);
				view.requestRender();
			}
		}
		// A select's editing (open/navigate/commit) is the select widget's
		// own keydown listener, run during dispatch above -- not here.
	}

	// A character-producing key fires keypress between keydown and keyup,
	// and inserting the character is that event's default action -- so a
	// field's `input` arrives after keypress, as it does in a browser, and a
	// keypress a listener cancels inserts nothing. Every printable
	// character, not only the ASCII ones: charCode is the character's own
	// code, and DEL and the control codes are the keys named elsewhere.
	if (notCanceled && key.length === 1 && charCode >= 32 && charCode !== 127) {
		const keypressEvent = new view.window.KeyboardEvent("keypress", {
			key,
			code: domCodeFor(key),
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
		if (view.fireAsUserAgent(targetElement, keypressEvent)) {
			insertText(handler, targetElement, key);
		}
	}

	const keyupEvent = new view.window.KeyboardEvent("keyup", {
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
	view.fireAsUserAgent(targetElement, keyupEvent);
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
	const view = handler[kView];
	view.fireAsUserAgent(
		target,
		new view.window.InputEvent("beforeinput", {
			inputType: "insertText",
			data: text,
			bubbles: true,
			cancelable: true,
		}),
	);
}

/** Focus the next or previous focusable element. */
function moveFocus(handler: EventHandler, reverse: boolean): void {
	const view = handler[kView];
	const toolkit = handler[kToolkit];
	// A modal dialog makes the rest of the document inert, and the visible
	// half of inertness is that Tab cannot leave the dialog: the sequential
	// order is the dialog's own, and it wraps within it.
	const scope = handler[kDefaults].modalScope() ?? view.document;
	const entries = sequentialFocusEntries(scope, handler[kLayout], toolkit);

	// activeElement retargets to the shadow host at document scope; the
	// walk needs the innermost focused element, so follow each root's own
	// activeElement down.
	let current = view.document.activeElement;
	while (current !== null) {
		const shadow = toolkit.shadowRootOf<ShadowRoot>(current);
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

	// Tab past the last focusable (or Shift+Tab before the first) rests on
	// nothing. That is the leg of a browser's cycle where focus walks the
	// chrome and the page sees activeElement fall back to body; a terminal
	// has no chrome, so the blurred stop stands in for it. It is also what
	// keeps a scope with a single focusable element escapable -- a pure
	// wrap would cycle Tab onto it forever.
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
					ancestor !== null;
					ancestor = toolkit.flatParentElement<Element>(ancestor)
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
	view.requestRender();
}

/**
 * The caret position under a document point: the element it hit-tests to,
 * asked of the layout.
 *
 * Null over a form control, whose value is not document text -- its
 * selection is the control's own bounded world, which #fieldOffsetAt asks
 * about instead. The two never merge: getSelection() cannot see inside a
 * control, per spec.
 */
function textPositionAt(
	handler: EventHandler,
	x: number,
	y: number,
): {node: Text; offset: number} | null {
	const window = handler[kView].window;
	const element = handler[kHitTest].elementAt(x, y);
	if (
		!element ||
		element instanceof (window as any).HTMLInputElement ||
		element instanceof (window as any).HTMLTextAreaElement
	) {
		return null;
	}
	return handler[kLayout].caretPositionFromPoint(x, y, element);
}

/** Whether the text at a caret position may enter the document selection. */
function selectable(
	handler: EventHandler,
	position: {node: Text; offset: number},
): boolean {
	const parent = handler[kToolkit].flatParentElement<Element>(position.node);
	return parent === null || handler[kStyleManager].isSelectable(parent);
}

/**
 * The value offset under a document-space point in a text field --
 * cell-width aware, clamped to the nearest offset so a drag that
 * leaves the field still resolves (the browser's capture model:
 * a selection begun in a field is the field's until release).
 */
function fieldOffsetAt(
	handler: EventHandler,
	element: HTMLInputElement | HTMLTextAreaElement,
	x: number,
	y: number,
): number | null {
	// The value's own text: a field's selection is measured in ITS offsets,
	// and for a password that text is the bullets, which is what was
	// painted and so what the point lands on.
	const valueText = handler[kToolkit].valueTextOf(element);
	if (!valueText) {
		return null;
	}
	const found = handler[kLayout].caretPositionFromPoint(x, y, valueText, true);
	if (!found) {
		return null;
	}
	return Math.min(found.offset, valueText.data.length);
}
