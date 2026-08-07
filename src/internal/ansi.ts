import {BOX_DRAWING, BorderEdgeStyle} from "./styles.js";
import {LRUCache, stringWidth} from "./text.js";

/** One shared grapheme segmenter -- construction is expensive. */
const graphemeSegmenter = new Intl.Segmenter("en", {granularity: "grapheme"});
/** Text that needs no segmentation: one char, one cell, no combining. */
const asciiPrintable = /^[\x20-\x7e]*$/;

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
	// Styled underline (SGR 4:2, the kitty extension most modern terminals
	// adopted). Only meaningful alongside Underline: emission sends plain 4
	// first so a DIRECTLY connected terminal that ignores 4:2 keeps a single
	// underline. That ordering cannot survive a re-encoding intermediary:
	// tmux collapses the pair into one styled-underline attribute at parse
	// time and forwards it to a client without the usstyle feature in a form
	// Apple Terminal drops entirely. Author-land CSS for terminals known to
	// support it -- the UA defaults deliberately never use it.
	DoubleUnderline = 0b00100000 << 24,
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
	/** CSS text-decoration-style, insofar as SGR can draw it. */
	underlineStyle?: "solid" | "double";
	strikethrough?: boolean;
	inverse?: boolean;
	dim?: boolean;
	blink?: boolean;
	overline?: boolean;
	border?: number;
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
		if (cellStyle?.underline && cellStyle?.underlineStyle === "double")
			fg |= FGStyle.DoubleUnderline;
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
		return this.grapheme ? stringWidth(this.grapheme) > 1 : false;
	}

	get width(): number {
		return this.grapheme ? stringWidth(this.grapheme) : 0;
	}

	getStyleFlags() {
		return {
			bold: (this.fg & FGStyle.Bold) !== 0,
			italic: (this.fg & FGStyle.Italic) !== 0,
			underline: (this.fg & FGStyle.Underline) !== 0,
			doubleUnderline: (this.fg & FGStyle.DoubleUnderline) !== 0,
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
		if (cellStyle?.underline && cellStyle?.underlineStyle === "double")
			fg |= FGStyle.DoubleUnderline;
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

	// The bits say which way a line leaves this cell, so the glyph follows
	// directly from how many ways it goes and which.
	const count =
		(hasTop ? 1 : 0) +
		(hasRight ? 1 : 0) +
		(hasBottom ? 1 : 0) +
		(hasLeft ? 1 : 0);

	if (count === 4) return charSet.cross; // ┼

	if (count === 3) {
		if (!hasTop) return charSet.topTee; // ┬
		if (!hasBottom) return charSet.bottomTee; // ┴
		if (!hasLeft) return charSet.rightTee; // ├
		return charSet.leftTee; // ┤
	}

	if (hasRight && hasBottom) return charSet.topLeft; // ┌
	if (hasLeft && hasBottom) return charSet.topRight; // ┐
	if (hasRight && hasTop) return charSet.bottomLeft; // └
	if (hasLeft && hasTop) return charSet.bottomRight; // ┘

	if (hasLeft || hasRight) return charSet.horizontal; // ─
	if (hasTop || hasBottom) return charSet.vertical; // │

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

function getStyleDiff(
	cell: Cell,
	prev: Cell | null,
	colorDepth: ColorDepth,
): Array<number | string> {
	if (!prev) {
		const seq: Array<number | string> = [];

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
		// After plain 4, so terminals without styled-underline support keep
		// the single underline.
		if (flags.doubleUnderline) seq.push("4:2");
		if (flags.blink) seq.push(5);
		if (flags.inverse) seq.push(7);
		if (flags.strikethrough) seq.push(9);
		if (flags.overline) seq.push(53);

		return seq;
	}

	if (cell.styleEquals(prev)) {
		return [];
	}

	const seq: Array<number | string> = [];
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
		// Underline and its style diff as one attribute: 24 clears both, a
		// bare 4 sets single (which also downgrades a previous double, per
		// ECMA-48 and tmux's own tracking), and 4:2 upgrades to double --
		// always after a plain 4 so unsupporting terminals degrade to single.
		if (
			cellFlags.underline !== prevFlags.underline ||
			cellFlags.doubleUnderline !== prevFlags.doubleUnderline
		) {
			if (!cellFlags.underline) {
				seq.push(24);
			} else {
				if (
					!prevFlags.underline ||
					(prevFlags.doubleUnderline && !cellFlags.doubleUnderline)
				) {
					seq.push(4);
				}
				if (cellFlags.doubleUnderline) {
					seq.push("4:2");
				}
			}
		}
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
	// Where the focused text element wants the real terminal cursor, in the
	// same coordinates setText uses. When set, the frame parks the cursor there
	// and shows it -- IME composition anchors at the real cursor, so a fake
	// inverse-cell caret is not enough for text entry.
	caret: {col: number; row: number} | null = null;
	// The active overflow:hidden clip, in the same document-space (row, col)
	// coordinates as every draw call below -- set/restored by the renderer
	// around a clipping element's children. An edge is +-Infinity when that
	// axis isn't clipped (e.g. overflow-x:hidden;overflow-y:visible only
	// bounds left/right). null means no clip is active at all.
	clipRect: {
		left: number;
		top: number;
		right: number;
		bottom: number;
	} | null = null;
	// When set, only buffer rows inside these [start, end) bands accept
	// writes: a scroll-transform frame repaints the exposed band and the
	// fixed-content rows, and everything else is the shifted previous frame.
	// Writes an element makes outside the bands are identical to the shifted
	// content by construction, so dropping them loses nothing.
	paintBands: Array<[number, number]> | null = null;

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

	setCaret(x: number, y: number): void {
		this.caret = {col: x, row: y};
	}

	fillRect(
		x: number,
		y: number,
		width: number,
		height: number,
		bgColor?: number | null | "default" | "inverse",
	): void {
		if (bgColor == null) {
			return;
		}

		// "default" clears the cells to the terminal's own background --
		// CSS's Canvas system color -- which still OVERWRITES whatever was
		// painted underneath: an opaque box in the theme's color, whatever
		// that theme is. "inverse" fills with SGR inverse instead: the
		// Highlight/HighlightText system-color pair, swapping each cell's
		// colors with no assumption about what they are.
		const style: CellStyle =
			bgColor === "inverse"
				? {inverse: true}
				: {bg: bgColor === "default" ? undefined : bgColor};

		for (let row = y; row < y + height; row++) {
			for (let col = x; col < x + width; col++) {
				this.#setCell(row, col, " ", style);
			}
		}
	}

	setText(x: number, y: number, text: string, style?: CellStyle): number {
		let currentX = x;

		// Printable ASCII -- the overwhelmingly common case -- needs no
		// grapheme segmentation: every char is its own one-cell grapheme.
		// Segmenting anyway (worse, constructing a Segmenter per call)
		// dominated the text painter's profile.
		if (asciiPrintable.test(text)) {
			for (let i = 0; i < text.length; i++) {
				if (currentX + 1 > this.cols) break;
				this.#setCell(y, currentX, text[i], style);
				currentX++;
			}
			return currentX;
		}

		for (const segment of graphemeSegmenter.segment(text)) {
			const char = segment.segment;

			// Never write a control char to a cell: a trailing one would survive to
			// the output as a raw escape byte (injection from untrusted text).
			const code = char.codePointAt(0)!;
			if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;

			const width = stringWidth(char);

			if (currentX + width > this.cols) {
				break;
			}

			this.#setCell(y, currentX, char, style);
			currentX += width;
		}

		return currentX;
	}

	/**
	 * Merge an underline/overline across a row, preserving existing glyphs (an
	 * empty cell becomes a spaced edge). Used to render `outline` as a full-width
	 * edge; setText can't, since it overwrites. The style's fg is the row's
	 * DEFAULT color: a cell that already carries an explicit foreground
	 * (::selection, ::placeholder, authored color) keeps it.
	 */
	edgeRow(
		x: number,
		y: number,
		width: number,
		edge: "underline" | "overline",
		style?: CellStyle,
	): void {
		const terminalRow = y + this.viewportOffset;
		if (terminalRow < 0 || terminalRow >= this.rows) return;
		for (let col = x; col < x + width; col++) {
			if (col < 0 || col >= this.cols) continue;
			if (this.clipRect && !this.#inClip(y, col)) continue;
			const existing = this.buffer[terminalRow][col];
			const flags = existing?.getStyleFlags();
			this.buffer[terminalRow][col] = Cell.create({
				grapheme: existing?.grapheme ?? " ",
				fg: existing?.getFgColor() ?? style?.fg,
				bg: existing?.getBgColor(),
				bold: flags?.bold,
				italic: flags?.italic,
				underline: edge === "underline" || flags?.underline,
				underlineStyle: flags?.doubleUnderline ? "double" : undefined,
				strikethrough: flags?.strikethrough,
				overline: edge === "overline" || flags?.overline,
				inverse: flags?.inverse,
				blink: flags?.blink,
				dim: style?.dim ?? flags?.dim,
			});
		}
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
		if (!borderStyles.hasAnyBorder || width < 1 || height < 1) return;
		// A thin box (a 1-row <hr>, say) still shows its horizontal edges: the loops
		// below draw only the run that fits, so let it through.

		const right = x + width - 1;
		const bottom = y + height - 1;

		const {topEdge, rightEdge, bottomEdge, leftEdge} = borderStyles;
		const hasTop = topEdge > 0;
		const hasRight = rightEdge > 0;
		const hasBottom = bottomEdge > 0;
		const hasLeft = leftEdge > 0;

		// Each cell records which way a line *leaves* it, not which edge of this
		// box it belongs to. Two boxes sharing a cell then merge by simple union
		// and land on the right glyph: a horizontal run (left+right) meeting two
		// corners that both turn downward (left+down and right+down) becomes
		// left+right+down -- a tee. Edge-membership bits gave a cross there,
		// which is what made every colspan and rowspan boundary render as ┼.
		const encode = (
			up: number,
			toRight: number,
			down: number,
			toLeft: number,
		) =>
			(up > 0 ? up << BorderShift.Top : 0) |
			(toRight > 0 ? toRight << BorderShift.Right : 0) |
			(down > 0 ? down << BorderShift.Bottom : 0) |
			(toLeft > 0 ? toLeft << BorderShift.Left : 0);

		const put = (col: number, row: number, encoding: number) => {
			// No bounds check here: rows are DOCUMENT rows, and #setBorderCell
			// culls after applying the viewport offset -- pre-culling against
			// terminal rows dropped bottom edges the camera had scrolled INTO
			// view.
			this.#setBorderCell(col, row, encoding, style);
		};

		// Top edge: a horizontal run that turns down at whichever corners exist.
		if (hasTop) {
			for (let col = x; col <= right; col++) {
				const atLeft = col === x && hasLeft;
				const atRight = col === right && hasRight;
				const down = atLeft ? leftEdge : atRight ? rightEdge : 0;
				put(
					col,
					y,
					encode(0, atRight ? 0 : topEdge, down, atLeft ? 0 : topEdge),
				);
			}
		}

		// Bottom edge: the same run, turning up at its corners. On a 1-row box it
		// draws only if the top didn't already cover that row.
		if (hasBottom && (bottom !== y || !hasTop)) {
			for (let col = x; col <= right; col++) {
				const atLeft = col === x && hasLeft;
				const atRight = col === right && hasRight;
				const up = atLeft ? leftEdge : atRight ? rightEdge : 0;
				put(
					col,
					bottom,
					encode(up, atRight ? 0 : bottomEdge, 0, atLeft ? 0 : bottomEdge),
				);
			}
		}

		// The sides are vertical runs between the corners -- and a missing
		// horizontal edge has no corner, so the run owns that end row itself.
		// Skipping unconditionally cut a border-left-only box (a blockquote)
		// off at its first and last row.
		const sideTop = hasTop ? y + 1 : y;
		const sideBottom = hasBottom ? bottom - 1 : bottom;
		if (hasLeft) {
			for (let row = sideTop; row <= sideBottom; row++) {
				put(x, row, encode(leftEdge, 0, leftEdge, 0));
			}
		}

		if (hasRight && right !== x) {
			for (let row = sideTop; row <= sideBottom; row++) {
				put(right, row, encode(rightEdge, 0, rightEdge, 0));
			}
		}
	}

	#inClip(row: number, col: number): boolean {
		if (!this.clipRect) return true;
		const {left, top, right, bottom} = this.clipRect;
		return col >= left && col < right && row >= top && row < bottom;
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

		if (this.paintBands) {
			let inBand = false;
			for (const [start, end] of this.paintBands) {
				if (terminalRow >= start && terminalRow < end) {
					inBand = true;
					break;
				}
			}
			if (!inBand) return;
		}

		if (this.clipRect && !this.#inClip(row, col)) return;

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
					underlineStyle: finalStyle.underlineStyle,
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

	#setBorderCell(
		x: number,
		y: number,
		borderEncoding: number,
		style?: CellStyle,
	): void {
		// Document row -> terminal row, exactly as #setCell translates text.
		// Without the offset, borders were only ever correct at scroll 0: a
		// scrolled camera stamped off-screen top edges into the band's first
		// row and lost bottom edges it had scrolled to.
		const terminalY = y + this.viewportOffset;

		if (terminalY < 0 || terminalY >= this.rows || x < 0 || x >= this.cols) {
			return;
		}
		if (!this.#inClip(y, x)) return;

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
	#prevContentHeight: number = 0;
	// Where the last frame parked the cursor, in buffer coordinates. The resize
	// re-anchor derives the frame's new top row from the cursor's post-rewrap
	// position minus the wrapped rows above this park point.
	#parkRow = 0;
	#parkCol = 0;
	#lastCaretVisible = false;
	#hasSavedCursor: boolean = false;
	#needsFullClear: boolean = false;
	#needsScreenReset: boolean = false;
	#resetAtRow: number = 0;
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

	/**
	 * How many terminal rows the previously painted frame occupies once the
	 * terminal rewraps it at `cols` columns.
	 *
	 * Every painted row is its own hard line -- frames are written with explicit
	 * positioning and never through the right margin -- so each rewraps
	 * independently: an empty row stays one row, and a row whose text spans `len`
	 * cells becomes ceil(len / cols) rows. Null when nothing has been painted.
	 *
	 * Used by the resize re-anchor: the cursor is parked at the frame's bottom,
	 * so its post-rewrap row minus this height names the frame's new top row
	 * exactly, no matter how anything above the frame reflowed.
	 */
	/**
	 * How many terminal rows sit above the parked cursor once the terminal
	 * rewraps the previously painted frame at `cols` columns.
	 *
	 * The resize re-anchor asks the terminal where the cursor is (it rides its
	 * line through the rewrap) and subtracts this to name the frame's new top
	 * row. With the default park -- content's last row, column 0 -- this is the
	 * full wrapped height minus one; with a caret park it is the wrapped rows
	 * above the caret's line plus the caret's own wrap segment.
	 */
	wrappedRowsAboveCursorPark(cols: number): number | null {
		if (!this.#prevBuffer || this.#prevContentHeight === 0 || cols <= 0) {
			return null;
		}
		const limit = Math.min(
			this.#parkRow,
			this.#prevContentHeight,
			this.#prevBuffer.length,
		);
		let wrapped = 0;
		for (let row = 0; row < limit; row++) {
			wrapped += Math.max(1, Math.ceil(this.#lineLength(row) / cols));
		}
		return wrapped + Math.floor(this.#parkCol / cols);
	}

	#lineLength(row: number): number {
		const line = this.#prevBuffer![row];
		for (let col = line.length - 1; col >= 0; col--) {
			const cell = line[col];
			if (cell !== null) {
				return col + cell.width;
			}
		}
		return 0;
	}

	/**
	 * Forget where the current block of output started.
	 *
	 * The next frame will anchor itself wherever the cursor now is, rather than
	 * restoring to the old content start. Used when the document has reflowed above
	 * the fold: the already-printed copy is in the scrollback and cannot be
	 * corrected, so the only honest thing left is to print a fresh one below it.
	 */
	clearPreviousBuffer(): void {
		this.#prevBuffer = null;
		this.#prevContentHeight = 0;
		this.#needsFullClear = true;
		this.#renderedLines.clear();
	}

	/**
	 * Repaint the whole visible screen from the top on the next frame.
	 *
	 * A resize rewraps everything the terminal is showing, including our previous
	 * frame, and moves the cursor unpredictably -- the saved position DECRC would
	 * restore no longer points where our content began. So instead of trying to
	 * erase relative to a position we can no longer trust, we home the cursor and
	 * clear the visible screen (ED2, not ED3 -- the scrollback is left alone) and
	 * reprint. The old content the terminal reflowed into scrollback stays there,
	 * as any command's output would; the visible frame is clean.
	 */
	resetScreen(startRow: number): void {
		this.#needsScreenReset = true;
		this.#resetAtRow = Math.max(0, startRow);
		this.#hasSavedCursor = false;
		this.clearPreviousBuffer();
	}

	/**
	 * Reset from the top row, for the resize whose anchor cannot be trusted
	 * (the frame no longer fits below where the cursor query put it, so the
	 * amount the terminal scrolled is unrecoverable). Nothing of the old frame
	 * survives: a reset frame covers every visible row -- each region row
	 * clears itself, and one partial erase takes everything below the content
	 * -- without the whole-screen ED that tmux would archive into scrollback.
	 * It costs the output above us, which beats a screen holding two
	 * half-frames.
	 */
	clearScreen(): void {
		this.resetScreen(0);
	}

	/**
	 * The screen scrolled by `rows` between resetScreen() and the frame that
	 * consumes it -- reserveRows pushing earlier output into the scrollback to
	 * make room. The pending reset row is SCREEN-absolute, so it rides the
	 * scroll like everything else on screen; without this, the erase and the
	 * paint land `rows` too low, overflow the bottom margin, and the frame's
	 * own top rows get scrolled up and stranded as duplicates.
	 */
	shiftScreenReset(rows: number): void {
		if (this.#needsScreenReset && rows > 0) {
			this.#resetAtRow = Math.max(0, this.#resetAtRow - rows);
		}
	}

	get hasSavedCursor(): boolean {
		return this.#hasSavedCursor;
	}

	/** A reset or clear is pending: the next frame must actually paint. */
	get needsRepaint(): boolean {
		return this.#needsScreenReset || this.#needsFullClear;
	}

	/**
	 * Render one frame.
	 *
	 * `regionRows` lets the caller render a region *taller than the terminal*. That
	 * is how content reaches the scrollback: the frame is emitted top to bottom
	 * with newlines, and printing past the bottom margin is what makes the terminal
	 * scroll -- and what puts the rows that scroll past into its scrollback, where
	 * they remain readable. (`CSI n S` scrolls too, but discards them.)
	 *
	 * Rows that scroll off can never be addressed again, so only the last
	 * `terminalHeight` of them are kept as the previous frame: they are the only
	 * part still ours to redraw.
	 */
	/**
	 * Render the whole document as plain lines, for a stdout that is not a
	 * terminal.
	 *
	 * A pipe or a file has no viewport, no cursor, no scrollback and no resize --
	 * so it has no fold, and none of the problems that come with one. There is
	 * nothing to commit, nothing to freeze and nothing to repair.
	 *
	 * It also has no way to interpret cursor movement. Emitting the interactive
	 * frame here would write CUP, EL, DECSC and synchronised-output sequences into
	 * the file. So this emits styled text and newlines, and nothing else: gaps are
	 * spaces rather than cursor-forward, and rows end with a newline rather than an
	 * erase-line.
	 */
	renderStatic(
		contentRows: number,
		drawCallback: (ctx: DrawingContext) => void,
		lineEnding: "\n" | "\r\n" = "\n",
	): string {
		const rows = Math.max(0, contentRows);
		if (rows === 0) return "";

		const buffer = createBuffer(rows, this.#cols);
		drawCallback(new DrawingContext(buffer, rows, this.#cols, 0));

		const lines: string[] = [];
		for (let row = 0; row < rows; row++) {
			// A file should not be padded out to the terminal width, so stop at the
			// last cell that actually holds something.
			let lastCol = -1;
			for (let col = this.#cols - 1; col >= 0; col--) {
				if (buffer[row][col] !== null) {
					lastCol = col;
					break;
				}
			}

			let line = "";
			let previous: Cell | null = null;

			for (let col = 0; col <= lastCol; col++) {
				const cell = buffer[row][col];
				if (cell === null) {
					line += " ";
					continue;
				}

				const style = getStyleDiff(cell, previous, this.#colorDepth);
				if (style.length > 0) line += `\x1b[${style.join(";")}m`;

				line += cell.border > 0 ? getBorderChar(cell.border) : cell.grapheme;
				previous = cell;

				// A wide grapheme's continuation column is null in the buffer but
				// already covered by the glyph -- skip it, or the line grows a
				// phantom space per wide character and shifts what follows.
				if (cell.border === 0) col += stringWidth(cell.grapheme) - 1;
			}

			if (previous !== null) line += "\x1b[0m";
			lines.push(line);
		}

		// A file wants a bare newline. A terminal wants CRLF: a lone LF moves the
		// cursor down without returning it to column 0, so the lines would staircase
		// away across the screen.
		return lines.join(lineEnding) + lineEnding;
	}

	renderFrame(
		offset: number,
		drawCallback: (ctx: DrawingContext) => void,
		cursorPosition?: number,
		regionRows?: number,
		scroll?: {delta: number; bands: Array<[number, number]>},
	): string {
		const frameRows = Math.max(this.#rows, regionRows ?? this.#rows);
		const overflowing = frameRows > this.#rows;

		// Setup: Create new frame buffer
		const nextBuffer = createBuffer(frameRows, this.#cols);

		// A pure camera move is a rigid transform the terminal can perform
		// itself: DECSTBM pins the margins to our region (anything above --
		// a shell prompt -- is outside them and untouchable), and DL/IL
		// within margins move the rows without touching the scrollback in
		// any terminal, unlike SU. The previous buffer shifts to match, the
		// exposed band plus fixed-content rows repaint, and every other row
		// is seeded from the shifted model so the diff leaves it alone.
		// Anything impure -- a reset pending, a growth frame, no previous
		// frame -- falls through to the ordinary full diff.
		let scrollPrefix = "";
		// delta 0 is a banded repaint with no terminal scroll: mutations whose
		// damage is bounded repaint their rows over a seeded, unshifted model.
		const scrolling =
			scroll !== undefined &&
			Math.abs(scroll.delta) < this.#rows &&
			this.#prevBuffer !== null &&
			!overflowing &&
			!this.#needsScreenReset &&
			!this.#needsFullClear &&
			cursorPosition !== undefined;
		if (scrolling && this.#prevBuffer && cursorPosition !== undefined) {
			const delta = scroll!.delta;
			const regionTop = cursorPosition;
			const regionEnd = Math.min(regionRows ?? this.#rows, this.#rows);

			// Shift the model: screen row r now shows what was at r + delta.
			// A zero delta shifts nothing -- the model already matches.
			const prev = this.#prevBuffer;
			const shifted: CellBuffer = [];
			for (let row = 0; row < prev.length; row++) {
				const source = row + delta;
				shifted.push(
					source >= 0 && source < prev.length
						? prev[source]
						: new Array(this.#cols).fill(null),
				);
			}
			this.#prevBuffer = shifted;
			const shiftedLines = new Set<number>();
			for (const row of this.#renderedLines) {
				const moved = row - delta;
				if (moved >= 0 && moved < frameRows) shiftedLines.add(moved);
			}
			// The repainted bands emit fresh \r\x1b[K lines regardless.
			for (const [start, end] of scroll!.bands) {
				for (let row = start; row < end; row++) shiftedLines.add(row);
			}
			this.#renderedLines = shiftedLines;

			// Seed everything outside the bands from the shifted model; the
			// paint callback owns the bands (enforced by the context mask).
			for (let row = 0; row < Math.min(frameRows, shifted.length); row++) {
				let inBand = false;
				for (const [start, end] of scroll!.bands) {
					if (row >= start && row < end) {
						inBand = true;
						break;
					}
				}
				if (inBand) continue;
				for (let col = 0; col < this.#cols; col++) {
					nextBuffer[row][col] = shifted[row][col];
				}
			}

			// DECSTBM homes the cursor, so position after resetting margins is
			// the standard prefix's problem (it always CUPs for this caller).
			// A zero delta needs no terminal scroll at all.
			if (delta !== 0) {
				const count = Math.abs(delta);
				scrollPrefix =
					`\x1b[${regionTop + 1};${regionEnd}r` +
					`\x1b[${regionTop + 1};1H` +
					(delta > 0 ? `\x1b[${count}M` : `\x1b[${count}L`) +
					"\x1b[r";
			}
		}

		// Create drawing context and execute drawing operations
		const context = new DrawingContext(
			nextBuffer,
			frameRows,
			this.#cols,
			offset,
		);
		if (scrolling) context.paintBands = scroll!.bands;
		drawCallback(context);

		// Create diff buffer. A frame taller than the terminal is a growth frame:
		// the rows below the fold have never been on screen, so there is nothing to
		// diff against -- print all of it.
		const diffBuffer = createBuffer(frameRows, this.#cols);
		if (!this.#prevBuffer || overflowing) {
			for (let row = 0; row < frameRows; row++) {
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

		// A reset frame redraws onto rows whose terminal content is unknown --
		// the previous buffer was dropped. Every region row must clear ITSELF:
		// a row the new frame leaves blank gets a seeded space so generateANSI
		// emits its \r\e[K line like any content row. Per-row erases instead of
		// one ED from the home position matter in tmux, which preserves a
		// fully-erased screen by pushing it into scrollback (the courtesy it
		// extends to `clear`) -- the ED archived a copy of the old frame into
		// the scrollback on every resize.
		const resetFrame = this.#needsScreenReset || this.#needsFullClear;
		if (resetFrame) {
			// Buffer rows are region-relative (the anchor row is where the frame
			// CUPs to); regionRows is a screen-absolute end. Seed exactly the
			// region's rows -- seeding further would count blank screen rows as
			// content and skew the park the resize re-anchor measures from.
			const anchorRow = this.#needsScreenReset
				? this.#resetAtRow
				: (cursorPosition ?? 0);
			const regionHeight = (regionRows ?? this.#rows) - anchorRow;
			const seedRows = Math.min(frameRows, this.#rows, regionHeight);
			for (let row = 0; row < seedRows; row++) {
				let empty = true;
				for (let col = 0; col < this.#cols; col++) {
					if (diffBuffer[row][col] !== null) {
						empty = false;
						break;
					}
				}
				if (empty) diffBuffer[row][0] = Cell.create(" ");
			}
		}

		// Check for content
		let hasContent = false;

		for (let row = 0; row < frameRows; row++) {
			for (let col = 0; col < this.#cols; col++) {
				if (diffBuffer[row][col] !== null) {
					hasContent = true;
					break;
				}
			}
			if (hasContent) break;
		}

		// A caret appearing, moving, or disappearing must emit a frame even when
		// no cell changed -- a blurred input leaves no visual diff, but the real
		// cursor is sitting visible at the stale caret until a frame re-parks it.
		const caret = context.caret;
		const caretBufferRow = caret === null ? null : caret.row + offset;
		const caretVisible =
			caret !== null &&
			caretBufferRow !== null &&
			caretBufferRow >= 0 &&
			caretBufferRow < this.#rows &&
			caret.col >= 0 &&
			caret.col < this.#cols;
		const caretStateChanged =
			caretVisible !== this.#lastCaretVisible ||
			(caretVisible &&
				(this.#parkRow !== caretBufferRow || this.#parkCol !== caret.col));
		if (caretStateChanged) {
			hasContent = true;
		}
		this.#lastCaretVisible = caretVisible;

		if (scrolling) {
			hasContent = true;
		}

		// Build output with proper framing
		let prefix = scrollPrefix;
		let suffix = "";
		// The frame's on-screen start row, when a positioning branch names one
		// absolutely. Used to park the cursor at the content bottom after painting.
		let frameStartRow: number | undefined;
		if (hasContent) {
			prefix += "\x1b[?25l"; // DECTCEM - Hide cursor
			prefix += "\x1b[?2026h"; // Synchronized output mode (start)

			// Add cursor positioning
			if (this.#needsScreenReset) {
				// After a resize the terminal has rewrapped everything on screen,
				// including our previous frame, and moved the cursor to somewhere we
				// can no longer name via DECRC. But the content above us -- a shell
				// prompt, an earlier command -- is short and does not reflow-grow, so
				// our own record of the row our content starts at still holds.
				//
				// Position there absolutely and reprint. We do NOT home to the top of
				// the screen: that would wipe whatever is above us. And no ED here at
				// all: every region row clears itself (see the reset-frame seeding),
				// and the rows below the content get one PARTIAL erase after the
				// paint -- a full-screen ED from the home row is exactly what tmux
				// archives into the scrollback.
				prefix += `\x1b[${this.#resetAtRow + 1};1H`; // CUP - content start
				prefix += "\x1b7"; // DECSC - save the new content start
				this.#hasSavedCursor = true;
				this.#needsScreenReset = false;
				this.#needsFullClear = false;
				frameStartRow = this.#resetAtRow;
			} else if (cursorPosition !== undefined) {
				// Explicit cursor position provided (e.g., from cursor detection)
				prefix += `\x1b[${cursorPosition + 1};1H`; // CUP - Cursor Position (row;col)
				// Save cursor at content start so DECRC-based cleanup works correctly
				prefix += "\x1b7"; // DECSC
				this.#hasSavedCursor = true;
				frameStartRow = cursorPosition;
			} else if (offset > 0) {
				// Position based on viewport offset
				prefix += `\x1b[${offset + 1};1H`; // CUP - Cursor Position (row;col)
				frameStartRow = offset;
			} else if (this.#hasSavedCursor) {
				// Restore cursor to content start (DECRC), then save again (DECSC)
				prefix += "\x1b8\x1b7"; // Restore + Save
			} else {
				// First render: save cursor at content start (DECSC)
				prefix += "\x1b7"; // Save
				this.#hasSavedCursor = true;
			}

			// After resize, clear everything from content start down.
			// Terminal reflow makes it impossible to know where old content ended up,
			// so we erase the entire area before redrawing.
			if (this.#needsFullClear) {
				prefix += "\x1b[J"; // ED0 - Erase from cursor to end of screen
				this.#needsFullClear = false;
			}

			// The cursor stays hidden between frames: it is parked at the content's
			// bottom-left for resize bookkeeping, and a blinking cursor squatting
			// there is not UI. Focused inputs paint their own caret as an inverse
			// cell. dispose() shows the real cursor again on the way out.
			suffix += "\x1b[?2026l"; // Synchronized output mode (end)
		}

		// Generate ANSI and finalize
		let output = generateANSI(
			diffBuffer,
			this.#colorDepth,
			this.#renderedLines,
		);

		// Strip trailing \r\n from generateANSI — in Renderer-managed mode,
		// the trailing newline would scroll the terminal on each re-render,
		// progressively pushing the command line into scrollback.
		if (output.endsWith("\r\n")) {
			output = output.slice(0, -2);
		}

		// Calculate current content height (highest rendered row + 1)
		let contentHeight = 0;
		for (const row of this.#renderedLines) {
			if (row + 1 > contentHeight) contentHeight = row + 1;
		}

		// Clear stale content below the rendered area.
		// Only needed when content shrank (previous render was taller).
		let staleOutput = "";
		if (this.#hasSavedCursor && this.#prevContentHeight > contentHeight) {
			// Content shrank — clear the lines that are no longer used.
			// Position to content start, then move past current content,
			// then erase to end of screen.
			staleOutput += "\x1b8"; // DECRC - restore to content start
			if (contentHeight > 0) {
				staleOutput += `\x1b[${contentHeight}B`; // CUD - Cursor Down
			}
			staleOutput += "\r"; // CR - column 0
			staleOutput += "\x1b[J"; // ED0 - Erase from cursor to end of screen
		} else if (
			resetFrame &&
			frameStartRow !== undefined &&
			frameStartRow + contentHeight < this.#rows
		) {
			// After a reset nothing below the content is trusted either -- the
			// old frame may have been taller. Erase from the first row past the
			// content: a PARTIAL erase, which no terminal treats as a screen
			// clear worth archiving.
			staleOutput += `\x1b[${frameStartRow + contentHeight + 1};1H\x1b[J`;
		}

		// Update state for next frame. Anything above the last terminalHeight rows
		// has scrolled into the scrollback and is no longer ours to redraw, so it is
		// not worth remembering.
		this.#prevBuffer = overflowing
			? nextBuffer.slice(frameRows - this.#rows)
			: nextBuffer;
		this.#prevContentHeight = contentHeight;

		// Park the cursor before the frame ends. A diff leaves the cursor wherever
		// the last changed cell happened to be -- an arbitrary row -- and the
		// terminal preserves the cursor across a resize, scrolling exactly enough
		// to keep it on screen, so an arbitrary resting place makes that scroll
		// arbitrary too. The resize re-anchor recovers the frame's position from
		// wherever the park went (see wrappedRowsAboveCursorPark).
		//
		// Two parks:
		// - A focused text element set a caret: park THERE and show the cursor.
		//   IME composition anchors at the real terminal cursor, so the caret has
		//   to be the real cursor, not just an inverse-video cell.
		// - Otherwise: the content's last row, column 0, hidden -- where an
		//   ordinary program's cursor rests after printing.
		let parkOutput = "";
		if (hasContent && contentHeight > 0) {
			if (caretVisible && caret !== null && caretBufferRow !== null) {
				this.#parkRow = caretBufferRow;
				this.#parkCol = caret.col;
				if (frameStartRow !== undefined) {
					parkOutput = `\x1b[${frameStartRow + caretBufferRow + 1};${caret.col + 1}H`; // CUP - caret
				} else if (this.#hasSavedCursor) {
					parkOutput = "\x1b8\x1b7";
					if (caretBufferRow > 0) parkOutput += `\x1b[${caretBufferRow}B`; // CUD
					if (caret.col > 0) parkOutput += `\r\x1b[${caret.col}C`;
					else parkOutput += "\r";
				}
				parkOutput += "\x1b[?25h"; // DECTCEM - the caret is the real cursor
			} else {
				this.#parkRow = Math.min(contentHeight, this.#rows) - 1;
				this.#parkCol = 0;
				if (frameStartRow !== undefined) {
					// 0-based start + height = 1-based last row; the bottom margin caps
					// it when the content overflows the screen.
					const lastRow = Math.min(frameStartRow + contentHeight, this.#rows);
					parkOutput = `\x1b[${lastRow};1H`; // CUP - content bottom
				} else if (this.#hasSavedCursor) {
					// No absolute row to name: restore the saved content start, re-save
					// it, and step down. CUD stops at the bottom margin, which is the
					// content's visible bottom when it overflows.
					parkOutput = "\x1b8\x1b7";
					if (contentHeight > 1) parkOutput += `\x1b[${contentHeight - 1}B`; // CUD
					parkOutput += "\r";
				}
			}
		}

		return prefix + output + staleOutput + parkOutput + suffix;
	}
}
