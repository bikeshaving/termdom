import type { DOMWindow, Element, Node } from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import linebreak from "linebreak";
import { TextBreaker, type LineBreak } from "../text/TextBreaker.js";
import { getResolvedStyle } from "../css.js";

/**
 * Interface for text with positioning - composition over inheritance
 */
export interface TextLayout {
	rect: DOMRect;
	text: string;
}

/**
 * Unified Layout Engine based on LAYOUT.md architecture
 * 
 * Key principles:
 * - Block elements get individual Yoga nodes with flex-direction: column  
 * - Inline runs (consecutive inline content) get anonymous Yoga nodes with flex-direction: row
 * - Individual inline elements/text nodes don't get separate Yoga nodes
 * - Anonymous boxes use measure functions to handle entire inline runs
 */
export class LayoutEngine {
	private yoga: typeof Yoga;
	private yogaConfig: YogaTypes.Config;
	private textBreaker: TextBreaker;
	private DOMRect: typeof DOMRect;
	
	// Internal storage - no DOM pollution
	private elementRects = new WeakMap<Element, DOMRect>();
	private elementMultiRects = new WeakMap<Element, DOMRect[]>();
	private elementTextLayouts = new WeakMap<Element, TextLayout[]>();
	private elementYogaNodes = new WeakMap<Element, YogaTypes.Node>();
	private anonymousBoxes = new WeakMap<Element, YogaTypes.Node[]>(); // Track anonymous boxes for each parent
	
	// Layout state
	private rootElement: Element | null = null;
	private terminalWidth: number = 80;
	private terminalHeight: number = 24;

	constructor(DOMRect: typeof DOMRect) {
		this.yoga = Yoga;
		this.DOMRect = DOMRect;
		this.textBreaker = new TextBreaker();

		// Create Yoga config with web defaults for terminal compatibility
		this.yogaConfig = this.yoga.Config.create();
		this.yogaConfig.setUseWebDefaults(true);
		this.yogaConfig.setPointScaleFactor(1.0); // Character grid alignment
	}

	/**
	 * Update terminal dimensions
	 */
	resize(width: number, height: number): void {
		this.terminalWidth = width;
		this.terminalHeight = height;
		
		// If we have a root, recompute layout with new dimensions
		if (this.rootElement) {
			this.rebuildAndCalculateLayout();
		}
	}

	/**
	 * Handle DOM mutations - rebuild affected parts of Yoga tree
	 */
	handleMutations(mutations: MutationRecord[]): void {
		// For now, do a full rebuild on any mutation
		// TODO: Implement incremental updates using Yoga's dirty node system
		if (mutations.length > 0) {
			this.rebuildAndCalculateLayout();
		}
	}

	/**
	 * Get single bounding rectangle for element
	 */
	getRect(element: Element): DOMRect | null {
		return this.elementRects.get(element) || null;
	}

	/**
	 * Get array of rectangles for element (for multi-line inline elements)
	 */
	getRects(element: Element): DOMRect[] {
		// Try multi-rects first (for wrapped inline elements)
		const multiRects = this.elementMultiRects.get(element);
		if (multiRects && multiRects.length > 0) {
			return multiRects;
		}
		
		// Fall back to single rect
		const singleRect = this.elementRects.get(element);
		return singleRect ? [singleRect] : [];
	}

	/**
	 * Get text layouts (positioned text content) for element
	 */
	getTextLayouts(element: Element): TextLayout[] {
		return this.elementTextLayouts.get(element) || [];
	}

	/**
	 * Dispose of layout engine and clean up Yoga resources
	 */
	dispose(): void {
		// Note: WeakMaps don't provide iteration methods, so we can't manually free Yoga nodes
		// They will be garbage collected when the elements they're keyed by are collected
		// For explicit cleanup, we'd need to track nodes separately

		// Clear all WeakMaps
		this.elementRects = new WeakMap();
		this.elementMultiRects = new WeakMap();
		this.elementTextLayouts = new WeakMap();
		this.elementYogaNodes = new WeakMap();
		this.anonymousBoxes = new WeakMap();

		// Free Yoga config
		if (this.yogaConfig) {
			this.yogaConfig.free();
		}
		
		this.rootElement = null;
	}

