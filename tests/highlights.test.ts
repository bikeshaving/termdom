/**
 * The CSS Custom Highlight API: the registry and its highlights, the cells
 * a `::highlight()` rule paints, how layers fold, and the repaints a
 * highlight mutation asks for.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

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

/** The cell the terminal painted at a row and column. */
function cellAt(terminal: MockProcess, row: number, col: number): any {
	return (terminal as any).terminal.buffer.active.getLine(row).getCell(col);
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

	// A highlight takes ranges, and its type is an enumeration: a value
	// outside it leaves the type alone.
	expect(() => highlight.add({} as never)).toThrow(TypeError);
	highlight.type = "spelling-error";
	expect(highlight.type).toBe("spelling-error");
	highlight.type = "underline";
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

test("priority, then registration order, decides which layer wins", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>" +
		"::highlight(low) { background-color: yellow; color: red }" +
		"::highlight(high) { background-color: blue }" +
		"::highlight(late) { background-color: lime }" +
		"</style>";
	document.body.innerHTML = "<p>abcdefgh</p>";
	const text = document.querySelector("p")!.firstChild!;

	const whole = document.createRange();
	whole.setStart(text, 0);
	whole.setEnd(text, 8);
	const half = document.createRange();
	half.setStart(text, 4);
	half.setEnd(text, 8);

	const low = new window.Highlight(whole);
	const high = new window.Highlight(half);
	high.priority = 1;
	window.CSS.highlights.set("low", low);
	window.CSS.highlights.set("high", high);
	await nextFrame(dom);

	// The higher priority wins where the two overlap, and only there.
	expect(yellowCells(terminal, 0)).toEqual([0, 1, 2, 3]);
	expect(cellAt(terminal, 0, 5).getBgColor()).toBe(0x0000ff);
	// It set no color, so the layer below it still supplies one.
	expect(cellAt(terminal, 0, 5).getFgColor()).toBe(0xff0000);

	dom.dispose();
});

test("a concrete background over a system-color layer is not inverted", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>" +
		"::highlight(system) { background-color: Highlight }" +
		"::highlight(own) { background-color: yellow; color: black }" +
		"</style>";
	document.body.innerHTML = "<p>abcdefgh</p>";
	const text = document.querySelector("p")!.firstChild!;

	const whole = document.createRange();
	whole.setStart(text, 0);
	whole.setEnd(text, 8);
	const half = document.createRange();
	half.setStart(text, 4);
	half.setEnd(text, 8);

	const own = new window.Highlight(half);
	own.priority = 1;
	window.CSS.highlights.set("system", new window.Highlight(whole));
	window.CSS.highlights.set("own", own);
	await nextFrame(dom);

	// The system color alone is the terminal's inverse video.
	expect(cellAt(terminal, 0, 1).isInverse()).toBeTruthy();
	// Under a layer with colors of its own, that inverse would swap them.
	expect(cellAt(terminal, 0, 5).isInverse()).toBeFalsy();
	expect(yellowCells(terminal, 0)).toEqual([4, 5, 6, 7]);

	dom.dispose();
});

test("equal priority is broken by registration order", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>" +
		"::highlight(early) { background-color: yellow }" +
		"::highlight(late) { background-color: lime }" +
		"</style>";
	document.body.innerHTML = "<p>abcdefgh</p>";
	const text = document.querySelector("p")!.firstChild!;

	const range = document.createRange();
	range.setStart(text, 0);
	range.setEnd(text, 4);
	// Both at the default priority, so the name registered last wins.
	window.CSS.highlights.set("early", new window.Highlight(range));
	window.CSS.highlights.set("late", new window.Highlight(range));
	await nextFrame(dom);

	expect(yellowCells(terminal, 0)).toEqual([]);
	expect(cellAt(terminal, 0, 0).getBgColor()).toBe(0x00ff00);

	dom.dispose();
});

test("::selection folds over a highlight covering the same cells", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>" +
		"::highlight(hit) { background-color: yellow }" +
		"::selection { background-color: blue }" +
		"</style>";
	document.body.innerHTML = "<p>abcdefgh</p>";
	const text = document.querySelector("p")!.firstChild!;

	const whole = document.createRange();
	whole.setStart(text, 0);
	whole.setEnd(text, 8);
	const highlight = new window.Highlight(whole);
	// However high the highlight's priority, a built-in pseudo paints over
	// it.
	highlight.priority = 99;
	window.CSS.highlights.set("hit", highlight);

	const selected = document.createRange();
	selected.setStart(text, 4);
	selected.setEnd(text, 8);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(selected);
	await nextFrame(dom);

	expect(yellowCells(terminal, 0)).toEqual([0, 1, 2, 3]);
	expect(cellAt(terminal, 0, 5).getBgColor()).toBe(0x0000ff);

	dom.dispose();
});

