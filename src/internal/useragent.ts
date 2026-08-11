/**
 * The user-agent stylesheet and the per-element defaults the cascade resolves
 * against, including the sheets scoped to the form widgets' shadow trees.
 *
 * It anchors an invariant: no painter emits a terminal attribute that did not
 * come from a computed style. A selection is inverse video because a rule here
 * declares Highlight/HighlightText, which is CSS's spelling of swapping a
 * cell's colors -- load-bearing, not decorative.
 */
import {CSS_INITIAL_VALUES} from "./cssproperties.js";
import {HTML_NAMESPACE} from "./dom.js";
import {stringWidth} from "./text.js";

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
const LIST_STYLE_POSITIONS = new Set(["inside", "outside"]);

/** CSS 1-4 value expansion: [all], [v h], [t h b], [t r b l]. */
function perEdge(values: string[]): [string, string, string, string] {
	const [a, b = a, c = a, d = b] = values;
	return [a, b, c, d];
}

/**
 * A value's top-level components. Whitespace INSIDE parentheses separates a
 * function's own arguments, not components: `rgb(95, 175, 255)` is one color,
 * however many spaces it carries.
 */
function splitComponents(value: string): string[] {
	const components: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		const char = value[i];
		if (char === "(") depth++;
		else if (char === ")") depth--;
		else if ((i === value.length || /\s/.test(char)) && depth === 0) {
			const component = value.slice(start, i).trim();
			if (component) components.push(component);
			start = i + 1;
		}
	}
	return components;
}

/**
 * The `<line-width> || <line-style> || <color>` grammar shared by `border`,
 * the per-side border shorthands and `outline`. Components may appear in any
 * order and any may be omitted.
 */
function splitLineValue(value: string): {
	width: string | null;
	lineStyle: string | null;
	color: string | null;
} {
	let width: string | null = null;
	let lineStyle: string | null = null;
	let color: string | null = null;
	for (const token of splitComponents(value)) {
		if (BORDER_STYLE_KEYWORDS.has(token)) lineStyle = token;
		else if (/^[\d.]/.test(token) || LINE_WIDTH_KEYWORDS.has(token)) {
			width = token;
		} else if (token) color = token;
	}
	return {width, lineStyle, color};
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
	for (const token of v.split(/\s+/)) {
		if (/^[\d.]+$/.test(token)) {
			if (grow === undefined) grow = token;
			else if (shrink === undefined) shrink = token;
			else return null;
		} else if (basis === undefined) {
			basis = token;
		} else {
			return null;
		}
	}
	if (grow === undefined && basis === undefined) return null;
	return {
		"flex-grow": grow ?? "1",
		"flex-shrink": shrink ?? "1",
		"flex-basis": basis ?? (grow !== undefined ? "0%" : "auto"),
	};
}

/**
 * Expand the `list-style` shorthand, whose components may appear in any order.
 *
 * `none` is ambiguous -- it sets whichever of type/image has not been given --
 * but for a terminal there are no images, so it always means "no marker".
 */
