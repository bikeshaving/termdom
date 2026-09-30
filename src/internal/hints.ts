// HTML's presentational hints (HTML §15, Rendering): the style an
// element's legacy attributes give it. They enter the cascade as author
// declarations of zero specificity ahead of every author rule, so any
// rule an author writes outranks them. A pixel here is a cell, as it is
// everywhere else in this engine.
import {CSS_NAMED_COLORS} from "../generated/cssproperties.ts";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

type Hints = Record<string, string>;

const EDGES = ["top", "right", "bottom", "left"] as const;

// The rules for parsing a legacy colour value (HTML §2.3.6).
export function parseLegacyColor(value: string | null): string | null {
	if (value === null) {
		return null;
	}
	let input = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
	if (input === "" || input.toLowerCase() === "transparent") {
		return null;
	}
	const named = CSS_NAMED_COLORS[input.toLowerCase()];
	if (named !== undefined) {
		return toRGB((named >> 16) & 0xff, (named >> 8) & 0xff, named & 0xff);
	}
	if (/^#[0-9a-f]{3}$/i.test(input)) {
		const [r, g, b] = [...input.slice(1)].map((digit) =>
			parseInt(digit, 16) * 17,
		);
		return toRGB(r, g, b);
	}
	input = Array.from(input, (character) =>
		character.codePointAt(0)! > 0xffff ? "00" : character,
	).join("");
	input = input.slice(0, 128);
	if (input.startsWith("#")) {
		input = input.slice(1);
	}
	input = input.replace(/[^0-9a-f]/gi, "0");
	while (input.length === 0 || input.length % 3 !== 0) {
		input += "0";
	}
	let length = input.length / 3;
	let components = [0, 1, 2].map((i) =>
		input.slice(i * length, (i + 1) * length),
	);
	if (length > 8) {
		components = components.map((component) => component.slice(-8));
		length = 8;
	}
	while (length > 2 && components.every((component) => component[0] === "0")) {
		components = components.map((component) => component.slice(1));
		length--;
	}
	if (length > 2) {
		components = components.map((component) => component.slice(0, 2));
	}
	const [r, g, b] = components.map((component) => parseInt(component, 16));
	return toRGB(r, g, b);
}

function toRGB(r: number, g: number, b: number): string {
	return `rgb(${r}, ${g}, ${b})`;
}

// The rules for parsing dimension values (HTML §2.3.4.4): a length in
// pixels, or a percentage.
export function parseDimension(
	value: string | null,
	nonzero = false,
): string | null {
	if (value === null) {
		return null;
	}
	const match = /^[\t\n\f\r ]*(\d+(?:\.\d+)?|\.\d+)(%?)/.exec(value);
	if (match === null) {
		return null;
	}
	const number = parseFloat(match[1]);
	if (nonzero && number === 0) {
		return null;
	}
	return match[2] === "%" ? `${number}%` : `${number}px`;
}

// The rules for parsing non-negative integers (HTML §2.3.4.2), as pixels.
export function parsePixels(value: string | null): string | null {
	if (value === null) {
		return null;
	}
	const match = /^[\t\n\f\r ]*\+?(\d+)/.exec(value);
	return match === null ? null : `${parseInt(match[1], 10)}px`;
}

function setColor(hints: Hints, property: string, value: string | null): void {
	const color = parseLegacyColor(value);
	if (color !== null) {
		hints[property] = color;
	}
}

function setDimension(
	hints: Hints,
	property: string,
	value: string | null,
	nonzero = false,
): void {
	const length = parseDimension(value, nonzero);
	if (length !== null) {
		hints[property] = length;
	}
}

function setEdges(hints: Hints, property: string, value: string): void {
	for (const edge of EDGES) {
		hints[property.replace("*", edge)] = value;
	}
}

// §15.3.3 and §15.3.8: align on block and table parts aligns the text
// and the block-level boxes inside, which browsers spell as the legacy
// text-align values.
const ALIGNMENTS: Record<string, string> = {
	left: "-webkit-left",
	right: "-webkit-right",
	center: "-webkit-center",
	middle: "-webkit-center",
	justify: "justify",
};

