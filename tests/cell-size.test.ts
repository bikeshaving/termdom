/**
 * The cellSize option: what one terminal cell measures in CSS pixels.
 * Pages write and read CSS pixels; layout places boxes on whole cells.
 * At the default unit size the two are the same number.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM, type TermDOMOptions} from "../src/index.ts";
import {MockProcess, nextFrame, scriptReplies} from "./test-utils.js";

function make(
	cellSize: TermDOMOptions["cellSize"],
	cols = 60,
	rows = 20,
): {terminal: MockProcess; dom: TermDOM} {
	const terminal = new MockProcess({cols, rows});
	return {
		terminal,
		dom: new TermDOM({transport: terminal.transport, cellSize}),
	};
}

test("the default unit cell is one CSS pixel each way", () => {
	const {dom} = make(undefined);
	expect(dom.window.innerWidth).toBe(60);
	expect(dom.window.innerHeight).toBe(20);
	expect(dom.window.getComputedStyle(dom.document.documentElement).fontSize)
		.toBe("1px");
	dom.dispose();
});

test("a typical cell is 8 by 16 CSS pixels", () => {
	const {dom} = make("typical");
	const {window, document} = dom;
	expect(window.innerWidth).toBe(480);
	expect(window.innerHeight).toBe(320);
	// A line of text is one row, so the initial font is a row tall.
	expect(window.getComputedStyle(document.documentElement).fontSize).toBe(
		"16px",
	);
	document.body.innerHTML =
		"<div id=\"box\" style=\"width: 240px; padding: 16px 8px; " +
		"border: 1px solid\">x</div>";
	const box = document.getElementById("box")!;
	// 30 columns, and a row of border, a row of padding and a line each way.
	expect(box.getBoundingClientRect().width).toBe(240);
	expect(box.getBoundingClientRect().height).toBe(80);
	expect(box.offsetWidth).toBe(240);
	expect(box.clientWidth).toBe(224);
	// What the page wrote reads back as written.
	expect(window.getComputedStyle(box).paddingTop).toBe("16px");
	expect(window.getComputedStyle(box).width).toBe("240px");
	dom.dispose();
});

test("lengths round to the nearest cell, and a border is at least one", () => {
	const {dom} = make({width: 10, height: 20});
	const {document} = dom;
	document.body.innerHTML =
		"<div id=\"a\" style=\"width: 34px; height: 29px\"></div>" +
		"<div id=\"b\" style=\"width: 50px; border-left: 1px solid\"></div>";
	const a = document.getElementById("a")!.getBoundingClientRect();
	expect([a.width, a.height]).toEqual([30, 20]);
	expect(document.getElementById("b")!.clientLeft).toBe(10);
	dom.dispose();
});

test("em follows the font, ch the cell, and vw the viewport", () => {
	const {dom} = make("typical");
	const {document} = dom;
	document.body.innerHTML =
		"<div id=\"em\" style=\"width: 2em\"></div>" +
		"<div id=\"ch\" style=\"width: 3ch\"></div>" +
		"<div id=\"vw\" style=\"width: 50vw\"></div>";
	const width = (id: string) =>
		document.getElementById(id)!.getBoundingClientRect().width;
	expect(width("em")).toBe(32);
	expect(width("ch")).toBe(24);
	expect(width("vw")).toBe(240);
	dom.dispose();
});

test("media queries compare CSS pixels", () => {
	const {dom} = make("typical");
	const {window} = dom;
	expect(window.matchMedia("(max-width: 600px)").matches).toBe(true);
	expect(window.matchMedia("(max-width: 400px)").matches).toBe(false);
	expect(window.matchMedia("(min-width: 30em)").matches).toBe(true);
	dom.dispose();
});

test("a grid track and an aspect ratio are CSS pixels", () => {
	const {dom} = make("typical");
	const {document} = dom;
	document.body.innerHTML =
		"<div style=\"display: grid; grid-template-columns: 80px 1fr\">" +
		"<div id=\"track\">a</div><div>b</div></div>" +
		"<div id=\"square\" style=\"width: 64px; aspect-ratio: 1\"></div>";
	expect(document.getElementById("track")!.getBoundingClientRect().width).toBe(
		80,
	);
	const square = document.getElementById("square")!.getBoundingClientRect();
	expect([square.width, square.height]).toEqual([64, 64]);
	dom.dispose();
});

test("scroll offsets are written and read in CSS pixels", () => {
	const {dom} = make("typical");
	const {document} = dom;
	document.body.innerHTML =
		"<div id=\"s\" style=\"height: 64px; overflow: auto\">" +
		"<div style=\"height: 320px\"></div></div>";
	const scroller = document.getElementById("s")!;
	expect(scroller.scrollHeight).toBe(320);
	scroller.scrollTop = 40;
	// 40px is two and a half rows, and a scroll moves whole rows.
	expect(scroller.scrollTop).toBe(48);
	scroller.scrollTop = 1000;
	expect(scroller.scrollTop).toBe(256);
	dom.dispose();
});

test("a point in CSS pixels hits the cell it falls in", () => {
	const {dom} = make("typical");
	const {document} = dom;
	document.body.innerHTML =
		"<div style=\"display: flex\"><span id=\"a\">aa</span>" +
		"<span id=\"b\">bb</span></div>";
	expect(document.elementFromPoint(12, 4)?.id).toBe("a");
	expect(document.elementFromPoint(20, 4)?.id).toBe("b");
	dom.dispose();
});

test("a mouse event reports the cell's corner in CSS pixels", async () => {
	const {terminal, dom} = make("typical");
	const {document} = dom;
	document.body.innerHTML = "<div id=\"t\" style=\"height: 64px\">x</div>";
	await dom.attach();
	await nextFrame(dom);
	const points: Array<[number, number]> = [];
	document.getElementById("t")!.addEventListener("mousedown", (event) => {
		points.push([event.clientX, event.clientY]);
	});
	terminal.stdin.simulateResponse("\x1b[<0;4;2M");
	await new Promise((resolve) => setTimeout(resolve, 20));
	// Column 4 and row 2 of the report, counted from 1.
	expect(points).toEqual([[24, 16]]);
	dom.dispose();
});

test("auto takes the size the terminal reports before the first frame", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	scriptReplies(terminal, [{ask: "\x1b[16t", reply: "\x1b[6;20;10t"}]);
	const dom = new TermDOM({transport: terminal.transport, cellSize: "auto"});
	const widths: number[] = [];
	dom.window.requestAnimationFrame(() => widths.push(dom.window.innerWidth));
	await dom.attach();
	await nextFrame(dom);
	expect(widths).toEqual([400]);
	expect(dom.window.innerHeight).toBe(200);
	dom.dispose();
});

test("auto without a terminal to ask is typical", () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	(terminal.stdout as unknown as {isTTY: boolean}).isTTY = false;
	const dom = new TermDOM({transport: terminal.transport, cellSize: "auto"});
	expect(dom.window.innerWidth).toBe(320);
	dom.dispose();
});

test("a size that is not one throws", () => {
	for (const cellSize of [{width: 0, height: 16}, {width: 8}, "big"]) {
		expect(() =>
			new TermDOM({
				transport: new MockProcess().transport,
				cellSize: cellSize as never,
			}),
		).toThrow(TypeError);
	}
});
