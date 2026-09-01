/**
 * Whole-frame snapshots for the layout the box tree decides and the painter
 * draws: grid placement, out-of-flow boxes, viewport-anchored boxes, and the
 * order overlapping boxes paint in.
 *
 * The other suites assert geometry, which says where a box is but not what
 * reached the screen. These assert the frame. Every fixture is built so the
 * frame cannot be right by accident: boxes overlap and carry different
 * background colours, so a wrong paint order shows up as the wrong colour
 * winning a cell rather than as text that happens to look the same.
 *
 * Each test asserts something in words as well, so a snapshot rewritten by
 * `-u` cannot quietly bless a regression on its own.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("a grid places its items on the tracks it declares", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"display: grid; " +
		"grid-template-columns: 8ch 1fr 8ch; " +
		"grid-template-rows: 1em 3em 1em; gap: 1ch\">" +
		"<div style=\"background-color: #400\">TL</div>" +
		"<div style=\"background-color: #040\">head</div>" +
		"<div style=\"background-color: #004\">TR</div>" +
		"<div style=\"background-color: #440\">side</div>" +
		"<div style=\"background-color: #044; grid-column: span 2\">wide body</div>" +
		"<div style=\"background-color: #404\">BL</div>" +
		"<div style=\"background-color: #444; grid-column: span 2\">footer</div>" +
		"</div>";
	await nextFrame(dom);

	const rows = terminal.getVisibleText().split("\n");
	// Three columns: 8 cells, the rest, 8 cells, with a cell of gap between.
	expect(rows[0]).toContain("TL");
	expect(rows[0]).toContain("TR");
	// The second row spans two columns, so nothing sits to its right.
	expect(rows[2]).toContain("wide body");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("grid-tracks-and-spans");
	dom.dispose();
});

test("a grid area names where its items go", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"display: grid; " +
		"grid-template-areas: 'head head' 'nav main' 'foot foot'; " +
		"grid-template-columns: 10ch 1fr; " +
		"grid-template-rows: 1em 4em 1em\">" +
		"<div style=\"grid-area: head; background-color: #114\">header</div>" +
		"<div style=\"grid-area: nav; background-color: #141\">nav</div>" +
		"<div style=\"grid-area: main; background-color: #411\">main</div>" +
		"<div style=\"grid-area: foot; background-color: #444\">footer</div>" +
		"</div>";
	await nextFrame(dom);

	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("header");
	// nav and main share a row, nav first because it is the first column.
	expect(rows[1].indexOf("nav")).toBeLessThan(rows[1].indexOf("main"));

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("grid-template-areas");
	dom.dispose();
});

test("an absolute box leaves the flow it came from", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	// The anchor establishes the containing block; the absolute box resolves
	// against it and takes no space, so `after` sits where `before` left off.
	dom.document.body.innerHTML =
		"<div style=\"position: relative; background-color: #222\">" +
		"<div>before</div>" +
		"<div style=\"position: absolute; top: 0; right: 0; " +
		"background-color: #800\">pinned</div>" +
		"<div>after</div>" +
		"</div>";
	await nextFrame(dom);

	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("before");
	expect(rows[0]).toContain("pinned");
	expect(rows[1]).toContain("after");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("absolute-out-of-flow");
	dom.dispose();
});

test("a fixed box holds its row while the document scrolls under it", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		Array.from({length: 40}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div style=\"position: fixed; top: 0; left: 0; width: 100%; " +
		"background-color: #006\">pinned header</div>";
	await nextFrame(dom);
	dom.window.scrollBy(0, 15);
	await nextFrame(dom);

	const rows = terminal.getVisibleText().split("\n");
	// The camera moved; the fixed box did not.
	expect(rows[0]).toContain("pinned header");
	expect(rows[1]).toContain("row 16");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("fixed-header-scrolled");
	dom.dispose();
});

test("z-index decides which of three stacked boxes is seen", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	// Three boxes on exactly the same cells, in the document order z3, z2, z1.
	// Document order alone would leave z1 on top. z-index says z3, so the
	// frame is only right if paint order beat document order.
	dom.document.body.innerHTML =
		"<div style=\"position: relative; height: 4em\">" +
		"<div style=\"position: absolute; top: 1em; left: 2ch; width: 24ch; " +
		"z-index: 3; background-color: #800\">z3 wins the cells</div>" +
		"<div style=\"position: absolute; top: 1em; left: 2ch; width: 24ch; " +
		"z-index: 2; background-color: #080\">z2 is covered</div>" +
		"<div style=\"position: absolute; top: 1em; left: 2ch; width: 24ch; " +
		"z-index: 1; background-color: #008\">z1 is covered</div>" +
		"</div>";
	await nextFrame(dom);

	const row = terminal.getVisibleText().split("\n")[1];
	expect(row).toContain("z3 wins the cells");
	expect(row).not.toContain("z2");
	expect(row).not.toContain("z1");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("stacking-z-index-overlap");
	dom.dispose();
});

test("a negative z-index paints behind the content of its stacking context", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	// The anchor takes z-index: 0, which is what makes it a stacking context --
	// position: relative alone does not. So the box below belongs to it, and
	// paints at step 2 of css2 appendix E: after this element's background,
	// before its in-flow content. The text wins the cells it covers; the box
	// keeps the rest.
	dom.document.body.innerHTML =
		"<div style=\"position: relative; z-index: 0; background-color: #222\">" +
		"<div style=\"position: absolute; top: 0; left: 0; width: 30ch; " +
		"z-index: -1; background-color: #600\">behind</div>" +
		"<div>in flow text</div>" +
		"</div>";
	await nextFrame(dom);

	const frame = terminal.getStaticANSI();
	// The in-flow text covers every cell the box behind put a glyph in, so
	// the proof that the box painted at all is its ground, not its text.
	expect(terminal.getVisibleText().split("\n")[0]).toContain("in flow text");
	// Both grounds reach the screen: the anchor's, and the box behind it.
	expect(frame).toContain("48;2;34;34;34m");
	expect(frame).toContain("48;2;102;0;0m");

	expect(frame).toMatchSnapshot();
	terminal.writeANSI("stacking-negative-z");
	dom.dispose();
});

test("a negative z-index hoists past a parent that is no stacking context", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	// The same markup with the anchor's z-index left at auto. It is then not
	// a stacking context, so the box hoists to the nearest one -- the root --
	// and paints before the root's in-flow content, which is the anchor. The
	// anchor's own background covers it, and only that ground reaches the
	// screen. This is the case that reads as a bug and is not one.
	dom.document.body.innerHTML =
		"<div style=\"position: relative; background-color: #222\">" +
		"<div style=\"position: absolute; top: 0; left: 0; width: 30ch; " +
		"z-index: -1; background-color: #600\">behind the text</div>" +
		"<div>in flow text</div>" +
		"</div>";
	await nextFrame(dom);

	const frame = terminal.getStaticANSI();
	expect(terminal.getVisibleText().split("\n")[0]).toContain("in flow text");
	expect(frame).toContain("48;2;34;34;34m");
	expect(frame).not.toContain("48;2;102;0;0m");

	expect(frame).toMatchSnapshot();
	terminal.writeANSI("stacking-negative-z-hoisted");
	dom.dispose();
});
