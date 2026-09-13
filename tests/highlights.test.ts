/**
 * The CSS Custom Highlight API: the registry and its highlights, the cells
 * a `::highlight()` rule paints, how layers fold, and the repaints a
 * highlight mutation asks for.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

function highlightDOM(options: {rows?: number; cols?: number} = {}): {
	terminal: MockProcess;
	dom: TermDOM;
	window: any;
} {
	const terminal = new MockProcess({
		rows: options.rows ?? 4,
		cols: options.cols ?? 40,
	});
	const dom = new TermDOM({transport: terminal.transport});
	return {terminal, dom, window: dom.window as any};
}

/** The columns of a row painted on a yellow background. */
function yellowCells(terminal: MockProcess, row: number): number[] {
	const line = (terminal as any).terminal.buffer.active.getLine(row);
	const columns: number[] = [];
	for (let col = 0; col < line.length; col++) {
		const cell = line.getCell(col);
		if (cell.isBgRGB() && cell.getBgColor() === 0xffff00) {
			columns.push(col);
		}
	}
	return columns;
}

test("CSS.highlights is a registry, and Highlight constructs from ranges", () => {
	const {dom, window} = highlightDOM();
	const {document} = dom;
	document.body.textContent = "one two";
	const text = document.body.firstChild!;

	expect(window.CSS.highlights).toBeInstanceOf(window.HighlightRegistry);
	expect(String(window.CSS.highlights)).toBe("[object HighlightRegistry]");

	const first = document.createRange();
	first.setStart(text, 0);
	first.setEnd(text, 3);
	const second = document.createRange();
	second.setStart(text, 4);
	second.setEnd(text, 7);

	const highlight = new window.Highlight(first, second);
	expect(String(highlight)).toBe("[object Highlight]");
	expect(highlight.priority).toBe(0);
	expect(highlight.type).toBe("highlight");
	expect(highlight.size).toBe(2);
	expect(highlight.has(first)).toBe(true);
	expect([...highlight]).toEqual([first, second]);

	const seen: unknown[] = [];
	highlight.forEach((value: unknown, key: unknown, parent: unknown) => {
		seen.push(value);
		expect(key).toBe(value);
		expect(parent).toBe(highlight);
	});
	expect(seen).toEqual([first, second]);

	expect(highlight.delete(first)).toBe(true);
	expect(highlight.delete(first)).toBe(false);
	expect(highlight.size).toBe(1);
	highlight.clear();
	expect(highlight.size).toBe(0);

	// A highlight takes ranges, and its type is an enumeration.
	expect(() => highlight.add({} as never)).toThrow(TypeError);
	expect(() => {
		highlight.type = "underline";
	}).toThrow(TypeError);
	highlight.type = "spelling-error";
	expect(highlight.type).toBe("spelling-error");
	highlight.priority = 2.7;
	expect(highlight.priority).toBe(2);

	dom.dispose();
});

test("the registry is a map, and re-registering a name moves it last", () => {
	const {dom, window} = highlightDOM();
	const registry = window.CSS.highlights;
	const first = new window.Highlight();
	const second = new window.Highlight();

	expect(registry.set("first", first)).toBe(registry);
	registry.set("second", second);
	expect(registry.size).toBe(2);
	expect(registry.get("first")).toBe(first);
	expect(registry.has("second")).toBe(true);
	expect([...registry.keys()]).toEqual(["first", "second"]);
	expect([...registry]).toEqual([["first", first], ["second", second]]);

	// Registration order is paint order, so setting a name again registers
	// it afresh, at the end.
	registry.set("first", first);
	expect([...registry.keys()]).toEqual(["second", "first"]);

	const names: string[] = [];
	registry.forEach((value: unknown, key: string, parent: unknown) => {
		names.push(key);
		expect(parent).toBe(registry);
	});
	expect(names).toEqual(["second", "first"]);

	expect(registry.delete("second")).toBe(true);
	expect(registry.delete("second")).toBe(false);
	expect(registry.size).toBe(1);
	registry.clear();
	expect(registry.size).toBe(0);
	expect(() => registry.set("bad", {} as never)).toThrow(TypeError);
	expect(() => new window.HighlightRegistry()).toThrow(TypeError);

	dom.dispose();
});

test("a styled highlight paints its cells, and an unstyled name paints none", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>::highlight(hit) { background-color: yellow }</style>";
	document.body.innerHTML = "<p>find the word here</p>";
	const text = document.querySelector("p")!.firstChild!;

	const range = document.createRange();
	range.setStart(text, 5);
	range.setEnd(text, 8);
	window.CSS.highlights.set("hit", new window.Highlight(range));
	// A name no rule styles has no user-agent style to fall back on.
	const unstyled = document.createRange();
	unstyled.setStart(text, 9);
	unstyled.setEnd(text, 13);
	window.CSS.highlights.set("miss", new window.Highlight(unstyled));
	await nextFrame(dom);

	expect(yellowCells(terminal, 0)).toEqual([5, 6, 7]);

	dom.dispose();
});

test("a highlight spanning two text nodes paints both", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>::highlight(hit) { background-color: yellow }</style>";
	document.body.innerHTML = "<p><span>abcd</span><span>efgh</span></p>";
	const [first, second] = Array.from(document.querySelectorAll("span"));

	const range = document.createRange();
	range.setStart(first.firstChild!, 2);
	range.setEnd(second.firstChild!, 2);
	window.CSS.highlights.set("hit", new window.Highlight(range));
	await nextFrame(dom);

	expect(yellowCells(terminal, 0)).toEqual([2, 3, 4, 5]);

	dom.dispose();
});