const ALIGNED_BLOCKS = new Set([
	"div",
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"caption",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
]);

const VERTICAL_ALIGNMENTS: Record<string, string> = {
	top: "top",
	middle: "middle",
	center: "middle",
	bottom: "bottom",
	baseline: "baseline",
};

const LIST_TYPES: Record<string, string> = {
	1: "decimal",
	a: "lower-alpha",
	A: "upper-alpha",
	i: "lower-roman",
	I: "upper-roman",
	disc: "disc",
	circle: "circle",
	square: "square",
	none: "none",
};

const TABLE_PARTS = new Set([
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
]);

const EMBEDDED = new Set(["img", "embed", "object", "iframe", "video"]);

// The table a cell belongs to: a row's parent, or the parent of a row
// group holding the row.
function getCellTable(cell: Element): Element | null {
	const row = cell.parentElement;
	if (row?.localName !== "tr") {
		return null;
	}
	const parent = row.parentElement;
	if (parent?.localName === "table") {
		return parent;
	}
	const table = parent?.parentElement ?? null;
	return table?.localName === "table" ? table : null;
}

function isLink(element: Element): boolean {
	return (
		(element.localName === "a" || element.localName === "area") &&
		element.hasAttribute("href")
	);
}

/** The declarations an element's attributes give it, or null for none. */
export function getPresentationalHints(element: Element): Hints | null {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return null;
	}
	const name = element.localName;
	const get = (attribute: string): string | null =>
		element.getAttribute(attribute);
	const hints: Hints = {};

	if (TABLE_PARTS.has(name) || name === "body") {
		setColor(hints, "background-color", get("bgcolor"));
	}

	if (name === "body") {
		setColor(hints, "color", get("text"));
		for (const [attribute, edges] of [
			["marginheight", ["top", "bottom"]],
			["topmargin", ["top"]],
			["bottommargin", ["bottom"]],
			["marginwidth", ["left", "right"]],
			["leftmargin", ["left"]],
			["rightmargin", ["right"]],
		] as const) {
			const length = parsePixels(get(attribute));
			if (length !== null) {
				for (const edge of edges) {
					hints[`margin-${edge}`] = length;
				}
			}
		}
	} else if (name === "font") {
		setColor(hints, "color", get("color"));
	} else if (isLink(element)) {
		const body = element.ownerDocument?.body ?? null;
		if (body?.localName === "body") {
			setColor(hints, "color", body.getAttribute("link"));
		}
	}

	const align = get("align")?.trim().toLowerCase();
	if (align !== undefined) {
		if (ALIGNED_BLOCKS.has(name) && ALIGNMENTS[align] !== undefined) {
			hints["text-align"] = ALIGNMENTS[align];
		} else if (name === "table" && align === "center") {
			hints["margin-left"] = "auto";
			hints["margin-right"] = "auto";
		}
	}

	if (
		name === "thead" ||
		name === "tbody" ||
		name === "tfoot" ||
		name === "tr" ||
		name === "td" ||
		name === "th"
	) {
		const valign = get("valign")?.trim().toLowerCase();
		if (valign !== undefined && VERTICAL_ALIGNMENTS[valign] !== undefined) {
			hints["vertical-align"] = VERTICAL_ALIGNMENTS[valign];
		}
		setDimension(hints, "height", get("height"));
	}

	if (name === "table") {
		setDimension(hints, "width", get("width"), true);
		setDimension(hints, "height", get("height"));
		const border = parsePixels(get("border"));
		if (border !== null) {
			setEdges(hints, "border-*-width", border);
			if (border !== "0px") {
				setEdges(hints, "border-*-style", "outset");
			}
		}
		setColor(hints, "border-top-color", get("bordercolor"));
		if (hints["border-top-color"] !== undefined) {
			setEdges(hints, "border-*-color", hints["border-top-color"]);
		}
		const spacing = parsePixels(get("cellspacing"));
		if (spacing !== null) {
			hints["border-spacing"] = `${spacing} ${spacing}`;
		}
	}

	if (name === "td" || name === "th") {
		setDimension(hints, "width", get("width"), true);
		// Quirks mode lets a pixel width override nowrap (HTML §15.3.8).
		const width = parseDimension(get("width"), true);
		if (
			element.hasAttribute("nowrap") && !(
				element.ownerDocument?.compatMode === "BackCompat" &&
				width?.endsWith("px")
			)
		) {
			hints["white-space-collapse"] = "collapse";
			hints["text-wrap-mode"] = "nowrap";
		}
		const table = getCellTable(element);
		const padding = parsePixels(table?.getAttribute("cellpadding") ?? null);
		if (padding !== null) {
			setEdges(hints, "padding-*", padding);
		}
	}

	if (name === "col" || name === "colgroup") {
		setDimension(hints, "width", get("width"));
	}

	if (name === "hr") {
		setDimension(hints, "width", get("width"));
		const color = parseLegacyColor(get("color"));
		if (color !== null) {
			hints["color"] = color;
			setEdges(hints, "border-*-color", color);
		}
		const align = get("align")?.trim().toLowerCase();
		if (align === "left") {
			hints["margin-left"] = "0";
			hints["margin-right"] = "auto";
		} else if (align === "right") {
			hints["margin-left"] = "auto";
			hints["margin-right"] = "0";
		} else if (align === "center") {
			hints["margin-left"] = "auto";
			hints["margin-right"] = "auto";
		}
	}

	if (
		EMBEDDED.has(name) ||
		(name === "input" && get("type")?.toLowerCase() === "image")
	) {
		setDimension(hints, "width", get("width"));
		setDimension(hints, "height", get("height"));
		const hspace = parseDimension(get("hspace"));
		if (hspace !== null) {
			hints["margin-left"] = hspace;
			hints["margin-right"] = hspace;
		}
		const vspace = parseDimension(get("vspace"));
		if (vspace !== null) {
			hints["margin-top"] = vspace;
			hints["margin-bottom"] = vspace;
		}
		if (name === "img" || name === "object" || name === "input") {
			const border = parsePixels(get("border"));
			if (border !== null) {
				setEdges(hints, "border-*-width", border);
				setEdges(hints, "border-*-style", "solid");
			}
		}
	}

	if (name === "ul" || name === "ol" || name === "li") {
		const type = get("type")?.trim();
		if (type !== undefined) {
			const listType = LIST_TYPES[type] ?? LIST_TYPES[type.toLowerCase()];
			if (listType !== undefined) {
				hints["list-style-type"] = listType;
			}
		}
	}

	return Object.keys(hints).length === 0 ? null : hints;
}

