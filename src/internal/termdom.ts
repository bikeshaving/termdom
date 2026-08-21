/**
 * The engine: it owns the document, the frame loop and the terminal, and is
 * where the three meet.
 *
 * A mutation becomes a frame here -- style, then layout, then paint -- and the
 * frame becomes bytes on the session.
 */
import * as DOM from "./dom.js";
import {
	caretRangeOf,
	fieldValueText,
	flatIsConnected,
	flatParentElement,
	scrollOffsetOf,
	setScrollOffset,
	closePopover,
	hidePopoversUntil,
	installUAEngine,
	isModalDialog,
	isShowingPopover,
	isTextField,
	pseudoHostOf,
	setUASelection,
	topLayerOf,
	topmostAutoPopover,
	topmostClickedPopover,
	upgradeUAWidget,
} from "./dom.js";
import {LayoutEngine} from "./layout.js";
import {Viewport} from "./viewport.js";
import {Painter} from "./painter.js";
import {
	TerminalSession,
	transportFromProcess,
	type TerminalCloseInfo,
	type TerminalSize,
	type TerminalTransport,
} from "./terminalsession.js";
import {Screen} from "./ansi.js";
import {StyleManager, computedStyleOf, getBoxModel} from "./styles.js";
import {stringWidth} from "./text.js";
import {
	ObserverManager,
	ResizeObserver as TermResizeObserver,
	IntersectionObserver as TermIntersectionObserver,
} from "./observers.js";
import {
	FOCUSABLE_SELECTOR,
	decodeKey,
	decodeMouseReport,
	domCodeFor,
	focusAutofocusedNodes,
	getFocusableElements,
	keyboardActivation,
	tokenizeInput,
} from "./events.js";

// How long to wait for a resize drag to settle before redrawing. Long enough to
// coalesce the burst of SIGWINCHes a drag fires, short enough to feel immediate.
const RESIZE_DEBOUNCE_MS = 40;

const BASE64_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** UTF-8 base64 of a string, the payload OSC 52 carries to the clipboard. */
function base64OfText(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i];
		const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
		const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
		out += BASE64_ALPHABET[a >> 2];
		out += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)];
		out +=
			i + 1 < bytes.length ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
		out += i + 2 < bytes.length ? BASE64_ALPHABET[c & 63] : "=";
	}
	return out;
}

// The built-in tags that upgrade to a UA widget on connect.
const UPGRADEABLE_CONTROLS = new Set([
	"DETAILS",
	"INPUT",
	"METER",
	"PROGRESS",
	"SELECT",
	"TEXTAREA",
]);

/**
 * Upgrade every control in a newly connected subtree, the element itself
 * included. A walk over the subtree's own child links rather than a selector
 * query: every insertion pays this, and a document of ordinary markup must pay
 * as little as a tag comparison per element.
 */
function upgradeControlsIn(root: Element): void {
	const stack: Element[] = [root];
	while (stack.length > 0) {
		const element = stack.pop()!;
		if (UPGRADEABLE_CONTROLS.has(element.tagName)) {
			upgradeUAWidget(element);
		}
		for (
			let child = element.firstElementChild;
			child !== null;
			child = child.nextElementSibling
		) {
			stack.push(child);
		}
	}
}

// The engine each document is mounted in. The DOM prototypes are the realm's,
// shared by every document; a patched member finds its engine here rather than
// closing over one.
const engines = new WeakMap<object, TermDOM>();

export {
	transportFromProcess,
	type TerminalTransport,
} from "./terminalsession.js";

export interface TermDOMOptions {
	/**
	 * The terminal this instance renders to. Defaults to a wrapper around the
	 * global process, so `attach()` takes the real terminal; inject an xterm.js
	 * or SSH transport to render elsewhere. Everything about the terminal --
	 * size, color depth, input, resizes, lifecycle -- comes from here.
	 */
	transport?: TerminalTransport;
}

// Exported handles for the internals the test suite must reach (the layout
// engine, input injection, anchor state): a test imports the key and reads
// them, but they are off the public API -- index.ts does not re-export these
// symbols, so a consumer cannot name them.
const kLayoutEngine = Symbol("layoutEngine");
const kObserver = Symbol("observer");
// The static-render entry renderANSI() reaches through; off the public API
// like the test handles above.
export {kLayoutEngine, kObserver};

const kWrite = Symbol("write");
const kFullscreenStack = Symbol("fullscreenStack");
const kIsInFullscreenMode = Symbol("isInFullscreenMode");

/**
 * The Fullscreen API over the terminal's alternate screen. Lives here
 * rather than in its own module because the alt-screen switch has to
 * serialize with rendering -- the two are one concern, not two.
 *
 * Writes through the session like every other emitter; raw mode is the
 * session's for the whole attachment, so there is nothing to save or restore
 * here beyond the screen switch itself.
 */
class FullscreenManager {
	declare [kWrite]: (output: string) => void;

	declare [kFullscreenStack]: Element[];
	declare [kIsInFullscreenMode]: boolean;

	constructor(write: (output: string) => void) {
		this[kFullscreenStack] = [];
		this[kIsInFullscreenMode] = false;
		this[kWrite] = write;
	}

	/**
	 * Request fullscreen mode for an element
	 */
	async requestFullscreen(
		element: Element,
		_options?: globalThis.FullscreenOptions,
	): Promise<void> {
		if (!element.isConnected) {
			const error = new Error("The element is not contained by a document.");
			error.name = "InvalidStateError";
			throw error;
		}

		try {
			// Add to fullscreen stack
			this[kFullscreenStack].push(element);

			// Enter fullscreen mode if this is the first element
			if (!this[kIsInFullscreenMode]) {
				await enterFullscreenMode(this);
			}

			// Fire fullscreenchange event
			fireFullscreenChangeEvent(this, element);
		} catch (error) {
			// Remove from stack on error
			this[kFullscreenStack].pop();

			// Fire fullscreenerror event
			fireFullscreenErrorEvent(this, element, error as Error);
			throw error;
		}
	}

	/**
	 * Exit fullscreen mode
	 */
	async exitFullscreen(): Promise<void> {
		if (this[kFullscreenStack].length === 0) {
			return; // Already not in fullscreen
		}

		// Remove the topmost element
		const exitingElement = this[kFullscreenStack].pop()!;

		// If no more elements in stack, exit fullscreen mode
		if (this[kFullscreenStack].length === 0) {
			await exitFullscreenMode(this);
		}

		// Fire fullscreenchange event
		fireFullscreenChangeEvent(this, exitingElement);
	}

	/**
	 * Get the current fullscreen element
	 */
	get fullscreenElement(): Element | null {
		return this[kFullscreenStack].length > 0 ?
			this[kFullscreenStack][this[kFullscreenStack].length - 1] :
			null;
	}

	/**
	 * Check if currently in fullscreen mode
	 */
	get isFullscreen(): boolean {
		return this[kIsInFullscreenMode];
	}

	dispose(): void {
		if (this[kIsInFullscreenMode]) {
			this[kWrite]("\x1b[?25h\x1b[?1049l");
		}

		this[kFullscreenStack] = [];
		this[kIsInFullscreenMode] = false;
	}
}

async function enterFullscreenMode(
	self: FullscreenManager,
): Promise<void> {
	// Enter alternate screen buffer, clear it, hide the cursor.
	self[kWrite]("\x1b[?1049h");
	self[kWrite]("\x1b[2J\x1b[H\x1b[?25l");

	self[kIsInFullscreenMode] = true;
}

async function exitFullscreenMode(
	self: FullscreenManager,
): Promise<void> {
	// Restore cursor and exit alternate screen buffer
	self[kWrite]("\x1b[?25h\x1b[?1049l");

	self[kIsInFullscreenMode] = false;
}

function fireFullscreenChangeEvent(
	self: FullscreenManager,
	element: Element,
): void {
	const window = getWindow(self, element);
	if (!window) {
		return;
	}

	const event = new window.CustomEvent("fullscreenchange", {
		bubbles: true,
		cancelable: false,
	});

	// Per spec: fired on the element, and it BUBBLES -- document listeners
	// hear it through the bubble; dispatching on the document as well
	// delivered every transition twice.
	element.dispatchEvent(event);
}

function fireFullscreenErrorEvent(
	self: FullscreenManager,
	element: Element,
	error: Error,
): void {
	const window = getWindow(self, element);
	if (!window) {
		return;
	}

	const event = new window.CustomEvent("fullscreenerror", {
		bubbles: true,
		cancelable: false,
		detail: {error},
	});

	// Fire on both element and document
	element.dispatchEvent(event);
	element.ownerDocument?.dispatchEvent(event);
}

function getWindow(
	self: FullscreenManager,
	element?: Element,
): any {
	// Get window from the element's document, or from the stack
	const targetElement = element || self[kFullscreenStack][0];
	const document = targetElement ? targetElement.ownerDocument : null;
	return document ? document.defaultView : undefined;
}

/**
 * The on* attributes a window carries. addEventListener/removeEventListener
 * come from EventTarget, so the mixins' redeclarations are dropped.
 */
type WindowEventHandlerAttributes = Omit<
	GlobalEventHandlers & WindowEventHandlers,
	"addEventListener" | "removeEventListener"
>;

/**
 * The window a TermDOM document is displayed in.
 *
 * A terminal has one screen and no browsing context, so this is a plain
 * object rather than a global: the DOM interfaces of `./dom.js`, the
 * scrolling and sizing the camera answers, and the handful of APIs an author
 * reaches for through `window`. Everything on it is either a DOM constructor
 * or something the engine itself serves.
 */
export interface EngineWindow
	extends EventTarget,
	WindowEventHandlerAttributes {
	readonly document: Document;
	readonly window: EngineWindow;
	readonly self: EngineWindow;
	readonly navigator: Navigator;

	readonly innerWidth: number;
	readonly innerHeight: number;
	readonly outerWidth: number;
	readonly outerHeight: number;
	readonly screenTop: number;
	readonly scrollX: number;
	readonly scrollY: number;
	readonly pageXOffset: number;
	readonly pageYOffset: number;
	scroll(options?: ScrollToOptions): void;
	scroll(x: number, y: number): void;
	scrollTo(options?: ScrollToOptions): void;
	scrollTo(x: number, y: number): void;
	scrollBy(options?: ScrollToOptions): void;
	scrollBy(x: number, y: number): void;

	getComputedStyle(
		element: Element,
		pseudoElement?: string | null,
	): CSSStyleDeclaration;
	getSelection(): Selection | null;
	matchMedia(query: string): MediaQueryList;
	requestAnimationFrame(callback: FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
	setTimeout: typeof globalThis.setTimeout;
	clearTimeout: typeof globalThis.clearTimeout;
	setInterval: typeof globalThis.setInterval;
	clearInterval: typeof globalThis.clearInterval;
	queueMicrotask: typeof globalThis.queueMicrotask;
	close(): void;

	readonly customElements: CustomElementRegistry;
	readonly NodeFilter: typeof globalThis.NodeFilter;

	EventTarget: typeof globalThis.EventTarget;
	Event: typeof globalThis.Event;
	CustomEvent: typeof globalThis.CustomEvent;
	UIEvent: typeof globalThis.UIEvent;
	MouseEvent: typeof globalThis.MouseEvent;
	PointerEvent: typeof globalThis.PointerEvent;
	WheelEvent: typeof globalThis.WheelEvent;
	KeyboardEvent: typeof globalThis.KeyboardEvent;
	FocusEvent: typeof globalThis.FocusEvent;
	InputEvent: typeof globalThis.InputEvent;
	CompositionEvent: typeof globalThis.CompositionEvent;
	BeforeUnloadEvent: typeof globalThis.BeforeUnloadEvent;
	DOMException: typeof globalThis.DOMException;
	Node: typeof globalThis.Node;
	Element: typeof globalThis.Element;
	Attr: typeof globalThis.Attr;
	CharacterData: typeof globalThis.CharacterData;
	Text: typeof globalThis.Text;
	Comment: typeof globalThis.Comment;
	CDATASection: typeof globalThis.CDATASection;
	ProcessingInstruction: typeof globalThis.ProcessingInstruction;
	DocumentType: typeof globalThis.DocumentType;
	Document: typeof globalThis.Document;
	XMLDocument: typeof globalThis.XMLDocument;
	DocumentFragment: typeof globalThis.DocumentFragment;
	ShadowRoot: typeof globalThis.ShadowRoot;
	DOMImplementation: typeof globalThis.DOMImplementation;
	DOMParser: typeof globalThis.DOMParser;
	NodeList: typeof globalThis.NodeList;
	HTMLCollection: typeof globalThis.HTMLCollection;
	NamedNodeMap: typeof globalThis.NamedNodeMap;
	DOMTokenList: typeof globalThis.DOMTokenList;
	DOMStringMap: typeof globalThis.DOMStringMap;
	MutationObserver: typeof globalThis.MutationObserver;
	MutationRecord: typeof globalThis.MutationRecord;
	NodeIterator: typeof globalThis.NodeIterator;
	TreeWalker: typeof globalThis.TreeWalker;
	AbstractRange: typeof globalThis.AbstractRange;
	StaticRange: typeof globalThis.StaticRange;
	Range: typeof globalThis.Range;
	Selection: typeof globalThis.Selection;
	DOMRect: typeof globalThis.DOMRect;
	DOMRectReadOnly: typeof globalThis.DOMRectReadOnly;
	CustomElementRegistry: typeof globalThis.CustomElementRegistry;
	ElementInternals: typeof globalThis.ElementInternals;
	ValidityState: typeof globalThis.ValidityState;
	SVGElement: typeof globalThis.SVGElement;
	MathMLElement: typeof globalThis.MathMLElement;
	HTMLElement: typeof globalThis.HTMLElement;
	HTMLInputElement: typeof globalThis.HTMLInputElement;
	HTMLTextAreaElement: typeof globalThis.HTMLTextAreaElement;
	HTMLSelectElement: typeof globalThis.HTMLSelectElement;
	HTMLOptionElement: typeof globalThis.HTMLOptionElement;
	HTMLButtonElement: typeof globalThis.HTMLButtonElement;
	HTMLLabelElement: typeof globalThis.HTMLLabelElement;
	HTMLAnchorElement: typeof globalThis.HTMLAnchorElement;
	HTMLStyleElement: typeof globalThis.HTMLStyleElement;
	HTMLLinkElement: typeof globalThis.HTMLLinkElement;
	HTMLFormElement: typeof globalThis.HTMLFormElement;
	HTMLDetailsElement: typeof globalThis.HTMLDetailsElement;
	HTMLDialogElement: typeof globalThis.HTMLDialogElement;
	HTMLTemplateElement: typeof globalThis.HTMLTemplateElement;
	HTMLSlotElement: typeof globalThis.HTMLSlotElement;
	CSSStyleDeclaration: typeof globalThis.CSSStyleDeclaration;
	CSSStyleSheet: typeof globalThis.CSSStyleSheet;
	ResizeObserver: typeof globalThis.ResizeObserver;
	IntersectionObserver: typeof globalThis.IntersectionObserver;
}

/**
 * The DOM interfaces a window names, which are the classes of `./dom.js`
 * under the names WebIDL gives them.
 */
function domInterfaces(): Record<string, unknown> {
	const named: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(DOM)) {
		if (typeof value !== "function") {
			continue;
		}
		// A module export is an interface when it is a class: an interface
		// has a prototype object of its own, and a plain function does not.
		const prototype = (value as {prototype?: unknown}).prototype;
		if (prototype === undefined || prototype === null) {
			continue;
		}
		if (!/^[A-Z]/.test(name)) {
			continue;
		}
		named[name] = value;
	}
	return named;
}

/** The window class, whose instances are windows: an EventTarget, and DOM-aware. */
class Window extends DOM.EventTarget {}

// A window carries both event handler mixins the HTML Standard gives it:
// GlobalEventHandlers, which it shares with elements and documents, and
// WindowEventHandlers, whose members exist as attributes whether or not this
// engine has anything that fires them.
DOM.installEventHandlers(Window.prototype, DOM.GLOBAL_EVENT_HANDLERS);
DOM.installEventHandlers(Window.prototype, DOM.WINDOW_EVENT_HANDLERS);

/** A document parsed from markup, displayed in a window of its own. */
export function createDocumentWindow(html: string, url?: string): EngineWindow {
	return createEngineWindow(DOM.parseHTMLDocument(html, url));
}

/**
 * Build the window a document is displayed in and mount the document in it.
 *
 * The engine fills in the rest -- sizing, scrolling, animation frames, the
 * clipboard -- as it installs itself over the document; what a window is born
 * with is its DOM and the timers any script expects to find.
 */
function createEngineWindow(document: DOM.Document): EngineWindow {
	const window = new Window() as unknown as Record<string, unknown>;
	Object.assign(window, domInterfaces(), {
		document,
		customElements: DOM.customElements,
		NodeFilter: DOM.NodeFilter,
		// The platform's, which is the one the DOM and the CSSOM throw: a
		// caller's `instanceof DOMException` has to name the same class the
		// engine builds its errors out of.
		DOMException: globalThis.DOMException,
		navigator: {
			userAgent: "TermDOM",
			language: "en-US",
			languages: Object.freeze(["en-US"]),
			platform: "",
		},
		setTimeout: globalThis.setTimeout.bind(globalThis),
		clearTimeout: globalThis.clearTimeout.bind(globalThis),
		setInterval: globalThis.setInterval.bind(globalThis),
		clearInterval: globalThis.clearInterval.bind(globalThis),
		queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
		// The Selection API defines the window's getSelection as a call to the
		// document's, and this is that call.
		getSelection: () => document.getSelection(),
		// Replaced by the engine, which closes the terminal session with it.
		close: () => {},
	});
	window.window = window;
	window.self = window;
	DOM.setDefaultView(document, window);
	DOM.setAmbientDocument(document);
	return window as unknown as EngineWindow;
}

