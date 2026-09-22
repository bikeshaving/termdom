/**
 * position: fixed anchors to the VIEWPORT: the camera scrolls the document
 * underneath it, offsets resolve against the terminal's dimensions, and the
 * box never moves. The painter's camera-cancel and hit-testing's coordinate
 * conversion always assumed this; layout now provides it -- fixed boxes
 * hoist to the terminal-sized viewport root, not the document root.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils";

function makeTallDoc(dom: TermDOM): void {
	dom.document.body.innerHTML =
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%;background-color:#333\">STATUS" +
		"<span id=\"pct\" style=\"position:absolute;right:1ch;top:0\">42%</span></div>";
}

test("a fixed bottom bar sits on the viewport's last row, unscrolled", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	makeTallDoc(dom);
	await nextFrame(dom);

	const rows = terminal.getVisibleText().split("\n");
	expect(rows[9]).toContain("STATUS");
	expect(rows[0]).toContain("row 0");
	dom.dispose();
});

test("the bar stays pinned while the camera scrolls", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	makeTallDoc(dom);
	await nextFrame(dom);

	dom.window.scrollBy(0, 12);
	await nextFrame(dom);

	const rows = terminal.getVisibleText().split("\n");
	expect(rows[9]).toContain("STATUS");
	// An absolute box INSIDE the fixed subtree rides with it: fixed-space is
	// a property of the containing-block chain, not of the one element.
	expect(rows[9]).toContain("42%");
	expect(rows[0]).toContain("row 12");
	// The bar's rect is viewport-relative and scroll-invariant, per spec.
	const rect = dom.document.getElementById("bar")!.getBoundingClientRect();
	expect(rect.top).toBe(9);
	dom.dispose();
});

test("a fixed bar inside a scrolled fullscreen scroller stays on the last row", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS</div>" +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	await pane.requestFullscreen();
	await nextFrame(dom);
	pane.scrollTop = 7;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("row 7");
	expect(rows[9]).toContain("STATUS");
	const bar = dom.document.getElementById("bar")!;
	expect(bar.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(2, 9)).toBe(bar);
	dom.dispose();
});
