import {Cascade, getBoxModel} from "./cssom.js";
import * as DOM from "./dom.js";
import {
	createDocumentWindow,
	disconnectObservers,
	type EngineWindow,
	flushObservers,
} from "./dom.js";
import {
	Exchange,
	type TerminalCloseInfo,
	type TerminalSize,
	type TerminalTransport,
	transportFromProcess,
} from "./exchange.js";
import {Input} from "./input.js";
import {Layout} from "./layout.js";
import {Painter} from "./painter.js";
import {Screen} from "./screen.js";

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
const kPendingCaretReveal = Symbol("pendingCaretReveal");
const kTransport = Symbol("transport");
const kExchange = Symbol("exchange");
const kStaticSibling = Symbol("staticSibling");
const kAttachBegun = Symbol("attachBegun");
type Lifecycle = "detached" | "attaching" | "attached" | "disposed";
const kLifecycle = Symbol("lifecycle");

export class TermDOM {
	readonly document: Document;
	readonly window: EngineWindow;

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
	// The field whose caret the next frame reveals. The last edit before
	// the frame wins.
	declare [kPendingCaretReveal]: HTMLInputElement |
		HTMLTextAreaElement |
		HTMLSelectElement |
		null;

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
		this[kPendingCaretReveal] = null;
		// A details that closes took content away. Only opening reveals.
		const onDisclosureToggle = (event: Event): void => {
			const details = event.target as HTMLElement | null;
			if (details === null || !("open" in details)) {
				return;
			}
			if (!(details as HTMLDetailsElement).open) {
				return;
			}
			details.scrollIntoView({block: "nearest"});
		};
		// Only the active field. A select commit or an author's dispatch on an
		// unfocused control must not move the document scroll.
		const onFieldEditEvent = (event: Event): void => {
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

		// The screen measures widths over the exchange's probe channel.
		this[kExchange] = buildExchange(this);
		this[kScreen] = new Screen(
			this[kTransport].rows,
			this[kTransport].cols,
			this[kTransport].colorDepth,
			this[kExchange],
		);

		DOM.attachDocument(
			document,
			this,
			this[kLayout],
			this[kCascade],
			this[kExchange],
			this[kScreen],
		);

		this[kInput] = new Input(
			this,
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

		// Capture, so the event is seen however it bubbles.
		this.document.addEventListener("input", onFieldEditEvent, true);
		this.document.addEventListener("select", onFieldEditEvent, true);
		this.document.addEventListener("change", onFieldEditEvent, true);
		this.document.addEventListener(
			"selectionchange",
			onFieldEditEvent,
			true,
		);
		// A terminal page is one screen tall, and what a details opened is
		// often below the fold.
		this.document.addEventListener("toggle", onDisclosureToggle, true);
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
				this[kExchange].setMode("bracketedPaste", true);
				// So dispose can restore the title.
				this[kExchange].setMode("titleStack", true);
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

function isFullscreen(termdom: TermDOM): boolean {
	return termdom.document.fullscreenElement !== null;
}

export function isAttached(termdom: TermDOM): boolean {
	const lifecycle = termdom[kLifecycle];
	return lifecycle === "attaching" || lifecycle === "attached";
}

/**
 * End the session. Called when the window closed and beforeunload
 * allowed it, or when the terminal went away.
 */
export function closeTermDOM(termDOM: TermDOM): void {
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
 * Events from the terminal the engine reacts to: its size, where the
 * command started, how it orders text, what its glyphs measure, and that
 * it went away (closeTermDOM). The exchange reports them and these
 * functions react.
 */
export function terminalResized(
	termDOM: TermDOM,
	width: number,
	height: number,
): void {
	const screen = termDOM[kScreen];
	// A SIGWINCH with an unchanged size still redraws but fires no event.
	const sizeChanged = width !== screen.cols || height !== screen.rows;
	screen.resize(height, width);
	termDOM[kLayout].resize(width, height);
	// A size change can flip any @media result and every vw/vh value.
	termDOM[kCascade].syncStylesheets();
	if (sizeChanged) {
		const window = termDOM.window;
		DOM.dispatchAsUserAgent(window, new window.Event("resize"));
	}
	DOM.syncMediaQueries(termDOM.document);
}

/** Record where the frame is after a resize, for the re-anchor. */
export function frameStanding(
	termDOM: TermDOM,
	cols: number,
): {
	contentHeight: number;
	wrappedRowsAbove: number | null;
	documentTop: number;
} {
	const layout = termDOM[kLayout];
	layout.calculateLayout();
	return {
		contentHeight: layout.documentPaintHeight(),
		wrappedRowsAbove: termDOM[kScreen].wrappedRowsAbovePark(cols),
		documentTop: termDOM[kScreen].documentTop,
	};
}

/** The frame now starts at `startRow`. Repaint it from there. */
export function frameReplaced(termDOM: TermDOM, startRow: number): void {
	const screen = termDOM[kScreen];
	screen.documentTop = startRow;
	screen.anchorScrollTop = -startRow;
	screen.replaced(startRow);
	void render(termDOM);
}

/**
 * The 1-based terminal row the command started on becomes the 0-based anchor.
 */
export function anchorDetected(termDOM: TermDOM, row: number): void {
	termDOM[kScreen].documentTop = row - 1;
	termDOM[kScreen].anchorScrollTop = 1 - row;
}

export function terminalReorders(termDOM: TermDOM): void {
	termDOM[kLayout].adoptTerminalReordering();
}

/** Deferred width probes go out with the next frame even if nothing changed. */
export function probesDeferred(termDOM: TermDOM): void {
	termDOM[kScreen].flushProbes();
	void render(termDOM);
}

/**
 * A cluster measured wider or narrower than the tables said, so every
 * column after it on a painted row is off. The previous frame described
 * a screen that was never drawn. Drop it and paint again from the
 * corrected measurements.
 */
export function widthsCorrected(termDOM: TermDOM): void {
	termDOM[kLayout].invalidateTextMeasurement();
	termDOM[kScreen].repaintAll();
	void render(termDOM);
}

/**
 * document.close(): flush the document into the scrollback and seal it.
 * The next mutation starts a fresh one below it.
 */
export function sealTermDOM(termDOM: TermDOM): void {
	if (isAttached(termDOM) && termDOM[kRenderCount] > 0) {
		flushDocument(termDOM);
		termDOM[kSealed] = true;
	}
}

function buildExchange(
	termdom: TermDOM,
): Exchange {
	return new Exchange(termdom[kTransport], termdom);
}

/**
 * Re-derive everything that comes from the transport. Only before the first
 * frame.
 */
function rebindTransport(
	termdom: TermDOM,
	transport: TerminalTransport,
): void {
	termdom[kTransport] = transport;
	termdom[kScreen].rebind(transport.colorDepth);
	termdom[kExchange].rebind(transport);
}

/**
 * The mouse is captured while the document owns the document scroll. When the
 * wheel has been yielded to the terminal, capture would take the user's
 * scrollback and selection for nothing.
 */
function syncMouseReporting(
	termdom: TermDOM,
): void {
	const wanted =
		isAttached(termdom) &&
		termdom[kTransport].interactive &&
		!termdom[kInput].mouseCaptureYielded;
	if (wanted === termdom[kMouseReportingEnabled]) {
		return;
	}
	termdom[kMouseReportingEnabled] = wanted;
	termdom[kExchange].setMode("mouseCapture", wanted);
	// Motion reporting depends on capture. A yield hands the whole mouse
	// back.
	syncHoverReporting(termdom);
}

/** Whether anything in the document can observe pointer hover right now. */
function isHoverObserved(
	termdom: TermDOM,
): boolean {
	return (
		DOM.hoverListenerCount(termdom.document) > 0 ||
		termdom[kCascade].hoverRulesExist()
	);
}

/**
 * Motion reporting (1003) sends a report per cell the pointer crosses, so
 * it is on only while capture is on and something observes hover.
 */
function syncHoverReporting(
	termdom: TermDOM,
): void {
	const wanted = termdom[kMouseReportingEnabled] && isHoverObserved(termdom);
	if (wanted === termdom[kHoverReportingEnabled]) {
		return;
	}
	termdom[kHoverReportingEnabled] = wanted;
	termdom[kExchange].setMode("motionReporting", wanted);
}

export async function render(termdom: TermDOM): Promise<void> {
	// Until attach(), mutations keep the DOM and layout live but write
	// nothing.
	if (!isAttached(termdom)) {
		return;
	}

	// A settling resize suppresses every render until its re-anchored
	// redraw.
	if (termdom[kExchange].resizing) {
		return;
	}

	// Coalesce, never drop. A dropped render leaves the diff's previous
	// buffer out of step with the screen. The loop folds this call's changes
	// into a trailing frame, so awaiting render() means they are painted.
	if (termdom[kRenderInFlight] !== null) {
		termdom[kRenderQueued] = true;
		return termdom[kRenderInFlight];
	}

	// The loop's first synchronous step can trigger a render, which has to
	// coalesce too, so claim the slot before starting.
	termdom[kRenderInFlight] = Promise.resolve();
	let framesAwaiting = false;
	const frames = (async () => {
		try {
			do {
				do {
					termdom[kRenderQueued] = false;
					await renderOnce(termdom);
				} while (termdom[kRenderQueued]);
				// A callback that schedules another frame re-queues the loop, so
				// requestAnimationFrame chains tick frame by frame.
				framesAwaiting = DOM.runFrameCallbacks(termdom.document);
			} while (termdom[kRenderQueued] || framesAwaiting);
		} finally {
			termdom[kRenderInFlight] = null;
		}
	})();
	termdom[kRenderInFlight] = frames;
	return frames;
}

/**
 * The await on the interactive renderer matters. The probe-echo scrub
 * that attach queued must reach the terminal before the first frame
 * does.
 */
async function renderOnce(
	termdom: TermDOM,
): Promise<void> {
	// A render loop can outlive dispose() by one queued frame.
	if (termdom[kLifecycle] === "attaching") {
		await termdom[kAttachBegun];
	}
	if (termdom[kLifecycle] === "disposed") {
		return;
	}
	if (!termdom[kTransport].interactive) {
		await printStatic(termdom);
		return;
	}

	await renderInteractive(termdom);
}

function getDocumentFlowHeight(
	termdom: TermDOM,
): number {
	const rect =
		termdom[kLayout].getRect(termdom.document.documentElement);
	return rect ? Math.ceil(rect.height) : 0;
}

/**
 * The rows the document scroll shows. Fullscreen owns the screen from row zero,
 * and its element has left the flow, which then measures next to
 * nothing.
 */
function getScrollingRegionHeight(
	termdom: TermDOM,
): number {
	return isFullscreen(termdom)
		? termdom[kScreen].rows
		: Math.min(
			termdom[kScreen].rows,
			getDocumentFlowHeight(termdom),
		);
}

/**
 * The reveal happens on the frame the edit scheduled, so there is one
 * document scroll decision per frame instead of a synchronous layout flush per
 * keystroke.
 */
function queueCaretReveal(
	termdom: TermDOM,
	element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
	termdom[kPendingCaretReveal] = element;
	// A document scroll move and a caret move. No mutation record describes
	// either.
	termdom[kScreen].invalidate();
}

/**
 * The caret as the painter derives it: the selection focus, measured
 * through the rendered text. Null when there is no record, text or box.
 */
function getCaretRect(
	termdom: TermDOM,
	element: Element,
): {x: number; y: number} | null {
	const focus = DOM.getSelectionFocus(element);
	if (focus === null) {
		return null;
	}
	const node = DOM.getFieldValueText(element);
	if (node === null) {
		return null;
	}
	const range = element.ownerDocument.createRange();
	range.setStart(node, Math.min(focus, node.data.length));
	range.collapse(true);
	const rects = termdom[kLayout].getRangeRects(range);
	if (rects.length === 0) {
		return null;
	}
	return {x: Math.round(rects[0].x), y: Math.round(rects[0].y)};
}

/**
 * Keeps the caret inside the document scroll on edits only. Wheel-scrolling away
 * from a focused field stays allowed.
 */
function scrollCaretIntoView(
	termdom: TermDOM,
	element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
	DOM.flushLayout(termdom.document);
	const rect = termdom[kLayout].getRect(element);
	if (!rect) {
		return;
	}
	let caretY = Math.round(rect.top);
	const caret = getCaretRect(termdom, element);
	if (caret !== null) {
		caretY = caret.y;
	}
	// Widened to the field's edge when the caret is on its first or last
	// row, so the border shows instead of a cropped box.
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
	const regionHeight = getScrollingRegionHeight(termdom);
	const top = termdom[kScreen].scrollTop;
	const delta =
		revealTop < top
			? revealTop - top
			: revealBottom > top + regionHeight
				? revealBottom - (top + regionHeight)
				: 0;
	if (delta) {
		scrollDocument(termdom, delta);
	}
}

/**
 * The buffer rows the journalled element scroll covers, or null when the
 * terminal cannot shift them. DECSTBM margins are horizontal, so a scroll shift
 * is the region's full width or nothing. Content overlapping the shift is
 * dragged along and the diff repairs it.
 */
function resolveScrollShift(
	termdom: TermDOM,
	regionHeight: number,
	record: {element: Element; delta: number} | null,
): {delta: number; top: number; end: number} | null {
	const journal = termdom[kScreen].journal;
	if (
		record === null ||
		record.delta === 0 ||
		// One scroll shift per frame. The document scroll's region already
		// contains this box.
		journal.frameScroll !== 0 ||
		// The rows the terminal would shift are not the rows the last frame
		// painted.
		termdom[kLayout].moved ||
		!record.element.isConnected
	) {
		return null;
	}
	const engine = termdom[kLayout];
	const rect = engine.getRect(record.element);
	if (rect === null) {
		return null;
	}

	// The scroll port is the padding box.
	const box = getBoxModel(record.element);
	const left = rect.left + (box.borderLeftWidth || 0);
	const right = rect.left + rect.width - (box.borderRightWidth || 0);
	if (left > 0 || right < termdom[kScreen].cols) {
		return null;
	}

	// Layout rows are document rows. Buffer rows are the document scroll's. A
	// fixed box is laid out in viewport rows and the paint cancels the document
	// scroll for it.
	const lift = engine.isInFixedSpace(record.element)
		? 0
		: termdom[kScreen].scrollTop;
	const top = Math.max(
		0,
		Math.round(rect.top + (box.borderTopWidth || 0)) - lift,
	);
	const end = Math.min(
		regionHeight,
		Math.round(rect.top + rect.height - (box.borderBottomWidth || 0)) - lift,
	);
	if (end - top <= Math.abs(record.delta)) {
		return null;
	}
	return {delta: record.delta, top, end};
}

/**
 * Run the observers against the layout just produced. A callback that
 * mutates schedules the next frame through the mutation observer.
 */
function afterRender(
	termdom: TermDOM,
): void {
	termdom[kRenderCount]++;
	// The viewport in document coordinates, for IntersectionObserver.
	const viewport = new termdom.window.DOMRect(
		0,
		termdom[kScreen].scrollTop,
		termdom[kScreen].cols,
		termdom[kScreen].rows,
	);
	flushObservers(
		termdom.document,
		termdom[kLayout],
		viewport,
		termdom[kRenderCount],
	);
	// The stylesheets have parsed, so whether any rule tests :hover is
	// current.
	syncMouseReporting(termdom);
	syncHoverReporting(termdom);
}

/** The whole document as plain lines, for a stdout that is not a terminal. */
async function printStatic(
	termdom: TermDOM,
): Promise<void> {
	DOM.applyMutations(termdom.document);

	termdom[kLayout].calculateLayout();

	const context = termdom[kScreen].beginStatic({
		rows: termdom[kLayout].documentPaintHeight(),
	});
	termdom[kPainter].paint(context);
	const output = termdom[kScreen].endFrame();
	termdom[kLayout].framePainted();

	if (output) {
		await termdom[kExchange].write(output);
	}
	afterRender(termdom);
}

/**
 * Frames repaint in place and commit nothing, so on the way out the
 * terminal has only seen the last one. Erase our rows and print the
 * document whole into the scrollback, like any command's output.
 */
function flushDocument(
	termdom: TermDOM,
): void {
	if (!termdom[kTransport].interactive) {
		return;
	}

	const top = termdom[kScreen].documentTop;
	const output = renderStatic(termdom, "\r\n");
	if (!output) {
		return;
	}

	// Every output line clears itself and one partial erase covers what the
	// old frame held below. Never a full ED from the top. tmux archives a
	// fully erased screen into the scrollback, which put the document there
	// twice.
	void termdom[kExchange].cursorToRow(top + 1);
	void termdom[kExchange].writeLines(output);
	void termdom[kExchange].eraseBelow();
}

/** The document as ANSI: colors and line breaks, no cursor controls, no modes. */
function renderStatic(
	termdom: TermDOM,
	lineEnding: "\n" | "\r\n",
): string {
	DOM.flushLayout(termdom.document);
	const contentHeight = termdom[kLayout].documentPaintHeight();
	if (contentHeight === 0) {
		return "";
	}
	const context = termdom[kScreen].beginStatic({
		rows: contentHeight,
		lineEnding,
	});
	termdom[kPainter].paint(context);
	return termdom[kScreen].endFrame();
}

/**
 * A window of the document, repainted in place in a region below the
 * anchor. Needing more rows scrolls earlier output into the
 * scrollback. Nothing on screen before us is painted over.
 */
async function renderInteractive(
	termdom: TermDOM,
): Promise<void> {
	// close() sealed the previous document. Start a fresh one below it.
	if (termdom[kSealed]) {
		termdom[kSealed] = false;
		termdom[kScreen].scrollTo(0);
		termdom[kScreen].repaintAll();
		// detectAnchor reads a reply, so the listener must be attached.
		if (termdom[kTransport].interactive) {
			termdom.attach();
			await termdom[kExchange].detectAnchor();
		}
	}

	// The region starts at the anchor row, found asynchronously. A
	// frame painted before it is known anchors a row above every later one.
	// Await only when pending, because the scroll clamp below is synchronous
	// by contract.
	const detectionPending = termdom[kExchange].cursorDetectionPending;
	if (detectionPending) {
		await detectionPending;
	}

	// The screen switch is written at the start of a frame so no frame
	// straddles it. Entry is switch, hide, clear.
	const wantAlt = isFullscreen(termdom);
	if (wantAlt !== termdom[kOnAlternateScreen]) {
		termdom[kOnAlternateScreen] = wantAlt;
		termdom[kExchange].setMode("altScreen", wantAlt);
		if (wantAlt) {
			termdom[kExchange].setMode("cursorHidden", true);
			void termdom[kExchange].clearScreen();
		}
		// Drop the diff model, or this frame patches one screen against the
		// other's content.
		termdom[kScreen].repaintAll();
		syncMouseReporting(termdom);
	}

	// First, so a hover listener's mutations join the records taken below.
	termdom[kInput].resolvePendingHover();

	DOM.applyMutations(termdom.document);

	termdom[kLayout].calculateLayout();
	DOM.clampScrollOffsets(termdom.document);

	// Skipped if focus has moved on. Revealing a field the user left would
	// yank the document scroll back.
	if (termdom[kPendingCaretReveal]) {
		const reveal = termdom[kPendingCaretReveal];
		termdom[kPendingCaretReveal] = null;
		if (reveal === termdom.document.activeElement) {
			scrollCaretIntoView(termdom, reveal);
		}
	}

	// Nothing this frame could paint differs from the screen, so skip the
	// paint.
	const journalled = DOM.takeScrollShift(termdom.document) as {
		element: Element;
		delta: number;
	} | null;
	const journal = termdom[kScreen].journal;
	if (
		!journal.dirty &&
		!termdom[kLayout].moved &&
		journal.frameScroll === 0 &&
		journalled === null &&
		!journal.needsRepaint
	) {
		// Observers still run, so a fresh observe() gets its initial entry.
		afterRender(termdom);
		return;
	}

	DOM.revealFieldCaret(termdom.document);

	// Fullscreen owns the alternate screen from row zero. The document's
	// scroll position survives underneath.
	const fullscreen = isFullscreen(termdom);
	const contentHeight = fullscreen
		? termdom[kScreen].rows
		: termdom[kLayout].documentPaintHeight();
	const regionHeight = Math.min(
		contentHeight,
		termdom[kScreen].rows,
	);

	const top = fullscreen ? 0 : reserveRows(termdom, regionHeight);

	if (!fullscreen) {
		// Through scrollTo, so the journal's delta is what the screen is about
		// to be shifted by.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		termdom[kScreen].scrollTo(Math.min(termdom[kScreen].scrollTop, maxScroll));
	}

	// The document scroll has nothing to move in fullscreen. A scroll box
	// inside it still does, under DECSTBM margins.
	const shift = resolveScrollShift(termdom, regionHeight, journalled);
	// Read after the clamp, which adds to the journal.
	const clamped = termdom[kScreen].journal;
	const context = termdom[kScreen].beginFrame({
		offset: -termdom[kScreen].scrollTop,
		cursorRow: top,
		regionRows: top + regionHeight,
		delta: shift ? shift.delta : fullscreen ? 0 : clamped.frameScroll,
		shift: shift ?? undefined,
	});
	termdom[kPainter].paint(context);
	const ansi = termdom[kScreen].endFrame();
	termdom[kLayout].framePainted();

	// The cursor stays hidden while a frame paints and between frames. It
	// is parked for resize bookkeeping, and a cursor blinking there is not
	// UI. A focused field shows it on its caret, where IME composition
	// anchors.
	if (ansi) {
		termdom[kExchange].setMode("cursorHidden", true);
		await termdom[kExchange].write(ansi);
	}
	termdom[kExchange].setMode("cursorHidden", !termdom[kScreen].caretVisible);
	afterRender(termdom);
}

/**
 * How many rows the screen must scroll for `rows` to fit below the
 * anchor. The start moves up by that much.
 */
function pushRowsUp(
	termdom: TermDOM,
	rows: number,
): number {
	const overflow = termdom[kScreen].documentTop +
		rows -
		termdom[kScreen].rows;
	if (overflow <= 0) {
		return 0;
	}
	const push = Math.min(overflow, termdom[kScreen].documentTop);
	termdom[kScreen].documentTop -= push;
	return push;
}

function scrollDocument(
	termdom: TermDOM,
	rows: number,
): void {
	termdom[kScreen].scrollTo(termdom[kScreen].scrollTop + rows);
	// No mutation record describes a document scroll move.
	void render(termdom);
}

/**
 * Room below the anchor comes from scrolling earlier output into
 * the scrollback, never from painting over it. The scroll is IND (ESC D)
 * from the bottom row. A bare LF after an absolute CUP does not scroll
 * (tmux and xterm-headless both), and CSI n S scrolls without adding the
 * rows to xterm-headless's scrollback, which would make this untestable.
 * Returns the screen row the region starts at.
 */
function reserveRows(
	termdom: TermDOM,
	rows: number,
): number {
	const push = pushRowsUp(termdom, rows);
	if (push > 0) {
		void termdom[kExchange].scrollUp(termdom[kScreen].rows, push);
		// The previous buffer is not shifted. Its rows are region-relative and
		// the region top moved by exactly the scroll. A pending post-resize
		// reset is screen-absolute and does shift.
		termdom[kScreen].scrolled(push);
	}

	return termdom[kScreen].documentTop;
}

function staticRenderer(
	termdom: TermDOM,
): TermDOM {
	const cols = termdom[kTransport].cols;
	if (
		termdom[kStaticSibling] &&
		termdom[kStaticSibling][kScreen].cols !== cols
	) {
		void termdom[kStaticSibling].dispose();
		termdom[kStaticSibling] = null;
	}
	termdom[kStaticSibling] ??= new TermDOM({
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
	return termdom[kStaticSibling];
}

function renderStaticHTML(
	termdom: TermDOM,
	html: string,
	lineEnding: "\n" | "\r\n",
): string {
	const renderer = staticRenderer(termdom);
	renderer.document.body.innerHTML = html;
	return renderStatic(renderer, lineEnding);
}
