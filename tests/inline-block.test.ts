/**
 * Inline Element Rendering Tests
 *
 * Tests for inline and inline-block element rendering in the terminal.
 */

import {test, expect} from "bun:test";
import {MockProcess} from "./test-utils";
import {TermDOM} from "../src/_termdom.js";

test("inline-block elements render side by side", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	const block1 = document.createElement("div");
	block1.style.display = "inline-block";
	block1.style.backgroundColor = "red";
	block1.style.color = "white";
	block1.textContent = "Block1";
	container.appendChild(block1);

	const block2 = document.createElement("div");
	block2.style.display = "inline-block";
	block2.style.backgroundColor = "blue";
	block2.style.color = "white";
	block2.textContent = "Block2";
	container.appendChild(block2);

	await dom.render();

	const visibleText = terminal.getVisibleText();
	const output = terminal.getStaticANSI();

	// Both blocks should appear on the same line
	expect(visibleText).toContain("Block1Block2");

	// Check that they have different background colors
	expect(output).toContain("\x1b[38;2;255;255;255;48;2;255;0;0m"); // white text on red background
	expect(output).toContain("\x1b[48;2;0;0;255m"); // blue background

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-side-by-side");

	dom.dispose();
});

test("inline-block elements with padding", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const block = document.createElement("div");
	block.style.display = "inline-block";
	block.style.backgroundColor = "green";
	block.style.color = "white";
	block.style.padding = "1px 2px";
	block.textContent = "Padded";
	document.body.appendChild(block);

	await dom.render();

	const output = terminal.getStaticANSI();
	const lines = output.trim().split("\n");

	// Should have 3 lines (1px top padding + content + 1px bottom padding)
	expect(lines.length).toBeGreaterThanOrEqual(3);

	// Each line should show padding (2px left + content + 2px right)
	const contentLine = lines.find((line) => line.includes("Padded"));
	expect(contentLine).toBeDefined();
	// The content should have spaces around it (accounting for ANSI codes)
	expect(contentLine).toContain("  "); // Check for spaces (padding)
	expect(contentLine).toContain("Padded"); // Check for content

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-padding");

	dom.dispose();
});

test("inline-block elements with margins", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const block1 = document.createElement("div");
	block1.style.display = "inline-block";
	block1.style.backgroundColor = "red";
	block1.style.color = "white";
	block1.style.marginRight = "3px";
	block1.textContent = "First";
	document.body.appendChild(block1);

	const block2 = document.createElement("div");
	block2.style.display = "inline-block";
	block2.style.backgroundColor = "blue";
	block2.style.color = "white";
	block2.textContent = "Second";
	document.body.appendChild(block2);

	await dom.render();

	const visibleText = terminal.getVisibleText();

	// Should have 3 spaces between blocks due to marginRight: "3px"
	expect(visibleText).toContain("First   Second");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("inline-block-margins");

	dom.dispose();
});

