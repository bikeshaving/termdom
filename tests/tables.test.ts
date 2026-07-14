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
import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {MockProcess, stripControlCodes} from "./test-utils.js";

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

async function render(html: string, cols = 60) {
	const terminal = new MockProcess({cols, rows: 20});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = html;
	await dom.render();

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
		`<table><tr><td>a</td><td>b</td></tr></table>`,
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
