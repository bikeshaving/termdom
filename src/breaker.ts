import LineBreaker from "linebreak";
import {getPropertyValue, parseUnitValue} from "./styles.js";
import Yoga from "yoga-layout";
import type * as YogaTypes from "yoga-layout";

interface InlineBlockBoxModel {
	width?: number;
	height?: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
	borderTopWidth: number;
	borderRightWidth: number;
	borderBottomWidth: number;
	borderLeftWidth: number;
}

function getInlineBlockBoxModel(element: Element): InlineBlockBoxModel {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element does not have an associated window");
	}
	const computedStyle = window.getComputedStyle(element);

	// Parse explicit width/height
	const widthValue = parseUnitValue(computedStyle.getPropertyValue("width"));
	const heightValue = parseUnitValue(computedStyle.getPropertyValue("height"));

	// Parse padding
	const paddingTop = parseUnitValue(
		computedStyle.getPropertyValue("padding-top"),
	);
	const paddingRight = parseUnitValue(
		computedStyle.getPropertyValue("padding-right"),
	);
	const paddingBottom = parseUnitValue(
		computedStyle.getPropertyValue("padding-bottom"),
	);
	const paddingLeft = parseUnitValue(
		computedStyle.getPropertyValue("padding-left"),
	);

	// Parse margin
	const marginTop = parseUnitValue(
		computedStyle.getPropertyValue("margin-top"),
	);
	const marginRight = parseUnitValue(
		computedStyle.getPropertyValue("margin-right"),
	);
	const marginBottom = parseUnitValue(
		computedStyle.getPropertyValue("margin-bottom"),
	);
	const marginLeft = parseUnitValue(
		computedStyle.getPropertyValue("margin-left"),
	);

	// Parse border
	const borderTopWidth = parseUnitValue(
		computedStyle.getPropertyValue("border-top-width"),
	);
	const borderRightWidth = parseUnitValue(
		computedStyle.getPropertyValue("border-right-width"),
	);
	const borderBottomWidth = parseUnitValue(
		computedStyle.getPropertyValue("border-bottom-width"),
	);
	const borderLeftWidth = parseUnitValue(
		computedStyle.getPropertyValue("border-left-width"),
	);

	return {
		width: typeof widthValue === "number" ? widthValue : undefined,
		height: typeof heightValue === "number" ? heightValue : undefined,
		paddingTop: typeof paddingTop === "number" ? paddingTop : 0,
		paddingRight: typeof paddingRight === "number" ? paddingRight : 0,
		paddingBottom: typeof paddingBottom === "number" ? paddingBottom : 0,
		paddingLeft: typeof paddingLeft === "number" ? paddingLeft : 0,
		marginTop: typeof marginTop === "number" ? marginTop : 0,
		marginRight: typeof marginRight === "number" ? marginRight : 0,
		marginBottom: typeof marginBottom === "number" ? marginBottom : 0,
		marginLeft: typeof marginLeft === "number" ? marginLeft : 0,
		borderTopWidth: typeof borderTopWidth === "number" ? borderTopWidth : 0,
		borderRightWidth:
			typeof borderRightWidth === "number" ? borderRightWidth : 0,
		borderBottomWidth:
			typeof borderBottomWidth === "number" ? borderBottomWidth : 0,
		borderLeftWidth: typeof borderLeftWidth === "number" ? borderLeftWidth : 0,
	};
}

interface BreakOptions {
	maxWidth: number;
	whiteSpace?: string;
	wordBreak?: string;
	overflowWrap?: string;
}

