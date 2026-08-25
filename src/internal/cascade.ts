/**
 * The cascade and the CSSOM: stylesheets, the values an element computes to,
 * and the object model an author writes through.
 *
 * Nothing below this file decides what an element's style is. Layout and the
 * painter read what it resolved.
 */

import type {EngineWindow} from "./termdom.js";
import {LINE_STYLES, type LineStyle} from "./screen.js";
import {
	Document as DOMDocumentClass,
	HTMLElement as DOMHTMLElement,
	HTMLLinkElement as DOMHTMLLinkElement,
	HTMLStyleElement as DOMHTMLStyleElement,
	SVGElement as DOMSVGElement,
	ShadowRoot as DOMShadowRoot,
	observeTree,
	type Document as DOMDocument,
	type UAToolkit,
	claimUAToolkit,
	TransitionEvent,
} from "./dom.js";
import * as CSSTree from "css-tree";
import {
	CSS_WIDE_KEYWORDS,
	WHITESPACE,
	cssTimeMs,
	cssValueChildren,
	functionArguments,
	seedValueNodes,
	serializeCSSIdentifier,
	serializeCSSNumber,
	serializeCSSString,
	serializeCSSValue,
	singleValueNode,
	splitCommaList,
	splitComponents,
	type CSSNode,
} from "./cssvalue.js";
import {parseCSSColorComponents, serializeCSSColor} from "./color.js";
import {stringWidth} from "./text.js";
import type {LayoutEngine} from "./layout.js";
import Flex from "./flex.js";
import type * as FlexTypes from "./flex.js";
import {
	CSS_INITIAL_VALUES,
	CSS_LONGHANDS,
	CSS_PROPERTIES,
	CSS_AT_RULE_DESCRIPTORS,
	CSS_RESET_ONLY_LONGHANDS,
	CSS_SHORTHANDS,
} from "../generated/cssproperties.js";
import {UA_DOCUMENT_STYLES, UA_ELEMENT_STYLES} from "./useragent.js";

// ---------------------------------------------------------------------------
// The UA toolkit, claimed per document
//
// The composed-tree and pseudo-element capabilities come from the claim a
// StyleManager makes when it is built (or from the engine's own install,
// which closes further claims). The wrappers below keep the capability
// per-document while the cascade's call sites stay one name deep.
// ---------------------------------------------------------------------------

const uaByDocument = new WeakMap<object, UAToolkit>();

function uaOf(node: object): UAToolkit | undefined {
	if ((node as object | null) == null) {
		return undefined;
	}
	const n = node as {ownerDocument?: object; host?: {ownerDocument?: object}};
	const document = n.ownerDocument ?? n.host?.ownerDocument ?? node;
	let toolkit = uaByDocument.get(document);
	if (toolkit === undefined) {
		// A headless document claims on first need; a mounted one was
		// stored at construction, and the claim door is shut behind it.
		try {
			toolkit = claimUAToolkit(document);
		} catch (_err) {
			// The claim door is shut: an engined document whose toolkit was
			// not stored at construction has no capability here.
			return undefined;
		}
		uaByDocument.set(document, toolkit);
	}
	return toolkit;
}

function flatParentElement<T>(node: object): T | null {
	return uaOf(node)?.flatParentElement<T>(node) ?? null;
}

function shadowRootOf<T>(element: object): T | null {
	return uaOf(element)?.shadowRootOf<T>(element) ?? null;
}

function pseudoElement<T>(host: object, name: string): T | null {
	return uaOf(host)?.pseudoElement<T>(host, name) ?? null;
}

function pseudoElementCount(host: object): number {
	return uaOf(host)?.pseudoElementCount(host) ?? 0;
}

function pseudoHostOf<T>(node: object): T | null {
	return uaOf(node)?.pseudoHostOf<T>(node) ?? null;
}

function pseudoNameOf(node: object): string | null {
	return uaOf(node)?.pseudoNameOf(node) ?? null;
}

function ensurePseudoElement<T>(target: object, name: string): T {
	const ua = uaOf(target);
	if (ua === undefined) {
		throw new Error("No toolkit claimed for this document.");
	}
	return ua.ensurePseudoElement<T>(target, name);
}

function clearPseudoElement(host: object, name: string): void {
	uaOf(host)?.clearPseudoElement(host, name);
}

function isUAShadowRoot(node: object): boolean {
	return uaOf(node)?.isUAShadowRoot(node) ?? false;
}

function styleElementCount(document: DOMDocument): number {
	return uaByDocument.get(document)?.styleElementCount() ?? 0;
}

// ---------------------------------------------------------------------------
// User-agent element defaults and shorthand expansion
//
// Cascade machinery, not stylesheet text: the per-element defaults the
// cascade resolves against, the shorthand expansion every origin's
// declarations pass through, and the inheritance and initial-value
// tables. The UA stylesheet strings stay in useragent.ts.
// ---------------------------------------------------------------------------

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

// ---- Shorthand expansion (the UA table is built on it) ----
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
/** The two ends of a flow-relative axis, in the order a pair shorthand states them. */
const AXIS_ENDS = ["start", "end"] as const;

const CORNERS = [
	"top-left",
	"top-right",
	"bottom-right",
	"bottom-left",
] as const;
const LIST_STYLE_POSITIONS = new Set(["inside", "outside"]);

/**
 * CSS 1-4 value expansion: [all], [v h], [t h b], [t r b l]. The four corners
 * fill by the same rule, running top-left, top-right, bottom-right,
 * bottom-left.
 */
function perEdge(values: string[]): [string, string, string, string] {
	const [a, b = a, c = a, d = b] = values;
	return [a, b, c, d];
}

/** A flow-relative pair's two values: [both] or [start end]. */
function perEnd(values: string[]): [string, string] {
	const [a, b = a] = values;
	return [a, b];
}

/**
 * The grammars a value is matched against: the property index's, with the
 * entries it states from an older level of the specs brought up to date.
 * `generic()` family names, the SVG baseline keywords and `outline-color:
 * invert` are all in the current specs and missing from the index. The
 * deprecated system colors still parse per CSS Color 4 -- each is an alias of
 * a modern one -- but the index's `<color>` leaves them out.
 */
const grammarLexer = CSSTree.fork({
	properties: {
		"alignment-baseline": "| text-bottom | text-top",
		"baseline-shift": "| top | center | bottom",
		"outline-color": "| invert",
	},
	types: {
		"color": "| <deprecated-system-color>",
		"family-name":
			"| generic( <custom-ident>+ ) | -webkit-generic( <custom-ident>+ )",
	},
}).lexer;

/** One top-level component of a value, and the grammar terms it satisfied. */
interface ValueTerm {
	text: string;
	terms: string[];
}

/** One step of a grammar match: the term a node was matched against. */
interface TraceTerm {
	type: string;
	name: string;
}

/**
 * Each top-level component of a value paired with the grammar terms it
 * satisfied, outermost first: the longhands and types the property index
 * names on the way to the component. Null when the grammar refuses the value
 * -- one carrying a substitution, or a spelling the index does not describe
 * -- which is where a caller falls back to reading the value by shape.
 *
 * The text is the component as the declaration spells it: the grammar says
 * which term a component fills, not how it is written.
 */
