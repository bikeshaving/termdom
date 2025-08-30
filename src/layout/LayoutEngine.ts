import type {DOMWindow} from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import {resolvePropertyValue} from "../css.js";

// TODO: UAX #14 linebreaks
//import linebreak from "linebreak";
import {TextBreaker, type LineBreak} from "../text/TextBreaker.js";

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
	declare nodeMap: WeakMap<Node, YogaTypes.Node>;
	declare textBreaker: TextBreaker;

	constructor(window: DOMWindow) {
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new WeakMap<Node, YogaTypes.Node>();
		this.textBreaker = new TextBreaker();
		this.observer = new window.MutationObserver((mutations) => {
			this.handleMutationRecords(mutations);
		});

		this.observer.observe(this.rootElement, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});
		addNode(this.rootElement, this.nodeMap);
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
		}
	}

	calculateLayout() {
		const records = this.observer.takeRecords();
		this.handleMutationRecords(records);
	}

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
				addNode(node, this.nodeMap, parentYogaNode);
				needsLayout = true;
			}

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

		// Recalculate layout if anything changed
		if (needsLayout) {
			const rootYogaNode = this.nodeMap.get(this.rootElement);
			if (rootYogaNode) {
				rootYogaNode.calculateLayout(this.terminalWidth, this.terminalHeight);
			}
		}
	}

	getRect(element: Element): DOMRect | null {
		const yogaNode = this.nodeMap.get(element);
		if (!yogaNode) {
			return null;
		}

		return new this.DOMRect(
			yogaNode.getComputedLeft(),
			yogaNode.getComputedTop(),
			yogaNode.getComputedWidth(),
			yogaNode.getComputedHeight(),
		);
	}

	getRects(element: Element): DOMRect[] {
		throw new Error("TODO");
	}

	dispose(): void {}
}

/**
 * Parse unit from CSS string and return value or percentage info
 * Examples: "10px" → {value: 10}, "50%" → {percentage: 50}, "auto" → null
 */
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

	const height = parseUnitValue(resolvePropertyValue(element, "height", false));
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

	// min-height: <length> | <percentage> | auto | max-content | min-content | fit-content
	// Keywords: auto (default), max-content, min-content, fit-content, inherit, initial, unset
	// Support: <length>, <percentage> (Yoga defaults to 0 for auto)
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

	// margin-top: <length> | <percentage> | auto
	// Keywords: auto (for centering/distribution), inherit, initial, unset
	// Support: <length>, <percentage>, auto
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

	// margin-right: <length> | <percentage> | auto
	// Keywords: auto (for centering/distribution), inherit, initial, unset
	// Support: <length>, <percentage>, auto
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

	// margin-bottom: <length> | <percentage> | auto
	// Keywords: auto (for centering/distribution), inherit, initial, unset
	// Support: <length>, <percentage>, auto
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

	// margin-left: <length> | <percentage> | auto
	// Keywords: auto (for centering/distribution), inherit, initial, unset
	// Support: <length>, <percentage>, auto
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

	// padding-top: <length> | <percentage>
	// Keywords: inherit, initial, unset (no auto for padding)
	// Support: <length>, <percentage> (defaults to 0)
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

	// padding-right: <length> | <percentage>
	// Keywords: inherit, initial, unset (no auto for padding)
	// Support: <length>, <percentage> (defaults to 0)
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

	// padding-bottom: <length> | <percentage>
	// Keywords: inherit, initial, unset (no auto for padding)
	// Support: <length>, <percentage> (defaults to 0)
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

	// padding-left: <length> | <percentage>
	// Keywords: inherit, initial, unset (no auto for padding)
	// Support: <length>, <percentage> (defaults to 0)
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

	// Special case: block layout children shouldn't flex
	if (
		element.parentElement &&
		resolvePropertyValue(element.parentElement, "display") === "block"
	) {
		// Block children don't participate in flexbox behavior
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
				yogaNode.setAlignSelf(undefined);
			}
		}
	}

	// === FLEX CONTAINER PROPERTIES ===

	// display: none | flex | block | inline | inline-block | ...
	// Keywords: block, flex, none, inline, inline-block, inherit, initial, unset
	// Support: flex, block, none (others treated as block)
	const display = resolvePropertyValue(element, "display");

	if (display === "none") {
		yogaNode.setDisplay(Yoga.DISPLAY_NONE);
	} else if (display === "flex") {
		yogaNode.setDisplay(Yoga.DISPLAY_FLEX);

		// flex-direction: row | row-reverse | column | column-reverse
		// Keywords: row (default), row-reverse, column, column-reverse, inherit, initial, unset
		// Support: all standard values
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

		// flex-wrap: nowrap | wrap | wrap-reverse
		// Keywords: nowrap (default), wrap, wrap-reverse, inherit, initial, unset
		// Support: all standard values
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

		// justify-content: flex-start | flex-end | center | space-between | space-around | space-evenly
		// Keywords: flex-start (default), flex-end, center, space-between, space-around, space-evenly, inherit, initial, unset
		// Support: all standard values
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

		// align-items: stretch | flex-start | flex-end | center | baseline
		// Keywords: stretch (default), flex-start, flex-end, center, baseline, inherit, initial, unset
		// Support: all standard values
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

		// align-content: stretch | flex-start | flex-end | center | space-between | space-around
		// Keywords: stretch (default), flex-start, flex-end, center, space-between, space-around, inherit, initial, unset
		// Support: all standard values (for multi-line flex containers)
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
		// Simulate block layout using flexbox
		yogaNode.setDisplay(Yoga.DISPLAY_FLEX);
		yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
		yogaNode.setAlignItems(Yoga.ALIGN_STRETCH);
	}
}

