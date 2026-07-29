/**
 * offsetWidth / offsetHeight / offsetTop / offsetLeft / offsetParent.
 *
 * The most commonly reached-for DOM measurement API, previously entirely
 * unimplemented (always 0/null, inherited from jsdom's defaults -- see the
 * spec-conformance audit). Border-box dimensions and position, from the same
 * layout rect getBoundingClientRect already uses.
 */

import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("offsetWidth/offsetHeight report an element's own border-box size", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div id="box" style="width:12px; height:4px"></div>`;
	await nextFrame(dom);

	const box = dom.document.getElementById("box")!;
	expect(box.offsetWidth).toBe(12);
	expect(box.offsetHeight).toBe(4);
	dom.dispose();
});

test("a disconnected element reports zero offset geometry", () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const div = dom.document.createElement("div");
	div.style.width = "12px";

	expect(div.offsetWidth).toBe(0);
	expect(div.offsetHeight).toBe(0);
	expect(div.offsetTop).toBe(0);
	expect(div.offsetLeft).toBe(0);
	expect(div.offsetParent).toBe(null);
	dom.dispose();
});

test("offsetParent is the nearest positioned ancestor", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `
		<div id="static-wrapper">
			<div id="positioned" style="position:relative">
				<div id="target">x</div>
			</div>
		</div>
	`;
	await nextFrame(dom);

	const target = dom.document.getElementById("target")!;
	const positioned = dom.document.getElementById("positioned")!;
	expect(target.offsetParent).toBe(positioned);
	dom.dispose();
});

test("offsetParent falls back to body when no ancestor is positioned", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div id="a"><div id="b">x</div></div>`;
	await nextFrame(dom);

	const b = dom.document.getElementById("b")!;
	expect(b.offsetParent).toBe(dom.document.body);
	dom.dispose();
});

test("body has no offsetParent", () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	expect(dom.document.body.offsetParent).toBe(null);
	dom.dispose();
});

test("offsetTop/offsetLeft are relative to offsetParent's own box, including margins", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `
		<div id="outer" style="width:20px; height:5px; position:relative">
			<div id="inner" style="width:10px; height:3px; margin-left:2px; margin-top:1px">hi</div>
		</div>
	`;
	await nextFrame(dom);

	const inner = dom.document.getElementById("inner")!;
	expect(inner.offsetTop).toBe(1);
	expect(inner.offsetLeft).toBe(2);
	dom.dispose();
});
