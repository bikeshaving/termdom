/**
 * Gradient Tests
 *
 * The parser reads `background-image` as css-images-3 §3.1 writes it, and
 * the painter fills a box cell by cell with the gradient's color at each
 * cell. A cell's background is the one thing the painted row cannot report
 * as text, so the rendering tests read colors out of the mock terminal's
 * buffer.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM, type TermDOMOptions} from "../src/index.ts";
import {parseGradient} from "../src/internal/gradients.ts";
import {MockProcess, nextFrame, scriptReplies} from "./test-utils.js";

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

test("an angle reads in any unit and lands in [0, 360)", () => {
	const angle = (direction: string): number | undefined =>
		parseGradient(`linear-gradient(${direction}, red, blue)`)?.angle;
	expect(angle("90deg")).toBe(90);
	expect(angle("100grad")).toBe(90);
	expect(angle("0.25turn")).toBe(90);
	expect(angle("1.5707963267948966rad")).toBeCloseTo(90);
	expect(angle("-90deg")).toBe(270);
	expect(angle("450deg")).toBe(90);
	expect(angle("90")).toBeUndefined();
	expect(angle("90px")).toBeUndefined();
});

test("a gradient's direction is an angle or a side or corner", () => {
	expect(parseGradient("linear-gradient(red, blue)")?.angle).toBe(180);
	expect(parseGradient("linear-gradient(to top, red, blue)")?.angle)
		.toBe(0);
	expect(parseGradient("linear-gradient(to right, red, blue)")?.angle)
		.toBe(90);
	expect(parseGradient("linear-gradient(to left, red, blue)")?.angle)
		.toBe(270);
	expect(parseGradient("linear-gradient(45deg, red, blue)")?.angle)
		.toBe(45);
	expect(parseGradient("linear-gradient(100grad, red, blue)")?.angle)
		.toBe(90);
	expect(parseGradient("linear-gradient(0.25turn, red, blue)")?.angle)
		.toBe(90);
	expect(parseGradient("linear-gradient(-90deg, red, blue)")?.angle)
		.toBe(270);
	expect(parseGradient("linear-gradient(1.5708rad, red, blue)")?.angle)
		.toBeCloseTo(90, 2);
});

test("a corner reads in either word order", () => {
	const one = parseGradient("linear-gradient(to bottom right, red, blue)");
	const two = parseGradient("linear-gradient(to right bottom, red, blue)");
	expect(one?.angle).toBe(135);
	expect(two?.angle).toBe(135);
	expect(parseGradient("linear-gradient(to top left, red, blue)")?.angle)
		.toBe(315);
	expect(parseGradient("linear-gradient(to left top, red, blue)")?.angle)
		.toBe(315);
});

test("stop positions keep the unit the author wrote", () => {
	const gradient =
		parseGradient("linear-gradient(to right, red 0%, lime 2ch, blue 100%)");
	expect(gradient?.stops.map((stop) => stop.position)).toEqual([
		{percentage: 0},
		{length: 2, unit: "ch"},
		{percentage: 100},
	]);
	expect(
		parseGradient("linear-gradient(red 10em, blue 3px)")?.stops
			.map((stop) => stop.position),
	).toEqual([{length: 10, unit: "em"}, 3]);
	expect(parseGradient("linear-gradient(red 10deg, blue)")).toBe(null);
});

test("a stop with two positions is two stops of one color", () => {
	const gradient =
		parseGradient("linear-gradient(to right, red 0%, blue 50% 100%)");
	expect(gradient?.stops).toEqual([
		{color: 0xff0000, alpha: 1, position: {percentage: 0}},
		{color: 0x0000ff, alpha: 1, position: {percentage: 50}},
		{color: 0x0000ff, alpha: 1, position: {percentage: 100}},
	]);
});

test("a color hint parses and leaves the stops alone", () => {
	const gradient = parseGradient("linear-gradient(to right, red, 20%, blue)");
	expect(gradient?.stops.length).toBe(2);
	expect(gradient?.stops[0].color).toBe(0xff0000);
	expect(gradient?.stops[1].color).toBe(0x0000ff);
});

test("transparent is a stop with no alpha", () => {
	const gradient = parseGradient("linear-gradient(to right, red, transparent)");
	expect(gradient?.stops[1].alpha).toBe(0);
});

test("repeating gradients are marked", () => {
	expect(
		parseGradient("repeating-linear-gradient(to right, red 0, blue 2ch)")
			?.repeating,
	).toBe(true);
	expect(parseGradient("linear-gradient(red, blue)")?.repeating)
		.toBe(false);
});

test("only the first image of a list is read", () => {
	expect(parseGradient("linear-gradient(red, blue), url(x.png)"))
		.not.toBe(null);
	expect(parseGradient("url(x.png), linear-gradient(red, blue)"))
		.toBe(null);
});

test("values the grammar rejects parse as null", () => {
	expect(parseGradient("none")).toBe(null);
	expect(parseGradient("url(a.png)")).toBe(null);
	expect(parseGradient("conic-gradient(red, blue)")).toBe(null);
	expect(parseGradient("linear-gradient(red)")).toBe(null);
	expect(parseGradient("linear-gradient(to right, bogus, blue)"))
		.toBe(null);
	expect(parseGradient("linear-gradient(to top bottom, red, blue)"))
		.toBe(null);
	expect(parseGradient("linear-gradient(45, red, blue)")).toBe(null);
	expect(parseGradient("linear-gradient(20%, red, blue)")).toBe(null);
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

// How far apart two colors are, by the channel that differs most.
function shadesApart(a: number, b: number): number {
	return Math.max(
		...[16, 8, 0].map((shift) =>
			Math.abs(((a >> shift) & 0xff) - ((b >> shift) & 0xff))),
	);
}

test("the angle follows the cell size the terminal reports", async () => {
	// Over square cells, 45deg runs corner to corner, so the cells down the
	// main diagonal sit at one place on the gradient line and share a color,
	// to a shade: the place is exactly halfway between two, and platforms
	// compute a sine to a different last digit.
	const square = new MockProcess({cols: 20, rows: 8});
	scriptReplies(square, [{ask: "\x1b[16t", reply: "\x1b[6;8;8t"}]);
	const dom = new TermDOM({transport: square.transport});
	const div = dom.document.createElement("div");
	div.setAttribute(
		"style",
		"width: 4ch; height: 4px; background-image: linear-gradient(45deg, red, blue)",
	);
	dom.document.body.appendChild(div);
	await nextFrame(dom);
	// The answers land after the first paint, and the repaint follows them.
	const deadline = Date.now() + 5000;
	while (
		shadesApart(readRow(square, 1, 4)[1].bg, readRow(square, 0, 4)[0].bg) > 1 &&
		Date.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	const rows = [0, 1, 2, 3].map((row) => readRow(square, row, 4));
	for (const index of [1, 2, 3]) {
		expect(shadesApart(rows[index][index].bg, rows[0][0].bg))
			.toBeLessThanOrEqual(1);
	}
	dom.dispose();

	// Over the guessed cell, twice as tall as wide, the diagonal drifts.
	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(45deg, red, blue)",
		4,
		4,
	);
	expect(
		shadesApart(readRow(terminal, 1, 4)[1].bg, readRow(terminal, 0, 4)[0].bg),
	).toBeGreaterThan(1);
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

test("an image that is not a gradient keeps background-color", async () => {
	for (const image of ["conic-gradient(red, blue)", "url(x.png)"]) {
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
	// The gradient composites onto the flat fill: green where it is
	// transparent, yellow where it is opaque, and a blend of the two
	// between, never a fade through black.
	const red = (color: number): number => (color >> 16) & 0xff;
	// Cells sample the line at their centers, so the ends are a twentieth
	// of the way in, not at the stops themselves.
	expect(red(row[0].bg)).toBeLessThan(0x20);
	expect(red(row[5].bg)).toBeGreaterThan(0x40);
	expect(red(row[5].bg)).toBeLessThan(0xc0);
	expect(red(row[9].bg)).toBeGreaterThan(0xe0);
	for (const cell of row) {
		expect(cell.bg & 0xff).toBe(0);
	}
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

/** A box `width` by `height` CSS pixels under a given cell size. */
async function paintSizedBox(
	css: string,
	cellSize: TermDOMOptions["cellSize"],
): Promise<{terminal: MockProcess; dispose(): void}> {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const dom = new TermDOM({transport: terminal.transport, cellSize});
	const div = dom.document.createElement("div");
	div.setAttribute("style", css);
	dom.document.body.appendChild(div);
	await nextFrame(dom);
	return {terminal, dispose: () => dom.dispose()};
}

