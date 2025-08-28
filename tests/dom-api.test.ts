/**
 * DOM API Tests
 *
 * Tests our Yoga-powered implementations of standard DOM APIs:
 * - document.elementFromPoint()
 * - element.contains()
 * - element.closest()
 */

import {test, expect} from "bun:test";
import {TermDOM} from "../src/index.js";
import {ELEMENT_BOUNDS, ELEMENT_RECTS} from "../src/core/TermDOM.js";

test("document.elementFromPoint() finds element at coordinates", () => {
	const dom = new TermDOM();
	const {document} = dom;

	// Create a button with known dimensions
	const button = document.createElement("button");
	button.textContent = "Test Button";
	button.style.setProperty("width", "20px");
	button.style.setProperty("height", "3px");
	document.body.appendChild(button);

	// Compute layout (this sets YOGA_BOUNDS internally)
	// Trigger layout computation by calling getBoundingClientRect
	button.getBoundingClientRect();

	// Test hit detection within computed bounds
	// Button should be at (0,0) with size 20x3
	const elementAt10_1 = document.elementFromPoint(10, 1); // Inside button
	const elementAt25_1 = document.elementFromPoint(25, 1); // Outside button width
	const elementAt10_5 = document.elementFromPoint(10, 5); // Outside button height

	expect(elementAt10_1).toBe(button); // Should hit button
	expect(elementAt25_1).toBe(document.body); // Should hit body (outside button, inside body)
	expect(elementAt10_5).toBe(document.body); // Should hit body (outside button, inside body)

	dom.dispose();
});

test("document.elementFromPoint() finds deepest element", () => {
	const dom = new TermDOM();
	const {document} = dom;

	// Create nested elements
	const container = document.createElement("div");
	const button = document.createElement("button");
	const span = document.createElement("span");

	span.textContent = "Click me";
	button.appendChild(span);
	container.appendChild(button);
	document.body.appendChild(container);

	// Set dimensions so we have predictable layout
	container.style.setProperty("width", "50px");
	container.style.setProperty("height", "10px");
	button.style.setProperty("width", "30px");
	button.style.setProperty("height", "6px");
	span.style.setProperty("width", "26px");
	span.style.setProperty("height", "4px");

	// Trigger layout computation by calling getBoundingClientRect on container
	container.getBoundingClientRect();

	// Test that deepest element is returned (span should be at 0,0 since it's the deepest)
	const elementAt5_0 = document.elementFromPoint(5, 0);

	expect(elementAt5_0).toBe(span); // Should return deepest element (span)

	dom.dispose();
});

test("element.contains() works correctly", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const container = document.createElement("div");
	const button = document.createElement("button");
	const span = document.createElement("span");

	button.appendChild(span);
	container.appendChild(button);
	document.body.appendChild(container);

	// Test containment relationships
	expect(container.contains(button)).toBe(true);
	expect(container.contains(span)).toBe(true);
	expect(button.contains(span)).toBe(true);
	expect(button.contains(container)).toBe(false);
	expect(span.contains(button)).toBe(false);
	expect(container.contains(container)).toBe(true); // Element contains itself

	dom.dispose();
});

test("element.closest() finds ancestor by tag name", () => {
	const dom = new TermDOM();
	const {document} = dom;

	const form = document.createElement("form");
	const div = document.createElement("div");
	const button = document.createElement("button");
	const span = document.createElement("span");

	form.appendChild(div);
	div.appendChild(button);
	button.appendChild(span);
	document.body.appendChild(form);

	// Test closest ancestor matching
	expect(span.closest("button")?.tagName).toBe("BUTTON");
	expect(span.closest("div")?.tagName).toBe("DIV");
	expect(span.closest("form")?.tagName).toBe("FORM");
	expect(span.closest("body")?.tagName).toBe("BODY");
	expect(span.closest("table")).toBe(null); // Not found

	// Test case insensitivity
	expect(span.closest("BUTTON")?.tagName).toBe("BUTTON");
	expect(span.closest("Button")?.tagName).toBe("BUTTON");

	dom.dispose();
});

test("elementFromPoint returns null for coordinates outside document bounds", () => {
	const dom = new TermDOM();
	const {document} = dom;

	// Add a small button
	const button = document.createElement("button");
	button.style.setProperty("width", "5px");
	button.style.setProperty("height", "3px");
	document.body.appendChild(button);

	// Trigger layout computation by calling getBoundingClientRect on button
	button.getBoundingClientRect();

	// Test coordinates outside terminal bounds (documentElement is 80x24)
	expect(document.elementFromPoint(100, 100)).toBe(null); // Outside document bounds
	expect(document.elementFromPoint(-1, -1)).toBe(null); // Negative coordinates
	expect(document.elementFromPoint(90, 30)).toBe(null); // Beyond terminal size

	dom.dispose();
});
