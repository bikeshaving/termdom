/**
 * contenteditable: an editing host takes the caret, the arrows walk it
 * around, and the keys that edit go through beforeinput before anything
 * in the tree moves.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

/** Feed bytes as the terminal would, and let the read side see them. */
function send(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as any).emit("data", Buffer.from(data));
	return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Fixture {
	terminal: MockProcess;
	dom: TermDOM;
	document: any;
	host: any;
	type(data: string): Promise<void>;
	cursor(): {x: number; y: number};
}

async function withHost(html: string, cols = 40): Promise<Fixture> {
	const terminal = new MockProcess({rows: 12, cols});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	await new Promise((r) => setTimeout(r, 0));
	const document = dom.document as any;
	document.body.innerHTML = html;
	const host = document.querySelector("[contenteditable]");
	await nextFrame(dom);
	return {
		terminal,
		dom,
		document,
		host,
		async type(data: string) {
			await send(terminal, data);
			await nextFrame(dom);
		},
		cursor() {
			const buffer = (terminal as any).terminal.buffer.active;
			return {x: buffer.cursorX, y: buffer.cursorY};
		},
	};
}

function caret(document: any): {node: any; offset: number} {
	const selection = document.getSelection();
	return {node: selection.focusNode, offset: selection.focusOffset};
}

test("a contenteditable element is focusable and reports its state", async () => {
	const fixture = await withHost("<div contenteditable>hello</div>");
	const {document, host} = fixture;
	expect(host.isContentEditable).toBe(true);
	expect(host.contentEditable).toBe("true");
	host.focus();
	expect(document.activeElement).toBe(host);
	fixture.dom.dispose();
});

test("focusing a host with no selection inside it parks the caret at its start", async () => {
	const fixture = await withHost("<div contenteditable>hello</div>");
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const point = caret(document);
	expect(point.node).toBe(host.firstChild);
	expect(point.offset).toBe(0);
	fixture.dom.dispose();
});

test("a focused host parks the terminal cursor at the caret", async () => {
	const fixture =
		await withHost("<div>title</div><div contenteditable>hello</div>");
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const start = fixture.cursor();
	expect(start.x).toBe(0);

	const text = host.firstChild;
	document.getSelection().setBaseAndExtent(text, 3, text, 3);
	await nextFrame(fixture.dom);
	const moved = fixture.cursor();
	expect(moved.y).toBe(start.y);
	expect(moved.x).toBe(3);
	fixture.dom.dispose();
});

test("arrows walk the caret by character, word and line; Shift extends", async () => {
	const fixture = await withHost(
		"<div contenteditable>one two three four five six seven</div>",
		20,
	);
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);

	await fixture.type("\x1b[C\x1b[C");
	expect(caret(document).offset).toBe(2);
	await fixture.type("\x1b[D");
	expect(caret(document).offset).toBe(1);

	// Alt+Right and Ctrl+Right move by word.
	await fixture.type("\x1b[1;3C");
	expect(caret(document).offset).toBe(3);
	await fixture.type("\x1b[1;5C");
	expect(caret(document).offset).toBe(7);

	// Home and End are the laid-out line's bounds, soft wraps included.
	await fixture.type("\x1b[H");
	expect(caret(document).offset).toBe(0);
	const firstRow = fixture.cursor().y;
	expect(fixture.cursor().x).toBe(0);

	// Down and Up cross the soft wrap.
	await fixture.type("\x1b[B");
	expect(fixture.cursor().y).toBe(firstRow + 1);
	await fixture.type("\x1b[A");
	expect(fixture.cursor().y).toBe(firstRow);

	await fixture.type("\x1b[F");
	expect(caret(document).offset).toBe(19);

	// Shift+Right extends rather than moving.
	const anchor = caret(document).offset;
	await fixture.type("\x1b[1;2C\x1b[1;2C");
	expect(document.getSelection().isCollapsed).toBe(false);
	expect(document.getSelection().anchorOffset).toBe(anchor);
	expect(caret(document).offset).toBe(anchor + 2);
	fixture.dom.dispose();
});

test("a contenteditable=false island is stepped over as one unit", async () => {
	const fixture = await withHost(
		"<div contenteditable>ab<span contenteditable=\"false\">XY</span>cd</div>",
	);
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const island = host.querySelector("span");

	await fixture.type("\x1b[C\x1b[C");
	expect(caret(document).offset).toBe(2);
	// One more step lands past the island, never inside it.
	await fixture.type("\x1b[C");
	expect(island.contains(caret(document).node)).toBe(false);
	expect(caret(document).node).toBe(host.lastChild);
	expect(caret(document).offset).toBe(0);

	// And back over it in one step.
	await fixture.type("\x1b[D");
	expect(island.contains(caret(document).node)).toBe(false);
	expect(caret(document).node).toBe(host.firstChild);
	expect(caret(document).offset).toBe(2);
	fixture.dom.dispose();
});

test("a click in a host collapses the caret at the point", async () => {
	const fixture = await withHost("<div contenteditable>hello world</div>");
	const {document, host} = fixture;
	await fixture.type("\x1b[<0;5;1M\x1b[<0;5;1m");
	expect(document.activeElement).toBe(host);
	expect(caret(document).node).toBe(host.firstChild);
	expect(caret(document).offset).toBe(4);
	fixture.dom.dispose();
});