test("a stop's pixels are the page's pixels under a cell size", async () => {
	const {terminal, dispose} = await paintSizedBox(
		"width: 160px; height: 16px;" +
			" background-image: linear-gradient(to right, red 80px, blue 80px)",
		{width: 8, height: 16},
	);
	const row = readRow(terminal, 0, 20);
	for (let col = 0; col < 10; col++) {
		expect(row[col].bg).toBe(0xff0000);
	}
	for (let col = 10; col < 20; col++) {
		expect(row[col].bg).toBe(0x0000ff);
	}
	dispose();
});

test("a stop measured in em splits where the font size says", async () => {
	const {terminal, dispose} = await paintSizedBox(
		"width: 160px; height: 16px; font-size: 8px;" +
			" background-image: linear-gradient(to right, red 10em, blue 10em)",
		{width: 8, height: 16},
	);
	const row = readRow(terminal, 0, 20);
	expect(row[9].bg).toBe(0xff0000);
	expect(row[10].bg).toBe(0x0000ff);
	dispose();
});

test("a stop in ch or px down a column counts rows", async () => {
	for (const stop of ["3ch", "3px"]) {
		const {terminal, dispose} = await paintSizedBox(
			"width: 4px; height: 6px;" +
				` background-image: linear-gradient(red ${stop}, blue ${stop})`,
			undefined,
		);
		for (let row = 0; row < 6; row++) {
			expect(readRow(terminal, row, 1)[0].bg)
				.toBe(row < 3 ? 0xff0000 : 0x0000ff);
		}
		dispose();
	}
});

