import type {LayoutEngine} from "./layout.js";
import type {Viewport} from "./viewport.js";
import type {ColorDepth, WidthMeasurer} from "./ansi.js";
import {recordClusterAdvance} from "./text.js";
import {tokenizeInput} from "./events.js";

const kWidthSettled = Symbol("widthSettled");
const kWidthProbes = Symbol("widthProbes");
const kWriteEpoch = Symbol("writeEpoch");
const kDsrSequence = Symbol("dsrSequence");
const kArmWidthProbeTimer = Symbol("armWidthProbeTimer");
const kWidthProbeTimer = Symbol("widthProbeTimer");
const kWIdTH_PROBE_TIMEOUT_MS = Symbol("WIDTH_PROBE_TIMEOUT_MS");
const kWidthAnswered = Symbol("widthAnswered");
const kWidthProbing = Symbol("widthProbing");
const kInteractive = Symbol("interactive");
const kGraphemeClustersNegotiated = Symbol("graphemeClustersNegotiated");
const kWidthMeasurer = Symbol("widthMeasurer");
const kWidthRunEpoch = Symbol("widthRunEpoch");
const kWidthRun = Symbol("widthRun");
const kWidthDrift = Symbol("widthDrift");
const kWidthRunLost = Symbol("widthRunLost");
const kLayout = Symbol("layout");
const kHandlers = Symbol("handlers");
const kTransport = Symbol("transport");
const kViewport = Symbol("viewport");
const kAnchorDetectionEnabled = Symbol("anchorDetectionEnabled");
const kHasDetectedCommandStart = Symbol("hasDetectedCommandStart");
const kDisposed = Symbol("disposed");
const kWriter = Symbol("writer");
const kLastWrite = Symbol("lastWrite");
const kStarted = Symbol("started");
const kReader = Symbol("reader");
const kReadLoop = Symbol("readLoop");
const kResizeReader = Symbol("resizeReader");
const kResizeLoop = Symbol("resizeLoop");
const kPartialEscape = Symbol("partialEscape");
const kRoute = Symbol("route");
const kPasteBuffer = Symbol("pasteBuffer");
const kFeedModeReport = Symbol("feedModeReport");
const kFeedCursorReport = Symbol("feedCursorReport");
const kModeProbeHandlers = Symbol("modeProbeHandlers");
const kCursorDetectionHandler = Symbol("cursorDetectionHandler");
const kCursorDetectionSequence = Symbol("cursorDetectionSequence");
const kSettleWidthProbe = Symbol("settleWidthProbe");
const kCursorDetectionPromise = Symbol("cursorDetectionPromise");
const kModeProbeTimers = Symbol("modeProbeTimers");
const kProbeMode = Symbol("probeMode");
const kPriorBidiMode = Symbol("priorBidiMode");
const kCursorDetectionTimer = Symbol("cursorDetectionTimer");

/**
 * The wire between the engine and a terminal: an established session as
 * duplex streams plus lifecycle, the common subset of WebTransport and
 * WebSocketStream. Everything Node-flavored -- raw mode, signals, env
 * sniffing -- belongs inside a wrapper, never in this contract.
 */
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

/**
 * The length of an incomplete escape sequence at the end of `chunk`, or 0.
 * Incomplete means a CSI (ESC [) whose final byte (0x40-0x7e) has not
 * arrived, or an SS3 (ESC O) missing its one final character. A bare
 * trailing ESC reports 0: see #partialEscape.
 */