function expandListStyle(value: string): Record<string, string> {
	const parts: Record<string, string> = {};
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

/**
 * Expand the `background` shorthand down to the two components a terminal can
 * render. Positions, repeats and attachments mean nothing on a cell grid and
 * are dropped; `none` is the IMAGE component, never a color, so the color a
 * bare `background: none` declares is its initial, transparent.
 */
function expandBackground(value: string): Record<string, string> {
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

/** An image value: a function that produces one, or the keyword for none. */
const IMAGE_VALUE =
	/^(?:none$|(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient|image|image-set|element|cross-fade|paint)\()/i;

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
	const out: Record<string, string> = {};
	const groups = value.split("/").map((group) => group.trim());
	const slice: string[] = [];
	const repeat: string[] = [];
	for (const token of splitComponents(groups[0] ?? "")) {
		if (BORDER_IMAGE_REPEATS.has(token.toLowerCase())) repeat.push(token);
		else if (IMAGE_VALUE.test(token)) out["border-image-source"] = token;
		else slice.push(token);
	}
	if (slice.length > 0) out["border-image-slice"] = slice.join(" ");
	if (repeat.length > 0) out["border-image-repeat"] = repeat.join(" ");
	if (groups[1]) out["border-image-width"] = groups[1];
	if (groups[2]) out["border-image-outset"] = groups[2];
	return out;
}

/**
 * Expand CSS SHORTHANDS into the longhands everything downstream reads.
 * Declarations are consulted per-property, so a `border: 1px solid` that
 * never becomes border-top-width etc. simply doesn't exist to the box model
 * or the border painter. Declaration order is preserved, so an explicit
 * longhand after a shorthand still overrides it.
 *
 * A shorthand keeps its own entry alongside the longhands it declares, so
 * `getPropertyValue("border")` still answers what was authored. `margin` and
 * `padding` are the exception: their computed answers are serialized from the
 * four longhands, so keeping the shorthand would shadow that.
 */
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
			case "border": {
				const {width, lineStyle, color} = splitLineValue(value);
				setEdges("width", [width ?? "medium"]);
				setEdges("style", [lineStyle ?? "none"]);
				if (color) setEdges("color", [color]);
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
			case "border-top":
			case "border-right":
			case "border-bottom":
			case "border-left": {
				const edge = property.slice("border-".length);
				const {width, lineStyle, color} = splitLineValue(value);
				out[`border-${edge}-width`] = width ?? "medium";
				out[`border-${edge}-style`] = lineStyle ?? "none";
				if (color) out[`border-${edge}-color`] = color;
				break;
			}
			case "outline": {
				const {width, lineStyle, color} = splitLineValue(value);
				out["outline-width"] = width ?? "medium";
				out["outline-style"] = lineStyle ?? "none";
				if (color) out["outline-color"] = color;
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
			case "overflow": {
				out["overflow-x"] = values[0];
				out["overflow-y"] = values[1] ?? values[0];
				break;
			}
			case "flex": {
				Object.assign(out, expandFlex(value) ?? {});
				break;
			}
			case "list-style":
				Object.assign(out, expandListStyle(value));
				break;
			case "background":
				Object.assign(out, expandBackground(value));
				break;
			case "text-decoration": {
				// `<line> || <style> || <color>`; only the line component has a
				// terminal rendering, and it is the one the painter reads.
				const line = values
					.filter((token) =>
						/^(none|underline|overline|line-through|blink)$/.test(token),
					)
					.join(" ");
				if (line) out["text-decoration-line"] = line;
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
	"border-radius": "0",
	"background-color": "transparent",
	color: "#000000",
	// One cell tall: the terminal's font is the grid, and a length written in
	// em is a length written in cells.
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
	// A group of controls in a labelled box, the way a browser draws one: a
	// border around the group with the legend sitting IN the top border line.
	// The legend gets there by rising one row onto the border and painting the
	// terminal's own background over the cells it covers -- which is what
	// "interrupting the border" is.
	fieldset: {
		display: "block",
		border: "1px solid",
		padding: "0 1ch",
	},
	legend: {
		display: "block",
		"margin-top": "-1px",
		"font-weight": "bold",
	},
	// A disclosure and its summary are both blocks, so the summary owns its
	// row and the body stacks under it. The marker and the open/closed glyph
	// are ::before rules in the UA document stylesheet.
	details: {display: "block"},
	summary: {display: "block", cursor: "pointer"},
	// A gauge is a flat field in the input family, sized like a browser's own
	// unstyled progress bar: a fixed track the fill is a fraction of.
	progress: {display: "inline-block", width: "10ch", "white-space": "pre"},
	meter: {display: "inline-block", width: "10ch", "white-space": "pre"},
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
	TERMINAL_ELEMENT_DEFAULTS[tag] = expandShorthands(declarations);
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
	// The defaults are keyed by the element's own name, which is what the
	// table is indexed by and what every branch below asks about. `tagName`
	// answers the same question in the document's case convention, deriving a
	// fresh string every time it is read; this is read once, per property, per
	// element, on the resolution path.
	// The sheet is HTML's. An element of the same local name in another
	// namespace -- the <select> a stray `<svg>` puts its children under -- is
	// not that element and has none of its interface.
	if (element.namespaceURI !== HTML_NAMESPACE) return undefined;
	const name = element.localName;
	const document = element.ownerDocument;
	// The browser's UA :fullscreen treatment: the fullscreen element fills
	// the viewport. Explicit cells rather than percentages -- the alternate
	// screen IS the containing geometry, and innerWidth/Height are its size.
	if (document !== null && document.fullscreenElement === element) {
		const window = document.defaultView;
		const base = TERMINAL_ELEMENT_DEFAULTS[name] ?? {};
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
	// A textarea's rows/cols are NOT defaults here: they size the CONTENT
	// box, and only layout knows what border and padding the cascade actually
	// left on the element to add around it. Baking the UA chrome into a
	// min-height/width constant left authors unable to unbake it with
	// `border: none`. See the textarea leaf sizing in layout.ts.
	if (name === "button") {
		const merged: Record<string, string> = {
			...TERMINAL_ELEMENT_DEFAULTS.button,
		};
		if (document?.activeElement === element) {
			merged["text-decoration-line"] = "underline";
		}
		return merged;
	}
	if (name === "select") {
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
		if (document?.activeElement === select) {
			merged["text-decoration-line"] = "underline";
		}
		return merged;
	}
	if (name === "input") {
		const input = element as HTMLInputElement;
		// The FOCUSED field gets the underline -- the UA "this is the live
		// one" signal, in plain SGR 4, the one underline every terminal and
		// every intermediary renders. Focus changes invalidate the
		// computed-style cache (see handleFocusChange), so this is
		// re-consulted at the right moments.
		const focused = document?.activeElement === input;
		if (input.type === "checkbox" || input.type === "radio") {
			// The compact glyph is bare when blurred; focus underlines it --
			// same live-wire language as the text field.
			return focused
				? {...CHECKBOX_DEFAULTS, "text-decoration-line": "underline"}
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
				merged["text-decoration-line"] = "underline";
			}
			return merged;
		}
	}
	return TERMINAL_ELEMENT_DEFAULTS[name];
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
	"text-decoration-color",
	"text-decoration-line",
	"text-decoration-style",
	"text-decoration-thickness",
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
 * A property's initial value on an element, or -- with no element, as for a
 * pseudo-element -- the initial value alone, which no element default has a
 * say in.
 */
export function getInitialStyle(
	element: Element | null,
	property: string,
): string {
	// Check element-specific defaults first
	const elementDefaults = element ? getElementDefaults(element) : null;
	if (elementDefaults && elementDefaults[property]) {
		return elementDefaults[property];
	}

	// Check universal defaults (*)
	const universalDefaults = TERMINAL_ELEMENT_DEFAULTS["*"];
	if (universalDefaults && universalDefaults[property]) {
		return universalDefaults[property];
	}

	// Fall back to CSS spec default, and past it to the property index --
	// every longhand has an initial value, and a property this engine does not
	// lay out still resolves to one.
	return CSS_SPEC_DEFAULTS[property] || CSS_INITIAL_VALUES[property] || "";
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
	datalist { display: none; }
	dialog:not([open]) { display: none; }
	details:not([open]) > :not(summary) { display: none; }
	details > summary:first-of-type::before { content: "▸ "; }
	details[open] > summary:first-of-type::before { content: "▾ "; }
	summary:focus-visible { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
	legend::before, legend::after { content: " "; white-space: pre; }
	a[href]:focus-visible { background-color: Highlight; color: HighlightText; }
	button:focus-visible { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
`;

// ---- Form-widget internal shadow stylesheets ----
/**
 * The UA stylesheet of a textarea's internal shadow tree. Unlike the input,
 * the textarea's parts render through the NORMAL pipeline -- the value text
 * node lays out, wraps and paints like any document text -- so these rules are
 * all there is: the placeholder's ghost gray, faint when the host is blurred,
 * hidden by the reconcile (an inline display:none) whenever a value exists,
 * and the focus outline, which the painter renders on the host's UA border
 * by repainting it in the outline color.
 */
export const TEXTAREA_UA_STYLES = `
	[part="placeholder"] { color: #808080; }
	:host(:not(:focus)) [part="placeholder"] { font-weight: lighter; }
	:host(:focus) { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
`;

/**
 * The UA stylesheet of an <input>'s internal shadow tree: the field design as
 * real, scoped CSS. The value and placeholder are single-line inline-blocks that
 * clip their text (the render loop sets scrollLeft to follow the caret); the
 * focus affordance is an `outline`, which the painter renders as a bottom
 * underline across the whole field in the outline color (a bordered field
 * would show it on the border instead). A blurred field carries no chrome.
 */
export const FIELD_UA_STYLES = `
	[part="value"], [part="placeholder"] { display: inline-block; white-space: pre; overflow: hidden; min-width: 1ch; max-width: 100%; vertical-align: top; }
	[part="placeholder"] { color: #808080; }
	:host(:focus) { outline-width: 1px; outline-style: solid; outline-color: #5fafff; }
`;

/**
 * The UA stylesheet of a progress bar's internal shadow tree.
 *
 * The track is the full-width box that clips; the bar is an inline-block whose
 * WIDTH is the fraction filled, so the fill is a real CSS length and the run of
 * block glyphs behind it is ordinary text. What follows the bar inside the same
 * clip is the groove, which is why an empty bar still reads as a bar.
 */
export const GAUGE_UA_STYLES = `
	[part="track"] { display: inline-block; width: 100%; overflow: hidden; white-space: pre; vertical-align: top; }
	[part="groove"] { color: #808080; font-weight: lighter; }
	[part="bar"] { display: inline-block; overflow: hidden; white-space: pre; vertical-align: top; }
`;

/**
 * The UA stylesheet of a progress bar, on top of the shared gauge rules: a
 * determinate bar is the accent color, and an indeterminate one has no bar at
 * all, so the groove alone shows.
 */
export const PROGRESS_UA_STYLES = `
	${GAUGE_UA_STYLES}
	[part="bar"] { color: #5fafff; }
`;

/**
 * The UA stylesheet of a meter, on top of the shared gauge rules. A meter's
 * value is read against its low/high/optimum ranges, and the level that reading
 * produces is what colors the bar -- the browser's own three-way answer,
 * spelled as an attribute a rule matches rather than a color the painter picks.
 */
export const METER_UA_STYLES = `
	${GAUGE_UA_STYLES}
	[part="bar"][data-level="optimum"] { color: #5faf5f; }
	[part="bar"][data-level="suboptimum"] { color: #d7af5f; }
	[part="bar"][data-level="even-less-good"] { color: #d75f5f; }
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
	[part="optgroup"] { display: block; white-space: pre; font-weight: bold; }
	[part="option"][data-grouped] { padding-left: 2ch; }
`;
