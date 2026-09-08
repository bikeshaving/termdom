import * as CSSTree from "css-tree";

import {
	CSS_INITIAL_VALUES,
	CSS_PROPERTIES,
	CSS_RESET_ONLY_LONGHANDS,
	CSS_SHORTHANDS,
} from "../generated/cssproperties.ts";
import {
	compileSelector,
	getChildren,
	isLegacyPseudoElement,
	parseSelectorList,
	pseudoName,
} from "./selectors.ts";
import type {CompiledSelector, SelectorNamespaces} from "./selectors.ts";

type Unit = "undefined" | "cell" | "percent" | "auto";

/**
 * A length as the layout solver stores it. NaN is the number for
 * `undefined` and `auto`, whose unit carries the whole meaning.
 */
export interface Value {
	unit: Unit;
	value: number;
}

const CSS_WIDE_KEYWORDS = new Set([
	"inherit",
	"initial",
	"revert",
	"revert-layer",
	"unset",
]);

export function isCSSWideKeyword(value: string): boolean {
	return CSS_WIDE_KEYWORDS.has(value);
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

// Value parsing runs during style computation, and a document re-reads
// the same handful of values many times, so each value is parsed once.
const valueNodes = new Map<string, CSSTree.ValueNode[] | null>();

/** A value's top-level nodes, or null if css-tree cannot parse the text. */
function getCSSValueChildren(value: string): CSSTree.ValueNode[] | null {
	let nodes = valueNodes.get(value);
	if (nodes === undefined) {
		try {
			const ast = CSSTree.parse(value, {
				context: "value",
			}) as unknown as CSSTree.ValueNode;
			nodes = ast.children ? ast.children.toArray() : [];
		} catch (_err) {
			nodes = null;
		}
		if (valueNodes.size > 1024) {
			valueNodes.clear();
		}
		valueNodes.set(value, nodes);
	}
	return nodes;
}

// Only a value whose canonical spelling matches the authored text may
// seed the cache. For that value, the sheet's parse is the same parse
// getCSSValueChildren would produce for the key.
function seedValueNodes(value: string, nodes: CSSTree.ValueNode[]): void {
	if (valueNodes.has(value)) {
		return;
	}
	if (valueNodes.size > 1024) {
		valueNodes.clear();
	}
	valueNodes.set(value, nodes);
}

function getSingleValueNode(value: string): CSSTree.ValueNode | undefined {
	const nodes = getCSSValueChildren(value);
	return nodes && nodes.length === 1 ? nodes[0] : undefined;
}

function getFunctionArguments(node: CSSTree.ValueNode): CSSTree.ValueNode[] {
	return (node.children?.toArray() ?? []).filter(
		(child) => child.type !== "Operator",
	);
}

function getCSSTimeMs(token: string): number | null {
	const node = getSingleValueNode(token.trim());
	if (!node || node.type !== "Dimension") {
		return null;
	}
	const unit = (node.unit ?? "").toLowerCase();
	if (unit !== "s" && unit !== "ms") {
		return null;
	}
	const number = parseFloat(node.value ?? "");
	if (!Number.isFinite(number)) {
		return null;
	}
	return unit === "ms" ? number : number * 1000;
}

// Whitespace inside parentheses separates a function's own arguments,
// not components.
function splitComponents(value: string): string[] {
	const components: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		const char = value[i];
		if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth--;
		} else if ((i === value.length || /\s/.test(char)) && depth === 0) {
			const component = value.slice(start, i).trim();
			if (component) {
				components.push(component);
			}
			start = i + 1;
		}
	}
	return components;
}

function splitCommaList(value: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		const char = value[i];
		if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth--;
		} else if ((i === value.length || char === ",") && depth === 0) {
			const item = value.slice(start, i).trim();
			if (item) {
				items.push(item);
			}
			start = i + 1;
		}
	}
	return items;
}

// A declared value in its CSSOM spelling. The property's grammar decides
// the details: a custom property keeps every number as written, a family
// name written as identifiers drops its quotes, and a counter() naming
// the default style drops the argument.
export function serializeCSSValue(input: string, property = ""): string {
	const custom = property.startsWith("--");
	let out = "";
	let space = false;
	const emit = (token: string): void => {
		if (out.endsWith(",")) {
			out += " ";
		} else if (space && out !== "" && !out.endsWith("(")) {
			out += " ";
		}
		space = false;
		out += token;
	};

	for (let i = 0; i < input.length; i++) {
		const character = input[i];
		if (WHITESPACE.has(character)) {
			space = out !== "";
			continue;
		}
		if (character === "/" && input[i + 1] === "*") {
			const end = input.indexOf("*/", i + 2);
			i = end === -1 ? input.length : end + 1;
			space = out !== "";
			continue;
		}
		if (character === '"' || character === "'") {
			const end = endOfString(input, i);
			emit(serializeCSSString(unescapeCSSString(input.slice(i + 1, end))));
			i = end;
			continue;
		}
		if (character === "," || character === ")") {
			out += character;
			space = false;
			continue;
		}
		if (startsNumber(input, i)) {
			const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(
				input.slice(i),
			)![0];
			i += number.length;
			const unit = /^(?:%|[a-zA-Z\u0080-\uFFFF]+)/.exec(input.slice(i))?.[0];
			if (unit) {
				i += unit.length;
			}
			emit(
				(custom ? number : serializeCSSNumber(number)) +
				(unit === "%" ? "%" : (unit?.toLowerCase() ?? "")),
			);
			i--;
			continue;
		}
		if (startsIdentifier(input, i)) {
			const name = /^[a-zA-Z0-9_\u0080-\uFFFF\\-]+/.exec(input.slice(i))![0];
			i += name.length;
			// A url() token's body is not an identifier list. It runs to the
			// closing parenthesis, quoted or not, and serializes quoted.
			if (name.toLowerCase() === "url" && input[i] === "(") {
				const end = input.indexOf(")", i);
				const body = input.slice(i + 1, end === -1 ? input.length : end).trim();
				const url =
					body.startsWith('"') || body.startsWith("'")
						? unescapeCSSString(body.slice(1, -1))
						: unescapeCSSString(body);
				emit(`url(${serializeCSSString(url)})`);
				i = end === -1 ? input.length : end;
				continue;
			}
			emit(name);
			i--;
			continue;
		}
		if (character === "#") {
			const name = /^#[a-zA-Z0-9_\u0080-\uFFFF\\-]*/.exec(input.slice(i))![0];
			emit(name);
			i += name.length - 1;
			continue;
		}
		emit(character);
	}
	return custom ? out : canonicalizeValue(property, out);
}

// "Twisty Tie" and Twisty Tie are the same family. The identifier
// spelling is canonical, so a string that spells a valid identifier
// sequence loses its quotes.
const FAMILY_IDENTIFIERS =
	/^[a-zA-Z_\u0080-\uffff-][\w\u0080-\uffff-]*(?: [a-zA-Z_\u0080-\uffff-][\w\u0080-\uffff-]*)*$/;

const FAMILY_PROPERTIES = new Set(["font", "font-family", "voice-family"]);

// Quoted, each of these names a family with that name. The quotes are
// what distinguish it, so they are kept.
const RESERVED_FAMILY_NAMES = new Set([
	"cursive",
	"default",
	"emoji",
	"fangsong",
	"fantasy",
	"math",
	"monospace",
	"sans-serif",
	"serif",
	"system-ui",
	"ui-monospace",
	"ui-rounded",
	"ui-sans-serif",
	"ui-serif",
]);

const DEFAULT_COUNTER_STYLE = "decimal";

function canonicalizeValue(property: string, value: string): string {
	let out = value;
	if (FAMILY_PROPERTIES.has(property)) {
		out = out.replace(/"((?:[^"\\]|\\.)*)"/g, (quoted, body: string) => {
			const name = unescapeCSSString(body);
			const lower = name.toLowerCase();
			return FAMILY_IDENTIFIERS.test(name) &&
				!CSS_WIDE_KEYWORDS.has(lower) &&
				!RESERVED_FAMILY_NAMES.has(lower)
				? name
				: quoted;
		});
	}
	// `counter(name, decimal)` counts the same as `counter(name)`, and
	// CSSOM writes the shorter form.
	out = out.replace(
		/\b(counters?)\(([^()]*)\)/gi,
		(whole, name: string, args: string) => {
			const parts = args.split(",").map((part) => part.trim());
			const wanted = name.toLowerCase() === "counters" ? 3 : 2;
			if (parts.length !== wanted) {
				return whole;
			}
			if (parts[wanted - 1].toLowerCase() !== DEFAULT_COUNTER_STYLE) {
				return whole;
			}
			return `${name}(${parts.slice(0, wanted - 1).join(", ")})`;
		},
	);
	return out;
}

function endOfString(input: string, start: number): number {
	const quote = input[start];
	for (let i = start + 1; i < input.length; i++) {
		if (input[i] === "\\") {
			i++;
		} else if (input[i] === quote) {
			return i;
		}
	}
	return input.length;
}

function unescapeCSSString(text: string): string {
	return text.replace(/\\(.)/g, "$1");
}

function startsNumber(input: string, index: number): boolean {
	const rest = input.slice(index, index + 3);
	return /^[+-]?(\d|\.\d)/.test(rest);
}

function startsIdentifier(input: string, index: number): boolean {
	return /^[a-zA-Z_\u0080-\uFFFF\\-]/.test(input[index]);
}

// CSSOM: the shortest form that round-trips, with no leading + and no
// negative zero.
function serializeCSSNumber(text: string): string {
	const value = Number(text);
	if (!Number.isFinite(value)) {
		return text;
	}
	if (Object.is(value, -0)) {
		return "0";
	}
	const out = String(value);
	return out.includes("e") ? expandExponential(out) : out;
}

// CSS has no scientific notation, so 1e24 is written with its zeros.
function expandExponential(text: string): string {
	const parts = /^([+-]?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
	if (!parts) {
		return text;
	}
	const [, sign, whole, fraction = "", exponentText] = parts;
	const exponent = Number(exponentText);
	const digits = whole + fraction;
	const point = whole.length + exponent;
	if (point <= 0) {
		return `${sign}0.${"0".repeat(-point)}${digits}`;
	}
	if (point >= digits.length) {
		return `${sign}${digits}${"0".repeat(point - digits.length)}`;
	}
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function serializeCSSString(text: string): string {
	return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

// The same result CSS.escape produces.
// An animation's name is a <custom-ident> or a <string>. The words a
// <custom-ident> excludes (the CSS-wide keywords and `none`, which
// animation-name uses for "no animation") are written as strings.
export function serializeKeyframesName(name: string): string {
	const reserved = name.toLowerCase();
	return CSS_WIDE_KEYWORDS.has(reserved) || reserved === "none"
		? serializeCSSString(name)
		: serializeCSSIdentifier(name);
}

export function serializeCSSIdentifier(value: string): string {
	const text = String(value);
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const character = text[i];
		if (code === 0) {
			out += "�";
		} else if (
			(code >= 0x1 && code <= 0x1f) ||
			code === 0x7f ||
			(i === 0 && code >= 0x30 && code <= 0x39) ||
			(i === 1 && code >= 0x30 && code <= 0x39 && text.charCodeAt(0) === 0x2d)
		) {
			out += `\\${code.toString(16)} `;
		} else if (i === 0 && code === 0x2d && text.length === 1) {
			out += `\\${character}`;
		} else if (
			code >= 0x80 ||
			code === 0x2d ||
			code === 0x5f ||
			(code >= 0x30 && code <= 0x39) ||
			(code >= 0x41 && code <= 0x5a) ||
			(code >= 0x61 && code <= 0x7a)
		) {
			out += character;
		} else {
			out += `\\${character}`;
		}
	}
	return out;
}

// Generated from Bun.color(name, "number"), so this and Bun agree.
const NAMED_COLORS: Record<string, number> = {
	aliceblue: 0xf0f8ff,
	antiquewhite: 0xfaebd7,
	aqua: 0x00ffff,
	aquamarine: 0x7fffd4,
	azure: 0xf0ffff,
	beige: 0xf5f5dc,
	bisque: 0xffe4c4,
	black: 0x000000,
	blanchedalmond: 0xffebcd,
	blue: 0x0000ff,
	blueviolet: 0x8a2be2,
	brown: 0xa52a2a,
	burlywood: 0xdeb887,
	cadetblue: 0x5f9ea0,
	chartreuse: 0x7fff00,
	chocolate: 0xd2691e,
	coral: 0xff7f50,
	cornflowerblue: 0x6495ed,
	cornsilk: 0xfff8dc,
	crimson: 0xdc143c,
	cyan: 0x00ffff,
	darkblue: 0x00008b,
	darkcyan: 0x008b8b,
	darkgoldenrod: 0xb8860b,
	darkgray: 0xa9a9a9,
	darkgreen: 0x006400,
	darkgrey: 0xa9a9a9,
	darkkhaki: 0xbdb76b,
	darkmagenta: 0x8b008b,
	darkolivegreen: 0x556b2f,
	darkorange: 0xff8c00,
	darkorchid: 0x9932cc,
	darkred: 0x8b0000,
	darksalmon: 0xe9967a,
	darkseagreen: 0x8fbc8f,
	darkslateblue: 0x483d8b,
	darkslategray: 0x2f4f4f,
	darkslategrey: 0x2f4f4f,
	darkturquoise: 0x00ced1,
	darkviolet: 0x9400d3,
	deeppink: 0xff1493,
	deepskyblue: 0x00bfff,
	dimgray: 0x696969,
	dimgrey: 0x696969,
	dodgerblue: 0x1e90ff,
	firebrick: 0xb22222,
	floralwhite: 0xfffaf0,
	forestgreen: 0x228b22,
	fuchsia: 0xff00ff,
	gainsboro: 0xdcdcdc,
	ghostwhite: 0xf8f8ff,
	gold: 0xffd700,
	goldenrod: 0xdaa520,
	gray: 0x808080,
	green: 0x008000,
	greenyellow: 0xadff2f,
	grey: 0x808080,
	honeydew: 0xf0fff0,
	hotpink: 0xff69b4,
	indianred: 0xcd5c5c,
	indigo: 0x4b0082,
	ivory: 0xfffff0,
	khaki: 0xf0e68c,
	lavender: 0xe6e6fa,
	lavenderblush: 0xfff0f5,
	lawngreen: 0x7cfc00,
	lemonchiffon: 0xfffacd,
	lightblue: 0xadd8e6,
	lightcoral: 0xf08080,
	lightcyan: 0xe0ffff,
	lightgoldenrodyellow: 0xfafad2,
	lightgray: 0xd3d3d3,
	lightgreen: 0x90ee90,
	lightgrey: 0xd3d3d3,
	lightpink: 0xffb6c1,
	lightsalmon: 0xffa07a,
	lightseagreen: 0x20b2aa,
	lightskyblue: 0x87cefa,
	lightslategray: 0x778899,
	lightslategrey: 0x778899,
	lightsteelblue: 0xb0c4de,
	lightyellow: 0xffffe0,
	lime: 0x00ff00,
	limegreen: 0x32cd32,
	linen: 0xfaf0e6,
	magenta: 0xff00ff,
	maroon: 0x800000,
	mediumaquamarine: 0x66cdaa,
	mediumblue: 0x0000cd,
	mediumorchid: 0xba55d3,
	mediumpurple: 0x9370db,
	mediumseagreen: 0x3cb371,
	mediumslateblue: 0x7b68ee,
	mediumspringgreen: 0x00fa9a,
	mediumturquoise: 0x48d1cc,
	mediumvioletred: 0xc71585,
	midnightblue: 0x191970,
	mintcream: 0xf5fffa,
	mistyrose: 0xffe4e1,
	moccasin: 0xffe4b5,
	navajowhite: 0xffdead,
	navy: 0x000080,
	oldlace: 0xfdf5e6,
	olive: 0x808000,
	olivedrab: 0x6b8e23,
	orange: 0xffa500,
	orangered: 0xff4500,
	orchid: 0xda70d6,
	palegoldenrod: 0xeee8aa,
	palegreen: 0x98fb98,
	paleturquoise: 0xafeeee,
	palevioletred: 0xdb7093,
	papayawhip: 0xffefd5,
	peachpuff: 0xffdab9,
	peru: 0xcd853f,
	pink: 0xffc0cb,
	plum: 0xdda0dd,
	powderblue: 0xb0e0e6,
	purple: 0x800080,
	rebeccapurple: 0x663399,
	red: 0xff0000,
	rosybrown: 0xbc8f8f,
	royalblue: 0x4169e1,
	saddlebrown: 0x8b4513,
	salmon: 0xfa8072,
	sandybrown: 0xf4a460,
	seagreen: 0x2e8b57,
	seashell: 0xfff5ee,
	sienna: 0xa0522d,
	silver: 0xc0c0c0,
	skyblue: 0x87ceeb,
	slateblue: 0x6a5acd,
	slategray: 0x708090,
	slategrey: 0x708090,
	snow: 0xfffafa,
	springgreen: 0x00ff7f,
	steelblue: 0x4682b4,
	tan: 0xd2b48c,
	teal: 0x008080,
	thistle: 0xd8bfd8,
	tomato: 0xff6347,
	transparent: 0x000000,
	turquoise: 0x40e0d0,
	violet: 0xee82ee,
	wheat: 0xf5deb3,
	white: 0xffffff,
	whitesmoke: 0xf5f5f5,
	yellow: 0xffff00,
	yellowgreen: 0x9acd32,
};

// The system colors mapped onto what a terminal already has. 0 is the
// cell grid's "no SGR color" sentinel, meaning the terminal's own
// default, and a nonzero value is packed RGB. Canvas and the
// Highlight/SelectedItem pairs have special painter translations; these
// values are used only on paths those guards do not intercept, such as a
// border or outline color.
const SYSTEM_COLORS: Record<string, number> = {
	accentcolor: 0x0000ff, // the accent: blue
	accentcolortext: 0, // text on the accent: the terminal's default background
	activetext: 0xff0000, // an active link: red
	buttonborder: 0, // a control's border: the default foreground
	buttonface: 0, // a control's face: the default background
	buttontext: 0, // a control's label: the default foreground
	canvas: 0, // the document background: the default background
	canvastext: 0, // document text: the default foreground
	textControl: 0, // an input's background: the default background
	fieldtext: 0, // an input's text: the default foreground
	graytext: 0x808080, // disabled text: bright black, the dim gray
	highlight: 0x0000ff, // the selection, when inverse cannot express it: blue
	highlighttext: 0, // selected text, likewise: the default background
	linktext: 0x0000ff, // a link: blue
	mark: 0xffff00, // a <mark>'s background: yellow
	marktext: 0, // a <mark>'s text: black, which this engine stores as 0
	selecteditem: 0x0000ff, // a selected item, when not inverse: blue
	selecteditemtext: 0, // its text, likewise: the default background
	visitedtext: 0xff00ff, // a visited link: magenta
	activeborder: 0, // deprecated -> ButtonBorder
	activecaption: 0, // deprecated -> Canvas
	appworkspace: 0, // deprecated -> Canvas
	background: 0, // deprecated -> Canvas
	buttonhighlight: 0, // deprecated -> ButtonFace
	buttonshadow: 0, // deprecated -> ButtonFace
	captiontext: 0, // deprecated -> CanvasText
	inactiveborder: 0, // deprecated -> ButtonBorder
	inactivecaption: 0, // deprecated -> Canvas
	inactivecaptiontext: 0x808080, // deprecated -> GrayText
	infobackground: 0, // deprecated -> Canvas
	infotext: 0, // deprecated -> CanvasText
	menu: 0, // deprecated -> Canvas
	menutext: 0, // deprecated -> CanvasText
	scrollbar: 0, // deprecated -> Canvas
	threeddarkshadow: 0, // deprecated -> ButtonBorder
	threedface: 0, // deprecated -> ButtonFace
	threedhighlight: 0, // deprecated -> ButtonBorder
	threedlightshadow: 0, // deprecated -> ButtonBorder
	threedshadow: 0, // deprecated -> ButtonBorder
	window: 0, // deprecated -> Canvas
	windowtext: 0, // deprecated -> CanvasText
};

function parseColor(text: string): {color: number; alpha: number} | null {
	const color = text.trim().toLowerCase();

	if (color in NAMED_COLORS) {
		return {color: NAMED_COLORS[color], alpha: 1};
	}

	if (color.startsWith("#")) {
		const hex = color.slice(1);
		if (!/^[0-9a-f]+$/.test(hex)) {
			return null;
		}
		const short = hex.length === 3 || hex.length === 4;
		if (!short && hex.length !== 6 && hex.length !== 8) {
			return null;
		}
		const size = short ? 1 : 2;
		const channel = (index: number): number => {
			const part = hex.slice(index * size, (index + 1) * size);
			return parseInt(short ? part + part : part, 16);
		};
		const packed = (channel(0) << 16) | (channel(1) << 8) | channel(2);
		const alpha = hex.length === 4 || hex.length === 8 ? channel(3) / 255 : 1;
		return {color: packed, alpha};
	}

	const rgbMatch = color.match(
		/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+%?))?\s*\)/,
	);
	if (rgbMatch) {
		const r = parseInt(rgbMatch[1], 10);
		const g = parseInt(rgbMatch[2], 10);
		const b = parseInt(rgbMatch[3], 10);
		return {color: (r << 16) | (g << 8) | b, alpha: parseAlpha(rgbMatch[4])};
	}

	const hslMatch = color.match(
		/hsla?\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+%?))?\s*\)/,
	);
	if (hslMatch) {
		const h = ((parseFloat(hslMatch[1]) % 360) + 360) % 360;
		const s = Math.min(100, Math.max(0, parseFloat(hslMatch[2]))) / 100;
		const l = Math.min(100, Math.max(0, parseFloat(hslMatch[3]))) / 100;
		const c = (1 - Math.abs(2 * l - 1)) * s;
		const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
		const m = l - c / 2;
		let r1 = 0, g1 = 0, b1 = 0;
		if (h < 60) {
			[r1, g1, b1] = [c, x, 0];
		} else if (h < 120) {
			[r1, g1, b1] = [x, c, 0];
		} else if (h < 180) {
			[r1, g1, b1] = [0, c, x];
		} else if (h < 240) {
			[r1, g1, b1] = [0, x, c];
		} else if (h < 300) {
			[r1, g1, b1] = [x, 0, c];
		} else {
			[r1, g1, b1] = [c, 0, x];
		}
		const r = Math.round((r1 + m) * 255);
		const g = Math.round((g1 + m) * 255);
		const b = Math.round((b1 + m) * 255);
		return {color: (r << 16) | (g << 8) | b, alpha: parseAlpha(hslMatch[4])};
	}

	return null;
}

