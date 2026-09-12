/**
 * Linear Gradient Tests
 *
 * The parser reads `background-image` as css-images-3 §3.1 writes it, and
 * the painter fills a box cell by cell with the gradient's color at each
 * cell. A cell's background is the one thing the painted row cannot report
 * as text, so the rendering tests read colors out of the mock terminal's
 * buffer.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {parseLinearGradient} from "../src/internal/cssvalues.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

/**
 * The painted row, one cell at a time: the packed background, the packed
 * foreground and the glyph. A cell with no color of its own reads -1, which
 * no packed color can be.
 */
function readRow(
	terminal: MockProcess,
	row: number,
	cols: number,
): Array<{bg: number; fg: number; char: string}> {
	const line = (terminal as any).terminal.buffer.active.getLine(row);
	const cells: Array<{bg: number; fg: number; char: string}> = [];
	for (let col = 0; col < cols; col++) {
		const cell = line.getCell(col)!;
		cells.push({
			bg: cell.isBgRGB() ? cell.getBgColor() : -1,
			fg: cell.isFgRGB() ? cell.getFgColor() : -1,
			char: cell.getChars() || " ",
		});
	}
	return cells;
}

/** A box of `cols` by `rows` cells carrying `css`, painted once. */
async function paintBox(
	css: string,
	cols: number,
	rows: number,
	text = "",
): Promise<{terminal: MockProcess; dispose(): void}> {
	const terminal = new MockProcess({cols: 20, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const div = document.createElement("div");
	div.setAttribute("style", `width: ${cols}ch; height: ${rows}px; ${css}`);
	div.textContent = text;
	document.body.appendChild(div);
	await nextFrame(dom);
	return {terminal, dispose: () => dom.dispose()};
}

const RED = (color: number): number => (color >> 16) & 0xff;
const GREEN = (color: number): number => (color >> 8) & 0xff;
const BLUE = (color: number): number => color & 0xff;

test("a gradient's direction is an angle or a side or corner", () => {
	expect(parseLinearGradient("linear-gradient(red, blue)")?.angle).toBe(180);
	expect(parseLinearGradient("linear-gradient(to top, red, blue)")?.angle)
		.toBe(0);
	expect(parseLinearGradient("linear-gradient(to right, red, blue)")?.angle)
		.toBe(90);
	expect(parseLinearGradient("linear-gradient(to left, red, blue)")?.angle)
		.toBe(270);
	expect(parseLinearGradient("linear-gradient(45deg, red, blue)")?.angle)
		.toBe(45);
	expect(parseLinearGradient("linear-gradient(100grad, red, blue)")?.angle)
		.toBe(90);
	expect(parseLinearGradient("linear-gradient(0.25turn, red, blue)")?.angle)
		.toBe(90);
	expect(parseLinearGradient("linear-gradient(-90deg, red, blue)")?.angle)
		.toBe(270);
	expect(parseLinearGradient("linear-gradient(1.5708rad, red, blue)")?.angle)
		.toBeCloseTo(90, 2);
});

test("a corner reads in either word order", () => {
	const one =
		parseLinearGradient("linear-gradient(to bottom right, red, blue)");
	const two =
		parseLinearGradient("linear-gradient(to right bottom, red, blue)");
	expect(one?.angle).toBe(135);
	expect(two?.angle).toBe(135);
	expect(parseLinearGradient("linear-gradient(to top left, red, blue)")?.angle)
		.toBe(315);
	expect(parseLinearGradient("linear-gradient(to left top, red, blue)")?.angle)
		.toBe(315);
});

test("stop positions keep the unit the author wrote", () => {
	const gradient = parseLinearGradient(
		"linear-gradient(to right, red 0%, lime 2ch, blue 100%)",
	);
	expect(gradient?.stops.map((stop) => stop.position)).toEqual([
		{percentage: 0},
		2,
		{percentage: 100},
	]);
});

test("a stop with two positions is two stops of one color", () => {
	const gradient =
		parseLinearGradient("linear-gradient(to right, red 0%, blue 50% 100%)");
	expect(gradient?.stops).toEqual([
		{color: 0xff0000, alpha: 1, position: {percentage: 0}},
		{color: 0x0000ff, alpha: 1, position: {percentage: 50}},
		{color: 0x0000ff, alpha: 1, position: {percentage: 100}},
	]);
});

test("a color hint parses and leaves the stops alone", () => {
	const gradient =
		parseLinearGradient("linear-gradient(to right, red, 20%, blue)");
	expect(gradient?.stops.length).toBe(2);
	expect(gradient?.stops[0].color).toBe(0xff0000);
	expect(gradient?.stops[1].color).toBe(0x0000ff);
});

test("transparent is a stop with no alpha", () => {
	const gradient =
		parseLinearGradient("linear-gradient(to right, red, transparent)");
	expect(gradient?.stops[1].alpha).toBe(0);
});

test("repeating gradients are marked", () => {
	expect(
		parseLinearGradient("repeating-linear-gradient(to right, red 0, blue 2ch)")
			?.repeating,
	).toBe(true);
	expect(parseLinearGradient("linear-gradient(red, blue)")?.repeating)
		.toBe(false);
});

test("only the first image of a list is read", () => {
	expect(parseLinearGradient("linear-gradient(red, blue), url(x.png)"))
		.not.toBe(null);
	expect(parseLinearGradient("url(x.png), linear-gradient(red, blue)"))
		.toBe(null);
});

test("values the grammar rejects parse as null", () => {
	expect(parseLinearGradient("none")).toBe(null);
	expect(parseLinearGradient("url(a.png)")).toBe(null);
	expect(parseLinearGradient("radial-gradient(red, blue)")).toBe(null);
	expect(parseLinearGradient("linear-gradient(red)")).toBe(null);
	expect(parseLinearGradient("linear-gradient(to right, bogus, blue)"))
		.toBe(null);
	expect(parseLinearGradient("linear-gradient(to top bottom, red, blue)"))
		.toBe(null);
	expect(parseLinearGradient("linear-gradient(45, red, blue)")).toBe(null);
	expect(parseLinearGradient("linear-gradient(20%, red, blue)")).toBe(null);
});

test("a horizontal gradient runs black to white across the row", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(to right, #000000, #ffffff)",
		10,
		1,
	);
	const row = readRow(terminal, 0, 10);
	expect(RED(row[0].bg)).toBeLessThan(32);
	expect(RED(row[9].bg)).toBeGreaterThan(223);
	for (let col = 1; col < 10; col++) {
		expect(row[col].bg).toBeGreaterThan(row[col - 1].bg);
		// A gray runs its three channels together.
		expect(GREEN(row[col].bg)).toBe(RED(row[col].bg));
		expect(BLUE(row[col].bg)).toBe(RED(row[col].bg));
	}
	dispose();
});

test("a vertical gradient paints uniform rows that differ", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(to bottom, #000000, #ffffff)",
		10,
		3,
	);
	const rows = [0, 1, 2].map((row) => readRow(terminal, row, 10));
	for (const row of rows) {
		for (const cell of row) {
			expect(cell.bg).toBe(row[0].bg);
		}
	}
	expect(rows[0][0].bg).toBeLessThan(rows[1][0].bg);
	expect(rows[1][0].bg).toBeLessThan(rows[2][0].bg);
	dispose();
});

