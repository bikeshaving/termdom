/**
 * ANSI terminal rendering and cell buffer management
 */

import LRUCache from "./utils.js";

export type ColorDepth = "ansi" | "rgb" | "256";

// Color masks
const COLOR_MASK = 0xffffff; // 24-bit RGB color

// Style flags packed into fg field (bits 24-31)
const FG_STYLE_BOLD = 1 << 24;
const FG_STYLE_ITALIC = 1 << 25;
const FG_STYLE_UNDERLINE = 1 << 26;
const FG_STYLE_STRIKETHROUGH = 1 << 27;
const FG_STYLE_OVERLINE = 1 << 28;

// Style flags packed into bg field (bits 24-31)
const BG_STYLE_INVERSE = 1 << 24;
const BG_STYLE_BLINK = 1 << 25;
const BG_STYLE_DIM = 1 << 26;
// TODO:
//const BG_STYLE_INVISIBLE = 1 << 27;

// Border constants (32-bit field encoding - 8 bits per edge)
// Edge positions: [8 bits top][8 bits right][8 bits bottom][8 bits left]
const BORDER_EDGE_TOP_SHIFT = 24;
const BORDER_EDGE_RIGHT_SHIFT = 16;
const BORDER_EDGE_BOTTOM_SHIFT = 8;
const BORDER_EDGE_LEFT_SHIFT = 0;

// Per-edge 8-bit encoding: [3 bits style][1 bit presence][1 bit rounded][3 bits reserved]
const BORDER_STYLE_NONE = 0;
const BORDER_STYLE_SOLID = 1;
const BORDER_STYLE_DOUBLE = 2;
const BORDER_STYLE_DASHED = 3;
const BORDER_STYLE_DOTTED = 4;
const BORDER_STYLE_GROOVE = 5;
const BORDER_STYLE_RIDGE = 6;
const BORDER_STYLE_MASK = 7;

const BORDER_EDGE_PRESENCE = 1 << 3;
const BORDER_EDGE_ROUNDED = 1 << 4;
const BORDER_EDGE_MASK = 0xff;

// Edge extraction utilities
const getBorderEdge = (border: number, shift: number) =>
	(border >> shift) & BORDER_EDGE_MASK;
const setBorderEdge = (border: number, shift: number, edgeValue: number) =>
	(border & ~(BORDER_EDGE_MASK << shift)) |
	((edgeValue & BORDER_EDGE_MASK) << shift);

// Style extraction from edge
const getEdgeStyle = (edgeValue: number) => edgeValue & BORDER_STYLE_MASK;
const getEdgePresence = (edgeValue: number) =>
	(edgeValue & BORDER_EDGE_PRESENCE) !== 0;
const getEdgeRounded = (edgeValue: number) =>
	(edgeValue & BORDER_EDGE_ROUNDED) !== 0;

// Border style precedence for merging (higher number = higher precedence)
const BORDER_STYLE_PRECEDENCE: Record<number, number> = {
	[BORDER_STYLE_DOUBLE]: 6, // Highest precedence
	[BORDER_STYLE_SOLID]: 5,
	[BORDER_STYLE_GROOVE]: 4,
	[BORDER_STYLE_RIDGE]: 3,
	[BORDER_STYLE_DASHED]: 2,
	[BORDER_STYLE_DOTTED]: 1, // Lowest precedence
	[BORDER_STYLE_NONE]: 0,
};

/**
 * Merge two border encodings, choosing the higher precedence style for each edge
 */
export function mergeBorderEncodings(
	existing: number,
	incoming: number,
): number {
	let merged = 0;

	// Process each edge
	for (const shift of [
		BORDER_EDGE_TOP_SHIFT,
		BORDER_EDGE_RIGHT_SHIFT,
		BORDER_EDGE_BOTTOM_SHIFT,
		BORDER_EDGE_LEFT_SHIFT,
	]) {
		const existingEdge = getBorderEdge(existing, shift);
		const incomingEdge = getBorderEdge(incoming, shift);

		// If only one has the edge, use it
		if (!getEdgePresence(existingEdge)) {
			merged = setBorderEdge(merged, shift, incomingEdge);
		} else if (!getEdgePresence(incomingEdge)) {
			merged = setBorderEdge(merged, shift, existingEdge);
		} else {
			// Both have the edge - choose based on style precedence
			const existingStyle = getEdgeStyle(existingEdge);
			const incomingStyle = getEdgeStyle(incomingEdge);

			const existingPrecedence = BORDER_STYLE_PRECEDENCE[existingStyle] || 0;
			const incomingPrecedence = BORDER_STYLE_PRECEDENCE[incomingStyle] || 0;

			if (incomingPrecedence > existingPrecedence) {
				merged = setBorderEdge(merged, shift, incomingEdge);
			} else {
				merged = setBorderEdge(merged, shift, existingEdge);
			}
		}
	}

	return merged;
}

