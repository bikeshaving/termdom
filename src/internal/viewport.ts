/**
 * The viewport: where the visible window is looking in the document, and the math that
 * maps a terminal cell back to a document point.
 *
 * TermDOM paints a moving window of the document into a region of the terminal.
 * Three numbers say where that window is:
 *
 * - scrollTop: how far down the document the viewport has scrolled -- the value
 *   `window.scrollY` / `pageYOffset` report.
 * - screenTop: the terminal row the painted region starts at (the command
 *   start), which drifts up as output scrolls into the shell's scrollback.
 * - anchorScrollTop: the fullscreen anchor, since the alternate screen owns
 *   row zero and its geometry is measured from there instead.
 *
 * A plain value object -- pure state and coordinate math, no terminal output
 * and no render loop. The render loop reads its position; callers that move it
 * (scrollBy) trigger their own repaint. Not a "Manager": it conforms to no API,
 * it is the internal source `window.scrollY` happens to read.
 */
export class Viewport {
	#scrollTop = 0;
	#screenTop = 0;
	#anchorScrollTop = 0;

	/** Viewport scroll offset into the document (window.scrollY), clamped >= 0. */
	get scrollTop(): number {
		return this.#scrollTop;
	}
	set scrollTop(value: number) {
		this.#scrollTop = Math.max(0, value);
	}

	/** The terminal row the painted region starts at (the command start). */
	get screenTop(): number {
		return this.#screenTop;
	}
	set screenTop(value: number) {
		this.#screenTop = value;
	}

	/** The fullscreen anchor: the alternate screen's row-zero scroll origin. */
	get anchorScrollTop(): number {
		return this.#anchorScrollTop;
	}
	set anchorScrollTop(value: number) {
		this.#anchorScrollTop = value;
	}

	/** Scroll the viewport by `rows` document rows (negative = up), clamped >= 0. */
	scrollBy(rows: number): void {
		this.#scrollTop = Math.max(0, this.#scrollTop + rows);
	}

	/**
	 * The document point under a terminal cell (screen column, screen row), or
	 * null for a row above the painted region -- a shell prompt above the
	 * command start is not part of the document. In fullscreen the alternate
	 * screen owns row zero, so the anchor supplies the origin directly.
	 */
	screenToDocumentPoint(
		x: number,
		row: number,
		isFullscreen: boolean,
	): {x: number; y: number} | null {
		if (isFullscreen) {
			return {x, y: row + this.#anchorScrollTop};
		}
		const y = row - this.#screenTop + this.#scrollTop;
		return y < 0 ? null : {x, y};
	}

	/**
	 * Reserve `rows` rows below the command start in a `height`-row terminal,
	 * returning how many rows the screen must scroll so they fit (0 if they
	 * already do). When there isn't room, the command start rides up into the
	 * shell's scrollback -- screenTop moves up by exactly the returned amount.
	 * The caller performs the terminal scroll itself; this is only the geometry
	 * of how far, and the bookkeeping of where the region now starts.
	 */
	reserveRows(rows: number, height: number): number {
		const overflow = this.#screenTop + rows - height;
		if (overflow <= 0) return 0;
		const push = Math.min(overflow, this.#screenTop);
		this.#screenTop -= push;
		return push;
	}

	/**
	 * How far to scroll so the row span [revealTop, revealBottom) is visible in
	 * a `regionHeight`-row window at the current scrollTop: negative to reveal
	 * above, positive to reveal below, 0 when it already fits. The caller
	 * applies the delta (via whatever schedules a repaint).
	 */
	scrollDeltaToReveal(
		revealTop: number,
		revealBottom: number,
		regionHeight: number,
	): number {
		if (revealTop < this.#scrollTop) return revealTop - this.#scrollTop;
		if (revealBottom > this.#scrollTop + regionHeight) {
			return revealBottom - (this.#scrollTop + regionHeight);
		}
		return 0;
	}
}
