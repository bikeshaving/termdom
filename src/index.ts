import "./internal/inspector.ts";

import {
	Cascade,
	type CellSize,
	type CellSizeSetting,
	getCellSize,
	UNIT_CELL,
} from "./internal/cssom.ts";
import {
	applyMutations,
	attachDocument,
	clampScrollOffsets,
	clearHighlights,
	createWindow,
	disconnectObservers,
	dispatchAsUserAgent,
	dropFullscreen,
	flushLayout,
	flushObservers,
	getCellSizeSetting,
	getGraphicsSetting,
	type GraphicsSetting,
	hasFrameCallbacks,
	hoverListenerCount,
	relayoutReplacedElements,
	revealPendingCaret,
	revealPendingEditingCaret,
	revealTextControlCaret,
	runFocusFixup,
	runFrameCallbacks,
	runScrollSteps,
	setDocumentVisible,
	syncMediaQueries,
	takeScrollShift,
	type Window,
} from "./internal/dom.ts";
import {
	DEFAULT_ROWS,
	Exchange,
	type TerminalCloseInfo,
	type TerminalResizeEvent,
	type TerminalSize,
	type TerminalTransport,
	transportFromProcess,
} from "./internal/exchange.ts";
import {Framebuffer} from "./internal/framebuffer.ts";
import {
	releaseDecoder,
	retainDecoder,
	setDecodeWorkerURL,
} from "./internal/images.ts";
import {Input} from "./internal/input.ts";
import {Layout} from "./internal/layout.ts";
import {Painter} from "./internal/painter.ts";
import {
	answerRequest,
	type FetchEvent,
	parseContentSecurityPolicies,
	type RequestPolicy,
} from "./internal/resources.ts";

export {CanvasCharGridContext} from "./internal/canvas.ts";
export type {CellSize} from "./internal/cssom.ts";
export {transportFromProcess} from "./internal/exchange.ts";
export {
	ExtendableEvent,
	FetchEvent,
	type FetchEventInit,
} from "./internal/resources.ts";
export type {
	ProcessLike,
	TTYReadStream,
	TTYWriteStream,
	TerminalCloseInfo,
	TerminalSize,
	TerminalTransport,
} from "./internal/exchange.ts";

