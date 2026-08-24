/**
 * The value-text boundary: raw CSS value text in, parsed nodes or canonical
 * text out. css-tree does the reading; the CSSOM spelling rules do the
 * writing, and the tokenizer below is what writes them -- css-tree generates
 * its own spellings, which are not the ones the object model answers with.
 *
 * Nothing here knows what a property means. The cascade decides that from
 * what this module hands back.
 */

import * as CSSTree from "css-tree";

/**
 * The node shapes css-tree parses a declaration value into: the form raw
 * value text takes before the engine interprets it.
 */
export type CSSNode = {
	type: string;
	name?: string;
	value?: string;
	unit?: string;
	children?: {toArray(): CSSNode[]};
};

/**
 * Parsed value ASTs by their source text. Value parsing runs inside style
 * computation, and a document re-reads its handful of spellings, so the
 * bounded cache holds one parse per spelling.
 */
const valueNodes = new Map<string, CSSNode[] | null>();

/** A value's top-level nodes, or null for text css-tree refuses. */
export function cssValueChildren(value: string): CSSNode[] | null {
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

/**
 * Keep value nodes a sheet parse already built. Only a value whose canonical
 * spelling is the authored spelling may seed the cache: for it, the sheet's
 * parse is the parse cssValueChildren would run on the cached key.
 */
export function seedValueNodes(value: string, nodes: CSSNode[]): void {
	if (valueNodes.has(value)) {
		return;
	}
	if (valueNodes.size > 1024) {
		valueNodes.clear();
	}
	valueNodes.set(value, nodes);
}

/** The one node a value holds, or undefined for none or several. */
export function singleValueNode(value: string): CSSNode | undefined {
	const nodes = cssValueChildren(value);
	return nodes && nodes.length === 1 ? nodes[0] : undefined;
}

/** The arguments of a function node, with the comma operators dropped. */
export function functionArguments(node: CSSNode): CSSNode[] {
	return (node.children?.toArray() ?? []).filter(
		(child) => child.type !== "Operator",
	);
}

/** The milliseconds a `<time>` token spells, or null for anything else. */
export function cssTimeMs(token: string): number | null {
	const node = singleValueNode(token.trim());
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

/**
 * A value's top-level components. Whitespace INSIDE parentheses separates a
 * function's own arguments, not components: `rgb(95, 175, 255)` is one color,
 * however many spaces it carries.
 */
export function splitComponents(value: string): string[] {
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

/** Split a comma-separated value list, leaving function arguments whole. */
export function splitCommaList(value: string): string[] {
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

/** The keywords every property accepts, whatever its own grammar. */
export const CSS_WIDE_KEYWORDS = new Set([
	"inherit",
	"initial",
	"revert",
	"revert-layer",
	"unset",
]);

/**
 * A declared value in its CSSOM spelling: comments removed, runs of whitespace
 * collapsed to one space, no space inside a function's parentheses except the
 * single space that follows each comma. Strings pass through as authored.
 *
 * `property` names the property the value is declared on, and its grammar
 * decides the rest: a custom property is a stream of tokens and keeps every
 * number as it was written, a family name that spells a run of identifiers
 * drops its quotes, and a counter() naming the style every counter already
 * has drops the argument.
 */
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
			// A url() token's body is not an identifier list: it runs to the
			// closing parenthesis, quoted or not, and serializes quoted.
			if (name.toLowerCase() === "url" && input[i] === "(") {
				const end = input.indexOf(")", i);
				const body = input.slice(i + 1, end === -1 ? input.length : end).trim();
				const url =
					body.startsWith('"') || body.startsWith("'") ?
							unescapeCSSString(body.slice(1, -1)) :
							unescapeCSSString(body);
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

/**
 * A family name is a sequence of identifiers or a string, and the two spell
 * one name: `"Twisty Tie"` and `Twisty Tie` are the same family. The
 * identifier spelling is the canonical one, so a string that spells a valid
 * sequence loses its quotes.
 */
const FAMILY_IDENTIFIERS =
	/^[a-zA-Z_\u0080-\uffff-][\w\u0080-\uffff-]*(?: [a-zA-Z_\u0080-\uffff-][\w\u0080-\uffff-]*)*$/;

/** The properties whose value may name a font family. */
const FAMILY_PROPERTIES = new Set(["font", "font-family", "voice-family"]);

/**
 * The family names that name no family: the generic families and the reserved
 * words a font-family list may not spell as identifiers. Quoted, each names a
 * family of that name, so the quotes are what distinguishes it and it keeps
 * them.
 */
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

/** The counter style a `counter()` or `counters()` takes when told none. */
const DEFAULT_COUNTER_STYLE = "decimal";

/**
 * The property-specific half of value serialization: what a value's own
 * grammar says its canonical spelling is, once tokenization has given every
 * value a uniform one.
 */
function canonicalizeValue(property: string, value: string): string {
	let out = value;
	if (FAMILY_PROPERTIES.has(property)) {
		out = out.replace(/"((?:[^"\\]|\\.)*)"/g, (quoted, body: string) => {
			const name = unescapeCSSString(body);
			const lower = name.toLowerCase();
			return FAMILY_IDENTIFIERS.test(name) &&
				!CSS_WIDE_KEYWORDS.has(lower) &&
				!RESERVED_FAMILY_NAMES.has(lower) ?
				name :
				quoted;
		});
	}
	// `counter(name, decimal)` counts what `counter(name)` counts, and the
	// shorter spelling is the one CSSOM writes.
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

export const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

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
	if (!Number.isFinite(value)) {
		return text;
	}
	if (Object.is(value, -0)) {
		return "0";
	}
	const out = String(value);
	return out.includes("e") ? expandExponential(out) : out;
}

/**
 * A number written in base ten, however large or small: CSS has no scientific
 * notation, so `1e24` is written with its twenty-four zeros.
 */
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
