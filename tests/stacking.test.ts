/**
 * Stacking contexts: CSS layering, not sibling sorting. Positioned boxes
 * hoist to their nearest stacking context and paint in the spec's layer
 * order -- which is what lets a deep overlay cover unrelated subtrees,
 * what makes a context atomic however large its children's z-indices are,
 * and what hit-testing must mirror so clicks land on what's visibly on
 * top.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

async function render(html: string, cols = 40, rows = 8) {
	const terminal = new MockProcess({rows, cols});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {terminal, dom};
}

test("a deep overlay escapes its parents and paints over a later subtree", async () => {
	// The old per-sibling sort could never do this: the overlay's parents
	// are plain static divs, and the content it must cover is in a sibling
	// subtree of its grandparent.
	const {terminal, dom} = await render(`
		<div><div><div style="position:absolute; top:1px; left:0; z-index:5; width:20ch">OVERLAY</div></div>first</div>
		<div>underneath content</div>`);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("first");
	expect(rows[1]).toContain("OVERLAY");
	expect(rows[1]).not.toContain("underneath");
	dom.dispose();
});

test("a stacking context is atomic: children cannot escape it", async () => {
	// isolated forms a context (positioned, z:0); its z:999 child competes
	// only INSIDE it, so the sibling context at z:1 wins.
	const {terminal, dom} = await render(`
		<div style="position:relative; z-index:0">
			<div style="position:absolute; top:0; left:0; z-index:999; width:12ch">TRAPPED</div>
		</div>
		<div style="position:absolute; top:0; left:0; z-index:1; width:12ch">WINNER</div>`);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("WINNER");
	expect(rows[0]).not.toContain("TRAPPED");
	dom.dispose();
});

test("z-index:auto does not isolate: descendants join the outer context", async () => {
	// Same shape, but the wrapper's z-index is auto -- no context forms, so
	// the z:999 child competes at body level and beats z:1.
	const {terminal, dom} = await render(`
		<div style="position:relative">
			<div style="position:absolute; top:0; left:0; z-index:999; width:12ch">ESCAPES</div>
		</div>
		<div style="position:absolute; top:0; left:0; z-index:1; width:12ch">loser</div>`);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("ESCAPES");
	dom.dispose();
});

test("a z:auto positioned box paints above in-flow content", async () => {
	const {terminal, dom} = await render(`
		<div style="position:relative">
			<div style="position:absolute; top:0; left:0; width:10ch">ABOVE</div>
			<div>in-flow text</div>
		</div>`);
	expect(terminal.getPlainText().split("\n")[0]).toContain("ABOVE");
	dom.dispose();
});

test("hit-testing lands on what is visibly on top", async () => {
	const {dom} = await render(`
		<div id="under">underneath row zero</div>
		<div id="over" style="position:absolute; top:0; left:0; z-index:2; width:10ch">OVER</div>`);
	const {document} = dom;
	// Inside the overlay's box: the overlay wins despite tree order.
	expect(document.elementFromPoint(2, 0)?.id).toBe("over");
	// Past its right edge on the same row: the in-flow text again.
	expect(document.elementFromPoint(15, 0)?.id).toBe("under");
	dom.dispose();
});

test("an absolute box outside its parent's rect is still clickable", async () => {
	// The old top-down hit test required every ancestor to contain the
	// point; a positioned child hanging outside its parent could never be
	// reached.
	const {dom} = await render(`
		<div style="height:1">
			<div id="hang" style="position:absolute; top:3px; left:5ch; width:6ch">HANG</div>
		</div>`);
	expect(dom.document.elementFromPoint(6, 3)?.id).toBe("hang");
	dom.dispose();
});

// Containing blocks: an absolute box positions against its nearest
// POSITIONED ancestor (else the initial containing block), never simply
// its parent -- and being out of flow, it neither occupies inline-run
// space nor is trapped inside a measure-function subtree.

test("absolute resolves against the nearest positioned ancestor", async () => {
	const {terminal, dom} = await render(`
		<div>push down one row</div>
		<div style="position:relative">
			<div>filler row</div>
			<div><div style="position:absolute; top:0; left:20ch; width:6ch">MARK</div></div>
		</div>`);
	const rows = terminal.getPlainText().split("\n");
	// top:0 against the RELATIVE wrapper (document row 1) -- not against
	// the static div it actually sits inside (row 2), and not the ICB.
	expect(rows[1]).toContain("MARK");
	expect(rows[1]).toContain("filler");
	dom.dispose();
});

test("with no positioned ancestor, the initial containing block wins", async () => {
	const {terminal, dom} = await render(`
		<div>row zero</div>
		<div><div><div style="position:absolute; top:0; left:20ch; width:6ch">TOP</div></div></div>`);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("TOP");
	expect(rows[0]).toContain("row zero");
	dom.dispose();
});

test("an absolute box does not occupy inline-run space", async () => {
	const {terminal, dom} = await render(`
		<div>ab<span style="position:absolute; top:2px; left:0; width:4ch">X</span>cd</div>`);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("abcd"); // contiguous: X takes no run cells
	expect(rows[2]).toContain("X");
	dom.dispose();
});

test("an absolute box escapes a measure-function (inline-block) subtree", async () => {
	const {terminal, dom} = await render(`
		<div style="position:relative">
			<span style="display:inline-block">label<span style="position:absolute; top:1px; left:10ch; width:8ch">ESCAPED</span></span>
		</div>`);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("label");
	expect(rows[1]).toContain("ESCAPED");
	dom.dispose();
});

test("a relative inline run member keeps painting with its run", async () => {
	// It has no hoisted box -- no positioned layer would paint it -- so the
	// in-flow walk must not defer it. (Its text also keeps its run cells:
	// relative positioning preserves flow space.)
	const {terminal, dom} = await render(
		`<div>ab<span style="position:relative">MID</span>cd</div>`,
	);
	expect(terminal.getPlainText()).toContain("abMIDcd");
	dom.dispose();
});

test("isolation: isolate forms a stacking context without positioning", async () => {
	const {terminal, dom} = await render(`
		<div style="isolation:isolate">
			<div style="position:absolute; top:0; left:0; z-index:999; width:10ch">TRAPPED</div>
		</div>
		<div style="position:absolute; top:0; left:0; z-index:1; width:10ch">WINNER</div>`);
	expect(terminal.getPlainText().split("\n")[0]).toContain("WINNER");
	dom.dispose();
});

test("relative offsets shift an inline run member's fragments", async () => {
	const {terminal, dom} = await render(
		`<div>ab<span style="position:relative; left:3ch">MID</span></div>`,
	);
	const row = terminal.getPlainText().split("\n")[0];
	expect(row.indexOf("MID")).toBe(5); // 2 (after "ab") + 3 offset
	dom.dispose();
});

test("a positioned ancestor's overflow clips its absolute descendant", async () => {
	// The wrapper IS the box's containing block, so its overflow:hidden
	// clips -- unlike an overflow ancestor outside the CB chain.
	const {terminal, dom} = await render(`
		<div style="position:relative; overflow:hidden; height:2px; width:10ch">
			<div style="position:absolute; top:0; left:0; width:20ch">WIDE-CLIPPED-TEXT</div>
		</div>`);
	const row = terminal.getPlainText().split("\n")[0];
	expect(row).toContain("WIDE-CLIPP");
	expect(row).not.toContain("WIDE-CLIPPED");
	dom.dispose();
});

test("position:fixed stays glued to the viewport as the camera scrolls", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML =
		`<div style="position:fixed; top:0; left:30ch; width:6ch">PINNED</div>` +
		Array.from({length: 10}, (_, i) => `<div>row${i}</div>`).join("");
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0]).toContain("PINNED");

	dom.window.scrollTo(0, 5);
	await nextFrame(dom);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("row5"); // camera moved
	expect(rows[0]).toContain("PINNED"); // fixed box did not

	dom.dispose();
});

test("the border shorthand in a stylesheet rule reaches the box model", async () => {
	// Rules and element defaults are consulted per-property; the expander
	// turns border/padding/margin shorthands into the longhands the box
	// model and painter read. Height proves MEASUREMENT, not just paint.
	const {terminal, dom} = await render(
		`<style>.boxed { border: 1px solid; padding: 1px; width: 10ch }</style>
		 <div class="boxed">X</div>`,
	);
	const div = dom.document.querySelector(".boxed")!;
	expect(div.getBoundingClientRect().height).toBe(5); // 1+1+1+1+1
	expect(terminal.getPlainText()).toContain("┌");
	dom.dispose();
});

test("a runtime flip to position:absolute keeps pseudo-only content", async () => {
	// The rebuild path used to reparent the stale run-member node wholesale:
	// its inline-run measure func skips out-of-flow boxes, so the flipped
	// button measured 0x0 and its ::after glyph silently vanished. The box
	// changed KIND -- reuse must give way to a full rebuild, both ways.
	const {terminal, dom} = await render(`
		<style>
			li { position: relative; display: flex; flex-direction: row; }
			.destroy::before { content: none } .destroy::after { content: "(x)" }
			li.pinned .destroy { position: absolute; top: 0px; right: 0px; }
		</style>
		<li id="li"><span>Finish TermDOM</span><button class="destroy"></button></li>`);
	const li = dom.document.getElementById("li")!;
	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe(
		"Finish TermDOM(x)",
	);

	li.classList.add("pinned");
	await nextFrame(dom);
	await nextFrame(dom);
	const pinned = terminal.getPlainText().split("\n")[0];
	expect(pinned.trimEnd().endsWith("(x)")).toBe(true); // at the right edge
	expect(pinned.startsWith("Finish TermDOM ")).toBe(true); // out of the row flow

	li.classList.remove("pinned");
	await nextFrame(dom);
	await nextFrame(dom);
	expect(terminal.getPlainText().split("\n")[0].trimEnd()).toBe(
		"Finish TermDOM(x)",
	);
	dom.dispose();
});
