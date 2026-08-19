/**
 * getBoundingClientRect()/getClientRects() are viewport-relative per CSSOM
 * View -- previously document-relative (rect.top grew forever with scroll
 * instead of going negative once an element scrolled above the viewport).
 *
 * Fixing the public rect had to be paired with three internal callers that
 * depend on the *document*-relative rect the layout engine's own
 * getRect()/getRects() still return (rendering works in that space, one
 * camera offset applied at paint time, not per element): scrollIntoView,
 * mouse hit-testing, and document.elementFromPoint's internal traversal. This
 * corpus exercises the public/internal split from both directions -- the
 * public API's new coordinate space, and that the internal callers still
 * work correctly at both scroll positions.
 */

import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function makeOverflowingApp(rows = 5, lines = 20) {
	const terminal = new MockProcess({cols: 40, rows});
	const dom = new TermDOM({transport: terminal.transport});
	for (let i = 0; i < lines; i++) {
		const div = dom.document.createElement("div");
		div.id = `line${i}`;
		div.textContent = `line ${i}`;
		dom.document.body.appendChild(div);
	}
	return {terminal, dom};
}

test("getBoundingClientRect().top shifts by the scroll amount", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	const target = dom.document.getElementById("line10")!;
	expect(target.getBoundingClientRect().top).toBe(10);

	dom.window.scrollTo(0, 5);
	await nextFrame(dom);
	expect(target.getBoundingClientRect().top).toBe(5);
	dom.dispose();
});

test("an element scrolled above the viewport has a negative rect.top", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.window.scrollTo(0, 5);
	await nextFrame(dom);
	const above = dom.document.getElementById("line0")!;
	expect(above.getBoundingClientRect().top).toBe(-5);
	dom.dispose();
});

test("getClientRects() applies the same viewport conversion", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.window.scrollTo(0, 5);
	await nextFrame(dom);
	const target = dom.document.getElementById("line10")!;
	const rects = Array.from(target.getClientRects());
	expect(rects.length).toBeGreaterThan(0);
	expect(rects[0].top).toBe(5);
	dom.dispose();
});

test("a disconnected element's rect is still a zero rect, not NaN from an unset scroll offset", () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const div = dom.document.createElement("div");
	const rect = div.getBoundingClientRect();
	expect(rect.top).toBe(0);
	expect(rect.width).toBe(0);
	dom.dispose();
});

test("mouse click hit-testing still targets the right element while scrolled", async () => {
	const {terminal, dom} = makeOverflowingApp();
	await nextFrame(dom);
	dom.attach();

	const clicked: string[] = [];
	dom.document.body.addEventListener("mousedown", (e: any) => {
		clicked.push((e.target as Element).id);
	});

	// Row 3 (1-based) at the top -> line2 (0-based row index 2).
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<0;1;3M"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(clicked.pop()).toBe("line2");

	// Same terminal row after scrolling down 5 -> a different document element
	// (line7), proving hit-testing reads live document position, not a rect
	// frozen in the old (always-growing) document-relative convention.
	dom.window.scrollTo(0, 5);
	await nextFrame(dom);
	(terminal.stdin as any).emit("data", Buffer.from("\x1b[<0;1;3M"));
	await new Promise((r) => setTimeout(r, 0));
	await nextFrame(dom);
	expect(clicked.pop()).toBe("line7");
	dom.dispose();
});

test("document.elementFromPoint takes viewport-relative coordinates, per spec", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	dom.window.scrollTo(0, 5);
	await nextFrame(dom);
	// Viewport row 2 + 5 scrolled = document row 7.
	expect(dom.document.elementFromPoint(0, 2)?.id).toBe("line7");
	dom.dispose();
});

test("scrollIntoView still brings an off-screen element into view", async () => {
	const {dom} = makeOverflowingApp();
	await nextFrame(dom);

	const target = dom.document.getElementById("line15")!;
	target.scrollIntoView();
	await nextFrame(dom);

	// "nearest" block alignment: the camera moves the minimum amount that
	// brings the element's bottom into the 5-row viewport.
	expect(dom.window.scrollY).toBe(11); // line15's bottom (16) - 5 rows
	const rect = target.getBoundingClientRect();
	expect(rect.top).toBeGreaterThanOrEqual(0);
	expect(rect.bottom).toBeLessThanOrEqual(5);
	dom.dispose();
});

test("an element's own scrollLeft shifts its descendants, distinct from the camera", async () => {
	const terminal = new MockProcess({cols: 40, rows: 5});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div id=\"s\" style=\"overflow:hidden; width:5px\"><span id=\"c\">abcdefghij</span></div>";
	await nextFrame(dom);

	const content = dom.document.getElementById("c")!;
	const left0 = content.getBoundingClientRect().left;

	// Per-element scroll is a document-space content offset the layout applies,
	// separate from the document camera. A rect read flushes layout itself and
	// reads scrollLeft live, so the child's box shifts left with no repaint.
	dom.document.getElementById("s")!.scrollLeft = 3;
	expect(content.getBoundingClientRect().left).toBe(left0 - 3);
	dom.dispose();
});
