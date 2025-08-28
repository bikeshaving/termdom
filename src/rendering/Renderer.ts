import {
	type CellBuffer,
	Cell,
	createBuffer,
} from "./CellBuffer.js";

export type ColorDepth = "ansi" | "256" | "rgb";

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

	constructor(
		private readonly rows: number,
		private readonly cols: number,
		private readonly colorDepth: ColorDepth = "rgb",
	) {
		this.currentBuffer = createBuffer(rows, cols);
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
		const newCell = Cell.create(char, style);
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
					this.currentBuffer[row][col] = null;
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
					const currCell = this.currentBuffer[row][col];
					diffBuffer[row][col] = currCell; // Cells are immutable, can reference directly
				}
			}
		} else {
			// Compare buffers and create diff
			for (let row = 0; row < this.rows; row++) {
				for (let col = 0; col < this.cols; col++) {
					const prevCell = this.previousBuffer[row][col];
					const currCell = this.currentBuffer[row][col];

					// Handle null cases
					if (prevCell === null && currCell === null) {
						// Both null, no change
						continue;
					}
					
					if (prevCell === null && currCell !== null) {
						// New content
						diffBuffer[row][col] = currCell; // Cells are immutable, can reference directly
						continue;
					}
					
					if (prevCell !== null && currCell === null) {
						// Content removed, need to clear with space
						diffBuffer[row][col] = Cell.create(" ");
						continue;
					}
					
					// Both non-null, compare normally
					if (!prevCell!.equals(currCell!)) {
						// Normal change, reference current cell directly
						diffBuffer[row][col] = currCell!; // Cells are immutable, can reference directly
					}
				}
			}
		}

		// Generate ANSI from diff
		const output = generateANSI(diffBuffer, this.colorDepth);

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

/**
 * Generate ANSI escape sequences from a cell buffer
 * Pure function - no state, no side effects
 */
