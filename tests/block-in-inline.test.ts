/**
 * Block-level boxes inside inline boxes (CSS2 §9.2.1.1).
 *
 * An inline box wrapping block-level content is broken around it: the content
 * before the block, the block, and the content after each become boxes of the
 * containing block, in document order. `<a href="..."><div>card</div></a>` is
 * this shape and it is everywhere in real markup -- before the split existed
 * the run simply ENDED at the block, and everything from there on rendered as
 * nothing at all.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

async function render(html: string, cols = 40, rows = 8): Promise<
	{dom: TermDOM; terminal: MockProcess; lines: () => string[]}
> {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const lines = () =>
		terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""));
	return {dom, terminal, lines};
}

test("an inline breaks into fragments around a block-level child", async () => {
	const {dom, lines} = await render("<span>alpha<div>beta</div>gamma</span>");

	expect(lines().slice(0, 3)).toEqual(["alpha", "beta", "gamma"]);

	dom.dispose();
});

test("a block-only inline still renders its block", async () => {
	const {dom, lines} = await render("<a href=\"#\"><div>card</div></a>");

	// The leading fragment is empty, so the inline's own run measures zero
	// height -- which is not a licence to cull the box the split handed to the
	// container.
	expect(lines()[0]).toBe("card");

	dom.dispose();
});

test("fragments keep document order with content after the inline", async () => {
	const {dom, lines} = await render("<span>a<div>b</div>c</span>d");

	// "c" and "d" share a line: the trailing fragment continues past </span>.
	expect(lines().slice(0, 3)).toEqual(["a", "b", "cd"]);

	dom.dispose();
});

test("nested inlines split at the same block", async () => {
	const {dom, lines} = await render("<span>a<em>b<div>c</div>d</em>e</span>");

	expect(lines().slice(0, 3)).toEqual(["ab", "c", "de"]);

	dom.dispose();
});

test("fragments survive a rebuild", async () => {
	const {dom, terminal, lines} = await render(
		"<p>before<span>a<div>b</div>c</span>after</p>",
	);
	const first = lines();
	expect(first.slice(0, 3)).toEqual(["beforea", "b", "cafter"]);

	// A class round-trip rebuilds the layout tree from the container's DIRECT
	// children, which never name the boxes an inline handed up.
	dom.document.body.className = "flip";
	await nextFrame(dom);
	dom.document.body.className = "";
	await nextFrame(dom);

	expect(
		terminal
			.getPlainText()
			.split("\n")
			.map((l) => l.replace(/\s+$/, "")),
	).toEqual(first);

	dom.dispose();
});

test("an inline-block child does not split its inline", async () => {
	// It establishes its own formatting context, so it stays on the line.
	const {dom, lines} = await render(
		"<span>a<span style=\"display: inline-block\">b</span>c</span>",
	);

	expect(lines()[0]).toBe("abc");

	dom.dispose();
});

/**
 * The other half: an inline-block may legally CONTAIN block-level boxes,
 * because it establishes a block container. That is not a split -- the boxes
 * stack inside it -- so the box gets a layout tree of its own, laid out during
 * its measurement and anchored wherever the run finally puts it.
 */

test("an inline-block lays out block-level children inside itself", async () => {
	const {dom, lines} = await render(
		"<span style=\"display: inline-block\"><div>one</div><div>two</div></span>",
	);

	expect(lines().slice(0, 2)).toEqual(["one", "two"]);

	dom.dispose();
});

test("inline content around a block inside an inline-block still paints", async () => {
	const {dom, lines} = await render(
		"<div style=\"display: inline-block\">before<p>block</p>after</div>",
	);

	// "before" is an anonymous block INSIDE the box, not part of the run the
	// box itself sits on -- reading it as the latter measured it against a run
	// that ends at the first block, and it painted nothing.
	expect(lines().slice(0, 3)).toEqual(["before", "block", "after"]);

	dom.dispose();
});

test("an inline-block shrinks to fit its block content", async () => {
	const {dom, terminal, lines} = await render(
		"<span style=\"display: inline-block; border: 1px solid\"><div>one</div><div>two</div></span>",
	);

	// Shrink-to-fit: three cells of content plus the border box.
	expect(lines()[0]).toBe("┌───┐");
	expect(lines()[1]).toBe("│one│");
	expect(lines()[3]).toBe("└───┘");
	expect(terminal.getPlainText()).toContain("two");

	dom.dispose();
});

