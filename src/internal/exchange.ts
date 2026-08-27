/**
 * The terminal session: what the terminal can do, what it has been told, and
 * what it says back.
 *
 * Everything above this file works in cells and events. The exchange asks the
 * terminal what it supports, keeps the ledger of every mode it put the
 * terminal into so they can all be undone on the way out, writes the wire
 * text, and sorts what comes back into input for the engine and answers for
 * the queries it is still waiting on.
 */

import {recordClusterAdvance, type WidthMeasurer} from "./text.js";
import type {ColorDepth} from "./color.js";
import {
	encode64,
	ansiMode,
	ansiModeQuery,
	clipboardQuery,
	clipboardWrite,
	decodeClipboardReply,
	decodeCursorReport,
	decodeModeReport,
	decodeMouseEscape,
	splitTrailingEscape,
	cursorPositionQuery,
	eraseToLineEnd,
	popTitle,
	privateMode,
	privateModeQuery,
	pushTitle,
	setWindowTitle,
	tokenizeInput,
	PASTE_END,
	PASTE_START,
} from "./wire.js";

/* -------------------------------------------------- the transport contract */

/** The terminal's dimensions, in cells. */
export interface TerminalSize {
	cols: number;
	rows: number;
}

export interface TerminalCloseInfo {
	/** Exit status, process semantics: the process wrapper hands it to
	 * process.exit; an SSH wrapper sends it as exit-status. */
	status?: number;
	/** The signal that ended the session ("SIGHUP", "SIGTERM"), when one did. */
	signal?: string;
	reason?: string;
}

/**
 * The wire between the engine and a terminal: an established session as
 * duplex streams plus lifecycle, the common subset of WebTransport and
 * WebSocketStream. Everything Node-flavored -- raw mode, signals, env
 * sniffing -- belongs inside a wrapper, never in this contract.
 */
export interface TerminalTransport {
	/**
	 * The current size, as LIVE getters: after `resizes` emits, these answer
	 * with the new size. `resizes` is the notification, these are the value.
	 */
	readonly cols: number;
	readonly rows: number;
	/** What the terminal can display; the wrapper knows its terminal. */
	readonly colorDepth: ColorDepth;
	/**
	 * User input: keys, replies to queries, paste bursts. Chunks are strings,
	 * so code points never split; escape sequences MAY split across chunks
	 * (a network transport fragments arbitrarily), and the session
	 * reassembles them.
	 */
	readonly readable: ReadableStream<string>;
	/** Frames out. */
	readonly writable: WritableStream<string>;
	readonly resizes: ReadableStream<TerminalSize>;
	/**
	 * The screen holds prior content the app must not paint over (a shell
	 * prompt above), so rendering anchors at the cursor rather than row 0.
	 * True for a terminal shared with a shell; false for one the app owns
	 * from row 0 (an xterm embed, a fresh SSH pty).
	 */
	readonly sharesScreen: boolean;
	/**
	 * Whether the far end is a screen that interprets cursor movement.
	 * False for a pipe or a file; rendering degrades to plain appended
	 * lines.
	 */
	readonly interactive: boolean;
	/**
	 * Resolves when the transport is established. A process's tty and an
	 * xterm instance are established at construction (Promise.resolve());
	 * an SSH wrapper resolves it when its channel opens.
	 */
	readonly ready: Promise<void>;
	/** The terminal went away: hangup, disconnect, process exit. Always
	 * fulfills with a TerminalCloseInfo; fields may be absent. */
	readonly closed: Promise<TerminalCloseInfo>;
	/** The app is done with the terminal (window.close()'s last act). A
	 * transport that owns its medium ends it -- the process transport exits
	 * the process with info's status; an SSH transport would end the channel.
	 * One that doesn't (an embedded pane, a test harness) implements this as
	 * a no-op: the engine has already flushed and disposed by the time it
	 * calls here. */
	close(info?: TerminalCloseInfo): void;
}

/* --------------------------------------------------------- the mode ledger */

/**
 * The private modes and stack controls this engine sets, named once. `set`
 * engages, `reset` hands the terminal back; wire spells both. An orderly
 * teardown resets what was engaged, in this declaration order; the
 * transport's panic paths blanket-reset the union. A mode written anywhere
 * else is a restore leak waiting -- new modes are added here, and set
 * through TerminalExchange.setMode.
 */
const MODE_SPELLINGS = {
	motionReporting: {
		set: privateMode(1003, true),
		reset: privateMode(1003, false),
		panic: true,
	},
	mouseCapture: {
		set: privateMode(1002, true) + privateMode(1006, true),
		reset: privateMode(1006, false) + privateMode(1002, false),
		panic: true,
	},
	cursorHidden: {
		set: privateMode(25, false),
		reset: privateMode(25, true),
		panic: true,
	},
	bracketedPaste: {
		set: privateMode(2004, true),
		reset: privateMode(2004, false),
		panic: true,
	},
	titleStack: {set: pushTitle(), reset: popTitle(), panic: true},
	// The Fullscreen API's screen switch. Panic-marked: a crash mid-fullscreen
	// hands the main screen back instead of stranding the user in the
	// alternate one.
	altScreen: {
		set: privateMode(1049, true),
		reset: privateMode(1049, false),
		panic: true,
	},
	// Negotiated, not imposed: a terminal that ignored the offer must not
	// see the reset, so only the engaged-tracking restore may write it.
	clusterWidths: {
		set: privateMode(2027, true),
		reset: privateMode(2027, false),
		panic: false,
	},
} as const;

type ModeName = keyof typeof MODE_SPELLINGS;

const MODE_RESTORE_ORDER = Object.keys(MODE_SPELLINGS) as ModeName[];

/**
 * The blanket restore the panic paths write: the reset of each panic-marked
 * mode, engaged or not -- a panic path cannot know, and each is idempotent.
 */
export const PANIC_RESTORE = MODE_RESTORE_ORDER.filter(
	(name) => MODE_SPELLINGS[name].panic,
).map((name) => MODE_SPELLINGS[name].reset).join("");

/* ------------------------------------------------------------ the exchange */