const kFrameDamage = Symbol("frameDamage");
const kScrolledElements = Symbol("scrolledElements");
const kTransport = Symbol("transport");
const kInteractive = Symbol("interactive");
const kWidth = Symbol("width");
const kHeight = Symbol("height");
const kTopLayer = Symbol("topLayer");
const kInstallPrototypes = Symbol("installPrototypes");
const kScreen = Symbol("screen");
const kStyleManager = Symbol("styleManager");
const kFullscreenManager = Symbol("fullscreenManager");
const kSession = Symbol("session");
const kObserverManager = Symbol("observerManager");
const kInstallObservers = Symbol("installObservers");
const kPainter = Symbol("painter");
const kViewport = Symbol("viewport");
const kOnFieldEditEvent = Symbol("onFieldEditEvent");
const kOnDisclosureToggle = Symbol("onDisclosureToggle");
const kNextRafId = Symbol("nextRafId");
const kSealed = Symbol("sealed");
const kFrameCallbacks = Symbol("frameCallbacks");
const kMediaQueryUpdaters = Symbol("mediaQueryUpdaters");
const kAttached = Symbol("attached");
const kAttachReady = Symbol("attachReady");
const kRenderCount = Symbol("renderCount");
const kPrototypesInstalled = Symbol("prototypesInstalled");
const kScreenSwitching = Symbol("screenSwitching");
const kRenderInFlight = Symbol("renderInFlight");
const kInputGeneration = Symbol("inputGeneration");
const kMouseCaptureYielded = Symbol("mouseCaptureYielded");
const kAttachBeginning = Symbol("attachBeginning");
const kAttachBegun = Symbol("attachBegun");
const kDisposed = Symbol("disposed");
const kMouseReportingEnabled = Symbol("mouseReportingEnabled");
const kScrollChainTimer = Symbol("scrollChainTimer");
const kResizeInProgress = Symbol("resizeInProgress");
const kIsRendering = Symbol("isRendering");
const kRenderQueued = Symbol("renderQueued");
const kPendingCaretReveal = Symbol("pendingCaretReveal");
const kResizeEpoch = Symbol("resizeEpoch");
const kResizeTimer = Symbol("resizeTimer");
const kSCROLL_CHAIN_TIMEOUT_MS = Symbol("SCROLL_CHAIN_TIMEOUT_MS");
const kFieldDragAnchor = Symbol("fieldDragAnchor");
const kSelectionDragAnchor = Symbol("selectionDragAnchor");
const kMouseDownTarget = Symbol("mouseDownTarget");
const kPopoverPressTarget = Symbol("popoverPressTarget");
const kLastClickTarget = Symbol("lastClickTarget");
const kLastClickTime = Symbol("lastClickTime");
const kDBLCLICK_INTERVAL_MS = Symbol("DBLCLICK_INTERVAL_MS");
const kLastFrameScrollTop = Symbol("lastFrameScrollTop");
const kLastFrameEpoch = Symbol("lastFrameEpoch");
const kLastFrameInputGeneration = Symbol("lastFrameInputGeneration");
const kLastFrameActiveElement = Symbol("lastFrameActiveElement");
const kLastFrameStructuralGeneration = Symbol("lastFrameStructuralGeneration");
const kLastFrameSelectionLive = Symbol("lastFrameSelectionLive");
const kStaticSibling = Symbol("staticSibling");

/**
 * Everything the window installers below need from the TermDOM that installed
 * them -- the whole seam, in one place, instead of a closure over the
 * instance.
 *
 * Getters and callbacks, never values. The installers run once and then live
 * for as long as the document does: prototype methods, property getters and
 * event plumbing that run long after the constructor returned. Most of what
 * they reach for does not exist yet when they are installed -- the renderer,
 * the style manager, the layout engine and the mutation observer are all
 * assigned later in the same constructor -- and the rest (the camera, the
 * anchor, the frame counter) moves while the program runs. A captured value
 * would freeze `undefined` for half of these and a stale number for the other
 * half.
 */
export class TermDOM {
	readonly document: Document;
	readonly window: EngineWindow;

	declare [kScreen]: Screen;
	[kLayoutEngine]: LayoutEngine;
	[kObserver]: MutationObserver;
	declare [kFullscreenManager]: FullscreenManager;
	declare [kObserverManager]: ObserverManager;
	declare [kStyleManager]: StyleManager;
	// The DOM-tree -> terminal-cells paint walk. Reads geometry/styles/widgets;
	// owns no scheduling. Shares kTopLayer by reference.
	declare [kPainter]: Painter;
	// Where the viewport looks in the document: scrollTop (window.scrollY),
	// screenTop (the command-start row), and the fullscreen anchor. See Viewport.
	declare [kViewport]: Viewport;

	// Guard against re-entrant rendering. A render() call arriving while one is in
	// flight sets renderQueued rather than being dropped, so a trailing frame runs.
	declare [kIsRendering]: boolean;
	// Callbacks registered via window.requestAnimationFrame, fired once the frame
	// that includes their pending mutations has actually been written. Keyed
	// by the handle requestAnimationFrame returned, so cancelAnimationFrame
	// can actually cancel.
	declare [kFrameCallbacks]: Map<number, FrameRequestCallback>;
	declare [kNextRafId]: number;
	// One updater per live MediaQueryList: re-evaluates its query and fires
	// "change" if the answer flipped. Run by kHandleResize -- SIGWINCH is
	// this screen's window resize.
	declare [kMediaQueryUpdaters]: Set<() => void>;
	// document.close() sealed the current document into scrollback; the next
	// mutation starts a fresh document below it.
	declare [kSealed]: boolean;
	declare [kRenderQueued]: boolean;
	declare [kScreenSwitching]: boolean;
	declare [kRenderInFlight]: Promise<void> | null;

	// Monotonic frame counter, used to timestamp observer entries.
	declare [kRenderCount]: number;

	// An overflowed field's horizontal scroll lives on the value part's own
	// scrollLeft (set by kScrollFieldCaretIntoView), not a side table.

	/**
	 * The TOP LAYER: elements painted above every stacking context, in
	 * insertion order, unclipped -- the foundation dialog/popover/::picker
	 * share. Members are excluded from normal stacking collection. The set is
	 * the DOCUMENT's, by reference: `showModal` puts a dialog in it with no
	 * route through the renderer, and the renderer paints whatever is there.
	 */
	declare [kTopLayer]: Set<Element>;

	// Timers that must be torn down in dispose(), or they keep the process
	// alive after the app is done -- which, across a test suite, piles up
	// into a hang.
	declare [kResizeTimer]: ReturnType<typeof setTimeout> | null;
	// True from the first SIGWINCH of a resize until the re-anchored redraw. While
	// set, render() bails: the terminal has rewrapped the screen and our anchor is
	// momentarily stale, so an auto-render (an animation tick) painting now lands
	// at the wrong rows and scrolls a stray copy into the scrollback. Only the
	// final redraw that handleResize issues is allowed through.
	declare [kResizeInProgress]: boolean;
	// Whether we have taken hold of the terminal: raw mode, signal handlers,
	// the stdin listener and the cursor query. Construction never touches the
	// process -- attach() does, lazily on the first render or explicitly.
	declare [kAttached]: boolean;
	// Frame-over-frame state the transform gate compares against.
	declare [kLastFrameScrollTop]: number | null;
	declare [kLastFrameEpoch]: number;
	// Reactive pseudo-state (:focus, :hover, :active) and document selection
	// change without mutations; repaint-and-diff is what detects them, so
	// every input path bumps this and the clean-frame skip compares it.
	declare [kInputGeneration]: number;
	declare [kLastFrameInputGeneration]: number;
	declare [kLastFrameActiveElement]: Element | null;
	declare [kLastFrameStructuralGeneration]: number;
	declare [kLastFrameSelectionLive]: boolean;

	// Elements this frame's mutations touched, with the layout rect each held
	// BEFORE relayout. Null once the set overflowed; cleared per frame.
	declare [kFrameDamage]: Map<Element, DOMRect | null> | null;

	// Boxes holding a nonzero scroll offset. Layout changes can shrink a
	// box's content out from under its offset; each layout flush pulls
	// these back into range (see clampScrolledOffsets).
	declare [kScrolledElements]: Set<Element>;

	// Bumped on every SIGWINCH. The re-anchor waits on an async cursor query;
	// if another resize lands while it is in flight, the stale response must not
	// trigger a redraw at coordinates that no longer mean anything.
	declare [kResizeEpoch]: number;

	declare [kWidth]: number;
	declare [kHeight]: number;

	// Whether the terminal is currently reporting mouse events to us. See
	// updateMouseReporting for when capture is on.
	declare [kMouseReportingEnabled]: boolean;
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
	// The field whose caret the NEXT frame must reveal -- set by edits,
	// consumed inside kRenderInteractive after its layout flush. Last
	// edit before the frame wins.
	declare [kPendingCaretReveal]: | HTMLInputElement |
		HTMLTextAreaElement |
		HTMLSelectElement |
		null;

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
	declare [kTransport]: TerminalTransport;

	// The conversation over the transport: the input demultiplexer plus the
	// cursor-position (command start, resize re-anchor) and mode-support (bidi,
	// grapheme clusters) queries whose replies arrive interleaved with typing.
	declare [kSession]: TerminalSession;

	// A defaulted transport over a piped stdout -- a pipe, a file, a CI log --
	// has no viewport, no cursor, no scrollback and no resize. It cannot
	// interpret cursor movement either, so the interactive frame would write
	// CUP and DECSC sequences straight into the file. An injected transport
	// asserts a terminal exists on the other end.
	declare [kInteractive]: boolean;

	constructor(options: TermDOMOptions = {}) {
		this[kViewport] = new Viewport();
		this[kIsRendering] = false;
		this[kFrameCallbacks] = new Map<number, FrameRequestCallback>();
		this[kNextRafId] = 1;
		this[kMediaQueryUpdaters] = new Set<() => void>();
		this[kSealed] = false;
		this[kRenderQueued] = false;
		this[kScreenSwitching] = false;
		this[kRenderInFlight] = null;
		this[kRenderCount] = 0;
		this[kResizeTimer] = null;
		this[kResizeInProgress] = false;
		this[kAttached] = false;
		this[kLastFrameScrollTop] = null;
		this[kLastFrameEpoch] = -1;
		this[kInputGeneration] = 0;
		this[kLastFrameInputGeneration] = -1;
		this[kLastFrameActiveElement] = null;
		this[kLastFrameStructuralGeneration] = -1;
		this[kLastFrameSelectionLive] = false;
		this[kFrameDamage] = new Map();
		this[kScrolledElements] = new Set();
		this[kResizeEpoch] = 0;
		this[kMouseReportingEnabled] = false;
		this[kMouseCaptureYielded] = false;
		this[kScrollChainTimer] = null;
		this[kMouseDownTarget] = null;
		this[kPopoverPressTarget] = null;
		this[kSelectionDragAnchor] = null;
		this[kPendingCaretReveal] = null;
		this[kFieldDragAnchor] = null;
		this[kLastClickTarget] = null;
		this[kLastClickTime] = 0;
		this[kOnDisclosureToggle] = (event: Event): void => {
			const details = event.target as HTMLElement | null;
			if (details === null || !("open" in details)) {
				return;
			}
			if (!(details as HTMLDetailsElement).open) {
				return;
			}
			details.scrollIntoView({block: "nearest"});
		};
		this[kOnFieldEditEvent] = (event: Event): void => {
			const target = event.target;
			if (
				target !== this.document.activeElement ||
				!(
					target instanceof (this.window as any).HTMLInputElement ||
					target instanceof (this.window as any).HTMLTextAreaElement ||
					target instanceof (this.window as any).HTMLSelectElement
				)
			) {
				return;
			}
			queueCaretReveal(
				this,
				target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
			);
			void render(this);
		};
		this[kAttachReady] = Promise.resolve();
		this[kAttachBegun] = Promise.resolve();
		this[kAttachBeginning] = false;
		this[kStaticSibling] = null;
		this[kDisposed] = false;
		this[kTransport] = options.transport ?? transportFromProcess();
		this[kInteractive] = this[kTransport].interactive;

		this[kWidth] = this[kTransport].cols;
		this[kHeight] = this[kTransport].rows;

		this.window = createDocumentWindow(
			"<!DOCTYPE html><html><head></head><body></body></html>",
		);
		const document = this.window.document as unknown as DOM.Document;
		this.document = this.window.document;
		this[kTopLayer] = topLayerOf(this.document) as unknown as Set<Element>;

		// One bag of getters and callbacks, shared by everything that patches
		// the window below. Built here, before the fields it exposes exist:
		// nothing reads through it until a patched API is actually called.

		engines.set(document, this);
		TermDOM[kInstallPrototypes](this.window);
		this[kScreen] = new Screen(
			this[kHeight],
			this[kWidth],
			this[kTransport].colorDepth,
		);

		// Setup style management FIRST to override getComputedStyle before LayoutEngine uses it
		this[kStyleManager] = new StyleManager(this.window);

		// Create layout engine after StyleManager overrides getComputedStyle
		this[kLayoutEngine] = new LayoutEngine(this.window);
		this[kStyleManager].setLayoutEngine(this[kLayoutEngine]);
		// A resolved value is a measurement, so it takes the same flush every
		// other geometry read takes -- one door, not two.
		this[kStyleManager].setLayoutFlush(() =>
			processPendingMutationsAndRender(this),
		);
		this[kLayoutEngine].resize(this[kWidth], this[kHeight]);
		this[kFullscreenManager] = new FullscreenManager((output) => {
			void this[kSession].write(output);
		});
		this[kObserverManager] = new ObserverManager(this[kLayoutEngine]);

		installWindowExtensions(this);
		this[kInstallObservers]();

		// Initialize scrolling management after window setup

		this[kObserver] = setupMutationObserver(this);

		// The collaborators a control's own shadow tree renders through. From
		// here a control builds and keeps its tree itself; the shell only says
		// when a newly connected one should be upgraded.
		installUAEngine(this.document, {
			layout: this[kLayoutEngine],
			styles: this[kStyleManager],
			observer: this[kObserver],
			invalidateStructure: () => this[kLayoutEngine].invalidateStructure(),
			// A popover shows and hides without touching the tree, so the
			// rules that test `:popover-open` -- the UA sheet's own display
			// among them -- are told here, and the frame that paints what
			// they reveal is asked for here.
			stateChanged: (element: object) => {
				this[kStyleManager].handleStateChange(element as Element);
				void render(this);
			},
		});
		this[kPainter] = new Painter({
			window: this.window,
			document: this.document,
			layout: this[kLayoutEngine],
			styleManager: this[kStyleManager],
			viewport: this[kViewport],
			topLayer: this[kTopLayer],
		});
		this[kSession] = buildSession(this);

		// A field edit -- text (input), a caret or selection move
		// (select/selectionchange), or a checkbox/radio toggle (change) --
		// announces itself with standard events. The render loop keeps the caret
		// in view and repaints in response to those, rather than each edit path
		// reaching back into it. Capture, so it lands however the event bubbles.
		this.document.addEventListener("input", this[kOnFieldEditEvent], true);
		this.document.addEventListener("select", this[kOnFieldEditEvent], true);
		this.document.addEventListener("change", this[kOnFieldEditEvent], true);
		this.document.addEventListener(
			"selectionchange",
			this[kOnFieldEditEvent],
			true,
		);
		// A disclosure that opens has just put its contents on the page, and a
		// terminal's page is one screen tall: what it revealed is often below
		// the fold that hid it. Bring it into view, the way moving focus does.
		this.document.addEventListener("toggle", this[kOnDisclosureToggle], true);

		// Initial processing of all elements is handled by StyleManager's constructor
	}

	/**
	 * Reveal what a disclosure opened. A details that closes has taken content
	 * away rather than added it, so there is nothing to bring into view.
	 */
	declare [kOnDisclosureToggle]: (event: Event) => void;

	/**
	 * Keep a focused field's caret in view and repaint, on the standard
	 * input/select/change events its own edit fires. Scoped to the active
	 * field: an event from elsewhere (a select commit, an author's dispatch on
	 * an unfocused control, a text input's change on blur) must not yank the
	 * camera to it.
	 */
	declare [kOnFieldEditEvent]: (event: Event) => void;

	/**
	 * Put the engine behind the DOM's measurement, focus and fullscreen
	 * surfaces.
	 *
	 * The prototypes are the realm's, shared by every document in it, so this
	 * runs once and each call finds the engine its node belongs to rather than
	 * closing over one. Installing per instance would stack a wrapper on a
	 * wrapper and leave every earlier engine on the chain.
	 */
	static [kPrototypesInstalled] = false;

