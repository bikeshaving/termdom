import LRUCache from "./utils.js";
import {BOX_DRAWING, BorderEdgeStyle} from "./styles.js";

export type ColorDepth = "ansi" | "rgb" | "256";

const enum Color {
	Mask = 0xffffff,
}

const enum FGStyle {
	Bold = 0b00000001 << 24,
	Italic = 0b00000010 << 24,
	Underline = 0b00000100 << 24,
	Strikethrough = 0b00001000 << 24,
	Overline = 0b00010000 << 24,
}

const enum BGStyle {
	Inverse = 0b00000001 << 24,
	Blink = 0b00000010 << 24,
	Dim = 0b00000100 << 24,
}

const enum BorderMask {
	Top = 0x000000ff,
	Right = 0x0000ff00,
	Bottom = 0x00ff0000,
	Left = 0xff000000,
	Edge = 0xff,
	Style = 0b00001111,
}

const enum BorderShift {
	Top = 0,
	Right = 8,
	Bottom = 16,
	Left = 24,
}

const BORDER_EDGE_MASKS = [
	{shift: BorderShift.Top, mask: BorderMask.Top},
	{shift: BorderShift.Right, mask: BorderMask.Right},
	{shift: BorderShift.Bottom, mask: BorderMask.Bottom},
	{shift: BorderShift.Left, mask: BorderMask.Left},
];

// Edge extraction utilities
const getBorderEdge = (border: number, mask: number) => {
	const shift = Math.log2(mask & -mask);
	return (border & mask) >> shift;
};

const setBorderEdge = (border: number, mask: number, edgeValue: number) => {
	const shift = Math.log2(mask & -mask);
	return (border & ~mask) | ((edgeValue << shift) & mask);
};

const getEdgeStyle = (edgeValue: number) => edgeValue & BorderMask.Style;
const getEdgePresence = (edgeValue: number) => {
	const style = edgeValue & BorderMask.Style;
	return style !== BorderEdgeStyle.None && style !== BorderEdgeStyle.Hidden;
};
const getEdgeRounded = (edgeValue: number) =>
	(edgeValue & BorderEdgeStyle.Rounded) !== 0;

/**
 * Merge two border encodings, choosing the higher precedence style for each edge
 */
export function mergeBorderEncodings(
	existing: number,
	incoming: number,
): number {
	let merged = 0;

	for (const {mask} of BORDER_EDGE_MASKS) {
		const existingEdge = getBorderEdge(existing, mask);
		const incomingEdge = getBorderEdge(incoming, mask);

		if (!getEdgePresence(existingEdge)) {
			merged = setBorderEdge(merged, mask, incomingEdge);
		} else if (!getEdgePresence(incomingEdge)) {
			merged = setBorderEdge(merged, mask, existingEdge);
		} else {
			const existingStyle = getEdgeStyle(existingEdge);
			const incomingStyle = getEdgeStyle(incomingEdge);

			if (incomingStyle > existingStyle) {
				merged = setBorderEdge(merged, mask, incomingEdge);
			} else {
				merged = setBorderEdge(merged, mask, existingEdge);
			}
		}
	}

	return merged;
}

export type CellBuffer = Array<Array<Cell | null>>;

export interface CellStyle {
	grapheme?: string;
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
	border?: number;
}

export interface BorderStyle {
	top?: {width: number; style: "solid" | "double" | "none"; color?: number};
	right?: {width: number; style: "solid" | "double" | "none"; color?: number};
	bottom?: {
		width: number;
		style: "solid" | "double" | "none";
		color?: number;
	};
	left?: {width: number; style: "solid" | "double" | "none"; color?: number};
}

const cache = new LRUCache<string, Cell>(2 ** 12);

