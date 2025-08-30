/**
 * Progressive Layout Tests - Building up to Flexbox Demo
 *
 * This test suite systematically builds from simple cases to complex ones,
 * ensuring each component works before adding complexity.
 */

import {test, expect} from "bun:test";
import {TermDOM} from "../src/index.js";

// === LEVEL 1: BASIC SINGLE ELEMENT TESTS ===

test("Level 1.1 - Single div with dimensions", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const div = document.createElement("div");
	div.style.setProperty("width", "20ch");
	div.style.setProperty("height", "5ch");
	document.body.appendChild(div);

	const rect = div.getBoundingClientRect();
	expect(rect.width).toBe(20);
	expect(rect.height).toBe(5);
	expect(rect.x).toBe(0);
	expect(rect.y).toBe(0);

	dom.dispose();
});

test("Level 1.2 - Single span with text content", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const span = document.createElement("span");
	span.textContent = "Hello World";
	document.body.appendChild(span);

	const rect = span.getBoundingClientRect();
	expect(rect.width).toBe(11); // "Hello World" = 11 chars
	expect(rect.height).toBe(1);
	expect(rect.x).toBe(0);
	expect(rect.y).toBe(0);

	dom.dispose();
});

test("Level 1.3 - Div with padding and margins", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const div = document.createElement("div");
	div.style.setProperty("width", "30ch");
	div.style.setProperty("height", "10ch");
	div.style.setProperty("margin-left", "5ch");
	div.style.setProperty("margin-top", "3ch");
	div.style.setProperty("padding", "2ch");
	document.body.appendChild(div);

	const rect = div.getBoundingClientRect();
	expect(rect.width).toBe(30);
	expect(rect.height).toBe(10);
	expect(rect.x).toBe(5); // margin-left
	expect(rect.y).toBe(3); // margin-top

	dom.dispose();
});

// === LEVEL 2: SIMPLE CONTAINER WITH SINGLE CHILD ===

test("Level 2.1 - Div containing single span", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("width", "50ch");
	container.style.setProperty("padding", "2ch");

	const span = document.createElement("span");
	span.textContent = "Child text";
	container.appendChild(span);
	document.body.appendChild(container);

	const containerRect = container.getBoundingClientRect();
	const spanRect = span.getBoundingClientRect();

	expect(containerRect.width).toBe(50);
	expect(spanRect.width).toBe(10); // "Child text" = 10 chars
	expect(spanRect.height).toBe(1);
	expect(spanRect.x).toBe(2); // container padding
	expect(spanRect.y).toBe(2); // container padding

	dom.dispose();
});

test("Level 2.2 - Flex container with single child", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("width", "40ch");
	container.style.setProperty("height", "8ch");

	const child = document.createElement("div");
	child.style.setProperty("width", "15ch");
	child.style.setProperty("height", "3ch");
	container.appendChild(child);
	document.body.appendChild(container);

	const containerRect = container.getBoundingClientRect();
	const childRect = child.getBoundingClientRect();

	expect(containerRect.width).toBe(40);
	expect(containerRect.height).toBe(8);
	expect(childRect.width).toBe(15);
	expect(childRect.height).toBe(3);
	expect(childRect.x).toBe(0);
	expect(childRect.y).toBe(0);

	dom.dispose();
});

test("Level 2.3 - Flex container with single span", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("width", "40ch");

	const span = document.createElement("span");
	span.textContent = "Flex span text";
	container.appendChild(span);
	document.body.appendChild(container);

	const spanRect = span.getBoundingClientRect();

	expect(spanRect.width).toBe(14); // "Flex span text" = 14 chars
	expect(spanRect.height).toBe(1);
	expect(spanRect.x).toBe(0);
	expect(spanRect.y).toBe(0);

	dom.dispose();
});

// === LEVEL 3: MULTIPLE CHILDREN IN CONTAINERS ===

test("Level 3.1 - Flex row with two spans", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "row");
	container.style.setProperty("width", "80ch");

	const span1 = document.createElement("span");
	span1.textContent = "First";
	const span2 = document.createElement("span");
	span2.textContent = "Second";

	container.appendChild(span1);
	container.appendChild(span2);
	document.body.appendChild(container);

	const span1Rect = span1.getBoundingClientRect();
	const span2Rect = span2.getBoundingClientRect();

	expect(span1Rect.width).toBe(5); // "First" = 5 chars
	expect(span1Rect.height).toBe(1);
	expect(span1Rect.x).toBe(0);
	expect(span1Rect.y).toBe(0);

	expect(span2Rect.width).toBe(6); // "Second" = 6 chars
	expect(span2Rect.height).toBe(1);
	expect(span2Rect.x).toBe(5); // After first span
	expect(span2Rect.y).toBe(0);

	dom.dispose();
});