test("designMode on makes the body an editing host", async () => {
	const fixture = await withHost("<p>hello</p>");
	const {document} = fixture;
	expect(document.designMode).toBe("off");
	document.designMode = "on";
	expect(document.designMode).toBe("on");
	// Nothing else is focused, so the body is the keydown target.
	await fixture.type("\x1b[C\x1b[C");
	const point = caret(document);
	expect(point.node).toBe(document.querySelector("p").firstChild);
	expect(point.offset).toBe(2);
	document.designMode = "off";
	fixture.dom.dispose();
});

test("typing inserts text at the caret and fires beforeinput then input", async () => {
	const fixture = await withHost("<div contenteditable>ac</div>");
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[C");

	const seen: string[] = [];
	for (const type of ["beforeinput", "input"]) {
		host.addEventListener(type, (event: any) => {
			seen.push(`${event.type}:${event.inputType}:${event.data}`);
		});
	}
	await fixture.type("b");
	expect(host.innerHTML).toBe("abc");
	expect(seen).toEqual(["beforeinput:insertText:b", "input:insertText:b"]);
	expect(caret(document).offset).toBe(2);
	expect(fixture.terminal.getPlainText()).toContain("abc");
	fixture.dom.dispose();
});

test("a canceled beforeinput leaves the tree alone", async () => {
	const fixture = await withHost("<div contenteditable>ac</div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	host.addEventListener("beforeinput", (event: any) => event.preventDefault());
	let inputs = 0;
	host.addEventListener("input", () => inputs++);
	await fixture.type("b\x7f");
	expect(host.innerHTML).toBe("ac");
	expect(inputs).toBe(0);
	fixture.dom.dispose();
});

test("typing into an empty host makes the text node it needs", async () => {
	const fixture = await withHost("<div contenteditable></div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("hi");
	expect(host.innerHTML).toBe("hi");
	expect(host.childNodes.length).toBe(1);
	fixture.dom.dispose();
});

test("Backspace and Delete take one grapheme cluster or the selection", async () => {
	const fixture =
		await withHost("<div contenteditable>a\u{1f469}\u{200d}\u{1f4bb}bc</div>");
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const seen: string[] = [];
	host.addEventListener("beforeinput", (event: any) => {
		seen.push(event.inputType);
	});

	// Past "a" and the whole ZWJ sequence, then back over it in one Backspace.
	await fixture.type("\x1b[C\x1b[C");
	await fixture.type("\x7f");
	expect(host.textContent).toBe("abc");
	expect(caret(document).offset).toBe(1);

	// Delete takes the character in front of the caret.
	await fixture.type("\x1b[3~");
	expect(host.textContent).toBe("ac");

	// A selection goes whole.
	document
		.getSelection()
		.setBaseAndExtent(host.firstChild, 0, host.firstChild, 2);
	await fixture.type("\x7f");
	expect(host.textContent).toBe("");
	expect(seen).toEqual([
		"deleteContentBackward",
		"deleteContentForward",
		"deleteContentBackward",
	]);
	fixture.dom.dispose();
});

test("Ctrl+W, Ctrl+U and Ctrl+K delete by word and by line", async () => {
	const fixture = await withHost("<div contenteditable>one two three</div>");
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const seen: string[] = [];
	host.addEventListener("beforeinput", (event: any) => {
		seen.push(event.inputType);
	});

	// To the end, then one word back.
	await fixture.type("\x1b[F");
	await fixture.type("\x17");
	expect(host.textContent).toBe("one two ");

	// Ctrl+K from the middle takes the rest of the line.
	host.textContent = "one two three";
	await nextFrame(fixture.dom);
	document
		.getSelection()
		.setBaseAndExtent(host.firstChild, 4, host.firstChild, 4);
	await fixture.type("\x0b");
	expect(host.textContent).toBe("one ");

	// Ctrl+U takes the line back to its start.
	host.textContent = "one two three";
	await nextFrame(fixture.dom);
	document
		.getSelection()
		.setBaseAndExtent(host.firstChild, 8, host.firstChild, 8);
	await fixture.type("\x15");
	expect(host.textContent).toBe("three");
	expect(seen).toEqual([
		"deleteWordBackward",
		"deleteSoftLineForward",
		"deleteSoftLineBackward",
	]);
	fixture.dom.dispose();
});

test("a space that would collapse away is written as a non-breaking space", async () => {
	const fixture = await withHost("<div contenteditable>a</div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[F");

	// A trailing space has nothing after it to hold it open.
	await fixture.type(" ");
	expect(host.innerHTML).toBe("a&nbsp;");
	// A letter after it gives the space something to sit between.
	await fixture.type("b");
	expect(host.innerHTML).toBe("a b");
	// In a run only the last space can stay plain.
	await fixture.type("  c");
	expect(host.innerHTML).toBe("a b&nbsp; c");
	expect(fixture.terminal.getPlainText()).toContain("a b\u00a0 c");
	fixture.dom.dispose();
});

test("a paste inserts its text through insertFromPaste", async () => {
	const fixture = await withHost("<div contenteditable>ac</div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[C");
	const seen: string[] = [];
	for (const type of ["paste", "beforeinput", "input"]) {
		host.addEventListener(type, (event: any) => seen.push(event.type));
	}
	await fixture.type("\x1b[200~b\x1b[201~");
	expect(host.innerHTML).toBe("abc");
	expect(seen).toEqual(["paste", "beforeinput", "input"]);
	fixture.dom.dispose();
});
