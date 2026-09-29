/**
 * An inline box's left and right margin, border and padding take cells
 * on its line (CSS 2.1 §10.3.1, css-box-3 §4). They sit at the box's
 * start on its first fragment and its end on its last, and stay with the
 * text they border when the line breaks.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess} from "./test-utils.js";

function render(html: string, cols = 30): string[] {
	const dom = new TermDOM({
		transport: new MockProcess({cols, rows: 10}).transport,
	});
	const lines = dom
		.renderANSI(html)
		.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
		.trimEnd()
		.split("\n");
	dom.dispose();
	return lines;
}

test("left and right padding take cells on the line", () => {
	expect(render("<p>[<span style=\"padding: 0 3px\">x</span>]</p>")).toEqual([
		"[   x   ]",
	]);
});

test("left and right margins take cells on the line", () => {
	expect(render("<p>[<span style=\"margin: 0 2px\">y</span>]</p>")).toEqual([
		"[  y  ]",
	]);
});

test("an inline box's border draws its two sides", () => {
	expect(
		render(
			"<p>[<span style=\"border: 1px solid; padding: 0 1px\">z</span>]</p>",
		),
	).toEqual(["[│ z │]"]);
});

test("an empty inline box with padding still takes its cells", () => {
	expect(render("<p>[<span style=\"padding: 0 2px\"></span>]</p>")).toEqual([
		"[    ]",
	]);
});

test("spaces collapse across an inline box's edge", () => {
	expect(render("<p>a <span style=\"padding: 0 2px\"> b</span> c</p>")).toEqual(
		["a   b   c"],
	);
});

test("the start edge goes to the next line with the text it borders", () => {
	expect(
		render(
			"<p style=\"width:12px\">aaaa <span style=\"padding:0 3px\">bbbb</span> cc</p>",
		),
	).toEqual(["aaaa ", "   bbbb    ", "cc"]);
});

test("a broken line's border opens on the first fragment and closes on the last", () => {
	expect(
		render(
			"<p style=\"width:8px\"><span style=\"border:1px solid\">aaa bbb ccc</span></p>",
		),
	).toEqual(["│aaa ", "bbb ccc│"]);
});

test("an inline box's rect is its border box, holding the margins of what it holds", () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 30, rows: 10}).transport,
	});
	dom.document.body.innerHTML =
		"<p>[<span id=\"outer\" style=\"margin: 0 1px\"><span id=\"inner\" " +
		"style=\"padding: 0 3px; margin: 0 1px; border-left: 1px solid\">x" +
		"</span></span>]</p>";
	const outer = dom.document.getElementById("outer")!.getBoundingClientRect();
	const inner = dom.document.getElementById("inner")!.getBoundingClientRect();
	expect([outer.left, outer.width]).toEqual([2, 10]);
	expect([inner.left, inner.width]).toEqual([3, 8]);
	dom.dispose();
});
