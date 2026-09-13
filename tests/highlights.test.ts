/**
 * The CSS Custom Highlight API: the registry and its highlights, the cells
 * a `::highlight()` rule paints, how layers fold, and the repaints a
 * highlight mutation asks for.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess} from "./test-utils.js";

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
