/**
 * user-select: none keeps text out of the selection: the mouse cannot anchor
 * or extend into it, Selection.modify walks past it, and the painter lays no
 * highlight over it. `auto` resolves through the parent; a `text` descendant
 * inside a `none` ancestor selects again.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

const press = (col: number, row: number): string => `\x1b[<0;${col};${row}M`;
const drag = (col: number, row: number): string => `\x1b[<32;${col};${row}M`;
const release = (col: number, row: number): string => `\x1b[<0;${col};${row}m`;

function mouseDOM(): {terminal: MockProcess; dom: TermDOM} {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	return {terminal, dom};
}

async function type(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("a press on user-select: none anchors nothing", async () => {
	const {terminal, dom} = mouseDOM();
	dom.document.body.innerHTML =
		"<div style=\"user-select: none\">frozen</div><div>liquid</div>";
	await nextFrame(dom);

	await type(terminal, press(1, 1));
	await type(terminal, drag(6, 1));
	await type(terminal, release(6, 1));
	await nextFrame(dom);
	expect(dom.window.getSelection()!.toString()).toEqual("");

	dom.dispose();
});

test("a drag does not extend into user-select: none", async () => {
	const {terminal, dom} = mouseDOM();
	dom.document.body.innerHTML =
		"<div>liquid</div><div style=\"user-select: none\">frozen</div>";
	await nextFrame(dom);

	await type(terminal, press(1, 1));
	await type(terminal, drag(6, 1));
	await type(terminal, drag(6, 2));
	await type(terminal, release(6, 2));
	await nextFrame(dom);
	expect(dom.window.getSelection()!.toString()).toEqual("liqui");

	dom.dispose();
});

test("auto resolves through the parent, and text re-enables inside none", async () => {
	const {terminal, dom} = mouseDOM();
	dom.document.body.innerHTML =
		"<div style=\"user-select: none\">out <span style=\"user-select: text\">in</span></div>";
	await nextFrame(dom);

	await type(terminal, press(5, 1));
	await type(terminal, drag(7, 1));
	await type(terminal, release(7, 1));
	await nextFrame(dom);
	expect(dom.window.getSelection()!.toString()).toEqual("in");

	dom.dispose();
});

test("Selection.modify walks past user-select: none text", async () => {
	const {dom} = mouseDOM();
	dom.document.body.innerHTML =
		"<div id=\"a\">alpha</div>" +
		"<div style=\"user-select: none\">frozen</div>" +
		"<div id=\"b\">beta</div>";
	await nextFrame(dom);

	const a = dom.document.getElementById("a")!.firstChild as Text;
	const selection = dom.window.getSelection()!;
	selection.setBaseAndExtent(a, 5, a, 5);
	selection.modify("move", "forward", "character");
	const focus = selection.focusNode as Text;
	expect(focus.data).toEqual("beta");

	dom.dispose();
});

test("the painter lays no highlight over user-select: none", async () => {
	const {terminal, dom} = mouseDOM();
	dom.document.body.innerHTML =
		"<div>liquid</div><div style=\"user-select: none\">frozen</div>";
	await nextFrame(dom);

	// A programmatic range may span anything; the paint still skips none.
	const selection = dom.window.getSelection()!;
	const liquid = dom.document.querySelector("div")!.firstChild as Text;
	const frozen = dom.document.querySelectorAll("div")[1].firstChild as Text;
	selection.setBaseAndExtent(liquid, 0, frozen, 6);
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	expect(buffer.getLine(0).getCell(0).isInverse()).toBeTruthy();
	expect(buffer.getLine(1).getCell(0).isInverse()).toBeFalsy();

	dom.dispose();
});
