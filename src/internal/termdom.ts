/**
 * The shell: the frame loop, and the wiring that makes the other modules one
 * running program.
 *
 * It answers none of their questions itself. The document holds the tree, the
 * cascade decides style, the box tree decides geometry and the paint walk
 * decides cells; this decides when to ask, and owns the terminal the answers
 * are written to.
 */

import * as DOM from "./dom.js";
import "./inspector.js";
import {
	createDocumentWindow,
	DOMRectList,
	disconnectObservers,
	flushObservers,
	type EngineWindow,
} from "./dom.js";
import {LayoutEngine} from "./layout.js";
import {Painter} from "./painter.js";
import {
	TerminalExchange,
	type TerminalCloseInfo,
	type TerminalSize,
	type TerminalTransport,
} from "./exchange.js";
import {transportFromProcess} from "./pty.js";
import {Screen} from "./screen.js";
import {StyleManager, getComputedValues, getBoxModel} from "./cascade.js";
import {stringWidth} from "./text.js";
import {
	EventHandler,
	focusAutofocusedNodes,
	isActivationTriggering,
	type DocumentPoint,
} from "./input.js";
import {
	cursorHome,
	cursorTo,
	eraseBelow,
	eraseScreen,
	eraseToLineEnd,
	index,
} from "./wire.js";

/** The mount this engine installs, which is how a node finds it back. */
interface EngineMount extends DOM.Mount {
	readonly engine: TermDOM;
}

/** The engine an event target belongs to, if it is mounted in one. */
function engineOfTarget(target: unknown): TermDOM | undefined {
	const node = target as (Node & {document?: object}) | null;
	if (!node) {
		return undefined;
	}
	// A window carries the document it shows; a node carries its owner.
	const from = typeof node.nodeType === "number" ? node : node.document;
	if (from === undefined) {
		return undefined;
	}
	return (DOM.getMount(from) as EngineMount | undefined)?.engine;
}

/**
 * Fire an event as the user agent.
 *
 * Every event this file dispatches comes from outside the document -- decoded
 * terminal input, a terminal that resized, a focus move the engine itself
 * made -- so it is the user agent's, and reads isTrusted true. Provenance is
 * decided here, once, for all of them: an event an application constructs and
 * hands to dispatchEvent() is script's, and is never trusted.
 *
 * An activation-triggering event also holds user activation open for as long
 * as its dispatch runs, which is what the clipboard asks about.
 */
function fireAsUserAgent(
	target: object,
	event: {type: string; key?: string; inputType?: string},
): boolean {
	const engine = engineOfTarget(target);
	// A target no engine mounts is headless by definition, so the claim
	// door is open for it; a mounted target dispatches through its engine's
	// own toolkit.
	const shaped = target as {ownerDocument?: object; document?: object};
	const toolkit =
		engine !== undefined ?
			engine[kUAToolkit] :
				DOM.claimUAToolkit(shaped.ownerDocument ?? shaped.document ?? target);
	if (engine === undefined || !isActivationTriggering(event)) {
		return toolkit.dispatchAsUserAgent(target, event);
	}
	engine[kActivationDepth]++;
	engine[kEverActivated] = true;
	try {
		return toolkit.dispatchAsUserAgent(target, event);
	} finally {
		engine[kActivationDepth]--;
	}
}

/** Whether an activation-triggering event is being dispatched right now. */
function isUserActive(termdom: TermDOM): boolean {
	return termdom[kActivationDepth] > 0;
}

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

/**
 * The Fullscreen API over the terminal's alternate screen. The element stack
 * and its events are user-agent state; the screen switch itself is a session
 * mode, so a panic restore hands the main screen back. Fullscreen is on while
 * the stack holds an element -- the switch engages with the first push and
 * resets with the last pop.
 */
function isFullscreen(termdom: TermDOM): boolean {
	return termdom[kFullscreenStack].length > 0;
}

function getFullscreenElement(termdom: TermDOM): Element | null {
	const stack = termdom[kFullscreenStack];
	// Style computation consults this during construction, before the field
	// is assigned.
	return stack?.length ? stack[stack.length - 1] : null;
}

async function requestFullscreenElement(
	termdom: TermDOM,
	element: Element,
	_options?: globalThis.FullscreenOptions,
): Promise<void> {
	if (!element.isConnected) {
		const error = new Error("The element is not contained by a document.");
		error.name = "InvalidStateError";
		throw error;
	}

	try {
		termdom[kFullscreenStack].push(element);
		if (termdom[kFullscreenStack].length === 1) {
			termdom[kExchange].setMode("altScreen", true);
			// The cursor goes before the screen is touched, so it never sits
			// blinking on the clear. Frames hide it as they paint and an
			// interactive session records that before its first frame, so the
			// hide is written whatever the record says.
			termdom[kExchange].engageMode("cursorHidden");
			// The alternate screen comes up holding whatever the terminal left
			// in it, so the entry clears it and homes the cursor.
			void termdom[kExchange].write(eraseScreen() + cursorHome());
		}

		fireFullscreenChangeEvent(termdom, element);
	} catch (error) {
		termdom[kFullscreenStack].pop();
		fireFullscreenErrorEvent(termdom, element, error as Error);
		throw error;
	}
}

async function exitFullscreenElement(termdom: TermDOM): Promise<void> {
	if (termdom[kFullscreenStack].length === 0) {
		return;
	}

	const exitingElement = termdom[kFullscreenStack].pop()!;
	if (termdom[kFullscreenStack].length === 0) {
		termdom[kExchange].setMode("altScreen", false);
	}

	fireFullscreenChangeEvent(termdom, exitingElement);
}

function fireFullscreenChangeEvent(
	termdom: TermDOM,
	element: Element,
): void {
	const window = getFullscreenWindow(termdom, element);
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
	fireAsUserAgent(element, event);
}

function fireFullscreenErrorEvent(
	termdom: TermDOM,
	element: Element,
	error: Error,
): void {
	const window = getFullscreenWindow(termdom, element);
	if (!window) {
		return;
	}

	const event = new window.CustomEvent("fullscreenerror", {
		bubbles: true,
		cancelable: false,
		detail: {error},
	});

	// Fire on both element and document
	fireAsUserAgent(element, event);
	if (element.ownerDocument) {
		fireAsUserAgent(element.ownerDocument, event);
	}
}

function getFullscreenWindow(
	termdom: TermDOM,
	element?: Element,
): any {
	// Get window from the element's document, or from the stack
	const targetElement = element || termdom[kFullscreenStack][0];
	const document = targetElement ? targetElement.ownerDocument : null;
	return document ? document.defaultView : undefined;
}

/**
 * Where an instance stands with the terminal, in order: constructed and
 * writing nothing, attach() establishing the session, the session live, torn
 * down for good. Disposal is final -- there is no way back to detached.
 */
type Lifecycle = "detached" | "attaching" | "attached" | "disposed";

/**
 * Whether the terminal is ours to write to. True from the moment attach() is
 * called, not from the moment its begin phase finishes: renders raised in
 * between belong to the session and wait on kAttachBegun rather than being
 * dropped.
 */
function isAttached(termdom: TermDOM): boolean {
	const lifecycle = termdom[kLifecycle];
	return lifecycle === "attaching" || lifecycle === "attached";
}

const kScreen = Symbol("screen");
const kLayoutEngine = Symbol("layoutEngine");
const kObserver = Symbol("observer");
const kFullscreenStack = Symbol("fullscreenStack");
const kStyleManager = Symbol("styleManager");
const kPainter = Symbol("painter");

const kIsRendering = Symbol("isRendering");
const kFrameCallbacks = Symbol("frameCallbacks");
const kNextRafId = Symbol("nextRafId");

const kMediaQueryUpdaters = Symbol("mediaQueryUpdaters");
const kSealed = Symbol("sealed");
const kRenderQueued = Symbol("renderQueued");
const kScreenSwitching = Symbol("screenSwitching");
const kRenderInFlight = Symbol("renderInFlight");
const kRenderCount = Symbol("renderCount");

const kUAToolkit = Symbol("uaToolkit");
const kEventHandler = Symbol("eventHandler");

const kResizeTimer = Symbol("resizeTimer");
const kSettlingResize = Symbol("settlingResize");

const kLifecycle = Symbol("lifecycle");
const kAttachBegun = Symbol("attachBegun");
const kAttachReady = Symbol("attachReady");
const kActivationDepth = Symbol("activationDepth");
const kEverActivated = Symbol("everActivated");

const kFrameScroll = Symbol("frameScroll");
const kFrameBand = Symbol("frameBand");
const kFrameDirty = Symbol("frameDirty");
/** The engine invalidation count the last painted frame was built from. */
const kPaintedGeneration = Symbol("paintedGeneration");

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
const kViewport = Symbol("viewport");