export function generateANSI(
	buffer: CellBuffer,
	colorDepth: ColorDepth = "rgb"
): string {
	const rows = buffer.length;
	const cols = buffer[0]?.length || 0;
	
	let output = "";
	let cursorRow = 0;
	let cursorCol = 0;
	let previousCell: Cell | null = null;

	// Helper functions
	const moveCursor = (targetRow: number, targetCol: number): string => {
		let moveOutput = "";
		const rowDiff = targetRow - cursorRow;
		const colDiff = targetCol - cursorCol;

		// Handle row movement
		if (rowDiff > 0) {
			// Moving down
			if (targetCol === 0 && cursorCol > 0) {
				// Use \r\n for efficiency when moving to start of next lines
				moveOutput += "\r\n".repeat(rowDiff);
				cursorRow = targetRow;
				cursorCol = 0;
				return moveOutput;
			} else {
				moveOutput += `\x1b[${rowDiff}B`;
			}
		} else if (rowDiff < 0) {
			moveOutput += `\x1b[${-rowDiff}A`;
		}

		// Handle column movement
		if (targetCol !== cursorCol || rowDiff !== 0) {
			if (targetCol === 0) {
				moveOutput += "\r";
			} else if (targetCol > cursorCol) {
				moveOutput += `\x1b[${targetCol - cursorCol}C`;
			} else if (targetCol < cursorCol) {
				moveOutput += `\x1b[${cursorCol - targetCol}D`;
			} else if (rowDiff !== 0) {
				// Row changed but column same - need to set absolute position
				moveOutput += `\x1b[${targetCol}G`;
			}
		}

		cursorRow = targetRow;
		cursorCol = targetCol;
		return moveOutput;
	};

	const emitColor = (color: number, isFg: boolean): number[] => {
		const prefix = isFg ? 38 : 48;
		const seq: number[] = [];

		switch (colorDepth) {
			case "rgb":
				// Extract RGB components from color integer
				const r = (color >> 16) & 0xFF;
				const g = (color >> 8) & 0xFF;
				const b = color & 0xFF;
				seq.push(prefix, 2, r, g, b);
				break;

			case "256":
				// Convert RGB to 256-color index
				const colorIndex = rgbTo256(color);
				seq.push(prefix, 5, colorIndex);
				break;

			case "ansi":
				// Convert to basic 8 colors
				const basicColor = rgbToBasic8(color);
				seq.push((isFg ? 30 : 40) + basicColor);
				break;
		}
		return seq;
	};

	const rgbTo256 = (color: number): number => {
		const r = (color >> 16) & 0xFF;
		const g = (color >> 8) & 0xFF;
		const b = color & 0xFF;

		// Standard colors (0-15)
		if (r === g && g === b) {
			// Grayscale
			if (r < 8) return 0; // black
			if (r > 248) return 15; // white
			return Math.round(((r - 8) / 247) * 23) + 232;
		}

		// 216 color cube (16-231)
		const r6 = Math.round(r / 255 * 5);
		const g6 = Math.round(g / 255 * 5);
		const b6 = Math.round(b / 255 * 5);
		return 16 + (36 * r6) + (6 * g6) + b6;
	};

	const rgbToBasic8 = (color: number): number => {
		const r = (color >> 16) & 0xFF;
		const g = (color >> 8) & 0xFF;
		const b = color & 0xFF;

		// Convert to basic 8 colors using thresholds
		let ansiColor = 0;
		if (r > 127) ansiColor |= 1; // red
		if (g > 127) ansiColor |= 2; // green  
		if (b > 127) ansiColor |= 4; // blue
		return ansiColor;
	};

	const getStyleDiff = (cell: Cell, prev: Cell | null): number[] => {
		if (!prev) {
			// First cell - emit all styles
			const seq: number[] = [];
			
			// Handle colors
			if (cell.fg !== 0) {
				seq.push(...emitColor(cell.fg, true));
			}
			if (cell.bg !== 0) {
				seq.push(...emitColor(cell.bg, false));
			}
			
			// Handle style flags
			const flags = cell.getStyleFlags();
			if (flags.bold) seq.push(1);
			if (flags.dim) seq.push(2);
			if (flags.italic) seq.push(3);
			if (flags.underline) seq.push(4);
			if (flags.blink) seq.push(5);
			if (flags.inverse) seq.push(7);
			if (flags.strikethrough) seq.push(9);
			if (flags.overline) seq.push(53);
			
			return seq;
		}

		if (cell.styleEquals(prev)) {
			return [];
		}

		const seq: number[] = [];
		const isDefault = cell.fg === 0 && cell.bg === 0 && cell.style === 0;
		const wasDefault = prev.fg === 0 && prev.bg === 0 && prev.style === 0;

		// Check if resetting to default
		if (isDefault && !wasDefault) {
			seq.push(0);
			return seq;
		}

		// Handle color changes
		if (cell.fg !== prev.fg) {
			if (cell.fg === 0) {
				seq.push(39); // Default foreground
			} else {
				seq.push(...emitColor(cell.fg, true));
			}
		}

		if (cell.bg !== prev.bg) {
			if (cell.bg === 0) {
				seq.push(49); // Default background
			} else {
				seq.push(...emitColor(cell.bg, false));
			}
		}

		// Handle style flag changes
		if (cell.style !== prev.style) {
			const cellFlags = cell.getStyleFlags();
			const prevFlags = prev.getStyleFlags();

			const diffFlag = (current: boolean, old: boolean, on: number, off: number) => {
				if (current !== old) {
					seq.push(current ? on : off);
				}
			};

			diffFlag(cellFlags.bold, prevFlags.bold, 1, 22);
			diffFlag(cellFlags.dim, prevFlags.dim, 2, 22);
			diffFlag(cellFlags.italic, prevFlags.italic, 3, 23);
			diffFlag(cellFlags.underline, prevFlags.underline, 4, 24);
			diffFlag(cellFlags.blink, prevFlags.blink, 5, 25);
			diffFlag(cellFlags.inverse, prevFlags.inverse, 7, 27);
			diffFlag(cellFlags.strikethrough, prevFlags.strikethrough, 9, 29);
			diffFlag(cellFlags.overline, prevFlags.overline, 53, 55);
		}

		return seq;
	};

	// Main processing loop
	let skipNextCol: number | null = null;

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const cell = buffer[row][col];
			
			// Skip null cells (empty Cell objects no longer exist)
			if (cell === null) {
				continue;
			}

			// Skip this cell if it's the second column of a wide character
			if (skipNextCol !== null && row === cursorRow && col === skipNextCol) {
				skipNextCol = null;
				continue;
			}
			skipNextCol = null;

			// Move cursor if needed
			if (row !== cursorRow || col !== cursorCol) {
				output += moveCursor(row, col);
			}

			// Apply style changes
			const styleSeq = getStyleDiff(cell, previousCell);
			if (styleSeq.length > 0) {
				output += `\x1b[${styleSeq.join(";")}m`;
			}

			// Write character
			output += cell.grapheme;

			// Update cursor position and track previous cell
			cursorCol += cell.width;
			previousCell = cell; // No cloning needed!

			// If this is a wide character, skip the next column position
			if (cell.width === 2) {
				skipNextCol = col + 1;
			}
		}
	}

	return output;
}
