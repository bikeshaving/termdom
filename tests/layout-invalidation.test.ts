import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("pseudo-elements render correctly after mutation observer fixes", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Create simple list
	const ul = document.createElement("ul");
	const li = document.createElement("li");
	li.textContent = "Item";

	ul.appendChild(li);
	document.body.appendChild(ul);

	await nextFrame(dom);

	// Wait for async writes to complete
	await new Promise((resolve) => setTimeout(resolve, 50));

	const output = terminal.getPlainText();

	// Should contain both marker and content
	expect(output).toContain("•");
	expect(output).toContain("Item");

	// Marker should appear before content
	const markerIndex = output.indexOf("•");
	const itemIndex = output.indexOf("Item");
	expect(markerIndex).toBeLessThan(itemIndex);

	dom.dispose();
});

test("multiple list items render correctly", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const ul = document.createElement("ul");

	const li1 = document.createElement("li");
	li1.textContent = "First";

	const li2 = document.createElement("li");
	li2.textContent = "Second";

	ul.appendChild(li1);
	ul.appendChild(li2);
	document.body.appendChild(ul);

	await nextFrame(dom);
	await new Promise((resolve) => setTimeout(resolve, 50));

	const output = terminal.getPlainText();

	// Should contain both items with markers
	expect(output).toContain("First");
	expect(output).toContain("Second");

	// Should have two bullet markers
	const bulletCount = (output.match(/•/g) || []).length;
	expect(bulletCount).toBe(2);

	dom.dispose();
});

test("a class change does not swallow later mutations in the same batch", async () => {
	// #handleMutationRecords returned from the whole function on an attributes or
	// characterData record instead of continuing to the next one, so a class flip
	// followed by a sibling's text change dropped the text change: the sibling's
	// new text node never entered the layout tree and the row rendered empty.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const header = document.createElement("div");
	header.textContent = "HEADER v1";
	const row = document.createElement("div");
	row.textContent = "row one";
	document.body.append(header, row);
	await nextFrame(dom);

	// The breaking order: attribute mutation first, then the text replacement.
	row.className = "selected";
	header.textContent = "HEADER v2";
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");
	expect(line(0)).toBe("HEADER v2");
	expect(line(1)).toBe("row one");

	dom.dispose();
});

test("appending many rows one at a time preserves document order", async () => {
	// LayoutEngine#getFlexIndex used to recompute a new node's position by
	// re-walking every earlier sibling from the start on every single append --
	// O(n) per append, O(n^2) for building a list of n rows this way. The fix
	// (a backward walk that reuses the nearest already-placed sibling's cached
	// position) has to produce the exact same order as the walk it replaced,
	// not just be fast -- this is the correctness half of that fix, covering
	// the sequential-build pattern real apps actually use (tree.ts's fill(),
	// any list built with a push loop).
	const terminal = new MockProcess({cols: 40, rows: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);
	for (let i = 0; i < 50; i++) {
		const row = document.createElement("div");
		row.textContent = `row ${i}`;
		container.appendChild(row);
	}
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");
	for (let i = 0; i < 50; i++) {
		expect(line(i)).toBe(`row ${i}`);
	}

	dom.dispose();
});

test("inserting a node in the middle of an already-laid-out list lands at the right position", async () => {
	// The backward-walk fast path only kicks in when it finds an already-placed
	// sibling nearby; insertBefore into the middle of an existing list -- the
	// case that fast path can't shortcut -- has to keep falling back to the
	// exact, full walk.
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const rows = ["a", "b", "d", "e"].map((label) => {
		const row = document.createElement("div");
		row.textContent = label;
		container.appendChild(row);
		return row;
	});
	await nextFrame(dom);

	const middle = document.createElement("div");
	middle.textContent = "c";
	container.insertBefore(middle, rows[2]); // between "b" and "d"
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");
	expect([line(0), line(1), line(2), line(3), line(4)]).toEqual([
		"a",
		"b",
		"c",
		"d",
		"e",
	]);

	dom.dispose();
});

test("bulk sequential appends no longer scale quadratically", async () => {
	// The regression this whole fix targets: appending N rows one at a time
	// into the same parent used to cost O(N) each (re-walking every earlier
	// sibling), O(N^2) total -- 8,000 rows measured at 44 SECONDS before the
	// fix. Not a tight timing assertion (that would be flaky under load); it
	// only has to rule out the quadratic blowup coming back, so the bound is
	// generous on purpose.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const start = performance.now();
	for (let i = 0; i < 4000; i++) {
		const row = document.createElement("div");
		row.textContent = `row ${i}`;
		container.appendChild(row);
	}
	await nextFrame(dom);
	const elapsed = performance.now() - start;

	// O(n^2) at this size took tens of seconds; O(n) takes well under a
	// second even on slow CI. 5s leaves generous headroom without letting a
	// quadratic regression pass unnoticed.
	expect(elapsed).toBeLessThan(5000);

	dom.dispose();
});
