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

test("a trailing newline grows the box; the caret never touches the border", async () => {
	// The UA tree keeps a trailing <br> anchor after the value -- the same
	// trick a browser's editor uses -- so the empty last line a final Enter
	// creates is real, measured content: the box grows and the caret's row
	// stays strictly inside it.
	const terminal = new MockProcess({rows: 12, cols: 40});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const textarea = document.createElement("textarea");
	document.body.appendChild(textarea);
	textarea.focus();
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const bottomBorderRow = () =>
		Math.round(textarea.getBoundingClientRect().bottom) - 1;

	type(terminal, "\r");
	await nextFrame(dom);
	expect(buffer.cursorY).toBeLessThan(bottomBorderRow());

	type(terminal, "\r");
	await nextFrame(dom);
	// Three logical lines now (all empty): content grew past rows=2.
	expect(textarea.getBoundingClientRect().height).toBe(5);
	expect(buffer.cursorY).toBe(3);
	expect(buffer.cursorY).toBeLessThan(bottomBorderRow());

	// And typing on that last line lands where the caret promised.
	type(terminal, "z");
	await nextFrame(dom);
	const row = buffer.getLine(3).translateToString(true);
	expect(row).toContain("z");

	dom.dispose();
});

test("the camera follows the caret as the textarea grows past the viewport", async () => {
	// Browser rule: EDITS keep the caret in view (scrolling away by wheel
	// stays allowed -- the camera only chases the caret on editing
	// actions). Grow a textarea past the terminal height and the camera
	// must follow the caret down, then back up on arrow travel.
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const textarea = document.createElement("textarea");
	document.body.appendChild(textarea);
	textarea.focus();
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	for (let i = 0; i < 8; i++) {
		type(terminal, `line${i}\r`);
		await nextFrame(dom);
		await nextFrame(dom);
		// The caret's row stays on screen the whole way down.
		expect(buffer.cursorY).toBeGreaterThanOrEqual(0);
		expect(buffer.cursorY).toBeLessThan(6);
	}
	// The latest line is visible; the first has scrolled off.
	const text = () => terminal.getPlainText();
	expect(text()).toContain("line7");
	expect(text()).not.toContain("line0");

	// Travel back up: the camera follows the caret to the top.
	for (let i = 0; i < 9; i++) {
		type(terminal, "\x1b[A");
		await nextFrame(dom);
	}
	await nextFrame(dom);
	expect(buffer.cursorY).toBeGreaterThanOrEqual(0);
	expect(text()).toContain("line0");
	expect(text()).not.toContain("line7");

	dom.dispose();
});

test("borders respect the camera: culled above the band, visible when scrolled to", async () => {
	// #setBorderCell wrote at raw DOCUMENT rows -- correct only at scroll 0.
	// Scrolled down, the off-screen top border stamped into the band's first
	// row (merging into whatever text lived there), and the bottom border
	// never painted even when the camera reached it.
	const terminal = new MockProcess({rows: 6, cols: 30});
	const dom = new TermDOM({process: terminal});
	dom.attach();
	const {document} = dom;
	const textarea = document.createElement("textarea");
	document.body.appendChild(textarea);
	textarea.focus();
	await nextFrame(dom);
	for (let i = 0; i < 7; i++) {
		type(terminal, `line${i}\r`);
		await nextFrame(dom);
	}
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const row = (r: number) => buffer.getLine(r).translateToString(true);

	// Caret at the bottom: the camera sits past the box top. The band's
	// first row is CONTENT (side borders only), not a phantom top edge.
	expect(row(0)).not.toContain("┌");
	expect(row(0)).not.toContain("─");
	// The caret's row is the last content row; the bottom border is the
	// next document row -- scroll one more line into view by typing.
	type(terminal, "tail");
	await nextFrame(dom);
	await nextFrame(dom);
	const screen = terminal.getPlainText();
	expect(screen).toContain("tail");
	expect(row(0)).not.toContain("┌");

	// Travel to the very top: the top border is real again, un-merged.
	for (let i = 0; i < 12; i++) {
		type(terminal, "\x1b[A");
		await nextFrame(dom);
	}
	await nextFrame(dom);
	expect(row(0)).toContain("┌");
	expect(row(0)).not.toContain("line"); // border row is pure border
	expect(row(1)).toContain("line0");

	dom.dispose();
});
