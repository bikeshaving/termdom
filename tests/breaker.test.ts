import {test, expect} from "bun:test";
import {breakNodes} from "../src/breaker.js";
import {JSDOM} from "jsdom";
import Yoga from "yoga-layout";

// Helper function to create a DOM element with text content
function createTextElement(
	jsdom: JSDOM,
	textContent: string,
	styles: Record<string, string> = {},
) {
	const element = jsdom.window.document.createElement("div");
	const textNode = jsdom.window.document.createTextNode(textContent);
	element.appendChild(textNode);

	// Apply styles to element
	Object.entries(styles).forEach(([prop, value]) => {
		element.style.setProperty(prop, value);
	});

	return {element, textNode};
}

test("simple text breaking", () => {
	const jsdom = new JSDOM();
	const {textNode} = createTextElement(jsdom, "hello world");

	const result = breakNodes(
		textNode,
		5,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);
	expect(result.lines.length).toBeGreaterThanOrEqual(2);
	expect(result.lines[0].segments.length).toBeGreaterThan(0);
});

test("basic line breaking behavior", () => {
	const jsdom = new JSDOM();
	const {textNode} = createTextElement(jsdom, "very long text");

	const result = breakNodes(
		textNode,
		5,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// With a narrow width, text should break into multiple lines
	expect(result.lines.length).toBeGreaterThan(1);
	expect(result.lines[0].segments.length).toBeGreaterThan(0);

	// Total width should fit the content
	expect(result.maxLineWidth).toBeLessThanOrEqual(5);
});

test("emoji text segmentation preserves characters", () => {
	const jsdom = new JSDOM();
	const textContent = "🎨 Colorful Text 🌈";
	const {textNode} = createTextElement(jsdom, textContent);

	const result = breakNodes(
		textNode,
		25,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// Check that we get at least one line
	expect(result.lines.length).toBeGreaterThan(0);

	// Get the first line and its segments
	const firstLine = result.lines[0];

	// Test that the processed text maintains emoji integrity
	let reconstructedText = "";
	for (const segment of firstLine.segments) {
		reconstructedText += segment.processedText;
	}

	// The reconstructed text should contain the emojis
	expect(reconstructedText).toContain("🎨");
	expect(reconstructedText).toContain("🌈");
	expect(reconstructedText).toContain("Colorful Text");
});

test("trailing space handling in isolated text", () => {
	const jsdom = new JSDOM();
	const {textNode} = createTextElement(jsdom, "Text ");

	const result = breakNodes(
		textNode,
		100,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// Trailing space should be preserved for width calculation
	expect(result.maxLineWidth).toBe(5); // "Text " = 5 chars
});

test("multiple text nodes with whitespace", () => {
	const jsdom = new JSDOM();
	const container = jsdom.window.document.createElement("div");

	// Create multiple text nodes to simulate inline layout
	const text1 = jsdom.window.document.createTextNode("Text ");
	const text2 = jsdom.window.document.createTextNode("More");
	container.appendChild(text1);
	container.appendChild(text2);

	const result = breakNodes(
		text1,
		100,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// When starting from text1, breakNodes will traverse the run and collect both text nodes
	expect(result.lines[0].segments.length).toBe(2);
	expect(result.maxLineWidth).toBe(9); // "Text More" = 9 chars (space preserved)
});

test("whitespace collapsing in normal mode", () => {
	const jsdom = new JSDOM();
	const {textNode} = createTextElement(jsdom, "Hello   World");

	const result = breakNodes(
		textNode,
		100,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// Multiple spaces should be collapsed to single space in normal white-space mode
	const segment = result.lines[0].segments[0];
	expect(segment.processedText).toBe("Hello World"); // Spaces collapsed
	expect(segment.width).toBe(11); // "Hello World" = 11 chars
});

test("pre-line whitespace mode", () => {
	const jsdom = new JSDOM();
	const {textNode} = createTextElement(jsdom, "Line1\nLine2", {
		"white-space": "pre-line",
	});

	const result = breakNodes(
		textNode,
		100,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// Should break on newlines in pre-line mode
	expect(result.lines.length).toBe(2);
	expect(result.lines[0].segments[0].processedText).toContain("Line1");
});

test("flex container nowrap behavior", () => {
	const jsdom = new JSDOM();

	// Create a flex container
	const flexContainer = jsdom.window.document.createElement("div");
	flexContainer.style.display = "flex";

	const textElement = jsdom.window.document.createElement("span");
	const textNode = jsdom.window.document.createTextNode(
		"very long text that would normally wrap",
	);
	textElement.appendChild(textNode);
	flexContainer.appendChild(textElement);

	// When width mode is undefined (flex sizing), should use nowrap
	const result = breakNodes(
		textNode,
		10,
		Yoga.MEASURE_MODE_UNDEFINED,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// Should not wrap in flex context with undefined width
	expect(result.lines.length).toBe(1);
	expect(result.maxLineWidth).toBeGreaterThan(10);
});

test("inline-block content measurement", () => {
	const jsdom = new JSDOM();

	// Create an inline-block element with text content
	const inlineBlock = jsdom.window.document.createElement("div");
	inlineBlock.style.display = "inline-block";
	const textNode = jsdom.window.document.createTextNode("Inline Block Text");
	inlineBlock.appendChild(textNode);

	const result = breakNodes(
		textNode,
		100,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// Should measure the text content properly
	expect(result.lines.length).toBe(1);
	expect(result.lines[0].segments.length).toBe(1);
	expect(result.lines[0].segments[0].processedText).toBe("Inline Block Text");
	expect(result.maxLineWidth).toBe(17); // "Inline Block Text" = 17 chars
});

test("mixed emoji and whitespace boundaries", () => {
	const jsdom = new JSDOM();
	const {textNode} = createTextElement(jsdom, "🚀  Text  🌍");

	const result = breakNodes(
		textNode,
		100,
		Yoga.MEASURE_MODE_EXACTLY,
		100,
		Yoga.MEASURE_MODE_UNDEFINED,
	);
	const segment = result.lines[0].segments[0];

	// Should handle emoji and whitespace correctly
	expect(segment.processedText).toBe("🚀 Text 🌍"); // Multiple spaces collapsed
	expect(segment.width).toBe(10); // Actual width from Bun.stringWidth() - emojis are 2-width
});