	static [kInstallPrototypes](window: EngineWindow): void {
		if (TermDOM[kPrototypesInstalled]) {
			return;
		}
		TermDOM[kPrototypesInstalled] = true;
		const {Element, Document, Range} = window;

		/** The engine that mounted a node's document. */
		const engineOf = (node: Node): TermDOM => {
			const document = (
				node.nodeType === node.DOCUMENT_NODE ? node : node.ownerDocument
			) as Document;
			const engine = engines.get(document);
			if (engine === undefined) {
				throw new Error("That node's document is not mounted in a terminal");
			}
			return engine;
		};

		// getRect()/getRects() (the layout engine's own primitives) are
		// document-relative -- the coordinate space rendering already works in,
		// since the renderer applies the camera offset once at paint time, not
		// per element. But getBoundingClientRect/getClientRects are a *public*
		// API, and CSSOM View defines them relative to the viewport: rect.top
		// for a scrolled-past element should be negative, not the same
		// ever-growing document row regardless of scroll. toViewportRect is the
		// one place that conversion happens, so both wrappers apply it
		// identically. Internal callers that need the pre-conversion,
		// document-relative rect (scrollIntoView, hit-testing) read
		// getRect()/getRects() directly instead of going through these -- see
		// their definitions.
		// A box inside a position:fixed subtree is laid out in viewport space
		// already -- subtracting the camera would double-convert it. Per spec
		// its client rect is scroll-invariant.
		const toViewportRect = (
			termDOM: TermDOM,
			rect: DOMRect,
			element?: Element,
		): DOMRect =>
			element && termDOM[kLayoutEngine].isInFixedSpace(element) ?
				rect :
					termDOM[kLayoutEngine].createDOMRect(
						rect.x,
						rect.y - termDOM[kViewport].scrollTop,
						rect.width,
						rect.height,
					);

		Element.prototype.getBoundingClientRect = function (
			this: Element,
		): DOMRect {
			const termDOM = engineOf(this);
			if (!this.isConnected) {
				return termDOM[kLayoutEngine].createDOMRect(0, 0, 0, 0);
			}

			processPendingMutationsAndRender(termDOM);

			const rect = termDOM[kLayoutEngine].getRect(this);
			return toViewportRect(
				termDOM,
				rect || termDOM[kLayoutEngine].createDOMRect(),
				this,
			);
		};

		Element.prototype.getClientRects = function (this: Element): DOMRectList {
			const termDOM = engineOf(this);
			if (!this.isConnected) {
				return termDOM[kLayoutEngine].createDOMRectList();
			}

			processPendingMutationsAndRender(termDOM);

			const rects = termDOM[kLayoutEngine]
				.getRects(this)
				.map((rect) => toViewportRect(termDOM, rect, this));
			return termDOM[kLayoutEngine].createDOMRectList(rects);
		};

		// Range geometry. The DOM does no layout, so Range.getClientRects/
		// getBoundingClientRect are the engine's to answer -- from the same
		// layout the element wrappers use, viewport-converted identically. The
		// caret and selection painters read the document-relative
		// getRangeRects() directly, the way scrollIntoView reads getRect().
		Range.prototype.getClientRects = function (this: Range): DOMRectList {
			const termDOM = engineOf(this.startContainer);
			processPendingMutationsAndRender(termDOM);
			const container = this.startContainer;
			const anchor =
				container.nodeType === container.ELEMENT_NODE ?
						(container as Element) :
						(container.parentElement ?? undefined);
			const rects = termDOM[kLayoutEngine]
				.getRangeRects(this)
				.map((rect) => toViewportRect(termDOM, rect, anchor));
			return termDOM[kLayoutEngine].createDOMRectList(rects);
		};

		Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
			const termDOM = engineOf(this.startContainer);
			processPendingMutationsAndRender(termDOM);
			const container = this.startContainer;
			const anchor =
				container.nodeType === container.ELEMENT_NODE ?
						(container as Element) :
						(container.parentElement ?? undefined);
			return toViewportRect(
				termDOM,
				termDOM[kLayoutEngine].unionRect(
					termDOM[kLayoutEngine].getRangeRects(this),
				),
				anchor,
			);
		};

		// offsetWidth/offsetHeight/offsetTop/offsetLeft/offsetParent/clientWidth/
		// clientHeight/scrollWidth/scrollHeight -- the most commonly reached-for
		// measurement APIs, and previously entirely unimplemented (always
		// 0/null, the value a DOM with no layout behind it has). Every one of
		// them is derived from
		// layoutRectOf, the single place that decides "is this element
		// connected, has layout settled, what is its border-box rect" -- so
		// offsetWidth and clientWidth can never quietly disagree about which
		// rect they mean, and a future change to that decision (e.g. how
		// isConnected or render-flushing is handled) only has one place to make.
		//
		// layoutRectOf returns the same rect getBoundingClientRect uses,
		// unrounded (each getter below rounds for its own purpose -- offsetTop
		// rounds the *difference* of two rects, not each rect independently, so
		// rounding here first would double-round and drift by a cell).
		const layoutRectOf = (element: Element): DOMRect | null => {
			if (!element.isConnected) {
				return null;
			}
			const termDOM = engineOf(element);
			processPendingMutationsAndRender(termDOM);
			return termDOM[kLayoutEngine].getRect(element);
		};

		// offsetParent walks the live DOM tree, not layout -- a separate concern
		// from layoutRectOf, reused by offsetParent itself and by offsetTop/Left
		// to find what they're relative to.
		const offsetParentOf = (element: Element): HTMLElement | null => {
			for (
				let ancestor = element.parentElement;
				ancestor;
				ancestor = ancestor.parentElement
			) {
				const position = computedStyleOf(ancestor).computedValueOf("position");
				if (position && position !== "static") {
					return ancestor as HTMLElement;
				}
			}
			const body = engineOf(element).document.body;
			return body === element ? null : body;
		};

		// The content+padding box (border-box rect minus border widths), which
		// both clientWidth/Height and scrollWidth/Height report -- see
		// their definition below for why scroll* is an alias of client* rather
		// than the element's true unclamped content size.
		const contentBoxOf = (
			element: Element,
		): {width: number; height: number} | null => {
			const rect = layoutRectOf(element);
			if (!rect) {
				return null;
			}
			const box = getBoxModel(element);
			return {
				width: rect.width - box.borderLeftWidth - box.borderRightWidth,
				height: rect.height - box.borderTopWidth - box.borderBottomWidth,
			};
		};

		Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
			get(this: Element) {
				return Math.round(layoutRectOf(this)?.width ?? 0);
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
			get(this: Element) {
				return Math.round(layoutRectOf(this)?.height ?? 0);
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
			get(this: Element) {
				return this.isConnected ? offsetParentOf(this) : null;
			},
			configurable: true,
			enumerable: true,
		});