	/**
	 * Rebuild Yoga tree and calculate layout
	 */
	private rebuildAndCalculateLayout(): void {
		if (!this.rootElement) return;
		
		// Clear existing layout data
		this.clearLayoutData();
		
		// Build Yoga tree using anonymous box algorithm
		const rootYogaNode = this.buildYogaTree(this.rootElement);
		if (!rootYogaNode) return;
		
		// Set root constraints to terminal dimensions
		rootYogaNode.setWidth(this.terminalWidth);
		rootYogaNode.setHeight(this.terminalHeight);
		
		// Calculate layout
		rootYogaNode.calculateLayout(this.terminalWidth, this.terminalHeight);
		
		// Extract layout data back to WeakMaps
		this.extractLayoutData(this.rootElement, 0, 0);
	}

	/**
	 * Set the root element for layout calculations
	 */
	setRootElement(element: Element): void {
		this.rootElement = element;
	}

	/**
	 * Clear all layout data
	 */
	private clearLayoutData(): void {
		// Note: WeakMaps don't have iteration methods, so we can't free individual nodes
		// The nodes will be garbage collected when elements are removed
		// For now, we just clear the maps
		this.elementRects = new WeakMap();
		this.elementMultiRects = new WeakMap();
		this.elementTextLayouts = new WeakMap();
		this.elementYogaNodes = new WeakMap();
		this.anonymousBoxes = new WeakMap();
	}

	/**
	 * Build Yoga tree for element using anonymous box algorithm
	 */
	private buildYogaTree(element: Element): YogaTypes.Node | null {
		const display = getResolvedStyle(element, "display");
		
		// Skip display:none elements
		if (display === "none") {
			return null;
		}

		// Create Yoga node for this element
		const yogaNode = this.createYogaNodeForElement(element);
		this.elementYogaNodes.set(element, yogaNode);

		// Process children using anonymous box algorithm
		this.processChildrenWithAnonymousBoxes(element, yogaNode);

		return yogaNode;
	}

	/**
	 * Create Yoga node for a specific element
	 */
	private createYogaNodeForElement(element: Element): YogaTypes.Node {
		const yogaNode = this.yoga.Node.createWithConfig(this.yogaConfig);
		const display = getResolvedStyle(element, "display");

		// Configure based on display type
		if (display === "flex") {
			yogaNode.setDisplay(this.yoga.DISPLAY_FLEX);
			const flexDirection = getResolvedStyle(element, "flex-direction");
			yogaNode.setFlexDirection(
				flexDirection === "row" ? this.yoga.FLEX_DIRECTION_ROW :
				flexDirection === "row-reverse" ? this.yoga.FLEX_DIRECTION_ROW_REVERSE :
				flexDirection === "column-reverse" ? this.yoga.FLEX_DIRECTION_COLUMN_REVERSE :
				this.yoga.FLEX_DIRECTION_COLUMN
			);
		} else if (display === "inline-block") {
			// Inline-block elements get their own atomic nodes
			yogaNode.setDisplay(this.yoga.DISPLAY_FLEX);
			yogaNode.setFlexDirection(this.yoga.FLEX_DIRECTION_ROW);
		} else {
			// Block elements default to column layout
			yogaNode.setDisplay(this.yoga.DISPLAY_FLEX);
			yogaNode.setFlexDirection(this.yoga.FLEX_DIRECTION_COLUMN);
			yogaNode.setAlignItems(this.yoga.ALIGN_STRETCH);
			yogaNode.setJustifyContent(this.yoga.JUSTIFY_FLEX_START);
		}

		// Apply CSS properties to Yoga node
		this.applyCSSPropertiesToYogaNode(element, yogaNode);

		return yogaNode;
	}

