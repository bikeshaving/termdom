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

test("scrolling a long list paints the correct visible rows at every offset", async () => {
	// #renderElement's child-gathering has a fast path that binary-searches
	// straight to the visible range (LayoutEngine#visibleChildrenInBand)
	// instead of walking every sibling to rule it out -- this is the
	// correctness half of that: the camera moving mid-list has to land on
	// exactly the rows in view, not an off-by-one range from a binary search
	// edge case, at the top, the middle, and the bottom of the list.
	const terminal = new MockProcess({cols: 20, rows: 5});
	const dom = new TermDOM({process: terminal});
	const {document, window} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);
	for (let i = 0; i < 100; i++) {
		const row = document.createElement("div");
		row.textContent = `row${i}`;
		container.appendChild(row);
	}
	await nextFrame(dom);

	const visibleRows = (): string[] =>
		terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);

	expect(visibleRows()).toEqual(["row0", "row1", "row2", "row3", "row4"]);

	window.scrollBy(0, 47);
	await nextFrame(dom);
	expect(visibleRows()).toEqual(["row47", "row48", "row49", "row50", "row51"]);

	window.scrollBy(0, 1000); // clamps to the bottom
	await nextFrame(dom);
	expect(visibleRows()).toEqual(["row95", "row96", "row97", "row98", "row99"]);

	dom.dispose();
});

test("an absolutely positioned overlay among many siblings still paints, scrolled or not", async () => {
	// visibleChildrenInBand refuses the fast path (falls back to the exact
	// walk) whenever a container has any position:relative/absolute child,
	// since such a child's extent can land anywhere regardless of DOM order
	// -- a binary search assuming top-to-bottom order would silently miss it.
	// This is the fallback path actually getting exercised end-to-end, not
	// just declining to run.
	const terminal = new MockProcess({cols: 20, rows: 5});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);
	for (let i = 0; i < 20; i++) {
		const row = document.createElement("div");
		row.textContent = `row${i}`;
		container.appendChild(row);
	}
	const overlay = document.createElement("div");
	overlay.style.position = "absolute";
	overlay.style.top = "1";
	overlay.style.left = "0";
	overlay.textContent = "OVERLAY";
	container.appendChild(overlay);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("OVERLAY");

	dom.dispose();
});

test("a display:none sibling among visible ones does not break which rows paint", async () => {
	// display:none is skipped by flow layout entirely, so its cached extent
	// doesn't reflect its place in document order -- unlike a merely
	// zero-height visible box, which is still correctly slotted. A binary
	// search that didn't know to disqualify it could jump to the wrong start
	// index using its degenerate extent as a pivot.
	const terminal = new MockProcess({cols: 20, rows: 5});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const visible1 = document.createElement("div");
	visible1.textContent = "first";
	container.appendChild(visible1);
	const hidden = document.createElement("div");
	hidden.style.display = "none";
	hidden.textContent = "hidden";
	container.appendChild(hidden);
	const visible2 = document.createElement("div");
	visible2.textContent = "second";
	container.appendChild(visible2);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("first");
	expect(output).toContain("second");
	expect(output).not.toContain("hidden");

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

test(
	"wheel-scrolling a long, already-built list stays fast regardless of its length",
	async () => {
		// The other half of the wheel-stutter report this fix targets: once a
		// list is built, repainting it after a pure camera move (no DOM mutation)
		// used to cost O(total rows) every frame -- the walk-based child-gathering
		// had to visit every sibling just to rule most of them out, so a longer
		// list made every subsequent frame slower even though only ~5 rows were
		// ever visible. The fast path (LayoutEngine#visibleChildrenInBand)
		// binary-searches straight to the visible range instead. A generous
		// per-frame bound here only needs to catch that O(total rows)-per-frame
		// cost coming back, not pin an exact number.
		const terminal = new MockProcess({cols: 20, rows: 5});
		const dom = new TermDOM({process: terminal});
		const {document} = dom;

		const container = document.createElement("div");
		document.body.appendChild(container);
		for (let i = 0; i < 8000; i++) {
			const row = document.createElement("div");
			row.textContent = `row${i}`;
			container.appendChild(row);
		}
		await nextFrame(dom);

		const start = performance.now();
		for (let i = 0; i < 30; i++) {
			(terminal.stdin as any).emit("data", Buffer.from("\x1b[<65;5;3M")); // wheel down
			await nextFrame(dom);
		}
		const elapsed = performance.now() - start;

		expect(elapsed / 30).toBeLessThan(50); // O(visible) is ~5ms/frame; O(total) would be seconds

		dom.dispose();
	},
	{timeout: 20000},
);
