/**
 * Selection.modify(): the caret motion a keyboard makes, asked for by a page.
 *
 * Character and word granularity are answerable from the text, so they are
 * tested on a bare document. A line is a laid-out line, so the line
 * granularities are tested against text wrapped by a real terminal width.
 */
import {expect, test} from "@b9g/libuild/test";

import {createDocumentWindow} from "../src/internal/dom.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

// The door a test document comes through: a document of this DOM, in the
// window whose selection the tests move, and with no terminal behind it.
function withText(html: string): any {
	const {document} = createDocumentWindow(
		"<!doctype html><title></title>",
	) as any;
	document.body.innerHTML = html;
	return document;
}

/** A caret parked at `offset` in the paragraph's first text node. */
function caretAt(document: any, offset: number): any {
	const text = document.body.firstChild.firstChild;
	const selection = document.getSelection();
	selection.setBaseAndExtent(text, offset, text, offset);
	return selection;
}

test("modify moves a caret by character, forward and backward", () => {
	const document = withText("<p>hello world</p>");
	const selection = caretAt(document, 0);
	selection.modify("move", "forward", "character");
	expect(selection.focusOffset).toBe(1);
	selection.modify("move", "forward", "character");
	expect(selection.focusOffset).toBe(2);
	expect(selection.isCollapsed).toBe(true);
	selection.modify("move", "backward", "character");
	expect(selection.focusOffset).toBe(1);
	// The first character back from the start is the start.
	selection.modify("move", "backward", "character");
	selection.modify("move", "backward", "character");
	expect(selection.focusOffset).toBe(0);
});

test("a character move counts graphemes, not code units", () => {
	const document = withText("<p>a\u{1f469}\u{200d}\u{1f4bb}b</p>");
	const selection = caretAt(document, 0);
	selection.modify("move", "forward", "character");
	expect(selection.focusOffset).toBe(1);
	// The whole ZWJ sequence is one character forward, and one back.
	selection.modify("move", "forward", "character");
	expect(selection.focusOffset).toBe(6);
	selection.modify("move", "backward", "character");
	expect(selection.focusOffset).toBe(1);
});

test("modify extends by character, leaving the anchor where it was", () => {
	const document = withText("<p>hello world</p>");
	const selection = caretAt(document, 2);
	selection.modify("extend", "forward", "character");
	selection.modify("extend", "forward", "character");
	expect(selection.anchorOffset).toBe(2);
	expect(selection.focusOffset).toBe(4);
	expect(selection.toString()).toBe("ll");
	expect(selection.direction).toBe("forward");
	selection.modify("extend", "backward", "character");
	expect(selection.toString()).toBe("l");
	// Past the anchor the selection turns around.
	selection.modify("extend", "backward", "character");
	selection.modify("extend", "backward", "character");
	expect(selection.direction).toBe("backward");
	expect(selection.toString()).toBe("e");
});

test("a forward character move over a range collapses it to its end", () => {
	const document = withText("<p>hello world</p>");
	const text = document.body.firstChild.firstChild;
	const selection = document.getSelection();
	selection.setBaseAndExtent(text, 1, text, 5);
	selection.modify("move", "forward", "character");
	expect(selection.isCollapsed).toBe(true);
	expect(selection.focusOffset).toBe(5);
	selection.setBaseAndExtent(text, 1, text, 5);
	selection.modify("move", "backward", "character");
	expect(selection.isCollapsed).toBe(true);
	expect(selection.focusOffset).toBe(1);
});

test("modify moves and extends by word", () => {
	const document = withText("<p>one two three</p>");
	const selection = caretAt(document, 0);
	selection.modify("move", "forward", "word");
	expect(selection.focusOffset).toBe(3);
	selection.modify("move", "forward", "word");
	expect(selection.focusOffset).toBe(7);
	selection.modify("move", "backward", "word");
	expect(selection.focusOffset).toBe(4);
	selection.modify("extend", "forward", "word");
	expect(selection.toString()).toBe("two");
	selection.modify("extend", "forward", "word");
	expect(selection.toString()).toBe("two three");
	selection.modify("move", "backward", "word");
	expect(selection.isCollapsed).toBe(true);
});

test("a word move crosses out of one text node and into the next", () => {
	const document = withText("<p>one <b>two</b> three</p>");
	const paragraph = document.body.firstChild;
	const selection = document.getSelection();
	selection.setBaseAndExtent(paragraph.firstChild, 0, paragraph.firstChild, 0);
	selection.modify("move", "forward", "word");
	selection.modify("move", "forward", "word");
	expect(selection.focusNode).toBe(paragraph.childNodes[1].firstChild);
	expect(selection.focusOffset).toBe(3);
	selection.modify("extend", "forward", "word");
	expect(selection.toString()).toBe(" three");
});

