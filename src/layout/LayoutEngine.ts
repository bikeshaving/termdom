/**
 * LayoutEngine - Yoga layout integration for HTML-to-Terminal rendering
 *
 * Provides flexbox layout capabilities using Facebook's Yoga layout engine.
 * Maps CSS styles to Yoga properties and computes element positions/sizes.
 * Works with standard HTML elements enhanced with Symbol properties.
 */

import type {DOMWindow} from "jsdom";
import {
	ELEMENT_BOUNDS,
	ELEMENT_RECTS,
	ELEMENT_TEXT_RECTS,
	YOGA_NODE,
	type TextRect,
} from "../core/TermDOM.js";
import {TextMeasurement} from "./TextMeasurement.js";
import {
	TextBreaker,
	type InlineElement,
	type BreakResult,
} from "../text/TextBreaker.js";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import { getResolvedStyle } from "../css.js";

/**
 * Layout Engine using Yoga for flexbox calculations
 */
export class LayoutEngine {
	private yoga: typeof Yoga;
	private window: DOMWindow;
	// Viewport root removed - documentElement is now the direct Yoga root
	private yogaConfig: YogaTypes.Config;

	textBreaker: TextBreaker;
	constructor(window: DOMWindow) {
		this.yoga = Yoga;
		this.textBreaker = new TextBreaker();
		this.window = window;

		// Create Yoga config optimized for web-compatible terminal layout
		this.yogaConfig = this.yoga.Config.create();
		this.yogaConfig.setPointScaleFactor(1.0); // Force integer calculations for character grid
		this.yogaConfig.setUseWebDefaults(true); // Use web-compatible defaults for flex-direction, align-content, flex-shrink
	}

	private computingLayout = false;

	/**
	 * Compute layout for an element tree using Yoga
	 */
	computeLayout(
		root: Element,
		containerWidth: number,
		containerHeight: number,
		isInitialLayout: boolean = false,
	): void {
		if (this.computingLayout) {
			return;
		}

		this.computingLayout = true;
		console.log('\n>>> COMPUTE LAYOUT CALLED <<<');
		console.log(`Computing layout for ${(root as any).tagName || 'non-HTML'}`);
		this.buildingYogaTreeFor.clear(); // Clear any previous state

		if (!(root instanceof this.window.HTMLElement)) {
			// Skip non-HTML elements (like Document, Text nodes)
			// Convert NodeList to array for iteration
			const children = Array.from(root.childNodes);
			for (const child of children) {
				if (child.nodeType === this.window.Node.ELEMENT_NODE) {
					this.computeLayout(child as Element, containerWidth, containerHeight);
				}
			}
			this.computingLayout = false;
			return;
		}

		// Now TypeScript knows root is HTMLElement
		const htmlRoot = root;

		// Yoga tree should already be built by MutationObserver
		// Only ensure root has a node (for initial setup)
		if (!htmlRoot[YOGA_NODE]) {
			this.setupYogaNode(htmlRoot);
		} else {
			// Reapply styles since they might have changed
			this.reapplyStylesRecursively(htmlRoot);
		}

		// documentElement is now the direct Yoga root
		const htmlRootYoga = htmlRoot[YOGA_NODE]!;
		
		// CRITICAL: Set the HTML element to fill the terminal dimensions
		// Without this, HTML has auto dimensions and won't constrain children properly
		htmlRootYoga.setWidth(containerWidth);
		htmlRootYoga.setHeight(containerHeight);

		// Compute layout directly from documentElement with container dimensions
		htmlRootYoga.calculateLayout(containerWidth, containerHeight);

		// Extract layout starting from document.documentElement at (0, 0)
		this.extractLayout(htmlRoot, 0, 0);

		// Layout complete

		this.computingLayout = false;
	}

	/**
	 * Create Yoga node for a newly added element and attach it to the parent's Yoga tree
	 */
	createYogaNodeForElement(element: HTMLElement, parent: HTMLElement): void {
		// Only create Yoga nodes for elements that need them (block/flex elements)
		const display = getResolvedStyle(element, "display");

		if (display === "inline" || display === "inline-block") {
			// Inline elements don't get Yoga nodes - they're handled by text layout
			return;
		}

		// Create and configure Yoga node
		this.setupYogaNode(element);

		// Attach to parent's Yoga tree if parent has a Yoga node
		if (parent && parent[YOGA_NODE] && element[YOGA_NODE]) {
			const parentYoga = parent[YOGA_NODE];
			const elementYoga = element[YOGA_NODE];

			// Find the correct insertion index (based on DOM order)
			let insertIndex = 0;
			const siblings = Array.from(parent.children) as HTMLElement[];
			const elementIndex = siblings.indexOf(element);

			for (let i = 0; i < elementIndex; i++) {
				if (siblings[i][YOGA_NODE]) {
					insertIndex++;
				}
			}

			parentYoga.insertChild(elementYoga, insertIndex);
		}
	}

	/**
	 * Destroy Yoga node for a removed element
	 */
	destroyYogaNodeForElement(element: HTMLElement): void {
		if (!element[YOGA_NODE]) return;

		const yogaNode = element[YOGA_NODE];

		// Remove from parent if it has one
		const parent = yogaNode.getParent();
		if (parent) {
			parent.removeChild(yogaNode);
		}

		// Recursively clean up children
		this.clearYogaNodes(element);
	}

	/**
	 * Dispose of the layout engine and clean up all Yoga nodes
	 */
	dispose(): void {
		// Free the Yoga config
		if (this.yogaConfig) {
			this.yogaConfig.free();
		}
	}

	/**
	 * Clear all YOGA_NODE Symbol properties recursively to prevent WASM corruption
	 * This should only be called when disposing of the TermDOM instance
	 */
	clearYogaNodes(element: Element): void {
		// Clear this element's yoga node reference
		if (element[YOGA_NODE]) {
			delete element[YOGA_NODE];
		}

		// Clear children recursively
		const children = Array.from(element.childNodes).filter(
			(child) => child.nodeType === this.window.Node.ELEMENT_NODE,
		) as Element[];

		for (const child of children) {
			this.clearYogaNodes(child);
		}
	}