test("text-decoration-line: underline in a highlight rule underlines", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>::highlight(hit) { text-decoration-line: underline }</style>";
	document.body.innerHTML = "<p>abcdefgh</p>";
	const text = document.querySelector("p")!.firstChild!;

	const range = document.createRange();
	range.setStart(text, 2);
	range.setEnd(text, 5);
	window.CSS.highlights.set("hit", new window.Highlight(range));
	await nextFrame(dom);

	expect(cellAt(terminal, 0, 1).isUnderline()).toBeFalsy();
	expect(cellAt(terminal, 0, 2).isUnderline()).toBeTruthy();
	expect(cellAt(terminal, 0, 4).isUnderline()).toBeTruthy();
	expect(cellAt(terminal, 0, 5).isUnderline()).toBeFalsy();

	dom.dispose();
});

test("a highlight mutation repaints without a DOM mutation", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>::highlight(hit) { background-color: yellow }</style>";
	document.body.innerHTML = "<p>abcdefgh</p>";
	const text = document.querySelector("p")!.firstChild!;

	const first = document.createRange();
	first.setStart(text, 0);
	first.setEnd(text, 2);
	const second = document.createRange();
	second.setStart(text, 4);
	second.setEnd(text, 6);
	const highlight = new window.Highlight(first);
	const other = new window.Highlight(second);
	window.CSS.highlights.set("hit", highlight);
	await nextFrame(dom);
	expect(yellowCells(terminal, 0)).toEqual([0, 1]);

	// Adding a range.
	highlight.add(second);
	await nextFrame(dom);
	expect(yellowCells(terminal, 0)).toEqual([0, 1, 4, 5]);

	// Removing one.
	highlight.delete(first);
	await nextFrame(dom);
	expect(yellowCells(terminal, 0)).toEqual([4, 5]);

	// Moving one.
	second.setEnd(text, 7);
	await nextFrame(dom);
	expect(yellowCells(terminal, 0)).toEqual([4, 5, 6]);

	// A change of priority, where the layer below is a different color.
	document.head.innerHTML +=
		"<style>::highlight(other) { background-color: lime }</style>";
	window.CSS.highlights.set("other", other);
	await nextFrame(dom);
	expect(cellAt(terminal, 0, 4).getBgColor()).toBe(0x00ff00);
	highlight.priority = 1;
	await nextFrame(dom);
	expect(cellAt(terminal, 0, 4).getBgColor()).toBe(0xffff00);

	// And dropping the name.
	window.CSS.highlights.delete("hit");
	window.CSS.highlights.delete("other");
	await nextFrame(dom);
	expect(yellowCells(terminal, 0)).toEqual([]);

	dom.dispose();
});

test("an invalid static range is skipped, and a live range follows the tree", async () => {
	const {terminal, dom, window} = highlightDOM();
	const {document} = dom;
	document.head.innerHTML =
		"<style>::highlight(hit) { background-color: yellow }</style>";
	document.body.innerHTML = "<p><span>gone</span><span>here</span></p>";
	const [first, second] = Array.from(document.querySelectorAll("span"));

	const stale = new window.StaticRange({
		startContainer: first.firstChild!,
		startOffset: 0,
		endContainer: first.firstChild!,
		endOffset: 4,
	});
	const live = document.createRange();
	live.setStart(second.firstChild!, 0);
	live.setEnd(second.firstChild!, 4);
	window.CSS.highlights.set("hit", new window.Highlight(stale, live));
	await nextFrame(dom);
	expect(yellowCells(terminal, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

	// The static range's node leaves the tree, so it describes nothing and
	// paints nothing. The live range's points follow the text inserted
	// before it.
	first.remove();
	const inserted = document.createElement("span");
	inserted.textContent = "XY";
	second.parentElement!.insertBefore(inserted, second);
	await nextFrame(dom);
	expect(yellowCells(terminal, 0)).toEqual([2, 3, 4, 5]);

	dom.dispose();
});

test("a non-empty highlight refuses the scroll transform", async () => {
	const {terminal, dom, window} = highlightDOM({rows: 8, cols: 20});
	const {document} = dom;
	document.head.innerHTML =
		"<style>::highlight(hit) { background-color: yellow }</style>";
	document.body.innerHTML =
		"<div id=\"pane\" style=\"height:6em;overflow-y:scroll\">" +
		Array.from({length: 20}, (_, i) => `<div>row ${i}</div>`).join("") +
		"</div>";
	await nextFrame(dom);

	// The transform is a DECSTBM band and an in-terminal line delete.
	const band = /\x1b\[\d+;\d+r/;
	const raw = captureRawOutput(terminal);
	document.getElementById("pane")!.scrollTop = 2;
	await nextFrame(dom);
	expect(raw()).toMatch(band);

	const text = document.querySelector("#pane div")!.firstChild!;
	const range = document.createRange();
	range.setStart(text, 0);
	range.setEnd(text, 3);
	window.CSS.highlights.set("hit", new window.Highlight(range));
	await nextFrame(dom);

	const rawAgain = captureRawOutput(terminal);
	document.getElementById("pane")!.scrollTop = 4;
	await nextFrame(dom);
	expect(rawAgain()).not.toMatch(band);

	dom.dispose();
});
