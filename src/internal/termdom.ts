/**
 * The shell: the frame loop, and the wiring that makes the other modules one
 * running program.
 *
 * It answers none of their questions itself. The document holds the tree, the
 * cascade decides style, the box tree decides geometry and the paint walk
 * decides cells; this decides when to ask, and owns the terminal the answers
 * are written to.
 */

import {getBoxModel, StyleManager} from "./cssom.js";
import * as DOM from "./dom.js";
import {
	createDocumentWindow,
	disconnectObservers,
	type EngineWindow,
	flushObservers,
} from "./dom.js";
import {
	kSettlingResize,
	kTransportClosed,
	type TerminalCloseInfo,
	TerminalExchange,
	type TerminalSize,
	type TerminalTransport,
	transportFromProcess,
} from "./exchange.js";
import {EventHandler} from "./input.js";
import {LayoutEngine} from "./layout.js";
import {Painter} from "./painter.js";
import {Screen} from "./screen.js";

export interface TermDOMOptions {

	/**
	 * The terminal this instance renders to. Defaults to a wrapper around the
	 * global process.
	 */
	transport?: TerminalTransport;

	/** The initial document's markup. */
	html?: string;

	/** The initial document's URL. */
	url?: string;
}

/** Whether the alternate screen is engaged: an element is fullscreen. */
function isFullscreen(termdom: TermDOM): boolean {
	return termdom.document.fullscreenElement !== null;
}

/**
 * Where an instance stands with the terminal, in order: constructed and
 * writing nothing, attach() establishing the session, the session live, torn
 * down for good. Disposal is final -- there is no way back to detached.
 */
type Lifecycle = "detached" | "attaching" | "attached" | "disposed";
const kAttachBegun = Symbol("attachBegun");

const kLifecycle = Symbol("lifecycle");

/**
 * Whether the terminal is ours to write to. True from the moment attach() is
 * called, not from the moment its begin phase finishes: renders raised in
 * between belong to the session and wait on kAttachBegun rather than being
 * dropped.
 */
export function isAttached(termdom: TermDOM): boolean {
	const lifecycle = termdom[kLifecycle];
	return lifecycle === "attaching" || lifecycle === "attached";
}

export const kScreen = Symbol("screen");
export const kLayoutEngine = Symbol("layoutEngine");
export const kStyleManager = Symbol("styleManager");
const kPainter = Symbol("painter");

const kSealed = Symbol("sealed");
const kRenderQueued = Symbol("renderQueued");
const kOnAltScreen = Symbol("onAltScreen");
const kRenderInFlight = Symbol("renderInFlight");
const kRenderCount = Symbol("renderCount");

const kEventHandler = Symbol("eventHandler");
const kAttachReady = Symbol("attachReady");

/**
 * The terminal size the document has adopted, which is what `window.innerWidth`
 * reports, what a `vw` is a hundredth of, and what an `@media` query is
 * answered against.
 *
 * Distinct from `transport.cols`/`rows`, which is the size the terminal is
 * RIGHT NOW. The two part company between a SIGWINCH and the frame that
 * answers it: the transport moves immediately, this moves when the document
 * takes the new size on, so the whole of a frame resolves against one size and
 * a signal reporting a size the document already has is recognised as the
 * no-op it is.
 */

const kMouseReportingEnabled = Symbol("mouseReportingEnabled");
const kHoverReportingEnabled = Symbol("hoverReportingEnabled");
const kPendingCaretReveal = Symbol("pendingCaretReveal");

const kTransport = Symbol("transport");
export const kExchange = Symbol("exchange");
const kStaticSibling = Symbol("staticSibling");

/**
 * One document on one terminal: the object an application holds.
 *
 * It builds the document and the engine that lays it out, takes hold of the
 * terminal on the first frame, and from then on runs the loop -- mutations
 * in, a painted frame out -- until dispose() gives the terminal back.
 */
export class TermDOM {
	readonly document: Document;
	readonly window: EngineWindow;

	declare [kScreen]: Screen;
	declare [kLayoutEngine]: LayoutEngine;
	declare [kStyleManager]: StyleManager;
	// The DOM-tree -> terminal-cells paint walk. Reads geometry/styles/widgets;
	// owns no scheduling.
	declare [kPainter]: Painter;
	// One updater per live MediaQueryList: re-evaluates its query and fires
	// "change" if the answer flipped. Run by handleResize -- SIGWINCH is
	// this screen's window resize.
	// document.close() sealed the current document into scrollback; the next
	// mutation starts a fresh document below it.
	declare [kSealed]: boolean;
	declare [kRenderQueued]: boolean;
	// Which screen the frames land on; flipped by the render loop when the
	// document's fullscreen state disagrees.
	declare [kOnAltScreen]: boolean;
	// The running render loop, and the guard against re-entering it. A render()
	// call arriving while one is in flight sets renderQueued rather than being
	// dropped, so a trailing frame runs.
	declare [kRenderInFlight]: Promise<void> | null;

