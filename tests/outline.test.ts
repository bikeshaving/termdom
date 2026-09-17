import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

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
