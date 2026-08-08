/**
 * CSS System for Terminal DOM
 *
 * This module provides a way to override window.getComputedStyle() with terminal-appropriate
 * CSS property resolution. The core TermDOM class uses this to provide a custom CSS implementation.
 */

import {type DOMWindow} from "jsdom";
import * as cssTree from "css-tree";
import {parseCSSColor} from "./color.js";
import {stringWidth} from "./text.js";
import {
	attachPseudoElement,
	compositionParentElement,
	compositionShadowRoot,
	getAllPseudoElements,
	getPseudoElement,
	removePseudoElement,
	invalidateComposition,
	invalidateStructure,
} from "./composition.js";
import {type LayoutEngine} from "./layout.js";
import {
	CSS_INITIAL_VALUES,
	CSS_LONGHANDS,
	CSS_PROPERTIES,
	CSS_SHORTHANDS,
} from "./cssproperties.js";
import {
	INHERITED_PROPERTIES,
	INITIAL_KEYWORDS,
	UA_DOCUMENT_STYLES,
	expandShorthands,
	getElementDefaults,
	getInitialStyle,
} from "./useragent.js";

/**
 * Helper to get computed style property value for an element.
 * Works with both regular DOM and JSDOM environments.
 */
export function getPropertyValue(element: Element, property: string): string {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element does not have an associated window");
	}
	return window.getComputedStyle(element).getPropertyValue(property);
}

/**
 * invalidationScopeFor, reachable from the layout engine, which holds a
 * window but no StyleManager -- the same registry hop getListGutterWidth
 * makes from inside the cascade. Null when no manager is registered; the
 * caller falls back to rebuilding from body.
 */
export function selectorInvalidationScope(element: Element): Element | null {
	const window = element.ownerDocument?.defaultView;
	const styleManager = window ? styleManagers.get(window) : undefined;
	return styleManager ? styleManager.invalidationScopeFor(element) : null;
}

export function parseUnitValue(
	value: string,
): number | {percentage: number} | null {
	if (!value) {
		return null;
	}

	// Handle values that start with a digit or are "0" variants
	if (!/^[\d.]/.test(value)) {
		return null;
	}

	if (value.endsWith("%")) {
		const num = parseFloat(value.slice(0, -1));
		if (isNaN(num)) return null;
		return {percentage: num};
	}

	// Handle "ch" units (character width) - treat as character units
	if (value.endsWith("ch")) {
		const num = parseFloat(value.slice(0, -2));
		if (isNaN(num)) return null;
		return num; // In TermDOM, 1ch = 1 character
	}

	const num = parseFloat(value);
	return isNaN(num) ? null : num;
}

/**
 * CSS Box Model representation for layout calculations
 */
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

/**
 * Parse CSS box model properties from an element's computed style
 */

/**
 * Lengths that may be negative: margins (and offsets). parseUnitValue's
 * digit gate is the right default -- negative widths, paddings and borders
 * are invalid CSS and must stay rejected -- so the sign lives in a separate
 * parser the margin paths opt into.
 */
export function parseSignedUnitValue(
	value: string,
): ReturnType<typeof parseUnitValue> {
	const trimmed = value?.trim();
	if (trimmed?.startsWith("-")) {
		const inner = parseUnitValue(trimmed.slice(1));
		if (typeof inner === "number") return -inner;
		if (inner && "percentage" in inner) {
			return {percentage: -inner.percentage};
		}
		return null;
	}
	return parseUnitValue(value);
}

/**
 * Border widths, keywords included: thin/medium/thick all land on one cell
 * -- the grid cannot grade them, and medium is the initial that a bare
 * `border: solid` carries, which must be a VISIBLE border as in a browser.
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

export function getBoxModel(element: Element): BoxModel {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element does not have an associated window");
	}
	const computedStyle = window.getComputedStyle(element);

	// Parse explicit width/height
	const widthValue = parseUnitValue(computedStyle.getPropertyValue("width"));
	const heightValue = parseUnitValue(computedStyle.getPropertyValue("height"));

	// Parse padding
	const paddingTop = parseUnitValue(
		computedStyle.getPropertyValue("padding-top"),
	);
	const paddingRight = parseUnitValue(
		computedStyle.getPropertyValue("padding-right"),
	);
	const paddingBottom = parseUnitValue(
		computedStyle.getPropertyValue("padding-bottom"),
	);
	const paddingLeft = parseUnitValue(
		computedStyle.getPropertyValue("padding-left"),
	);

	// Parse margin
	const marginTop = parseSignedUnitValue(
		computedStyle.getPropertyValue("margin-top"),
	);
	const marginRight = parseSignedUnitValue(
		computedStyle.getPropertyValue("margin-right"),
	);
	const marginBottom = parseSignedUnitValue(
		computedStyle.getPropertyValue("margin-bottom"),
	);
	const marginLeft = parseSignedUnitValue(
		computedStyle.getPropertyValue("margin-left"),
	);

	// Parse border. The USED width is 0 when the side's style is none or
	// hidden (css-backgrounds §3.3), however wide the width property says --
	// `border-style: none` must release the space, not just the glyphs.
	const borderWidthFor = (side: string) => {
		const style = computedStyle.getPropertyValue(`border-${side}-style`);
		if (!style || style === "none" || style === "hidden") return null;
		return parseBorderWidthValue(
			computedStyle.getPropertyValue(`border-${side}-width`),
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

/**
 * Properties whose every numeric component must carry a unit. CSS accepts
 * a bare `0` for any length, and accepts bare numbers for the properties
 * that are typed as numbers (line-height, z-index, flex-grow, order,
 * opacity, font-weight) -- those are NOT listed here.
 */
const LENGTH_PROPERTIES = new Set([
	"padding",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"margin",
	"margin-top",
	"margin-right",
	"margin-bottom",
	"margin-left",
	"inset",
	"top",
	"right",
	"bottom",
	"left",
	"width",
	"height",
	"min-width",
	"max-width",
	"min-height",
	"max-height",
	"gap",
	"column-gap",
	"row-gap",
	"border-width",
	"border-top-width",
	"border-right-width",
	"border-bottom-width",
	"border-left-width",
	"font-size",
	"text-indent",
	"letter-spacing",
	"word-spacing",
	"flex-basis",
	"outline-width",
	"outline-offset",
]);

/**
 * A nonzero length written without a unit (`padding-top: 1`) is invalid
 * CSS. Browsers reject the declaration at PARSE time, so it never enters
 * the cascade and a lower-priority rule still wins -- coercing it to 0
 * instead would let the bad declaration beat the good one. Terminal
 * authoring makes this an easy slip to write, since 1px is exactly one
 * cell here, so the check earns its keep: `padding-top: 1` means nothing,
 * `padding-top: 1px` means one cell.
 */
function isValidDeclaration(property: string, value: string): boolean {
	if (!LENGTH_PROPERTIES.has(property)) {
		return true;
	}
	// A shorthand is invalid as a WHOLE if any of its components is, so
	// every component is checked and one failure rejects the declaration.
	return value
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.every((token) => {
			if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
				return true; // carries a unit, or is a keyword like auto
			}
			return parseFloat(token) === 0; // bare 0 is the one legal bare number
		});
}

/** Minimum gutter a UL/OL reserves for its markers, in cells. */
const DEFAULT_LIST_GUTTER = 4;

/** Lists currently having their gutter measured, to stop re-entrant computation. */
const listGutterInProgress = new WeakSet<Element>();

/**
 * The active StyleManager for a window.
 *
 * The gutter is resolved deep inside the cascade, which has no StyleManager to
 * hand, but it has to measure the *resolved* ::marker content -- the same string
 * the renderer will draw -- and only the StyleManager can produce that.
 */
const styleManagers = new WeakMap<object, StyleManager>();

/** A marker is separated from its item's text by one cell. */
function withMarkerSeparator(marker: string): string {
	return marker ? `${marker} ` : "";
}

/**
 * Strip the quotes from a CSS `content` value.
 *
 * A content value is a *sequence* of components -- quoted strings, and functions
 * like counter() -- so `counter(list-item) ") "` has to yield
 * `counter(list-item)) ` for the counter pass to expand, not keep its literal
 * quote characters. Only stripping when the whole value is one quoted string
 * left `"` and `'` in the rendered marker.
 */
function unquoteContent(content: string): string {
	let out = "";
	let index = 0;

	while (index < content.length) {
		const char = content[index];

		if (char === '"' || char === "'") {
			// A quote or a backslash inside the string carries a backslash of
			// its own, which is spelling, not content.
			let close = index + 1;
			for (; close < content.length && content[close] !== char; close++) {
				if (content[close] === "\\") close++;
			}
			out += content.slice(index + 1, close).replace(/\\(.)/g, "$1");
			index = close + 1;
		} else if (/\s/.test(char)) {
			// Whitespace *between* components is not rendered.
			index++;
		} else {
			// A function or keyword: copy it verbatim, parens and all.
			let depth = 0;
			let end = index;
			for (; end < content.length; end++) {
				const c = content[end];
				if (c === "(") depth++;
				else if (c === ")") depth--;
				else if (depth === 0 && /\s/.test(c)) break;
			}
			out += content.slice(index, end);
			index = end;
		}
	}

	return out;
}

/**
 * Width of the gutter a list reserves for `list-style-position: outside` markers.
 *
 * Markers are right-aligned against the content edge, so the gutter must fit the
 * widest marker in the list. A fixed gutter silently collides with wide markers:
 * "iii. Third" renders as "iii.Third" once the marker fills all four cells.
 *
 * This must measure exactly what renderOutsideMarker() will draw -- the resolved
 * ::marker content, in terminal cells. Measuring the *default* marker instead
 * lets `::marker { content: ">>>>>> " }` overrun the gutter, and measuring with
 * String#length instead of stringWidth() lets a wide-character marker like
 * "日本 " do the same: .length is 3 where the cells occupied are 5.
 */
function getListGutterWidth(listElement: Element): number {
	if (listGutterInProgress.has(listElement)) {
		return DEFAULT_LIST_GUTTER;
	}
	listGutterInProgress.add(listElement);
	try {
		const window = listElement.ownerDocument.defaultView;
		const styleManager = window ? styleManagers.get(window) : undefined;

		let widest = 0;
		for (const child of Array.from(listElement.children)) {
			if (child.tagName !== "LI") continue;
			const marker = styleManager
				? styleManager.getMarkerContent(child)
				: withMarkerSeparator(getListMarker(child, listElement));
			if (!marker) continue;
			widest = Math.max(widest, stringWidth(marker));
		}
		return Math.max(DEFAULT_LIST_GUTTER, widest);
	} finally {
		listGutterInProgress.delete(listElement);
	}
}

/**
 * The box shorthands whose computed answer is serialized from their four
 * longhands rather than resolved in its own right. Border shorthands are
 * excluded on purpose: resolveBorderStyles reads the longhands directly, and
 * `border` answers what was authored.
 */
const BOX_SHORTHAND_LONGHANDS = new Map<string, readonly string[]>([
	["margin", ["margin-top", "margin-right", "margin-bottom", "margin-left"]],
	[
		"padding",
		["padding-top", "padding-right", "padding-bottom", "padding-left"],
	],
]);

/** Properties whose value is a `<color>`. */
const COLOR_PROPERTIES = new Set([
	"color",
	"background-color",
	"border-top-color",
	"border-right-color",
	"border-bottom-color",
	"border-left-color",
	"outline-color",
	"text-decoration-color",
	"caret-color",
	"column-rule-color",
]);

/**
 * Properties whose value carries author text -- strings, family names,
 * function bodies -- and so is never case-folded.
 */
const VERBATIM_PROPERTIES = new Set([
	"content",
	"font",
	"font-family",
	"quotes",
	"counter-reset",
	"counter-increment",
	"background-image",
	"list-style-image",
]);

/** A value that is one bare CSS identifier, which computes case-folded. */
const IDENTIFIER_VALUE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * `#rgb`/`#rrggbb` (and their alpha forms) in the rgb()/rgba() serialization
 * a computed color carries. Null for anything that is not a valid hex color.
 */
function hexColorToRgb(hex: string): string | null {
	const digits = hex.slice(1);
	if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
	const short = digits.length === 3 || digits.length === 4;
	if (!short && digits.length !== 6 && digits.length !== 8) return null;
	const size = short ? 1 : 2;
	const channel = (index: number): number => {
		const part = digits.substr(index * size, size);
		return parseInt(short ? part + part : part, 16);
	};
	const rgb = `${channel(0)}, ${channel(1)}, ${channel(2)}`;
	if (digits.length === 4 || digits.length === 8) {
		const alpha = Math.round((channel(3) / 255) * 1000) / 1000;
		return `rgba(${rgb}, ${alpha})`;
	}
	return `rgb(${rgb})`;
}

/**
 * A numeric component in its computed spelling: the sign and any trailing
 * zeros dropped, the unit case-folded, and a unitless zero given the `px` a
 * length always computes to.
 */
function computedNumber(token: string): string {
	const match = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-zA-Z%]*)$/.exec(token);
	if (!match) return token;
	const number = parseFloat(match[1]);
	if (!Number.isFinite(number)) return token;
	const unit = match[2].toLowerCase() || (number === 0 ? "px" : "");
	return `${number}${unit}`;
}

/**
 * The computed spelling of a declared value: the one place a struct becomes
 * a string, at the getPropertyValue boundary.
 */
function normalizeValue(property: string, declared: string): string {
	const value = declared.trim();
	if (
		!value ||
		property.startsWith("--") ||
		VERBATIM_PROPERTIES.has(property)
	) {
		return value;
	}
	if (COLOR_PROPERTIES.has(property)) {
		return serializeColor(value) ?? value;
	}
	if (LENGTH_PROPERTIES.has(property)) {
		return value.split(/\s+/).map(computedNumber).join(" ");
	}
	return IDENTIFIER_VALUE.test(value) ? value.toLowerCase() : value;
}

/**
 * A color's resolved spelling: `rgb(r, g, b)`, or `rgba(r, g, b, a)` when it
 * is not opaque. Null for a value that names no color -- `currentcolor` before
 * it resolves, a keyword this engine's color table does not carry.
 */
function serializeColor(value: string): string | null {
	const text = value.trim();
	if (!text || text.toLowerCase() === "currentcolor") return null;
	if (/^transparent$/i.test(text)) return "rgba(0, 0, 0, 0)";
	if (text.startsWith("#")) return hexColorToRgb(text);
	const packed = parseCSSColor(text);
	if (packed === null) return null;
	const red = (packed >> 16) & 0xff;
	const green = (packed >> 8) & 0xff;
	const blue = packed & 0xff;
	// An alpha component survives the 24-bit packing as its own text.
	const functional = /^(?:rgba|hsla)\(([^)]*)\)$/i.exec(text);
	const parts = functional ? functional[1].split(/\s*[,/]\s*/) : [];
	if (parts.length === 4) {
		const raw = parts[3].trim();
		const opacity = raw.endsWith("%")
			? Number(raw.slice(0, -1)) / 100
			: Number(raw);
		if (Number.isFinite(opacity) && opacity < 1) {
			return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
		}
	}
	return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * Computed strings interned by property and declared text. A document draws
 * its declared values from a small vocabulary -- a handful of colors, a
 * handful of lengths, the same keywords on every element -- so the same pair
 * recurs across thousands of elements and every generation after the first.
 */
const computedValues = new Map<string, Map<string, string>>();

function computedValue(property: string, declared: string): string {
	if (!declared) return "";
	let byValue = computedValues.get(property);
	if (!byValue) {
		byValue = new Map();
		computedValues.set(property, byValue);
	}
	let value = byValue.get(declared);
	if (value === undefined) {
		value = normalizeValue(property, declared);
		if (byValue.size >= 512) byValue.clear();
		byValue.set(declared, value);
	}
	return value;
}

/** A cascade level's declarations: expanded longhands, and which are `!important`. */
interface DeclarationBlock {
	declarations: Record<string, string>;
	important: Record<string, boolean>;
}

const EMPTY_DECLARATIONS: DeclarationBlock = {declarations: {}, important: {}};

/** The CSSOM shape a declaration block is read through: a rule's, or an element's. */
interface DeclarationSource {
	readonly [index: number]: string;
	readonly length: number;
	getPropertyValue(property: string): string;
	getPropertyPriority(property: string): string;
}

/** One declaration of a block: a longhand, or a shorthand kept undecomposed. */
interface CSSDeclaration {
	name: string;
	value: string;
	important: boolean;
}

/** Every property CSSOM exposes, shorthands included. */
const SUPPORTED_PROPERTIES = new Set(CSS_PROPERTIES);

const EDGE_NAMES = ["top", "right", "bottom", "left"] as const;

/** The components of a line shorthand, in the order its grammar writes them. */
const LINE_COMPONENTS = ["width", "style", "color"] as const;

/** The keywords every property accepts, whatever its own grammar. */
const CSS_WIDE_KEYWORDS = new Set([
	"initial",
	"inherit",
	"unset",
	"revert",
	"revert-layer",
]);

const CORNER_NAMES = [
	"top-left",
	"top-right",
	"bottom-right",
	"bottom-left",
] as const;

/**
 * The shape of a shorthand's grammar, and so how its value serializes: a box
 * of four sides or corners collapsed to one to four values, a pair collapsed
 * when both agree, a line's width/style/color, `border`'s three uniform boxes,
 * or a plain sequence of components.
 */
type ShorthandShape = "box" | "pair" | "line" | "border" | "sequence";

/**
 * Each shorthand's longhands, in the order its grammar names them: the
 * property index lists a box's sides alphabetically, where the grammar --
 * and so the order the longhands are stored and serialized in -- runs
 * top, right, bottom, left.
 */
const SHORTHAND_LONGHANDS = new Map<string, readonly string[]>();

/** Each shorthand's shape, classified once rather than per serialization. */
const SHORTHAND_SHAPES = new Map<string, ShorthandShape>();

for (const [shorthand, indexed] of Object.entries(CSS_SHORTHANDS)) {
	const box =
		boxOrder(shorthand, indexed, EDGE_NAMES) ??
		boxOrder(shorthand, indexed, CORNER_NAMES);
	const longhands = box ?? indexed;
	SHORTHAND_LONGHANDS.set(shorthand, longhands);
	SHORTHAND_SHAPES.set(
		shorthand,
		box
			? "box"
			: longhands.length === 12 &&
				  LINE_COMPONENTS.every(
						(kind) =>
							longhands.filter((longhand) => longhand.endsWith(`-${kind}`))
								.length === 4,
				  )
				? "border"
				: longhands.length === LINE_COMPONENTS.length &&
					  longhands.every((longhand, index) =>
							longhand.endsWith(`-${LINE_COMPONENTS[index]}`),
					  )
					? "line"
					: longhands.length === 2
						? "pair"
						: "sequence",
	);
}

/**
 * The shorthands a longhand belongs to, widest first: block serialization
 * prefers the shorthand covering the most declarations, and `all` -- covering
 * every longhand there is -- comes first of all.
 */
const LONGHAND_SHORTHANDS = new Map<string, readonly string[]>();
{
	const byLonghand = new Map<string, string[]>();
	for (const [shorthand, longhands] of SHORTHAND_LONGHANDS) {
		for (const longhand of longhands) {
			let shorthands = byLonghand.get(longhand);
			if (!shorthands) byLonghand.set(longhand, (shorthands = []));
			shorthands.push(shorthand);
		}
	}
	for (const [longhand, shorthands] of byLonghand) {
		shorthands.sort(
			(a, b) =>
				SHORTHAND_LONGHANDS.get(b)!.length -
					SHORTHAND_LONGHANDS.get(a)!.length || (a < b ? -1 : 1),
		);
		LONGHAND_SHORTHANDS.set(longhand, shorthands);
	}
}

/**
 * A declared value in its CSSOM spelling: comments removed, runs of whitespace
 * collapsed to one space, no space inside a function's parentheses except the
 * single space that follows each comma. Strings pass through as authored.
 */
