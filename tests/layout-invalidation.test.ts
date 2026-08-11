import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("pseudo-elements render correctly after mutation observer fixes", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
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
	const dom = new TermDOM({transport: terminal.transport});
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
	overlay.style.top = "1px";
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
	const dom = new TermDOM({transport: terminal.transport});
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

test("a class flip is scoped: a sibling-combinator rule still reaches the sibling", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// The sibling combinator is what forces the invalidation scope past the
	// flipped element's own subtree -- if the scope stayed at the element,
	// the sibling would keep its old display.
	const style = document.createElement("style");
	style.textContent = `.on ~ .light { display: none; }`;
	document.head.appendChild(style);
	document.body.innerHTML = `<div id="switch">switch</div><div class="light">light</div>`;
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("light");

	document.getElementById("switch")!.className = "on";
	await nextFrame(dom);
	expect(terminal.getPlainText()).not.toContain("light");

	document.getElementById("switch")!.className = "";
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("light");

	dom.dispose();
});

test("a no-op class flip on a block inside an inline repaints identically", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// A block in an inline breaks the span into fragments owned by the
	// nearest block container; a scoped invalidation must rebuild from that
	// container (found by the markup fuzzer: the div's content vanished).
	document.body.innerHTML = `<span><p>head</p> <div id="mid">middle</div></span> tail`;
	await nextFrame(dom);
	const before = terminal.getPlainText();
	expect(before).toContain("middle");

	const mid = document.getElementById("mid")!;
	mid.className = "flip";
	await nextFrame(dom);
	mid.className = "";
	await nextFrame(dom);
	expect(terminal.getPlainText()).toEqual(before);

	dom.dispose();
});

test("a run's first node turning block-level takes a box of its own", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// The span opens the paragraph's only anonymous box. Flipping its display
	// moves it out of that box and into one of its own, which only the
	// container's box list knows about -- the style record names the span.
	document.body.innerHTML = `<p><span id="s">head</span> tail</p>`;
	await nextFrame(dom);
	const lines = () =>
		terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.trimEnd())
			.filter(Boolean);
	expect(lines()).toEqual(["head tail"]);

	const span = document.getElementById("s")!;
	span.style.display = "block";
	await nextFrame(dom);
	expect(lines()).toEqual(["head", " tail"]);

	span.style.display = "none";
	await nextFrame(dom);
	expect(lines()).toEqual([" tail"]);

	span.style.display = "inline";
	await nextFrame(dom);
	expect(lines()).toEqual(["head tail"]);

	dom.dispose();
});

test("a class flip reaches the descendants its selectors reach", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Three ways a flip on the row can reach the label below it: a rule that
	// names the class on an ancestor, a property the label inherits, and a
	// sibling combinator. A flip that reaches none of them still has to leave
	// the label exactly as it was.
	document.body.innerHTML =
		`<style>` +
		`.editing .view { display: none; }` +
		`.dim { color: red; }` +
		`.open ~ .note { display: none; }` +
		`.boxed { background: blue; padding-left: 1px; }` +
		`</style>` +
		`<div id="row"><span class="view">label</span></div>` +
		`<div class="note">note</div>`;
	await nextFrame(dom);
	const row = document.getElementById("row")!;
	const label = document.querySelector(".view") as HTMLElement;
	const plain = () => terminal.getPlainText().replace(/\s+/g, " ").trim();

	expect(plain()).toContain("label");

	// Reached by an ancestor-combinator rule.
	row.classList.add("editing");
	await nextFrame(dom);
	expect(plain()).not.toContain("label");
	row.classList.remove("editing");
	await nextFrame(dom);
	expect(plain()).toContain("label");

	// Reached by inheritance: the rule names the row, the colour is the
	// label's too.
	row.classList.add("dim");
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(label).color).toBe("rgb(255, 0, 0)");
	row.classList.remove("dim");
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(label).color).not.toBe("rgb(255, 0, 0)");

	// Reaching nothing: `.boxed` declares only what a box keeps to itself, and
	// names no descendant, so the label's own style is left standing -- which
	// it must still be, exactly.
	const labelColor = dom.window.getComputedStyle(label).color;
	row.classList.add("boxed");
	await nextFrame(dom);
	expect(plain()).toContain("label");
	expect(dom.window.getComputedStyle(label).color).toBe(labelColor);
	expect(dom.window.getComputedStyle(label).display).toBe("inline");

	// Reached sideways.
	expect(plain()).toContain("note");
	row.classList.add("open");
	await nextFrame(dom);
	expect(plain()).not.toContain("note");

	dom.dispose();
});

test("a style that changes what descendants inherit re-measures them", async () => {
	// A run remembers the size it answered with, and re-answers only when its
	// constraints move. What it INHERITS moves neither: the same run at the
	// same width measures differently once its white space stops collapsing,
	// and nothing about the offer says so.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		`<style>.pre { white-space: pre; }</style>` +
		`<span id="s"><em style="display: flex"><span>   x   </span></em></span>`;
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");
	expect(line()).toBe(" x");

	document.getElementById("s")!.classList.add("pre");
	await nextFrame(dom);
	expect(line()).toBe("   x");

	// And an inline style says the same thing.
	document.getElementById("s")!.classList.remove("pre");
	await nextFrame(dom);
	expect(line()).toBe(" x");
	document.getElementById("s")!.setAttribute("style", "white-space: pre");
	await nextFrame(dom);
	expect(line()).toBe("   x");

	dom.dispose();
});

test("a block arriving under a box that measures as a unit rebuilds it", async () => {
	// An inline-block measuring its content as a run and one establishing a
	// block container are different KINDS of box. Clearing the measure leaves
	// the old kind in place, holding a tree that cannot lay the newcomer out.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `<span style="display: inline-block" id="s">A</span>B`;
	await nextFrame(dom);
	const lines = () =>
		terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""));
	expect(lines()[0]).toBe("AB");

	const block = document.createElement("div");
	block.textContent = "N";
	const host = document.getElementById("s")!;
	host.insertBefore(block, host.firstChild);
	await nextFrame(dom);
	expect(lines().slice(0, 2)).toEqual(["NB", "A"]);

	dom.dispose();
});

test("a block added inside a display: contents element keeps its siblings", async () => {
	// The element generates no box, so what arrives inside it is a box of the
	// CONTAINER -- and so is the text already dissolved alongside it, which the
	// arrival splits away from.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `<style>.c { display: contents; }</style>AB<p class="c" id="s">C</p>`;
	await nextFrame(dom);
	const lines = () =>
		terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""));
	expect(lines()[0]).toBe("ABC");

	const block = document.createElement("div");
	block.textContent = "N";
	const host = document.getElementById("s")!;
	host.insertBefore(block, host.firstChild);
	await nextFrame(dom);
	expect(lines().slice(0, 3)).toEqual(["AB", "N", "C"]);

	dom.dispose();
});