/** What the exchange tells the engine, as it works out what arrived. */
interface ExchangeHandlers {
	/** Decoded non-mouse input: batched keystrokes after the demux. */
	onKeys(keyInput: string): void;
	onMouse(button: number, x: number, y: number, release: boolean): void;
	onPaste(text: string): void;
	onResize(size: TerminalSize): void;
	/** Ctrl-C with no listener claiming it: the default action is window.close(). */
	onCloseRequest(): void;
	/** Where the region's start row is, once cursor detection lands. */
	onCommandStart(screenTop: number): void;
	/**
	 * The terminal answered that it reorders bidirectional text itself, so the
	 * renderer must hand it logical order.
	 */
	onTerminalReordersText(): void;
	/**
	 * The terminal reported an advance the width tables did not predict. Every
	 * width answered so far may have been answered wrongly, so the rows holding
	 * that cluster need repainting against the corrected measurement.
	 */
	onWidthCorrection(): void;
	/**
	 * A cluster the margin keeps turning away needs a frame to carry its probe
	 * train, and the document is not producing one. Repaint the least that
	 * gives the train a row to stand on.
	 */
	onWidthStarvation(): void;
	/** The transport's `closed` settled: the terminal is gone. */
	onClosed(info: TerminalCloseInfo): void;
}

const kTransport = Symbol("transport");
const kInteractive = Symbol("interactive");
const kEngagedModes = Symbol("engagedModes");
const kAnchorDetectionEnabled = Symbol("anchorDetectionEnabled");
const kHandlers = Symbol("handlers");

const kWriter = Symbol("writer");
const kReader = Symbol("reader");
const kResizeReader = Symbol("resizeReader");
const kStarted = Symbol("started");
const kDisposed = Symbol("disposed");
const kLastWrite = Symbol("lastWrite");
const kWriteBatch = Symbol("writeBatch");

const kPasteBuffer = Symbol("pasteBuffer");
const kPartialEscape = Symbol("partialEscape");

const kHasDetectedCommandStart = Symbol("hasDetectedCommandStart");
const kCursorDetectionHandler = Symbol("cursorDetectionHandler");
const kCursorDetectionTimer = Symbol("cursorDetectionTimer");
const kCursorDetectionPromise = Symbol("cursorDetectionPromise");
const kCursorDetectionSequence = Symbol("cursorDetectionSequence");
const kDsrSequence = Symbol("dsrSequence");

const kModeProbeHandlers = Symbol("modeProbeHandlers");
const kModeProbeTimers = Symbol("modeProbeTimers");
const kPriorBidiMode = Symbol("priorBidiMode");
const kGraphemeClustersNegotiated = Symbol("graphemeClustersNegotiated");

const kClipboardHandler = Symbol("clipboardHandler");
const kClipboardTimer = Symbol("clipboardTimer");
const kClipboardBuffer = Symbol("clipboardBuffer");
const kClipboardQueryTimeout = Symbol("clipboardQueryTimeout");
const kClipboardReplyLimit = Symbol("clipboardReplyLimit");

const kProbingEnded = Symbol("probingEnded");
const kWidthProbes = Symbol("widthProbes");
const kWidthSettled = Symbol("widthSettled");
const kWidthAsked = Symbol("widthAsked");
const kWidthAnswered = Symbol("widthAnswered");
const kWidthProbing = Symbol("widthProbing");
const kWidthProbeTimer = Symbol("widthProbeTimer");
const kWidthProbeTimeout = Symbol("widthProbeTimeout");
const kWidthMeasurer = Symbol("widthMeasurer");

const kWidthStarved = Symbol("widthStarved");
const kStarvationTimer = Symbol("starvationTimer");
const kWidthStarvationWait = Symbol("widthStarvationWait");

const kDriftBatch = Symbol("driftBatch");
const kWidthRun = Symbol("widthRun");
const kWidthDrift = Symbol("widthDrift");
const kWidthRunLost = Symbol("widthRunLost");

/**
 * The conversation held over a transport: one reader, one writer, and the
 * demultiplexer between them.
 *
 * Everything the wire carries arrives interleaved on one byte stream -- that
 * is the terminal protocol's nature -- so this is where it fans out:
 * bracketed-paste bodies, DECRPM mode replies and DSR cursor replies (spliced
 * out and routed to whichever query waits), mouse reports, and finally
 * keystrokes. The engine sees typed callbacks and dispatches DOM events; no
 * other layer parses input.
 *
 * The query half is the round-trips the engine cannot have synchronously. A
 * DSR cursor query locates the command-start row so the painted region
 * anchors correctly; DECRQM queries settle capabilities the renderer's
 * contract depends on (explicit bidi, grapheme-cluster widths). Answers may
 * never come -- most terminals implement no such modes -- so every query is
 * bounded by a timer, and silence is a valid answer meaning "no opinion,
 * ours stands". Every timer is tracked so dispose() can clear it; a live one
 * keeps the event loop open, which across a test suite is fatal.
 */
export class TerminalExchange {
	declare [kTransport]: TerminalTransport;
	declare [kInteractive]: boolean;
	// The modes currently set on the terminal, the source restore derives from.
	declare [kEngagedModes]: Set<ModeName>;
	declare [kAnchorDetectionEnabled]: boolean;
	declare [kHandlers]: ExchangeHandlers;

	declare [kWriter]: WritableStreamDefaultWriter<string> | null;
	declare [kReader]: ReadableStreamDefaultReader<string> | null;
	declare [kResizeReader]: ReadableStreamDefaultReader<TerminalSize> | null;
	declare [kStarted]: boolean;
	declare [kDisposed]: boolean;
	// The last queued write, so flush() can await everything before it.
	declare [kLastWrite]: Promise<void>;

	// Body of a bracketed paste (ESC[200~..ESC[201~) across chunks; null when
	// no paste is in flight.
	declare [kPasteBuffer]: string | null;
	// A trailing incomplete escape sequence, held for the next chunk: network
	// transports fragment arbitrarily, and half a CSI decodes as garbage
	// keystrokes. A bare trailing ESC is NOT held -- it is the Escape key
	// far more often than a split, and holding it would delay every Escape.
	declare [kPartialEscape]: string;

	// Command start was resolved (even if at row 1). The resize re-anchor saves
	// and restores this around its redraw.
	declare [kHasDetectedCommandStart]: boolean;
	// The pending DSR reply handler and its timeout. Cursor detection and the
	// resize re-anchor share these slots so input routing and dispose can see
	// them; overlapping queries check handler identity before clearing.
	declare [kCursorDetectionHandler]: ((data: string) => void) | null;
	declare [kCursorDetectionTimer]: ReturnType<typeof setTimeout> | null;
	// Resolves when startup command-start detection settles (or times out), so
	// the first frame waits for the anchor rather than painting at row 0 first.
	declare [kCursorDetectionPromise]: Promise<void> | null;