		// offsetTop/Left are relative to offsetParent's own border-box origin
		// (not its padding edge, which the spec technically uses): a
		// simplification that only differs when offsetParent itself has a
		// border, and is off by exactly that border's width when it does.
		Object.defineProperty(window.HTMLElement.prototype, "offsetTop", {
			get(this: Element) {
				const rect = layoutRectOf(this);
				if (!rect) {
					return 0;
				}
				const parent = offsetParentOf(this);
				const parentRect = parent ? layoutRectOf(parent) : null;
				return Math.round(rect.top - (parentRect?.top ?? 0));
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(window.HTMLElement.prototype, "offsetLeft", {
			get(this: Element) {
				const rect = layoutRectOf(this);
				if (!rect) {
					return 0;
				}
				const parent = offsetParentOf(this);
				const parentRect = parent ? layoutRectOf(parent) : null;
				return Math.round(rect.left - (parentRect?.left ?? 0));
			},
			configurable: true,
			enumerable: true,
		});

		// clientWidth/clientHeight/scrollWidth/scrollHeight, generalized from the
		// html/body-only instance properties defined above (which still win: an
		// own-property shadows a prototype getter, so document.body's viewport-
		// height special case is untouched).
		Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
			get(this: Element) {
				return Math.round(contentBoxOf(this)?.width ?? 0);
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
			get(this: Element) {
				return Math.round(contentBoxOf(this)?.height ?? 0);
			},
			configurable: true,
			enumerable: true,
		});

		// scroll* is the content's laid-out extent -- how far the box could
		// scroll, and what its offsets clamp against -- read off the layout
		// tree, whose children keep their natural sizes when they overflow a
		// fixed box. A box whose content the tree does not decompose into
		// child boxes (an inline, a run member) has no readable extent and
		// falls back to its client size, exact for the no-overflow case.
		const scrollExtentOf = (
			element: Element,
		): {width: number | null; height: number} | null => {
			if (!element.isConnected) {
				return null;
			}
			const termDOM = engineOf(element);
			processPendingMutationsAndRender(termDOM);
			return termDOM[kLayoutEngine].scrollExtentOf(element);
		};

		Object.defineProperty(window.HTMLElement.prototype, "scrollWidth", {
			get(this: Element) {
				return (
					scrollExtentOf(this)?.width ??
					Math.round(contentBoxOf(this)?.width ?? 0)
				);
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
			get(this: Element) {
				return (
					scrollExtentOf(this)?.height ??
					Math.round(contentBoxOf(this)?.height ?? 0)
				);
			},
			configurable: true,
			enumerable: true,
		});

		// scrollTop/scrollLeft writes take effect here, where layout and the
		// frame loop live: a write rounds to whole cells (everything paints
		// on the cell grid, like the document camera), clamps into the
		// scrollable range, and schedules the repaint that shows it. The
		// value lands in the DOM's store (setScrollOffset), which is what
		// the layout's geometry funnel already reads -- so getters stay the
		// DOM's. An axis whose overflow is visible is not scrollable and
		// pins to 0; hidden scrolls programmatically, as in a browser. A box
		// whose extent the layout cannot name (a field's value span, whose
		// content is an opaque measured run) stores the write unclamped --
		// the caret-reveal machinery owns those offsets and keeps them sane.
		const scrollAxisTo = (
			element: Element,
			axis: "left" | "top",
			value: number,
		): void => {
			const numeric = Number(value);
			let next =
				Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
			const termDOM = engines.get(element.ownerDocument);
			if (termDOM && element.isConnected) {
				processPendingMutationsAndRender(termDOM);
				const engine = termDOM[kLayoutEngine];
				const extent = engine.scrollExtentOf(element);
				const port = engine.contentRect(element);
				const size =
					extent === null ?
						null :
						axis === "top" ?
							extent.height :
							extent.width;
				if (size !== null && port) {
					const style = computedStyleOf(element);
					const overflow =
						style.computedValueOf(`overflow-${axis === "top" ? "y" : "x"}`) ||
						style.computedValueOf("overflow");
					const scrollable =
						overflow === "auto" ||
						overflow === "scroll" ||
						overflow === "hidden";
					const room =
						size -
						Math.round(axis === "top" ? port.height : port.width);
					next = Math.min(next, scrollable ? Math.max(0, room) : 0);
				}
			}
			if (scrollOffsetOf(element)[axis] === next) {
				return;
			}
			setScrollOffset(element, axis, next);
			if (termDOM) {
				if (next !== 0) {
					termDOM[kScrolledElements].add(element);
				}
				// A scroll offset is frame state no MutationObserver sees --
				// the same footing as input: the generation bump keeps the
				// "nothing observable moved" gate from skipping the paint,
				// and the damage keeps that paint banded to the box's rows.
				termDOM[kInputGeneration]++;
				addFrameDamage(termDOM, element);
				void render(termDOM);
			}
		};

		for (const axis of ["left", "top"] as const) {
			const property = axis === "left" ? "scrollLeft" : "scrollTop";
			const stored = Object.getOwnPropertyDescriptor(
				Element.prototype,
				property,
			);
			Object.defineProperty(Element.prototype, property, {
				get: stored?.get,
				set(this: Element, value: number) {
					scrollAxisTo(this, axis, value);
				},
				configurable: true,
				enumerable: true,
			});
		}

		// scrollTo/scroll/scrollBy, in both their forms; assignment through
		// the accessors above is what rounds, clamps and repaints. html and
		// body's own scrollTop accessors map to the camera, so scrolling
		// them scrolls the document, as everywhere else.
		const scrollTargetOf = (
			xOrOptions?: number | ScrollToOptions,
			y?: number,
		): {left?: number; top?: number} => {
			if (typeof xOrOptions === "object" && xOrOptions !== null) {
				return {left: xOrOptions.left, top: xOrOptions.top};
			}
			return {left: xOrOptions, top: y};
		};

		const scrollElementTo = function (
			this: Element,
			xOrOptions?: number | ScrollToOptions,
			y?: number,
		): void {
			const target = scrollTargetOf(xOrOptions, y);
			if (target.left !== undefined) {
				this.scrollLeft = target.left;
			}
			if (target.top !== undefined) {
				this.scrollTop = target.top;
			}
		};
		Element.prototype.scrollTo = scrollElementTo as Element["scrollTo"];
		Element.prototype.scroll = scrollElementTo as Element["scroll"];
		Element.prototype.scrollBy = function (
			this: Element,
			xOrOptions?: number | ScrollToOptions,
			y?: number,
		): void {
			const target = scrollTargetOf(xOrOptions, y);
			if (target.left) {
				this.scrollLeft = this.scrollLeft + target.left;
			}
			if (target.top) {
				this.scrollTop = this.scrollTop + target.top;
			}
		} as Element["scrollBy"];

		// The document-rooted MutationObserver never sees inside a shadow
		// root -- per spec, shadow trees are separate observation scopes. Each
		// author-attached root gets enrolled in the same observer, so shadow
		// mutations invalidate styles/layout and repaint like light ones.
		const originalAttachShadow = Element.prototype.attachShadow;
		Element.prototype.attachShadow = function (
			this: Element,
			init: ShadowRootInit,
		): ShadowRoot {
			const termDOM = engineOf(this);
			const root = originalAttachShadow.call(this, init);
			termDOM[kObserver].observe(root, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeOldValue: true,
				characterData: true,
			});
			// The root's <style> elements join the cascade, scoped to this
			// tree; the refresh rides on the STYLE mutation records the
			// observer enrollment above will deliver.
			// A shadow attachment recomposes the host's subtree with no
			// mutation record: unbounded for any banded repaint.
			termDOM[kLayoutEngine].invalidateStructure();
			termDOM[kStyleManager].registerShadowRoot(root);
			// attachShadow is not a DOM mutation -- no observer record will
			// ever fire for it -- but on a CONNECTED host the composed tree
			// just changed wholesale: light children stop rendering the moment
			// the root exists, even while it is still empty. Rebuild the
			// host's composed subtree and repaint.
			if (this.isConnected) {
				termDOM[kLayoutEngine].invalidate(this);
				void render(termDOM);
			}
			return root;
		};

		Element.prototype.requestFullscreen = function (
			this: Element,
			options?: FullscreenOptions,
		): Promise<void> {
			const termDOM = engineOf(this);
			// Fullscreen writes the alternate-screen switch; attach() is the
			// only consent for that. A browser rejects without a user gesture,
			// and this is the terminal's equivalent precondition.
			if (!termDOM[kAttached]) {
				return Promise.reject(
					new Error("requestFullscreen(): attach() the terminal first"),
				);
			}
			return (async () => {
				// No frame may straddle the screen switch: an in-flight render
				// finishing its stdout write AFTER the switch paints one
				// screen's geometry onto the other (the demo's animation made
				// this a near-certainty on exit). Hold new frames, drain the
				// running one, then switch.
				termDOM[kScreenSwitching] = true;
				try {
					await termDOM[kRenderInFlight];
					await termDOM[kFullscreenManager].requestFullscreen(this, options);
					// The element's UA styles changed (it now fills the
					// viewport) and neither a mutation nor a focus move fired.
					termDOM[kStyleManager].handleFocusChange(this);
					termDOM[kLayoutEngine].invalidate(this);
					// The screen under the renderer changed wholesale (the
					// alternate screen starts cleared): drop the diff model or
					// the first fullscreen frame patches against the main
					// screen's content.
					termDOM[kScreen].repaintAll();
					updateMouseReporting(termDOM);
				} finally {
					termDOM[kScreenSwitching] = false;
				}
				void render(termDOM);
			})();
		};

		Document.prototype.exitFullscreen = function (
			this: Document,
		): Promise<void> {
			const termDOM = engineOf(this);
			return (async () => {
				const element = termDOM[kFullscreenManager].fullscreenElement;
				termDOM[kScreenSwitching] = true;
				try {
					await termDOM[kRenderInFlight];
					await termDOM[kFullscreenManager].exitFullscreen();
					if (element) {
						termDOM[kStyleManager].handleFocusChange(element);
						termDOM[kLayoutEngine].invalidate(element);
					}
					// Same wholesale swap in reverse: the terminal restored the
					// main screen, but the diff model still describes the last
					// ALTERNATE-screen frame -- patching against it garbles the
					// restored document.
					termDOM[kScreen].repaintAll();
					updateMouseReporting(termDOM);
				} finally {
					termDOM[kScreenSwitching] = false;
				}
				void render(termDOM);
			})();
		};

		Object.defineProperty(Document.prototype, "fullscreenElement", {
			get(this: Document) {
				// Style computation consults this during construction, before
				// the manager field is assigned.
				const termDOM = engines.get(this);
				if (termDOM === undefined) {
					return null;
				}
				return termDOM[kFullscreenManager]?.fullscreenElement ?? null;
			},
			configurable: true,
		});

		Document.prototype.elementFromPoint = function (
			this: Document,
			x: number,
			y: number,
		): Element | null {
			const termDOM = engineOf(this);
			// Per CSSOM View, x/y are viewport-relative -- convert to the
			// document-relative space hit-testing works in, the same conversion
			// getBoundingClientRect's toViewportRect makes in the other direction.
			return findElementAtDocumentPoint(
				termDOM,
				x,
				y + termDOM[kViewport].scrollTop,
			);
		};

		// Moving focus is the DOM's; firing the events a move fires, and
		// repainting for the :focus rules it brings in, are the engine's.
		const HTMLElement = window.HTMLElement;
		const originalFocus = HTMLElement.prototype.focus;
		const originalBlur = HTMLElement.prototype.blur;

		HTMLElement.prototype.focus = function (this: HTMLElement) {
			const termDOM = engineOf(this);
			const document = termDOM.document;
			const prev = document.activeElement;
			originalFocus.call(this);
			if (prev !== this && document.activeElement === this) {
				// :focus rules match live, but computed styles are cached and
				// focus is not a mutation -- both moved elements must drop
				// their caches, and the repaint must happen even when no
				// listener mutates anything.
				termDOM[kStyleManager].handleFocusChange(prev, this);
				void render(termDOM);
				if (prev && prev !== document.body) {
					prev.dispatchEvent(
						new window.FocusEvent("blur", {
							relatedTarget: this,
							bubbles: false,
						}),
					);
					prev.dispatchEvent(
						new window.FocusEvent("focusout", {
							relatedTarget: this,
							bubbles: true,
						}),
					);
				}
				this.dispatchEvent(
					new window.FocusEvent("focus", {
						relatedTarget: prev,
						bubbles: false,
					}),
				);
				this.dispatchEvent(
					new window.FocusEvent("focusin", {
						relatedTarget: prev,
						bubbles: true,
					}),
				);
			}
		};

		HTMLElement.prototype.blur = function (this: HTMLElement) {
			const termDOM = engineOf(this);
			const wasFocused = termDOM.document.activeElement === this;
			originalBlur.call(this);
			if (wasFocused) {
				termDOM[kStyleManager].handleFocusChange(this);
				void render(termDOM);
				this.dispatchEvent(
					new window.FocusEvent("blur", {
						relatedTarget: null,
						bubbles: false,
					}),
				);
				this.dispatchEvent(
					new window.FocusEvent("focusout", {
						relatedTarget: null,
						bubbles: true,
					}),
				);
			}
		};

		// scrollIntoView: every scroll box between the element and the
		// document reveals it within its own port, innermost first -- each
		// scroll moves the element in every outer port's coordinates, so the
		// rect is re-read per level -- and the camera reveals what remains.
		// All moves are the minimal ones: block "nearest".
		HTMLElement.prototype.scrollIntoView = function (
			this: HTMLElement,
			_arg?: boolean | ScrollIntoViewOptions,
		) {
			if (!this.isConnected) {
				return;
			}
			const termDOM = engineOf(this);
			processPendingMutationsAndRender(termDOM);
			const engine = termDOM[kLayoutEngine];

			const revealIn = (scroller: Element): void => {
				// Document-relative rects on both sides: the element wherever
				// its current offsets put it, against the scroller's padding
				// box -- what the scroller actually shows.
				const rect = engine.getRect(this);
				const scrollerRect = engine.getRect(scroller);
				if (!rect || !scrollerRect) {
					return;
				}
				const box = getBoxModel(scroller);
				const portTop = scrollerRect.top + (box.borderTopWidth || 0);
				const portBottom =
					scrollerRect.bottom - (box.borderBottomWidth || 0);
				const portLeft = scrollerRect.left + (box.borderLeftWidth || 0);
				const portRight = scrollerRect.right - (box.borderRightWidth || 0);
				if (rect.top < portTop) {
					scroller.scrollTop -= Math.round(portTop - rect.top);
				} else if (rect.bottom > portBottom) {
					scroller.scrollTop += Math.round(rect.bottom - portBottom);
				}
				if (rect.left < portLeft) {
					scroller.scrollLeft -= Math.round(portLeft - rect.left);
				} else if (rect.right > portRight) {
					scroller.scrollLeft += Math.round(rect.right - portRight);
				}
			};

			for (
				let ancestor = flatParentElement<Element>(this);
				ancestor &&
				ancestor !== termDOM.document.body &&
				ancestor !== termDOM.document.documentElement;
				ancestor = flatParentElement<Element>(ancestor)
			) {
				const style = computedStyleOf(ancestor);
				const overflow = style.computedValueOf("overflow");
				const scrollable = (value: string) =>
					value === "auto" || value === "scroll" || value === "hidden";
				if (
					scrollable(style.computedValueOf("overflow-y") || overflow) ||
					scrollable(style.computedValueOf("overflow-x") || overflow)
				) {
					revealIn(ancestor);
				}
			}

			// Document-relative, not getBoundingClientRect's viewport-relative --
			// this compares directly against the camera's scrollTop below, so it needs
			// the same coordinate space getRect() already provides.
			const rect = engine.getRect(this);
			if (!rect) {
				return;
			}

			// The camera shows [scrollTop, scrollTop + region).
			// Move it the minimal amount that brings the element into it -- the
			// standard block: "nearest" behavior.
			const regionHeight = cameraRegionHeight(termDOM);
			const top = termDOM[kViewport].scrollTop;
			if (rect.top < top) {
				scrollCamera(termDOM, rect.top - top);
			} else if (rect.bottom > top + regionHeight) {
				scrollCamera(termDOM, rect.bottom - (top + regionHeight));
			}
		};
	}

	/**
	 * Take hold of the terminal: begin the session (input, resizes, closure),
	 * the startup cursor/mode queries, and mouse reporting.
	 *
	 * Construction is inert -- a constructor has no business writing escape
	 * sequences or flipping a tty into raw mode. Attachment is the one door to
	 * the terminal; dispose() reverses it.
	 *
	 * Passing a different transport rebinds to it -- the construction-time
	 * transport (the global process by default) was only a stand-in, and this
	 * re-derives every terminal-dependent fact from the one handed here.
	 * Rebinding is only allowed before the first attach; re-attaching a live
	 * instance to another terminal needs teardown that does not exist yet.
	 */
	declare [kAttachReady]: Promise<void>;
	// Resolves once attach()'s begin phase has run (session started, cursor
	// detection initialized): a render triggered between attach() and that
	// phase -- a requestAnimationFrame, a mutation -- must not paint an
	// unanchored first frame. The flag keeps steady-state renders fully
	// synchronous: an unconditional await would defer every frame a
	// microtask, and the scrollTop clamp is synchronous by contract.
	declare [kAttachBegun]: Promise<void>;
	declare [kAttachBeginning]: boolean;

	attach(transport: TerminalTransport = this[kTransport]): Promise<void> {
		const rebinding = transport !== this[kTransport];
		if (this[kAttached]) {
			if (rebinding) {
				throw new Error(
					"attach(): cannot re-attach a live TermDOM to a different " +
					"transport; attach once, before the first render.",
				);
			}
			return this[kAttachReady];
		}
		if (rebinding) {
			rebindTransport(this, transport);
		}
		this[kAttached] = true;

		// Begin once the transport is established (a process tty already is;
		// an SSH wrapper's channel may still be opening), then paint whatever
		// the document holds. The returned promise resolves when that first
		// frame has been written; negotiations are excluded deliberately --
		// their silence timeouts must never hold a first paint hostage.
		this[kAttachBeginning] = true;
		let begun!: () => void;
		this[kAttachBegun] = new Promise<void>((resolve) => {
			begun = resolve;
		});
		this[kAttachReady] = (async () => {
			await this[kTransport].ready;
			if (this[kDisposed] || !this[kAttached]) {
				this[kAttachBeginning] = false;
				begun();
				return;
			}

			this[kSession].start();
			if (this[kInteractive]) {
				// Bracketed paste on: pasted text arrives fenced, one insertion.
				void this[kSession].write("\x1b[?2004h");
				// Save the terminal's title, so dispose can hand it back; the
				// document.title setter emits the replacement.
				void this[kSession].write("\x1b[22;0t");
				if (this.document.title) {
					void this[kSession].write(`\x1b]2;${this.document.title}\x07`);
				}
			}
			updateMouseReporting(this);
			this[kSession].initializeCursorDetection();
			void this[kSession].negotiateBidi();
			void this[kSession].negotiateGraphemeClusters();
			this[kSession].scrubProbeEcho();
			this[kAttachBeginning] = false;
			begun();

			// Deferred a microtask so the render does not occupy the
			// re-entrancy guard while synchronous code right after attach()
			// still expects its own render calls to drain mutations inline.
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await render(this);
		})();
		return this[kAttachReady];
	}

	/** Install the observer constructors on the window, bound to this instance. */
	[kInstallObservers](): void {
		const manager = this[kObserverManager];
		const window = this.window as unknown as {
			ResizeObserver: unknown;
			IntersectionObserver: unknown;
		};

		window.ResizeObserver = class extends TermResizeObserver {
			constructor(
				callback: ConstructorParameters<typeof TermResizeObserver>[0],
			) {
				super(callback, manager);
			}
		};

		window.IntersectionObserver = class extends TermIntersectionObserver {
			constructor(
				callback: ConstructorParameters<typeof TermIntersectionObserver>[0],
				init?: ConstructorParameters<typeof TermIntersectionObserver>[2],
			) {
				super(callback, manager, init);
			}
		};
	}

	/** Write to the transport and wait for it to be flushed. */
	[kWrite](output: string): Promise<void> {
		return this[kSession].write(output);
	}

	// The scratch engine behind renderANSI/print: created on first use,
	// sized from the transport, recreated if the width changes, reused
	// across calls.
	declare [kStaticSibling]: TermDOM | null;

	/**
	 * Render an HTML string to an ANSI string at the transport's width:
	 * colors and line breaks, no cursor controls, no modes. <style> elements
	 * in the fragment join the cascade. The instance's document is untouched.
	 */
	renderANSI(html: string): string {
		return renderStaticHTML(this, html, "\n");
	}

	/**
	 * renderANSI(html) written through the transport as ordinary command
	 * output; resolves when the bytes have reached it. CRLF while a raw-mode
	 * session holds the terminal, since raw mode does not translate newlines.
	 */
	print(html: string): Promise<void> {
		const output = renderStaticHTML(
			this,
			html,
			this[kAttached] && this[kInteractive] ? "\r\n" : "\n",
		);
		if (!output) {
			return Promise.resolve();
		}
		return this[kSession].write(output);
	}

	/** Explicit resource management: `using dom = new TermDOM()` tears down on scope exit. */
	[Symbol.dispose](): void {
		this.dispose();
	}

	declare [kDisposed]: boolean;

	/**
	 * Tear down and hand the terminal back. Resolves when every queued
	 * restore has reached the transport; await it before writing further
	 * output or exiting with a status code. The process transport restores
	 * shell-critical modes synchronously besides, so exiting without
	 * awaiting still leaves the shell usable.
	 */
	dispose(): Promise<void> {
		if (this[kDisposed]) {
			return Promise.resolve();
		}
		this[kDisposed] = true;

		// A TermDOM that never attached owes the terminal nothing: no final
		// flush, no mode restores -- there is no session to close.
		const wasAttached = this[kAttached];
		this[kAttached] = false;

		// Document mode has been painting a window in place, so nothing it
		// showed has reached the terminal's scrollback. Pay it all out now --
		// but only if a frame was ever painted: with none, there is nothing
		// of ours on screen, and the payout's cursor moves and erases would
		// land on someone else's rows.
		if (wasAttached && this[kRenderCount] > 0) {
			flushDocument(this);
		}

		// Frames keep the terminal cursor hidden (it is parked for resize
		// bookkeeping, not UI); hand it back visible on the way out. The mouse
		// goes back to the terminal the same way, and the title we replaced
		// pops back to what the terminal held before attach pushed it.
		if (this[kMouseReportingEnabled]) {
			void this[kSession].write("\x1b[?1006l\x1b[?1002l");
			this[kMouseReportingEnabled] = false;
		}
		if (wasAttached && this[kInteractive]) {
			void this[kSession].write("\x1b[?25h\x1b[?2004l\x1b[23;0t");
		}
		// The fullscreen manager's own teardown writes the alt-screen restore,
		// so it must run while the session still holds the wire.
		this[kFullscreenManager].dispose();

		// Restore the terminal modes we negotiated, clear the session's timers
		// and handlers (a live query timer keeps the event loop open), and
		// release the transport -- which is what hands a process transport its
		// tty back.
		this[kSession].dispose();

		// Tear down the rest of what holds the event loop open. Without this a
		// disposed TermDOM keeps the process alive via the resize timers, and
		// across a whole test suite those accumulate until nothing can exit.
		if (this[kResizeTimer] !== null) {
			clearTimeout(this[kResizeTimer]);
			this[kResizeTimer] = null;
		}
		if (this[kScrollChainTimer] !== null) {
			clearTimeout(this[kScrollChainTimer]);
			this[kScrollChainTimer] = null;
		}

		// Shadow DOM cleanup is automatic with symbol-based storage

		if (this[kStaticSibling]) {
			void this[kStaticSibling].dispose();
			this[kStaticSibling] = null;
		}
		this[kObserver].disconnect();
		this[kStyleManager].dispose();
		this[kLayoutEngine].dispose();
		this[kObserverManager].dispose();
		return this[kSession].flush();
	}
}

function addFrameDamage(
	self: TermDOM,
	node: Node,
): void {
	if (!self[kFrameDamage]) {
		return;
	}
	const element =
		node.nodeType === node.ELEMENT_NODE ?
				(node as Element) :
				(node.parentElement ?? null);
	if (!element) {
		self[kFrameDamage] = null;
		return;
	}
	if (self[kFrameDamage].has(element)) {
		return;
	}
	if (self[kFrameDamage].size >= 24) {
		self[kFrameDamage] = null;
		return;
	}
	// The rect BEFORE this frame's relayout: getRect answers from the
	// last computed layout until calculateLayout runs.
	self[kFrameDamage].set(
		element,
		(self[kLayoutEngine].getRect(element) as DOMRect | null) ?? null,
	);
}

/**
 * The frame handle a requestAnimationFrame callback is keyed by, so a
 * cancelAnimationFrame can name the callback it cancels.
 */
function allocateFrameHandle(
	self: TermDOM,
): number {
	return self[kNextRafId]++;
}

function sealToScrollback(
	self: TermDOM,
): void {
	flushDocument(self);
	self[kSealed] = true;
}

function installWindowExtensions(
	self: TermDOM,
): void {
	const termDOM = self;
	const window = termDOM.window;
	const document = window.document;
	Object.defineProperty(window, "innerWidth", {
		value: termDOM[kWidth],
		writable: false,
		configurable: true,
	});
	Object.defineProperty(window, "innerHeight", {
		value: termDOM[kHeight],
		writable: false,
		configurable: true,
	});
	Object.defineProperty(window, "outerWidth", {
		value: termDOM[kWidth],
		writable: false,
		configurable: true,
	});
	Object.defineProperty(window, "outerHeight", {
		value: termDOM[kHeight],
		writable: false,
		configurable: true,
	});

	// screenTop: readonly like browsers, and LIVE -- cursor detection moves
	// the anchor after this runs. A frozen value here silently shadowed the
	// real one, with only constructor line order deciding which won.
	Object.defineProperty(window, "screenTop", {
		get: () => termDOM[kViewport].screenTop,
		configurable: true,
		enumerable: true,
	});

	// Standard window scrolling, mapped onto the camera: scrollY is how far the
	// camera has moved down the document, scrollBy moves it.
	Object.defineProperty(window, "scrollY", {
		get: () => termDOM[kViewport].scrollTop,
		configurable: true,
		enumerable: true,
	});
	Object.defineProperty(window, "pageYOffset", {
		get: () => termDOM[kViewport].scrollTop,
		configurable: true,
		enumerable: true,
	});
	// A terminal document never scrolls sideways, so the X pair reads 0.
	Object.defineProperty(window, "scrollX", {
		get: () => 0,
		configurable: true,
		enumerable: true,
	});
	Object.defineProperty(window, "pageXOffset", {
		get: () => 0,
		configurable: true,
		enumerable: true,
	});
	window.scrollBy = ((
		xOrOptions?: number | ScrollToOptions,
		y?: number,
	): void => {
		const dy =
			typeof xOrOptions === "object" && xOrOptions !== null ?
					(xOrOptions.top ?? 0) :
					(y ?? 0);
		scrollCamera(termDOM, dy);
	}) as typeof window.scrollBy;

	// scrollTo/scroll set the camera to an absolute position -- the same
	// state scrollY reads and scrollBy moves relatively. document.
	// documentElement/body.scrollTop are the same value again, standard DOM
	// (window.scrollY === document.documentElement.scrollTop always): one
	// camera, four ways to read or move it, matching the "unified scrolling
	// model" the viewport tests already name it after.
	const scrollToCamera = (
		xOrOptions?: number | ScrollToOptions,
		y?: number,
	): void => {
		const targetY =
			typeof xOrOptions === "object" && xOrOptions !== null ?
					(xOrOptions.top ?? termDOM[kViewport].scrollTop) :
					(y ?? 0);
		termDOM[kViewport].scrollTop = Math.max(0, targetY);
		void render(termDOM);
	};
	window.scrollTo = scrollToCamera as typeof window.scrollTo;
	window.scroll = scrollToCamera as typeof window.scroll;

	for (const root of [document.documentElement, document.body]) {
		Object.defineProperty(root, "scrollTop", {
			get: () => termDOM[kViewport].scrollTop,
			set: (value: number) => {
				termDOM[kViewport].scrollTop = Math.max(0, value);
				void render(termDOM);
			},
			configurable: true,
			enumerable: true,
		});
	}

	// requestAnimationFrame is the only way to await a painted frame -- render()
	// is private. A bare timer would be decoupled from our (async) paint, so a
	// callback could fire before the frame is written.
	// Route it through the render loop: schedule a render and fire the callback
	// once it completes, so "await a frame" always means the frame that includes
	// your pending mutations has landed.
	window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
		const id = allocateFrameHandle(termDOM);
		termDOM[kFrameCallbacks].set(id, cb);
		void render(termDOM);
		return id;
	}) as typeof window.requestAnimationFrame;
	window.cancelAnimationFrame = ((handle: number): void => {
		termDOM[kFrameCallbacks].delete(handle);
	}) as typeof window.cancelAnimationFrame;

	// matchMedia: the terminal is the one screen, and queries answer
	// through the SAME evaluator @media stylesheet rules use, so a
	// script and a stylesheet can never disagree about the viewport.
	// The list is live: a resize (SIGWINCH is this screen's window
	// resize) re-evaluates and fires "change" when the answer flips --
	// the browser contract, which is what makes responsive terminal
	// layouts a matchMedia listener instead of a bespoke resize hook.
	window.matchMedia = ((query: string): MediaQueryList => {
		const media = String(query);
		const mql = new (window as any).EventTarget();
		// `matches` reads live; this holds the value the last "change"
		// event reported.
		let notified = termDOM[kStyleManager].mediaQueryMatches(media);
		let onchange: ((ev: Event) => void) | null = null;
		Object.defineProperties(mql, {
			media: {get: () => media, enumerable: true, configurable: true},
			matches: {
				get: () => termDOM[kStyleManager].mediaQueryMatches(media),
				enumerable: true,
				configurable: true,
			},
			onchange: {
				get: () => onchange,
				set: (value: ((ev: Event) => void) | null) => {
					// An event-handler attribute IS a listener, per spec:
					// route it through add/removeEventListener so dispatch
					// order and dedup behave like any other handler.
					if (onchange) {
						mql.removeEventListener("change", onchange);
					}
					onchange = typeof value === "function" ? value : null;
					if (onchange) {
						mql.addEventListener("change", onchange);
					}
				},
				enumerable: true,
				configurable: true,
			},
			// The pre-2020 MediaQueryList API, still what much deployed
			// code calls: plain aliases for the EventTarget pair.
			addListener: {
				value: (cb: ((ev: Event) => void) | null) => {
					if (cb) {
						mql.addEventListener("change", cb);
					}
				},
				configurable: true,
			},
			removeListener: {
				value: (cb: ((ev: Event) => void) | null) => {
					if (cb) {
						mql.removeEventListener("change", cb);
					}
				},
				configurable: true,
			},
		});
		termDOM[kMediaQueryUpdaters].add(() => {
			const now = termDOM[kStyleManager].mediaQueryMatches(media);
			if (now === notified) {
				return;
			}
			notified = now;
			const event = new window.Event("change");
			Object.defineProperties(event, {
				matches: {value: now, enumerable: true},
				media: {value: media, enumerable: true},
			});
			mql.dispatchEvent(event);
		});
		return mql as MediaQueryList;
	}) as typeof window.matchMedia;

	// window.close() closes the terminal session as it would close a
	// browser tab: dispose, then close the transport. Ctrl-C's default
	// action is this call.
	window.close = () => {
		// beforeunload is the door out, and a listener that cancels keeps
		// the session. A browser answers a canceled beforeunload with a
		// prompt of its own; a terminal has no UA chrome to prompt with,
		// so cancellation just stops the teardown, leaving the app to ask
		// "are you sure?" however it likes and to close again once the
		// user says yes. Every close asks: the event carries nothing from
		// the last one.
		const unloadEvent = DOM.createBeforeUnloadEvent();
		(window as unknown as DOM.EventTarget).dispatchEvent(unloadEvent);
		if (unloadEvent.defaultPrevented || unloadEvent.returnValue !== "") {
			return;
		}

		const wasAttached = termDOM[kAttached];
		// An immediate close must not tear down mid-establishment: wait
		// for attach to finish (anchor found, first frame painted) so the
		// payout lands where the frame was, not at a stale row 0. Then
		// everything dispose queued must reach the wire before the
		// transport acts on the close (a process transport exits).
		void (async () => {
			if (wasAttached) {
				await termDOM[kAttachReady];
			}
			await termDOM.dispose();
			if (wasAttached) {
				termDOM[kTransport].close({status: 0});
			}
		})();
	};

	// document.title sets the terminal's window title in-band (OSC 2).
	// attach() pushes the previous title; dispose() pops it.
	let nativeTitle: PropertyDescriptor | undefined;
	for (
		let proto = Object.getPrototypeOf(document);
		proto && !nativeTitle;
		proto = Object.getPrototypeOf(proto)
	) {
		nativeTitle = Object.getOwnPropertyDescriptor(proto, "title");
	}
	if (nativeTitle?.get && nativeTitle.set) {
		Object.defineProperty(document, "title", {
			get: () => nativeTitle.get!.call(document),
			set: (value: string) => {
				nativeTitle.set!.call(document, value);
				if (termDOM[kAttached] && termDOM[kInteractive]) {
					void termDOM[kSession].write(`\x1b]2;${String(value)}\x07`);
				}
			},
			configurable: true,
			enumerable: true,
		});
	}

	// navigator.clipboard: writeText() carries the text to the system
	// clipboard over OSC 52, which travels in-band -- across SSH too.
	// Terminals without OSC 52 ignore it; there is no way to know, so the
	// promise resolves when the transport has the bytes. readText()
	// rejects: terminals do not answer clipboard queries to untrusted
	// programs, and pretending otherwise would hang.
	Object.defineProperty(window.navigator, "clipboard", {
		value: {
			writeText: (text: string): Promise<void> => {
				if (!termDOM[kAttached] || !termDOM[kInteractive]) {
					return Promise.reject(
						new (window as any).DOMException(
							"clipboard requires an attached interactive terminal",
							"NotAllowedError",
						),
					);
				}
				return termDOM[kSession].write(
					`\x1b]52;c;${base64OfText(String(text))}\x07`,
				);
			},
			readText: (): Promise<string> =>
				Promise.reject(
					new (window as any).DOMException(
						"the terminal does not expose clipboard reads",
						"NotAllowedError",
					),
				),
		},
		configurable: true,
	});

	// document.close() finalizes the document: flush the live region into the
	// terminal's scrollback and seal it -- the SSR res.end() of the terminal.
	// A later DOM mutation starts a fresh document below the sealed block. This
	// is the "print rich output and stop" seam: write(), then close().
	const nativeDocumentClose = document.close.bind(document);
	document.close = () => {
		nativeDocumentClose();
		// dispose() has already set attached=false by the time it reaches here,
		// so we skip the seal. A real seal is a close() from a live, painted
		// session.
		if (termDOM[kAttached] && termDOM[kRenderCount] > 0) {
			sealToScrollback(termDOM);
		}
	};

	// Implement standard DOM scrollHeight properties
	Object.defineProperty(document.body, "scrollHeight", {
		get() {
			return termDOM[kLayoutEngine].getContentHeight();
		},
		configurable: true,
		enumerable: true,
	});

	Object.defineProperty(document.documentElement, "scrollHeight", {
		get() {
			return termDOM[kLayoutEngine].getContentHeight();
		},
		configurable: true,
		enumerable: true,
	});

	// clientHeight is the viewport height (terminal height)
	Object.defineProperty(document.body, "clientHeight", {
		get() {
			return termDOM[kHeight];
		},
		configurable: true,
		enumerable: true,
	});

	Object.defineProperty(document.documentElement, "clientHeight", {
		get() {
			return termDOM[kHeight];
		},
		configurable: true,
		enumerable: true,
	});
}

