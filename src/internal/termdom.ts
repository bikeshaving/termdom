import {type DOMWindow, JSDOM} from "jsdom";
import {LayoutEngine, visualToDataOffsets} from "./layout.js";
import {Viewport} from "./viewport.js";
import {Painter} from "./painter.js";
import {
	TerminalSession,
	transportFromProcess,
	type TerminalCloseInfo,
	type TerminalSize,
	type TerminalTransport,
} from "./terminalsession.js";
import {Renderer} from "./ansi.js";
import {
	StyleManager,
	beginInternalStyleReads,
	endInternalStyleReads,
	getBoxModel,
} from "./styles.js";
import {stringWidth} from "./text.js";
import {
	ObserverManager,
	ResizeObserver as TermResizeObserver,
	IntersectionObserver as TermIntersectionObserver,
} from "./observers.js";
import {setupInspectMethods} from "./inspector.js";
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
import {
	compositionIsConnected,
	compositionParentElement,
	currentCompositionEpoch,
	currentStructuralGeneration,
	fieldCaretRange,
	fieldValueText,
	invalidateComposition,
	invalidateStructure,
} from "./composition.js";
import {type UAWidgetController, defineUAWidgets} from "./widgets.js";

// How long to wait for a resize drag to settle before redrawing. Long enough to
// coalesce the burst of SIGWINCHes a drag fires, short enough to feel immediate.
const RESIZE_DEBOUNCE_MS = 40;

// The built-in tags that upgrade to a UA widget on connect.
const UPGRADEABLE_CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

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

// Symbol-keyed handles for the internals the test suite must reach (the layout
// engine, input injection, anchor state). These are deliberately not #private so
// a test can import the key and read them -- but they are off the public API:
// index.ts does not re-export these symbols, so a consumer cannot name them.
const kLayoutEngine = Symbol("layoutEngine");
const kObserver = Symbol("observer");
// The static-render entry renderANSI() reaches through; off the public API
// like the test handles above.
const kRenderStatic = Symbol("renderStatic");
export {kLayoutEngine, kObserver, kRenderStatic};

/** A text-ish input type (not checkbox/radio/hidden). */
function isTextInputType(type: string): boolean {
	return type !== "checkbox" && type !== "radio" && type !== "hidden";
}

/**
 * The Fullscreen API over the terminal's alternate screen. Lives here
 * rather than in its own module because the alt-screen switch has to
 * serialize with rendering -- the two are one concern, not two.
 *
 * Writes through the session like every other emitter; raw mode is the
 * session's for the whole attachment, so there is nothing to save or restore
 * here beyond the screen switch itself.
 */
export class FullscreenManager {
	#write: (output: string) => void;

	#fullscreenStack: Element[] = [];
	#isInFullscreenMode: boolean = false;

	constructor(write: (output: string) => void) {
		this.#write = write;
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
			this.#fullscreenStack.push(element);

			// Enter fullscreen mode if this is the first element
			if (!this.#isInFullscreenMode) {
				await this.#enterFullscreenMode();
			}

			// Fire fullscreenchange event
			this.#fireFullscreenChangeEvent(element);
		} catch (error) {
			// Remove from stack on error
			this.#fullscreenStack.pop();

			// Fire fullscreenerror event
			this.#fireFullscreenErrorEvent(element, error as Error);
			throw error;
		}
	}

	/**
	 * Exit fullscreen mode
	 */
	async exitFullscreen(): Promise<void> {
		if (this.#fullscreenStack.length === 0) {
			return; // Already not in fullscreen
		}

		// Remove the topmost element
		const exitingElement = this.#fullscreenStack.pop()!;

		// If no more elements in stack, exit fullscreen mode
		if (this.#fullscreenStack.length === 0) {
			await this.#exitFullscreenMode();
		}

		// Fire fullscreenchange event
		this.#fireFullscreenChangeEvent(exitingElement);
	}

	/**
	 * Get the current fullscreen element
	 */
	get fullscreenElement(): Element | null {
		return this.#fullscreenStack.length > 0
			? this.#fullscreenStack[this.#fullscreenStack.length - 1]
			: null;
	}

	/**
	 * Check if currently in fullscreen mode
	 */
	get isFullscreen(): boolean {
		return this.#isInFullscreenMode;
	}

	async #enterFullscreenMode(): Promise<void> {
		// Enter alternate screen buffer, clear it, hide the cursor.
		this.#write("\x1b[?1049h");
		this.#write("\x1b[2J\x1b[H\x1b[?25l");

		this.#isInFullscreenMode = true;
	}

	async #exitFullscreenMode(): Promise<void> {
		// Restore cursor and exit alternate screen buffer
		this.#write("\x1b[?25h\x1b[?1049l");

		this.#isInFullscreenMode = false;
	}

	#fireFullscreenChangeEvent(element: Element): void {
		const window = this.#getWindow(element);
		if (!window) return;

		const event = new window.CustomEvent("fullscreenchange", {
			bubbles: true,
			cancelable: false,
		});

		// Per spec: fired on the element, and it BUBBLES -- document listeners
		// hear it through the bubble; dispatching on the document as well
		// delivered every transition twice.
		element.dispatchEvent(event);
	}

	#fireFullscreenErrorEvent(element: Element, error: Error): void {
		const window = this.#getWindow(element);
		if (!window) return;

		const event = new window.CustomEvent("fullscreenerror", {
			bubbles: true,
			cancelable: false,
			detail: {error},
		});

		// Fire on both element and document
		element.dispatchEvent(event);
		element.ownerDocument?.dispatchEvent(event);
	}

	#getWindow(element?: Element): any {
		// Get window from the element's document, or from the stack
		const targetElement = element || this.#fullscreenStack[0];
		return targetElement?.ownerDocument?.defaultView;
	}

	dispose(): void {
		if (this.#isInFullscreenMode) {
			this.#write("\x1b[?25h\x1b[?1049l");
		}

		this.#fullscreenStack = [];
		this.#isInFullscreenMode = false;
	}
}

/**
 * Everything the jsdom patches below need from the TermDOM that installed
 * them -- the whole seam, in one place, instead of a closure over the
 * instance.
 *
 * Getters and callbacks, never values. The patches are installed once and
 * then live for as long as the document does: prototype methods, property
 * getters and event plumbing that run long after the constructor returned.
 * Most of what they reach for does not exist yet when they are installed --
 * the renderer, the style manager, the layout engine and the mutation
 * observer are all assigned later in the same constructor -- and the rest
 * (the camera, the anchor, the frame counter) moves while the program runs.
 * A captured value would freeze `undefined` for half of these and a stale
 * number for the other half.
 */
export class TermDOM {
	readonly document: Document;
	readonly window: DOMWindow;

	#renderer: Renderer;
	[kLayoutEngine]: LayoutEngine;
	// TODO: Should we expose the JSDOM instance?
	#jsdom: JSDOM;
	[kObserver]: MutationObserver;
	#fullscreenManager: FullscreenManager;
	#observerManager: ObserverManager;
	#styleManager: StyleManager;
	#uaWidgets: UAWidgetController;
	// The DOM-tree -> terminal-cells paint walk. Reads geometry/styles/widgets;
	// owns no scheduling. Shares #topLayer by reference.
	#painter: Painter;
	// Where the viewport looks in the document: scrollTop (window.scrollY),
	// screenTop (the command-start row), and the fullscreen anchor. See Viewport.
	#viewport = new Viewport();

	// Guard against re-entrant rendering. A render() call arriving while one is in
	// flight sets renderQueued rather than being dropped, so a trailing frame runs.
	#isRendering = false;
	// Callbacks registered via window.requestAnimationFrame, fired once the frame
	// that includes their pending mutations has actually been written. Keyed
	// by the handle requestAnimationFrame returned, so cancelAnimationFrame
	// can actually cancel.
	#frameCallbacks = new Map<number, FrameRequestCallback>();
	#nextRafId = 1;
	// One updater per live MediaQueryList: re-evaluates its query and fires
	// "change" if the answer flipped. Run by #handleResize -- SIGWINCH is
	// this screen's window resize.
	#mediaQueryUpdaters = new Set<() => void>();
	// document.close() sealed the current document into scrollback; the next
	// mutation starts a fresh document below it.
	#sealed = false;
	#renderQueued = false;
	#screenSwitching = false;
	#renderInFlight: Promise<void> | null = null;

	// Monotonic frame counter, used to timestamp observer entries.
	#renderCount = 0;

	// An overflowed field's horizontal scroll lives on the value part's own
	// scrollLeft (set by #scrollFieldCaretIntoView), not a side table.
	// The UA-internal shadow trees behind input widgets, by host: the tree
	// IS the field's content model (value text, placeholder, blank / toggle
	// glyph), and the painter reads its computed styles instead of
	// hardcoding the design. This map just caches the part references.
	/**
	 * The TOP LAYER: elements painted above every stacking context, in
	 * insertion order, unclipped -- the foundation dialog/popover/::picker
	 * share. Members are excluded from normal stacking collection.
	 */
	#topLayer = new Set<Element>();

	// Timers that must be torn down in dispose(), or they keep the process
	// alive after the app is done -- which, across a test suite, piles up
	// into a hang.
	#resizeTimer: ReturnType<typeof setTimeout> | null = null;
	// True from the first SIGWINCH of a resize until the re-anchored redraw. While
	// set, render() bails: the terminal has rewrapped the screen and our anchor is
	// momentarily stale, so an auto-render (an animation tick) painting now lands
	// at the wrong rows and scrolls a stray copy into the scrollback. Only the
	// final redraw that handleResize issues is allowed through.
	#resizeInProgress = false;
	// Whether we have taken hold of the terminal: raw mode, signal handlers,
	// the stdin listener and the cursor query. Construction never touches the
	// process -- attach() does, lazily on the first render or explicitly.
	#attached = false;
	// Frame-over-frame state the transform gate compares against.
	#lastFrameScrollTop: number | null = null;
	#lastFrameEpoch = -1;
	// Reactive pseudo-state (:focus, :hover, :active) and document selection
	// change without mutations; repaint-and-diff is what detects them, so
	// every input path bumps this and the clean-frame skip compares it.
	#inputGeneration = 0;
	#lastFrameInputGeneration = -1;
	#lastFrameActiveElement: Element | null = null;
	// Mouse input is tracked separately: it can flip :hover anywhere on the
	// screen, which no damage set can bound. Keyboard input's reactive
	// effects (:focus, :active) name their elements.
	#mouseGeneration = 0;
	#lastFrameMouseGeneration = -1;
	#lastFrameStructuralGeneration = -1;
	#lastFrameSelectionLive = false;

	// Elements this frame's mutations touched, with the layout rect each held
	// BEFORE relayout. Null once the set overflowed; cleared per frame.
	#frameDamage: Map<Element, DOMRect | null> | null = new Map();

	#addFrameDamage(node: Node): void {
		if (!this.#frameDamage) return;
		const element =
			node.nodeType === node.ELEMENT_NODE
				? (node as Element)
				: (node.parentElement ?? null);
		if (!element) {
			this.#frameDamage = null;
			return;
		}
		if (this.#frameDamage.has(element)) return;
		if (this.#frameDamage.size >= 24) {
			this.#frameDamage = null;
			return;
		}
		// The rect BEFORE this frame's relayout: getRect answers from the
		// last computed layout until calculateLayout runs.
		this.#frameDamage.set(
			element,
			(this[kLayoutEngine].getRect(element) as DOMRect | null) ?? null,
		);
	}