// Images decode on the runtime's web Worker, running src/decode-worker.ts,
// which builds to dist/decode-worker.js beside this file. A runtime with
// no Worker, as Node is without --experimental-web-worker, and a CommonJS
// build, which has no import.meta.url, decode on this thread instead.
setDecodeWorkerURL(
	typeof import.meta.url === "string"
		? new URL(
			`./decode-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
			import.meta.url,
		)
		: null,
);

export interface TermDOMOptions {

	/** Defaults to the global process. */
	transport?: TerminalTransport;

	/** The initial document's markup. */
	html?: string;

	/** The initial document's URL. */
	url?: string;

	/**
	 * What one terminal cell measures in CSS pixels. Layout places each
	 * box's edges on the nearest cell, so widths that add up still fit,
	 * and a border that is there at all is one cell wide.
	 *
	 * - `"unit"` (the default): a cell is one CSS pixel each way.
	 * - `"auto"`: the size the terminal reports, asked for before the
	 *   first frame, which waits a second at most. 8 by 16 when it cannot
	 *   answer, as on a pipe.
	 * - `{width, height}`: that size.
	 */
	cellSize?: "unit" | "auto" | CellSize;

	/**
	 * The Content Security Policy the document's loads are checked against,
	 * as a `Content-Security-Policy` header would state it: an <img> loads
	 * only what `img-src`, or `default-src` without it, allows. A page's own
	 * `<meta http-equiv="Content-Security-Policy">` can narrow it, never
	 * widen it. Defaults to `"default-src 'none'"`, so markup loads nothing
	 * unless the program allows it. The empty string, like a header with
	 * no directives, sets no policy and allows every load.
	 */
	csp?: string;

	/**
	 * How the document draws pixels, for an <img> and a canvas's "2d"
	 * context.
	 *
	 * - `true` (the default): the best way the terminal has. Today that is
	 *   cells: two pixels to a cell in half blocks, which every terminal
	 *   shows.
	 * - `"cells"`: cells, whatever else the terminal could do.
	 * - `false`: no pixels. An <img> loads nothing and shows its alt text,
	 *   as HTML renders one when images are disabled, and
	 *   `getContext("2d")` returns null, so a canvas shows its fallback
	 *   content.
	 */
	graphics?: boolean | "cells";
}

function toGraphicsSetting(
	option: TermDOMOptions["graphics"],
): GraphicsSetting {
	if (option === undefined || option === true || option === "cells") {
		return "cells";
	}
	if (option === false) {
		return false;
	}
	throw new TypeError('graphics must be true, false or "cells"');
}

const DEFAULT_CONTENT_SECURITY_POLICY = "default-src 'none'";

function isSameCell(a: Readonly<CellSize>, b: Readonly<CellSize>): boolean {
	return a.width === b.width && a.height === b.height;
}

function toCellSizeSetting(
	option: TermDOMOptions["cellSize"],
): CellSizeSetting {
	if (option === undefined || option === "unit") {
		return "unit";
	}
	if (option === "auto") {
		return "auto";
	}
	if (
		typeof option === "object" &&
		option !== null &&
		Number.isFinite(option.width) &&
		Number.isFinite(option.height) &&
		option.width > 0 &&
		option.height > 0
	) {
		return Object.freeze({width: option.width, height: option.height});
	}
	throw new TypeError(
		'cellSize must be "unit", "auto" or {width, height} with positive sizes',
	);
}

const kFramebuffer = Symbol("framebuffer");
const kLayout = Symbol("layout");
const kCascade = Symbol("cascade");
const kPainter = Symbol("painter");
const kSealed = Symbol("sealed");
const kRenderQueued = Symbol("renderQueued");
const kOnAlternateScreen = Symbol("onAlternateScreen");
const kRenderInFlight = Symbol("renderInFlight");
const kRenderCount = Symbol("renderCount");
const kFirstFrame = Symbol("firstFrame");
const kUnprinted = Symbol("unprinted");
const kInput = Symbol("input");
const kAttachReady = Symbol("attachReady");
const kMouseReportingEnabled = Symbol("mouseReportingEnabled");
const kHoverReportingEnabled = Symbol("hoverReportingEnabled");
const kTransport = Symbol("transport");
const kExchange = Symbol("exchange");
const kStaticSibling = Symbol("staticSibling");
const kLifetimes = Symbol("lifetimes");
const kLoads = Symbol("loads");
const kAttachBegun = Symbol("attachBegun");
type Lifecycle = "detached" | "attaching" | "attached" | "disposed";
const kLifecycle = Symbol("lifecycle");
// Whether a frame has been painted in flow, below the prompt. Leaving the
// alternate screen restores the cursor to where the switch saved it; over
// flow content that is the content's last row, and the shell's next line
// would land on it.
const kFlowPainted = Symbol("flowPainted");
// Errors the page let escape that no log could take live. Printed below
// the document when the session ends.
const kHeldErrors = Symbol("heldErrors");
// Held errors handed to the output queue whose write has not finished.
const kUnwrittenErrors = Symbol("unwrittenErrors");
const HELD_ERROR_LIMIT = 50;

/** The events a TermDOM dispatches, by type. */
export interface TermDOMEventMap {
	fetch: FetchEvent;
}

export interface TermDOM {
	[kFramebuffer]: Framebuffer;
	[kLayout]: Layout;
	[kCascade]: Cascade;
	[kPainter]: Painter;
	// document.close() sealed the document into the scrollback. The next
	// mutation starts a fresh one below it.
	[kSealed]: boolean;
	[kRenderQueued]: boolean;
	// Which screen frames land on. Switched at the start of a frame when
	// the document's fullscreen state disagrees.
	[kOnAlternateScreen]: boolean;
	// The running render loop. A render() during it queues a trailing
	// frame rather than starting another.
	[kRenderInFlight]: Promise<void> | null;
	[kFlowPainted]: boolean;
	[kHeldErrors]: string[];
	[kUnwrittenErrors]: string | null;
	// Timestamps observer entries.
	[kRenderCount]: number;
	// What the first frame waits for: the terminal's answers that decide
	// how the page looks.
	[kFirstFrame]: Promise<void> | null;
	// A stdout that is not a terminal gets the document once, as it stands
	// when the session ends. True while a frame has changed it since.
	[kUnprinted]: boolean;
	[kInput]: Input;
	// Construction never touches the terminal. attach() does, and dispose()
	// ends the instance for good.
	[kLifecycle]: Lifecycle;
	[kMouseReportingEnabled]: boolean;
	[kHoverReportingEnabled]: boolean;
	[kTransport]: TerminalTransport;
	[kExchange]: Exchange;
	// Resolves once the session is established and the first frame written.
	[kAttachReady]: Promise<void>;
	// Resolves once attach()'s begin phase has run. Awaited only while
	// attaching, because an unconditional await would defer every frame a
	// microtask, and the scrollTop clamp is synchronous by contract.
	[kAttachBegun]: Promise<void>;
	// The engine behind renderANSI and print, rebuilt when the width, the
	// cell or the screen's colors change.
	[kStaticSibling]: TermDOM | null;
	// What "fetch" listeners passed to waitUntil(). dispose() waits for it.
	[kLifetimes]: Set<Promise<void>>;
	// Aborts the document's loads when the TermDOM is disposed.
	[kLoads]: AbortController;
}

/**
 * A document drawn in a terminal. It is the target of a "fetch" event for
 * each load its markup asks for that its policy allows (see FetchEvent).
 */
export class TermDOM extends EventTarget {
	readonly document: Document;
	readonly window: Window;

	constructor(options: TermDOMOptions = {}) {
		super();
		const cellSize = toCellSizeSetting(options.cellSize);
		const graphics = toGraphicsSetting(options.graphics);
		this[kSealed] = false;

		this[kRenderQueued] = false;
		this[kOnAlternateScreen] = false;
		this[kRenderInFlight] = null;
		this[kFlowPainted] = false;
		this[kHeldErrors] = [];
		this[kUnwrittenErrors] = null;
		this[kRenderCount] = 0;
		this[kFirstFrame] = null;
		this[kUnprinted] = false;
		this[kLifecycle] = "detached";

		this[kMouseReportingEnabled] = false;
		this[kHoverReportingEnabled] = false;

		this[kAttachReady] = Promise.resolve();
		this[kAttachBegun] = Promise.resolve();
		this[kStaticSibling] = null;
		this[kLifetimes] = new Set();
		retainDecoder();
		this[kLoads] = new AbortController();
		this[kTransport] = options.transport ?? transportFromProcess();

		this.window = createWindow(
			options.html ?? "<!DOCTYPE html><html><head></head><body></body></html>",
			options.url,
		);

		const document = this.document = this.window.document;
		// The page's fetch resolves a relative URL against the document, as a
		// browser's does, and goes to the runtime's.
		this.window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
			fetch(
				new Request(
					typeof input === "string" ? new URL(input, document.baseURI) : input,
					init,
				),
			)) as typeof this.window.fetch;
		const policy = options.csp;
		let hinted = false;
		const requestPolicy: RequestPolicy = {
			policies: parseContentSecurityPolicies(
				policy ?? DEFAULT_CONTENT_SECURITY_POLICY,
			),
			signal: this[kLoads].signal,
			extend: (promise) => {
				const lifetime = promise.then(() => {}, () => {});
				this[kLifetimes].add(lifetime);
				void lifetime.then(() => this[kLifetimes].delete(lifetime));
			},
			violate: (at, init) => {
				const window = this.window as unknown as typeof globalThis;
				dispatchAsUserAgent(
					at as never,
					new window.SecurityPolicyViolationEvent(
						"securitypolicyviolation",
						init,
					) as never,
				);
				// A program that set no policy may not know markup loads
				// nothing until it does.
				if (policy === undefined && !hinted) {
					hinted = true;
					// A URL that is not HTTP(S) is reported as its scheme alone.
					const blocked = init.blockedURI!.includes(":")
						? init.blockedURI
						: `a ${init.blockedURI}: URL`;
					reportUncaught(
						this,
						`TermDOM blocked ${blocked}. The document's markup ` +
						"loads nothing until a Content Security Policy allows it: " +
						"new TermDOM({csp: \"img-src data: https:\"}), for one.",
					);
				}
			},
		};

		this[kLayout] = new Layout(
			this.window,
			this[kTransport].cols,
			this[kTransport].rows,
		);
		this[kCascade] = new Cascade(this.window, this[kLayout]);

		this[kFramebuffer] = new Framebuffer(
			this[kTransport].rows,
			this[kTransport].cols,
			this[kTransport].colorDepth ?? "256",
		);

		const exchange = this[kExchange] = new Exchange(
			this[kTransport],
			this.window,
			this[kLayout],
			this[kCascade],
			this[kFramebuffer],
		);

		// The framebuffer measures widths over the exchange's probe channel.
		this[kFramebuffer].measurer = exchange;

		attachDocument(document, {
			layout: this[kLayout],
			cascade: this[kCascade],
			exchange: this[kExchange],
			framebuffer: this[kFramebuffer],
			cellSize,
			graphics,
			load: (request, context) =>
				answerRequest(this, document, request, context, requestPolicy),
			loadSignal: this[kLoads].signal,
			render: () => render(this),
			reportUncaught: (error) => reportUncaught(this, error),
		});
		// The document had no size until it was attached, so an @media rule
		// in the markup was read against a zero-width viewport. Attaching is
		// a resize, and flips @media results the same way.
		this[kCascade].syncStylesheets();

		this[kInput] = new Input(
			this.document,
			this[kLayout],
			this[kCascade],
			this[kFramebuffer],
		);

		this[kPainter] = new Painter(
			this.document,
			this[kLayout],
			this[kCascade],
			this[kFramebuffer],
		);

		// A canceled or untrusted beforeunload does not close.
		exchange.addEventListener("beforeunload", (event) => {
			if (
				!event.isTrusted ||
				event.defaultPrevented ||
				(event as BeforeUnloadEvent).returnValue !== ""
			) {
				return;
			}
			closeTermDOM(this);
		});

		// A page can dispatch an event of the same name on the document.
		// Only the exchange's own reach these. document.close() flushes the
		// document into the scrollback and seals it. The next mutation
		// starts a fresh one below it.
		exchange.addEventListener("seal", (event) => {
			if (
				event.target === exchange && isAttached(this) && this[kRenderCount] > 0
			) {
				flushDocument(this);
				this[kSealed] = true;
			}
		});
		exchange.addEventListener("terminalclose", (event) => {
			if (event.target === exchange) {
				closeTermDOM(this);
			}
		});
	}

	/**
	 * Takes over the terminal: starts the session, sends the startup queries,
	 * enables mouse reporting. Passing a transport rebinds to it and
	 * re-derives everything that depends on the terminal. Only allowed before
	 * the first attach.
	 */
	attach(transport: TerminalTransport = this[kTransport]): Promise<void> {
		const rebinding = transport !== this[kTransport];
		if (this[kLifecycle] === "disposed") {
			return this[kAttachReady];
		}
		if (isAttached(this)) {
			if (rebinding) {
				throw new Error(
					"attach(): cannot re-attach a live TermDOM to a different " +
					"transport; attach once, before the first render.",
				);
			}
			return this[kAttachReady];
		}
		// Re-derive everything that comes from the transport. Only before the
		// first frame.
		if (rebinding) {
			this[kTransport] = transport;
			this[kFramebuffer].rebind(transport.colorDepth ?? "256");
			this[kExchange].rebind(transport);
		}
		// Resolves when the first frame has been written. The negotiations'
		// silence timeouts must not delay that.
		this[kLifecycle] = "attaching";
		setDocumentVisible(this.document, true);
		let begun!: () => void;
		this[kAttachBegun] = new Promise<void>((resolve) => {
			begun = resolve;
		});
		this[kAttachReady] = (async () => {
			await this[kTransport].ready;
			// dispose() during the wait ends it. The session never starts.
			if (this[kLifecycle] !== "attaching") {
				begun();
				return;
			}

			this[kExchange].start(this[kInput]);
			if (this[kTransport].interactive) {
				this[kExchange].setDisplayType("bracketedPaste", true);
				// So dispose can restore the title.
				this[kExchange].setDisplayType("titleStack", true);
				if (this.document.title) {
					void this[kExchange].setTitle(this.document.title);
				}
			}
			syncMouseReporting(this);
			syncHoverReporting(this);
			// The terminal's background, asked first so the first frame can
			// wait for it.
			const schemeBefore = this[kExchange].colorScheme;
			void this[kExchange].negotiateColorScheme().then(() => {
				if (isAttached(this) && this[kExchange].colorScheme !== schemeBefore) {
					this[kCascade].syncStylesheets();
					syncMediaQueries(this.document);
					void render(this);
				}
			});
			// What colors the terminal shows, when the transport leaves it to
			// the terminal to say. Asked before DA1, like the background.
			const depthSettled = this[kTransport].colorDepth === undefined
				? this[kExchange].negotiateColorDepth().then((depth) => {
					if (isAttached(this) && depth !== this[kFramebuffer].colorDepth) {
						this[kFramebuffer].rebind(depth);
						syncMediaQueries(this.document);
						void render(this);
					}
				})
				: Promise.resolve();
			// A terminal answers in the order it was asked, so once it answers
			// DA1, one that said nothing of its background never will.
			const answered = this[kExchange].queryDeviceAttributes();
			this[kExchange].initializeCursorDetection();
			// A terminal that answers nothing is not waited on past the cursor
			// question the anchor already waits for.
			const cursor = this[kExchange].cursorDetectionPending;
			const schemeSettled = (
				cursor === null ? answered : Promise.race([answered, cursor])
			).then(() => {
				this[kExchange].abandonColorSchemeQuery();
				this[kExchange].abandonColorDepthQuery();
			});
			void this[kExchange].negotiateBidi();
			void this[kExchange].negotiateGraphemeClusters();
			// Math draws its bars as overlines once the terminal has agreed
			// to them, so what was measured before the answer measures again.
			void this[kExchange].negotiateOverline().then((agreed) => {
				if (agreed && isAttached(this)) {
					this[kLayout].invalidateTextMeasurement();
					void render(this);
				}
			});
			this[kExchange].scrubProbeEcho();
			// After the erase, which is for the mode probes' echo. What was
			// painted against the guessed cell repaints when the answer lands.
			// When the cell sizes the page, the first frame waits for it, so
			// the page never lays out against the guess.
			const measuresCell = getCellSizeSetting(this.document) === "auto";
			const cellAnswered = this[kExchange].negotiateCellPixels().then(
				(cellChanged) => {
					if (!isAttached(this)) {
						return;
					}
					if (cellChanged) {
						cellPixelsChanged(this);
						if (measuresCell) {
							cellSizeChanged(this);
						}
					}
					void render(this);
				},
			);
			// The first frame is drawn in the colors the terminal chose and can
			// show, and, when the cell sizes the page, at the size it reported.
			// Input does not wait for any of them.
			this[kFirstFrame] = Promise.all([
				schemeSettled,
				depthSettled,
				...(measuresCell ? [cellAnswered] : []),
			]).then(() => {});
			if (measuresCell) {
				// A font zoom resizes the grid, and the cell with it. The page
				// hears of it once, when the cell is known.
				this[kExchange].deferResizeEvent();
				this[kExchange].addEventListener("terminalresize", (event) => {
					const {sizeChanged} = event as TerminalResizeEvent;
					void this[kExchange].negotiateCellPixels().then((cellChanged) => {
						if (!isAttached(this)) {
							return;
						}
						if (cellChanged) {
							cellPixelsChanged(this);
							cellSizeChanged(this);
							void render(this);
						} else if (sizeChanged) {
							dispatchAsUserAgent(this.window, new this.window.Event("resize"));
						}
					});
				});
			}
			this[kLifecycle] = "attached";
			begun();

			// A microtask later, so synchronous code after attach() can still
			// drain its own mutations with render().
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await render(this);
		})();
		return this[kAttachReady];
	}

	// lib.dom's shape: the keyed overload first.
	override addEventListener<K extends keyof TermDOMEventMap>(
		type: K,
		listener: (this: TermDOM, event: TermDOMEventMap[K]) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void;
	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		super.addEventListener(type, listener, options);
	}

	override removeEventListener<K extends keyof TermDOMEventMap>(
		type: K,
		listener: (this: TermDOM, event: TermDOMEventMap[K]) => unknown,
		options?: boolean | EventListenerOptions,
	): void;
	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void;
	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		super.removeEventListener(type, listener, options);
	}

	/**
	 * Render to ANSI at the transport's width: colors and line breaks, no
	 * cursor controls, no modes. Without an argument, the document as it
	 * stands; with HTML, that markup, leaving the document untouched.
	 * Colors are the framebuffer's: the transport's `colorDepth`, or what the
	 * terminal said when attached, and 256 colors before it is asked.
	 */
	renderANSI(html?: string): string {
		return html === undefined
			? renderStatic(this, "\n")
			: renderStaticHTML(this, html, "\n");
	}

	/**
	 * Write renderANSI(html), or the document without an argument, through
	 * the transport as ordinary output. Uses CRLF while a raw-mode session
	 * holds the terminal.
	 */
	print(html?: string): Promise<void> {
		const lineEnding = isAttached(this) && this[kTransport].interactive
			? "\r\n"
			: "\n";
		if (html === undefined) {
			markPrinted(this);
		}
		const output = html === undefined
			? renderStatic(this, lineEnding)
			: renderStaticHTML(this, html, lineEnding);
		if (!output) {
			return Promise.resolve();
		}
		return this[kExchange].write(output);
	}

	/** `using dom = new TermDOM()` tears down on scope exit. */
	[Symbol.dispose](): void {
		this.dispose();
	}

	/**
	 * Hand the terminal back. Resolves when every restore has reached the
	 * transport and what "fetch" listeners passed to waitUntil() has
	 * settled. Loads still in flight are aborted. The process transport
	 * also restores the shell-critical modes synchronously, so exiting
	 * without awaiting leaves the shell usable.
	 */
	dispose(): Promise<void> {
		if (this[kLifecycle] === "disposed") {
			return Promise.resolve();
		}

		const wasAttached = isAttached(this);
		this[kLifecycle] = "disposed";
		this[kLoads].abort();
		releaseDecoder();
		setDocumentVisible(this.document, false);

		// Frames painted in place, so nothing reached the scrollback. Write the
		// document out now. Skip this if no frame was ever painted, because the
		// erases would land on someone else's rows, and skip it while
		// fullscreen, because the screen switch restores what was there before
		// entry, and that is the record.
		const closingFullscreen = isFullscreen(this);
		if (wasAttached && this[kRenderCount] > 0 && !closingFullscreen) {
			// A paint that fails on the way out must not keep the terminal's
			// modes from being restored.
			try {
				flushDocument(this);
			} catch (error) {
				holdError(this, error);
			}
		}

		// Leaving the alternate screen puts the cursor where the switch saved
		// it, on the flow content's bottom row. Step below it, or the shell's
		// next line lands on ours.
		this[kExchange].restoreEngagedModes();
		dropFullscreen(this.document);
		this[kHoverReportingEnabled] = false;
		this[kMouseReportingEnabled] = false;
		// A program that was fullscreen from its first frame leaves nothing
		// behind, as vim does: the cursor returns to the command line.
		if (
			closingFullscreen && this[kTransport].interactive && this[kFlowPainted]
		) {
			void this[kExchange].write("\r\n");
		}
		writeHeldErrors(this);

		this[kExchange].dispose();

		this[kInput].dispose();

		if (this[kStaticSibling]) {
			void this[kStaticSibling].dispose();
			this[kStaticSibling] = null;
		}
		this[kCascade].dispose();
		this[kLayout].dispose();
		clearHighlights(this.document);
		disconnectObservers(this.document);
		return Promise.all([this[kExchange].flush(), ...this[kLifetimes]])
			.then(() => {});
	}
}