/**
 * Apply a batch of mutation records to everything that isn't painting:
 * pseudo-elements/caches, the layout tree, and the autofocus default
 * action. In the same order everywhere it's called, since mutations reach
 * this from two different places -- the observer's own async callback
 * below, and kProcessPendingMutationsAndRender/kRenderStatic/
 * kRenderInteractive's synchronous `takeRecords()` drain (a geometry read
 * or a scheduled render needs fresh layout NOW, not whenever the next
 * microtask checkpoint happens to land) -- and whichever one runs first
 * empties the queue for the other.
 */
function handlePendingMutations(
	self: TermDOM,
	mutations: MutationRecord[],
): void {
	// Any observed mutation can move a node in the flat tree; drop the
	// memoized composition links before anything reads through them.
	self[kLayoutEngine].invalidateFrame();
	// Record damage while the old layout still answers: a banded repaint
	// must cover the target's pre-mutation rows too.
	for (const mutation of mutations) {
		addFrameDamage(self, mutation.target);
		if (mutation.type === "childList") {
			for (const node of mutation.addedNodes) {
				addFrameDamage(self, node);
			}
			// Removed nodes have no rows of their own; their damage is the
			// parent's, already added.
		}
	}
	// Attribute records whose value did not actually change are dropped
	// before any handler sees them. Frameworks (and this repo's own
	// examples) re-assign className/style with identical values on every
	// update; per spec each assignment fires a record, and a class
	// record rebuilds the whole layout tree from body -- the difference
	// between a keystroke costing a counter re-measure and costing the
	// document. A->B->A inside one unpainted batch also nets out: the
	// intermediate value never rendered, so skipping is correct, and a
	// same-batch pair still processes via the B->A record.
	const relevant = mutations.filter((record) => {
		if (record.type !== "attributes" || !record.attributeName) {
			return true;
		}
		const target = record.target as Element;
		return record.oldValue !== target.getAttribute(record.attributeName);
	});
	if (relevant.length === 0) {
		return;
	}
	// Upgrade UA form controls the moment they connect -- before layout reads
	// their shadow and before the painter walks it -- the way a browser
	// upgrades a custom element on connect, not lazily at first paint. The
	// shell drives it here, the one place every insert -- observer-driven or
	// drained from a synchronous render -- passes through.
	for (const record of relevant) {
		if (record.type !== "childList") {
			continue;
		}
		for (const added of record.addedNodes) {
			if (added.nodeType !== added.ELEMENT_NODE) {
				continue;
			}
			upgradeControlsIn(added as Element);
		}
	}
	self[kStyleManager].handleMutations(relevant);
	self[kLayoutEngine].handleMutations(relevant);
	focusAutofocusedNodes(relevant);
}

function setupMutationObserver(
	self: TermDOM,
): MutationObserver {
	const observer = new self.window.MutationObserver((mutations) => {
		handlePendingMutations(self, mutations);
		render(self);
	});

	observer.observe(self.document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeOldValue: true,
		characterData: true,
	});

	return observer;
}

/**
 * The session over the transport: input demultiplexing and the query
 * round-trips, wired to this instance's dispatchers. Rebuilt on a rebind;
 * started only by attach() -- construction holds no lock and reads nothing.
 */
function buildSession(
	self: TermDOM,
): TerminalSession {
	return new TerminalSession({
		transport: self[kTransport],
		viewport: self[kViewport],
		layout: self[kLayoutEngine],
		interactive: self[kInteractive],
		anchorDetection: self[kTransport].sharesScreen,
		handlers: {
			onKeys: (keyInput) => {
				self[kInputGeneration]++;
				// A keystroke means the user is back at the live screen
				// (terminals snap to the bottom on input): reclaim the mouse
				// if scroll chaining yielded it.
				if (self[kMouseCaptureYielded]) {
					reclaimMouseCapture(self);
				}
				dispatchGlobalKeyboardEvent(self, keyInput);
			},
			onMouse: (button, x, y, release) => {
				self[kInputGeneration]++;
				handleMouseReport(self, button, x, y, release);
			},
			onPaste: (text) => {
				self[kInputGeneration]++;
				dispatchPaste(self, text);
			},
			onResize: () => {
				scheduleResize(self);
			},
			// Ctrl-C's default action is the DOM's own way out: close the
			// window. An app that wants different behavior handles the
			// keydown; this is what happens when nobody does.
			onCloseRequest: () => {
				self.window.close();
			},
			// A cluster is wider or narrower on this terminal than the
			// tables said, so every column after one on a painted row is
			// off by the difference. The previous frame described a screen
			// that was never drawn: drop it and paint the region again from
			// the corrected measurements.
			onWidthCorrection: () => {
				self[kScreen].repaintAll();
				void render(self);
			},
			onWidthStarvation: () => {
				self[kScreen].repaintTopRow();
				void render(self);
			},
			// The terminal went away (hangup, disconnect, process exit):
			// clean up this side. The transport is already closing; there
			// is nothing to close back.
			onClosed: () => {
				self.dispose();
			},
		},
	});
}

/**
 * Adopt `transport` and re-derive everything that comes from the terminal:
 * color depth, the viewport size, and the session. The collaborators that
 * hold the transport -- the renderer, the session -- are rebuilt rather
 * than mutated: the renderer has no color-depth setter, and a rebind always
 * precedes the first frame. The transport-independent collaborators
 * (layout, style, painter, viewport) are untouched; only the layout is
 * resized to the new terminal.
 */
function rebindTransport(
	self: TermDOM,
	transport: TerminalTransport,
): void {
	self[kTransport] = transport;
	self[kInteractive] = transport.interactive;
	applyTerminalSize(self, transport.cols, transport.rows);
	self[kScreen] = new Screen(
		self[kHeight],
		self[kWidth],
		transport.colorDepth,
	);
	self[kSession] = buildSession(self);
}

/**
 * Adopt a new terminal size: update the reported dimensions, re-parse the
 * stylesheets and re-evaluate media queries against them (a viewport change
 * can flip any @media answer), and resize the layout. The renderer is left
 * to the caller -- a resize resizes it in place, a rebind replaces it.
 */
function applyTerminalSize(
	self: TermDOM,
	newWidth: number,
	newHeight: number,
): void {
	// A SIGWINCH reporting an unchanged size still redraws but fires no
	// resize event.
	const sizeChanged = newWidth !== self[kWidth] ||
		newHeight !== self[kHeight];
	self[kWidth] = newWidth;
	self[kHeight] = newHeight;

	Object.defineProperty(self.window, "innerWidth", {
		value: newWidth,
		writable: false,
		configurable: true,
	});
	Object.defineProperty(self.window, "innerHeight", {
		value: newHeight,
		writable: false,
		configurable: true,
	});

	// The layout engine holds the viewport a `vw` is a hundredth of, so it
	// learns the new size BEFORE any style is resolved against it.
	self[kLayoutEngine].resize(newWidth, newHeight);

	// The viewport changed, so every @media answer may have: re-parse the
	// stylesheets against the new size (they were parsed against the old one
	// and would stay stale), then let each live MediaQueryList re-evaluate
	// and fire "change" if it flipped. The re-parse also moves the style
	// epoch, which is what retires the viewport-relative values every
	// computed style resolved under the old size.
	self[kStyleManager].refreshStylesheets();

	// Per the rendering steps, resize fires before media query "change"
	// events, and everything a listener reads already has the new size.
	if (sizeChanged) {
		self.window.dispatchEvent(new self.window.Event("resize"));
	}
	for (const update of self[kMediaQueryUpdaters]) {
		update();
	}
}

/**
 * The mouse is captured exactly when the document owns the camera: document
 * mode and fullscreen, where wheel-to-scroll is the default action, the same
 * as a browser. Flow mode leaves the mouse native -- there the terminal owns
 * scrolling (that is the mode's point), and capture would take the user's
 * scrollback and selection in exchange for nothing.
 *
 * Idempotent; call it whenever attachment, viewport mode, or fullscreen
 * changes.
 */
function updateMouseReporting(
	self: TermDOM,
): void {
	const wanted =
		self[kAttached] && self[kInteractive] && !self[kMouseCaptureYielded];
	if (wanted === self[kMouseReportingEnabled]) {
		return;
	}
	self[kMouseReportingEnabled] = wanted;
	// 1002: button presses, releases, wheel, and drag motion (no move flood
	// while nothing is pressed). 1006: SGR encoding, the only one that is
	// unambiguous past column 223.
	void self[kSession].write(
		wanted ? "\x1b[?1002h\x1b[?1006h" : "\x1b[?1006l\x1b[?1002l",
	);
}

/**
 * End a scroll-chaining yield, from whichever of the two triggers reaches
 * it first -- a keystroke (the common case) or the fallback timer (see
 * kScrollChainTimer). Both need the same cleanup, so this is the one place
 * that does it: clear the pending timer (the other trigger firing later
 * would be a harmless no-op via kUpdateMouseReporting's own idempotence,
 * but there is no reason to let it) and restore mouse capture.
 */
function reclaimMouseCapture(
	self: TermDOM,
): void {
	if (self[kScrollChainTimer] !== null) {
		clearTimeout(self[kScrollChainTimer]);
		self[kScrollChainTimer] = null;
	}
	self[kMouseCaptureYielded] = false;
	updateMouseReporting(self);
}

async function render(
	self: TermDOM,
): Promise<void> {
	// attach() is the ONLY door to the terminal: until the app calls it,
	// mutations keep the DOM and layout live but write nothing. Rendering
	// resumes -- starting with whatever the document holds by then -- the
	// moment attach() runs, which ends by scheduling this render.
	if (!self[kAttached]) {
		return;
	}

	// A resize is settling: suppress every render until handleResize issues the
	// single re-anchored redraw. See resizeInProgress.
	if (self[kResizeInProgress]) {
		return;
	}

	// A screen switch (fullscreen enter/exit) is in progress: no frame
	// may straddle it -- a frame computed for one screen landing on the
	// other paints the wrong geometry onto the wrong buffer.
	if (self[kScreenSwitching]) {
		return;
	}

	// A render in flight: coalesce, don't drop. Dropping an auto-render (a
	// mutation observer firing mid-frame) leaves the diff renderer's
	// previous-buffer out of step with the screen, which shows up as rows drawn
	// at the wrong place. Instead mark one pending and hand back the running
	// loop's promise: it will fold this caller's changes into a trailing frame,
	// so awaiting render() always means "the caller's changes are painted".
	if (self[kIsRendering]) {
		self[kRenderQueued] = true;
		return self[kRenderInFlight] ?? Promise.resolve();
	}

	self[kIsRendering] = true;
	self[kRenderInFlight] = (async () => {
		try {
			do {
				self[kRenderQueued] = false;
				await renderOnce(self);
			} while (self[kRenderQueued]);
			// The frame(s) are written; wake anything awaiting requestAnimationFrame.
			drainFrameCallbacks(self);
		} finally {
			self[kIsRendering] = false;
			self[kRenderInFlight] = null;
		}
	})();
	return self[kRenderInFlight];
}

function drainFrameCallbacks(
	self: TermDOM,
): void {
	if (self[kFrameCallbacks].size === 0) {
		return;
	}
	const callbacks = [...self[kFrameCallbacks].values()];
	self[kFrameCallbacks].clear();
	const now = performance.now();
	for (const cb of callbacks) {
		cb(now);
	}
}

async function renderOnce(
	self: TermDOM,
): Promise<void> {
	// An in-flight render loop can outlive dispose() by one queued frame;
	// everything below assumes a live document.
	if (self[kDisposed]) {
		return;
	}
	if (self[kAttachBeginning]) {
		await self[kAttachBegun];
		if (self[kDisposed]) {
			return;
		}
	}
	if (!self[kInteractive]) {
		await printStatic(self);
		return;
	}

	await renderInteractive(self);
}