	/**
	 * Outstanding DECRQM queries, keyed by the mode as it appears in the reply
	 * ("8", "?2027"). Two negotiations run concurrently at startup and their
	 * answers can arrive in either order, so they are matched by mode number
	 * rather than by whoever asked last.
	 */
	declare [kModeProbeHandlers]: Map<string, (value: number) => void>;
	declare [kModeProbeTimers]: Set<ReturnType<typeof setTimeout>>;
	/**
	 * The outstanding OSC 52 clipboard query: the handler its reply resolves,
	 * the timeout that gives up on it, and the half of a reply held for the
	 * next chunk. One query at a time -- the reply carries no sequence, so a
	 * second would have nothing to be told apart by.
	 *
	 * The buffer is only ever non-null while a query is outstanding, so a
	 * typed ESC ] is routed as keystrokes exactly as before.
	 */
	declare [kClipboardHandler]: ((payload: string | null) => void) | null;
	declare [kClipboardTimer]: ReturnType<typeof setTimeout> | null;
	declare [kClipboardBuffer]: string | null;
	/** The BDSM state the terminal reported before we touched it, for dispose. */
	declare [kPriorBidiMode]: number | null;
	/** Whether the terminal agreed to grapheme-cluster widths (mode 2027). */
	declare [kGraphemeClustersNegotiated]: boolean;

	/**
	 * DSR queries in the order they went out. A terminal answers them in that
	 * order, so the sequence number is what keeps cursor detection and width
	 * measurement from taking each other's replies.
	 */
	declare [kDsrSequence]: number;
	/** The sequence number of the outstanding cursor query, if any. */
	declare [kCursorDetectionSequence]: number;
	/** Width probes written and not yet answered, oldest first. */
	declare [kProbingEnded]: boolean;
	declare [kWidthProbes]: Array<{
		cluster: string;
		run: number;
		batch: object;
		column: number;
		width: number;
		sequence: number;
		sentAt: number;
	}>;

	/**
	 * Clusters whose advance this session no longer wonders about: the terminal
	 * answered for them, or answered unreadably and the tables keep them.
	 *
	 * A cluster leaves this set never, and enters it only on a reply -- not on
	 * a probe. So a cluster the frame paints twice before either answer is
	 * asked about twice, which is what keeps a run's column arithmetic whole:
	 * every glyph whose advance is still in question carries its own query, and
	 * the replies come back in the same order the glyphs were painted.
	 */
	declare [kWidthSettled]: Set<string>;
	/**
	 * Every cluster that has ever carried a query, wherever it was asked from.
	 * A cluster in here is not starved however often the margin turns it away:
	 * it has had its question put, and the answer's fate is the queue's
	 * business. This is what bounds the probe train to one per cluster.
	 */
	declare [kWidthAsked]: Set<string>;
	/**
	 * Clusters the margin guard turned away that have never been asked about
	 * at all, waiting for a frame to carry their probe train. Right-aligned
	 * text is what fills this: its clusters land against the last column every
	 * time they are painted, so in place they would be deferred for the whole
	 * session.
	 */
	declare [kWidthStarved]: Set<string>;
	/** The wait for a frame the starved clusters could have ridden. */
	declare [kStarvationTimer]: ReturnType<typeof setTimeout> | null;
	/**
	 * Whether frames may still probe: false from the start when nothing
	 * interactive is behind the transport, and false for good once the
	 * terminal proves it does not answer.
	 */
	declare [kWidthProbing]: boolean;
	/** Whether the terminal has ever answered a width probe. */
	declare [kWidthAnswered]: boolean;
	declare [kWidthProbeTimer]: ReturnType<typeof setTimeout> | null;
	// The write batch and emission run the running divergence belongs to, and
	// the divergence itself: within one run each cluster's cells are reached by
	// advancing through the ones before it, so an earlier miscount displaces
	// every column after it by exactly this much. A reading that cannot be
	// believed leaves the drift unknown, and the rest of that run unreadable
	// with it.
	declare [kDriftBatch]: object | null;
	declare [kWidthRun]: number;
	declare [kWidthDrift]: number;
	declare [kWidthRunLost]: boolean;
	// Replaced by every write, so probes taken while building one frame are
	// told apart from probes taken while building the next.
	declare [kWriteBatch]: object;
	declare [kWidthMeasurer]: WidthMeasurer;

	/**
	 * Generous: the reply crosses whatever the transport is, and a terminal
	 * answering late is still answering. Only a session that gets NOTHING back
	 * gives up probing, and it can afford to wait to be sure.
	 */
	static readonly [kWidthProbeTimeout] = 2000;
	/**
	 * How long a starved cluster waits for a frame of the document's own
	 * before one is asked for on its behalf. Long enough that anything still
	 * animating, typing or scrolling carries the train for free.
	 */
	static readonly [kWidthStarvationWait] = 500;
	/**
	 * How long a clipboard query waits. Short on purpose: most terminals
	 * refuse clipboard reads and refusing is silence, so this is the delay
	 * every navigator.clipboard.readText() pays before rejecting. A terminal
	 * that does answer answers at typing latency.
	 */
	static readonly [kClipboardQueryTimeout] = 500;
	/**
	 * The most of a clipboard reply that is held while its terminator is
	 * awaited. A larger payload is not a clipboard the terminal is answering
	 * with, and the query gives up rather than buffer the wire.
	 */
	static readonly [kClipboardReplyLimit] = 1 << 16;

	/**
	 * The frame's channel for measuring cluster advances. Whether asking is
	 * worth anything is not decided here: the channel reports this session's
	 * facts and the width authority judges them (see probingTeaches).
	 */
	get widthMeasurer(): WidthMeasurer {
		return this[kWidthMeasurer];
	}

