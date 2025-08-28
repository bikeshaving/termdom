/**
 * Tests for HTML CSSOM integration in TTYOM
 */

import {test, expect, describe} from "bun:test";
import {TermDOM} from "../src/index.js";

describe("HTML CSSOM Integration", () => {
	test("HTML elements should have CSSStyleDeclaration", () => {
		const dom = new TermDOM();
		const {document} = dom;
		const element = document.createElement("div");

		expect(element.style).toBeDefined();
		// JSDOM may not have constructor.name, just check it's a style object
		expect(typeof element.style.setProperty).toBe("function");
		expect(typeof element.style.getPropertyValue).toBe("function");
		expect(typeof element.style.removeProperty).toBe("function");

		dom.dispose();
	});

	test("setProperty and getPropertyValue should work", () => {
		const dom = new TermDOM();
		const {document} = dom;
		const element = document.createElement("div");

		element.style.setProperty("color", "red");
		element.style.setProperty("background-color", "blue");
		element.style.setProperty("display", "flex");

		expect(element.style.getPropertyValue("color")).toBe("red");
		expect(element.style.getPropertyValue("background-color")).toBe("blue");
		expect(element.style.getPropertyValue("display")).toBe("flex");
		expect(element.style.getPropertyValue("font-size")).toBe(""); // not set

		dom.dispose();
	});

	test("removeProperty should work", () => {
		const dom = new TermDOM();
		const {document} = dom;
		const element = document.createElement("div");

		element.style.setProperty("color", "red");
		expect(element.style.getPropertyValue("color")).toBe("red");

		element.style.removeProperty("color");
		expect(element.style.getPropertyValue("color")).toBe("");

		dom.dispose();
	});

	test("document.defaultView.getComputedStyle should work", () => {
		const dom = new TermDOM();
		const {document} = dom;
		const element = document.createElement("div");

		element.style.setProperty("color", "red");
		element.style.setProperty("display", "block");
		document.body.appendChild(element);

		const computedStyle = document.defaultView!.getComputedStyle(element);

		expect(computedStyle).toBeDefined();
		// JSDOM may not have constructor.name, just check it's a computed style object
		expect(typeof computedStyle.getPropertyValue).toBe("function");
		expect(computedStyle.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
		expect(computedStyle.getPropertyValue("display")).toBe("block");

		dom.dispose();
	});

	test("CSS property names should be kebab-case", () => {
		const dom = new TermDOM();
		const {document} = dom;
		const element = document.createElement("div");

		// Use kebab-case property names
		element.style.setProperty("background-color", "blue");
		element.style.setProperty("font-weight", "bold");
		element.style.setProperty("flex-direction", "column");
		element.style.setProperty("text-align", "center");

		expect(element.style.getPropertyValue("background-color")).toBe("blue");
		expect(element.style.getPropertyValue("font-weight")).toBe("bold");
		expect(element.style.getPropertyValue("flex-direction")).toBe("column");
		expect(element.style.getPropertyValue("text-align")).toBe("center");

		dom.dispose();
	});

	test("style changes should work with HTML elements", async () => {
		const dom = new TermDOM();
		const {document} = dom;
		const element = document.createElement("div");

		// Add element to DOM
		document.body.appendChild(element);
		element.style.setProperty("color", "red");

		// Verify style property works
		expect(element.style.getPropertyValue("color")).toBe("red");

		// DOM automatically re-renders via MutationObserver
		await new Promise((resolve) => setTimeout(resolve));

		dom.dispose();
	});

	test("createElement should work with any HTML tag names", () => {
		const dom = new TermDOM();
		const {document} = dom;

		const element = document.createElement("custom-element");

		expect(element).toBeDefined();
		expect(element.tagName).toBe("CUSTOM-ELEMENT");
		expect(element.style).toBeDefined();
		expect(typeof element.style.setProperty).toBe("function");

		// Should work the same as built-in elements
		element.style.setProperty("color", "green");
		expect(element.style.getPropertyValue("color")).toBe("green");

		dom.dispose();
	});

	test("style property should be the same instance on repeated access", () => {
		const dom = new TermDOM();
		const {document} = dom;
		const element = document.createElement("div");

		const style1 = element.style;
		const style2 = element.style;

		expect(style1).toBe(style2);

		dom.dispose();
	});

	test("computed style should work with HTML elements", () => {
		const dom = new TermDOM();
		const {document} = dom;
		const parent = document.createElement("div");
		const child = document.createElement("span");

		parent.style.setProperty("color", "blue");
		parent.style.setProperty("font-size", "16px");
		parent.appendChild(child);
		document.body.appendChild(parent);

		const parentComputed = document.defaultView!.getComputedStyle(parent);
		const childComputed = document.defaultView!.getComputedStyle(child);

		// Parent should have its set values (JSDOM normalizes colors to rgb())
		expect(parentComputed.getPropertyValue("color")).toBe("rgb(0, 0, 255)");
		expect(parentComputed.getPropertyValue("font-size")).toBe("16px");

		// Note: HappyDOM's computed styles might not fully implement inheritance
		// but we're testing that getComputedStyle works for both elements
		expect(childComputed).toBeDefined();
		expect(typeof childComputed.getPropertyValue).toBe("function");

		dom.dispose();
	});
});
