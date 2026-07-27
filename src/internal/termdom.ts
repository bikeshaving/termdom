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
	type ExpandedTreeWalker,
	getShadowRoot,
	hasShadowRoot,
	initializeShadowDOM,
	getPseudoMetadata,
} from "./composition.js";

// How long to wait for a resize drag to settle before redrawing. Long enough to
// coalesce the burst of SIGWINCHes a drag fires, short enough to feel immediate.
const RESIZE_DEBOUNCE_MS = 40;

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

// Test-only instance tracking. A test harness that creates many short-lived
// TermDOMs (and, being tests, does not always dispose them) can turn this on and
// dispose the leaked ones between tests. Off by default -- the set stays null and
// every hook below is a no-op -- so production pays nothing.
let trackedInstances: Set<TermDOM> | null = null;

// Frames keep the terminal cursor hidden, and dispose() shows it again -- but
// an app that calls process.exit() without disposing would strand the user's
// shell with no cursor. One process-level exit hook restores it for any live
// interactive instance that skipped dispose. Registered lazily, only for
// instances driving the real process (never for test mocks).
const undisposedInteractive = new Set<TermDOM>();
let exitHookInstalled = false;

// What Tab traverses and what a mousedown focuses -- one definition of
// "focusable" for both.
const FOCUSABLE_SELECTOR =
	'input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function installCursorRestoreOnExit(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const instance of undisposedInteractive) {
			try {
				// Mouse capture off (a no-op if it was never on), cursor back on.
				(instance as unknown as {process: ProcessLike}).process.stdout.write(
					"\x1b[?1006l\x1b[?1002l\x1b[?25h",
				);
			} catch {
				// The stream may already be gone; the shell will survive.
			}
		}
	});
}

/** Begin tracking TermDOM instances for later bulk disposal (test harness only). */
export function __enableInstanceTracking(): void {
	trackedInstances ??= new Set<TermDOM>();
}

/** Dispose every tracked, still-live TermDOM instance (test harness only). */
export function __disposeTrackedInstances(): void {
	if (!trackedInstances) return;
	for (const instance of trackedInstances) {
		try {
			instance.dispose();
		} catch {
			// Already disposed, or mid-teardown; ignore.
		}
	}
	trackedInstances.clear();
}

export class TermDOM {
	public readonly document: Document;
	public readonly window: DOMWindow;

	private readonly renderer: Renderer;
	private readonly layoutEngine: LayoutEngine;
	// TODO: Should we expose the JSDOM instance?
	private readonly jsdom: JSDOM;
	private readonly observer: MutationObserver;
	private readonly fullscreenManager: FullscreenManager;
	private readonly observerManager: ObserverManager;
	public readonly styleManager: StyleManager;
	private readonly scrollingManager: ScrollingManager;

	// Guard against re-entrant rendering. A render() call arriving while one is in
	// flight sets renderQueued rather than being dropped, so a trailing frame runs.
	private isRendering = false;
	private renderQueued = false;
	private renderInFlight: Promise<void> | null = null;

	// Monotonic frame counter, used to timestamp observer entries.
	private renderCount = 0;

	// Input element state tracking
	private inputCursorPositions = new WeakMap<Element, number>();
	private inputScrollOffsets = new WeakMap<Element, number>();

	// Track whether command start was explicitly detected (even if at row 1)
	private hasDetectedCommandStart: boolean = false;

	// The element that sat at the fold when we last committed, and where it sat.
	// If the content above the fold changes height, this element moves -- which is
	// how we notice that the committed rows no longer mean what they meant.
	private foldAnchor: {element: Element; top: number} | null = null;

	// Document rows that have scrolled off the top into the terminal's scrollback.
	// The cursor cannot address scrollback, so these are frozen for good: they can
	// never be redrawn. Everything below them is the live, addressable viewport.
	private committedRows = 0;

	// Unified stdin handling
	private cursorDetectionHandler: ((data: string) => void) | null = null;

	// Handles and timers that must be torn down in dispose(), or they keep the
	// process alive after the app is done -- which, across a test suite, piles up
	// into a hang.
	private sigintHandler: (() => void) | null = null;
	private sigwinchHandler: (() => void) | null = null;
	private stdinDataHandler: ((chunk: string | Buffer) => void) | null = null;
	private cursorDetectionTimer: ReturnType<typeof setTimeout> | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	// True from the first SIGWINCH of a resize until the re-anchored redraw. While
	// set, render() bails: the terminal has rewrapped the screen and our anchor is
	// momentarily stale, so an auto-render (an animation tick) painting now lands
	// at the wrong rows and scrolls a stray copy into the scrollback. Only the
	// final redraw that handleResize issues is allowed through.
	private resizeInProgress = false;
	// Whether we have taken hold of the terminal: raw mode, signal handlers,
	// the stdin listener and the cursor query. Construction never touches the
	// process -- attach() does, lazily on the first render or explicitly.
	private attached = false;
	// Bumped on every SIGWINCH. The re-anchor waits on an async cursor query;
	// if another resize lands while it is in flight, the stale response must not
	// trigger a redraw at coordinates that no longer mean anything.
	private resizeEpoch = 0;

	// Promise that resolves when cursor detection completes (or times out)
	private cursorDetectionPromise: Promise<void> | null = null;

	private width: number;
	private height: number;
	/**
	 * How the document scrolls.
	 *
	 * - `flow`: the document accumulates. Rows that scroll off the top are committed
	 *   to the terminal's scrollback, frozen and unaddressable. This is what an
	 *   ordinary command does.
	 * - `document`: the document is a fixed thing the user moves a camera over. We
	 *   own a region of the screen and repaint a window of the document into it.
	 *   Nothing is committed, so nothing is frozen: the whole document stays
	 *   mutable.
	 *
	 * This is *not* the same axis as whether we occupy the whole screen.
	 * requestFullscreen() is about screen ownership -- a user-facing experience --
	 * and the alternate buffer is one way to implement it. Document mode still
	 * starts at the command height and still respects what came before it.
	 */
	private viewportMode: "flow" | "document" = "flow";

	/** Which document row sits at the top of our region, in document mode. */
	private documentScrollTop = 0;

	// Whether the terminal is currently reporting mouse events to us. See
	// updateMouseReporting for when capture is on.
	private mouseReportingEnabled = false;
	// Scroll chaining yielded the mouse back to the terminal: the camera hit
	// the document top and the user kept scrolling up, so the wheel now
	// belongs to the terminal's own scrollback. Cleared by the next keystroke
	// -- terminals snap to the live screen on input, which is exactly the
	// moment the wheel should become ours again.
	private mouseCaptureYielded = false;
	// Where the last mousedown landed, so a mouseup on the same element
	// becomes a click. (Browsers dispatch click at the nearest common
	// ancestor; the same-element case is the one that matters on a cell grid.)
	private mouseDownTarget: Element | null = null;
	private readonly process: ProcessLike;

	private readonly detectCursorEnabled: boolean;

