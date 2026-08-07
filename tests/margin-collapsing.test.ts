/**
 * CSS 2.2 §8.3.1 margin collapsing, in the block emulation.
 *
 * The flex engine sums adjacent margins; CSS block layout collapses them.
 * These pin the cases that matter in real documents: adjacent siblings, a
 * margin collapsing THROUGH a parent's edge and escaping the box (the
 * blockquote whose border must start at its first text row), and the
 * conditions that stop a collapse (border, padding, a BFC, a flex parent).
 */
import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils";
import {TermDOM, kLayoutEngine} from "../src/internal/termdom.js";

function rectOf(dom: TermDOM, el: Element) {
	return (
		dom as unknown as Record<symbol, {getRect(e: Element): DOMRect | null}>
	)[kLayoutEngine].getRect(el)!;
}

async function layout(html: string, head = "") {
	const terminal = new MockProcess({cols: 60, rows: 16});
	const dom = new TermDOM({process: terminal});
	if (head) dom.document.head.innerHTML = head;
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {terminal, dom};
}

test("adjacent sibling margins collapse to the larger", async () => {
	const {dom} = await layout(
		`<div id="a" style="margin-bottom:2px">A</div>` +
			`<div id="b" style="margin-top:1px">B</div>`,
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	expect(b.top - a.bottom).toBe(2);
	dom.dispose();
});

// Negative margins are unsupported engine-wide (parseUnitValue rejects any
// non-digit-leading value in every margin path, not just collapsing), so the
// most-negative half of the §8.3.1 combine rule stays untested until they are.

test("a first child's margin collapses through a borderless-top parent", async () => {
	// The blockquote case: border-left only, so the first paragraph's
	// margin-top escapes the box. The bar starts at the first text row.
	const {dom} = await layout(
		`<div id="h">Heading</div>` +
			`<blockquote id="bq" style="border-left:1px solid;padding-left:1ch;margin-top:1px">` +
			`<p id="p1" style="margin-top:1px">first</p>` +
			`<p id="p2" style="margin-top:1px">second</p>` +
			`</blockquote>`,
	);
	const h = rectOf(dom, dom.document.getElementById("h")!);
	const bq = rectOf(dom, dom.document.getElementById("bq")!);
	const p1 = rectOf(dom, dom.document.getElementById("p1")!);
	const p2 = rectOf(dom, dom.document.getElementById("p2")!);
	// One collapsed row of gap above the box; the box starts AT its first text.
	expect(bq.top - h.bottom).toBe(1);
	expect(p1.top).toBe(bq.top);
	// The sibling gap stays inside; the box ends at its last text row.
	expect(p2.top - p1.bottom).toBe(1);
	expect(bq.bottom).toBe(p2.bottom);
	dom.dispose();
});

test("padding-top stops the collapse: the child margin stays inside", async () => {
	const {dom} = await layout(
		`<div id="h">Heading</div>` +
			`<blockquote id="bq" style="border-left:1px solid;padding-top:1px;margin-top:1px">` +
			`<p id="p" style="margin-top:1px">quote</p>` +
			`</blockquote>`,
	);
	const h = rectOf(dom, dom.document.getElementById("h")!);
	const bq = rectOf(dom, dom.document.getElementById("bq")!);
	const p = rectOf(dom, dom.document.getElementById("p")!);
	expect(bq.top - h.bottom).toBe(1);
	// padding row + the paragraph's own margin, both inside the box.
	expect(p.top - bq.top).toBe(2);
	dom.dispose();
});

test("a last child's margin collapses through a borderless-bottom parent", async () => {
	const {dom} = await layout(
		`<div id="wrap"><p id="p" style="margin-bottom:2px">text</p></div>` +
			`<div id="after">after</div>`,
	);
	const wrap = rectOf(dom, dom.document.getElementById("wrap")!);
	const p = rectOf(dom, dom.document.getElementById("p")!);
	const after = rectOf(dom, dom.document.getElementById("after")!);
	expect(wrap.bottom).toBe(p.bottom);
	expect(after.top - wrap.bottom).toBe(2);
	dom.dispose();
});

test("overflow:hidden establishes a BFC: no collapse through its edges", async () => {
	const {dom} = await layout(
		`<div id="h">Heading</div>` +
			`<div id="box" style="overflow:hidden;margin-top:1px">` +
			`<p id="p" style="margin-top:1px">inside</p>` +
			`</div>`,
	);
	const h = rectOf(dom, dom.document.getElementById("h")!);
	const box = rectOf(dom, dom.document.getElementById("box")!);
	const p = rectOf(dom, dom.document.getElementById("p")!);
	expect(box.top - h.bottom).toBe(1);
	expect(p.top - box.top).toBe(1);
	dom.dispose();
});

test("flex items never collapse margins", async () => {
	const {dom} = await layout(
		`<div style="display:flex;flex-direction:column">` +
			`<div id="a" style="margin-bottom:2px">A</div>` +
			`<div id="b" style="margin-top:1px">B</div>` +
			`</div>`,
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	expect(b.top - a.bottom).toBe(3);
	dom.dispose();
});