	// Monotonic frame counter, used to timestamp observer entries.
	declare [kRenderCount]: number;

	// The input interpreter: decoded wire items in, DOM events out, and the
	// transient gesture state interpretation needs.
	declare [kEventHandler]: EventHandler;

	// Timers that must be torn down in dispose(), or they keep the process
	// alive after the app is done -- which, across a test suite, piles up
	// into a hang.
	// The resize being settled: a fresh object from the first SIGWINCH of a
	// resize until the re-anchored redraw, and null between resizes. While one
	// is set, render() bails: the terminal has rewrapped the screen and our
	// anchor is momentarily stale, so an auto-render (an animation tick)
	// painting now lands at the wrong rows and scrolls a stray copy into the
	// scrollback. Only the final redraw that handleResize issues is allowed
	// through. The redraw waits on an async cursor query, so it holds the
	// object it was scheduled for and drops its answer if another SIGWINCH has
	// replaced it -- the newer resize's own redraw is the one that lands.
	// How far we have gone in taking hold of the terminal: raw mode, signal
	// handlers, the stdin listener and the cursor query. Construction never
	// touches the process -- attach() does, lazily on the first render or
	// explicitly -- and dispose() ends the instance for good.
	declare [kLifecycle]: Lifecycle;

	// Whether the terminal is currently reporting mouse events to us. See
	// updateMouseReporting for when capture is on.
	declare [kMouseReportingEnabled]: boolean;
	// Whether the terminal is currently reporting pointer MOTION (SGR 1003)
	// on top of button/drag reporting. See updateHoverReporting.
	declare [kHoverReportingEnabled]: boolean;
	// The field whose caret the NEXT frame must reveal -- set by edits,
	// consumed inside renderInteractive after its layout flush. Last
	// edit before the frame wins.
	declare [kPendingCaretReveal]: HTMLInputElement |
		HTMLTextAreaElement |
		HTMLSelectElement |
		null;

	declare [kTransport]: TerminalTransport;

	// The conversation over the transport: the input demultiplexer plus the
	// cursor-position (command start, resize re-anchor) and mode-support (bidi,
	// grapheme clusters) queries whose replies arrive interleaved with typing.
	declare [kExchange]: TerminalExchange;

	// What attach() hands back and hands back again: resolved once the session
	// is established and the first frame written.
	declare [kAttachReady]: Promise<void>;
	// Resolves once attach()'s begin phase has run (session started, cursor
	// detection initialized): a render triggered between attach() and that
	// phase -- a requestAnimationFrame, a mutation -- must not paint an
	// unanchored first frame. Awaited only while attaching, so steady-state
	// renders stay fully synchronous: an unconditional await would defer
	// each frame a microtask, and the scrollTop clamp is synchronous by
	// contract.
	declare [kAttachBegun]: Promise<void>;

	// The scratch engine behind renderANSI/print: created on first use,
	// sized from the transport, recreated if the width changes, reused
	// across calls.
	declare [kStaticSibling]: TermDOM | null;

