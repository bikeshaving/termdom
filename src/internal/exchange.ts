/**
 * The terminal session: what the terminal can do, what it has been told, and
 * what it says back.
 *
 * Everything above this file works in cells and events. The exchange asks the
 * terminal what it supports, keeps the ledger of every mode it put the
 * terminal into so they can all be undone on the way out, writes the wire
 * text, and sorts what comes back into input for the engine and answers for
 * the queries it is still waiting on. Start at TerminalExchange.
 *
 * The one terminal this engine ships a wrapper for -- a Node process -- is
 * written as an ordinary TerminalTransport at the end of the module, where
 * raw mode, the stdin listener and the signal handlers are all it can reach:
 * nothing above transportFromProcess names Node.
 */

import {recordClusterAdvance, type WidthMeasurer} from "./text.js";
import type {ColorDepth} from "./color.js";
import {
	Wire,
	type WireItem,
	type WireKey,
	type WireProbe,
} from "./wire.js";

/* -------------------------------------------------- the transport contract */

/** The terminal's dimensions, in cells. */
export interface TerminalSize {
	cols: number;
	rows: number;
}

export interface TerminalCloseInfo {
	/**
	 * Exit status, process semantics: the process wrapper hands it to
	 * process.exit; an SSH wrapper sends it as exit-status.
	 */
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
	/**
	 * The terminal went away: hangup, disconnect, process exit. Always
	 * fulfills with a TerminalCloseInfo; fields may be absent.
	 */
	readonly closed: Promise<TerminalCloseInfo>;
	/**
	 * The app is done with the terminal (window.close()'s last act). A
	 * transport that owns its medium ends it -- the process transport exits
	 * the process with info's status; an SSH transport would end the channel.
	 * One that doesn't (an embedded pane, a test harness) implements this as
	 * a no-op: the engine has already flushed and disposed by the time it
	 * calls here.
	 */
	close(info?: TerminalCloseInfo): void;
}

/* --------------------------------------------------------- the mode ledger */

/**
 * A wire of its own for the ledger below, which is a constant and spelled
 * before any session exists.
 */
const spelling = new Wire();

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
		set: spelling.privateMode(1003, true).take(),
		reset: spelling.privateMode(1003, false).take(),
		panic: true,
	},
	mouseCapture: {
		set: spelling.privateMode(1002, true).privateMode(1006, true).take(),
		reset: spelling.privateMode(1006, false).privateMode(1002, false).take(),
		panic: true,
	},
	cursorHidden: {
		set: spelling.privateMode(25, false).take(),
		reset: spelling.privateMode(25, true).take(),
		panic: true,
	},
	bracketedPaste: {
		set: spelling.privateMode(2004, true).take(),
		reset: spelling.privateMode(2004, false).take(),
		panic: true,
	},
	titleStack: {
		set: spelling.pushTitle().take(),
		reset: spelling.popTitle().take(),
		panic: true,
	},
	// The Fullscreen API's screen switch. The panic spelling is ?1047, the
	// switch WITHOUT the cursor restore: a bare ?1049l restores a saved
	// cursor even when the alternate screen is not active (tmux and xterm
	// both), and the saved slot outlives whichever program set it. The
	// blanket restore cuts ahead of the queued payout, so a cursor-moving
	// reset there teleports the payout onto rows the app never owned.
	altScreen: {
		set: spelling.privateMode(1049, true).take(),
		reset: spelling.privateMode(1049, false).take(),
		panic: spelling.privateMode(1047, false).take(),
	},
	// Negotiated, not imposed: a terminal that ignored the offer must not
	// see the reset, so only the engaged-tracking restore may write it.
	clusterWidths: {
		set: spelling.privateMode(2027, true).take(),
		reset: spelling.privateMode(2027, false).take(),
		panic: false,
	},
} as const;

type ModeName = keyof typeof MODE_SPELLINGS;

const MODE_RESTORE_ORDER = Object.keys(MODE_SPELLINGS) as ModeName[];

/**
 * The blanket restore the panic paths write: each panic-marked mode's reset,
 * engaged or not -- a panic path cannot know, and each must therefore hold as
 * a no-op on a terminal the mode never touched. A mode whose ordinary reset
 * is not that no-op carries its own panic spelling instead.
 */