function parseAlpha(raw: string | undefined): number {
	if (raw === undefined) {
		return 1;
	}
	const value = raw.endsWith("%")
		? Number(raw.slice(0, -1)) / 100
		: Number(raw);
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** Whether a color paints nothing: transparent, none, empty, or zero alpha. */
export function isTransparentColor(color: string): boolean {
	const text = color.trim().toLowerCase();
	if (!text || text === "transparent" || text === "none") {
		return true;
	}
	return parseColor(text)?.alpha === 0;
}

// Null for a value that names no color. A system color is deliberately
// null: it computes to its keyword, because the color it stands for
// belongs to the terminal's theme and this process cannot express it as
// an rgb().
function serializeCSSColor(value: string): string | null {
	const components = parseCSSColorComponents(value);
	if (components === null) {
		return null;
	}
	const [red, green, blue] = components;
	if (components[3] < 1) {
		const alpha = Math.round(components[3] * 1000) / 1000;
		return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
	}
	return `rgb(${red}, ${green}, ${blue})`;
}

function parseCSSColorComponents(
	value: string,
): [number, number, number, number] | null {
	const text = value.trim().toLowerCase();
	if (!text || text === "currentcolor") {
		return null;
	}
	if (text === "transparent") {
		return [0, 0, 0, 0];
	}
	const parsed = parseColor(text);
	if (parsed === null) {
		return null;
	}
	return [
		(parsed.color >> 16) & 0xff,
		(parsed.color >> 8) & 0xff,
		parsed.color & 0xff,
		parsed.alpha,
	];
}

/**
 * Packed 24-bit RGB. Unrecognized, transparent and system-default colors
 * all resolve to 0, because the painter has no null to put in a cell.
 */
export function cssColorToNumber(cssColor: string): number {
	if (!cssColor || cssColor === "transparent" || cssColor === "none") {
		return 0;
	}
	const system = SYSTEM_COLORS[cssColor.trim().toLowerCase()];
	if (system !== undefined) {
		return system;
	}
	return parseColor(cssColor)?.color ?? 0;
}

const BORDER_STYLE_KEYWORDS = new Set([
	"none",
	"hidden",
	"dotted",
	"dashed",
	"solid",
	"double",
	"groove",
	"ridge",
	"inset",
	"outset",
]);
const LINE_WIDTH_KEYWORDS = new Set(["thin", "medium", "thick"]);
const EDGES = ["top", "right", "bottom", "left"] as const;

const AXIS_ENDS = ["start", "end"] as const;

const CORNERS = [
	"top-left",
	"top-right",
	"bottom-right",
	"bottom-left",
] as const;
const LIST_STYLE_POSITIONS = new Set(["inside", "outside"]);

// CSS 1-4 expansion: [all], [v h], [t h b], [t r b l]. Corners expand
// the same way.
function perEdge(values: string[]): [string, string, string, string] {
	const [a, b = a, c = a, d = b] = values;
	return [a, b, c, d];
}

function perEnd(values: string[]): [string, string] {
	const [a, b = a] = values;
	return [a, b];
}

// The property index's grammars, with entries the index states from an
// older spec level brought up to date. The deprecated system colors
// still parse, per CSS Color 4.
const grammarLexer = CSSTree.fork({
	properties: {
		"alignment-baseline": "| text-bottom | text-top",
		"baseline-shift": "| top | center | bottom",
		"outline-color": "| invert",
	},
	types: {
		color: "| <deprecated-system-color>",
		"family-name":
			"| generic( <custom-ident>+ ) | -webkit-generic( <custom-ident>+ )",
	},
}).lexer;

interface ValueTerm {
	text: string;
	terms: string[];
}

// Each component paired with the grammar terms it matched, outermost
// first. Null when the grammar rejects the value (a substitution, or a
// spelling the index does not describe), in which case callers fall back
// to reading by shape. The text is the component as the declaration
// spells it.
function getGrammarTerms(property: string, value: string): ValueTerm[] | null {
	let ast: {children?: {toArray(): CSSTree.ValueNode[]} | null};
	// getTrace returns one step of the match per term the node matched.
	let match: {
		matched: unknown;
		getTrace(node: unknown): Array<{type: string; name: string}> | null;
	};
	try {
		ast = CSSTree.parse(value, {context: "value", positions: true}) as never;
		match = grammarLexer.matchProperty(property, ast as never) as never;
	} catch (_err) {
		return null;
	}
	if (!match.matched) {
		return null;
	}
	const out: ValueTerm[] = [];
	for (const node of ast.children?.toArray() ?? []) {
		const source = node as unknown as {
			loc?: {start: {offset: number}; end: {offset: number}};
		};
		const trace = match.getTrace(node);
		if (!trace || !source.loc) {
			return null;
		}
		out.push({
			text: value.slice(source.loc.start.offset, source.loc.end.offset),
			terms: trace.map((step) => step.name),
		});
	}
	return out;
}

interface LineValue {
	width: string | null;
	lineStyle: string | null;
	color: string | null;
}

const LINE_VALUE_TERMS = new Map<string, keyof LineValue>([
	["line-width", "width"],
	["line-style", "lineStyle"],
	["outline-line-style", "lineStyle"],
	["color", "color"],
]);

const NUMERIC_NODES = new Set(["Number", "Dimension", "Percentage"]);

// border/outline's <line-width> || <line-style> || <color>: the
// components come in any order, so which term each fills is read from
// the grammar match. A rejected value is read by shape instead.
function splitLineValue(property: string, value: string): LineValue {
	const out: LineValue = {width: null, lineStyle: null, color: null};
	const traced = getGrammarTerms(property, value);
	if (traced) {
		for (const component of traced) {
			for (const term of component.terms) {
				const slot = LINE_VALUE_TERMS.get(term);
				if (slot) {
					out[slot] = component.text;
					break;
				}
			}
		}
		return out;
	}
	for (const token of splitComponents(value)) {
		const type = getSingleValueNode(token)?.type;
		if (BORDER_STYLE_KEYWORDS.has(token)) {
			out.lineStyle = token;
		} else if (
			LINE_WIDTH_KEYWORDS.has(token) || NUMERIC_NODES.has(type ?? "")
		) {
			out.width = token;
		} else if (token) {
			out.color = token;
		}
	}
	return out;
}

const FLEX_DIRECTIONS = new Set([
	"row",
	"row-reverse",
	"column",
	"column-reverse",
]);

const FLEX_WRAPS = new Set(["nowrap", "wrap", "wrap-reverse"]);

// `safe center`, `first baseline`: the first word qualifies the second.
const ALIGNMENT_QUALIFIERS = new Set(["safe", "unsafe", "first", "last"]);

// css-flexbox-1 §7.1.
function expandFlexFlow(value: string): Record<string, string> {
	const out: Record<string, string> = {
		"flex-direction": "row",
		"flex-wrap": "nowrap",
	};
	for (const token of splitComponents(value)) {
		const keyword = token.toLowerCase();
		if (FLEX_DIRECTIONS.has(keyword)) {
			out["flex-direction"] = keyword;
		} else if (FLEX_WRAPS.has(keyword)) {
			out["flex-wrap"] = keyword;
		}
	}
	return out;
}

// css-align-3 §10: block axis first, and one value applies to both.
function expandPlace(
	value: string,
	block: string,
	inline: string,
): Record<string, string> {
	const values: string[] = [];
	for (const token of splitComponents(value)) {
		const previous = values[values.length - 1];
		if (
			previous !== undefined && ALIGNMENT_QUALIFIERS.has(previous.toLowerCase())
		) {
			values[values.length - 1] = `${previous} ${token}`;
		} else {
			values.push(token);
		}
	}
	if (values.length === 0) {
		return {};
	}
	return {[block]: values[0], [inline]: values[1] ?? values[0]};
}

// css-flexbox-1 §7.1.1. The one-value numeric form (`flex: 1`) sets the
// basis to 0%, which is what makes it the everyday grow-to-fill
// declaration.
function expandFlex(value: string): Record<string, string> | null {
	const v = value.trim();
	if (v === "none") {
		return {"flex-grow": "0", "flex-shrink": "0", "flex-basis": "auto"};
	}
	if (v === "auto") {
		return {"flex-grow": "1", "flex-shrink": "1", "flex-basis": "auto"};
	}
	if (v === "initial") {
		return {"flex-grow": "0", "flex-shrink": "1", "flex-basis": "auto"};
	}
	let grow: string | undefined;
	let shrink: string | undefined;
	let basis: string | undefined;
	const traced = getGrammarTerms("flex", v);
	if (traced) {
		for (const component of traced) {
			if (component.terms.includes("flex-grow")) {
				grow = component.text;
			} else if (component.terms.includes("flex-shrink")) {
				shrink = component.text;
			} else if (component.terms.includes("flex-basis")) {
				basis = component.text;
			}
		}
	} else {
		for (const token of splitComponents(v)) {
			if (getSingleValueNode(token)?.type === "Number") {
				if (grow === undefined) {
					grow = token;
				} else if (shrink === undefined) {
					shrink = token;
				} else {
					return null;
				}
			} else if (basis === undefined) {
				basis = token;
			} else {
				return null;
			}
		}
	}
	if (grow === undefined && basis === undefined) {
		return null;
	}
	return {
		"flex-grow": grow ?? "1",
		"flex-shrink": shrink ?? "1",
		"flex-basis": basis ?? (grow !== undefined ? "0%" : "auto"),
	};
}

const LIST_STYLE_LONGHANDS = [
	"list-style-position",
	"list-style-image",
	"list-style-type",
];

// `none` sets whichever of type/image was not given. A terminal has no
// images, so it always means "no marker".
function expandListStyle(value: string): Record<string, string> {
	const parts: Record<string, string> = {};
	const traced = getGrammarTerms("list-style", value);
	if (traced) {
		for (const component of traced) {
			for (const longhand of LIST_STYLE_LONGHANDS) {
				if (component.terms.includes(longhand)) {
					parts[longhand] = component.text;
					break;
				}
			}
		}
		return parts;
	}
	for (const token of splitComponents(value)) {
		if (LIST_STYLE_POSITIONS.has(token)) {
			parts["list-style-position"] = token;
		} else if (token.startsWith("url(")) {
			parts["list-style-image"] = token;
		} else {
			parts["list-style-type"] = token;
		}
	}
	return parts;
}

// Expands only to the two components a terminal renders. `none` is the
// IMAGE component, so a bare `background: none` leaves the color
// transparent.
function expandBackground(value: string): Record<string, string> {
	const traced = getGrammarTerms("background", value);
	if (traced) {
		const image = traced
			.filter((component) => component.terms.includes("bg-image"))
			.map((component) => component.text)
			.join(" ");
		const color = traced
			.filter((component) => component.terms.includes("background-color"))
			.map((component) => component.text)
			.join(" ");
		return {
			"background-image": image || "none",
			"background-color": color || "transparent",
		};
	}
	const tokens = splitComponents(value);
	if (value.includes("url(")) {
		return {"background-image": value.trim()};
	}
	const color = tokens
		.filter((token) => token.toLowerCase() !== "none")
		.join(" ");
	return {
		"background-image": "none",
		"background-color": color || "transparent",
	};
}

const BORDER_IMAGE_REPEATS = new Set(["stretch", "repeat", "round", "space"]);

const IMAGE_FUNCTIONS = new Set([
	"url",
	"image",
	"image-set",
	"element",
	"cross-fade",
	"paint",
]);

function isImageValue(token: string): boolean {
	const node = getSingleValueNode(token);
	if (!node) {
		return false;
	}
	if (node.type === "Url") {
		return true;
	}
	if (node.type === "Identifier") {
		return (node.name ?? "").toLowerCase() === "none";
	}
	const name = (node.name ?? "").toLowerCase();
	return (
		node.type === "Function" &&
		(IMAGE_FUNCTIONS.has(name) || name.endsWith("-gradient"))
	);
}

const BORDER_IMAGE_LONGHANDS = [
	"border-image-source",
	"border-image-slice",
	"border-image-width",
	"border-image-outset",
	"border-image-repeat",
];

// Nothing here reaches the painter. The `border` shorthand resets these
// five longhands and serializes only while they are initial, so a block
// has to know their values.
function expandBorderImage(value: string): Record<string, string> {
	const traced = getGrammarTerms("border-image", value);
	if (traced) {
		const out: Record<string, string> = {};
		for (const component of traced) {
			for (const longhand of BORDER_IMAGE_LONGHANDS) {
				if (component.terms.includes(longhand)) {
					out[longhand] =
						out[longhand] === undefined
							? component.text
							: `${out[longhand]} ${component.text}`;
					break;
				}
			}
		}
		return out;
	}
	const out: Record<string, string> = {};
	const groups = value.split("/").map((group) => group.trim());
	const slice: string[] = [];
	const repeat: string[] = [];
	for (const token of splitComponents(groups[0] ?? "")) {
		if (BORDER_IMAGE_REPEATS.has(token.toLowerCase())) {
			repeat.push(token);
		} else if (isImageValue(token)) {
			out["border-image-source"] = token;
		} else {
			slice.push(token);
		}
	}
	if (slice.length > 0) {
		out["border-image-slice"] = slice.join(" ");
	}
	if (repeat.length > 0) {
		out["border-image-repeat"] = repeat.join(" ");
	}
	if (groups[1]) {
		out["border-image-width"] = groups[1];
	}
	if (groups[2]) {
		out["border-image-outset"] = groups[2];
	}
	return out;
}

// A corner is elliptical. Its longhand holds both radii, and states one
// value when the two are equal.
function expandBorderRadius(value: string): Record<string, string> {
	const [across, down] = value.split("/");
	const horizontal = splitComponents(across ?? "");
	if (horizontal.length === 0) {
		return {};
	}
	const vertical = down === undefined ? horizontal : splitComponents(down);
	const horizontalCorners = perEdge(horizontal);
	const verticalCorners = perEdge(
		vertical.length === 0 ? horizontal : vertical,
	);
	const out: Record<string, string> = {};
	CORNERS.forEach((corner, i) => {
		const h = horizontalCorners[i];
		const v = verticalCorners[i];
		out[`border-${corner}-radius`] = h === v ? h : `${h} ${v}`;
	});
	return out;
}

// The grid shorthands are the only slash-separated ones whose
// components can contain a slash inside a quoted string.
function splitSlashGroups(value: string): string[] {
	const groups: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			if (char === quote) {
				quote = "";
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(" || char === "[") {
			depth++;
		} else if (char === ")" || char === "]") {
			depth--;
		} else if (char === "/" && depth === 0) {
			groups.push(value.slice(start, i).trim());
			start = i + 1;
		}
	}
	groups.push(value.slice(start).trim());
	return groups;
}

function splitGridComponents(value: string): string[] {
	const components: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		const char = value[i];
		if (quote) {
			if (char === quote) {
				quote = "";
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "(" || char === "[") {
			depth++;
		} else if (char === ")" || char === "]") {
			depth--;
		} else if ((i === value.length || /\s/.test(char)) && depth === 0) {
			const component = value.slice(start, i).trim();
			if (component) {
				components.push(component);
			}
			start = i + 1;
		}
	}
	return components;
}

function isCustomIdent(value: string): boolean {
	return (
		/^-?[A-Za-z_][\w-]*$/.test(value) && value !== "auto" && value !== "span"
	);
}

// css-grid-2 §8.3.2: an omitted end repeats the start only when the
// start is a name. `grid-column: main` is the whole area; `grid-column:
// 2` is one track.
function expandGridPlacementPair(
	value: string,
	start: string,
	end: string,
): Record<string, string> {
	const groups = splitSlashGroups(value);
	const first = groups[0] || "auto";
	const second =
		groups.length > 1 && groups[1]
			? groups[1]
			: isCustomIdent(first) ? first : "auto";
	return {[start]: first, [end]: second};
}

// css-grid-2 §8.4: each omitted value falls back to the one across from
// it by the same custom-ident rule.
function expandGridArea(value: string): Record<string, string> {
	const groups = splitSlashGroups(value);
	const rowStart = groups[0] || "auto";
	const fallback = (index: number, from: string): string =>
		groups.length > index && groups[index]
			? groups[index]
			: isCustomIdent(from) ? from : "auto";
	const columnStart = fallback(1, rowStart);
	const rowEnd = fallback(2, rowStart);
	const columnEnd = fallback(3, columnStart);
	return {
		"grid-row-start": rowStart,
		"grid-column-start": columnStart,
		"grid-row-end": rowEnd,
		"grid-column-end": columnEnd,
	};
}

// css-grid-2 §7.4: rows / columns, or the visual form with area-name
// strings.
function expandGridTemplate(value: string): Record<string, string> {
	const text = value.trim();
	if (!text || text === "none") {
		return {
			"grid-template-rows": "none",
			"grid-template-columns": "none",
			"grid-template-areas": "none",
		};
	}

	if (!text.includes('"') && !text.includes("'")) {
		const groups = splitSlashGroups(text);
		return {
			"grid-template-rows": groups[0] || "none",
			"grid-template-columns": groups[1] || "none",
			"grid-template-areas": "none",
		};
	}

	// The visual form: everything up to the last top-level slash states the
	// rows, and the slash group after it, if any, states the columns.
	const groups = splitSlashGroups(text);
	const rowsText = groups[0];
	const columns = groups.length > 1 ? groups.slice(1).join(" / ") : "none";

	const strings: string[] = [];
	const rowTracks: string[] = [];
	let pendingNames: string[] = [];
	let sawString = false;
	for (const component of splitGridComponents(rowsText)) {
		if (component.startsWith("[")) {
			pendingNames.push(component);
			continue;
		}
		if (component.startsWith('"') || component.startsWith("'")) {
			// A row's own track size follows its string. A row with none is
			// `auto`, written out so the track list stays positional.
			if (sawString && rowTracks.length < strings.length) {
				rowTracks.push("auto");
			}
			strings.push(component);
			rowTracks.push(...pendingNames);
			pendingNames = [];
			sawString = true;
			continue;
		}
		rowTracks.push(component);
	}
	if (sawString && rowTracks.length < strings.length) {
		rowTracks.push("auto");
	}
	rowTracks.push(...pendingNames);

	return {
		"grid-template-rows": rowTracks.length > 0 ? rowTracks.join(" ") : "none",
		"grid-template-columns": columns,
		"grid-template-areas": strings.length > 0 ? strings.join(" ") : "none",
	};
}

// css-grid-2 §7.4: the explicit grid, or one axis against an `auto-flow`
// that sizes the other's implicit tracks. Resets every longhand it
// covers.
function expandGrid(value: string): Record<string, string> {
	const text = value.trim();
	const reset = {
		"grid-auto-flow": "row",
		"grid-auto-rows": "auto",
		"grid-auto-columns": "auto",
	};
	if (!/\bauto-flow\b/.test(text)) {
		return {...expandGridTemplate(text), ...reset};
	}

	const groups = splitSlashGroups(text);
	if (groups.length !== 2) {
		return {...expandGridTemplate(text), ...reset};
	}

	const flowInSecond = /\bauto-flow\b/.test(groups[1]);
	const flowGroup = flowInSecond ? groups[1] : groups[0];
	const otherGroup = flowInSecond ? groups[0] : groups[1];
	const dense = /\bdense\b/.test(flowGroup);
	const sizes = splitGridComponents(flowGroup)
		.filter((token) => token !== "auto-flow" && token !== "dense")
		.join(" ");

	// The axis the flow runs along takes the implicit sizes. The other axis
	// takes the explicit track list written across the slash.
	return flowInSecond
		? {
			"grid-template-rows": otherGroup || "none",
			"grid-template-columns": "none",
			"grid-template-areas": "none",
			"grid-auto-flow": dense ? "column dense" : "column",
			"grid-auto-columns": sizes || "auto",
			"grid-auto-rows": "auto",
		}
		: {
			"grid-template-columns": otherGroup || "none",
			"grid-template-rows": "none",
			"grid-template-areas": "none",
			"grid-auto-flow": dense ? "row dense" : "row",
			"grid-auto-rows": sizes || "auto",
			"grid-auto-columns": "auto",
		};
}

const EASING_KEYWORDS = new Set([
	"linear",
	"ease",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"step-start",
	"step-end",
]);

const EASING_FUNCTION_NAMES = new Set(["linear", "cubic-bezier", "steps"]);

function isEasingValue(token: string): boolean {
	const node = getSingleValueNode(token);
	if (!node) {
		return false;
	}
	if (node.type === "Identifier") {
		return EASING_KEYWORDS.has((node.name ?? "").toLowerCase());
	}
	return (
		node.type === "Function" &&
		EASING_FUNCTION_NAMES.has((node.name ?? "").toLowerCase())
	);
}

// The first time is the duration and the second is the delay.
function expandTransition(value: string): Record<string, string> {
	const properties: string[] = [];
	const durations: string[] = [];
	const delays: string[] = [];
	const easings: string[] = [];
	const behaviors: string[] = [];
	for (const item of splitCommaList(value)) {
		let property = "";
		let easing = "";
		let behavior = "";
		const times: string[] = [];
		for (const token of splitComponents(item)) {
			const lower = token.toLowerCase();
			if (times.length < 2 && getCSSTimeMs(token) !== null) {
				times.push(lower);
			} else if (!easing && isEasingValue(token)) {
				easing = lower;
			} else if (
				!behavior && (lower === "normal" || lower === "allow-discrete")
			) {
				behavior = lower;
			} else if (!property) {
				property = lower;
			}
		}
		properties.push(property || "all");
		durations.push(times[0] ?? "0s");
		delays.push(times[1] ?? "0s");
		easings.push(easing || "ease");
		behaviors.push(behavior || "normal");
	}
	if (properties.length === 0) {
		return {};
	}
	return {
		"transition-property": properties.join(", "),
		"transition-duration": durations.join(", "),
		"transition-timing-function": easings.join(", "),
		"transition-delay": delays.join(", "),
		"transition-behavior": behaviors.join(", "),
	};
}

// For a value whose grammar the index rejects (a substitution) but
// which still declares the lines it spells out.
const DECORATION_LINE_KEYWORDS = new Set([
	"none",
	"underline",
	"overline",
	"line-through",
	"blink",
	"spelling-error",
	"grammar-error",
]);

// Declarations are consulted per property, so a shorthand that is never
// expanded to longhands does not exist downstream. Order is preserved,
// so an explicit longhand after a shorthand still overrides it. A
// shorthand keeps its own entry so `getPropertyValue("border")` returns
// what was authored, except margin, padding and border-radius, whose
// computed values are serialized from the longhands the kept shorthand
// would shadow.
export function expandShorthands(
	declarations: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	const setEdges = (kind: string, values: string[]) => {
		const edgeValues = perEdge(values);
		EDGES.forEach((edge, i) => {
			out[`border-${edge}-${kind}`] = edgeValues[i];
		});
	};

	for (const [property, value] of Object.entries(declarations)) {
		const values = splitComponents(value);
		switch (property) {
			// css-fonts-4 §6.1: `normal` and `none` are whole values; otherwise
			// each keyword belongs to the one longhand whose grammar takes it,
			// and an unstated longhand resets to normal.
			case "font-variant": {
				const longhands = SHORTHAND_LONGHANDS.get("font-variant")!;
				const lower = value.trim().toLowerCase();
				if (lower === "normal" || lower === "none") {
					for (const longhand of longhands) {
						out[longhand] =
							lower === "none" && longhand === "font-variant-ligatures"
								? "none"
								: "normal";
					}
					break;
				}
				const assigned = new Map<string, string[]>();
				let valid = true;
				for (const component of values) {
					const longhand = longhands.find(
						(candidate) =>
							grammarLexer.matchProperty(candidate, component).matched !== null,
					);
					if (longhand === undefined) {
						valid = false;
						break;
					}
					assigned.set(longhand, [
						...(assigned.get(longhand) ?? []),
						component,
					]);
				}
				if (!valid) {
					break;
				}
				for (const longhand of longhands) {
					out[longhand] = assigned.get(longhand)?.join(" ") ?? "normal";
				}
				break;
			}
			case "border": {
				const {width, lineStyle, color} = splitLineValue(property, value);
				setEdges("width", [width ?? "medium"]);
				setEdges("style", [lineStyle ?? "none"]);
				if (color) {
					setEdges("color", [color]);
				}
				break;
			}
			case "border-image":
				Object.assign(out, expandBorderImage(value));
				break;
			case "border-width":
				setEdges("width", values);
				break;
			case "border-style":
				setEdges("style", values);
				break;
			case "border-color":
				setEdges("color", values);
				break;
			case "border-radius": {
				const corners = expandBorderRadius(value);
				if (Object.keys(corners).length === 0) {
					break;
				}
				Object.assign(out, corners);
				// The shorthand itself is serialized from these on read.
				continue;
			}
			// One edge's line, physical or flow-relative: `border-top: 1px
			// solid`, `border-inline-start: 1px solid`. The edge is whatever
			// follows `border-`, which covers both kinds.
			case "border-top":
			case "border-right":
			case "border-bottom":
			case "border-left":
			case "border-block-start":
			case "border-block-end":
			case "border-inline-start":
			case "border-inline-end": {
				const edge = property.slice("border-".length);
				const {width, lineStyle, color} = splitLineValue(property, value);
				out[`border-${edge}-width`] = width ?? "medium";
				out[`border-${edge}-style`] = lineStyle ?? "none";
				if (color) {
					out[`border-${edge}-color`] = color;
				}
				break;
			}
			case "outline": {
				const {width, lineStyle, color} = splitLineValue(property, value);
				out["outline-width"] = width ?? "medium";
				out["outline-style"] = lineStyle ?? "none";
				if (color) {
					out["outline-color"] = color;
				}
				break;
			}
			// The flow-relative pairs (css-logical-1 §4): one value for both
			// ends of the axis, or one for each. They set their longhands and,
			// like `margin` and `padding`, are serialized back from them.
			case "margin-block":
			case "margin-inline":
			case "padding-block":
			case "padding-inline":
			case "inset-block":
			case "inset-inline": {
				const axis = property.slice(property.lastIndexOf("-") + 1);
				const kind = property.slice(0, property.lastIndexOf("-"));
				const ends = perEnd(values);
				AXIS_ENDS.forEach((end, i) => {
					out[`${kind}-${axis}-${end}`] = ends[i];
				});
				continue;
			}
			// `border-block` / `border-inline`: one line on both ends of the
			// axis.
			case "border-block":
			case "border-inline": {
				const axis = property.slice("border-".length);
				const {width, lineStyle, color} = splitLineValue(property, value);
				for (const end of AXIS_ENDS) {
					out[`border-${axis}-${end}-width`] = width ?? "medium";
					out[`border-${axis}-${end}-style`] = lineStyle ?? "none";
					if (color) {
						out[`border-${axis}-${end}-color`] = color;
					}
				}
				break;
			}
			// One line component across an axis: `border-inline-width: 1px 2px`.
			case "border-block-width":
			case "border-block-style":
			case "border-block-color":
			case "border-inline-width":
			case "border-inline-style":
			case "border-inline-color": {
				const [, axis, kind] = property.split("-");
				const ends = perEnd(values);
				AXIS_ENDS.forEach((end, i) => {
					out[`border-${axis}-${end}-${kind}`] = ends[i];
				});
				break;
			}
			case "padding":
			case "margin": {
				const edgeValues = perEdge(values);
				EDGES.forEach((edge, i) => {
					out[`${property}-${edge}`] = edgeValues[i];
				});
				// The shorthand itself is serialized from these on read.
				continue;
			}
			case "inset": {
				const edgeValues = perEdge(values);
				EDGES.forEach((edge, i) => {
					out[edge] = edgeValues[i];
				});
				break;
			}
			case "gap": {
				out["row-gap"] = values[0];
				out["column-gap"] = values[1] ?? values[0];
				break;
			}
			// The legacy spelling of `gap`, which browsers still accept. Its
			// longhands share a cascade slot with row-gap/column-gap, so
			// declaring them is declaring the modern pair.
			case "grid-gap": {
				out["grid-row-gap"] = values[0];
				out["grid-column-gap"] = values[1] ?? values[0];
				break;
			}
			case "grid-row":
				Object.assign(
					out,
					expandGridPlacementPair(value, "grid-row-start", "grid-row-end"),
				);
				break;
			case "grid-column":
				Object.assign(
					out,
					expandGridPlacementPair(
						value,
						"grid-column-start",
						"grid-column-end",
					),
				);
				break;
			case "grid-area":
				Object.assign(out, expandGridArea(value));
				break;
			case "grid-template":
				Object.assign(out, expandGridTemplate(value));
				break;
			case "grid":
				Object.assign(out, expandGrid(value));
				break;
			case "overflow": {
				out["overflow-x"] = values[0];
				out["overflow-y"] = values[1] ?? values[0];
				break;
			}
			case "flex": {
				Object.assign(out, expandFlex(value) ?? {});
				break;
			}
			case "flex-flow": {
				Object.assign(out, expandFlexFlow(value));
				break;
			}
			case "place-content":
				Object.assign(
					out,
					expandPlace(value, "align-content", "justify-content"),
				);
				break;
			case "place-items":
				Object.assign(out, expandPlace(value, "align-items", "justify-items"));
				break;
			case "place-self":
				Object.assign(out, expandPlace(value, "align-self", "justify-self"));
				break;
			case "list-style":
				Object.assign(out, expandListStyle(value));
				break;
			case "background":
				Object.assign(out, expandBackground(value));
				break;
			case "transition":
				Object.assign(out, expandTransition(value));
				break;
			case "text-decoration": {
				// `<line> || <style> || <color> || <thickness>`. Only the line
				// component has a terminal rendering, and it is the one the
				// painter reads.
				const traced = getGrammarTerms(property, value);
				const line = (
					traced
						? traced
							.filter((component) =>
								component.terms.includes("text-decoration-line"),
							)
							.map((component) => component.text)
						: values.filter((token) =>
							DECORATION_LINE_KEYWORDS.has(token.toLowerCase()),
						)
				).join(" ");
				if (line) {
					out["text-decoration-line"] = line;
				}
				break;
			}
		}
		out[property] = value;
	}
	return out;
}

// Overrides the property index's initial values. A cell grid uses one
// cell for `font-size` where the index says medium, and border-box for
// `box-sizing`.
const CSS_SPEC_DEFAULTS: Record<string, string> = {
	display: "inline",
	"margin-top": "0",
	"margin-right": "0",
	"margin-bottom": "0",
	"margin-left": "0",
	"padding-top": "0",
	"padding-right": "0",
	"padding-bottom": "0",
	"padding-left": "0",
	"border-width": "0",
	"border-style": "none",
	"border-color": "currentColor",
	"border-top-width": "0",
	"border-right-width": "0",
	"border-bottom-width": "0",
	"border-left-width": "0",
	"border-top-style": "none",
	"border-right-style": "none",
	"border-bottom-style": "none",
	"border-left-style": "none",
	"border-top-color": "currentColor",
	"border-right-color": "currentColor",
	"border-bottom-color": "currentColor",
	"border-left-color": "currentColor",
	"background-color": "transparent",
	color: "#000000",
	// One cell tall. The terminal's font is the grid, so a length in em is
	// a length in cells.
	"font-size": "1px",
	"font-weight": "normal",
	"font-style": "normal",
	"text-decoration": "none",
	"white-space": "normal",
	overflow: "visible",
	position: "static",
	width: "auto",
	height: "auto",
	"box-sizing": "border-box",
	"flex-direction": "row",
	"flex-wrap": "nowrap",
	// `normal` is CSS's initial value for both, and the one a grid needs:
	// it tells a grid's auto tracks to fill the container. A flex container
	// packs its items at the main-start edge under it, which is what
	// flex-start asks for.
	"justify-content": "normal",
	"align-items": "stretch",
	"align-content": "normal",
	gap: "0",
	"row-gap": "0",
	"column-gap": "0",
	"flex-grow": "0",
	"flex-shrink": "1",
	"flex-basis": "auto",
	"align-self": "auto",
	order: "0",
};

export function getInitialValue(property: string): string {
	return CSS_SPEC_DEFAULTS[property] || CSS_INITIAL_VALUES[property] || "";
}

// A custom property inherits too, and is in no list, because there is
// no fixed set of names.
const INHERITED_PROPERTIES = new Set([
	"color",
	"cursor",
	"direction",
	"font-family",
	"font-size",
	"font-style",
	"font-variant",
	"font-weight",
	"letter-spacing",
	"line-height",
	"list-style",
	"list-style-image",
	"list-style-position",
	"list-style-type",
	"overflow-wrap",
	"quotes",
	"text-align",
	"text-decoration",
	"text-decoration-color",
	"text-decoration-line",
	"text-decoration-style",
	"text-decoration-thickness",
	"text-indent",
	"text-transform",
	"visibility",
	"white-space",
	"word-break",
	"word-spacing",
]);

export function isInheritedProperty(property: string): boolean {
	return property.startsWith("--") || INHERITED_PROPERTIES.has(property);
}

// The unit collapses to the count (px and ch both measure one cell), and
// a percentage keeps its mark for the caller to resolve against a basis.
function getLeadingUnitValue(
	value: string,
): number | {percentage: number} | null {
	const nodes = value ? getCSSValueChildren(value.trim()) : null;
	const node = nodes?.[0];
	if (!node) {
		return null;
	}
	const number = parseFloat(node.value ?? "");
	if (!Number.isFinite(number)) {
		return null;
	}
	if (node.type === "Percentage") {
		return {percentage: number};
	}
	if (node.type === "Dimension" || node.type === "Number") {
		return number;
	}
	return null;
}

/**
 * A nonnegative length or percentage. A negative width or padding is
 * invalid CSS and must not reach layout. parseSignedUnitValue keeps the
 * sign.
 */
export function parseUnitValue(
	value: string,
): number | {percentage: number} | null {
	const parsed = getLeadingUnitValue(value);
	const number =
		typeof parsed === "number"
			? parsed
			: parsed !== null ? parsed.percentage : null;
	return number !== null && number < 0 ? null : parsed;
}

/** A number-valued property such as flex-grow. Null when not a number. */
export function parseCSSNumber(value: string): number | null {
	const number = parseFloat(value);
	return Number.isFinite(number) ? number : null;
}

/** An integer-valued property such as order or z-index. */
export function parseCSSInteger(value: string): number | null {
	const number = parseCSSNumber(value);
	return number === null ? null : Math.trunc(number);
}

/** One to four lengths in the order top, right, bottom, left, signs kept. */
export function parseEdgeLengths(
	value: string,
): [UnitValue, UnitValue, UnitValue, UnitValue] {
	const parts = splitComponents(value);
	if (parts.length === 0) {
		return [null, null, null, null];
	}
	const [top, right, bottom, left] = perEdge(parts);
	return [
		parseSignedUnitValue(top),
		parseSignedUnitValue(right),
		parseSignedUnitValue(bottom),
		parseSignedUnitValue(left),
	];
}

export type UnitValue = number | {percentage: number} | null;

/**
 * The alignment keyword without its qualifier: `safe center` and
 * `first baseline` name center and baseline.
 */
export function parseAlignmentKeyword(value: string): string {
	const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
	while (tokens.length > 1 && ALIGNMENT_QUALIFIERS.has(tokens[0])) {
		tokens.shift();
	}
	return tokens[0] ?? "";
}

export function parseGridAutoFlow(value: string): {
	column: boolean;
	dense: boolean;
} {
	const tokens = value.toLowerCase().split(/\s+/);
	return {column: tokens.includes("column"), dense: tokens.includes("dense")};
}

/**
 * A font weight as a number, 100 to 900. Relative keywords resolve
 * against normal, since a terminal has one bold and one dim and nothing
 * between to be relative to.
 */
export function parseFontWeight(value: string): number {
	switch (value.trim().toLowerCase()) {
		case "normal":
			return 400;
		case "bold":
		case "bolder":
			return 700;
		case "lighter":
			return 300;
		default: {
			const number = parseCSSNumber(value);
			return number === null ? 400 : number;
		}
	}
}

export function parseTextDecorationLine(value: string): {
	underline: boolean;
	overline: boolean;
	lineThrough: boolean;
} {
	const tokens = new Set(value.toLowerCase().split(/\s+/));
	return {
		underline: tokens.has("underline"),
		overline: tokens.has("overline"),
		lineThrough: tokens.has("line-through"),
	};
}

/** Canvas: the terminal's own background. */
export function isCanvasColor(value: string): boolean {
	return value.trim().toLowerCase() === "canvas";
}

/**
 * Highlight, HighlightText, SelectedItem and SelectedItemText. On a
 * terminal the pair means SGR inverse.
 */
export function isHighlightColor(value: string): boolean {
	return /^(?:highlight|selecteditem)(?:text)?$/.test(
		value.trim().toLowerCase(),
	);
}

/** The edges a box has, in cells, and the sizes it declares. */
export interface BoxModel {
	width?: number;
	height?: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
	borderTopWidth: number;
	borderRightWidth: number;
	borderBottomWidth: number;
	borderLeftWidth: number;
}

/** Lengths that may be negative. Margins (and offsets) keep the sign. */
export function parseSignedUnitValue(
	value: string,
): ReturnType<typeof parseUnitValue> {
	return getLeadingUnitValue(value ?? "");
}

/**
 * Border widths, keywords included. thin/medium/thick all become one
 * cell, because the grid cannot distinguish them, and medium is the
 * initial value a bare `border: solid` implies, which must be a VISIBLE
 * border as in a browser.
 */
export function parseBorderWidthValue(
	value: string,
): ReturnType<typeof parseUnitValue> {
	const keyword = value.trim().toLowerCase();
	if (keyword === "thin" || keyword === "medium" || keyword === "thick") {
		return 1;
	}
	return parseUnitValue(value);
}

/**
 * width / height, counting cells on both axes. `aspect-ratio: 1` on a box
 * 10 cells wide makes it 10 rows tall. Undefined leaves the box to size
 * itself.
 */
export function parseAspectRatio(value: string): number | undefined {
	if (!value || value.includes("auto")) {
		return undefined;
	}
	const parts = value.split("/");
	if (parts.length > 2) {
		return undefined;
	}
	const width = parseFloat(parts[0]);
	const height = parts.length === 2 ? parseFloat(parts[1]) : 1;
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return undefined;
	}
	return width / height;
}

// CSS accepts a bare 0 for any length, and bare numbers for the
// properties typed as numbers (line-height, z-index, opacity, ...).
// Those are NOT listed here.
const LENGTH_PROPERTIES = new Set([
	"border-bottom-left-radius",
	"border-bottom-right-radius",
	"border-bottom-width",
	"border-left-width",
	"border-radius",
	"border-right-width",
	"border-top-left-radius",
	"border-top-right-radius",
	"border-top-width",
	"border-width",
	"bottom",
	"column-gap",
	"flex-basis",
	"font-size",
	"gap",
	"height",
	"inset",
	"left",
	"letter-spacing",
	"margin",
	"margin-bottom",
	"margin-left",
	"margin-right",
	"margin-top",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"outline-offset",
	"outline-width",
	"padding",
	"padding-bottom",
	"padding-left",
	"padding-right",
	"padding-top",
	"right",
	"row-gap",
	"text-indent",
	"top",
	"width",
	"word-spacing",
]);

// A nonzero length without a unit is invalid CSS, rejected at parse
// time so a lower-priority rule still wins. Terminal authoring makes it
// an easy slip: `padding-top: 1` means nothing, `padding-top: 1px` means
// one cell.
export function isValidDeclaration(
	property: string,
	value: string,
	atRule = "",
): boolean {
	if (!isValidByGrammar(property, value, atRule)) {
		return false;
	}
	if (!LENGTH_PROPERTIES.has(property)) {
		return true;
	}
	// A shorthand is invalid as a WHOLE if one component is, so one bare
	// nonzero Number node rejects the declaration. Only top-level nodes
	// count. A number nested in a calc() is the grammar's business.
	const nodes = getCSSValueChildren(value.trim());
	if (!nodes) {
		return true;
	}
	return !nodes.some(
		(node) => node.type === "Number" && parseFloat(node.value ?? "") !== 0,
	);
}

// A declaration is parsed once for every element that declares it, and
// the same handful of values recur across a whole document.
const grammarMatches = new Map<string, boolean>();

const SUPPORTED_PROPERTIES = new Set(CSS_PROPERTIES);

export function isSupportedProperty(property: string): boolean {
	return property.startsWith("--") || SUPPORTED_PROPERTIES.has(property);
}

// A value that does not match its grammar is not a declaration at all.
// `color: notacolor` is a no-op, not a value. A value with a
// substitution is not checked.
function isValidByGrammar(
	property: string,
	value: string,
	atRule = "",
): boolean {
	if (property.startsWith("--")) {
		return true;
	}
	if (!atRule && !SUPPORTED_PROPERTIES.has(property)) {
		return true;
	}
	const text = value.trim();
	if (!text || CSS_WIDE_KEYWORDS.has(text.toLowerCase())) {
		return true;
	}
	if (/\b(?:var|env|attr)\(/i.test(text)) {
		return true;
	}
	const key = `${atRule}|${property}|${text}`;
	const memoized = grammarMatches.get(key);
	if (memoized !== undefined) {
		return memoized;
	}
	let valid = true;
	try {
		const match = atRule
			? grammarLexer.matchAtruleDescriptor(atRule.slice(1), property, text)
			: grammarLexer.matchProperty(property, text);
		// A descriptor or property the grammars do not describe cannot be
		// checked.
		valid =
			match.matched !== null ||
			/Unknown (?:property|at-rule)/i.test(match.error?.message ?? "");
	} catch (_err) {
		valid = true;
	}
	if (grammarMatches.size > 4096) {
		grammarMatches.clear();
	}
	grammarMatches.set(key, valid);
	return valid;
}

// A marker is separated from its item's text by one cell.
export function withMarkerSeparator(marker: string): string {
	return marker ? `${marker} ` : "";
}

// A content value is a SEQUENCE of components (strings and functions).
// Stripping quotes only when the whole value was one quoted string left
// `"` in the rendered marker.
export function unquoteContent(content: string): string {
	let out = "";
	let index = 0;

	while (index < content.length) {
		const char = content[index];

		if (char === '"' || char === "'") {
			// A quote or backslash inside the string is preceded by a
			// backslash, which is spelling, not content.
			let close = index + 1;
			for (; close < content.length && content[close] !== char; close++) {
				if (content[close] === "\\") {
					close++;
				}
			}
			out += content.slice(index + 1, close).replace(/\\(.)/g, "$1");
			index = close + 1;
		} else if (/\s/.test(char)) {
			// Whitespace between components is not rendered.
			index++;
		} else {
			// A function or keyword: copy it verbatim, parens and all.
			let depth = 0;
			let end = index;
			for (; end < content.length; end++) {
				const c = content[end];
				if (c === "(") {
					depth++;
				} else if (c === ")") {
					depth--;
				} else if (depth === 0 && /\s/.test(c)) {
					break;
				}
			}
			out += content.slice(index, end);
			index = end;
		}
	}

	return out;
}

const COLOR_PROPERTIES = new Set([
	"accent-color",
	"background-color",
	"border-block-end-color",
	"border-block-start-color",
	"border-bottom-color",
	"border-inline-end-color",
	"border-inline-start-color",
	"border-left-color",
	"border-right-color",
	"border-top-color",
	"caret-color",
	"color",
	"column-rule-color",
	"outline-color",
	"text-decoration-color",
	"text-emphasis-color",
]);

export function isColorProperty(property: string): boolean {
	return COLOR_PROPERTIES.has(property);
}

// Author text (strings, family names, custom idents) is never
// case-folded.
const VERBATIM_PROPERTIES = new Set([
	"background-image",
	"content",
	"counter-increment",
	"counter-reset",
	"font",
	"font-family",
	"grid-area",
	"grid-auto-columns",
	"grid-auto-rows",
	"grid-column",
	"grid-column-end",
	"grid-column-start",
	"grid-row",
	"grid-row-end",
	"grid-row-start",
	"grid-template",
	"grid-template-areas",
	"grid-template-columns",
	"grid-template-rows",
	"list-style-image",
	"quotes",
]);

// One bare identifier computes case-folded.
const IDENTIFIER_VALUE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

// Drops the sign and trailing zeros, folds the unit, and gives a
// unitless zero the px a length computes to.
function getComputedNumber(token: string): string {
	const node = getSingleValueNode(token);
	if (!node) {
		return token;
	}
	const number = parseFloat(node.value ?? "");
	if (!Number.isFinite(number)) {
		return token;
	}
	switch (node.type) {
		case "Number":
			return number === 0 ? "0px" : `${number}`;
		case "Percentage":
			return `${number}%`;
		case "Dimension":
			return `${number}${(node.unit ?? "").toLowerCase()}`;
	}
	return token;
}

const RADIUS_LONGHANDS = new Set([
	"border-top-left-radius",
	"border-top-right-radius",
	"border-bottom-right-radius",
	"border-bottom-left-radius",
]);

// A circular corner states one radius, an elliptical one both.
export function collapseRadius(property: string, value: string): string {
	if (!RADIUS_LONGHANDS.has(property)) {
		return value;
	}
	const parts = value.split(/\s+/).filter(Boolean);
	return parts.length === 2 && parts[0] === parts[1] ? parts[0] : value;
}

// The spacing an author uses to line up a picture of the grid is not
// part of the value. Every row writes its cells one space apart
// (css-grid-2 §7.3).
function normalizeGridAreas(value: string): string {
	const children = getCSSValueChildren(value);
	if (
		!children ||
		children.length === 0 ||
		children.some((node) => node.type !== "String")
	) {
		return value;
	}
	return children
		.map((node) => `"${(node.value ?? "").trim().split(/\s+/).join(" ")}"`)
		.join(" ");
}

// The one place a declared value becomes its computed spelling.
function normalizeValue(property: string, declared: string): string {
	const value = declared.trim();
	if (!value || property.startsWith("--")) {
		return value;
	}
	if (property === "grid-template-areas") {
		return normalizeGridAreas(value);
	}
	if (VERBATIM_PROPERTIES.has(property)) {
		return value;
	}
	if (COLOR_PROPERTIES.has(property)) {
		return serializeCSSColor(value) ?? value;
	}
	if (LENGTH_PROPERTIES.has(property)) {
		const lengths = value.split(/\s+/).map(getComputedNumber).join(" ");
		return collapseRadius(property, lengths);
	}
	return IDENTIFIER_VALUE.test(value) ? value.toLowerCase() : value;
}

// A value on any other property is the same string on every element,
// and interning is all its computation needs.
const ABSOLUTIZED_PROPERTIES = new Set([
	...LENGTH_PROPERTIES,
	"border-spacing",
	// A track list holds lengths inside functions and among keywords, so it
	// absolutizes by token rather than by the whitespace split the length
	// properties use.
	"grid-auto-columns",
	"grid-auto-rows",
	"grid-template",
	"grid-template-columns",
	"grid-template-rows",
	"line-height",
	"text-underline-offset",
	"vertical-align",
]);

// font-size resolves against the parent's font size, line-height
// against the element's own. Every other percentage stays until used.
const FONT_RELATIVE_PERCENTAGES = new Set(["font-size", "line-height"]);

export function isFontRelativePercentage(property: string): boolean {
	return FONT_RELATIVE_PERCENTAGES.has(property);
}

const RELATIVE_UNIT = /[\d.](?:r?em|ex|ch|vw|vh|vmin|vmax)\b/i;

// `contextual` means computing the value needs the element (a relative
// length, a calc(), a font-relative percentage). Decided once per
// declared text, so the common case is still just two map lookups.
interface ComputedEntry {
	value: string;
	contextual: boolean;
}

const EMPTY_ENTRY: ComputedEntry = {value: "", contextual: false};

// A document uses a small vocabulary of declared values, so the same
// property/text pair recurs across thousands of elements.
const computedValues = new Map<string, Map<string, ComputedEntry>>();

export function getComputedEntry(
	property: string,
	declared: string,
): ComputedEntry {
	if (!declared) {
		return EMPTY_ENTRY;
	}
	let byValue = computedValues.get(property);
	if (!byValue) {
		byValue = new Map();
		computedValues.set(property, byValue);
	}
	let entry = byValue.get(declared);
	if (entry === undefined) {
		const value = normalizeValue(property, declared);
		entry = {
			value,
			contextual:
				ABSOLUTIZED_PROPERTIES.has(property) &&
				(RELATIVE_UNIT.test(value) ||
					value.includes("calc(") ||
					(FONT_RELATIVE_PERCENTAGES.has(property) && value.includes("%"))),
		};
		if (byValue.size >= 512) {
			byValue.clear();
		}
		byValue.set(declared, entry);
	}
	return entry;
}

export function getComputedValueEntry(
	property: string,
	declared: string,
): string {
	return getComputedEntry(property, declared).value;
}

export interface LengthContext {
	font: number;

	// For `rem`.
	root: number;
	viewportWidth: number;
	viewportHeight: number;

	// What a percentage is worth, or null where percentages are kept.
	percent: number | null;
}

// One cell. `1em` is one cell in a document that declares no font size,
// and a document that declares a size still gets the spec's arithmetic.
const INITIAL_FONT_SIZE = 1;

export function getFontSize(fontSize: string): number {
	const size = parseFloat(fontSize);
	return Number.isFinite(size) ? size : INITIAL_FONT_SIZE;
}

function getUnitFactor(unit: string, context: LengthContext): number | null {
	switch (unit.toLowerCase()) {
		case "em":
			return context.font;
		case "rem":
			return context.root;
		// A terminal has no font metrics. Every glyph is one cell, so the
		// x-height a browser would measure is the half-em fallback.
		case "ex":
			return context.font / 2;
		// One cell wide whatever font size the document declares. A style
		// cannot resize the grid's column.
		case "ch":
			return 1;
		case "vw":
			return context.viewportWidth / 100;
		case "vh":
			return context.viewportHeight / 100;
		case "vmin":
			return Math.min(context.viewportWidth, context.viewportHeight) / 100;
		case "vmax":
			return Math.max(context.viewportWidth, context.viewportHeight) / 100;
		case "%":
			return context.percent;
		default:
			return null;
	}
}

function absoluteLength(px: number): string {
	return `${Math.round(px * 1e6) / 1e6}px`;
}

const LENGTH_TOKEN = /([+-]?(?:\d+\.?\d*|\.\d+))(%|[a-zA-Z]+)/g;

// What is left is px, the percentages a property keeps until used, and
// anything this engine does not measure, untouched.
export function absolutizeLengths(
	value: string,
	context: LengthContext,
): string {
	const reduced = value.includes("calc(") ? replaceCalc(value, context) : value;
	return reduced.replace(
		LENGTH_TOKEN,
		(token, number: string, unit: string) => {
			const factor = getUnitFactor(unit, context);
			return factor === null
				? token
				: absoluteLength(parseFloat(number) * factor);
		},
	);
}

function replaceCalc(value: string, context: LengthContext): string {
	let out = "";
	let index = 0;
	while (index < value.length) {
		const start = value.toLowerCase().indexOf("calc(", index);
		if (start === -1) {
			out += value.slice(index);
			break;
		}
		out += value.slice(index, start);
		let depth = 0;
		let end = start + 4;
		for (; end < value.length; end++) {
			if (value[end] === "(") {
				depth++;
			} else if (value[end] === ")" && --depth === 0) {
				break;
			}
		}
		const body = value.slice(start + 5, end);
		const terms = evaluateCalc(body, context);
		out += terms === null ? value.slice(start, end + 1) : serializeCalc(terms);
		index = end + 1;
	}
	return out;
}

interface CalcTerms {
	px: number;
	percent: number;
	number: number;
}

// A lone term serializes as itself. A length still carrying a
// percentage keeps the calc() that holds the two together.
function serializeCalc(terms: CalcTerms): string {
	const round = (value: number): number => Math.round(value * 1e6) / 1e6;
	const px = round(terms.px);
	const percent = round(terms.percent);
	const number = round(terms.number);
	if (percent === 0 && px === 0 && number !== 0) {
		return `${number}`;
	}
	if (percent === 0) {
		return `${px}px`;
	}
	if (px === 0 && number === 0) {
		return `${percent}%`;
	}
	return `calc(${px}px ${percent < 0 ? "-" : "+"} ${Math.abs(percent)}%)`;
}

// Null for anything this cannot reduce (a nested min()/max()/clamp(),
// an unsubstituted var()), which leaves the value as written.
function evaluateCalc(body: string, context: LengthContext): CalcTerms | null {
	const tokens = body.match(
		/[+-]?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?|[()*/+-]/g,
	);
	if (!tokens) {
		return null;
	}
	let position = 0;
	const peek = (): string | undefined => tokens[position];

	const scale = (terms: CalcTerms, by: number): CalcTerms => ({
		px: terms.px * by,
		percent: terms.percent * by,
		number: terms.number * by,
	});

	const primary = (): CalcTerms | null => {
		const token = tokens[position++];
		if (token === undefined) {
			return null;
		}
		if (token === "(") {
			const inner = sum();
			if (inner === null || tokens[position++] !== ")") {
				return null;
			}
			return inner;
		}
		if (token === "-" || token === "+") {
			const inner = primary();
			return inner === null ? null : scale(inner, token === "-" ? -1 : 1);
		}
		const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(%|[a-zA-Z]+)?$/.exec(token);
		if (!match) {
			return null;
		}
		const number = parseFloat(match[1]);
		if (!match[2]) {
			return {px: 0, percent: 0, number};
		}
		if (match[2] === "px") {
			return {px: number, percent: 0, number: 0};
		}
		if (match[2] === "%" && context.percent === null) {
			return {px: 0, percent: number, number: 0};
		}
		const factor = getUnitFactor(match[2], context);
		if (factor === null) {
			return null;
		}
		return {px: number * factor, percent: 0, number: 0};
	};

	const product = (): CalcTerms | null => {
		let left = primary();
		while (left !== null && (peek() === "*" || peek() === "/")) {
			const operator = tokens[position++];
			const right = primary();
			if (right === null) {
				return null;
			}
			if (operator === "/") {
				if (right.px !== 0 || right.percent !== 0 || right.number === 0) {
					return null;
				}
				left = scale(left, 1 / right.number);
			} else if (right.px === 0 && right.percent === 0) {
				left = scale(left, right.number);
			} else if (left.px === 0 && left.percent === 0) {
				left = scale(right, left.number);
			} else {
				return null;
			}
		}
		return left;
	};

	const sum = (): CalcTerms | null => {
		let left = product();
		while (left !== null && (peek() === "+" || peek() === "-")) {
			const operator = tokens[position++];
			const right = product();
			if (right === null) {
				return null;
			}
			const sign = operator === "-" ? -1 : 1;
			left = {
				px: left.px + sign * right.px,
				percent: left.percent + sign * right.percent,
				number: left.number + sign * right.number,
			};
		}
		return left;
	};

	const terms = sum();
	return terms !== null && position === tokens.length ? terms : null;
}

/** A cascade level's declarations: expanded longhands, and which are `!important`. */
export interface DeclarationBlock {
	declarations: Record<string, string>;
	important: Record<string, boolean>;

	// A logical property and its physical twin are two names for one
	// cascade slot, so whichever a block declares LAST decides the value.
	// Only this map records which that is.
	order: Record<string, number>;
}

// The slot name the block declares LAST at this importance, or null.
// `accepts` rejects a flow-relative name that maps to the opposite edge.
export function getDeclaredName(
	block: DeclarationBlock,
	names: readonly string[],
	important: boolean,
	accepts: (name: string) => boolean,
): string | null {
	let winner: string | null = null;
	let winningOrder = -1;
	for (const name of names) {
		if (block.declarations[name] === undefined) {
			continue;
		}
		if (Boolean(block.important[name]) !== important) {
			continue;
		}
		const order = block.order[name] ?? 0;
		if (order < winningOrder || !accepts(name)) {
			continue;
		}
		winner = name;
		winningOrder = order;
	}
	return winner;
}

export interface CSSDeclaration {
	name: string;
	value: string;
	important: boolean;
}

const LINE_COMPONENTS = ["width", "style", "color"] as const;

// One table per inline direction (css-logical-1 §2). This engine
// renders horizontal-tb only, because a terminal's grid is row-major, so
// block-start is always the top edge and `direction` alone decides the
// inline edges. A writing-mode implementation would replace these two
// tables with four more, and nothing else here would change.
const LOGICAL_TO_PHYSICAL: Readonly<
	Record<"ltr" | "rtl", Map<string, string>>
> = {ltr: new Map(), rtl: new Map()};

// Both inline longhands can name a physical edge. Which one does is not
// known until an element states its direction.
const PHYSICAL_TO_LOGICAL = new Map<string, readonly string[]>();

{
	const map = (logical: string, ltr: string, rtl = ltr) => {
		LOGICAL_TO_PHYSICAL.ltr.set(logical, ltr);
		LOGICAL_TO_PHYSICAL.rtl.set(logical, rtl);
		for (const physical of ltr === rtl ? [ltr] : [ltr, rtl]) {
			PHYSICAL_TO_LOGICAL.set(physical, [
				...(PHYSICAL_TO_LOGICAL.get(physical) ?? []),
				logical,
			]);
		}
	};
	for (const kind of ["margin", "padding"]) {
		map(`${kind}-block-start`, `${kind}-top`);
		map(`${kind}-block-end`, `${kind}-bottom`);
		map(`${kind}-inline-start`, `${kind}-left`, `${kind}-right`);
		map(`${kind}-inline-end`, `${kind}-right`, `${kind}-left`);
	}
	map("inset-block-start", "top");
	map("inset-block-end", "bottom");
	map("inset-inline-start", "left", "right");
	map("inset-inline-end", "right", "left");
	for (const component of LINE_COMPONENTS) {
		map(`border-block-start-${component}`, `border-top-${component}`);
		map(`border-block-end-${component}`, `border-bottom-${component}`);
		map(
			`border-inline-start-${component}`,
			`border-left-${component}`,
			`border-right-${component}`,
		);
		map(
			`border-inline-end-${component}`,
			`border-right-${component}`,
			`border-left-${component}`,
		);
	}
	// The flow-relative sizes name an axis and no edge, so `direction` does
	// not affect them. Only a vertical writing mode could.
	for (const prefix of ["", "min-", "max-"]) {
		map(`${prefix}block-size`, `${prefix}height`);
		map(`${prefix}inline-size`, `${prefix}width`);
	}
	// `grid-row-gap` and `grid-column-gap` are not flow-relative at all.
	// They are the OLD SPELLING of the gap properties (css-align-3 §8.4).
	// But sharing a cascade slot is what an alias is, so they are declared
	// here: one slot, under whichever name the winning declaration used.
	map("grid-row-gap", "row-gap");
	map("grid-column-gap", "column-gap");
}

export function isFlowRelative(property: string): boolean {
	return LOGICAL_TO_PHYSICAL.ltr.has(property);
}

// Whether the property shares its cascade slot with another name.
export function hasSlotAliases(property: string): boolean {
	return LOGICAL_TO_PHYSICAL.ltr.has(property) ||
		PHYSICAL_TO_LOGICAL.has(property);
}

export function getPhysicalProperty(
	property: string,
	direction: string,
): string | undefined {
	return LOGICAL_TO_PHYSICAL[direction === "rtl" ? "rtl" : "ltr"].get(property);
}

// The OTHER names of the cascade slot a longhand belongs to under
// `direction`. Empty for a longhand with no aliases.
export function getSlotNames(
	property: string,
	direction: string,
): readonly string[] {
	const physical = getPhysicalProperty(property, direction);
	if (physical) {
		return [physical];
	}
	const logical = PHYSICAL_TO_LOGICAL.get(property);
	if (!logical) {
		return [];
	}
	return logical.filter(
		(name) => getPhysicalProperty(name, direction) === property,
	);
}

// How a shorthand's value serializes, classified once.
type ShorthandShape =
	"box" |
	"radius" |
	"pair" |
	"line" |
	"border" |
	"grid-line" |
	"grid-template" |
	"sequence";

// In grammar order. The property index lists a box's sides
// alphabetically, but the grammar runs top, right, bottom, left.
const SHORTHAND_LONGHANDS = new Map<string, readonly string[]>();

const SHORTHAND_SHAPES = new Map<string, ShorthandShape>();

const GRID_LINE_SHORTHANDS = new Set(["grid-area", "grid-column", "grid-row"]);

// Longhands a shorthand resets but whose values its grammar cannot
// express. A block missing them cannot serialize as the shorthand.
const RESET_ONLY_LONGHANDS = new Map<string, ReadonlySet<string>>(
	Object.entries(CSS_RESET_ONLY_LONGHANDS).map(([shorthand, longhands]) => [
		shorthand,
		new Set(longhands),
	]),
);

for (const [shorthand, all] of Object.entries(CSS_SHORTHANDS)) {
	const reset = CSS_RESET_ONLY_LONGHANDS[shorthand];
	const indexed = reset
		? all.filter((longhand) => !reset.includes(longhand))
		: all;
	const box = getBoxOrder(indexed, EDGES) ?? getBoxOrder(indexed, CORNERS);
	const longhands = box ? [...box, ...(reset ?? [])] : all;
	SHORTHAND_LONGHANDS.set(shorthand, longhands);
	// A corner box whose longhands are radii writes its two axes around a
	// slash rather than one value per corner.
	const radius =
		box !== null && indexed.every((longhand) => longhand.endsWith("-radius"));
	SHORTHAND_SHAPES.set(
		shorthand,
		// The grid shorthands write their components around slashes, which no
		// other shorthand's grammar does.
		GRID_LINE_SHORTHANDS.has(shorthand)
			? "grid-line"
			: shorthand === "grid" || shorthand === "grid-template"
				? "grid-template"
				: box
					? radius
						? "radius"
						: "box" // A width, a style and a color stated once for several sides:
				// Four for `border`, the axis's two for `border-block` and
				// `border-inline`.
					: indexed.length >= 2 * LINE_COMPONENTS.length &&
						LINE_COMPONENTS.every(
							(kind) =>
								indexed.filter((longhand) => longhand.endsWith(`-${kind}`))
									.length ===
									indexed.length / LINE_COMPONENTS.length,
						)
						? "border"
						: indexed.length === LINE_COMPONENTS.length &&
							indexed.every((longhand, index) =>
								longhand.endsWith(`-${LINE_COMPONENTS[index]}`),
							)
							? "line"
							: indexed.length === 2 && axisPair(shorthand, indexed)
								? "pair"
								: "sequence",
	);
}

// ONE property on two axes (`gap`, `overflow`) rather than two side by
// side. An axis pair writes one value when its two agree. A shorthand
// like `flex-flow` instead drops components left at their initial value.
function axisPair(shorthand: string, longhands: readonly string[]): boolean {
	if (longhands.every((longhand) => longhand.startsWith(shorthand))) {
		return true;
	}
	const segment = shorthand.slice(shorthand.lastIndexOf("-") + 1);
	return longhands.every((longhand) => longhand.endsWith(`-${segment}`));
}

// Widest first, with `all` first of all. A vendor-prefixed shorthand
// goes last however wide, since it is not the name to write its
// longhands as.
const LONGHAND_SHORTHANDS = new Map<string, readonly string[]>();

/** A shorthand's longhands in grammar order, or undefined for a longhand. */
export function getLonghands(shorthand: string): readonly string[] | undefined {
	return SHORTHAND_LONGHANDS.get(shorthand);
}

/** The shorthands that cover a longhand, widest first. */
export function getShorthands(longhand: string): readonly string[] {
	return LONGHAND_SHORTHANDS.get(longhand) ?? [];
}

{
	const byLonghand = new Map<string, string[]>();
	for (const [shorthand, longhands] of SHORTHAND_LONGHANDS) {
		for (const longhand of longhands) {
			let shorthands = byLonghand.get(longhand);
			if (!shorthands) {
				byLonghand.set(longhand, (shorthands = []));
			}
			shorthands.push(shorthand);
		}
	}
	for (const [longhand, shorthands] of byLonghand) {
		shorthands.sort(
			(a, b) =>
				Number(a.startsWith("-")) - Number(b.startsWith("-")) ||
				SHORTHAND_LONGHANDS.get(b)!.length -
				SHORTHAND_LONGHANDS.get(a)!.length ||
				(a < b ? -1 : 1),
		);
		LONGHAND_SHORTHANDS.set(longhand, shorthands);
	}
}

function supportsCondition(text: string): boolean {
	let nodes: CSSTree.SupportsNode[];
	try {
		const ast = CSSTree.parse(text, {
			context: "atrulePrelude",
			atrule: "supports",
			positions: true,
		}) as unknown as {children?: {toArray(): CSSTree.SupportsNode[]} | null};
		nodes = ast.children ? ast.children.toArray() : [];
	} catch (_err) {
		return false;
	}
	if (nodes.length !== 1 || nodes[0].type !== "Condition") {
		return false;
	}
	return supportsConditionMatches(nodes[0], text);
}

// css-conditional-3's grammar is narrow: `not` opens its own condition,
// a joined condition uses `and` throughout or `or` throughout, and
// operands and joiners alternate. A condition outside that grammar
// supports nothing.
function supportsConditionMatches(
	condition: CSSTree.SupportsNode,
	source: string,
): boolean {
	let matches: boolean | null = null;
	let joiner: string | null = null;
	let negate = false;
	let awaited = true;
	for (const part of condition.children?.toArray() ?? []) {
		if (part.type === "Identifier") {
			const word = (part.name ?? "").toLowerCase();
			if (word === "not") {
				if (matches !== null || negate || !awaited) {
					return false;
				}
				negate = true;
				continue;
			}
			if ((word !== "and" && word !== "or") || awaited) {
				return false;
			}
			if (joiner !== null && joiner !== word) {
				return false;
			}
			joiner = word;
			awaited = true;
			continue;
		}
		if (!awaited || (joiner !== null && matches === null)) {
			return false;
		}
		let operand = supportsOperandMatches(part, source);
		if (negate) {
			operand = !operand;
		}
		matches =
			matches === null
				? operand
				: joiner === "or" ? matches || operand : matches && operand;
		awaited = false;
	}
	// A negated operand is a whole condition, so nothing may be joined to
	// it.
	if (awaited || matches === null || (negate && joiner !== null)) {
		return false;
	}
	return matches;
}

// A condition of any other shape (font-format(), font-tech()) is not
// supported.
function supportsOperandMatches(
	part: CSSTree.SupportsNode,
	source: string,
): boolean {
	const sliceOf = (
		node: CSSTree.SupportsNode | null | undefined,
	): string | null =>
		node?.loc ? source.slice(node.loc.start.offset, node.loc.end.offset) : null;
	if (part.type === "Condition") {
		return supportsConditionMatches(part, source);
	}
	if (part.type === "SupportsDeclaration") {
		const value = sliceOf(part.declaration?.value);
		return (
			value !== null && cssSupports(part.declaration?.property ?? "", value)
		);
	}
	// `selector(...)` asks whether a selector parses, which is exactly what
	// the cascade's own selector parser decides.
	if (part.type === "FeatureFunction" && part.feature === "selector") {
		const selector = sliceOf(part.value);
		return selector !== null && parseSelectorList(selector) !== null;
	}
	return false;
}

// The one-argument form parses its text as a condition, and failing
// that, as a condition with the parentheses left off. That is
// css-conditional-3's pair of steps.
export function cssSupports(
	conditionOrProperty: string,
	value?: string,
): boolean {
	if (value === undefined) {
		const condition = String(conditionOrProperty).trim();
		return supportsCondition(condition) || supportsCondition(`(${condition})`);
	}
	const property = normalizePropertyName(conditionOrProperty);
	if (property.startsWith("--")) {
		return true;
	}
	if (!SUPPORTED_PROPERTIES.has(property)) {
		return false;
	}
	const text = serializeCSSValue(String(value), property);
	return text !== "" && isValidDeclaration(property, text);
}

// Longhands the grammar leaves out reset to their initial value, as a
// browser's shorthand write does. Null for a grammar this engine does
// not decompose, which stays a declaration of its own.
export function expandShorthandValue(
	property: string,
	value: string,
): Record<string, string> | null {
	const longhands = SHORTHAND_LONGHANDS.get(property);
	if (!longhands) {
		return null;
	}
	// A CSS-wide keyword is the whole value of every longhand the shorthand
	// covers, which for `all` is all of them.
	if (CSS_WIDE_KEYWORDS.has(value.toLowerCase())) {
		return Object.fromEntries(
			longhands.map((longhand) => [longhand, value.toLowerCase()]),
		);
	}
	const expanded = expandShorthands({[property]: value});
	const out: Record<string, string> = {};
	let decomposed = false;
	for (const longhand of longhands) {
		if (expanded[longhand] === undefined) {
			continue;
		}
		out[longhand] = expanded[longhand];
		decomposed = true;
	}
	if (!decomposed) {
		return null;
	}
	for (const longhand of longhands) {
		if (longhand in out) {
			continue;
		}
		const initial = CSS_INITIAL_VALUES[longhand];
		if (initial) {
			out[longhand] = initial;
		}
	}
	// Longhand order follows the shorthand's grammar, not the fill order.
	const ordered: Record<string, string> = {};
	for (const longhand of longhands) {
		if (longhand in out) {
			ordered[longhand] = out[longhand];
		}
	}
	return ordered;
}

function getRadiusAxes(value: string): [string, string] {
	const [horizontal, vertical = horizontal] = value
		.split(/\s+/)
		.filter(Boolean);
	return [horizontal ?? "0px", vertical ?? "0px"];
}

function collapseSides(values: string[]): string {
	const [top, right, bottom, left] = values;
	if (left !== right) {
		return `${top} ${right} ${bottom} ${left}`;
	}
	if (bottom !== top) {
		return `${top} ${right} ${bottom}`;
	}
	if (right !== top) {
		return `${top} ${right}`;
	}
	return top;
}

// The longhands grouped by the side or corner each names, in grammar
// order. Null when they are not a box.
function getBoxOrder(
	longhands: readonly string[],
	parts: readonly string[],
): string[] | null {
	if (longhands.length !== parts.length) {
		return null;
	}
	const byPart = new Map<string, string>();
	let stem: string | null = null;
	for (const longhand of longhands) {
		let matched: string | null = null;
		for (const part of parts) {
			const pattern = new RegExp(`(^|-)${part}(-|$)`);
			if (!pattern.test(longhand)) {
				continue;
			}
			if (matched === null || part.length > matched.length) {
				matched = part;
			}
		}
		if (matched === null) {
			return null;
		}
		const rest = longhand.replace(new RegExp(`(^|-)${matched}(-|$)`), "$1$2");
		if (stem === null) {
			stem = rest;
		} else if (stem !== rest) {
			return null;
		}
		if (byPart.has(matched)) {
			return null;
		}
		byPart.set(matched, longhand);
	}
	const ordered = parts.map((part) => byPart.get(part));
	return ordered.every((name): name is string => name !== undefined)
		? ordered
		: null;
}

export function serializeShorthandValue(
	shorthand: string,
	longhands: readonly string[],
	valueOf: (longhand: string) => string,
): string {
	const all = longhands.map(valueOf);
	// A CSS-wide keyword serializes as itself only when every longhand
	// holds the same one. If one longhand is overridden, the shorthand has
	// no value.
	if (all.some((value) => CSS_WIDE_KEYWORDS.has(value))) {
		return all.every((value) => value === all[0]) ? all[0] : "";
	}

	// A longhand the shorthand resets without stating (border-image under
	// `border`) takes no place in the written value, and if it holds a value
	// the shorthand cannot express, the shorthand cannot be written at all.
	const reset = RESET_ONLY_LONGHANDS.get(shorthand);
	if (reset) {
		for (const longhand of longhands) {
			if (
				reset.has(longhand) &&
				valueOf(longhand) !== CSS_INITIAL_VALUES[longhand]
			) {
				return "";
			}
		}
	}
	const stated = reset
		? longhands.filter((longhand) => !reset.has(longhand))
		: longhands;
	const values = reset ? stated.map(valueOf) : all;

	// css-fonts-4 §6.1: `none` is font-variant-ligatures alone, and no
	// shorthand spells `none` beside another longhand's value.
	if (shorthand === "font-variant") {
		const at = (longhand: string): string =>
			values[stated.indexOf(longhand)] ?? "normal";
		const rest = stated
			.filter((longhand) => longhand !== "font-variant-ligatures")
			.map(at);
		if (at("font-variant-ligatures") === "none") {
			return rest.every((value) => value === "normal") ? "none" : "";
		}
		const spelled = stated.map(at).filter((value) => value !== "normal");
		return spelled.length > 0 ? spelled.join(" ") : "normal";
	}

	switch (SHORTHAND_SHAPES.get(shorthand)) {
		case "box":
			return collapseSides(values);
		// `border-radius` writes the four horizontal radii, then the four
		// vertical ones after a slash, and drops the slash entirely when the
		// two axes agree, which is every circular corner.
		case "radius": {
			const axes = values.map(getRadiusAxes);
			const across = collapseSides(axes.map(([horizontal]) => horizontal));
			const down = collapseSides(axes.map(([, vertical]) => vertical));
			return across === down ? across : `${across} / ${down}`;
		}
		// `border` and its logical twins are three uniform boxes (widths,
		// styles, colors) and serialize only when every side agrees.
		case "border": {
			const components: Array<[string, string]> = [];
			for (const kind of LINE_COMPONENTS) {
				const sides = stated.filter((longhand) =>
					longhand.endsWith(`-${kind}`),
				);
				const sideValues = sides.map(valueOf);
				if (sideValues.some((value) => value !== sideValues[0])) {
					return "";
				}
				components.push([sides[0], sideValues[0]]);
			}
			return dropInitials(components);
		}
		// `border-top`, `outline`, `column-rule`: a line's width, style and
		// color.
		case "line":
			return dropInitials(
				stated.map((longhand, index) => [longhand, values[index]] as const),
			);
		case "pair":
			return values[0] === values[1] ? values[0] : values.join(" ");
		// css-grid-2 §8.4: the components run start / end (and for `grid-area`,
		// both axes of each). A trailing component is dropped when it states
		// the value the omission already implies: the opposite component when
		// that is a name, and `auto` otherwise.
		case "grid-line": {
			const implied = (from: string): string =>
				isCustomIdent(from) ? from : "auto";
			const kept = [...values];
			// grid-area's four are [row-start, column-start, row-end,
			// column-end]. The pair shorthands' two are [start, end].
			const from = kept.length === 4 ? [-1, 0, 0, 1] : [-1, 0];
			while (kept.length > 1) {
				const index = kept.length - 1;
				if (kept[index] !== implied(values[from[index]])) {
					break;
				}
				kept.pop();
			}
			return kept.join(" / ");
		}
		// `grid-template` writes its rows and columns around a slash. Its third
		// form, the picture of the grid with strings and row sizes interleaved,
		// states an area map, and no rows-and-columns spelling can express one.
		// A block holding one serializes as its longhands.
		case "grid-template": {
			const at = (longhand: string): string =>
				values[stated.indexOf(longhand)] ?? "";
			if (at("grid-template-areas") !== "none") {
				return "";
			}
			for (const longhand of stated) {
				if (longhand.startsWith("grid-auto-")) {
					if (at(longhand) !== CSS_INITIAL_VALUES[longhand]) {
						return "";
					}
				}
			}
			const rows = at("grid-template-rows");
			const columns = at("grid-template-columns");
			if (rows === "none" && columns === "none") {
				return "none";
			}
			return `${rows} / ${columns}`;
		}
		default:
			return dropInitials(
				stated.map((longhand, index) => [longhand, values[index]] as const),
			);
	}
}

// This is what makes `border-top: 1px solid` serialize without its
// color.
function dropInitials(
	components: ReadonlyArray<readonly [string, string]>,
): string {
	const kept = components
		.filter(([longhand, value]) => {
			const initial = CSS_INITIAL_VALUES[longhand];
			return !initial || value !== initial;
		})
		.map(([, value]) => value);
	if (kept.length > 0) {
		return kept.join(" ");
	}
	return components.length > 0 ? components[0][1] : "";
}

// font-size to fontSize. With lowercaseFirst, -webkit-mask to
// webkitMask.
export function camelCaseProperty(
	property: string,
	lowercaseFirst = false,
): string {
	const source = lowercaseFirst ? property.slice(1) : property;
	return source.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
}

export function parseDeclarationText(text: string): CSSDeclaration[] {
	const declarations: CSSDeclaration[] = [];
	let depth = 0;
	let start = 0;
	const push = (end: number): void => {
		const source = text.slice(start, end);
		start = end + 1;
		const colon = source.indexOf(":");
		if (colon === -1) {
			return;
		}
		const name = parsePropertyName(source.slice(0, colon));
		if (!name) {
			return;
		}
		let value = serializeCSSValue(source.slice(colon + 1), name);
		let important = false;
		// `!` and `important` are two tokens, and whitespace or a comment may
		// come between them.
		const bang = /!\s*important\s*$/i.exec(value);
		if (bang) {
			important = true;
			value = value.slice(0, bang.index).trim();
		}
		if (!value) {
			return;
		}
		declarations.push({name, value, important});
	};
	for (let i = 0; i < text.length; i++) {
		const character = text[i];
		if (character === "\\") {
			i++;
		} else if (character === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 1;
		} else if (character === '"' || character === "'") {
			for (i++; i < text.length && text[i] !== character; i++) {
				if (text[i] === "\\") {
					i++;
				}
			}
		} else if (character === "(" || character === "[" || character === "{") {
			depth++;
		} else if (character === ")" || character === "]" || character === "}") {
			depth--;
		} else if (character === ";" && depth <= 0) {
			push(i);
		}
	}
	push(text.length);
	return declarations;
}

// Custom properties keep their case. Everything else is
// ASCII-lowercased.
export function normalizePropertyName(property: string): string {
	const name = String(property).trim();
	if (name.startsWith("--")) {
		return name;
	}
	const lower = name.toLowerCase();
	return LEGACY_PROPERTY_ALIASES.get(lower) ?? lower;
}

// A legacy name that is the same property under its standard name, so a
// declaration made through it serializes as the standard one.
const LEGACY_PROPERTY_ALIASES = new Map([["-webkit-line-clamp", "line-clamp"]]);

// Escapes in a custom property's name spell characters that could not
// otherwise appear. The source `--a\;b` names the property `--a;b`.
function parsePropertyName(source: string): string {
	const name = String(source).trim();
	if (!name.startsWith("--")) {
		return normalizePropertyName(name);
	}
	return name.includes("\\")
		? `--${CSSTree.ident.decode(name.slice(2))}`
		: name;
}

// A custom property's name is escaped so reparsing names the same
// property.
export function serializePropertyName(property: string): string {
	return property.startsWith("--")
		? `--${serializeCSSIdentifier(property.slice(2))}`
		: property;
}

// A comment can appear anywhere whitespace can, so it becomes a space.
// Media text is sliced by hand here, and a comment left in would be
// carried into a feature's parentheses and unbalance them.
export function stripCSSComments(text: string): string {
	if (!text.includes("/*")) {
		return text;
	}
	let out = "";
	let quote = "";
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (quote) {
			if (character === quote) {
				quote = "";
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character !== "/" || text[index + 1] !== "*") {
			continue;
		}
		out += `${text.slice(start, index)} `;
		const close = text.indexOf("*/", index + 2);
		if (close === -1) {
			return out;
		}
		index = close + 1;
		start = index + 1;
	}
	return out + text.slice(start);
}

function splitMediaConditions(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === "(") {
			depth++;
		} else if (character === ")") {
			depth--;
		} else if (depth === 0 && WHITESPACE.has(character)) {
			const joiner = /^\s+and\s+/i.exec(text.slice(index));
			if (!joiner) {
				continue;
			}
			parts.push(text.slice(start, index));
			index += joiner[0].length - 1;
			start = index + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.map((part) => part.trim()).filter(Boolean);
}

function serializeMediaFeature(feature: string): string {
	const body = feature.slice(1, -1).trim();
	const colon = body.indexOf(":");
	if (colon === -1) {
		return `(${body.toLowerCase()})`;
	}
	const name = body.slice(0, colon).trim().toLowerCase();
	return `(${name}: ${serializeCSSValue(body.slice(colon + 1))})`;
}

// For text css-tree rejects. It passes through as authored, case-folded,
// so a list keeps carrying queries this engine cannot evaluate.
function serializeMediaQueryText(text: string): string {
	const parts = splitMediaConditions(text);
	if (parts.length === 0) {
		return "";
	}
	let head = parts[0];
	let modifier = "";
	const prefixed = /^(not|only)\s+([^]*)$/i.exec(head);
	if (prefixed) {
		modifier = `${prefixed[1].toLowerCase()} `;
		head = prefixed[2].trim();
	}
	const conditions = parts
		.slice(1)
		.map((part) =>
			part.startsWith("(") ? serializeMediaFeature(part) : part.toLowerCase(),
		);
	if (head.startsWith("(")) {
		return (
			modifier + [serializeMediaFeature(head), ...conditions].join(" and ")
		);
	}
	const type = head.toLowerCase();
	if (type === "all" && !modifier && conditions.length > 0) {
		return conditions.join(" and ");
	}
	return modifier + [type, ...conditions].join(" and ");
}

// One parse per spelling, with positions. Serialization slices the
// authored text at them.
const mediaQueryNodes = new Map<string, CSSTree.MediaQueryNode[] | null>();

export function getMediaConditionParts(
	condition: CSSTree.MediaConditionNode | null | undefined,
): CSSTree.MediaConditionNode[] {
	return condition?.children ? condition.children.toArray() : [];
}

export function parseMediaQueryList(text: string): CSSTree.MediaQueryNode[] |
	null {
	let queries = mediaQueryNodes.get(text);
	if (queries === undefined) {
		try {
			const ast = CSSTree.parse(text, {
				context: "mediaQueryList",
				positions: true,
			}) as unknown as {children: {toArray(): CSSTree.MediaQueryNode[]}};
			queries = ast.children.toArray();
		} catch (_err) {
			queries = null;
		}
		if (mediaQueryNodes.size > 1024) {
			mediaQueryNodes.clear();
		}
		mediaQueryNodes.set(text, queries);
	}
	return queries;
}

// The spelling CSSOM writes: names case-folded, and the media type
// dropped where it says nothing (`all and (color)` is `(color)`).
// Structure comes from the parsed nodes. Each condition's TEXT is still
// sliced from the authored source, and text css-tree rejects uses the
// splitter above.
export function serializeMediaQuery(query: string): string {
	const text = stripCSSComments(String(query ?? "")).trim();
	if (!text) {
		return "";
	}
	if (text.includes("\\")) {
		return serializeMediaQueryText(text);
	}
	const queries = parseMediaQueryList(text);
	if (!queries || queries.length !== 1) {
		return serializeMediaQueryText(text);
	}
	const parsed = queries[0];
	let modifier = parsed.modifier ? `${parsed.modifier.toLowerCase()} ` : "";
	const type = parsed.mediaType ? parsed.mediaType.toLowerCase() : null;
	// css-tree tolerates shapes the splitter treats as opaque text (a
	// missing `and`, a dangling word), so the source is re-walked alongside
	// the nodes, and a query whose parts are not separated by ` and ` keeps
	// the splitter's result.
	let cursor = 0;
	if (parsed.modifier) {
		const head = /^(?:not|only)\s+/i.exec(text);
		if (!head) {
			return serializeMediaQueryText(text);
		}
		cursor = head[0].length;
	}
	if (parsed.mediaType) {
		if (!text.startsWith(parsed.mediaType, cursor)) {
			return serializeMediaQueryText(text);
		}
		cursor += parsed.mediaType.length;
	}
	const conditions: string[] = [];
	// What may appear at the cursor: the first part, the joiner a feature
	// expects, or the feature a joiner or bare `not` requires.
	let expected: "first" | "feature" | "joiner" = "first";
	for (const part of getMediaConditionParts(parsed.condition)) {
		if (!part.loc) {
			return serializeMediaQueryText(text);
		}
		const gap = text.slice(cursor, part.loc.start.offset);
		cursor = part.loc.end.offset;
		if (part.type === "Identifier") {
			const word = (part.name ?? "").toLowerCase();
			// A leading `not` is the query's modifier, as the splitter treated
			// it. `and` joins. Any other bare word is a shape the splitter
			// divides differently.
			if (word === "not" && expected === "first" && !modifier && !type) {
				if (gap !== "") {
					return serializeMediaQueryText(text);
				}
				modifier = "not ";
			} else if (word === "and" && expected === "joiner") {
				if (!/^\s+$/.test(gap)) {
					return serializeMediaQueryText(text);
				}
			} else {
				return serializeMediaQueryText(text);
			}
			expected = "feature";
			continue;
		}
		const wellGapped =
			expected === "joiner"
				? false
				: expected === "feature"
					? /^\s+$/.test(gap)
					: type !== null ? /^\s+and\s+$/i.test(gap) : gap === "";
		if (!wellGapped) {
			return serializeMediaQueryText(text);
		}
		if (
			part.type !== "Feature" &&
			part.type !== "FeatureRange" &&
			part.type !== "GeneralEnclosed" &&
			part.type !== "Condition"
		) {
			return serializeMediaQueryText(text);
		}
		const slice = text.slice(part.loc.start.offset, part.loc.end.offset);
		// A part that opens with anything but a parenthesis (`not(color)`
		// parses as an enclosed function) is one the splitter treated as text.
		if (part.type !== "Condition" && !slice.startsWith("(")) {
			return serializeMediaQueryText(text);
		}
		conditions.push(
			serializeMediaFeature(part.type === "Condition" ? `(${slice})` : slice),
		);
		expected = "joiner";
	}
	if (expected === "feature" || cursor < text.length) {
		return serializeMediaQueryText(text);
	}
	if (type === null) {
		return modifier + conditions.join(" and ");
	}
	if (type === "all" && !modifier && conditions.length > 0) {
		return conditions.join(" and ");
	}
	return modifier + [type, ...conditions].join(" and ");
}

export function splitMediaQueryList(text: string): string[] {
	const queries: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === "(") {
			depth++;
		} else if (character === ")") {
			depth--;
		} else if (character === "," && depth === 0) {
			queries.push(text.slice(start, index));
			start = index + 1;
		}
	}
	queries.push(text.slice(start));
	return queries;
}