	constructor(deps: {
		transport: TerminalTransport;
		interactive: boolean;
		anchorDetection: boolean;
		handlers: ExchangeHandlers;
	}) {
		this[kWriter] = null;
		this[kReader] = null;
		this[kResizeReader] = null;
		this[kStarted] = false;
		this[kDisposed] = false;
		this[kLastWrite] = Promise.resolve();
		this[kPasteBuffer] = null;
		this[kPartialEscape] = "";
		this[kHasDetectedCommandStart] = false;
		this[kCursorDetectionHandler] = null;
		this[kCursorDetectionTimer] = null;
		this[kCursorDetectionPromise] = null;
		this[kModeProbeHandlers] = new Map<string, (value: number) => void>();
		this[kModeProbeTimers] = new Set<ReturnType<typeof setTimeout>>();
		this[kClipboardHandler] = null;
		this[kClipboardTimer] = null;
		this[kClipboardBuffer] = null;
		this[kPriorBidiMode] = null;
		this[kGraphemeClustersNegotiated] = false;
		this[kDsrSequence] = 0;
		this[kCursorDetectionSequence] = 0;
		this[kWidthProbes] = [];
		this[kProbingEnded] = false;
		this[kWidthSettled] = new Set<string>();
		this[kWidthProbing] = deps.interactive;
		this[kWidthAnswered] = false;
		this[kWidthProbeTimer] = null;
		this[kDriftBatch] = null;
		this[kWidthRun] = -1;
		this[kWidthDrift] = 0;
		this[kWidthRunLost] = false;
		this[kWriteBatch] = {};
		this[kWidthAsked] = new Set();
		this[kWidthStarved] = new Set();
		this[kStarvationTimer] = null;
		this[kWidthMeasurer] = {
			probing: () => this[kWidthProbing],
			clusterWidthsNegotiated: () => this[kGraphemeClustersNegotiated],
			wants: (cluster: string) => !this[kWidthSettled].has(cluster),
			starved: () => this[kWidthStarved],
			defer: (cluster: string) => {
				// A cluster that has been asked about somewhere is not
				// starving, whatever this frame's margin did to it. So one
				// deferral of a cluster nothing has ever asked about IS the
				// starvation: the layout that put it there will put it there
				// again.
				if (
					this[kWidthAsked].has(cluster) ||
					this[kWidthStarved].has(cluster)
				) {
					return;
				}
				this[kWidthStarved].add(cluster);
				requestStarvationFrame(this);
			},
			probe: (cluster: string, run: number, column: number, width: number) => {
				// A teardown frame asks nothing: the reply would arrive
				// after the tty is handed back, typed into the next shell,
				// and the width it names will never be reused.
				if (this[kProbingEnded]) {
					return "";
				}
				this[kWidthAsked].add(cluster);
				this[kWidthStarved].delete(cluster);
				this[kWidthProbes].push({
					cluster,
					run,
					batch: this[kWriteBatch],
					column,
					width,
					sequence: this[kDsrSequence]++,
					sentAt: Date.now(),
				});
				armWidthProbeTimer(this);
				return cursorPositionQuery();
			},
		};
		this[kTransport] = deps.transport;
		this[kInteractive] = deps.interactive;
		this[kEngagedModes] = new Set<ModeName>();
		this[kAnchorDetectionEnabled] = deps.anchorDetection && deps.interactive;
		this[kHandlers] = deps.handlers;
	}

	/**
	 * Write a mode's set or reset and track the engagement, so teardown can
	 * restore what was engaged and nothing else. Writing on change only makes
	 * re-deciding callers free.
	 */
	setMode(name: ModeName, on: boolean): void {
		if (on === this[kEngagedModes].has(name)) {
			return;
		}
		if (on) {
			this[kEngagedModes].add(name);
		} else {
			this[kEngagedModes].delete(name);
		}
		void this.write(
			on ? MODE_SPELLINGS[name].set : MODE_SPELLINGS[name].reset,
		);
	}

	/**
	 * Record an engagement whose set bytes ride another write -- frames hide
	 * the cursor as part of painting -- so the restore still covers it.
	 */
	markModeEngaged(name: ModeName): void {
		this[kEngagedModes].add(name);
	}

	/**
	 * Write a mode's set bytes and record the engagement, whether or not it
	 * was recorded already. A mode marked engaged because its bytes ride
	 * another write has none on the wire until that write happens, and a
	 * caller that needs the mode NOW cannot wait for it.
	 */
	engageMode(name: ModeName): void {
		this[kEngagedModes].add(name);
		void this.write(MODE_SPELLINGS[name].set);
	}

	/**
	 * Reset the engaged modes, in the table's order. The orderly half of the
	 * restore guarantee; the panic paths write the blanket union instead.
	 */
	restoreEngagedModes(): void {
		for (const name of MODE_RESTORE_ORDER) {
			if (this[kEngagedModes].delete(name)) {
				void this.write(MODE_SPELLINGS[name].reset);
			}
		}
	}

	/** Whether command-start anchoring runs: the default process transport only. */
	get anchorDetectionEnabled(): boolean {
		return this[kAnchorDetectionEnabled];
	}

	/**
	 * Whether command start was resolved. The resize re-anchor saves this,
	 * clears it across its redraw so the frame is placed by the screen reset
	 * rather than a stale detection, then restores it.
	 */
	get hasDetectedCommandStart(): boolean {
		return this[kHasDetectedCommandStart];
	}

	set hasDetectedCommandStart(value: boolean) {
		this[kHasDetectedCommandStart] = value;
	}

	/**
	 * Queue output on the transport, in order. The writer engages lazily on
	 * the first write. Returns the chunk's flush promise; flush() awaits the
	 * queue's tail.
	 */
	write(output: string): Promise<void> {
		// Probes are taken while a frame is being built and go out with it, so
		// each write ends the batch that can share a drift correction.
		this[kWriteBatch] = {};
		// A disposed session has released the wire; late writes are dropped.
		if (this[kDisposed] && !this[kWriter]) {
			return Promise.resolve();
		}
		if (!this[kWriter]) {
			this[kWriter] = this[kTransport].writable.getWriter();
		}
		this[kLastWrite] = this[kWriter].write(output).catch(() => {
			// A transport torn down mid-write (disconnect) is a close, not a
			// crash; the closed promise carries the real signal.
		});
		return this[kLastWrite];
	}

	/** Resolves when everything written so far has reached the transport. */
	flush(): Promise<void> {
		return this[kLastWrite];
	}

	/**
	 * Begin the conversation: acquire the readers and route input, resizes and
	 * closure to the engine's handlers. Idempotent.
	 */
	start(): void {
		if (this[kStarted]) {
			return;
		}
		this[kStarted] = true;

		this[kReader] = this[kTransport].readable.getReader();
		void readLoop(this, this[kReader]);

		this[kResizeReader] = this[kTransport].resizes.getReader();
		void resizeLoop(this, this[kResizeReader]);

		void this[kTransport].closed.then((info) => {
			if (!this[kDisposed]) {
				this[kHandlers].onClosed(info);
			}
		});
	}

	/**
	 * The outstanding startup command-start detection, or null once it has
	 * settled. The first interactive frame awaits this so it anchors at the
	 * resolved row rather than painting at row 0 first -- but only when one is
	 * actually pending. A settled probe returns null so the caller adds no
	 * async hop: an unconditional await would defer the rest of that frame a
	 * microtask even with nothing to wait for, and a synchronous scroll clamp
	 * depends on the frame running straight through.
	 */
	get cursorDetectionPending(): Promise<void> | null {
		return this[kCursorDetectionPromise];
	}