	/**
	 * Process children using correct algorithm from LAYOUT.md
	 * Flex containers and normal flow use different algorithms
	 */
	private processChildrenWithAnonymousBoxes(parent: Element, parentYogaNode: YogaTypes.Node): void {
		const children = Array.from(parent.childNodes);
		const parentDisplay = getResolvedStyle(parent, "display");
		const isFlexContainer = parentDisplay === "flex";

		if (isFlexContainer) {
			// CSS Flexbox: group into flex items (elements + text runs)
			this.processFlexChildren(children, parent, parentYogaNode);
		} else {
			// Standard flow: use anonymous box algorithm
			this.processStandardChildren(children, parent, parentYogaNode);
		}
	}

	/**
	 * Process children in flex containers following CSS flexbox spec:
	 * - Elements become individual flex items
	 * - Adjacent text nodes combine into anonymous flex items
	 */
	private processFlexChildren(children: Node[], parent: Element, parentYogaNode: YogaTypes.Node): void {
		const flexItems = this.groupFlexItems(children);
		const anonymousBoxesForParent: YogaTypes.Node[] = [];

		for (const item of flexItems) {
			if (item.type === 'element') {
				// Each element gets its own Yoga node (even inline elements become flex items)
				const childYogaNode = this.buildYogaTree(item.element);
				if (childYogaNode) {
					parentYogaNode.insertChild(childYogaNode, parentYogaNode.getChildCount());
				}
			} else if (item.type === 'text-run') {
				// Text runs get anonymous flex items with measure functions
				const anonymousBox = this.createAnonymousBoxForTextRun(item.textNodes, parent);
				anonymousBoxesForParent.push(anonymousBox);
				parentYogaNode.insertChild(anonymousBox, parentYogaNode.getChildCount());
			}
		}

		if (anonymousBoxesForParent.length > 0) {
			this.anonymousBoxes.set(parent, anonymousBoxesForParent);
		}
	}

	/**
	 * Group children into flex items following CSS spec:
	 * "each contiguous run of text directly contained inside a flex container 
	 *  is wrapped in an anonymous flex item"
	 */
	private groupFlexItems(children: Node[]): Array<{ type: 'element' | 'text-run', element?: Element, textNodes?: Node[] }> {
		const items: Array<{ type: 'element' | 'text-run', element?: Element, textNodes?: Node[] }> = [];
		let currentTextRun: Node[] = [];

		for (const child of children) {
			if (child.nodeType === child.ELEMENT_NODE) {
				// Flush any pending text run
				if (currentTextRun.length > 0) {
					items.push({ type: 'text-run', textNodes: [...currentTextRun] });
					currentTextRun = [];
				}

				// Add element if not display:none
				const element = child as Element;
				const display = getResolvedStyle(element, "display");
				if (display !== "none") {
					items.push({ type: 'element', element });
				}
			} else if (child.nodeType === child.TEXT_NODE) {
				// Add to current text run if it has content
				const text = child.textContent?.trim();
				if (text) {
					currentTextRun.push(child);
				}
			}
		}

		// Flush final text run
		if (currentTextRun.length > 0) {
			items.push({ type: 'text-run', textNodes: currentTextRun });
		}

		return items;
	}

	/**
	 * Process children using standard anonymous box algorithm (non-flex containers)
	 */
	private processStandardChildren(children: Node[], parent: Element, parentYogaNode: YogaTypes.Node): void {
		const groups = this.groupChildNodes(children);
		const anonymousBoxesForParent: YogaTypes.Node[] = [];

		for (const group of groups) {
			if (group.type === 'block') {
				// Single block element - gets its own Yoga node
				const blockElement = group.nodes[0] as Element;
				const childYogaNode = this.buildYogaTree(blockElement);
				if (childYogaNode) {
					parentYogaNode.insertChild(childYogaNode, parentYogaNode.getChildCount());
				}
			} else {
				// Inline run - create anonymous box
				const anonymousBox = this.createAnonymousBoxForInlineRun(group.nodes, parent);
				anonymousBoxesForParent.push(anonymousBox);
				parentYogaNode.insertChild(anonymousBox, parentYogaNode.getChildCount());
			}
		}

		if (anonymousBoxesForParent.length > 0) {
			this.anonymousBoxes.set(parent, anonymousBoxesForParent);
		}
	}

