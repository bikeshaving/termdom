/**
 * A transform's translation draws a box away from where layout put it,
 * and the box takes pointer events there. Nothing around it moves. A
 * rotation, scale or skew draws the box as it is.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.ts";

function domFor(body: string): {dom: TermDOM; terminal: MockProcess} {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({
		html: `<!DOCTYPE html><html><body style="margin: 0">${body}</body></html>`,
		transport: terminal.transport,
	});
	return {dom, terminal};
}

function screenRow(terminal: MockProcess, row: number): string {
	return terminal.terminal.buffer.active
		.getLine(row)!
		.translateToString(true);
}

test("translateX moves a box by a length, and what follows stays", async () => {
	const {dom, terminal} = domFor(
		"<div style=\"transform: translateX(5ch)\">moved</div><div>after</div>",
	);
	await nextFrame(dom);
	expect(screenRow(terminal, 0)).toBe("     moved");
	expect(screenRow(terminal, 1)).toBe("after");
	const moved = dom.document.querySelector("div")!;
	expect(moved.getBoundingClientRect().left).toBe(5);
	expect(dom.document.elementFromPoint(6, 0)).toBe(moved);
	expect(dom.document.elementFromPoint(2, 0)).toBe(dom.document.body);
	dom.dispose();
});

test("a percentage is of the box's own size", async () => {
	const {dom, terminal} =
		domFor("<div style=\"width: 10ch; translate: 50% 100%\">half</div>");
	await nextFrame(dom);
	expect(screenRow(terminal, 0)).toBe("");
	expect(screenRow(terminal, 1)).toBe("     half");
	dom.dispose();
});

test("translations add up, and other functions draw the box in place", async () => {
	const {dom, terminal} = domFor(
		"<div style=\"transform: translate(2ch, 0) rotate(5deg)" +
			" translateX(1ch) scale(2)\">x</div>",
	);
	await nextFrame(dom);
	expect(screenRow(terminal, 0)).toBe("   x");
	dom.dispose();
});

test("a matrix moves the box by its last two numbers, in pixels", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({
		html:
			"<!DOCTYPE html><html><body style=\"margin: 0\"><div" +
			" style=\"transform: matrix(1, 0, 0, 1, 24, 16)\">m</div></body></html>",
		transport: terminal.transport,
		cellSize: {width: 8, height: 16},
	});
	await nextFrame(dom);
	expect(screenRow(terminal, 1)).toBe("   m");
	dom.dispose();
});

test("a menu translated off screen opens when its transform is cleared", async () => {
	const {dom, terminal} = domFor(
		"<nav id=\"menu\" style=\"position: fixed; top: 0; left: 0; width: 8ch;" +
			" transform: translateX(-100%)\">MENU</nav><p style=\"margin: 0\">page</p>",
	);
	await nextFrame(dom);
	expect(screenRow(terminal, 0)).toBe("page");
	const menu = dom.document.getElementById("menu")!;
	expect(dom.document.elementFromPoint(1, 0)?.localName).toBe("p");

	menu.style.transform = "none";
	await nextFrame(dom);
	expect(screenRow(terminal, 0)).toBe("MENU");
	expect(dom.document.elementFromPoint(1, 0)).toBe(menu);

	menu.style.transform = "translateX(-100%)";
	await nextFrame(dom);
	expect(screenRow(terminal, 0)).toBe("page");
	dom.dispose();
});