	/**
	 * Get padding from element style (CSS property parsing)
	 */
	private getPadding(element: Element): [number, number, number, number] {
		// Try individual padding properties first
		const paddingTop = this.parseValue(getResolvedStyle(element, "padding-top"), 0);
		const paddingRight = this.parseValue(getResolvedStyle(element, "padding-right"), 0);
		const paddingBottom = this.parseValue(getResolvedStyle(element, "padding-bottom"), 0);
		const paddingLeft = this.parseValue(getResolvedStyle(element, "padding-left"), 0);

		// If any individual properties are set, use them
		if (paddingTop || paddingRight || paddingBottom || paddingLeft) {
			return [paddingTop, paddingRight, paddingBottom, paddingLeft];
		}

		// Return all zeros if no individual properties were set
		// (JSDOM should have expanded any shorthand properties to individual ones)
		return [0, 0, 0, 0];
	}

	/**
	 * Setup Yoga node for element
	 */
	setupYogaNode(element: Element): void {
		if (!element[YOGA_NODE]) {
			const yogaNode = this.yoga.Node.createWithConfig(this.yogaConfig);
			element[YOGA_NODE] = yogaNode;

			// Note: Flex defaults are handled in applyStylesToYoga based on parent display type
		}

		// Always apply styles to Yoga node (styles may have changed)
		this.applyStylesToYoga(element);

		// Set up measure function if this element has text content or inline children
		this.setupMeasureFunction(element);
	}
	
	/**
	 * Reapply styles to existing Yoga nodes recursively
	 */
	private reapplyStylesRecursively(element: Element): void {
		if (element[YOGA_NODE]) {
			this.applyStylesToYoga(element);
		}
		
		// Process children
		const children = Array.from(element.children);
		for (const child of children) {
			this.reapplyStylesRecursively(child);
		}
	}

	/**
	 * Set up measure function for element if it needs one
	 * Elements with text content or inline children (but no block children) need measure functions
	 */
	private setupMeasureFunction(element: Element): void {
		const yogaNode = element[YOGA_NODE];
		if (!yogaNode) return;

		// Get all children (elements + text nodes)
		const children = Array.from(element.childNodes);
		const elementChildren = children.filter(
			(child) => child.nodeType === this.window.Node.ELEMENT_NODE,
		) as HTMLElement[];
		const textNodes = children.filter(
			(child) =>
				child.nodeType === this.window.Node.TEXT_NODE &&
				child.textContent &&
				child.textContent.trim(),
		) as Text[];

		// Check if this element should have a measure function
		// Elements that contain only inline content (text nodes and/or inline elements) need measure functions
		const hasBlockChildren = elementChildren.some((child) => {
			const display = getResolvedStyle(child, "display");
			return (
				display !== "inline" && display !== "inline-block" && display !== ""
			);
		});

		// Set measure function ONLY for leaf elements with text content
		// Yoga constraint: nodes with measure functions cannot have ANY children
		if (textNodes.length > 0 && elementChildren.length === 0) {
			const measureFunc = TextMeasurement.createMeasureFunction(element);
			yogaNode.setMeasureFunc(measureFunc);
		}
	}

	private buildingYogaTreeFor = new Set<Element>();

	/**
	 * Build Yoga tree recursively, handling inline elements specially
	 */
	private buildYogaTree(element: Element): void {
		const tagName = (element as any).tagName;

		if (this.buildingYogaTreeFor.has(element)) {
			return;
		}

		this.buildingYogaTreeFor.add(element);

		// With the new MutationObserver approach, buildYogaTree should not be used
		// Elements should already have Yoga nodes from handleElementAdded
		const htmlElement = element as HTMLElement;
		if (htmlElement[YOGA_NODE]) {
			this.buildingYogaTreeFor.delete(element);
			return;
		}

		this.setupYogaNode(element);

		// Get all children (elements + text nodes)
		const children = Array.from(element.childNodes);
		const elementChildren = children.filter(
			(child) => child.nodeType === (this.window as any).Node.ELEMENT_NODE,
		) as HTMLElement[];
		const textNodes = children.filter(
			(child) =>
				child.nodeType === (this.window as any).Node.TEXT_NODE &&
				child.textContent &&
				child.textContent.trim(),
		) as Text[];

		// Clear existing children
		const yogaNode = element[YOGA_NODE]!;
		if (!yogaNode) {
			return;
		}

		while (yogaNode.getChildCount() > 0) {
			yogaNode.removeChild(yogaNode.getChild(0));
		}

		// Check if this element should have a measure function
		// Elements that contain only inline content (text nodes and/or inline elements) need measure functions
		const hasBlockChildren = elementChildren.some((child) => {
			const display = getResolvedStyle(child, "display");
			return (
				display !== "inline" && display !== "inline-block" && display !== ""
			);
		});

		// Set measure function ONLY for leaf elements with text content
		// Yoga constraint: nodes with measure functions cannot have ANY children
		if (textNodes.length > 0 && elementChildren.length === 0) {
			const measureFunc = TextMeasurement.createMeasureFunction(element);
			yogaNode.setMeasureFunc(measureFunc);
			this.buildingYogaTreeFor.delete(element);
			return; // Leaf nodes don't have Yoga children
		}

		// Add element children to Yoga tree
		let yogaChildIndex = 0;
		for (const child of elementChildren) {
			let display = getResolvedStyle(child, "display");

			// Demote block/flex children inside inline-ish parents to inline-block
			// This ensures everything flows together in inline layout without modifying CSS
			const parentDisplay = getResolvedStyle(element, "display");
			if (
				(parentDisplay === "inline" || parentDisplay === "inline-block") &&
				(display === "block" || display === "flex")
			) {
				display = "inline-block"; // Treat as inline-block for layout purposes
			}

			if (display === "inline-block" || display === "inline") {
				// Inline and inline-block elements do NOT get Yoga nodes
				// They are handled by parent's inline layout system via processInlineLayout
				// Note: inline layout happens after Yoga computation in extractLayout
			} else {
				// Block/flex elements use normal Yoga tree building
				this.buildYogaTree(child);

				yogaNode.insertChild(child[YOGA_NODE]!, yogaChildIndex++);
			}
		}

		this.buildingYogaTreeFor.delete(element);
	}

