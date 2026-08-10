/**
 * The screen: the cells the terminal is showing, the cells the next frame
 * wants, and the shortest escape sequence between them.
 */
import {BOX_DRAWING, BorderEdgeStyle} from "./styles.js";
import {stringWidth} from "./text.js";

/** One shared grapheme segmenter -- construction is expensive. */
const graphemeSegmenter = new Intl.Segmenter("en", {granularity: "grapheme"});
/** Text that needs no segmentation: one char, one cell, no combining. */
const asciiPrintable = /^[\x20-\x7e]*$/;

export type ColorDepth = "ansi" | "rgb" | "256";

const enum Color {
	Mask = 0xffffff,
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

/**
 * Per-cell attribute bits.
 *
 * Bold through Overline are the bits the foreground word carries alongside its
 * color; Inverse through Dim are the background word's. The SGR delta treats
 * each group as one unit with its color -- a foreground change re-states every
 * foreground attribute -- so the groups are named here as masks.
 *
 * Width is the grapheme's column count, recorded at write time so the emitter
 * never re-measures. WidthWide is the escape for a cluster wider than the
 * field (a base carrying many spacing marks); the emitter measures those.
 */
const enum Attr {
	Bold = 1 << 0,
	Italic = 1 << 1,
	Underline = 1 << 2,
	// Styled underline (SGR 4:2, the kitty extension most modern terminals
	// adopted). Only meaningful alongside Underline: emission sends plain 4
	// first so a DIRECTLY connected terminal that ignores 4:2 keeps a single
	// underline. That ordering cannot survive a re-encoding intermediary:
	// tmux collapses the pair into one styled-underline attribute at parse
	// time and forwards it to a client without the usstyle feature in a form
	// Apple Terminal drops entirely. Author-land CSS for terminals known to
	// support it -- the UA defaults deliberately never use it.
	DoubleUnderline = 1 << 3,
	Strikethrough = 1 << 4,
	Overline = 1 << 5,
	Inverse = 1 << 6,
	Blink = 1 << 7,
	Dim = 1 << 8,
	FGGroup = Bold |
		Italic |
		Underline |
		DoubleUnderline |
		Strikethrough |
		Overline,
	BGGroup = Inverse | Blink | Dim,
	StyleMask = FGGroup | BGGroup,
	WidthShift = 9,
	WidthMask = 0x1f << 9,
	WidthWide = 0x1f,
}

/**
 * A char-plane value at or above this is an index into `internedGraphemes`
 * rather than a code point; below it, the value IS the code point. Zero is the
 * empty cell -- nothing has ever been written there, or a wide glyph to the
 * left covers it.
 */
const CHAR_INTERNED = 0x8000_0000;

/**
 * Grapheme clusters of more than one code point -- ZWJ emoji, combining
 * sequences, regional-indicator flags -- named by index so a cell stays one
 * uint32.
 *
 * Append-only: an id, once handed out, names the same cluster for the life of
 * the process, so a plane value copied between buffers by scroll or seed stays
 * valid. The table's size is bounded by the number of DISTINCT multi-code-point
 * clusters the document uses, which is a property of its script, not of how
 * much text passes through.
 */
const internedGraphemes: string[] = [""];
const internedIds = new Map<string, number>();

function internGrapheme(grapheme: string): number {
	let id = internedIds.get(grapheme);
	if (id === undefined) {
		id = internedGraphemes.length;
		internedGraphemes.push(grapheme);
		internedIds.set(grapheme, id);
	}
	return id;
}

/** The char-plane value for a grapheme cluster. */
function encodeGrapheme(grapheme: string): number {
	const code = grapheme.codePointAt(0)!;
	if (grapheme.length === (code > 0xffff ? 2 : 1)) return code;
	return CHAR_INTERNED | internGrapheme(grapheme);
}

/** The grapheme cluster a char-plane value names. */
function decodeGrapheme(char: number): string {
	return char >= CHAR_INTERNED
		? internedGraphemes[char - CHAR_INTERNED]
		: String.fromCodePoint(char);
}

/**
 * Column count of a grapheme, skipping the width cache for printable ASCII --
 * the overwhelmingly common case, and one whose answer is always 1.
 */
function graphemeColumns(grapheme: string): number {
	const code = grapheme.charCodeAt(0);
	if (grapheme.length === 1 && code >= 0x20 && code <= 0x7e) return 1;
	return stringWidth(grapheme);
}

/** The style bits of a CellStyle, packed. Width is added by the caller. */
function packAttrs(style: CellStyle | undefined): number {
	if (!style) return 0;
	let attrs = 0;
	if (style.bold) attrs |= Attr.Bold;
	if (style.italic) attrs |= Attr.Italic;
	if (style.underline) {
		attrs |= Attr.Underline;
		if (style.underlineStyle === "double") attrs |= Attr.DoubleUnderline;
	}
	if (style.strikethrough) attrs |= Attr.Strikethrough;
	if (style.overline) attrs |= Attr.Overline;
	if (style.inverse) attrs |= Attr.Inverse;
	if (style.blink) attrs |= Attr.Blink;
	if (style.dim) attrs |= Attr.Dim;
	return attrs;
}

/**
 * The terminal grid, as parallel typed-array planes indexed by `row * cols +
 * col`.
 *
 * Every per-cell datum has a plane: the grapheme (a code point, or an index
 * into the intern table), the foreground and background colors, the style and
 * width bits, and the border encoding. A color of 0 is the terminal's own
 * default rather than black -- the sentinel the SGR emitter reads as 39/49.
 *
 * A cell is empty when its char plane is 0. The column to the right of a
 * two-column glyph is empty in exactly that sense: the glyph's own width field
 * is what tells the emitter to step over it.
 *
 * Planes are allocated once per size and reused. The renderer swaps whole
 * grids between frames rather than copying them.
 */
export class CellGrid {
	readonly rows: number;
	readonly cols: number;
	readonly char: Uint32Array;
	readonly fg: Uint32Array;
	readonly bg: Uint32Array;
	readonly attrs: Uint16Array;
	readonly border: Uint32Array;

	constructor(rows: number, cols: number) {
		this.rows = rows;
		this.cols = cols;
		const size = rows * cols;
		this.char = new Uint32Array(size);
		this.fg = new Uint32Array(size);
		this.bg = new Uint32Array(size);
		this.attrs = new Uint16Array(size);
		this.border = new Uint32Array(size);
	}

	clear(): void {
		this.char.fill(0);
		this.fg.fill(0);
		this.bg.fill(0);
		this.attrs.fill(0);
		this.border.fill(0);
	}

	/** Blank the cells in [start, end) of the flat index space. */
	clearRange(start: number, end: number): void {
		if (end <= start) return;
		this.char.fill(0, start, end);
		this.fg.fill(0, start, end);
		this.bg.fill(0, start, end);
		this.attrs.fill(0, start, end);
		this.border.fill(0, start, end);
	}

	/** Copy [srcStart, srcEnd) of the flat index space to `dest`. */
	moveRange(dest: number, srcStart: number, srcEnd: number): void {
		this.char.copyWithin(dest, srcStart, srcEnd);
		this.fg.copyWithin(dest, srcStart, srcEnd);
		this.bg.copyWithin(dest, srcStart, srcEnd);
		this.attrs.copyWithin(dest, srcStart, srcEnd);
		this.border.copyWithin(dest, srcStart, srcEnd);
	}

	/** Copy [srcStart, srcEnd) of `source` to `dest` in this grid. */
	copyFrom(
		source: CellGrid,
		dest: number,
		srcStart: number,
		srcEnd: number,
	): void {
		this.char.set(source.char.subarray(srcStart, srcEnd), dest);
		this.fg.set(source.fg.subarray(srcStart, srcEnd), dest);
		this.bg.set(source.bg.subarray(srcStart, srcEnd), dest);
		this.attrs.set(source.attrs.subarray(srcStart, srcEnd), dest);
		this.border.set(source.border.subarray(srcStart, srcEnd), dest);
	}

	/** The bottom `rows` rows, as a grid of their own. */
	bottomRows(rows: number): CellGrid {
		const kept = new CellGrid(rows, this.cols);
		kept.copyFrom(
			this,
			0,
			(this.rows - rows) * this.cols,
			this.rows * this.cols,
		);
		return kept;
	}

	/**
	 * Write one cell.
	 *
	 * `bgColor` overrides the style's background, for the caller that has
	 * already resolved what an absent background inherits.
	 */
	setCell(
		index: number,
		grapheme: string,
		style?: CellStyle,
		bgColor?: number,
	): void {
		const width = graphemeColumns(grapheme);
		this.char[index] = encodeGrapheme(grapheme);
		this.fg[index] = (style?.fg ?? 0) & Color.Mask;
		this.bg[index] =
			bgColor !== undefined ? bgColor : (style?.bg ?? 0) & Color.Mask;
		this.attrs[index] =
			packAttrs(style) |
			((width < Attr.WidthWide ? width : Attr.WidthWide) << Attr.WidthShift);
		// A text cell carries no border encoding; setBorderCell is the only
		// way one gets in.
		this.border[index] = 0;
	}

	/**
	 * Write one border cell. The glyph follows from the encoding at emit time,
	 * so the cell stores the space that gives it its one-column width.
	 *
	 * Border cells carry no styled underline: the SGR 4:2 extension is
	 * author-land only, and a border's style comes from the UA sheet.
	 */
	setBorderCell(index: number, border: number, style?: CellStyle): void {
		this.char[index] = 0x20;
		this.fg[index] = (style?.fg ?? 0) & Color.Mask;
		this.bg[index] = (style?.bg ?? 0) & Color.Mask;
		this.attrs[index] =
			(packAttrs(style) & ~Attr.DoubleUnderline) | (1 << Attr.WidthShift);
		this.border[index] = border;
	}

	/** Overwrite one cell with a plain space in the terminal's own colors. */
	setBlank(index: number): void {
		this.char[index] = 0x20;
		this.fg[index] = 0;
		this.bg[index] = 0;
		this.attrs[index] = 1 << Attr.WidthShift;
		this.border[index] = 0;
	}

	/** Copy one cell from another grid. */
	setFrom(index: number, source: CellGrid, sourceIndex: number): void {
		this.char[index] = source.char[sourceIndex];
		this.fg[index] = source.fg[sourceIndex];
		this.bg[index] = source.bg[sourceIndex];
		this.attrs[index] = source.attrs[sourceIndex];
		this.border[index] = source.border[sourceIndex];
	}

	/** Columns the cell's glyph occupies. */
	widthAt(index: number): number {
		const width = (this.attrs[index] & Attr.WidthMask) >>> Attr.WidthShift;
		return width === Attr.WidthWide
			? stringWidth(decodeGrapheme(this.char[index]))
			: width;
	}

	/** The grapheme a cell holds, or "" when it is empty. */
	graphemeAt(index: number): string {
		const char = this.char[index];
		return char === 0 ? "" : decodeGrapheme(char);
	}

	/** Whether two cells carry the same content and the same styling. */
	equalCells(index: number, other: CellGrid, otherIndex: number): boolean {
		return (
			this.char[index] === other.char[otherIndex] &&
			this.fg[index] === other.fg[otherIndex] &&
			this.bg[index] === other.bg[otherIndex] &&
			(this.attrs[index] & Attr.StyleMask) ===
				(other.attrs[otherIndex] & Attr.StyleMask) &&
			this.border[index] === other.border[otherIndex]
		);
	}
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
): string {
	switch (colorDepth) {
		case "rgb": {
			const r = (color >> 16) & 0xff;
			const g = (color >> 8) & 0xff;
			const b = color & 0xff;
			return `${isFg ? 38 : 48};2;${r};${g};${b}`;
		}
		case "256":
			return `${isFg ? 38 : 48};5;${rgbTo256(color)}`;
		case "ansi":
			return String((isFg ? 30 : 40) + rgbToBasic8(color));
	}
}

/**
 * The SGR parameters that take the terminal from the cell at `prev` to the
 * cell at `index`, or "" when nothing needs to change. A `prev` of -1 means no
 * cell precedes this one, so every attribute the cell carries is stated.
 *
 * Colors and their attribute group move together: a foreground change
 * re-states bold, italic, underline, strikethrough and overline, and a
 * background change re-states inverse, blink and dim. That is what lets a run
 * of identically styled cells emit nothing at all.
 */
function styleDiff(
	grid: CellGrid,
	index: number,
	prev: number,
	colorDepth: ColorDepth,
): string {
	const fg = grid.fg[index];
	const bg = grid.bg[index];
	const attrs = grid.attrs[index] & Attr.StyleMask;

	if (prev < 0) {
		let seq = "";
		if (fg !== 0) seq = emitColor(fg, true, colorDepth);
		if (bg !== 0) {
			const code = emitColor(bg, false, colorDepth);
			seq = seq === "" ? code : `${seq};${code}`;
		}
		if (attrs & Attr.Bold) seq += seq === "" ? "1" : ";1";
		if (attrs & Attr.Dim) seq += seq === "" ? "2" : ";2";
		if (attrs & Attr.Italic) seq += seq === "" ? "3" : ";3";
		if (attrs & Attr.Underline) seq += seq === "" ? "4" : ";4";
		// After plain 4, so terminals without styled-underline support keep
		// the single underline.
		if (attrs & Attr.DoubleUnderline) seq += seq === "" ? "4:2" : ";4:2";
		if (attrs & Attr.Blink) seq += seq === "" ? "5" : ";5";
		if (attrs & Attr.Inverse) seq += seq === "" ? "7" : ";7";
		if (attrs & Attr.Strikethrough) seq += seq === "" ? "9" : ";9";
		if (attrs & Attr.Overline) seq += seq === "" ? "53" : ";53";
		return seq;
	}

	const prevFg = grid.fg[prev];
	const prevBg = grid.bg[prev];
	const prevAttrs = grid.attrs[prev] & Attr.StyleMask;

	if (
		fg === prevFg &&
		bg === prevBg &&
		attrs === prevAttrs &&
		grid.border[index] === grid.border[prev]
	) {
		return "";
	}

	// Everything back to the terminal's own defaults is one code, not nine.
	// Two cells that are both already default differ only in a border
	// encoding, which the glyph carries rather than the SGR.
	const wasDefault = prevFg === 0 && prevBg === 0 && prevAttrs === 0;
	if (fg === 0 && bg === 0 && attrs === 0) {
		return wasDefault ? "" : "0";
	}

	const fgChanged =
		fg !== prevFg || (attrs & Attr.FGGroup) !== (prevAttrs & Attr.FGGroup);
	const bgChanged =
		bg !== prevBg || (attrs & Attr.BGGroup) !== (prevAttrs & Attr.BGGroup);

	let seq = "";
	const push = (code: string) => {
		seq += seq === "" ? code : `;${code}`;
	};

	if (fgChanged) {
		push(fg === 0 ? "39" : emitColor(fg, true, colorDepth));
	}
	if (bgChanged) {
		push(bg === 0 ? "49" : emitColor(bg, false, colorDepth));
	}

	if (fgChanged || bgChanged) {
		const diffFlag = (bit: number, on: string, off: string) => {
			if ((attrs & bit) !== (prevAttrs & bit)) push(attrs & bit ? on : off);
		};

		diffFlag(Attr.Bold, "1", "22");
		diffFlag(Attr.Dim, "2", "22");
		diffFlag(Attr.Italic, "3", "23");
		// Underline and its style diff as one attribute: 24 clears both, a
		// bare 4 sets single (which also downgrades a previous double, per
		// ECMA-48 and tmux's own tracking), and 4:2 upgrades to double --
		// always after a plain 4 so unsupporting terminals degrade to single.
		if (
			(attrs & (Attr.Underline | Attr.DoubleUnderline)) !==
			(prevAttrs & (Attr.Underline | Attr.DoubleUnderline))
		) {
			if (!(attrs & Attr.Underline)) {
				push("24");
			} else {
				if (
					!(prevAttrs & Attr.Underline) ||
					(prevAttrs & Attr.DoubleUnderline && !(attrs & Attr.DoubleUnderline))
				) {
					push("4");
				}
				if (attrs & Attr.DoubleUnderline) {
					push("4:2");
				}
			}
		}
		diffFlag(Attr.Blink, "5", "25");
		diffFlag(Attr.Inverse, "7", "27");
		diffFlag(Attr.Strikethrough, "9", "29");
		diffFlag(Attr.Overline, "53", "55");
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

/**
 * Emit the grid as ANSI, row by row.
 *
 * Empty cells are skipped rather than painted, so the cursor jumps them with
 * CUF and whatever the terminal already shows there survives. `renderedLines`
 * names the rows that have been printed before; a row's first appearance opens
 * with an erase so nothing of the terminal's own is left on it.
 */
export function generateANSI(
	grid: CellGrid,
	colorDepth: ColorDepth = "rgb",
	renderedLines?: Set<number>,
): string {
	const {rows, cols, char, border} = grid;

	let output = "";
	let cursorRow = 0;
	let cursorCol = 0;
	// Flat index of the last cell emitted, whose style the next cell diffs
	// against. -1 while no cell precedes.
	let prevIndex = -1;

	let skipNextCol = -1;

	for (let row = 0; row < rows; row++) {
		const rowStart = row * cols;
		let rowHasContent = false;
		let rowHasAnsi = false;
		let isFirstRenderOfLine = false;

		for (let col = 0; col < cols; col++) {
			if (char[rowStart + col] !== 0) {
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
			const index = rowStart + col;

			if (char[index] === 0) {
				continue;
			}

			if (skipNextCol >= 0 && row === cursorRow && col === skipNextCol) {
				skipNextCol = -1;
				continue;
			}

			skipNextCol = -1;

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

			const styleSeq = styleDiff(grid, index, prevIndex, colorDepth);
			if (styleSeq !== "") {
				output += `\x1b[${styleSeq}m`; // SGR - Select Graphic Rendition
				rowHasAnsi = true;
			}

			const encoding = border[index];
			output +=
				encoding > 0 ? getBorderChar(encoding) : decodeGrapheme(char[index]);

			const width = grid.widthAt(index);
			cursorCol += width;
			prevIndex = index;

			if (width === 2) {
				skipNextCol = col + 1;
			}
		}

		if (rowHasContent) {
			prevIndex = -1;
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
	grid: CellGrid;
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
	// writes; every other row is the seeded previous frame. Writes outside
	// the bands are identical to the seeded content by construction, so
	// dropping them loses nothing.
	paintBands: Array<[number, number]> | null = null;

	constructor(
		grid: CellGrid,
		rows: number,
		cols: number,
		viewportOffset: number,
	) {
		this.grid = grid;
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

		// Printable ASCII needs no grapheme segmentation: every char is its
		// own one-cell grapheme.
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
		const grid = this.grid;
		const rowStart = terminalRow * this.cols;
		const edgeBit = edge === "underline" ? Attr.Underline : Attr.Overline;
		for (let col = x; col < x + width; col++) {
			if (col < 0 || col >= this.cols) continue;
			if (this.clipRect && !this.#inClip(y, col)) continue;
			const index = rowStart + col;
			if (grid.char[index] !== 0) {
				let attrs = grid.attrs[index] | edgeBit;
				if (style?.dim !== undefined) {
					attrs = style.dim ? attrs | Attr.Dim : attrs & ~Attr.Dim;
				}
				grid.attrs[index] = attrs;
			} else {
				grid.char[index] = 0x20;
				grid.fg[index] = (style?.fg ?? 0) & Color.Mask;
				grid.bg[index] = 0;
				grid.attrs[index] =
					edgeBit | (style?.dim ? Attr.Dim : 0) | (1 << Attr.WidthShift);
			}
			// The edge replaces a box-drawing glyph with the space that cell
			// measures as: an outline is a line of its own, not a junction.
			grid.border[index] = 0;
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
		// Per-edge overrides for differently-colored sides. A corner cell's
		// glyph spans two edges but holds one color; it takes the horizontal
		// edge's, the closest a cell gets to the browser's diagonal miter.
		edgeStyles?: {
			top?: CellStyle;
			right?: CellStyle;
			bottom?: CellStyle;
			left?: CellStyle;
		},
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

		const put = (
			col: number,
			row: number,
			encoding: number,
			edgeStyle?: CellStyle,
		) => {
			// No bounds check here: rows are DOCUMENT rows, and #setBorderCell
			// culls after applying the viewport offset -- pre-culling against
			// terminal rows dropped bottom edges the camera had scrolled INTO
			// view.
			this.#setBorderCell(col, row, encoding, edgeStyle ?? style);
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
					edgeStyles?.top,
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
					edgeStyles?.bottom,
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
				put(x, row, encode(leftEdge, 0, leftEdge, 0), edgeStyles?.left);
			}
		}

		if (hasRight && right !== x) {
			for (let row = sideTop; row <= sideBottom; row++) {
				put(right, row, encode(rightEdge, 0, rightEdge, 0), edgeStyles?.right);
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

		const grid = this.grid;
		const index = terminalRow * this.cols + col;

		// A style that names no background of its own takes the one already in
		// the cell: text painted over a filled box sits ON the fill rather than
		// punching a default-colored hole through it.
		let bgColor: number | undefined;
		if (style && style.bg == null && grid.char[index] !== 0) {
			bgColor = grid.bg[index];
		}

		grid.setCell(index, char, style, bgColor);
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

		const grid = this.grid;
		const index = terminalY * this.cols + x;

		// Two boxes sharing a cell union their edges, so a shared wall lands on
		// a tee or a cross rather than the later box's corner.
		const existing = grid.border[index];
		grid.setBorderCell(
			index,
			grid.char[index] !== 0 && existing > 0
				? mergeBorderEncodings(existing, borderEncoding)
				: borderEncoding,
			style,
		);
	}
}

export class Renderer {
	#prev: CellGrid | null = null;
	// Retired grids kept for the next frame that wants their size: the frame
	// buffer and the previous frame trade places rather than reallocating, and
	// the diff is filled and cleared in place.
	#spare: CellGrid | null = null;
	#diff: CellGrid | null = null;
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
		if (!this.#prev || this.#prevContentHeight === 0 || cols <= 0) {
			return null;
		}
		const limit = Math.min(
			this.#parkRow,
			this.#prevContentHeight,
			this.#prev.rows,
		);
		let wrapped = 0;
		for (let row = 0; row < limit; row++) {
			wrapped += Math.max(1, Math.ceil(this.#lineLength(row) / cols));
		}
		return wrapped + Math.floor(this.#parkCol / cols);
	}

	#lineLength(row: number): number {
		const grid = this.#prev!;
		const rowStart = row * grid.cols;
		for (let col = grid.cols - 1; col >= 0; col--) {
			const index = rowStart + col;
			if (grid.char[index] !== 0) {
				return col + grid.widthAt(index);
			}
		}
		return 0;
	}

	/**
	 * A cleared grid of the given size, reusing a retired one when it fits.
	 */
	#takeGrid(rows: number, cols: number): CellGrid {
		const spare = this.#spare;
		if (spare !== null && spare.rows === rows && spare.cols === cols) {
			this.#spare = null;
			spare.clear();
			return spare;
		}
		return new CellGrid(rows, cols);
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
		this.#spare = this.#prev;
		this.#prev = null;
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

		const cols = this.#cols;
		const grid = new CellGrid(rows, cols);
		drawCallback(new DrawingContext(grid, rows, cols, 0));

		const lines: string[] = [];
		for (let row = 0; row < rows; row++) {
			const rowStart = row * cols;
			// A file should not be padded out to the terminal width, so stop at the
			// last cell that actually holds something.
			let lastCol = -1;
			for (let col = cols - 1; col >= 0; col--) {
				if (grid.char[rowStart + col] !== 0) {
					lastCol = col;
					break;
				}
			}

			let line = "";
			let previous = -1;

			for (let col = 0; col <= lastCol; col++) {
				const index = rowStart + col;
				if (grid.char[index] === 0) {
					line += " ";
					continue;
				}

				const style = styleDiff(grid, index, previous, this.#colorDepth);
				if (style !== "") line += `\x1b[${style}m`;

				const encoding = grid.border[index];
				line +=
					encoding > 0
						? getBorderChar(encoding)
						: decodeGrapheme(grid.char[index]);
				previous = index;

				// A wide grapheme's continuation column is empty in the buffer but
				// already covered by the glyph -- skip it, or the line grows a
				// phantom space per wide character and shifts what follows.
				if (encoding === 0) col += grid.widthAt(index) - 1;
			}

			if (previous !== -1) line += "\x1b[0m";
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

		const cols = this.#cols;
		const next = this.#takeGrid(frameRows, cols);

		// A camera move is a rigid transform the terminal performs itself:
		// DECSTBM pins the margins to our region (a shell prompt above is
		// outside them), and DL/IL within margins move rows without touching
		// the scrollback, unlike SU. The previous buffer shifts to match; the
		// caller's bands repaint; every other row is seeded from the shifted
		// model so the diff leaves it alone. Delta 0 is a banded repaint with
		// no terminal scroll. A pending reset, a growth frame, or no previous
		// frame falls through to the full diff.
		let scrollPrefix = "";
		const scrolling =
			scroll !== undefined &&
			Math.abs(scroll.delta) < this.#rows &&
			this.#prev !== null &&
			// A rigid transform only makes sense between grids of one width.
			this.#prev.cols === cols &&
			!overflowing &&
			!this.#needsScreenReset &&
			!this.#needsFullClear &&
			cursorPosition !== undefined;
		if (scrolling && this.#prev && cursorPosition !== undefined) {
			const delta = scroll!.delta;
			const regionTop = cursorPosition;
			const regionEnd = Math.min(regionRows ?? this.#rows, this.#rows);

			// Shift the model in place: screen row r now shows what was at
			// r + delta, and the rows scrolled in from beyond the edge are
			// blank until the bands paint them.
			const prev = this.#prev;
			const prevCells = prev.rows * cols;
			const shift = Math.abs(delta) * cols;
			if (shift >= prevCells) {
				prev.clear();
			} else if (delta > 0) {
				prev.moveRange(0, shift, prevCells);
				prev.clearRange(prevCells - shift, prevCells);
			} else if (delta < 0) {
				prev.moveRange(shift, 0, prevCells - shift);
				prev.clearRange(0, shift);
			}
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
			// Contiguous non-band rows copy as one run per plane.
			const seedEnd = Math.min(frameRows, prev.rows);
			let runStart = -1;
			for (let row = 0; row <= seedEnd; row++) {
				let inBand = row === seedEnd;
				if (!inBand) {
					for (const [start, end] of scroll!.bands) {
						if (row >= start && row < end) {
							inBand = true;
							break;
						}
					}
				}
				if (inBand) {
					if (runStart >= 0) {
						next.copyFrom(prev, runStart * cols, runStart * cols, row * cols);
						runStart = -1;
					}
				} else if (runStart < 0) {
					runStart = row;
				}
			}

			// DECSTBM homes the cursor; the standard prefix always CUPs for
			// this caller afterward.
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
		const context = new DrawingContext(next, frameRows, cols, offset);
		if (scrolling) context.paintBands = scroll!.bands;
		drawCallback(context);

		// Build the diff. A frame taller than the terminal is a growth frame:
		// the rows below the fold have never been on screen, so there is nothing
		// to diff against -- print all of it.
		let diff = this.#diff;
		if (diff === null || diff.rows !== frameRows || diff.cols !== cols) {
			diff = new CellGrid(frameRows, cols);
			this.#diff = diff;
		} else {
			diff.clear();
		}

		const prev = this.#prev;
		if (prev === null || overflowing) {
			diff.copyFrom(next, 0, 0, frameRows * cols);
		} else {
			const prevRows = prev.rows;
			const prevCols = prev.cols;
			const aligned = prevCols === cols;

			for (let row = 0; row < this.#rows; row++) {
				const nextRow = row * cols;
				const prevRow = row * prevCols;
				const rowInPrev = row < prevRows;

				// A row that did not change at all is the common case, so look
				// for the first column that differs before touching the diff.
				let col = 0;
				if (aligned && rowInPrev) {
					while (col < cols) {
						const n = nextRow + col;
						const p = prevRow + col;
						if (
							next.char[n] !== prev.char[p] ||
							next.fg[n] !== prev.fg[p] ||
							next.bg[n] !== prev.bg[p] ||
							(next.attrs[n] & Attr.StyleMask) !==
								(prev.attrs[p] & Attr.StyleMask) ||
							next.border[n] !== prev.border[p]
						) {
							break;
						}
						col++;
					}
					if (col === cols) continue;
				}

				for (; col < cols; col++) {
					const n = nextRow + col;
					const nextChar = next.char[n];

					if (!rowInPrev || col >= prevCols) {
						if (nextChar !== 0) diff.setFrom(n, next, n);
						continue;
					}

					const p = prevRow + col;
					const prevChar = prev.char[p];

					if (prevChar === 0) {
						if (nextChar !== 0) diff.setFrom(n, next, n);
					} else if (nextChar === 0) {
						// A cell the frame no longer paints has to be erased,
						// not merely skipped: the terminal still shows the old
						// glyph there.
						diff.setBlank(n);
					} else if (!next.equalCells(n, prev, p)) {
						diff.setFrom(n, next, n);
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
				const rowStart = row * cols;
				let empty = true;
				for (let col = 0; col < cols; col++) {
					if (diff.char[rowStart + col] !== 0) {
						empty = false;
						break;
					}
				}
				if (empty) diff.setBlank(rowStart);
			}
		}

		// Check for content
		let hasContent = false;

		const diffCells = frameRows * cols;
		for (let index = 0; index < diffCells; index++) {
			if (diff.char[index] !== 0) {
				hasContent = true;
				break;
			}
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
		let output = generateANSI(diff, this.#colorDepth, this.#renderedLines);

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
		// The frame buffer becomes the previous frame and the retired one goes
		// back to be the next frame's, so a steady-size renderer allocates two
		// grids for its whole life.
		const retired = this.#prev;
		if (overflowing) {
			this.#prev = next.bottomRows(this.#rows);
			this.#spare = next;
		} else {
			this.#prev = next;
			this.#spare = retired;
		}
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