// A prefix no `@namespace` declared names no namespace, and a selector
// using one does not parse. The prefixes stay in the selector, and the
// matcher resolves them against the sheet's map.
export function namespacePrefixesDeclared(
	selector: string,
	namespaces: SelectorNamespaces | undefined,
): boolean {
	try {
		compileSelector(selector, {namespaces, pseudoElements: true});
		return true;
	} catch (_err) {
		return false;
	}
}

/** The page pseudo-classes a `@page` selector may name. */
const PAGE_PSEUDO_CLASSES = new Set(["blank", "first", "left", "right"]);

/**
 * A page selector (an optional page name followed by page pseudo-classes,
 * with no whitespace between them), or "" when it names no valid page.
 */
export function serializePageSelector(selector: string): string {
	const text = String(selector).trim();
	if (!text) {
		return "";
	}
	const match = /^([^\s:]*)((?::[^\s:]+)*)$/.exec(text);
	if (!match) {
		return "";
	}
	const pseudos = match[2] ? match[2].slice(1).split(":") : [];
	for (const pseudo of pseudos) {
		if (!PAGE_PSEUDO_CLASSES.has(pseudo.toLowerCase())) {
			return "";
		}
	}
	const name = match[1] ? serializeCSSIdentifier(match[1]) : "";
	return name + pseudos.map((pseudo) => `:${pseudo.toLowerCase()}`).join("");
}