	/**
	 * Extract computed layout from Yoga
	 */
	private extractLayout(
		element: Element,
		parentX: number,
		parentY: number,
	): void {
		if (!element[YOGA_NODE]) return;
		
		// Skip elements with display: none - they and their children shouldn't have bounds
		const display = getResolvedStyle(element, "display");
		if (display === "none") {
			return;
		}

		// Get computed layout from Yoga
		const layout = element[YOGA_NODE]!.getComputedLayout();

		// Debug the conversion from Yoga layout to DOM bounds
		const finalX = parentX + layout.left;
		const finalY = parentY + layout.top;
		const tagName = (element as any).tagName || "UNKNOWN";
		
		// Debug margin values
		const yogaNode = element[YOGA_NODE]!;
		const marginLeft = yogaNode.getMargin(this.yoga.EDGE_LEFT);
		const marginTop = yogaNode.getMargin(this.yoga.EDGE_TOP);
		const setWidth = yogaNode.getWidth();
		const setHeight = yogaNode.getHeight();
		
		if (tagName === "DIV" || tagName === "BODY") {
			console.log(`${tagName} layout:`, {
				parentX, parentY,
				layout: { left: layout.left, top: layout.top, width: layout.width, height: layout.height },
				setDimensions: { width: setWidth.value, height: setHeight.value },
				margins: { left: marginLeft, top: marginTop },
				final: { x: finalX, y: finalY }
			});
		}

		// Layout engine sets bounds correctly for block elements

		// Convert floating-point Yoga coordinates to integer terminal positions
		// With setPointScaleFactor(1.0), Yoga should already provide integer values
		const intX = Math.round(finalX);
		const intY = Math.round(finalY);
		const intWidth = Math.round(layout.width);
		const intHeight = Math.round(layout.height);

		// Store computed bounds in Symbol property
		element[ELEMENT_BOUNDS] = new (this.window as any).DOMRect(
			intX,
			intY,
			intWidth,
			intHeight,
		);

		// Extract layout for children using standard DOM traversal
		const children = Array.from(element.childNodes).filter(
			(child) => child.nodeType === this.window.Node.ELEMENT_NODE,
		) as Element[];

		const bounds = element[ELEMENT_BOUNDS];
		if (!bounds) {
			throw new Error("Element bounds not set before layout processing");
		}

		// Handle inline layout for inline children
		this.processInlineLayout(element, children, bounds);

		// Process Text node children that need text wrapping
		this.processTextNodeLayout(element, bounds);

		// Process children that have Yoga nodes (block/flex/inline-block)
		for (const child of children) {
			if (child[YOGA_NODE]) {
				// Calculate inner content area by accounting for parent's padding
				// Child elements are positioned relative to parent's content area, not outer bounds
				const paddingLeft = this.parseValue(getResolvedStyle(element, "padding-left"), 0);
				const paddingTop = this.parseValue(getResolvedStyle(element, "padding-top"), 0);

				const innerX = bounds.x + paddingLeft;
				const innerY = bounds.y + paddingTop;

				this.extractLayout(child, innerX, innerY);
			}
		}
	}

	/**
	 * Process Text node children that need text wrapping within block elements
	 */
	private processTextNodeLayout(element: Element, parentBounds: DOMRect): void {
		// Find direct Text node children
		const textNodes = Array.from(element.childNodes).filter(
			(child) => child.nodeType === this.window.Node.TEXT_NODE,
		) as Text[];

		if (textNodes.length === 0) return;

		let currentY = parentBounds.y;

		for (const textNode of textNodes) {
			const text = textNode.textContent;
			if (!text || !text.trim()) continue;

			// Use TextBreaker to break text into lines
			const breakResult = this.textBreaker.breakText(text, {
				maxWidth: parentBounds.width,
				breakWords: true,
			});

			if (breakResult.lines.length > 0) {
				const textRects: TextRect[] = [];

				// Create TextRect for each line
				for (let i = 0; i < breakResult.lines.length; i++) {
					const line = breakResult.lines[i];

					// Create proper DOMRect using constructor
					const domRect = new this.window.DOMRect(
						parentBounds.x,
						currentY,
						line.width,
						1,
					);

					// Add text property to make it a TextRect
					const rect: TextRect = Object.assign(domRect, {
						text: line.text.trim(),
					});

					textRects.push(rect);
					currentY += 1;
				}

				// Store text rectangles on the Text node
				(textNode as any)[ELEMENT_TEXT_RECTS] = textRects;

				// Also create a bounding rectangle
				if (textRects.length === 1) {
					(textNode as any)[ELEMENT_BOUNDS] = textRects[0];
				} else {
					const minY = Math.min(...textRects.map((r) => r.y));
					const maxY = Math.max(...textRects.map((r) => r.y + r.height));
					const maxWidth = Math.max(...textRects.map((r) => r.width));

					(textNode as any)[ELEMENT_BOUNDS] = new this.window.DOMRect(
						parentBounds.x,
						minY,
						maxWidth,
						maxY - minY,
					);
				}
			}
		}
	}

