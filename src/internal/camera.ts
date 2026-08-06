/**
 * The camera: where the viewport is looking in the document, and the math that
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
export class Camera {
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
}