const kScrollTop = Symbol("scrollTop");
const kScreenTop = Symbol("screenTop");
const kAnchorScrollTop = Symbol("anchorScrollTop");
const kScrolledElements = Symbol("scrolledElements");

const kMouseReportingEnabled = Symbol("mouseReportingEnabled");
const kHoverReportingEnabled = Symbol("hoverReportingEnabled");
const kMountHandle = Symbol("mountHandle");
const kPendingCaretReveal = Symbol("pendingCaretReveal");

const kTransport = Symbol("transport");
const kExchange = Symbol("exchange");
const kStaticSibling = Symbol("staticSibling");

const kOnDisclosureToggle = Symbol("onDisclosureToggle");
const kOnFieldEditEvent = Symbol("onFieldEditEvent");

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
	declare [kObserver]: MutationObserver;
	// The elements that asked for the alternate screen, innermost last.
	declare [kFullscreenStack]: Element[];
	declare [kStyleManager]: StyleManager;
	// The DOM-tree -> terminal-cells paint walk. Reads geometry/styles/widgets;
	// owns no scheduling.
	declare [kPainter]: Painter;
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

	/**
	 * The UA's capabilities, returned by the one installUAEngine handshake:
	 * open a closed shadow root, read a control's selection past the type
	 * gate. Holding this object is what makes this engine the document's
	 * user agent -- it is never re-exported and never reachable from a node.
	 */
	declare [kUAToolkit]: DOM.UAToolkit;

	// The input interpreter: decoded wire items in, DOM events out, and the
	// transient gesture state interpretation needs.
	declare [kEventHandler]: EventHandler;

	// Timers that must be torn down in dispose(), or they keep the process
	// alive after the app is done -- which, across a test suite, piles up
	// into a hang.
	declare [kResizeTimer]: ReturnType<typeof setTimeout> | null;
	// The resize being settled: a fresh object from the first SIGWINCH of a
	// resize until the re-anchored redraw, and null between resizes. While one
	// is set, render() bails: the terminal has rewrapped the screen and our
	// anchor is momentarily stale, so an auto-render (an animation tick)
	// painting now lands at the wrong rows and scrolls a stray copy into the
	// scrollback. Only the final redraw that handleResize issues is allowed
	// through. The redraw waits on an async cursor query, so it holds the
	// object it was scheduled for and drops its answer if another SIGWINCH has
	// replaced it -- the newer resize's own redraw is the one that lands.
	declare [kSettlingResize]: object | null;
	// How far we have gone in taking hold of the terminal: raw mode, signal
	// handlers, the stdin listener and the cursor query. Construction never
	// touches the process -- attach() does, lazily on the first render or
	// explicitly -- and dispose() ends the instance for good.
	declare [kLifecycle]: Lifecycle;
	/**
	 * How many activation-triggering events are being dispatched right now,
	 * and whether one ever has been. What only a user may ask for is asked of
	 * these, and nothing else writes them.
	 */
	declare [kActivationDepth]: number;
	declare [kEverActivated]: boolean;

	/**
	 * The frame journal: how far the camera moved since the last painted
	 * frame, which box scrolled under it, and whether anything else did. A
	 * frame with none of the three paints nothing a diff would keep, so it is
	 * skipped; a frame with any of them repaints the region, hands the screen
	 * the rows to shift and the band to shift them in, and resets the lot.
	 *
	 * One box's scroll is a band the terminal can move for us. A second box
	 * scrolling before the frame lands has no single band to name, so the
	 * record degrades to the dirty bit and the frame repaints.
	 */
	declare [kFrameScroll]: number;
	declare [kFrameBand]: {element: Element; delta: number} | null;
	declare [kFrameDirty]: boolean;
	declare [kPaintedGeneration]: number;

	declare [kViewport]: {width: number; height: number};

	/** How far into the document the painted region looks (window.scrollY). */
	declare [kScrollTop]: number;
	/** The terminal row the painted region starts at (the command start). */
	declare [kScreenTop]: number;
	/** The fullscreen anchor: the alternate screen's row-zero scroll origin. */
	declare [kAnchorScrollTop]: number;

	// Boxes holding a nonzero scroll offset. Layout changes can shrink a
	// box's content out from under its offset; each layout flush pulls
	// these back into range (see clampScrolledOffsets).
	declare [kScrolledElements]: Set<Element>;

	// Whether the terminal is currently reporting mouse events to us. See
	// updateMouseReporting for when capture is on.
	declare [kMouseReportingEnabled]: boolean;
	// Whether the terminal is currently reporting pointer MOTION (SGR 1003)
	// on top of button/drag reporting. See updateHoverReporting.
	declare [kHoverReportingEnabled]: boolean;
	// Reads the document's live count of hover-family listeners, half of
	// what "the document observes hover" means (the other half is a sheet
	// with a :hover rule).
	declare [kMountHandle]: DOM.MountHandle;
	// The field whose caret the NEXT frame must reveal -- set by edits,
	// consumed inside kRenderInteractive after its layout flush. Last
	// edit before the frame wins.
	declare [kPendingCaretReveal]: | HTMLInputElement |
		HTMLTextAreaElement |
		HTMLSelectElement |
		null;

	declare [kTransport]: TerminalTransport;

	// The conversation over the transport: the input demultiplexer plus the
	// cursor-position (command start, resize re-anchor) and mode-support (bidi,
	// grapheme clusters) queries whose replies arrive interleaved with typing.
	declare [kExchange]: TerminalExchange;

	// A defaulted transport over a piped stdout -- a pipe, a file, a CI log --
	// has no viewport, no cursor, no scrollback and no resize. It cannot
	// interpret cursor movement either, so the interactive frame would write
	// CUP and DECSC sequences straight into the file. An injected transport
	// asserts a terminal exists on the other end.

	constructor(options: TermDOMOptions = {}) {
		this[kScrollTop] = 0;
		this[kScreenTop] = 0;
		this[kAnchorScrollTop] = 0;
		this[kFrameScroll] = 0;
		this[kFrameBand] = null;

		this[kFrameDirty] = true;
		this[kPaintedGeneration] = -1;
		this[kIsRendering] = false;
		this[kFrameCallbacks] = new Map<number, FrameRequestCallback>();
		this[kNextRafId] = 1;
		this[kMediaQueryUpdaters] = new Set<() => void>();
		this[kSealed] = false;

		this[kRenderQueued] = false;
		this[kScreenSwitching] = false;
		this[kFullscreenStack] = [];
		this[kRenderInFlight] = null;
		this[kRenderCount] = 0;
		this[kResizeTimer] = null;
		this[kSettlingResize] = null;
		this[kLifecycle] = "detached";
		this[kActivationDepth] = 0;
		this[kEverActivated] = false;
		this[kScrolledElements] = new Set();

		this[kMouseReportingEnabled] = false;
		this[kHoverReportingEnabled] = false;
		this[kPendingCaretReveal] = null;
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
		this[kStaticSibling] = null;
		this[kTransport] = options.transport ?? transportFromProcess();

		this.window = createDocumentWindow(
			options.html ?? "<!DOCTYPE html><html><head></head><body></body></html>",
			options.url,
		);

		const document = this.window.document as unknown as DOM.Document;
		this.document = this.window.document;

		// The mount is built here, before the fields it reads exist: nothing
		// reaches through it until a DOM member is actually called.
		this[kMountHandle] = DOM.mount(document, createMount(this));

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
		adoptTerminalSize(this, this[kTransport].cols, this[kTransport].rows);

		// Initialize scrolling management after window setup

		const observer = new this.window.MutationObserver((mutations) => {
			handlePendingMutations(this, mutations);
			render(this);
		});

		observer.observe(this.document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeOldValue: true,
			characterData: true,
		});

		this[kObserver] = observer;

		// The collaborators a control's own shadow tree renders through. From
		// here a control builds and keeps its tree itself; the shell only says
		// when a newly connected one should be upgraded.
		this[kUAToolkit] = DOM.installUAEngine(this.document, {
			layout: this[kLayoutEngine],
			styles: this[kStyleManager],
			observer: this[kObserver],
			invalidateStructure: () => this[kLayoutEngine].invalidate(),
			// A popover shows and hides without touching the tree, so the
			// rules that test `:popover-open` -- the UA sheet's own display
			// among them -- are told here, and the frame that paints what
			// they reveal is asked for here.
			stateChanged: (element: object) => {
				this[kStyleManager].handleStateChange(element as Element);
				void render(this);
			},
		});

		this[kEventHandler] = buildEventHandler(this);
		this[kPainter] = new Painter({
			window: this.window,
			document: this.document,
			layout: this[kLayoutEngine],
			styleManager: this[kStyleManager],
			scrollTop: () => this[kScrollTop],
			topLayer: this[kUAToolkit].topLayer as unknown as Set<Element>,
			toolkit: this[kUAToolkit],
		});

		// The session first: the screen measures widths over the session's
		// probe channel, and takes it for its lifetime.
		this[kExchange] = buildExchange(this);
		this[kScreen] = new Screen(
			this[kViewport].height,
			this[kViewport].width,
			this[kTransport].colorDepth,
			this[kExchange].widthMeasurer,
		);

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
	// unanchored first frame. Awaited only while attaching, so steady-state
	// renders stay fully synchronous: an unconditional await would defer
	// each frame a microtask, and the scrollTop clamp is synchronous by
	// contract.
	declare [kAttachBegun]: Promise<void>;

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

			this[kExchange].start();
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
		this[kFullscreenStack] = [];
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

		// Tear down the rest of what holds the event loop open. Without this a
		// disposed TermDOM keeps the process alive via the resize timers, and
		// across a whole test suite those accumulate until nothing can exit.
		if (this[kResizeTimer] !== null) {
			clearTimeout(this[kResizeTimer]);
			this[kResizeTimer] = null;
		}
		this[kEventHandler].dispose();

		// Shadow DOM cleanup is automatic with symbol-based storage

		if (this[kStaticSibling]) {
			void this[kStaticSibling].dispose();
			this[kStaticSibling] = null;
		}
		this[kObserver].disconnect();
		this[kStyleManager].dispose();
		this[kLayoutEngine].dispose();
		disconnectObservers(this.document);
		return this[kExchange].flush();
	}
}