test("inline-block elements wrapping to multiple lines", async () => {
	const terminal = new MockProcess({cols: 20, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const words = ["First", "Second", "Third", "Fourth", "Fifth"];

	for (const word of words) {
		const block = document.createElement("div");
		block.style.display = "inline-block";
		block.style.backgroundColor = "darkblue";
		block.style.color = "white";
		block.style.margin = "0 1px";
		block.textContent = word;
		document.body.appendChild(block);
	}

	await dom.render();

	const visibleText = terminal.getVisibleText();
	const lines = visibleText.split("\n").filter((line) => line.trim());

	// With 20 columns and margins, elements should wrap to multiple lines
	expect(lines.length).toBeGreaterThan(1);

	// Each line should contain one or more complete words
	for (const word of words) {
		expect(visibleText).toContain(word);
	}

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("inline-block-wrapping");

	dom.dispose();
});

test("mixed inline and inline-block elements", async () => {
	const terminal = new MockProcess({cols: 50, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const text1 = document.createElement("span");
	text1.textContent = "Regular ";
	text1.style.color = "yellow";
	document.body.appendChild(text1);

	const block = document.createElement("div");
	block.style.display = "inline-block";
	block.style.backgroundColor = "purple";
	block.style.color = "white";
	block.style.padding = "0 1px";
	block.textContent = "inline-block";
	document.body.appendChild(block);

	const text2 = document.createElement("span");
	text2.textContent = " text";
	text2.style.color = "cyan";
	document.body.appendChild(text2);

	await dom.render();

	const visibleText = terminal.getVisibleText();

	// All elements should appear on the same line with padding spacing
	// inline-block has 1px padding on each side, creating extra spaces
	expect(visibleText.trim()).toBe("Regular  inline-block  text");

	const output = terminal.getStaticANSI();
	// Check color transitions (now without white background forcing)
	expect(output).toContain("\x1b[38;2;255;255;0m"); // yellow text
	expect(output).toContain("48;2;128;0;128"); // purple background (may be combined with other codes)
	expect(output).toContain("38;2;0;255;255"); // cyan text (may have background reset after)

	expect(output).toMatchSnapshot();
	terminal.writeANSI("mixed-inline-and-inline-block");

	dom.dispose();
});

test("nested inline-block elements", async () => {
	const terminal = new MockProcess({cols: 50, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const outer = document.createElement("div");
	outer.style.display = "inline-block";
	outer.style.backgroundColor = "navy";
	outer.style.padding = "1px";
	document.body.appendChild(outer);

	const inner1 = document.createElement("span");
	inner1.textContent = "Nested ";
	inner1.style.color = "white";
	outer.appendChild(inner1);

	const inner2 = document.createElement("div");
	inner2.style.display = "inline-block";
	inner2.style.backgroundColor = "red";
	inner2.style.color = "white";
	inner2.style.padding = "0 1px";
	inner2.textContent = "block";
	outer.appendChild(inner2);

	await dom.render();

	const output = terminal.getStaticANSI();

	// Should show nested structure with proper backgrounds
	expect(output).toContain("\x1b[48;2;0;0;128m"); // navy background for outer
	expect(output).toContain("48;2;255;0;0"); // red background for inner (may be combined with other codes)

	expect(output).toMatchSnapshot();
	terminal.writeANSI("nested-inline-block");

	dom.dispose();
});

test("inline-block with explicit width", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const block1 = document.createElement("div");
	block1.style.display = "inline-block";
	block1.style.width = "10px";
	block1.style.backgroundColor = "green";
	block1.style.color = "white";
	block1.style.textAlign = "center";
	block1.textContent = "Fixed";
	document.body.appendChild(block1);

	const block2 = document.createElement("div");
	block2.style.display = "inline-block";
	block2.style.backgroundColor = "blue";
	block2.style.color = "white";
	block2.textContent = "Auto";
	document.body.appendChild(block2);

	await dom.render();

	const output = terminal.getStaticANSI();
	const visibleText = terminal.getVisibleText();

	// First block should be exactly 10 characters wide due to width: "10px"
	expect(visibleText).toContain("Fixed     Auto"); // "Fixed" + 5 spaces to reach 10 chars + "Auto"

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-fixed-width");

	dom.dispose();
});

test("inline-block with height", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const block1 = document.createElement("div");
	block1.style.display = "inline-block";
	block1.style.height = "3px";
	block1.style.backgroundColor = "darkgreen";
	block1.style.color = "white";
	block1.textContent = "Tall";
	document.body.appendChild(block1);

	const block2 = document.createElement("div");
	block2.style.display = "inline-block";
	block2.style.backgroundColor = "darkred";
	block2.style.color = "white";
	block2.textContent = "Normal";
	document.body.appendChild(block2);

	await dom.render();

	const output = terminal.getStaticANSI();
	const lines = output.trim().split("\n");

	// Tall block should occupy 3 lines (height: "3px")
	const greenBackgroundLines = lines.filter(
		(line) => line.includes("48;2;0;100;0m"), // darkgreen background
	);
	expect(greenBackgroundLines.length).toBe(3);

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-height");

	dom.dispose();
});

test("inline-block with borders", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const block = document.createElement("div");
	block.style.display = "inline-block";
	block.style.border = "1px solid red";
	block.style.padding = "1px";
	block.style.backgroundColor = "black";
	block.style.color = "white";
	block.textContent = "Bordered";
	document.body.appendChild(block);

	await dom.render();

	const output = terminal.getStaticANSI();

	// Should have border box drawing characters
	expect(output).toContain("┌"); // top border
	expect(output).toContain("└"); // bottom border

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-borders");

	dom.dispose();
});

test("an empty inline flex item measures zero, not its next sibling's width", async () => {
	// An empty inline element that is a flex item was collecting its *next
	// sibling's* content: the tree walker, when its currentNode was the root and
	// the root had no children, fell through to the root's next sibling and
	// escaped the subtree. So an empty <span> before <span>ABC</span> reported
	// width 3, shoving everything after it -- which is exactly what broke a
	// progress bar whenever its fill or track emptied (0% and 100%).
	const terminal = new MockProcess({cols: 40, rows: 4});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML = `<div style="display:flex"><span></span><span>ABC</span><span>XY</span></div>`;
	await dom.render();

	const spans = [...dom.document.querySelectorAll("span")];
	const rect = (i: number) => spans[i].getBoundingClientRect();

	// The empty span occupies nothing, and the others pack from the start.
	expect(rect(0).width).toBe(0);
	expect(rect(1).left).toBe(0);
	expect(rect(1).width).toBe(3);
	expect(rect(2).left).toBe(3);
	expect(rect(2).width).toBe(2);

	dom.dispose();
});

test("a progress bar stays intact when its fill or track empties", async () => {
	// The 0% and 100% frames put an empty span first or in the middle of a flex
	// row. The fill and track must always tile to a constant width, with the
	// percent immediately after -- no gap opening up, nothing shoved off.
	const terminal = new MockProcess({cols: 50, rows: 4});
	const dom = new TermDOM({process: terminal});
	dom.document.body.innerHTML =
		`<div style="display:flex">` +
		`<span id="fill"></span><span id="track"></span><span id="pct"></span>` +
		`</div>`;
	const fill = dom.document.getElementById("fill")!;
	const track = dom.document.getElementById("track")!;
	const pct = dom.document.getElementById("pct")!;

	const frame = async (p: number) => {
		const width = 30;
		const filled = Math.round((p / 100) * width);
		fill.textContent = "█".repeat(filled);
		track.textContent = "░".repeat(width - filled);
		pct.textContent = `${p}%`;
		await dom.render();
	};

	for (const p of [0, 50, 100]) {
		await frame(p);
		// fill starts at 0, track directly follows it, percent directly follows the
		// track -- the bar tiles to exactly 30 cells regardless of where the split is.
		expect(fill.getBoundingClientRect().left).toBe(0);
		expect(track.getBoundingClientRect().left).toBe(
			fill.getBoundingClientRect().width,
		);
		expect(pct.getBoundingClientRect().left).toBe(30);
	}

	dom.dispose();
});
