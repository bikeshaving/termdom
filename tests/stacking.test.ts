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