// `from` is 0%, `to` is 100%.
export function serializeKeyText(text: string): string {
	const source = String(text).trim();
	let list: {
		loc?: CSSTree.Span | null;
		children: {toArray(): CSSTree.ValueNode[]};
	};
	try {
		list = CSSTree.parse(source, {
			context: "selectorList",
			positions: true,
			onParseError(error: Error) {
				throw error;
			},
		}) as never;
	} catch (_err) {
		return "";
	}
	// css-tree lets a selector list trail off after its last selector, but
	// a keyframe selector list may not, so the nodes have to span the text.
	if (list.loc?.end.offset !== source.length) {
		return "";
	}
	const selectors = list.children.toArray();
	if (selectors.length === 0) {
		return "";
	}
	const keys: string[] = [];
	for (const selector of selectors) {
		const parts = selector.children?.toArray() ?? [];
		if (parts.length !== 1) {
			return "";
		}
		const [key] = parts;
		if (key.type === "Percentage") {
			keys.push(`${serializeCSSNumber(key.value ?? "")}%`);
			continue;
		}
		const word = key.type === "TypeSelector"
			? (key.name ?? "").toLowerCase()
			: "";
		if (word === "from") {
			keys.push("0%");
		} else if (word === "to") {
			keys.push("100%");
		} else {
			return "";
		}
	}
	return keys.join(", ");
}

