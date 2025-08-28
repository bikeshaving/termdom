import {
	type CellBuffer,
	Cell,
	createBuffer,
} from "./CellBuffer.js";
import {ANSIGenerator, type ColorDepth} from "./ANSIGenerator.js";

export interface CellStyle {
	fg?: number;
	bg?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	inverse?: boolean;
	dim?: boolean;
	blink?: boolean;
	overline?: boolean;
}

export class Renderer {
	private previousBuffer: CellBuffer | null = null;
	private currentBuffer: CellBuffer;
	private generator: ANSIGenerator;

	constructor(
		private readonly rows: number,
		private readonly cols: number,
		colorDepth: ColorDepth = "rgb",
	) {
		this.currentBuffer = createBuffer(rows, cols);
		this.generator = new ANSIGenerator(rows, cols, colorDepth);
	}

	/**
	 * Begin a new frame - creates fresh buffer
	 */
	beginFrame(): void {
		this.currentBuffer = createBuffer(this.rows, this.cols);
	}

	/**
	 * Set a cell with character and style (low-level API)
	 */
	setCell(row: number, col: number, char: string, style?: CellStyle): void {
		if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;

		// Create new cell and assign it to the buffer
		const newCell = new Cell(char, style);
		this.currentBuffer[row][col] = newCell;
	}

	/**
	 * Fill a rectangular area with background color (high-level API)
	 */
	fillRect(
		x: number,
		y: number,
		width: number,
		height: number,
		style?: CellStyle,
	): void {
		for (let row = y; row < y + height; row++) {
			for (let col = x; col < x + width; col++) {
				if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
					this.setCell(row, col, " ", style);
				}
			}
		}
	}

	/**
	 * Clear a rectangular area (high-level API)
	 */
	clearRect(x: number, y: number, width: number, height: number): void {
		for (let row = y; row < y + height; row++) {
			for (let col = x; col < x + width; col++) {
				if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
					this.currentBuffer[row][col] = Cell.createNull();
				}
			}
		}
	}

	/**
	 * Write text with automatic wide character handling (high-level API)
	 */
	setText(x: number, y: number, text: string, style?: CellStyle): number {
		if (y < 0 || y >= this.rows) return x;

		let currentX = x;
		const segmenter = new Intl.Segmenter("en", {granularity: "grapheme"});
		const segments = Array.from(segmenter.segment(text));

		for (const segment of segments) {
			const char = segment.segment;
			const width = Bun.stringWidth(char);

			// Stop if we're going out of bounds
			if (currentX + width > this.cols) break;

			this.setCell(y, currentX, char, style);
			currentX += width;
		}

		return currentX;
	}

	/**
	 * Write text with wrapping support (high-level API)
	 */
	setTextWrapped(
		x: number,
		y: number,
		text: string,
		style?: CellStyle,
		maxWidth?: number,
	): {endX: number; endY: number} {
		const wrapWidth = maxWidth || this.cols - x;
		let currentX = x;
		let currentY = y;

		const segmenter = new Intl.Segmenter("en", {granularity: "grapheme"});
		const segments = Array.from(segmenter.segment(text));

		for (const segment of segments) {
			const char = segment.segment;
			const width = Bun.stringWidth(char);

			// Handle newlines
			if (char === "\n") {
				currentX = x;
				currentY++;
				continue;
			}

			// Wrap if needed
			if (currentX + width > x + wrapWidth) {
				currentX = x;
				currentY++;
			}

			// Stop if we're going out of bounds vertically
			if (currentY >= this.rows) break;

			this.setCell(currentY, currentX, char, style);
			currentX += width;
		}

		return {endX: currentX, endY: currentY};
	}

	/**
	 * Render the current frame and return ANSI diff
	 */
	render(): string {
		// Create diff buffer
		const diffBuffer = createBuffer(this.rows, this.cols);

		if (!this.previousBuffer) {
			// First frame - everything is new
			for (let row = 0; row < this.rows; row++) {
				for (let col = 0; col < this.cols; col++) {
					diffBuffer[row][col] = this.currentBuffer[row][col].copy();
				}
			}
		} else {
			// Compare buffers and create diff
			for (let row = 0; row < this.rows; row++) {
				for (let col = 0; col < this.cols; col++) {
					const prevCell = this.previousBuffer[row][col];
					const currCell = this.currentBuffer[row][col];

					if (!prevCell.equals(currCell)) {
						// If previous cell had content but current doesn't, we need to clear it
						const prevEmpty = prevCell.isEmpty();
						const currEmpty = currCell.isEmpty();

						if (!prevEmpty && currEmpty) {
							// Create a space character to clear the cell with current cell's style
							const clearCell = new Cell(" ", {
								fg: currCell.fg || undefined,
								bg: currCell.bg || undefined,
								...currCell.getStyleFlags()
							});
							diffBuffer[row][col] = clearCell;
						} else {
							// Normal change, copy current cell
							diffBuffer[row][col] = currCell.copy();
						}
					}
				}
			}
		}

		// Generate ANSI from diff
		const output = this.generator.serialize(diffBuffer);

		// Current becomes previous
		this.previousBuffer = this.currentBuffer;

		return output;
	}

	/**
	 * Clean up
	 */
	dispose(): void {
		// Nothing to dispose with simple arrays
	}
}