export class Cell {
	declare grapheme: string;
	declare fg: number;
	declare bg: number;
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
			throw new Error("Cell grapheme cannot be empty. Use null instead.");
		}

		this.grapheme = grapheme;

		let fg = (cellStyle?.fg ?? 0) & Color.Mask;
		if (cellStyle?.bold) fg |= FGStyle.Bold;
		if (cellStyle?.italic) fg |= FGStyle.Italic;
		if (cellStyle?.underline) fg |= FGStyle.Underline;
		if (cellStyle?.strikethrough) fg |= FGStyle.Strikethrough;
		if (cellStyle?.overline) fg |= FGStyle.Overline;
		this.fg = fg;

		let bg = (cellStyle?.bg ?? 0) & Color.Mask;
		if (cellStyle?.inverse) bg |= BGStyle.Inverse;
		if (cellStyle?.blink) bg |= BGStyle.Blink;
		if (cellStyle?.dim) bg |= BGStyle.Dim;
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
			bold: (this.fg & FGStyle.Bold) !== 0,
			italic: (this.fg & FGStyle.Italic) !== 0,
			underline: (this.fg & FGStyle.Underline) !== 0,
			strikethrough: (this.fg & FGStyle.Strikethrough) !== 0,
			overline: (this.fg & FGStyle.Overline) !== 0,
			inverse: (this.bg & BGStyle.Inverse) !== 0,
			blink: (this.bg & BGStyle.Blink) !== 0,
			dim: (this.bg & BGStyle.Dim) !== 0,
		};
	}

	getFgColor(): number {
		return this.fg & Color.Mask;
	}

	getBgColor(): number {
		return this.bg & Color.Mask;
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

		let fg = (cellStyle?.fg ?? 0) & Color.Mask;
		if (cellStyle?.bold) fg |= FGStyle.Bold;
		if (cellStyle?.italic) fg |= FGStyle.Italic;
		if (cellStyle?.underline) fg |= FGStyle.Underline;
		if (cellStyle?.strikethrough) fg |= FGStyle.Strikethrough;
		if (cellStyle?.overline) fg |= FGStyle.Overline;

		let bg = (cellStyle?.bg ?? 0) & Color.Mask;
		if (cellStyle?.inverse) bg |= BGStyle.Inverse;
		if (cellStyle?.blink) bg |= BGStyle.Blink;
		if (cellStyle?.dim) bg |= BGStyle.Dim;

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
		const line: Array<Cell | null> = [];
		for (let col = 0; col < cols; col++) {
			line.push(null);
		}
		buffer.push(line);
	}
	return buffer;
}

/**
 * Generate the appropriate box-drawing character for a cell based on its
 * border encoding
 */
export function getBorderChar(borderEncoding: number): string {
	const topEdge = getBorderEdge(borderEncoding, BorderMask.Top);
	const rightEdge = getBorderEdge(borderEncoding, BorderMask.Right);
	const bottomEdge = getBorderEdge(borderEncoding, BorderMask.Bottom);
	const leftEdge = getBorderEdge(borderEncoding, BorderMask.Left);

	const hasTop = getEdgePresence(topEdge);
	const hasRight = getEdgePresence(rightEdge);
	const hasBottom = getEdgePresence(bottomEdge);
	const hasLeft = getEdgePresence(leftEdge);

	if (!hasTop && !hasRight && !hasBottom && !hasLeft) {
		return " ";
	}

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

	let charSet;
	switch (dominantStyle) {
		case BorderEdgeStyle.Solid:
			charSet = hasRounded ? BOX_DRAWING.lightRounded : BOX_DRAWING.light;
			break;
		case BorderEdgeStyle.Double:
			charSet = BOX_DRAWING.double;
			break;
		case BorderEdgeStyle.Dashed:
			charSet = BOX_DRAWING.dashed;
			break;
		case BorderEdgeStyle.Dotted:
			charSet = BOX_DRAWING.dotted;
			break;
		case BorderEdgeStyle.Groove:
			charSet = BOX_DRAWING.heavy;
			break;
		case BorderEdgeStyle.Ridge:
			charSet = BOX_DRAWING.light;
			break;
		case BorderEdgeStyle.Inset:
		case BorderEdgeStyle.Outset:
			charSet = hasRounded ? BOX_DRAWING.lightRounded : BOX_DRAWING.light;
			break;
		case BorderEdgeStyle.Hidden:
		case BorderEdgeStyle.None:
			return " ";
		default:
			charSet = BOX_DRAWING.light;
			break;
	}

	// Corner characters
	if (hasTop && hasLeft && !hasRight && !hasBottom) {
		return charSet.topLeft;
	}
	if (hasTop && hasRight && !hasLeft && !hasBottom) {
		return charSet.topRight;
	}
	if (hasBottom && hasLeft && !hasTop && !hasRight) {
		return charSet.bottomLeft;
	}
	if (hasBottom && hasRight && !hasTop && !hasLeft) {
		return charSet.bottomRight;
	}

	// T-junction characters
	if (hasTop && hasBottom && hasLeft && !hasRight) {
		return charSet.rightTee;
	}
	if (hasTop && hasBottom && hasRight && !hasLeft) {
		return charSet.leftTee;
	}
	if (hasLeft && hasRight && hasTop && !hasBottom) {
		return charSet.topTee;
	}
	if (hasLeft && hasRight && hasBottom && !hasTop) {
		return charSet.bottomTee;
	}

	// Cross junction
	if (hasTop && hasRight && hasBottom && hasLeft) {
		return charSet.cross;
	}

	// Straight lines
	if ((hasTop || hasBottom) && !hasLeft && !hasRight) {
		return charSet.horizontal;
	}
	if ((hasLeft || hasRight) && !hasTop && !hasBottom) {
		return charSet.vertical;
	}

	return " ";
}

