/**
 * The screen: the cell grid the paint walk writes into, and the frame diff
 * that turns two of them into the bytes a terminal needs to catch up.
 *
 * A cell holds a grapheme cluster and its style, packed. A frame is the whole
 * grid; committing one compares it against the grid the terminal is already
 * holding and emits only what differs -- cursor moves, style runs, scroll
 * shifts for a band that moved -- spelled through the frame writer at the top
 * of this file, which owns every escape sequence the bytes are made of.
 *
 * Start at beginFrame: it checks out a grid, hands back the CellContext every
 * draw call goes through, and arms the endFrame that diffs and emits. The
 * sections above it are what a frame is made of, in the order it uses them --
 * the writer, the cell encoding, the box-drawing glyphs, the grid, the draw
 * calls, and the emission.
 */
import type {ColorDepth, TerminalExchange} from "./exchange.js";
import {
	graphemeSegmenter,
	PRINTABLE_ASCII,
	stringWidth,
	widthIsUncertain,
} from "./text.js";

export type {ColorDepth};

/* -------------------------------------------------------- the frame writer */

/**
 * The characters no frame may put on the wire: C0, DEL, and the C1 range
 * whose single bytes are CSI, OSC and DCS. One of these in a document's own
 * text would end the sequence around it or start one of its own, so both
 * doors text takes into a frame -- a cell, and the writer below -- turn them
 * away.
 */