/**
 * An exception the page let escape, once the window's error event has
 * not handled it. A browser would log it to the console and go on. The
 * console here is the transport's log when it has one apart from the
 * screen, and the scrollback below the document at the end otherwise;
 * the app runs on either way.
 */
function reportUncaught(termDOM: TermDOM, error: unknown): void {
	const text = formatError(error);
	if (termDOM[kTransport].logError?.(text)) {
		return;
	}
	if (!isAttached(termDOM) || !termDOM[kTransport].interactive) {
		console.error(text);
		return;
	}
	holdError(termDOM, error);
}

// The sessions holding errors not yet written. However the process ends,
// by dispose, process.exit(), a signal or a crash, its exit writes what is
// left, after the transport has restored the terminal.
const sessionsHoldingErrors = new Set<TermDOM>();

// The sessions whose document a stdout that is not a terminal has not
// been given. An exit before dispose() prints it.
const sessionsUnprinted = new Set<TermDOM>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) {
		return;
	}
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const session of sessionsUnprinted) {
			const output = takeUnprinted(session);
			if (output) {
				session[kTransport].writeSync?.(output);
			}
		}
		for (const session of sessionsHoldingErrors) {
			const text =
				(session[kUnwrittenErrors] ?? "") + (takeHeldErrors(session) ?? "");
			if (text !== "") {
				session[kTransport].writeSync?.(text);
			}
		}
	});
}