test("a corner gradient runs corner to corner", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(to bottom right, red, blue)",
		10,
		3,
	);
	const first = readRow(terminal, 0, 10);
	const last = readRow(terminal, 2, 10);
	expect(RED(first[0].bg)).toBeGreaterThan(223);
	expect(BLUE(last[9].bg)).toBeGreaterThan(223);
	// A gradient across the box shades down its rows; one across the row
	// alone would leave every row the same.
	expect(first[0].bg).not.toBe(last[0].bg);
	dispose();
});

test("45deg points at the top right, not the bottom right", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(45deg, red, blue)",
		10,
		3,
	);
	const first = readRow(terminal, 0, 10);
	const last = readRow(terminal, 2, 10);
	expect(RED(last[0].bg)).toBeGreaterThan(223);
	expect(BLUE(first[9].bg)).toBeGreaterThan(223);
	expect(first[0].bg).not.toBe(last[0].bg);
	dispose();
});

test("two stops in one place make a hard edge", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: " +
		"linear-gradient(to right, red 0%, red 50%, blue 50%, blue 100%)",
		10,
		1,
	);
	const row = readRow(terminal, 0, 10);
	for (let col = 0; col < 5; col++) {
		expect(row[col].bg).toBe(0xff0000);
	}
	for (let col = 5; col < 10; col++) {
		expect(row[col].bg).toBe(0x0000ff);
	}
	dispose();
});

