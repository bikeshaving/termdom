/**
 * CSS System for Terminal DOM
 *
 * This module provides a way to override window.getComputedStyle() with terminal-appropriate
 * CSS property resolution. The core TermDOM class uses this to provide a custom CSS implementation.
 */

import {CSSStyleDeclaration} from "cssstyle";
import {type DOMWindow} from "jsdom";
import * as CSSOM from "rrweb-cssom";
import {
	cssColorToNumber as runtimeCssColorToNumber,
	stringWidth,
} from "./runtime.js";
import {
	attachPseudoElement,
	clearPseudoElements,
	compositionParentElement,
	compositionShadowRoot,
	removePseudoElement,
} from "./composition.js";
import {type LayoutEngine} from "./layout.js";

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
	const marginTop = parseUnitValue(
		computedStyle.getPropertyValue("margin-top"),
	);
	const marginRight = parseUnitValue(
		computedStyle.getPropertyValue("margin-right"),
	);
	const marginBottom = parseUnitValue(
		computedStyle.getPropertyValue("margin-bottom"),
	);
	const marginLeft = parseUnitValue(
		computedStyle.getPropertyValue("margin-left"),
	);

	// Parse border
	const borderTopWidth = parseUnitValue(
		computedStyle.getPropertyValue("border-top-width"),
	);
	const borderRightWidth = parseUnitValue(
		computedStyle.getPropertyValue("border-right-width"),
	);
	const borderBottomWidth = parseUnitValue(
		computedStyle.getPropertyValue("border-bottom-width"),
	);
	const borderLeftWidth = parseUnitValue(
		computedStyle.getPropertyValue("border-left-width"),
	);

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

// ============================================================================
// CSS DEFAULTS FOR TERMINAL ELEMENTS
// ============================================================================

/**
 * CSS specification defaults for properties
 */
const CSS_SPEC_DEFAULTS: Record<string, string> = {
	display: "inline",
	margin: "0",
	padding: "0",
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
	"border-radius": "0",
	"background-color": "transparent",
	color: "#000000",
	"font-size": "1rem",
	"font-weight": "normal",
	"font-style": "normal",
	"text-decoration": "none",
	"white-space": "normal",
	overflow: "visible",
	position: "static",
	width: "auto",
	height: "auto",
	"box-sizing": "border-box",
	// Terminal-optimized flexbox defaults
	// Container properties
	"flex-direction": "row",
	"flex-wrap": "nowrap",
	"justify-content": "flex-start",
	"align-items": "stretch",
	"align-content": "flex-start",
	gap: "0",
	"row-gap": "0",
	"column-gap": "0",
	// Item properties
	"flex-grow": "0",
	"flex-shrink": "1",
	"flex-basis": "auto",
	"align-self": "auto",
	order: "0",
};

/**
 * Terminal-specific defaults per element type
 */
/**
 * Expand box-model SHORTHANDS into the longhands everything downstream
 * reads. Both stylesheet rules and element defaults are consulted
 * per-property, so a `border: 1px solid` that never becomes
 * border-top-width etc. simply doesn't exist to the box model or the
 * border painter. (Inline styles don't need this: cssstyle expands them.)
 * Declaration order is preserved, so an explicit longhand after a
 * shorthand still overrides it.
 */
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
const EDGES = ["top", "right", "bottom", "left"] as const;

/** CSS 1-4 value expansion: [all], [v h], [t h b], [t r b l]. */
function perEdge(values: string[]): [string, string, string, string] {
	const [a, b = a, c = a, d = b] = values;
	return [a, b, c, d];
}

export function expandBoxShorthands(
	declarations: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	const setEdges = (kind: string, values: string[]) => {
		const edgeValues = perEdge(values);
		EDGES.forEach((edge, i) => {
			out[`border-${edge}-${kind}`] = edgeValues[i];
		});
	};
	const splitBorderValue = (value: string) => {
		let width: string | null = null;
		let borderStyle: string | null = null;
		let color: string | null = null;
		for (const token of value.trim().split(/\s+/)) {
			if (BORDER_STYLE_KEYWORDS.has(token)) borderStyle = token;
			else if (
				/^[\d.]/.test(token) ||
				token === "thin" ||
				token === "thick" ||
				token === "medium"
			)
				width = token;
			else if (token) color = token;
		}
		return {width, borderStyle, color};
	};

	for (const [property, value] of Object.entries(declarations)) {
		const values = value.trim().split(/\s+/).filter(Boolean);
		if (property === "border") {
			const {width, borderStyle, color} = splitBorderValue(value);
			setEdges("width", [width ?? "medium"]);
			setEdges("style", [borderStyle ?? "none"]);
			if (color) setEdges("color", [color]);
		} else if (property === "border-width") {
			setEdges("width", values);
		} else if (property === "border-style") {
			setEdges("style", values);
		} else if (property === "border-color") {
			setEdges("color", values);
		} else if (/^border-(top|right|bottom|left)$/.test(property)) {
			const edge = property.slice("border-".length);
			const {width, borderStyle, color} = splitBorderValue(value);
			out[`border-${edge}-width`] = width ?? "medium";
			out[`border-${edge}-style`] = borderStyle ?? "none";
			if (color) out[`border-${edge}-color`] = color;
		} else if (property === "padding" || property === "margin") {
			const edgeValues = perEdge(values);
			EDGES.forEach((edge, i) => {
				out[`${property}-${edge}`] = edgeValues[i];
			});
		} else {
			out[property] = value;
		}
	}
	return out;
}

