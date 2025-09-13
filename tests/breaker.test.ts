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

test("trailing space trimming in isolated text", () => {
	const jsdom = new JSDOM();
	const textNode = jsdom.window.document.createTextNode("Text ");

	const leaves: Leaf[] = [{
		type: "text",
		node: textNode,
		content: "Text "
	}];

	const result = breakNodes(leaves, {maxWidth: 100, whiteSpace: "normal"});
	
	// Bug: trailing space gets trimmed when processing in isolation
	expect(result.maxLineWidth).toBe(5); // Should be 5 for "Text ", but gets 4
});

test("multiple spans measured individually - width cascade error", () => {
	const jsdom = new JSDOM();
	
	// Simulating measuring spans individually like flexbox does
	const span1: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("Text "),
		content: "Text "
	}];
	
	const span2: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("🚀"),
		content: "🚀"
	}];
	
	const span3: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode(" More"),
		content: " More"
	}];
	
	const result1 = breakNodes(span1, { maxWidth: 100, whiteSpace: "normal" });
	const result2 = breakNodes(span2, { maxWidth: 100, whiteSpace: "normal" });
	const result3 = breakNodes(span3, { maxWidth: 100, whiteSpace: "normal" });
	
	// The bug: span1 loses its trailing space
	expect(result1.maxLineWidth).toBe(5); // Should be 5 for "Text ", but gets 4
	expect(result2.maxLineWidth).toBe(2); // "🚀" = 2 (correct)
	expect(result3.maxLineWidth).toBe(5); // " More" = 5 (correct, leading space preserved)
	
	// Total should be 5+2+5=12, but we get 4+2+5=11
	const totalWidth = result1.maxLineWidth + result2.maxLineWidth + result3.maxLineWidth;
	expect(totalWidth).toBe(12); // Fails: gets 11
});

test("text truncation due to width mismeasurement", () => {
	const jsdom = new JSDOM();
	
	// First measure "Hello " in isolation
	const span1: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("Hello "),
		content: "Hello "
	}];
	
	const result1 = breakNodes(span1, { maxWidth: 100, whiteSpace: "normal" });
	const width1 = result1.maxLineWidth; // Gets 5 instead of 6
	
	// Now measure "Beautiful" with constrained width
	const remainingWidth = 10 - width1; // 10 - 5 = 5 (should be 10 - 6 = 4)
	const span2: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("Beautiful"),
		content: "Beautiful"
	}];
	
	const result2 = breakNodes(span2, { 
		maxWidth: remainingWidth,
		whiteSpace: "normal" 
	});
	
	// "Beautiful" (9 chars) gets truncated to fit in incorrectly calculated space
	expect(result2.lines[0].segments[0].end).toBe(5); // Truncated to "Beaut"
	expect(result2.maxLineWidth).toBe(5);
});

test("whitespace preserved in continuous runs", () => {
	const jsdom = new JSDOM();
	
	// When processing multiple nodes together (normal inline flow)
	const leaves: Leaf[] = [
		{
			type: "text",
			node: jsdom.window.document.createTextNode("Text "),
			content: "Text "
		},
		{
			type: "text", 
			node: jsdom.window.document.createTextNode("More"),
			content: "More"
		}
	];
	
	const result = breakNodes(leaves, { maxWidth: 100, whiteSpace: "normal" });
	
	// Should preserve the space between words
	expect(result.lines[0].segments.length).toBe(2);
	expect(result.lines[0].segments[0].end - result.lines[0].segments[0].start).toBe(5); // "Text "
	expect(result.lines[0].segments[1].end - result.lines[0].segments[1].start).toBe(4); // "More"
	expect(result.maxLineWidth).toBe(9); // "Text More" = 9 chars
});

test("multiple trailing spaces compound the error", () => {
	const jsdom = new JSDOM();
	
	const leaves1: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("A  "),
		content: "A  "
	}];
	
	const leaves2: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("B  "),
		content: "B  "
	}];
	
	const leaves3: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("C"),
		content: "C"
	}];
	
	const result1 = breakNodes(leaves1, { maxWidth: 100, whiteSpace: "normal" });
	const result2 = breakNodes(leaves2, { maxWidth: 100, whiteSpace: "normal" });
	const result3 = breakNodes(leaves3, { maxWidth: 100, whiteSpace: "normal" });
	
	// Each double space gets trimmed to single space
	expect(result1.maxLineWidth).toBe(3); // "A  " should be 3
	expect(result2.maxLineWidth).toBe(3); // "B  " should be 3  
	expect(result3.maxLineWidth).toBe(1); // "C" = 1
});

test("segment boundaries align with processed text", () => {
	const jsdom = new JSDOM();
	
	const leaves: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("Hello   World"),
		content: "Hello   World"
	}];
	
	const result = breakNodes(leaves, { maxWidth: 100, whiteSpace: "normal" });
	
	// Processed text should be "Hello World" (spaces collapsed)
	// Segment should have correct boundaries for the processed text
	const segment = result.lines[0].segments[0];
	
	// The segment's end-start should match the processed text length
	expect(segment.end - segment.start).toBe(11); // "Hello World"
	expect(segment.width).toBe(11); // Width should match processed length
});

test("trailing whitespace causes segment length mismatch", () => {
	const jsdom = new JSDOM();
	
	// Test case that exposes the core RectLength bug
	const leaves: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("Test    "), // Original has trailing spaces
		content: "Test    "
	}];
	
	const result = breakNodes(leaves, { maxWidth: 100, whiteSpace: "normal" });
	const segment = result.lines[0].segments[0];
	
	// This is where the bug manifests:
	// - Original text: "Test    " (8 chars)
	// - Processed text: "Test" (4 chars) - trailing spaces trimmed
	// - Segment reports: end-start = 4 (processed length)
	// - But when TermDOM slices original text with length 4, it gets "Test" 
	// - However, if this were in the middle of other text, the mismatch would cascade
	
	expect(segment.end - segment.start).toBe(4); // This is the processed length
	// But original text is 8 chars - this mismatch causes rendering bugs
});

test("mixed emoji and whitespace boundaries", () => {
	const jsdom = new JSDOM();
	
	const leaves: Leaf[] = [{
		type: "text",
		node: jsdom.window.document.createTextNode("🚀  Text  🌍"), 
		content: "🚀  Text  🌍"
	}];
	
	const result = breakNodes(leaves, { maxWidth: 100, whiteSpace: "normal" });
	const segment = result.lines[0].segments[0];
	
	// Original: "🚀  Text  🌍" (11 chars, but emoji are 2-width)
	// Processed: "🚀 Text 🌍" (9 chars, spaces collapsed)
	// Width calculation should be: 2 + 1 + 4 + 1 + 2 = 10
	
	expect(segment.width).toBe(10); // Visual width including emoji
	expect(segment.end - segment.start).toBe(9); // Character count in processed text
});
