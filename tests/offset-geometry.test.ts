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
	// margin-top collapses THROUGH the outer div's borderless, unpadded top
	// (position:relative establishes no BFC), so vertically the inner sits
	// flush -- exactly what a browser reports here. margin-left has no
	// collapsing and offsets the box.
	expect(inner.offsetTop).toBe(0);
	expect(inner.offsetLeft).toBe(2);
	dom.dispose();
});

test("clientWidth/clientHeight exclude border but include padding, for any element", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div id="bordered" style="width:10px; height:4px; border:1px solid; padding:1px"></div>`;
	await nextFrame(dom);

	const bordered = dom.document.getElementById("bordered")!;
	expect(bordered.offsetWidth).toBe(10);
	expect(bordered.offsetHeight).toBe(4);
	// 1px border on each side: 10-2=8, 4-2=2. Padding stays inside clientWidth.
	expect(bordered.clientWidth).toBe(8);
	expect(bordered.clientHeight).toBe(2);
	dom.dispose();
});

test("scrollWidth/scrollHeight equal clientWidth/clientHeight when content doesn't overflow", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div id="box" style="width:8px; height:3px"></div>`;
	await nextFrame(dom);

	const box = dom.document.getElementById("box")!;
	expect(box.scrollWidth).toBe(box.clientWidth);
	expect(box.scrollHeight).toBe(box.clientHeight);
	dom.dispose();
});

test("body's own clientHeight/scrollHeight (viewport height, real content height) are not shadowed", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div>one</div><div>two</div>`;
	await nextFrame(dom);

	// clientHeight is the terminal's own height, unrelated to content.
	expect(dom.document.body.clientHeight).toBe(10);
	// scrollHeight is the document's real content height (2 lines here), which
	// the general contentBoxSize() fallback -- had it applied to body -- would
	// get wrong, since body has no explicit height for a border-box rect to
	// report; the existing instance-level override must still be winning.
	expect(dom.document.body.scrollHeight).toBe(2);
	dom.dispose();
});

test("offsetWidth/Height and clientWidth/Height stay mechanically consistent with border width", async () => {
	// offsetWidth/Height, clientWidth/Height, and offsetTop/Left are all
	// derived from the same #layoutRectOf/#contentBoxOf internals in
	// termdom.ts, not independently written formulas -- so this identity can't
	// silently drift out of sync across an edit to just one of them the way
	// duplicated code could.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `
		<div id="a" style="width:14px; height:6px; border:2px solid; padding:1px"></div>
		<div id="b" style="width:9px; height:5px"></div>
	`;
	await nextFrame(dom);

	// "a" has a 2px border on every side (4 total per axis); "b" has none.
	const expectedBorderTotal: Record<string, number> = {a: 4, b: 0};
	for (const id of ["a", "b"]) {
		const el = dom.document.getElementById(id)!;
		// clientWidth is offsetWidth with the border removed, by construction.
		expect(el.offsetWidth - el.clientWidth).toBe(expectedBorderTotal[id]);
		expect(el.offsetHeight - el.clientHeight).toBe(expectedBorderTotal[id]);
	}
	dom.dispose();
});