const TERMINAL_ELEMENT_DEFAULTS: Record<string, Record<string, string>> = {
	// Metadata elements - never rendered in terminal
	head: {display: "none"},
	style: {display: "none"},
	script: {display: "none"},
	meta: {display: "none"},
	title: {display: "none"},
	link: {display: "none"},

	// Block elements
	html: {display: "block"},
	body: {display: "block"},
	div: {display: "block"},
	section: {display: "block"},
	article: {display: "block"},
	aside: {display: "block"},
	header: {display: "block"},
	footer: {display: "block"},
	main: {display: "block"},
	nav: {display: "block"},
	h1: {display: "block"},
	h2: {display: "block"},
	h3: {display: "block"},
	h4: {display: "block"},
	h5: {display: "block"},
	h6: {display: "block"},
	p: {display: "block"},
	blockquote: {display: "block"},
	pre: {display: "block", "white-space": "pre"},
	ul: {display: "block", "padding-left": "4ch"},
	ol: {display: "block", "padding-left": "4ch"},
	li: {display: "list-item"},
	dl: {display: "block"},
	dt: {display: "block"},
	dd: {display: "block"},
	form: {display: "block"},
	fieldset: {display: "block"},
	figure: {display: "block"},
	figcaption: {display: "block"},
	hr: {display: "block", "border-top": "1px solid"},

	// Inline elements
	span: {display: "inline"},
	a: {display: "inline"},
	em: {display: "inline", "font-style": "italic"},
	strong: {display: "inline", "font-weight": "bold"},
	code: {display: "inline", "background-color": "rgba(0, 0, 0, 0.1)"},
	kbd: {display: "inline"},
	samp: {display: "inline"},
	var: {display: "inline", "font-style": "italic"},
	b: {display: "inline", "font-weight": "bold"},
	i: {display: "inline", "font-style": "italic"},
	u: {display: "inline", "text-decoration": "underline"},
	s: {display: "inline", "text-decoration": "line-through"},
	sub: {display: "inline"},
	sup: {display: "inline"},
	// SGR faint is the terminal's small: same glyph cells, reduced ink.
	small: {display: "inline", "font-weight": "lighter"},
	abbr: {display: "inline"},
	cite: {display: "inline", "font-style": "italic"},
	dfn: {display: "inline", "font-style": "italic"},
	mark: {display: "inline"},
	time: {display: "inline"},
	q: {display: "inline"},
	label: {display: "inline"},
	br: {display: "inline"},
	// As in browsers: a slot generates no box of its own -- its projected
	// (or fallback) content is spliced into the parent's child sequence by
	// the walker's flat-tree layer (see composition.ts). Styling the slot
	// still works for inherited properties, exactly the browser behavior.
	slot: {display: "contents"},

	// Terminal UI controls. The button joins the flat field family: no
	// border (three rows and two columns per button, in a world of one-row
	// list items), just breathing room and the family's focus underline
	// (see getElementDefaults). Authors who want chrome add it.
	// The button is the toggles' visual language extended to labels:
	// "[ Label ]", the delimited one-row form every terminal tradition
	// from dialog/whiptail to Midnight Commander to the text-mode
	// browsers (Lynx, w3m, ELinks render HTML buttons exactly this way)
	// converged on. The brackets are UA ::before/::after rules in the UA
	// document stylesheet -- author content rules override them (an
	// icon button sets its own), and focus underlines the whole token
	// like the rest of the field family.
	button: {
		display: "inline-block",
		cursor: "pointer",
	},
	// A text input is a flat field: bare when blurred (dim placeholder and
	// the content are the affordance -- the convention of the entire
	// prompt-tool ecosystem), underlined when FOCUSED (see
	// getElementDefaults) -- "underline means live." Plain SGR 4 only:
	// styled underlines (4:2) verified dead through the baseline
	// tmux+Terminal.app chain, where the intermediary normalizes the
	// graceful 4-then-4:2 pair into one styled attribute and the terminal
	// drops it entirely -- the focused field would lose its marker on
	// exactly the stack we promise works. No borders (three rows and two
	// columns per field), no backgrounds (no theme-safe color exists).
	// Width mirrors the browser's own size=20 default. This is the UA
	// baseline, deliberately lightweight; authors who want chrome add it.
	input: {
		display: "inline-block",
		width: "20ch",
		// A field's value never wraps or collapses -- runs of spaces are
		// real content, and the painter's scroll-window handles overflow.
		"white-space": "pre",
	},
	// A textarea preserves newlines and soft-wraps at its edge, exactly the
	// browser default. Its UA shadow tree's value text lays out through the
	// normal pipeline, so this is what makes multiline values multiline.
	textarea: {
		display: "inline-block",
		border: "1px solid",
		padding: "0 1ch",
		"white-space": "pre-wrap",
	},
	// A select is a flat field in the input family: the selected option's
	// label plus a dim indicator, underlined when focused (see
	// getElementDefaults for the dynamic width and focus underline).
	select: {
		display: "inline-block",
		"white-space": "pre",
	},

	// Tables
	table: {display: "table", "border-collapse": "collapse"},
	thead: {display: "table-header-group"},
	tbody: {display: "table-row-group"},
	tfoot: {display: "table-footer-group"},
	tr: {display: "table-row"},
	caption: {display: "table-caption"},
	colgroup: {display: "table-column-group"},
	col: {display: "table-column"},
	td: {
		display: "table-cell",
		"border-top-width": "1px",
		"border-right-width": "1px",
		"border-bottom-width": "1px",
		"border-left-width": "1px",
		"border-top-style": "solid",
		"border-right-style": "solid",
		"border-bottom-style": "solid",
		"border-left-style": "solid",
		"padding-left": "1ch",
		"padding-right": "1ch",
	},
	th: {
		display: "table-cell",
		"border-top-width": "1px",
		"border-right-width": "1px",
		"border-bottom-width": "1px",
		"border-left-width": "1px",
		"border-top-style": "solid",
		"border-right-style": "solid",
		"border-bottom-style": "solid",
		"border-left-style": "solid",
		"padding-left": "1ch",
		"padding-right": "1ch",
		"font-weight": "bold",
	},
};