	// Bumped on every SIGWINCH. The re-anchor waits on an async cursor query;
	// if another resize lands while it is in flight, the stale response must not
	// trigger a redraw at coordinates that no longer mean anything.
	#resizeEpoch = 0;

	#width: number;
	#height: number;

	// Whether the terminal is currently reporting mouse events to us. See
	// updateMouseReporting for when capture is on.
	#mouseReportingEnabled = false;
	// Scroll chaining yielded the mouse back to the terminal: the camera hit
	// the document top and the user kept scrolling up, so the wheel now
	// belongs to the terminal's own scrollback. Cleared by the next keystroke
	// -- terminals snap to the live screen on input, which is exactly the
	// moment the wheel should become ours again -- or, failing that, by
	// #SCROLL_CHAIN_TIMEOUT_MS of silence (see #scrollChainTimer).
	#mouseCaptureYielded = false;
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
	// re-enable. Tried 1000ms live; it was short enough to hit that toggle
	// and felt like lag. 3000ms tested flawless.
	static readonly #SCROLL_CHAIN_TIMEOUT_MS = 3000;
	#scrollChainTimer: ReturnType<typeof setTimeout> | null = null;
	// Where the last mousedown landed, so a mouseup on the same element
	// becomes a click. (Browsers dispatch click at the nearest common
	// ancestor; the same-element case is the one that matters on a cell grid.)
	#mouseDownTarget: Element | null = null;
	// Where a left-button drag started selecting text, as a caret position --
	// the selection's anchor. The focus end follows the drag; both feed
	// Selection.setBaseAndExtent, which handles backward drags itself.
	#selectionDragAnchor: {node: Text; offset: number} | null = null;
	// The field whose caret the NEXT frame must reveal -- set by edits,
	// consumed inside #renderInteractive after its layout flush. Last
	// edit before the frame wins.
	#pendingCaretReveal:
		| HTMLInputElement
		| HTMLTextAreaElement
		| HTMLSelectElement
		| null = null;
	// A drag that started inside a text field extends the FIELD's own
	// selection (selectionStart/End, bounded to the field) rather than the
	// document selection -- the browser's exact split. The anchor is a
	// value offset; the focus end follows the pointer, clamped into the
	// field.
	#fieldDragAnchor: {
		element: HTMLInputElement | HTMLTextAreaElement;
		offset: number;
	} | null = null;
	// The target and time of the last completed click, to detect a second one
	// close enough behind it to be a dblclick -- browsers' own double-click
	// interval varies by OS/user setting; 500ms is the common default.
	static readonly #DBLCLICK_INTERVAL_MS = 500;
	#lastClickTarget: Element | null = null;
	#lastClickTime = 0;
	#transport: TerminalTransport;

	// The conversation over the transport: the input demultiplexer plus the
	// cursor-position (command start, resize re-anchor) and mode-support (bidi,
	// grapheme clusters) queries whose replies arrive interleaved with typing.
	#session: TerminalSession;

	// The unpatched jsdom window.close, for dispose(): the patched one closes
	// the terminal session, and dispose is what it calls to do that.
	#nativeWindowClose: (() => void) | null = null;

	// A defaulted transport over a piped stdout -- a pipe, a file, a CI log --
	// has no viewport, no cursor, no scrollback and no resize. It cannot
	// interpret cursor movement either, so the interactive frame would write
	// CUP and DECSC sequences straight into the file. An injected transport
	// asserts a terminal exists on the other end.
	#interactive: boolean;

	constructor(options: TermDOMOptions = {}) {
		this.#transport = options.transport ?? transportFromProcess();
		this.#interactive = this.#transport.interactive;

		this.#width = this.#transport.cols;
		this.#height = this.#transport.rows;

		this.#jsdom = new JSDOM(
			"<!DOCTYPE html><html><head></head><body></body></html>",
			{pretendToBeVisual: true},
		);

		this.window = this.#jsdom.window;
		this.document = this.#jsdom.window.document;

		// Setup DOM inspector
		setupInspectMethods(this.window);

		// One bag of getters and callbacks, shared by everything that patches
		// the window below. Built here, before the fields it exposes exist:
		// nothing reads through it until a patched API is actually called.

		this.#installConstructorExtensions();
		this.#renderer = new Renderer(
			this.#height,
			this.#width,
			this.#transport.colorDepth,
		);

		// Setup style management FIRST to override getComputedStyle before LayoutEngine uses it
		this.#styleManager = new StyleManager(this.window);

		// Create layout engine after StyleManager overrides getComputedStyle
		this[kLayoutEngine] = new LayoutEngine(this.#jsdom.window);
		this.#styleManager.setLayoutEngine(this[kLayoutEngine]);
		// A resolved value is a measurement, so it takes the same flush every
		// other geometry read takes -- one door, not two.
		this.#styleManager.setLayoutFlush(() =>
			this.#processPendingMutationsAndRender(),
		);
		this[kLayoutEngine].resize(this.#width, this.#height);
		this.#fullscreenManager = new FullscreenManager((output) => {
			void this.#session.write(output);
		});
		this.#observerManager = new ObserverManager(this[kLayoutEngine]);

		this.#installWindowExtensions();
		this.#installObservers();

		// Initialize scrolling management after window setup

		this[kObserver] = this.#setupMutationObserver();

		this.#uaWidgets = defineUAWidgets({
			window: this.window,
			layoutEngine: this[kLayoutEngine],
			styleManager: this.#styleManager,
			observer: this[kObserver],
		});
		this.#painter = new Painter({
			window: this.window,
			document: this.document,
			layout: this[kLayoutEngine],
			styleManager: this.#styleManager,
			viewport: this.#viewport,
			topLayer: this.#topLayer,
		});
		this.#session = this.#buildSession();

		// A field edit -- text (input/select events) or a checkbox/radio toggle
		// (change) -- announces itself with standard events. The render loop
		// keeps the caret in view and repaints in response to those, rather than
		// each edit path reaching back into it. Capture, so it lands however the
		// event bubbles.
		this.document.addEventListener("input", this.#onFieldEditEvent, true);
		this.document.addEventListener("select", this.#onFieldEditEvent, true);
		this.document.addEventListener("change", this.#onFieldEditEvent, true);

		// Initial processing of all elements is handled by StyleManager's constructor
	}

	/**
	 * Keep a focused field's caret in view and repaint, on the standard
	 * input/select/change events its own edit fires. Scoped to the active
	 * field: an event from elsewhere (a select commit, an author's dispatch on
	 * an unfocused control, a text input's change on blur) must not yank the
	 * camera to it.
	 */
	#onFieldEditEvent = (event: Event): void => {
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
		this.#queueCaretReveal(
			target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
		);
		void this.#render();
	};

	/**
	 * The seam between this instance and the jsdom patches installed over its
	 * window: see DOMPatchHost for why every member is a getter or a callback
	 * rather than a value.
	 */
	#allocateFrameHandle(): number {
		return this.#nextRafId++;
	}

	#sealToScrollback(): void {
		this.#flushDocument();
		this.#sealed = true;
	}

	#installWindowExtensions(): void {
		const termDOM = this;
		const window = termDOM.window;
		const document = window.document;
		Object.defineProperty(window, "innerWidth", {
			value: termDOM.#width,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "innerHeight", {
			value: termDOM.#height,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "outerWidth", {
			value: termDOM.#width,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "outerHeight", {
			value: termDOM.#height,
			writable: false,
			configurable: true,
		});

		// screenTop: readonly like browsers, and LIVE -- cursor detection moves
		// the anchor after this runs. A frozen value here silently shadowed the
		// real one, with only constructor line order deciding which won.
		Object.defineProperty(window, "screenTop", {
			get: () => termDOM.#viewport.screenTop,
			configurable: true,
			enumerable: true,
		});

		// Standard window scrolling, mapped onto the camera: scrollY is how far the
		// camera has moved down the document, scrollBy moves it.
		Object.defineProperty(window, "scrollY", {
			get: () => termDOM.#viewport.scrollTop,
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(window, "pageYOffset", {
			get: () => termDOM.#viewport.scrollTop,
			configurable: true,
			enumerable: true,
		});
		window.scrollBy = ((
			xOrOptions?: number | ScrollToOptions,
			y?: number,
		): void => {
			const dy =
				typeof xOrOptions === "object" && xOrOptions !== null
					? (xOrOptions.top ?? 0)
					: (y ?? 0);
			termDOM.#scrollCamera(dy);
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
				typeof xOrOptions === "object" && xOrOptions !== null
					? (xOrOptions.top ?? termDOM.#viewport.scrollTop)
					: (y ?? 0);
			termDOM.#viewport.scrollTop = Math.max(0, targetY);
			void termDOM.#render();
		};
		window.scrollTo = scrollToCamera as typeof window.scrollTo;
		window.scroll = scrollToCamera as typeof window.scroll;

		for (const root of [document.documentElement, document.body]) {
			Object.defineProperty(root, "scrollTop", {
				get: () => termDOM.#viewport.scrollTop,
				set: (value: number) => {
					termDOM.#viewport.scrollTop = Math.max(0, value);
					void termDOM.#render();
				},
				configurable: true,
				enumerable: true,
			});
		}

		// requestAnimationFrame is the only way to await a painted frame -- render()
		// is private. jsdom's pretendToBeVisual rAF is a bare timer, decoupled from
		// our (async) paint, so a callback could fire before the frame is written.
		// Route it through the render loop: schedule a render and fire the callback
		// once it completes, so "await a frame" always means the frame that includes
		// your pending mutations has landed.
		window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
			const id = termDOM.#allocateFrameHandle();
			termDOM.#frameCallbacks.set(id, cb);
			void termDOM.#render();
			return id;
		}) as typeof window.requestAnimationFrame;
		window.cancelAnimationFrame = ((handle: number): void => {
			termDOM.#frameCallbacks.delete(handle);
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
			let matches = termDOM.#styleManager.mediaQueryMatches(media);
			let onchange: ((ev: Event) => void) | null = null;
			Object.defineProperties(mql, {
				media: {get: () => media, enumerable: true, configurable: true},
				matches: {get: () => matches, enumerable: true, configurable: true},
				onchange: {
					get: () => onchange,
					set: (value: ((ev: Event) => void) | null) => {
						// An event-handler attribute IS a listener, per spec:
						// route it through add/removeEventListener so dispatch
						// order and dedup behave like any other handler.
						if (onchange) mql.removeEventListener("change", onchange);
						onchange = typeof value === "function" ? value : null;
						if (onchange) mql.addEventListener("change", onchange);
					},
					enumerable: true,
					configurable: true,
				},
				// The pre-2020 MediaQueryList API, still what much deployed
				// code calls: plain aliases for the EventTarget pair.
				addListener: {
					value: (cb: ((ev: Event) => void) | null) => {
						if (cb) mql.addEventListener("change", cb);
					},
					configurable: true,
				},
				removeListener: {
					value: (cb: ((ev: Event) => void) | null) => {
						if (cb) mql.removeEventListener("change", cb);
					},
					configurable: true,
				},
			});
			termDOM.#mediaQueryUpdaters.add(() => {
				const now = termDOM.#styleManager.mediaQueryMatches(media);
				if (now === matches) return;
				matches = now;
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
		// action is this call. jsdom's own close still runs inside dispose,
		// through the saved original.
		termDOM.#nativeWindowClose = window.close.bind(window);
		window.close = () => {
			const wasAttached = termDOM.#attached;
			// An immediate close must not tear down mid-establishment: wait
			// for attach to finish (anchor found, first frame painted) so the
			// payout lands where the frame was, not at a stale row 0. Then
			// everything dispose queued must reach the wire before the
			// transport acts on the close (a process transport exits).
			void (async () => {
				if (wasAttached) await termDOM.#attachReady;
				await termDOM.dispose();
				if (wasAttached) termDOM.#transport.close({status: 0});
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
					if (termDOM.#attached && termDOM.#interactive) {
						void termDOM.#session.write(`\x1b]2;${String(value)}\x07`);
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
					if (!termDOM.#attached || !termDOM.#interactive) {
						return Promise.reject(
							new (window as any).DOMException(
								"clipboard requires an attached interactive terminal",
								"NotAllowedError",
							),
						);
					}
					return termDOM.#session.write(
						`\x1b]52;c;${Buffer.from(String(text), "utf8").toString("base64")}\x07`,
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
			// dispose() tears down via jsdom's window.close(), which calls
			// document.close() -- but it has already set attached=false, so we skip
			// the seal there. A real seal is a close() from a live, painted session.
			if (termDOM.#attached && termDOM.#renderCount > 0) {
				termDOM.#sealToScrollback();
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
				return termDOM.#height;
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(document.documentElement, "clientHeight", {
			get() {
				return termDOM.#height;
			},
			configurable: true,
			enumerable: true,
		});
	}

	#installConstructorExtensions(): void {
		const termDOM = this;
		const window = termDOM.window;
		const {Element, Document, Range} = window;
		const document = window.document;

		// getRect()/getRects() (the layout engine's own primitives) are
		// document-relative -- the coordinate space rendering already works in,
		// since the renderer applies the camera offset once at paint time, not
		// per element. But getBoundingClientRect/getClientRects are a *public*
		// API, and CSSOM View defines them relative to the viewport: rect.top
		// for a scrolled-past element should be negative, not the same
		// ever-growing document row regardless of scroll. #toViewportRect is the
		// one place that conversion happens, so both wrappers apply it
		// identically. Internal callers that need the pre-conversion,
		// document-relative rect (scrollIntoView, hit-testing) read
		// getRect()/getRects() directly instead of going through these -- see
		// their definitions.
		// A box inside a position:fixed subtree is laid out in viewport space
		// already -- subtracting the camera would double-convert it. Per spec
		// its client rect is scroll-invariant.
		const inFixedSpace = (element: Element): boolean => {
			for (
				let el: Element | null = element;
				el;
				el = compositionParentElement(el)
			) {
				if (
					termDOM.window.getComputedStyle(el).getPropertyValue("position") ===
					"fixed"
				) {
					return true;
				}
			}
			return false;
		};
		const toViewportRect = (rect: DOMRect, element?: Element): DOMRect =>
			element && inFixedSpace(element)
				? rect
				: termDOM[kLayoutEngine].createDOMRect(
						rect.x,
						rect.y - termDOM.#viewport.scrollTop,
						rect.width,
						rect.height,
					);

		Element.prototype.getBoundingClientRect = function (
			this: Element,
		): DOMRect {
			if (!this.isConnected) {
				return termDOM[kLayoutEngine].createDOMRect(0, 0, 0, 0);
			}

			termDOM.#processPendingMutationsAndRender();

			const rect = termDOM[kLayoutEngine].getRect(this);
			return toViewportRect(
				rect || termDOM[kLayoutEngine].createDOMRect(),
				this,
			);
		};

		Element.prototype.getClientRects = function (): DOMRectList {
			if (!this.isConnected) {
				return termDOM[kLayoutEngine].createDOMRectList();
			}

			termDOM.#processPendingMutationsAndRender();

			const rects = termDOM[kLayoutEngine]
				.getRects(this)
				.map((rect) => toViewportRect(rect, this));
			return termDOM[kLayoutEngine].createDOMRectList(rects);
		};

		// Range geometry. jsdom does no layout, so Range.getClientRects/
		// getBoundingClientRect are absent -- these supply them from the same
		// layout the element wrappers use, viewport-converted identically. The
		// caret and selection painters read the document-relative
		// getRangeRects() directly, the way scrollIntoView reads getRect().
		Range.prototype.getClientRects = function (this: Range): DOMRectList {
			termDOM.#processPendingMutationsAndRender();
			const container = this.startContainer;
			const anchor =
				container.nodeType === container.ELEMENT_NODE
					? (container as Element)
					: (container.parentElement ?? undefined);
			const rects = termDOM[kLayoutEngine]
				.getRangeRects(this)
				.map((rect) => toViewportRect(rect, anchor));
			return termDOM[kLayoutEngine].createDOMRectList(rects);
		};

		Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
			termDOM.#processPendingMutationsAndRender();
			const container = this.startContainer;
			const anchor =
				container.nodeType === container.ELEMENT_NODE
					? (container as Element)
					: (container.parentElement ?? undefined);
			const rects = termDOM[kLayoutEngine].getRangeRects(this);
			if (rects.length === 0) {
				return toViewportRect(termDOM[kLayoutEngine].createDOMRect(), anchor);
			}
			let left = Infinity;
			let top = Infinity;
			let right = -Infinity;
			let bottom = -Infinity;
			for (const rect of rects) {
				left = Math.min(left, rect.x);
				top = Math.min(top, rect.y);
				right = Math.max(right, rect.x + rect.width);
				bottom = Math.max(bottom, rect.y + rect.height);
			}
			return toViewportRect(
				termDOM[kLayoutEngine].createDOMRect(
					left,
					top,
					right - left,
					bottom - top,
				),
				anchor,
			);
		};

		// offsetWidth/offsetHeight/offsetTop/offsetLeft/offsetParent/clientWidth/
		// clientHeight/scrollWidth/scrollHeight -- the most commonly reached-for
		// measurement APIs, and previously entirely unimplemented (always
		// 0/null via jsdom's defaults). Every one of them is derived from
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
			if (!element.isConnected) return null;
			termDOM.#processPendingMutationsAndRender();
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
				const position = window
					.getComputedStyle(ancestor)
					.getPropertyValue("position");
				if (position && position !== "static") {
					return ancestor as HTMLElement;
				}
			}
			return document.body === element ? null : document.body;
		};

		// The content+padding box (border-box rect minus border widths), which
		// both clientWidth/Height and scrollWidth/Height report -- see
		// their definition below for why scroll* is an alias of client* rather
		// than the element's true unclamped content size.
		const contentBoxOf = (
			element: Element,
		): {width: number; height: number} | null => {
			const rect = layoutRectOf(element);
			if (!rect) return null;
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
				if (!rect) return 0;
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
				if (!rect) return 0;
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
		//
		// scroll* is set equal to client* here rather than the element's true
		// unclamped content size, matching the same limitation the paint-extent
		// culling above already documents for the same reason: nothing in the
		// layout engine measures a subtree's natural size separately from
		// whatever box it was actually constrained into. That makes scroll* exact
		// for the common case (auto-sized boxes, no overflow) and an honest
		// under-report for a box with both an explicit size *and* overflowing
		// normal-flow content -- the one case a real browser's scrollWidth/Height
		// would exceed clientWidth/Height.
		for (const prop of ["clientWidth", "scrollWidth"] as const) {
			Object.defineProperty(window.HTMLElement.prototype, prop, {
				get(this: Element) {
					return Math.round(contentBoxOf(this)?.width ?? 0);
				},
				configurable: true,
				enumerable: true,
			});
		}

		for (const prop of ["clientHeight", "scrollHeight"] as const) {
			Object.defineProperty(window.HTMLElement.prototype, prop, {
				get(this: Element) {
					return Math.round(contentBoxOf(this)?.height ?? 0);
				},
				configurable: true,
				enumerable: true,
			});
		}

		// The document-rooted MutationObserver never sees inside a shadow
		// root -- per spec, shadow trees are separate observation scopes. Each
		// author-attached root gets enrolled in the same observer, so shadow
		// mutations invalidate styles/layout and repaint like light ones.
		const originalAttachShadow = Element.prototype.attachShadow;
		Element.prototype.attachShadow = function (
			this: Element,
			init: ShadowRootInit,
		): ShadowRoot {
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
			invalidateStructure();
			termDOM.#styleManager.registerShadowRoot(root);
			// attachShadow is not a DOM mutation -- no observer record will
			// ever fire for it -- but on a CONNECTED host the composed tree
			// just changed wholesale: light children stop rendering the moment
			// the root exists, even while it is still empty. Rebuild the
			// host's composed subtree and repaint.
			if (this.isConnected) {
				termDOM[kLayoutEngine].invalidate(this);
				void termDOM.#render();
			}
			return root;
		};

		Element.prototype.requestFullscreen = function (
			this: Element,
			options?: FullscreenOptions,
		): Promise<void> {
			// Fullscreen writes the alternate-screen switch; attach() is the
			// only consent for that. A browser rejects without a user gesture,
			// and this is the terminal's equivalent precondition.
			if (!termDOM.#attached) {
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
				termDOM.#screenSwitching = true;
				try {
					await termDOM.#renderInFlight;
					await termDOM.#fullscreenManager.requestFullscreen(this, options);
					// The element's UA styles changed (it now fills the
					// viewport) and neither a mutation nor a focus move fired.
					termDOM.#styleManager.handleFocusChange(this);
					termDOM[kLayoutEngine].invalidate(this);
					// The screen under the renderer changed wholesale (the
					// alternate screen starts cleared): drop the diff model or
					// the first fullscreen frame patches against the main
					// screen's content.
					termDOM.#renderer.clearPreviousBuffer();
					termDOM.#updateMouseReporting();
				} finally {
					termDOM.#screenSwitching = false;
				}
				void termDOM.#render();
			})();
		};

		Document.prototype.exitFullscreen = function (
			this: Document,
		): Promise<void> {
			return (async () => {
				const element = termDOM.#fullscreenManager.fullscreenElement;
				termDOM.#screenSwitching = true;
				try {
					await termDOM.#renderInFlight;
					await termDOM.#fullscreenManager.exitFullscreen();
					if (element) {
						termDOM.#styleManager.handleFocusChange(element);
						termDOM[kLayoutEngine].invalidate(element);
					}
					// Same wholesale swap in reverse: the terminal restored the
					// main screen, but the diff model still describes the last
					// ALTERNATE-screen frame -- patching against it garbles the
					// restored document.
					termDOM.#renderer.clearPreviousBuffer();
					termDOM.#updateMouseReporting();
				} finally {
					termDOM.#screenSwitching = false;
				}
				void termDOM.#render();
			})();
		};

		Object.defineProperty(Document.prototype, "fullscreenElement", {
			get: function (this: Document) {
				// Style computation consults this during construction, before
				// the manager field is assigned.
				return termDOM.#fullscreenManager?.fullscreenElement ?? null;
			},
			configurable: true,
		});

		Document.prototype.elementFromPoint = function (
			x: number,
			y: number,
		): Element | null {
			// Per CSSOM View, x/y are viewport-relative -- convert to the
			// document-relative space hit-testing works in, the same conversion
			// getBoundingClientRect's toViewportRect makes in the other direction.
			return termDOM.#findElementAtDocumentPoint(
				x,
				y + termDOM.#viewport.scrollTop,
			);
		};

		// Override focus/blur to dispatch proper events
		const HTMLElement = window.HTMLElement;
		const originalFocus = HTMLElement.prototype.focus;
		const originalBlur = HTMLElement.prototype.blur;

		HTMLElement.prototype.focus = function (this: HTMLElement) {
			const prev = document.activeElement;
			originalFocus.call(this);
			if (prev !== this) {
				// :focus rules match live, but computed styles are cached and
				// focus is not a mutation -- both moved elements must drop
				// their caches, and the repaint must happen even when no
				// listener mutates anything.
				termDOM.#styleManager.handleFocusChange(prev, this);
				void termDOM.#render();
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
			const wasFocused = document.activeElement === this;
			originalBlur.call(this);
			if (wasFocused) {
				termDOM.#styleManager.handleFocusChange(this);
				void termDOM.#render();
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

		// Override scrollIntoView to adjust scroll offset
		HTMLElement.prototype.scrollIntoView = function (
			this: HTMLElement,
			_arg?: boolean | ScrollIntoViewOptions,
		) {
			if (!this.isConnected) return;
			termDOM.#processPendingMutationsAndRender();

			// Document-relative, not getBoundingClientRect's viewport-relative --
			// this compares directly against documentScrollTop below, so it needs
			// the same coordinate space getRect() already provides.
			const rect = termDOM[kLayoutEngine].getRect(this);
			if (!rect) return;

			// The camera shows [documentScrollTop, documentScrollTop + region).
			// Move it the minimal amount that brings the element into it -- the
			// standard block: "nearest" behavior.
			const regionHeight = Math.min(
				termDOM.#height,
				document.body.scrollHeight,
			);
			const top = termDOM.#viewport.scrollTop;
			if (rect.top < top) {
				termDOM.#scrollCamera(rect.top - top);
			} else if (rect.bottom > top + regionHeight) {
				termDOM.#scrollCamera(rect.bottom - (top + regionHeight));
			}
		};
	}

	/**
	 * Apply a batch of mutation records to everything that isn't painting:
	 * pseudo-elements/caches, the layout tree, and the autofocus default
	 * action. In the same order everywhere it's called, since mutations reach
	 * this from two different places -- the observer's own async callback
	 * below, and #processPendingMutationsAndRender/#renderStatic/
	 * #renderInteractive's synchronous `takeRecords()` drain (a geometry read
	 * or a scheduled render needs fresh layout NOW, not whenever the next
	 * microtask checkpoint happens to land) -- and whichever one runs first
	 * empties the queue for the other.
	 */
	#handlePendingMutations(mutations: MutationRecord[]): void {
		// Any observed mutation can move a node in the flat tree; drop the
		// memoized composition links before anything reads through them.
		invalidateComposition();
		// Record damage while the old layout still answers: a banded repaint
		// must cover the target's pre-mutation rows too.
		for (const mutation of mutations) {
			this.#addFrameDamage(mutation.target);
			if (mutation.type === "childList") {
				for (const node of mutation.addedNodes) this.#addFrameDamage(node);
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
			if (record.type !== "attributes" || !record.attributeName) return true;
			const target = record.target as Element;
			return record.oldValue !== target.getAttribute(record.attributeName);
		});
		if (relevant.length === 0) return;
		// Upgrade UA form controls the moment they connect -- before layout reads
		// their shadow and before the painter walks it -- the way a browser
		// upgrades a custom element on connect, not lazily at first paint. (jsdom
		// won't auto-upgrade a plain built-in, so the shell drives it here, the
		// one place every insert -- observer-driven or drained from a synchronous
		// render -- passes through.)
		for (const record of relevant) {
			if (record.type !== "childList") continue;
			for (const added of record.addedNodes) {
				if (added.nodeType !== added.ELEMENT_NODE) continue;
				const element = added as Element;
				if (UPGRADEABLE_CONTROLS.has(element.tagName)) {
					this.#uaWidgets.upgrade(element);
				}
				for (const control of element.querySelectorAll(
					"input, textarea, select",
				)) {
					this.#uaWidgets.upgrade(control);
				}
			}
		}
		this.#styleManager.handleMutations(relevant);
		this[kLayoutEngine].handleMutations(relevant);
		focusAutofocusedNodes(relevant);
	}

	#setupMutationObserver(): MutationObserver {
		const observer = new this.window.MutationObserver((mutations) => {
			this.#handlePendingMutations(mutations);
			this.#render();
		});

		observer.observe(this.document.documentElement, {
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
	#buildSession(): TerminalSession {
		return new TerminalSession({
			transport: this.#transport,
			viewport: this.#viewport,
			layout: this[kLayoutEngine],
			interactive: this.#interactive,
			anchorDetection: this.#transport.sharesScreen,
			handlers: {
				onKeys: (keyInput) => {
					this.#inputGeneration++;
					// A keystroke means the user is back at the live screen
					// (terminals snap to the bottom on input): reclaim the mouse
					// if scroll chaining yielded it.
					if (this.#mouseCaptureYielded) {
						this.#reclaimMouseCapture();
					}
					this.#dispatchGlobalKeyboardEvent(Buffer.from(keyInput));
				},
				onMouse: (button, x, y, release) => {
					this.#inputGeneration++;
					this.#mouseGeneration++;
					this.#handleMouseReport(button, x, y, release);
				},
				onPaste: (text) => {
					this.#inputGeneration++;
					this.#dispatchPaste(text);
				},
				onResize: () => {
					this.#scheduleResize();
				},
				// Ctrl-C's default action is the DOM's own way out: close the
				// window. An app that wants different behavior handles the
				// keydown; this is what happens when nobody does.
				onCloseRequest: () => {
					this.window.close();
				},
				// The terminal went away (hangup, disconnect, process exit):
				// clean up this side. The transport is already closing; there
				// is nothing to close back.
				onClosed: () => {
					this.dispose();
				},
			},
		});
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
	#attachReady: Promise<void> = Promise.resolve();
	// Resolves once attach()'s begin phase has run (session started, cursor
	// detection initialized): a render triggered between attach() and that
	// phase -- a requestAnimationFrame, a mutation -- must not paint an
	// unanchored first frame. The flag keeps steady-state renders fully
	// synchronous: an unconditional await would defer every frame a
	// microtask, and the scrollTop clamp is synchronous by contract.
	#attachBegun: Promise<void> = Promise.resolve();
	#attachBeginning = false;

	attach(transport: TerminalTransport = this.#transport): Promise<void> {
		const rebinding = transport !== this.#transport;
		if (this.#attached) {
			if (rebinding) {
				throw new Error(
					"attach(): cannot re-attach a live TermDOM to a different " +
						"transport; attach once, before the first render.",
				);
			}
			return this.#attachReady;
		}
		if (rebinding) this.#rebindTransport(transport);
		this.#attached = true;

		// Begin once the transport is established (a process tty already is;
		// an SSH wrapper's channel may still be opening), then paint whatever
		// the document holds. The returned promise resolves when that first
		// frame has been written; negotiations are excluded deliberately --
		// their silence timeouts must never hold a first paint hostage.
		this.#attachBeginning = true;
		let begun!: () => void;
		this.#attachBegun = new Promise<void>((resolve) => {
			begun = resolve;
		});
		this.#attachReady = (async () => {
			await this.#transport.ready;
			if (this.#disposed || !this.#attached) {
				this.#attachBeginning = false;
				begun();
				return;
			}

			this.#session.start();
			if (this.#interactive) {
				// Bracketed paste on: pasted text arrives fenced, one insertion.
				void this.#session.write("\x1b[?2004h");
				// Save the terminal's title, so dispose can hand it back; the
				// document.title setter emits the replacement.
				void this.#session.write("\x1b[22;0t");
				if (this.document.title) {
					void this.#session.write(`\x1b]2;${this.document.title}\x07`);
				}
			}
			this.#updateMouseReporting();
			this.#session.initializeCursorDetection();
			void this.#session.negotiateBidi();
			void this.#session.negotiateGraphemeClusters();
			this.#attachBeginning = false;
			begun();

			// Deferred a microtask so the render does not occupy the
			// re-entrancy guard while synchronous code right after attach()
			// still expects its own render calls to drain mutations inline.
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await this.#render();
		})();
		return this.#attachReady;
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
	#rebindTransport(transport: TerminalTransport): void {
		this.#transport = transport;
		this.#interactive = transport.interactive;
		this.#applyTerminalSize(transport.cols, transport.rows);
		this.#renderer = new Renderer(
			this.#height,
			this.#width,
			transport.colorDepth,
		);
		this.#session = this.#buildSession();
	}

	/**
	 * Adopt a new terminal size: update the reported dimensions, re-parse the
	 * stylesheets and re-evaluate media queries against them (a viewport change
	 * can flip any @media answer), and resize the layout. The renderer is left
	 * to the caller -- a resize resizes it in place, a rebind replaces it.
	 */
	#applyTerminalSize(newWidth: number, newHeight: number): void {
		this.#width = newWidth;
		this.#height = newHeight;

		Object.defineProperty(this.window, "innerWidth", {
			value: newWidth,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(this.window, "innerHeight", {
			value: newHeight,
			writable: false,
			configurable: true,
		});

		this.window._terminalSize = {width: newWidth, height: newHeight};

		// The viewport changed, so every @media answer may have: re-parse the
		// stylesheets against the new size (they were parsed against the old one
		// and would stay stale), then let each live MediaQueryList re-evaluate
		// and fire "change" if it flipped.
		this.#styleManager.refreshStylesheets();
		for (const update of this.#mediaQueryUpdaters) update();

		this[kLayoutEngine].resize(newWidth, newHeight);
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
	#updateMouseReporting(): void {
		const wanted =
			this.#attached && this.#interactive && !this.#mouseCaptureYielded;
		if (wanted === this.#mouseReportingEnabled) return;
		this.#mouseReportingEnabled = wanted;
		// 1002: button presses, releases, wheel, and drag motion (no move flood
		// while nothing is pressed). 1006: SGR encoding, the only one that is
		// unambiguous past column 223.
		void this.#session.write(
			wanted ? "\x1b[?1002h\x1b[?1006h" : "\x1b[?1006l\x1b[?1002l",
		);
	}

	/**
	 * End a scroll-chaining yield, from whichever of the two triggers reaches
	 * it first -- a keystroke (the common case) or the fallback timer (see
	 * #scrollChainTimer). Both need the same cleanup, so this is the one place
	 * that does it: clear the pending timer (the other trigger firing later
	 * would be a harmless no-op via #updateMouseReporting's own idempotence,
	 * but there is no reason to let it) and restore mouse capture.
	 */
	#reclaimMouseCapture(): void {
		if (this.#scrollChainTimer !== null) {
			clearTimeout(this.#scrollChainTimer);
			this.#scrollChainTimer = null;
		}
		this.#mouseCaptureYielded = false;
		this.#updateMouseReporting();
	}

	async #render(): Promise<void> {
		// attach() is the ONLY door to the terminal: until the app calls it,
		// mutations keep the DOM and layout live but write nothing. Rendering
		// resumes -- starting with whatever the document holds by then -- the
		// moment attach() runs, which ends by scheduling this render.
		if (!this.#attached) return;

		// A resize is settling: suppress every render until handleResize issues the
		// single re-anchored redraw. See resizeInProgress.
		if (this.#resizeInProgress) {
			return;
		}

		// A screen switch (fullscreen enter/exit) is in progress: no frame
		// may straddle it -- a frame computed for one screen landing on the
		// other paints the wrong geometry onto the wrong buffer.
		if (this.#screenSwitching) {
			return;
		}

		// A render in flight: coalesce, don't drop. Dropping an auto-render (a
		// mutation observer firing mid-frame) leaves the diff renderer's
		// previous-buffer out of step with the screen, which shows up as rows drawn
		// at the wrong place. Instead mark one pending and hand back the running
		// loop's promise: it will fold this caller's changes into a trailing frame,
		// so awaiting render() always means "the caller's changes are painted".
		if (this.#isRendering) {
			this.#renderQueued = true;
			return this.#renderInFlight ?? Promise.resolve();
		}

		this.#isRendering = true;
		this.#renderInFlight = (async () => {
			try {
				do {
					this.#renderQueued = false;
					await this.#renderOnce();
				} while (this.#renderQueued);
				// The frame(s) are written; wake anything awaiting requestAnimationFrame.
				this.#drainFrameCallbacks();
			} finally {
				this.#isRendering = false;
				this.#renderInFlight = null;
			}
		})();
		return this.#renderInFlight;
	}

	#drainFrameCallbacks(): void {
		if (this.#frameCallbacks.size === 0) return;
		const callbacks = [...this.#frameCallbacks.values()];
		this.#frameCallbacks.clear();
		const now = performance.now();
		for (const cb of callbacks) cb(now);
	}

	async #renderOnce(): Promise<void> {
		// An in-flight render loop can outlive dispose() by one queued frame;
		// everything below assumes a live document.
		if (this.#disposed) return;
		if (this.#attachBeginning) {
			await this.#attachBegun;
			if (this.#disposed) return;
		}
		// A frame is the engine reading its own styles: layout and paint decide
		// geometry from computed values, and a resolved (used) value inside a
		// frame would feed layout its own output. Author code cannot run inside
		// this window -- the engine owns the loop until the frame is written.
		beginInternalStyleReads();
		try {
			if (!this.#interactive) {
				await this.#renderStatic();
				return;
			}

			await this.#renderInteractive();
		} finally {
			endInternalStyleReads();
		}
	}

	/**
	 * The paint height of the document: body's scroll height, extended to
	 * cover top-layer boxes -- hoisted under the root, they contribute
	 * nothing to body's own height, and a picker opening at the bottom
	 * edge must still get rows to paint into.
	 */
	#documentPaintHeight(): number {
		let height = this.document.body.scrollHeight;
		for (const element of this.#topLayer) {
			if (!compositionIsConnected(element)) continue;
			const rect = this[kLayoutEngine].getRect(element);
			if (rect) height = Math.max(height, Math.ceil(rect.bottom));
		}
		return height;
	}

	/**
	 * The value offset under a document-space point in a text field --
	 * cell-width aware, clamped to the nearest offset so a drag that
	 * leaves the field still resolves (the browser's capture model:
	 * a selection begun in a field is the field's until release).
	 */
	#fieldOffsetAtPoint(
		element: HTMLInputElement | HTMLTextAreaElement,
		x: number,
		y: number,
	): number | null {
		if (element.tagName === "TEXTAREA") {
			const valueText = fieldValueText(element);
			if (!valueText) return null;
			const lines = this[kLayoutEngine].lineFragments(valueText);
			if (lines.length === 0) return null;
			// The pressed row's line; above the first clamps to it, below
			// the last to that.
			let line = lines[0];
			for (const candidate of lines) {
				if (candidate.y > y) break;
				line = candidate;
			}
			const rel = x - line.x;
			if (rel <= 0) return line.startOffset;
			let cells = 0;
			let offset = 0;
			for (const char of line.text) {
				if (cells >= rel) break;
				cells += stringWidth(char);
				offset += char.length;
			}
			return Math.min(line.startOffset + offset, line.endOffset);
		}

		const input = element as HTMLInputElement;
		const rect = this[kLayoutEngine].getRect(input);
		if (!rect) return null;
		const boxModel = getBoxModel(input);
		const contentX =
			Math.round(rect.left) +
			(boxModel.borderLeftWidth || 0) +
			(boxModel.paddingLeft || 0);
		const value = input.value || "";
		// The click's target cell is its column plus the cells scrolled off the
		// left (the value part's scrollLeft). SHOWN text = a password's bullets.
		const valueText = fieldValueText(input);
		const valueSpan = valueText?.parentElement as HTMLElement | null;
		const shown = valueText?.data ?? value;
		const scrollLeft = valueSpan
			? Math.max(0, Math.round(valueSpan.scrollLeft))
			: 0;
		const targetCell = x - contentX + scrollLeft;
		if (targetCell <= 0) return 0;
		let cells = 0;
		let offset = 0;
		for (const char of shown) {
			if (cells >= targetCell) break;
			cells += stringWidth(char);
			offset += char.length;
		}
		return Math.min(offset, value.length);
	}

	/**
	 * Queue a caret reveal for the next frame. The reveal rides the frame
	 * the edit already scheduled: one camera decision against the layout
	 * that frame flushes anyway, however many keystrokes coalesced into it.
	 * Revealing immediately instead would cost a full synchronous layout
	 * flush per keystroke, before the frame's own -- half the typing latency.
	 */
	#queueCaretReveal(
		element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	): void {
		this.#pendingCaretReveal = element;
	}

	/**
	 * Keep the editing caret inside the camera, the way a browser keeps the
	 * caret of a focused control visible on every EDIT (typing, Enter,
	 * caret travel) -- and only on edits: wheel-scrolling away from a
	 * focused field stays allowed, so the render loop runs this only when
	 * an edit queued it (see #queueCaretReveal). The caret row comes from
	 * fresh layout; single-row widgets reduce to their own row.
	 */
	#scrollCaretIntoView(
		element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	): void {
		this.#processPendingMutationsAndRender();
		const rect = this[kLayoutEngine].getRect(element);
		if (!rect) return;
		let caretY = Math.round(rect.top);
		if (element.tagName === "TEXTAREA") {
			const range = fieldCaretRange(element as HTMLTextAreaElement);
			const [caret] = range ? this[kLayoutEngine].getRangeRects(range) : [];
			if (!caret) return;
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
		const regionHeight = Math.min(
			this.#height,
			this.document.body.scrollHeight,
		);
		const delta = this.#viewport.scrollDeltaToReveal(
			revealTop,
			revealBottom,
			regionHeight,
		);
		if (delta) this.#scrollCamera(delta);
	}

	/**
	 * Keep a single-line input's caret in its box by setting the value part's
	 * scrollLeft (the layout reads it live, no relayout). Measured in cells.
	 */
	#scrollFieldCaretIntoView(input: HTMLInputElement): void {
		const valueText = fieldValueText(input);
		const valueSpan = valueText?.parentElement as HTMLElement | null;
		if (!valueText || !valueSpan) return;
		const rect = this[kLayoutEngine].getRect(input);
		if (!rect) return;
		const boxModel = getBoxModel(input);
		const contentWidth =
			Math.round(rect.width) -
			(boxModel.borderLeftWidth || 0) -
			(boxModel.borderRightWidth || 0) -
			(boxModel.paddingLeft || 0) -
			(boxModel.paddingRight || 0);
		if (contentWidth <= 0) return;

		const shown = valueText.data;
		// Seed from the current scrollLeft so a settled window doesn't jitter.
		const currentScroll = Math.max(0, Math.round(valueSpan.scrollLeft));
		let scrollOffset = 0;
		for (let acc = 0; scrollOffset < shown.length && acc < currentScroll; ) {
			acc += stringWidth(shown[scrollOffset]);
			scrollOffset++;
		}
		// The caret sits at the selection's moving end.
		const start = input.selectionStart ?? shown.length;
		const end = input.selectionEnd ?? shown.length;
		const cursor = input.selectionDirection === "backward" ? start : end;
		// Keep the caret's cell in the box, then pull back when a deletion left slack.
		if (cursor < scrollOffset) scrollOffset = cursor;
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
		if (scrollLeft !== currentScroll) valueSpan.scrollLeft = scrollLeft;
	}

	#processPendingMutationsAndRender(): boolean {
		// A geometry read (getBoundingClientRect, elementFromPoint) needs fresh
		// *layout*, not fresh pixels. A full render() here would make every
		// rect read with pending mutations paint a frame -- an app calling
		// scrollIntoView on each keystroke pays two paints per key, and the
		// rect could still be stale unless the render were awaited. Flushing
		// mutations and laying out synchronously gives an exact rect; painting
		// stays with the caller's own render. The dirty-skip makes this free when
		// nothing changed.
		const pendingMutations = this[kObserver].takeRecords();
		const hadMutations = pendingMutations.length > 0;
		if (hadMutations) {
			this.#handlePendingMutations(pendingMutations);
			// takeRecords() stole these from the observer callback that would
			// have painted them. When the caller's own follow-up (a camera
			// move, an input's render) never comes -- scrollIntoView on an
			// already-visible row is the canonical case -- the mutation would
			// otherwise never reach the screen. Schedule the paint the drain
			// consumed, UNCONDITIONALLY: render() itself queues a trailing
			// frame when one is in flight, and skipping "because a render is
			// running" leaves the screen one interaction behind the DOM when
			// keystrokes arrive faster than frames.
			void this.#render();
		}
		this[kLayoutEngine].calculateLayout();
		return hadMutations;
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
	#scheduleResize(): void {
		// Suppress renders from the very first SIGWINCH, before the debounce
		// settles, so a drag's worth of animation ticks cannot paint at the stale
		// anchor while the terminal is rewrapping under us.
		this.#resizeInProgress = true;
		this.#resizeEpoch++;
		if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
		this.#resizeTimer = setTimeout(() => {
			this.#resizeTimer = null;
			this.#handleResize();
		}, RESIZE_DEBOUNCE_MS);
	}

	#handleResize(): void {
		const newWidth = this.#transport.cols;
		const newHeight = this.#transport.rows;

		this.#applyTerminalSize(newWidth, newHeight);
		this.#renderer.resize(newHeight, newWidth);

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
		this[kLayoutEngine].calculateLayout();
		const contentHeight = this.document.body.scrollHeight;
		const wrappedRowsAbove =
			this.#renderer.wrappedRowsAboveCursorPark(newWidth);
		const epoch = this.#resizeEpoch;

		const redraw = (startRow: number) => {
			// The recovered row is where the frame stands; whether it still
			// FITS below that row at the new height is reserveRows' problem,
			// which solves it the only permissible way -- scrolling earlier
			// output up into the scrollback, never painting over it. Clamping
			// startRow upward to force a fit instead would plant the frame on
			// top of the shell prompt above it.
			this.#viewport.screenTop = startRow;
			this.#viewport.anchorScrollTop = -this.#viewport.screenTop;
			this.#renderer.resetScreen(startRow);

			// Everything suppressed since the first SIGWINCH may paint again. The
			// frame is placed by the screen reset, not by cursor detection.
			this.#resizeInProgress = false;
			const wasDetected = this.#session.hasDetectedCommandStart;
			this.#session.hasDetectedCommandStart = false;
			this.#render().then(() => {
				this.#session.hasDetectedCommandStart = wasDetected;
			});
		};

		const computedReanchor = () => {
			const previousStart = this.#viewport.screenTop;
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
				this.#renderer.clearScreen();
				redraw(0);
			}
		};

		if (this.#session.anchorDetectionEnabled && wrappedRowsAbove !== null) {
			this.#session
				.queryCursorRow()
				.then((cursorRow) => {
					// A newer resize superseded this one; its handler will redraw.
					if (epoch !== this.#resizeEpoch) return;
					place(Math.max(0, cursorRow - wrappedRowsAbove));
				})
				.catch(() => {
					if (epoch !== this.#resizeEpoch) return;
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
	#afterRender(): void {
		this.#renderCount++;
		// The viewport in document coordinates: the scroll offset, one terminal
		// high. IntersectionObserver measures targets against it.
		const viewport = this[kLayoutEngine].createDOMRect(
			0,
			this.#viewport.scrollTop,
			this.#width,
			this.#height,
		);
		this.#observerManager.flush(viewport, this.#renderCount);
	}

	/** Install the observer constructors on the window, bound to this instance. */
	#installObservers(): void {
		const manager = this.#observerManager;
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

	/**
	 * Focus the next or previous focusable element
	 */
	#moveFocus(reverse: boolean): void {
		const focusable = getFocusableElements(
			this.document,
			this.window,
			this[kLayoutEngine],
		);
		if (focusable.length === 0) return;

		const current = this.document.activeElement;
		const currentIndex = focusable.indexOf(current as Element);
		let nextIndex: number;

		if (reverse) {
			nextIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
		} else {
			nextIndex = currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1;
		}

		(focusable[nextIndex] as HTMLElement).focus();

		// Focus is not a DOM mutation, so no observer will schedule a frame -- but
		// :focus styling and the caret (the real terminal cursor, parked in the
		// focused field) both need one to move.
		void this.#render();
	}

	/**
	 * Hit-test a document-relative point (flushing pending layout first). The
	 * one place both document.elementFromPoint (which converts its public,
	 * viewport-relative x/y into this space) and mouse hit-testing (whose
	 * points are already document-relative, from #screenToDocumentPoint) go
	 * through, so a click always tests against fresh layout regardless of
	 * entry point.
	 */
	#findElementAtDocumentPoint(x: number, y: number): Element | null {
		this.#processPendingMutationsAndRender();
		let element = this[kLayoutEngine].hitTest(
			this.document.documentElement,
			x,
			y,
			this.#topLayer,
			this.#viewport.scrollTop,
		);
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
		return element;
	}

	/**
	 * Resolve a document-relative point to a caret position -- (text node,
	 * code-unit offset into node.data) -- the way a browser's
	 * caretPositionFromPoint does. Hit-tests the element, then scans its text
	 * nodes' painted fragments for the one on the point's row; the x offset
	 * becomes a visual character index (cell-width aware), and
	 * visualToDataOffsets bridges that back to a Range-valid data offset.
	 * Landing past a fragment's last character on its row means "after the
	 * last character", so a drag can select through end-of-line. Returns null
	 * over rows with no text (and over inputs, whose value is not document
	 * text -- their selection is the input's own selectionStart/End world).
	 */
	#documentPointToTextPosition(
		x: number,
		y: number,
	): {node: Text; offset: number} | null {
		const element = this.#findElementAtDocumentPoint(x, y);
		if (
			!element ||
			element instanceof (this.window as any).HTMLInputElement ||
			element instanceof (this.window as any).HTMLTextAreaElement
		) {
			return null;
		}

		let best: {node: Text; offset: number; distance: number} | null = null;
		const visit = (node: Node): void => {
			for (const child of Array.from(node.childNodes)) {
				if (child.nodeType === child.TEXT_NODE) {
					const textNode = child as Text;
					const fragments = this[kLayoutEngine].getRectTexts(textNode);
					if (fragments.length === 0) continue;
					const visToData = visualToDataOffsets(textNode.data, fragments);
					let visualBase = 0;
					for (const fragment of fragments) {
						const rect = fragment.rect;
						if (y >= rect.y && y < rect.y + Math.max(1, rect.height)) {
							// Walk cells to the visual index under (or past) x.
							let cellX = rect.x;
							let index = 0;
							while (index < fragment.text.length && cellX < x) {
								const w = stringWidth(fragment.text[index]);
								if (cellX + w > x) break;
								cellX += w;
								index++;
							}
							const distance =
								x < rect.x
									? rect.x - x
									: x >= cellX && index === fragment.text.length
										? x - cellX
										: 0;
							if (!best || distance < best.distance) {
								const visual = visualBase + index;
								const offset =
									visual < visToData.length
										? visToData[visual]
										: textNode.data.length;
								best = {node: textNode, offset, distance};
							}
						}
						visualBase += fragment.text.length;
					}
				} else if (child.nodeType === child.ELEMENT_NODE) {
					visit(child);
				}
			}
		};
		visit(element);
		return best
			? {node: (best as any).node, offset: (best as any).offset}
			: null;
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
	#handleMouseReport(
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

		const point = this.#viewport.screenToDocumentPoint(
			col - 1,
			row - 1,
			this.#fullscreenManager.isFullscreen,
		);
		const x = point?.x ?? col - 1;
		const y = point?.y ?? 0;
		// Already document-relative -- go straight to the shared hit-test rather
		// than through the public elementFromPoint, which expects viewport-
		// relative input and would convert it right back.
		const target =
			(point && this.#findElementAtDocumentPoint(x, y)) || this.document.body;

		if (wheelDeltaY !== null) {
			const notCanceled = target.dispatchEvent(
				new this.window.WheelEvent("wheel", {
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
				if (
					wheelDeltaY < 0 &&
					this.#viewport.scrollTop === 0 &&
					!this.#fullscreenManager.isFullscreen
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
					this.#mouseCaptureYielded = true;
					this.#updateMouseReporting();
					if (this.#scrollChainTimer !== null) {
						clearTimeout(this.#scrollChainTimer);
					}
					this.#scrollChainTimer = setTimeout(() => {
						this.#scrollChainTimer = null;
						this.#reclaimMouseCapture();
					}, TermDOM.#SCROLL_CHAIN_TIMEOUT_MS);
				} else {
					this.#scrollCamera(wheelDeltaY);
				}
			}
			return;
		}

		// Buttons: 0/1/2 = left/middle/right. 3 is "no button" in the legacy
		// encoding; SGR names the button even on release, so 3 carries nothing.
		if (base > 2) return;
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
			target.dispatchEvent(new this.window.MouseEvent("mousemove", eventInit));
			// A field drag extends the field's own selection to the offset
			// under the pointer -- clamped into the field, whichever element
			// the pointer is over now (the field holds the capture).
			if (this.#fieldDragAnchor && point) {
				const {element: fieldElement, offset: anchor} = this.#fieldDragAnchor;
				const focus = this.#fieldOffsetAtPoint(fieldElement, x, y);
				if (focus !== null && focus !== undefined) {
					fieldElement.setSelectionRange(
						Math.min(anchor, focus),
						Math.max(anchor, focus),
						focus < anchor ? "backward" : "forward",
					);
					this.#render();
				}
				return;
			}
			// Dragging with the anchor set extends the document selection to
			// the caret position under the pointer. setBaseAndExtent handles a
			// backward drag itself; over a textless stretch the focus simply
			// stays where it last was.
			if (this.#selectionDragAnchor && this.#mouseDownTarget && point) {
				const focus = this.#documentPointToTextPosition(x, y);
				if (focus) {
					const anchor = this.#selectionDragAnchor;
					this.window
						.getSelection()
						?.setBaseAndExtent(
							anchor.node,
							anchor.offset,
							focus.node,
							focus.offset,
						);
					this.#render();
				}
			}
			return;
		}

		if (!isRelease) {
			this.#mouseDownTarget = target;
			this.#fieldDragAnchor = null;
			// A pointer press suppresses the :focus-visible ring.
			if (this.#styleManager.setFocusVisible(false)) {
				this.#styleManager.handleFocusChange(this.document.activeElement);
				void this.#render();
			}
			const notCanceled = target.dispatchEvent(
				new this.window.MouseEvent("mousedown", eventInit),
			);
			// Default action: mousedown moves focus, exactly as in a browser --
			// to the nearest focusable ancestor, or away from the active element
			// when the click lands on nothing focusable.
			if (notCanceled) {
				const focusable = (target as Element).closest?.(FOCUSABLE_SELECTOR);
				const active = this.document.activeElement;
				if (focusable && focusable !== active) {
					(focusable as HTMLElement).focus();
					void this.#render();
				} else if (!focusable && active && active !== this.document.body) {
					(active as HTMLElement).blur();
					void this.#render();
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
					base === 0 &&
					point &&
					(target instanceof (this.window as any).HTMLTextAreaElement ||
						(target instanceof (this.window as any).HTMLInputElement &&
							(target as HTMLInputElement).type !== "checkbox" &&
							(target as HTMLInputElement).type !== "radio"))
						? (target as HTMLInputElement | HTMLTextAreaElement)
						: null;
				if (field) {
					const offset = this.#fieldOffsetAtPoint(field, x, y);
					if (offset !== null) {
						field.setSelectionRange(offset, offset);
						this.#fieldDragAnchor = {element: field, offset};
						// The DOCUMENT selection still clears on entry -- a page
						// selection doesn't stay highlighted behind a field click
						// in a browser either. The two worlds just never merge:
						// getSelection() cannot see inside the field, per spec.
						const docSelection = this.window.getSelection();
						if (docSelection && !docSelection.isCollapsed) {
							docSelection.removeAllRanges();
						}
						this.#render();
					}
				}

				// Default action: mousedown collapses the document selection at
				// the pressed caret position and anchors a possible drag there,
				// as in a browser. Left button only -- and preventDefault on
				// mousedown suppresses it, which is exactly how apps that want
				// the drag events for themselves opt out.
				const selection = this.window.getSelection();
				if (base === 0 && selection && !this.#fieldDragAnchor) {
					const anchor = point ? this.#documentPointToTextPosition(x, y) : null;
					const hadSelection = !selection.isCollapsed;
					this.#selectionDragAnchor = anchor;
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
						this.#render();
					}
				}
			}
			return;
		}

		target.dispatchEvent(new this.window.MouseEvent("mouseup", eventInit));
		// A selection is only a selection: writing the clipboard is a
		// deliberate act, through navigator.clipboard. The terminal's own
		// select-to-copy remains available as Shift+drag, which bypasses
		// mouse reporting.
		let selectedByDrag = false;
		if (this.#fieldDragAnchor) {
			this.#fieldDragAnchor = null;
		}
		if (this.#selectionDragAnchor) {
			this.#selectionDragAnchor = null;
			const text = this.window.getSelection()?.toString() ?? "";
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
			this.#mouseDownTarget = null;
			return;
		}
		if (this.#mouseDownTarget === target) {
			target.dispatchEvent(
				new this.window.MouseEvent("click", {...eventInit, buttons: 0}),
			);
			// A checkbox/radio's .checked already flipped -- jsdom's own click
			// activation behavior handles that directly, and forwards it from a
			// <label for> or wrapping label the same way (honoring
			// preventDefault in both cases) -- but that's a property change,
			// invisible to the MutationObserver that would otherwise repaint it,
			// same as .value on a text input. Focus also needs an explicit push
			// here for the label case: a real browser's "focusing steps" move
			// focus to the label's associated control, which jsdom's dispatch
			// alone does not simulate (the direct-click case is already
			// focused via mousedown's own default action above, so this is a
			// harmless no-op there).
			const isCheckable = (el: unknown): el is HTMLInputElement =>
				el instanceof (this.window as any).HTMLInputElement &&
				((el as HTMLInputElement).type === "checkbox" ||
					(el as HTMLInputElement).type === "radio");
			const control = isCheckable(target)
				? target
				: target instanceof (this.window as any).HTMLLabelElement &&
					  isCheckable((target as any).control)
					? ((target as any).control as HTMLInputElement)
					: null;
			if (control) {
				control.focus();
				this.#render();
			}

			// A second click on the same target within the double-click interval
			// is also a dblclick -- in addition to, not instead of, its own click
			// (a browser fires both). Reset after firing so a third quick click
			// starts a fresh pair rather than double-firing again immediately.
			const now = performance.now();
			if (
				this.#lastClickTarget === target &&
				now - this.#lastClickTime <= TermDOM.#DBLCLICK_INTERVAL_MS
			) {
				target.dispatchEvent(
					new this.window.MouseEvent("dblclick", {...eventInit, buttons: 0}),
				);
				this.#lastClickTarget = null;
				this.#lastClickTime = 0;
			} else {
				this.#lastClickTarget = target as Element;
				this.#lastClickTime = now;
			}
		}
		this.#mouseDownTarget = null;
	}

	/**
	 * Deliver a paste to the focused control as an `insertFromPaste` beforeinput;
	 * its own listener does the edit. Dropped if nothing editable is focused.
	 */
	#dispatchPaste(text: string): void {
		const target = this.document.activeElement;
		if (!target || target === this.document.body) return;
		target.dispatchEvent(
			new this.window.InputEvent("beforeinput", {
				inputType: "insertFromPaste",
				data: text,
				bubbles: true,
				cancelable: true,
			}),
		);
		void this.#render();
	}

	#dispatchGlobalKeyboardEvent(chunk: Buffer): void {
		const key = chunk.toString("utf8");

		// Tokenize multi-key chunks and dispatch each token on its own.
		const tokens = Array.from(tokenizeInput(key));
		if (tokens.length > 1) {
			for (const token of tokens) {
				this.#dispatchGlobalKeyboardEvent(Buffer.from(token));
			}
			return;
		}

		// A cursor position report with no query outstanding is a late or
		// duplicate terminal reply, not a keystroke: decodeKey returns null and
		// nothing is dispatched.
		const stroke = decodeKey(key);
		if (!stroke) return;
		const {keyName, keyCode, charCode, shiftKey, ctrlKey, altKey, metaKey} =
			stroke;

		// Keyboard input warrants the :focus-visible ring; repaint if it flipped.
		if (this.#styleManager.setFocusVisible(true)) {
			this.#styleManager.handleFocusChange(this.document.activeElement);
			void this.#render();
		}

		// Find the focused element. document.activeElement defaults to body when
		// nothing is focused, so it can't be used with `||` to detect "nothing
		// focused". In fullscreen, a browser moves focus to the fullscreen
		// element as part of entering it -- but jsdom's own focus() only takes
		// elements that are already focusable (tabindex, form controls, etc.),
		// so an arbitrary fullscreen container is otherwise unreachable here.
		// Fall back to it (before document.body) so keydown still lands on it,
		// the same as the dedicated fullscreen dispatch this replaced -- but
		// still prefer an explicitly focused descendant (e.g. an input inside
		// the fullscreen element), which the old dispatch ignored.
		const active = this.document.activeElement;
		const targetElement =
			active && active !== this.document.body
				? active
				: this.#fullscreenManager.fullscreenElement || this.document.body;

		// Escape exits fullscreen unconditionally -- not dispatched to the DOM at
		// all, the same as a real browser: fullscreen exit is a user-agent
		// guarantee an app can't trap the user past with preventDefault.
		if (keyName === "Escape" && this.#fullscreenManager.isFullscreen) {
			this.#fullscreenManager.exitFullscreen().catch(() => {});
			return;
		}

		// Create and dispatch keydown event
		const keydownEvent = new this.window.KeyboardEvent("keydown", {
			key: keyName,
			code: domCodeFor(keyName),
			keyCode: keyCode,
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

		// Handle default actions if keydown wasn't canceled
		if (notCanceled) {
			// Tab navigation
			if (keyName === "Tab") {
				this.#moveFocus(shiftKey);
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
					this.#render();
				}
			}
			// A select's editing (open/navigate/commit) is the select widget's
			// own keydown listener, run during dispatch above -- not here.
		}

		// If keydown wasn't canceled and it's a printable character, dispatch keypress
		if (notCanceled && key.length === 1 && charCode >= 32 && charCode < 127) {
			const keypressEvent = new this.window.KeyboardEvent("keypress", {
				key: key,
				code: domCodeFor(key),
				keyCode: charCode,
				charCode: charCode,
				which: charCode,
				ctrlKey,
				shiftKey,
				altKey,
				metaKey,
				bubbles: true,
				cancelable: true,
			});
			targetElement.dispatchEvent(keypressEvent);
		}

		// Always dispatch keyup
		const keyupEvent = new this.window.KeyboardEvent("keyup", {
			key: keyName,
			code: domCodeFor(keyName),
			keyCode: keyCode,
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
	async #renderStatic(): Promise<void> {
		const pending = this[kObserver].takeRecords();
		if (pending.length > 0) {
			this.#handlePendingMutations(pending);
		}

		this[kLayoutEngine].calculateLayout();

		const output = this.#renderer.renderStatic(
			this.document.body.scrollHeight,
			(ctx) => {
				this.#painter.paint(ctx);
			},
		);

		if (output) await this.#write(output);
		this.#afterRender();
	}

	/**
	 * Scroll the command start upward when the content outgrows the room below it.
	 *
	 * A TermDOM app behaves like an ordinary command: its output begins wherever
	 * the cursor was and flows down, and when it runs past the bottom of the
	 * terminal the earlier rows scroll off into the terminal's own scrollback.
	 * Emitting the newlines to make that happen is what keeps the output *in* the
	 * scrollback -- searchable, selectable, copy-pasteable -- rather than trapped
	 * in an alternate screen buffer.
	 *
	 * Without this, content past the bottom of the terminal is never drawn at
	 * all.
	 */
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
	#flushDocument(): void {
		if (!this.#interactive) return;

		const top = this.#viewport.screenTop;
		const output = this[kRenderStatic]("\r\n");
		if (!output) return;

		// Back to the top of our region; every payout line then clears ITSELF
		// (\x1b[K before its text) and one partial erase covers whatever the
		// old frame held below. Never a full ED from the top row: tmux
		// preserves a fully-erased screen by pushing it into scrollback (the
		// courtesy it extends to `clear`), which archived a copy of the final
		// frame above the payout -- the document twice, interleaved.
		void this.#session.write(`\x1b[${top + 1};1H`);
		void this.#session.write(
			"\x1b[K" + output.replace(/\r\n(?!$)/g, "\r\n\x1b[K"),
		);
		void this.#session.write("\x1b[J");
	}

	/**
	 * The document as an ANSI string: colors and line breaks, no cursor
	 * controls, no modes. Feeds the quit payout (CRLF: raw mode does not
	 * translate bare newlines) and the scratch sibling behind renderANSI();
	 * not part of the class's public surface.
	 */
	[kRenderStatic](lineEnding: "\n" | "\r\n"): string {
		this.#processPendingMutationsAndRender();
		const contentHeight = this.document.body.scrollHeight;
		if (contentHeight === 0) return "";
		return this.#renderer.renderStatic(
			contentHeight,
			(ctx) => {
				this.#painter.paint(ctx);
			},
			lineEnding,
		);
	}

	/** Write to the transport and wait for it to be flushed. */
	#write(output: string): Promise<void> {
		return this.#session.write(output);
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
	async #renderInteractive(): Promise<void> {
		// The previous document was sealed to scrollback by close(). Start a fresh
		// one below it: re-anchor to where the cursor now sits and reset the diff so
		// nothing composites over the frozen block.
		if (this.#sealed) {
			this.#sealed = false;
			this.#viewport.scrollTop = 0;
			this.#renderer.clearPreviousBuffer();
			// detectCommandStart waits for a reply on stdin, so the listener must
			// be attached first (idempotent -- normally already done by now).
			if (this.#interactive) {
				this.attach();
				await this.#session.detectCommandStart();
			}
		}

		// Our region starts at the command-start row, which cursor detection resolves
		// asynchronously. Render before it lands and the first frame anchors at row 0
		// while every diff after detection anchors one row lower -- the labels stay,
		// the values slide down a row. Wait for the anchor to settle first, exactly
		// as the flow path does. Await only when one is pending: an unconditional
		// await would defer the rest of this frame a microtask even with nothing
		// to wait for, and a downstream synchronous scroll clamp depends on it.
		const detectionPending = this.#session.cursorDetectionPending;
		if (detectionPending) await detectionPending;

		const pending = this[kObserver].takeRecords();
		if (pending.length > 0) {
			this.#handlePendingMutations(pending);
		}

		this[kLayoutEngine].calculateLayout();

		// The caret reveal an edit queued runs here, against the layout this
		// frame just flushed -- one camera decision per frame, however many
		// keystrokes coalesced into it. Skipped if focus has already moved
		// on: revealing a field the user left would yank the camera back.
		const revealed = this.#pendingCaretReveal !== null;
		if (this.#pendingCaretReveal) {
			const reveal = this.#pendingCaretReveal;
			this.#pendingCaretReveal = null;
			if (reveal === this.document.activeElement) {
				this.#scrollCaretIntoView(reveal);
			}
		}

		// Nothing observable moved: no mutations, no invalidation, no input,
		// same focus, no live selection, camera unmoved, no reveal, no pending
		// reset. Painting would emit nothing; don't pay to discover that.
		const selection = this.window.getSelection?.();
		if (
			pending.length === 0 &&
			!revealed &&
			this.#lastFrameScrollTop !== null &&
			this.#viewport.scrollTop === this.#lastFrameScrollTop &&
			currentCompositionEpoch() === this.#lastFrameEpoch &&
			this.#inputGeneration === this.#lastFrameInputGeneration &&
			this.document.activeElement === this.#lastFrameActiveElement &&
			(!selection || selection.rangeCount === 0 || selection.isCollapsed) &&
			!this.#renderer.needsRepaint
		) {
			// Skip the paint, not the frame: observers still run, so a fresh
			// observe() gets its initial entry on the next tick.
			this.#afterRender();
			return;
		}

		// Recompute the focused input's scroll window every frame (derived state).
		const activeField = this.document.activeElement;
		if (
			activeField instanceof (this.window as any).HTMLInputElement &&
			isTextInputType((activeField as HTMLInputElement).type)
		) {
			this.#scrollFieldCaretIntoView(activeField as HTMLInputElement);
		}

		// Fullscreen owns the WHOLE alternate screen from row zero: the
		// main screen's command anchor means nothing there, and reserveRows'
		// index-scrolls would scroll the alternate screen itself. The
		// document's scroll position survives untouched underneath -- the
		// fixed, Canvas-backed fullscreen element covers it regardless.
		const isFullscreen = this.#fullscreenManager.isFullscreen;
		const contentHeight = isFullscreen
			? this.#height
			: this.#documentPaintHeight();
		const regionHeight = Math.min(contentHeight, this.#height);

		// Take the room we need by pushing earlier output up, never over it.
		const top = isFullscreen ? 0 : this.#reserveRows(regionHeight);

		if (!isFullscreen) {
			// The camera cannot run off the end of the document.
			const maxScroll = Math.max(0, contentHeight - regionHeight);
			this.#viewport.scrollTop = Math.min(this.#viewport.scrollTop, maxScroll);
		}

		// A frame is a TRANSFORM when everything that changed since the last
		// one is bounded: a camera delta (the terminal scrolls the region via
		// DECSTBM + DL/IL) plus damage that names its elements. Only the
		// exposed band, fixed rows (real and shifted positions), the focused
		// field, and damaged rows repaint. Anything unbounded -- a structural
		// event, mouse input (:hover can flip anywhere), a live selection, a
		// drag, a geometry change (cascades) -- takes the full diff.
		let scroll: {delta: number; bands: Array<[number, number]>} | undefined;
		const scrollTop = this.#viewport.scrollTop;
		const styleDamage = this.#styleManager.drainStyleDamage();
		const frameDamage = this.#frameDamage;
		this.#frameDamage = new Map();
		const documentSelection = this.window.getSelection?.();
		const liveSelection = Boolean(
			documentSelection &&
				documentSelection.rangeCount > 0 &&
				!documentSelection.isCollapsed,
		);
		transform: if (
			!isFullscreen &&
			top === 0 &&
			regionHeight === this.#height &&
			this.#lastFrameScrollTop !== null &&
			currentStructuralGeneration() === this.#lastFrameStructuralGeneration &&
			this.#mouseGeneration === this.#lastFrameMouseGeneration &&
			!liveSelection &&
			!this.#lastFrameSelectionLive &&
			this.#selectionDragAnchor === null &&
			this.#fieldDragAnchor === null &&
			!this.#resizeInProgress &&
			frameDamage !== null &&
			styleDamage !== null
		) {
			const delta = scrollTop - this.#lastFrameScrollTop;
			if (Math.abs(delta) >= regionHeight) break transform;
			if (delta === 0 && frameDamage.size === 0 && styleDamage.size === 0) {
				break transform;
			}

			const bands: Array<[number, number]> = [];
			const addBand = (start: number, end: number): void => {
				const clampedStart = Math.max(0, Math.floor(start));
				const clampedEnd = Math.min(regionHeight, Math.ceil(end));
				if (clampedEnd > clampedStart) bands.push([clampedStart, clampedEnd]);
			};

			if (delta > 0) addBand(regionHeight - delta, regionHeight);
			else if (delta < 0) addBand(0, -delta);
			for (const band of this[kLayoutEngine].fixedRowBands(this.#height)) {
				addBand(band[0], band[1]);
				// The scroll moved fixed content too, leaving a stale copy at
				// the shifted position; model and screen agree on it, so only
				// a repaint of that row corrects it.
				if (delta !== 0) addBand(band[0] - delta, band[1] - delta);
			}
			// The focused field's rows repaint: its caret cell and the real
			// cursor park come from the painter visiting it.
			const active = this.document.activeElement;
			if (active && UPGRADEABLE_CONTROLS.has(active.tagName)) {
				const rect = this[kLayoutEngine].getRect(active);
				if (rect) {
					addBand(rect.top - scrollTop, rect.top + rect.height - scrollTop);
				}
			}

			// A focus move flips :focus/:focus-visible on both elements.
			const damaged = new Set<Element>(frameDamage.keys());
			for (const element of styleDamage) damaged.add(element);
			if (active !== this.#lastFrameActiveElement) {
				if (active) damaged.add(active);
				if (this.#lastFrameActiveElement) {
					damaged.add(this.#lastFrameActiveElement);
				}
			}

			for (const element of damaged) {
				// Damage reaches as far as the selector invalidation scope; the
				// whole document is unbounded.
				const scope = this.#styleManager.invalidationScopeFor(element);
				if (
					scope === this.document.body ||
					scope === this.document.documentElement
				) {
					break transform;
				}
				const before = frameDamage.get(element) ?? frameDamage.get(scope);
				const after = this[kLayoutEngine].getRect(scope);
				if (!after && !before) {
					// An inline element has no box of its own, so its rows are
					// not recoverable here: unbounded. A removed element's
					// damage is its parent's, already recorded.
					if (scope.isConnected) break transform;
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
				const fixedSpace = this[kLayoutEngine].isInFixedSpace(scope);
				if (after) {
					const afterTop = fixedSpace ? after.top : after.top - scrollTop;
					addBand(afterTop, afterTop + after.height);
					// The shifted stale copy of the damaged rows, as for fixed.
					if (delta !== 0) {
						addBand(afterTop - delta, afterTop + after.height - delta);
					}
				}
				if (before) {
					const beforeTop = fixedSpace
						? before.top
						: before.top - this.#lastFrameScrollTop;
					addBand(beforeTop - delta, beforeTop + before.height - delta);
				}
			}

			// Past most of the region the transform stops paying.
			let coverage = 0;
			for (const [start, end] of bands) coverage += end - start;
			if (delta === 0 && bands.length === 0) break transform;
			if (coverage > regionHeight * 0.75) break transform;

			scroll = {delta, bands};
		}

		const ansi = this.#renderer.renderFrame(
			-this.#viewport.scrollTop,
			(ctx) => {
				this.#painter.paint(ctx);
			},
			top,
			top + regionHeight,
			scroll,
		);
		this.#lastFrameScrollTop = scrollTop;
		this.#lastFrameEpoch = currentCompositionEpoch();
		this.#lastFrameInputGeneration = this.#inputGeneration;
		this.#lastFrameMouseGeneration = this.#mouseGeneration;
		this.#lastFrameStructuralGeneration = currentStructuralGeneration();
		this.#lastFrameSelectionLive = liveSelection;
		this.#lastFrameActiveElement = this.document.activeElement;

		if (ansi) await this.#write(ansi);
		this.#afterRender();
	}

	/** Move the camera over the document. */
	#scrollCamera(rows: number): void {
		this.#viewport.scrollBy(rows);
		// A camera move is invisible to the MutationObserver; schedule the frame
		// it needs, the same way a DOM mutation would.
		void this.#render();
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
	#reserveRows(rows: number): number {
		const push = this.#viewport.reserveRows(rows, this.#height);
		if (push > 0) {
			void this.#session.write(
				`\x1b[${this.#height};1H` + "\x1bD".repeat(push),
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
			this.#renderer.shiftScreenReset(push);
		}

		return this.#viewport.screenTop;
	}

	// The scratch engine behind renderANSI/print: created on first use,
	// sized from the transport, recreated if the width changes, reused
	// across calls.
	#staticSibling: TermDOM | null = null;

	#staticRenderer(): TermDOM {
		const cols = this.#transport.cols;
		if (this.#staticSibling && this.#staticSibling.#width !== cols) {
			void this.#staticSibling.dispose();
			this.#staticSibling = null;
		}
		this.#staticSibling ??= new TermDOM({
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
		return this.#staticSibling;
	}

	/**
	 * Render an HTML string to an ANSI string at the transport's width:
	 * colors and line breaks, no cursor controls, no modes. <style> elements
	 * in the fragment join the cascade. The instance's document is untouched.
	 */
	renderANSI(html: string): string {
		return this.#renderStaticHTML(html, "\n");
	}

	#renderStaticHTML(html: string, lineEnding: "\n" | "\r\n"): string {
		const renderer = this.#staticRenderer();
		renderer.document.body.innerHTML = html;
		return renderer[kRenderStatic](lineEnding);
	}

	/**
	 * renderANSI(html) written through the transport as ordinary command
	 * output; resolves when the bytes have reached it. CRLF while a raw-mode
	 * session holds the terminal, since raw mode does not translate newlines.
	 */
	print(html: string): Promise<void> {
		const output = this.#renderStaticHTML(
			html,
			this.#attached && this.#interactive ? "\r\n" : "\n",
		);
		if (!output) return Promise.resolve();
		return this.#session.write(output);
	}

	/** Explicit resource management: `using dom = new TermDOM()` tears down on scope exit. */
	[Symbol.dispose](): void {
		this.dispose();
	}

	#disposed = false;

	/**
	 * Tear down and hand the terminal back. Resolves when every queued
	 * restore has reached the transport; await it before writing further
	 * output or exiting with a status code. The process transport restores
	 * shell-critical modes synchronously besides, so exiting without
	 * awaiting still leaves the shell usable.
	 */
	dispose(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#disposed = true;

		// A TermDOM that never attached owes the terminal nothing: no final
		// flush, no mode restores -- there is no session to close.
		const wasAttached = this.#attached;
		this.#attached = false;

		// Document mode has been painting a window in place, so nothing it
		// showed has reached the terminal's scrollback. Pay it all out now --
		// but only if a frame was ever painted: with none, there is nothing
		// of ours on screen, and the payout's cursor moves and erases would
		// land on someone else's rows.
		if (wasAttached && this.#renderCount > 0) this.#flushDocument();

		// Frames keep the terminal cursor hidden (it is parked for resize
		// bookkeeping, not UI); hand it back visible on the way out. The mouse
		// goes back to the terminal the same way, and the title we replaced
		// pops back to what the terminal held before attach pushed it.
		if (this.#mouseReportingEnabled) {
			void this.#session.write("\x1b[?1006l\x1b[?1002l");
			this.#mouseReportingEnabled = false;
		}
		if (wasAttached && this.#interactive) {
			void this.#session.write("\x1b[?25h\x1b[?2004l\x1b[23;0t");
		}
		// The fullscreen manager's own teardown writes the alt-screen restore,
		// so it must run while the session still holds the wire.
		this.#fullscreenManager.dispose();

		// Restore the terminal modes we negotiated, clear the session's timers
		// and handlers (a live query timer keeps the event loop open), and
		// release the transport -- which is what hands a process transport its
		// tty back.
		this.#session.dispose();

		// Tear down the rest of what holds the event loop open. Without this a
		// disposed TermDOM keeps the process alive via the resize timers, and
		// across a whole test suite those accumulate until nothing can exit.
		if (this.#resizeTimer !== null) {
			clearTimeout(this.#resizeTimer);
			this.#resizeTimer = null;
		}
		if (this.#scrollChainTimer !== null) {
			clearTimeout(this.#scrollChainTimer);
			this.#scrollChainTimer = null;
		}

		// Shadow DOM cleanup is automatic with symbol-based storage

		if (this.#staticSibling) {
			void this.#staticSibling.dispose();
			this.#staticSibling = null;
		}
		this[kObserver].disconnect();
		this.#styleManager.dispose();
		this[kLayoutEngine].dispose();
		this.#observerManager.dispose();
		const flushed = this.#session.flush();
		(
			this.#nativeWindowClose ??
			this.#jsdom.window.close.bind(this.#jsdom.window)
		)();
		return flushed;
	}
}
