/**
 * Terminal CSS System
 *
 * This module provides CSS property resolution and classification specifically
 * designed for terminal UIs.
 *
 * WHY WE DON'T SUPPORT STYLESHEETS/SELECTORS:
 * 1. JSDOM's cascade implementation is incomplete:
 *    - No CSS specificity calculation (uses source order only)
 *    - No proper !important handling
 *    - Incomplete inheritance support
 * 2. Terminal UIs are typically built programmatically with inline styles
 * 3. Avoiding cascade complexity makes the system more predictable and
 *   debuggable
 *
 * WHY WE DON'T USE getComputedStyle():
 * 1. Real browsers resolve units to pixels ("10ch" → "80px") - we want
 *   semantic units
 * 2. JSDOM's getComputedStyle() has broken cascade resolution which would
 *   work, but we don't want to rely on non-compliant behavior
 * 3. We need predictable behavior across environments
 *
 * WHAT THIS MODULE PROVIDES:
 * - Inline style resolution with proper inheritance
 * - some CSS keyword handling (inherit, initial, unset)
 * - Preservation of semantic units (ch, em, %, etc.)
 * - Terminal-appropriate default values per element type
 */

// ============================================================================
// PROPERTY CLASSIFICATION
// ============================================================================

/**
 * Layout properties that affect element positioning, sizing, or text flow.
 * These properties CANNOT use CSS keywords (inherit, initial, unset) to keep
 * layout invalidation simple and predictable.
 *
 * When these properties change, only the specific element needs re-layout.
 */
export const LAYOUT_PROPERTIES = new Set([
	// Box dimensions
	"width",
	"height",
	"min-width",
	"min-height",
	"max-width",
	"max-height",

	// Spacing
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

	// Borders (affect terminal cell layout through box-drawing characters)
	"border",
	"border-width",
	"border-style",
	"border-top",
	"border-right",
	"border-bottom",
	"border-left",
	"border-top-width",
	"border-right-width",
	"border-bottom-width",
	"border-left-width",
	"border-top-style",
	"border-right-style",
	"border-bottom-style",
	"border-left-style",

	// Display and positioning
	"display",
	"position",
	"top",
	"right",
	"bottom",
	"left",
	"overflow",
	"overflow-x",
	"overflow-y",
	"z-index",

	// Flexbox layout
	"flex-direction",
	"flex-wrap",
	"justify-content",
	"align-items",
	"align-content",
	"flex",
	"flex-grow",
	"flex-shrink",
	"flex-basis",
	"align-self",
	"order",

	// Text layout properties that affect positioning/wrapping
	"text-align",
	"white-space",
]);

/**
 * Visual properties that affect appearance but not layout.
 * These properties CAN use CSS keywords and inherit normally.
 *
 * When these properties change, only the rendering of the specific element
 * needs to be updated (no layout recalculation needed).
 */
export const VISUAL_PROPERTIES = new Set([
	// Text and background colors
	"color",
	"background-color",
	"background", // shorthand

	// Border colors (border width/style affect layout, but color is purely visual)
	"border-color",
	"border-top-color",
	"border-right-color",
	"border-bottom-color",
	"border-left-color",
]);

/**
 * All supported CSS properties in Terminal DOM.
 * Any property not in this set is ignored entirely.
 */
export const SUPPORTED_PROPERTIES = new Set([
	...LAYOUT_PROPERTIES,
	...VISUAL_PROPERTIES,
]);

// ============================================================================
// INHERITANCE CLASSIFICATION
// ============================================================================

/**
 * CSS properties that inherit from parent by default
 * Based on CSS spec: https://www.w3.org/TR/CSS21/propidx.html
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

// ============================================================================
// DEFAULT VALUES
// ============================================================================

/**
 * CSS specification defaults for properties
 * These apply when no other value is found
 */
