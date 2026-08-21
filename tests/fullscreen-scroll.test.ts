/**
 * The document camera inside a fullscreen element.
 *
 * A fullscreen element is the viewport for its content: its box is pinned
 * to the screen at row zero, its in-flow descendants scroll with the
 * camera (window.scrollTo/scrollBy), and a position:fixed descendant pins
 * to the screen while the content moves under it. The camera clamps to
 * the fullscreen content's height, scrollIntoView reveals descendants by
 * moving it, and hit-testing resolves to what a scrolled cell shows.
 */

import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils";

/**
 * A fullscreen stage taller than the 6-row screen: a pinned status bar
 * over sixteen one-row lines, L00 through L15.
 */
async function mountStage(): Promise<{
	terminal: MockProcess;
	dom: TermDOM;
	rows: () => string[];
}> {
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const lines = Array.from(
		{length: 16},
		(_, i) => `<div id="L${String(i).padStart(2, "0")}">` +
			`L${String(i).padStart(2, "0")} content</div>`,
	).join("");
	document.body.innerHTML =
		"<div id=\"fs\">" +
		"<div id=\"bar\" style=\"position: fixed; top: 0; left: 0\">STATUS</div>" +
		lines +
		"</div>";
	await nextFrame(dom);
	await document.getElementById("fs")!.requestFullscreen();
	await nextFrame(dom);
	return {
		terminal,
		dom,
		rows: () => terminal.getPlainText().split("\n"),
	};
}

test("the camera scrolls fullscreen content under a pinned fixed bar", async () => {
	const {dom, rows} = await mountStage();

	// Before any scroll: content from the top, the bar over row zero.
	expect(rows()[0]).toContain("STATUS");
	expect(rows().join("\n")).toContain("L01");
	expect(rows().join("\n")).toContain("L05");
	expect(rows().join("\n")).not.toContain("L08");

	dom.window.scrollBy(0, 3);
	await nextFrame(dom);

	// The content moved up three rows; the bar did not move.
	expect(rows()[0]).toContain("STATUS");
	expect(rows().join("\n")).toContain("L05");
	expect(rows().join("\n")).toContain("L08");
	expect(rows().join("\n")).not.toContain("L02");

	dom.dispose();
});

test("the camera clamps to the fullscreen content height", async () => {
	const {dom, rows} = await mountStage();

	dom.window.scrollTo(0, 999);
	await nextFrame(dom);

	// Sixteen content rows in a 6-row screen: the camera stops at 10.
	expect(dom.window.scrollY).toBe(10);
	expect(rows()[0]).toContain("STATUS");
	expect(rows().join("\n")).toContain("L15");
	expect(rows().join("\n")).not.toContain("L09");

	dom.dispose();
});

test("scrollIntoView reveals a deep fullscreen descendant", async () => {
	const {dom, rows} = await mountStage();
	const {document} = dom;

	document.getElementById("L12")!.scrollIntoView();
	await nextFrame(dom);

	expect(dom.window.scrollY).toBe(7);
	expect(rows().join("\n")).toContain("L12");
	expect(rows()[0]).toContain("STATUS");

	dom.dispose();
});

test("elementFromPoint resolves what a scrolled fullscreen cell shows", async () => {
	const {dom} = await mountStage();
	const {document} = dom;

	dom.window.scrollTo(0, 7);
	await nextFrame(dom);

	// Screen row 3 shows document row 10; row 0 is the pinned bar.
	expect(document.elementFromPoint(1, 3)?.id).toBe("L10");
	expect(document.elementFromPoint(1, 0)?.id).toBe("bar");

	dom.dispose();
});

test("the document's scroll position survives a fullscreen session", async () => {
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	const {document} = dom;
	const lines = Array.from({length: 12}, (_, i) => `<div>doc ${i}</div>`);
	document.body.innerHTML = lines.join("") + "<div id=\"fs\">stage</div>";
	await nextFrame(dom);

	dom.window.scrollTo(0, 4);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(4);

	await document.getElementById("fs")!.requestFullscreen();
	await nextFrame(dom);
	// Fullscreen starts its viewport at the top.
	expect(dom.window.scrollY).toBe(0);

	await document.exitFullscreen();
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(4);

	dom.dispose();
});
