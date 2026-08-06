import {type LayoutEngine} from "./layout.js";
import {type Viewport} from "./viewport.js";
import {type ProcessLike} from "./termdom.js";

/**
 * The terminal conversation TermDOM cannot have synchronously: every fact it
 * needs about the terminal is a query written to stdout whose answer arrives
 * later on stdin, interleaved with ordinary keystrokes.
 *
 * Two kinds of round-trip live here. A DSR cursor query (`ESC[6n`) locates the
 * command-start row so the painted region anchors correctly, and re-locates it
 * after a resize rewraps the screen. A DECRQM mode query settles capabilities
 * the renderer's own contract depends on -- explicit bidi (BDSM) so the
 * terminal never reorders cells it was handed one at a time, and grapheme-
 * cluster widths (mode 2027) so it agrees with how text was measured.
 *
 * The shell owns the stdin decoder; it splices replies out of the input stream
 * and hands them here through feedCursorReport/feedModeReport, which route each
 * to whatever query is waiting. Answers may never come -- most terminals
 * implement no such modes -- so every query is bounded by a timer, and silence
 * is a valid answer meaning "no opinion, ours stands". Every timer is tracked
 * so dispose() can clear it; a live one keeps the event loop open, which across
 * a test suite is fatal.
 */
export class TerminalProbe {
	#process: ProcessLike;
	#viewport: Viewport;
	#layout: LayoutEngine;
	#interactive: boolean;
	#detectCursorEnabled: boolean;

