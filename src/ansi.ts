/**
 * ANSI terminal rendering and cell buffer management
 */

import LRUCache from "./utils.js";

export type ColorDepth = "ansi" | "256" | "rgb";

// Style flags (internal implementation)
const STYLE_BOLD = 1 << 0;
const STYLE_ITALIC = 1 << 1;
const STYLE_UNDERLINE = 1 << 2;
const STYLE_STRIKETHROUGH = 1 << 3;
const STYLE_INVERSE = 1 << 4;
const STYLE_BLINK = 1 << 5;
const STYLE_DIM = 1 << 6;
const STYLE_INVISIBLE = 1 << 7;
const STYLE_OVERLINE = 1 << 8;

export type CellBuffer = (Cell | null)[][];

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

const cache = new LRUCache<string, Cell>(2 ** 12);

export class Cell {
	declare grapheme: string;
	declare fg: number;
	declare bg: number;
	declare style: number;

	constructor(grapheme: string, cellStyle?: CellStyle) {
		if (grapheme === "") {
			throw new Error(
				"Cell grapheme cannot be empty - use null for empty cells",
			);
		}

		this.grapheme = grapheme;
		this.fg = cellStyle?.fg ?? 0;
		this.bg = cellStyle?.bg ?? 0;

		// Convert boolean flags to bit flags
		let styleFlags = 0;
		if (cellStyle?.bold) styleFlags |= STYLE_BOLD;
		if (cellStyle?.italic) styleFlags |= STYLE_ITALIC;
		if (cellStyle?.underline) styleFlags |= STYLE_UNDERLINE;
		if (cellStyle?.strikethrough) styleFlags |= STYLE_STRIKETHROUGH;
		if (cellStyle?.inverse) styleFlags |= STYLE_INVERSE;
		if (cellStyle?.blink) styleFlags |= STYLE_BLINK;
		if (cellStyle?.dim) styleFlags |= STYLE_DIM;
		if (cellStyle?.overline) styleFlags |= STYLE_OVERLINE;
		this.style = styleFlags;

		Object.freeze(this);
	}

	equals(other: Cell): boolean {
		return (
			this.grapheme === other.grapheme &&
			this.fg === other.fg &&
			this.bg === other.bg &&
			this.style === other.style
		);
	}

	styleEquals(other: Cell): boolean {
		return (
			this.fg === other.fg && this.bg === other.bg && this.style === other.style
		);
	}

	get isWide(): boolean {
		return this.grapheme ? Bun.stringWidth(this.grapheme) > 1 : false;
	}

	get width(): number {
		return this.grapheme ? Bun.stringWidth(this.grapheme) : 0;
	}

	getStyleFlags() {
		return {
			bold: (this.style & STYLE_BOLD) !== 0,
			italic: (this.style & STYLE_ITALIC) !== 0,
			underline: (this.style & STYLE_UNDERLINE) !== 0,
			strikethrough: (this.style & STYLE_STRIKETHROUGH) !== 0,
			inverse: (this.style & STYLE_INVERSE) !== 0,
			blink: (this.style & STYLE_BLINK) !== 0,
			dim: (this.style & STYLE_DIM) !== 0,
			overline: (this.style & STYLE_OVERLINE) !== 0,
		};
	}

	static create(grapheme: string, cellStyle?: CellStyle): Cell | null {
		if (grapheme === "") {
			return null;
		}
		const fg = cellStyle?.fg ?? 0;
		const bg = cellStyle?.bg ?? 0;

		let styleFlags = 0;
		if (cellStyle?.bold) styleFlags |= STYLE_BOLD;
		if (cellStyle?.italic) styleFlags |= STYLE_ITALIC;
		if (cellStyle?.underline) styleFlags |= STYLE_UNDERLINE;
		if (cellStyle?.strikethrough) styleFlags |= STYLE_STRIKETHROUGH;
		if (cellStyle?.inverse) styleFlags |= STYLE_INVERSE;
		if (cellStyle?.blink) styleFlags |= STYLE_BLINK;
		if (cellStyle?.dim) styleFlags |= STYLE_DIM;
		if (cellStyle?.overline) styleFlags |= STYLE_OVERLINE;

		const cacheKey = `${grapheme}:${fg}:${bg}:${styleFlags}`;

		const cached = cache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const cell = new Cell(grapheme, cellStyle);
		cache.set(cacheKey, cell);
		return cell;
	}
}

