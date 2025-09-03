import type {DOMWindow} from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import {resolvePropertyValue} from "../css.js";
import {breakNodes, type Leaf, type BreakResult} from "../text/TextBreaker.js";

export interface TextLayout {
	rect: DOMRect;
	text: string;
}

const yogaConfig = Yoga.Config.create();
yogaConfig.setUseWebDefaults(true);
yogaConfig.setPointScaleFactor(1.0);

export class LayoutEngine {
	// Layout state
	declare DOMRect: typeof DOMRect;
	declare rootElement: Element;
	declare observer: MutationObserver;

	// TODO: the terminal width and height should be defined and updated on the window
	declare terminalWidth: number;
	declare terminalHeight: number;

	// TODO: Can we make these (strong) maps?
	declare nodeMap: WeakMap<Node, YogaTypes.Node>;
	// TODO: Indicate in the name that this is for inline elements and text nodes
	// TODO: Use TextLayout interface not, intersection
	declare nodeRects: WeakMap<Node, Array<DOMRect & {text?: string}>>;

	constructor(window: DOMWindow) {
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new WeakMap<Node, YogaTypes.Node>();
		this.nodeRects = new WeakMap<Node, Array<DOMRect & {text?: string}>>();
		this.observer = new window.MutationObserver((mutations) => this.handleMutationRecords(mutations));

		// TODO: Because we only do inline styles, we might be able to pass an
		// attribute filter and listen for style changes only
		this.observer.observe(this.rootElement, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});
		this.addNode(this.rootElement, null);
	}

	resize(width: number, height: number): void {
		this.terminalWidth = width;
		this.terminalHeight = height;

		// Set root element dimensions to match viewport
		const rootYogaNode = this.nodeMap.get(this.rootElement);
		if (rootYogaNode) {
			rootYogaNode.setWidth(width);
			rootYogaNode.setHeight(height);
			rootYogaNode.calculateLayout(width, height);
			// Process inline runs after layout calculation
			this.processInlineRuns(this.rootElement);
		}
	}

	calculateLayout() {
		const records = this.observer.takeRecords();
		this.handleMutationRecords(records);

		// Run actual layout calculation
		const rootYogaNode = this.nodeMap.get(this.rootElement);
		if (rootYogaNode) {
			rootYogaNode.calculateLayout(this.terminalWidth, this.terminalHeight);

			// Process inline runs after layout calculation
			this.processInlineRuns(this.rootElement);
		}
	}

	getRect(element: Element): DOMRect | null {
		const yogaNode = this.nodeMap.get(element);
		if (!yogaNode) {
			return null;
		}

		// Calculate absolute position by walking up the parent chain
		let x = 0;
		let y = 0;
		let current = element;

		while (current) {
			const currentNode = this.nodeMap.get(current);
			if (currentNode) {
				x += currentNode.getComputedLeft();
				y += currentNode.getComputedTop();
			}

			// Move to parent element
			if (current.parentElement && current !== this.rootElement) {
				current = current.parentElement;
			} else {
				break;
			}
		}

		return new this.DOMRect(
			x,
			y,
			yogaNode.getComputedWidth(),
			yogaNode.getComputedHeight(),
		);
	}
	// TODO: return type is missing
	getRects(node: Node): DOMRect[] {
		// Return cached rects if available
		return this.nodeRects.get(node) || [];
	}

	// TODO: dispose MutationObserver and all Yoga nodes
	dispose(): void {}

	private handleMutationRecords(mutations: MutationRecord[]): void {
		let needsLayout = false;
		for (let i = 0; i < mutations.length; i++) {
			const record = mutations[i];

			// Handle attribute changes (style modifications)
			if (record.type === "attributes" && record.attributeName === "style") {
				const element = record.target as Element;
				const yogaNode = this.nodeMap.get(element);
				if (yogaNode) {
					styleYogaNode(element, yogaNode);
					needsLayout = true;
				}
			}

			// Handle added nodes
			for (let j = 0; j < record.addedNodes.length; j++) {
				const node = record.addedNodes[j];
				const parentYogaNode = this.nodeMap.get(record.target as Element);
				if (!parentYogaNode) {
					throw new Error(
						`No parent Yoga node found for added node ${node.nodeName} under ${(record.target as Element).tagName}`,
					);
				}
				this.addNode(node, parentYogaNode);
				needsLayout = true;
			}

			// TODO: Separate method
			// Handle removed nodes
			for (let j = 0; j < record.removedNodes.length; j++) {
				const node = record.removedNodes[j];
				const yogaNode = this.nodeMap.get(node);
				if (yogaNode) {
					// Remove from parent and free
					const parent = this.nodeMap.get(record.target as Element);
					if (parent) {
						parent.removeChild(yogaNode);
					}
					yogaNode.freeRecursive();
					this.nodeMap.delete(node);
					needsLayout = true;
				}
			}
		}

		// Layout will be calculated by the caller in calculateLayout()
	}

	/**
	 * Add a rect to a node's rect collection
	 */
	private addRectToNode(node: Node, rect: DOMRect & {text?: string}): void {
		const rects = this.nodeRects.get(node) || [];
		rects.push(rect);
		this.nodeRects.set(node, rects);
	}

	/**
	 * Add a node to the layout tree
	 */
	private addNode(
		node: Node,
		parentYogaNode: YogaTypes.Node | null = null,
	): void {
		// Skip if this node already has a Yoga node
		if (this.nodeMap.has(node)) {
			return;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			this.addElement(node as Element, parentYogaNode);
		} else if (node.nodeType === node.TEXT_NODE) {
			this.addTextNode(node as Text, parentYogaNode);
		}
	}

	/**
	 * Add an element to the layout tree
	 */
	private addElement(
		element: Element,
		parentYogaNode: YogaTypes.Node | null = null,
		yogaIndex: number = this.getYogaIndex(element),
	): void {
		const display = resolvePropertyValue(element, "display", false);

		// Check if this inline element is part of an inline run
		if (display === "inline" || display === "inline-block") {
			if (!isInlineRunHead(element)) {
				return; // Not the head, don't create a Yoga node
			}
			// This is an inline run head - continue to create Yoga node and set measure function
		}

		let yogaNode = this.nodeMap.get(element);
		if (!yogaNode) {
			yogaNode = Yoga.Node.createWithConfig(yogaConfig);
			this.nodeMap.set(element, yogaNode);
		}

		// Apply CSS properties including display
		styleYogaNode(element, yogaNode);

		// Special handling for BODY element - make it fill the viewport
		if (element.tagName === "BODY") {
			yogaNode.setHeightPercent(100);
		}

		// Skip processing children if display: none, but keep the node in tree
		if (display === "none") {
			yogaNode.setDisplay(Yoga.DISPLAY_NONE);
			// Early return - don't process children
			if (yogaNode && parentYogaNode) {
				parentYogaNode.insertChild(yogaNode, yogaIndex);
			}
			return;
		} else if (display === "inline" || display === "inline-block") {
			// This is an inline run head - set measure function
			yogaNode.setMeasureFunc((width, widthMode, height, heightMode) => {
				return this.measureInlineRun(
					element,
					width,
					widthMode,
					height,
					heightMode,
				);
			});

			if (yogaNode && parentYogaNode) {
				parentYogaNode.insertChild(yogaNode, yogaIndex);
			}

			// Don't process children - they're part of the inline run
			return;
		}

		// Check if this is a block element with inline content that needs measurement
		let hasInlineContent = false;
		for (const child of element.childNodes) {
			if (child.nodeType === child.TEXT_NODE && child.textContent?.trim()) {
				hasInlineContent = true;
				break;
			} else if (child.nodeType === child.ELEMENT_NODE) {
				const childDisplay = resolvePropertyValue(child as Element, "display");
				if (childDisplay === "inline" || childDisplay === "inline-block") {
					hasInlineContent = true;
					break;
				}
			}
		}

		// If block element has inline content and no explicit height, give it a measure function
		// But only if it doesn't have block-level children (Yoga restriction)
		// AND it's not a flex container (flex containers handle their own layout)
		let hasBlockChildren = false;
		for (const child of element.childNodes) {
			if (child.nodeType === child.ELEMENT_NODE) {
				const childDisplay = resolvePropertyValue(child as Element, "display");
				if (childDisplay !== "inline" && childDisplay !== "inline-block") {
					hasBlockChildren = true;
					break;
				}
			}
		}

		// Don't add measure function to flex containers - they use flexbox layout
		if (
			hasInlineContent &&
			!hasBlockChildren &&
			display !== "flex" &&
			!resolvePropertyValue(element, "height", false)
		) {
			yogaNode.setMeasureFunc((width, widthMode, height, heightMode) => {
				return this.measureInlineRun(
					element,
					width,
					widthMode,
					height,
					heightMode,
				);
			});
		}

		// Process children
		for (let i = 0; i < element.childNodes.length; i++) {
			const child = element.childNodes[i];
			if (child.nodeType === child.ELEMENT_NODE) {
				const childDisplay = resolvePropertyValue(child as Element, "display");
				if (childDisplay === "inline" || childDisplay === "inline-block") {
					if (display === "flex") {
						// Inline elements in flex containers become flex items
						this.addElement(child as Element, yogaNode);
					} else {
						// Regular inline elements - only process if they're inline run heads
						this.addElement(child as Element, yogaNode);
					}
				} else {
					// Block-level child
					this.addElement(child as Element, yogaNode);
				}
			} else if (child.nodeType === child.TEXT_NODE) {
				// Text nodes are handled during inline run measurement
			}
		}

		if (yogaNode && parentYogaNode) {
			try {
				parentYogaNode.insertChild(yogaNode, yogaIndex);
			} catch (err) {
				// Silently handle insertion errors
			}
		}
	}

	/**
	 * Add a text node to the layout tree
	 * 
	 * Text nodes that are inline run heads get Yoga nodes with measure functions.
	 * Other text nodes are handled during inline layout processing.
	 */
	private addTextNode(
		text: Text,
		parentYogaNode: YogaTypes.Node | null = null,
	): void {
		// Skip empty or whitespace-only text nodes
		if (!text.textContent || !text.textContent.trim()) {
			return;
		}
		
		if (!parentYogaNode) {
			return;
		}
		
		// Only create Yoga nodes for text nodes that are inline run heads
		if (isInlineRunHead(text)) {
			let yogaNode = this.nodeMap.get(text);
			if (!yogaNode) {
				yogaNode = Yoga.Node.createWithConfig(yogaConfig);
				this.nodeMap.set(text, yogaNode);
			}
			
			// Set up measure function for inline content
			yogaNode.setMeasureFunc((
				widthMode: YogaTypes.MeasureMode,
				width: number,
				heightMode: YogaTypes.MeasureMode,
				height: number,
			) => {
				return this.measureInlineRun(text.parentElement!, widthMode, width, heightMode, height);
			});
			
			// Add to parent
			parentYogaNode.insertChild(yogaNode, parentYogaNode.getChildCount());
		}
		
		// Non-run-head text nodes are handled during inline layout processing
	}

	/**
	 * Get the Yoga index for an element based on its position among siblings
	 */
	private getYogaIndex(element: Element): number {
		if (!element.parentElement) {
			return 0;
		}

		let yogaIndex = 0;
		for (let i = 0; i < element.parentElement.childNodes.length; i++) {
			const sibling = element.parentElement.childNodes[i];
			if (sibling === element) {
				break;
			}
			if (sibling.nodeType === sibling.ELEMENT_NODE) {
				const siblingElement = sibling as Element;
				const siblingDisplay = resolvePropertyValue(siblingElement, "display");

				// Skip inline elements that are not run heads
				if (
					(siblingDisplay === "inline" || siblingDisplay === "inline-block") &&
					!isInlineRunHead(siblingElement)
				) {
					continue;
				}

				// Count this sibling if it should have a yoga node
				const siblingYogaNode = this.nodeMap.get(siblingElement);
				if (siblingYogaNode) {
					yogaIndex++;
				}
			}
		}
		return yogaIndex;
	}

	/**
	 * Process inline runs after Yoga layout calculation
	 */
	private processInlineRuns(
		element: Element,
		parentX: number = 0,
		parentY: number = 0,
	): void {
		const yogaNode = this.nodeMap.get(element);
		let elementX = parentX;
		let elementY = parentY;

		if (yogaNode) {
			// Calculate absolute position by adding parent offset
			elementX = parentX + yogaNode.getComputedLeft();
			elementY = parentY + yogaNode.getComputedTop();
		}

		// Check if this is an inline run head OR a block element with inline content
		const display = resolvePropertyValue(element, "display");
		if (
			(display === "inline" || display === "inline-block") &&
			isInlineRunHead(element)
		) {
			if (yogaNode) {
				const width = yogaNode.getComputedWidth();
				this.layoutInlineRun(element, elementX, elementY, width);
			}
		} else if (display === "block" || display === "flex") {
			// Check if this block element has inline content (text or inline elements)
			let hasInlineContent = false;
			for (const child of element.childNodes) {
				if (child.nodeType === child.TEXT_NODE && child.textContent?.trim()) {
					hasInlineContent = true;
					break;
				} else if (child.nodeType === child.ELEMENT_NODE) {
					const childDisplay = resolvePropertyValue(
						child as Element,
						"display",
					);
					if (childDisplay === "inline" || childDisplay === "inline-block") {
						hasInlineContent = true;
						break;
					}
				}
			}

			if (hasInlineContent && yogaNode) {
				const width = yogaNode.getComputedWidth();
				this.layoutInlineRun(element, elementX, elementY, width);
			}
		}

		// Process children with updated parent position
		for (let i = 0; i < element.childNodes.length; i++) {
			const child = element.childNodes[i];
			if (child.nodeType === child.ELEMENT_NODE) {
				this.processInlineRuns(child as Element, elementX, elementY);
			}
		}
	}

	/**
	 * Collect all leaf nodes (text and inline-block) from an inline formatting context
	 */
	private collectLeafNodes(element: Element): Leaf[] {
		const leafNodes: Leaf[] = [];

		// Check if this element is in a flex container
		const parentDisplay = element.parentElement
			? resolvePropertyValue(element.parentElement, "display")
			: null;
		const isFlexItem = parentDisplay === "flex";

		// If this is an inline run head AND not a flex item, collect from all elements in the run
		if (isInlineRunHead(element) && !isFlexItem) {
			// Start from the head and collect all inline siblings
			let current: Node | null = element;
			while (current) {
				if (current.nodeType === current.ELEMENT_NODE) {
					const el = current as Element;
					const display = resolvePropertyValue(el, "display");
					if (display !== "inline" && display !== "inline-block") {
						break; // Hit a block element, stop
					}
				}

				// Traverse this node
				this.traverseNode(current, leafNodes);

				// Move to next sibling
				current = current.nextSibling;
			}
		} else {
			// For flex items or block elements, collect from this element's children
			// But check for inline run heads among children
			const processedNodes = new Set<Node>();
			
			for (let i = 0; i < element.childNodes.length; i++) {
				const child = element.childNodes[i];
				
				// Skip if already processed as part of an inline run
				if (processedNodes.has(child)) {
					continue;
				}
				
				// Check if this child is an inline run head
				if (isInlineRunHead(child)) {
					// This child starts an inline run - collect the entire run
					let current: Node | null = child;
					while (current) {
						if (current.nodeType === current.ELEMENT_NODE) {
							const el = current as Element;
							const display = resolvePropertyValue(el, "display");
							if (display !== "inline" && display !== "inline-block") {
								break; // Hit a block element, stop
							}
						}

						// Traverse this node and mark as processed
						this.traverseNode(current, leafNodes);
						processedNodes.add(current);

						// Move to next sibling
						current = current.nextSibling;
					}
				} else {
					// Not an inline run head - just process this single node
					this.traverseNode(child, leafNodes);
				}
			}
		}

		return leafNodes;
	}

	private traverseNode(node: Node, leafNodes: Leaf[]): void {
		const traverse = (node: Node) => {
			if (node.nodeType === node.TEXT_NODE) {
				const text = node as Text;
				if (text.textContent && text.textContent.trim()) {
					leafNodes.push({
						type: "text",
						node: text,
						content: text.textContent,
					});
				}
			} else if (node.nodeType === node.ELEMENT_NODE) {
				const el = node as Element;
				const display = resolvePropertyValue(el, "display");

				if (display === "inline-block") {
					// Measure inline-block element
					const size = this.measureInlineBlock(el);
					leafNodes.push({
						type: "inline-block",
						node: el,
						width: size.width,
						height: size.height,
					});
				} else if (display === "inline") {
					// Traverse inline elements to find their text/inline-block children
					for (let i = 0; i < el.childNodes.length; i++) {
						traverse(el.childNodes[i]);
					}
				} else if (el.tagName === "BR") {
					leafNodes.push({
						type: "br",
						node: el as HTMLBRElement,
					});
				}
			}
		};

		// Start traversal from the node
		traverse(node);
	}

	/**
	 * Measure an inline-block element to get its intrinsic size
	 */
	private measureInlineBlock(element: Element): {
		width: number;
		height: number;
	} {
		// TODO: We need to iterate through the children to find newlines, but
		// we don't do natural line breaks
		// TODO: We need to use width/height from CSS if set
		// TODO: imgs?
		const textContent = element.textContent || "";
		return {
			width: Bun.stringWidth(textContent),
			height: 1,
		};
	}

	/**
	 * Measure an inline run (inline formatting context) and set its dimensions
	 */
	private measureInlineRun(
		element: Element,
		width: number,
		widthMode: YogaTypes.MeasureMode,
		height: number,
		heightMode: YogaTypes.MeasureMode,
	): {width: number; height: number} {
		// Use width as maxWidth for text breaking
		// If width is 0 or undefined, measure with no wrapping to get preferred width
		const maxWidth =
			widthMode === Yoga.MEASURE_MODE_UNDEFINED || width === 0
				? Number.MAX_SAFE_INTEGER
				: width;
		// Collect all leaf nodes
		const leafNodes = this.collectLeafNodes(element);

		// Get CSS properties for text breaking
		let whiteSpace = resolvePropertyValue(element, "white-space") as any;
		const wordBreak = resolvePropertyValue(element, "word-break") as any;
		const overflowWrap = resolvePropertyValue(element, "overflow-wrap") as any;

		// In flex containers, inline elements should not wrap unless explicitly sized
		if (
			element.parentElement &&
			resolvePropertyValue(element.parentElement, "display") === "flex"
		) {
			// If no explicit width is set, use nowrap behavior
			if (widthMode === Yoga.MEASURE_MODE_UNDEFINED) {
				whiteSpace = "nowrap";
			}
		}

		// Use TextBreaker to break the content into lines
		const breakResult = breakNodes(leafNodes, {
			maxWidth,
			whiteSpace: whiteSpace || "normal",
			wordBreak: wordBreak || "normal",
			overflowWrap: overflowWrap || "normal",
		});

		// Note: Padding is handled by Yoga, so we only return content size
		const result = {
			width: breakResult.maxLineWidth,
			height: breakResult.totalHeight,
		};
		return result;
	}

	/**
	 * Layout an inline run and distribute rects to all nodes
	 */
	private layoutInlineRun(
		element: Element,
		x: number,
		y: number,
		maxWidth: number,
	): void {
		// Collect all leaf nodes
		const leafNodes = this.collectLeafNodes(element);

		// Get CSS properties
		let whiteSpace = resolvePropertyValue(element, "white-space") as any;
		const wordBreak = resolvePropertyValue(element, "word-break") as any;
		const overflowWrap = resolvePropertyValue(element, "overflow-wrap") as any;

		// In flex containers with row direction, inline elements should not wrap
		// But in column direction, they should wrap normally
		if (
			element.parentElement &&
			resolvePropertyValue(element.parentElement, "display") === "flex"
		) {
			const flexDirection =
				resolvePropertyValue(element.parentElement, "flex-direction") || "row";
			if (flexDirection === "row" || flexDirection === "row-reverse") {
				whiteSpace = "nowrap";
			}
		}

		// Break content into lines
		const breakResult = breakNodes(leafNodes, {
			maxWidth,
			whiteSpace: whiteSpace || "normal",
			wordBreak: wordBreak || "normal",
			overflowWrap: overflowWrap || "normal",
		});

		// Distribute rects to all nodes
		this.distributeRects(breakResult, element, x, y);
	}

	/**
	 * Distribute rects from line breaking results to DOM nodes
	 */
	private distributeRects(
		breakResult: BreakResult,
		rootElement: Element,
		startX: number,
		startY: number,
	): void {
		// Clear existing rects
		const clearRects = (node: Node) => {
			this.nodeRects.delete(node);
			if (node.nodeType === node.ELEMENT_NODE) {
				const el = node as Element;
				for (let i = 0; i < el.childNodes.length; i++) {
					clearRects(el.childNodes[i]);
				}
			}
		};
		clearRects(rootElement);

		// Create rects for each line segment
		for (const line of breakResult.lines) {
			for (const segment of line.segments) {
				const rect = new this.DOMRect(
					startX + segment.x,
					startY + line.y,
					segment.width,
					line.height,
				) as DOMRect & {text?: string};

				// Add text content for text segments
				if (segment.leaf.type === "text" && segment.leaf.content) {
					rect.text = segment.leaf.content.slice(segment.start, segment.end);
				}

				// Add rect to the leaf node
				this.addRectToNode(segment.leaf.node, rect);

				// Propagate rect to all inline ancestors
				let parent = segment.leaf.node.parentElement;
				while (parent && parent !== rootElement.parentElement) {
					const display = resolvePropertyValue(parent, "display");
					if (display === "inline" || display === "inline-block") {
						this.addRectToNode(parent, rect);
					} else {
						break; // Stop at block boundaries
					}
					parent = parent.parentElement;
				}
			}
		}
	}
}

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

