/**
 * The debugging seam: what the pipeline reports about itself, and the guard
 * that keeps a reporter's failure out of the frame.
 *
 * The variants are the funnels the engine already has -- the render loop's
 * outcomes, the demultiplexer's decoded items, the mode ledger, the terminal
 * size, the lifecycle, and the writes themselves -- so a log answers "what
 * did the engine do" without a terminal attached to watch. Nothing here does
 * I/O: the callback decides what an event is worth.
 *
 * Cost when nobody is listening is one optional call per site. An optional
 * call short-circuits its arguments, so the event object of a disabled trace
 * is never built.
 */

/** Where an instance stands with the terminal. See TermDOM's Lifecycle. */
export type TraceLifecycle =
	"detached" | "attaching" | "attached" | "disposed";

/**
 * Why a frame painted nothing. Each is one of the render loop's own early
 * returns: the terminal is not ours yet, a resize is settling, a screen
 * switch is straddling, a render in flight folded this one in, the instance
 * is torn down, or the frame journal says the screen already shows this.
 */
export type TraceSkipReason =
	"detached" |
	"resizing" |
	"screen-switching" |
	"coalesced" |
	"disposed" |
	"unchanged";

/**
 * One thing the engine did. `type` names the variant and the rest is the
 * fact, as plain data -- no formatting, no serialization, nothing the
 * consumer has to parse back out of a string.
 */
export type TraceEvent =
	/** The lifecycle moved: attach begins and lands, dispose ends it. */
	{type: "lifecycle"; from: TraceLifecycle; to: TraceLifecycle} |
	/** document.close() paid the live region out into the scrollback. */
	{type: "document.sealed"} |
	/** A new terminal size was adopted, from a SIGWINCH or a rebind. */
	{type: "terminal.resized"; cols: number; rows: number} |
	/** A render painted nothing, for one of the loop's own reasons. */
	{type: "frame.skipped"; reason: TraceSkipReason} |
	/** A frame diffed and patched its region with no terminal-side shift. */
	{type: "frame.repainted"; rows: number; bytes: number} |
	/**
	 * A frame rode a shift the terminal made for it: the camera's rows, or a
	 * scroll box's band between the buffer rows `top` and `end`.
	 */
	{
		type: "frame.transformed";
		delta: number;
		band: {top: number; end: number} | null;
		bytes: number;
	} |
	/** Bytes queued on the transport. `text` rides only under traceBytes. */
	{type: "wire.write"; bytes: number; text?: string} |
	/** A mode of the ledger was set on the terminal. */
	{type: "mode.engaged"; mode: string} |
	/** A mode of the ledger was handed back. */
	{type: "mode.reset"; mode: string} |
	/** Keystrokes, as the demultiplexer batched them. */
	{type: "input.keys"; keys: string} |
	/** One decoded SGR mouse report, in 1-based terminal cells. */
	{
		type: "input.mouse";
		button: number;
		x: number;
		y: number;
		release: boolean;
	} |
	/** A bracketed paste, whole. `text` rides only under traceBytes. */
	{type: "input.paste"; length: number; text?: string} |
	/** Ctrl-C reached the engine with nothing claiming it. */
	{type: "input.closeRequest"} |
	/** The anchor query answered: the 0-based row the region starts at. */
	{type: "input.commandStart"; row: number};

/** What a TermDOM reports its events to. */
export type Trace = (event: TraceEvent) => void;

/**
 * Wrap a caller's hook so a throw from it costs the hook and nothing else.
 *
 * The guard lives here, once, around the callback the instance stores --
 * not at the emit sites, where it would be a try block per report. A
 * reporter is a diagnostic, and a diagnostic that changes the outcome is
 * worse than no diagnostic: the throw is dropped rather than raised out of
 * band, since an out-of-band throw ends a Node process the frame would have
 * survived. A caller who wants to see it catches it in their own hook.
 */
export function guardTrace(trace: Trace): Trace {
	return (event: TraceEvent): void => {
		try {
			trace(event);
		} catch (_err) {
			// The hook's business, not the frame's.
		}
	};
}

const encoder = new TextEncoder();

/** How many bytes a write puts on the wire. Called on the traced path. */
export function byteLength(text: string): number {
	return encoder.encode(text).length;
}