/** A box as paintBox paints it, on a terminal that reports `background`. */
async function paintBoxOn(
	background: string,
	css: string,
	cols: number,
	rows: number,
): Promise<{terminal: MockProcess; dom: TermDOM; div: HTMLElement}> {
	const terminal = new MockProcess({cols: 20, rows: 8});
	scriptReplies(terminal, [
		{ask: "\x1b]11;?\x1b\\", reply: `\x1b]11;${background}\x1b\\`},
	]);
	const dom = new TermDOM({transport: terminal.transport, colorDepth: "rgb"});
	const div = dom.document.createElement("div");
	div.setAttribute("style", `width: ${cols}ch; height: ${rows}px; ${css}`);
	dom.document.body.appendChild(div);
	await dom.attach();
	await nextFrame(dom);
	return {terminal, dom, div};
}

test("a fade to transparent blends with the background the terminal reports", async () => {
	const {terminal, dom} = await paintBoxOn(
		"rgb:0000/0000/8080",
		"background-image: linear-gradient(to right, red, transparent)",
		10,
		1,
	);
	const row = readRow(terminal, 0, 10);
	// Red runs out as the terminal's navy comes in, a step a cell.
	for (let col = 1; col < 9; col++) {
		expect(RED(row[col].bg)).toBeLessThan(RED(row[col - 1].bg));
		expect(BLUE(row[col].bg)).toBeGreaterThan(BLUE(row[col - 1].bg));
		expect(GREEN(row[col].bg)).toBe(0);
	}
	expect(RED(row[0].bg)).toBeGreaterThan(0xe0);
	expect(BLUE(row[9].bg)).toBeGreaterThan(0x70);
	dom.dispose();
});

test("a fade to transparent on a terminal that reports nothing stops halfway", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: linear-gradient(to right, red, transparent)",
		10,
		1,
	);
	const row = readRow(terminal, 0, 10);
	// There is nothing to blend with, so a cell is the gradient's color
	// where that is the stronger and the terminal's own where it is not.
	expect(row.map((cell) => cell.bg)).toEqual([
		...Array(5).fill(0xff0000),
		...Array(5).fill(-1),
	]);
	dispose();
});

