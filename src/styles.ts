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

import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";

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
	"border-color",
	"border-top-color",
	"border-right-color",
	"border-bottom-color",
	"border-left-color",

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

// ============================================================================
// YOGA LAYOUT INTEGRATION
// ============================================================================

interface EnumMap {
	align: YogaTypes.Align;
	justify: YogaTypes.Justify;
	wrap: YogaTypes.Wrap;
}

function getYogaConstant<TEnumName extends keyof EnumMap>(
	enumName: TEnumName,
	propertyName: string,
): EnumMap[TEnumName] | null {
	const name =
		enumName.toUpperCase() + "_" + propertyName.replace("-", "_").toUpperCase();
	return (Yoga as any)[name] || null;
}

function parseUnitValue(value: string): number | {percentage: number} | null {
	if (!value || !/^\d/.test(value)) {
		return null;
	}

	if (value.endsWith("%")) {
		const num = parseFloat(value.slice(0, -1));
		if (isNaN(num)) return null;
		return {percentage: num};
	}

	const num = parseFloat(value);
	return isNaN(num) ? null : num;
}

export function styleYogaNode(element: Element, yogaNode: YogaTypes.Node): void {
	const width = parseUnitValue(resolvePropertyValue(element, "width", false));
	if (typeof width === "number") {
		yogaNode.setWidth(width);
	} else if (width && "percentage" in width) {
		yogaNode.setWidthPercent(width.percentage);
	} else {
		yogaNode.setWidthAuto();
	}

	const heightValue = resolvePropertyValue(element, "height", false);
	const height = parseUnitValue(heightValue);
	if (typeof height === "number") {
		yogaNode.setHeight(height);
	} else if (height && "percentage" in height) {
		yogaNode.setHeightPercent(height.percentage);
	} else {
		yogaNode.setHeightAuto();
	}

	const minWidth = parseUnitValue(
		resolvePropertyValue(element, "min-width", false),
	);
	if (typeof minWidth === "number") {
		yogaNode.setMinWidth(minWidth);
	} else if (minWidth && "percentage" in minWidth) {
		yogaNode.setMinWidthPercent(minWidth.percentage);
	} else {
		yogaNode.setMinWidth(undefined);
	}

	const minHeight = parseUnitValue(
		resolvePropertyValue(element, "min-height", false),
	);
	if (typeof minHeight === "number") {
		yogaNode.setMinHeight(minHeight);
	} else if (minHeight && "percentage" in minHeight) {
		yogaNode.setMinHeightPercent(minHeight.percentage);
	} else {
		yogaNode.setMinHeight(undefined);
	}

	const maxWidth = parseUnitValue(
		resolvePropertyValue(element, "max-width", false),
	);
	if (typeof maxWidth === "number") {
		yogaNode.setMaxWidth(maxWidth);
	} else if (maxWidth && "percentage" in maxWidth) {
		yogaNode.setMaxWidthPercent(maxWidth.percentage);
	} else {
		yogaNode.setMaxWidth(undefined);
	}

	const maxHeight = parseUnitValue(
		resolvePropertyValue(element, "max-height", false),
	);
	if (typeof maxHeight === "number") {
		yogaNode.setMaxHeight(maxHeight);
	} else if (maxHeight && "percentage" in maxHeight) {
		yogaNode.setMaxHeightPercent(maxHeight.percentage);
	} else {
		yogaNode.setMaxHeight(undefined);
	}

	const marginTop = parseUnitValue(
		resolvePropertyValue(element, "margin-top", false),
	);
	if (typeof marginTop === "number") {
		yogaNode.setMargin(Yoga.EDGE_TOP, marginTop);
	} else if (marginTop && "percentage" in marginTop) {
		yogaNode.setMarginPercent(Yoga.EDGE_TOP, marginTop.percentage);
	} else {
		const originalValue = resolvePropertyValue(element, "margin-top", false);
		if (originalValue === "auto") {
			yogaNode.setMarginAuto(Yoga.EDGE_TOP);
		} else {
			yogaNode.setMargin(Yoga.EDGE_TOP, undefined);
		}
	}
	const marginRight = parseUnitValue(
		resolvePropertyValue(element, "margin-right", false),
	);
	if (typeof marginRight === "number") {
		yogaNode.setMargin(Yoga.EDGE_RIGHT, marginRight);
	} else if (marginRight && "percentage" in marginRight) {
		yogaNode.setMarginPercent(Yoga.EDGE_RIGHT, marginRight.percentage);
	} else {
		const originalValue = resolvePropertyValue(element, "margin-right", false);
		if (originalValue === "auto") {
			yogaNode.setMarginAuto(Yoga.EDGE_RIGHT);
		} else {
			yogaNode.setMargin(Yoga.EDGE_RIGHT, undefined);
		}
	}
	const marginBottom = parseUnitValue(
		resolvePropertyValue(element, "margin-bottom", false),
	);
	if (typeof marginBottom === "number") {
		yogaNode.setMargin(Yoga.EDGE_BOTTOM, marginBottom);
	} else if (marginBottom && "percentage" in marginBottom) {
		yogaNode.setMarginPercent(Yoga.EDGE_BOTTOM, marginBottom.percentage);
	} else {
		const originalValue = resolvePropertyValue(element, "margin-bottom", false);
		if (originalValue === "auto") {
			yogaNode.setMarginAuto(Yoga.EDGE_BOTTOM);
		} else {
			yogaNode.setMargin(Yoga.EDGE_BOTTOM, undefined);
		}
	}

	const marginLeft = parseUnitValue(
		resolvePropertyValue(element, "margin-left", false),
	);
	if (typeof marginLeft === "number") {
		yogaNode.setMargin(Yoga.EDGE_LEFT, marginLeft);
	} else if (marginLeft && "percentage" in marginLeft) {
		yogaNode.setMarginPercent(Yoga.EDGE_LEFT, marginLeft.percentage);
	} else {
		const originalValue = resolvePropertyValue(element, "margin-left", false);
		if (originalValue === "auto") {
			yogaNode.setMarginAuto(Yoga.EDGE_LEFT);
		} else {
			yogaNode.setMargin(Yoga.EDGE_LEFT, undefined);
		}
	}

	const paddingTop = parseUnitValue(
		resolvePropertyValue(element, "padding-top", false),
	);
	if (typeof paddingTop === "number") {
		yogaNode.setPadding(Yoga.EDGE_TOP, paddingTop);
	} else if (paddingTop && "percentage" in paddingTop) {
		yogaNode.setPaddingPercent(Yoga.EDGE_TOP, paddingTop.percentage);
	} else {
		yogaNode.setPadding(Yoga.EDGE_TOP, undefined);
	}

	const paddingRight = parseUnitValue(
		resolvePropertyValue(element, "padding-right", false),
	);
	if (typeof paddingRight === "number") {
		yogaNode.setPadding(Yoga.EDGE_RIGHT, paddingRight);
	} else if (paddingRight && "percentage" in paddingRight) {
		yogaNode.setPaddingPercent(Yoga.EDGE_RIGHT, paddingRight.percentage);
	} else {
		yogaNode.setPadding(Yoga.EDGE_RIGHT, undefined);
	}

	const paddingBottom = parseUnitValue(
		resolvePropertyValue(element, "padding-bottom", false),
	);
	if (typeof paddingBottom === "number") {
		yogaNode.setPadding(Yoga.EDGE_BOTTOM, paddingBottom);
	} else if (paddingBottom && "percentage" in paddingBottom) {
		yogaNode.setPaddingPercent(Yoga.EDGE_BOTTOM, paddingBottom.percentage);
	} else {
		yogaNode.setPadding(Yoga.EDGE_BOTTOM, undefined);
	}

	const paddingLeft = parseUnitValue(
		resolvePropertyValue(element, "padding-left", false),
	);
	if (typeof paddingLeft === "number") {
		yogaNode.setPadding(Yoga.EDGE_LEFT, paddingLeft);
	} else if (paddingLeft && "percentage" in paddingLeft) {
		yogaNode.setPaddingPercent(Yoga.EDGE_LEFT, paddingLeft.percentage);
	} else {
		yogaNode.setPadding(Yoga.EDGE_LEFT, undefined);
	}

	// Border width calculations for layout
	const borderTopWidth = parseUnitValue(resolvePropertyValue(element, "border-top-width", false));
	if (typeof borderTopWidth === "number" && borderTopWidth > 0) {
		yogaNode.setBorder(Yoga.EDGE_TOP, borderTopWidth);
	} else {
		yogaNode.setBorder(Yoga.EDGE_TOP, 0);
	}

	const borderRightWidth = parseUnitValue(resolvePropertyValue(element, "border-right-width", false));
	if (typeof borderRightWidth === "number" && borderRightWidth > 0) {
		yogaNode.setBorder(Yoga.EDGE_RIGHT, borderRightWidth);
	} else {
		yogaNode.setBorder(Yoga.EDGE_RIGHT, 0);
	}

	const borderBottomWidth = parseUnitValue(resolvePropertyValue(element, "border-bottom-width", false));
	if (typeof borderBottomWidth === "number" && borderBottomWidth > 0) {
		yogaNode.setBorder(Yoga.EDGE_BOTTOM, borderBottomWidth);
	} else {
		yogaNode.setBorder(Yoga.EDGE_BOTTOM, 0);
	}

	const borderLeftWidth = parseUnitValue(resolvePropertyValue(element, "border-left-width", false));
	if (typeof borderLeftWidth === "number" && borderLeftWidth > 0) {
		yogaNode.setBorder(Yoga.EDGE_LEFT, borderLeftWidth);
	} else {
		yogaNode.setBorder(Yoga.EDGE_LEFT, 0);
	}

	if (
		element.parentElement &&
		resolvePropertyValue(element.parentElement, "display") === "block"
	) {
		yogaNode.setFlexGrow(0);
		yogaNode.setFlexShrink(0);
		yogaNode.setFlexBasisAuto();
		yogaNode.setAlignSelf(Yoga.ALIGN_AUTO);
	} else {
		const flexGrow = resolvePropertyValue(element, "flex-grow", false);
		const growValue = parseFloat(flexGrow);
		if (!isNaN(growValue) && growValue >= 0) {
			yogaNode.setFlexGrow(growValue);
		} else {
			yogaNode.setFlexGrow(undefined);
		}

		const flexShrink = resolvePropertyValue(element, "flex-shrink", false);
		const shrinkValue = parseFloat(flexShrink);
		if (!isNaN(shrinkValue) && shrinkValue >= 0) {
			yogaNode.setFlexShrink(shrinkValue);
		} else {
			yogaNode.setFlexShrink(undefined);
		}

		const flexBasis = parseUnitValue(
			resolvePropertyValue(element, "flex-basis", false),
		);
		if (typeof flexBasis === "number") {
			yogaNode.setFlexBasis(flexBasis);
		} else if (flexBasis && "percentage" in flexBasis) {
			yogaNode.setFlexBasisPercent(flexBasis.percentage);
		} else {
			const originalValue = resolvePropertyValue(element, "flex-basis", false);
			if (originalValue === "auto") {
				yogaNode.setFlexBasisAuto();
			} else {
				yogaNode.setFlexBasis(undefined);
			}
		}

		const alignSelf = resolvePropertyValue(element, "align-self", false);
		if (alignSelf === "auto") {
			yogaNode.setAlignSelf(Yoga.ALIGN_AUTO);
		} else {
			const alignValue = getYogaConstant("align", alignSelf);
			if (alignValue !== null) {
				yogaNode.setAlignSelf(alignValue);
			} else {
				yogaNode.setAlignSelf(Yoga.ALIGN_AUTO);
			}
		}
	}

	const display = resolvePropertyValue(element, "display");
	if (display === "none") {
		yogaNode.setDisplay(Yoga.DISPLAY_NONE);
	} else if (display === "flex") {
		yogaNode.setDisplay(Yoga.DISPLAY_FLEX);

		const flexDirection = resolvePropertyValue(element, "flex-direction");
		if (flexDirection === "row") {
			yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
		} else if (flexDirection === "row-reverse") {
			yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW_REVERSE);
		} else if (flexDirection === "column") {
			yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
		} else if (flexDirection === "column-reverse") {
			yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN_REVERSE);
		} else {
			yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
		}

		const flexWrap = resolvePropertyValue(element, "flex-wrap");
		if (flexWrap === "nowrap") {
			yogaNode.setFlexWrap(Yoga.WRAP_NO_WRAP);
		} else if (flexWrap === "wrap") {
			yogaNode.setFlexWrap(Yoga.WRAP_WRAP);
		} else if (flexWrap === "wrap-reverse") {
			yogaNode.setFlexWrap(Yoga.WRAP_WRAP_REVERSE);
		} else {
			yogaNode.setFlexWrap(Yoga.WRAP_NO_WRAP);
		}

		const justifyContent = resolvePropertyValue(element, "justify-content");
		const justifyValue = getYogaConstant("justify", justifyContent);
		if (justifyValue !== null) {
			yogaNode.setJustifyContent(justifyValue);
		} else {
			yogaNode.setJustifyContent(Yoga.JUSTIFY_FLEX_START);
		}

		const alignItems = resolvePropertyValue(element, "align-items");
		const alignValue = getYogaConstant("align", alignItems);
		if (alignValue !== null) {
			yogaNode.setAlignItems(alignValue);
		} else {
			yogaNode.setAlignItems(Yoga.ALIGN_STRETCH);
		}

		const alignContent = resolvePropertyValue(element, "align-content");
		const alignContentValue = getYogaConstant("align", alignContent);
		if (alignContentValue !== null) {
			yogaNode.setAlignContent(alignContentValue);
		} else {
			yogaNode.setAlignContent(Yoga.ALIGN_FLEX_START);
		}
	} else {
		yogaNode.setDisplay(Yoga.DISPLAY_FLEX);
		yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
		yogaNode.setAlignItems(Yoga.ALIGN_STRETCH);
	}
}

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
	// Helper to encode individual edge
	const encodeEdge = (width: string, style: string, isRounded: boolean): number => {
		const widthValue = parseFloat(width);
		if (isNaN(widthValue) || widthValue <= 0 || !style || style === "none") {
			return 0; // No border
		}
		
		// Encode style
		let encodedStyle = 0;
		switch (style) {
			case "solid": encodedStyle = 1; break;
			case "double": encodedStyle = 2; break;
			case "dashed": encodedStyle = 3; break;
			case "dotted": encodedStyle = 4; break;
			case "groove": encodedStyle = 5; break;
			case "ridge": encodedStyle = 6; break;
			default: encodedStyle = 1; // Default to solid
		}
		
		// Add presence and rounded flags
		let edgeValue = encodedStyle;
		edgeValue |= (1 << 3); // BORDER_EDGE_PRESENCE
		if (isRounded) {
			edgeValue |= (1 << 4); // BORDER_EDGE_ROUNDED
		}
		
		return edgeValue;
	};
	
	// Check for border-radius (applies to all corners)
	const borderRadius = parseFloat(resolvePropertyValue(element, "border-radius", false));
	const hasRadius = !isNaN(borderRadius) && borderRadius > 0;
	
	// Resolve individual edges (check both shorthand and individual properties)
	const topWidth = resolvePropertyValue(element, "border-top-width", false) || resolvePropertyValue(element, "border-width", false);
	const topStyle = resolvePropertyValue(element, "border-top-style", false) || resolvePropertyValue(element, "border-style", false);
	
	const rightWidth = resolvePropertyValue(element, "border-right-width", false) || resolvePropertyValue(element, "border-width", false);
	const rightStyle = resolvePropertyValue(element, "border-right-style", false) || resolvePropertyValue(element, "border-style", false);
	
	const bottomWidth = resolvePropertyValue(element, "border-bottom-width", false) || resolvePropertyValue(element, "border-width", false);
	const bottomStyle = resolvePropertyValue(element, "border-bottom-style", false) || resolvePropertyValue(element, "border-style", false);
	
	const leftWidth = resolvePropertyValue(element, "border-left-width", false) || resolvePropertyValue(element, "border-width", false);
	const leftStyle = resolvePropertyValue(element, "border-left-style", false) || resolvePropertyValue(element, "border-style", false);
	
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
		hasAnyBorder: topEdge > 0 || rightEdge > 0 || bottomEdge > 0 || leftEdge > 0
	};
}