/**
 * The paint height of the document: body's scroll height, extended to
 * cover top-layer boxes -- hoisted under the root, they contribute
 * nothing to body's own height, and a picker opening at the bottom
 * edge must still get rows to paint into.
 */
function documentPaintHeight(
	self: TermDOM,
): number {
	let height = self.document.body.scrollHeight;
	for (const element of self[kTopLayer]) {
		if (!flatIsConnected(element)) {
			continue;
		}
		const rect = self[kLayoutEngine].getRect(element);
		if (rect) {
			height = Math.max(height, Math.ceil(rect.bottom));
		}
	}
	return height;
}

/**
 * The height of the window the camera shows, for the scroll-to-reveal
 * math. Fullscreen owns the whole screen from row zero, and the
 * fullscreen element has left the flow -- body.scrollHeight measures
 * next to nothing there, and a reveal sized by it would scroll the
 * camera by the target's whole row.
 */
function cameraRegionHeight(
	self: TermDOM,
): number {
	return self[kFullscreenManager].isFullscreen ?
		self[kHeight] :
			Math.min(self[kHeight], self.document.body.scrollHeight);
}

/**
 * The value offset under a document-space point in a text field --
 * cell-width aware, clamped to the nearest offset so a drag that
 * leaves the field still resolves (the browser's capture model:
 * a selection begun in a field is the field's until release).
 */
function fieldOffsetAtPoint(
	self: TermDOM,
	element: HTMLInputElement | HTMLTextAreaElement,
	x: number,
	y: number,
): number | null {
	// The value's own text: a field's selection is measured in ITS offsets,
	// and for a password that text is the bullets, which is what was
	// painted and so what the point lands on.
	const valueText = fieldValueText(element);
	if (!valueText) {
		return null;
	}
	const found = self[kLayoutEngine].caretPositionFromPoint(
		x,
		y,
		valueText,
		true,
	);
	if (!found) {
		return null;
	}
	return Math.min(found.offset, valueText.data.length);
}

/**
 * Queue a caret reveal for the next frame. The reveal rides the frame
 * the edit already scheduled: one camera decision against the layout
 * that frame flushes anyway, however many keystrokes coalesced into it.
 * Revealing immediately instead would cost a full synchronous layout
 * flush per keystroke, before the frame's own -- half the typing latency.
 */
function queueCaretReveal(
	self: TermDOM,
	element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
	self[kPendingCaretReveal] = element;
}

/**
 * Keep the editing caret inside the camera, the way a browser keeps the
 * caret of a focused control visible on every EDIT (typing, Enter,
 * caret travel) -- and only on edits: wheel-scrolling away from a
 * focused field stays allowed, so the render loop runs this only when
 * an edit queued it (see kQueueCaretReveal). The caret row comes from
 * fresh layout; single-row widgets reduce to their own row.
 */
function scrollCaretIntoView(
	self: TermDOM,
	element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
	processPendingMutationsAndRender(self);
	const rect = self[kLayoutEngine].getRect(element);
	if (!rect) {
		return;
	}
	let caretY = Math.round(rect.top);
	if (element.tagName === "TEXTAREA") {
		const caret = self[kLayoutEngine].caretRectOf(element);
		if (!caret) {
			return;
		}
		caretY = caret.y;
	}
	// The row span to reveal: the caret's row -- widened to the field's
	// own edge when the caret sits on the first or last content row, so
	// resting at a boundary shows the border instead of a cropped box.
	const boxModel = getBoxModel(element);
	let revealTop = caretY;
	let revealBottom = caretY + 1;
	if (caretY <= Math.round(rect.top) + (boxModel.borderTopWidth || 0)) {
		revealTop = Math.round(rect.top);
	}
	if (
		caretY >=
		Math.round(rect.bottom) - (boxModel.borderBottomWidth || 0) - 1
	) {
		revealBottom = Math.round(rect.bottom);
	}
	const regionHeight = cameraRegionHeight(self);
	const delta = self[kViewport].scrollDeltaToReveal(
		revealTop,
		revealBottom,
		regionHeight,
	);
	if (delta) {
		scrollCamera(self, delta);
	}
}

/**
 * Keep a single-line input's caret in its box by setting the value part's
 * scrollLeft (the layout reads it live, no relayout). Measured in cells.
 */
function scrollFieldCaretIntoView(
	self: TermDOM,
	input: HTMLInputElement,
): void {
	const valueText = fieldValueText(input);
	const valueSpan = valueText?.parentElement as HTMLElement | null;
	if (!valueText || !valueSpan) {
		return;
	}
	const content = self[kLayoutEngine].contentRect(input);
	if (!content) {
		return;
	}
	const contentWidth = Math.round(content.width);
	if (contentWidth <= 0) {
		return;
	}

	const shown = valueText.data;
	// Seed from the current scrollLeft so a settled window doesn't jitter.
	const currentScroll = Math.max(0, Math.round(valueSpan.scrollLeft));
	let scrollOffset = 0;
	for (let acc = 0; scrollOffset < shown.length && acc < currentScroll;) {
		acc += stringWidth(shown[scrollOffset]);
		scrollOffset++;
	}
	// The caret is wherever the input renders it, in the value text's own
	// offsets -- the same text `shown` is read from.
	const caret = caretRangeOf(input);
	if (!caret) {
		return;
	}
	const cursor = caret.startOffset;
	// Keep the caret's cell in the box, then pull back when a deletion left slack.
	if (cursor < scrollOffset) {
		scrollOffset = cursor;
	}
	while (
		scrollOffset < cursor &&
		stringWidth(shown.slice(scrollOffset, cursor)) > contentWidth
	) {
		scrollOffset++;
	}
	while (
		scrollOffset > 0 &&
		stringWidth(shown.slice(scrollOffset - 1)) < contentWidth
	) {
		scrollOffset--;
	}
	const scrollLeft = stringWidth(shown.slice(0, scrollOffset));
	if (scrollLeft !== currentScroll) {
		valueSpan.scrollLeft = scrollLeft;
	}
}

function processPendingMutationsAndRender(
	self: TermDOM,
): boolean {
	// A geometry read (getBoundingClientRect, elementFromPoint) needs fresh
	// *layout*, not fresh pixels. A full render() here would make every
	// rect read with pending mutations paint a frame -- an app calling
	// scrollIntoView on each keystroke pays two paints per key, and the
	// rect could still be stale unless the render were awaited. Flushing
	// mutations and laying out synchronously gives an exact rect; painting
	// stays with the caller's own render. The dirty-skip makes this free when
	// nothing changed.
	const pendingMutations = self[kObserver].takeRecords();
	const hadMutations = pendingMutations.length > 0;
	if (hadMutations) {
		handlePendingMutations(self, pendingMutations);
		// takeRecords() stole these from the observer callback that would
		// have painted them. When the caller's own follow-up (a camera
		// move, an input's render) never comes -- scrollIntoView on an
		// already-visible row is the canonical case -- the mutation would
		// otherwise never reach the screen. Schedule the paint the drain
		// consumed, UNCONDITIONALLY: render() itself queues a trailing
		// frame when one is in flight, and skipping "because a render is
		// running" leaves the screen one interaction behind the DOM when
		// keystrokes arrive faster than frames.
		void render(self);
	}
	self[kLayoutEngine].calculateLayout();
	clampScrolledOffsets(self);
	return hadMutations;
}

/**
 * Pull every held scroll offset back into its box's scrollable range
 * against fresh layout: a mutation that shrinks a box's content must not
 * leave the box scrolled past what remains. Offsets are written to the
 * store directly -- the accessor's own clamp would re-enter this flush --
 * and a change repaints the box's rows like any other scroll.
 */
function clampScrolledOffsets(
	self: TermDOM,
): void {
	let changed = false;
	for (const element of self[kScrolledElements]) {
		const offsets = scrollOffsetOf(element);
		if (offsets.left === 0 && offsets.top === 0) {
			self[kScrolledElements].delete(element);
			continue;
		}
		if (!element.isConnected) {
			continue;
		}
		const engine = self[kLayoutEngine];
		const extent = engine.scrollExtentOf(element);
		const port = engine.contentRect(element);
		if (!extent || !port) {
			continue;
		}
		// An unknowable horizontal extent leaves that axis unclamped.
		const maxLeft =
			extent.width === null ?
				offsets.left :
					Math.max(0, extent.width - Math.round(port.width));
		const maxTop = Math.max(0, extent.height - Math.round(port.height));
		if (offsets.left <= maxLeft && offsets.top <= maxTop) {
			continue;
		}
		setScrollOffset(element, "left", Math.min(offsets.left, maxLeft));
		setScrollOffset(element, "top", Math.min(offsets.top, maxTop));
		addFrameDamage(self, element);
		changed = true;
	}
	if (changed) {
		// See scrollAxisTo: offsets are frame state no observer sees.
		self[kInputGeneration]++;
		void render(self);
	}
}

/**
 * Coalesce a burst of resize events into a single redraw.
 *
 * Dragging a terminal's edge fires a SIGWINCH for every width it passes
 * through -- dozens in one drag. Redrawing on each leaves a little reflowed
 * crud in the scrollback every time (see handleResize), so the crud grows with
 * the length of the drag rather than the fact that it happened. Waiting for the
 * drag to settle turns the whole gesture into one redraw, and one lot of crud.
 */
function scheduleResize(
	self: TermDOM,
): void {
	// Suppress renders from the very first SIGWINCH, before the debounce
	// settles, so a drag's worth of animation ticks cannot paint at the stale
	// anchor while the terminal is rewrapping under us.
	self[kResizeInProgress] = true;
	self[kResizeEpoch]++;
	if (self[kResizeTimer] !== null) {
		clearTimeout(self[kResizeTimer]);
	}
	self[kResizeTimer] = setTimeout(() => {
		self[kResizeTimer] = null;
		handleResize(self);
	}, RESIZE_DEBOUNCE_MS);
}

function handleResize(
	self: TermDOM,
): void {
	const newWidth = self[kTransport].cols;
	const newHeight = self[kTransport].rows;

	applyTerminalSize(self, newWidth, newHeight);
	self[kScreen].resize(newHeight, newWidth);

	// Re-anchor and redraw. The terminal has already rewrapped everything on
	// screen -- including our old frame -- and how far our content moved depends
	// on text above us that we do not own. But two facts make its new position
	// exactly recoverable:
	//
	//   1. The cursor is parked on our content's bottom row after every frame,
	//      and it rides its line through the rewrap (renderFrame parks it).
	//   2. Every row we paint is a hard line, so the old frame's rewrapped
	//      height is computable from the previous frame's own line lengths.
	//
	// So: ask the terminal where the cursor is (DSR), subtract the rewrapped
	// height, and that is our frame's new top row -- ground truth, immune to
	// whatever the shell prompt above did. Anything that ballooned past the
	// screen top is in the scrollback, beyond rewriting; the redraw's erase
	// covers everything from the recovered top down, so the visible screen
	// carries exactly one copy.
	//
	// resizeInProgress has suppressed every animation tick since the first
	// SIGWINCH, so nothing paints at a stale anchor while the query is in
	// flight. If the terminal does not answer, fall back to the computed
	// vertical re-anchor (exact for height changes, approximate for width).
	self[kLayoutEngine].calculateLayout();
	const contentHeight = self.document.body.scrollHeight;
	const wrappedRowsAbove = self[kScreen].wrappedRowsAbovePark(newWidth);
	const epoch = self[kResizeEpoch];

	const redraw = (startRow: number) => {
		// The recovered row is where the frame stands; whether it still
		// FITS below that row at the new height is reserveRows' problem,
		// which solves it the only permissible way -- scrolling earlier
		// output up into the scrollback, never painting over it. Clamping
		// startRow upward to force a fit instead would plant the frame on
		// top of the shell prompt above it.
		self[kViewport].screenTop = startRow;
		self[kViewport].anchorScrollTop = -self[kViewport].screenTop;
		self[kScreen].replaced(startRow);

		// Everything suppressed since the first SIGWINCH may paint again. The
		// frame is placed by the screen reset, not by cursor detection.
		self[kResizeInProgress] = false;
		const wasDetected = self[kSession].hasDetectedCommandStart;
		self[kSession].hasDetectedCommandStart = false;
		render(self).then(() => {
			self[kSession].hasDetectedCommandStart = wasDetected;
		});
	};

	const computedReanchor = () => {
		const previousStart = self[kViewport].screenTop;
		const scrolledUp = Math.max(0, previousStart + contentHeight - newHeight);
		return Math.max(0, previousStart - scrolledUp);
	};

	// The anchor is trustworthy exactly while the frame still FITS below it.
	// When it does, no room-making scroll happens and the redraw is precise,
	// so the prompt above is left alone. When it does not, the terminal
	// scrolled the frame by an amount a same-cursor DSR cannot report, and
	// making room on top of that mis-anchor is what strands a copy of our
	// own rows -- an intermittent race we cannot win. There, clear the whole
	// screen and start at the top: the erase covers every row the old frame
	// could hold, so no fragment survives. It costs the output above us,
	// which is the trade for a screen that is always legible.
	const place = (startRow: number) => {
		if (startRow + contentHeight <= newHeight) {
			redraw(startRow);
		} else {
			redraw(0);
		}
	};

	if (self[kSession].anchorDetectionEnabled && wrappedRowsAbove !== null) {
		self[kSession]
			.queryCursorRow()
			.then((cursorRow) => {
				// A newer resize superseded this one; its handler will redraw.
				if (epoch !== self[kResizeEpoch]) {
					return;
				}
				place(Math.max(0, cursorRow - wrappedRowsAbove));
			})
			.catch(() => {
				if (epoch !== self[kResizeEpoch]) {
					return;
				}
				place(computedReanchor());
			});
	} else {
		place(computedReanchor());
	}
}

/**
 * Run the observers against the layout just produced.
 *
 * Called after every render, once isRendering is clear -- a callback that
 * mutates the DOM schedules the next frame through the mutation observer, so
 * there is no re-entrancy to guard against here.
 */
function afterRender(
	self: TermDOM,
): void {
	self[kRenderCount]++;
	// The viewport in document coordinates: the scroll offset, one terminal
	// high. IntersectionObserver measures targets against it.
	const viewport = self[kLayoutEngine].createDOMRect(
		0,
		self[kViewport].scrollTop,
		self[kWidth],
		self[kHeight],
	);
	self[kObserverManager].flush(viewport, self[kRenderCount]);
}

/**
 * The modal dialog on top of the document, or null while none is showing.
 * Last in the top layer is topmost, and only a modal dialog is ever in it
 * by way of `showModal`.
 */
function topmostModalDialog(
	self: TermDOM,
): HTMLDialogElement | null {
	let modal: HTMLDialogElement | null = null;
	for (const element of self[kTopLayer]) {
		if (isModalDialog(element)) {
			modal = element as HTMLDialogElement;
		}
	}
	return modal;
}

/**
 * What a close request closes: the modal dialog or auto popover last into
 * the top layer, which is the one the user sees on top. A manual popover
 * is not one -- it responds to neither Escape nor a click outside -- and
 * neither is anything else riding the layer.
 */
function topmostCloseRequestTarget(
	self: TermDOM,
): Element | null {
	const popover = topmostAutoPopover(self.document) as Element | null;
	let target: Element | null = null;
	for (const element of self[kTopLayer]) {
		if (isModalDialog(element) || element === popover) {
			target = element;
		}
	}
	return target;
}

/**
 * Focus the next or previous focusable element
 */
function moveFocus(
	self: TermDOM,
	reverse: boolean,
): void {
	// A modal dialog makes the rest of the document inert, and the visible
	// half of inertness is that Tab cannot leave the dialog: the sequential
	// order is the dialog's own, and it wraps within it.
	const scope = topmostModalDialog(self) ?? self.document;
	const focusable = getFocusableElements(scope, self[kLayoutEngine]);
	if (focusable.length === 0) {
		return;
	}

	const current = self.document.activeElement;
	const currentIndex = focusable.indexOf(current as Element);

	// Tab past the last focusable (or Shift+Tab before the first) rests on
	// nothing. That is the leg of a browser's cycle where focus walks the
	// chrome and the page sees activeElement fall back to body; a terminal
	// has no chrome, so the blurred stop stands in for it. It is also what
	// keeps a scope with a single focusable element escapable -- a pure
	// wrap would cycle Tab onto it forever.
	const leaving = reverse ?
		currentIndex === 0 :
		currentIndex === focusable.length - 1;
	if (leaving) {
		(current as HTMLElement).blur();
		return;
	}

	// From the blurred stop, Tab enters at the first element and Shift+Tab
	// at the last, as from a browser's chrome.
	const nextIndex = reverse ?
			(currentIndex === -1 ? focusable.length - 1 : currentIndex - 1) :
		currentIndex + 1;

	const next = focusable[nextIndex] as HTMLElement;
	next.focus();
	// A control the camera is not looking at cannot be typed into, so the
	// move brings it into view -- what a browser does when focus leaves the
	// scrollport, and what makes tabbing through a form longer than the
	// screen work at all.
	next.scrollIntoView({block: "nearest"});

	// Focus is not a DOM mutation, so no observer will schedule a frame -- but
	// :focus styling and the caret (the real terminal cursor, parked in the
	// focused field) both need one to move.
	void render(self);
}

/**
 * Hit-test a document-relative point (flushing pending layout first). The
 * one place both document.elementFromPoint (which converts its public,
 * viewport-relative x/y into this space) and mouse hit-testing (whose
 * points are already document-relative, from the viewport's screenToDocumentPoint) go
 * through, so a click always tests against fresh layout regardless of
 * entry point.
 */
