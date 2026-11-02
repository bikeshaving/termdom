import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

async function open(html: string, cols = 40, rows = 6): Promise<TermDOM> {
	const dom = new TermDOM({transport: new MockProcess({cols, rows}).transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return dom;
}

test("caretPositionFromPoint finds the text offset under a point", async () => {
	const dom = await open("<p>hello world</p><p>second</p>");
	const {document} = dom;
	const text = document.querySelector("p")!.firstChild!;
	const position = document.caretPositionFromPoint(3, 0)!;
	expect(position).toBeInstanceOf(dom.window.CaretPosition);
	expect(position.offsetNode).toBe(text);
	expect(position.offset).toBe(3);
	const rect = position.getClientRect()!;
	expect([rect.x, rect.y]).toEqual([3, 0]);
	const range = document.caretRangeFromPoint(7, 0)!;
	expect(range.collapsed).toBe(true);
	expect(range.startContainer).toBe(text);
	expect(range.startOffset).toBe(7);
	dom.dispose();
});

test("caretPositionFromPoint is null off the viewport", async () => {
	const dom = await open("<p>hello</p>");
	const {document} = dom;
	expect(document.caretPositionFromPoint(-1, 0)).toBe(null);
	expect(document.caretPositionFromPoint(0, 100)).toBe(null);
	expect(document.caretRangeFromPoint(100, 0)).toBe(null);
	expect(() => document.caretPositionFromPoint(NaN, 0)).toThrow(TypeError);
	dom.dispose();
});

test("caretPositionFromPoint leaves a shadow tree not passed in", async () => {
	const dom = await open("<p>light</p><div id=host></div>");
	const {document} = dom;
	const host = document.getElementById("host")!;
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = "<span>shadow</span>";
	await nextFrame(dom);
	const outside = document.caretPositionFromPoint(2, 1)!;
	expect(outside.offsetNode).toBe(document.body);
	expect(outside.offset).toBe(1);
	const inside = document.caretPositionFromPoint(2, 1, {shadowRoots: [root]})!;
	expect(inside.offsetNode).toBe(root.querySelector("span")!.firstChild);
	expect(inside.offset).toBe(2);
	const range = document.caretRangeFromPoint(2, 1)!;
	expect([range.startContainer, range.startOffset]).toEqual([document.body, 1]);
	expect(() =>
		document.caretPositionFromPoint(0, 0, {shadowRoots: [host as never]}),
	).toThrow(TypeError);
	dom.dispose();
});

test("caretPositionFromPoint over a text control gives the value offset", async () => {
	const dom = await open("<input value=abcdef>");
	const {document} = dom;
	const input = document.querySelector("input")!;
	const left = input.getBoundingClientRect().left;
	const position = document.caretPositionFromPoint(left + 3, 0)!;
	expect(position.offsetNode).toBe(input);
	expect(position.offset).toBe(3);
	const range = document.caretRangeFromPoint(left + 3, 0)!;
	expect([range.startContainer, range.startOffset]).toEqual([document.body, 0]);
	dom.dispose();
});

test("CaretPosition cannot be constructed by script", async () => {
	const dom = await open("");
	expect(() => new (dom.window.CaretPosition as any)()).toThrow(TypeError);
	dom.dispose();
});
