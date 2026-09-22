/**
 * position: sticky lays the box out in flow, then shifts it, as far as the
 * box it flows in allows, so its insets hold against the nearest
 * scrollport: an element scroller above it, or the viewport.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils";

function makeSections(...rows: number[]): string {
	return rows
		.map(
			(count, s) =>
				`<section id="s${s}"><h2 id="h${s}" style="position:sticky;top:0">Heading ${s}</h2>` +
		Array.from({length: count}, (_, i) => `<div>s${s} row ${i}</div>`)
			.join("") +
		"</section>",
		)
		.join("");
}

test("a sticky heading holds the top of a scrolled element scroller", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:8px;overflow-y:auto\">" +
		makeSections(20) +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	pane.scrollTop = 5;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("Heading 0");
	expect(rows[1]).toContain("s0 row 5");
	const heading = dom.document.getElementById("h0")!;
	expect(heading.getBoundingClientRect().top).toBe(0);
	expect(dom.document.elementFromPoint(2, 0)).toBe(heading);
	dom.dispose();
});

test("a sticky heading holds the top of the viewport while the camera scrolls", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = makeSections(30);
	await nextFrame(dom);
	dom.window.scrollBy(0, 10);
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("Heading 0");
	expect(rows[1]).toContain("s0 row 10");
	expect(dom.document.getElementById("h0")!.getBoundingClientRect().top).toBe(
		0,
	);
	dom.dispose();
});

test("a sticky box never leaves the box it flows in", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:8px;overflow-y:auto\">" +
		makeSections(6, 20) +
		"</div>";
	await nextFrame(dom);
	const pane = dom.document.getElementById("pane")!;
	// Section 0 is 7 rows tall. Scrolled 6, its heading sits on its last row,
	// pushed up by the section's end rather than pinned at the top.
	pane.scrollTop = 6;
	await nextFrame(dom);
	let rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("Heading 0");
	expect(rows[1]).toContain("Heading 1");
	// One more row and section 1's heading takes over.
	pane.scrollTop = 7;
	await nextFrame(dom);
	rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("Heading 1");
	expect(rows[1]).toContain("s1 row 0");
	dom.dispose();
});

test("a sticky footer holds the bottom of the scrollport", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:8px;overflow-y:auto\">" +
		Array.from({length: 20}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"foot\" style=\"position:sticky;bottom:0\">FOOTER</div>" +
		"</div>";
	await nextFrame(dom);
	let rows = terminal.getVisibleText().split("\n");
	expect(rows[7]).toContain("FOOTER");
	expect(rows[6]).toContain("row 6");
	const pane = dom.document.getElementById("pane")!;
	pane.scrollTop = 13;
	await nextFrame(dom);
	rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("row 13");
	expect(rows[7]).toContain("FOOTER");
	expect(dom.document.getElementById("foot")!.getBoundingClientRect().top).toBe(
		7,
	);
	dom.dispose();
});

test("a sticky inset in a percentage resolves against the scrollport", async () => {
	const terminal = new MockProcess({cols: 30, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:10px;overflow-y:auto\">" +
		"<div id=\"bar\" style=\"position:sticky;top:20%\">BAR</div>" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"</div>";
	await nextFrame(dom);
	dom.document.getElementById("pane")!.scrollTop = 8;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[2]).toContain("BAR");
	dom.dispose();
});

test("an absolute box inside a sticky one rides with it", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"pane\" style=\"height:8px;overflow-y:auto\">" +
		"<div id=\"bar\" style=\"position:sticky;top:0\">BAR" +
		"<span id=\"pct\" style=\"position:absolute;right:1ch;top:0\">42%</span></div>" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"</div>";
	await nextFrame(dom);
	dom.document.getElementById("pane")!.scrollTop = 9;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[0]).toContain("BAR");
	expect(rows[0]).toContain("42%");
	expect(dom.document.getElementById("pct")!.getBoundingClientRect().top).toBe(
		0,
	);
	dom.dispose();
});

test("an absolute box ignores a scroller outside its containing block", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"frame\" style=\"position:relative;height:8px\">" +
		"<div id=\"pane\" style=\"height:8px;overflow-y:auto\">" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("") +
		"<div id=\"tag\" style=\"position:absolute;top:2px;left:0\">TAG</div>" +
		"</div></div>";
	await nextFrame(dom);
	dom.document.getElementById("pane")!.scrollTop = 10;
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	expect(rows[2]).toContain("TAG");
	const tag = dom.document.getElementById("tag")!;
	expect(tag.getBoundingClientRect().top).toBe(2);
	expect(dom.document.elementFromPoint(1, 2)).toBe(tag);
	dom.dispose();
});