function holdError(termDOM: TermDOM, error: unknown): void {
	const held = termDOM[kHeldErrors];
	held.push(formatError(error));
	if (held.length > HELD_ERROR_LIMIT) {
		held.shift();
	}
	sessionsHoldingErrors.add(termDOM);
	installExitHook();
}

// The held errors as the lines to print, emptying the hold.
function takeHeldErrors(termDOM: TermDOM): string | null {
	const held = termDOM[kHeldErrors];
	termDOM[kHeldErrors] = [];
	if (held.length === 0 || !termDOM[kTransport].interactive) {
		return null;
	}
	return held.join("\r\n") + "\r\n";
}

// Into the output queue, after the document. Until that write lands, the
// process's exit writes the text itself.
function writeHeldErrors(termDOM: TermDOM): void {
	const text = takeHeldErrors(termDOM);
	if (text === null) {
		if (termDOM[kUnwrittenErrors] === null) {
			sessionsHoldingErrors.delete(termDOM);
		}
		return;
	}
	termDOM[kUnwrittenErrors] = (termDOM[kUnwrittenErrors] ?? "") + text;
	void termDOM[kExchange].writeLines(text).then(() => {
		termDOM[kUnwrittenErrors] = null;
		if (termDOM[kHeldErrors].length === 0) {
			sessionsHoldingErrors.delete(termDOM);
		}
	});
}

