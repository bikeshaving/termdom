import {Cascade} from "./cssom.ts";
import * as DOM from "./dom.ts";
import {
	createDocumentWindow,
	disconnectObservers,
	flushObservers,
	type Window,
} from "./dom.ts";
import {
	Exchange,
	type TerminalCloseInfo,
	type TerminalSize,
	type TerminalTransport,
	transportFromProcess,
} from "./exchange.ts";
import {Input} from "./input.ts";
import {Layout} from "./layout.ts";
import {Painter} from "./painter.ts";
import {Screen} from "./screen.ts";

export interface TermDOMOptions {

	/** Defaults to the global process. */
	transport?: TerminalTransport;

	/** The initial document's markup. */
	html?: string;

	/** The initial document's URL. */
	url?: string;
}

const kScreen = Symbol("screen");
const kLayout = Symbol("layout");
const kCascade = Symbol("cascade");
const kPainter = Symbol("painter");
const kSealed = Symbol("sealed");
const kRenderQueued = Symbol("renderQueued");
const kOnAlternateScreen = Symbol("onAlternateScreen");
const kRenderInFlight = Symbol("renderInFlight");
const kRenderCount = Symbol("renderCount");
const kInput = Symbol("input");
const kAttachReady = Symbol("attachReady");
const kMouseReportingEnabled = Symbol("mouseReportingEnabled");
const kHoverReportingEnabled = Symbol("hoverReportingEnabled");
const kTransport = Symbol("transport");
const kExchange = Symbol("exchange");
const kStaticSibling = Symbol("staticSibling");
const kAttachBegun = Symbol("attachBegun");
type Lifecycle = "detached" | "attaching" | "attached" | "disposed";
const kLifecycle = Symbol("lifecycle");

export class TermDOM {
	readonly document: Document;
	readonly window: Window;

