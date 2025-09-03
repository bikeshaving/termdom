import LineBreaker from "linebreak";

// TODO: Can this type be a mapped type over the lib.dom.d.ts types?
export interface BreakOptions {
	maxWidth: number;
	whiteSpace?: "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line";
	wordBreak?: "normal" | "break-all" | "break-word" | "keep-all";
	overflowWrap?: "normal" | "anywhere" | "break-word";
}

export interface InlineBlockLeaf {
	type: "inline-block";
	node: Element;
	width: number; // for inline-block
	height: number; // for inline-block (can be > 1)
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
		start: number; // char position within text node
		end: number; // char position within text node
		x: number; // x position on line
		width: number; // width of this segment
	}>;
	y: number;
	width: number; // total line width
	height: number; // max height of nodes on this line
}

export interface BreakResult {
	lines: Array<LineResult>;
	maxLineWidth: number;
	totalHeight: number;
}

export function breakNodes(
	leafNodes: Leaf[],
	options: BreakOptions,
): BreakResult {
	const {maxWidth, whiteSpace = "normal"} = options;

	// Handle nowrap case
	if (whiteSpace === "nowrap") {
		return noWrapLayout(leafNodes);
	}

	// Build flattened content with whitespace handling
	const processedContent = processWhitespace(leafNodes, whiteSpace);

	// Use linebreak library for UAX #14 support
	const breaks = findBreakPoints(processedContent, options);

	// Build lines from break points
	const lines = buildLines(processedContent, breaks, maxWidth);

	return {
		lines,
		totalHeight: lines.reduce((sum, line) => sum + line.height, 0),
		maxLineWidth: Math.max(...lines.map((l) => l.width), 0),
	};
}

interface ProcessedContent {
	// TODO: should this be segments too?
	items: Array<{
		leafNode: Leaf;
		start: number; // position in processed text
		end: number; // position in processed text
		processedContent?: string; // the processed text for this node
	}>;
	text: string; // flattened text for linebreak library
}