	constructor(options: TermDOMOptions = {}) {
		this[kSealed] = false;

		this[kRenderQueued] = false;
		this[kOnAltScreen] = false;
		this[kRenderInFlight] = null;
		this[kRenderCount] = 0;
		this[kLifecycle] = "detached";

		this[kMouseReportingEnabled] = false;
		this[kHoverReportingEnabled] = false;
		this[kPendingCaretReveal] = null;
		// Reveal what a disclosure opened. A details that closes has taken
		// content away rather than added it, so there is nothing to bring into
		// view.
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
		// Keep a focused field's caret in view and repaint, on the standard
		// input/select/change events its own edit fires. Scoped to the active
		// field: an event from elsewhere (a select commit, an author's dispatch
		// on an unfocused control, a text input's change on blur) must not yank
		// the camera to it.
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

		// The cascade measures through the layout engine, so it is built with
		// it; the engine reads styles lazily, through the getComputedStyle the
		// cascade installs on the window.
		this[kLayoutEngine] = new LayoutEngine(this.window);
		this[kStyleManager] = new StyleManager(this.window, this[kLayoutEngine]);
		adoptTerminalSize(this, this[kTransport].cols, this[kTransport].rows);

		// The session first: the screen measures widths over the session's
		// probe channel, and takes it for its lifetime.
		this[kExchange] = buildExchange(this);
		this[kScreen] = new Screen(
			this[kTransport].rows,
			this[kTransport].cols,
			this[kTransport].colorDepth,
			this[kExchange],
		);

		// The engine the document stands on. From here a control builds and
		// keeps its own shadow tree; the shell only says when a newly
		// connected one should be upgraded.
		DOM.adoptDocument(document, this);

		this[kEventHandler] = new EventHandler(this);
		this[kPainter] = new Painter(
			this.document,
			this[kLayoutEngine],
			this[kStyleManager],
			this[kScreen],
		);

		// A field edit -- text (input), a caret or selection move
		// (select/selectionchange), or a checkbox/radio toggle (change) --
		// announces itself with standard events. The render loop keeps the caret
		// in view and repaints in response to those, rather than each edit path
		// reaching back into it. Capture, so it lands however the event bubbles.
		this.document.addEventListener("input", onFieldEditEvent, true);
		this.document.addEventListener("select", onFieldEditEvent, true);
		this.document.addEventListener("change", onFieldEditEvent, true);
		this.document.addEventListener(
			"selectionchange",
			onFieldEditEvent,
			true,
		);
		// A disclosure that opens has just put its contents on the page, and a
		// terminal's page is one screen tall: what it revealed is often below
		// the fold that hid it. Bring it into view, the way moving focus does.
		this.document.addEventListener("toggle", onDisclosureToggle, true);
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
	attach(transport: TerminalTransport = this[kTransport]): Promise<void> {
		const rebinding = transport !== this[kTransport];
		// A disposed instance owes the terminal nothing and takes nothing back.
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
		// Begin once the transport is established (a process tty already is;
		// an SSH wrapper's channel may still be opening), then paint whatever
		// the document holds. The returned promise resolves when that first
		// frame has been written; negotiations are excluded deliberately --
		// their silence timeouts must never hold a first paint hostage.
		this[kLifecycle] = "attaching";
		let begun!: () => void;
		this[kAttachBegun] = new Promise<void>((resolve) => {
			begun = resolve;
		});
		this[kAttachReady] = (async () => {
			await this[kTransport].ready;
			// dispose() during the wait ends it: the session never starts.
			if (this[kLifecycle] !== "attaching") {
				begun();
				return;
			}

			this[kExchange].start(this[kEventHandler]);
			if (this[kTransport].interactive) {
				// Bracketed paste on: pasted text arrives fenced, one insertion.
				this[kExchange].setMode("bracketedPaste", true);
				// Save the terminal's title, so dispose can hand it back; the
				// document.title setter emits the replacement.
				this[kExchange].setMode("titleStack", true);
				if (this.document.title) {
					void this[kExchange].setTitle(this.document.title);
				}
				// Frames park the cursor hidden as they paint; recorded here so
				// the restore shows it again.
				this[kExchange].markModeEngaged("cursorHidden");
			}
			updateMouseReporting(this);
			this[kExchange].initializeCursorDetection();
			void this[kExchange].negotiateBidi();
			void this[kExchange].negotiateGraphemeClusters();
			this[kExchange].scrubProbeEcho();
			this[kLifecycle] = "attached";
			begun();

			// Deferred a microtask so the render does not occupy the
			// re-entrancy guard while synchronous code right after attach()
			// still expects its own render calls to drain mutations inline.
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await render(this);
		})();
		return this[kAttachReady];
	}

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
			isAttached(this) && this[kTransport].interactive ? "\r\n" : "\n",
		);
		if (!output) {
			return Promise.resolve();
		}
		return this[kExchange].write(output);
	}

	/** Explicit resource management: `using dom = new TermDOM()` tears down on scope exit. */
	[Symbol.dispose](): void {
		this.dispose();
	}

	/**
	 * Tear down and hand the terminal back. Resolves when every queued
	 * restore has reached the transport; await it before writing further
	 * output or exiting with a status code. The process transport restores
	 * shell-critical modes synchronously besides, so exiting without
	 * awaiting still leaves the shell usable.
	 */
	dispose(): Promise<void> {
		if (this[kLifecycle] === "disposed") {
			return Promise.resolve();
		}

		// A TermDOM that never attached owes the terminal nothing: no final
		// flush, no mode restores -- there is no session to close.
		const wasAttached = isAttached(this);
		this[kLifecycle] = "disposed";

		// Document mode has been painting a window in place, so nothing it
		// showed has reached the terminal's scrollback. Pay it all out now --
		// but only if a frame was ever painted: with none, there is nothing
		// of ours on screen, and the payout's cursor moves and erases would
		// land on someone else's rows. A document closing WHILE fullscreen
		// leaves no trace instead, the way an alt-screen program does: the
		// screen switch restores what stood before entry, and that is the
		// record. An app that wants its final state in scrollback exits
		// fullscreen first and lets the flow frame pay out.
		const closingFullscreen = isFullscreen(this);
		if (wasAttached && this[kRenderCount] > 0 && !closingFullscreen) {
			flushDocument(this);
		}

		// Frames keep the terminal cursor hidden (it is parked for resize
		// bookkeeping, not UI); hand it back visible on the way out. The mouse
		// goes back to the terminal the same way, the title we replaced pops
		// back to what the terminal held before attach pushed it, and the
		// alternate screen hands the main screen back. That restore puts the
		// cursor where the switch saved it -- parked on the flow content's
		// bottom row -- so step below the content, or the shell's next line
		// lands on top of ours.
		this[kExchange].restoreEngagedModes();
		DOM.dropFullscreen(this.document);
		this[kHoverReportingEnabled] = false;
		this[kMouseReportingEnabled] = false;
		if (closingFullscreen && this[kTransport].interactive) {
			void this[kExchange].write("\r\n");
		}

		// Restore the terminal modes we negotiated, clear the session's timers
		// and handlers (a live query timer keeps the event loop open), and
		// release the transport -- which is what hands a process transport its
		// tty back.
		this[kExchange].dispose();

		this[kEventHandler].dispose();

		if (this[kStaticSibling]) {
			void this[kStaticSibling].dispose();
			this[kStaticSibling] = null;
		}
		this[kStyleManager].dispose();
		this[kLayoutEngine].dispose();
		disconnectObservers(this.document);
		return this[kExchange].flush();
	}
}

