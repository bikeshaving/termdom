import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

// The ratio counts cells: one cell is one cell, vertical or horizontal, so
// `aspect-ratio: 1` on a box 10 cells wide makes it 10 rows tall.

test("a definite width derives the height through the ratio", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const box = document.createElement("div");
	box.style.width = "12ch";
	box.style.setProperty("aspect-ratio", "3");
	document.body.appendChild(box);

	await nextFrame(dom);

	const rect = box.getBoundingClientRect();
	expect(rect.width).toBe(12);
	expect(rect.height).toBe(4);

	dom.dispose();
});

test("aspect-ratio: 1 makes a 10-cell-wide box 10 rows tall", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const box = document.createElement("div");
	box.style.width = "10ch";
	box.style.setProperty("aspect-ratio", "1");
	document.body.appendChild(box);

	await nextFrame(dom);

	const rect = box.getBoundingClientRect();
	expect(rect.width).toBe(10);
	expect(rect.height).toBe(10);

	dom.dispose();
});

test("a definite height derives the width through the ratio", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const box = document.createElement("div");
	box.style.height = "4px";
	box.style.setProperty("aspect-ratio", "2 / 1");
	document.body.appendChild(box);

	await nextFrame(dom);

	const rect = box.getBoundingClientRect();
	expect(rect.height).toBe(4);
	expect(rect.width).toBe(8);

	dom.dispose();
});

test("both axes definite: the ratio is ignored", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const box = document.createElement("div");
	box.style.width = "12ch";
	box.style.height = "3px";
	box.style.setProperty("aspect-ratio", "1");
	document.body.appendChild(box);

	await nextFrame(dom);

	const rect = box.getBoundingClientRect();
	expect(rect.width).toBe(12);
	expect(rect.height).toBe(3);

	dom.dispose();
});

test("min-height overrides the derived height", async () => {
	const terminal = new MockProcess({cols: 40, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const box = document.createElement("div");
	box.style.width = "6ch";
	box.style.setProperty("aspect-ratio", "1 / 2");
	box.style.minHeight = "20px";
	document.body.appendChild(box);

	await nextFrame(dom);

	const rect = box.getBoundingClientRect();
	expect(rect.width).toBe(6);
	expect(rect.height).toBe(20);

	dom.dispose();
});

test("max-height clamps the derived height", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const box = document.createElement("div");
	box.style.width = "10ch";
	box.style.setProperty("aspect-ratio", "1");
	box.style.maxHeight = "5px";
	document.body.appendChild(box);

	await nextFrame(dom);

	const rect = box.getBoundingClientRect();
	expect(rect.width).toBe(10);
	expect(rect.height).toBe(5);

	dom.dispose();
});

test("a flex item transfers its definite cross size to the main axis", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const row = document.createElement("div");
	row.style.display = "flex";
	row.style.flexDirection = "row";
	document.body.appendChild(row);

	const item = document.createElement("div");
	item.style.height = "4px";
	item.style.setProperty("aspect-ratio", "3 / 1");
	row.appendChild(item);

	const sibling = document.createElement("div");
	sibling.textContent = "x";
	row.appendChild(sibling);

	await nextFrame(dom);

	const rect = item.getBoundingClientRect();
	expect(rect.height).toBe(4);
	expect(rect.width).toBe(12);

	const siblingRect = sibling.getBoundingClientRect();
	expect(siblingRect.left).toBe(12);

	dom.dispose();
});

test("a flex item with a definite main size derives its cross size", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const row = document.createElement("div");
	row.style.display = "flex";
	row.style.flexDirection = "row";
	row.style.alignItems = "flex-start";
	document.body.appendChild(row);

	const item = document.createElement("div");
	item.style.width = "8ch";
	item.style.setProperty("aspect-ratio", "2 / 1");
	row.appendChild(item);

	await nextFrame(dom);

	const rect = item.getBoundingClientRect();
	expect(rect.width).toBe(8);
	expect(rect.height).toBe(4);

	dom.dispose();
});

test("aspect-ratio: auto leaves the box content-sized", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const box = document.createElement("div");
	box.style.width = "12ch";
	box.style.setProperty("aspect-ratio", "auto");
	box.textContent = "hello";
	document.body.appendChild(box);

	await nextFrame(dom);

	const rect = box.getBoundingClientRect();
	expect(rect.width).toBe(12);
	expect(rect.height).toBe(1);

	dom.dispose();
});

test("a zero or negative component behaves as auto", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const zero = document.createElement("div");
	zero.style.width = "12ch";
	zero.style.setProperty("aspect-ratio", "0");
	zero.textContent = "a";
	document.body.appendChild(zero);

	const negative = document.createElement("div");
	negative.style.width = "12ch";
	negative.style.setProperty("aspect-ratio", "3 / -1");
	negative.textContent = "b";
	document.body.appendChild(negative);

	await nextFrame(dom);

	expect(zero.getBoundingClientRect().height).toBe(1);
	expect(negative.getBoundingClientRect().height).toBe(1);

	dom.dispose();
});

test("an auto-width block fills its container and derives its height", async () => {
	const terminal = new MockProcess({cols: 20, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const box = document.createElement("div");
	box.style.setProperty("aspect-ratio", "4 / 1");
	document.body.appendChild(box);

	await nextFrame(dom);

	const rect = box.getBoundingClientRect();
	expect(rect.width).toBe(20);
	expect(rect.height).toBe(5);

	dom.dispose();
});
