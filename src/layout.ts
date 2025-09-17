import type {DOMWindow} from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import {breakNodes, type BreakResult} from "./breaker.js";
import {getPropertyValue, parseUnitValue} from "./styles.js";

function getAbsolutePosition(yogaNode: YogaTypes.Node): {x: number; y: number} {
	let x = 0;
	let y = 0;
	let current: YogaTypes.Node | null = yogaNode;

	for (; current; current = current.getParent()) {
		x += current.getComputedLeft();
		y += current.getComputedTop();
	}

	return {x, y};
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

function styleYogaNode(element: Element, yogaNode: YogaTypes.Node): void {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element must have an ownerDocument with defaultView");
	}
	const computedStyle = window.getComputedStyle(element);

	// Skip box model properties for inline elements (not inline-block)
	const display = computedStyle.getPropertyValue("display");
	// Handle width/height based on display type
	if (display === "inline") {
		// For pure inline elements, unset dimensions since they handle dimensions in their measure function
		yogaNode.setWidthAuto();
		yogaNode.setHeightAuto();
		// Also unset min/max constraints for pure inline elements
		yogaNode.setMinWidth(undefined);
		yogaNode.setMinHeight(undefined);
		yogaNode.setMaxWidth(undefined);
		yogaNode.setMaxHeight(undefined);
	} else if (display === "inline-block") {
		// For inline-block elements, unset width/height but preserve min/max constraints
		// This allows the measure function to work while still respecting CSS constraints
		yogaNode.setWidthAuto();
		yogaNode.setHeightAuto();

		// Apply min/max constraints for inline-block elements (like block elements)
		const minWidth = parseUnitValue(
			computedStyle.getPropertyValue("min-width"),
		);
		if (typeof minWidth === "number") {
			yogaNode.setMinWidth(minWidth);
		} else if (minWidth && "percentage" in minWidth) {
			yogaNode.setMinWidthPercent(minWidth.percentage);
		} else {
			yogaNode.setMinWidth(0);
		}

		const minHeight = parseUnitValue(
			computedStyle.getPropertyValue("min-height"),
		);
		if (typeof minHeight === "number") {
			yogaNode.setMinHeight(minHeight);
		} else if (minHeight && "percentage" in minHeight) {
			yogaNode.setMinHeightPercent(minHeight.percentage);
		} else {
			yogaNode.setMinHeight(0);
		}

		const maxWidth = parseUnitValue(
			computedStyle.getPropertyValue("max-width"),
		);
		if (typeof maxWidth === "number") {
			yogaNode.setMaxWidth(maxWidth);
		} else if (maxWidth && "percentage" in maxWidth) {
			yogaNode.setMaxWidthPercent(maxWidth.percentage);
		} else {
			yogaNode.setMaxWidth(undefined);
		}

		const maxHeight = parseUnitValue(
			computedStyle.getPropertyValue("max-height"),
		);
		if (typeof maxHeight === "number") {
			yogaNode.setMaxHeight(maxHeight);
		} else if (maxHeight && "percentage" in maxHeight) {
			yogaNode.setMaxHeightPercent(maxHeight.percentage);
		} else {
			yogaNode.setMaxHeight(undefined);
		}
	} else {
		// For block elements, apply explicit dimensions normally
		const width = parseUnitValue(computedStyle.getPropertyValue("width"));
		if (typeof width === "number") {
			yogaNode.setWidth(width);
		} else if (width && "percentage" in width) {
			yogaNode.setWidthPercent(width.percentage);
		} else {
			yogaNode.setWidthAuto();
		}

		const height = parseUnitValue(computedStyle.getPropertyValue("height"));
		if (typeof height === "number") {
			yogaNode.setHeight(height);
		} else if (height && "percentage" in height) {
			yogaNode.setHeightPercent(height.percentage);
		} else {
			yogaNode.setHeightAuto();
		}

		// Apply min/max constraints for block elements
		const minWidth = parseUnitValue(
			computedStyle.getPropertyValue("min-width"),
		);
		if (typeof minWidth === "number") {
			yogaNode.setMinWidth(minWidth);
		} else if (minWidth && "percentage" in minWidth) {
			yogaNode.setMinWidthPercent(minWidth.percentage);
		} else {
			yogaNode.setMinWidth(0);
		}

		const minHeight = parseUnitValue(
			computedStyle.getPropertyValue("min-height"),
		);
		if (typeof minHeight === "number") {
			yogaNode.setMinHeight(minHeight);
		} else if (minHeight && "percentage" in minHeight) {
			yogaNode.setMinHeightPercent(minHeight.percentage);
		} else {
			yogaNode.setMinHeight(0);
		}

		const maxWidth = parseUnitValue(
			computedStyle.getPropertyValue("max-width"),
		);
		if (typeof maxWidth === "number") {
			yogaNode.setMaxWidth(maxWidth);
		} else if (maxWidth && "percentage" in maxWidth) {
			yogaNode.setMaxWidthPercent(maxWidth.percentage);
		} else {
			yogaNode.setMaxWidth(undefined);
		}

		const maxHeight = parseUnitValue(
			computedStyle.getPropertyValue("max-height"),
		);
		if (typeof maxHeight === "number") {
			yogaNode.setMaxHeight(maxHeight);
		} else if (maxHeight && "percentage" in maxHeight) {
			yogaNode.setMaxHeightPercent(maxHeight.percentage);
		} else {
			yogaNode.setMaxHeight(undefined);
		}
	}

	// Box model properties: clear for inline elements, apply for block/inline-block
	if (display === "inline") {
		// Clear all box model properties for inline elements
		yogaNode.setMargin(Yoga.EDGE_TOP, 0);
		yogaNode.setMargin(Yoga.EDGE_RIGHT, 0);
		yogaNode.setMargin(Yoga.EDGE_BOTTOM, 0);
		yogaNode.setMargin(Yoga.EDGE_LEFT, 0);

		yogaNode.setPadding(Yoga.EDGE_TOP, 0);
		yogaNode.setPadding(Yoga.EDGE_RIGHT, 0);
		yogaNode.setPadding(Yoga.EDGE_BOTTOM, 0);
		yogaNode.setPadding(Yoga.EDGE_LEFT, 0);

		yogaNode.setBorder(Yoga.EDGE_TOP, 0);
		yogaNode.setBorder(Yoga.EDGE_RIGHT, 0);
		yogaNode.setBorder(Yoga.EDGE_BOTTOM, 0);
		yogaNode.setBorder(Yoga.EDGE_LEFT, 0);
	} else {
		// Apply normal box model properties for block/inline-block elements

		// Margins
		const marginTop = parseUnitValue(
			computedStyle.getPropertyValue("margin-top"),
		);
		if (typeof marginTop === "number") {
			yogaNode.setMargin(Yoga.EDGE_TOP, marginTop);
		} else if (marginTop && "percentage" in marginTop) {
			yogaNode.setMarginPercent(Yoga.EDGE_TOP, marginTop.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("margin-top");
			if (originalValue === "auto") {
				yogaNode.setMarginAuto(Yoga.EDGE_TOP);
			} else {
				yogaNode.setMargin(Yoga.EDGE_TOP, undefined);
			}
		}

		const marginRight = parseUnitValue(
			computedStyle.getPropertyValue("margin-right"),
		);
		if (typeof marginRight === "number") {
			yogaNode.setMargin(Yoga.EDGE_RIGHT, marginRight);
		} else if (marginRight && "percentage" in marginRight) {
			yogaNode.setMarginPercent(Yoga.EDGE_RIGHT, marginRight.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("margin-right");
			if (originalValue === "auto") {
				yogaNode.setMarginAuto(Yoga.EDGE_RIGHT);
			} else {
				yogaNode.setMargin(Yoga.EDGE_RIGHT, undefined);
			}
		}

		const marginBottom = parseUnitValue(
			computedStyle.getPropertyValue("margin-bottom"),
		);
		if (typeof marginBottom === "number") {
			yogaNode.setMargin(Yoga.EDGE_BOTTOM, marginBottom);
		} else if (marginBottom && "percentage" in marginBottom) {
			yogaNode.setMarginPercent(Yoga.EDGE_BOTTOM, marginBottom.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("margin-bottom");
			if (originalValue === "auto") {
				yogaNode.setMarginAuto(Yoga.EDGE_BOTTOM);
			} else {
				yogaNode.setMargin(Yoga.EDGE_BOTTOM, undefined);
			}
		}

		const marginLeft = parseUnitValue(
			computedStyle.getPropertyValue("margin-left"),
		);
		if (typeof marginLeft === "number") {
			yogaNode.setMargin(Yoga.EDGE_LEFT, marginLeft);
		} else if (marginLeft && "percentage" in marginLeft) {
			yogaNode.setMarginPercent(Yoga.EDGE_LEFT, marginLeft.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("margin-left");
			if (originalValue === "auto") {
				yogaNode.setMarginAuto(Yoga.EDGE_LEFT);
			} else {
				yogaNode.setMargin(Yoga.EDGE_LEFT, undefined);
			}
		}

		// Paddings
		const paddingTop = parseUnitValue(
			computedStyle.getPropertyValue("padding-top"),
		);
		if (typeof paddingTop === "number") {
			yogaNode.setPadding(Yoga.EDGE_TOP, paddingTop);
		} else if (paddingTop && "percentage" in paddingTop) {
			yogaNode.setPaddingPercent(Yoga.EDGE_TOP, paddingTop.percentage);
		} else {
			yogaNode.setPadding(Yoga.EDGE_TOP, undefined);
		}

		const paddingRight = parseUnitValue(
			computedStyle.getPropertyValue("padding-right"),
		);
		if (typeof paddingRight === "number") {
			yogaNode.setPadding(Yoga.EDGE_RIGHT, paddingRight);
		} else if (paddingRight && "percentage" in paddingRight) {
			yogaNode.setPaddingPercent(Yoga.EDGE_RIGHT, paddingRight.percentage);
		} else {
			yogaNode.setPadding(Yoga.EDGE_RIGHT, undefined);
		}

		const paddingBottom = parseUnitValue(
			computedStyle.getPropertyValue("padding-bottom"),
		);
		if (typeof paddingBottom === "number") {
			yogaNode.setPadding(Yoga.EDGE_BOTTOM, paddingBottom);
		} else if (paddingBottom && "percentage" in paddingBottom) {
			yogaNode.setPaddingPercent(Yoga.EDGE_BOTTOM, paddingBottom.percentage);
		} else {
			yogaNode.setPadding(Yoga.EDGE_BOTTOM, undefined);
		}

		const paddingLeft = parseUnitValue(
			computedStyle.getPropertyValue("padding-left"),
		);
		if (typeof paddingLeft === "number") {
			yogaNode.setPadding(Yoga.EDGE_LEFT, paddingLeft);
		} else if (paddingLeft && "percentage" in paddingLeft) {
			yogaNode.setPaddingPercent(Yoga.EDGE_LEFT, paddingLeft.percentage);
		} else {
			yogaNode.setPadding(Yoga.EDGE_LEFT, undefined);
		}

		// Border widths
		const borderTopWidth = parseUnitValue(
			computedStyle.getPropertyValue("border-top-width"),
		);
		if (typeof borderTopWidth === "number" && borderTopWidth > 0) {
			yogaNode.setBorder(Yoga.EDGE_TOP, borderTopWidth);
		} else {
			yogaNode.setBorder(Yoga.EDGE_TOP, 0);
		}

		const borderRightWidth = parseUnitValue(
			computedStyle.getPropertyValue("border-right-width"),
		);
		if (typeof borderRightWidth === "number" && borderRightWidth > 0) {
			yogaNode.setBorder(Yoga.EDGE_RIGHT, borderRightWidth);
		} else {
			yogaNode.setBorder(Yoga.EDGE_RIGHT, 0);
		}

		const borderBottomWidth = parseUnitValue(
			computedStyle.getPropertyValue("border-bottom-width"),
		);
		if (typeof borderBottomWidth === "number" && borderBottomWidth > 0) {
			yogaNode.setBorder(Yoga.EDGE_BOTTOM, borderBottomWidth);
		} else {
			yogaNode.setBorder(Yoga.EDGE_BOTTOM, 0);
		}

		const borderLeftWidth = parseUnitValue(
			computedStyle.getPropertyValue("border-left-width"),
		);
		if (typeof borderLeftWidth === "number" && borderLeftWidth > 0) {
			yogaNode.setBorder(Yoga.EDGE_LEFT, borderLeftWidth);
		} else {
			yogaNode.setBorder(Yoga.EDGE_LEFT, 0);
		}
	}

	if (
		element.parentElement
			? getPropertyValue(element.parentElement, "display")
			: null
	) {
		// We emulate display: block with yoga, but this means we need the children
		// to not have configurable flex properties, or surprising layout behavior
		// might occur.
		yogaNode.setFlexGrow(0);
		yogaNode.setFlexShrink(1);
		yogaNode.setFlexBasisAuto();
		yogaNode.setAlignSelf(Yoga.ALIGN_AUTO);
	} else {
		const flexGrow = computedStyle.getPropertyValue("flex-grow");
		const growValue = parseFloat(flexGrow);
		if (!isNaN(growValue) && growValue >= 0) {
			yogaNode.setFlexGrow(growValue);
		} else {
			yogaNode.setFlexGrow(undefined);
		}

		const flexShrink = computedStyle.getPropertyValue("flex-shrink");
		const shrinkValue = parseFloat(flexShrink);
		if (!isNaN(shrinkValue) && shrinkValue >= 0) {
			yogaNode.setFlexShrink(shrinkValue);
		} else {
			yogaNode.setFlexShrink(undefined);
		}

		const flexBasis = parseUnitValue(
			computedStyle.getPropertyValue("flex-basis"),
		);
		if (typeof flexBasis === "number") {
			yogaNode.setFlexBasis(flexBasis);
		} else if (flexBasis && "percentage" in flexBasis) {
			yogaNode.setFlexBasisPercent(flexBasis.percentage);
		} else {
			const originalValue = computedStyle.getPropertyValue("flex-basis");
			if (originalValue === "auto") {
				yogaNode.setFlexBasisAuto();
			} else {
				yogaNode.setFlexBasis(undefined);
			}
		}

		const alignSelf = computedStyle.getPropertyValue("align-self");
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

	if (display === "none") {
		yogaNode.setDisplay(Yoga.DISPLAY_NONE);
	} else if (display === "flex") {
		yogaNode.setDisplay(Yoga.DISPLAY_FLEX);

		const flexDirection = computedStyle.getPropertyValue("flex-direction");
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

		const flexWrap = computedStyle.getPropertyValue("flex-wrap");
		if (flexWrap === "nowrap") {
			yogaNode.setFlexWrap(Yoga.WRAP_NO_WRAP);
		} else if (flexWrap === "wrap") {
			yogaNode.setFlexWrap(Yoga.WRAP_WRAP);
		} else if (flexWrap === "wrap-reverse") {
			yogaNode.setFlexWrap(Yoga.WRAP_WRAP_REVERSE);
		} else {
			yogaNode.setFlexWrap(Yoga.WRAP_NO_WRAP);
		}

		const justifyContent = computedStyle.getPropertyValue("justify-content");
		const justifyValue = getYogaConstant("justify", justifyContent);
		if (justifyValue !== null) {
			yogaNode.setJustifyContent(justifyValue);
		} else {
			yogaNode.setJustifyContent(Yoga.JUSTIFY_FLEX_START);
		}

		const alignItems = computedStyle.getPropertyValue("align-items");
		const alignValue = getYogaConstant("align", alignItems);
		if (alignValue !== null) {
			yogaNode.setAlignItems(alignValue);
		} else {
			yogaNode.setAlignItems(Yoga.ALIGN_STRETCH);
		}

		const alignContent = computedStyle.getPropertyValue("align-content");
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

class DOMRectList extends Array<DOMRect> implements globalThis.DOMRectList {
	item(index: number): globalThis.DOMRect | null {
		if (index < 0 || index >= this.length) {
			return null;
		}
		return this[index];
	}
}

Object.defineProperty(DOMRectList.prototype, Symbol.toStringTag, {
	value: "DOMRectList",
	configurable: true,
});

export interface RectText {
	rect: DOMRect;
	text: string; // Processed text to render (replaces textLength)
}

const yogaConfig = Yoga.Config.create();
yogaConfig.setUseWebDefaults(true);
yogaConfig.setPointScaleFactor(1.0);

export class LayoutEngine {
	declare DOMRect: typeof DOMRect;
	declare rootElement: Element;
	declare observer: MutationObserver;
	declare window: DOMWindow;

	// TODO:
	declare terminalWidth: number;
	declare terminalHeight: number;

	// TODO: These should be strong maps
	declare nodeMap: WeakMap<Node, YogaTypes.Node>;
	declare breakResultMap: WeakMap<Node, BreakResult>;

	// Shadow DOM support
	private getShadowRoot?: (element: Element) => ShadowRoot | null;
	private getMergedTree?: (element: Element) => DocumentFragment | null;
	private getOriginalNode?: (node: Node) => Node | null;

	constructor(
		window: DOMWindow,
		getShadowRoot?: (element: Element) => ShadowRoot | null,
		getMergedTree?: (element: Element) => DocumentFragment | null,
		getOriginalNode?: (node: Node) => Node | null,
	) {
		this.window = window;
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new WeakMap<Node, YogaTypes.Node>();
		this.breakResultMap = new WeakMap<Node, BreakResult>();
		this.getShadowRoot = getShadowRoot;
		this.getMergedTree = getMergedTree;
		this.getOriginalNode = getOriginalNode;
		this.observer = new window.MutationObserver((mutations) =>
			this.handleMutationRecords(mutations),
		);

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

		const rootYogaNode = this.nodeMap.get(this.rootElement);
		if (rootYogaNode) {
			rootYogaNode.setWidth(width);
			rootYogaNode.setHeight(height);
			rootYogaNode.calculateLayout(width, height);
		}
	}

	calculateLayout() {
		const records = this.observer.takeRecords();
		this.handleMutationRecords(records);

		const rootYogaNode = this.nodeMap.get(this.rootElement);
		if (rootYogaNode) {
			rootYogaNode.calculateLayout(this.terminalWidth, this.terminalHeight);
		}
	}

	getRect(element: Element): DOMRect | null {
		const display = getPropertyValue(element, "display");

		// For inline/inline-block elements, check if they appear in breakResults
		if (display === "inline" || display === "inline-block") {
			// For inline-block elements, search through all breakResults to find this element
			if (display === "inline-block") {
				// Find the inline run head that contains this element
				const runHead = this.findInlineRunHead(element);
				if (runHead) {
					const breakResult = this.breakResultMap.get(runHead);
					if (breakResult) {
						for (const line of breakResult.lines) {
							for (const segment of line.segments) {
								if (
									segment.leaf.type === "inline-block" &&
									segment.leaf.node === element
								) {
									// Get absolute position of the inline-block element
									const yogaNode = this.nodeMap.get(element);
									if (!yogaNode) {
										// Fallback to relative position if no yoga node
										return new this.DOMRect(
											segment.x,
											line.y,
											segment.width,
											line.height,
										);
									}
									const {x, y} = getAbsolutePosition(yogaNode);
									return new this.DOMRect(x, y, segment.width, line.height);
								}
							}
						}
					}
				}
			}

			// For inline elements, use getRectTexts
			const rectTexts = this.getRectTexts(element);
			if (rectTexts.length > 0) {
				// Calculate bounding box from all rectTexts
				let minX = Infinity;
				let minY = Infinity;
				let maxX = -Infinity;
				let maxY = -Infinity;

				for (const rectText of rectTexts) {
					const rect = rectText.rect;
					minX = Math.min(minX, rect.x);
					minY = Math.min(minY, rect.y);
					maxX = Math.max(maxX, rect.x + rect.width);
					maxY = Math.max(maxY, rect.y + rect.height);
				}

				return new this.DOMRect(minX, minY, maxX - minX, maxY - minY);
			}
		}

		// Fall back to Yoga node for block elements and containers
		let yogaNode = this.nodeMap.get(element);

		// If this is a cloned element and we don't have layout data for it,
		// try to use the original element's layout data
		if (!yogaNode && this.getOriginalNode) {
			const originalNode = this.getOriginalNode(element);
			if (originalNode && originalNode.nodeType === originalNode.ELEMENT_NODE) {
				yogaNode = this.nodeMap.get(originalNode);
			}
		}

		if (!yogaNode) {
			return null;
		}

		const {x, y} = getAbsolutePosition(yogaNode);

		return new this.DOMRect(
			x,
			y,
			yogaNode.getComputedWidth(),
			yogaNode.getComputedHeight(),
		);
	}

	getRectTexts(node: Node): RectText[] {
		// This method handles two main scenarios:
		// 1. Direct calls on inline-block elements (special case below)
		// 2. Calls on elements/text inside inline-blocks (general walk-up logic)

		// Handle element nodes
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");

			// For block elements, return empty array (no inline text layout)
			if (display !== "inline" && display !== "inline-block") {
				return [];
			}

			// Special case: inline-block element called directly (e.g., getRectTexts(inlineBlockDiv))
			// The element's breakResult contains itself as an inline-block segment with nested content
			if (display === "inline-block" && this.isInlineRunHead(element)) {
				const breakResult = this.breakResultMap.get(element);
				if (breakResult) {
					// The breakResult contains this inline-block as a segment with nested content
					const rectTexts: RectText[] = [];
					const yogaNode = this.nodeMap.get(element);
					if (!yogaNode) return [];

					const {x: containerX, y: containerY} = getAbsolutePosition(yogaNode);

					for (const line of breakResult.lines) {
						for (const segment of line.segments) {
							if (
								segment.leaf.type === "inline-block" &&
								segment.leaf.node === element &&
								segment.leaf.breakResult
							) {
								// Extract text from the nested breakResult
								const nestedBreakResult = segment.leaf.breakResult;
								for (const nestedLine of nestedBreakResult.lines) {
									for (const nestedSegment of nestedLine.segments) {
										if (nestedSegment.leaf.type === "text") {
											rectTexts.push({
												text: nestedSegment.processedText,
												rect: new this.DOMRect(
													containerX + segment.x + nestedSegment.x,
													containerY + line.y + nestedLine.y,
													nestedSegment.width,
													nestedLine.height,
												),
											});
										}
									}
								}
							}
						}
					}
					return rectTexts;
				}
			}
		}

		// Find the inline run head for this node
		const runHead = this.findInlineRunHead(node);
		if (!runHead) {
			return [];
		}

		// Get stored BreakResult for the run head
		let breakResult = this.breakResultMap.get(runHead);
		if (!breakResult) {
			return [];
		}

		// Get run head's absolute position by accumulating parent positions
		const yogaNode = this.nodeMap.get(runHead);
		if (!yogaNode) return [];

		let {x: containerX, y: containerY} = getAbsolutePosition(yogaNode);

		// Walk from target node up to runHead, handling nested inline-blocks
		// This handles the case where getRectTexts is called on elements/text inside inline-blocks
		let currentBreakResult = breakResult;
		let accumulatedOffsetX = 0;
		let accumulatedOffsetY = 0;
		let currentNode = node;

		while (currentNode !== runHead && currentNode.parentElement) {
			const parent = currentNode.parentElement;

			if (getPropertyValue(parent, "display") === "inline-block") {
				// Find this inline-block in current breakResult
				let found = false;
				for (const line of currentBreakResult.lines) {
					for (const segment of line.segments) {
						if (
							segment.leaf.type === "inline-block" &&
							segment.leaf.node === parent
						) {
							// Accumulate offset and switch to internal breakResult
							accumulatedOffsetX += segment.x;
							accumulatedOffsetY += line.y;
							if (segment.leaf.breakResult) {
								currentBreakResult = segment.leaf.breakResult;
							}
							found = true;
							break;
						}
					}
					if (found) break;
				}
			}
			currentNode = parent;
		}

		// Apply accumulated offsets
		containerX += accumulatedOffsetX;
		containerY += accumulatedOffsetY;
		breakResult = currentBreakResult;

		// Collect target text nodes based on node type
		let targetTextNodes: Set<Text>;

		if (node.nodeType === node.TEXT_NODE) {
			targetTextNodes = new Set([node as Text]);
		} else {
			// For element nodes, collect all descendant text nodes
			targetTextNodes = new Set<Text>();
			const window = (node as Element).ownerDocument!.defaultView!;
			const walker = window.document.createTreeWalker(
				node,
				window.NodeFilter.SHOW_TEXT,
				null,
			);

			let textNode;
			while ((textNode = walker.nextNode())) {
				targetTextNodes.add(textNode as Text);
			}
		}

		const rectTexts: RectText[] = [];

		// Merge segments per line that belong to this node
		for (const line of breakResult.lines) {
			let minX = Infinity;
			let maxX = -Infinity;
			let hasSegments = false;
			let concatenatedText = "";

			// Find the extent of segments on this line that belong to our target node
			for (const segment of line.segments) {
				if (
					segment.leaf.type === "text" &&
					targetTextNodes.has(segment.leaf.node as Text)
				) {
					minX = Math.min(minX, segment.x);
					maxX = Math.max(maxX, segment.x + segment.width);
					concatenatedText += segment.processedText;
					hasSegments = true;
				}
			}

			if (hasSegments) {
				const rect = new this.DOMRect(
					containerX + minX,
					containerY + line.y,
					maxX - minX,
					line.height,
				);
				rectTexts.push({
					rect,
					text: concatenatedText,
				});
			}
		}

		return rectTexts;
	}

	getRects(node: Node): DOMRect[] {
		// For block elements, just return getBoundingClientRect in an array
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");

			if (display !== "inline" && display !== "inline-block") {
				// Block element - use standard getBoundingClientRect
				const rect = this.getRect(element);
				return rect ? [rect] : [];
			}
		}

		// For inline elements, use getRectTexts and extract just the rects
		return this.getRectTexts(node).map((rectText) => rectText.rect);
	}

	createDOMRectList(rects?: globalThis.DOMRect[]): globalThis.DOMRectList {
		const list = new DOMRectList();
		if (rects) {
			list.push(...rects);
		}
		return list;
	}

	createDOMRect(
		x: number = 0,
		y: number = 0,
		width: number = 0,
		height: number = 0,
	): globalThis.DOMRect {
		return new this.DOMRect(x, y, width, height);
	}

	dispose(): void {
		this.observer.disconnect();
	}

	isInlineRunHead(node: Node): boolean {
		return this.findInlineRunHead(node) === node;
	}

	findInlineRunHead(node: Node): Node | null {
		// 1. Validate input
		if (!node.isConnected) {
			return null;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");
			if (display !== "inline" && display !== "inline-block") {
				return null;
			}
		} else if (node.nodeType !== node.TEXT_NODE) {
			return null;
		}

		// 2. Create TreeWalker to traverse only elements and text nodes
		const walker = this.window.document.createTreeWalker(
			node.ownerDocument || this.window.document,
			this.window.NodeFilter.SHOW_ELEMENT | this.window.NodeFilter.SHOW_TEXT,
			null,
		);

		// Position walker at starting node
		walker.currentNode = node;
		let current = node;

		// 3. Traverse up through inline parents
		while (walker.parentNode()) {
			const parent = walker.currentNode;
			if (parent.nodeType !== parent.ELEMENT_NODE) continue;

			const parentDisplay = getPropertyValue(parent as Element, "display");

			if (parentDisplay === "inline" || parentDisplay === "inline-block") {
				current = parent;
			} else {
				break;
			}
		}

		// 4. Reset walker to current position and check container type
		walker.currentNode = current;
		const isInFlex =
			current.parentElement &&
			getPropertyValue(current.parentElement, "display") === "flex";

		if (isInFlex) {
			// 5a. Flex container traversal
			if (current.nodeType === current.ELEMENT_NODE) {
				return current; // Elements in flex are their own run heads
			}

			while (walker.previousSibling()) {
				const prev = walker.currentNode;

				if (prev.nodeType === prev.ELEMENT_NODE) {
					break; // Stop at any element in flex
				}
				// Must be text node due to TreeWalker filter
				current = prev;
			}
		} else {
			// 5b. Normal flow traversal
			while (walker.previousSibling()) {
				const prev = walker.currentNode;

				if (prev.nodeType === prev.ELEMENT_NODE) {
					const prevElement = prev as Element;
					const prevDisplay = getPropertyValue(prevElement, "display");
					if (prevDisplay === "inline" || prevDisplay === "inline-block") {
						current = prevElement;
					} else {
						break;
					}
				} else {
					// Must be text node due to TreeWalker filter
					current = prev;
				}
			}
		}

		return current;
	}

	// TODO: delete these terrible functions
	/**
	 * Get the children to traverse for layout - merged tree if available, otherwise light DOM
	 */
	private getChildrenForLayout(element: Element): NodeListOf<ChildNode> {
		const mergedTree = this.getMergedTree?.(element);
		if (mergedTree) {
			return mergedTree.childNodes;
		}
		return element.childNodes;
	}

	/**
	 * Get the effective children for layout, using merged tree when available
	 */
	private getEffectiveChildrenForLayout(element: Element): Node[] {
		const mergedTree = this.getMergedTree?.(element);
		if (mergedTree) {
			// For shadow DOM with merged tree, use the merged children directly
			return Array.from(mergedTree.childNodes);
		}
		return Array.from(element.childNodes);
	}

	private handleMutationRecords(mutations: MutationRecord[]): void {
		for (let i = 0; i < mutations.length; i++) {
			const record = mutations[i];

			if (record.type === "attributes") {
				if (record.attributeName === "style") {
					const element = record.target as Element;
					const yogaNode = this.nodeMap.get(element);
					if (yogaNode) {
						styleYogaNode(element, yogaNode);
					}
				}
				return;
			} else if (record.type === "characterData") {
				// TODO: Handle characterData
				// invalidate run head
				return;
			}

			for (let j = 0; j < record.addedNodes.length; j++) {
				const node = record.addedNodes[j];
				const parentYogaNode = this.nodeMap.get(record.target as Element);
				if (!parentYogaNode) {
					throw new Error(
						`No parent Yoga node found for added node ${node.nodeName} under ${(record.target as Element).tagName}`,
					);
				}
				this.addNode(node, parentYogaNode);
			}

			for (let j = 0; j < record.removedNodes.length; j++) {
				const node = record.removedNodes[j];
				const yogaNode = this.nodeMap.get(node);
				if (yogaNode) {
					const parent = this.nodeMap.get(record.target as Element);
					if (parent) {
						parent.removeChild(yogaNode);
					}
					yogaNode.freeRecursive();
					this.nodeMap.delete(node);
				}
			}
		}
	}

	private addNode(
		node: Node,
		parentYogaNode: YogaTypes.Node | null = null,
	): void {
		if (this.nodeMap.has(node)) {
			return;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			this.addElementNode(node as Element, parentYogaNode);
		} else if (node.nodeType === node.TEXT_NODE) {
			this.addTextNode(node as Text, parentYogaNode);
		}
	}

	private addElementNode(
		element: Element,
		parentYogaNode: YogaTypes.Node | null = null,
		yogaIndex: number = this.getYogaIndex(element),
	): void {
		const display = getPropertyValue(element, "display");
		if (display === "inline" || display === "inline-block") {
			if (!this.isInlineRunHead(element)) {
				return;
			}
		}

		let yogaNode = this.nodeMap.get(element);
		if (!yogaNode) {
			yogaNode = Yoga.Node.createWithConfig(yogaConfig);
			this.nodeMap.set(element, yogaNode);
		}

		styleYogaNode(element, yogaNode);

		if (element.tagName === "BODY") {
			yogaNode.setHeightPercent(100);
		}

		if (display === "none") {
			yogaNode.setDisplay(Yoga.DISPLAY_NONE);
			if (yogaNode && parentYogaNode) {
				parentYogaNode.insertChild(yogaNode, yogaIndex);
			}
			return;
		} else if (display === "inline" || display === "inline-block") {
			yogaNode.setMeasureFunc((width, widthMode, height, heightMode) => {
				return this.measureInlineRun(
					element,
					width,
					widthMode,
					height,
					heightMode,
				);
			});

			// Note: Automatic minimum size for flex items is now handled in measureInlineRun

			if (yogaNode && parentYogaNode) {
				parentYogaNode.insertChild(yogaNode, yogaIndex);
			}

			return;
		}

		// Block elements should NOT get measure functions - only their inline children do.
		// This prevents Yoga constraint violations (nodes with measure functions cannot have children)

		const measuredChildNodes = this.getChildrenForLayout(element);
		for (let i = 0; i < measuredChildNodes.length; i++) {
			const child = measuredChildNodes[i];
			if (child.nodeType === child.ELEMENT_NODE) {
				const childDisplay = getPropertyValue(child as Element, "display");
				if (childDisplay === "inline" || childDisplay === "inline-block") {
					if (display === "flex") {
						this.addElementNode(child as Element, yogaNode);
					} else {
						this.addElementNode(child as Element, yogaNode);
					}
				} else {
					this.addElementNode(child as Element, yogaNode);
				}
			} else if (child.nodeType === child.TEXT_NODE) {
				// Text nodes need to be added to the layout tree
				this.addTextNode(child as Text, yogaNode);
			}
		}

		if (yogaNode && parentYogaNode) {
			parentYogaNode.insertChild(yogaNode, yogaIndex);
		}
	}

	private addTextNode(
		text: Text,
		parentYogaNode: YogaTypes.Node | null = null,
	): void {
		// Process all text nodes, even if they appear empty
		// (they might contain whitespace that's significant for layout)

		if (!parentYogaNode) {
			return;
		}

		if (this.isInlineRunHead(text)) {
			let yogaNode = this.nodeMap.get(text);
			if (!yogaNode) {
				yogaNode = Yoga.Node.createWithConfig(yogaConfig);
				this.nodeMap.set(text, yogaNode);
			}

			yogaNode.setMeasureFunc(
				(
					width: number,
					widthMode: YogaTypes.MeasureMode,
					height: number,
					heightMode: YogaTypes.MeasureMode,
				) => {
					return this.measureInlineRun(
						text,
						width,
						widthMode,
						height,
						heightMode,
					);
				},
			);

			// Note: Automatic minimum size for flex items is now handled in measureInlineRun

			parentYogaNode.insertChild(yogaNode, parentYogaNode.getChildCount());
		}
	}

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
				const siblingDisplay = getPropertyValue(siblingElement, "display");

				if (
					(siblingDisplay === "inline" || siblingDisplay === "inline-block") &&
					!this.isInlineRunHead(siblingElement)
				) {
					continue;
				}

				const siblingYogaNode = this.nodeMap.get(siblingElement);
				if (siblingYogaNode) {
					yogaIndex++;
				}
			}
		}
		return yogaIndex;
	}

	private measureInlineRun(
		node: Node,
		width: number,
		widthMode: YogaTypes.MeasureMode,
		height: number,
		heightMode: YogaTypes.MeasureMode,
	): {width: number; height: number} {
		const breakResult = breakNodes(node, width, widthMode, height, heightMode);

		// Store the BreakResult for later use by getRects()
		this.breakResultMap.set(node, breakResult);

		const result = {
			width: breakResult.maxLineWidth,
			height: breakResult.totalHeight,
		};

		return result;
	}
}

export function computeBoundingRect(
	DOMRect: typeof globalThis.DOMRect,
	rects: DOMRect[] | DOMRectList,
): DOMRect {
	const rectArray: DOMRect[] = Array.from(rects);
	if (rectArray.length === 0) {
		return new DOMRect(0, 0, 0, 0);
	}

	if (rectArray.length === 1) {
		return rectArray[0];
	}

	let minLeft = Infinity;
	let minTop = Infinity;
	let maxRight = -Infinity;
	let maxBottom = -Infinity;

	for (const rect of rectArray) {
		minLeft = Math.min(minLeft, rect.left);
		minTop = Math.min(minTop, rect.top);
		maxRight = Math.max(maxRight, rect.right);
		maxBottom = Math.max(maxBottom, rect.bottom);
	}

	return new DOMRect(minLeft, minTop, maxRight - minLeft, maxBottom - minTop);
}

export function isPointInRects(
	x: number,
	y: number,
	...rects: Array<DOMRect | DOMRect[] | DOMRectList>
): boolean {
	const allRects = rects.flat();
	return allRects.some((rect) => {
		if (Array.isArray(rect) || rect instanceof DOMRectList) {
			// Handle nested arrays/lists
			return isPointInRects(x, y, ...rect);
		}
		return (
			x >= rect.x &&
			x < rect.x + rect.width &&
			y >= rect.y &&
			y < rect.y + rect.height
		);
	});
}