	/** Startup command-start detection, awaited by the first frame's anchor. */
	initializeCursorDetection(): void {
		this[kCursorDetectionPromise] = null;
		if (this[kAnchorDetectionEnabled]) {
			this[kCursorDetectionPromise] = Promise.race([
				this.detectCommandStart().then(() => {}),
				// Fallback: if cursor detection takes too long, proceed without it.
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					this[kHasDetectedCommandStart] = false;
				})
				.finally(() => {
					// Clear the promise so subsequent renders don't wait.
					this[kCursorDetectionPromise] = null;
				});
		}
	}

	/**
	 * Settle who reorders bidirectional text, us or the terminal.
	 *
	 * ECMA-48 mode 8 (BDSM) has two sides: *implicit*, where the terminal runs
	 * the bidi algorithm over what it receives, and *explicit*, where the
	 * application decides the order and the terminal paints cells as given. We
	 * need explicit, and not by preference: this renderer addresses cells
	 * directly and diffs frames, so it hands the terminal single cells at
	 * absolute positions. A terminal reordering each of those against a line it
	 * was never given whole would scramble the frame. So we ask for explicit
	 * and then ask what we got (DECRQM), rather than assuming either.
	 *
	 * The answer is a DECRPM value: 0 means the terminal does not recognise the
	 * mode at all -- no bidi, cells land as written, which is the same contract
	 * explicit gives us. 2 or 4 confirm explicit. 1 or 3 mean it intends to
	 * reorder anyway, and 3 (permanently set) means our request was refused; in
	 * that case we stop reordering and emit logical order, because the terminal
	 * doing it once beats both of us doing it.
	 *
	 * Silence is the common case -- most terminals answer nothing at all -- and
	 * is treated as "no bidi", which is what silence has always meant here.
	 */
	async negotiateBidi(): Promise<void> {
		if (!this[kInteractive]) {
			return;
		}

		// Explicit mode, then "what is mode 8 now?" in one write.
		const answer = await probeMode(
			this,
			"8",
			ansiMode(8, false) + ansiModeQuery(8),
		);

		// No bidi at all: cells land as written, which is the contract we want.
		if (answer === null || answer === 0) {
			return;
		}
		this[kPriorBidiMode] = answer;

		// 1 = still set, 3 = permanently set. Either way it reorders regardless
		// of what we asked, so hand it text in the order it expects.
		if (answer === 1 || answer === 3) {
			this[kHandlers].onTerminalReordersText();
		}
	}

	/**
	 * A terminal that does not implement a mode report may echo the
	 * request's final byte as text. Homing and erasing the line disposes
	 * of any echo, so the first frame starts on a clean row.
	 */
	scrubProbeEcho(): void {
		if (!this[kInteractive]) {
			return;
		}
		void this.write("\r" + eraseToLineEnd());
	}

	/**
	 * Ask the terminal to measure text in grapheme CLUSTERS rather than by code
	 * point (DEC private mode 2027, the terminal-unicode-core specification).
	 *
	 * The default a terminal implements is POSIX wcwidth, which is per code
	 * point and predates emoji: it cannot express that a ZWJ family sequence or
	 * an emoji with a variation selector is one indivisible unit, so it
	 * advances the cursor once per code point in them. We measure by cluster --
	 * that is what stringWidth does -- so on such a terminal every cluster of
	 * more than one code point is a standing disagreement about where the next
	 * cell is.
	 *
	 * Mode 2027 is the fix the terminal community landed on, and it is asked
	 * for the same way as bidi: set it, then query it. A terminal that does not
	 * know the mode answers 0 or says nothing, and we simply carry on -- our
	 * measurements do not change, because they were already cluster-based; what
	 * changes is only whether the terminal agrees with them.
	 */
	async negotiateGraphemeClusters(): Promise<void> {
		if (!this[kInteractive]) {
			return;
		}

		const answer = await probeMode(
			this,
			"?2027",
			MODE_SPELLINGS.clusterWidths.set + privateModeQuery(2027),
		);
		// 1 = set (it agrees now), 3 = permanently set (it always did).
		this[kGraphemeClustersNegotiated] = answer === 1 || answer === 3;
		if (this[kGraphemeClustersNegotiated]) {
			this.markModeEngaged("clusterWidths");
		}
	}

	/**
	 * Detect the current cursor position and set the viewport's command-start
	 * anchor. Sends DSR (`ESC[6n`) and waits for the `ESC[row;colR` reply.
	 */
	detectCommandStart(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this[kInteractive]) {
				reject(new Error("Cannot detect cursor position: not interactive"));
				return;
			}

			let responseBuffer = "";

			const finish = () => {
				this[kCursorDetectionHandler] = null;
				if (this[kCursorDetectionTimer] !== null) {
					clearTimeout(this[kCursorDetectionTimer]);
					this[kCursorDetectionTimer] = null;
				}
			};

			this[kCursorDetectionHandler] = (dataStr: string) => {
				responseBuffer += dataStr;

				const match = decodeCursorReport(responseBuffer);
				if (match) {
					finish();

					// Convert 1-based terminal row to the 0-based anchor.
					this[kHandlers].onCommandStart(match.row - 1);

					this[kHasDetectedCommandStart] = true;
					resolve(match.row);
				}
			};

			this[kCursorDetectionSequence] = this[kDsrSequence]++;
			void this.write(cursorPositionQuery());