// `none`, `and`, `or` and `not` name no container, so a prelude opening
// with one of those words is a query alone, as is a prelude outside the
// grammar.
export function getContainerParts(prelude: string): {
	name: string;
	query: string;
} {
	let nodes: CSSTree.ContainerPreludeNode[] = [];
	try {
		const ast = CSSTree.parse(prelude, {
			context: "atrulePrelude",
			atrule: "container",
			positions: true,
		}) as unknown as {
			children?: {toArray(): CSSTree.ContainerPreludeNode[]} | null;
		};
		nodes = ast.children ? ast.children.toArray() : [];
	} catch (_err) {
		return {name: "", query: prelude};
	}
	const head = nodes[0];
	if (head?.type !== "Identifier" || !head.loc) {
		return {name: "", query: prelude};
	}
	return {
		name: head.name ?? "",
		query: prelude.slice(head.loc.end.offset).trim(),
	};
}

// Both null for a prelude outside the grammar. The limit alone for the
// implicit `@scope to (...)`.
export function getScopeLimits(prelude: string): {
	start: string | null;
	end: string | null;
} {
	let scope: CSSTree.ScopePreludeNode | undefined;
	try {
		const ast = CSSTree.parse(prelude, {
			context: "atrulePrelude",
			atrule: "scope",
			positions: true,
		}) as unknown as {
			children?: {toArray(): CSSTree.ScopePreludeNode[]} | null;
		};
		const nodes = ast.children ? ast.children.toArray() : [];
		if (nodes.length === 1 && nodes[0].type === "Scope") {
			scope = nodes[0];
		}
	} catch (_err) {
		scope = undefined;
	}
	const sliceOf = (node: CSSTree.ScopePreludeNode | null | undefined): string |
		null =>
		node?.loc
			? prelude.slice(node.loc.start.offset, node.loc.end.offset)
			: null;
	return {start: sliceOf(scope?.root), end: sliceOf(scope?.limit)};
}