function formatError(error: unknown): string {
	const text = error instanceof Error
		? error.stack || `${error.name}: ${error.message}`
		: String(error);
	return text.replace(/\r?\n/g, "\r\n");
}

function isFullscreen(termDOM: TermDOM): boolean {
	return termDOM.document.fullscreenElement !== null;
}

function isAttached(termDOM: TermDOM): boolean {
	const lifecycle = termDOM[kLifecycle];
	return lifecycle === "attaching" || lifecycle === "attached";
}

/**
 * End the session. Called when the window closed and beforeunload
 * allowed it, or when the terminal went away.
 */
function closeTermDOM(termDOM: TermDOM): void {
	// A terminal that went away has nothing to drain or close.
	const live = isAttached(termDOM) && !termDOM[kExchange].transportClosed;
	// Wait for attach to finish so the final output lands where the frame
	// was, and let everything dispose queued reach the wire before the
	// transport acts on the close (a process transport exits).
	void (async () => {
		if (live) {
			await termDOM[kAttachReady];
			// The last frames' DSR replies are on the wire. Read them while the
			// session still owns the terminal, or the shell receives them as
			// typing.
			await termDOM[kExchange].drainQueries(200);
		}
		await termDOM.dispose();
		if (live) {
			termDOM[kTransport].close({status: 0});
		}
	})();
}