// The attributes a hint reads, and on which elements. A table's
// cellpadding styles its cells and body's link its links, and many hints
// set inherited properties, so a change restyles the subtree.
const HINT_ATTRIBUTES: Record<string, ReadonlySet<string> | "*"> = {
	bgcolor: new Set([...TABLE_PARTS, "body"]),
	text: new Set(["body"]),
	link: new Set(["body"]),
	color: new Set(["font", "hr"]),
	bordercolor: new Set(["table"]),
	align: "*",
	valign: new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]),
	width: "*",
	height: "*",
	border: new Set(["table", "img", "object", "input"]),
	cellspacing: new Set(["table"]),
	cellpadding: new Set(["table"]),
	nowrap: new Set(["td", "th"]),
	hspace: "*",
	vspace: "*",
	type: new Set(["ul", "ol", "li", "input"]),
	marginheight: new Set(["body"]),
	marginwidth: new Set(["body"]),
	topmargin: new Set(["body"]),
	bottommargin: new Set(["body"]),
	leftmargin: new Set(["body"]),
	rightmargin: new Set(["body"]),
};

// The hints that change nothing but paint.
const PAINT_HINT_ATTRIBUTES = new Set([
	"bgcolor",
	"text",
	"link",
	"color",
	"bordercolor",
]);

export function isHintAttribute(element: Element, name: string): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const elements = HINT_ATTRIBUTES[name];
	return elements === "*" || (elements?.has(element.localName) ?? false);
}

export function isLayoutHintAttribute(element: Element, name: string): boolean {
	return isHintAttribute(element, name) && !PAINT_HINT_ATTRIBUTES.has(name);
}
