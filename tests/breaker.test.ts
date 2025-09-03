import {test, expect} from "bun:test";
import {breakNodes, type Leaf} from "../src/breaker.js";
import {JSDOM} from "jsdom";

test("simple text breaking", () => {
	const jsdom = new JSDOM();
	const textNode = jsdom.window.document.createTextNode("hello world");
	
	const leaves: Leaf[] = [{
		type: "text",
		node: textNode,
		content: "hello world"
	}];
	
	const result = breakNodes(leaves, {maxWidth: 5});
	expect(result.lines.length).toBeGreaterThanOrEqual(2);
	expect(result.lines[0].segments.length).toBeGreaterThan(0);
});

test("nowrap behavior", () => {
	const jsdom = new JSDOM();
	const textNode = jsdom.window.document.createTextNode("very long text");
	
	const leaves: Leaf[] = [{
		type: "text",
		node: textNode,
		content: "very long text"
	}];
	
	const result = breakNodes(leaves, {maxWidth: 5, whiteSpace: "nowrap"});
	expect(result.lines.length).toBe(1);
	expect(result.maxLineWidth).toBeGreaterThan(5);
});