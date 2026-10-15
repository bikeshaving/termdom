import "./internal/inspector.ts";

import type {CanvasCellGridContext} from "./internal/canvas.ts";
import {Cascade, dispose, hoverRulesExist} from "./internal/cssom.ts";
import {
	applyMutations,
	attachDocument,
	clampScrollOffsets,
	clearHighlights,
	clearWindowTimers,
	constructInternal,
	disconnectObservers,
	dispatchAsUserAgent,
	DOMException,
	dropFullscreen,
	EventTarget,
	type EventTargetSlots,
	flushLayout,
	flushObservers,
	getGraphicsSettings,
	getProcessTimers,
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
import {installEditing} from "./internal/editing.ts";
import {
	abandonColorDepthQuery,
	abandonColorSchemeQuery,
	clearScreen,
	cursorToRow,
	DEFAULT_ROWS,
	deferResizeEvent,
	detectAnchor,
	type ColorDepth as EmittedColorDepth,
	eraseBelow,
	Exchange,
	flushExchange,
	initializeCursorDetection,
	negotiateBidi,
	negotiateCellPixels,
	negotiateColorDepth,
	negotiateColorScheme,
	negotiateGraphemeClusters,
	negotiateOverline,
	queryDeviceAttributes,
	reclaimModes,
	releaseModes,
	reserveRows,
	restoreEngagedModes,
	scrubProbeEcho,
	setDisplayType,
	startExchange,
	type TerminalCloseInfo,
	type TerminalResizeEvent,
	type TerminalSize,
	type TerminalTransport,
	transportFromProcess,
	writeLines,
} from "./internal/exchange.ts";
import {
	beginFrame,
	endFrame,
	Framebuffer,
	rebind,
	repaintAll,
	scrollTo,
} from "./internal/framebuffer.ts";
import {
	releaseDecoder,
	retainDecoder,
	setDecodeWorkerURL,
} from "./internal/images.ts";
import {Input, resolvePendingHover} from "./internal/input.ts";
import {
	framePainted,
	invalidateTextMeasurement,
	Layout,
	takeDamageBands,
} from "./internal/layout.ts";
import {
	checkPartialFrame,
	paint,
	Painter,
	paintsAsBefore,
	partialFrameCheck,
	resolveDocumentScrollBand,
	resolveScrollShift,
} from "./internal/painter.ts";
import {
	answerRequest,
	checkInlineHandler,
	type FetchEvent,
	isWindowFetch,
	parseContentSecurityPolicies,
	type RequestPolicy,
	setWindowFetch,
} from "./internal/resources.ts";
import {_, type internals, moveLateMembers} from "./internal/slots.ts";
import {queueMicrotask, queueTask, setTimeout} from "./internal/timers.ts";
import {getCellSizeSetting} from "./internal/tree.ts";
import {
	type CellSize,
	type CellSizeSetting,
	getCellSize,
	UNIT_CELL,
} from "./internal/units.ts";
import {createWindow} from "./internal/window.ts";

export type {CanvasCellGridContext} from "./internal/canvas.ts";
export type {CellSize} from "./internal/units.ts";
export {transportFromProcess, transportFromSSH} from "./internal/exchange.ts";
export {
	ExtendableEvent,
	FetchEvent,
	type FetchEventInit,
} from "./internal/resources.ts";
export type {
	ProcessLike,
	SSHSessionLike,
	TerminalCloseInfo,
	TerminalSize,
	TerminalTransport,
} from "./internal/exchange.ts";

declare global {
	interface HTMLCanvasElement {
		/** @experimental The cell grid may change in a minor release. */
		getContext(
			contextId: "termdom-cellgrid",
			options?: unknown,
		): CanvasCellGridContext | null;
	}
}

// Images decode on the runtime's web Worker, running src/image-decode.worker.ts,
// which builds to dist/image-decode.worker.js beside this file. A runtime with
// no Worker, as Node is without --experimental-web-worker, and a CommonJS
// build, which has no import.meta.url, decode on this thread instead.
setDecodeWorkerURL(
	typeof import.meta.url === "string"
		? new URL(
			`./image-decode.worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
			import.meta.url,
		)
		: null,
);

export interface TermDOMOptions {

	/** Defaults to the global process. */
	transport?: TerminalTransport;

	/** The initial document's markup. */
	html?: string;

	/**
	 * The initial document's URL, which relative URLs resolve against.
	 * Anything but an absolute URL throws a TypeError.
	 */
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
	 * - `{width, height}`: that size, each from 0.01 to 1000.
	 */
	cellSize?: "unit" | "auto" | CellSize;

	/**
	 * The Content Security Policy the document's loads are checked against,
	 * as a `Content-Security-Policy` header would state it: an <img> loads
	 * only what `img-src`, or `default-src` without it, allows. A page's own
	 * `<meta http-equiv="Content-Security-Policy">` can narrow it, never
	 * widen it. Left out, there is no policy and every load is allowed, as
	 * in a browser that got no header. A program showing markup it does
	 * not trust, such as email, sets one.
	 */
	csp?: string;

	/**
	 * How an <img> draws.
	 *
	 * - `"auto"` (the default): in the best way the terminal has. Today
	 *   that is cells: two pixels to a cell in half blocks, which every
	 *   terminal shows.
	 * - `"cells"`: in cells, whatever else the terminal could do.
	 * - `"none"`: not at all. An <img> loads nothing and shows its alt
	 *   text, as HTML renders one when images are disabled.
	 */
	images?: "auto" | "cells" | "none";

	/**
	 * How a canvas's "2d" context draws, with the same values as `images`.
	 * With `"none"`, `getContext("2d")` returns null, so the canvas shows
	 * its fallback content. The "termdom-cellgrid" context, which draws
	 * glyphs rather than pixels, works either way.
	 */
	canvas?: "auto" | "cells" | "none";

	/**
	 * The colors the terminal shows, in the bits `screen.colorDepth`
	 * reports: `24` for 24-bit color, `8` for the 256-color palette, `4`
	 * for the 16 basic colors. `"rgb"`, `"256"` and `"ansi"` name the same
	 * three. With `"auto"`, the default, TermDOM
	 * asks the terminal: 24 when it says it has 24-bit color, or when it is
	 * tmux, which converts 24-bit color for the terminal it runs in, and 8
	 * otherwise.
	 */
	colorDepth?: "auto" | ColorDepth;

	/**
	 * Whether the terminal's background is light or dark, which
	 * `prefers-color-scheme` reports. With "auto" (default), TermDOM asks
	 * the terminal, and takes light when it gives no answer. Any other
	 * value throws a TypeError.
	 */
	colorScheme?: "auto" | "light" | "dark";

	/**
	 * Whether an exception the page lets escape ends the session. With
	 * `false`, the default, the error is reported and the app goes on, as
	 * in a browser. With `true`, the first one hands the terminal back,
	 * prints the error and closes the transport with status 1: a process
	 * exits, and an SSH session ends that client's channel alone. Meant
	 * for development, where an error should stop the program where it
	 * happened. Any value but a boolean throws a TypeError.
	 */
	failFast?: boolean;
}

/**
 * A color depth: `24`, `8` or `4`, the bits `screen.colorDepth` reports,
 * or `"rgb"`, `"256"` or `"ansi"`, the same three by name.
 */
export type ColorDepth = 24 | 8 | 4 | EmittedColorDepth;

const COLOR_DEPTHS = new Map<unknown, EmittedColorDepth>([
	[24, "rgb"],
	[8, "256"],
	[4, "ansi"],
	["rgb", "rgb"],
	["256", "256"],
	["ansi", "ansi"],
]);

function toColorDepth(
	option: TermDOMOptions["colorDepth"],
): EmittedColorDepth | undefined {
	if (option === undefined || option === "auto") {
		return undefined;
	}
	const depth = COLOR_DEPTHS.get(option);
	if (depth === undefined) {
		throw new TypeError(
			'colorDepth must be "auto", 24, 8 or 4 ("rgb", "256" or "ansi")',
		);
	}
	return depth;
}

function toColorScheme(
	option: TermDOMOptions["colorScheme"],
): "light" | "dark" | undefined {
	if (option === undefined || option === "auto") {
		return undefined;
	}
	if (option === "light" || option === "dark") {
		return option;
	}
	throw new TypeError('colorScheme must be "auto", "light" or "dark"');
}

function toDocumentURL(option: string | undefined): string | undefined {
	if (option !== undefined && !URL.canParse(option)) {
		throw new TypeError(`url must be an absolute URL, not ${option}`);
	}
	return option;
}

function toGraphicsSetting(
	name: "images" | "canvas",
	option: TermDOMOptions["images"],
): GraphicsSetting {
	if (option === undefined || option === "auto" || option === "cells") {
		return "cells";
	}
	if (option === "none") {
		return "none";
	}
	throw new TypeError(`${name} must be "auto", "cells" or "none"`);
}

function toFailFast(option: unknown): boolean {
	if (option === undefined || typeof option === "boolean") {
		return option === true;
	}
	throw new TypeError("failFast must be a boolean");
}

function isSameCell(a: Readonly<CellSize>, b: Readonly<CellSize>): boolean {
	return a.width === b.width && a.height === b.height;
}

// A cell's side in CSS pixels. Past these, the viewport or the document
// in cells is too large to lay out.
const MIN_CELL_LENGTH = 0.01;
const MAX_CELL_LENGTH = 1000;

function isCellLength(length: unknown): length is number {
	return typeof length === "number" &&
		length >= MIN_CELL_LENGTH &&
		length <= MAX_CELL_LENGTH;
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
		isCellLength(option.width) &&
		isCellLength(option.height)
	) {
		return Object.freeze({width: option.width, height: option.height});
	}
	throw new TypeError(
		`cellSize must be "unit", "auto" or {width, height} with sizes from ${MIN_CELL_LENGTH} to ${MAX_CELL_LENGTH}`,
	);
}

type Lifecycle = "detached" | "attaching" | "attached" | "disposed";
// About a display's refresh. Changes that come faster share a frame.
const FRAME_INTERVAL_MS = 16;
const HELD_ERROR_LIMIT = 50;

/** The events a TermDOM dispatches, by type. */
export interface TermDOMEventMap {
	fetch: FetchEvent;
}

// A transport serves the one TermDOM that first attached to it, which
// takes its streams for good.
const transportUsers = new WeakMap<TerminalTransport, TermDOM>();

interface TermDOMSlots extends EventTargetSlots {
	framebuffer: Framebuffer;
	layout: Layout;
	cascade: Cascade;
	painter: Painter;
	// document.close() sealed the document into the scrollback. The next
	// mutation starts a fresh one below it.
	sealed: boolean;
	renderQueued: boolean;
	// How many frames the loop has begun, and the render() calls waiting
	// for the frame after the one under way when they were made.
	framesStarted: number;
	frameWaiters: Array<{
		frame: number;
		resolve: () => void;
		reject: (error: unknown) => void;
	}>;
	// Which screen frames land on. Switched at the start of a frame when
	// the document's fullscreen state disagrees.
	onAlternateScreen: boolean;
	// The running render loop. A render() during it queues a trailing
	// frame rather than starting another.
	renderInFlight: Promise<void> | null;
	// Whether a frame has been painted in flow, below the prompt. Leaving the
	// alternate screen restores the cursor to where the switch saved it; over
	// flow content that is the content's last row, and the shell's next line
	// would land on it.
	flowPainted: boolean;
	// When the last frame began, so the next waits out the rest of its
	// interval.
	lastFrameAt: number;
	// Errors the page let escape that no log could take live. Printed below
	// the document when the session ends.
	heldErrors: string[];
	errored: boolean;
	// Cleared once an escaped exception has begun to end the session.
	failFast: boolean;
	suspended: boolean;
	// Held errors handed to the output queue whose write has not finished.
	unwrittenErrors: string | null;
	// Timestamps observer entries.
	renderCount: number;
	// What the first frame waits for: the terminal's answers that decide
	// how the page looks.
	firstFrame: Promise<void> | null;
	// A stdout that is not a terminal gets the document once, as it stands
	// when the session ends. True while a frame has changed it since.
	unprinted: boolean;
	input: Input;
	// Construction never touches the terminal. attach() does, and dispose()
	// ends the instance for good.
	lifecycle: Lifecycle;
	mouseReportingEnabled: boolean;
	hoverReportingEnabled: boolean;
	transport: TerminalTransport;
	// The colorDepth option, or undefined when the terminal is to be asked.
	colorDepth: EmittedColorDepth | undefined;
	exchange: Exchange;
	// Resolves once the session is established and the first frame written.
	attachReady: Promise<void>;
	// Resolves once attach()'s begin phase has run. Awaited only while
	// attaching, because an unconditional await would defer every frame a
	// microtask, and the scrollTop clamp is synchronous by contract.
	attachBegun: Promise<void>;
	// The engine behind renderANSI and print, rebuilt when the width, the
	// cell or the screen's colors change.
	staticSibling: TermDOM | null;
	// What the engine behind renderANSI and print is built with, so markup
	// rendered through it is held to the same policy and base URL.
	staticOptions: Pick<TermDOMOptions, "csp" | "url">;
	// Where the document's loads dispatch "fetch", and whose dispose()
	// waits for what its listeners passed to waitUntil(). The engine behind
	// renderANSI and print hands its loads to the TermDOM it renders for.
	fetchTarget: TermDOM;
	// What "fetch" listeners passed to waitUntil(). dispose() waits for it.
	lifetimes: Set<Promise<void>>;
	// Aborts the document's loads when the TermDOM is disposed.
	loads: AbortController;
	// What dispose() returns, to every call.
	disposal: Promise<void>;
	// The window as the engine knows it, which term.window is.
	window: Window;
}

export interface TermDOM {
	readonly [internals]: TermDOMSlots;
}

/**
 * A document drawn in a terminal. It is the target of a "fetch" event for
 * each load its markup asks for that its policy allows (see FetchEvent).
 */
export class TermDOM extends EventTarget {
	readonly document: Document;
	readonly window: globalThis.Window & typeof globalThis;

	constructor(options: TermDOMOptions = {}) {
		super();
		const cellSize = toCellSizeSetting(options.cellSize);
		const images = toGraphicsSetting("images", options.images);
		const canvas = toGraphicsSetting("canvas", options.canvas);
		const slots = _(this);
		slots.colorDepth = toColorDepth(options.colorDepth);
		const url = toDocumentURL(options.url);
		slots.sealed = false;

		slots.renderQueued = false;
		slots.framesStarted = 0;
		slots.frameWaiters = [];
		slots.onAlternateScreen = false;
		slots.renderInFlight = null;
		slots.flowPainted = false;
		slots.lastFrameAt = -Infinity;
		slots.heldErrors = [];
		slots.errored = false;
		slots.failFast = toFailFast(options.failFast);
		slots.suspended = false;
		slots.unwrittenErrors = null;
		slots.renderCount = 0;
		slots.firstFrame = null;
		slots.unprinted = false;
		slots.lifecycle = "detached";

		slots.mouseReportingEnabled = false;
		slots.hoverReportingEnabled = false;

		slots.attachReady = Promise.resolve();
		slots.attachBegun = Promise.resolve();
		slots.staticSibling = null;
		slots.staticOptions = {csp: options.csp, url: options.url};
		slots.fetchTarget = this;
		slots.lifetimes = new Set();
		slots.disposal = Promise.resolve();
		retainDecoder();
		slots.loads = new AbortController();
		slots.transport = options.transport ?? transportFromProcess();

		const window = slots.window = createWindow(
			options.html ?? "<!DOCTYPE html><html><head></head><body></body></html>",
			url,
		);
		this.window = window as unknown as globalThis.Window & typeof globalThis;

		const document = this.document = this.window.document;
		const requestPolicy: RequestPolicy = {
			policies: parseContentSecurityPolicies(options.csp ?? ""),
			signal: slots.loads.signal,
			extend: (promise) => {
				const lifetime = promise.then(() => {}, () => {});
				const lifetimes = _(slots.fetchTarget).lifetimes;
				lifetimes.add(lifetime);
				void lifetime.then(() => lifetimes.delete(lifetime));
			},
			violate: (at, init) => {
				const window = this.window as unknown as typeof globalThis;
				dispatchAsUserAgent(
					at as never,
					constructInternal(() =>
						new window.SecurityPolicyViolationEvent(
							"securitypolicyviolation",
							init,
						),
					) as never,
				);
			},
		};

		// The page's fetch resolves a relative URL against the document, as a
		// browser's does, and is held to the policy and offered to the fetch
		// listeners as the markup's loads are.
		this.window.fetch = setWindowFetch(
			async (input: RequestInfo | URL, init?: RequestInit) =>
				answerRequest(
					slots.fetchTarget,
					document,
					input instanceof Request && init === undefined
						? input
						: new Request(
							typeof input === "string"
								? new URL(input, document.baseURI)
								: input,
							init,
						),
					{initiator: null},
					requestPolicy,
				),
		) as typeof this.window.fetch;

		slots.layout = new Layout(
			window,
			slots.transport.cols,
			slots.transport.rows,
		);
		slots.cascade = new Cascade(window, slots.layout);

		slots.framebuffer = new Framebuffer(
			slots.transport.rows,
			slots.transport.cols,
			slots.colorDepth ?? "256",
		);

		const exchange = slots.exchange = new Exchange(
			slots.transport,
			window,
			slots.layout,
			slots.cascade,
			slots.framebuffer,
			toColorScheme(options.colorScheme),
		);

		// The framebuffer measures widths over the exchange's probe channel.
		slots.framebuffer.measurer = exchange;

		attachDocument(document, {
			layout: slots.layout,
			cascade: slots.cascade,
			exchange: slots.exchange,
			framebuffer: slots.framebuffer,
			cellSize,
			images,
			canvas,
			load: (request, context) =>
				answerRequest(
					slots.fetchTarget,
					document,
					request,
					context,
					requestPolicy,
				),
			allowsInlineHandler: (element) =>
				checkInlineHandler(document, element, requestPolicy),
			loadSignal: slots.loads.signal,
			render: () => render(this),
			reportUncaught: (error) => {
				slots.errored = true;
				reportUncaught(this, error);
			},
		});
		installEditing(exchange);
		// The document had no size until it was attached, so an @media rule
		// in the markup was read against a zero-width viewport. Attaching is
		// a resize, and flips @media results the same way.
		slots.cascade.syncStylesheets();

		slots.input = new Input(
			this.document,
			slots.layout,
			slots.cascade,
			slots.framebuffer,
			() => {
				void suspendTermDOM(this);
			},
		);

		slots.painter = new Painter(
			this.document,
			slots.layout,
			slots.cascade,
			slots.framebuffer,
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
				event.target === exchange && isAttached(this) && slots.renderCount > 0
			) {
				flushDocument(this);
				slots.sealed = true;
			}
		});
		exchange.addEventListener("terminalclose", (event) => {
			if (event.target === exchange) {
				closeTermDOM(this);
			}
		});
	}

	/**
	 * Takes over the terminal the constructor was given: starts the
	 * session, sends the startup queries, enables mouse reporting. When the
	 * transport fails to get ready, it rejects and can be called again.
	 * After dispose(), or on a transport another TermDOM has attached to,
	 * it rejects with an InvalidStateError.
	 */
	attach(): Promise<void> {
		const slots = _(this);
		if (slots.lifecycle === "disposed") {
			return Promise.reject(disposedError());
		}
		if (isAttached(this)) {
			return slots.attachReady;
		}
		const user = transportUsers.get(slots.transport);
		if (user !== undefined && user !== this) {
			return Promise.reject(
				new DOMException(
					"The transport has served another TermDOM",
					"InvalidStateError",
				),
			);
		}
		transportUsers.set(slots.transport, this);
		// Resolves when the first frame has been written. The negotiations'
		// silence timeouts must not delay that.
		slots.lifecycle = "attaching";
		setDocumentVisible(this.document, true);
		let begun!: () => void;
		slots.attachBegun = new Promise<void>((resolve) => {
			begun = resolve;
		});
		let started = false;
		const attaching = (async () => {
			await slots.transport.ready;
			// dispose() during the wait ends it. The session never starts.
			if (slots.lifecycle !== "attaching") {
				begun();
				return;
			}

			started = true;
			startExchange(slots.exchange, slots.input);
			if (slots.transport.interactive) {
				setDisplayType(slots.exchange, "bracketedPaste", true);
				// So dispose can restore the title.
				setDisplayType(slots.exchange, "titleStack", true);
				if (this.document.title) {
					void slots.exchange.setTitle(this.document.title);
				}
			}
			syncMouseReporting(this);
			syncHoverReporting(this);
			// The terminal's background, asked first so the first frame can
			// wait for it.
			const schemeBefore = slots.exchange.colorScheme;
			void negotiateColorScheme(slots.exchange).then(() => {
				if (isAttached(this) && slots.exchange.colorScheme !== schemeBefore) {
					slots.cascade.syncStylesheets();
					syncMediaQueries(this.document);
					void render(this);
				}
			});
			// What colors the terminal shows, when the program leaves it to the
			// terminal to say. Asked before DA1, like the background.
			const depthSettled = slots.colorDepth === undefined
				? negotiateColorDepth(slots.exchange).then((depth) => {
					if (isAttached(this) && depth !== slots.framebuffer.colorDepth) {
						rebind(slots.framebuffer, depth);
						syncMediaQueries(this.document);
						void render(this);
					}
				})
				: Promise.resolve();
			// A terminal answers in the order it was asked, so once it answers
			// DA1, one that said nothing of its background never will.
			const answered = queryDeviceAttributes(slots.exchange);
			initializeCursorDetection(slots.exchange);
			// A terminal that answers nothing is not waited on past the cursor
			// question the anchor already waits for.
			const cursor = slots.exchange.cursorDetectionPending;
			const schemeSettled = (
				cursor === null ? answered : Promise.race([answered, cursor])
			).then(() => {
				abandonColorSchemeQuery(slots.exchange);
				abandonColorDepthQuery(slots.exchange);
			});
			void negotiateBidi(slots.exchange);
			void negotiateGraphemeClusters(slots.exchange);
			// Math draws its bars as overlines once the terminal has agreed
			// to them, so what was measured before the answer measures again.
			void negotiateOverline(slots.exchange).then((agreed) => {
				if (agreed && isAttached(this)) {
					invalidateTextMeasurement(slots.layout);
					void render(this);
				}
			});
			scrubProbeEcho(slots.exchange);
			// After the erase, which is for the mode probes' echo. What was
			// painted against the guessed cell repaints when the answer lands.
			// When the cell sizes the page, the first frame waits for it, so
			// the page never lays out against the guess.
			const measuresCell = getCellSizeSetting(this.document) === "auto";
			const cellAnswered = negotiateCellPixels(slots.exchange).then(
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
			slots.firstFrame = Promise.all([
				schemeSettled,
				depthSettled,
				...(measuresCell ? [cellAnswered] : []),
			]).then(() => {});
			if (measuresCell) {
				// A font zoom resizes the grid, and the cell with it. The page
				// hears of it once, when the cell is known.
				deferResizeEvent(slots.exchange);
				slots.exchange.addEventListener("terminalresize", (event) => {
					const {sizeChanged} = event as TerminalResizeEvent;
					void negotiateCellPixels(slots.exchange).then((cellChanged) => {
						if (!isAttached(this)) {
							return;
						}
						if (cellChanged) {
							cellPixelsChanged(this);
							cellSizeChanged(this);
							void render(this);
						} else if (sizeChanged) {
							dispatchAsUserAgent(
								this.window,
								constructInternal(() => new this.window.Event("resize")),
							);
						}
					});
				});
			}
			slots.lifecycle = "attached";
			begun();

			// A microtask later, so synchronous code after attach() can still
			// drain its own mutations with render().
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await render(this);
		})();
		// A transport that never got ready leaves the instance as it was, so
		// attach() can be tried again. One that failed once the session
		// began is handed back.
		slots.attachReady = attaching.catch((error: unknown) => {
			if (slots.lifecycle === "attaching") {
				if (started) {
					void this.dispose();
				} else {
					slots.lifecycle = "detached";
					setDocumentVisible(this.document, false);
				}
			}
			begun();
			throw error;
		});
		return slots.attachReady;
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

	override dispatchEvent(event: globalThis.Event): boolean {
		return super.dispatchEvent(event as never);
	}

	/**
	 * Render to ANSI at the transport's width: colors and line breaks, no
	 * cursor controls, no modes. Without an argument, the document as it
	 * stands; with HTML, that markup, leaving the document untouched.
	 * Colors are the framebuffer's: the `colorDepth` option, or what the
	 * terminal said when attached, and 256 colors before it is asked.
	 * After dispose() it throws an InvalidStateError.
	 */
	renderANSI(html?: string): string {
		if (_(this).lifecycle === "disposed") {
			throw disposedError();
		}
		return html === undefined
			? renderStatic(this, "\n")
			: renderStaticHTML(this, html, "\n");
	}

	/**
	 * Write renderANSI(html), or the document without an argument, through
	 * the transport as ordinary output. Uses CRLF while a raw-mode session
	 * holds the terminal. After dispose() it rejects with an
	 * InvalidStateError.
	 */
	print(html?: string): Promise<void> {
		const slots = _(this);
		if (slots.lifecycle === "disposed") {
			return Promise.reject(disposedError());
		}
		const lineEnding = isAttached(this) && slots.transport.interactive
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
		return slots.exchange.write(output);
	}

	/**
	 * `await using term = new TermDOM()` disposes on scope exit and waits
	 * for the restores, as dispose() does.
	 */
	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	/**
	 * Hand the terminal back. Resolves when every restore has reached the
	 * transport, the replies the terminal still owes have been read or
	 * waited on for 200ms, and what "fetch" listeners passed to waitUntil()
	 * has settled. Every call returns the same promise. Loads still in
	 * flight are aborted. The process transport also restores the
	 * shell-critical modes synchronously, or at exit while replies are
	 * still owed, so exiting without awaiting leaves the shell usable.
	 */
	dispose(): Promise<void> {
		const slots = _(this);
		if (slots.lifecycle === "disposed") {
			return slots.disposal;
		}

		const wasAttached = isAttached(this);
		slots.lifecycle = "disposed";
		slots.loads.abort();
		releaseDecoder();
		setDocumentVisible(this.document, false);

		// Frames painted in place, so nothing reached the scrollback. Write the
		// document out now. Skip this if no frame was ever painted, because the
		// erases would land on someone else's rows, and skip it while
		// fullscreen, because the screen switch restores what was there before
		// entry, and that is the record.
		const closingFullscreen = isFullscreen(this);
		if (wasAttached && slots.renderCount > 0 && !closingFullscreen) {
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
		restoreEngagedModes(slots.exchange);
		dropFullscreen(this.document);
		slots.hoverReportingEnabled = false;
		slots.mouseReportingEnabled = false;
		// A program that was fullscreen from its first frame leaves nothing
		// behind, as vim does: the cursor returns to the command line.
		if (closingFullscreen && slots.transport.interactive && slots.flowPainted) {
			void slots.exchange.write("\r\n");
		}
		writeHeldErrors(this);

		// The last frames' DSR replies may be on the wire. The exchange reads
		// them before it hands the terminal back, or the shell receives them
		// as typing.
		const drained = slots.exchange.dispose();

		slots.input.dispose();

		if (slots.staticSibling) {
			void slots.staticSibling.dispose();
			slots.staticSibling = null;
		}
		dispose(slots.cascade);
		slots.layout.dispose();
		clearHighlights(this.document);
		disconnectObservers(this.document);
		clearWindowTimers(slots.window);
		slots.disposal = Promise.all([
			flushExchange(slots.exchange),
			drained,
			...slots.lifetimes,
		]).then(() => {});
		return slots.disposal;
	}
}

/**
 * Ctrl+Z: hand the terminal back, stop until the shell continues the
 * program, and take it again. The document is hidden meanwhile, as a
 * backgrounded tab is. A document in flow is written into the
 * scrollback, so the shell's lines land below it and the document starts
 * again under them; a fullscreen one leaves the alternate screen and
 * comes back to it.
 */
async function suspendTermDOM(termDOM: TermDOM): Promise<void> {
	const termDOMSlots = _(termDOM);
	const suspend = termDOMSlots.transport.suspend;
	if (
		suspend === undefined ||
		termDOMSlots.lifecycle !== "attached" ||
		termDOMSlots.suspended
	) {
		return;
	}
	termDOMSlots.suspended = true;
	setDocumentVisible(termDOM.document, false);
	const fullscreen = isFullscreen(termDOM);
	if (!fullscreen && termDOMSlots.renderCount > 0) {
		flushDocument(termDOM);
		termDOMSlots.sealed = true;
	}
	releaseModes(termDOMSlots.exchange);
	await flushExchange(termDOMSlots.exchange);
	await suspend.call(termDOMSlots.transport);
	termDOMSlots.suspended = false;
	if (termDOMSlots.lifecycle !== "attached") {
		return;
	}
	reclaimModes(termDOMSlots.exchange);
	if (termDOM.document.title) {
		void termDOMSlots.exchange.setTitle(termDOM.document.title);
	}
	if (fullscreen) {
		repaintAll(termDOMSlots.framebuffer);
	}
	setDocumentVisible(termDOM.document, true);
	void render(termDOM);
}

/**
 * How the session ended, as an exit status: 130 when Ctrl-C closed it, as
 * a shell reports an interrupt, 1 when the page let an exception escape,
 * and 0 otherwise.
 */
function getExitStatus(termDOM: TermDOM): number {
	const termDOMSlots = _(termDOM);
	if (termDOMSlots.exchange.interrupted) {
		return 130;
	}
	return termDOMSlots.errored ? 1 : 0;
}

/**
 * An exception the page let escape, once the window's error event has
 * not handled it. A browser would log it to the console and go on. The
 * console here is the transport's log when it has one apart from the
 * screen, and the scrollback below the document at the end otherwise.
 * The app runs on either way, unless failFast ends the session.
 */
function reportUncaught(termDOM: TermDOM, error: unknown): void {
	const text = formatError(error);
	const termDOMSlots = _(termDOM);
	if (!termDOMSlots.transport.logError?.(text)) {
		if (!isAttached(termDOM) || !termDOMSlots.transport.interactive) {
			console.error(text);
		} else {
			holdError(termDOM, error);
		}
	}
	if (termDOMSlots.failFast) {
		termDOMSlots.failFast = false;
		failTermDOM(termDOM);
	}
}

// As closeTermDOM, for a session that is not attached too: a process
// that never attached exits all the same.
function failTermDOM(termDOM: TermDOM): void {
	const termDOMSlots = _(termDOM);
	if (termDOMSlots.lifecycle === "disposed") {
		return;
	}
	const live = !termDOMSlots.exchange.transportClosed;
	void (async () => {
		if (isAttached(termDOM)) {
			await termDOMSlots.attachReady.catch(() => {});
		}
		await termDOM.dispose();
		if (live) {
			termDOMSlots.transport.close({status: getExitStatus(termDOM)});
		}
	})();
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
				_(session).transport.writeSync?.(output);
			}
		}
		for (const session of sessionsHoldingErrors) {
			const text =
				(_(session).unwrittenErrors ?? "") + (takeHeldErrors(session) ?? "");
			if (text !== "") {
				_(session).transport.writeSync?.(text);
			}
		}
	});
}

function holdError(termDOM: TermDOM, error: unknown): void {
	const held = _(termDOM).heldErrors;
	held.push(formatError(error));
	if (held.length > HELD_ERROR_LIMIT) {
		held.shift();
	}
	sessionsHoldingErrors.add(termDOM);
	installExitHook();
}

// The held errors as the lines to print, emptying the hold.
function takeHeldErrors(termDOM: TermDOM): string | null {
	const termDOMSlots = _(termDOM);
	const held = termDOMSlots.heldErrors;
	termDOMSlots.heldErrors = [];
	if (held.length === 0 || !termDOMSlots.transport.interactive) {
		return null;
	}
	return held.join("\r\n") + "\r\n";
}

// Into the output queue, after the document. Until that write lands, the
// process's exit writes the text itself.
function writeHeldErrors(termDOM: TermDOM): void {
	const text = takeHeldErrors(termDOM);
	const termDOMSlots = _(termDOM);
	if (text === null) {
		if (termDOMSlots.unwrittenErrors === null) {
			sessionsHoldingErrors.delete(termDOM);
		}
		return;
	}
	termDOMSlots.unwrittenErrors = (termDOMSlots.unwrittenErrors ?? "") + text;
	void writeLines(termDOMSlots.exchange, text).then(() => {
		termDOMSlots.unwrittenErrors = null;
		if (termDOMSlots.heldErrors.length === 0) {
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
	const lifecycle = _(termDOM).lifecycle;
	return lifecycle === "attaching" || lifecycle === "attached";
}

/**
 * End the session. Called when the window closed and beforeunload
 * allowed it, or when the terminal went away.
 */
function closeTermDOM(termDOM: TermDOM): void {
	// A terminal that went away has nothing to drain or close.
	const termDOMSlots = _(termDOM);
	const live = isAttached(termDOM) && !termDOMSlots.exchange.transportClosed;
	// Wait for attach to finish so the final output lands where the frame
	// was, and let everything dispose queued reach the wire before the
	// transport acts on the close (a process transport exits).
	void (async () => {
		if (live) {
			await termDOMSlots.attachReady;
		}
		await termDOM.dispose();
		if (live) {
			termDOMSlots.transport.close({status: getExitStatus(termDOM)});
		}
	})();
}

/**
 * The mouse is captured while the document owns the document scroll. When the
 * wheel has been yielded to the terminal, capture would take the user's
 * scrollback and selection for nothing.
 */
function syncMouseReporting(termDOM: TermDOM): void {
	const termDOMSlots = _(termDOM);
	const wanted =
		isAttached(termDOM) &&
		termDOMSlots.transport.interactive &&
		!termDOMSlots.input.mouseCaptureYielded;
	if (wanted === termDOMSlots.mouseReportingEnabled) {
		return;
	}
	termDOMSlots.mouseReportingEnabled = wanted;
	setDisplayType(termDOMSlots.exchange, "mouseCapture", wanted);
}

/**
 * Motion reporting (1003) sends a report per cell the pointer crosses, so
 * it is on only while capture is on and something observes hover.
 */
function syncHoverReporting(termDOM: TermDOM): void {
	const termDOMSlots = _(termDOM);
	const wanted =
		termDOMSlots.mouseReportingEnabled &&
		(hoverListenerCount(termDOM.document) > 0 ||
			hoverRulesExist(termDOMSlots.cascade));
	if (wanted === termDOMSlots.hoverReportingEnabled) {
		return;
	}
	termDOMSlots.hoverReportingEnabled = wanted;
	setDisplayType(termDOMSlots.exchange, "motionReporting", wanted);
}

// An image's or a canvas's natural size in cells is its pixels over the
// cell's, so a cell measured anew lays them out again.
function cellPixelsChanged(termDOM: TermDOM): void {
	relayoutReplacedElements(termDOM.document);
}

// Every length the page wrote measures differently now, and so does the
// viewport, as after a resize.
function cellSizeChanged(termDOM: TermDOM): void {
	_(termDOM).cascade.syncStylesheets();
	const window = termDOM.window;
	dispatchAsUserAgent(
		window,
		constructInternal(() => new window.Event("resize")),
	);
	syncMediaQueries(termDOM.document);
}

// Settled once a frame begun after the call has been painted, which holds
// the caller's changes, or once the loop stops without painting one.
function waitForFrame(termDOM: TermDOM): Promise<void> {
	const termDOMSlots = _(termDOM);
	return new Promise((resolve, reject) => {
		termDOMSlots.frameWaiters.push({
			frame: termDOMSlots.framesStarted + 1,
			resolve,
			reject,
		});
	});
}

function settleFrameWaiters(termDOM: TermDOM, painted: number): void {
	const termDOMSlots = _(termDOM);
	const waiters = termDOMSlots.frameWaiters;
	termDOMSlots.frameWaiters = waiters.filter(
		(waiter) => waiter.frame > painted,
	);
	for (const waiter of waiters) {
		if (waiter.frame <= painted) {
			waiter.resolve();
		}
	}
}

async function render(termDOM: TermDOM): Promise<void> {
	// Until attach(), mutations keep the DOM and layout live but write
	// nothing. Nor while suspended: the terminal is the shell's until the
	// program resumes, and resuming renders.
	const termDOMSlots = _(termDOM);
	if (!isAttached(termDOM) || termDOMSlots.suspended) {
		return;
	}

	// A settling resize suppresses every render until its re-anchored
	// redraw.
	if (termDOMSlots.exchange.resizing) {
		return;
	}

	// Coalesce, never drop. A dropped render leaves the diff's previous
	// buffer out of step with the screen. The loop folds this call's changes
	// into a trailing frame, so awaiting render() means they are painted.
	// It waits for that frame, not for the loop to go idle, which a
	// requestAnimationFrame chain never lets it do.
	if (termDOMSlots.renderInFlight !== null) {
		termDOMSlots.renderQueued = true;
		return waitForFrame(termDOM);
	}

	// The loop's first synchronous step can trigger a render, which has to
	// coalesce too, so claim the slot before starting.
	termDOMSlots.renderInFlight = Promise.resolve();
	const painted = waitForFrame(termDOM);
	let framesAwaiting = false;
	const frames = (async () => {
		try {
			// After the task that asked, and every microtask it queued, as a
			// browser renders: an edit and whatever answers it in its own
			// microtasks are one frame, not a frame of the half-done edit. A
			// task the runtime runs at once, not a timer, which sleeps the
			// process and, on a loaded machine, waits for the scheduler to
			// give it the processor back.
			await new Promise<void>((resolve) => queueTask(resolve));
			do {
				termDOMSlots.renderQueued = false;
				if (termDOMSlots.lifecycle === "attaching") {
					await termDOMSlots.attachBegun;
				}
				// The first frame, its callbacks included, waits for what
				// decides how the page looks.
				if (termDOMSlots.firstFrame !== null) {
					const first = termDOMSlots.firstFrame;
					await first;
					if (termDOMSlots.firstFrame === first) {
						termDOMSlots.firstFrame = null;
					}
				}
				// A disposed engine paints nothing, so a callback chain that
				// never ends would spin here forever; it ends with the engine.
				// One whose attach failed waits for the next attach, and a
				// suspended one for resuming.
				if (!isAttached(termDOM) || termDOMSlots.suspended) {
					break;
				}
				// One frame per interval at most. What changes in the wait,
				// a burst of keys or a timer's updates, is drawn once. The
				// wait is a task even when the last frame ran over, or a
				// requestAnimationFrame chain would run frame after frame on
				// microtasks alone, and input and timers would never get a turn.
				const wait =
					termDOMSlots.lastFrameAt + FRAME_INTERVAL_MS - performance.now();
				await new Promise<void>((resolve) => {
					if (wait > 0) {
						setTimeout(resolve, wait);
					} else {
						queueTask(resolve);
					}
				});
				if (!isAttached(termDOM) || termDOMSlots.suspended) {
					break;
				}
				// A resize that began in the wait draws its own frame once
				// it settles.
				if (termDOMSlots.exchange.resizing) {
					break;
				}
				termDOMSlots.lastFrameAt = performance.now();
				const frame = ++termDOMSlots.framesStarted;
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
				settleFrameWaiters(termDOM, frame);
			} while (termDOMSlots.renderQueued || framesAwaiting);
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
			// Raised once: to whoever waits for a frame, or else out of the
			// loop.
			const waiters = termDOMSlots.frameWaiters;
			termDOMSlots.frameWaiters = [];
			if (waiters.length === 0) {
				throw error;
			}
			for (const waiter of waiters) {
				waiter.reject(error);
			}
		} finally {
			termDOMSlots.renderInFlight = null;
			settleFrameWaiters(termDOM, Infinity);
		}
	})();
	termDOMSlots.renderInFlight = frames;
	return painted;
}

/**
 * The await on the interactive renderer matters. The probe-echo scrub
 * that attach queued must reach the terminal before the first frame
 * does.
 */
async function renderOnce(termDOM: TermDOM): Promise<void> {
	// A render loop can outlive dispose() by one queued frame.
	const termDOMSlots = _(termDOM);
	if (termDOMSlots.lifecycle === "attaching") {
		await termDOMSlots.attachBegun;
	}
	if (!isAttached(termDOM) || termDOMSlots.suspended) {
		return;
	}
	if (!termDOMSlots.transport.interactive) {
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
	const termDOMSlots = _(termDOM);
	termDOMSlots.renderCount++;
	// The viewport in document coordinates, for IntersectionObserver.
	const viewport = new termDOM.window.DOMRect(
		0,
		termDOMSlots.framebuffer.scrollTop,
		termDOMSlots.framebuffer.cols,
		termDOMSlots.framebuffer.rows,
	);
	// A hidden document gets no observer entries, as a background tab
	// gets none; they are delivered with the first frame after it shows.
	if (termDOM.document.visibilityState === "visible") {
		flushObservers(
			termDOM.document,
			termDOMSlots.layout,
			viewport,
			termDOMSlots.renderCount,
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
	const termDOMSlots = _(termDOM);
	termDOMSlots.layout.performLayout();
	framePainted(termDOMSlots.layout);
	termDOMSlots.unprinted = true;
	sessionsUnprinted.add(termDOM);
	installExitHook();
	afterRender(termDOM);
}

// The document as plain lines, once, for a stdout that is not a terminal.
function takeUnprinted(termDOM: TermDOM): string | null {
	if (!_(termDOM).unprinted) {
		return null;
	}
	markPrinted(termDOM);
	return renderStatic(termDOM, "\n") || null;
}

function markPrinted(termDOM: TermDOM): void {
	_(termDOM).unprinted = false;
	sessionsUnprinted.delete(termDOM);
}

/**
 * Frames repaint in place and commit nothing, so on the way out the
 * terminal has only seen the last one. Erase our rows and print the
 * document whole into the scrollback, like any command's output.
 */
function flushDocument(termDOM: TermDOM): void {
	const termDOMSlots = _(termDOM);
	if (!termDOMSlots.transport.interactive) {
		const output = takeUnprinted(termDOM);
		if (output) {
			void termDOMSlots.exchange.write(output);
		}
		return;
	}

	const top = termDOMSlots.framebuffer.documentTop;
	const output = renderStatic(termDOM, "\r\n");
	if (!output) {
		return;
	}

	// Every output line clears itself and one partial erase covers what the
	// old frame held below. Never a full ED from the top. tmux archives a
	// fully erased screen into the scrollback, which put the document there
	// twice.
	void cursorToRow(termDOMSlots.exchange, top + 1);
	void writeLines(termDOMSlots.exchange, output);
	void eraseBelow(termDOMSlots.exchange);
}

/** The document as ANSI: colors and line breaks, no cursor controls, no modes. */
function renderStatic(termDOM: TermDOM, lineEnding: "\n" | "\r\n"): string {
	flushLayout(termDOM.document);
	const termDOMSlots = _(termDOM);
	return termDOMSlots.framebuffer.renderStatic(
		termDOMSlots.layout.documentPaintHeight(),
		lineEnding,
		(context) => paint(termDOMSlots.painter, context),
	);
}

/**
 * A window of the document, repainted in place in a region below the
 * anchor. Needing more rows scrolls earlier output into the
 * scrollback. Nothing on screen before us is painted over.
 */
async function renderInteractive(termDOM: TermDOM): Promise<void> {
	// close() sealed the previous document. Start a fresh one below it.
	const termDOMSlots = _(termDOM);
	if (termDOMSlots.sealed) {
		termDOMSlots.sealed = false;
		scrollTo(termDOMSlots.framebuffer, 0);
		repaintAll(termDOMSlots.framebuffer);
		// detectAnchor reads a reply, so the listener must be attached.
		if (termDOMSlots.transport.interactive) {
			termDOM.attach();
			// A terminal that does not answer leaves the anchor where it was,
			// as at attach, and dispose() gives the question up.
			await detectAnchor(termDOMSlots.exchange, NaN);
			if (termDOMSlots.lifecycle === "disposed") {
				return;
			}
		}
	}

	// The region starts at the anchor row, found asynchronously. A
	// frame painted before it is known anchors a row above every later one.
	// Await only when pending, because the scroll clamp below is synchronous
	// by contract.
	const detectionPending = termDOMSlots.exchange.cursorDetectionPending;
	if (detectionPending) {
		await detectionPending;
	}

	// The screen switch is written at the start of a frame so no frame
	// straddles it. Entry is switch, hide, clear.
	const wantAlt = isFullscreen(termDOM);
	if (wantAlt !== termDOMSlots.onAlternateScreen) {
		termDOMSlots.onAlternateScreen = wantAlt;
		setDisplayType(termDOMSlots.exchange, "altScreen", wantAlt);
		if (wantAlt) {
			setDisplayType(termDOMSlots.exchange, "cursorHidden", true);
			void clearScreen(termDOMSlots.exchange);
		}
		// Drop the diff model, or this frame patches one screen against the
		// other's content.
		repaintAll(termDOMSlots.framebuffer);
		syncMouseReporting(termDOM);
		syncHoverReporting(termDOM);
	}

	// First, so a hover listener's mutations join the records taken below.
	resolvePendingHover(termDOMSlots.input);

	applyMutations(termDOM.document);
	runFocusFixup(termDOM.document);

	termDOMSlots.layout.performLayout();
	clampScrollOffsets(termDOM.document);

	revealPendingCaret(termDOM.document);
	revealPendingEditingCaret(termDOM.document);

	// Nothing this frame could paint differs from the screen, so skip the
	// paint.
	const journalled = takeScrollShift(termDOM.document) as {
		element: Element;
		delta: number;
	} | null;
	const journal = termDOMSlots.framebuffer.journal;
	if (
		!journal.dirty &&
		!termDOMSlots.layout.moved &&
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
		? termDOMSlots.framebuffer.rows
		: termDOMSlots.layout.documentPaintHeight();
	const regionHeight = Math.min(contentHeight, termDOMSlots.framebuffer.rows);

	const top = fullscreen ? 0 : reserveRows(termDOMSlots.exchange, regionHeight);

	if (!fullscreen) {
		// Through scrollTo, so the journal's delta is what the screen is about
		// to be shifted by.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		scrollTo(
			termDOMSlots.framebuffer,
			Math.min(termDOMSlots.framebuffer.scrollTop, maxScroll),
		);
	}

	// The document scroll has nothing to move in fullscreen. A scroll box
	// inside it still does, under DECSTBM margins.
	const shift =
		resolveScrollShift(termDOMSlots.painter, regionHeight, journalled) ??
		(fullscreen || termDOMSlots.framebuffer.journal.frameScroll === 0
			? null
			: resolveDocumentScrollBand(
				termDOMSlots.painter,
				regionHeight,
				termDOMSlots.framebuffer.journal.frameScroll,
			));
	// Read after the clamp, which adds to the journal.
	const clamped = termDOMSlots.framebuffer.journal;
	const damage = takeDamageBands(
		termDOMSlots.layout,
		-termDOMSlots.framebuffer.scrollTop,
		(element, key) => paintsAsBefore(termDOMSlots.painter, element, key),
	);
	const context = beginFrame(termDOMSlots.framebuffer, {
		offset: -termDOMSlots.framebuffer.scrollTop,
		cursorRow: top,
		regionRows: top + regionHeight,
		delta: shift ? shift.delta : fullscreen ? 0 : clamped.frameScroll,
		shift: shift ?? undefined,
		// A box scrolled moves rows no box reports.
		bands: termDOMSlots.framebuffer.wholeDamage || journalled !== null
			? undefined
			: damage,
	});
	paint(termDOMSlots.painter, context);
	if (context.partial && partialFrameCheck.enabled) {
		checkPartialFrame(
			termDOMSlots.painter,
			context,
			termDOMSlots.framebuffer.prevFrame?.caret ?? null,
		);
	}
	const ansi = endFrame(termDOMSlots.framebuffer);
	framePainted(termDOMSlots.layout);

	// The cursor stays hidden while a frame paints and between frames. It
	// is parked for resize bookkeeping, and a cursor blinking there is not
	// UI. A focused text control shows it on its caret, where IME composition
	// anchors.
	if (ansi) {
		if (!fullscreen) {
			termDOMSlots.flowPainted = true;
		}
		setDisplayType(termDOMSlots.exchange, "cursorHidden", true);
		await termDOMSlots.exchange.write(ansi);
	}
	setDisplayType(
		termDOMSlots.exchange,
		"cursorHidden",
		!termDOMSlots.framebuffer.caretVisible,
	);
	afterRender(termDOM);
}

function renderStaticHTML(
	termDOM: TermDOM,
	html: string,
	lineEnding: "\n" | "\r\n",
): string {
	const termDOMSlots = _(termDOM);
	const cols = termDOMSlots.transport.cols;
	const cell = getCellSize(termDOM.document);
	const colorDepth = termDOMSlots.framebuffer.colorDepth;
	const graphics = getGraphicsSettings(termDOM.document)!;
	const colorScheme = termDOMSlots.exchange.colorScheme;
	if (
		termDOMSlots.staticSibling &&
		(_(termDOMSlots.staticSibling).framebuffer.cols !== cols ||
			_(termDOMSlots.staticSibling).framebuffer.colorDepth !== colorDepth ||
			_(termDOMSlots.staticSibling).exchange.colorScheme !== colorScheme ||
			getGraphicsSettings(termDOMSlots.staticSibling.document)!.images !==
				graphics.images ||
			getGraphicsSettings(termDOMSlots.staticSibling.document)!.canvas !==
				graphics.canvas ||
			!isSameCell(getCellSize(termDOMSlots.staticSibling.document), cell))
	) {
		void termDOMSlots.staticSibling.dispose();
		termDOMSlots.staticSibling = null;
	}
	termDOMSlots.staticSibling ??= new TermDOM({
		...termDOMSlots.staticOptions,
		colorScheme,
		cellSize: cell === UNIT_CELL ? "unit" : cell,
		images: graphics.images === "none" ? "none" : "cells",
		canvas: graphics.canvas === "none" ? "none" : "cells",
		colorDepth,
		transport: {
			cols,
			rows: DEFAULT_ROWS,
			readable: new ReadableStream<string>({}, {highWaterMark: 0}),
			writable: new WritableStream<string>({}),
			resizes: new ReadableStream<TerminalSize>({}, {highWaterMark: 0}),
			closed: new Promise<TerminalCloseInfo>(() => {}),
			ready: Promise.resolve(),
			interactive: false,
			sharesScreen: false,
			close() {},
		},
	});

	const renderer = termDOMSlots.staticSibling;
	_(renderer).fetchTarget = termDOM;
	renderer.document.body.innerHTML = html;
	return renderStatic(renderer, lineEnding);
}

function disposedError(): DOMException {
	return new DOMException("The TermDOM has been disposed", "InvalidStateError");
}

// Names that stay the runtime's wherever it has them: its storage. Deno's,
// and Node's given --localstorage-file, persist where the window's do not.
const RUNTIME_KEPT = new Set(["localStorage", "sessionStorage"]);

// Node defines localStorage even without --localstorage-file, as
// undefined, and warns when it is read, so it is read with the warning
// held back, and a runtime whose storage is undefined gets the window's.
function hasRuntimeGlobal(name: string): boolean {
	if (!(name in globalThis)) {
		return false;
	}
	const emitWarning = process.emitWarning;
	process.emitWarning = () => {};
	try {
		return (globalThis as Record<string, unknown>)[name] != null;
	} catch (_err) {
		return false;
	} finally {
		process.emitWarning = emitWarning;
	}
}

// Shared by every copy of this module a process loads, so two copies
// cannot each install a TermDOM's globals.
const kGlobalsInstalled = Symbol.for("@b9g/termdom.globalsInstalled");

/**
 * Defines the window's names on globalThis, for code that reaches for
 * `document`, `window`, `Element` or `requestAnimationFrame` as globals
 * the way browser code does: frameworks, editors, DOM libraries. The
 * process then reads as the window does, so a name the runtime defines
 * too, such as `setTimeout` or `navigator`, is the window's until
 * uninstalled. The runtime's storage stays its own.
 * While installed, a promise rejected with no handler fires
 * unhandledrejection on the window and is reported, where the runtime
 * would end the process. Methods are bound to the window and other
 * properties read through to it, so `scrollY` stays current. Returns a
 * function that puts back what was there.
 */
export function installGlobals(termDOM: TermDOM): () => void {
	const global = globalThis as Record<string | symbol, unknown>;
	if (global[kGlobalsInstalled]) {
		throw new Error("TermDOM's globals are already installed.");
	}
	const window = termDOM.window as unknown as Record<string, unknown>;
	const termDOMSlots = _(termDOM);
	const processTimers = getProcessTimers(termDOMSlots.window);
	// Each name's own descriptor on globalThis before, or undefined where
	// it had none, beside the descriptor put in its place.
	const installed = new Map<
		string,
		{ours: PropertyDescriptor; before: PropertyDescriptor | undefined}
	>();
	for (
		let object: object | null = window;
		object && object !== Object.prototype;
		object = Object.getPrototypeOf(object)
	) {
		for (const name of Object.getOwnPropertyNames(object)) {
			if (
				name === "constructor" ||
				name === "globalThis" ||
				installed.has(name) ||
				(RUNTIME_KEPT.has(name) && hasRuntimeGlobal(name))
			) {
				continue;
			}
			const value =
				processTimers[name] ??
				Object.getOwnPropertyDescriptor(object, name)!.value;
			let descriptor: PropertyDescriptor;
			if (typeof value === "function") {
				descriptor = {
					value: /^[a-z]/.test(name) && !isWindowFetch(value)
						? value.bind(window)
						: value,
					configurable: true,
					writable: true,
				};
			} else {
				// What a terminal does not have, such as indexedDB, reads as
				// undefined. Not installed, `typeof indexedDB` finds it missing,
				// as feature detection expects, or finds the runtime's own, such
				// as Deno's caches.
				let current: unknown;
				try {
					current = window[name];
				} catch (_err) {
					continue;
				}
				if (current === undefined && name !== "event") {
					continue;
				}
				// The window's own object is the runtime's already. A value
				// that merely compares equal, such as a handler that is null on
				// both, is not, and reads through to the window.
				if (
					current === global[name] &&
					((typeof current === "object" && current !== null) ||
						typeof current === "function")
				) {
					continue;
				}
				descriptor = {
					get: () => window[name],
					set: (next) => {
						window[name] = next;
					},
					configurable: true,
				};
			}
			const before = Object.getOwnPropertyDescriptor(globalThis, name);
			try {
				Object.defineProperty(globalThis, name, descriptor);
			} catch (_err) {
				// A runtime's global it does not let be redefined stays its own.
				continue;
			}
			installed.set(name, {ours: descriptor, before});
		}
	}
	// The process is the page's now, so a promise it rejects with no
	// handler is reported as a browser reports one, with unhandledrejection
	// on the window, and the program goes on, where a runtime would end it.
	// Deno fires its own unhandledrejection at the global, which is the
	// window's now, before it calls the process's listeners, so a promise
	// the window has heard about is reported without firing again.
	const heard = new WeakSet<object>();
	const hear = (event: Event) => {
		const promise = (event as PromiseRejectionEvent).promise;
		if (promise instanceof Object) {
			heard.add(promise);
		}
	};
	termDOM.window.addEventListener("unhandledrejection", hear);
	const reasons = new WeakMap<object, unknown>();
	const onHandled = (promise: Promise<unknown>) => {
		dispatchAsUserAgent(
			termDOM.window,
			constructInternal(() =>
				new termDOM.window.PromiseRejectionEvent("rejectionhandled", {
					promise,
					reason: reasons.get(promise),
				}),
			),
		);
	};
	const onRejection = (reason: unknown, promise: Promise<unknown>) => {
		reasons.set(promise, reason);
		if (!heard.has(promise)) {
			const event = constructInternal(() =>
				new termDOM.window.PromiseRejectionEvent("unhandledrejection", {
					promise,
					reason,
					cancelable: true,
				}),
			);
			dispatchAsUserAgent(termDOM.window, event);
			if (event.defaultPrevented) {
				return;
			}
		}
		termDOMSlots.errored = true;
		reportUncaught(termDOM, reason);
	};
	process.on("unhandledRejection", onRejection);
	// Deno fires its own rejectionhandled at the global, which is the
	// window's now, after the process hears of it.
	if (!("Deno" in globalThis)) {
		process.on("rejectionHandled", onHandled);
	}
	global[kGlobalsInstalled] = true;
	let uninstalled = false;
	return () => {
		if (uninstalled) {
			return;
		}
		uninstalled = true;
		process.removeListener("unhandledRejection", onRejection);
		process.removeListener("rejectionHandled", onHandled);
		termDOM.window.removeEventListener("unhandledrejection", hear);
		// A name something else has since redefined is that code's now.
		for (const [name, {ours, before}] of installed) {
			const current = Object.getOwnPropertyDescriptor(globalThis, name);
			if (
				current === undefined ||
				current.get !== ours.get ||
				current.value !== ours.value
			) {
				continue;
			}
			if (before === undefined) {
				delete global[name];
			} else {
				Object.defineProperty(globalThis, name, before);
			}
		}
		delete global[kGlobalsInstalled];
	};
}

moveLateMembers();