function findElementAtDocumentPoint(
	self: TermDOM,
	x: number,
	y: number,
): Element | null {
	processPendingMutationsAndRender(self);
	let element = self[kLayoutEngine].hitTest(
		self.document.documentElement,
		x,
		y,
		self[kTopLayer],
		self[kViewport].scrollTop,
	);
	// A pseudo-element is not an element the DOM can hand out: the hit on
	// the content it generates is a hit on the element it originates from.
	for (
		let host = element && pseudoHostOf<Element>(element);
		host;
		host = pseudoHostOf<Element>(element!)
	) {
		element = host;
	}
	// RETARGET out of shadow trees, per spec: from outside a shadow tree
	// (and the document is always outside), the hit is the HOST -- a
	// click on an input's internal value span is a click on the input.
	// Without this, closest()/focus logic dead-ends inside the UA
	// fragment, whose parts have no parentElement chain to climb.
	while (element) {
		const root = element.getRootNode();
		if (root.nodeType === 11 && (root as ShadowRoot).host) {
			element = (root as ShadowRoot).host;
		} else {
			break;
		}
	}
	// A modal dialog makes the rest of the document inert: a point outside
	// it lands on its backdrop, and a backdrop's hits are the DIALOG's --
	// the target a browser reports for a click on the dim area, and the
	// reason nothing behind a modal can be clicked or focused while it is
	// up.
	const modal = topmostModalDialog(self);
	if (modal !== null && (element === null || !modal.contains(element))) {
		return modal as unknown as Element;
	}
	return element;
}

/**
 * The caret position under a document point: the element it hit-tests to,
 * asked of the engine.
 *
 * Null over a form control, whose value is not document text -- its
 * selection is the control's own bounded world, which kFieldOffsetAtPoint
 * asks about instead. The two never merge: getSelection() cannot see inside
 * a control, per spec.
 */
function documentPointToTextPosition(
	self: TermDOM,
	x: number,
	y: number,
): {node: Text; offset: number} | null {
	const element = findElementAtDocumentPoint(self, x, y);
	if (
		!element ||
		element instanceof (self.window as any).HTMLInputElement ||
		element instanceof (self.window as any).HTMLTextAreaElement
	) {
		return null;
	}
	return self[kLayoutEngine].caretPositionFromPoint(x, y, element);
}

/**
 * The scroll box a wheel tick over `target` belongs to: the nearest flat-tree
 * ancestor (the target included) whose overflow-y makes it a scroll
 * container -- auto or scroll; hidden and visible don't take the wheel, as
 * in a browser -- and that can still move in the tick's direction. None
 * means the tick chains past every element scroller to the document camera.
 */
function wheelScrollerFor(
	self: TermDOM,
	target: Element,
	deltaY: number,
): Element | null {
	const body = self.document.body;
	const root = self.document.documentElement;
	const engine = self[kLayoutEngine];
	for (
		let element: Element | null = target;
		element && element !== body && element !== root;
		element = flatParentElement<Element>(element)
	) {
		const style = computedStyleOf(element);
		const overflowY =
			style.computedValueOf("overflow-y") ||
			style.computedValueOf("overflow");
		if (overflowY !== "auto" && overflowY !== "scroll") {
			continue;
		}
		if (deltaY < 0) {
			if (element.scrollTop > 0) {
				return element;
			}
			continue;
		}
		const extent = engine.scrollExtentOf(element);
		const port = engine.contentRect(element);
		if (!extent || !port) {
			continue;
		}
		if (element.scrollTop < extent.height - Math.round(port.height)) {
			return element;
		}
	}
	return null;
}

/**
 * A mouse report from the terminal (SGR encoding: `CSI < code ; col ; row M/m`).
 * These only arrive while capture is on -- see updateMouseReporting.
 *
 * Reports become the DOM's own mouse events, dispatched at the element
 * under the cell (document.elementFromPoint is layout-true), with the
 * browser's default actions: wheel scrolls the camera, mousedown moves
 * focus, mouseup on the mousedown target is a click.
 */