/**
 * Parse unit from CSS string and return value or percentage info
 * Examples: "10px" → 10, "50%" → {percentage: 50}, "auto" → null
 * In TermDOM, all CSS units are treated as cells: px = ch = em
 */
// TODO: vw/vh
function parseUnitValue(value: string): number | {percentage: number} | null {
	if (!value || !/^\d/.test(value)) {
		return null;
	}

	// Handle percentage units
	if (value.endsWith("%")) {
		const num = parseFloat(value.slice(0, -1));
		if (isNaN(num)) return null;
		// If we have parentSize, return the calculated value, otherwise return percentage object
		return {percentage: num};
	}

	const num = parseFloat(value);
	return isNaN(num) ? null : num;

	// TODO: vw/vh units
}

/**
 * Apply CSS properties to Yoga node
 */
function styleYogaNode(element: Element, yogaNode: YogaTypes.Node): void {
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

	// === MARGINS ===
	// TODO: The originalValue retrieval seems redundant.
	const marginTop = parseUnitValue(
		resolvePropertyValue(element, "margin-top", false),
	);
	if (typeof marginTop === "number") {
		yogaNode.setMargin(Yoga.EDGE_TOP, marginTop);
	} else if (marginTop && "percentage" in marginTop) {
		yogaNode.setMarginPercent(Yoga.EDGE_TOP, marginTop.percentage);
	} else {
		// Check if original value was 'auto'
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

	// === PADDING ===
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

	// === FLEXBOX ITEM PROPERTIES ===
	if (
		element.parentElement &&
		resolvePropertyValue(element.parentElement, "display") === "block"
	) {
		// Block layout children shouldn't flex
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
			// Check if original value was 'auto'
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
		if (
			flexDirection &&
			flexDirection !== "row" &&
			flexDirection !== "initial" &&
			flexDirection !== "inherit" &&
			flexDirection !== "unset"
		) {
			switch (flexDirection) {
				case "column":
					yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
					break;
				case "row-reverse":
					yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW_REVERSE);
					break;
				case "column-reverse":
					yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN_REVERSE);
					break;
			}
		}

		const flexWrap = resolvePropertyValue(element, "flex-wrap");
		if (
			flexWrap &&
			flexWrap !== "nowrap" &&
			flexWrap !== "initial" &&
			flexWrap !== "inherit" &&
			flexWrap !== "unset"
		) {
			const wrapValue = getYogaConstant("wrap", flexWrap);
			if (wrapValue !== null) {
				yogaNode.setFlexWrap(wrapValue);
			}
		}

		const justifyContent = resolvePropertyValue(element, "justify-content");
		if (
			justifyContent &&
			justifyContent !== "flex-start" &&
			justifyContent !== "initial" &&
			justifyContent !== "inherit" &&
			justifyContent !== "unset"
		) {
			const justifyValue = getYogaConstant("justify", justifyContent);
			if (justifyValue !== null) {
				yogaNode.setJustifyContent(justifyValue);
			}
		}

		const alignItems = resolvePropertyValue(element, "align-items");
		if (
			alignItems &&
			alignItems !== "stretch" &&
			alignItems !== "initial" &&
			alignItems !== "inherit" &&
			alignItems !== "unset"
		) {
			const alignValue = getYogaConstant("align", alignItems);
			if (alignValue !== null) {
				yogaNode.setAlignItems(alignValue);
			}
		}

		const alignContent = resolvePropertyValue(element, "align-content");
		if (
			alignContent &&
			alignContent !== "stretch" &&
			alignContent !== "initial" &&
			alignContent !== "inherit" &&
			alignContent !== "unset"
		) {
			const alignValue = getYogaConstant("align", alignContent);
			if (alignValue !== null) {
				yogaNode.setAlignContent(alignValue);
			}
		}
	} else if (display === "block" || display === "inline-block" || !display) {
		// Emulate block layout using flexbox
		yogaNode.setDisplay(Yoga.DISPLAY_FLEX);
		yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
		yogaNode.setAlignItems(Yoga.ALIGN_STRETCH);
	}
}