/**
 * End the session: the window closed and the beforeunload gate agreed, or
 * the terminal went away.
 */
export function closeTermDOM(termDOM: TermDOM): void {
	// A terminal that went away on its own has nothing to drain and
	// nothing to close; the engine just ends.
	const live = isAttached(termDOM) && !termDOM[kExchange][kTransportClosed];
	// An immediate close must not tear down mid-establishment: wait
	// for attach to finish (anchor found, first frame painted) so the
	// payout lands where the frame was, not at a stale row 0. Then
	// everything dispose queued must reach the wire before the
	// transport acts on the close (a process transport exits).
	void (async () => {
		if (live) {
			await termDOM[kAttachReady];
			// The last frames' DSR queries -- width probes above all
			// -- have replies on the wire. Consume them while the
			// session still reads, or they are typed into the shell
			// that inherits the tty.
			await termDOM[kExchange].drainQueries(200);
		}
		await termDOM.dispose();
		if (live) {
			termDOM[kTransport].close({status: 0});
		}
	})();
}

/**
 * Closing the document flushes the live region into the terminal's
 * scrollback and seals it -- the SSR res.end() of the terminal. This is the
 * "print rich output and stop" seam: write(), then close().
 *
 * dispose() has already set attached=false by the time it reaches here, so
 * the seal is skipped. A real seal is a close() from a live, painted
 * session.
 */
export function sealTermDOM(termDOM: TermDOM): void {
	if (isAttached(termDOM) && termDOM[kRenderCount] > 0) {
		flushDocument(termDOM);
		termDOM[kSealed] = true;
	}
}

/**
 * The exchange over the transport: input demultiplexing and the query
 * round-trips, wired to this instance's dispatchers. Rebuilt on a rebind;
 * started only by attach() -- construction holds no lock and reads nothing.
 */
function buildExchange(
	termdom: TermDOM,
): TerminalExchange {
	return new TerminalExchange({
		transport: termdom[kTransport],
		document: termdom.document,
	});
}

/**
 * Adopt `transport` and re-derive everything that comes from the terminal:
 * the session's input facts, the screen's color depth, and the sizes. In
 * place -- the mount holds the session and the screen by reference, and a
 * rebind always precedes the first frame.
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
 * Take a terminal size on as the document's own, and hand it to the layout
 * engine, which lays the viewport root out at it. The one writer: everything
 * else reads the size back through `window.innerWidth`/`innerHeight`, or
 * through the mount those go to.
 */
function adoptTerminalSize(
	termdom: TermDOM,
	width: number,
	height: number,
): void {
	// The screen is the size's owner; the constructor adopts before the
	// screen exists and builds it at this size right after.
	termdom[kScreen]?.resize(height, width);
	termdom[kLayoutEngine].resize(width, height);
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
	termdom: TermDOM,
): void {
	const wanted =
		isAttached(termdom) &&
		termdom[kTransport].interactive &&
		!termdom[kEventHandler].mouseCaptureYielded;
	if (wanted === termdom[kMouseReportingEnabled]) {
		return;
	}
	termdom[kMouseReportingEnabled] = wanted;
	// 1002 with SGR encoding: button presses, releases, wheel, and drag
	// motion, unambiguous past column 223 -- one mode as far as policy
	// goes; the session spells the pair.
	termdom[kExchange].setMode("mouseCapture", wanted);
	// Motion reporting rides on top of capture: it follows capture off (a
	// scroll-chaining yield hands the WHOLE mouse back) and back on.
	updateHoverReporting(termdom);
}

