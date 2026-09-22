/**
 * The glyphs the math engine assembles stretched operators, radicals and
 * fraction bars from, in three sets: Unicode's Miscellaneous Technical
 * pieces, box drawing only (for fonts without those pieces), and ASCII
 * (for TERM=dumb, log files and plain-text copies).
 */

export type GlyphSet = "unicode" | "box-drawing" | "ascii";

export function parseGlyphSet(value: string): GlyphSet {
	const text = value.trim().toLowerCase();
	return text === "ascii" || text === "box-drawing" ? text : "unicode";
}

interface VerticalPieces {
	top: string;
	middle: string;
	center?: string;
	bottom: string;
}

interface HorizontalPieces {
	left: string;
	filler: string;
	right: string;
}

interface GlyphTable {
	vertical: Record<string, VerticalPieces>;
	horizontal: Record<string, HorizontalPieces>;
	fractionBar: string;
	overline: string;
	radical: RadicalPieces;
	plain: Record<string, string>;
}

/**
 * A radical sign's foot, its stem and the bar over the radicand. A null
 * bar is an underline on the row above, which the terminal draws along
 * that row's bottom edge, flush with the stem's top. The shape says how
 * the stem reaches it: "rises" when the foot glyph carries the stroke
 * to its own top corner and taller radicands add a diagonal per row;
 * "climbs" when the foot is a bare stroke and the diagonal starts on
 * its row, as SymPy draws it; "stands" when the stem is a vertical bar
 * beside the foot.
 */
export interface RadicalPieces {
	foot: string;
	stem: string;
	bar: string | null;
	shape: "rises" | "climbs" | "stands";
}

// One row of a drawn glyph. An underlined row is a bar the terminal
// draws along the row's bottom edge, flush with the strokes below it.
export interface GlyphRow {
	text: string;
	underline: boolean;
	overline?: boolean;
}

const UNICODE_VERTICAL: Record<string, VerticalPieces> = {
	"(": {top: "⎛", middle: "⎜", bottom: "⎝"},
	")": {top: "⎞", middle: "⎟", bottom: "⎠"},
	"[": {top: "⎡", middle: "⎢", bottom: "⎣"},
	"]": {top: "⎤", middle: "⎥", bottom: "⎦"},
	"{": {top: "⎧", middle: "⎪", center: "⎨", bottom: "⎩"},
	"}": {top: "⎫", middle: "⎪", center: "⎬", bottom: "⎭"},
	"|": {top: "│", middle: "│", bottom: "│"},
	"‖": {top: "║", middle: "║", bottom: "║"},
	"∣": {top: "│", middle: "│", bottom: "│"},
	"∥": {top: "║", middle: "║", bottom: "║"},
	"∫": {top: "⌠", middle: "⎮", bottom: "⌡"},
	"⌈": {top: "⌈", middle: "│", bottom: "│"},
	"⌉": {top: "⌉", middle: "│", bottom: "│"},
	"⌊": {top: "│", middle: "│", bottom: "⌊"},
	"⌋": {top: "│", middle: "│", bottom: "⌋"},
};

const BOX_DRAWING_VERTICAL: Record<string, VerticalPieces> = {
	"(": {top: "╭", middle: "│", bottom: "╰"},
	")": {top: "╮", middle: "│", bottom: "╯"},
	"[": {top: "┌", middle: "│", bottom: "└"},
	"]": {top: "┐", middle: "│", bottom: "┘"},
	"{": {top: "╭", middle: "│", center: "┤", bottom: "╰"},
	"}": {top: "╮", middle: "│", center: "├", bottom: "╯"},
	"|": {top: "│", middle: "│", bottom: "│"},
	"‖": {top: "║", middle: "║", bottom: "║"},
	"∣": {top: "│", middle: "│", bottom: "│"},
	"∥": {top: "║", middle: "║", bottom: "║"},
	"∫": {top: "╭", middle: "│", bottom: "╯"},
	"⌈": {top: "┌", middle: "│", bottom: "│"},
	"⌉": {top: "┐", middle: "│", bottom: "│"},
	"⌊": {top: "│", middle: "│", bottom: "└"},
	"⌋": {top: "│", middle: "│", bottom: "┘"},
};

