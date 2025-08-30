import {type CellBuffer, Cell, createBuffer} from "./CellBuffer.js";

export type ColorDepth = "ansi" | "256" | "rgb";

export interface CellStyle {
	fg?: number | null;
	bg?: number | null;
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
		private rows: number,
		private cols: number,
		private readonly colorDepth: ColorDepth = "rgb",
	) {
		this.currentBuffer = createBuffer(rows, cols);
	}

	/**
	 * Resize the renderer dimensions
	 * Next beginFrame() will use new dimensions
	 */
	resize(rows: number, cols: number): void {
		this.rows = rows;
		this.cols = cols;
	}

	/**
	 * Clear previous buffer to force full re-render
	 * Useful after terminal resize to ensure complete redraw
	 */
	clearPreviousBuffer(): void {
		this.previousBuffer = null;
	}

	// TODO: Add drawBorder(x, y, width, height, options) for border rendering with:
	// TODO:    - Box drawing characters (┌─┐│└┘├┤┬┴┼ etc.)
	// TODO:    - Border styles (single, double, rounded)
	// TODO:    - Smart corner/intersection handling
	// TODO:    - Background preservation (borders inherit background)

	/**
	 * Begin a new frame - creates fresh buffer
	 */
	beginFrame(): void {
		this.currentBuffer = createBuffer(this.rows, this.cols);
	}

	/**
	 * Set a cell with character and style (private low-level API)
	 */
	private setCell(
		row: number,
		col: number,
		char: string,
		style?: CellStyle,
	): void {
		if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;

		// Preserve existing background if new style doesn't specify one
		let finalStyle = style;
		if (style && style.bg == null) {
			const existingCell = this.currentBuffer[row][col];
			if (existingCell && existingCell.bg !== 0) {
				finalStyle = {...style, bg: existingCell.bg};
			}
		}

		// Create new cell and assign it to the buffer
		const newCell = Cell.create(char, finalStyle);
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
		bgColor?: number | null,
	): void {
		// Skip if background color is null/undefined (means don't overwrite)
		if (bgColor == null) {
			return;
		}

		// bg: 0 is valid (default background color)
		const style: CellStyle = {bg: bgColor};

		for (let row = y; row < y + height; row++) {
			for (let col = x; col < x + width; col++) {
				if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
					this.setCell(row, col, " ", style);
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
			// Compare buffers and create diff - handle different dimensions
			const prevRows = this.previousBuffer.length;
			const prevCols = this.previousBuffer[0]?.length || 0;

			for (let row = 0; row < this.rows; row++) {
				for (let col = 0; col < this.cols; col++) {
					// Get previous cell if it exists in old buffer bounds
					const prevCell =
						row < prevRows && col < prevCols
							? this.previousBuffer[row][col]
							: null;
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
}

/**
 * Generate ANSI escape sequences from a cell buffer
 * Pure function - no state, no side effects
 */
export function generateANSI(
	buffer: CellBuffer,
	colorDepth: ColorDepth = "rgb",
): string {
	const rows = buffer.length;
	const cols = buffer[0]?.length || 0;

	let output = "";
	let cursorRow = 0;
	let cursorCol = 0;
	let previousCell: Cell | null = null;
	let hasContent = false;

	// Check if there's any content to render first
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			if (buffer[row][col] !== null) {
				hasContent = true;
				break;
			}
		}
		if (hasContent) break;
	}

	// Only add wrapper sequences if there's content to render
	if (hasContent) {
		// Robust terminal rendering setup - synchronized output prevents tearing
		// Enable synchronized output to batch all updates
		output += "\x1b[?2026h"; // Enable synchronized output (prevents screen tearing)
		output += "\x1b[s"; // Save current cursor position
		output += "\x1b[?25l"; // Hide cursor to prevent flicker during rendering
		output += "\x1b[H"; // Move cursor to home position (0,0)
	}

	// Helper functions
	const moveCursor = (targetRow: number, targetCol: number): string => {
		let moveOutput = "";
		const rowDiff = targetRow - cursorRow;

		// Should never move up or left in sparse buffer processing
		if (rowDiff < 0) {
			throw new Error(
				`Trying to move up from row ${cursorRow} to ${targetRow} - this should never happen in row-major processing`,
			);
		}
		if (targetCol < cursorCol && rowDiff === 0) {
			throw new Error(
				`Trying to move left from col ${cursorCol} to ${targetCol} in row ${cursorRow} - this should never happen`,
			);
		}

		// Handle movement
		if (rowDiff > 0) {
			if (targetCol === 0) {
				// Moving down to column 0 - use idiomatic \r\n
				moveOutput += "\r\n".repeat(rowDiff);
			} else {
				// Moving down to non-zero column - use \r\n then move right
				moveOutput += "\r\n".repeat(rowDiff);
				moveOutput += `\x1b[${targetCol}C`;
			}
		} else if (targetCol !== cursorCol) {
			// Same row - handle column movement
			if (targetCol === 0) {
				moveOutput += "\r";
			} else {
				// Same row - move right
				moveOutput += `\x1b[${targetCol - cursorCol}C`;
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
				const r = (color >> 16) & 0xff;
				const g = (color >> 8) & 0xff;
				const b = color & 0xff;
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
		const r = (color >> 16) & 0xff;
		const g = (color >> 8) & 0xff;
		const b = color & 0xff;

		// Standard colors (0-15)
		if (r === g && g === b) {
			// Grayscale
			if (r < 8) return 0; // black
			if (r > 248) return 15; // white
			return Math.round(((r - 8) / 247) * 23) + 232;
		}

		// 216 color cube (16-231)
		const r6 = Math.round((r / 255) * 5);
		const g6 = Math.round((g / 255) * 5);
		const b6 = Math.round((b / 255) * 5);
		return 16 + 36 * r6 + 6 * g6 + b6;
	};

	const rgbToBasic8 = (color: number): number => {
		const r = (color >> 16) & 0xff;
		const g = (color >> 8) & 0xff;
		const b = color & 0xff;

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

			const diffFlag = (
				current: boolean,
				old: boolean,
				on: number,
				off: number,
			) => {
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
		let rowHasContent = false;
		let rowHasAnsi = false;

		for (let col = 0; col < cols; col++) {
			const cell = buffer[row][col];

			// Skip null cells (empty Cell objects no longer exist)
			if (cell === null) {
				continue;
			}

			rowHasContent = true;

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
				rowHasAnsi = true;
			}

			// Write character
			output += cell.grapheme;

			// Update cursor position and track previous cell
			cursorCol += cell.width;
			previousCell = cell;

			// If this is a wide character, skip the next column position
			if (cell.width === 2) {
				skipNextCol = col + 1;
			}
		}

		// Reset at end of each line that has content AND ANSI sequences to prevent style bleeding on truncation
		if (rowHasContent) {
			previousCell = null;
			if (rowHasAnsi) {
				output += "\x1b[0m";
			}
		}
	}

	// Only add closing wrapper sequences if we added opening ones
	if (hasContent) {
		// Restore cursor to original position and show cursor
		output += "\x1b[u"; // Restore cursor position
		output += "\x1b[?25h"; // Show cursor
		output += "\x1b[?2026l"; // Disable synchronized output (commit all updates)
	}

	return output;
}
