/**
 * Basic HTML-to-Terminal Tests
 */

import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {MockProcess} from "./test-utils";

test("TermDOM provides HTML document with terminal capabilities", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	expect(document).toBeDefined();
	expect(document.createElement).toBeDefined();
	expect(typeof dom.dispose).toBe("function");

	dom.dispose();
});

test("can create standard HTML elements", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const div = document.createElement("div");
	const span = document.createElement("span");
	const button = document.createElement("button");

	expect(div.tagName).toBe("DIV");
	expect(span.tagName).toBe("SPAN");
	expect(button.tagName).toBe("BUTTON");

	dom.dispose();
});

test("can build HTML DOM tree", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	const span = document.createElement("span");

	span.textContent = "Hello HTML Terminal!";
	container.appendChild(span);
	document.body.appendChild(container);

	expect(container.children.length).toBe(1);
	expect(container.children[0]).toBe(span);
	expect(span.textContent).toBe("Hello HTML Terminal!");
	expect(document.body.children.length).toBe(1);
	expect(document.body.children[0]).toBe(container);

	dom.dispose();
});

test("HTML elements have CSS styling", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const element = document.createElement("div");

	// Test that element has proper HTML styling APIs
	expect(element).toBeDefined();
	expect(element.tagName).toBe("DIV");
	expect(element.style).toBeDefined();
	expect(typeof element.style.setProperty).toBe("function");

	// Set CSS styles using standard CSSStyleDeclaration API
	element.style.setProperty("background-color", "red");
	element.style.setProperty("color", "white");
	element.style.setProperty("padding", "10px");

	// Test that CSS styles were set
	expect(element.style.getPropertyValue("background-color")).toBe("red");
	expect(element.style.getPropertyValue("color")).toBe("white");
	expect(element.style.getPropertyValue("padding")).toBe("10px");

	dom.dispose();
});

test("TermDOM provides correct terminal dimensions", () => {
	const terminal = new MockProcess({cols: 100, rows: 50});
	const dom = new TermDOM({
		process: terminal,
		width: 100,
		height: 50,
	});

	// Access the internal dimensions via the dom instance
	expect((dom as any).width).toBe(100);
	expect((dom as any).height).toBe(50);

	dom.dispose();
});

test("HTML elements support layout APIs", () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Test that standard HTML elements have layout APIs
	const div = document.createElement("div");
	const span = document.createElement("span");
	const p = document.createElement("p");

	// All elements should have layout APIs
	expect(typeof div.getBoundingClientRect).toBe("function");
	expect(typeof span.offsetWidth).toBe("number");
	expect(typeof p.clientHeight).toBe("number");

	// Initially should return zero (no layout computed yet)
	expect(div.getBoundingClientRect().width).toBe(0);
	expect(span.offsetWidth).toBe(0);
	expect(p.clientHeight).toBe(0);

	dom.dispose();
});

test("can render HTML to terminal without errors", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "Test content";
	div.style.setProperty("color", "blue");
	document.body.appendChild(div);

	// Should render without throwing errors
	// DOM automatically re-renders via MutationObserver
	await new Promise((resolve) => setTimeout(resolve));
	dom.dispose();
});

test("pseudo-element CSS content is available immediately after render", async () => {
	// Test the observable behavior: pseudo-element content should work on first render
	// This was broken before the render pipeline fix - content would be empty until second render

	const terminal = new MockProcess();
	const termDOM = new TermDOM({process: terminal});

	// Set up HTML with pseudo-element CSS
	termDOM.document.body.innerHTML = `
		<style>
			li::marker { content: "🎯 "; color: red; }
			li::before { content: "PREFIX: "; color: blue; }
		</style>
		<ul>
			<li>Test item</li>
		</ul>
	`;

	// Call render once
	await termDOM.render();

	// Test that pseudo-element styles are immediately available
	const li = termDOM.document.querySelector("li")!;
	const markerStyle = termDOM.window.getComputedStyle(li, "::marker");
	const beforeStyle = termDOM.window.getComputedStyle(li, "::before");

	// These should have content immediately, not be empty
	expect(markerStyle.getPropertyValue("content")).toBe('"🎯 "');
	expect(markerStyle.getPropertyValue("color")).toBe("red");
	expect(beforeStyle.getPropertyValue("content")).toBe('"PREFIX: "');
	expect(beforeStyle.getPropertyValue("color")).toBe("blue");

	termDOM.dispose();
});

test("lists render correctly without requiring double-rendering", async () => {
	// Test the actual user-facing behavior that was broken:
	// Lists should render with proper markers on the first render

	const terminal = new MockProcess();
	const termDOM = new TermDOM({process: terminal});

	// Set up a list with custom markers
	termDOM.document.body.innerHTML = `
		<style>
			ul { list-style: none; }
			li::marker { content: "→ "; color: green; }
		</style>
		<ul>
			<li>First item</li>
			<li>Second item</li>
		</ul>
	`;

	// Render once and verify markers are present
	await termDOM.render();

	// Check that markers are available immediately
	const items = termDOM.document.querySelectorAll("li");
	for (const item of items) {
		const markerStyle = termDOM.window.getComputedStyle(item, "::marker");
		expect(markerStyle.getPropertyValue("content")).toBe('"→ "');
		expect(markerStyle.getPropertyValue("color")).toBe("green");
	}

	termDOM.dispose();
});

test("pseudo-elements work on programmatic render without MutationObserver", async () => {
	// This test specifically prevents MutationObserver from triggering the "accidental fix"
	// and tests if pseudo-elements work on the first programmatic render call

	const terminal = new MockProcess();
	const termDOM = new TermDOM({process: terminal});

	// Disconnect MutationObserver to prevent accidental double-rendering
	(termDOM as any).observer.disconnect();

	// Set up HTML with pseudo-element CSS programmatically (not via innerHTML)
	const style = termDOM.document.createElement("style");
	style.textContent = 'li::marker { content: "★ "; color: purple; }';
	termDOM.document.head.appendChild(style);

	const ul = termDOM.document.createElement("ul");
	const li = termDOM.document.createElement("li");
	li.textContent = "Manual item";
	ul.appendChild(li);
	termDOM.document.body.appendChild(ul);

	// Call render once without MutationObserver interference
	await termDOM.render();

	// Test that pseudo-element content is available immediately
	const markerStyle = termDOM.window.getComputedStyle(li, "::marker");

	// With the broken pipeline, this should fail because CSS wasn't parsed before pseudo-element attachment
	expect(markerStyle.getPropertyValue("content")).toBe('"★ "');
	expect(markerStyle.getPropertyValue("color")).toBe("purple");

	termDOM.dispose();
});
