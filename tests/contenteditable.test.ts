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

test("focusing a host skips the whitespace between its blocks", async () => {
	const fixture = await withHost(
		"<div contenteditable>\n  <h2>Notes</h2>\n  <div>body</div>\n</div>",
	);
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const point = caret(document);
	expect(point.node).toBe(host.querySelector("h2")!.firstChild);
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

test("the caret stays inside the host when a motion would leave it", async () => {
	const fixture = await withHost(
		"<div>above</div><div contenteditable><div>one</div><div>two</div></div>" +
		"<div>below the host</div>",
	);
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const one = host.firstChild!.firstChild!;
	const two = host.lastChild!.firstChild!;

	// Down on the last line lands at its end; Up on the first at its start.
	await fixture.type("\x1b[B\x1b[B");
	expect(caret(document)).toEqual({node: two, offset: 3});
	await fixture.type("\x1b[A\x1b[A");
	expect(caret(document)).toEqual({node: one, offset: 0});
	// Left at the start and Right at the end go nowhere, so no frame
	// follows them.
	await send(fixture.terminal, "\x1b[D");
	expect(caret(document)).toEqual({node: one, offset: 0});
	await fixture.type("\x1b[F\x1b[B");
	await send(fixture.terminal, "\x1b[C");
	expect(caret(document)).toEqual({node: two, offset: 3});
	// Shift+Down on the last line extends to its end and no further.
	await fixture.type("\x1b[H\x1b[1;2B");
	const selection = document.getSelection()!;
	expect([selection.focusNode, selection.focusOffset]).toEqual([two, 3]);

	// The application-cursor forms of the keys move the same way.
	await fixture.type("\x1bOH\x1bOA\x1bOC");
	expect(caret(document)).toEqual({node: one, offset: 1});
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

test("Enter splits the caret's block and leaves an empty one one line tall", async () => {
	const fixture = await withHost("<div contenteditable><p>abcd</p></div>");
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const seen: string[] = [];
	host.addEventListener("beforeinput", (event: any) => {
		seen.push(event.inputType);
	});

	await fixture.type("\x1b[C\x1b[C");
	await fixture.type("\r");
	expect(host.innerHTML).toBe("<p>ab</p><p>cd</p>");
	expect(seen).toEqual(["insertParagraph"]);
	expect(caret(document).node).toBe(host.lastChild.firstChild);
	expect(caret(document).offset).toBe(0);

	// At the end of a paragraph the new one is empty, and its placeholder
	// <br> keeps it a line tall.
	await fixture.type("\x1b[F\r");
	expect(host.innerHTML).toBe("<p>ab</p><p>cd</p><p><br></p>");
	const rows = fixture.terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("ab");
	expect(rows[1]).toContain("cd");

	// Typing takes the placeholder away again.
	await fixture.type("e");
	expect(host.innerHTML).toBe("<p>ab</p><p>cd</p><p>e</p>");
	fixture.dom.dispose();
});

test("Enter at the end of a heading starts a div", async () => {
	const fixture = await withHost("<div contenteditable><h1>title</h1></div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[F\r");
	expect(host.innerHTML).toBe("<h1>title</h1><div><br></div>");

	// In the middle it is the heading that splits.
	host.innerHTML = "<h1>title</h1>";
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[H\x1b[C\x1b[C\r");
	expect(host.innerHTML).toBe("<h1>ti</h1><h1>tle</h1>");
	fixture.dom.dispose();
});

test("Enter with no block wraps the line in a div and starts another", async () => {
	const fixture = await withHost("<div contenteditable>abcd</div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[C\x1b[C\r");
	expect(host.innerHTML).toBe("<div>ab</div><div>cd</div>");
	fixture.dom.dispose();
});

test("Enter splits the inline elements around the caret with the block", async () => {
	const fixture = await withHost(
		"<div contenteditable><p>he<b>ll<i>o</i> there</b></p></div>",
	);
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[C\x1b[C\x1b[C\x1b[C");
	await fixture.type("\r");
	expect(host.innerHTML).toBe("<p>he<b>ll</b></p><p><b><i>o</i> there</b></p>");
	fixture.dom.dispose();
});

test("Shift+Enter inserts a <br>", async () => {
	const fixture = await withHost("<div contenteditable><p>abcd</p></div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const seen: string[] = [];
	host.addEventListener("beforeinput", (event: any) => {
		seen.push(event.inputType);
	});
	await fixture.type("\x1b[C\x1b[C");
	// No terminal sends Shift+Enter as a sequence of its own, so the key
	// arrives the way a page would send it.
	host.dispatchEvent(
		new (fixture.dom.window as any).KeyboardEvent("keydown", {
			key: "Enter",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}),
	);
	await nextFrame(fixture.dom);
	expect(host.innerHTML).toBe("<p>ab<br>cd</p>");
	expect(seen).toEqual(["insertLineBreak"]);

	// A break at the end of a block gets the placeholder that keeps the
	// new line a line.
	await fixture.type("\x1b[F");
	host.dispatchEvent(
		new (fixture.dom.window as any).KeyboardEvent("keydown", {
			key: "Enter",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}),
	);
	await nextFrame(fixture.dom);
	expect(host.innerHTML).toBe("<p>ab<br>cd<br><br></p>");
	await fixture.type("e");
	expect(host.innerHTML).toBe("<p>ab<br>cd<br>e</p>");
	fixture.dom.dispose();
});

test("Backspace at a block's start merges it into the one before", async () => {
	const fixture =
		await withHost("<div contenteditable><p>one</p><p>two</p></div>");
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const second = host.lastChild;
	document
		.getSelection()
		.setBaseAndExtent(second.firstChild, 0, second.firstChild, 0);
	await fixture.type("\x7f");
	expect(host.innerHTML).toBe("<p>onetwo</p>");
	expect(caret(document).offset).toBe(3);

	// Delete at the end takes the next block in the same way.
	host.innerHTML = "<p>one</p><p>two</p>";
	await nextFrame(fixture.dom);
	const first = host.firstChild;
	document
		.getSelection()
		.setBaseAndExtent(first.firstChild, 3, first.firstChild, 3);
	await fixture.type("\x1b[3~");
	expect(host.innerHTML).toBe("<p>onetwo</p>");
	fixture.dom.dispose();
});

test("deleting a selection that spans blocks joins the two ends", async () => {
	const fixture = await withHost(
		"<div contenteditable><p>one</p><p>two</p><p>three</p></div>",
	);
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	document
		.getSelection()
		.setBaseAndExtent(
			host.firstChild.firstChild,
			1,
			host.lastChild.firstChild,
			2,
		);
	await fixture.type("\x7f");
	expect(host.innerHTML).toBe("<p>oree</p>");
	fixture.dom.dispose();
});

test("emptying a block leaves the placeholder <br> behind", async () => {
	const fixture = await withHost("<div contenteditable><p>a</p></div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[F\x7f");
	expect(host.innerHTML).toBe("<p><br></p>");
	fixture.dom.dispose();
});

test("Enter in a list makes another item; Enter in an empty item ends it", async () => {
	const fixture = await withHost(
		"<div contenteditable><ul><li>one</li><li>two</li></ul></div>",
	);
	const {document, host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	const second = host.querySelectorAll("li")[1];
	document
		.getSelection()
		.setBaseAndExtent(second.firstChild, 3, second.firstChild, 3);
	await fixture.type("\r");
	expect(host.innerHTML).toBe("<ul><li>one</li><li>two</li><li><br></li></ul>");

	// The empty item leaves the list rather than making another.
	await fixture.type("\r");
	expect(host.innerHTML).toBe(
		"<ul><li>one</li><li>two</li></ul><div><br></div>",
	);
	await fixture.type("x");
	expect(host.innerHTML).toBe("<ul><li>one</li><li>two</li></ul><div>x</div>");
	fixture.dom.dispose();
});

test("a pasted line break starts a new block", async () => {
	const fixture = await withHost("<div contenteditable><p>ad</p></div>");
	const {host} = fixture;
	host.focus();
	await nextFrame(fixture.dom);
	await fixture.type("\x1b[C");
	await fixture.type("\x1b[200~b\rc\x1b[201~");
	expect(host.innerHTML).toBe("<p>ab</p><p>cd</p>");
	fixture.dom.dispose();
});
