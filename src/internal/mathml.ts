/**
 * Presentation MathML layout. Every element lays out to a MathBox, a
 * grid of styled cells with a baseline row, built from three
 * combinators: beside, stack and pad. The <math> element's box is what
 * the block and inline engines place, and what the painter blits.
 */

import {getComputedValue} from "./cssom.ts";
import * as CSSValues from "./cssvalues.ts";
import {getDocumentExchange, MATHML_NAMESPACE} from "./dom.ts";
import type {CellStyle} from "./screen.ts";
import {getStringWidth, graphemeSegmenter} from "./text.ts";

// ---------------------------------------------------------------------
// The operator dictionary
// ---------------------------------------------------------------------
//
// MathML Core's operator dictionary, compressed by category. Each
// category names a form, the spacing on each side in eighteenths of an
// em, the properties every operator in it shares, and the operators.

type OperatorForm = "prefix" | "infix" | "postfix";

interface OperatorEntry {
	form: OperatorForm;
	lspace: number;
	rspace: number;
	stretchy: boolean;
	symmetric: boolean;
	largeop: boolean;
	accent: boolean;
	movableLimits: boolean;
}

type Category = [
	form: OperatorForm,
	lspace: number,
	rspace: number,
	flags: string,
	operators: string,
];

const CATEGORIES: Category[] = [
	[
		"infix",
		5,
		5,
		"",
		"= < > ≠ ≤ ≥ ≡ ≢ ≈ ≉ ≃ ≄ ≅ ≆ ≇ ≍ ≎ ≏ ≐ ≑ ≒ ≓ ≔ ≕ ≖ ≗ ≘ ≙ ≚ ≛ ≜ ≝ ≞ ≟ " +
		"≦ ≧ ≨ ≩ ≪ ≫ ≬ ≭ ≮ ≯ ≰ ≱ ≲ ≳ ≴ ≵ ≶ ≷ ≸ ≹ ≺ ≻ ≼ ≽ ≾ ≿ ⊀ ⊁ ⊂ ⊃ ⊄ ⊅ ⊆ ⊇ ⊈ ⊉ " +
		"⊊ ⊋ ⊏ ⊐ ⊑ ⊒ ⊢ ⊣ ⊤ ⊥ ⊦ ⊧ ⊨ ⊩ ⊪ ⊫ ⊬ ⊭ ⊮ ⊯ ⊰ ⊱ ⊲ ⊳ ⊴ ⊵ ⊶ ⊷ ⋍ ⋐ ⋑ ⋖ ⋗ ⋘ ⋙ " +
		"⋚ ⋛ ⋜ ⋝ ⋞ ⋟ ⋠ ⋡ ⋢ ⋣ ⋤ ⋥ ⋦ ⋧ ⋨ ⋩ ⋪ ⋫ ⋬ ⋭ ∈ ∉ ∊ ∋ ∌ ∍ ∝ ∣ ∤ ∥ ∦ ∼ ∽ ∾ ∿ ≀ ≁ " +
		": ∶ ∷ ⊏ ⊐ ⫅ ⫆ ⫋ ⫌ ⩽ ⩾ ⪅ ⪆ ⪇ ⪈ ⪉ ⪊ ⪋ ⪌ ⪕ ⪖ ⪯ ⪰ ⪷ ⪸ ⩵ ⩶ ⩸ ⫫ ⫬",
	],
	[
		"infix",
		5,
		5,
		"stretchy",
		"← ↑ → ↓ ↔ ↕ ↖ ↗ ↘ ↙ ↚ ↛ ↞ ↠ ↢ ↣ ↦ ↩ ↪ ↫ ↬ ↭ ↮ ↰ ↱ ↶ ↷ ↺ ↻ ↼ ↽ ↾ ↿ ⇀ ⇁ ⇂ ⇃ " +
		"⇄ ⇅ ⇆ ⇇ ⇈ ⇉ ⇊ ⇋ ⇌ ⇍ ⇎ ⇏ ⇐ ⇑ ⇒ ⇓ ⇔ ⇕ ⇖ ⇗ ⇘ ⇙ ⇚ ⇛ ⇝ ⇞ ⇟ ⇠ ⇡ ⇢ ⇣ ⇤ ⇥ ⇦ ⇧ ⇨ ⇩ " +
		"⇪ ⟵ ⟶ ⟷ ⟸ ⟹ ⟺ ⟻ ⟼ ⟽ ⟾ ⟿ ⤒ ⤓ ⥊ ⥋ ⥎ ⥐ ⥒ ⥓ ⥖ ⥗ ⥚ ⥛ ⥞ ⥟ ⥢ ⥤ ⥦ ⥧ ⥨ ⥩ ⥪ ⥫ ⥬ ⥭ ⥮ ⥯",
	],
	[
		"infix",
		4,
		4,
		"",
		"+ − - ± ∓ ∔ ∸ ∨ ∧ ⊕ ⊖ ⊎ ⊔ ⊓ ∪ ∩ ⋃ ⋂ ⊻ ⊼ ⊽ ⋎ ⋏ ⩒ ⩓ ⩔ ⩕ ⩖ ⩗ ⩘ ⩙ ⩚ ⩛ ⩜ ⩝ " +
		"⩞ ⩟ ⩠ ⩡ ⩢ ⩣ ⩤ ⩥ ⩦ ⩧ ⩨ ⩩ ⩪ ⩫ ⩬ ⩭ ⩮ ⩯ ⩰ ⩱ ⩲ ⩳ ⩴ ⨢ ⨣ ⨤ ⨥ ⨦ ⨧ ⨨ ⨩ ⨪ ⨫ ⨬ ⨭ ⨮ ⨹ ⨺",
	],
	[
		"infix",
		3,
		3,
		"",
		"× ⋅ · ∗ ∘ ∙ ⊗ ⊘ ⊙ ⊚ ⊛ ⊜ ⊝ ⊞ ⊟ ⊠ ⊡ ⋄ ⋆ ⋇ ⋈ ⋉ ⋊ ⋋ ⋌ ⋒ ⋓ ∖ ⁄ / ÷ ∤ ∦ % ‰ ‱ " +
		"⊗ ⨯ ⨰ ⨱ ⨲ ⨳ ⨴ ⨵ ⨶ ⨷ ⨸ ⨻ ⨼ ⨽ ⩀ ⩁ ⩂ ⩃ ⩄ ⩅ ⩆ ⩇ ⩈ ⩉ ⩊ ⩋ ⩌ ⩍ ⩎ ⩏ ⩐ ⩑ ∧ ∨ ∘ ∙ ⋅ ⊙ " +
		"@ & * . ^ ⃒ ⧵ ⨿",
	],
	["infix", 0, 3, "", ", ; "],
	["infix", 0, 0, "", "⁡ ⁢ ⁣ ⁤ ​ ' ′ ″ ‴ ⁗"],
	[
		"prefix",
		0,
		0,
		"stretchy symmetric",
		"( [ { ⌈ ⌊ ⟨ ⟦ ⟪ ⟬ ⟮ ⦃ ⦅ ⦇ ⦉ ⦋ ⦍ ⦏ ⦑ ⦓ ⦕ ⦗ ⧼ | ‖ ⎰ ⎱ ⟅ ⟨ ⦇ ⦉",
	],
	[
		"postfix",
		0,
		0,
		"stretchy symmetric",
		") ] } ⌉ ⌋ ⟩ ⟧ ⟫ ⟭ ⟯ ⦄ ⦆ ⦈ ⦊ ⦌ ⦎ ⦐ ⦒ ⦔ ⦖ ⦘ ⧽ | ‖ ⎱ ⟆ ⦈ ⦊",
	],
	[
		"prefix",
		3,
		3,
		"stretchy largeop symmetric movablelimits",
		"∑ ∏ ∐ ⋀ ⋁ ⋂ ⋃ ⨀ ⨁ ⨂ ⨃ ⨄ ⨅ ⨆ ⨇ ⨈ ⨉ ⫼ ⫽ ⫿",
	],
	[
		"prefix",
		3,
		0,
		"stretchy largeop symmetric",
		"∫ ∬ ∭ ∮ ∯ ∰ ∱ ∲ ∳ ⨋ ⨌ ⨍ ⨎ ⨏ ⨐ ⨑ ⨒ ⨓ ⨔ ⨕ ⨖ ⨗ ⨘ ⨙ ⨚ ⨛ ⨜",
	],
	["prefix", 0, 0, "movablelimits", "lim max min sup inf det gcd Pr"],
	[
		"prefix",
		0,
		0,
		"",
		"+ − - ± ∓ ¬ ∂ ∇ √ ∛ ∜ ∀ ∃ ∄ ∁ ∆ ∡ ∢ ∟ ∠ ℑ ℜ ℘ ∤ ∦ ⊘ ∽ ∾ ∿ ⅁ ⅂ ⅃ ⅄ ⅋ ⨊ ⫝̸ ⫝ ⫞ ⫟ ⫠",
	],
	["postfix", 0, 0, "", "! ′ ″ ‴ ⁗ ° ‰ ‱ ‼ ⁇ ⁈ ⁉ ′′ ′′′"],
	[
		"postfix",
		0,
		0,
		"accent stretchy",
		"^ ˆ ˇ ˉ ˊ ˋ ˍ ˘ ˙ ˚ ˜ ˝ ¯ ´ ` ¨ ¸ ~ _ ‾ ‿ ⁀ ⃗ ⏜ ⏝ ⏞ ⏟ ⏠ ⏡ ⎴ ⎵ ⎶ ← → ↔ ↼ ⇀ ⇐ ⇒ ⇔ " +
		"⟵ ⟶ ⟷ ─ ‐ ‑ ‒ – —",
	],
	["postfix", 0, 0, "accent", "̂ ̃ ̄ ̅ ̇ ̈ ̌ ̆ ̊ ̀ ́ ⃗ ̲ ̱ ̣ ̧ ̸ ̶ ̷"],
];

const FORM_ORDER: OperatorForm[] = ["infix", "postfix", "prefix"];

const DICTIONARY = new Map<string, OperatorEntry>();

for (const [form, lspace, rspace, flags, operators] of CATEGORIES) {
	const entry: OperatorEntry = {
		form,
		lspace,
		rspace,
		stretchy: flags.includes("stretchy"),
		symmetric: flags.includes("symmetric"),
		largeop: flags.includes("largeop"),
		accent: flags.includes("accent"),
		movableLimits: flags.includes("movablelimits"),
	};
	for (const operator of operators.split(" ")) {
		if (operator === "") {
			continue;
		}
		const key = `${form} ${operator}`;
		if (!DICTIONARY.has(key)) {
			DICTIONARY.set(key, entry);
		}
	}
}

/** The dictionary entry for an operator in exactly this form. */
function findOperator(
	text: string,
	form: OperatorForm,
): OperatorEntry | undefined {
	return DICTIONARY.get(`${form} ${text}`);
}

