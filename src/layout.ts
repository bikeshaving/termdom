import type {DOMWindow} from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import {resolvePropertyValue} from "./styles.js";
import {breakNodes, type Leaf, type BreakResult} from "./breaker.js";

export interface TextLayout {
	rect: DOMRect;
	text: string;
}

const yogaConfig = Yoga.Config.create();
yogaConfig.setUseWebDefaults(true);
yogaConfig.setPointScaleFactor(1.0);

export class LayoutEngine {
	declare DOMRect: typeof DOMRect;
	declare rootElement: Element;
	declare observer: MutationObserver;

	declare terminalWidth: number;
	declare terminalHeight: number;

	declare nodeMap: WeakMap<Node, YogaTypes.Node>;
	declare nodeRects: WeakMap<Node, Array<DOMRect & {text?: string}>>;

	constructor(window: DOMWindow) {
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new WeakMap<Node, YogaTypes.Node>();
		this.nodeRects = new WeakMap<Node, Array<DOMRect & {text?: string}>>();
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
		const yogaNode = this.nodeMap.get(element);
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

	getRects(node: Node): DOMRect[] {
		return this.nodeRects.get(node) || [];
	}

	dispose(): void {}

	private handleMutationRecords(mutations: MutationRecord[]): void {
		let _needsLayout = false;
		for (let i = 0; i < mutations.length; i++) {
			const record = mutations[i];

			if (record.type === "attributes" && record.attributeName === "style") {
				const element = record.target as Element;
				const yogaNode = this.nodeMap.get(element);
				if (yogaNode) {
					styleYogaNode(element, yogaNode);
					_needsLayout = true;
				}
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
				_needsLayout = true;
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
					_needsLayout = true;
				}
			}
		}
	}

	private addRectToNode(node: Node, rect: DOMRect & {text?: string}): void {
		const rects = this.nodeRects.get(node) || [];
		rects.push(rect);
		this.nodeRects.set(node, rects);
	}

	private addNode(
		node: Node,
		parentYogaNode: YogaTypes.Node | null = null,
	): void {
		if (this.nodeMap.has(node)) {
			return;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			this.addElement(node as Element, parentYogaNode);
		} else if (node.nodeType === node.TEXT_NODE) {
			this.addTextNode(node as Text, parentYogaNode);
		}
	}