	// A stdout that is not a terminal -- a pipe, a file, a CI log -- has no
	// viewport, no cursor, no scrollback and no resize. It cannot interpret cursor
	// movement either, so the interactive frame would write CUP and DECSC sequences
	// straight into the file.
	private readonly interactive: boolean;

	constructor(options: TermDOMOptions = {}) {
		this.process = options.process || process;
		this.interactive = this.process.stdout.isTTY !== false;
		this.detectCursorEnabled =
			(options.detectCursor ?? this.process === process) && this.interactive;

		this.width = options.width || this.process.stdout.columns || 80;
		this.height = options.height || this.process.stdout.rows || 24;

		this.jsdom = new JSDOM(
			"<!DOCTYPE html><html><head></head><body></body></html>",
			{pretendToBeVisual: true},
		);

		this.window = this.jsdom.window;
		this.document = this.jsdom.window.document;

		// Setup DOM inspector
		setupInspectMethods(this.window);

		// Setup shadow DOM support
		initializeShadowDOM(this.window);

		this.initializeConstructorExtensions();
		this.renderer = new Renderer(
			this.height,
			this.width,
			options.colorDepth || detectColorDepth(this.process),
		);

		// Setup style management FIRST to override getComputedStyle before LayoutEngine uses it
		this.styleManager = new StyleManager(this.window);

		// Create layout engine after StyleManager overrides getComputedStyle
		this.layoutEngine = new LayoutEngine(this.jsdom.window);
		this.styleManager.setLayoutEngine(this.layoutEngine);
		this.layoutEngine.resize(this.width, this.height);
		this.fullscreenManager = new FullscreenManager(this.process);
		this.observerManager = new ObserverManager(this.createObserverHost());

		this.initializeWindow();
		this.installObservers();

		// Initialize scrolling management after window setup
		this.scrollingManager = new ScrollingManager(this.window, this.document);

		this.observer = this.setupMutationObserver();

		// Initial processing of all elements is handled by StyleManager's constructor

		trackedInstances?.add(this);
	}

	/**
	 * Get cached shadow root for an element (works with both open and closed shadows)
	 */
	getShadowRoot(element: Element): ShadowRoot | null {
		return getShadowRoot(element);
	}

	/**
	 * Check if an element has a shadow root
	 */
	hasShadowRoot(element: Element): boolean {
		return hasShadowRoot(element);
	}

	/**
	 * Create an ExpandedTreeWalker that can traverse pseudo-elements, shadow DOM, and slot content
	 */
	createExpandedTreeWalker(root: Node): ExpandedTreeWalker {
		return createExpandedTreeWalker(this.window, root);
	}

