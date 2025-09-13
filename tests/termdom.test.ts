/**
 * Basic HTML-to-Terminal Tests
 */

import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {TestTerminal} from "./test-utils";

test("TermDOM provides HTML document with terminal capabilities", () => {
	const terminal = new TestTerminal();
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	expect(document).toBeDefined();
	expect(document.createElement).toBeDefined();
	expect(typeof dom.dispose).toBe("function");

	dom.dispose();
});

test("can create standard HTML elements", () => {
	const terminal = new TestTerminal();
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
	const terminal = new TestTerminal();
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
	const terminal = new TestTerminal();
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
	const terminal = new TestTerminal({cols: 100, rows: 50});
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
	const terminal = new TestTerminal();
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
	const terminal = new TestTerminal();
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
