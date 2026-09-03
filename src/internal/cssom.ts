import * as CSSTree from "css-tree";

import {
	CSS_AT_RULE_DESCRIPTORS,
	CSS_INITIAL_VALUES,
	CSS_LONGHANDS,
	CSS_PROPERTIES,
	CSS_RESET_ONLY_LONGHANDS,
	CSS_SHORTHANDS,
} from "../generated/cssproperties.js";
import {
	type CompiledSelector,
	compileSelector,
	dispatchAsUserAgent,
	type Document as DOMDocument,
	type Element as DOMElement,
	type Node as DOMNode,
	dropPseudoElement,
	ensurePseudoElement,
	flatParentElement,
	flushLayout,
	getChildren,
	getPseudoHost,
	getPseudoName,
	getShadowRoot,
	isUAShadowTree,
	LEGACY_PSEUDO_ELEMENTS,
	matchesCompiled,
	NO_NAMESPACES,
	parseSelectorList,
	pseudoElement,
	pseudoElementCount,
	pseudoName,
	selectAllCompiled,
	type SelectorNamespaces,
	type SelectorNode,
	styleElementCount,
	TransitionEvent,
	type Window,
} from "./dom.js";
import type {Layout} from "./layout.js";
import {LINE_STYLES, type LineStyle} from "./screen.js";
import {getStringWidth} from "./text.js";
import {UA_DOCUMENT_STYLES, UA_ELEMENT_STYLES} from "./useragent.js";

export type Unit = "undefined" | "cell" | "percent" | "auto";

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

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

type CSSNode = {
	type: string;
	name?: string;
	value?: string;
	unit?: string;
	children?: {toArray(): CSSNode[]};
};

// Value parsing runs during style computation, and a document re-reads
// the same handful of values many times, so each value is parsed once.
const valueNodes = new Map<string, CSSNode[] | null>();