test("Level 3.2 - Flex column with two spans", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "column");
	container.style.setProperty("width", "80ch");

	const span1 = document.createElement("span");
	span1.textContent = "Top";
	const span2 = document.createElement("span");
	span2.textContent = "Bottom";

	container.appendChild(span1);
	container.appendChild(span2);
	document.body.appendChild(container);

	const span1Rect = span1.getBoundingClientRect();
	const span2Rect = span2.getBoundingClientRect();

	expect(span1Rect.width).toBe(3); // "Top" = 3 chars
	expect(span1Rect.height).toBe(1);
	expect(span1Rect.x).toBe(0);
	expect(span1Rect.y).toBe(0);

	expect(span2Rect.width).toBe(6); // "Bottom" = 6 chars
	expect(span2Rect.height).toBe(1);
	expect(span2Rect.x).toBe(0);
	expect(span2Rect.y).toBe(1); // Below first span

	dom.dispose();
});

test("Level 3.3 - Block container with multiple inline elements", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	container.style.setProperty("width", "60ch");

	const span1 = document.createElement("span");
	span1.textContent = "Start ";
	const span2 = document.createElement("span");
	span2.textContent = "middle ";
	const span3 = document.createElement("span");
	span3.textContent = "end";

	container.appendChild(span1);
	container.appendChild(span2);
	container.appendChild(span3);
	document.body.appendChild(container);

	const span1Rect = span1.getBoundingClientRect();
	const span2Rect = span2.getBoundingClientRect();
	const span3Rect = span3.getBoundingClientRect();

	// All should be on same line (y=0) but different x positions
	expect(span1Rect.y).toBe(0);
	expect(span2Rect.y).toBe(0);
	expect(span3Rect.y).toBe(0);

	expect(span1Rect.width).toBe(6); // "Start " = 6 chars
	expect(span2Rect.width).toBe(7); // "middle " = 7 chars
	expect(span3Rect.width).toBe(3); // "end" = 3 chars

	expect(span1Rect.x).toBe(0);
	expect(span2Rect.x).toBe(6); // After "Start "
	expect(span3Rect.x).toBe(13); // After "Start middle "

	dom.dispose();
});

// === LEVEL 4: ONE LEVEL OF NESTING ===

test("Level 4.1 - Flex container with nested div", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const outer = document.createElement("div");
	outer.style.setProperty("display", "flex");
	outer.style.setProperty("flex-direction", "column");
	outer.style.setProperty("width", "60ch");

	const inner = document.createElement("div");
	inner.style.setProperty("width", "30ch");
	inner.style.setProperty("height", "5ch");
	inner.style.setProperty("background-color", "red");

	const span = document.createElement("span");
	span.textContent = "Nested text";
	inner.appendChild(span);

	outer.appendChild(inner);
	document.body.appendChild(outer);

	const outerRect = outer.getBoundingClientRect();
	const innerRect = inner.getBoundingClientRect();
	const spanRect = span.getBoundingClientRect();

	expect(outerRect.width).toBe(60);
	expect(innerRect.width).toBe(30);
	expect(innerRect.height).toBe(5);
	expect(spanRect.width).toBe(11); // "Nested text" = 11 chars
	expect(spanRect.height).toBe(1);

	dom.dispose();
});

test("Level 4.2 - Flex row with two flex columns", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const main = document.createElement("div");
	main.style.setProperty("display", "flex");
	main.style.setProperty("flex-direction", "row");
	main.style.setProperty("width", "80ch");

	const col1 = document.createElement("div");
	col1.style.setProperty("display", "flex");
	col1.style.setProperty("flex-direction", "column");
	col1.style.setProperty("width", "30ch");

	const col2 = document.createElement("div");
	col2.style.setProperty("display", "flex");
	col2.style.setProperty("flex-direction", "column");
	col2.style.setProperty("width", "40ch");

	const text1 = document.createElement("span");
	text1.textContent = "Column 1";
	const text2 = document.createElement("span");
	text2.textContent = "Column 2";

	col1.appendChild(text1);
	col2.appendChild(text2);
	main.appendChild(col1);
	main.appendChild(col2);
	document.body.appendChild(main);

	const text1Rect = text1.getBoundingClientRect();
	const text2Rect = text2.getBoundingClientRect();

	expect(text1Rect.width).toBe(8); // "Column 1" = 8 chars
	expect(text1Rect.x).toBe(0);
	expect(text1Rect.y).toBe(0);

	expect(text2Rect.width).toBe(8); // "Column 2" = 8 chars
	expect(text2Rect.x).toBe(30); // After col1 width
	expect(text2Rect.y).toBe(0);

	dom.dispose();
});