test("a fade to transparent blends with what an ancestor painted", async () => {
	const terminal = new MockProcess({cols: 20, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"background-color: blue; width: 10ch\">" +
		"<div style=\"height: 1px;" +
		" background-image: linear-gradient(to right, red, transparent)\"></div>" +
		"</div>";
	await nextFrame(dom);
	const row = readRow(terminal, 0, 10);
	expect(RED(row[0].bg)).toBeGreaterThan(0xe0);
	expect(RED(row[5].bg)).toBeGreaterThan(0x40);
	expect(BLUE(row[5].bg)).toBeGreaterThan(0x40);
	expect(BLUE(row[9].bg)).toBeGreaterThan(0xe0);
	dom.dispose();
});

test("Canvas is a stop in the background the terminal reports", async () => {
	const {terminal, dom} = await paintBoxOn(
		"rgb:0000/0000/8080",
		"background-image: linear-gradient(to right, red 0, Canvas 10ch)",
		10,
		1,
	);
	const row = readRow(terminal, 0, 10);
	expect(RED(row[0].bg)).toBeGreaterThan(0xe0);
	expect(RED(row[9].bg)).toBeLessThan(0x20);
	expect(BLUE(row[9].bg)).toBeGreaterThan(0x70);
	dom.dispose();
	// Unreported, Canvas is the terminal's own, which is no paint at all.
	const plain = await paintBox(
		"background-image: linear-gradient(to right, red, Canvas)",
		10,
		1,
	);
	expect(readRow(plain.terminal, 0, 10)[9].bg).toBe(-1);
	plain.dispose();
});

test("Canvas computes to the background the terminal reports", async () => {
	const {dom, div} = await paintBoxOn(
		"rgb:0000/0000/8080",
		"background-color: Canvas; color: CanvasText",
		4,
		1,
	);
	const style = dom.window.getComputedStyle(div);
	expect(style.backgroundColor).toBe("rgb(0, 0, 128)");
	// The terminal reports no text color, so that stays the scheme's.
	expect(style.color).toBe("rgb(255, 255, 255)");
	dom.dispose();
	const quiet = new TermDOM({
		transport: new MockProcess({cols: 20, rows: 8}).transport,
	});
	quiet.document.body.style.backgroundColor = "Canvas";
	expect(quiet.window.getComputedStyle(quiet.document.body).backgroundColor)
		.toBe("rgb(255, 255, 255)");
	quiet.dispose();
});

test("a radial gradient's shape is an ellipse to the farthest corner unless it says", () => {
	expect(parseGradient("radial-gradient(red, blue)")?.radial).toEqual({
		circle: false,
		size: "farthest-corner",
		at: [{percentage: 50}, {percentage: 50}],
	});
	expect(parseGradient("radial-gradient(circle, red, blue)")!.radial!.circle)
		.toBe(true);
	expect(
		parseGradient("radial-gradient(closest-side circle, red, blue)")?.radial,
	).toEqual({
		circle: true,
		size: "closest-side",
		at: [{percentage: 50}, {percentage: 50}],
	});
	// One length is a circle's radius, and two are an ellipse's.
	expect(parseGradient("radial-gradient(4px, red, blue)")?.radial).toEqual({
		circle: true,
		size: [4],
		at: [{percentage: 50}, {percentage: 50}],
	});
	expect(parseGradient("radial-gradient(6ch 50%, red, blue)")!.radial!.size)
		.toEqual([{length: 6, unit: "ch"}, {percentage: 50}]);
	expect(
		parseGradient("repeating-radial-gradient(red, blue 2px)")?.repeating,
	).toBe(true);
	expect(parseGradient("radial-gradient(red, blue)")?.repeating).toBe(false);
});

test("a radial gradient's center reads as a position", () => {
	const at = (position: string): unknown => {
		const gradient =
			parseGradient(`radial-gradient(at ${position}, red, blue)`);
		return gradient === null ? undefined : gradient.radial!.at;
	};
	expect(at("left")).toEqual([{percentage: 0}, {percentage: 50}]);
	expect(at("top")).toEqual([{percentage: 50}, {percentage: 0}]);
	expect(at("bottom right")).toEqual([{percentage: 100}, {percentage: 100}]);
	expect(at("right bottom")).toEqual([{percentage: 100}, {percentage: 100}]);
	expect(at("center")).toEqual([{percentage: 50}, {percentage: 50}]);
	expect(at("3px 25%")).toEqual([3, {percentage: 25}]);
	expect(at("2ch")).toEqual([{length: 2, unit: "ch"}, {percentage: 50}]);
	expect(at("left left")).toBeUndefined();
	expect(at("up")).toBeUndefined();
	expect(
		parseGradient("radial-gradient(circle 4px at left, red, blue)")?.radial,
	).toEqual({circle: true, size: [4], at: [{percentage: 0}, {percentage: 50}]});
});

test("radial shapes the grammar rejects parse as null", () => {
	expect(parseGradient("radial-gradient(circle 4px 2px, red, blue)"))
		.toBe(null);
	expect(parseGradient("radial-gradient(ellipse 4px, red, blue)")).toBe(null);
	expect(parseGradient("radial-gradient(circle 50%, red, blue)")).toBe(null);
	expect(parseGradient("radial-gradient(50%, red, blue)")).toBe(null);
	expect(parseGradient("radial-gradient(circle circle, red, blue)"))
		.toBe(null);
	expect(parseGradient("radial-gradient(closest-side 4px, red, blue)"))
		.toBe(null);
	expect(parseGradient("radial-gradient(-4px, red, blue)")).toBe(null);
	expect(parseGradient("radial-gradient(circle, red)")).toBe(null);
	expect(parseGradient("radial-gradient(to right, red, blue)")).toBe(null);
});

/** Every row of a painted box, as readRow reads one. */
function readBox(
	terminal: MockProcess,
	cols: number,
	rows: number,
): number[][] {
	return Array.from({length: rows}, (_, row) =>
		readRow(terminal, row, cols).map((cell) => RED(cell.bg)));
}

test("a radial gradient is brightest at its center and the same all round", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: radial-gradient(white, black)",
		9,
		5,
	);
	const box = readBox(terminal, 9, 5);
	for (let row = 0; row < 5; row++) {
		for (let col = 0; col < 9; col++) {
			expect(box[row][col]).toBe(box[4 - row][8 - col]);
			expect(box[row][col]).toBe(box[row][8 - col]);
			if (row !== 2 || col !== 4) {
				expect(box[row][col]).toBeLessThan(box[2][4]);
			}
		}
	}
	expect(box[2][4]).toBe(0xff);
	expect(box[2][3]).toBeGreaterThan(box[2][2]);
	expect(box[1][4]).toBeGreaterThan(box[0][4]);
	dispose();
});