function handleMouseReport(
	self: TermDOM,
	code: number,
	col: number,
	row: number,
	isRelease: boolean,
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

	const point = self[kViewport].screenToDocumentPoint(
		col - 1,
		row - 1,
		self[kFullscreenManager].isFullscreen,
	);
	const x = point?.x ?? col - 1;
	const y = point?.y ?? 0;
	// Already document-relative -- go straight to the shared hit-test rather
	// than through the public elementFromPoint, which expects viewport-
	// relative input and would convert it right back.
	const target =
		(point && findElementAtDocumentPoint(self, x, y)) || self.document.body;

	if (wheelDeltaY !== null) {
		const notCanceled = target.dispatchEvent(
			new self.window.WheelEvent("wheel", {
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
		if (notCanceled) {
			// The innermost scroll box under the pointer that can still move
			// in the wheel's direction consumes the tick; an exhausted one
			// chains outward -- ultimately to the camera and the terminal's
			// own scrollback below, the browser's scroll chaining.
			const scroller = wheelScrollerFor(self, target as Element, wheelDeltaY);
			if (scroller) {
				scroller.scrollTop += wheelDeltaY;
				return;
			}
			if (
				wheelDeltaY < 0 &&
				self[kViewport].scrollTop === 0 &&
				!self[kFullscreenManager].isFullscreen
			) {
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
				self[kMouseCaptureYielded] = true;
				updateMouseReporting(self);
				if (self[kScrollChainTimer] !== null) {
					clearTimeout(self[kScrollChainTimer]);
				}
				self[kScrollChainTimer] = setTimeout(() => {
					self[kScrollChainTimer] = null;
					reclaimMouseCapture(self);
				}, TermDOM[kSCROLL_CHAIN_TIMEOUT_MS]);
			} else {
				scrollCamera(self, wheelDeltaY);
			}
		}
		return;
	}

	// Buttons: 0/1/2 = left/middle/right. 3 is "no button" in the legacy
	// encoding; SGR names the button even on release, so 3 carries nothing.
	if (base > 2) {
		return;
	}
	const eventInit = {
		button,
		buttons,
		clientX: x,
		clientY: y,
		shiftKey,
		altKey,
		ctrlKey,
		bubbles: true,
		cancelable: true,
	};

	if (isMotion) {
		target.dispatchEvent(new self.window.MouseEvent("mousemove", eventInit));
		// A field drag extends the field's own selection to the offset
		// under the pointer -- clamped into the field, whichever element
		// the pointer is over now (the field holds the capture).
		if (self[kFieldDragAnchor] && point) {
			const {element: fieldElement, offset: anchor} = self[kFieldDragAnchor];
			const focus = fieldOffsetAtPoint(self, fieldElement, x, y);
			if (focus !== null) {
				setUASelection(
					fieldElement,
					Math.min(anchor, focus),
					Math.max(anchor, focus),
					focus < anchor ? "backward" : "forward",
				);
				render(self);
			}
			return;
		}
		// Dragging with the anchor set extends the document selection to
		// the caret position under the pointer. setBaseAndExtent handles a
		// backward drag itself; over a textless stretch the focus simply
		// stays where it last was.
		if (self[kSelectionDragAnchor] && self[kMouseDownTarget] && point) {
			const focus = documentPointToTextPosition(self, x, y);
			if (focus) {
				const anchor = self[kSelectionDragAnchor];
				self.window
					.getSelection()
					?.setBaseAndExtent(
						anchor.node,
						anchor.offset,
						focus.node,
						focus.offset,
					);
				render(self);
			}
		}
		return;
	}

	if (!isRelease) {
		self[kMouseDownTarget] = target;
		// The popover a press belongs to, which the release compares
		// against: light dismiss is a press and a release in the same
		// place, so a drag out of a popover does not close it.
		self[kPopoverPressTarget] = topmostClickedPopover(target);
		self[kFieldDragAnchor] = null;
		// A pointer press suppresses the :focus-visible ring.
		if (self[kStyleManager].setFocusVisible(false)) {
			self[kStyleManager].handleFocusChange(self.document.activeElement);
			void render(self);
		}
		const notCanceled = target.dispatchEvent(
			new self.window.MouseEvent("mousedown", eventInit),
		);
		// Default action: mousedown moves focus, exactly as in a browser --
		// to the nearest focusable ancestor, or away from the active element
		// when the click lands on nothing focusable.
		if (notCanceled) {
			const focusable = (target as Element).closest?.(FOCUSABLE_SELECTOR);
			const active = self.document.activeElement;
			if (focusable && focusable !== active) {
				(focusable as HTMLElement).focus();
				void render(self);
			} else if (!focusable && active && active !== self.document.body) {
				(active as HTMLElement).blur();
				void render(self);
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
				base === 0 && point && isTextField(target as Element) ?
						(target as HTMLInputElement | HTMLTextAreaElement) :
					null;
			if (field) {
				const offset = fieldOffsetAtPoint(self, field, x, y);
				if (offset !== null) {
					setUASelection(field, offset, offset);
					self[kFieldDragAnchor] = {element: field, offset};
					// The DOCUMENT selection still clears on entry -- a page
					// selection doesn't stay highlighted behind a field click
					// in a browser either. The two worlds just never merge:
					// getSelection() cannot see inside the field, per spec.
					const docSelection = self.window.getSelection();
					if (docSelection && !docSelection.isCollapsed) {
						docSelection.removeAllRanges();
					}
					render(self);
				}
			}

			// Default action: mousedown collapses the document selection at
			// the pressed caret position and anchors a possible drag there,
			// as in a browser. Left button only -- and preventDefault on
			// mousedown suppresses it, which is exactly how apps that want
			// the drag events for themselves opt out.
			const selection = self.window.getSelection();
			if (base === 0 && selection && !self[kFieldDragAnchor]) {
				const anchor = point ?
						documentPointToTextPosition(self, x, y) :
					null;
				const hadSelection = !selection.isCollapsed;
				self[kSelectionDragAnchor] = anchor;
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
					render(self);
				}
			}
		}
		return;
	}

	target.dispatchEvent(new self.window.MouseEvent("mouseup", eventInit));
	// LIGHT DISMISS: a release closes every auto popover the released
	// point is not inside of and did not open -- the invoker of a popover
	// counts as part of it, so the click that follows toggles rather than
	// reopens what this closed. It runs before the click, where a browser
	// runs it, and no listener can prevent it.
	const dismissAncestor = topmostClickedPopover(target);
	const samePopoverPress = dismissAncestor === self[kPopoverPressTarget];
	self[kPopoverPressTarget] = null;
	if (samePopoverPress && topmostAutoPopover(self.document) !== null) {
		hidePopoversUntil(self.document, dismissAncestor, false, true);
	}
	// A selection is only a selection: writing the clipboard is a
	// deliberate act, through navigator.clipboard. The terminal's own
	// select-to-copy remains available as Shift+drag, which bypasses
	// mouse reporting.
	let selectedByDrag = false;
	if (self[kFieldDragAnchor]) {
		self[kFieldDragAnchor] = null;
	}
	if (self[kSelectionDragAnchor]) {
		self[kSelectionDragAnchor] = null;
		const text = self.window.getSelection()?.toString() ?? "";
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
		self[kMouseDownTarget] = null;
		return;
	}
	if (self[kMouseDownTarget] === target) {
		target.dispatchEvent(
			new self.window.MouseEvent("click", {...eventInit, buttons: 0}),
		);
		// A checkbox/radio's .checked already flipped -- the activation behavior's
		// activation behavior handles that directly, and forwards it from a
		// <label for> or wrapping label the same way (honoring
		// preventDefault in both cases) -- but that's a property change,
		// invisible to the MutationObserver that would otherwise repaint it,
		// same as .value on a text input. Focus also needs an explicit push
		// here for the label case: a real browser's "focusing steps" move
		// focus to the label's associated control, which the activation behavior's
		// alone does not simulate (the direct-click case is already
		// focused via mousedown's own default action above, so this is a
		// harmless no-op there).
		const isCheckable = (el: unknown): el is HTMLInputElement =>
			el instanceof (self.window as any).HTMLInputElement &&
			((el as HTMLInputElement).type === "checkbox" ||
				(el as HTMLInputElement).type === "radio");
		const control = isCheckable(target) ?
			target :
			target instanceof (self.window as any).HTMLLabelElement &&
			isCheckable((target as any).control) ?
					((target as any).control as HTMLInputElement) :
				null;
		if (control) {
			control.focus();
			render(self);
		}

		// A second click on the same target within the double-click interval
		// is also a dblclick -- in addition to, not instead of, its own click
		// (a browser fires both). Reset after firing so a third quick click
		// starts a fresh pair rather than double-firing again immediately.
		const now = performance.now();
		if (
			self[kLastClickTarget] === target &&
			now - self[kLastClickTime] <= TermDOM[kDBLCLICK_INTERVAL_MS]
		) {
			target.dispatchEvent(
				new self.window.MouseEvent("dblclick", {...eventInit, buttons: 0}),
			);
			self[kLastClickTarget] = null;
			self[kLastClickTime] = 0;
		} else {
			self[kLastClickTarget] = target as Element;
			self[kLastClickTime] = now;
		}
	}
	self[kMouseDownTarget] = null;
}

/**
 * Deliver a paste to the focused control as an `insertFromPaste` beforeinput;
 * its own listener does the edit. Dropped if nothing editable is focused.
 */
function dispatchPaste(
	self: TermDOM,
	text: string,
): void {
	// A terminal transmits a pasted line break as CR -- the byte Enter
	// sends (tmux's paste-buffer documents the LF-to-CR replacement) --
	// while the DOM's paste carries newlines as LF. Converted here, at the
	// boundary, so a multi-line paste into a textarea is multi-line and
	// a field's own handlers never see a bare CR.
	text = text.replace(/\r\n?/g, "\n");
	const target = self.document.activeElement;
	if (!target || target === self.document.body) {
		return;
	}
	target.dispatchEvent(
		new self.window.InputEvent("beforeinput", {
			inputType: "insertFromPaste",
			data: text,
			bubbles: true,
			cancelable: true,
		}),
	);
	void render(self);
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
function dispatchInsertText(
	self: TermDOM,
	target: Element,
	text: string,
): void {
	const tag = target.tagName;
	if (tag !== "INPUT" && tag !== "TEXTAREA") {
		return;
	}
	target.dispatchEvent(
		new self.window.InputEvent("beforeinput", {
			inputType: "insertText",
			data: text,
			bubbles: true,
			cancelable: true,
		}),
	);
}

function dispatchGlobalKeyboardEvent(
	self: TermDOM,
	key: string,
): void {
	// Tokenize multi-key chunks and dispatch each token on its own.
	const tokens = Array.from(tokenizeInput(key));
	if (tokens.length > 1) {
		for (const token of tokens) {
			dispatchGlobalKeyboardEvent(self, token);
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
	if (self[kStyleManager].setFocusVisible(true)) {
		self[kStyleManager].handleFocusChange(self.document.activeElement);
		void render(self);
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
	const active = self.document.activeElement;
	const targetElement =
		active && active !== self.document.body ?
			active :
			self[kFullscreenManager].fullscreenElement || self.document.body;

	// Escape in fullscreen is the user agent's key, never dispatched to the
	// DOM: an app can't trap the user past it with preventDefault. It spends
	// itself on the innermost trap first -- a focused text field owns the
	// keyboard, so the first Escape gives it back, and only a free
	// keyboard's Escape exits the screen.
	if (keyName === "Escape" && self[kFullscreenManager].isFullscreen) {
		if (
			active &&
			active !== self.document.body &&
			isTextField(active as Element)
		) {
			(active as HTMLElement).blur();
			return;
		}
		self[kFullscreenManager].exitFullscreen().catch(() => {});
		return;
	}

	// Create and dispatch keydown event
	const keydownEvent = new self.window.KeyboardEvent("keydown", {
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

	const notCanceled = targetElement.dispatchEvent(keydownEvent);

	// Escape is a CLOSE REQUEST on whatever is on top of the top layer and
	// answers one: a modal dialog fires cancel and closes unless a
	// listener takes it, an auto popover closes outright (nothing cancels
	// a popover, which is why a manual one -- answering no close request
	// -- is the way to keep one up). Whichever entered the layer last is
	// the one the key reaches, so a popover over a dialog closes first.
	// Both get Escape only when nothing is fullscreen -- the branch above
	// already returned -- which is the browser's own precedence: the
	// fullscreen exit is the user agent's guarantee, and only after it is
	// spent does the key reach the page's own modality. Unlike Tab below,
	// a preventDefault on keydown does not suppress it.
	if (keyName === "Escape") {
		const target = topmostCloseRequestTarget(self);
		if (target !== null) {
			if (isShowingPopover(target)) {
				closePopover(target);
			} else {
				(target as HTMLDialogElement).requestClose();
			}
			void render(self);
			return;
		}
	}

	// Handle default actions if keydown wasn't canceled
	if (notCanceled) {
		// Tab navigation
		if (keyName === "Tab") {
			moveFocus(self, shiftKey);
		}

		// Field editing (input and textarea) is each widget's own keydown
		// listener, run during dispatch above -- not a default action here.
		if (keyboardActivation(targetElement as Element)) {
			// A focused button activates on Enter and on Space, and a link on
			// Enter, per HTML's activation behavior. Without this, both took
			// focus and painted :focus while doing nothing -- advertising an
			// affordance they did not have. `input[type=submit|button]`
			// activate here; text inputs never match keyboardActivation.
			const activation = keyboardActivation(targetElement as Element)!;
			if (
				(keyName === "Enter" && activation.enter) ||
				(key === " " && activation.space)
			) {
				// click() rather than a synthesized event: it runs the element's
				// full activation behavior, so a submit button submits its form
				// and a link follows its href, exactly as a mouse click would.
				(targetElement as HTMLElement).click();
				render(self);
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
		const keypressEvent = new self.window.KeyboardEvent("keypress", {
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
		if (targetElement.dispatchEvent(keypressEvent)) {
			dispatchInsertText(self, targetElement, key);
		}
	}

	// Always dispatch keyup
	const keyupEvent = new self.window.KeyboardEvent("keyup", {
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
	targetElement.dispatchEvent(keyupEvent);
}

/**
 * Render the whole document once, as plain lines, for a non-terminal stdout.
 *
 * There is no fold here, so there is nothing to commit, freeze or repair: the
 * document is simply printed. Every hard problem in this file is a consequence
 * of having a viewport, and a pipe does not have one.
 */
async function printStatic(
	self: TermDOM,
): Promise<void> {
	const pending = self[kObserver].takeRecords();
	if (pending.length > 0) {
		handlePendingMutations(self, pending);
	}

	self[kLayoutEngine].calculateLayout();

	const context = self[kScreen].beginStatic({
		rows: self.document.body.scrollHeight,
	});
	self[kPainter].paint(context);
	const output = self[kScreen].endFrame();

	if (output) {
		await self[kWrite](output);
	}
	afterRender(self);
}

/**
 * Print the whole document to stdout, once, on the way out.
 *
 * Document mode never commits anything: it paints a window of the document into
 * a region it owns and repaints it in place. That is what buys the mutability --
 * nothing is frozen, because nothing was printed. But it means that at the
 * moment we exit, the terminal has only ever *seen* the last frame.
 *
 * So we settle up. Erase the region we were painting -- our own viewport rows,
 * with ED0; this is not the flicker sin, which is ED3 against the scrollback --
 * and then print the document in full. It scrolls into the scrollback exactly as
 * an ordinary command's output does, and the terminal ends up holding the whole
 * thing: searchable, selectable, and still there tomorrow.
 *
 * The axis was never "do you get scrollback". It is *when you commit*: flow
 * writes uneditable stdout as it goes, and document waits until the end.
 *
 * The cost of waiting is that a crash takes the output with it -- flow's partial
 * output survives, because it was already printed.
 */
function flushDocument(
	self: TermDOM,
): void {
	if (!self[kInteractive]) {
		return;
	}

	const top = self[kViewport].screenTop;
	const output = renderStatic(self, "\r\n");
	if (!output) {
		return;
	}

	// Back to the top of our region; every payout line then clears ITSELF
	// (\x1b[K before its text) and one partial erase covers whatever the
	// old frame held below. Never a full ED from the top row: tmux
	// preserves a fully-erased screen by pushing it into scrollback (the
	// courtesy it extends to `clear`), which archived a copy of the final
	// frame above the payout -- the document twice, interleaved.
	void self[kSession].write(`\x1b[${top + 1};1H`);
	void self[kSession].write(
		"\x1b[K" + output.replace(/\r\n(?!$)/g, "\r\n\x1b[K"),
	);
	void self[kSession].write("\x1b[J");
}

/**
 * The document as an ANSI string: colors and line breaks, no cursor
 * controls, no modes. Feeds the quit payout (CRLF: raw mode does not
 * translate bare newlines) and the scratch sibling behind renderANSI();
 * not part of the class's public surface.
 */
function renderStatic(
	self: TermDOM,
	lineEnding: "\n" | "\r\n",
): string {
	processPendingMutationsAndRender(self);
	const contentHeight = self.document.body.scrollHeight;
	if (contentHeight === 0) {
		return "";
	}
	const context = self[kScreen].beginStatic({
		rows: contentHeight,
		lineEnding,
	});
	self[kPainter].paint(context);
	return self[kScreen].endFrame();
}

/**
 * Render a window of the document into a region we own.
 *
 * Document mode still starts at the command height: it does not seize the whole
 * terminal, and it does not paint over what was on screen before us. If it needs
 * more rows than are left below the command start, it *scrolls* the earlier
 * content away into the scrollback, where it survives and the user can still
 * reach it.
 *
 * Nothing of ours is committed. The document stays a single mutable thing
 * that we repaint a window of: content that scrolls out of view is never
 * frozen output, and reflow anywhere is free.
 */
async function renderInteractive(
	self: TermDOM,
): Promise<void> {
	// The previous document was sealed to scrollback by close(). Start a fresh
	// one below it: re-anchor to where the cursor now sits and reset the diff so
	// nothing composites over the frozen block.
	if (self[kSealed]) {
		self[kSealed] = false;
		self[kViewport].scrollTop = 0;
		self[kScreen].repaintAll();
		// detectCommandStart waits for a reply on stdin, so the listener must
		// be attached first (idempotent -- normally already done by now).
		if (self[kInteractive]) {
			self.attach();
			await self[kSession].detectCommandStart();
		}
	}

	// Our region starts at the command-start row, which cursor detection resolves
	// asynchronously. Render before it lands and the first frame anchors at row 0
	// while every diff after detection anchors one row lower -- the labels stay,
	// the values slide down a row. Wait for the anchor to settle first, exactly
	// as the flow path does. Await only when one is pending: an unconditional
	// await would defer the rest of this frame a microtask even with nothing
	// to wait for, and a downstream synchronous scroll clamp depends on it.
	const detectionPending = self[kSession].cursorDetectionPending;
	if (detectionPending) {
		await detectionPending;
	}

	const pending = self[kObserver].takeRecords();
	if (pending.length > 0) {
		handlePendingMutations(self, pending);
	}

	self[kLayoutEngine].calculateLayout();
	clampScrolledOffsets(self);

	// The caret reveal an edit queued runs here, against the layout this
	// frame just flushed -- one camera decision per frame, however many
	// keystrokes coalesced into it. Skipped if focus has already moved
	// on: revealing a field the user left would yank the camera back.
	const revealed = self[kPendingCaretReveal] !== null;
	if (self[kPendingCaretReveal]) {
		const reveal = self[kPendingCaretReveal];
		self[kPendingCaretReveal] = null;
		if (reveal === self.document.activeElement) {
			scrollCaretIntoView(self, reveal);
		}
	}

	// Nothing observable moved: no mutations, no invalidation, no input,
	// same focus, no live selection, camera unmoved, no reveal, no pending
	// reset. Painting would emit nothing; don't pay to discover that.
	const selection = self.window.getSelection?.();
	if (
		pending.length === 0 &&
		!revealed &&
		self[kLastFrameScrollTop] !== null &&
		self[kViewport].scrollTop === self[kLastFrameScrollTop] &&
		self[kLayoutEngine].invalidationEpoch === self[kLastFrameEpoch] &&
		self[kInputGeneration] === self[kLastFrameInputGeneration] &&
		self.document.activeElement === self[kLastFrameActiveElement] &&
		(!selection || selection.rangeCount === 0 || selection.isCollapsed) &&
		!self[kScreen].needsRepaint
	) {
		// Skip the paint, not the frame: observers still run, so a fresh
		// observe() gets its initial entry on the next tick.
		afterRender(self);
		return;
	}

	// Recompute the focused input's scroll window every frame (derived state).
	const activeField = self.document.activeElement;
	if (
		activeField instanceof (self.window as any).HTMLInputElement &&
		isTextField(activeField as HTMLInputElement)
	) {
		scrollFieldCaretIntoView(self, activeField as HTMLInputElement);
	}

	// Fullscreen owns the WHOLE alternate screen from row zero: the
	// main screen's command anchor means nothing there, and reserveRows'
	// index-scrolls would scroll the alternate screen itself. The
	// document's scroll position survives untouched underneath -- the
	// fixed, Canvas-backed fullscreen element covers it regardless.
	const isFullscreen = self[kFullscreenManager].isFullscreen;
	const contentHeight = isFullscreen ?
		self[kHeight] :
			documentPaintHeight(self);
	const regionHeight = Math.min(contentHeight, self[kHeight]);

	// Take the room we need by pushing earlier output up, never over it.
	const top = isFullscreen ? 0 : reserveRows(self, regionHeight);

	if (!isFullscreen) {
		// The camera cannot run off the end of the document.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		self[kViewport].scrollTop = Math.min(
			self[kViewport].scrollTop,
			maxScroll,
		);
	}

	// A frame is a TRANSFORM when everything that changed since the last
	// one is bounded: a camera delta (the terminal scrolls the region via
	// DECSTBM + DL/IL) plus damage that names its elements. Only the
	// exposed band, fixed rows (real and shifted positions), the focused
	// field, and damaged rows repaint. Anything unbounded -- a structural
	// event, a live selection, a drag, a geometry change (cascades) --
	// takes the full diff. What a mouse report changes names its elements:
	// a click moves focus, which the cascade damages, and a drag holds an
	// anchor this gate already reads. A pointer that flipped state
	// anywhere on the screen would not, but no such state exists here --
	// :hover matches nothing -- and adding one means damaging the chains
	// it entered and left, not giving up the transform.
	let scroll: {delta: number; bands: Array<[number, number]>} | undefined;
	const scrollTop = self[kViewport].scrollTop;
	const styleDamage = self[kStyleManager].drainStyleDamage();
	const frameDamage = self[kFrameDamage];
	self[kFrameDamage] = new Map();
	const documentSelection = self.window.getSelection?.();
	const liveSelection = Boolean(
		documentSelection &&
		documentSelection.rangeCount > 0 &&
		!documentSelection.isCollapsed,
	);
	transform: if (
		!isFullscreen &&
		top === 0 &&
		regionHeight === self[kHeight] &&
		self[kLastFrameScrollTop] !== null &&
		self[kLayoutEngine].structuralGeneration ===
		self[kLastFrameStructuralGeneration] &&
		!liveSelection &&
		!self[kLastFrameSelectionLive] &&
		self[kSelectionDragAnchor] === null &&
		self[kFieldDragAnchor] === null &&
		!self[kResizeInProgress] &&
		frameDamage !== null &&
		styleDamage !== null
	) {
		const delta = scrollTop - self[kLastFrameScrollTop];
		if (Math.abs(delta) >= regionHeight) {
			break transform;
		}
		if (delta === 0 && frameDamage.size === 0 && styleDamage.size === 0) {
			break transform;
		}

		const bands: Array<[number, number]> = [];
		// Past most of the region the transform stops paying, so the rows
		// the bands claim are counted as they are added: damage that
		// already covers the screen stops the walk instead of pricing
		// every element that follows it. Overlap counts twice, which only
		// makes the bail come sooner.
		const bandBudget = regionHeight * 0.75;
		let coverage = 0;
		const addBand = (start: number, end: number): void => {
			const clampedStart = Math.max(0, Math.floor(start));
			const clampedEnd = Math.min(regionHeight, Math.ceil(end));
			if (clampedEnd > clampedStart) {
				bands.push([clampedStart, clampedEnd]);
				coverage += clampedEnd - clampedStart;
			}
		};

		if (delta > 0) {
			addBand(regionHeight - delta, regionHeight);
		} else if (delta < 0) {
			addBand(0, -delta);
		}
		for (const band of self[kLayoutEngine].fixedRowBands(self[kHeight])) {
			addBand(band[0], band[1]);
			// The scroll moved fixed content too, leaving a stale copy at
			// the shifted position; model and screen agree on it, so only
			// a repaint of that row corrects it.
			if (delta !== 0) {
				addBand(band[0] - delta, band[1] - delta);
			}
		}
		// The focused field's rows repaint: its caret cell and the real
		// cursor park come from the painter visiting it.
		const active = self.document.activeElement;
		if (active && UPGRADEABLE_CONTROLS.has(active.tagName)) {
			const rect = self[kLayoutEngine].getRect(active);
			if (rect) {
				addBand(rect.top - scrollTop, rect.top + rect.height - scrollTop);
			}
		}

		// A focus move flips :focus/:focus-visible on both elements.
		const damaged = new Set<Element>(frameDamage.keys());
		for (const element of styleDamage) {
			damaged.add(element);
		}
		if (active !== self[kLastFrameActiveElement]) {
			if (active) {
				damaged.add(active);
			}
			if (self[kLastFrameActiveElement]) {
				damaged.add(self[kLastFrameActiveElement]);
			}
		}

		for (const element of damaged) {
			if (coverage > bandBudget) {
				break transform;
			}
			// Damage reaches as far as the selector invalidation scope; the
			// whole document is unbounded.
			const scope = self[kStyleManager].invalidationScopeFor(element);
			if (
				scope === self.document.body ||
				scope === self.document.documentElement
			) {
				break transform;
			}
			const before = frameDamage.get(element) ?? frameDamage.get(scope);
			const after = self[kLayoutEngine].getRect(scope);
			if (!after && !before) {
				// An inline element has no box of its own, so its rows are
				// not recoverable here: unbounded. A removed element's
				// damage is its parent's, already recorded.
				if (scope.isConnected) {
					break transform;
				}
				continue;
			}
			// A geometry change cascades to everything after the element.
			if (
				before &&
				after &&
				(before.top !== after.top || before.height !== after.height)
			) {
				break transform;
			}
			const fixedSpace = self[kLayoutEngine].isInFixedSpace(scope);
			if (after) {
				const afterTop = fixedSpace ? after.top : after.top - scrollTop;
				addBand(afterTop, afterTop + after.height);
				// The shifted stale copy of the damaged rows, as for fixed.
				if (delta !== 0) {
					addBand(afterTop - delta, afterTop + after.height - delta);
				}
			}
			if (before) {
				const beforeTop = fixedSpace ?
					before.top :
					before.top - self[kLastFrameScrollTop];
				addBand(beforeTop - delta, beforeTop + before.height - delta);
			}
		}

		if (delta === 0 && bands.length === 0) {
			break transform;
		}
		if (coverage > bandBudget) {
			break transform;
		}

		scroll = {delta, bands};
	}

	const context = self[kScreen].beginFrame({
		offset: -self[kViewport].scrollTop,
		cursorRow: top,
		regionRows: top + regionHeight,
		scroll,
		measurer: self[kSession].widthMeasurer,
	});
	self[kPainter].paint(context);
	const ansi = self[kScreen].endFrame();
	self[kLastFrameScrollTop] = scrollTop;
	self[kLastFrameEpoch] = self[kLayoutEngine].invalidationEpoch;
	self[kLastFrameInputGeneration] = self[kInputGeneration];
	self[kLastFrameStructuralGeneration] =
		self[kLayoutEngine].structuralGeneration;
	self[kLastFrameSelectionLive] = liveSelection;
	self[kLastFrameActiveElement] = self.document.activeElement;

	if (ansi) {
		await self[kWrite](ansi);
	}
	afterRender(self);
}

/** Move the camera over the document. */
function scrollCamera(
	self: TermDOM,
	rows: number,
): void {
	self[kViewport].scrollBy(rows);
	// A camera move is invisible to the MutationObserver; schedule the frame
	// it needs, the same way a DOM mutation would.
	void render(self);
}

/**
 * Make room for `rows` rows below the command start, *without painting over
 * anything that was already on screen*.
 *
 * If there is not enough room between the command start and the bottom of the
 * terminal, we scroll the terminal -- pushing the rows above into the
 * scrollback, where they are preserved and the user can still reach them.
 * Overwriting them in place would destroy the output of whatever ran before
 * us; scrolling them away is what an ordinary command does when it prints.
 *
 * This positions the cursor at the bottom row (CUP) and sends IND (ESC D,
 * Index -- "move down a line, scrolling if already at the bottom margin")
 * `push` times. Two things this is deliberately NOT:
 *
 * - Not "print bare newlines at the bottom margin". Verified directly (a
 *   real terminal via tmux, and the xterm-headless mock the test suite
 *   runs against) that a bare LF only triggers a scroll when the cursor
 *   reaches the bottom row through ordinary sequential output --
 *   teleporting there with an absolute CUP first and then sending LF
 *   leaves the screen completely unchanged in both.
 * - Not CSI n S (Scroll Up), which scrolls the visible screen correctly in
 *   both but -- verified directly -- does not add the scrolled-off rows to
 *   xterm-headless's own scrollback history the way real terminal
 *   scrolling does, which would make the "scrolled away, not destroyed"
 *   half of this behavior untestable. IND scrolls identically but goes
 *   through the same internal path as natural overflow, so it does.
 *
 * Returns the screen row our region now starts at.
 */
function reserveRows(
	self: TermDOM,
	rows: number,
): number {
	const push = self[kViewport].reserveRows(rows, self[kHeight]);
	if (push > 0) {
		void self[kSession].write(
			`\x1b[${self[kHeight]};1H` + "\x1bD".repeat(push),
		);
		// Do NOT shift the renderer's previous buffer. Its rows are relative to
		// the region top, and the top moves up by exactly the amount the screen
		// scrolled -- the two cancel, so buffer coordinates are unchanged.
		// Shifting it desynced the diff by `push` rows: the model compared
		// against the wrong screen rows, skipped cells it wrongly believed
		// unchanged, and composited the old frame under the new one whenever a
		// document-mode region grew past the space below the shell prompt.
		//
		// A pending post-resize screen reset IS screen-absolute, though, and
		// must ride the scroll (see shiftScreenReset).
		self[kScreen].scrolled(push);
	}

	return self[kViewport].screenTop;
}

function staticRenderer(
	self: TermDOM,
): TermDOM {
	const cols = self[kTransport].cols;
	if (self[kStaticSibling] && self[kStaticSibling][kWidth] !== cols) {
		void self[kStaticSibling].dispose();
		self[kStaticSibling] = null;
	}
	self[kStaticSibling] ??= new TermDOM({
		transport: {
			cols,
			rows: 24,
			readable: new ReadableStream<string>({}, {highWaterMark: 0}),
			writable: new WritableStream<string>({}),
			resizes: new ReadableStream<TerminalSize>({}, {highWaterMark: 0}),
			closed: new Promise<TerminalCloseInfo>(() => {}),
			ready: Promise.resolve(),
			colorDepth: "rgb",
			interactive: false,
			sharesScreen: false,
			close() {},
		},
	});
	return self[kStaticSibling];
}

function renderStaticHTML(
	self: TermDOM,
	html: string,
	lineEnding: "\n" | "\r\n",
): string {
	const renderer = staticRenderer(self);
	renderer.document.body.innerHTML = html;
	return renderStatic(renderer, lineEnding);
}
