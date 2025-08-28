/**
 * ANSI Generator - converts cell buffers to minimal ANSI escape sequences
 * Skips null/empty cells (codepoint 0) and only emits content for cells with data
 */

import {
	Cell,
	type CellBuffer,
} from "./CellBuffer.js";

interface NonEmptyCell {
	row: number;
	col: number;
	cell: Cell;
}

export type ColorDepth = "ansi" | "256" | "rgb";

export class ANSIGenerator {
	private _cursorRow: number = 0;
	private _cursorCol: number = 0;
	private _cursorStyle: Cell = Cell.createNull();

	constructor(
		private readonly rows: number,
		private readonly cols: number,
		private readonly colorDepth: ColorDepth = "rgb",
	) {}

	/**
	 * Serialize a cell buffer to ANSI escape sequences
	 * Null cells (codepoint 0) are skipped, all other cells (including spaces) are emitted
	 */
	serialize(buffer: CellBuffer): string {
		let output = "";
		this._cursorRow = 0;
		this._cursorCol = 0;
		this._cursorStyle = Cell.createNull();

		// Collect all non-empty cells
		const nonEmptyCells: NonEmptyCell[] = [];
		for (let row = 0; row < this.rows; row++) {
			for (let col = 0; col < this.cols; col++) {
				const cell = buffer[row][col];
				if (!cell.isEmpty()) {
					nonEmptyCells.push({row, col, cell});
				}
			}
		}

		// Process cells in order, skipping positions occupied by wide characters
		let skipNextCol: number | null = null;

		for (const {row, col, cell} of nonEmptyCells) {
			// Skip this cell if it's the second column of a wide character
			if (
				skipNextCol !== null &&
				row === this._cursorRow &&
				col === skipNextCol
			) {
				skipNextCol = null;
				continue;
			}
			skipNextCol = null;

			// Move cursor if needed
			if (row !== this._cursorRow || col !== this._cursorCol) {
				output += this._moveCursor(row, col);
			}

			// Apply style changes
			const sgrSeq = this._diffStyle(cell, this._cursorStyle);
			if (sgrSeq.length > 0) {
				output += `\x1b[${sgrSeq.join(";")}m`;
				this._cursorStyle = cell.copy();
			}

			// Write character
			output += cell.grapheme;

			// Handle wide characters - they occupy 2 columns
			const cellWidth = cell.width;
			this._cursorCol += cellWidth;

			// If this is a wide character, skip the next column position
			if (cellWidth === 2) {
				skipNextCol = col + 1;
			}
		}

		return output;
	}

	private _moveCursor(targetRow: number, targetCol: number): string {
		let output = "";

		const rowDiff = targetRow - this._cursorRow;
		const colDiff = targetCol - this._cursorCol;

		// Handle row movement
		if (rowDiff > 0) {
			// Moving down
			if (targetCol === 0 && this._cursorCol > 0) {
				// Use \r\n for efficiency when moving to start of next lines
				output += "\r\n".repeat(rowDiff);
				this._cursorRow = targetRow;
				this._cursorCol = 0;
				return output;
			} else {
				output += `\x1b[${rowDiff}B`;
			}
		} else if (rowDiff < 0) {
			output += `\x1b[${-rowDiff}A`;
		}

		// Handle column movement
		if (targetCol !== this._cursorCol || rowDiff !== 0) {
			if (targetCol === 0) {
				output += "\r";
			} else if (targetCol > this._cursorCol) {
				output += `\x1b[${targetCol - this._cursorCol}C`;
			} else if (targetCol < this._cursorCol) {
				output += `\x1b[${this._cursorCol - targetCol}D`;
			} else if (rowDiff !== 0) {
				// Row changed but column same - need to set absolute position
				output += `\x1b[${targetCol}G`;
			}
		}

		this._cursorRow = targetRow;
		this._cursorCol = targetCol;

		return output;
	}