const ASCII_VERTICAL: Record<string, VerticalPieces> = {
	"(": {top: "/", middle: "|", bottom: "\\"},
	")": {top: "\\", middle: "|", bottom: "/"},
	"[": {top: "+", middle: "|", bottom: "+"},
	"]": {top: "+", middle: "|", bottom: "+"},
	"{": {top: "/", middle: "|", center: "+", bottom: "\\"},
	"}": {top: "\\", middle: "|", center: "+", bottom: "/"},
	"|": {top: "|", middle: "|", bottom: "|"},
	"‖": {top: "||", middle: "||", bottom: "||"},
	"∣": {top: "|", middle: "|", bottom: "|"},
	"∥": {top: "||", middle: "||", bottom: "||"},
	"∫": {top: "/", middle: "|", bottom: "/"},
	"⌈": {top: "+", middle: "|", bottom: "|"},
	"⌉": {top: "+", middle: "|", bottom: "|"},
	"⌊": {top: "|", middle: "|", bottom: "+"},
	"⌋": {top: "|", middle: "|", bottom: "+"},
};

const UNICODE_HORIZONTAL: Record<string, HorizontalPieces> = {
	"⏞": {left: "╭", filler: "─", right: "╮"},
	"⏟": {left: "╰", filler: "─", right: "╯"},
	"→": {left: "─", filler: "─", right: "→"},
	"←": {left: "←", filler: "─", right: "─"},
	"↔": {left: "←", filler: "─", right: "→"},
	"⟶": {left: "─", filler: "─", right: "→"},
	"⟵": {left: "←", filler: "─", right: "─"},
	"⟷": {left: "←", filler: "─", right: "→"},
	"‾": {left: "─", filler: "─", right: "─"},
	"¯": {left: "─", filler: "─", right: "─"},
	_: {left: "─", filler: "─", right: "─"},
	"─": {left: "─", filler: "─", right: "─"},
	"~": {left: "~", filler: "~", right: "~"},
	"˜": {left: "~", filler: "~", right: "~"},
	"^": {left: "^", filler: "^", right: "^"},
	ˆ: {left: "^", filler: "^", right: "^"},
	"⏜": {left: "╭", filler: "─", right: "╮"},
	"⏝": {left: "╰", filler: "─", right: "╯"},
	"⎴": {left: "┌", filler: "─", right: "┐"},
	"⎵": {left: "└", filler: "─", right: "┘"},
};

const ASCII_HORIZONTAL: Record<string, HorizontalPieces> = {
	"⏞": {left: "/", filler: "-", right: "\\"},
	"⏟": {left: "\\", filler: "-", right: "/"},
	"→": {left: "-", filler: "-", right: ">"},
	"←": {left: "<", filler: "-", right: "-"},
	"↔": {left: "<", filler: "-", right: ">"},
	"⟶": {left: "-", filler: "-", right: ">"},
	"⟵": {left: "<", filler: "-", right: "-"},
	"⟷": {left: "<", filler: "-", right: ">"},
	"‾": {left: "-", filler: "-", right: "-"},
	"¯": {left: "-", filler: "-", right: "-"},
	_: {left: "-", filler: "-", right: "-"},
	"─": {left: "-", filler: "-", right: "-"},
	"~": {left: "~", filler: "~", right: "~"},
	"˜": {left: "~", filler: "~", right: "~"},
	"^": {left: "^", filler: "^", right: "^"},
	ˆ: {left: "^", filler: "^", right: "^"},
	"⏜": {left: "/", filler: "-", right: "\\"},
	"⏝": {left: "\\", filler: "-", right: "/"},
	"⎴": {left: "+", filler: "-", right: "+"},
	"⎵": {left: "+", filler: "-", right: "+"},
};