function processWhitespace(
	leafNodes: Leaf[],
	whiteSpace: string,
): ProcessedContent {
	const items: ProcessedContent["items"] = [];
	let text = "";
	let lastWasSpace = false;

	for (const leaf of leafNodes) {
		const start = text.length;

		if (leaf.type === "text" && leaf.content) {
			let processed = "";
			const mapping: Array<number> = []; // maps processed position to original position

			// Apply whitespace rules
			if (whiteSpace === "normal" || whiteSpace === "nowrap") {
				// Process character by character for proper space collapsing
				for (let i = 0; i < leaf.content.length; i++) {
					const char = leaf.content[i];
					if (/\s/.test(char)) {
						// For normal/nowrap, convert ALL whitespace (including newlines) to spaces
						// BR elements are handled separately and will add their own newlines
						const atStart = text.length === 0 && processed.length === 0;
						const afterNewline =
							text.length > 0 && text[text.length - 1] === "\n";
						if (!atStart && !lastWasSpace && !afterNewline) {
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
			} else if (whiteSpace === "pre-line") {
				// Collapse spaces but preserve newlines
				let temp = "";
				for (let i = 0; i < leaf.content.length; i++) {
					const char = leaf.content[i];
					if (char === "\n") {
						temp += char;
						mapping.push(i);
						lastWasSpace = false;
					} else if (/\s/.test(char)) {
						// For pre-line: collapse consecutive spaces, but keep one
						// Don't add space at start of line (after newline)
						const atLineStart =
							temp.length === 0 || temp[temp.length - 1] === "\n";
						if (!lastWasSpace && !atLineStart) {
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
			} else {
				// pre and pre-wrap preserve everything
				processed = leaf.content;
				for (let i = 0; i < leaf.content.length; i++) {
					mapping.push(i);
				}
				lastWasSpace = false;
			}

			text += processed;

			// Store the item with processed content
			items.push({
				leafNode: leaf,
				start,
				end: text.length,
				processedContent: processed,
			});
		} else if (leaf.type === "br") {
			text += "\n";
			lastWasSpace = false; // Reset space tracking after newline
			items.push({
				leafNode: leaf,
				start,
				end: text.length,
			});
		} else if (leaf.type === "inline-block") {
			// Use object replacement character
			text += "\uFFFC";
			lastWasSpace = false;
			items.push({
				leafNode: leaf,
				start,
				end: text.length,
			});
		}
	}

	// Trim trailing space for normal/nowrap/pre-line
	if (
		(whiteSpace === "normal" ||
			whiteSpace === "nowrap" ||
			whiteSpace === "pre-line") &&
		text.endsWith(" ")
	) {
		text = text.slice(0, -1);
		// Adjust last item's end and processed content
		for (let i = items.length - 1; i >= 0; i--) {
			if (items[i].end > text.length) {
				items[i].end = text.length;
				// Also trim the processed content if it's a text node
				const item = items[i];
				if (item.leafNode.type === "text" && item.processedContent) {
					const trimAmount =
						item.processedContent.length - (item.end - item.start);
					if (trimAmount > 0) {
						item.processedContent = item.processedContent.slice(0, -trimAmount);
					}
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
): Array<BreakPoint> {
	// Use linebreak library for proper UAX #14 breaking
	const breaker = new LineBreaker(content.text);
	const breaks: Array<BreakPoint> = [];

	let lastPos = 0;
	let bk;
	while ((bk = breaker.nextBreak())) {
		// Handle forced breaks (newlines, <br>)
		let required = bk.required || false;

		// Check if this is a forced break from white-space CSS
		const {whiteSpace = "normal"} = options;
		if (
			whiteSpace === "pre" ||
			whiteSpace === "pre-wrap" ||
			whiteSpace === "pre-line"
		) {
			// Check if there's a newline in this segment
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
	breaks: Array<BreakPoint>,
	maxWidth: number,
): Array<LineResult> {
	const lines: Array<LineResult> = [];
	let currentY = 0;
	let lineStart = 0;

	// Greedy line breaking algorithm
	while (lineStart < content.text.length) {
		let bestBreak = lineStart;
		let bestBreakWidth = 0;

		// Find the best break position that fits
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
				// This break is too far, stop looking
				break;
			}

			// If this is a required break, use it
			if (breakPoint.required) {
				bestBreak = breakPoint.position;
				bestBreakWidth = width;
				break;
			}
		}

		// If no break found, force break at maxWidth or next char
		if (bestBreak === lineStart) {
			// Find position that fits
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

		// Create line
		const lineNodes = getNodesInRange(content.items, lineStart, bestBreak);

		if (lineNodes.length > 0) {
			const lineHeight = Math.max(
				...lineNodes.map((n) =>
					n.leaf.type === "inline-block" ? n.leaf.height : 1,
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

		// Skip whitespace at start of next line (for normal white-space mode)
		// This is handled by processWhitespace but we might need to adjust lineStart
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

	// Find items in this range
	for (const item of items) {
		if (item.start >= end || item.end <= start) continue;

		const itemStart = Math.max(item.start, start);
		const itemEnd = Math.min(item.end, end);

		if (item.leafNode.type === "text") {
			// Measure text portion
			const portion = text.slice(itemStart, itemEnd);
			width += Bun.stringWidth(portion);
		} else if (item.leafNode.type === "inline-block") {
			// Use pre-calculated width
			width += item.leafNode.width;
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
				// Calculate positions within the processed content
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
				});
			} else if (item.leafNode.type === "inline-block") {
				width = item.leafNode.width;
				nodes.push({
					leaf: item.leafNode,
					start: 0,
					end: 0,
					x,
					width,
				});
			} else if (item.leafNode.type === "br") {
				// BR elements don't have visual width
				nodes.push({
					leaf: item.leafNode,
					start: 0,
					end: 0,
					x,
					width: 0,
				});
			}

			x += width;
		}
	}

	return nodes;
}

function noWrapLayout(segments: Array<Leaf>): BreakResult {
	// Single line with all content
	const content = processWhitespace(segments, "nowrap");
	const lineNodes = getNodesInRange(content.items, 0, content.text.length);

	const width = measureText(
		content.text,
		content.items,
		0,
		content.text.length,
	);

	const height = Math.max(
		...segments.map((n) => (n.type === "inline-block" ? n.height : 1)),
		1,
	);

	const lines: Array<LineResult> = [
		{
			segments: lineNodes,
			y: 0,
			height,
			width,
		},
	];

	return {
		lines,
		totalHeight: height,
		maxLineWidth: width,
	};
}
