import type {DOMWindow} from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import {breakNodes, type Leaf, type BreakResult} from "./breaker.js";

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

function styleYogaNode(element: Element, yogaNode: YogaTypes.Node): void {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element must have an ownerDocument with defaultView");
	}
	const computedStyle = window.getComputedStyle(element);

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

	const minWidth = parseUnitValue(computedStyle.getPropertyValue("min-width"));
	if (typeof minWidth === "number") {
		yogaNode.setMinWidth(minWidth);
	} else if (minWidth && "percentage" in minWidth) {
		yogaNode.setMinWidthPercent(minWidth.percentage);
	} else {
		yogaNode.setMinWidth(undefined);
	}

	const minHeight = parseUnitValue(
		computedStyle.getPropertyValue("min-height"),
	);
	if (typeof minHeight === "number") {
		yogaNode.setMinHeight(minHeight);
	} else if (minHeight && "percentage" in minHeight) {
		yogaNode.setMinHeightPercent(minHeight.percentage);
	} else {
		yogaNode.setMinHeight(undefined);
	}

	const maxWidth = parseUnitValue(computedStyle.getPropertyValue("max-width"));
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

	// Flexbox properties
	if (
		element.parentElement &&
		computedStyle.getPropertyValue("display") === "block"
	) {
		yogaNode.setFlexGrow(0);
		yogaNode.setFlexShrink(0);
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

	const display = computedStyle.getPropertyValue("display");
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

/**
 * A rectangle with an associated text length, used for text layout.
 * Multiple RectLength objects may be needed for a single text node due to line wrapping.
 */
export interface RectLength {
	rect: DOMRect;
	textLength: number; // Number of UTF-16 code units in this rect
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
	declare rectLengthsMap: WeakMap<Node, RectLength[]>;

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
		this.rectLengthsMap = new WeakMap<Node, RectLength[]>();
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
			this.processInlineRuns(this.rootElement);
		}
	}

	calculateLayout() {
		const records = this.observer.takeRecords();
		this.handleMutationRecords(records);

		const rootYogaNode = this.nodeMap.get(this.rootElement);
		if (rootYogaNode) {
			rootYogaNode.calculateLayout(this.terminalWidth, this.terminalHeight);

			this.processInlineRuns(this.rootElement);
		}
	}

	getRect(element: Element): DOMRect | null {
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

		let x = 0;
		let y = 0;
		let current = element;

		while (current) {
			const currentNode = this.nodeMap.get(current);
			if (currentNode) {
				x += currentNode.getComputedLeft();
				y += currentNode.getComputedTop();
			}

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

	getRectLengths(node: Node): RectLength[] {
		let rectLengths = this.rectLengthsMap.get(node);

		// If this is a cloned node and we don't have layout data for it,
		// try to use the original node's layout data
		if (!rectLengths && this.getOriginalNode) {
			const originalNode = this.getOriginalNode(node);
			if (originalNode) {
				rectLengths = this.rectLengthsMap.get(originalNode);
			}
		}

		return rectLengths || [];
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

	dispose(): void {}

	/**
	 * Get computed style for an element using our terminal-specific getComputedStyle
	 */
	private getComputedStyle(element: Element): CSSStyleDeclaration {
		return this.window.getComputedStyle(element);
	}

	/**
	 * Get a specific CSS property value from computed styles
	 */
	private getPropertyValue(element: Element, property: string): string {
		return this.getComputedStyle(element).getPropertyValue(property);
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

	private addRectLength(node: Node, rectLength: RectLength): void {
		const rectLengths = this.rectLengthsMap.get(node) || [];
		rectLengths.push(rectLength);
		this.rectLengthsMap.set(node, rectLengths);
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
		const display = this.getPropertyValue(element, "display");
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
				const childDisplay = this.getPropertyValue(child as Element, "display");
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
		// TODO: WTF CLAUDE???
		if (!text.textContent || !text.textContent.trim()) {
			return;
		}

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
					widthMode: YogaTypes.MeasureMode,
					width: number,
					heightMode: YogaTypes.MeasureMode,
					height: number,
				) => {
					return this.measureInlineRun(
						text.parentElement!,
						widthMode,
						width,
						heightMode,
						height,
					);
				},
			);

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
				const siblingDisplay = this.getPropertyValue(siblingElement, "display");

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

	private processInlineRuns(
		element: Element,
		parentX: number = 0,
		parentY: number = 0,
	): void {
		const yogaNode = this.nodeMap.get(element);
		let elementX = parentX;
		let elementY = parentY;

		if (yogaNode) {
			elementX = parentX + yogaNode.getComputedLeft();
			elementY = parentY + yogaNode.getComputedTop();
		}

		const display = this.getPropertyValue(element, "display");
		if (
			(display === "inline" || display === "inline-block") &&
			this.isInlineRunHead(element)
		) {
			if (yogaNode) {
				// Calculate content box coordinates and width for text positioning
				const borderLeft = yogaNode.getComputedBorder(Yoga.EDGE_LEFT);
				const borderTop = yogaNode.getComputedBorder(Yoga.EDGE_TOP);
				const borderRight = yogaNode.getComputedBorder(Yoga.EDGE_RIGHT);
				const paddingLeft = yogaNode.getComputedPadding(Yoga.EDGE_LEFT);
				const paddingTop = yogaNode.getComputedPadding(Yoga.EDGE_TOP);
				const paddingRight = yogaNode.getComputedPadding(Yoga.EDGE_RIGHT);

				const contentX = elementX + borderLeft + paddingLeft;
				const contentY = elementY + borderTop + paddingTop;
				const contentWidth =
					yogaNode.getComputedWidth() -
					borderLeft -
					borderRight -
					paddingLeft -
					paddingRight;

				this.layoutInlineRun(element, contentX, contentY, contentWidth);
			}
		} else if (display === "block" || display === "flex") {
			let hasInlineContent = false;
			const elementChildNodes = this.getChildrenForLayout(element);
			for (const child of elementChildNodes) {
				if (child.nodeType === child.TEXT_NODE && child.textContent?.trim()) {
					hasInlineContent = true;
					break;
				} else if (child.nodeType === child.ELEMENT_NODE) {
					const childDisplay = this.getPropertyValue(
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
				// Calculate content box coordinates and width for text positioning
				const borderLeft = yogaNode.getComputedBorder(Yoga.EDGE_LEFT);
				const borderTop = yogaNode.getComputedBorder(Yoga.EDGE_TOP);
				const borderRight = yogaNode.getComputedBorder(Yoga.EDGE_RIGHT);
				const paddingLeft = yogaNode.getComputedPadding(Yoga.EDGE_LEFT);
				const paddingTop = yogaNode.getComputedPadding(Yoga.EDGE_TOP);
				const paddingRight = yogaNode.getComputedPadding(Yoga.EDGE_RIGHT);

				const contentX = elementX + borderLeft + paddingLeft;
				const contentY = elementY + borderTop + paddingTop;
				const contentWidth =
					yogaNode.getComputedWidth() -
					borderLeft -
					borderRight -
					paddingLeft -
					paddingRight;

				this.layoutInlineRun(element, contentX, contentY, contentWidth);
			}
		}

		const inlineProcessChildNodes = this.getChildrenForLayout(element);
		for (let i = 0; i < inlineProcessChildNodes.length; i++) {
			const child = inlineProcessChildNodes[i];
			if (child.nodeType === child.ELEMENT_NODE) {
				this.processInlineRuns(child as Element, elementX, elementY);
			}
		}
	}

	private collectLeafNodes(element: Element): Leaf[] {
		const leafNodes: Leaf[] = [];

		const parentDisplay = element.parentElement
			? this.getPropertyValue(element.parentElement, "display")
			: null;
		const isFlexItem = parentDisplay === "flex";

		if (this.isInlineRunHead(element) && !isFlexItem) {
			let current: Node | null = element;
			while (current) {
				if (current.nodeType === current.ELEMENT_NODE) {
					const el = current as Element;
					const display = this.getPropertyValue(el, "display");
					if (display !== "inline" && display !== "inline-block") {
						break;
					}
				}

				this.traverseNode(current, leafNodes);

				current = current.nextSibling;
			}
		} else {
			const processedNodes = new Set<Node>();
			const collectChildNodes = this.getChildrenForLayout(element);

			for (let i = 0; i < collectChildNodes.length; i++) {
				const child = collectChildNodes[i];

				if (processedNodes.has(child)) {
					continue;
				}

				if (this.isInlineRunHead(child)) {
					let current: Node | null = child;
					while (current) {
						if (current.nodeType === current.ELEMENT_NODE) {
							const el = current as Element;
							const display = this.getPropertyValue(el, "display");
							if (display !== "inline" && display !== "inline-block") {
								break;
							}
						}

						this.traverseNode(current, leafNodes);
						processedNodes.add(current);

						current = current.nextSibling;
					}
				} else {
					// Don't traverse into block elements during inline processing
					if (child.nodeType === child.ELEMENT_NODE) {
						const el = child as Element;
						const display = this.getPropertyValue(el, "display");
						if (display !== "inline" && display !== "inline-block") {
							continue; // Skip block elements
						}
					}
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
				const display = this.getPropertyValue(el, "display");

				if (display === "inline-block") {
					const size = this.measureInlineBlock(el);
					leafNodes.push({
						type: "inline-block",
						node: el,
						width: size.width,
						height: size.height,
					});
				} else if (display === "inline") {
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

		traverse(node);
	}

	private measureInlineBlock(element: Element): {
		width: number;
		height: number;
	} {
		const textContent = element.textContent || "";
		return {
			width: Bun.stringWidth(textContent),
			height: 1,
		};
	}

	private measureInlineRun(
		element: Element,
		width: number,
		widthMode: YogaTypes.MeasureMode,
		_height: number,
		_heightMode: YogaTypes.MeasureMode,
	): {width: number; height: number} {
		const maxWidth =
			widthMode === Yoga.MEASURE_MODE_UNDEFINED || width === 0
				? Number.MAX_SAFE_INTEGER
				: width;
		const leafNodes = this.collectLeafNodes(element);

		let whiteSpace = this.getPropertyValue(element, "white-space") as any;
		const wordBreak = this.getPropertyValue(element, "word-break") as any;
		const overflowWrap = this.getPropertyValue(element, "overflow-wrap") as any;

		if (
			element.parentElement &&
			this.getPropertyValue(element.parentElement, "display") === "flex"
		) {
			if (widthMode === Yoga.MEASURE_MODE_UNDEFINED) {
				whiteSpace = "nowrap";
			}
		}

		const breakResult = breakNodes(leafNodes, {
			maxWidth,
			whiteSpace: whiteSpace || "normal",
			wordBreak: wordBreak || "normal",
			overflowWrap: overflowWrap || "normal",
		});

		const result = {
			width: breakResult.maxLineWidth,
			height: breakResult.totalHeight,
		};
		return result;
	}

	private layoutInlineRun(
		element: Element,
		x: number,
		y: number,
		maxWidth: number,
	): void {
		const leafNodes = this.collectLeafNodes(element);

		let whiteSpace = this.getPropertyValue(element, "white-space") as any;
		const wordBreak = this.getPropertyValue(element, "word-break") as any;
		const overflowWrap = this.getPropertyValue(element, "overflow-wrap") as any;

		if (
			element.parentElement &&
			this.getPropertyValue(element.parentElement, "display") === "flex"
		) {
			const flexDirection =
				this.getPropertyValue(element.parentElement, "flex-direction") || "row";
			if (flexDirection === "row" || flexDirection === "row-reverse") {
				whiteSpace = "nowrap";
			}
		}

		const breakResult = breakNodes(leafNodes, {
			maxWidth,
			whiteSpace: whiteSpace || "normal",
			wordBreak: wordBreak || "normal",
			overflowWrap: overflowWrap || "normal",
		});

		this.distributeRects(breakResult, element, x, y);
	}

	private distributeRects(
		breakResult: BreakResult,
		rootElement: Element,
		startX: number,
		startY: number,
	): void {
		const clearRects = (node: Node) => {
			this.rectLengthsMap.delete(node);
			if (node.nodeType === node.ELEMENT_NODE) {
				const el = node as Element;
				for (let i = 0; i < el.childNodes.length; i++) {
					clearRects(el.childNodes[i]);
				}
			}
		};
		clearRects(rootElement);

		for (const line of breakResult.lines) {
			for (const segment of line.segments) {
				const domRect = new this.DOMRect(
					startX + segment.x,
					startY + line.y,
					segment.width,
					line.height,
				);

				const rectLength: RectLength = {
					rect: domRect,
					textLength: segment.end - segment.start,
				};

				this.addRectLength(segment.leaf.node, rectLength);

				let parent = segment.leaf.node.parentElement;
				while (parent && parent !== rootElement.parentElement) {
					const display = this.getPropertyValue(parent, "display");
					if (display === "inline" || display === "inline-block") {
						this.addRectLength(parent, rectLength);
					} else {
						break;
					}
					parent = parent.parentElement;
				}
			}
		}
	}

	public isInlineRunHead(node: Node): boolean {
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = this.getPropertyValue(element, "display");
			if (display !== "inline" && display !== "inline-block") {
				return false;
			}

			const parentDisplay = element.parentElement
				? this.getPropertyValue(element.parentElement, "display")
				: "block";

			if (parentDisplay === "flex") {
				return true;
			}
		} else if (node.nodeType === node.TEXT_NODE) {
			if (node.parentElement) {
				const parentDisplay = this.getPropertyValue(
					node.parentElement,
					"display",
				);
				if (parentDisplay === "flex") {
					let prevSibling = node.previousSibling;
					while (prevSibling) {
						if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
							if (prevSibling.textContent) {
								return false;
							}
						} else {
							return true;
						}
						prevSibling = prevSibling.previousSibling;
					}
					return true;
				}
			}
		} else {
			return false;
		}

		let prevSibling = node.previousSibling;
		while (prevSibling) {
			if (prevSibling.nodeType === prevSibling.ELEMENT_NODE) {
				const prevDisplay = this.getPropertyValue(
					prevSibling as Element,
					"display",
				);
				if (prevDisplay === "inline" || prevDisplay === "inline-block") {
					return false;
				} else {
					return true;
				}
			} else if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
				if (prevSibling.textContent) {
					return false;
				}
			}
			prevSibling = prevSibling.previousSibling;
		}

		return true;
	}

	public findInlineRunHead(node: Node): Node | null {
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = this.getPropertyValue(element, "display");
			if (display !== "inline" && display !== "inline-block") {
				return null;
			}
		} else if (node.nodeType !== node.TEXT_NODE) {
			return null;
		}

		let startNode = node;
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;

			let current = element;
			while (current.parentElement) {
				const parentDisplay = this.getPropertyValue(
					current.parentElement,
					"display",
				);

				if (parentDisplay === "flex") {
					return current;
				}

				if (parentDisplay === "inline" || parentDisplay === "inline-block") {
					current = current.parentElement;
					startNode = current;
				} else {
					startNode = current;
					break;
				}
			}
		}

		if (node.nodeType === node.TEXT_NODE && node.parentElement) {
			const parentDisplay = this.getPropertyValue(
				node.parentElement,
				"display",
			);
			if (parentDisplay === "flex") {
				let current = node;
				while (current.previousSibling) {
					const prevSibling = current.previousSibling;
					if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
						if (prevSibling.textContent) {
							current = prevSibling;
						} else {
							// Empty text node - skip
						}
					} else {
						break;
					}
				}
				return current;
			}
		}

		let current = startNode;
		while (current.previousSibling) {
			const prevSibling = current.previousSibling;

			if (prevSibling.nodeType === prevSibling.ELEMENT_NODE) {
				const prevElement = prevSibling as Element;
				const prevDisplay = this.getPropertyValue(prevElement, "display");
				if (prevDisplay === "inline" || prevDisplay === "inline-block") {
					current = prevElement;
				} else {
					break;
				}
			} else if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
				current = prevSibling;
			} else {
				break;
			}
		}

		return current;
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
