/**
 * Tests that deeply nested markup renders instead of overflowing the stack
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils";

function depthOf(node: Node): number {
	let depth = 0;
	for (let n: Node | null = node; n !== null; n = n.parentNode) {
		depth++;
	}
	return depth;
}

test("the html option caps parser depth and renders", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({
		html: "<div>".repeat(16000) + "deep",
		transport: terminal.transport,
	});
	await nextFrame(dom);
	const divs = dom.document.querySelectorAll("div");
	expect(divs.length).toBe(16000);
	expect(Math.max(...Array.from(divs, depthOf))).toBeLessThanOrEqual(520);
});

test("innerHTML past the parser depth cap renders", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({html: "<p>top</p>", transport: terminal.transport});
	await nextFrame(dom);
	dom.document.body.innerHTML = "<div>".repeat(10000) + "deep";
	await nextFrame(dom);
	expect(dom.document.querySelectorAll("div").length).toBe(10000);
});

test("list and table nesting render", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({
		html: "<ul><li>".repeat(5000) + "x",
		transport: terminal.transport,
	});
	await nextFrame(dom);
	dom.document.body.innerHTML = "<table><tr><td>".repeat(5000) + "x";
	await nextFrame(dom);
	expect(dom.document.querySelectorAll("td").length).toBeGreaterThan(0);
});

test("DOMParser caps depth", () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const parsed = new dom.window.DOMParser().parseFromString(
		"<div>".repeat(5000),
		"text/html",
	);
	const divs = parsed.querySelectorAll("div");
	expect(divs.length).toBe(5000);
	expect(Math.max(...Array.from(divs, depthOf))).toBeLessThanOrEqual(520);
});