	/**
	 * Group child nodes into block elements vs inline runs
	 */
	private groupChildNodes(nodes: Node[]): Array<{ type: 'block' | 'inline', nodes: Node[] }> {
		const groups: Array<{ type: 'block' | 'inline', nodes: Node[] }> = [];
		let currentInlineGroup: Node[] = [];

		for (const node of nodes) {
			if (node.nodeType === node.ELEMENT_NODE) {
				const element = node as Element;
				const display = getResolvedStyle(element, "display");

				if (this.isBlockLevelDisplay(display)) {
					// Block element - flush inline group first
					if (currentInlineGroup.length > 0) {
						groups.push({ type: 'inline', nodes: [...currentInlineGroup] });
						currentInlineGroup = [];
					}
					
					// Add block element (skip display:none)
					if (display !== "none") {
						groups.push({ type: 'block', nodes: [element] });
					}
				} else {
					// Inline element - add to current inline group
					if (display !== "none") {
						currentInlineGroup.push(node);
					}
				}
			} else if (node.nodeType === node.TEXT_NODE) {
				// Text node - add to inline group if it has content
				const text = node.textContent?.trim();
				if (text) {
					currentInlineGroup.push(node);
				}
			}
		}

		// Flush remaining inline group
		if (currentInlineGroup.length > 0) {
			groups.push({ type: 'inline', nodes: currentInlineGroup });
		}

		return groups;
	}

	/**
	 * Check if display value is block-level
	 */
	private isBlockLevelDisplay(display: string): boolean {
		return display === "block" || 
			   display === "flex" || 
			   display === "inline-block" ||
			   display === "none";
	}

	/**
	 * Create anonymous box for inline run with measure function
	 */
	private createAnonymousBoxForInlineRun(nodes: Node[], parent: Element): YogaTypes.Node {
		const anonymousBox = this.yoga.Node.createWithConfig(this.yogaConfig);
		
		// Anonymous boxes are horizontal flex containers
		anonymousBox.setDisplay(this.yoga.DISPLAY_FLEX);
		anonymousBox.setFlexDirection(this.yoga.FLEX_DIRECTION_ROW);
		anonymousBox.setFlexWrap(this.yoga.WRAP_WRAP);

		// Set measure function that handles all content in this inline run
		const measureFunc = this.createMeasureFunctionForInlineRun(nodes, parent);
		anonymousBox.setMeasureFunc(measureFunc);

		return anonymousBox;
	}

	/**
	 * Create anonymous box for text run (flex container text runs)
	 * Uses wholeText for semantic content while preserving individual nodes
	 */
	private createAnonymousBoxForTextRun(textNodes: Node[], parent: Element): YogaTypes.Node {
		const anonymousBox = this.yoga.Node.createWithConfig(this.yogaConfig);
		
		// Text run anonymous boxes are flex items that contain text
		anonymousBox.setDisplay(this.yoga.DISPLAY_FLEX);
		// In flex containers, text runs are treated as single items (no wrapping needed)
		anonymousBox.setFlexDirection(this.yoga.FLEX_DIRECTION_ROW);

		// Use wholeText from first text node to get complete semantic content
		const firstTextNode = textNodes[0] as Text;
		const fullText = firstTextNode.wholeText || firstTextNode.textContent || '';

		// Create measure function for the complete text content
		const measureFunc = this.createTextRunMeasureFunction(fullText.trim(), textNodes, parent);
		anonymousBox.setMeasureFunc(measureFunc);

		return anonymousBox;
	}

