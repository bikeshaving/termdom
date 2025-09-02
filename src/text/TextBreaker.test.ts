import { test, expect } from "bun:test";
import { TextBreaker, type LeafNode } from "./TextBreaker2.js";

// Helper to create text leaf nodes
function textNode(content: string): LeafNode {
	return {
		type: "text",
		content,
		node: { nodeType: 3 } as any, // Mock text node
	};
}

// Helper to create inline-block leaf nodes
function inlineBlockNode(width: number, height: number = 1): LeafNode {
	return {
		type: "inline-block",
		width,
		height,
		node: { nodeType: 1 } as any, // Mock element node
	};
}

// Helper to create br leaf nodes
function brNode(): LeafNode {
	return {
		type: "br",
		node: { nodeType: 1 } as any, // Mock element node
	};
}

test("TextBreaker - simple text", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes([textNode("Hello world")], { maxWidth: 20 });

	expect(result.lines).toHaveLength(1);
	expect(result.lines[0].width).toBeLessThanOrEqual(20);
	expect(result.lines[0].nodes).toHaveLength(1);
	expect(result.lines[0].nodes[0].start).toBe(0);
	expect(result.lines[0].nodes[0].end).toBe(11); // Full length of original content
});

test("TextBreaker - text wrapping", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes([textNode("Hello beautiful world")], { maxWidth: 10 });

	expect(result.lines.length).toBeGreaterThan(1);
	// Each line should be <= 10 chars wide
	for (const line of result.lines) {
		expect(line.width).toBeLessThanOrEqual(10);
	}
});

test("TextBreaker - whitespace normal", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[textNode("Hello   world   ")], 
		{ maxWidth: 20, whiteSpace: "normal" }
	);

	// Should collapse multiple spaces
	expect(result.lines).toHaveLength(1);
	// The result contains the collapsed text
	expect(result.lines[0].width).toBe(11); // "Hello world" = 11 chars
	expect(result.lines[0].nodes).toHaveLength(1);
	
	// For whitespace processing, the start/end positions are relative to the processed content
	// not the original content. The original content was "Hello   world   " but
	// after processing it becomes "Hello world"
	const node = result.lines[0].nodes[0];
	expect(node.start).toBe(0);
	expect(node.end).toBe(11); // "Hello world" = 11 chars
	expect(node.width).toBe(11);
});

test("TextBreaker - whitespace pre", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[textNode("Hello   world   ")], 
		{ maxWidth: 20, whiteSpace: "pre" }
	);

	// Should preserve all spaces
	const text = result.lines[0].nodes.map(n => {
		const content = n.leafNode.content!;
		return content.slice(n.start, n.end);
	}).join("");
	expect(text).toBe("Hello   world   ");
});

test("TextBreaker - nowrap", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[textNode("This is a very long line that should not wrap")], 
		{ maxWidth: 10, whiteSpace: "nowrap" }
	);

	// Should have exactly one line regardless of width
	expect(result.lines).toHaveLength(1);
	expect(result.lines[0].width).toBeGreaterThan(10);
});

test("TextBreaker - br elements", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[textNode("Line 1"), brNode(), textNode("Line 2")], 
		{ maxWidth: 100 }
	);

	// Should have two lines
	expect(result.lines).toHaveLength(2);
	expect(result.lines[0].nodes[0].leafNode.content).toBe("Line 1");
	expect(result.lines[1].nodes[0].leafNode.content).toBe("Line 2");
});

test("TextBreaker - BR with normal whitespace", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[textNode("Line 1"), brNode(), textNode("Line 2")],
		{ maxWidth: 100, whiteSpace: "normal" }
	);

	// BR should force a line break even with normal whitespace
	expect(result.lines).toHaveLength(2);
	expect(result.lines[0].nodes[0].leafNode.content).toBe("Line 1");
	expect(result.lines[1].nodes[0].leafNode.content).toBe("Line 2");
});

test("TextBreaker - inline-block elements", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[
			textNode("Hello "),
			inlineBlockNode(5), // 5 chars wide
			textNode(" world"),
		],
		{ maxWidth: 20 }
	);

	// Should treat inline-block as atomic unit
	expect(result.lines).toHaveLength(1);
	expect(result.lines[0].nodes).toHaveLength(3);
	expect(result.lines[0].nodes[1].leafNode.type).toBe("inline-block");
	expect(result.lines[0].nodes[1].width).toBe(5);
});

