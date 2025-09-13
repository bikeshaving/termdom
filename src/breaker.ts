import LineBreaker from "linebreak";

export interface BreakOptions {
	maxWidth: number;
	whiteSpace?: "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line";
	wordBreak?: "normal" | "break-all" | "break-word" | "keep-all";
	overflowWrap?: "normal" | "anywhere" | "break-word";
}

export interface InlineBlockLeaf {
	type: "inline-block";
	node: Element;
	width: number;
	height: number;
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

export function breakNodes(
	leafNodes: Leaf[],
	options: BreakOptions,
): BreakResult {
	const {maxWidth, whiteSpace = "normal"} = options;

	if (whiteSpace === "nowrap") {
		return noWrapLayout(leafNodes);
	}

	const processedContent = processWhitespace(leafNodes, whiteSpace);

	const breaks = findBreakPoints(processedContent, options);

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

	for (const leaf of leafNodes) {
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

	// TODO: This is wrong
	if (
		(whiteSpace === "normal" ||
			whiteSpace === "nowrap" ||
			whiteSpace === "pre-line") &&
		text.endsWith(" ")
	) {
		text = text.slice(0, -1);
		for (let i = items.length - 1; i >= 0; i--) {
			if (items[i].end > text.length) {
				items[i].end = text.length;
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

function noWrapLayout(segments: Leaf[]): BreakResult {
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

	const lines: LineResult[] = [
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