// The defaults above may use shorthands; normalize them once so the
// per-property consultation below always finds longhands.
for (const [tag, declarations] of Object.entries(TERMINAL_ELEMENT_DEFAULTS)) {
	TERMINAL_ELEMENT_DEFAULTS[tag] = expandBoxShorthands(declarations);
}

// input's own entry in TERMINAL_ELEMENT_DEFAULTS above (bordered box, 20ch
// wide) is shaped for a text field, whose void-element content has nothing
// else to size or paint a box from. A checkbox/radio renders as a compact
// "[ ]"/"[x]" glyph instead (see #renderInputElement) -- same reasoning, same
// problem, opposite answer: 3 cells wide, no border, no padding to pad it
// out further.
const CHECKBOX_DEFAULTS: Record<string, string> = {
	display: "inline-block",
	width: "3ch",
};

/**
 * TERMINAL_ELEMENT_DEFAULTS keyed purely by tag name can't distinguish an
 * <input type="checkbox"> from a text <input> -- both are just "input". This
 * is the one place type has to be checked before falling back to the
 * tag-level defaults.
 */
function getElementDefaults(
	element: Element,
): Record<string, string> | undefined {
	// The browser's UA :fullscreen treatment: the fullscreen element fills
	// the viewport. Explicit cells rather than percentages -- the alternate
	// screen IS the containing geometry, and innerWidth/Height are its size.
	if (element.ownerDocument?.fullscreenElement === element) {
		const window = element.ownerDocument.defaultView;
		const base = TERMINAL_ELEMENT_DEFAULTS[element.tagName.toLowerCase()] ?? {};
		if (window) {
			return {
				...base,
				// The browser's :fullscreen block: fixed at the viewport
				// origin, viewport-sized, opaque over the document (Canvas =
				// the terminal's own background, the ::backdrop stand-in).
				position: "fixed",
				top: "0px",
				left: "0px",
				width: `${window.innerWidth}ch`,
				height: `${window.innerHeight}px`,
				"background-color": "Canvas",
			};
		}
	}
	if (element.tagName === "TEXTAREA") {
		// rows/cols size the box exactly as in a browser (spec defaults 2
		// and 20), in border-box terms: +2 for the border rows/cols, +2 for
		// the horizontal padding. min-height rather than height: the field
		// GROWS with its content -- the terminal-native reading of a
		// multiline field (a browser scrolls inside a fixed box instead;
		// element scrolling is machinery this engine doesn't have).
		const rows = parseInt(element.getAttribute("rows") ?? "", 10);
		const cols = parseInt(element.getAttribute("cols") ?? "", 10);
		const effectiveRows = Number.isFinite(rows) && rows > 0 ? rows : 2;
		const effectiveCols = Number.isFinite(cols) && cols > 0 ? cols : 20;
		return {
			...TERMINAL_ELEMENT_DEFAULTS.textarea,
			"min-height": `${effectiveRows + 2}px`,
			width: `${effectiveCols + 4}ch`,
		};
	}
	if (element.tagName === "BUTTON") {
		const merged: Record<string, string> = {
			...TERMINAL_ELEMENT_DEFAULTS.button,
		};
		if (element.ownerDocument?.activeElement === element) {
			merged["text-decoration"] = "underline";
		}
		return merged;
	}
	if (element.tagName === "SELECT") {
		// Sized to the LONGEST option label plus the indicator, exactly as a
		// browser sizes a closed select -- so the field's width never jumps
		// as the selection changes.
		const select = element as HTMLSelectElement;
		let widest = 0;
		for (const option of select.options) {
			widest = Math.max(widest, stringWidth(option.label));
		}
		const merged: Record<string, string> = {
			...TERMINAL_ELEMENT_DEFAULTS.select,
			width: `${widest + 2}ch`,
		};
		if (select.ownerDocument?.activeElement === select) {
			merged["text-decoration"] = "underline";
		}
		return merged;
	}
	if (element.tagName === "INPUT") {
		const input = element as HTMLInputElement;
		// The FOCUSED field gets the underline -- the UA "this is the live
		// one" signal, in plain SGR 4, the one underline every terminal and
		// every intermediary renders. Focus changes invalidate the
		// computed-style cache (see handleFocusChange), so this is
		// re-consulted at the right moments.
		const focused = input.ownerDocument?.activeElement === input;
		if (input.type === "checkbox" || input.type === "radio") {
			// The compact glyph is bare when blurred; focus underlines it --
			// same live-wire language as the text field.
			return focused
				? {...CHECKBOX_DEFAULTS, "text-decoration": "underline"}
				: CHECKBOX_DEFAULTS;
		}
		// The size attribute drives a text input's default width, one column
		// per character position, exactly as a browser sizes an unstyled
		// input from size="...". The static defaults entry carries the spec
		// default of 20.
		const size = parseInt(input.getAttribute("size") ?? "", 10);
		if (Number.isFinite(size) || focused) {
			const merged = {...TERMINAL_ELEMENT_DEFAULTS.input};
			if (Number.isFinite(size) && size > 0) {
				merged.width = `${size}ch`;
			}
			if (focused) {
				merged["text-decoration"] = "underline";
			}
			return merged;
		}
	}
	return TERMINAL_ELEMENT_DEFAULTS[element.tagName.toLowerCase()];
}

