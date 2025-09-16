import LineBreaker from "linebreak";
import {getPropertyValue} from "./styles.js";
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

export interface BreakOptions {
	maxWidth: number;
	whiteSpace?: "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line";
	wordBreak?: "normal" | "break-all" | "break-word" | "keep-all";
	overflowWrap?: "normal" | "anywhere" | "break-word";
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

	// Always create walker
	const walker = window.document.createTreeWalker(
		runHead.ownerDocument || window.document,
		window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT,
		null,
	);

	// Check if we should limit traversal scope
	const parentDisplay = runHead.parentElement
		? getPropertyValue(runHead.parentElement, "display")
		: null;
	const shouldLimitScope =
		parentDisplay === "flex" || parentDisplay === "inline-block";

	// Unified traversal: simple loop with smart next-node decisions
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

		// Apply scope limiting if needed
		if (shouldLimitScope && !runHead.contains(walker.currentNode)) {
			break;
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

	// Get CSS text layout properties
	let whiteSpace = getPropertyValue(styleElement, "white-space") as any;
	const wordBreak = getPropertyValue(styleElement, "word-break") as any;
	const overflowWrap = getPropertyValue(styleElement, "overflow-wrap") as any;

	// Special handling for flex containers
	if (
		styleElement.parentElement &&
		getPropertyValue(styleElement.parentElement, "display") === "flex"
	) {
		if (widthMode === Yoga.MEASURE_MODE_UNDEFINED) {
			whiteSpace = "nowrap";
		}
	}

	// Determine maxWidth based on width and widthMode
	const maxWidth =
		widthMode === Yoga.MEASURE_MODE_UNDEFINED || width === 0
			? Number.MAX_SAFE_INTEGER
			: width;

	// Process and break the content
	const processedContent = processWhitespace(leafNodes, whiteSpace || "normal");
	const breaks = findBreakPoints(processedContent, {
		maxWidth,
		whiteSpace: whiteSpace || "normal",
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

function processWhitespace(
	leafNodes: Leaf[],
	whiteSpace: string,
): ProcessedContent {
	const items: ProcessedContent["items"] = [];
	let text = "";
	let lastWasSpace = false;

	for (let leafIndex = 0; leafIndex < leafNodes.length; leafIndex++) {
		const leaf = leafNodes[leafIndex];
		const nextLeaf = leafNodes[leafIndex + 1];
		const prevLeaf = leafNodes[leafIndex - 1];
		const start = text.length;

		if (leaf.type === "text" && leaf.content) {
			let processed = "";
			const mapping: number[] = [];

			if (whiteSpace === "normal" || whiteSpace === "nowrap") {
				for (let i = 0; i < leaf.content.length; i++) {
					const char = leaf.content[i];
					if (/\s/.test(char)) {
						const atStart = text.length === 0 && processed.length === 0;
						const afterNewline =
							text.length > 0 && text[text.length - 1] === "\n";

						// Check if previous leaf ends with space (for isolated measurement)
						const prevEndsWithSpace =
							prevLeaf?.type === "text" &&
							prevLeaf.content &&
							/\s$/.test(prevLeaf.content);

						// Preserve leading spaces unless previous text ends with space
						if (
							!atStart &&
							!lastWasSpace &&
							!afterNewline &&
							!prevEndsWithSpace
						) {
							processed += " ";
							mapping.push(i);
							lastWasSpace = true;
						} else if (atStart && !prevEndsWithSpace) {
							// For isolated measurement, preserve leading space
							processed += " ";
							mapping.push(i);
							lastWasSpace = true;
						}
					} else {
						processed += char;
						mapping.push(i);
						lastWasSpace = false;
					}
				}

				// Handle trailing whitespace with lookahead
				if (processed.length > 0 && /\s$/.test(processed)) {
					const nextStartsWithSpace =
						nextLeaf?.type === "text" &&
						nextLeaf.content &&
						/^\s/.test(nextLeaf.content);

					// Only remove trailing whitespace if next leaf starts with whitespace
					// This allows proper CSS collapsing between adjacent text nodes
					// For isolated measurement (flexbox), trailing spaces are preserved
					if (nextStartsWithSpace) {
						// Remove ALL trailing whitespace (not just one character)
						const trimmed = processed.replace(/\s+$/, "");
						const trimAmount = processed.length - trimmed.length;

						processed = trimmed;
						// Adjust mapping to remove trimmed characters
						mapping.splice(-trimAmount, trimAmount);
						lastWasSpace = false;
					}
				}
			} else if (whiteSpace === "pre-line") {
				let temp = "";
				for (let i = 0; i < leaf.content.length; i++) {
					const char = leaf.content[i];
					if (char === "\n") {
						temp += char;
						mapping.push(i);
						lastWasSpace = false;
					} else if (/\s/.test(char)) {
						const atLineStart =
							temp.length === 0 || temp[temp.length - 1] === "\n";

						// Check if previous leaf ends with space (for isolated measurement)
						const prevEndsWithSpace =
							prevLeaf?.type === "text" &&
							prevLeaf.content &&
							/\s$/.test(prevLeaf.content);

						if (!lastWasSpace && !atLineStart && !prevEndsWithSpace) {
							temp += " ";
							mapping.push(i);
							lastWasSpace = true;
						} else if (atLineStart && !prevEndsWithSpace) {
							// For isolated measurement, preserve leading space
							temp += " ";
							mapping.push(i);
							lastWasSpace = true;
						}
					} else {
						temp += char;
						mapping.push(i);
						lastWasSpace = false;
					}
				}
				processed = temp;

				// Handle trailing whitespace for pre-line (same as normal/nowrap)
				if (processed.length > 0 && /\s$/.test(processed)) {
					const nextStartsWithSpace =
						nextLeaf?.type === "text" &&
						nextLeaf.content &&
						/^\s/.test(nextLeaf.content);

					// Only remove trailing whitespace if next leaf starts with whitespace
					if (nextStartsWithSpace) {
						const trimmed = processed.replace(/\s+$/, "");
						const trimAmount = processed.length - trimmed.length;

						processed = trimmed;
						mapping.splice(-trimAmount, trimAmount);
						lastWasSpace = false;
					}
				}
			} else {
				processed = leaf.content;
				for (let i = 0; i < leaf.content.length; i++) {
					mapping.push(i);
				}
				lastWasSpace = false;
			}

			text += processed;

			items.push({
				leafNode: leaf,
				start,
				end: text.length,
				processedContent: processed,
			});
		} else if (leaf.type === "br") {
			text += "\n";
			lastWasSpace = false;
			items.push({
				leafNode: leaf,
				start,
				end: text.length,
			});
		} else if (leaf.type === "inline-block") {
			// TODO: explain
			text += "\uFFFC";
			lastWasSpace = false;
			items.push({
				leafNode: leaf,
				start,
				end: text.length,
			});
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