	private addElement(
		element: Element,
		parentYogaNode: YogaTypes.Node | null = null,
		yogaIndex: number = this.getYogaIndex(element),
	): void {
		const display = resolvePropertyValue(element, "display", false);

		if (display === "inline" || display === "inline-block") {
			if (!isInlineRunHead(element)) {
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

		for (let i = 0; i < element.childNodes.length; i++) {
			const child = element.childNodes[i];
			if (child.nodeType === child.ELEMENT_NODE) {
				const childDisplay = resolvePropertyValue(child as Element, "display");
				if (childDisplay === "inline" || childDisplay === "inline-block") {
					if (display === "flex") {
						this.addElement(child as Element, yogaNode);
					} else {
						this.addElement(child as Element, yogaNode);
					}
				} else {
					this.addElement(child as Element, yogaNode);
				}
			} else if (child.nodeType === child.TEXT_NODE) {
				// Text nodes are handled during rendering
			}
		}

		if (yogaNode && parentYogaNode) {
			try {
				parentYogaNode.insertChild(yogaNode, yogaIndex);
			} catch (err) {
				// Yoga error when inserting child - ignore
			}
		}
	}

	private addTextNode(
		text: Text,
		parentYogaNode: YogaTypes.Node | null = null,
	): void {
		if (!text.textContent || !text.textContent.trim()) {
			return;
		}

		if (!parentYogaNode) {
			return;
		}

		if (isInlineRunHead(text)) {
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
				const siblingDisplay = resolvePropertyValue(siblingElement, "display");

				if (
					(siblingDisplay === "inline" || siblingDisplay === "inline-block") &&
					!isInlineRunHead(siblingElement)
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

		for (let i = 0; i < element.childNodes.length; i++) {
			const child = element.childNodes[i];
			if (child.nodeType === child.ELEMENT_NODE) {
				this.processInlineRuns(child as Element, elementX, elementY);
			}
		}
	}

	private collectLeafNodes(element: Element): Leaf[] {
		const leafNodes: Leaf[] = [];

		const parentDisplay = element.parentElement
			? resolvePropertyValue(element.parentElement, "display")
			: null;
		const isFlexItem = parentDisplay === "flex";

		if (isInlineRunHead(element) && !isFlexItem) {
			let current: Node | null = element;
			while (current) {
				if (current.nodeType === current.ELEMENT_NODE) {
					const el = current as Element;
					const display = resolvePropertyValue(el, "display");
					if (display !== "inline" && display !== "inline-block") {
						break;
					}
				}

				this.traverseNode(current, leafNodes);

				current = current.nextSibling;
			}
		} else {
			const processedNodes = new Set<Node>();

			for (let i = 0; i < element.childNodes.length; i++) {
				const child = element.childNodes[i];

				if (processedNodes.has(child)) {
					continue;
				}

				if (isInlineRunHead(child)) {
					let current: Node | null = child;
					while (current) {
						if (current.nodeType === current.ELEMENT_NODE) {
							const el = current as Element;
							const display = resolvePropertyValue(el, "display");
							if (display !== "inline" && display !== "inline-block") {
								break;
							}
						}

						this.traverseNode(current, leafNodes);
						processedNodes.add(current);

						current = current.nextSibling;
					}
				} else {
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

		let whiteSpace = resolvePropertyValue(element, "white-space") as any;
		const wordBreak = resolvePropertyValue(element, "word-break") as any;
		const overflowWrap = resolvePropertyValue(element, "overflow-wrap") as any;

		if (
			element.parentElement &&
			resolvePropertyValue(element.parentElement, "display") === "flex"
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

		let whiteSpace = resolvePropertyValue(element, "white-space") as any;
		const wordBreak = resolvePropertyValue(element, "word-break") as any;
		const overflowWrap = resolvePropertyValue(element, "overflow-wrap") as any;

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
			this.nodeRects.delete(node);
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
				const rect = new this.DOMRect(
					startX + segment.x,
					startY + line.y,
					segment.width,
					line.height,
				) as DOMRect & {text?: string};

				if (segment.leaf.type === "text" && segment.leaf.content) {
					rect.text = segment.leaf.content.slice(segment.start, segment.end);
				}

				this.addRectToNode(segment.leaf.node, rect);

				let parent = segment.leaf.node.parentElement;
				while (parent && parent !== rootElement.parentElement) {
					const display = resolvePropertyValue(parent, "display");
					if (display === "inline" || display === "inline-block") {
						this.addRectToNode(parent, rect);
					} else {
						break;
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
		yogaNode.setDisplay(Yoga.DISPLAY_FLEX);
		yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
		yogaNode.setAlignItems(Yoga.ALIGN_STRETCH);
	}
}

export function isInlineRunHead(node: Node): boolean {
	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;
		const display = resolvePropertyValue(element, "display", false);
		if (display !== "inline" && display !== "inline-block") {
			return false;
		}

		const parentDisplay = element.parentElement
			? resolvePropertyValue(element.parentElement, "display", false)
			: "block";

		if (parentDisplay === "flex") {
			return true;
		}
	} else if (node.nodeType === node.TEXT_NODE) {
		if (node.parentElement) {
			const parentDisplay = resolvePropertyValue(
				node.parentElement,
				"display",
				false,
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
			const prevDisplay = resolvePropertyValue(
				prevSibling as Element,
				"display",
				false,
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

export function findInlineRunHead(node: Node): Node | null {
	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;
		const display = resolvePropertyValue(element, "display", false);
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
			const parentDisplay = resolvePropertyValue(
				current.parentElement,
				"display",
				false,
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
			const prevDisplay = resolvePropertyValue(prevElement, "display", false);
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

export class RectUtils {
	static computeBoundingRect(
		rects: DOMRect[] | DOMRectList,
		window: DOMWindow,
	): DOMRect {
		const rectArray: DOMRect[] = Array.from(rects) as DOMRect[];

		if (rectArray.length === 0) {
			return new window.DOMRect(0, 0, 0, 0);
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

		return new window.DOMRect(
			minLeft,
			minTop,
			maxRight - minLeft,
			maxBottom - minTop,
		);
	}

	static isPointInAnyRect(
		x: number,
		y: number,
		rects: DOMRect[] | DOMRectList,
	): boolean {
		const rectArray: DOMRect[] = Array.from(rects) as DOMRect[];
		return rectArray.some((rect) => this.isPointInRect(x, y, rect));
	}

	static isPointInRect(x: number, y: number, rect: DOMRect): boolean {
		return (
			x >= rect.x &&
			x < rect.x + rect.width &&
			y >= rect.y &&
			y < rect.y + rect.height
		);
	}

	static createDOMRectList(rects: DOMRect[]): DOMRectList {
		const rectList = rects.slice();

		(rectList as any).item = (index: number): DOMRect | null => {
			return index >= 0 && index < rectList.length ? rectList[index] : null;
		};

		return rectList as any as DOMRectList;
	}
}