function isBlockLevelDisplay(display: string): boolean {
	// TODO: there are more block-level displays
	return (
		display === "block" ||
		display === "flex" ||
		display === "inline-block" ||
		display === "none"
	);
}

function addNode(
	node: Node,
	map: WeakMap<Node, YogaTypes.Node>,
	parentYogaNode: YogaTypes.Node | null = null,
): void {
	if (node.nodeType === node.ELEMENT_NODE) {
		addElement(node as Element, map, parentYogaNode);
	} else if (node.nodeType === node.TEXT_NODE) {
		addTextNode(node as Text, map, parentYogaNode);
	}
}

function addElement(
	element: Element,
	map: WeakMap<Node, YogaTypes.Node>,
	parentYogaNode: YogaTypes.Node | null = null,
	yogaIndex: number = getYogaIndex(element, map),
): void {
	const display = resolvePropertyValue(element, "display", false);

	// Check if this inline element should join an existing inline run
	if (display === "inline" || display === "inline-block") {
		if (element.parentElement === null) {
			throw new Error("inline/inline-block element with no parent");
		}

		const parentDisplay = resolvePropertyValue(
			element.parentElement,
			"display",
			false,
		);

		// Return early (join existing inline run) if:
		// - parent is block AND has previous sibling that's inline content
		if (
			parentDisplay !== "flex" &&
			element.previousSibling !== null &&
			(element.previousSibling.nodeType === element.TEXT_NODE ||
				(element.previousSibling.nodeType === element.ELEMENT_NODE &&
					(resolvePropertyValue(
						element.previousSibling as Element,
						"display",
						false,
					) === "inline" ||
						resolvePropertyValue(
							element.previousSibling as Element,
							"display",
							false,
						) === "inline-block")))
		) {
			console.log(`${element.tagName} joining existing inline run`);
			return; // Join existing inline run
		}
	}

	let yogaNode = map.get(element);
	if (!yogaNode) {
		yogaNode = Yoga.Node.createWithConfig(yogaConfig);
		map.set(element, yogaNode);
	}

	// Apply CSS properties including display
	styleYogaNode(element, yogaNode);

	// Skip processing children if display: none, but keep the node in tree
	if (display === "none") {
		yogaNode.setDisplay(Yoga.DISPLAY_NONE);
		// Early return - don't process children
		if (yogaNode && parentYogaNode) {
			parentYogaNode.insertChild(yogaNode, yogaIndex);
		}
	} else if (display === "inline" || display === "inline-block") {
		// TODO: if it's an inline element, we need to traverse to previous siblings to find the head node or create one if it doesn't exist
		if (yogaNode && parentYogaNode) {
			parentYogaNode.insertChild(yogaNode, yogaIndex);
		}

		return;
	}

	let inlineRunNode: YogaTypes.Node | null = null;
	for (let i = 0; i < element.childNodes.length; i++) {
		const child = element.childNodes[i];
		if (child.nodeType === child.ELEMENT_NODE) {
			const childDisplay = resolvePropertyValue(child as Element, "display");
			if (childDisplay === "inline" || childDisplay === "inline-block") {
				if (display === "flex") {
					// each child of a flex node is flexed
					console.log(
						`  SKIPPING inline child ${(child as Element).tagName} in flex container`,
					);
				} else if (inlineRunNode) {
					// The inline run node is handling this
					console.log(
						`  SKIPPING inline child ${(child as Element).tagName} - inline run handling`,
					);
				} else {
					addElement(child as Element, map, yogaNode);
				}
			} else {
				if (inlineRunNode) {
					inlineRunNode = null;
				}

				addElement(child as Element, map, yogaNode);
			}
		} else if (child.nodeType === child.TEXT_NODE) {
			if (inlineRunNode) {
				console.log(`  SKIPPING text node - inline run handling`);
				continue;
			}

			console.log(`  SKIPPING text node - addTextNode unimplemented`);
			// addTextNode(child as Text, map, yogaNode);
		}
	}

	if (yogaNode && parentYogaNode && yogaNode.getParent() === null) {
		try {
			console.log(
				`Inserting ${element.tagName} at index ${yogaIndex}, parent has ${parentYogaNode.getChildCount()} children`,
			);
			parentYogaNode.insertChild(yogaNode, yogaIndex);
		} catch (err) {
			console.log(
				"Error:",
				element.tagName,
				`yogaIndex: ${yogaIndex}`,
				`parent children: ${parentYogaNode.getChildCount()}`,
				err.message,
			);
		}
	}
}

