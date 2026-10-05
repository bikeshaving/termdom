/**
 * Table layout tests.
 *
 * Tables had no tests at all: the only table-ish case in the suite drew
 * collapsed borders directly into a ScreenBuffer and never constructed a
 * <table>. So "table support" was backed by nothing executable, and the
 * implementation turned out to be a flex approximation -- a flex row per <tr>
 * with `flex: 1` cells -- which structurally cannot produce the one property
 * that makes a table a table:
 *
 *   a column's width is decided by every cell in it, across every row.
 *
 * These tests assert that property and the things that follow from it. The
 * expectations come from CSS table semantics, not from the implementation.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame, stripControlCodes} from "./test-utils.js";

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

async function render(
	html: string,
	cols = 60,
): Promise<{
	box: (selector: string, index?: number) => Box;
	rows: string[];
	dom: TermDOM;
	document: Document;
}> {
	const terminal = new MockProcess({cols, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);

	const box = (selector: string, index = 0): Box => {
		const element = dom.document.querySelectorAll(selector)[index];
		const rect = element.getBoundingClientRect();
		return {
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
		};
	};

	const rows = stripControlCodes(terminal.getStaticANSI())
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.length > 0);

	return {box, rows, dom, document: dom.document};
}

test("columns are shared: a cell's width is decided across every row", async () => {
	// This is the defining property. Under the old flex emulation each row
	// divided the width on its own, so a narrow cell in row 2 did not line up
	// with the wide cell above it.
	const {box, dom} = await render(
		`<table style="width:40ch">
			<tr><td>ID</td><td>a much longer description</td></tr>
			<tr><td>7</td><td>x</td></tr>
		</table>`,
	);

	const topLeft = box("td", 0);
	const topRight = box("td", 1);
	const bottomLeft = box("td", 2);
	const bottomRight = box("td", 3);

	expect(bottomLeft.left).toBe(topLeft.left);
	expect(bottomLeft.width).toBe(topLeft.width);
	expect(bottomRight.left).toBe(topRight.left);
	expect(bottomRight.width).toBe(topRight.width);

	dom.dispose();
});

test("columns are sized to their content, not split evenly", async () => {
	// "ID" is far narrower than the description, so its column must be too.
	const {box, dom} = await render(
		`<table style="width:40ch">
			<tr><td>ID</td><td>a much longer description</td></tr>
		</table>`,
	);

	const narrow = box("td", 0);
	const wide = box("td", 1);

	expect(narrow.width).toBeLessThan(wide.width);
	dom.dispose();
});

test("a table with width auto shrink-wraps instead of filling its container", async () => {
	// A browser renders this a dozen or so cells wide, not the full viewport.
	const {box, dom} = await render(
		"<table><tr><td>a</td><td>b</td></tr></table>",
		60,
	);

	const table = box("table");
	expect(table.width).toBeLessThan(20);
	dom.dispose();
});

test("an explicit width on a cell fixes its column", async () => {
	// The surplus has to go to the auto column: a fixed column keeps its width.
	const {box, dom} = await render(
		`<table style="width:30ch">
			<tr><td style="width:8ch">a</td><td>b</td></tr>
		</table>`,
	);

	expect(box("td", 0).width).toBe(8);
	dom.dispose();
});

test("colspan makes a cell span its columns, and the rest still line up", async () => {
	const {box, dom} = await render(
		`<table style="width:36ch">
			<tr><td colspan="2">wide</td><td>c</td></tr>
			<tr><td>a</td><td>b</td><td>c</td></tr>
		</table>`,
	);

	const spanning = box("td", 0);
	const first = box("td", 2);
	const second = box("td", 3);
	const third = box("td", 4);

	// The spanning cell starts where column 1 starts and ends where column 2
	// ends. Collapsed borders make the two columns share one cell of border, so
	// the span is one narrower than the sum.
	expect(spanning.left).toBe(first.left);
	expect(spanning.width).toBe(first.width + second.width - 1);

	// And the unspanned cell in row 1 lines up with column 3 below it.
	expect(box("td", 1).left).toBe(third.left);
	dom.dispose();
});

test("rowspan makes a cell cover its rows", async () => {
	const {box, dom} = await render(
		`<table style="width:30ch">
			<tr><td rowspan="2">tall</td><td>b</td></tr>
			<tr><td>d</td></tr>
		</table>`,
	);

	const tall = box("td", 0);
	const upper = box("td", 1);
	const lower = box("td", 2);

	// The spanning cell reaches from the top of the first row to the bottom of
	// the second, sharing one row of border between them.
	expect(tall.height).toBe(upper.height + lower.height - 1);
	// And the next row's cell flows past the occupied slot, not under it.
	expect(lower.left).toBe(upper.left);
	dom.dispose();
});

test("a span is the attribute's own clamp: 1000 columns at most", async () => {
	// HTML caps colspan at 1000, which is what the reflected colSpan hands
	// back. A cell asking for 5000 columns therefore builds the same
	// thousand-column table a cell asking for 1000 builds, and every row is
	// laid out over those thousand columns.
	const table = async (span: string) => {
		const {box, dom, document} = await render(
			`<table style="width:40ch">
				<tr><td colspan="${span}">a</td></tr>
				<tr><td>b</td><td>c</td></tr>
			</table>`,
		);
		const colSpan = (document.querySelector("td") as any).colSpan as number;
		const row = [box("td", 1), box("td", 2)];
		dom.dispose();
		return {colSpan, row};
	};

	const asked = await table("5000");
	const capped = await table("1000");

	// Columns no cell starts or ends in take no space, so the layout is the
	// same however many there are; the reflected span is what shows the
	// clamp.
	expect(asked.colSpan).toBe(1000);
	expect(asked.row).toEqual(capped.row);
});

test("rowspan=\"0\" covers one row, not the rest of its row group", async () => {
	// HTML says rowspan="0" spans to the end of the row group. This table
	// algorithm has no such reach, and the layout clamps the zero the
	// reflected rowSpan hands it back up to one: a known gap, written down
	// rather than parsed away.
	const {box, dom} = await render(
		`<table style="width:30ch">
			<tr><td rowspan="0">tall</td><td>b</td></tr>
			<tr><td>d</td></tr>
		</table>`,
	);

	const tall = box("td", 0);
	const upper = box("td", 1);
	expect(tall.height).toBe(upper.height);
	dom.dispose();
});

test("tfoot renders after the body even when written before it", async () => {
	// display: table-footer-group is placed after the row groups, whatever the
	// source order.
	const {box, dom} = await render(
		`<table style="width:20ch">
			<thead><tr><th>H</th></tr></thead>
			<tfoot><tr><td>F</td></tr></tfoot>
			<tbody><tr><td>B</td></tr></tbody>
		</table>`,
	);

	const header = box("th", 0);
	const footer = box("tfoot td", 0);
	const body = box("tbody td", 0);

	expect(header.top).toBeLessThan(body.top);
	expect(body.top).toBeLessThan(footer.top);
	dom.dispose();
});

test("an empty row does not collapse the rows around it", async () => {
	// An empty <tr> has no height and so no border to share. Letting it consume
	// a collapse overlap pulled every later row up by one, landing their text on
	// top of the row above.
	const {box, rows, dom} = await render(
		`<table style="width:20ch">
			<tbody>
				<tr><td>a</td><td>b</td></tr>
				<tr></tr>
				<tr><td>c</td><td>d</td></tr>
			</tbody>
		</table>`,
	);

	const first = box("td", 0);
	const third = box("td", 2);

	expect(third.top).toBeGreaterThanOrEqual(first.top + first.height - 1);
	expect(rows.some((row) => row.includes("a") && row.includes("b"))).toBe(true);
	expect(rows.some((row) => row.includes("c") && row.includes("d"))).toBe(true);
	dom.dispose();
});

test("a caption renders above the table", async () => {
	const {box, rows, dom} = await render(
		`<table style="width:20ch">
			<caption>CAPTION</caption>
			<tbody><tr><td>1</td><td>2</td></tr></tbody>
		</table>`,
	);

	expect(rows[0]).toContain("CAPTION");
	expect(box("caption").top).toBeLessThan(box("td", 0).top);
	dom.dispose();
});

test("wide characters do not break column alignment", async () => {
	// Column widths are in cells, so a CJK cell is measured at two cells per
	// character and the columns still tile.
	const {box, dom} = await render(
		`<table style="width:30ch">
			<tr><td>中文字</td><td>x</td></tr>
			<tr><td>ab</td><td>y</td></tr>
		</table>`,
	);

	expect(box("td", 2).left).toBe(box("td", 0).left);
	expect(box("td", 3).left).toBe(box("td", 1).left);
	dom.dispose();
});

test("cells tile the table exactly, with no gap or overlap", async () => {
	// Collapsed borders mean each cell after the first starts exactly on its
	// neighbour's last column: they share the one cell they both draw a border
	// in.
	const {box, dom} = await render(
		`<table style="width:31ch">
			<tr><td>a</td><td>b</td><td>c</td></tr>
		</table>`,
	);

	const first = box("td", 0);
	const second = box("td", 1);
	const third = box("td", 2);
	const table = box("table");

	expect(second.left).toBe(first.left + first.width - 1);
	expect(third.left).toBe(second.left + second.width - 1);
	expect(third.left + third.width).toBe(table.left + table.width);
	dom.dispose();
});

test("border junctions reflect where lines actually continue", async () => {
	// A colspan above two columns, a rowspan beside them, and a colspan below.
	// Each boundary must render the junction for the lines that meet there --
	// not a cross, which is what edge-membership border bits always produced.
	const {rows, dom} = await render(
		`<table style="border-collapse:collapse; width:44ch">
			<tbody>
				<tr><td colspan="3">Quarterly Report</td></tr>
				<tr><td rowspan="2">Region</td><td>North</td><td>120</td></tr>
				<tr><td>South</td><td>90</td></tr>
				<tr><td>Total</td><td colspan="2">210</td></tr>
			</tbody>
		</table>`,
		50,
	);

	const junctions = rows.filter((row) => /[┬┴┼├┤]/.test(row));

	// Below the full-width colspan the columns begin: the line runs left-right
	// and turns down, so ┬ -- there is nothing above it to join.
	expect(junctions[0]).toContain("┬");
	expect(junctions[0]).not.toContain("┼");

	// At the rowspan's boundary the vertical continues past a horizontal that
	// only arrives from the right: ├.
	expect(junctions[1]).toContain("├");

	// Above the colspan at the bottom, two columns merge into one: ┴.
	expect(junctions[2]).toContain("┴");

	dom.dispose();
});

test("a long word widens its column instead of overflowing into the next cell", async () => {
	// A column is never narrower than its cells' min-content width -- the longest
	// word they contain. Without that floor the word simply carried on painting:
	// it overwrote the cell border and the first characters of its neighbour.
	const {box, rows, dom} = await render(
		`<table style="width:20ch">
			<tr><td>abcdefghijklmno</td><td>x</td></tr>
			<tr><td>a</td><td>b</td></tr>
		</table>`,
		40,
	);

	const wide = box("td", 0);
	const narrow = box("td", 1);

	// 15 cells of word, 1 of padding each side, 1 of border each side.
	expect(wide.width).toBe(19);
	// The neighbour starts where it ends (sharing one collapsed border), so
	// nothing is painted over.
	expect(narrow.left).toBe(wide.left + wide.width - 1);

	// And the word survives intact.
	expect(rows.some((row) => row.includes("abcdefghijklmno"))).toBe(true);
	dom.dispose();
});

// A sizing pass over a table inside a table writes its own results over
// the cells, so the layout placed before it cannot be reused afterwards.
test("a percent table inside a block in a nested table sizes its cells to itself", () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 80, rows: 24}).transport,
	});
	const text =
		"Lorem ipsum dolor sit amet consectetur adipiscing elit sed do " +
		"eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim";
	dom.document.body.innerHTML =
		`<table><tr><td><table width="40"><tr><td><div>` +
		`<table id="t" width="100%"><tr><td id="c"><p>${text}</p></td></tr>` +
		"</table></div></td></tr></table></td></tr></table>";
	const width = (id: string) =>
		dom.document.getElementById(id)!.getBoundingClientRect().width;
	expect(width("c")).toBe(width("t"));
	dom.dispose();
});

test("rows share a collapsed border only where both sides draw one", async () => {
	const {box, dom} = await render(
		`<style>td, th { border: none }</style>
		<table style="width: 40ch">
			<tr><th style="border-bottom: 1px solid">Head A</th><th>Head B</th></tr>
			<tr><td>Description</td><td>Amount</td></tr>
		</table>`,
	);
	// The heading's border line is its own; the next row starts below it.
	expect(box("th", 0).height).toBe(2);
	expect(box("td", 0).top).toBe(2);
	dom.dispose();
});

test("a cell's content sits in the middle of its row by default", async () => {
	const {box, dom, document} = await render(
		`<style>td { border: none }</style>
		<table style="width: 40ch"><tr>
			<td style="padding: 1px 0">Description</td><td id="b">Amount</td>
		</tr></table>`,
	);
	expect(
		(document.defaultView as Window).getComputedStyle(
			document.getElementById("b")!,
		).verticalAlign,
	).toBe("middle");
	expect(box("td", 1).height).toBe(3);
	const amount = document.getElementById("b")!.firstChild!;
	const range = document.createRange();
	range.selectNodeContents(amount);
	expect(range.getBoundingClientRect().top).toBe(box("td", 1).top + 1);
	dom.dispose();
});

// CSS 2.1 §17.5.3: baseline cells line up their first lines.
test("baseline cells in a row line up their first lines", async () => {
	const {dom, document} = await render(
		`<style>td { border: none; vertical-align: baseline }</style>
		<table><tr>
			<td style="padding: 2px 0">padded</td>
			<td id="plain">plain</td>
			<td style="padding-top: 1px">one</td>
		</tr></table>`,
	);
	const top = (text: string) => {
		const cell = [...document.querySelectorAll("td")].find((td) =>
			td.textContent === text,
		)!;
		const range = document.createRange();
		range.selectNodeContents(cell.firstChild!);
		return range.getBoundingClientRect().top;
	};
	expect(top("plain")).toBe(top("padded"));
	expect(top("one")).toBe(top("padded"));
	dom.dispose();
});

// CSS 2.1 §17.5.4: a vertical-align other than top, middle, bottom and
// baseline does not apply to a cell, which aligns at the baseline.
test("a cell with another vertical-align aligns at the baseline", async () => {
	const {dom, document} = await render(
		`<style>td { border: none }</style>
		<table><tr>
			<td style="padding: 2px 0; vertical-align: baseline">padded</td>
			<td style="vertical-align: sub">sub</td>
		</tr></table>`,
	);
	const top = (text: string) => {
		const cell = [...document.querySelectorAll("td")].find((td) =>
			td.textContent === text,
		)!;
		const range = document.createRange();
		range.selectNodeContents(cell.firstChild!);
		return range.getBoundingClientRect().top;
	};
	expect(top("sub")).toBe(top("padded"));
	dom.dispose();
});

// Each table measures its cells and then places them once. Placing them
// in the measuring pass too, or measuring a table afresh for every size
// its owner tried, multiplied the work at each level: 63 levels of spam
// email hung the process.
test("deeply nested tables lay out in time that grows with their number", () => {
	const terminal = new MockProcess({cols: 200, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	for (const width of ["auto", "100%"]) {
		let html = "x";
		for (let i = 0; i < 63; i++) {
			html = `<table style="width: ${width}"><tr><td>${html}</td></tr></table>`;
		}
		const start = performance.now();
		const output = dom.renderANSI(html);
		expect(performance.now() - start).toBeLessThan(5000);
		expect(stripControlCodes(output)).toContain("x");
	}
	dom.dispose();
});

// A table tries what it holds at several widths, and a table inside it
// tries its own cells at several widths for each of those.
test("nested centered tables lay out without measuring each level anew", () => {
	const terminal = new MockProcess({cols: 200, rows: 10});
	const dom = new TermDOM({
		transport: terminal.transport,
		cellSize: {width: 7, height: 15},
	});
	let html = "x y z";
	for (let i = 0; i < 14; i++) {
		html =
			"<center><table width=\"90%\"><tr><td align=\"center\" " +
			`style="padding: 4px">${html}</td></tr></table></center>`;
	}
	const start = performance.now();
	const output = dom.renderANSI(html);
	expect(performance.now() - start).toBeLessThan(2000);
	expect(stripControlCodes(output)).toContain("x y z");
	dom.dispose();
});

// A cell's percentage width is of its table, not of what holds the table.
test("a 100% cell fills a fixed-width table, not the table's container", () => {
	const terminal = new MockProcess({cols: 120, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<div style=\"width: 90px\"><table id=\"t\" style=\"width: 60px; " +
		"border-collapse: collapse\"><tr><td id=\"c\" style=\"width: 100%; " +
		"padding: 0; border: none\">words that wrap inside the card</td></tr>" +
		"</table></div>";
	const width = (id: string) =>
		document.getElementById(id)!.getBoundingClientRect().width;
	expect(width("t")).toBe(60);
	expect(width("c")).toBe(60);
	dom.dispose();
});

// A cell's padding is its own. The UA sheet gives cells a column either
// side; an author's padding: 0 takes it away.
test("a cell with padding 0 holds content edge to edge", () => {
	const terminal = new MockProcess({cols: 120, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<table><tr><td id=\"bare\" style=\"width: 70px; padding: 0; border: 0\">" +
		"<div id=\"a\">plain</div></td><td id=\"ua\"><div id=\"b\">ua</div></td>" +
		"</tr></table>";
	const rect = (id: string) =>
		document.getElementById(id)!.getBoundingClientRect();
	expect([rect("a").left - rect("bare").left, rect("a").width])
		.toEqual([0, 70]);
	expect(rect("b").left - rect("ua").left).toBe(2);
	dom.dispose();
});

// A block in a row is no cell, so it stands in an anonymous one, which
// sizes with the columns. The block fills it up to its own width limits,
// centered by its auto margins.
test("a block in a table row lays out in an anonymous cell", () => {
	const terminal = new MockProcess({cols: 120, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const row = (style: string) =>
		"<div style=\"width: 70px\"><table style=\"width: 100%; " +
		"border-collapse: collapse\"><tr><td style=\"padding: 0; border: 0\">" +
		`</td><td id="c" style="${style}; padding: 0; border: 0"><p id="p" ` +
		"style=\"margin: 0\">the article body</p></td><td style=\"padding: 0; " +
		"border: 0\"></td></tr></table></div>";
	const rect = (id: string) =>
		document.getElementById(id)!.getBoundingClientRect();
	document.body.innerHTML =
		row("display: block; max-width: 60px; margin: 0 auto");
	expect([rect("c").left, rect("c").width, rect("p").width]).toEqual([
		5,
		60,
		60,
	]);
	document.body.innerHTML = row("display: block");
	expect(rect("p").width).toBe(70);
	dom.dispose();
});

// The white space between a row's cells renders nothing, so it is no
// anonymous cell and takes no column.
test("white space between cells takes no column", () => {
	const terminal = new MockProcess({cols: 120, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = "<div id=\"host\" style=\"width: 60px\"></div>";
	const parsed = new dom.window.DOMParser().parseFromString(
		"<table style=\"width: 100%\"><tr>\n  <td id=\"c\" " +
		"style=\"padding: 0; border: none\"><div></div></td>\n</tr></table>",
		"text/html",
	);
	document.getElementById("host")!.append(
		document.adoptNode(parsed.body.firstElementChild!),
	);
	expect(document.getElementById("c")!.getBoundingClientRect().width).toBe(60);
	dom.dispose();
});

// A percentage column takes its share of the table only from what the
// other columns leave, so the row never runs past the table.
test("a 100% cell beside others takes what they leave", () => {
	const terminal = new MockProcess({cols: 120, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const cell = (body: string, style = "") =>
		`<td style="padding: 0; border: 0;${style}">${body}</td>`;
	document.body.innerHTML =
		"<div style=\"width: 60px\"><table style=\"width: 100%; " +
		"border-collapse: collapse\"><tr>" +
		cell("Substack", " white-space: nowrap") +
		cell("", " width: 2px") +
		cell("You follow", " white-space: nowrap") +
		`<td id="last" style="padding: 0; border: 0; width: 100%; ` +
		"text-align: right\">7d</td></tr></table></div>";
	const last = document.getElementById("last")!.getBoundingClientRect();
	expect([last.left, last.width]).toEqual([20, 40]);
	dom.dispose();
});

// A word longer than the table is wide makes the cell as wide as the word.
// Its height is then that of its lines at that width, not of the one word
// per line that measuring its narrowest width produced.
test("a cell widened by a long word is as tall as its lines at that width", () => {
	const terminal = new MockProcess({cols: 60, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<table style=\"width: 14px\"><tr><td id=\"cell\" " +
		"style=\"padding: 0; border: 0\"><div id=\"text\">aa bb cc dd ee ff " +
		`gg hh ii jj kk ll mm nn ${"x".repeat(30)}</div></td></tr></table>`;
	const cell = document.getElementById("cell")!.getBoundingClientRect();
	const text = document.getElementById("text")!.getBoundingClientRect();
	expect([cell.width, cell.height]).toEqual([30, 3]);
	expect([text.top, text.height]).toEqual([cell.top, 3]);
	dom.dispose();
});

// The space after a word that ends a line hangs past it (css-text-3
// §4.1.3), so it does not widen the narrowest the cell can be.
test("a space a long word wraps at adds nothing to its cell's width", () => {
	const terminal = new MockProcess({cols: 60, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<table style=\"width: 14px\"><tr><td id=\"cell\" " +
		`style="padding: 0; border: 0">${"x".repeat(30)} aa</td></tr></table>`;
	const cell = document.getElementById("cell")!.getBoundingClientRect();
	expect([cell.width, cell.height]).toEqual([30, 2]);
	dom.dispose();
});

test("the space a line hangs leaves the cell's border drawn", async () => {
	const {rows, dom} = await render(
		"<table style=\"width: 4px\"><tr><td style=\"padding: 0\">" +
			`${"x".repeat(10)} aa</td></tr></table>`,
	);
	expect(rows).toEqual([
		"┌──────────┐",
		`│${"x".repeat(10)}│`,
		"│aa        │",
		"└──────────┘",
	]);
	dom.dispose();
});

// A table's width and height are the least it takes (css2 §17.5.2,
// §17.5.3). A cell as big as the table makes it grow around the cell, and
// the cell no longer covers the table's border.
test("a table grows to hold a cell as big as the table", async () => {
	const {rows, box, dom} = await render(
		"<table style=\"width: 6px; height: 3px; border: 1px solid\"><tr>" +
			"<td style=\"width: 6px; height: 3px; padding: 0; border: 0; " +
			"background: #5c6bc0\">x</td></tr></table>",
	);
	expect(box("table")).toEqual({left: 0, top: 0, width: 8, height: 5});
	expect(box("td")).toEqual({left: 1, top: 1, width: 6, height: 3});
	expect(rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()))
		.toEqual(["┌──────┐", "│      │", "│x     │", "│      │", "└──────┘"]);
	dom.dispose();
});

// CSS 2.1 §17.2.1, rule 2: cells a table holds with no row between share
// an anonymous row. Mail built on MJML lays out every column this way.
test("cells directly in a table share an anonymous row", async () => {
	const variants = [
		"table-layout:fixed;width:100%|width:100%",
		"width:100%|width:100%",
		"table-layout:fixed;width:100%|",
		"width:100%|",
	];
	for (const variant of variants) {
		const [table, cell] = variant.split("|");
		const {box, rows, dom} = await render(
			`<div style="display:table;${table}">\n` +
			`<div id=c style="display:table-cell;${cell}"><p>hello</p></div>\n` +
			"</div>",
		);
		expect(box("#c")).toMatchObject({left: 0, top: 0, width: 60});
		expect(box("#c").height).toBeGreaterThan(0);
		expect(rows.some((row) => row.includes("hello"))).toBe(true);
		dom.dispose();
	}
});

test("consecutive stray cells form one row, and a real row closes it", async () => {
	const {box, dom} = await render(
		"<div style=\"display:table;width:30ch\">" +
		"<div id=a style=\"display:table-cell\">a</div>" +
		"<div id=b style=\"display:table-cell\">b</div>" +
		"<div style=\"display:table-row\"><div id=r style=\"display:table-cell\">r</div></div>" +
		"<div id=c style=\"display:table-cell\">c</div>" +
		"</div>",
	);
	expect(box("#a").top).toBe(0);
	expect(box("#b").top).toBe(0);
	expect(box("#b").left).toBeGreaterThan(box("#a").left);
	expect(box("#r").top).toBe(1);
	expect(box("#c").top).toBe(2);
	expect(box("#a").width + box("#b").width).toBe(30);
	dom.dispose();
});

test("stray cells in a row group share an anonymous row too", async () => {
	const {box, dom} = await render(
		"<div style=\"display:table;width:20ch\"><div style=\"display:table-row-group\">" +
		"<div id=a style=\"display:table-cell\">a</div>" +
		"<div id=b style=\"display:table-cell\">b</div>" +
		"</div></div>",
	);
	expect([box("#a").top, box("#b").top]).toEqual([0, 0]);
	expect(box("#a").width + box("#b").width).toBe(20);
	dom.dispose();
});

// CSS 2.1 §17.2.1, rule 3: a row group or a row whose parent is no table
// is wrapped in an anonymous table, which stacks the rows and shrinks to
// them. A newsletter's display:block table holds its sections this way.
test("rows of a display:block table stack in an anonymous table", async () => {
	for (const markup of [
		"<tbody><tr><td id=a>A</td></tr><tr><td id=b>B</td></tr></tbody>",
		"<div style=\"display:table-row\"><div id=a style=\"display:table-cell\">A</div></div>" +
			"<div style=\"display:table-row\"><div id=b style=\"display:table-cell\">B</div></div>",
	]) {
		const {box, dom} =
			await render(`<table style="display:block;width:50ch">${markup}</table>`);
		expect(box("#a").left).toBe(0);
		expect(box("#b").left).toBe(0);
		expect(box("#b").top).toBeGreaterThan(box("#a").top);
		expect(box("#a").width).toBeLessThan(10);
		dom.dispose();
	}
});