// Every character the ASCII set may emit for one it cannot draw. Anything
// not listed passes through, since the set exists for glyph shapes, not
// for the operators an author chose.
const ASCII_PLAIN: Record<string, string> = {
	"−": "-",
	"×": "x",
	"÷": "/",
	"⋅": ".",
	"·": ".",
	"∗": "*",
	"≤": "<=",
	"≥": ">=",
	"≠": "!=",
	"≈": "~=",
	"≡": "==",
	"→": "->",
	"←": "<-",
	"↔": "<->",
	"⇒": "=>",
	"⇐": "<=",
	"⇔": "<=>",
	"±": "+-",
	"∓": "-+",
	"∞": "oo",
	"√": "sqrt",
	"∑": "sum",
	"∏": "prod",
	"∫": "integral",
	"∂": "d",
	"∇": "nabla",
	"‖": "||",
	"⟨": "<",
	"⟩": ">",
	"⌈": "|",
	"⌉": "|",
	"⌊": "|",
	"⌋": "|",
	"⁡": "",
	"⁢": "",
	"⁣": "",
	"⁤": "",
	"…": "...",
	"⋯": "...",
	"′": "'",
	"″": "''",
	"‴": "'''",
	"°": "deg",
	"∈": "in",
	"∉": "!in",
	"∀": "forall",
	"∃": "exists",
	"¬": "not",
	"∧": "and",
	"∨": "or",
	"∩": "n",
	"∪": "u",
	"∅": "{}",
	α: "alpha",
	β: "beta",
	γ: "gamma",
	δ: "delta",
	ε: "epsilon",
	ζ: "zeta",
	η: "eta",
	θ: "theta",
	ι: "iota",
	κ: "kappa",
	λ: "lambda",
	μ: "mu",
	ν: "nu",
	ξ: "xi",
	π: "pi",
	ρ: "rho",
	σ: "sigma",
	τ: "tau",
	υ: "upsilon",
	φ: "phi",
	χ: "chi",
	ψ: "psi",
	ω: "omega",
	Γ: "Gamma",
	Δ: "Delta",
	Θ: "Theta",
	Λ: "Lambda",
	Ξ: "Xi",
	Π: "Pi",
	Σ: "Sigma",
	Φ: "Phi",
	Ψ: "Psi",
	Ω: "Omega",
	ℝ: "R",
	ℂ: "C",
	ℕ: "N",
	ℤ: "Z",
	ℚ: "Q",
	ℏ: "hbar",
	ℓ: "l",
};

const TABLES: Record<GlyphSet, GlyphTable> = {
	unicode: {
		vertical: UNICODE_VERTICAL,
		horizontal: UNICODE_HORIZONTAL,
		fractionBar: "─",
		overline: "─",
		radical: {foot: "⎷", stem: "╱", bar: null, shape: "rises"},
		plain: {},
	},
	"box-drawing": {
		vertical: BOX_DRAWING_VERTICAL,
		horizontal: UNICODE_HORIZONTAL,
		fractionBar: "─",
		overline: "─",
		radical: {foot: "╲", stem: "│", bar: null, shape: "stands"},
		plain: {},
	},
	ascii: {
		vertical: ASCII_VERTICAL,
		horizontal: ASCII_HORIZONTAL,
		fractionBar: "-",
		overline: "_",
		radical: {foot: "\\", stem: "/", bar: "_", shape: "climbs"},
		plain: ASCII_PLAIN,
	},
};

export interface BoxLines {
	horizontal: string;
	vertical: string;
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	cross: string;
	topJoin: string;
	bottomJoin: string;
	leftJoin: string;
	rightJoin: string;
}

const UNICODE_LINES: BoxLines = {
	horizontal: "─",
	vertical: "│",
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	cross: "┼",
	topJoin: "┬",
	bottomJoin: "┴",
	leftJoin: "├",
	rightJoin: "┤",
};

const ASCII_LINES: BoxLines = {
	horizontal: "-",
	vertical: "|",
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	cross: "+",
	topJoin: "+",
	bottomJoin: "+",
	leftJoin: "+",
	rightJoin: "+",
};

/** The rules and frame of a table or the border of an merror. */
export function getBoxLines(glyphs: GlyphSet): BoxLines {
	return glyphs === "ascii" ? ASCII_LINES : UNICODE_LINES;
}

export function getFractionBar(glyphs: GlyphSet): string {
	return TABLES[glyphs].fractionBar;
}

export function getOverline(glyphs: GlyphSet): string {
	return TABLES[glyphs].overline;
}

export function getRadical(glyphs: GlyphSet): RadicalPieces {
	return TABLES[glyphs].radical;
}

// The rows a large operator takes in display mode, where print sets it
// bigger than the text: the least that draws one. A sum whose top bar
// is an overline on its first stroke needs no row for the bar. Zero
// for an operator with no pieces to draw.
export function getDisplayHeight(
	op: string,
	glyphs: GlyphSet,
	overline: boolean,
): number {
	if (op === "∑") {
		return overline && glyphs !== "ascii" ? 2 : 3;
	}
	return op === "∏" || op in TABLES[glyphs].vertical ? 3 : 0;
}

/**
 * The text a token paints in a glyph set. Only the ASCII set rewrites
 * anything; a character it has no spelling for stays as it is.
 */
export function toPlainGlyphs(text: string, glyphs: GlyphSet): string {
	const plain = TABLES[glyphs].plain;
	let out = "";
	for (const char of text) {
		const replacement = plain[char];
		out += replacement === undefined ? char : replacement;
	}
	return out;
}

export function hasVerticalPieces(op: string, glyphs: GlyphSet): boolean {
	return (
		op in TABLES[glyphs].vertical ||
		op === "∑" ||
		op === "∏" ||
		op === "⟨" ||
		op === "⟩"
	);
}

