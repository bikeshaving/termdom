import type {LayoutEngine} from "./layout.js";
import type {Viewport} from "./viewport.js";
import type {ColorDepth, WidthMeasurer} from "./ansi.js";
import {recordClusterAdvance} from "./text.js";
import {tokenizeInput} from "./events.js";

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
			} catch {
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
		proc.stdin?.setRawMode?.(false);
		proc.stdin?.pause();
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
	#transport: TerminalTransport;
	#viewport: Viewport;
	#layout: LayoutEngine;
	#interactive: boolean;
	#anchorDetectionEnabled: boolean;
	#handlers: TerminalSessionHandlers;

	#writer: WritableStreamDefaultWriter<string> | null = null;
	#reader: ReadableStreamDefaultReader<string> | null = null;
	#resizeReader: ReadableStreamDefaultReader<TerminalSize> | null = null;
	#started = false;
	#disposed = false;
	// The last queued write, so flush() can await everything before it.
	#lastWrite: Promise<void> = Promise.resolve();

	// Body of a bracketed paste (ESC[200~..ESC[201~) across chunks; null when
	// no paste is in flight.
	#pasteBuffer: string | null = null;
	// A trailing incomplete escape sequence, held for the next chunk: network
	// transports fragment arbitrarily, and half a CSI decodes as garbage
	// keystrokes. A bare trailing ESC is NOT held -- it is the Escape key
	// far more often than a split, and holding it would delay every Escape.
	#partialEscape = "";

	// Command start was resolved (even if at row 1). The resize re-anchor saves
	// and restores this around its redraw.
	#hasDetectedCommandStart = false;
	// The pending DSR reply handler and its timeout. Cursor detection and the
	// resize re-anchor share these slots so input routing and dispose can see
	// them; overlapping queries check handler identity before clearing.
	#cursorDetectionHandler: ((data: string) => void) | null = null;
	#cursorDetectionTimer: ReturnType<typeof setTimeout> | null = null;
	// Resolves when startup command-start detection settles (or times out), so
	// the first frame waits for the anchor rather than painting at row 0 first.
	#cursorDetectionPromise: Promise<void> | null = null;

	/**
	 * Outstanding DECRQM queries, keyed by the mode as it appears in the reply
	 * ("8", "?2027"). Two negotiations run concurrently at startup and their
	 * answers can arrive in either order, so they are matched by mode number
	 * rather than by whoever asked last.
	 */
	#modeProbeHandlers = new Map<string, (value: number) => void>();
	#modeProbeTimers = new Set<ReturnType<typeof setTimeout>>();
	/** The BDSM state the terminal reported before we touched it, for dispose. */
	#priorBidiMode: number | null = null;
	/** Whether the terminal agreed to grapheme-cluster widths (mode 2027). */
	#graphemeClustersNegotiated = false;

	/**
	 * DSR queries in the order they went out. A terminal answers them in that
	 * order, so the sequence number is what keeps cursor detection and width
	 * measurement from taking each other's replies.
	 */
	#dsrSequence = 0;
	/** The sequence number of the outstanding cursor query, if any. */
	#cursorDetectionSequence = 0;
	/** Width probes written and not yet answered, oldest first. */
	#widthProbes: Array<{
		cluster: string;
		run: number;
		epoch: number;
		column: number;
		width: number;
		sequence: number;
		sentAt: number;
	}> = [];

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
	#widthSettled = new Set<string>();
	/** Whether frames may still probe. */
	#widthProbing = true;
	/** Whether the terminal has ever answered a width probe. */
	#widthAnswered = false;
	#widthProbeTimer: ReturnType<typeof setTimeout> | null = null;
	// The emission run the running divergence belongs to, and the divergence
	// itself: within one run each cluster's cells are reached by advancing
	// through the ones before it, so an earlier miscount displaces every column
	// after it by exactly this much. A reading that cannot be believed leaves
	// the drift unknown, and the rest of that run unreadable with it.
	#widthRunEpoch = -1;
	#widthRun = -1;
	#widthDrift = 0;
	#widthRunLost = false;
	// Bumped by every write, so probes taken while building one frame are told
	// apart from probes taken while building the next.
	#writeEpoch = 0;
	/**
	 * Generous: the reply crosses whatever the transport is, and a terminal
	 * answering late is still answering. Only a session that gets NOTHING back
	 * gives up probing, and it can afford to wait to be sure.
	 */
	static readonly #WIDTH_PROBE_TIMEOUT_MS = 2000;

	#widthMeasurer: WidthMeasurer = {
		wants: (cluster: string) => !this.#widthSettled.has(cluster),
		probe: (cluster: string, run: number, column: number, width: number) => {
			this.#widthProbes.push({
				cluster,
				run,
				epoch: this.#writeEpoch,
				column,
				width,
				sequence: this.#dsrSequence++,
				sentAt: Date.now(),
			});
			this.#armWidthProbeTimer();
			return "\x1b[6n";
		},
	};

	/**
	 * Keep a deadline running for as long as any probe is outstanding, timed
	 * from the oldest of them.
	 */
	#armWidthProbeTimer(): void {
		if (this.#widthProbeTimer !== null) {
			return;
		}
		const oldest = this.#widthProbes[0];
		if (oldest === undefined) {
			return;
		}
		const remaining = Math.max(
			0,
			oldest.sentAt + TerminalSession.#WIDTH_PROBE_TIMEOUT_MS - Date.now(),
		);
		this.#widthProbeTimer = setTimeout(() => {
			this.#widthProbeTimer = null;
			// Unanswered this long is unanswered. The queue is what matches
			// replies to probes, so an abandoned probe must leave it; its
			// cluster keeps the tables' answer and is not asked again. Probes
			// written since the deadline was set are not late yet and keep
			// their place -- the deadline is per probe, and re-arms for the
			// oldest one still waiting.
			const deadline = Date.now() - TerminalSession.#WIDTH_PROBE_TIMEOUT_MS;
			let expired = 0;
			while (
				expired < this.#widthProbes.length &&
				this.#widthProbes[expired].sentAt <= deadline
			) {
				this.#widthSettled.add(this.#widthProbes[expired].cluster);
				expired++;
			}
			// Nothing has ever come back: this terminal does not answer DSR,
			// and asking it again each frame is asking forever. Fall open to
			// the tables.
			if (expired > 0 && !this.#widthAnswered) {
				this.#widthProbing = false;
				this.#widthProbes.length = 0;
				return;
			}
			this.#widthProbes.splice(0, expired);
			this.#armWidthProbeTimer();
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
		if (!this.#interactive || !this.#widthProbing) {
			return undefined;
		}
		if (this.#graphemeClustersNegotiated) {
			return undefined;
		}
		return this.#widthMeasurer;
	}

	/**
	 * Settle one width probe against the column the terminal reports.
	 *
	 * The probe rode the frame that painted the cluster, so the reply's column
	 * minus the column the cluster started from IS the advance -- corrected by
	 * the drift the earlier unmeasured clusters of the same run introduced,
	 * which their own replies have just established.
	 */
	#settleWidthProbe(
		probe: {
			cluster: string;
			run: number;
			epoch: number;
			column: number;
			width: number;
		},
		replyColumn: number,
	): void {
		this.#widthAnswered = true;
		// The deadline belonged to the probe just answered; whatever is still
		// waiting gets its own.
		if (this.#widthProbeTimer !== null) {
			clearTimeout(this.#widthProbeTimer);
			this.#widthProbeTimer = null;
		}
		this.#armWidthProbeTimer();

		if (probe.epoch !== this.#widthRunEpoch || probe.run !== this.#widthRun) {
			this.#widthRunEpoch = probe.epoch;
			this.#widthRun = probe.run;
			this.#widthDrift = 0;
			this.#widthRunLost = false;
		}

		// An earlier reading in this run could not be believed, so the drift the
		// glyphs before this one introduced is unknown and its column means
		// nothing. Wait for a run whose arithmetic is whole.
		if (this.#widthRunLost) {
			return;
		}

		// Terminal columns are 1-based; the ledger counts cells.
		const advance = replyColumn - 1 - (probe.column + this.#widthDrift);
		// A reading no cluster could produce means the reply describes
		// something else -- a screen that scrolled under the frame, a terminal
		// answering out of turn. The tables keep the cluster, and the rest of
		// the run is read against a drift this reading did not establish.
		if (advance < 0 || advance > 4) {
			this.#widthRunLost = true;
			return;
		}

		this.#widthSettled.add(probe.cluster);
		this.#widthDrift += advance - probe.width;
		if (recordClusterAdvance(probe.cluster, advance)) {
			this.#layout.invalidateTextMeasurement();
			this.#handlers.onWidthCorrection();
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
		this.#transport = deps.transport;
		this.#viewport = deps.viewport;
		this.#layout = deps.layout;
		this.#interactive = deps.interactive;
		this.#anchorDetectionEnabled = deps.anchorDetection && deps.interactive;
		this.#handlers = deps.handlers;
	}

	/** Whether command-start anchoring runs: the default process transport only. */
	get anchorDetectionEnabled(): boolean {
		return this.#anchorDetectionEnabled;
	}

	/**
	 * Whether command start was resolved. The resize re-anchor saves this,
	 * clears it across its redraw so the frame is placed by the screen reset
	 * rather than a stale detection, then restores it.
	 */
	get hasDetectedCommandStart(): boolean {
		return this.#hasDetectedCommandStart;
	}

	set hasDetectedCommandStart(value: boolean) {
		this.#hasDetectedCommandStart = value;
	}

	/**
	 * Queue output on the transport, in order. The writer engages lazily on
	 * the first write. Returns the chunk's flush promise; flush() awaits the
	 * queue's tail.
	 */
	write(output: string): Promise<void> {
		// Probes are taken while a frame is being built and go out with it, so
		// each write ends the batch that can share a drift correction.
		this.#writeEpoch++;
		// A disposed session has released the wire; late writes are dropped.
		if (this.#disposed && !this.#writer) {
			return Promise.resolve();
		}
		if (!this.#writer) {
			this.#writer = this.#transport.writable.getWriter();
		}
		this.#lastWrite = this.#writer.write(output).catch(() => {
			// A transport torn down mid-write (disconnect) is a close, not a
			// crash; the closed promise carries the real signal.
		});
		return this.#lastWrite;
	}

	/** Resolves when everything written so far has reached the transport. */
	flush(): Promise<void> {
		return this.#lastWrite;
	}

	/**
	 * Begin the conversation: acquire the readers and route input, resizes and
	 * closure to the engine's handlers. Idempotent.
	 */
	start(): void {
		if (this.#started) {
			return;
		}
		this.#started = true;

		this.#reader = this.#transport.readable.getReader();
		void this.#readLoop(this.#reader);

		this.#resizeReader = this.#transport.resizes.getReader();
		void this.#resizeLoop(this.#resizeReader);

		void this.#transport.closed.then((info) => {
			if (!this.#disposed) {
				this.#handlers.onClosed(info);
			}
		});
	}

	async #readLoop(reader: ReadableStreamDefaultReader<string>): Promise<void> {
		try {
			for (;;) {
				const {done, value} = await reader.read();
				if (done) {
					return;
				}
				if (!value) {
					continue;
				}
				let chunk = this.#partialEscape + value;
				this.#partialEscape = "";
				const held = splitTrailingEscape(chunk);
				if (held > 0 && held <= 32) {
					this.#partialEscape = chunk.slice(-held);
					chunk = chunk.slice(0, -held);
				}
				if (chunk) {
					this.#route(chunk);
				}
			}
		} catch {
			// Reader cancelled by dispose, or the transport died; either way the
			// conversation is over and closed/dispose carry the follow-up.
		}
	}

	async #resizeLoop(
		reader: ReadableStreamDefaultReader<TerminalSize>,
	): Promise<void> {
		try {
			for (;;) {
				const {done, value} = await reader.read();
				if (done) {
					return;
				}
				if (value) {
					this.#handlers.onResize(value);
				}
			}
		} catch {
			// As above: teardown, not error.
		}
	}

	/**
	 * The demultiplexer. One route table for everything the wire carries, in
	 * priority order; re-entered with the remainder whenever a reply or paste
	 * fence is spliced out of a chunk that also holds real typing.
	 */
	#route(dataStr: string): void {
		// Bracketed paste: its body is literal text (a pasted newline must not
		// fire Enter), buffered across chunks until ESC[201~. Checked before the
		// report routes so paste content isn't parsed as a reply.
		if (this.#pasteBuffer !== null) {
			const end = dataStr.indexOf("\x1b[201~");
			if (end === -1) {
				this.#pasteBuffer += dataStr;
				return;
			}
			this.#handlers.onPaste(this.#pasteBuffer + dataStr.slice(0, end));
			this.#pasteBuffer = null;
			const after = dataStr.slice(end + 6);
			if (after.length) {
				this.#route(after);
			}
			return;
		}
		const pasteStart = dataStr.indexOf("\x1b[200~");
		if (pasteStart !== -1) {
			const before = dataStr.slice(0, pasteStart);
			if (before.length) {
				this.#route(before);
			}
			this.#pasteBuffer = "";
			this.#route(dataStr.slice(pasteStart + 6));
			return;
		}

		// Replies (highest priority): the terminal's answer about a mode
		// (DECRPM) or the cursor position (DSR). Fast typing can land in the
		// same chunk as a report -- "jjj\x1b[12;1Rjjj" -- so hand the report to
		// the waiting query and let the rest continue through as keystrokes.
		const modeReport = dataStr.match(/\x1b\[(\??)(\d+);(\d+)\$y/);
		if (modeReport) {
			const mode = (modeReport[1] ? "?" : "") + modeReport[2];
			if (this.#feedModeReport(mode, parseInt(modeReport[3], 10))) {
				const rest =
					dataStr.slice(0, modeReport.index) +
					dataStr.slice((modeReport.index ?? 0) + modeReport[0].length);
				if (rest.length > 0) {
					this.#route(rest);
				}
				return;
			}
		}

		const report = dataStr.match(/\x1b\[(\d+);(\d+)R/);
		if (report && this.#feedCursorReport(report[0], parseInt(report[2], 10))) {
			const rest =
				dataStr.slice(0, report.index) +
				dataStr.slice((report.index ?? 0) + report[0].length);
			if (rest.length > 0) {
				this.#route(rest);
			}
			return;
		}

		// Ctrl-C: raw mode delivers it as data, and its default action is the
		// engine's to decide (window.close()), not this layer's.
		if (dataStr.charCodeAt(0) === 0x03) {
			this.#handlers.onCloseRequest();
			return;
		}

		// SGR mouse reports, peeled off token by token so a report glued to
		// fast keystrokes ("jj\x1b[<65;4;7Mjj") eats neither side.
		let keyInput = "";
		for (const token of tokenizeInput(dataStr)) {
			const mouse = token.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
			if (mouse) {
				this.#handlers.onMouse(
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

		this.#handlers.onKeys(keyInput);
	}

	/** Route a DECRPM mode reply to whichever negotiation is waiting on it. */
	#feedModeReport(mode: string, value: number): boolean {
		const waiting = this.#modeProbeHandlers.get(mode);
		if (!waiting) {
			return false;
		}
		this.#modeProbeHandlers.delete(mode);
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
	#feedCursorReport(report: string, column: number): boolean {
		const probe = this.#widthProbes[0];
		if (
			this.#cursorDetectionHandler !== null &&
			(probe === undefined || this.#cursorDetectionSequence < probe.sequence)
		) {
			this.#cursorDetectionHandler(report);
			return true;
		}
		if (probe !== undefined) {
			this.#widthProbes.shift();
			this.#settleWidthProbe(probe, column);
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
		return this.#cursorDetectionPromise;
	}

	/** Startup command-start detection, awaited by the first frame's anchor. */
	initializeCursorDetection(): void {
		this.#cursorDetectionPromise = null;
		if (this.#anchorDetectionEnabled) {
			this.#cursorDetectionPromise = Promise.race([
				this.detectCommandStart().then(() => {}),
				// Fallback: if cursor detection takes too long, proceed without it.
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					this.#hasDetectedCommandStart = false;
				})
				.finally(() => {
					// Clear the promise so subsequent renders don't wait.
					this.#cursorDetectionPromise = null;
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
	#probeMode(mode: string, request: string): Promise<number | null> {
		return new Promise<number | null>((resolve) => {
			// The same second the cursor probe allows: a cold start or a slow SSH
			// link can outlast a tighter window, and answering late is answering.
			const timer = setTimeout(() => {
				this.#modeProbeTimers.delete(timer);
				this.#modeProbeHandlers.delete(mode);
				resolve(null);
			}, 1000);
			this.#modeProbeTimers.add(timer);
			this.#modeProbeHandlers.set(mode, (value: number) => {
				clearTimeout(timer);
				this.#modeProbeTimers.delete(timer);
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
		if (!this.#interactive) {
			return;
		}

		// Explicit mode, then "what is mode 8 now?" in one write.
		const answer = await this.#probeMode("8", "\x1b[8l\x1b[8$p");

		if (answer === null || answer === 0) {
			return;
		} // No bidi: cells as written.
		this.#priorBidiMode = answer;

		// 1 = still set, 3 = permanently set. Either way it reorders regardless
		// of what we asked, so hand it text in the order it expects.
		if (answer === 1 || answer === 3) {
			this.#layout.setTerminalReordersText(true);
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
		if (!this.#interactive) {
			return;
		}
		void this.write("\r\x1b[K");
	}

	async negotiateGraphemeClusters(): Promise<void> {
		if (!this.#interactive) {
			return;
		}

		const answer = await this.#probeMode("?2027", "\x1b[?2027h\x1b[?2027$p");
		// 1 = set (it agrees now), 3 = permanently set (it always did).
		this.#graphemeClustersNegotiated = answer === 1 || answer === 3;
	}

	/**
	 * Detect the current cursor position and set the viewport's command-start
	 * anchor. Sends DSR (`ESC[6n`) and waits for the `ESC[row;colR` reply.
	 */
	detectCommandStart(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this.#interactive) {
				reject(new Error("Cannot detect cursor position: not interactive"));
				return;
			}

			let responseBuffer = "";

			const finish = () => {
				this.#cursorDetectionHandler = null;
				if (this.#cursorDetectionTimer !== null) {
					clearTimeout(this.#cursorDetectionTimer);
					this.#cursorDetectionTimer = null;
				}
			};

			this.#cursorDetectionHandler = (dataStr: string) => {
				responseBuffer += dataStr;

				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					finish();

					const row = parseInt(match[1], 10);
					// Convert 1-based terminal row to the 0-based anchor.
					const screenTop = row - 1;
					this.#viewport.screenTop = screenTop;

					// Content shifts up to the terminal top from the command start.
					this.#viewport.anchorScrollTop = -this.#viewport.screenTop;

					this.#hasDetectedCommandStart = true;
					resolve(row);
				}
			};

			this.#cursorDetectionSequence = this.#dsrSequence++;
			void this.write("\x1b[6n");

			// Timeout after 1000ms. The timer is held so it can be cleared the
			// moment a response arrives --
			// otherwise it keeps the event loop alive a further second.
			this.#cursorDetectionTimer = setTimeout(() => {
				this.#cursorDetectionTimer = null;
				if (this.#cursorDetectionHandler) {
					this.#cursorDetectionHandler = null;
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
			if (!this.#interactive) {
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
					if (this.#cursorDetectionHandler === handler) {
						this.#cursorDetectionHandler = null;
					}
					if (localTimer !== null) {
						clearTimeout(localTimer);
						if (this.#cursorDetectionTimer === localTimer) {
							this.#cursorDetectionTimer = null;
						}
						localTimer = null;
					}
					resolve(parseInt(match[1], 10) - 1);
				}
			};

			// Replacing a stale handler is fine: its own timeout still fires and
			// rejects it, and the caller's epoch check discards the stale result.
			this.#cursorDetectionHandler = handler;

			this.#cursorDetectionSequence = this.#dsrSequence++;
			void this.write("\x1b[6n");

			// Short timeout: the redraw should feel immediate, and a terminal
			// that does not answer promptly falls back to the computed re-anchor.
			localTimer = setTimeout(() => {
				if (this.#cursorDetectionHandler === handler) {
					this.#cursorDetectionHandler = null;
				}
				if (this.#cursorDetectionTimer === localTimer) {
					this.#cursorDetectionTimer = null;
				}
				localTimer = null;
				reject(new Error("Timeout waiting for cursor position response"));
			}, 200);
			this.#cursorDetectionTimer = localTimer;
		});
	}

	/**
	 * Hand the terminal back the modes we changed, release the transport, and
	 * tear down every timer and handler that would otherwise keep the event
	 * loop open. Only modes we actually set are restored -- reset is where the
	 * terminal already was.
	 */
	dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;

		// We asked for explicit bidi on the way in; give the terminal back the
		// mode it reported, so the next command inherits its own settings rather
		// than ours. Only when it was SET -- reset is where we left it anyway.
		if (this.#priorBidiMode === 1) {
			void this.write("\x1b[8h");
			this.#priorBidiMode = null;
		}
		// Mode 2027 likewise: we turned it on, so turn it off. A terminal that
		// never had it does not see this, having answered nothing.
		if (this.#graphemeClustersNegotiated) {
			void this.write("\x1b[?2027l");
			this.#graphemeClustersNegotiated = false;
		}
		for (const timer of this.#modeProbeTimers) {
			clearTimeout(timer);
		}
		this.#modeProbeTimers.clear();
		this.#modeProbeHandlers.clear();
		if (this.#cursorDetectionTimer !== null) {
			clearTimeout(this.#cursorDetectionTimer);
			this.#cursorDetectionTimer = null;
		}
		this.#cursorDetectionHandler = null;
		if (this.#widthProbeTimer !== null) {
			clearTimeout(this.#widthProbeTimer);
			this.#widthProbeTimer = null;
		}
		this.#widthProbes.length = 0;
		this.#widthProbing = false;

		// Release the wire: cancelling the readable is what hands a process
		// transport its tty back (raw mode off, stdin paused). The writer is
		// released after the restores above have been queued on it.
		if (this.#reader) {
			void this.#reader.cancel().catch(() => {});
			this.#reader = null;
		}
		if (this.#resizeReader) {
			void this.#resizeReader.cancel().catch(() => {});
			this.#resizeReader = null;
		}
		if (this.#writer) {
			const writer = this.#writer;
			this.#writer = null;
			void this.#lastWrite.then(() => writer.releaseLock());
		}
	}
}