/**
 * Check if a node is the head of an inline run (first inline content in sequence)
 */
export function isInlineRunHead(node: Node): boolean {
	// Only elements and text nodes can be inline
	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;
		const display = resolvePropertyValue(element, "display", false);
		if (display !== "inline" && display !== "inline-block") {
			return false;
		}

		const parentDisplay = element.parentElement
			? resolvePropertyValue(element.parentElement, "display", false)
			: "block";

		// In flex containers, inline elements are flex items (always run heads)
		if (parentDisplay === "flex") {
			return true;
		}
	} else if (node.nodeType === node.TEXT_NODE) {
		// Text nodes are always inline content
		// In flex containers, text nodes only form runs with other text nodes
		if (node.parentElement) {
			const parentDisplay = resolvePropertyValue(
				node.parentElement,
				"display",
				false,
			);
			if (parentDisplay === "flex") {
				// In flex containers, only adjacent text nodes can form runs
				// Any element between text nodes breaks the run
				let prevSibling = node.previousSibling;
				while (prevSibling) {
					if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
						if (prevSibling.textContent) {
							return false; // Adjacent text content exists
						}
						// Skip empty text nodes and continue
					} else {
						// Any element breaks text runs in flex containers
						return true; // This text is head of new run
					}
					prevSibling = prevSibling.previousSibling;
				}
				return true; // No previous content in flex container
			}
		}
	} else {
		return false; // Other node types are not inline
	}

	// In block containers, check if there's any previous inline content
	let prevSibling = node.previousSibling;
	while (prevSibling) {
		if (prevSibling.nodeType === prevSibling.ELEMENT_NODE) {
			const prevDisplay = resolvePropertyValue(
				prevSibling as Element,
				"display",
				false,
			);
			if (prevDisplay === "inline" || prevDisplay === "inline-block") {
				return false; // Not head - previous inline element exists
			} else {
				return true; // Head - previous sibling is block
			}
		} else if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
			if (prevSibling.textContent) {
				return false; // Not head - previous text content exists
			}
			// Skip empty text nodes
		}
		prevSibling = prevSibling.previousSibling;
	}

	return true; // Head - no previous inline content
}