/** Whether anything in the document can observe pointer hover right now. */
function hoverObserved(
	termdom: TermDOM,
): boolean {
	return (
		DOM.hoverListenerCount(termdom.document) > 0 ||
		termdom[kStyleManager].hoverRulesExist()
	);
}

/**
 * Motion (hover) reporting -- SGR 1003 -- is DEMAND-DRIVEN: a terminal
 * reporting motion sends a report per cell the pointer crosses, a flood an
 * app that never looks at hover should not receive. So it turns on only
 * while base capture is on AND something observes hover, and turns back
 * off when the last observer goes. There is no override: observation is
 * the whole switch.
 *
 * Idempotent; called from every edge that can move the answer: capture
 * toggles, listener registration, and the end of each frame (where a
 * stylesheet's `:hover` rules have just parsed).
 */
function updateHoverReporting(
	termdom: TermDOM,
): void {
	const wanted = termdom[kMouseReportingEnabled] && hoverObserved(termdom);
	if (wanted === termdom[kHoverReportingEnabled]) {
		return;
	}
	termdom[kHoverReportingEnabled] = wanted;
	termdom[kExchange].setMode("motionReporting", wanted);
}

export async function render(termdom: TermDOM): Promise<void> {
	// attach() is the ONLY door to the terminal: until the app calls it,
	// mutations keep the DOM and layout live but write nothing. Rendering
	// resumes -- starting with whatever the document holds by then -- the
	// moment attach() runs, which ends by scheduling this render.
	if (!isAttached(termdom)) {
		return;
	}

	// A resize is settling: suppress every render until the exchange issues
	// the single re-anchored redraw.
	if (termdom[kExchange][kSettlingResize] !== null) {
		return;
	}

	// A render in flight: coalesce, don't drop. Dropping an auto-render (a
	// mutation observer firing mid-frame) leaves the diff renderer's
	// previous-buffer out of step with the screen, which shows up as rows drawn
	// at the wrong place. Instead mark one pending and hand back the running
	// loop's promise: it will fold this caller's changes into a trailing frame,
	// so awaiting render() always means "the caller's changes are painted".
	if (termdom[kRenderInFlight] !== null) {
		termdom[kRenderQueued] = true;
		return termdom[kRenderInFlight];
	}

	// The loop's own first synchronous step can raise a render, and that one
	// has to coalesce like any other: claim the slot before starting, then
	// hand the real promise over the moment the loop yields.
	termdom[kRenderInFlight] = Promise.resolve();
	let framesAwaiting = false;
	const frames = (async () => {
		try {
			do {
				do {
					termdom[kRenderQueued] = false;
					await renderOnce(termdom);
				} while (termdom[kRenderQueued]);
				// The frames are written; wake everything that awaited them.
				// A callback that schedules another frame re-queues the
				// outer loop, so a chain of requestAnimationFrame calls
				// ticks frame by frame instead of stalling after the first.
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
 * The guards a frame passes before it may paint, and the fork between the
 * two renderers.
 *
 * Awaiting the interactive renderer through this call is load-bearing: the
 * probe-echo scrub attach queues must reach the terminal before the first
 * frame paints, and folding the two together writes the frame a turn
 * earlier -- soon enough for the erase to land on a row already painted.
 */
async function renderOnce(
	termdom: TermDOM,
): Promise<void> {
	// The begin phase has to land before a frame can be anchored, and an
	// in-flight render loop can outlive dispose() by one queued frame;
	// everything below assumes a live document.
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

/**
 * The rows the document's flow occupies, from the root box that holds it.
 */
function documentFlowHeight(
	termdom: TermDOM,
): number {
	const rect =
		termdom[kLayoutEngine].getRect(termdom.document.documentElement);
	return rect ? Math.ceil(rect.height) : 0;
}

/**
 * The height of the window the camera shows, for the scroll-to-reveal
 * math. Fullscreen owns the whole screen from row zero, and the
 * fullscreen element has left the flow -- the flow measures next to
 * nothing there, and a reveal sized by it would scroll the camera by the
 * target's whole row.
 */
function cameraRegionHeight(
	termdom: TermDOM,
): number {
	return isFullscreen(termdom)
		? termdom[kScreen].rows
		: Math.min(
			termdom[kScreen].rows,
			documentFlowHeight(termdom),
		);
}

/**
 * Queue a caret reveal for the next frame. The reveal rides the frame
 * the edit already scheduled: one camera decision against the layout
 * that frame flushes anyway, however many keystrokes coalesced into it.
 * Revealing immediately instead would cost a full synchronous layout
 * flush per keystroke, before the frame's own -- half the typing latency.
 */
function queueCaretReveal(
	termdom: TermDOM,
	element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
	termdom[kPendingCaretReveal] = element;
	// The reveal is a camera decision and a caret move, neither of which a
	// mutation record describes.
	termdom[kScreen].invalidate();
}

/**
 * Where a control's caret sits on screen, derived as the painter derives
 * it: the focus of the selection record, measured through the text the
 * control renders. Null when there is no record, no text, or no box --
 * an empty value's caret is the caller's fallback.
 */
function caretRectFor(
	termdom: TermDOM,
	element: Element,
): {x: number; y: number} | null {
	const focus = DOM.selectionFocusOf(element);
	if (focus === null) {
		return null;
	}
	const node = DOM.fieldValueText(element);
	if (node === null) {
		return null;
	}
	const range = element.ownerDocument.createRange();
	range.setStart(node, Math.min(focus, node.data.length));
	range.collapse(true);
	const rects = termdom[kLayoutEngine].getRangeRects(range);
	if (rects.length === 0) {
		return null;
	}
	return {x: Math.round(rects[0].x), y: Math.round(rects[0].y)};
}

/**
 * Keep the editing caret inside the camera, the way a browser keeps the
 * caret of a focused control visible on every EDIT (typing, Enter,
 * caret travel) -- and only on edits: wheel-scrolling away from a
 * focused field stays allowed, so the render loop runs this only when
 * an edit queued it (see queueCaretReveal). The caret row comes from
 * fresh layout; single-row widgets reduce to their own row.
 */
function scrollCaretIntoView(
	termdom: TermDOM,
	element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
	DOM.flushLayout(termdom.document);
	const rect = termdom[kLayoutEngine].getRect(element);
	if (!rect) {
		return;
	}
	let caretY = Math.round(rect.top);
	const caret = caretRectFor(termdom, element);
	if (caret !== null) {
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
	const regionHeight = cameraRegionHeight(termdom);
	const top = termdom[kScreen].scrollTop;
	const delta =
		revealTop < top
			? revealTop - top
			: revealBottom > top + regionHeight
				? revealBottom - (top + regionHeight)
				: 0;
	if (delta) {
		scrollCamera(termdom, delta);
	}
}

/**
 * Resolve the journalled element scroll against this frame's layout: the
 * buffer rows its scroll port covers, or null when the terminal cannot be
 * asked to shift them.
 *
 * A band has to be the FULL WIDTH of the region, because DECSTBM margins are
 * horizontal: the terminal shifts whole rows or nothing. Everything else the
 * gate asks is about naming rows at all -- the box is still in the document,
 * layout gives it a box, and the rows it covers are inside the region. A
 * `delta` at least as tall as the band would scroll the band's whole content
 * out, which the plain repaint does for the same bytes.
 *
 * Content overlapping the band is not asked about. The terminal drags it
 * along, the shifted model says so, and the diff repairs it -- the same
 * backstop that repairs the fixed rows of a camera move.
 */
function resolveScrollBand(
	termdom: TermDOM,
	regionHeight: number,
	record: {element: Element; delta: number} | null,
): {delta: number; top: number; end: number} | null {
	if (
		record === null ||
		record.delta === 0 ||
		// The camera owns the frame it moved in: one band per frame, and the
		// region it shifts already contains this box.
		termdom[kScreen].frameScroll !== 0 ||
		// Anything the layout derives a frame from has moved, so the rows the
		// terminal would shift are not the rows the last frame painted.
		termdom[kScreen].layoutMoved ||
		!record.element.isConnected
	) {
		return null;
	}
	const engine = termdom[kLayoutEngine];
	const rect = engine.getRect(record.element);
	if (rect === null) {
		return null;
	}

	// The scroll port is the PADDING box: what the port clips its content to,
	// and so the rows whose content rides the scroll.
	const box = getBoxModel(record.element);
	const left = rect.left + (box.borderLeftWidth || 0);
	const right = rect.left + rect.width - (box.borderRightWidth || 0);
	if (left > 0 || right < termdom[kScreen].cols) {
		return null;
	}

	// Layout rows are document rows -- the geometry funnel has already taken
	// off what a scrolled ancestor lifts the box by -- and the buffer's are
	// the camera's. A box in fixed space is laid out in viewport rows
	// instead, and the paint cancels the camera for it.
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
 * Run the observers against the layout just produced.
 *
 * Called after every render, once isRendering is clear -- a callback that
 * mutates the DOM schedules the next frame through the mutation observer, so
 * there is no re-entrancy to guard against here.
 */
function afterRender(
	termdom: TermDOM,
): void {
	termdom[kRenderCount]++;
	// The viewport in document coordinates: the scroll offset, one terminal
	// high. IntersectionObserver measures targets against it.
	const viewport = new termdom.window.DOMRect(
		0,
		termdom[kScreen].scrollTop,
		termdom[kScreen].cols,
		termdom[kScreen].rows,
	);
	flushObservers(
		termdom.document,
		termdom[kLayoutEngine],
		viewport,
		termdom[kRenderCount],
	);
	// The frame's stylesheets have parsed, so "does any rule test :hover"
	// is current, and the wheel may have been handed to the terminal or
	// taken back: re-answer what the terminal should report.
	updateMouseReporting(termdom);
	updateHoverReporting(termdom);
}

/**
 * Render the whole document once, as plain lines, for a non-terminal stdout.
 *
 * There is no fold here, so there is nothing to commit, freeze or repair: the
 * document is simply printed. Every hard problem in this file is a consequence
 * of having a viewport, and a pipe does not have one.
 */
async function printStatic(
	termdom: TermDOM,
): Promise<void> {
	DOM.applyMutations(termdom.document);

	termdom[kLayoutEngine].calculateLayout();

	const context = termdom[kScreen].beginStatic({
		rows: termdom[kLayoutEngine].documentPaintHeight(),
	});
	termdom[kPainter].paint(context);
	const output = termdom[kScreen].endFrame();

	if (output) {
		await termdom[kExchange].write(output);
	}
	afterRender(termdom);
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

	// Back to the top of our region; every payout line then clears ITSELF
	// (an EL before its text) and one partial erase covers whatever the
	// old frame held below. Never a full ED from the top row: tmux
	// preserves a fully-erased screen by pushing it into scrollback (the
	// courtesy it extends to `clear`), which archived a copy of the final
	// frame above the payout -- the document twice, interleaved.
	void termdom[kExchange].cursorToRow(top + 1);
	void termdom[kExchange].writeLines(output);
	void termdom[kExchange].eraseBelow();
}

/**
 * The document as an ANSI string: colors and line breaks, no cursor
 * controls, no modes. Feeds the quit payout (CRLF: raw mode does not
 * translate bare newlines) and the scratch sibling behind renderANSI();
 * not part of the class's public surface.
 */
function renderStatic(
	termdom: TermDOM,
	lineEnding: "\n" | "\r\n",
): string {
	DOM.flushLayout(termdom.document);
	const contentHeight = termdom[kLayoutEngine].documentPaintHeight();
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
	termdom: TermDOM,
): Promise<void> {
	// The previous document was sealed to scrollback by close(). Start a fresh
	// one below it: re-anchor to where the cursor now sits and reset the diff so
	// nothing composites over the frozen block.
	if (termdom[kSealed]) {
		termdom[kSealed] = false;
		termdom[kScreen].scrollTo(0);
		termdom[kScreen].repaintAll();
		// detectCommandStart waits for a reply on stdin, so the listener must
		// be attached first (idempotent -- normally already done by now).
		if (termdom[kTransport].interactive) {
			termdom.attach();
			await termdom[kExchange].detectCommandStart();
		}
	}

	// Our region starts at the command-start row, which cursor detection resolves
	// asynchronously. Render before it lands and the first frame anchors at row 0
	// while every diff after detection anchors one row lower -- the labels stay,
	// the values slide down a row. Wait for the anchor to settle first, exactly
	// as the flow path does. Await only when one is pending: an unconditional
	// await would defer the rest of this frame a microtask even with nothing
	// to wait for, and a downstream synchronous scroll clamp depends on it.
	const detectionPending = termdom[kExchange].cursorDetectionPending;
	if (detectionPending) {
		await detectionPending;
	}

	// The screen under this frame must match the document's fullscreen
	// state before anything composes: the switch is written here, at the
	// head of a frame, so no frame can straddle it -- the previous frame's
	// bytes are already on the wire, and this frame paints the screen it
	// just took. Entry is switch, hide, clear: a cursor the entry left
	// visible would sit blinking on the screen it just took, and a frame's
	// own hide arrives no earlier than the frame does.
	const wantAlt = isFullscreen(termdom);
	if (wantAlt !== termdom[kOnAltScreen]) {
		termdom[kOnAltScreen] = wantAlt;
		termdom[kExchange].setMode("altScreen", wantAlt);
		if (wantAlt) {
			termdom[kExchange].engageMode("cursorHidden");
			void termdom[kExchange].clearScreen();
		}
		// The screen changed wholesale: drop the diff model, or this frame
		// patches one screen against the other's content.
		termdom[kScreen].repaintAll();
		updateMouseReporting(termdom);
	}

	// Coalesced pointer motion resolves first: a hover listener's
	// synchronous mutations join the records taken below, and the hover
	// chain's invalidation precedes this frame's style resolution.
	termdom[kEventHandler].resolvePendingHover();

	DOM.applyMutations(termdom.document);

	termdom[kLayoutEngine].calculateLayout();
	DOM.clampScrollOffsets(termdom.document);

	// The caret reveal an edit queued runs here, against the layout this
	// frame just flushed -- one camera decision per frame, however many
	// keystrokes coalesced into it. Skipped if focus has already moved
	// on: revealing a field the user left would yank the camera back.
	if (termdom[kPendingCaretReveal]) {
		const reveal = termdom[kPendingCaretReveal];
		termdom[kPendingCaretReveal] = null;
		if (reveal === termdom.document.activeElement) {
			scrollCaretIntoView(termdom, reveal);
		}
	}

	// The journal is empty and the camera stands where it painted: nothing
	// this frame could paint differs from what the screen already shows.
	// Don't pay to discover that.
	const journalled = DOM.takeScrollBand(termdom.document) as {
		element: Element;
		delta: number;
	} | null;
	if (
		!termdom[kScreen].dirty &&
		!termdom[kScreen].layoutMoved &&
		termdom[kScreen].frameScroll === 0 &&
		journalled === null &&
		!termdom[kScreen].needsRepaint
	) {
		// Skip the paint, not the frame: observers still run, so a fresh
		// observe() gets its initial entry on the next tick.
		afterRender(termdom);
		return;
	}

	// Recompute the focused input's scroll window every frame (derived state).
	DOM.revealFieldCaret(termdom.document);

	// Fullscreen owns the WHOLE alternate screen from row zero: the
	// main screen's command anchor means nothing there, and reserveRows'
	// index-scrolls would scroll the alternate screen itself. The
	// document's scroll position survives untouched underneath -- the
	// fixed, Canvas-backed fullscreen element covers it regardless.
	const fullscreen = isFullscreen(termdom);
	const contentHeight = fullscreen
		? termdom[kScreen].rows
		: termdom[kLayoutEngine].documentPaintHeight();
	const regionHeight = Math.min(
		contentHeight,
		termdom[kScreen].rows,
	);

	// Take the room we need by pushing earlier output up, never over it.
	const top = fullscreen ? 0 : reserveRows(termdom, regionHeight);

	if (!fullscreen) {
		// The camera cannot run off the end of the document. The clamp goes
		// through the setter, so the journal's delta is what the screen is
		// about to be shifted by -- there is no memory of where the last
		// frame painted for it to disagree with.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		termdom[kScreen].scrollTo(Math.min(termdom[kScreen].scrollTop, maxScroll));
	}

	// The camera has no alternate screen to move: fullscreen owns row zero
	// and paints the whole of it. A scroll box inside it does move, though,
	// and DECSTBM margins hold there like anywhere else -- a full-width pane
	// scrolls under fixed chrome the terminal never touches.
	const band = resolveScrollBand(termdom, regionHeight, journalled);
	const context = termdom[kScreen].beginFrame({
		offset: -termdom[kScreen].scrollTop,
		cursorRow: top,
		regionRows: top + regionHeight,
		delta: band ? band.delta : fullscreen ? 0 : termdom[kScreen].frameScroll,
		band: band ?? undefined,
	});
	termdom[kPainter].paint(context);
	const ansi = termdom[kScreen].endFrame();

	if (ansi) {
		await termdom[kExchange].write(ansi);
	}
	afterRender(termdom);
}

/**
 * Reserve `rows` rows below the command start, returning how many rows the
 * screen must scroll so they fit (0 if they already do). When there isn't
 * room the command start rides up into the shell's scrollback, and the
 * region's start moves up by that much.
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

/** Move the camera over the document. */
function scrollCamera(
	termdom: TermDOM,
	rows: number,
): void {
	termdom[kScreen].scrollTo(termdom[kScreen].scrollTop + rows);
	// A camera move is invisible to the MutationObserver; schedule the frame
	// it needs, the same way a DOM mutation would.
	void render(termdom);
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
	termdom: TermDOM,
	rows: number,
): number {
	const push = pushRowsUp(termdom, rows);
	if (push > 0) {
		void termdom[kExchange].scrollUp(termdom[kScreen].rows, push);
		// Do NOT shift the screen's previous buffer. Its rows are relative to
		// the region top, and the top moves up by exactly the amount the screen
		// scrolled -- the two cancel, so buffer coordinates are unchanged.
		// Shifting it desynced the diff by `push` rows: the model compared
		// against the wrong screen rows, skipped cells it wrongly believed
		// unchanged, and composited the old frame under the new one whenever a
		// document-mode region grew past the space below the shell prompt.
		//
		// A pending post-resize screen reset IS screen-absolute, though, and
		// must ride the scroll (see the screen's own `scrolled`).
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