function splitTrailingEscape(chunk: string): number {
	const esc = chunk.lastIndexOf("\x1b");
	if (esc === -1 || esc === chunk.length - 1) {
		return 0;
	}
	const kind = chunk[esc + 1];
	if (kind === "[") {
		for (let i = esc + 2; i < chunk.length; i++) {
			const code = chunk.charCodeAt(i);
			if (code >= 0x40 && code <= 0x7e) {
				return 0;
			} // finished
		}
		return chunk.length - esc;
	}
	if (kind === "O" && esc + 2 >= chunk.length) {
		return chunk.length - esc;
	}
	return 0;
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
				// Mouse capture off, cursor back on, bracketed paste off.
				proc.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?25h\x1b[?2004l");
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
		| ((chunk: string | Uint8Array | ArrayBuffer) => void) |
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
		proc.stdout.write("[?1006l[?1002l[?25h[?2004l[23;0t");
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
 * The query half is the old TerminalProbe: round-trips the engine cannot have
 * synchronously. A DSR cursor query locates the command-start row so the
 * painted region anchors correctly; DECRQM queries settle capabilities the
 * renderer's contract depends on (explicit bidi, grapheme-cluster widths).
 * Answers may never come -- most terminals implement no such modes -- so every
 * query is bounded by a timer, and silence is a valid answer meaning "no
 * opinion, ours stands". Every timer is tracked so dispose() can clear it; a
 * live one keeps the event loop open, which across a test suite is fatal.
 */
interface TerminalSessionHandlers {
	/** Decoded non-mouse input: batched keystrokes after the demux. */
	onKeys(keyInput: string): void;
	onMouse(button: number, x: number, y: number, release: boolean): void;
	onPaste(text: string): void;
	onResize(size: TerminalSize): void;
	/** Ctrl-C with no listener claiming it: the default action is window.close(). */
	onCloseRequest(): void;
	/**
	 * The terminal reported an advance the width tables did not predict. Every
	 * width answered so far may have been answered wrongly, so the rows holding
	 * that cluster need repainting against the corrected measurement.
	 */
	onWidthCorrection(): void;
	/** The transport's `closed` settled: the terminal is gone. */
	onClosed(info: TerminalCloseInfo): void;
}

export class TerminalSession {
	declare [kTransport]: TerminalTransport;
	declare [kViewport]: Viewport;
	declare [kLayout]: LayoutEngine;
	declare [kInteractive]: boolean;
	declare [kAnchorDetectionEnabled]: boolean;
	declare [kHandlers]: TerminalSessionHandlers;

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
	declare [kWidthProbes]: Array<{
		cluster: string;
		run: number;
		epoch: number;
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
	/** Whether frames may still probe. */
	declare [kWidthProbing]: boolean;
	/** Whether the terminal has ever answered a width probe. */
	declare [kWidthAnswered]: boolean;
	declare [kWidthProbeTimer]: ReturnType<typeof setTimeout> | null;
	// The emission run the running divergence belongs to, and the divergence
	// itself: within one run each cluster's cells are reached by advancing
	// through the ones before it, so an earlier miscount displaces every column
	// after it by exactly this much. A reading that cannot be believed leaves
	// the drift unknown, and the rest of that run unreadable with it.
	declare [kWidthRunEpoch]: number;
	declare [kWidthRun]: number;
	declare [kWidthDrift]: number;
	declare [kWidthRunLost]: boolean;
	// Bumped by every write, so probes taken while building one frame are told
	// apart from probes taken while building the next.
	declare [kWriteEpoch]: number;
	/**
	 * Generous: the reply crosses whatever the transport is, and a terminal
	 * answering late is still answering. Only a session that gets NOTHING back
	 * gives up probing, and it can afford to wait to be sure.
	 */
	static readonly [kWIdTH_PROBE_TIMEOUT_MS] = 2000;

	declare [kWidthMeasurer]: WidthMeasurer;

	/**
	 * Keep a deadline running for as long as any probe is outstanding, timed
	 * from the oldest of them.
	 */
	[kArmWidthProbeTimer](): void {
		if (this[kWidthProbeTimer] !== null) {
			return;
		}
		const oldest = this[kWidthProbes][0];
		if (oldest === undefined) {
			return;
		}
		const remaining = Math.max(
			0,
			oldest.sentAt + TerminalSession[kWIdTH_PROBE_TIMEOUT_MS] - Date.now(),
		);
		this[kWidthProbeTimer] = setTimeout(() => {
			this[kWidthProbeTimer] = null;
			// Unanswered this long is unanswered. The queue is what matches
			// replies to probes, so an abandoned probe must leave it; its
			// cluster keeps the tables' answer and is not asked again. Probes
			// written since the deadline was set are not late yet and keep
			// their place -- the deadline is per probe, and re-arms for the
			// oldest one still waiting.
			const deadline = Date.now() - TerminalSession[kWIdTH_PROBE_TIMEOUT_MS];
			let expired = 0;
			while (
				expired < this[kWidthProbes].length &&
				this[kWidthProbes][expired].sentAt <= deadline
			) {
				this[kWidthSettled].add(this[kWidthProbes][expired].cluster);
				expired++;
			}
			// Nothing has ever come back: this terminal does not answer DSR,
			// and asking it again each frame is asking forever. Fall open to
			// the tables.
			if (expired > 0 && !this[kWidthAnswered]) {
				this[kWidthProbing] = false;
				this[kWidthProbes].length = 0;
				return;
			}
			this[kWidthProbes].splice(0, expired);
			this[kArmWidthProbeTimer]();
		}, remaining);
	}

	/**
	 * The frame's channel for measuring cluster advances, or undefined where
	 * there is nothing to learn: a transport with no terminal behind it, a
	 * terminal that agreed to grapheme-cluster widths (mode 2027 makes it
	 * measure the way we do, so the tables and the screen already agree), or
	 * one that has proven it does not answer.
	 */
	get widthMeasurer(): WidthMeasurer | undefined {
		if (!this[kInteractive] || !this[kWidthProbing]) {
			return undefined;
		}
		if (this[kGraphemeClustersNegotiated]) {
			return undefined;
		}
		return this[kWidthMeasurer];
	}

	/**
	 * Settle one width probe against the column the terminal reports.
	 *
	 * The probe rode the frame that painted the cluster, so the reply's column
	 * minus the column the cluster started from IS the advance -- corrected by
	 * the drift the earlier unmeasured clusters of the same run introduced,
	 * which their own replies have just established.
	 */
	[kSettleWidthProbe](
		probe: {
			cluster: string;
			run: number;
			epoch: number;
			column: number;
			width: number;
		},
		replyColumn: number,
	): void {
		this[kWidthAnswered] = true;
		// The deadline belonged to the probe just answered; whatever is still
		// waiting gets its own.
		if (this[kWidthProbeTimer] !== null) {
			clearTimeout(this[kWidthProbeTimer]);
			this[kWidthProbeTimer] = null;
		}
		this[kArmWidthProbeTimer]();

		if (probe.epoch !== this[kWidthRunEpoch] || probe.run !== this[kWidthRun]) {
			this[kWidthRunEpoch] = probe.epoch;
			this[kWidthRun] = probe.run;
			this[kWidthDrift] = 0;
			this[kWidthRunLost] = false;
		}

		// An earlier reading in this run could not be believed, so the drift the
		// glyphs before this one introduced is unknown and its column means
		// nothing. Wait for a run whose arithmetic is whole.
		if (this[kWidthRunLost]) {
			return;
		}

		// Terminal columns are 1-based; the ledger counts cells.
		const advance = replyColumn - 1 - (probe.column + this[kWidthDrift]);
		// A reading no cluster could produce means the reply describes
		// something else -- a screen that scrolled under the frame, a terminal
		// answering out of turn. The tables keep the cluster, and the rest of
		// the run is read against a drift this reading did not establish.
		if (advance < 0 || advance > 4) {
			this[kWidthRunLost] = true;
			return;
		}

		this[kWidthSettled].add(probe.cluster);
		this[kWidthDrift] += advance - probe.width;
		if (recordClusterAdvance(probe.cluster, advance)) {
			this[kLayout].invalidateTextMeasurement();
			this[kHandlers].onWidthCorrection();
		}
	}

	constructor(deps: {
		transport: TerminalTransport;
		viewport: Viewport;
		layout: LayoutEngine;
		interactive: boolean;
		anchorDetection: boolean;
		handlers: TerminalSessionHandlers;
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
		this[kPriorBidiMode] = null;
		this[kGraphemeClustersNegotiated] = false;
		this[kDsrSequence] = 0;
		this[kCursorDetectionSequence] = 0;
		this[kWidthProbes] = [];
		this[kWidthSettled] = new Set<string>();
		this[kWidthProbing] = true;
		this[kWidthAnswered] = false;
		this[kWidthProbeTimer] = null;
		this[kWidthRunEpoch] = -1;
		this[kWidthRun] = -1;
		this[kWidthDrift] = 0;
		this[kWidthRunLost] = false;
		this[kWriteEpoch] = 0;
		this[kWidthMeasurer] = {
			wants: (cluster: string) => !this[kWidthSettled].has(cluster),
			probe: (cluster: string, run: number, column: number, width: number) => {
				this[kWidthProbes].push({
					cluster,
					run,
					epoch: this[kWriteEpoch],
					column,
					width,
					sequence: this[kDsrSequence]++,
					sentAt: Date.now(),
				});
				this[kArmWidthProbeTimer]();
				return "\x1b[6n";
			},
		};
		this[kTransport] = deps.transport;
		this[kViewport] = deps.viewport;
		this[kLayout] = deps.layout;
		this[kInteractive] = deps.interactive;
		this[kAnchorDetectionEnabled] = deps.anchorDetection && deps.interactive;
		this[kHandlers] = deps.handlers;
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
		this[kWriteEpoch]++;
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
		void this[kReadLoop](this[kReader]);

		this[kResizeReader] = this[kTransport].resizes.getReader();
		void this[kResizeLoop](this[kResizeReader]);

		void this[kTransport].closed.then((info) => {
			if (!this[kDisposed]) {
				this[kHandlers].onClosed(info);
			}
		});
	}

	async [kReadLoop](
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
				let chunk = this[kPartialEscape] + value;
				this[kPartialEscape] = "";
				const held = splitTrailingEscape(chunk);
				if (held > 0 && held <= 32) {
					this[kPartialEscape] = chunk.slice(-held);
					chunk = chunk.slice(0, -held);
				}
				if (chunk) {
					this[kRoute](chunk);
				}
			}
		} catch (_err) {
			// Reader cancelled by dispose, or the transport died; either way the
			// conversation is over and closed/dispose carry the follow-up.
		}
	}

	async [kResizeLoop](
		reader: ReadableStreamDefaultReader<TerminalSize>,
	): Promise<void> {
		try {
			for (;;) {
				const {done, value} = await reader.read();
				if (done) {
					return;
				}
				if (value) {
					this[kHandlers].onResize(value);
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
	[kRoute](dataStr: string): void {
		// Bracketed paste: its body is literal text (a pasted newline must not
		// fire Enter), buffered across chunks until ESC[201~. Checked before the
		// report routes so paste content isn't parsed as a reply.
		if (this[kPasteBuffer] !== null) {
			const end = dataStr.indexOf("\x1b[201~");
			if (end === -1) {
				this[kPasteBuffer] += dataStr;
				return;
			}
			this[kHandlers].onPaste(this[kPasteBuffer] + dataStr.slice(0, end));
			this[kPasteBuffer] = null;
			const after = dataStr.slice(end + 6);
			if (after.length) {
				this[kRoute](after);
			}
			return;
		}
		const pasteStart = dataStr.indexOf("\x1b[200~");
		if (pasteStart !== -1) {
			const before = dataStr.slice(0, pasteStart);
			if (before.length) {
				this[kRoute](before);
			}
			this[kPasteBuffer] = "";
			this[kRoute](dataStr.slice(pasteStart + 6));
			return;
		}

		// Replies (highest priority): the terminal's answer about a mode
		// (DECRPM) or the cursor position (DSR). Fast typing can land in the
		// same chunk as a report -- "jjj\x1b[12;1Rjjj" -- so hand the report to
		// the waiting query and let the rest continue through as keystrokes.
		const modeReport = dataStr.match(/\x1b\[(\??)(\d+);(\d+)\$y/);
		if (modeReport) {
			const mode = (modeReport[1] ? "?" : "") + modeReport[2];
			if (this[kFeedModeReport](mode, parseInt(modeReport[3], 10))) {
				const rest =
					dataStr.slice(0, modeReport.index) +
					dataStr.slice((modeReport.index ?? 0) + modeReport[0].length);
				if (rest.length > 0) {
					this[kRoute](rest);
				}
				return;
			}
		}

		const report = dataStr.match(/\x1b\[(\d+);(\d+)R/);
		if (report && this[kFeedCursorReport](report[0], parseInt(report[2], 10))) {
			const rest =
				dataStr.slice(0, report.index) +
				dataStr.slice((report.index ?? 0) + report[0].length);
			if (rest.length > 0) {
				this[kRoute](rest);
			}
			return;
		}

		// Ctrl-C: raw mode delivers it as data, and its default action is the
		// engine's to decide (window.close()), not this layer's.
		if (dataStr.charCodeAt(0) === 0x03) {
			this[kHandlers].onCloseRequest();
			return;
		}

		// SGR mouse reports, peeled off token by token so a report glued to
		// fast keystrokes ("jj\x1b[<65;4;7Mjj") eats neither side.
		let keyInput = "";
		for (const token of tokenizeInput(dataStr)) {
			const mouse = token.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
			if (mouse) {
				this[kHandlers].onMouse(
					parseInt(mouse[1]),
					parseInt(mouse[2]),
					parseInt(mouse[3]),
					mouse[4] === "m",
				);
			} else {
				keyInput += token;
			}
		}
		if (keyInput.length === 0) {
			return;
		}

		this[kHandlers].onKeys(keyInput);
	}

	/** Route a DECRPM mode reply to whichever negotiation is waiting on it. */
	[kFeedModeReport](mode: string, value: number): boolean {
		const waiting = this[kModeProbeHandlers].get(mode);
		if (!waiting) {
			return false;
		}
		this[kModeProbeHandlers].delete(mode);
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
	[kFeedCursorReport](report: string, column: number): boolean {
		const probe = this[kWidthProbes][0];
		if (
			this[kCursorDetectionHandler] !== null &&
			(probe === undefined || this[kCursorDetectionSequence] < probe.sequence)
		) {
			this[kCursorDetectionHandler](report);
			return true;
		}
		if (probe !== undefined) {
			this[kWidthProbes].shift();
			this[kSettleWidthProbe](probe, column);
			return true;
		}
		return false;
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
	 * Set a terminal mode and ask what it actually is now (DECRQM), resolving
	 * with the reported value -- or null if the terminal says nothing, which is
	 * the common case, since most implement no such mode and answer only the
	 * queries they know.
	 *
	 * The reply values are DECRPM's: 0 not recognised, 1 set, 2 reset, 3
	 * permanently set, 4 permanently reset. 0 and silence mean the same thing
	 * to every caller here -- the terminal has no opinion, so ours stands.
	 */
	[kProbeMode](mode: string, request: string): Promise<number | null> {
		return new Promise<number | null>((resolve) => {
			// The same second the cursor probe allows: a cold start or a slow SSH
			// link can outlast a tighter window, and answering late is answering.
			const timer = setTimeout(() => {
				this[kModeProbeTimers].delete(timer);
				this[kModeProbeHandlers].delete(mode);
				resolve(null);
			}, 1000);
			this[kModeProbeTimers].add(timer);
			this[kModeProbeHandlers].set(mode, (value: number) => {
				clearTimeout(timer);
				this[kModeProbeTimers].delete(timer);
				resolve(value);
			});
			void this.write(request);
		});
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
		const answer = await this[kProbeMode]("8", "\x1b[8l\x1b[8$p");

		if (answer === null || answer === 0) {
			return;
		} // No bidi: cells as written.
		this[kPriorBidiMode] = answer;

		// 1 = still set, 3 = permanently set. Either way it reorders regardless
		// of what we asked, so hand it text in the order it expects.
		if (answer === 1 || answer === 3) {
			this[kLayout].setTerminalReordersText(true);
		}
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
	/**
	 * A terminal that does not implement a mode report may echo the
	 * request's final byte as text. Homing and erasing the line disposes
	 * of any echo, so the first frame starts on a clean row.
	 */
	scrubProbeEcho(): void {
		if (!this[kInteractive]) {
			return;
		}
		void this.write("\r\x1b[K");
	}

	async negotiateGraphemeClusters(): Promise<void> {
		if (!this[kInteractive]) {
			return;
		}

		const answer = await this[kProbeMode]("?2027", "\x1b[?2027h\x1b[?2027$p");
		// 1 = set (it agrees now), 3 = permanently set (it always did).
		this[kGraphemeClustersNegotiated] = answer === 1 || answer === 3;
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

				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					finish();

					const row = parseInt(match[1], 10);
					// Convert 1-based terminal row to the 0-based anchor.
					const screenTop = row - 1;
					this[kViewport].screenTop = screenTop;

					// Content shifts up to the terminal top from the command start.
					this[kViewport].anchorScrollTop = -this[kViewport].screenTop;

					this[kHasDetectedCommandStart] = true;
					resolve(row);
				}
			};

			this[kCursorDetectionSequence] = this[kDsrSequence]++;
			void this.write("\x1b[6n");

			// Timeout after 1000ms. The timer is held so it can be cleared the
			// moment a response arrives --
			// otherwise it keeps the event loop alive a further second.
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
				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
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
					resolve(parseInt(match[1], 10) - 1);
				}
			};

			// Replacing a stale handler is fine: its own timeout still fires and
			// rejects it, and the caller's epoch check discards the stale result.
			this[kCursorDetectionHandler] = handler;

			this[kCursorDetectionSequence] = this[kDsrSequence]++;
			void this.write("\x1b[6n");

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

	/**
	 * Hand the terminal back the modes we changed, release the transport, and
	 * tear down every timer and handler that would otherwise keep the event
	 * loop open. Only modes we actually set are restored -- reset is where the
	 * terminal already was.
	 */
	dispose(): void {
		if (this[kDisposed]) {
			return;
		}
		this[kDisposed] = true;

		// We asked for explicit bidi on the way in; give the terminal back the
		// mode it reported, so the next command inherits its own settings rather
		// than ours. Only when it was SET -- reset is where we left it anyway.
		if (this[kPriorBidiMode] === 1) {
			void this.write("\x1b[8h");
			this[kPriorBidiMode] = null;
		}
		// Mode 2027 likewise: we turned it on, so turn it off. A terminal that
		// never had it does not see this, having answered nothing.
		if (this[kGraphemeClustersNegotiated]) {
			void this.write("\x1b[?2027l");
			this[kGraphemeClustersNegotiated] = false;
		}
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