	/**
	 * Apply CSS properties to Yoga node
	 */
	private applyCSSPropertiesToYogaNode(element: Element, yogaNode: YogaTypes.Node): void {
		// === DIMENSIONS ===
		const width = getResolvedStyle(element, "width");
		const height = getResolvedStyle(element, "height");
		const minWidth = getResolvedStyle(element, "min-width");
		const minHeight = getResolvedStyle(element, "min-height");
		const maxWidth = getResolvedStyle(element, "max-width");
		const maxHeight = getResolvedStyle(element, "max-height");

		if (width && width !== "auto") {
			const widthValue = this.parsePixelValue(width);
			if (widthValue !== null) {
				yogaNode.setWidth(widthValue);
			}
		}

		if (height && height !== "auto") {
			const heightValue = this.parsePixelValue(height);
			if (heightValue !== null) {
				yogaNode.setHeight(heightValue);
			}
		}

		if (minWidth && minWidth !== "auto") {
			const minWidthValue = this.parsePixelValue(minWidth);
			if (minWidthValue !== null) {
				yogaNode.setMinWidth(minWidthValue);
			}
		}

		if (minHeight && minHeight !== "auto") {
			const minHeightValue = this.parsePixelValue(minHeight);
			if (minHeightValue !== null) {
				yogaNode.setMinHeight(minHeightValue);
			}
		}

		if (maxWidth && maxWidth !== "none") {
			const maxWidthValue = this.parsePixelValue(maxWidth);
			if (maxWidthValue !== null) {
				yogaNode.setMaxWidth(maxWidthValue);
			}
		}

		if (maxHeight && maxHeight !== "none") {
			const maxHeightValue = this.parsePixelValue(maxHeight);
			if (maxHeightValue !== null) {
				yogaNode.setMaxHeight(maxHeightValue);
			}
		}

		// === MARGINS ===
		const marginTop = getResolvedStyle(element, "margin-top");
		const marginRight = getResolvedStyle(element, "margin-right");
		const marginBottom = getResolvedStyle(element, "margin-bottom");
		const marginLeft = getResolvedStyle(element, "margin-left");

		if (marginTop && marginTop !== "auto") {
			const value = this.parsePixelValue(marginTop);
			if (value !== null) {
				yogaNode.setMargin(this.yoga.EDGE_TOP, value);
			}
		}

		if (marginRight && marginRight !== "auto") {
			const value = this.parsePixelValue(marginRight);
			if (value !== null) {
				yogaNode.setMargin(this.yoga.EDGE_RIGHT, value);
			}
		}

		if (marginBottom && marginBottom !== "auto") {
			const value = this.parsePixelValue(marginBottom);
			if (value !== null) {
				yogaNode.setMargin(this.yoga.EDGE_BOTTOM, value);
			}
		}

		if (marginLeft && marginLeft !== "auto") {
			const value = this.parsePixelValue(marginLeft);
			if (value !== null) {
				yogaNode.setMargin(this.yoga.EDGE_LEFT, value);
			}
		}

		// === PADDING ===
		const paddingTop = getResolvedStyle(element, "padding-top");
		const paddingRight = getResolvedStyle(element, "padding-right");
		const paddingBottom = getResolvedStyle(element, "padding-bottom");
		const paddingLeft = getResolvedStyle(element, "padding-left");

		if (paddingTop) {
			const value = this.parsePixelValue(paddingTop);
			if (value !== null) {
				yogaNode.setPadding(this.yoga.EDGE_TOP, value);
			}
		}

		if (paddingRight) {
			const value = this.parsePixelValue(paddingRight);
			if (value !== null) {
				yogaNode.setPadding(this.yoga.EDGE_RIGHT, value);
			}
		}

		if (paddingBottom) {
			const value = this.parsePixelValue(paddingBottom);
			if (value !== null) {
				yogaNode.setPadding(this.yoga.EDGE_BOTTOM, value);
			}
		}

		if (paddingLeft) {
			const value = this.parsePixelValue(paddingLeft);
			if (value !== null) {
				yogaNode.setPadding(this.yoga.EDGE_LEFT, value);
			}
		}

		// === FLEXBOX PROPERTIES ===
		const flexGrow = getResolvedStyle(element, "flex-grow");
		const flexShrink = getResolvedStyle(element, "flex-shrink");
		const flexBasis = getResolvedStyle(element, "flex-basis");
		const alignSelf = getResolvedStyle(element, "align-self");

		if (flexGrow && flexGrow !== "0") {
			const growValue = parseFloat(flexGrow);
			if (!isNaN(growValue)) {
				yogaNode.setFlexGrow(growValue);
			}
		}

		if (flexShrink && flexShrink !== "1") {
			const shrinkValue = parseFloat(flexShrink);
			if (!isNaN(shrinkValue)) {
				yogaNode.setFlexShrink(shrinkValue);
			}
		}

		if (flexBasis && flexBasis !== "auto") {
			const basisValue = this.parsePixelValue(flexBasis);
			if (basisValue !== null) {
				yogaNode.setFlexBasis(basisValue);
			}
		}

		if (alignSelf && alignSelf !== "auto") {
			const alignValue = this.mapAlignSelf(alignSelf);
			if (alignValue !== null) {
				yogaNode.setAlignSelf(alignValue);
			}
		}

		// === FLEX CONTAINER PROPERTIES ===
		const display = getResolvedStyle(element, "display");
		if (display === "flex") {
			const justifyContent = getResolvedStyle(element, "justify-content");
			const alignItems = getResolvedStyle(element, "align-items");
			const flexWrap = getResolvedStyle(element, "flex-wrap");

			if (justifyContent) {
				const justifyValue = this.mapJustifyContent(justifyContent);
				if (justifyValue !== null) {
					yogaNode.setJustifyContent(justifyValue);
				}
			}

			if (alignItems) {
				const alignValue = this.mapAlignItems(alignItems);
				if (alignValue !== null) {
					yogaNode.setAlignItems(alignValue);
				}
			}

			if (flexWrap && flexWrap !== "nowrap") {
				const wrapValue = this.mapFlexWrap(flexWrap);
				if (wrapValue !== null) {
					yogaNode.setFlexWrap(wrapValue);
				}
			}
		}
	}