function serializeQualifiedName(
	name: string,
	namespaces: SelectorNamespaces | undefined,
	attribute = false,
): string {
	const bar = name.lastIndexOf("|");
	const local = bar === -1 ? name : name.slice(bar + 1);
	const prefix = bar === -1 ? null : name.slice(0, bar);
	const localText = local === "*" ? "*" : serializeIdentifierSource(local);
	if (prefix === null) {
		return localText;
	}
	// A prefix is written only where it says something an unprefixed name
	// does not. `*|E` means "any namespace", which is what `E` already means
	// with no default namespace declared, and a prefix bound to the default
	// namespace resolves to the same namespace `E` does.
	const declared = namespaces?.default ?? null;
	if (prefix === "*") {
		return declared === null && !attribute ? localText : `*|${localText}`;
	}
	if (prefix === "") {
		// `|E` means "no namespace", which a bare `E` never means, whether or
		// not a default namespace was declared, so the bar stays. An attribute
		// is the exception: an unprefixed attribute is already in no namespace,
		// so `[|attr]` and `[attr]` are the same selector.
		return attribute ? localText : `|${localText}`;
	}
	const decoded = CSSTree.ident.decode(prefix);
	if (
		!attribute &&
		declared !== null &&
		namespaces?.prefixes.get(decoded) === declared
	) {
		return localText;
	}
	return `${serializeCSSIdentifier(decoded)}|${localText}`;
}

// selectors-4 §17: ids, then classes/attributes/pseudo-classes, then
// types/pseudo-elements.
type Specificity = [number, number, number];

// Their weight is their most specific argument's. The name itself
// counts nothing.
const ARGUMENT_WEIGHTED_PSEUDO_CLASSES = new Set([
	"has",
	"is",
	"matches",
	"not",
	"-moz-any",
	"-webkit-any",
]);

// Weigh as a class AND add their most specific argument's weight.
const COMPOUND_WEIGHTED_PSEUDO_CLASSES = new Set([
	"host",
	"host-context",
	"nth-child",
	"nth-last-child",
]);

function getListSpecificity(list: CSSTree.SelectorNode): Specificity {
	let most: Specificity = [0, 0, 0];
	for (const selector of getChildren(list)) {
		const weight = getSelectorSpecificity(selector);
		if (
			weight[0] > most[0] ||
			(weight[0] === most[0] &&
				(weight[1] > most[1] || (weight[1] === most[1] && weight[2] > most[2])))
		) {
			most = weight;
		}
	}
	return most;
}

function getSelectorSpecificity(selector: CSSTree.SelectorNode): Specificity {
	const total: Specificity = [0, 0, 0];
	const add = (weight: Specificity): void => {
		total[0] += weight[0];
		total[1] += weight[1];
		total[2] += weight[2];
	};
	const argumentWeight = (node: CSSTree.SelectorNode): Specificity => {
		for (const child of getChildren(node)) {
			if (child.type === "SelectorList") {
				return getListSpecificity(child);
			}
			if (child.type === "Selector") {
				return getSelectorSpecificity(child);
			}
			if (child.type === "Nth" && child.selector) {
				return getListSpecificity(child.selector);
			}
		}
		return [0, 0, 0];
	};
	for (const part of getChildren(selector)) {
		switch (part.type) {
			case "IdSelector":
				total[0]++;
				break;
			case "ClassSelector":
			case "AttributeSelector":
				total[1]++;
				break;
			// The universal selector weighs nothing, in any namespace.
			case "TypeSelector": {
				const name = String(part.name ?? "");
				if (!name.endsWith("*")) {
					total[2]++;
				}
				break;
			}
			// `::slotted(.a)` and `::part(name)`: the pseudo-element weighs as
			// an element, and a compound argument adds to that.
			case "PseudoElementSelector":
				total[2]++;
				add(argumentWeight(part));
				break;
			case "PseudoClassSelector": {
				const name = pseudoName(String(part.name ?? ""));
				// `:before` is the CSS 2 spelling of a pseudo-element, and
				// weighs as one.
				if (isLegacyPseudoElement(name)) {
					total[2]++;
					break;
				}
				// `:where()` contributes nothing at all, arguments included.
				if (name === "where") {
					break;
				}
				if (ARGUMENT_WEIGHTED_PSEUDO_CLASSES.has(name)) {
					add(argumentWeight(part));
					break;
				}
				total[1]++;
				if (COMPOUND_WEIGHTED_PSEUDO_CLASSES.has(name)) {
					add(argumentWeight(part));
				}
				break;
			}
		}
	}
	return total;
}

// A selector testing one of these on an ancestor affects the ancestor's
// descendants when the attribute behind it changes, and no attribute
// NAME in the selector reveals that.
const STATE_PSEUDO_CLASSES = new Set([
	"any-link",
	"checked",
	"closed",
	"default",
	"defined",
	"disabled",
	"enabled",
	"in-range",
	"indeterminate",
	"invalid",
	"link",
	"open",
	"optional",
	"out-of-range",
	"placeholder-shown",
	"popover-open",
	"read-only",
	"read-write",
	"required",
	"target",
	"valid",
	"visited",
]);

// The attributes those state pseudo-classes depend on.
const STATE_ATTRIBUTES = new Set([
	"checked",
	"disabled",
	"href",
	"id",
	"max",
	"min",
	"multiple",
	"open",
	"pattern",
	"placeholder",
	"popover",
	"readonly",
	"required",
	"selected",
	"type",
	"value",
]);

export function isStateAttribute(name: string): boolean {
	return STATE_ATTRIBUTES.has(name);
}

// A change to a key a compound names can change whether the compound
// matches.
interface CompoundKeys {
	classes: string[];
	ids: string[];
	attributes: string[];
	states: boolean;
}

// The subject is the last compound.
export interface SelectorReading {
	specificity: string;
	subjectTag: string | undefined;
	compounds: CompoundKeys[];
	// Whether a match depends on the element's siblings or children: the
	// sibling combinators, the tree-structural pseudo-classes and :empty.
	reachesSiblings: boolean;
}

// Includes pseudo-class arguments. A class inside :not() or :is() is
// tested on the compound around it.
function harvestKeys(nodes: CSSTree.SelectorNode[], keys: CompoundKeys): void {
	for (const node of nodes) {
		switch (node.type) {
			case "ClassSelector":
				keys.classes.push(CSSTree.ident.decode(String(node.name ?? "")));
				break;
			case "IdSelector":
				keys.ids.push(CSSTree.ident.decode(String(node.name ?? "")));
				break;
			case "AttributeSelector": {
				const qualified = (node.name as {name: string} | undefined)?.name;
				const name = String(qualified ?? "");
				// An unprefixed attribute is in no namespace, and a prefixed
				// one is keyed by the local name a mutation reports.
				keys.attributes.push(
					CSSTree.ident.decode(name.slice(name.indexOf("|") + 1)).toLowerCase(),
				);
				break;
			}
			case "PseudoClassSelector":
				if (STATE_PSEUDO_CLASSES.has(pseudoName(String(node.name ?? "")))) {
					keys.states = true;
				}
				harvestKeys(getChildren(node), keys);
				break;
			case "PseudoElementSelector":
			case "SelectorList":
			case "Selector":
				harvestKeys(getChildren(node), keys);
				break;
			case "Nth":
				if (node.selector) {
					harvestKeys([node.selector], keys);
				}
				break;
		}
	}
}

// A selector this parser cannot read weighs nothing. The matcher reads
// a wider grammar and may still accept it, and a rule whose weight
// cannot be counted should lose a tie. It anchors to no type and names
// no keys.
export function readSelector(selector: string): SelectorReading {
	const reachesSiblings = SIBLING_SELECTOR.test(selector);
	let failed = false;
	let list: CSSTree.SelectorNode | null = null;
	try {
		list = CSSTree.parse(selector, {
			context: "selectorList",
			onParseError() {
				failed = true;
			},
		}) as unknown as CSSTree.SelectorNode;
	} catch (_err) {
		failed = true;
	}
	if (failed || !list || list.type !== "SelectorList") {
		return {
			specificity: "000-000-000",
			subjectTag: undefined,
			compounds: [],
			reachesSiblings,
		};
	}
	const weight = getListSpecificity(list);
	const specificity = weight
		.map((count) => String(count).padStart(3, "0"))
		.join("-");
	const complex = getChildren(list).find((child) => child.type === "Selector");
	const compounds: CompoundKeys[] = [];
	let parts: CSSTree.SelectorNode[] = [];
	const closeCompound = (): void => {
		const keys: CompoundKeys = {
			classes: [],
			ids: [],
			attributes: [],
			states: false,
		};
		harvestKeys(parts, keys);
		compounds.push(keys);
		parts = [];
	};
	for (const part of complex ? getChildren(complex) : []) {
		if (part.type === "Combinator") {
			closeCompound();
		} else {
			parts.push(part);
		}
	}
	closeCompound();
	return {
		specificity,
		subjectTag: getSubjectTag(complex),
		compounds,
		reachesSiblings,
	};
}

// Undefined when the subject names no type, including a type in a
// namespace, which the matcher resolves against the namespaces the sheet
// bound.
function getSubjectTag(complex: CSSTree.SelectorNode | undefined): string |
	undefined {
	if (!complex) {
		return undefined;
	}
	let type: CSSTree.SelectorNode | undefined;
	for (const part of getChildren(complex)) {
		if (part.type === "Combinator") {
			type = undefined;
		} else if (part.type === "TypeSelector" && type === undefined) {
			type = part;
		}
	}
	const name = type ? String(type.name ?? "") : "";
	if (!name || name.includes("|") || name.endsWith("*")) {
		return undefined;
	}
	return CSSTree.ident.decode(name).toLowerCase();
}

function serializeIdentifierSource(name: string): string {
	return serializeCSSIdentifier(CSSTree.ident.decode(name));
}

export function serializeSelectorList(
	list: CSSTree.SelectorNode,
	namespaces?: SelectorNamespaces,
): string {
	return getChildren(list)
		.map((selector) => serializeSelector(selector, namespaces))
		.join(", ");
}

function serializeSelector(
	selector: CSSTree.SelectorNode,
	namespaces: SelectorNamespaces | undefined,
): string {
	let out = "";
	const parts = getChildren(selector);
	for (const [index, part] of parts.entries()) {
		// A universal selector adds nothing to the compound around it, so it is
		// written only when it stands alone.
		if (part.type === "TypeSelector") {
			const text = serializeQualifiedName(part.name as string, namespaces);
			const next = parts[index + 1];
			const alone = !next || next.type === "Combinator";
			if (text === "*" && !alone) {
				continue;
			}
			out += text;
			continue;
		}
		out += serializeSimpleSelector(part, namespaces);
	}
	return out;
}