/**
 * The dictionary entry for an operator in a form. When the form has no
 * entry the other forms are tried in the order the spec gives, and an
 * operator in no form at all gets the spec's fallback: the requested
 * form, 5/18 em on each side, and no properties.
 */
function lookupOperator(text: string, form: OperatorForm): OperatorEntry {
	const own = DICTIONARY.get(`${form} ${text}`);
	if (own) {
		return own;
	}
	for (const candidate of FORM_ORDER) {
		const entry = DICTIONARY.get(`${candidate} ${text}`);
		if (entry) {
			return {...entry, form};
		}
	}
	return {
		form,
		lspace: 5,
		rspace: 5,
		stretchy: false,
		symmetric: false,
		largeop: false,
		accent: false,
		movableLimits: false,
	};
}

// ---------------------------------------------------------------------
// Glyph tables
// ---------------------------------------------------------------------
//
// The glyphs the engine assembles stretched operators, radicals and
// fraction bars from, in three sets: Unicode's Miscellaneous Technical
// pieces, box drawing only (for fonts without those pieces), and ASCII
// (for TERM=dumb, log files and plain-text copies).

type GlyphSet = "unicode" | "box-drawing" | "ascii";

function parseGlyphSet(value: string): GlyphSet {
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
 * to its own top right corner and the stem, a bar on that edge of the
 * cell, stands straight up from it; "climbs" when the foot is a bare
 * stroke and a diagonal steps a column per row, as SymPy draws it;
 * "stands" when the stem is a vertical bar beside the foot.
 */
interface RadicalPieces {
	foot: string;
	stem: string;
	bar: string | null;
	shape: "rises" | "climbs" | "stands";
}

// One row of a drawn glyph. An underlined row is a bar the terminal
// draws along the row's bottom edge, flush with the strokes below it.
interface GlyphRow {
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
		radical: {foot: "⎷", stem: "▕", bar: null, shape: "rises"},
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

interface BoxLines {
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
function getBoxLines(glyphs: GlyphSet): BoxLines {
	return glyphs === "ascii" ? ASCII_LINES : UNICODE_LINES;
}

function getFractionBar(glyphs: GlyphSet): string {
	return TABLES[glyphs].fractionBar;
}

function getRadical(glyphs: GlyphSet): RadicalPieces {
	return TABLES[glyphs].radical;
}

// Integrals with more than one sign, and with a ring, are columns of
// the integral's pieces, the ring on the middle row. Whether the ring
// joins the pieces above and below is the font's to decide.
const INTEGRALS: Record<string, {columns: number; ring: boolean}> = {
	"∫": {columns: 1, ring: false},
	"∬": {columns: 2, ring: false},
	"∭": {columns: 3, ring: false},
	"∮": {columns: 1, ring: true},
	"∯": {columns: 2, ring: true},
	"∰": {columns: 3, ring: true},
};

// The rows a large operator takes in display mode, where print sets it
// bigger than the text: the least that draws one. A sum whose top bar
// is an overline on its first stroke needs no row for the bar. Zero
// for an operator with no pieces to draw.
function getDisplayHeight(
	op: string,
	glyphs: GlyphSet,
	overline: boolean,
): number {
	if (op === "∑") {
		return overline && glyphs !== "ascii" ? 2 : 3;
	}
	// A product is its bar and its legs.
	if (op === "∏") {
		return 2;
	}
	return op in TABLES[glyphs].vertical || op in INTEGRALS ? 3 : 0;
}

/**
 * The text a token paints in a glyph set. Only the ASCII set rewrites
 * anything; a character it has no spelling for stays as it is.
 */
function toPlainGlyphs(text: string, glyphs: GlyphSet): string {
	const plain = TABLES[glyphs].plain;
	let out = "";
	for (const char of text) {
		const replacement = plain[char];
		out += replacement === undefined ? char : replacement;
	}
	return out;
}

function hasVerticalPieces(op: string, glyphs: GlyphSet): boolean {
	return (
		op in TABLES[glyphs].vertical ||
		op in INTEGRALS ||
		op === "∑" ||
		op === "∏" ||
		op === "⟨" ||
		op === "⟩"
	);
}

function hasHorizontalPieces(op: string, glyphs: GlyphSet): boolean {
	return op in TABLES[glyphs].horizontal;
}

/**
 * A vertically stretched operator, one string per row, at a height of at
 * least two. The center piece of a brace goes on the baseline row.
 */
function buildVerticalGlyph(
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
	if (op in INTEGRALS) {
		return plainRows(buildIntegral(op, height, baseline, glyphs));
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
function buildHorizontalGlyph(
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

function buildIntegral(
	op: string,
	height: number,
	baseline: number,
	glyphs: GlyphSet,
): string[] {
	const {columns, ring} = INTEGRALS[op];
	const pieces = TABLES[glyphs].vertical["∫"];
	// The ring on the stroke: the APL circle stile in the Unicode set,
	// whose stroke runs through the ring, and a bare ring elsewhere.
	const center = glyphs === "ascii"
		? "o"
		: glyphs === "box-drawing" ? "○" : "⌽";
	const rows: string[] = [];
	for (let row = 0; row < height; row++) {
		const piece = row === 0
			? pieces.top
			: row === height - 1
				? pieces.bottom
				: ring && row === baseline ? center : pieces.middle;
		rows.push(piece.repeat(columns));
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
	_baseline: number,
	glyphs: GlyphSet,
): string[] {
	const ascii = glyphs === "ascii";
	const down = ascii ? "\\" : "╲";
	const up = ascii ? "/" : "╱";
	// The point is on the middle row when there is one, and otherwise
	// the strokes meet at the seam between the two middle rows.
	const rows: string[] = [];
	const point = height % 2 === 1 ? (height - 1) >> 1 : -1;
	for (let row = 0; row < height; row++) {
		if (row === point) {
			rows.push(ascii ? (op === "⟨" ? "<" : ">") : op);
		} else if (row < height / 2) {
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

// ---------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------

export interface MathCell {
	text: string;
	width: number;
	style: CellStyle | null;
	// The text the cell renders, for selection and geometry. A drawn
	// stroke or bar has none.
	source?: CellSource;
}

export interface CellSource {
	node: Text;
	offset: number;
	length: number;
}

// One code point of a token's text and where it came from. A quote an
// ms adds, or a space a collapsed run leaves, comes from nowhere.
interface SourcedChar {
	ch: string;
	source: CellSource | null;
}

export interface MathBox {
	width: number;
	height: number;
	baseline: number;
	cells: MathCell[][];
	// Leading cells that hang outside the box when it is centered: a
	// negation sign, so its operand centers over a denominator.
	hang?: number;
}

export type Alignment = "left" | "center" | "right";

interface MathContext {
	display: boolean;
	glyphs: GlyphSet;
	variantGlyphs: boolean;
	// The terminal draws SGR 53, so a bar over a row can be an overline
	// on that row rather than an underline on a row above it.
	overline: boolean;
	// Inside a script or a limit, where operators get no spacing.
	tight: boolean;
}

interface Operator {
	text: string;
	entry: OperatorEntry;
	form: OperatorForm;
	fence: boolean;
	gapBefore: boolean;
	gapAfter: boolean;
}

const BLANK: MathCell = {text: " ", width: 1, style: null};

const MATHML_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

const TOKENS = new Set(["mi", "mn", "mo", "mtext", "ms"]);

// The bars \overline and \underline write as accents.
const BAR_ACCENTS = new Set(["‾", "¯", "ˉ", "_", "̄", "̅", "̲", "─"]);

// Function application, invisible times, separator and plus, and the
// zero-width space: operators with no glyph and no cell.
const INVISIBLE_OPERATORS = /^[\u2061-\u2064\u200b]$/u;

export function isMathRoot(node: Node): boolean {
	return (
		node.nodeType === node.ELEMENT_NODE &&
		(node as Element).namespaceURI === MATHML_NAMESPACE &&
		(node as Element).localName === "math"
	);
}

function isMathElement(node: Node): boolean {
	return (
		node.nodeType === node.ELEMENT_NODE &&
		(node as Element).namespaceURI === MATHML_NAMESPACE
	);
}

/**
 * The box a <math> element renders as. Display mode may use any number
 * of rows; inline mode linearizes everything onto one.
 */
export function layoutMath(element: Element, display: boolean): MathBox {
	const context: MathContext = {
		display,
		glyphs: parseGlyphSet(getComputedValue(element, "--math-glyphs")),
		variantGlyphs:
			getComputedValue(element, "--math-variant-glyphs").trim() === "unicode",
		overline:
			getDocumentExchange(element.ownerDocument)?.overlineNegotiated() ?? false,
		tight: false,
	};
	return layoutRow(getLayoutChildren(element), element, context);
}

export function createEmptyBox(
	width: number,
	height = 1,
	baseline = 0,
): MathBox {
	const cells: MathCell[][] = [];
	for (let row = 0; row < height; row++) {
		cells.push(blankRow(width));
	}
	return {width, height, baseline, cells};
}

function blankRow(width: number): MathCell[] {
	const row: MathCell[] = [];
	for (let i = 0; i < width; i++) {
		row.push(BLANK);
	}
	return row;
}

export function createTextBox(text: string, style: CellStyle | null): MathBox {
	return createSourcedBox(unsourced(text), style);
}

function unsourced(text: string): SourcedChar[] {
	return Array.from(text, (ch) => ({ch, source: null}));
}

function createSourcedBox(
	chars: SourcedChar[],
	style: CellStyle | null,
): MathBox {
	let text = "";
	const sources: Array<CellSource | null> = [];
	for (const {ch, source} of chars) {
		for (let i = 0; i < ch.length; i++) {
			sources.push(source);
		}
		text += ch;
	}
	const cells: MathCell[] = [];
	let width = 0;
	for (const {segment, index} of graphemeSegmenter.segment(text)) {
		const cellWidth = getStringWidth(segment);
		if (cellWidth <= 0) {
			if (cells.length > 0) {
				const last = cells[cells.length - 1];
				cells[cells.length - 1] = {...last, text: last.text + segment};
			}
			continue;
		}
		const source = sources[index];
		cells.push(
			source === null
				? {text: segment, width: cellWidth, style}
				: {text: segment, width: cellWidth, style, source},
		);
		width += cellWidth;
	}
	return {width, height: 1, baseline: 0, cells: [cells]};
}

// The code points of the text under an element, each with the text
// node and offset it sits at.
function readTokenChars(element: Element): SourcedChar[] {
	const chars: SourcedChar[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === node.TEXT_NODE) {
			chars.push(...readTextChars(node as Text));
			return;
		}
		for (const child of node.childNodes) {
			walk(child);
		}
	};
	walk(element);
	return chars;
}

function readTextChars(node: Text): SourcedChar[] {
	const chars: SourcedChar[] = [];
	let offset = 0;
	for (const ch of node.data) {
		chars.push({ch, source: {node, offset, length: ch.length}});
		offset += ch.length;
	}
	return chars;
}

// A run of white space is one space, and none at either end unless the
// edges are kept. White space is MathML's: the four ASCII characters,
// so a no-break space stays what it is.
function collapseChars(chars: SourcedChar[], keepEdges = false): SourcedChar[] {
	const out: SourcedChar[] = [];
	let pendingSpace = false;
	for (const char of chars) {
		if (MATHML_WHITESPACE.has(char.ch)) {
			pendingSpace = keepEdges || out.length > 0;
			continue;
		}
		if (pendingSpace) {
			out.push({ch: " ", source: null});
			pendingSpace = false;
		}
		out.push(char);
	}
	if (pendingSpace && keepEdges && out.length > 0) {
		out.push({ch: " ", source: null});
	}
	return out;
}

function joinChars(chars: SourcedChar[]): string {
	return chars.map((char) => char.ch).join("");
}

// The cells of a box's columns the text-align of a wider content box
// leaves free on the left.
export function getMathAlignOffset(spare: number, align: string): number {
	if (spare <= 0) {
		return 0;
	}
	return align === "right" || align === "end"
		? spare
		: align === "center" ? spare >> 1 : 0;
}

/**
 * The text position a point in a box's cells stands for: the text the
 * nearest cell with a source renders, before it, or after it when the
 * point lies to its right, as a pointer past a line's last character
 * does. Null for a box with no text in it.
 */
export function findMathPosition(
	box: MathBox,
	x: number,
	y: number,
): {node: Text; offset: number} | null {
	let best: {source: CellSource; end: number; distance: number} | null = null;
	for (let row = 0; row < box.height; row++) {
		let column = 0;
		for (const cell of box.cells[row]) {
			if (cell.source !== undefined) {
				const end = column + cell.width;
				const dx = x < column ? column - x : x >= end ? x - end + 1 : 0;
				const distance = Math.abs(row - y) * 1000 + dx;
				if (best === null || distance < best.distance) {
					best = {source: cell.source, end, distance};
				}
			}
			column += cell.width;
		}
	}
	if (best === null) {
		return null;
	}
	const {source, end} = best;
	return {
		node: source.node,
		offset: x >= end ? source.offset + source.length : source.offset,
	};
}

/** The cells, as rectangles in the box, that render a node's text. */
export function getMathCellRects(
	box: MathBox,
	node: Node,
): Array<{x: number; y: number; width: number; height: number}> {
	const rects: Array<{x: number; y: number; width: number; height: number}> =
		[];
	for (let row = 0; row < box.height; row++) {
		let column = 0;
		for (const cell of box.cells[row]) {
			const source = cell.source;
			if (
				source !== undefined &&
				(node.nodeType === node.TEXT_NODE
					? source.node === node
					: node.contains(source.node))
			) {
				const last = rects[rects.length - 1];
				if (
					last !== undefined && last.y === row && last.x + last.width === column
				) {
					last.width += cell.width;
				} else {
					rects.push({x: column, y: row, width: cell.width, height: 1});
				}
			}
			column += cell.width;
		}
	}
	return rects;
}

export function getDescent(box: MathBox): number {
	return box.height - box.baseline - 1;
}

/** Horizontal concatenation on a shared baseline. */
export function beside(a: MathBox, b: MathBox, gap = 0): MathBox {
	const baseline = Math.max(a.baseline, b.baseline);
	const descent = Math.max(getDescent(a), getDescent(b));
	const height = baseline + descent + 1;
	const left = alignToBaseline(a, baseline, height);
	const right = alignToBaseline(b, baseline, height);
	const cells: MathCell[][] = [];
	for (let row = 0; row < height; row++) {
		cells.push([...left.cells[row], ...blankRow(gap), ...right.cells[row]]);
	}
	return {width: a.width + gap + b.width, height, baseline, cells};
}

function alignToBaseline(
	box: MathBox,
	baseline: number,
	height: number,
): MathBox {
	const top = baseline - box.baseline;
	const bottom = height - box.height - top;
	return top === 0 && bottom === 0 ? box : pad(box, top, 0, bottom, 0);
}

/** Vertical concatenation. The caller says which row is the baseline. */
export function stack(
	top: MathBox,
	bottom: MathBox,
	align: Alignment,
	baseline: number,
): MathBox {
	const width = Math.max(top.width, bottom.width);
	const cells = [
		...widenRows(top, width, align),
		...widenRows(bottom, width, align),
	];
	return {width, height: cells.length, baseline, cells};
}

function widenRows(
	box: MathBox,
	width: number,
	align: Alignment,
): MathCell[][] {
	const extra = width - box.width;
	if (extra <= 0) {
		return box.cells;
	}
	const hang = box.hang ?? 0;
	const left = align === "left"
		? 0
		: align === "right" ? extra : Math.max(0, ((extra + hang) >> 1) - hang);
	const right = extra - left;
	return box.cells.map((row) => [
		...blankRow(left),
		...row,
		...blankRow(right),
	]);
}

export function pad(
	box: MathBox,
	top: number,
	right: number,
	bottom: number,
	left: number,
): MathBox {
	const width = box.width + left + right;
	const cells: MathCell[][] = [];
	for (let row = 0; row < top; row++) {
		cells.push(blankRow(width));
	}
	for (const row of box.cells) {
		cells.push([...blankRow(left), ...row, ...blankRow(right)]);
	}
	for (let row = 0; row < bottom; row++) {
		cells.push(blankRow(width));
	}
	return {width, height: cells.length, baseline: box.baseline + top, cells};
}

export function getBoxText(box: MathBox): string[] {
	return box.cells.map((row) => row.map((cell) => cell.text).join(""));
}

// The children an element lays out: its elements, plus any text that is
// not just white space, which renders as if it were an mtext.
function getLayoutChildren(element: Element): Node[] {
	const children: Node[] = [];
	for (const child of element.childNodes) {
		if (child.nodeType === child.ELEMENT_NODE) {
			if (getComputedValue(child as Element, "display") !== "none") {
				children.push(child);
			}
		} else if (
			child.nodeType === child.TEXT_NODE && (child as Text).data.trim() !== ""
		) {
			children.push(child);
		}
	}
	return children;
}

function layoutNode(node: Node, context: MathContext): MathBox {
	if (node.nodeType === node.TEXT_NODE) {
		const parent = node.parentElement;
		return createSourcedBox(
			collapseChars(readTextChars(node as Text)),
			parent ? getTokenStyle(parent, null) : null,
		);
	}
	const element = node as Element;
	if (!isMathElement(element)) {
		return layoutTextToken(element, element.textContent ?? "", context);
	}
	const local = getComputedValue(element, "math-style") === "compact"
		? {...context, display: false}
		: context;
	// A token holding elements, as KaTeX writes \overset with an mover
	// inside an mo, renders its children as a row, as a browser does.
	if (
		TOKENS.has(element.localName) &&
		getLayoutChildren(element).some((child) => isMathElement(child))
	) {
		return layoutRow(getLayoutChildren(element), element, local);
	}
	switch (element.localName) {
		case "mi":
		case "mn":
		case "mo":
			return layoutTextToken(element, element.textContent ?? "", local);
		case "mtext": {
			// TeX's thin and thick spaces arrive as blank mtext. Text keeps a
			// space at either end, as inline text does beside its neighbors.
			const text = element.textContent ?? "";
			return text !== "" && text.trim() === ""
				? createEmptyBox(1)
				: layoutTextToken(
					element,
					text,
					local,
					collapseChars(readTokenChars(element), true),
				);
		}
		case "ms": {
			const quoted = [
				...unsourced(element.getAttribute("lquote") ?? "\""),
				...collapseChars(readTokenChars(element)),
				...unsourced(element.getAttribute("rquote") ?? "\""),
			];
			return layoutTextToken(element, joinChars(quoted), local, quoted);
		}
		case "mspace": {
			const width = parseMathLength(element.getAttribute("width")) ?? 0;
			return createEmptyBox(width > 0 ? Math.max(1, Math.round(width)) : 0);
		}
		case "maction":
		case "semantics": {
			const first = getLayoutChildren(element)[0];
			return first ? layoutNode(first, local) : createEmptyBox(1);
		}
		case "annotation":
		case "annotation-xml":
		case "mprescripts":
		case "none":
			return createEmptyBox(0);
		case "msub":
		case "msup":
		case "msubsup":
			return layoutScriptElement(element, local);
		case "mmultiscripts":
			return layoutMultiscripts(element, local);
		case "mfrac":
			return layoutFraction(element, local);
		case "msqrt":
		case "mroot":
			return layoutRadical(element, local);
		case "munder":
		case "mover":
		case "munderover":
			return layoutUnderOver(element, local);
		case "mtable":
			return layoutTable(element, local);
		case "mpadded":
			return layoutPadded(element, local);
		case "mphantom":
			return blankOut(layoutRow(getLayoutChildren(element), element, local));
		case "merror":
			return layoutError(element, local);
		default:
			return layoutRow(getLayoutChildren(element), element, local);
	}
}

function collapseTokenText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function layoutTextToken(
	element: Element,
	text: string,
	context: MathContext,
	chars?: SourcedChar[],
): MathBox {
	let letters = (
		chars ??
		collapseChars(
			text === (element.textContent ?? "")
				? readTokenChars(element)
				: unsourced(text),
		)
	).filter((char) => !INVISIBLE_OPERATORS.test(char.ch));
	const collapsed = joinChars(letters);
	const large = getLargeOperatorRows(element, collapsed, context);
	if (large !== null) {
		return large;
	}
	// A one-letter identifier is italic, as print sets variables, by the
	// user agent's text-transform: math-auto on mi, which an author's
	// text-transform: none turns off, as in a browser.
	let variant = getMathVariant(element);
	if (
		variant === null &&
		element.localName === "mi" &&
		isSingleGrapheme(collapsed) &&
		getComputedValue(element, "text-transform") === "math-auto"
	) {
		variant = "italic";
	}
	let bold = variant !== null && variant.includes("bold");
	let italic = variant !== null && variant.includes("italic");
	if (variant !== null && context.glyphs !== "ascii") {
		const mapped = toMathAlphanumeric(letters, variant, context.variantGlyphs);
		if (mapped !== null) {
			letters = mapped;
			bold = false;
			italic = false;
		}
	}
	letters = letters.flatMap((char) =>
		Array.from(toPlainGlyphs(char.ch, context.glyphs), (ch) => ({
			ch,
			source: char.source,
		})),
	);
	return createSourcedBox(
		letters,
		getTokenStyle(element, variant === null ? null : {bold, italic}),
	);
}

// A large operator at display size: rows for the print convention
// that sets a sum or integral bigger than the text around it. Null
// where the text size holds: inline, in a script, or with no pieces.
function getLargeOperatorRows(
	element: Element,
	text: string,
	context: MathContext,
): MathBox | null {
	if (
		!context.display ||
		context.tight ||
		!isOperatorElement(element) ||
		!lookupOperator(text, "prefix").largeop
	) {
		return null;
	}
	const height = getDisplayHeight(text, context.glyphs, context.overline);
	if (height < 2) {
		return null;
	}
	const baseline = getLargeOperatorBaseline(text, height);
	const rows = buildVerticalGlyph(
		text,
		height,
		baseline,
		context.glyphs,
		context.overline,
	);
	return rows === null
		? null
		: createRowsBox(rows, baseline, getTokenStyle(element, null));
}

// The middle row, or the upper of the two middle rows: beside a drawn
// sum, the summand sits on the row of the first stroke. A product's
// top row is its bar, so its operand sits beside the legs.
function getLargeOperatorBaseline(text: string, height: number): number {
	const middle = (height - 1) >> 1;
	return text === "∏" ? Math.max(1, middle) : middle;
}

interface AlphanumericRange {
	upper: number;
	lower: number;
	digits?: number;
	greekUpper?: number;
	greekLower?: number;
	exceptions?: Record<string, string>;
}

// The Mathematical Alphanumeric Symbols block, by mathvariant. The
// exceptions are the letters Unicode had encoded before the block.
const ALPHANUMERIC_RANGES: Record<string, AlphanumericRange> = {
	bold: {
		upper: 0x1d400,
		lower: 0x1d41a,
		digits: 0x1d7ce,
		greekUpper: 0x1d6a8,
		greekLower: 0x1d6c2,
	},
	italic: {
		upper: 0x1d434,
		lower: 0x1d44e,
		greekUpper: 0x1d6e2,
		greekLower: 0x1d6fc,
		exceptions: {h: "ℎ"},
	},
	"bold-italic": {
		upper: 0x1d468,
		lower: 0x1d482,
		greekUpper: 0x1d71c,
		greekLower: 0x1d736,
	},
	script: {
		upper: 0x1d49c,
		lower: 0x1d4b6,
		exceptions: {
			B: "ℬ",
			E: "ℰ",
			F: "ℱ",
			H: "ℋ",
			I: "ℐ",
			L: "ℒ",
			M: "ℳ",
			R: "ℛ",
			e: "ℯ",
			g: "ℊ",
			o: "ℴ",
		},
	},
	fraktur: {
		upper: 0x1d504,
		lower: 0x1d51e,
		exceptions: {C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ"},
	},
	"double-struck": {
		upper: 0x1d538,
		lower: 0x1d552,
		digits: 0x1d7d8,
		exceptions: {C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ"},
	},
	"sans-serif": {upper: 0x1d5a0, lower: 0x1d5ba, digits: 0x1d7e2},
	monospace: {upper: 0x1d670, lower: 0x1d68a, digits: 0x1d7f6},
};

// The text in the block's letters, or null when any character has no
// form there, so the token falls back to SGR bold and italic. The
// letters Unicode encoded before the block (ℝ, ℂ, ℕ, ℋ, ℜ) are in every
// font that has any math at all, so they are used without the flag that
// opts into the block.
function toMathAlphanumeric(
	chars: SourcedChar[],
	variant: string,
	block: boolean,
): SourcedChar[] | null {
	const range = ALPHANUMERIC_RANGES[variant];
	if (range === undefined) {
		return null;
	}
	const out: SourcedChar[] = [];
	for (const {ch, source} of chars) {
		const mapped = mapAlphanumeric(ch, range, block);
		if (mapped === null) {
			return null;
		}
		out.push({ch: mapped, source});
	}
	return out;
}

function mapAlphanumeric(
	char: string,
	range: AlphanumericRange,
	block: boolean,
): string | null {
	const code = char.codePointAt(0)!;
	const exception = range.exceptions?.[char];
	if (exception !== undefined) {
		return exception;
	}
	if (char === " ") {
		return char;
	}
	if (!block) {
		return null;
	}
	if (code >= 0x41 && code <= 0x5a) {
		return String.fromCodePoint(range.upper + code - 0x41);
	}
	if (code >= 0x61 && code <= 0x7a) {
		return String.fromCodePoint(range.lower + code - 0x61);
	}
	if (code >= 0x30 && code <= 0x39 && range.digits !== undefined) {
		return String.fromCodePoint(range.digits + code - 0x30);
	}
	if (code >= 0x391 && code <= 0x3a9 && range.greekUpper !== undefined) {
		return String.fromCodePoint(range.greekUpper + code - 0x391);
	}
	if (code >= 0x3b1 && code <= 0x3c9 && range.greekLower !== undefined) {
		return String.fromCodePoint(range.greekLower + code - 0x3b1);
	}
	return null;
}

function isSingleGrapheme(text: string): boolean {
	let count = 0;
	for (const _ of graphemeSegmenter.segment(text)) {
		if (++count > 1) {
			return false;
		}
	}
	return count === 1;
}

function getMathVariant(element: Element): string | null {
	for (
		let current: Element | null = element;
		current !== null && isMathElement(current);
		current = current.parentElement
	) {
		const variant = current.getAttribute("mathvariant");
		if (variant !== null) {
			return variant.trim().toLowerCase();
		}
	}
	return null;
}

// The cell style of an element's text. A math variant, when the token
// has one, decides bold and italic instead of the font properties.
function getTokenStyle(
	element: Element,
	variant: {bold: boolean; italic: boolean} | null,
): CellStyle | null {
	const color = getComputedValue(element, "color");
	const background = getComputedValue(element, "background-color");
	const weight = getComputedValue(element, "font-weight");
	const fontStyle = getComputedValue(element, "font-style");
	const bold = variant === null
		? weight === "bold" ||
		weight === "bolder" ||
		(Number.isFinite(Number(weight)) && Number(weight) >= 600)
		: variant.bold;
	const italic = variant === null
		? fontStyle === "italic" || fontStyle === "oblique"
		: variant.italic;
	const style: CellStyle = {};
	let any = false;
	if (color && color !== "initial" && !CSSValues.isHighlightColor(color)) {
		style.fg = CSSValues.cssColorToNumber(color);
		any = true;
	}
	if (
		background &&
		background !== "initial" &&
		!CSSValues.isTransparentColor(background) &&
		!CSSValues.isCanvasColor(background) &&
		!CSSValues.isHighlightColor(background)
	) {
		style.bg = CSSValues.cssColorToNumber(background);
		any = true;
	}
	if (bold) {
		style.bold = true;
		any = true;
	}
	if (italic) {
		style.italic = true;
		any = true;
	}
	return any ? style : null;
}

/**
 * A length attribute in cells, unrounded. em, ch and px are one column;
 * ex and lh one row; a bare number counts cells. A percentage or an
 * unknown unit is null.
 */
export function parseMathLength(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const match = /^\s*([+-]?\d*\.?\d+)\s*([a-z%]*)\s*$/i.exec(value);
	if (!match) {
		return null;
	}
	switch (match[2].toLowerCase()) {
		case "":
		case "em":
		case "ch":
		case "px":
		case "ex":
		case "lh":
		case "rem":
			return Number(match[1]);
		default:
			return null;
	}
}

/** An operator's form: the attribute, else its position in the row. */
function getOperatorForm(
	element: Element,
	index: number,
	count: number,
): OperatorForm {
	const attribute = element.getAttribute("form")?.trim().toLowerCase();
	if (
		attribute === "prefix" || attribute === "infix" || attribute === "postfix"
	) {
		return attribute;
	}
	if (count > 1 && index === 0) {
		return "prefix";
	}
	if (count > 1 && index === count - 1) {
		return "postfix";
	}
	return "infix";
}

function readSpace(element: Element, name: string, fallback: number): number {
	const value = element.getAttribute(name);
	if (value === null) {
		return fallback / 18;
	}
	const match = /^\s*([+-]?\d*\.?\d+)\s*(em|px|ch|ex)?\s*$/i.exec(value);
	return match ? Number(match[1]) : fallback / 18;
}

function readFlag(element: Element, name: string, fallback: boolean): boolean {
	const value = element.getAttribute(name)?.trim().toLowerCase();
	return value === "true" ? true : value === "false" ? false : fallback;
}

function getOperator(element: Element, index: number, count: number): Operator {
	const text = collapseTokenText(element.textContent ?? "");
	const form = getOperatorForm(element, index, count);
	const found = lookupOperator(text, form);
	// A fence the author marked as one stretches, whatever the
	// dictionary says of the character.
	const fence = readFlag(element, "fence", false);
	const entry: OperatorEntry = {
		...found,
		stretchy: readFlag(element, "stretchy", found.stretchy || fence),
		symmetric: readFlag(element, "symmetric", found.symmetric),
		largeop: readFlag(element, "largeop", found.largeop),
		accent: readFlag(element, "accent", found.accent),
	};
	// TeX puts a thin space after a large operator, a function name and
	// a limit-taking word like lim, and before a large operator.
	const infix = form === "infix";
	return {
		text,
		entry,
		form,
		fence,
		gapBefore:
			(infix && readSpace(element, "lspace", found.lspace) >= 0.2) ||
			entry.largeop,
		gapAfter:
			(infix && readSpace(element, "rspace", found.rspace) >= 0.2) ||
			entry.largeop ||
			entry.movableLimits ||
			text === "\u2061" ||
			text === "," ||
			text === ";",
	};
}

function isNegation(operator: Operator): boolean {
	return (
		operator.form === "prefix" &&
		(operator.text === "−" || operator.text === "-")
	);
}

function isOperatorElement(node: Node): boolean {
	return isMathElement(node) && (node as Element).localName === "mo";
}

const SCRIPTED = new Set([
	"msub",
	"msup",
	"msubsup",
	"munder",
	"mover",
	"munderover",
	"mmultiscripts",
]);

const WRAPPERS = new Set(["mrow", "mstyle", "mpadded", "mphantom"]);

// The operator an element's spacing comes from: itself for an mo; for
// scripts, limits and a wrapper around one, the operator inside (MathML
// Core's embellished operator); and for a row ending in function
// application, as KaTeX writes lim, that operator.
function getCoreOperator(node: Node): Element | null {
	if (!isMathElement(node)) {
		return null;
	}
	const element = node as Element;
	if (element.localName === "mo") {
		return element;
	}
	const children = getLayoutChildren(element);
	if (SCRIPTED.has(element.localName) && children.length > 0) {
		return getCoreOperator(children[0]);
	}
	if (WRAPPERS.has(element.localName) && children.length === 1) {
		return getCoreOperator(children[0]);
	}
	const last = children[children.length - 1];
	if (
		WRAPPERS.has(element.localName) &&
		last !== undefined &&
		isOperatorElement(last) &&
		collapseTokenText((last as Element).textContent ?? "") === "\u2061"
	) {
		return last as Element;
	}
	return null;
}

// TeX sets nothing apart from a fence on its inside: not the large
// operator after an opening one, nor anything before a closing one. A
// bar is either, so only its position says which.
function isFence(operator: Operator, side: "prefix" | "postfix"): boolean {
	if (operator.fence) {
		return operator.form === side;
	}
	// An arrow is a stretchy accent in postfix form, not a fence.
	const isFenceEntry = (entry: OperatorEntry | undefined): boolean =>
		entry !== undefined &&
		entry.stretchy &&
		!entry.largeop &&
		!entry.accent &&
		entry.lspace === 0 &&
		entry.rspace === 0;
	if (!isFenceEntry(findOperator(operator.text, side))) {
		return false;
	}
	const other = side === "prefix" ? "postfix" : "prefix";
	return !isFenceEntry(findOperator(operator.text, other)) ||
		operator.form === side;
}

function isBlankBox(box: MathBox): boolean {
	return box.width > 0 && box.cells.every((row) => row.every(isBlankCell));
}

export function isBlankCell(cell: MathCell): boolean {
	return (
		cell.text === " " &&
		cell.style?.bg == null &&
		!cell.style?.underline &&
		!cell.style?.overline
	);
}

/**
 * An mrow's children side by side. An infix operator with enough
 * spacing in the dictionary gets one cell on that side; prefix and
 * postfix operators get none. A stretchy operator is laid out last, to
 * the height of the other children.
 */
function layoutRow(
	children: Node[],
	_parent: Element,
	context: MathContext,
): MathBox {
	if (children.length === 0) {
		return createEmptyBox(1);
	}
	const operators = children.map((child, index) =>
		isOperatorElement(child)
			? getOperator(child as Element, index, children.length)
			: null,
	);
	// A minus at the start of a row or after another operator, as in
	// "= −x", negates rather than subtracts, whatever its position says.
	for (let index = 0; index < operators.length; index++) {
		const operator = operators[index];
		const before = index === 0 ? null : operators[index - 1];
		if (
			operator !== null &&
			operator.form !== "prefix" &&
			(operator.text === "−" || operator.text === "-") &&
			(index === 0 || (before !== null && !isFence(before, "postfix")))
		) {
			operators[index] = {
				...operator,
				form: "prefix",
				gapBefore: false,
				gapAfter: false,
			};
		}
	}
	const boxes = children.map((child, index) => {
		const operator = operators[index];
		if (operator !== null && isVerticallyStretchy(operator, context)) {
			return null;
		}
		// A negation sign is the short dash, and the box it starts hangs
		// it outside the operand when centered.
		if (operator !== null && isNegation(operator)) {
			const source =
				readTokenChars(child as Element).find((char) => char.source !== null)
					?.source ?? null;
			return createSourcedBox(
				Array.from(toPlainGlyphs("-", context.glyphs), (ch) => ({ch, source})),
				getTokenStyle(child as Element, null),
			);
		}
		return layoutNode(child, context);
	});
	const hang = operators[0] !== null && isNegation(operators[0]) ? 1 : 0;
	let ascent = 0;
	let descent = 0;
	for (const box of boxes) {
		if (box !== null) {
			ascent = Math.max(ascent, box.baseline);
			descent = Math.max(descent, getDescent(box));
		}
	}
	let result: MathBox | null = null;
	let gapAfter = false;
	let blankBefore = false;
	let openBefore = false;
	let applicationBefore = false;
	for (let index = 0; index < children.length; index++) {
		const operator = operators[index];
		const box =
			boxes[index] ??
			layoutStretchedOperator(
				children[index] as Element,
				operator!,
				ascent,
				descent,
				context,
			);
		const spacing = operator ?? getSpacing(children[index], box, context);
		const blank = isBlankBox(box);
		if (result === null) {
			result = box;
		} else {
			// A blank cell already keeps the boxes apart, and a function
			// name meets its parenthesis directly, as sin(x).
			const wanted = gapAfter || (spacing?.gapBefore ?? false);
			const covered =
				blank ||
				blankBefore ||
				openBefore ||
				(spacing !== null && isFence(spacing, "postfix")) ||
				(applicationBefore && spacing !== null && isFence(spacing, "prefix"));
			const gap = !context.tight && wanted && !covered && box.width > 0 ? 1 : 0;
			result = beside(result, box, gap);
		}
		if (hang > 0 && result.width > hang) {
			result = {...result, hang};
		}
		// An invisible operator has no cell of its own; its spacing carries
		// to the next box that has one.
		if (box.width > 0) {
			gapAfter = spacing?.gapAfter ?? false;
			blankBefore = blank;
			openBefore = spacing !== null && isFence(spacing, "prefix");
			applicationBefore = spacing?.text === "\u2061";
		} else if (spacing !== null) {
			gapAfter = gapAfter || spacing.gapAfter;
			applicationBefore = spacing.text === "\u2061";
		}
	}
	return result!;
}

// The spacing of a scripted or wrapped operator. A large operator whose
// limits stand over and under it in display mode is already set apart
// by them when they are wider than it.
function getSpacing(
	node: Node,
	box: MathBox,
	context: MathContext,
): Operator | null {
	const core = getCoreOperator(node);
	if (core === null || core === node) {
		return null;
	}
	const spacing = getOperator(core, 1, 3);
	const element = node as Element;
	if (
		spacing.entry.largeop &&
		context.display &&
		(element.localName === "munder" ||
			element.localName === "mover" ||
			element.localName === "munderover") &&
		box.width > layoutNode(core, context).width
	) {
		return {...spacing, gapBefore: false, gapAfter: false};
	}
	return spacing;
}

function isVerticallyStretchy(
	operator: Operator,
	context: MathContext,
): boolean {
	return (
		context.display &&
		operator.entry.stretchy &&
		hasVerticalPieces(operator.text, context.glyphs)
	);
}

/**
 * A stretchy operator grown to its siblings' rows, and no further: a
 * symmetric fence around a two-row matrix takes two rows, since the
 * blank row symmetry about the baseline would add reads as a gap.
 * minsize and maxsize clamp the height in rows, and a height of one is
 * the plain glyph.
 */
function layoutStretchedOperator(
	element: Element,
	operator: Operator,
	ascent: number,
	descent: number,
	context: MathContext,
): MathBox {
	let height = ascent + descent + 1;
	if (operator.entry.largeop && !context.tight) {
		height = Math.max(
			height,
			getDisplayHeight(operator.text, context.glyphs, context.overline),
		);
	}
	const minsize = parseMathLength(element.getAttribute("minsize"));
	const maxsize = parseMathLength(element.getAttribute("maxsize"));
	if (minsize !== null) {
		height = Math.max(height, Math.round(minsize));
	}
	if (maxsize !== null) {
		height = Math.min(height, Math.max(1, Math.round(maxsize)));
	}
	// Rows minsize adds go half above and half below; a large operator
	// taller than its siblings keeps its own baseline.
	const spare = Math.max(0, height - (ascent + descent + 1));
	const baseline = operator.entry.largeop && spare > 0
		? getLargeOperatorBaseline(operator.text, height)
		: Math.min(ascent + (spare >> 1), height - 1);
	const rows = height > 1
		? buildVerticalGlyph(
			operator.text,
			height,
			baseline,
			context.glyphs,
			context.overline,
		)
		: null;
	if (rows === null) {
		return layoutTextToken(element, operator.text, context);
	}
	return createRowsBox(rows, baseline, getTokenStyle(element, null));
}

function createRowsBox(
	rows: Array<string | GlyphRow>,
	baseline: number,
	style: CellStyle | null,
): MathBox {
	let box: MathBox | null = null;
	for (const row of rows) {
		const line = typeof row === "string"
			? createTextBox(row, style)
			: createTextBox(row.text, {
				...style,
				...(row.underline ? {underline: true} : {}),
				...(row.overline ? {overline: true} : {}),
			});
		box = box === null ? line : stack(box, line, "left", 0);
	}
	return {...box!, baseline};
}

// Writes `top` over `base` at a cell offset, on copies of the rows it
// touches. Both boxes' cells in the overlap must be one cell wide.
function overlay(base: MathBox, top: MathBox, x: number, y: number): MathBox {
	const cells = base.cells.slice();
	for (let row = 0; row < top.height; row++) {
		const target = cells[y + row].slice();
		let column = 0;
		let index = 0;
		while (index < target.length && column < x) {
			column += target[index].width;
			index++;
		}
		for (const cell of top.cells[row]) {
			target[index++] = cell;
		}
		cells[y + row] = target;
	}
	return {...base, cells};
}

const COMBINING_OVER: Record<string, string> = {
	"¯": "̄",
	"‾": "̄",
	ˉ: "̄",
	"−": "̄",
	"-": "̄",
	_: "̄",
	"^": "̂",
	ˆ: "̂",
	"˙": "̇",
	".": "̇",
	"¨": "̈",
	"→": "⃗",
	"⃗": "⃗",
	"~": "̃",
	"˜": "̃",
	"˘": "̆",
	ˇ: "̌",
	"´": "́",
	"`": "̀",
	"˚": "̊",
};

const COMBINING_UNDER: Record<string, string> = {
	_: "̲",
	"‾": "̲",
	"¯": "̲",
	"−": "̲",
	"-": "̲",
	".": "̣",
	"˙": "̣",
	"¨": "̤",
};

/**
 * A radical. Display mode draws an overline over the radicand, a radical
 * sign on the baseline and a climb up the rows between; an mroot's index
 * ends on the row above the sign, overlapping the climb column. Inline
 * mode writes √(x), with the index as a superscript when it has one.
 */
function layoutRadical(element: Element, context: MathContext): MathBox {
	const children = getLayoutChildren(element);
	const isRoot = element.localName === "mroot";
	const radicand = isRoot
		? layoutChild(children[0], context)
		: layoutRow(children, element, context);
	const index = isRoot
		? layoutChild(children[1], scriptContext(context))
		: null;
	if (!context.display) {
		const body = beside(
			beside(createTextBox("(", null), radicand),
			createTextBox(")", null),
		);
		const sign = createTextBox(toPlainGlyphs("√", context.glyphs), null);
		if (index === null) {
			return beside(sign, body);
		}
		const indexCharacters = toScriptCharacters(index, "sup", context);
		if (indexCharacters !== null) {
			return beside(beside(indexCharacters, sign), body);
		}
		return beside(
			beside(
				beside(createTextBox("root(", null), index),
				createTextBox(", ", null),
			),
			beside(radicand, createTextBox(")", null)),
		);
	}
	const {foot, stem, bar, shape} = getRadical(context.glyphs);
	const height = radicand.height;
	const signWidth = shape === "rises" ? 1 : shape === "climbs" ? height + 1 : 2;
	const rows: string[] = [];
	for (let row = 0; row < height; row++) {
		const last = row === height - 1;
		const column = shape === "rises"
			? 0
			: shape === "climbs" ? height - row : 1;
		const cells = Array.from({length: signWidth}, () => " ");
		if (last) {
			cells[0] = foot;
		}
		if (!(last && shape === "rises")) {
			cells[column] = stem;
		}
		rows.push(cells.join(""));
	}
	// The bar starts where the stem's top will meet it.
	const barStart = shape === "stands" ? 1 : signWidth;
	const column = createRowsBox(rows, radicand.baseline, null);
	const body = beside(column, radicand);
	// An overline along the radicand's top row needs no row of its own.
	let result: MathBox;
	if (bar === null && context.overline) {
		result = overlineRow(body, 0, barStart);
	} else {
		const overline = bar === null
			? beside(
				createTextBox(" ".repeat(barStart), null),
				createTextBox(" ".repeat(radicand.width + signWidth - barStart), {
					underline: true,
				}),
			)
			: createTextBox(" ".repeat(barStart) + bar.repeat(radicand.width), null);
		result = stack(overline, body, "left", body.baseline + 1);
	}
	if (index === null) {
		return result;
	}
	// The index is a superscript before the sign when it has the
	// characters, and otherwise sits above the sign.
	const superscript = toScriptCharacters(index, "sup", context);
	if (superscript !== null) {
		return beside(superscript, result);
	}
	// The index ends where the bar begins.
	const room = barStart;
	const shift = Math.max(0, index.width - room);
	result = pad(result, 0, 0, 0, shift);
	let top = result.baseline - index.height;
	if (top < 0) {
		result = pad(result, -top, 0, 0, 0);
		top = 0;
	}
	return overlay(result, index, shift + room - index.width, top);
}

/**
 * Under- and over-scripts. Display mode stacks them, centered on the
 * widest; an accent on a one-cell base becomes a combining mark, and a
 * stretchy accent or arrow over a wider base repeats its filler. Inline
 * mode writes them as scripts, which is how limits on ∑ and ∫ read on
 * one line.
 */
function layoutUnderOver(element: Element, context: MathContext): MathBox {
	const children = getLayoutChildren(element);
	const kind = element.localName;
	let underNode = kind === "mover" ? undefined : children[1];
	let overNode = kind === "mover"
		? children[1]
		: kind === "munderover" ? children[2] : undefined;
	let result = layoutChild(children[0], context);
	if (overNode !== undefined) {
		const combined = combineAccent(
			result,
			overNode,
			"over",
			element.getAttribute("accent"),
			context,
		);
		if (combined !== null) {
			result = combined;
			overNode = undefined;
		}
	}
	if (underNode !== undefined) {
		const combined = combineAccent(
			result,
			underNode,
			"under",
			element.getAttribute("accentunder"),
			context,
		);
		if (combined !== null) {
			result = combined;
			underNode = undefined;
		}
	}
	const scripts = scriptContext(context);
	if (!context.display) {
		return attachScripts(
			result,
			underNode === undefined ? null : layoutNode(underNode, scripts),
			overNode === undefined ? null : layoutNode(overNode, scripts),
			underNode,
			overNode,
			context,
		);
	}
	// A bar over or under a wider base is a line on the base's edge, as a
	// radical's is: an underline, an overline where the terminal draws
	// one, or an underlined blank row above where it does not. The ASCII
	// set is characters only, and draws its bars as rows of dashes.
	const edges = context.glyphs !== "ascii";
	if (edges && overNode !== undefined && isBarAccent(overNode)) {
		result = context.overline
			? overlineRow(result, 0, 0)
			: stack(
				createTextBox(" ".repeat(result.width), {underline: true}),
				result,
				"left",
				result.baseline + 1,
			);
		overNode = undefined;
	}
	if (edges && underNode !== undefined && isBarAccent(underNode)) {
		result = underlineRow(result, result.height - 1, 0);
		underNode = undefined;
	}
	const over = overNode === undefined
		? null
		: layoutUnderOverScript(result, overNode, scripts);
	const under = underNode === undefined
		? null
		: layoutUnderOverScript(result, underNode, scripts);
	// A stretchy base, as the arrow under \xrightarrow's label, reaches
	// across its limits and to its minsize.
	result = stretchAcross(
		children[0],
		result,
		Math.max(over?.width ?? 0, under?.width ?? 0),
		context,
	);
	if (over !== null) {
		result = attachUnderOver(result, over, "over");
	}
	if (under !== null) {
		result = attachUnderOver(result, under, "under");
	}
	return result;
}

function stretchAcross(
	node: Node | undefined,
	base: MathBox,
	width: number,
	context: MathContext,
): MathBox {
	if (node === undefined || !isOperatorElement(node)) {
		return base;
	}
	const element = node as Element;
	const text = collapseTokenText(element.textContent ?? "");
	const entry = lookupOperator(text, "infix");
	if (
		!readFlag(element, "stretchy", entry.stretchy) ||
		!hasHorizontalPieces(text, context.glyphs)
	) {
		return base;
	}
	const minsize = parseMathLength(element.getAttribute("minsize"));
	const target = Math.max(base.width, width, Math.round(minsize ?? 0));
	if (target <= base.width) {
		return base;
	}
	return createTextBox(
		buildHorizontalGlyph(text, target, context.glyphs)!,
		getTokenStyle(element, null),
	);
}

function getAccentOperator(
	node: Node,
): {text: string; entry: OperatorEntry} | null {
	if (!isOperatorElement(node)) {
		return null;
	}
	const text = collapseTokenText((node as Element).textContent ?? "");
	return {text, entry: lookupOperator(text, "postfix")};
}

// An accent on a one-cell base as that cell with a combining mark, or
// null when the accent has no mark, the base is wider, or the width
// tables say the terminal would give the mark a cell of its own.
function combineAccent(
	base: MathBox,
	node: Node,
	side: "over" | "under",
	accentAttribute: string | null,
	context: MathContext,
): MathBox | null {
	const operator = getAccentOperator(node);
	const accentFlag = accentAttribute?.trim().toLowerCase();
	const accent =
		accentFlag === "true" ||
		(accentFlag !== "false" && operator !== null && operator.entry.accent);
	if (
		!accent ||
		operator === null ||
		context.glyphs === "ascii" ||
		base.height !== 1 ||
		base.cells[0].length !== 1
	) {
		return null;
	}
	const mark = (side === "over" ? COMBINING_OVER : COMBINING_UNDER)[
		operator.text
	];
	const cell = base.cells[0][0];
	if (mark === undefined || getStringWidth(cell.text + mark) !== cell.width) {
		return null;
	}
	return {...base, cells: [[{...cell, text: cell.text + mark}]]};
}

// A limit's box: a stretchy operator, as a brace, spans the base.
function layoutUnderOverScript(
	base: MathBox,
	node: Node,
	context: MathContext,
): MathBox {
	const operator = getAccentOperator(node);
	const stretchy =
		operator !== null &&
		readFlag(node as Element, "stretchy", operator.entry.stretchy) &&
		hasHorizontalPieces(operator.text, context.glyphs);
	return stretchy && base.width > 1
		? createTextBox(
			buildHorizontalGlyph(operator!.text, base.width, context.glyphs)!,
			getTokenStyle(node as Element, null),
		)
		: layoutNode(node, context);
}

function attachUnderOver(
	base: MathBox,
	script: MathBox,
	side: "over" | "under",
): MathBox {
	if (side === "over" && script.height === 1 && hasBarOnTop(base)) {
		return setOnBar(base, script);
	}
	return side === "over"
		? stack(script, base, "center", base.baseline + script.height)
		: stack(base, script, "center", base.baseline);
}

// A drawn sum's top row is blank and underlined: a bar with room on it.
function hasBarOnTop(box: MathBox): boolean {
	return (
		box.height > 1 &&
		box.cells[0].every((cell) => cell.text === " " && cell.style?.underline)
	);
}

// The upper limit sits on the bar row, underlined where the bar runs,
// so the bar is drawn under it and the sum keeps its height.
function setOnBar(base: MathBox, script: MathBox): MathBox {
	const width = Math.max(base.width, script.width);
	const wide = widenBox(base, width, "center");
	const limit = widenBox(script, width, "center");
	const top = wide.cells[0].map((cell, index) => {
		const over = limit.cells[0][index];
		if (over.text === " " && over.style == null) {
			return cell;
		}
		return cell.style?.underline
			? {...over, style: {...over.style, underline: true}}
			: over;
	});
	return {...wide, cells: [top, ...wide.cells.slice(1)]};
}

/**
 * The one-line text of a <math> element, for innerText and clipboard
 * copies. An annotation is display: none by the user agent's sheet, so
 * it is no more part of the text than in a browser.
 */
export function linearizeMath(element: Element): string {
	const box = layoutMath(element, false);
	return getBoxText(box).join("\n").trim();
}

const SUPERSCRIPTS: Record<string, string> = {
	0: "⁰",
	1: "¹",
	2: "²",
	3: "³",
	4: "⁴",
	5: "⁵",
	6: "⁶",
	7: "⁷",
	8: "⁸",
	9: "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	" ": " ",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	A: "ᴬ",
	B: "ᴮ",
	D: "ᴰ",
	E: "ᴱ",
	G: "ᴳ",
	H: "ᴴ",
	I: "ᴵ",
	J: "ᴶ",
	K: "ᴷ",
	L: "ᴸ",
	M: "ᴹ",
	N: "ᴺ",
	O: "ᴼ",
	P: "ᴾ",
	R: "ᴿ",
	T: "ᵀ",
	U: "ᵁ",
	V: "ⱽ",
	W: "ᵂ",
	β: "ᵝ",
	γ: "ᵞ",
	δ: "ᵟ",
	θ: "ᶿ",
	φ: "ᵠ",
	χ: "ᵡ",
};

const SUBSCRIPTS: Record<string, string> = {
	0: "₀",
	1: "₁",
	2: "₂",
	3: "₃",
	4: "₄",
	5: "₅",
	6: "₆",
	7: "₇",
	8: "₈",
	9: "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	" ": " ",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
	β: "ᵦ",
	γ: "ᵧ",
	ρ: "ᵨ",
	φ: "ᵩ",
	χ: "ᵪ",
};

// Elements whose one-line form reads as a unit without parentheses when
// it is one side of a linearized fraction (x²/2, √x/2).
const FRACTION_UNITS = new Set([
	"mi",
	"mn",
	"mo",
	"mtext",
	"ms",
	"msub",
	"msup",
	"msubsup",
	"msqrt",
	"mroot",
]);

// The same for a linearized script: only a number (x^10), since x^ab
// would read as x^a b.
const SCRIPT_UNITS = new Set(["mn"]);

function layoutChild(node: Node | undefined, context: MathContext): MathBox {
	return node === undefined ? createEmptyBox(1) : layoutNode(node, context);
}

// The base of scripts, which is nothing at all when it is an empty
// mrow, as KaTeX writes a prescript's.
function layoutBase(node: Node | undefined, context: MathContext): MathBox {
	return node !== undefined &&
		isMathElement(node) &&
		(node as Element).localName === "mrow" &&
		getLayoutChildren(node as Element).length === 0
		? createEmptyBox(0)
		: layoutChild(node, context);
}

function scriptContext(context: MathContext): MathContext {
	return context.tight ? context : {...context, tight: true};
}

/**
 * A one-row script as Unicode superscript or subscript characters, or
 * null when any grapheme in it has no such form. The ASCII set has none.
 */
function toScriptCharacters(
	box: MathBox,
	kind: "sub" | "sup",
	context: MathContext,
): MathBox | null {
	if (box.height !== 1 || box.width === 0 || context.glyphs === "ascii") {
		return null;
	}
	const table = kind === "sup" ? SUPERSCRIPTS : SUBSCRIPTS;
	const cells: MathCell[] = [];
	let width = 0;
	for (const cell of box.cells[0]) {
		const mapped = table[cell.text];
		if (mapped === undefined) {
			return null;
		}
		const cellWidth = Math.max(1, getStringWidth(mapped));
		cells.push({text: mapped, width: cellWidth, style: cell.style});
		width += cellWidth;
	}
	return {width, height: 1, baseline: 0, cells: [cells]};
}

function parenthesize(
	box: MathBox,
	node: Node | undefined,
	units: Set<string>,
): MathBox {
	if (
		box.width <= 1 ||
		(node !== undefined &&
			node.nodeType === node.ELEMENT_NODE &&
			units.has((node as Element).localName))
	) {
		return box;
	}
	return beside(
		beside(createTextBox("(", null), box),
		createTextBox(")", null),
	);
}

// The rows a shifted script pair occupies beside the base: the
// superscript ends on the row above the baseline, the subscript starts
// on the row below, and the baseline row between them is empty.
function buildScriptColumn(
	sub: MathBox | null,
	sup: MathBox | null,
	align: Alignment,
): MathBox {
	let column = createEmptyBox(Math.max(sub?.width ?? 0, sup?.width ?? 0, 1));
	if (sup !== null) {
		column = stack(sup, column, align, sup.height);
	}
	if (sub !== null) {
		column = stack(column, sub, align, column.baseline);
	}
	return column;
}

/**
 * Scripts on a base. Unicode script characters follow the base on its
 * own row whenever the script has them, subscript before superscript.
 * Otherwise display mode shifts the script a row up or down beside the
 * base, and inline mode spells it ^(…) or _(…).
 */
function attachScripts(
	base: MathBox,
	sub: MathBox | null,
	sup: MathBox | null,
	subNode: Node | undefined,
	supNode: Node | undefined,
	context: MathContext,
	pre = false,
): MathBox {
	const subCharacters = sub && toScriptCharacters(sub, "sub", context);
	const supCharacters = sup && toScriptCharacters(sup, "sup", context);
	const shiftedSub = subCharacters ? null : sub;
	const shiftedSup = supCharacters ? null : sup;
	const joinTo = (box: MathBox, part: MathBox): MathBox =>
		pre ? beside(part, box) : beside(box, part);
	let result = base;
	if (!pre && base.height > 1 && (subCharacters || supCharacters)) {
		// Beside a tall base the superscript takes its top row and the
		// subscript its bottom row, as they do on a fence in print.
		let column = createEmptyBox(
			Math.max(subCharacters?.width ?? 0, supCharacters?.width ?? 0),
			base.height,
			base.baseline,
		);
		if (supCharacters) {
			column = overlay(column, supCharacters, 0, 0);
		}
		if (subCharacters) {
			column = overlay(column, subCharacters, 0, base.height - 1);
		}
		result = beside(result, column);
	} else if (pre) {
		if (subCharacters) {
			result = beside(subCharacters, result);
		}
		if (supCharacters) {
			result = beside(supCharacters, result);
		}
	} else {
		if (subCharacters) {
			result = beside(result, subCharacters);
		}
		if (supCharacters) {
			result = beside(result, supCharacters);
		}
	}
	if (shiftedSub === null && shiftedSup === null) {
		return result;
	}
	if (context.display) {
		return joinTo(
			result,
			buildScriptColumn(shiftedSub, shiftedSup, pre ? "right" : "left"),
		);
	}
	if (shiftedSub !== null) {
		result = joinTo(
			result,
			beside(
				createTextBox("_", null),
				parenthesize(shiftedSub, subNode, SCRIPT_UNITS),
			),
		);
	}
	if (shiftedSup !== null) {
		result = joinTo(
			result,
			beside(
				createTextBox("^", null),
				parenthesize(shiftedSup, supNode, SCRIPT_UNITS),
			),
		);
	}
	return result;
}

function layoutScriptElement(element: Element, context: MathContext): MathBox {
	const children = getLayoutChildren(element);
	const base = layoutBase(children[0], context);
	const subNode = element.localName === "msup" ? undefined : children[1];
	const supNode = element.localName === "msup"
		? children[1]
		: element.localName === "msubsup" ? children[2] : undefined;
	return attachScripts(
		base,
		subNode === undefined ? null : layoutNode(subNode, scriptContext(context)),
		supNode === undefined ? null : layoutNode(supNode, scriptContext(context)),
		subNode,
		supNode,
		context,
	);
}

function isEmptyScript(node: Node | undefined): boolean {
	return (
		node === undefined ||
		(isMathElement(node) && (node as Element).localName === "none")
	);
}

function layoutMultiscripts(element: Element, context: MathContext): MathBox {
	const children = getLayoutChildren(element);
	let result = layoutChild(children[0], context);
	const pairs: Array<[Node | undefined, Node | undefined, boolean]> = [];
	let pre = false;
	for (let index = 1; index < children.length; index++) {
		const node = children[index];
		if (isMathElement(node) && (node as Element).localName === "mprescripts") {
			pre = true;
			continue;
		}
		pairs.push([node, children[index + 1], pre]);
		index++;
	}
	for (const [subNode, supNode, isPre] of pairs) {
		result = attachScripts(
			result,
			isEmptyScript(subNode)
				? null
				: layoutNode(subNode!, scriptContext(context)),
			isEmptyScript(supNode)
				? null
				: layoutNode(supNode!, scriptContext(context)),
			subNode,
			supNode,
			context,
			isPre,
		);
	}
	return result;
}

function parseAlignment(value: string | null, fallback: Alignment): Alignment {
	const text = value?.trim().toLowerCase();
	return text === "left" || text === "right" || text === "center"
		? text
		: fallback;
}

/**
 * A fraction. In display mode the numerator and denominator stack over a
 * bar one cell wider than either on each side, and the bar row is the
 * baseline. Inline mode writes a/b, with a side in parentheses when it
 * is more than one cell and not self-delimiting.
 */
function layoutFraction(element: Element, context: MathContext): MathBox {
	const children = getLayoutChildren(element);
	const numerator = layoutChild(children[0], context);
	const denominator = layoutChild(children[1], context);
	if (!context.display) {
		return beside(
			beside(
				parenthesize(numerator, children[0], FRACTION_UNITS),
				createTextBox("/", null),
			),
			parenthesize(denominator, children[1], FRACTION_UNITS),
		);
	}
	// A cell of bar on each side of the wider operand, not counting a
	// negation sign, which hangs into that cell so its operand centers.
	const width =
		Math.max(
			numerator.width - (numerator.hang ?? 0),
			denominator.width - (denominator.hang ?? 0),
		) + 2;
	const thickness = parseMathLength(element.getAttribute("linethickness"));
	const numalign = parseAlignment(element.getAttribute("numalign"), "center");
	const denomalign = parseAlignment(
		element.getAttribute("denomalign"),
		"center",
	);
	const top = placeInWidth(numerator, width, numalign);
	const bottom = placeInWidth(denominator, width, denomalign);
	// The bar is a row of its own, and what stands beside the fraction
	// sits on it, centered between the two operands. linethickness 0
	// leaves the row empty.
	const bar = thickness === 0
		? createEmptyBox(width)
		: createTextBox(getFractionBar(context.glyphs).repeat(width), null);
	const barred = stack(top, bar, "left", top.height);
	return stack(barred, bottom, "left", barred.baseline);
}

// A box in a field, centered by its operand with a negation sign
// hanging to the left of it.
function placeInWidth(
	box: MathBox,
	width: number,
	align: Alignment,
	room = 0,
): MathBox {
	const extra = width - box.width;
	if (extra < 0) {
		return box;
	}
	// The field's first `room` cells are for hanging signs, so the
	// operands of a column line up whether or not each has one.
	const hang = box.hang ?? 0;
	const left = align === "right"
		? extra
		: Math.max(
			0,
			room -
				hang +
				(align === "left" ? 0 : (width - room - (box.width - hang)) >> 1),
		);
	return pad(box, 0, extra - left, 0, left);
}

function overlineRow(box: MathBox, row: number, from: number): MathBox {
	return decorateRow(box, row, from, "overline");
}

function underlineRow(box: MathBox, row: number, from: number): MathBox {
	return decorateRow(box, row, from, "underline");
}

function decorateRow(
	box: MathBox,
	row: number,
	from: number,
	line: "underline" | "overline",
): MathBox {
	let column = 0;
	const cells = box.cells[row].map((cell) => {
		const start = column;
		column += cell.width;
		return start < from
			? cell
			: {...cell, style: {...cell.style, [line]: true}};
	});
	return {...box, cells: box.cells.map((r, i) => (i === row ? cells : r))};
}

// An mo that is a bar: the accents \overline and \underline write.
function isBarAccent(node: Node): boolean {
	if (!isOperatorElement(node)) {
		return false;
	}
	const text = collapseTokenText((node as Element).textContent ?? "");
	return BAR_ACCENTS.has(text);
}

type RowAlignment = "top" | "center" | "bottom" | "baseline";

interface TableCell {
	box: MathBox;
	align: Alignment;
	rowAlign: RowAlignment;
}

function readKeyword(
	element: Element | null,
	name: string,
): string | undefined {
	const value = element === null ? null : element.getAttribute(name);
	return value === null ? undefined : value.trim().toLowerCase();
}

function parseList(value: string | null): string[] {
	return value === null ? [] : value.trim().toLowerCase().split(/\s+/);
}

// The nth entry of a space-separated attribute list, with the last
// entry repeating past the end.
function pickListValue(list: string[], index: number): string | undefined {
	return list.length === 0 ? undefined : list[Math.min(index, list.length - 1)];
}

function parseRowAlignment(
	value: string | undefined,
	fallback: RowAlignment,
): RowAlignment {
	switch (value) {
		case "top":
		case "center":
		case "bottom":
		case "baseline":
			return value;
		case "axis":
			return "baseline";
		default:
			return fallback;
	}
}

function isLineValue(value: string | undefined): boolean {
	return value === "solid" || value === "dashed";
}

function frameBox(
	box: MathBox,
	lines: BoxLines,
	style: CellStyle | null,
): MathBox {
	const top = createTextBox(
		lines.topLeft + lines.horizontal.repeat(box.width) + lines.topRight,
		style,
	);
	const bottom = createTextBox(
		lines.bottomLeft + lines.horizontal.repeat(box.width) + lines.bottomRight,
		style,
	);
	const side = createRowsBox(
		new Array<string>(box.height).fill(lines.vertical),
		box.baseline,
		style,
	);
	const body = beside(beside(side, box), side);
	return stack(stack(top, body, "left", 0), bottom, "left", body.baseline + 1);
}

function getTableRows(
	element: Element,
): Array<{row: Element | null; cells: Node[]}> {
	const rows: Array<{row: Element | null; cells: Node[]}> = [];
	for (const child of getLayoutChildren(element)) {
		const name = isMathElement(child) ? (child as Element).localName : "";
		if (name === "mtr" || name === "mlabeledtr") {
			const cells = getLayoutChildren(child as Element);
			rows.push({
				row: child as Element,
				cells: name === "mlabeledtr" ? cells.slice(1) : cells,
			});
		} else {
			rows.push({row: null, cells: [child]});
		}
	}
	return rows;
}

/**
 * A table. Columns take their widest cell; cells center by default and
 * rows align on their tallest cell's baseline. One cell separates
 * columns and no row separates rows unless columnspacing or rowspacing
 * says otherwise, and frame, rowlines and columnlines draw box-drawing
 * rules. The table's baseline is its center row. Inline mode joins
 * cells with commas and rows with semicolons.
 */
function layoutTable(element: Element, context: MathContext): MathBox {
	const rows = getTableRows(element);
	if (rows.length === 0) {
		return createEmptyBox(1);
	}
	if (!context.display) {
		let result: MathBox | null = null;
		for (const {cells} of rows) {
			let line: MathBox | null = null;
			for (const cell of cells) {
				const box = layoutNode(cell, context);
				line = line === null
					? box
					: beside(beside(line, createTextBox(", ", null)), box);
			}
			line ??= createEmptyBox(1);
			result = result === null
				? line
				: beside(beside(result, createTextBox("; ", null)), line);
		}
		return result!;
	}
	const columnAligns = parseList(element.getAttribute("columnalign"));
	const rowAligns = parseList(element.getAttribute("rowalign"));
	const grid: TableCell[][] = rows.map(({row, cells}, rowIndex) => {
		const rowColumnAligns = row === null
			? []
			: parseList(row.getAttribute("columnalign"));
		const rowAlign = parseRowAlignment(
			readKeyword(row, "rowalign") ?? pickListValue(rowAligns, rowIndex),
			"baseline",
		);
		return cells.map((cell, columnIndex) => {
			const own = isMathElement(cell) ? (cell as Element) : null;
			return {
				box: layoutNode(cell, context),
				align: parseAlignment(
					own?.getAttribute("columnalign") ??
					pickListValue(rowColumnAligns, columnIndex) ??
					pickListValue(columnAligns, columnIndex) ??
					null,
					"center",
				),
				rowAlign: parseRowAlignment(readKeyword(own, "rowalign"), rowAlign),
			};
		});
	});
	const columnCount = Math.max(...grid.map((row) => row.length));
	// A column is as wide as its widest operand plus the widest hanging
	// sign, so the operands line up down the column.
	const columnWidths = new Array<number>(columnCount).fill(0);
	const columnHangs = new Array<number>(columnCount).fill(0);
	for (const row of grid) {
		row.forEach((cell, index) => {
			const hang = cell.box.hang ?? 0;
			columnWidths[index] = Math.max(
				columnWidths[index],
				cell.box.width - hang,
			);
			columnHangs[index] = Math.max(columnHangs[index], hang);
		});
	}
	for (let index = 0; index < columnCount; index++) {
		columnWidths[index] += columnHangs[index];
	}
	const lines = getBoxLines(context.glyphs);
	const columnSpacing = Math.max(
		0,
		Math.round(parseMathLength(element.getAttribute("columnspacing")) ?? 1),
	);
	const rowSpacing = Math.max(
		0,
		Math.round(parseMathLength(element.getAttribute("rowspacing")) ?? 0),
	);
	const columnLines = parseList(element.getAttribute("columnlines"));
	const rowLines = parseList(element.getAttribute("rowlines"));
	const framed = isLineValue(
		element.getAttribute("frame")?.trim().toLowerCase(),
	);

	// The columns where a vertical rule runs, for the rule rows to cross.
	const ruleColumns: number[] = [];
	const rowBoxes = grid.map((row) => {
		const ascent = Math.max(
			0,
			...row.map((cell) =>
				cell.rowAlign === "baseline" ? cell.box.baseline : 0,
			),
		);
		const descent = Math.max(
			0,
			...row.map((cell) =>
				cell.rowAlign === "baseline" ? getDescent(cell.box) : 0,
			),
		);
		let height = ascent + descent + 1;
		for (const cell of row) {
			height = Math.max(height, cell.box.height);
		}
		let rowBox: MathBox | null = null;
		for (let column = 0; column < columnCount; column++) {
			const cell = row[column];
			let box = cell
				? placeInWidth(
					cell.box,
					columnWidths[column],
					cell.align,
					columnHangs[column],
				)
				: createEmptyBox(columnWidths[column]);
			box = alignInRow(box, cell?.rowAlign ?? "baseline", ascent, height);
			if (rowBox === null) {
				rowBox = box;
			} else {
				const ruled = isLineValue(pickListValue(columnLines, column - 1));
				if (ruled) {
					if (ruleColumns.length < columnCount - 1) {
						ruleColumns.push(rowBox.width + Math.max(0, columnSpacing - 1));
					}
					rowBox = beside(
						beside(rowBox, createEmptyBox(1), Math.max(0, columnSpacing - 1)),
						box,
					);
				} else {
					rowBox = beside(rowBox, box, columnSpacing);
				}
			}
		}
		return rowBox ?? createEmptyBox(1);
	});
	const width = Math.max(...rowBoxes.map((row) => row.width));
	const ruleRow = (): MathBox => {
		let text = "";
		for (let x = 0; x < width; x++) {
			text += ruleColumns.includes(x) ? lines.cross : lines.horizontal;
		}
		return createTextBox(text, null);
	};
	let result: MathBox | null = null;
	rowBoxes.forEach((rowBox, index) => {
		const ruled = drawVerticalRules(rowBox, ruleColumns, lines);
		if (result === null) {
			result = ruled;
			return;
		}
		if (isLineValue(pickListValue(rowLines, index - 1))) {
			result = stack(result, ruleRow(), "left", 0);
			if (rowSpacing > 1) {
				result = pad(result, 0, 0, rowSpacing - 1, 0);
			}
		} else if (rowSpacing > 0) {
			result = pad(result, 0, 0, rowSpacing, 0);
		}
		result = stack(result, ruled, "left", 0);
	});
	let table = result!;
	if (framed) {
		table = frameTable(table, ruleColumns, lines);
	}
	const align = element.getAttribute("align")?.trim().toLowerCase();
	const baseline = align === "top"
		? 0
		: align === "bottom" ? table.height - 1 : (table.height - 1) >> 1;
	return {...table, baseline};
}

function widenBox(box: MathBox, width: number, align: Alignment): MathBox {
	return {...box, width, cells: widenRows(box, width, align)};
}

function alignInRow(
	box: MathBox,
	align: RowAlignment,
	ascent: number,
	height: number,
): MathBox {
	const spare = height - box.height;
	if (align === "baseline") {
		const top = Math.min(Math.max(0, ascent - box.baseline), spare);
		return pad(box, top, 0, spare - top, 0);
	}
	const top = align === "top" ? 0 : align === "bottom" ? spare : spare >> 1;
	return pad(box, top, 0, spare - top, 0);
}

function drawVerticalRules(
	row: MathBox,
	columns: number[],
	lines: BoxLines,
): MathBox {
	if (columns.length === 0) {
		return row;
	}
	const rule = createTextBox(lines.vertical, null);
	let result = row;
	for (const x of columns) {
		for (let y = 0; y < row.height; y++) {
			result = overlay(result, rule, x, y);
		}
	}
	return result;
}

function frameTable(
	table: MathBox,
	columns: number[],
	lines: BoxLines,
): MathBox {
	const edge = (join: string, left: string, right: string): MathBox => {
		let text = left;
		for (let x = 0; x < table.width; x++) {
			text += columns.includes(x) ? join : lines.horizontal;
		}
		return createTextBox(text + right, null);
	};
	const side = createRowsBox(
		new Array<string>(table.height).fill(lines.vertical),
		table.baseline,
		null,
	);
	let body = beside(beside(side, table), side);
	for (let y = 0; y < table.height; y++) {
		if (table.cells[y][0]?.text === lines.horizontal) {
			body = overlay(body, createTextBox(lines.leftJoin, null), 0, y);
			body = overlay(
				body,
				createTextBox(lines.rightJoin, null),
				table.width + 1,
				y,
			);
		}
	}
	return stack(
		stack(edge(lines.topJoin, lines.topLeft, lines.topRight), body, "left", 0),
		edge(lines.bottomJoin, lines.bottomLeft, lines.bottomRight),
		"left",
		0,
	);
}

/**
 * mpadded's width, height, depth and lspace grow the box (a value below
 * the content's size leaves it as it is). A leading + or - adjusts the
 * content's own measure. height and depth are rows above and below the
 * baseline and apply in display mode only.
 */
function layoutPadded(element: Element, context: MathContext): MathBox {
	const box = layoutRow(getLayoutChildren(element), element, context);
	const resolve = (name: string, current: number): number => {
		const raw = element.getAttribute(name);
		const value = parseMathLength(raw);
		if (raw === null || value === null) {
			return current;
		}
		// An adjustment of less than a cell, the padding TeX puts around
		// an arrow's label, is no cell.
		const adjusts = /^\s*[+-]/.test(raw);
		return Math.max(
			current,
			adjusts ? current + Math.trunc(value) : Math.round(value),
		);
	};
	const left = Math.max(
		0,
		Math.round(parseMathLength(element.getAttribute("lspace")) ?? 0),
	);
	const width = resolve("width", box.width + left);
	const ascent = context.display
		? resolve("height", box.baseline + 1)
		: box.baseline + 1;
	const descent = context.display
		? resolve("depth", getDescent(box))
		: getDescent(box);
	return pad(
		box,
		ascent - box.baseline - 1,
		Math.max(0, width - box.width - left),
		descent - getDescent(box),
		left,
	);
}

function blankOut(box: MathBox): MathBox {
	return {
		...box,
		cells: box.cells.map((row) =>
			row.map((cell) => ({
				text: " ".repeat(cell.width),
				width: cell.width,
				style: null,
			})),
		),
	};
}

// A red border around the content in display mode. Inline mode has no
// rows for a border, so the content is red instead.
function layoutError(element: Element, context: MathContext): MathBox {
	const box = layoutRow(getLayoutChildren(element), element, context);
	const red: CellStyle = {fg: CSSValues.cssColorToNumber("red")};
	if (!context.display) {
		return {
			...box,
			cells: box.cells.map((row) =>
				row.map((cell) => ({...cell, style: {...cell.style, ...red}})),
			),
		};
	}
	return frameBox(box, getBoxLines(context.glyphs), red);
}