	private initializeWindow(): void {
		const window = this.window;
		Object.defineProperty(window, "innerWidth", {
			value: this.width,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "innerHeight", {
			value: this.height,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "outerWidth", {
			value: this.width,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "outerHeight", {
			value: this.height,
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

		// Standard window scrolling, mapped onto the document-mode camera. In flow
		// mode scrollY reports how far the content has scrolled; scrollBy only
		// means something when there is a camera to move.
		const termDOM = this;
		Object.defineProperty(window, "scrollY", {
			get: () =>
				termDOM.viewportMode === "document"
					? termDOM.documentScrollTop
					: Math.max(0, -termDOM.scrollingManager.getScrollTop()),
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
			termDOM.scrollDocumentBy(dy);
		}) as typeof window.scrollBy;

		// Implement standard DOM scrollHeight properties
		Object.defineProperty(this.document.body, "scrollHeight", {
			get() {
				return termDOM.layoutEngine.getContentHeight();
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(this.document.documentElement, "scrollHeight", {
			get() {
				return termDOM.layoutEngine.getContentHeight();
			},
			configurable: true,
			enumerable: true,
		});

		// clientHeight is the viewport height (terminal height)
		Object.defineProperty(this.document.body, "clientHeight", {
			get() {
				return termDOM.height;
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(this.document.documentElement, "clientHeight", {
			get() {
				return termDOM.height;
			},
			configurable: true,
			enumerable: true,
		});
	}

	private setupMutationObserver(): MutationObserver {
		const observer = new this.window.MutationObserver((mutations) => {
			// Process mutations in correct order to avoid race conditions
			this.styleManager.handleMutations(mutations); // First: attach pseudo-elements, invalidate caches
			this.layoutEngine.handleMutations(mutations); // Second: process DOM changes for layout
			this.render(); // Finally: render with fully processed DOM
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
		if (this.attached) return;
		this.attached = true;

		this.setupProcessHandlers();
		this.updateMouseReporting();
		this.initializeCursorDetection();

		// See installCursorRestoreOnExit: if this instance dies without
		// dispose(), the exit hook hands the user their cursor back.
		if (this.interactive && this.process === process) {
			undisposedInteractive.add(this);
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
	private updateMouseReporting(): void {
		const wanted =
			this.attached &&
			this.interactive &&
			Boolean(this.process.stdin?.isTTY) &&
			!this.mouseCaptureYielded &&
			(this.viewportMode === "document" || this.fullscreenManager.isFullscreen);
		if (wanted === this.mouseReportingEnabled) return;
		this.mouseReportingEnabled = wanted;
		// 1002: button presses, releases, wheel, and drag motion (no move flood
		// while nothing is pressed). 1006: SGR encoding, the only one that is
		// unambiguous past column 223.
		this.process.stdout.write(
			wanted ? "\x1b[?1002h\x1b[?1006h" : "\x1b[?1006l\x1b[?1002l",
		);
	}

	// TODO: This should be put in an event translator abstraction
	private setupProcessHandlers(): void {
		this.sigintHandler = () => {
			this.dispose();
			this.process.exit(0);
		};
		this.process.on("SIGINT", this.sigintHandler);

		this.sigwinchHandler = () => this.scheduleResize();
		this.process.on("SIGWINCH", this.sigwinchHandler);

		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin;
			if (!stdin) return;

			// Configure terminal for proper input handling (once)
			stdin.setRawMode?.(true);
			stdin.resume();
			stdin.setEncoding?.("utf8");

			// Single unified handler for all stdin data
			this.stdinDataHandler = (chunk: string | Buffer) => {
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
				if (this.cursorDetectionHandler && report) {
					this.cursorDetectionHandler(report[0]);
					const rest =
						dataStr.slice(0, report.index) +
						dataStr.slice((report.index ?? 0) + report[0].length);
					if (rest.length === 0) return;
					if (this.stdinDataHandler) {
						this.stdinDataHandler(rest);
					}
					return;
				}

				// Route 2: Ctrl-C handling (high priority) - check raw bytes
				if (data.length > 0 && data[0] === 0x03) {
					this.dispose();
					return this.process.exit(0);
				}

				// Route 3: SGR mouse reports. Peeled off token by token so a report
				// glued to fast keystrokes ("jj\x1b[<65;4;7Mjj") eats neither side,
				// and BEFORE the fullscreen filter below -- fullscreen is a
				// mouse-capturing mode, so its reports must not be dropped with the
				// keyboard events.
				let keyInput = "";
				for (const token of this.tokenizeInput(dataStr)) {
					const mouse = token.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
					if (mouse) {
						this.handleMouseReport(
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
				if (this.mouseCaptureYielded) {
					this.mouseCaptureYielded = false;
					this.updateMouseReporting();
				}

				// TODO: Why does this filter on fullscreen????
				// Route 4: General keyboard events (when not in fullscreen)
				if (!this.fullscreenManager.isFullscreen) {
					this.dispatchGlobalKeyboardEvent(Buffer.from(keyInput));
				}
			};
			stdin.on("data", this.stdinDataHandler);
		}
	}

	async render(): Promise<void> {
		this.attach();

		// A resize is settling: suppress every render until handleResize issues the
		// single re-anchored redraw. See resizeInProgress.
		if (this.resizeInProgress) {
			return;
		}

		// A render in flight: coalesce, don't drop. Dropping an auto-render (a
		// mutation observer firing mid-frame) leaves the diff renderer's
		// previous-buffer out of step with the screen, which shows up as rows drawn
		// at the wrong place. Instead mark one pending and hand back the running
		// loop's promise: it will fold this caller's changes into a trailing frame,
		// so awaiting render() always means "what I changed is painted".
		if (this.isRendering) {
			this.renderQueued = true;
			return this.renderInFlight ?? Promise.resolve();
		}

		this.isRendering = true;
		this.renderInFlight = (async () => {
			try {
				do {
					this.renderQueued = false;
					await this.renderOnce();
				} while (this.renderQueued);
			} finally {
				this.isRendering = false;
				this.renderInFlight = null;
			}
		})();
		return this.renderInFlight;
	}

	private async renderOnce(): Promise<void> {
		if (!this.interactive) {
			await this.renderStatic();
			return;
		}

		if (this.viewportMode === "document") {
			await this.renderDocumentMode();
			return;
		}

		// Wait for cursor detection to complete before first render
		if (this.cursorDetectionPromise) {
			await this.cursorDetectionPromise;
		}

		// Process any pending mutations first (for direct render() calls)
		const pendingMutations = this.observer.takeRecords();
		if (pendingMutations.length > 0) {
			this.styleManager.handleMutations(pendingMutations);
			this.layoutEngine.handleMutations(pendingMutations);
		}

		// Clear the rendered markers set for this frame
		this.renderedOutsideMarkers = new WeakSet<Element>();

		// Note: refreshStylesheets() is called by mutation observer when stylesheets change

		// Always use auto height for natural content sizing and scrolling
		this.layoutEngine.calculateLayout();

		// Content taller than the room left below the command start has to push the
		// command start upward, so the overflow scrolls into the terminal's native
		// scrollback -- exactly as a normal command's output does. Without this the
		// rows past the bottom of the terminal are simply never drawn, and the
		// content is silently lost.
		if (this.hasDetectedCommandStart) {
			this.pushUpForOverflow();
		}

		// Which *region* of the document we draw is a different question from how we
		// position the cursor to draw it. The resize path deliberately unsets
		// hasDetectedCommandStart so the frame is placed with DECRC rather than CUP
		// -- and keying the region on that flag too meant a resize fell back to a
		// stale scroll offset and painted over rows the terminal had just handed
		// back to us out of scrollback.
		const flow = this.interactive;

		// If the document reflowed above the fold, the commit index no longer refers
		// to the same content: printing from it would duplicate rows into the
		// scrollback and drop the newly inserted ones. We cannot correct what is
		// already in the scrollback, so we print the document again below it.
		if (flow && this.hasReflowedAboveFold()) {
			await this.reprintAsNewBlock();
			this.layoutEngine.calculateLayout();
		}

		// The document rows still ours to draw: everything below what has already
		// scrolled into the scrollback. On a frame where the content has grown this
		// region is taller than the terminal, and printing it is what scrolls the
		// terminal and commits the overflow to scrollback.
		const contentHeight = this.document.body.scrollHeight;

		// Flow mode's commit index is a document row number, so it only means
		// anything while the document is append-only. If the document shrinks below
		// what has already been committed -- rows removed, or cleared -- the index
		// points past the end and there is nothing left to draw, which blanked the
		// screen entirely. Clamp it back to what the document can actually support.
		//
		// This is a floor, not a fix: reflow *above* the fold still shifts every row
		// number underneath the commit index, and the scrollback cannot be rewritten
		// to match. See the note in SCROLLBACK.md.
		const maxCommitted = Math.max(0, contentHeight - this.height);
		if (this.committedRows > maxCommitted) {
			this.committedRows = maxCommitted;
		}

		const regionRows = Math.max(0, contentHeight - this.committedRows);

		// Where on screen that region begins. Once anything has been committed the
		// content fills the terminal from its top row.
		const startRow =
			this.committedRows > 0 ? 0 : this.scrollingManager.getScreenTop();

		const viewportOffset = flow
			? -this.committedRows
			: -this.scrollingManager.getScrollTop();

		const cursorPosition = this.hasDetectedCommandStart ? startRow : undefined;

		const ansi = this.renderer.renderFrame(
			viewportOffset,
			(ctx) => {
				this.renderElement(this.document.body, ctx);
			},
			cursorPosition,
			flow ? startRow + regionRows : undefined,
		);

		// Printing past the bottom margin scrolls the terminal, and those rows are
		// now in its scrollback -- permanently, and beyond our reach.
		if (flow) {
			const scrolled = Math.max(0, startRow + regionRows - this.height);
			if (scrolled > 0) {
				this.committedRows += scrolled;
				this.scrollingManager.setScreenTop(Math.max(0, startRow - scrolled));
			}
			this.updateFoldAnchor();
		}

		if (ansi) {
			await new Promise<void>((resolve, reject) => {
				this.process.stdout.write(ansi, "utf8", (error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		}

		this.afterRender();
	}

	// TODO: many of the following methods do not belong on the TermDOM class
	private renderElement(
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
			this.layoutEngine.isSubtreeOutsideBand(
				element,
				bandTop,
				bandTop + ctx.rows,
			)
		) {
			return;
		}

		const rect = this.layoutEngine.getRect(element);

		const color = this.window
			.getComputedStyle(element)
			.getPropertyValue("color");
		const backgroundColor = this.window
			.getComputedStyle(element)
			.getPropertyValue("background-color");
		const bold =
			this.window.getComputedStyle(element).getPropertyValue("font-weight") ===
			"bold";
		const italic =
			this.window.getComputedStyle(element).getPropertyValue("font-style") ===
			"italic";
		const underline = this.window
			.getComputedStyle(element)
			.getPropertyValue("text-decoration")
			.includes("underline");

		const style = {
			fg: color && color !== "initial" ? cssColorToNumber(color) : undefined,
			bg:
				backgroundColor &&
				backgroundColor !== "initial" &&
				backgroundColor !== "transparent"
					? cssColorToNumber(backgroundColor)
					: undefined,
			bold,
			italic,
			underline,
		};

		if (rect && style.bg != null) {
			ctx.fillRect(rect.left, rect.top, rect.width, rect.height, style.bg);
		}

		// Handle tables with TanStack integration
		const display = this.window
			.getComputedStyle(element)
			.getPropertyValue("display");
		if (display === "table" && rect) {
			this.renderTable(element, rect, style);
			// Continue with normal child rendering
		}

		// Handle borders
		if (rect) {
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
		this.renderOutsideMarker(element, ctx);

		// Render input elements (void elements with no children)
		if (
			element.tagName === "INPUT" &&
			rect &&
			(element as HTMLInputElement).type !== "hidden"
		) {
			this.renderInputElement(element as HTMLInputElement, rect, style, ctx);
			return; // Input elements have no children to render
		}

		// Note: JSDOM automatically calls connectedCallback() when elements are added to DOM
		// No manual lifecycle management needed

		// Use ExpandedTreeWalker to render all children including pseudo-elements and shadow DOM
		const walker = this.createExpandedTreeWalker(element);

		// Collect the children first, then paint them in z-order. Painting straight
		// down the tree in document order means nothing can ever sit on top of
		// anything else, which is why an overlay or a modal was impossible: it
		// would be painted before the content it is supposed to cover.
		const children: Array<{node: Node; zIndex: number}> = [];
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
				this.layoutEngine.isSubtreeOutsideBand(
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
						? this.zIndexOf(childNode as Element)
						: 0,
			});
		}

		// A stable sort, so boxes at the same level keep their document order and
		// only an explicit z-index moves anything.
		children.sort((a, b) => a.zIndex - b.zIndex);

		for (const {node: childNode} of children) {
			if (childNode.nodeType === childNode.ELEMENT_NODE) {
				const childElement = childNode as Element;
				if (childElement instanceof (this.window as any).HTMLElement) {
					this.renderElement(childElement, ctx);
				}
			} else if (childNode.nodeType === childNode.TEXT_NODE) {
				const textNode = childNode as Text;
				this.renderText(textNode, ctx);
			}
		}
	}

	/**
	 * The paint order of a box relative to its siblings.
	 *
	 * z-index only applies to positioned boxes, so a static one always sits at 0
	 * and keeps its document order.
	 */
	private zIndexOf(element: Element): number {
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
	private renderedOutsideMarkers = new WeakSet<Element>();

	private renderOutsideMarker(
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
		if (this.renderedOutsideMarkers.has(element)) {
			return;
		}
		this.renderedOutsideMarkers.add(element);

		// Get marker content from StyleManager
		const markerContent = this.styleManager.getMarkerContent(element);
		if (!markerContent) {
			return;
		}

		const rect = this.layoutEngine.getRect(element);
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
		const markerBold = markerStyle.getPropertyValue("font-weight") === "bold";
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
	private renderInputElement(
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

		const value = element.value || "";
		const placeholder = element.getAttribute("placeholder") || "";
		const isFocused = element === this.document.activeElement;

		let displayText: string;
		let textStyle = {...style};

		if (value) {
			displayText = value;
		} else if (placeholder && !isFocused) {
			displayText = placeholder;
			// Dim the placeholder text
			textStyle.fg = 0x808080;
		} else {
			displayText = "";
		}

		// Everything below measures in CELLS, not characters. CJK text is two
		// cells per glyph, so character arithmetic put the caret mid-text (IME
		// composition then anchored on top of already-typed glyphs) and padEnd
		// by character count pushed the value's background straight through the
		// input's right border.
		let scrollOffset = this.inputScrollOffsets.get(element) ?? 0;
		const cursor = this.inputCursorPositions.get(element) ?? value.length;

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
			this.inputScrollOffsets.set(element, scrollOffset);
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
		visibleText += " ".repeat(Math.max(0, contentWidth - usedCells));

		ctx.setText(contentX, contentY, visibleText, textStyle);

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
	private renderText(
		textNode: Text,
		ctx: import("./ansi.js").DrawingContext,
	): void {
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

		const textColor = computedStyle.getPropertyValue("color");
		const textBgColor = computedStyle.getPropertyValue("background-color");
		const textBold = computedStyle.getPropertyValue("font-weight") === "bold";
		const textItalic =
			computedStyle.getPropertyValue("font-style") === "italic";
		const textUnderline = computedStyle
			.getPropertyValue("text-decoration")
			.includes("underline");

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
			italic: textItalic,
			underline: textUnderline,
		};

		const rectTexts = this.layoutEngine.getRectTexts(textNode);
		if (rectTexts.length > 0) {
			for (const rectText of rectTexts) {
				if (rectText.text.length > 0) {
					ctx.setText(
						Math.round(rectText.rect.x),
						Math.round(rectText.rect.y),
						rectText.text,
						textStyle,
					);
				}
			}
		}
	}

	// TODO: move this to tables.ts? or layout.ts
	private renderTable(
		tableElement: Element,
		_rect: DOMRect,
		_style: any,
	): void {
		// For now, let's fall back to normal rendering and let CSS handle table layout
		// The layout engine should already handle display: table properly
		// TODO: Implement table-specific optimizations like borders between cells

		// Check if we have proper table children, if not, render as normal element
		const hasTableStructure = this.hasTableStructure(tableElement);
		if (!hasTableStructure) {
			// Render children normally
			return;
		}

		// For tables with proper structure, add table-specific border rendering
		this.renderTableBorders(tableElement, _rect, _style);
	}

	private hasTableStructure(tableElement: Element): boolean {
		// Check if element has table-like children (thead, tbody, tr, etc.)
		const tableElements = ["thead", "tbody", "tfoot", "tr", "th", "td"];
		return Array.from(tableElement.children).some((child) =>
			tableElements.includes(child.tagName?.toLowerCase() || ""),
		);
	}

	private renderTableBorders(
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

	private processPendingMutationsAndRender(): boolean {
		// A geometry read (getBoundingClientRect, elementFromPoint) needs fresh
		// *layout*, not fresh pixels. This used to fire a full render() here, so
		// every rect read with pending mutations painted a frame -- an app calling
		// scrollIntoView on each keystroke paid two paints per key, and the rect
		// could still be stale because the render was not awaited. Flushing
		// mutations and laying out synchronously gives an exact rect; painting
		// stays with the caller's own render. The dirty-skip makes this free when
		// nothing changed.
		const pendingMutations = this.observer.takeRecords();
		const hadMutations = pendingMutations.length > 0;
		if (hadMutations) {
			// Process mutations in the same order as MutationObserver callback
			this.styleManager.handleMutations(pendingMutations);
			this.layoutEngine.handleMutations(pendingMutations);
		}
		this.layoutEngine.calculateLayout();
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
	private scheduleResize(): void {
		// Suppress renders from the very first SIGWINCH, before the debounce
		// settles, so a drag's worth of animation ticks cannot paint at the stale
		// anchor while the terminal is rewrapping under us.
		this.resizeInProgress = true;
		this.resizeEpoch++;
		if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
		this.resizeTimer = setTimeout(() => {
			this.resizeTimer = null;
			this.handleResize();
		}, RESIZE_DEBOUNCE_MS);
	}

	private handleResize(): void {
		const newWidth = this.process.stdout.columns || 80;
		const newHeight = this.process.stdout.rows || 24;

		this.width = newWidth;
		this.height = newHeight;

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

		this.renderer.resize(newHeight, newWidth);
		this.layoutEngine.resize(newWidth, newHeight);

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
		this.layoutEngine.calculateLayout();
		const contentHeight = this.document.body.scrollHeight;
		const wrappedRowsAbove = this.renderer.wrappedRowsAboveCursorPark(newWidth);
		const epoch = this.resizeEpoch;

		const redraw = (startRow: number) => {
			this.committedRows = 0;
			this.foldAnchor = null;
			this.scrollingManager.setScreenTop(startRow);
			this.scrollingManager.scrollToCommandStart();
			this.renderer.resetScreen(startRow);

			// Everything suppressed since the first SIGWINCH may paint again. The
			// frame is placed by the screen reset, not by cursor detection.
			this.resizeInProgress = false;
			const wasDetected = this.hasDetectedCommandStart;
			this.hasDetectedCommandStart = false;
			this.render().then(() => {
				this.hasDetectedCommandStart = wasDetected;
			});
		};

		const computedReanchor = () => {
			const previousStart = this.scrollingManager.getScreenTop();
			const scrolledUp = Math.max(0, previousStart + contentHeight - newHeight);
			return Math.max(0, previousStart - scrolledUp);
		};

		if (
			this.detectCursorEnabled &&
			this.process.stdin?.isTTY &&
			wrappedRowsAbove !== null
		) {
			this.queryCursorRow()
				.then((cursorRow) => {
					// A newer resize superseded this one; its handler will redraw.
					if (epoch !== this.resizeEpoch) return;
					const startRow = Math.max(0, cursorRow - wrappedRowsAbove);
					redraw(startRow);
				})
				.catch(() => {
					if (epoch !== this.resizeEpoch) return;
					const startRow = computedReanchor();
					redraw(startRow);
				});
		} else {
			const startRow = computedReanchor();
			redraw(startRow);
		}
	}

	/** The measurement surface the observers read each frame. See ObserverHost. */
	private createObserverHost(): ObserverHost {
		return {
			getBorderBox: (element) => {
				const rect = this.layoutEngine.getRect(element);
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
				const rect = this.layoutEngine.getRect(element);
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
				const scrollTop =
					this.viewportMode === "document"
						? this.documentScrollTop
						: Math.max(0, -this.scrollingManager.getScrollTop());
				return {
					top: scrollTop,
					left: 0,
					width: this.width,
					height: this.height,
				};
			},
			now: () => this.renderCount,
		};
	}

	/**
	 * Run the observers against the layout just produced.
	 *
	 * Called after every render, once isRendering is clear -- a callback that
	 * mutates the DOM schedules the next frame through the mutation observer, so
	 * there is no re-entrancy to guard against here.
	 */
	private afterRender(): void {
		this.renderCount++;
		this.observerManager.flush();
	}

	/** Install the observer constructors on the window, bound to this instance. */
	private installObservers(): void {
		const manager = this.observerManager;
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
	private initializeConstructorExtensions(): void {
		const {Element, Document} = this.window;
		const termDOM = this;

		Element.prototype.getBoundingClientRect = function (
			this: Element,
		): DOMRect {
			if (!this.isConnected) {
				return termDOM.layoutEngine.createDOMRect(0, 0, 0, 0);
			}

			termDOM.processPendingMutationsAndRender();

			const rect = termDOM.layoutEngine.getRect(this);
			return rect || termDOM.layoutEngine.createDOMRect(0, 0, 0, 0);
		};

		Element.prototype.getClientRects = function (): DOMRectList {
			if (!this.isConnected) {
				return termDOM.layoutEngine.createDOMRectList();
			}

			termDOM.processPendingMutationsAndRender();

			const rects = termDOM.layoutEngine.getRects(this);
			return termDOM.layoutEngine.createDOMRectList(rects);
		};

		// Fullscreen API methods
		Element.prototype.requestFullscreen = function (
			this: Element,
			options?: FullscreenOptions,
		): Promise<void> {
			return termDOM.fullscreenManager
				.requestFullscreen(this, options)
				.then(() => termDOM.updateMouseReporting());
		};

		Document.prototype.exitFullscreen = function (
			this: Document,
		): Promise<void> {
			return termDOM.fullscreenManager
				.exitFullscreen()
				.then(() => termDOM.updateMouseReporting());
		};

		Object.defineProperty(Document.prototype, "fullscreenElement", {
			get: function (this: Document) {
				return termDOM.fullscreenManager.fullscreenElement;
			},
			configurable: true,
		});

		Document.prototype.elementFromPoint = function (
			x: number,
			y: number,
		): Element | null {
			termDOM.processPendingMutationsAndRender();
			return findElementAtPoint(termDOM, this.documentElement, x, y);
		};

		// Override focus/blur to dispatch proper events
		const HTMLElement = this.window.HTMLElement;
		const originalFocus = HTMLElement.prototype.focus;
		const originalBlur = HTMLElement.prototype.blur;

		HTMLElement.prototype.focus = function (this: HTMLElement) {
			const prev = termDOM.document.activeElement;
			originalFocus.call(this);
			if (prev !== this) {
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
			const rect = this.getBoundingClientRect();

			// In document mode the rect is in document rows and the camera shows
			// [documentScrollTop, documentScrollTop + region). Move the camera the
			// minimal amount that brings the element into it -- the standard
			// block: "nearest" behavior.
			if (termDOM.viewportMode === "document") {
				const regionHeight = Math.min(
					termDOM.height,
					termDOM.document.body.scrollHeight,
				);
				const top = termDOM.documentScrollTop;
				if (rect.top < top) {
					termDOM.scrollDocumentBy(rect.top - top);
				} else if (rect.bottom > top + regionHeight) {
					termDOM.scrollDocumentBy(rect.bottom - (top + regionHeight));
				}
				return;
			}

			const viewportHeight = termDOM.height;
			const scrollTop = termDOM.scrollingManager.getScrollTop();

			if (rect.top < 0) {
				// Element is above viewport - scroll up
				termDOM.scrollingManager.setScrollTop(scrollTop + rect.top);
			} else if (rect.bottom > viewportHeight) {
				// Element is below viewport - scroll down
				termDOM.scrollingManager.setScrollTop(
					scrollTop + (rect.bottom - viewportHeight),
				);
			}
		};
	}

	/**
	 * Get all focusable elements in tab order
	 */
	private getFocusableElements(): Element[] {
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
	private moveFocus(reverse: boolean): void {
		const focusable = this.getFocusableElements();
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
		void this.render();
	}

	/**
	 * Handle input element default actions (character insertion, deletion, navigation)
	 */
	private handleInputAction(
		element: HTMLInputElement,
		keyName: string,
		key: string,
	): void {
		const value = element.value;
		const cursor = this.inputCursorPositions.get(element) ?? value.length;

		let newValue = value;
		let newCursor = cursor;

		if (keyName === "Backspace") {
			if (cursor > 0) {
				newValue = value.slice(0, cursor - 1) + value.slice(cursor);
				newCursor = cursor - 1;
			}
		} else if (keyName === "Delete") {
			if (cursor < value.length) {
				newValue = value.slice(0, cursor) + value.slice(cursor + 1);
			}
		} else if (keyName === "ArrowLeft") {
			newCursor = Math.max(0, cursor - 1);
		} else if (keyName === "ArrowRight") {
			newCursor = Math.min(value.length, cursor + 1);
		} else if (keyName === "Home") {
			newCursor = 0;
		} else if (keyName === "End") {
			newCursor = value.length;
		} else if (key.length === 1 && key.charCodeAt(0) >= 32) {
			// Printable character
			newValue = value.slice(0, cursor) + key + value.slice(cursor);
			newCursor = cursor + 1;
		} else {
			return; // Not an input action
		}

		if (newValue !== value) {
			element.value = newValue;
			this.inputCursorPositions.set(element, newCursor);

			// Dispatch input event
			element.dispatchEvent(
				new this.window.Event("input", {bubbles: true, cancelable: false}),
			);

			// Trigger re-render since .value changes don't trigger MutationObserver
			this.render();
		} else if (newCursor !== cursor) {
			this.inputCursorPositions.set(element, newCursor);
			// Cursor moved - re-render to update cursor position
			this.render();
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
	private *tokenizeInput(input: string): Generator<string> {
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
	private screenToDocumentPoint(
		x: number,
		row: number,
	): {x: number; y: number} | null {
		if (this.fullscreenManager.isFullscreen) {
			return {x, y: row + this.scrollingManager.getScrollTop()};
		}
		if (this.viewportMode === "document") {
			const y =
				row - this.scrollingManager.getScreenTop() + this.documentScrollTop;
			return y < 0 ? null : {x, y};
		}
		// Flow mode: rows above the region belong to committed content or the
		// shell. (Capture is off in flow mode, so this is for completeness.)
		const start =
			this.committedRows > 0 ? 0 : this.scrollingManager.getScreenTop();
		const y = row - start + this.committedRows;
		return y < 0 ? null : {x, y};
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
	private handleMouseReport(
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

		const point = this.screenToDocumentPoint(col - 1, row - 1);
		const x = point?.x ?? col - 1;
		const y = point?.y ?? 0;
		const target =
			(point && this.document.elementFromPoint(x, y)) || this.document.body;

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
					this.documentScrollTop === 0 &&
					this.viewportMode === "document" &&
					!this.fullscreenManager.isFullscreen
				) {
					// Scroll chaining, the browser default: the camera is at the
					// document top, so the scroll escapes to the parent scroller --
					// here, the terminal's own scrollback. Yield the mouse so the
					// next wheel tick scrolls the shell history natively; the next
					// keystroke reclaims it. An app opts out the same way it would
					// in a browser: preventDefault on the wheel event.
					this.mouseCaptureYielded = true;
					this.updateMouseReporting();
				} else {
					this.scrollDocumentBy(deltaY);
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
			return;
		}

		if (!isRelease) {
			this.mouseDownTarget = target;
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
					void this.render();
				} else if (!focusable && active && active !== this.document.body) {
					(active as HTMLElement).blur();
					void this.render();
				}
			}
			return;
		}

		target.dispatchEvent(new this.window.MouseEvent("mouseup", eventInit));
		if (this.mouseDownTarget === target) {
			target.dispatchEvent(
				new this.window.MouseEvent("click", {...eventInit, buttons: 0}),
			);
		}
		this.mouseDownTarget = null;
	}

	private dispatchGlobalKeyboardEvent(chunk: Buffer): void {
		const key = chunk.toString("utf8");

		// Tokenize multi-key chunks and dispatch each token on its own.
		const tokens = Array.from(this.tokenizeInput(key));
		if (tokens.length > 1) {
			for (const token of tokens) {
				this.dispatchGlobalKeyboardEvent(Buffer.from(token));
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

		// Find the focused element or use document.body
		let targetElement = this.document.activeElement || this.document.body;

		// Map common key codes (reuse logic from fullscreen manager)
		let keyName = key;
		let keyCode = 0;
		let charCode = key.charCodeAt(0);

		// Handle special keys
		// Detect modifier keys
		let shiftKey = false;

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
			default:
				// For regular characters, keyCode is often the uppercase charCode
				if (key.length === 1) {
					keyCode = key.toUpperCase().charCodeAt(0);
				}
		}

		// Create and dispatch keydown event
		const keydownEvent = new this.window.KeyboardEvent("keydown", {
			key: keyName,
			code: `Key${keyName.toUpperCase()}`,
			keyCode: keyCode,
			charCode: 0,
			which: keyCode,
			ctrlKey: false,
			shiftKey,
			altKey: false,
			metaKey: false,
			bubbles: true,
			cancelable: true,
		});

		const notCanceled = targetElement.dispatchEvent(keydownEvent);

		// Handle default actions if keydown wasn't canceled
		if (notCanceled) {
			// Tab navigation
			if (keyName === "Tab") {
				this.moveFocus(shiftKey);
			}

			// Input element default actions
			if (
				targetElement instanceof (this.window as any).HTMLInputElement &&
				(targetElement as HTMLInputElement).type !== "submit" &&
				(targetElement as HTMLInputElement).type !== "button"
			) {
				this.handleInputAction(targetElement as HTMLInputElement, keyName, key);
			}
		}

		// If keydown wasn't canceled and it's a printable character, dispatch keypress
		if (notCanceled && key.length === 1 && charCode >= 32 && charCode < 127) {
			const keypressEvent = new this.window.KeyboardEvent("keypress", {
				key: key,
				code: `Key${key.toUpperCase()}`,
				keyCode: charCode,
				charCode: charCode,
				which: charCode,
				ctrlKey: false,
				shiftKey,
				altKey: false,
				metaKey: false,
				bubbles: true,
				cancelable: true,
			});
			targetElement.dispatchEvent(keypressEvent);
		}

		// Always dispatch keyup
		const keyupEvent = new this.window.KeyboardEvent("keyup", {
			key: keyName,
			code: `Key${keyName.toUpperCase()}`,
			keyCode: keyCode,
			charCode: 0,
			which: keyCode,
			ctrlKey: false,
			shiftKey,
			altKey: false,
			metaKey: false,
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
	private async renderStatic(): Promise<void> {
		const pending = this.observer.takeRecords();
		if (pending.length > 0) {
			this.styleManager.handleMutations(pending);
			this.layoutEngine.handleMutations(pending);
		}

		this.renderedOutsideMarkers = new WeakSet<Element>();
		this.layoutEngine.calculateLayout();

		const output = this.renderer.renderStatic(
			this.document.body.scrollHeight,
			(ctx) => {
				this.renderElement(this.document.body, ctx);
			},
		);

		if (output) await this.write(output);
		this.afterRender();
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
	private flushDocument(): void {
		if (this.viewportMode !== "document" || !this.interactive) return;

		const contentHeight = this.document.body.scrollHeight;
		if (contentHeight === 0) return;

		const top = this.scrollingManager.getScreenTop();

		// Back to the top of our region, and erase from there down. Only rows we
		// painted ourselves; the scrollback above is untouched.
		this.process.stdout.write(`\x1b[${top + 1};1H\x1b[J`);

		const output = this.renderer.renderStatic(
			contentHeight,
			(ctx) => {
				this.renderElement(this.document.body, ctx);
			},
			"\r\n",
		);

		if (output) this.process.stdout.write(output);
	}

	/** Write to stdout and wait for it to be flushed. */
	private write(output: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.process.stdout.write(output, "utf8", (error) => {
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
	private async renderDocumentMode(): Promise<void> {
		// Our region starts at the command-start row, which cursor detection resolves
		// asynchronously. Render before it lands and the first frame anchors at row 0
		// while every diff after detection anchors one row lower -- the labels stay,
		// the values slide down a row. Wait for the anchor to settle first, exactly
		// as the flow path does.
		if (this.cursorDetectionPromise) {
			await this.cursorDetectionPromise;
		}

		const pending = this.observer.takeRecords();
		if (pending.length > 0) {
			this.styleManager.handleMutations(pending);
			this.layoutEngine.handleMutations(pending);
		}

		this.renderedOutsideMarkers = new WeakSet<Element>();
		this.layoutEngine.calculateLayout();

		const contentHeight = this.document.body.scrollHeight;
		const regionHeight = Math.min(contentHeight, this.height);

		// Take the room we need by pushing earlier output up, never over it.
		const top = this.reserveRows(regionHeight);

		// The camera cannot run off the end of the document.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		this.documentScrollTop = Math.min(this.documentScrollTop, maxScroll);

		const ansi = this.renderer.renderFrame(
			-this.documentScrollTop,
			(ctx) => {
				this.renderElement(this.document.body, ctx);
			},
			top,
			top + regionHeight,
		);

		if (ansi) await this.write(ansi);
		this.afterRender();
	}

	/**
	 * Choose how the document scrolls. See `viewportMode`.
	 */
	setViewportMode(mode: "flow" | "document"): void {
		if (mode === this.viewportMode) return;
		this.viewportMode = mode;
		this.documentScrollTop = 0;
		this.renderer.clearPreviousBuffer();
		this.mouseCaptureYielded = false;
		this.updateMouseReporting();
	}

	/** Move the camera, in document mode. Ignored in flow mode. */
	scrollDocumentBy(rows: number): void {
		if (this.viewportMode !== "document") return;
		this.documentScrollTop = Math.max(0, this.documentScrollTop + rows);
		// A camera move is invisible to the MutationObserver; schedule the frame
		// it needs, the same way a DOM mutation would.
		void this.render();
	}

	/**
	 * Make room for `rows` rows below the command start, *without painting over
	 * anything that was already on screen*.
	 *
	 * If there is not enough room between the command start and the bottom of the
	 * terminal, we scroll the terminal -- by printing newlines at the bottom margin,
	 * which pushes the rows above into the scrollback, where they are preserved and
	 * the user can still reach them. Overwriting them in place would destroy the
	 * output of whatever ran before us; scrolling them away is what an ordinary
	 * command does when it prints.
	 *
	 * Returns the screen row our region now starts at.
	 */
	private reserveRows(rows: number): number {
		const top = this.scrollingManager.getScreenTop();
		const overflow = top + rows - this.height;

		if (overflow <= 0) return top;

		const push = Math.min(overflow, top);
		if (push > 0) {
			this.process.stdout.write(`\x1b[${this.height};1H` + "\n".repeat(push));
			// Do NOT shift the renderer's previous buffer. Its rows are relative to
			// the region top, and the top moves up by exactly the amount the screen
			// scrolled -- the two cancel, so buffer coordinates are unchanged.
			// Shifting it desynced the diff by `push` rows: the model compared
			// against the wrong screen rows, skipped cells it wrongly believed
			// unchanged, and composited the old frame under the new one whenever a
			// document-mode region grew past the space below the shell prompt.
			this.scrollingManager.setScreenTop(top - push);
		}

		return this.scrollingManager.getScreenTop();
	}

	/**
	 * Has the document reflowed above the fold?
	 *
	 * The commit index is a row *number*, so it only means anything while the rows
	 * above it stay where they are. Insert a row near the top and every row number
	 * beneath it shifts: rows already in the scrollback get printed again
	 * (duplicated), and the newly inserted content never appears at all.
	 *
	 * The committed rows are beyond our reach, but we can watch the first element
	 * that is still ours. If it has moved, everything above it changed height.
	 */
	private hasReflowedAboveFold(): boolean {
		if (this.committedRows === 0 || this.foldAnchor === null) return false;

		const {element, top} = this.foldAnchor;
		if (!element.isConnected) return true;

		const rect = this.layoutEngine.getRect(element);
		if (!rect) return true;

		return Math.round(rect.top) !== top;
	}

	/** Remember the first element below the fold, so we can tell if it moves. */
	private updateFoldAnchor(): void {
		if (this.committedRows === 0) {
			this.foldAnchor = null;
			return;
		}

		for (const element of Array.from(this.document.body.children)) {
			const rect = this.layoutEngine.getRect(element);
			if (!rect) continue;
			if (rect.top >= this.committedRows) {
				this.foldAnchor = {element, top: Math.round(rect.top)};
				return;
			}
		}

		this.foldAnchor = null;
	}

	/**
	 * Print the document again, below what is already there.
	 *
	 * The scrollback cannot be rewritten: no escape sequence addresses it. There
	 * are exactly two primitives -- append, or destroy the lot with ED3. Destroying
	 * it and re-rendering is what flicker *is*, so we append. The stale copy stays
	 * above as a record of what was shown, and a correct one is printed below it.
	 *
	 * It costs a duplicate. It never flickers, and it never loses anything.
	 */
	private async reprintAsNewBlock(): Promise<void> {
		this.process.stdout.write("\r\n");

		this.committedRows = 0;
		this.foldAnchor = null;
		this.renderer.beginNewBlock();

		// Re-anchor: ask the terminal where the cursor actually is now.
		await this.detectCommandStart();
	}

	private pushUpForOverflow(): void {
		const contentHeight = this.document.body.scrollHeight;

		// Where the content currently starts, as a terminal row.
		const startRow = -this.scrollingManager.getScrollTop();
		const roomBelow = this.height - startRow;

		if (contentHeight <= roomBelow) return;

		const pushUp = contentHeight - roomBelow;

		// The command start moves up by the overflow, and the content with it.
		const screenTop = this.scrollingManager.getScreenTop();
		this.scrollingManager.setScreenTop(Math.max(0, screenTop - pushUp));
		this.scrollingManager.scrollBy(pushUp, true);
	}

	/**
	 * Initialize cursor position detection for TTY environments
	 * This runs asynchronously during construction to set up proper viewport positioning
	 */
	private initializeCursorDetection(): void {
		this.cursorDetectionPromise = null;
		// Only detect cursor position in TTY environments when enabled
		if (this.detectCursorEnabled && this.process.stdin?.isTTY) {
			// Set up cursor detection promise that render() will wait for
			this.cursorDetectionPromise = Promise.race([
				this.detectCommandStart().then(() => {}),
				// Fallback: if cursor detection takes too long, proceed without it
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					// If cursor detection fails, continue without it
					this.hasDetectedCommandStart = false;
				})
				.finally(() => {
					// Clear the promise so subsequent renders don't wait
					this.cursorDetectionPromise = null;
				});
		} else {
			// In non-TTY environments, don't set up cursor detection at all
			this.cursorDetectionPromise = null;
		}
	}

	/**
	 * Detect current cursor position and set window.screenTop
	 * Sends \x1b[6n and waits for response \x1b[row;colR
	 */
	detectCommandStart(): Promise<number> {
		this.attach();
		return new Promise<number>((resolve, reject) => {
			if (!this.process.stdin?.isTTY) {
				reject(new Error("Cannot detect cursor position: stdin is not a TTY"));
				return;
			}

			let responseBuffer = "";

			const finish = () => {
				this.cursorDetectionHandler = null;
				if (this.cursorDetectionTimer !== null) {
					clearTimeout(this.cursorDetectionTimer);
					this.cursorDetectionTimer = null;
				}
			};

			// Set up cursor detection handler for unified stdin
			this.cursorDetectionHandler = (dataStr: string) => {
				responseBuffer += dataStr;

				// Look for cursor position response pattern: \x1b[row;colR
				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					finish();

					const row = parseInt(match[1], 10);
					// Set window.screenTop (convert 1-based terminal row to 0-based)
					const screenTop = row - 1;
					this.scrollingManager.setScreenTop(screenTop);

					// Set scrollTop to command start position (browser behavior)
					// For command start, we want content to shift up to terminal top
					this.scrollingManager.scrollToCommandStart();

					this.hasDetectedCommandStart = true;
					resolve(row);
				}
			};

			// Send cursor position query with proper flushing
			this.process.stdout.write("\x1b[6n");

			// Force flush the output buffer (critical for cursor queries)
			if (typeof (this.process.stdout as any)._flush === "function") {
				(this.process.stdout as any)._flush();
			}

			// Timeout after 1000ms (reasonable balance for reliability). The timer is
			// held so it can be cleared the moment a response arrives -- otherwise it
			// keeps the event loop alive for a further second after we are done.
			this.cursorDetectionTimer = setTimeout(() => {
				this.cursorDetectionTimer = null;
				if (this.cursorDetectionHandler) {
					this.cursorDetectionHandler = null;
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
	private queryCursorRow(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this.process.stdin?.isTTY) {
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
					if (this.cursorDetectionHandler === handler) {
						this.cursorDetectionHandler = null;
					}
					if (localTimer !== null) {
						clearTimeout(localTimer);
						if (this.cursorDetectionTimer === localTimer) {
							this.cursorDetectionTimer = null;
						}
						localTimer = null;
					}
					resolve(parseInt(match[1], 10) - 1);
				}
			};

			// Replacing a stale handler is fine: its own timeout still fires and
			// rejects it, and the caller's epoch check discards the stale result.
			this.cursorDetectionHandler = handler;

			this.process.stdout.write("\x1b[6n");
			if (typeof (this.process.stdout as any)._flush === "function") {
				(this.process.stdout as any)._flush();
			}

			// Short timeout: the redraw should feel immediate, and a terminal that
			// does not answer promptly falls back to the computed re-anchor.
			localTimer = setTimeout(() => {
				if (this.cursorDetectionHandler === handler) {
					this.cursorDetectionHandler = null;
				}
				if (this.cursorDetectionTimer === localTimer) {
					this.cursorDetectionTimer = null;
				}
				localTimer = null;
				reject(new Error("Timeout waiting for cursor position response"));
			}, 200);
			this.cursorDetectionTimer = localTimer;
		});
	}

	dispose(): void {
		trackedInstances?.delete(this);
		undisposedInteractive.delete(this);
		this.attached = false;

		// Document mode has been painting a window in place, so nothing it showed
		// has reached the terminal's scrollback. Pay it all out now.
		this.flushDocument();

		// Frames keep the terminal cursor hidden (it is parked for resize
		// bookkeeping, not UI); hand it back visible on the way out. The mouse
		// goes back to the terminal the same way.
		if (this.mouseReportingEnabled) {
			this.process.stdout.write("\x1b[?1006l\x1b[?1002l");
			this.mouseReportingEnabled = false;
		}
		if (this.interactive) {
			this.process.stdout.write("\x1b[?25h");
		}

		// Tear down everything that holds the event loop open. Without this a
		// disposed TermDOM keeps the process alive -- via the process signal
		// listeners, the stdin data listener, and the cursor-detection timer -- and
		// across a whole test suite those accumulate until nothing can exit.
		if (this.cursorDetectionTimer !== null) {
			clearTimeout(this.cursorDetectionTimer);
			this.cursorDetectionTimer = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		this.cursorDetectionHandler = null;

		if (this.sigintHandler) {
			(this.process as unknown as EventEmitter).removeListener?.(
				"SIGINT",
				this.sigintHandler,
			);
			this.sigintHandler = null;
		}
		if (this.sigwinchHandler) {
			(this.process as unknown as EventEmitter).removeListener?.(
				"SIGWINCH",
				this.sigwinchHandler,
			);
			this.sigwinchHandler = null;
		}

		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin as TTYReadStream;
			if (this.stdinDataHandler) {
				stdin.removeListener?.("data", this.stdinDataHandler);
				this.stdinDataHandler = null;
			}
			stdin.setRawMode?.(false);
			stdin.pause();
		}

		// Shadow DOM cleanup is automatic with symbol-based storage

		this.observer.disconnect();
		this.styleManager.dispose();
		this.layoutEngine.dispose();
		this.fullscreenManager.dispose();
		this.observerManager.dispose();
		this.jsdom.window.close();
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
		const rects = Array.from(element.getClientRects());
		if (!isPointInRects(x, y, rects)) {
			return null;
		}
	} catch (error) {
		return null;
	}

	// Use ExpandedTreeWalker to traverse children (including shadow DOM)
	const walker = termDOM.createExpandedTreeWalker(element);

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
