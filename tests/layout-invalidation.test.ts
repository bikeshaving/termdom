import {expect, test} from "@b9g/libuild/test";

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
	// Every record in a batch is restaged, whatever kind it is: a class flip
	// followed by a sibling's text change must leave both the flipped row and
	// the retexted one correct, not drop the second because the first was
	// handled.
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
	// A box is appended to its container's layout children as it is built, and
	// its position among them is settled afterwards from the container's box
	// list. Fifty rows pushed one at a time -- the sequential-build pattern
	// real apps use (tree.ts's fill(), any list built with a push loop) -- must
	// come out in document order.
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
	// straight to the visible range (Layout#getVisibleChildren)
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
	// getVisibleChildren refuses the fast path (falls back to the exact
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
	style.textContent = ".on ~ .light { display: none; }";
	document.head.appendChild(style);
	document.body.innerHTML = "<div id=\"switch\">switch</div><div class=\"light\">light</div>";
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
	document.body.innerHTML = "<span><p>head</p> <div id=\"mid\">middle</div></span> tail";
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
	document.body.innerHTML = "<p><span id=\"s\">head</span> tail</p>";
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
	expect(lines()).toEqual(["head", "tail"]);

	span.style.display = "none";
	await nextFrame(dom);
	expect(lines()).toEqual(["tail"]);

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
		"<style>" +
		".editing .view { display: none; }" +
		".dim { color: red; }" +
		".open ~ .note { display: none; }" +
		".boxed { background: blue; padding-left: 1px; }" +
		"</style>" +
		"<div id=\"row\"><span class=\"view\">label</span></div>" +
		"<div class=\"note\">note</div>";
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

test("a flip reaches descendants through names only the parser reads", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Names a token scan reads wrong: an escaped colon, a name outside ASCII,
	// an id spelled with two dashes, and a state pseudo-class carrying no
	// attribute name at all. Each names the row, so each reaches the label.
	document.body.innerHTML =
		"<style>" +
		".foo\\:bar .view { display: none; }" +
		".α .view { color: red; }" +
		"#--x .view { color: blue; }" +
		"details[open] .view { color: lime; }" +
		"</style>" +
		"<div id=\"row\"><span class=\"view\">label</span></div>" +
		"<details><span class=\"view\">inner</span></details>";
	await nextFrame(dom);
	const row = document.getElementById("row")!;
	const label = document.querySelector("#row .view") as HTMLElement;
	const inner = document.querySelector("details .view") as HTMLElement;
	const details = document.querySelector("details") as HTMLElement;
	const plain = () => terminal.getPlainText().replace(/\s+/g, " ").trim();

	expect(plain()).toContain("label");

	row.classList.add("α");
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(label).color).toBe("rgb(255, 0, 0)");
	row.classList.remove("α");
	await nextFrame(dom);

	row.id = "--x";
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(label).color).toBe("rgb(0, 0, 255)");
	row.id = "row";
	await nextFrame(dom);

	details.setAttribute("open", "");
	await nextFrame(dom);
	expect(dom.window.getComputedStyle(inner).color).toBe("rgb(0, 255, 0)");

	row.classList.add("foo:bar");
	await nextFrame(dom);
	expect(plain()).not.toContain("label");

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
		"<style>.pre { white-space: pre; }</style>" +
		"<span id=\"s\"><em style=\"display: flex\"><span>   x   </span></em></span>";
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");
	expect(line()).toBe("x");

	document.getElementById("s")!.classList.add("pre");
	await nextFrame(dom);
	expect(line()).toBe("   x");

	// And an inline style says the same thing.
	document.getElementById("s")!.classList.remove("pre");
	await nextFrame(dom);
	expect(line()).toBe("x");
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
	document.body.innerHTML = "<span style=\"display: inline-block\" id=\"s\">A</span>B";
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
	document.body.innerHTML = "<style>.c { display: contents; }</style>AB<p class=\"c\" id=\"s\">C</p>";
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

test("an element flipped to display: contents gives up its box", async () => {
	// The walk that builds boxes FLATTENS a dissolved element away, so nothing
	// there ever names the element itself -- and a box it held under an earlier
	// display outlived the flip whenever the flip's invalidation scope was an
	// ancestor rather than the element. The stale box kept its rows, which only
	// showed once its children changed underneath it.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	// A sibling combinator anywhere in the sheets widens every class flip's
	// scope to the parent, which is how the element stops being visited.
	document.body.innerHTML =
		"<style>.c { display: contents; } .on ~ .light { color: red; }</style>" +
		"<li id=\"a\">A<div id=\"b\">B</div></li><p>C</p>";
	await nextFrame(dom);
	const lines = () =>
		terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""));
	expect(lines().slice(0, 3)).toEqual(["A", "B", "C"]);

	document.getElementById("a")!.classList.add("c");
	await nextFrame(dom);
	expect(document.getElementById("a")!.getBoundingClientRect().height).toBe(0);

	document.getElementById("b")!.remove();
	await nextFrame(dom);
	expect(lines().slice(0, 2)).toEqual(["A", "C"]);

	dom.dispose();
});

test("a block inside an inline takes its padding from a class flip", async () => {
	// An inline element's invalidation is its RUN's, and stops there: it never
	// recurses into children, because a run measures everything under it. A
	// block-level child breaks the inline apart and is laid out by a node of
	// its own, whose margins and padding are the element's own style -- so the
	// flip has to reach that node, and the cascade is what says it must.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<style>.pad { padding-left: 2ch; }</style><b><div id=\"d\">AB</div></b>";
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");
	expect(line()).toBe("AB");

	document.getElementById("d")!.classList.add("pad");
	await nextFrame(dom);
	expect(line()).toBe("  AB");

	dom.dispose();
});

