import type {DOMWindow} from "jsdom";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";
import {resolvePropertyValue, styleYogaNode} from "./styles.js";
import {breakNodes, type Leaf, type BreakResult} from "./breaker.js";
import {createTable, getCoreRowModel} from "@tanstack/table-core";

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

interface TableInstance {
	element: Element;
	// TOOD: type this accurately
	tanstackTable: any;
	data: any[];
	columns: any[];
}

const yogaConfig = Yoga.Config.create();
yogaConfig.setUseWebDefaults(true);
yogaConfig.setPointScaleFactor(1.0);

export class LayoutEngine {
	declare DOMRect: typeof globalThis.DOMRect;
	declare rootElement: Element;
	declare observer: MutationObserver;

	// TODO:
	declare terminalWidth: number;
	declare terminalHeight: number;

	// TODO: These should be strong maps
	declare nodeMap: WeakMap<Node, YogaTypes.Node>;
	declare rectLengthsMap: WeakMap<Node, RectLength[]>;
	declare tableInstances: WeakMap<Element, TableInstance>;

	constructor(window: DOMWindow) {
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new WeakMap<Node, YogaTypes.Node>();
		this.rectLengthsMap = new WeakMap<Node, RectLength[]>();
		this.tableInstances = new WeakMap<Element, TableInstance>();
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

	getRectLengths(node: Node): RectLength[] {
		return this.rectLengthsMap.get(node) || [];
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

	getTableInstance(element: Element): TableInstance | undefined {
		return this.tableInstances.get(element);
	}

	dispose(): void {}

	private setupTableElement(
		tableElement: Element,
		parentYogaNode: YogaTypes.Node | null,
		yogaIndex: number = this.getYogaIndex(tableElement),
	): void {
		// Extract data from DOM table structure
		const tableData = this.extractTableData(tableElement);

		// Create TanStack Table instance with proper state defaults
		const tanstackTable = createTable({
			data: tableData.data,
			columns: tableData.columns,
			getCoreRowModel: getCoreRowModel(),
			state: {
				columnPinning: {left: [], right: []},
				columnOrder: [],
				sorting: [],
			},
			onStateChange: () => {},
		});

		// Store table instance for later updates
		this.tableInstances.set(tableElement, {
			element: tableElement,
			tanstackTable,
			data: tableData.data,
			columns: tableData.columns,
		});

		// Create Yoga node for the table container
		let yogaNode = this.nodeMap.get(tableElement);
		if (!yogaNode) {
			yogaNode = Yoga.Node.createWithConfig(yogaConfig);
			this.nodeMap.set(tableElement, yogaNode);
		}

		// Style the table container
		styleYogaNode(tableElement, yogaNode);

		// Set up table as flex column container
		yogaNode.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
		yogaNode.setDisplay(Yoga.DISPLAY_FLEX);

		// Add to parent
		if (parentYogaNode) {
			parentYogaNode.insertChild(yogaNode, yogaIndex);
		}

		// Set up custom measure function for table content
		yogaNode.setMeasureFunc((width, widthMode, height, heightMode) => {
			return this.measureTable(
				tableElement,
				width,
				widthMode,
				height,
				heightMode,
			);
		});
	}

	private extractTableData(tableElement: Element): {
		data: any[];
		columns: any[];
	} {
		const data: any[] = [];
		const columns: any[] = [];

		// Find headers (th elements)
		const headerCells = Array.from(tableElement.querySelectorAll("th"));
		const hasHeaders = headerCells.length > 0;

		if (hasHeaders) {
			headerCells.forEach((th, index) => {
				columns.push({
					id: `col_${index}`,
					header: th.textContent?.trim() || `Column ${index + 1}`,
					accessorKey: `col_${index}`,
				});
			});
		}

		// Extract data from tbody tr elements
		const dataRows = Array.from(tableElement.querySelectorAll("tbody tr"));

		dataRows.forEach((row) => {
			const cells = Array.from(row.querySelectorAll("td"));
			const rowData: any = {};

			cells.forEach((cell, index) => {
				rowData[`col_${index}`] = cell.textContent?.trim() || "";
			});

			if (Object.keys(rowData).length > 0) {
				data.push(rowData);
			}
		});

		// Generate columns if no headers found
		if (!hasHeaders && data.length > 0) {
			Object.keys(data[0]).forEach((key, index) => {
				columns.push({
					id: key,
					header: `Column ${index + 1}`,
					accessorKey: key,
				});
			});
		}

		return {data, columns};
	}

	private measureTable(
		tableElement: Element,
		width: number,
		widthMode: YogaTypes.MeasureMode,
		height: number,
		heightMode: YogaTypes.MeasureMode,
	): {width: number; height: number} {
		const tableInstance = this.tableInstances.get(tableElement);
		if (!tableInstance) {
			// TODO: Throw if no table instance is found
			return {width: 40, height: 5};
		}

		const table = tableInstance.tanstackTable;
		const rowCount = table.getRowModel().rows.length + 1; // +1 for header
		const colCount = table.getAllColumns().length;

		// TODO: intrinsic cell sizing
		// Calculate dimensions
		const calculatedWidth = Math.max(colCount * 12, 40);
		const calculatedHeight = Math.max(rowCount, 3);

		return {
			width:
				widthMode === Yoga.MEASURE_MODE_UNDEFINED
					? calculatedWidth
					: Math.min(width, calculatedWidth),
			height:
				heightMode === Yoga.MEASURE_MODE_UNDEFINED
					? calculatedHeight
					: Math.min(height, calculatedHeight),
		};
	}

	private setupListElement(
		listElement: Element,
		parentYogaNode: YogaTypes.Node | null = null,
		yogaIndex: number = this.getYogaIndex(listElement),
	): void {
		let yogaNode = this.nodeMap.get(listElement);
		if (!yogaNode) {
			yogaNode = Yoga.Node.createWithConfig(yogaConfig);
			this.nodeMap.set(listElement, yogaNode);
		}

		// Apply normal styling first
		styleYogaNode(listElement, yogaNode);

		// Check if this is a nested list (parent is LI)
		const parentIsListItem = listElement.parentElement?.tagName === "LI";

		// Calculate marker width for this list
		const firstListItem = Array.from(listElement.children).find(
			(child) => child.tagName === "LI",
		) as Element;
		const markerWidth = firstListItem
			? this.calculateListMarkerWidth(firstListItem)
			: 2;

		if (parentIsListItem) {
			// Nested list: use margin instead of padding for positioning
			// Find the parent list item to align with its text
			const parentLI = listElement.parentElement as Element;
			const parentMarkerWidth = this.calculateListMarkerWidth(parentLI);

			yogaNode.setMargin(Yoga.EDGE_LEFT, parentMarkerWidth);
			yogaNode.setPadding(Yoga.EDGE_LEFT, markerWidth);
		} else {
			// Top-level list: use calculated marker width for padding
			yogaNode.setPadding(Yoga.EDGE_LEFT, markerWidth);
		}

		// Add to parent
		if (parentYogaNode) {
			parentYogaNode.insertChild(yogaNode, yogaIndex);
		}

		// Process children normally
		for (let i = 0; i < listElement.childNodes.length; i++) {
			const child = listElement.childNodes[i];
			if (child.nodeType === child.ELEMENT_NODE) {
				this.addElementNode(child as Element, yogaNode);
			} else if (child.nodeType === child.TEXT_NODE) {
				this.addTextNode(child as Text, yogaNode);
			}
		}
	}

	private setupListItem(
		listItem: Element,
		parentYogaNode: YogaTypes.Node | null,
		yogaIndex: number,
	): void {
		// Create Yoga node for the list item
		let yogaNode = this.nodeMap.get(listItem);
		if (!yogaNode) {
			yogaNode = Yoga.Node.createWithConfig(yogaConfig);
			this.nodeMap.set(listItem, yogaNode);
		}

		// Style the list item container
		styleYogaNode(listItem, yogaNode);

		// List items need padding for their own markers
		const markerSpace = this.calculateListMarkerWidth(listItem);
		yogaNode.setPadding(Yoga.EDGE_LEFT, markerSpace);

		// Add to parent
		if (parentYogaNode) {
			parentYogaNode.insertChild(yogaNode, yogaIndex);
		}

		// Handle mixed content: separate text nodes from block elements
		const textNodes: Node[] = [];
		const blockElements: Node[] = [];

		for (let i = 0; i < listItem.childNodes.length; i++) {
			const child = listItem.childNodes[i];
			if (child.nodeType === child.TEXT_NODE) {
				textNodes.push(child);
			} else if (child.nodeType === child.ELEMENT_NODE) {
				const display = resolvePropertyValue(child as Element, "display");
				if (display === "block") {
					blockElements.push(child);
				} else {
					textNodes.push(child); // Treat inline elements with text
				}
			}
		}

		// Process text nodes first (they'll be positioned at the top)
		for (const textNode of textNodes) {
			this.addNode(textNode, yogaNode);
		}

		// Process block elements after text with smart spacing
		for (let i = 0; i < blockElements.length; i++) {
			const blockElement = blockElements[i];
			this.addNode(blockElement, yogaNode);

			// Add spacing only if there's text content before AND this isn't the last element
			if (
				textNodes.length > 0 &&
				blockElement.nodeType === blockElement.ELEMENT_NODE
			) {
				const blockYogaNode = this.nodeMap.get(blockElement);
				if (blockYogaNode) {
					// Add top padding to separate from preceding text
					blockYogaNode.setPadding(Yoga.EDGE_TOP, 1);
				}
			}
		}
	}

	private getListNestingDepth(listItem: Element): number {
		let depth = 0;
		let current = listItem.parentElement;

		while (current) {
			if (current.tagName === "UL" || current.tagName === "OL") {
				depth++;
			}
			current = current.parentElement;
		}

		return depth - 1; // Subtract 1 because we want 0-based depth (first level = 0)
	}

	private calculateListMarkerWidth(listItem: Element): number {
		const listParent = listItem.parentElement;
		if (!listParent) return 2; // Default fallback

		const listType = listParent.tagName.toLowerCase();

		if (listType === "ul") {
			// Unordered lists use single-char markers (•, ◦, ▪) + space = 2 chars
			return 2;
		} else if (listType === "ol") {
			// For ordered lists, calculate the width of the longest marker in this list
			const items = Array.from(listParent.children).filter(
				(child) => child.tagName === "LI",
			);
			const start = parseInt(listParent.getAttribute("start") || "1", 10);
			const maxNumber = start + items.length - 1;

			const listStyleType = resolvePropertyValue(listParent, "list-style-type");
			let maxMarkerWidth = 2; // Minimum width

			// Calculate width based on list style type and max number
			switch (listStyleType) {
				case "decimal":
					maxMarkerWidth = Math.max(2, maxNumber.toString().length + 1); // +1 for the dot
					break;
				case "lower-alpha":
				case "upper-alpha": {
					// Calculate width for alphabetical markers (a., b., ... z., aa., ab., ...)
					const alphaWidth = this.getAlphaMarkerWidth(maxNumber) + 1; // +1 for dot
					maxMarkerWidth = Math.max(2, alphaWidth);
					break;
				}
				case "lower-roman":
				case "upper-roman": {
					// Calculate width for Roman numerals
					const romanWidth = this.getRomanMarkerWidth(maxNumber) + 1; // +1 for dot
					maxMarkerWidth = Math.max(2, romanWidth);
					break;
				}
				default:
					maxMarkerWidth = Math.max(2, maxNumber.toString().length + 1);
			}

			return maxMarkerWidth + 1; // +1 for spacing after marker
		}

		return 2; // Default fallback
	}

	private getAlphaMarkerWidth(number: number): number {
		// Convert number to alpha (1=a, 2=b, ..., 26=z, 27=aa, etc.)
		let result = "";
		let n = number;
		while (n > 0) {
			n--; // Make it 0-based
			result = String.fromCharCode(97 + (n % 26)) + result;
			n = Math.floor(n / 26);
		}
		return result.length;
	}

	private getRomanMarkerWidth(number: number): number {
		// Calculate Roman numeral width (rough estimation)
		const romanNumerals = [
			[1000, "m"],
			[900, "cm"],
			[500, "d"],
			[400, "cd"],
			[100, "c"],
			[90, "xc"],
			[50, "l"],
			[40, "xl"],
			[10, "x"],
			[9, "ix"],
			[5, "v"],
			[4, "iv"],
			[1, "i"],
		];

		let result = "";
		let n = number;
		for (const [value, numeral] of romanNumerals) {
			while (n >= value) {
				result += numeral;
				n -= value;
			}
		}
		return result.length;
	}

	private calculateNestingIndent(listItem: Element): number {
		// Find the first parent list item to align with
		let current = listItem.parentElement; // Start with immediate parent (should be ul/ol)

		// Walk up to find the parent list item
		while (current) {
			if (current.tagName === "LI") {
				// Found parent list item - we want to align with its marker width
				// This gives us minimal nesting that aligns with the parent's text content
				const parentMarkerWidth = this.calculateListMarkerWidth(
					current as Element,
				);
				return parentMarkerWidth;
			}
			current = current.parentElement;
		}

		return 0; // No nesting found
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
		const display = resolvePropertyValue(element, "display", false);

		// Handle table elements with TanStack Table integration
		if (display === "table") {
			this.setupTableElement(element, parentYogaNode);
			return;
		}

		// Table children handled by table layout
		if (
			display === "table-header-group" ||
			display === "table-row-group" ||
			display === "table-footer-group" ||
			display === "table-row" ||
			display === "table-cell"
		) {
			// These will be handled by the parent table's layout
			return;
		}

		// Handle list items - need special layout for marker positioning
		if (element.tagName === "LI") {
			this.setupListItem(element, parentYogaNode, yogaIndex);
			return;
		}

		// Handle ul/ol lists - nested lists use positioning instead of padding
		if (element.tagName === "UL" || element.tagName === "OL") {
			this.setupListElement(element, parentYogaNode, yogaIndex);
			return;
		}

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
					// Don't traverse into block elements during inline processing
					if (child.nodeType === child.ELEMENT_NODE) {
						const el = child as Element;
						const display = resolvePropertyValue(el, "display");
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
					const display = resolvePropertyValue(parent, "display");
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