function addTextNode(
	text: Text,
	map: WeakMap<Node, YogaTypes.Node>,
	parentNode: YogaTypes.Node | null = null,
): void {
	// TODO:
}

/**
 * Check if an element is the head of an inline run (first inline element in sequence)
 */
function isInlineRunHead(element: Element): boolean {
	const display = resolvePropertyValue(element, "display", false);
	if (display !== "inline" && display !== "inline-block") {
		return false;
	}

	const parentDisplay = element.parentElement
		? resolvePropertyValue(element.parentElement, "display", false)
		: "block";

	// In flex containers, all inline elements are heads (flex items)
	if (parentDisplay === "flex") {
		return true;
	}

	// In block containers, check if there's any previous inline content
	let prevSibling = element.previousSibling;
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
			if (prevSibling.textContent?.trim()) {
				return false; // Not head - previous text content exists
			}
			// Skip whitespace text nodes
		}
		prevSibling = prevSibling.previousSibling;
	}

	return true; // Head - no previous inline content
}

/**
 * Find the head element of an inline run that contains the given element
 */
function findInlineRunHead(element: Element): Element | null {
	const display = resolvePropertyValue(element, "display", false);
	if (display !== "inline" && display !== "inline-block") {
		return null; // Not an inline element
	}

	const parentDisplay = element.parentElement
		? resolvePropertyValue(element.parentElement, "display", false)
		: "block";

	// In flex containers, each inline element is its own head
	if (parentDisplay === "flex") {
		return element;
	}

	// In block containers, traverse backwards to find the head
	let current = element;
	while (current.previousSibling) {
		const prevSibling = current.previousSibling;

		if (prevSibling.nodeType === prevSibling.ELEMENT_NODE) {
			const prevDisplay = resolvePropertyValue(
				prevSibling as Element,
				"display",
				false,
			);
			if (prevDisplay === "inline" || prevDisplay === "inline-block") {
				current = prevSibling as Element; // Continue backwards
			} else {
				break; // Block element - current is the head
			}
		} else if (prevSibling.nodeType === prevSibling.TEXT_NODE) {
			if (prevSibling.textContent?.trim()) {
				// Text content - need to keep looking for the element head
				current = current; // Stay at current element
			}
			// Skip whitespace and continue backwards
		}

		// Move to previous sibling (handled by the while condition)
	}

	return current;
}

function getYogaIndex(node: Node, map: WeakMap<Node, YogaTypes.Node>): number {
	console.log("getYogaIndex called", (node as any).outerHTML);
	if (!node.parentNode) return 0;

	const parent = node.parentNode;
	const parentYogaNode = map.get(parent);
	if (!parentYogaNode) return 0;

	// Count how many previous siblings have Yoga nodes
	let yogaIndex = 0;
	for (
		let sibling = parent.firstChild;
		sibling && sibling !== node;
		sibling = sibling.nextSibling
	) {
		if (map.has(sibling)) {
			yogaIndex++;
		}
	}

	// Ensure index doesn't exceed parent's child count
	return yogaIndex;
}