test("a widget inside an inline-block's block content paints in place", async () => {
	const {dom, terminal} = await render(
		"<span style=\"display: inline-block\"><p>x<input value=\"typed\">tail</p></span>",
	);

	const input = dom.document.querySelector("input")!;
	const rect = input.getBoundingClientRect();
	// Positions under a independent formatting context mean nothing until the run places the box
	// that owns it; the widget's own rect is anchored to that box's content edge.
	expect(rect.x).toBe(1);
	expect(terminal.getPlainText()).toContain("typed");

	dom.dispose();
});

test("an inline-block's content survives sitting inside another inline", async () => {
	// Nested this way the box is a run MEMBER, and #addElementNode is never
	// called on one, so its measurement is what gives it a independent formatting context.
	const {dom, lines} = await render(
		"<span><span style=\"display: inline-block\"><p>deep</p></span> tail</span>",
	);

	expect(lines()[0]).toBe("deep tail");

	dom.dispose();
});

test("a widget in an inline-block does not take a box of its own", async () => {
	const {dom, lines} = await render(
		"heading<span style=\"display: inline-block\"><input value=\"V\"></span>",
	);

	// The run measures the box and everything in it. Manufacturing a layout
	// node for the widget put it at the top of the document, one row above the
	// text it belongs beside.
	expect(lines()[0]).toBe("headingV");

	dom.dispose();
});

test("text between two blocks keeps its place in the order", async () => {
	// The three fragments are boxes of the CONTAINER, and the anonymous one
	// holding the text sits between the two blocks. A box placed among its DOM
	// siblings cannot see the anonymous boxes between them, so the second block
	// was landing in the text's slot and rendering above it.
	const {dom, lines} = await render("<b><section>A</section>B<div>C</div></b>");

	expect(lines().slice(0, 3)).toEqual(["A", "B", "C"]);

	dom.dispose();
});

test("a block added to an inline breaks it, and rejoins it on removal", async () => {
	// The fragments are the container's, so an arriving block-level child
	// changes a box list the inline itself never announces. Deferred to the
	// re-add sweep, the block was hung off the nearest laid-out ancestor and
	// never drawn at all.
	const {dom, lines} = await render("<section><em>A<b>B</b>C</em></section>");
	expect(lines()[0]).toBe("ABC");

	const block = dom.document.createElement("div");
	block.textContent = "D";
	dom.document.querySelector("em")!.appendChild(block);
	await nextFrame(dom);
	expect(lines().slice(0, 2)).toEqual(["ABC", "D"]);

	block.remove();
	await nextFrame(dom);
	expect(lines().slice(0, 2)).toEqual(["ABC", ""]);

	dom.dispose();
});

test("a display: contents element added brings its children with it", async () => {
	// It generates no box of its own, so nothing about it reaches layout: the
	// container has to be told to enumerate again, or the children it
	// dissolves into are never boxed.
	const {dom, lines} = await render(
		"<style>.c { display: contents; }</style><div>A</div>",
	);
	expect(lines()[0]).toBe("A");

	const wrapper = dom.document.createElement("span");
	wrapper.className = "c";
	wrapper.textContent = "B";
	dom.document.body.appendChild(wrapper);
	await nextFrame(dom);
	expect(lines().slice(0, 2)).toEqual(["A", "B"]);

	dom.dispose();
});

test("an inline flex item holding a block is a block container", async () => {
	// A flex container isBlockified its children (css-display-3 §2.7), so an
	// inline one holding block-level content establishes a block container.
	// Measured as a run instead, its content ends at the first block inside it
	// -- and everything from there on, which here is everything, is dropped.
	const {dom, lines} = await render(
		"<b style=\"display: flex\"><span><p>X</p></span></b>",
	);

	expect(lines()[0]).toBe("X");

	dom.dispose();
});

test("an inline-block inside an inline-block takes a block child", async () => {
	// The inner one lays its block content out under a independent formatting context of its
	// own, and a block arriving there belongs to that box's children like any
	// other.
	const {dom, lines} = await render(
		"<section style=\"display: inline-block\">" +
		"<b style=\"display: inline-block\" id=\"s\">A<div></div></b>" +
		"</section>C",
	);
	expect(lines()[0]).toBe("AC");

	const block = dom.document.createElement("div");
	block.textContent = "N";
	const host = dom.document.getElementById("s")!;
	host.insertBefore(block, host.firstChild);
	await nextFrame(dom);
	expect(lines().slice(0, 2)).toEqual(["NC", "A"]);

	dom.dispose();
});