	/**
	 * Parse pixel value from CSS string (e.g., "10px" → 10, "2ch" → 2)
	 */
	private parsePixelValue(value: string): number | null {
		if (!value || value === "auto" || value === "none") {
			return null;
		}

		// Handle ch units (character width) - in terminal context, 1ch = 1 cell
		if (value.endsWith("ch")) {
			const num = parseFloat(value.slice(0, -2));
			return isNaN(num) ? null : num;
		}

		// Handle px units
		if (value.endsWith("px")) {
			const num = parseFloat(value.slice(0, -2));
			return isNaN(num) ? null : num;
		}

		// Handle unitless numbers
		const num = parseFloat(value);
		return isNaN(num) ? null : num;
	}

	/**
	 * Map CSS align-self values to Yoga constants
	 */
	private mapAlignSelf(alignSelf: string): YogaTypes.Align | null {
		switch (alignSelf) {
			case "flex-start": return this.yoga.ALIGN_FLEX_START;
			case "flex-end": return this.yoga.ALIGN_FLEX_END;
			case "center": return this.yoga.ALIGN_CENTER;
			case "baseline": return this.yoga.ALIGN_BASELINE;
			case "stretch": return this.yoga.ALIGN_STRETCH;
			default: return null;
		}
	}

	/**
	 * Map CSS justify-content values to Yoga constants
	 */
	private mapJustifyContent(justifyContent: string): YogaTypes.Justify | null {
		switch (justifyContent) {
			case "flex-start": return this.yoga.JUSTIFY_FLEX_START;
			case "flex-end": return this.yoga.JUSTIFY_FLEX_END;
			case "center": return this.yoga.JUSTIFY_CENTER;
			case "space-between": return this.yoga.JUSTIFY_SPACE_BETWEEN;
			case "space-around": return this.yoga.JUSTIFY_SPACE_AROUND;
			case "space-evenly": return this.yoga.JUSTIFY_SPACE_EVENLY;
			default: return null;
		}
	}