			// The timer is held so a response can clear it; left running, it
			// keeps the event loop alive a further second.
			this[kCursorDetectionTimer] = setTimeout(() => {
				this[kCursorDetectionTimer] = null;
				if (this[kCursorDetectionHandler]) {
					this[kCursorDetectionHandler] = null;
					reject(new Error("Timeout waiting for cursor position response"));
				}
			}, 1000);
		});
	}

	/**
	 * Ask the terminal where the cursor is (DSR) and resolve with its 0-based
	 * row.
	 *
	 * Used by the resize re-anchor: the cursor is parked on our content's
	 * bottom row after every frame, so after a rewrap its position names where
	 * the frame actually ended up. Rejects on timeout so the caller can fall
	 * back to a computed anchor.
	 */
	queryCursorRow(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this[kInteractive]) {
				reject(new Error("not interactive"));
				return;
			}

			// Queries can overlap: a drag fires resizes faster than the terminal
			// answers, and each handleResize issues its own query. The handler
			// and timer live in shared instance slots (so input routing and
			// dispose can see them), so every cleanup must check identity before
			// clearing -- otherwise a superseded query's cleanup kills its
			// successor's handler and timeout, and that resize never redraws.
			let responseBuffer = "";
			let localTimer: ReturnType<typeof setTimeout> | null = null;

			const handler = (dataStr: string) => {
				responseBuffer += dataStr;
				const match = decodeCursorReport(responseBuffer);
				if (match) {
					if (this[kCursorDetectionHandler] === handler) {
						this[kCursorDetectionHandler] = null;
					}
					if (localTimer !== null) {
						clearTimeout(localTimer);
						if (this[kCursorDetectionTimer] === localTimer) {
							this[kCursorDetectionTimer] = null;
						}
						localTimer = null;
					}
					resolve(match.row - 1);
				}
			};

			// Replacing a stale handler is fine: its own timeout still fires and
			// rejects it, and the caller drops an answer to a question it has
			// stopped asking.
			this[kCursorDetectionHandler] = handler;

			this[kCursorDetectionSequence] = this[kDsrSequence]++;
			void this.write(cursorPositionQuery());

			// Short timeout: the redraw should feel immediate, and a terminal
			// that does not answer promptly falls back to the computed re-anchor.
			localTimer = setTimeout(() => {
				if (this[kCursorDetectionHandler] === handler) {
					this[kCursorDetectionHandler] = null;
				}
				if (this[kCursorDetectionTimer] === localTimer) {
					this[kCursorDetectionTimer] = null;
				}
				localTimer = null;
				reject(new Error("Timeout waiting for cursor position response"));
			}, 200);
			this[kCursorDetectionTimer] = localTimer;
		});
	}

	/** OSC 52: replace the terminal's clipboard with `text`. */
	writeClipboard(text: string): Promise<void> {
		const payload = encode64(new TextEncoder().encode(text));
		return this.write(clipboardWrite(payload));
	}

	/** OSC 2: set the terminal's title (the stack holds the prior one). */
	setTitle(text: string): Promise<void> {
		return this.write(setWindowTitle(text));
	}

	queryClipboard(): Promise<string | null> {
		if (!this[kInteractive] || this[kDisposed]) {
			return Promise.resolve(null);
		}
		return new Promise<string | null>((resolve) => {
			settleClipboardQuery(this, null);
			const timer = setTimeout(() => {
				settleClipboardQuery(this, null);
			}, TerminalExchange[kClipboardQueryTimeout]);
			this[kClipboardTimer] = timer;
			this[kClipboardHandler] = resolve;
			void this.write(clipboardQuery());
		});
	}

	/**
	 * Wait for the reply of every outstanding cursor-position query --
	 * width probes, an anchor query -- or give up when the deadline
	 * passes. A reply that lands after the tty is handed back is typed
	 * into the caller's shell, so teardown holds the wire until the debt
	 * is paid or forfeited. Mode probes are not waited on: they belong to
	 * attach, and their stragglers have erase handling of their own.
	 */
	drainQueries(deadlineMs: number): Promise<void> {
		this[kProbingEnded] = true;
		if (!this[kInteractive] || this[kDisposed]) {
			return Promise.resolve();
		}
		const settled = () =>
			this[kWidthProbes].length === 0 &&
			this[kCursorDetectionHandler] === null;
		if (settled()) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const deadline = Date.now() + deadlineMs;
			const timer = setInterval(() => {
				if (settled() || Date.now() >= deadline) {
					clearInterval(timer);
					resolve();
				}
			}, 10);
			// A process with nothing else to do may exit instead of
			// waiting out a forfeited deadline.
			timer.unref?.();
		});
	}

	dispose(): void {
		if (this[kDisposed]) {
			return;
		}
		this[kDisposed] = true;
		this[kProbingEnded] = true;

		// We asked for explicit bidi on the way in; give the terminal back the
		// mode it reported, so the next command inherits its own settings rather
		// than ours. Only when it was SET -- reset is where we left it anyway.
		if (this[kPriorBidiMode] === 1) {
			void this.write(ansiMode(8, true));
			this[kPriorBidiMode] = null;
		}
		// The engaged modes go back too -- 2027 among them, for a terminal
		// that agreed to it. A terminal that never had a mode does not see
		// its reset, having never been set.
		this.restoreEngagedModes();
		this[kGraphemeClustersNegotiated] = false;
		settleClipboardQuery(this, null);
		for (const timer of this[kModeProbeTimers]) {
			clearTimeout(timer);
		}
		this[kModeProbeTimers].clear();
		this[kModeProbeHandlers].clear();
		if (this[kCursorDetectionTimer] !== null) {
			clearTimeout(this[kCursorDetectionTimer]);
			this[kCursorDetectionTimer] = null;
		}
		this[kCursorDetectionHandler] = null;
		if (this[kWidthProbeTimer] !== null) {
			clearTimeout(this[kWidthProbeTimer]);
			this[kWidthProbeTimer] = null;
		}
		if (this[kStarvationTimer] !== null) {
			clearTimeout(this[kStarvationTimer]);
			this[kStarvationTimer] = null;
		}
		this[kWidthProbes].length = 0;
		this[kWidthProbing] = false;

		// Release the wire: cancelling the readable is what hands a process
		// transport its tty back (raw mode off, stdin paused). The writer is
		// released after the restores above have been queued on it.
		if (this[kReader]) {
			void this[kReader].cancel().catch(() => {});
			this[kReader] = null;
		}
		if (this[kResizeReader]) {
			void this[kResizeReader].cancel().catch(() => {});
			this[kResizeReader] = null;
		}
		if (this[kWriter]) {
			const writer = this[kWriter];
			this[kWriter] = null;
			void this[kLastWrite].then(() => writer.releaseLock());
		}
	}
}

/* ------------------------------------------------------------ width probes */

/**
 * Wait for a frame the starved clusters can ride, and ask for one if none
 * comes.
 *
 * Starvation is discovered while a frame is being emitted, and that frame is
 * already past the point where its train would have gone -- so the clusters
 * need a later frame. A document still painting gives them one for nothing:
 * every frame carries whatever is starved when it starts. Only a document
 * that has gone quiet needs to be made to paint, and the wait is what tells
 * the two apart.
 */
function requestStarvationFrame(session: TerminalExchange): void {
	if (session[kStarvationTimer] !== null) {
		return;
	}
	session[kStarvationTimer] = setTimeout(() => {
		session[kStarvationTimer] = null;
		if (session[kDisposed] || session[kWidthStarved].size === 0) {
			return;
		}
		session[kHandlers].onWidthStarvation();
	}, TerminalExchange[kWidthStarvationWait]);
}

/**
 * Keep a deadline running for as long as any probe is outstanding, timed
 * from the oldest of them.
 */