function serializeSimpleSelector(
	node: CSSTree.SelectorNode,
	namespaces: SelectorNamespaces | undefined,
): string {
	switch (node.type) {
		case "TypeSelector":
			return serializeQualifiedName(node.name as string, namespaces);
		case "ClassSelector":
			return `.${serializeIdentifierSource(node.name as string)}`;
		case "IdSelector":
			return `#${serializeIdentifierSource(node.name as string)}`;
		case "NestingSelector":
			return "&";
		case "Combinator": {
			const name = node.name as string;
			return name === " " ? " " : ` ${name} `;
		}
		case "AttributeSelector": {
			const name = node.name as {name: string};
			let out = `[${serializeQualifiedName(name.name, undefined, true)}`;
			if (node.matcher && node.value) {
				const value =
					node.value.type === "String"
						? (node.value.value ?? "")
						: (node.value.name ?? "");
				out += `${node.matcher}${serializeCSSString(value)}`;
				if (node.flags) {
					out += ` ${node.flags.toLowerCase()}`;
				}
			}
			return `${out}]`;
		}
		case "PseudoClassSelector":
		case "PseudoElementSelector": {
			// A CSS 2 pseudo-element may be written with one colon. It
			// serializes with two, the spelling every pseudo-element has.
			const decoded = pseudoName(node.name as string);
			const element =
				node.type === "PseudoElementSelector" || isLegacyPseudoElement(decoded);
			const colons = element ? "::" : ":";
			const name = serializeCSSIdentifier(decoded);
			const args = getChildren(node);
			if (args.length === 0) {
				return `${colons}${name}`;
			}
			const text = args
				.map((argument) => serializeSelectorArgument(argument, namespaces))
				.join(", ");
			return `${colons}${name}(${text})`;
		}
		default:
			return "";
	}
}

function serializeSelectorArgument(
	node: CSSTree.SelectorNode,
	namespaces: SelectorNamespaces | undefined,
): string {
	switch (node.type) {
		case "SelectorList":
			return serializeSelectorList(node, namespaces);
		case "Selector":
			return serializeSelector(node, namespaces);
		case "Nth": {
			const nth = node.nth
				? serializeSelectorArgument(node.nth, namespaces)
				: "";
			const of = node.selector
				? ` of ${serializeSelectorList(node.selector, namespaces)}`
				: "";
			return `${nth}${of}`;
		}
		case "AnPlusB":
			return serializeAnPlusB(node.a ?? null, node.b ?? null);
		case "Identifier": {
			// `even` and `odd` are An+B written in words.
			const word = ((node.name as string) ?? "").toLowerCase();
			if (word === "even") {
				return "2n";
			}
			if (word === "odd") {
				return "2n+1";
			}
			return serializeIdentifierSource((node.name as string) ?? "");
		}
		case "String":
			return serializeCSSString(node.value?.value ?? "");
		case "Raw": {
			const text = String((node as {value?: string}).value ?? "").trim();
			// An argument that is one identifier (`::highlight(name)`,
			// `:lang(ja)`) serializes as the identifier its escapes spell.
			// Anything else the parser passed through whole stays as written.
			return /^-?(?:[-\w-￿]|\\[^\n])+$/.test(text) && !/^-?\d/.test(text)
				? serializeIdentifierSource(text)
				: text;
		}
		default:
			return "";
	}
}

// The one spelling CSSOM writes: `2n`, `2n+1`, `-n+5`, `10`.
function serializeAnPlusB(a: string | null, b: string | null): string {
	if (a === null) {
		return String(Number(b ?? 0));
	}
	const step = Number(a);
	let out = step === 1 ? "n" : step === -1 ? "-n" : `${step}n`;
	const offset = Number(b ?? 0);
	if (offset > 0) {
		out += `+${offset}`;
	} else if (offset < 0) {
		out += `${offset}`;
	}
	return out;
}

// "" means the argument names no pseudo-element and is ignored, which
// is how getComputedStyle(el, "before") returns the element's own
// style. Null means it names something that is not a pseudo-element, and
// the result is an empty declaration.
export function parsePseudoElementArgument(text: string): string | null {
	if (!text.startsWith(":")) {
		return "";
	}
	const double = text.startsWith("::");
	let name = text.slice(double ? 2 : 1);
	// CSS tokenization closes a function left open at the end of the input,
	// so `::highlight( name ` names the same pseudo-element as
	// `::highlight(name)`. Anything after the name that is not inside a
	// function is a trailing token, and a trailing token is not part of the
	// selector.
	let open = 0;
	for (let index = 0; index < name.length; index++) {
		const char = name[index];
		if (char === "\\") {
			index++;
		} else if (char === "(") {
			open++;
		} else if (char === ")") {
			open--;
		} else if (char === "," && open === 0) {
			// A comma outside the arguments starts a second selector, and a
			// list of selectors names no single pseudo-element.
			return null;
		}
	}
	if (open > 0) {
		name += ")".repeat(open);
	} else if (name !== name.trimEnd()) {
		return null;
	}
	// One colon is the CSS 2 spelling, which only the four CSS 2
	// pseudo-elements accept.
	if (!double && !isLegacyPseudoElement(pseudoName(name))) {
		return null;
	}
	const selectors = parseSelectorList(`*::${name}`);
	if (!selectors) {
		return null;
	}
	// One pseudo-element, not a list of them.
	const list = getChildren(selectors);
	if (list.length !== 1) {
		return null;
	}
	const compound = getChildren(list[0] ?? {type: ""});
	const pseudo = compound[compound.length - 1];
	if (
		compound.length !== 2 || !pseudo || pseudo.type !== "PseudoElementSelector"
	) {
		return null;
	}
	return serializeSimpleSelector(pseudo, undefined);
}

export function splitSelectorList(text: string): string[] {
	const selectors: string[] = [];
	let depth = 0;
	let start = 0;
	let quote = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = "";
			}
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(" || char === "[") {
			depth++;
		} else if (char === ")" || char === "]") {
			depth--;
		} else if (char === "," && depth === 0) {
			selectors.push(text.slice(start, index).trim());
			start = index + 1;
		}
	}
	selectors.push(text.slice(start).trim());
	return selectors.filter(Boolean);
}

export function getNodes(container: {
	children?: {toArray(): CSSTree.StyleSheetNode[]} | null;
}): CSSTree.StyleSheetNode[] {
	return container.children ? container.children.toArray() : [];
}

// Value nodes from the sheet parse are kept when the canonical spelling
// is the authored one. The value TEXT always serializes from the source,
// which the parsed spelling cannot replace.
export function getBlockDeclarations(
	node: CSSTree.StyleSheetNode,
	source: string,
): CSSDeclaration[] {
	const declarations: CSSDeclaration[] = [];
	if (!node.block) {
		return declarations;
	}
	for (const child of getNodes(node.block)) {
		if (child.type !== "Declaration" || !child.value) {
			continue;
		}
		const name = parsePropertyName(child.property ?? "");
		const raw =
			child.value.type === "Raw"
				? (child.value.value ?? "")
				: child.value.loc
					? source.slice(
						child.value.loc.start.offset,
						child.value.loc.end.offset,
					)
					: CSSTree.generate(child.value as never);
		const value = serializeCSSValue(raw, name);
		if (!value) {
			continue;
		}
		if (child.value.type === "Value" && value === raw.trim()) {
			seedValueNodes(
				value,
				getNodes(child.value as never) as CSSTree.ValueNode[],
			);
		}
		declarations.push({name, value, important: child.important === true});
	}
	return declarations;
}

export function getPreludeText(node: CSSTree.StyleSheetNode): string {
	return (node.prelude?.value ?? "").trim();
}

export function getNestedRules(
	node: CSSTree.StyleSheetNode,
): CSSTree.StyleSheetNode[] {
	return getNodes(node.block ?? {}).filter(
		(child) => child.type === "Rule" || child.type === "Atrule",
	);
}

// The empty list for the anonymous block. Null for a prelude outside
// the grammar, which drops the at-rule.
export function getLayerNames(prelude: string): string[] | null {
	let nodes: CSSTree.LayerPreludeNode[];
	try {
		const ast = CSSTree.parse(prelude, {
			context: "atrulePrelude",
			atrule: "layer",
		}) as unknown as {
			children?: {toArray(): CSSTree.LayerPreludeNode[]} | null;
		};
		nodes = ast.children ? ast.children.toArray() : [];
	} catch (_err) {
		return null;
	}
	if (nodes.length === 0) {
		return [];
	}
	if (nodes.length !== 1 || nodes[0].type !== "LayerList") {
		return null;
	}
	return (nodes[0].children?.toArray() ?? []).map((node) => node.name ?? "");
}

// A used length in the one unit a terminal has: a cell, spelled `px`.
export function getUsedLength(cells: number): string {
	return `${Math.round(cells * 1000) / 1000}px`;
}

const BLOCKIFIED_DISPLAYS: Record<string, string> = {
	inline: "block",
	"inline-block": "block",
	"inline-flex": "flex",
	"inline-grid": "grid",
	"inline-table": "table",
};

// Null for `auto`, which is not a length but an instruction to
// measure.
export function getInsetLength(computed: string, basis: number): number | null {
	if (!computed || computed === "auto") {
		return null;
	}
	const calc = /^calc\(([+-]?[\d.]+)px ([+-]) ([\d.]+)%\)$/.exec(computed);
	if (calc) {
		const percentage = (parseFloat(calc[3]) / 100) * basis;
		return parseFloat(calc[1]) + (calc[2] === "-" ? -percentage : percentage);
	}
	if (computed.endsWith("%")) {
		return (parseFloat(computed) / 100) * basis;
	}
	const length = parseFloat(computed);
	return Number.isFinite(length) ? length : null;
}

// The reader is the caller's. The computed and resolved paths ask their
// longhands different questions, and the results must not mix, which is
// why only the computed one is memoized.
export function resolveShorthand(
	property: string,
	longhands: readonly string[],
	read: (longhand: string) => string,
): string {
	return serializeShorthandValue(
		property,
		longhands,
		(longhand) => read(longhand) || CSS_INITIAL_VALUES[longhand] || "",
	);
}

// The physical property first, then every flow-relative name that can
// map to it, whichever way `direction` goes.
const SLOT_CANDIDATES = new Map<string, readonly string[]>();

export function getSlotCandidates(property: string): readonly string[] {
	let names = SLOT_CANDIDATES.get(property);
	if (names === undefined) {
		const logical = PHYSICAL_TO_LOGICAL.get(property);
		names = logical ? [property, ...logical] : [property];
		SLOT_CANDIDATES.set(property, names);
	}
	return names;
}

export function acceptsAnyName(): boolean {
	return true;
}

/** Roman numeral for 1-3999. Callers must range-check. */
function toRoman(num: number): string {
	const romanNumerals = [
		{value: 1000, symbol: "M"},
		{value: 900, symbol: "CM"},
		{value: 500, symbol: "D"},
		{value: 400, symbol: "CD"},
		{value: 100, symbol: "C"},
		{value: 90, symbol: "XC"},
		{value: 50, symbol: "L"},
		{value: 40, symbol: "XL"},
		{value: 10, symbol: "X"},
		{value: 9, symbol: "IX"},
		{value: 5, symbol: "V"},
		{value: 4, symbol: "IV"},
		{value: 1, symbol: "I"},
	];

	let remaining = num;
	let result = "";
	for (const {value, symbol} of romanNumerals) {
		while (remaining >= value) {
			result += symbol;
			remaining -= value;
		}
	}
	return result;
}

/** Marker glyphs for the bullet list-style-types. */
const BULLET_MARKERS: Record<string, string> = {
	disc: "\u2022",
	circle: "\u25e6",
	square: "\u25aa",
};

/** The list-style-types that count, and so draw a marker ending in a dot. */
const COUNTER_STYLES = new Set([
	"decimal",
	"decimal-leading-zero",
	"lower-alpha",
	"lower-latin",
	"lower-roman",
	"upper-alpha",
	"upper-latin",
	"upper-roman",
]);

export function getBulletMarker(listStyleType: string): string | undefined {
	return BULLET_MARKERS[listStyleType];
}

export function isCounterStyle(listStyleType: string): boolean {
	return COUNTER_STYLES.has(listStyleType);
}