export const PANIC_RESTORE = MODE_RESTORE_ORDER.filter(
	(name) => MODE_SPELLINGS[name].panic,
).map((name) => {
	const {panic, reset} = MODE_SPELLINGS[name];
	return typeof panic === "string" ? panic : reset;
}).join("");

/* ------------------------------------------------------------ the exchange */

/** What the exchange tells the engine, as it works out what arrived. */
interface ExchangeHandlers {
	/** One chunk's contiguous keystrokes, as the reader decoded them. */
	onKeys(keys: WireKey[]): void;
	onMouse(button: number, x: number, y: number, release: boolean): void;
	onPaste(text: string): void;
	/**
	 * The terminal resized. A notification and nothing more: the transport's
	 * `cols`/`rows` are the value, and by the time this runs they answer with
	 * the new one.
	 */
	onResize(): void;
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

/**
 * One question awaiting its answer. The probe itself comes from wire, which
 * pairs the request with the rule matching its reply; the session adds what
 * only it knows -- the deadline, and for cursor probes the DSR send order
 * that keeps them and the width probes from taking each other's replies.
 * Oldest first: the first pending probe an item matches is the one it
 * answers, and an item matching none is a late or duplicate reply, dropped.
 */
interface PendingProbe {
	matches(item: WireItem): unknown;
	/** Resolve the asker with the matched answer, clearing the deadline. */
	settle(answer: unknown): void;
	/** The deadline; expiring removes the probe and tells the asker. */
	timer: ReturnType<typeof setTimeout>;
	/** DSR send order, cursor probes only. */
	sequence?: number;
	/** The clipboard probe: one at a time, and dispose answers it null. */
	clipboard?: boolean;
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

const kWire = Symbol("wire");

const kHasDetectedCommandStart = Symbol("hasDetectedCommandStart");
const kCursorDetectionPromise = Symbol("cursorDetectionPromise");
const kDsrSequence = Symbol("dsrSequence");
const kPendingProbes = Symbol("pendingProbes");

const kPriorBidiMode = Symbol("priorBidiMode");
const kGraphemeClustersNegotiated = Symbol("graphemeClustersNegotiated");

const kClipboardQueryTimeout = Symbol("clipboardQueryTimeout");

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
 * is the terminal protocol's nature. The wire's reader says what each chunk
 * meant, and this is where the items fan out: pastes, DECRPM mode replies and
 * DSR cursor replies to whichever query waits, mouse reports, keystrokes. The
 * engine sees typed callbacks and dispatches DOM events; no other layer
 * parses input.
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

	// The session's wire, both ways: every sequence this exchange writes is
	// spelled through it, and its read-side syntax and cross-chunk state --
	// split escapes, an open paste body, an open clipboard reply -- live
	// there too; this class only dispatches the items it returns.
	declare [kWire]: Wire;

	// Command start was resolved (even if at row 1). The resize re-anchor saves
	// and restores this around its redraw.
	declare [kHasDetectedCommandStart]: boolean;
	// Resolves when startup command-start detection settles (or times out), so
	// the first frame waits for the anchor rather than painting at row 0 first.
	declare [kCursorDetectionPromise]: Promise<void> | null;

	/**
	 * Every question written and not yet answered or given up on, oldest
	 * first: the anchor and re-anchor cursor queries, the DECRQM
	 * negotiations, the clipboard read. Each item off the wire answers the
	 * first probe here that matches it. Two mode negotiations run
	 * concurrently at startup and their answers can arrive in either order --
	 * each probe matches on its own mode number, so neither takes the
	 * other's.
	 */
	declare [kPendingProbes]: PendingProbe[];
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
	 * The frame's channel for measuring cluster advances. Whether asking is
	 * worth anything is not decided here: the channel reports this session's
	 * facts and the width authority judges them (see probingTeaches).
	 */
	get widthMeasurer(): WidthMeasurer {
		return this[kWidthMeasurer];
	}

	/**
	 * The session's wire, for the engine's own few spellings. One per session,
	 * so what the engine writes and what the exchange writes are spelled by
	 * the same object -- and every one of them goes out through write().
	 */
	get wire(): Wire {
		return this[kWire];
	}