/**
 * The mouse is captured while the document owns the document scroll. When the
 * wheel has been yielded to the terminal, capture would take the user's
 * scrollback and selection for nothing.
 */
function syncMouseReporting(termDOM: TermDOM): void {
	const wanted =
		isAttached(termDOM) &&
		termDOM[kTransport].interactive &&
		!termDOM[kInput].mouseCaptureYielded;
	if (wanted === termDOM[kMouseReportingEnabled]) {
		return;
	}
	termDOM[kMouseReportingEnabled] = wanted;
	termDOM[kExchange].setDisplayType("mouseCapture", wanted);
}

/**
 * Motion reporting (1003) sends a report per cell the pointer crosses, so
 * it is on only while capture is on and something observes hover.
 */
function syncHoverReporting(termDOM: TermDOM): void {
	const wanted =
		termDOM[kMouseReportingEnabled] &&
		(hoverListenerCount(termDOM.document) > 0 ||
			termDOM[kCascade].hoverRulesExist());
	if (wanted === termDOM[kHoverReportingEnabled]) {
		return;
	}
	termDOM[kHoverReportingEnabled] = wanted;
	termDOM[kExchange].setDisplayType("motionReporting", wanted);
}

// An image's or a canvas's natural size in cells is its pixels over the
// cell's, so a cell measured anew lays them out again.
function cellPixelsChanged(termDOM: TermDOM): void {
	relayoutReplacedElements(termDOM.document);
}

// Every length the page wrote measures differently now, and so does the
// viewport, as after a resize.
function cellSizeChanged(termDOM: TermDOM): void {
	termDOM[kCascade].syncStylesheets();
	const window = termDOM.window;
	dispatchAsUserAgent(window, new window.Event("resize"));
	syncMediaQueries(termDOM.document);
}

async function render(termDOM: TermDOM): Promise<void> {
	// Until attach(), mutations keep the DOM and layout live but write
	// nothing.
	if (!isAttached(termDOM)) {
		return;
	}

	// A settling resize suppresses every render until its re-anchored
	// redraw.
	if (termDOM[kExchange].resizing) {
		return;
	}

	// Coalesce, never drop. A dropped render leaves the diff's previous
	// buffer out of step with the screen. The loop folds this call's changes
	// into a trailing frame, so awaiting render() means they are painted.
	if (termDOM[kRenderInFlight] !== null) {
		termDOM[kRenderQueued] = true;
		return termDOM[kRenderInFlight];
	}

	// The loop's first synchronous step can trigger a render, which has to
	// coalesce too, so claim the slot before starting.
	termDOM[kRenderInFlight] = Promise.resolve();
	let framesAwaiting = false;
	const frames = (async () => {
		try {
			// After the task that asked, and every microtask it queued, as a
			// browser renders: an edit and whatever answers it in its own
			// microtasks are one frame, not a frame of the half-done edit.
			await new Promise((resolve) => setTimeout(resolve, 0));
			do {
				termDOM[kRenderQueued] = false;
				if (termDOM[kLifecycle] === "attaching") {
					await termDOM[kAttachBegun];
				}
				// The first frame, its callbacks included, waits for what
				// decides how the page looks.
				if (termDOM[kFirstFrame] !== null) {
					const first = termDOM[kFirstFrame];
					await first;
					if (termDOM[kFirstFrame] === first) {
						termDOM[kFirstFrame] = null;
					}
				}
				// A disposed engine paints nothing, so a callback chain that
				// never ends would spin here forever; it ends with the engine.
				if (termDOM[kLifecycle] === "disposed") {
					break;
				}
				// The order of "update the rendering": the frame callbacks
				// first, then style, layout and paint, so what a callback
				// changes lands in the frame it ran for and nothing is shown
				// in between. A callback that schedules another frame re-queues
				// the loop, so requestAnimationFrame chains tick frame by frame.
				// Never inside the requestAnimationFrame() call that held it:
				// the loop's first step runs synchronously from there.
				framesAwaiting = false;
				if (hasFrameCallbacks(termDOM.document)) {
					await Promise.resolve();
					framesAwaiting = runFrameCallbacks(termDOM.document);
				}
				await renderOnce(termDOM);
				// After the paint, never inside the scrollTo() that asked
				// for it. A listener's mutations queue the next frame.
				runScrollSteps(termDOM.document);
			} while (termDOM[kRenderQueued] || framesAwaiting);
		} catch (error) {
			// The page's own exceptions were reported where they happened,
			// so this is the engine failing. Hand the terminal back first, so
			// the crash reads as one: the last frame in the scrollback, the
			// shell restored, the stack below.
			try {
				await termDOM.dispose();
			} catch (_err) {
				// The failure that got us here.
			}
			throw error;
		} finally {
			termDOM[kRenderInFlight] = null;
		}
	})();
	termDOM[kRenderInFlight] = frames;
	return frames;
}

