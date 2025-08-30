/**
 * Comprehensive Layout Tests - Testing LAYOUT.md Specification
 *
 * This test suite systematically validates each part of the layout system:
 * - Block elements
 * - Inline elements (both in normal flow and flex containers)
 * - Inline-block elements
 * - Flex containers
 * - Anonymous box algorithm
 * - Measure functions
 * - Edge cases from LAYOUT.md
 */

import {test, expect} from "bun:test";
import {TermDOM} from "../src/index.js";

// === BLOCK ELEMENTS ===

test("block elements - basic div layout", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const div = document.createElement("div");
	div.style.setProperty("width", "50ch");
	div.style.setProperty("height", "20ch");
	div.style.setProperty("margin-left", "10ch");
	div.style.setProperty("margin-top", "5ch");
	document.body.appendChild(div);

	const rect = div.getBoundingClientRect();
	expect(rect.width).toBe(50);
	expect(rect.height).toBe(20);
	expect(rect.x).toBe(10);
	expect(rect.y).toBe(5);

	dom.dispose();
});

test("block elements - nested block elements", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const outer = document.createElement("div");
	outer.style.setProperty("width", "80ch");
	outer.style.setProperty("height", "40ch");
	outer.style.setProperty("padding", "5ch");

	const inner = document.createElement("div");
	inner.style.setProperty("width", "30ch");
	inner.style.setProperty("height", "10ch");
	inner.style.setProperty("margin-left", "10ch");
	inner.style.setProperty("margin-top", "8ch");

	outer.appendChild(inner);
	document.body.appendChild(outer);

	const outerRect = outer.getBoundingClientRect();
	const innerRect = inner.getBoundingClientRect();

	expect(outerRect.width).toBe(80);
	expect(outerRect.height).toBe(40);
	expect(outerRect.x).toBe(0);
	expect(outerRect.y).toBe(0);

	// Inner element position includes outer's padding (5) + inner's margin (10, 8)
	expect(innerRect.width).toBe(30);
	expect(innerRect.height).toBe(10);
	expect(innerRect.x).toBe(15); // 5 (padding) + 10 (margin)
	expect(innerRect.y).toBe(13); // 5 (padding) + 8 (margin)

	dom.dispose();
});

// === FLEX CONTAINERS ===

test("flex container - basic flexbox layout", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "row");
	container.style.setProperty("width", "100ch");
	container.style.setProperty("height", "20ch");

	const child1 = document.createElement("div");
	child1.style.setProperty("width", "30ch");
	child1.style.setProperty("height", "15ch");

	const child2 = document.createElement("div");
	child2.style.setProperty("width", "40ch");
	child2.style.setProperty("height", "10ch");

	container.appendChild(child1);
	container.appendChild(child2);
	document.body.appendChild(container);

	const containerRect = container.getBoundingClientRect();
	const child1Rect = child1.getBoundingClientRect();
	const child2Rect = child2.getBoundingClientRect();

	expect(containerRect.width).toBe(100);
	expect(containerRect.height).toBe(20);

	// Flex items should be positioned side by side in row direction
	expect(child1Rect.width).toBe(30);
	expect(child1Rect.height).toBe(15);
	expect(child1Rect.x).toBe(0);
	expect(child1Rect.y).toBe(0);

	expect(child2Rect.width).toBe(40);
	expect(child2Rect.height).toBe(10);
	expect(child2Rect.x).toBe(30); // After child1
	expect(child2Rect.y).toBe(0);

	dom.dispose();
});

test("flex container - column direction", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "column");
	container.style.setProperty("width", "60ch");
	container.style.setProperty("height", "50ch");

	const child1 = document.createElement("div");
	child1.style.setProperty("width", "30ch");
	child1.style.setProperty("height", "15ch");

	const child2 = document.createElement("div");
	child2.style.setProperty("width", "40ch");
	child2.style.setProperty("height", "20ch");

	container.appendChild(child1);
	container.appendChild(child2);
	document.body.appendChild(container);

	const child1Rect = child1.getBoundingClientRect();
	const child2Rect = child2.getBoundingClientRect();

	// Flex items should be stacked vertically in column direction
	expect(child1Rect.x).toBe(0);
	expect(child1Rect.y).toBe(0);
	expect(child1Rect.width).toBe(30);
	expect(child1Rect.height).toBe(15);

	expect(child2Rect.x).toBe(0);
	expect(child2Rect.y).toBe(15); // After child1
	expect(child2Rect.width).toBe(40);
	expect(child2Rect.height).toBe(20);

	dom.dispose();
});

// === INLINE ELEMENTS IN FLEX CONTAINERS ===