export function createBuffer(rows: number, cols: number): CellBuffer {
	const buffer: CellBuffer = [];
	for (let row = 0; row < rows; row++) {
		const line: (Cell | null)[] = [];
		for (let col = 0; col < cols; col++) {
			line.push(null);
		}
		buffer.push(line);
	}
	return buffer;
}

export interface RendererCellStyle {
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

	resize(rows: number, cols: number): void {
		this.rows = rows;
		this.cols = cols;
	}

	clearPreviousBuffer(): void {
		this.previousBuffer = null;
	}

	beginFrame(): void {
		this.currentBuffer = createBuffer(this.rows, this.cols);
	}

	private setCell(
		row: number,
		col: number,
		char: string,
		style?: RendererCellStyle,
	): void {
		if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;

		let finalStyle = style;
		if (style && style.bg == null) {
			const existingCell = this.currentBuffer[row][col];
			if (existingCell) {
				finalStyle = {...style, bg: existingCell.bg};
			}
		}

		const newCell = Cell.create(char, finalStyle);
		this.currentBuffer[row][col] = newCell;
	}

	fillRect(
		x: number,
		y: number,
		width: number,
		height: number,
		bgColor?: number | null,
	): void {
		if (bgColor == null) {
			return;
		}

		const style: RendererCellStyle = {bg: bgColor};

		for (let row = y; row < y + height; row++) {
			for (let col = x; col < x + width; col++) {
				if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
					this.setCell(row, col, " ", style);
				}
			}
		}
	}

	setText(x: number, y: number, text: string, style?: RendererCellStyle): number {
		if (y < 0 || y >= this.rows) return x;

		let currentX = x;
		const segmenter = new Intl.Segmenter("en", {granularity: "grapheme"});
		const segments = Array.from(segmenter.segment(text));

		for (const segment of segments) {
			const char = segment.segment;
			const width = Bun.stringWidth(char);

			if (currentX + width > this.cols) break;

			this.setCell(y, currentX, char, style);
			currentX += width;
		}

		return currentX;
	}

	render(): string {
		const diffBuffer = createBuffer(this.rows, this.cols);

		if (!this.previousBuffer) {
			for (let row = 0; row < this.rows; row++) {
				for (let col = 0; col < this.cols; col++) {
					const currCell = this.currentBuffer[row][col];
					diffBuffer[row][col] = currCell;
				}
			}
		} else {
			const prevRows = this.previousBuffer.length;
			const prevCols = this.previousBuffer[0]?.length || 0;

			for (let row = 0; row < this.rows; row++) {
				for (let col = 0; col < this.cols; col++) {
					const prevCell =
						row < prevRows && col < prevCols
							? this.previousBuffer[row][col]
							: null;
					const currCell = this.currentBuffer[row][col];

					if (prevCell === null && currCell === null) {
						continue;
					}

					if (prevCell === null && currCell !== null) {
						diffBuffer[row][col] = currCell;
						continue;
					}

					if (prevCell !== null && currCell === null) {
						diffBuffer[row][col] = Cell.create(" ");
						continue;
					}

					if (!prevCell!.equals(currCell!)) {
						diffBuffer[row][col] = currCell!;
					}
				}
			}
		}

		const output = generateANSI(diffBuffer, this.colorDepth);
		this.previousBuffer = this.currentBuffer;
		return output;
	}
}

