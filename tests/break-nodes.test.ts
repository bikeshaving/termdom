import {test, expect} from "bun:test";
import {JSDOM} from "jsdom";
import {breakNodes} from "../src/breaker.js";
import Yoga from "yoga-layout";

// Set up DOM environment for tests
const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
global.window = dom.window as any;
global.document = dom.window.document;

function createTextInSpan(text: string): Text {
	const span = document.createElement("span");
	const textNode = document.createTextNode(text);
	span.appendChild(textNode);
	document.body.appendChild(span);
	return textNode;
}

test("breakNodes should return natural width for min-content measurement", () => {
	const textNode = createTextInSpan("📋 Navigation");

	// Min-content measurement should return natural width regardless of constraints
	const result = breakNodes(
		textNode,
		Number.MAX_SAFE_INTEGER, // No width constraint
		Yoga.MEASURE_MODE_UNDEFINED,
		Number.MAX_SAFE_INTEGER,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	expect(result.maxLineWidth).toBe(13); // Natural width of "📋 Navigation"
	expect(result.lines.length).toBe(1); // Should be one line
	expect(result.lines[0].segments.map((s) => s.processedText).join("")).toBe(
		"📋 Navigation",
	);
});

test("breakNodes should break text when given constraints (layout mode)", () => {
	const textNode = createTextInSpan("📋 Navigation");

	// When doing actual layout with constraints, should break text
	const result = breakNodes(
		textNode,
		8, // Constrained width
		Yoga.MEASURE_MODE_AT_MOST,
		Number.MAX_SAFE_INTEGER,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// Should break to fit constraint for layout
	expect(result.maxLineWidth).toBe(8);
	expect(result.lines.length).toBeGreaterThan(1);
});

test("breakNodes should return natural width for min-content with MAX_SAFE_INTEGER", () => {
	const textNode = createTextInSpan("📋 Navigation");

	// Min-content measurement using Number.MAX_SAFE_INTEGER as width
	const result = breakNodes(
		textNode,
		Number.MAX_SAFE_INTEGER, // Min-content signal
		Yoga.MEASURE_MODE_UNDEFINED, // Min-content signal
		Number.MAX_SAFE_INTEGER,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	// Should return natural width for min-content measurement
	expect(result.maxLineWidth).toBe(13);
	expect(result.lines.length).toBe(1);
});

test("breakNodes should break text for actual layout (not measurement)", () => {
	const textNode = createTextInSpan("This is a long text that should wrap");

	// When doing actual layout/rendering, it SHOULD break text to fit constraints
	const result = breakNodes(
		textNode,
		15, // Constrained width
		Yoga.MEASURE_MODE_EXACTLY,
		Number.MAX_SAFE_INTEGER,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	expect(result.maxLineWidth).toBeLessThanOrEqual(15); // Should respect constraint
	expect(result.lines.length).toBeGreaterThan(1); // Should break into multiple lines
});

test("breakNodes with nowrap should return natural width", () => {
	const span = document.createElement("span");
	span.style.whiteSpace = "nowrap";
	const textNode = document.createTextNode("📋 Navigation");
	span.appendChild(textNode);
	document.body.appendChild(span);

	// With nowrap, should return natural width even with constraints
	const result = breakNodes(
		textNode,
		5, // Very constrained
		Yoga.MEASURE_MODE_AT_MOST,
		Number.MAX_SAFE_INTEGER,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	expect(result.maxLineWidth).toBe(13); // Should return natural width due to nowrap
	expect(result.lines.length).toBe(1); // Should not break due to nowrap
});

test("breakNodes should handle emoji and unicode correctly", () => {
	const textNode = createTextInSpan("📋🎨🚀 Unicode Test");

	const result = breakNodes(
		textNode,
		Number.MAX_SAFE_INTEGER,
		Yoga.MEASURE_MODE_UNDEFINED,
		Number.MAX_SAFE_INTEGER,
		Yoga.MEASURE_MODE_UNDEFINED,
	);

	const expectedWidth = Bun.stringWidth("📋🎨🚀 Unicode Test");
	expect(result.maxLineWidth).toBe(expectedWidth);
	expect(result.lines[0].segments.map((s) => s.processedText).join("")).toBe(
		"📋🎨🚀 Unicode Test",
	);
});