	/**
	 * Map CSS align-items values to Yoga constants
	 */
	private mapAlignItems(alignItems: string): YogaTypes.Align | null {
		switch (alignItems) {
			case "flex-start": return this.yoga.ALIGN_FLEX_START;
			case "flex-end": return this.yoga.ALIGN_FLEX_END;
			case "center": return this.yoga.ALIGN_CENTER;
			case "baseline": return this.yoga.ALIGN_BASELINE;
			case "stretch": return this.yoga.ALIGN_STRETCH;
			default: return null;
		}
	}

	/**
	 * Map CSS flex-wrap values to Yoga constants
	 */
	private mapFlexWrap(flexWrap: string): YogaTypes.Wrap | null {
		switch (flexWrap) {
			case "nowrap": return this.yoga.WRAP_NO_WRAP;
			case "wrap": return this.yoga.WRAP_WRAP;
			case "wrap-reverse": return this.yoga.WRAP_WRAP_REVERSE;
			default: return null;
		}
	}

	/**
	 * Create measure function for text runs in flex containers
	 * Uses complete text content but preserves node references
	 */
	private createTextRunMeasureFunction(text: string, textNodes: Node[], parent: Element) {
		return (
			width: number,
			widthMode: YogaTypes.MeasureMode,
			height: number,
			heightMode: YogaTypes.MeasureMode
		) => {
			if (!text.trim()) {
				return { width: 0, height: 0 };
			}

			// Use TextBreaker for proper line breaking with width constraints
			const breakResult = this.textBreaker.breakText(text, { maxWidth: width });
			
			// Calculate actual width and height
			const maxLineWidth = breakResult.maxLineWidth;
			const actualWidth = widthMode === this.yoga.MEASURE_MODE_EXACTLY 
				? width 
				: Math.min(maxLineWidth, width);
			const actualHeight = breakResult.totalHeight;

			// Store text layouts for rendering (associate with parent element)
			this.createTextLayoutsForTextRun(textNodes, parent, breakResult.lines, actualWidth);

			return { 
				width: actualWidth, 
				height: actualHeight 
			};
		};
	}

	/**
	 * Create measure function for inline run using linebreak library
	 */
	private createMeasureFunctionForInlineRun(nodes: Node[], parent: Element) {
		return (
			width: number,
			widthMode: YogaTypes.MeasureMode,
			height: number,
			heightMode: YogaTypes.MeasureMode
		) => {
			// Extract all text content from the inline run
			const textContent = this.extractTextFromInlineRun(nodes);
			if (!textContent.trim()) {
				return { width: 0, height: 0 };
			}

			// Use TextBreaker for proper line breaking with width constraints
			const breakResult = this.textBreaker.breakText(textContent, { maxWidth: width });
			
			// Calculate actual width and height
			const maxLineWidth = breakResult.maxLineWidth;

			const actualWidth = widthMode === this.yoga.MEASURE_MODE_EXACTLY 
				? width 
				: Math.min(maxLineWidth, width);
			
			const actualHeight = breakResult.totalHeight;

			// Store text layouts for rendering
			this.createTextLayoutsForInlineRun(nodes, parent, breakResult.lines, actualWidth);

			return { 
				width: actualWidth, 
				height: actualHeight 
			};
		};
	}

