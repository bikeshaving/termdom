/**
 * The terminal User Agent stylesheet -- the browser's html.css, terminal
 * edition, and the one home for TermDOM's default styling data.
 *
 * It holds the per-element default computed styles (TERMINAL_ELEMENT_DEFAULTS +
 * getElementDefaults), the CSS spec fallbacks and inheritance list the cascade
 * resolves against, the UA DOCUMENT sheet (::selection and the button
 * brackets), and the scoped stylesheets of the form widgets' internal shadow
 * trees. The cascade (styles.ts) and the widgets (widgets.ts) both read from
 * here; it depends only on text + the DOM, so it stays a leaf.
 *
 * The architectural invariant it anchors: no painter emits a terminal attribute
 * that didn't come from a computed style. Even the selection's inverse video is
 * DECLARED here -- Highlight/HighlightText is CSS's spelling of "swap the cell's
 * colors", which the selection painters translate to SGR 7. Delete that rule
 * and selections stop painting; it is load-bearing, not decorative.
 */
import {stringWidth} from "./text.js";

// ---- Box-model shorthand expansion (the UA table is built on it) ----
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

// ---- CSS spec defaults ----
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

// ---- Terminal element defaults ----
export const TERMINAL_ELEMENT_DEFAULTS: Record<
	string,
	Record<string, string>
> = {
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
	// normal pipeline, so this is what makes multiline values multiline --
	// and break-word (the browser's own textarea UA rule) is what makes a
	// long unbroken word wrap at the field edge instead of escaping it.
	textarea: {
		display: "inline-block",
		border: "1px solid",
		padding: "0 1ch",
		"white-space": "pre-wrap",
		"overflow-wrap": "break-word",
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
export function getElementDefaults(
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

// ---- Inheritance / initial-value tables ----
/**
 * Properties that inherit by default
 */
export const INHERITED_PROPERTIES = new Set([
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
	"word-break",
	"overflow-wrap",
	"direction",
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

export const INITIAL_KEYWORDS = new Set([
	"initial",
	"unset",
	"revert",
	"revert-layer",
]);

/**
 * Get the initial/default value for a property on an element
 */
export function getInitialStyle(element: Element, property: string): string {
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

// ---- UA document stylesheet ----
/**
 * The UA DOCUMENT stylesheet. Rules here are UA origin (every author rule
 * outranks them) and, uniquely, apply in EVERY tree scope, exactly as a
 * browser's UA sheet styles shadow trees. The `::selection` rule is the
 * load-bearing one the header warns about: it is CSS's spelling of "swap the
 * cell's colors", which the selection painters translate to SGR 7.
 */
export const UA_DOCUMENT_STYLES = `
	*::selection { background-color: Highlight; color: HighlightText; }
	button::before { content: "[ "; }
	button::after { content: " ]"; }
	a[href] { text-decoration: underline; }
	a[href]:focus-visible { background-color: Highlight; color: HighlightText; }
	button:focus-visible { outline-width: 1px; outline-style: solid; }
`;

// ---- Form-widget internal shadow stylesheets ----
/**
 * The UA stylesheet of a textarea's internal shadow tree. Unlike the input,
 * the textarea's parts render through the NORMAL pipeline -- the value text
 * node lays out, wraps and paints like any document text -- so these rules are
 * all there is: the placeholder's ghost gray, faint when the host is blurred,
 * hidden by the reconcile (an inline display:none) whenever a value exists.
 */
export const TEXTAREA_UA_STYLES = `
	[part="placeholder"] { color: #808080; }
	:host(:not(:focus)) [part="placeholder"] { font-weight: lighter; }
`;

/**
 * The UA stylesheet of an <input>'s internal shadow tree: the field design as
 * real, scoped CSS. The value and placeholder are single-line inline-blocks that
 * clip their text (the render loop sets scrollLeft to follow the caret); the
 * focus affordance is an `outline`, which the painter renders as a bottom
 * underline across the whole field. A blurred field carries no chrome.
 */
export const FIELD_UA_STYLES = `
	[part="value"], [part="placeholder"] { display: inline-block; white-space: pre; overflow: hidden; min-width: 1ch; max-width: 100%; vertical-align: top; }
	[part="placeholder"] { color: #808080; }
	:host(:focus) { outline-width: 1px; outline-style: solid; }
`;

/**
 * The UA stylesheet of a select's internal shadow tree: the ▾ indicator is
 * faint -- affordance, not content. Everything else (the focused field's
 * underline included) inherits from the host's own defaults.
 */
export const SELECT_UA_STYLES = `
	[part="indicator"] { font-weight: lighter; }
	[part="picker"] {
		display: none;
		position: absolute;
		background-color: Canvas;
		text-decoration: none;
		border-top-width: 1px; border-right-width: 1px;
		border-bottom-width: 1px; border-left-width: 1px;
		border-top-style: solid; border-right-style: solid;
		border-bottom-style: solid; border-left-style: solid;
	}
	[part="option"] { display: block; white-space: pre; }
	[part="option"][data-highlighted] { background-color: Highlight; color: HighlightText; }
	[part="option"][data-disabled] { font-weight: lighter; }
`;
