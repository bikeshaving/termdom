/**
 * The keys a browser scrolls with, as the default action of a keydown
 * nothing canceled: the arrows a row, PageUp, PageDown and Space a page,
 * Home and End to an edge. They move the nearest scroller around the
 * focus that can go that way, and the document otherwise, and leave keys
 * a control or editable content takes alone.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame, until} from "./test-utils.js";

const KEYS: Record<string, string> = {
	ArrowUp: "\x1b[A",
	ArrowDown: "\x1b[B",
	PageUp: "\x1b[5~",
	PageDown: "\x1b[6~",
	Home: "\x1b[H",
	End: "\x1b[F",
	" ": " ",
};

async function press(terminal: MockProcess, key: string): Promise<void> {
	terminal.stdin.simulateResponse(KEYS[key]);
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function longDocument(): Promise<{terminal: MockProcess; dom: TermDOM}> {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = Array.from(
		{length: 40},
		(_, i) => `<div>row ${i}</div>`,
	).join("");
	await dom.attach();
	await nextFrame(dom);
	return {terminal, dom};
}

test("the arrows, the page keys, Space, Home and End scroll the document", async () => {
	const {terminal, dom} = await longDocument();
	const {window} = dom;
	await press(terminal, "ArrowDown");
	await until(() => window.scrollY === 1);
	await press(terminal, "PageDown");
	await until(() => window.scrollY === 10);
	await press(terminal, " ");
	await until(() => window.scrollY === 19);
	await press(terminal, "ArrowUp");
	await until(() => window.scrollY === 18);
	await press(terminal, "End");
	await until(() => window.scrollY === 30);
	await press(terminal, "PageUp");
	await until(() => window.scrollY === 21);
	await press(terminal, "Home");
	await until(() => window.scrollY === 0);
	expect(window.scrollY).toBe(0);
	await dom.dispose();
});

test("a canceled keydown scrolls nothing", async () => {
	const {terminal, dom} = await longDocument();
	let seen = 0;
	dom.document.addEventListener("keydown", (event) => {
		seen++;
		event.preventDefault();
	});
	await press(terminal, "ArrowDown");
	await press(terminal, "PageDown");
	await until(() => seen === 2);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(0);
	await dom.dispose();
});

test("the nearest scroller around the focus takes the keys first", async () => {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<div id=box tabindex=0 style=\"height: 4px; overflow: auto\">" +
		Array.from({length: 12}, (_, i) => `<div>line ${i}</div>`).join("") +
		"</div>" +
		Array.from({length: 30}, (_, i) => `<div>row ${i}</div>`).join("");
	await dom.attach();
	const box = document.getElementById("box")!;
	box.focus();
	await nextFrame(dom);
	await press(terminal, "ArrowDown");
	await until(() => box.scrollTop === 1);
	await press(terminal, "PageDown");
	await until(() => box.scrollTop === 4);
	await press(terminal, "End");
	await until(() => box.scrollTop === 8);
	// At its end, the box lets the next key go to the document.
	await press(terminal, "ArrowDown");
	await until(() => dom.window.scrollY === 1);
	expect(box.scrollTop).toBe(8);
	await dom.dispose();
});

test("keys a field or editable content takes do not scroll", async () => {
	const {terminal, dom} = await longDocument();
	const {document} = dom;
	const field = document.createElement("input");
	const note = document.createElement("div");
	note.contentEditable = "true";
	note.textContent = "note";
	document.body.prepend(field, note);
	for (const target of [field, note]) {
		target.focus();
		await nextFrame(dom);
		await press(terminal, "End");
		await press(terminal, " ");
		await press(terminal, "ArrowDown");
		await nextFrame(dom);
		expect(dom.window.scrollY).toBe(0);
	}
	await dom.dispose();
});

test("Space on a button presses it rather than scrolling", async () => {
	const {terminal, dom} = await longDocument();
	const {document} = dom;
	const button = document.createElement("button");
	button.textContent = "go";
	let clicks = 0;
	button.addEventListener("click", () => clicks++);
	document.body.prepend(button);
	button.focus();
	await nextFrame(dom);
	await press(terminal, " ");
	await until(() => clicks === 1);
	await nextFrame(dom);
	expect(dom.window.scrollY).toBe(0);
	await dom.dispose();
});

test("the arrows move through a radio group, checking and wrapping", async () => {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<input type=radio name=size value=s checked>" +
		"<input type=radio name=size value=m disabled>" +
		"<input type=radio name=size value=l>" +
		"<input type=radio name=other value=x>";
	await dom.attach();
	const radios = [...document.querySelectorAll("input")] as HTMLInputElement[];
	const changes: string[] = [];
	for (const radio of radios) {
		radio.addEventListener("change", () => changes.push(radio.value));
	}
	radios[0].focus();
	await nextFrame(dom);
	await press(terminal, "ArrowDown");
	await until(() => radios[2].checked);
	expect(document.activeElement).toBe(radios[2]);
	await press(terminal, "ArrowDown");
	await until(() => radios[0].checked);
	await press(terminal, "ArrowUp");
	await until(() => radios[2].checked);
	expect(changes).toEqual(["l", "s", "l"]);
	expect(radios[3].checked).toBe(false);
	await dom.dispose();
});