	constructor(deps: {
		transport: TerminalTransport;
		handlers: ExchangeHandlers;
	}) {
		const interactive = deps.transport.interactive;
		this[kWriter] = null;
		this[kReader] = null;
		this[kResizeReader] = null;
		this[kStarted] = false;
		this[kDisposed] = false;
		this[kLastWrite] = Promise.resolve();
		this[kWire] = new Wire(deps.transport.colorDepth);
		this[kHasDetectedCommandStart] = false;
		this[kCursorDetectionPromise] = null;
		this[kPendingProbes] = [];
		this[kPriorBidiMode] = null;
		this[kGraphemeClustersNegotiated] = false;
		this[kDsrSequence] = 0;
		this[kWidthProbes] = [];
		this[kProbingEnded] = false;
		this[kWidthSettled] = new Set<string>();
		this[kWidthProbing] = interactive;
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
				// Ask through the wire like anything else, then hand the bytes
				// back rather than write them: this ask rides the frame that
				// paints the cluster. The matcher is dropped -- a width reply
				// is claimed by the queue above, in the DSR send order the
				// sequence number keeps, never by the pending table.
				this[kWire].cursorPositionProbe();
				return this[kWire].take();
			},
		};
		this[kTransport] = deps.transport;
		this[kInteractive] = interactive;
		this[kEngagedModes] = new Set<ModeName>();
		// A shared screen is one with a shell's rows above ours, which is what
		// there is an anchor to find; a terminal that answers nothing has none.
		this[kAnchorDetectionEnabled] = deps.transport.sharesScreen && interactive;
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
			this[kWire].ansiMode(8, false).take(),
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
		void this.write("\r" + this[kWire].eraseToLineEnd().take());
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
			MODE_SPELLINGS.clusterWidths.set,
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

			const probe = this[kWire].cursorPositionProbe();
			enrollProbe(
				this,
				probe,
				({row}) => {
					// Convert 1-based terminal row to the 0-based anchor.
					this[kHandlers].onCommandStart(row - 1);

					this[kHasDetectedCommandStart] = true;
					resolve(row);
				},
				() => reject(new Error("Timeout waiting for cursor position response")),
				1000,
				{sequence: this[kDsrSequence]++},
			);
			void this.write(this[kWire].take());
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

			// Queries can overlap: a drag fires resizes faster than the
			// terminal answers, and each handleResize issues its own query.
			// Each is its own pending probe, and DSR answers arrive in ask
			// order, so every query gets its own reply.
			//
			// Short timeout: the redraw should feel immediate, and a terminal
			// that does not answer promptly falls back to the computed
			// re-anchor.
			const probe = this[kWire].cursorPositionProbe();
			enrollProbe(
				this,
				probe,
				({row}) => resolve(row - 1),
				() => reject(new Error("Timeout waiting for cursor position response")),
				200,
				{sequence: this[kDsrSequence]++},
			);
			void this.write(this[kWire].take());
		});
	}

	/** OSC 52: replace the terminal's clipboard with `text`. */
	writeClipboard(text: string): Promise<void> {
		return this.write(this[kWire].clipboardWrite(text).take());
	}

	/** OSC 2: set the terminal's title (the stack holds the prior one). */
	setTitle(text: string): Promise<void> {
		return this.write(this[kWire].title(text).take());
	}

	queryClipboard(): Promise<string | null> {
		if (!this[kInteractive] || this[kDisposed]) {
			return Promise.resolve(null);
		}
		return new Promise<string | null>((resolve) => {
			// One query at a time -- the reply carries no sequence, so a
			// second would have nothing to be told apart by. Asking again
			// answers the first asker with silence.
			abandonClipboardProbe(this);
			const probe = this[kWire].clipboardProbe();
			enrollProbe(
				this,
				probe,
				resolve,
				() => resolve(null),
				TerminalExchange[kClipboardQueryTimeout],
				{clipboard: true},
			);
			void this.write(this[kWire].take());
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
			!this[kPendingProbes].some((probe) => probe.sequence !== undefined);
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
			void this.write(this[kWire].ansiMode(8, true).take());
			this[kPriorBidiMode] = null;
		}
		// The engaged modes go back too -- 2027 among them, for a terminal
		// that agreed to it. A terminal that never had a mode does not see
		// its reset, having never been set.
		this.restoreEngagedModes();
		this[kGraphemeClustersNegotiated] = false;
		// The clipboard read is answered with silence; the rest of the pending
		// probes are simply dropped, their timers cleared so nothing keeps the
		// event loop alive.
		abandonClipboardProbe(this);
		for (const probe of this[kPendingProbes]) {
			clearTimeout(probe.timer);
		}
		this[kPendingProbes].length = 0;
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
function armWidthProbeTimer(session: TerminalExchange): void {
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
			try {
				route(session, value);
			} catch (err) {
				// Only the read can tell the conversation is over, so a
				// throw from routing -- a decode, a listener -- costs its
				// chunk and no more. Nothing here reports an error to the
				// document and swallowing one would hide it, so it is
				// raised again out of band while the read goes on.
				queueMicrotask(() => {
					throw err;
				});
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
				session[kHandlers].onResize();
			}
		}
	} catch (_err) {
		// As above: teardown, not error.
	}
}