/**
 * Properties that inherit by default
 */
const INHERITED_PROPERTIES = new Set([
	"color",
	"font-family",
	"font-size",
	"font-style",
	"font-variant",
	"font-weight",
	"line-height",
	"text-align",
	"text-decoration",
	"text-indent",
	"text-transform",
	"white-space",
	"word-spacing",
	"letter-spacing",
	"visibility",
	"cursor",
	"quotes",
	"list-style",
	"list-style-image",
	"list-style-position",
	"list-style-type",
]);

const INITIAL_KEYWORDS = new Set([
	"initial",
	"unset",
	"revert",
	"revert-layer",
]);

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
			const close = content.indexOf(char, index + 1);
			if (close === -1) {
				out += content.slice(index + 1);
				break;
			}
			out += content.slice(index + 1, close);
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
 * Get the initial/default value for a property on an element
 */
function getInitialStyle(element: Element, property: string): string {
	// Check element-specific defaults first
	const elementDefaults = getElementDefaults(element);
	if (elementDefaults && elementDefaults[property]) {
		return elementDefaults[property];
	}

	// Check universal defaults (*)
	const universalDefaults = TERMINAL_ELEMENT_DEFAULTS["*"];
	if (universalDefaults && universalDefaults[property]) {
		return universalDefaults[property];
	}

	// Fall back to CSS spec default
	return CSS_SPEC_DEFAULTS[property] || "";
}

export class ComputedStyleDeclaration extends CSSStyleDeclaration {
	#element: Element;
	#cssRules: ParsedCSSRule[];

	constructor(element: Element, cssRules: ParsedCSSRule[] = []) {
		// Initialize with no onChange callback since this is read-only computed style
		super();

		this.#element = element;
		this.#cssRules = cssRules;

		// Pre-populate with all our resolved values
		this.#populateDeclaration();
	}

