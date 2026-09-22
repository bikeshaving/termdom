import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

async function paint(style: string): Promise<string> {
	const terminal = new MockProcess({cols: 12, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<div style="width: 6ch; height: 3px; border: 1px solid #00ff00; ${style}">x</div>`;
	await nextFrame(dom);
	const output = terminal.getStaticANSI();
	dom.dispose();
	return output;
}

test("an outline in currentcolor paints in the element's color", async () => {
	const named = await paint("color: #ff0000; outline: 1px solid #ff0000");
	const current = await paint("color: #ff0000; outline: 1px solid");
	const none = await paint("color: #ff0000");
	expect(current).toBe(named);
	expect(current).not.toBe(none);
});

test("an outline on a borderless box overlines its top row and underlines its bottom row", async () => {
	const terminal = new MockProcess({cols: 12, rows: 5});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div style=\"width: 6ch; height: 3px; outline: 1px solid #ff0000\">x</div>";
	await nextFrame(dom);
	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);

	for (const col of [0, 5]) {
		expect(cellAt(0, col).isOverline()).toBeTruthy();
		expect(cellAt(0, col).isUnderline()).toBeFalsy();
		expect(cellAt(1, col).isOverline()).toBeFalsy();
		expect(cellAt(1, col).isUnderline()).toBeFalsy();
		expect(cellAt(2, col).isUnderline()).toBeTruthy();
		expect(cellAt(2, col).isOverline()).toBeFalsy();
	}
	expect(cellAt(0, 6).isOverline()).toBeFalsy();
	expect(cellAt(2, 1).getFgColor()).toBe(0xff0000);
	dom.dispose();
});

test("focusing an element outlines it without moving its content", async () => {
	const terminal = new MockProcess({cols: 20, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<div id=\"host\" tabindex=\"0\">first line<br>second line</div>";
	await nextFrame(dom);
	const text = () =>
		terminal.getPlainText().split("\n").map((line) => line.trimEnd());
	const before = text();
	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);

	(dom.document.getElementById("host") as HTMLElement).focus();
	await nextFrame(dom);
	expect(text()).toEqual(before);
	expect(cellAt(0, 0).isOverline()).toBeTruthy();
	expect(cellAt(1, 0).isUnderline()).toBeTruthy();
	expect(cellAt(1, 0).isFgDefault()).toBeTruthy();
	dom.dispose();
});

test("focus shows the cursor on a text field and an outline on other controls", async () => {
	const focus = async (html: string) => {
		const terminal = new MockProcess({cols: 30, rows: 3});
		const dom = new TermDOM({transport: terminal.transport});
		dom.document.body.innerHTML = html;
		await nextFrame(dom);
		const raw = captureRawOutput(terminal);
		(dom.document.getElementById("control") as HTMLElement).focus();
		await nextFrame(dom);
		const output = raw();
		const cell = (terminal as any).terminal.buffer.active.getLine(0).getCell(1);
		const result = {
			cursor: output.lastIndexOf("\x1b[?25h") > output.lastIndexOf("\x1b[?25l"),
			outlined: Boolean(cell.isOverline()) && Boolean(cell.isUnderline()),
		};
		dom.dispose();
		return result;
	};

	expect(await focus("<input id=\"control\" value=\"hi\">"))
		.toEqual({cursor: true, outlined: false});
	expect(await focus("<textarea id=\"control\" rows=\"1\"></textarea>"))
		.toEqual({cursor: true, outlined: false});
	expect(await focus("<input id=\"control\" type=\"checkbox\">"))
		.toEqual({cursor: false, outlined: true});
	expect(await focus("<input id=\"control\" type=\"submit\" value=\"Go\">"))
		.toEqual({cursor: false, outlined: true});
	expect(await focus("<select id=\"control\"><option>one</option></select>"))
		.toEqual({cursor: false, outlined: true});
});

test("an outline on a one-row box lines both edges of that row", async () => {
	const terminal = new MockProcess({cols: 12, rows: 3});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<span style=\"display: inline-block; outline: 1px solid\">go</span>";
	await nextFrame(dom);
	const cell = (terminal as any).terminal.buffer.active.getLine(0).getCell(0);
	expect(cell.isOverline()).toBeTruthy();
	expect(cell.isUnderline()).toBeTruthy();
	dom.dispose();
});

test("a focused inline broken across lines is outlined along each of its fragments", async () => {
	const terminal = new MockProcess({cols: 12, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<p>see <a href=\"#\" id=\"a\">a link that wraps</a> here</p>";
	await nextFrame(dom);
	dom.document.getElementById("a")!.focus();
	await nextFrame(dom);
	const rows = terminal.getVisibleText().split("\n");
	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	// Row 0: "see a link" -- the link's first fragment is cols 4..9.
	expect(rows[0].trimEnd()).toBe("see a link");
	expect(!!cellAt(0, 4).isUnderline()).toBe(true);
	expect(!!cellAt(0, 9).isUnderline()).toBe(true);
	expect(!!cellAt(0, 2).isUnderline()).toBe(false);
	// Row 1: "that wraps" is the second fragment, then " here" is not.
	expect(rows[1].trimEnd()).toBe("that wraps");
	expect(!!cellAt(1, 0).isUnderline()).toBe(true);
	expect(!!cellAt(1, 9).isUnderline()).toBe(true);
	expect(!!cellAt(1, 10).isUnderline()).toBe(false);
	expect(!!cellAt(1, 11).isUnderline()).toBe(false);
	dom.dispose();
});