/**
 * The demultiplexer: one pass over what the reader says a chunk meant, in
 * stream order. Contiguous keystrokes are batched into one onKeys call;
 * everything else is dispatched where it stands, so a report glued to fast
 * keystrokes ("jj\x1b[<65;4;7Mjj") eats neither side.
 */
function route(session: TerminalExchange, chunk: string): void {
	let keys: WireKey[] = [];
	const flushKeys = () => {
		if (keys.length > 0) {
			session[kHandlers].onKeys(keys);
			keys = [];
		}
	};
	for (const item of session[kWire].feed(chunk)) {
		switch (item.kind) {
			case "key":
				// Ctrl-C: raw mode delivers it as data, and its default action
				// is the engine's to decide (window.close()), not this layer's.
				// Ctrl+c and nothing else is that one byte: no other spelling
				// decodes to the letter with the control modifier.
				if (item.ctrlKey && item.key === "c") {
					flushKeys();
					session[kHandlers].onCloseRequest();
					break;
				}
				keys.push(item);
				break;
			case "mouse":
				flushKeys();
				session[kHandlers].onMouse(
					item.button,
					item.col,
					item.row,
					item.release,
				);
				break;
			case "paste":
				flushKeys();
				session[kHandlers].onPaste(item.text);
				break;
			default:
				flushKeys();
				dispatchReply(session, item);
				break;
		}
	}
	flushKeys();
}

/* ------------------------------------------------------- query correlation */

/**
 * Put a probe in the pending table, bounded by a deadline: `settle` gets the
 * matched answer, `expire` runs when the deadline passes unanswered. Asking
 * is the caller's: the wire method it took the probe from has already put the
 * request in the buffer, and the caller flushes it -- some ride other bytes.
 */
function enrollProbe<T>(
	session: TerminalExchange,
	probe: WireProbe<T>,
	settle: (answer: T) => void,
	expire: () => void,
	timeoutMs: number,
	extras?: {sequence?: number; clipboard?: boolean},
): void {
	const entry: PendingProbe = {
		matches: probe.matches,
		settle: (answer: unknown) => {
			clearTimeout(entry.timer);
			settle(answer as T);
		},
		timer: setTimeout(() => {
			const index = session[kPendingProbes].indexOf(entry);
			if (index !== -1) {
				session[kPendingProbes].splice(index, 1);
			}
			expire();
		}, timeoutMs),
		...extras,
	};
	session[kPendingProbes].push(entry);
}

/**
 * Answer the outstanding clipboard query with silence and forget it. Called
 * wherever the query ends without a reply: a replacement query, dispose.
 */
function abandonClipboardProbe(session: TerminalExchange): void {
	const pending = session[kPendingProbes];
	const index = pending.findIndex((probe) => probe.clipboard);
	if (index !== -1) {
		const [probe] = pending.splice(index, 1);
		probe.settle(null);
	}
}

/**
 * Route one reply item to whichever question it answers: the first pending
 * probe that matches it, and one matching none is dropped as a late,
 * duplicate or unasked-for answer.
 *
 * Cursor reports need one more rule. Two kinds of query share that reply
 * shape -- the anchor queries here and the width probes a frame appends
 * after a cluster -- and a terminal answers DSR in the order it was asked,
 * so the oldest outstanding query owns the reply and neither kind can take
 * the other's.
 */
function dispatchReply(session: TerminalExchange, item: WireItem): void {
	const pending = session[kPendingProbes];
	let index = -1;
	let answer: unknown;
	for (let i = 0; i < pending.length; i++) {
		answer = pending[i].matches(item);
		if (answer !== undefined) {
			index = i;
			break;
		}
	}
	if (item.kind === "cursor-report") {
		const width = session[kWidthProbes][0];
		if (
			width !== undefined &&
			(index === -1 || width.sequence < (pending[index].sequence ?? Infinity))
		) {
			session[kWidthProbes].shift();
			settleWidthProbe(session, width, item.col);
			return;
		}
	}
	if (index === -1) {
		return;
	}
	const [probe] = pending.splice(index, 1);
	probe.settle(answer);
}