/**
 * The await on the interactive renderer matters. The probe-echo scrub
 * that attach queued must reach the terminal before the first frame
 * does.
 */
async function renderOnce(termDOM: TermDOM): Promise<void> {
	// A render loop can outlive dispose() by one queued frame.
	if (termDOM[kLifecycle] === "attaching") {
		await termDOM[kAttachBegun];
	}
	if (termDOM[kLifecycle] === "disposed") {
		return;
	}
	if (!termDOM[kTransport].interactive) {
		printStatic(termDOM);
		return;
	}

	await renderInteractive(termDOM);
}

/**
 * Run the observers against the layout just produced. A callback that
 * mutates schedules the next frame through the mutation observer.
 */
function afterRender(termDOM: TermDOM): void {
	termDOM[kRenderCount]++;
	// The viewport in document coordinates, for IntersectionObserver.
	const viewport = new termDOM.window.DOMRect(
		0,
		termDOM[kFramebuffer].scrollTop,
		termDOM[kFramebuffer].cols,
		termDOM[kFramebuffer].rows,
	);
	// A hidden document gets no observer entries, as a background tab
	// gets none; they are delivered with the first frame after it shows.
	if (termDOM.document.visibilityState === "visible") {
		flushObservers(
			termDOM.document,
			termDOM[kLayout],
			viewport,
			termDOM[kRenderCount],
		);
	}
	// The stylesheets have parsed, so whether any rule tests :hover is
	// current.
	syncMouseReporting(termDOM);
	syncHoverReporting(termDOM);
}

/**
 * A frame for a stdout that is not a terminal. Nothing written can be
 * redrawn, so the frame lays out for the page's observers and the
 * document is printed once, when the session ends.
 */
function printStatic(termDOM: TermDOM): void {
	applyMutations(termDOM.document);
	termDOM[kLayout].performLayout();
	termDOM[kLayout].framePainted();
	termDOM[kUnprinted] = true;
	sessionsUnprinted.add(termDOM);
	installExitHook();
	afterRender(termDOM);
}

// The document as plain lines, once, for a stdout that is not a terminal.
function takeUnprinted(termDOM: TermDOM): string | null {
	if (!termDOM[kUnprinted]) {
		return null;
	}
	markPrinted(termDOM);
	return renderStatic(termDOM, "\n") || null;
}

function markPrinted(termDOM: TermDOM): void {
	termDOM[kUnprinted] = false;
	sessionsUnprinted.delete(termDOM);
}

/**
 * Frames repaint in place and commit nothing, so on the way out the
 * terminal has only seen the last one. Erase our rows and print the
 * document whole into the scrollback, like any command's output.
 */
function flushDocument(termDOM: TermDOM): void {
	if (!termDOM[kTransport].interactive) {
		const output = takeUnprinted(termDOM);
		if (output) {
			void termDOM[kExchange].write(output);
		}
		return;
	}

	const top = termDOM[kFramebuffer].documentTop;
	const output = renderStatic(termDOM, "\r\n");
	if (!output) {
		return;
	}

	// Every output line clears itself and one partial erase covers what the
	// old frame held below. Never a full ED from the top. tmux archives a
	// fully erased screen into the scrollback, which put the document there
	// twice.
	void termDOM[kExchange].cursorToRow(top + 1);
	void termDOM[kExchange].writeLines(output);
	void termDOM[kExchange].eraseBelow();
}

/** The document as ANSI: colors and line breaks, no cursor controls, no modes. */
function renderStatic(termDOM: TermDOM, lineEnding: "\n" | "\r\n"): string {
	flushLayout(termDOM.document);
	return termDOM[kFramebuffer].renderStatic(
		termDOM[kLayout].documentPaintHeight(),
		lineEnding,
		(context) => termDOM[kPainter].paint(context),
	);
}

/**
 * A window of the document, repainted in place in a region below the
 * anchor. Needing more rows scrolls earlier output into the
 * scrollback. Nothing on screen before us is painted over.
 */
