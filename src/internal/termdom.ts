import {type EventEmitter} from "events";
import {type DOMWindow, JSDOM} from "jsdom";
import {LayoutEngine, isPointInRects} from "./layout.js";
import {type ColorDepth, Renderer} from "./ansi.js";
import {
	StyleManager,
	resolveBorderStyles,
	cssColorToNumber,
	getBoxModel,
} from "./styles.js";
import {stringWidth} from "./runtime.js";
import {FullscreenManager} from "./fullscreen.js";
import {
	ObserverManager,
	type ObserverHost,
	ResizeObserver as TermResizeObserver,
	IntersectionObserver as TermIntersectionObserver,
} from "./observers.js";
import {setupInspectMethods} from "./inspector.js";
import {ScrollingManager} from "./scrolling.js";
import {
	createExpandedTreeWalker,
	initializeShadowDOM,
	getPseudoMetadata,
} from "./composition.js";

// How long to wait for a resize drag to settle before redrawing. Long enough to
// coalesce the burst of SIGWINCHes a drag fires, short enough to feel immediate.
const RESIZE_DEBOUNCE_MS = 40;

type ClipRect = {left: number; top: number; right: number; bottom: number};

/**
 * The clip an overflow:hidden (or overflow-x/-y:hidden) element imposes on its
 * own children, intersected with whatever clip was already active from an
 * ancestor. overflow:auto/scroll/visible impose no clip on that axis -- there
 * are no scrollable containers, only the document camera, so "auto/scroll"
 * degrades to "visible" rather than clipping content nobody can scroll to see.
 * An axis that isn't hidden stays unbounded (+-Infinity), not just "this
 * element's own edge", so overflow-x:hidden;overflow-y:visible only bounds
 * columns, matching CSS's independent per-axis overflow.
 */
function overflowClipRect(
	rect: {left: number; top: number; width: number; height: number} | null,
	overflowX: string,
	overflowY: string,
	parent: ClipRect | null,
): ClipRect | null {
	if (!rect) return parent;
	const hiddenX = overflowX === "hidden";
	const hiddenY = overflowY === "hidden";
	if (!hiddenX && !hiddenY) return parent;

	const left = hiddenX ? rect.left : -Infinity;
	const right = hiddenX ? rect.left + rect.width : Infinity;
	const top = hiddenY ? rect.top : -Infinity;
	const bottom = hiddenY ? rect.top + rect.height : Infinity;

	if (!parent) return {left, top, right, bottom};
	return {
		left: Math.max(parent.left, left),
		top: Math.max(parent.top, top),
		right: Math.min(parent.right, right),
		bottom: Math.min(parent.bottom, bottom),
	};
}

// DOM `code` values for the named/special keys the tokenizer already resolves
// unambiguously. This is what `code` is FOR -- unlike `key`, it identifies the
// physical key, not the character it produced.
const NAMED_KEY_CODES: Record<string, string> = {
	Enter: "Enter",
	Tab: "Tab",
	Backspace: "Backspace",
	Escape: "Escape",
	ArrowUp: "ArrowUp",
	ArrowDown: "ArrowDown",
	ArrowLeft: "ArrowLeft",
	ArrowRight: "ArrowRight",
	Home: "Home",
	End: "End",
	Insert: "Insert",
	Delete: "Delete",
	PageUp: "PageUp",
	PageDown: "PageDown",
	F1: "F1",
	F2: "F2",
	F3: "F3",
	F4: "F4",
	F5: "F5",
	F6: "F6",
	F7: "F7",
	F8: "F8",
	F9: "F9",
	F10: "F10",
	F11: "F11",
	F12: "F12",
	" ": "Space",
};

/**
 * The DOM `code` for a resolved key name -- physical key identity, independent
 * of modifiers. Exact for named/special keys (the escape sequence uniquely
 * identifies the physical key) and for letters/digits under the near-universal
 * assumption of a US QWERTY layout. Not exact for punctuation: a terminal only
 * ever tells us the character a key combination *produced* ("!" from Shift+1
 * on US layout, but a different physical key entirely on others), never which
 * physical key+modifiers produced it -- there is no protocol-level signal for
 * that, unlike the modifier bits `ctrlKey`/`altKey`/`shiftKey` decode from.
 * Falls back to the previous (also approximate) `Key<X>` guess for those.
 */
function domCodeFor(keyName: string): string {
	const named = NAMED_KEY_CODES[keyName];
	if (named) return named;
	if (keyName.length === 1) {
		const upper = keyName.toUpperCase();
		if (upper >= "A" && upper <= "Z") return `Key${upper}`;
		if (keyName >= "0" && keyName <= "9") return `Digit${keyName}`;
	}
	return `Key${keyName.toUpperCase()}`;
}

/**
 * The terminal has exactly three font weights, and CSS names all three:
 * light maps to SGR faint (dim), normal to nothing, bold to SGR bold.
 * Numeric values follow the CSS scale (100-300 light, 600+ bold). The
 * relative keywords resolve absolutely rather than against the parent's
 * weight -- an approximation, documented rather than hidden: "bolder" from
 * a bold parent cannot get bolder on a terminal anyway.
 */
function resolveFontWeight(weight: string): {bold: boolean; dim: boolean} {
	if (weight === "bold" || weight === "bolder") {
		return {bold: true, dim: false};
	}
	if (weight === "lighter") {
		return {bold: false, dim: true};
	}
	const numeric = parseInt(weight, 10);
	if (Number.isFinite(numeric)) {
		if (numeric >= 600) return {bold: true, dim: false};
		if (numeric <= 300) return {bold: false, dim: true};
	}
	return {bold: false, dim: false};
}

/**
 * Map each painted (visual) character of a text node back to its code-unit
 * offset in node.data. The painted fragments are the node's text after
 * whitespace collapsing and line breaking, so they differ from the raw data
 * only in whitespace: a run of data whitespace becomes one visual space, or
 * nothing at a line break. Non-whitespace code units match one-for-one --
 * including surrogate halves, which is what keeps the returned offsets valid
 * as Range offsets (Ranges address code units, not glyphs).
 *
 * Selection needs this bridge in both directions: a mouse hit lands on a
 * visual cell and must become a Range offset into the data; painting walks
 * the visual fragments and must know which of them a data-offset Range
 * covers.
 */
function visualToDataOffsets(
	data: string,
	fragments: Array<{text: string}>,
): number[] {
	const map: number[] = [];
	let d = 0;
	for (const fragment of fragments) {
		// Code UNITS on both sides, not code points: surrogate halves of
		// non-whitespace text are identical in data and fragment, so they
		// align half-to-half, and the map stays indexable by the same
		// positions String.prototype.slice uses.
		for (let i = 0; i < fragment.text.length; i++) {
			if (!/\s/.test(fragment.text[i])) {
				// A visual char never comes from data whitespace -- skip any
				// collapsed run to the next real char.
				while (d < data.length && /\s/.test(data[d])) d++;
				map.push(Math.min(d, Math.max(0, data.length - 1)));
				d++;
			} else {
				// One visual space stands for the whole whitespace run.
				map.push(Math.min(d, Math.max(0, data.length - 1)));
				while (d < data.length && /\s/.test(data[d])) d++;
			}
		}
	}
	return map;
}

/**
 * Apply CSS `text-transform` at paint time, not layout time. Every character
 * occupies the same cell width regardless of case in a terminal, so unlike a
 * browser's proportional font this can never change line wrapping -- there's
 * no need to re-measure, just transform the already-shaped text right before
 * it's drawn.
 */
function applyTextTransform(text: string, transform: string): string {
	switch (transform) {
		case "uppercase":
			return text.toUpperCase();
		case "lowercase":
			return text.toLowerCase();
		case "capitalize":
			return text.replace(
				/\p{L}[\p{L}\p{M}]*/gu,
				(word) => (word[0]?.toUpperCase() ?? "") + word.slice(1),
			);
		default:
			return text;
	}
}

function detectColorDepth(process: ProcessLike): ColorDepth {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "rgb";
	}

	const term = process.env.TERM || "";
	if (term.includes("256color") || term.includes("256")) {
		return "256";
	}

	return "ansi";
}

// TODO: Can we use web streams (WritableStream)
export interface TTYWriteStream {
	write(
		chunk: any,
		encoding?: BufferEncoding | ((error?: Error) => void),
		callback?: (error?: Error) => void,
	): boolean;
	columns: number;
	rows: number;
	isTTY: boolean;
}

// TODO: Can we use web streams (ReadableStream) or at least track what events we're using?
export interface TTYReadStream extends EventEmitter {
	isTTY: boolean;
	setRawMode?(mode: boolean): this;
	resume(): this;
	pause(): this;
	setEncoding?(encoding?: string): this;
}

export interface ProcessLike extends EventEmitter {
	stdin?: TTYReadStream;
	stdout: TTYWriteStream;
	exit(code?: number): never;
	env: Record<string, string | undefined>;
}

export interface TermDOMOptions {
	width?: number;
	height?: number;
	colorDepth?: ColorDepth;
	process?: ProcessLike;
	/** Disable automatic cursor position detection. Useful for testing. */
	detectCursor?: boolean;
}

// Frames keep the terminal cursor hidden, and dispose() shows it again -- but
// an app that calls process.exit() without disposing would strand the user's
// shell with no cursor. One process-level exit hook restores it for any live
// interactive instance that skipped dispose. Registered lazily, only for
// instances driving the real process (never for test mocks).
const undisposedInteractive = new Set<ProcessLike>();
let exitHookInstalled = false;

// What Tab traverses and what a mousedown focuses -- one definition of
// "focusable" for both.
const FOCUSABLE_SELECTOR =
	'input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function installCursorRestoreOnExit(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const proc of undisposedInteractive) {
			try {
				// Mouse capture off (a no-op if it was never on), cursor back on.
				proc.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?25h");
			} catch {
				// The stream may already be gone; the shell will survive.
			}
		}
	});
}