/**
 * Set a terminal mode and ask what it actually is now (DECRQM), resolving
 * with the reported value -- or null if the terminal says nothing, which is
 * the common case, since most implement no such mode and answer only the
 * queries they know. `prelude` is the set bytes the query rides behind, in
 * one write.
 *
 * The reply values are DECRPM's: 0 not recognised, 1 set, 2 reset, 3
 * permanently set, 4 permanently reset. 0 and silence mean the same thing
 * to every caller here -- the terminal has no opinion, so ours stands.
 */
function probeMode(
	session: TerminalExchange,
	mode: string,
	prelude: string,
): Promise<number | null> {
	return new Promise<number | null>((resolve) => {
		// The same second the cursor probe allows: a cold start or a slow SSH
		// link can outlast a tighter window, and answering late is answering.
		const probe = session[kWire].modeProbe(mode);
		enrollProbe(session, probe, resolve, () => resolve(null), 1000);
		void session.write(prelude + session[kWire].take());
	});
}

/* --------------------------------------------------- the process transport */

// The Node process shape the default wrapper consumes. The engine itself
// never touches these: they exist so `transportFromProcess` can be typed
// against exactly the members it reads, and so tests can hand it mocks.
export interface TTYWriteStream {
	write(
		chunk: any,
		encoding?: string | ((error?: Error) => void),
		callback?: (error?: Error) => void,
	): boolean;
	columns: number;
	rows: number;
	isTTY: boolean;
}

export interface TTYReadStream {
	isTTY: boolean;
	on(
		event: "data",
		listener: (chunk: string | Uint8Array | ArrayBuffer) => void,
	): unknown;
	removeListener?(
		event: "data",
		listener: (chunk: string | Uint8Array | ArrayBuffer) => void,
	): unknown;
	setRawMode?(mode: boolean): this;
	resume(): this;
	pause(): this;
	setEncoding?(encoding?: string): this;
}

type ProcessSignal = "SIGWINCH" | "SIGINT" | "SIGTERM" | "SIGHUP" | "exit";

export interface ProcessLike {
	stdin?: TTYReadStream;
	stdout: TTYWriteStream;
	on(event: ProcessSignal, listener: () => void): unknown;
	removeListener?(event: ProcessSignal, listener: () => void): unknown;
	exit(code?: number): never;
	env: Record<string, string | undefined>;
}

function detectColorDepth(proc: ProcessLike): ColorDepth {
	const colorterm = proc.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "rgb";
	}

	const term = proc.env.TERM || "";
	if (term.includes("256color") || term.includes("256")) {
		return "256";
	}

	return "ansi";
}

// Frames keep the terminal cursor hidden, and dispose() shows it again -- but
// an app that calls process.exit() without disposing would strand the user's
// shell with no cursor. One process-level exit hook restores it for any
// process transport still engaged. Registered lazily, only once a transport
// actually takes its terminal.
const undisposedProcesses = new Set<ProcessLike>();
let exitHookInstalled = false;

function installCursorRestoreOnExit(): void {
	if (exitHookInstalled) {
		return;
	}
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const proc of undisposedProcesses) {
			try {
				proc.stdout.write(PANIC_RESTORE);
			} catch (_err) {
				// The stream may already be gone; the shell will survive.
			}
		}
	});
}

/**
 * A Node-process-shaped object as a TerminalTransport. Inert until used:
 * raw mode, the stdin listener, and the signal listeners engage on the
 * first read of `readable`. Cancelling the readable hands the tty back.
 */
