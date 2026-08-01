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

import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils.js";
import {TermDOM} from "../src/internal/termdom.js";

async function render(html: string, cols = 40, rows = 8) {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	await nextFrame(dom);
	const lines = () =>
		terminal
			.getPlainText()
			.split("\n")
			.map((line) => line.replace(/\s+$/, ""));
	return {dom, terminal, lines};
}

test("an inline breaks into fragments around a block-level child", async () => {
	const {dom, lines} = await render(`<span>alpha<div>beta</div>gamma</span>`);

	expect(lines().slice(0, 3)).toEqual(["alpha", "beta", "gamma"]);

	dom.dispose();
});

test("a block-only inline still renders its block", async () => {
	const {dom, lines} = await render(`<a href="#"><div>card</div></a>`);

	// The leading fragment is empty, so the inline's own run measures zero
	// height -- which is not a licence to cull the box the split handed to the
	// container.
	expect(lines()[0]).toBe("card");

	dom.dispose();
});

test("fragments keep document order with content after the inline", async () => {
	const {dom, lines} = await render(`<span>a<div>b</div>c</span>d`);

	// "c" and "d" share a line: the trailing fragment continues past </span>.
	expect(lines().slice(0, 3)).toEqual(["a", "b", "cd"]);

	dom.dispose();
});

test("nested inlines split at the same block", async () => {
	const {dom, lines} = await render(`<span>a<em>b<div>c</div>d</em>e</span>`);

	expect(lines().slice(0, 3)).toEqual(["ab", "c", "de"]);

	dom.dispose();
});

test("fragments survive a rebuild", async () => {
	const {dom, terminal, lines} = await render(
		`<p>before<span>a<div>b</div>c</span>after</p>`,
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
		`<span>a<span style="display: inline-block">b</span>c</span>`,
	);

	expect(lines()[0]).toBe("abc");

	dom.dispose();
});