// Symbol-keyed handles for the internals the test suite must reach (the layout
// engine, input injection, anchor state). These are deliberately not #private so
// a test can import the key and read them -- but they are off the public API:
// index.ts does not re-export these symbols, so a consumer cannot name them.
const kLayoutEngine = Symbol("layoutEngine");
const kObserver = Symbol("observer");
export {kLayoutEngine, kObserver};

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
	#scrollingManager: ScrollingManager;

	// Guard against re-entrant rendering. A render() call arriving while one is in
	// flight sets renderQueued rather than being dropped, so a trailing frame runs.
	#isRendering = false;
	// Callbacks registered via window.requestAnimationFrame, fired once the frame
	// that includes their pending mutations has actually been written.
	#frameCallbacks: FrameRequestCallback[] = [];
	#nextRafId = 1;
	// document.close() sealed the current document into scrollback; the next
	// mutation starts a fresh document below it.
	#sealed = false;
	#renderQueued = false;
	#renderInFlight: Promise<void> | null = null;

	// Monotonic frame counter, used to timestamp observer entries.
	#renderCount = 0;

	// Input element state tracking. Only the horizontal scroll of an
	// overflowed field lives here -- pure presentation, invisible to the DOM.
	// The caret does NOT: it is the input's own selectionStart/End/Direction,
	// the standard API.
	#inputScrollOffsets = new WeakMap<Element, number>();

	// Track whether command start was explicitly detected (even if at row 1)
	#hasDetectedCommandStart: boolean = false;

	// Unified stdin handling
	#cursorDetectionHandler: ((data: string) => void) | null = null;

	// Handles and timers that must be torn down in dispose(), or they keep the
	// process alive after the app is done -- which, across a test suite, piles up
	// into a hang.
	#sigintHandler: (() => void) | null = null;
	#sigwinchHandler: (() => void) | null = null;
	#stdinDataHandler: ((chunk: string | Buffer) => void) | null = null;
	#cursorDetectionTimer: ReturnType<typeof setTimeout> | null = null;
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
	// Bumped on every SIGWINCH. The re-anchor waits on an async cursor query;
	// if another resize lands while it is in flight, the stale response must not
	// trigger a redraw at coordinates that no longer mean anything.
	#resizeEpoch = 0;

	// Promise that resolves when cursor detection completes (or times out)
	#cursorDetectionPromise: Promise<void> | null = null;

	#width: number;
	#height: number;
	/** Which document row sits at the top of the camera. */
	#documentScrollTop = 0;

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
	// The target and time of the last completed click, to detect a second one
	// close enough behind it to be a dblclick -- browsers' own double-click
	// interval varies by OS/user setting; 500ms is the common default.
	static readonly #DBLCLICK_INTERVAL_MS = 500;
	#lastClickTarget: Element | null = null;
	#lastClickTime = 0;
	#process: ProcessLike;

	#detectCursorEnabled: boolean;

	// A stdout that is not a terminal -- a pipe, a file, a CI log -- has no
	// viewport, no cursor, no scrollback and no resize. It cannot interpret cursor
	// movement either, so the interactive frame would write CUP and DECSC sequences
	// straight into the file.
	#interactive: boolean;

	constructor(options: TermDOMOptions = {}) {
		this.#process = options.process || process;
		this.#interactive = this.#process.stdout.isTTY !== false;
		this.#detectCursorEnabled =
			(options.detectCursor ?? this.#process === process) && this.#interactive;

		this.#width = options.width || this.#process.stdout.columns || 80;
		this.#height = options.height || this.#process.stdout.rows || 24;

		this.#jsdom = new JSDOM(
			"<!DOCTYPE html><html><head></head><body></body></html>",
			{pretendToBeVisual: true},
		);

		this.window = this.#jsdom.window;
		this.document = this.#jsdom.window.document;

		// Setup DOM inspector
		setupInspectMethods(this.window);

		// Setup shadow DOM support
		initializeShadowDOM(this.window);

		this.#initializeConstructorExtensions();
		this.#renderer = new Renderer(
			this.#height,
			this.#width,
			options.colorDepth || detectColorDepth(this.#process),
		);

		// Setup style management FIRST to override getComputedStyle before LayoutEngine uses it
		this.#styleManager = new StyleManager(this.window);

		// Create layout engine after StyleManager overrides getComputedStyle
		this[kLayoutEngine] = new LayoutEngine(this.#jsdom.window);
		this.#styleManager.setLayoutEngine(this[kLayoutEngine]);
		this[kLayoutEngine].resize(this.#width, this.#height);
		this.#fullscreenManager = new FullscreenManager(this.#process);
		this.#observerManager = new ObserverManager(this.#createObserverHost());

		this.#initializeWindow();
		this.#installObservers();

		// Initialize scrolling management after window setup
		this.#scrollingManager = new ScrollingManager(this.window, this.document);

		this[kObserver] = this.#setupMutationObserver();

		// Initial processing of all elements is handled by StyleManager's constructor
	}

	#initializeWindow(): void {
		const window = this.window;
		Object.defineProperty(window, "innerWidth", {
			value: this.#width,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "innerHeight", {
			value: this.#height,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "outerWidth", {
			value: this.#width,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "outerHeight", {
			value: this.#height,
			writable: false,
			configurable: true,
		});

		// Initialize screenTop for terminal viewport positioning (readonly like browsers)
		Object.defineProperty(window, "screenTop", {
			value: 0,
			writable: false,
			configurable: true,
			enumerable: true,
		});

		// Standard window scrolling, mapped onto the camera: scrollY is how far the
		// camera has moved down the document, scrollBy moves it.
		const termDOM = this;
		Object.defineProperty(window, "scrollY", {
			get: () => termDOM.#documentScrollTop,
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(window, "pageYOffset", {
			get: () => termDOM.#documentScrollTop,
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
					? (xOrOptions.top ?? termDOM.#documentScrollTop)
					: (y ?? 0);
			termDOM.#documentScrollTop = Math.max(0, targetY);
			void termDOM.#render();
		};
		window.scrollTo = scrollToCamera as typeof window.scrollTo;
		window.scroll = scrollToCamera as typeof window.scroll;

		for (const root of [this.document.documentElement, this.document.body]) {
			Object.defineProperty(root, "scrollTop", {
				get: () => termDOM.#documentScrollTop,
				set: (value: number) => {
					termDOM.#documentScrollTop = Math.max(0, value);
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
			const id = termDOM.#nextRafId++;
			termDOM.#frameCallbacks.push(cb);
			void termDOM.#render();
			return id;
		}) as typeof window.requestAnimationFrame;

		// document.close() finalizes the document: flush the live region into the
		// terminal's scrollback and seal it -- the SSR res.end() of the terminal.
		// A later DOM mutation starts a fresh document below the sealed block. This
		// is the "print rich output and stop" seam: write(), then close().
		const nativeDocumentClose = termDOM.document.close.bind(termDOM.document);
		termDOM.document.close = () => {
			nativeDocumentClose();
			// dispose() tears down via jsdom's window.close(), which calls
			// document.close() -- but it has already set attached=false, so we skip
			// the seal there. A real seal is a close() from a live, painted session.
			if (termDOM.#attached && termDOM.#renderCount > 0) {
				termDOM.#flushDocument();
				termDOM.#sealed = true;
			}
		};

		// Implement standard DOM scrollHeight properties
		Object.defineProperty(this.document.body, "scrollHeight", {
			get() {
				return termDOM[kLayoutEngine].getContentHeight();
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(this.document.documentElement, "scrollHeight", {
			get() {
				return termDOM[kLayoutEngine].getContentHeight();
			},
			configurable: true,
			enumerable: true,
		});

		// clientHeight is the viewport height (terminal height)
		Object.defineProperty(this.document.body, "clientHeight", {
			get() {
				return termDOM.#height;
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(this.document.documentElement, "clientHeight", {
			get() {
				return termDOM.#height;
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
	 * below, and #processPendingMutationsAndRender/#renderStatic/
	 * #renderInteractive's synchronous `takeRecords()` drain (a geometry read
	 * or a scheduled render needs fresh layout NOW, not whenever the next
	 * microtask checkpoint happens to land) -- and whichever one runs first
	 * empties the queue for the other.
	 */
	#handlePendingMutations(mutations: MutationRecord[]): void {
		this.#styleManager.handleMutations(mutations);
		this[kLayoutEngine].handleMutations(mutations);
		this.#focusAutofocusedNodes(mutations);
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
			characterData: true,
		});

		return observer;
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
	#focusAutofocusedNodes(mutations: MutationRecord[]): void {
		for (const record of mutations) {
			for (const node of record.addedNodes) {
				if (node.nodeType !== node.ELEMENT_NODE) continue;
				const element = node as Element;
				const candidate = (element as any).autofocus
					? element
					: element.querySelector?.("[autofocus]");
				(candidate as HTMLElement | null)?.focus?.();
			}
		}
	}

	/**
	 * Take hold of the terminal: raw mode, signal handlers, the stdin listener,
	 * the cursor-position query, and the exit hook that restores the cursor.
	 *
	 * Construction is inert -- a constructor has no business writing escape
	 * sequences to stdout or flipping stdin into raw mode. Attachment happens
	 * here, invoked lazily by the first render (so the zero-config path still
	 * just works) or explicitly by callers that want to control the moment the
	 * terminal changes hands. Idempotent; dispose() reverses it.
	 */
	attach(): void {
		if (this.#attached) return;
		this.#attached = true;

		this.#setupProcessHandlers();
		this.#updateMouseReporting();
		this.#initializeCursorDetection();

		// See installCursorRestoreOnExit: if this instance dies without
		// dispose(), the exit hook hands the user their cursor back.
		if (this.#interactive && this.#process === process) {
			undisposedInteractive.add(this.#process);
			installCursorRestoreOnExit();
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
	#updateMouseReporting(): void {
		const wanted =
			this.#attached &&
			this.#interactive &&
			Boolean(this.#process.stdin?.isTTY) &&
			!this.#mouseCaptureYielded;
		if (wanted === this.#mouseReportingEnabled) return;
		this.#mouseReportingEnabled = wanted;
		// 1002: button presses, releases, wheel, and drag motion (no move flood
		// while nothing is pressed). 1006: SGR encoding, the only one that is
		// unambiguous past column 223.
		this.#process.stdout.write(
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

	// TODO: This should be put in an event translator abstraction
	#setupProcessHandlers(): void {
		this.#sigintHandler = () => {
			this.dispose();
			this.#process.exit(0);
		};
		this.#process.on("SIGINT", this.#sigintHandler);

		this.#sigwinchHandler = () => this.#scheduleResize();
		this.#process.on("SIGWINCH", this.#sigwinchHandler);

		if (this.#process.stdin?.isTTY) {
			const stdin = this.#process.stdin;
			if (!stdin) return;

			// Configure terminal for proper input handling (once)
			stdin.setRawMode?.(true);
			stdin.resume();
			stdin.setEncoding?.("utf8");

			// Single unified handler for all stdin data
			this.#stdinDataHandler = (chunk: string | Buffer) => {
				// Ensure we have both string and buffer representations
				const data = Buffer.isBuffer(chunk)
					? chunk
					: Buffer.from(chunk, "utf8");
				const dataStr = data.toString("utf8");

				// Route 1: Cursor position responses (highest priority). Fast typing
				// can land in the same chunk as the report -- "jjj\x1b[12;1Rjjj" --
				// so hand the report to the waiting query and let the rest continue
				// through the normal routes as keystrokes.
				const report = dataStr.match(/\x1b\[\d+;\d+R/);
				if (this.#cursorDetectionHandler && report) {
					this.#cursorDetectionHandler(report[0]);
					const rest =
						dataStr.slice(0, report.index) +
						dataStr.slice((report.index ?? 0) + report[0].length);
					if (rest.length === 0) return;
					if (this.#stdinDataHandler) {
						this.#stdinDataHandler(rest);
					}
					return;
				}

				// Route 2: Ctrl-C handling (high priority) - check raw bytes
				if (data.length > 0 && data[0] === 0x03) {
					this.dispose();
					return this.#process.exit(0);
				}

				// Route 3: SGR mouse reports. Peeled off token by token so a report
				// glued to fast keystrokes ("jj\x1b[<65;4;7Mjj") eats neither side,
				// and BEFORE the fullscreen filter below -- fullscreen is a
				// mouse-capturing mode, so its reports must not be dropped with the
				// keyboard events.
				let keyInput = "";
				for (const token of this.#tokenizeInput(dataStr)) {
					const mouse = token.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
					if (mouse) {
						this.#handleMouseReport(
							parseInt(mouse[1]),
							parseInt(mouse[2]),
							parseInt(mouse[3]),
							mouse[4] === "m",
						);
					} else {
						keyInput += token;
					}
				}
				if (keyInput.length === 0) return;

				// A keystroke means the user is back at the live screen (terminals
				// snap to the bottom on input): reclaim the mouse if scroll
				// chaining yielded it.
				if (this.#mouseCaptureYielded) {
					this.#reclaimMouseCapture();
				}

				// Route 4: General keyboard events. Fullscreen used to have its own,
				// entirely separate stdin listener and dispatch implementation here
				// (fullscreen.ts's old #inputHandler) -- duplicated, and silently
				// out of sync with this one: no tokenization for batched input, no
				// SGR-mouse-report filtering (a mouse report arriving while
				// fullscreen was active would get misread as literal keyboard
				// text), none of the modifier decoding above. One pipeline for
				// both now; #dispatchGlobalKeyboardEvent itself handles Escape
				// exiting fullscreen (see below) the same way this used to.
				this.#dispatchGlobalKeyboardEvent(Buffer.from(keyInput));
			};
			stdin.on("data", this.#stdinDataHandler);
		}
	}

	async #render(): Promise<void> {
		this.attach();

		// A resize is settling: suppress every render until handleResize issues the
		// single re-anchored redraw. See resizeInProgress.
		if (this.#resizeInProgress) {
			return;
		}

		// A render in flight: coalesce, don't drop. Dropping an auto-render (a
		// mutation observer firing mid-frame) leaves the diff renderer's
		// previous-buffer out of step with the screen, which shows up as rows drawn
		// at the wrong place. Instead mark one pending and hand back the running
		// loop's promise: it will fold this caller's changes into a trailing frame,
		// so awaiting render() always means "what I changed is painted".
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
		if (this.#frameCallbacks.length === 0) return;
		const callbacks = this.#frameCallbacks;
		this.#frameCallbacks = [];
		const now = performance.now();
		for (const cb of callbacks) cb(now);
	}

	async #renderOnce(): Promise<void> {
		if (!this.#interactive) {
			await this.#renderStatic();
			return;
		}

		await this.#renderInteractive();
	}

	// TODO: many of the following methods do not belong on the TermDOM class
	#renderElement(
		element: Element,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		// Viewport culling. The buffer only keeps document rows in
		// [-viewportOffset, -viewportOffset + rows); a subtree whose paint extent
		// lies wholly outside that band would be walked -- styles computed, text
		// shaped, borders drawn -- and then discarded cell by cell. Skip it here
		// and the paint costs what is on screen, not what is in the document.
		const bandTop = -ctx.viewportOffset;
		if (
			this[kLayoutEngine].isSubtreeOutsideBand(
				element,
				bandTop,
				bandTop + ctx.rows,
			)
		) {
			return;
		}

		const rect = this[kLayoutEngine].getRect(element);

		const color = this.window
			.getComputedStyle(element)
			.getPropertyValue("color");
		const backgroundColor = this.window
			.getComputedStyle(element)
			.getPropertyValue("background-color");
		const {bold, dim} = resolveFontWeight(
			this.window.getComputedStyle(element).getPropertyValue("font-weight"),
		);
		const italic =
			this.window.getComputedStyle(element).getPropertyValue("font-style") ===
			"italic";
		const underline = this.window
			.getComputedStyle(element)
			.getPropertyValue("text-decoration")
			.includes("underline");
		const underlineStyle =
			this.window
				.getComputedStyle(element)
				.getPropertyValue("text-decoration-style") === "double"
				? ("double" as const)
				: undefined;
		// visibility:hidden reserves the box (layout is untouched) but paints
		// nothing of it -- unlike display:none, which removes the box entirely. A
		// descendant that sets visibility:visible still paints, since visibility
		// inherits and each element resolves its own computed value here.
		const visible =
			this.window.getComputedStyle(element).getPropertyValue("visibility") !==
			"hidden";

		const style = {
			fg: color && color !== "initial" ? cssColorToNumber(color) : undefined,
			bg:
				backgroundColor &&
				backgroundColor !== "initial" &&
				backgroundColor !== "transparent"
					? cssColorToNumber(backgroundColor)
					: undefined,
			bold,
			dim,
			italic,
			underline,
			underlineStyle,
		};

		if (rect && style.bg != null && visible) {
			ctx.fillRect(rect.left, rect.top, rect.width, rect.height, style.bg);
		}

		// Handle tables with TanStack integration
		const display = this.window
			.getComputedStyle(element)
			.getPropertyValue("display");
		if (display === "table" && rect && visible) {
			this.#renderTable(element, rect, style);
			// Continue with normal child rendering
		}

		// Handle borders
		if (rect && visible) {
			const borderStyles = resolveBorderStyles(element);
			if (borderStyles.hasAnyBorder) {
				// Use foreground color for borders, inherit element's background color
				const borderCellStyle = {
					fg: style.fg || 0xffffff, // Default to white if no color
					bg: style.bg, // Inherit element's background color
				};
				ctx.drawBorder(
					Math.round(rect.left),
					Math.round(rect.top),
					Math.round(rect.width),
					Math.round(rect.height),
					borderStyles,
					borderCellStyle,
				);
			}
		}

		// Handle list-style-position: outside markers
		if (visible) this.#renderOutsideMarker(element, ctx);

		// Render input elements (void elements with no children)
		if (
			element.tagName === "INPUT" &&
			rect &&
			(element as HTMLInputElement).type !== "hidden"
		) {
			if (visible) {
				this.#renderInputElement(element as HTMLInputElement, rect, style, ctx);
			}
			return; // Input elements have no children to render
		}

		// Note: JSDOM automatically calls connectedCallback() when elements are added to DOM
		// No manual lifecycle management needed

		// Collect the children first, then paint them in z-order. Painting straight
		// down the tree in document order means nothing can ever sit on top of
		// anything else, which is why an overlay or a modal was impossible: it
		// would be painted before the content it is supposed to cover.
		const children: Array<{node: Node; zIndex: number}> = [];

		// Fast path: for a plain vertically-stacked container (no position:
		// relative/absolute child, no flex-direction other than column -- see
		// visibleChildrenInBand's own doc comment for exactly what that rules
		// out), the layout tree already knows which children are in band
		// without visiting the rest to rule them out. A long list scrolled to
		// any depth used to cost O(total children) to paint one frame --
		// worse the longer the list got, even though only ~O(screen) of it
		// could ever be visible -- because the walker below has no choice but
		// to step through every sibling to find out which ones are off-band.
		const fastChildren = this[kLayoutEngine].visibleChildrenInBand(
			element,
			bandTop,
			bandTop + ctx.rows,
		);
		if (fastChildren) {
			for (const childNode of fastChildren) {
				children.push({
					node: childNode,
					zIndex:
						childNode.nodeType === childNode.ELEMENT_NODE
							? this.#zIndexOf(childNode as Element)
							: 0,
				});
			}
		} else {
			// Use ExpandedTreeWalker to render all children including pseudo-elements and shadow DOM
			const walker = createExpandedTreeWalker(this.window, element);
			for (
				let childNode = walker.firstChild();
				childNode;
				childNode = walker.nextSibling()
			) {
				// Cull before the z-index style read: an off-band child costs one map
				// lookup instead of a computed-style resolution, which is what keeps a
				// wide container of mostly off-screen children O(screen).
				if (
					childNode.nodeType === childNode.ELEMENT_NODE &&
					this[kLayoutEngine].isSubtreeOutsideBand(
						childNode as Element,
						bandTop,
						bandTop + ctx.rows,
					)
				) {
					continue;
				}
				children.push({
					node: childNode,
					zIndex:
						childNode.nodeType === childNode.ELEMENT_NODE
							? this.#zIndexOf(childNode as Element)
							: 0,
				});
			}
		}

		// A stable sort, so boxes at the same level keep their document order and
		// only an explicit z-index moves anything.
		children.sort((a, b) => a.zIndex - b.zIndex);

		// overflow:hidden clips *descendants* to this element's own box -- never
		// the element's own border/background painted above, which is why this is
		// scoped to just the children, not the whole function.
		const overflow = this.window
			.getComputedStyle(element)
			.getPropertyValue("overflow");
		const overflowX =
			this.window.getComputedStyle(element).getPropertyValue("overflow-x") ||
			overflow;
		const overflowY =
			this.window.getComputedStyle(element).getPropertyValue("overflow-y") ||
			overflow;
		const previousClip = ctx.clipRect;
		ctx.clipRect = overflowClipRect(rect, overflowX, overflowY, previousClip);

		try {
			for (const {node: childNode} of children) {
				if (childNode.nodeType === childNode.ELEMENT_NODE) {
					const childElement = childNode as Element;
					if (childElement instanceof (this.window as any).HTMLElement) {
						this.#renderElement(childElement, ctx);
					}
				} else if (childNode.nodeType === childNode.TEXT_NODE) {
					const textNode = childNode as Text;
					this.#renderText(textNode, ctx);
				}
			}
		} finally {
			ctx.clipRect = previousClip;
		}
	}

	/**
	 * The paint order of a box relative to its siblings.
	 *
	 * z-index only applies to positioned boxes, so a static one always sits at 0
	 * and keeps its document order.
	 */
	#zIndexOf(element: Element): number {
		const computedStyle = this.window.getComputedStyle(element);

		const position = computedStyle.getPropertyValue("position");
		if (!position || position === "static") return 0;

		const zIndex = computedStyle.getPropertyValue("z-index");
		if (!zIndex || zIndex === "auto") return 0;

		const value = parseInt(zIndex, 10);
		return Number.isFinite(value) ? value : 0;
	}

	/**
	 * Render outside positioned markers for list items
	 */
	#renderedOutsideMarkers = new WeakSet<Element>();

	#renderOutsideMarker(
		element: Element,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const computedStyle = this.window.getComputedStyle(element);
		const display = computedStyle.getPropertyValue("display");

		// Only handle list items
		if (display !== "list-item") {
			return;
		}

		const listStylePosition =
			computedStyle.getPropertyValue("list-style-position") || "outside";

		// Only handle outside positioning
		if (listStylePosition !== "outside") {
			return;
		}

		// Prevent duplicate rendering in the same frame
		if (this.#renderedOutsideMarkers.has(element)) {
			return;
		}
		this.#renderedOutsideMarkers.add(element);

		// Get marker content from StyleManager
		const markerContent = this.#styleManager.getMarkerContent(element);
		if (!markerContent) {
			return;
		}

		const rect = this[kLayoutEngine].getRect(element);
		if (!rect) {
			return;
		}

		// Cells, not code units: a marker like "日本 " is 3 characters but 5 cells
		// wide, and right-aligning it by its length would paint it over the item's
		// own text.
		const markerWidth = stringWidth(markerContent);

		// Get marker styles
		const markerStyle = this.window.getComputedStyle(element, "::marker");
		// ::marker inherits color from its originating element, so fall back to the
		// list item's own color rather than rendering the marker unstyled.
		const markerColor =
			markerStyle.getPropertyValue("color") ||
			computedStyle.getPropertyValue("color");
		const {bold: markerBold, dim: markerDim} = resolveFontWeight(
			markerStyle.getPropertyValue("font-weight"),
		);
		const markerItalic =
			markerStyle.getPropertyValue("font-style") === "italic";
		const markerUnderline = markerStyle
			.getPropertyValue("text-decoration")
			.includes("underline");

		const markerTextStyle = {
			fg:
				markerColor && markerColor !== "initial"
					? cssColorToNumber(markerColor)
					: undefined,
			bold: markerBold,
			dim: markerDim,
			italic: markerItalic,
			underline: markerUnderline,
		};

		// Position marker just before the list item's content area (outside positioning)
		const markerX = Math.max(0, Math.round(rect.left) - markerWidth);
		const markerY = Math.round(rect.top);

		// Render the marker (clipped to available space, never mutate the DOM)
		ctx.setText(markerX, markerY, markerContent, markerTextStyle);
	}

	/**
	 * Render an input element with its value and cursor
	 */
	#renderInputElement(
		element: HTMLInputElement,
		rect: DOMRect,
		style: {
			fg?: number;
			bg?: number;
			bold: boolean;
			italic: boolean;
			underline: boolean;
		},
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const boxModel = getBoxModel(element);
		const contentX =
			Math.round(rect.left) +
			(boxModel.borderLeftWidth || 0) +
			(boxModel.paddingLeft || 0);
		const contentY =
			Math.round(rect.top) +
			(boxModel.borderTopWidth || 0) +
			(boxModel.paddingTop || 0);
		const contentWidth =
			Math.round(rect.width) -
			(boxModel.borderLeftWidth || 0) -
			(boxModel.borderRightWidth || 0) -
			(boxModel.paddingLeft || 0) -
			(boxModel.paddingRight || 0);

		if (element.type === "checkbox" || element.type === "radio") {
			const mark =
				element.type === "checkbox"
					? element.checked
						? "[x]"
						: "[ ]"
					: element.checked
						? "(x)"
						: "( )";
			ctx.setText(contentX, contentY, mark, style);
			if (element === this.document.activeElement) {
				ctx.setCaret(contentX, contentY);
			}
			return;
		}

		const value = element.value || "";
		const placeholder = element.getAttribute("placeholder") || "";
		const isFocused = element === this.document.activeElement;

		let displayText: string;
		let textStyle = {...style};

		if (value) {
			displayText = value;
		} else if (placeholder) {
			// Shown focused or not, as in a browser -- the caret just sits at
			// the field start, over the dimmed text. (This used to be gated on
			// !isFocused, which nothing noticed while autofocus was
			// unimplemented: no input ever STARTED focused, so the placeholder
			// always survived the first paint.)
			displayText = placeholder;
			textStyle.fg = 0x808080;
		} else {
			displayText = "";
		}

		// Everything below measures in CELLS, not characters. CJK text is two
		// cells per glyph, so character arithmetic put the caret mid-text (IME
		// composition then anchored on top of already-typed glyphs) and padEnd
		// by character count pushed the value's background straight through the
		// input's right border.
		let scrollOffset = this.#inputScrollOffsets.get(element) ?? 0;
		// The caret is the input's own selection (selectionStart/End), so a
		// framework assigning .value can never strand it: per spec, setting
		// value collapses the selection to the end. The caret sits at the
		// selection's FOCUS -- the moving end, per selectionDirection -- which
		// is the end that must stay scrolled into view while extending.
		const selStart = element.selectionStart ?? value.length;
		const selEnd = element.selectionEnd ?? value.length;
		const cursor =
			element.selectionDirection === "backward" ? selStart : selEnd;

		if (isFocused) {
			// Keep the caret's CELL offset inside the box.
			if (cursor < scrollOffset) {
				scrollOffset = cursor;
			}
			while (
				scrollOffset < cursor &&
				stringWidth(displayText.slice(scrollOffset, cursor)) >= contentWidth
			) {
				scrollOffset++;
			}
			// And scroll BACK when there's slack: after deleting at the end of
			// an overflowed value, the window would otherwise stay put and show
			// a shrinking tail with the earlier text still hidden off the left
			// edge. Pull the window left while everything from one character
			// earlier through the end still fits strictly inside the field
			// (strictly: the caret needs its cell when it sits at the end),
			// exactly what a browser's field does on backspace.
			while (
				scrollOffset > 0 &&
				stringWidth(displayText.slice(scrollOffset - 1)) < contentWidth
			) {
				scrollOffset--;
			}
			this.#inputScrollOffsets.set(element, scrollOffset);
		}

		// Take characters from the scroll offset until the next one would no
		// longer fit, then pad with spaces to exactly the content width in cells.
		let visibleText = "";
		let usedCells = 0;
		for (const char of displayText.slice(scrollOffset)) {
			const charCells = stringWidth(char);
			if (usedCells + charCells > contentWidth) break;
			visibleText += char;
			usedCells += charCells;
		}
		const visibleChars = visibleText.length;
		visibleText += " ".repeat(Math.max(0, contentWidth - usedCells));

		if (isFocused) {
			ctx.setText(contentX, contentY, visibleText, textStyle);
		} else {
			// A blurred field is a FAINT BLANK: dim + underline (SGR 2 and 4,
			// classic codes that survive every terminal and every re-encoding
			// intermediary) across every cell the value doesn't occupy. In CSS
			// terms the blank is `font-weight: lighter; text-decoration:
			// underline` -- both attributes authors can write themselves
			// (resolveFontWeight maps light weights to faint); only the
			// value/remainder REGION split is widget magic, pending a field
			// pseudo-element under the divergence doctrine. Typed
			// content reads as plain text; the placeholder is part of the
			// blank -- a ghost label sitting on it -- so it keeps its gray and
			// goes faint with it. Focus swaps the whole extent to the solid
			// underline (via the focus-aware default), the live-wire signal.
			// This split is the UA widget painter's job, the same place the
			// placeholder's gray lives -- browsers style their field
			// internals the same way (::placeholder is UA magic, not author
			// CSS).
			const blank = {...textStyle, underline: true, dim: true};
			if (value) {
				ctx.setText(
					contentX,
					contentY,
					visibleText.slice(0, visibleChars),
					textStyle,
				);
				ctx.setText(
					contentX + usedCells,
					contentY,
					visibleText.slice(visibleChars),
					blank,
				);
			} else {
				ctx.setText(contentX, contentY, visibleText, blank);
			}
		}

		// A selection paints as inverse video over its visible slice --
		// terminal-native highlight, no color assumptions. (Placeholder text
		// can never be selected: it only shows for an empty value, whose
		// selection is necessarily collapsed.)
		if (isFocused && selEnd > selStart) {
			const visStart = Math.max(selStart, scrollOffset);
			const visEnd = Math.min(selEnd, scrollOffset + visibleChars);
			if (visEnd > visStart) {
				ctx.setText(
					contentX + stringWidth(displayText.slice(scrollOffset, visStart)),
					contentY,
					displayText.slice(visStart, visEnd),
					{...textStyle, inverse: true},
				);
			}
		}

		// The caret of a focused input is the REAL terminal cursor, parked there
		// by the frame -- not an inverse-video imitation. IME composition, screen
		// readers and the terminal's own cursor style all anchor to the real one.
		if (isFocused) {
			const cursorX =
				contentX + stringWidth(displayText.slice(scrollOffset, cursor));
			if (cursorX >= contentX && cursorX < contentX + contentWidth) {
				ctx.setCaret(cursorX, contentY);
			}
		}
	}

	/**
	 * Render a text node with proper styling from its parent element or pseudo-element
	 */
	#renderText(textNode: Text, ctx: import("./ansi.js").DrawingContext): void {
		const textContent = textNode.data;
		if (!textContent) return;

		// Check if this is a pseudo-element node
		const pseudoMetadata = getPseudoMetadata(textNode);

		// For pseudo elements, we don't have a parentElement, but we have hostElement
		const parentElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: textNode.parentElement;
		if (!parentElement) return;

		let computedStyle: CSSStyleDeclaration;

		if (pseudoMetadata) {
			// For pseudo-elements, get the computed style with the pseudo-element selector
			computedStyle = this.window.getComputedStyle(
				pseudoMetadata.hostElement,
				pseudoMetadata.pseudoType,
			);
		} else {
			// For regular text nodes, use the parent element's style
			computedStyle = this.window.getComputedStyle(parentElement);
		}

		// visibility inherits, so the parent's own resolved value already accounts
		// for a closer ancestor overriding back to visible.
		if (computedStyle.getPropertyValue("visibility") === "hidden") return;

		const textTransform = computedStyle.getPropertyValue("text-transform");
		const textColor = computedStyle.getPropertyValue("color");
		const textBgColor = computedStyle.getPropertyValue("background-color");
		const {bold: textBold, dim: textDim} = resolveFontWeight(
			computedStyle.getPropertyValue("font-weight"),
		);
		const textItalic =
			computedStyle.getPropertyValue("font-style") === "italic";
		const textUnderline = computedStyle
			.getPropertyValue("text-decoration")
			.includes("underline");
		const textUnderlineStyle =
			computedStyle.getPropertyValue("text-decoration-style") === "double"
				? ("double" as const)
				: undefined;

		const textStyle = {
			fg:
				textColor && textColor !== "initial"
					? cssColorToNumber(textColor)
					: undefined,
			bg:
				textBgColor &&
				textBgColor !== "initial" &&
				textBgColor !== "transparent"
					? cssColorToNumber(textBgColor)
					: undefined,
			bold: textBold,
			dim: textDim,
			italic: textItalic,
			underline: textUnderline,
			underlineStyle: textUnderlineStyle,
		};

		const rectTexts = this[kLayoutEngine].getRectTexts(textNode);
		if (rectTexts.length > 0) {
			for (const rectText of rectTexts) {
				if (rectText.text.length > 0) {
					ctx.setText(
						Math.round(rectText.rect.x),
						Math.round(rectText.rect.y),
						applyTextTransform(rectText.text, textTransform),
						textStyle,
					);
				}
			}
			this.#renderTextSelection(
				textNode,
				rectTexts,
				textStyle,
				textTransform,
				ctx,
			);
		}
	}

	/**
	 * Overlay the document selection on a text node's painted fragments as
	 * inverse video -- the terminal-native highlight, no color assumptions.
	 * The Range holds code-unit offsets into node.data; visualToDataOffsets
	 * bridges each painted character back to its data offset, and contiguous
	 * selected runs repaint inverse. Ranges whose boundary containers are
	 * elements rather than text nodes still highlight any text node they
	 * fully contain (the intersectsNode walk); a boundary that lands INSIDE
	 * this node only resolves to a precise offset when the container is the
	 * node itself -- the only shape our own drag selection produces.
	 */
	#renderTextSelection(
		textNode: Text,
		rectTexts: Array<import("./layout.js").RectText>,
		textStyle: import("./ansi.js").CellStyle,
		textTransform: string,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const selection = this.window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			return;
		}
		const range = selection.getRangeAt(0);
		if (!range.intersectsNode(textNode)) return;

		const from = range.startContainer === textNode ? range.startOffset : 0;
		const to =
			range.endContainer === textNode ? range.endOffset : textNode.data.length;
		if (to <= from) return;

		const visToData = visualToDataOffsets(textNode.data, rectTexts);
		let visualBase = 0;
		for (const rectText of rectTexts) {
			// Contiguous run of selected visual chars within this fragment.
			let runStart = -1;
			for (let i = 0; i <= rectText.text.length; i++) {
				const dataOffset =
					i < rectText.text.length ? visToData[visualBase + i] : -1;
				const selected =
					dataOffset >= 0 && dataOffset >= from && dataOffset < to;
				if (selected && runStart === -1) {
					runStart = i;
				} else if (!selected && runStart !== -1) {
					// Case transforms never change cell width, so slicing the
					// untransformed text and transforming the slice paints the
					// same cells the base pass did.
					ctx.setText(
						Math.round(rectText.rect.x) +
							stringWidth(rectText.text.slice(0, runStart)),
						Math.round(rectText.rect.y),
						applyTextTransform(rectText.text.slice(runStart, i), textTransform),
						{...textStyle, inverse: true},
					);
					runStart = -1;
				}
			}
			visualBase += rectText.text.length;
		}
	}

	// TODO: move this to tables.ts? or layout.ts
	#renderTable(tableElement: Element, _rect: DOMRect, _style: any): void {
		// For now, let's fall back to normal rendering and let CSS handle table layout
		// The layout engine should already handle display: table properly
		// TODO: Implement table-specific optimizations like borders between cells

		// Check if we have proper table children, if not, render as normal element
		const hasTableStructure = this.#hasTableStructure(tableElement);
		if (!hasTableStructure) {
			// Render children normally
			return;
		}

		// For tables with proper structure, add table-specific border rendering
		this.#renderTableBorders(tableElement, _rect, _style);
	}

	#hasTableStructure(tableElement: Element): boolean {
		// Check if element has table-like children (thead, tbody, tr, etc.)
		const tableElements = ["thead", "tbody", "tfoot", "tr", "th", "td"];
		return Array.from(tableElement.children).some((child) =>
			tableElements.includes(child.tagName?.toLowerCase() || ""),
		);
	}

	#renderTableBorders(
		tableElement: Element,
		_rect: DOMRect,
		_style: any,
	): void {
		// Add borders between table cells
		// This could be enhanced to draw proper table borders
		// For now, this is a placeholder for table-specific rendering

		// Check if border-collapse is set
		const borderCollapse = this.window
			.getComputedStyle(tableElement)
			.getPropertyValue("border-collapse");

		if (borderCollapse === "collapse") {
			// TODO: Implement collapsed border model
			// This would require drawing borders between cells
		}
	}

	#processPendingMutationsAndRender(): boolean {
		// A geometry read (getBoundingClientRect, elementFromPoint) needs fresh
		// *layout*, not fresh pixels. This used to fire a full render() here, so
		// every rect read with pending mutations painted a frame -- an app calling
		// scrollIntoView on each keystroke paid two paints per key, and the rect
		// could still be stale because the render was not awaited. Flushing
		// mutations and laying out synchronously gives an exact rect; painting
		// stays with the caller's own render. The dirty-skip makes this free when
		// nothing changed.
		const pendingMutations = this[kObserver].takeRecords();
		const hadMutations = pendingMutations.length > 0;
		if (hadMutations) {
			this.#handlePendingMutations(pendingMutations);
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
		const newWidth = this.#process.stdout.columns || 80;
		const newHeight = this.#process.stdout.rows || 24;

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

		this.#renderer.resize(newHeight, newWidth);
		this[kLayoutEngine].resize(newWidth, newHeight);

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
			this.#scrollingManager.setScreenTop(startRow);
			this.#scrollingManager.scrollToCommandStart();
			this.#renderer.resetScreen(startRow);

			// Everything suppressed since the first SIGWINCH may paint again. The
			// frame is placed by the screen reset, not by cursor detection.
			this.#resizeInProgress = false;
			const wasDetected = this.#hasDetectedCommandStart;
			this.#hasDetectedCommandStart = false;
			this.#render().then(() => {
				this.#hasDetectedCommandStart = wasDetected;
			});
		};

		const computedReanchor = () => {
			const previousStart = this.#scrollingManager.getScreenTop();
			const scrolledUp = Math.max(0, previousStart + contentHeight - newHeight);
			return Math.max(0, previousStart - scrolledUp);
		};

		if (
			this.#detectCursorEnabled &&
			this.#process.stdin?.isTTY &&
			wrappedRowsAbove !== null
		) {
			this.#queryCursorRow()
				.then((cursorRow) => {
					// A newer resize superseded this one; its handler will redraw.
					if (epoch !== this.#resizeEpoch) return;
					const startRow = Math.max(0, cursorRow - wrappedRowsAbove);
					redraw(startRow);
				})
				.catch(() => {
					if (epoch !== this.#resizeEpoch) return;
					const startRow = computedReanchor();
					redraw(startRow);
				});
		} else {
			const startRow = computedReanchor();
			redraw(startRow);
		}
	}

	/** The measurement surface the observers read each frame. See ObserverHost. */
	#createObserverHost(): ObserverHost {
		return {
			getBorderBox: (element) => {
				const rect = this[kLayoutEngine].getRect(element);
				return rect
					? {
							top: rect.top,
							left: rect.left,
							width: rect.width,
							height: rect.height,
						}
					: null;
			},
			getContentBox: (element) => {
				const rect = this[kLayoutEngine].getRect(element);
				if (!rect) return null;
				const box = getBoxModel(element);
				const width = Math.max(
					0,
					rect.width -
						(box.paddingLeft || 0) -
						(box.paddingRight || 0) -
						(box.borderLeftWidth || 0) -
						(box.borderRightWidth || 0),
				);
				const height = Math.max(
					0,
					rect.height -
						(box.paddingTop || 0) -
						(box.paddingBottom || 0) -
						(box.borderTopWidth || 0) -
						(box.borderBottomWidth || 0),
				);
				return {width, height};
			},
			getViewportRect: () => {
				// The visible window over the document, in the document coordinate
				// space getRect() uses: it begins at the current scroll offset and is
				// one terminal high.
				const scrollTop = this.#documentScrollTop;
				return {
					top: scrollTop,
					left: 0,
					width: this.#width,
					height: this.#height,
				};
			},
			now: () => this.#renderCount,
		};
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
		this.#observerManager.flush();
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

	// TODO: Move these somewhere?
	#initializeConstructorExtensions(): void {
		const {Element, Document} = this.window;
		const termDOM = this;

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
		const toViewportRect = (rect: DOMRect): DOMRect =>
			termDOM[kLayoutEngine].createDOMRect(
				rect.x,
				rect.y - termDOM.#documentScrollTop,
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
			return toViewportRect(rect || termDOM[kLayoutEngine].createDOMRect());
		};

		Element.prototype.getClientRects = function (): DOMRectList {
			if (!this.isConnected) {
				return termDOM[kLayoutEngine].createDOMRectList();
			}

			termDOM.#processPendingMutationsAndRender();

			const rects = termDOM[kLayoutEngine].getRects(this).map(toViewportRect);
			return termDOM[kLayoutEngine].createDOMRectList(rects);
		};

		// offsetWidth/offsetHeight/offsetTop/offsetLeft/offsetParent/clientWidth/
		// clientHeight/scrollWidth/scrollHeight -- the most commonly reached-for
		// measurement APIs, and previously entirely unimplemented (always
		// 0/null via jsdom's defaults). Every one of them is derived from
		// #layoutRectOf, the single place that decides "is this element
		// connected, has layout settled, what is its border-box rect" -- so
		// offsetWidth and clientWidth can never quietly disagree about which
		// rect they mean, and a future change to that decision (e.g. how
		// isConnected or render-flushing is handled) only has one place to make.
		//
		// #layoutRectOf returns the same rect getBoundingClientRect uses,
		// unrounded (each getter below rounds for its own purpose -- offsetTop
		// rounds the *difference* of two rects, not each rect independently, so
		// rounding here first would double-round and drift by a cell).
		const layoutRectOf = (element: Element): DOMRect | null => {
			if (!element.isConnected) return null;
			termDOM.#processPendingMutationsAndRender();
			return termDOM[kLayoutEngine].getRect(element);
		};

		// offsetParent walks the live DOM tree, not layout -- a separate concern
		// from #layoutRectOf, reused by offsetParent itself and by offsetTop/Left
		// to find what they're relative to.
		const offsetParentOf = (element: Element): HTMLElement | null => {
			for (
				let ancestor = element.parentElement;
				ancestor;
				ancestor = ancestor.parentElement
			) {
				const position = termDOM.window
					.getComputedStyle(ancestor)
					.getPropertyValue("position");
				if (position && position !== "static") {
					return ancestor as HTMLElement;
				}
			}
			return termDOM.document.body === element ? null : termDOM.document.body;
		};

		// The content+padding box (border-box rect minus border widths), which
		// both clientWidth/Height and (for now) scrollWidth/Height report -- see
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

		Object.defineProperty(this.window.HTMLElement.prototype, "offsetWidth", {
			get(this: Element) {
				return Math.round(layoutRectOf(this)?.width ?? 0);
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(this.window.HTMLElement.prototype, "offsetHeight", {
			get(this: Element) {
				return Math.round(layoutRectOf(this)?.height ?? 0);
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(this.window.HTMLElement.prototype, "offsetParent", {
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
		Object.defineProperty(this.window.HTMLElement.prototype, "offsetTop", {
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

		Object.defineProperty(this.window.HTMLElement.prototype, "offsetLeft", {
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
			Object.defineProperty(this.window.HTMLElement.prototype, prop, {
				get(this: Element) {
					return Math.round(contentBoxOf(this)?.width ?? 0);
				},
				configurable: true,
				enumerable: true,
			});
		}

		for (const prop of ["clientHeight", "scrollHeight"] as const) {
			Object.defineProperty(this.window.HTMLElement.prototype, prop, {
				get(this: Element) {
					return Math.round(contentBoxOf(this)?.height ?? 0);
				},
				configurable: true,
				enumerable: true,
			});
		}

		// Fullscreen API methods
		Element.prototype.requestFullscreen = function (
			this: Element,
			options?: FullscreenOptions,
		): Promise<void> {
			return termDOM.#fullscreenManager
				.requestFullscreen(this, options)
				.then(() => termDOM.#updateMouseReporting());
		};

		Document.prototype.exitFullscreen = function (
			this: Document,
		): Promise<void> {
			return termDOM.#fullscreenManager
				.exitFullscreen()
				.then(() => termDOM.#updateMouseReporting());
		};

		Object.defineProperty(Document.prototype, "fullscreenElement", {
			get: function (this: Document) {
				return termDOM.#fullscreenManager.fullscreenElement;
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
				y + termDOM.#documentScrollTop,
			);
		};

		// Override focus/blur to dispatch proper events
		const HTMLElement = this.window.HTMLElement;
		const originalFocus = HTMLElement.prototype.focus;
		const originalBlur = HTMLElement.prototype.blur;

		HTMLElement.prototype.focus = function (this: HTMLElement) {
			const prev = termDOM.document.activeElement;
			originalFocus.call(this);
			if (prev !== this) {
				// :focus rules match live, but computed styles are cached and
				// focus is not a mutation -- both moved elements must drop
				// their caches, and the repaint must happen even when no
				// listener mutates anything.
				termDOM.#styleManager.handleFocusChange(prev, this);
				void termDOM.#render();
				if (prev && prev !== termDOM.document.body) {
					prev.dispatchEvent(
						new termDOM.window.FocusEvent("blur", {
							relatedTarget: this,
							bubbles: false,
						}),
					);
					prev.dispatchEvent(
						new termDOM.window.FocusEvent("focusout", {
							relatedTarget: this,
							bubbles: true,
						}),
					);
				}
				this.dispatchEvent(
					new termDOM.window.FocusEvent("focus", {
						relatedTarget: prev,
						bubbles: false,
					}),
				);
				this.dispatchEvent(
					new termDOM.window.FocusEvent("focusin", {
						relatedTarget: prev,
						bubbles: true,
					}),
				);
			}
		};

		HTMLElement.prototype.blur = function (this: HTMLElement) {
			const wasFocused = termDOM.document.activeElement === this;
			originalBlur.call(this);
			if (wasFocused) {
				termDOM.#styleManager.handleFocusChange(this);
				void termDOM.#render();
				this.dispatchEvent(
					new termDOM.window.FocusEvent("blur", {
						relatedTarget: null,
						bubbles: false,
					}),
				);
				this.dispatchEvent(
					new termDOM.window.FocusEvent("focusout", {
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
				termDOM.document.body.scrollHeight,
			);
			const top = termDOM.#documentScrollTop;
			if (rect.top < top) {
				termDOM.#scrollCamera(rect.top - top);
			} else if (rect.bottom > top + regionHeight) {
				termDOM.#scrollCamera(rect.bottom - (top + regionHeight));
			}
		};
	}

	/**
	 * Get all focusable elements in tab order
	 */
	#getFocusableElements(): Element[] {
		const elements = Array.from(
			this.document.querySelectorAll(FOCUSABLE_SELECTOR),
		);
		return elements.sort((a, b) => {
			const aTab = parseInt(a.getAttribute("tabindex") || "0", 10);
			const bTab = parseInt(b.getAttribute("tabindex") || "0", 10);
			if (aTab !== bTab) {
				if (aTab > 0 && bTab > 0) return aTab - bTab;
				if (aTab > 0) return -1;
				if (bTab > 0) return 1;
			}
			return 0;
		});
	}

	/**
	 * Focus the next or previous focusable element
	 */
	#moveFocus(reverse: boolean): void {
		const focusable = this.#getFocusableElements();
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
	 * Handle input element default actions (character insertion, deletion, navigation)
	 */
	/**
	 * Flip a checkbox's checked state and fire `change`, matching a browser's
	 * Space-key default action for a focused checkbox -- never `input`, which
	 * checkboxes don't fire. Click doesn't need this: jsdom's own click
	 * activation behavior already toggles `.checked` and fires `change` (and
	 * already honors preventDefault on the click), so handling it here too
	 * would double-toggle.
	 */
	#toggleCheckbox(element: HTMLInputElement): void {
		element.checked = !element.checked;
		element.dispatchEvent(
			new this.window.Event("change", {bubbles: true, cancelable: false}),
		);
		this.#render();
	}

	#handleInputAction(
		element: HTMLInputElement,
		keyName: string,
		key: string,
		shiftKey: boolean,
		ctrlKey: boolean,
	): void {
		if (element.type === "checkbox" || element.type === "radio") {
			// Only Space activates these -- real browsers don't accept typed
			// text into them at all, so every other key here is a no-op. A
			// checkbox toggles; a radio only ever checks (Space on an
			// already-checked radio does nothing, per the browser default --
			// jsdom's checkedness setter handles unchecking the rest of the
			// same-name group).
			if (key === " ") {
				if (element.type === "checkbox") {
					this.#toggleCheckbox(element);
				} else if (!element.checked) {
					element.checked = true;
					element.dispatchEvent(
						new this.window.Event("change", {
							bubbles: true,
							cancelable: false,
						}),
					);
					this.#render();
				}
			}
			return;
		}

		// The caret IS the input's collapsed selection -- selectionStart/End/
		// Direction, the standard API, not a private shadow of it. That makes
		// the caret visible to setSelectionRange()/select() callers, and it
		// means a framework assigning .value can't strand it: per spec (and in
		// jsdom, verified) setting value collapses the selection to the end.
		// Direction carries which end of a selection is the moving focus, so
		// Shift+Left after Shift+Right shrinks the selection instead of
		// flipping it -- exactly the browser's anchor/focus model.
		const value = element.value;
		const start = element.selectionStart ?? value.length;
		const end = element.selectionEnd ?? value.length;
		const backward = element.selectionDirection === "backward";
		const caret = backward ? start : end;
		const anchor = backward ? end : start;
		const hasSelection = start !== end;

		let newValue = value;
		let newStart = start;
		let newEnd = end;
		let newDirection: "forward" | "backward" | "none" = "none";

		// Collapse the selection to a caret at `pos`.
		const collapse = (pos: number) => {
			newStart = newEnd = Math.max(0, Math.min(pos, newValue.length));
		};
		// Move the selection's focus (anchor stays), Shift+arrow style.
		const extend = (focus: number) => {
			const clamped = Math.max(0, Math.min(focus, value.length));
			newStart = Math.min(anchor, clamped);
			newEnd = Math.max(anchor, clamped);
			newDirection = clamped < anchor ? "backward" : "forward";
		};

		if (ctrlKey && keyName === "a") {
			// Select all, the browser's Ctrl+A. (Never Cmd+A here: Cmd chords
			// are consumed by the terminal app and don't reach the PTY.)
			extend(0);
			newStart = 0;
			newEnd = value.length;
			newDirection = "forward";
		} else if (keyName === "Backspace") {
			if (hasSelection) {
				newValue = value.slice(0, start) + value.slice(end);
				collapse(start);
			} else if (caret > 0) {
				newValue = value.slice(0, caret - 1) + value.slice(caret);
				collapse(caret - 1);
			}
		} else if (keyName === "Delete") {
			if (hasSelection) {
				newValue = value.slice(0, start) + value.slice(end);
				collapse(start);
			} else if (caret < value.length) {
				newValue = value.slice(0, caret) + value.slice(caret + 1);
				collapse(caret);
			}
		} else if (keyName === "ArrowLeft") {
			if (shiftKey) {
				extend(caret - 1);
			} else if (hasSelection) {
				// A plain arrow collapses to the selection's matching edge,
				// not one past it -- the browser behavior.
				collapse(start);
			} else {
				collapse(caret - 1);
			}
		} else if (keyName === "ArrowRight") {
			if (shiftKey) {
				extend(caret + 1);
			} else if (hasSelection) {
				collapse(end);
			} else {
				collapse(caret + 1);
			}
		} else if (keyName === "Home") {
			if (shiftKey) {
				extend(0);
			} else {
				collapse(0);
			}
		} else if (keyName === "End") {
			if (shiftKey) {
				extend(value.length);
			} else {
				collapse(value.length);
			}
		} else if (key.length === 1 && key.charCodeAt(0) >= 32) {
			// Printable character: replaces the selection, as in a browser.
			newValue = value.slice(0, start) + key + value.slice(end);
			collapse(start + 1);
		} else {
			return; // Not an input action
		}

		if (newValue !== value) {
			// Order matters: assigning .value collapses the selection to the
			// end (per spec), so the new caret must be set after.
			element.value = newValue;
			element.setSelectionRange(newStart, newEnd, newDirection);

			// Dispatch input event
			element.dispatchEvent(
				new this.window.Event("input", {bubbles: true, cancelable: false}),
			);

			// Trigger re-render since .value changes don't trigger MutationObserver
			this.#render();
		} else if (
			newStart !== start ||
			newEnd !== end ||
			(newStart !== newEnd && newDirection !== element.selectionDirection)
		) {
			// jsdom fires the `select` event itself for a real range change.
			element.setSelectionRange(newStart, newEnd, newDirection);
			this.#render();
		}
	}

	/**
	 * Split raw terminal input into key tokens: CSI sequences (ESC [ ... final
	 * byte), SS3 sequences (ESC O x), and single characters.
	 *
	 * Fast input arrives batched -- a held arrow key delivers
	 * "\x1b[B\x1b[B\x1b[B" in one chunk, and a terminal report can land glued to
	 * ordinary keystrokes. Anything that treats a chunk as one key swallows
	 * everything after the first token: a held arrow repeated once per chunk
	 * instead of once per press, and a stray cursor report ate every key packed
	 * behind it.
	 */
	*#tokenizeInput(input: string): Generator<string> {
		let i = 0;
		while (i < input.length) {
			if (input[i] === "\x1b" && i + 1 < input.length) {
				if (input[i + 1] === "[") {
					// CSI: parameter/intermediate bytes end at a final byte 0x40-0x7e.
					let end = i + 2;
					while (
						end < input.length &&
						!(input.charCodeAt(end) >= 0x40 && input.charCodeAt(end) <= 0x7e)
					) {
						end++;
					}
					yield input.slice(i, Math.min(end + 1, input.length));
					i = end + 1;
					continue;
				}
				if (input[i + 1] === "O" && i + 2 < input.length) {
					yield input.slice(i, i + 3);
					i += 3;
					continue;
				}
			}
			yield input[i];
			i++;
		}
	}

	/**
	 * Where a screen cell lands in the document, given who owns the camera.
	 * Returns null for cells above our region (a shell prompt is not part of
	 * the document).
	 */
	#screenToDocumentPoint(
		x: number,
		row: number,
	): {x: number; y: number} | null {
		if (this.#fullscreenManager.isFullscreen) {
			return {x, y: row + this.#scrollingManager.getScrollTop()};
		}
		const y =
			row - this.#scrollingManager.getScreenTop() + this.#documentScrollTop;
		return y < 0 ? null : {x, y};
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
		return findElementAtPoint(this, this.document.documentElement, x, y);
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
		if (!element || element instanceof (this.window as any).HTMLInputElement) {
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
		const shiftKey = (code & 4) !== 0;
		const altKey = (code & 8) !== 0;
		const ctrlKey = (code & 16) !== 0;
		const isMotion = (code & 32) !== 0;
		const base = code & ~(4 | 8 | 16 | 32);

		const point = this.#screenToDocumentPoint(col - 1, row - 1);
		const x = point?.x ?? col - 1;
		const y = point?.y ?? 0;
		// Already document-relative -- go straight to the shared hit-test rather
		// than through the public elementFromPoint, which expects viewport-
		// relative input and would convert it right back.
		const target =
			(point && this.#findElementAtDocumentPoint(x, y)) || this.document.body;

		// Wheel: 64 = up, 65 = down. One notch is three rows, the browser's
		// line-mode convention, and DOM_DELTA_LINE is literally true here.
		if (base === 64 || base === 65) {
			const deltaY = base === 64 ? -3 : 3;
			const notCanceled = target.dispatchEvent(
				new this.window.WheelEvent("wheel", {
					deltaY,
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
					deltaY < 0 &&
					this.#documentScrollTop === 0 &&
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
					this.#scrollCamera(deltaY);
				}
			}
			return;
		}

		// Buttons: 0/1/2 = left/middle/right. 3 is "no button" in the legacy
		// encoding; SGR names the button even on release, so 3 carries nothing.
		if (base > 2) return;
		const eventInit = {
			button: base === 1 ? 1 : base === 2 ? 2 : 0,
			buttons: isRelease ? 0 : base === 1 ? 4 : base === 2 ? 2 : 1,
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

				// Default action: mousedown collapses the document selection at
				// the pressed caret position and anchors a possible drag there,
				// as in a browser. Left button only -- and preventDefault on
				// mousedown suppresses it, which is exactly how apps that want
				// the drag events for themselves opt out.
				const selection = this.window.getSelection();
				if (base === 0 && selection) {
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
		// Releasing a selection drag offers the selected text to the system
		// clipboard via OSC 52 -- select-to-copy, the terminal's own
		// convention (a Cmd/Ctrl+C chord never reaches the PTY). Terminals
		// without OSC 52 support ignore the sequence entirely.
		let selectedByDrag = false;
		if (this.#selectionDragAnchor) {
			this.#selectionDragAnchor = null;
			const text = this.window.getSelection()?.toString() ?? "";
			if (text.length > 0) {
				selectedByDrag = true;
				this.#process.stdout.write(
					`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`,
				);
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

	#dispatchGlobalKeyboardEvent(chunk: Buffer): void {
		const key = chunk.toString("utf8");

		// Tokenize multi-key chunks and dispatch each token on its own.
		const tokens = Array.from(this.#tokenizeInput(key));
		if (tokens.length > 1) {
			for (const token of tokens) {
				this.#dispatchGlobalKeyboardEvent(Buffer.from(token));
			}
			return;
		}

		// A cursor position report is the terminal answering a query, not the
		// user pressing keys. With no query outstanding (a late or duplicate
		// answer), it is not a keystroke -- drop it rather than dispatching a
		// nonsense key event.
		if (/^\x1b\[\d+;\d+R$/.test(key)) {
			return;
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
		let targetElement =
			active && active !== this.document.body
				? active
				: this.#fullscreenManager.fullscreenElement || this.document.body;

		// Map common key codes (reuse logic from fullscreen manager)
		let keyName = key;
		let keyCode = 0;
		let charCode = key.charCodeAt(0);

		// Handle special keys
		// Detect modifier keys
		let shiftKey = false;
		let ctrlKey = false;
		let altKey = false;
		let metaKey = false;

		// Ctrl+<letter> arrives as a single raw ASCII control byte (Ctrl+A=0x01
		// ... Ctrl+Z=0x1A) -- there is no escape sequence, and no way to combine
		// it with Shift (the terminal only ever sends the one byte). Tab(0x09)
		// and Enter(0x0A/0x0D) are excluded even though they fall in this range:
		// a raw terminal genuinely cannot distinguish the physical Enter/Tab keys
		// from Ctrl+M/Ctrl+I, they are the identical byte, so the named key wins
		// -- matching every other terminal app. Ctrl+C(0x03) never reaches here:
		// it is intercepted earlier, unconditionally, for SIGINT.
		const modifiedArrow = key.match(/^\x1b\[1;(\d+)([ABCDHF])$/);
		if (
			charCode >= 1 &&
			charCode <= 26 &&
			charCode !== 9 &&
			charCode !== 10 &&
			charCode !== 13
		) {
			keyName = String.fromCharCode(charCode + 96); // 0x01 -> 'a' ... 0x1A -> 'z'
			keyCode = charCode + 64; // 'A'..'Z', the DOM keyCode for the letter itself
			ctrlKey = true;
		} else if (modifiedArrow) {
			// xterm's extended CSI encoding for a modified cursor key: CSI 1 ;
			// <mod> <letter>, e.g. Alt+Up = \x1b[1;3A, Shift+Home = \x1b[1;2H.
			// The tokenizer already yields this whole sequence as one token
			// unchanged -- it scans for the CSI final byte regardless of what
			// parameters precede it -- so this is pure decoding, no parsing
			// changes needed. mod-1 is a bitmask: 1=Shift, 2=Alt, 4=Ctrl,
			// 8=Meta (metaKey included for spec-completeness; nothing on macOS
			// actually sends it, since Cmd+key never reaches the PTY at all).
			const modifierBits = parseInt(modifiedArrow[1], 10) - 1;
			shiftKey = (modifierBits & 1) !== 0;
			altKey = (modifierBits & 2) !== 0;
			ctrlKey = (modifierBits & 4) !== 0;
			metaKey = (modifierBits & 8) !== 0;
			const cursorKeyByLetter: Record<string, [string, number]> = {
				A: ["ArrowUp", 38],
				B: ["ArrowDown", 40],
				C: ["ArrowRight", 39],
				D: ["ArrowLeft", 37],
				H: ["Home", 36],
				F: ["End", 35],
			};
			[keyName, keyCode] = cursorKeyByLetter[modifiedArrow[2]];
			charCode = 0;
		} else {
			switch (key) {
				case "\r":
				case "\n":
					keyName = "Enter";
					keyCode = 13;
					charCode = 13;
					break;
				case "\t":
					keyName = "Tab";
					keyCode = 9;
					charCode = 9;
					break;
				case "\x1b[Z":
					// Shift+Tab
					keyName = "Tab";
					keyCode = 9;
					charCode = 9;
					shiftKey = true;
					break;
				case "\x7f":
					keyName = "Backspace";
					keyCode = 8;
					charCode = 8;
					break;
				case "\x1b":
					// A lone Escape -- not the start of a CSI/SS3 sequence, since the
					// tokenizer already peels those off as their own multi-char tokens.
					keyName = "Escape";
					keyCode = 27;
					charCode = 0;
					break;
				case "\x1b[A":
					keyName = "ArrowUp";
					keyCode = 38;
					charCode = 0;
					break;
				case "\x1b[B":
					keyName = "ArrowDown";
					keyCode = 40;
					charCode = 0;
					break;
				case "\x1b[C":
					keyName = "ArrowRight";
					keyCode = 39;
					charCode = 0;
					break;
				case "\x1b[D":
					keyName = "ArrowLeft";
					keyCode = 37;
					charCode = 0;
					break;
				case "\x1b[H":
				case "\x1b[1~":
					keyName = "Home";
					keyCode = 36;
					charCode = 0;
					break;
				case "\x1b[F":
				case "\x1b[4~":
					keyName = "End";
					keyCode = 35;
					charCode = 0;
					break;
				case "\x1b[2~":
					keyName = "Insert";
					keyCode = 45;
					charCode = 0;
					break;
				case "\x1b[3~":
					keyName = "Delete";
					keyCode = 46;
					charCode = 0;
					break;
				case "\x1b[5~":
					keyName = "PageUp";
					keyCode = 33;
					charCode = 0;
					break;
				case "\x1b[6~":
					keyName = "PageDown";
					keyCode = 34;
					charCode = 0;
					break;
				// F1-F4: SS3 encoding, the modern xterm default. F5-F12: CSI-tilde --
				// note the historical gap (no ~16), a quirk of the original xterm
				// numbering every terminal descended from it still follows.
				case "\x1bOP":
					keyName = "F1";
					keyCode = 112;
					charCode = 0;
					break;
				case "\x1bOQ":
					keyName = "F2";
					keyCode = 113;
					charCode = 0;
					break;
				case "\x1bOR":
					keyName = "F3";
					keyCode = 114;
					charCode = 0;
					break;
				case "\x1bOS":
					keyName = "F4";
					keyCode = 115;
					charCode = 0;
					break;
				case "\x1b[15~":
					keyName = "F5";
					keyCode = 116;
					charCode = 0;
					break;
				case "\x1b[17~":
					keyName = "F6";
					keyCode = 117;
					charCode = 0;
					break;
				case "\x1b[18~":
					keyName = "F7";
					keyCode = 118;
					charCode = 0;
					break;
				case "\x1b[19~":
					keyName = "F8";
					keyCode = 119;
					charCode = 0;
					break;
				case "\x1b[20~":
					keyName = "F9";
					keyCode = 120;
					charCode = 0;
					break;
				case "\x1b[21~":
					keyName = "F10";
					keyCode = 121;
					charCode = 0;
					break;
				case "\x1b[23~":
					keyName = "F11";
					keyCode = 122;
					charCode = 0;
					break;
				case "\x1b[24~":
					keyName = "F12";
					keyCode = 123;
					charCode = 0;
					break;
				default:
					// For regular characters, keyCode is often the uppercase charCode
					if (key.length === 1) {
						keyCode = key.toUpperCase().charCodeAt(0);
					}
			}
		}

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

			// Input element default actions
			if (
				targetElement instanceof (this.window as any).HTMLInputElement &&
				(targetElement as HTMLInputElement).type !== "submit" &&
				(targetElement as HTMLInputElement).type !== "button"
			) {
				this.#handleInputAction(
					targetElement as HTMLInputElement,
					keyName,
					key,
					shiftKey,
					ctrlKey,
				);
			}
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

		this.#renderedOutsideMarkers = new WeakSet<Element>();
		this[kLayoutEngine].calculateLayout();

		const output = this.#renderer.renderStatic(
			this.document.body.scrollHeight,
			(ctx) => {
				this.#renderElement(this.document.body, ctx);
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
	 * See SCROLLBACK.md. Without this, content past the bottom of the terminal is
	 * never drawn at all.
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

		const contentHeight = this.document.body.scrollHeight;
		if (contentHeight === 0) return;

		const top = this.#scrollingManager.getScreenTop();

		// Back to the top of our region, and erase from there down. Only rows we
		// painted ourselves; the scrollback above is untouched.
		this.#process.stdout.write(`\x1b[${top + 1};1H\x1b[J`);

		const output = this.#renderer.renderStatic(
			contentHeight,
			(ctx) => {
				this.#renderElement(this.document.body, ctx);
			},
			"\r\n",
		);

		if (output) this.#process.stdout.write(output);
	}

	/** Write to stdout and wait for it to be flushed. */
	#write(output: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.#process.stdout.write(output, "utf8", (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
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
	 * Nothing of ours is committed. The document stays a single mutable thing that we
	 * repaint a window of -- so unlike flow mode, content that scrolls out of view is
	 * not frozen, and reflow anywhere is free.
	 */
	async #renderInteractive(): Promise<void> {
		// The previous document was sealed to scrollback by close(). Start a fresh
		// one below it: re-anchor to where the cursor now sits and reset the diff so
		// nothing composites over the frozen block.
		if (this.#sealed) {
			this.#sealed = false;
			this.#documentScrollTop = 0;
			this.#renderer.clearPreviousBuffer();
			if (this.#process.stdin?.isTTY) await this.#detectCommandStart();
		}

		// Our region starts at the command-start row, which cursor detection resolves
		// asynchronously. Render before it lands and the first frame anchors at row 0
		// while every diff after detection anchors one row lower -- the labels stay,
		// the values slide down a row. Wait for the anchor to settle first, exactly
		// as the flow path does.
		if (this.#cursorDetectionPromise) {
			await this.#cursorDetectionPromise;
		}

		const pending = this[kObserver].takeRecords();
		if (pending.length > 0) {
			this.#handlePendingMutations(pending);
		}

		this.#renderedOutsideMarkers = new WeakSet<Element>();
		this[kLayoutEngine].calculateLayout();

		const contentHeight = this.document.body.scrollHeight;
		const regionHeight = Math.min(contentHeight, this.#height);

		// Take the room we need by pushing earlier output up, never over it.
		const top = this.#reserveRows(regionHeight);

		// The camera cannot run off the end of the document.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		this.#documentScrollTop = Math.min(this.#documentScrollTop, maxScroll);

		const ansi = this.#renderer.renderFrame(
			-this.#documentScrollTop,
			(ctx) => {
				this.#renderElement(this.document.body, ctx);
			},
			top,
			top + regionHeight,
		);

		if (ansi) await this.#write(ansi);
		this.#afterRender();
	}

	/** Move the camera over the document. */
	#scrollCamera(rows: number): void {
		this.#documentScrollTop = Math.max(0, this.#documentScrollTop + rows);
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
		const top = this.#scrollingManager.getScreenTop();
		const overflow = top + rows - this.#height;

		if (overflow <= 0) return top;

		const push = Math.min(overflow, top);
		if (push > 0) {
			this.#process.stdout.write(
				`\x1b[${this.#height};1H` + "\x1bD".repeat(push),
			);
			// Do NOT shift the renderer's previous buffer. Its rows are relative to
			// the region top, and the top moves up by exactly the amount the screen
			// scrolled -- the two cancel, so buffer coordinates are unchanged.
			// Shifting it desynced the diff by `push` rows: the model compared
			// against the wrong screen rows, skipped cells it wrongly believed
			// unchanged, and composited the old frame under the new one whenever a
			// document-mode region grew past the space below the shell prompt.
			this.#scrollingManager.setScreenTop(top - push);
		}

		return this.#scrollingManager.getScreenTop();
	}

	/**
	 * Initialize cursor position detection for TTY environments
	 * This runs asynchronously during construction to set up proper viewport positioning
	 */
	#initializeCursorDetection(): void {
		this.#cursorDetectionPromise = null;
		// Only detect cursor position in TTY environments when enabled
		if (this.#detectCursorEnabled && this.#process.stdin?.isTTY) {
			// Set up cursor detection promise that render() will wait for
			this.#cursorDetectionPromise = Promise.race([
				this.#detectCommandStart().then(() => {}),
				// Fallback: if cursor detection takes too long, proceed without it
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					// If cursor detection fails, continue without it
					this.#hasDetectedCommandStart = false;
				})
				.finally(() => {
					// Clear the promise so subsequent renders don't wait
					this.#cursorDetectionPromise = null;
				});
		} else {
			// In non-TTY environments, don't set up cursor detection at all
			this.#cursorDetectionPromise = null;
		}
	}

	/**
	 * Detect current cursor position and set window.screenTop
	 * Sends \x1b[6n and waits for response \x1b[row;colR
	 */
	#detectCommandStart(): Promise<number> {
		this.attach();
		return new Promise<number>((resolve, reject) => {
			if (!this.#process.stdin?.isTTY) {
				reject(new Error("Cannot detect cursor position: stdin is not a TTY"));
				return;
			}

			let responseBuffer = "";

			const finish = () => {
				this.#cursorDetectionHandler = null;
				if (this.#cursorDetectionTimer !== null) {
					clearTimeout(this.#cursorDetectionTimer);
					this.#cursorDetectionTimer = null;
				}
			};

			// Set up cursor detection handler for unified stdin
			this.#cursorDetectionHandler = (dataStr: string) => {
				responseBuffer += dataStr;

				// Look for cursor position response pattern: \x1b[row;colR
				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					finish();

					const row = parseInt(match[1], 10);
					// Set window.screenTop (convert 1-based terminal row to 0-based)
					const screenTop = row - 1;
					this.#scrollingManager.setScreenTop(screenTop);

					// Set scrollTop to command start position (browser behavior)
					// For command start, we want content to shift up to terminal top
					this.#scrollingManager.scrollToCommandStart();

					this.#hasDetectedCommandStart = true;
					resolve(row);
				}
			};

			// Send cursor position query with proper flushing
			this.#process.stdout.write("\x1b[6n");

			// Force flush the output buffer (critical for cursor queries)
			if (typeof (this.#process.stdout as any)._flush === "function") {
				(this.#process.stdout as any)._flush();
			}

			// Timeout after 1000ms (reasonable balance for reliability). The timer is
			// held so it can be cleared the moment a response arrives -- otherwise it
			// keeps the event loop alive for a further second after we are done.
			this.#cursorDetectionTimer = setTimeout(() => {
				this.#cursorDetectionTimer = null;
				if (this.#cursorDetectionHandler) {
					this.#cursorDetectionHandler = null;
					reject(new Error("Timeout waiting for cursor position response"));
				}
			}, 1000);
		});
	}

	/**
	 * Ask the terminal where the cursor is (DSR) and resolve with its 0-based row.
	 *
	 * Used by the resize re-anchor: the cursor is parked on our content's bottom
	 * row after every frame, so after a rewrap its position names where the frame
	 * actually ended up. Rejects on timeout so the caller can fall back to a
	 * computed anchor.
	 */
	#queryCursorRow(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this.#process.stdin?.isTTY) {
				reject(new Error("stdin is not a TTY"));
				return;
			}

			// Queries can overlap: a drag fires resizes faster than the terminal
			// answers, and each handleResize issues its own query. The handler and
			// timer live in shared instance slots (so stdin routing and dispose can
			// see them), so every cleanup must check identity before clearing --
			// otherwise a superseded query's cleanup kills its successor's handler
			// and timeout, and that resize never redraws at all.
			let responseBuffer = "";
			let localTimer: ReturnType<typeof setTimeout> | null = null;

			const handler = (dataStr: string) => {
				responseBuffer += dataStr;
				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					if (this.#cursorDetectionHandler === handler) {
						this.#cursorDetectionHandler = null;
					}
					if (localTimer !== null) {
						clearTimeout(localTimer);
						if (this.#cursorDetectionTimer === localTimer) {
							this.#cursorDetectionTimer = null;
						}
						localTimer = null;
					}
					resolve(parseInt(match[1], 10) - 1);
				}
			};

			// Replacing a stale handler is fine: its own timeout still fires and
			// rejects it, and the caller's epoch check discards the stale result.
			this.#cursorDetectionHandler = handler;

			this.#process.stdout.write("\x1b[6n");
			if (typeof (this.#process.stdout as any)._flush === "function") {
				(this.#process.stdout as any)._flush();
			}

			// Short timeout: the redraw should feel immediate, and a terminal that
			// does not answer promptly falls back to the computed re-anchor.
			localTimer = setTimeout(() => {
				if (this.#cursorDetectionHandler === handler) {
					this.#cursorDetectionHandler = null;
				}
				if (this.#cursorDetectionTimer === localTimer) {
					this.#cursorDetectionTimer = null;
				}
				localTimer = null;
				reject(new Error("Timeout waiting for cursor position response"));
			}, 200);
			this.#cursorDetectionTimer = localTimer;
		});
	}

	/** Explicit resource management: `using dom = new TermDOM()` tears down on scope exit. */
	[Symbol.dispose](): void {
		this.dispose();
	}

	dispose(): void {
		undisposedInteractive.delete(this.#process);
		this.#attached = false;

		// Document mode has been painting a window in place, so nothing it showed
		// has reached the terminal's scrollback. Pay it all out now.
		this.#flushDocument();

		// Frames keep the terminal cursor hidden (it is parked for resize
		// bookkeeping, not UI); hand it back visible on the way out. The mouse
		// goes back to the terminal the same way.
		if (this.#mouseReportingEnabled) {
			this.#process.stdout.write("\x1b[?1006l\x1b[?1002l");
			this.#mouseReportingEnabled = false;
		}
		if (this.#interactive) {
			this.#process.stdout.write("\x1b[?25h");
		}

		// Tear down everything that holds the event loop open. Without this a
		// disposed TermDOM keeps the process alive -- via the process signal
		// listeners, the stdin data listener, and the cursor-detection timer -- and
		// across a whole test suite those accumulate until nothing can exit.
		if (this.#cursorDetectionTimer !== null) {
			clearTimeout(this.#cursorDetectionTimer);
			this.#cursorDetectionTimer = null;
		}
		if (this.#resizeTimer !== null) {
			clearTimeout(this.#resizeTimer);
			this.#resizeTimer = null;
		}
		if (this.#scrollChainTimer !== null) {
			clearTimeout(this.#scrollChainTimer);
			this.#scrollChainTimer = null;
		}
		this.#cursorDetectionHandler = null;

		if (this.#sigintHandler) {
			(this.#process as unknown as EventEmitter).removeListener?.(
				"SIGINT",
				this.#sigintHandler,
			);
			this.#sigintHandler = null;
		}
		if (this.#sigwinchHandler) {
			(this.#process as unknown as EventEmitter).removeListener?.(
				"SIGWINCH",
				this.#sigwinchHandler,
			);
			this.#sigwinchHandler = null;
		}

		if (this.#process.stdin?.isTTY) {
			const stdin = this.#process.stdin as TTYReadStream;
			if (this.#stdinDataHandler) {
				stdin.removeListener?.("data", this.#stdinDataHandler);
				this.#stdinDataHandler = null;
			}
			stdin.setRawMode?.(false);
			stdin.pause();
		}

		// Shadow DOM cleanup is automatic with symbol-based storage

		this[kObserver].disconnect();
		this.#styleManager.dispose();
		this[kLayoutEngine].dispose();
		this.#fullscreenManager.dispose();
		this.#observerManager.dispose();
		this.#jsdom.window.close();
	}
}

function findElementAtPoint(
	termDOM: TermDOM,
	element: Element,
	x: number,
	y: number,
): Element | null {
	if (element.nodeType !== 1) {
		return null;
	}

	try {
		// Document-relative, matching the document-relative x/y hit-testing
		// works in throughout -- not the public, viewport-relative
		// getClientRects(), which would need re-converting right back.
		const rects = termDOM[kLayoutEngine].getRects(element);
		if (!isPointInRects(x, y, rects)) {
			return null;
		}
	} catch (error) {
		return null;
	}

	// Use ExpandedTreeWalker to traverse children (including shadow DOM)
	const walker = createExpandedTreeWalker(termDOM.window, element);

	let child = walker.nextNode() as Element;
	while (child) {
		const result = findElementAtPoint(termDOM, child, x, y);
		if (result) {
			return result;
		}
		child = walker.nextNode() as Element;
	}

	return element;
}