	/**
	 * Process inline layout for inline children with line-wrapping support
	 * This handles pure inline elements that don't have Yoga nodes
	 */
	private processInlineLayout(
		parent: Element,
		children: Element[],
		parentBounds: DOMRect,
	): void {
		// Find ALL inline children that need layout
		const inlineChildren = children.filter((child) => {
			const computedStyle =
				child.ownerDocument!.defaultView!.getComputedStyle(child);
			let display = computedStyle.getPropertyValue("display");
			let defaultDisplay = display;

			// Demote block/flex children inside inline-ish parents to inline-block
			const parentDisplay = parent
				.ownerDocument!.defaultView!.getComputedStyle(parent)
				.getPropertyValue("display");
			if (
				(parentDisplay === "inline" || parentDisplay === "inline-block") &&
				(defaultDisplay === "block" || defaultDisplay === "flex")
			) {
				defaultDisplay = "inline-block";
			}

			// Include both inline and inline-block elements (both flow together in inline layout)
			// Empty display value means browser default - for SPAN elements, that's 'inline'
			return (
				defaultDisplay === "inline" ||
				defaultDisplay === "inline-block" ||
				defaultDisplay === ""
			);
		});

		if (inlineChildren.length === 0) return;

		// Check parent's flex direction first
		const parentComputedStyle =
			parent.ownerDocument!.defaultView!.getComputedStyle(parent);
		const flexDirection =
			parentComputedStyle.getPropertyValue("flex-direction");
		const isColumn =
			flexDirection === "column" || flexDirection === "column-reverse";

		// For column layouts, always use simple layout (no line wrapping needed)
		if (isColumn) {
			this.processSimpleInlineLayout(parent, inlineChildren, parentBounds);
			return;
		}

		// For row layouts, check if we need line wrapping
		const parentTextContent = this.getDirectTextContent(parent);
		let totalWidth = parentTextContent ? parentTextContent.length : 0;

		// Quick check: calculate total width needed
		for (const child of inlineChildren) {
			const computedStyle =
				child.ownerDocument!.defaultView!.getComputedStyle(child);
			const marginLeft =
				parseInt(computedStyle.getPropertyValue("margin-left")) || 0;
			const marginRight =
				parseInt(computedStyle.getPropertyValue("margin-right")) || 0;

			totalWidth += marginLeft;

			let display = computedStyle.getPropertyValue("display");
			let defaultDisplay = display;
			if (defaultDisplay === "inline-block") {
				const size = this.measureInlineBlockElement(child);
				totalWidth += size.width;
			} else {
				const content = child.textContent || "";
				totalWidth += Math.max(this.getTextWidth(content), 1);
			}

			totalWidth += marginRight;
		}

		// If everything fits on one line, use simple layout
		if (totalWidth <= parentBounds.width) {
			this.processSimpleInlineLayout(parent, inlineChildren, parentBounds);
			return;
		}

		// Build the content for line breaking
		let currentPosition = 0;
		const inlineElements: InlineElement[] = [];

		// Account for parent's direct text content first
		if (parentTextContent) {
			currentPosition = parentTextContent.length;
		}

		// Convert child elements to InlineElement format for TextBreaker
		for (const child of inlineChildren) {
			const computedStyle =
				child.ownerDocument!.defaultView!.getComputedStyle(child);
			let display = computedStyle.getPropertyValue("display");
			let defaultDisplay = display;

			// Apply horizontal margins
			const marginLeft =
				parseInt(computedStyle.getPropertyValue("margin-left")) || 0;
			const marginRight =
				parseInt(computedStyle.getPropertyValue("margin-right")) || 0;

			// Add left margin space if needed
			if (marginLeft > 0) {
				currentPosition += marginLeft;
			}

			let width: number;
			let height: number;
			let breakable: boolean;

			if (defaultDisplay === "inline-block") {
				// Inline-block: atomic units that cannot break
				const size = this.measureInlineBlockElement(child);
				width = size.width;
				height = size.height;
				breakable = false;
			} else {
				// Pure inline: can break across lines
				const content = child.textContent || "";
				width = Math.max(this.getTextWidth(content), 1);
				height = 1;
				breakable = true;
			}

			inlineElements.push({
				position: currentPosition,
				width,
				height,
				breakable,
				element: child,
			});

			currentPosition += width + marginRight;
		}

		// Build the full text content (parent text + inline text)
		let fullText = parentTextContent || "";
		let textPosition = fullText.length;

		// Process elements in order to build the full text
		for (let i = 0; i < inlineElements.length; i++) {
			const inlineEl = inlineElements[i];
			const child = inlineEl.element as Element;
			const childText = child.textContent || "";

			// Pad with spaces to reach the element's position
			while (textPosition < inlineEl.position) {
				fullText += " ";
				textPosition++;
			}

			// Update element position to match actual text position
			inlineEl.position = textPosition;

			// For inline elements, insert their text
			// For inline-block, insert placeholder spaces
			if (inlineEl.breakable) {
				fullText += childText;
				textPosition += childText.length;
			} else {
				// Use spaces as placeholders for inline-block width
				fullText += " ".repeat(inlineEl.width);
				textPosition += inlineEl.width;
			}
		}

		// Use TextBreaker to compute line breaks
		const breakResult = this.textBreaker.breakText(fullText, {
			maxWidth: parentBounds.width,
			breakWords: true,
			inlineElements,
		});

		// Apply the computed layout to elements
		this.applyLineBreaksToElements(
			inlineChildren,
			breakResult,
			parentBounds,
			inlineElements,
		);
	}

