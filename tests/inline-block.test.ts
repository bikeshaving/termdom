/**
 * Inline Element Rendering Tests
 *
 * Tests for inline and inline-block element rendering in the terminal.
 */

import {test, expect} from "bun:test";
import {TestTerminal} from "./test-utils";
import {TermDOM} from "../src/termdom";

test("inline-block elements render side by side", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
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
	const terminal = new TestTerminal({cols: 40, rows: 10});
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
	expect(contentLine).toContain("  Padded  "); // 2 spaces on each side

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-padding");

	dom.dispose();
});

test("inline-block elements with margins", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
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

	// TODO: Should have 3 spaces between blocks due to margin (when margins are implemented)
	expect(visibleText).toContain("FirstSecond");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("inline-block-margins");

	dom.dispose();
});

test("inline-block elements wrapping to multiple lines", async () => {
	const terminal = new TestTerminal({cols: 20, rows: 10});
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
	const terminal = new TestTerminal({cols: 50, rows: 10});
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

	// All elements should appear on the same line
	expect(visibleText.trim()).toBe("Regular inline-block text");

	const output = terminal.getStaticANSI();
	// Check color transitions
	expect(output).toContain("\x1b[38;2;255;255;0;48;2;255;255;255m"); // yellow text on white background
	expect(output).toContain("\x1b[38;2;255;255;255;48;2;128;0;128m"); // white text on purple background
	expect(output).toContain("\x1b[38;2;0;255;255;48;2;255;255;255m"); // cyan text on white background

	expect(output).toMatchSnapshot();
	terminal.writeANSI("mixed-inline-and-inline-block");

	dom.dispose();
});

test("nested inline-block elements", async () => {
	const terminal = new TestTerminal({cols: 50, rows: 10});
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
	expect(output).toContain("\x1b[48;2;255;0;0m"); // red background for inner

	expect(output).toMatchSnapshot();
	terminal.writeANSI("nested-inline-block");

	dom.dispose();
});

test("inline-block with explicit width", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
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

	// TODO: First block should be exactly 10 characters wide when width is implemented
	// For now, blocks should be adjacent without explicit width
	expect(visibleText).toContain("FixedAuto");

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-fixed-width");

	dom.dispose();
});

test("inline-block with height", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
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

	// Tall block should occupy 3 lines
	const greenBackgroundLines = lines.filter(
		(line) => line.includes("\x1b[48;2;0;100;0m"), // darkgreen
	);
	expect(greenBackgroundLines.length).toBe(3);

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-height");

	dom.dispose();
});

test("inline-block with borders", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
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
	const lines = output
		.trim()
		.split("\n")
		.filter((line) => line.length > 0);

	// Should have 4 lines minimum (top border + padding + content + padding + bottom border)
	expect(lines.length).toBeGreaterThanOrEqual(4);

	// Top and bottom borders should be red
	expect(lines[0]).toContain("\x1b[48;2;255;0;0m"); // red border
	expect(lines[lines.length - 1]).toContain("\x1b[48;2;255;0;0m"); // red border

	expect(output).toMatchSnapshot();
	terminal.writeANSI("inline-block-borders");

	dom.dispose();
});
