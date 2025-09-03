import {test, expect} from "bun:test";
import {JSDOM} from "jsdom";
import {resolvePropertyValue} from "../src/styles.js";

test("resolvePropertyValue basic functionality", () => {
	const jsdom = new JSDOM(`<div></div>`);
	const element = jsdom.window.document.querySelector("div")!;
	
	// Test default display value for div
	expect(resolvePropertyValue(element, "display")).toBe("block");
	
	// Test inline style
	(element as any).style.color = "red";
	expect(resolvePropertyValue(element, "color")).toBe("red");
});

test("CSS inheritance", () => {
	const jsdom = new JSDOM(`<div><span></span></div>`);
	const parent = jsdom.window.document.querySelector("div")!;
	const child = jsdom.window.document.querySelector("span")!;
	
	// Set color on parent
	(parent as any).style.color = "blue";
	
	// Child should inherit color
	expect(resolvePropertyValue(child, "color")).toBe("blue");
});

test("CSS keywords", () => {
	const jsdom = new JSDOM(`<div></div>`);
	const element = jsdom.window.document.querySelector("div")!;
	
	// Test initial keyword
	(element as any).style.display = "initial";
	expect(resolvePropertyValue(element, "display")).toBe("block");
});