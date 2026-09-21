/**
 * window.scrollY/pageYOffset/scrollBy/scrollTo/scroll and
 * document.documentElement/body.scrollTop are all one value: the document
 * camera. Previously scrollTo/scroll/scrollTop wrote a completely separate,
 * unused piece of state of their own -- calling window.scrollTo(0, 100) did
 * not move what window.scrollY reported. See the spec-conformance audit.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

function makeOverflowingApp(
	rows = 5,
	lines = 20,
): {terminal: MockProcess; dom: TermDOM} {
	const terminal = new MockProcess({cols: 40, rows});
	const dom = new TermDOM({transport: terminal.transport});
	for (let i = 0; i < lines; i++) {
		const div = dom.document.createElement("div");
		div.textContent = `line ${i}`;
		dom.document.body.appendChild(div);
	}
	return {terminal, dom};
}

test("scrollTo moves the same camera scrollY reads", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.window.scrollTo(0, 5);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(5);
	expect(dom.window.pageYOffset).toBe(5);
	dom.dispose();
});

test("scroll() is an alias for scrollTo", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.window.scroll(0, 4);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(4);
	dom.dispose();
});

test("scrollTo/scroll accept the {top} options-object form", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.window.scrollTo({top: 6});
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(6);

	dom.window.scroll({top: 3});
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(3);
	dom.dispose();
});

test("document.documentElement.scrollTop reads and writes the camera", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.document.documentElement.scrollTop = 8;
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(8);
	expect(dom.document.documentElement.scrollTop).toBe(8);
	dom.dispose();
});

test("document.body.scrollTop is the same value as documentElement.scrollTop", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.document.body.scrollTop = 7;
	await nextFrame(dom);
	expect(dom.document.documentElement.scrollTop).toBe(7);
	expect(dom.window.scrollY).toBe(7);
	dom.dispose();
});

test("scrolling via scrollBy is visible through scrollTop, and vice versa", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.window.scrollBy(0, 4);
	await nextFrame(dom);
	expect(dom.document.documentElement.scrollTop).toBe(4);

	dom.document.documentElement.scrollTop = 2;
	await nextFrame(dom);
	dom.window.scrollBy(0, 3);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(5);
	dom.dispose();
});

test("scrollTo clamps to the document's actual scrollable range, not past it", async () => {
	// 20 lines in a 5-row viewport -> 15 rows of real scroll room.
	const {dom} = makeOverflowingApp(5, 20);
	await nextFrame(dom);

	dom.window.scrollTo(0, 9999);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(15);
	dom.dispose();
});

test("scrollTo is a no-op (stays at 0) when content already fits the viewport", async () => {
	// Only 3 lines in a 10-row viewport -- nothing to scroll to.
	const {dom} = makeOverflowingApp(10, 3);
	await nextFrame(dom);

	dom.window.scrollTo(0, 5);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(0);
	dom.dispose();
});

test("negative scrollTo values clamp to 0, matching scrollBy", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.window.scrollTo(0, -50);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(0);
	dom.dispose();
});

test("a scroll repaint keeps the legend on the fieldset's border row", async () => {
	// A legend's negative margin sets it INTO the top border row. A camera
	// scroll repaints only the newly exposed rows and carries the rest of
	// the screen over; the fieldset intersects the exposed band, so its
	// border strokes repaint -- and they must not blank the carried-over
	// border row's legend, which nothing in the band redraws.
	const terminal = new MockProcess({cols: 30, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div>l0</div><div>l1</div><div>l2</div><div>l3</div>" +
		"<fieldset><legend>Legend</legend><div>field body</div></fieldset>" +
		"<div>t0</div><div>t1</div><div>t2</div><div>t3</div>" +
		"<div>t4</div><div>t5</div><div>t6</div><div>t7</div>";
	await nextFrame(dom);

	dom.window.scrollTo(0, 1);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("Legend");

	// The border row scrolled off and back re-exposes it whole.
	dom.window.scrollTo(0, 8);
	await nextFrame(dom);
	dom.window.scrollTo(0, 4);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("Legend");
	dom.dispose();
});

test("banded scroll repaints match a from-scratch paint at each offset", async () => {
	// Two bordered boxes share a wall row. One-row scrolls walk that seam
	// across the screen: each frame repaints only the exposed band while a
	// box spanning the seam re-stamps its whole outline, so strokes and
	// text aimed at carried-over rows must be dropped, not landed. A fresh
	// terminal painted directly at the target offset is the referee.
	const html =
		"<div>l0</div><div>l1</div><div>l2</div><div>l3</div>" +
		"<div style=\"border:1px solid;width:12px\">alpha</div>" +
		"<div style=\"border:1px solid;width:8px;margin-top:-1px\">beta</div>" +
		"<div>t0</div><div>t1</div><div>t2</div><div>t3</div>";
	const terminal = new MockProcess({cols: 30, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	for (let target = 1; target <= 6; target++) {
		dom.window.scrollTo(0, target);
		await nextFrame(dom);
		const fresh = new MockProcess({cols: 30, rows: 6});
		const freshDOM = new TermDOM({transport: fresh.transport});
		freshDOM.document.body.innerHTML = html;
		freshDOM.window.scrollTo(0, target);
		await nextFrame(freshDOM);
		expect(terminal.getPlainText()).toEqual(fresh.getPlainText());
		freshDOM.dispose();
	}
	dom.dispose();
});

test("scrolling the document fires scroll on the document and the window", async () => {
	const terminal = new MockProcess({cols: 40, rows: 5});
	const dom = new TermDOM({transport: terminal.transport});
	const {window, document} = dom;
	document.body.innerHTML = Array.from(
		{length: 30},
		(_, i) => `<div>${i}</div>`,
	).join("");
	await nextFrame(dom);

	const seen: string[] = [];
	document.addEventListener("scroll", (e) =>
		seen.push(`document:${e.target === document}`),
	);
	window.addEventListener("scroll", (e) =>
		seen.push(`window:${e.target === document}`),
	);
	window.scrollBy(0, 3);
	expect(seen).toEqual([]);
	await nextFrame(dom);
	expect(seen).toEqual(["document:true", "window:true"]);

	// Two moves in one frame are one event; a frame with no move fires none.
	window.scrollBy(0, 1);
	window.scrollTo(0, 10);
	await nextFrame(dom);
	document.body.appendChild(document.createElement("div"));
	await nextFrame(dom);
	expect(seen.length).toBe(4);
	dom.dispose();
});

test("scrolling a box fires scroll on the box, without bubbling", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {window, document} = dom;
	document.body.innerHTML =
		"<div id=\"box\" style=\"height: 3px; overflow-y: auto\">" +
		Array.from({length: 20}, (_, i) => `<div>${i}</div>`).join("") +
		"</div>";
	await nextFrame(dom);
	const box = document.getElementById("box")!;

	const seen: string[] = [];
	box.addEventListener("scroll", () => seen.push("box"));
	document.addEventListener("scroll", () => seen.push("document"));
	window.addEventListener("scroll", () => seen.push("window"));
	box.scrollTop = 5;
	await nextFrame(dom);
	expect(seen).toEqual(["box"]);

	box.scrollTop = 5;
	await nextFrame(dom);
	expect(seen).toEqual(["box"]);
	dom.dispose();
});