/** Alphabetic counters are bijective base-26: 26 -> "z", 27 -> "aa". */
function toAlpha(value: number): string {
	let n = value;
	let out = "";
	while (n > 0) {
		const digit = (n - 1) % 26;
		out = String.fromCharCode(97 + digit) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

// Falls back to decimal outside a style's range.
export function formatOrdinal(ordinal: number, listStyleType: string): string {
	switch (listStyleType) {
		case "decimal-leading-zero":
			return ordinal >= 0 && ordinal < 10 ? `0${ordinal}` : `${ordinal}`;
		case "lower-alpha":
		case "lower-latin":
			return ordinal > 0 ? toAlpha(ordinal) : `${ordinal}`;
		case "lower-roman":
			// Roman numerals are undefined outside 1-3999. CSS falls back to
			// decimal.
			return ordinal > 0 && ordinal < 4000
				? toRoman(ordinal).toLowerCase()
				: `${ordinal}`;
		case "upper-alpha":
		case "upper-latin":
			return ordinal > 0 ? toAlpha(ordinal).toUpperCase() : `${ordinal}`;
		case "upper-roman":
			return ordinal > 0 && ordinal < 4000 ? toRoman(ordinal) : `${ordinal}`;
		default:
			return `${ordinal}`;
	}
}

export interface ScopeCondition {
	// Null for @scope written without a root, whose root is the element the
	// stylesheet's owner node is in.
	roots: readonly CompiledSelector[] | null;

	// The same roots read relative to the enclosing scope, which is what
	// lets `@scope (.a) { @scope (> .b) }` work.
	rootsInOuter: readonly CompiledSelector[];

	// The scoping limits, read relative to the root they close.
	limits: readonly CompiledSelector[];

	// The implicit scoping root, for a condition that names none.
	owner: Element | null;
}

export interface RuleContext {
	layer: string | null;
	scopes: readonly ScopeCondition[];
}

// A selector this engine cannot read selects nothing and is dropped.
export function compileSelectors(
	text: string,
	options: {namespaces?: SelectorNamespaces; relative?: boolean},
): CompiledSelector[] {
	const compiled: CompiledSelector[] = [];
	for (const selector of splitSelectorList(text)) {
		try {
			compiled.push(compileSelector(selector, options));
		} catch (_err) {
			// A prelude sliced out of its at-rule has passed no grammar check.
		}
	}
	return compiled;
}

export interface CounterScope {
	element: Element;
	counters: {[counterName: string]: number};
	parent?: CounterScope;
}

const SIBLING_SELECTOR = /[+~]|:(?:nth-|first-|last-|only-|empty)/;

export function getBlockifiedDisplay(display: string): string {
	return BLOCKIFIED_DISPLAYS[display] ?? display;
}

// CSS transitions (css-transitions-1): started at style change events,
// advanced by a per-frame tick, read through the computed-value
// override.
export interface TransitionTiming {
	duration: number;
	delay: number;
	easing: string;
}

export interface RunningTransition {
	property: string;
	from: string;
	to: string;

	// Timeline ms of the style change event that started it.
	start: number;
	delay: number;
	duration: number;
	easing: (input: number) => number;

	// Whether transitionstart has fired, meaning the delay has elapsed.
	started: boolean;
	reversingAdjustedStartValue: string;
	reversingShorteningFactor: number;
}

// A bounded list. `all` literally means anything animatable, and an
// unbounded snapshot per style change would put the whole property index
// in front of each restyle.
const TRANSITIONABLE_ALL = [
	"background-color",
	"border-bottom-color",
	"border-bottom-width",
	"border-left-color",
	"border-left-width",
	"border-right-color",
	"border-right-width",
	"border-top-color",
	"border-top-width",
	"bottom",
	"color",
	"column-gap",
	"flex-basis",
	"flex-grow",
	"flex-shrink",
	"font-size",
	"height",
	"left",
	"letter-spacing",
	"margin-bottom",
	"margin-left",
	"margin-right",
	"margin-top",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"opacity",
	"outline-color",
	"outline-width",
	"padding-bottom",
	"padding-left",
	"padding-right",
	"padding-top",
	"right",
	"row-gap",
	"text-indent",
	"top",
	"visibility",
	"width",
	"word-spacing",
	"z-index",
];

export function getTransitionBase(
	read: (property: string) => string,
	property: string,
): string {
	return (
		read(property) ||
		getComputedValueEntry(property, CSS_INITIAL_VALUES[property] ?? "")
	);
}

function parseCSSTime(token: string): number {
	return getCSSTimeMs(token) ?? 0;
}

// The timing lists repeat to the property list's length
// (css-transitions-1 §2.1). A later item naming a property a prior one
// covered wins.
export function getMatchedTransitions(
	read: (property: string) => string,
): Map<string, TransitionTiming> | null {
	const propertyList = getTransitionBase(read, "transition-property");
	if (!propertyList || propertyList === "none") {
		return null;
	}
	const durations = splitCommaList(
		getTransitionBase(read, "transition-duration"),
	).map(parseCSSTime);
	const delays = splitCommaList(
		getTransitionBase(read, "transition-delay"),
	).map(parseCSSTime);
	const easings = splitCommaList(
		getTransitionBase(read, "transition-timing-function"),
	);
	const items = splitCommaList(propertyList);
	const out = new Map<string, TransitionTiming>();
	items.forEach((item, index) => {
		const name = item.toLowerCase();
		if (name === "none") {
			return;
		}
		const timing: TransitionTiming = {
			duration: durations.length > 0 ? durations[index % durations.length] : 0,
			delay: delays.length > 0 ? delays[index % delays.length] : 0,
			easing: easings.length > 0 ? easings[index % easings.length] : "ease",
		};
		// A shorthand in the list covers its longhands (css-transitions-1
		// §2.1). `all` covers the bounded list above.
		const targets =
			name === "all"
				? TRANSITIONABLE_ALL
				: (
					SHORTHAND_LONGHANDS.get(name) ?? [name]
				);
		for (const target of targets) {
			out.set(target, timing);
		}
	});
	return out.size > 0 ? out : null;
}

export function getTransitionProgress(
	transition: RunningTransition,
	now: number,
): number {
	if (transition.delay > 0 && now < transition.start + transition.delay) {
		return 0;
	}
	const linear =
		transition.duration <= 0
			? 1
			: (
				Math.min(
					Math.max(
						(now - transition.start - transition.delay) / transition.duration,
						0,
					),
					1,
				)
			);
	return transition.easing(linear);
}

export function getCurrentTransitionValue(
	transition: RunningTransition,
	now: number,
): string {
	if (transition.delay > 0 && now < transition.start + transition.delay) {
		return transition.from;
	}
	return interpolateValue(
		transition.from,
		transition.to,
		getTransitionProgress(transition, now),
	);
}

// Numbers with a shared unit interpolate numerically, colors by
// channel, and anything else flips at the midpoint (the spec's discrete
// type).
function interpolateValue(from: string, to: string, progress: number): string {
	if (progress <= 0) {
		return from;
	}
	if (progress >= 1) {
		return to;
	}
	const a = getScalarComponents(from);
	const b = getScalarComponents(to);
	if (a && b && a.unit === b.unit) {
		const value = a.number + (b.number - a.number) * progress;
		return `${Math.round(value * 1000) / 1000}${a.unit}`;
	}
	const fromColor = parseCSSColorComponents(from);
	const toColor = parseCSSColorComponents(to);
	if (fromColor && toColor) {
		const channel = (index: number): number =>
			Math.round(
				fromColor[index] + (toColor[index] - fromColor[index]) * progress,
			);
		const alpha = fromColor[3] + (toColor[3] - fromColor[3]) * progress;
		if (alpha < 1) {
			return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${Math.round(alpha * 1000) / 1000})`;
		}
		return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
	}
	return progress < 0.5 ? from : to;
}

function getScalarComponents(
	value: string,
): {number: number; unit: string} | null {
	const node = getSingleValueNode(value);
	if (!node) {
		return null;
	}
	const number = parseFloat(node.value ?? "");
	if (!Number.isFinite(number)) {
		return null;
	}
	switch (node.type) {
		case "Number":
			return {number, unit: ""};
		case "Percentage":
			return {number, unit: "%"};
		case "Dimension":
			return {number, unit: (node.unit ?? "").toLowerCase()};
	}
	return null;
}

const easingFunctions = new Map<string, (input: number) => number>();

export function parseEasing(text: string): (input: number) => number {
	const key = text.trim().toLowerCase();
	let easing = easingFunctions.get(key);
	if (!easing) {
		easing = buildEasing(key);
		if (easingFunctions.size > 256) {
			easingFunctions.clear();
		}
		easingFunctions.set(key, easing);
	}
	return easing;
}

function buildEasing(key: string): (input: number) => number {
	switch (key) {
		case "linear":
			return (input) => input;
		case "ease":
			return cubicBezierEasing(0.25, 0.1, 0.25, 1);
		case "ease-in":
			return cubicBezierEasing(0.42, 0, 1, 1);
		case "ease-out":
			return cubicBezierEasing(0, 0, 0.58, 1);
		case "ease-in-out":
			return cubicBezierEasing(0.42, 0, 0.58, 1);
		case "step-start":
			return stepsEasing(1, "jump-start");
		case "step-end":
			return stepsEasing(1, "jump-end");
	}
	const node = getSingleValueNode(key);
	if (node && node.type === "Function") {
		const name = (node.name ?? "").toLowerCase();
		const args = getFunctionArguments(node);
		if (name === "cubic-bezier" && args.length === 4) {
			const points = args.map((arg) =>
				arg.type === "Number" ? parseFloat(arg.value ?? "") : NaN,
			);
			if (points.every(Number.isFinite)) {
				return cubicBezierEasing(points[0], points[1], points[2], points[3]);
			}
		} else if (name === "steps" && args.length >= 1 && args.length <= 2) {
			const count =
				args[0].type === "Number" ? parseInt(args[0].value ?? "", 10) : NaN;
			const position =
				args.length < 2
					? "end"
					: args[1].type === "Identifier"
						? (args[1].name ?? "").toLowerCase()
						: "";
			if (Number.isFinite(count) && count > 0 && position) {
				return stepsEasing(count, position);
			}
		} else if (name === "linear") {
			const easing = linearEasing(node);
			if (easing) {
				return easing;
			}
		}
	}
	// Anything unrecognized plays as linear.
	return (input) => input;
}

// css-easing-1 §2.6. Null for an argument list outside the grammar,
// which then plays as `linear`.
function linearEasing(node: CSSTree.ValueNode): ((input: number) => number) |
	null {
	const stops: CSSTree.ValueNode[][] = [[]];
	for (const child of node.children?.toArray() ?? []) {
		if (child.type === "Operator") {
			if ((child.value ?? "").trim() !== ",") {
				return null;
			}
			stops.push([]);
		} else {
			stops[stops.length - 1].push(child);
		}
	}
	const points: Array<{input: number | null; output: number}> = [];
	let largest = -Infinity;
	for (const stop of stops) {
		let output: number | null = null;
		const given: number[] = [];
		for (const item of stop) {
			if (item.type === "Number" && output === null) {
				output = parseFloat(item.value ?? "");
			} else if (item.type === "Percentage" && given.length < 2) {
				given.push(parseFloat(item.value ?? "") / 100);
			} else {
				return null;
			}
		}
		if (
			output === null ||
			!Number.isFinite(output) ||
			given.some((input) => !Number.isFinite(input))
		) {
			return null;
		}
		const first = given.length > 0 ? Math.max(given[0], largest) : null;
		if (first !== null) {
			largest = first;
		}
		points.push({input: first, output});
		if (given.length === 2) {
			largest = Math.max(given[1], largest);
			points.push({input: largest, output});
		}
	}
	if (points.length < 2) {
		return null;
	}
	if (points[0].input === null) {
		points[0].input = 0;
	}
	if (points[points.length - 1].input === null) {
		points[points.length - 1].input = Math.max(largest, 1);
	}
	for (let start = 1; start < points.length; start++) {
		if (points[start].input !== null) {
			continue;
		}
		let end = start;
		while (points[end].input === null) {
			end++;
		}
		const from = points[start - 1].input as number;
		const to = points[end].input as number;
		const gap = end - start + 1;
		for (let i = start; i < end; i++) {
			points[i].input = from + ((to - from) * (i - start + 1)) / gap;
		}
	}
	const inputs = points.map((point) => point.input as number);
	const outputs = points.map((point) => point.output);
	return (input) => {
		let index = 0;
		while (index < inputs.length - 2 && inputs[index + 1] <= input) {
			index++;
		}
		const span = inputs[index + 1] - inputs[index];
		if (span <= 0) {
			return outputs[index + 1];
		}
		const ratio = (input - inputs[index]) / span;
		return outputs[index] + (outputs[index + 1] - outputs[index]) * ratio;
	};
}

// css-easing-1 §2.3. At 0 the jump-start family is already up a step.
function stepsEasing(
	count: number,
	position: string,
): (input: number) => number {
	const rising =
		position === "jump-start" ||
		position === "start" ||
		position === "jump-both";
	const jumps =
		position === "jump-both"
			? count + 1
			: position === "jump-none" ? Math.max(count - 1, 1) : count;
	return (input) => {
		if (input >= 1) {
			return 1;
		}
		let step = Math.floor(Math.max(input, 0) * count);
		if (rising) {
			step++;
		}
		return Math.min(Math.max(step / jumps, 0), 1);
	};
}

// Newton's method with a bisection fallback.
function cubicBezierEasing(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): (input: number) => number {
	const sample = (a1: number, a2: number, t: number): number =>
		(((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t + 3 * a1) * t;
	const derivative = (a1: number, a2: number, t: number): number =>
		3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1;
	const solve = (x: number): number => {
		let t = x;
		for (let i = 0; i < 8; i++) {
			const error = sample(x1, x2, t) - x;
			if (Math.abs(error) < 1e-6) {
				return t;
			}
			const slope = derivative(x1, x2, t);
			if (Math.abs(slope) < 1e-6) {
				break;
			}
			t -= error / slope;
		}
		let low = 0;
		let high = 1;
		t = x;
		while (high - low > 1e-6) {
			if (sample(x1, x2, t) < x) {
				low = t;
			} else {
				high = t;
			}
			t = (low + high) / 2;
		}
		return t;
	};
	return (input) => {
		if (input <= 0) {
			return 0;
		}
		if (input >= 1) {
			return 1;
		}
		return sample(y1, y2, solve(input));
	};
}

// Null for a value outside the grammar, which leaves the feature
// unevaluated.
export function getMediaLength(
	node: CSSTree.ValueNode | null | undefined,
): number | null {
	let length: number | null = null;
	if (node?.type === "Number") {
		length = parseFloat(node.value ?? "");
	} else if (node?.type === "Dimension") {
		const unit = (node.unit ?? "").toLowerCase();
		if (unit === "px" || unit === "ch") {
			length = parseFloat(node.value ?? "");
		}
	}
	if (length === null || !Number.isFinite(length) || length < 0) {
		return null;
	}
	return length;
}

export function mediaComparison(
	left: number,
	comparison: string | null | undefined,
	right: number,
): boolean {
	switch (comparison) {
		case "<":
			return left < right;
		case "<=":
			return left <= right;
		case ">":
			return left > right;
		case ">=":
			return left >= right;
		case "=":
			return left === right;
		default:
			return true;
	}
}

// Each identifier opens a pair. A counter written without a number
// takes `fallback`: 0 for a reset, 1 for an increment.
export function getCounterPairs(
	value: string,
	fallback: number,
): Array<[string, number]> {
	const pairs: Array<[string, number]> = [];
	const nodes = getCSSValueChildren(value);
	if (!nodes) {
		return pairs;
	}
	for (const node of nodes) {
		if (node.type === "Identifier" && node.name) {
			pairs.push([node.name, fallback]);
		} else if (node.type === "Number" && pairs.length > 0) {
			const count = parseInt(node.value ?? "", 10);
			if (!isNaN(count)) {
				pairs[pairs.length - 1][1] = count;
			}
		}
	}
	return pairs;
}

export function parseCounterReset(
	scope: CounterScope,
	counterReset: string,
): void {
	for (const [name, value] of getCounterPairs(counterReset, 0)) {
		scope.counters[name] = value;
	}
}

export function getCounterValueInScope(
	scope: CounterScope | undefined,
	counterName: string,
): number {
	let currentScope = scope;
	while (currentScope) {
		if (counterName in currentScope.counters) {
			return currentScope.counters[counterName];
		}
		currentScope = currentScope.parent;
	}
	return 0;
}

// A bullet style names a glyph and ignores the value. Everything else is
// the ordinal a list marker of the same style would show.
export function formatCounterValue(value: number, style: string): string {
	return BULLET_MARKERS[style] ?? formatOrdinal(value, style);
}

/**
 * A `<track-breadth>`: one end of a track's sizing function. `flex` is
 * the `fr` unit, whose factor is a share of the leftover space rather
 * than a length. The three keywords are intrinsic and size from the
 * items in the track.
 */
export type TrackBreadth =
	{kind: "length"; value: Value} |
	{kind: "flex"; factor: number} |
	{kind: "auto"} |
	{kind: "min-content"} |
	{kind: "max-content"};

/**
 * A `<track-size>`: the minimum and maximum a track may take.
 *
 * `fit-content(x)` is `minmax(auto, max-content)` with the maximum
 * clamped by `x` (css-grid-2 §7.2.3), so it is stored exactly that way:
 * the clamp beside the pair, not a fourth kind of sizing function.
 */
export interface TrackSize {
	min: TrackBreadth;
	max: TrackBreadth;
	fitContent?: Value;
}

/** One track of a track list, with the line names written before it. */
export interface TrackListTrack {
	names: string[];
	size: TrackSize;
}

/**
 * A `repeat()` group. `auto-fill` and `auto-fit` decide their own count
 * from the space available. `auto-fit` then collapses the tracks that
 * took no item (css-grid-2 §7.2.3.2).
 */
interface TrackRepeat {
	count: number | "auto-fill" | "auto-fit";
	tracks: TrackListTrack[];

	/** Line names written after the repeat group's last track. */
	endNames: string[];
}

type TrackListPart =
	{type: "track"; track: TrackListTrack} |
	{type: "repeat"; repeat: TrackRepeat};

/** A `<track-list>`: the tracks of one axis, with the lines named between them. */
export interface TrackList {
	parts: TrackListPart[];

	/** Line names written after the last track. */
	endNames: string[];
}

/**
 * A `grid-template-areas` map: one entry per row, one name (or null for
 * a `.` null cell) per column. Every row has `columnCount` entries.
 */
export interface GridAreaMap {
	rows: Array<Array<string | null>>;
	columnCount: number;
}

/**
 * One `<grid-line>` (css-grid-2 §8.3). `auto` is index null with no name
 * and no span. The rest are the grammar's three forms, which the parser
 * has already distinguished.
 */
export interface GridPlacement {
	span: boolean;
	index: number | null;
	name: string | null;
}

// Rejected rather than approximated. `subgrid` takes its tracks from an
// ancestor grid, so a grid's sizing could no longer be decided from its
// own box, and `masonry` is not a grid in its second axis. A track list
// naming either falls back to `none`, which is what a browser that does
// not implement them does.
const REFUSED_GRID_VALUES = new Set(["subgrid", "masonry"]);

// px and ch both measure one cell, and nothing else does.
function trackCells(node: CSSTree.ValueNode): number | null {
	if (node.type !== "Dimension") {
		return null;
	}
	const unit = (node.unit ?? "").toLowerCase();
	if (unit !== "px" && unit !== "ch") {
		return null;
	}
	const number = parseFloat(node.value ?? "");
	return Number.isFinite(number) ? number : null;
}

function getCellBreadth(cells: number): TrackBreadth {
	return {kind: "length", value: {unit: "cell", value: cells}};
}

function parseTrackBreadth(node: CSSTree.ValueNode): TrackBreadth | null {
	if (node.type === "Dimension" && (node.unit ?? "").toLowerCase() === "fr") {
		const factor = parseFloat(node.value ?? "");
		return Number.isFinite(factor) && factor >= 0
			? {kind: "flex", factor}
			: null;
	}
	const cells = trackCells(node);
	if (cells !== null) {
		return getCellBreadth(cells);
	}
	if (node.type === "Percentage") {
		const percentage = parseFloat(node.value ?? "");
		return Number.isFinite(percentage)
			? {kind: "length", value: {unit: "percent", value: percentage}}
			: null;
	}
	if (node.type === "Number" && parseFloat(node.value ?? "") === 0) {
		return getCellBreadth(0);
	}
	if (node.type === "Identifier") {
		switch ((node.name ?? "").toLowerCase()) {
			case "auto":
				return {kind: "auto"};
			case "min-content":
				return {kind: "min-content"};
			case "max-content":
				return {kind: "max-content"};
		}
	}
	return null;
}

function parseTrackSize(node: CSSTree.ValueNode): TrackSize | null {
	if (node.type === "Function") {
		const name = (node.name ?? "").toLowerCase();
		const args = getFunctionArguments(node);
		if (name === "minmax") {
			if (args.length !== 2) {
				return null;
			}
			const min = parseTrackBreadth(args[0]);
			const max = parseTrackBreadth(args[1]);
			// An `fr` is a share of leftover space, which is not a minimum
			// anything can be measured against. The grammar excludes it.
			if (!min || !max || min.kind === "flex") {
				return null;
			}
			return {min, max};
		}
		if (name === "fit-content") {
			if (args.length !== 1) {
				return null;
			}
			const clamp = parseTrackBreadth(args[0]);
			if (!clamp || clamp.kind !== "length") {
				return null;
			}
			// fit-content(x) is minmax(auto, max-content) capped at x (§7.2.3).
			return {
				min: {kind: "auto"},
				max: {kind: "max-content"},
				fitContent: clamp.value,
			};
		}
		return null;
	}
	const breadth = parseTrackBreadth(node);
	if (!breadth) {
		return null;
	}
	// A bare `<flex>` is minmax(auto, <flex>). Every other bare breadth is
	// both ends of the pair.
	if (breadth.kind === "flex") {
		return {min: {kind: "auto"}, max: breadth};
	}
	return {min: breadth, max: breadth};
}

function getBracketNames(node: CSSTree.ValueNode): string[] {
	return (node.children?.toArray() ?? [])
		.filter((child) => child.type === "Identifier")
		.map((child) => child.name ?? "");
}

// A track list is written once and computed onto every element the
// rule matches. The parsers are pure and their results read-only, so
// one parse serves every element that declares it.
const parsedGridValues = new Map<string, unknown>();

function memoizeGridValue<T>(
	kind: string,
	value: string,
	parse: (value: string) => T,
): T {
	const key = kind + " " + value;
	if (parsedGridValues.has(key)) {
		return parsedGridValues.get(key) as T;
	}
	const parsed = parse(value);
	parsedGridValues.set(key, parsed);
	return parsed;
}

/** A `<track-list>`, or null when the value is not one (and so has no effect). */
export function parseTrackList(value: string): TrackList | null {
	return memoizeGridValue("track-list", value, parseTrackListValue);
}

function parseTrackListValue(value: string): TrackList | null {
	const text = value.trim();
	if (!text || text === "none") {
		return null;
	}
	if (REFUSED_GRID_VALUES.has(text.toLowerCase())) {
		return null;
	}
	const children = getCSSValueChildren(text);
	if (!children) {
		return null;
	}

	const parts: TrackListPart[] = [];
	let names: string[] = [];

	for (const node of children) {
		if (node.type === "Brackets") {
			names = names.concat(getBracketNames(node));
			continue;
		}
		if (
			node.type === "Function" && (node.name ?? "").toLowerCase() === "repeat"
		) {
			const repeat = parseTrackRepeat(node);
			if (!repeat) {
				return null;
			}
			repeat.tracks[0].names = names.concat(repeat.tracks[0].names);
			names = [];
			parts.push({type: "repeat", repeat});
			continue;
		}
		if (
			node.type === "Identifier" &&
			REFUSED_GRID_VALUES.has((node.name ?? "").toLowerCase())
		) {
			return null;
		}
		const size = parseTrackSize(node);
		if (!size) {
			return null;
		}
		parts.push({type: "track", track: {names, size}});
		names = [];
	}

	if (parts.length === 0) {
		return null;
	}
	return {parts, endNames: names};
}

function parseTrackRepeat(node: CSSTree.ValueNode): TrackRepeat | null {
	const args = (node.children?.toArray() ?? []).filter(
		(child) => child.type !== "Operator",
	);
	if (args.length < 2) {
		return null;
	}
	const first = args[0];
	let count: number | "auto-fill" | "auto-fit";
	if (first.type === "Number") {
		const parsed = parseInt(first.value ?? "", 10);
		if (!Number.isFinite(parsed) || parsed < 1) {
			return null;
		}
		// A repeat is written by an author and expanded here, so a runaway
		// count would cost tracks nobody can see.
		count = Math.min(parsed, 1000);
	} else if (first.type === "Identifier") {
		const keyword = (first.name ?? "").toLowerCase();
		if (keyword !== "auto-fill" && keyword !== "auto-fit") {
			return null;
		}
		count = keyword;
	} else {
		return null;
	}

	const tracks: TrackListTrack[] = [];
	let names: string[] = [];
	for (const child of args.slice(1)) {
		if (child.type === "Brackets") {
			names = names.concat(getBracketNames(child));
			continue;
		}
		const size = parseTrackSize(child);
		if (!size) {
			return null;
		}
		tracks.push({names, size});
		names = [];
	}
	if (tracks.length === 0) {
		return null;
	}
	return {count, tracks, endNames: names};
}

/** grid-auto-rows/columns: a list of track sizes, cycled over implicit tracks. */
export function parseTrackSizeList(value: string): TrackSize[] | null {
	return memoizeGridValue("track-size-list", value, parseTrackSizeListValue);
}

function parseTrackSizeListValue(value: string): TrackSize[] | null {
	const text = value.trim();
	if (!text || text === "auto") {
		return null;
	}
	const children = getCSSValueChildren(text);
	if (!children) {
		return null;
	}
	const sizes: TrackSize[] = [];
	for (const node of children) {
		const size = parseTrackSize(node);
		if (!size) {
			return null;
		}
		sizes.push(size);
	}
	return sizes.length > 0 ? sizes : null;
}

/**
 * `grid-template-areas`: rows of names, one string per row. The map is
 * invalid, and so declares nothing, unless every row has the same number
 * of cells and every named area is a solid rectangle (css-grid-2 §7.3).
 */
export function parseGridAreas(value: string): GridAreaMap | null {
	return memoizeGridValue("areas", value, parseGridAreasValue);
}

function parseGridAreasValue(value: string): GridAreaMap | null {
	const text = value.trim();
	if (!text || text === "none") {
		return null;
	}
	const children = getCSSValueChildren(text);
	if (!children || children.length === 0) {
		return null;
	}

	const rows: Array<Array<string | null>> = [];
	for (const node of children) {
		if (node.type !== "String") {
			return null;
		}
		const cells = (node.value ?? "")
			.trim()
			.split(/\s+/)
			.filter((cell) => cell.length > 0)
			// A run of dots is one null cell, however many dots it has.
			.map((cell) => (/^\.+$/.test(cell) ? null : cell));
		if (cells.length === 0) {
			return null;
		}
		rows.push(cells);
	}

	const columnCount = rows[0].length;
	if (rows.some((row) => row.length !== columnCount)) {
		return null;
	}

	// Every area must be a fully filled rectangle. `"a b a"` names no area
	// at all.
	const boxes = new Map<
		string,
		{top: number; left: number; bottom: number; right: number}
	>();
	rows.forEach((row, rowIndex) => {
		row.forEach((name, columnIndex) => {
			if (name === null) {
				return;
			}
			const box = boxes.get(name);
			if (!box) {
				boxes.set(name, {
					top: rowIndex,
					left: columnIndex,
					bottom: rowIndex + 1,
					right: columnIndex + 1,
				});
				return;
			}
			box.top = Math.min(box.top, rowIndex);
			box.left = Math.min(box.left, columnIndex);
			box.bottom = Math.max(box.bottom, rowIndex + 1);
			box.right = Math.max(box.right, columnIndex + 1);
		});
	});
	for (const [name, box] of boxes) {
		for (let row = box.top; row < box.bottom; row++) {
			for (let column = box.left; column < box.right; column++) {
				if (rows[row][column] !== name) {
					return null;
				}
			}
		}
	}

	return {rows, columnCount};
}

/** One `<grid-line>`: `auto`, a line number, a name, or a span of either. */
export function parseGridPlacement(value: string): GridPlacement | null {
	return memoizeGridValue("placement", value, parseGridPlacementValue);
}

function parseGridPlacementValue(value: string): GridPlacement | null {
	const text = value.trim();
	if (!text || text === "auto") {
		return null;
	}
	const children = getCSSValueChildren(text);
	if (!children || children.length === 0) {
		return null;
	}

	let span = false;
	let index: number | null = null;
	let name: string | null = null;

	for (const node of children) {
		if (node.type === "Number") {
			const parsed = parseInt(node.value ?? "", 10);
			if (!Number.isFinite(parsed) || parsed === 0) {
				return null;
			}
			if (index !== null) {
				return null;
			}
			index = parsed;
			continue;
		}
		if (node.type !== "Identifier") {
			return null;
		}
		const keyword = node.name ?? "";
		if (keyword.toLowerCase() === "span") {
			if (span) {
				return null;
			}
			span = true;
			continue;
		}
		if (keyword.toLowerCase() === "auto") {
			return null;
		}
		if (name !== null) {
			return null;
		}
		name = keyword;
	}

	if (span) {
		// A span is a count of tracks or of named lines, never a line number.
		if (index !== null && index < 1) {
			return null;
		}
		if (index === null && name === null) {
			return null;
		}
	}
	if (!span && index === null && name === null) {
		return null;
	}
	return {span, index, name};
}