	/**
	 * Process simple inline layout when everything fits on one line
	 */
	private processSimpleInlineLayout(
		parent: Element,
		children: Element[],
		parentBounds: DOMRect,
	): void {
		let currentX = parentBounds.x;
		let currentY = parentBounds.y;

		// Check parent's flex direction to determine layout direction
		const parentComputedStyle =
			parent.ownerDocument!.defaultView!.getComputedStyle(parent);
		const flexDirection =
			parentComputedStyle.getPropertyValue("flex-direction");
		const isColumn =
			flexDirection === "column" || flexDirection === "column-reverse";

		// Account for parent's own text content before inline children
		const parentTextContent = this.getDirectTextContent(parent);
		if (parentTextContent) {
			if (isColumn) {
				currentY += 1; // In column layout, parent text takes up a line
			} else {
				currentX += parentTextContent.length; // In row layout, advance horizontally
			}
		}

		for (const child of children) {
			const computedStyle =
				child.ownerDocument!.defaultView!.getComputedStyle(child);
			let display = computedStyle.getPropertyValue("display");
			let defaultDisplay = display;

			// Demote block/flex children inside inline-ish parents to inline-block
			const parentDisplay = parent
				.ownerDocument!.defaultView!.getComputedStyle(parent)
				.getPropertyValue("display");
			if (
				(parentDisplay === "inline" || parentDisplay === "inline-block") &&
				(defaultDisplay === "block" || defaultDisplay === "flex")
			) {
				defaultDisplay = "inline-block";
			}

			// Apply margins based on layout direction - use getResolvedStyle for proper unit handling
			const marginLeft = this.parseValue(getResolvedStyle(child, "margin-left"), 0);
			const marginRight = this.parseValue(getResolvedStyle(child, "margin-right"), 0);
			const marginTop = this.parseValue(getResolvedStyle(child, "margin-top"), 0);
			const marginBottom = this.parseValue(getResolvedStyle(child, "margin-bottom"), 0);

			// Position element with margin
			if (isColumn) {
				currentY += marginTop;
			} else {
				currentX += marginLeft;
			}

			// Size element based on its display type
			let width: number;
			let height: number;

			if (defaultDisplay === "inline-block") {
				// Inline-block elements use intrinsic sizing
				const size = this.measureInlineBlockElement(child);
				width = size.width;
				height = size.height;

				// Set the element's bounds
				const childBounds = new this.window.DOMRect(
					currentX,
					currentY,
					width,
					height,
				);
				child[ELEMENT_BOUNDS] = childBounds;
				child[ELEMENT_RECTS] = [childBounds];
			} else {
				// Pure inline elements use content-based sizing
				const content = child.textContent || "";
				const textWidth = this.getTextWidth(content);

				// In column layout, respect parent width for text wrapping
				if (isColumn && textWidth > parentBounds.width) {
					// Text needs wrapping - use parent width
					width = parentBounds.width;

					// Calculate how many lines needed
					const wrappedText = this.measureTextWithWrapping(
						content,
						parentBounds.width,
					);
					height = wrappedText.height;

					// Create multiple rects for wrapped text
					const textRects: DOMRect[] = [];
					const elementTextRects: TextRect[] = [];
					const breakResult = this.textBreaker.breakText(content, {
						maxWidth: parentBounds.width,
						breakWords: true,
					});

					let lineY = currentY;
					for (const line of breakResult.lines) {
						const lineRect = new this.window.DOMRect(
							currentX,
							lineY,
							line.width,
							1,
						);
						textRects.push(lineRect);

						// Create TextRect with both position and content
						const textRect: TextRect = Object.assign(
							new this.window.DOMRect(currentX, lineY, line.width, 1),
							{text: line.text},
						);
						elementTextRects.push(textRect);

						lineY += 1;
					}

					// Set multiple rects for wrapped text
					child[ELEMENT_RECTS] = textRects;
					child[ELEMENT_TEXT_RECTS] = elementTextRects;

					// Bounding rect encompasses all lines
					const childBounds = new this.window.DOMRect(
						currentX,
						currentY,
						width,
						height,
					);
					child[ELEMENT_BOUNDS] = childBounds;
				} else {
					// Text fits on one line
					width = Math.max(textWidth, 1);
					height = 1;

					// Set the element's bounds (single rect case)
					const childBounds = new this.window.DOMRect(
						currentX,
						currentY,
						width,
						height,
					);
					child[ELEMENT_BOUNDS] = childBounds;
					child[ELEMENT_RECTS] = [childBounds];
				}
			}

			// Advance position for next inline element based on layout direction
			if (isColumn) {
				currentY += height + marginBottom;
				// In column layout, reset X position for next element (unless it's the same line)
				currentX = parentBounds.x;
			} else {
				currentX += width + marginRight;
			}

			// Recursively process any nested inline children
			const nestedChildren = Array.from(child.childNodes).filter(
				(node) => node.nodeType === this.window.Node.ELEMENT_NODE,
			) as Element[];

			if (nestedChildren.length > 0) {
				const childBounds = child[ELEMENT_BOUNDS];
				if (!childBounds) {
					throw new Error(
						"Child element bounds not set before processing nested inline children",
					);
				}
				this.processInlineLayout(child, nestedChildren, childBounds);
			}
		}

		// After processing all children, update parent's height if needed
		if (isColumn && currentY > parentBounds.y + parentBounds.height) {
			// The inline content extends beyond the parent's calculated height
			// This happens when text wrapping increases the actual content height
			const actualContentHeight = currentY - parentBounds.y;
			const newParentBounds = new this.window.DOMRect(
				parentBounds.x,
				parentBounds.y,
				parentBounds.width,
				actualContentHeight,
			);
			parent[ELEMENT_BOUNDS] = newParentBounds;

			// Also need to update any parent containers that might be affected
			this.propagateHeightChange(
				parent,
				actualContentHeight - parentBounds.height,
			);
		}
	}

	/**
	 * Propagate height changes up the DOM tree when inline content wraps
	 */
	private propagateHeightChange(element: Element, heightDelta: number): void {
		let current = element.parentElement;
		while (current && current[ELEMENT_BOUNDS]) {
			const bounds = current[ELEMENT_BOUNDS];
			const newBounds = new this.window.DOMRect(
				bounds.x,
				bounds.y,
				bounds.width,
				bounds.height + heightDelta,
			);
			current[ELEMENT_BOUNDS] = newBounds;

			// Stop at elements with Yoga nodes as they control their own layout
			if (current[YOGA_NODE]) {
				break;
			}

			current = current.parentElement;
		}
	}