	/**
	 * Extract text content from an inline run of nodes
	 */
	private extractTextFromInlineRun(nodes: Node[]): string {
		let text = '';
		
		for (const node of nodes) {
			if (node.nodeType === node.TEXT_NODE) {
				text += node.textContent || '';
			} else if (node.nodeType === node.ELEMENT_NODE) {
				// For inline elements, recursively extract their text content
				text += (node as Element).textContent || '';
			}
		}
		
		return text;
	}


	/**
	 * Create text layouts for text runs in flex containers
	 */
	private createTextLayoutsForTextRun(
		textNodes: Node[], 
		parent: Element, 
		lines: LineBreak[], 
		containerWidth: number
	): void {
		// Convert TextBreaker LineBreak objects to TextLayout objects
		const textLayouts: TextLayout[] = [];
		
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const line = lines[lineIndex];
			if (line.text.trim()) {
				textLayouts.push({
					rect: new this.DOMRect(0, lineIndex, line.width, 1),
					text: line.text
				});
			}
		}
		
		// Store text layouts for the parent element
		// The textNodes array preserves the original DOM structure for potential future use
		const existingLayouts = this.elementTextLayouts.get(parent) || [];
		this.elementTextLayouts.set(parent, [...existingLayouts, ...textLayouts]);
	}

	/**
	 * Create text layouts for inline run nodes with line positioning
	 */
	private createTextLayoutsForInlineRun(
		nodes: Node[], 
		parent: Element, 
		lines: LineBreak[], 
		containerWidth: number
	): void {
		// Convert TextBreaker LineBreak objects to TextLayout objects
		const textLayouts: TextLayout[] = [];
		
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const line = lines[lineIndex];
			if (line.text.trim()) {
				textLayouts.push({
					rect: new this.DOMRect(0, lineIndex, line.width, 1),
					text: line.text
				});
			}
		}
		
		// Store text layouts for the parent element
		// In a more sophisticated implementation, we'd distribute these among the individual nodes
		this.elementTextLayouts.set(parent, textLayouts);
	}

	/**
	 * Extract layout data from Yoga tree and populate WeakMaps
	 */
	private extractLayoutData(element: Element, parentX: number, parentY: number): void {
		// Get the Yoga node for this element
		const yogaNode = this.elementYogaNodes.get(element);
		if (!yogaNode) return;

		// Extract computed layout from Yoga
		const x = parentX + yogaNode.getComputedLeft();
		const y = parentY + yogaNode.getComputedTop();
		const width = yogaNode.getComputedWidth();
		const height = yogaNode.getComputedHeight();

		// Store the element's bounding rect
		const rect = new this.DOMRect(x, y, width, height);
		this.elementRects.set(element, rect);

		// Process children recursively
		for (const child of element.children) {
			if (child.nodeType === child.ELEMENT_NODE) {
				this.extractLayoutData(child as Element, x, y);
			}
		}

		// Handle anonymous boxes for this element
		const anonymousBoxes = this.anonymousBoxes.get(element);
		if (anonymousBoxes) {
			for (let i = 0; i < anonymousBoxes.length; i++) {
				const boxNode = anonymousBoxes[i];
				
				// Anonymous boxes store their text layouts during measure function execution
				// The text layouts are already positioned relative to the anonymous box
				// We need to adjust them to be relative to the document
				const existingLayouts = this.elementTextLayouts.get(element) || [];
				const adjustedLayouts: TextLayout[] = [];
				
				const boxX = x + boxNode.getComputedLeft();
				const boxY = y + boxNode.getComputedTop();
				
				for (const layout of existingLayouts) {
					adjustedLayouts.push({
						rect: new this.DOMRect(
							boxX + layout.rect.x,
							boxY + layout.rect.y,
							layout.rect.width,
							layout.rect.height
						),
						text: layout.text
					});
				}
				
				// Update with document-relative positions
				if (adjustedLayouts.length > 0) {
					this.elementTextLayouts.set(element, adjustedLayouts);
				}
			}
		}
	}
}