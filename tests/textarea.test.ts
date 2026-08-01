/**
 * <textarea> as a UA shadow tree: the value is a real text node
 * (part="value") laid out by the NORMAL pipeline -- newlines and soft
 * wrapping come from white-space: pre-wrap, not from a widget painter.
 * What stays native is exactly what a browser also keeps native: caret
 * parking and key handling. The tree is as closed as an input's.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

function type(terminal: MockProcess, data: string) {
	(terminal.stdin as any).emit("data", Buffer.from(data));
}

test("textarea renders its multiline value inside the bordered box", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const textarea = document.createElement("textarea");
	textarea.value = "first line\nsecond line";
	document.body.appendChild(textarea);
	await nextFrame(dom);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("first line");
	expect(output).toContain("second line");
	// Distinct rows, in order.
	const lines = output.split("\n");
	const firstRow = lines.findIndex((l) => l.includes("first line"));
	const secondRow = lines.findIndex((l) => l.includes("second line"));
	expect(secondRow).toBe(firstRow + 1);

	dom.dispose();
});

test("long lines soft-wrap at the content edge, as pre-wrap says", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const textarea = document.createElement("textarea");
	textarea.setAttribute("cols", "10");
	textarea.value = "aaaa bbbb cccc";
	document.body.appendChild(textarea);
	await nextFrame(dom);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.replace(/[│┌┐└┘─]/g, "").trim())
		.filter(Boolean);
	expect(lines).toEqual(["aaaa bbbb", "cccc"]);

	dom.dispose();
});

test("typing edits the value; Enter inserts a newline", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const textarea = document.createElement("textarea");
	document.body.appendChild(textarea);
	textarea.focus();
	await nextFrame(dom);

	type(terminal, "ab");
	await nextFrame(dom);
	type(terminal, "\r"); // Enter
	await nextFrame(dom);
	type(terminal, "cd");
	await nextFrame(dom);

	expect(textarea.value).toBe("ab\ncd");
	const output = terminal.getPlainText();
	expect(output).toContain("ab");
	expect(output).toContain("cd");

	dom.dispose();
});

test("the placeholder shows in an empty textarea and hides once typed", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const textarea = document.createElement("textarea");
	textarea.setAttribute("placeholder", "Say something");
	document.body.appendChild(textarea);
	await nextFrame(dom);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("Say something");

	textarea.focus();
	await nextFrame(dom);
	type(terminal, "x");
	await nextFrame(dom);
	await nextFrame(dom);
	const output = terminal.getPlainText();
	expect(output).not.toContain("Say something");
	expect(output).toContain("x");

	dom.dispose();
});

test("textarea internals are closed: no shadowRoot, attachShadow throws", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const textarea = document.createElement("textarea");
	textarea.value = "content";
	document.body.appendChild(textarea);
	await nextFrame(dom);
	await nextFrame(dom);

	expect(textarea.shadowRoot).toBeNull();
	expect(() => textarea.attachShadow({mode: "open"})).toThrow();

	dom.dispose();
});

test("rows and cols size the empty box, as in a browser", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const textarea = document.createElement("textarea");
	textarea.setAttribute("rows", "3");
	textarea.setAttribute("cols", "8");
	document.body.appendChild(textarea);
	await nextFrame(dom);
	await nextFrame(dom);

	const rect = textarea.getBoundingClientRect();
	expect(rect.height).toBe(5); // 3 content rows + 2 border rows
	expect(rect.width).toBe(12); // 8 content cols + 2 border + 2 padding

	dom.dispose();
});

test("the caret parks at the multiline position; arrows move between lines", async () => {
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const textarea = document.createElement("textarea");
	document.body.appendChild(textarea);
	textarea.focus();
	await nextFrame(dom);

	type(terminal, "ab");
	await nextFrame(dom);
	type(terminal, "\r");
	await nextFrame(dom);
	type(terminal, "wxyz");
	await nextFrame(dom);
	await nextFrame(dom);

	// Caret after "wxyz" on the second content row. Content origin is
	// (2, 1+1): border+padding left, border top.
	const buffer = (terminal as any).terminal.buffer.active;
	expect(textarea.selectionStart).toBe(7); // "ab\nwxyz"
	expect(buffer.cursorY).toBe(2); // border row 0, "ab" row 1, "wxyz" row 2
	expect(buffer.cursorX).toBe(2 + 4); // border+padding, after "wxyz"

	// ArrowUp keeps the column where possible.
	type(terminal, "\x1b[A");
	await nextFrame(dom);
	expect(textarea.selectionStart).toBe(2); // end of "ab" (column clamps)
	expect(buffer.cursorY).toBe(1);

	// ArrowDown returns to the second line.
	type(terminal, "\x1b[B");
	await nextFrame(dom);
	expect(textarea.selectionStart).toBe(7);

	dom.dispose();
});

test("consecutive newlines: caret and arrows track blank lines exactly", async () => {
	// Blank lines own real (empty) layout fragments, and only the line
	// after a TRAILING newline is virtual -- offsets must come from the
	// value's own structure, not double-counted separators, or the caret
	// drifts a row per blank line.
	const terminal = new MockProcess({rows: 10, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const textarea = document.createElement("textarea");
	document.body.appendChild(textarea);
	textarea.focus();
	await nextFrame(dom);

	type(terminal, "a");
	await nextFrame(dom);
	type(terminal, "\r\r"); // two Enters: a blank line, caret below it
	await nextFrame(dom);
	type(terminal, "b");
	await nextFrame(dom);
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	expect(textarea.value).toBe("a\n\nb");
	// Rows: border 0, "a" 1, blank 2, "b" 3. Content x starts at 2.
	expect(buffer.cursorY).toBe(3);
	expect(buffer.cursorX).toBe(3); // after "b"

	// Two more Enters: value ends with newlines; the caret sits on the
	// (virtual) empty last line, exactly one row below "b"'s successor.
	type(terminal, "\r\r");
	await nextFrame(dom);
	await nextFrame(dom);
	expect(textarea.value).toBe("a\n\nb\n\n");
	expect(buffer.cursorY).toBe(5);
	expect(buffer.cursorX).toBe(2);

	// Walking up visits every line, blank ones included.
	type(terminal, "\x1b[A");
	await nextFrame(dom);
	expect(textarea.selectionStart).toBe(5); // the "" line between b and end
	type(terminal, "\x1b[A");
	await nextFrame(dom);
	expect(textarea.selectionStart).toBe(3); // start of "b" (goal column 0)
	type(terminal, "\x1b[A");
	await nextFrame(dom);
	expect(textarea.selectionStart).toBe(2); // the blank line
	expect(buffer.cursorY).toBe(2);

	dom.dispose();
});
