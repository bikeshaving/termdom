import {test, expect} from "bun:test";
import {breakNodes, type Leaf} from "../src/breaker.js";
import {JSDOM} from "jsdom";

test("simple text breaking", () => {
	const jsdom = new JSDOM();
	const textNode = jsdom.window.document.createTextNode("hello world");

	const leaves: Leaf[] = [
		{
			type: "text",
			node: textNode,
			content: "hello world",
		},
	];

	const result = breakNodes(leaves, {maxWidth: 5});
	expect(result.lines.length).toBeGreaterThanOrEqual(2);
	expect(result.lines[0].segments.length).toBeGreaterThan(0);
});

test("nowrap behavior", () => {
	const jsdom = new JSDOM();
	const textNode = jsdom.window.document.createTextNode("very long text");

	const leaves: Leaf[] = [
		{
			type: "text",
			node: textNode,
			content: "very long text",
		},
	];

	const result = breakNodes(leaves, {maxWidth: 5, whiteSpace: "nowrap"});
	expect(result.lines.length).toBe(1);
	expect(result.maxLineWidth).toBeGreaterThan(5);
});

test("emoji text segmentation preserves characters", () => {
	const jsdom = new JSDOM();
	const textContent = "🎨 Colorful Text 🌈";
	const textNode = jsdom.window.document.createTextNode(textContent);

	const leaves: Leaf[] = [
		{
			type: "text",
			node: textNode,
			content: textContent,
		},
	];

	const result = breakNodes(leaves, {maxWidth: 25});
	
	console.log('Breaker test - original text:', JSON.stringify(textContent));
	console.log('Breaker test - result lines:', result.lines.length);
	
	// Check that we get at least one line
	expect(result.lines.length).toBeGreaterThan(0);
	
	// Get the first line and its segments
	const firstLine = result.lines[0];
	console.log('Breaker test - first line segments:', firstLine.segments.length);
	
	// Test that when we slice the original text using the segment boundaries,
	// we get the correct text back
	let reconstructedText = "";
	for (const segment of firstLine.segments) {
		console.log('Breaker test - segment:', {
			start: segment.start, 
			end: segment.end,
			length: segment.end - segment.start,
			leaf: segment.leaf.type
		});
		
		if (segment.leaf.type === "text") {
			const slicedText = textContent.slice(segment.start, segment.end);
			console.log('Breaker test - sliced text:', JSON.stringify(slicedText));
			reconstructedText += slicedText;
		}
	}
	
	console.log('Breaker test - reconstructed text:', JSON.stringify(reconstructedText));
	
	// The reconstructed text should match the original
	expect(reconstructedText).toBe(textContent);
	
	// Specifically check that the space after the first emoji is preserved
	expect(reconstructedText).toContain("🎨 Colorful"); // Space between emoji and text
	expect(reconstructedText).not.toContain("🎨Colorful"); // Should NOT be missing space
});