function grammarTerms(property: string, value: string): ValueTerm[] | null {
	let ast: {children?: {toArray(): CSSNode[]} | null};
	let match: {matched: unknown; getTrace(node: unknown): TraceTerm[] | null};
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

/** The `<line-width> || <line-style> || <color>` grammar's three terms. */
interface LineValue {
	width: string | null;
	lineStyle: string | null;
	color: string | null;
}

/**
 * The grammar term each component of a line value satisfied, keyed by the
 * term's name in the property index.
 */
const LINE_VALUE_TERMS = new Map<string, keyof LineValue>([
	["line-width", "width"],
	["line-style", "lineStyle"],
	["outline-line-style", "lineStyle"],
	["color", "color"],
]);

/** The node types a number is parsed into, whatever unit it carries. */
const NUMERIC_NODES = new Set(["Number", "Dimension", "Percentage"]);

/**
 * The `<line-width> || <line-style> || <color>` grammar shared by `border`,
 * the per-side border shorthands and `outline`. Components may appear in any
 * order and any may be omitted, so which term a component fills is read off
 * the grammar it matched rather than guessed from its spelling.
 *
 * A value the grammar refuses -- one carrying a substitution, or a spelling
 * the index does not describe -- is read by shape instead: the cascade takes
 * such a value as declared, and what it means is decided downstream.
 */
function splitLineValue(property: string, value: string): LineValue {
	const out: LineValue = {width: null, lineStyle: null, color: null};
	const traced = grammarTerms(property, value);
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
		const type = singleValueNode(token)?.type;
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

/** The values `flex-direction` takes, which is how `flex-flow` knows one. */
const FLEX_DIRECTIONS = new Set([
	"row",
	"row-reverse",
	"column",
	"column-reverse",
]);

/** The values `flex-wrap` takes. */
const FLEX_WRAPS = new Set(["nowrap", "wrap", "wrap-reverse"]);

/**
 * The keywords that qualify the alignment keyword after them rather than
 * standing as a value of their own: `safe center`, `first baseline`.
 */
const ALIGNMENT_QUALIFIERS = new Set(["safe", "unsafe", "first", "last"]);

/**
 * Expand `flex-flow` (css-flexbox-1 §7.1): a direction and a wrap in either
 * order, either one omitted and left at its initial value.
 */
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

/**
 * Expand a `place-*` shorthand (css-align-3 §10): the block axis first, then
 * the inline axis, and one value stated for both when only one is written.
 * A value is one keyword, or two where the first only qualifies the second.
 */
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

/**
 * Expand the `flex` shorthand (css-flexbox-1 §7.1.1): `none` is 0 0 auto,
 * `auto` 1 1 auto, `initial` 0 1 auto; otherwise the first number is grow,
 * a second number is shrink, anything else is the basis -- and a one-value
 * numeric form (`flex: 1`) sets the basis to 0%, which is what makes it the
 * everyday grow-to-fill declaration.
 */
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
	const traced = grammarTerms("flex", v);
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
			if (singleValueNode(token)?.type === "Number") {
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

/** The longhands `list-style` states, and the terms its grammar names. */
const LIST_STYLE_LONGHANDS = [
	"list-style-position",
	"list-style-image",
	"list-style-type",
];

/**
 * Expand the `list-style` shorthand, whose components may appear in any order.
 *
 * `none` is ambiguous -- it sets whichever of type/image has not been given --
 * but for a terminal there are no images, so it always means "no marker".
 */
function expandListStyle(value: string): Record<string, string> {
	const parts: Record<string, string> = {};
	const traced = grammarTerms("list-style", value);
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

/**
 * Expand the `background` shorthand down to the two components a terminal can
 * render. Positions, repeats and attachments mean nothing on a cell grid and
 * are dropped; `none` is the IMAGE component, never a color, so the color a
 * bare `background: none` declares is its initial, transparent.
 */
function expandBackground(value: string): Record<string, string> {
	const traced = grammarTerms("background", value);
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

/** The four ways a border image tiles, which name the repeat component. */
const BORDER_IMAGE_REPEATS = new Set(["stretch", "repeat", "round", "space"]);

/** The functions that produce an image, beside the gradients. */
const IMAGE_FUNCTIONS = new Set([
	"url",
	"image",
	"image-set",
	"element",
	"cross-fade",
	"paint",
]);

/** Whether a component names an image: a function producing one, or `none`. */
function isImageValue(token: string): boolean {
	const node = singleValueNode(token);
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

/** The longhands `border-image` states, and the terms its grammar names. */
const BORDER_IMAGE_LONGHANDS = [
	"border-image-source",
	"border-image-slice",
	"border-image-width",
	"border-image-outset",
	"border-image-repeat",
];

/**
 * Expand the `border-image` shorthand, whose slash-separated groups are the
 * slice, the width and the outset, and whose first group holds the source,
 * the slice and the repeat in any order.
 *
 * A terminal draws no border image, so nothing here reaches the painter. The
 * `border` shorthand resets these five longhands and serializes only while
 * they stand at their initial values, so a declaration block has to know what
 * they hold.
 */
function expandBorderImage(value: string): Record<string, string> {
	const traced = grammarTerms("border-image", value);
	if (traced) {
		const out: Record<string, string> = {};
		for (const component of traced) {
			for (const longhand of BORDER_IMAGE_LONGHANDS) {
				if (component.terms.includes(longhand)) {
					out[longhand] =
						out[longhand] === undefined ?
							component.text :
							`${out[longhand]} ${component.text}`;
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

/**
 * Expand the `border-radius` shorthand: up to four horizontal radii and,
 * after a slash, up to four vertical ones, each list filled out by the CSS
 * 1-4 rule. A corner is elliptical, so its longhand holds both radii -- and
 * states one value where the two agree, which is how a radius serializes.
 */
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

/**
 * A value's top-level components, split on `/` rather than on whitespace, with
 * strings, brackets and parentheses kept whole. The grid shorthands are the
 * only ones whose parts are slash-separated and whose components can contain
 * a slash-free quoted string.
 */
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

/** A value's top-level components, with strings and bracketed names kept whole. */
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

/** Whether a grid-placement component is a `<custom-ident>` and nothing else. */
function isCustomIdent(value: string): boolean {
	return (
		/^-?[A-Za-z_][\w-]*$/.test(value) && value !== "auto" && value !== "span"
	);
}

/**
 * `grid-row` / `grid-column` (css-grid-2 §8.3.2): a start line and an end
 * line. An omitted end repeats the start only when the start is a name --
 * `grid-column: main` means the whole area called main, while
 * `grid-column: 2` means one track starting at line 2.
 */
function expandGridPlacementPair(
	value: string,
	start: string,
	end: string,
): Record<string, string> {
	const groups = splitSlashGroups(value);
	const first = groups[0] || "auto";
	const second =
		groups.length > 1 && groups[1] ?
			groups[1] :
			isCustomIdent(first) ?
				first :
				"auto";
	return {[start]: first, [end]: second};
}

/**
 * `grid-area` (css-grid-2 §8.4): row-start / column-start / row-end /
 * column-end, each omitted value falling back to the one across from it by the
 * same custom-ident rule the pair shorthands use.
 */
function expandGridArea(value: string): Record<string, string> {
	const groups = splitSlashGroups(value);
	const rowStart = groups[0] || "auto";
	const fallback = (index: number, from: string): string =>
		groups.length > index && groups[index] ?
			groups[index] :
			isCustomIdent(from) ?
				from :
				"auto";
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

/**
 * `grid-template` (css-grid-2 §7.4). Two forms: rows `/` columns, and the
 * visual one whose rows are written as strings of area names with each row's
 * track size and line names around them.
 */
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
	// rows, and the slash group after it -- if any -- states the columns.
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
			// A row's own track size follows its string; a row with none is
			// `auto`, and is written out so the track list stays positional.
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

/**
 * `grid` (css-grid-2 §7.4): the whole explicit grid, or one axis of it
 * against an `auto-flow` that sizes the other's implicit tracks. Either way
 * the shorthand resets every longhand it stands for, which is what makes it
 * safe to write once at the top of a rule.
 */
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

	// The axis the flow runs along takes the implicit sizes; the other axis
	// takes the explicit track list written across the slash.
	return flowInSecond ?
			{
				"grid-template-rows": otherGroup || "none",
				"grid-template-columns": "none",
				"grid-template-areas": "none",
				"grid-auto-flow": dense ? "column dense" : "column",
				"grid-auto-columns": sizes || "auto",
				"grid-auto-rows": "auto",
			} :
			{
				"grid-template-columns": otherGroup || "none",
				"grid-template-rows": "none",
				"grid-template-areas": "none",
				"grid-auto-flow": dense ? "row dense" : "row",
				"grid-auto-rows": sizes || "auto",
				"grid-auto-columns": "auto",
			};
}

/** The easing keywords css-easing-1 defines. */
const EASING_KEYWORDS = new Set([
	"linear",
	"ease",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"step-start",
	"step-end",
]);

/** The easing function names; their arguments are judged at build time. */
const EASING_FUNCTION_NAMES = new Set(["linear", "cubic-bezier", "steps"]);

/** Whether a component spells an `<easing-function>`. */
function isEasingValue(token: string): boolean {
	const node = singleValueNode(token);
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

/**
 * `transition: <single-transition>#`, each item `<property> || <duration> ||
 * <easing> || <delay> || <behavior>`. The first time is the duration and the
 * second the delay; each longhand collects one slot per item.
 */
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
			if (times.length < 2 && cssTimeMs(token) !== null) {
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

/**
 * The lines `text-decoration-line` names, for a value whose grammar the index
 * refuses -- one carrying a substitution, which still declares the lines it
 * spells outright.
 */
const DECORATION_LINE_KEYWORDS = new Set([
	"none",
	"underline",
	"overline",
	"line-through",
	"blink",
	"spelling-error",
	"grammar-error",
]);

/**
 * Expand CSS SHORTHANDS into the longhands everything downstream reads.
 * Declarations are consulted per-property, so a `border: 1px solid` that
 * never becomes border-top-width etc. simply doesn't exist to the box model
 * or the border painter. Declaration order is preserved, so an explicit
 * longhand after a shorthand still overrides it.
 *
 * A shorthand keeps its own entry alongside the longhands it declares, so
 * `getPropertyValue("border")` still answers what was authored. `margin`,
 * `padding` and `border-radius` are the exception: their computed answers are
 * serialized from the four longhands, so keeping the shorthand would shadow
 * that.
 */
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
			case "border-top":
			case "border-right":
			case "border-bottom":
			case "border-left": {
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
			// ends of the axis, or one for each. They state their longhands
			// and, like `margin` and `padding`, are serialized back from them.
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
			// `border-block` / `border-inline`: one line drawn on both ends of
			// the axis.
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
			// One flow-relative edge's line: `border-inline-start: 1px solid`.
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
				// `<line> || <style> || <color> || <thickness>`; only the line
				// component has a terminal rendering, and it is the one the
				// painter reads.
				const traced = grammarTerms(property, value);
				const line = (
					traced ?
							traced
								.filter((component) =>
									component.terms.includes("text-decoration-line"),
								)
								.map((component) => component.text) :
							values.filter((token) =>
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

// ---- CSS spec defaults ----
/**
 * CSS specification defaults for properties
 */
const CSS_SPEC_DEFAULTS: Record<string, string> = {
	"display": "inline",
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
	"color": "#000000",
	// One cell tall: the terminal's font is the grid, and a length written in
	// em is a length written in cells.
	"font-size": "1px",
	"font-weight": "normal",
	"font-style": "normal",
	"text-decoration": "none",
	"white-space": "normal",
	"overflow": "visible",
	"position": "static",
	"width": "auto",
	"height": "auto",
	"box-sizing": "border-box",
	// Terminal-optimized flexbox defaults
	// Container properties
	"flex-direction": "row",
	"flex-wrap": "nowrap",
	// `normal` is CSS's own initial value on both, and the one grid needs: it
	// is what tells a grid's auto tracks to fill the container. In a flex
	// container it means what flex-start meant here before, so nothing about
	// flex layout moves.
	"justify-content": "normal",
	"align-items": "stretch",
	"align-content": "normal",
	"gap": "0",
	"row-gap": "0",
	"column-gap": "0",
	// Item properties
	"flex-grow": "0",
	"flex-shrink": "1",
	"flex-basis": "auto",
	"align-self": "auto",
	"order": "0",
};

// ---- Element defaults the stylesheet cannot express ----

/**
 * The per-element defaults that are STATE, not stylesheet: the fullscreen
 * element's viewport block (explicit cells -- the alternate screen IS the
 * containing geometry), a select sized to its widest option label so the
 * field never jumps as the selection changes, and the size attribute
 * driving a text input's width. Everything expressible as CSS lives in
 * UA_ELEMENT_STYLES; these resolve at the initial-value layer, below it.
 */
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
				"position": "fixed",
				"top": "0px",
				"left": "0px",
				"width": `${window.innerWidth}ch`,
				"height": `${window.innerHeight}px`,
				"background-color": "Canvas",
			};
		}
	}
	if (name === "select") {
		const select = element as HTMLSelectElement;
		let widest = 0;
		for (const option of select.options) {
			widest = Math.max(widest, stringWidth(option.label));
		}
		return {width: `${widest + 2}ch`};
	}
	if (name === "input") {
		const input = element as HTMLInputElement;
		if (input.type === "checkbox" || input.type === "radio") {
			return undefined;
		}
		// A text input's width is attribute state: size columns when the
		// attribute says so, the spec's 20 otherwise. It lives here rather
		// than in the sheet so the attribute can beat the default without a
		// width the sheet cannot spell (there is no attr() length).
		const size = parseInt(input.getAttribute("size") ?? "", 10);
		return {
			width: `${Number.isFinite(size) && size > 0 ? size : 20}ch`,
		};
	}
	return undefined;
}

// ---- Inheritance / initial-value tables ----
/**
 * Properties that inherit by default
 */
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

/**
 * A property's initial value on an element, or -- with no element, as for a
 * pseudo-element -- the initial value alone, which no element default has a
 * say in.
 */
function getInitialStyle(
	element: Element | null,
	property: string,
): string {
	// Check element-specific defaults first
	const elementDefaults = element ? getElementDefaults(element) : null;
	if (elementDefaults && elementDefaults[property]) {
		return elementDefaults[property];
	}

	// Fall back to CSS spec default, and past it to the property index --
	// every longhand has an initial value, and a property this engine does not
	// lay out still resolves to one.
	return CSS_SPEC_DEFAULTS[property] || CSS_INITIAL_VALUES[property] || "";
}

/**
 * Helper to get computed style property value for an element.
 */
export function getPropertyValue(element: Element, property: string): string {
	// The COMPUTED value, not the resolved one: layout and paint decide
	// geometry from this, and a used value here would feed layout its own
	// output. It is the internal path by construction -- computedStyleOf
	// reaches the cascade's declaration directly -- so there is no branch to
	// guard, nothing to unwind, and nothing between here and the value but
	// two map lookups.
	return computedStyleOf(element).computedValueOf(property);
}

/**
 * The number a value leads with, read off its Dimension, Number or
 * Percentage node. The unit collapses to the count -- px and ch both
 * measure one cell here -- and a percentage keeps its mark for the caller
 * to resolve against a basis.
 */
function leadingUnitValue(
	value: string,
): number | {percentage: number} | null {
	const nodes = value ? cssValueChildren(value.trim()) : null;
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
 * A nonnegative length or percentage, or null. Negative lengths are
 * refused here -- a negative width, padding or border is invalid CSS and
 * must not reach layout -- and parseSignedUnitValue carries the sign for
 * the paths that take one.
 */
export function parseUnitValue(
	value: string,
): number | {percentage: number} | null {
	const parsed = leadingUnitValue(value);
	const number =
		typeof parsed === "number" ?
			parsed :
			parsed !== null ?
				parsed.percentage :
				null;
	return number !== null && number < 0 ? null : parsed;
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

/** Lengths that may be negative: margins (and offsets) opt into the sign. */
export function parseSignedUnitValue(
	value: string,
): ReturnType<typeof parseUnitValue> {
	return leadingUnitValue(value ?? "");
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

/**
 * Parse CSS box model properties from an element's computed style
 */
export function getBoxModel(element: Element): BoxModel {
	// The engine's own read: the cascade's declaration, straight, with none of
	// the author path's resolved-value work between here and the values layout
	// is about to decide geometry from.
	return readBoxModel(computedStyleOf(element));
}

function readBoxModel(computedStyle: ComputedStyle): BoxModel {
	// Parse explicit width/height
	const widthValue = parseUnitValue(computedStyle.computedValueOf("width"));
	const heightValue = parseUnitValue(computedStyle.computedValueOf("height"));

	// Parse padding
	const paddingTop = parseUnitValue(
		computedStyle.computedValueOf("padding-top"),
	);
	const paddingRight = parseUnitValue(
		computedStyle.computedValueOf("padding-right"),
	);
	const paddingBottom = parseUnitValue(
		computedStyle.computedValueOf("padding-bottom"),
	);
	const paddingLeft = parseUnitValue(
		computedStyle.computedValueOf("padding-left"),
	);

	// Parse margin
	const marginTop = parseSignedUnitValue(
		computedStyle.computedValueOf("margin-top"),
	);
	const marginRight = parseSignedUnitValue(
		computedStyle.computedValueOf("margin-right"),
	);
	const marginBottom = parseSignedUnitValue(
		computedStyle.computedValueOf("margin-bottom"),
	);
	const marginLeft = parseSignedUnitValue(
		computedStyle.computedValueOf("margin-left"),
	);

	// Parse border. The USED width is 0 when the side's style is none or
	// hidden (css-backgrounds §3.3), however wide the width property says --
	// `border-style: none` must release the space, not just the glyphs.
	const borderWidthFor = (side: string) => {
		const style = computedStyle.computedValueOf(`border-${side}-style`);
		if (!style || style === "none" || style === "hidden") {
			return null;
		}
		return parseBorderWidthValue(
			computedStyle.computedValueOf(`border-${side}-width`),
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

/**
 * A nonzero length written without a unit (`padding-top: 1`) is invalid
 * CSS. Browsers reject the declaration at PARSE time, so it never enters
 * the cascade and a lower-priority rule still wins -- coercing it to 0
 * instead would let the bad declaration beat the good one. Terminal
 * authoring makes this an easy slip to write, since 1px is exactly one
 * cell here, so the check earns its keep: `padding-top: 1` means nothing,
 * `padding-top: 1px` means one cell.
 */
function isValidDeclaration(
	property: string,
	value: string,
	atRule = "",
): boolean {
	if (!matchesGrammar(property, value, atRule)) {
		return false;
	}
	if (!LENGTH_PROPERTIES.has(property)) {
		return true;
	}
	// A shorthand is invalid as a WHOLE if one component is, so one bare
	// nonzero Number node rejects the declaration. Only top-level nodes
	// count: a number nested in a calc() is the grammar's business.
	const nodes = cssValueChildren(value.trim());
	if (!nodes) {
		return true;
	}
	return !nodes.some(
		(node) => node.type === "Number" && parseFloat(node.value ?? "") !== 0,
	);
}

/**
 * Whether a value fits its property's grammar, memoized: a declaration is
 * parsed once for every element that declares it, and the same handful of
 * values recur across a whole document.
 */
const grammarMatches = new Map<string, boolean>();

/**
 * Whether a declared value matches the property's grammar, as the property
 * index states it. A value that does not is not a declaration at all: it
 * leaves whatever stood there standing, which is what makes `color: notacolor`
 * a no-op rather than a value.
 *
 * A value carrying a substitution is not judged: what it means depends on what
 * the custom property holds, which is not known here.
 */
function matchesGrammar(property: string, value: string, atRule = ""): boolean {
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
		const match = atRule ?
				grammarLexer.matchAtruleDescriptor(atRule.slice(1), property, text) :
				grammarLexer.matchProperty(property, text);
		// A descriptor or property the grammars do not describe is one this
		// cannot judge.
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

/**
 * The same registry keyed by DOCUMENT rather than window.
 *
 * A window is one object per document, and an element holds its document
 * rather than its window: the internal read path takes this door so that a
 * cascade is found from a node without a hop through the window.
 */
const documentManagers = new WeakMap<object, StyleManager>();

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
				if (content[close] === "\\") {
					close++;
				}
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
			if (child.tagName !== "LI") {
				continue;
			}
			const marker = styleManager ?
					styleManager.getMarkerContent(child) :
					withMarkerSeparator(getListMarker(child, listElement));
			if (!marker) {
				continue;
			}
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

/**
 * Properties whose value carries author text -- strings, family names,
 * function bodies -- and so is never case-folded.
 */
const VERBATIM_PROPERTIES = new Set([
	"background-image",
	"content",
	"counter-increment",
	"counter-reset",
	"font",
	"font-family",
	// A grid value carries custom idents -- line names and area names, which
	// are case-sensitive -- alongside its keywords, so it cannot be folded.
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

/** A value that is one bare CSS identifier, which computes case-folded. */
const IDENTIFIER_VALUE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * A numeric component in its computed spelling: the sign and any trailing
 * zeros dropped, the unit case-folded, and a unitless zero given the `px` a
 * length always computes to.
 */
function computedNumber(token: string): string {
	const node = singleValueNode(token);
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

/** The corner radii, whose value is a horizontal radius and a vertical one. */
const RADIUS_LONGHANDS = new Set([
	"border-top-left-radius",
	"border-top-right-radius",
	"border-bottom-right-radius",
	"border-bottom-left-radius",
]);

/**
 * A corner radius with its second component dropped where the two agree: a
 * circular corner states one radius, an elliptical one states both.
 */
function collapseRadius(value: string): string {
	const parts = value.split(/\s+/).filter(Boolean);
	return parts.length === 2 && parts[0] === parts[1] ? parts[0] : value;
}

/**
 * `grid-template-areas` computes to a list of rows, each a list of cell names
 * (css-grid-2 §7.3), so the spacing an author lines a picture of the grid up
 * with is not part of the value: every row writes its cells one space apart.
 * A value that is not a run of strings -- `none`, a var() still to substitute
 * -- is left as it is written.
 */
function normalizeGridAreas(value: string): string {
	const children = cssValueChildren(value);
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

/**
 * The computed spelling of a declared value: the one place a struct becomes
 * a string, at the getPropertyValue boundary.
 */
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
		const lengths = value.split(/\s+/).map(computedNumber).join(" ");
		return RADIUS_LONGHANDS.has(property) ? collapseRadius(lengths) : lengths;
	}
	return IDENTIFIER_VALUE.test(value) ? value.toLowerCase() : value;
}

/**
 * The properties whose value absolutizes against the element it is computed
 * on: every property that takes a length, plus the two whose percentage is
 * font-relative. A value on any other property is the same string on every
 * element, and interning is the whole of its computation.
 */
const ABSOLUTIZED_PROPERTIES = new Set([
	...LENGTH_PROPERTIES,
	"border-spacing",
	// A track list holds lengths inside functions and among keywords, so it
	// absolutizes by token rather than by the whitespace-separated split the
	// length properties take.
	"grid-auto-columns",
	"grid-auto-rows",
	"grid-template",
	"grid-template-columns",
	"grid-template-rows",
	"line-height",
	"text-underline-offset",
	"vertical-align",
]);

/**
 * The properties whose percentage resolves at computed-value time, against
 * the font size: `font-size` against the parent's, `line-height` against the
 * element's own. Every other percentage stays a percentage until it is used.
 */
const FONT_RELATIVE_PERCENTAGES = new Set(["font-size", "line-height"]);

/** A number carrying a unit that only an element can measure. */
const RELATIVE_UNIT = /[\d.](?:r?em|ex|ch|vw|vh|vmin|vmax)\b/i;

/**
 * One interned computed value: the string, and whether answering it needs
 * the element -- a relative length to absolutize, a calc() to reduce, a
 * font-relative percentage to resolve. The flag is decided once per declared
 * text, so the common value (a keyword, an integer, a px or ch length) is
 * still nothing but two map lookups.
 */
interface ComputedEntry {
	value: string;
	contextual: boolean;
}

const EMPTY_ENTRY: ComputedEntry = {value: "", contextual: false};

/**
 * Computed strings interned by property and declared text. A document draws
 * its declared values from a small vocabulary -- a handful of colors, a
 * handful of lengths, the same keywords on every element -- so the same pair
 * recurs across thousands of elements, and again after each re-resolution.
 */
const computedValues = new Map<string, Map<string, ComputedEntry>>();

function computedEntry(property: string, declared: string): ComputedEntry {
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

function computedValue(property: string, declared: string): string {
	return computedEntry(property, declared).value;
}

/** The unit a length measures in, and the px each one of it is worth. */
interface LengthContext {
	/** The font size relative units measure against, in px. */
	font: number;
	/** The root element's font size, for `rem`. */
	root: number;
	viewportWidth: number;
	viewportHeight: number;
	/** What a percentage is worth, or null where percentages stay. */
	percent: number | null;
}

/**
 * The font size a terminal draws with: one cell. It is the initial value
 * `font-size` computes to, so `1em` is one cell in a document that declares
 * no font size -- and a document that declares one still gets the spec's
 * arithmetic, which the grid then rounds to cells.
 */
const INITIAL_FONT_SIZE = 1;

function fontSizeOf(style: ComputedStyle): number {
	const size = parseFloat(style.computedValueOf("font-size"));
	return Number.isFinite(size) ? size : INITIAL_FONT_SIZE;
}

function unitFactor(unit: string, context: LengthContext): number | null {
	switch (unit.toLowerCase()) {
		case "em":
			return context.font;
		case "rem":
			return context.root;
		// A terminal has no font metrics: every glyph is one cell, so the
		// x-height a browser measures is the half-em it falls back to.
		case "ex":
			return context.font / 2;
		// One cell wide, whatever font size the document declares -- the grid's
		// column is not something a style can resize.
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

/** A length in the spelling a computed value carries: px, six decimals at most. */
function absoluteLength(px: number): string {
	return `${Math.round(px * 1e6) / 1e6}px`;
}

/** A number token followed by its unit, anywhere in a value. */
const LENGTH_TOKEN = /([+-]?(?:\d+\.?\d*|\.\d+))(%|[a-zA-Z]+)/g;

/**
 * A computed value with every relative length replaced by the absolute one it
 * computes to, and every calc() reduced. What is left is px, the percentages
 * a property keeps until it is used, and whatever this engine does not
 * measure -- which passes through untouched.
 */
function absolutizeLengths(value: string, context: LengthContext): string {
	const reduced = value.includes("calc(") ? replaceCalc(value, context) : value;
	return reduced.replace(
		LENGTH_TOKEN,
		(token, number: string, unit: string) => {
			const factor = unitFactor(unit, context);
			return factor === null ?
				token :
					absoluteLength(parseFloat(number) * factor);
		},
	);
}

/** Each calc() in a value, replaced by the value it reduces to. */
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

/**
 * What a math function reduces to: a length in px, a percentage, and a plain
 * number, at most one of which a valid calc() leaves nonzero alongside the
 * others.
 */
interface CalcTerms {
	px: number;
	percent: number;
	number: number;
}

/**
 * The reduced form of a sum, per css-values: a lone term serializes as
 * itself, and a length that still carries a percentage keeps the calc() it
 * needs to hold the two together.
 */
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

/**
 * A calc() body reduced to its terms. Null for anything this cannot reduce --
 * a nested min()/max()/clamp(), a unit with no cell length, an unsubstituted
 * var() -- which leaves the value as the author wrote it.
 */
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
		const factor = unitFactor(match[2], context);
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
	/**
	 * Each declaration's position in the block, counting from the first. A
	 * logical property and the physical property it maps to are two names for
	 * one cascade slot, so which of them a block declares LAST decides the
	 * value -- and only this says which that is.
	 */
	order: Record<string, number>;
}

const EMPTY_DECLARATIONS: DeclarationBlock = {
	declarations: {},
	important: {},
	order: {},
};

/**
 * Which of a cascade slot's names a block declares LAST at the given
 * importance -- the declaration whose value the slot takes -- or null when it
 * declares none of them. `accepts` rejects a flow-relative name that maps to
 * the opposite physical edge under the element's direction.
 */
function declaredName(
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

/**
 * Every flow-relative longhand and the physical longhand it maps to, one table
 * per inline direction (css-logical-1 §2).
 *
 * This engine renders one writing mode -- `horizontal-tb`, the only one a
 * terminal's row-major grid has -- so the block axis is always vertical and
 * the inline axis always horizontal: block-start is the top edge, block-end
 * the bottom, and `direction` alone decides which side the inline edges name.
 * A `writing-mode` implementation would replace these two tables with four
 * more; nothing else here would move.
 */
const LOGICAL_TO_PHYSICAL: Readonly<
	Record<"ltr" | "rtl", Map<string, string>>
> = {ltr: new Map(), rtl: new Map()};

/**
 * Each physical longhand and the flow-relative longhands that can name it --
 * its block counterpart, or both inline ones, since which of those maps here
 * is not known until an element states its direction.
 */
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
	// not reach them: only a vertical writing mode could.
	for (const prefix of ["", "min-", "max-"]) {
		map(`${prefix}block-size`, `${prefix}height`);
		map(`${prefix}inline-size`, `${prefix}width`);
	}
	// `grid-row-gap` and `grid-column-gap` are not flow-relative at all: they
	// are the OLD SPELLING of the gap properties (css-align-3 §8.4). Sharing a
	// cascade slot is what an alias is, though, so they are declared here --
	// one slot, whichever of the two names the winning declaration used.
	map("grid-row-gap", "row-gap");
	map("grid-column-gap", "column-gap");
}

/** The physical longhand a flow-relative one names under `direction`, if it is one. */
function physicalProperty(
	property: string,
	direction: string,
): string | undefined {
	return LOGICAL_TO_PHYSICAL[direction === "rtl" ? "rtl" : "ltr"].get(property);
}

/**
 * The OTHER names of the cascade slot a longhand belongs to under `direction`:
 * a flow-relative longhand's physical counterpart, or a physical longhand's
 * flow-relative ones. Empty for a longhand that stands alone.
 */
function slotNames(property: string, direction: string): readonly string[] {
	const physical = physicalProperty(property, direction);
	if (physical) {
		return [physical];
	}
	const logical = PHYSICAL_TO_LOGICAL.get(property);
	if (!logical) {
		return [];
	}
	return logical.filter(
		(name) => physicalProperty(name, direction) === property,
	);
}

const CORNER_NAMES = [
	"top-left",
	"top-right",
	"bottom-right",
	"bottom-left",
] as const;

/**
 * The shape of a shorthand's grammar, and so how its value serializes: a box
 * of four sides or corners collapsed to one to four values, a radius box
 * whose corners each carry two values, a pair collapsed when both agree, a
 * line's width/style/color, `border`'s three uniform boxes, or a plain
 * sequence of components.
 */
type ShorthandShape =
	"box" |
	"radius" |
	"pair" |
	"line" |
	"border" |
	"grid-line" |
	"grid-template" |
	"sequence";

/**
 * Each shorthand's longhands, in the order its grammar names them: the
 * property index lists a box's sides alphabetically, where the grammar --
 * and so the order the longhands are stored and serialized in -- runs
 * top, right, bottom, left.
 */
const SHORTHAND_LONGHANDS = new Map<string, readonly string[]>();

/** Each shorthand's shape, classified once rather than per serialization. */
const SHORTHAND_SHAPES = new Map<string, ShorthandShape>();

/** The placement shorthands, whose components are separated by slashes. */
const GRID_LINE_SHORTHANDS = new Set(["grid-area", "grid-column", "grid-row"]);

/** Whether a grid-placement component is a `<custom-ident>` and nothing else. */
function isGridCustomIdent(value: string): boolean {
	return (
		/^-?[A-Za-z_][\w-]*$/.test(value) && value !== "auto" && value !== "span"
	);
}

/**
 * The longhands a shorthand resets but whose values its own grammar cannot
 * state: a block missing them cannot serialize as the shorthand, and they
 * take no place in the value it writes.
 */
const RESET_ONLY_LONGHANDS = new Map<string, ReadonlySet<string>>(
	Object.entries(CSS_RESET_ONLY_LONGHANDS).map(([shorthand, longhands]) => [
		shorthand,
		new Set(longhands),
	]),
);

for (const [shorthand, all] of Object.entries(CSS_SHORTHANDS)) {
	const reset = CSS_RESET_ONLY_LONGHANDS[shorthand];
	const indexed = reset ?
			all.filter((longhand) => !reset.includes(longhand)) :
		all;
	const box = boxOrder(indexed, EDGE_NAMES) ?? boxOrder(indexed, CORNER_NAMES);
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
		GRID_LINE_SHORTHANDS.has(shorthand) ?
			"grid-line" :
			shorthand === "grid" || shorthand === "grid-template" ?
				"grid-template" :
				box ?
					radius ?
						"radius" :
						"box" : // A width, a style and a color stated once for several sides:
				// four for `border`, the axis's two for `border-block` and
				// `border-inline`.
					indexed.length >= 2 * LINE_COMPONENTS.length &&
					LINE_COMPONENTS.every(
						(kind) =>
							indexed.filter((longhand) => longhand.endsWith(`-${kind}`))
								.length ===
								indexed.length / LINE_COMPONENTS.length,
					) ?
						"border" :
						indexed.length === LINE_COMPONENTS.length &&
						indexed.every((longhand, index) =>
							longhand.endsWith(`-${LINE_COMPONENTS[index]}`),
						) ?
							"line" :
							indexed.length === 2 && axisPair(shorthand, indexed) ?
								"pair" :
								"sequence",
	);
}

/**
 * Whether a two-longhand shorthand states ONE property on two axes -- `gap`,
 * `overflow`, `place-content`, `margin-inline` -- rather than two properties
 * side by side. An axis pair writes one value where its two agree, and copies
 * a single stated value to both; a shorthand like `flex-flow` writes each
 * component it has and drops the ones left at their initial value.
 *
 * The two longhands of an axis pair name the shorthand's own property: they
 * are built on it as a stem, or they end in the segment it ends in.
 */
function axisPair(shorthand: string, longhands: readonly string[]): boolean {
	if (longhands.every((longhand) => longhand.startsWith(shorthand))) {
		return true;
	}
	const segment = shorthand.slice(shorthand.lastIndexOf("-") + 1);
	return longhands.every((longhand) => longhand.endsWith(`-${segment}`));
}

/**
 * The shorthands a longhand belongs to, widest first: block serialization
 * prefers the shorthand covering the most declarations, and `all` -- covering
 * every longhand there is -- comes first of all. A vendor-prefixed shorthand
 * comes last however wide it is: `-webkit-border-start` covers exactly the
 * longhands `border-inline-start` does, and is not the name to write them as.
 */
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

/** A node a `<supports-condition>` parses into. */
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

/**
 * A `<supports-condition>` against this engine, on the nodes css-tree parses
 * it into. Text css-tree refuses, and a word standing where an operand
 * belongs, are conditions nothing supports.
 */
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

/**
 * The operands one joiner stands between, in source order. The grammar
 * css-conditional-3 writes is narrow: a `not` opens a condition of its own,
 * a joined condition holds `and` throughout or `or` throughout, and an
 * operand and a joiner take turns. A condition off that grammar supports
 * nothing.
 */
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
			matches === null ?
				operand :
				joiner === "or" ?
					matches || operand :
					matches && operand;
		awaited = false;
	}
	// A negated operand is a whole condition, so nothing may be joined to it.
	if (awaited || matches === null || (negate && joiner !== null)) {
		return false;
	}
	return matches;
}

/**
 * One `<supports-in-parens>`: a nested condition, a declaration this engine
 * would honour, or a `selector()` this engine's own selector parser reads.
 * A condition of any other shape -- `font-format()`, `font-tech()` -- is one
 * nothing here supports.
 */
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
	// the cascade's own selector parser answers.
	if (part.type === "FeatureFunction" && part.feature === "selector") {
		const selector = sliceOf(part.value);
		return selector !== null && parseSelectorList(selector) !== null;
	}
	return false;
}

/**
 * Whether a declaration would be honoured: `CSS.supports(property, value)`, and
 * the one-argument form that takes a `@supports` condition. The one-argument
 * form reads its text as a condition, and failing that as a condition the
 * parentheses were left off of, which is the pair of steps css-conditional-3
 * gives it.
 */
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

/** The `CSS` namespace object: identifier escaping and support queries. */
const CSSNamespace = {
	escape(ident: string): string {
		if (arguments.length === 0) {
			throw typeError("escape requires an identifier");
		}
		return serializeCSSIdentifier(String(ident));
	},
	supports: cssSupports,
};
// A namespace object's class string is its name, and it is not writable.
Object.defineProperty(CSSNamespace, Symbol.toStringTag, {
	value: "CSS",
	writable: false,
	enumerable: false,
	configurable: true,
});

/** The declarations of a `style` attribute, a `cssText`, or a rule's block. */
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
		// stand between them.
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
	if (!longhands) {
		return null;
	}
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

/**
 * A corner radius as its two axes, the vertical one taken from the horizontal
 * where the value states a single radius.
 */
function radiusAxes(value: string): [string, string] {
	const [horizontal, vertical = horizontal] = value
		.split(/\s+/)
		.filter(Boolean);
	return [horizontal ?? "0px", vertical ?? "0px"];
}

/** The four values of a box shorthand, collapsed to the shortest equivalent. */
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

/**
 * The longhands of `shorthand` grouped by the side or corner each names, in
 * the order the shorthand's grammar writes them, or null when the longhands
 * are not a box.
 */
function boxOrder(
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
	return ordered.every((name): name is string => name !== undefined) ?
		ordered :
		null;
}

/** A shorthand's value, reconstructed from its longhands' values. */
function serializeShorthandValue(
	shorthand: string,
	longhands: readonly string[],
	valueOf: (longhand: string) => string,
): string {
	const all = longhands.map(valueOf);
	// A CSS-wide keyword serializes as itself only when every longhand holds
	// the same one; one longhand overridden and the shorthand has no value.
	if (all.some((value) => CSS_WIDE_KEYWORDS.has(value))) {
		return all.every((value) => value === all[0]) ? all[0] : "";
	}

	// A longhand the shorthand resets without stating -- border-image under
	// `border` -- takes no place in the value written, and a value of its own
	// that the shorthand cannot express means it cannot be written at all.
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
	const stated = reset ?
			longhands.filter((longhand) => !reset.has(longhand)) :
		longhands;
	const values = reset ? stated.map(valueOf) : all;

	switch (SHORTHAND_SHAPES.get(shorthand)) {
		case "box":
			return collapseSides(values);
		// `border-radius` writes the four horizontal radii, then the four
		// vertical ones after a slash -- and drops the slash entirely where
		// the two axes agree, which is every circular corner.
		case "radius": {
			const axes = values.map(radiusAxes);
			const across = collapseSides(axes.map(([horizontal]) => horizontal));
			const down = collapseSides(axes.map(([, vertical]) => vertical));
			return across === down ? across : `${across} / ${down}`;
		}
		// `border` and its logical twins are three uniform boxes -- widths,
		// styles and colors -- and serialize only when every side agrees.
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
		// css-grid-2 §8.4: the components run start / end (and, for
		// `grid-area`, both axes' of each), and a trailing one is dropped when
		// it states the value the omission already implies -- the opposite
		// component when that is a name, and `auto` otherwise.
		case "grid-line": {
			const implied = (from: string): string =>
				isGridCustomIdent(from) ? from : "auto";
			const kept = [...values];
			// grid-area's four are [row-start, column-start, row-end,
			// column-end]; the pair shorthands' two are [start, end].
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
		// `grid-template` writes its rows and columns around a slash. Its
		// third form -- the picture of the grid, whose strings and row sizes
		// interleave -- states an area map, and no rows-and-columns spelling
		// can carry one: a block holding one serializes as its longhands.
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
			if (index === required) {
				return true;
			}
			const initial = CSS_INITIAL_VALUES[longhand];
			return !initial || value !== initial;
		})
		.map(([, value]) => value);
	if (kept.length > 0) {
		return kept.join(" ");
	}
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
class CSSStyleDeclaration implements DeclarationSource {
	[index: number]: string;
	declare [kElement]: Element | null;
	declare [kParentRule]: CSSRule | null;
	declare [kOnChange]: (() => void) | null;
	/**
	 * The at-rule whose descriptors this block holds, empty for a block of CSS
	 * properties. A descriptor is named only inside its own at-rule, and only
	 * its own at-rule's grammar can judge its value.
	 */
	declare [kDescriptors]: string;
	/** Whether this block is one keyframe of an animation. */
	declare [kKeyframe]: boolean;
	declare [kDeclarations]: CSSDeclaration[];
	/**
	 * The declarations by name. A block holds one declaration per property, so
	 * a lookup is a map read; `all` expands to every longhand there is, and a
	 * scan per lookup would make serializing such a block cubic in its size.
	 */
	declare [kByName]: Map<string, CSSDeclaration>;
	/** The `style` attribute text this object last serialized or parsed. */
	declare [kAttributeText]: string | null;
	/** The declarations expanded to longhands for the cascade. */
	declare [kBlock]: DeclarationBlock | null;
	/** How many numeric index properties currently name a declaration. */
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
		this[kDescriptors] = "";
		this[kKeyframe] = false;
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

	/** Adopt the `style` attribute when it says something this object did not write. */
	[kSync](): void {
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
			apply(
				this,
				declaration.name,
				declaration.value,
				declaration.important,
				true,
			);
		}
		invalidate(this);
	}

	/** The declarations as the cascade consumes them: longhands, importance included. */
	declarationBlock(): DeclarationBlock {
		this[kSync]();
		if (this[kDeclarations].length === 0) {
			return EMPTY_DECLARATIONS;
		}
		if (this[kBlock]) {
			return this[kBlock];
		}

		const declarations: Record<string, string> = {};
		const important: Record<string, boolean> = {};
		const order: Record<string, number> = {};
		const importantValues: Record<string, string> = {};
		let undecomposed = false;
		this[kDeclarations].forEach((entry, index) => {
			// An invalid declaration never enters the cascade: dropping it is
			// what lets a lower-priority rule keep winning, as a browser does.
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

		// An inline `transition` opens the sticky gate a rule opens; the
		// block parse is the one door both the attribute and setProperty
		// spellings come through.
		if (
			this[kElement] &&
			(declarations["transition"] !== undefined ||
				declarations["transition-duration"] !== undefined ||
				declarations["transition-delay"] !== undefined)
		) {
			const document = this[kElement].ownerDocument;
			const manager = document ? documentManagers.get(document) : undefined;
			if (manager) {
				manager[kTransitionsExist] = true;
			}
		}

		// The block holds longhands, which is what the cascade consults --
		// except for a shorthand whose grammar this engine does not decompose,
		// which reaches the cascade as whatever longhands it can name, its
		// importance covering each of them. A longhand a shorthand states
		// stands where the shorthand does.
		if (undecomposed) {
			for (const property of Object.keys(expandShorthands(importantValues))) {
				important[property] = true;
			}
			this[kDeclarations].forEach((entry, index) => {
				const expanded = expandShorthands({[entry.name]: entry.value});
				for (const property in expanded) {
					order[property] = index;
				}
			});
			return (this[kBlock] = {
				declarations: expandShorthands(declarations),
				important,
				order,
			});
		}
		return (this[kBlock] = {declarations, important, order});
	}

	get parentRule(): CSSRule | null {
		return this[kParentRule];
	}

	get length(): number {
		this[kSync]();
		return this[kDeclarations].length;
	}

	item(index: number): string {
		this[kSync]();
		return this[kDeclarations][index]?.name ?? "";
	}

	[Symbol.iterator](): IterableIterator<string> {
		this[kSync]();
		return this[kDeclarations].map((entry) => entry.name)[Symbol.iterator]();
	}

	getPropertyValue(property: string): string {
		this[kSync]();
		const name = normalizePropertyName(property);
		const declared = find(this, name);
		if (declared) {
			return declared.value;
		}
		const longhands = SHORTHAND_LONGHANDS.get(name);
		return longhands ? shorthandValue(this, name, longhands) : "";
	}

	getPropertyPriority(property: string): string {
		this[kSync]();
		const name = normalizePropertyName(property);
		const declared = find(this, name);
		if (declared) {
			return declared.important ? "important" : "";
		}
		const longhands = SHORTHAND_LONGHANDS.get(name);
		if (
			longhands &&
			longhands.every((longhand) => find(this, longhand)?.important)
		) {
			return "important";
		}
		return "";
	}

	setProperty(property: string, value: string, priority?: string): void {
		this[kSync]();
		const name = normalizePropertyName(property);
		if (!supports(this, name)) {
			return;
		}
		// `[LegacyNullToEmptyString]`: null names the empty value, which removes
		// the declaration. Every other value is stringified, and `undefined`
		// stringifies to a value no property has -- so the call does nothing.
		const text = serializeCSSValue(value === null ? "" : String(value), name);
		if (text === "") {
			this.removeProperty(name);
			return;
		}
		const priorityText = String(priority ?? "").toLowerCase();
		if (priorityText !== "" && priorityText !== "important") {
			return;
		}
		if (apply(this, name, text, priorityText === "important")) {
			flush(this);
		}
	}

	removeProperty(property: string): string {
		this[kSync]();
		const name = normalizePropertyName(property);
		const previous = this.getPropertyValue(name);
		let changed = remove(this, name);
		for (const longhand of SHORTHAND_LONGHANDS.get(name) ?? []) {
			changed = remove(this, longhand) || changed;
		}
		if (changed) {
			flush(this);
		}
		return previous;
	}

	get cssText(): string {
		this[kSync]();
		return serialize(this);
	}

	set cssText(text: string) {
		this[kSync]();
		this[kDeclarations] = [];
		this[kByName].clear();
		for (const declaration of parseDeclarationText(text ?? "")) {
			if (!supports(this, declaration.name)) {
				continue;
			}
			apply(
				this,
				declaration.name,
				declaration.value,
				declaration.important,
				true,
			);
		}
		flush(this);
	}
}

/** Serialize a CSS declaration block: shorthands reconstructed, priority kept. */
function serialize(
	block: CSSStyleDeclaration,
): string {
	const parts: string[] = [];
	const serialized = new Set<string>();
	// A shorthand this block cannot express is one it cannot express at
	// any of its longhands: the declarations do not change under the walk.
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
			// A shorthand covering more properties than the block holds
			// cannot be serialized from it, and `all` covers hundreds.
			if (longhands.length > block[kDeclarations].length) {
				continue;
			}
			const value = shorthandValue(block, shorthand, longhands);
			if (!value) {
				unserializable.add(shorthand);
				continue;
			}
			const important = find(block, longhands[0])!.important;
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

/** Serialize to the `style` attribute, which is what invalidation observes. */
function flush(
	declaration: CSSStyleDeclaration,
): void {
	invalidate(declaration);
	if (declaration[kElement]) {
		declaration[kAttributeText] = serialize(declaration);
		declaration[kElement].setAttribute("style", declaration[kAttributeText]);
	}
	declaration[kOnChange]?.();
}

function invalidate(
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

function find(
	declaration: CSSStyleDeclaration,
	property: string,
): CSSDeclaration | undefined {
	return declaration[kByName].get(property);
}

/**
 * Whether this block may hold `name`: a supported CSS property or a custom
 * property, or -- in an at-rule's block -- any descriptor it names, since
 * the property index does not describe descriptors.
 */
function supports(
	declaration: CSSStyleDeclaration,
	name: string,
): boolean {
	// A keyframe's block is a step of an animation, and the animation's own
	// properties describe the whole rather than the step.
	if (declaration[kKeyframe] && KEYFRAME_EXCLUDED.test(name)) {
		return false;
	}
	if (declaration[kDescriptors]) {
		// An at-rule's block holds its own descriptors. One this engine
		// has no descriptor list for holds whatever it is given, which is
		// what keeps @font-feature-values' feature blocks working.
		const names = DESCRIPTOR_NAMES.get(declaration[kDescriptors]);
		return names ? names.has(name) : name !== "";
	}

	return name.startsWith("--") || SUPPORTED_PROPERTIES.has(name);
}

/**
 * Store one declaration; returns whether anything changed.
 *
 * A declaration that says something new is the LAST declaration in the
 * block: it was written after the ones already there, and the order the
 * block serializes in is the order its declarations were made. Restating
 * a declaration unchanged leaves it where it stands.
 */
function store(
	declaration: CSSStyleDeclaration,
	name: string,
	value: string,
	important: boolean,
	cascade = false,
): boolean {
	const declared = find(declaration, name);
	if (declared) {
		// Parsing a block is a cascade in miniature: a normal declaration
		// does not displace the important one already standing there.
		if (cascade && declared.important && !important) {
			return false;
		}
		if (declared.value === value && declared.important === important) {
			return false;
		}
		remove(declaration, name);
	}
	const entry = {name, value, important};
	declaration[kDeclarations].push(entry);
	declaration[kByName].set(name, entry);
	return true;
}

function remove(
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

/** Store a property as its longhands, or as itself; returns whether it changed. */
function apply(
	declaration: CSSStyleDeclaration,
	name: string,
	value: string,
	important: boolean,
	cascade = false,
): boolean {
	// A declaration whose value does not parse is not stored at all, so a
	// shorthand with one bad component drops whole rather than leaving its
	// good components behind.
	if (!isValidDeclaration(name, value, declaration[kDescriptors])) {
		return false;
	}
	const expanded = expandShorthandValue(name, value);
	if (!expanded) {
		return store(declaration, name, value, important, cascade);
	}
	let changed = remove(declaration, name);
	for (const longhand of SHORTHAND_LONGHANDS.get(name)!) {
		if (longhand in expanded) {
			continue;
		}
		if (cascade && find(declaration, longhand)?.important && !important) {
			continue;
		}
		changed = remove(declaration, longhand) || changed;
	}
	for (const [longhand, longhandValue] of Object.entries(expanded)) {
		changed =
			store(declaration, longhand, longhandValue, important, cascade) ||
			changed;
	}
	return changed;
}

/** The shorthand's value, or "" when its longhands do not agree on one. */
function shorthandValue(
	declaration: CSSStyleDeclaration,
	shorthand: string,
	longhands: readonly string[],
): string {
	let important: boolean | null = null;
	for (const longhand of longhands) {
		const declared = find(declaration, longhand);
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
		(longhand) => find(declaration, longhand)!.value,
	);
}

/**
 * The declaration block of CSS PROPERTIES: an element's inline style, a style
 * rule's block, a keyframe's. It reflects every property in the index as an
 * IDL attribute, which is what separates it from the descriptor blocks an
 * at-rule holds -- `cssFloat` reaches a style rule's block and no @page's.
 */
class CSSStyleProperties extends CSSStyleDeclaration {}

/** Custom properties keep their case; everything else is ASCII-lowercased. */
function normalizePropertyName(property: string): string {
	const name = String(property).trim();
	return name.startsWith("--") ? name : name.toLowerCase();
}

/**
 * A property name as CSS source spells it. A custom property's name is an
 * identifier, so the escapes in it spell characters that could not otherwise
 * stand there: the source `--a\;b` names the property `--a;b`.
 */
function parsePropertyName(source: string): string {
	const name = String(source).trim();
	if (!name.startsWith("--")) {
		return normalizePropertyName(name);
	}
	return name.includes("\\") ?
		`--${CSSTree.ident.decode(name.slice(2))}` :
		name;
}

/**
 * A property name as a declaration block writes it: a custom property's name
 * escaped so that reparsing the block names the same property, every other
 * name already an identifier.
 */
function serializePropertyName(property: string): string {
	return property.startsWith("--") ?
		`--${serializeCSSIdentifier(property.slice(2))}` :
		property;
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

// ============================================================================
// CSSOM: STYLESHEETS AND RULES
// ============================================================================

/**
 * The window whose CSSOM was installed last.
 *
 * An error thrown out of a stylesheet has to be the document's own
 * DOMException -- one from another global is not the error an author catches.
 * A sheet reaches its document through its owner node; a constructed one has
 * none, and takes the window its constructor came from.
 */
let cssomWindow: EngineWindow | null = null;

/** The window of the document a sheet's owner node lives in, if any. */
function sheetView(
	sheet: CSSStyleSheet | null | undefined,
): object | undefined {
	const owner = sheet ? sheet.ownerNode : null;
	const document = owner === null ? null : owner.ownerDocument;
	return document === null ? undefined : (document.defaultView ?? undefined);
}

function typeError(message: string, sheet?: CSSStyleSheet | null): TypeError {
	const view = sheetView(sheet) ?? cssomWindow ?? undefined;
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
	const view = sheetView(sheet) ?? cssomWindow ?? undefined;
	const Exception =
		(view as unknown as {DOMException?: typeof DOMException} | undefined)
			?.DOMException ?? DOMException;
	return new Exception(message, name);
}

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

/**
 * Define the collection's own index accessors, `list[0]` alongside
 * `list.item(0)`. Each accessor reads through item(), so the values are as
 * live as the collection; only the count is maintained, re-synchronized here
 * by whatever grows or shrinks the collection. Accessors beat a Proxy: every
 * non-index read of a proxied list pays the get trap, and each method read
 * pays a bind.
 */
function syncIndexed(collection: object, items?: readonly unknown[]): void {
	const list = collection as IndexedCollection;
	const previous = list[kIndexCount] ?? 0;
	const length = items ? items.length : list.length;
	for (let index = previous; index < length; index++) {
		Object.defineProperty(list, index, {
			get: items ?
					(): unknown => items[index] :
					(): unknown => list.item(index) ?? undefined,
			enumerable: true,
			configurable: true,
		});
	}
	for (let index = length; index < previous; index++) {
		delete list[index];
	}
	list[kIndexCount] = length;
}

/**
 * `text` with its comments replaced by a space. A comment stands where
 * whitespace may, so it separates the tokens around it, and one that never
 * closes runs to the end of the text as the tokenizer says. Media text is
 * split and sliced by hand here, and a comment left in would be carried into
 * a feature's parentheses and unbalance them.
 */
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

/**
 * The top-level `and`-separated conditions of one media query. Whitespace
 * inside a feature's parentheses belongs to the feature.
 */
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

/** One media feature, in its canonical spelling: `(min-width: 480px)`. */
function serializeMediaFeature(feature: string): string {
	const body = feature.slice(1, -1).trim();
	const colon = body.indexOf(":");
	if (colon === -1) {
		return `(${body.toLowerCase()})`;
	}
	const name = body.slice(0, colon).trim().toLowerCase();
	return `(${name}: ${serializeCSSValue(body.slice(colon + 1))})`;
}

/**
 * A query serialized by splitting its text, for the text css-tree refuses:
 * an unrecognized query passes through as authored, case-folded, which is
 * how a list keeps carrying queries this engine cannot judge.
 */
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

/** The nodes css-tree parses one media query into. */
interface MediaQueryNode {
	modifier?: string | null;
	mediaType?: string | null;
	condition?: MediaConditionNode | null;
}

/**
 * One part of a parsed media condition: a nested condition, a `<mf-plain>`
 * feature and its value, a `<mf-range>` comparison, or the identifier
 * `and`, `or` or `not` standing between them.
 */
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

/**
 * Parsed media query lists by their source text. A media list is asked
 * whether it matches on every sheet parse, and a document re-asks its
 * handful of spellings, so the bounded cache holds one parse per spelling.
 * The parse carries positions: serialization slices the authored text at
 * them.
 */
const mediaQueryNodes = new Map<string, MediaQueryNode[] | null>();

/** The operands and joiners a media condition holds, in source order. */
function mediaConditionParts(
	condition: MediaConditionNode | null | undefined,
): MediaConditionNode[] {
	return condition?.children ? condition.children.toArray() : [];
}

/** A media query list's queries as nodes, or null for text css-tree refuses. */
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

/**
 * One media query, in the spelling CSSOM writes: the type and the feature
 * names case-folded, one space after each colon, and the media type dropped
 * where it says nothing -- `all and (color)` is the query `(color)` is, while
 * `not all and (color)` negates the pair and keeps it.
 *
 * The query's structure -- modifier, type, the conditions `and` joins -- is
 * read off css-tree's media query nodes, parsed once here; each condition's
 * TEXT still serializes from the authored source, sliced at the node's
 * position. Comments come out first -- a slice would carry one inside a
 * feature's parentheses -- and text css-tree refuses, or spells with escapes
 * the slices would drop, keeps the splitter above.
 */
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
	// css-tree tolerates shapes the splitter treats as opaque text -- a
	// missing `and`, a dangling word -- so the source is re-walked beside the
	// nodes, and a query whose parts do not stand ` and ` apart keeps the
	// splitter's answer.
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
	// What may stand at the cursor: the first part, the joiner a feature
	// awaits, or the feature a joiner or bare `not` demands.
	let expected: "first" | "feature" | "joiner" = "first";
	for (const part of mediaConditionParts(parsed.condition)) {
		if (!part.loc) {
			return serializeMediaQueryText(text);
		}
		const gap = text.slice(cursor, part.loc.start.offset);
		cursor = part.loc.end.offset;
		if (part.type === "Identifier") {
			const word = (part.name ?? "").toLowerCase();
			// A leading `not` reads as the query's modifier, as the splitter
			// took it; `and` joins; any other bare word is a shape the
			// splitter divides differently.
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
			expected === "joiner" ?
				false :
				expected === "feature" ?
						/^\s+$/.test(gap) :
					type !== null ?
							/^\s+and\s+$/i.test(gap) :
						gap === "";
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
		// A part that opens with anything but a parenthesis -- `not(color)`
		// reads as an enclosed function -- is one the splitter took as text.
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

/** A media query list's queries: split on the commas no parenthesis encloses. */
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
export class MediaList {
	/**
	 * The queries, in their canonical spelling. Mutated in place: the indexed
	 * getter reads this array, and a list an author holds keeps answering.
	 */
	declare [kMedia]: string[];
	declare [kOnChange]: (() => void) | null;

	constructor(mediaText = "", onChange?: () => void) {
		this[kMedia] = [];
		this[kOnChange] = onChange ?? null;
		parse(this, mediaText);
	}

	get mediaText(): string {
		return this[kMedia].join(", ");
	}

	set mediaText(text: string) {
		parse(this, text);
		this[kOnChange]?.();
	}

	get length(): number {
		return this[kMedia].length;
	}

	item(index: number): string | null {
		return this[kMedia][index] ?? null;
	}

	/**
	 * Append one query. The argument is parsed as a SINGLE media query, so a
	 * comma-separated list parses to nothing and the call does nothing; a
	 * query the list already holds is not held twice.
	 */
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

	/** Delete every query equal to this one, or throw when the list holds none. */
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

	[Symbol.iterator](): IterableIterator<string> {
		return this[kMedia][Symbol.iterator]();
	}

	toString(): string {
		return this.mediaText;
	}
}

function parse(
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
		for (const child of Array.from(group.cssRules)) {
			detachRule(child);
		}
	}
}

/** A rule of a stylesheet: the base every rule type shares. */
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

/** Tell the sheet -- and so the cascade -- that a rule changed. */
function notifyRule(rule: CSSRule): void {
	sheetChanged(rule.parentStyleSheet);
}

const kRuleList = Symbol("ruleList");
const kRules = Symbol("rules");

/** A rule with a rule list of its own: `@media`, `@supports`, `@layer`. */
export abstract class CSSGroupingRule extends CSSRule {
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

const kSelectors = Symbol("selectors");
const kStyle = Symbol("style");
const kSelectorText = Symbol("selectorText");

/**
 * Load a block from declarations the sheet parser already holds, sparing the
 * serialize-and-reparse a cssText assignment would run. The filters are the
 * cssText setter's: a name the block may not hold is skipped, and each entry
 * cascades against the ones before it.
 */
function assignDeclarations(
	block: CSSStyleDeclaration,
	declarations: readonly CSSDeclaration[],
): void {
	for (const declaration of declarations) {
		if (!supports(block, declaration.name)) {
			continue;
		}
		const {name, value, important} = declaration;
		apply(block, name, value, important, true);
	}
	flush(block);
}

/** A style rule: a selector and the declaration block it applies. */
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

	/**
	 * Serialized on first read rather than at construction: whether `*|E` keeps
	 * its prefix depends on the sheet declaring a default namespace, and the
	 * sheet's `@namespace` rules are only in place once parsing finishes.
	 */
	get selectorText(): string {
		return (this[kSelectorText] ??= serializeSelectorList(
			this[kSelectors],
			sheetNamespaces(this.parentStyleSheet),
		));
	}

	/** A selector that does not parse leaves the rule as it was. */
	set selectorText(selector: string) {
		const selectors = parseSelectorList(selector);
		if (!selectors) {
			return;
		}
		this[kSelectors] = selectors;
		this[kSelectorText] = null;
		notifyRule(this);
	}

	/** The parsed selector, which the cascade matches against. */
	get selectors(): SelectorNode {
		return this[kSelectors];
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

/**
 * A selector's namespace constraint, and the selector with the prefixes that
 * state it taken off.
 *
 * CSS Namespaces 2: a compound selector with no type selector is qualified by
 * the default namespace all the same, so with an HTML default namespace
 * declared `.style1` selects no SVG element -- `.style1` means `*|*.style1`
 * only where no default namespace was declared. The DOM's own matcher knows
 * nothing of a sheet's namespace map, so the constraint is answered here and
 * the prefixes come off the text handed to that matcher.
 *
 * `namespace` is the URI the subject must be in, null for no namespace at all,
 * and undefined when any will do. It constrains the SUBJECT of the selector;
 * an ancestor written with a prefix is matched on its local name alone.
 */
function selectorNamespace(
	selector: string,
	namespaces: SelectorNamespaces,
): {selector: string; namespace?: string | null; valid: boolean} {
	const list = parseSelectorList(selector);
	if (!list) {
		return {selector, valid: true};
	}
	let subject: string | null | undefined;
	let subjectStated = false;
	let sawPrefix = false;
	let valid = true;
	for (const one of childrenOf(list)) {
		const parts = childrenOf(one);
		let start = 0;
		for (const [index, part] of parts.entries()) {
			if (part.type === "Combinator") {
				start = index + 1;
			}
		}
		for (const [index, part] of parts.entries()) {
			if (part.type !== "TypeSelector") {
				continue;
			}
			const name = part.name as string;
			const bar = name.lastIndexOf("|");
			if (bar === -1) {
				continue;
			}
			sawPrefix = true;
			part.name = name.slice(bar + 1);
			const prefix = name.slice(0, bar);
			let uri: string | null | undefined;
			if (prefix === "") {
				uri = null;
			} else if (prefix !== "*") {
				uri = namespaces.prefixes.get(CSSTree.ident.decode(prefix));
				// A prefix no @namespace declared makes the selector invalid,
				// and an invalid selector matches nothing.
				if (uri === undefined) {
					valid = false;
				}
			}
			if (index >= start) {
				subject = uri;
				subjectStated = true;
			}
		}
	}
	if (!subjectStated) {
		subject = namespaces.default ?? undefined;
	}
	return {
		selector: sawPrefix ? serializeSelectorList(list) : selector,
		namespace: subject,
		valid,
	};
}

/** The namespaces a sheet's `@namespace` rules declare. */
function sheetNamespaces(sheet: CSSStyleSheet | null): SelectorNamespaces {
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

/**
 * The declaration blocks at-rules hold: one class per at-rule that declares
 * descriptors, each reflecting its own descriptors as IDL attributes and
 * naming itself as the interface it is. A descriptor is not a property -- it
 * is named only inside its own at-rule -- so `src` reaches
 * `CSSFontFaceDescriptors` and nothing else.
 */
const DESCRIPTOR_BLOCKS = new Map<string, typeof CSSStyleDeclaration>();

/** The descriptor names each at-rule's block may hold, and no others. */
const DESCRIPTOR_NAMES = new Map<string, ReadonlySet<string>>();
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

/** A rule whose body is a declaration block rather than a rule list. */
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
			// the property index does not gate what it may hold.
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
		return declarations ?
			`${this.prelude} { ${declarations} }` :
			`${this.prelude} { }`;
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
 * A page selector -- an optional page name followed by page pseudo-classes,
 * with no whitespace between them -- or "" when it names no valid page.
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
 * its kin. The name is the prelude, the block is the declaration's.
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

/**
 * The properties a keyframe cannot declare: an animation's own, which describe
 * the animation rather than a step of it.
 */
const KEYFRAME_EXCLUDED = /^animation(?:-|$)/;

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

/** A keyframe's selector, as percentages: `from` is 0%, `to` is 100%. */
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
	// css-tree lets a selector list trail off after its last selector, and a
	// keyframe selector list may not: the nodes have to span the text.
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
		const word = key.type === "TypeSelector" ?
				(key.name ?? "").toLowerCase() :
			"";
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

	/** A condition is read: the media list behind it is what an author sets. */
	get conditionText(): string {
		return this[kMedia].mediaText;
	}

	get cssText(): string {
		return `@media ${this.conditionText} {${serializeGroupRules(this)}\n}`;
	}
}

const kConditionText = Symbol("conditionText");

/** A grouping rule whose condition is a text this engine keeps as authored. */
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

const kContainerName = Symbol("containerName");
const kContainerQuery = Symbol("containerQuery");

/** A node a `@container` prelude parse yields at its top level. */
interface ContainerPreludeNode {
	type: string;
	name?: string;
	loc?: ParsedSpan | null;
}

/**
 * The container a `@container` prelude names and the query it asks, split at
 * the Identifier node css-tree parses the name into. The name keeps its
 * authored spelling, escapes and all, and the query is the condition text
 * standing after it. `none`, `and`, `or` and `not` name no container, so a
 * prelude opening with one of those words is query alone, as is a prelude
 * off the grammar.
 */
function containerParts(prelude: string): {name: string; query: string} {
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
		// The prelude does not change under this rule, so its parts are read
		// once here.
		const parts = containerParts(this.conditionText);
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

const kPrelude = Symbol("prelude");
const kScopeStart = Symbol("scopeStart");
const kScopeEnd = Symbol("scopeEnd");

/** The node an `@scope` prelude parses into, and the selector lists it holds. */
interface ScopePreludeNode {
	type: string;
	loc?: ParsedSpan | null;
	root?: ScopePreludeNode | null;
	limit?: ScopePreludeNode | null;
}

/**
 * The selectors an `@scope` prelude bounds its rules with, sliced at the
 * root and limit nodes css-tree parses it into. Both are null for a prelude
 * off the grammar, and the limit alone for the implicit `@scope to (...)`.
 */
function scopeLimits(prelude: string): {
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
		node?.loc ?
				prelude.slice(node.loc.start.offset, node.loc.end.offset) :
			null;
	return {start: sliceOf(scope?.root), end: sliceOf(scope?.limit)};
}

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
		// The prelude does not change under this rule, so its parts are read
		// once here.
		const limits = scopeLimits(this[kPrelude]);
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

/** `@starting-style`: parsed, with no transitions behind it. */
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

/**
 * `@import`: parsed into an object with its href, layer, supports condition
 * and media, whose styleSheet is null. There is no network behind a terminal
 * document, so nothing is fetched and the rule declares nothing.
 */
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
		for (const child of nodesOf(node.block ?? {})) {
			if (child.type !== "Atrule" || !child.name) {
				continue;
			}
			const block = new CSSStyleDeclaration({
				parentRule: this,
				onChange: () => notifyRule(this),
				descriptors: "@font-feature-values",
			});
			assignDeclarations(block, blockDeclarations(child, source));
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

	/** One feature block's values, or an empty block when it was not written. */
	[kBlock](name: string): CSSStyleDeclaration {
		let block = this[kBlocks].get(name);
		if (!block) {
			block = new CSSStyleDeclaration({
				parentRule: this,
				onChange: () => notifyRule(this),
				descriptors: "@font-feature-values",
			});
			this[kBlocks].set(name, block);
		}
		return block;
	}

	get annotation(): CSSStyleDeclaration {
		return this[kBlock]("annotation");
	}

	get ornaments(): CSSStyleDeclaration {
		return this[kBlock]("ornaments");
	}

	get stylistic(): CSSStyleDeclaration {
		return this[kBlock]("stylistic");
	}

	get swash(): CSSStyleDeclaration {
		return this[kBlock]("swash");
	}

	get characterVariant(): CSSStyleDeclaration {
		return this[kBlock]("character-variant");
	}

	get styleset(): CSSStyleDeclaration {
		return this[kBlock]("styleset");
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

	get cssText(): string {
		const frames = this[kRules].map((rule) => `\n  ${rule.cssText}`).join("");
		// An animation's name is a <custom-ident> or a <string>; the words a
		// <custom-ident> excludes -- the CSS-wide keywords and `none`, which
		// animation-name spends on "no animation" -- are written as the
		// strings they are.
		const reserved = this[kName].toLowerCase();
		const name =
			CSS_WIDE_KEYWORDS.has(reserved) || reserved === "none" ?
					serializeCSSString(this[kName]) :
					serializeCSSIdentifier(this[kName]);
		return `@keyframes ${name} {${frames}\n}`;
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

/**
 * A stylesheet: the rules of a `<style>` element, or a constructed sheet a
 * document adopts.
 *
 * The rules are this object's own -- the cascade reads them rather than
 * re-parsing text -- so insertRule, deleteRule, replaceSync and a write to any
 * rule's declaration block all reach the render through the same invalidation
 * a `<style>` text change does.
 */
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
	/** The owner node's text this sheet last parsed. */
	declare [kText]: string | null;

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
		this[kRules] = [];
		this[kOwnerNode] = null;
		this[kOwnerRule] = null;
		this[kDisabled] = false;
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
			() => changed(this),
		);
		this[kRuleList] = createRuleList(this[kRules]);
	}

	/** Reparse the owner element's text when it says something new. */
	[kSync](): void {
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

	/**
	 * Forget what the owner element last said, so the next read reparses it.
	 * A <style> element's child list IS its stylesheet: changing it replaces
	 * the sheet's rules even when the text it spells out is the same.
	 */
	reparseOwnerText(): void {
		this[kText] = null;
	}

	get cssRules(): CSSRuleList {
		this[kSync]();
		return this[kRuleList];
	}

	/** The legacy alias every engine still answers to. */
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
		changed(this);
	}

	insertRule(text: string, index = 0): number {
		if (arguments.length === 0) {
			throw typeError("insertRule requires a rule", this);
		}
		this[kSync]();
		if (index > this[kRules].length) {
			throw domException(
				`Cannot insert at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		const inserted = parseRuleText(text, this, null);
		// A sheet an author constructed pulls in no other: `@import` is not a
		// rule it can be given.
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
		changed(this);
		return index;
	}

	deleteRule(index: number): void {
		if (arguments.length === 0) {
			throw typeError("deleteRule requires an index", this);
		}
		this[kSync]();
		if (index >= this[kRules].length) {
			throw domException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		const removed = this[kRules][index];
		// Removing a namespace declaration would change what the selectors
		// already parsed against it mean, so a sheet holding any other rule
		// keeps it.
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
		changed(this);
	}

	/** The legacy IE spellings, defined in terms of the modern pair. */
	addRule(selector = "undefined", block = "", index?: number): number {
		this.insertRule(`${selector} { ${block} }`, index ?? this.cssRules.length);
		return -1;
	}

	removeRule(index = 0): void {
		this[kSync]();
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
		// An adopted sheet cannot pull in another: `@import` is dropped rather
		// than parsed, per the constructable-stylesheet rules.
		this[kRules].length = 0;
		this[kRules].push(
			...parseRules(String(text ?? ""), this, null).filter(
				(rule) => !(rule instanceof CSSImportRule),
			),
		);
		syncIndexed(this[kRuleList]);
		changed(this);
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

function changed(
	sheet: CSSStyleSheet,
): void {
	sheetNotifiers.get(sheet)?.();
}

/**
 * Whether a rule may stand at `index`.
 *
 * `@import` precedes every rule but another `@import`, and `@namespace`
 * every rule but those two -- which is as much a constraint on the rule
 * being inserted as on the ones already there. A `@namespace` additionally
 * needs a sheet that holds nothing else: a namespace declared after a
 * selector has been parsed cannot reach it.
 */
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
	"highlight",
	"part",
	"picker",
	"scroll-button",
	"slotted",
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
	if (!children) {
		return [];
	}
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
	if (prefix === null) {
		return localText;
	}
	// A prefix is written only where it says something an unprefixed name does
	// not: `*|E` says "any namespace", which is what `E` already means with no
	// default namespace declared, and a prefix bound to the default namespace
	// resolves to the same namespace `E` does.
	if (prefix === "*") {
		return namespaces.default === null ? localText : `*|${localText}`;
	}
	if (prefix === "") {
		// `|E` says "no namespace", which is not what a bare `E` says whether or
		// not a default namespace was declared -- so the bar stays. An
		// attribute is the exception: an unprefixed one is already in no
		// namespace, so `[|attr]` and `[attr]` are the same selector.
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

/**
 * The namespaces a selector is read against: the sheet's default namespace, if
 * it declared one, and the prefixes it bound.
 */
interface SelectorNamespaces {
	default: string | null;
	prefixes: Map<string, string>;
}

const NO_NAMESPACES: SelectorNamespaces = {
	default: null,
	prefixes: new Map(),
};

/**
 * A selector's weight, as the three counts selectors-4 §17 keeps: ids,
 * then classes/attributes/pseudo-classes, then types/pseudo-elements.
 */
type Specificity = [number, number, number];

/**
 * The pseudo-classes whose weight is the weight of their most specific
 * argument, their own name counting for nothing.
 */
const ARGUMENT_WEIGHTED_PSEUDO_CLASSES = new Set([
	"has",
	"is",
	"matches",
	"not",
	"-moz-any",
	"-webkit-any",
]);

/**
 * The pseudo-classes that weigh as a class AND take the weight of their most
 * specific argument on top: `:host(.a)` is a pseudo-class testing a compound,
 * and `:nth-child(2n of .a)` an index testing one.
 */
const COMPOUND_WEIGHTED_PSEUDO_CLASSES = new Set([
	"host",
	"host-context",
	"nth-child",
	"nth-last-child",
]);

/** The weight of the heaviest selector in a list; zero for an empty one. */
function listSpecificity(list: SelectorNode): Specificity {
	let most: Specificity = [0, 0, 0];
	for (const selector of childrenOf(list)) {
		const weight = selectorSpecificityOf(selector);
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

/** The weight of one complex selector: every simple selector in it, summed. */
function selectorSpecificityOf(selector: SelectorNode): Specificity {
	const total: Specificity = [0, 0, 0];
	const add = (weight: Specificity): void => {
		total[0] += weight[0];
		total[1] += weight[1];
		total[2] += weight[2];
	};
	const argumentWeight = (node: SelectorNode): Specificity => {
		for (const child of childrenOf(node)) {
			if (child.type === "SelectorList") {
				return listSpecificity(child);
			}
			if (child.type === "Selector") {
				return selectorSpecificityOf(child);
			}
			if (child.type === "Nth" && child.selector) {
				return listSpecificity(child.selector);
			}
		}
		return [0, 0, 0];
	};
	for (const part of childrenOf(selector)) {
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
			// an element, and a compound it takes weighs on top of that.
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

/**
 * The pseudo-classes an attribute can start or stop matching. A selector that
 * tests one of these on an ancestor reaches the ancestor's descendants when the
 * attribute behind it changes, and no attribute NAME in the selector says so.
 */
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

/** The attributes those state pseudo-classes are driven by. */
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

/**
 * The invalidation keys one compound tests: a change to a key a compound
 * names can flip what the compound matches.
 */
interface CompoundKeys {
	classes: string[];
	ids: string[];
	attributes: string[];
	states: boolean;
}

/**
 * One reading of a selector: the weight the cascade sorts rules by, the
 * element type its subject is anchored to, and the keys each of its compounds
 * tests, in source order. The subject is the last compound.
 */
interface SelectorReading {
	specificity: string;
	subjectTag: string | undefined;
	compounds: CompoundKeys[];
}

/**
 * The keys a compound names, the arguments of its pseudo-classes included: a
 * class inside `:not()` or `:is()` is tested on the compound around it, so a
 * change to it reaches whatever that compound reaches.
 */
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
				// An unprefixed attribute is in no namespace, and a prefixed one
				// is keyed by the local name a mutation reports.
				keys.attributes.push(
					CSSTree.ident.decode(name.slice(name.indexOf("|") + 1)).toLowerCase(),
				);
				break;
			}
			case "PseudoClassSelector":
				if (STATE_PSEUDO_CLASSES.has(pseudoName(String(node.name ?? "")))) {
					keys.states = true;
				}
				harvestKeys(childrenOf(node), keys);
				break;
			case "PseudoElementSelector":
			case "SelectorList":
			case "Selector":
				harvestKeys(childrenOf(node), keys);
				break;
			case "Nth":
				if (node.selector) {
					harvestKeys([node.selector], keys);
				}
				break;
		}
	}
}

/**
 * Read a selector once, for everything the cascade asks of its structure.
 *
 * A selector the parser cannot read weighs nothing: the matcher may still
 * accept it -- it reads a wider selector grammar than this parser does -- and
 * a rule whose weight cannot be counted is the one that should lose a tie.
 * Its subject is anchored to no type and it names no keys, so it is indexed
 * where anything can find it.
 */

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
	const weight = listSpecificity(list);
	const specificity = weight
		.map((count) => String(count).padStart(3, "0"))
		.join("-");
	const complex = childrenOf(list).find((child) => child.type === "Selector");
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
	for (const part of complex ? childrenOf(complex) : []) {
		if (part.type === "Combinator") {
			closeCompound();
		} else {
			parts.push(part);
		}
	}
	closeCompound();
	return {specificity, subjectTag: subjectTagOf(complex), compounds};
}

/**
 * The element type a selector's subject is anchored to, lowercased, or
 * undefined when the subject names none -- a universal, a class, an id, an
 * attribute or a bare pseudo-class can be any element, and so can a type in a
 * namespace, which the matcher reads against the namespaces the sheet bound.
 */
function subjectTagOf(complex: SelectorNode | undefined): string | undefined {
	if (!complex) {
		return undefined;
	}
	let type: SelectorNode | undefined;
	for (const part of childrenOf(complex)) {
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
	return serializeCSSIdentifier(CSSTree.ident.decode(name));
}

/**
 * A pseudo's name as it is compared and serialized: the identifier the source
 * escapes spell, ASCII-lowercased. `::\000041fter` and `::AFTER` are both
 * `::after`, and an escape is part of the spelling, not of the name.
 */
function pseudoName(name: string): string {
	return CSSTree.ident.decode(name).toLowerCase();
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
					node.value.type === "String" ?
							(node.value.value ?? "") :
							(node.value.name ?? "");
				out += `${node.matcher}${serializeCSSString(value)}`;
				if (node.flags) {
					out += ` ${node.flags.toLowerCase()}`;
				}
			}
			return `${out}]`;
		}
		case "PseudoClassSelector":
		case "PseudoElementSelector": {
			// A CSS 2 pseudo-element may be written with one colon; it
			// serializes with two, which is the spelling every one of them has.
			const decoded = pseudoName(node.name as string);
			const element =
				node.type === "PseudoElementSelector" ||
				LEGACY_PSEUDO_ELEMENTS.has(decoded);
			const colons = element ? "::" : ":";
			const name = serializeCSSIdentifier(decoded);
			const args = childrenOf(node);
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
			const nth = node.nth ?
					serializeSelectorArgument(node.nth, namespaces) :
				"";
			const of = node.selector ?
				` of ${serializeSelectorList(node.selector, namespaces)}` :
				"";
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
			// An argument that is one identifier -- `::highlight(name)`,
			// `:lang(ja)` -- serializes as the identifier its escapes spell.
			// Anything else the parser handed over whole stays as written.
			return /^-?(?:[-\w-￿]|\\[^\n])+$/.test(text) && !/^-?\d/.test(text) ?
					serializeIdentifierSource(text) :
				text;
		}
		default:
			return "";
	}
}

/** `An+B` in the one spelling CSSOM writes: `2n`, `2n+1`, `-n+5`, `10`. */
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
	if (!text.startsWith(":")) {
		return "";
	}
	const double = text.startsWith("::");
	let name = text.slice(double ? 2 : 1);
	// CSS tokenization closes a function left open at the end of the input, so
	// `::highlight( name ` names the same pseudo-element `::highlight(name)`
	// does. Anything after the name that is not inside a function is a
	// trailing token, and a trailing token is not part of the selector.
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
			// list of them names no one pseudo-element.
			return null;
		}
	}
	if (open > 0) {
		name += ")".repeat(open);
	} else if (name !== name.trimEnd()) {
		return null;
	}
	// One colon is the CSS 2 spelling, which only the four CSS 2
	// pseudo-elements answer to.
	if (!double && !LEGACY_PSEUDO_ELEMENTS.has(pseudoName(name))) {
		return null;
	}
	const selectors = parseSelectorList(`*::${name}`);
	if (!selectors) {
		return null;
	}
	// One pseudo-element, not a list of them.
	const list = childrenOf(selectors);
	if (list.length !== 1) {
		return null;
	}
	const compound = childrenOf(list[0] ?? {type: ""});
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
 * A selector list's selectors: split on the commas that separate them, which
 * are the ones no bracket, paren or string encloses.
 */
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

/**
 * Parse a selector list, or null when it does not parse -- which includes a
 * pseudo this engine does not know, since an unknown pseudo makes the whole
 * selector invalid.
 */
function parseSelectorList(text: string): SelectorNode | null {
	let list: SelectorNode;
	// A selector list has to select something: the empty string is not one.
	if (!String(text).trim()) {
		return null;
	}
	try {
		list = CSSTree.parse(String(text), {
			context: "selectorList",
			onParseError(error: Error) {
				throw error;
			},
		}) as unknown as SelectorNode;
	} catch (_err) {
		return null;
	}
	if (list.type !== "SelectorList") {
		return null;
	}
	let valid = true;
	const checkSimple = (node: SelectorNode): void => {
		if (!valid) {
			return;
		}
		switch (node.type) {
			case "PseudoClassSelector": {
				const name = pseudoName(node.name as string);
				// `:before` and friends are the CSS 2 spelling of a pseudo-element.
				if (!PSEUDO_CLASSES.has(name) && !LEGACY_PSEUDO_ELEMENTS.has(name)) {
					valid = false;
					return;
				}
				break;
			}
			case "PseudoElementSelector": {
				const name = pseudoName(node.name as string);
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
			if (child.type === "SelectorList") {
				checkList(child);
			} else if (child.type === "Selector") {
				checkSelector(child);
			} else if (child.type === "Nth" && child.selector) {
				checkList(child.selector);
			}
		}
	};
	const checkSelector = (selector: SelectorNode): void => {
		const parts = childrenOf(selector);
		if (parts.length === 0) {
			valid = false;
			return;
		}
		for (const part of parts) {
			checkSimple(part);
		}
	};
	const checkList = (node: SelectorNode): void => {
		for (const selector of childrenOf(node)) {
			checkSelector(selector);
		}
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
	if (!FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) {
		return args.length === 0;
	}
	if (args.length === 0) {
		return false;
	}
	if (name === "slotted") {
		return args.every((argument) => argument.type === "Selector");
	}
	const text = args
		.map((argument) =>
			argument.type === "Raw" ?
					String((argument as {value?: string}).value ?? "") :
				"",
		)
		.join("")
		.trim();
	// The argument is an identifier, so the escapes in it spell the name.
	if (!/^(?:[\w\u0080-\uFFFF-]|\\[^\n])+$/.test(text)) {
		return false;
	}
	const identifier = CSSTree.ident.decode(text);
	// `::picker` names the element whose picker it is, and nothing else does.
	if (name === "picker") {
		return identifier === "select";
	}
	return /^[a-zA-Z_\u0080-\uFFFF-][\w\u0080-\uFFFF-]*$/.test(identifier);
}

// ---- The text parser -------------------------------------------------------

/** The span of source text a parsed node covers. */
interface ParsedSpan {
	start: {offset: number};
	end: {offset: number};
}

/** A parsed rule, as the CSS parser hands it over. */
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

function nodesOf(container: {
	children?: {toArray(): ParsedNode[]} | null;
}): ParsedNode[] {
	return container.children ? container.children.toArray() : [];
}

/**
 * The declarations of a rule's block, in source order. The value nodes the
 * sheet parse built are kept where the canonical spelling is the authored
 * one, so reading such a value later costs no second parse; the value TEXT
 * is always serialized from the authored source, which the parsed spelling
 * cannot stand in for.
 */
function blockDeclarations(node: ParsedNode, source: string): CSSDeclaration[] {
	const declarations: CSSDeclaration[] = [];
	if (!node.block) {
		return declarations;
	}
	for (const child of nodesOf(node.block)) {
		if (child.type !== "Declaration" || !child.value) {
			continue;
		}
		const name = parsePropertyName(child.property ?? "");
		const raw =
			child.value.type === "Raw" ?
					(child.value.value ?? "") :
				child.value.loc ?
						source.slice(
							child.value.loc.start.offset,
							child.value.loc.end.offset,
						) :
						CSSTree.generate(child.value as never);
		const value = serializeCSSValue(raw, name);
		if (!value) {
			continue;
		}
		if (child.value.type === "Value" && value === raw.trim()) {
			seedValueNodes(value, nodesOf(child.value as never) as CSSNode[]);
		}
		declarations.push({
			name,
			value,
			important: child.important === true,
		});
	}
	return declarations;
}

/** Parse a rule list, as a sheet's text or a grouping rule's body. */
function parseRules(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule[] {
	let ast: {children: {toArray(): ParsedNode[]}};
	try {
		// Values parse to nodes on this one pass; a value off its grammar
		// falls back to a Raw node rather than an error, so what the sheet
		// keeps for it is what a raw-text parse kept. Positions are on
		// because the value TEXT serializes from the authored source, not
		// from the parsed spelling.
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

/** One rule's text, as insertRule takes it. */
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
		sheetNamespaces(sheet),
	);
	if (!rule) {
		throw domException(`Cannot parse rule: ${source}`, "SyntaxError", sheet);
	}
	return rule;
}

/**
 * A sheet's rules, in source order.
 *
 * The namespaces a selector resolves against are the ones declared BEFORE it:
 * a sheet is read top to bottom, and an @namespace reaches only the rules that
 * follow it. The map is therefore built as the walk goes rather than read back
 * off a sheet that is still being built.
 */
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

/** An at-rule's prelude, as written. */
function preludeText(node: ParsedNode): string {
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
		const prelude = preludeText(node);
		const selectors = parseSelectorList(prelude);
		if (!selectors) {
			return null;
		}
		// A prefix no @namespace declared names no namespace, and a selector
		// naming one does not parse.
		if (
			prelude.includes("|") &&
			!selectorNamespace(prelude, namespaces).valid
		) {
			return null;
		}
		return new CSSStyleRule(
			selectors,
			blockDeclarations(node, source),
			sheet,
			parentRule,
			(rule) =>
				convertRules(nestedRules(node), source, sheet, rule, namespaces),
		);
	}
	if (node.type !== "Atrule") {
		return null;
	}
	const prelude = preludeText(node);
	switch ((node.name ?? "").toLowerCase()) {
		// A charset rule is not exposed in a sheet's rule list, per CSSOM.
		case "charset":
			return null;
		case "container":
			return new CSSContainerRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					nodesOf(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "counter-style":
			return new CSSCounterStyleRule(
				prelude,
				blockDeclarations(node, source),
				sheet,
			);
		case "font-face":
			return new CSSFontFaceRule(
				blockDeclarations(node, source),
				sheet,
				parentRule,
			);
		case "font-feature-values":
			return new CSSFontFeatureValuesRule(prelude, node, source, sheet);
		case "font-palette-values":
			return new CSSFontPaletteValuesRule(
				prelude,
				blockDeclarations(node, source),
				sheet,
			);
		case "import":
			return convertImportRule(prelude, sheet);
		case "keyframes":
		case "-webkit-keyframes":
			return new CSSKeyframesRule(prelude, sheet, (rule) =>
				nodesOf(node.block ?? {})
					.filter((frame) => frame.type === "Rule")
					.map(
						(frame) =>
							new CSSKeyframeRule(
								preludeText(frame),
								blockDeclarations(frame, source),
								sheet,
								rule,
							),
					),
			);
		case "layer": {
			const names = layerNames(prelude);
			if (!names) {
				return null;
			}
			if (!node.block) {
				// `@layer;` orders nothing, and names nothing to order.
				return names.length === 0 ?
					null :
						new CSSLayerStatementRule(names, sheet, parentRule);
			}
			// A block opens one layer: a list of names belongs to the
			// statement form alone.
			if (names.length > 1) {
				return null;
			}
			return new CSSLayerBlockRule(
				names[0] ?? "",
				sheet,
				parentRule,
				(group) =>
					convertRules(
						nodesOf(node.block ?? {}),
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
					nodesOf(node.block ?? {}),
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
				blockDeclarations(node, source),
				sheet,
				parentRule,
			);
		case "property":
			return new CSSPropertyRule(
				prelude,
				blockDeclarations(node, source),
				sheet,
			);
		case "scope":
			return new CSSScopeRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					nodesOf(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "starting-style":
			return new CSSStartingStyleRule(sheet, parentRule, (group) =>
				convertRules(
					nodesOf(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "supports":
			return new CSSSupportsRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					nodesOf(node.block ?? {}),
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

/** The style rules nested inside a style rule's own block. */
function nestedRules(node: ParsedNode): ParsedNode[] {
	return nodesOf(node.block ?? {}).filter(
		(child) => child.type === "Rule" || child.type === "Atrule",
	);
}

/** A node a `@namespace` prelude parse yields at its top level. */
interface NamespacePreludeNode {
	type: string;
	name?: string;
	value?: string;
}

/**
 * `@namespace [prefix] <url>`, read off css-tree's prelude nodes: an
 * optional Identifier naming the prefix, then the Url or String carrying the
 * namespace URI, unescaped. A prefix keeps its authored spelling, which is
 * the spelling it serializes back as and the spelling a selector's prefix is
 * decoded against.
 *
 * Null for a prelude off the grammar, which is an at-rule a sheet drops.
 */
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

/** A node an `@layer` prelude parse yields. */
interface LayerPreludeNode {
	type: string;
	name?: string;
	children?: {toArray(): LayerPreludeNode[]} | null;
}

/**
 * The layer names an `@layer` prelude lists, read off its Layer nodes: the
 * empty list for the anonymous block, and null for a prelude off the
 * grammar, which is an at-rule a sheet drops. A name keeps its authored
 * spelling, escapes and all, which is the spelling it serializes back as.
 */
function layerNames(prelude: string): string[] | null {
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

/** A node an @import prelude parse yields at its top level. */
interface ImportPreludeNode {
	type: string;
	name?: string;
	value?: string;
	loc?: ParsedSpan | null;
	children?: {toArray(): ImportPreludeNode[]} | null;
}

/**
 * `@import <url> [layer] [supports()] [media]`, read off css-tree's prelude
 * nodes: the url or string node carries the href it spells, unescaped; a
 * `layer()` carries the layer it names; and the supports condition and the
 * media list keep their authored text, sliced at their nodes' positions.
 *
 * Null for a prelude off the grammar, which is an at-rule a sheet drops and
 * insertRule refuses.
 */
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
			// `layer()` takes a layer name and nothing else, so a name off
			// the grammar takes the prelude with it. The anonymous layer is
			// what the bare word `layer` asks for.
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
		// condition between them. A function whose parenthesis never closes
		// is recovered ending at the text, with no `)` to leave off.
		const spelled = sliceOf(node);
		const opened = (node.name ?? "").length + 1;
		supportsText = (
			spelled.endsWith(")") ?
					spelled.slice(opened, -1) :
					spelled.slice(opened)
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
	if (!descriptor?.get) {
		continue;
	}
	Object.defineProperty(type.prototype, "cssText", {
		...descriptor,
		set() {},
	});
}

/** The one sheet a `<style>` (or `<link>`) element owns. */
const elementSheets = new WeakMap<Element, CSSStyleSheet>();

/** The sheets a document or shadow root has adopted. */
const adoptedSheets = new WeakMap<Node, CSSStyleSheet[]>();

/** Marks a prototype whose CSSOM accessors are already the engine's. */

function sheetFor(element: Element): CSSStyleSheet {
	let sheet = elementSheets.get(element);
	if (!sheet) {
		sheet = new CSSStyleSheet({}, element);
		sheetNotifiers.set(sheet, () => {
			const window = element.ownerDocument?.defaultView;
			const manager = window ? styleManagers.get(window) : undefined;
			if (!manager) {
				return;
			}
			// A shadow sheet's change refreshes its root; only a document
			// sheet's change rebuilds the document cascade.
			const root = element.getRootNode();
			if (root.nodeType === 11 && (root as ShadowRoot).host) {
				manager.refreshShadowRoot(root as ShadowRoot);
			} else {
				manager.refreshStylesheets();
			}
		});
		elementSheets.set(element, sheet);
	}
	return sheet;
}

/**
 * The `<style>` elements a document holds, as a bare length to poll.
 *
 * The document counts them as they join and leave its trees, so a length read
 * answers "has a sheet appeared" without walking for one -- cheap enough to
 * ask on every computed-style read.
 */
function documentStyleSheetList(document: Document): {length: number} {
	const counted = document as unknown as DOMDocument;
	return {
		get length(): number {
			return styleElementCount(counted);
		},
	};
}

/**
 * The sheets a tree's own elements declare, which is what `styleSheets`
 * lists. An adopted sheet belongs to no element and is not one of them.
 */
function declaredStyleSheets(root: Document | ShadowRoot): CSSStyleSheet[] {
	return Array.from(root.querySelectorAll("style"), sheetFor);
}

/**
 * A document's stylesheets: one per `<style>` element in tree order, followed
 * by what the document adopted. A `<link>` never resolves to a sheet -- there
 * is no network behind a terminal document.
 */
function documentStyleSheets(document: Document): CSSStyleSheet[] {
	return [
		...declaredStyleSheets(document),
		...(adoptedSheets.get(document) ?? []),
	];
}

/** A shadow root's stylesheets: its own `<style>` elements, then what it adopted. */
function shadowStyleSheets(root: ShadowRoot): CSSStyleSheet[] {
	return [...declaredStyleSheets(root), ...(adoptedSheets.get(root) ?? [])];
}

/** The cascade a tree's sheets belong to. */
function managerForTree(tree: Node): StyleManager | undefined {
	const document =
		tree.nodeType === tree.DOCUMENT_NODE ?
				(tree as Document) :
			tree.ownerDocument;
	return document ? documentManagers.get(document) : undefined;
}

/** A sheet a tree may adopt: one an author constructed, and nothing else. */
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
	sheetNotifiers.set(sheet, () => managerForTree(tree)?.refreshStylesheets());
	return sheet;
}

/**
 * Adopt a list of constructed sheets, and wire each one's later mutations to
 * the cascade -- a constructed sheet has no consumer until something adopts it.
 */
function adopt(target: Node, sheets: unknown): void {
	const adopted = Array.from(sheets as Iterable<unknown>).map((sheet) =>
		checkAdoptable(target, sheet),
	);
	// One array per tree, replaced in place: the observable array an author
	// already holds is the same object after a whole reassignment.
	let list = adoptedSheets.get(target);
	if (!list) {
		adoptedSheets.set(target, (list = []));
	}
	list.length = 0;
	for (const [index, sheet] of adopted.entries()) {
		defineIndex(list, index, sheet);
	}
}

/**
 * Write one index of a backing list.
 *
 * An ObservableArray's backing list is not a JavaScript object: it has no
 * prototype behind it, and an index write to it consults nothing. A plain
 * assignment to an array does consult the prototype chain, so an accessor
 * installed at `Array.prototype[1]` would run with the backing list as its
 * receiver -- handing an author the list itself and swallowing the write.
 * Defining the property is the write with no chain behind it.
 */
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

/** The observable array behind one tree's `adoptedStyleSheets`. */
const adoptedProxies = new WeakMap<Node, CSSStyleSheet[]>();

/**
 * `adoptedStyleSheets` as an ObservableArray: the list an author holds is the
 * list the cascade reads, so `push`, `splice` and an indexed write all take
 * effect where a whole reassignment would -- and each is checked as one.
 */
function observableAdopted(
	target: Node,
	list: CSSStyleSheet[],
): CSSStyleSheet[] {
	let proxy = adoptedProxies.get(target);
	if (proxy) {
		return proxy;
	}
	const changed = (): void => {
		managerForTree(target)?.refreshStylesheets();
	};
	// Assignment to arbitrary indices of adoptedStyleSheets must be observed.
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
			// No notification: an array method that deletes an index (`pop`,
			// `shift`) writes the new length straight after, and the cascade
			// must not read the list between the two.
			return Reflect.deleteProperty(array, property);
		},
	});
	adoptedProxies.set(target, proxy);
	return proxy;
}

/**
 * Every CSSOM interface names itself: `Object.prototype.toString` on one of
 * its objects gives the interface name, as it does for any platform object.
 */
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

/** The UA document sheet, parsed once: its rules never change. */
let uaDocumentSheet: CSSStyleSheet | null = null;

function uaStyleSheet(): CSSStyleSheet {
	if (!uaDocumentSheet) {
		uaDocumentSheet = new CSSStyleSheet();
		uaDocumentSheet.replaceSync(UA_ELEMENT_STYLES + UA_DOCUMENT_STYLES);
	}
	return uaDocumentSheet;
}

/**
 * The properties whose resolved value is the used value, per CSSOM: the box's
 * own dimensions, its edges, and the offsets that place it. Everything else
 * resolves to its computed value.
 */
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

/** A used length in the one unit a terminal has: a cell, spelled `px`. */
function usedLength(cells: number): string {
	return `${Math.round(cells * 1000) / 1000}px`;
}

/**
 * The reads a used-value measurement takes, from whichever declaration owns
 * the box. An element's computed declaration is one directly; a
 * pseudo-element's declaration answers through a view whose [kElement] is the
 * pseudo-element's own node, which is where its box lives -- the measurement
 * arithmetic is the same either way, so there is one copy of it.
 */
interface MeasuredDeclaration {
	[kElement]: Element;
	[kManager]: StyleManager | null;
	computedValueOf(property: string): string;
	getPropertyValue(property: string): string;
}

/**
 * The colors whose `auto` names the element's own color: a caret is drawn in
 * the text's color, and an outline whose color was left to the UA takes it
 * too. The resolved value CSSOM reports is that used color.
 */
const AUTO_COLOR_PROPERTIES = new Set(["caret-color", "outline-color"]);

/** The two sizes whose `auto` names a minimum only some boxes have. */
const MIN_SIZE_PROPERTIES = new Set(["min-width", "min-height"]);

/**
 * The two track lists whose resolved value is the USED track sizes: what the
 * grid came to, one length per track of the implicit grid, rather than the
 * sizing functions the author wrote (css-grid-2 §7.2).
 */
const USED_TRACK_PROPERTIES = new Set([
	"grid-template-columns",
	"grid-template-rows",
]);

/** The containers whose children have an automatic minimum size. */
const PSEUDO_ELEMENT_NAMES = ["::before", "::after", "::marker"];

const ITEM_DISPLAYS = new Set(["flex", "grid", "inline-flex", "inline-grid"]);

/** The block-level display an inline-level box takes as a flex or grid item. */
const BLOCKIFIED_DISPLAYS: Record<string, string> = {
	"inline": "block",
	"inline-block": "block",
	"inline-flex": "flex",
	"inline-grid": "grid",
	"inline-table": "table",
};

function blockified(display: string): string {
	return BLOCKIFIED_DISPLAYS[display] ?? display;
}

/** The four properties that place a positioned box against its containing block. */
const INSET_PROPERTIES = new Set(["top", "right", "bottom", "left"]);

const OPPOSITE_INSET: Record<string, string> = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left",
};

/**
 * A computed inset as a length in cells, with percentages -- and the one
 * percentage a calc() can still carry -- resolved against the containing
 * block. Null for `auto`, which is not a length but an instruction to
 * measure.
 */
function insetLength(computed: string, basis: number): number | null {
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
 * A computed style as the engine reads it: `computedValueOf` alone, answering
 * the cascade's value with no resolved-value branch and no author-facing
 * bookkeeping. Computed-only by construction, not by flag.
 */
export interface ComputedStyle {
	computedValueOf(property: string): string;
}

/**
 * An element's computed style, for the engine itself.
 *
 * Straight to the declaration the cascade caches: no `getComputedStyle` call,
 * no pseudo-element parsing, no flat-tree walk, no used-value branch. This is
 * the read layout and paint make thousands of times a frame.
 */
export function computedStyleOf(element: Element): ComputedStyle {
	// A pseudo-element node's style is its host's declaration for the
	// pseudo-element it fills; it matches no selector of its own.
	const host = pseudoHostOf<Element>(element);
	if (host !== null) {
		const name = pseudoNameOf(element) as string;
		const manager = host.ownerDocument ?
				documentManagers.get(host.ownerDocument) :
			undefined;
		return manager ?
				manager.pseudoNodeStyleFor(element, host, name) :
				pseudoStyleOf(host, name);
	}
	const document = element.ownerDocument;
	if (!document) {
		return EMPTY_COMPUTED_STYLE;
	}
	const manager = documentManagers.get(document);
	if (manager) {
		return manager.declarationFor(element);
	}
	// A document with no cascade of this engine's behind it -- a bare
	// document -- still answers, through whatever getComputedStyle its
	// window has; a window an engine never dressed has none, and answers
	// with initial values like a window-less document.
	const window = document.defaultView;
	return window && typeof window.getComputedStyle === "function" ?
			foreignComputedStyle(window.getComputedStyle(element)) :
		EMPTY_COMPUTED_STYLE;
}

function foreignComputedStyle(
	declaration: globalThis.CSSStyleDeclaration,
): ComputedStyle {
	return {
		computedValueOf: (property: string): string =>
			declaration.getPropertyValue(property),
	};
}

/** A pseudo-element's computed style, on the same internal read path. */
export function pseudoStyleOf(
	element: Element,
	pseudoElement: string,
): ComputedStyle {
	const document = element.ownerDocument;
	if (!document) {
		return EMPTY_COMPUTED_STYLE;
	}
	const manager = documentManagers.get(document);
	if (manager) {
		return manager.pseudoDeclarationFor(element, pseudoElement);
	}
	const window = document.defaultView;
	return window ?
			foreignComputedStyle(window.getComputedStyle(element, pseudoElement)) :
		EMPTY_COMPUTED_STYLE;
}

/**
 * Expose a computed style's indices to an author.
 *
 * The index accessors read through item(), so they answer the live list; the
 * count re-synchronizes on refresh, but only for declarations that have been
 * handed out here -- the engine's own computed styles never materialize an
 * item list.
 */
function indexedDeclaration<T extends CSSStyleDeclaration>(declaration: T): T {
	syncIndexed(declaration);
	return declaration;
}

/** What a read answers before a document has a cascade behind it. */
const EMPTY_COMPUTED_STYLE: ComputedStyle = {
	computedValueOf(): string {
		return "";
	},
};

const kCSSRules = Symbol("cssRules");
const kManager = Symbol("manager");
const kUsedValuesOf = Symbol("usedValuesOf");
const kDropUsedValues = Symbol("dropUsedValues");
const kRefresh = Symbol("refresh");
const kResolved = Symbol("resolved");
const kCustom = Symbol("custom");
const kUsedValue = Symbol("usedValue");
const kBaseValue = Symbol("baseValue");
const kTransitionValue = Symbol("transitionValue");

class ComputedStyleDeclaration extends CSSStyleProperties {
	declare [kElement]: Element;
	declare [kCSSRules]: ParsedCSSRule[];
	/**
	 * The manager to re-ask for matching rules, and the one that says whether
	 * this declaration still stands for the cascade (see resolvedDeclarations).
	 * A computed style is LIVE: the object an author holds keeps answering the
	 * element's current values across class flips, rule insertions and sheet
	 * replacements, so it re-resolves rather than being replaced.
	 */
	declare [kManager]: StyleManager | null;
	// Lazily resolved properties -- INCLUDING ones that resolved to "".
	// Values here are COMPUTED strings, materialized once per property per
	// resolution; an initial-valued property (word-break, visibility, ...)
	// that re-resolved on every read would re-walk the whole ancestor chain
	// for an inherited property, and each ancestor's own read does the same
	// -- thousands of full cascade resolutions per keystroke. The
	// declaration is discarded wholesale on invalidation, so memoizing here
	// needs no invalidation of its own.
	declare [kResolved]: Map<string, string>;

	constructor(
		element: Element,
		cssRules: ParsedCSSRule[] = [],
		manager?: StyleManager,
	) {
		super();
		this[kManager] = null;
		this[kResolved] = new Map<string, string>();
		this[kCustom] = null;
		this[kElement] = element;
		this[kCSSRules] = cssRules;
		if (manager) {
			this[kManager] = manager;
			manager[kCurrentDeclarations].add(this);
		}
	}

	/**
	 * A resolved value that is the used value: measured through the same flush
	 * a geometry read takes, and memoized behind that flush so a
	 * property-heavy caller measures once per layout rather than once per read.
	 * The memo is the manager's, which is what lets a flush drop every one.
	 */
	[kUsedValue](property: string): string {
		const manager = this[kManager]!;
		const used = manager[kUsedValuesOf](this);
		const memoized = used.get(property);
		if (memoized !== undefined) {
			return memoized;
		}

		const computed = this.computedValueOf(property);
		const value = measure(this, property, computed);
		used.set(property, value);
		return value;
	}

	/**
	 * The computed value: what the cascade says, before any box exists. This
	 * is what the engine's own geometry decisions read -- a used value there
	 * would feed layout its own output.
	 */
	computedValueOf(property: string): string {
		const current = this[kManager]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kRefresh]();
		}
		const value = this[kBaseValue](property);
		const manager = this[kManager];
		if (manager !== null && manager[kTransitionCount] > 0) {
			const transitional = transitionValueOf(
				manager,
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

	/**
	 * The cascade's own answer, before any running transition overrides it:
	 * what the transition machinery calls the after-change style. Memoized --
	 * an interpolated value moves per frame and must never enter the memo.
	 */
	[kBaseValue](property: string): string {
		let value = this[kResolved].get(property);
		if (value === undefined) {
			const longhands = SHORTHAND_LONGHANDS.get(property);
			value = longhands ?
					shorthand(this, property, longhands, (longhand) =>
						this[kBaseValue](longhand),
					) : // A flow-relative longhand shares its computed value with the
					// physical longhand it maps to, so it is answered as that one.
					computed(this, physicalOf(this, property));
			this[kResolved].set(property, value);
		}
		return value;
	}

	/**
	 * Re-resolve against the current cascade. Reads ask the manager whether
	 * this declaration is one it still resolves for and call this only when it
	 * is not -- this sits on the hottest path in the engine, under every
	 * property read of every element.
	 */
	[kRefresh](): void {
		if (!this[kManager]) {
			return;
		}
		// Before the work: resolving below reads back through this declaration.
		this[kManager][kCurrentDeclarations].add(this);
		this[kCSSRules] = this[kManager].matchingRules(this[kElement]);
		this[kCustom] = null;
		storeTransitionFallback(
			this[kManager],
			this[kElement],
			"",
			this[kResolved],
		);
		this[kResolved] = new Map();
		this[kManager]?.[kDropUsedValues](this);
		if ((this as IndexedCollection)[kIndexCount] !== undefined) {
			syncIndexed(this);
		}
		// The re-resolution is a style change event: whatever moved against
		// the last snapshot starts, retargets or cancels transitions.
		processTransitionStyle(
			this[kManager],
			this[kElement],
			(property) => this[kBaseValue](property),
			"",
		);
	}

	// Resolution is fully lazy: construction populates nothing, and each
	// property resolves on first read, then answers from the memo. Most
	// elements are only ever asked a handful of properties -- the
	// composition walker asks each element `display` alone.
	override getPropertyValue(property: string): string {
		// The author's read, and the DOM it describes is the DOM as it stands:
		// a style object held across a class flip answers for the flip. The
		// engine reads through computedValueOf, which takes no flush -- style
		// is resolved from inside layout, which this would re-enter.
		this[kManager]?.flushStyle();
		const current = this[kManager]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kRefresh]();
		}
		// A flow-relative longhand resolves as the physical longhand it maps
		// to: same slot, same measurement, same answer.
		property = physicalOf(this, property);
		if (this[kManager] && USED_VALUE_PROPERTIES.has(property)) {
			return this[kUsedValue](property);
		}
		if (this[kManager] && MIN_SIZE_PROPERTIES.has(property)) {
			return resolvedMinSize(this, this.computedValueOf(property));
		}
		if (this[kManager] && USED_TRACK_PROPERTIES.has(property)) {
			const tracks = this[kManager].usedGridTracks(
				this[kElement],
				property === "grid-template-rows",
			);
			if (tracks) {
				return tracks.length > 0 ? tracks.map(usedLength).join(" ") : "none";
			}
		}
		if (AUTO_COLOR_PROPERTIES.has(property)) {
			const computed = this.computedValueOf(property);
			return computed === "auto" ? this.getPropertyValue("color") : computed;
		}
		const longhands = SHORTHAND_LONGHANDS.get(property);
		if (longhands) {
			return shorthand(this, property, longhands, (longhand) =>
				this.getPropertyValue(longhand),
			);
		}
		return this.computedValueOf(property);
	}

	/** Computed styles are read-only; writing one is an error, not a no-op. */
	override setProperty(): void {
		throw readOnlyDeclaration(this[kElement]);
	}

	override removeProperty(): string {
		throw readOnlyDeclaration(this[kElement]);
	}

	override getPropertyPriority(): string {
		return "";
	}

	/**
	 * A computed style declares every supported longhand, so its indices name
	 * them in the property index's order rather than the order reads happened
	 * to resolve them in -- followed by the custom properties in effect on the
	 * element, which are declarations too and have no place in that index.
	 */
	override item(index: number): string {
		return (
			CSS_LONGHANDS[index] ??
			customNames(this)[index - CSS_LONGHANDS.length] ??
			""
		);
	}

	override get length(): number {
		return CSS_LONGHANDS.length + customNames(this).length;
	}

	override [Symbol.iterator](): IterableIterator<string> {
		return [...CSS_LONGHANDS, ...customNames(this)][Symbol.iterator]();
	}

	/** The names of the custom properties declared for this element. */
	declaredCustomProperties(): string[] {
		const names: string[] = [];
		for (const rule of this[kCSSRules]) {
			for (const name of Object.keys(rule.declarations)) {
				if (name.startsWith("--") && !names.includes(name)) {
					names.push(name);
				}
			}
		}
		for (const name of Object.keys(inlineDeclarations(this).declarations)) {
			if (name.startsWith("--") && !names.includes(name)) {
				names.push(name);
			}
		}
		return names;
	}

	declare [kCustom]: string[] | null;

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement]);
	}

	override get parentRule(): CSSRule | null {
		return null;
	}
}

/**
 * One property's computed value: the cascade's declaration, interned, and
 * absolutized against this element when the interned entry says only an
 * element can answer it. The memo both callers write into is the
 * per-element cache one re-resolution's absolutization is paid into once.
 */
function computed(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	const entry = computedEntry(
		property,
		resolvePropertyValue(declaration, property),
	);
	if (!entry.contextual) {
		return entry.value;
	}
	const absolute = absolutizeLengths(
		entry.value,
		lengthContext(declaration, property),
	);
	// Two radii that differ as written -- `1ch 1px` -- can measure the same
	// cell, and a corner whose radii agree states one of them.
	return RADIUS_LONGHANDS.has(property) ? collapseRadius(absolute) : absolute;
}

/**
 * What a relative length on this element is worth.
 *
 * `font-size` measures against the PARENT's font size, so it is the one
 * property whose own computed value is not in its own context; every other
 * property measures against this element's font size, which therefore
 * computes first.
 */
function lengthContext(
	declaration: ComputedStyleDeclaration,
	property: string,
): LengthContext {
	const own = property === "font-size";
	const parent = own ? flatParentElement<Element>(declaration[kElement]) : null;
	const font = own ?
		parent ?
				fontSizeOf(computedStyleOf(parent)) :
			INITIAL_FONT_SIZE :
			fontSizeOf(declaration);
	const root = rootFontSize(declaration, own);
	const viewport = declaration[kManager]?.viewportSize();
	return {
		font,
		root,
		viewportWidth: viewport ? viewport.width : 0,
		viewportHeight: viewport ? viewport.height : 0,
		// A percentage is font-relative on exactly two properties: on
		// `font-size` it is a share of the parent's, on `line-height` of
		// this element's own. Everywhere else it stays a percentage until
		// something uses it.
		percent: FONT_RELATIVE_PERCENTAGES.has(property) ? font / 100 : null,
	};
}

/** The font size `rem` measures against: the root element's. */
function rootFontSize(
	declaration: ComputedStyleDeclaration,
	ownFontSize: boolean,
): number {
	const root = declaration[kElement].ownerDocument?.documentElement;
	// `rem` in the root's own font-size is the initial value, not the
	// value being computed.
	if (!root || (ownFontSize && root === declaration[kElement])) {
		return INITIAL_FONT_SIZE;
	}
	return root === declaration[kElement] ?
			fontSizeOf(declaration) :
			fontSizeOf(computedStyleOf(root));
}

/**
 * The name a longhand computes under: itself, or -- for a flow-relative
 * longhand -- the physical longhand this element's `direction` maps it to.
 */
function physicalOf(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	if (!LOGICAL_TO_PHYSICAL.ltr.has(property)) {
		return property;
	}
	return (
		physicalProperty(property, declaration.computedValueOf("direction")) ??
		property
	);
}

/**
 * A shorthand answers as its longhands, each in the spelling `read` gives
 * it, collapsed: `margin: 10px 10px 10px 10px` is "10px". The reader is the
 * caller's, because the computed and resolved value paths ask their
 * longhands different questions -- and their answers must not meet, which
 * is why only the computed one is memoized.
 */
function shorthand(
	declaration: ComputedStyleDeclaration,
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

function measure(
	declaration: MeasuredDeclaration,
	property: string,
	computed: string,
): string {
	// A border with no style draws nothing and takes no space, whatever
	// width it declares.
	if (property.startsWith("border-") && property.endsWith("-width")) {
		const style = declaration.computedValueOf(
			`${property.slice(0, -"-width".length)}-style`,
		);
		if (!style || style === "none" || style === "hidden") {
			return "0px";
		}
	}
	const inset = INSET_PROPERTIES.has(property);
	// An inset only applies to a positioned box; on a static one it stays
	// as declared.
	const position = inset ? declaration.getPropertyValue("position") : "";
	if (inset && position === "static") {
		return computed;
	}

	const rect = declaration[kManager]!.usedRect(declaration[kElement]);
	// No box -- display:none, or a tree layout never reached -- so the
	// computed value is the answer, exactly as CSSOM says.
	if (!rect) {
		return computed;
	}

	if (inset) {
		return usedInset(declaration, property, computed, rect, position);
	}

	if (property === "width" || property === "height") {
		const vertical = property === "height";
		const edges =
			edge(declaration, vertical ? "border-top-width" : "border-left-width") +
			edge(
				declaration,
				vertical ? "border-bottom-width" : "border-right-width",
			) +
			edge(declaration, vertical ? "padding-top" : "padding-left") +
			edge(declaration, vertical ? "padding-bottom" : "padding-right");
		const border = vertical ? rect.height : rect.width;
		// `box-sizing: border-box` measures the border box itself.
		const content =
			declaration.getPropertyValue("box-sizing") === "border-box" ?
				border :
				border - edges;
		return usedLength(Math.max(0, content));
	}

	// An `auto` margin is whatever space the box was given: the distance
	// between its border box and its containing block's content edge.
	if (computed === "auto" && property.startsWith("margin-")) {
		return usedLength(autoMargin(declaration, property, rect));
	}

	// Every other used length is already absolute in this engine's own
	// unit, so the computed value carries it; only a percentage still has
	// to be resolved, against the containing block's width.
	if (computed.endsWith("%")) {
		const basis = containingWidth(declaration);
		if (basis === null) {
			return computed;
		}
		return usedLength((parseFloat(computed) / 100) * basis);
	}
	return computed || "0px";
}

/**
 * A positioned box's inset, as used.
 *
 * A declared inset resolves where it stands -- a percentage against the
 * containing block, everything else as written -- which is also what CSSOM
 * asks for when the four insets over-constrain the box. `auto` is the one
 * that has to be measured: it is whatever distance the box ended up at.
 */
function usedInset(
	declaration: MeasuredDeclaration,
	property: string,
	computed: string,
	rect: DOMRect,
	position: string,
): string {
	const block = containingBlockBox(declaration, position);
	if (!block) {
		return computed;
	}
	const vertical = property === "top" || property === "bottom";
	const basis = vertical ? block.height : block.width;
	const own = insetLength(computed, basis);
	if (own !== null) {
		return usedLength(own);
	}
	// A sticky box keeps its `auto`: it names an edge that constrains
	// nothing, not a distance.
	if (position === "sticky") {
		return computed;
	}

	const opposite = OPPOSITE_INSET[property];
	const other = insetLength(declaration.computedValueOf(opposite), basis);
	// A relatively positioned box is offset from where it already was, so
	// an `auto` inset is the negative of its opposite -- and zero when both
	// are auto, which moves the box nowhere.
	if (position === "relative") {
		return usedLength(other === null ? 0 : -other);
	}

	// Out of flow: the box hangs in its containing block, so the used
	// inset is the distance from that block's edge to the box's margin
	// edge -- the far side of the box when the opposite inset placed it,
	// and its static position when neither did.
	const start = vertical ? "margin-top" : "margin-left";
	const end = vertical ? "margin-bottom" : "margin-right";
	if (other !== null) {
		const size =
			(vertical ? rect.height : rect.width) +
			edge(declaration, start) +
			edge(declaration, end);
		return usedLength(basis - other - size);
	}
	switch (property) {
		case "top":
			return usedLength(rect.y - edge(declaration, start) - block.y);
		case "left":
			return usedLength(rect.x - edge(declaration, start) - block.x);
		case "bottom":
			return usedLength(
				block.y +
				block.height -
				(rect.y + rect.height + edge(declaration, end)),
			);
		default:
			return usedLength(
				block.x + block.width - (rect.x + rect.width + edge(declaration, end)),
			);
	}
}

/**
 * The box this element's insets are measured against: the padding box of
 * the containing block an out-of-flow box hangs from, the scrollport a
 * sticky box is constrained by, and otherwise the content box of the box
 * this one flows in.
 */
function containingBlockBox(
	declaration: MeasuredDeclaration,
	position: string,
): DOMRect | null {
	if (position === "fixed") {
		return viewportBox(declaration);
	}
	if (position === "absolute") {
		for (
			let ancestor = flatParentElement<Element>(declaration[kElement]);
			ancestor;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			const ancestorPosition =
				computedStyleOf(ancestor).computedValueOf("position");
			if (ancestorPosition && ancestorPosition !== "static") {
				return boxOf(declaration, ancestor, false);
			}
		}
		return viewportBox(declaration);
	}
	if (position === "sticky") {
		for (
			let ancestor = flatParentElement<Element>(declaration[kElement]);
			ancestor;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			const overflow = computedStyleOf(ancestor).computedValueOf("overflow");
			if (overflow && overflow !== "visible") {
				return boxOf(declaration, ancestor, true);
			}
		}
	}
	const parent = flatParentElement<Element>(declaration[kElement]);
	return parent ? boxOf(declaration, parent, true) : viewportBox(declaration);
}

/** An ancestor's padding box, or its content box, in the same coordinates as a rect. */
function boxOf(
	declaration: MeasuredDeclaration,
	element: Element,
	content: boolean,
): DOMRect | null {
	const rect = declaration[kManager]!.usedRect(element);
	if (!rect) {
		return null;
	}
	const style = computedStyleOf(element);
	const edge = (name: string): number =>
		parseFloat(style.computedValueOf(name)) || 0;
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

/** The initial containing block: the grid itself. */
function viewportBox(
	declaration: MeasuredDeclaration,
): DOMRect | null {
	const viewport = declaration[kManager]!.viewportSize();
	if (!viewport) {
		return null;
	}
	const rect = declaration[kManager]!.usedRect(declaration[kElement]);
	if (!rect) {
		return null;
	}
	return new (rect.constructor as typeof DOMRect)(
		0,
		0,
		viewport.width,
		viewport.height,
	);
}

/**
 * `min-width: auto` and `min-height: auto` as resolved.
 *
 * The keyword means "the box's automatic minimum size", which only a flex
 * or grid item, or a box with an aspect ratio, actually has; anywhere else
 * -- and for a box that was never generated -- it is zero, which is the
 * value CSSOM reports.
 */
function resolvedMinSize(
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
		element = flatParentElement<Element>(element)
	) {
		if (computedStyleOf(element).computedValueOf("display") === "none") {
			return "0px";
		}
	}
	if (declaration.computedValueOf("aspect-ratio") !== "auto") {
		return "auto";
	}
	const parent = flatParentElement<Element>(declaration[kElement]);
	const display = parent ?
			computedStyleOf(parent).computedValueOf("display") :
		"";
	return ITEM_DISPLAYS.has(display) ? "auto" : "0px";
}

/** One edge length in cells, for the arithmetic above. */
function edge(
	declaration: MeasuredDeclaration,
	property: string,
): number {
	return parseFloat(declaration.getPropertyValue(property)) || 0;
}

/** The space an `auto` margin actually took, measured off the two boxes. */
function autoMargin(
	declaration: MeasuredDeclaration,
	property: string,
	rect: DOMRect,
): number {
	const parent = flatParentElement<Element>(declaration[kElement]);
	const parentRect = parent ? declaration[kManager]!.usedRect(parent) : null;
	if (!parent || !parentRect) {
		return 0;
	}
	const parentStyle = computedStyleOf(parent);
	const edge = (name: string): number =>
		parseFloat(parentStyle.computedValueOf(name)) || 0;
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

/** The width a percentage on this element resolves against. */
function containingWidth(
	declaration: MeasuredDeclaration,
): number | null {
	const parent = flatParentElement<Element>(declaration[kElement]);
	if (!parent) {
		return null;
	}
	const rect = declaration[kManager]!.usedRect(parent);
	return rect ? rect.width : null;
}

/**
 * The element's inline declarations, expanded to longhands.
 *
 * The store behind `element.style` is this engine's own CSSOM, which keeps
 * a declaration as authored and hands the cascade the expanded block --
 * so a shorthand's `!important` covers every longhand it declares.
 */
function inlineDeclarations(
	declaration: ComputedStyleDeclaration,
): DeclarationBlock {
	const style = (declaration[kElement] as HTMLElement).style;
	return style instanceof CSSStyleDeclaration ?
			style.declarationBlock() :
		EMPTY_DECLARATIONS;
}

/** This element's flat-tree parent's computed value for `property`, or null at the root. */
function resolveFromParent(
	declaration: ComputedStyleDeclaration,
	property: string,
): string | null {
	const parent = flatParentElement<Element>(declaration[kElement]);
	if (!parent) {
		return null;
	}
	return computedStyleOf(parent).computedValueOf(property) || null;
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

		const resolved = resolveCustomProperty(declaration, name);
		if (resolved !== null) {
			out += substituteVar(declaration, resolved, depth + 1);
		} else if (fallback !== undefined) {
			out += substituteVar(declaration, fallback, depth + 1);
		}
		// Neither a value nor a fallback: the guaranteed-invalid value -- omit,
		// which approximates the property's own initial/inherited fallback.

		i = j;
	}
	return out;
}

function resolveCustomProperty(
	declaration: ComputedStyleDeclaration,
	name: string,
): string | null {
	// A custom property is just an ordinary (always-inherited) cascade lookup
	// -- kResolvePropertyValueRaw's step 4 already walks ancestors for it.
	return resolvePropertyValueRaw(declaration, name) || null;
}

/**
 * Resolve property value applying CSS cascade: inline styles > CSS rules >
 * defaults, with `!important` promoted above all of that (an important
 * stylesheet rule beats even a non-important inline style, per spec), and
 * `var()` references substituted in whatever wins.
 */
function resolvePropertyValue(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	const raw = resolvePropertyValueRaw(declaration, property);
	// A custom property holds the tokens it was given; substituting it
	// into a property of its own grammar re-serializes them in that
	// property's spelling.
	const value = raw ?
		property.startsWith("--") ?
				substituteVar(declaration, raw) :
				serializeCSSValue(substituteVar(declaration, raw), property) :
		raw;
	// `currentcolor` is the element's own color, which is what a resolved
	// value says; on `color` itself it means the parent's.
	if (
		value.toLowerCase() === "currentcolor" &&
		COLOR_PROPERTIES.has(property)
	) {
		// The COMPUTED color, on the engine's own read path: this is the
		// cascade resolving a value, and the author path flushes -- which
		// drains mutations and lays the document out, from inside the
		// resolution of a style that layout is waiting on. `color` has no
		// used value to wait for, so the two answer alike.
		return property === "color" ?
				(resolveFromParent(declaration, "color") ?? "") :
				declaration.computedValueOf("color");
	}
	return value;
}

function resolvePropertyValueRaw(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	// A physical property and the flow-relative properties that map to it
	// are ONE cascade slot (css-logical-1 §2.1): every name in the slot
	// computes to the value of the declaration that comes last in the
	// cascade, whichever name that declaration used. Which flow-relative
	// name maps here depends on the element's `direction`, so the slot's
	// names are widened to both inline edges and narrowed by direction
	// only once a block actually declares one of them.
	const logical = PHYSICAL_TO_LOGICAL.get(property);
	const names = logical ? [property, ...logical] : [property];
	let direction: string | null = null;
	const mapsHere = (name: string): boolean =>
		name === property ||
		physicalProperty(
			name,
			(direction ??= declaration.computedValueOf("direction")),
		) === property;

	const inline = inlineDeclarations(declaration);
	const inlineName = declaredName(inline, names, false, mapsHere);
	const inlineValue = inlineName ?
			inline.declarations[inlineName].trim() :
		undefined;
	const inlineUsable = !!inlineValue && !INITIAL_KEYWORDS.has(inlineValue);
	const inlineImportantName = declaredName(inline, names, true, mapsHere);
	const inlineImportantValue = inlineImportantName ?
			inline.declarations[inlineImportantName].trim() :
		undefined;
	const inlineImportant =
		!!inlineImportantValue && !INITIAL_KEYWORDS.has(inlineImportantValue);

	// `inherit` skips the rest of the cascade and goes straight to the parent's
	// resolved value, regardless of whether this property normally inherits.
	if (inlineImportant && inlineImportantValue === "inherit") {
		return resolveFromParent(declaration, property) ?? "";
	}
	if (!inlineImportant && inlineUsable && inlineValue === "inherit") {
		return resolveFromParent(declaration, property) ?? "";
	}

	// 1 & 2. Inline style and stylesheet rules, with an !important tier above
	// the normal cascade. #cssRules is pre-sorted by specificity/source order,
	// so within each tier the last match wins.
	let ruleValue: string | null = null;
	let importantRuleValue: string | null = null;
	// `!important` reverses the layer order (css-cascade-5 §6.4.4): the
	// EARLIEST layer wins, and unlayered declarations -- which win the
	// normal cascade -- lose to every layer. The rules arrive with the
	// earliest layer first, so the first layer to declare the property
	// keeps it, and later ones only tie it within the same layer.
	let importantOrigin = false;
	let importantLayer = 0;
	for (const rule of declaration[kCSSRules]) {
		const name = declaredName(rule, names, false, mapsHere);
		if (name !== null) {
			ruleValue = rule.declarations[name];
		}
		const importantName = declaredName(rule, names, true, mapsHere);
		if (
			importantName !== null &&
			(importantRuleValue === null ||
				Boolean(rule.uaOrigin) !== importantOrigin ||
				rule.layerRank === importantLayer)
		) {
			importantRuleValue = rule.declarations[importantName];
			importantOrigin = Boolean(rule.uaOrigin);
			importantLayer = rule.layerRank;
		}
	}

	// A CSS-wide keyword a rule declares is not a value: `inherit` takes the
	// parent's, and the rest send resolution on to the defaults below, as
	// though the declaration were not there.
	const declaredByRule = (value: string): string | null => {
		if (value === "inherit") {
			return resolveFromParent(declaration, property) ?? "";
		}
		return INITIAL_KEYWORDS.has(value) ? null : value;
	};

	if (inlineImportant) {
		return inlineImportantValue!;
	}
	if (importantRuleValue) {
		const resolved = declaredByRule(importantRuleValue);
		if (resolved !== null) {
			return resolved;
		}
	} else if (inlineUsable) {
		return inlineValue!;
	} else if (ruleValue) {
		const resolved = declaredByRule(ruleValue);
		if (resolved !== null) {
			return resolved;
		}
	}

	// 3. Check element-specific UA defaults (e.g., strong { font-weight: bold })
	// These take priority over inherited values
	const tagName = declaration[kElement].tagName.toLowerCase();

	// A list's marker gutter is sized to its widest marker rather than taken
	// from the static table, so it has to be resolved before it.
	if (
		property === "padding-left" &&
		(tagName === "ul" || tagName === "ol")
	) {
		return `${getListGutterWidth(declaration[kElement])}ch`;
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
		if (tagName === "ol") {
			return "decimal";
		}
		const bullets = ["disc", "circle", "square"];
		const depth = listNestingDepth(declaration[kElement]);
		return bullets[Math.min(depth, bullets.length - 1)];
	}

	const elementDefaults = getElementDefaults(declaration[kElement]);
	if (elementDefaults && elementDefaults[property]) {
		return elementDefaults[property];
	}

	// 4. For inherited properties, walk up the DOM using getComputedStyle
	// which correctly resolves CSS rules on parent elements. Custom properties
	// (--x) always inherit -- there's no fixed list for them to be in.
	if (INHERITED_PROPERTIES.has(property) || property.startsWith("--")) {
		const window = declaration[kElement].ownerDocument?.defaultView;
		if (window) {
			// Flat-tree parents: inheritance crosses the shadow boundary
			// (host -> shadow child) and reaches slotted content through
			// its slot's chain, exactly as in a browser.
			for (
				let parent = flatParentElement<Element>(declaration[kElement]);
				parent !== null;
				parent = flatParentElement<Element>(parent)
			) {
				const parentValue = computedStyleOf(parent).computedValueOf(property);
				if (parentValue) {
					return parentValue;
				}
			}
		}
	}

	// 5. Fallback to universal defaults and CSS spec defaults
	return getInitialStyle(declaration[kElement], property);
}

/**
 * The custom properties in effect here: this element's own, and every one
 * an ancestor declared -- a custom property inherits, so it is part of
 * this element's computed style whichever element declared it.
 */
function customNames(
	computed: ComputedStyleDeclaration,
): string[] {
	const current = computed[kManager]?.[kCurrentDeclarations];
	if (current !== undefined && !current.has(computed)) {
		computed[kRefresh]();
	}
	if (computed[kCustom]) {
		return computed[kCustom];
	}
	const names = new Set<string>();
	for (
		let element: Element | null = computed[kElement];
		element;
		element = flatParentElement<Element>(element)
	) {
		const declaration = computed[kManager]?.declarationFor(element);
		for (const name of declaration?.declaredCustomProperties() ?? []) {
			names.add(name);
		}
	}
	computed[kCustom] = [...names];
	return computed[kCustom];
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

const kPseudoDeclarations = Symbol("pseudo declarations");
const kPseudoElement = Symbol("pseudoElement");
const kNodeResolved = Symbol("nodeResolved");
const kNodeStyle = Symbol("nodeStyle");
const kBoxView = Symbol("boxView");
const kBoxViewOf = Symbol("boxViewOf");

/**
 * A pseudo-element's computed style: a flat declaration set -- the matched
 * rules plus what it inherits from its originating element -- read through
 * the same computed-value boundary as an element's.
 */
class PseudoStyleDeclaration extends CSSStyleProperties {
	declare [kPseudoDeclarations]: Record<string, string>;
	// Lazily resolved properties, cleared by kRefresh -- the same one-per
	// -resolution memo an element's declaration keeps, for the same reason.
	declare [kResolved]: Map<string, string>;
	/**
	 * The element the pseudo-element originates from, which pseudo-element it
	 * is, and the manager whose flush a resolved value is measured behind.
	 * Absent on the engine's own reads (the ::selection and ::marker painters),
	 * which want the cascade's declarations and never a used value -- and whose
	 * declarations, handed in whole, are not the manager's to recompute.
	 */
	declare [kElement]: Element | null;
	declare [kPseudoElement]: string;
	declare [kManager]: StyleManager | null;
	/**
	 * A pseudo-element's computed style is LIVE for the same reason an
	 * element's is: the object an author holds keeps answering the
	 * pseudo-element's current values across class flips and sheet
	 * replacements. The manager says when what it holds no longer stands.
	 */

	constructor(
		declarations: Record<string, string>,
		element?: Element,
		manager?: StyleManager,
		pseudoElement = "",
	) {
		super();
		this[kResolved] = new Map<string, string>();
		this[kNodeStyle] = null;
		this[kNodeResolved] = new Map<string, string>();
		this[kBoxView] = null;
		this[kPseudoDeclarations] = declarations;
		this[kElement] = element ?? null;
		this[kPseudoElement] = pseudoElement;
		this[kManager] = manager ?? null;
		if (manager) {
			manager[kCurrentDeclarations].add(this);
		}
	}

	/** Re-resolve against the current cascade, declarations and all. */
	[kRefresh](): void {
		// Before the work: resolving below reads back through this declaration.
		this[kManager]?.[kCurrentDeclarations].add(this);
		if (this[kManager] && this[kElement] && this[kPseudoElement]) {
			this[kPseudoDeclarations] = this[kManager].pseudoDeclarations(
				this[kElement],
				this[kPseudoElement],
			);
		}
		if (this[kManager] && this[kElement] && this[kPseudoElement]) {
			storeTransitionFallback(
				this[kManager],
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
		if (this[kManager] && this[kElement] && this[kPseudoElement]) {
			processTransitionStyle(
				this[kManager],
				this[kElement],
				(property) => this[kBaseValue](property),
				this[kPseudoElement],
			);
		}
	}

	/**
	 * What the cascade declared for this pseudo-element, and nothing else.
	 *
	 * This is the engine's read: an empty answer means no rule reached the
	 * pseudo-element, which is what the ::selection painter and the ::marker
	 * painter decide on. The author read below completes the same declarations
	 * with the initial values a computed style carries.
	 */
	computedValueOf(property: string): string {
		const current = this[kManager]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kRefresh]();
		}
		const value = this[kBaseValue](property);
		const transitional = this[kTransitionValue](property);
		return transitional ?? value;
	}

	/** The cascade's declarations alone, with no transition standing over them. */
	[kBaseValue](property: string): string {
		let value = this[kResolved].get(property);
		if (value === undefined) {
			const longhands = SHORTHAND_LONGHANDS.get(property);
			value =
				longhands && this[kPseudoDeclarations][property] === undefined ?
						serializeShorthandValue(
							property,
							longhands,
							(longhand) =>
								this[kBaseValue](longhand) ||
								CSS_INITIAL_VALUES[longhand] ||
								"",
						) :
						computedValue(property, this[kPseudoDeclarations][property] ?? "");
			this[kResolved].set(property, value);
		}
		return value;
	}

	/** A running transition's value for this pseudo-element, or null. */
	[kTransitionValue](property: string): string | null {
		const manager = this[kManager];
		if (
			manager === null ||
			this[kElement] === null ||
			manager[kTransitionCount] === 0
		) {
			return null;
		}
		return transitionValueOf(
			manager,
			this[kElement],
			this[kPseudoElement],
			property,
		);
	}

	/**
	 * The style of the NODE a pseudo-element generates: the same declarations,
	 * completed with the initial value of everything no rule and no
	 * inheritance gave a value. A box is laid out and painted from this -- an
	 * empty answer would leave it with no `display` at all -- while the
	 * cascade read above stays the bare declarations the ::selection and
	 * ::marker painters decide on.
	 */
	get nodeStyle(): ComputedStyle {
		let style = this[kNodeStyle];
		if (style === null) {
			// One object for the declaration's life: the memo behind it is a
			// field kRefresh clears, so a holder of this view sees the current
			// cascade rather than the one it was first read under.
			style = {
				computedValueOf: (property: string): string => {
					const current = this[kManager]?.[kCurrentDeclarations];
					if (current !== undefined && !current.has(this)) {
						this[kRefresh]();
					}
					let value = this[kNodeResolved].get(property);
					if (value === undefined) {
						value =
							this[kBaseValue](property) ||
							computedValue(property, getInitialStyle(null, property));
						this[kNodeResolved].set(property, value);
					}
					const transitional = this[kTransitionValue](property);
					return transitional ?? value;
				},
			};
			this[kNodeStyle] = style;
		}
		return style;
	}

	declare [kNodeStyle]: ComputedStyle | null;
	declare [kNodeResolved]: Map<string, string>;
	declare [kBoxView]: MeasuredDeclaration | null;

	override getPropertyValue(property: string): string {
		this[kManager]?.flushStyle();
		const computed =
			this.computedValueOf(property) ||
			computedValue(property, getInitialStyle(null, property));
		if (this[kManager] && USED_VALUE_PROPERTIES.has(property)) {
			return this[kUsedValue](property, computed);
		}
		return computed;
	}

	/**
	 * A pseudo-element's resolved value, measured behind the same flush an
	 * element's is.
	 *
	 * A pseudo-element's box belongs to the node the composition pass gave it,
	 * so its metrics are measured off that node's rect through the same
	 * arithmetic an element's are: a stretched block pseudo answers its used
	 * width, an inline one the union of its fragments. A pseudo the
	 * composition never gave a node -- one whose selector generates no
	 * content, or a ::selection -- keeps the percentage resolution below,
	 * against the box it would hang in.
	 */
	[kUsedValue](property: string, computed: string): string {
		const originating = this[kElement];
		const manager = this[kManager];
		if (originating && manager) {
			// The flush before the node lookup: the composition pass that runs
			// under it is what creates a pseudo-element's node, so a lookup
			// taken first would answer "no box" for a box one render away.
			manager.usedRect(originating);
			const node = pseudoElement<Element>(
				originating,
				this[kPseudoElement],
			);
			if (node) {
				return measure(this[kBoxViewOf](node), property, computed);
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
		// its own, so its pseudo-elements hang in the box its own parent
		// makes -- the same box its children hang in.
		let host: Element | null = this[kElement];
		while (
			host &&
			computedStyleOf(host).computedValueOf("display") === "contents"
		) {
			host = flatParentElement<Element>(host);
		}
		const box = host && this[kManager]!.contentBox(host);
		if (!box) {
			return computed;
		}
		// Every percentage but the block-axis sizes measures against the
		// containing block's width, block direction included.
		const vertical =
			property === "height" || property === "top" || property === "bottom";
		const basis = vertical ? box.height : box.width;
		return usedLength((parseFloat(computed) / 100) * basis);
	}

	/**
	 * This declaration as the measurement arithmetic reads it: the same
	 * cascade answers, with the pseudo-element's own node standing where the
	 * element stands -- its rect is the box being measured, and its flat-tree
	 * parent is the originating element percentages resolve against. One view
	 * per node: composition may retire a node and make another, and a view
	 * naming the old one would measure a rect no layout holds.
	 */
	[kBoxViewOf](node: Element): MeasuredDeclaration {
		let view = this[kBoxView];
		if (!view || view[kElement] !== node) {
			view = {
				[kElement]: node,
				[kManager]: this[kManager],
				computedValueOf: (property: string): string =>
					this.nodeStyle.computedValueOf(property),
				getPropertyValue: (property: string): string =>
					this.getPropertyValue(property),
			};
			this[kBoxView] = view;
		}
		return view;
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
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}
}

/**
 * The answer to a `getComputedStyle` pseudo-element argument that names no
 * pseudo-element: a declaration of nothing, as CSSOM says.
 */
class EmptyStyleDeclaration extends CSSStyleProperties {
	declare [kElement]: Element | null;

	constructor(element?: Element) {
		super();
		this[kElement] = element ?? null;
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

	override get length(): number {
		return 0;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}
}

/**
 * A computed style is read-only; writing one is an error, not a no-op. The
 * error is the document's own DOMException where one is reachable -- an error
 * from another global is not the one an author catches.
 */
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

/** An element's border sides, in `drawBorder`'s own vocabulary. */
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
	const computedStyle = computedStyleOf(element);

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
		return LINE_KEYWORDS.has(style) ?
				(style as LineStyle["style"]) :
			"solid";
	};

	// A corner is rounded when its radius is nonzero on BOTH axes, exactly as
	// a browser squares off a corner whose ellipse has collapsed. A cell grid
	// has one size of curve, so how large the radius is says nothing further.
	const roundedCorner = (corner: string): "round" | undefined => {
		const radii = computedStyle
			.computedValueOf(`border-${corner}-radius`)
			.split(/\s+/)
			.filter(Boolean);
		if (radii.length === 0) {
			return undefined;
		}
		return radii.every((radius) => parseFloat(radius) > 0) ?
			"round" :
			undefined;
	};

	const of = (side: string): LineStyle["style"] | undefined =>
		sideOf(
			computedStyle.computedValueOf(`border-${side}-width`) ||
			computedStyle.computedValueOf("border-width"),
			computedStyle.computedValueOf(`border-${side}-style`) ||
			computedStyle.computedValueOf("border-style"),
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

/** list-style-types that produce a counter, and therefore a trailing "." */
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

/** Render an ordinal in a counter style, falling back to decimal out of range. */
function formatOrdinal(ordinal: number, listStyleType: string): string {
	switch (listStyleType) {
		case "decimal-leading-zero":
			return ordinal >= 0 && ordinal < 10 ? `0${ordinal}` : `${ordinal}`;
		case "lower-alpha":
		case "lower-latin":
			return ordinal > 0 ? toAlpha(ordinal) : `${ordinal}`;
		case "lower-roman":
			// Roman numerals are undefined outside 1-3999; CSS falls back to decimal.
			return ordinal > 0 && ordinal < 4000 ?
					toRoman(ordinal).toLowerCase() :
				`${ordinal}`;
		case "upper-alpha":
		case "upper-latin":
			return ordinal > 0 ? toAlpha(ordinal).toUpperCase() : `${ordinal}`;
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
	const listStyleType =
		computedStyleOf(listItem).computedValueOf("list-style-type");

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
		return `${formatOrdinal(listItemOrdinal(listItem, listParent), listStyleType)}.`;
	}

	return "";
}

// TODO: Just use the CSSOM CSSRule interface from the DOM
interface ParsedCSSRule {
	selector: string;
	/**
	 * The element type the selector's subject is anchored to, lowercased --
	 * absent when the subject names no type and any element could be it. Every
	 * rule is tried against every element, so this is the reject that keeps a
	 * document of divs from running the selector engine over a sheet's worth of
	 * rules about summaries and legends.
	 */
	subjectTag?: string;
	declarations: Record<string, string>;
	/** Properties declared `!important` in this rule. */
	important: Record<string, boolean>;
	/** Each declaration's position in the rule's block. See DeclarationBlock. */
	order: Record<string, number>;
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
	 * The namespace the selector's subject must be in: a URI, null for no
	 * namespace, absent when the selector names none and any will do.
	 */
	namespace?: string | null;
	/**
	 * True for rules declared by a UA-internal shadow tree's stylesheet.
	 * Cascade ORIGIN, the tier above specificity: every author rule beats
	 * every UA rule, which is what lets `input::placeholder { color }`
	 * override the UA sheet's gray despite the UA attribute selector's
	 * higher specificity -- exactly the browser's origin ordering.
	 */
	uaOrigin?: boolean;
	/**
	 * The cascade layer this rule was declared in, dot-joined through every
	 * enclosing `@layer`, or null for a rule in no layer.
	 */
	layer: string | null;
	/**
	 * Where the rule's layer sorts, smallest first: layers in the order their
	 * names were declared, then -- last, and so winning the normal cascade --
	 * every unlayered rule. Filled in once the whole layer order is known.
	 */
	layerRank: number;
	/**
	 * The `@scope` conditions the rule was declared inside, outermost first.
	 * Absent for a rule no `@scope` encloses, which is in scope everywhere.
	 */
	scopes?: readonly ScopeCondition[];
}

/**
 * One `@scope (start) to (end)` prelude: the selector lists naming the scoping
 * roots and the scoping limits. `start` is null for `@scope` written without a
 * root, whose root is the element the stylesheet's owner node sits in.
 */
interface ScopeCondition {
	start: string | null;
	end: string | null;
	/** The implicit scoping root, for a condition that names none. */
	owner: Element | null;
}

/** The conditional rules a style rule was found inside, as the cascade reads them. */
interface RuleContext {
	layer: string | null;
	scopes: readonly ScopeCondition[];
}

/** The context of a rule at the top level of a stylesheet. */
const UNCONDITIONAL: RuleContext = {layer: null, scopes: []};

/**
 * The proximity of a declaration in no scope: farther from any element than
 * any scoping root can be, and the same distance for every one of them.
 */
const UNSCOPED = Number.MAX_SAFE_INTEGER;

/**
 * Whether an element is a scoping root of this condition. A condition naming
 * no root has one all the same: the element the stylesheet was written in.
 */
function scopeRootMatches(
	element: Element,
	condition: ScopeCondition,
	outer: Element | null,
): boolean {
	if (condition.start === null) {
		return element === condition.owner;
	}
	return splitSelectorList(condition.start).some((selector) =>
		outer ?
				matchesInScope(element, selector, outer) :
				matchesSelector(element, selector),
	);
}

/**
 * Whether an element is in the scope a root opens: inside it, and with no
 * scoping limit between the two. The root is always in its own scope, limit
 * or no limit.
 */
function inScopeOf(
	element: Element,
	root: Element,
	condition: ScopeCondition,
): boolean {
	const limits = condition.end ? splitSelectorList(condition.end) : [];
	let node: Element | null = element;
	for (; node && node !== root; node = node.parentElement) {
		if (limits.some((selector) => matchesInScope(node!, selector, root))) {
			return false;
		}
	}
	return node === root;
}

/** `element.matches`, with a selector the matcher rejects matching nothing. */
function matchesSelector(element: Element, selector: string): boolean {
	try {
		return element.matches(selector);
	} catch (_err) {
		return false;
	}
}

/**
 * Whether an element matches a scoped selector, `:scope` standing for the
 * given scoping root.
 *
 * A selector opening with a combinator is relative to the root, which is what
 * `@scope { > .a { } }` means. The root's own subtree is the DOM's own scoping
 * root, so a selector reaching down from `:scope` is matched by asking it for
 * the elements it selects; a selector whose subject IS the root cannot be, and
 * matches with `:scope` standing for any element -- the identity it asserts is
 * already established.
 */
function matchesInScope(
	element: Element,
	selector: string,
	root: Element,
): boolean {
	let text = selector.trim();
	if (/^[>+~]/.test(text)) {
		text = `:scope ${text}`;
	}
	try {
		if (!text.includes(":scope")) {
			return element.matches(text);
		}
		if (element === root) {
			const subject = subjectCompoundStart(text);
			// `:scope` on a non-subject compound asks the root to be a strict
			// descendant of itself.
			if (text.slice(0, subject).includes(":scope")) {
				return false;
			}
			return element.matches(
				text.slice(0, subject) + text.slice(subject).replaceAll(":scope", "*"),
			);
		}
		for (const found of root.querySelectorAll(text)) {
			if (found === element) {
				return true;
			}
		}
		return false;
	} catch (_err) {
		return false;
	}
}

/** Where a complex selector's subject compound starts: past its last combinator. */
function subjectCompoundStart(selector: string): number {
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let index = 0; index < selector.length; index++) {
		const char = selector[index];
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
		} else if (depth === 0 && /[\s>+~]/.test(char)) {
			start = index + 1;
		}
	}
	return start;
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

const kWindow = Symbol("window");
const kLayoutEngine = Symbol("layoutEngine");
const kDocument = Symbol("document");
const kGetComputedStyle = Symbol("getComputedStyle");
const kCurrentDeclarations = Symbol("currentDeclarations");
const kStylesheetsDirty = Symbol("stylesheetsDirty");
const kParsedStyleSheetCount = Symbol("parsedStyleSheetCount");
const kLayoutFlush = Symbol("layoutFlush");
const kFlushing = Symbol("flushing");
const kUsedValues = Symbol("usedValues");
const kShadowRoots = Symbol("shadowRoots");
const kSelectorsReachAncestors = Symbol("selectorsReachAncestors");
const kSelectorsReachSiblings = Symbol("selectorsReachSiblings");
const kStyleSheetList = Symbol("styleSheetList");
const kFocusVisibleActive = Symbol("focusVisibleActive");
const kComputedStyleCache = Symbol("computedStyleCache");
const kPseudoElementStyleCache = Symbol("pseudoElementStyleCache");
const kPseudoNodeStyles = Symbol("pseudoNodeStyles");
const kCounterScopes = Symbol("counterScopes");
const kParsedRules = Symbol("parsedRules");
const kReachingClasses = Symbol("reachingClasses");
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
const kTransitionsExist = Symbol("transitionsExist");
const kTransitionSnapshots = Symbol("transitionSnapshots");
const kTransitionFallback = Symbol("transitionFallback");
const kActiveTransitions = Symbol("activeTransitions");
const kTransitionCount = Symbol("transitionCount");
const kTransitionClock = Symbol("transitionClock");
const kTransitionTimer = Symbol("transitionTimer");
const kTransitionEvents = Symbol("transitionEvents");
const kTransitionFlushQueued = Symbol("transitionFlushQueued");

export class StyleManager {
	declare [kComputedStyleCache]: WeakMap<Element, ComputedStyleDeclaration>;
	/**
	 * Every declaration this manager has resolved against the cascade as it
	 * stands. A declaration reads this to know whether its values are still
	 * the cascade's answer: dropping one, or replacing the set, is what sends
	 * it back through kRefresh on its next read. Membership is weak, so a
	 * declaration nobody holds costs nothing to have handed out.
	 */
	declare [kCurrentDeclarations]: WeakSet<object>;
	/**
	 * Every shadow root whose <style> elements participate in the cascade.
	 * Nothing else parses a shadow tree's stylesheets, so parsing walks these
	 * and feeds each <style>'s text through the parser document sheets take.
	 */
	declare [kShadowRoots]: Set<ShadowRoot>;
	declare [kPseudoElementStyleCache]: WeakMap<
		Element,
		Map<string, PseudoStyleDeclaration>
	>;

	declare [kParsedRules]: ParsedCSSRule[];
	declare [kStylesheetsDirty]: boolean;
	/**
	 * Whether any parsed selector can reach OUTSIDE the mutated element's
	 * subtree: sibling combinators reach following siblings, :has() reaches
	 * ancestors. Set during parsing, read when an attribute flips to decide
	 * how far its invalidation must reach. String tests are deliberately
	 * loose (`~=` in an attribute selector counts as a sibling combinator): a
	 * false positive only widens the rebuild.
	 */
	declare [kSelectorsReachSiblings]: boolean;
	declare [kSelectorsReachAncestors]: boolean;
	/**
	 * The keys a change to which can reach an element's DESCENDANTS: those a
	 * selector tests left of a combinator (`.editing .view` is TodoMVC's edit
	 * row), and those on rules declaring an inherited property, which the
	 * descendants take their own value from. A class the sheets only ever
	 * test on the subject of rules declaring `background` and `display`
	 * (`.row.selected`) reaches nothing below.
	 *
	 * Collected loosely, by scanning compounds for `.name`, `#name` and
	 * `[name`: keys inside :not()/:is() are read the same way, and a false
	 * positive only widens the invalidation.
	 */
	declare [kReachingClasses]: Set<string>;
	declare [kReachingIds]: Set<string>;
	declare [kReachingAttributes]: Set<string>;
	/**
	 * Whether any of those keys is a STATE pseudo-class (`:checked ~`,
	 * `details[open] :not(summary)`) rather than a name. State pseudos are
	 * driven by attributes whose names are not in the sets above, so a change
	 * to any of {@link STATE_ATTRIBUTES} goes wide while this holds.
	 */
	declare [kReachingStates]: boolean;
	/**
	 * Rule-existence gates, also set during parsing. Attaching pseudos and
	 * initializing counters both start by building full computed-style
	 * declarations -- per element, on every insertion and attribute change.
	 * A document whose sheets declare no ::before for divs and no counters
	 * anywhere must not pay that; these let the hot paths answer "could any
	 * rule possibly apply here" with a few matches() calls instead.
	 */
	declare [kPseudoRulesByType]: Map<string, ParsedCSSRule[]>;
	declare [kCounterRulesExist]: boolean;
	declare [kListItemRulesExist]: boolean;
	/** Whether any rule is scoped, which is what puts proximity in the sort. */
	declare [kScopedRulesExist]: boolean;
	declare [kHasRulesExist]: boolean;
	/**
	 * Whether any parsed selector mentions `:hover`. The engine reads this to
	 * decide whether the terminal must report pointer motion: a sheet that
	 * never tests hover is a document that cannot show it, and motion
	 * reporting has a per-cell cost the document should not pay for nothing.
	 */
	declare [kHoverRulesExist]: boolean;
	// The `:focus-visible` state, driven by TermDOM from the last input modality
	// (keyboard true, pointer false). kRuleMatches gates such rules on it.
	declare [kFocusVisibleActive]: boolean;
	/**
	 * How many document.styleSheets the last parse consumed; -1 = never
	 * parsed. A changed count re-parses on the next style computation --
	 * which is what lets a sheet appended right before the first paint
	 * apply even when no MutationObserver is attached. (The old sentinel
	 * was kParsedRules.length === 0, which stopped meaning "never parsed"
	 * the moment the UA document sheet guaranteed one rule.)
	 */
	declare [kParsedStyleSheetCount]: number;

	// CSS Counter support
	declare [kCounterScopes]: WeakMap<Element, CounterScope>;

	/**
	 * The transition machinery's state. The gate is STICKY: it opens the
	 * first time any rule or inline block declares a transition and never
	 * closes, so a document with none pays two checks per style change
	 * event and nothing else. Snapshots (the after-change values of the
	 * last style change event, per element per pseudo) live in a WeakMap;
	 * only elements with RUNNING transitions sit in the strong map the
	 * per-frame tick iterates.
	 */
	declare [kTransitionsExist]: boolean;
	declare [kTransitionSnapshots]: WeakMap<
		Element,
		Map<string, Map<string, string>>
	>;

	/**
	 * The resolved values a dropped declaration had computed, kept as the
	 * before-change style for an element whose transitions are declared in
	 * one style change with the retarget of a property -- the case the
	 * snapshot above cannot cover, since no transition was matched when it
	 * was last written. Stolen maps, not copies: the declaration replacing
	 * its memo is what makes the old map safe to hold.
	 */
	declare [kTransitionFallback]: WeakMap<
		Element,
		Map<string, Map<string, string>>
	>;

	declare [kActiveTransitions]: Map<
		Element,
		Map<string, Map<string, RunningTransition>>
	>;

	declare [kTransitionCount]: number;
	/** The timeline instant a frame's reads interpolate against. */
	declare [kTransitionClock]: number;
	declare [kTransitionTimer]: ReturnType<typeof setTimeout> | null;
	declare [kTransitionEvents]: QueuedTransitionEvent[];
	declare [kTransitionFlushQueued]: boolean;

	// The document is fixed for the window's lifetime, so hold it directly rather
	// than reaching through window.document on every access.
	declare [kDocument]: Document;
	declare [kWindow]: EngineWindow;
	declare [kLayoutEngine]?: LayoutEngine;

	constructor(window: EngineWindow, layoutEngine?: LayoutEngine) {
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
		this[kSelectorsReachSiblings] = false;
		this[kSelectorsReachAncestors] = false;
		this[kReachingClasses] = new Set<string>();
		this[kReachingIds] = new Set<string>();
		this[kReachingAttributes] = new Set<string>();
		this[kReachingStates] = false;
		this[kPseudoRulesByType] = new Map<string, ParsedCSSRule[]>();
		this[kCounterRulesExist] = false;
		this[kListItemRulesExist] = false;
		this[kScopedRulesExist] = false;
		this[kHasRulesExist] = false;
		this[kHoverRulesExist] = false;
		this[kFocusVisibleActive] = true;
		this[kParsedStyleSheetCount] = -1;
		this[kCounterScopes] = new WeakMap<Element, CounterScope>();
		this[kLayoutFlush] = null;
		this[kFlushing] = false;
		this[kUsedValues] = new WeakMap();
		this[kStyleSheetList] = null;
		this[kPseudoNodeStyles] = new WeakMap<Element, ComputedStyle>();
		this[kLayerPaths] = [];
		this[kAnonymousLayers] = 0;
		this[kUnlayeredRank] = 0;
		this[kTransitionsExist] = false;
		this[kTransitionSnapshots] = new WeakMap();
		this[kTransitionFallback] = new WeakMap();
		this[kActiveTransitions] = new Map();
		this[kTransitionCount] = 0;
		this[kTransitionClock] = 0;
		this[kTransitionTimer] = null;
		this[kTransitionEvents] = [];
		this[kTransitionFlushQueued] = false;
		this[kWindow] = window;
		this[kLayoutEngine] = layoutEngine;
		this[kDocument] = window.document;

		// The list gutter is resolved inside the cascade, which cannot reach a
		// StyleManager any other way. See getListGutterWidth().
		styleManagers.set(window, this);
		documentManagers.set(this[kDocument], this);
		// The composed-tree capability: claimed here while the document is
		// headless (tests, WPT, headless windows). On the terminal path
		// this constructor runs before the engine installs, so the claim is
		// the UA constructing itself; page code arrives after the install
		// closes the door.
		if (!uaByDocument.has(this[kDocument])) {
			uaByDocument.set(this[kDocument], claimUAToolkit(this[kDocument]));
		}

		// Override window.getComputedStyle with our cached version
		window.getComputedStyle = this[kGetComputedStyle].bind(this);

		// Hook into methods that should invalidate cached styles
		setupInvalidationHooks(this);
	}

	/** The rules matching an element, in cascade order. */
	matchingRules(element: Element): ParsedCSSRule[] {
		if (
			this[kStylesheetsDirty] ||
			styleSheetCount(this) !== this[kParsedStyleSheetCount]
		) {
			parseStylesheets(this);
		}
		return getMatchingRules(this, element);
	}

	/**
	 * The flush a geometry read takes before measuring: pending mutations
	 * drained and layout brought up to date, synchronously. A resolved value
	 * is a measurement, so it goes through the same door -- there is exactly
	 * one place that decides what "laid out now" means.
	 */
	declare [kLayoutFlush]: (() => boolean) | null;

	setLayoutFlush(flush: () => boolean): void {
		this[kLayoutFlush] = flush;
	}

	/**
	 * Take that flush: pending mutations drained into the cascade and layout,
	 * then layout brought up to date. Every author-facing style read goes
	 * through it, so a value read straight after a DOM change describes that
	 * change; the engine's own reads (computedValueOf) never do.
	 */
	flushStyle(): void {
		// Not re-entrant: layout and paint resolve styles as they run, and a
		// read taken from inside the flush sees the layout being computed --
		// asking for it again would compute it inside itself.
		if (this[kFlushing] || !this[kLayoutFlush]) {
			return;
		}
		this[kFlushing] = true;
		try {
			if (this[kLayoutFlush]()) {
				this[kUsedValues] = new WeakMap();
			}
		} finally {
			this[kFlushing] = false;
		}
	}

	declare [kFlushing]: boolean;

	/**
	 * The grid a viewport unit measures against, in cells. Null before a
	 * layout engine is wired up, where `1vw` has nothing to be a hundredth of.
	 */
	viewportSize(): {width: number; height: number} | null {
		if (!this[kLayoutEngine]) {
			return null;
		}
		return {
			width: this[kLayoutEngine].terminalWidth,
			height: this[kLayoutEngine].terminalHeight,
		};
	}

	/** The element's border-box rect, measured after that flush. */
	usedRect(element: Element): DOMRect | null {
		// Without a renderer there is no layout pass, and so no used value to
		// report: the computed value is the answer, as it is for any element
		// with no box.
		if (!this[kLayoutEngine] || !this[kLayoutFlush]) {
			return null;
		}
		// The flush is taken once per layout, not once per read: an
		// invalidation and a layout pass both stale the engine, and until one
		// does the layout standing behind the last flush is still the answer.
		// A caller reading four properties off two hundred elements pays one
		// flush, not eight hundred. Nothing under the flush can reach back
		// here -- layout reads the cascade through computedValueOf, which has
		// no used value to ask for.
		if (this[kLayoutEngine].layoutStale) {
			this[kLayoutFlush]();
			this[kLayoutEngine].layoutStale = false;
			this[kUsedValues] = new WeakMap();
		}
		return this[kLayoutEngine].getRect(element);
	}

	/**
	 * An element's content box, measured behind the same flush: the box a
	 * child's -- or a pseudo-element's -- percentage resolves against.
	 */
	contentBox(element: Element): DOMRect | null {
		// The flush first, since the engine's own derivation reads the layout
		// and this read has to stand behind the same one.
		if (!this.usedRect(element)) {
			return null;
		}
		return this[kLayoutEngine]!.contentRect(element);
	}

	/**
	 * A grid container's used track sizes, measured behind the same flush a
	 * rect read takes. Null for a box that is not one -- the resolved value
	 * then stays the computed track list, as CSSOM says of a grid property on
	 * a box that generated no grid.
	 */
	usedGridTracks(element: Element, rows: boolean): number[] | null {
		if (!this.usedRect(element)) {
			return null;
		}
		return this[kLayoutEngine]!.gridTracks(element, rows);
	}

	/**
	 * The used values measured behind the last flush, per declaration. Held
	 * here rather than on the declarations so that a cascade rebuild, or a
	 * flush that found work, drops every one of them at once -- a fresh map
	 * says nothing has been measured, which costs nothing to say.
	 */
	declare [kUsedValues]: WeakMap<object, Map<string, string>>;

	/** The used values a declaration has measured behind the last flush. */
	[kUsedValuesOf](declaration: object): Map<string, string> {
		let values = this[kUsedValues].get(declaration);
		if (!values) {
			values = new Map();
			this[kUsedValues].set(declaration, values);
		}
		return values;
	}

	/** Drop one declaration's used values: its cascade moved under them. */
	[kDropUsedValues](declaration: object): void {
		this[kUsedValues].delete(declaration);
	}

	setLayoutEngine(layoutEngine: LayoutEngine): void {
		this[kLayoutEngine] = layoutEngine;

		// Parse initial stylesheets (may be empty at construction time)
		parseStylesheets(this);
	}

	/**
	 * Enroll a shadow root's stylesheets in the cascade. Called for every
	 * attached root (author and UA alike); rules parse lazily on the next
	 * stylesheet refresh, which the root's own <style> mutations trigger
	 * through the shared observer.
	 */
	registerShadowRoot(root: ShadowRoot): void {
		if (this[kShadowRoots].has(root)) {
			return;
		}
		this[kShadowRoots].add(root);
		// A new root's sheets parse INCREMENTALLY: rebuilding every sheet
		// for each widget upgrade made a document of n widgets reparse the
		// world n times. The new rules join the cascade order by the same
		// sort, and only the root's own tree -- and its host, for :host
		// rules -- restyles. A rebuild already pending covers this root,
		// since it is in kShadowRoots now.
		this.refreshShadowRoot(root);
	}

	/**
	 * Re-parse ONE shadow root's sheets in place: its old rules leave, the
	 * current sheets parse in, the cascade re-sorts, and only trees the
	 * root's rules can reach restyle. The full rebuild handles everything
	 * else; a pending one covers this root already.
	 */
	refreshShadowRoot(root: ShadowRoot): void {
		if (this[kStylesheetsDirty] || this[kParsedStyleSheetCount] < 0) {
			this[kStylesheetsDirty] = true;
			return;
		}
		const stale = this[kParsedRules].length;
		this[kParsedRules] = this[kParsedRules].filter(
			(rule) => rule.scope !== root,
		);
		void stale;
		const before = this[kParsedRules].length;
		for (const sheet of shadowStyleSheets(root)) {
			parseStyleSheet(this, sheet, root);
		}
		// The refresh accounted for every sheet the counter has seen; a
		// document-level sheet arriving in the same batch re-dirties on its
		// own record. Without the sync, the drift check orders the full
		// rebuild this path exists to avoid -- once per widget.
		this[kParsedStyleSheetCount] = styleSheetCount(this);
		const fresh = this[kParsedRules].slice(before);
		if (fresh.length === 0) {
			return;
		}
		const layerRanks = rankLayers(this);
		for (const rule of this[kParsedRules]) {
			rule.layerRank =
				rule.layer === null ?
					this[kUnlayeredRank] :
						(layerRanks.get(rule.layer) ?? this[kUnlayeredRank]);
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
		// A scoped rule that generates pseudo-element boxes needs the attach
		// sweep; the widgets' sheets carry none, so the sweep runs only for
		// the author shadow that does.
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

	/**
	 * Handle DOM mutations using invalidation approach
	 */
	handleMutations(mutations: MutationRecord[]): void {
		const Node = this[kWindow].Node;
		let shouldRefreshStylesheets = false;

		// A :has() subject sits ABOVE what flipped it, so when such rules
		// exist every mutation restyles its flat-tree ancestor chain too.
		if (this[kHasRulesExist]) {
			for (const mutation of mutations) {
				const start =
					mutation.target.nodeType === 1 ?
							(mutation.target as Element) :
						mutation.target.parentElement;
				for (
					let ancestor: Element | null = start;
					ancestor;
					ancestor = uaOf(ancestor)?.flatParentElement<Element>(
						ancestor,
					) ?? null
				) {
					invalidateElementCaches(this, ancestor);
				}
			}
		}

		for (const mutation of mutations) {
			if (mutation.type === "childList") {
				// A <style> element's children ARE its stylesheet text, so
				// adding or removing one reparses the sheet. Inside a shadow
				// root the refresh stays inside it: a widget's sheet must not
				// rebuild the document's cascade.
				if ((mutation.target as Element).tagName === "STYLE") {
					sheetFor(mutation.target as Element).reparseOwnerText();
					const styleRoot = (mutation.target as Element).getRootNode();
					if (
						styleRoot.nodeType === 11 &&
						(styleRoot as ShadowRoot).host
					) {
						this.refreshShadowRoot(styleRoot as ShadowRoot);
					} else {
						shouldRefreshStylesheets = true;
					}
				}
				// A list's marker gutter is derived from its children, so adding or
				// removing an item invalidates the *list*, not just the item that
				// moved. Without this the gutter stays at whatever the original items
				// needed, and a wider marker added later overruns it -- the "iii.Third"
				// collision, on any mutation.
				invalidateEnclosingList(this, mutation.target);

				// Check for stylesheet changes
				for (const node of mutation.addedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (
							element.tagName === "STYLE" ||
							(element.tagName === "LINK" &&
								element.getAttribute("rel") === "stylesheet")
						) {
							const addedRoot = element.getRootNode();
							if (
								element.tagName === "STYLE" &&
								addedRoot.nodeType === 11 &&
								(addedRoot as ShadowRoot).host
							) {
								this.refreshShadowRoot(addedRoot as ShadowRoot);
							} else {
								shouldRefreshStylesheets = true;
							}
						} else {
							// Invalidate caches for new elements
							invalidateElementCaches(this, element);
							// Process pseudo-elements for new elements
							this.attachPseudoElementsToElement(element);

							// Also handle any child elements
							const childElements = element.querySelectorAll("*");
							for (const childElement of childElements) {
								invalidateElementCaches(this, childElement);
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
				const element = mutation.target as Element;
				// A class flip on an ancestor changes which rules match its
				// descendants -- `.editing .view {display:none}` is exactly the
				// TodoMVC edit row -- and moves what they inherit. But only a
				// flip the sheets USE that way does: when no rule tests the
				// flipped class outside its own subject and none of the rules
				// that test it declares an inherited property, the descendants'
				// styles stand exactly as they were.
				if (
					this.attributeReachesDescendants(
						element,
						mutation.attributeName!,
						mutation.oldValue,
					)
				) {
					invalidateSubtree(this, element);
				} else {
					invalidateElementCaches(this, element);
					this.attachPseudoElementsToElement(element);
				}
				// Sibling combinators reach right: `.on ~ .light` matches (or
				// stops matching) a FOLLOWING sibling when this element's
				// attributes change, and that sibling's cached styles know
				// nothing of it. :has() reaches ancestors, for which only the
				// nuclear cache
				// clear is honest.
				if (this[kSelectorsReachAncestors]) {
					this.clearCache();
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
				// A <style>'s text changed: reparse the sheet, and keep a
				// shadow sheet's refresh inside its root.
				const owner = mutation.target.parentElement;
				if (owner?.tagName === "STYLE") {
					sheetFor(owner).reparseOwnerText();
					const ownerRoot = owner.getRootNode();
					if (
						ownerRoot.nodeType === 11 &&
						(ownerRoot as ShadowRoot).host
					) {
						this.refreshShadowRoot(ownerRoot as ShadowRoot);
					} else {
						shouldRefreshStylesheets = true;
					}
				}
			}
		}

		// If stylesheets changed, refresh everything
		if (shouldRefreshStylesheets) {
			this.refreshStylesheets();
		}
	}

	/**
	 * The document's style-element list, held so the count below is a bare
	 * length read. The count is polled on every computed-style read to catch
	 * a <style> appended in the same tick, before the mutation observer
	 * delivers; adopted sheets and a sheet's own mutations reach the cascade
	 * through refreshStylesheets instead.
	 */
	declare [kStyleSheetList]: {length: number} | null;

	/**
	 * Whether an element's text can enter a selection: the used value of
	 * user-select, with `auto` resolved through the parent per css-ui-4.
	 * Divergence: `text`, `all` and `contain` all behave as plain
	 * selectable -- `all` and `contain` change selection's shape, and
	 * nothing implements that shape yet.
	 */
	isSelectable(element: object): boolean {
		let current = element as Element | null;
		while (current) {
			const value = computedStyleOf(current).computedValueOf("user-select");
			if (value === "none") {
				return false;
			}
			if (value !== "auto" && value !== "") {
				return true;
			}
			current = flatParentElement<Element>(current);
		}
		return true;
	}

	/**
	 * Focus moved: the cached ComputedStyleDeclarations of the elements that
	 * gained and lost focus hold rule sets matched BEFORE the move, so a
	 * `:focus` rule would never apply (or, symmetrically, never stop
	 * applying) -- focus is not a mutation, and nothing else invalidates.
	 * Selector matching itself is live (matches(":focus") follows
	 * activeElement); only these caches go stale. Scoped to the two moved
	 * elements: `:focus-within` on ancestors would need chain invalidation,
	 * which nothing supports or tests yet.
	 */
	handleFocusChange(...elements: Array<Element | null>): void {
		for (const element of elements) {
			// The whole flat-tree chain above can observe a focus state:
			// each ancestor through :focus-within, each shadow host through
			// :focus, and a host's focus state reaches into its shadow tree
			// through :host(:focus) rules (and inheritance from whatever
			// they set), so every stop's caches go stale together.
			for (
				let node: Element | null = element;
				node;
				node = flatParentElement<Element>(node)
			) {
				invalidateElementCaches(this, node);
				const shadowRoot = shadowRootOf<ShadowRoot>(node);
				if (shadowRoot) {
					for (const descendant of shadowRoot.querySelectorAll("*")) {
						invalidateElementCaches(this, descendant);
					}
				}
			}
		}
	}

	/**
	 * A state no attribute records moved: a popover was shown or hidden. The
	 * rules that test it (`:popover-open`, and the UA sheet's display among
	 * them) matched before the move, and a popover that stops being displayed
	 * takes its subtree's styles with it -- so the element and everything
	 * whose style comes through it re-resolve.
	 */
	handleStateChange(element: Element): void {
		invalidateSubtree(this, element);
		// No mutation record describes the move, so the frame that decides
		// whether anything is worth painting is told here.
		this[kLayoutEngine]?.invalidateFrame();
	}

	/**
	 * The pointer moved to a new element: the cached declarations of both
	 * hover chains hold rule sets matched under the OLD hover state, the
	 * same staleness a focus move leaves. Scoped to the symmetric
	 * difference of the two flat-tree chains -- the part of the tree whose
	 * `:hover` answer moved; the shared ancestors above the fork answered
	 * hovered before and answer hovered still. Hover is not a mutation, so
	 * the frame the pointer report schedules is what shows it.
	 */
	handleHoverChange(
		previous: Element | null,
		next: Element | null,
	): void {
		const chainOf = (element: Element | null): Set<Element> => {
			const chain = new Set<Element>();
			for (
				let node: Element | null = element;
				node;
				node = flatParentElement<Element>(node)
			) {
				chain.add(node);
			}
			return chain;
		};
		const previousChain = chainOf(previous);
		const nextChain = chainOf(next);
		const invalidate = (node: Element): void => {
			invalidateElementCaches(this, node);
			// A host's hover reaches into its shadow tree through
			// :host(:hover) rules and inheritance, the same reach a focus
			// move has.
			const shadowRoot = shadowRootOf<ShadowRoot>(node);
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

	/**
	 * Whether any active rule tests `:hover`, against the sheets as they
	 * stand -- a dirty sheet list parses first, so an answer read between
	 * frames still describes the current document.
	 */
	hoverRulesExist(): boolean {
		if (
			this[kStylesheetsDirty] ||
			styleSheetCount(this) !== this[kParsedStyleSheetCount]
		) {
			parseStylesheets(this);
		}
		return this[kHoverRulesExist];
	}

	/** Set the `:focus-visible` state; returns whether it changed. */
	setFocusVisible(active: boolean): boolean {
		if (this[kFocusVisibleActive] === active) {
			return false;
		}
		this[kFocusVisibleActive] = active;
		return true;
	}

	[kGetComputedStyle](
		element: Element,
		pseudoElt?: string | null,
	): globalThis.CSSStyleDeclaration {
		// A computed style describes the DOM as it stands, so an author read
		// goes through the flush a geometry read does.
		this.flushStyle();
		// Ensure stylesheets are parsed if the document's sheet list changed
		// since the last parse, or a newly registered shadow root's sheet
		// awaits
		if (
			this[kStylesheetsDirty] ||
			styleSheetCount(this) !== this[kParsedStyleSheetCount]
		) {
			parseStylesheets(this);
		}
		// An element that is not being rendered has no style to report: it is
		// out of the document, or out of the flat tree its document composes.
		// Only an author read comes through here -- the engine reads through
		// declarationFor, which asks nothing of the flat tree.
		if (!isBeingRendered(element)) {
			return new EmptyStyleDeclaration(
				element,
			) as unknown as globalThis.CSSStyleDeclaration;
		}

		// The pseudo-element argument names a pseudo-element, names nothing
		// (and is ignored), or names something that is not one -- for which an
		// empty declaration is the answer.
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
			return indexedDeclaration(
				this.pseudoDeclarationFor(element, pseudoElement),
			) as unknown as globalThis.CSSStyleDeclaration;
		}

		return indexedDeclaration(
			this.declarationFor(element),
		) as unknown as globalThis.CSSStyleDeclaration;
	}

	/**
	 * The declaration behind an element, for the engine itself.
	 *
	 * This is the internal read path: no pseudo-element parsing, no
	 * being-rendered gate, no resolved-value branch -- the cascade's own answer,
	 * which is what layout and paint decide geometry from. It is reached
	 * thousands of times per frame, so it does the least it can.
	 */
	declarationFor(element: Element): ComputedStyleDeclaration {
		let declaration = this[kComputedStyleCache].get(element);
		if (!declaration) {
			if (
				this[kStylesheetsDirty] ||
				styleSheetCount(this) !== this[kParsedStyleSheetCount]
			) {
				parseStylesheets(this);
			}
			declaration = new ComputedStyleDeclaration(
				element,
				getMatchingRules(this, element),
				this,
			);
			this[kComputedStyleCache].set(element, declaration);
			// A fresh declaration is how a style change reaches an element
			// whose old one was dropped by invalidation, so building one is
			// the other face of the style change event kRefresh sees.
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

	/**
	 * The style a pseudo-element's own node is laid out and painted from, on
	 * the same one-lookup read path an element's style takes: layout and paint
	 * ask per property per frame, and rebuilding the view from the host's
	 * declaration each time would put four map hops in front of every read.
	 */
	pseudoNodeStyleFor(
		node: Element,
		host: Element,
		name: string,
	): ComputedStyle {
		let style = this[kPseudoNodeStyles].get(node);
		if (style === undefined) {
			style = this.pseudoDeclarationFor(host, name).nodeStyle;
			this[kPseudoNodeStyles].set(node, style);
		}
		return style;
	}

	declare [kPseudoNodeStyles]: WeakMap<Element, ComputedStyle>;

	/** A pseudo-element's declaration, on the same internal read path. */
	pseudoDeclarationFor(
		element: Element,
		pseudoElement: string,
	): PseudoStyleDeclaration {
		const cached = this[kPseudoElementStyleCache]
			.get(element)
			?.get(pseudoElement);
		if (cached) {
			return cached;
		}
		const declarations = this.pseudoDeclarations(element, pseudoElement);
		const declaration = new PseudoStyleDeclaration(
			declarations,
			element,
			this,
			pseudoElement,
		);
		// The cache is reached HERE, not before the work: resolving the host's
		// style above can reparse the stylesheets, and a reparse replaces every
		// cache on this manager. A map taken before that is an orphan, and
		// storing into it caches nothing -- every read recomputes the
		// declaration, and with it the host's inherited properties.
		let elementCache = this[kPseudoElementStyleCache].get(element);
		if (!elementCache) {
			elementCache = new Map();
			this[kPseudoElementStyleCache].set(element, elementCache);
		}
		elementCache.set(pseudoElement, declaration);
		processTransitionStyle(
			this,
			element,
			(property) => declaration[kBaseValue](property),
			pseudoElement,
		);
		return declaration;
	}

	/**
	 * What the cascade declares for a pseudo-element: its matched rules,
	 * completed by what it inherits from its originating element. A live
	 * declaration re-asks this when the cascade moves under it.
	 */
	pseudoDeclarations(
		element: Element,
		pseudoElement: string,
	): Record<string, string> {
		const declarations: Record<string, string> = {
			...computePseudoElementStyle(this, element, pseudoElement),
		};
		// Per CSS, a pseudo-element INHERITS from its originating element: a
		// button's focus underline runs through its UA brackets, a .destroy's
		// color reaches its ::after glyph. Rule declarations above win;
		// inherited values only fill the gaps.
		const hostStyle = this.declarationFor(element);
		for (const property of INHERITED_PROPERTIES) {
			if (!declarations[property]) {
				const inherited = hostStyle.computedValueOf(property);
				if (inherited) {
					declarations[property] = inherited;
				}
			}
		}
		// A pseudo-element of a flex or grid container is one of its items, and
		// an item's display blockifies -- including the `inline` it would
		// otherwise take from the initial value.
		if (ITEM_DISPLAYS.has(hostStyle.computedValueOf("display"))) {
			declarations.display = blockified(
				declarations.display || getInitialStyle(null, "display"),
			);
		}
		return declarations;
	}

	/**
	 * Every cascade layer, in the order its name was first declared: a
	 * `@layer a, b;` statement, a `@layer a { }` block, or the anonymous layer
	 * an unnamed block opens. A nested layer's path is dot-joined through its
	 * ancestors, which is the name `@layer a.b` writes for itself.
	 */
	declare [kLayerPaths]: string[];
	declare [kAnonymousLayers]: number;

	/** Where an unlayered rule sorts: after every layer, and so above them. */
	declare [kUnlayeredRank]: number;

	/**
	 * Whether a media query currently matches, judged on the nodes css-tree
	 * parses the query list into. There is exactly one "screen" -- the
	 * terminal viewport -- so only width/height features are meaningful;
	 * every other feature (scripting, color-gamut, pointer, ...) matches
	 * rather than silently dropping an author's rules, as does text css-tree
	 * refuses. Public: it answers window.matchMedia through the SAME
	 * evaluator @media uses, so a stylesheet and a script can never disagree
	 * about the viewport.
	 */
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

	/**
	 * Whether changing this attribute on this element can change the style of
	 * its DESCENDANTS -- by starting or stopping a rule that matches one of
	 * them, or by moving a value they inherit. When it can do neither, the
	 * element's own cached style is the only one the cascade renders stale.
	 *
	 * An inline style is always taken to reach them: what it declares is not
	 * known until it is parsed, and it is written where a value is meant to
	 * change.
	 */
	attributeReachesDescendants(
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
			// A record with no old value can be one for an attribute that did
			// not exist, or one from an observer that records none; the classes
			// that LEFT are unknowable either way.
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

	/**
	 * Get marker content for outside positioning
	 */
	getMarkerContent(hostElement: Element): string | null {
		if (!hostElement || hostElement.nodeType !== hostElement.ELEMENT_NODE) {
			return null;
		}

		const computedStyle = this.declarationFor(hostElement);
		const display = computedStyle.computedValueOf("display");

		if (display !== "list-item") {
			return null;
		}

		const styles = computePseudoElementStyle(this, hostElement, "::marker");
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
	 * Check if element should have a pseudo-element based on CSS rules
	 */
	shouldCreatePseudoElement(element: Element, pseudoType: string): boolean {
		// For ::marker pseudo-elements, only create them for inside positioning
		if (pseudoType === "::marker") {
			const computedStyle = this.declarationFor(element);
			const display = computedStyle.computedValueOf("display");
			const listStylePosition =
				computedStyle.computedValueOf("list-style-position") || "outside";

			if (display === "list-item" && listStylePosition !== "outside") {
				return true; // Only create inline markers for inside positioning
			}
		}

		const styles = computePseudoElementStyle(this, element, pseudoType);
		const content = styles.content;
		return !!(content && content !== "none" && content !== "normal");
	}

	/**
	 * Refresh stylesheet parsing (call when stylesheets change)
	 */
	refreshStylesheets(): void {
		parseStylesheets(this);

		// Rules can change LAYOUT (a display flip, new dimensions), and boxes
		// may already have been built under the pre-parse styles -- a
		// .view{display:none} arriving with the same batch as its markup left
		// the hidden subtree's stale boxes ghosting about. Rebuild from the
		// root; stylesheet changes are rare.
		const body = this[kDocument].body;
		if (body) {
			this[kLayoutEngine]?.invalidate(body);
		}
	}

	/**
	 * Efficiently scan document and attach pseudo-element nodes to elements that have matching pseudo-element rules
	 * Uses CSS rules to find matching elements rather than checking every element
	 */
	attachPseudoElementsToDocument(): void {
		// Group pseudo-element rules by pseudo-type for efficient processing
		const pseudoRulesByType = new Map<string, ParsedCSSRule[]>();

		for (const rule of this[kParsedRules]) {
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
					const scope = (rule.scope ?? this[kDocument]) as ParentNode;
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
				attachPseudoElementToElementForType(this, element, pseudoType);
			}
		}

		// Handle special case: ::marker for list-item elements (only for inside positioning)
		const listItems = this[kDocument].querySelectorAll(
			'[style*="list-item"], li',
		);
		for (const element of listItems) {
			const computedStyle = this.declarationFor(element);
			const display = computedStyle.computedValueOf("display");
			const listStylePosition =
				computedStyle.computedValueOf("list-style-position") || "outside";

			// Only create inline markers for inside positioning
			if (display === "list-item" && listStylePosition !== "outside") {
				attachPseudoElementToElementForType(this, element, "::marker");
			}
		}
	}

	/**
	 * The element types a pseudo-element rule originates on, uppercased -- or
	 * null where a rule reaches an element of any type, which is also what a
	 * counter rule does through the scope chain. Built on demand, from the
	 * subject each pseudo rule was parsed with.
	 */
	declare [kPseudoSubjectTags]: Set<string> | null | undefined;

	/**
	 * Attach pseudo-element nodes to a specific element if it has matching pseudo-element rules
	 */
	attachPseudoElementsToElement(element: Element): void {
		// No pseudo rule names this element's type, no counter scope reaches
		// it, and it carries no pseudo of its own to reconsider: everything
		// below would answer no, one matches() call per rule at a time. This is
		// the whole cost of the walk over a subtree that just arrived.
		const tags = pseudoSubjects(this);
		if (
			tags !== null &&
			!tags.has(element.tagName) &&
			pseudoElementCount(element) === 0 &&
			!this[kCounterScopes].has(element.parentElement!) &&
			!(element.getAttribute("style") ?? "").includes("list-item")
		) {
			return;
		}
		// Initialize counters for this element first
		this.initializeCounters(element);

		const pseudoTypes = ["::before", "::after", "::marker"];

		for (const pseudoType of pseudoTypes) {
			attachPseudoElementToElementForType(this, element, pseudoType);
		}
	}

	invalidateElement(element: Element): void {
		// A computed style an author still holds is the one this cache handed
		// out, so it is told the cascade moved on rather than merely dropped.
		const dropped = this[kComputedStyleCache].get(element);
		if (dropped) {
			this[kCurrentDeclarations].delete(dropped);
			storeTransitionFallback(this, element, "", dropped[kResolved]);
		}
		this[kComputedStyleCache].delete(element);
		this[kPseudoElementStyleCache].delete(element);
		// A style change can flip display: contents, which moves the node's
		// flat-tree BOX parent, so no box enumeration still stands.
		this[kLayoutEngine]?.invalidateFrame();
	}

	/**
	 * Clear all cached computed styles (nuclear option)
	 */
	clearCache(): void {
		// Every computed style ever handed out re-resolves on its next read:
		// this manager vouches for none of them any more.
		this[kCurrentDeclarations] = new WeakSet<object>();
		this[kUsedValues] = new WeakMap();
		this[kComputedStyleCache] = new WeakMap();
		this[kPseudoElementStyleCache] = new WeakMap();
		this[kPseudoNodeStyles] = new WeakMap();
		this[kCounterScopes] = new WeakMap();
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
		if (this[kCounterScopes].has(element)) {
			return;
		}

		// With no counter-bearing rules anywhere, only lists carry counters
		// (the automatic list-item one). Skip everything else -- UNLESS the
		// element sits under a scope-holding parent, so a chain like
		// ol > li > div > ol keeps its inheritance path unbroken.
		const tag = element.tagName;
		if (
			!this[kCounterRulesExist] &&
			tag !== "OL" &&
			tag !== "UL" &&
			tag !== "LI" &&
			!(
				element.parentElement && this[kCounterScopes].has(element.parentElement)
			) &&
			!(element.getAttribute("style") ?? "").includes("counter")
		) {
			return;
		}

		const computedStyle = this.declarationFor(element);
		const counterReset = computedStyle.computedValueOf("counter-reset");
		const counterIncrement = computedStyle.computedValueOf("counter-increment");

		// Get parent scope if parent exists (but don't recursively initialize parents)
		const parentElement = element.parentElement;
		const parentScope = parentElement ?
				this[kCounterScopes].get(parentElement) :
			undefined;

		// Create counter scope for this element
		const scope: CounterScope = {
			element,
			counters: {},
			parent: parentScope,
		};
		this[kCounterScopes].set(element, scope);

		// Handle counter-reset first
		if (counterReset && counterReset !== "none") {
			parseCounterReset(this, scope, counterReset);
		}

		// Handle automatic list-item counter for ol/ul elements
		if (element.tagName === "OL" || element.tagName === "UL") {
			const startValue =
				element.tagName === "OL" ?
						parseInt(element.getAttribute("start") || "1", 10) :
					0;
			scope.counters["list-item"] = startValue - 1; // Reset to start-1 so first increment gives start
		}

		// Handle counter-increment after reset
		if (counterIncrement && counterIncrement !== "none") {
			parseCounterIncrement(this, scope, counterIncrement);
		}

		// Handle automatic list-item increment for li elements
		if (element.tagName === "LI") {
			incrementCounter(this, scope, "list-item", 1);
		}
	}

	getCounterValue(element: Element, counterName: string): number {
		const scope = this[kCounterScopes].get(element);
		if (!scope) {
			return 0;
		}

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
		this[kComputedStyleCache] = new WeakMap();
		this[kPseudoElementStyleCache] = new WeakMap();
		this[kPseudoNodeStyles] = new WeakMap();
		this[kCounterScopes] = new WeakMap();
		if (this[kTransitionTimer] !== null) {
			clearTimeout(this[kTransitionTimer]);
			this[kTransitionTimer] = null;
		}
		this[kActiveTransitions].clear();
		this[kTransitionCount] = 0;
		this[kTransitionEvents] = [];
	}
}

// ---------------------------------------------------------------------------
// CSS transitions (css-transitions-1): started at style change events,
// advanced by a per-frame tick, read through the computed-value override.
// ---------------------------------------------------------------------------

/** The timing a transition-property item matched: milliseconds and an easing. */
interface TransitionTiming {
	duration: number;
	delay: number;
	easing: string;
}

interface RunningTransition {
	property: string;
	from: string;
	to: string;
	/** Timeline ms of the style change event that started it. */
	start: number;
	delay: number;
	duration: number;
	easing: (input: number) => number;
	/** Whether transitionstart has fired -- the delay has elapsed. */
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

/**
 * The properties `transition-property: all` covers here: the longhands whose
 * values this engine can interpolate, or flip, with a visible result. A
 * bounded list -- `all` literally means anything animatable, and an
 * unbounded snapshot per style change would put the whole property index in
 * front of each restyle.
 */
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

/**
 * Keep a dropped declaration's resolved values as before-change style. Only
 * properties something read are here -- which is what makes it affordable,
 * and enough: a value nothing ever computed has nothing to transition from.
 * The caller stops holding the map, so it is stored as-is. Unconditional on
 * the sticky gate: the write that declares an element's first transition
 * lands AFTER the invalidation that drops the values it transitions from.
 */
function storeTransitionFallback(
	manager: StyleManager,
	element: Element,
	pseudo: string,
	resolved: Map<string, string>,
): void {
	if (resolved.size === 0) {
		return;
	}
	let byPseudo = manager[kTransitionFallback].get(element);
	if (!byPseudo) {
		byPseudo = new Map();
		manager[kTransitionFallback].set(element, byPseudo);
	}
	byPseudo.set(pseudo, resolved);
}

/** A computed value, with the initial value standing in for an empty answer. */
function transitionBase(
	read: (property: string) => string,
	property: string,
): string {
	return (
		read(property) ||
		computedValue(property, CSS_INITIAL_VALUES[property] ?? "")
	);
}

function parseCSSTime(token: string): number {
	return cssTimeMs(token) ?? 0;
}

/**
 * The transitions the current style matches: each covered longhand mapped to
 * its timing. The duration, delay and easing lists repeat to the property
 * list's length (css-transitions-1 §2.1); a later item naming a property a
 * prior one covered wins.
 */
function matchedTransitions(
	read: (property: string) => string,
): Map<string, TransitionTiming> | null {
	const propertyList = transitionBase(read, "transition-property");
	if (!propertyList || propertyList === "none") {
		return null;
	}
	const durations = splitCommaList(
		transitionBase(read, "transition-duration"),
	).map(parseCSSTime);
	const delays = splitCommaList(
		transitionBase(read, "transition-delay"),
	).map(parseCSSTime);
	const easings = splitCommaList(
		transitionBase(read, "transition-timing-function"),
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
		// §2.1); `all` covers the bounded list above.
		const targets =
			name === "all" ?
				TRANSITIONABLE_ALL :
					(
						SHORTHAND_LONGHANDS.get(name) ?? [name]
					);
		for (const target of targets) {
			out.set(target, timing);
		}
	});
	return out.size > 0 ? out : null;
}

/**
 * One style change event for an element (or one of its pseudo-elements):
 * compare the new base values against the last event's snapshot, start,
 * retarget or cancel transitions accordingly, and store the new snapshot.
 * The cheap early-outs are what each style change in a transition-free
 * document pays.
 */
function processTransitionStyle(
	manager: StyleManager,
	element: Element,
	read: (property: string) => string,
	pseudo: string,
): void {
	const active = manager[kActiveTransitions].get(element)?.get(pseudo);
	if (!manager[kTransitionsExist] && !active) {
		// The sticky gate opens as stylesheets and inline blocks PARSE, and
		// an inline transition written right before this event may not have
		// parsed yet: the attribute text is the one place it already shows.
		const attribute = element.getAttribute("style");
		if (!attribute || !attribute.includes("transition")) {
			return;
		}
		manager[kTransitionsExist] = true;
	}
	const candidates = matchedTransitions(read);
	let snapshots = manager[kTransitionSnapshots].get(element);
	const previous = snapshots?.get(pseudo);
	const fallbacks = manager[kTransitionFallback].get(element);
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
		const after = transitionBase(read, property);
		const timing = candidates?.get(property);
		const runnable =
			timing !== undefined && timing.duration + Math.max(timing.delay, 0) > 0;
		const running = active?.get(property);
		if (running) {
			if (!runnable) {
				cancelTransition(manager, element, pseudo, property, now);
				continue;
			}
			if (after === running.to) {
				continue;
			}
			const current = currentTransitionValue(running, now);
			cancelTransition(manager, element, pseudo, property, now);
			if (current === after) {
				continue;
			}
			// A change back toward where an unfinished transition came from
			// plays in the portion already covered, not the full duration
			// (css-transitions-1 §3, the reversing-adjusted start value).
			let duration = timing.duration;
			let factor = 1;
			if (after === running.reversingAdjustedStartValue) {
				const progress = transitionProgress(running, now);
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
			startTransition(manager, element, pseudo, property, {
				from: current,
				to: after,
				timing: {...timing, duration},
				now,
				reversingAdjustedStartValue: running.to,
				reversingShorteningFactor: factor,
			});
			continue;
		}
		// No before-change value means the element had no style before this
		// event, and an element styled for the first time transitions
		// nothing. The fallback covers a transition declared and retargeted
		// in one event; its raw entries spell "no declaration" as the empty
		// string, which is the initial value the snapshot spells out.
		const raw = previous?.get(property) ?? fallback?.get(property);
		const before =
			raw === "" ?
					computedValue(property, CSS_INITIAL_VALUES[property] ?? "") :
				raw;
		if (
			before === undefined ||
			before === after ||
			!runnable
		) {
			continue;
		}
		startTransition(manager, element, pseudo, property, {
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
			snapshot.set(property, transitionBase(read, property));
		}
		if (!snapshots) {
			snapshots = new Map();
			manager[kTransitionSnapshots].set(element, snapshots);
		}
		snapshots.set(pseudo, snapshot);
	} else if (previous) {
		snapshots!.delete(pseudo);
	}
}

function startTransition(
	manager: StyleManager,
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
	let byPseudo = manager[kActiveTransitions].get(element);
	if (!byPseudo) {
		byPseudo = new Map();
		manager[kActiveTransitions].set(element, byPseudo);
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
	manager[kTransitionCount]++;
	manager[kTransitionClock] = now;
	// A negative delay starts partway in, which is what elapsedTime reports.
	const elapsed =
		Math.min(Math.max(-timing.delay, 0), timing.duration) / 1000;
	queueTransitionEvent(
		manager,
		element,
		"transitionrun",
		property,
		elapsed,
		pseudo,
	);
	if (transition.started) {
		queueTransitionEvent(
			manager,
			element,
			"transitionstart",
			property,
			elapsed,
			pseudo,
		);
	}
	scheduleTransitionTick(manager);
}

function cancelTransition(
	manager: StyleManager,
	element: Element,
	pseudo: string,
	property: string,
	now: number,
): void {
	const byPseudo = manager[kActiveTransitions].get(element);
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
		manager[kActiveTransitions].delete(element);
	}
	manager[kTransitionCount]--;
	const elapsed = Math.min(
		Math.max((now - transition.start - transition.delay) / 1000, 0),
		transition.duration / 1000,
	);
	queueTransitionEvent(
		manager,
		element,
		"transitioncancel",
		property,
		elapsed,
		pseudo,
	);
}

/** The eased progress at `now`, for the reversing arithmetic. */
function transitionProgress(
	transition: RunningTransition,
	now: number,
): number {
	if (transition.delay > 0 && now < transition.start + transition.delay) {
		return 0;
	}
	const linear =
		transition.duration <= 0 ?
			1 :
				(
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

function currentTransitionValue(
	transition: RunningTransition,
	now: number,
): string {
	if (transition.delay > 0 && now < transition.start + transition.delay) {
		return transition.from;
	}
	return interpolateValue(
		transition.from,
		transition.to,
		transitionProgress(transition, now),
	);
}

/**
 * The value a computed-style read answers while a transition runs, or null
 * where none does. Interpolates against the manager's clock rather than the
 * wall: the clock moves once per tick, so a frame's reads agree with each
 * other and with what the painter draws.
 */
function transitionValueOf(
	manager: StyleManager,
	element: Element,
	pseudo: string,
	property: string,
): string | null {
	const transitions = manager[kActiveTransitions].get(element)?.get(pseudo);
	const transition = transitions ? transitions.get(property) : undefined;
	if (!transition) {
		return null;
	}
	return currentTransitionValue(transition, manager[kTransitionClock]);
}

/**
 * Interpolate two computed values: numbers with a shared unit numerically,
 * colors by channel, and anything else -- per the spec's discrete type --
 * as a flip at the midpoint. The painter quantizes to cells and palette
 * entries downstream, so precision here costs nothing.
 */
function interpolateValue(from: string, to: string, progress: number): string {
	if (progress <= 0) {
		return from;
	}
	if (progress >= 1) {
		return to;
	}
	const a = scalarComponents(from);
	const b = scalarComponents(to);
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

/** A value that is one number, dimension or percentage, taken apart. */
function scalarComponents(
	value: string,
): {number: number; unit: string} | null {
	const node = singleValueNode(value);
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

/** Easing functions, memoized by their computed spelling. */
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
	const node = singleValueNode(key);
	if (node && node.type === "Function") {
		const name = (node.name ?? "").toLowerCase();
		const args = functionArguments(node);
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
				args.length < 2 ?
					"end" :
					args[1].type === "Identifier" ?
							(args[1].name ?? "").toLowerCase() :
						"";
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

/**
 * A `linear()` easing (css-easing-1 §2.6). Stops give outputs; a
 * percentage on a stop gives its input, clamped so inputs never run
 * backwards, and a second percentage writes the stop twice. Missing
 * inputs spread evenly between their stated neighbors, and evaluation
 * interpolates within the segment the input lands in, riding the end
 * segments beyond the range. Null for an argument list off the grammar,
 * which then plays as `linear`.
 */
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

/**
 * A step easing (css-easing-1 §2.3). At the input boundaries the before-flag
 * subtleties collapse: 1 answers 1, and 0 answers the first jump's landing --
 * which for the jump-start family is already up a step.
 */
function stepsEasing(
	count: number,
	position: string,
): (input: number) => number {
	const rising =
		position === "jump-start" ||
		position === "start" ||
		position === "jump-both";
	const jumps =
		position === "jump-both" ?
			count + 1 :
			position === "jump-none" ?
					Math.max(count - 1, 1) :
				count;
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

/** A cubic Bezier easing, solved by Newton's method with a bisection net. */
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
	manager: StyleManager,
	element: Element,
	type: string,
	propertyName: string,
	elapsedTime: number,
	pseudoElement: string,
): void {
	manager[kTransitionEvents].push({
		element,
		type,
		propertyName,
		elapsedTime,
		pseudoElement,
	});
	if (manager[kTransitionFlushQueued]) {
		return;
	}
	manager[kTransitionFlushQueued] = true;
	// Style change events run under layout; a listener can mutate the DOM, so
	// dispatch waits for the stack that queued it to unwind.
	queueMicrotask(() => flushTransitionEvents(manager));
}

function flushTransitionEvents(manager: StyleManager): void {
	manager[kTransitionFlushQueued] = false;
	if (manager[kTransitionEvents].length === 0) {
		return;
	}
	const queued = manager[kTransitionEvents];
	manager[kTransitionEvents] = [];
	for (const item of queued) {
		const event = new TransitionEvent(item.type, {
			bubbles: true,
			cancelable: item.type === "transitionend",
			propertyName: item.propertyName,
			elapsedTime: item.elapsedTime,
			pseudoElement: item.pseudoElement,
		});
		uaOf(item.element)?.dispatchAsUserAgent(item.element, event);
	}
}

function scheduleTransitionTick(manager: StyleManager): void {
	if (manager[kTransitionTimer] !== null || manager[kTransitionCount] === 0) {
		return;
	}
	manager[kTransitionTimer] = setTimeout(() => {
		manager[kTransitionTimer] = null;
		tickTransitions(manager);
	}, 16);
}

/**
 * Advance the clock one frame: promote delayed transitions, finish elapsed
 * ones, cancel those whose element left the document, then invalidate the
 * transitioning elements so the next read -- and the frame the tick requests
 * -- answers the new interpolated values.
 */
function tickTransitions(manager: StyleManager): void {
	const now = performance.now();
	manager[kTransitionClock] = now;
	for (const [element, byPseudo] of [...manager[kActiveTransitions]]) {
		const disconnected = !element.isConnected;
		for (const [pseudo, transitions] of [...byPseudo]) {
			for (const [property, transition] of [...transitions]) {
				if (disconnected) {
					cancelTransition(manager, element, pseudo, property, now);
					continue;
				}
				if (
					!transition.started &&
					now >= transition.start + transition.delay
				) {
					transition.started = true;
					queueTransitionEvent(
						manager,
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
					manager[kTransitionCount]--;
					queueTransitionEvent(
						manager,
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
			manager[kActiveTransitions].delete(element);
		}
		invalidateElementCaches(manager, element);
	}
	manager[kLayoutEngine]?.invalidateFrame();
	flushTransitionEvents(manager);
	// The engine's requestAnimationFrame schedules a render; a window no
	// engine dressed has none, and its reads interpolate on their own.
	const raf = (
		manager[kWindow] as {
			requestAnimationFrame?: (cb: () => void) => number;
		}
	).requestAnimationFrame;
	if (typeof raf === "function") {
		raf.call(manager[kWindow], () => {});
	}
	scheduleTransitionTick(manager);
}

function styleSheetCount(
	manager: StyleManager,
): number {
	manager[kStyleSheetList] ??= documentStyleSheetList(manager[kDocument]);
	return manager[kStyleSheetList].length;
}

/**
 * Invalidate an element and everything whose style it reaches: its
 * descendants, and the shadow tree it hosts -- inheritance crosses that
 * boundary, so a color set on a host reaches the tree it composes.
 */
function invalidateSubtree(
	manager: StyleManager,
	element: Element,
): void {
	invalidateElementCaches(manager, element);
	manager.attachPseudoElementsToElement(element);
	for (const descendant of element.querySelectorAll("*")) {
		invalidateElementCaches(manager, descendant);
		manager.attachPseudoElementsToElement(descendant);
	}
	const root = element.shadowRoot;
	if (root) {
		for (const descendant of root.querySelectorAll("*")) {
			invalidateSubtree(manager, descendant);
		}
	}
}

function invalidateElementCaches(
	manager: StyleManager,
	element: Element,
): void {
	// Layout measured this element under the style being dropped. This is
	// the one place an element's computed style goes stale -- attribute
	// flips, inline styles, subtree and sibling reach, focus all arrive
	// here -- so it is the one place layout has to be told.
	manager[kLayoutEngine]?.styleInvalidated(element);
	// A computed style an author still holds is the one this cache handed
	// out, so it is told the cascade moved on rather than merely dropped.
	const dropped = manager[kComputedStyleCache].get(element);
	if (dropped) {
		manager[kCurrentDeclarations].delete(dropped);
		storeTransitionFallback(manager, element, "", dropped[kResolved]);
	}
	manager[kComputedStyleCache].delete(element);
	const droppedPseudos = manager[kPseudoElementStyleCache].get(element);
	if (droppedPseudos) {
		for (const [name, declaration] of droppedPseudos) {
			manager[kCurrentDeclarations].delete(declaration);
			storeTransitionFallback(manager, element, name, declaration[kResolved]);
		}
	}
	manager[kPseudoElementStyleCache].delete(element);
	// The pseudo-element nodes read through the declarations just dropped.
	if (pseudoElementCount(element) > 0) {
		for (const name of PSEUDO_ELEMENT_NAMES) {
			const node = pseudoElement<Element>(element, name);
			if (node) {
				manager[kPseudoNodeStyles].delete(node);
			}
		}
	}
	manager[kCounterScopes].delete(element);
}

/**
 * Invalidate the nearest enclosing list, and its items, after a child changed.
 *
 * The list's padding-left is a function of its items' markers, and the items'
 * ordinals are a function of their position, so both go stale when the child
 * list changes. Only the *nearest* list is affected: a deeper list's items do
 * not contribute to an outer list's gutter.
 */
// TODO(box-tree): a list's gutter is a layout question -- the widest
// marker its items generate -- answered here in the cascade, which is why
// the cascade must watch child lists and reach into the layout engine.
// Phase C computes the gutter during block layout and deletes this.
function invalidateEnclosingList(
	manager: StyleManager,
	target: Node,
): void {
	let element: Element | null =
		target.nodeType === manager[kWindow].Node.ELEMENT_NODE ?
				(target as Element) :
			target.parentElement;

	for (; element; element = element.parentElement) {
		if (element.tagName !== "UL" && element.tagName !== "OL") {
			continue;
		}

		invalidateElementCaches(manager, element);
		manager[kLayoutEngine]?.invalidate(element);
		for (const item of Array.from(element.children)) {
			invalidateElementCaches(manager, item);
		}
		return;
	}
}

/**
 * Walk the document's stylesheets -- this engine's own CSSOM objects, the
 * same ones an author reaches through `styleEl.sheet` -- and collect the
 * rules the cascade matches against.
 *
 * Every style cached against the previous rule set is dropped: a
 * declaration built before this parse was resolved against rules that no
 * longer describe the cascade, and nothing else would ever tell it so.
 */
function parseStylesheets(
	manager: StyleManager,
): void {
	manager[kLayoutEngine]?.invalidateStructure();
	const document = manager[kDocument];
	manager[kParsedRules] = [];
	manager[kSelectorsReachSiblings] = false;
	manager[kSelectorsReachAncestors] = false;
	manager[kReachingClasses].clear();
	manager[kReachingIds].clear();
	manager[kReachingAttributes].clear();
	manager[kReachingStates] = false;
	manager[kPseudoRulesByType] = new Map();
	manager[kPseudoSubjectTags] = undefined;
	manager[kCounterRulesExist] = false;
	manager[kListItemRulesExist] = false;
	manager[kScopedRulesExist] = false;
	manager[kHasRulesExist] = false;
	manager[kHoverRulesExist] = false;
	manager[kStylesheetsDirty] = false;
	manager[kLayerPaths] = [];
	manager[kAnonymousLayers] = 0;
	manager[kParsedStyleSheetCount] = styleSheetCount(manager);

	// The UA document sheet parses first; origin ordering (not source
	// order) is what keeps it beneath every author rule.
	parseStyleSheet(manager, uaStyleSheet(), undefined, true);

	for (const sheet of documentStyleSheets(document)) {
		parseStyleSheet(manager, sheet);
	}

	// Shadow-tree stylesheets, scoped to their root. Disconnected roots
	// parse too: attach-populate-connect is the standard order, and a
	// scope-gated rule matches nothing until its tree renders anyway.
	for (const root of manager[kShadowRoots]) {
		for (const sheet of shadowStyleSheets(root)) {
			parseStyleSheet(manager, sheet, root);
		}
	}

	const layerRanks = rankLayers(manager);
	for (const rule of manager[kParsedRules]) {
		rule.layerRank =
			rule.layer === null ?
				manager[kUnlayeredRank] :
					(layerRanks.get(rule.layer) ?? manager[kUnlayeredRank]);
	}

	sortRulesForCascade(manager);
	manager.clearCache();
	attachPseudoElements(manager);
}

/**
 * Sort rules for cascade resolution: origin first (UA rules sort below
 * every author rule -- later wins), then cascade layer, then specificity,
 * then the order the rules were read in.
 */
function sortRulesForCascade(manager: StyleManager): void {
	const sourceOrder = new Map(
		manager[kParsedRules].map((rule, index) => [rule, index] as const),
	);
	manager[kParsedRules].sort((a, b) => {
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

/** Name a layer, and every layer its path nests inside, in declaration order. */
function declareLayer(
	manager: StyleManager,
	outer: string | null,
	name: string,
): string {
	const path = outer === null ? name : `${outer}.${name}`;
	const segments = path.split(".");
	for (let depth = 1; depth <= segments.length; depth++) {
		const prefix = segments.slice(0, depth).join(".");
		if (!manager[kLayerPaths].includes(prefix)) {
			manager[kLayerPaths].push(prefix);
		}
	}
	return path;
}

/**
 * Where each layer sorts. Layers sort in the order their names were
 * declared, and a layer's OWN rules sort after the rules of every layer
 * nested inside it -- the same relation unlayered rules have to layers,
 * one level down. Smallest first, so the last layer, and then the
 * unlayered rules above it, win the normal cascade; the important cascade
 * reads the same order backwards.
 */
function rankLayers(
	manager: StyleManager,
): Map<string, number> {
	const nested = new Map<string, string[]>();
	for (const path of manager[kLayerPaths]) {
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
	manager[kUnlayeredRank] = next;
	return ranks;
}

/**
 * Collect the style rules of a stylesheet, or of a grouping rule's own
 * rule list. A disabled sheet, and a sheet or `@media` whose condition the
 * terminal viewport does not match, contribute nothing; `@supports`
 * contributes its rules, since what this engine supports is what it
 * renders. `@font-face`, `@keyframes` and `@import` have no terminal
 * rendering and declare nothing to the cascade.
 *
 * A grouping rule this walk has no branch for is walked THROUGH: its rules
 * cascade without whatever its prelude says about them. For a conditional
 * rule that is the wrong answer where the condition is false -- a
 * `@container` query the box does not satisfy still paints -- and it is
 * the better wrong answer: a rule that applies too widely is one an author
 * can see, and one that vanishes with the whole at-rule is not.
 */
function parseStyleSheet(
	manager: StyleManager,
	container: CSSStyleSheet | CSSGroupingRule,
	scope?: Node,
	uaOrigin?: boolean,
	context: RuleContext = UNCONDITIONAL,
): void {
	if (container instanceof CSSStyleSheet) {
		if (container.disabled) {
			return;
		}
		if (!manager.mediaQueryMatches(container.media.mediaText)) {
			return;
		}
	}
	for (const rule of container.cssRules) {
		if (rule instanceof CSSStyleRule) {
			parseStyleRule(manager, rule, scope, uaOrigin, context);
		} else if (rule instanceof CSSMediaRule) {
			if (manager.mediaQueryMatches(rule.conditionText)) {
				parseStyleSheet(manager, rule, scope, uaOrigin, context);
			}
		} else if (rule instanceof CSSSupportsRule) {
			parseStyleSheet(manager, rule, scope, uaOrigin, context);
		} else if (rule instanceof CSSLayerStatementRule) {
			// `@layer a, b;` declares the order of layers whose rules come
			// later, and declares nothing else.
			for (const name of rule.nameList) {
				declareLayer(manager, context.layer, name);
			}
		} else if (rule instanceof CSSLayerBlockRule) {
			// An unnamed block opens a layer nothing else can name or reach,
			// which is a layer of its own wherever it stands.
			const layer = rule.name ?
					declareLayer(manager, context.layer, rule.name) :
					declareLayer(
						manager,
						context.layer,
						` ${manager[kAnonymousLayers]++}`,
					);
			parseStyleSheet(manager, rule, scope, uaOrigin, {...context, layer});
		} else if (rule instanceof CSSScopeRule) {
			const owner = rule.parentStyleSheet?.ownerNode ?? null;
			parseStyleSheet(manager, rule, scope, uaOrigin, {
				...context,
				scopes: [
					...context.scopes,
					{
						start: rule.start,
						end: rule.end,
						owner: owner ? owner.parentElement : null,
					},
				],
			});
		} else if (rule instanceof CSSStartingStyleRule) {
			// `@starting-style` declares the style a box starts a transition
			// FROM. This engine runs no transitions, so a rule inside it
			// would have no moment to stop applying in and would style the
			// box for good: it parses into the CSSOM and reaches the
			// cascade never.
			continue;
		} else if (rule instanceof CSSGroupingRule) {
			parseStyleSheet(manager, rule, scope, uaOrigin, context);
		}
	}
}

/**
 * One media query: the type it names, `and`-ed with its condition and
 * negated by a `not` modifier. Only `all` and `screen` name this screen --
 * the terminal viewport -- so `print`, `speech` and the media types
 * mediaqueries-4 deprecated match nothing.
 */
function mediaQueryNodeMatches(
	manager: StyleManager,
	query: MediaQueryNode,
): boolean {
	const type = (query.mediaType ?? "").toLowerCase();
	let matches = type === "" || type === "all" || type === "screen";
	if (matches && query.condition) {
		matches = mediaConditionMatches(manager, query.condition);
	}
	return (query.modifier ?? "").toLowerCase() === "not" ? !matches : matches;
}

/**
 * A media condition: the operands `and` or `or` joins, each of which a `not`
 * may negate. A word standing where neither a joiner nor a negation belongs
 * leaves the condition unjudged, and so matching.
 */
function mediaConditionMatches(
	manager: StyleManager,
	condition: MediaConditionNode,
): boolean {
	let matches: boolean | null = null;
	let disjunction = false;
	let negate = false;
	for (const part of mediaConditionParts(condition)) {
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
		let operand = mediaOperandMatches(manager, part);
		if (negate) {
			operand = !operand;
			negate = false;
		}
		matches =
			matches === null ?
				operand :
				disjunction ?
					matches || operand :
					matches && operand;
	}
	return matches ?? true;
}

/** One `<media-in-parens>`: a nested condition, a feature, or a range. */
function mediaOperandMatches(
	manager: StyleManager,
	part: MediaConditionNode,
): boolean {
	if (part.type === "Condition") {
		return mediaConditionMatches(manager, part);
	}
	if (part.type === "Feature") {
		return mediaFeatureMatches(manager, part);
	}
	if (part.type === "FeatureRange") {
		return mediaFeatureRangeMatches(manager, part);
	}
	return true;
}

/** The window length a media feature name asks about, or null for the rest. */
function viewportLength(
	manager: StyleManager,
	dimension: string,
): number | null {
	if (dimension === "width") {
		return manager[kWindow].innerWidth;
	}
	if (dimension === "height") {
		return manager[kWindow].innerHeight;
	}
	return null;
}

/**
 * A length a media feature compares against, in the cell lengths px and ch
 * both spell here. Null for a value off the grammar, which leaves the
 * feature unjudged.
 */
function mediaLength(node: CSSNode | null | undefined): number | null {
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

/** The comparison a `<mf-range>` writes between two lengths. */
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

/**
 * A `<mf-plain>` or `<mf-boolean>` feature against the terminal: the width
 * and height features, judged against the window. A feature this engine does
 * not track answers true -- the permissive default -- as does a value off
 * the grammar.
 */
function mediaFeatureMatches(
	manager: StyleManager,
	feature: MediaConditionNode,
): boolean {
	const name = (feature.name ?? "").toLowerCase();
	const value = feature.value ?? null;
	// mediaqueries-4's hover feature: `hover` when the primary pointer can
	// hover. Motion reporting turns on whenever the document observes
	// hover, so the answer is unconditional; a bare `(hover)` is the
	// boolean context.
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
		name.startsWith("min-") ?
			"min" :
			name.startsWith("max-") ?
				"max" :
				null;
	const actual = viewportLength(
		manager,
		bound === null ? name : name.slice(4),
	);
	const length = mediaLength(value);
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

/**
 * A `<mf-range>` feature: the one-sided `(width >= 40px)` and `(40px <=
 * width)`, and the two-sided `(20px <= width < 80px)`. The feature name
 * stands in the middle of a two-sided range, and opposite the value in a
 * one-sided one.
 */
function mediaFeatureRangeMatches(
	manager: StyleManager,
	range: MediaConditionNode,
): boolean {
	const named = (node: CSSNode | null | undefined): string =>
		node?.type === "Identifier" ? (node.name ?? "").toLowerCase() : "";
	if (range.right) {
		const actual = viewportLength(manager, named(range.middle));
		const low = mediaLength(range.left);
		const high = mediaLength(range.right);
		if (actual === null || low === null || high === null) {
			return true;
		}
		return (
			mediaComparison(low, range.leftComparison, actual) &&
			mediaComparison(actual, range.rightComparison, high)
		);
	}
	const leftName = named(range.left);
	const actual = viewportLength(manager, leftName || named(range.middle));
	const length = mediaLength(leftName ? range.middle : range.left);
	if (actual === null || length === null) {
		return true;
	}
	return leftName ?
			mediaComparison(actual, range.leftComparison, length) :
			mediaComparison(length, range.leftComparison, actual);
}

/**
 * Parse a single style rule and extract selector/declarations
 */
function parseStyleRule(
	manager: StyleManager,
	styleRule: CSSStyleRule,
	scope?: Node,
	uaOriginSheet?: boolean,
	context: RuleContext = UNCONDITIONAL,
): void {
	// A rule's selector list is a set of selectors that share a block, and
	// each is matched -- and weighed -- on its own. `#a::before, #b` is one
	// pseudo-element rule and one ordinary rule, not one of either.
	const block = styleRule.style.declarationBlock();
	const namespaces = sheetNamespaces(styleRule.parentStyleSheet);
	for (const selector of splitSelectorList(styleRule.selectorText)) {
		parseSelector(
			manager,
			selector,
			block,
			scope,
			uaOriginSheet,
			namespaces,
			context,
		);
	}
}

/**
 * Record the keys a change to which can reach an element's descendants.
 *
 * Two ways it can: the key is tested on a NON-SUBJECT compound, so the
 * rule matches something below the element it names; or the rule declares
 * an INHERITED property, so starting or stopping it moves a value the
 * descendants take from the element. A key in neither position changes
 * nothing but the element's own box.
 */
function indexReachingKeys(
	manager: StyleManager,
	reading: SelectorReading,
	declarations: Record<string, string>,
): void {
	let inherits = false;
	for (const property in declarations) {
		// A shorthand is stored as its longhands, so this reads longhands --
		// except `all`, which stands for every property there is.
		// `display` is not inherited and reaches them anyway: a flex
		// container blockifies its children (css-display-3 §2.7), which
		// changes what KIND of box each of them is.
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
	const last = inherits ? compounds.length : compounds.length - 1;
	for (let i = 0; i < last; i++) {
		const keys = compounds[i];
		for (const name of keys.classes) {
			manager[kReachingClasses].add(name);
		}
		for (const name of keys.ids) {
			manager[kReachingIds].add(name);
		}
		for (const name of keys.attributes) {
			manager[kReachingAttributes].add(name);
		}
		if (keys.states) {
			manager[kReachingStates] = true;
		}
	}
}

function parseSelector(
	manager: StyleManager,
	selector: string,
	block: DeclarationBlock,
	scope?: Node,
	uaOriginSheet?: boolean,
	sheetNamespaces: SelectorNamespaces = NO_NAMESPACES,
	context: RuleContext = UNCONDITIONAL,
): void {
	const {declarations, important, order} = block;
	// Opens the sticky transition gate: only a duration or delay can ever
	// make a transition run, so the property list alone does not open it.
	if (
		declarations["transition-duration"] ||
		declarations["transition-delay"]
	) {
		manager[kTransitionsExist] = true;
	}
	// A rule's layer decides where it sorts, and the whole layer order is
	// only known once every sheet has been read: the rank is filled in
	// then, and this is the value it is filled in from.
	const layer = context.layer;
	// A :has() rule reads DOWN the tree, so a mutation anywhere below its
	// subject can flip it -- the one relational direction the per-target
	// invalidation cannot see. The flag buys the ancestor sweep only for
	// documents that actually pay for it.
	if (selector.includes(":has(")) {
		manager[kHasRulesExist] = true;
	}
	if (selector.includes(":hover")) {
		manager[kHoverRulesExist] = true;
	}
	let scopes: readonly ScopeCondition[] | undefined;
	if (context.scopes.length > 0) {
		scopes = context.scopes;
		manager[kScopedRulesExist] = true;
	}
	let namespace: string | null | undefined;
	if (sheetNamespaces !== NO_NAMESPACES || selector.includes("|")) {
		const resolved = selectorNamespace(selector, sheetNamespaces);
		if (!resolved.valid) {
			return;
		}
		selector = resolved.selector;
		namespace = resolved.namespace;
	}
	if (selector.includes("+") || selector.includes("~")) {
		manager[kSelectorsReachSiblings] = true;
	}
	if (selector.includes(":has")) {
		manager[kSelectorsReachAncestors] = true;
	}
	const reading = readSelector(selector);
	indexReachingKeys(manager, reading, declarations);
	if (
		declarations["counter-reset"] ||
		declarations["counter-increment"] ||
		declarations["content"]?.includes("counter")
	) {
		manager[kCounterRulesExist] = true;
	}
	if (declarations["display"] === "list-item") {
		manager[kListItemRulesExist] = true;
	}
	const specificity = reading.specificity;
	const uaOrigin = Boolean(
		uaOriginSheet || (scope != null && isUAShadowRoot(scope)),
	);

	// :host selectors only mean anything inside a shadow tree's own
	// stylesheet; the selector engine rejects them outright, so they parse
	// into a structured predicate matched by kRuleMatches instead.
	const subjectTag = reading.subjectTag;

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
			manager[kParsedRules].push({
				selector,
				declarations,
				important,
				order,
				specificity,
				scope,
				host: {predicate, rest, child: Boolean(child)},
				uaOrigin,
				layer,
				layerRank: 0,
				scopes,
			});
			return;
		}
	}

	// Check if this is a pseudo-element rule. ::placeholder/::selection
	// are widget-part pseudos: no content node ever attaches for them --
	// they resolve onto the UA shadow tree's [part] elements (see
	// kGetMatchingRules) or the selection painter.
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
			subjectTag: reading.subjectTag,
			declarations,
			important,
			order,
			specificity,
			pseudoElement,
			scope,
			uaOrigin,
			namespace,
			layer,
			layerRank: 0,
			scopes,
		};
		manager[kParsedRules].push(rule);
		const byType = manager[kPseudoRulesByType].get(pseudoElement);
		if (byType) {
			byType.push(rule);
		} else {
			manager[kPseudoRulesByType].set(pseudoElement, [rule]);
		}
	} else {
		manager[kParsedRules].push({
			selector,
			subjectTag,
			declarations,
			important,
			order,
			specificity,
			scope,
			uaOrigin,
			namespace,
			layer,
			layerRank: 0,
			scopes,
		});
	}
}

/**
 * Get matching CSS rules for an element
 */
function getMatchingRules(
	manager: StyleManager,
	element: Element,
): ParsedCSSRule[] {
	// A UA shadow part IS the element its part pseudo styles: the host's
	// ::placeholder rules cascade directly onto the [part="placeholder"]
	// span, the way a browser resolves ::placeholder onto its input's
	// internal placeholder element.
	const partPseudo = partPseudoFor(manager, element);
	const root = element.getRootNode();
	const rootNode = root as unknown as Node;
	const shadowHost =
		root.nodeType === 11 ? ((root as ShadowRoot).host ?? null) : null;
	const partNames = (element.getAttribute("part") ?? "")
		.split(/\s+/)
		.filter(Boolean);
	const matched = manager[kParsedRules].filter((rule) => {
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
					ruleMatches(manager, shadowHost, rule)
				);
			}
			// ::placeholder / ::selection: UA-part pseudo aliases.
			return (
				partPseudo !== null &&
				shadowHost !== null &&
				rule.pseudoElement === partPseudo &&
				ruleMatches(manager, shadowHost, rule)
			);
		}
		return ruleMatches(manager, element, rule, rootNode);
	});
	// Scope proximity sorts between specificity and order of appearance
	// (css-cascade-6 §3.1.3), and unlike either it is a fact about THIS
	// element: the closer scoping root wins, and a rule in no scope at all
	// is infinitely far from one. The rules arrive in cascade order and
	// the sort is stable, so a comparison that only answers for proximity
	// leaves every other tier as it found it.
	if (!manager[kScopedRulesExist]) {
		return matched;
	}
	const proximity = new Map(
		matched.map(
			(rule) =>
				[
					rule,
					rule.scopes ? scopeProximity(manager, element, rule) : UNSCOPED,
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

/**
 * Whether an element matches one of a rule's selectors. A scoped rule's
 * selector is written relative to a scoping root and reaches only the
 * elements that root has in scope; every other rule's is matched by the
 * DOM outright.
 */
function matchesRule(
	manager: StyleManager,
	element: Element,
	rule: ParsedCSSRule,
	selector: string,
): boolean {
	if (!rule.scopes) {
		return element.matches(selector);
	}
	return scopingRoot(manager, element, {...rule, selector}) !== null;
}

/**
 * How many generations lie between an element and the nearest scoping root
 * its rule applies from, or Infinity when the rule names no scope. Only
 * ever asked of a rule that matches, so a rule out of scope everywhere has
 * already been filtered out.
 */
function scopeProximity(
	manager: StyleManager,
	element: Element,
	rule: ParsedCSSRule,
): number {
	const root = scopingRoot(manager, element, rule);
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

/**
 * The scoping root a scoped rule reaches this element from, or null when
 * no chain of roots puts the element in the rule's scope and matches its
 * selector.
 *
 * Every root is an inclusive ancestor of the element -- that is what being
 * in scope means -- so the chain is read outermost first, each condition
 * taking the HIGHEST root it can (which constrains the roots inside it
 * least), and the innermost taking the NEAREST, which is the one the
 * element's selector and its proximity are measured from.
 */
function scopingRoot(
	manager: StyleManager,
	element: Element,
	rule: ParsedCSSRule,
): Element | null {
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
			if (!scopeRootMatches(candidate, condition, outer)) {
				continue;
			}
			if (!inScopeOf(element, candidate, condition)) {
				continue;
			}
			if (innermost) {
				if (!matchesInScope(element, rule.selector, candidate)) {
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

/**
 * The part pseudo-element a UA shadow part element answers to, if any:
 * "::placeholder" for the [part="placeholder"] span of an input's
 * UA-internal tree. Author shadow trees are not eligible -- their parts
 * are theirs to style from inside.
 */
function partPseudoFor(
	manager: StyleManager,
	element: Element,
): string | null {
	const root = element.getRootNode();
	if (isUAShadowRoot(root)) {
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
function ruleMatches(
	manager: StyleManager,
	element: Element,
	rule: ParsedCSSRule,
	elementRoot?: Node,
): boolean {
	// Every rule is tried against every element, so the rejects that cost a
	// comparison come first. A scoped rule from another tree can never
	// match: one identity check retires a widget's whole sheet for every
	// element outside it.
	if (
		rule.scope !== undefined &&
		rule.host === undefined &&
		rule.scope !== (elementRoot ?? element.getRootNode())
	) {
		return false;
	}
	// The subject's type, when the selector names one: this reject costs a
	// string comparison instead of a selector match. A :host rule's subject
	// is the host, which the branch below resolves for itself.
	if (rule.subjectTag !== undefined && rule.host === undefined) {
		const local = element.localName;
		// A foreign element's local name keeps its case (feGaussianBlur), and
		// the tag here is lowercased, so the reject only fires when neither
		// reading matches -- the case-sensitivity a selector really has is
		// then the matcher's to decide.
		if (
			local !== rule.subjectTag &&
			local.toLowerCase() !== rule.subjectTag
		) {
			return false;
		}
	}
	try {
		// The namespace the selector qualifies its subject with, which the
		// DOM's own matcher cannot answer.
		if (
			rule.namespace !== undefined &&
			element.namespaceURI !== rule.namespace
		) {
			return false;
		}
		// The selector engine treats `:focus-visible` as `:focus`, so gate it
		// on our own flag.
		if (
			!manager[kFocusVisibleActive] &&
			rule.selector.includes(":focus-visible")
		) {
			return false;
		}
		if (rule.host) {
			const scope = rule.scope as ShadowRoot;
			const host = scope.host;
			if (!host) {
				return false;
			}
			const {predicate, rest, child} = rule.host;
			if (predicate && !host.matches(predicate)) {
				return false;
			}
			if (!rest) {
				return element === host;
			}
			if (element.getRootNode() !== scope) {
				return false;
			}
			if (!element.matches(rest)) {
				return false;
			}
			return child ? element.parentNode === scope : true;
		}
		const root = elementRoot ?? element.getRootNode();
		if (rule.scope) {
			return (
				root === rule.scope &&
				matchesRule(manager, element, rule, rule.selector)
			);
		}
		// UA document rules apply in EVERY tree scope, as a browser's own
		// UA sheet styles shadow trees.
		if (rule.uaOrigin) {
			return matchesRule(manager, element, rule, rule.selector);
		}
		// AUTHOR document rules match everything OUTSIDE shadow trees --
		// including detached elements (styles resolve before insertion,
		// and always have here); the boundary they must not cross is the
		// shadow root.
		const inShadowTree =
			root.nodeType === 11 && Boolean((root as ShadowRoot).host);
		return !inShadowTree && matchesRule(manager, element, rule, rule.selector);
	} catch (err) {
		// Fallback for unsupported selectors
		return false;
	}
}

/**
 * Compute style properties for a pseudo-element
 */
function computePseudoElementStyle(
	manager: StyleManager,
	element: Element,
	pseudoElement: string,
): Record<string, string> {
	const pseudoRoot = element.getRootNode() as unknown as Node;
	const matchingRules = manager[kParsedRules].filter((rule) => {
		if (rule.pseudoElement !== pseudoElement) {
			return false;
		}
		return ruleMatches(manager, element, rule, pseudoRoot);
	});

	// Apply rules in cascade order. A pseudo-element's declarations are a
	// flat record rather than a per-property cascade, so a flow-relative
	// declaration fills BOTH names of its slot as it lands: the physical
	// one everything downstream reads, and its own, which a later rule
	// declaring either name overwrites in turn.
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
			direction ??= manager
				.declarationFor(element)
				.computedValueOf("direction");
			for (const other of slotNames(name, direction)) {
				computedStyle[other] = value;
			}
		}
	}

	return computedStyle;
}

/**
 * The text a pseudo-element holds, or null when it holds none -- no rule
 * declared `content`, or the one that did declared `none`.
 */
function pseudoContentFor(
	manager: StyleManager,
	hostElement: Element,
	pseudoType: string,
): string | null {
	const styles = computePseudoElementStyle(manager, hostElement, pseudoType);
	let content = styles.content;

	// For ::marker pseudo-elements, generate default content if none specified
	if (pseudoType === "::marker") {
		const computedStyle = manager.declarationFor(hostElement);
		const display = computedStyle.computedValueOf("display");

		if (display === "list-item") {
			// Check if explicitly set to outside positioning
			const listStylePosition =
				computedStyle.computedValueOf("list-style-position") || "outside";

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
	const textContent = unquoteContent(content);

	// Resolve counter() functions in the content
	return manager.resolveCounterFunction(hostElement, textContent);
}

/**
 * Bring the document's pseudo-element nodes into line with the rules just
 * parsed: the ones a rule now reaches gain a node, the ones no rule
 * reaches lose theirs.
 */
function attachPseudoElements(
	manager: StyleManager,
): void {
	// Re-evaluate existing pseudos IDENTITY-PRESERVINGLY -- never clear
	// wholesale: layout keys a pseudo's boxes by node instance, and a
	// fresh node per refresh strands every mapped one. Attach handles
	// content updates in place and removal when a pseudo stops matching.
	// Walks every element on stylesheet change.
	if (!manager[kDocument].documentElement) {
		return;
	}
	const walker = manager[kDocument].createTreeWalker(
		manager[kDocument].documentElement,
		manager[kWindow].NodeFilter.SHOW_ELEMENT,
		null,
	);
	let element = walker.nextNode() as Element;
	while (element) {
		if (pseudoElementCount(element) > 0) {
			manager.attachPseudoElementsToElement(element);
		}
		element = walker.nextNode() as Element;
	}

	manager.attachPseudoElementsToDocument();
}

function pseudoSubjects(
	manager: StyleManager,
): Set<string> | null {
	if (manager[kPseudoSubjectTags] !== undefined) {
		return manager[kPseudoSubjectTags];
	}
	if (manager[kCounterRulesExist] || manager[kListItemRulesExist]) {
		return (manager[kPseudoSubjectTags] = null);
	}
	// A list carries the one counter no rule declares, and its items the
	// markers that counter numbers.
	const tags = new Set(["OL", "UL", "LI"]);
	// Only the pseudos this attaches: ::marker reaches list items, named
	// above, and ::placeholder, ::selection and ::part live on nodes the
	// widget trees already hold.
	for (const type of ["::before", "::after"]) {
		for (const rule of manager[kPseudoRulesByType].get(type) ?? []) {
			if (!rule.subjectTag) {
				return (manager[kPseudoSubjectTags] = null);
			}
			tags.add(rule.subjectTag.toUpperCase());
		}
	}
	return (manager[kPseudoSubjectTags] = tags);
}

/**
 * Could any parsed rule give this element a pseudo of this type? A few
 * matches() calls against only the rules that declare the pseudo --
 * instead of building the full pseudo style declaration per element per
 * type just to discover `content` is "none". Over-matching is safe (the
 * full path still decides); the win is the early false for the common
 * document with no pseudo rules beyond the UA button brackets.
 */
function pseudoRuleCouldMatch(
	manager: StyleManager,
	element: Element,
	pseudoType: string,
): boolean {
	if (pseudoType === "::marker") {
		// Markers exist only on display:list-item boxes: an <li>, a rule
		// declaring it, or an inline style. Nothing else needs the
		// computed-display check below.
		return (
			element.tagName === "LI" ||
			manager[kListItemRulesExist] ||
			(element.getAttribute("style") ?? "").includes("list-item")
		);
	}
	const rules = manager[kPseudoRulesByType].get(pseudoType);
	if (!rules) {
		return false;
	}
	for (const rule of rules) {
		try {
			if (element.matches(rule.selector)) {
				return true;
			}
		} catch (_err) {
			return true;
		}
	}
	return false;
}

/**
 * Attach a specific pseudo-element type to an element if it should have one
 */
function attachPseudoElementToElementForType(
	manager: StyleManager,
	element: Element,
	pseudoType: string,
): void {
	// No rule can apply and none is attached: skip the counter and style
	// computations wholesale. (An attached pseudo still takes the full
	// path so a rule that STOPPED matching removes it.)
	if (
		!pseudoRuleCouldMatch(manager, element, pseudoType) &&
		!pseudoElement(element, pseudoType)
	) {
		return;
	}

	// Initialize counters for this element first (needed for counter() functions)
	manager.initializeCounters(element);

	// Skip ::marker for elements without display: list-item or with outside positioning
	if (pseudoType === "::marker") {
		const computedStyle = manager.declarationFor(element);
		const display = computedStyle.computedValueOf("display");
		const listStylePosition =
			computedStyle.computedValueOf("list-style-position") || "outside";

		if (display !== "list-item") {
			return;
		}

		// Remove inline markers for outside positioning
		if (listStylePosition === "outside") {
			removePseudoElement(manager, element, "::marker");
			return;
		}
	}

	// Compute what the pseudo should hold now; null means "none".
	const content = manager.shouldCreatePseudoElement(element, pseudoType) ?
			pseudoContentFor(manager, element, pseudoType) :
		null;
	const existing = pseudoElement<Element>(element, pseudoType);

	// Pseudo NODE IDENTITY is stable: attaches re-run on every element
	// addition and attribute invalidation, and layout keys the pseudo's
	// boxes by instance -- a fresh node per attach strands the mapped one
	// (an absolutely positioned button's ::after glyph simply vanished).
	// The slot keeps the node; only its text changes.
	if (content === null) {
		if (existing) {
			removePseudoElement(manager, element, pseudoType);
		}
		return;
	}
	if (existing) {
		const text = existing.firstChild as Text;
		if (text.data !== content) {
			text.data = content;
			manager[kLayoutEngine]?.invalidate(element);
		}
		return;
	}
	const node = ensurePseudoElement<Element>(element, pseudoType);
	node.appendChild(element.ownerDocument.createTextNode(content));
	manager[kLayoutEngine]?.invalidateStructure();
	manager[kLayoutEngine]?.invalidate(element);
}

/** Drop an element's pseudo-element node, and the boxes it held. */
function removePseudoElement(
	manager: StyleManager,
	element: Element,
	pseudoType: string,
): void {
	if (!pseudoElement(element, pseudoType)) {
		return;
	}
	clearPseudoElement(element, pseudoType);
	manager[kLayoutEngine]?.invalidateStructure();
	manager[kLayoutEngine]?.invalidate(element);
}

function setupInvalidationHooks(
	manager: StyleManager,
): void {
	// An error thrown out of a constructed sheet is this realm's own.
	cssomWindow = manager[kWindow];
	Object.assign(manager[kWindow], CSSOM_WINDOW_GLOBALS);
}

/** The CSSOM interfaces a window exposes as globals. */
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

/**
 * `[ <custom-ident> <integer>? ]+`: each identifier opens a pair, a number
 * that follows it sets the count, and a counter written without one takes
 * `fallback` -- 0 for a reset, 1 for an increment.
 */
function counterPairs(
	value: string,
	fallback: number,
): Array<[string, number]> {
	const pairs: Array<[string, number]> = [];
	const nodes = cssValueChildren(value);
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

/**
 * Parse counter-reset CSS property
 */
function parseCounterReset(
	manager: StyleManager,
	scope: CounterScope,
	counterReset: string,
): void {
	for (const [name, value] of counterPairs(counterReset, 0)) {
		scope.counters[name] = value;
	}
}

/**
 * Parse counter-increment CSS property
 */
function parseCounterIncrement(
	manager: StyleManager,
	scope: CounterScope,
	counterIncrement: string,
): void {
	for (const [name, increment] of counterPairs(counterIncrement, 1)) {
		incrementCounter(manager, scope, name, increment);
	}
}

/**
 * Increment a counter by a specific amount
 */
function incrementCounter(
	manager: StyleManager,
	scope: CounterScope,
	counterName: string,
	increment: number,
): void {
	// For list-item counters, we need to check previous siblings for the most recent value
	if (counterName === "list-item" && scope.element.tagName === "LI") {
		const currentValue = getListItemCounterValue(manager, scope.element);
		scope.counters[counterName] = currentValue + increment;
	} else {
		// For other counters, get value from parent scopes
		const currentValue = getCounterValueFromScope(
			manager,
			scope.parent,
			counterName,
		);
		scope.counters[counterName] = currentValue + increment;
	}
}

/**
 * Get the current list-item counter value by checking previous siblings
 */
function getListItemCounterValue(
	manager: StyleManager,
	element: Element,
): number {
	// Find the parent OL/UL that establishes the counter scope
	let parent = element.parentElement;
	while (parent && parent.tagName !== "OL" && parent.tagName !== "UL") {
		parent = parent.parentElement;
	}

	if (!parent) {
		return 0;
	}

	// Get the reset value from the OL/UL
	const parentScope = manager[kCounterScopes].get(parent);
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
function getCounterValueFromScope(
	manager: StyleManager,
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

/**
 * A counter's value in the counter style `counter()` named. A bullet style
 * names a glyph and ignores the value; everything else is the ordinal a list
 * marker of the same style would show, so `counter(x, lower-alpha)` and
 * `list-style-type: lower-alpha` agree at every value.
 */
function formatCounterValue(value: number, style: string): string {
	return BULLET_MARKERS[style] ?? formatOrdinal(value, style);
}

// ---------------------------------------------------------------------------
// The cascade's half of the DOM interfaces, defined on the DOM's own
// prototypes once, at load: `element.style`, `document.styleSheets`,
// `adoptedStyleSheets`, and the `sheet` accessors.
// ---------------------------------------------------------------------------

for (const prototype of [DOMHTMLElement.prototype, DOMSVGElement.prototype]) {
	Object.defineProperty(prototype, "style", {
		get(this: Element) {
			let style = inlineStyles.get(this);
			if (!style) {
				style = new CSSStyleProperties({element: this});
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

for (const prototype of [DOMDocumentClass.prototype, DOMShadowRoot.prototype]) {
	Object.defineProperty(prototype, "styleSheets", {
		get(this: Document | ShadowRoot) {
			const sheets = declaredStyleSheets(this);
			const list = new StyleSheetList(sheets);
			syncIndexed(list);
			return list;
		},
		configurable: true,
		enumerable: true,
	});
	Object.defineProperty(prototype, "adoptedStyleSheets", {
		get(this: Node) {
			let list = adoptedSheets.get(this);
			if (!list) {
				adoptedSheets.set(this, (list = []));
			}
			return observableAdopted(this, list);
		},
		set(this: Node, sheets: unknown) {
			adopt(this, sheets);
			managerForTree(this)?.refreshStylesheets();
		},
		configurable: true,
		enumerable: true,
	});
}

Object.defineProperty(DOMHTMLStyleElement.prototype, "sheet", {
	get(this: Element) {
		// A style element outside a tree has no sheet, as in a browser.
		return this.parentNode ? sheetFor(this) : null;
	},
	configurable: true,
	enumerable: true,
});

// Nothing is fetched over a terminal's document, so a link never resolves to
// a sheet.
Object.defineProperty(DOMHTMLLinkElement.prototype, "sheet", {
	get() {
		return null;
	},
	configurable: true,
	enumerable: true,
});

// The cascade is the realm's style engine: it hears the DOM's own change
// algorithms, so classList, className and the parser invalidate as
// setAttribute does, and a declarative shadow root registers the moment the
// parser attaches it.
observeTree({
	attributeChanged(element, localName) {
		if (
			localName === "style" ||
			localName === "class" ||
			localName === "id"
		) {
			documentManagers
				.get(element.ownerDocument as object)
				?.invalidateElement(element as unknown as Element);
		}
	},
	shadowAttached(root) {
		documentManagers
			.get((root.host as unknown as Element).ownerDocument as object)
			?.registerShadowRoot(root as unknown as ShadowRoot);
	},
});

// ---------------------------------------------------------------------------
// Grid values (css-grid-2 §7, §8)
//
// The compute core takes track lists, area maps and placements already parsed,
// so this is where CSS text becomes them. css-tree does the tokenizing: a
// track list nests functions, bracketed line names and strings, and a
// hand-rolled splitter gets one of those wrong sooner or later.
//
// Two values are REFUSED rather than approximated. `subgrid` (css-grid-2 §9.5)
// takes its tracks from an ancestor grid, which means a grid's own sizing can
// no longer be decided from its own box; `masonry` (css-grid-3) is not a grid
// in its second axis at all. A track list naming either is invalid here, and
// the property falls back to `none` -- the same answer a browser that does not
// implement them gives.
// ---------------------------------------------------------------------------

/** The refused grid values, kept together so the refusal is one list. */
const REFUSED_GRID_VALUES = new Set(["subgrid", "masonry"]);

/** A length token in cells: px and ch both measure one cell, and nothing else does. */
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

function pointBreadth(cells: number): FlexTypes.TrackBreadth {
	return {kind: "length", value: {unit: Flex.UNIT_POINT, value: cells}};
}

function percentBreadth(percentage: number): FlexTypes.TrackBreadth {
	return {kind: "length", value: {unit: Flex.UNIT_PERCENT, value: percentage}};
}

/** One `<track-breadth>`: a length, a percentage, an `fr`, or an intrinsic keyword. */
function parseTrackBreadth(node: CSSNode): FlexTypes.TrackBreadth | null {
	if (node.type === "Dimension" && (node.unit ?? "").toLowerCase() === "fr") {
		const factor = parseFloat(node.value ?? "");
		return Number.isFinite(factor) && factor >= 0 ?
				{kind: "flex", factor} :
			null;
	}
	const cells = trackCells(node);
	if (cells !== null) {
		return pointBreadth(cells);
	}
	if (node.type === "Percentage") {
		const percentage = parseFloat(node.value ?? "");
		return Number.isFinite(percentage) ? percentBreadth(percentage) : null;
	}
	if (node.type === "Number" && parseFloat(node.value ?? "") === 0) {
		return pointBreadth(0);
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

/** One `<track-size>`: a breadth, a `minmax()` pair, or a `fit-content()` clamp. */
function parseTrackSize(node: CSSNode): FlexTypes.TrackSize | null {
	if (node.type === "Function") {
		const name = (node.name ?? "").toLowerCase();
		const args = functionArguments(node);
		if (name === "minmax") {
			if (args.length !== 2) {
				return null;
			}
			const min = parseTrackBreadth(args[0]);
			const max = parseTrackBreadth(args[1]);
			// An `fr` is a share of leftover space, which is not a minimum
			// anything can be measured against: the grammar excludes it.
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
	// A bare `<flex>` is minmax(auto, <flex>); every other bare breadth is
	// both ends of the pair.
	if (breadth.kind === "flex") {
		return {min: {kind: "auto"}, max: breadth};
	}
	return {min: breadth, max: breadth};
}

/** The identifiers inside a `[a b]` line-name group. */
function bracketNames(node: CSSNode): string[] {
	return (node.children?.toArray() ?? [])
		.filter((child) => child.type === "Identifier")
		.map((child) => child.name ?? "");
}

/** A `<track-list>`, or null when the value is not one (and so has no effect). */
export function parseTrackList(value: string): FlexTypes.TrackList | null {
	const text = value.trim();
	if (!text || text === "none") {
		return null;
	}
	if (REFUSED_GRID_VALUES.has(text.toLowerCase())) {
		return null;
	}
	const children = cssValueChildren(text);
	if (!children) {
		return null;
	}

	const parts: FlexTypes.TrackListPart[] = [];
	let names: string[] = [];

	for (const node of children) {
		if (node.type === "Brackets") {
			names = names.concat(bracketNames(node));
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

function parseTrackRepeat(node: CSSNode): FlexTypes.TrackRepeat | null {
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
		// count would be paid for in tracks nobody can see.
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

	const tracks: FlexTypes.TrackListTrack[] = [];
	let names: string[] = [];
	for (const child of args.slice(1)) {
		if (child.type === "Brackets") {
			names = names.concat(bracketNames(child));
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
): FlexTypes.TrackSize[] | null {
	const text = value.trim();
	if (!text || text === "auto") {
		return null;
	}
	const children = cssValueChildren(text);
	if (!children) {
		return null;
	}
	const sizes: FlexTypes.TrackSize[] = [];
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
 * `grid-template-areas`: rows of names, one string per row. The map is invalid
 * -- and so declares nothing -- unless every row states the same number of
 * cells and every named area is a solid rectangle (css-grid-2 §7.3).
 */
export function parseGridAreas(value: string): FlexTypes.GridAreaMap | null {
	const text = value.trim();
	if (!text || text === "none") {
		return null;
	}
	const children = cssValueChildren(text);
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
			// A run of dots is one null cell, however many dots it is written with.
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

	// Every area is a rectangle, fully filled: `"a b a"` names no area at all.
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
): FlexTypes.GridPlacement | null {
	const text = value.trim();
	if (!text || text === "auto") {
		return null;
	}
	const children = cssValueChildren(text);
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
