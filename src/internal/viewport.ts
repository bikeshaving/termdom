const kScrollTop = Symbol("scrollTop");
const kScreenTop = Symbol("screenTop");
const kAnchorScrollTop = Symbol("anchorScrollTop");
const kLastPlannedScrollTop = Symbol("lastPlannedScrollTop");

/**
 * One frame's composition plan: the net camera movement since the previous
 * plan, and the region rows that movement exposed. A frame with a plan is a
 * transform -- the terminal shifts the carried rows and only the exposed
 * bands (plus whatever damage the renderer adds) repaint.
 */
export interface FramePlan {
	/** Net rows scrolled since the last plan, positive downward. */
	shift: number;
	/** The scroll offset the previous plan was taken at. */
	previousScrollTop: number;
	/** The [start, end) region rows the shift exposed at an edge. */
	exposedBands: Array<[number, number]>;
}

/**
 * Where the visible window is looking in the document, and the mapping between
 * a terminal cell and a document point.
 */
export class Viewport {
	constructor() {
		this[kScrollTop] = 0;
		this[kScreenTop] = 0;
		this[kAnchorScrollTop] = 0;
		this[kLastPlannedScrollTop] = null;
	}

	declare [kScrollTop]: number;
	declare [kScreenTop]: number;
	declare [kAnchorScrollTop]: number;
	declare [kLastPlannedScrollTop]: number | null;

	/** Viewport scroll offset into the document (window.scrollY), clamped >= 0. */
	get scrollTop(): number {
		return this[kScrollTop];
	}

	set scrollTop(value: number) {
		this[kScrollTop] = Math.max(0, value);
	}

	/** The terminal row the painted region starts at (the command start). */
	get screenTop(): number {
		return this[kScreenTop];
	}

	set screenTop(value: number) {
		this[kScreenTop] = value;
	}

	/** The fullscreen anchor: the alternate screen's row-zero scroll origin. */
	get anchorScrollTop(): number {
		return this[kAnchorScrollTop];
	}

	set anchorScrollTop(value: number) {
		this[kAnchorScrollTop] = value;
	}

	/** Scroll the viewport by `rows` document rows (negative = up), clamped >= 0. */
	scrollBy(rows: number): void {
		this[kScrollTop] = Math.max(0, this[kScrollTop] + rows);
	}

	/** Scroll the viewport to an absolute document row, clamped >= 0. */
	scrollTo(row: number): void {
		this[kScrollTop] = Math.max(0, row);
	}

	/** Whether the camera still sits where the last frame plan painted it. */
	get atLastPlannedScrollTop(): boolean {
		return (
			this[kLastPlannedScrollTop] !== null &&
			this[kScrollTop] === this[kLastPlannedScrollTop]
		);
	}

	/**
	 * Plan the frame about to paint a `regionHeight`-row window: the net
	 * scroll shift since the previous plan, and the rows that shift exposed.
	 * Null means the frame must repaint in full -- the first frame has no
	 * baseline, and a shift of a region height or more carries nothing over.
	 * Taking the plan records the current offset as the next plan's baseline
	 * either way, whether or not the caller can honor a transform.
	 */
	takeFramePlan(regionHeight: number): FramePlan | null {
		const previous = this[kLastPlannedScrollTop];
		this[kLastPlannedScrollTop] = this[kScrollTop];
		if (previous === null) {
			return null;
		}
		const shift = this[kScrollTop] - previous;
		if (Math.abs(shift) >= regionHeight) {
			return null;
		}
		const exposedBands: Array<[number, number]> = [];
		if (shift > 0) {
			exposedBands.push([regionHeight - shift, regionHeight]);
		} else if (shift < 0) {
			exposedBands.push([0, -shift]);
		}
		return {shift, previousScrollTop: previous, exposedBands};
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
			return {x, y: row + this[kAnchorScrollTop]};
		}
		const y = row - this[kScreenTop] + this[kScrollTop];
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
		const overflow = this[kScreenTop] + rows - height;
		if (overflow <= 0) {
			return 0;
		}
		const push = Math.min(overflow, this[kScreenTop]);
		this[kScreenTop] -= push;
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
		if (revealTop < this[kScrollTop]) {
			return revealTop - this[kScrollTop];
		}
		if (revealBottom > this[kScrollTop] + regionHeight) {
			return revealBottom - (this[kScrollTop] + regionHeight);
		}
		return 0;
	}
}