	private _isAttributeDefault(cell: Cell): boolean {
		return cell.fg === 0 && cell.bg === 0 && cell.style === 0;
	}

	private _diffStyle(cell: Cell, oldCell: Cell): number[] {
		const seq: number[] = [];

		if (cell.styleEquals(oldCell)) {
			return seq;
		}

		const fgChanged = cell.fg !== oldCell.fg;
		const bgChanged = cell.bg !== oldCell.bg;
		const styleChanged = cell.style !== oldCell.style;

		// Check if resetting to default
		if (this._isAttributeDefault(cell)) {
			if (!this._isAttributeDefault(oldCell)) {
				seq.push(0);
			}
			return seq;
		}

		// Handle foreground color changes
		if (fgChanged) {
			const fgColor = cell.fg;

			if (fgColor === 0) {
				seq.push(39); // Default foreground
			} else {
				// Emit color based on color depth setting
				this._emitColor(seq, fgColor, true);
			}
		}

		// Handle background color changes
		if (bgChanged) {
			const bgColor = cell.bg;

			if (bgColor === 0) {
				seq.push(49); // Default background
			} else {
				// Emit color based on color depth setting
				this._emitColor(seq, bgColor, false);
			}
		}

		// Handle style changes
		if (styleChanged) {
			const cellFlags = cell.getStyleFlags();
			const oldFlags = oldCell.getStyleFlags();

			this._diffFlag(seq, cellFlags.bold, oldFlags.bold, 1, 22);
			this._diffFlag(seq, cellFlags.dim, oldFlags.dim, 2, 22);
			this._diffFlag(seq, cellFlags.italic, oldFlags.italic, 3, 23);
			this._diffFlag(seq, cellFlags.underline, oldFlags.underline, 4, 24);
			this._diffFlag(seq, cellFlags.blink, oldFlags.blink, 5, 25);
			this._diffFlag(seq, cellFlags.inverse, oldFlags.inverse, 7, 27);
			// Note: invisible is not exposed in public API, skip it
			this._diffFlag(seq, cellFlags.strikethrough, oldFlags.strikethrough, 9, 29);
			this._diffFlag(seq, cellFlags.overline, oldFlags.overline, 53, 55);
		}

		return seq;
	}

	private _emitColor(seq: number[], color: number, isFg: boolean): void {
		const prefix = isFg ? 38 : 48;

		switch (this.colorDepth) {
			case "rgb":
				// Extract RGB components from color integer
				const r = (color >> 16) & 0xFF;
				const g = (color >> 8) & 0xFF;
				const b = color & 0xFF;
				seq.push(prefix, 2, r, g, b);
				break;

			case "256":
				// Convert RGB to 256-color index
				const colorIndex = this._rgbTo256(color);
				seq.push(prefix, 5, colorIndex);
				break;

			case "ansi":
				// Convert to basic 8 colors
				const basicColor = this._rgbToBasic8(color);
				seq.push((isFg ? 30 : 40) + basicColor);
				break;
		}
	}

	/**
	 * Convert RGB color to 256-color palette index
	 */
	private _rgbTo256(color: number): number {
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
	}

	/**
	 * Convert RGB color to basic 8-color ANSI
	 */
	private _rgbToBasic8(color: number): number {
		const r = (color >> 16) & 0xFF;
		const g = (color >> 8) & 0xFF;
		const b = color & 0xFF;

		// Convert to basic 8 colors using thresholds
		let ansiColor = 0;
		if (r > 127) ansiColor |= 1; // red
		if (g > 127) ansiColor |= 2; // green  
		if (b > 127) ansiColor |= 4; // blue
		return ansiColor;
	}

	private _diffFlag(
		seq: number[],
		currentFlag: boolean,
		oldFlag: boolean,
		on: number,
		off: number,
	): void {
		if (currentFlag !== oldFlag) {
			seq.push(currentFlag ? on : off);
		}
	}
}