function rgbTo256(color: number): number {
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
}

function rgbToBasic8(color: number): number {
	const r = (color >> 16) & 0xff;
	const g = (color >> 8) & 0xff;
	const b = color & 0xff;

	let ansiColor = 0;
	if (r > 127) ansiColor |= 1;
	if (g > 127) ansiColor |= 2;
	if (b > 127) ansiColor |= 4;
	return ansiColor;
}

function emitColor(
	color: number,
	isFg: boolean,
	colorDepth: ColorDepth,
): number[] {
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
}

function scrollBuffer(
	source: CellBuffer,
	scroll: number, // positive = scroll down, negative = scroll up
): CellBuffer {
	const rows = source.length;
	const cols = source[0]?.length || 0;
	const dest = createBuffer(rows, cols);

	for (let row = 0; row < rows; row++) {
		const sourceRow = row + scroll;
		if (sourceRow >= 0 && sourceRow < rows) {
			for (let col = 0; col < cols; col++) {
				dest[row][col] = source[sourceRow][col];
			}
		}
		// Cells outside bounds remain null (createBuffer default)
	}

	return dest;
}

function getStyleDiff(
	cell: Cell,
	prev: Cell | null,
	colorDepth: ColorDepth,
): number[] {
	if (!prev) {
		const seq: number[] = [];

		const fgColor = cell.getFgColor();
		const bgColor = cell.getBgColor();

		if (fgColor !== 0) {
			seq.push(...emitColor(fgColor, true, colorDepth));
		}
		if (bgColor !== 0) {
			seq.push(...emitColor(bgColor, false, colorDepth));
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
			seq.push(...emitColor(fgColor, true, colorDepth));
		}
	}

	if (cell.bg !== prev.bg) {
		const bgColor = cell.getBgColor();
		if (bgColor === 0) {
			seq.push(49);
		} else {
			seq.push(...emitColor(bgColor, false, colorDepth));
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
}

function moveCursor(
	currentRow: number,
	currentCol: number,
	targetRow: number,
	targetCol: number,
): [string, number, number] {
	let moveOutput = "";
	const rowDiff = targetRow - currentRow;

	if (rowDiff < 0) {
		throw new Error(
			`Trying to move up from row ${currentRow} to ${targetRow} - this should never happen in row-major processing`,
		);
	}
	if (targetCol < currentCol && rowDiff === 0) {
		throw new Error(
			`Trying to move left from col ${currentCol} to ${targetCol} in row ${currentRow} - this should never happen`,
		);
	}

	if (rowDiff > 0) {
		if (targetCol === 0) {
			moveOutput += "\r\n".repeat(rowDiff);
		} else {
			moveOutput += "\r\n".repeat(rowDiff);
			moveOutput += `\x1b[${targetCol}C`; // CUF - Cursor Forward n columns
		}
	} else if (targetCol !== currentCol) {
		if (targetCol === 0) {
			moveOutput += "\r";
		} else {
			moveOutput += `\x1b[${targetCol - currentCol}C`; // CUF - Cursor Forward n columns
		}
	}

	return [moveOutput, targetRow, targetCol];
}

export function generateANSI(
	buffer: CellBuffer,
	colorDepth: ColorDepth = "rgb",
	renderedLines?: Set<number>,
): string {
	const rows = buffer.length;
	const cols = buffer[0]?.length || 0;

	let output = "";
	let cursorRow = 0;
	let cursorCol = 0;
	let prevCell: Cell | null = null;

	let skipNextCol: number | null = null;

	for (let row = 0; row < rows; row++) {
		let rowHasContent = false;
		let rowHasAnsi = false;
		let isFirstRenderOfLine = false;

		for (let col = 0; col < cols; col++) {
			if (buffer[row][col] !== null) {
				rowHasContent = true;
				break;
			}
		}

		if (rowHasContent && renderedLines) {
			isFirstRenderOfLine = !renderedLines.has(row);
			if (isFirstRenderOfLine) {
				renderedLines.add(row);
			}
		}

		for (let col = 0; col < cols; col++) {
			const cell = buffer[row][col];

			if (cell === null) {
				continue;
			}

			if (skipNextCol !== null && row === cursorRow && col === skipNextCol) {
				skipNextCol = null;
				continue;
			}

			skipNextCol = null;

			if (row !== cursorRow || col !== cursorCol) {
				const [moveSeq, newRow, newCol] = moveCursor(
					cursorRow,
					cursorCol,
					row,
					col,
				);
				output += moveSeq;
				cursorRow = newRow;
				cursorCol = newCol;
			}

			if (isFirstRenderOfLine) {
				output += "\r\x1b[K"; // CR + EL - Carriage Return + Erase Line
				if (col > 0) {
					output += `\x1b[${col}C`; // CUF - Cursor Forward n columns
				}
				cursorCol = col;
				isFirstRenderOfLine = false;
			}

			const styleSeq = getStyleDiff(cell, prevCell, colorDepth);
			if (styleSeq.length > 0) {
				output += `\x1b[${styleSeq.join(";")}m`; // SGR - Select Graphic Rendition
				rowHasAnsi = true;
			}

			let charToOutput;
			if (cell.border > 0) {
				charToOutput = getBorderChar(cell.border);
			} else {
				charToOutput = cell.grapheme;
			}

			output += charToOutput;
			cursorCol += cell.width;
			prevCell = cell;

			if (cell.width === 2) {
				skipNextCol = col + 1;
			}
		}

		if (rowHasContent) {
			prevCell = null;
			if (rowHasAnsi) {
				output += "\x1b[0m"; // SGR - Reset all attributes
			}
		}
	}

	if (output && !output.endsWith("\n")) {
		output += "\r\n";
	}

	return output;
}

export class DrawingContext {
	buffer: CellBuffer;
	rows: number;
	cols: number;
	viewportOffset: number;

	constructor(
		buffer: CellBuffer,
		rows: number,
		cols: number,
		viewportOffset: number,
	) {
		this.buffer = buffer;
		this.rows = rows;
		this.cols = cols;
		this.viewportOffset = viewportOffset;
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

		const style: CellStyle = {bg: bgColor};

		for (let row = y; row < y + height; row++) {
			for (let col = x; col < x + width; col++) {
				this.#setCell(row, col, " ", style);
			}
		}
	}

	setText(x: number, y: number, text: string, style?: CellStyle): number {
		let currentX = x;
		const segmenter = new Intl.Segmenter("en", {granularity: "grapheme"});
		const segments = Array.from(segmenter.segment(text));

		for (const segment of segments) {
			const char = segment.segment;
			const width = Bun.stringWidth(char);

			if (currentX + width > this.cols) {
				break;
			}

			this.#setCell(y, currentX, char, style);
			currentX += width;
		}

		return currentX;
	}

	drawBorder(
		x: number,
		y: number,
		width: number,
		height: number,
		borderStyles: {
			topEdge: number;
			rightEdge: number;
			bottomEdge: number;
			leftEdge: number;
			hasAnyBorder: boolean;
		},
		style?: CellStyle,
	): void {
		if (width < 2 || height < 2 || !borderStyles.hasAnyBorder) return;

		const right = x + width - 1;
		const bottom = y + height - 1;

		// Top edge
		if (borderStyles.topEdge > 0 && y >= 0 && y < this.rows) {
			for (let col = x; col <= right; col++) {
				if (col >= 0 && col < this.cols) {
					const cornerLeft = col === x && borderStyles.leftEdge > 0;
					const cornerRight = col === right && borderStyles.rightEdge > 0;
					const encoding = this.#calculateEdgeEncoding(
						borderStyles,
						true, // hasTop
						cornerRight,
						false, // hasBottom
						cornerLeft,
					);
					this.#setBorderCell(col, y, encoding, style);
				}
			}
		}

		// Bottom edge
		if (
			borderStyles.bottomEdge > 0 &&
			bottom !== y &&
			bottom >= 0 &&
			bottom < this.rows
		) {
			for (let col = x; col <= right; col++) {
				if (col >= 0 && col < this.cols) {
					const cornerLeft = col === x && borderStyles.leftEdge > 0;
					const cornerRight = col === right && borderStyles.rightEdge > 0;
					const encoding = this.#calculateEdgeEncoding(
						borderStyles,
						false, // hasTop
						cornerRight,
						true, // hasBottom
						cornerLeft,
					);
					this.#setBorderCell(col, bottom, encoding, style);
				}
			}
		}

		// Left edge (excluding corners)
		if (borderStyles.leftEdge > 0 && x >= 0 && x < this.cols) {
			for (let row = y + 1; row < bottom; row++) {
				if (row >= 0 && row < this.rows) {
					const encoding = this.#calculateEdgeEncoding(
						borderStyles,
						false, // hasTop
						false, // hasRight
						false, // hasBottom
						true, // hasLeft
					);
					this.#setBorderCell(x, row, encoding, style);
				}
			}
		}

		// Right edge (excluding corners)
		if (
			borderStyles.rightEdge > 0 &&
			right !== x &&
			right >= 0 &&
			right < this.cols
		) {
			for (let row = y + 1; row < bottom; row++) {
				if (row >= 0 && row < this.rows) {
					const encoding = this.#calculateEdgeEncoding(
						borderStyles,
						false, // hasTop
						true, // hasRight
						false, // hasBottom
						false, // hasLeft
					);
					this.#setBorderCell(right, row, encoding, style);
				}
			}
		}
	}

	#setCell(row: number, col: number, char: string, style?: CellStyle): void {
		const terminalRow = row + this.viewportOffset;

		if (
			terminalRow < 0 ||
			terminalRow >= this.rows ||
			col < 0 ||
			col >= this.cols
		)
			return;

		row = terminalRow;

		let finalStyle = style;
		if (style && style.bg == null) {
			const existingCell = this.buffer[row][col];
			if (existingCell) {
				finalStyle = {...style, bg: existingCell.bg};
			}
		}

		const cellStyle = finalStyle
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
		this.buffer[row][col] = newCell;
	}

	#calculateEdgeEncoding(
		borderStyles: {
			topEdge: number;
			rightEdge: number;
			bottomEdge: number;
			leftEdge: number;
		},
		hasTop: boolean,
		hasRight: boolean,
		hasBottom: boolean,
		hasLeft: boolean,
	): number {
		let encoding = 0;

		if (hasTop && borderStyles.topEdge > 0) {
			encoding |= borderStyles.topEdge << BorderShift.Top;
		}
		if (hasRight && borderStyles.rightEdge > 0) {
			encoding |= borderStyles.rightEdge << BorderShift.Right;
		}
		if (hasBottom && borderStyles.bottomEdge > 0) {
			encoding |= borderStyles.bottomEdge << BorderShift.Bottom;
		}
		if (hasLeft && borderStyles.leftEdge > 0) {
			encoding |= borderStyles.leftEdge << BorderShift.Left;
		}

		return encoding;
	}

	#setBorderCell(
		x: number,
		y: number,
		borderEncoding: number,
		style?: CellStyle,
	): void {
		const terminalY = y;

		if (terminalY < 0 || terminalY >= this.rows || x < 0 || x >= this.cols) {
			return;
		}

		y = terminalY;

		const existingCell = this.buffer[y][x];

		if (existingCell && existingCell.border > 0) {
			const mergedBorder = mergeBorderEncodings(
				existingCell.border,
				borderEncoding,
			);
			this.buffer[y][x] = new Cell({
				grapheme: " ",
				fg: style?.fg ?? undefined,
				bg: style?.bg ?? undefined,
				bold: style?.bold,
				italic: style?.italic,
				underline: style?.underline,
				strikethrough: style?.strikethrough,
				inverse: style?.inverse,
				dim: style?.dim,
				blink: style?.blink,
				overline: style?.overline,
				border: mergedBorder,
			});
		} else {
			this.buffer[y][x] = new Cell({
				grapheme: " ",
				fg: style?.fg ?? undefined,
				bg: style?.bg ?? undefined,
				bold: style?.bold,
				italic: style?.italic,
				underline: style?.underline,
				strikethrough: style?.strikethrough,
				inverse: style?.inverse,
				dim: style?.dim,
				blink: style?.blink,
				overline: style?.overline,
				border: borderEncoding,
			});
		}
	}
}