/** A value's top-level nodes, or null if css-tree cannot parse the text. */
function getCSSValueChildren(value: string): CSSNode[] | null {
	let nodes = valueNodes.get(value);
	if (nodes === undefined) {
		try {
			const ast = CSSTree.parse(value, {
				context: "value",
			}) as unknown as CSSNode;
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
function seedValueNodes(value: string, nodes: CSSNode[]): void {
	if (valueNodes.has(value)) {
		return;
	}
	if (valueNodes.size > 1024) {
		valueNodes.clear();
	}
	valueNodes.set(value, nodes);
}

function getSingleValueNode(value: string): CSSNode | undefined {
	const nodes = getCSSValueChildren(value);
	return nodes && nodes.length === 1 ? nodes[0] : undefined;
}

function getFunctionArguments(node: CSSNode): CSSNode[] {
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
function serializeCSSValue(input: string, property = ""): string {
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

function serializeCSSString(text: string): string {
	return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

// The same result CSS.escape produces.
function serializeCSSIdentifier(value: string): string {
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
		const alpha =
			hex.length === 4 || hex.length === 8 ? channel(3) / 255 : 1;
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
		let r1 = 0,
			g1 = 0,
			b1 = 0;
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

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

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
	let ast: {children?: {toArray(): CSSNode[]} | null};
	// getTrace returns one step of the match per term the node matched.
	let match: {
		matched: unknown;
		getTrace(node: unknown): Array<{type: string; name: string}> | null;
	};
	try {
		ast = CSSTree.parse(value, {
			context: "value",
			positions: true,
		}) as never;
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
			previous !== undefined &&
			ALIGNMENT_QUALIFIERS.has(previous.toLowerCase())
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
			: isCustomIdent(first)
				? first
				: "auto";
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
			: isCustomIdent(from)
				? from
				: "auto";
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
				!behavior &&
				(lower === "normal" || lower === "allow-discrete")
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
function expandShorthands(
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

// Per-element defaults that are STATE, not stylesheet: the fullscreen
// element's viewport block, a select sized to its widest option label so
// the text control never jumps, the size attribute driving an input's width.
// Everything expressible as CSS lives in UA_ELEMENT_STYLES.
function getElementDefaults(
	element: Element,
): Record<string, string> | undefined {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return undefined;
	}
	const name = element.localName;
	const document = element.ownerDocument;
	if (document !== null && document.fullscreenElement === element) {
		const window = document.defaultView;
		if (window) {
			return {
				position: "fixed",
				top: "0px",
				left: "0px",
				width: `${window.innerWidth}ch`,
				height: `${window.innerHeight}px`,
				"background-color": "Canvas",
			};
		}
	}
	if (name === "select") {
		const select = element as HTMLSelectElement;
		let widest = 0;
		for (const option of select.options) {
			widest = Math.max(widest, getStringWidth(option.label));
		}
		return {width: `${widest + 2}ch`};
	}
	if (name === "input") {
		const input = element as HTMLInputElement;
		if (input.type === "checkbox" || input.type === "radio") {
			return undefined;
		}
		// A text input's width is attribute state: size columns when the
		// attribute is set, the spec's 20 otherwise. It lives here rather than
		// in the sheet so the attribute can override the default without a
		// width the sheet cannot express (there is no attr() length).
		const size = parseInt(input.getAttribute("size") ?? "", 10);
		return {
			width: `${Number.isFinite(size) && size > 0 ? size : 20}ch`,
		};
	}
	return undefined;
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

const INITIAL_KEYWORDS = new Set([
	"initial",
	"revert",
	"revert-layer",
	"unset",
]);

function getInitialStyle(
	element: Element | null,
	property: string,
): string {
	const elementDefaults = element ? getElementDefaults(element) : null;
	if (elementDefaults && elementDefaults[property]) {
		return elementDefaults[property];
	}

	// A property this engine does not lay out still resolves to an initial
	// value.
	return CSS_SPEC_DEFAULTS[property] || CSS_INITIAL_VALUES[property] || "";
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
			: parsed !== null
				? parsed.percentage
				: null;
	return number !== null && number < 0 ? null : parsed;
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

/** An element's margins, borders and padding, in cells. */
export function getBoxModel(element: Element): BoxModel {
	// The engine's own read: the cascade's declaration directly, without
	// the author path's resolved-value work.
	const widthValue = parseUnitValue(getComputedValue(element, "width"));
	const heightValue = parseUnitValue(getComputedValue(element, "height"));

	const paddingTop = parseUnitValue(
		getComputedValue(element, "padding-top"),
	);
	const paddingRight = parseUnitValue(
		getComputedValue(element, "padding-right"),
	);
	const paddingBottom = parseUnitValue(
		getComputedValue(element, "padding-bottom"),
	);
	const paddingLeft = parseUnitValue(
		getComputedValue(element, "padding-left"),
	);

	const marginTop = parseSignedUnitValue(
		getComputedValue(element, "margin-top"),
	);
	const marginRight = parseSignedUnitValue(
		getComputedValue(element, "margin-right"),
	);
	const marginBottom = parseSignedUnitValue(
		getComputedValue(element, "margin-bottom"),
	);
	const marginLeft = parseSignedUnitValue(
		getComputedValue(element, "margin-left"),
	);

	// The used width is 0 when the side's style is none or hidden
	// (css-backgrounds §3.3). `border-style: none` must release the space.
	const borderWidthFor = (side: string) => {
		const style = getComputedValue(element, `border-${side}-style`);
		if (!style || style === "none" || style === "hidden") {
			return null;
		}
		return parseBorderWidthValue(
			getComputedValue(element, `border-${side}-width`),
		);
	};
	const borderTopWidth = borderWidthFor("top");
	const borderRightWidth = borderWidthFor("right");
	const borderBottomWidth = borderWidthFor("bottom");
	const borderLeftWidth = borderWidthFor("left");

	return {
		width: typeof widthValue === "number" ? widthValue : undefined,
		height: typeof heightValue === "number" ? heightValue : undefined,
		paddingTop: typeof paddingTop === "number" ? paddingTop : 0,
		paddingRight: typeof paddingRight === "number" ? paddingRight : 0,
		paddingBottom: typeof paddingBottom === "number" ? paddingBottom : 0,
		paddingLeft: typeof paddingLeft === "number" ? paddingLeft : 0,
		marginTop: typeof marginTop === "number" ? marginTop : 0,
		marginRight: typeof marginRight === "number" ? marginRight : 0,
		marginBottom: typeof marginBottom === "number" ? marginBottom : 0,
		marginLeft: typeof marginLeft === "number" ? marginLeft : 0,
		borderTopWidth: typeof borderTopWidth === "number" ? borderTopWidth : 0,
		borderRightWidth:
			typeof borderRightWidth === "number" ? borderRightWidth : 0,
		borderBottomWidth:
			typeof borderBottomWidth === "number" ? borderBottomWidth : 0,
		borderLeftWidth: typeof borderLeftWidth === "number" ? borderLeftWidth : 0,
	};
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
function isValidDeclaration(
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

/** Minimum gutter a UL/OL reserves for its markers, in cells. */
const DEFAULT_LIST_GUTTER = 4;

/** Lists whose gutter is being measured, to stop re-entrant computation. */
const listGutterInProgress = new WeakSet<Element>();

// The entry point for every read of the cascade from a node, including
// reads deep inside the cascade itself that have no Cascade in
// hand.
const documentCascades = new WeakMap<object, Cascade>();

// A marker is separated from its item's text by one cell.
function withMarkerSeparator(marker: string): string {
	return marker ? `${marker} ` : "";
}

// What list-style-type spells, quoted the way a content value is
// written. Null outside a list.
function getDefaultMarkerContent(hostElement: Element): string | null {
	const listParent = hostElement.parentElement;
	if (
		!listParent ||
		(listParent.tagName !== "UL" && listParent.tagName !== "OL")
	) {
		return null;
	}
	const marker = getListMarker(hostElement, listParent);
	return marker ? `"${withMarkerSeparator(marker)}"` : null;
}

// A content value is a SEQUENCE of components (strings and functions).
// Stripping quotes only when the whole value was one quoted string left
// `"` in the rendered marker.
function unquoteContent(content: string): string {
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

// Markers are right-aligned against the content edge, so the gutter
// must fit the widest one, measured from the resolved ::marker content
// in cells. The default marker misses `::marker { content: ">>>>>> " }`,
// and .length undercounts a wide-character marker.
function getListGutterWidth(listElement: Element): number {
	if (listGutterInProgress.has(listElement)) {
		return DEFAULT_LIST_GUTTER;
	}
	listGutterInProgress.add(listElement);
	try {
		const cascade = documentCascades.get(listElement.ownerDocument);

		let widest = 0;
		for (const child of Array.from(listElement.children)) {
			if (child.tagName !== "LI") {
				continue;
			}
			const marker = cascade
				? cascade.getMarkerContent(child)
				: withMarkerSeparator(getListMarker(child, listElement));
			if (!marker) {
				continue;
			}
			widest = Math.max(widest, getStringWidth(marker));
		}
		return Math.max(DEFAULT_LIST_GUTTER, widest);
	} finally {
		listGutterInProgress.delete(listElement);
	}
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
function collapseRadius(value: string): string {
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
		return RADIUS_LONGHANDS.has(property) ? collapseRadius(lengths) : lengths;
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

function getComputedEntry(property: string, declared: string): ComputedEntry {
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

function getComputedValueEntry(property: string, declared: string): string {
	return getComputedEntry(property, declared).value;
}

interface LengthContext {
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

function getFontSize(fontSize: string): number {
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
function absolutizeLengths(value: string, context: LengthContext): string {
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
interface DeclarationBlock {
	declarations: Record<string, string>;
	important: Record<string, boolean>;

	// A logical property and its physical twin are two names for one
	// cascade slot, so whichever a block declares LAST decides the value.
	// Only this map records which that is.
	order: Record<string, number>;
}

const EMPTY_DECLARATIONS: DeclarationBlock = {
	declarations: {},
	important: {},
	order: {},
};

// The slot name the block declares LAST at this importance, or null.
// `accepts` rejects a flow-relative name that maps to the opposite edge.
function getDeclaredName(
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

interface CSSDeclaration {
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

function getPhysicalProperty(
	property: string,
	direction: string,
): string | undefined {
	return LOGICAL_TO_PHYSICAL[direction === "rtl" ? "rtl" : "ltr"].get(property);
}

// The OTHER names of the cascade slot a longhand belongs to under
// `direction`. Empty for a longhand with no aliases.
function getSlotNames(property: string, direction: string): readonly string[] {
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

interface SupportsNode {
	type: string;
	name?: string;
	feature?: string;
	property?: string;
	loc?: ParsedSpan | null;
	children?: {toArray(): SupportsNode[]} | null;
	declaration?: SupportsNode | null;
	value?: SupportsNode | null;
}

function supportsCondition(text: string): boolean {
	let nodes: SupportsNode[];
	try {
		const ast = CSSTree.parse(text, {
			context: "atrulePrelude",
			atrule: "supports",
			positions: true,
		}) as unknown as {children?: {toArray(): SupportsNode[]} | null};
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
	condition: SupportsNode,
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
				: joiner === "or"
					? matches || operand
					: matches && operand;
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
function supportsOperandMatches(part: SupportsNode, source: string): boolean {
	const sliceOf = (node: SupportsNode | null | undefined): string | null =>
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
function cssSupports(conditionOrProperty: string, value?: string): boolean {
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

const CSSNamespace = {
	escape(ident: string): string {
		if (arguments.length === 0) {
			throw typeError("escape requires an identifier");
		}
		return serializeCSSIdentifier(String(ident));
	},
	supports: cssSupports,
};
// A namespace object's class string is its name, and is not writable.
Object.defineProperty(CSSNamespace, Symbol.toStringTag, {
	value: "CSS",
	writable: false,
	enumerable: false,
	configurable: true,
});

// Longhands the grammar leaves out reset to their initial value, as a
// browser's shorthand write does. Null for a grammar this engine does
// not decompose, which stays a declaration of its own.
function expandShorthandValue(
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

function serializeShorthandValue(
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
function camelCaseProperty(property: string, lowercaseFirst = false): string {
	const source = lowercaseFirst ? property.slice(1) : property;
	return source.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
}

const inlineStyles = new WeakMap<Element, CSSStyleDeclaration>();

const kLayout = Symbol("layout");
const kStylesheetsDirty = Symbol("stylesheetsDirty");
const kParsing = Symbol("parsing");
const kPseudoHosts = Symbol("pseudoHosts");
const kElement = Symbol("element");
const kParentRule = Symbol("parentRule");
const kOnChange = Symbol("onChange");
const kDescriptors = Symbol("descriptors");
const kKeyframe = Symbol("keyframe");
const kAttributeText = Symbol("attributeText");
const kDeclarations = Symbol("declarations");
const kByName = Symbol("byName");
const kBlock = Symbol("block");
const kIndexed = Symbol("indexed");
const kSync = Symbol("sync");

// Declarations are stored as longhands. A shorthand write expands and a
// shorthand read reconstructs. An element-owned block and the `style`
// attribute are one store seen from two sides: a property write
// serializes through setAttribute, so attribute invalidation fires
// either way, and an attribute write reparses on the next read, detected
// by the text differing from what this object last serialized.
class CSSStyleDeclaration {
	[index: number]: string;
	declare [kElement]: Element | null;
	declare [kParentRule]: CSSRule | null;
	declare [kOnChange]: (() => void) | null;

	// The at-rule whose descriptors this block holds, or empty for a block
	// of CSS properties. Only an at-rule's own grammar can validate its
	// descriptors.
	declare [kDescriptors]: string;

	declare [kKeyframe]: boolean;
	declare [kDeclarations]: CSSDeclaration[];

	// `all` expands to every longhand there is, and a scan per lookup would
	// make serializing such a block cubic in its size.
	declare [kByName]: Map<string, CSSDeclaration>;

	// The `style` attribute text this object last serialized or parsed.
	declare [kAttributeText]: string | null;

	// The declarations expanded to longhands for the cascade.
	declare [kBlock]: DeclarationBlock | null;

	// How many numeric index properties currently name a declaration.
	declare [kIndexed]: number;

	constructor(
		owner: {
			element?: Element;
			parentRule?: CSSRule;
			onChange?: () => void;
			descriptors?: string;
			keyframe?: boolean;
		} = {},
	) {
		this[kDeclarations] = [];
		this[kByName] = new Map<string, CSSDeclaration>();
		this[kAttributeText] = null;
		this[kBlock] = null;
		this[kIndexed] = 0;
		this[kElement] = owner.element ?? null;
		this[kParentRule] = owner.parentRule ?? null;
		this[kOnChange] = owner.onChange ?? null;
		this[kDescriptors] = owner.descriptors ?? "";
		this[kKeyframe] = Boolean(owner.keyframe);
	}

	get parentRule(): CSSRule | null {
		return this[kParentRule];
	}

	get length(): number {
		this[kSync]!();
		return this[kDeclarations].length;
	}

	get cssText(): string {
		this[kSync]!();
		return serializeDeclarations(this);
	}

	set cssText(text: string) {
		this[kSync]!();
		this[kDeclarations] = [];
		this[kByName].clear();
		for (const declaration of parseDeclarationText(text ?? "")) {
			if (!isSupportedDeclaration(this, declaration.name)) {
				continue;
			}
			applyDeclaration(
				this,
				declaration.name,
				declaration.value,
				declaration.important,
				true,
			);
		}
		flushStyleAttribute(this);
	}

	item(index: number): string {
		this[kSync]!();
		return this[kDeclarations][index]?.name ?? "";
	}

	[Symbol.iterator](): IterableIterator<string> {
		this[kSync]!();
		return this[kDeclarations].map((entry) => entry.name)[Symbol.iterator]();
	}

	getPropertyValue(property: string): string {
		this[kSync]!();
		const name = normalizePropertyName(property);
		const declared = findDeclaration(this, name);
		if (declared) {
			return declared.value;
		}
		const longhands = SHORTHAND_LONGHANDS.get(name);
		return longhands ? getShorthandValue(this, name, longhands) : "";
	}

	getPropertyPriority(property: string): string {
		this[kSync]!();
		const name = normalizePropertyName(property);
		const declared = findDeclaration(this, name);
		if (declared) {
			return declared.important ? "important" : "";
		}
		const longhands = SHORTHAND_LONGHANDS.get(name);
		if (
			longhands &&
			longhands.every((longhand) => findDeclaration(this, longhand)?.important)
		) {
			return "important";
		}
		return "";
	}

	setProperty(property: string, value: string, priority?: string): void {
		this[kSync]!();
		const name = normalizePropertyName(property);
		if (!isSupportedDeclaration(this, name)) {
			return;
		}
		// `[LegacyNullToEmptyString]`: null means the empty value, which
		// removes the declaration. Every other value is stringified, and
		// `undefined` stringifies to a value no property accepts, so the call
		// does nothing.
		const text = serializeCSSValue(value === null ? "" : String(value), name);
		if (text === "") {
			this.removeProperty(name);
			return;
		}
		const priorityText = String(priority ?? "").toLowerCase();
		if (priorityText !== "" && priorityText !== "important") {
			return;
		}
		if (applyDeclaration(this, name, text, priorityText === "important")) {
			flushStyleAttribute(this);
		}
	}

	removeProperty(property: string): string {
		this[kSync]!();
		const name = normalizePropertyName(property);
		const previous = this.getPropertyValue(name);
		let changed = removeDeclaration(this, name);
		for (const longhand of SHORTHAND_LONGHANDS.get(name) ?? []) {
			changed = removeDeclaration(this, longhand) || changed;
		}
		if (changed) {
			flushStyleAttribute(this);
		}
		return previous;
	}

	/**
	 * Reparse the `style` attribute if it changed since this object last wrote
	 * it.
	 */
	[kSync]?(): void {
		if (!this[kElement]) {
			return;
		}
		const text = this[kElement].getAttribute("style") ?? "";
		if (text === this[kAttributeText]) {
			return;
		}
		this[kAttributeText] = text;
		this[kDeclarations] = [];
		this[kByName].clear();
		for (const declaration of parseDeclarationText(text)) {
			applyDeclaration(
				this,
				declaration.name,
				declaration.value,
				declaration.important,
				true,
			);
		}
		invalidateDeclaration(this);
	}
}

function parseDeclarationText(text: string): CSSDeclaration[] {
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

const kTransitionsExist = Symbol("transitionsExist");

function getDeclarationBlock(style: CSSStyleDeclaration): DeclarationBlock {
	style[kSync]!();
	if (style[kDeclarations].length === 0) {
		return EMPTY_DECLARATIONS;
	}
	if (style[kBlock]) {
		return style[kBlock];
	}

	const declarations: Record<string, string> = {};
	const important: Record<string, boolean> = {};
	const order: Record<string, number> = {};
	const importantValues: Record<string, string> = {};
	let undecomposed = false;
	style[kDeclarations].forEach((entry, index) => {
		// An invalid declaration never enters the cascade. Dropping it lets a
		// lower-priority rule keep winning, as in a browser.
		if (!isValidDeclaration(entry.name, entry.value)) {
			return;
		}
		declarations[entry.name] = entry.value;
		order[entry.name] = index;
		if (entry.important) {
			important[entry.name] = true;
			importantValues[entry.name] = entry.value;
		}
		if (SHORTHAND_LONGHANDS.has(entry.name)) {
			undecomposed = true;
		}
	});

	// The block parse is the one path both the attribute and setProperty
	// forms of an inline transition come through.
	if (
		style[kElement] &&
		(declarations["transition"] !== undefined ||
			declarations["transition-duration"] !== undefined ||
			declarations["transition-delay"] !== undefined)
	) {
		const document = style[kElement].ownerDocument;
		const cascade = document ? documentCascades.get(document) : undefined;
		if (cascade) {
			cascade[kTransitionsExist] = true;
		}
	}

	// A shorthand this engine does not decompose reaches the cascade as
	// whatever longhands it can name, with its importance applied to each.
	if (undecomposed) {
		for (const property of Object.keys(expandShorthands(importantValues))) {
			important[property] = true;
		}
		style[kDeclarations].forEach((entry, index) => {
			const expanded = expandShorthands({[entry.name]: entry.value});
			for (const property in expanded) {
				order[property] = index;
			}
		});
		return (style[kBlock] = {
			declarations: expandShorthands(declarations),
			important,
			order,
		});
	}
	return (style[kBlock] = {declarations, important, order});
}

// Reconstructs shorthands and keeps priority.
function serializeDeclarations(
	block: CSSStyleDeclaration,
): string {
	const parts: string[] = [];
	const serialized = new Set<string>();
	// A shorthand this block cannot express is unexpressible at every one
	// of its longhands, because the declarations do not change during the
	// walk.
	const unserializable = new Set<string>();
	for (const declaration of block[kDeclarations]) {
		if (serialized.has(declaration.name)) {
			continue;
		}
		let text = "";
		for (const shorthand of LONGHAND_SHORTHANDS.get(declaration.name) ?? []) {
			if (unserializable.has(shorthand)) {
				continue;
			}
			const longhands = SHORTHAND_LONGHANDS.get(shorthand)!;
			// A shorthand covering more properties than the block holds cannot
			// be serialized from it, and `all` covers hundreds.
			if (longhands.length > block[kDeclarations].length) {
				continue;
			}
			const value = getShorthandValue(block, shorthand, longhands);
			if (!value) {
				unserializable.add(shorthand);
				continue;
			}
			const important = findDeclaration(block, longhands[0])!.important;
			text = `${shorthand}: ${value}${important ? " !important" : ""};`;
			for (const longhand of longhands) {
				serialized.add(longhand);
			}
			break;
		}
		if (!text) {
			const priority = declaration.important ? " !important" : "";
			text = `${serializePropertyName(declaration.name)}: ${
				declaration.value
			}${priority};`;
			serialized.add(declaration.name);
		}
		parts.push(text);
	}
	return parts.join(" ");
}

// Serializes to the `style` attribute, which is what invalidation
// observes.
function flushStyleAttribute(
	declaration: CSSStyleDeclaration,
): void {
	invalidateDeclaration(declaration);
	if (declaration[kElement]) {
		declaration[kAttributeText] = serializeDeclarations(declaration);
		declaration[kElement].setAttribute("style", declaration[kAttributeText]);
	}
	declaration[kOnChange]?.();
}

function invalidateDeclaration(
	declaration: CSSStyleDeclaration,
): void {
	declaration[kBlock] = null;
	for (let i = 0; i < declaration[kIndexed]; i++) {
		delete declaration[i];
	}
	declaration[kIndexed] = declaration[kDeclarations].length;
	for (let i = 0; i < declaration[kIndexed]; i++) {
		declaration[i] = declaration[kDeclarations][i].name;
	}
}

function findDeclaration(
	declaration: CSSStyleDeclaration,
	property: string,
): CSSDeclaration | undefined {
	return declaration[kByName].get(property);
}

const DESCRIPTOR_NAMES = new Map<string, ReadonlySet<string>>();

const KEYFRAME_EXCLUDED = /^animation(?:-|$)/;

function isSupportedDeclaration(
	declaration: CSSStyleDeclaration,
	name: string,
): boolean {
	// A keyframe's block is one step of an animation, and the animation's
	// own properties describe the whole rather than the step.
	if (declaration[kKeyframe] && KEYFRAME_EXCLUDED.test(name)) {
		return false;
	}
	if (declaration[kDescriptors]) {
		// An at-rule's block holds its own descriptors. One this engine has no
		// descriptor list for accepts whatever it is given, which keeps
		// @font-feature-values' feature blocks working.
		const names = DESCRIPTOR_NAMES.get(declaration[kDescriptors]);
		return names ? names.has(name) : name !== "";
	}

	return name.startsWith("--") || SUPPORTED_PROPERTIES.has(name);
}

// A declaration that changes the value moves to the END of the block.
// Restating one unchanged leaves it in place.
function storeDeclaration(
	declaration: CSSStyleDeclaration,
	name: string,
	value: string,
	important: boolean,
	cascade = false,
): boolean {
	const declared = findDeclaration(declaration, name);
	if (declared) {
		// Parsing a block is a cascade in miniature. A normal declaration does
		// not displace an important one already there.
		if (cascade && declared.important && !important) {
			return false;
		}
		if (declared.value === value && declared.important === important) {
			return false;
		}
		removeDeclaration(declaration, name);
	}
	const entry = {name, value, important};
	declaration[kDeclarations].push(entry);
	declaration[kByName].set(name, entry);
	return true;
}

function removeDeclaration(
	declaration: CSSStyleDeclaration,
	name: string,
): boolean {
	const index = declaration[kDeclarations].findIndex(
		(entry) => entry.name === name,
	);
	if (index === -1) {
		return false;
	}
	declaration[kDeclarations].splice(index, 1);
	declaration[kByName].delete(name);
	return true;
}

function applyDeclaration(
	declaration: CSSStyleDeclaration,
	name: string,
	value: string,
	important: boolean,
	cascade = false,
): boolean {
	// A declaration whose value does not parse is not stored at all, so a
	// shorthand with one bad component is dropped whole rather than leaving
	// its good components behind.
	if (!isValidDeclaration(name, value, declaration[kDescriptors])) {
		return false;
	}
	const expanded = expandShorthandValue(name, value);
	// A shorthand this engine does not decompose (`font: menu`, a system
	// font) is stored whole, and still covers its longhands: any declared
	// on their own are dropped, as the standard's set-a-declaration does.
	let changed = false;
	if (!expanded) {
		for (const longhand of SHORTHAND_LONGHANDS.get(name) ?? []) {
			if (
				cascade &&
				findDeclaration(declaration, longhand)?.important &&
				!important
			) {
				continue;
			}
			changed = removeDeclaration(declaration, longhand) || changed;
		}
		return storeDeclaration(declaration, name, value, important, cascade) ||
			changed;
	}
	changed = removeDeclaration(declaration, name);
	for (const longhand of SHORTHAND_LONGHANDS.get(name)!) {
		if (longhand in expanded) {
			continue;
		}
		if (
			cascade && findDeclaration(declaration, longhand)?.important && !important
		) {
			continue;
		}
		changed = removeDeclaration(declaration, longhand) || changed;
	}
	for (const [longhand, longhandValue] of Object.entries(expanded)) {
		changed =
			storeDeclaration(
				declaration,
				longhand,
				longhandValue,
				important,
				cascade,
			) ||
			changed;
	}
	return changed;
}

// Returns "" when the longhands do not agree on one value.
function getShorthandValue(
	declaration: CSSStyleDeclaration,
	shorthand: string,
	longhands: readonly string[],
): string {
	let important: boolean | null = null;
	for (const longhand of longhands) {
		const declared = findDeclaration(declaration, longhand);
		if (!declared) {
			return "";
		}
		if (important === null) {
			important = declared.important;
		} else if (important !== declared.important) {
			return "";
		}
	}
	return serializeShorthandValue(
		shorthand,
		longhands,
		(longhand) => findDeclaration(declaration, longhand)!.value,
	);
}

// Reflects every property in the index as an IDL attribute, which is
// what separates it from an at-rule's descriptor blocks. `cssFloat`
// exists on a style rule's block and not on an @page's.
class CSSStyleProperties extends CSSStyleDeclaration {}

// Custom properties keep their case. Everything else is
// ASCII-lowercased.
function normalizePropertyName(property: string): string {
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
function serializePropertyName(property: string): string {
	return property.startsWith("--")
		? `--${serializeCSSIdentifier(property.slice(2))}`
		: property;
}

for (const property of CSS_PROPERTIES) {
	const descriptor: PropertyDescriptor = {
		get(this: CSSStyleDeclaration) {
			return this.getPropertyValue(property);
		},
		set(this: CSSStyleDeclaration, value: unknown) {
			this.setProperty(property, value == null ? "" : String(value));
		},
		configurable: true,
		enumerable: true,
	};
	const names = [camelCaseProperty(property)];
	if (property.startsWith("-webkit-")) {
		names.push(camelCaseProperty(property, true));
	}
	if (property !== names[0]) {
		names.push(property);
	}
	if (property === "float") {
		names.push("cssFloat");
	}
	for (const [index, name] of names.entries()) {
		Object.defineProperty(CSSStyleProperties.prototype, name, {
			...descriptor,
			enumerable: index === 0,
		});
	}
}

// An error thrown out of a stylesheet has to be the document's own
// DOMException. A sheet reaches its document through its owner node. A
// constructed sheet has none, and uses the window its constructor came
// from.
let cssomWindow: Window | null = null;

function getSheetView(
	sheet: CSSStyleSheet | null | undefined,
): object | undefined {
	const owner = sheet ? sheet.ownerNode : null;
	const document = owner === null ? null : owner.ownerDocument;
	return document === null ? undefined : (document.defaultView ?? undefined);
}

function typeError(message: string, sheet?: CSSStyleSheet | null): TypeError {
	const view = getSheetView(sheet) ?? cssomWindow ?? undefined;
	const Constructor =
		(view as unknown as {TypeError?: typeof TypeError} | undefined)
			?.TypeError ?? TypeError;
	return new Constructor(message);
}

function domException(
	message: string,
	name: string,
	sheet?: CSSStyleSheet | null,
): DOMException {
	const view = getSheetView(sheet) ?? cssomWindow ?? undefined;
	const Exception =
		(view as unknown as {DOMException?: typeof DOMException} | undefined)
			?.DOMException ?? DOMException;
	return new Exception(message, name);
}

const RULE_TYPES = {
	STYLE_RULE: 1,
	CHARSET_RULE: 2,
	IMPORT_RULE: 3,
	MEDIA_RULE: 4,
	FONT_FACE_RULE: 5,
	PAGE_RULE: 6,
	KEYFRAMES_RULE: 7,
	KEYFRAME_RULE: 8,
	NAMESPACE_RULE: 10,
	COUNTER_STYLE_RULE: 11,
	SUPPORTS_RULE: 12,
	FONT_FEATURE_VALUES_RULE: 14,
} as const;

// Registered per sheet rather than exposed on it, so a rule can reach
// its sheet's consumer without the sheet exposing a method authors
// should not see.
const sheetNotifiers = new WeakMap<CSSStyleSheet, () => void>();

function sheetChanged(sheet: CSSStyleSheet | null | undefined): void {
	if (sheet) {
		sheetNotifiers.get(sheet)?.();
	}
}

const kIndexCount = Symbol("index count");

interface IndexedCollection {
	readonly length: number;
	item(index: number): unknown;
	[kIndexCount]?: number;
	[index: number]: unknown;
}

// Provides `list[0]` alongside `list.item(0)`, reading through item() so
// the values stay live. Accessors beat a Proxy: every non-index read of
// a proxied list pays the get trap, and each method read pays a bind.
function syncIndexed(collection: object, items?: readonly unknown[]): void {
	const list = collection as IndexedCollection;
	const previous = list[kIndexCount] ?? 0;
	const length = items ? items.length : list.length;
	for (let index = previous; index < length; index++) {
		Object.defineProperty(list, index, {
			get: items
				? (): unknown => items[index]
				: (): unknown => list.item(index) ?? undefined,
			enumerable: true,
			configurable: true,
		});
	}
	for (let index = length; index < previous; index++) {
		delete list[index];
	}
	list[kIndexCount] = length;
}

// A comment can appear anywhere whitespace can, so it becomes a space.
// Media text is sliced by hand here, and a comment left in would be
// carried into a feature's parentheses and unbalance them.
function stripCSSComments(text: string): string {
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

interface MediaQueryNode {
	modifier?: string | null;
	mediaType?: string | null;
	condition?: MediaConditionNode | null;
}

interface MediaConditionNode {
	type: string;
	name?: string;
	loc?: ParsedSpan | null;
	value?: CSSNode | null;
	children?: {toArray(): MediaConditionNode[]} | null;
	left?: CSSNode | null;
	leftComparison?: string | null;
	middle?: CSSNode | null;
	rightComparison?: string | null;
	right?: CSSNode | null;
}

// One parse per spelling, with positions. Serialization slices the
// authored text at them.
const mediaQueryNodes = new Map<string, MediaQueryNode[] | null>();

function getMediaConditionParts(
	condition: MediaConditionNode | null | undefined,
): MediaConditionNode[] {
	return condition?.children ? condition.children.toArray() : [];
}

function parseMediaQueryList(text: string): MediaQueryNode[] | null {
	let queries = mediaQueryNodes.get(text);
	if (queries === undefined) {
		try {
			const ast = CSSTree.parse(text, {
				context: "mediaQueryList",
				positions: true,
			}) as unknown as {children: {toArray(): MediaQueryNode[]}};
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
function serializeMediaQuery(query: string): string {
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
					: type !== null
						? /^\s+and\s+$/i.test(gap)
						: gap === "";
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

function splitMediaQueryList(text: string): string[] {
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

const kMedia = Symbol("media");

/** The media queries a sheet or an `@media` rule applies under. */
export class MediaList implements globalThis.MediaList {
	[index: number]: string;

	// Mutated in place, so a list an author holds stays current.
	declare [kMedia]: string[];
	declare [kOnChange]: (() => void) | null;

	constructor(mediaText = "", onChange?: () => void) {
		this[kMedia] = [];
		this[kOnChange] = onChange ?? null;
		parseMediaText(this, mediaText);
	}

	get mediaText(): string {
		return this[kMedia].join(", ");
	}

	set mediaText(text: string) {
		parseMediaText(this, text);
		this[kOnChange]?.();
	}

	get length(): number {
		return this[kMedia].length;
	}

	item(index: number): string | null {
		return this[kMedia][index] ?? null;
	}

	// Parsed as a SINGLE media query. A comma-separated list parses to
	// nothing and the call does nothing.
	appendMedium(medium: string): void {
		if (arguments.length === 0) {
			throw typeError("appendMedium requires a medium");
		}
		const text = stripCSSComments(String(medium));
		if (splitMediaQueryList(text).length !== 1) {
			return;
		}
		const query = serializeMediaQuery(text);
		if (!query || this[kMedia].includes(query)) {
			return;
		}
		this[kMedia].push(query);
		syncIndexed(this);
		this[kOnChange]?.();
	}

	deleteMedium(medium: string): void {
		if (arguments.length === 0) {
			throw typeError("deleteMedium requires a medium");
		}
		const text = stripCSSComments(String(medium));
		const query =
			splitMediaQueryList(text).length === 1 ? serializeMediaQuery(text) : "";
		const kept = this[kMedia].filter((entry) => entry !== query);
		if (kept.length === this[kMedia].length) {
			throw domException(`No such medium: ${medium}`, "NotFoundError");
		}
		this[kMedia].length = 0;
		this[kMedia].push(...kept);
		syncIndexed(this);
		this[kOnChange]?.();
	}

	[Symbol.iterator](): ArrayIterator<string> {
		return this[kMedia][Symbol.iterator]();
	}

	toString(): string {
		return this.mediaText;
	}
}

function parseMediaText(
	list: MediaList,
	text: string,
): void {
	list[kMedia].length = 0;
	for (const query of splitMediaQueryList(
		stripCSSComments(String(text ?? "")),
	)) {
		const serialized = serializeMediaQuery(query);
		if (serialized) {
			list[kMedia].push(serialized);
		}
	}
	syncIndexed(list);
}

// Stored beside the rule so deleting one can cut the link. A removed
// rule belongs to no stylesheet, and reports that.
const ruleSheets = new WeakMap<CSSRule, CSSStyleSheet | null>();

function detachRule(rule: CSSRule): void {
	ruleSheets.set(rule, null);
	const group = rule as {cssRules?: CSSRuleList};
	if (group.cssRules) {
		for (const child of Array.from(group.cssRules)) {
			detachRule(child);
		}
	}
}

abstract class CSSRule {
	static readonly STYLE_RULE = RULE_TYPES.STYLE_RULE;
	static readonly CHARSET_RULE = RULE_TYPES.CHARSET_RULE;
	static readonly IMPORT_RULE = RULE_TYPES.IMPORT_RULE;
	static readonly MEDIA_RULE = RULE_TYPES.MEDIA_RULE;
	static readonly FONT_FACE_RULE = RULE_TYPES.FONT_FACE_RULE;
	static readonly PAGE_RULE = RULE_TYPES.PAGE_RULE;
	static readonly KEYFRAMES_RULE = RULE_TYPES.KEYFRAMES_RULE;
	static readonly KEYFRAME_RULE = RULE_TYPES.KEYFRAME_RULE;
	static readonly NAMESPACE_RULE = RULE_TYPES.NAMESPACE_RULE;
	static readonly COUNTER_STYLE_RULE = RULE_TYPES.COUNTER_STYLE_RULE;
	static readonly SUPPORTS_RULE = RULE_TYPES.SUPPORTS_RULE;
	static readonly FONT_FEATURE_VALUES_RULE =
		RULE_TYPES.FONT_FEATURE_VALUES_RULE;

	declare [kParentRule]: CSSRule | null;

	constructor(
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		ruleSheets.set(this, parentStyleSheet);
		this[kParentRule] = parentRule;
	}

	abstract get type(): number;
	abstract get cssText(): string;

	get parentRule(): CSSRule | null {
		return this[kParentRule];
	}

	get parentStyleSheet(): CSSStyleSheet | null {
		return ruleSheets.get(this) ?? null;
	}
}

for (const [name, value] of Object.entries(RULE_TYPES)) {
	Object.defineProperty(CSSRule.prototype, name, {
		value,
		enumerable: true,
	});
}

function notifyRule(rule: CSSRule): void {
	sheetChanged(rule.parentStyleSheet);
}

const kRuleList = Symbol("ruleList");
const kRules = Symbol("rules");

abstract class CSSGroupingRule extends CSSRule {
	declare [kRules]: CSSRule[];
	declare [kRuleList]: CSSRuleList;

	constructor(
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule);
		this[kRules] = [];
		this[kRuleList] = createRuleList(this[kRules]);
		if (build) {
			this[kRules].push(...build(this));
			syncIndexed(this[kRuleList]);
		}
	}

	get cssRules(): CSSRuleList {
		return this[kRuleList];
	}

	insertRule(text: string, index = 0): number {
		if (arguments.length === 0) {
			throw typeError(
				"insertRule requires a rule",
				this.parentStyleSheet ?? undefined,
			);
		}
		if (index > this[kRules].length) {
			throw domException(
				`Cannot insert at index ${index}`,
				"IndexSizeError",
				this.parentStyleSheet,
			);
		}
		const inserted = parseRuleText(text, this.parentStyleSheet, this);
		if (
			inserted instanceof CSSImportRule ||
			inserted instanceof CSSNamespaceRule
		) {
			throw domException(
				"Only a stylesheet may hold that rule",
				"HierarchyRequestError",
				this.parentStyleSheet,
			);
		}
		this[kRules].splice(index, 0, inserted);
		syncIndexed(this[kRuleList]);
		notifyRule(this);
		return index;
	}

	deleteRule(index: number): void {
		if (arguments.length === 0) {
			throw typeError(
				"deleteRule requires an index",
				this.parentStyleSheet ?? undefined,
			);
		}
		if (index >= this[kRules].length) {
			throw domException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
				this.parentStyleSheet,
			);
		}
		detachRule(this[kRules][index]);
		this[kRules].splice(index, 1);
		syncIndexed(this[kRuleList]);
		notifyRule(this);
	}
}

function serializeGroupRules(group: CSSGroupingRule): string {
	return Array.from(group.cssRules)
		.map((rule) => `\n  ${rule.cssText.replace(/\n/g, "\n  ")}`)
		.join("");
}

abstract class CSSConditionRule extends CSSGroupingRule {
	abstract get conditionText(): string;
}

const kSelectors = Symbol("selectors");
const kStyle = Symbol("style");
const kSelectorText = Symbol("selectorText");

// Avoids the serialize-and-reparse a cssText assignment would run. The
// filters are the cssText setter's.
function assignDeclarations(
	block: CSSStyleDeclaration,
	declarations: readonly CSSDeclaration[],
): void {
	for (const declaration of declarations) {
		if (!isSupportedDeclaration(block, declaration.name)) {
			continue;
		}
		const {name, value, important} = declaration;
		applyDeclaration(block, name, value, important, true);
	}
	flushStyleAttribute(block);
}

class CSSStyleRule extends CSSGroupingRule {
	declare [kSelectors]: SelectorNode;
	declare [kSelectorText]: string | null;
	declare [kStyle]: CSSStyleDeclaration;

	constructor(
		selectors: SelectorNode,
		block: string | readonly CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kSelectorText] = null;
		this[kSelectors] = selectors;
		this[kStyle] = new CSSStyleProperties({
			parentRule: this,
			onChange: () => notifyRule(this),
		});
		if (typeof block === "string") {
			this[kStyle].cssText = block;
		} else {
			assignDeclarations(this[kStyle], block);
		}
	}

	get type(): number {
		return RULE_TYPES.STYLE_RULE;
	}

	// Serialized on first read, because whether `*|E` keeps its prefix
	// depends on `@namespace` rules that are only in place once parsing
	// finishes.
	get selectorText(): string {
		return (this[kSelectorText] ??= serializeSelectorList(
			this[kSelectors],
			getSheetNamespaces(this.parentStyleSheet),
		));
	}

	/** A selector that does not parse leaves the rule unchanged. */
	set selectorText(selector: string) {
		const selectors = parseSelectorList(selector);
		if (!selectors) {
			return;
		}
		this[kSelectors] = selectors;
		this[kSelectorText] = null;
		notifyRule(this);
	}

	get style(): CSSStyleDeclaration {
		return this[kStyle];
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this[kStyle].cssText = String(text);
	}

	get cssText(): string {
		const declarations = this[kStyle].cssText;
		const nested = serializeGroupRules(this);
		const selector = this.selectorText;
		if (nested) {
			return `${selector} { ${declarations}${nested}\n}`;
		}
		return declarations ? `${selector} { ${declarations} }` : `${selector} { }`;
	}
}

// A prefix no `@namespace` declared names no namespace, and a selector
// using one does not parse. The prefixes stay in the selector, and the
// matcher resolves them against the sheet's map.
function namespacePrefixesDeclared(
	selector: string,
	namespaces: SelectorNamespaces,
): boolean {
	try {
		compileSelector(selector, {namespaces, pseudoElements: true});
		return true;
	} catch (_err) {
		return false;
	}
}

function getSheetNamespaces(sheet: CSSStyleSheet | null): SelectorNamespaces {
	if (!sheet) {
		return NO_NAMESPACES;
	}
	const namespaces: SelectorNamespaces = {default: null, prefixes: new Map()};
	for (const rule of Array.from(sheet.cssRules)) {
		if (!(rule instanceof CSSNamespaceRule)) {
			continue;
		}
		if (rule.prefix === "") {
			namespaces.default = rule.namespaceURI;
		} else {
			namespaces.prefixes.set(
				CSSTree.ident.decode(rule.prefix),
				rule.namespaceURI,
			);
		}
	}
	return namespaces;
}

// One class per at-rule that declares descriptors. A descriptor is
// named only inside its own at-rule, so `src` exists on
// CSSFontFaceDescriptors and nothing else.
const DESCRIPTOR_BLOCKS = new Map<string, typeof CSSStyleDeclaration>();

for (const [atRule, descriptors] of Object.entries(CSS_AT_RULE_DESCRIPTORS)) {
	const name = `CSS${atRule
		.slice(1)
		.replace(/(?:^|-)([a-z])/g, (_, letter: string) =>
			letter.toUpperCase(),
		)}Descriptors`;
	const block = class extends CSSStyleDeclaration {};
	DESCRIPTOR_NAMES.set(atRule, new Set(descriptors));
	Object.defineProperty(block, "name", {value: name, configurable: true});
	Object.defineProperty(block.prototype, Symbol.toStringTag, {
		value: name,
		configurable: true,
	});
	for (const descriptor of descriptors) {
		const attribute = camelCaseProperty(descriptor);
		for (const [index, key] of [attribute, descriptor].entries()) {
			if (index === 1 && key === attribute) {
				continue;
			}
			Object.defineProperty(block.prototype, key, {
				get(this: CSSStyleDeclaration) {
					return this.getPropertyValue(descriptor);
				},
				set(this: CSSStyleDeclaration, value: unknown) {
					this.setProperty(descriptor, value == null ? "" : String(value));
				},
				configurable: true,
				enumerable: index === 0,
			});
		}
	}
	DESCRIPTOR_BLOCKS.set(atRule, block);
}

abstract class CSSDeclarationBlockRule extends CSSRule {
	declare [kStyle]: CSSStyleDeclaration;

	constructor(
		block: string | readonly CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		const atRule = (this.constructor as unknown as {atRule?: string}).atRule;
		const Block =
			(atRule ? DESCRIPTOR_BLOCKS.get(atRule) : undefined) ??
			CSSStyleProperties;
		this[kStyle] = new Block({
			parentRule: this,
			onChange: () => notifyRule(this),
			// A descriptor block declares descriptors, not CSS properties, so
			// the property index does not restrict what it may hold.
			descriptors: atRule ?? "",
			keyframe: this instanceof CSSKeyframeRule,
		});
		if (typeof block === "string") {
			this[kStyle].cssText = block;
		} else {
			assignDeclarations(this[kStyle], block);
		}
	}

	get style(): CSSStyleDeclaration {
		return this[kStyle];
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this[kStyle].cssText = String(text);
	}

	/** The at-keyword and prelude this rule's text opens with. */
	abstract get prelude(): string;

	get cssText(): string {
		const declarations = this[kStyle].cssText;
		return declarations
			? `${this.prelude} { ${declarations} }`
			: `${this.prelude} { }`;
	}
}

/** `@font-face`: the descriptors of a font this terminal will never load. */
class CSSFontFaceRule extends CSSDeclarationBlockRule {
	/** The at-rule whose descriptors this rule's block holds. */
	static readonly atRule = "@font-face";

	get type(): number {
		return RULE_TYPES.FONT_FACE_RULE;
	}

	get prelude(): string {
		return "@font-face";
	}
}

/** `@page`: the page selector and its descriptors. */
class CSSPageRule extends CSSDeclarationBlockRule {
	/** The at-rule whose descriptors this rule's block holds. */
	static readonly atRule = "@page";

	declare [kSelectorText]: string;

	constructor(
		selectorText: string,
		block: string | readonly CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(block, parentStyleSheet, parentRule);
		this[kSelectorText] = serializePageSelector(selectorText);
	}

	get type(): number {
		return RULE_TYPES.PAGE_RULE;
	}

	get selectorText(): string {
		return this[kSelectorText];
	}

	set selectorText(selector: string) {
		this[kSelectorText] = serializePageSelector(String(selector));
		notifyRule(this);
	}

	get prelude(): string {
		return this[kSelectorText] ? `@page ${this[kSelectorText]}` : "@page";
	}
}

/** The page pseudo-classes a `@page` selector may name. */
const PAGE_PSEUDO_CLASSES = new Set(["blank", "first", "left", "right"]);

/**
 * A page selector (an optional page name followed by page pseudo-classes,
 * with no whitespace between them), or "" when it names no valid page.
 */
function serializePageSelector(selector: string): string {
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

const kName = Symbol("name");

/**
 * A named at-rule with a descriptor block: `@counter-style x { ... }` and
 * similar. The name is the prelude and the block holds the declarations.
 */
class CSSNamedDeclarationRule extends CSSDeclarationBlockRule {
	/** The at-rule whose descriptors this rule's block holds. */
	static readonly atRule: string = "";

	declare [kName]: string;

	constructor(
		name: string,
		block: string | readonly CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(block, parentStyleSheet, null);
		this[kName] = name.trim();
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this[kName];
	}

	get prelude(): string {
		return `${(this.constructor as typeof CSSNamedDeclarationRule).atRule} ${
			this[kName]
		}`;
	}
}

/** `@counter-style`: a counter's name and the descriptors that define it. */
class CSSCounterStyleRule extends CSSNamedDeclarationRule {
	static override readonly atRule = "@counter-style";

	override get type(): number {
		return RULE_TYPES.COUNTER_STYLE_RULE;
	}

	override get name(): string {
		return this[kName];
	}

	override set name(name: string) {
		const text = String(name).trim();
		if (!text) {
			return;
		}
		this[kName] = text;
		notifyRule(this);
	}
}

/** `@property`: a custom property's registration. */
class CSSPropertyRule extends CSSNamedDeclarationRule {
	static override readonly atRule = "@property";

	get syntax(): string {
		return this.style.getPropertyValue("syntax");
	}

	get inherits(): boolean {
		return this.style.getPropertyValue("inherits") === "true";
	}

	get initialValue(): string | null {
		return this.style.getPropertyValue("initial-value") || null;
	}
}

/** `@font-palette-values`: a palette's name and its descriptors. */
class CSSFontPaletteValuesRule extends CSSNamedDeclarationRule {
	static override readonly atRule = "@font-palette-values";

	get fontFamily(): string {
		return this.style.getPropertyValue("font-family");
	}

	get basePalette(): string {
		return this.style.getPropertyValue("base-palette");
	}

	get overrideColors(): string {
		return this.style.getPropertyValue("override-colors");
	}
}

const kKeyText = Symbol("keyText");

/** One keyframe of an `@keyframes` rule: its offsets and its declarations. */
class CSSKeyframeRule extends CSSDeclarationBlockRule {
	declare [kKeyText]: string;

	constructor(
		keyText: string,
		block: string | readonly CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(block, parentStyleSheet, parentRule);
		this[kKeyText] = serializeKeyText(keyText);
	}

	get type(): number {
		return RULE_TYPES.KEYFRAME_RULE;
	}

	get keyText(): string {
		return this[kKeyText];
	}

	set keyText(text: string) {
		const serialized = serializeKeyText(String(text));
		if (!serialized) {
			throw domException(
				`Cannot parse keyText: ${text}`,
				"SyntaxError",
				this.parentStyleSheet,
			);
		}
		this[kKeyText] = serialized;
		notifyRule(this);
	}

	get prelude(): string {
		return this[kKeyText];
	}
}

// `from` is 0%, `to` is 100%.
function serializeKeyText(text: string): string {
	const source = String(text).trim();
	let list: {loc?: ParsedSpan | null; children: {toArray(): CSSNode[]}};
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

/** `@media`: the rules that apply when the viewport matches. */
class CSSMediaRule extends CSSConditionRule {
	declare [kMedia]: MediaList;

	constructor(
		mediaText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kMedia] = new MediaList(mediaText, () => notifyRule(this));
	}

	get type(): number {
		return RULE_TYPES.MEDIA_RULE;
	}

	get media(): MediaList {
		return this[kMedia];
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this[kMedia].mediaText = String(text);
	}

	/** Read-only. The media list behind it is what an author sets. */
	get conditionText(): string {
		return this[kMedia].mediaText;
	}

	get cssText(): string {
		return `@media ${this.conditionText} {${serializeGroupRules(this)}\n}`;
	}
}

const kConditionText = Symbol("conditionText");

/** A grouping rule whose condition this engine keeps as authored text. */
abstract class CSSTextConditionRule extends CSSConditionRule {
	declare [kConditionText]: string;

	constructor(
		conditionText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kConditionText] = conditionText.trim();
	}

	get conditionText(): string {
		return this[kConditionText];
	}

	abstract get atKeyword(): string;

	get cssText(): string {
		const condition = this[kConditionText] ? ` ${this[kConditionText]}` : "";
		return `${this.atKeyword}${condition} {${serializeGroupRules(this)}\n}`;
	}
}

/** `@supports`: its rules apply, since what this engine supports it renders. */
class CSSSupportsRule extends CSSTextConditionRule {
	get type(): number {
		return RULE_TYPES.SUPPORTS_RULE;
	}

	get atKeyword(): string {
		return "@supports";
	}
}

/** A top-level node from parsing a `@container` prelude. */
interface ContainerPreludeNode {
	type: string;
	name?: string;
	loc?: ParsedSpan | null;
}

const kContainerName = Symbol("containerName");
const kContainerQuery = Symbol("containerQuery");

/** `@container`: parsed, with no container query engine behind it. */
class CSSContainerRule extends CSSTextConditionRule {
	declare [kContainerName]: string;
	declare [kContainerQuery]: string;

	constructor(
		conditionText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(conditionText, parentStyleSheet, parentRule, build);
		// The prelude does not change for this rule, so its parts are read
		// once here.
		const parts = getContainerParts(this.conditionText);
		this[kContainerName] = parts.name;
		this[kContainerQuery] = parts.query;
	}

	get type(): number {
		return 0;
	}

	get atKeyword(): string {
		return "@container";
	}

	get containerName(): string {
		return this[kContainerName];
	}

	get containerQuery(): string {
		return this[kContainerQuery];
	}
}

// `none`, `and`, `or` and `not` name no container, so a prelude opening
// with one of those words is a query alone, as is a prelude outside the
// grammar.
function getContainerParts(prelude: string): {name: string; query: string} {
	let nodes: ContainerPreludeNode[] = [];
	try {
		const ast = CSSTree.parse(prelude, {
			context: "atrulePrelude",
			atrule: "container",
			positions: true,
		}) as unknown as {children?: {toArray(): ContainerPreludeNode[]} | null};
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

interface ScopePreludeNode {
	type: string;
	loc?: ParsedSpan | null;
	root?: ScopePreludeNode | null;
	limit?: ScopePreludeNode | null;
}

const kPrelude = Symbol("prelude");
const kScopeStart = Symbol("scopeStart");
const kScopeEnd = Symbol("scopeEnd");

/** `@scope`: parsed, and its rules apply unscoped. */
class CSSScopeRule extends CSSGroupingRule {
	declare [kPrelude]: string;
	declare [kScopeStart]: string | null;
	declare [kScopeEnd]: string | null;

	constructor(
		prelude: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kPrelude] = prelude.trim();
		// The prelude does not change for this rule, so its parts are read
		// once here.
		const limits = getScopeLimits(this[kPrelude]);
		this[kScopeStart] = limits.start;
		this[kScopeEnd] = limits.end;
	}

	get type(): number {
		return 0;
	}

	get start(): string | null {
		return this[kScopeStart];
	}

	get end(): string | null {
		return this[kScopeEnd];
	}

	get cssText(): string {
		const prelude = this[kPrelude] ? ` ${this[kPrelude]}` : "";
		return `@scope${prelude} {${serializeGroupRules(this)}\n}`;
	}
}

// Both null for a prelude outside the grammar. The limit alone for the
// implicit `@scope to (...)`.
function getScopeLimits(prelude: string): {
	start: string | null;
	end: string | null;
} {
	let scope: ScopePreludeNode | undefined;
	try {
		const ast = CSSTree.parse(prelude, {
			context: "atrulePrelude",
			atrule: "scope",
			positions: true,
		}) as unknown as {children?: {toArray(): ScopePreludeNode[]} | null};
		const nodes = ast.children ? ast.children.toArray() : [];
		if (nodes.length === 1 && nodes[0].type === "Scope") {
			scope = nodes[0];
		}
	} catch (_err) {
		scope = undefined;
	}
	const sliceOf = (node: ScopePreludeNode | null | undefined): string | null =>
		node?.loc
			? prelude.slice(node.loc.start.offset, node.loc.end.offset)
			: null;
	return {start: sliceOf(scope?.root), end: sliceOf(scope?.limit)};
}

/** `@starting-style`: parsed, and its rules never apply. */
class CSSStartingStyleRule extends CSSGroupingRule {
	get type(): number {
		return 0;
	}

	get cssText(): string {
		return `@starting-style {${serializeGroupRules(this)}\n}`;
	}
}

/** `@layer name { ... }`: its rules cascade in source order. */
class CSSLayerBlockRule extends CSSGroupingRule {
	declare [kName]: string;

	constructor(
		name: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kName] = name;
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this[kName];
	}

	get cssText(): string {
		const name = this[kName] ? ` ${this[kName]}` : "";
		return `@layer${name} {${serializeGroupRules(this)}\n}`;
	}
}

const kNames = Symbol("names");

/** `@layer a, b;`: the layer order, declared without a block. */
class CSSLayerStatementRule extends CSSRule {
	declare [kNames]: string[];

	constructor(
		names: readonly string[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		this[kNames] = [...names];
	}

	get type(): number {
		return 0;
	}

	get nameList(): readonly string[] {
		return this[kNames];
	}

	get cssText(): string {
		return `@layer ${this[kNames].join(", ")};`;
	}
}

const kPrefix = Symbol("prefix");
const kNamespaceURI = Symbol("namespaceURI");

/** `@namespace`: a prefix bound to a namespace URI. */
class CSSNamespaceRule extends CSSRule {
	declare [kPrefix]: string;
	declare [kNamespaceURI]: string;

	constructor(
		prefix: string,
		namespaceURI: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this[kPrefix] = prefix;
		this[kNamespaceURI] = namespaceURI;
	}

	get type(): number {
		return RULE_TYPES.NAMESPACE_RULE;
	}

	get prefix(): string {
		return this[kPrefix];
	}

	get namespaceURI(): string {
		return this[kNamespaceURI];
	}

	get cssText(): string {
		const prefix = this[kPrefix] ? `${this[kPrefix]} ` : "";
		return `@namespace ${prefix}url(${serializeCSSString(this[kNamespaceURI])});`;
	}
}

const kHref = Symbol("href");
const kLayerName = Symbol("layerName");
const kSupportsText = Symbol("supportsText");

// There is no network behind a terminal document. Nothing is fetched,
// the rule declares nothing, and its styleSheet is null.
class CSSImportRule extends CSSRule {
	declare [kHref]: string;
	declare [kMedia]: MediaList;
	declare [kLayerName]: string | null;
	declare [kSupportsText]: string | null;

	constructor(
		href: string,
		mediaText: string,
		layerName: string | null,
		supportsText: string | null,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this[kHref] = href;
		this[kMedia] = new MediaList(mediaText);
		this[kLayerName] = layerName;
		this[kSupportsText] = supportsText;
	}

	get type(): number {
		return RULE_TYPES.IMPORT_RULE;
	}

	get href(): string {
		return this[kHref];
	}

	get media(): MediaList {
		return this[kMedia];
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this[kMedia].mediaText = String(text);
	}

	get layerName(): string | null {
		return this[kLayerName];
	}

	get supportsText(): string | null {
		return this[kSupportsText];
	}

	get styleSheet(): CSSStyleSheet | null {
		return null;
	}

	get cssText(): string {
		let out = `@import url(${serializeCSSString(this[kHref])})`;
		if (this[kLayerName] !== null) {
			out += this[kLayerName] ? ` layer(${this[kLayerName]})` : " layer";
		}
		if (this[kSupportsText] !== null) {
			out += ` supports(${this[kSupportsText]})`;
		}
		const media = this[kMedia].mediaText;
		if (media) {
			out += ` ${media}`;
		}
		return `${out};`;
	}
}

const kFontFamily = Symbol("fontFamily");
const kBlocks = Symbol("blocks");

/** `@font-feature-values`: a font family and the feature blocks it names. */
class CSSFontFeatureValuesRule extends CSSRule {
	declare [kFontFamily]: string;
	declare [kBlocks]: Map<string, CSSStyleDeclaration>;

	constructor(
		fontFamily: string,
		node: ParsedNode,
		source: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this[kBlocks] = new Map<string, CSSStyleDeclaration>();
		this[kFontFamily] = fontFamily.trim();
		for (const child of getNodes(node.block ?? {})) {
			if (child.type !== "Atrule" || !child.name) {
				continue;
			}
			const block = new CSSStyleDeclaration({
				parentRule: this,
				onChange: () => notifyRule(this),
				descriptors: "@font-feature-values",
			});
			assignDeclarations(block, getBlockDeclarations(child, source));
			this[kBlocks].set(child.name.toLowerCase(), block);
		}
	}

	get type(): number {
		return RULE_TYPES.FONT_FEATURE_VALUES_RULE;
	}

	get fontFamily(): string {
		return this[kFontFamily];
	}

	set fontFamily(family: string) {
		this[kFontFamily] = String(family).trim();
		notifyRule(this);
	}

	get annotation(): CSSStyleDeclaration {
		return getFeatureBlock(this, "annotation");
	}

	get ornaments(): CSSStyleDeclaration {
		return getFeatureBlock(this, "ornaments");
	}

	get stylistic(): CSSStyleDeclaration {
		return getFeatureBlock(this, "stylistic");
	}

	get swash(): CSSStyleDeclaration {
		return getFeatureBlock(this, "swash");
	}

	get characterVariant(): CSSStyleDeclaration {
		return getFeatureBlock(this, "character-variant");
	}

	get styleset(): CSSStyleDeclaration {
		return getFeatureBlock(this, "styleset");
	}

	get cssText(): string {
		const blocks: string[] = [];
		for (const [name, block] of this[kBlocks]) {
			const declarations = block.cssText;
			if (declarations) {
				blocks.push(`\n  @${name} { ${declarations} }`);
			}
		}
		return `@font-feature-values ${this[kFontFamily]} {${blocks.join("")}\n}`;
	}
}

function getFeatureBlock(
	rule: CSSFontFeatureValuesRule,
	name: string,
): CSSStyleDeclaration {
	let block = rule[kBlocks].get(name);
	if (!block) {
		block = new CSSStyleDeclaration({
			parentRule: rule,
			onChange: () => notifyRule(rule),
			descriptors: "@font-feature-values",
		});
		rule[kBlocks].set(name, block);
	}
	return block;
}

/** `@keyframes`: its name and the keyframes it holds. */
class CSSKeyframesRule extends CSSRule {
	declare [kName]: string;
	declare [kRules]: CSSRule[];
	declare [kRuleList]: CSSRuleList;

	constructor(
		name: string,
		parentStyleSheet: CSSStyleSheet | null,
		build?: (rule: CSSKeyframesRule) => CSSRule[],
	) {
		super(parentStyleSheet, null);
		this[kRules] = [];
		this[kName] = name.trim();
		this[kRuleList] = createRuleList(this[kRules]);
		if (build) {
			this[kRules].push(...build(this));
			syncIndexed(this[kRuleList]);
		}
		syncIndexed(this, this[kRules]);
	}

	get type(): number {
		return RULE_TYPES.KEYFRAMES_RULE;
	}

	get name(): string {
		return this[kName];
	}

	set name(name: string) {
		this[kName] = String(name);
		notifyRule(this);
	}

	get cssRules(): CSSRuleList {
		return this[kRuleList];
	}

	get length(): number {
		return this[kRules].length;
	}

	get cssText(): string {
		const frames = this[kRules].map((rule) => `\n  ${rule.cssText}`).join("");
		// An animation's name is a <custom-ident> or a <string>. The words a
		// <custom-ident> excludes (the CSS-wide keywords and `none`, which
		// animation-name uses for "no animation") are written as strings.
		const reserved = this[kName].toLowerCase();
		const name =
			CSS_WIDE_KEYWORDS.has(reserved) || reserved === "none"
				? serializeCSSString(this[kName])
				: serializeCSSIdentifier(this[kName]);
		return `@keyframes ${name} {${frames}\n}`;
	}

	appendRule(text: string): void {
		const rule = parseRuleText(
			`@keyframes k { ${text} }`,
			this.parentStyleSheet,
			this,
		);
		if (rule instanceof CSSKeyframesRule) {
			this[kRules].push(...Array.from(rule.cssRules));
			syncIndexed(this[kRuleList]);
			syncIndexed(this, this[kRules]);
			notifyRule(this);
		}
	}

	deleteRule(select: string): void {
		const key = serializeKeyText(String(select));
		for (let index = this[kRules].length - 1; index >= 0; index--) {
			if ((this[kRules][index] as CSSKeyframeRule).keyText !== key) {
				continue;
			}
			this[kRules].splice(index, 1);
			syncIndexed(this[kRuleList]);
			syncIndexed(this, this[kRules]);
			notifyRule(this);
			return;
		}
	}

	findRule(select: string): CSSKeyframeRule | null {
		const key = serializeKeyText(String(select));
		for (let index = this[kRules].length - 1; index >= 0; index--) {
			const rule = this[kRules][index] as CSSKeyframeRule;
			if (rule.keyText === key) {
				return rule;
			}
		}
		return null;
	}
}

/** The rules of a stylesheet or a grouping rule. */
class CSSRuleList {
	declare [kRules]: readonly CSSRule[];

	constructor(rules: readonly CSSRule[]) {
		this[kRules] = rules;
	}

	get length(): number {
		return this[kRules].length;
	}

	item(index: number): CSSRule | null {
		return this[kRules][index] ?? null;
	}

	[Symbol.iterator](): IterableIterator<CSSRule> {
		return this[kRules][Symbol.iterator]();
	}
}

function createRuleList(rules: readonly CSSRule[]): CSSRuleList {
	const list = new CSSRuleList(rules);
	syncIndexed(list);
	return list;
}

const kSheets = Symbol("sheets");

/** The stylesheets of a document or a shadow root. */
class StyleSheetList {
	declare [kSheets]: readonly CSSStyleSheet[];

	constructor(sheets: readonly CSSStyleSheet[]) {
		this[kSheets] = sheets;
	}

	get length(): number {
		return this[kSheets].length;
	}

	item(index: number): CSSStyleSheet | null {
		return this[kSheets][index] ?? null;
	}

	[Symbol.iterator](): IterableIterator<CSSStyleSheet> {
		return this[kSheets][Symbol.iterator]();
	}
}

const kOwnerNode = Symbol("ownerNode");
const kConstructed = Symbol("constructed");
const kTitle = Symbol("title");
const kDisabled = Symbol("disabled");
const kText = Symbol("text");
const kOwnerRule = Symbol("ownerRule");

/** Only a constructed sheet may be adopted, per spec. */
const constructedSheets = new WeakSet<CSSStyleSheet>();

// The rules belong to this object. The cascade reads them rather than
// re-parsing text, so every mutation path reaches the render through the
// same invalidation a `<style>` text change does.
class CSSStyleSheet {
	declare [kRules]: CSSRule[];
	declare [kRuleList]: CSSRuleList;
	declare [kMedia]: MediaList;
	declare [kOwnerNode]: Element | null;
	declare [kOwnerRule]: CSSRule | null;
	declare [kConstructed]: boolean;
	declare [kDisabled]: boolean;
	declare [kHref]: string | null;
	declare [kTitle]: string | null;

	// The owner node's text this sheet last parsed.
	declare [kText]: string | null;

	// A sheet with an owner element is one the document parsed:
	// replace(Sync) is refused on it, and its rules follow the element's
	// text. The exposed constructor takes options only, so authors can only
	// make the constructed kind.
	constructor(
		options: {media?: string; title?: string; disabled?: boolean} = {},
		ownerNode: Element | null = null,
	) {
		this[kRules] = [];
		this[kOwnerRule] = null;
		this[kText] = null;
		this[kOwnerNode] = ownerNode;
		this[kConstructed] = ownerNode === null;
		if (this[kConstructed]) {
			constructedSheets.add(this);
		}
		this[kHref] = ownerNode?.getAttribute("href") ?? null;
		this[kTitle] = ownerNode?.getAttribute("title") ?? options.title ?? null;
		this[kDisabled] = Boolean(options.disabled);
		this[kMedia] = new MediaList(
			ownerNode?.getAttribute("media") ?? options.media ?? "",
			() => sheetChanged(this),
		);
		this[kRuleList] = createRuleList(this[kRules]);
	}

	get cssRules(): CSSRuleList {
		this[kSync]!();
		return this[kRuleList];
	}

	// The legacy alias every engine still supports.
	get rules(): CSSRuleList {
		return this.cssRules;
	}

	get type(): string {
		return "text/css";
	}

	get href(): string | null {
		return this[kHref];
	}

	get title(): string | null {
		return this[kTitle];
	}

	get ownerNode(): Element | null {
		return this[kOwnerNode];
	}

	get ownerRule(): CSSRule | null {
		return this[kOwnerRule];
	}

	get parentStyleSheet(): CSSStyleSheet | null {
		return this[kOwnerRule]?.parentStyleSheet ?? null;
	}

	get media(): MediaList {
		return this[kMedia];
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this[kMedia].mediaText = String(text);
	}

	get disabled(): boolean {
		return this[kDisabled];
	}

	set disabled(disabled: boolean) {
		const value = Boolean(disabled);
		if (value === this[kDisabled]) {
			return;
		}
		this[kDisabled] = value;
		sheetChanged(this);
	}

	insertRule(text: string, index = 0): number {
		if (arguments.length === 0) {
			throw typeError("insertRule requires a rule", this);
		}
		this[kSync]!();
		if (index > this[kRules].length) {
			throw domException(
				`Cannot insert at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		const inserted = parseRuleText(text, this, null);
		// A constructed sheet cannot import another. `@import` is not a rule it
		// accepts.
		if (inserted instanceof CSSImportRule && this[kConstructed]) {
			throw domException(
				"A constructed stylesheet holds no @import rule",
				"SyntaxError",
				this,
			);
		}
		checkRuleOrder(this, inserted, index);
		this[kRules].splice(index, 0, inserted);
		syncIndexed(this[kRuleList]);
		sheetChanged(this);
		return index;
	}

	deleteRule(index: number): void {
		if (arguments.length === 0) {
			throw typeError("deleteRule requires an index", this);
		}
		this[kSync]!();
		if (index >= this[kRules].length) {
			throw domException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		const removed = this[kRules][index];
		// Removing a namespace declaration would change the meaning of
		// selectors already parsed against it, so a sheet holding any other
		// rule keeps it.
		if (
			removed instanceof CSSNamespaceRule &&
			this[kRules].some(
				(other) =>
					!(
						other instanceof CSSImportRule || other instanceof CSSNamespaceRule
					),
			)
		) {
			throw domException(
				"A @namespace rule cannot be removed from a sheet that holds other rules",
				"InvalidStateError",
				this,
			);
		}
		detachRule(removed);
		this[kRules].splice(index, 1);
		syncIndexed(this[kRuleList]);
		sheetChanged(this);
	}

	// The legacy IE spellings, defined in terms of the modern pair.
	addRule(selector = "undefined", block = "", index?: number): number {
		this.insertRule(`${selector} { ${block} }`, index ?? this.cssRules.length);
		return -1;
	}

	removeRule(index = 0): void {
		this[kSync]!();
		if (index >= this.cssRules.length) {
			throw domException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		this.deleteRule(index);
	}

	replaceSync(text: string): void {
		if (!this[kConstructed]) {
			throw domException(
				"replaceSync is only allowed on a constructed stylesheet",
				"NotAllowedError",
				this,
			);
		}
		// An adopted sheet cannot import another. `@import` is dropped rather
		// than parsed, per the constructable-stylesheet rules.
		this[kRules].length = 0;
		this[kRules].push(
			...parseRules(String(text ?? ""), this, null).filter(
				(rule) => !(rule instanceof CSSImportRule),
			),
		);
		syncIndexed(this[kRuleList]);
		sheetChanged(this);
	}

	replace(text: string): Promise<CSSStyleSheet> {
		try {
			this.replaceSync(text);
		} catch (error) {
			return Promise.reject(error);
		}
		return Promise.resolve(this);
	}

	// Reparse the owner element's text if it changed.
	[kSync]?(): void {
		const node = this[kOwnerNode];
		if (!node || node.tagName !== "STYLE") {
			return;
		}
		const text = node.textContent ?? "";
		if (text === this[kText]) {
			return;
		}
		this[kText] = text;
		this[kRules].length = 0;
		this[kRules].push(...parseRules(text, this, null));
		syncIndexed(this[kRuleList]);
	}
}

// `@import` must precede every rule except another `@import`, and
// `@namespace` every rule except those two. A `@namespace` also needs a
// sheet holding nothing else, because a selector parsed before the
// declaration cannot use it.
function checkRuleOrder(
	sheet: CSSStyleSheet,
	rule: CSSRule,
	index: number,
): void {
	const hierarchy = (): never => {
		throw domException(
			"That rule cannot stand at that index",
			"HierarchyRequestError",
			sheet,
		);
	};
	const prelude = (other: CSSRule): boolean =>
		other instanceof CSSImportRule || other instanceof CSSNamespaceRule;
	const before = sheet[kRules].slice(0, index);
	const after = sheet[kRules].slice(index);
	if (rule instanceof CSSImportRule) {
		if (before.some((other) => !(other instanceof CSSImportRule))) {
			hierarchy();
		}
		return;
	}
	if (rule instanceof CSSNamespaceRule) {
		if (before.some((other) => !prelude(other))) {
			hierarchy();
		}
		if (after.some((other) => other instanceof CSSImportRule)) {
			hierarchy();
		}
		if (sheet[kRules].some((other) => !prelude(other))) {
			throw domException(
				"A @namespace rule needs a sheet of nothing but @import and @namespace rules",
				"InvalidStateError",
				sheet,
			);
		}
		return;
	}
	if (after.some(prelude)) {
		hierarchy();
	}
}

function serializeQualifiedName(
	name: string,
	namespaces: SelectorNamespaces,
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
	if (prefix === "*") {
		return namespaces.default === null ? localText : `*|${localText}`;
	}
	if (prefix === "") {
		// `|E` means "no namespace", which a bare `E` never means, whether or
		// not a default namespace was declared, so the bar stays. An attribute
		// is the exception: an unprefixed attribute is already in no namespace,
		// so `[|attr]` and `[attr]` are the same selector.
		return namespaces === ATTRIBUTE_NAMESPACES ? localText : `|${localText}`;
	}
	const decoded = CSSTree.ident.decode(prefix);
	if (
		namespaces.default !== null &&
		namespaces.prefixes.get(decoded) === namespaces.default
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

function getListSpecificity(list: SelectorNode): Specificity {
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

function getSelectorSpecificity(selector: SelectorNode): Specificity {
	const total: Specificity = [0, 0, 0];
	const add = (weight: Specificity): void => {
		total[0] += weight[0];
		total[1] += weight[1];
		total[2] += weight[2];
	};
	const argumentWeight = (node: SelectorNode): Specificity => {
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
				if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
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

// A change to a key a compound names can change whether the compound
// matches.
interface CompoundKeys {
	classes: string[];
	ids: string[];
	attributes: string[];
	states: boolean;
}

// The subject is the last compound.
interface SelectorReading {
	specificity: string;
	subjectTag: string | undefined;
	compounds: CompoundKeys[];
}

// Includes pseudo-class arguments. A class inside :not() or :is() is
// tested on the compound around it.
function harvestKeys(nodes: SelectorNode[], keys: CompoundKeys): void {
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
function readSelector(selector: string): SelectorReading {
	let failed = false;
	let list: SelectorNode | null = null;
	try {
		list = CSSTree.parse(selector, {
			context: "selectorList",
			onParseError() {
				failed = true;
			},
		}) as unknown as SelectorNode;
	} catch (_err) {
		failed = true;
	}
	if (failed || !list || list.type !== "SelectorList") {
		return {specificity: "000-000-000", subjectTag: undefined, compounds: []};
	}
	const weight = getListSpecificity(list);
	const specificity = weight
		.map((count) => String(count).padStart(3, "0"))
		.join("-");
	const complex = getChildren(list).find((child) => child.type === "Selector");
	const compounds: CompoundKeys[] = [];
	let parts: SelectorNode[] = [];
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
	return {specificity, subjectTag: getSubjectTag(complex), compounds};
}

// Undefined when the subject names no type, including a type in a
// namespace, which the matcher resolves against the namespaces the sheet
// bound.
function getSubjectTag(complex: SelectorNode | undefined): string | undefined {
	if (!complex) {
		return undefined;
	}
	let type: SelectorNode | undefined;
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

// An unprefixed attribute is always in no namespace, whatever the
// default.
const ATTRIBUTE_NAMESPACES: SelectorNamespaces = {
	default: "",
	prefixes: new Map(),
};

function serializeIdentifierSource(name: string): string {
	return serializeCSSIdentifier(CSSTree.ident.decode(name));
}

function serializeSelectorList(
	list: SelectorNode,
	namespaces: SelectorNamespaces = NO_NAMESPACES,
): string {
	return getChildren(list)
		.map((selector) => serializeSelector(selector, namespaces))
		.join(", ");
}

function serializeSelector(
	selector: SelectorNode,
	namespaces: SelectorNamespaces = NO_NAMESPACES,
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
	node: SelectorNode,
	namespaces: SelectorNamespaces,
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
			let out = `[${serializeQualifiedName(name.name, ATTRIBUTE_NAMESPACES)}`;
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
				node.type === "PseudoElementSelector" ||
				LEGACY_PSEUDO_ELEMENTS.has(decoded);
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
	node: SelectorNode,
	namespaces: SelectorNamespaces,
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
function parsePseudoElementArgument(text: string): string | null {
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
	if (!double && !LEGACY_PSEUDO_ELEMENTS.has(pseudoName(name))) {
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
		compound.length !== 2 ||
		!pseudo ||
		pseudo.type !== "PseudoElementSelector"
	) {
		return null;
	}
	return serializeSimpleSelector(pseudo, NO_NAMESPACES);
}

function splitSelectorList(text: string): string[] {
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

interface ParsedSpan {
	start: {offset: number};
	end: {offset: number};
}

interface ParsedNode {
	type: string;
	name?: string;
	prelude?: {type: string; value?: string} | null;
	block?: {children: {toArray(): ParsedNode[]}} | null;
	property?: string;
	value?: {
		type: string;
		value?: string;
		loc?: ParsedSpan | null;
		children?: {toArray(): CSSNode[]} | null;
	} | null;
	important?: boolean | string;
	children?: {toArray(): ParsedNode[]} | null;
}

function getNodes(container: {
	children?: {toArray(): ParsedNode[]} | null;
}): ParsedNode[] {
	return container.children ? container.children.toArray() : [];
}

// Value nodes from the sheet parse are kept when the canonical spelling
// is the authored one. The value TEXT always serializes from the source,
// which the parsed spelling cannot replace.
function getBlockDeclarations(
	node: ParsedNode,
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
			seedValueNodes(value, getNodes(child.value as never) as CSSNode[]);
		}
		declarations.push({
			name,
			value,
			important: child.important === true,
		});
	}
	return declarations;
}

function parseRules(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule[] {
	let ast: {children: {toArray(): ParsedNode[]}};
	try {
		// Values parse to nodes in this one pass. A value outside its grammar
		// falls back to a Raw node rather than an error, so the sheet keeps
		// what a raw-text parse would keep. Positions are on because the value
		// TEXT serializes from the authored source, not from the parsed
		// spelling.
		ast = CSSTree.parse(text, {
			parseValue: true,
			parseAtrulePrelude: false,
			parseRulePrelude: false,
			parseCustomProperty: false,
			positions: true,
		}) as never;
	} catch (_err) {
		return [];
	}
	return convertRules(ast.children.toArray(), text, sheet, parentRule);
}

function parseRuleText(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule {
	const source = String(text ?? "");
	let ast: {children: {toArray(): ParsedNode[]}};
	try {
		ast = CSSTree.parse(source, {
			parseValue: false,
			parseAtrulePrelude: false,
			parseRulePrelude: false,
			parseCustomProperty: false,
			onParseError(error: Error) {
				throw error;
			},
		}) as never;
	} catch (_err) {
		throw domException(`Cannot parse rule: ${source}`, "SyntaxError", sheet);
	}
	const nodes = ast.children.toArray();
	if (nodes.length !== 1) {
		throw domException(`Cannot parse rule: ${source}`, "SyntaxError", sheet);
	}
	const rule = convertRule(
		nodes[0],
		source,
		sheet,
		parentRule,
		getSheetNamespaces(sheet),
	);
	if (!rule) {
		throw domException(`Cannot parse rule: ${source}`, "SyntaxError", sheet);
	}
	return rule;
}

// An @namespace applies only to the rules that follow it, so the
// namespace map is built during the walk rather than read from a sheet
// still being built.
function convertRules(
	nodes: readonly ParsedNode[],
	source: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
	namespaces: SelectorNamespaces = {default: null, prefixes: new Map()},
): CSSRule[] {
	const rules: CSSRule[] = [];
	for (const node of nodes) {
		const rule = convertRule(node, source, sheet, parentRule, namespaces);
		if (!rule) {
			continue;
		}
		if (rule instanceof CSSNamespaceRule) {
			if (rule.prefix === "") {
				namespaces.default = rule.namespaceURI;
			} else {
				namespaces.prefixes.set(
					CSSTree.ident.decode(rule.prefix),
					rule.namespaceURI,
				);
			}
		}
		rules.push(rule);
	}
	return rules;
}

function getPreludeText(node: ParsedNode): string {
	return (node.prelude?.value ?? "").trim();
}

function convertRule(
	node: ParsedNode,
	source: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
	namespaces: SelectorNamespaces = NO_NAMESPACES,
): CSSRule | null {
	if (node.type === "Rule") {
		const prelude = getPreludeText(node);
		const selectors = parseSelectorList(prelude);
		if (!selectors) {
			return null;
		}
		// A prefix no @namespace declared names no namespace, and a selector
		// using one does not parse.
		if (
			prelude.includes("|") &&
			!namespacePrefixesDeclared(prelude, namespaces)
		) {
			return null;
		}
		return new CSSStyleRule(
			selectors,
			getBlockDeclarations(node, source),
			sheet,
			parentRule,
			(rule) =>
				convertRules(getNestedRules(node), source, sheet, rule, namespaces),
		);
	}
	if (node.type !== "Atrule") {
		return null;
	}
	const prelude = getPreludeText(node);
	switch ((node.name ?? "").toLowerCase()) {
		// A charset rule is not exposed in a sheet's rule list, per CSSOM.
		case "charset":
			return null;
		case "container":
			return new CSSContainerRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "counter-style":
			return new CSSCounterStyleRule(
				prelude,
				getBlockDeclarations(node, source),
				sheet,
			);
		case "font-face":
			return new CSSFontFaceRule(
				getBlockDeclarations(node, source),
				sheet,
				parentRule,
			);
		case "font-feature-values":
			return new CSSFontFeatureValuesRule(prelude, node, source, sheet);
		case "font-palette-values":
			return new CSSFontPaletteValuesRule(
				prelude,
				getBlockDeclarations(node, source),
				sheet,
			);
		case "import":
			return convertImportRule(prelude, sheet);
		case "keyframes":
		case "-webkit-keyframes":
			return new CSSKeyframesRule(prelude, sheet, (rule) =>
				getNodes(node.block ?? {})
					.filter((frame) => frame.type === "Rule")
					.map(
						(frame) =>
							new CSSKeyframeRule(
								getPreludeText(frame),
								getBlockDeclarations(frame, source),
								sheet,
								rule,
							),
					),
			);
		case "layer": {
			const names = getLayerNames(prelude);
			if (!names) {
				return null;
			}
			if (!node.block) {
				// `@layer;` orders nothing and names nothing to order.
				return names.length === 0
					? null
					: new CSSLayerStatementRule(names, sheet, parentRule);
			}
			// A block opens one layer. A list of names is only valid in the
			// statement form.
			if (names.length > 1) {
				return null;
			}
			return new CSSLayerBlockRule(
				names[0] ?? "",
				sheet,
				parentRule,
				(group) =>
					convertRules(
						getNodes(node.block ?? {}),
						source,
						sheet,
						group,
						namespaces,
					),
			);
		}
		case "media":
			return new CSSMediaRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "namespace":
			return convertNamespaceRule(prelude, sheet);
		case "page":
			return new CSSPageRule(
				prelude,
				getBlockDeclarations(node, source),
				sheet,
				parentRule,
			);
		case "property":
			return new CSSPropertyRule(
				prelude,
				getBlockDeclarations(node, source),
				sheet,
			);
		case "scope":
			return new CSSScopeRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "starting-style":
			return new CSSStartingStyleRule(sheet, parentRule, (group) =>
				convertRules(
					getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "supports":
			return new CSSSupportsRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		default:
			return null;
	}
}

function getNestedRules(node: ParsedNode): ParsedNode[] {
	return getNodes(node.block ?? {}).filter(
		(child) => child.type === "Rule" || child.type === "Atrule",
	);
}

interface NamespacePreludeNode {
	type: string;
	name?: string;
	value?: string;
}

// A prefix keeps its authored spelling, which is what it serializes
// back as and what a selector's prefix is decoded against. Null drops
// the at-rule.
function convertNamespaceRule(
	prelude: string,
	sheet: CSSStyleSheet | null,
): CSSNamespaceRule | null {
	let nodes: NamespacePreludeNode[];
	try {
		const ast = CSSTree.parse(prelude, {
			context: "atrulePrelude",
			atrule: "namespace",
		}) as unknown as {
			children?: {toArray(): NamespacePreludeNode[]} | null;
		};
		nodes = ast.children ? ast.children.toArray() : [];
	} catch (_err) {
		return null;
	}
	let index = 0;
	let prefix = "";
	if (nodes[index]?.type === "Identifier") {
		prefix = nodes[index].name ?? "";
		index++;
	}
	const uri = nodes[index];
	if (
		nodes.length !== index + 1 ||
		(uri.type !== "Url" && uri.type !== "String")
	) {
		return null;
	}
	return new CSSNamespaceRule(prefix, uri.value ?? "", sheet);
}

interface LayerPreludeNode {
	type: string;
	name?: string;
	children?: {toArray(): LayerPreludeNode[]} | null;
}

// The empty list for the anonymous block. Null for a prelude outside
// the grammar, which drops the at-rule.
function getLayerNames(prelude: string): string[] | null {
	let nodes: LayerPreludeNode[];
	try {
		const ast = CSSTree.parse(prelude, {
			context: "atrulePrelude",
			atrule: "layer",
		}) as unknown as {children?: {toArray(): LayerPreludeNode[]} | null};
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

interface ImportPreludeNode {
	type: string;
	name?: string;
	value?: string;
	loc?: ParsedSpan | null;
	children?: {toArray(): ImportPreludeNode[]} | null;
}

// The supports condition and the media list keep their authored text,
// sliced at their nodes' positions. Null for a prelude outside the
// grammar.
function convertImportRule(
	prelude: string,
	sheet: CSSStyleSheet | null,
): CSSImportRule | null {
	const text = prelude.trim();
	let nodes: ImportPreludeNode[];
	try {
		const ast = CSSTree.parse(text, {
			context: "atrulePrelude",
			atrule: "import",
			positions: true,
		}) as unknown as {children?: {toArray(): ImportPreludeNode[]} | null};
		nodes = ast.children ? ast.children.toArray() : [];
	} catch (_err) {
		return null;
	}
	const sliceOf = (node: ImportPreludeNode): string =>
		node.loc ? text.slice(node.loc.start.offset, node.loc.end.offset) : "";
	const head = nodes[0];
	if (!head || (head.type !== "Url" && head.type !== "String")) {
		return null;
	}
	const href = head.value ?? "";
	let index = 1;

	let layerName: string | null = null;
	let node: ImportPreludeNode | undefined = nodes[index];
	if (
		node &&
		(node.type === "Identifier" || node.type === "Function") &&
		(node.name ?? "").toLowerCase() === "layer"
	) {
		const layer = (node.children?.toArray() ?? []).find(
			(child) => child.type === "Layer",
		);
		if (node.type === "Function" && !layer) {
			// `layer()` takes a layer name and nothing else, so a name outside
			// the grammar invalidates the prelude. The bare word `layer` means
			// the anonymous layer.
			return null;
		}
		layerName = layer?.name ?? "";
		index++;
	}

	let supportsText: string | null = null;
	node = nodes[index];
	if (
		node?.loc &&
		node.type === "Function" &&
		(node.name ?? "").toLowerCase() === "supports"
	) {
		// The slice spans the function: its name, its parentheses and the
		// condition between them. A function whose parenthesis never closes is
		// recovered ending at the text, with no `)` to leave off.
		const spelled = sliceOf(node);
		const opened = (node.name ?? "").length + 1;
		supportsText = (
			spelled.endsWith(")")
				? spelled.slice(opened, -1)
				: spelled.slice(opened)
		).trim();
		index++;
	}

	let mediaText = "";
	node = nodes[index];
	if (node) {
		if (node.type !== "MediaQueryList") {
			return null;
		}
		mediaText = sliceOf(node);
		index++;
	}
	if (index !== nodes.length) {
		return null;
	}
	return new CSSImportRule(href, mediaText, layerName, supportsText, sheet);
}

// Assigning a rule's text does nothing, as in every engine, but the
// attribute exists, so every rule type gets the setter alongside the
// serialization its own class defines.
for (const type of [
	CSSStyleRule,
	CSSMediaRule,
	CSSSupportsRule,
	CSSContainerRule,
	CSSScopeRule,
	CSSStartingStyleRule,
	CSSLayerBlockRule,
	CSSLayerStatementRule,
	CSSNamespaceRule,
	CSSImportRule,
	CSSFontFaceRule,
	CSSPageRule,
	CSSCounterStyleRule,
	CSSPropertyRule,
	CSSFontPaletteValuesRule,
	CSSKeyframeRule,
	CSSFontFeatureValuesRule,
	CSSKeyframesRule,
]) {
	// The getter may live on a base class, so the chain is walked to find
	// it.
	let prototype: object | null = type.prototype;
	let descriptor: PropertyDescriptor | undefined;
	while (prototype && !descriptor) {
		descriptor = Object.getOwnPropertyDescriptor(prototype, "cssText");
		prototype = Object.getPrototypeOf(prototype);
	}
	if (!descriptor?.get) {
		continue;
	}
	Object.defineProperty(type.prototype, "cssText", {
		...descriptor,
		set() {},
	});
}

const elementSheets = new WeakMap<Element, CSSStyleSheet>();

const adoptedSheets = new WeakMap<Node, CSSStyleSheet[]>();

// A bare fragment is a document fragment too and hosts nothing, which
// is what separates it from a tree some element composes.
function isShadowRoot(root: Node): root is ShadowRoot {
	return root.nodeType === 11 && (root as ShadowRoot).host !== undefined;
}

const kSyncShadowRoot = Symbol("syncShadowRoot");

function getSheet(element: Element): CSSStyleSheet {
	let sheet = elementSheets.get(element);
	if (!sheet) {
		sheet = new CSSStyleSheet({}, element);
		sheetNotifiers.set(sheet, () => {
			const cascade = getTreeCascade(element);
			if (!cascade) {
				return;
			}
			// A shadow sheet's change syncs its root. Only a document
			// sheet's change rebuilds the document cascade.
			const root = element.getRootNode();
			if (isShadowRoot(root)) {
				cascade[kSyncShadowRoot](root);
			} else {
				cascade.syncStylesheets();
			}
		});
		elementSheets.set(element, sheet);
	}
	return sheet;
}

// What `styleSheets` lists. An adopted sheet belongs to no element and
// is not included.
function getDeclaredStyleSheets(root: Document | ShadowRoot): CSSStyleSheet[] {
	return Array.from(root.querySelectorAll("style"), getSheet);
}

// A `<link>` never resolves to a sheet, because there is no network
// behind a terminal document.
function getDocumentStyleSheets(document: Document): CSSStyleSheet[] {
	return [
		...getDeclaredStyleSheets(document),
		...(adoptedSheets.get(document) ?? []),
	];
}

function getShadowStyleSheets(root: ShadowRoot): CSSStyleSheet[] {
	return [...getDeclaredStyleSheets(root), ...(adoptedSheets.get(root) ?? [])];
}

function getTreeCascade(tree: Node): Cascade | undefined {
	const document =
		tree.nodeType === tree.DOCUMENT_NODE
			? (tree as Document)
			: tree.ownerDocument;
	return document ? documentCascades.get(document) : undefined;
}

function checkAdoptable(tree: Node, sheet: unknown): CSSStyleSheet {
	if (!(sheet instanceof CSSStyleSheet)) {
		throw typeError("adoptedStyleSheets takes CSSStyleSheet objects");
	}
	if (!constructedSheets.has(sheet)) {
		throw domException(
			"Can't adopt a stylesheet that was not constructed",
			"NotAllowedError",
			sheet,
		);
	}
	sheetNotifiers.set(sheet, () => getTreeCascade(tree)?.syncStylesheets());
	return sheet;
}

// A constructed sheet has no consumer until something adopts it.
function adopt(target: Node, sheets: unknown): void {
	const adopted = Array.from(sheets as Iterable<unknown>).map((sheet) =>
		checkAdoptable(target, sheet),
	);
	// One array per tree, replaced in place, so the observable array an
	// author already holds is the same object after a whole reassignment.
	let list = adoptedSheets.get(target);
	if (!list) {
		adoptedSheets.set(target, (list = []));
	}
	list.length = 0;
	for (const [index, sheet] of adopted.entries()) {
		defineIndex(list, index, sheet);
	}
}

// A plain assignment consults the prototype chain, so an accessor
// installed at Array.prototype[1] would run with the backing list as its
// receiver, handing an author the list and swallowing the write.
// Defining the property writes with no chain lookup.
function defineIndex(
	list: CSSStyleSheet[],
	index: number | string,
	sheet: unknown,
): boolean {
	return Reflect.defineProperty(list, index, {
		value: sheet,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

const adoptedProxies = new WeakMap<Node, CSSStyleSheet[]>();

// The list an author holds is the list the cascade reads. push, splice
// and an indexed write all take effect the same as a whole reassignment.
function observableAdopted(
	target: Node,
	list: CSSStyleSheet[],
): CSSStyleSheet[] {
	let proxy = adoptedProxies.get(target);
	if (proxy) {
		return proxy;
	}
	const changed = (): void => {
		getTreeCascade(target)?.syncStylesheets();
	};
	// Assignment to arbitrary indices of adoptedStyleSheets must be
	// observed.
	// eslint-disable-next-line no-restricted-globals
	proxy = new Proxy(list, {
		set(array, property, value) {
			if (typeof property === "string" && /^\d+$/.test(property)) {
				checkAdoptable(target, value);
				const defined = defineIndex(array, property, value);
				if (defined) {
					changed();
				}
				return defined;
			}
			const ok = Reflect.set(array, property, value);
			if (ok) {
				changed();
			}
			return ok;
		},
		deleteProperty(array, property) {
			// No notification here. An array method that deletes an index
			// (`pop`, `shift`) writes the new length right after, and the
			// cascade must not read the list between the two.
			return Reflect.deleteProperty(array, property);
		},
	});
	adoptedProxies.set(target, proxy);
	return proxy;
}

// Every CSSOM interface names itself, as any platform object does.
for (const [name, type] of Object.entries({
	CSSStyleSheet,
	StyleSheetList,
	CSSRuleList,
	CSSRule,
	CSSStyleRule,
	CSSGroupingRule,
	CSSConditionRule,
	CSSMediaRule,
	CSSSupportsRule,
	CSSContainerRule,
	CSSImportRule,
	CSSNamespaceRule,
	CSSKeyframesRule,
	CSSKeyframeRule,
	CSSFontFaceRule,
	CSSPageRule,
	CSSCounterStyleRule,
	CSSPropertyRule,
	CSSFontPaletteValuesRule,
	CSSFontFeatureValuesRule,
	CSSLayerBlockRule,
	CSSLayerStatementRule,
	CSSScopeRule,
	CSSStartingStyleRule,
	MediaList,
	CSSStyleDeclaration,
	CSSStyleProperties,
})) {
	Object.defineProperty(
		(type as {prototype: object}).prototype,
		Symbol.toStringTag,
		{value: name, configurable: true},
	);
}

// Parsed once. Its rules never change.
let uaDocumentSheet: CSSStyleSheet | null = null;

function getUAStyleSheet(): CSSStyleSheet {
	if (!uaDocumentSheet) {
		uaDocumentSheet = new CSSStyleSheet();
		uaDocumentSheet.replaceSync(UA_ELEMENT_STYLES + UA_DOCUMENT_STYLES);
	}
	return uaDocumentSheet;
}

// The properties whose resolved value is the used value, per CSSOM.
// Everything else resolves to its computed value.
const USED_VALUE_PROPERTIES = new Set([
	"border-bottom-width",
	"border-left-width",
	"border-right-width",
	"border-top-width",
	"bottom",
	"height",
	"left",
	"margin-bottom",
	"margin-left",
	"margin-right",
	"margin-top",
	"padding-bottom",
	"padding-left",
	"padding-right",
	"padding-top",
	"right",
	"top",
	"width",
]);

// A used length in the one unit a terminal has: a cell, spelled `px`.
function getUsedLength(cells: number): string {
	return `${Math.round(cells * 1000) / 1000}px`;
}

const kCascade = Symbol("cascade");

// A pseudo-element's declaration resolves through a view whose
// [kElement] is the pseudo-element's own node, so there is one copy of
// the measurement arithmetic.
interface MeasuredDeclaration {
	[kElement]: Element;
	[kCascade]: Cascade | null;
	getComputedValue(property: string): string;
	getPropertyValue(property: string): string;
}

// `auto` on these means the element's own color, and the resolved value
// CSSOM reports is that used color.
const AUTO_COLOR_PROPERTIES = new Set(["caret-color", "outline-color"]);

// `auto` here means a minimum only some boxes have.
const MIN_SIZE_PROPERTIES = new Set(["min-width", "min-height"]);

// Resolve to the USED track sizes, not the sizing functions the author
// wrote (css-grid-2 §7.2).
const USED_TRACK_PROPERTIES = new Set([
	"grid-template-columns",
	"grid-template-rows",
]);

// The pseudo-elements this engine gives a node of their own.
const PSEUDO_ELEMENT_NAMES = ["::before", "::after", "::marker"];

const ITEM_DISPLAYS = new Set(["flex", "grid", "inline-flex", "inline-grid"]);

const BLOCKIFIED_DISPLAYS: Record<string, string> = {
	inline: "block",
	"inline-block": "block",
	"inline-flex": "flex",
	"inline-grid": "grid",
	"inline-table": "table",
};

const INSET_PROPERTIES = new Set(["top", "right", "bottom", "left"]);

const OPPOSITE_INSET: Record<string, string> = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left",
};

// Null for `auto`, which is not a length but an instruction to
// measure.
function getInsetLength(computed: string, basis: number): number | null {
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

/**
 * The COMPUTED value: what the cascade says before any box exists. This
 * is not what getComputedStyle returns (getResolvedStyle is that). A used
 * value here would feed layout its own output, and this is called
 * thousands of times a frame, so it must never take a branch that needs
 * layout. Asked about a pseudo-element by name, it returns the bare
 * declarations (empty means no rule reached it). Asked about a
 * pseudo-element's NODE, it returns declarations completed with initial
 * values, so a box has a `display` to lay out from.
 */
export function getComputedValue(
	element: Element,
	property: string,
	pseudoElement = "",
): string {
	// A pseudo-element node's style is its host's declaration for the
	// pseudo-element it fills. It matches no selector of its own.
	const host = getPseudoHost(element);
	if (host !== null) {
		const name = getPseudoName(element) as string;
		const cascade = host.ownerDocument
			? documentCascades.get(host.ownerDocument)
			: undefined;
		return cascade
			? getPseudoDeclaration(cascade, host, name).nodeValue(property)
			: getComputedValue(host, property, name);
	}
	const document = element.ownerDocument;
	if (!document) {
		return "";
	}
	const cascade = documentCascades.get(document);
	if (!cascade) {
		return "";
	}
	const declaration = pseudoElement
		? getPseudoDeclaration(cascade, element, pseudoElement)
		: cascade.declarationFor(element);
	return declaration.getComputedValue(property);
}

// Only declarations handed to an author materialize an item list. The
// engine's own computed styles never do.
function getIndexedDeclaration<
	T extends CSSStyleDeclaration,
>(declaration: T): T {
	syncIndexed(declaration);
	return declaration;
}

const kCSSRules = Symbol("cssRules");
const kSyncResolved = Symbol("syncResolved");
const kResolved = Symbol("resolved");
const kCustom = Symbol("custom");
const kInlineBlock = Symbol("inlineBlock");
const kUsedValue = Symbol("usedValue");
const kBaseValue = Symbol("baseValue");
const kActiveTransitions = Symbol("activeTransitions");
const kCurrentDeclarations = Symbol("currentDeclarations");
const kUsedGridTracks = Symbol("usedGridTracks");
const kFlushStyle = Symbol("flushStyle");
const kMatchingRules = Symbol("matchingRules");

// LIVE: the object an author holds stays valid across class changes and
// sheet replacements, because it re-resolves rather than being replaced.
class ComputedStyleDeclaration extends CSSStyleProperties {
	declare [kElement]: Element;
	declare [kCSSRules]: ParsedCSSRule[];

	declare [kCascade]: Cascade | null;
	declare [kInlineBlock]: DeclarationBlock | null;

	// Computed strings, memoized once per property per resolution, ""
	// results included. An inherited property re-resolved on every read
	// would re-walk the whole ancestor chain, thousands of times per
	// keystroke. The declaration is discarded wholesale on invalidation, so
	// the memo needs no invalidation of its own.
	declare [kResolved]: Map<string, string>;

	declare [kCustom]: string[] | null;

	constructor(
		element: Element,
		cssRules: ParsedCSSRule[] = [],
		cascade?: Cascade,
	) {
		super();
		this[kCascade] = null;
		this[kResolved] = new Map<string, string>();
		this[kCustom] = null;
		this[kElement] = element;
		this[kCSSRules] = cssRules;
		this[kInlineBlock] = null;
		if (cascade) {
			this[kCascade] = cascade;
			cascade[kCurrentDeclarations].add(this);
		}
	}

	override get length(): number {
		return CSS_LONGHANDS.length + getCustomNames(this).length;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement]);
	}

	override get parentRule(): CSSRule | null {
		return null;
	}

	getComputedValue(property: string): string {
		const current = this[kCascade]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kSyncResolved]();
		}
		const value = this[kBaseValue](property);
		const cascade = this[kCascade];
		if (cascade !== null && cascade[kActiveTransitions].size > 0) {
			const transitional = getTransitionValue(
				cascade,
				this[kElement],
				"",
				property,
			);
			if (transitional !== null) {
				return transitional;
			}
		}
		return value;
	}

	// Fully lazy. Most elements are only ever asked a handful of
	// properties. The composition walker asks each element only `display`.
	override getPropertyValue(property: string): string {
		// The author's read describes the DOM as it currently is. The engine
		// reads through getComputedValue, which does not flush, because style
		// is resolved from inside layout, which a flush would re-enter.
		this[kCascade]?.[kFlushStyle]();
		const current = this[kCascade]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kSyncResolved]();
		}
		// A flow-relative longhand resolves as the physical longhand it maps
		// to: same slot, same measurement, same result.
		property = toPhysicalProperty(this, property);
		if (this[kCascade] && USED_VALUE_PROPERTIES.has(property)) {
			return this[kUsedValue](property);
		}
		if (this[kCascade] && MIN_SIZE_PROPERTIES.has(property)) {
			return getResolvedMinSize(this, this.getComputedValue(property));
		}
		if (this[kCascade] && USED_TRACK_PROPERTIES.has(property)) {
			const tracks = this[kCascade][kUsedGridTracks](
				this[kElement],
				property === "grid-template-rows",
			);
			if (tracks) {
				return tracks.length > 0 ? tracks.map(getUsedLength).join(" ") : "none";
			}
		}
		if (AUTO_COLOR_PROPERTIES.has(property)) {
			const computed = this.getComputedValue(property);
			return computed === "auto" ? this.getPropertyValue("color") : computed;
		}
		const longhands = SHORTHAND_LONGHANDS.get(property);
		if (longhands) {
			return resolveShorthand(property, longhands, (longhand) =>
				this.getPropertyValue(longhand),
			);
		}
		return this.getComputedValue(property);
	}

	override setProperty(): void {
		throw readOnlyDeclaration(this[kElement]);
	}

	override removeProperty(): string {
		throw readOnlyDeclaration(this[kElement]);
	}

	override getPropertyPriority(): string {
		return "";
	}

	// Every supported longhand in the property index's order, then the
	// custom properties in effect, which have no place in that index.
	override item(index: number): string {
		return (
			CSS_LONGHANDS[index] ??
			getCustomNames(this)[index - CSS_LONGHANDS.length] ??
			""
		);
	}

	override [Symbol.iterator](): IterableIterator<string> {
		return [...CSS_LONGHANDS, ...getCustomNames(this)][Symbol.iterator]();
	}

	declaredCustomProperties(): string[] {
		const names: string[] = [];
		for (const rule of this[kCSSRules]) {
			for (const name of Object.keys(rule.declarations)) {
				if (name.startsWith("--") && !names.includes(name)) {
					names.push(name);
				}
			}
		}
		for (const name of Object.keys(getInlineDeclarations(this).declarations)) {
			if (name.startsWith("--") && !names.includes(name)) {
				names.push(name);
			}
		}
		return names;
	}

	// Measured through the same flush a geometry read takes, and memoized
	// behind it, so a property-heavy caller measures once per layout. The
	// memo belongs to the cascade, which lets a flush drop every one.
	[kUsedValue](property: string): string {
		const cascade = this[kCascade]!;
		const used = getUsedValues(cascade, this);
		const memoized = used.get(property);
		if (memoized !== undefined) {
			return memoized;
		}

		const computed = this.getComputedValue(property);
		const value = measureUsedValue(this, property, computed);
		used.set(property, value);
		return value;
	}

	// The cascade's value before a running transition overrides it, meaning
	// the after-change style. An interpolated value moves every frame and
	// must never enter the memo.
	[kBaseValue](property: string): string {
		let value = this[kResolved].get(property);
		if (value === undefined) {
			const longhands = SHORTHAND_LONGHANDS.get(property);
			value = longhands
				? resolveShorthand(property, longhands, (longhand) =>
					this[kBaseValue](longhand),
				)
				: getAbsolutizedValue(this, toPhysicalProperty(this, property));
			this[kResolved].set(property, value);
		}
		return value;
	}

	// Reads call this only when the cascade no longer vouches for this
	// declaration. It runs under every property read of every element.
	[kSyncResolved](): void {
		if (!this[kCascade]) {
			return;
		}
		// Before the work, because resolving below reads back through this
		// declaration.
		this[kCascade][kCurrentDeclarations].add(this);
		this[kCSSRules] = this[kCascade][kMatchingRules](this[kElement]);
		this[kInlineBlock] = null;
		this[kCustom] = null;
		storeTransitionFallback(
			this[kCascade],
			this[kElement],
			"",
			this[kResolved],
		);
		this[kResolved] = new Map();
		dropUsedValues(this[kCascade], this);
		if ((this as IndexedCollection)[kIndexCount] !== undefined) {
			syncIndexed(this);
		}
		// The re-resolution is a style change event. Whatever changed against
		// the last snapshot starts, retargets or cancels transitions.
		processTransitionStyle(
			this[kCascade],
			this[kElement],
			(property) => this[kBaseValue](property),
			"",
		);
	}
}

// The cascade's declaration, interned, and absolutized against this
// element when the interned entry says only an element can resolve it.
function getAbsolutizedValue(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	const entry = getComputedEntry(
		property,
		resolvePropertyValue(declaration, property),
	);
	if (!entry.contextual) {
		return entry.value;
	}
	const absolute = absolutizeLengths(
		entry.value,
		getLengthContext(declaration, property),
	);
	// Two radii that differ as written (`1ch 1px`) can measure the same
	// cell, and a corner whose radii agree states one of them.
	return RADIUS_LONGHANDS.has(property) ? collapseRadius(absolute) : absolute;
}

// `font-size` measures against the PARENT's font size, so it is the one
// property whose own computed value is not in its own context.
function getLengthContext(
	declaration: ComputedStyleDeclaration,
	property: string,
): LengthContext {
	const own = property === "font-size";
	const parent = own
		? flatParentElement(declaration[kElement])
		: null;
	const font = own
		? parent
			? getFontSize(getComputedValue(parent, "font-size"))
			: INITIAL_FONT_SIZE
		: getFontSize(declaration.getComputedValue("font-size"));
	const root = getRootFontSize(declaration, own);
	const cascade = declaration[kCascade];
	const block = cascade ? cascade[kLayout].initialContainingBlock : null;
	return {
		font,
		root,
		viewportWidth: block ? block.width : 0,
		viewportHeight: block ? block.height : 0,
		// A percentage is font-relative on exactly two properties. On
		// `font-size` it is a share of the parent's, on `line-height` of this
		// element's own. Everywhere else it stays a percentage until used.
		percent: FONT_RELATIVE_PERCENTAGES.has(property) ? font / 100 : null,
	};
}

function getRootFontSize(
	declaration: ComputedStyleDeclaration,
	ownFontSize: boolean,
): number {
	const root = declaration[kElement].ownerDocument?.documentElement;
	// `rem` in the root's own font-size means the initial value, not the
	// value being computed.
	if (!root || (ownFontSize && root === declaration[kElement])) {
		return INITIAL_FONT_SIZE;
	}
	return root === declaration[kElement]
		? getFontSize(declaration.getComputedValue("font-size"))
		: getFontSize(getComputedValue(root, "font-size"));
}

function toPhysicalProperty(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	if (!LOGICAL_TO_PHYSICAL.ltr.has(property)) {
		return property;
	}
	return (
		getPhysicalProperty(property, declaration.getComputedValue("direction")) ??
		property
	);
}

// The reader is the caller's. The computed and resolved paths ask their
// longhands different questions, and the results must not mix, which is
// why only the computed one is memoized.
function resolveShorthand(
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

function measureUsedValue(
	declaration: MeasuredDeclaration,
	property: string,
	computed: string,
): string {
	// A border with no style draws nothing and takes no space, whatever
	// width it declares.
	if (property.startsWith("border-") && property.endsWith("-width")) {
		const style = declaration.getComputedValue(
			`${property.slice(0, -"-width".length)}-style`,
		);
		if (!style || style === "none" || style === "hidden") {
			return "0px";
		}
	}
	const inset = INSET_PROPERTIES.has(property);
	// An inset only applies to a positioned box. On a static one it stays as
	// declared.
	const position = inset ? declaration.getPropertyValue("position") : "";
	if (inset && position === "static") {
		return computed;
	}

	const rect = getUsedRect(declaration[kCascade]!, declaration[kElement]);
	// No box (display:none, or a tree layout never reached), so the
	// computed value is the result, exactly as CSSOM says.
	if (!rect) {
		return computed;
	}

	if (inset) {
		return getUsedInset(declaration, property, computed, rect, position);
	}

	if (property === "width" || property === "height") {
		const vertical = property === "height";
		const edges =
			getEdgeLength(
				declaration,
				vertical ? "border-top-width" : "border-left-width",
			) +
			getEdgeLength(
				declaration,
				vertical ? "border-bottom-width" : "border-right-width",
			) +
			getEdgeLength(declaration, vertical ? "padding-top" : "padding-left") +
			getEdgeLength(declaration, vertical ? "padding-bottom" : "padding-right");
		// The rect is the border box whichever way the box was sized, and the
		// resolved value of width is the CONTENT width either way (cssom-view
		// §7.1), so the edges are subtracted regardless of box-sizing.
		const border = vertical ? rect.height : rect.width;
		return getUsedLength(Math.max(0, border - edges));
	}

	// An `auto` margin is whatever space the box was given: the distance
	// between its border box and its containing block's content edge.
	if (computed === "auto" && property.startsWith("margin-")) {
		return getUsedLength(getAutoMargin(declaration, property, rect));
	}

	// Every other used length is already absolute in this engine's own
	// unit, so the computed value carries it. Only a percentage still has to
	// be resolved, against the containing block's width.
	if (computed.endsWith("%")) {
		const basis = getContainingWidth(declaration);
		if (basis === null) {
			return computed;
		}
		return getUsedLength((parseFloat(computed) / 100) * basis);
	}
	return computed || "0px";
}

// A declared inset resolves as written. `auto` is the one that has to be
// measured, to whatever distance the box ended up at.
function getUsedInset(
	declaration: MeasuredDeclaration,
	property: string,
	computed: string,
	rect: DOMRect,
	position: string,
): string {
	const block = getContainingBlockBox(declaration, position);
	if (!block) {
		return computed;
	}
	const vertical = property === "top" || property === "bottom";
	const basis = vertical ? block.height : block.width;
	const own = getInsetLength(computed, basis);
	if (own !== null) {
		return getUsedLength(own);
	}
	// A sticky box keeps its `auto`. It names an edge that constrains
	// nothing, not a distance.
	if (position === "sticky") {
		return computed;
	}

	const opposite = OPPOSITE_INSET[property];
	const other = getInsetLength(declaration.getComputedValue(opposite), basis);
	// A relatively positioned box is offset from where it already was, so
	// an `auto` inset is the negative of its opposite, and zero when both
	// are auto, which moves the box nowhere.
	if (position === "relative") {
		return getUsedLength(other === null ? 0 : -other);
	}

	// Out of flow: the box hangs in its containing block, so the used inset
	// is the distance from that block's edge to the box's margin edge. That
	// is the far side of the box when the opposite inset placed it, and its
	// static position when neither did.
	const start = vertical ? "margin-top" : "margin-left";
	const end = vertical ? "margin-bottom" : "margin-right";
	if (other !== null) {
		const size =
			(vertical ? rect.height : rect.width) +
			getEdgeLength(declaration, start) +
			getEdgeLength(declaration, end);
		return getUsedLength(basis - other - size);
	}
	switch (property) {
		case "top":
			return getUsedLength(
				rect.y - getEdgeLength(declaration, start) - block.y,
			);
		case "left":
			return getUsedLength(
				rect.x - getEdgeLength(declaration, start) - block.x,
			);
		case "bottom":
			return getUsedLength(
				block.y +
				block.height -
				(rect.y + rect.height + getEdgeLength(declaration, end)),
			);
		default:
			return getUsedLength(
				block.x +
				block.width -
				(rect.x + rect.width + getEdgeLength(declaration, end)),
			);
	}
}

// The padding box of the block an out-of-flow box hangs from, the
// scrollport a sticky box is constrained by, and otherwise the content
// box of the box this one flows in.
function getContainingBlockBox(
	declaration: MeasuredDeclaration,
	position: string,
): DOMRect | null {
	if (position === "fixed") {
		return getViewportBox(declaration);
	}
	if (position === "absolute") {
		for (
			let ancestor = flatParentElement(declaration[kElement]);
			ancestor;
			ancestor = flatParentElement(ancestor)
		) {
			const ancestorPosition =
				getComputedValue(ancestor, "position");
			if (ancestorPosition && ancestorPosition !== "static") {
				return getUsedBoxRect(declaration, ancestor, false);
			}
		}
		return getViewportBox(declaration);
	}
	if (position === "sticky") {
		for (
			let ancestor = flatParentElement(declaration[kElement]);
			ancestor;
			ancestor = flatParentElement(ancestor)
		) {
			const overflow = getComputedValue(ancestor, "overflow");
			if (overflow && overflow !== "visible") {
				return getUsedBoxRect(declaration, ancestor, true);
			}
		}
	}
	const parent = flatParentElement(declaration[kElement]);
	return parent
		? getUsedBoxRect(declaration, parent, true)
		: getViewportBox(declaration);
}

function getUsedBoxRect(
	declaration: MeasuredDeclaration,
	element: Element,
	content: boolean,
): DOMRect | null {
	const rect = getUsedRect(declaration[kCascade]!, element);
	if (!rect) {
		return null;
	}
	const edge = (name: string): number =>
		parseFloat(getComputedValue(element, name)) || 0;
	let top = edge("border-top-width");
	let left = edge("border-left-width");
	let bottom = edge("border-bottom-width");
	let right = edge("border-right-width");
	if (content) {
		top += edge("padding-top");
		left += edge("padding-left");
		bottom += edge("padding-bottom");
		right += edge("padding-right");
	}
	return new (rect.constructor as typeof DOMRect)(
		rect.x + left,
		rect.y + top,
		rect.width - left - right,
		rect.height - top - bottom,
	);
}

// The initial containing block: the grid itself.
function getViewportBox(
	declaration: MeasuredDeclaration,
): DOMRect | null {
	const block = declaration[kCascade]![kLayout].initialContainingBlock;
	const rect = getUsedRect(declaration[kCascade]!, declaration[kElement]);
	if (!rect) {
		return null;
	}
	return new (rect.constructor as typeof DOMRect)(
		0,
		0,
		block.width,
		block.height,
	);
}

// `auto` means the automatic minimum only a flex or grid item, or an
// aspect-ratio box, actually has. Anywhere else it resolves to 0px.
function getResolvedMinSize(
	declaration: ComputedStyleDeclaration,
	computed: string,
): string {
	if (computed !== "auto") {
		return computed;
	}
	// A box that was never generated has no automatic minimum, whatever
	// else its style says.
	for (
		let element: Element | null = declaration[kElement];
		element;
		element = flatParentElement(element)
	) {
		if (getComputedValue(element, "display") === "none") {
			return "0px";
		}
	}
	if (declaration.getComputedValue("aspect-ratio") !== "auto") {
		return "auto";
	}
	const parent = flatParentElement(declaration[kElement]);
	const display = parent
		? getComputedValue(parent, "display")
		: "";
	return ITEM_DISPLAYS.has(display) ? "auto" : "0px";
}

function getEdgeLength(
	declaration: MeasuredDeclaration,
	property: string,
): number {
	return parseFloat(declaration.getPropertyValue(property)) || 0;
}

// The space an `auto` margin actually took, measured from the two
// boxes.
function getAutoMargin(
	declaration: MeasuredDeclaration,
	property: string,
	rect: DOMRect,
): number {
	const parent = flatParentElement(declaration[kElement]);
	const parentRect = parent
		? getUsedRect(declaration[kCascade]!, parent)
		: null;
	if (!parent || !parentRect) {
		return 0;
	}
	const edge = (name: string): number =>
		parseFloat(getComputedValue(parent, name)) || 0;
	const left =
		parentRect.x + edge("border-left-width") + edge("padding-left");
	const top = parentRect.y + edge("border-top-width") + edge("padding-top");
	const right =
		parentRect.x +
		parentRect.width -
		edge("border-right-width") -
		edge("padding-right");
	const bottom =
		parentRect.y +
		parentRect.height -
		edge("border-bottom-width") -
		edge("padding-bottom");
	switch (property) {
		case "margin-left":
			return Math.max(0, rect.x - left);
		case "margin-top":
			return Math.max(0, rect.y - top);
		case "margin-right":
			return Math.max(0, right - (rect.x + rect.width));
		default:
			return Math.max(0, bottom - (rect.y + rect.height));
	}
}

function getContainingWidth(
	declaration: MeasuredDeclaration,
): number | null {
	const parent = flatParentElement(declaration[kElement]);
	if (!parent) {
		return null;
	}
	const rect = getUsedRect(declaration[kCascade]!, parent);
	return rect ? rect.width : null;
}

// The cascade gets the expanded block, so a shorthand's `!important`
// covers every longhand it declares.
function getInlineDeclarations(
	declaration: ComputedStyleDeclaration,
): DeclarationBlock {
	let block = declaration[kInlineBlock];
	if (block === null) {
		const element = declaration[kElement];
		let style = inlineStyles.get(element);
		if (style === undefined && element.hasAttribute("style")) {
			getInlineStyle(element);
			style = inlineStyles.get(element);
		}
		block = style === undefined
			? EMPTY_DECLARATIONS
			: getDeclarationBlock(style);
		declaration[kInlineBlock] = block;
	}
	return block;
}

function resolveFromParent(
	declaration: ComputedStyleDeclaration,
	property: string,
): string | null {
	const parent = flatParentElement(declaration[kElement]);
	if (!parent) {
		return null;
	}
	return getComputedValue(parent, property) || null;
}

// Substituted values are substituted in turn. The depth guard stops a
// property that (invalidly) refers to itself.
function substituteVar(
	declaration: ComputedStyleDeclaration,
	value: string,
	depth = 0,
): string {
	if (depth > 8 || !value.includes("var(")) {
		return value;
	}

	let out = "";
	let i = 0;
	while (i < value.length) {
		const start = value.indexOf("var(", i);
		if (start === -1) {
			out += value.slice(i);
			break;
		}
		out += value.slice(i, start);

		let parenDepth = 1;
		let j = start + 4;
		for (; j < value.length && parenDepth > 0; j++) {
			if (value[j] === "(") {
				parenDepth++;
			} else if (value[j] === ")") {
				parenDepth--;
			}
		}
		const inner = value.slice(start + 4, j - 1);
		const commaIndex = inner.indexOf(",");
		const name = (
			commaIndex === -1 ? inner : inner.slice(0, commaIndex)
		).trim();
		const fallback =
			commaIndex === -1 ? undefined : inner.slice(commaIndex + 1).trim();

		// A custom property is an ordinary (always-inherited) cascade lookup.
		// resolvePropertyValueRaw's step 4 already walks ancestors for it.
		const resolved = resolvePropertyValueRaw(declaration, name) || null;
		if (resolved !== null) {
			out += substituteVar(declaration, resolved, depth + 1);
		} else if (fallback !== undefined) {
			out += substituteVar(declaration, fallback, depth + 1);
		}
		// Neither a value nor a fallback: the guaranteed-invalid value. Omit
		// it, which approximates the property's own initial/inherited fallback.

		i = j;
	}
	return out;
}

// What the cascade leaves, with var() substituted and `currentcolor`
// replaced by the color it names.
function resolvePropertyValue(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	const raw = resolvePropertyValueRaw(declaration, property);
	// A custom property holds the tokens it was given. Substituting it into
	// a property with its own grammar re-serializes them in that property's
	// spelling.
	const value = raw
		? !raw.includes("var(")
			? raw
			: property.startsWith("--")
				? substituteVar(declaration, raw)
				: serializeCSSValue(substituteVar(declaration, raw), property)
		: raw;
	// `currentcolor` is the element's own color, which is what a resolved
	// value reports. On `color` itself it means the parent's.
	if (
		value.toLowerCase() === "currentcolor" &&
		COLOR_PROPERTIES.has(property)
	) {
		// The COMPUTED color, on the engine's own read path. The author path
		// flushes, from inside the resolution of a style that layout is waiting
		// on.
		return property === "color"
			? (resolveFromParent(declaration, "color") ?? "")
			: declaration.getComputedValue("color");
	}
	return value;
}

// The physical property first, then every flow-relative name that can
// map to it, whichever way `direction` goes.
const SLOT_CANDIDATES = new Map<string, readonly string[]>();

function getSlotCandidates(property: string): readonly string[] {
	let names = SLOT_CANDIDATES.get(property);
	if (names === undefined) {
		const logical = PHYSICAL_TO_LOGICAL.get(property);
		names = logical ? [property, ...logical] : [property];
		SLOT_CANDIDATES.set(property, names);
	}
	return names;
}

function acceptsAnyName(): boolean {
	return true;
}

function resolvePropertyValueRaw(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	// A physical property and its flow-relative names are ONE cascade slot
	// (css-logical-1 §2.1). The slot widens to both inline edges and narrows
	// by `direction` only once a block actually declares one of them.
	const names = getSlotCandidates(property);
	let direction: string | null = null;
	const mapsHere =
		names.length === 1
			? acceptsAnyName
			: (name: string): boolean =>
				name === property ||
				getPhysicalProperty(
					name,
					(direction ??= declaration.getComputedValue("direction")),
				) === property;

	const inline = getInlineDeclarations(declaration);
	const inlineName = getDeclaredName(inline, names, false, mapsHere);
	const inlineValue =
		inlineName !== null ? inline.declarations[inlineName].trim() : "";
	const inlineImportantName = getDeclaredName(inline, names, true, mapsHere);
	const inlineImportantValue =
		inlineImportantName !== null
			? inline.declarations[inlineImportantName].trim()
			: "";

	// 1 & 2. Inline style and stylesheet rules, with an !important tier above
	// the normal cascade. The parsed rules are pre-sorted by specificity and
	// source order, so within each tier the last match wins.
	let ruleValue = "";
	let importantRuleValue = "";
	// `!important` reverses the origin and layer order (css-cascade-5 §6.1,
	// §6.4.4): a UA declaration beats an author one, the EARLIEST layer
	// wins, and unlayered declarations, which win the normal cascade, lose
	// to every layer. The rules arrive UA first and earliest layer first, so
	// the first origin and layer to declare the property keeps it, and
	// later rules only tie it within that same origin and layer.
	let importantOrigin = false;
	let importantLayer = 0;
	for (const rule of declaration[kCSSRules]) {
		const name = getDeclaredName(rule, names, false, mapsHere);
		if (name !== null) {
			ruleValue = rule.declarations[name];
		}
		const importantName = getDeclaredName(rule, names, true, mapsHere);
		if (
			importantName !== null &&
			(importantRuleValue === "" ||
				(Boolean(rule.uaOrigin) === importantOrigin &&
					rule.layerRank === importantLayer))
		) {
			importantRuleValue = rule.declarations[importantName];
			importantOrigin = Boolean(rule.uaOrigin);
			importantLayer = rule.layerRank;
		}
	}

	const declared =
		inlineImportantValue || importantRuleValue || inlineValue || ruleValue;
	// A CSS-wide keyword on the winning declaration decides the value there:
	// `inherit` takes the parent's whether or not the property inherits,
	// `initial` takes the property's initial value, and the rest send
	// resolution on to the defaults below, as though nothing were declared.
	if (declared === "inherit") {
		return resolveFromParent(declaration, property) ?? "";
	}
	if (declared === "initial") {
		return CSS_SPEC_DEFAULTS[property] || CSS_INITIAL_VALUES[property] || "";
	}
	if (declared !== "" && !INITIAL_KEYWORDS.has(declared)) {
		return declared;
	}

	// 3. The UA's own per-element defaults, such as strong's bold, which
	// take precedence over anything inherited.
	const element = declaration[kElement];
	const isList =
		element.namespaceURI === HTML_NAMESPACE &&
		(element.localName === "ul" || element.localName === "ol");

	// A list's marker gutter is sized to its widest marker rather than
	// taken from the static table, so it has to be resolved first.
	if (property === "padding-left" && isList) {
		return `${getListGutterWidth(declaration[kElement])}ch`;
	}

	// The UA default marker type depends on nesting depth, exactly as a
	// browser's `ul ul { list-style-type: circle }` rules do. Resolving it
	// here rather than inheriting means an author value on an outer list
	// does not leak into a nested one, while an author rule that matches
	// the nested list still wins because step 2 already returned it.
	if (property === "list-style-type" && isList) {
		if (element.localName === "ol") {
			return "decimal";
		}
		const bullets = ["disc", "circle", "square"];
		const depth = getListNestingDepth(declaration[kElement]);
		return bullets[Math.min(depth, bullets.length - 1)];
	}

	const elementDefaults = getElementDefaults(declaration[kElement]);
	if (elementDefaults && elementDefaults[property]) {
		return elementDefaults[property];
	}

	// 4. What the element inherits: the nearest ancestor with a value for
	// an inherited property, resolved through the same steps so the
	// ancestor's own rules apply. A custom property always inherits; there
	// is no fixed list of names.
	if (INHERITED_PROPERTIES.has(property) || property.startsWith("--")) {
		const window = declaration[kElement].ownerDocument?.defaultView;
		if (window) {
			// Flat-tree parents. Inheritance crosses the shadow boundary (host
			// to shadow child) and reaches slotted content through its slot's
			// chain, exactly as in a browser.
			for (
				let parent = flatParentElement(declaration[kElement]);
				parent !== null;
				parent = flatParentElement(parent)
			) {
				const parentValue = getComputedValue(parent, property);
				if (parentValue) {
					return parentValue;
				}
			}
		}
	}

	// 5. The property's initial value.
	return CSS_SPEC_DEFAULTS[property] || CSS_INITIAL_VALUES[property] || "";
}

// This element's own custom properties and every ancestor's, since a
// custom property inherits.
function getCustomNames(
	computed: ComputedStyleDeclaration,
): string[] {
	const current = computed[kCascade]?.[kCurrentDeclarations];
	if (current !== undefined && !current.has(computed)) {
		computed[kSyncResolved]();
	}
	if (computed[kCustom]) {
		return computed[kCustom];
	}
	const names = new Set<string>();
	for (
		let element: Element | null = computed[kElement];
		element;
		element = flatParentElement(element)
	) {
		const declaration = computed[kCascade]?.declarationFor(element);
		for (const name of declaration?.declaredCustomProperties() ?? []) {
			names.add(name);
		}
	}
	computed[kCustom] = [...names];
	return computed[kCustom];
}

// In a document, and reachable through the flat tree it composes. A
// light-DOM child its host never slots has no computed style to report.
function isBeingRendered(element: Element): boolean {
	// Walk out through every shadow root the element is under. A tree whose
	// outermost root is the document is composed into the rendering. One
	// that ends in a bare fragment is not.
	let node: Node = element;
	for (let depth = 0; depth < 32; depth++) {
		const root = node.getRootNode();
		if (root === element.ownerDocument) {
			break;
		}
		const host = (root as ShadowRoot).host;
		if (!host) {
			return false;
		}
		node = host;
	}
	// A light-DOM child an open shadow root never slots is outside the flat
	// tree. A closed root is this engine's own UA shadow tree internals, whose
	// parts the UA shadow tree itself reads styles for.
	for (
		let child: Element | null = element;
		child;
		child = child.parentElement
	) {
		const parent = child.parentElement;
		if (
			parent?.shadowRoot &&
			parent.shadowRoot.mode === "open" &&
			!(child as HTMLElement).assignedSlot
		) {
			return false;
		}
	}
	return true;
}

const kPseudoDeclarations = Symbol("pseudo declarations");
const kPseudoElement = Symbol("pseudoElement");
const kNodeResolved = Symbol("nodeResolved");
const kBoxView = Symbol("boxView");
const kPseudoDeclarationsFor = Symbol("pseudoDeclarationsFor");
const kContentBox = Symbol("contentBox");

// A flat declaration set: the matched rules plus what the
// pseudo-element inherits from its originating element. LIVE, for the
// same reason an element's declaration is.
class PseudoStyleDeclaration extends CSSStyleProperties {
	declare [kPseudoDeclarations]: Record<string, string>;
	declare [kResolved]: Map<string, string>;

	// Absent on the engine's own reads (the ::selection and ::marker
	// painters), which want the cascade's declarations and never a used
	// value. Their declarations are passed in whole and are not the
	// cascade's to recompute.
	declare [kElement]: Element | null;
	declare [kPseudoElement]: string;
	declare [kCascade]: Cascade | null;

	declare [kNodeResolved]: Map<string, string>;
	declare [kBoxView]: MeasuredDeclaration | null;
	constructor(
		declarations: Record<string, string>,
		element?: Element,
		cascade?: Cascade,
		pseudoElement = "",
	) {
		super();
		this[kResolved] = new Map<string, string>();
		this[kNodeResolved] = new Map<string, string>();
		this[kBoxView] = null;
		this[kPseudoDeclarations] = declarations;
		this[kElement] = element ?? null;
		this[kPseudoElement] = pseudoElement;
		this[kCascade] = cascade ?? null;
		if (cascade) {
			cascade[kCurrentDeclarations].add(this);
		}
	}

	override get length(): number {
		return CSS_LONGHANDS.length;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	// The engine's read. An empty result means no rule reached the
	// pseudo-element, which is what the ::selection and ::marker painters
	// check.
	getComputedValue(property: string): string {
		const current = this[kCascade]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kSyncResolved]();
		}
		const value = this[kBaseValue](property);
		const transitional = getPseudoTransitionValue(this, property);
		return transitional ?? value;
	}

	// The style of the NODE a pseudo-element generates: the declarations
	// completed with initial values, so a box is never laid out without a
	// `display`.
	nodeValue(property: string): string {
		const current = this[kCascade]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kSyncResolved]();
		}
		let value = this[kNodeResolved].get(property);
		if (value === undefined) {
			value =
				this[kBaseValue](property) ||
				getComputedValueEntry(property, getInitialStyle(null, property));
			this[kNodeResolved].set(property, value);
		}
		const transitional = getPseudoTransitionValue(this, property);
		return transitional ?? value;
	}

	override getPropertyValue(property: string): string {
		this[kCascade]?.[kFlushStyle]();
		const computed =
			this.getComputedValue(property) ||
			getComputedValueEntry(property, getInitialStyle(null, property));
		if (this[kCascade] && USED_VALUE_PROPERTIES.has(property)) {
			return this[kUsedValue](property, computed);
		}
		return computed;
	}

	override setProperty(): void {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override removeProperty(): string {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override getPropertyPriority(): string {
		return "";
	}

	override item(index: number): string {
		return CSS_LONGHANDS[index] ?? "";
	}

	[kSyncResolved](): void {
		// Before the work, because resolving below reads back through this
		// declaration.
		this[kCascade]?.[kCurrentDeclarations].add(this);
		if (this[kCascade] && this[kElement] && this[kPseudoElement]) {
			this[kPseudoDeclarations] = this[kCascade][kPseudoDeclarationsFor](
				this[kElement],
				this[kPseudoElement],
			);
			storeTransitionFallback(
				this[kCascade],
				this[kElement],
				this[kPseudoElement],
				this[kResolved],
			);
		}
		this[kResolved] = new Map();
		this[kNodeResolved].clear();
		if ((this as IndexedCollection)[kIndexCount] !== undefined) {
			syncIndexed(this);
		}
		if (this[kCascade] && this[kElement] && this[kPseudoElement]) {
			processTransitionStyle(
				this[kCascade],
				this[kElement],
				(property) => this[kBaseValue](property),
				this[kPseudoElement],
			);
		}
	}

	// The cascade's declarations alone, with no transition overriding them.
	[kBaseValue](property: string): string {
		let value = this[kResolved].get(property);
		if (value === undefined) {
			const longhands = SHORTHAND_LONGHANDS.get(property);
			value =
				longhands && this[kPseudoDeclarations][property] === undefined
					? serializeShorthandValue(
						property,
						longhands,
						(longhand) =>
							this[kBaseValue](longhand) ||
							CSS_INITIAL_VALUES[longhand] ||
							"",
					)
					: getComputedValueEntry(
						property,
						this[kPseudoDeclarations][property] ?? "",
					);
			this[kResolved].set(property, value);
		}
		return value;
	}

	// Measured from the node the composition pass gave the pseudo-element,
	// through the same arithmetic as an element's metrics. A pseudo-element
	// never given a node uses the percentage resolution below, against the
	// box it would be in.
	[kUsedValue](property: string, computed: string): string {
		const originating = this[kElement];
		const cascade = this[kCascade];
		if (originating && cascade) {
			// Flush before the node lookup. The composition pass that runs
			// under the flush is what creates a pseudo-element's node, so a
			// lookup taken first would report "no box" for a box one render
			// away.
			getUsedRect(cascade, originating);
			const node = pseudoElement<Element>(
				originating,
				this[kPseudoElement],
			);
			if (node) {
				return measureUsedValue(getBoxView(this, node), property, computed);
			}
		}
		if (!computed.endsWith("%")) {
			return computed;
		}
		const display = this.getPropertyValue("display");
		if (display === "none" || display === "contents") {
			return computed;
		}
		// An originating element with `display: contents` generates no box of
		// its own, so its pseudo-elements go in the box its parent makes, the
		// same box its children go in.
		let host: Element | null = this[kElement];
		while (
			host &&
			getComputedValue(host, "display") === "contents"
		) {
			host = flatParentElement(host);
		}
		const box = host && this[kCascade]![kContentBox](host);
		if (!box) {
			return computed;
		}
		// Every percentage except the block-axis sizes resolves against the
		// containing block's width, including in the block direction.
		const vertical =
			property === "height" || property === "top" || property === "bottom";
		const basis = vertical ? box.height : box.width;
		return getUsedLength((parseFloat(computed) / 100) * basis);
	}
}

function getPseudoTransitionValue(
	declaration: PseudoStyleDeclaration,
	property: string,
): string | null {
	const cascade = declaration[kCascade];
	if (
		cascade === null ||
		declaration[kElement] === null ||
		cascade[kActiveTransitions].size === 0
	) {
		return null;
	}
	return getTransitionValue(
		cascade,
		declaration[kElement],
		declaration[kPseudoElement],
		property,
	);
}

// The same cascade with the pseudo-element's own node in place of the
// element. One view per node: composition may drop a node and make
// another, and a view naming the old one would measure a rect no layout
// has.
function getBoxView(
	declaration: PseudoStyleDeclaration,
	node: Element,
): MeasuredDeclaration {
	let view = declaration[kBoxView];
	if (!view || view[kElement] !== node) {
		view = {
			[kElement]: node,
			[kCascade]: declaration[kCascade],
			getComputedValue: (property: string): string =>
				declaration.nodeValue(property),
			getPropertyValue: (property: string): string =>
				declaration.getPropertyValue(property),
		};
		declaration[kBoxView] = view;
	}
	return view;
}

// A declaration of nothing, which CSSOM specifies for a bad pseudo
// argument.
class EmptyStyleDeclaration extends CSSStyleProperties {
	declare [kElement]: Element | null;

	constructor(element?: Element) {
		super();
		this[kElement] = element ?? null;
	}

	override get length(): number {
		return 0;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override getPropertyValue(): string {
		return "";
	}

	override getPropertyPriority(): string {
		return "";
	}

	override setProperty(): void {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override removeProperty(): string {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override item(): string {
		return "";
	}
}

// Writing a computed style is an error, not a no-op. It throws the
// document's own DOMException, since one from another global is not
// what an author catches.
function readOnlyDeclaration(element?: Element): DOMException {
	const document = element ? element.ownerDocument : null;
	const view = document ? document.defaultView : null;
	const Exception =
		(view as unknown as {DOMException?: typeof DOMException} | null)
			?.DOMException ?? DOMException;
	return new Exception(
		"A computed style declaration is read-only",
		"NoModificationAllowedError",
	);
}

// The accessors (style.fontWeight) callers use alongside
// getPropertyValue.
const ACCESSOR_PROPERTIES = new Set<string>([
	...LENGTH_PROPERTIES,
	...COLOR_PROPERTIES,
	...INHERITED_PROPERTIES,
	"align-content",
	"align-items",
	"align-self",
	"background",
	"background-image",
	"background-position",
	"background-repeat",
	"border",
	"border-bottom-color",
	"border-bottom-style",
	"border-collapse",
	"border-color",
	"border-left-color",
	"border-left-style",
	"border-radius",
	"border-right-color",
	"border-right-style",
	"border-style",
	"border-top-color",
	"border-top-style",
	"box-sizing",
	"clear",
	"content",
	"counter-increment",
	"counter-reset",
	"display",
	"flex",
	"flex-direction",
	"flex-grow",
	"flex-shrink",
	"flex-wrap",
	"float",
	"gap",
	"inset",
	"isolation",
	"justify-content",
	"opacity",
	"order",
	"outline",
	"outline-color",
	"outline-style",
	"overflow",
	"overflow-x",
	"overflow-y",
	"position",
	"table-layout",
	"text-decoration-color",
	"text-decoration-line",
	"text-decoration-style",
	"vertical-align",
	"z-index",
]);

for (const property of ACCESSOR_PROPERTIES) {
	const camelCase = camelCaseProperty(property);
	for (const name of new Set([property, camelCase])) {
		for (const prototype of [
			ComputedStyleDeclaration.prototype,
			PseudoStyleDeclaration.prototype,
		] as object[]) {
			if (name in prototype) {
				continue;
			}
			Object.defineProperty(prototype, name, {
				get(this: ComputedStyleDeclaration | PseudoStyleDeclaration) {
					return this.getPropertyValue(property);
				},
				configurable: true,
			});
		}
	}
}

interface BorderSides {
	top?: LineStyle["style"];
	right?: LineStyle["style"];
	bottom?: LineStyle["style"];
	left?: LineStyle["style"];
	topLeft?: "round";
	topRight?: "round";
	bottomRight?: "round";
	bottomLeft?: "round";
}

const LINE_KEYWORDS = new Set<string>(LINE_STYLES);

export function resolveBorderSides(element: Element): BorderSides {
	const sideOf = (
		width: string,
		style: string,
	): LineStyle["style"] | undefined => {
		const parsed = parseBorderWidthValue(width);
		const widthValue = typeof parsed === "number" ? parsed : NaN;
		if (isNaN(widthValue) || widthValue <= 0 || !style || style === "none") {
			return undefined;
		}
		// An unknown style keyword draws as solid rather than not at all.
		return LINE_KEYWORDS.has(style)
			? (style as LineStyle["style"])
			: "solid";
	};

	// Rounded when the radius is nonzero on BOTH axes, as a browser squares
	// off a collapsed ellipse. A cell grid has one size of curve.
	const roundedCorner = (corner: string): "round" | undefined => {
		const radii = getComputedValue(element, `border-${corner}-radius`)
			.split(/\s+/)
			.filter(Boolean);
		if (radii.length === 0) {
			return undefined;
		}
		return radii.every((radius) => parseFloat(radius) > 0)
			? "round"
			: undefined;
	};

	const of = (side: string): LineStyle["style"] | undefined =>
		sideOf(
			getComputedValue(element, `border-${side}-width`) ||
			getComputedValue(element, "border-width"),
			getComputedValue(element, `border-${side}-style`) ||
			getComputedValue(element, "border-style"),
		);

	return {
		top: of("top"),
		right: of("right"),
		bottom: of("bottom"),
		left: of("left"),
		topLeft: roundedCorner("top-left"),
		topRight: roundedCorner("top-right"),
		bottomRight: roundedCorner("bottom-right"),
		bottomLeft: roundedCorner("bottom-left"),
	};
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

function getListNestingDepth(element: Element): number {
	let depth = 0;
	for (
		let parent = element.parentElement;
		parent;
		parent = parent.parentElement
	) {
		if (parent.tagName === "UL" || parent.tagName === "OL") {
			depth++;
		}
	}
	return depth;
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

// `<ol start>` sets where counting begins, `<ol reversed>` counts down,
// and a `<li value>` resets the counter mid-list and carries forward.
function getListItemOrdinal(listItem: Element, listParent: Element): number {
	const items = Array.from(listParent.children).filter(
		(child) => child.tagName === "LI",
	);

	const reversed = listParent.hasAttribute("reversed");
	const start = parseInt(listParent.getAttribute("start") ?? "", 10);

	let counter = Number.isFinite(start) ? start : reversed ? items.length : 1;

	for (const item of items) {
		const value = parseInt(item.getAttribute("value") ?? "", 10);
		if (Number.isFinite(value)) {
			counter = value;
		}
		if (item === listItem) {
			return counter;
		}
		counter += reversed ? -1 : 1;
	}

	return counter;
}

// Falls back to decimal outside a style's range.
function formatOrdinal(ordinal: number, listStyleType: string): string {
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

// Keyed by the COMPUTED list-style-type, not the parent's tag name. A
// ul can be decimal, an ol disc, either none.
function getListMarker(listItem: Element, listParent: Element): string {
	const listStyleType =
		getComputedValue(listItem, "list-style-type");

	if (!listStyleType || listStyleType === "none") {
		return "";
	}

	const bullet = BULLET_MARKERS[listStyleType];
	if (bullet) {
		return bullet;
	}

	if (COUNTER_STYLES.has(listStyleType)) {
		const items = Array.from(listParent.children).filter(
			(child) => child.tagName === "LI",
		);
		if (!items.includes(listItem)) {
			return "";
		}
		return `${formatOrdinal(getListItemOrdinal(listItem, listParent), listStyleType)}.`;
	}

	return "";
}

// TODO: Just use the CSSOM CSSRule interface from the DOM
interface ParsedCSSRule {

	// Compiled against the namespaces the sheet declared, once, at parse. A
	// rule is matched through this and never through its text. Null for a
	// selector this engine cannot read, which styles nothing.
	matcher: CompiledSelector | null;

	// The same selector read relative to a scoping root, which is what
	// `@scope { > .a { } }` writes. Only a rule inside an @scope has one.
	relativeMatcher: CompiledSelector | null;

	// Every rule is tried against every element, so this check keeps a
	// document of divs from running the selector engine over a sheet's
	// worth of rules about summaries and legends. Absent when any element
	// could match.
	subjectTag?: string;
	declarations: Record<string, string>;
	important: Record<string, boolean>;

	// Each declaration's position in the rule's block. See DeclarationBlock.
	order: Record<string, number>;

	// Zero-padded for lexicographic comparison.
	specificity: string;
	pseudoElement?: string;

	// The tree scope whose stylesheet declared this rule. Undefined for
	// document rules. A rule only ever matches elements of its own tree,
	// which is the cascade's encapsulation boundary in both directions.
	scope?: Node;

	// `:host` is the one thing that reaches outside the tree its
	// stylesheet belongs to.
	reachesHost?: boolean;

	// Cascade ORIGIN, the tier above specificity. Every author rule beats
	// every UA rule, which lets `input::placeholder { color }` beat the UA
	// sheet's gray despite that selector's higher specificity.
	uaOrigin?: boolean;

	// Dot-joined through every enclosing @layer. Null for a rule in no
	// layer.
	layer: string | null;

	// Layers in declaration order, then every unlayered rule last, which
	// wins the normal cascade. Filled in once the whole order is known.
	layerRank: number;

	// The @scope conditions the rule was declared inside, outermost first.
	// Absent for a rule no @scope encloses, which is in scope everywhere.
	scopes?: readonly ScopeCondition[];
}

interface ScopeCondition {
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

interface RuleContext {
	layer: string | null;
	scopes: readonly ScopeCondition[];
}

const UNCONDITIONAL: RuleContext = {layer: null, scopes: []};

// Farther from any element than any scoping root can be.
const UNSCOPED = Number.MAX_SAFE_INTEGER;

function isScopeRootMatch(
	element: Element,
	condition: ScopeCondition,
	outer: Element | null,
): boolean {
	if (condition.roots === null) {
		return element === condition.owner;
	}
	// Relative to the enclosing scope's root, which is what `:scope` refers
	// to.
	return outer
		? condition.rootsInOuter.some((root) => isSelectedBy(element, root, outer))
		: condition.roots.some((root) => isSelectedBy(element, root, element));
}

// Inside the root with no scoping limit between the two. The root is
// always in its own scope.
function isInScope(
	element: Element,
	root: Element,
	condition: ScopeCondition,
): boolean {
	let node: Element | null = element;
	for (; node && node !== root; node = node.parentElement) {
		if (condition.limits.some((limit) => isSelectedBy(node!, limit, root))) {
			return false;
		}
	}
	return node === root;
}

// The cascade types its nodes as the platform's interfaces and the
// matcher as this DOM's own classes. They are the same objects under two
// names, cast here.
function isSelectedBy(
	element: Element,
	selector: CompiledSelector,
	scope: Node,
	shadow: Node | null = null,
): boolean {
	return matchesCompiled(element as unknown as DOMElement, selector, {
		scope: scope as unknown as DOMNode,
		shadow: shadow as DOMNode | null,
	});
}

function shouldCreatePseudoElement(
	cascade: Cascade,
	element: Element,
	pseudoType: string,
): boolean {
	if (pseudoType === "::marker") {
		const computedStyle = cascade.declarationFor(element);
		const display = computedStyle.getComputedValue("display");
		const listStylePosition =
			computedStyle.getComputedValue("list-style-position") || "outside";

		if (display === "list-item" && listStylePosition !== "outside") {
			return true;
		}
	}

	const styles = computePseudoElementStyle(cascade, element, pseudoType);
	const content = styles.content;
	return !!(content && content !== "none" && content !== "normal");
}

const kCounterScopes = Symbol("counterScopes");

// The entry point for mutations.
function attachPseudoElementsToElement(
	cascade: Cascade,
	element: Element,
): void {
	// If no pseudo rule names this element's type and it has no
	// pseudo-element to reconsider, everything below would return no, at
	// the cost of one matches() call per rule. Counters are built when a
	// content value first reads them.
	const tags = getPseudoSubjects(cascade);
	if (
		tags !== null &&
		!tags.has(element.tagName) &&
		pseudoElementCount(element) === 0 &&
		!(element.getAttribute("style") ?? "").includes("list-item")
	) {
		return;
	}

	for (const pseudoType of PSEUDO_ELEMENT_NAMES) {
		attachPseudoElementToElementForType(cascade, element, pseudoType);
	}
}

// A selector this engine cannot read selects nothing and is dropped.
function compileSelectors(
	text: string,
	options: {namespaces: SelectorNamespaces; relative?: boolean},
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

interface CounterScope {
	element: Element;
	counters: {[counterName: string]: number};
	parent?: CounterScope;
}

const kWindow = Symbol("window");
const kDocument = Symbol("document");
const kAttributeReachesDescendants = Symbol("attributeReachesDescendants");
const kDropCache = Symbol("clearCache");
const kResolveCounterFunction = Symbol("resolveCounterFunction");
const kParsedStyleSheetCount = Symbol("parsedStyleSheetCount");
const kFlushing = Symbol("flushing");
const kUsedValues = Symbol("usedValues");
const kUsedStale = Symbol("used values stale");
const kShadowRoots = Symbol("shadowRoots");
const kSelectorsReachAncestors = Symbol("selectorsReachAncestors");
const kSelectorsReachSiblings = Symbol("selectorsReachSiblings");

// Selectors whose match on one element depends on its siblings or its
// children: the sibling combinators, the tree-structural pseudo-classes
// and :empty.
const SIBLING_SELECTOR = /[+~]|:(?:nth-|first-|last-|only-|empty)/;
const kComputedStyleCache = Symbol("computedStyleCache");
const kPseudoElementStyleCache = Symbol("pseudoElementStyleCache");
const kParsedRules = Symbol("parsedRules");
const kReachingClasses = Symbol("reachingClasses");
const kKeyProperties = Symbol("keyProperties");
const kReachingIds = Symbol("reachingIds");
const kReachingAttributes = Symbol("reachingAttributes");
const kReachingStates = Symbol("reachingStates");
const kPseudoRulesByType = Symbol("pseudoRulesByType");
const kPseudoSubjectTags = Symbol("pseudoSubjectTags");
const kCounterRulesExist = Symbol("counterRulesExist");
const kListItemRulesExist = Symbol("listItemRulesExist");
const kScopedRulesExist = Symbol("scopedRulesExist");
const kHasRulesExist = Symbol("hasRulesExist");
const kHoverRulesExist = Symbol("hoverRulesExist");
const kLayerPaths = Symbol("layerPaths");
const kAnonymousLayers = Symbol("anonymousLayers");
const kUnlayeredRank = Symbol("unlayeredRank");
const kTransitionSnapshots = Symbol("transitionSnapshots");
const kTransitionFallback = Symbol("transitionFallback");
const kTransitionClock = Symbol("transitionClock");
const kTransitionTimer = Symbol("transitionTimer");
const kTransitionEvents = Symbol("transitionEvents");
const kTransitionFlushQueued = Symbol("transitionFlushQueued");

export class Cascade {
	declare [kComputedStyleCache]: WeakMap<Element, ComputedStyleDeclaration>;

	// Every declaration resolved against the current cascade. Dropping one, or
	// replacing the set, sends it back through kSyncResolved on its next read.
	// Weak, so a declaration nobody holds costs nothing.
	declare [kCurrentDeclarations]: WeakSet<object>;

	// Nothing else tracks a shadow tree's sheets, so a parse walks these.
	declare [kShadowRoots]: Set<ShadowRoot>;
	declare [kPseudoElementStyleCache]: WeakMap<
		Element,
		Map<string, PseudoStyleDeclaration>
	>;

	declare [kParsedRules]: ParsedCSSRule[];
	declare [kStylesheetsDirty]: boolean;
	declare [kParsing]: boolean;
	// Every element holding a pseudo-element node, so a sheet change
	// reconsiders them without walking the document.
	declare [kPseudoHosts]: Set<Element>;

	// Whether any parsed selector can reach OUTSIDE a mutated element's
	// subtree. Sibling combinators reach following siblings, and :has()
	// reaches ancestors. The string tests are deliberately loose. A false
	// positive only widens the rebuild.
	declare [kSelectorsReachSiblings]: boolean;
	declare [kSelectorsReachAncestors]: boolean;

	// The keys whose change can affect an element's DESCENDANTS: those a
	// selector tests left of a combinator (`.editing .view`), and those on
	// rules declaring an inherited property. Collected loosely. A false
	// positive only widens the invalidation.
	declare [kReachingClasses]: Set<string>;
	// Every property a rule declares, by each class, id and attribute its
	// selector tests, as `.name`, `#name` and `[name]`. A change to a key
	// whose properties are all paint decides nothing layout reads.
	declare [kKeyProperties]: Map<string, Set<string>>;
	declare [kReachingIds]: Set<string>;
	declare [kReachingAttributes]: Set<string>;

	// Whether any of those keys is a STATE pseudo-class (`:checked ~`),
	// which is driven by attributes not in the sets above. While this is
	// set, a change to any of STATE_ATTRIBUTES invalidates widely.
	declare [kReachingStates]: boolean;

	// Rule-existence gates. Attaching pseudo-elements and initializing
	// counters both build full computed-style declarations per element per
	// mutation. A document with no such rules must not pay that, and these
	// let the hot paths decide "could any rule apply" with a few matches()
	// calls.
	declare [kPseudoRulesByType]: Map<string, ParsedCSSRule[]>;
	declare [kCounterRulesExist]: boolean;
	declare [kListItemRulesExist]: boolean;

	// Whether any rule is scoped, which is what adds proximity to the sort.
	declare [kScopedRulesExist]: boolean;
	declare [kHasRulesExist]: boolean;

	// The engine reads this to decide whether the terminal must report
	// pointer motion. A sheet that never tests :hover cannot show it, and
	// motion reporting has a per-cell cost.
	declare [kHoverRulesExist]: boolean;

	// -1 means never parsed. A changed count re-parses on the next style
	// computation, which lets a sheet appended right before the first paint
	// apply with no MutationObserver attached.
	declare [kParsedStyleSheetCount]: number;

	declare [kCounterScopes]: WeakMap<Element, CounterScope>;

	// The transition gate is STICKY. It opens the first time anything
	// declares a transition and never closes, so a document with none pays
	// two checks per style change event. Snapshots live in a WeakMap. Only
	// elements with RUNNING transitions are in the strong map the tick
	// iterates.
	declare [kTransitionsExist]: boolean;
	declare [kTransitionSnapshots]: WeakMap<
		Element,
		Map<string, Map<string, string>>
	>;

	// A dropped declaration's resolved values, kept as the before-change
	// style for a transition declared and retargeted in one style change,
	// the case the snapshot cannot cover. These are the original maps, not
	// copies. The declaration replacing its memo is what makes the old map
	// safe to hold.
	declare [kTransitionFallback]: WeakMap<
		Element,
		Map<string, Map<string, string>>
	>;

	declare [kActiveTransitions]: Map<
		Element,
		Map<string, Map<string, RunningTransition>>
	>;

	// The timeline instant a frame's reads interpolate against.
	declare [kTransitionClock]: number;
	declare [kTransitionTimer]: ReturnType<typeof setTimeout> | null;
	declare [kTransitionEvents]: QueuedTransitionEvent[];
	declare [kTransitionFlushQueued]: boolean;

	// Fixed for the window's lifetime, so held directly.
	declare [kDocument]: Document;
	declare [kWindow]: Window;
	declare [kLayout]: Layout;

	declare [kFlushing]: boolean;

	// The used values measured behind the last flush, held here rather
	// than on the declarations so a cascade rebuild drops them all at once.
	declare [kUsedValues]: WeakMap<object, Map<string, string>>;

	// Set by the layout engine when geometry changed under the used values.
	declare [kUsedStale]: boolean;

	// Every cascade layer, in the order its name was first declared. A
	// nested layer's path is dot-joined, the name `@layer a.b` writes for
	// itself.
	declare [kLayerPaths]: string[];
	declare [kAnonymousLayers]: number;

	// Where an unlayered rule sorts: after every layer, and so above them.
	declare [kUnlayeredRank]: number;

	// The element types a pseudo rule originates on, uppercased. Null when
	// a rule reaches any type, as a counter rule does through the scope
	// chain.
	declare [kPseudoSubjectTags]: Set<string> | null | undefined;

	constructor(window: Window, layout: Layout) {
		this[kComputedStyleCache] = new WeakMap<
			Element,
			ComputedStyleDeclaration
		>();
		this[kCurrentDeclarations] = new WeakSet<object>();
		this[kShadowRoots] = new Set<ShadowRoot>();
		this[kPseudoElementStyleCache] = new WeakMap<
			Element,
			Map<string, PseudoStyleDeclaration>
		>();
		this[kParsedRules] = [];
		this[kStylesheetsDirty] = false;
		this[kParsing] = false;
		this[kPseudoHosts] = new Set();
		this[kSelectorsReachSiblings] = false;
		this[kSelectorsReachAncestors] = false;
		this[kReachingClasses] = new Set<string>();
		this[kKeyProperties] = new Map<string, Set<string>>();
		this[kReachingIds] = new Set<string>();
		this[kReachingAttributes] = new Set<string>();
		this[kReachingStates] = false;
		this[kPseudoRulesByType] = new Map<string, ParsedCSSRule[]>();
		this[kCounterRulesExist] = false;
		this[kListItemRulesExist] = false;
		this[kScopedRulesExist] = false;
		this[kHasRulesExist] = false;
		this[kHoverRulesExist] = false;
		this[kParsedStyleSheetCount] = -1;
		this[kCounterScopes] = new WeakMap<Element, CounterScope>();
		this[kFlushing] = false;
		this[kUsedValues] = new WeakMap();
		this[kUsedStale] = true;
		this[kLayerPaths] = [];
		this[kAnonymousLayers] = 0;
		this[kUnlayeredRank] = 0;
		this[kTransitionsExist] = false;
		this[kTransitionSnapshots] = new WeakMap();
		this[kTransitionFallback] = new WeakMap();
		this[kActiveTransitions] = new Map();
		this[kTransitionClock] = 0;
		this[kTransitionTimer] = null;
		this[kTransitionEvents] = [];
		this[kTransitionFlushQueued] = false;
		this[kWindow] = window;
		this[kLayout] = layout;
		this[kDocument] = window.document;

		documentCascades.set(this[kDocument], this);
		window.getComputedStyle = (
			element: Element,
			pseudoElt?: string | null,
		): globalThis.CSSStyleDeclaration =>
			getResolvedStyle(this, element, pseudoElt);

		setupInvalidationHooks(this);

		parseStylesheets(this);
	}

	registerShadowRoot(root: ShadowRoot): void {
		if (this[kShadowRoots].has(root)) {
			return;
		}
		this[kShadowRoots].add(root);
		// Incrementally. Rebuilding every sheet per UA shadow tree upgrade made
		// a document of n UA shadow trees reparse everything n times.
		this[kSyncShadowRoot](root);
	}

	handleMutations(mutations: MutationRecord[]): void {
		const Node = this[kWindow].Node;
		let shouldSyncStylesheets = false;

		// A :has() subject sits ABOVE what changed it, so when such rules exist
		// every mutation restyles its flat-tree ancestor chain too.
		if (this[kHasRulesExist]) {
			for (const mutation of mutations) {
				const start =
					mutation.target.nodeType === 1
						? (mutation.target as Element)
						: mutation.target.parentElement;
				for (
					let ancestor: Element | null = start;
					ancestor;
					ancestor = flatParentElement(ancestor)
				) {
					invalidateElementCaches(this, ancestor);
				}
			}
		}

		for (const mutation of mutations) {
			if (mutation.type === "childList") {
				// A <style>'s children ARE its stylesheet text. A shadow
				// sheet's sync stays inside its root.
				if ((mutation.target as Element).tagName === "STYLE") {
					reparseOwnerText(getSheet(mutation.target as Element));
					const styleRoot = mutation.target.getRootNode();
					if (isShadowRoot(styleRoot)) {
						this[kSyncShadowRoot](styleRoot);
					} else {
						shouldSyncStylesheets = true;
					}
				}
				// A list's gutter is derived from its items' markers, so a
				// change to the ITEMS invalidates the list: a wider marker added
				// later overran the gutter the original items set. A change
				// inside an item's content moves no marker.
				if (mutationChangesListItems(mutation)) {
					invalidateEnclosingList(this, mutation.target);
				}

				for (const node of mutation.addedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (isStyleElement(element)) {
							const addedRoot =
								element.tagName === "STYLE" ? element.getRootNode() : null;
							if (addedRoot !== null && isShadowRoot(addedRoot)) {
								this[kSyncShadowRoot](addedRoot);
							} else {
								shouldSyncStylesheets = true;
							}
						} else {
							invalidateElementCaches(this, element);
							attachPseudoElementsToElement(this, element);

							const childElements = element.querySelectorAll("*");
							for (const childElement of childElements) {
								invalidateElementCaches(this, childElement);
								attachPseudoElementsToElement(this, childElement);
							}
						}
					}
				}

				for (const node of mutation.removedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (isStyleElement(element)) {
							shouldSyncStylesheets = true;
						}
					}
				}
				// A child that came or went changes what `li + li`,
				// `:first-child` and `:empty` match on the children around it
				// and on the parent, none of which the mutation names.
				if (this[kSelectorsReachAncestors]) {
					this[kDropCache]();
				} else if (
					this[kSelectorsReachSiblings] &&
					mutation.target.nodeType === Node.ELEMENT_NODE
				) {
					invalidateSubtree(this, mutation.target as Element);
				}
			} else if (mutation.type === "attributes") {
				const element = mutation.target as Element;
				// A change to keys whose rules declare only paint properties
				// leaves every box where it was. The styles are dropped so the
				// next read resolves them, and layout is not told.
				const notifyLayout = !isPaintOnlyChange(
					this,
					element,
					mutation.attributeName!,
					mutation.oldValue,
				);
				// Only a change the sheets USE that way reaches descendants.
				// When no rule tests the class outside its own subject and none
				// declares an inherited property, descendant styles are
				// unchanged.
				if (
					this[kAttributeReachesDescendants](
						element,
						mutation.attributeName!,
						mutation.oldValue,
					)
				) {
					invalidateSubtree(this, element, notifyLayout);
				} else {
					invalidateElementCaches(this, element, notifyLayout);
					attachPseudoElementsToElement(this, element);
				}
				if (!notifyLayout) {
					this[kLayout].invalidateFrame();
				}
				// `.on ~ .light` matches a FOLLOWING sibling whose cached
				// styles know nothing of this change. :has() reaches ancestors,
				// and the only correct response is to drop every cached style.
				if (this[kSelectorsReachAncestors]) {
					this[kDropCache]();
				} else if (this[kSelectorsReachSiblings]) {
					for (
						let sibling = element.nextElementSibling;
						sibling;
						sibling = sibling.nextElementSibling
					) {
						invalidateSubtree(this, sibling);
					}
				}
			} else if (mutation.type === "characterData") {
				const owner = mutation.target.parentElement;
				if (owner?.tagName === "STYLE") {
					reparseOwnerText(getSheet(owner));
					const ownerRoot = owner.getRootNode();
					if (isShadowRoot(ownerRoot)) {
						this[kSyncShadowRoot](ownerRoot);
					} else {
						shouldSyncStylesheets = true;
					}
				}
			}
		}

		if (shouldSyncStylesheets) {
			this.syncStylesheets();
		}
	}

	// user-select, with `auto` resolved through the parent per css-ui-4.
	// `text`, `all` and `contain` all behave as plain isSelectable. Nothing
	// implements the shapes `all` and `contain` ask for yet.
	isSelectable(element: Node): boolean {
		let current = element as Element | null;
		while (current) {
			const value = getComputedValue(current, "user-select");
			if (value === "none") {
				return false;
			}
			if (value !== "auto" && value !== "") {
				return true;
			}
			current = flatParentElement(current);
		}
		return true;
	}

	// Focus is not a mutation, and nothing else invalidates. The cached
	// declarations of the two moved elements hold rule sets matched BEFORE
	// the move, so a :focus rule would never apply or stop applying.
	handleFocusChange(...elements: Array<Element | null>): void {
		for (const element of elements) {
			// The whole flat-tree chain can observe focus (:focus-within,
			// :host(:focus)), so every element on it goes stale together.
			for (
				let node: Element | null = element;
				node;
				node = flatParentElement(node)
			) {
				invalidateElementCaches(this, node);
				const shadowRoot = getShadowRoot(node);
				if (shadowRoot) {
					for (const descendant of shadowRoot.querySelectorAll("*")) {
						invalidateElementCaches(this, descendant);
					}
				}
			}
		}
	}

	// State no attribute records changed: a popover was shown or hidden,
	// and the rules that test it (:popover-open) matched before the change.
	handleStateChange(element: Element): void {
		invalidateSubtree(this, element);
		// No mutation record describes the change, so the frame that decides
		// whether anything needs painting is notified here.
		this[kLayout].invalidateFrame();
	}

	// The same staleness a focus move leaves, scoped to the symmetric
	// difference of the two flat-tree chains. The shared ancestors above the
	// fork were hovered before and are hovered still.
	handleHoverChange(
		previous: Element | null,
		next: Element | null,
	): void {
		const chainOf = (element: Element | null): Set<Element> => {
			const chain = new Set<Element>();
			for (
				let node: Element | null = element;
				node;
				node = flatParentElement(node)
			) {
				chain.add(node);
			}
			return chain;
		};
		const previousChain = chainOf(previous);
		const nextChain = chainOf(next);
		const invalidate = (node: Element): void => {
			invalidateElementCaches(this, node);
			// A host's hover reaches its shadow tree through :host(:hover).
			const shadowRoot = getShadowRoot(node);
			if (shadowRoot) {
				for (const descendant of shadowRoot.querySelectorAll("*")) {
					invalidateElementCaches(this, descendant);
				}
			}
		};
		for (const node of previousChain) {
			if (!nextChain.has(node)) {
				invalidate(node);
			}
		}
		for (const node of nextChain) {
			if (!previousChain.has(node)) {
				invalidate(node);
			}
		}
	}

	// A dirty sheet list parses first, so a value read between frames still
	// describes the current document.
	hoverRulesExist(): boolean {
		parseStylesheetsIfStale(this);
		return this[kHoverRulesExist];
	}

	// The internal read path: no pseudo parsing, no being-rendered check, no
	// resolved-value branch. Called thousands of times per frame, so it does
	// the least it can.
	declarationFor(element: Element): ComputedStyleDeclaration {
		let declaration = this[kComputedStyleCache].get(element);
		if (!declaration) {
			parseStylesheetsIfStale(this);
			declaration = new ComputedStyleDeclaration(
				element,
				getMatchingRules(this, element),
				this,
			);
			this[kComputedStyleCache].set(element, declaration);
			// Building a fresh declaration is the other form of the style
			// change event kSyncResolved sees.
			const fresh = declaration;
			processTransitionStyle(
				this,
				element,
				(property) => fresh[kBaseValue](property),
				"",
			);
		}
		return declaration;
	}

	// Only width/height features are meaningful on the one screen a
	// terminal has. Every other feature matches rather than silently
	// dropping rules. Public because window.matchMedia uses the SAME
	// evaluator @media does, so a stylesheet and a script can never
	// disagree.
	mediaQueryMatches(mediaText: string): boolean {
		const text = mediaText.trim();
		if (!text) {
			return true;
		}
		const queries = parseMediaQueryList(text);
		if (!queries) {
			return true;
		}
		return queries.some((query) => mediaQueryNodeMatches(this, query));
	}

	/** The text a list item's marker draws, or null when it draws none. */
	getMarkerContent(hostElement: Element): string | null {
		if (!hostElement || hostElement.nodeType !== hostElement.ELEMENT_NODE) {
			return null;
		}

		const computedStyle = this.declarationFor(hostElement);
		const display = computedStyle.getComputedValue("display");

		if (display !== "list-item") {
			return null;
		}

		const styles = computePseudoElementStyle(this, hostElement, "::marker");
		let content = styles.content;

		if (!content || content === "none" || content === "normal") {
			content = getDefaultMarkerContent(hostElement) ?? content;
		}
		if (!content || content === "none" || content === "normal") {
			return null;
		}

		let textContent = unquoteContent(content);

		textContent = this[kResolveCounterFunction](hostElement, textContent);

		return textContent;
	}

	syncStylesheets(): void {
		// A sheet materializing its rules under the parse in progress
		// notifies once per rule; that parse reads them.
		if (this[kParsing]) {
			return;
		}
		parseStylesheets(this);

		// Boxes may have been built under the pre-parse styles. A
		// .view{display:none} arriving in the same batch as its markup left the
		// hidden subtree's stale boxes behind. Rebuild from the root.
		// Stylesheet changes are rare.
		const body = this[kDocument].body;
		if (body) {
			this[kLayout].invalidate(body);
		}
	}

	// The document is being torn down.
	dispose(): void {
		this[kComputedStyleCache] = new WeakMap();
		this[kPseudoElementStyleCache] = new WeakMap();
		this[kCounterScopes] = new WeakMap();
		if (this[kTransitionTimer] !== null) {
			clearTimeout(this[kTransitionTimer]);
			this[kTransitionTimer] = null;
		}
		this[kActiveTransitions].clear();
		this[kTransitionEvents] = [];
	}

	[kMatchingRules](element: Element): ParsedCSSRule[] {
		parseStylesheetsIfStale(this);
		return getMatchingRules(this, element);
	}

	// Every author-facing style read goes through this flush, so a value
	// read right after a DOM change describes it. The engine's own reads
	// never flush. Not re-entrant: layout and paint resolve styles as they
	// run, and asking for the flush from inside it would compute it inside
	// itself.
	[kFlushStyle](): void {
		if (this[kFlushing]) {
			return;
		}
		this[kFlushing] = true;
		try {
			if (flushLayout(this[kDocument])) {
				this[kUsedValues] = new WeakMap();
			}
		} finally {
			this[kFlushing] = false;
		}
	}

	// The box a child's or a pseudo-element's percentage resolves against,
	// measured behind the same flush a rect read takes.
	[kContentBox](element: Element): DOMRect | null {
		if (!getUsedRect(this, element)) {
			return null;
		}
		return this[kLayout].contentRect(element);
	}

	// Null for a box that generated no grid. The resolved value then stays
	// the computed track list, as CSSOM says.
	[kUsedGridTracks](element: Element, rows: boolean): number[] | null {
		if (!getUsedRect(this, element)) {
			return null;
		}
		return this[kLayout].gridTracks(element, rows);
	}

	// Re-parse ONE shadow root's sheets in place. Only trees the root's
	// rules can reach restyle. A pending full rebuild covers this root.
	[kSyncShadowRoot](root: ShadowRoot): void {
		if (this[kStylesheetsDirty] || this[kParsedStyleSheetCount] < 0) {
			this[kStylesheetsDirty] = true;
			return;
		}
		this[kParsedRules] = this[kParsedRules].filter(
			(rule) => rule.scope !== root,
		);
		const before = this[kParsedRules].length;
		for (const sheet of getShadowStyleSheets(root)) {
			parseStyleSheet(this, sheet, root);
		}
		// Without this sync the drift check orders the full rebuild this path
		// exists to avoid, once per UA shadow tree.
		this[kParsedStyleSheetCount] = getStyleSheetCount(this);
		const fresh = this[kParsedRules].slice(before);
		if (fresh.length === 0) {
			return;
		}
		const layerRanks = rankLayers(this);
		for (const rule of this[kParsedRules]) {
			rule.layerRank =
				rule.layer === null
					? this[kUnlayeredRank]
					: (layerRanks.get(rule.layer) ?? this[kUnlayeredRank]);
		}
		sortRulesForCascade(this);
		const host = root.host as Element | null;
		if (host) {
			invalidateSubtree(this, host);
		} else {
			for (const child of root.children) {
				invalidateSubtree(this, child);
			}
		}
		// The UA shadow trees' sheets have no pseudo-generating rules, so the
		// attach sweep runs only for an author shadow root that does.
		if (
			fresh.some(
				(rule) =>
					rule.pseudoElement &&
					rule.pseudoElement !== "::placeholder" &&
					rule.pseudoElement !== "::selection" &&
					!rule.pseudoElement.startsWith("::part("),
			)
		) {
			attachPseudoElements(this);
		}
	}

	[kPseudoDeclarationsFor](
		element: Element,
		pseudoElement: string,
	): Record<string, string> {
		const declarations: Record<string, string> = {
			...computePseudoElementStyle(this, element, pseudoElement),
		};
		// A pseudo-element INHERITS from its originating element. Rule
		// declarations win, and inherited values only fill the gaps.
		const hostStyle = this.declarationFor(element);
		for (const property of INHERITED_PROPERTIES) {
			if (!declarations[property]) {
				const inherited = hostStyle.getComputedValue(property);
				if (inherited) {
					declarations[property] = inherited;
				}
			}
		}
		// A pseudo-element of a flex or grid container is one of its items,
		// and an item's display isBlockified, including the initial `inline`.
		if (ITEM_DISPLAYS.has(hostStyle.getComputedValue("display"))) {
			declarations.display = getBlockifiedDisplay(
				declarations.display || getInitialStyle(null, "display"),
			);
		}
		return declarations;
	}

	// Whether this attribute change can affect a DESCENDANT's style, by a
	// rule that matches one or a value they inherit. An inline style always
	// can, because what it declares is not known until parsed.
	[kAttributeReachesDescendants](
		element: Element,
		name: string,
		oldValue: string | null,
	): boolean {
		if (name === "style") {
			return true;
		}
		if (name === "class") {
			if (this[kReachingAttributes].has("class")) {
				return true;
			}
			if (this[kReachingClasses].size === 0) {
				return false;
			}
			// With no old value, the classes that LEFT cannot be known.
			if (oldValue === null) {
				return element.hasAttribute("class");
			}
			// Only the classes that came or went can have changed a match.
			const before = new Set(oldValue.split(/\s+/));
			const after = element.classList;
			for (const token of after) {
				if (!before.has(token) && this[kReachingClasses].has(token)) {
					return true;
				}
			}
			for (const token of before) {
				if (
					token !== "" &&
					!after.contains(token) &&
					this[kReachingClasses].has(token)
				) {
					return true;
				}
			}
			return false;
		}
		if (name === "id") {
			if (this[kReachingAttributes].has("id")) {
				return true;
			}
			if (oldValue !== null && this[kReachingIds].has(oldValue)) {
				return true;
			}
			const id = element.getAttribute("id");
			return id !== null && this[kReachingIds].has(id);
		}
		if (this[kReachingAttributes].has(name)) {
			return true;
		}
		return this[kReachingStates] && STATE_ATTRIBUTES.has(name);
	}

	[kDropCache](): void {
		// Every computed style ever handed out re-resolves on its next read.
		this[kCurrentDeclarations] = new WeakSet<object>();
		this[kUsedValues] = new WeakMap();
		this[kComputedStyleCache] = new WeakMap();
		this[kPseudoElementStyleCache] = new WeakMap();
		this[kCounterScopes] = new WeakMap();
	}

	// Replace each counter(name[, style]) with the number it stands at
	// here.
	[kResolveCounterFunction](element: Element, content: string): string {
		initializeCounters(this, element);
		const scope = this[kCounterScopes].get(element);
		return content.replace(
			/counter\s*\(\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g,
			(_match, counterName, style) => {
				const trimmedName = counterName.trim();
				const trimmedStyle = style?.trim() || "decimal";
				return formatCounterValue(
					getCounterValueInScope(scope, trimmedName),
					trimmedStyle,
				);
			},
		);
	}
}

// The flush runs once per change, not once per read. A caller reading
// four properties off two hundred elements pays one flush, not eight
// hundred. Nothing under the flush can call back into this.
function getUsedRect(cascade: Cascade, element: Element): DOMRect | null {
	if (cascade[kUsedStale]) {
		flushLayout(cascade[kDocument]);
		cascade[kUsedStale] = false;
		cascade[kUsedValues] = new WeakMap();
	}
	return cascade[kLayout].getRect(element);
}

// A pseudo-element's declaration, on the same internal read path.
function getPseudoDeclaration(
	cascade: Cascade,
	element: Element,
	pseudoElement: string,
): PseudoStyleDeclaration {
	const cached = cascade[kPseudoElementStyleCache]
		.get(element)
		?.get(pseudoElement);
	if (cached) {
		return cached;
	}
	const declarations = cascade[kPseudoDeclarationsFor](element, pseudoElement);
	const declaration = new PseudoStyleDeclaration(
		declarations,
		element,
		cascade,
		pseudoElement,
	);
	// The cache is fetched HERE, not before the work. Resolving the host's
	// style can reparse the stylesheets, which replaces every cache on this
	// cascade, and a map fetched before that would be orphaned.
	let elementCache = cascade[kPseudoElementStyleCache].get(element);
	if (!elementCache) {
		elementCache = new Map();
		cascade[kPseudoElementStyleCache].set(element, elementCache);
	}
	elementCache.set(pseudoElement, declaration);
	processTransitionStyle(
		cascade,
		element,
		(property) => declaration[kBaseValue](property),
		pseudoElement,
	);
	return declaration;
}

// Driven from the rules rather than the tree, so the walk costs what
// the sheets ask for rather than what the document holds.
function attachPseudoElementsToDocument(cascade: Cascade): void {
	const pseudoRulesByType = new Map<string, ParsedCSSRule[]>();

	for (const rule of cascade[kParsedRules]) {
		if (
			rule.pseudoElement &&
			rule.pseudoElement !== "::placeholder" &&
			rule.pseudoElement !== "::selection" &&
			!rule.pseudoElement.startsWith("::part(")
		) {
			const rules = pseudoRulesByType.get(rule.pseudoElement) || [];
			rules.push(rule);
			pseudoRulesByType.set(rule.pseudoElement, rules);
		}
	}

	for (const [pseudoType, rules] of pseudoRulesByType) {
		const matchingElements = new Set<Element>();

		for (const rule of rules) {
			// Within the rule's own tree scope. A :host rule reaches the one
			// element outside it.
			const scope = (rule.scope ?? cascade[kDocument]) as Node;
			for (const element of selectForRule(scope, rule)) {
				matchingElements.add(element);
			}
			const host = rule.reachesHost
				? ((rule.scope as ShadowRoot).host as Element | null)
				: null;
			if (host && ruleSelectorMatches(host, rule)) {
				matchingElements.add(host);
			}
		}

		for (const element of matchingElements) {
			attachPseudoElementToElementForType(cascade, element, pseudoType);
		}
	}

	// A ::marker needs no rule to exist, since list-style-type gives it
	// content on its own, so the items are found by tag as well.
	const listItems = cascade[kDocument].querySelectorAll(
		'[style*="list-item"], li',
	);
	for (const element of listItems) {
		const computedStyle = cascade.declarationFor(element);
		const display = computedStyle.getComputedValue("display");
		const listStylePosition =
			computedStyle.getComputedValue("list-style-position") || "outside";

		if (display === "list-item" && listStylePosition !== "outside") {
			attachPseudoElementToElementForType(cascade, element, "::marker");
		}
	}
}

function invalidateElement(cascade: Cascade, element: Element): void {
	// A computed style an author still holds is the one this cache handed
	// out, so it is told the cascade changed rather than merely dropped.
	const dropped = cascade[kComputedStyleCache].get(element);
	if (dropped) {
		cascade[kCurrentDeclarations].delete(dropped);
		storeTransitionFallback(cascade, element, "", dropped[kResolved]);
	}
	cascade[kComputedStyleCache].delete(element);
	cascade[kPseudoElementStyleCache].delete(element);
	// A style change can flip display: contents, which moves the node's
	// flat-tree BOX parent, so every box enumeration is stale.
	cascade[kLayout].invalidateFrame();
}

// The parent's scope is read, never built. Building it recursively up a
// deep tree is what this avoids.
// Built on first read, not on invalidation: a counter's value depends
// on the element's ancestors, and for a list item on the items before
// it, so the parent is built first and a dropped scope comes back when
// something next asks. A full restyle used to build every element's
// computed style here for the counters alone.
function initializeCounters(cascade: Cascade, element: Element): void {
	if (cascade[kCounterScopes].has(element)) {
		return;
	}
	if (element.parentElement) {
		initializeCounters(cascade, element.parentElement);
	}

	// With no counter rules anywhere, only lists carry counters. But an
	// element under a scope-holding parent still joins, so a chain like ol >
	// li > div > ol keeps its inheritance path unbroken.
	const tag = element.tagName;
	if (
		!cascade[kCounterRulesExist] &&
		tag !== "OL" &&
		tag !== "UL" &&
		tag !== "LI" &&
		!(
			element.parentElement &&
			cascade[kCounterScopes].has(element.parentElement)
		) &&
		!(element.getAttribute("style") ?? "").includes("counter")
	) {
		return;
	}

	const computedStyle = cascade.declarationFor(element);
	const counterReset = computedStyle.getComputedValue("counter-reset");
	const counterIncrement = computedStyle.getComputedValue(
		"counter-increment",
	);

	const parentElement = element.parentElement;
	const parentScope = parentElement
		? cascade[kCounterScopes].get(parentElement)
		: undefined;

	const scope: CounterScope = {
		element,
		counters: {},
		parent: parentScope,
	};
	cascade[kCounterScopes].set(element, scope);

	if (counterReset && counterReset !== "none") {
		parseCounterReset(scope, counterReset);
	}

	if (element.tagName === "OL" || element.tagName === "UL") {
		const startValue =
			element.tagName === "OL"
				? parseInt(element.getAttribute("start") || "1", 10)
				: 0;
		// start - 1, so the first increment gives start.
		scope.counters["list-item"] = startValue - 1;
	}

	if (counterIncrement && counterIncrement !== "none") {
		parseCounterIncrement(cascade, scope, counterIncrement);
	}

	if (element.tagName === "LI") {
		incrementCounter(cascade, scope, "list-item", 1);
	}
}

function isStyleElement(element: Element): boolean {
	return (
		element.tagName === "STYLE" ||
		(element.tagName === "LINK" &&
			element.getAttribute("rel") === "stylesheet")
	);
}

// A <style>'s child list IS its stylesheet. Changing it replaces the
// rules even when the resulting text is the same.
function reparseOwnerText(sheet: CSSStyleSheet): void {
	sheet[kText] = null;
}

function getBlockifiedDisplay(display: string): string {
	return BLOCKIFIED_DISPLAYS[display] ?? display;
}

function getUsedValues(
	cascade: Cascade,
	declaration: object,
): Map<string, string> {
	let values = cascade[kUsedValues].get(declaration);
	if (!values) {
		values = new Map();
		cascade[kUsedValues].set(declaration, values);
	}
	return values;
}

function dropUsedValues(cascade: Cascade, declaration: object): void {
	cascade[kUsedValues].delete(declaration);
}

// What window.getComputedStyle returns: CSSOM's RESOLVED value, which
// is computed for most properties and used for the ones that need
// layout. The platform method is misnamed, and this is the one place the
// engine uses that name.
function getResolvedStyle(
	cascade: Cascade,
	element: Element,
	pseudoElt?: string | null,
): globalThis.CSSStyleDeclaration {
	cascade[kFlushStyle]();
	parseStylesheetsIfStale(cascade);
	// An element out of the document, or out of the flat tree it composes,
	// has no style to report. Only an author read comes through here.
	if (!isBeingRendered(element)) {
		return new EmptyStyleDeclaration(
			element,
		) as unknown as globalThis.CSSStyleDeclaration;
	}

	let pseudoElement = "";
	if (pseudoElt) {
		const parsed = parsePseudoElementArgument(String(pseudoElt));
		if (parsed === null) {
			return new EmptyStyleDeclaration(
				element,
			) as unknown as globalThis.CSSStyleDeclaration;
		}
		pseudoElement = parsed;
	}

	if (pseudoElement) {
		return getIndexedDeclaration(
			getPseudoDeclaration(cascade, element, pseudoElement),
		) as unknown as globalThis.CSSStyleDeclaration;
	}

	return getIndexedDeclaration(
		cascade.declarationFor(element),
	) as unknown as globalThis.CSSStyleDeclaration;
}

// CSS transitions (css-transitions-1): started at style change events,
// advanced by a per-frame tick, read through the computed-value
// override.
interface TransitionTiming {
	duration: number;
	delay: number;
	easing: string;
}

interface RunningTransition {
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

interface QueuedTransitionEvent {
	element: Element;
	type: string;
	propertyName: string;
	elapsedTime: number;
	pseudoElement: string;
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

// Only properties something read are here, which is enough: a value
// nothing computed has nothing to transition from. Runs regardless of
// the sticky gate, because the write declaring an element's first
// transition lands AFTER the invalidation that drops the values it
// transitions from.
function storeTransitionFallback(
	cascade: Cascade,
	element: Element,
	pseudo: string,
	resolved: Map<string, string>,
): void {
	if (resolved.size === 0) {
		return;
	}
	let byPseudo = cascade[kTransitionFallback].get(element);
	if (!byPseudo) {
		byPseudo = new Map();
		cascade[kTransitionFallback].set(element, byPseudo);
	}
	byPseudo.set(pseudo, resolved);
}

function getTransitionBase(
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
function getMatchedTransitions(
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

// One style change event: compare the new base values against the last
// snapshot; start, retarget or cancel; store the new snapshot. The early
// returns are all each style change in a transition-free document pays.
function processTransitionStyle(
	cascade: Cascade,
	element: Element,
	read: (property: string) => string,
	pseudo: string,
): void {
	const active = cascade[kActiveTransitions].get(element)?.get(pseudo);
	if (!cascade[kTransitionsExist] && !active) {
		// An inline transition written right before this event may not have
		// parsed yet. The attribute text is the one place it already shows.
		const attribute = element.getAttribute("style");
		if (!attribute || !attribute.includes("transition")) {
			return;
		}
		cascade[kTransitionsExist] = true;
	}
	const candidates = getMatchedTransitions(read);
	let snapshots = cascade[kTransitionSnapshots].get(element);
	const previous = snapshots?.get(pseudo);
	const fallbacks = cascade[kTransitionFallback].get(element);
	const fallback = fallbacks?.get(pseudo);
	if (fallback) {
		fallbacks!.delete(pseudo);
	}
	if (!candidates && !active && !previous) {
		return;
	}
	const now = performance.now();
	const names = new Set<string>([
		...(candidates?.keys() ?? []),
		...(active?.keys() ?? []),
	]);
	for (const property of names) {
		const after = getTransitionBase(read, property);
		const timing = candidates?.get(property);
		const runnable =
			timing !== undefined && timing.duration + Math.max(timing.delay, 0) > 0;
		const running = active?.get(property);
		if (running) {
			if (!runnable) {
				cancelTransition(cascade, element, pseudo, property, now);
				continue;
			}
			if (after === running.to) {
				continue;
			}
			const current = getCurrentTransitionValue(running, now);
			cancelTransition(cascade, element, pseudo, property, now);
			if (current === after) {
				continue;
			}
			// A change back toward where an unfinished transition came from
			// plays in the portion already covered (css-transitions-1 §3).
			let duration = timing.duration;
			let factor = 1;
			if (after === running.reversingAdjustedStartValue) {
				const progress = getTransitionProgress(running, now);
				factor = Math.min(
					Math.max(
						progress * running.reversingShorteningFactor +
						(1 - running.reversingShorteningFactor),
						0,
					),
					1,
				);
				duration *= factor;
			}
			startTransition(cascade, element, pseudo, property, {
				from: current,
				to: after,
				timing: {...timing, duration},
				now,
				reversingAdjustedStartValue: running.to,
				reversingShorteningFactor: factor,
			});
			continue;
		}
		// An element styled for the first time transitions nothing. The
		// fallback's raw entries store "no declaration" as the empty string,
		// and the snapshot stores the initial value explicitly.
		const raw = previous?.get(property) ?? fallback?.get(property);
		const before =
			raw === ""
				? getComputedValueEntry(property, CSS_INITIAL_VALUES[property] ?? "")
				: raw;
		if (
			before === undefined ||
			before === after ||
			!runnable
		) {
			continue;
		}
		startTransition(cascade, element, pseudo, property, {
			from: before,
			to: after,
			timing: timing!,
			now,
			reversingAdjustedStartValue: before,
			reversingShorteningFactor: 1,
		});
	}
	if (candidates) {
		const snapshot = new Map<string, string>();
		for (const property of candidates.keys()) {
			snapshot.set(property, getTransitionBase(read, property));
		}
		if (!snapshots) {
			snapshots = new Map();
			cascade[kTransitionSnapshots].set(element, snapshots);
		}
		snapshots.set(pseudo, snapshot);
	} else if (previous) {
		snapshots!.delete(pseudo);
	}
}

function startTransition(
	cascade: Cascade,
	element: Element,
	pseudo: string,
	property: string,
	options: {
		from: string;
		to: string;
		timing: TransitionTiming;
		now: number;
		reversingAdjustedStartValue: string;
		reversingShorteningFactor: number;
	},
): void {
	let byPseudo = cascade[kActiveTransitions].get(element);
	if (!byPseudo) {
		byPseudo = new Map();
		cascade[kActiveTransitions].set(element, byPseudo);
	}
	let transitions = byPseudo.get(pseudo);
	if (!transitions) {
		transitions = new Map();
		byPseudo.set(pseudo, transitions);
	}
	const {timing, now} = options;
	const transition: RunningTransition = {
		property,
		from: options.from,
		to: options.to,
		start: now,
		delay: timing.delay,
		duration: timing.duration,
		easing: parseEasing(timing.easing),
		started: timing.delay <= 0,
		reversingAdjustedStartValue: options.reversingAdjustedStartValue,
		reversingShorteningFactor: options.reversingShorteningFactor,
	};
	transitions.set(property, transition);
	cascade[kTransitionClock] = now;
	// A negative delay starts partway in, which is what elapsedTime
	// reports.
	const elapsed =
		Math.min(Math.max(-timing.delay, 0), timing.duration) / 1000;
	queueTransitionEvent(
		cascade,
		element,
		"transitionrun",
		property,
		elapsed,
		pseudo,
	);
	if (transition.started) {
		queueTransitionEvent(
			cascade,
			element,
			"transitionstart",
			property,
			elapsed,
			pseudo,
		);
	}
	scheduleTransitionTick(cascade);
}

function cancelTransition(
	cascade: Cascade,
	element: Element,
	pseudo: string,
	property: string,
	now: number,
): void {
	const byPseudo = cascade[kActiveTransitions].get(element);
	const transitions = byPseudo?.get(pseudo);
	const transition = transitions?.get(property);
	if (!transition || !transitions || !byPseudo) {
		return;
	}
	transitions.delete(property);
	if (transitions.size === 0) {
		byPseudo.delete(pseudo);
	}
	if (byPseudo.size === 0) {
		cascade[kActiveTransitions].delete(element);
	}
	const elapsed = Math.min(
		Math.max((now - transition.start - transition.delay) / 1000, 0),
		transition.duration / 1000,
	);
	queueTransitionEvent(
		cascade,
		element,
		"transitioncancel",
		property,
		elapsed,
		pseudo,
	);
}

function getTransitionProgress(
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

function getCurrentTransitionValue(
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

// Interpolates against the cascade's clock rather than the wall clock.
// The clock moves once per tick, so a frame's reads agree with each
// other and with what the painter draws.
function getTransitionValue(
	cascade: Cascade,
	element: Element,
	pseudo: string,
	property: string,
): string | null {
	const transitions = cascade[kActiveTransitions].get(element)?.get(pseudo);
	const transition = transitions ? transitions.get(property) : undefined;
	if (!transition) {
		return null;
	}
	return getCurrentTransitionValue(transition, cascade[kTransitionClock]);
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
		const alpha =
			fromColor[3] + (toColor[3] - fromColor[3]) * progress;
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

function parseEasing(text: string): (input: number) => number {
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
function linearEasing(node: CSSNode): ((input: number) => number) | null {
	const stops: CSSNode[][] = [[]];
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
			: position === "jump-none"
				? Math.max(count - 1, 1)
				: count;
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

function queueTransitionEvent(
	cascade: Cascade,
	element: Element,
	type: string,
	propertyName: string,
	elapsedTime: number,
	pseudoElement: string,
): void {
	cascade[kTransitionEvents].push({
		element,
		type,
		propertyName,
		elapsedTime,
		pseudoElement,
	});
	if (cascade[kTransitionFlushQueued]) {
		return;
	}
	cascade[kTransitionFlushQueued] = true;
	// Style change events run under layout, and a listener can mutate the
	// DOM, so dispatch waits for the stack that queued it to unwind.
	queueMicrotask(() => flushTransitionEvents(cascade));
}

function flushTransitionEvents(cascade: Cascade): void {
	cascade[kTransitionFlushQueued] = false;
	if (cascade[kTransitionEvents].length === 0) {
		return;
	}
	const queued = cascade[kTransitionEvents];
	cascade[kTransitionEvents] = [];
	for (const item of queued) {
		const event = new TransitionEvent(item.type, {
			bubbles: true,
			cancelable: item.type === "transitionend",
			propertyName: item.propertyName,
			elapsedTime: item.elapsedTime,
			pseudoElement: item.pseudoElement,
		});
		dispatchAsUserAgent(item.element, event);
	}
}

function scheduleTransitionTick(cascade: Cascade): void {
	if (
		cascade[kTransitionTimer] !== null ||
		cascade[kActiveTransitions].size === 0
	) {
		return;
	}
	cascade[kTransitionTimer] = setTimeout(() => {
		cascade[kTransitionTimer] = null;
		tickTransitions(cascade);
	}, 16);
}

// Promote delayed transitions, finish elapsed ones, cancel those whose
// element left the document, then invalidate so the next read returns
// the new interpolated values.
function tickTransitions(cascade: Cascade): void {
	const now = performance.now();
	cascade[kTransitionClock] = now;
	for (const [element, byPseudo] of [...cascade[kActiveTransitions]]) {
		const disconnected = !element.isConnected;
		for (const [pseudo, transitions] of [...byPseudo]) {
			for (const [property, transition] of [...transitions]) {
				if (disconnected) {
					cancelTransition(cascade, element, pseudo, property, now);
					continue;
				}
				if (
					!transition.started &&
					now >= transition.start + transition.delay
				) {
					transition.started = true;
					queueTransitionEvent(
						cascade,
						element,
						"transitionstart",
						property,
						Math.min(Math.max(-transition.delay, 0), transition.duration) /
						1000,
						pseudo,
					);
				}
				if (
					now >=
					transition.start + transition.delay + transition.duration
				) {
					transitions.delete(property);
					queueTransitionEvent(
						cascade,
						element,
						"transitionend",
						property,
						transition.duration / 1000,
						pseudo,
					);
				}
			}
			if (transitions.size === 0) {
				byPseudo.delete(pseudo);
			}
		}
		if (byPseudo.size === 0) {
			cascade[kActiveTransitions].delete(element);
		}
		invalidateElementCaches(cascade, element);
	}
	cascade[kLayout].invalidateFrame();
	flushTransitionEvents(cascade);
	// A window no engine set up has no requestAnimationFrame, and its reads
	// interpolate on their own.
	const raf = (
		cascade[kWindow] as {
			requestAnimationFrame?: (cb: () => void) => number;
		}
	).requestAnimationFrame;
	if (typeof raf === "function") {
		raf.call(cascade[kWindow], () => {});
	}
	scheduleTransitionTick(cascade);
}

// The document counts <style> elements as they join and leave, so this
// is cheap enough to poll on every computed-style read. That catches a
// sheet appended in the same tick, before the mutation observer
// delivers.
function getStyleSheetCount(
	cascade: Cascade,
): number {
	return styleElementCount(cascade[kDocument] as unknown as DOMDocument);
}

function parseStylesheetsIfStale(cascade: Cascade): void {
	if (
		cascade[kStylesheetsDirty] ||
		getStyleSheetCount(cascade) !== cascade[kParsedStyleSheetCount]
	) {
		parseStylesheets(cascade);
	}
}

// Descendants and the hosted shadow tree too, since inheritance crosses
// that boundary.
function invalidateSubtree(
	cascade: Cascade,
	element: Element,
	notifyLayout = true,
): void {
	// A paint-only change cannot create or remove a pseudo-element, since
	// `content` is not a paint property, so the attachment pass is skipped
	// with layout.
	invalidateElementCaches(cascade, element, notifyLayout);
	if (notifyLayout) {
		attachPseudoElementsToElement(cascade, element);
	}
	for (const descendant of element.querySelectorAll("*")) {
		invalidateElementCaches(cascade, descendant, notifyLayout);
		if (notifyLayout) {
			attachPseudoElementsToElement(cascade, descendant);
		}
	}
	const root = element.shadowRoot;
	if (root) {
		for (const descendant of root.querySelectorAll("*")) {
			invalidateSubtree(cascade, descendant);
		}
	}
}

function invalidateElementCaches(
	cascade: Cascade,
	element: Element,
	notifyLayout = true,
): void {
	// The one place an element's computed style goes stale, so the one
	// place layout, which measured it under the style being dropped, is
	// notified, unless the caller knows nothing layout reads changed.
	if (notifyLayout) {
		cascade[kLayout].styleInvalidated(element);
	}
	// A computed style an author still holds is the one this cache handed
	// out, so it is told the cascade changed rather than merely dropped.
	const dropped = cascade[kComputedStyleCache].get(element);
	if (dropped) {
		cascade[kCurrentDeclarations].delete(dropped);
		storeTransitionFallback(cascade, element, "", dropped[kResolved]);
	}
	cascade[kComputedStyleCache].delete(element);
	const droppedPseudos = cascade[kPseudoElementStyleCache].get(element);
	if (droppedPseudos) {
		for (const [name, declaration] of droppedPseudos) {
			cascade[kCurrentDeclarations].delete(declaration);
			storeTransitionFallback(cascade, element, name, declaration[kResolved]);
		}
	}
	cascade[kPseudoElementStyleCache].delete(element);
	cascade[kCounterScopes].delete(element);
}

// Properties the painter reads and layout never does. A rule declaring
// only these moves nothing when it starts or stops matching.
const PAINT_ONLY_PROPERTIES = new Set([
	"color",
	"background",
	"background-color",
	"background-image",
	"background-position",
	"background-repeat",
	"background-size",
	"background-attachment",
	"background-clip",
	"background-origin",
	"border-color",
	"border-top-color",
	"border-right-color",
	"border-bottom-color",
	"border-left-color",
	"border-block-color",
	"border-inline-color",
	"outline",
	"outline-color",
	"outline-style",
	"outline-width",
	"outline-offset",
	"text-decoration",
	"text-decoration-line",
	"text-decoration-color",
	"text-decoration-style",
	"text-decoration-thickness",
	"font-weight",
	"font-style",
	"caret-color",
	"accent-color",
	"cursor",
	"visibility",
	"opacity",
	"user-select",
	"pointer-events",
]);

// Whether every rule an attribute change can turn on or off declares
// paint properties only. The style attribute can declare anything; a
// key no rule tests changes nothing at all.
function isPaintOnlyChange(
	cascade: Cascade,
	element: Element,
	name: string,
	oldValue: string | null,
): boolean {
	if (
		name === "style" || (cascade[kReachingStates] && STATE_ATTRIBUTES.has(name))
	) {
		return false;
	}
	const keys: string[] = [`[${name}]`];
	if (name === "class") {
		const before = oldValue === null ? [] : oldValue.split(/\s+/);
		for (const token of [...before, ...element.classList]) {
			if (token !== "") {
				keys.push(`.${token}`);
			}
		}
	} else if (name === "id") {
		for (const token of [oldValue, element.getAttribute("id")]) {
			if (token !== null && token !== "") {
				keys.push(`#${token}`);
			}
		}
	}
	for (const key of keys) {
		const properties = cascade[kKeyProperties].get(key);
		if (properties === undefined) {
			continue;
		}
		for (const property of properties) {
			if (!PAINT_ONLY_PROPERTIES.has(property)) {
				return false;
			}
		}
	}
	return true;
}

// The list's padding-left is a function of its items' markers and
// their ordinals. Only the NEAREST list is affected.
// TODO(box-tree): the gutter is a layout question answered here in the
// cascade. Computing it during block layout deletes this.
function mutationChangesListItems(mutation: MutationRecord): boolean {
	const target = mutation.target;
	if (
		target.nodeType === 1 &&
		((target as Element).tagName === "UL" ||
			(target as Element).tagName === "OL")
	) {
		return true;
	}
	for (const list of [mutation.addedNodes, mutation.removedNodes]) {
		for (const node of list) {
			if (node.nodeType !== 1) {
				continue;
			}
			const element = node as Element;
			if (element.tagName === "LI" || element.querySelector("li") !== null) {
				return true;
			}
		}
	}
	return false;
}

function invalidateEnclosingList(
	cascade: Cascade,
	target: Node,
): void {
	let element: Element | null =
		target.nodeType === cascade[kWindow].Node.ELEMENT_NODE
			? (target as Element)
			: target.parentElement;

	for (; element; element = element.parentElement) {
		if (element.tagName !== "UL" && element.tagName !== "OL") {
			continue;
		}

		invalidateElementCaches(cascade, element);
		cascade[kLayout].invalidate(element);
		for (const item of Array.from(element.children)) {
			invalidateElementCaches(cascade, item);
		}
		return;
	}
}

// Every style cached against the previous rule set is dropped. A
// declaration built before this parse was resolved against rules that
// no longer describe the cascade, and nothing else would tell it.
function parseStylesheets(
	cascade: Cascade,
): void {
	// Materializing a sheet's rules notifies the sheet once per rule, and
	// each notification asked for a parse from inside this one. The parse
	// under way reads those rules itself.
	if (cascade[kParsing]) {
		return;
	}
	cascade[kParsing] = true;
	try {
		parseStylesheetsNow(cascade);
	} finally {
		cascade[kParsing] = false;
	}
}

function parseStylesheetsNow(cascade: Cascade): void {
	const document = cascade[kDocument];
	cascade[kParsedRules] = [];
	cascade[kSelectorsReachSiblings] = false;
	cascade[kSelectorsReachAncestors] = false;
	cascade[kReachingClasses].clear();
	cascade[kKeyProperties].clear();
	cascade[kReachingIds].clear();
	cascade[kReachingAttributes].clear();
	cascade[kReachingStates] = false;
	cascade[kPseudoRulesByType] = new Map();
	cascade[kPseudoSubjectTags] = undefined;
	cascade[kCounterRulesExist] = false;
	cascade[kListItemRulesExist] = false;
	cascade[kScopedRulesExist] = false;
	cascade[kHasRulesExist] = false;
	cascade[kHoverRulesExist] = false;
	cascade[kStylesheetsDirty] = false;
	cascade[kLayerPaths] = [];
	cascade[kAnonymousLayers] = 0;
	cascade[kParsedStyleSheetCount] = getStyleSheetCount(cascade);

	// Origin ordering, not source order, keeps the UA sheet beneath every
	// author rule.
	parseStyleSheet(cascade, getUAStyleSheet(), undefined, true);

	for (const sheet of getDocumentStyleSheets(document)) {
		parseStyleSheet(cascade, sheet);
	}

	// Disconnected roots parse too. attach-populate-connect is the standard
	// order, and a scope-gated rule matches nothing until its tree renders.
	for (const root of cascade[kShadowRoots]) {
		for (const sheet of getShadowStyleSheets(root)) {
			parseStyleSheet(cascade, sheet, root);
		}
	}

	const layerRanks = rankLayers(cascade);
	for (const rule of cascade[kParsedRules]) {
		rule.layerRank =
			rule.layer === null
				? cascade[kUnlayeredRank]
				: (layerRanks.get(rule.layer) ?? cascade[kUnlayeredRank]);
	}

	sortRulesForCascade(cascade);
	cascade[kDropCache]();
	// Only now, because invalidated layout re-derives boxes by asking the
	// cascade for display, and the result must come from the rules just
	// parsed.
	cascade[kLayout].invalidate();
	attachPseudoElements(cascade);
}

// Origin first (UA below every author rule, later wins), then layer,
// then specificity, then the order the rules were read in.
function sortRulesForCascade(cascade: Cascade): void {
	const sourceOrder = new Map(
		cascade[kParsedRules].map((rule, index) => [rule, index] as const),
	);
	cascade[kParsedRules].sort((a, b) => {
		if (Boolean(a.uaOrigin) !== Boolean(b.uaOrigin)) {
			return a.uaOrigin ? -1 : 1;
		}
		if (a.layerRank !== b.layerRank) {
			return a.layerRank - b.layerRank;
		}
		if (a.specificity !== b.specificity) {
			return a.specificity < b.specificity ? -1 : 1;
		}
		return sourceOrder.get(a)! - sourceOrder.get(b)!;
	});
}

// Declare a layer and every layer its path nests inside.
function declareLayer(
	cascade: Cascade,
	outer: string | null,
	name: string,
): string {
	const path = outer === null ? name : `${outer}.${name}`;
	const segments = path.split(".");
	for (let depth = 1; depth <= segments.length; depth++) {
		const prefix = segments.slice(0, depth).join(".");
		if (!cascade[kLayerPaths].includes(prefix)) {
			cascade[kLayerPaths].push(prefix);
		}
	}
	return path;
}

// A layer's OWN rules sort after every layer nested inside it, the same
// relation unlayered rules have to layers, one level down. The important
// cascade reads the same order backwards.
function rankLayers(
	cascade: Cascade,
): Map<string, number> {
	const nested = new Map<string, string[]>();
	for (const path of cascade[kLayerPaths]) {
		const dot = path.lastIndexOf(".");
		const outer = dot === -1 ? "" : path.slice(0, dot);
		const siblings = nested.get(outer);
		if (siblings) {
			siblings.push(path);
		} else {
			nested.set(outer, [path]);
		}
	}
	const ranks = new Map<string, number>();
	let next = 0;
	const rank = (path: string): void => {
		for (const inner of nested.get(path) ?? []) {
			rank(inner);
		}
		if (path !== "") {
			ranks.set(path, next++);
		}
	};
	rank("");
	cascade[kUnlayeredRank] = next;
	return ranks;
}

// A disabled sheet and an unmatched @media contribute nothing.
// @supports contributes, since what this engine supports it renders. A
// grouping rule this walk has no branch for is walked THROUGH: a rule
// that applies too widely is one an author can see, and one that
// vanishes with the whole at-rule is not.
function parseStyleSheet(
	cascade: Cascade,
	container: CSSStyleSheet | CSSGroupingRule,
	scope?: Node,
	uaOrigin?: boolean,
	context: RuleContext = UNCONDITIONAL,
): void {
	if (container instanceof CSSStyleSheet) {
		if (container.disabled) {
			return;
		}
		if (!cascade.mediaQueryMatches(container.media.mediaText)) {
			return;
		}
	}
	for (const rule of container.cssRules) {
		if (rule instanceof CSSStyleRule) {
			parseStyleRule(cascade, rule, scope, uaOrigin, context);
		} else if (rule instanceof CSSMediaRule) {
			if (cascade.mediaQueryMatches(rule.conditionText)) {
				parseStyleSheet(cascade, rule, scope, uaOrigin, context);
			}
		} else if (rule instanceof CSSSupportsRule) {
			parseStyleSheet(cascade, rule, scope, uaOrigin, context);
		} else if (rule instanceof CSSLayerStatementRule) {
			// `@layer a, b;` declares layer order and nothing else.
			for (const name of rule.nameList) {
				declareLayer(cascade, context.layer, name);
			}
		} else if (rule instanceof CSSLayerBlockRule) {
			// An unnamed block opens a layer nothing else can name or reach.
			const layer = rule.name
				? declareLayer(cascade, context.layer, rule.name)
				: declareLayer(
					cascade,
					context.layer,
					` ${cascade[kAnonymousLayers]++}`,
				);
			parseStyleSheet(cascade, rule, scope, uaOrigin, {...context, layer});
		} else if (rule instanceof CSSScopeRule) {
			parseStyleSheet(cascade, rule, scope, uaOrigin, {
				...context,
				scopes: [...context.scopes, readScopeCondition(rule)],
			});
		} else if (rule instanceof CSSStartingStyleRule) {
			// `@starting-style` declares the style a box starts a transition
			// FROM, a moment nothing here gives a rule. A rule inside it would
			// have no moment to stop applying and would style the box
			// permanently, so it never reaches the cascade.
			continue;
		} else if (rule instanceof CSSGroupingRule) {
			parseStyleSheet(cascade, rule, scope, uaOrigin, context);
		}
	}
}

// Only `all` and `screen` name this screen, so `print`, `speech` and
// the deprecated types match nothing.
function mediaQueryNodeMatches(
	cascade: Cascade,
	query: MediaQueryNode,
): boolean {
	const type = (query.mediaType ?? "").toLowerCase();
	let matches = type === "" || type === "all" || type === "screen";
	if (matches && query.condition) {
		matches = mediaConditionMatches(cascade, query.condition);
	}
	return (query.modifier ?? "").toLowerCase() === "not" ? !matches : matches;
}

// A word where neither a joiner nor a negation belongs leaves the
// condition unevaluated, and so matching.
function mediaConditionMatches(
	cascade: Cascade,
	condition: MediaConditionNode,
): boolean {
	let matches: boolean | null = null;
	let disjunction = false;
	let negate = false;
	for (const part of getMediaConditionParts(condition)) {
		if (part.type === "Identifier") {
			const word = (part.name ?? "").toLowerCase();
			if (word === "not") {
				negate = true;
			} else if (word === "and" || word === "or") {
				disjunction = word === "or";
			} else {
				return true;
			}
			continue;
		}
		let operand = mediaOperandMatches(cascade, part);
		if (negate) {
			operand = !operand;
			negate = false;
		}
		matches =
			matches === null
				? operand
				: disjunction
					? matches || operand
					: matches && operand;
	}
	return matches ?? true;
}

function mediaOperandMatches(
	cascade: Cascade,
	part: MediaConditionNode,
): boolean {
	if (part.type === "Condition") {
		return mediaConditionMatches(cascade, part);
	}
	if (part.type === "Feature") {
		return mediaFeatureMatches(cascade, part);
	}
	if (part.type === "FeatureRange") {
		return mediaFeatureRangeMatches(cascade, part);
	}
	return true;
}

function getViewportLength(
	cascade: Cascade,
	dimension: string,
): number | null {
	if (dimension === "width") {
		return cascade[kWindow].innerWidth;
	}
	if (dimension === "height") {
		return cascade[kWindow].innerHeight;
	}
	return null;
}

// Null for a value outside the grammar, which leaves the feature
// unevaluated.
function getMediaLength(node: CSSNode | null | undefined): number | null {
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

function mediaComparison(
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

// A feature this engine does not track returns true, the permissive
// default, as does a value outside the grammar.
function mediaFeatureMatches(
	cascade: Cascade,
	feature: MediaConditionNode,
): boolean {
	const name = (feature.name ?? "").toLowerCase();
	const value = feature.value ?? null;
	// Motion reporting turns on whenever the document observes hover, so
	// the result is unconditional. A bare `(hover)` is the boolean context.
	if (name === "hover" || name === "any-hover") {
		return (
			value === null ||
			(value.type === "Identifier" &&
				(value.name ?? "").toLowerCase() === "hover")
		);
	}
	if (value === null) {
		return true;
	}
	const bound =
		name.startsWith("min-")
			? "min"
			: name.startsWith("max-")
				? "max"
				: null;
	const actual = getViewportLength(
		cascade,
		bound === null ? name : name.slice(4),
	);
	const length = getMediaLength(value);
	if (actual === null || length === null) {
		return true;
	}
	if (bound === "min") {
		return actual >= length;
	}
	if (bound === "max") {
		return actual <= length;
	}
	return actual === length;
}

// The feature name is in the middle of a two-sided range, and opposite
// the value in a one-sided one.
function mediaFeatureRangeMatches(
	cascade: Cascade,
	range: MediaConditionNode,
): boolean {
	const named = (node: CSSNode | null | undefined): string =>
		node?.type === "Identifier" ? (node.name ?? "").toLowerCase() : "";
	if (range.right) {
		const actual = getViewportLength(cascade, named(range.middle));
		const low = getMediaLength(range.left);
		const high = getMediaLength(range.right);
		if (actual === null || low === null || high === null) {
			return true;
		}
		return (
			mediaComparison(low, range.leftComparison, actual) &&
			mediaComparison(actual, range.rightComparison, high)
		);
	}
	const leftName = named(range.left);
	const actual = getViewportLength(cascade, leftName || named(range.middle));
	const length = getMediaLength(leftName ? range.middle : range.left);
	if (actual === null || length === null) {
		return true;
	}
	return leftName
		? mediaComparison(actual, range.leftComparison, length)
		: mediaComparison(length, range.leftComparison, actual);
}

function readScopeCondition(rule: CSSScopeRule): ScopeCondition {
	const namespaces = getSheetNamespaces(rule.parentStyleSheet);
	const start = rule.start;
	const owner = rule.parentStyleSheet?.ownerNode ?? null;
	return {
		roots: start === null ? null : compileSelectors(start, {namespaces}),
		rootsInOuter:
			start === null
				? []
				: compileSelectors(start, {namespaces, relative: true}),
		limits:
			rule.end
				? compileSelectors(rule.end, {namespaces, relative: true})
				: [],
		owner: owner ? owner.parentElement : null,
	};
}

function parseStyleRule(
	cascade: Cascade,
	styleRule: CSSStyleRule,
	scope?: Node,
	uaOriginSheet?: boolean,
	context: RuleContext = UNCONDITIONAL,
): void {
	// Each selector of the list is matched and weighed on its own.
	// `#a::before, #b` is one pseudo rule and one ordinary rule.
	const block = getDeclarationBlock(styleRule.style);
	const namespaces = getSheetNamespaces(styleRule.parentStyleSheet);
	for (const selector of splitSelectorList(styleRule.selectorText)) {
		parseSelector(
			cascade,
			selector,
			block,
			scope,
			uaOriginSheet,
			namespaces,
			context,
		);
	}
}

// A key reaches descendants two ways: tested on a NON-SUBJECT compound,
// or on a rule declaring an INHERITED property. In neither position, it
// changes nothing but the element's own box.
function indexReachingKeys(
	cascade: Cascade,
	reading: SelectorReading,
	declarations: Record<string, string>,
): void {
	let inherits = false;
	for (const property in declarations) {
		// `display` is not inherited but reaches descendants anyway. A flex
		// container isBlockified its children (css-display-3 §2.7).
		if (
			property === "all" ||
			property === "display" ||
			property.startsWith("--") ||
			INHERITED_PROPERTIES.has(property)
		) {
			inherits = true;
			break;
		}
	}
	const compounds = reading.compounds;
	const names = Object.keys(declarations);
	for (const keys of compounds) {
		for (const key of [
			...keys.classes.map((name) => `.${name}`),
			...keys.ids.map((name) => `#${name}`),
			...keys.attributes.map((name) => `[${name}]`),
		]) {
			let properties = cascade[kKeyProperties].get(key);
			if (properties === undefined) {
				properties = new Set<string>();
				cascade[kKeyProperties].set(key, properties);
			}
			for (const name of names) {
				properties.add(name);
			}
		}
	}
	const last = inherits ? compounds.length : compounds.length - 1;
	for (let i = 0; i < last; i++) {
		const keys = compounds[i];
		for (const name of keys.classes) {
			cascade[kReachingClasses].add(name);
		}
		for (const name of keys.ids) {
			cascade[kReachingIds].add(name);
		}
		for (const name of keys.attributes) {
			cascade[kReachingAttributes].add(name);
		}
		if (keys.states) {
			cascade[kReachingStates] = true;
		}
	}
}

// A selector this engine cannot read compiles to neither reading, and
// the rule styles nothing.
function compileRuleSelector(
	selector: string,
	namespaces: SelectorNamespaces | undefined,
	scopes: readonly ScopeCondition[] | undefined,
): Pick<ParsedCSSRule, "matcher" | "relativeMatcher"> {
	const read = (relative: boolean): CompiledSelector | null => {
		try {
			return compileSelector(selector, {namespaces, relative});
		} catch (_err) {
			// Only the shape of a sheet's selector was checked when the rule
			// was parsed. A prefix no `@namespace` declared is rejected here.
			return null;
		}
	};
	return {matcher: read(false), relativeMatcher: scopes ? read(true) : null};
}

function parseSelector(
	cascade: Cascade,
	selector: string,
	block: DeclarationBlock,
	scope?: Node,
	uaOriginSheet?: boolean,
	getSheetNamespaces: SelectorNamespaces = NO_NAMESPACES,
	context: RuleContext = UNCONDITIONAL,
): void {
	const {declarations, important, order} = block;
	// Only a duration or delay can make a transition run, so the property
	// list alone does not open the sticky gate.
	if (
		declarations["transition-duration"] ||
		declarations["transition-delay"]
	) {
		cascade[kTransitionsExist] = true;
	}
	const layer = context.layer;
	// A :has() rule reads DOWN the tree, the one relational direction the
	// per-target invalidation cannot see, so the flag enables the ancestor
	// sweep only for documents that need it.
	if (selector.includes(":has(")) {
		cascade[kHasRulesExist] = true;
	}
	if (selector.includes(":hover")) {
		cascade[kHoverRulesExist] = true;
	}
	let scopes: readonly ScopeCondition[] | undefined;
	if (context.scopes.length > 0) {
		scopes = context.scopes;
		cascade[kScopedRulesExist] = true;
	}
	let namespaces: SelectorNamespaces | undefined;
	if (getSheetNamespaces !== NO_NAMESPACES) {
		namespaces = getSheetNamespaces;
	}
	if (
		selector.includes("|") &&
		!namespacePrefixesDeclared(selector, getSheetNamespaces)
	) {
		return;
	}
	if (SIBLING_SELECTOR.test(selector)) {
		cascade[kSelectorsReachSiblings] = true;
	}
	if (selector.includes(":has")) {
		cascade[kSelectorsReachAncestors] = true;
	}
	const reading = readSelector(selector);
	indexReachingKeys(cascade, reading, declarations);
	if (
		declarations["counter-reset"] ||
		declarations["counter-increment"] ||
		declarations["content"]?.includes("counter")
	) {
		cascade[kCounterRulesExist] = true;
	}
	const specificity = reading.specificity;
	const uaOrigin = Boolean(
		uaOriginSheet || (scope != null && isUAShadowTree(scope)),
	);
	// The UA sheet's own `li { display: list-item }` is covered by the tag
	// tests that read this flag. Set by the UA sheet too, the flag was
	// always on, and every element paid for a ::marker it could not have.
	if (!uaOrigin && declarations["display"] === "list-item") {
		cascade[kListItemRulesExist] = true;
	}

	const subjectTag = reading.subjectTag;
	// A :host rule is tried against the host as well as the tree's
	// elements.
	const reachesHost = scope !== undefined && selector.includes(":host");

	// Any pseudo-element, not just the ones this engine gives a box. A rule
	// for `::highlight(x)` still has to be visible through
	// getComputedStyle.
	const pseudoMatch = selector.match(
		/^(.*?)(::[-\w]+(?:\([^)]*\))?)((?::[-\w]+(?:\([^)]*\))?)*)$/,
	);

	if (pseudoMatch) {
		const [, baseSelector, pseudoElement] = pseudoMatch;
		const rule: ParsedCSSRule = {
			// A pseudo-element written with no originating selector originates
			// on every element, which is what `*` means.
			...compileRuleSelector(baseSelector.trim() || "*", namespaces, scopes),
			subjectTag: reading.subjectTag,
			declarations,
			important,
			order,
			specificity,
			pseudoElement,
			scope,
			uaOrigin,
			reachesHost,
			layer,
			layerRank: 0,
			scopes,
		};
		cascade[kParsedRules].push(rule);
		const byType = cascade[kPseudoRulesByType].get(pseudoElement);
		if (byType) {
			byType.push(rule);
		} else {
			cascade[kPseudoRulesByType].set(pseudoElement, [rule]);
		}
	} else {
		cascade[kParsedRules].push({
			...compileRuleSelector(selector, namespaces, scopes),
			subjectTag,
			declarations,
			important,
			order,
			specificity,
			scope,
			uaOrigin,
			reachesHost,
			layer,
			layerRank: 0,
			scopes,
		});
	}
}

function getMatchingRules(
	cascade: Cascade,
	element: Element,
): ParsedCSSRule[] {
	// A UA shadow part IS the element its part pseudo styles. The host's
	// ::placeholder rules cascade onto the [part="placeholder"] span.
	const partPseudo = getPartPseudo(element);
	const root = element.getRootNode();
	const rootNode = root as unknown as Node;
	const shadowHost = isShadowRoot(root) ? root.host : null;
	const partNames = (element.getAttribute("part") ?? "")
		.split(/\s+/)
		.filter(Boolean);
	const matched = cascade[kParsedRules].filter((rule) => {
		if (rule.pseudoElement) {
			// ::part(name) matches the shadow's HOST, and its declarations
			// cascade onto the part element. This is the standard CSS Shadow
			// Parts crossing.
			const partArg = rule.pseudoElement.match(/^::part\((.+)\)$/);
			if (partArg) {
				return (
					shadowHost !== null &&
					partNames.includes(partArg[1].trim()) &&
					isRuleMatch(shadowHost, rule)
				);
			}
			return (
				partPseudo !== null &&
				shadowHost !== null &&
				rule.pseudoElement === partPseudo &&
				isRuleMatch(shadowHost, rule)
			);
		}
		return isRuleMatch(element, rule, rootNode);
	});
	// Scope proximity sorts between specificity and order of appearance
	// (css-cascade-6 §3.1.3), and unlike either it depends on THIS element.
	// The sort is stable, so a comparison that only compares proximity
	// leaves every other tier as it was.
	if (!cascade[kScopedRulesExist]) {
		return matched;
	}
	const proximity = new Map(
		matched.map(
			(rule) =>
				[
					rule,
					rule.scopes ? getScopeProximity(element, rule) : UNSCOPED,
				] as const,
		),
	);
	return matched.sort((a, b) => {
		if (Boolean(a.uaOrigin) !== Boolean(b.uaOrigin)) {
			return 0;
		}
		if (a.layerRank !== b.layerRank) {
			return 0;
		}
		if (a.specificity !== b.specificity) {
			return 0;
		}
		return proximity.get(b)! - proximity.get(a)!;
	});
}

function ruleSelectorMatches(
	element: Element,
	rule: ParsedCSSRule,
	root?: Element,
): boolean {
	// From a scoping root, use the relative reading. Anywhere else, the
	// plain one.
	const matcher = root === undefined ? rule.matcher : rule.relativeMatcher;
	if (matcher === null) {
		return false;
	}
	return isSelectedBy(element, matcher, root ?? element, ruleShadow(rule));
}

function selectForRule(root: Node, rule: ParsedCSSRule): Element[] {
	if (rule.matcher === null) {
		return [];
	}
	return selectAllCompiled(root as unknown as DOMNode, rule.matcher, {
		scope: root as unknown as DOMNode,
		shadow: ruleShadow(rule) as DOMNode | null,
	}) as unknown as Element[];
}

function ruleShadow(rule: ParsedCSSRule): Node | null {
	return (rule.reachesHost ? rule.scope : null) ?? null;
}

function matchesRule(element: Element, rule: ParsedCSSRule): boolean {
	if (!rule.scopes) {
		return ruleSelectorMatches(element, rule);
	}
	return getScopingRoot(element, rule) !== null;
}

// Only called for a rule that matches. One out of scope everywhere has
// already been filtered out.
function getScopeProximity(
	element: Element,
	rule: ParsedCSSRule,
): number {
	const root = getScopingRoot(element, rule);
	if (!root) {
		return UNSCOPED;
	}
	let generations = 0;
	for (
		let node: Element | null = element;
		node && node !== root;
		node = node.parentElement
	) {
		generations++;
	}
	return generations;
}

// Read outermost first, each condition taking the HIGHEST root it can
// (which constrains the roots inside it least). The innermost takes the
// NEAREST, which the selector and proximity are measured from.
function getScopingRoot(element: Element, rule: ParsedCSSRule): Element | null {
	const conditions = rule.scopes!;
	let outer: Element | null = null;
	for (let index = 0; index < conditions.length; index++) {
		const condition = conditions[index];
		const innermost = index === conditions.length - 1;
		let found: Element | null = null;
		for (
			let candidate: Element | null = element;
			candidate;
			candidate = candidate.parentElement
		) {
			if (outer && candidate !== outer && !outer.contains(candidate)) {
				break;
			}
			if (!isScopeRootMatch(candidate, condition, outer)) {
				continue;
			}
			if (!isInScope(element, candidate, condition)) {
				continue;
			}
			if (innermost) {
				if (!ruleSelectorMatches(element, rule, candidate)) {
					continue;
				}
				// The nearest root the rule reaches the element from.
				found = candidate;
				break;
			}
			found = candidate;
		}
		if (!found) {
			return null;
		}
		outer = found;
	}
	return outer;
}

// Author shadow trees are not eligible. Their parts are theirs to style
// from inside.
function getPartPseudo(element: Element): string | null {
	const root = element.getRootNode();
	if (isUAShadowTree(root)) {
		const part = element.getAttribute("part");
		if (part === "placeholder" || part === "selection") {
			return `::${part}`;
		}
	}
	return null;
}

// A rule matches only elements of the tree its stylesheet belongs to,
// plus the one deliberate crossing: :host.
function isRuleMatch(
	element: Element,
	rule: ParsedCSSRule,
	elementRoot?: Node,
): boolean {
	// The cheapest rejections come first. One identity check rejects a
	// UA shadow tree's whole sheet for every element outside it.
	const root = elementRoot ?? element.getRootNode();
	if (rule.scope !== undefined && rule.scope !== root) {
		// A :host rule's subject is outside the tree it was written in.
		if (
			!rule.reachesHost ||
			element !== (rule.scope as ShadowRoot).host
		) {
			return false;
		}
	} else if (rule.subjectTag !== undefined && !rule.reachesHost) {
		const local = element.localName;
		// A foreign element's local name keeps its case (feGaussianBlur), so
		// the rejection fires only when neither reading matches. The matcher
		// decides the case sensitivity a selector really has.
		if (local !== rule.subjectTag && local.toLowerCase() !== rule.subjectTag) {
			return false;
		}
	}
	if (rule.scope) {
		return matchesRule(element, rule);
	}
	// UA document rules apply in EVERY tree scope, as a browser's own UA
	// sheet styles shadow trees.
	if (rule.uaOrigin) {
		return matchesRule(element, rule);
	}
	// Author document rules match everything outside shadow trees,
	// detached elements included, because styles resolve before insertion.
	return !isShadowRoot(root) && matchesRule(element, rule);
}

function computePseudoElementStyle(
	cascade: Cascade,
	element: Element,
	pseudoElement: string,
): Record<string, string> {
	const pseudoRoot = element.getRootNode() as unknown as Node;
	const matchingRules = cascade[kParsedRules].filter((rule) => {
		if (rule.pseudoElement !== pseudoElement) {
			return false;
		}
		return isRuleMatch(element, rule, pseudoRoot);
	});

	// A pseudo-element's declarations are a flat record, not a per-property
	// cascade, so a flow-relative declaration fills BOTH names of its slot
	// as it lands, and a later rule declaring either name overwrites in
	// turn.
	const computedStyle: Record<string, string> = {};
	let direction: string | null = null;
	for (const rule of matchingRules) {
		const names = Object.keys(rule.declarations).sort(
			(a, b) => (rule.order[a] ?? 0) - (rule.order[b] ?? 0),
		);
		for (const name of names) {
			const value = rule.declarations[name];
			computedStyle[name] = value;
			if (
				!LOGICAL_TO_PHYSICAL.ltr.has(name) &&
				!PHYSICAL_TO_LOGICAL.has(name)
			) {
				continue;
			}
			direction ??= cascade
				.declarationFor(element)
				.getComputedValue("direction");
			for (const other of getSlotNames(name, direction)) {
				computedStyle[other] = value;
			}
		}
	}

	return computedStyle;
}

function getPseudoContent(
	cascade: Cascade,
	hostElement: Element,
	pseudoType: string,
): string | null {
	const styles = computePseudoElementStyle(cascade, hostElement, pseudoType);
	let content = styles.content;

	if (pseudoType === "::marker") {
		const computedStyle = cascade.declarationFor(hostElement);
		const display = computedStyle.getComputedValue("display");

		if (display === "list-item") {
			const listStylePosition =
				computedStyle.getComputedValue("list-style-position") || "outside";

			if (listStylePosition === "outside") {
				return null;
			}

			if (!content || content === "none" || content === "normal") {
				content = getDefaultMarkerContent(hostElement) ?? content;
			}
		}
	}

	if (!content || content === "none" || content === "normal") {
		return null;
	}

	const textContent = unquoteContent(content);

	return cascade[kResolveCounterFunction](hostElement, textContent);
}

function attachPseudoElements(
	cascade: Cascade,
): void {
	// Preserve identity, never clear wholesale. Layout keys a
	// pseudo-element's boxes by node instance, and a fresh node per sync
	// orphans every mapped one.
	if (!cascade[kDocument].documentElement) {
		return;
	}
	for (const element of [...cascade[kPseudoHosts]]) {
		if (element.isConnected && pseudoElementCount(element) > 0) {
			attachPseudoElementsToElement(cascade, element);
		} else {
			cascade[kPseudoHosts].delete(element);
		}
	}

	attachPseudoElementsToDocument(cascade);
}

function getPseudoSubjects(
	cascade: Cascade,
): Set<string> | null {
	if (cascade[kPseudoSubjectTags] !== undefined) {
		return cascade[kPseudoSubjectTags];
	}
	if (cascade[kCounterRulesExist] || cascade[kListItemRulesExist]) {
		return (cascade[kPseudoSubjectTags] = null);
	}
	// A list carries the one counter no rule declares, and its items carry
	// the markers that counter numbers.
	const tags = new Set(["OL", "UL", "LI"]);
	// Only the pseudo-elements this function attaches. ::marker reaches
	// list items, handled above, and ::placeholder, ::selection and ::part
	// live on nodes the UA shadow tree trees already hold.
	for (const type of ["::before", "::after"]) {
		for (const rule of cascade[kPseudoRulesByType].get(type) ?? []) {
			if (!rule.subjectTag) {
				return (cascade[kPseudoSubjectTags] = null);
			}
			tags.add(rule.subjectTag.toUpperCase());
		}
	}
	return (cascade[kPseudoSubjectTags] = tags);
}

// A few matches() calls instead of building the full pseudo-element
// declaration just to discover `content` is "none". Over-matching is
// safe. The win is the early false for a document with no pseudo rules
// beyond the UA button brackets.
function pseudoRuleCouldMatch(
	cascade: Cascade,
	element: Element,
	pseudoType: string,
): boolean {
	if (pseudoType === "::marker") {
		// Markers exist only on display:list-item boxes.
		return (
			element.tagName === "LI" ||
			cascade[kListItemRulesExist] ||
			(element.getAttribute("style") ?? "").includes("list-item")
		);
	}
	const rules = cascade[kPseudoRulesByType].get(pseudoType);
	if (!rules) {
		return false;
	}
	for (const rule of rules) {
		if (ruleSelectorMatches(element, rule)) {
			return true;
		}
	}
	return false;
}

function attachPseudoElementToElementForType(
	cascade: Cascade,
	element: Element,
	pseudoType: string,
): void {
	// An attached pseudo-element still takes the full path, so a rule that
	// STOPPED matching removes it.
	if (
		!pseudoRuleCouldMatch(cascade, element, pseudoType) &&
		!pseudoElement(element, pseudoType)
	) {
		return;
	}

	// counter() in a content value reads these, so they must exist first.
	initializeCounters(cascade, element);

	if (pseudoType === "::marker") {
		const computedStyle = cascade.declarationFor(element);
		const display = computedStyle.getComputedValue("display");
		const listStylePosition =
			computedStyle.getComputedValue("list-style-position") || "outside";

		if (display !== "list-item") {
			return;
		}

		if (listStylePosition === "outside") {
			removePseudoElement(cascade, element, "::marker");
			return;
		}
	}

	const content = shouldCreatePseudoElement(cascade, element, pseudoType)
		? getPseudoContent(cascade, element, pseudoType)
		: null;
	const existing = pseudoElement<Element>(element, pseudoType);

	// Node identity is stable. Layout keys the pseudo-element's boxes by
	// instance, and a fresh node per attach orphans the mapped one (a
	// positioned button's ::after glyph simply vanished). Only the text
	// changes.
	if (content === null) {
		if (existing) {
			removePseudoElement(cascade, element, pseudoType);
		}
		return;
	}
	if (existing) {
		const text = existing.firstChild as Text;
		if (text.data !== content) {
			text.data = content;
			cascade[kLayout].invalidate(element);
		}
		return;
	}
	const node = ensurePseudoElement<Element>(element, pseudoType);
	cascade[kPseudoHosts].add(element);
	node.appendChild(element.ownerDocument.createTextNode(content));
	cascade[kLayout].invalidate();
	cascade[kLayout].invalidate(element);
}

function removePseudoElement(
	cascade: Cascade,
	element: Element,
	pseudoType: string,
): void {
	if (!pseudoElement(element, pseudoType)) {
		return;
	}
	dropPseudoElement(element, pseudoType);
	cascade[kLayout].invalidate();
	cascade[kLayout].invalidate(element);
}

const CSSOM_WINDOW_GLOBALS = {
	CSSStyleSheet,
	StyleSheetList,
	CSSRuleList,
	CSSRule,
	CSSStyleRule,
	CSSGroupingRule,
	CSSConditionRule,
	CSSMediaRule,
	CSSSupportsRule,
	CSSImportRule,
	CSSKeyframesRule,
	CSSKeyframeRule,
	CSSNamespaceRule,
	CSSPageRule,
	CSSFontFaceRule,
	CSSCounterStyleRule,
	CSSPropertyRule,
	CSSFontPaletteValuesRule,
	CSSFontFeatureValuesRule,
	CSSContainerRule,
	CSSLayerBlockRule,
	CSSLayerStatementRule,
	CSSScopeRule,
	CSSStartingStyleRule,
	MediaList,
	CSSStyleDeclaration,
	CSSStyleProperties,
	CSS: CSSNamespace,
};

function setupInvalidationHooks(
	cascade: Cascade,
): void {
	// An error thrown out of a constructed sheet belongs to this realm.
	cssomWindow = cascade[kWindow];
	Object.assign(cascade[kWindow], CSSOM_WINDOW_GLOBALS);
}

// Each identifier opens a pair. A counter written without a number
// takes `fallback`: 0 for a reset, 1 for an increment.
function getCounterPairs(
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

function parseCounterReset(scope: CounterScope, counterReset: string): void {
	for (const [name, value] of getCounterPairs(counterReset, 0)) {
		scope.counters[name] = value;
	}
}

function parseCounterIncrement(
	cascade: Cascade,
	scope: CounterScope,
	counterIncrement: string,
): void {
	for (const [name, increment] of getCounterPairs(counterIncrement, 1)) {
		incrementCounter(cascade, scope, name, increment);
	}
}

function incrementCounter(
	cascade: Cascade,
	scope: CounterScope,
	counterName: string,
	increment: number,
): void {
	// A list item counts from the item before it, not from its scope.
	// Siblings share one list, and each scope only ever holds its own
	// element's value.
	if (counterName === "list-item" && scope.element.tagName === "LI") {
		const currentValue = getListItemCounterValue(cascade, scope.element);
		scope.counters[counterName] = currentValue + increment;
	} else {
		const currentValue = getCounterValueInScope(scope.parent, counterName);
		scope.counters[counterName] = currentValue + increment;
	}
}

// The list's start value plus the items before this one. Siblings
// share one counter, and each scope holds only its own element's value.
function getListItemCounterValue(
	cascade: Cascade,
	element: Element,
): number {
	let parent = element.parentElement;
	while (parent && parent.tagName !== "OL" && parent.tagName !== "UL") {
		parent = parent.parentElement;
	}

	if (!parent) {
		return 0;
	}

	// Items initialize in document order, so the nearest earlier item that
	// has a scope already holds the count up to itself. Counting from the
	// list's start for every item made a long list quadratic.
	let uncounted = 0;
	for (
		let previous = element.previousElementSibling;
		previous !== null;
		previous = previous.previousElementSibling
	) {
		if (previous.tagName !== "LI") {
			continue;
		}
		const scope = cascade[kCounterScopes].get(previous as Element);
		if (scope !== undefined && "list-item" in scope.counters) {
			return scope.counters["list-item"] + uncounted;
		}
		uncounted++;
	}
	const parentScope = cascade[kCounterScopes].get(parent);
	return (parentScope?.counters["list-item"] ?? 0) + uncounted;
}

function getCounterValueInScope(
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
function formatCounterValue(value: number, style: string): string {
	return BULLET_MARKERS[style] ?? formatOrdinal(value, style);
}

/** The element's inline style declaration, one per element for its lifetime. */
export function getInlineStyle(
	element: Element,
): globalThis.CSSStyleDeclaration {
	let style = inlineStyles.get(element);
	if (!style) {
		style = new CSSStyleProperties({element});
		inlineStyles.set(element, style);
	}
	return style as unknown as globalThis.CSSStyleDeclaration;
}

/** The sheets a tree declares, as document.styleSheets lists them. */
export function getStyleSheets(
	tree: Document | ShadowRoot,
): globalThis.StyleSheetList {
	const list = new StyleSheetList(getDeclaredStyleSheets(tree));
	syncIndexed(list);
	return list as unknown as globalThis.StyleSheetList;
}

/** The tree's adopted sheets, as the observable array the setter replaces. */
export function getAdoptedStyleSheets(tree: Node): globalThis.CSSStyleSheet[] {
	let list = adoptedSheets.get(tree);
	if (!list) {
		adoptedSheets.set(tree, (list = []));
	}
	return observableAdopted(tree, list) as unknown as globalThis.CSSStyleSheet[];
}

export function adoptStyleSheets(tree: Node, sheets: unknown): void {
	adopt(tree, sheets);
	getTreeCascade(tree)?.syncStylesheets();
}

/** A style element's sheet. Null outside a tree, as in a browser. */
export function styleElementSheet(
	element: Element,
): globalThis.CSSStyleSheet | null {
	return element.parentNode
		? (getSheet(element) as unknown as globalThis.CSSStyleSheet)
		: null;
}

/**
 * Called from the DOM's own attribute change algorithms, so classList,
 * className and the parser invalidate the same way setAttribute does.
 */
export function styleAttributeChanged(
	element: Element,
	localName: string,
): void {
	if (localName === "style" || localName === "class" || localName === "id") {
		const cascade = documentCascades.get(element.ownerDocument as object);
		if (cascade) {
			invalidateElement(cascade, element);
		}
	}
}

/**
 * The layout engine moved geometry, so the used values measured under it are
 * stale.
 */
export function usedValuesChanged(document: object): void {
	const cascade = documentCascades.get(document);
	if (cascade !== undefined) {
		cascade[kUsedStale] = true;
	}
}

/** A shadow root registers with the cascade the moment it attaches. */
export function styleShadowAttached(root: ShadowRoot): void {
	documentCascades
		.get((root.host as Element).ownerDocument as object)
		?.registerShadowRoot(root);
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
export interface TrackRepeat {
	count: number | "auto-fill" | "auto-fit";
	tracks: TrackListTrack[];

	/** Line names written after the repeat group's last track. */
	endNames: string[];
}

export type TrackListPart =
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

export const AUTO_PLACEMENT: GridPlacement = {
	span: false,
	index: null,
	name: null,
};

/** The `auto` track size: the initial value of grid-auto-rows/columns. */
export const AUTO_TRACK: TrackSize = {min: {kind: "auto"}, max: {kind: "auto"}};

export const EMPTY_TRACK_LIST: TrackList = {parts: [], endNames: []};

// Rejected rather than approximated. `subgrid` takes its tracks from an
// ancestor grid, so a grid's sizing could no longer be decided from its
// own box, and `masonry` is not a grid in its second axis. A track list
// naming either falls back to `none`, which is what a browser that does
// not implement them does.
const REFUSED_GRID_VALUES = new Set(["subgrid", "masonry"]);

// px and ch both measure one cell, and nothing else does.
function trackCells(node: CSSNode): number | null {
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

function parseTrackBreadth(node: CSSNode): TrackBreadth | null {
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

function parseTrackSize(node: CSSNode): TrackSize | null {
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

function getBracketNames(node: CSSNode): string[] {
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
			node.type === "Function" &&
			(node.name ?? "").toLowerCase() === "repeat"
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

function parseTrackRepeat(node: CSSNode): TrackRepeat | null {
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
export function parseTrackSizeList(
	value: string,
): TrackSize[] | null {
	return memoizeGridValue("track-size-list", value, parseTrackSizeListValue);
}

function parseTrackSizeListValue(
	value: string,
): TrackSize[] | null {
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
export function parseGridPlacement(
	value: string,
): GridPlacement | null {
	return memoizeGridValue("placement", value, parseGridPlacementValue);
}

function parseGridPlacementValue(
	value: string,
): GridPlacement | null {
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