	/**
	 * Apply line break results to inline elements with multi-rect support
	 */
	private applyLineBreaksToElements(
		elements: Element[],
		breakResult: BreakResult,
		parentBounds: DOMRect,
		inlineElements: InlineElement[],
	): void {
		// Create a map of elements to their positions from the inlineElements array
		const elementPositions = new Map<
			Element,
			{
				startPos: number;
				endPos: number;
				width: number;
				isInlineBlock: boolean;
			}
		>();

		// Use the positions from inlineElements that we passed to TextBreaker
		for (const inlineEl of inlineElements) {
			const element = inlineEl.element as Element;
			elementPositions.set(element, {
				startPos: inlineEl.position,
				endPos: inlineEl.position + inlineEl.width,
				width: inlineEl.width,
				isInlineBlock: !inlineEl.breakable,
			});
		}

		// Track multiple rectangles for elements that span multiple lines
		const elementRects = new Map<Element, DOMRect[]>();
		const elementTextRects = new Map<Element, TextRect[]>();

		// Position elements based on which lines they overlap with
		let currentY = parentBounds.y;

		for (let lineIndex = 0; lineIndex < breakResult.lines.length; lineIndex++) {
			const line = breakResult.lines[lineIndex];

			// Check which elements overlap with this line's text range
			for (const [element, elemPos] of elementPositions) {
				// Check if element overlaps with this line
				const overlapsLine =
					elemPos.startPos < line.endIndex && elemPos.endPos > line.startIndex;

				if (overlapsLine) {
					if (elemPos.isInlineBlock) {
						// Inline-block: atomic, position only once on the line where it starts
						if (
							!elementRects.has(element) &&
							elemPos.startPos >= line.startIndex &&
							elemPos.startPos < line.endIndex
						) {
							const lineX =
								parentBounds.x + (elemPos.startPos - line.startIndex);
							const rect = new this.window.DOMRect(
								lineX,
								currentY,
								elemPos.width,
								1,
							);
							elementRects.set(element, [rect]);
						}
					} else {
						// Inline element: can span multiple lines, create rect for each line fragment
						if (!elementRects.has(element)) {
							elementRects.set(element, []);
							elementTextRects.set(element, []);
						}

						// Calculate this line's fragment of the element
						const fragmentStartPos = Math.max(
							elemPos.startPos,
							line.startIndex,
						);
						const fragmentEndPos = Math.min(elemPos.endPos, line.endIndex);

						if (fragmentStartPos < fragmentEndPos) {
							const lineX =
								parentBounds.x + (fragmentStartPos - line.startIndex);
							const fragmentWidth = fragmentEndPos - fragmentStartPos;
							const rect = new this.window.DOMRect(
								lineX,
								currentY,
								fragmentWidth,
								1,
							);

							// Extract the text content for this fragment
							const elementText = element.textContent || "";
							const fragmentText = elementText.slice(
								fragmentStartPos - elemPos.startPos,
								fragmentEndPos - elemPos.startPos,
							);

							// Create TextRect with both position and content
							const baseRect = new this.window.DOMRect(
								rect.x,
								rect.y,
								rect.width,
								rect.height,
							);
							const textRect: TextRect = Object.assign(baseRect, {
								text: fragmentText,
							});

							elementRects.get(element)!.push(rect);
							elementTextRects.get(element)!.push(textRect);
						}
					}
				}
			}

			// Move to next line
			currentY += 1;
		}

		// Apply computed rectangles to elements
		for (const [element, rects] of elementRects) {
			if (rects.length > 0) {
				// Set ELEMENT_RECTS to all rectangles
				element[ELEMENT_RECTS] = rects;

				// Set ELEMENT_TEXT_RECTS to text rectangles with content
				const textRects = elementTextRects.get(element);
				if (textRects) {
					element[ELEMENT_TEXT_RECTS] = textRects;
				}

				// Set ELEMENT_BOUNDS to bounding rectangle of all rects
				if (rects.length === 1) {
					element[ELEMENT_BOUNDS] = rects[0];
				} else {
					// Calculate bounding rectangle that encompasses all line fragments
					const minX = Math.min(...rects.map((r) => r.x));
					const maxX = Math.max(...rects.map((r) => r.x + r.width));
					const minY = Math.min(...rects.map((r) => r.y));
					const maxY = Math.max(...rects.map((r) => r.y + r.height));

					element[ELEMENT_BOUNDS] = new this.window.DOMRect(
						minX,
						minY,
						maxX - minX,
						maxY - minY,
					);
				}

				// Recursively process nested inline children with proper bounds
				const nestedChildren = Array.from(element.childNodes).filter(
					(node) => node.nodeType === this.window.Node.ELEMENT_NODE,
				) as Element[];

				if (nestedChildren.length > 0) {
					// For nested elements in multi-line inline parents, we need special handling
					this.processNestedInlineLayout(
						element,
						nestedChildren,
						rects,
						elementPositions,
					);
				}
			}
		}

		// Ensure all elements have bounds set (fallback for elements not positioned)
		for (const element of elements) {
			if (!element[ELEMENT_BOUNDS]) {
				// Set a default position
				const defaultBounds = new this.window.DOMRect(
					parentBounds.x,
					parentBounds.y,
					1,
					1,
				);
				element[ELEMENT_BOUNDS] = defaultBounds;
				element[ELEMENT_RECTS] = [defaultBounds];
			}
		}
	}

	/**
	 * Process nested inline layout for elements whose parent spans multiple lines
	 * This handles complex cases where nested inline elements need positioning within
	 * the context of their parent's multiple rectangles
	 */
	private processNestedInlineLayout(
		parent: Element,
		children: Element[],
		parentRects: DOMRect[],
		elementPositions: Map<
			Element,
			{startPos: number; endPos: number; width: number; isInlineBlock: boolean}
		>,
	): void {
		// For now, use a simplified approach: position nested elements relative to the first parent rectangle
		// This handles most common cases while being predictable

		if (parentRects.length === 0) return;

		// Use the first rectangle as the base for nested layout
		const baseRect = parentRects[0];

		// Get parent's direct text content to offset nested elements properly
		const parentTextContent = this.getDirectTextContent(parent);
		let baseX = baseRect.x;

		// Account for parent's text content before inline children
		if (parentTextContent) {
			baseX += parentTextContent.length;
		}

		// Position nested inline children sequentially
		let currentX = baseX;
		const currentY = baseRect.y;

		for (const child of children) {
			const computedStyle =
				child.ownerDocument!.defaultView!.getComputedStyle(child);
			let display = computedStyle.getPropertyValue("display");

			// Apply demoting logic
			const parentDisplay = parent
				.ownerDocument!.defaultView!.getComputedStyle(parent)
				.getPropertyValue("display");
			if (
				(parentDisplay === "inline" || parentDisplay === "inline-block") &&
				(display === "block" || display === "flex")
			) {
				display = "inline-block";
			}

			// Apply horizontal margins
			const marginLeft =
				parseInt(computedStyle.getPropertyValue("margin-left")) || 0;
			const marginRight =
				parseInt(computedStyle.getPropertyValue("margin-right")) || 0;

			currentX += marginLeft;

			// Size and position the nested element
			let width: number;
			let height: number;

			if (display === "inline-block") {
				const size = this.measureInlineBlockElement(child);
				width = size.width;
				height = size.height;
			} else {
				const content = child.textContent || "";
				width = Math.max(this.getTextWidth(content), 1);
				height = 1;
			}

			// Set bounds for the nested element
			const nestedChildBounds = new this.window.DOMRect(
				currentX,
				currentY,
				width,
				height,
			);
			child[ELEMENT_BOUNDS] = nestedChildBounds;
			child[ELEMENT_RECTS] = [nestedChildBounds];

			currentX += width + marginRight;

			// Recursively handle further nesting
			const grandChildren = Array.from(child.childNodes).filter(
				(node) => node.nodeType === this.window.Node.ELEMENT_NODE,
			) as Element[];

			if (grandChildren.length > 0) {
				const childBounds = child[ELEMENT_BOUNDS];
				if (!childBounds) {
					throw new Error(
						"Child element bounds not set before processing grand children",
					);
				}
				this.processInlineLayout(child, grandChildren, childBounds);
			}
		}
	}

	/**
	 * Get direct text content of an element (only immediate text nodes, not nested elements)
	 */
	private getDirectTextContent(element: Element): string {
		let directText = "";
		for (const child of element.childNodes) {
			if (child.nodeType === this.window.Node.TEXT_NODE) {
				directText += child.textContent || "";
			}
		}
		return directText;
	}

