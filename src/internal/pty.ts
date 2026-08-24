/**
 * The process transport: a Node-process-shaped object wrapped as the
 * TerminalTransport an exchange talks over. Raw mode, the stdin listener,
 * the signal handlers and the terminal's color depth live here, so the
 * exchange itself stays free of Node.
 */

import {
	PANIC_RESTORE,
	type TerminalCloseInfo,
	type TerminalSize,
	type TerminalTransport,
} from "./exchange.js";
import type {ColorDepth} from "./color.js";

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
