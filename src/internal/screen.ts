import type {ColorDepth, Exchange} from "./exchange.ts";
import {
	getStringWidth,
	graphemeSegmenter,
	isWidthUncertain,
	PRINTABLE_ASCII,
} from "./text.ts";

function isControlByte(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

function rgbTo256(color: number): number {
	const r = (color >> 16) & 0xff;
	const g = (color >> 8) & 0xff;
	const b = color & 0xff;

	if (r === g && g === b) {
		if (r < 8) {
			return 0;
		}
		if (r > 248) {
			return 15;
		}
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
	if (r > 127) {
		ansiColor |= 1;
	}
	if (g > 127) {
		ansiColor |= 2;
	}
	if (b > 127) {
		ansiColor |= 4;
	}
	return ansiColor;
}

function getColorParameters(
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

type StyleAttribute =
	"bold" |
	"dim" |
	"italic" |
	"blink" |
	"inverse" |
	"strikethrough" |
	"overline";

type StyleAttributes = {[K in StyleAttribute]?: boolean};

type UnderlineStyle = "none" | "single" | "double";

interface StyleSpan {
	fg?: number | null;
	bg?: number | null;
	attributes?: StyleAttributes;
	underline?: UnderlineStyle;
}

function getUnderlineCodes(style: UnderlineStyle): string[] {
	switch (style) {
		case "none":
			return ["24"];
		case "single":
			return ["4"];
		case "double":
			// Plain 4 first. A terminal that ignores 4:2 still draws a line,
			// and a later plain 4 downgrades double to single (ECMA-48, and
			// tmux).
			return ["4", "4:2"];
	}
}

const kOut = Symbol("out");
const kColorDepth = Symbol("colorDepth");

class FrameWriter {
	declare [kColorDepth]: ColorDepth;

	declare [kOut]: string[];

	constructor(colorDepth: ColorDepth) {
		this[kColorDepth] = colorDepth;
		this[kOut] = [];
	}

	take(): string {
		const out = this[kOut].join("");
		this[kOut].length = 0;
		return out;
	}

	carriageReturn(): this {
		this[kOut].push("\r");
		return this;
	}

	newLine(rows = 1): this {
		this[kOut].push("\r\n".repeat(rows));
		return this;
	}

	cursorTo(row: number, col: number): this {
		this[kOut].push(`\x1b[${row};${col}H`);
		return this;
	}

	cursorForward(columns: number): this {
		this[kOut].push(`\x1b[${columns}C`);
		return this;
	}

	cursorDown(rows: number): this {
		this[kOut].push(`\x1b[${rows}B`);
		return this;
	}

	saveCursor(): this {
		this[kOut].push("\x1b7");
		return this;
	}

	restoreCursor(): this {
		this[kOut].push("\x1b8");
		return this;
	}

	eraseToLineEnd(): this {
		this[kOut].push("\x1b[K");
		return this;
	}

	eraseBelow(): this {
		this[kOut].push("\x1b[J");
		return this;
	}

	setScrollRegion(top: number, bottom: number): this {
		this[kOut].push(`\x1b[${top};${bottom}r`);
		return this;
	}

	resetScrollRegion(): this {
		this[kOut].push("\x1b[r");
		return this;
	}

	deleteLines(count: number): this {
		this[kOut].push(`\x1b[${count}M`);
		return this;
	}

	insertLines(count: number): this {
		this[kOut].push(`\x1b[${count}L`);
		return this;
	}

	resetStyle(): this {
		this[kOut].push("\x1b[0m");
		return this;
	}

	style(run: StyleSpan): this {
		const escape = createStyleEscape(run, this[kColorDepth]);
		if (escape !== "") {
			this[kOut].push(escape);
		}
		return this;
	}

	text(glyphs: string): this {
		let safe = "";
		// Text is the document's own. A control byte in it would end the
		// sequence around it and hand the rest of the string to the terminal as
		// commands.
		for (const char of glyphs) {
			if (isControlByte(char.codePointAt(0)!)) {
				continue;
			}
			safe += char;
		}
		this[kOut].push(safe);
		return this;
	}
}

/** DEC 2026: the terminal shows the frame at once rather than as it arrives. */
function wrapSynchronized(frame: string): string {
	return `\x1b[?2026h${frame}\x1b[?2026l`;
}

function createStyleEscape(run: StyleSpan, colorDepth: ColorDepth): string {
	const codes: string[] = [];
	if (run.fg !== undefined) {
		codes.push(
			run.fg === null ? "39" : getColorParameters(run.fg, true, colorDepth),
		);
	}
	if (run.bg !== undefined) {
		codes.push(
			run.bg === null ? "49" : getColorParameters(run.bg, false, colorDepth),
		);
	}

	const wanted = run.attributes;
	const state = (name: StyleAttribute, on: string, off: string) => {
		const want = wanted?.[name];
		if (want !== undefined) {
			codes.push(want ? on : off);
		}
	};

	state("bold", "1", "22");
	state("dim", "2", "22");
	state("italic", "3", "23");
	if (run.underline) {
		codes.push(...getUnderlineCodes(run.underline));
	}
	state("blink", "5", "25");
	state("inverse", "7", "27");
	state("strikethrough", "9", "29");
	state("overline", "53", "55");

	return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

export interface CellStyle {
	fg?: number | null;
	bg?: number | null;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;

	underlineStyle?: "solid" | "double";
	strikethrough?: boolean;
	inverse?: boolean;
	dim?: boolean;
	blink?: boolean;
	overline?: boolean;
}

function packAttrs(style: CellStyle | undefined): number {
	if (!style) {
		return 0;
	}
	let attrs = 0;
	if (style.bold) {
		attrs |= ATTR.Bold;
	}
	if (style.italic) {
		attrs |= ATTR.Italic;
	}
	if (style.underline) {
		attrs |= ATTR.Underline;
		if (style.underlineStyle === "double") {
			attrs |= ATTR.DoubleUnderline;
		}
	}
	if (style.strikethrough) {
		attrs |= ATTR.Strikethrough;
	}
	if (style.overline) {
		attrs |= ATTR.Overline;
	}
	if (style.inverse) {
		attrs |= ATTR.Inverse;
	}
	if (style.blink) {
		attrs |= ATTR.Blink;
	}
	if (style.dim) {
		attrs |= ATTR.Dim;
	}
	return attrs;
}

interface TextMetrics {
	width: number;
}

const COLOR_MASK = 0xffffff;

const ATTR_FLAGS = {
	Bold: 1 << 0,
	Italic: 1 << 1,
	Underline: 1 << 2,
	// SGR 4:2. Emission sends plain 4 first so a terminal that ignores 4:2
	// keeps a single underline. tmux collapses the pair and Apple Terminal
	// drops the result, so the UA sheet never uses it. Authors may.
	DoubleUnderline: 1 << 3,
	Strikethrough: 1 << 4,
	Overline: 1 << 5,
	Inverse: 1 << 6,
	Blink: 1 << 7,
	Dim: 1 << 8,
} as const;

const FG_GROUP =
	ATTR_FLAGS.Bold |
	ATTR_FLAGS.Italic |
	ATTR_FLAGS.Underline |
	ATTR_FLAGS.DoubleUnderline |
	ATTR_FLAGS.Strikethrough |
	ATTR_FLAGS.Overline;
const BG_GROUP = ATTR_FLAGS.Inverse | ATTR_FLAGS.Blink | ATTR_FLAGS.Dim;

const ATTR = {
	...ATTR_FLAGS,
	FGGroup: FG_GROUP,
	BGGroup: BG_GROUP,
	StyleMask: FG_GROUP | BG_GROUP,
	WidthShift: 9,
	WidthMask: 0x1f << 9,
	WidthWide: 0x1f,
} as const;

// At or above this a char-plane value indexes internedGraphemes. Below
// it the value is the code point. Zero is the empty cell.
const CHAR_INTERNED = 0x8000_0000;

// Clusters of more than one code point, referenced by index so a cell
// stays one uint32. Append-only: an id refers to the same cluster for
// the life of the process, so a value copied between grids stays valid.
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

function decodeGrapheme(char: number): string {
	return char >= CHAR_INTERNED
		? internedGraphemes[char - CHAR_INTERNED]
		: String.fromCodePoint(char);
}

const BORDER_EDGE_STYLE = {
	// Style values (bits 3-0)
	None: 0b0000,
	Dotted: 0b0001,
	Dashed: 0b0010,
	Solid: 0b0011,
	Groove: 0b0100,
	Ridge: 0b0101,
	Inset: 0b0110,
	Outset: 0b0111,
	Double: 0b1000,
	Hidden: 0b1111,

	// Flags (bit 4+)
	// Set on the edges that meet in a corner cell whose radius rounds it,
	// and on nothing else. The runs between corners are the same line either
	// way.
	Rounded: 0b00010000,
} as const;

const BORDER_MASK = {
	Top: 0x000000ff,
	Right: 0x0000ff00,
	Bottom: 0x00ff0000,
	Left: 0xff000000,
	Edge: 0xff,
	Style: 0b00001111,
} as const;

const BORDER_SHIFT = {
	Top: 0,
	Right: 8,
	Bottom: 16,
	Left: 24,
} as const;

const BORDER_EDGE_MASKS = [
	BORDER_MASK.Top,
	BORDER_MASK.Right,
	BORDER_MASK.Bottom,
	BORDER_MASK.Left,
];

function getBorderEdge(border: number, mask: number): number {
	const shift = Math.log2(mask & -mask);
	return (border & mask) >> shift;
}

function setBorderEdge(
	border: number,
	mask: number,
	edgeValue: number,
): number {
	const shift = Math.log2(mask & -mask);
	return (border & ~mask) | ((edgeValue << shift) & mask);
}

function getEdgeStyle(edgeValue: number): number {
	return edgeValue & BORDER_MASK.Style;
}

function getEdgePresence(edgeValue: number): boolean {
	const style = edgeValue & BORDER_MASK.Style;
	return style !== BORDER_EDGE_STYLE.None && style !== BORDER_EDGE_STYLE.Hidden;
}

function getEdgeRounded(edgeValue: number): boolean {
	return (edgeValue & BORDER_EDGE_STYLE.Rounded) !== 0;
}

/**
 * A border line: the CSS keyword and its color, or the terminal's
 * default foreground when absent. A cap says how an end finishes. By
 * default it stops at the end cell's center, so another line's
 * half-stroke joins with it into a corner or a tee. "square" projects
 * through the cell for a free end. "round" curves the glyph where two
 * capped ends meet.
 */
export const LINE_STYLES = [
	"solid",
	"double",
	"dashed",
	"dotted",
	"groove",
	"ridge",
	"inset",
	"outset",
	"hidden",
] as const;

export interface LineStyle {
	style: (typeof LINE_STYLES)[number];
	color?: number | null;
	startCap?: "round" | "square";
	endCap?: "round" | "square";
}

const LINE_BITS: Record<LineStyle["style"], number> = {
	solid: BORDER_EDGE_STYLE.Solid,
	double: BORDER_EDGE_STYLE.Double,
	dashed: BORDER_EDGE_STYLE.Dashed,
	dotted: BORDER_EDGE_STYLE.Dotted,
	groove: BORDER_EDGE_STYLE.Groove,
	ridge: BORDER_EDGE_STYLE.Ridge,
	inset: BORDER_EDGE_STYLE.Inset,
	outset: BORDER_EDGE_STYLE.Outset,
	hidden: BORDER_EDGE_STYLE.Hidden,
};

const BOX_DRAWING: Record<string, {
	horizontal: string;
	vertical: string;
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	topTee: string;
	bottomTee: string;
	leftTee: string;
	rightTee: string;
	cross: string;
}> = {
	dashed: {
		horizontal: "╌",
		vertical: "┆",
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	},
	dotted: {
		horizontal: "┄",
		vertical: "┊",
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	},
	double: {
		horizontal: "═",
		vertical: "║",
		topLeft: "╔",
		topRight: "╗",
		bottomLeft: "╚",
		bottomRight: "╝",
		topTee: "╦",
		bottomTee: "╩",
		leftTee: "╣",
		rightTee: "╠",
		cross: "╬",
	},
	heavy: {
		horizontal: "━",
		vertical: "┃",
		topLeft: "┏",
		topRight: "┓",
		bottomLeft: "┗",
		bottomRight: "┛",
		topTee: "┳",
		bottomTee: "┻",
		leftTee: "┫",
		rightTee: "┣",
		cross: "╋",
	},
	light: {
		horizontal: "─",
		vertical: "│",
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	},
};

// Only the light stroke has rounded glyphs. Double and heavy corners
// stay square because no character bends them.
const ROUNDED_CORNERS: Readonly<Record<string, string>> = {
	"┌": "╭",
	"┐": "╮",
	"└": "╰",
	"┘": "╯",
};

function getBorderChar(borderEncoding: number): string {
	const topEdge = getBorderEdge(borderEncoding, BORDER_MASK.Top);
	const rightEdge = getBorderEdge(borderEncoding, BORDER_MASK.Right);
	const bottomEdge = getBorderEdge(borderEncoding, BORDER_MASK.Bottom);
	const leftEdge = getBorderEdge(borderEncoding, BORDER_MASK.Left);

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

	// Solid is the light stroke, and so are ridge, inset and outset. A
	// terminal draws one weight of line, so the three shaded keywords use
	// the glyphs their unshaded relative uses.
	let charSet = BOX_DRAWING.light;
	switch (dominantStyle) {
		case BORDER_EDGE_STYLE.Double:
			charSet = BOX_DRAWING.double;
			break;
		case BORDER_EDGE_STYLE.Dashed:
			charSet = BOX_DRAWING.dashed;
			break;
		case BORDER_EDGE_STYLE.Dotted:
			charSet = BOX_DRAWING.dotted;
			break;
		case BORDER_EDGE_STYLE.Groove:
			charSet = BOX_DRAWING.heavy;
			break;
	}

	const count =
		(hasTop ? 1 : 0) +
		(hasRight ? 1 : 0) +
		(hasBottom ? 1 : 0) +
		(hasLeft ? 1 : 0);

	if (count === 4) {
		return charSet.cross; // ┼
	}

	if (count === 3) {
		if (!hasTop) {
			return charSet.topTee; // ┬
		}
		if (!hasBottom) {
			return charSet.bottomTee; // ┴
		}
		if (!hasLeft) {
			return charSet.rightTee; // ├
		}
		return charSet.leftTee; // ┤
	}

	// A corner takes its rounded form where one exists. The character set
	// is still the border style's (a rounded dashed box keeps its dashes
	// and bends only the four cells where the strokes turn), and a style
	// whose corner has no rounded glyph stays square. See ROUNDED_CORNERS.
	const corner =
		hasRight && hasBottom
			? charSet.topLeft // ┌
			: hasLeft && hasBottom
				? charSet.topRight // ┐
				: hasRight && hasTop
					? charSet.bottomLeft // └
					: hasLeft && hasTop
						? charSet.bottomRight // ┘
						: null;
	if (corner !== null) {
		return hasRounded ? (ROUNDED_CORNERS[corner] ?? corner) : corner;
	}

	if (hasLeft || hasRight) {
		return charSet.horizontal; // ─
	}
	if (hasTop || hasBottom) {
		return charSet.vertical; // │
	}

	return " ";
}

/**
 * Parallel typed-array planes indexed by `row * cols + col`. A color of
 * 0 is the terminal's default, not black. It is the sentinel the diff
 * writes as 39/49. A char of 0 is an empty cell, including the column a
 * two-column glyph covers. The glyph's width text control steps the emitter
 * over it.
 */
class CellGrid {
	readonly rows: number;
	readonly cols: number;
	readonly cluster: Uint32Array;
	readonly fg: Uint32Array;
	readonly bg: Uint32Array;
	readonly attrs: Uint16Array;
	readonly border: Uint32Array;

	constructor(rows: number, cols: number) {
		this.rows = rows;
		this.cols = cols;
		const size = rows * cols;
		this.cluster = new Uint32Array(size);
		this.fg = new Uint32Array(size);
		this.bg = new Uint32Array(size);
		this.attrs = new Uint16Array(size);
		this.border = new Uint32Array(size);
	}

	clear(): void {
		this.cluster.fill(0);
		this.fg.fill(0);
		this.bg.fill(0);
		this.attrs.fill(0);
		this.border.fill(0);
	}

	clearRange(start: number, end: number): void {
		if (end <= start) {
			return;
		}
		this.cluster.fill(0, start, end);
		this.fg.fill(0, start, end);
		this.bg.fill(0, start, end);
		this.attrs.fill(0, start, end);
		this.border.fill(0, start, end);
	}

	moveRange(dest: number, srcStart: number, srcEnd: number): void {
		this.cluster.copyWithin(dest, srcStart, srcEnd);
		this.fg.copyWithin(dest, srcStart, srcEnd);
		this.bg.copyWithin(dest, srcStart, srcEnd);
		this.attrs.copyWithin(dest, srcStart, srcEnd);
		this.border.copyWithin(dest, srcStart, srcEnd);
	}

	copyFrom(
		source: CellGrid,
		{to, start, end}: {to: number; start: number; end: number},
	): void {
		this.cluster.set(source.cluster.subarray(start, end), to);
		this.fg.set(source.fg.subarray(start, end), to);
		this.bg.set(source.bg.subarray(start, end), to);
		this.attrs.set(source.attrs.subarray(start, end), to);
		this.border.set(source.border.subarray(start, end), to);
	}

	bottomRows(rows: number): CellGrid {
		const kept = new CellGrid(rows, this.cols);
		kept.copyFrom(this, {
			to: 0,
			start: (this.rows - rows) * this.cols,
			end: this.rows * this.cols,
		});
		return kept;
	}

	setCell(
		index: number,
		grapheme: string,
		{style, background}: {style?: CellStyle; background?: number} = {},
	): void {
		const width = getGraphemeColumns(grapheme);
		this.cluster[index] = encodeGrapheme(grapheme);
		this.fg[index] = (style?.fg ?? 0) & COLOR_MASK;
		this.bg[index] =
			background !== undefined ? background : (style?.bg ?? 0) & COLOR_MASK;
		this.attrs[index] =
			packAttrs(style) |
			((width < ATTR.WidthWide ? width : ATTR.WidthWide) << ATTR.WidthShift);
		this.border[index] = 0;
	}

	setBorderCell(index: number, border: number, style?: CellStyle): void {
		// A border strokes. It does not fill. The cell keeps the background the
		// fills beneath it painted, unless the caller specifies one.
		const bg = style?.bg != null ? style.bg & COLOR_MASK : this.bg[index];
		this.cluster[index] = 0x20;
		this.fg[index] = (style?.fg ?? 0) & COLOR_MASK;
		this.bg[index] = bg;
		this.attrs[index] =
			(packAttrs(style) & ~ATTR.DoubleUnderline) | (1 << ATTR.WidthShift);
		this.border[index] = border;
	}

	setBlank(index: number): void {
		this.cluster[index] = 0x20;
		this.fg[index] = 0;
		this.bg[index] = 0;
		this.attrs[index] = 1 << ATTR.WidthShift;
		this.border[index] = 0;
	}

	setFrom(index: number, source: CellGrid, sourceIndex: number): void {
		this.cluster[index] = source.cluster[sourceIndex];
		this.fg[index] = source.fg[sourceIndex];
		this.bg[index] = source.bg[sourceIndex];
		this.attrs[index] = source.attrs[sourceIndex];
		this.border[index] = source.border[sourceIndex];
	}

	widthAt(index: number): number {
		const width = (this.attrs[index] & ATTR.WidthMask) >>> ATTR.WidthShift;
		return width === ATTR.WidthWide
			? getStringWidth(decodeGrapheme(this.cluster[index]))
			: width;
	}

	equalCells(index: number, other: CellGrid, otherIndex: number): boolean {
		return (
			this.cluster[index] === other.cluster[otherIndex] &&
			this.fg[index] === other.fg[otherIndex] &&
			this.bg[index] === other.bg[otherIndex] &&
			(this.attrs[index] & ATTR.StyleMask) ===
			(other.attrs[otherIndex] & ATTR.StyleMask) &&
			this.border[index] === other.border[otherIndex]
		);
	}
}

function meetEdges(existing: number, incoming: number): number {
	let met = 0;
	for (const mask of BORDER_EDGE_MASKS) {
		const here = getBorderEdge(existing, mask);
		const there = getBorderEdge(incoming, mask);
		if (!getEdgePresence(here)) {
			met = setBorderEdge(met, mask, there);
		} else if (!getEdgePresence(there)) {
			met = setBorderEdge(met, mask, here);
		} else {
			met = setBorderEdge(
				met,
				mask,
				getEdgeStyle(there) > getEdgeStyle(here) ? there : here,
			);
		}
	}

	return met;
}

function joinTouchingBorders(grid: CellGrid): void {
	const {rows, cols, border} = grid;
	const painted = border.slice();
	// Which neighbour to look at for each edge of a cell, and which of that
	// neighbour's edges would run into this one.
	const REACHES: Array<{mask: number; step: number; from: number}> = [
		{mask: BORDER_MASK.Top, step: -cols, from: BORDER_MASK.Bottom},
		{mask: BORDER_MASK.Bottom, step: cols, from: BORDER_MASK.Top},
		{mask: BORDER_MASK.Left, step: -1, from: BORDER_MASK.Right},
		{mask: BORDER_MASK.Right, step: 1, from: BORDER_MASK.Left},
	];

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const index = row * cols + col;
			const own = painted[index];
			if (own === 0) {
				continue;
			}
			let joined = border[index];
			for (const {mask, step, from} of REACHES) {
				if ((own & mask) !== 0) {
					continue;
				}
				const neighbour = index + step;
				if (mask === BORDER_MASK.Top && row === 0) {
					continue;
				}
				if (mask === BORDER_MASK.Bottom && row === rows - 1) {
					continue;
				}
				if (mask === BORDER_MASK.Left && col === 0) {
					continue;
				}
				if (mask === BORDER_MASK.Right && col === cols - 1) {
					continue;
				}
				const edge = getBorderEdge(painted[neighbour], from);
				if (!getEdgePresence(edge)) {
					continue;
				}
				joined = meetEdges(joined, setBorderEdge(0, mask, edge));
			}

			border[index] = joined;
		}
	}
}

function getGridLine(grid: CellGrid, row: number, writer: FrameWriter): string {
	const rowStart = row * grid.cols;
	// A file should not be padded out to the terminal width, so stop at the
	// last cell that actually holds something.
	let lastCol = -1;
	for (let col = grid.cols - 1; col >= 0; col--) {
		if (grid.cluster[rowStart + col] !== 0) {
			lastCol = col;
			break;
		}
	}

	let previous = -1;
	for (let col = 0; col <= lastCol; col++) {
		const index = rowStart + col;
		if (grid.cluster[index] === 0) {
			writer.text(" ");
			continue;
		}

		getStyleDiff(grid, index, previous, writer);

		const encoding = grid.border[index];
		writer.text(
			encoding > 0
				? getBorderChar(encoding)
				: decodeGrapheme(grid.cluster[index]),
		);
		previous = index;

		// A wide grapheme's continuation column is empty in the buffer but
		// already covered by the glyph. Skip it, or the line grows a phantom
		// space per wide character and shifts what follows.
		if (encoding === 0) {
			col += Math.max(1, grid.widthAt(index)) - 1;
		}
	}

	if (previous !== -1) {
		writer.resetStyle();
	}
	return writer.take();
}

function getLineLength(grid: CellGrid, row: number): number {
	const rowStart = row * grid.cols;
	for (let col = grid.cols - 1; col >= 0; col--) {
		const index = rowStart + col;
		if (grid.cluster[index] !== 0) {
			return col + Math.max(1, grid.widthAt(index));
		}
	}
	return 0;
}

function encodeGrapheme(grapheme: string): number {
	const code = grapheme.codePointAt(0)!;
	if (grapheme.length === (code > 0xffff ? 2 : 1)) {
		return code;
	}
	return CHAR_INTERNED | internGrapheme(grapheme);
}

function getGraphemeColumns(grapheme: string): number {
	// Printable ASCII is the common case and always 1, so skip the tests
	// getStringWidth starts with.
	const code = grapheme.charCodeAt(0);
	if (grapheme.length === 1 && code >= 0x20 && code <= 0x7e) {
		return 1;
	}
	return getStringWidth(grapheme);
}

export class CellContext {
	grid: CellGrid;
	rows: number;
	cols: number;
	viewportOffset: number;
	// Where a focused text control wants the real cursor. IME composition anchors
	// there, so an inverse-cell caret is not enough for text entry.
	caret: {col: number; row: number} | null;
	// The overflow:hidden clip in document (row, col) space. An edge is
	// +-Infinity on an axis that is not clipped. Null when none is active.
	clipRect: {
		left: number;
		top: number;
		right: number;
		bottom: number;
	} | null;

	constructor(
		grid: CellGrid,
		rows: number,
		cols: number,
		viewportOffset: number,
	) {
		this.caret = null;
		this.clipRect = null;
		this.grid = grid;
		this.rows = rows;
		this.cols = cols;
		this.viewportOffset = viewportOffset;
	}

	setCaret(x: number, y: number): void {
		this.caret = {col: x, row: y};
	}

	drawRect(
		x: number,
		y: number,
		width: number,
		height: number,
		background: number | null | undefined | "default" | "inverse",
	): void {
		if (background == null) {
			return;
		}

		// "default" clears the cells to the terminal's own background (CSS's
		// Canvas system color), which still OVERWRITES whatever was painted
		// underneath with an opaque box in the theme's color, whatever that
		// theme is. "inverse" fills with SGR inverse instead. That is the
		// Highlight/HighlightText system-color pair, swapping each cell's
		// colors with no assumption about what they are.
		const style: CellStyle =
			background === "inverse"
				? {inverse: true}
				: {bg: background === "default" ? undefined : background};

		for (let row = y; row < y + height; row++) {
			for (let col = x; col < x + width; col++) {
				setCell(this, row, col, " ", style);
			}
		}
	}

	measureText(text: string): TextMetrics {
		if (PRINTABLE_ASCII.test(text)) {
			return {width: text.length};
		}
		let width = 0;
		for (const segment of graphemeSegmenter.segment(text)) {
			width += getStringWidth(segment.segment);
		}
		return {width};
	}

	drawText(text: string, x: number, y: number, style?: CellStyle): void {
		let currentX = x;

		if (PRINTABLE_ASCII.test(text)) {
			for (let i = 0; i < text.length; i++) {
				if (currentX + 1 > this.cols) {
					break;
				}
				setCell(this, y, currentX, text[i], style);
				currentX++;
			}
			return;
		}

		for (const segment of graphemeSegmenter.segment(text)) {
			const char = segment.segment;

			// Never write a control char to a cell. A cell is a column, and a
			// control byte must be rejected before it takes one, or it survives
			// to the output as a raw escape byte (injection from untrusted
			// text).
			if (isControlByte(char.codePointAt(0)!)) {
				continue;
			}

			const width = getStringWidth(char);

			// A soft hyphen or a lone format character has no width and takes
			// no cell. A cell holding one would send every walk over the row
			// backwards.
			if (width === 0) {
				continue;
			}
			if (currentX + width > this.cols) {
				break;
			}

			setCell(this, y, currentX, char, style);
			currentX += width;
		}
	}

	drawDecoration(x: number, y: number, width: number, style: CellStyle): void {
		// An edge across existing glyphs, which drawText cannot draw because it
		// overwrites. The style's fg is the row's default. A cell with its own
		// (::selection, ::placeholder, an authored color) keeps it.
		const grid = this.grid;
		const edgeBit =
			(style.underline ? ATTR.Underline : 0) |
			(style.overline ? ATTR.Overline : 0);
		if (edgeBit === 0) {
			return;
		}
		for (let col = x; col < x + width; col++) {
			const index = getGuardedWriteIndex(this, y, col);
			if (index < 0) {
				continue;
			}
			if (grid.cluster[index] !== 0) {
				let attrs = grid.attrs[index] | edgeBit;
				if (style.dim !== undefined) {
					attrs = style.dim ? attrs | ATTR.Dim : attrs & ~ATTR.Dim;
				}
				grid.attrs[index] = attrs;
			} else {
				grid.cluster[index] = 0x20;
				grid.fg[index] = (style.fg ?? 0) & COLOR_MASK;
				grid.bg[index] = 0;
				grid.attrs[index] =
					edgeBit | (style.dim ? ATTR.Dim : 0) | (1 << ATTR.WidthShift);
			}
			// The edge replaces a box-drawing glyph with the space that cell
			// measures as. An outline is a line of its own, not a junction.
			grid.border[index] = 0;
		}
	}

	drawLine(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		line: LineStyle,
	): void {
		// Axis-aligned, half-open. The stroke runs from the start cell toward
		// the end coordinate and stops short of it, so a one-cell vertical is
		// (x, y, x, y + 1) and equal points stroke nothing. That is also what
		// disambiguates the axis of a one-cell line.
		if ((x1 !== x2 && y1 !== y2) || (x1 === x2 && y1 === y2)) {
			return;
		}
		const bits = LINE_BITS[line.style];
		if (bits === 0) {
			return;
		}
		const style: CellStyle | undefined =
			line.color != null ? {fg: line.color} : undefined;
		const rounded = BORDER_EDGE_STYLE.Rounded;

		// Each cell records which way the stroke LEAVES it, and an end cell
		// keeps only its inward half. The stroke enters and stops at center.
		// Two lines meeting in a cell then join into the corner, the tee or the
		// cross without either knowing the other exists. A "square" cap
		// projects through its cell instead, for a free end. A "round" cap is
		// recorded on the half-stroke, which is how a corner cell learns it
		// curves.
		if (y1 === y2) {
			const a = Math.min(x1, x2);
			const b = Math.max(x1, x2) - 1;
			const capA = x1 <= x2 ? line.startCap : line.endCap;
			const capB = x1 <= x2 ? line.endCap : line.startCap;
			for (let col = a; col <= b; col++) {
				let toRight = col < b || capB === "square" ? bits : 0;
				let toLeft = col > a || capA === "square" ? bits : 0;
				if (col === a && capA === "round") {
					toRight |= rounded;
				}
				if (col === b && capB === "round") {
					toLeft |= rounded;
				}
				setBorderCell(
					this,
					col,
					y1,
					(toRight << BORDER_SHIFT.Right) | (toLeft << BORDER_SHIFT.Left),
					style,
				);
			}
		} else {
			const a = Math.min(y1, y2);
			const b = Math.max(y1, y2) - 1;
			const capA = y1 <= y2 ? line.startCap : line.endCap;
			const capB = y1 <= y2 ? line.endCap : line.startCap;
			for (let row = a; row <= b; row++) {
				let down = row < b || capB === "square" ? bits : 0;
				let up = row > a || capA === "square" ? bits : 0;
				if (row === a && capA === "round") {
					down |= rounded;
				}
				if (row === b && capB === "round") {
					up |= rounded;
				}
				setBorderCell(
					this,
					x1,
					row,
					(down << BORDER_SHIFT.Bottom) | (up << BORDER_SHIFT.Top),
					style,
				);
			}
		}
	}

	drawBox(
		x: number,
		y: number,
		width: number,
		height: number,
		sides: {
			top?: LineStyle;
			right?: LineStyle;
			bottom?: LineStyle;
			left?: LineStyle;
			topLeft?: "round";
			topRight?: "round";
			bottomRight?: "round";
			bottomLeft?: "round";
		},
	): void {
		if (width < 1 || height < 1) {
			return;
		}
		const r = x + width - 1;
		const b = y + height - 1;
		const cap = (
			adjacent: LineStyle | undefined,
			corner: "round" | undefined,
		): "round" | "square" | undefined => (adjacent ? corner : "square");

		// Verticals first. A corner cell's glyph spans two sides but holds one
		// color, and the horizontal side's wins, which is the closest a cell
		// gets to the browser's diagonal miter.
		if (sides.left) {
			this.drawLine(x, y, x, b + 1, {
				...sides.left,
				startCap: cap(sides.top, sides.topLeft),
				endCap: cap(sides.bottom, sides.bottomLeft),
			});
		}
		if (sides.right) {
			this.drawLine(r, y, r, b + 1, {
				...sides.right,
				startCap: cap(sides.top, sides.topRight),
				endCap: cap(sides.bottom, sides.bottomRight),
			});
		}
		if (sides.top) {
			this.drawLine(x, y, r + 1, y, {
				...sides.top,
				startCap: cap(sides.left, sides.topLeft),
				endCap: cap(sides.right, sides.topRight),
			});
		}
		// A 1-row box's bottom shares the top's row, and the top already drew
		// it.
		if (sides.bottom && !(b === y && sides.top)) {
			this.drawLine(x, b, r + 1, b, {
				...sides.bottom,
				startCap: cap(sides.left, sides.bottomLeft),
				endCap: cap(sides.right, sides.bottomRight),
			});
		}
	}
}

function inClip(
	context: CellContext,
	row: number,
	col: number,
): boolean {
	if (!context.clipRect) {
		return true;
	}
	const {left, top, right, bottom} = context.clipRect;
	return col >= left && col < right && row >= top && row < bottom;
}

function getGuardedWriteIndex(
	context: CellContext,
	row: number,
	col: number,
): number {
	const terminalRow = row + context.viewportOffset;
	if (
		terminalRow < 0 ||
		terminalRow >= context.rows ||
		col < 0 ||
		col >= context.cols
	) {
		return -1;
	}
	if (!inClip(context, row, col)) {
		return -1;
	}
	return terminalRow * context.cols + col;
}

function setCell(
	context: CellContext,
	row: number,
	col: number,
	char: string,
	style?: CellStyle,
): void {
	const index = getGuardedWriteIndex(context, row, col);
	if (index < 0) {
		return;
	}

	const grid = context.grid;

	// A style that names no background of its own takes the one already in
	// the cell. Text painted over a filled box sits ON the fill rather than
	// punching a default-colored hole through it.
	let bgColor: number | undefined;
	if (style && style.bg == null && grid.cluster[index] !== 0) {
		bgColor = grid.bg[index];
	}

	grid.setCell(index, char, {style, background: bgColor});
}

function setBorderCell(
	context: CellContext,
	x: number,
	y: number,
	borderEncoding: number,
	style?: CellStyle,
): void {
	// A box whose extent touches an exposed row still stamps its whole
	// outline. The gate drops the strokes on carried-over rows (a top border
	// row carrying a legend, say), which keep what the seeded grid holds.
	const index = getGuardedWriteIndex(context, y, x);
	if (index < 0) {
		return;
	}

	const grid = context.grid;

	// Two boxes sharing a cell union their edges, so a shared wall becomes a
	// tee or a cross rather than the later box's corner.
	const existing = grid.border[index];
	grid.setBorderCell(
		index,
		grid.cluster[index] !== 0 && existing > 0
			? meetEdges(existing, borderEncoding)
			: borderEncoding,
		style,
	);
}

function getStyleDiff(
	grid: CellGrid,
	index: number,
	prev: number,
	writer: FrameWriter,
): void {
	const fg = grid.fg[index];
	const bg = grid.bg[index];
	const attrs = grid.attrs[index] & ATTR.StyleMask;

	if (prev < 0) {
		writer.style({
			fg: fg === 0 ? undefined : fg,
			bg: bg === 0 ? undefined : bg,
			attributes: getChangedAttributes(attrs, 0),
			underline: getUnderline(attrs) === "none"
				? undefined
				: getUnderline(attrs),
		});
		return;
	}

	const prevFg = grid.fg[prev];
	const prevBg = grid.bg[prev];
	const prevAttrs = grid.attrs[prev] & ATTR.StyleMask;

	if (
		fg === prevFg &&
		bg === prevBg &&
		attrs === prevAttrs &&
		grid.border[index] === grid.border[prev]
	) {
		return;
	}

	// Everything back to the terminal's own defaults is one code, not nine.
	// Two cells that are both already default differ only in a border
	// encoding, which the glyph carries rather than the SGR.
	const wasDefault = prevFg === 0 && prevBg === 0 && prevAttrs === 0;
	if (fg === 0 && bg === 0 && attrs === 0) {
		if (!wasDefault) {
			writer.resetStyle();
		}
		return;
	}

	// A color moves with its attribute group, so a run of identically
	// styled cells emits nothing at all.
	const fgChanged =
		fg !== prevFg || (attrs & ATTR.FGGroup) !== (prevAttrs & ATTR.FGGroup);
	const bgChanged =
		bg !== prevBg || (attrs & ATTR.BGGroup) !== (prevAttrs & ATTR.BGGroup);

	const run: StyleSpan = {};
	if (fgChanged) {
		run.fg = fg === 0 ? null : fg;
	}
	if (bgChanged) {
		run.bg = bg === 0 ? null : bg;
	}
	if (fgChanged || bgChanged) {
		run.attributes = getChangedAttributes(attrs, prevAttrs);
		if (getUnderline(attrs) !== getUnderline(prevAttrs)) {
			run.underline = getUnderline(attrs);
		}
	}

	writer.style(run);
}

function getUnderline(attrs: number): UnderlineStyle {
	if (!(attrs & ATTR.Underline)) {
		return "none";
	}
	return attrs & ATTR.DoubleUnderline ? "double" : "single";
}

function getChangedAttributes(
	attrs: number,
	prevAttrs: number,
): StyleAttributes {
	const changed: StyleAttributes = {};
	const flag = (bit: number, name: StyleAttribute) => {
		if ((attrs & bit) !== (prevAttrs & bit)) {
			changed[name] = (attrs & bit) !== 0;
		}
	};

	flag(ATTR.Bold, "bold");
	flag(ATTR.Dim, "dim");
	flag(ATTR.Italic, "italic");
	flag(ATTR.Blink, "blink");
	flag(ATTR.Inverse, "inverse");
	flag(ATTR.Strikethrough, "strikethrough");
	flag(ATTR.Overline, "overline");
	return changed;
}

function moveCursor(
	writer: FrameWriter,
	currentRow: number,
	currentCol: number,
	targetRow: number,
	targetCol: number,
): string {
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
		writer.newLine(rowDiff);
		if (targetCol > 0) {
			writer.cursorForward(targetCol);
		}
		return writer.take();
	}
	if (targetCol === currentCol) {
		return "";
	}
	if (targetCol === 0) {
		return writer.carriageReturn().take();
	}
	return writer.cursorForward(targetCol - currentCol).take();
}

// The widest advance a probe's reply is believed to describe.
const PROBE_RESIDUE_COLUMNS = 4;

function safeProbeCell(grid: CellGrid): {row: number; col: number} | null {
	// Only the first painted row can hide a probe. Emission never moves the
	// cursor back up, so content could not paint over probes on a later row.
	const {rows, cols, cluster, border} = grid;
	if (cols <= PROBE_RESIDUE_COLUMNS) {
		return null;
	}

	for (let row = 0; row < rows; row++) {
		const rowStart = row * cols;
		let spanStart = -1;
		let col = 0;
		let rowHasContent = false;

		while (col < cols) {
			const index = rowStart + col;
			if (cluster[index] === 0) {
				spanStart = -1;
				col++;
				continue;
			}
			rowHasContent = true;
			if (spanStart < 0) {
				spanStart = col;
			}
			// A wide glyph covers its continuation column too, which the grid
			// leaves empty. The span runs on across it.
			col += border[index] > 0 ? 1 : Math.max(1, grid.widthAt(index));
			if (
				col - spanStart >= PROBE_RESIDUE_COLUMNS &&
				spanStart + PROBE_RESIDUE_COLUMNS < cols
			) {
				return {row, col: spanStart};
			}
		}

		if (rowHasContent) {
			return null;
		}
	}

	return null;
}

function generateANSI(
	grid: CellGrid,
	writer: FrameWriter,
	renderedLines: Set<number>,
	measurer?: Exchange,
): string {
	const {rows, cols, cluster, border} = grid;

	let output = "";
	let cursorRow = 0;
	let cursorCol = 0;
	let prevIndex = -1;

	// The first column after the glyph last emitted on this row, when
	// that glyph is wider than one cell. A cell written inside the span (a
	// selection or caret measured off a cluster boundary) cannot be
	// reached without moving the cursor back, so it is not emitted.
	let coveredUntil = -1;

	// The emission run the cursor is in (every move ends one), and how many
	// unmeasured clusters this row has painted. Each can carry the real
	// cursor a column either side of the predicted one.
	let run = 0;
	let unknownInRow = 0;

	// Clusters the margin has deferred are probed off to the side, before
	// the frame paints anything. The probes go to cells the first painted
	// row covers, and that row's own content lands on top of them in this
	// same write, so nothing of them is ever on screen.
	if (measurer !== undefined) {
		const deferred = measurer.deferredWidths();
		if (deferred.size > 0) {
			const cell = safeProbeCell(grid);
			if (cell !== null) {
				output += moveCursor(writer, 0, 0, cell.row, 0);
				cursorRow = cell.row;
				cursorCol = 0;
				// probe() takes the cluster out of the set being iterated.
				for (const cluster of [...deferred]) {
					writer.carriageReturn();
					if (cell.col > 0) {
						writer.cursorForward(cell.col);
					}
					// Each probe is reached by naming its column outright, so
					// no probed glyph's advance carries into the next.
					run++;
					output +=
						writer.text(cluster).take() +
						measurer.probeWidth(
							cluster,
							run,
							cell.col,
							getStringWidth(cluster),
						);
				}
				output += writer.carriageReturn().take();
				run++;
			}
		}
	}

	for (let row = 0; row < rows; row++) {
		const rowStart = row * cols;
		let rowHasContent = false;
		let rowHasANSI = false;
		let isFirstRenderOfLine = false;
		unknownInRow = 0;

		for (let col = 0; col < cols; col++) {
			if (cluster[rowStart + col] !== 0) {
				rowHasContent = true;
				break;
			}
		}

		if (rowHasContent) {
			isFirstRenderOfLine = !renderedLines.has(row);
			if (isFirstRenderOfLine) {
				renderedLines.add(row);
			}
		}

		for (let col = 0; col < cols; col++) {
			const index = rowStart + col;

			if (cluster[index] === 0) {
				continue;
			}

			if (row === cursorRow && col < coveredUntil) {
				continue;
			}

			if (row !== cursorRow || col !== cursorCol) {
				const moveSeq = moveCursor(writer, cursorRow, cursorCol, row, col);
				output += moveSeq;
				cursorRow = row;
				cursorCol = col;
				// A carriage return puts the cursor in a column named
				// absolutely, so whatever the glyphs before it really did stops
				// mattering and a new run begins. A bare cursor-forward does
				// not. It steps from wherever the cursor actually is, carrying
				// any divergence with it, and the run continues.
				if (measurer !== undefined && moveSeq.includes("\r")) {
					run++;
				}
			}

			if (isFirstRenderOfLine) {
				output += writer.carriageReturn().eraseToLineEnd().take();
				if (col > 0) {
					output += writer.cursorForward(col).take();
				}
				cursorCol = col;
				isFirstRenderOfLine = false;
				if (measurer !== undefined) {
					run++;
				}
			}

			getStyleDiff(grid, index, prevIndex, writer);
			const styleSeq = writer.take();
			if (styleSeq !== "") {
				output += styleSeq;
				rowHasANSI = true;
			}

			const encoding = border[index];
			const glyph =
				encoding > 0 ? getBorderChar(encoding) : decodeGrapheme(cluster[index]);
			output += writer.text(glyph).take();

			const width = grid.widthAt(index);

			// Only clusters terminals disagree about are probed. The char test
			// keeps ASCII from reaching isWidthUncertain, and a border glyph is
			// a character this engine chose.
			if (measurer !== undefined && encoding === 0) {
				const code = cluster[index];
				if (
					(code > 0x7e || code < 0x20) &&
					isWidthUncertain(glyph) &&
					measurer.wantsWidth(glyph)
				) {
					// Near the right margin the reply is unreadable. A glyph
					// that reaches the last column leaves the cursor there with
					// wrap pending rather than past it, and the reply reports
					// the same column for two different advances. The room to
					// leave is the widest advance a cluster can plausibly have,
					// plus what the unmeasured clusters already on this row may
					// have pushed the real cursor past the predicted one.
					//
					// Defer instead. The cluster keeps its place in line and
					// gets measured wherever it next appears with room, or, if
					// it never has room, among a later frame's probes.
					if (col + PROBE_RESIDUE_COLUMNS + 2 * unknownInRow < cols) {
						output += measurer.probeWidth(glyph, run, col, width);
					} else {
						measurer.deferWidth(glyph);
					}
					unknownInRow++;
				}
			}

			cursorCol += width;
			prevIndex = index;
			coveredUntil = width > 1 ? col + width : -1;
		}

		if (rowHasContent) {
			prevIndex = -1;
			if (rowHasANSI) {
				output += writer.resetStyle().take();
			}
		}
	}

	// Never a trailing newline. The frame is repainted in place, and one
	// line feed per render would scroll the launching prompt up a row each
	// time.
	return output;
}

interface FrameJournal {
	readonly dirty: boolean;
	readonly frameScroll: number;
	readonly needsRepaint: boolean;
}

const kRows = Symbol("rows");
const kCols = Symbol("cols");
const kWriter = Symbol("writer");
const kPrev = Symbol("prev");
const kPrevContentHeight = Symbol("prevContentHeight");
const kPark = Symbol("park");
const kSpare = Symbol("spare");
const kNeedsScreenReset = Symbol("needsScreenReset");
const kResetAtRow = Symbol("resetAtRow");
const kHasSavedCursor = Symbol("hasSavedCursor");
const kNeedsFullClear = Symbol("needsFullClear");
const kRenderedLines = Symbol("renderedLines");
const kEndFrame = Symbol("endFrame");
const kFlushProbes = Symbol("flushProbes");
const kMeasurer = Symbol("measurer");
const kDiff = Symbol("diff");
const kLastCaretVisible = Symbol("lastCaretVisible");
const kScrollTop = Symbol("scrollTop");
const kFrameScroll = Symbol("frameScroll");
const kDirty = Symbol("dirty");
const kDocumentTop = Symbol("documentTop");
const kAnchorScrollTop = Symbol("anchorScrollTop");

export class Screen {
	declare [kPrev]: CellGrid | null;
	// The dropped grid, reused by the next frame of the same size.
	declare [kSpare]: CellGrid | null;
	declare [kDiff]: CellGrid | null;
	declare [kEndFrame]: (() => string) | null;
	declare [kRenderedLines]: Set<number>;
	declare [kPrevContentHeight]: number;
	// Where the last frame parked the cursor, in buffer coordinates. The
	// resize re-anchor derives the frame's new top row from the cursor's
	// post-rewrap position minus the wrapped rows above this park point.
	declare [kPark]: {row: number; col: number};
	declare [kLastCaretVisible]: boolean;
	declare [kHasSavedCursor]: boolean;
	declare [kNeedsFullClear]: boolean;
	declare [kNeedsScreenReset]: boolean;
	// Probes are waiting. The next flush re-emits the first contentful row
	// as their cover even if nothing changed.
	declare [kFlushProbes]: boolean;
	// Null for a headless render.
	declare [kMeasurer]: Exchange | null;
	declare [kResetAtRow]: number;
	declare [kRows]: number;
	declare [kCols]: number;
	// The fullscreen anchor: the alternate screen's row-zero scroll origin.
	declare [kScrollTop]: number;
	declare [kDocumentTop]: number;
	declare [kAnchorScrollTop]: number;
	declare [kWriter]: FrameWriter;
	declare [kFrameScroll]: number;
	declare [kDirty]: boolean;

	constructor(
		rows: number,
		cols: number,
		colorDepth: ColorDepth = "rgb",
	) {
		this[kFlushProbes] = false;
		this[kMeasurer] = null;
		this[kPrev] = null;
		this[kSpare] = null;
		this[kDiff] = null;
		this[kEndFrame] = null;
		this[kRenderedLines] = new Set();
		this[kPrevContentHeight] = 0;
		this[kPark] = {row: 0, col: 0};
		this[kLastCaretVisible] = false;
		this[kHasSavedCursor] = false;
		this[kNeedsFullClear] = false;
		this[kNeedsScreenReset] = false;
		this[kResetAtRow] = 0;
		this[kRows] = rows;
		this[kCols] = cols;
		this[kScrollTop] = 0;
		this[kDocumentTop] = 0;
		this[kAnchorScrollTop] = 0;
		this[kFrameScroll] = 0;
		this[kDirty] = true;
		this[kWriter] = new FrameWriter(colorDepth);
	}

	/** Width probes go out over the exchange, once there is one. */
	set measurer(exchange: Exchange) {
		this[kMeasurer] = exchange;
	}

	get rows(): number {
		return this[kRows];
	}

	get cols(): number {
		return this[kCols];
	}

	get scrollTop(): number {
		return this[kScrollTop];
	}

	/** Whether the last frame parked the real cursor on a caret. */
	get caretVisible(): boolean {
		return this[kLastCaretVisible];
	}

	get journal(): FrameJournal {
		return {
			dirty: this[kDirty],
			frameScroll: this[kFrameScroll],
			needsRepaint:
				this[kNeedsScreenReset] ||
				this[kNeedsFullClear] ||
				this[kFlushProbes],
		};
	}

	get documentTop(): number {
		return this[kDocumentTop];
	}

	set documentTop(row: number) {
		this[kDocumentTop] = row;
	}

	get anchorScrollTop(): number {
		return this[kAnchorScrollTop];
	}

	set anchorScrollTop(row: number) {
		this[kAnchorScrollTop] = row;
	}

	resize(rows: number, cols: number): void {
		this[kRows] = rows;
		this[kCols] = cols;
	}

	rebind(colorDepth: ColorDepth): void {
		this[kWriter] = new FrameWriter(colorDepth);
	}

	scrollTo(row: number): void {
		const next = Math.max(0, row);
		this[kFrameScroll] += next - this[kScrollTop];
		this[kScrollTop] = next;
	}

	invalidate(): void {
		this[kDirty] = true;
	}

	wrappedRowsAbovePark(cols: number): number | null {
		// The resize re-anchor asks the terminal where the cursor is after the
		// rewrap and subtracts this to find the frame's new top row.
		const grid = this[kPrev];
		if (grid === null || this[kPrevContentHeight] === 0 || cols <= 0) {
			return null;
		}
		const limit = Math.min(
			this[kPark].row,
			this[kPrevContentHeight],
			grid.rows,
		);
		let wrapped = 0;
		for (let row = 0; row < limit; row++) {
			wrapped += Math.max(1, Math.ceil(getLineLength(grid, row) / cols));
		}
		return wrapped + Math.floor(this[kPark].col / cols);
	}

	replaced(fromRow = 0): void {
		this[kNeedsScreenReset] = true;
		this[kResetAtRow] = Math.max(0, fromRow);
		this[kHasSavedCursor] = false;
		this.repaintAll();
	}

	scrolled(rows: number): void {
		if (this[kNeedsScreenReset] && rows > 0) {
			this[kResetAtRow] = Math.max(0, this[kResetAtRow] - rows);
		}
	}

	flushProbes(): void {
		this[kFlushProbes] = true;
	}

	repaintAll(): void {
		// After a resize DECRC no longer points where the content began, so
		// the next frame homes, clears the visible screen (ED2, not ED3, which
		// leaves the scrollback alone) and reprints.
		this[kSpare] = this[kPrev];
		this[kPrev] = null;
		this[kPrevContentHeight] = 0;
		this[kNeedsFullClear] = true;
		this[kRenderedLines].clear();
	}

	beginStatic({
		rows: contentRows,
		lineEnding = "\n",
	}: {
		rows: number;
		lineEnding?: "\n" | "\r\n";
	}): CellContext {
		const rows = Math.max(0, contentRows);
		if (rows === 0) {
			const empty = new CellGrid(0, this[kCols]);
			this[kEndFrame] = () => "";
			return new CellContext(empty, 0, this[kCols], 0);
		}

		const cols = this[kCols];
		const grid = new CellGrid(rows, cols);
		const context = new CellContext(grid, rows, cols, 0);
		this[kEndFrame] = (): string => {
			const lines: string[] = [];
			for (let row = 0; row < rows; row++) {
				lines.push(getGridLine(grid, row, this[kWriter]));
			}

			// A file wants a bare newline. A terminal wants CRLF. A lone LF
			// moves the cursor down without returning it to column 0, so the
			// lines would staircase across the screen.
			return lines.join(lineEnding) + lineEnding;
		};
		return context;
	}

	beginFrame({
		offset,
		cursorRow: cursorPosition,
		regionRows,
		delta = 0,
		shift,
	}: {

		/** Rows the document scroll has scrolled, negative downward. */
		offset: number;

		cursorRow?: number;

		/**
		 * Rows past the terminal's height are printed with newlines, which is
		 * what scrolls them into the scrollback where they stay readable (CSI n
		 * S discards them). Only the last `rows` of them are kept as the previous
		 * frame. They alone can still be redrawn.
		 */
		regionRows?: number;

		/** Rows the scroll moved since the last frame, positive downward. */
		delta?: number;

		/**
		 * The buffer rows `delta` moved, `[top, end)`. A scrolling element's
		 * port names its own rows here. The document scroll names none and takes the
		 * whole region, which is the rows a document scroll spans.
		 */
		shift?: {top: number; end: number};
	}): CellContext {
		const frameRows = Math.max(this[kRows], regionRows ?? this[kRows]);
		const overflowing = frameRows > this[kRows];
		const cols = this[kCols];
		const next = takeGrid(this, frameRows, cols);

		// A scroll is a rigid transform the terminal performs. DECSTBM pins the
		// margins to the shifted rows (a shell prompt above stays outside
		// them), and DL/IL move rows without touching the scrollback, unlike
		// SU. The previous buffer shifts to match, so the diff emits only what
		// the shift could not carry.
		let scrollPrefix = "";
		const regionTop = cursorPosition ?? 0;
		const regionEnd = Math.min(regionRows ?? this[kRows], this[kRows]);
		const viewportTop = Math.max(0, shift ? shift.top : 0);
		const bandEnd = Math.min(
			this[kPrev]?.rows ?? 0,
			shift ? shift.end : regionEnd - regionTop,
		);
		const scrolling =
			delta !== 0 &&
			Math.abs(delta) < this[kRows] &&
			bandEnd > viewportTop &&
			this[kPrev] !== null &&
			// A rigid transform only makes sense between grids of one width.
			this[kPrev].cols === cols &&
			!overflowing &&
			!this[kNeedsScreenReset] &&
			!this[kNeedsFullClear] &&
			cursorPosition !== undefined;
		if (scrolling && this[kPrev]) {
			const prev = this[kPrev];
			const start = viewportTop * cols;
			const stop = bandEnd * cols;
			const shift = Math.abs(delta) * cols;
			if (shift >= stop - start) {
				prev.clearRange(start, stop);
			} else if (delta > 0) {
				prev.moveRange(start, start + shift, stop);
				prev.clearRange(stop - shift, stop);
			} else {
				prev.moveRange(start + shift, start, stop - shift);
				prev.clearRange(start, start + shift);
			}
			const shiftedLines = new Set<number>();
			for (const row of this[kRenderedLines]) {
				if (row < viewportTop || row >= bandEnd) {
					shiftedLines.add(row);
					continue;
				}
				const moved = row - delta;
				if (moved >= viewportTop && moved < bandEnd) {
					shiftedLines.add(moved);
				}
			}
			this[kRenderedLines] = shiftedLines;

			// DECSTBM homes the cursor. The standard prefix always CUPs for
			// this caller afterward.
			const count = Math.abs(delta);
			const bandRow = regionTop + viewportTop + 1;
			const writer = this[kWriter];
			writer.setScrollRegion(bandRow, regionTop + bandEnd).cursorTo(bandRow, 1);
			if (delta > 0) {
				writer.deleteLines(count);
			} else {
				writer.insertLines(count);
			}
			scrollPrefix = writer.resetScrollRegion().take();
		}

		const context = new CellContext(next, frameRows, cols, offset);
		this[kEndFrame] = (): string => {
			const measurer =
				this[kMeasurer] !== null && isProbingUseful(this[kMeasurer])
					? this[kMeasurer]
					: undefined;
			// The frame is complete. Join the borders whose strokes touch, so
			// the diff below sees a junction appear even when only its
			// neighbour changed.
			joinTouchingBorders(next);

			// Build the diff. A frame taller than the terminal is a growth
			// frame. The rows below the fold have never been on screen, so
			// there is nothing to diff against. Print all of it.
			let diff = this[kDiff];
			if (diff === null || diff.rows !== frameRows || diff.cols !== cols) {
				diff = new CellGrid(frameRows, cols);
				this[kDiff] = diff;
			} else {
				diff.clear();
			}

			const prev = this[kPrev];
			if (prev === null || overflowing) {
				diff.copyFrom(next, {to: 0, start: 0, end: frameRows * cols});
			} else {
				const prevRows = prev.rows;
				const prevCols = prev.cols;
				const aligned = prevCols === cols;

				for (let row = 0; row < this[kRows]; row++) {
					const nextRow = row * cols;
					const prevRow = row * prevCols;
					const rowInPrev = row < prevRows;

					let col = 0;
					if (aligned && rowInPrev) {
						while (col < cols) {
							const n = nextRow + col;
							const p = prevRow + col;
							if (
								next.cluster[n] !== prev.cluster[p] ||
								next.fg[n] !== prev.fg[p] ||
								next.bg[n] !== prev.bg[p] ||
								(next.attrs[n] & ATTR.StyleMask) !==
								(prev.attrs[p] & ATTR.StyleMask) ||
								next.border[n] !== prev.border[p]
							) {
								break;
							}
							col++;
						}
						if (col === cols) {
							continue;
						}
					}

					for (; col < cols; col++) {
						const n = nextRow + col;
						const nextChar = next.cluster[n];

						if (!rowInPrev || col >= prevCols) {
							if (nextChar !== 0) {
								diff.setFrom(n, next, n);
							}
							continue;
						}

						const p = prevRow + col;
						const prevChar = prev.cluster[p];

						if (prevChar === 0) {
							if (nextChar !== 0) {
								diff.setFrom(n, next, n);
							}
						} else if (nextChar === 0) {
							// A cell the frame no longer paints has to be
							// erased, not merely skipped. The terminal still
							// shows the old glyph there.
							diff.setBlank(n);
						} else if (!next.equalCells(n, prev, p)) {
							diff.setFrom(n, next, n);
						}
					}
				}
			}

			// A reset frame redraws onto rows whose terminal content is
			// unknown, because the previous buffer was dropped. Every region
			// row must clear ITSELF. A row the new frame leaves blank gets a
			// seeded space so generateANSI emits its \r\e[K line like any
			// content row. Per-row erases instead of one ED from the home
			// position matter in tmux, which preserves a fully-erased screen by
			// pushing it into scrollback (the courtesy it extends to `clear`).
			// The ED archived a copy of the old frame into the scrollback on
			// every resize.
			const resetFrame = this[kNeedsScreenReset] || this[kNeedsFullClear];
			if (resetFrame) {
				// Buffer rows are region-relative (the anchor row is where the
				// frame CUPs to). regionRows is a screen-absolute end. Seed
				// exactly the region's rows. Seeding further would count blank
				// screen rows as content and skew the park the resize re-anchor
				// measures from.
				const anchorRow = this[kNeedsScreenReset]
					? this[kResetAtRow]
					: (cursorPosition ?? 0);
				const regionHeight = (regionRows ?? this[kRows]) - anchorRow;
				const seedRows = Math.min(frameRows, this[kRows], regionHeight);
				for (let row = 0; row < seedRows; row++) {
					const rowStart = row * cols;
					let empty = true;
					for (let col = 0; col < cols; col++) {
						if (diff.cluster[rowStart + col] !== 0) {
							empty = false;
							break;
						}
					}
					if (empty) {
						diff.setBlank(rowStart);
					}
				}
			}

			let hasContent = false;

			const diffCells = frameRows * cols;
			for (let index = 0; index < diffCells; index++) {
				if (diff.cluster[index] !== 0) {
					hasContent = true;
					break;
				}
			}

			// Waiting probes go only under cells this same write paints over.
			// A frame that diffs to nothing offers none, so the first
			// contentful row re-emits verbatim: identical cells, no erase, and
			// the probes go under them.
			if (this[kFlushProbes]) {
				this[kFlushProbes] = false;
				if (measurer !== undefined && !hasContent) {
					for (let row = 0; row < frameRows && !hasContent; row++) {
						const rowStart = row * cols;
						for (let col = 0; col < cols; col++) {
							const index = rowStart + col;
							if (next.cluster[index] !== 0) {
								diff.setFrom(index, next, index);
								hasContent = true;
							}
						}
					}
				}
			}

			// A caret appearing, moving, or disappearing must emit a frame even
			// when no cell changed. A blurred input leaves no visual diff, but
			// the real cursor is sitting visible at the stale caret until a
			// frame re-parks it.
			const caret = context.caret;
			const caretBufferRow = caret === null ? null : caret.row + offset;
			const caretVisible =
				caret !== null &&
				caretBufferRow !== null &&
				caretBufferRow >= 0 &&
				caretBufferRow < this[kRows] &&
				caret.col >= 0 &&
				caret.col < this[kCols];
			const caretStateChanged =
				caretVisible !== this[kLastCaretVisible] ||
				(caretVisible &&
					(this[kPark].row !== caretBufferRow ||
						this[kPark].col !== caret.col));
			if (caretStateChanged) {
				hasContent = true;
			}
			this[kLastCaretVisible] = caretVisible;

			if (scrolling) {
				hasContent = true;
			}

			const writer = this[kWriter];
			let prefix = scrollPrefix;
			let frameStartRow: number | undefined;
			if (hasContent) {
				if (this[kNeedsScreenReset]) {
					// After a resize the terminal rewrapped our frame and moved
					// the cursor where DECRC cannot find it. The row our
					// content starts at still holds, since what is above us
					// does not reflow-grow. No home and no ED. That would wipe
					// what is above us, and tmux archives a full-screen erase
					// into the scrollback.
					prefix +=
						writer.cursorTo(this[kResetAtRow] + 1, 1).saveCursor().take();
					this[kHasSavedCursor] = true;
					this[kNeedsScreenReset] = false;
					this[kNeedsFullClear] = false;
					frameStartRow = this[kResetAtRow];
				} else if (cursorPosition !== undefined) {
					prefix += writer.cursorTo(cursorPosition + 1, 1).saveCursor().take();
					this[kHasSavedCursor] = true;
					frameStartRow = cursorPosition;
				} else if (offset > 0) {
					prefix += writer.cursorTo(offset + 1, 1).take();
					frameStartRow = offset;
				} else if (this[kHasSavedCursor]) {
					prefix += writer.restoreCursor().saveCursor().take();
				} else {
					prefix += writer.saveCursor().take();
					this[kHasSavedCursor] = true;
				}

				if (this[kNeedsFullClear]) {
					prefix += writer.eraseBelow().take();
					this[kNeedsFullClear] = false;
				}
			}

			const output = generateANSI(diff, writer, this[kRenderedLines], measurer);

			let contentHeight = 0;
			for (const row of this[kRenderedLines]) {
				if (row + 1 > contentHeight) {
					contentHeight = row + 1;
				}
			}

			// Rows the last frame painted below where this one ends still show
			// what it left on them.
			let staleOutput = "";
			if (this[kHasSavedCursor] && this[kPrevContentHeight] > contentHeight) {
				writer.restoreCursor();
				if (contentHeight > 0) {
					writer.cursorDown(contentHeight);
				}
				staleOutput = writer
					.carriageReturn()
					.eraseBelow()
					.take();
			} else if (
				resetFrame &&
				frameStartRow !== undefined &&
				frameStartRow + contentHeight < this[kRows]
			) {
				// After a reset nothing below the content is trusted either,
				// because the old frame may have been taller. Erase from the
				// first row past the content. This is a PARTIAL erase, which no
				// terminal treats as a screen clear worth archiving.
				staleOutput = writer
					.cursorTo(frameStartRow + contentHeight + 1, 1)
					.eraseBelow()
					.take();
			}

			// The two grids trade places. Of an overflowing frame only the rows
			// still on screen are kept. The rest scrolled into the scrollback.
			const retired = this[kPrev];
			if (overflowing) {
				this[kPrev] = next.bottomRows(this[kRows]);
				this[kSpare] = next;
			} else {
				this[kPrev] = next;
				this[kSpare] = retired;
			}
			this[kPrevContentHeight] = contentHeight;

			// A diff leaves the cursor at the last changed cell, and a resize
			// scrolls just enough to keep the cursor on screen, so the park is
			// what wrappedRowsAbovePark re-anchors from. A caret parks the real
			// cursor there, shown, because IME composition anchors at the real
			// cursor.
			let parkOutput = "";
			if (hasContent && contentHeight > 0) {
				if (caretVisible) {
					this[kPark] = {row: caretBufferRow, col: caret.col};
					if (frameStartRow !== undefined) {
						parkOutput = writer
							.cursorTo(frameStartRow + caretBufferRow + 1, caret.col + 1)
							.take();
					} else if (this[kHasSavedCursor]) {
						writer.restoreCursor().saveCursor();
						if (caretBufferRow > 0) {
							writer.cursorDown(caretBufferRow);
						}
						writer.carriageReturn();
						if (caret.col > 0) {
							writer.cursorForward(caret.col);
						}
						parkOutput = writer.take();
					}
				} else {
					this[kPark] = {
						row: Math.min(contentHeight, this[kRows]) - 1,
						col: 0,
					};
					if (frameStartRow !== undefined) {
						// 0-based start + height = 1-based last row. The bottom
						// margin caps it when the content overflows the screen.
						const lastRow = Math.min(
							frameStartRow + contentHeight,
							this[kRows],
						);
						parkOutput = writer.cursorTo(lastRow, 1).take();
					} else if (this[kHasSavedCursor]) {
						// No absolute row to name. Restore the saved content
						// start, re-save it, and step down. CUD stops at the
						// bottom margin, which is the content's visible bottom
						// when it overflows.
						writer.restoreCursor().saveCursor();
						if (contentHeight > 1) {
							writer.cursorDown(contentHeight - 1);
						}
						parkOutput = writer.carriageReturn().take();
					}
				}
			}

			const frame = prefix + output + staleOutput + parkOutput;
			return hasContent ? wrapSynchronized(frame) : frame;
		};
		return context;
	}

	endFrame(): string {
		const end = this[kEndFrame];
		if (end === null) {
			throw new Error("endFrame without a begun frame");
		}
		this[kEndFrame] = null;
		const ansi = end();
		this[kFrameScroll] = 0;
		this[kDirty] = false;
		return ansi;
	}
}

function takeGrid(screen: Screen, rows: number, cols: number): CellGrid {
	const spare = screen[kSpare];
	if (spare !== null && spare.rows === rows && spare.cols === cols) {
		screen[kSpare] = null;
		spare.clear();
		return spare;
	}
	return new CellGrid(rows, cols);
}

function isProbingUseful(exchange: Exchange): boolean {
	return exchange.probing() && !exchange.clusterWidthsNegotiated();
}