	/**
	 * Map CSS styles to Yoga properties
	 */
	private applyStylesToYoga(element: Element): void {
		if (!element[YOGA_NODE]) return;

		const node = element[YOGA_NODE]!;
		
		console.log(`\n=== applyStylesToYoga for ${(element as any).tagName} ===`);

		// Display type
		const display = getResolvedStyle(element, "display");
		if (display === "none") {
			node.setDisplay(this.yoga.DISPLAY_NONE);
			return;
		} else if (display === "flex") {
			node.setDisplay(this.yoga.DISPLAY_FLEX);
		} else if (display === "block") {
			// Block display is syntactic sugar for flex column + stretch
			node.setDisplay(this.yoga.DISPLAY_FLEX);
			node.setFlexDirection(this.yoga.FLEX_DIRECTION_COLUMN);
			node.setAlignItems(this.yoga.ALIGN_STRETCH);
			// Ensure children start at top, not centered
			node.setJustifyContent(this.yoga.JUSTIFY_FLEX_START);
		}
		// inline elements use measurement functions, no special display setting needed

		// Flex direction (not allowed for block display)
		const flexDirection = getResolvedStyle(element, "flex-direction");
		if (flexDirection && display !== "block") {
			const flexDir = {
				row: this.yoga.FLEX_DIRECTION_ROW,
				column: this.yoga.FLEX_DIRECTION_COLUMN,
				"row-reverse": this.yoga.FLEX_DIRECTION_ROW_REVERSE,
				"column-reverse": this.yoga.FLEX_DIRECTION_COLUMN_REVERSE,
			}[flexDirection];
			if (flexDir !== undefined) node.setFlexDirection(flexDir);
		}

		// Justify content
		const justifyContent = getResolvedStyle(element, "justify-content");
		if (justifyContent) {
			const justify = {
				"flex-start": this.yoga.JUSTIFY_FLEX_START,
				center: this.yoga.JUSTIFY_CENTER,
				"flex-end": this.yoga.JUSTIFY_FLEX_END,
				"space-between": this.yoga.JUSTIFY_SPACE_BETWEEN,
				"space-around": this.yoga.JUSTIFY_SPACE_AROUND,
			}[justifyContent];
			if (justify !== undefined) node.setJustifyContent(justify);
		}

		// Align items (not allowed for block display)
		const alignItems = getResolvedStyle(element, "align-items");
		if (alignItems && display !== "block") {
			const align = {
				stretch: this.yoga.ALIGN_STRETCH,
				"flex-start": this.yoga.ALIGN_FLEX_START,
				center: this.yoga.ALIGN_CENTER,
				"flex-end": this.yoga.ALIGN_FLEX_END,
			}[alignItems];
			if (align !== undefined) node.setAlignItems(align);
		}

		// Dimensions
		const widthStr = getResolvedStyle(element, "width");
		const heightStr = getResolvedStyle(element, "height");

		// Parse width - handle ch units
		let width = NaN;
		if (widthStr) {
			if (widthStr.endsWith("ch")) {
				width = parseFloat(widthStr); // "80ch" -> 80
			} else if (widthStr.endsWith("%")) {
				// For percentage, we'd need parent context, skip for now
			} else {
				width = parseInt(widthStr);
			}
		}

		// Parse height - handle ch units
		let height = NaN;
		if (heightStr) {
			if (heightStr.endsWith("ch")) {
				height = parseFloat(heightStr);
			} else {
				height = parseInt(heightStr);
			}
		}
		const minWidth = parseInt(getResolvedStyle(element, "min-width"));
		const minHeight = parseInt(getResolvedStyle(element, "min-height"));
		const maxWidth = parseInt(getResolvedStyle(element, "max-width"));
		const maxHeight = parseInt(getResolvedStyle(element, "max-height"));

		console.log(`Setting dimensions for ${(element as any).tagName}: widthStr="${widthStr}", heightStr="${heightStr}", width=${width}, height=${height}`);

		if (!isNaN(width)) node.setWidth(width);
		if (!isNaN(height)) node.setHeight(height);
		if (!isNaN(minWidth)) node.setMinWidth(minWidth);
		if (!isNaN(minHeight)) node.setMinHeight(minHeight);
		if (!isNaN(maxWidth)) node.setMaxWidth(maxWidth);
		if (!isNaN(maxHeight)) node.setMaxHeight(maxHeight);

		// Flex properties - special handling for children of block elements
		const parent = (element as HTMLElement).parentElement;
		const parentDisplay = parent ? getResolvedStyle(parent, "display") : "";
		const isChildOfBlock = parentDisplay === "block";
		
		// For children of block elements, we need specific flex properties
		// to emulate traditional block behavior
		if (isChildOfBlock) {
			// Block children don't grow or shrink - they have intrinsic height
			node.setFlexGrow(0);
			node.setFlexShrink(0);
			// TODO: node.setFlexBasis('auto') when supported
		} else {
			// For other elements, respect CSS values
			const flexGrow = parseFloat(getResolvedStyle(element, "flex-grow"));
			const flexShrink = parseFloat(getResolvedStyle(element, "flex-shrink"));
			
			// Only override defaults if explicitly specified in CSS
			if (!isNaN(flexGrow)) node.setFlexGrow(flexGrow);
			if (!isNaN(flexShrink)) node.setFlexShrink(flexShrink);
		}

		// TODO: Add flex-basis support for complete CSS compatibility

		// Position type (CSS default: static already set in setupYogaNode)
		const position = getResolvedStyle(element, "position");
		if (position === "relative") {
			node.setPositionType(this.yoga.POSITION_TYPE_RELATIVE);
		} else if (position === "absolute") {
			node.setPositionType(this.yoga.POSITION_TYPE_ABSOLUTE);
		} else if (position === "static") {
			node.setPositionType(this.yoga.POSITION_TYPE_STATIC);
		}
		// If unspecified, keep the CSS default (static) set in setupYogaNode

		// Position offset values (top, right, bottom, left)
		if (position === "relative" || position === "absolute") {
			const top = parseInt(getResolvedStyle(element, "top"));
			const right = parseInt(getResolvedStyle(element, "right"));
			const bottom = parseInt(getResolvedStyle(element, "bottom"));
			const left = parseInt(getResolvedStyle(element, "left"));

			if (!isNaN(top)) node.setPosition(this.yoga.EDGE_TOP, top);
			if (!isNaN(right)) node.setPosition(this.yoga.EDGE_RIGHT, right);
			if (!isNaN(bottom)) node.setPosition(this.yoga.EDGE_BOTTOM, bottom);
			if (!isNaN(left)) node.setPosition(this.yoga.EDGE_LEFT, left);
		}

		// Padding
		const [top, right, bottom, left] = this.getPadding(element);
		if (top || right || bottom || left) {
			node.setPadding(this.yoga.EDGE_TOP, top);
			node.setPadding(this.yoga.EDGE_RIGHT, right);
			node.setPadding(this.yoga.EDGE_BOTTOM, bottom);
			node.setPadding(this.yoga.EDGE_LEFT, left);
		}

		// Margin
		const margin = this.getMargin(element);
		console.log(`Applying margins for ${(element as any).tagName}:`, margin);
		if (margin[0] || margin[1] || margin[2] || margin[3]) {
			node.setMargin(this.yoga.EDGE_TOP, margin[0]);
			node.setMargin(this.yoga.EDGE_RIGHT, margin[1]);
			node.setMargin(this.yoga.EDGE_BOTTOM, margin[2]);
			node.setMargin(this.yoga.EDGE_LEFT, margin[3]);
		}
	}