export function generateANSI(
	buffer: CellBuffer,
	colorDepth: ColorDepth = "rgb",
	clean: boolean = false,
): string {
	const rows = buffer.length;
	const cols = buffer[0]?.length || 0;

	let output = "";
	let cursorRow = 0;
	let cursorCol = 0;
	let previousCell: Cell | null = null;
	let hasContent = false;

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			if (buffer[row][col] !== null) {
				hasContent = true;
				break;
			}
		}
		if (hasContent) break;
	}

	if (hasContent && !clean) {
		output += "\x1b[?2026h"; 
		output += "\x1b[?25l"; 
		output += "\x1b[H"; 
	}

	const moveCursor = (targetRow: number, targetCol: number): string => {
		let moveOutput = "";
		const rowDiff = targetRow - cursorRow;

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

		if (rowDiff > 0) {
			if (targetCol === 0) {
				moveOutput += "\r\n".repeat(rowDiff);
			} else {
				moveOutput += "\r\n".repeat(rowDiff);
				moveOutput += `\x1b[${targetCol}C`;
			}
		} else if (targetCol !== cursorCol) {
			if (targetCol === 0) {
				moveOutput += "\r";
			} else {
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
				const r = (color >> 16) & 0xff;
				const g = (color >> 8) & 0xff;
				const b = color & 0xff;
				seq.push(prefix, 2, r, g, b);
				break;
			case "256":
				const colorIndex = rgbTo256(color);
				seq.push(prefix, 5, colorIndex);
				break;
			case "ansi":
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

		if (r === g && g === b) {
			if (r < 8) return 0;
			if (r > 248) return 15;
			return Math.round(((r - 8) / 247) * 23) + 232;
		}

		const r6 = Math.round((r / 255) * 5);
		const g6 = Math.round((g / 255) * 5);
		const b6 = Math.round((b / 255) * 5);
		return 16 + 36 * r6 + 6 * g6 + b6;
	};

	const rgbToBasic8 = (color: number): number => {
		const r = (color >> 16) & 0xff;
		const g = (color >> 8) & 0xff;
		const b = color & 0xff;

		let ansiColor = 0;
		if (r > 127) ansiColor |= 1;
		if (g > 127) ansiColor |= 2;
		if (b > 127) ansiColor |= 4;
		return ansiColor;
	};

	const getStyleDiff = (cell: Cell, prev: Cell | null): number[] => {
		if (!prev) {
			const seq: number[] = [];

			if (cell.fg !== 0) {
				seq.push(...emitColor(cell.fg, true));
			}
			if (cell.bg !== 0) {
				seq.push(...emitColor(cell.bg, false));
			}

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

		if (isDefault && !wasDefault) {
			seq.push(0);
			return seq;
		}

		if (cell.fg !== prev.fg) {
			if (cell.fg === 0) {
				seq.push(39);
			} else {
				seq.push(...emitColor(cell.fg, true));
			}
		}

		if (cell.bg !== prev.bg) {
			if (cell.bg === 0) {
				seq.push(49);
			} else {
				seq.push(...emitColor(cell.bg, false));
			}
		}

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

	let skipNextCol: number | null = null;

	for (let row = 0; row < rows; row++) {
		let rowHasContent = false;
		let rowHasAnsi = false;

		for (let col = 0; col < cols; col++) {
			const cell = buffer[row][col];

			if (cell === null) {
				continue;
			}

			rowHasContent = true;

			if (skipNextCol !== null && row === cursorRow && col === skipNextCol) {
				skipNextCol = null;
				continue;
			}
			skipNextCol = null;

			if (row !== cursorRow || col !== cursorCol) {
				output += moveCursor(row, col);
			}

			const styleSeq = getStyleDiff(cell, previousCell);
			if (styleSeq.length > 0) {
				output += `\x1b[${styleSeq.join(";")}m`;
				rowHasAnsi = true;
			}

			output += cell.grapheme;

			cursorCol += cell.width;
			previousCell = cell;

			if (cell.width === 2) {
				skipNextCol = col + 1;
			}
		}

		if (rowHasContent) {
			previousCell = null;
			if (rowHasAnsi) {
				output += "\x1b[0m";
			}
		}
	}

	if (hasContent && !clean) {
		output += "\x1b[?25h";
		output += "\x1b[?2026l";
	}

	return output;
}