/**
 * Find the head node of an inline run that contains the given node
 */
export function findInlineRunHead(node: Node): Node | null {
	// Only elements and text nodes can be in inline runs
	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;
		const display = resolvePropertyValue(element, "display", false);
		if (display !== "inline" && display !== "inline-block") {
			return null; // Not an inline element
		}
	} else if (node.nodeType !== node.TEXT_NODE) {
		return null; // Not inline content
	}

	// For inline elements, first traverse up to find the outermost inline ancestor
	let startNode = node;
	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;

		// Traverse up to find the outermost inline ancestor
		let current = element;
		while (current.parentElement) {
			const parentDisplay = resolvePropertyValue(
				current.parentElement,
				"display",
				false,
			);

			// If parent is flex, each child is its own item
			if (parentDisplay === "flex") {
				return current; // In flex, return this element as its own head
			}

			// If parent is inline, continue up
			if (parentDisplay === "inline" || parentDisplay === "inline-block") {
				current = current.parentElement;
				startNode = current;
			} else {
				// Parent is block-like, current is the outermost inline
				startNode = current;
				break;
			}
		}
	}

	// For text nodes in flex containers, only consider other text nodes
	if (node.nodeType === node.TEXT_NODE && node.parentElement) {
		const parentDisplay = resolvePropertyValue(
			node.parentElement,
			"display",
			false,
		);
		if (parentDisplay === "flex") {
			let current = node;
			while (current.previousSibling) {
				const prevSibling = current.previousSibling;
				if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
					if (prevSibling.textContent) {
						current = prevSibling;
					} else {
						// Skip empty text nodes
					}
				} else {
					break; // Stop at non-text nodes in flex containers
				}
			}
			return current;
		}
	}

	// Now traverse backwards from the outermost inline to find the head
	let current = startNode;
	while (current.previousSibling) {
		const prevSibling = current.previousSibling;

		if (prevSibling.nodeType === prevSibling.ELEMENT_NODE) {
			const prevElement = prevSibling as Element;
			const prevDisplay = resolvePropertyValue(prevElement, "display", false);
			if (prevDisplay === "inline" || prevDisplay === "inline-block") {
				current = prevElement; // Continue backwards
			} else {
				break; // Block element - current is the head
			}
		} else if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
			// Text nodes are part of inline runs - continue backwards
			current = prevSibling;
		} else {
			break; // Other node type breaks inline run
		}
	}

	return current;
}