function armWidthProbeTimer(
	session: TerminalExchange,
): void {
	if (session[kWidthProbeTimer] !== null) {
		return;
	}
	const oldest = session[kWidthProbes][0];
	if (oldest === undefined) {
		return;
	}
	const remaining = Math.max(
		0,
		oldest.sentAt + TerminalExchange[kWidthProbeTimeout] - Date.now(),
	);
	session[kWidthProbeTimer] = setTimeout(() => {
		session[kWidthProbeTimer] = null;
		// Unanswered this long is unanswered. The queue is what matches
		// replies to probes, so an abandoned probe must leave it; its
		// cluster keeps the tables' answer and is not asked again. Probes
		// written since the deadline was set are not late yet and keep
		// their place -- the deadline is per probe, and re-arms for the
		// oldest one still waiting.
		const deadline = Date.now() - TerminalExchange[kWidthProbeTimeout];
		let expired = 0;
		while (
			expired < session[kWidthProbes].length &&
			session[kWidthProbes][expired].sentAt <= deadline
		) {
			session[kWidthSettled].add(session[kWidthProbes][expired].cluster);
			expired++;
		}
		// Nothing has ever come back: this terminal does not answer DSR,
		// and asking it again each frame is asking forever. Fall open to
		// the tables.
		if (expired > 0 && !session[kWidthAnswered]) {
			session[kWidthProbing] = false;
			session[kWidthProbes].length = 0;
			session[kWidthStarved].clear();
			return;
		}
		session[kWidthProbes].splice(0, expired);
		armWidthProbeTimer(session);
	}, remaining);
}

/**
 * Settle one width probe against the column the terminal reports.
 *
 * The probe rode the frame that painted the cluster, so the reply's column
 * minus the column the cluster started from IS the advance -- corrected by
 * the drift the earlier unmeasured clusters of the same run introduced,
 * which their own replies have just established.
 */
function settleWidthProbe(
	session: TerminalExchange,
	probe: {
		cluster: string;
		run: number;
		batch: object;
		column: number;
		width: number;
	},
	replyColumn: number,
): void {
	session[kWidthAnswered] = true;
	// The deadline belonged to the probe just answered; whatever is still
	// waiting gets its own.
	if (session[kWidthProbeTimer] !== null) {
		clearTimeout(session[kWidthProbeTimer]);
		session[kWidthProbeTimer] = null;
	}
	armWidthProbeTimer(session);

	if (
		probe.batch !== session[kDriftBatch] || probe.run !== session[kWidthRun]
	) {
		session[kDriftBatch] = probe.batch;
		session[kWidthRun] = probe.run;
		session[kWidthDrift] = 0;
		session[kWidthRunLost] = false;
	}

	// An earlier reading in this run could not be believed, so the drift the
	// glyphs before this one introduced is unknown and its column means
	// nothing. Wait for a run whose arithmetic is whole.
	if (session[kWidthRunLost]) {
		return;
	}

	// Terminal columns are 1-based; the ledger counts cells.
	const advance = replyColumn - 1 - (probe.column + session[kWidthDrift]);
	// A reading no cluster could produce means the reply describes
	// something else -- a screen that scrolled under the frame, a terminal
	// answering out of turn. The tables keep the cluster, and the rest of
	// the run is read against a drift this reading did not establish.
	if (advance < 0 || advance > 4) {
		session[kWidthRunLost] = true;
		return;
	}

	session[kWidthSettled].add(probe.cluster);
	session[kWidthDrift] += advance - probe.width;
	if (recordClusterAdvance(probe.cluster, advance)) {
		session[kHandlers].onWidthCorrection();
	}
}

/* ---------------------------------------------------- input demultiplexing */

/**
 * A throw from routing one chunk, raised again out of band. Nothing here
 * reports an error to the document, and swallowing one would hide it, so it
 * leaves as an uncaught exception while the read goes on.
 */
function reportInputFailure(err: unknown): void {
	queueMicrotask(() => {
		throw err;
	});
}

async function readLoop(
	session: TerminalExchange,
	reader: ReadableStreamDefaultReader<string>,
): Promise<void> {
	try {
		for (;;) {
			const {done, value} = await reader.read();
			if (done) {
				return;
			}
			if (!value) {
				continue;
			}
			let chunk = session[kPartialEscape] + value;
			session[kPartialEscape] = "";
			const held = splitTrailingEscape(chunk);
			if (held > 0 && held <= 32) {
				session[kPartialEscape] = chunk.slice(-held);
				chunk = chunk.slice(0, -held);
			}
			if (chunk) {
				try {
					route(session, chunk);
				} catch (err) {
					// Only the read can tell the conversation is over, so a
					// throw from routing -- a decode, a listener -- costs its
					// chunk and no more.
					reportInputFailure(err);
				}
			}
		}
	} catch (_err) {
		// Reader cancelled by dispose, or the transport died; either way the
		// conversation is over and closed/dispose carry the follow-up.
	}
}

async function resizeLoop(
	session: TerminalExchange,
	reader: ReadableStreamDefaultReader<TerminalSize>,
): Promise<void> {
	try {
		for (;;) {
			const {done, value} = await reader.read();
			if (done) {
				return;
			}
			if (value) {
				session[kHandlers].onResize(value);
			}
		}
	} catch (_err) {
		// As above: teardown, not error.
	}
}

/**
 * The demultiplexer. One route table for everything the wire carries, in
 * priority order; re-entered with the remainder whenever a reply or paste
 * fence is spliced out of a chunk that also holds real typing.
 */