// === LEVEL 5: FLEXBOX DEMO COMPONENTS ===

test("Level 5.1 - Header component (from flexbox demo)", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const header = document.createElement("div");
	header.style.setProperty("display", "flex");
	header.style.setProperty("flex-direction", "row");
	header.style.setProperty("background-color", "magenta");
	header.style.setProperty("padding", "1ch");

	const title = document.createElement("span");
	title.textContent = "TTY Flexbox Demo";
	title.style.setProperty("color", "white");

	const subtitle = document.createElement("span");
	subtitle.textContent = "Terminal Object Model";
	subtitle.style.setProperty("color", "white");

	header.appendChild(title);
	header.appendChild(subtitle);
	document.body.appendChild(header);

	const titleRect = title.getBoundingClientRect();
	const subtitleRect = subtitle.getBoundingClientRect();

	expect(titleRect.width).toBe(16); // "TTY Flexbox Demo" = 16 chars
	expect(titleRect.height).toBe(1);
	expect(titleRect.x).toBe(1); // header padding

	expect(subtitleRect.width).toBe(21); // "Terminal Object Model" = 21 chars
	expect(subtitleRect.height).toBe(1);
	expect(subtitleRect.x).toBe(17); // 1 (padding) + 16 (title width)

	dom.dispose();
});

test("Level 5.2 - Sidebar component (from flexbox demo)", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const sidebar = document.createElement("div");
	sidebar.style.setProperty("display", "flex");
	sidebar.style.setProperty("flex-direction", "column");
	sidebar.style.setProperty("background-color", "darkgreen");
	sidebar.style.setProperty("padding", "1ch");

	const title = document.createElement("span");
	title.textContent = "Navigation";
	title.style.setProperty("color", "white");

	const item1 = document.createElement("span");
	item1.textContent = "• Home";
	item1.style.setProperty("color", "white");

	const item2 = document.createElement("span");
	item2.textContent = "• About";
	item2.style.setProperty("color", "white");

	sidebar.appendChild(title);
	sidebar.appendChild(item1);
	sidebar.appendChild(item2);
	document.body.appendChild(sidebar);

	const titleRect = title.getBoundingClientRect();
	const item1Rect = item1.getBoundingClientRect();
	const item2Rect = item2.getBoundingClientRect();

	expect(titleRect.width).toBe(10); // "Navigation" = 10 chars
	expect(titleRect.x).toBe(1); // padding
	expect(titleRect.y).toBe(1); // padding

	expect(item1Rect.width).toBe(6); // "• Home" = 6 chars
	expect(item1Rect.x).toBe(1); // padding
	expect(item1Rect.y).toBe(2); // below title

	expect(item2Rect.width).toBe(7); // "• About" = 7 chars
	expect(item2Rect.x).toBe(1); // padding
	expect(item2Rect.y).toBe(3); // below item1

	dom.dispose();
});

test("Level 5.3 - Content area with longer text", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const content = document.createElement("div");
	content.style.setProperty("display", "flex");
	content.style.setProperty("flex-direction", "column");
	content.style.setProperty("width", "60ch");
	content.style.setProperty("padding", "2ch");

	const longText = document.createElement("span");
	longText.textContent =
		"This demonstrates flexbox layout with nested containers.";
	longText.style.setProperty("color", "white");

	content.appendChild(longText);
	document.body.appendChild(content);

	const textRect = longText.getBoundingClientRect();

	expect(textRect.width).toBe(56); // Text length = 56 chars
	expect(textRect.height).toBe(1); // Single line (within 60ch width)
	expect(textRect.x).toBe(2); // padding
	expect(textRect.y).toBe(2); // padding

	dom.dispose();
});