function isControlByte(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/** Quantize 24-bit RGB onto the 256-color cube and grayscale ramp. */
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

/** Round 24-bit RGB to the nearest of the basic eight. */
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

/**
 * The SGR parameters naming a 24-bit color at the depth the terminal speaks:
 * stated outright, quantized to the 256-color cube, or rounded to one of the
 * eight the oldest terminals have. Parameters, not a whole SGR -- a run of
 * them shares one escape.
 */
function colorParameters(
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

/** The attributes an SGR run states by name, apart from the underline. */
type StyleAttribute =
	"bold" |
	"dim" |
	"italic" |
	"blink" |
	"inverse" |
	"strikethrough" |
	"overline";

/** Wanted states by name; an absent name is left as the terminal has it. */
type StyleAttributes = {[K in StyleAttribute]?: boolean};

/** No underline, one line, or the styled double line of SGR 4:2. */
type UnderlineStyle = "none" | "single" | "double";

/**
 * What a run of SGR parameters says. A color is a 24-bit value, `null` for
 * the terminal's own default, absent to leave standing. The underline is a
 * move from one style to another, because which codes spell the move depends
 * on where it starts.
 */
interface StyleRun {
	fg?: number | null;
	bg?: number | null;
	attributes?: StyleAttributes;
	underline?: {from: UnderlineStyle; to: UnderlineStyle};
}

/**
 * The codes taking the underline from one style to another. A plain 4 comes
 * before 4:2 so a terminal that ignores the styled underline still draws a
 * line, and a plain 4 on its own downgrades a double to a single (ECMA-48,
 * and what tmux tracks).
 */
function underlineCodes(from: UnderlineStyle, to: UnderlineStyle): string[] {
	if (from === to) {
		return [];
	}
	if (to === "none") {
		return ["24"];
	}
	if (to === "double") {
		return from === "none" ? ["4", "4:2"] : ["4:2"];
	}
	return ["4"];
}

const kOut = Symbol("out");
const kColorDepth = Symbol("colorDepth");

/**
 * A frame's bytes, spelled rather than concatenated.
 *
 * Every method returns the writer, so a row is said aloud --
 * `writer.cursorTo(row, 1).style(run).text(glyphs).eraseToLineEnd()` -- and
 * take() hands back everything spelled since the last one. Where a caller
 * wants a single spelling as a string, `writer.carriageReturn().take()` is
 * the idiom.
 *
 * text() is the one door a document's own characters come through, and it
 * drops the bytes a terminal would read as commands. Nothing else here
 * carries anything but numbers this file chose.
 */
class FrameWriter {
	/** Everything spelled since the last take(), in order. */
	declare [kOut]: string[];

	/** What the terminal can display; style() spells colors at this depth. */
	declare [kColorDepth]: ColorDepth;

	constructor(colorDepth: ColorDepth) {
		this[kOut] = [];
		this[kColorDepth] = colorDepth;
	}

	/** Everything spelled since the last take, and the buffer is empty again. */
	take(): string {
		const out = this[kOut].join("");
		this[kOut].length = 0;
		return out;
	}

	/* ---------------------------------------------------------- the cursor */

	/** CR: back to the first column, the row unchanged. */
	carriageReturn(): this {
		this[kOut].push("\r");
		return this;
	}

	/**
	 * CR LF, `rows` times: down that many rows and back to the first column.
	 * A lone line feed moves the cursor down without returning it, so the
	 * rows would staircase away across the screen.
	 */
	newLine(rows = 1): this {
		this[kOut].push("\r\n".repeat(rows));
		return this;
	}

	/** CUP: the cursor to a one-based row and column. */
	cursorTo(row: number, col: number): this {
		this[kOut].push(`\x1b[${row};${col}H`);
		return this;
	}

	/** CUF: the cursor forward by columns. */
	cursorForward(columns: number): this {
		this[kOut].push(`\x1b[${columns}C`);
		return this;
	}

	/** CUD: the cursor down by rows, stopping at the bottom margin. */
	cursorDown(rows: number): this {
		this[kOut].push(`\x1b[${rows}B`);
		return this;
	}

	/** DECSC: remember where the cursor is. */
	saveCursor(): this {
		this[kOut].push("\x1b7");
		return this;
	}

	/** DECRC: the cursor back to where DECSC left it. */
	restoreCursor(): this {
		this[kOut].push("\x1b8");
		return this;
	}

	/* ---------------------------------------------------------- the eraser */

	/** EL 0: from the cursor to the end of its row. */
	eraseToLineEnd(): this {
		this[kOut].push("\x1b[K");
		return this;
	}

	/** ED 0: from the cursor to the end of the screen. */
	eraseBelow(): this {
		this[kOut].push("\x1b[J");
		return this;
	}

	/* --------------------------------------------------- the scroll region */

	/** DECSTBM: the scrolling region, one-based rows. Homes the cursor. */
	setScrollRegion(top: number, bottom: number): this {
		this[kOut].push(`\x1b[${top};${bottom}r`);
		return this;
	}

	/** DECSTBM with no parameters: the region is the whole screen again. */
	resetScrollRegion(): this {
		this[kOut].push("\x1b[r");
		return this;
	}

	/** DL: delete rows at the cursor, pulling the region up. */
	deleteLines(count: number): this {
		this[kOut].push(`\x1b[${count}M`);
		return this;
	}

	/** IL: insert blank rows at the cursor, pushing the region down. */
	insertLines(count: number): this {
		this[kOut].push(`\x1b[${count}L`);
		return this;
	}

	/* ----------------------------------------------------------- the style */

	/** SGR 0: back to the terminal's own defaults. */
	resetStyle(): this {
		this[kOut].push("\x1b[0m");
		return this;
	}

	/**
	 * SGR: the escape a run of style spells, at the writer's own color depth.
	 * A run that says nothing writes nothing -- no escape is ever emitted
	 * empty, since an empty SGR is the terminal's reset.
	 */
	style(run: StyleRun): this {
		const escape = styleEscape(run, this[kColorDepth]);
		if (escape !== "") {
			this[kOut].push(escape);
		}
		return this;
	}

	/* ----------------------------------------------------------- the modes */

	/** DECSET/DECRST: engage or release a private mode by number. */
	privateMode(code: number, on: boolean): this {
		this[kOut].push(`\x1b[?${code}${on ? "h" : "l"}`);
		return this;
	}

	/* --------------------------------------------------------- the payload */

	/**
	 * Glyphs, as themselves. The bytes the writer refuses are dropped: text
	 * is a document's, so a control character in it would end whatever
	 * sequence surrounds it and leave the rest of the string to the terminal
	 * as its own commands.
	 */
	text(glyphs: string): this {
		let safe = "";
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

/**
 * The SGR spelling a run, parameters in the order a terminal wants to hear
 * them: colors, then attributes. "" when the run says nothing -- no escape
 * is ever emitted empty, since an empty SGR is the terminal's reset.
 */
function styleEscape(run: StyleRun, colorDepth: ColorDepth): string {
	const codes: string[] = [];
	if (run.fg !== undefined) {
		codes.push(
			run.fg === null ? "39" : colorParameters(run.fg, true, colorDepth),
		);
	}
	if (run.bg !== undefined) {
		codes.push(
			run.bg === null ? "49" : colorParameters(run.bg, false, colorDepth),
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
		codes.push(...underlineCodes(run.underline.from, run.underline.to));
	}
	state("blink", "5", "25");
	state("inverse", "7", "27");
	state("strikethrough", "9", "29");
	state("overline", "53", "55");

	return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

/* ------------------------------------------------------------------- cells */

export interface CellStyle {
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
}

/**
 * What `measureText` answers: the columns the text occupies, which is the
 * one metric a cell grid has -- nothing in a cell has a baseline. The name
 * and the field are canvas's own original TextMetrics; further fields join
 * if a consumer ever appears, the way canvas itself grew.
 */
interface TextMetrics {
	width: number;
}

const Color = {
	Mask: 0xffffff,
} as const;

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
const AttrFlags = {
	Bold: 1 << 0,
	Italic: 1 << 1,
	Underline: 1 << 2,
	// Styled underline (SGR 4:2, the kitty extension most modern terminals
	// adopted). Only meaningful alongside Underline: emission sends plain 4
	// first so a DIRECTLY connected terminal that ignores 4:2 keeps a single
	// underline. That ordering cannot survive a re-encoding intermediary:
	// tmux collapses the pair into one styled-underline attribute at parse
	// time and forwards it to a client without the usstyle feature in a form
	// Apple Terminal drops entirely. Author-land CSS for terminals known to
	// support it -- the UA defaults deliberately never use it.
	DoubleUnderline: 1 << 3,
	Strikethrough: 1 << 4,
	Overline: 1 << 5,
	Inverse: 1 << 6,
	Blink: 1 << 7,
	Dim: 1 << 8,
} as const;

const kFGGroup =
	AttrFlags.Bold |
	AttrFlags.Italic |
	AttrFlags.Underline |
	AttrFlags.DoubleUnderline |
	AttrFlags.Strikethrough |
	AttrFlags.Overline;
const kBGGroup = AttrFlags.Inverse | AttrFlags.Blink | AttrFlags.Dim;

const Attr = {
	...AttrFlags,
	FGGroup: kFGGroup,
	BGGroup: kBGGroup,
	StyleMask: kFGGroup | kBGGroup,
	WidthShift: 9,
	WidthMask: 0x1f << 9,
	WidthWide: 0x1f,
} as const;

/* --------------------------------------------------------------- graphemes */

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

/** The grapheme cluster a char-plane value names. */
function decodeGrapheme(char: number): string {
	return char >= CHAR_INTERNED
		? internedGraphemes[char - CHAR_INTERNED]
		: String.fromCodePoint(char);
}

/* ----------------------------------------------------------------- borders */

const BorderEdgeStyle = {
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
	// Set on the edges that meet in a corner cell whose radius rounds it, and
	// on nothing else: the runs between corners are the same line either way.
	Rounded: 0b00010000,
} as const;

const BorderMask = {
	Top: 0x000000ff,
	Right: 0x0000ff00,
	Bottom: 0x00ff0000,
	Left: 0xff000000,
	Edge: 0xff,
	Style: 0b00001111,
} as const;

const BorderShift = {
	Top: 0,
	Right: 8,
	Bottom: 16,
	Left: 24,
} as const;

const BORDER_EDGE_MASKS = [
	BorderMask.Top,
	BorderMask.Right,
	BorderMask.Bottom,
	BorderMask.Left,
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
	return edgeValue & BorderMask.Style;
}

function getEdgePresence(edgeValue: number): boolean {
	const style = edgeValue & BorderMask.Style;
	return style !== BorderEdgeStyle.None && style !== BorderEdgeStyle.Hidden;
}

function getEdgeRounded(edgeValue: number): boolean {
	return (edgeValue & BorderEdgeStyle.Rounded) !== 0;
}

/** Merge two border encodings, taking the stronger style on each edge. */
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

/**
 * How a border line is drawn: the CSS keyword, in the CSS's own word, and
 * the line's color -- the terminal's default foreground when absent.
 *
 * An end's cap says how its stroke finishes. By default it stops at the end
 * cell's center, which is what lets another line's half-stroke union with it
 * into a corner or a tee; "square" projects through the cell, for a free end
 * nothing meets; "round" curves the glyph where two capped ends union -- a
 * box's four line ends are its four corners.
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
	solid: BorderEdgeStyle.Solid,
	double: BorderEdgeStyle.Double,
	dashed: BorderEdgeStyle.Dashed,
	dotted: BorderEdgeStyle.Dotted,
	groove: BorderEdgeStyle.Groove,
	ridge: BorderEdgeStyle.Ridge,
	inset: BorderEdgeStyle.Inset,
	outset: BorderEdgeStyle.Outset,
	hidden: BorderEdgeStyle.Hidden,
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

/**
 * The rounded form of a corner glyph.
 *
 * Unicode draws rounded corners for the light single stroke alone, so this is
 * the whole of what a terminal can bend: the light-cornered character sets --
 * solid, dashed, dotted, ridge, inset, outset -- round, and double and heavy
 * corners stay square because no glyph exists that bends those strokes. That
 * is the deliberate adaptation: a radius on a double border is honored as far
 * as the terminal's characters allow, which is not at all.
 */
const ROUNDED_CORNERS: Readonly<Record<string, string>> = {
	"┌": "╭",
	"┐": "╮",
	"└": "╰",
	"┘": "╯",
};

/** The box-drawing character a cell's border encoding spells. */
function getBorderChar(borderEncoding: number): string {
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
	// The radius rides the edges meeting in this cell, so a cell is a rounded
	// corner exactly when the edges that made it one carry the flag.
	const hasRounded =
		(hasTop && getEdgeRounded(topEdge)) ||
		(hasRight && getEdgeRounded(rightEdge)) ||
		(hasBottom && getEdgeRounded(bottomEdge)) ||
		(hasLeft && getEdgeRounded(leftEdge));

	// Solid is the light stroke, and so are ridge, inset and outset: a terminal
	// draws one weight of line, so the three shaded keywords land on the glyphs
	// their unshaded relative uses.
	let charSet = BOX_DRAWING.light;
	switch (dominantStyle) {
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
	}

	// The bits say which way a line leaves this cell, so the glyph follows
	// directly from how many ways it goes and which.
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

	// A corner takes its rounded form where one exists. The character set is
	// still the border style's -- a rounded dashed box keeps its dashes and
	// bends only the four cells where the strokes turn -- and a style whose
	// corner has no rounded glyph stays square; see ROUNDED_CORNERS.
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

/* ---------------------------------------------------------------- the grid */

/**
 * The terminal grid, as parallel typed-array planes indexed by `row * cols +
 * col`.
 *
 * Every per-cell datum has a plane: the grapheme (a code point, or an index
 * into the intern table), the foreground and background colors, the style and
 * width bits, and the border encoding. A color of 0 is the terminal's own
 * default rather than black -- the sentinel the style diff spells as 39/49.
 *
 * A cell is empty when its char plane is 0. The column to the right of a
 * two-column glyph is empty in exactly that sense: the glyph's own width field
 * is what tells the emitter to step over it.
 *
 * Planes are allocated once per size and reused. The renderer swaps whole
 * grids between frames rather than copying them.
 */
class CellGrid {
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
		if (end <= start) {
			return;
		}
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

	/** Copy `source`'s cells in `[start, end)` to this grid at `to`. */
	copyFrom(
		source: CellGrid,
		{to, start, end}: {to: number; start: number; end: number},
	): void {
		this.char.set(source.char.subarray(start, end), to);
		this.fg.set(source.fg.subarray(start, end), to);
		this.bg.set(source.bg.subarray(start, end), to);
		this.attrs.set(source.attrs.subarray(start, end), to);
		this.border.set(source.border.subarray(start, end), to);
	}

	/** The bottom `rows` rows, as a grid of their own. */
	bottomRows(rows: number): CellGrid {
		const kept = new CellGrid(rows, this.cols);
		kept.copyFrom(this, {
			to: 0,
			start: (this.rows - rows) * this.cols,
			end: this.rows * this.cols,
		});
		return kept;
	}

	/**
	 * Write one cell.
	 *
	 * `background` overrides the style's own, for the caller that has already
	 * resolved what an absent background inherits.
	 */
	setCell(
		index: number,
		grapheme: string,
		{style, background}: {style?: CellStyle; background?: number} = {},
	): void {
		const width = graphemeColumns(grapheme);
		this.char[index] = encodeGrapheme(grapheme);
		this.fg[index] = (style?.fg ?? 0) & Color.Mask;
		this.bg[index] =
			background !== undefined ? background : (style?.bg ?? 0) & Color.Mask;
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
		// A border strokes; it does not fill. The cell keeps the background
		// the fills beneath it painted, unless the caller names one.
		const bg = style?.bg != null ? style.bg & Color.Mask : this.bg[index];
		this.char[index] = 0x20;
		this.fg[index] = (style?.fg ?? 0) & Color.Mask;
		this.bg[index] = bg;
		this.attrs[index] =
			(packAttrs(style) & ~Attr.DoubleUnderline) | (1 << Attr.WidthShift);
		this.border[index] = border;
	}

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

/** The style bits of a CellStyle, packed. Width is added by the caller. */
function packAttrs(style: CellStyle | undefined): number {
	if (!style) {
		return 0;
	}
	let attrs = 0;
	if (style.bold) {
		attrs |= Attr.Bold;
	}
	if (style.italic) {
		attrs |= Attr.Italic;
	}
	if (style.underline) {
		attrs |= Attr.Underline;
		if (style.underlineStyle === "double") {
			attrs |= Attr.DoubleUnderline;
		}
	}
	if (style.strikethrough) {
		attrs |= Attr.Strikethrough;
	}
	if (style.overline) {
		attrs |= Attr.Overline;
	}
	if (style.inverse) {
		attrs |= Attr.Inverse;
	}
	if (style.blink) {
		attrs |= Attr.Blink;
	}
	if (style.dim) {
		attrs |= Attr.Dim;
	}
	return attrs;
}

/** The char-plane value for a grapheme cluster. */
function encodeGrapheme(grapheme: string): number {
	const code = grapheme.codePointAt(0)!;
	if (grapheme.length === (code > 0xffff ? 2 : 1)) {
		return code;
	}
	return CHAR_INTERNED | internGrapheme(grapheme);
}

/**
 * Column count of a grapheme. Printable ASCII is answered from the code unit
 * itself -- the overwhelmingly common case, and one whose answer is always 1
 * -- so a cell write never pays for the tests stringWidth opens with.
 */
function graphemeColumns(grapheme: string): number {
	const code = grapheme.charCodeAt(0);
	if (grapheme.length === 1 && code >= 0x20 && code <= 0x7e) {
		return 1;
	}
	return stringWidth(grapheme);
}

/* ---------------------------------------------------------------- painting */

/**
 * The surface a begun frame hands the paint walk: fills, text, decorations
 * and lines, in the document's own rows and columns. `viewportOffset` is what
 * carries those onto the terminal, and every write goes through the one gate
 * below it, which drops whatever lands off the screen or outside the clip.
 */
export class CellContext {
	grid: CellGrid;
	rows: number;
	cols: number;
	viewportOffset: number;
	// Where the focused text element wants the real terminal cursor, in the
	// same coordinates every draw call uses. When set, the frame parks the
	// cursor there and shows it -- IME composition anchors at the real cursor,
	// so a fake inverse-cell caret is not enough for text entry.
	caret: {col: number; row: number} | null;
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

		// "default" clears the cells to the terminal's own background --
		// CSS's Canvas system color -- which still OVERWRITES whatever was
		// painted underneath: an opaque box in the theme's color, whatever
		// that theme is. "inverse" fills with SGR inverse instead: the
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

	/** Measure `text` the way `drawText` will lay it down. */
	measureText(text: string): TextMetrics {
		if (PRINTABLE_ASCII.test(text)) {
			return {width: text.length};
		}
		let width = 0;
		for (const segment of graphemeSegmenter.segment(text)) {
			width += stringWidth(segment.segment);
		}
		return {width};
	}

	drawText(text: string, x: number, y: number, style?: CellStyle): void {
		let currentX = x;

		// Printable ASCII needs no grapheme segmentation: every char is its
		// own one-cell grapheme.
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

			// Never write a control char to a cell: a cell is a column, and a
			// control byte must be turned away before it takes one, or it
			// survives to the output as a raw escape byte (injection from
			// untrusted text).
			if (isControlByte(char.codePointAt(0)!)) {
				continue;
			}

			const width = stringWidth(char);

			if (currentX + width > this.cols) {
				break;
			}

			setCell(this, y, currentX, char, style);
			currentX += width;
		}
	}

	/**
	 * Merge an underline/overline across a row, preserving existing glyphs (an
	 * empty cell becomes a spaced edge). Used to render `outline` as a full-width
	 * edge; drawText can't, since it overwrites. The style's fg is the row's
	 * DEFAULT color: a cell that already carries an explicit foreground
	 * (::selection, ::placeholder, authored color) keeps it.
	 */
	drawDecoration(x: number, y: number, width: number, style: CellStyle): void {
		const grid = this.grid;
		const edgeBit =
			(style.underline ? Attr.Underline : 0) |
			(style.overline ? Attr.Overline : 0);
		if (edgeBit === 0) {
			return;
		}
		for (let col = x; col < x + width; col++) {
			const index = guardedWriteIndex(this, y, col);
			if (index < 0) {
				continue;
			}
			if (grid.char[index] !== 0) {
				let attrs = grid.attrs[index] | edgeBit;
				if (style.dim !== undefined) {
					attrs = style.dim ? attrs | Attr.Dim : attrs & ~Attr.Dim;
				}
				grid.attrs[index] = attrs;
			} else {
				grid.char[index] = 0x20;
				grid.fg[index] = (style.fg ?? 0) & Color.Mask;
				grid.bg[index] = 0;
				grid.attrs[index] =
					edgeBit | (style.dim ? Attr.Dim : 0) | (1 << Attr.WidthShift);
			}
			// The edge replaces a box-drawing glyph with the space that cell
			// measures as: an outline is a line of its own, not a junction.
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
		// Axis-aligned, half-open: the stroke runs from the start cell toward
		// the end coordinate and stops short of it, so a one-cell vertical is
		// (x, y, x, y + 1) and equal points stroke nothing -- which is also
		// what disambiguates the axis of a one-cell line.
		if ((x1 !== x2 && y1 !== y2) || (x1 === x2 && y1 === y2)) {
			return;
		}
		const bits = LINE_BITS[line.style];
		if (bits === 0) {
			return;
		}
		const style: CellStyle | undefined =
			line.color != null ? {fg: line.color} : undefined;
		const rounded = BorderEdgeStyle.Rounded;

		// Each cell records which way the stroke LEAVES it, and an end cell
		// keeps only its inward half -- the stroke enters and stops at
		// center. Two lines meeting in a cell then union into the corner,
		// the tee or the cross without either knowing the other exists. A
		// "square" cap projects through its cell instead, for a free end; a
		// "round" cap rides the half-stroke, which is how a corner cell
		// learns it curves.
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
					(toRight << BorderShift.Right) | (toLeft << BorderShift.Left),
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
					(down << BorderShift.Bottom) | (up << BorderShift.Top),
					style,
				);
			}
		}
	}

	/**
	 * Four lines and their caps: the box composition drawLine callers would
	 * otherwise write. An end that meets an adjacent side stops at center
	 * (and curves when the corner rounds); a free end projects through its
	 * cell.
	 */
	drawBox(
		x: number,
		y: number,
		width: number,
		height: number,
		// The sides, and "round" on each corner whose radius rounds it.
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

		// Verticals first: a corner cell's glyph spans two sides but holds one
		// color, and the horizontal side's wins -- the closest a cell gets to
		// the browser's diagonal miter.
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
		// A 1-row box's bottom shares the top's row; the top already drew it.
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

/**
 * The grid index a write at document (row, col) may land on, or -1 when it
 * must be dropped: off the terminal, or outside the active clip. The one
 * gate for cell writers; each calls it once at entry, so no writer can apply
 * one of these checks without the other.
 */
function guardedWriteIndex(
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
	const index = guardedWriteIndex(context, row, col);
	if (index < 0) {
		return;
	}

	const grid = context.grid;

	// A style that names no background of its own takes the one already in
	// the cell: text painted over a filled box sits ON the fill rather than
	// punching a default-colored hole through it.
	let bgColor: number | undefined;
	if (style && style.bg == null && grid.char[index] !== 0) {
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
	// A box whose extent touches an exposed band still stamps its whole
	// outline; the gate drops the strokes on carried-over rows -- a top
	// border row wearing a legend, say -- which keep what the seeded grid
	// holds.
	const index = guardedWriteIndex(context, y, x);
	if (index < 0) {
		return;
	}

	const grid = context.grid;

	// Two boxes sharing a cell union their edges, so a shared wall lands on
	// a tee or a cross rather than the later box's corner.
	const existing = grid.border[index];
	grid.setBorderCell(
		index,
		grid.char[index] !== 0 && existing > 0
			? meetEdges(existing, borderEncoding)
			: borderEncoding,
		style,
	);
}

/* ---------------------------------------------------------------- emission */

/**
 * Spell the SGR that takes the terminal from the cell at `prev` to the cell at
 * `index`, or nothing at all when nothing needs to change. A `prev` of -1
 * means no cell precedes this one, so every attribute the cell carries is
 * stated.
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
	writer: FrameWriter,
): void {
	const fg = grid.fg[index];
	const bg = grid.bg[index];
	const attrs = grid.attrs[index] & Attr.StyleMask;

	if (prev < 0) {
		writer.style({
			fg: fg === 0 ? undefined : fg,
			bg: bg === 0 ? undefined : bg,
			attributes: attrsChanged(attrs, 0),
			underline: {from: "none", to: getUnderline(attrs)},
		});
		return;
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

	const fgChanged =
		fg !== prevFg || (attrs & Attr.FGGroup) !== (prevAttrs & Attr.FGGroup);
	const bgChanged =
		bg !== prevBg || (attrs & Attr.BGGroup) !== (prevAttrs & Attr.BGGroup);

	const run: StyleRun = {};
	if (fgChanged) {
		run.fg = fg === 0 ? null : fg;
	}
	if (bgChanged) {
		run.bg = bg === 0 ? null : bg;
	}
	if (fgChanged || bgChanged) {
		run.attributes = attrsChanged(attrs, prevAttrs);
		run.underline = {from: getUnderline(prevAttrs), to: getUnderline(attrs)};
	}

	writer.style(run);
}

/** The underline the bits ask for. DoubleUnderline needs Underline with it. */
function getUnderline(attrs: number): UnderlineStyle {
	if (!(attrs & Attr.Underline)) {
		return "none";
	}
	return attrs & Attr.DoubleUnderline ? "double" : "single";
}

/** The attributes whose bit differs, named and in their wanted state. */
function attrsChanged(attrs: number, prevAttrs: number): StyleAttributes {
	const changed: StyleAttributes = {};
	const flag = (bit: number, name: StyleAttribute) => {
		if ((attrs & bit) !== (prevAttrs & bit)) {
			changed[name] = (attrs & bit) !== 0;
		}
	};

	flag(Attr.Bold, "bold");
	flag(Attr.Dim, "dim");
	flag(Attr.Italic, "italic");
	flag(Attr.Blink, "blink");
	flag(Attr.Inverse, "inverse");
	flag(Attr.Strikethrough, "strikethrough");
	flag(Attr.Overline, "overline");
	return changed;
}

/**
 * The bytes that carry the cursor from one cell to another. Emission runs
 * row-major and never goes back, so a move is CRLFs down to the row and a
 * step rightward within it.
 */
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

/**
 * The columns a cluster's residue can reach: the widest advance a probe's
 * reply is believed to describe, so the widest one a probe can leave behind.
 */
const PROBE_RESIDUE_COLUMNS = 4;

/**
 * Where a frame can paint a probe without being seen and without the margin in
 * the way: a column in the frame's FIRST painted row whose next four columns
 * the row's own content covers, far enough from the last column that the reply
 * is unambiguous.
 *
 * The first painted row is the only candidate. Emission runs top to bottom and
 * never moves the cursor back up, so a probe train on any later row could not
 * be overwritten by the content that follows it.
 */
function safeProbeCell(grid: CellGrid): {row: number; col: number} | null {
	const {rows, cols, char, border} = grid;
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
			if (char[index] === 0) {
				spanStart = -1;
				col++;
				continue;
			}
			rowHasContent = true;
			if (spanStart < 0) {
				spanStart = col;
			}
			// A wide glyph covers its continuation column too, which the grid
			// leaves empty: the span runs on across it.
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

/* -------------------------------------------------------------- the screen */

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
const kRideProbeTrain = Symbol("rideProbeTrain");
const kMeasurer = Symbol("measurer");
const kDiff = Symbol("diff");
const kLastCaretVisible = Symbol("lastCaretVisible");
const kScrollTop = Symbol("scrollTop");
const kFrameScroll = Symbol("frameScroll");
const kDirty = Symbol("dirty");
const kLayoutMoved = Symbol("layoutMoved");
const kDocumentTop = Symbol("documentTop");
const kAnchorScrollTop = Symbol("anchorScrollTop");

export class Screen {
	declare [kPrev]: CellGrid | null;
	// Retired grids kept for the next frame that wants their size: the frame
	// buffer and the previous frame trade places rather than reallocating, and
	// the diff is filled and cleared in place.
	declare [kSpare]: CellGrid | null;
	declare [kDiff]: CellGrid | null;
	// The emitter of the frame begun and not yet ended; begin* arms it and
	// endFrame fires it once.
	declare [kEndFrame]: (() => string) | null;
	declare [kRenderedLines]: Set<number>;
	declare [kPrevContentHeight]: number;
	// Where the last frame parked the cursor, in buffer coordinates. The resize
	// re-anchor derives the frame's new top row from the cursor's post-rewrap
	// position minus the wrapped rows above this park point.
	declare [kPark]: {row: number; col: number};
	declare [kLastCaretVisible]: boolean;
	declare [kHasSavedCursor]: boolean;
	declare [kNeedsFullClear]: boolean;
	declare [kNeedsScreenReset]: boolean;
	// A probe train is waiting for a frame to ride: the next flush re-emits
	// the first contentful row as its cover, though the document has not moved.
	declare [kRideProbeTrain]: boolean;
	// The width-probe channel, or null when the screen has none (headless
	// renders never have one).
	declare [kMeasurer]: TerminalExchange | null;
	declare [kResetAtRow]: number;
	declare [kRows]: number;
	declare [kCols]: number;
	// The camera over the document, and where the document sits on the
	// terminal: how far down the document the view has moved, the screen row
	// the document's first row is anchored to, and the fullscreen anchor --
	// the alternate screen's row-zero scroll origin.
	declare [kScrollTop]: number;
	declare [kDocumentTop]: number;
	declare [kAnchorScrollTop]: number;
	// The writer every frame is spelled with, at the depth this terminal
	// speaks. One per screen, and nothing reads back through it: a screen
	// has no input side.
	declare [kWriter]: FrameWriter;
	declare [kFrameScroll]: number;
	declare [kDirty]: boolean;
	declare [kLayoutMoved]: boolean;

	/**
	 * A screen measures widths through the channel it is built with, for as
	 * long as it lives. Whether a given frame probes is decided as the frame
	 * is emitted (probingTeaches reads the channel's facts as they stand),
	 * so probing ending or mode 2027 settling later changes nothing here.
	 */
	constructor(
		rows: number,
		cols: number,
		colorDepth: ColorDepth = "rgb",
		measurer: TerminalExchange | null = null,
	) {
		this[kRideProbeTrain] = false;
		this[kMeasurer] = measurer;
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
		this[kLayoutMoved] = false;
		this[kWriter] = new FrameWriter(colorDepth);
	}

	get rows(): number {
		return this[kRows];
	}

	get cols(): number {
		return this[kCols];
	}

	/** How far down the document the camera has moved, in cells. */
	get scrollTop(): number {
		return this[kScrollTop];
	}

	/** Camera rows moved since the last painted frame. */
	get frameScroll(): number {
		return this[kFrameScroll];
	}

	get dirty(): boolean {
		return this[kDirty];
	}

	get layoutMoved(): boolean {
		return this[kLayoutMoved];
	}

	/** The screen row the document's first row is anchored to. */
	get documentTop(): number {
		return this[kDocumentTop];
	}

	set documentTop(row: number) {
		this[kDocumentTop] = row;
	}

	/** The fullscreen anchor: the alternate screen's row-zero scroll origin. */
	get anchorScrollTop(): number {
		return this[kAnchorScrollTop];
	}

	set anchorScrollTop(row: number) {
		this[kAnchorScrollTop] = row;
	}

	/** A reset or clear is pending: the next frame must actually paint. */
	get needsRepaint(): boolean {
		return (
			this[kNeedsScreenReset] ||
			this[kNeedsFullClear] ||
			this[kRideProbeTrain]
		);
	}

	resize(rows: number, cols: number): void {
		this[kRows] = rows;
		this[kCols] = cols;
	}

	/** Adopt a rebound transport's color depth: the writer is its one holder. */
	rebind(colorDepth: ColorDepth): void {
		this[kWriter] = new FrameWriter(colorDepth);
	}

	/**
	 * Move the camera to a document row, clamped at the top.
	 *
	 * The one writer: the frame journal's scroll delta is the sum of what
	 * comes through here since the last painted frame, so the camera and
	 * the rows the terminal is about to be shifted by can never disagree.
	 */
	scrollTo(row: number): void {
		const next = Math.max(0, row);
		this[kFrameScroll] += next - this[kScrollTop];
		this[kScrollTop] = next;
	}

	/**
	 * Mark the frame stale by hand: for state no mutation record names --
	 * a focus move, a selection, a popover shown -- the paint is asked for
	 * here.
	 */
	invalidate(): void {
		this[kDirty] = true;
	}

	/**
	 * The layout engine moved geometry since the last frame: the rows that
	 * frame painted no longer describe the document, so no band of them may
	 * be shifted in place of a repaint.
	 */
	invalidateLayout(): void {
		this[kLayoutMoved] = true;
	}

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
	wrappedRowsAbovePark(cols: number): number | null {
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
			wrapped += Math.max(1, Math.ceil(lineLength(grid, row) / cols));
		}
		return wrapped + Math.floor(this[kPark].col / cols);
	}

	/**
	 * The terminal's screen is no longer the one this last painted, from
	 * `fromRow` down: the alternate screen swapped in, a resize moved the
	 * frame, a width correction landed. What that costs -- which rows must be
	 * erased, what can still be diffed -- is this class's business; the
	 * caller only reports the fact.
	 */
	replaced(fromRow = 0): void {
		this[kNeedsScreenReset] = true;
		this[kResetAtRow] = Math.max(0, fromRow);
		this[kHasSavedCursor] = false;
		this.repaintAll();
	}

	/**
	 * The screen scrolled under this by `rows` -- output pushed into the
	 * scrollback to make room -- so a pending erase, which names a screen row,
	 * rides along with everything else on screen.
	 */
	scrolled(rows: number): void {
		if (this[kNeedsScreenReset] && rows > 0) {
			this[kResetAtRow] = Math.max(0, this[kResetAtRow] - rows);
		}
	}

	/**
	 * Carry a probe train on the next frame even if the document has stopped
	 * changing and its frames diff to nothing. A train rides only under
	 * cells the same write paints over, so the flush re-emits the first
	 * contentful row verbatim -- identical cells, no erase -- as the cover.
	 */
	rideProbeTrain(): void {
		this[kRideProbeTrain] = true;
	}

	/**
	 * Repaint the whole visible screen from the top on the next frame: what
	 * the terminal shows is no longer what this last painted. A resize is
	 * the loudest case -- it rewraps everything on screen and moves the
	 * cursor unpredictably, so the saved position DECRC would restore no
	 * longer points where our content began. Rather than erase relative to
	 * a position we cannot trust, the next frame homes the cursor, clears
	 * the visible screen (ED2, not ED3 -- the scrollback is left alone) and
	 * reprints. The old content the terminal reflowed into scrollback stays
	 * there, as any command's output would.
	 */
	repaintAll(): void {
		this[kSpare] = this[kPrev];
		this[kPrev] = null;
		this[kPrevContentHeight] = 0;
		this[kNeedsFullClear] = true;
		this[kRenderedLines].clear();
	}

	/**
	 * Render the whole document as plain lines, for a stdout that is not a
	 * terminal.
	 *
	 * A pipe or a file has no viewport, no cursor, no scrollback and no resize --
	 * so it has no fold, and none of the problems that come with one. There is
	 * nothing to commit, nothing to freeze and nothing to repair.
	 *
	 * It also has no way to interpret cursor movement. Emitting the interactive
	 * frame here would write CUP, EL, DECSC and synchronised-output sequences
	 * into the file. So this emits styled text and newlines, and nothing else:
	 * gaps are spaces rather than cursor-forward, and rows end with a newline
	 * rather than an erase-line. There is no diff and no previous screen; one
	 * grid is rendered whole, and `end` returns the lines.
	 */
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
				lines.push(gridLine(grid, row, this[kWriter]));
			}

			// A file wants a bare newline. A terminal wants CRLF: a lone LF moves the
			// cursor down without returning it to column 0, so the lines would staircase
			// away across the screen.
			return lines.join(lineEnding) + lineEnding;
		};
		return context;
	}

	/**
	 * Begin a frame against the screen: the grid is checked out and seeded for
	 * whatever camera move the options describe, and `end` diffs it against
	 * the last frame and returns the escape sequences that close the gap.
	 *
	 * `regionRows` lets the caller render a region taller than the terminal.
	 * That is how content reaches the scrollback: the frame is emitted top to
	 * bottom with newlines, and printing past the bottom margin is what makes
	 * the terminal scroll -- and what puts the rows that scroll past into its
	 * scrollback, where they remain readable. (`CSI n S` scrolls too, but
	 * discards them.) Rows that scroll off can never be addressed again, so
	 * only the last `terminalHeight` of them are kept as the previous frame:
	 * they are the only part still ours to redraw.
	 */
	beginFrame({
		offset,
		cursorRow: cursorPosition,
		regionRows,
		delta = 0,
		band,
	}: {

		/** Rows the camera has scrolled, negative downward. */
		offset: number;

		/** Where the cursor parks when the frame ends. */
		cursorRow?: number;

		/** Rows the frame spans, when it is taller than the screen. */
		regionRows?: number;

		/** Rows the scroll moved since the last frame, positive downward. */
		delta?: number;

		/**
		 * The buffer rows `delta` moved, `[top, end)`. A scrolling element's
		 * port names its own rows here; the camera names none and takes the
		 * whole region, which is the band a camera move happens to span.
		 */
		band?: {top: number; end: number};
	}): CellContext {
		const frameRows = Math.max(this[kRows], regionRows ?? this[kRows]);
		const overflowing = frameRows > this[kRows];
		const cols = this[kCols];
		const next = takeGrid(this, frameRows, cols);

		// A scroll is a rigid transform the terminal performs itself: DECSTBM
		// pins the margins to the band that moved (a shell prompt above is
		// outside them, and so is chrome an element's scroll port does not
		// cover), and DL/IL within margins move rows without touching the
		// scrollback, unlike SU. The previous buffer shifts to match, so the
		// diff below prices this frame against where the rows now sit and
		// emits only what the shift could not carry -- content overlapping
		// the band the terminal dragged along included. A pending reset, a
		// growth frame, or no previous frame falls through to the plain diff,
		// which repaints the region instead of shifting it.
		let scrollPrefix = "";
		const regionTop = cursorPosition ?? 0;
		const regionEnd = Math.min(regionRows ?? this[kRows], this[kRows]);
		const bandTop = Math.max(0, band ? band.top : 0);
		const bandEnd = Math.min(
			this[kPrev]?.rows ?? 0,
			band ? band.end : regionEnd - regionTop,
		);
		const scrolling =
			delta !== 0 &&
			Math.abs(delta) < this[kRows] &&
			bandEnd > bandTop &&
			this[kPrev] !== null &&
			// A rigid transform only makes sense between grids of one width.
			this[kPrev].cols === cols &&
			!overflowing &&
			!this[kNeedsScreenReset] &&
			!this[kNeedsFullClear] &&
			cursorPosition !== undefined;
		if (scrolling && this[kPrev]) {
			// Shift the model in place: band row r now shows what was at
			// r + delta, and the rows scrolled in from beyond the band's
			// edge are blank until the paint fills them.
			const prev = this[kPrev];
			const start = bandTop * cols;
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
				if (row < bandTop || row >= bandEnd) {
					shiftedLines.add(row);
					continue;
				}
				const moved = row - delta;
				if (moved >= bandTop && moved < bandEnd) {
					shiftedLines.add(moved);
				}
			}
			this[kRenderedLines] = shiftedLines;

			// DECSTBM homes the cursor; the standard prefix always CUPs for
			// this caller afterward.
			const count = Math.abs(delta);
			const bandRow = regionTop + bandTop + 1;
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
			// Whether this frame probes is the width authority's call, taken
			// as the frame is emitted so the session's facts are current.
			const measurer =
				this[kMeasurer] !== null && probingTeaches(this[kMeasurer])
					? this[kMeasurer]
					: undefined;
			// The frame is complete: join the borders whose strokes touch,
			// so the diff below sees a junction appear even when only its
			// neighbour changed.
			joinTouchingBorders(next);

			// Build the diff. A frame taller than the terminal is a growth frame:
			// the rows below the fold have never been on screen, so there is nothing
			// to diff against -- print all of it.
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
						if (col === cols) {
							continue;
						}
					}

					for (; col < cols; col++) {
						const n = nextRow + col;
						const nextChar = next.char[n];

						if (!rowInPrev || col >= prevCols) {
							if (nextChar !== 0) {
								diff.setFrom(n, next, n);
							}
							continue;
						}

						const p = prevRow + col;
						const prevChar = prev.char[p];

						if (prevChar === 0) {
							if (nextChar !== 0) {
								diff.setFrom(n, next, n);
							}
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
			const resetFrame = this[kNeedsScreenReset] || this[kNeedsFullClear];
			if (resetFrame) {
				// Buffer rows are region-relative (the anchor row is where the frame
				// CUPs to); regionRows is a screen-absolute end. Seed exactly the
				// region's rows -- seeding further would count blank screen rows as
				// content and skew the park the resize re-anchor measures from.
				const anchorRow = this[kNeedsScreenReset]
					? this[kResetAtRow]
					: (cursorPosition ?? 0);
				const regionHeight = (regionRows ?? this[kRows]) - anchorRow;
				const seedRows = Math.min(frameRows, this[kRows], regionHeight);
				for (let row = 0; row < seedRows; row++) {
					const rowStart = row * cols;
					let empty = true;
					for (let col = 0; col < cols; col++) {
						if (diff.char[rowStart + col] !== 0) {
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
				if (diff.char[index] !== 0) {
					hasContent = true;
					break;
				}
			}

			// A waiting probe train rides only under cells this same write
			// paints over. A frame that diffs to nothing offers none, so the
			// first contentful row re-emits verbatim: identical cells, no
			// erase, and the train goes under them.
			if (this[kRideProbeTrain]) {
				this[kRideProbeTrain] = false;
				if (measurer !== undefined && !hasContent) {
					for (let row = 0; row < frameRows && !hasContent; row++) {
						const rowStart = row * cols;
						for (let col = 0; col < cols; col++) {
							const index = rowStart + col;
							if (next.char[index] !== 0) {
								diff.setFrom(index, next, index);
								hasContent = true;
							}
						}
					}
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
			let suffix = "";
			// The frame's on-screen start row, when a positioning branch names one
			// absolutely. Used to park the cursor at the content bottom after painting.
			let frameStartRow: number | undefined;
			if (hasContent) {
				// DECTCEM off, hiding the cursor; then synchronized output, start.
				prefix += writer.privateMode(25, false).privateMode(2026, true).take();

				if (this[kNeedsScreenReset]) {
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
					prefix +=
						writer.cursorTo(this[kResetAtRow] + 1, 1).saveCursor().take();
					this[kHasSavedCursor] = true;
					this[kNeedsScreenReset] = false;
					this[kNeedsFullClear] = false;
					frameStartRow = this[kResetAtRow];
				} else if (cursorPosition !== undefined) {
					// The frame names its own start row, and saves it: the stale-row
					// erase and the park below both step down from there.
					prefix += writer.cursorTo(cursorPosition + 1, 1).saveCursor().take();
					this[kHasSavedCursor] = true;
					frameStartRow = cursorPosition;
				} else if (offset > 0) {
					prefix += writer.cursorTo(offset + 1, 1).take();
					frameStartRow = offset;
				} else if (this[kHasSavedCursor]) {
					prefix += writer.restoreCursor().saveCursor().take();
				} else {
					// The first render starts wherever the cursor already is.
					prefix += writer.saveCursor().take();
					this[kHasSavedCursor] = true;
				}

				// After resize, clear everything from content start down.
				// Terminal reflow makes it impossible to know where old content ended up,
				// so we erase the entire area before redrawing.
				if (this[kNeedsFullClear]) {
					prefix += writer.eraseBelow().take();
					this[kNeedsFullClear] = false;
				}

				// The cursor stays hidden between frames: it is parked at the content's
				// bottom-left for resize bookkeeping, and a blinking cursor squatting
				// there is not UI. Focused inputs paint their own caret as an inverse
				// cell. dispose() shows the real cursor again on the way out.
				suffix = writer.privateMode(2026, false).take(); // synchronized, end
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
				// Back to content start, past what the frame does paint, and
				// erase from there down.
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
				// After a reset nothing below the content is trusted either -- the
				// old frame may have been taller. Erase from the first row past the
				// content: a PARTIAL erase, which no terminal treats as a screen
				// clear worth archiving.
				staleOutput = writer
					.cursorTo(frameStartRow + contentHeight + 1, 1)
					.eraseBelow()
					.take();
			}

			// The frame buffer becomes the previous frame and the retired one goes
			// back to be the next frame's, so a steady-size renderer allocates two
			// grids for its whole life. Of an overflowing frame only the rows still
			// on screen are kept: the ones above have scrolled into the scrollback
			// and are no longer ours to redraw.
			const retired = this[kPrev];
			if (overflowing) {
				this[kPrev] = next.bottomRows(this[kRows]);
				this[kSpare] = next;
			} else {
				this[kPrev] = next;
				this[kSpare] = retired;
			}
			this[kPrevContentHeight] = contentHeight;

			// Park the cursor before the frame ends. A diff leaves the cursor wherever
			// the last changed cell happened to be -- an arbitrary row -- and the
			// terminal preserves the cursor across a resize, scrolling exactly enough
			// to keep it on screen, so an arbitrary resting place makes that scroll
			// arbitrary too. The resize re-anchor recovers the frame's position from
			// wherever the park went (see wrappedRowsAbovePark).
			//
			// Two parks:
			// - A focused text element set a caret: park THERE and show the cursor.
			//   IME composition anchors at the real terminal cursor, so the caret has
			//   to be the real cursor, not just an inverse-video cell.
			// - Otherwise: the content's last row, column 0, hidden -- where an
			//   ordinary program's cursor rests after printing.
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
					// The caret is the real cursor, so it is shown.
					parkOutput += writer.privateMode(25, true).take();
				} else {
					this[kPark] = {
						row: Math.min(contentHeight, this[kRows]) - 1,
						col: 0,
					};
					if (frameStartRow !== undefined) {
						// 0-based start + height = 1-based last row; the bottom margin caps
						// it when the content overflows the screen.
						const lastRow = Math.min(
							frameStartRow + contentHeight,
							this[kRows],
						);
						parkOutput = writer.cursorTo(lastRow, 1).take();
					} else if (this[kHasSavedCursor]) {
						// No absolute row to name: restore the saved content start, re-save
						// it, and step down. CUD stops at the bottom margin, which is the
						// content's visible bottom when it overflows.
						writer.restoreCursor().saveCursor();
						if (contentHeight > 1) {
							writer.cursorDown(contentHeight - 1);
						}
						parkOutput = writer.carriageReturn().take();
					}
				}
			}

			return prefix + output + staleOutput + parkOutput + suffix;
		};
		return context;
	}

	/**
	 * Finish the frame begun by beginFrame or beginStatic: diff, emit, and
	 * return the output. One end per begin.
	 */
	endFrame(): string {
		const end = this[kEndFrame];
		if (end === null) {
			throw new Error("endFrame without a begun frame");
		}
		this[kEndFrame] = null;
		const ansi = end();
		this[kFrameScroll] = 0;
		this[kDirty] = false;
		this[kLayoutMoved] = false;
		return ansi;
	}
}

/**
 * Join the borders in `grid` whose strokes touch.
 *
 * A stroke is drawn to the edge of its cell, so a border cell beside another
 * whose line runs at it would, in a browser's pixels, be touched by that
 * line: the cell gains the connecting stub and `├ ┬ ┼` form where one-pixel
 * borders meet. Every decision reads the grid as painted, so a stub never
 * begets another; parallel strokes point along the shared edge rather than
 * across it, so boxes that merely sit flush stay separate.
 */
function joinTouchingBorders(grid: CellGrid): void {
	const {rows, cols, border} = grid;
	const painted = border.slice();
	// Which neighbour to look at for each edge of a cell, and which of that
	// neighbour's edges would run into this one.
	const REACHES: Array<{mask: number; step: number; from: number}> = [
		{mask: BorderMask.Top, step: -cols, from: BorderMask.Bottom},
		{mask: BorderMask.Bottom, step: cols, from: BorderMask.Top},
		{mask: BorderMask.Left, step: -1, from: BorderMask.Right},
		{mask: BorderMask.Right, step: 1, from: BorderMask.Left},
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
				if (mask === BorderMask.Top && row === 0) {
					continue;
				}
				if (mask === BorderMask.Bottom && row === rows - 1) {
					continue;
				}
				if (mask === BorderMask.Left && col === 0) {
					continue;
				}
				if (mask === BorderMask.Right && col === cols - 1) {
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

/** A cleared grid of the given size, reusing the retired one when it matches. */
function takeGrid(screen: Screen, rows: number, cols: number): CellGrid {
	const spare = screen[kSpare];
	if (spare !== null && spare.rows === rows && spare.cols === cols) {
		screen[kSpare] = null;
		spare.clear();
		return spare;
	}
	return new CellGrid(rows, cols);
}

/**
 * One row of a grid as a styled string: the cells up to the last one holding
 * anything, with a wide glyph counted once and an unwritten cell spelled as
 * a space. This is how the static frame reads a grid, having no cursor to
 * move and no previous frame to diff against.
 */
function gridLine(grid: CellGrid, row: number, writer: FrameWriter): string {
	const rowStart = row * grid.cols;
	// A file should not be padded out to the terminal width, so stop at the
	// last cell that actually holds something.
	let lastCol = -1;
	for (let col = grid.cols - 1; col >= 0; col--) {
		if (grid.char[rowStart + col] !== 0) {
			lastCol = col;
			break;
		}
	}

	let previous = -1;
	for (let col = 0; col <= lastCol; col++) {
		const index = rowStart + col;
		if (grid.char[index] === 0) {
			writer.text(" ");
			continue;
		}

		styleDiff(grid, index, previous, writer);

		const encoding = grid.border[index];
		writer.text(
			encoding > 0
				? getBorderChar(encoding)
				: decodeGrapheme(grid.char[index]),
		);
		previous = index;

		// A wide grapheme's continuation column is empty in the buffer but
		// already covered by the glyph -- skip it, or the line grows a
		// phantom space per wide character and shifts what follows.
		if (encoding === 0) {
			col += grid.widthAt(index) - 1;
		}
	}

	if (previous !== -1) {
		writer.resetStyle();
	}
	return writer.take();
}

/** The columns a row occupies, out to the right edge of its last glyph. */
function lineLength(grid: CellGrid, row: number): number {
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
 * Emit the grid as ANSI, row by row.
 *
 * Empty cells are skipped rather than painted, so the cursor jumps them with
 * CUF and whatever the terminal already shows there survives. `renderedLines`
 * names the rows that have been printed before; a row's first appearance opens
 * with an erase so nothing of the terminal's own is left on it.
 *
 * The bytes never end in a newline. A frame is repainted in place, and one
 * more line feed per render would scroll the terminal, pushing the command
 * line that launched us into the scrollback a row at a time.
 */
function generateANSI(
	grid: CellGrid,
	writer: FrameWriter,
	renderedLines: Set<number>,
	measurer?: TerminalExchange,
): string {
	const {rows, cols, char, border} = grid;

	let output = "";
	let cursorRow = 0;
	let cursorCol = 0;
	// Flat index of the last cell emitted, whose style the next cell diffs
	// against. -1 while no cell precedes.
	let prevIndex = -1;

	let skipNextCol = -1;

	// Measurement bookkeeping: which emission run the cursor is in (every move
	// ends one), and how many clusters of unknown advance this row has already
	// painted -- each one can carry the real cursor a column either side of the
	// predicted one.
	let run = 0;
	let unknownInRow = 0;

	// Clusters the margin has starved are asked about off to the side, before
	// the frame paints anything: the probe train goes to a cell the first
	// painted row covers, and that row's own content lands on top of it in this
	// same write, so nothing of it is ever on screen.
	if (measurer !== undefined) {
		const starving = measurer.starvedWidths();
		if (starving.size > 0) {
			const cell = safeProbeCell(grid);
			if (cell !== null) {
				output += moveCursor(writer, 0, 0, cell.row, 0);
				cursorRow = cell.row;
				cursorCol = 0;
				// probe() takes the cluster out of the set being iterated.
				for (const cluster of [...starving]) {
					writer.carriageReturn();
					if (cell.col > 0) {
						writer.cursorForward(cell.col);
					}
					// Each probe is reached by naming its column outright, so
					// no train glyph's advance carries into the next.
					run++;
					output +=
						writer.text(cluster).take() +
						measurer.probeWidth(cluster, run, cell.col, stringWidth(cluster));
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
			if (char[rowStart + col] !== 0) {
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

			if (char[index] === 0) {
				continue;
			}

			if (skipNextCol >= 0 && row === cursorRow && col === skipNextCol) {
				skipNextCol = -1;
				continue;
			}

			skipNextCol = -1;

			if (row !== cursorRow || col !== cursorCol) {
				const moveSeq = moveCursor(writer, cursorRow, cursorCol, row, col);
				output += moveSeq;
				cursorRow = row;
				cursorCol = col;
				// A carriage return puts the cursor in a column named
				// absolutely, so whatever the glyphs before it really did stops
				// mattering and a new run begins. A bare cursor-forward does
				// not: it steps from wherever the cursor actually is, carrying
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

			styleDiff(grid, index, prevIndex, writer);
			const styleSeq = writer.take();
			if (styleSeq !== "") {
				output += styleSeq;
				rowHasANSI = true;
			}

			const encoding = border[index];
			const glyph =
				encoding > 0 ? getBorderChar(encoding) : decodeGrapheme(char[index]);
			output += writer.text(glyph).take();

			const width = grid.widthAt(index);

			// The cursor is sitting immediately after a cluster whose advance
			// has never been checked against this terminal: ask now, while the
			// column it started from is known. Only clusters terminals actually
			// disagree about are asked at all; the char-plane test in front of
			// widthIsUncertain keeps plain ASCII from reaching it, and a border
			// glyph is drawn from a character this engine chose.
			if (measurer !== undefined && encoding === 0) {
				const code = char[index];
				if (
					(code > 0x7e || code < 0x20) &&
					widthIsUncertain(glyph) &&
					measurer.wantsWidth(glyph)
				) {
					// Near the right margin the answer is unreadable: a glyph
					// that reaches the last column leaves the cursor there with
					// wrap pending rather than past it, and the reply says the
					// same column for two different advances. The room to leave
					// is the widest advance a cluster can plausibly have, plus
					// what the unmeasured clusters already on this row may have
					// pushed the real cursor past the predicted one.
					//
					// Defer -- the cluster keeps its place in line and gets
					// measured wherever it next appears with room -- or, if it
					// never has room, on a later frame's probe train.
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

			if (width === 2) {
				skipNextCol = col + 1;
			}
		}

		if (rowHasContent) {
			prevIndex = -1;
			if (rowHasANSI) {
				output += writer.resetStyle().take();
			}
		}
	}

	return output;
}

/**
 * One terminal's screen: the grid the last frame left on it, what is still
 * known to be true of that, and the writer the next frame is spelled with.
 * Frames come one at a time -- begin, draw, end -- and each ends by parking
 * the cursor where the next resize can find it again.
 */
/**
 * Whether asking the terminal can teach the width tables anything. A wire
 * that stopped answering teaches nothing, and neither does a terminal that
 * negotiated mode 2027: that mode makes it advance by grapheme cluster,
 * measuring the way the tables do, so its answers cannot disagree with them.
 */
function probingTeaches(exchange: TerminalExchange): boolean {
	return exchange.probing() && !exchange.clusterWidthsNegotiated();
}
