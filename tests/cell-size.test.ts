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

test("a used width takes away the edges as they were drawn", () => {
	const {dom} = make("typical");
	const {document, window} = dom;
	document.body.innerHTML =
		"<div id=\"box\" style=\"box-sizing: content-box; width: 80px; " +
		"padding: 5px; border: 1px solid\">x</div>";
	const style = window.getComputedStyle(document.getElementById("box")!);
	// Five pixels of padding is a cell across and nothing down, and a border
	// is at least a cell either way.
	expect(style.width).toBe("80px");
	expect(style.height).toBe("16px");
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

test("auto does not wait on a terminal that answers DA1 but not the size", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	scriptReplies(terminal, [{ask: "\x1b[c", reply: "\x1b[?62c"}]);
	const dom = new TermDOM({transport: terminal.transport, cellSize: "auto"});
	const start = performance.now();
	await dom.attach();
	await nextFrame(dom);
	expect(performance.now() - start).toBeLessThan(500);
	expect(dom.window.innerWidth).toBe(320);
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

test("ch is a cell along its axis, and lh a line as the terminal draws it", () => {
	for (const [
		cellSize,
		column,
		row,
	] of [["unit", 1, 1], ["typical", 8, 16]] as const) {
		const {dom} = make(cellSize);
		const {document, window} = dom;
		document.body.innerHTML =
			"<div id=\"box\" style=\"width: 3ch; height: 3ch; padding: 1ch\"></div>" +
			"<div style=\"line-height: 2\"><div id=\"line\" style=\"height: 2lh\">" +
			"</div></div><div id=\"root\" style=\"height: 1rlh\"></div>";
		const rect = (id: string) =>
			document.getElementById(id)!.getBoundingClientRect();
		// Three cells each way, and a cell of padding on every side of them
		// taken from inside, as border-box sizes it.
		expect([rect("box").width, rect("box").height]).toEqual([
			3 * column,
			3 * row,
		]);
		expect(document.getElementById("box")!.clientHeight).toBe(3 * row);
		expect(
			window.getComputedStyle(document.getElementById("box")!)
				.paddingTop,
		).toBe(`${row}px`);
		// Every line is drawn one row tall, whatever line-height says.
		expect(rect("line").height).toBe(2 * row);
		expect(rect("root").height).toBe(row);
		expect(
			window.matchMedia(`(min-height: ${window.innerHeight / row}ch)`)
				.matches,
		).toBe(true);
		dom.dispose();
	}
});

test("Tab and focus() scroll a pane by the pixels its cells take", async () => {
	const {terminal, dom} = make({width: 8, height: 16});
	const {document} = dom;
	document.body.innerHTML =
		"<div id=\"s\" style=\"height: 5lh; overflow: auto\">" +
		"<div style=\"height: 9lh\"></div><a id=\"a\" href=\"#x\">link</a>" +
		"<div style=\"height: 9lh\"></div><a id=\"b\" href=\"#y\">far</a></div>";
	await dom.attach();
	await nextFrame(dom);
	const pane = document.getElementById("s")!;
	const inPane = (id: string) => {
		const link = document.getElementById(id)!.getBoundingClientRect();
		const port = pane.getBoundingClientRect();
		return link.top >= port.top && link.bottom <= port.bottom;
	};

	terminal.stdin.simulateResponse("\t");
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(document.activeElement?.id).toBe("a");
	expect(pane.scrollTop).toBe(5 * 16);
	expect(inPane("a")).toBe(true);

	document.getElementById("b")!.focus();
	expect(inPane("b")).toBe(true);
	dom.dispose();
});

test("the built-in styles lay out the same under every cell size", () => {
	const html =
		"<p>Before.</p><blockquote><p>Quoted.</p>" +
		"<blockquote>Nested.</blockquote></blockquote><p>After.</p>" +
		"<fieldset><legend>Title</legend>x</fieldset>";
	const render = (cellSize: TermDOMOptions["cellSize"]) => {
		const {dom} = make(cellSize, 30, 12);
		const text = dom.renderANSI(html).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
		dom.dispose();
		return text;
	};
	const unit = render("unit");
	expect(unit.split("\n").slice(0, 5)).toEqual([
		"Before.",
		"│ Quoted.",
		"│ │ Nested.",
		"After.",
		"┌─ Title ────────────────────┐",
	]);
	expect(render("typical")).toBe(unit);
});

test("a select's picker opens under it and takes clicks under a larger cell", async () => {
	const {terminal, dom} = make("typical", 40, 12);
	const {document} = dom;
	document.body.innerHTML =
		"<div>one</div><div>two</div><select id=\"s\">" +
		"<option value=\"a\">Alpha</option><option value=\"b\">Beta</option>" +
		"<option value=\"c\">Gamma</option></select>";
	await dom.attach();
	await nextFrame(dom);
	const click = async (col: number, row: number) => {
		terminal.stdin.simulateResponse(
			`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await nextFrame(dom);
	};
	// The select is on row 3; its picker opens below it, border first.
	await click(2, 3);
	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("one");
	expect(rows[3]).toContain("┌");
	// Rows: 3 field, 4 border, 5 Alpha, 6 Beta, 7 Gamma.
	await click(3, 7);
	expect((document.getElementById("s") as HTMLSelectElement).value).toBe("c");
	dom.dispose();
});

test("a sticky box holds to the top of the scrolled document under a larger cell", async () => {
	const {dom} = make("typical", 30, 8);
	const {document, window} = dom;
	document.body.innerHTML =
		"<div id=\"bar\" style=\"position: sticky; top: 0\">bar</div>" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("");
	await dom.attach();
	await nextFrame(dom);
	window.scrollTo(0, 5 * 16);
	await nextFrame(dom);
	expect(document.getElementById("bar")!.getBoundingClientRect().top).toBe(0);
	dom.dispose();
});

test("a tab-size length is measured across, a count in spaces", () => {
	const {dom} = make("typical", 40, 5);
	const render = (tabSize: string) =>
		dom
			.renderANSI(`<pre style="tab-size: ${tabSize}">a\tb</pre>`)
			.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
			.split("\n")[0];
	expect(render("32px")).toBe("a   b");
	expect(render("4")).toBe("a   b");
	dom.dispose();
});
