import type {DOMWindow} from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import LineBreaker from "linebreak";
import {getBoxModel, type BoxModel} from "./styles.js";
import {getPropertyValue, parseUnitValue} from "./styles.js";
import {
	createExpandedTreeWalker,
	NodeFilterExtended,
	getPseudoMetadata,
} from "./composition.js";

function getAbsolutePosition(yogaNode: YogaTypes.Node): {
	x: number;
	y: number;
} {
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

	const parentDisplay = element.parentElement
		? getPropertyValue(element.parentElement, "display")
		: null;

	if (parentDisplay === "block") {
		// We emulate display: block with yoga, but this means we need the children
		// to not have configurable flex properties, or surprising layout behavior
		// might occur.
		yogaNode.setFlexGrow(0);
		yogaNode.setFlexShrink(0); // Prevent shrinking in block containers
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

	// Handle positioning properties
	const position = computedStyle.getPropertyValue("position");
	if (position === "absolute") {
		yogaNode.setPositionType(Yoga.POSITION_TYPE_ABSOLUTE);

		// Handle left positioning
		const left = parseUnitValue(computedStyle.getPropertyValue("left"));
		if (typeof left === "number") {
			yogaNode.setPosition(Yoga.EDGE_LEFT, left);
		} else if (left && "percentage" in left) {
			yogaNode.setPositionPercent(Yoga.EDGE_LEFT, left.percentage);
		} else {
			const originalLeft = computedStyle.getPropertyValue("left");
			if (originalLeft === "auto" || !originalLeft) {
				yogaNode.setPositionAuto(Yoga.EDGE_LEFT);
			}
		}

		// Handle top positioning
		const top = parseUnitValue(computedStyle.getPropertyValue("top"));
		if (typeof top === "number") {
			yogaNode.setPosition(Yoga.EDGE_TOP, top);
		} else if (top && "percentage" in top) {
			yogaNode.setPositionPercent(Yoga.EDGE_TOP, top.percentage);
		} else {
			const originalTop = computedStyle.getPropertyValue("top");
			if (originalTop === "auto" || !originalTop) {
				yogaNode.setPositionAuto(Yoga.EDGE_TOP);
			}
		}

		// Handle right positioning
		const right = parseUnitValue(computedStyle.getPropertyValue("right"));
		if (typeof right === "number") {
			yogaNode.setPosition(Yoga.EDGE_RIGHT, right);
		} else if (right && "percentage" in right) {
			yogaNode.setPositionPercent(Yoga.EDGE_RIGHT, right.percentage);
		} else {
			const originalRight = computedStyle.getPropertyValue("right");
			if (originalRight === "auto" || !originalRight) {
				yogaNode.setPositionAuto(Yoga.EDGE_RIGHT);
			}
		}

		// Handle bottom positioning
		const bottom = parseUnitValue(computedStyle.getPropertyValue("bottom"));
		if (typeof bottom === "number") {
			yogaNode.setPosition(Yoga.EDGE_BOTTOM, bottom);
		} else if (bottom && "percentage" in bottom) {
			yogaNode.setPositionPercent(Yoga.EDGE_BOTTOM, bottom.percentage);
		} else {
			const originalBottom = computedStyle.getPropertyValue("bottom");
			if (originalBottom === "auto" || !originalBottom) {
				yogaNode.setPositionAuto(Yoga.EDGE_BOTTOM);
			}
		}
	} else if (position === "relative") {
		yogaNode.setPositionType(Yoga.POSITION_TYPE_RELATIVE);
		// For relative positioning, also apply left/top/right/bottom offsets
		// (same pattern as absolute, but with relative position type)
		const left = parseUnitValue(computedStyle.getPropertyValue("left"));
		if (typeof left === "number") {
			yogaNode.setPosition(Yoga.EDGE_LEFT, left);
		} else if (left && "percentage" in left) {
			yogaNode.setPositionPercent(Yoga.EDGE_LEFT, left.percentage);
		}

		const top = parseUnitValue(computedStyle.getPropertyValue("top"));
		if (typeof top === "number") {
			yogaNode.setPosition(Yoga.EDGE_TOP, top);
		} else if (top && "percentage" in top) {
			yogaNode.setPositionPercent(Yoga.EDGE_TOP, top.percentage);
		}
	} else if (position === "static") {
		yogaNode.setPositionType(Yoga.POSITION_TYPE_STATIC);
		// Static positioning ignores left/top/right/bottom properties
	} else {
		// Default to static positioning for any unrecognized values
		yogaNode.setPositionType(Yoga.POSITION_TYPE_STATIC);
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

// Inline layout types (moved from breaker.ts)
export interface InlineBlockLeaf {
	type: "inline-block";
	node: Element;
	breakResult?: BreakResult;
	boxModel: BoxModel;
	contentWidth: number;
	contentHeight: number;
}

export interface TextLeaf {
	type: "text";
	node: Text;
	content: string;
}

export interface BRLeaf {
	type: "br";
	node: HTMLBRElement;
}

export type Leaf = InlineBlockLeaf | TextLeaf | BRLeaf;

export interface LineResult {
	segments: Array<{
		leaf: Leaf;
		start: number;
		end: number;
		x: number;
		width: number;
		processedText: string;
	}>;
	y: number;
	width: number;
	height: number;
}

export interface BreakResult {
	lines: LineResult[];
	maxLineWidth: number;
	totalHeight: number;
}

interface BreakOptions {
	maxWidth: number;
	whiteSpace?: string;
	wordBreak?: string;
	overflowWrap?: string;
}

interface ProcessedContent {
	items: Array<{
		leafNode: Leaf;
		start: number;
		end: number;
		processedContent?: string;
	}>;
	text: string;
}

interface BreakPoint {
	position: number;
	required: boolean;
}

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

	// Viewport root node - represents terminal dimensions, no DOM element associated
	declare viewportRootNode: YogaTypes.Node;

	// TODO: These should be strong maps
	declare nodeMap: WeakMap<Node, YogaTypes.Node>;
	declare breakResultMap: WeakMap<Node, BreakResult>;

	constructor(window: DOMWindow) {
		this.window = window;
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new WeakMap<Node, YogaTypes.Node>();
		this.breakResultMap = new WeakMap<Node, BreakResult>();
		this.observer = new window.MutationObserver((mutations) =>
			this.#handleMutationRecords(mutations),
		);

		// Create viewport root node (no DOM element associated)
		this.viewportRootNode = Yoga.Node.create();
		this.viewportRootNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
		this.viewportRootNode.setAlignItems(Yoga.ALIGN_STRETCH);

		this.observer.observe(this.rootElement, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});
		// Attach HTML element to viewport root instead of null
		this.#addNode(this.rootElement, this.viewportRootNode);
	}

	resize(width: number, height: number): void {
		this.terminalWidth = width;
		this.terminalHeight = height;

		// Set dimensions on the viewport root node (terminal dimensions)
		this.viewportRootNode.setWidth(width);
		this.viewportRootNode.setHeight(height);

		// Force recalculation of all layout after size change
		this.calculateLayout();
	}

	calculateLayout() {
		const records = this.observer.takeRecords();
		this.#handleMutationRecords(records);

		// Calculate layout using viewport root node (terminal dimensions)
		// The HTML element can now have auto height and reference viewport via percentages
		this.viewportRootNode.calculateLayout(
			this.terminalWidth,
			this.terminalHeight,
		);
	}

	/**
	 * Clean up yoga nodes and resources
	 */
	dispose(): void {
		// Clean up viewport root node (this will recursively free all child yoga nodes)
		this.viewportRootNode.freeRecursive();

		// Clear the maps (WeakMap doesn't support iteration, but the nodes are freed above)
		this.nodeMap = new WeakMap();
		this.breakResultMap = new WeakMap();

		// Disconnect observer
		this.observer.disconnect();
	}

	/**
	 * Get the actual height of the document content after layout calculation
	 * Used for implementing standard DOM scrollHeight property
	 */
	getContentHeight(): number {
		const bodyRect = this.getRect(this.rootElement.ownerDocument?.body);
		if (bodyRect) {
			return Math.ceil(bodyRect.height);
		}
		return 0;
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
								// Get padding offsets for text positioning
								const paddingLeft = segment.leaf.boxModel.paddingLeft;
								const paddingTop = segment.leaf.boxModel.paddingTop;
								for (const nestedLine of nestedBreakResult.lines) {
									for (const nestedSegment of nestedLine.segments) {
										if (nestedSegment.leaf.type === "text") {
											rectTexts.push({
												text: nestedSegment.processedText,
												rect: new this.DOMRect(
													containerX +
														segment.x +
														paddingLeft +
														nestedSegment.x,
													containerY + line.y + paddingTop + nestedLine.y,
													nestedSegment.width,
													nestedLine.height,
												),
											});
										} else if (
											nestedSegment.leaf.type === "inline-block" &&
											nestedSegment.leaf.breakResult
										) {
											// Recursively extract text from nested inline-block
											const nestedInlineBlock = nestedSegment.leaf;
											const nestedPaddingLeft =
												nestedInlineBlock.boxModel.paddingLeft;
											const nestedPaddingTop =
												nestedInlineBlock.boxModel.paddingTop;

											for (const innerLine of nestedInlineBlock.breakResult!
												.lines) {
												for (const innerSegment of innerLine.segments) {
													if (innerSegment.leaf.type === "text") {
														rectTexts.push({
															text: innerSegment.processedText,
															rect: new this.DOMRect(
																containerX +
																	segment.x +
																	paddingLeft +
																	nestedSegment.x +
																	nestedPaddingLeft +
																	innerSegment.x,
																containerY +
																	line.y +
																	paddingTop +
																	nestedLine.y +
																	nestedPaddingTop +
																	innerLine.y,
																innerSegment.width,
																innerLine.height,
															),
														});
													}
													// Could add more nesting levels here if needed
												}
											}
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
							// Accumulate offset including padding and switch to internal breakResult
							accumulatedOffsetX +=
								segment.x + segment.leaf.boxModel.paddingLeft;
							accumulatedOffsetY += line.y + segment.leaf.boxModel.paddingTop;
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

			// Use ExpandedTreeWalker for traversal
			const walker = createExpandedTreeWalker(
				this.window,
				node,
				this.window.NodeFilter.SHOW_TEXT |
					NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
				null,
			);

			let textNode;
			while ((textNode = walker.nextNode())) {
				targetTextNodes.add(textNode as Text);
			}
		}

		const rectTexts: RectText[] = [];

		// Helper function to recursively find target text nodes in segments
		const findTargetTextInSegments = (
			segments: any[],
			baseX: number,
			baseY: number,
		): Array<{x: number; width: number; text: string}> => {
			const results: Array<{x: number; width: number; text: string}> = [];

			for (const segment of segments) {
				if (
					segment.leaf.type === "text" &&
					targetTextNodes.has(segment.leaf.node as Text)
				) {
					results.push({
						x: baseX + segment.x,
						width: segment.width,
						text: segment.processedText,
					});
				} else if (
					segment.leaf.type === "inline-block" &&
					segment.leaf.breakResult
				) {
					// Recursively search within nested inline-block
					const paddingLeft = segment.leaf.boxModel.paddingLeft;
					const paddingTop = segment.leaf.boxModel.paddingTop;

					for (const nestedLine of segment.leaf.breakResult.lines) {
						const nestedResults = findTargetTextInSegments(
							nestedLine.segments,
							baseX + segment.x + paddingLeft,
							baseY + paddingTop + nestedLine.y,
						);
						results.push(...nestedResults);
					}
				}
			}

			return results;
		};

		// Merge segments per line that belong to this node
		for (const line of breakResult.lines) {
			const targetTexts = findTargetTextInSegments(line.segments, 0, line.y);

			if (targetTexts.length > 0) {
				let minX = Infinity;
				let maxX = -Infinity;
				let concatenatedText = "";

				for (const targetText of targetTexts) {
					minX = Math.min(minX, targetText.x);
					maxX = Math.max(maxX, targetText.x + targetText.width);
					concatenatedText += targetText.text;
				}

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

	/**
	 * A "run head" is the first node in a contiguous run of inline-level
	 * elements. This is a TermDOM implementation detail for implementing CSS
	 * inline layout with Yoga measurement functions.
	 *
	 * The run head node:
	 * - Gets the Yoga node with a measure function
	 * - Assigns a breakResult entry
	 * - Other inline nodes in the run delegate their layout to this head
	 *
	 * Examples:
	 * - "Hello" + <span>world</span>: "Hello" text node is run head
	 * - <em>text</em> + "more": <em> element is run head
	 * - <div>text</div>: "text" is run head (block creates new context)
	 * - In flex containers: each flex item gets its own run head
	 * - Block interruption: <span>text</span><div>block</div><span>more</span>
	 *   creates separate runs with separate heads
	 *
	 * Note: Pseudo-elements (::before, ::marker, ::after) are treated as
	 * text nodes and can participate in inline runs.
	 */
	findInlineRunHead(node: Node): Node | null {
		// 1. Validate input
		if (!node.isConnected) {
			// For pseudo elements, check if the host element is connected
			const pseudoMetadata = getPseudoMetadata(node);
			if (!pseudoMetadata || !pseudoMetadata.hostElement.isConnected) {
				return null;
			}
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

		// 2. Create ExpandedTreeWalker to traverse elements, text nodes, and pseudo-elements
		const walker = createExpandedTreeWalker(
			this.window,
			node.ownerDocument || this.window.document,
			this.window.NodeFilter.SHOW_ELEMENT |
				this.window.NodeFilter.SHOW_TEXT |
				NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
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

			if (parentDisplay === "inline") {
				current = parent;
			} else if (parentDisplay === "inline-block") {
				// Only walk up through inline-block if current node is inline (not inline-block)
				if (node.nodeType === node.ELEMENT_NODE) {
					const nodeDisplay = getPropertyValue(node as Element, "display");
					if (nodeDisplay === "inline") {
						current = parent;
					} else {
						// Current node is inline-block, stop here
						break;
					}
				} else {
					// Current node is text, can walk up through inline-block
					current = parent;
				}
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

	isInlineRunHead(node: Node): boolean {
		return this.findInlineRunHead(node) === node;
	}

	/**
	 * Invalidate a node, handling both block and inline elements appropriately
	 * For inline elements, invalidates the entire inline run
	 * For block elements, invalidates their layout by removing from nodeMap
	 */
	invalidate(node: Node): void {
		// If it's an inline-level node, invalidate the entire run
		if (this.#isInlineLevel(node)) {
			this.#invalidateInlineRun(node);
		} else if (node.nodeType === node.ELEMENT_NODE) {
			// For block-level elements, remove from nodeMap to force recreation
			// We can't call markDirty() on container nodes as Yoga only allows
			// leaf nodes with measure functions to be marked dirty
			const yogaNode = this.nodeMap.get(node);
			if (yogaNode) {
				// Get parent before removing from map
				const parent = yogaNode.getParent();
				if (parent) {
					parent.removeChild(yogaNode);
				}

				// Check if node was actually removed vs just being invalidated (e.g., for pseudo-elements)
				if (!node.isConnected) {
					// Node was truly removed from DOM - free it
					yogaNode.freeRecursive();
					this.nodeMap.delete(node);
				} else {
					// Node is still connected - just remove from parent but keep Yoga node for reuse
					// This happens during pseudo-element attachment invalidation
					// Don't free the node - it will be reattached during layout calculation
				}
			}
		}
	}

	#clearBreakResultCache(node: Node): void {
		// Find the run head for this node
		const runHead = this.findInlineRunHead(node);
		if (runHead) {
			this.breakResultMap.delete(runHead);
		}
	}

	#invalidateInlineRun(node: Node): void {
		const runHead = this.findInlineRunHead(node);
		if (runHead) {
			// Clear cached break results
			this.breakResultMap.delete(runHead);

			// If this node has a Yoga node but is NOT the run head, clean it up
			if (runHead !== node && this.nodeMap.has(node)) {
				const yogaNode = this.nodeMap.get(node);
				if (yogaNode) {
					// Remove from parent
					const parent = node.parentElement;
					if (parent) {
						const parentYogaNode = this.nodeMap.get(parent);
						if (parentYogaNode) {
							parentYogaNode.removeChild(yogaNode);
						}
					}
					// Free and remove from map
					const pseudoMeta = getPseudoMetadata(node);
					if (pseudoMeta) {
						// Removing pseudo element from nodeMap during invalidateInlineRun cleanup
					}
					yogaNode.freeRecursive();
					this.nodeMap.delete(node);
				}
			}

			// Ensure the actual run head has a Yoga node
			if (!this.nodeMap.has(runHead)) {
				// Find the parent that should contain this run head's Yoga node
				let parent = runHead.parentElement;
				while (parent) {
					const parentYogaNode = this.nodeMap.get(parent);
					if (parentYogaNode) {
						// Add the run head to the layout tree
						this.#addNode(runHead, parentYogaNode);
						break;
					}
					parent = parent.parentElement;
				}
			} else {
				// Run head already has Yoga node, just mark it dirty
				const yogaNode = this.nodeMap.get(runHead);
				if (yogaNode) {
					yogaNode.markDirty();
				}
			}
		}
	}

	#isInlineLevel(node: Node): boolean {
		if (node.nodeType === node.TEXT_NODE) {
			// Regular text nodes and pseudo-element text nodes are inline-level
			return true;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");
			return display === "inline" || display === "inline-block";
		}

		return false;
	}

	/**
	 * Determines if a whitespace-only text node should be collapsed to nothing
	 * according to CSS whitespace collapsing rules in block formatting contexts
	 */
	#shouldCollapseWhitespaceTextNode(textNode: Text): boolean {
		// Only collapse whitespace-only text nodes
		if (!textNode.textContent || !/^\s*$/.test(textNode.textContent)) {
			return false;
		}

		// Get parent element
		const parent = textNode.parentElement;
		if (!parent) {
			return false;
		}

		// Check parent's display type - only collapse in block formatting contexts
		const parentDisplay = getPropertyValue(parent, "display");
		if (parentDisplay === "inline" || parentDisplay === "inline-block") {
			// In inline contexts, preserve whitespace as spaces
			return false;
		}

		// Check if this whitespace is between block-level elements
		const prevSibling = textNode.previousSibling;
		const nextSibling = textNode.nextSibling;

		// Helper to check if a node is block-level
		const isBlockLevel = (node: Node | null): boolean => {
			if (!node || node.nodeType !== node.ELEMENT_NODE) {
				return false;
			}
			const display = getPropertyValue(node as Element, "display");
			return display !== "inline" && display !== "inline-block";
		};

		// If whitespace is between two block elements, collapse it
		if (isBlockLevel(prevSibling) && isBlockLevel(nextSibling)) {
			return true;
		}

		// If whitespace is at the start/end of a block container next to a block element, collapse it
		if (isBlockLevel(prevSibling) && !nextSibling) {
			return true; // End of container after block element
		}

		if (!prevSibling && isBlockLevel(nextSibling)) {
			return true; // Start of container before block element
		}

		// If whitespace is the only content at start/end of block container, collapse it
		if (!prevSibling && !nextSibling) {
			return true; // Only content in block container
		}

		return false;
	}

	#handleMutationRecords(mutations: MutationRecord[]): void {
		for (let i = 0; i < mutations.length; i++) {
			const record = mutations[i];
			if (record.type === "attributes") {
				if (record.attributeName === "style") {
					const element = record.target as Element;
					const yogaNode = this.nodeMap.get(element);
					if (yogaNode) {
						styleYogaNode(element, yogaNode);
						// Invalidate inline runs if style changes might affect layout
						this.#invalidateInlineRun(element);
					}
				}
				return;
			} else if (record.type === "characterData") {
				const textNode = record.target as Text;
				// Invalidate the inline run containing this text node
				this.#invalidateInlineRun(textNode);
				return;
			}

			// Handle added nodes
			for (let j = 0; j < record.addedNodes.length; j++) {
				const node = record.addedNodes[j];
				const parentElement = record.target as Element;
				const parentYogaNode = this.nodeMap.get(parentElement);

				// Skip adding children if parent is inline-block (it uses measure function and cannot have children)
				const parentDisplay = getPropertyValue(parentElement, "display");
				if (parentDisplay === "inline-block") {
					continue;
				}

				if (!parentYogaNode) {
					// If parent has no Yoga node, it might be an inline element that's part of a run
					// Instead of adding to Yoga tree, just invalidate the inline run
					if (this.#isInlineLevel(node)) {
						this.#invalidateInlineRun(node);
						this.#invalidateInlineRun(parentElement); // Also invalidate parent's run
						continue; // Skip normal Yoga tree addition
					} else {
						// Block elements should have parents with Yoga nodes
						throw new Error(
							`No parent Yoga node found for added node ${node.nodeName} under ${parentElement.tagName}`,
						);
					}
				}

				// Add the node to Yoga layout
				this.#addNode(node, parentYogaNode);

				// Invalidate inline runs that might be affected by this addition
				if (this.#isInlineLevel(node)) {
					// If adding an inline node, invalidate the run it joins
					this.#invalidateInlineRun(node);

					// Also check if this changes the run head of existing runs
					const nextSibling = node.nextSibling;
					if (nextSibling && this.#isInlineLevel(nextSibling)) {
						this.#invalidateInlineRun(nextSibling);
					}

					const prevSibling = node.previousSibling;
					if (prevSibling && this.#isInlineLevel(prevSibling)) {
						this.#invalidateInlineRun(prevSibling);
					}
				} else {
					// Block element added - might split inline runs
					const nextSibling = node.nextSibling;
					if (nextSibling && this.#isInlineLevel(nextSibling)) {
						this.#invalidateInlineRun(nextSibling);
					}

					const prevSibling = node.previousSibling;
					if (prevSibling && this.#isInlineLevel(prevSibling)) {
						this.#invalidateInlineRun(prevSibling);
					}
				}
			}

			// Handle removed nodes
			for (let j = 0; j < record.removedNodes.length; j++) {
				const node = record.removedNodes[j];
				const yogaNode = this.nodeMap.get(node);

				// Invalidate inline runs before removing the node
				if (this.#isInlineLevel(node)) {
					// Check siblings that might now become the new run head
					const parent = record.target as Element;
					const siblings = Array.from(parent.childNodes);
					const nodeIndex =
						record.removedNodes.length > 1
							? -1
							: siblings.findIndex((n) => n === node);

					// Find adjacent inline siblings that need invalidation
					if (nodeIndex >= 0) {
						const nextSibling = siblings[nodeIndex + 1];
						if (nextSibling && this.#isInlineLevel(nextSibling)) {
							this.#invalidateInlineRun(nextSibling);
						}

						const prevSibling = siblings[nodeIndex - 1];
						if (prevSibling && this.#isInlineLevel(prevSibling)) {
							this.#invalidateInlineRun(prevSibling);
						}
					} else {
						// If we can't determine position, invalidate all inline siblings
						for (const sibling of siblings) {
							if (sibling !== node && this.#isInlineLevel(sibling)) {
								this.#invalidateInlineRun(sibling);
							}
						}
					}
				} else {
					// Block element removed - might merge previously separate inline runs
					const parent = record.target as Element;
					const siblings = Array.from(parent.childNodes);

					// Process all inline siblings to handle run merging
					for (const sibling of siblings) {
						if (this.#isInlineLevel(sibling)) {
							this.#invalidateInlineRun(sibling);
						}
					}
				}

				// Remove from Yoga layout
				if (yogaNode) {
					const parent = this.nodeMap.get(record.target as Element);
					if (parent) {
						parent.removeChild(yogaNode);
					}

					// Check if node was actually removed vs just moved
					if (!node.isConnected) {
						// Node was truly removed from DOM - free it
						const pseudoMeta = getPseudoMetadata(node);
						if (pseudoMeta) {
							// Removing pseudo element from nodeMap during mutation removal
						}
						yogaNode.freeRecursive();
						this.nodeMap.delete(node);
					}
					// If node.isConnected is true, node was moved - keep Yoga node and nodeMap entry
					// It will be re-added to the new parent when that mutation is processed
				}

				// Clear any cached break results for this node
				this.#clearBreakResultCache(node);
			}
		}
	}

	#addNode(node: Node, parentYogaNode: YogaTypes.Node | null = null): void {
		if (this.nodeMap.has(node)) {
			// Node already exists - this might be a moved node that needs reparenting
			const existingYogaNode = this.nodeMap.get(node);
			if (existingYogaNode && parentYogaNode) {
				// Check if it's already a child of the correct parent
				const currentParent = existingYogaNode.getParent();
				if (currentParent !== parentYogaNode) {
					// Remove from current parent first (if any)
					if (currentParent) {
						currentParent.removeChild(existingYogaNode);
					}
					// Add to new parent
					const yogaIndex = this.#getYogaIndex(node as Element);
					parentYogaNode.insertChild(existingYogaNode, yogaIndex);
				}
			}
			return;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			this.#addElementNode(node as Element, parentYogaNode);
		} else if (node.nodeType === node.TEXT_NODE) {
			this.#addTextNode(node as Text, parentYogaNode);
		}
	}

	#addElementNode(
		element: Element,
		parentYogaNode: YogaTypes.Node | null = null,
	): void {
		const yogaIndex = this.#getYogaIndex(element);
		const display = getPropertyValue(element, "display");

		// For inline elements, we need to find or create the run head
		if (display === "inline" || display === "inline-block") {
			const runHead = this.findInlineRunHead(element);
			if (runHead && runHead !== element) {
				// This element is part of an existing run - the run head will handle it
				// Clear any cached results for the run head to force re-measurement
				this.#clearBreakResultCache(runHead);
				const runHeadYogaNode = this.nodeMap.get(runHead);
				if (runHeadYogaNode) {
					runHeadYogaNode.markDirty();
				}
				return;
			}
			// If runHead === element, this is the run head - proceed to create Yoga node
		}

		let yogaNode = this.nodeMap.get(element);
		if (!yogaNode) {
			yogaNode = Yoga.Node.createWithConfig(yogaConfig);
			this.nodeMap.set(element, yogaNode);
		}

		styleYogaNode(element, yogaNode);

		if (display === "none") {
			yogaNode.setDisplay(Yoga.DISPLAY_NONE);
			if (yogaNode && parentYogaNode) {
				parentYogaNode.insertChild(yogaNode, yogaIndex);
			}
			return;
		} else if (display === "inline" || display === "inline-block") {
			yogaNode.setMeasureFunc((width, widthMode, height, heightMode) => {
				return this.#measureInlineRun(
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

		// Inline-block elements cannot have children in the Yoga tree because they use measure functions
		if (display === "inline-block") {
			return;
		}

		// Use ExpandedTreeWalker to traverse children including pseudo-elements
		const walker = createExpandedTreeWalker(
			this.window,
			element,
			this.window.NodeFilter.SHOW_ELEMENT |
				this.window.NodeFilter.SHOW_TEXT |
				NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
			null,
		);

		// Start with first child (skip the element itself)
		let child = walker.firstChild();
		while (child) {
			if (child.nodeType === child.ELEMENT_NODE) {
				const childDisplay = getPropertyValue(child as Element, "display");
				if (childDisplay === "inline" || childDisplay === "inline-block") {
					if (display === "flex") {
						this.#addNode(child, yogaNode);
					} else {
						this.#addNode(child, yogaNode);
					}
				} else {
					this.#addNode(child, yogaNode);
				}
			} else if (child.nodeType === child.TEXT_NODE) {
				// Text nodes need to be added to the layout tree
				this.#addNode(child, yogaNode);
			}
			child = walker.nextSibling();
		}

		if (yogaNode && parentYogaNode) {
			parentYogaNode.insertChild(yogaNode, yogaIndex);
		}
	}

	#addTextNode(text: Text, parentYogaNode: YogaTypes.Node | null = null): void {
		if (!parentYogaNode) {
			return;
		}

		// For text nodes, find the inline run head
		const runHead = this.findInlineRunHead(text);
		if (runHead && runHead !== text) {
			// This text node is part of an existing run - the run head will handle it
			// Clear any cached results for the run head to force re-measurement
			this.#clearBreakResultCache(runHead);
			const runHeadYogaNode = this.nodeMap.get(runHead);
			if (runHeadYogaNode) {
				runHeadYogaNode.markDirty();
			}
			return;
		}

		// This text node is the run head - create a Yoga node for it
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
				return this.#measureInlineRun(
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

	#getYogaIndex(element: Element): number {
		if (!element.parentElement) {
			return 0;
		}

		// Use the same expanded tree walker as addElementNode to ensure consistency
		const walker = createExpandedTreeWalker(
			this.window,
			element.parentElement,
			this.window.NodeFilter.SHOW_ELEMENT |
				this.window.NodeFilter.SHOW_TEXT |
				NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
			null,
		);

		let yogaIndex = 0;
		let sibling = walker.firstChild();

		while (sibling && sibling !== element) {
			if (sibling.nodeType === sibling.ELEMENT_NODE) {
				const siblingElement = sibling as Element;
				const siblingDisplay = getPropertyValue(siblingElement, "display");

				if (
					(siblingDisplay === "inline" || siblingDisplay === "inline-block") &&
					!this.isInlineRunHead(siblingElement)
				) {
					// Skip inline elements that aren't run heads
				} else {
					const siblingYogaNode = this.nodeMap.get(siblingElement);
					if (siblingYogaNode) {
						yogaIndex++;
					}
				}
			} else if (sibling.nodeType === sibling.TEXT_NODE) {
				// Count text nodes that will be added to Yoga tree
				const siblingYogaNode = this.nodeMap.get(sibling);
				if (siblingYogaNode) {
					yogaIndex++;
				}
			}
			// Note: Pseudo-elements will also be counted if they have Yoga nodes

			sibling = walker.nextSibling();
		}

		return yogaIndex;
	}

	#measureInlineRun(
		node: Node,
		width: number,
		widthMode: YogaTypes.MeasureMode,
		height: number,
		heightMode: YogaTypes.MeasureMode,
	): {width: number; height: number} {
		const breakResult = this.#breakNodes(
			node,
			width,
			widthMode,
			height,
			heightMode,
		);

		// Store the BreakResult for later use by getRects()
		this.breakResultMap.set(node, breakResult);

		const result = {
			width: breakResult.maxLineWidth,
			height: breakResult.totalHeight,
		};

		return result;
	}

	// Inline layout methods (moved from breaker.ts)
	// TODO: Many of these methods could be regular functions
	#collectLeafNodes(runHead: Node): Leaf[] {
		const leafNodes: Leaf[] = [];

		// For pseudo elements, use the host element as the parent
		const pseudoMetadata = getPseudoMetadata(runHead);
		const parentElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: runHead.parentElement;

		// Inline run heads should always have a parent element
		if (!parentElement) {
			throw new Error("Inline run head must have a parent element");
		}

		// Determine the appropriate traversal root based on parent display type
		const parentDisplay = getPropertyValue(parentElement, "display");

		let traversalRoot: Node;
		if (parentDisplay === "flex" && runHead.nodeType === runHead.ELEMENT_NODE) {
			// For flex items that are elements, traverse only within that element
			traversalRoot = runHead;
		} else {
			// For all other cases, use the parent as the boundary
			traversalRoot = parentElement;
		}

		// Use ExpandedTreeWalker for traversal
		const walker = createExpandedTreeWalker(
			this.window,
			traversalRoot,
			this.window.NodeFilter.SHOW_ELEMENT |
				this.window.NodeFilter.SHOW_TEXT |
				NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
			null,
		);

		walker.currentNode = runHead;
		while (walker.currentNode) {
			const node = walker.currentNode;

			if (node.nodeType === node.TEXT_NODE) {
				// Text node - add as leaf
				const textNode = node as Text;

				if (textNode.textContent) {
					// Check if this is a whitespace-only text node between block elements
					const isWhitespaceOnly = /^\s*$/.test(textNode.textContent);

					if (
						isWhitespaceOnly &&
						this.#shouldCollapseWhitespaceTextNode(textNode)
					) {
						// Skip this whitespace text node - it should be collapsed to nothing
						if (!walker.nextNode()) break;
						continue;
					}

					leafNodes.push({
						type: "text",
						node: textNode,
						content: textNode.textContent,
					});
				}
				// Continue with normal traversal
				if (!walker.nextNode()) break;
			} else if (node.nodeType === node.ELEMENT_NODE) {
				const element = node as Element;
				const display = getPropertyValue(element, "display");

				if (element.tagName === "BR") {
					leafNodes.push({
						type: "br",
						node: element as HTMLBRElement,
					});
					// Continue with normal traversal
					if (!walker.nextNode()) break;
				} else if (display === "inline-block") {
					// Parse CSS box model properties
					const boxModel = getBoxModel(element);

					// Calculate available content dimensions
					const horizontalBoxSpace =
						boxModel.paddingLeft +
						boxModel.paddingRight +
						boxModel.borderLeftWidth +
						boxModel.borderRightWidth;
					const verticalBoxSpace =
						boxModel.paddingTop +
						boxModel.paddingBottom +
						boxModel.borderTopWidth +
						boxModel.borderBottomWidth;

					// Determine content constraints
					let contentWidth = Number.MAX_SAFE_INTEGER;
					let contentHeight = Number.MAX_SAFE_INTEGER;
					let contentWidthMode = Yoga.MEASURE_MODE_UNDEFINED;
					let contentHeightMode = Yoga.MEASURE_MODE_UNDEFINED;

					if (boxModel.width !== undefined) {
						contentWidth = Math.max(0, boxModel.width - horizontalBoxSpace);
						contentWidthMode = Yoga.MEASURE_MODE_EXACTLY;
					}

					if (boxModel.height !== undefined) {
						contentHeight = Math.max(0, boxModel.height - verticalBoxSpace);
						contentHeightMode = Yoga.MEASURE_MODE_EXACTLY;
					}

					// Recursively measure inline-block content with constraints
					let inlineBlockResult: BreakResult | undefined;
					if (element.firstChild) {
						inlineBlockResult = this.#breakNodes(
							element.firstChild,
							contentWidth,
							contentWidthMode,
							contentHeight,
							contentHeightMode,
						);
					}

					// Calculate final content dimensions
					let finalContentWidth = inlineBlockResult?.maxLineWidth ?? 0;
					let finalContentHeight = inlineBlockResult?.totalHeight ?? 0;

					// If explicit dimensions were set, use those instead of measured content
					if (boxModel.width !== undefined) {
						finalContentWidth = Math.max(
							0,
							boxModel.width - horizontalBoxSpace,
						);
					}
					if (boxModel.height !== undefined) {
						finalContentHeight = Math.max(
							0,
							boxModel.height - verticalBoxSpace,
						);
					}

					leafNodes.push({
						type: "inline-block",
						node: element,
						breakResult: inlineBlockResult,
						boxModel,
						contentWidth: finalContentWidth,
						contentHeight: finalContentHeight,
					});
					// Skip children by going to next sibling
					if (!walker.nextSibling()) break;
				} else if (display === "inline") {
					// Inline element - traverse into its children
					if (!walker.nextNode()) break;
				} else {
					// Block element - stop traversal
					break;
				}
			} else {
				// Unknown node type - continue
				if (!walker.nextNode()) break;
			}
		}

		return leafNodes;
	}

	#breakNodes(
		runHead: Node,
		width: number,
		widthMode: YogaTypes.MeasureMode,
		_height: number,
		_heightMode: YogaTypes.MeasureMode,
	): BreakResult {
		// Collect leaf nodes from the run head
		const leafNodes = this.#collectLeafNodes(runHead);

		// Handle empty case
		if (leafNodes.length === 0) {
			return {lines: [], totalHeight: 0, maxLineWidth: 0};
		}

		// Get CSS properties from the appropriate element
		// For pseudo elements, use the host element, otherwise use parent for text nodes
		const pseudoMetadata = getPseudoMetadata(runHead);
		const styleElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: runHead.nodeType === runHead.TEXT_NODE
				? runHead.parentElement!
				: (runHead as Element);

		// Get default CSS properties from the run head element
		const whiteSpace = getPropertyValue(styleElement, "white-space");
		const wordBreak = getPropertyValue(styleElement, "word-break");
		const overflowWrap = getPropertyValue(styleElement, "overflow-wrap");

		// Determine maxWidth based on width and widthMode
		const maxWidth =
			widthMode === Yoga.MEASURE_MODE_UNDEFINED || width === 0
				? Number.MAX_SAFE_INTEGER
				: width;

		// Process and break the content with dynamic per-element styling
		const processedContent = this.#processWhitespace(leafNodes);
		const breaks = this.#findBreakPoints(processedContent, {
			maxWidth,
			whiteSpace: whiteSpace || "normal",
			wordBreak: wordBreak || "normal",
			overflowWrap: overflowWrap || "normal",
		});
		const lines = this.#buildLines(processedContent, breaks, maxWidth);

		return {
			lines,
			totalHeight: lines.reduce((sum, line) => sum + line.height, 0),
			maxLineWidth: Math.max(...lines.map((l) => l.width), 0),
		};
	}

	#collapseWhitespace(text: string, whiteSpace: string): string {
		if (whiteSpace === "pre" || whiteSpace === "pre-wrap") {
			// Preserve all whitespace exactly as-is
			return text;
		}

		if (whiteSpace === "pre-line") {
			// Preserve newlines, collapse other whitespace to single spaces
			return text
				.split("\n")
				.map((line) => line.replace(/[ \t\r\f]+/g, " "))
				.join("\n");
		}

		// For "normal" and "nowrap": collapse all whitespace sequences to single space
		// This includes spaces, tabs, newlines, etc.
		return text.replace(/\s+/g, " ");
	}

	#processWhitespace(leafNodes: Leaf[]): ProcessedContent {
		const items: ProcessedContent["items"] = [];
		let text = "";

		for (let leafIndex = 0; leafIndex < leafNodes.length; leafIndex++) {
			const leaf = leafNodes[leafIndex];
			const start = text.length;

			if (leaf.type === "text" && leaf.content) {
				// Get the white-space property for this specific leaf's parent element
				const leafWhiteSpace = leaf.node.parentElement
					? getPropertyValue(leaf.node.parentElement, "white-space")
					: "normal";

				// Process the text content according to its white-space property
				let processed = this.#collapseWhitespace(leaf.content, leafWhiteSpace);

				// Handle boundary whitespace between adjacent text nodes
				if (leafIndex > 0 && processed.length > 0) {
					const prevItem = items[items.length - 1];
					if (prevItem && prevItem.leafNode.type === "text") {
						// Check if we have adjacent spaces at the boundary
						const prevEndsWithSpace =
							text.length > 0 && text[text.length - 1] === " ";
						const thisStartsWithSpace = processed[0] === " ";

						if (prevEndsWithSpace && thisStartsWithSpace) {
							// Remove the leading space to avoid double spaces at boundaries
							processed = processed.substring(1);
						}
					}
				}

				text += processed;

				items.push({
					leafNode: leaf,
					start: start,
					end: text.length,
					processedContent: processed,
				});
			} else if (leaf.type === "br") {
				// BR elements always create a line break
				text += "\n";
				items.push({
					leafNode: leaf,
					start,
					end: text.length,
				});
			} else if (leaf.type === "inline-block") {
				// Inline-block elements are treated as a single unit
				// Add a placeholder character for measurement
				text += "\uFFFC"; // Object replacement character
				items.push({
					leafNode: leaf,
					start,
					end: text.length,
				});
			}
		}

		// Final cleanup: trim leading/trailing spaces from the entire run
		// But preserve them for pre text or isolated measurement scenarios
		if (text.length > 0) {
			// Check if any leaf has pre-style whitespace that should be preserved
			const hasPreWhitespace = leafNodes.some((leaf) => {
				if (leaf.type === "text" && leaf.node.parentElement) {
					const ws = getPropertyValue(leaf.node.parentElement, "white-space");
					return ws === "pre" || ws === "pre-wrap" || ws === "pre-line";
				}
				return false;
			});

			// Only trim if we don't have pre whitespace and we have multiple leaf nodes
			// For isolated text (single leaf), preserve trailing spaces for measurement
			const shouldTrim = !hasPreWhitespace && leafNodes.length > 1;

			if (shouldTrim) {
				const trimStart = text.match(/^\s*/)?.[0].length || 0;
				const trimEnd = text.match(/\s*$/)?.[0].length || 0;

				if (trimStart > 0 || trimEnd > 0) {
					// Adjust text
					text = text.trim();

					// Adjust item positions
					for (const item of items) {
						item.start = Math.max(0, item.start - trimStart);
						item.end = Math.max(0, item.end - trimStart);
					}
				}
			}
		}

		return {items, text};
	}

	#findBreakPoints(
		content: ProcessedContent,
		options: BreakOptions,
	): BreakPoint[] {
		const {whiteSpace = "normal"} = options;

		// Check if ANY leaf node has white-space: nowrap
		const hasNowrap = content.items.some((item) => {
			if (item.leafNode.type === "text" && item.leafNode.node.parentElement) {
				const leafWhiteSpace = getPropertyValue(
					item.leafNode.node.parentElement,
					"white-space",
				);
				return leafWhiteSpace === "nowrap";
			}
			return false;
		});

		// For nowrap, only allow breaking at the very end
		if (whiteSpace === "nowrap" || hasNowrap) {
			return [
				{
					position: content.text.length,
					required: false,
				},
			];
		}

		const breaker = new LineBreaker(content.text);
		const breaks: BreakPoint[] = [];

		let lastPos = 0;
		let bk;
		while ((bk = breaker.nextBreak())) {
			let required = bk.required || false;

			const {whiteSpace = "normal"} = options;
			if (
				whiteSpace === "pre" ||
				whiteSpace === "pre-wrap" ||
				whiteSpace === "pre-line"
			) {
				const segment = content.text.slice(lastPos, bk.position);
				if (segment.includes("\n")) {
					required = true;
				}
			}

			breaks.push({
				position: bk.position,
				required,
			});
			lastPos = bk.position;
		}

		return breaks;
	}

	#buildLines(
		content: ProcessedContent,
		breaks: BreakPoint[],
		maxWidth: number,
	): LineResult[] {
		const lines: LineResult[] = [];
		let currentY = 0;
		let lineStart = 0;

		while (lineStart < content.text.length) {
			let bestBreak = lineStart;
			let bestBreakWidth = 0;

			for (const breakPoint of breaks) {
				if (breakPoint.position <= lineStart) continue;

				const width = this.#measureText(
					content.text,
					content.items,
					lineStart,
					breakPoint.position,
				);

				// For nowrap (single break point at end), always use it regardless of width
				if (
					breaks.length === 1 &&
					breakPoint.position === content.text.length
				) {
					bestBreak = breakPoint.position;
					bestBreakWidth = width;
					break;
				}

				if (width <= maxWidth) {
					bestBreak = breakPoint.position;
					bestBreakWidth = width;
				} else {
					break;
				}

				if (breakPoint.required) {
					bestBreak = breakPoint.position;
					bestBreakWidth = width;
					break;
				}
			}

			if (bestBreak === lineStart) {
				let pos = lineStart + 1;
				while (pos <= content.text.length) {
					// Check if we would break within an inline-block element
					let crossesInlineBlock = false;
					for (const item of content.items) {
						if (item.leafNode.type === "inline-block") {
							// If our position would split this inline-block, skip to its end
							if (pos > item.start && pos < item.end) {
								pos = item.end;
								crossesInlineBlock = true;
								break;
							}
						}
					}

					if (crossesInlineBlock) {
						continue; // Try again with the new position
					}

					const width = this.#measureText(
						content.text,
						content.items,
						lineStart,
						pos,
					);
					if (width > maxWidth && pos > lineStart + 1) {
						pos--;
						break;
					}
					pos++;
				}
				bestBreak = Math.min(pos, content.text.length);
				bestBreakWidth = this.#measureText(
					content.text,
					content.items,
					lineStart,
					bestBreak,
				);
			}

			const lineNodes = this.#getNodesInRange(
				content.items,
				lineStart,
				bestBreak,
			);

			if (lineNodes.length > 0) {
				const lineHeight = Math.max(
					...lineNodes.map((n) =>
						n.leaf.type === "inline-block"
							? n.leaf.contentHeight +
								n.leaf.boxModel.paddingTop +
								n.leaf.boxModel.paddingBottom +
								n.leaf.boxModel.borderTopWidth +
								n.leaf.boxModel.borderBottomWidth
							: 1,
					),
					1,
				);

				lines.push({
					segments: lineNodes,
					y: currentY,
					height: lineHeight,
					width: bestBreakWidth,
				});

				currentY += lineHeight;
			}

			lineStart = bestBreak;
		}

		return lines;
	}

	#measureText(
		text: string,
		items: ProcessedContent["items"],
		start: number,
		end: number,
	): number {
		let width = 0;

		for (const item of items) {
			if (item.start >= end || item.end <= start) continue;

			const itemStart = Math.max(item.start, start);
			const itemEnd = Math.min(item.end, end);

			if (item.leafNode.type === "text") {
				const portion = text.slice(itemStart, itemEnd);
				width += Bun.stringWidth(portion);
			} else if (item.leafNode.type === "inline-block") {
				// Only count inline-block width if we're measuring its full range
				if (itemStart === item.start && itemEnd === item.end) {
					const blockWidth =
						item.leafNode.contentWidth +
						item.leafNode.boxModel.paddingLeft +
						item.leafNode.boxModel.paddingRight +
						item.leafNode.boxModel.borderLeftWidth +
						item.leafNode.boxModel.borderRightWidth +
						item.leafNode.boxModel.marginLeft +
						item.leafNode.boxModel.marginRight;
					width += blockWidth;
				} else {
					// Partial inline-block measurement not supported
				}
			}
		}

		return width;
	}

	#getNodesInRange(
		items: ProcessedContent["items"],
		start: number,
		end: number,
	): LineResult["segments"] {
		const nodes: LineResult["segments"] = [];
		let x = 0;

		for (const item of items) {
			if (item.start >= end || item.end <= start) continue;

			const itemStart = Math.max(item.start, start);
			const itemEnd = Math.min(item.end, end);

			if (itemStart < itemEnd) {
				let width = 0;
				if (item.leafNode.type === "text" && item.processedContent) {
					const relativeStart = itemStart - item.start;
					const relativeEnd = itemEnd - item.start;
					const portion = item.processedContent.slice(
						relativeStart,
						relativeEnd,
					);
					width = Bun.stringWidth(portion);

					nodes.push({
						leaf: item.leafNode,
						start: relativeStart,
						end: relativeEnd,
						x,
						width,
						processedText: portion,
					});
				} else if (item.leafNode.type === "inline-block") {
					width =
						item.leafNode.contentWidth +
						item.leafNode.boxModel.paddingLeft +
						item.leafNode.boxModel.paddingRight +
						item.leafNode.boxModel.borderLeftWidth +
						item.leafNode.boxModel.borderRightWidth +
						item.leafNode.boxModel.marginLeft +
						item.leafNode.boxModel.marginRight;
					// Extract text content from the inline-block's breakResult
					let processedText = "";
					if (item.leafNode.breakResult) {
						for (const line of item.leafNode.breakResult.lines) {
							for (const segment of line.segments) {
								processedText += segment.processedText;
							}
						}
					}
					nodes.push({
						leaf: item.leafNode,
						start: 0,
						end: 0,
						x,
						width,
						processedText,
					});
				} else if (item.leafNode.type === "br") {
					nodes.push({
						leaf: item.leafNode,
						start: 0,
						end: 0,
						x,
						width: 0,
						processedText: "",
					});
				}

				x += width;
			}
		}

		return nodes;
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