test("stops with no positions spread evenly", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(to right, red, lime, blue)",
		10,
		1,
	);
	const row = readRow(terminal, 0, 10);
	// The middle stop lands in the middle: red is spent by the halfway
	// column and blue has not started before it.
	for (let col = 0; col < 5; col++) {
		expect(BLUE(row[col].bg)).toBe(0);
		expect(RED(row[col].bg)).toBeGreaterThan(0);
	}
	for (let col = 5; col < 10; col++) {
		expect(RED(row[col].bg)).toBe(0);
		expect(BLUE(row[col].bg)).toBeGreaterThan(0);
	}
	expect(GREEN(row[4].bg)).toBeGreaterThan(GREEN(row[0].bg));
	expect(GREEN(row[5].bg)).toBeGreaterThan(GREEN(row[9].bg));
	dispose();
});

test("a repeating gradient cycles every two cells", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: repeating-linear-gradient(to right, red 0, blue 2ch)",
		8,
		1,
	);
	const row = readRow(terminal, 0, 8);
	for (let col = 2; col < 8; col++) {
		expect(row[col].bg).toBe(row[col - 2].bg);
	}
	expect(row[0].bg).not.toBe(row[1].bg);
	dispose();
});

test("text over a gradient keeps the gradient under it", async () => {
	const bare = await paintBox(
		"background-image: linear-gradient(to right, #000000, #ffffff)",
		10,
		1,
	);
	const empty = readRow(bare.terminal, 0, 10);
	bare.dispose();

	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(to right, #000000, #ffffff);" +
		" color: red",
		10,
		1,
		"Hi",
	);
	const row = readRow(terminal, 0, 10);
	expect(row.map((cell) => cell.char).join("").trimEnd()).toBe("Hi");
	for (let col = 0; col < 10; col++) {
		expect(row[col].bg).toBe(empty[col].bg);
	}
	expect(row[0].fg).toBe(0xff0000);
	expect(row[1].fg).toBe(0xff0000);
	dispose();
});

test("an image that is not a linear gradient keeps background-color", async () => {
	for (const image of ["radial-gradient(red, blue)", "url(x.png)"]) {
		const {terminal, dispose} = await paintBox(
			`background-color: green; background-image: ${image}`,
			10,
			1,
		);
		for (const cell of readRow(terminal, 0, 10)) {
			expect(cell.bg).toBe(0x008000);
		}
		dispose();
	}
});

test("the background shorthand paints the same gradient", async () => {
	const longhand = await paintBox(
		"background-image: linear-gradient(to right, #000000, #ffffff)",
		10,
		1,
	);
	const fromLonghand = readRow(longhand.terminal, 0, 10).map((c) => c.bg);
	longhand.dispose();

	const {terminal, dispose} = await paintBox(
		"background: linear-gradient(to right, #000000, #ffffff)",
		10,
		1,
	);
	expect(readRow(terminal, 0, 10).map((c) => c.bg)).toEqual(fromLonghand);
	dispose();
});

test("a transparent stop lets the background-color through", async () => {
	const {terminal, dispose} = await paintBox(
		"background-color: green;" +
		" background-image: linear-gradient(to right, transparent, yellow)",
		10,
		1,
	);
	const row = readRow(terminal, 0, 10);
	// Under half coverage the flat fill stands, and the yellow end never
	// fades through black on its way there.
	expect(row[0].bg).toBe(0x008000);
	expect(row[9].bg).toBe(0xffff00);
	dispose();
});

test("a gradient bar renders to stable ANSI", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(to right, #1a4d8f, #9fd0ff)",
		20,
		2,
	);
	expect(terminal.getScreenContents()).toMatchSnapshot();
	dispose();
});