	#populateDeclaration(): void {
		// Get all CSS properties we might need to resolve
		const properties = [
			// Layout properties
			"display",
			"position",
			"top",
			"right",
			"bottom",
			"left",
			"width",
			"height",
			"min-width",
			"min-height",
			"max-width",
			"max-height",
			"margin",
			"margin-top",
			"margin-right",
			"margin-bottom",
			"margin-left",
			"padding",
			"padding-top",
			"padding-right",
			"padding-bottom",
			"padding-left",
			"border-width",
			"border-style",
			"border-color",
			"border-radius",
			"border-top-width",
			"border-right-width",
			"border-bottom-width",
			"border-left-width",
			"border-top-style",
			"border-right-style",
			"border-bottom-style",
			"border-left-style",
			"border-top-color",
			"border-right-color",
			"border-bottom-color",
			"border-left-color",
			"overflow",
			"overflow-x",
			"overflow-y",
			"z-index",

			// Flexbox
			"flex-direction",
			"flex-wrap",
			"justify-content",
			"align-items",
			"align-content",
			"flex",
			"flex-grow",
			"flex-shrink",
			"flex-basis",
			"gap",
			"row-gap",
			"column-gap",
			"align-self",
			"order",

			// Text and visual
			"color",
			"background-color",
			"font-size",
			"font-weight",
			"font-style",
			"text-decoration",
			"text-align",
			"white-space",
			"word-break",
			"overflow-wrap",
			"list-style",
			"list-style-type",
			"list-style-position",
			"list-style-image",

			// CSS Counters
			"counter-reset",
			"counter-increment",
			"content",
		];

		// Resolve each property and set it in the declaration
		for (const property of properties) {
			const value = this.#resolvePropertyValue(property);
			if (value) {
				super.setProperty(property, value);
			}
		}
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

	/** An author-level shorthand value, inline first, then stylesheet rules. */
	#resolveShorthand(property: string): string | null {
		const style = (this.#element as HTMLElement).style;
		const inline = style?.getPropertyValue(property).trim();
		if (inline && !INITIAL_KEYWORDS.has(inline)) return inline;

		let ruleValue: string | null = null;
		for (const rule of this.#cssRules) {
			if (rule.declarations[property]) {
				ruleValue = rule.declarations[property];
			}
		}
		return ruleValue;
	}