test("left and right are backward and forward", () => {
	const document = withText("<p>hello</p>");
	const selection = caretAt(document, 2);
	selection.modify("move", "right", "character");
	expect(selection.focusOffset).toBe(3);
	selection.modify("move", "left", "character");
	expect(selection.focusOffset).toBe(2);
});

test("the document boundaries are a granularity of their own", () => {
	const document = withText("<p>one</p><p>two</p>");
	const selection = caretAt(document, 1);
	selection.modify("extend", "forward", "documentboundary");
	expect(selection.toString()).toBe("netwo");
	selection.modify("move", "backward", "documentboundary");
	expect(selection.isCollapsed).toBe(true);
	expect(selection.focusOffset).toBe(0);
});

test("an unrecognized argument, and an empty selection, do nothing", () => {
	const document = withText("<p>hello</p>");
	const selection = caretAt(document, 2);
	selection.modify("mangle", "forward", "character");
	selection.modify("move", "sideways", "character");
	selection.modify("move", "forward", "sentence");
	selection.modify("move", "forward", "paragraph");
	expect(selection.focusOffset).toBe(2);
	selection.removeAllRanges();
	selection.modify("move", "forward", "character");
	expect(selection.rangeCount).toBe(0);
});

test("the line granularities do nothing without a layout behind them", () => {
	const document = withText("<p>hello world</p>");
	const selection = caretAt(document, 3);
	selection.modify("move", "forward", "lineboundary");
	selection.modify("move", "forward", "line");
	expect(selection.focusOffset).toBe(3);
});

/* --------------------------------------------- lines, as the layout has them */

/** A 12-column terminal, so "hello there world" wraps into two rows. */
async function attached(html: string): Promise<{dom: TermDOM; document: any}> {
	const terminal = new MockProcess({cols: 12, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const document = dom.document as any;
	document.body.innerHTML = html;
	await nextFrame(dom);
	return {dom, document};
}

test("lineboundary runs to the ends of the WRAPPED line, not the string", async () => {
	const {dom, document} = await attached("<p>hello there world</p>");
	const text = document.body.firstChild.firstChild;
	const selection = document.getSelection()!;
	// "hello there world" in 12 columns wraps as "hello there " / "world":
	// the line's end is the end of what the row renders, space and all.
	selection.setBaseAndExtent(text, 2, text, 2);
	selection.modify("extend", "forward", "lineboundary");
	expect(selection.toString()).toBe("llo there ");
	selection.setBaseAndExtent(text, 8, text, 8);
	selection.modify("move", "backward", "lineboundary");
	expect(selection.focusOffset).toBe(0);
	selection.modify("move", "forward", "lineboundary");
	expect(selection.focusOffset).toBe(12);
	dom.dispose();
});

test("a line move steps a wrapped row at a time, keeping the column", async () => {
	const {dom, document} = await attached("<p>hello there world</p>");
	const text = document.body.firstChild.firstChild;
	const selection = document.getSelection()!;
	selection.setBaseAndExtent(text, 2, text, 2);
	// Down one row from column 2 of "hello there" is column 2 of "world".
	selection.modify("move", "forward", "line");
	expect(selection.focusOffset).toBe(14);
	selection.modify("move", "backward", "line");
	expect(selection.focusOffset).toBe(2);
	// Up from the first row spends itself on that row's start.
	selection.modify("move", "backward", "line");
	expect(selection.focusOffset).toBe(0);
	dom.dispose();
});

test("a line move crosses from one block into the next, and extends", async () => {
	const {dom, document} = await attached("<p>abcd</p><p>wxyz</p>");
	const first = document.body.firstChild.firstChild;
	const second = document.body.childNodes[1].firstChild;
	const selection = document.getSelection()!;
	selection.setBaseAndExtent(first, 2, first, 2);
	selection.modify("extend", "forward", "line");
	expect(selection.focusNode).toBe(second);
	expect(selection.focusOffset).toBe(2);
	expect(selection.toString()).toBe("cdwx");
	// Down again is past the last line, so it spends itself on that line's end.
	selection.modify("extend", "forward", "line");
	expect(selection.toString()).toBe("cdwxyz");
	dom.dispose();
});

test("a modified selection paints where it now is", async () => {
	const terminal = new MockProcess({cols: 12, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const document = dom.document as any;
	document.body.innerHTML = "<p>hello there world</p>";
	await nextFrame(dom);
	const text = document.body.firstChild.firstChild;
	const selection = document.getSelection()!;
	selection.setBaseAndExtent(text, 0, text, 0);
	selection.modify("extend", "forward", "lineboundary");
	await nextFrame(dom);
	// The highlight is inverse video, over the row the selection now covers.
	expect(terminal.getScreenContents()).toContain("hello there");
	expect(selection.toString()).toBe("hello there ");
	dom.dispose();
});