test("a circle is round on cells twice as tall as wide", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: radial-gradient(circle closest-side, white, black)",
		9,
		5,
	);
	const box = readBox(terminal, 9, 5);
	// A row is two columns' distance, so one row up is two columns across.
	expect(box[1][4]).toBe(box[2][2]);
	expect(box[1][4]).toBe(box[2][6]);
	expect(box[0][4]).toBe(box[2][0]);
	// The nearest side is half the width away, and all past it is the end.
	expect(box[0][0]).toBe(0);
	expect(box[0][4]).toBeGreaterThan(0);
	dispose();
});

test("an ellipse reaches each side it is sized to", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image:" +
		" radial-gradient(closest-side, white, black 100%, red 100%)",
		10,
		4,
	);
	const box = readRow(terminal, 0, 10);
	const middle = readRow(terminal, 1, 10);
	// Inside the ellipse the cells are gray, and outside they are red:
	// the corners are out, and the middle of every side is in.
	expect(box[0].bg).toBe(0xff0000);
	expect(box[9].bg).toBe(0xff0000);
	expect(GREEN(box[4].bg)).toBe(RED(box[4].bg));
	expect(GREEN(middle[0].bg)).toBe(RED(middle[0].bg));
	expect(GREEN(middle[9].bg)).toBe(RED(middle[9].bg));
	dispose();
});

test("a radial gradient is centered where it says", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image: radial-gradient(circle 4ch at 2ch 1px, white, black)",
		10,
		4,
	);
	const box = readBox(terminal, 10, 4);
	// The center is the corner four cells share, so they match.
	expect(box[0][1]).toBe(box[0][2]);
	expect(box[0][1]).toBe(box[1][1]);
	expect(box[0][1]).toBe(box[1][2]);
	expect(box[0][1]).toBeGreaterThan(box[0][3]);
	expect(box[0][1]).toBeGreaterThan(box[2][1]);
	// Four columns out is the radius, and everything past it is black.
	expect(box[0][6]).toBe(0);
	expect(box[0][5]).toBeGreaterThan(0);
	dispose();
});

test("a repeating radial gradient rings", async () => {
	const {terminal, dispose} = await paintBox(
		"background-image:" +
		" repeating-radial-gradient(circle at left, white 0, white 1ch," +
		" black 1ch, black 2ch)",
		8,
		1,
	);
	expect(readRow(terminal, 0, 8).map((cell) => cell.bg)).toEqual([
		0xffffff,
		0,
		0xffffff,
		0,
		0xffffff,
		0,
		0xffffff,
		0,
	]);
	dispose();
});

test("a glow fades into the background the terminal reports", async () => {
	const {terminal, dom} = await paintBoxOn(
		"rgb:0000/0000/8080",
		"background-image:" +
		" radial-gradient(circle closest-side, yellow, transparent)",
		9,
		5,
	);
	const row = readRow(terminal, 2, 9);
	expect(RED(row[4].bg)).toBeGreaterThan(0xd0);
	expect(RED(row[2].bg)).toBeLessThan(RED(row[3].bg));
	expect(BLUE(row[2].bg)).toBeGreaterThan(BLUE(row[3].bg));
	// Past the circle nothing is painted at all.
	expect(readRow(terminal, 0, 9)[0].bg).toBe(-1);
	dom.dispose();
});
