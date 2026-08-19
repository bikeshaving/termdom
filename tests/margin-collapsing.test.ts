/**
 * CSS 2.2 §8.3.1 margin collapsing.
 *
 * These pin the cases that matter in real documents: adjacent siblings, a
 * margin collapsing THROUGH a parent's edge and escaping the box (the
 * blockquote whose border must start at its first text row), and the
 * conditions that stop a collapse (border, padding, a BFC, a flex parent).
 */
import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils";
import {TermDOM, kLayoutEngine} from "../src/internal/termdom.js";

function rectOf(dom: TermDOM, el: Element): DOMRect {
	return (
		dom as unknown as Record<symbol, {getRect(e: Element): DOMRect | null}>
	)[kLayoutEngine].getRect(el)!;
}

async function layout(html: string, head = ""): Promise<
	{terminal: MockProcess; dom: TermDOM}
> {
	const terminal = new MockProcess({cols: 60, rows: 16});
	const dom = new TermDOM({transport: terminal.transport});
	if (head) {
		dom.document.head.innerHTML = head;
	}
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {terminal, dom};
}

test("adjacent sibling margins collapse to the larger", async () => {
	const {dom} = await layout(
		"<div id=\"a\" style=\"margin-bottom:2px\">A</div>" +
		"<div id=\"b\" style=\"margin-top:1px\">B</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	expect(b.top - a.bottom).toBe(2);
	dom.dispose();
});

test("a first child's margin collapses through a borderless-top parent", async () => {
	// The blockquote case: border-left only, so the first paragraph's
	// margin-top escapes the box. The bar starts at the first text row.
	const {dom} = await layout(
		"<div id=\"h\">Heading</div>" +
		"<blockquote id=\"bq\" style=\"border-left:1px solid;padding-left:1ch;margin-top:1px\">" +
		"<p id=\"p1\" style=\"margin-top:1px\">first</p>" +
		"<p id=\"p2\" style=\"margin-top:1px\">second</p>" +
		"</blockquote>",
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
		"<div id=\"h\">Heading</div>" +
		"<blockquote id=\"bq\" style=\"border-left:1px solid;padding-top:1px;margin-top:1px\">" +
		"<p id=\"p\" style=\"margin-top:1px\">quote</p>" +
		"</blockquote>",
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
		"<div id=\"wrap\"><p id=\"p\" style=\"margin-bottom:2px\">text</p></div>" +
		"<div id=\"after\">after</div>",
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
		"<div id=\"h\">Heading</div>" +
		"<div id=\"box\" style=\"overflow:hidden;margin-top:1px\">" +
		"<p id=\"p\" style=\"margin-top:1px\">inside</p>" +
		"</div>",
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
		"<div style=\"display:flex;flex-direction:column\">" +
		"<div id=\"a\" style=\"margin-bottom:2px\">A</div>" +
		"<div id=\"b\" style=\"margin-top:1px\">B</div>" +
		"</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	expect(b.top - a.bottom).toBe(3);
	dom.dispose();
});

test("a negative margin pulls the box up", async () => {
	const {dom} = await layout(
		"<div id=\"a\">A</div><div id=\"b\" style=\"margin-top:-1px\">B</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	// B overlaps A's row: the negative margin is real geometry, not clamped.
	expect(b.top).toBe(a.bottom - 1);
	dom.dispose();
});

test("a negative margin subtracts from the collapsed positive", async () => {
	// §8.3.1: the collapsed margin is the largest positive plus the most
	// negative of the adjoining set.
	const {dom} = await layout(
		"<div id=\"a\" style=\"margin-bottom:2px\">A</div>" +
		"<div id=\"b\" style=\"margin-top:-1px\">B</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	expect(b.top - a.bottom).toBe(1);
	dom.dispose();
});

test("negative values stay rejected where CSS forbids them", async () => {
	const {dom} = await layout(
		"<div id=\"w\" style=\"width:-5px;padding-top:-1px\">x</div>",
	);
	// Invalid declarations fall back: auto width fills the line, padding 0.
	const w = rectOf(dom, dom.document.getElementById("w")!);
	expect(w.width).toBe(60);
	expect(w.height).toBe(1);
	dom.dispose();
});

test("an empty block self-collapses: one margin passes through it", async () => {
	const {dom} = await layout(
		"<div id=\"a\">A</div>" +
		"<div id=\"e\" style=\"margin-top:2px;margin-bottom:3px\"></div>" +
		"<div id=\"b\">B</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const e = rectOf(dom, dom.document.getElementById("e")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	// All four margins adjoin through the zero-height block: max is 3.
	expect(e.height).toBe(0);
	expect(b.top - a.bottom).toBe(3);
	dom.dispose();
});

test("a chain of empty blocks still collapses to one margin", async () => {
	const {dom} = await layout(
		"<div id=\"a\">A</div>" +
		"<div style=\"margin-bottom:2px\"></div>" +
		"<div style=\"margin-top:1px\"></div>" +
		"<div id=\"b\" style=\"margin-top:1px\">B</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	expect(b.top - a.bottom).toBe(2);
	dom.dispose();
});

test("border or height stops self-collapse", async () => {
	const {dom} = await layout(
		"<div id=\"a\">A</div>" +
		"<div id=\"e\" style=\"height:1px;margin-top:1px;margin-bottom:1px\"></div>" +
		"<div id=\"b\">B</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	// A real box between them: both margins apply around it.
	expect(b.top - a.bottom).toBe(3);
	dom.dispose();
});

test("a self-collapsing block collapses its parent through both edges", async () => {
	const {dom} = await layout(
		"<div id=\"a\">A</div>" +
		"<div id=\"wrap\"><div id=\"e\" style=\"margin-top:2px;margin-bottom:3px\"></div></div>" +
		"<div id=\"b\">B</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const wrap = rectOf(dom, dom.document.getElementById("wrap")!);
	const e = rectOf(dom, dom.document.getElementById("e")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	// Nothing separates any of the six margins: one set, largest positive wins.
	expect(e.height).toBe(0);
	expect(wrap.height).toBe(0);
	expect(b.top - a.bottom).toBe(3);
	dom.dispose();
});

test("a negative margin inside a self-collapsing block passes through", async () => {
	const {dom} = await layout(
		"<div id=\"a\" style=\"margin-bottom:3px\">A</div>" +
		"<div id=\"e\" style=\"margin-top:-1px;margin-bottom:1px\"></div>" +
		"<div id=\"b\">B</div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const b = rectOf(dom, dom.document.getElementById("b")!);
	// {3, -1, 1, 0}: largest positive plus most negative.
	expect(b.top - a.bottom).toBe(2);
	dom.dispose();
});

test("a negative margin collapses through a parent's top edge", async () => {
	const {dom} = await layout(
		"<div id=\"a\" style=\"margin-bottom:2px\">A</div>" +
		"<div id=\"wrap\"><div id=\"c\" style=\"margin-top:-1px\">C</div></div>",
	);
	const a = rectOf(dom, dom.document.getElementById("a")!);
	const wrap = rectOf(dom, dom.document.getElementById("wrap")!);
	const c = rectOf(dom, dom.document.getElementById("c")!);
	expect(wrap.top - a.bottom).toBe(1);
	expect(c.top).toBe(wrap.top);
	dom.dispose();
});

test("a trailing self-collapsing child pushes the gap outside its parent", async () => {
	const {dom} = await layout(
		"<div id=\"wrap\"><div id=\"c\">C</div><div id=\"e\" style=\"margin-top:2px\"></div></div>" +
		"<div id=\"after\">after</div>",
	);
	const wrap = rectOf(dom, dom.document.getElementById("wrap")!);
	const c = rectOf(dom, dom.document.getElementById("c")!);
	const after = rectOf(dom, dom.document.getElementById("after")!);
	// The empty block's margins adjoin the parent's bottom edge and escape it.
	expect(wrap.bottom).toBe(c.bottom);
	expect(after.top - wrap.bottom).toBe(2);
	dom.dispose();
});
