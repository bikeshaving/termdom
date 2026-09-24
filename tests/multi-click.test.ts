/**
 * A double click selects the word under the pointer and a triple click the
 * paragraph, as the default action of mousedown. A drag after either
 * extends the selection a whole word or paragraph at a time.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

const press = (col: number, row: number): string => `\x1b[<0;${col};${row}M`;
const release = (col: number, row: number): string => `\x1b[<0;${col};${row}m`;
const drag = (col: number, row: number): string => `\x1b[<32;${col};${row}M`;

async function type(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function clicks(
	terminal: MockProcess,
	count: number,
	col: number,
	row: number,
): Promise<void> {
	for (let i = 0; i < count; i++) {
		await type(terminal, press(col, row));
		await type(terminal, release(col, row));
	}
}

async function page(
	html: string,
): Promise<{terminal: MockProcess; dom: TermDOM}> {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {terminal, dom};
}

test("a double click selects the word under the pointer", async () => {
	const {terminal, dom} = await page("<div>hello brave world</div>");
	await clicks(terminal, 2, 9, 1);
	expect(dom.window.getSelection()!.toString()).toBe("brave");
	await dom.dispose();
});

test("a triple click selects the paragraph", async () => {
	const {terminal, dom} =
		await page("<div>hello brave world</div><div>second line</div>");
	await clicks(terminal, 3, 9, 1);
	expect(dom.window.getSelection()!.toString()).toBe("hello brave world");
	await dom.dispose();
});

test("a double click past the end of a line selects its last word", async () => {
	const {terminal, dom} = await page("<div>hello world</div>");
	await clicks(terminal, 2, 30, 1);
	expect(dom.window.getSelection()!.toString()).toBe("world");
	await dom.dispose();
});

test("a drag after a double click extends a word at a time", async () => {
	const {terminal, dom} = await page("<div>one two three four</div>");
	await clicks(terminal, 1, 6, 1);
	await type(terminal, press(6, 1));
	await type(terminal, drag(10, 1));
	await type(terminal, release(10, 1));
	expect(dom.window.getSelection()!.toString()).toBe("two three");

	// Past the double-click interval, so the next click counts from one.
	await new Promise((resolve) => setTimeout(resolve, 600));
	await clicks(terminal, 1, 10, 1);
	await type(terminal, press(10, 1));
	await type(terminal, drag(2, 1));
	await type(terminal, release(2, 1));
	expect(dom.window.getSelection()!.toString()).toBe("one two three");
	await dom.dispose();
});

test("a drag after a triple click extends a paragraph at a time", async () => {
	const {terminal, dom} = await page(
		"<div>first line here</div><div>second line</div><div>third</div>",
	);
	await clicks(terminal, 2, 3, 1);
	await type(terminal, press(3, 1));
	await type(terminal, drag(3, 2));
	await type(terminal, release(3, 2));
	expect(dom.window.getSelection()!.toString()).toBe(
		"first line here\nsecond line",
	);
	await dom.dispose();
});

test("a canceled mousedown selects nothing", async () => {
	const {terminal, dom} = await page("<div>hello brave world</div>");
	dom.document.addEventListener("mousedown", (event) => event.preventDefault());
	await clicks(terminal, 2, 9, 1);
	expect(dom.window.getSelection()!.toString()).toBe("");
	await dom.dispose();
});

test("user-select: none text takes no word", async () => {
	const {terminal, dom} =
		await page("<div style=\"user-select: none\">hello brave world</div>");
	await clicks(terminal, 2, 9, 1);
	expect(dom.window.getSelection()!.toString()).toBe("");
	await dom.dispose();
});

test("in a textarea, a double click selects a word and a triple click a line", async () => {
	const {terminal, dom} = await page(
		"<textarea style=\"border: none; padding: 0; width: 30ch; height: 3px\">alpha beta\ngamma delta</textarea>",
	);
	const area = dom.document.querySelector("textarea")!;
	await clicks(terminal, 2, 8, 1);
	expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe("beta");
	await new Promise((resolve) => setTimeout(resolve, 600));
	await clicks(terminal, 3, 3, 2);
	expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe(
		"gamma delta",
	);
	await dom.dispose();
});

test("in an input, a triple click selects the whole value", async () => {
	const {terminal, dom} =
		await page("<input value=\"alpha beta gamma\" style=\"width: 30ch\">");
	const input = dom.document.querySelector("input")!;
	await clicks(terminal, 2, 8, 1);
	expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe(
		"beta",
	);
	await clicks(terminal, 1, 8, 1);
	expect(input.selectionStart).toBe(0);
	expect(input.selectionEnd).toBe(input.value.length);
	await dom.dispose();
});

test("in a password field, a double click selects the whole value", async () => {
	const {terminal, dom} = await page(
		"<input type=\"password\" value=\"two words\" style=\"width: 30ch\">",
	);
	const input = dom.document.querySelector("input")!;
	await clicks(terminal, 2, 2, 1);
	expect(input.selectionStart).toBe(0);
	expect(input.selectionEnd).toBe(input.value.length);
	await dom.dispose();
});

test("a second press on another cell is a new click, not a double click", async () => {
	const {terminal, dom} = await page("<div>hello brave world</div>");
	const counts: number[] = [];
	dom.document.addEventListener("mousedown", (event) =>
		counts.push(event.detail),
	);
	await clicks(terminal, 1, 2, 1);
	await clicks(terminal, 1, 9, 1);
	expect(counts).toEqual([1, 1]);
	expect(dom.window.getSelection()!.toString()).toBe("");
	await dom.dispose();
});
