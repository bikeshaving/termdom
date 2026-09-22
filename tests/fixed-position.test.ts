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

test("a fixed bar inside a plain scrolled scroller stays on the last row", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:6px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS</div>" +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	pane.scrollTop = 4;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("row 4");
	expect(rows[9]).toContain("STATUS");
	const bar = dom.document.getElementById("bar")!;
	expect(bar.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(2, 9)).toBe(bar);
	dom.dispose();
});

test("a fixed box ignores scrollLeft on the scroller above it", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"width:20ch;overflow-x:auto;white-space:nowrap\">" +
		"<div style=\"width:60ch\">0123456789012345678901234567890123456789</div>" +
		"<div id=\"tag\" style=\"position:fixed;top:0;left:0\">TAG</div>" +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	pane.scrollLeft = 5;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0].startsWith("TAG")).toBe(true);
	const tag = dom.document.getElementById("tag")!;
	expect(tag.getBoundingClientRect().left).toBe(0);
	expect(dom.document.elementFromPoint(1, 0)).toBe(tag);
	dom.dispose();
});

test("an absolute box inside a fixed bar rides with it under a scroller", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:10px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS" +
		"<span id=\"pct\" style=\"position:absolute;right:1ch;top:0\">42%</span></div>" +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	pane.scrollTop = 6;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[9]).toContain("STATUS");
	expect(rows[9]).toContain("42%");
	const pct = dom.document.getElementById("pct")!;
	expect(pct.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(37, 9)).toBe(pct);
	dom.dispose();
});

test("a fixed box under nested scrollers ignores both", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"outer\" style=\"height:8px;overflow-y:auto\">" +
		"<div>outer top</div>" +
		"<div id=\"inner\" style=\"height:5px;overflow-y:auto\">" +
		Array.from({length: 20}, (_, i) => `<div>inner ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS</div>" +
		"</div>" +
		Array.from({length: 20}, (_, i) => `<div>outer ${i}</div>`).join("") +
		"</div>";
	await nextFrame(dom);
	dom.document.getElementById("outer")!.scrollTop = 1;
	dom.document.getElementById("inner")!.scrollTop = 3;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("inner 3");
	expect(rows[9]).toContain("STATUS");
	const bar = dom.document.getElementById("bar")!;
	expect(bar.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(2, 9)).toBe(bar);
	dom.dispose();
});

test("a fixed box that scrolls still moves its own content", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:10px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"panel\" style=\"position:fixed;top:0;left:0;width:100%;height:3px;overflow-y:auto\">" +
		Array.from({length: 8}, (_, i) => `<div>line ${i}</div>`).join("") +
		"</div>" +
		"</div>";
	await nextFrame(dom);
	dom.document.getElementById("pane")!.scrollTop = 5;
	dom.document.getElementById("panel")!.scrollTop = 2;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("line 2");
	expect(rows[2]).toContain("line 4");
	expect(rows[3]).toContain("row 8");
	expect(dom.document.elementFromPoint(2, 1)!.textContent).toBe("line 3");
	dom.dispose();
});

test("a fixed bar under a scroller stays put while the camera scrolls too", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		Array.from({length: 5}, (_, i) => `<div>lead ${i}</div>`).join("") +
		"<div id=\"pane\" style=\"height:6px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"bar\" style=\"position:fixed;bottom:0;left:0;width:100%\">STATUS</div>" +
		"</div>" +
		Array.from({length: 20}, (_, i) => `<div>tail ${i}</div>`).join("");
	await nextFrame(dom);
	dom.document.getElementById("pane")!.scrollTop = 3;
	dom.window.scrollBy(0, 4);
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("lead 4");
	expect(rows[1]).toContain("row 3");
	expect(rows[9]).toContain("STATUS");
	const bar = dom.document.getElementById("bar")!;
	expect(bar.getBoundingClientRect().top).toBe(9);
	expect(dom.document.elementFromPoint(2, 9)).toBe(bar);
	dom.dispose();
});
