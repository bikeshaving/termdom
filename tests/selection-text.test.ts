/**
 * Selection.toString() reads the rendered text between the selection's
 * ends. It walks only the subtrees the range reaches, so a click, which
 * leaves the selection collapsed, walks nothing, and a selection in a
 * long document reads its own few nodes rather than the whole page.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

test("a selection reads the rendered text between its ends, shadow content included", async () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 40, rows: 12}).transport,
	});
	const {document, window} = dom;
	document.body.innerHTML =
		"<p id=\"a\">one two</p>" +
		"<div><p>mid <b>bold</b></p><p hidden>gone</p></div>" +
		"<p id=\"b\">three four</p>" +
		"<div id=\"host\"><span slot=\"x\">light x</span>" +
		"<span slot=\"y\">light y</span></div>" +
		"<p id=\"c\">tail end</p>";
	document.getElementById("host")!.attachShadow({mode: "open"}).innerHTML =
		"<p><slot name=\"y\"></slot></p><p><slot name=\"x\"></slot></p>";
	dom.attach();
	await nextFrame(dom);
	const selection = window.getSelection()!;
	const text = (id: string) => document.getElementById(id)!.firstChild!;

	selection.setBaseAndExtent(text("a"), 4, text("a"), 4);
	expect(selection.toString()).toBe("");
	selection.setBaseAndExtent(text("a"), 4, text("b"), 5);
	expect(selection.toString()).toBe("two\nmid bold\nthree");
	selection.setBaseAndExtent(text("b"), 6, text("c"), 4);
	expect(selection.toString()).toBe("four\nlight ylight x\ntail");
	const {body} = document;
	selection.setBaseAndExtent(body, 0, body, body.childNodes.length);
	expect(selection.toString())
		.toBe("one two\nmid bold\nthree four\nlight ylight x\ntail end");
	dom.dispose();
});