	/**
	 * Resolve property value applying CSS cascade: inline styles > CSS rules >
	 * defaults, with `!important` promoted above all of that (an important
	 * stylesheet rule beats even a non-important inline style, per spec), and
	 * `var()` references substituted in whatever wins.
	 */
	#resolvePropertyValue(property: string): string {
		const raw = this.#resolvePropertyValueRaw(property);
		return raw ? this.#substituteVar(raw) : raw;
	}

	#resolvePropertyValueRaw(property: string): string {
		const style = (this.#element as HTMLElement).style;
		const inlineValue = style?.getPropertyValue(property).trim();
		const inlineUsable = !!inlineValue && !INITIAL_KEYWORDS.has(inlineValue);
		const inlineImportant =
			inlineUsable && style.getPropertyPriority(property) === "important";

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

		if (inlineImportant) return inlineValue;
		if (importantRuleValue) return importantRuleValue;
		if (inlineUsable) return inlineValue;
		if (ruleValue) {
			return ruleValue;
		}

		// 2b. Author-level shorthands that cssstyle does not expand for us. They are
		// consulted after the longhands -- an explicit `row-gap` beats the `gap` it
		// appears with -- but before the defaults, or the default would silently win
		// over the shorthand.
		if (LIST_STYLE_LONGHANDS.has(property)) {
			const shorthand = this.#resolveShorthand("list-style");
			if (shorthand) {
				const expanded =
					expandListStyle(shorthand)[property as keyof ListStyleParts];
				if (expanded) return expanded;
			}
		}

		if (property === "row-gap" || property === "column-gap") {
			const shorthand = this.#resolveShorthand("gap");
			if (shorthand) {
				// `gap: <row> <column>`, with a single value meaning both.
				const parts = shorthand.trim().split(/\s+/);
				const value =
					property === "row-gap" ? parts[0] : (parts[1] ?? parts[0]);
				if (value) return value;
			}
		}

		if (property === "background-color") {
			// The full background shorthand covers images, positions and repeats
			// that mean nothing in a terminal; honor the everyday
			// `background: <color>` form and ignore the rest.
			const shorthand = this.#resolveShorthand("background");
			if (shorthand && !shorthand.includes("url(")) {
				return shorthand.trim();
			}
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

	// Override getPropertyValue to use our terminal-specific resolution
	override getPropertyValue(property: string): string {
		// First check if we have a cached value from populateDeclaration
		const cachedValue = super.getPropertyValue(property);
		if (cachedValue) {
			return this.#normalizeForTerminal(property, cachedValue);
		}

		// If not in our pre-populated cache, resolve it fresh
		// (This handles properties not in our common list)
		const freshValue = this.#resolvePropertyValue(property);
		return this.#normalizeForTerminal(property, freshValue);
	}

	/**
	 * Apply terminal-specific normalization to computed values
	 * This allows us to override cssstyle's default normalization
	 */
	#normalizeForTerminal(property: string, value: string): string {
		if (!value) return value;

		// Handle shorthand property expansion
		if (property === "margin") {
			const top = super.getPropertyValue("margin-top") || "0px";
			const right = super.getPropertyValue("margin-right") || "0px";
			const bottom = super.getPropertyValue("margin-bottom") || "0px";
			const left = super.getPropertyValue("margin-left") || "0px";
			return `${top} ${right} ${bottom} ${left}`;
		}

		if (property === "padding") {
			const top = super.getPropertyValue("padding-top") || "0px";
			const right = super.getPropertyValue("padding-right") || "0px";
			const bottom = super.getPropertyValue("padding-bottom") || "0px";
			const left = super.getPropertyValue("padding-left") || "0px";
			return `${top} ${right} ${bottom} ${left}`;
		}

		// For now, return the value as-is (cssstyle normalization)
		return value;
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
	ascii: {
		horizontal: "-",
		vertical: "|",
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		topTee: "+",
		bottomTee: "+",
		leftTee: "+",
		rightTee: "+",
		cross: "+",
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
		const widthValue = parseFloat(width);
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

/**
 * Convert CSS color string to numeric color value
 */
export function cssColorToNumber(cssColor: string): number {
	if (!cssColor || cssColor === "transparent" || cssColor === "none") {
		return 0;
	}

	const colorNumber = runtimeCssColorToNumber(cssColor);
	return typeof colorNumber === "number" ? colorNumber : 0;
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

interface ListStyleParts {
	"list-style-type"?: string;
	"list-style-position"?: string;
	"list-style-image"?: string;
}

const LIST_STYLE_LONGHANDS = new Set([
	"list-style-type",
	"list-style-position",
	"list-style-image",
]);

const LIST_STYLE_POSITIONS = new Set(["inside", "outside"]);

/**
 * Expand the `list-style` shorthand, whose components may appear in any order.
 *
 * `none` is ambiguous -- it sets whichever of type/image has not been given --
 * but for a terminal there are no images, so it always means "no marker".
 */
function expandListStyle(value: string): ListStyleParts {
	const parts: ListStyleParts = {};

	for (const token of value.trim().split(/\s+/)) {
		if (!token) continue;
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

/**
 * The UA DOCUMENT stylesheet -- this engine's html.css. Rules here are UA
 * origin (every author rule outranks them) and, uniquely, apply in EVERY
 * tree scope, exactly as a browser's UA sheet styles shadow trees.
 *
 * The architectural rule this file anchors: no painter may emit a terminal
 * attribute that didn't come from a computed style. Even the selection's
 * inverse video is DECLARED -- the Highlight/HighlightText system-color
 * pair is CSS's spelling of "swap the cell's colors", and the selection
 * painters translate exactly that pair to SGR 7. Delete this rule and
 * selections stop painting; it is load-bearing, not decorative.
 */
const UA_DOCUMENT_STYLES = `
	*::selection { background-color: Highlight; color: HighlightText; }
	button::before { content: "[ "; }
	button::after { content: " ]"; }
`;

export class StyleManager {
	#computedStyleCache = new WeakMap<Element, CSSStyleDeclaration>();
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
				// collision, back again after any mutation.
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
				// Invalidate caches for attribute changes (over-invalidation approach)
				const element = mutation.target as Element;
				this.#invalidateElementCaches(element);
				this.attachPseudoElementsToElement(element);
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

	/**
	 * Invalidate cached styles for an element (invalidation approach)
	 */
	#invalidateElementCaches(element: Element): void {
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
			this.#document.styleSheets.length !== this.#parsedStyleSheetCount
		) {
			this.#parseStylesheets();
		}
		// Handle pseudo-element styles
		if (pseudoElt) {
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

			// Create a CSSStyleDeclaration-like object - inline createPseudoStyleDeclaration
			const declaration = new CSSStyleDeclaration();
			for (const [property, value] of Object.entries(pseudoStyle)) {
				declaration.setProperty(property, value);
			}
			// Per CSS, a pseudo-element INHERITS from its originating element:
			// a button's focus underline runs through its UA brackets, a
			// .destroy's color reaches its ::after glyph. Rule declarations
			// above win; inherited values only fill the gaps.
			const hostStyle = this.#getComputedStyle(element);
			for (const property of INHERITED_PROPERTIES) {
				if (!declaration.getPropertyValue(property)) {
					const inherited = hostStyle.getPropertyValue(property);
					if (inherited) {
						declaration.setProperty(property, inherited);
					}
				}
			}
			return declaration as unknown as globalThis.CSSStyleDeclaration;
		}

		// Check cache first for regular element styles
		let computedStyle = this.#computedStyleCache.get(element);
		if (!computedStyle) {
			// Create new instance with stylesheet rules applied
			computedStyle = new ComputedStyleDeclaration(
				element,
				this.#getMatchingRules(element),
			);
			this.#computedStyleCache.set(element, computedStyle);
		}

		return computedStyle as unknown as globalThis.CSSStyleDeclaration;
	}

	/**
	 * Parse all stylesheets in the document and extract rules
	 */
	#parseStylesheets(): void {
		const document = this.#document;
		this.#parsedRules = [];
		this.#stylesheetsDirty = false;
		this.#parsedStyleSheetCount = document.styleSheets.length;

		// The UA document sheet parses first; origin ordering (not source
		// order) is what keeps it beneath every author rule.
		this.#parseStyleSheet(CSSOM.parse(UA_DOCUMENT_STYLES), undefined, true);

		// Parse all stylesheets
		for (let i = 0; i < document.styleSheets.length; i++) {
			const stylesheet = document.styleSheets[i] as CSSStyleSheet;
			if (stylesheet.cssRules) {
				this.#parseStyleSheet(stylesheet);
			}
		}

		// Shadow-tree stylesheets, scoped to their root. Disconnected roots
		// parse too: attach-populate-connect is the standard order, and a
		// scope-gated rule matches nothing until its tree renders anyway.
		for (const root of this.#shadowRoots) {
			for (const styleElement of root.querySelectorAll("style")) {
				const cssText = styleElement.textContent;
				if (cssText) {
					this.#parseStyleSheet(CSSOM.parse(cssText), root);
				}
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
	 * Parse a stylesheet (or a @media block's own rule list) and add rules to
	 * parsedRules. @media recurses into its nested rules when its condition
	 * matches the terminal's current size; every other condition/at-rule
	 * (@supports, @font-face, @keyframes, @import) has no terminal meaning and
	 * stays dropped.
	 */
	#parseStyleSheet(
		stylesheet: {cssRules: CSSRuleList},
		scope?: Node,
		uaOrigin?: boolean,
	): void {
		for (let i = 0; i < stylesheet.cssRules.length; i++) {
			const rule = stylesheet.cssRules[i];
			// TODO: use constructor.name
			if (rule.type === 1) {
				// CSSRule.STYLE_RULE
				this.#parseStyleRule(rule as CSSStyleRule, scope, uaOrigin);
			} else if (rule.type === 4) {
				// CSSRule.MEDIA_RULE
				const mediaRule = rule as CSSMediaRule;
				if (this.#mediaQueryMatches(mediaRule.media.mediaText)) {
					this.#parseStyleSheet(mediaRule, scope, uaOrigin);
				}
			}
		}
	}

	/**
	 * Whether a media query currently matches. There is exactly one "screen" --
	 * the terminal viewport -- so only width/height features are meaningful;
	 * everything else (scripting, color-gamut, pointer, ...) defaults to
	 * matching rather than silently dropping an author's rules.
	 */
	#mediaQueryMatches(mediaText: string): boolean {
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
		const {declarations, important} = this.#parseDeclarations(styleRule.style);
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
		const pseudoMatch = selector.match(
			/^(.+)(::(?:before|after|marker|first-line|first-letter|placeholder|selection))(.*)$/,
		);

		if (pseudoMatch) {
			const [, baseSelector, pseudoElement] = pseudoMatch;
			this.#parsedRules.push({
				selector: baseSelector.trim(),
				declarations,
				important,
				specificity,
				pseudoElement,
				scope,
				uaOrigin,
			});
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
	 * Parse CSSStyleDeclaration into a plain object, alongside which of its
	 * properties were declared `!important`.
	 */
	#parseDeclarations(style: any): {
		declarations: Record<string, string>;
		important: Record<string, boolean>;
	} {
		const declarations: Record<string, string> = {};
		const important: Record<string, boolean> = {};
		for (let i = 0; i < style.length; i++) {
			const property = style[i];
			declarations[property] = style.getPropertyValue(property);
			if (style.getPropertyPriority(property) === "important") {
				important[property] = true;
			}
		}
		// Rules are consulted per-property downstream; a border/padding/margin
		// shorthand that stays a shorthand is invisible to the box model.
		return {declarations: expandBoxShorthands(declarations), important};
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
		const partHost = partPseudo
			? (element.getRootNode() as ShadowRoot).host
			: null;
		return this.#parsedRules.filter((rule) => {
			if (rule.pseudoElement) {
				return (
					partPseudo !== null &&
					partHost !== null &&
					rule.pseudoElement === partPseudo &&
					this.#ruleMatches(partHost, rule)
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
	 * Get pseudo-element styles for use by ExpandedTreeWalker
	 */
	getPseudoElementStyles(
		element: Element,
		pseudoType: string,
	): Record<string, string> {
		return this.#computePseudoElementStyle(element, pseudoType);
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
		let textContent = content;
		if (
			(textContent.startsWith('"') && textContent.endsWith('"')) ||
			(textContent.startsWith("'") && textContent.endsWith("'"))
		) {
			textContent = textContent.slice(1, -1);
		}

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

		// TODO: Implement more granular pseudo-element invalidation
		// Currently we clear ALL pseudo-elements on any stylesheet change,
		// but we could be smarter and only clear/update affected elements
		// by diffing the old vs new pseudo-element rules

		// Clear all existing pseudo-elements before reattaching
		// TODO: Performance optimization - this walks every element in the DOM when stylesheets change.
		// Could track elements with pseudo-elements in a WeakSet and only clear those.
		const walker = this.#document.createTreeWalker(
			this.#document.documentElement,
			this.#window.NodeFilter.SHOW_ELEMENT,
			null,
		);
		let element = walker.nextNode() as Element;
		while (element) {
			clearPseudoElements(element);
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
				rule.pseudoElement !== "::selection"
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
	#attachPseudoElementToElementForType(
		element: Element,
		pseudoType: string,
	): void {
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

		// Check if element should have this pseudo-element
		if (this.shouldCreatePseudoElement(element, pseudoType)) {
			const pseudoNode = this.createPseudoElementNode(element, pseudoType);
			if (pseudoNode) {
				// Attach pseudo-element to the element
				// Use composition system to attach pseudo-element
				attachPseudoElement(element, pseudoNode, pseudoType);

				// Add CSS-specific metadata
				const existingMetadata = (pseudoNode as any).pseudoMetadata || {};
				(pseudoNode as any).pseudoMetadata = {
					...existingMetadata,
					styles: this.#computePseudoElementStyle(element, pseudoType),
				};

				// Invalidate the element in layout engine to rediscover pseudo elements
				this.#layoutEngine?.invalidate(element);
			}
		}
	}

	/**
	 * Clean up pseudo-elements when an element is removed from the DOM
	 */
	cleanupPseudoElementsForRemovedElement(element: Element): void {
		// Clean up pseudo-elements for this element
		clearPseudoElements(element);

		// Also clean up pseudo-elements for any descendant elements
		// TODO: Performance optimization - walks all descendants when element is removed.
		// Could track which descendants have pseudo-elements to avoid full traversal.
		const walker = this.#document.createTreeWalker(
			element,
			this.#window.NodeFilter.SHOW_ELEMENT,
			null,
		);
		let descendant = walker.nextNode() as Element;
		while (descendant) {
			clearPseudoElements(descendant);
			descendant = walker.nextNode() as Element;
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

		// Store wrapped styles to avoid double-wrapping
		const wrappedStyles = new WeakSet();

		// Find where the style property is defined in the prototype chain
		let stylePropertyOwner = null;
		let proto = this.#window.HTMLElement.prototype;
		while (proto) {
			if (Object.prototype.hasOwnProperty.call(proto, "style")) {
				stylePropertyOwner = proto;
				break;
			}
			proto = Object.getPrototypeOf(proto);
		}

		if (stylePropertyOwner) {
			const originalStyleGetter = Object.getOwnPropertyDescriptor(
				stylePropertyOwner,
				"style",
			)?.get;

			if (originalStyleGetter) {
				Object.defineProperty(stylePropertyOwner, "style", {
					get() {
						const style = originalStyleGetter.call(this);

						// Wrap the onChange callback if not already wrapped
						if (style && !wrappedStyles.has(style)) {
							wrappedStyles.add(style);

							// Save reference to element for the callback
							const element = this;

							// Wrap the existing onChange callback
							const originalOnChange = style._onChange;
							style._onChange = function (cssText: string) {
								// Call original onChange first (which updates the style attribute)
								if (originalOnChange) {
									originalOnChange.call(this, cssText);
								}
								// Then invalidate our cache
								styleManager.invalidateElement(element);
							};
						}

						return style;
					},
					configurable: true,
				});
			}
		}
	}

	/**
	 * Invalidate cached computed style for an element
	 */
	invalidateElement(element: Element): void {
		this.#computedStyleCache.delete(element);
		this.#pseudoElementStyleCache.delete(element);
	}

	/**
	 * Clear all cached computed styles (nuclear option)
	 */
	clearCache(): void {
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