	declare [kScreen]: Screen;
	declare [kLayout]: Layout;
	declare [kCascade]: Cascade;
	declare [kPainter]: Painter;
	// document.close() sealed the document into the scrollback. The next
	// mutation starts a fresh one below it.
	declare [kSealed]: boolean;
	declare [kRenderQueued]: boolean;
	// Which screen frames land on. Switched at the start of a frame when
	// the document's fullscreen state disagrees.
	declare [kOnAlternateScreen]: boolean;
	// The running render loop. A render() during it queues a trailing
	// frame rather than starting another.
	declare [kRenderInFlight]: Promise<void> | null;
	// Timestamps observer entries.
	declare [kRenderCount]: number;
	declare [kInput]: Input;
	// Construction never touches the terminal. attach() does, and dispose()
	// ends the instance for good.
	declare [kLifecycle]: Lifecycle;
	declare [kMouseReportingEnabled]: boolean;
	declare [kHoverReportingEnabled]: boolean;
	declare [kTransport]: TerminalTransport;
	declare [kExchange]: Exchange;
	// Resolves once the session is established and the first frame written.
	declare [kAttachReady]: Promise<void>;
	// Resolves once attach()'s begin phase has run. Awaited only while
	// attaching, because an unconditional await would defer every frame a
	// microtask, and the scrollTop clamp is synchronous by contract.
	declare [kAttachBegun]: Promise<void>;
	// The engine behind renderANSI and print, rebuilt when the width changes.
	declare [kStaticSibling]: TermDOM | null;
	constructor(options: TermDOMOptions = {}) {
		this[kSealed] = false;

		this[kRenderQueued] = false;
		this[kOnAlternateScreen] = false;
		this[kRenderInFlight] = null;
		this[kRenderCount] = 0;
		this[kLifecycle] = "detached";

		this[kMouseReportingEnabled] = false;
		this[kHoverReportingEnabled] = false;

		this[kAttachReady] = Promise.resolve();
		this[kAttachBegun] = Promise.resolve();
		this[kStaticSibling] = null;
		this[kTransport] = options.transport ?? transportFromProcess();

		this.window = createDocumentWindow(
			options.html ?? "<!DOCTYPE html><html><head></head><body></body></html>",
			options.url,
		);

		const document = this.window.document as unknown as DOM.Document;
		this.document = this.window.document;

		this[kLayout] = new Layout(
			this.window,
			this[kTransport].cols,
			this[kTransport].rows,
		);
		this[kCascade] = new Cascade(this.window, this[kLayout]);

		this[kScreen] = new Screen(
			this[kTransport].rows,
			this[kTransport].cols,
			this[kTransport].colorDepth,
		);
		this[kExchange] = new Exchange(
			this[kTransport],
			this.window,
			this[kLayout],
			this[kCascade],
			this[kScreen],
		);
		const exchange = this[kExchange];
		// The screen measures widths over the exchange's probe channel.
		this[kScreen].measurer = exchange;

		DOM.attachDocument(
			document,
			this[kLayout],
			this[kCascade],
			this[kExchange],
			this[kScreen],
			() => render(this),
		);

		this[kInput] = new Input(
			this.document,
			this[kLayout],
			this[kCascade],
			this[kScreen],
		);
		this[kPainter] = new Painter(
			this.document,
			this[kLayout],
			this[kCascade],
			this[kScreen],
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
		// Only the exchange's own reach these.
		exchange.addEventListener("seal", (event) => {
			if (event.target === exchange) {
				sealTermDOM(this);
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
		if (rebinding) {
			rebindTransport(this, transport);
		}
		// Resolves when the first frame has been written. The negotiations'
		// silence timeouts must not delay that.
		this[kLifecycle] = "attaching";
		DOM.setDocumentVisible(this.document, true);
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
			this[kExchange].initializeCursorDetection();
			void this[kExchange].negotiateBidi();
			void this[kExchange].negotiateGraphemeClusters();
			this[kExchange].scrubProbeEcho();
			this[kLifecycle] = "attached";
			begun();

			// A microtask later, so synchronous code after attach() can still
			// drain its own mutations with render().
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await render(this);
		})();
		return this[kAttachReady];
	}

	/**
	 * Render HTML to ANSI at the transport's width: colors and line breaks,
	 * no cursor controls, no modes. The instance's document is untouched.
	 */
	renderANSI(html: string): string {
		return renderStaticHTML(this, html, "\n");
	}

	/**
	 * Write renderANSI(html) through the transport as ordinary output. Uses
	 * CRLF while a raw-mode session holds the terminal.
	 */
	print(html: string): Promise<void> {
		const output = renderStaticHTML(
			this,
			html,
			isAttached(this) && this[kTransport].interactive ? "\r\n" : "\n",
		);
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
	 * transport. The process transport also restores the shell-critical
	 * modes synchronously, so exiting without awaiting leaves the shell
	 * usable.
	 */
	dispose(): Promise<void> {
		if (this[kLifecycle] === "disposed") {
			return Promise.resolve();
		}

		const wasAttached = isAttached(this);
		this[kLifecycle] = "disposed";
		DOM.setDocumentVisible(this.document, false);

		// Frames painted in place, so nothing reached the scrollback. Write the
		// document out now. Skip this if no frame was ever painted, because the
		// erases would land on someone else's rows, and skip it while
		// fullscreen, because the screen switch restores what was there before
		// entry, and that is the record.
		const closingFullscreen = isFullscreen(this);
		if (wasAttached && this[kRenderCount] > 0 && !closingFullscreen) {
			flushDocument(this);
		}

		// Leaving the alternate screen puts the cursor where the switch saved
		// it, on the flow content's bottom row. Step below it, or the shell's
		// next line lands on ours.
		this[kExchange].restoreEngagedModes();
		DOM.dropFullscreen(this.document);
		this[kHoverReportingEnabled] = false;
		this[kMouseReportingEnabled] = false;
		if (closingFullscreen && this[kTransport].interactive) {
			void this[kExchange].write("\r\n");
		}

		this[kExchange].dispose();

		this[kInput].dispose();

		if (this[kStaticSibling]) {
			void this[kStaticSibling].dispose();
			this[kStaticSibling] = null;
		}
		this[kCascade].dispose();
		this[kLayout].dispose();
		disconnectObservers(this.document);
		return this[kExchange].flush();
	}
}

function isFullscreen(termDOM: TermDOM): boolean {
	return termDOM.document.fullscreenElement !== null;
}

function isAttached(termDOM: TermDOM): boolean {
	const lifecycle = termDOM[kLifecycle];
	return lifecycle === "attaching" || lifecycle === "attached";
}

/**
 * document.close(): flush the document into the scrollback and seal it.
 * The next mutation starts a fresh one below it.
 */
function sealTermDOM(termDOM: TermDOM): void {
	if (isAttached(termDOM) && termDOM[kRenderCount] > 0) {
		flushDocument(termDOM);
		termDOM[kSealed] = true;
	}
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
 * Re-derive everything that comes from the transport. Only before the first
 * frame.
 */
function rebindTransport(
	termDOM: TermDOM,
	transport: TerminalTransport,
): void {
	termDOM[kTransport] = transport;
	termDOM[kScreen].rebind(transport.colorDepth);
	termDOM[kExchange].rebind(transport);
}

/**
 * The mouse is captured while the document owns the document scroll. When the
 * wheel has been yielded to the terminal, capture would take the user's
 * scrollback and selection for nothing.
 */
function syncMouseReporting(
	termDOM: TermDOM,
): void {
	const wanted =
		isAttached(termDOM) &&
		termDOM[kTransport].interactive &&
		!termDOM[kInput].mouseCaptureYielded;
	if (wanted === termDOM[kMouseReportingEnabled]) {
		return;
	}
	termDOM[kMouseReportingEnabled] = wanted;
	termDOM[kExchange].setDisplayType("mouseCapture", wanted);
	// Motion reporting depends on capture. A yield hands the whole mouse
	// back.
	syncHoverReporting(termDOM);
}

/** Whether anything in the document can observe pointer hover right now. */
function isHoverObserved(
	termDOM: TermDOM,
): boolean {
	return (
		DOM.hoverListenerCount(termDOM.document) > 0 ||
		termDOM[kCascade].hoverRulesExist()
	);
}

/**
 * Motion reporting (1003) sends a report per cell the pointer crosses, so
 * it is on only while capture is on and something observes hover.
 */
function syncHoverReporting(
	termDOM: TermDOM,
): void {
	const wanted = termDOM[kMouseReportingEnabled] && isHoverObserved(termDOM);
	if (wanted === termDOM[kHoverReportingEnabled]) {
		return;
	}
	termDOM[kHoverReportingEnabled] = wanted;
	termDOM[kExchange].setDisplayType("motionReporting", wanted);
}

export async function render(termDOM: TermDOM): Promise<void> {
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
			do {
				do {
					termDOM[kRenderQueued] = false;
					await renderOnce(termDOM);
				} while (termDOM[kRenderQueued]);
				// A callback that schedules another frame re-queues the loop, so
				// requestAnimationFrame chains tick frame by frame. A disposed
				// engine paints nothing, so a chain that never ends would spin
				// here forever; it ends with the engine.
				if (termDOM[kLifecycle] === "disposed") {
					break;
				}
				framesAwaiting = DOM.runFrameCallbacks(termDOM.document);
			} while (termDOM[kRenderQueued] || framesAwaiting);
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
async function renderOnce(
	termDOM: TermDOM,
): Promise<void> {
	// A render loop can outlive dispose() by one queued frame.
	if (termDOM[kLifecycle] === "attaching") {
		await termDOM[kAttachBegun];
	}
	if (termDOM[kLifecycle] === "disposed") {
		return;
	}
	if (!termDOM[kTransport].interactive) {
		await printStatic(termDOM);
		return;
	}

	await renderInteractive(termDOM);
}

/**
 * Run the observers against the layout just produced. A callback that
 * mutates schedules the next frame through the mutation observer.
 */
function afterRender(
	termDOM: TermDOM,
): void {
	termDOM[kRenderCount]++;
	// The viewport in document coordinates, for IntersectionObserver.
	const viewport = new termDOM.window.DOMRect(
		0,
		termDOM[kScreen].scrollTop,
		termDOM[kScreen].cols,
		termDOM[kScreen].rows,
	);
	flushObservers(
		termDOM.document,
		termDOM[kLayout],
		viewport,
		termDOM[kRenderCount],
	);
	// The stylesheets have parsed, so whether any rule tests :hover is
	// current.
	syncMouseReporting(termDOM);
	syncHoverReporting(termDOM);
}

/** The whole document as plain lines, for a stdout that is not a terminal. */
async function printStatic(
	termDOM: TermDOM,
): Promise<void> {
	DOM.applyMutations(termDOM.document);

	termDOM[kLayout].performLayout();

	const context = termDOM[kScreen].beginStatic({
		rows: termDOM[kLayout].documentPaintHeight(),
	});
	termDOM[kPainter].paint(context);
	const output = termDOM[kScreen].endFrame();
	termDOM[kLayout].framePainted();

	if (output) {
		await termDOM[kExchange].write(output);
	}
	afterRender(termDOM);
}

/**
 * Frames repaint in place and commit nothing, so on the way out the
 * terminal has only seen the last one. Erase our rows and print the
 * document whole into the scrollback, like any command's output.
 */
function flushDocument(
	termDOM: TermDOM,
): void {
	if (!termDOM[kTransport].interactive) {
		return;
	}

	const top = termDOM[kScreen].documentTop;
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
function renderStatic(
	termDOM: TermDOM,
	lineEnding: "\n" | "\r\n",
): string {
	DOM.flushLayout(termDOM.document);
	const contentHeight = termDOM[kLayout].documentPaintHeight();
	if (contentHeight === 0) {
		return "";
	}
	const context = termDOM[kScreen].beginStatic({
		rows: contentHeight,
		lineEnding,
	});
	termDOM[kPainter].paint(context);
	return termDOM[kScreen].endFrame();
}

/**
 * A window of the document, repainted in place in a region below the
 * anchor. Needing more rows scrolls earlier output into the
 * scrollback. Nothing on screen before us is painted over.
 */
async function renderInteractive(
	termDOM: TermDOM,
): Promise<void> {
	// close() sealed the previous document. Start a fresh one below it.
	if (termDOM[kSealed]) {
		termDOM[kSealed] = false;
		termDOM[kScreen].scrollTo(0);
		termDOM[kScreen].repaintAll();
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
		termDOM[kScreen].repaintAll();
		syncMouseReporting(termDOM);
	}

	// First, so a hover listener's mutations join the records taken below.
	termDOM[kInput].resolvePendingHover();

	DOM.applyMutations(termDOM.document);

	termDOM[kLayout].performLayout();
	DOM.clampScrollOffsets(termDOM.document);

	DOM.revealPendingCaret(termDOM.document);

	// Nothing this frame could paint differs from the screen, so skip the
	// paint.
	const journalled = DOM.takeScrollShift(termDOM.document) as {
		element: Element;
		delta: number;
	} | null;
	const journal = termDOM[kScreen].journal;
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

	DOM.revealTextControlCaret(termDOM.document);

	// Fullscreen owns the alternate screen from row zero. The document's
	// scroll position survives underneath.
	const fullscreen = isFullscreen(termDOM);
	const contentHeight = fullscreen
		? termDOM[kScreen].rows
		: termDOM[kLayout].documentPaintHeight();
	const regionHeight = Math.min(
		contentHeight,
		termDOM[kScreen].rows,
	);

	const top = fullscreen ? 0 : termDOM[kExchange].reserveRows(regionHeight);

	if (!fullscreen) {
		// Through scrollTo, so the journal's delta is what the screen is about
		// to be shifted by.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		termDOM[kScreen].scrollTo(Math.min(termDOM[kScreen].scrollTop, maxScroll));
	}

	// The document scroll has nothing to move in fullscreen. A scroll box
	// inside it still does, under DECSTBM margins.
	const shift = termDOM[kPainter].resolveScrollShift(regionHeight, journalled);
	// Read after the clamp, which adds to the journal.
	const clamped = termDOM[kScreen].journal;
	const context = termDOM[kScreen].beginFrame({
		offset: -termDOM[kScreen].scrollTop,
		cursorRow: top,
		regionRows: top + regionHeight,
		delta: shift ? shift.delta : fullscreen ? 0 : clamped.frameScroll,
		shift: shift ?? undefined,
	});
	termDOM[kPainter].paint(context);
	const ansi = termDOM[kScreen].endFrame();
	termDOM[kLayout].framePainted();

	// The cursor stays hidden while a frame paints and between frames. It
	// is parked for resize bookkeeping, and a cursor blinking there is not
	// UI. A focused text control shows it on its caret, where IME composition
	// anchors.
	if (ansi) {
		termDOM[kExchange].setDisplayType("cursorHidden", true);
		await termDOM[kExchange].write(ansi);
	}
	termDOM[kExchange].setDisplayType(
		"cursorHidden",
		!termDOM[kScreen].caretVisible,
	);
	afterRender(termDOM);
}

function renderStaticHTML(
	termDOM: TermDOM,
	html: string,
	lineEnding: "\n" | "\r\n",
): string {
	const cols = termDOM[kTransport].cols;
	if (
		termDOM[kStaticSibling] &&
		termDOM[kStaticSibling][kScreen].cols !== cols
	) {
		void termDOM[kStaticSibling].dispose();
		termDOM[kStaticSibling] = null;
	}
	termDOM[kStaticSibling] ??= new TermDOM({
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

	const renderer = termDOM[kStaticSibling];
	renderer.document.body.innerHTML = html;
	return renderStatic(renderer, lineEnding);
}
