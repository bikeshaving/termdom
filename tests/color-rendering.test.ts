/**
 * Color Rendering Tests
 *
 * Tests to ensure CSS colors are properly converted to ANSI escape sequences
 * and that background colors render correctly without bleeding.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

/**
 * How many cells of a painted row carry a background colour.
 *
 * A background is the one thing the row's text cannot report: the cells past
 * the last character hold a colour and a space, and reading the row as a
 * string turns them into trailing blanks that look the same either way. The
 * cells have to be counted.
 */
function backgroundCells(terminal: MockProcess, row: number): number {
	const line = (terminal as any).terminal.buffer.active.getLine(row);
	let count = 0;
	for (let x = 0; x < line.length; x++) {
		if (line.getCell(x)!.isBgRGB()) {
			count++;
		}
	}
	return count;
}

test("red foreground color renders correctly", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "Red text";
	div.style.color = "red";
	document.body.appendChild(div);

	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	// Verify red RGB color code
	expect(snapshot).toMatch(/\x1b\[38;2;255;0;0/); // Red RGB
	expect(snapshot).toContain("Red text");

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

test("background colors fill full width", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "Short text";
	div.style.backgroundColor = "red";
	div.style.display = "block";
	document.body.appendChild(div);

	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	// Background should fill the entire line (80 chars)
	const lines = snapshot.split("\n");
	const coloredLine = lines.find((line) => line.includes("Short text"));

	expect(coloredLine).toMatch(/48;2;255;0;0/); // red background

	// A block box is as wide as its container, so the red runs the whole
	// width of the terminal and not just under the ten characters.
	expect(backgroundCells(terminal, 0)).toBe(80);

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

// Skip multi-element test due to layout positioning issues
// TODO: Re-enable when block layout stacking is fixed

test("mixed foreground and background colors", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "Yellow text on blue background";
	div.style.color = "yellow";
	div.style.backgroundColor = "blue";
	div.style.display = "block";
	document.body.appendChild(div);

	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	// Should have combined foreground and background codes
	expect(snapshot).toMatch(/38;2;255;255;0/); // yellow foreground
	expect(snapshot).toMatch(/48;2;0;0;255/); // blue background

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

test("CSS color formats are handled correctly", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// RGB format
	const div1 = document.createElement("div");
	div1.textContent = "RGB color";
	div1.style.color = "rgb(255, 0, 0)";
	document.body.appendChild(div1);

	// Hex format
	const div2 = document.createElement("div");
	div2.textContent = "Hex color";
	div2.style.color = "#00ff00";
	document.body.appendChild(div2);

	// Named color
	const div3 = document.createElement("div");
	div3.textContent = "Named color";
	div3.style.color = "blue";
	document.body.appendChild(div3);

	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	// Should produce blue RGB code
	expect(snapshot).toMatch(/38;2;0;0;255/); // Blue RGB
	expect(snapshot).toContain("Named color");

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

test("style combinations work correctly", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "Bold red text on yellow background";
	div.style.color = "red";
	div.style.backgroundColor = "yellow";
	div.style.fontWeight = "bold";
	div.style.display = "block";
	document.body.appendChild(div);

	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	// Should have combined style codes
	expect(snapshot).toMatch(/;1m/); // bold (combined in sequence)
	expect(snapshot).toMatch(/38;2;255;0;0/); // red foreground
	expect(snapshot).toMatch(/48;2;255;255;0/); // yellow background

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

test("inline elements do not extend background", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const span = document.createElement("span");
	span.textContent = "Inline text";
	span.style.backgroundColor = "green";
	document.body.appendChild(span);

	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	expect(snapshot).toMatch(/48;2;0;128;0/); // green background

	// An inline box is as wide as its text, so the green stops with the
	// eleventh character rather than running out to the margin.
	expect(backgroundCells(terminal, 0)).toBe("Inline text".length);

	expect(snapshot).toMatchSnapshot();

	dom.dispose();
});

// Skip complex layout tests due to positioning issues
// TODO: Re-enable when block layout stacking is fixed

test("font-weight maps to the terminal's three weights", async () => {
	// The terminal has exactly three font weights and CSS names all three:
	// lighter/100-300 -> SGR faint (dim), bold/bolder/600+ -> SGR bold.
	// Numeric weights count too -- font-weight: 700 was previously not even
	// recognized as bold (only the literal string "bold" was).
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `
		<div style="font-weight: lighter">faint keyword</div>
		<div style="font-weight: 300">faint numeric</div>
		<div style="font-weight: 700">bold numeric</div>
		<div><small>small is faint by default</small></div>
	`;
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	expect(cellAt(0, 0).isDim()).toBeTruthy();
	expect(cellAt(1, 0).isDim()).toBeTruthy();
	expect(cellAt(2, 0).isBold()).toBeTruthy();
	expect(cellAt(2, 0).isDim()).toBeFalsy();
	expect(cellAt(3, 0).isDim()).toBeTruthy();

	dom.dispose();
});

test("a blockquote's left border covers margin rows and every paragraph", async () => {
	const terminal = new MockProcess({cols: 60, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>
		blockquote { border-left: 1px solid #5f5f5f; padding-left: 1ch; margin-top: 1px; }
		p { margin-top: 1px; }
	</style>`;
	dom.document.body.innerHTML =
		"<div>Blockquote</div>" +
		"<blockquote><p>first quote line</p><p>second quote line</p></blockquote>";
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	// The first paragraph's margin-top collapses through the blockquote's
	// borderless top and escapes the box, so the bar starts AT the first text
	// row: text, gap, text -- rows 2-4 -- with the collapsed margin as bare
	// row 1 above the box.
	for (const row of [2, 3, 4]) {
		expect(cellAt(row, 0).getChars()).toBe("│");
	}
	expect(cellAt(1, 0)?.getChars() ?? "").not.toBe("│");
	expect(cellAt(5, 0)?.getChars() ?? "").not.toBe("│");
	dom.dispose();
});

test("each border side paints its own border color", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	document.body.innerHTML =
		"<style>#p { width: 6ch; border: 1px solid; " +
		"border-top-color: red; border-right-color: lime; " +
		"border-bottom-color: blue; border-left-color: yellow; }</style>" +
		"<div id=\"p\">x</div>";
	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	expect(snapshot).toMatch(/38;2;255;0;0/); // top: red
	expect(snapshot).toMatch(/38;2;0;255;0/); // right: lime
	expect(snapshot).toMatch(/38;2;0;0;255/); // bottom: blue
	expect(snapshot).toMatch(/38;2;255;255;0/); // left: yellow

	dom.dispose();
});

test("system colors map onto the terminal palette", async () => {
	// A system color names whatever the user's environment says, which on a
	// terminal is the theme-resolved palette: GrayText the dim gray, the link
	// trio blue/magenta/red, Mark the yellow of a highlighter.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML = `
		<div style="color: GrayText">disabled</div>
		<div style="color: LinkText">link</div>
		<div style="color: VisitedText">visited</div>
		<div style="color: ActiveText">active</div>
		<div style="background-color: Mark">marked</div>
	`;
	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	expect(snapshot).toMatch(/38;2;128;128;128/); // GrayText: bright black
	expect(snapshot).toMatch(/38;2;0;0;255/); // LinkText: blue
	expect(snapshot).toMatch(/38;2;255;0;255/); // VisitedText: magenta
	expect(snapshot).toMatch(/38;2;255;0;0/); // ActiveText: red
	expect(snapshot).toMatch(/48;2;255;255;0/); // Mark: yellow

	dom.dispose();
});

test("Field and ButtonFace clear to the terminal's default background", async () => {
	// The surface system colors stand for the terminal's own background: the
	// box is filled, but with no SGR background color asserted -- the same
	// clear background-color: Canvas paints.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<div style=\"background-color: Field; display: block\">field row</div>" +
		"<div style=\"background-color: ButtonFace; display: block\">button row</div>";
	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();

	expect(snapshot).toContain("field row");
	expect(snapshot).toContain("button row");
	expect(snapshot).not.toMatch(/48;2;/);

	dom.dispose();
});

test("SelectedItem paints inverse video, like the Highlight pair", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<div style=\"background-color: SelectedItem; color: SelectedItemText\">" +
		"chosen</div>";
	await nextFrame(dom);

	const cellAt = (row: number, col: number) =>
		(terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	expect(cellAt(0, 0).isInverse()).toBeTruthy();

	dom.dispose();
});

test("deprecated system colors resolve through their modern equivalents", async () => {
	// CSS Color 4 keeps the desktop-era names as aliases: MenuText is
	// CanvasText, ThreeDFace is ButtonFace, InactiveCaptionText is GrayText.
	// The declarations are valid, keep their keyword spelling, and paint as
	// what they alias.
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "inactive";
	div.style.color = "InactiveCaptionText";
	div.style.backgroundColor = "ThreeDFace";
	document.body.appendChild(div);
	expect(div.style.color).toBe("InactiveCaptionText");
	expect(div.style.backgroundColor).toBe("ThreeDFace");
	expect(dom.window.getComputedStyle(div).color).toBe("InactiveCaptionText");

	await nextFrame(dom);
	const snapshot = terminal.getScreenContents();
	expect(snapshot).toMatch(/38;2;128;128;128/); // GrayText's gray
	expect(snapshot).not.toMatch(/48;2;/); // ButtonFace: default background

	dom.dispose();
});

test("an inline background paints its fragments, not the box enclosing them", async () => {
	// An inline box that breaks across lines has a fragment on each of them.
	// Filling the rectangle that encloses those fragments covers the whole
	// width of every line it spans, erasing the neighbours that own those
	// cells -- the text before it on its first line, and after it on its last.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		"<p>aaaaaaaaaa <span id=\"s\" style=\"background-color: #202020\">" +
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</span> cccccccccc</p>";
	await nextFrame(dom);

	const text = terminal.getPlainText().split("\n");
	// Everything before the inline box on its first line survives.
	expect(text[0]).toContain("aaaaaaaaaa");
	// And everything after it on its last line.
	expect(text.join("\n")).toContain("cccccccccc");

	dom.dispose();
});
