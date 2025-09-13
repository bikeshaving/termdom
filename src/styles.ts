/**
 * CSS System for Terminal DOM
 *
 * This module provides a way to override window.getComputedStyle() with terminal-appropriate
 * CSS property resolution. The core TermDOM class uses this to provide a custom CSS implementation.
 */

import {CSSStyleDeclaration} from "cssstyle";
import type {DOMWindow} from "jsdom";

// ============================================================================
// CSS DEFAULTS FOR TERMINAL ELEMENTS
// ============================================================================

/**
 * CSS specification defaults for properties
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

/**
 * Get the resolved value for a CSS property on an element
 * Used internally by TerminalComputedStyle
 */
function resolvePropertyValue(
	element: Element,
	property: string,
	followInheritance = true,
): string {
	const style = (element as HTMLElement).style;
	if (!style) {
		return getInitialStyle(element, property);
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
		return inlineValue;
	}

	return getInitialStyle(element, property);
}

/**
 * Get the initial/default value for a property on an element
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
// COMPUTED STYLE CLASS
// ============================================================================

/**
 * Custom computed style that implements the DOM CSSStyleDeclaration interface
 * This provides a 1-to-1 interface with the browser's getComputedStyle result
 */
class TerminalComputedStyle extends CSSStyleDeclaration {
	constructor(private element: Element) {
		// Initialize with no onChange callback since this is read-only computed style
		super();

		// Pre-populate with all our resolved values
		this.populateDeclaration();
	}

	private populateDeclaration(): void {
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
		];