export function hasHorizontalPieces(op: string, glyphs: GlyphSet): boolean {
	return op in TABLES[glyphs].horizontal;
}

/**
 * A vertically stretched operator, one string per row, at a height of at
 * least two. The center piece of a brace goes on the baseline row.
 */
export function buildVerticalGlyph(
	op: string,
	height: number,
	baseline: number,
	glyphs: GlyphSet,
	overline = false,
): GlyphRow[] | null {
	if (op === "∑") {
		return buildSum(height, glyphs, overline);
	}
	if (op === "∏") {
		return plainRows(buildProduct(height, glyphs));
	}
	if (op === "⟨" || op === "⟩") {
		return plainRows(buildAngle(op, height, baseline, glyphs));
	}
	const pieces = TABLES[glyphs].vertical[op];
	if (!pieces) {
		return null;
	}
	const rows: string[] = [];
	for (let row = 0; row < height; row++) {
		if (row === 0) {
			rows.push(pieces.top);
		} else if (row === height - 1) {
			rows.push(pieces.bottom);
		} else if (pieces.center !== undefined && row === baseline) {
			rows.push(pieces.center);
		} else {
			rows.push(pieces.middle);
		}
	}
	return plainRows(rows);
}

function plainRows(rows: string[]): GlyphRow[] {
	return rows.map((text) => ({text, underline: false}));
}

/**
 * A horizontally stretched operator (an accent or arrow over or under a
 * base) as one row of the given width.
 */
export function buildHorizontalGlyph(
	op: string,
	width: number,
	glyphs: GlyphSet,
): string | null {
	const pieces = TABLES[glyphs].horizontal[op];
	if (!pieces) {
		return null;
	}
	if (width <= 1) {
		return glyphs === "ascii" ? pieces.filler : op;
	}
	if (width === 2) {
		return pieces.left + pieces.right;
	}
	return pieces.left + pieces.filler.repeat(width - 2) + pieces.right;
}

// The shape SymPy draws, a backslash and slash meeting in the middle
// between two bars, each flush with the strokes. The bottom bar is an
// underline on the last stroke's row. The top bar is an overline on
// the first stroke's row when the terminal draws one, and otherwise an
// underline on a row of its own above.
function buildSum(
	height: number,
	glyphs: GlyphSet,
	overline: boolean,
): GlyphRow[] {
	if (glyphs === "ascii") {
		return plainRows([
			"___",
			...buildStrokes(Math.max(1, height - 2), "\\", "/"),
			"---",
		]);
	}
	const rows: GlyphRow[] = overline ? [] : [{text: "   ", underline: true}];
	for (const text of buildStrokes(height - rows.length, "╲", "╱")) {
		rows.push({text, underline: false});
	}
	if (overline) {
		rows[0].overline = true;
	}
	rows[rows.length - 1].underline = true;
	return rows;
}

// The strokes down and back, stepping out to the third column at most.
function buildStrokes(count: number, down: string, up: string): string[] {
	const upper = Math.ceil(count / 2);
	const rows: string[] = [];
	for (let i = 0; i < upper; i++) {
		rows.push(placeAt(down, Math.min(i, 2), 3));
	}
	for (let j = upper - 1; j >= 0 && rows.length < count; j--) {
		rows.push(placeAt(up, Math.min(j, 2), 3));
	}
	while (rows.length < count) {
		rows.push(placeAt(up, 0, 3));
	}
	return rows;
}

function buildProduct(height: number, glyphs: GlyphSet): string[] {
	const ascii = glyphs === "ascii";
	const rows: string[] = [ascii ? "+-+" : "┬─┬"];
	for (let row = 1; row < height; row++) {
		rows.push(ascii ? "| |" : "│ │");
	}
	return rows;
}

function buildAngle(
	op: string,
	height: number,
	baseline: number,
	glyphs: GlyphSet,
): string[] {
	const ascii = glyphs === "ascii";
	const down = ascii ? "\\" : "╲";
	const up = ascii ? "/" : "╱";
	const rows: string[] = [];
	for (let row = 0; row < height; row++) {
		if (row === baseline) {
			rows.push(ascii ? (op === "⟨" ? "<" : ">") : op);
		} else if (row < baseline) {
			rows.push(op === "⟨" ? up : down);
		} else {
			rows.push(op === "⟨" ? down : up);
		}
	}
	return rows;
}

function placeAt(glyph: string, column: number, width: number): string {
	return " ".repeat(column) + glyph + " ".repeat(width - column - 1);
}