export type CellBuffer = Array<Array<Cell | null>>;

export interface CellStyle {
	grapheme?: string;
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
	border?: number;
}

export interface BorderStyle {
	top?: {width: number; style: "solid" | "double" | "none"; color?: number};
	right?: {width: number; style: "solid" | "double" | "none"; color?: number};
	bottom?: {width: number; style: "solid" | "double" | "none"; color?: number};
	left?: {width: number; style: "solid" | "double" | "none"; color?: number};
}

const cache = new LRUCache<string, Cell>(2 ** 12);

export class Cell {
	declare grapheme: string;
	declare fg: number; // RGB color (24-bit) + style flags (8-bit)
	declare bg: number; // RGB color (24-bit) + style flags (8-bit)
	declare border: number;

	constructor(options: string | CellStyle) {
		let grapheme: string;
		let cellStyle: CellStyle | undefined;

		if (typeof options === "string") {
			grapheme = options;
			cellStyle = undefined;
		} else {
			grapheme = options.grapheme ?? "┼";
			cellStyle = options;
		}

		if (grapheme === "") {
			throw new Error(
				"Cell grapheme cannot be empty - use null for empty cells",
			);
		}

		this.grapheme = grapheme;

		// Pack fg color and style flags into fg field
		let fg = (cellStyle?.fg ?? 0) & COLOR_MASK;
		if (cellStyle?.bold) fg |= FG_STYLE_BOLD;
		if (cellStyle?.italic) fg |= FG_STYLE_ITALIC;
		if (cellStyle?.underline) fg |= FG_STYLE_UNDERLINE;
		if (cellStyle?.strikethrough) fg |= FG_STYLE_STRIKETHROUGH;
		if (cellStyle?.overline) fg |= FG_STYLE_OVERLINE;
		this.fg = fg;

		// Pack bg color and style flags into bg field
		let bg = (cellStyle?.bg ?? 0) & COLOR_MASK;
		if (cellStyle?.inverse) bg |= BG_STYLE_INVERSE;
		if (cellStyle?.blink) bg |= BG_STYLE_BLINK;
		if (cellStyle?.dim) bg |= BG_STYLE_DIM;
		this.bg = bg;

		this.border = cellStyle?.border ?? 0;

		Object.freeze(this);
	}

	equals(other: Cell): boolean {
		return (
			this.grapheme === other.grapheme &&
			this.fg === other.fg &&
			this.bg === other.bg &&
			this.border === other.border
		);
	}

	styleEquals(other: Cell): boolean {
		return (
			this.fg === other.fg &&
			this.bg === other.bg &&
			this.border === other.border
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
			bold: (this.fg & FG_STYLE_BOLD) !== 0,
			italic: (this.fg & FG_STYLE_ITALIC) !== 0,
			underline: (this.fg & FG_STYLE_UNDERLINE) !== 0,
			strikethrough: (this.fg & FG_STYLE_STRIKETHROUGH) !== 0,
			overline: (this.fg & FG_STYLE_OVERLINE) !== 0,
			inverse: (this.bg & BG_STYLE_INVERSE) !== 0,
			blink: (this.bg & BG_STYLE_BLINK) !== 0,
			dim: (this.bg & BG_STYLE_DIM) !== 0,
		};
	}

	getFgColor(): number {
		return this.fg & COLOR_MASK;
	}

	getBgColor(): number {
		return this.bg & COLOR_MASK;
	}