export function transportFromProcess(
	proc: ProcessLike = process as unknown as ProcessLike,
	// The global process sits below a shell; a wrapped mock or relay owns
	// its screen unless the caller says otherwise.
	options: {sharesScreen?: boolean} = {},
): TerminalTransport {
	const sharesScreen =
		options.sharesScreen ?? proc === (process as unknown as ProcessLike);
	let closedResolve!: (info: TerminalCloseInfo) => void;
	const closed = new Promise<TerminalCloseInfo>((resolve) => {
		closedResolve = resolve;
	});

	let engaged = false;
	let dataListener:
		((chunk: string | Uint8Array | ArrayBuffer) => void) |
		null = null;
	const signalListeners: Array<[ProcessSignal, () => void]> = [];

	const disengage = () => {
		if (!engaged) {
			return;
		}
		engaged = false;
		undisposedProcesses.delete(proc);
		// Restore SYNCHRONOUSLY: the engine's own restores ride the writable's
		// queue, and `dispose(); process.exit()` exits before it flushes.
		// These are the modes whose survival breaks the user's shell; each is
		// idempotent, so the queued restores repeating them is harmless.
		proc.stdout.write(PANIC_RESTORE);
		if (dataListener && proc.stdin) {
			proc.stdin.removeListener?.("data", dataListener);
			dataListener = null;
		}
		const stdin = proc.stdin;
		if (stdin !== undefined) {
			stdin.setRawMode?.(false);
			stdin.pause();
		}
		for (const [signal, listener] of signalListeners) {
			proc.removeListener?.(signal, listener);
		}
		signalListeners.length = 0;
	};

	const readable = new ReadableStream<string>(
		{
			pull: (controller) => {
				if (engaged || !proc.stdin?.isTTY) {
					return;
				}
				engaged = true;

				const stdin = proc.stdin;
				stdin.setRawMode?.(true);
				stdin.resume();
				stdin.setEncoding?.("utf8");
				// Hosts without setEncoding deliver bytes; a streaming decoder
				// keeps a code point split across two chunks whole.
				const decoder = new TextDecoder();
				dataListener = (chunk: string | Uint8Array | ArrayBuffer) => {
					controller.enqueue(
						typeof chunk === "string" ?
							chunk :
								decoder.decode(chunk, {stream: true}),
					);
				};
				stdin.on("data", dataListener);

				// If the app dies without dispose, the exit hook restores the cursor.
				undisposedProcesses.add(proc);
				installCursorRestoreOnExit();

				// A SIGINT here is an external kill, never Ctrl-C -- raw mode delivers
				// that as \x03 on stdin. Resolve `closed` so the session disposes
				// (microtasks), then exit; SIGTERM/SIGHUP/exit likewise close, with
				// the process runtime handling the actual termination.
				const closeOn = (signal: ProcessSignal, exitAfter: boolean) => {
					const listener = () => {
						closedResolve({reason: signal});
						if (exitAfter) {
							setImmediate(() => proc.exit(0));
						}
					};
					signalListeners.push([signal, listener]);
					proc.on(signal, listener);
				};
				closeOn("SIGINT", true);
				closeOn("SIGTERM", true);
				closeOn("SIGHUP", true);
				closeOn("exit", false);
			},
			cancel: disengage,
			// HWM 0: pull only when a read is pending. The default (1) would pull at
			// construction, engaging the tty before attach -- the exact takeover the
			// attach() contract forbids.
		},
		{highWaterMark: 0},
	);

	const writable = new WritableStream<string>({
		// Resolve on the stream's own completion callback: awaiting a write
		// means the terminal HAS the bytes (a mock's emulator has ingested
		// them, a real stdout has flushed), which is what frame ordering and
		// "await a painted frame" rest on.
		write: (chunk) =>
			new Promise<void>((resolve, reject) => {
				proc.stdout.write(chunk, "utf8", (error?: Error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			}),
	});

	let resizeListener: (() => void) | null = null;
	const resizes = new ReadableStream<TerminalSize>(
		{
			pull: (controller) => {
				if (resizeListener) {
					return;
				}
				resizeListener = () => {
					controller.enqueue({
						cols: proc.stdout.columns || 80,
						rows: proc.stdout.rows || 24,
					});
				};
				proc.on("SIGWINCH", resizeListener);
			},
			cancel: () => {
				if (resizeListener) {
					proc.removeListener?.("SIGWINCH", resizeListener);
					resizeListener = null;
				}
			},
		},
		{highWaterMark: 0},
	);

	return {
		get cols() {
			return proc.stdout.columns || 80;
		},
		get rows() {
			return proc.stdout.rows || 24;
		},
		sharesScreen,
		interactive: proc.stdout.isTTY !== false,
		colorDepth: detectColorDepth(proc),
		ready: Promise.resolve(),
		readable,
		writable,
		resizes,
		closed,
		close(info?: TerminalCloseInfo) {
			disengage();
			proc.exit(info?.status ?? 0);
		},
	};
}