export interface InlineBlockLeaf {
	type: "inline-block";
	node: Element;
	breakResult?: BreakResult;
	boxModel: InlineBlockBoxModel;
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

function collectLeafNodes(runHead: Node): Leaf[] {
	const leafNodes: Leaf[] = [];

	// Get the window for the TreeWalker
	const window = runHead.ownerDocument?.defaultView;
	if (!window) {
		return leafNodes;
	}

	// Inline run heads should always have a parent element
	if (!runHead.parentElement) {
		throw new Error("Inline run head must have a parent element");
	}

	// Determine the appropriate traversal root based on parent display type
	const parentDisplay = getPropertyValue(runHead.parentElement, "display");

	let traversalRoot: Node;
	if (parentDisplay === "flex" && runHead.nodeType === runHead.ELEMENT_NODE) {
		// For flex items that are elements, traverse only within that element
		traversalRoot = runHead;
	} else {
		// For all other cases, use the parent as the boundary
		traversalRoot = runHead.parentElement;
	}

	const walker = window.document.createTreeWalker(
		traversalRoot,
		window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT,
		null,
	);

	walker.currentNode = runHead;
	while (walker.currentNode) {
		const node = walker.currentNode;

		if (node.nodeType === node.TEXT_NODE) {
			// Text node - add as leaf
			const textNode = node as Text;
			if (textNode.textContent) {
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
				const boxModel = getInlineBlockBoxModel(element);

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
					inlineBlockResult = breakNodes(
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
					finalContentWidth = Math.max(0, boxModel.width - horizontalBoxSpace);
				}
				if (boxModel.height !== undefined) {
					finalContentHeight = Math.max(0, boxModel.height - verticalBoxSpace);
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

export function breakNodes(
	runHead: Node,
	width: number,
	widthMode: YogaTypes.MeasureMode,
	_height: number,
	_heightMode: YogaTypes.MeasureMode,
): BreakResult {
	// Collect leaf nodes from the run head
	const leafNodes = collectLeafNodes(runHead);

	// Handle empty case
	if (leafNodes.length === 0) {
		return {lines: [], totalHeight: 0, maxLineWidth: 0};
	}

	// Get CSS properties from the appropriate element
	const styleElement =
		runHead.nodeType === runHead.TEXT_NODE
			? runHead.parentElement!
			: (runHead as Element);

	// Get default CSS properties from the run head element
	let whiteSpace = getPropertyValue(styleElement, "white-space");

	const wordBreak = getPropertyValue(styleElement, "word-break");
	const overflowWrap = getPropertyValue(styleElement, "overflow-wrap");

	// Note: Automatic minimum size for flex containers is now handled in measureInlineRun

	// Determine maxWidth based on width and widthMode
	const maxWidth =
		widthMode === Yoga.MEASURE_MODE_UNDEFINED || width === 0
			? Number.MAX_SAFE_INTEGER
			: width;

	// Process and break the content with dynamic per-element styling
	const processedContent = processWhitespace(leafNodes);
	const breaks = findBreakPoints(processedContent, {
		maxWidth,
		// Note: findBreakPoints now needs to handle per-element styling too
		whiteSpace: whiteSpace || "normal", // fallback for run head
		wordBreak: wordBreak || "normal",
		overflowWrap: overflowWrap || "normal",
	});
	const lines = buildLines(processedContent, breaks, maxWidth);

	return {
		lines,
		totalHeight: lines.reduce((sum, line) => sum + line.height, 0),
		maxLineWidth: Math.max(...lines.map((l) => l.width), 0),
	};
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

// Helper to collapse whitespace according to CSS rules
function collapseWhitespace(text: string, whiteSpace: string): string {
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

function processWhitespace(leafNodes: Leaf[]): ProcessedContent {
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
			let processed = collapseWhitespace(leaf.content, leafWhiteSpace);

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

interface BreakPoint {
	position: number;
	required: boolean;
}

function findBreakPoints(
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

function buildLines(
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

			const width = measureText(
				content.text,
				content.items,
				lineStart,
				breakPoint.position,
			);

			// For nowrap (single break point at end), always use it regardless of width
			if (breaks.length === 1 && breakPoint.position === content.text.length) {
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
				const width = measureText(content.text, content.items, lineStart, pos);
				if (width > maxWidth && pos > lineStart + 1) {
					pos--;
					break;
				}
				pos++;
			}
			bestBreak = Math.min(pos, content.text.length);
			bestBreakWidth = measureText(
				content.text,
				content.items,
				lineStart,
				bestBreak,
			);
		}

		const lineNodes = getNodesInRange(content.items, lineStart, bestBreak);

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

function measureText(
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
					item.leafNode.boxModel.borderRightWidth;
				width += blockWidth;
			} else {
				// Partial inline-block measurement not supported
			}
		}
	}

	return width;
}

function getNodesInRange(
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
				const portion = item.processedContent.slice(relativeStart, relativeEnd);
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
					item.leafNode.boxModel.borderRightWidth;
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