export function serializeCSSValue(input: string): string {
	let out = "";
	let space = false;
	const emit = (token: string): void => {
		if (out.endsWith(",")) out += " ";
		else if (space && out !== "" && !out.endsWith("(")) out += " ";
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
			if (unit) i += unit.length;
			emit(
				serializeCSSNumber(number) +
					(unit === "%" ? "%" : (unit?.toLowerCase() ?? "")),
			);
			i--;
			continue;
		}
		if (startsIdentifier(input, i)) {
			const name = /^[a-zA-Z0-9_\u0080-\uFFFF\\-]+/.exec(input.slice(i))![0];
			i += name.length;
			// A url() token's body is not an identifier list: it runs to the
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
	return out;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

function endOfString(input: string, start: number): number {
	const quote = input[start];
	for (let i = start + 1; i < input.length; i++) {
		if (input[i] === "\\") i++;
		else if (input[i] === quote) return i;
	}
	return input.length;
}

function unescapeCSSString(text: string): string {
	return text.replace(/\\(.)/g, "$1");
}

/** Whether a number token begins at `index`. */
function startsNumber(input: string, index: number): boolean {
	const rest = input.slice(index, index + 3);
	return /^[+-]?(\d|\.\d)/.test(rest);
}

/** Whether an identifier begins at `index`. */
function startsIdentifier(input: string, index: number): boolean {
	return /^[a-zA-Z_\u0080-\uFFFF\\-]/.test(input[index]);
}

/**
 * Serialize a number as CSSOM says: the shortest form that round-trips, with
 * no leading `+`, no bare leading `.`, and no negative zero.
 */
export function serializeCSSNumber(text: string): string {
	const value = Number(text);
	if (!Number.isFinite(value)) return text;
	if (Object.is(value, -0)) return "0";
	return String(value);
}

/** Serialize a string: double-quoted, with quotes and backslashes escaped. */
export function serializeCSSString(text: string): string {
	return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * Serialize an identifier: what `CSS.escape` answers. A code point that could
 * not stand in an identifier is written as a hex escape, and one that merely
 * needs quoting takes a backslash.
 */
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

/**
 * Whether a declaration would be honoured: `CSS.supports(property, value)`, and
 * the one-argument form that takes a `@supports` condition.
 */
function cssSupports(conditionOrProperty: string, value?: string): boolean {
	if (value === undefined) {
		const condition = String(conditionOrProperty).trim();
		// `selector(...)` asks whether a selector parses, which is exactly
		// what the cascade's own selector parser answers.
		const selector = /^selector\(([\s\S]*)\)$/.exec(condition);
		if (selector) return parseSelectorList(selector[1]) !== null;
		if (!condition.startsWith("(") || !condition.endsWith(")")) return false;
		const inner = condition.slice(1, -1);
		const colon = inner.indexOf(":");
		if (colon === -1) return false;
		return cssSupports(inner.slice(0, colon), inner.slice(colon + 1));
	}
	const property = normalizePropertyName(conditionOrProperty);
	if (property.startsWith("--")) return true;
	if (!SUPPORTED_PROPERTIES.has(property)) return false;
	const text = serializeCSSValue(String(value));
	return text !== "" && isValidDeclaration(property, text);
}

/** The `CSS` namespace object: identifier escaping and support queries. */
const CSSNamespace = {
	escape: serializeCSSIdentifier,
	supports: cssSupports,
	[Symbol.toStringTag]: "CSS",
};

/** The declarations of a `style` attribute, a `cssText`, or a rule's block. */
function parseDeclarationText(text: string): CSSDeclaration[] {
	const declarations: CSSDeclaration[] = [];
	let depth = 0;
	let start = 0;
	const push = (end: number): void => {
		const source = text.slice(start, end);
		start = end + 1;
		const colon = source.indexOf(":");
		if (colon === -1) return;
		const name = normalizePropertyName(source.slice(0, colon));
		if (!name) return;
		let value = serializeCSSValue(source.slice(colon + 1));
		let important = false;
		const bang = value.toLowerCase().lastIndexOf("!important");
		if (bang !== -1 && !value.slice(bang + 10).trim()) {
			important = true;
			value = value.slice(0, bang).trim();
		}
		if (!value) return;
		declarations.push({name, value, important});
	};
	for (let i = 0; i < text.length; i++) {
		const character = text[i];
		if (character === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 1;
		} else if (character === '"' || character === "'") {
			for (i++; i < text.length && text[i] !== character; i++) {
				if (text[i] === "\\") i++;
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

/**
 * A shorthand's value as its longhands, every longhand the shorthand covers
 * given a value -- the ones its grammar leaves out reset to their initial
 * value, as a browser's shorthand write does. Null for a shorthand whose
 * grammar this engine does not decompose, which stays a declaration of its own.
 */
function expandShorthandValue(
	property: string,
	value: string,
): Record<string, string> | null {
	const longhands = SHORTHAND_LONGHANDS.get(property);
	if (!longhands) return null;
	// A CSS-wide keyword is the whole value of every longhand the shorthand
	// covers -- which is all of them, for `all`.
	if (CSS_WIDE_KEYWORDS.has(value.toLowerCase())) {
		return Object.fromEntries(
			longhands.map((longhand) => [longhand, value.toLowerCase()]),
		);
	}
	const expanded = expandShorthands({[property]: value});
	const out: Record<string, string> = {};
	let decomposed = false;
	for (const longhand of longhands) {
		if (expanded[longhand] === undefined) continue;
		out[longhand] = expanded[longhand];
		decomposed = true;
	}
	if (!decomposed) return null;
	for (const longhand of longhands) {
		if (longhand in out) continue;
		const initial = CSS_INITIAL_VALUES[longhand];
		if (initial) out[longhand] = initial;
	}
	// Longhand order follows the shorthand's grammar, not the fill order.
	const ordered: Record<string, string> = {};
	for (const longhand of longhands) {
		if (longhand in out) ordered[longhand] = out[longhand];
	}
	return ordered;
}

/** The four values of a box shorthand, collapsed to the shortest equivalent. */
function collapseSides(values: string[]): string {
	const [top, right, bottom, left] = values;
	if (left !== right) return `${top} ${right} ${bottom} ${left}`;
	if (bottom !== top) return `${top} ${right} ${bottom}`;
	if (right !== top) return `${top} ${right}`;
	return top;
}

/**
 * The longhands of `shorthand` grouped by the side or corner each names, in
 * the order the shorthand's grammar writes them, or null when the longhands
 * are not a box.
 */
function boxOrder(
	shorthand: string,
	longhands: readonly string[],
	parts: readonly string[],
): string[] | null {
	if (longhands.length !== parts.length) return null;
	const byPart = new Map<string, string>();
	let stem: string | null = null;
	for (const longhand of longhands) {
		let matched: string | null = null;
		for (const part of parts) {
			const pattern = new RegExp(`(^|-)${part}(-|$)`);
			if (!pattern.test(longhand)) continue;
			if (matched === null || part.length > matched.length) matched = part;
		}
		if (matched === null) return null;
		const rest = longhand.replace(new RegExp(`(^|-)${matched}(-|$)`), "$1$2");
		if (stem === null) stem = rest;
		else if (stem !== rest) return null;
		if (byPart.has(matched)) return null;
		byPart.set(matched, longhand);
	}
	const ordered = parts.map((part) => byPart.get(part));
	return ordered.every((name): name is string => name !== undefined)
		? ordered
		: null;
}

/** A shorthand's value, reconstructed from its longhands' values. */
function serializeShorthandValue(
	shorthand: string,
	longhands: readonly string[],
	valueOf: (longhand: string) => string,
): string {
	const values = longhands.map(valueOf);
	// A CSS-wide keyword serializes as itself only when every longhand holds
	// the same one; one longhand overridden and the shorthand has no value.
	if (values.some((value) => CSS_WIDE_KEYWORDS.has(value))) {
		return values.every((value) => value === values[0]) ? values[0] : "";
	}

	switch (SHORTHAND_SHAPES.get(shorthand)) {
		case "box":
			return collapseSides(values);
		// `border` and its logical twins are three uniform boxes -- widths,
		// styles and colors -- and serialize only when every side agrees.
		case "border": {
			const components: Array<[string, string]> = [];
			for (const kind of LINE_COMPONENTS) {
				const sides = longhands.filter((longhand) =>
					longhand.endsWith(`-${kind}`),
				);
				const sideValues = sides.map(valueOf);
				if (sideValues.some((value) => value !== sideValues[0])) return "";
				components.push([sides[0], sideValues[0]]);
			}
			return dropInitials(components, 1);
		}
		// `border-top`, `outline`, `column-rule`: a line's width, style and
		// color, of which the style is the component that says the line is there
		// at all and so is written even when it is the initial `none`.
		case "line":
			return dropInitials(
				longhands.map((longhand, index) => [longhand, values[index]] as const),
				1,
			);
		case "pair":
			return values[0] === values[1] ? values[0] : values.join(" ");
		default:
			return dropInitials(
				longhands.map((longhand, index) => [longhand, values[index]] as const),
			);
	}
}

/**
 * A shorthand's components with the ones left at their initial value omitted,
 * which is what makes `border-top: 1px solid` serialize without its color.
 * `required` names a component index written whatever its value.
 */
function dropInitials(
	components: ReadonlyArray<readonly [string, string]>,
	required = -1,
): string {
	const kept = components
		.filter(([longhand, value], index) => {
			if (index === required) return true;
			const initial = CSS_INITIAL_VALUES[longhand];
			return !initial || value !== initial;
		})
		.map(([, value]) => value);
	if (kept.length > 0) return kept.join(" ");
	return components.length > 0 ? components[0][1] : "";
}

/**
 * The CSSOM algorithm turning a property name into the IDL attribute that
 * reflects it: `font-size` to `fontSize`, and -- with the lowercase-first flag
 * a `-webkit-` property also carries -- `-webkit-mask` to `webkitMask` as well
 * as `WebkitMask`.
 */
function camelCaseProperty(property: string, lowercaseFirst = false): string {
	const source = lowercaseFirst ? property.slice(1) : property;
	return source.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
}

/**
 * The inline style objects, one per element, that `element.style` hands out.
 */
const inlineStyles = new WeakMap<Element, CSSStyleDeclaration>();

/** Marks a prototype whose `style` accessor is already the engine's. */
const kInlineStyleInstalled = Symbol("termdom.inlineStyle");

/**
 * A CSS declaration block: what `element.style`, a style rule's `style`, and
 * every other CSSOM block are.
 *
 * Declarations are stored as longhands, so a shorthand write expands and a
 * shorthand read reconstructs -- `style.margin = "1px"` answers
 * `style.marginTop === "1px"`, and `style.marginTop = "2px"` answers
 * `style.margin === "1px 1px 1px 2px"`.
 *
 * An element-owned block and the element's `style` attribute are one store
 * seen from two sides. A write serializes through setAttribute, so the
 * attribute mutation record invalidation listens to fires for a property write
 * exactly as for an attribute write; a write to the attribute (or its removal)
 * reparses into the object on the next read, recognized by the text differing
 * from what this object last serialized.
 */
export class CSSStyleDeclaration implements DeclarationSource {
	[index: number]: string;
	#element: Element | null;
	#parentRule: CSSRule | null;
	#onChange: (() => void) | null;
	/** Whether this block holds an at-rule's descriptors rather than properties. */
	#descriptors = false;
	#declarations: CSSDeclaration[] = [];
	/** The `style` attribute text this object last serialized or parsed. */
	#attributeText: string | null = null;
	/** The declarations expanded to longhands for the cascade. */
	#block: DeclarationBlock | null = null;
	/** How many numeric index properties currently name a declaration. */
	#indexed = 0;

	constructor(
		owner: {
			element?: Element;
			parentRule?: CSSRule;
			onChange?: () => void;
			descriptors?: boolean;
		} = {},
	) {
		this.#element = owner.element ?? null;
		this.#parentRule = owner.parentRule ?? null;
		this.#onChange = owner.onChange ?? null;
		this.#descriptors = Boolean(owner.descriptors);
	}

	/** Adopt the `style` attribute when it says something this object did not write. */
	#sync(): void {
		if (!this.#element) return;
		const text = this.#element.getAttribute("style") ?? "";
		if (text === this.#attributeText) return;
		this.#attributeText = text;
		this.#declarations = [];
		for (const declaration of parseDeclarationText(text)) {
			this.#apply(declaration.name, declaration.value, declaration.important);
		}
		this.#invalidate();
	}

	/** Serialize a CSS declaration block: shorthands reconstructed, priority kept. */
	#serialize(): string {
		const parts: string[] = [];
		const serialized = new Set<string>();
		for (const declaration of this.#declarations) {
			if (serialized.has(declaration.name)) continue;
			let text = "";
			for (const shorthand of LONGHAND_SHORTHANDS.get(declaration.name) ?? []) {
				const longhands = SHORTHAND_LONGHANDS.get(shorthand)!;
				// A shorthand covering more properties than the block holds
				// cannot be serialized from it, and `all` covers hundreds.
				if (longhands.length > this.#declarations.length) continue;
				const value = this.#shorthandValue(shorthand, longhands);
				if (!value) continue;
				const important = this.#find(longhands[0])!.important;
				text = `${shorthand}: ${value}${important ? " !important" : ""};`;
				for (const longhand of longhands) serialized.add(longhand);
				break;
			}
			if (!text) {
				const priority = declaration.important ? " !important" : "";
				text = `${declaration.name}: ${declaration.value}${priority};`;
				serialized.add(declaration.name);
			}
			parts.push(text);
		}
		return parts.join(" ");
	}

	/** Serialize to the `style` attribute, which is what invalidation observes. */
	#flush(): void {
		this.#invalidate();
		if (this.#element) {
			this.#attributeText = this.#serialize();
			this.#element.setAttribute("style", this.#attributeText);
		}
		this.#onChange?.();
	}

	#invalidate(): void {
		this.#block = null;
		for (let i = 0; i < this.#indexed; i++) {
			delete this[i];
		}
		this.#indexed = this.#declarations.length;
		for (let i = 0; i < this.#indexed; i++) {
			this[i] = this.#declarations[i].name;
		}
	}

	#find(property: string): CSSDeclaration | undefined {
		return this.#declarations.find((entry) => entry.name === property);
	}

	/**
	 * Whether this block may hold `name`: a supported CSS property or a custom
	 * property, or -- in an at-rule's block -- any descriptor it names, since
	 * the property index does not describe descriptors.
	 */
	#supports(name: string): boolean {
		if (this.#descriptors) return name !== "";
		return name.startsWith("--") || SUPPORTED_PROPERTIES.has(name);
	}

	/** Store one declaration in place; returns whether anything changed. */
	#store(name: string, value: string, important: boolean): boolean {
		const declared = this.#find(name);
		if (!declared) {
			this.#declarations.push({name, value, important});
			return true;
		}
		if (declared.value === value && declared.important === important) {
			return false;
		}
		declared.value = value;
		declared.important = important;
		return true;
	}

	#remove(name: string): boolean {
		const index = this.#declarations.findIndex((entry) => entry.name === name);
		if (index === -1) return false;
		this.#declarations.splice(index, 1);
		return true;
	}

	/** Store a property as its longhands, or as itself; returns whether it changed. */
	#apply(name: string, value: string, important: boolean): boolean {
		// A declaration whose value does not parse is not stored at all, so a
		// shorthand with one bad component drops whole rather than leaving its
		// good components behind.
		if (!isValidDeclaration(name, value)) return false;
		const expanded = expandShorthandValue(name, value);
		if (!expanded) return this.#store(name, value, important);
		let changed = this.#remove(name);
		for (const longhand of SHORTHAND_LONGHANDS.get(name)!) {
			if (longhand in expanded) continue;
			changed = this.#remove(longhand) || changed;
		}
		for (const [longhand, longhandValue] of Object.entries(expanded)) {
			changed = this.#store(longhand, longhandValue, important) || changed;
		}
		return changed;
	}

	/** The shorthand's value, or "" when its longhands do not agree on one. */
	#shorthandValue(shorthand: string, longhands: readonly string[]): string {
		let important: boolean | null = null;
		for (const longhand of longhands) {
			const declared = this.#find(longhand);
			if (!declared) return "";
			if (important === null) important = declared.important;
			else if (important !== declared.important) return "";
		}
		return serializeShorthandValue(
			shorthand,
			longhands,
			(longhand) => this.#find(longhand)!.value,
		);
	}

	/** The declarations as the cascade consumes them: longhands, importance included. */
	declarationBlock(): DeclarationBlock {
		this.#sync();
		if (this.#declarations.length === 0) return EMPTY_DECLARATIONS;
		if (this.#block) return this.#block;

		const declarations: Record<string, string> = {};
		const important: Record<string, boolean> = {};
		const importantValues: Record<string, string> = {};
		let undecomposed = false;
		for (const entry of this.#declarations) {
			// An invalid declaration never enters the cascade: dropping it is
			// what lets a lower-priority rule keep winning, as a browser does.
			if (!isValidDeclaration(entry.name, entry.value)) continue;
			declarations[entry.name] = entry.value;
			if (entry.important) {
				important[entry.name] = true;
				importantValues[entry.name] = entry.value;
			}
			if (SHORTHAND_LONGHANDS.has(entry.name)) undecomposed = true;
		}

		// The block holds longhands, which is what the cascade consults --
		// except for a shorthand whose grammar this engine does not decompose,
		// which reaches the cascade as whatever longhands it can name, its
		// importance covering each of them.
		if (undecomposed) {
			for (const property of Object.keys(expandShorthands(importantValues))) {
				important[property] = true;
			}
			return (this.#block = {
				declarations: expandShorthands(declarations),
				important,
			});
		}
		return (this.#block = {declarations, important});
	}

	get parentRule(): CSSRule | null {
		return this.#parentRule;
	}

	get length(): number {
		this.#sync();
		return this.#declarations.length;
	}

	item(index: number): string {
		this.#sync();
		return this.#declarations[index]?.name ?? "";
	}

	[Symbol.iterator](): IterableIterator<string> {
		this.#sync();
		return this.#declarations.map((entry) => entry.name)[Symbol.iterator]();
	}

	getPropertyValue(property: string): string {
		this.#sync();
		const name = normalizePropertyName(property);
		const declared = this.#find(name);
		if (declared) return declared.value;
		const longhands = SHORTHAND_LONGHANDS.get(name);
		return longhands ? this.#shorthandValue(name, longhands) : "";
	}

	getPropertyPriority(property: string): string {
		this.#sync();
		const name = normalizePropertyName(property);
		const declared = this.#find(name);
		if (declared) return declared.important ? "important" : "";
		const longhands = SHORTHAND_LONGHANDS.get(name);
		if (
			longhands &&
			longhands.every((longhand) => this.#find(longhand)?.important)
		) {
			return "important";
		}
		return "";
	}

	setProperty(property: string, value: string, priority?: string): void {
		this.#sync();
		const name = normalizePropertyName(property);
		if (!this.#supports(name)) return;
		const text = serializeCSSValue(value == null ? "" : String(value));
		if (text === "") {
			this.removeProperty(name);
			return;
		}
		const priorityText = String(priority ?? "").toLowerCase();
		if (priorityText !== "" && priorityText !== "important") return;
		if (this.#apply(name, text, priorityText === "important")) {
			this.#flush();
		}
	}

	removeProperty(property: string): string {
		this.#sync();
		const name = normalizePropertyName(property);
		const previous = this.getPropertyValue(name);
		let changed = this.#remove(name);
		for (const longhand of SHORTHAND_LONGHANDS.get(name) ?? []) {
			changed = this.#remove(longhand) || changed;
		}
		if (changed) this.#flush();
		return previous;
	}

	get cssText(): string {
		this.#sync();
		return this.#serialize();
	}

	set cssText(text: string) {
		this.#sync();
		this.#declarations = [];
		for (const declaration of parseDeclarationText(text ?? "")) {
			if (!this.#supports(declaration.name)) continue;
			this.#apply(declaration.name, declaration.value, declaration.important);
		}
		this.#flush();
	}
}

/** Custom properties keep their case; everything else is ASCII-lowercased. */
function normalizePropertyName(property: string): string {
	const name = String(property).trim();
	return name.startsWith("--") ? name : name.toLowerCase();
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
	if (property !== names[0]) names.push(property);
	if (property === "float") names.push("cssFloat");
	for (const [index, name] of names.entries()) {
		Object.defineProperty(CSSStyleDeclaration.prototype, name, {
			...descriptor,
			enumerable: index === 0,
		});
	}
}

/**
 * Put this engine's CSSOM behind `element.style`, on whichever prototype in the
 * HTML and SVG element chains declares the accessor (jsdom mixes it in from
 * ElementCSSInlineStyle).
 */
export function installInlineStyle(window: DOMWindow): void {
	const roots = [window.HTMLElement?.prototype, window.SVGElement?.prototype];
	for (const root of roots) {
		let prototype: object | null = root ?? null;
		while (prototype) {
			if (Object.prototype.hasOwnProperty.call(prototype, "style")) break;
			prototype = Object.getPrototypeOf(prototype);
		}
		if (!prototype) continue;
		const owner = prototype as Record<string | symbol, unknown>;
		if (owner[kInlineStyleInstalled]) continue;
		owner[kInlineStyleInstalled] = true;
		Object.defineProperty(prototype, "style", {
			get(this: Element) {
				let style = inlineStyles.get(this);
				if (!style) {
					style = new CSSStyleDeclaration({element: this});
					inlineStyles.set(this, style);
				}
				return style;
			},
			set(this: Element, value: unknown) {
				(this as HTMLElement).style.cssText = value == null ? "" : `${value}`;
			},
			configurable: true,
			enumerable: true,
		});
	}
}

// ============================================================================
// CSSOM: STYLESHEETS AND RULES
// ============================================================================

/** The rule types CSSRule's legacy constants name. */
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

/**
 * What a sheet does when its rules -- or a declaration inside one of them --
 * change: tell whoever consumes it. Registered per sheet rather than exposed
 * on it, so a rule can reach its sheet's consumer without the sheet carrying
 * a method no author should see.
 */
const sheetNotifiers = new WeakMap<CSSStyleSheet, () => void>();

function sheetChanged(sheet: CSSStyleSheet | null | undefined): void {
	if (sheet) sheetNotifiers.get(sheet)?.();
}

/** An indexed CSSOM collection: `list[0]` alongside `list.item(0)`. */
function indexed<T extends object>(list: T, items: readonly unknown[]): T {
	return new Proxy(list, {
		get(target, property) {
			if (typeof property === "string" && /^\d+$/.test(property)) {
				return items[Number(property)];
			}
			// The list itself is the receiver: its accessors and methods read
			// private fields, which a proxy receiver cannot reach.
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		has(target, property) {
			if (typeof property === "string" && /^\d+$/.test(property)) {
				return Number(property) < items.length;
			}
			return Reflect.has(target, property);
		},
		ownKeys(target) {
			return [
				...items.map((_, index) => String(index)),
				...Reflect.ownKeys(target),
			];
		},
		getOwnPropertyDescriptor(target, property) {
			if (typeof property === "string" && /^\d+$/.test(property)) {
				const index = Number(property);
				if (index < items.length) {
					return {
						value: items[index],
						writable: false,
						enumerable: true,
						configurable: true,
					};
				}
			}
			return Reflect.getOwnPropertyDescriptor(target, property);
		},
	});
}

/** The media queries a sheet or an `@media` rule applies under. */
export class MediaList {
	#media: string[] = [];
	#onChange: (() => void) | null;

	constructor(mediaText = "", onChange?: () => void) {
		this.#onChange = onChange ?? null;
		this.#parse(mediaText);
	}

	#parse(text: string): void {
		this.#media = String(text ?? "")
			.split(",")
			.map((query) => query.trim())
			.filter(Boolean);
	}

	get mediaText(): string {
		return this.#media.join(", ");
	}

	set mediaText(text: string) {
		this.#parse(text);
		this.#onChange?.();
	}

	get length(): number {
		return this.#media.length;
	}

	item(index: number): string | null {
		return this.#media[index] ?? null;
	}

	appendMedium(medium: string): void {
		const query = String(medium).trim();
		if (!query || this.#media.includes(query)) return;
		this.#media.push(query);
		this.#onChange?.();
	}

	deleteMedium(medium: string): void {
		const index = this.#media.indexOf(String(medium).trim());
		if (index === -1) {
			throw new DOMException(`No such medium: ${medium}`, "NotFoundError");
		}
		this.#media.splice(index, 1);
		this.#onChange?.();
	}

	[Symbol.iterator](): IterableIterator<string> {
		return this.#media[Symbol.iterator]();
	}

	toString(): string {
		return this.mediaText;
	}
}

/** A rule of a stylesheet: the base every rule type shares. */
/**
 * A rule's owning sheet, held beside the rule so that deleting a rule can cut
 * the link -- a removed rule belongs to no stylesheet, and says so.
 */
const ruleSheets = new WeakMap<CSSRule, CSSStyleSheet | null>();

/** Cut a removed rule, and everything under it, loose from its sheet. */
function detachRule(rule: CSSRule): void {
	ruleSheets.set(rule, null);
	const group = rule as {cssRules?: CSSRuleList};
	if (group.cssRules) {
		for (const child of Array.from(group.cssRules)) detachRule(child);
	}
}

export abstract class CSSRule {
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

	#parentRule: CSSRule | null;

	constructor(
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		ruleSheets.set(this, parentStyleSheet);
		this.#parentRule = parentRule;
	}

	abstract get type(): number;
	abstract get cssText(): string;

	get parentRule(): CSSRule | null {
		return this.#parentRule;
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

/** Tell the sheet -- and so the cascade -- that a rule changed. */
function notifyRule(rule: CSSRule): void {
	sheetChanged(rule.parentStyleSheet);
}

/** A rule with a rule list of its own: `@media`, `@supports`, `@layer`. */
export abstract class CSSGroupingRule extends CSSRule {
	#rules: CSSRule[] = [];
	#ruleList: CSSRuleList;

	constructor(
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule);
		this.#ruleList = createRuleList(this.#rules);
		if (build) this.#rules.push(...build(this));
	}

	get cssRules(): CSSRuleList {
		return this.#ruleList;
	}

	insertRule(text: string, index = 0): number {
		const inserted = parseRuleText(text, this.parentStyleSheet, this);
		if (index > this.#rules.length) {
			throw new DOMException(
				`Cannot insert at index ${index}`,
				"IndexSizeError",
			);
		}
		if (
			inserted instanceof CSSImportRule ||
			inserted instanceof CSSNamespaceRule
		) {
			throw new DOMException(
				"Only a stylesheet may hold that rule",
				"HierarchyRequestError",
			);
		}
		this.#rules.splice(index, 0, inserted);
		notifyRule(this);
		return index;
	}

	deleteRule(index: number): void {
		if (index >= this.#rules.length) {
			throw new DOMException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
			);
		}
		detachRule(this.#rules[index]);
		this.#rules.splice(index, 1);
		notifyRule(this);
	}
}

/** A group's rules, serialized one per line and indented one level. */
function serializeGroupRules(group: CSSGroupingRule): string {
	return Array.from(group.cssRules)
		.map((rule) => `\n  ${rule.cssText.replace(/\n/g, "\n  ")}`)
		.join("");
}

/** A grouping rule gated on a condition: `@media`, `@supports`. */
export abstract class CSSConditionRule extends CSSGroupingRule {
	abstract get conditionText(): string;
}

/** A style rule: a selector and the declaration block it applies. */
export class CSSStyleRule extends CSSGroupingRule {
	#selectors: SelectorNode;
	#selectorText: string | null = null;
	#style: CSSStyleDeclaration;

	constructor(
		selectors: SelectorNode,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this.#selectors = selectors;
		this.#style = new CSSStyleDeclaration({
			parentRule: this,
			onChange: () => notifyRule(this),
		});
		this.#style.cssText = cssText;
	}

	get type(): number {
		return RULE_TYPES.STYLE_RULE;
	}

	/**
	 * Serialized on first read rather than at construction: whether `*|E` keeps
	 * its prefix depends on the sheet declaring a default namespace, and the
	 * sheet's `@namespace` rules are only in place once parsing finishes.
	 */
	get selectorText(): string {
		return (this.#selectorText ??= serializeSelectorList(
			this.#selectors,
			sheetNamespaces(this.parentStyleSheet),
		));
	}

	/** A selector that does not parse leaves the rule as it was. */
	set selectorText(selector: string) {
		const selectors = parseSelectorList(selector);
		if (!selectors) return;
		this.#selectors = selectors;
		this.#selectorText = null;
		notifyRule(this);
	}

	/** The parsed selector, which the cascade matches against. */
	get selectors(): SelectorNode {
		return this.#selectors;
	}

	get style(): CSSStyleDeclaration {
		return this.#style;
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this.#style.cssText = String(text);
	}

	get cssText(): string {
		const declarations = this.#style.cssText;
		const nested = serializeGroupRules(this);
		const selector = this.selectorText;
		if (nested) return `${selector} { ${declarations}${nested}\n}`;
		return declarations ? `${selector} { ${declarations} }` : `${selector} { }`;
	}
}

/** The namespaces a sheet's `@namespace` rules declare. */
function sheetNamespaces(sheet: CSSStyleSheet | null): SelectorNamespaces {
	if (!sheet) return NO_NAMESPACES;
	const namespaces: SelectorNamespaces = {default: null, prefixes: new Map()};
	for (const rule of Array.from(sheet.cssRules)) {
		if (!(rule instanceof CSSNamespaceRule)) continue;
		if (rule.prefix === "") namespaces.default = rule.namespaceURI;
		else namespaces.prefixes.set(rule.prefix, rule.namespaceURI);
	}
	return namespaces;
}

/** A rule whose body is a declaration block rather than a rule list. */
export abstract class CSSDeclarationBlockRule extends CSSRule {
	#style: CSSStyleDeclaration;

	constructor(
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		this.#style = new CSSStyleDeclaration({
			parentRule: this,
			onChange: () => notifyRule(this),
			// A descriptor block declares descriptors, not CSS properties, so
			// the property index does not gate what it may hold.
			descriptors: true,
		});
		this.#style.cssText = cssText;
	}

	get style(): CSSStyleDeclaration {
		return this.#style;
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this.#style.cssText = String(text);
	}

	/** The at-keyword and prelude this rule's text opens with. */
	abstract get prelude(): string;

	get cssText(): string {
		const declarations = this.#style.cssText;
		return declarations
			? `${this.prelude} { ${declarations} }`
			: `${this.prelude} { }`;
	}
}

/** `@font-face`: the descriptors of a font this terminal will never load. */
export class CSSFontFaceRule extends CSSDeclarationBlockRule {
	get type(): number {
		return RULE_TYPES.FONT_FACE_RULE;
	}

	get prelude(): string {
		return "@font-face";
	}
}

/** `@page`: the page selector and its descriptors. */
export class CSSPageRule extends CSSDeclarationBlockRule {
	#selectorText: string;

	constructor(
		selectorText: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(cssText, parentStyleSheet, parentRule);
		this.#selectorText = serializePageSelector(selectorText);
	}

	get type(): number {
		return RULE_TYPES.PAGE_RULE;
	}

	get selectorText(): string {
		return this.#selectorText;
	}

	set selectorText(selector: string) {
		this.#selectorText = serializePageSelector(String(selector));
		notifyRule(this);
	}

	get prelude(): string {
		return this.#selectorText ? `@page ${this.#selectorText}` : "@page";
	}
}

/** The page pseudo-classes a `@page` selector may name. */
const PAGE_PSEUDO_CLASSES = new Set(["first", "left", "right", "blank"]);

/**
 * A page selector -- an optional page name followed by page pseudo-classes,
 * with no whitespace between them -- or "" when it names no valid page.
 */
function serializePageSelector(selector: string): string {
	const text = String(selector).trim();
	if (!text) return "";
	const match = /^([^\s:]*)((?::[^\s:]+)*)$/.exec(text);
	if (!match) return "";
	const pseudos = match[2] ? match[2].slice(1).split(":") : [];
	for (const pseudo of pseudos) {
		if (!PAGE_PSEUDO_CLASSES.has(pseudo.toLowerCase())) return "";
	}
	const name = match[1] ? serializeCSSIdentifier(match[1]) : "";
	return name + pseudos.map((pseudo) => `:${pseudo.toLowerCase()}`).join("");
}

/** `@counter-style`: a counter's name and the descriptors that define it. */
export class CSSCounterStyleRule extends CSSDeclarationBlockRule {
	#name: string;

	constructor(
		name: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(cssText, parentStyleSheet, null);
		this.#name = name.trim();
	}

	get type(): number {
		return RULE_TYPES.COUNTER_STYLE_RULE;
	}

	get name(): string {
		return this.#name;
	}

	set name(name: string) {
		const text = String(name).trim();
		if (!text) return;
		this.#name = text;
		notifyRule(this);
	}

	get prelude(): string {
		return `@counter-style ${this.#name}`;
	}
}

/** `@property`: a custom property's registration. */
export class CSSPropertyRule extends CSSDeclarationBlockRule {
	#name: string;

	constructor(
		name: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(cssText, parentStyleSheet, null);
		this.#name = name.trim();
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this.#name;
	}

	get syntax(): string {
		return this.style.getPropertyValue("syntax");
	}

	get inherits(): boolean {
		return this.style.getPropertyValue("inherits") === "true";
	}

	get initialValue(): string | null {
		return this.style.getPropertyValue("initial-value") || null;
	}

	get prelude(): string {
		return `@property ${this.#name}`;
	}
}

/** `@font-palette-values`: a palette's name and its descriptors. */
export class CSSFontPaletteValuesRule extends CSSDeclarationBlockRule {
	#name: string;

	constructor(
		name: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(cssText, parentStyleSheet, null);
		this.#name = name.trim();
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this.#name;
	}

	get fontFamily(): string {
		return this.style.getPropertyValue("font-family");
	}

	get basePalette(): string {
		return this.style.getPropertyValue("base-palette");
	}

	get overrideColors(): string {
		return this.style.getPropertyValue("override-colors");
	}

	get prelude(): string {
		return `@font-palette-values ${this.#name}`;
	}
}

/** One keyframe of an `@keyframes` rule: its offsets and its declarations. */
export class CSSKeyframeRule extends CSSDeclarationBlockRule {
	#keyText: string;

	constructor(
		keyText: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(cssText, parentStyleSheet, parentRule);
		this.#keyText = serializeKeyText(keyText);
	}

	get type(): number {
		return RULE_TYPES.KEYFRAME_RULE;
	}

	get keyText(): string {
		return this.#keyText;
	}

	set keyText(text: string) {
		const serialized = serializeKeyText(String(text));
		if (!serialized) {
			throw new DOMException(`Cannot parse keyText: ${text}`, "SyntaxError");
		}
		this.#keyText = serialized;
		notifyRule(this);
	}

	get prelude(): string {
		return this.#keyText;
	}
}

/** A keyframe's selector, as percentages: `from` is 0%, `to` is 100%. */
function serializeKeyText(text: string): string {
	const keys: string[] = [];
	for (const part of String(text).split(",")) {
		const key = part.trim().toLowerCase();
		if (key === "from") keys.push("0%");
		else if (key === "to") keys.push("100%");
		else if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(key)) {
			keys.push(`${serializeCSSNumber(key.slice(0, -1))}%`);
		} else return "";
	}
	return keys.join(", ");
}

/** `@media`: the rules that apply when the viewport matches. */
export class CSSMediaRule extends CSSConditionRule {
	#media: MediaList;

	constructor(
		mediaText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this.#media = new MediaList(mediaText, () => notifyRule(this));
	}

	get type(): number {
		return RULE_TYPES.MEDIA_RULE;
	}

	get media(): MediaList {
		return this.#media;
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this.#media.mediaText = String(text);
	}

	get conditionText(): string {
		return this.#media.mediaText;
	}

	set conditionText(text: string) {
		this.#media.mediaText = text;
	}

	get cssText(): string {
		return `@media ${this.conditionText} {${serializeGroupRules(this)}\n}`;
	}
}

/** A grouping rule whose condition is a text this engine keeps as authored. */
abstract class CSSTextConditionRule extends CSSConditionRule {
	#conditionText: string;

	constructor(
		conditionText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this.#conditionText = conditionText.trim();
	}

	get conditionText(): string {
		return this.#conditionText;
	}

	abstract get atKeyword(): string;

	get cssText(): string {
		const condition = this.#conditionText ? ` ${this.#conditionText}` : "";
		return `${this.atKeyword}${condition} {${serializeGroupRules(this)}\n}`;
	}
}

/** `@supports`: its rules apply, since what this engine supports it renders. */
export class CSSSupportsRule extends CSSTextConditionRule {
	get type(): number {
		return RULE_TYPES.SUPPORTS_RULE;
	}

	get atKeyword(): string {
		return "@supports";
	}
}

/** `@container`: parsed, with no container query engine behind it. */
export class CSSContainerRule extends CSSTextConditionRule {
	get type(): number {
		return 0;
	}

	get atKeyword(): string {
		return "@container";
	}

	get containerName(): string {
		const match = /^([a-zA-Z_-][\w-]*)\s+/.exec(this.conditionText);
		return match?.[1] ?? "";
	}

	get containerQuery(): string {
		const name = this.containerName;
		return name
			? this.conditionText.slice(name.length).trim()
			: this.conditionText;
	}
}

/** `@scope`: parsed, and its rules apply unscoped. */
export class CSSScopeRule extends CSSGroupingRule {
	#prelude: string;

	constructor(
		prelude: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this.#prelude = prelude.trim();
	}

	get type(): number {
		return 0;
	}

	get start(): string | null {
		const match = /^\(([^)]*)\)/.exec(this.#prelude);
		return match?.[1].trim() ?? null;
	}

	get end(): string | null {
		const match = /\bto\s*\(([^)]*)\)/.exec(this.#prelude);
		return match?.[1].trim() ?? null;
	}

	get cssText(): string {
		const prelude = this.#prelude ? ` ${this.#prelude}` : "";
		return `@scope${prelude} {${serializeGroupRules(this)}\n}`;
	}
}

/** `@starting-style`: parsed, with no transitions behind it. */
export class CSSStartingStyleRule extends CSSGroupingRule {
	get type(): number {
		return 0;
	}

	get cssText(): string {
		return `@starting-style {${serializeGroupRules(this)}\n}`;
	}
}

/** `@layer name { ... }`: its rules cascade in source order. */
export class CSSLayerBlockRule extends CSSGroupingRule {
	#name: string;

	constructor(
		name: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this.#name = name.trim();
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this.#name;
	}

	get cssText(): string {
		const name = this.#name ? ` ${this.#name}` : "";
		return `@layer${name} {${serializeGroupRules(this)}\n}`;
	}
}

/** `@layer a, b;`: the layer order, declared without a block. */
export class CSSLayerStatementRule extends CSSRule {
	#names: string[];

	constructor(
		prelude: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		this.#names = prelude
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
	}

	get type(): number {
		return 0;
	}

	get nameList(): readonly string[] {
		return this.#names;
	}

	get cssText(): string {
		return `@layer ${this.#names.join(", ")};`;
	}
}

/** `@namespace`: a prefix bound to a namespace URI. */
export class CSSNamespaceRule extends CSSRule {
	#prefix: string;
	#namespaceURI: string;

	constructor(
		prefix: string,
		namespaceURI: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this.#prefix = prefix;
		this.#namespaceURI = namespaceURI;
	}

	get type(): number {
		return RULE_TYPES.NAMESPACE_RULE;
	}

	get prefix(): string {
		return this.#prefix;
	}

	get namespaceURI(): string {
		return this.#namespaceURI;
	}

	get cssText(): string {
		const prefix = this.#prefix ? `${this.#prefix} ` : "";
		return `@namespace ${prefix}url(${serializeCSSString(this.#namespaceURI)});`;
	}
}

/**
 * `@import`: parsed into an object with its href, layer, supports condition
 * and media, whose styleSheet is null. There is no network behind a terminal
 * document, so nothing is fetched and the rule declares nothing.
 */
export class CSSImportRule extends CSSRule {
	#href: string;
	#media: MediaList;
	#layerName: string | null;
	#supportsText: string | null;

	constructor(
		href: string,
		mediaText: string,
		layerName: string | null,
		supportsText: string | null,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this.#href = href;
		this.#media = new MediaList(mediaText);
		this.#layerName = layerName;
		this.#supportsText = supportsText;
	}

	get type(): number {
		return RULE_TYPES.IMPORT_RULE;
	}

	get href(): string {
		return this.#href;
	}

	get media(): MediaList {
		return this.#media;
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this.#media.mediaText = String(text);
	}

	get layerName(): string | null {
		return this.#layerName;
	}

	get supportsText(): string | null {
		return this.#supportsText;
	}

	get styleSheet(): CSSStyleSheet | null {
		return null;
	}

	get cssText(): string {
		let out = `@import url(${serializeCSSString(this.#href)})`;
		if (this.#layerName !== null) {
			out += this.#layerName ? ` layer(${this.#layerName})` : " layer";
		}
		if (this.#supportsText !== null) out += ` supports(${this.#supportsText})`;
		const media = this.#media.mediaText;
		if (media) out += ` ${media}`;
		return `${out};`;
	}
}

/** `@font-feature-values`: a font family and the feature blocks it names. */
export class CSSFontFeatureValuesRule extends CSSRule {
	#fontFamily: string;
	#blocks = new Map<string, CSSStyleDeclaration>();

	constructor(
		fontFamily: string,
		node: ParsedNode,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this.#fontFamily = fontFamily.trim();
		for (const child of nodesOf(node.block ?? {})) {
			if (child.type !== "Atrule" || !child.name) continue;
			const block = new CSSStyleDeclaration({
				parentRule: this,
				onChange: () => notifyRule(this),
				descriptors: true,
			});
			block.cssText = blockText(child);
			this.#blocks.set(child.name.toLowerCase(), block);
		}
	}

	get type(): number {
		return RULE_TYPES.FONT_FEATURE_VALUES_RULE;
	}

	get fontFamily(): string {
		return this.#fontFamily;
	}

	set fontFamily(family: string) {
		this.#fontFamily = String(family).trim();
		notifyRule(this);
	}

	/** One feature block's values, or an empty block when it was not written. */
	#block(name: string): CSSStyleDeclaration {
		let block = this.#blocks.get(name);
		if (!block) {
			block = new CSSStyleDeclaration({
				parentRule: this,
				onChange: () => notifyRule(this),
				descriptors: true,
			});
			this.#blocks.set(name, block);
		}
		return block;
	}

	get annotation(): CSSStyleDeclaration {
		return this.#block("annotation");
	}

	get ornaments(): CSSStyleDeclaration {
		return this.#block("ornaments");
	}

	get stylistic(): CSSStyleDeclaration {
		return this.#block("stylistic");
	}

	get swash(): CSSStyleDeclaration {
		return this.#block("swash");
	}

	get characterVariant(): CSSStyleDeclaration {
		return this.#block("character-variant");
	}

	get styleset(): CSSStyleDeclaration {
		return this.#block("styleset");
	}

	get cssText(): string {
		const blocks: string[] = [];
		for (const [name, block] of this.#blocks) {
			const declarations = block.cssText;
			if (declarations) blocks.push(`\n  @${name} { ${declarations} }`);
		}
		return `@font-feature-values ${this.#fontFamily} {${blocks.join("")}\n}`;
	}
}

/** `@keyframes`: its name and the keyframes it holds. */
export class CSSKeyframesRule extends CSSRule {
	#name: string;
	#rules: CSSRule[] = [];
	#ruleList: CSSRuleList;

	constructor(
		name: string,
		parentStyleSheet: CSSStyleSheet | null,
		build?: (rule: CSSKeyframesRule) => CSSRule[],
	) {
		super(parentStyleSheet, null);
		this.#name = name.trim();
		this.#ruleList = createRuleList(this.#rules);
		if (build) this.#rules.push(...build(this));
	}

	get type(): number {
		return RULE_TYPES.KEYFRAMES_RULE;
	}

	get name(): string {
		return this.#name;
	}

	set name(name: string) {
		this.#name = String(name);
		notifyRule(this);
	}

	get cssRules(): CSSRuleList {
		return this.#ruleList;
	}

	get length(): number {
		return this.#rules.length;
	}

	appendRule(text: string): void {
		const rule = parseRuleText(
			`@keyframes k { ${text} }`,
			this.parentStyleSheet,
			this,
		);
		if (rule instanceof CSSKeyframesRule) {
			this.#rules.push(...Array.from(rule.cssRules));
			notifyRule(this);
		}
	}

	deleteRule(select: string): void {
		const key = serializeKeyText(String(select));
		for (let index = this.#rules.length - 1; index >= 0; index--) {
			if ((this.#rules[index] as CSSKeyframeRule).keyText !== key) continue;
			this.#rules.splice(index, 1);
			notifyRule(this);
			return;
		}
	}

	findRule(select: string): CSSKeyframeRule | null {
		const key = serializeKeyText(String(select));
		for (let index = this.#rules.length - 1; index >= 0; index--) {
			const rule = this.#rules[index] as CSSKeyframeRule;
			if (rule.keyText === key) return rule;
		}
		return null;
	}

	get cssText(): string {
		const frames = this.#rules.map((rule) => `\n  ${rule.cssText}`).join("");
		return `@keyframes ${this.#name} {${frames}\n}`;
	}
}

/** The rules of a stylesheet or a grouping rule. */
export class CSSRuleList {
	#rules: readonly CSSRule[];

	constructor(rules: readonly CSSRule[]) {
		this.#rules = rules;
	}

	get length(): number {
		return this.#rules.length;
	}

	item(index: number): CSSRule | null {
		return this.#rules[index] ?? null;
	}

	[Symbol.iterator](): IterableIterator<CSSRule> {
		return this.#rules[Symbol.iterator]();
	}
}

function createRuleList(rules: readonly CSSRule[]): CSSRuleList {
	return indexed(new CSSRuleList(rules), rules);
}

/** The stylesheets of a document or a shadow root. */
export class StyleSheetList {
	#sheets: readonly CSSStyleSheet[];

	constructor(sheets: readonly CSSStyleSheet[]) {
		this.#sheets = sheets;
	}

	get length(): number {
		return this.#sheets.length;
	}

	item(index: number): CSSStyleSheet | null {
		return this.#sheets[index] ?? null;
	}

	[Symbol.iterator](): IterableIterator<CSSStyleSheet> {
		return this.#sheets[Symbol.iterator]();
	}
}

/**
 * A stylesheet: the rules of a `<style>` element, or a constructed sheet a
 * document adopts.
 *
 * The rules are this object's own -- the cascade reads them rather than
 * re-parsing text -- so insertRule, deleteRule, replaceSync and a write to any
 * rule's declaration block all reach the render through the same invalidation
 * a `<style>` text change does.
 */
export class CSSStyleSheet {
	#rules: CSSRule[] = [];
	#ruleList: CSSRuleList;
	#media: MediaList;
	#ownerNode: Element | null = null;
	#ownerRule: CSSRule | null = null;
	#constructed: boolean;
	#disabled = false;
	#href: string | null;
	#title: string | null;
	/** The owner node's text this sheet last parsed. */
	#text: string | null = null;

	/**
	 * A sheet with an owner element is one the document parsed: replace and
	 * replaceSync are refused on it, and its rules follow the element's text.
	 * The exposed constructor takes options alone, so author code only ever
	 * makes the constructed kind.
	 */
	constructor(
		options: {media?: string; title?: string; disabled?: boolean} = {},
		ownerNode: Element | null = null,
	) {
		this.#ownerNode = ownerNode;
		this.#constructed = ownerNode === null;
		if (this.#constructed) constructedSheets.add(this);
		this.#href = ownerNode?.getAttribute("href") ?? null;
		this.#title = ownerNode?.getAttribute("title") ?? options.title ?? null;
		this.#disabled = Boolean(options.disabled);
		this.#media = new MediaList(
			ownerNode?.getAttribute("media") ?? options.media ?? "",
			() => this.#changed(),
		);
		this.#ruleList = createRuleList(this.#rules);
	}

	#changed(): void {
		sheetNotifiers.get(this)?.();
	}

	/** Reparse the owner element's text when it says something new. */
	#sync(): void {
		const node = this.#ownerNode;
		if (!node || node.tagName !== "STYLE") return;
		const text = node.textContent ?? "";
		if (text === this.#text) return;
		this.#text = text;
		this.#rules.length = 0;
		this.#rules.push(...parseRules(text, this, null));
	}

	get cssRules(): CSSRuleList {
		this.#sync();
		return this.#ruleList;
	}

	/** The legacy alias every engine still answers to. */
	get rules(): CSSRuleList {
		return this.cssRules;
	}

	get type(): string {
		return "text/css";
	}

	get href(): string | null {
		return this.#href;
	}

	get title(): string | null {
		return this.#title;
	}

	get ownerNode(): Element | null {
		return this.#ownerNode;
	}

	get ownerRule(): CSSRule | null {
		return this.#ownerRule;
	}

	get parentStyleSheet(): CSSStyleSheet | null {
		return this.#ownerRule?.parentStyleSheet ?? null;
	}

	get media(): MediaList {
		return this.#media;
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this.#media.mediaText = String(text);
	}

	get disabled(): boolean {
		return this.#disabled;
	}

	set disabled(disabled: boolean) {
		const value = Boolean(disabled);
		if (value === this.#disabled) return;
		this.#disabled = value;
		this.#changed();
	}

	insertRule(text: string, index = 0): number {
		this.#sync();
		if (index > this.#rules.length) {
			throw new DOMException(
				`Cannot insert at index ${index}`,
				"IndexSizeError",
			);
		}
		this.#rules.splice(index, 0, parseRuleText(text, this, null));
		this.#changed();
		return index;
	}

	deleteRule(index: number): void {
		this.#sync();
		if (index >= this.#rules.length) {
			throw new DOMException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
			);
		}
		detachRule(this.#rules[index]);
		this.#rules.splice(index, 1);
		this.#changed();
	}

	/** The legacy IE spellings, defined in terms of the modern pair. */
	addRule(selector = "undefined", block = "undefined", index?: number): number {
		this.insertRule(`${selector} { ${block} }`, index ?? this.cssRules.length);
		return -1;
	}

	removeRule(index = 0): void {
		this.deleteRule(index);
	}

	replaceSync(text: string): void {
		if (!this.#constructed) {
			throw new DOMException(
				"replaceSync is only allowed on a constructed stylesheet",
				"NotAllowedError",
			);
		}
		// An adopted sheet cannot pull in another: `@import` is dropped rather
		// than parsed, per the constructable-stylesheet rules.
		this.#rules.length = 0;
		this.#rules.push(
			...parseRules(String(text ?? ""), this, null).filter(
				(rule) => !(rule instanceof CSSImportRule),
			),
		);
		this.#changed();
	}

	replace(text: string): Promise<CSSStyleSheet> {
		try {
			this.replaceSync(text);
		} catch (error) {
			return Promise.reject(error);
		}
		return Promise.resolve(this);
	}
}

/** Whether a sheet may be adopted: only a constructed one, per spec. */
const constructedSheets = new WeakSet<CSSStyleSheet>();

// ---- Selectors -------------------------------------------------------------

/**
 * The pseudo-classes and pseudo-elements a selector may name. A selector
 * naming anything else does not parse, which is what makes `:gibberish`
 * invalid rather than merely unmatched.
 */
const PSEUDO_CLASSES = new Set([
	"active",
	"any-link",
	"autofill",
	"blank",
	"buffering",
	"checked",
	"current",
	"default",
	"defined",
	"dir",
	"disabled",
	"empty",
	"enabled",
	"first",
	"first-child",
	"first-of-type",
	"focus",
	"focus-visible",
	"focus-within",
	"fullscreen",
	"future",
	"has",
	"host",
	"host-context",
	"hover",
	"in-range",
	"indeterminate",
	"invalid",
	"is",
	"lang",
	"last-child",
	"last-of-type",
	"left",
	"link",
	"local-link",
	"modal",
	"muted",
	"not",
	"nth-child",
	"nth-col",
	"nth-last-child",
	"nth-last-col",
	"nth-last-of-type",
	"nth-of-type",
	"only-child",
	"only-of-type",
	"open",
	"optional",
	"out-of-range",
	"past",
	"paused",
	"picture-in-picture",
	"placeholder-shown",
	"playing",
	"popover-open",
	"read-only",
	"read-write",
	"required",
	"right",
	"root",
	"scope",
	"seeking",
	"stalled",
	"state",
	"target",
	"target-current",
	"target-within",
	"user-invalid",
	"user-valid",
	"valid",
	"visited",
	"volume-locked",
	"where",
	"window-inactive",
]);

const PSEUDO_ELEMENTS = new Set([
	"after",
	"backdrop",
	"before",
	"checkmark",
	"column",
	"cue",
	"cue-region",
	"details-content",
	"file-selector-button",
	"first-letter",
	"first-line",
	"grammar-error",
	"highlight",
	"marker",
	"part",
	"picker",
	"picker-icon",
	"placeholder",
	"scroll-button",
	"scroll-marker",
	"scroll-marker-group",
	"selection",
	"slotted",
	"spelling-error",
	"target-text",
	"view-transition",
	"view-transition-group",
	"view-transition-image-pair",
	"view-transition-new",
	"view-transition-old",
]);

/**
 * The pseudo-elements whose selector takes an argument, and so are written
 * only in functional form -- `::part(name)`, never a bare `::part`.
 */
const FUNCTIONAL_PSEUDO_ELEMENTS = new Set([
	"part",
	"highlight",
	"slotted",
	"picker",
	"scroll-button",
	"view-transition-group",
	"view-transition-image-pair",
	"view-transition-new",
	"view-transition-old",
]);

/** The pseudo-elements that may also be written with one colon, from CSS 2. */
const LEGACY_PSEUDO_ELEMENTS = new Set([
	"after",
	"before",
	"first-letter",
	"first-line",
]);

/** A selector AST node, as the CSS parser hands it over. */
interface SelectorNode {
	type: string;
	name?: string | {type: string; name: string};
	matcher?: string | null;
	value?: {type: string; value?: string; name?: string} | null;
	flags?: string | null;
	children?: {toArray(): SelectorNode[]} | SelectorNode[] | null;
	nth?: SelectorNode | null;
	selector?: SelectorNode | null;
	a?: string | null;
	b?: string | null;
}

function childrenOf(node: SelectorNode): SelectorNode[] {
	const children = node.children;
	if (!children) return [];
	return Array.isArray(children) ? children : children.toArray();
}

/**
 * A qualified name -- `ns|local`, `*|local`, `local` -- with each part
 * serialized as an identifier and `*` left as itself.
 */
function serializeQualifiedName(
	name: string,
	namespaces: SelectorNamespaces,
): string {
	const bar = name.lastIndexOf("|");
	const local = bar === -1 ? name : name.slice(bar + 1);
	const prefix = bar === -1 ? null : name.slice(0, bar);
	const localText = local === "*" ? "*" : serializeIdentifierSource(local);
	if (prefix === null) return localText;
	// A prefix is written only where it says something an unprefixed name does
	// not: `*|E` says "any namespace", which is what `E` already means with no
	// default namespace declared, and a prefix bound to the default namespace
	// resolves to the same namespace `E` does.
	if (prefix === "*") {
		return namespaces.default === null ? localText : `*|${localText}`;
	}
	if (prefix === "") {
		// `|E` says "no namespace", which `E` means only without a default.
		return namespaces.default === null ? localText : `|${localText}`;
	}
	const decoded = cssTree.ident.decode(prefix);
	if (
		namespaces.default !== null &&
		namespaces.prefixes.get(decoded) === namespaces.default
	) {
		return localText;
	}
	return `${serializeCSSIdentifier(decoded)}|${localText}`;
}

/**
 * The namespaces a selector is read against: the sheet's default namespace, if
 * it declared one, and the prefixes it bound.
 */
interface SelectorNamespaces {
	default: string | null;
	prefixes: Map<string, string>;
}

const NO_NAMESPACES: SelectorNamespaces = {default: null, prefixes: new Map()};

/**
 * An attribute selector's name is never read against the default namespace: an
 * unprefixed attribute is always in no namespace.
 */
const ATTRIBUTE_NAMESPACES: SelectorNamespaces = {
	default: "",
	prefixes: new Map(),
};

/** An identifier as the selector source spelled it, re-escaped canonically. */
function serializeIdentifierSource(name: string): string {
	return serializeCSSIdentifier(cssTree.ident.decode(name));
}

/**
 * Serialize a group of selectors, per CSSOM: the selectors joined by ", ",
 * each simple selector in its canonical spelling -- identifiers escaped,
 * attribute values quoted, combinators spaced, An+B reduced.
 */
function serializeSelectorList(
	list: SelectorNode,
	namespaces: SelectorNamespaces = NO_NAMESPACES,
): string {
	return childrenOf(list)
		.map((selector) => serializeSelector(selector, namespaces))
		.join(", ");
}

function serializeSelector(
	selector: SelectorNode,
	namespaces: SelectorNamespaces = NO_NAMESPACES,
): string {
	let out = "";
	// A universal selector is written only when it stands alone in its
	// compound, or carries a namespace prefix.
	const parts = childrenOf(selector);
	for (const [index, part] of parts.entries()) {
		// A universal selector says nothing that the compound around it does
		// not already say, so it is written only when it stands alone.
		if (part.type === "TypeSelector") {
			const text = serializeQualifiedName(part.name as string, namespaces);
			const next = parts[index + 1];
			const alone = !next || next.type === "Combinator";
			if (text === "*" && !alone) continue;
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
				if (node.flags) out += ` ${node.flags.toLowerCase()}`;
			}
			return `${out}]`;
		}
		case "PseudoClassSelector":
		case "PseudoElementSelector": {
			const colons = node.type === "PseudoElementSelector" ? "::" : ":";
			const name = serializeIdentifierSource(
				(node.name as string).toLowerCase(),
			);
			const args = childrenOf(node);
			if (args.length === 0) return `${colons}${name}`;
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
			if (word === "even") return "2n";
			if (word === "odd") return "2n+1";
			return serializeIdentifierSource((node.name as string) ?? "");
		}
		case "String":
			return serializeCSSString(node.value?.value ?? "");
		case "Raw":
			return String((node as {value?: string}).value ?? "").trim();
		default:
			return "";
	}
}

/** `An+B` in the one spelling CSSOM writes: `2n`, `2n+1`, `-n+5`, `10`. */
function serializeAnPlusB(a: string | null, b: string | null): string {
	if (a === null) return String(Number(b ?? 0));
	const step = Number(a);
	let out = step === 1 ? "n" : step === -1 ? "-n" : `${step}n`;
	const offset = Number(b ?? 0);
	if (offset > 0) out += `+${offset}`;
	else if (offset < 0) out += `${offset}`;
	return out;
}

/**
 * A `getComputedStyle` pseudo-element argument, in its canonical spelling.
 *
 * "" means the argument names no pseudo-element and is ignored -- an argument
 * without a leading colon always is, which is how `getComputedStyle(el,
 * "before")` answers with the element's own style. Null means the argument
 * names something that is not a pseudo-element, for which an empty
 * declaration is the answer.
 */
function parsePseudoElementArgument(text: string): string | null {
	if (!text.startsWith(":")) return "";
	const double = text.startsWith("::");
	const name = text.slice(double ? 2 : 1);
	// One colon is the CSS 2 spelling, which only the four CSS 2
	// pseudo-elements answer to.
	if (!double && !LEGACY_PSEUDO_ELEMENTS.has(name.toLowerCase())) return null;
	const selectors = parseSelectorList(`*::${name}`);
	if (!selectors) return null;
	const compound = childrenOf(childrenOf(selectors)[0] ?? {type: ""});
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

/**
 * Parse a selector list, or null when it does not parse -- which includes a
 * pseudo this engine does not know, since an unknown pseudo makes the whole
 * selector invalid.
 */
function parseSelectorList(text: string): SelectorNode | null {
	let list: SelectorNode;
	try {
		list = cssTree.parse(String(text), {
			context: "selectorList",
			onParseError(error: Error) {
				throw error;
			},
		}) as unknown as SelectorNode;
	} catch {
		return null;
	}
	if (list.type !== "SelectorList") return null;
	let valid = true;
	const checkSimple = (node: SelectorNode): void => {
		if (!valid) return;
		switch (node.type) {
			case "PseudoClassSelector": {
				const name = (node.name as string).toLowerCase();
				// `:before` and friends are the CSS 2 spelling of a pseudo-element.
				if (!PSEUDO_CLASSES.has(name) && !LEGACY_PSEUDO_ELEMENTS.has(name)) {
					valid = false;
					return;
				}
				break;
			}
			case "PseudoElementSelector": {
				const name = (node.name as string).toLowerCase();
				if (!PSEUDO_ELEMENTS.has(name)) {
					valid = false;
					return;
				}
				if (!validPseudoElementArguments(name, childrenOf(node))) {
					valid = false;
					return;
				}
				break;
			}
			// A chunk the parser could not read is not a simple selector.
			case "Raw":
				valid = false;
				return;
		}
		// A functional pseudo's arguments are selectors only for the pseudos
		// that take them; `::part(title)` and `:lang(ja)` name something else,
		// and their arguments carry no selector to validate.
		for (const child of childrenOf(node)) {
			if (child.type === "SelectorList") checkList(child);
			else if (child.type === "Selector") checkSelector(child);
			else if (child.type === "Nth" && child.selector)
				checkList(child.selector);
		}
	};
	const checkSelector = (selector: SelectorNode): void => {
		const parts = childrenOf(selector);
		if (parts.length === 0) {
			valid = false;
			return;
		}
		for (const part of parts) checkSimple(part);
	};
	const checkList = (node: SelectorNode): void => {
		for (const selector of childrenOf(node)) checkSelector(selector);
	};
	checkList(list);
	return valid ? list : null;
}

/**
 * Whether a pseudo-element's arguments fit its grammar: the functional ones
 * take an identifier (or, for `::slotted`, a compound selector), and the rest
 * take nothing at all.
 */
function validPseudoElementArguments(
	name: string,
	args: SelectorNode[],
): boolean {
	if (!FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) return args.length === 0;
	if (args.length === 0) return false;
	if (name === "slotted") {
		return args.every((argument) => argument.type === "Selector");
	}
	const text = args
		.map((argument) =>
			argument.type === "Raw"
				? String((argument as {value?: string}).value ?? "")
				: "",
		)
		.join("")
		.trim();
	// `::picker` names the element whose picker it is, and nothing else does.
	if (name === "picker") return text === "select";
	return /^[a-zA-Z_\u0080-\uFFFF-][\w\u0080-\uFFFF-]*$/.test(text);
}

// ---- The text parser -------------------------------------------------------

/** A parsed rule, as the CSS parser hands it over. */
interface ParsedNode {
	type: string;
	name?: string;
	prelude?: {type: string; value?: string} | null;
	block?: {children: {toArray(): ParsedNode[]}} | null;
	property?: string;
	value?: {type: string; value?: string} | null;
	important?: boolean | string;
	children?: {toArray(): ParsedNode[]} | null;
}

function nodesOf(container: {
	children?: {toArray(): ParsedNode[]} | null;
}): ParsedNode[] {
	return container.children ? container.children.toArray() : [];
}

/** The declarations of a rule's block, in source order. */
function blockDeclarations(node: ParsedNode): CSSDeclaration[] {
	const declarations: CSSDeclaration[] = [];
	if (!node.block) return declarations;
	for (const child of nodesOf(node.block)) {
		if (child.type !== "Declaration") continue;
		const value = serializeCSSValue(cssTree.generate(child.value as never));
		if (!value) continue;
		declarations.push({
			name: normalizePropertyName(child.property ?? ""),
			value,
			important: child.important === true,
		});
	}
	return declarations;
}

/** A rule block's text, as a declaration block takes it. */
function blockText(node: ParsedNode): string {
	return blockDeclarations(node)
		.map(
			({name, value, important}) =>
				`${name}: ${value}${important ? " !important" : ""};`,
		)
		.join(" ");
}

/** Parse a rule list, as a sheet's text or a grouping rule's body. */
function parseRules(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule[] {
	let ast: {children: {toArray(): ParsedNode[]}};
	try {
		ast = cssTree.parse(text, {
			parseValue: false,
			parseAtrulePrelude: false,
			parseRulePrelude: false,
			parseCustomProperty: false,
		}) as never;
	} catch {
		return [];
	}
	return convertRules(ast.children.toArray(), sheet, parentRule);
}

/** One rule's text, as insertRule takes it. */
function parseRuleText(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule {
	const source = String(text ?? "");
	let ast: {children: {toArray(): ParsedNode[]}};
	try {
		ast = cssTree.parse(source, {
			parseValue: false,
			parseAtrulePrelude: false,
			parseRulePrelude: false,
			parseCustomProperty: false,
			onParseError(error: Error) {
				throw error;
			},
		}) as never;
	} catch {
		throw new DOMException(`Cannot parse rule: ${source}`, "SyntaxError");
	}
	const nodes = ast.children.toArray();
	if (nodes.length !== 1) {
		throw new DOMException(`Cannot parse rule: ${source}`, "SyntaxError");
	}
	const rule = convertRule(nodes[0], sheet, parentRule);
	if (!rule) {
		throw new DOMException(`Cannot parse rule: ${source}`, "SyntaxError");
	}
	return rule;
}

function convertRules(
	source: readonly ParsedNode[],
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule[] {
	const rules: CSSRule[] = [];
	for (const node of source) {
		const rule = convertRule(node, sheet, parentRule);
		if (rule) rules.push(rule);
	}
	return rules;
}

/** An at-rule's prelude, as written. */
function preludeText(node: ParsedNode): string {
	return (node.prelude?.value ?? "").trim();
}

function convertRule(
	node: ParsedNode,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule | null {
	if (node.type === "Rule") {
		const selectors = parseSelectorList(preludeText(node));
		if (!selectors) return null;
		return new CSSStyleRule(
			selectors,
			blockText(node),
			sheet,
			parentRule,
			(rule) => convertRules(nestedRules(node), sheet, rule),
		);
	}
	if (node.type !== "Atrule") return null;
	const prelude = preludeText(node);
	switch ((node.name ?? "").toLowerCase()) {
		case "media":
			return new CSSMediaRule(prelude, sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group),
			);
		case "supports":
			return new CSSSupportsRule(prelude, sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group),
			);
		case "container":
			return new CSSContainerRule(prelude, sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group),
			);
		case "scope":
			return new CSSScopeRule(prelude, sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group),
			);
		case "starting-style":
			return new CSSStartingStyleRule(sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group),
			);
		case "layer":
			return node.block
				? new CSSLayerBlockRule(prelude, sheet, parentRule, (group) =>
						convertRules(nodesOf(node.block ?? {}), sheet, group),
					)
				: new CSSLayerStatementRule(prelude, sheet, parentRule);
		case "import":
			return convertImportRule(prelude, sheet);
		case "namespace": {
			const match = /^(?:([^\s]+)\s+)?(.*)$/.exec(prelude);
			return new CSSNamespaceRule(
				match?.[1] ?? "",
				unwrapURL(match?.[2] ?? ""),
				sheet,
			);
		}
		case "font-face":
			return new CSSFontFaceRule(blockText(node), sheet, parentRule);
		case "page":
			return new CSSPageRule(prelude, blockText(node), sheet, parentRule);
		case "counter-style":
			return new CSSCounterStyleRule(prelude, blockText(node), sheet);
		case "property":
			return new CSSPropertyRule(prelude, blockText(node), sheet);
		case "font-feature-values":
			return new CSSFontFeatureValuesRule(prelude, node, sheet);
		case "font-palette-values":
			return new CSSFontPaletteValuesRule(prelude, blockText(node), sheet);
		case "keyframes":
		case "-webkit-keyframes":
			return new CSSKeyframesRule(prelude, sheet, (rule) =>
				nodesOf(node.block ?? {})
					.filter((frame) => frame.type === "Rule")
					.map(
						(frame) =>
							new CSSKeyframeRule(
								preludeText(frame),
								blockText(frame),
								sheet,
								rule,
							),
					),
			);
		// A charset rule is not exposed in a sheet's rule list, per CSSOM.
		case "charset":
			return null;
		default:
			return null;
	}
}

/** The style rules nested inside a style rule's own block. */
function nestedRules(node: ParsedNode): ParsedNode[] {
	return nodesOf(node.block ?? {}).filter(
		(child) => child.type === "Rule" || child.type === "Atrule",
	);
}

/** `url("x")` or `"x"` reduced to the URL it names. */
function unwrapURL(text: string): string {
	const trimmed = text.trim();
	const url = /^url\(\s*(.*?)\s*\)$/i.exec(trimmed);
	const body = url ? url[1] : trimmed;
	return /^["']/.test(body) ? body.slice(1, -1) : body;
}

/** `@import <url> [layer] [supports()] [media]`, split into its parts. */
function convertImportRule(
	prelude: string,
	sheet: CSSStyleSheet | null,
): CSSImportRule {
	let rest = prelude.trim();
	const head = /^(url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')/.exec(
		rest,
	);
	const href = unwrapURL(head?.[1] ?? "");
	rest = rest.slice(head?.[1].length ?? 0).trim();

	let layerName: string | null = null;
	const layer = /^layer(?:\(\s*([^)]*)\s*\))?/i.exec(rest);
	if (layer) {
		layerName = layer[1]?.trim() ?? "";
		rest = rest.slice(layer[0].length).trim();
	}

	let supportsText: string | null = null;
	if (/^supports\(/i.test(rest)) {
		// The condition nests parentheses -- `supports((a: b) or (c: d))` --
		// so its end is the parenthesis that closes the one it opened.
		let depth = 0;
		let end = rest.length;
		for (let i = "supports(".length - 1; i < rest.length; i++) {
			if (rest[i] === "(") depth++;
			else if (rest[i] === ")" && --depth === 0) {
				end = i;
				break;
			}
		}
		supportsText = rest.slice("supports(".length, end).trim();
		rest = rest.slice(end + 1).trim();
	}

	return new CSSImportRule(href, rest, layerName, supportsText, sheet);
}

// Assigning a rule's text does nothing, as in every engine -- but the
// attribute exists, so every rule type carries the setter alongside the
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
	// The getter may live on a base class, so the chain is walked for it.
	let prototype: object | null = type.prototype;
	let descriptor: PropertyDescriptor | undefined;
	while (prototype && !descriptor) {
		descriptor = Object.getOwnPropertyDescriptor(prototype, "cssText");
		prototype = Object.getPrototypeOf(prototype);
	}
	if (!descriptor?.get) continue;
	Object.defineProperty(type.prototype, "cssText", {
		...descriptor,
		set() {},
	});
}

/** The one sheet a `<style>` (or `<link>`) element owns. */
const elementSheets = new WeakMap<Element, CSSStyleSheet>();

/** The sheets a document or shadow root has adopted. */
const adoptedSheets = new WeakMap<Node, CSSStyleSheet[]>();

/** The `document.styleSheets` getter jsdom installed, before it was replaced. */
const nativeStyleSheets = new WeakMap<object, () => {length: number}>();

/** Marks a prototype whose CSSOM accessors are already the engine's. */
const kStyleSheetsInstalled = Symbol("termdom.styleSheets");

function sheetFor(element: Element): CSSStyleSheet {
	let sheet = elementSheets.get(element);
	if (!sheet) {
		sheet = new CSSStyleSheet({}, element);
		sheetNotifiers.set(sheet, () => {
			const window = element.ownerDocument?.defaultView;
			if (window) styleManagers.get(window)?.refreshStylesheets();
		});
		elementSheets.set(element, sheet);
	}
	return sheet;
}

/** The list object jsdom keeps behind its own styleSheets accessor. */
const nativeSheetLists = new WeakMap<Document, {length: number}>();

/**
 * The `<style>` elements a document holds, as a bare length to poll.
 *
 * jsdom maintains this list as it parses style elements, so a length read
 * answers "has a sheet appeared" without walking the tree -- cheap enough to
 * ask on every computed-style read. The real list lives on the wrapper's impl
 * object, behind the "impl" symbol.
 */
export function documentStyleSheetList(document: Document): {length: number} {
	let list = nativeSheetLists.get(document);
	if (list === undefined) {
		const native = nativeStyleSheets.get(document.constructor.prototype);
		const wrapper = native ? native.call(document) : null;
		const implSymbol = wrapper
			? Object.getOwnPropertySymbols(wrapper).find(
					(symbol) => symbol.description === "impl",
				)
			: undefined;
		list = implSymbol
			? ((wrapper as any)[implSymbol] as {length: number})
			: (wrapper ?? {length: 0});
		nativeSheetLists.set(document, list);
	}
	return list;
}

/**
 * A document's stylesheets: one per `<style>` element in tree order, followed
 * by what the document adopted. A `<link>` never resolves to a sheet -- there
 * is no network behind a terminal document.
 */
export function documentStyleSheets(document: Document): CSSStyleSheet[] {
	const sheets: CSSStyleSheet[] = [];
	for (const element of document.querySelectorAll("style")) {
		sheets.push(sheetFor(element));
	}
	sheets.push(...(adoptedSheets.get(document) ?? []));
	return sheets;
}

/** A shadow root's stylesheets: its own `<style>` elements, then what it adopted. */
export function shadowStyleSheets(root: ShadowRoot): CSSStyleSheet[] {
	const sheets: CSSStyleSheet[] = [];
	for (const element of root.querySelectorAll("style")) {
		sheets.push(sheetFor(element));
	}
	sheets.push(...(adoptedSheets.get(root) ?? []));
	return sheets;
}

/**
 * Adopt a list of constructed sheets, and wire each one's later mutations to
 * the cascade -- a constructed sheet has no consumer until something adopts it.
 */
function adopt(window: DOMWindow, target: Node, sheets: unknown): void {
	const list: CSSStyleSheet[] = [];
	for (const sheet of Array.from(sheets as Iterable<unknown>)) {
		if (!(sheet instanceof CSSStyleSheet)) {
			throw new TypeError("adoptedStyleSheets takes CSSStyleSheet objects");
		}
		if (!constructedSheets.has(sheet)) {
			throw new DOMException(
				"Can't adopt a stylesheet that was not constructed",
				"NotAllowedError",
			);
		}
		sheetNotifiers.set(sheet, () =>
			styleManagers.get(window)?.refreshStylesheets(),
		);
		list.push(sheet);
	}
	adoptedSheets.set(target, list);
}

/**
 * Put this engine's CSSOM behind the document's stylesheet surface: a style
 * element's `sheet`, `document.styleSheets`, and the adopted lists.
 */
export function installStyleSheets(window: DOMWindow): void {
	const owner = window as unknown as Record<string | symbol, unknown>;
	if (owner[kStyleSheetsInstalled]) return;
	owner[kStyleSheetsInstalled] = true;

	const documentPrototype = window.Document.prototype;
	const nativeGetter = Object.getOwnPropertyDescriptor(
		documentPrototype,
		"styleSheets",
	)?.get;
	if (nativeGetter) {
		nativeStyleSheets.set(
			documentPrototype,
			nativeGetter as () => {length: number},
		);
	}

	Object.defineProperty(documentPrototype, "styleSheets", {
		get(this: Document) {
			const sheets = documentStyleSheets(this);
			return indexed(new StyleSheetList(sheets), sheets);
		},
		configurable: true,
		enumerable: true,
	});

	for (const prototype of [documentPrototype, window.ShadowRoot?.prototype]) {
		if (!prototype) continue;
		Object.defineProperty(prototype, "adoptedStyleSheets", {
			get(this: Node) {
				let list = adoptedSheets.get(this);
				if (!list) adoptedSheets.set(this, (list = []));
				return list;
			},
			set(this: Node, sheets: unknown) {
				adopt(window, this, sheets);
				styleManagers.get(window)?.refreshStylesheets();
			},
			configurable: true,
			enumerable: true,
		});
	}

	if (window.ShadowRoot) {
		Object.defineProperty(window.ShadowRoot.prototype, "styleSheets", {
			get(this: ShadowRoot) {
				const sheets = shadowStyleSheets(this);
				return indexed(new StyleSheetList(sheets), sheets);
			},
			configurable: true,
			enumerable: true,
		});
	}

	Object.defineProperty(window.HTMLStyleElement.prototype, "sheet", {
		get(this: Element) {
			// A style element outside a tree has no sheet, as in a browser.
			return this.parentNode ? sheetFor(this) : null;
		},
		configurable: true,
		enumerable: true,
	});

	// Nothing is fetched over a terminal's document, so a link never resolves
	// to a sheet.
	Object.defineProperty(window.HTMLLinkElement.prototype, "sheet", {
		get() {
			return null;
		},
		configurable: true,
		enumerable: true,
	});

	Object.assign(window, {
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
		MediaList,
		CSSStyleDeclaration,
		CSS: CSSNamespace,
	});
}

/** The UA document sheet, parsed once: its rules never change. */
let uaDocumentSheet: CSSStyleSheet | null = null;

export function uaStyleSheet(): CSSStyleSheet {
	if (!uaDocumentSheet) {
		uaDocumentSheet = new CSSStyleSheet();
		uaDocumentSheet.replaceSync(UA_DOCUMENT_STYLES);
	}
	return uaDocumentSheet;
}

/** The epoch a declaration with no manager behind it watches: one that never moves. */
const NO_STYLE_EPOCH = {value: 0};

export class ComputedStyleDeclaration extends CSSStyleDeclaration {
	#element: Element;
	#cssRules: ParsedCSSRule[];
	/**
	 * The manager to re-ask for matching rules, and the epoch it bumps when
	 * every declaration goes stale at once. A computed style is LIVE: the
	 * object an author holds keeps answering the element's current values
	 * across class flips, rule insertions and sheet replacements, so it
	 * re-resolves rather than being replaced.
	 */
	#manager: StyleManager | null = null;
	#epoch = NO_STYLE_EPOCH;
	#seenEpoch = 0;
	#stale = false;
	// Lazily resolved properties -- INCLUDING ones that resolved to "".
	// Values here are COMPUTED strings, materialized once per property per
	// generation; an initial-valued property (word-break, visibility, ...)
	// that re-resolved on every read would re-walk the whole ancestor chain
	// for an inherited property, and each ancestor's own read does the same
	// -- thousands of full cascade resolutions per keystroke. The
	// declaration is discarded wholesale on invalidation, so memoizing here
	// needs no invalidation of its own.
	#resolved = new Map<string, string>();

	constructor(
		element: Element,
		cssRules: ParsedCSSRule[] = [],
		manager?: StyleManager,
	) {
		super();
		this.#element = element;
		this.#cssRules = cssRules;
		if (manager) {
			this.#manager = manager;
			this.#epoch = manager.styleEpoch;
			this.#seenEpoch = this.#epoch.value;
		}
	}

	/** Mark this declaration's values as belonging to a cascade that has moved on. */
	invalidate(): void {
		this.#stale = true;
	}

	/**
	 * Re-resolve against the current cascade. Reads take the two-field guard
	 * inline and call this only when it has actually moved -- this sits on the
	 * hottest path in the engine, under every property read of every element.
	 */
	#refresh(): void {
		if (!this.#manager) return;
		this.#stale = false;
		this.#seenEpoch = this.#epoch.value;
		this.#cssRules = this.#manager.matchingRules(this.#element);
		this.#resolved.clear();
	}

	/**
	 * The element's inline declarations, expanded to longhands.
	 *
	 * The store behind `element.style` is this engine's own CSSOM, which keeps
	 * a declaration as authored and hands the cascade the expanded block --
	 * so a shorthand's `!important` covers every longhand it declares.
	 */
	#inlineDeclarations(): DeclarationBlock {
		const style = (this.#element as HTMLElement).style;
		return style instanceof CSSStyleDeclaration
			? style.declarationBlock()
			: EMPTY_DECLARATIONS;
	}

	/** This element's flat-tree parent's resolved value for `property`, or null at the root. */
	#resolveFromParent(property: string): string | null {
		const window = this.#element.ownerDocument?.defaultView;
		const parent = compositionParentElement(this.#element);
		if (!window || !parent) return null;
		return window.getComputedStyle(parent).getPropertyValue(property) || null;
	}

	/**
	 * Resolve `var(--name[, fallback])` references in a declared value.
	 *
	 * Custom properties always inherit (they aren't subject to the fixed
	 * INHERITED_PROPERTIES list), so lookup walks the element's own inline style
	 * and matching rules first, then the parent chain via getComputedStyle --
	 * which recurses through this same substitution at each ancestor, so a
	 * custom property whose own value references another var() resolves too.
	 * A depth guard stops a property that (invalidly) refers to itself.
	 */
	#substituteVar(value: string, depth = 0): string {
		if (depth > 8 || !value.includes("var(")) return value;

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
				if (value[j] === "(") parenDepth++;
				else if (value[j] === ")") parenDepth--;
			}
			const inner = value.slice(start + 4, j - 1);
			const commaIndex = inner.indexOf(",");
			const name = (
				commaIndex === -1 ? inner : inner.slice(0, commaIndex)
			).trim();
			const fallback =
				commaIndex === -1 ? undefined : inner.slice(commaIndex + 1).trim();

			const resolved = this.#resolveCustomProperty(name);
			if (resolved !== null) {
				out += this.#substituteVar(resolved, depth + 1);
			} else if (fallback !== undefined) {
				out += this.#substituteVar(fallback, depth + 1);
			}
			// Neither a value nor a fallback: the guaranteed-invalid value -- omit,
			// which approximates the property's own initial/inherited fallback.

			i = j;
		}
		return out;
	}

	#resolveCustomProperty(name: string): string | null {
		// A custom property is just an ordinary (always-inherited) cascade lookup
		// -- #resolvePropertyValueRaw's step 4 already walks ancestors for it.
		return this.#resolvePropertyValueRaw(name) || null;
	}

	/**
	 * Resolve property value applying CSS cascade: inline styles > CSS rules >
	 * defaults, with `!important` promoted above all of that (an important
	 * stylesheet rule beats even a non-important inline style, per spec), and
	 * `var()` references substituted in whatever wins.
	 */
	#resolvePropertyValue(property: string): string {
		const raw = this.#resolvePropertyValueRaw(property);
		const value = raw ? this.#substituteVar(raw) : raw;
		// `currentcolor` is the element's own color, which is what a resolved
		// value says; on `color` itself it means the parent's.
		if (
			value.toLowerCase() === "currentcolor" &&
			COLOR_PROPERTIES.has(property)
		) {
			return property === "color"
				? (this.#resolveFromParent("color") ?? "")
				: this.getPropertyValue("color");
		}
		return value;
	}

	#resolvePropertyValueRaw(property: string): string {
		const inline = this.#inlineDeclarations();
		const inlineValue = inline.declarations[property]?.trim();
		const inlineUsable = !!inlineValue && !INITIAL_KEYWORDS.has(inlineValue);
		const inlineImportant = inlineUsable && !!inline.important[property];

		// `inherit` skips the rest of the cascade and goes straight to the parent's
		// resolved value, regardless of whether this property normally inherits.
		if (inlineUsable && inlineValue === "inherit") {
			return this.#resolveFromParent(property) ?? "";
		}

		// 1 & 2. Inline style and stylesheet rules, with an !important tier above
		// the normal cascade. #cssRules is pre-sorted by specificity/source order,
		// so within each tier the last match wins.
		let ruleValue: string | null = null;
		let importantRuleValue: string | null = null;
		for (const rule of this.#cssRules) {
			const value = rule.declarations[property];
			if (value === undefined) continue;
			if (rule.important[property]) {
				importantRuleValue = value;
			} else {
				ruleValue = value;
			}
		}

		// A CSS-wide keyword a rule declares is not a value: `inherit` takes the
		// parent's, and the rest send resolution on to the defaults below, as
		// though the declaration were not there.
		const declaredByRule = (value: string): string | null => {
			if (value === "inherit") return this.#resolveFromParent(property) ?? "";
			return INITIAL_KEYWORDS.has(value) ? null : value;
		};

		if (inlineImportant) return inlineValue;
		if (importantRuleValue) {
			const resolved = declaredByRule(importantRuleValue);
			if (resolved !== null) return resolved;
		} else if (inlineUsable) {
			return inlineValue;
		} else if (ruleValue) {
			const resolved = declaredByRule(ruleValue);
			if (resolved !== null) return resolved;
		}

		// 3. Check element-specific UA defaults (e.g., strong { font-weight: bold })
		// These take priority over inherited values
		const tagName = this.#element.tagName.toLowerCase();

		// A list's marker gutter is sized to its widest marker rather than taken
		// from the static table, so it has to be resolved before it.
		if (
			property === "padding-left" &&
			(tagName === "ul" || tagName === "ol") &&
			this.#element.ownerDocument?.defaultView
		) {
			return `${getListGutterWidth(this.#element)}ch`;
		}

		// The UA default marker type depends on nesting depth, exactly as a browser's
		// `ul ul { list-style-type: circle }` rules do. Resolving it here rather than
		// inheriting means an author value on an outer list does not leak into a
		// nested one, while an author rule that matches the nested list still wins:
		// it was already returned in step 2.
		if (
			property === "list-style-type" &&
			(tagName === "ul" || tagName === "ol")
		) {
			if (tagName === "ol") return "decimal";
			const bullets = ["disc", "circle", "square"];
			const depth = listNestingDepth(this.#element);
			return bullets[Math.min(depth, bullets.length - 1)];
		}

		const elementDefaults = getElementDefaults(this.#element);
		if (elementDefaults && elementDefaults[property]) {
			return elementDefaults[property];
		}

		// 4. For inherited properties, walk up the DOM using getComputedStyle
		// which correctly resolves CSS rules on parent elements. Custom properties
		// (--x) always inherit -- there's no fixed list for them to be in.
		if (INHERITED_PROPERTIES.has(property) || property.startsWith("--")) {
			const window = this.#element.ownerDocument?.defaultView;
			if (window) {
				// Flat-tree parents: inheritance crosses the shadow boundary
				// (host -> shadow child) and reaches slotted content through
				// its slot's chain, exactly as in a browser.
				for (
					let parent = compositionParentElement(this.#element);
					parent !== null;
					parent = compositionParentElement(parent)
				) {
					const parentValue = window
						.getComputedStyle(parent)
						.getPropertyValue(property);
					if (parentValue) {
						return parentValue;
					}
				}
			}
		}

		// 5. Fallback to universal defaults and CSS spec defaults
		return getInitialStyle(this.#element, property);
	}

	// Resolution is fully lazy: construction populates nothing, and each
	// property resolves on first read, then answers from the memo. Most
	// elements are only ever asked a handful of properties -- the
	// composition walker asks each element `display` alone.
	override getPropertyValue(property: string): string {
		if (this.#stale || this.#epoch.value !== this.#seenEpoch) this.#refresh();
		let value = this.#resolved.get(property);
		if (value === undefined) {
			// A shorthand answers as its longhands, each in its own computed
			// spelling, collapsed: `margin: 10px 10px 10px 10px` is "10px".
			const longhands = SHORTHAND_LONGHANDS.get(property);
			value = longhands
				? serializeShorthandValue(
						property,
						longhands,
						(longhand) =>
							this.getPropertyValue(longhand) ||
							CSS_INITIAL_VALUES[longhand] ||
							"",
					)
				: computedValue(property, this.#resolvePropertyValue(property));
			this.#resolved.set(property, value);
		}
		return value;
	}

	/** Computed styles are read-only; writing one is an error, not a no-op. */
	override setProperty(): void {
		throw readOnlyDeclaration();
	}

	override removeProperty(): string {
		throw readOnlyDeclaration();
	}

	override getPropertyPriority(): string {
		return "";
	}

	/**
	 * A computed style declares every supported longhand, so its indices name
	 * them in the property index's order rather than the order reads happened
	 * to resolve them in.
	 */
	override item(index: number): string {
		return CSS_LONGHANDS[index] ?? "";
	}

	override get length(): number {
		return CSS_LONGHANDS.length;
	}

	override [Symbol.iterator](): IterableIterator<string> {
		return CSS_LONGHANDS[Symbol.iterator]();
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration();
	}

	override get parentRule(): CSSRule | null {
		return null;
	}
}

/**
 * Whether an element takes part in rendering: it is in a document, and the
 * flat tree that document composes reaches it. A light-DOM child its host
 * never slots is in neither, and has no computed style to report.
 */
function isBeingRendered(element: Element): boolean {
	// Walk out through every shadow root the element sits under: a tree whose
	// outermost root is the document is composed into the rendering, and one
	// that ends in a bare fragment is not.
	let node: Node = element;
	for (let depth = 0; depth < 32; depth++) {
		const root = node.getRootNode();
		if (root === element.ownerDocument) break;
		const host = (root as ShadowRoot).host;
		if (!host) return false;
		node = host;
	}
	// A light-DOM child an open shadow root never slots is outside the flat
	// tree. A closed root is this engine's own widget internals, whose parts
	// the widget itself reads styles for.
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

/**
 * A pseudo-element's computed style: a flat declaration set -- the matched
 * rules plus what it inherits from its originating element -- read through
 * the same computed-value boundary as an element's.
 */
export class PseudoStyleDeclaration extends CSSStyleDeclaration {
	#declarations: Record<string, string>;
	#resolved = new Map<string, string>();

	constructor(declarations: Record<string, string>) {
		super();
		this.#declarations = declarations;
	}

	override getPropertyValue(property: string): string {
		let value = this.#resolved.get(property);
		if (value === undefined) {
			const longhands = SHORTHAND_LONGHANDS.get(property);
			value =
				longhands && this.#declarations[property] === undefined
					? serializeShorthandValue(
							property,
							longhands,
							(longhand) =>
								this.getPropertyValue(longhand) ||
								CSS_INITIAL_VALUES[longhand] ||
								"",
						)
					: computedValue(property, this.#declarations[property] ?? "");
			this.#resolved.set(property, value);
		}
		return value;
	}

	override setProperty(): void {
		throw readOnlyDeclaration();
	}

	override removeProperty(): string {
		throw readOnlyDeclaration();
	}

	override getPropertyPriority(): string {
		return "";
	}

	/**
	 * A pseudo-element's computed style declares every supported longhand,
	 * exactly as an element's does.
	 */
	override item(index: number): string {
		return CSS_LONGHANDS[index] ?? "";
	}

	override get length(): number {
		return CSS_LONGHANDS.length;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration();
	}
}

/**
 * The answer to a `getComputedStyle` pseudo-element argument that names no
 * pseudo-element: a declaration of nothing, as CSSOM says.
 */
export class EmptyStyleDeclaration extends CSSStyleDeclaration {
	override getPropertyValue(): string {
		return "";
	}

	override getPropertyPriority(): string {
		return "";
	}

	override setProperty(): void {
		throw readOnlyDeclaration();
	}

	override removeProperty(): string {
		throw readOnlyDeclaration();
	}

	override item(): string {
		return "";
	}

	override get length(): number {
		return 0;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration();
	}
}

/** A computed style is read-only; writing one is an error, not a no-op. */
function readOnlyDeclaration(): DOMException {
	return new DOMException(
		"A computed style declaration is read-only",
		"NoModificationAllowedError",
	);
}

/**
 * The property accessors (`style.fontWeight`) callers reach for alongside
 * getPropertyValue, installed once for the properties this engine resolves.
 */
const ACCESSOR_PROPERTIES = new Set<string>([
	...LENGTH_PROPERTIES,
	...COLOR_PROPERTIES,
	...INHERITED_PROPERTIES,
	...BOX_SHORTHAND_LONGHANDS.keys(),
	"align-content",
	"align-items",
	"align-self",
	"background",
	"background-image",
	"background-position",
	"background-repeat",
	"border",
	"border-collapse",
	"border-color",
	"border-radius",
	"border-style",
	"border-bottom-color",
	"border-bottom-style",
	"border-left-color",
	"border-left-style",
	"border-right-color",
	"border-right-style",
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
	const camelCase = property.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
	for (const name of new Set([property, camelCase])) {
		for (const prototype of [
			ComputedStyleDeclaration.prototype,
			PseudoStyleDeclaration.prototype,
		]) {
			if (name in prototype) continue;
			Object.defineProperty(prototype, name, {
				get(this: ComputedStyleDeclaration | PseudoStyleDeclaration) {
					return this.getPropertyValue(property);
				},
				configurable: true,
			});
		}
	}
}

// ============================================================================
// BORDER UTILITIES
// ============================================================================

export enum BorderEdgeStyle {
	// Style values (bits 3-0)
	None = 0b0000,
	Dotted = 0b0001,
	Dashed = 0b0010,
	Solid = 0b0011,
	Groove = 0b0100,
	Ridge = 0b0101,
	Inset = 0b0110,
	Outset = 0b0111,
	Double = 0b1000,
	Hidden = 0b1111,

	// Flags (bit 4+)
	Rounded = 0b00010000,
}

interface BoxCharSet {
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
}

export const BOX_DRAWING: Record<string, BoxCharSet> = {
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
	lightRounded: {
		horizontal: "─",
		vertical: "│",
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	},
};

/**
 * Resolve border styles for an element, returning per-edge encoded data
 */
export function resolveBorderStyles(element: Element): {
	topEdge: number;
	rightEdge: number;
	bottomEdge: number;
	leftEdge: number;
	hasAnyBorder: boolean;
} {
	const computedStyle =
		element.ownerDocument.defaultView!.getComputedStyle(element);

	// Helper to encode individual edge
	const encodeEdge = (
		width: string,
		style: string,
		isRounded: boolean,
	): number => {
		const parsed = parseBorderWidthValue(width);
		const widthValue = typeof parsed === "number" ? parsed : NaN;
		if (isNaN(widthValue) || widthValue <= 0 || !style || style === "none") {
			return 0;
		}

		let edgeValue = 0;
		switch (style) {
			case "solid":
				edgeValue = BorderEdgeStyle.Solid;
				break;
			case "double":
				edgeValue = BorderEdgeStyle.Double;
				break;
			case "dashed":
				edgeValue = BorderEdgeStyle.Dashed;
				break;
			case "dotted":
				edgeValue = BorderEdgeStyle.Dotted;
				break;
			case "groove":
				edgeValue = BorderEdgeStyle.Groove;
				break;
			case "ridge":
				edgeValue = BorderEdgeStyle.Ridge;
				break;
			case "inset":
				edgeValue = BorderEdgeStyle.Inset;
				break;
			case "outset":
				edgeValue = BorderEdgeStyle.Outset;
				break;
			case "hidden":
				edgeValue = BorderEdgeStyle.Hidden;
				break;
			default:
				edgeValue = BorderEdgeStyle.Solid;
		}

		if (isRounded) {
			edgeValue |= BorderEdgeStyle.Rounded;
		}

		return edgeValue;
	};

	// Check for border-radius (applies to all corners)
	const borderRadius = parseFloat(
		computedStyle.getPropertyValue("border-radius"),
	);
	const hasRadius = !isNaN(borderRadius) && borderRadius > 0;

	// Resolve individual edges
	const topWidth =
		computedStyle.getPropertyValue("border-top-width") ||
		computedStyle.getPropertyValue("border-width");
	const topStyle =
		computedStyle.getPropertyValue("border-top-style") ||
		computedStyle.getPropertyValue("border-style");

	const rightWidth =
		computedStyle.getPropertyValue("border-right-width") ||
		computedStyle.getPropertyValue("border-width");
	const rightStyle =
		computedStyle.getPropertyValue("border-right-style") ||
		computedStyle.getPropertyValue("border-style");

	const bottomWidth =
		computedStyle.getPropertyValue("border-bottom-width") ||
		computedStyle.getPropertyValue("border-width");
	const bottomStyle =
		computedStyle.getPropertyValue("border-bottom-style") ||
		computedStyle.getPropertyValue("border-style");

	const leftWidth =
		computedStyle.getPropertyValue("border-left-width") ||
		computedStyle.getPropertyValue("border-width");
	const leftStyle =
		computedStyle.getPropertyValue("border-left-style") ||
		computedStyle.getPropertyValue("border-style");

	// Encode each edge
	const topEdge = encodeEdge(topWidth, topStyle, hasRadius);
	const rightEdge = encodeEdge(rightWidth, rightStyle, hasRadius);
	const bottomEdge = encodeEdge(bottomWidth, bottomStyle, hasRadius);
	const leftEdge = encodeEdge(leftWidth, leftStyle, hasRadius);

	return {
		topEdge,
		rightEdge,
		bottomEdge,
		leftEdge,
		hasAnyBorder:
			topEdge > 0 || rightEdge > 0 || bottomEdge > 0 || leftEdge > 0,
	};
}

/** Roman numeral for 1-3999; callers must range-check. */
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

/** How many lists this element is nested inside, not counting itself. */
function listNestingDepth(element: Element): number {
	let depth = 0;
	for (
		let parent = element.parentElement;
		parent;
		parent = parent.parentElement
	) {
		if (parent.tagName === "UL" || parent.tagName === "OL") depth++;
	}
	return depth;
}

/** Marker glyphs for the bullet list-style-types. */
const BULLET_MARKERS: Record<string, string> = {
	disc: "\u2022",
	circle: "\u25e6",
	square: "\u25aa",
};

/** list-style-types that produce a counter, and therefore a trailing "." */
const COUNTER_STYLES = new Set([
	"decimal",
	"decimal-leading-zero",
	"lower-alpha",
	"lower-latin",
	"upper-alpha",
	"upper-latin",
	"lower-roman",
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

/**
 * The ordinal of a list item, honouring the HTML list attributes.
 *
 * `<ol start>` sets where counting begins, `<ol reversed>` counts down, and a
 * `<li value>` resets the counter mid-list and carries forward from there.
 */
function listItemOrdinal(listItem: Element, listParent: Element): number {
	const items = Array.from(listParent.children).filter(
		(child) => child.tagName === "LI",
	);

	const reversed = listParent.hasAttribute("reversed");
	const start = parseInt(listParent.getAttribute("start") ?? "", 10);

	let counter = Number.isFinite(start) ? start : reversed ? items.length : 1;

	for (const item of items) {
		const value = parseInt(item.getAttribute("value") ?? "", 10);
		if (Number.isFinite(value)) counter = value;
		if (item === listItem) return counter;
		counter += reversed ? -1 : 1;
	}

	return counter;
}

/** Render an ordinal in a counter style, falling back to decimal out of range. */
function formatOrdinal(ordinal: number, listStyleType: string): string {
	switch (listStyleType) {
		case "decimal-leading-zero":
			return ordinal >= 0 && ordinal < 10 ? `0${ordinal}` : `${ordinal}`;
		case "lower-alpha":
		case "lower-latin":
			return ordinal > 0 ? toAlpha(ordinal) : `${ordinal}`;
		case "upper-alpha":
		case "upper-latin":
			return ordinal > 0 ? toAlpha(ordinal).toUpperCase() : `${ordinal}`;
		case "lower-roman":
			// Roman numerals are undefined outside 1-3999; CSS falls back to decimal.
			return ordinal > 0 && ordinal < 4000
				? toRoman(ordinal).toLowerCase()
				: `${ordinal}`;
		case "upper-roman":
			return ordinal > 0 && ordinal < 4000 ? toRoman(ordinal) : `${ordinal}`;
		default:
			return `${ordinal}`;
	}
}

/**
 * The default marker text for a list item, e.g. "\u2022" or "iii.".
 *
 * Keyed off the *computed* list-style-type, not the parent's tag name: a `ul`
 * can be `list-style-type: decimal` and an `ol` can be `disc`, and either can be
 * `none`. Reading the type off the tag made all three impossible, and ignored a
 * list-style-type set on the `li` itself.
 */
function getListMarker(listItem: Element, listParent: Element): string {
	const window = listItem.ownerDocument.defaultView;
	if (!window) return "";

	const listStyleType = window
		.getComputedStyle(listItem)
		.getPropertyValue("list-style-type");

	if (!listStyleType || listStyleType === "none") return "";

	const bullet = BULLET_MARKERS[listStyleType];
	if (bullet) return bullet;

	if (COUNTER_STYLES.has(listStyleType)) {
		const items = Array.from(listParent.children).filter(
			(child) => child.tagName === "LI",
		);
		if (!items.includes(listItem)) return "";
		return `${formatOrdinal(listItemOrdinal(listItem, listParent), listStyleType)}.`;
	}

	return "";
}

// TODO: Just use the CSSOM CSSRule interface from the DOM
interface ParsedCSSRule {
	selector: string;
	declarations: Record<string, string>;
	/** Properties declared `!important` in this rule. */
	important: Record<string, boolean>;
	specificity: string; // Zero-padded string for lexicographic comparison
	pseudoElement?: string;
	/**
	 * The tree scope whose stylesheet declared this rule: a ShadowRoot for
	 * rules from a shadow tree's <style>, undefined for document rules. A
	 * rule only ever matches elements of its own tree -- the cascade's
	 * encapsulation boundary in both directions.
	 */
	scope?: Node;
	/**
	 * Parsed form of a `:host`-prefixed selector (only meaningful with a
	 * shadow `scope`): `predicate` is the parenthesized/compound condition
	 * the HOST must match (null = unconditional), `rest` targets descendant
	 * shadow-tree elements (null = the rule styles the host itself), and
	 * `child` restricts `rest` to direct children of the shadow root.
	 */
	host?: {predicate: string | null; rest: string | null; child: boolean};
	/**
	 * True for rules declared by a UA-internal shadow tree's stylesheet.
	 * Cascade ORIGIN, the tier above specificity: every author rule beats
	 * every UA rule, which is what lets `input::placeholder { color }`
	 * override the UA sheet's gray despite the UA attribute selector's
	 * higher specificity -- exactly the browser's origin ordering.
	 */
	uaOrigin?: boolean;
}

// CSS Counter interfaces
interface CounterState {
	[counterName: string]: number;
}

interface CounterScope {
	element: Element;
	counters: CounterState;
	parent?: CounterScope;
}

export class StyleManager {
	#computedStyleCache = new WeakMap<Element, ComputedStyleDeclaration>();
	/**
	 * The counter every computed style watches. A bump means the whole cascade
	 * changed -- new rules, a new sheet -- and every declaration handed out
	 * must resolve again.
	 */
	#styleEpoch = {value: 0};
	/**
	 * Every shadow root whose <style> elements participate in the cascade.
	 * jsdom never parses shadow stylesheets (shadowRoot.styleSheets does not
	 * exist), so parsing walks these and feeds each <style>'s text through
	 * the same CSSOM parser jsdom uses for document sheets.
	 */
	#shadowRoots = new Set<ShadowRoot>();
	#pseudoElementStyleCache = new WeakMap<
		Element,
		Map<string, Record<string, string>>
	>();
	#parsedRules: ParsedCSSRule[] = [];
	#stylesheetsDirty = false;
	/**
	 * Whether any parsed selector can reach OUTSIDE the mutated element's
	 * subtree: sibling combinators reach following siblings, :has() reaches
	 * ancestors. Set during parsing, read by invalidationScopeFor() to decide
	 * how much layout a class/id flip must rebuild. String tests are
	 * deliberately loose (`~=` in an attribute selector counts as a sibling
	 * combinator): a false positive only widens the rebuild.
	 */
	#selectorsReachSiblings = false;
	#selectorsReachAncestors = false;
	/**
	 * Rule-existence gates, also set during parsing. Attaching pseudos and
	 * initializing counters both start by building full computed-style
	 * declarations -- per element, on every insertion and attribute change.
	 * A document whose sheets declare no ::before for divs and no counters
	 * anywhere must not pay that; these let the hot paths answer "could any
	 * rule possibly apply here" with a few matches() calls instead.
	 */
	#pseudoRulesByType = new Map<string, ParsedCSSRule[]>();
	#counterRulesExist = false;
	#listItemRulesExist = false;
	// The `:focus-visible` state, driven by TermDOM from the last input modality
	// (keyboard true, pointer false). #ruleMatches gates such rules on it.
	#focusVisibleActive = true;
	/**
	 * How many document.styleSheets the last parse consumed; -1 = never
	 * parsed. A changed count re-parses on the next style computation --
	 * which is what lets a sheet appended right before the first paint
	 * apply even when no MutationObserver is attached. (The old sentinel
	 * was #parsedRules.length === 0, which stopped meaning "never parsed"
	 * the moment the UA document sheet guaranteed one rule.)
	 */
	#parsedStyleSheetCount = -1;

	// CSS Counter support
	#counterScopes = new WeakMap<Element, CounterScope>();

	// The document is fixed for the window's lifetime, so hold it directly rather
	// than reaching through window.document on every access. JSDOM's window is a
	// global proxy whose .document getter can transiently resolve to undefined
	// under a fast async render loop (a mutation-observer-driven animation), which
	// crashed style computation mid-frame. The Document object itself stays valid,
	// so a direct reference sidesteps the flaky getter.
	#document: Document;
	#window: DOMWindow;
	#layoutEngine?: LayoutEngine;

	constructor(window: DOMWindow, layoutEngine?: LayoutEngine) {
		this.#window = window;
		this.#layoutEngine = layoutEngine;
		this.#document = window.document;

		// The list gutter is resolved inside the cascade, which cannot reach a
		// StyleManager any other way. See getListGutterWidth().
		styleManagers.set(window, this);

		// Override window.getComputedStyle with our cached version
		window.getComputedStyle = this.#getComputedStyle.bind(this);

		// Hook into methods that should invalidate cached styles
		this.#setupInvalidationHooks();
	}

	/** The epoch a computed style watches to know its values have gone stale. */
	get styleEpoch(): {value: number} {
		return this.#styleEpoch;
	}

	/** The rules matching an element, in cascade order. */
	matchingRules(element: Element): ParsedCSSRule[] {
		if (
			this.#stylesheetsDirty ||
			this.#styleSheetCount() !== this.#parsedStyleSheetCount
		) {
			this.#parseStylesheets();
		}
		return this.#getMatchingRules(element);
	}

	setLayoutEngine(layoutEngine: LayoutEngine): void {
		this.#layoutEngine = layoutEngine;

		// Parse initial stylesheets (may be empty at construction time)
		this.#parseStylesheets();
	}

	/**
	 * Enroll a shadow root's stylesheets in the cascade. Called for every
	 * attached root (author and UA alike); rules parse lazily on the next
	 * stylesheet refresh, which the root's own <style> mutations trigger
	 * through the shared observer.
	 */
	registerShadowRoot(root: ShadowRoot): void {
		this.#shadowRoots.add(root);
		// UA-internal roots are never observer-enrolled, so no STYLE mutation
		// record will trigger a refresh for the <style> they already contain;
		// re-parse lazily on the next style computation instead.
		this.#stylesheetsDirty = true;
	}

	/**
	 * Handle DOM mutations using invalidation approach
	 */
	handleMutations(mutations: MutationRecord[]): void {
		const Node = this.#window.Node;
		let shouldRefreshStylesheets = false;

		for (const mutation of mutations) {
			if (mutation.type === "childList") {
				// A list's marker gutter is derived from its children, so adding or
				// removing an item invalidates the *list*, not just the item that
				// moved. Without this the gutter stays at whatever the original items
				// needed, and a wider marker added later overruns it -- the "iii.Third"
				// collision, on any mutation.
				this.#invalidateEnclosingList(mutation.target);

				// Check for stylesheet changes
				for (const node of mutation.addedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (
							element.tagName === "STYLE" ||
							(element.tagName === "LINK" &&
								element.getAttribute("rel") === "stylesheet")
						) {
							shouldRefreshStylesheets = true;
						} else {
							// Invalidate caches for new elements
							this.#invalidateElementCaches(element);
							// Process pseudo-elements for new elements
							this.attachPseudoElementsToElement(element);

							// Also handle any child elements
							const childElements = element.querySelectorAll("*");
							for (const childElement of childElements) {
								this.#invalidateElementCaches(childElement);
								this.attachPseudoElementsToElement(childElement);
							}
						}
					}
				}

				// Check for removed stylesheets
				for (const node of mutation.removedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (
							element.tagName === "STYLE" ||
							(element.tagName === "LINK" &&
								element.getAttribute("rel") === "stylesheet")
						) {
							shouldRefreshStylesheets = true;
						}
					}
				}
			} else if (mutation.type === "attributes") {
				// Invalidate caches for attribute changes (over-invalidation
				// approach) -- INCLUDING descendants: a class flip on an
				// ancestor changes which descendant-combinator rules match
				// (.editing .view {display:none} is exactly the TodoMVC edit
				// row), and the descendants' cached styles know nothing of it.
				const element = mutation.target as Element;
				this.#invalidateElementCaches(element);
				this.attachPseudoElementsToElement(element);
				for (const descendant of element.querySelectorAll("*")) {
					this.#invalidateElementCaches(descendant);
					this.attachPseudoElementsToElement(descendant);
				}
				// Sibling combinators reach right: `.on ~ .light` matches (or
				// stops matching) a FOLLOWING sibling when this element's
				// attributes change, and that sibling's cached styles know
				// nothing of it. Same flags the layout scope decision uses;
				// :has() reaches ancestors, for which only the nuclear cache
				// clear is honest.
				if (this.#selectorsReachAncestors) {
					this.clearCache();
				} else if (this.#selectorsReachSiblings) {
					for (
						let sibling = element.nextElementSibling;
						sibling;
						sibling = sibling.nextElementSibling
					) {
						this.#invalidateElementCaches(sibling);
						this.attachPseudoElementsToElement(sibling);
						for (const descendant of sibling.querySelectorAll("*")) {
							this.#invalidateElementCaches(descendant);
							this.attachPseudoElementsToElement(descendant);
						}
					}
				}
			} else if (mutation.type === "characterData") {
				// Check for changes to <style> element content
				if (mutation.target.parentElement?.tagName === "STYLE") {
					shouldRefreshStylesheets = true;
				}
			}
		}

		// If stylesheets changed, refresh everything
		if (shouldRefreshStylesheets) {
			this.refreshStylesheets();
		}
	}

	/**
	 * The outermost element whose layout a class/id flip on `element` can
	 * affect. Selectors reach the element itself and its descendants; a
	 * sibling combinator anywhere in the sheets extends that to the parent's
	 * subtree, and :has() extends it to the whole document. This is what
	 * keeps a selection-highlight flip from rebuilding every box on the
	 * page: rules for `.row.selected` can only reach the row.
	 */

	/**
	 * The document's style-element list, held so the count below is a bare
	 * length read. The count is polled on every computed-style read to catch
	 * a <style> appended in the same tick, before the mutation observer
	 * delivers; adopted sheets and a sheet's own mutations reach the cascade
	 * through refreshStylesheets instead.
	 */
	#styleSheetList: {length: number} | null = null;

	#styleSheetCount(): number {
		this.#styleSheetList ??= documentStyleSheetList(this.#document);
		return this.#styleSheetList.length;
	}

	invalidationScopeFor(element: Element): Element {
		if (
			this.#stylesheetsDirty ||
			this.#styleSheetCount() !== this.#parsedStyleSheetCount
		) {
			this.#parseStylesheets();
		}
		if (this.#selectorsReachAncestors) {
			return this.#document.body ?? element;
		}
		if (this.#selectorsReachSiblings) {
			return element.parentElement ?? element;
		}
		return element;
	}

	/**
	 * Focus moved: the cached ComputedStyleDeclarations of the elements that
	 * gained and lost focus hold rule sets matched BEFORE the move, so a
	 * `:focus` rule would never apply (or, symmetrically, never stop
	 * applying) -- focus is not a mutation, and nothing else invalidates.
	 * Selector matching itself is live (jsdom's matches(":focus") follows
	 * activeElement); only these caches go stale. Scoped to the two moved
	 * elements: `:focus-within` on ancestors would need chain invalidation,
	 * which nothing supports or tests yet.
	 */
	handleFocusChange(...elements: Array<Element | null>): void {
		for (const element of elements) {
			if (element) {
				this.#invalidateElementCaches(element);
				// A host's focus state reaches into its shadow tree through
				// :host(:focus) rules (and inheritance from whatever they
				// set), so the tree's cached styles go stale with it.
				const shadowRoot = compositionShadowRoot(element);
				if (shadowRoot) {
					for (const descendant of shadowRoot.querySelectorAll("*")) {
						this.#invalidateElementCaches(descendant);
					}
				}
			}
		}
	}

	/** Set the `:focus-visible` state; returns whether it changed. */
	setFocusVisible(active: boolean): boolean {
		if (this.#focusVisibleActive === active) return false;
		this.#focusVisibleActive = active;
		return true;
	}

	/**
	 * Invalidate cached styles for an element (invalidation approach)
	 */
	#invalidateElementCaches(element: Element): void {
		// A computed style an author still holds is the one this cache handed
		// out, so it is told the cascade moved on rather than merely dropped.
		this.#computedStyleCache.get(element)?.invalidate();
		this.#computedStyleCache.delete(element);
		this.#pseudoElementStyleCache.delete(element);
		this.#counterScopes.delete(element);
	}

	/**
	 * Invalidate the nearest enclosing list, and its items, after a child changed.
	 *
	 * The list's padding-left is a function of its items' markers, and the items'
	 * ordinals are a function of their position, so both go stale when the child
	 * list changes. Only the *nearest* list is affected: a deeper list's items do
	 * not contribute to an outer list's gutter.
	 */
	#invalidateEnclosingList(target: Node): void {
		let element: Element | null =
			target.nodeType === this.#window.Node.ELEMENT_NODE
				? (target as Element)
				: target.parentElement;

		for (; element; element = element.parentElement) {
			if (element.tagName !== "UL" && element.tagName !== "OL") continue;

			this.#invalidateElementCaches(element);
			this.#layoutEngine?.invalidate(element);
			for (const item of Array.from(element.children)) {
				this.#invalidateElementCaches(item);
			}
			return;
		}
	}

	#getComputedStyle(
		element: Element,
		pseudoElt?: string | null,
	): globalThis.CSSStyleDeclaration {
		// Ensure stylesheets are parsed if the document's sheet list changed
		// since the last parse, or a newly registered shadow root's sheet
		// awaits
		if (
			this.#stylesheetsDirty ||
			this.#styleSheetCount() !== this.#parsedStyleSheetCount
		) {
			this.#parseStylesheets();
		}
		// An element that is not being rendered has no style to report: it is
		// out of the document, or out of the flat tree its document composes.
		if (!isBeingRendered(element)) {
			return new EmptyStyleDeclaration() as unknown as globalThis.CSSStyleDeclaration;
		}

		// The pseudo-element argument names a pseudo-element, names nothing
		// (and is ignored), or names something that is not one -- for which an
		// empty declaration is the answer.
		let pseudoElement = "";
		if (pseudoElt) {
			const parsed = parsePseudoElementArgument(String(pseudoElt));
			if (parsed === null) {
				return new EmptyStyleDeclaration() as unknown as globalThis.CSSStyleDeclaration;
			}
			pseudoElement = parsed;
		}

		if (pseudoElement) {
			pseudoElt = pseudoElement;
			// Check cache first
			let elementCache = this.#pseudoElementStyleCache.get(element);
			if (!elementCache) {
				elementCache = new Map();
				this.#pseudoElementStyleCache.set(element, elementCache);
			}

			let pseudoStyle = elementCache.get(pseudoElt);
			if (!pseudoStyle) {
				// Compute pseudo-element style
				pseudoStyle = this.#computePseudoElementStyle(element, pseudoElt);
				elementCache.set(pseudoElt, pseudoStyle);
			}

			const declarations: Record<string, string> = {...pseudoStyle};
			// Per CSS, a pseudo-element INHERITS from its originating element:
			// a button's focus underline runs through its UA brackets, a
			// .destroy's color reaches its ::after glyph. Rule declarations
			// above win; inherited values only fill the gaps.
			const hostStyle = this.#getComputedStyle(element);
			for (const property of INHERITED_PROPERTIES) {
				if (!declarations[property]) {
					const inherited = hostStyle.getPropertyValue(property);
					if (inherited) {
						declarations[property] = inherited;
					}
				}
			}
			return new PseudoStyleDeclaration(
				declarations,
			) as unknown as globalThis.CSSStyleDeclaration;
		}

		// Check cache first for regular element styles
		let computedStyle = this.#computedStyleCache.get(element);
		if (!computedStyle) {
			// Create new instance with stylesheet rules applied
			computedStyle = new ComputedStyleDeclaration(
				element,
				this.#getMatchingRules(element),
				this,
			);
			this.#computedStyleCache.set(element, computedStyle);
		}

		return computedStyle as unknown as globalThis.CSSStyleDeclaration;
	}

	/**
	 * Walk the document's stylesheets -- this engine's own CSSOM objects, the
	 * same ones an author reaches through `styleEl.sheet` -- and collect the
	 * rules the cascade matches against.
	 */
	#parseStylesheets(): void {
		invalidateStructure();
		const document = this.#document;
		this.#parsedRules = [];
		this.#selectorsReachSiblings = false;
		this.#selectorsReachAncestors = false;
		this.#pseudoRulesByType = new Map();
		this.#counterRulesExist = false;
		this.#listItemRulesExist = false;
		this.#stylesheetsDirty = false;
		this.#parsedStyleSheetCount = this.#styleSheetCount();

		// The UA document sheet parses first; origin ordering (not source
		// order) is what keeps it beneath every author rule.
		this.#parseStyleSheet(uaStyleSheet(), undefined, true);

		for (const sheet of documentStyleSheets(document)) {
			this.#parseStyleSheet(sheet);
		}

		// Shadow-tree stylesheets, scoped to their root. Disconnected roots
		// parse too: attach-populate-connect is the standard order, and a
		// scope-gated rule matches nothing until its tree renders anyway.
		for (const root of this.#shadowRoots) {
			for (const sheet of shadowStyleSheets(root)) {
				this.#parseStyleSheet(sheet, root);
			}
		}

		// Sort rules for cascade resolution: origin first (UA rules sort
		// below every author rule -- later wins), then specificity.
		this.#parsedRules.sort((a, b) => {
			if (Boolean(a.uaOrigin) !== Boolean(b.uaOrigin)) {
				return a.uaOrigin ? -1 : 1;
			}
			if (a.specificity !== b.specificity) {
				return a.specificity < b.specificity ? -1 : 1;
			}
			// Use array index as source order tie-breaker
			return this.#parsedRules.indexOf(a) - this.#parsedRules.indexOf(b);
		});
	}

	/**
	 * Collect the style rules of a stylesheet, or of a grouping rule's own
	 * rule list. A disabled sheet, and a sheet or `@media` whose condition the
	 * terminal viewport does not match, contribute nothing; `@supports`
	 * contributes its rules, since what this engine supports is what it
	 * renders. `@font-face`, `@keyframes` and `@import` have no terminal
	 * rendering and declare nothing to the cascade.
	 */
	#parseStyleSheet(
		container: CSSStyleSheet | CSSGroupingRule,
		scope?: Node,
		uaOrigin?: boolean,
	): void {
		if (container instanceof CSSStyleSheet) {
			if (container.disabled) return;
			if (!this.mediaQueryMatches(container.media.mediaText)) return;
		}
		for (const rule of container.cssRules) {
			if (rule instanceof CSSStyleRule) {
				this.#parseStyleRule(rule, scope, uaOrigin);
			} else if (rule instanceof CSSMediaRule) {
				if (this.mediaQueryMatches(rule.conditionText)) {
					this.#parseStyleSheet(rule, scope, uaOrigin);
				}
			} else if (rule instanceof CSSSupportsRule) {
				this.#parseStyleSheet(rule, scope, uaOrigin);
			}
		}
	}

	/**
	 * Whether a media query currently matches. There is exactly one "screen" --
	 * the terminal viewport -- so only width/height features are meaningful;
	 * everything else (scripting, color-gamut, pointer, ...) defaults to
	 * matching rather than silently dropping an author's rules. Public: it
	 * answers window.matchMedia through the SAME evaluator @media uses, so
	 * a stylesheet and a script can never disagree about the viewport.
	 */
	mediaQueryMatches(mediaText: string): boolean {
		const text = mediaText.trim();
		if (!text) return true;
		return text.split(",").some((query) => this.#mediaQueryPartMatches(query));
	}

	#mediaQueryPartMatches(query: string): boolean {
		let q = query.trim();
		let negate = false;
		if (/^not\s+/i.test(q)) {
			negate = true;
			q = q.replace(/^not\s+/i, "");
		}

		const typeMatch = q.match(/^(all|screen|print|speech)\b\s*(and\s+)?/i);
		let matches = true;
		if (typeMatch) {
			matches = typeMatch[1].toLowerCase() !== "print";
			q = q.slice(typeMatch[0].length);
		}

		const features = q.match(/\([^)]*\)/g) || [];
		for (const feature of features) {
			if (!this.#mediaFeatureMatches(feature.slice(1, -1).trim())) {
				matches = false;
			}
		}

		return negate ? !matches : matches;
	}

	#mediaFeatureMatches(feature: string): boolean {
		const match = feature.match(
			/^(min-|max-)?(width|height)\s*:\s*([\d.]+)(px|ch)?$/i,
		);
		if (!match) return true; // unrecognized feature: permissive default

		const [, boundRaw, dimension, numRaw] = match;
		const bound = boundRaw?.toLowerCase();
		const num = parseFloat(numRaw);
		const actual =
			dimension.toLowerCase() === "width"
				? this.#window.innerWidth
				: this.#window.innerHeight;

		if (bound === "min-") return actual >= num;
		if (bound === "max-") return actual <= num;
		return actual === num;
	}

	/**
	 * Parse a single style rule and extract selector/declarations
	 */
	#parseStyleRule(
		styleRule: CSSStyleRule,
		scope?: Node,
		uaOriginSheet?: boolean,
	): void {
		const selector = styleRule.selectorText;
		if (selector.includes("+") || selector.includes("~")) {
			this.#selectorsReachSiblings = true;
		}
		if (selector.includes(":has")) {
			this.#selectorsReachAncestors = true;
		}
		const {declarations, important} = styleRule.style.declarationBlock();
		if (
			declarations["counter-reset"] ||
			declarations["counter-increment"] ||
			declarations["content"]?.includes("counter")
		) {
			this.#counterRulesExist = true;
		}
		if (declarations["display"] === "list-item") {
			this.#listItemRulesExist = true;
		}
		const specificity = this.#calculateSpecificity(selector);
		const uaOrigin = Boolean(
			uaOriginSheet || (scope && (scope as any).uaInternal),
		);

		// :host selectors only mean anything inside a shadow tree's own
		// stylesheet; jsdom's matches() rejects them outright, so they parse
		// into a structured predicate matched by #ruleMatches instead.
		// Supported forms: `:host`, `:host(sel)`, `:host:focus`, and any of
		// those followed by a descendant (or `>` child) selector.
		if (scope && selector.startsWith(":host")) {
			// The argument needs balanced-paren matching, not [^)]*: the UA
			// field sheet's own :host(:not(:focus)) nests one level deep.
			const hostMatch = selector.match(
				/^:host(?:\(((?:[^()]|\([^()]*\))*)\))?([^\s>]*)\s*(>)?\s*(.*)$/,
			);
			if (hostMatch) {
				const [, arg, compound, child, restRaw] = hostMatch;
				const predicate = [arg, compound].filter(Boolean).join("") || null;
				const rest = restRaw.trim() || null;
				this.#parsedRules.push({
					selector,
					declarations,
					important,
					specificity,
					scope,
					host: {predicate, rest, child: Boolean(child)},
					uaOrigin,
				});
				return;
			}
		}

		// Check if this is a pseudo-element rule. ::placeholder/::selection
		// are widget-part pseudos: no content node ever attaches for them --
		// they resolve onto the UA shadow tree's [part] elements (see
		// #getMatchingRules) or the selection painter.
		// Any pseudo-element, not just the ones this engine gives a box: a
		// rule for `::highlight(x)` still has to answer through
		// getComputedStyle, which is the whole of what CSSOM asks of it.
		const pseudoMatch = selector.match(
			/^(.*?)(::[-\w]+(?:\([^)]*\))?)((?::[-\w]+(?:\([^)]*\))?)*)$/,
		);

		if (pseudoMatch) {
			const [, baseSelector, pseudoElement] = pseudoMatch;
			const rule: ParsedCSSRule = {
				// A pseudo-element written with no originating selector
				// originates on every element, which is what `*` names.
				selector: baseSelector.trim() || "*",
				declarations,
				important,
				specificity,
				pseudoElement,
				scope,
				uaOrigin,
			};
			this.#parsedRules.push(rule);
			const byType = this.#pseudoRulesByType.get(pseudoElement);
			if (byType) byType.push(rule);
			else this.#pseudoRulesByType.set(pseudoElement, [rule]);
		} else {
			this.#parsedRules.push({
				selector,
				declarations,
				important,
				specificity,
				scope,
				uaOrigin,
			});
		}
	}

	/**
	 * Calculate CSS specificity for a selector as zero-padded string
	 * Format: "000-000-000" (ids-classes-elements) for lexicographic comparison
	 */
	#calculateSpecificity(selector: string): string {
		// Remove pseudo-elements first to avoid counting them as pseudo-classes
		const withoutPseudoElements = selector.replace(/::[^\s+>~.#[]+/g, "");

		// Count IDs
		const ids = (selector.match(/#[^\s+>~.:[]+/g) || []).length;

		// Count classes (handle chained classes like .class.other)
		const classMatches = selector.match(/\.[a-zA-Z][\w-]*/g) || [];
		const classes = classMatches.length;

		// Count attributes
		const attributes = (selector.match(/\[[^\]]+\]/g) || []).length;

		// Count pseudo-classes (but not pseudo-elements)
		const pseudoClasses = (
			withoutPseudoElements.match(/:(?!:)[a-zA-Z][\w-]*/g) || []
		).length;

		const classTotal = classes + attributes + pseudoClasses;

		// Count elements
		const elements = (selector.match(/(?:^|[\s+>~])[a-zA-Z][\w-]*/g) || [])
			.length;

		// Count pseudo-elements
		const pseudoElements = (selector.match(/::[a-zA-Z][\w-]*/g) || []).length;

		const elementTotal = elements + pseudoElements;

		// Format as zero-padded string: "001-005-002"
		return `${ids.toString().padStart(3, "0")}-${classTotal.toString().padStart(3, "0")}-${elementTotal.toString().padStart(3, "0")}`;
	}

	/**
	 * Get matching CSS rules for an element
	 */
	#getMatchingRules(element: Element): ParsedCSSRule[] {
		// A UA shadow part IS the element its part pseudo styles: the host's
		// ::placeholder rules cascade directly onto the [part="placeholder"]
		// span, the way a browser resolves ::placeholder onto its input's
		// internal placeholder element.
		const partPseudo = this.#partPseudoFor(element);
		const root = element.getRootNode();
		const shadowHost =
			root.nodeType === 11 ? ((root as ShadowRoot).host ?? null) : null;
		const partNames = (element.getAttribute("part") ?? "")
			.split(/\s+/)
			.filter(Boolean);
		return this.#parsedRules.filter((rule) => {
			if (rule.pseudoElement) {
				// ::part(name): an author styling an exposed shadow part from
				// outside. The rule matches the shadow's HOST; its declarations
				// cascade onto the part element -- any shadow, not just the UA's,
				// which is the standard CSS Shadow Parts crossing.
				const partArg = rule.pseudoElement.match(/^::part\((.+)\)$/);
				if (partArg) {
					return (
						shadowHost !== null &&
						partNames.includes(partArg[1].trim()) &&
						this.#ruleMatches(shadowHost, rule)
					);
				}
				// ::placeholder / ::selection: UA-part pseudo aliases.
				return (
					partPseudo !== null &&
					shadowHost !== null &&
					rule.pseudoElement === partPseudo &&
					this.#ruleMatches(shadowHost, rule)
				);
			}
			return this.#ruleMatches(element, rule);
		});
	}

	/**
	 * The part pseudo-element a UA shadow part element answers to, if any:
	 * "::placeholder" for the [part="placeholder"] span of an input's
	 * UA-internal tree. Author shadow trees are not eligible -- their parts
	 * are theirs to style from inside.
	 */
	#partPseudoFor(element: Element): string | null {
		const root = element.getRootNode();
		if (
			root.nodeType === 11 &&
			(root as any).uaInternal &&
			(root as ShadowRoot).host
		) {
			const part = element.getAttribute("part");
			if (part === "placeholder" || part === "selection") {
				return `::${part}`;
			}
		}
		return null;
	}

	/**
	 * Whether a rule applies to an element, honoring tree scopes: a rule
	 * matches only elements of the tree its stylesheet belongs to --
	 * document rules stop at every shadow boundary, shadow rules never
	 * escape their root -- plus the one deliberate crossing, :host, which
	 * lets a shadow stylesheet style its own host.
	 */
	#ruleMatches(element: Element, rule: ParsedCSSRule): boolean {
		try {
			// jsdom treats `:focus-visible` as `:focus`, so gate it on our own flag.
			if (
				!this.#focusVisibleActive &&
				rule.selector.includes(":focus-visible")
			) {
				return false;
			}
			if (rule.host) {
				const scope = rule.scope as ShadowRoot;
				const host = scope.host;
				if (!host) return false;
				const {predicate, rest, child} = rule.host;
				if (predicate && !host.matches(predicate)) return false;
				if (!rest) return element === host;
				if (element.getRootNode() !== scope) return false;
				if (!element.matches(rest)) return false;
				return child ? element.parentNode === scope : true;
			}
			const root = element.getRootNode();
			if (rule.scope) {
				return root === rule.scope && element.matches(rule.selector);
			}
			// UA document rules apply in EVERY tree scope, as a browser's own
			// UA sheet styles shadow trees.
			if (rule.uaOrigin) {
				return element.matches(rule.selector);
			}
			// AUTHOR document rules match everything OUTSIDE shadow trees --
			// including detached elements (styles resolve before insertion,
			// and always have here); the boundary they must not cross is the
			// shadow root.
			const inShadowTree =
				root.nodeType === 11 && Boolean((root as ShadowRoot).host);
			return !inShadowTree && element.matches(rule.selector);
		} catch (err) {
			// Fallback for unsupported selectors
			return false;
		}
	}

	/**
	 * Compute style properties for a pseudo-element
	 */
	#computePseudoElementStyle(
		element: Element,
		pseudoElement: string,
	): Record<string, string> {
		const matchingRules = this.#parsedRules.filter((rule) => {
			if (rule.pseudoElement !== pseudoElement) return false;
			return this.#ruleMatches(element, rule);
		});

		// Apply rules in cascade order
		const computedStyle: Record<string, string> = {};
		for (const rule of matchingRules) {
			Object.assign(computedStyle, rule.declarations);
		}

		return computedStyle;
	}

	/**
	 * Get marker content for outside positioning
	 * This is separate from createPseudoElementNode to handle outside markers
	 */
	getMarkerContent(hostElement: Element): string | null {
		if (!hostElement || hostElement.nodeType !== hostElement.ELEMENT_NODE) {
			return null;
		}

		const computedStyle = this.#window.getComputedStyle(hostElement);
		const display = computedStyle.getPropertyValue("display");

		if (display !== "list-item") {
			return null;
		}

		const styles = this.#computePseudoElementStyle(hostElement, "::marker");
		let content = styles.content;

		// If no explicit CSS content, generate default marker using list-style-type
		if (!content || content === "none" || content === "normal") {
			const listParent = hostElement.parentElement;
			if (
				listParent &&
				(listParent.tagName === "UL" || listParent.tagName === "OL")
			) {
				// Use getListMarker function to handle all list-style-type values
				const marker = getListMarker(hostElement, listParent);
				if (marker) {
					content = `"${withMarkerSeparator(marker)}"`;
				}
			}
		}

		// Only return marker if it has content
		if (!content || content === "none" || content === "normal") {
			return null;
		}

		// Remove quotes from content string
		let textContent = unquoteContent(content);

		// Resolve counter() functions in the content
		textContent = this.resolveCounterFunction(hostElement, textContent);

		return textContent;
	}

	/**
	 * Create pseudo-element node with CSS content applied
	 * This integrates with ExpandedTreeWalker for automatic pseudo-element creation
	 */
	createPseudoElementNode(
		hostElement: Element,
		pseudoType: string,
	): Text | null {
		const styles = this.#computePseudoElementStyle(hostElement, pseudoType);
		let content = styles.content;

		// For ::marker pseudo-elements, generate default content if none specified
		if (pseudoType === "::marker") {
			const computedStyle = this.#window.getComputedStyle(hostElement);
			const display = computedStyle.getPropertyValue("display");

			if (display === "list-item") {
				// Check if explicitly set to outside positioning
				const listStylePosition =
					computedStyle.getPropertyValue("list-style-position") || "outside";

				// Skip inline marker creation for outside positioning (the default)
				if (listStylePosition === "outside") {
					return null;
				}

				// If no explicit CSS content, generate default marker using list-style-type
				if (!content || content === "none" || content === "normal") {
					const listParent = hostElement.parentElement;
					if (
						listParent &&
						(listParent.tagName === "UL" || listParent.tagName === "OL")
					) {
						// Use getListMarker function to handle all list-style-type values
						const marker = getListMarker(hostElement, listParent);
						if (marker) {
							content = `"${marker} "`;
						}
					}
				}
			}
		}

		// Only create pseudo-element if it has content
		if (!content || content === "none" || content === "normal") {
			return null;
		}

		// Remove quotes from content string
		let textContent = unquoteContent(content);

		// Resolve counter() functions in the content
		textContent = this.resolveCounterFunction(hostElement, textContent);

		// Create text node with the content
		const doc = hostElement.ownerDocument;
		const textNode = doc.createTextNode(textContent);

		// Store metadata for ExpandedTreeWalker
		(textNode as any).pseudoMetadata = {
			pseudoType,
			hostElement,
			styles,
		};

		return textNode;
	}

	/**
	 * Check if element should have a pseudo-element based on CSS rules
	 */
	shouldCreatePseudoElement(element: Element, pseudoType: string): boolean {
		// For ::marker pseudo-elements, only create them for inside positioning
		if (pseudoType === "::marker") {
			const computedStyle = this.#window.getComputedStyle(element);
			const display = computedStyle.getPropertyValue("display");
			const listStylePosition =
				computedStyle.getPropertyValue("list-style-position") || "outside";

			if (display === "list-item" && listStylePosition !== "outside") {
				return true; // Only create inline markers for inside positioning
			}
		}

		const styles = this.#computePseudoElementStyle(element, pseudoType);
		const content = styles.content;
		return !!(content && content !== "none" && content !== "normal");
	}

	/**
	 * Refresh stylesheet parsing (call when stylesheets change)
	 */
	refreshStylesheets(): void {
		this.#parseStylesheets();
		this.clearCache();

		// Rules can change LAYOUT (a display flip, new dimensions), and boxes
		// may already have been built under the pre-parse styles -- a
		// .view{display:none} arriving with the same batch as its markup left
		// the hidden subtree's stale boxes ghosting about. Rebuild from the
		// root; stylesheet changes are rare.
		const body = this.#document.body;
		if (body) {
			this.#layoutEngine?.invalidate(body);
		}

		// Re-evaluate existing pseudos IDENTITY-PRESERVINGLY -- never clear
		// wholesale: layout keys a pseudo's boxes by node instance, and a
		// fresh node per refresh strands every mapped one. Attach handles
		// content updates in place and removal when a pseudo stops matching.
		// TODO: Performance - walks every element on stylesheet change.
		const walker = this.#document.createTreeWalker(
			this.#document.documentElement,
			this.#window.NodeFilter.SHOW_ELEMENT,
			null,
		);
		let element = walker.nextNode() as Element;
		while (element) {
			if (Object.keys(getAllPseudoElements(element)).length > 0) {
				this.attachPseudoElementsToElement(element);
			}
			element = walker.nextNode() as Element;
		}

		// After parsing rules, attach pseudo-elements to matching elements
		this.attachPseudoElementsToDocument();
	}

	/**
	 * Efficiently scan document and attach pseudo-element nodes to elements that have matching pseudo-element rules
	 * Uses CSS rules to find matching elements rather than checking every element
	 */
	attachPseudoElementsToDocument(): void {
		// Group pseudo-element rules by pseudo-type for efficient processing
		const pseudoRulesByType = new Map<string, ParsedCSSRule[]>();

		for (const rule of this.#parsedRules) {
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

		// Process each pseudo-element type
		for (const [pseudoType, rules] of pseudoRulesByType) {
			// Collect all matching elements for this pseudo-type
			const matchingElements = new Set<Element>();

			for (const rule of rules) {
				try {
					// Find all elements matching this rule's selector, within the
					// rule's own tree scope -- a document query can't see shadow
					// elements and a shadow rule must never claim document ones.
					const scope = (rule.scope ?? this.#document) as ParentNode;
					const elements = scope.querySelectorAll(rule.selector);
					for (const element of elements) {
						matchingElements.add(element);
					}
				} catch (e) {
					// Skip invalid selectors
					continue;
				}
			}

			// Attach pseudo-elements to matching elements
			for (const element of matchingElements) {
				this.#attachPseudoElementToElementForType(element, pseudoType);
			}
		}

		// Handle special case: ::marker for list-item elements (only for inside positioning)
		const listItems = this.#document.querySelectorAll(
			'[style*="list-item"], li',
		);
		for (const element of listItems) {
			const computedStyle = this.#window.getComputedStyle(element);
			const display = computedStyle.getPropertyValue("display");
			const listStylePosition =
				computedStyle.getPropertyValue("list-style-position") || "outside";

			// Only create inline markers for inside positioning
			if (display === "list-item" && listStylePosition !== "outside") {
				this.#attachPseudoElementToElementForType(element, "::marker");
			}
		}
	}

	/**
	 * Attach pseudo-element nodes to a specific element if it has matching pseudo-element rules
	 */
	attachPseudoElementsToElement(element: Element): void {
		// Initialize counters for this element first
		this.initializeCounters(element);

		const pseudoTypes = ["::before", "::after", "::marker"];

		for (const pseudoType of pseudoTypes) {
			this.#attachPseudoElementToElementForType(element, pseudoType);
		}
	}

	/**
	 * Attach a specific pseudo-element type to an element if it should have one
	 */
	/**
	 * Could any parsed rule give this element a pseudo of this type? A few
	 * matches() calls against only the rules that declare the pseudo --
	 * instead of building the full pseudo style declaration per element per
	 * type just to discover `content` is "none". Over-matching is safe (the
	 * full path still decides); the win is the early false for the common
	 * document with no pseudo rules beyond the UA button brackets.
	 */
	#pseudoRuleCouldMatch(element: Element, pseudoType: string): boolean {
		if (pseudoType === "::marker") {
			// Markers exist only on display:list-item boxes: an <li>, a rule
			// declaring it, or an inline style. Nothing else needs the
			// computed-display check below.
			return (
				element.tagName === "LI" ||
				this.#listItemRulesExist ||
				(element.getAttribute("style") ?? "").includes("list-item")
			);
		}
		const rules = this.#pseudoRulesByType.get(pseudoType);
		if (!rules) return false;
		for (const rule of rules) {
			try {
				if (element.matches(rule.selector)) return true;
			} catch {
				return true;
			}
		}
		return false;
	}

	#attachPseudoElementToElementForType(
		element: Element,
		pseudoType: string,
	): void {
		// No rule can apply and none is attached: skip the counter and style
		// computations wholesale. (An attached pseudo still takes the full
		// path so a rule that STOPPED matching removes it.)
		if (
			!this.#pseudoRuleCouldMatch(element, pseudoType) &&
			!getPseudoElement(element, pseudoType)
		) {
			return;
		}

		// Initialize counters for this element first (needed for counter() functions)
		this.initializeCounters(element);

		// Skip ::marker for elements without display: list-item or with outside positioning
		if (pseudoType === "::marker") {
			const computedStyle = this.#window.getComputedStyle(element);
			const display = computedStyle.getPropertyValue("display");
			const listStylePosition =
				computedStyle.getPropertyValue("list-style-position") || "outside";

			if (display !== "list-item") {
				return;
			}

			// Remove inline markers for outside positioning
			if (listStylePosition === "outside") {
				removePseudoElement(element, "::marker");
				return;
			}
		}

		// Compute what the pseudo should hold now; null means "none".
		const candidate = this.shouldCreatePseudoElement(element, pseudoType)
			? this.createPseudoElementNode(element, pseudoType)
			: null;
		const existing = getPseudoElement(element, pseudoType) as Text | null;

		// Pseudo NODE IDENTITY is stable: attaches re-run on every element
		// addition and attribute invalidation, and layout keys the pseudo's
		// boxes by instance -- a fresh node per attach strands the mapped one
		// (an absolutely positioned button's ::after glyph simply vanished).
		// Reuse the node; update its text in place; remove when content goes.
		if (existing && candidate) {
			if (existing.data !== candidate.data) {
				existing.data = candidate.data;
				this.#layoutEngine?.invalidate(element);
			}
			(existing as any).pseudoMetadata = {
				...((existing as any).pseudoMetadata || {}),
				styles: this.#computePseudoElementStyle(element, pseudoType),
			};
			return;
		}
		if (existing && !candidate) {
			removePseudoElement(element, pseudoType);
			this.#layoutEngine?.invalidate(element);
			return;
		}
		if (candidate) {
			attachPseudoElement(element, candidate, pseudoType);
			(candidate as any).pseudoMetadata = {
				...((candidate as any).pseudoMetadata || {}),
				styles: this.#computePseudoElementStyle(element, pseudoType),
			};
			this.#layoutEngine?.invalidate(element);
		}
	}

	#setupInvalidationHooks(): void {
		const styleManager = this;
		const Element = this.#window.Element;
		const originalSetAttribute = Element.prototype.setAttribute;
		const originalRemoveAttribute = Element.prototype.removeAttribute;

		// Hook setAttribute to catch style attribute changes
		Element.prototype.setAttribute = function (name: string, value: string) {
			const result = originalSetAttribute.call(this, name, value);

			// Invalidate for style attribute changes
			if (name === "style") {
				styleManager.invalidateElement(this);
			}
			// Invalidate for class/id changes that might affect CSS rules
			else if (name === "class" || name === "id") {
				styleManager.invalidateElement(this);
			}

			return result;
		};

		// Hook removeAttribute to catch style attribute removal
		Element.prototype.removeAttribute = function (name: string) {
			const result = originalRemoveAttribute.call(this, name);

			// Invalidate for style attribute removal
			if (name === "style") {
				styleManager.invalidateElement(this);
			}
			// Invalidate for class/id changes that might affect CSS rules
			else if (name === "class" || name === "id") {
				styleManager.invalidateElement(this);
			}

			return result;
		};

		// A property written through element.style lands on the style attribute,
		// so the hooks above are the whole invalidation path for inline styles.
		installInlineStyle(this.#window);
		installStyleSheets(this.#window);
	}

	/**
	 * Invalidate cached computed style for an element
	 */
	// Elements style-invalidated since the last drain; null once the set
	// overflowed. The engine drains this per frame to bound a banded repaint.
	#pendingStyleDamage: Set<Element> | null = new Set();

	/**
	 * The style-invalidated elements since the last call, or null when the
	 * set overflowed (treat as unbounded). Resets the accumulator.
	 */
	drainStyleDamage(): Set<Element> | null {
		const damage = this.#pendingStyleDamage;
		this.#pendingStyleDamage = new Set();
		return damage;
	}

	invalidateElement(element: Element): void {
		this.#computedStyleCache.delete(element);
		this.#pseudoElementStyleCache.delete(element);
		if (this.#pendingStyleDamage) {
			this.#pendingStyleDamage.add(element);
			if (this.#pendingStyleDamage.size > 24) this.#pendingStyleDamage = null;
		}
		// A style change can flip display: contents, which moves the node's
		// flat-tree BOX parent; the composition memo must not outlive it.
		invalidateComposition();
	}

	/**
	 * Clear all cached computed styles (nuclear option)
	 */
	clearCache(): void {
		// Every computed style ever handed out re-resolves on its next read:
		// there is no enumerating a WeakMap, so the epoch they all watch moves.
		this.#styleEpoch.value++;
		this.#computedStyleCache = new WeakMap();
		this.#pseudoElementStyleCache = new WeakMap();
		this.#counterScopes = new WeakMap();
	}

	// ============================================================================
	// CSS COUNTER SUPPORT
	// ============================================================================
	/**
	 * Initialize counters for an element based on CSS properties
	 * Non-recursive approach to avoid memory issues
	 */
	initializeCounters(element: Element): void {
		// Skip if already initialized
		if (this.#counterScopes.has(element)) {
			return;
		}

		// With no counter-bearing rules anywhere, only lists carry counters
		// (the automatic list-item one). Skip everything else -- UNLESS the
		// element sits under a scope-holding parent, so a chain like
		// ol > li > div > ol keeps its inheritance path unbroken.
		const tag = element.tagName;
		if (
			!this.#counterRulesExist &&
			tag !== "OL" &&
			tag !== "UL" &&
			tag !== "LI" &&
			!(
				element.parentElement && this.#counterScopes.has(element.parentElement)
			) &&
			!(element.getAttribute("style") ?? "").includes("counter")
		) {
			return;
		}

		const computedStyle = this.#window.getComputedStyle(element);
		const counterReset = computedStyle.getPropertyValue("counter-reset");
		const counterIncrement =
			computedStyle.getPropertyValue("counter-increment");

		// Get parent scope if parent exists (but don't recursively initialize parents)
		const parentElement = element.parentElement;
		const parentScope = parentElement
			? this.#counterScopes.get(parentElement)
			: undefined;

		// Create counter scope for this element
		const scope: CounterScope = {
			element,
			counters: {},
			parent: parentScope,
		};
		this.#counterScopes.set(element, scope);

		// Handle counter-reset first
		if (counterReset && counterReset !== "none") {
			this.#parseCounterReset(scope, counterReset);
		}

		// Handle automatic list-item counter for ol/ul elements
		if (element.tagName === "OL" || element.tagName === "UL") {
			const startValue =
				element.tagName === "OL"
					? parseInt(element.getAttribute("start") || "1", 10)
					: 0;
			scope.counters["list-item"] = startValue - 1; // Reset to start-1 so first increment gives start
		}

		// Handle counter-increment after reset
		if (counterIncrement && counterIncrement !== "none") {
			this.#parseCounterIncrement(scope, counterIncrement);
		}

		// Handle automatic list-item increment for li elements
		if (element.tagName === "LI") {
			this.#incrementCounter(scope, "list-item", 1);
		}
	}

	/**
	 * Parse counter-reset CSS property
	 */
	#parseCounterReset(scope: CounterScope, counterReset: string): void {
		// Parse "counter1 value1 counter2 value2" format
		const tokens = counterReset.trim().split(/\s+/);
		for (let i = 0; i < tokens.length; i += 2) {
			const counterName = tokens[i];
			const value = tokens[i + 1] ? parseInt(tokens[i + 1], 10) : 0;
			if (counterName && !isNaN(value)) {
				scope.counters[counterName] = value;
			}
		}
	}

	/**
	 * Parse counter-increment CSS property
	 */
	#parseCounterIncrement(scope: CounterScope, counterIncrement: string): void {
		// Parse "counter1 increment1 counter2 increment2" format
		const tokens = counterIncrement.trim().split(/\s+/);
		for (let i = 0; i < tokens.length; i += 2) {
			const counterName = tokens[i];
			const increment = tokens[i + 1] ? parseInt(tokens[i + 1], 10) : 1;
			if (counterName && !isNaN(increment)) {
				this.#incrementCounter(scope, counterName, increment);
			}
		}
	}

	/**
	 * Increment a counter by a specific amount
	 */
	#incrementCounter(
		scope: CounterScope,
		counterName: string,
		increment: number,
	): void {
		// For list-item counters, we need to check previous siblings for the most recent value
		if (counterName === "list-item" && scope.element.tagName === "LI") {
			const currentValue = this.#getListItemCounterValue(scope.element);
			scope.counters[counterName] = currentValue + increment;
		} else {
			// For other counters, get value from parent scopes
			const currentValue = this.#getCounterValueFromScope(
				scope.parent,
				counterName,
			);
			scope.counters[counterName] = currentValue + increment;
		}
	}

	/**
	 * Get the current list-item counter value by checking previous siblings
	 */
	#getListItemCounterValue(element: Element): number {
		// Find the parent OL/UL that establishes the counter scope
		let parent = element.parentElement;
		while (parent && parent.tagName !== "OL" && parent.tagName !== "UL") {
			parent = parent.parentElement;
		}

		if (!parent) return 0;

		// Get the reset value from the OL/UL
		const parentScope = this.#counterScopes.get(parent);
		let currentValue = parentScope?.counters["list-item"] ?? 0;

		// Add increments from all previous LI siblings
		const siblings = Array.from(parent.children);
		const currentIndex = siblings.indexOf(element);

		for (let i = 0; i < currentIndex; i++) {
			const sibling = siblings[i];
			if (sibling.tagName === "LI") {
				currentValue += 1; // Each LI increments by 1
			}
		}

		return currentValue;
	}

	/**
	 * Get counter value from a specific scope (without current scope)
	 */
	#getCounterValueFromScope(
		scope: CounterScope | undefined,
		counterName: string,
	): number {
		// Look for counter in current scope or parent scopes
		let currentScope = scope;
		while (currentScope) {
			if (counterName in currentScope.counters) {
				return currentScope.counters[counterName];
			}
			currentScope = currentScope.parent;
		}
		return 0; // Counter not found
	}

	getCounterValue(element: Element, counterName: string): number {
		const scope = this.#counterScopes.get(element);
		if (!scope) return 0;

		// Look for counter in current scope or parent scopes
		let currentScope: CounterScope | undefined = scope;
		while (currentScope) {
			if (counterName in currentScope.counters) {
				return currentScope.counters[counterName];
			}
			currentScope = currentScope.parent;
		}

		return 0; // Counter not found
	}

	/**
	 * Resolve counter() function in CSS content
	 * Supports: counter(name), counter(name, style)
	 */
	resolveCounterFunction(element: Element, content: string): string {
		// Replace all counter() functions in the content
		return content.replace(
			/counter\s*\(\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g,
			(_match, counterName, style) => {
				const trimmedName = counterName.trim();
				const trimmedStyle = style?.trim() || "decimal";
				const value = this.getCounterValue(element, trimmedName);
				return formatCounterValue(value, trimmedStyle);
			},
		);
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		this.#computedStyleCache = new WeakMap();
		this.#pseudoElementStyleCache = new WeakMap();
		this.#counterScopes = new WeakMap();
	}
}

function formatCounterValue(value: number, style: string): string {
	switch (style) {
		case "decimal":
		default:
			return value.toString();
		case "lower-alpha":
			return String.fromCharCode(96 + ((value - 1) % 26) + 1);
		case "upper-alpha":
			return String.fromCharCode(64 + ((value - 1) % 26) + 1);
		case "lower-roman":
			return toRoman(value).toLowerCase();
		case "upper-roman":
			return toRoman(value);
		case "disc":
			return "•";
		case "circle":
			return "◦";
		case "square":
			return "▪";
	}
}