test("flex container - inline elements become flex items", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "row");
	container.style.setProperty("width", "100ch");

	const span1 = document.createElement("span");
	span1.textContent = "Hello";
	span1.style.setProperty("width", "20ch");
	span1.style.setProperty("height", "2ch");

	const span2 = document.createElement("span");
	span2.textContent = "World";
	span2.style.setProperty("width", "25ch");
	span2.style.setProperty("height", "2ch");

	container.appendChild(span1);
	container.appendChild(span2);
	document.body.appendChild(container);

	const span1Rect = span1.getBoundingClientRect();
	const span2Rect = span2.getBoundingClientRect();

	// In flex containers, inline elements become flex items
	// They should respect explicit width/height (per LAYOUT.md)
	expect(span1Rect.width).toBe(20);
	expect(span1Rect.height).toBe(2);
	expect(span1Rect.x).toBe(0);
	expect(span1Rect.y).toBe(0);

	expect(span2Rect.width).toBe(25);
	expect(span2Rect.height).toBe(2);
	expect(span2Rect.x).toBe(20); // After span1
	expect(span2Rect.y).toBe(0);

	dom.dispose();
});

test("flex container - text nodes become anonymous flex items", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "row");
	container.style.setProperty("width", "100ch");

	// Add text nodes directly to flex container
	container.appendChild(document.createTextNode("Hello "));
	const span = document.createElement("span");
	span.textContent = "World";
	container.appendChild(span);
	container.appendChild(document.createTextNode(" End"));

	document.body.appendChild(container);

	// The text nodes should be wrapped in anonymous flex items
	// We can't test their rects directly, but the container should lay out properly
	const containerRect = container.getBoundingClientRect();
	const spanRect = span.getBoundingClientRect();

	expect(containerRect.width).toBe(100);
	// Span should be positioned correctly within the flex layout
	expect(spanRect.x).toBeGreaterThan(0); // Should be after "Hello " text

	dom.dispose();
});

// === INLINE ELEMENTS IN NORMAL FLOW (ANONYMOUS BOXES) ===

test("anonymous boxes - inline content in block container", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("width", "80ch");

	// Mixed content: inline elements and text
	container.appendChild(document.createTextNode("Start "));
	const span = document.createElement("span");
	span.textContent = "middle";
	container.appendChild(span);
	container.appendChild(document.createTextNode(" end"));

	document.body.appendChild(container);

	// The container should group inline content into anonymous boxes
	const containerRect = container.getBoundingClientRect();
	expect(containerRect.width).toBe(80);

	// The span should have layout within the anonymous box
	const spanRect = span.getBoundingClientRect();
	expect(spanRect.width).toBeGreaterThan(0);
	expect(spanRect.height).toBeGreaterThan(0);

	dom.dispose();
});

test("anonymous boxes - mixed block and inline content", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("width", "80ch");

	// Mixed content with block interruption
	container.appendChild(document.createTextNode("Before "));
	const span = document.createElement("span");
	span.textContent = "inline";
	container.appendChild(span);

	const blockDiv = document.createElement("div");
	blockDiv.textContent = "Block content";
	blockDiv.style.setProperty("height", "10ch");
	container.appendChild(blockDiv);

	container.appendChild(document.createTextNode(" after"));

	document.body.appendChild(container);

	// Should create anonymous boxes around the block element
	const containerRect = container.getBoundingClientRect();
	const blockRect = blockDiv.getBoundingClientRect();
	const spanRect = span.getBoundingClientRect();

	expect(containerRect.width).toBe(80);
	expect(blockRect.height).toBe(10);
	expect(spanRect.width).toBeGreaterThan(0);

	// Block should create vertical separation
	expect(blockRect.y).toBeGreaterThan(spanRect.y);

	dom.dispose();
});

// === INLINE-BLOCK ELEMENTS ===

test("inline-block elements - basic behavior", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("width", "100ch");

	const inlineBlock = document.createElement("span");
	inlineBlock.style.setProperty("display", "inline-block");
	inlineBlock.style.setProperty("width", "30ch");
	inlineBlock.style.setProperty("height", "8ch");
	inlineBlock.textContent = "Inline-block";

	container.appendChild(document.createTextNode("Before "));
	container.appendChild(inlineBlock);
	container.appendChild(document.createTextNode(" After"));

	document.body.appendChild(container);

	const inlineBlockRect = inlineBlock.getBoundingClientRect();

	// Inline-block should respect explicit dimensions
	expect(inlineBlockRect.width).toBe(30);
	expect(inlineBlockRect.height).toBe(8);
	expect(inlineBlockRect.x).toBeGreaterThan(0); // Should be after "Before " text

	dom.dispose();
});

// === MEASURE FUNCTIONS (TEXT MEASUREMENT) ===

test("measure functions - text-only elements", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const span = document.createElement("span");
	span.textContent = "Hello World";

	const container = document.createElement("div");
	container.appendChild(span);
	document.body.appendChild(container);

	const spanRect = span.getBoundingClientRect();

	// Text should be measured properly
	expect(spanRect.width).toBe(11); // "Hello World" = 11 characters
	expect(spanRect.height).toBe(1); // Single line
	expect(spanRect.x).toBe(0);
	expect(spanRect.y).toBe(0);

	dom.dispose();
});