const CSS_SPEC_DEFAULTS: Record<string, string> = {
	display: "inline",
	margin: "0",
	"margin-top": "0",
	"margin-right": "0",
	"margin-bottom": "0",
	"margin-left": "0",
	padding: "0",
	"padding-top": "0",
	"padding-right": "0",
	"padding-bottom": "0",
	"padding-left": "0",
	"border-width": "0",
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
};

/**
 * Terminal-specific defaults per element type
 * These override CSS spec defaults to be appropriate for terminal UIs
 */
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
	ul: {display: "block", "padding-left": "2ch"},
	ol: {display: "block", "padding-left": "2ch"},
	li: {display: "block"},
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
	small: {display: "inline"},
	abbr: {display: "inline"},
	cite: {display: "inline", "font-style": "italic"},
	dfn: {display: "inline", "font-style": "italic"},
	mark: {display: "inline"},
	time: {display: "inline"},
	q: {display: "inline"},
	label: {display: "inline"},
	br: {display: "inline"},

	// Terminal UI controls
	button: {
		display: "inline-block",
		border: "1px solid",
		padding: "0 1ch",
		cursor: "pointer",
	},
	input: {
		display: "inline-block",
		border: "1px solid",
		padding: "0 1ch",
	},
	textarea: {
		display: "inline-block",
		border: "1px solid",
		padding: "0 1ch",
	},
	select: {
		display: "inline-block",
		border: "1px solid",
		padding: "0 1ch",
	},

	// Tables
	table: {display: "table", "border-collapse": "collapse"},
	thead: {display: "table-header-group"},
	tbody: {display: "table-row-group"},
	tfoot: {display: "table-footer-group"},
	tr: {display: "table-row"},
	td: {
		display: "table-cell",
		border: "1px solid",
		padding: "0 1ch",
	},
	th: {
		display: "table-cell",
		border: "1px solid",
		padding: "0 1ch",
		"font-weight": "bold",
	},
};

const INITIAL_KEYWORDS = new Set([
	"initial",
	"unset",
	"revert",
	"revert-layer",
]);

/**
 * Get the resolved value for a CSS property on an element.
 * Resolution order:
 * 1. Inline style value (if not a keyword)
 * 2. Handles some CSS keywords (inherit, initial, unset)
 * 3. Fall back to element-specific defaults
 * 4. Fall back to CSS spec defaults
 *
 * @param element - The DOM element
 * @param property - The CSS property name (kebab-case, e.g. 'margin-left')
 * @returns The resolved value with original units preserved (e.g. '10ch', '50%')
 */
export function resolvePropertyValue(
	element: Element,
	property: string,
	followInheritance = true,
): string {
	const style = (element as HTMLElement).style;
	if (!style) {
		return "";
	}

	const inlineValue = style.getPropertyValue(property).trim();
	if (INITIAL_KEYWORDS.has(inlineValue)) {
		return getInitialStyle(element, property);
	} else if (
		followInheritance &&
		(inlineValue === "inherit" ||
			(!inlineValue && INHERITED_PROPERTIES.has(property)))
	) {
		for (
			let parentElement = element.parentElement;
			parentElement !== null;
			parentElement = parentElement.parentElement
		) {
			const parentStyle = (parentElement as HTMLElement).style;
			if (parentStyle && parentStyle.getPropertyValue(property)) {
				return resolvePropertyValue(parentElement, property);
			}
		}

		return getInitialStyle(element, property);
	} else if (inlineValue) {
		// If we have a concrete value, use it
		return inlineValue;
	}

	// Fall back to defaults
	return getInitialStyle(element, property);
}

/**
 * Get the initial/default value for a property on an element.
 *
 * @param element - The DOM element
 * @param property - The CSS property name
 * @returns The initial value for this element type and property
 */
function getInitialStyle(element: Element, property: string): string {
	const tagName = element.tagName.toLowerCase();

	// Check element-specific defaults first
	const elementDefaults = TERMINAL_ELEMENT_DEFAULTS[tagName];
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