function route(
	session: TerminalExchange,
	dataStr: string,
): void {
	// Bracketed paste: its body is literal text (a pasted newline must not
	// fire Enter), buffered across chunks until ESC[201~. Checked before the
	// report routes so paste content isn't parsed as a reply.
	if (session[kPasteBuffer] !== null) {
		const end = dataStr.indexOf(PASTE_END);
		if (end === -1) {
			session[kPasteBuffer] += dataStr;
			return;
		}
		session[kHandlers].onPaste(session[kPasteBuffer] + dataStr.slice(0, end));
		session[kPasteBuffer] = null;
		const after = dataStr.slice(end + PASTE_END.length);
		if (after.length) {
			route(session, after);
		}
		return;
	}
	const pasteStart = dataStr.indexOf(PASTE_START);
	if (pasteStart !== -1) {
		const before = dataStr.slice(0, pasteStart);
		if (before.length) {
			route(session, before);
		}
		session[kPasteBuffer] = "";
		route(session, dataStr.slice(pasteStart + PASTE_START.length));
		return;
	}

	// The clipboard reply, while one is asked for: its base64 body would not
	// survive tokenization, and it can arrive split, so it is taken out of
	// the chunk before anything else looks at it.
	if (session[kClipboardHandler] !== null) {
		const rest = routeClipboardReply(session, dataStr);
		if (rest !== null) {
			if (rest.length > 0) {
				route(session, rest);
			}
			return;
		}
	}

	// Replies (highest priority): the terminal's answer about a mode
	// (DECRPM) or the cursor position (DSR). Fast typing can land in the
	// same chunk as a report -- "jjj\x1b[12;1Rjjj" -- so hand the report to
	// the waiting query and let the rest continue through as keystrokes.
	const modeReport = decodeModeReport(dataStr);
	if (
		modeReport &&
		feedModeReport(session, modeReport.mode, modeReport.value)
	) {
		const rest =
			dataStr.slice(0, modeReport.index) +
			dataStr.slice(modeReport.index + modeReport.length);
		if (rest.length > 0) {
			route(session, rest);
		}
		return;
	}

	const report = decodeCursorReport(dataStr);
	if (report && feedCursorReport(session, report.text, report.col)) {
		const rest =
			dataStr.slice(0, report.index) +
			dataStr.slice(report.index + report.length);
		if (rest.length > 0) {
			route(session, rest);
		}
		return;
	}

	// Ctrl-C: raw mode delivers it as data, and its default action is the
	// engine's to decide (window.close()), not this layer's.
	if (dataStr.charCodeAt(0) === 0x03) {
		session[kHandlers].onCloseRequest();
		return;
	}

	// SGR mouse reports, peeled off token by token so a report glued to
	// fast keystrokes ("jj\x1b[<65;4;7Mjj") eats neither side.
	let keyInput = "";
	for (const token of tokenizeInput(dataStr)) {
		const mouse = decodeMouseEscape(token);
		if (mouse) {
			session[kHandlers].onMouse(
				mouse.button,
				mouse.col,
				mouse.row,
				mouse.release,
			);
		} else {
			keyInput += token;
		}
	}
	if (keyInput.length === 0) {
		return;
	}

	session[kHandlers].onKeys(keyInput);
}

/* ------------------------------------------------------- query correlation */

/**
 * Answer the outstanding clipboard query and forget it. Called with the
 * payload the terminal sent, or null wherever the query ends without one:
 * the timeout, a replacement query, dispose.
 */
function settleClipboardQuery(
	session: TerminalExchange,
	payload: string | null,
): void {
	const waiting = session[kClipboardHandler];
	if (session[kClipboardTimer] !== null) {
		clearTimeout(session[kClipboardTimer]);
		session[kClipboardTimer] = null;
	}
	session[kClipboardHandler] = null;
	session[kClipboardBuffer] = null;
	waiting?.(payload);
}

/**
 * Take the OSC 52 reply out of a chunk that may also hold typing, or say the
 * chunk is not one. Returns the remainder to route on as ordinary input, or
 * null for "no reply here, route the whole chunk yourself".
 *
 * An OSC carries base64 and ends in BEL or ST, and no other branch of the
 * route table knows either, so a reply split across chunks would be shredded
 * into keystrokes. It is held whole here instead -- only while a query is
 * outstanding, so nothing a user types is ever held.
 */
function routeClipboardReply(
	session: TerminalExchange,
	dataStr: string,
): string | null {
	let chunk = dataStr;
	if (session[kClipboardBuffer] !== null) {
		chunk = session[kClipboardBuffer] + chunk;
		session[kClipboardBuffer] = null;
	}
	const reply = decodeClipboardReply(chunk);
	if (reply === null) {
		return null;
	}
	const before = chunk.slice(0, reply.start);
	if (reply.text === null) {
		// The terminator has not arrived. Hold the fragment for the next chunk
		// and let whatever preceded it through as input.
		const held = chunk.slice(reply.start);
		if (held.length <= TerminalExchange[kClipboardReplyLimit]) {
			session[kClipboardBuffer] = held;
			return before;
		}
		settleClipboardQuery(session, null);
		return before;
	}
	settleClipboardQuery(session, reply.text);
	return before + chunk.slice(reply.end);
}

/** Route a DECRPM mode reply to whichever negotiation is waiting on it. */
function feedModeReport(
	session: TerminalExchange,
	mode: string,
	value: number,
): boolean {
	const waiting = session[kModeProbeHandlers].get(mode);
	if (!waiting) {
		return false;
	}
	session[kModeProbeHandlers].delete(mode);
	waiting(value);
	return true;
}

/**
 * Route a DSR cursor-position reply to whichever query it answers.
 *
 * Two kinds of query share this reply shape -- the anchor queries (command
 * start, resize re-anchor) and the width probes a frame appends after a
 * cluster -- and a terminal answers DSR in the order it was asked. So the
 * oldest outstanding query owns the reply, and neither kind can take the
 * other's.
 */
function feedCursorReport(
	session: TerminalExchange,
	report: string,
	column: number,
): boolean {
	const probe = session[kWidthProbes][0];
	if (
		session[kCursorDetectionHandler] !== null &&
		(probe === undefined || session[kCursorDetectionSequence] < probe.sequence)
	) {
		session[kCursorDetectionHandler](report);
		return true;
	}
	if (probe !== undefined) {
		session[kWidthProbes].shift();
		settleWidthProbe(session, probe, column);
		return true;
	}
	return false;
}

/**
 * Set a terminal mode and ask what it actually is now (DECRQM), resolving
 * with the reported value -- or null if the terminal says nothing, which is
 * the common case, since most implement no such mode and answer only the
 * queries they know.
 *
 * The reply values are DECRPM's: 0 not recognised, 1 set, 2 reset, 3
 * permanently set, 4 permanently reset. 0 and silence mean the same thing
 * to every caller here -- the terminal has no opinion, so ours stands.
 */
function probeMode(
	session: TerminalExchange,
	mode: string,
	request: string,
): Promise<number | null> {
	return new Promise<number | null>((resolve) => {
		// The same second the cursor probe allows: a cold start or a slow SSH
		// link can outlast a tighter window, and answering late is answering.
		const timer = setTimeout(() => {
			session[kModeProbeTimers].delete(timer);
			session[kModeProbeHandlers].delete(mode);
			resolve(null);
		}, 1000);
		session[kModeProbeTimers].add(timer);
		session[kModeProbeHandlers].set(mode, (value: number) => {
			clearTimeout(timer);
			session[kModeProbeTimers].delete(timer);
			resolve(value);
		});
		void session.write(request);
	});
}