test("a block turned inline-block keeps the content it already had", async () => {
	// The block's layout node is retired the moment an anonymous box takes
	// over measuring it, and its children's nodes belong to other elements
	// which go on pointing at them. Freeing the retired node without severing
	// them first leaves every descendant holding a corpse, and an element
	// measured through a freed node lays out nothing at all.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<div id=\"d\"><section>AB</section></div>";
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");
	expect(line()).toBe("AB");

	document.getElementById("d")!.setAttribute("style", "display: inline-block");
	await nextFrame(dom);
	expect(line()).toBe("AB");

	dom.dispose();
});

test("a restyle deep inside an inline-block re-measures the run holding it", async () => {
	// An inline-block's block content is laid out in a DETACHED tree, run only
	// by the measure of the box the inline-block sits on. The climb out of that
	// tree has to be a DOM question: nothing between the restyled element and
	// the inline-block owns a layout node, and the flex tree above the box is
	// severed and rebuilt constantly, so a box asked which tree it is in can
	// answer "none" and leave the only measure that runs it clean.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<style>.dim { color: #808080; } .on ~ .light { color: red; }</style>" +
		"A<section style=\"display: inline-block\"><section><b id=\"s\">BC</b></section></section>";
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");
	expect(line()).toBe("ABC");

	document.getElementById("s")!.classList.add("dim");
	await nextFrame(dom);
	expect(line()).toBe("ABC");

	dom.dispose();
});

test("a flex item that stops being one gives up its layout node", async () => {
	// A flex container gives each child a box of its own, so an inline child
	// getBlockifiedDisplay into one owns a layout node. When the container stops being a
	// flex container the child joins an anonymous box instead -- and the node
	// it kept lays the same content out a second time, beside the box.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<style>.col { display: flex; flex-direction: column; }</style>" +
		"<b><div id=\"d\" class=\"col\"><span>A</span></div>BC</b>";
	await nextFrame(dom);
	const lines = () =>
		terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""));
	expect(lines().slice(0, 2)).toEqual(["A", "BC"]);

	document.getElementById("d")!.classList.remove("col");
	await nextFrame(dom);
	expect(lines().slice(0, 2)).toEqual(["A", "BC"]);

	dom.dispose();
});

test("a hidden run member gives up the width it reserved", async () => {
	// A member that turns display:none changes what its box measures, and
	// nothing about the space the box was offered says so: the box would go on
	// reserving the hidden member's width forever.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<span>A<em id=\"s\">BBBB</em></span>C";
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");
	expect(line()).toBe("ABBBBC");

	document.getElementById("s")!.setAttribute("style", "display: none");
	await nextFrame(dom);
	expect(line()).toBe("AC");

	dom.dispose();
});

test("a box that stops being display:none is built with its content", async () => {
	// A hidden box is built and switched off, and nothing under it is built at
	// all -- there is nothing there for a measurement to find. Showing it again
	// is a rebuild, not a re-measurement.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<em id=\"s\">AB</em>";
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");

	const em = document.getElementById("s")!;
	em.setAttribute("style", "display: none");
	await nextFrame(dom);
	expect(line()).toBe("");

	em.setAttribute("style", "display: block");
	await nextFrame(dom);
	expect(line()).toBe("AB");

	dom.dispose();
});

test("an inline-block turned block gives up its independent formatting context", async () => {
	// An inline-block holding block-level content lays it out in a tree of its
	// own, run only by the measure of the box the inline-block sits on. A
	// block lays the same content out in the tree above -- and a independent formatting context
	// left behind goes on claiming the children that belong there.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<style>.iblock { display: inline-block; }</style>" +
		"<section id=\"s\" class=\"iblock\"><em><section>AB</section></em></section>";
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");
	expect(line()).toBe("AB");

	document.getElementById("s")!.classList.remove("iblock");
	await nextFrame(dom);
	expect(line()).toBe("AB");

	dom.dispose();
});

test("a block turned flex gives each child a box of its own", async () => {
	// A flex container isBlockified its children (css-display-3 §2.7): each is a
	// box of its own, where a block container gathers the inline ones into
	// anonymous boxes it shares. A ::before is one of those children, and its
	// box has to be built the moment the container becomes a flex one.
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<style>.mark::before { content: \"* \"; }</style>" +
		"<section id=\"s\" class=\"mark\">AB</section>";
	await nextFrame(dom);
	const line = () => terminal.getPlainText().split("\n")[0].replace(/\s+$/, "");
	expect(line()).toBe("* AB");

	document.getElementById("s")!.setAttribute("style", "display: flex");
	await nextFrame(dom);
	expect(line()).toBe("*AB");

	dom.dispose();
});

test("an absolute box inside an appended inline subtree reaches its containing block", async () => {
	// An out-of-flow box hangs from its containing block, not from the
	// container it is written in, so no container's box list names it and no
	// reconciliation builds it. Inside a subtree that arrives as run content
	// nothing descends to it either -- an anonymous box measures its members
	// and steps over what left the flow -- so the arrival itself is what has
	// to find it.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<div id=\"host\" style=\"position: relative\">base</div>";
	await nextFrame(dom);

	const span = document.createElement("span");
	span.innerHTML = "hi<i style=\"position:absolute; top:2px; left:0px\">ABS</i>";
	document.getElementById("host")!.appendChild(span);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));
	expect(lines[0]).toBe("basehi");
	expect(lines[2]).toBe("ABS");

	dom.dispose();
});