test("measure functions - nested inline elements", () => {
	const dom = new TermDOM();
	const {document} = dom;

	// Complex nested structure: <span>Hello <strong>bold</strong> world</span>
	const span = document.createElement("span");
	span.appendChild(document.createTextNode("Hello "));

	const strong = document.createElement("strong");
	strong.textContent = "bold";
	span.appendChild(strong);

	span.appendChild(document.createTextNode(" world"));

	const container = document.createElement("div");
	container.appendChild(span);
	document.body.appendChild(container);

	const spanRect = span.getBoundingClientRect();
	const strongRect = strong.getBoundingClientRect();

	// The nested structure should measure correctly
	expect(spanRect.width).toBe(17); // "Hello bold world" = 17 characters
	expect(spanRect.height).toBe(1);

	// Strong element should be positioned within the span
	expect(strongRect.width).toBe(4); // "bold" = 4 characters
	expect(strongRect.height).toBe(1);
	expect(strongRect.x).toBe(6); // After "Hello " (6 chars)
	expect(strongRect.y).toBe(0);

	dom.dispose();
});

// === EDGE CASES FROM LAYOUT.MD ===

test("edge case - empty elements", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const emptySpan = document.createElement("span");
	// No text content, no children

	const container = document.createElement("div");
	container.appendChild(emptySpan);
	document.body.appendChild(container);

	const emptyRect = emptySpan.getBoundingClientRect();

	// Empty elements should collapse to zero dimensions
	expect(emptyRect.width).toBe(0);
	expect(emptyRect.height).toBe(0);

	dom.dispose();
});

test("edge case - inline to block promotion", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const span = document.createElement("span");
	const blockChild = document.createElement("div");
	blockChild.textContent = "Block content";
	blockChild.style.setProperty("height", "5ch");
	span.appendChild(blockChild);

	const container = document.createElement("div");
	container.appendChild(span);
	document.body.appendChild(container);

	const spanRect = span.getBoundingClientRect();
	const blockChildRect = blockChild.getBoundingClientRect();

	// Span should be promoted to block behavior due to block child
	expect(spanRect.width).toBeGreaterThan(0);
	expect(blockChildRect.height).toBe(5);

	dom.dispose();
});

// === COMPREHENSIVE FLEXBOX DEMO COMPONENTS ===

test("flexbox demo - feature card component", () => {
	const dom = new TermDOM();
	const {document} = dom;

	// Create a feature card similar to the flexbox demo
	const card = document.createElement("div");
	card.style.setProperty("display", "flex");
	card.style.setProperty("flex-direction", "column");
	card.style.setProperty("width", "30ch");
	card.style.setProperty("padding", "2ch");
	card.style.setProperty("margin", "1ch");

	const title = document.createElement("h3");
	title.textContent = "Feature Title";
	title.style.setProperty("height", "2ch");
	title.style.setProperty("margin-bottom", "1ch");

	const description = document.createElement("p");
	description.textContent =
		"This is a feature description that should wrap properly within the card.";

	card.appendChild(title);
	card.appendChild(description);
	document.body.appendChild(card);

	const cardRect = card.getBoundingClientRect();
	const titleRect = title.getBoundingClientRect();
	const descRect = description.getBoundingClientRect();

	expect(cardRect.width).toBe(30);
	expect(titleRect.width).toBeGreaterThan(0);
	expect(titleRect.height).toBe(2);
	expect(descRect.width).toBeGreaterThan(0);

	// Title should be above description in column layout
	expect(titleRect.y).toBeLessThan(descRect.y);

	dom.dispose();
});

test("flexbox demo - three column layout", () => {
	const dom = new TermDOM();
	const {document} = dom;

	// Three column flex layout
	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "row");
	container.style.setProperty("width", "120ch");
	container.style.setProperty("height", "40ch");

	const col1 = document.createElement("div");
	col1.style.setProperty("flex", "1");
	col1.style.setProperty("margin", "2ch");
	col1.textContent = "Column 1 content";

	const col2 = document.createElement("div");
	col2.style.setProperty("flex", "1");
	col2.style.setProperty("margin", "2ch");
	col2.textContent = "Column 2 content";

	const col3 = document.createElement("div");
	col3.style.setProperty("flex", "1");
	col3.style.setProperty("margin", "2ch");
	col3.textContent = "Column 3 content";

	container.appendChild(col1);
	container.appendChild(col2);
	container.appendChild(col3);
	document.body.appendChild(container);

	const col1Rect = col1.getBoundingClientRect();
	const col2Rect = col2.getBoundingClientRect();
	const col3Rect = col3.getBoundingClientRect();

	// Columns should be side by side
	expect(col1Rect.x).toBe(2); // margin
	expect(col2Rect.x).toBeGreaterThan(col1Rect.x + col1Rect.width);
	expect(col3Rect.x).toBeGreaterThan(col2Rect.x + col2Rect.width);

	// All columns should have similar widths due to flex: 1
	const tolerance = 5; // Allow some variance
	expect(Math.abs(col1Rect.width - col2Rect.width)).toBeLessThan(tolerance);
	expect(Math.abs(col2Rect.width - col3Rect.width)).toBeLessThan(tolerance);

	dom.dispose();
});