// ============================================================================
// BOX-DRAWING CHARACTER SETS
// ============================================================================

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

export const BOX_DRAWING = {
	// ASCII fallback for maximum compatibility
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
	} as BoxCharSet,
	
	// Unicode light box drawing (solid borders)
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
	} as BoxCharSet,
	
	// Unicode heavy box drawing (bold/thick borders)
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
	} as BoxCharSet,
	
	// Unicode double-line box drawing
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
	} as BoxCharSet,
	
	// Unicode dashed borders
	dashed: {
		horizontal: "╌",
		vertical: "┆",
		topLeft: "┌", // Fall back to light corners
		topRight: "┐",
		bottomLeft: "└", 
		bottomRight: "┘",
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	} as BoxCharSet,
	
	// Unicode dotted borders  
	dotted: {
		horizontal: "┄",
		vertical: "┊",
		topLeft: "┌", // Fall back to light corners
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘", 
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	} as BoxCharSet,
	
	// Unicode light rounded corners (border-radius support)
	lightRounded: {
		horizontal: "─",
		vertical: "│",
		topLeft: "╭",
		topRight: "╮", 
		bottomLeft: "╰",
		bottomRight: "╯",
		// No rounded T-junctions - fall back to sharp
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├", 
		cross: "┼",
	} as BoxCharSet,
};