/**
 * The frame handle a requestAnimationFrame callback is keyed by, so a
 * cancelAnimationFrame can name the callback it cancels.
 */
function allocateFrameHandle(
	termdom: TermDOM,
): number {
	return termdom[kNextRafId]++;
}

function sealToScrollback(
	termdom: TermDOM,
): void {
	flushDocument(termdom);
	termdom[kSealed] = true;
}

/**
 * The document's Mount: the geometry half of the public DOM surface,
 * answered from this engine's layout. Reached through the document -- no
 * prototype carries engine state for these.
 */
function createMount(termDOM: TermDOM): EngineMount {
	// getBoundingClientRect/getClientRects are a *public* API, and CSSOM
	// View defines them relative to the viewport: rect.top for a
	// scrolled-past element should be negative, not the same ever-growing
	// document row regardless of scroll. getRect()/getRects() (the layout
	// engine's own primitives) are document-relative -- the renderer
	// applies the camera offset once at paint time -- so toViewportRect is
	// the one place the conversion happens, applied identically by both.
	// Internal callers that need the document-relative rect
	// (scrollIntoView, hit-testing) read getRect()/getRects() directly.
	// A box inside a position:fixed subtree is laid out in viewport space
	// already -- subtracting the camera would double-convert it. Per spec
	// its client rect is scroll-invariant.
	const toViewportRect = (rect: DOMRect, element?: Element): DOMRect =>
		element && termDOM[kLayoutEngine].isInFixedSpace(element) ?
			rect :
				new termDOM.window.DOMRect(
					rect.x,
					rect.y - termDOM[kScrollTop],
					rect.width,
					rect.height,
				);

	// The single place that decides "is this element connected, has layout
	// settled, what is its border-box rect" -- so offsetWidth and
	// clientWidth can never quietly disagree about which rect they mean.
	// Unrounded: each reader rounds for its own purpose (offsetTop rounds
	// the *difference* of two rects; rounding here first would double-round
	// and drift by a cell).
	const layoutRectOf = (element: Element): DOMRect | null => {
		if (!element.isConnected) {
			return null;
		}
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
			const position = getComputedValues(ancestor).getComputedValue("position");
			if (position && position !== "static") {
				return ancestor as HTMLElement;
			}
		}
		const body = termDOM.document.body ?? null;
		return body === element ? null : body;
	};

	// The content+padding box (border-box rect minus border widths), which
	// both clientWidth/Height and scrollWidth/Height report -- see
	// scrollSize for why scroll* falls back to client* rather than the
	// element's true unclamped content size.
	const getContentBox = (
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
		processPendingMutationsAndRender(termDOM);
		return termDOM[kLayoutEngine].scrollExtentOf(element);
	};

	// html and body scroll the document itself: their scroll offset is the
	// camera's, their scroll height the document's, and their client height
	// the terminal's. One camera, however it is reached.
	const isRoot = (element: Element): boolean =>
		element === termDOM.document.documentElement ||
		element === termDOM.document.body;

	return {
		engine: termDOM,
		boundingClientRect(target) {
			const element = target as Element;
			if (!element.isConnected) {
				return new termDOM.window.DOMRect(0, 0, 0, 0);
			}
			processPendingMutationsAndRender(termDOM);
			const rect = termDOM[kLayoutEngine].getRect(element);
			return toViewportRect(
				rect || new termDOM.window.DOMRect(),
				element,
			);
		},
		clientRects(target) {
			const element = target as Element;
			if (!element.isConnected) {
				return new DOMRectList();
			}
			processPendingMutationsAndRender(termDOM);
			const rects = termDOM[kLayoutEngine]
				.getRects(element)
				.map((rect) => toViewportRect(rect, element));
			return rectList(rects);
		},
		// Range geometry answers from the same layout the element members
		// use, viewport-converted identically. The caret and selection
		// painters read the document-relative getRangeRects() directly, the
		// way scrollIntoView reads getRect().
		rangeBoundingClientRect(target) {
			const range = target as Range;
			processPendingMutationsAndRender(termDOM);
			const container = range.startContainer;
			const anchor =
				container.nodeType === container.ELEMENT_NODE ?
						(container as Element) :
						(container.parentElement ?? undefined);
			return toViewportRect(
				unionRect(termDOM, termDOM[kLayoutEngine].getRangeRects(range)),
				anchor,
			);
		},
		rangeClientRects(target) {
			const range = target as Range;
			processPendingMutationsAndRender(termDOM);
			const container = range.startContainer;
			const anchor =
				container.nodeType === container.ELEMENT_NODE ?
						(container as Element) :
						(container.parentElement ?? undefined);
			const rects = termDOM[kLayoutEngine]
				.getRangeRects(range)
				.map((rect) => toViewportRect(rect, anchor));
			return rectList(rects);
		},
		offsetSize(target) {
			const element = target as Element;
			const rect = layoutRectOf(element);
			return {
				width: Math.round(rect?.width ?? 0),
				height: Math.round(rect?.height ?? 0),
			};
		},
		offsetPosition(target) {
			const element = target as Element;
			const rect = layoutRectOf(element);
			if (!rect) {
				return {top: 0, left: 0};
			}
			const parent = offsetParentOf(element);
			const parentRect = parent ? layoutRectOf(parent) : null;
			return {
				top: Math.round(rect.top - (parentRect?.top ?? 0)),
				left: Math.round(rect.left - (parentRect?.left ?? 0)),
			};
		},
		offsetParent(target) {
			const element = target as Element;
			return element.isConnected ? offsetParentOf(element) : null;
		},
		clientSize(target) {
			const element = target as Element;
			const box = getContentBox(element);
			return {
				width: Math.round(box?.width ?? 0),
				height: isRoot(element) ?
					termDOM[kViewport].height :
						Math.round(box?.height ?? 0),
			};
		},
		// The border widths: what clientLeft/clientTop report, being the
		// distance from the border box's edge to the padding box's.
		clientEdge(target) {
			const box = getBoxModel(target as Element);
			return {left: box.borderLeftWidth, top: box.borderTopWidth};
		},
		scrollSize(target) {
			const element = target as Element;
			const extent = scrollExtentOf(element);
			const box = getContentBox(element);
			return {
				width: extent?.width ?? Math.round(box?.width ?? 0),
				height: isRoot(element) ?
						termDOM[kLayoutEngine].getContentHeight() :
						(extent?.height ?? Math.round(box?.height ?? 0)),
			};
		},
		scrollOffset(target) {
			const element = target as Element;
			if (isRoot(element)) {
				return {left: 0, top: termDOM[kScrollTop]};
			}
			return elementScrollOffsets.get(element) ?? {left: 0, top: 0};
		},
		// A write rounds to whole cells (everything paints on the cell grid,
		// like the document camera), clamps into the scrollable range, and
		// schedules the repaint that shows it. The value lands in the
		// engine's store, which scrollOffset above and the layout's geometry
		// funnel (element.scrollTop) both read. An axis whose overflow is
		// visible is not scrollable and pins to 0; hidden scrolls
		// programmatically, as in a browser. A box whose extent the layout
		// cannot name (a field's value span, whose content is an opaque
		// measured run) stores the write unclamped -- the caret-reveal
		// machinery owns those offsets and keeps them sane.
		scrollOffsetTo(target, axis, value) {
			const element = target as Element;
			if (isRoot(element)) {
				if (axis === "top") {
					scrollDocumentTo(termDOM, Number(value));
					void render(termDOM);
				}
				return;
			}
			const numeric = Number(value);
			let next =
				Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
			if (element.isConnected) {
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
					const style = getComputedValues(element);
					const overflow =
						style.getComputedValue(
							`overflow-${axis === "top" ? "y" : "x"}`,
						) || style.getComputedValue("overflow");
					const scrollable =
						overflow === "auto" ||
						overflow === "scroll" ||
						overflow === "hidden";
					const room =
						size - Math.round(axis === "top" ? port.height : port.width);
					next = Math.min(next, scrollable ? Math.max(0, room) : 0);
				}
			}
			const previous = elementScrollOffsets.get(element)?.[axis] ?? 0;
			if (previous === next) {
				return;
			}
			writeElementScroll(element, axis, next);
			if (next !== 0) {
				termDOM[kScrolledElements].add(element);
			}
			// A scroll offset is frame state no MutationObserver sees, so
			// the frame journal is told here: without it the "nothing moved"
			// gate would skip the paint. A vertical move is a band the
			// terminal may be able to shift for us; a horizontal one is not,
			// and dirties the frame like anything else.
			if (axis === "top") {
				recordElementScroll(termDOM, element, next - previous);
			} else {
				termDOM[kFrameDirty] = true;
			}
			void render(termDOM);
		},
		elementFromPoint(_target, x, y) {
			// Per CSSOM View, x/y are viewport-relative -- convert to the
			// document-relative space hit-testing works in, the same conversion
			// getBoundingClientRect's toViewportRect makes in the other
			// direction.
			return findElementAtDocumentPoint(
				termDOM,
				x,
				y + termDOM[kScrollTop],
			);
		},
		// The stack CSSOM View asks for, approximated as the hit element and
		// its flat-tree ancestors: content that overlaps without containing
		// (an absolutely placed box over a sibling) reports only the winner's
		// chain. The divergence is declared here rather than hidden.
		elementsFromPoint(_target, x, y) {
			const stack: Element[] = [];
			let current = findElementAtDocumentPoint(
				termDOM,
				x,
				y + termDOM[kScrollTop],
			);
			while (current !== null) {
				stack.push(current);
				current = termDOM[kUAToolkit].flatParentElement<Element>(current);
			}
			return stack;
		},
		checkVisibility(target, options) {
			const element = target as Element;
			if (!element.isConnected) {
				return false;
			}
			const asked = options as globalThis.CheckVisibilityOptions | undefined;
			const styleOf = (of: Element) => termDOM.window.getComputedStyle(of);
			for (
				let ancestor: Element | null = element;
				ancestor;
				ancestor = termDOM[kUAToolkit].flatParentElement<Element>(ancestor)
			) {
				if (styleOf(ancestor).display === "none") {
					return false;
				}
			}
			if (
				(asked?.checkVisibilityCSS || asked?.visibilityProperty) &&
				styleOf(element).visibility !== "visible"
			) {
				return false;
			}
			return termDOM[kLayoutEngine].getRects(element).length > 0;
		},
		focusMoved(previousTarget, target) {
			const previous = previousTarget as Element | null;
			const element = target as Element;
			const {FocusEvent} = termDOM.window;
			// :focus rules match live, but computed styles are cached and
			// focus is not a mutation -- both moved elements must drop their
			// caches, and the repaint must happen even when no listener
			// mutates anything.
			termDOM[kStyleManager].handleFocusChange(previous, element);
			termDOM[kFrameDirty] = true;
			void render(termDOM);
			if (previous && previous !== termDOM.document.body) {
				fireAsUserAgent(
					previous,
					new FocusEvent("blur", {
						relatedTarget: element,
						bubbles: false,
					}),
				);
				fireAsUserAgent(
					previous,
					new FocusEvent("focusout", {
						relatedTarget: element,
						bubbles: true,
					}),
				);
			}
			fireAsUserAgent(
				element,
				new FocusEvent("focus", {relatedTarget: previous, bubbles: false}),
			);
			fireAsUserAgent(
				element,
				new FocusEvent("focusin", {relatedTarget: previous, bubbles: true}),
			);
		},
		selectionMoved() {
			termDOM[kFrameDirty] = true;
			void render(termDOM);
		},
		blurred(target) {
			const element = target as Element;
			const {FocusEvent} = termDOM.window;
			termDOM[kStyleManager].handleFocusChange(element);
			termDOM[kFrameDirty] = true;
			void render(termDOM);
			fireAsUserAgent(
				element,
				new FocusEvent("blur", {relatedTarget: null, bubbles: false}),
			);
			fireAsUserAgent(
				element,
				new FocusEvent("focusout", {relatedTarget: null, bubbles: true}),
			);
		},
		// Every scroll box between the element and the document reveals it
		// within its own port, innermost first -- each scroll moves the
		// element in every outer port's coordinates, so the rect is re-read
		// per level -- and the camera reveals what remains.
		scrollIntoView(target) {
			const element = target as Element;
			if (!element.isConnected) {
				return;
			}
			processPendingMutationsAndRender(termDOM);
			const engine = termDOM[kLayoutEngine];

			const revealIn = (scroller: Element): void => {
				// Document-relative rects on both sides: the element wherever
				// its current offsets put it, against the scroller's padding
				// box -- what the scroller actually shows.
				const rect = engine.getRect(element);
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

			const toolkit = termDOM[kUAToolkit];
			for (
				let ancestor = toolkit.flatParentElement<Element>(element);
				ancestor &&
				ancestor !== termDOM.document.body &&
				ancestor !== termDOM.document.documentElement;
				ancestor = toolkit.flatParentElement<Element>(ancestor)
			) {
				const style = getComputedValues(ancestor);
				const overflow = style.getComputedValue("overflow");
				const scrollable = (value: string) =>
					value === "auto" || value === "scroll" || value === "hidden";
				if (
					scrollable(style.getComputedValue("overflow-y") || overflow) ||
					scrollable(style.getComputedValue("overflow-x") || overflow)
				) {
					revealIn(ancestor);
				}
			}

			// Document-relative, not getBoundingClientRect's viewport-relative
			// -- this compares directly against the camera's scrollTop below,
			// so it needs the space getRect() already provides.
			const rect = engine.getRect(element);
			if (!rect) {
				return;
			}

			// The camera shows [scrollTop, scrollTop + region).
			// Move it the minimal amount that brings the element into it --
			// the standard block: "nearest" behavior.
			const regionHeight = cameraRegionHeight(termDOM);
			const top = termDOM[kScrollTop];
			if (rect.top < top) {
				scrollCamera(termDOM, rect.top - top);
			} else if (rect.bottom > top + regionHeight) {
				scrollCamera(termDOM, rect.bottom - (top + regionHeight));
			}
		},
		// The document-rooted MutationObserver never sees inside a shadow
		// root -- per spec, shadow trees are separate observation scopes.
		// Each author-attached root gets enrolled in the same observer, so
		// shadow mutations invalidate styles/layout and repaint like light
		// ones.
		shadowAttached(hostTarget, rootTarget) {
			const host = hostTarget as Element;
			const root = rootTarget as ShadowRoot;
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
			// mutation record, so no box enumeration still stands.
			termDOM[kLayoutEngine].invalidate();
			termDOM[kStyleManager].registerShadowRoot(root);
			// attachShadow is not a DOM mutation -- no observer record will
			// ever fire for it -- but on a CONNECTED host the composed tree
			// just changed wholesale: light children stop rendering the moment
			// the root exists, even while it is still empty. Rebuild the
			// host's composed subtree and repaint.
			if (host.isConnected) {
				termDOM[kLayoutEngine].invalidate(host);
				void render(termDOM);
			}
		},
		requestFullscreen(target, options) {
			const element = target as Element;
			// Fullscreen writes the alternate-screen switch; attach() is the
			// only consent for that. A browser rejects without a user gesture,
			// and this is the terminal's equivalent precondition.
			if (!isAttached(termDOM)) {
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
					await requestFullscreenElement(
						termDOM,
						element,
						options as FullscreenOptions | undefined,
					);
					// The element's UA styles changed (it now fills the
					// viewport) and neither a mutation nor a focus move fired.
					termDOM[kStyleManager].handleFocusChange(element);
					termDOM[kLayoutEngine].invalidate(element);
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
		},
		exitFullscreen() {
			return (async () => {
				const element = getFullscreenElement(termDOM);
				termDOM[kScreenSwitching] = true;
				try {
					await termDOM[kRenderInFlight];
					await exitFullscreenElement(termDOM);
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
		},
		fullscreenElement() {
			return getFullscreenElement(termDOM);
		},
		// The terminal is the window and the screen both, so the inner and
		// outer pairs are one size, and the root elements report the height
		// as the height of what they scroll in.
		viewportSize() {
			return {...termDOM[kViewport]};
		},
		screenTop() {
			return termDOM[kScreenTop];
		},
		// A terminal document never scrolls sideways, so the camera's X is 0.
		documentScrollOffset() {
			return {left: 0, top: termDOM[kScrollTop]};
		},
		scrollDocumentTo(top) {
			scrollDocumentTo(termDOM, top);
			void render(termDOM);
		},
		scrollDocumentBy(top) {
			scrollCamera(termDOM, top);
		},
		// A frame callback fires after the render it scheduled has been
		// painted: a bare timer would be decoupled from the (async) paint,
		// so a callback could fire before the frame is written.
		requestFrame(callback) {
			const id = allocateFrameHandle(termDOM);
			termDOM[kFrameCallbacks].set(id, callback as FrameRequestCallback);
			void render(termDOM);
			return id;
		},
		cancelFrame(handle) {
			termDOM[kFrameCallbacks].delete(handle);
		},
		mediaMatches(query) {
			return termDOM[kStyleManager].mediaQueryMatches(query);
		},
		watchMedia(update) {
			termDOM[kMediaQueryUpdaters].add(update);
		},
		closeRequested() {
			const wasAttached = isAttached(termDOM);
			// An immediate close must not tear down mid-establishment: wait
			// for attach to finish (anchor found, first frame painted) so the
			// payout lands where the frame was, not at a stale row 0. Then
			// everything dispose queued must reach the wire before the
			// transport acts on the close (a process transport exits).
			void (async () => {
				if (wasAttached) {
					await termDOM[kAttachReady];
					// The last frames' DSR queries -- width probes above all
					// -- have replies on the wire. Consume them while the
					// session still reads, or they are typed into the shell
					// that inherits the tty.
					await termDOM[kExchange].drainQueries(200);
				}
				await termDOM.dispose();
				if (wasAttached) {
					termDOM[kTransport].close({status: 0});
				}
			})();
		},
		// document.title sets the terminal's window title in-band (OSC 2).
		// attach() pushes the previous title; dispose() pops it.
		titleChanged(title) {
			if (isAttached(termDOM) && termDOM[kTransport].interactive) {
				void termDOM[kExchange].setTitle(title);
			}
		},
		// Closing the document flushes the live region into the terminal's
		// scrollback and seals it -- the SSR res.end() of the terminal. This
		// is the "print rich output and stop" seam: write(), then close().
		//
		// dispose() has already set attached=false by the time it reaches
		// here, so the seal is skipped. A real seal is a close() from a live,
		// painted session.
		documentClosed() {
			if (isAttached(termDOM) && termDOM[kRenderCount] > 0) {
				sealToScrollback(termDOM);
			}
		},
		// A hover listener appearing or vanishing moves the "does anything
		// observe hover" answer between frames, so it pokes the mode update
		// directly; the stylesheet half is re-read after each frame instead,
		// where the sheets have already parsed.
		hoverListenersChanged() {
			updateHoverReporting(termDOM);
		},
		// The clipboard travels over OSC 52, so it is reachable while a
		// terminal is attached and taking input, and not otherwise.
		clipboardTerminal() {
			return isAttached(termDOM) && termDOM[kTransport].interactive ?
				termDOM[kExchange] :
				null;
		},
		userActive() {
			return isUserActive(termDOM);
		},
		everActivated() {
			return termDOM[kEverActivated];
		},
	};
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
	termdom: TermDOM,
	mutations: MutationRecord[],
): void {
	// Any observed mutation can move a node in the flat tree; drop the
	// memoized composition links before anything reads through them.
	termdom[kLayoutEngine].invalidateFrame();
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
			termdom[kUAToolkit].upgradeWidgetsIn(added as Element);
		}
	}
	termdom[kStyleManager].handleMutations(relevant);
	termdom[kLayoutEngine].handleMutations(relevant);
	focusAutofocusedNodes(relevant);
	dropUnfocusableFocus(termdom);
}

/**
 * The focus fixup: a mutation that made the focused element unfocusable --
 * an inert ancestor appearing above it, a move into an inert parent, a
 * display:none anywhere on its flat chain -- unfocuses it, blur events
 * and restyle included.
 */
function dropUnfocusableFocus(termdom: TermDOM): void {
	let active = termdom.document.activeElement;
	while (active !== null) {
		const shadow = termdom[kUAToolkit].getShadowRoot<ShadowRoot>(active);
		const inner = shadow?.activeElement ?? null;
		if (inner === null) {
			break;
		}
		active = inner;
	}
	if (active === null || active === termdom.document.body) {
		return;
	}
	for (
		let node: Element | null = active;
		node !== null;
		node = termdom[kUAToolkit].flatParentElement<Element>(node)
	) {
		if (
			node.hasAttribute("inert") ||
			getComputedValues(node).getComputedValue("display") === "none"
		) {
			(active as HTMLElement).blur();
			return;
		}
	}
}

/** A DOMRectList of this window's, holding the rects given. */
function rectList(
	rects: readonly globalThis.DOMRect[],
): globalThis.DOMRectList {
	const list = new DOMRectList();
	list.push(...rects);
	return list;
}

/**
 * The smallest rect enclosing a set of fragments -- the bounding box a broken
 * inline reports for itself, and the one a Range reports over the runs it
 * covers. An empty set encloses nothing and gives a zero rect at the origin,
 * which is what both public APIs answer for no geometry.
 */
function unionRect(
	termdom: TermDOM,
	rects: readonly globalThis.DOMRect[],
): globalThis.DOMRect {
	if (rects.length === 0) {
		return new termdom.window.DOMRect();
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
	return new termdom.window.DOMRect(left, top, right - left, bottom - top);
}

/**
 * The input interpreter, wired to this instance. Its collaborators are split
 * by owner: what it dispatches into, what it asks about a point, and the
 * user-agent defaults that move the camera or the wire and so stay here.
 */
function buildEventHandler(termdom: TermDOM): EventHandler {
	return new EventHandler({
		view: {
			get document(): Document {
				return termdom.document;
			},
			get window(): EngineWindow {
				return termdom.window;
			},
			fireAsUserAgent: (target, event) => fireAsUserAgent(target, event),
			requestRender: () => {
				void render(termdom);
			},
		},
		hitTest: {
			// A row above the painted region is not part of the document -- a
			// shell prompt above the command start. In fullscreen the alternate
			// screen owns row zero, so the anchor supplies the origin directly.
			documentPointAt: (col, row): DocumentPoint => {
				const documentRow =
					isFullscreen(termdom) ?
						row - 1 + termdom[kAnchorScrollTop] :
						row - 1 - termdom[kScreenTop] + termdom[kScrollTop];
				const inDocument = documentRow >= 0;
				return {x: col - 1, y: inDocument ? documentRow : 0, inDocument};
			},
			elementAt: (x, y) => findElementAtDocumentPoint(termdom, x, y),
		},
		defaults: {
			scrollByWheel: (target, deltaY) => {
				// The innermost scroll box under the pointer that can still move
				// in the wheel's direction consumes the tick; an exhausted one
				// chains outward -- ultimately to the camera and the terminal's
				// own scrollback below, the browser's scroll chaining.
				const scroller = wheelScrollerFor(termdom, target, deltaY);
				if (scroller) {
					scroller.scrollTop += deltaY;
					return false;
				}
				if (
					deltaY < 0 &&
					termdom[kScrollTop] === 0 &&
					!isFullscreen(termdom)
				) {
					return true;
				}
				scrollCamera(termdom, deltaY);
				return false;
			},
			mouseCaptureChanged: () => {
				updateMouseReporting(termdom);
			},
			hoverMoved: (target) => {
				termdom[kMountHandle].hoveredElement(target);
			},
			modalScope: () => topmostModalDialog(termdom),
			closeRequestTarget: () => topmostCloseRequestTarget(termdom),
			fullscreenTarget: () => getFullscreenElement(termdom),
		},
		toolkit: termdom[kUAToolkit],
		styleManager: termdom[kStyleManager],
		layout: termdom[kLayoutEngine],
	});
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
		interactive: termdom[kTransport].interactive,
		anchorDetection: termdom[kTransport].sharesScreen,
		handlers: {
			// Input dirties the journal wholesale. Reactive pseudo-state
			// (:focus, :hover, :active) and the document selection move
			// without a mutation record, and no cheaper answer than the paint
			// exists. A keystroke that changes nothing costs one culled paint
			// and an empty diff, which is what it is worth.
			onKeys: (keyInput) => {
				termdom[kFrameDirty] = true;
				termdom[kEventHandler].handleKeys(keyInput);
			},
			onMouse: (button, x, y, release) => {
				termdom[kFrameDirty] = true;
				termdom[kEventHandler].handleMouseReport(button, x, y, release);
			},
			onPaste: (text) => {
				termdom[kFrameDirty] = true;
				termdom[kEventHandler].handlePaste(text);
			},
			onResize: () => {
				scheduleResize(termdom);
			},
			// Ctrl-C's default action is the DOM's own way out: close the
			// window. An app that wants different behavior handles the
			// keydown; this is what happens when nobody does.
			onCloseRequest: () => {
				termdom.window.close();
			},
			onCommandStart: (screenTop) => {
				termdom[kScreenTop] = screenTop;
				// Content shifts up to the terminal top from the command start.
				termdom[kAnchorScrollTop] = -screenTop;
			},
			onTerminalReordersText: () => {
				termdom[kLayoutEngine].setTerminalReordersText(true);
			},
			// A cluster is wider or narrower on this terminal than the
			// tables said, so every column after one on a painted row is
			// off by the difference. The previous frame described a screen
			// that was never drawn: drop it and paint the region again from
			// the corrected measurements.
			onWidthCorrection: () => {
				termdom[kLayoutEngine].invalidateTextMeasurement();
				termdom[kScreen].repaintAll();
				void render(termdom);
			},
			onWidthStarvation: () => {
				termdom[kScreen].rideProbeTrain();
				void render(termdom);
			},
			// The terminal went away (hangup, disconnect, process exit):
			// clean up this side. The transport is already closing; there
			// is nothing to close back.
			onClosed: () => {
				termdom.dispose();
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
	termdom: TermDOM,
	transport: TerminalTransport,
): void {
	termdom[kTransport] = transport;
	applyTerminalSize(termdom, transport.cols, transport.rows);
	termdom[kExchange] = buildExchange(termdom);
	termdom[kScreen] = new Screen(
		termdom[kViewport].height,
		termdom[kViewport].width,
		transport.colorDepth,
		termdom[kExchange].widthMeasurer,
	);
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
	termdom[kViewport] = {width, height};
	termdom[kLayoutEngine].resize(width, height);
}

/**
 * Adopt a new terminal size: update the reported dimensions, re-parse the
 * stylesheets and re-evaluate media queries against them (a viewport change
 * can flip any @media answer), and resize the layout. The renderer is left
 * to the caller -- a resize resizes it in place, a rebind replaces it.
 */
function applyTerminalSize(
	termdom: TermDOM,
	newWidth: number,
	newHeight: number,
): void {
	// A SIGWINCH reporting an unchanged size still redraws but fires no
	// resize event, so the comparison is against the size the document holds,
	// not the one the transport is reporting.
	const viewport = termdom[kViewport];
	const sizeChanged =
		newWidth !== viewport.width || newHeight !== viewport.height;

	// Before any style is resolved: `vw` and `@media` are answered from here
	// through the window, and the layout engine is handed the same size to
	// lay the viewport root out at.
	adoptTerminalSize(termdom, newWidth, newHeight);

	// The viewport changed, so every @media answer may have: re-parse the
	// stylesheets against the new size (they were parsed against the old one
	// and would stay stale), then let each live MediaQueryList re-evaluate
	// and fire "change" if it flipped. The re-parse also drops what the style
	// manager still resolves for, which retires the viewport-relative values
	// every computed style resolved under the old size.
	termdom[kStyleManager].refreshStylesheets();

	// Per the rendering steps, resize fires before media query "change"
	// events, and everything a listener reads already has the new size.
	if (sizeChanged) {
		fireAsUserAgent(termdom.window, new termdom.window.Event("resize"));
	}
	for (const update of termdom[kMediaQueryUpdaters]) {
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
		termdom[kMountHandle].hoverListenerCount() > 0 ||
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

async function render(
	termdom: TermDOM,
): Promise<void> {
	// attach() is the ONLY door to the terminal: until the app calls it,
	// mutations keep the DOM and layout live but write nothing. Rendering
	// resumes -- starting with whatever the document holds by then -- the
	// moment attach() runs, which ends by scheduling this render.
	if (!isAttached(termdom)) {
		return;
	}

	// A resize is settling: suppress every render until handleResize issues the
	// single re-anchored redraw. See settlingResize.
	if (termdom[kSettlingResize] !== null) {
		return;
	}

	// A screen switch (fullscreen enter/exit) is in progress: no frame
	// may straddle it -- a frame computed for one screen landing on the
	// other paints the wrong geometry onto the wrong buffer.
	if (termdom[kScreenSwitching]) {
		return;
	}

	// A render in flight: coalesce, don't drop. Dropping an auto-render (a
	// mutation observer firing mid-frame) leaves the diff renderer's
	// previous-buffer out of step with the screen, which shows up as rows drawn
	// at the wrong place. Instead mark one pending and hand back the running
	// loop's promise: it will fold this caller's changes into a trailing frame,
	// so awaiting render() always means "the caller's changes are painted".
	if (termdom[kIsRendering]) {
		termdom[kRenderQueued] = true;
		return termdom[kRenderInFlight] ?? Promise.resolve();
	}

	termdom[kIsRendering] = true;
	termdom[kRenderInFlight] = (async () => {
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
				drainFrameCallbacks(termdom);
			} while (
				termdom[kRenderQueued] ||
				termdom[kFrameCallbacks].size > 0
			);
		} finally {
			termdom[kIsRendering] = false;
			termdom[kRenderInFlight] = null;
		}
	})();
	return termdom[kRenderInFlight];
}

function drainFrameCallbacks(termdom: TermDOM): void {
	if (termdom[kFrameCallbacks].size === 0) {
		return;
	}
	const callbacks = [...termdom[kFrameCallbacks].values()];
	termdom[kFrameCallbacks].clear();
	const now = performance.now();
	for (const cb of callbacks) {
		cb(now);
	}
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
 * The paint height of the document: the root box's laid-out height,
 * extended to cover top-layer boxes -- hoisted under the root, they
 * contribute nothing to the flow's height, and a picker opening at the
 * bottom edge must still get rows to paint into.
 *
 * The root, not body's scroll height: an inline body is a run member
 * whose block children are hoisted out and laid out beside it, so its own
 * box measures one line however many rows they paint. The root box holds
 * those hoisted boxes and reports the rows the flow occupies.
 */
function documentPaintHeight(
	termdom: TermDOM,
): number {
	let height = documentFlowHeight(termdom);
	const rendered =
		termdom[kUAToolkit].renderedTopLayer() as unknown as Element[];
	for (const element of rendered) {
		// A modal's ::backdrop paints the whole viewport, so the frame
		// emits that many rows whatever the dialog's own box says. The
		// reserve must match what the emitter writes: reserving less
		// lets the frame's last rows push the terminal past its bottom,
		// a physical scroll no bookkeeping records -- and from then on
		// the anchor lies by that many rows.
		if (termdom[kUAToolkit].isModalDialog(element)) {
			return termdom[kViewport].height;
		}
		const rect = termdom[kLayoutEngine].getRect(element);
		if (rect) {
			height = Math.max(height, Math.ceil(rect.bottom));
		}
	}
	return height;
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
	return isFullscreen(termdom) ?
		termdom[kViewport].height :
			Math.min(
				termdom[kViewport].height,
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
	termdom[kFrameDirty] = true;
}

/**
 * The focus of a control's selection record, or null for an element with
 * no record: the caret, in the value text's own offsets.
 */
function getSelectionFocus(termdom: TermDOM, element: Element): number | null {
	const record = termdom[kUAToolkit].selectionOf(element);
	if (record === null) {
		return null;
	}
	return record.direction === "backward" ? record.start : record.end;
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
	const focus = getSelectionFocus(termdom, element);
	if (focus === null) {
		return null;
	}
	const node = termdom[kUAToolkit].valueTextOf(element);
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
	processPendingMutationsAndRender(termdom);
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
	const top = termdom[kScrollTop];
	const delta =
		revealTop < top ?
			revealTop - top :
			revealBottom > top + regionHeight ?
				revealBottom - (top + regionHeight) :
				0;
	if (delta) {
		scrollCamera(termdom, delta);
	}
}

/**
 * Keep a single-line input's caret in its box by setting the value part's
 * scrollLeft (the layout reads it live, no relayout). Measured in cells.
 */
function scrollFieldCaretIntoView(
	termdom: TermDOM,
	input: HTMLInputElement,
): void {
	const valueText = termdom[kUAToolkit].valueTextOf(input);
	const valueSpan = valueText?.parentElement as HTMLElement | null;
	if (!valueText || !valueSpan) {
		return;
	}
	const content = termdom[kLayoutEngine].contentRect(input);
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
	const cursor = getSelectionFocus(termdom, input);
	if (cursor === null) {
		return;
	}
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
	termdom: TermDOM,
): boolean {
	// A geometry read (getBoundingClientRect, elementFromPoint) needs fresh
	// *layout*, not fresh pixels. A full render() here would make every
	// rect read with pending mutations paint a frame -- an app calling
	// scrollIntoView on each keystroke pays two paints per key, and the
	// rect could still be stale unless the render were awaited. Flushing
	// mutations and laying out synchronously gives an exact rect; painting
	// stays with the caller's own render. The dirty-skip makes this free when
	// nothing changed.
	const pendingMutations = termdom[kObserver].takeRecords();
	const hadMutations = pendingMutations.length > 0;
	if (hadMutations) {
		handlePendingMutations(termdom, pendingMutations);
		// takeRecords() stole these from the observer callback that would
		// have painted them. When the caller's own follow-up (a camera
		// move, an input's render) never comes -- scrollIntoView on an
		// already-visible row is the canonical case -- the mutation would
		// otherwise never reach the screen. Schedule the paint the drain
		// consumed, UNCONDITIONALLY: render() itself queues a trailing
		// frame when one is in flight, and skipping "because a render is
		// running" leaves the screen one interaction behind the DOM when
		// keystrokes arrive faster than frames.
		void render(termdom);
	}
	termdom[kLayoutEngine].calculateLayout();
	clampScrolledOffsets(termdom);
	return hadMutations;
}

/**
 * The engine's element scroll offsets, in cells: what the mount's
 * scrollOffset answers with and what its scrollOffsetTo clamps and writes.
 * A box nothing scrolled is absent and reads zero.
 */
const elementScrollOffsets = new WeakMap<
	Element,
	{left: number; top: number}
>();

function writeElementScroll(
	element: Element,
	axis: "left" | "top",
	value: number,
): void {
	let offsets = elementScrollOffsets.get(element);
	if (offsets === undefined) {
		offsets = {left: 0, top: 0};
		elementScrollOffsets.set(element, offsets);
	}
	offsets[axis] = value;
}

/**
 * Journal a box's vertical scroll: the rows it moved, against the box that
 * moved them. Repeats on one box add up, since the frame shifts once by
 * whatever the burst came to. A second box arriving means no single band
 * describes the frame, so the record gives way to the dirty bit and the
 * frame repaints its region as it did before.
 */
function recordElementScroll(
	termdom: TermDOM,
	element: Element,
	delta: number,
): void {
	const band = termdom[kFrameBand];
	if (band === null) {
		termdom[kFrameBand] = {element, delta};
	} else if (band.element === element) {
		band.delta += delta;
	} else {
		termdom[kFrameBand] = null;
		termdom[kFrameDirty] = true;
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
): {delta: number; top: number; end: number} | null {
	const record = termdom[kFrameBand];
	if (
		record === null ||
		record.delta === 0 ||
		// The camera owns the frame it moved in: one band per frame, and the
		// region it shifts already contains this box.
		termdom[kFrameScroll] !== 0 ||
		// Anything the layout derives a frame from has moved, so the rows the
		// terminal would shift are not the rows the last frame painted.
		termdom[kLayoutEngine].invalidations !== termdom[kPaintedGeneration] ||
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
	if (left > 0 || right < termdom[kViewport].width) {
		return null;
	}

	// Layout rows are document rows -- the geometry funnel has already taken
	// off what a scrolled ancestor lifts the box by -- and the buffer's are
	// the camera's. A box in fixed space is laid out in viewport rows
	// instead, and the paint cancels the camera for it.
	const lift = engine.isInFixedSpace(record.element) ? 0 : termdom[kScrollTop];
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
 * Pull every held scroll offset back into its box's scrollable range
 * against fresh layout: a mutation that shrinks a box's content must not
 * leave the box scrolled past what remains. Offsets are written to the
 * store directly -- the accessor's own clamp would re-enter this flush --
 * and a change repaints the box's rows like any other scroll.
 */
function clampScrolledOffsets(
	termdom: TermDOM,
): void {
	let changed = false;
	for (const element of termdom[kScrolledElements]) {
		const offsets = elementScrollOffsets.get(element) ?? {left: 0, top: 0};
		if (offsets.left === 0 && offsets.top === 0) {
			termdom[kScrolledElements].delete(element);
			continue;
		}
		if (!element.isConnected) {
			continue;
		}
		const engine = termdom[kLayoutEngine];
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
		writeElementScroll(element, "left", Math.min(offsets.left, maxLeft));
		writeElementScroll(element, "top", Math.min(offsets.top, maxTop));
		changed = true;
	}
	if (changed) {
		// See scrollOffsetTo: offsets are frame state no observer sees. A
		// clamp is not a band -- it moves offsets the journal already priced,
		// and can move several boxes at once -- so it takes the dirty bit and
		// drops whatever band was standing.
		termdom[kFrameBand] = null;
		termdom[kFrameDirty] = true;
		void render(termdom);
	}
}

const RESIZE_DEBOUNCE_MS = 40;

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
	termdom: TermDOM,
): void {
	// Suppress renders from the very first SIGWINCH, before the debounce
	// settles, so a drag's worth of animation ticks cannot paint at the stale
	// anchor while the terminal is rewrapping under us.
	termdom[kSettlingResize] = {};
	if (termdom[kResizeTimer] !== null) {
		clearTimeout(termdom[kResizeTimer]);
	}
	termdom[kResizeTimer] = setTimeout(() => {
		termdom[kResizeTimer] = null;
		handleResize(termdom);
	}, RESIZE_DEBOUNCE_MS);
}

function handleResize(
	termdom: TermDOM,
): void {
	const newWidth = termdom[kTransport].cols;
	const newHeight = termdom[kTransport].rows;

	applyTerminalSize(termdom, newWidth, newHeight);
	termdom[kScreen].resize(newHeight, newWidth);

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
	// The settling resize has suppressed every animation tick since the first
	// SIGWINCH, so nothing paints at a stale anchor while the query is in
	// flight. If the terminal does not answer, fall back to the computed
	// vertical re-anchor (exact for height changes, approximate for width).
	termdom[kLayoutEngine].calculateLayout();
	const contentHeight = documentPaintHeight(termdom);
	const wrappedRowsAbove = termdom[kScreen].wrappedRowsAbovePark(newWidth);
	const settling = termdom[kSettlingResize];

	const redraw = (startRow: number) => {
		// The recovered row is where the frame stands; whether it still
		// FITS below that row at the new height is reserveRows' problem,
		// which solves it the only permissible way -- scrolling earlier
		// output up into the scrollback, never painting over it. Clamping
		// startRow upward to force a fit instead would plant the frame on
		// top of the shell prompt above it.
		termdom[kScreenTop] = startRow;
		termdom[kAnchorScrollTop] = -startRow;
		termdom[kScreen].replaced(startRow);

		// Everything suppressed since the first SIGWINCH may paint again. The
		// frame is placed by the screen reset, not by cursor detection.
		termdom[kSettlingResize] = null;
		const wasDetected = termdom[kExchange].hasDetectedCommandStart;
		termdom[kExchange].hasDetectedCommandStart = false;
		render(termdom).then(() => {
			termdom[kExchange].hasDetectedCommandStart = wasDetected;
		});
	};

	const computedReanchor = () => {
		const previousStart = termdom[kScreenTop];
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

	if (termdom[kExchange].anchorDetectionEnabled && wrappedRowsAbove !== null) {
		termdom[kExchange]
			.queryCursorRow()
			.then((cursorRow) => {
				// A newer resize superseded this one; its handler will redraw.
				if (settling !== termdom[kSettlingResize]) {
					return;
				}
				place(Math.max(0, cursorRow - wrappedRowsAbove));
			})
			.catch(() => {
				if (settling !== termdom[kSettlingResize]) {
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
	termdom: TermDOM,
): void {
	termdom[kRenderCount]++;
	// The viewport in document coordinates: the scroll offset, one terminal
	// high. IntersectionObserver measures targets against it.
	const viewport = new termdom.window.DOMRect(
		0,
		termdom[kScrollTop],
		termdom[kViewport].width,
		termdom[kViewport].height,
	);
	flushObservers(
		termdom.document,
		termdom[kLayoutEngine],
		viewport,
		termdom[kRenderCount],
	);
	// The frame's stylesheets have parsed, so "does any rule test :hover"
	// is current: re-answer whether the terminal should report motion.
	updateHoverReporting(termdom);
}

/**
 * The modal dialog on top of the document, or null while none is showing.
 * Last in the top layer is topmost, and only a modal dialog is ever in it
 * by way of `showModal`.
 */
function topmostModalDialog(
	termdom: TermDOM,
): HTMLDialogElement | null {
	let modal: HTMLDialogElement | null = null;
	const rendered =
		termdom[kUAToolkit].renderedTopLayer() as unknown as Element[];
	for (const element of rendered) {
		if (termdom[kUAToolkit].isModalDialog(element)) {
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
	termdom: TermDOM,
): Element | null {
	const popover = termdom[kUAToolkit].topmostAutoPopover() as Element | null;
	let target: Element | null = null;
	const rendered =
		termdom[kUAToolkit].renderedTopLayer() as unknown as Element[];
	for (const element of rendered) {
		if (termdom[kUAToolkit].isModalDialog(element) || element === popover) {
			target = element;
		}
	}
	return target;
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
	termdom: TermDOM,
	x: number,
	y: number,
): Element | null {
	processPendingMutationsAndRender(termdom);
	let element = termdom[kLayoutEngine].hitTest(
		termdom.document.documentElement,
		x,
		y,
		termdom[kUAToolkit].topLayer as unknown as Set<Element>,
		termdom[kScrollTop],
	);
	// A pseudo-element is not an element the DOM can hand out: the hit on
	// the content it generates is a hit on the element it originates from.
	for (
		let host = element && termdom[kUAToolkit].getPseudoHost<Element>(element);
		host;
		host = termdom[kUAToolkit].getPseudoHost<Element>(element!)
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
	const modal = topmostModalDialog(termdom);
	if (modal !== null && (element === null || !modal.contains(element))) {
		return modal as unknown as Element;
	}
	return element;
}

/**
 * The scroll box a wheel tick over `target` belongs to: the nearest flat-tree
 * ancestor (the target included) whose overflow-y makes it a scroll
 * container -- auto or scroll; hidden and visible don't take the wheel, as
 * in a browser -- and that can still move in the tick's direction. None
 * means the tick chains past every element scroller to the document camera.
 */
function wheelScrollerFor(
	termdom: TermDOM,
	target: Element,
	deltaY: number,
): Element | null {
	const body = termdom.document.body;
	const root = termdom.document.documentElement;
	const engine = termdom[kLayoutEngine];
	for (
		let element: Element | null = target;
		element && element !== body && element !== root;
		element = termdom[kUAToolkit].flatParentElement<Element>(element)
	) {
		const style = getComputedValues(element);
		const overflowY =
			style.getComputedValue("overflow-y") ||
			style.getComputedValue("overflow");
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
 * Render the whole document once, as plain lines, for a non-terminal stdout.
 *
 * There is no fold here, so there is nothing to commit, freeze or repair: the
 * document is simply printed. Every hard problem in this file is a consequence
 * of having a viewport, and a pipe does not have one.
 */
async function printStatic(
	termdom: TermDOM,
): Promise<void> {
	const pending = termdom[kObserver].takeRecords();
	if (pending.length > 0) {
		handlePendingMutations(termdom, pending);
	}

	termdom[kLayoutEngine].calculateLayout();

	const context = termdom[kScreen].beginStatic({
		rows: documentPaintHeight(termdom),
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

	const top = termdom[kScreenTop];
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
	void termdom[kExchange].write(cursorTo(top + 1, 1));
	const erase = eraseToLineEnd();
	void termdom[kExchange].write(
		erase + output.replace(/\r\n(?!$)/g, "\r\n" + erase),
	);
	void termdom[kExchange].write(eraseBelow());
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
	processPendingMutationsAndRender(termdom);
	const contentHeight = documentPaintHeight(termdom);
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
		scrollDocumentTo(termdom, 0);
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

	// Coalesced pointer motion resolves first: a hover listener's
	// synchronous mutations join the records taken below, and the hover
	// chain's invalidation precedes this frame's style resolution.
	termdom[kEventHandler].resolvePendingHover();

	const pending = termdom[kObserver].takeRecords();
	if (pending.length > 0) {
		handlePendingMutations(termdom, pending);
	}

	termdom[kLayoutEngine].calculateLayout();
	clampScrolledOffsets(termdom);

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
	if (
		!termdom[kFrameDirty] &&
		termdom[kLayoutEngine].invalidations === termdom[kPaintedGeneration] &&
		termdom[kFrameScroll] === 0 &&
		termdom[kFrameBand] === null &&
		!termdom[kScreen].needsRepaint
	) {
		// Skip the paint, not the frame: observers still run, so a fresh
		// observe() gets its initial entry on the next tick.
		afterRender(termdom);
		return;
	}

	// Recompute the focused input's scroll window every frame (derived state).
	const activeField = termdom.document.activeElement;
	if (
		activeField instanceof (termdom.window as any).HTMLInputElement &&
		termdom[kUAToolkit].isTextField(activeField as HTMLInputElement)
	) {
		scrollFieldCaretIntoView(termdom, activeField as HTMLInputElement);
	}

	// Fullscreen owns the WHOLE alternate screen from row zero: the
	// main screen's command anchor means nothing there, and reserveRows'
	// index-scrolls would scroll the alternate screen itself. The
	// document's scroll position survives untouched underneath -- the
	// fixed, Canvas-backed fullscreen element covers it regardless.
	const fullscreen = isFullscreen(termdom);
	const contentHeight = fullscreen ?
		termdom[kViewport].height :
			documentPaintHeight(termdom);
	const regionHeight = Math.min(
		contentHeight,
		termdom[kViewport].height,
	);

	// Take the room we need by pushing earlier output up, never over it.
	const top = fullscreen ? 0 : reserveRows(termdom, regionHeight);

	if (!fullscreen) {
		// The camera cannot run off the end of the document. The clamp goes
		// through the setter, so the journal's delta is what the screen is
		// about to be shifted by -- there is no memory of where the last
		// frame painted for it to disagree with.
		const maxScroll = Math.max(0, contentHeight - regionHeight);
		scrollDocumentTo(termdom, Math.min(termdom[kScrollTop], maxScroll));
	}

	// The camera has no alternate screen to move: fullscreen owns row zero
	// and paints the whole of it. A scroll box inside it does move, though,
	// and DECSTBM margins hold there like anywhere else -- a full-width pane
	// scrolls under fixed chrome the terminal never touches.
	const band = resolveScrollBand(termdom, regionHeight);
	const context = termdom[kScreen].beginFrame({
		offset: -termdom[kScrollTop],
		cursorRow: top,
		regionRows: top + regionHeight,
		delta: band ? band.delta : fullscreen ? 0 : termdom[kFrameScroll],
		band: band ?? undefined,
	});
	termdom[kPainter].paint(context);
	const ansi = termdom[kScreen].endFrame();
	termdom[kFrameScroll] = 0;
	termdom[kFrameBand] = null;
	termdom[kFrameDirty] = false;
	termdom[kPaintedGeneration] = termdom[kLayoutEngine].invalidations;

	if (ansi) {
		await termdom[kExchange].write(ansi);
	}
	afterRender(termdom);
}

/**
 * Move the camera to a document row, clamped at the top.
 *
 * The one writer: the journal's scroll delta is the sum of what comes
 * through here since the last painted frame, so the camera and the rows the
 * terminal is about to be shifted by can never disagree. The frame-time
 * clamp comes through here too, which is why nothing remembers where the
 * last frame painted.
 */
function scrollDocumentTo(
	termdom: TermDOM,
	row: number,
): void {
	const next = Math.max(0, row);
	termdom[kFrameScroll] += next - termdom[kScrollTop];
	termdom[kScrollTop] = next;
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
	const overflow = termdom[kScreenTop] +
		rows -
		termdom[kViewport].height;
	if (overflow <= 0) {
		return 0;
	}
	const push = Math.min(overflow, termdom[kScreenTop]);
	termdom[kScreenTop] -= push;
	return push;
}

/** Move the camera over the document. */
function scrollCamera(
	termdom: TermDOM,
	rows: number,
): void {
	scrollDocumentTo(termdom, termdom[kScrollTop] + rows);
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
		void termdom[kExchange].write(
			cursorTo(termdom[kViewport].height, 1) + index().repeat(push),
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
		termdom[kScreen].scrolled(push);
	}

	return termdom[kScreenTop];
}

function staticRenderer(
	termdom: TermDOM,
): TermDOM {
	const cols = termdom[kTransport].cols;
	if (
		termdom[kStaticSibling] &&
		termdom[kStaticSibling][kViewport].width !== cols
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