async function renderInteractive(termDOM: TermDOM): Promise<void> {
	// close() sealed the previous document. Start a fresh one below it.
	if (termDOM[kSealed]) {
		termDOM[kSealed] = false;
		termDOM[kFramebuffer].scrollTo(0);
		termDOM[kFramebuffer].repaintAll();
		// detectAnchor reads a reply, so the listener must be attached.
		if (termDOM[kTransport].interactive) {
			termDOM.attach();
			await termDOM[kExchange].detectAnchor();
		}
	}

	// The region starts at the anchor row, found asynchronously. A
	// frame painted before it is known anchors a row above every later one.
	// Await only when pending, because the scroll clamp below is synchronous
	// by contract.
	const detectionPending = termDOM[kExchange].cursorDetectionPending;
	if (detectionPending) {
		await detectionPending;
	}

	// The screen switch is written at the start of a frame so no frame
	// straddles it. Entry is switch, hide, clear.
	const wantAlt = isFullscreen(termDOM);
	if (wantAlt !== termDOM[kOnAlternateScreen]) {
		termDOM[kOnAlternateScreen] = wantAlt;
		termDOM[kExchange].setDisplayType("altScreen", wantAlt);
		if (wantAlt) {
			termDOM[kExchange].setDisplayType("cursorHidden", true);
			void termDOM[kExchange].clearScreen();
		}
		// Drop the diff model, or this frame patches one screen against the
		// other's content.
		termDOM[kFramebuffer].repaintAll();
		syncMouseReporting(termDOM);
		syncHoverReporting(termDOM);
	}

	// First, so a hover listener's mutations join the records taken below.
	termDOM[kInput].resolvePendingHover();

	applyMutations(termDOM.document);
	runFocusFixup(termDOM.document);

	termDOM[kLayout].performLayout();
	clampScrollOffsets(termDOM.document);

	revealPendingCaret(termDOM.document);
	revealPendingEditingCaret(termDOM.document);

	// Nothing this frame could paint differs from the screen, so skip the
	// paint.
	const journalled = takeScrollShift(termDOM.document) as {
		element: Element;
		delta: number;
	} | null;
	const journal = termDOM[kFramebuffer].journal;
	if (
		!journal.dirty &&
		!termDOM[kLayout].moved &&
		journal.frameScroll === 0 &&
		journalled === null &&
		!journal.needsRepaint
	) {
		// Observers still run, so a fresh observe() gets its initial entry.
		afterRender(termDOM);
		return;
	}

	revealTextControlCaret(termDOM.document);

	// Fullscreen owns the alternate screen from row zero. The document's
	// scroll position survives underneath.
	const fullscreen = isFullscreen(termDOM);
	const contentHeight = fullscreen
		? termDOM[kFramebuffer].rows
		: termDOM[kLayout].documentPaintHeight();
	const regionHeight = Math.min(contentHeight, termDOM[kFramebuffer].rows);

	const top = fullscreen ? 0 : termDOM[kExchange].reserveRows(regionHeight);

	if (!fullscreen) {
		// Through scrollTo, so the journal's delta is what the screen is about
		// to be shifted by.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		termDOM[kFramebuffer].scrollTo(
			Math.min(termDOM[kFramebuffer].scrollTop, maxScroll),
		);
	}

	// The document scroll has nothing to move in fullscreen. A scroll box
	// inside it still does, under DECSTBM margins.
	const shift = termDOM[kPainter].resolveScrollShift(regionHeight, journalled);
	// Read after the clamp, which adds to the journal.
	const clamped = termDOM[kFramebuffer].journal;
	const context = termDOM[kFramebuffer].beginFrame({
		offset: -termDOM[kFramebuffer].scrollTop,
		cursorRow: top,
		regionRows: top + regionHeight,
		delta: shift ? shift.delta : fullscreen ? 0 : clamped.frameScroll,
		shift: shift ?? undefined,
	});
	termDOM[kPainter].paint(context);
	const ansi = termDOM[kFramebuffer].endFrame();
	termDOM[kLayout].framePainted();

	// The cursor stays hidden while a frame paints and between frames. It
	// is parked for resize bookkeeping, and a cursor blinking there is not
	// UI. A focused text control shows it on its caret, where IME composition
	// anchors.
	if (ansi) {
		if (!fullscreen) {
			termDOM[kFlowPainted] = true;
		}
		termDOM[kExchange].setDisplayType("cursorHidden", true);
		await termDOM[kExchange].write(ansi);
	}
	termDOM[kExchange].setDisplayType(
		"cursorHidden",
		!termDOM[kFramebuffer].caretVisible,
	);
	afterRender(termDOM);
}

function renderStaticHTML(
	termDOM: TermDOM,
	html: string,
	lineEnding: "\n" | "\r\n",
): string {
	const cols = termDOM[kTransport].cols;
	const cell = getCellSize(termDOM.document);
	const colorDepth = termDOM[kFramebuffer].colorDepth;
	const graphics = getGraphicsSetting(termDOM.document)!;
	if (
		termDOM[kStaticSibling] &&
		(termDOM[kStaticSibling][kFramebuffer].cols !== cols ||
			termDOM[kStaticSibling][kFramebuffer].colorDepth !== colorDepth ||
			getGraphicsSetting(termDOM[kStaticSibling].document) !== graphics ||
			!isSameCell(getCellSize(termDOM[kStaticSibling].document), cell))
	) {
		void termDOM[kStaticSibling].dispose();
		termDOM[kStaticSibling] = null;
	}
	termDOM[kStaticSibling] ??= new TermDOM({
		cellSize: cell === UNIT_CELL ? "unit" : cell,
		graphics,
		transport: {
			cols,
			rows: DEFAULT_ROWS,
			readable: new ReadableStream<string>({}, {highWaterMark: 0}),
			writable: new WritableStream<string>({}),
			resizes: new ReadableStream<TerminalSize>({}, {highWaterMark: 0}),
			closed: new Promise<TerminalCloseInfo>(() => {}),
			ready: Promise.resolve(),
			colorDepth,
			interactive: false,
			sharesScreen: false,
			close() {},
		},
	});

	const renderer = termDOM[kStaticSibling];
	renderer.document.body.innerHTML = html;
	return renderStatic(renderer, lineEnding);
}
