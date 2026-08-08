import {type LayoutEngine} from "./layout.js";
import {type Viewport} from "./viewport.js";
import {type ColorDepth} from "./ansi.js";
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
	/** Exit status; the process wrapper hands it to process.exit. */
	code?: number;
	reason?: string;
}

export interface TerminalTransport {
	/** Geometry now; changes arrive on `resizes`. */
	readonly cols: number;
	readonly rows: number;
	/** Absent means full color: a transport that knows less says so. */
	colorDepth?: ColorDepth;
	/** User input: keys, replies to queries, paste bursts -- one byte stream. */
	readonly readable: ReadableStream<string>;
	/** Frames out. */
	readonly writable: WritableStream<string>;
	readonly resizes?: ReadableStream<TerminalSize>;
	/**
	 * The screen holds prior content the app must not paint over (a shell
	 * prompt above), so rendering anchors at the cursor rather than row 0.
	 * Absent means the engine decides: true for the defaulted process
	 * transport, false for injected ones, which own their screen.
	 */
	readonly sharesScreen?: boolean;
	/**
	 * Whether the far end is a screen that interprets cursor movement.
	 * Absent means true -- xterm.js and SSH ptys always are; the process
	 * wrapper reports false when stdout is a pipe, and rendering degrades to
	 * plain appended lines.
	 */
	readonly interactive?: boolean;
	/** The terminal went away: hangup, disconnect, process exit. */
	readonly closed: Promise<TerminalCloseInfo | void>;
	/** The app is done with the terminal (window.close()'s last act). */
	close?(info?: TerminalCloseInfo): void;
}

// The Node process shape the default wrapper consumes. The engine itself
// never touches these: they exist so `transportFromProcess` can be typed
// against exactly the members it reads, and so tests can hand it mocks.
export interface TTYWriteStream {
	write(
		chunk: any,
		encoding?: BufferEncoding | ((error?: Error) => void),
		callback?: (error?: Error) => void,
	): boolean;
	columns: number;
	rows: number;
	isTTY: boolean;
}

export interface TTYReadStream {
	isTTY: boolean;
	on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
	removeListener?(
		event: "data",
		listener: (chunk: string | Buffer) => void,
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
	if (exitHookInstalled) return;
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
	options: {sharesScreen?: boolean} = {},
): TerminalTransport {
	let closedResolve!: (info: TerminalCloseInfo | void) => void;
	const closed = new Promise<TerminalCloseInfo | void>((resolve) => {
		closedResolve = resolve;
	});

	let engaged = false;
	let dataListener: ((chunk: string | Buffer) => void) | null = null;
	const signalListeners: Array<[ProcessSignal, () => void]> = [];

	const disengage = () => {
		if (!engaged) return;
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
				if (engaged || !proc.stdin?.isTTY) return;
				engaged = true;

				const stdin = proc.stdin;
				stdin.setRawMode?.(true);
				stdin.resume();
				stdin.setEncoding?.("utf8");
				dataListener = (chunk: string | Buffer) => {
					controller.enqueue(
						typeof chunk === "string" ? chunk : chunk.toString("utf8"),
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
						closedResolve(undefined);
						if (exitAfter) setImmediate(() => proc.exit(0));
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
					if (error) reject(error);
					else resolve();
				});
			}),
	});

	let resizeListener: (() => void) | null = null;
	const resizes = new ReadableStream<TerminalSize>(
		{
			pull: (controller) => {
				if (resizeListener) return;
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
		sharesScreen: options.sharesScreen,
		interactive: proc.stdout.isTTY !== false,
		colorDepth: detectColorDepth(proc),
		readable,
		writable,
		resizes,
		closed,
		close(info?: TerminalCloseInfo) {
			disengage();
			proc.exit(info?.code ?? 0);
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
export interface TerminalSessionHandlers {
	/** Decoded non-mouse input: batched keystrokes after the demux. */
	onKeys(keyInput: string): void;
	onMouse(button: number, x: number, y: number, release: boolean): void;
	onPaste(text: string): void;
	onResize(size: TerminalSize): void;
	/** Ctrl-C with no listener claiming it: the default action is window.close(). */
	onCloseRequest(): void;
	/** The transport's `closed` settled: the terminal is gone. */
	onClosed(info: TerminalCloseInfo | void): void;
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
		// A disposed session has released the wire; late writes are dropped.
		if (this.#disposed && !this.#writer) return Promise.resolve();
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
		if (this.#started) return;
		this.#started = true;

		this.#reader = this.#transport.readable.getReader();
		void this.#readLoop(this.#reader);

		if (this.#transport.resizes) {
			this.#resizeReader = this.#transport.resizes.getReader();
			void this.#resizeLoop(this.#resizeReader);
		}

		void this.#transport.closed.then((info) => {
			if (!this.#disposed) this.#handlers.onClosed(info);
		});
	}

	async #readLoop(reader: ReadableStreamDefaultReader<string>): Promise<void> {
		try {
			for (;;) {
				const {done, value} = await reader.read();
				if (done) return;
				if (value) this.#route(value);
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
				if (done) return;
				if (value) this.#handlers.onResize(value);
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
			if (after.length) this.#route(after);
			return;
		}
		const pasteStart = dataStr.indexOf("\x1b[200~");
		if (pasteStart !== -1) {
			const before = dataStr.slice(0, pasteStart);
			if (before.length) this.#route(before);
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
				if (rest.length > 0) this.#route(rest);
				return;
			}
		}

		const report = dataStr.match(/\x1b\[\d+;\d+R/);
		if (report && this.#feedCursorReport(report[0])) {
			const rest =
				dataStr.slice(0, report.index) +
				dataStr.slice((report.index ?? 0) + report[0].length);
			if (rest.length > 0) this.#route(rest);
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
		if (keyInput.length === 0) return;

		this.#handlers.onKeys(keyInput);
	}

	/** Route a DECRPM mode reply to whichever negotiation is waiting on it. */
	#feedModeReport(mode: string, value: number): boolean {
		const waiting = this.#modeProbeHandlers.get(mode);
		if (!waiting) return false;
		this.#modeProbeHandlers.delete(mode);
		waiting(value);
		return true;
	}

	/** Route a DSR cursor-position reply to the pending detection or query. */
	#feedCursorReport(report: string): boolean {
		if (!this.#cursorDetectionHandler) return false;
		this.#cursorDetectionHandler(report);
		return true;
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
		if (!this.#interactive) return;

		// Explicit mode, then "what is mode 8 now?" in one write.
		const answer = await this.#probeMode("8", "\x1b[8l\x1b[8$p");

		if (answer === null || answer === 0) return; // No bidi: cells as written.
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
	async negotiateGraphemeClusters(): Promise<void> {
		if (!this.#interactive) return;

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

			void this.write("\x1b[6n");

			// Timeout after 1000ms (reasonable balance for reliability). The
			// timer is held so it can be cleared the moment a response arrives --
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
		if (this.#disposed) return;
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
		for (const timer of this.#modeProbeTimers) clearTimeout(timer);
		this.#modeProbeTimers.clear();
		this.#modeProbeHandlers.clear();
		if (this.#cursorDetectionTimer !== null) {
			clearTimeout(this.#cursorDetectionTimer);
			this.#cursorDetectionTimer = null;
		}
		this.#cursorDetectionHandler = null;

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