	static create(options: string | CellStyle): Cell | null {
		let grapheme: string;
		let cellStyle: CellStyle | undefined;

		if (typeof options === "string") {
			if (options === "") return null;
			grapheme = options;
			cellStyle = undefined;
		} else {
			grapheme = options.grapheme ?? "┼";
			if (grapheme === "") return null;
			cellStyle = options;
		}

		// Pack style flags into fg/bg fields for caching
		let fg = (cellStyle?.fg ?? 0) & COLOR_MASK;
		if (cellStyle?.bold) fg |= FG_STYLE_BOLD;
		if (cellStyle?.italic) fg |= FG_STYLE_ITALIC;
		if (cellStyle?.underline) fg |= FG_STYLE_UNDERLINE;
		if (cellStyle?.strikethrough) fg |= FG_STYLE_STRIKETHROUGH;
		if (cellStyle?.overline) fg |= FG_STYLE_OVERLINE;

		let bg = (cellStyle?.bg ?? 0) & COLOR_MASK;
		if (cellStyle?.inverse) bg |= BG_STYLE_INVERSE;
		if (cellStyle?.blink) bg |= BG_STYLE_BLINK;
		if (cellStyle?.dim) bg |= BG_STYLE_DIM;

		const border = cellStyle?.border ?? 0;
		const cacheKey = `${grapheme}:${fg}:${bg}:${border}`;

		const cached = cache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const cell = new Cell(options);
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
	private writtenLines: Set<number> = new Set();

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

	private clearLine(y: number): void {
		if (y < 0 || y >= this.rows) return;
		const row = this.currentBuffer[y];
		for (let x = 0; x < this.cols; x++) {
			row[x] = new Cell(" ");
		}
	}

	beginFrame(): void {
		this.currentBuffer = createBuffer(this.rows, this.cols);
		this.writtenLines = new Set();
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

		// Convert RendererCellStyle to CellStyle by filtering out null values
		const cellStyle: CellStyle | undefined = finalStyle
			? {
					fg: finalStyle.fg ?? undefined,
					bg: finalStyle.bg ?? undefined,
					bold: finalStyle.bold,
					italic: finalStyle.italic,
					underline: finalStyle.underline,
					strikethrough: finalStyle.strikethrough,
					inverse: finalStyle.inverse,
					dim: finalStyle.dim,
					blink: finalStyle.blink,
					overline: finalStyle.overline,
				}
			: undefined;

		const newCell = Cell.create({
			grapheme: char,
			...cellStyle,
		});
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

	setText(
		x: number,
		y: number,
		text: string,
		style?: RendererCellStyle,
	): number {
		if (y < 0 || y >= this.rows) return x;

		// Clear the line on first write to prevent text overlap
		if (!this.writtenLines.has(y)) {
			this.clearLine(y);
			this.writtenLines.add(y);
		}

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

import {BOX_DRAWING} from "./styles.js";

/**
 * Generate the appropriate box-drawing character for a cell based on its border encoding
 * Uses per-edge encoding to determine proper junction characters
 */
export function getBorderChar(borderEncoding: number): string {
	// Extract edge information
	const topEdge = getBorderEdge(borderEncoding, BORDER_EDGE_TOP_SHIFT);
	const rightEdge = getBorderEdge(borderEncoding, BORDER_EDGE_RIGHT_SHIFT);
	const bottomEdge = getBorderEdge(borderEncoding, BORDER_EDGE_BOTTOM_SHIFT);
	const leftEdge = getBorderEdge(borderEncoding, BORDER_EDGE_LEFT_SHIFT);

	// Check which edges are present
	const hasTop = getEdgePresence(topEdge);
	const hasRight = getEdgePresence(rightEdge);
	const hasBottom = getEdgePresence(bottomEdge);
	const hasLeft = getEdgePresence(leftEdge);

	// If no edges, return space
	if (!hasTop && !hasRight && !hasBottom && !hasLeft) {
		return " ";
	}

	// Determine dominant style for character set selection
	// Priority: double > solid > groove > ridge > dashed > dotted
	const styles = [
		hasTop ? getEdgeStyle(topEdge) : 0,
		hasRight ? getEdgeStyle(rightEdge) : 0,
		hasBottom ? getEdgeStyle(bottomEdge) : 0,
		hasLeft ? getEdgeStyle(leftEdge) : 0,
	].filter((s) => s > 0);

	const dominantStyle = Math.max(...styles);
	const hasRounded =
		(hasTop && getEdgeRounded(topEdge)) ||
		(hasRight && getEdgeRounded(rightEdge)) ||
		(hasBottom && getEdgeRounded(bottomEdge)) ||
		(hasLeft && getEdgeRounded(leftEdge));

	// Choose character set based on dominant style
	let charSet;
	switch (dominantStyle) {
		case 1:
			charSet = hasRounded ? BOX_DRAWING.lightRounded : BOX_DRAWING.light;
			break; // solid
		case 2:
			charSet = BOX_DRAWING.double;
			break; // double (can't be rounded)
		case 3:
			charSet = BOX_DRAWING.dashed;
			break; // dashed
		case 4:
			charSet = BOX_DRAWING.dotted;
			break; // dotted
		case 5:
			charSet = BOX_DRAWING.heavy;
			break; // groove (using heavy)
		case 6:
			charSet = BOX_DRAWING.light;
			break; // ridge (using light)
		default:
			charSet = BOX_DRAWING.light;
			break;
	}

	// Corner characters
	if (hasTop && hasLeft && !hasRight && !hasBottom) {
		return charSet.topLeft; // ┌
	}
	if (hasTop && hasRight && !hasLeft && !hasBottom) {
		return charSet.topRight; // ┐
	}
	if (hasBottom && hasLeft && !hasTop && !hasRight) {
		return charSet.bottomLeft; // └
	}
	if (hasBottom && hasRight && !hasTop && !hasLeft) {
		return charSet.bottomRight; // ┘
	}

	// T-junction characters
	if (hasTop && hasBottom && hasLeft && !hasRight) {
		return charSet.leftTee;
	}
	if (hasTop && hasBottom && hasRight && !hasLeft) {
		return charSet.rightTee;
	}
	if (hasLeft && hasRight && hasTop && !hasBottom) {
		return charSet.bottomTee;
	}
	if (hasLeft && hasRight && hasBottom && !hasTop) {
		return charSet.topTee;
	}

	// Cross junction
	if (hasTop && hasRight && hasBottom && hasLeft) {
		return charSet.cross;
	}

	// Straight lines
	if ((hasTop || hasBottom) && !hasLeft && !hasRight) {
		return charSet.horizontal; // Top/bottom edges use horizontal lines ─
	}
	if ((hasLeft || hasRight) && !hasTop && !hasBottom) {
		return charSet.vertical; // Left/right edges use vertical lines │
	}

	// Default to space for no borders
	return " ";
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
			case "rgb": {
				const r = (color >> 16) & 0xff;
				const g = (color >> 8) & 0xff;
				const b = color & 0xff;
				seq.push(prefix, 2, r, g, b);
				break;
			}
			case "256": {
				const colorIndex = rgbTo256(color);
				seq.push(prefix, 5, colorIndex);
				break;
			}
			case "ansi": {
				const basicColor = rgbToBasic8(color);
				seq.push((isFg ? 30 : 40) + basicColor);
				break;
			}
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

			const fgColor = cell.getFgColor();
			const bgColor = cell.getBgColor();

			if (fgColor !== 0) {
				seq.push(...emitColor(fgColor, true));
			}
			if (bgColor !== 0) {
				seq.push(...emitColor(bgColor, false));
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
		const isDefault = cell.fg === 0 && cell.bg === 0;
		const wasDefault = prev.fg === 0 && prev.bg === 0;

		if (isDefault && !wasDefault) {
			seq.push(0);
			return seq;
		}

		if (cell.fg !== prev.fg) {
			const fgColor = cell.getFgColor();
			if (fgColor === 0) {
				seq.push(39);
			} else {
				seq.push(...emitColor(fgColor, true));
			}
		}

		if (cell.bg !== prev.bg) {
			const bgColor = cell.getBgColor();
			if (bgColor === 0) {
				seq.push(49);
			} else {
				seq.push(...emitColor(bgColor, false));
			}
		}

		if (cell.fg !== prev.fg || cell.bg !== prev.bg) {
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

			// Use border character if cell has border, otherwise use grapheme
			if (cell.border > 0) {
				const borderChar = getBorderChar(cell.border);
				output += borderChar;
			} else {
				output += cell.grapheme;
			}

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

	// Always end with newline for proper terminal output
	if (hasContent && !output.endsWith("\n")) {
		output += "\n";
	}

	return output;
}