	/**
	 * Measure inline element size based on text content only (no chrome)
	 */
	private measureInlineElement(element: Element): {
		width: number;
		height: number;
	} {
		const content = element.textContent || "";

		if (!content) {
			return {width: 0, height: 0};
		}

		const computedStyle =
			element.ownerDocument!.defaultView!.getComputedStyle(element);
		const style = computedStyle;
		const wordWrap = style.getPropertyValue("word-wrap") || "normal";
		const whiteSpace = style.getPropertyValue("white-space") || "normal";

		// For inline elements, we size based on content without wrapping constraints
		// They shrink to fit their content
		if (
			wordWrap === "nowrap" ||
			whiteSpace === "nowrap" ||
			whiteSpace === "pre"
		) {
			return {width: this.getTextWidth(content), height: 1};
		}

		// For normal wrapping, inline elements still size to their content
		// Wrapping happens at the container level during inline layout
		const lines = content.split("\n");
		const width = Math.max(...lines.map((line) => this.getTextWidth(line)));
		return {width, height: lines.length};
	}

	/**
	 * Measure text with width constraints using TextBreaker
	 */
	private measureTextWithWrapping(
		text: string,
		maxWidth: number,
		inlineElements: InlineElement[] = [],
	): {width: number; height: number} {
		if (!text && inlineElements.length === 0) {
			return {width: 0, height: 0};
		}

		const result = this.textBreaker.breakText(text, {
			maxWidth,
			breakWords: true,
			inlineElements,
		});

		return {
			width: result.maxLineWidth,
			height: result.totalHeight,
		};
	}

	/**
	 * Measure inline-block element size with full visual dimensions
	 */
	private measureInlineBlockElement(element: Element): {
		width: number;
		height: number;
	} {
		const computedStyle =
			element.ownerDocument!.defaultView!.getComputedStyle(element);
		const style = computedStyle;

		// 1. Check for explicit dimensions first (highest priority)
		const widthValue = parseInt(style.getPropertyValue("width"));
		const heightValue = parseInt(style.getPropertyValue("height"));
		let width = !isNaN(widthValue) ? widthValue : null;
		let height = !isNaN(heightValue) ? heightValue : null;

		// 2. If no explicit dimensions, calculate from content + chrome
		if (width === null || height === null) {
			const contentSize = this.measureInlineElement(element);
			const [padTop, padRight, padBottom, padLeft] = this.getPadding(style);
			const borderWidth = this.getBorderWidth(element);

			if (width === null) {
				width = contentSize.width + padLeft + padRight + borderWidth * 2;
			}
			if (height === null) {
				height = contentSize.height + padTop + padBottom + borderWidth * 2;
			}
		}

		// 3. Apply minimum constraints
		const minWidth = parseInt(style.getPropertyValue("min-width"));
		const minHeight = parseInt(style.getPropertyValue("min-height"));
		if (!isNaN(minWidth)) {
			width = Math.max(width, minWidth);
		}
		if (!isNaN(minHeight)) {
			height = Math.max(height, minHeight);
		}

		// 4. Apply maximum constraints
		const maxWidth = parseInt(style.getPropertyValue("max-width"));
		const maxHeight = parseInt(style.getPropertyValue("max-height"));
		if (!isNaN(maxWidth)) {
			width = Math.min(width, maxWidth);
		}
		if (!isNaN(maxHeight)) {
			height = Math.min(height, maxHeight);
		}

		return {width, height};
	}

	/**
	 * Get border width from element style
	 */
	private getBorderWidth(element: Element): number {
		const computedStyle =
			element.ownerDocument!.defaultView!.getComputedStyle(element);
		const style = computedStyle;
		const borderWidth = style.getPropertyValue("border-width");
		return parseInt(borderWidth) || 0;
	}

	/**
	 * Get visual width of text using Bun's stringWidth
	 */
	private getTextWidth(text: string): number {
		return Bun.stringWidth(text);
	}

	/**
	 * Get margin from element style (CSS property parsing)
	 */
	private getMargin(element: Element): [number, number, number, number] {
		// Get individual margin properties using getResolvedStyle
		const marginTop = this.parseValue(getResolvedStyle(element, "margin-top"), 0);
		const marginRight = this.parseValue(getResolvedStyle(element, "margin-right"), 0);
		const marginBottom = this.parseValue(getResolvedStyle(element, "margin-bottom"), 0);
		const marginLeft = this.parseValue(getResolvedStyle(element, "margin-left"), 0);

		// If any individual properties are set, use them
		if (marginTop || marginRight || marginBottom || marginLeft) {
			return [marginTop, marginRight, marginBottom, marginLeft];
		}

		// Return all zeros if no individual properties were set
		// (JSDOM should have expanded any shorthand properties to individual ones)
		return [0, 0, 0, 0];
	}

	/**
	 * Parse CSS value and convert to pixels
	 */
	private parseValue(value: string, defaultValue: number): number {
		if (!value || value === "auto") return defaultValue;

		console.log(`Parsing CSS value: "${value}"`);
		
		// Remove units and parse as integer
		const numericValue = parseInt(value);
		console.log(`Parsed numeric value: ${numericValue}`);
		
		return isNaN(numericValue) ? defaultValue : numericValue;
	}
}