export class Renderer {
	#prevBuffer: CellBuffer | null = null;
	#renderedLines: Set<number> = new Set();
	#prevOffset: number = 0;
	#rows: number;
	#cols: number;
	#colorDepth: ColorDepth;

	constructor(rows: number, cols: number, colorDepth: ColorDepth = "rgb") {
		this.#rows = rows;
		this.#cols = cols;
		this.#colorDepth = colorDepth;
	}

	resize(rows: number, cols: number): void {
		this.#rows = rows;
		this.#cols = cols;
	}

	clearPreviousBuffer(): void {
		this.#prevBuffer = null;
		this.#prevOffset = 0;
	}

	renderFrame(
		offset: number,
		drawCallback: (ctx: DrawingContext) => void,
		cursorPosition?: number,
	): string {
		// Setup: Create new frame buffer
		const nextBuffer = createBuffer(this.#rows, this.#cols);

		// Create drawing context and execute drawing operations
		const context = new DrawingContext(
			nextBuffer,
			this.#rows,
			this.#cols,
			offset,
		);
		drawCallback(context);

		// Generate output: Transform previous buffer for scroll optimization
		this.#transformBufferForScroll(offset);

		// Create diff buffer
		const diffBuffer = createBuffer(this.#rows, this.#cols);
		if (!this.#prevBuffer) {
			for (let row = 0; row < this.#rows; row++) {
				for (let col = 0; col < this.#cols; col++) {
					const currCell = nextBuffer[row][col];
					diffBuffer[row][col] = currCell;
				}
			}
		} else {
			const prevRows = this.#prevBuffer.length;
			const prevCols = this.#prevBuffer[0]?.length || 0;

			for (let row = 0; row < this.#rows; row++) {
				for (let col = 0; col < this.#cols; col++) {
					const prevCell =
						row < prevRows && col < prevCols
							? this.#prevBuffer[row][col]
							: null;
					const currCell = nextBuffer[row][col];

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

		// Generate scroll commands and check for content
		const scrollCommands = this.#generateScrollCommands(offset);
		let hasContent = false;

		for (let row = 0; row < this.#rows; row++) {
			for (let col = 0; col < this.#cols; col++) {
				if (diffBuffer[row][col] !== null) {
					hasContent = true;
					break;
				}
			}
			if (hasContent) break;
		}

		// Build output with proper framing
		let prefix = "";
		let suffix = "";
		if (hasContent) {
			prefix += "\x1b[?25l"; // DECTCEM - Hide cursor
			prefix += "\x1b[?2026h"; // Synchronized output mode (start)

			// Add scroll commands if provided
			if (scrollCommands) {
				prefix += scrollCommands;
			}

			// Add cursor positioning
			if (cursorPosition !== undefined) {
				// Explicit cursor position provided (e.g., from cursor detection)
				prefix += `\x1b[${cursorPosition + 1};1H`; // CUP - Cursor Position (row;col)
			} else if (offset > 0) {
				// Position based on viewport offset
				prefix += `\x1b[${offset + 1};1H`; // CUP - Cursor Position (row;col)
			} else if (offset === 0 && this.#prevBuffer !== null) {
				// Home position for subsequent renders
				prefix += "\x1b[H"; // CUP - Cursor Home Position
			}

			suffix += "\x1b[?25h"; // DECTCEM - Show cursor
			suffix += "\x1b[?2026l"; // Synchronized output mode (end)
		}

		// Generate ANSI and finalize
		const output = generateANSI(
			diffBuffer,
			this.#colorDepth,
			this.#renderedLines,
		);

		// Update state for next frame
		this.#prevBuffer = nextBuffer;
		this.#prevOffset = offset;

		return prefix + output + suffix;
	}

	#generateScrollCommands(nextOffset: number): string {
		if (!this.#prevBuffer) {
			return "";
		}

		const offsetDelta = nextOffset - this.#prevOffset;

		if (offsetDelta === 0) {
			return "";
		}

		if (offsetDelta > 0) {
			return `\x1b[${offsetDelta}S`; // SU - Scroll Up n lines
		} else {
			return `\x1b[${Math.abs(offsetDelta)}T`; // SD - Scroll Down n lines
		}
	}

	#transformBufferForScroll(nextOffset: number): void {
		if (!this.#prevBuffer) return;

		const offsetDelta = nextOffset - this.#prevOffset;
		if (offsetDelta === 0) return;

		this.#prevBuffer = scrollBuffer(this.#prevBuffer, offsetDelta);
	}
}