	// Command start was resolved (even if at row 1). The resize re-anchor saves
	// and restores this around its redraw.
	#hasDetectedCommandStart = false;
	// The pending DSR reply handler and its timeout. Cursor detection and the
	// resize re-anchor share these slots so stdin routing and dispose can see
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
		process: ProcessLike;
		viewport: Viewport;
		layout: LayoutEngine;
		interactive: boolean;
		detectCursor: boolean;
	}) {
		this.#process = deps.process;
		this.#viewport = deps.viewport;
		this.#layout = deps.layout;
		this.#interactive = deps.interactive;
		this.#detectCursorEnabled = deps.detectCursor;
	}

	/** Whether cursor detection is enabled: an interactive TTY, not disabled. */
	get detectCursorEnabled(): boolean {
		return this.#detectCursorEnabled;
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

	/** Route a DECRPM mode reply to whichever negotiation is waiting on it. */
	feedModeReport(mode: string, value: number): boolean {
		const waiting = this.#modeProbeHandlers.get(mode);
		if (!waiting) return false;
		this.#modeProbeHandlers.delete(mode);
		waiting(value);
		return true;
	}

	/** Route a DSR cursor-position reply to the pending detection or query. */
	feedCursorReport(report: string): boolean {
		if (!this.#cursorDetectionHandler) return false;
		this.#cursorDetectionHandler(report);
		return true;
	}

	/**
	 * The outstanding startup command-start detection, or null once it has
	 * settled. The first interactive frame awaits this so it anchors at the
	 * resolved row rather than painting at row 0 first -- but only when one is
	 * actually pending. A settled probe returns null so the caller adds no async
	 * hop: an unconditional await would defer the rest of that frame a microtask
	 * even with nothing to wait for, and a synchronous scroll clamp depends on
	 * the frame running straight through.
	 */
	get cursorDetectionPending(): Promise<void> | null {
		return this.#cursorDetectionPromise;
	}

	/**
	 * Initialize cursor position detection for TTY environments
	 * This runs asynchronously during construction to set up proper viewport positioning
	 */
	initializeCursorDetection(): void {
		this.#cursorDetectionPromise = null;
		// Only detect cursor position in TTY environments when enabled
		if (this.#detectCursorEnabled && this.#process.stdin?.isTTY) {
			// Set up cursor detection promise that render() will wait for
			this.#cursorDetectionPromise = Promise.race([
				this.detectCommandStart().then(() => {}),
				// Fallback: if cursor detection takes too long, proceed without it
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					// If cursor detection fails, continue without it
					this.#hasDetectedCommandStart = false;
				})
				.finally(() => {
					// Clear the promise so subsequent renders don't wait
					this.#cursorDetectionPromise = null;
				});
		} else {
			// In non-TTY environments, don't set up cursor detection at all
			this.#cursorDetectionPromise = null;
		}
	}

	/**
	 * Set a terminal mode and ask what it actually is now (DECRQM), resolving
	 * with the reported value -- or null if the terminal says nothing, which is
	 * the common case, since most implement no such mode and answer only the
	 * queries they know.
	 *
	 * The reply values are DECRPM's: 0 not recognised, 1 set, 2 reset, 3
	 * permanently set, 4 permanently reset. 0 and silence mean the same thing to
	 * every caller here -- the terminal has no opinion, so ours stands.
	 */
	#probeMode(mode: string, request: string): Promise<number | null> {
		return new Promise<number | null>((resolve) => {
			// The same second the cursor probe allows: a cold start or a slow SSH
			// link can outlast a tighter window, and answering late is answering.
			// Timers are tracked so dispose() can clear them -- a live one keeps
			// the event loop open, which across a test suite is fatal.
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
			this.#process.stdout.write(request);
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
	 * was never given whole would scramble the frame. So we ask for explicit and
	 * then ask what we got (DECRQM), rather than assuming either.
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
		if (!this.#interactive || !this.#process.stdin?.isTTY) return;

		// Explicit mode, then "what is mode 8 now?" in one write.
		const answer = await this.#probeMode("8", "\x1b[8l\x1b[8$p");

		if (answer === null || answer === 0) return; // No bidi: cells as written.
		this.#priorBidiMode = answer;

		// 1 = still set, 3 = permanently set. Either way it reorders regardless of
		// what we asked, so hand it text in the order it expects.
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
	 * an emoji with a variation selector is one indivisible unit, so it advances
	 * the cursor once per code point in them. We measure by cluster -- that is
	 * what stringWidth does -- so on such a terminal every cluster of more than
	 * one code point is a standing disagreement about where the next cell is.
	 *
	 * Mode 2027 is the fix the terminal community landed on, and it is asked for
	 * the same way as bidi: set it, then query it. A terminal that does not know
	 * the mode answers 0 or says nothing, and we simply carry on -- our
	 * measurements do not change, because they were already cluster-based; what
	 * changes is only whether the terminal agrees with them.
	 */
	async negotiateGraphemeClusters(): Promise<void> {
		if (!this.#interactive || !this.#process.stdin?.isTTY) return;

		const answer = await this.#probeMode("?2027", "\x1b[?2027h\x1b[?2027$p");
		// 1 = set (it agrees now), 3 = permanently set (it always did).
		this.#graphemeClustersNegotiated = answer === 1 || answer === 3;
	}

	/**
	 * Detect current cursor position and set window.screenTop
	 * Sends \x1b[6n and waits for response \x1b[row;colR
	 */
	detectCommandStart(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this.#process.stdin?.isTTY) {
				reject(new Error("Cannot detect cursor position: stdin is not a TTY"));
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

			// Set up cursor detection handler for unified stdin
			this.#cursorDetectionHandler = (dataStr: string) => {
				responseBuffer += dataStr;

				// Look for cursor position response pattern: \x1b[row;colR
				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					finish();

					const row = parseInt(match[1], 10);
					// Set window.screenTop (convert 1-based terminal row to 0-based)
					const screenTop = row - 1;
					this.#viewport.screenTop = screenTop;

					// Set scrollTop to command start position (browser behavior)
					// For command start, we want content to shift up to terminal top
					this.#viewport.anchorScrollTop = -this.#viewport.screenTop;

					this.#hasDetectedCommandStart = true;
					resolve(row);
				}
			};

			// Send cursor position query with proper flushing
			this.#process.stdout.write("\x1b[6n");

			// Force flush the output buffer (critical for cursor queries)
			if (typeof (this.#process.stdout as any)._flush === "function") {
				(this.#process.stdout as any)._flush();
			}

			// Timeout after 1000ms (reasonable balance for reliability). The timer is
			// held so it can be cleared the moment a response arrives -- otherwise it
			// keeps the event loop alive for a further second after we are done.
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
	 * Ask the terminal where the cursor is (DSR) and resolve with its 0-based row.
	 *
	 * Used by the resize re-anchor: the cursor is parked on our content's bottom
	 * row after every frame, so after a rewrap its position names where the frame
	 * actually ended up. Rejects on timeout so the caller can fall back to a
	 * computed anchor.
	 */
	queryCursorRow(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this.#process.stdin?.isTTY) {
				reject(new Error("stdin is not a TTY"));
				return;
			}

			// Queries can overlap: a drag fires resizes faster than the terminal
			// answers, and each handleResize issues its own query. The handler and
			// timer live in shared instance slots (so stdin routing and dispose can
			// see them), so every cleanup must check identity before clearing --
			// otherwise a superseded query's cleanup kills its successor's handler
			// and timeout, and that resize never redraws at all.
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

			this.#process.stdout.write("\x1b[6n");
			if (typeof (this.#process.stdout as any)._flush === "function") {
				(this.#process.stdout as any)._flush();
			}

			// Short timeout: the redraw should feel immediate, and a terminal that
			// does not answer promptly falls back to the computed re-anchor.
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
	 * Hand the terminal back the modes we changed, and tear down every timer and
	 * handler that would otherwise keep the event loop open. Only modes we
	 * actually set are restored -- reset is where the terminal already was.
	 */
	dispose(): void {
		// We asked for explicit bidi on the way in; give the terminal back the
		// mode it reported, so the next command inherits its own settings rather
		// than ours. Only when it was SET -- reset is where we left it anyway.
		if (this.#priorBidiMode === 1) {
			this.#process.stdout.write("\x1b[8h");
			this.#priorBidiMode = null;
		}
		// Mode 2027 likewise: we turned it on, so turn it off. A terminal that
		// never had it does not see this, having answered nothing.
		if (this.#graphemeClustersNegotiated) {
			this.#process.stdout.write("\x1b[?2027l");
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
	}
}