		// Resolve each property and set it in the declaration
		for (const property of properties) {
			const value = resolvePropertyValue(this.element, property);
			if (value) {
				super.setProperty(property, value);
			}
		}
	}

	// Override getPropertyValue to use our terminal-specific resolution
	override getPropertyValue(property: string): string {
		// First check if we have a cached value from populateDeclaration
		const cachedValue = super.getPropertyValue(property);
		if (cachedValue) {
			return this.normalizeForTerminal(property, cachedValue);
		}

		// If not in our pre-populated cache, resolve it fresh
		// (This handles properties not in our common list)
		const freshValue = resolvePropertyValue(this.element, property);
		return this.normalizeForTerminal(property, freshValue);
	}

	/**
	 * Apply terminal-specific normalization to computed values
	 * This allows us to override cssstyle's default normalization
	 */
	private normalizeForTerminal(property: string, value: string): string {
		if (!value) return value;

		// Example: Convert pixel measurements to character units for terminals
		// if (property === 'width' || property === 'height') {
		// 	// Convert px to ch (assuming 1ch = 8px for typical monospace)
		// 	if (value.endsWith('px')) {
		// 		const pixels = parseFloat(value);
		// 		const chars = Math.round(pixels / 8);
		// 		return `${chars}ch`;
		// 	}
		// }

		// Example: Prevent shorthand expansion for certain properties
		// if (property === 'margin') {
		// 	// Keep original shorthand instead of expanded form
		// 	const original = resolvePropertyValue(this.element, property);
		// 	if (original && original !== '0') {
		// 		return original; // Return original shorthand
		// 	}
		// }

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
	const computedStyle = new TerminalComputedStyle(element);

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

// ============================================================================
// COLOR UTILITIES
// ============================================================================

/**
 * Convert CSS color string to numeric color value
 */
export function cssColorToNumber(cssColor: string): number {
	if (!cssColor || cssColor === "transparent" || cssColor === "none") {
		return 0;
	}

	const colorNumber = Bun.color(cssColor, "number");
	return typeof colorNumber === "number" ? colorNumber : 0;
}

/**
 * Darken a color by a given factor
 */
export function darkenColor(color: number, factor: number): number {
	const r = (color >> 16) & 0xff;
	const g = (color >> 8) & 0xff;
	const b = color & 0xff;

	return (
		(Math.floor(r * (1 - factor)) << 16) |
		(Math.floor(g * (1 - factor)) << 8) |
		Math.floor(b * (1 - factor))
	);
}

// ============================================================================
// LIST UTILITIES
// ============================================================================

/**
 * Convert a number to Roman numeral representation
 */
export function toRoman(num: number): string {
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

	let result = "";
	for (const {value, symbol} of romanNumerals) {
		while (num >= value) {
			result += symbol;
			num -= value;
		}
	}
	return result;
}

/**
 * Calculate nesting depth of a list item
 */
export function getListNestingDepth(listItem: Element): number {
	let depth = 0;
	let current = listItem.parentElement;

	while (current) {
		if (current.tagName === "UL" || current.tagName === "OL") {
			depth++;
		}
		current = current.parentElement;
	}

	return depth - 1; // Zero-based depth (first level = 0)
}

/**
 * Generate appropriate list marker for a list item
 */
export function getListMarker(listItem: Element, listParent: Element): string {
	const listType = listParent.tagName.toLowerCase();
	const listStyleType = new TerminalComputedStyle(listParent).getPropertyValue(
		"list-style-type",
	);
	const nestingDepth = getListNestingDepth(listItem);

	if (listType === "ol") {
		// Ordered list - get the item index and format as number
		const items = Array.from(listParent.children).filter(
			(child) => child.tagName === "LI",
		);
		const index = items.indexOf(listItem as HTMLLIElement);
		if (index === -1) return "";

		const start = parseInt(listParent.getAttribute("start") || "1", 10);
		const itemNumber = start + index;

		switch (listStyleType) {
			case "decimal":
			default:
				return `${itemNumber}.`;
			case "lower-alpha":
				return `${String.fromCharCode(96 + (itemNumber % 26))}.`;
			case "upper-alpha":
				return `${String.fromCharCode(64 + (itemNumber % 26))}.`;
			case "lower-roman":
				return `${toRoman(itemNumber).toLowerCase()}.`;
			case "upper-roman":
				return `${toRoman(itemNumber)}.`;
		}
	} else if (listType === "ul") {
		// Unordered list - use bullet characters based on nesting depth if no explicit style
		if (listStyleType === "disc" || !listStyleType) {
			// Auto-select bullet based on nesting level
			const bullets = ["•", "◦", "▪", "▫"];
			return bullets[nestingDepth % bullets.length];
		}

		switch (listStyleType) {
			case "disc":
				return "•";
			case "circle":
				return "◦";
			case "square":
				return "▪";
		}
	}

	return "";
}

// ============================================================================
// COMPUTED STYLE OVERRIDE
// ============================================================================

/**
 * CSS Style Manager
 * Handles computed style caching and invalidation for terminal DOM
 */
export class StyleManager {
	private computedStyleCache = new WeakMap<Element, TerminalComputedStyle>();

	constructor(private window: DOMWindow) {
		// Override window.getComputedStyle with our cached version
		window.getComputedStyle = this.getComputedStyle.bind(this);

		// Hook into methods that should invalidate cached styles
		this.setupInvalidationHooks();
	}

	private getComputedStyle(
		element: Element,
		_pseudoElt?: string | null,
	): globalThis.CSSStyleDeclaration {
		// For now, we ignore pseudoElt parameter (could be ::before, ::after, etc.)

		// Check cache first
		let computedStyle = this.computedStyleCache.get(element);
		if (!computedStyle) {
			// Create new instance and cache it
			computedStyle = new TerminalComputedStyle(element);
			this.computedStyleCache.set(element, computedStyle);
		}

		return computedStyle as unknown as globalThis.CSSStyleDeclaration;
	}

	private setupInvalidationHooks(): void {
		const styleManager = this;
		const Element = this.window.Element;
		const originalSetAttribute = Element.prototype.setAttribute;
		const originalRemoveAttribute = Element.prototype.removeAttribute;

		// Hook setAttribute to catch style attribute changes
		Element.prototype.setAttribute = function (name: string, value: string) {
			const result = originalSetAttribute.call(this, name, value);

			// Only invalidate for direct style attribute changes
			// (When we add stylesheet support, we'll need smarter invalidation)
			if (name === "style") {
				styleManager.invalidateElement(this);
			}

			return result;
		};

		// Hook removeAttribute to catch style attribute removal
		Element.prototype.removeAttribute = function (name: string) {
			const result = originalRemoveAttribute.call(this, name);

			// Only invalidate for direct style attribute removal
			if (name === "style") {
				styleManager.invalidateElement(this);
			}

			return result;
		};

		// Store wrapped styles to avoid double-wrapping
		const wrappedStyles = new WeakSet();

		// Find where the style property is defined in the prototype chain
		let stylePropertyOwner = null;
		let proto = this.window.HTMLElement.prototype;
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
		this.computedStyleCache.delete(element);
	}

	/**
	 * Clear all cached computed styles (nuclear option)
	 */
	clearCache(): void {
		this.computedStyleCache = new WeakMap();
	}
}