test("TextBreaker - inline-block wrapping", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[
			textNode("Text "),
			inlineBlockNode(15), // Too wide to fit on same line
			textNode(" more"),
		],
		{ maxWidth: 10 }
	);

	// Inline-block should be on its own line
	expect(result.lines.length).toBeGreaterThanOrEqual(2);
	// Find the line with the inline-block
	const inlineBlockLine = result.lines.find(line => 
		line.nodes.some(n => n.leafNode.type === "inline-block")
	);
	expect(inlineBlockLine).toBeDefined();
	expect(inlineBlockLine!.width).toBe(15);
});

test("TextBreaker - multiple text nodes", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[
			textNode("Hello "),
			textNode("beautiful "),
			textNode("world"),
		],
		{ maxWidth: 15 }
	);

	// Should handle multiple text nodes correctly
	expect(result.lines.length).toBeGreaterThan(1);
	// Check that all nodes appear in the result
	const nodeCount = result.lines.reduce((sum, line) => sum + line.nodes.length, 0);
	expect(nodeCount).toBeGreaterThanOrEqual(3); // At least one node per input
});

test("TextBreaker - line height with tall inline-block", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[
			textNode("Normal "),
			inlineBlockNode(5, 3), // 3 lines tall
			textNode(" text"),
		],
		{ maxWidth: 50 }
	);

	// Line should be as tall as tallest element
	expect(result.lines).toHaveLength(1);
	expect(result.lines[0].height).toBe(3);
});

test("TextBreaker - empty nodes", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[
			textNode("Start"),
			textNode(""), // Empty text node
			textNode("End"),
		],
		{ maxWidth: 20 }
	);

	// Should handle empty nodes gracefully
	expect(result.lines).toHaveLength(1);
	const text = result.lines[0].nodes.map(n => {
		if (n.leafNode.type === "text") {
			return n.leafNode.content!.slice(n.start, n.end);
		}
		return "";
	}).join("");
	expect(text).toBe("StartEnd");
});

test("TextBreaker - character positions", () => {
	const breaker = new TextBreaker();
	const nodes = [
		textNode("Hello "),
		textNode("world"),
	];
	const result = breaker.breakNodes(nodes, { maxWidth: 100 });

	// Check that nodes are present
	expect(result.lines[0].nodes.length).toBeGreaterThanOrEqual(2);
	// Check x positions increment correctly
	let totalX = 0;
	for (const node of result.lines[0].nodes) {
		expect(node.x).toBe(totalX);
		totalX += node.width;
	}
});

test("TextBreaker - x positioning", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[
			textNode("AB"), // 2 chars
			inlineBlockNode(3), // 3 chars
			textNode("CD"), // 2 chars
		],
		{ maxWidth: 100 }
	);

	// Check x positions
	expect(result.lines[0].nodes[0].x).toBe(0);
	expect(result.lines[0].nodes[1].x).toBe(2); // After "AB"
	expect(result.lines[0].nodes[2].x).toBe(5); // After "AB" + inline-block
});

test("TextBreaker - pre-line whitespace", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[textNode("Line 1  \nLine 2  ")], 
		{ maxWidth: 100, whiteSpace: "pre-line" }
	);

	// Should preserve newlines but collapse other spaces
	expect(result.lines).toHaveLength(2);
	// With pre-line:
	// "Line 1  \n" -> "Line 1 \n" (collapses double space to single)
	// "Line 2  " -> "Line 2" (collapses and trims trailing)
	expect(result.lines[0].width).toBe(7); // "Line 1 " = 7 chars
	expect(result.lines[1].width).toBe(6); // "Line 2" = 6 chars
});

test("TextBreaker - break-word", () => {
	const breaker = new TextBreaker();
	const result = breaker.breakNodes(
		[textNode("verylongwordthatdoesntfit")], 
		{ maxWidth: 10, wordBreak: "break-word" }
	);

	// Should break within word
	expect(result.lines.length).toBeGreaterThan(1);
	for (const line of result.lines) {
		expect(line.width).toBeLessThanOrEqual(10);
	}
});