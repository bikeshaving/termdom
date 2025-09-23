import {test, expect} from "bun:test";
import {TermDOM} from "../src/index.js";
import {TestTerminal} from "./test-utils.js";

test("detectCommandStart queries and parses cursor position", async () => {
	const terminal = new TestTerminal();

	// Position cursor at row 15 using raw ANSI (1-based coordinates)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[15;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});

	// This should detect we're at row 15
	const row = await dom.detectCommandStart();
	expect(row).toBe(15);
	expect(dom.commandStartRow).toBe(15);
});

test("detectCommandStart handles different cursor positions", async () => {
	const terminal = new TestTerminal();

	// Position cursor at row 23
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[23;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});

	const row = await dom.detectCommandStart();
	expect(row).toBe(23);
	expect(dom.commandStartRow).toBe(23);
});

test("detectCommandStart handles row 1 (top of terminal)", async () => {
	const terminal = new TestTerminal();

	// Position cursor at top of terminal
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[1;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});

	const row = await dom.detectCommandStart();
	expect(row).toBe(1);
	expect(dom.commandStartRow).toBe(1);
});

test("rendering small content from command start (fits in available space)", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 8 (leaving 2 lines available)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Add small content that fits in available space
	dom.document.body.innerHTML = `<div>Content Line</div>`;

	await dom.render();
	const lines = terminal.getPlainText().split('\n');

	// Content should render starting at row 8 (command start)
	expect(dom.commandStartRow).toBe(8);
	
	// FAILING: Currently renders at top, should render at row 8
	expect(lines[7]).toBe("Content Line"); // Row 8 (0-based index 7)
	expect(lines[0]).toBe(""); // Top should be empty
});

test("rendering large content that exceeds available space (should push up)", async () => {
	const terminal = new TestTerminal({rows: 24, cols: 80});

	// Position cursor at row 22 (leaving only 2 lines available)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[22;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Add content that needs 6 lines (exceeds available 2 lines)
	dom.document.body.innerHTML = `
		<div>Line 1: This is the first line of content</div>
		<div>Line 2: This is the second line of content</div>
		<div>Line 3: This is the third line of content</div>
		<div>Line 4: This is the fourth line of content</div>
		<div>Line 5: This is the fifth line of content</div>
		<div>Line 6: This is the sixth line of content</div>
	`;

	await dom.render();

	// TODO: When push-up is implemented, verify:
	// 1. commandStartRow gets updated to accommodate all content
	// 2. Content renders from the new pushed-up position
	// 3. Terminal scrolls content upward as needed
	expect(dom.commandStartRow).toBe(22); // Initial position before push-up logic
});

test("rendering at top of terminal (row 1) with large content", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 1 (full terminal available)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[1;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Add content that exactly fills terminal height
	const lines = Array.from({length: 10}, (_, i) => `<div>Line ${i + 1}</div>`);
	dom.document.body.innerHTML = lines.join('\n');

	await dom.render();

	// Content should render from top without needing push-up
	expect(dom.commandStartRow).toBe(1);
	// TODO: Verify all content fits and renders correctly when coordinate transformation is implemented
});

test("coordinate transformation from layout space to terminal space", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 5
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[5;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Add content with known layout coordinates
	dom.document.body.innerHTML = `
		<div style="position: absolute; top: 0; left: 0;">First</div>
		<div style="position: absolute; top: 1ch; left: 10ch;">Second</div>
	`;

	await dom.render();
	const lines = terminal.getPlainText().split('\n');

	expect(dom.commandStartRow).toBe(5);
	
	// FAILING: Layout coordinates should be offset by commandStartRow
	// Layout (0,0) should map to terminal row 5
	expect(lines[4]).toBe("First"); // Row 5 (0-based index 4)
	// Layout (1,10) should map to terminal row 6, col 10
	expect(lines[5].substring(10, 16)).toBe("Second"); // Row 6, starting at col 10
});

test("handling content that would exceed terminal bottom", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor near bottom (row 8, leaving only 2 lines)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Add content that needs 5 lines (exceeds remaining 2 lines)
	dom.document.body.innerHTML = `
		<div>Content line 1</div>
		<div>Content line 2</div>
		<div>Content line 3</div>
		<div>Content line 4</div>
		<div>Content line 5</div>
	`;

	await dom.render();

	// TODO: When push-up behavior is implemented, verify:
	// 1. Terminal scrolls existing content upward
	// 2. Command start gets repositioned to accommodate all content
	// 3. All content fits within terminal height
	expect(dom.commandStartRow).toBe(8); // Initial position before push-up
});

test("maximum layout height calculation", async () => {
	const terminal = new TestTerminal({rows: 20, cols: 60});

	// Test different command start positions
	const testCases = [
		{commandStart: 1, expectedMaxHeight: 20},   // Full terminal available
		{commandStart: 10, expectedMaxHeight: 11},  // Half terminal available
		{commandStart: 19, expectedMaxHeight: 2},   // Almost at bottom
		{commandStart: 20, expectedMaxHeight: 1},   // At bottom
	];

	for (const {commandStart, expectedMaxHeight} of testCases) {
		await new Promise<void>((resolve) => {
			terminal.stdout.write(`\x1b[${commandStart};1H`, () => resolve());
		});

		const dom = new TermDOM({process: terminal});
		await dom.detectCommandStart();

		// TODO: When maxLayoutHeight property is added, verify calculation:
		// maxLayoutHeight = terminalHeight - commandStartRow + 1
		expect(dom.commandStartRow).toBe(commandStart);
		const calculatedMaxHeight = terminal.stdout.rows - commandStart + 1;
		expect(calculatedMaxHeight).toBe(expectedMaxHeight);
	}
});

test("push-up offset calculation when content exceeds available space", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 9 (2 lines available)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[9;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Add content that needs 4 lines (exceeds available 2 lines by 2)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
	`;

	await dom.render();
	const lines = terminal.getPlainText().split('\n');

	// FAILING: Should push up by 2 lines to accommodate all content
	// New commandStartRow should be 9 - 2 = 7
	// Content should render from row 7 to row 10
	expect(lines[6]).toBe("Line 1"); // Row 7 (0-based index 6)
	expect(lines[7]).toBe("Line 2"); // Row 8
	expect(lines[8]).toBe("Line 3"); // Row 9  
	expect(lines[9]).toBe("Line 4"); // Row 10

	// Initial command start should be updated
	expect(dom.commandStartRow).toBe(7); // Should be pushed up from 9 to 7
});

test("content positioning with different terminal sizes", async () => {
	const smallTerminal = new TestTerminal({rows: 5, cols: 20});
	const largeTerminal = new TestTerminal({rows: 50, cols: 120});

	// Test same content on different terminal sizes
	const content = `
		<div>First line of content</div>
		<div>Second line here</div>
		<div>Third line content</div>
	`;

	// Small terminal test
	await new Promise<void>((resolve) => {
		smallTerminal.stdout.write("\x1b[3;1H", () => resolve());
	});
	const smallDom = new TermDOM({process: smallTerminal});
	await smallDom.detectCommandStart();
	smallDom.document.body.innerHTML = content;
	await smallDom.render();

	// Large terminal test
	await new Promise<void>((resolve) => {
		largeTerminal.stdout.write("\x1b[25;1H", () => resolve());
	});
	const largeDom = new TermDOM({process: largeTerminal});
	await largeDom.detectCommandStart();
	largeDom.document.body.innerHTML = content;
	await largeDom.render();

	// Verify cursor positions are detected correctly
	expect(smallDom.commandStartRow).toBe(3);
	expect(largeDom.commandStartRow).toBe(25);

	// TODO: When coordinate transformation is implemented, verify content
	// appears at correct terminal positions relative to commandStartRow
});

test("content clipped to terminal boundaries", async () => {
	const terminal = new TestTerminal({rows: 5, cols: 20});

	// Position cursor at row 4 (only 2 lines available)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[4;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Add content that would extend beyond terminal
	dom.document.body.innerHTML = `
		<div>Visible line 1</div>
		<div>Visible line 2</div>
		<div>Should not appear</div>
	`;

	await dom.render();
	const lines = terminal.getPlainText().split('\n');

	expect(dom.commandStartRow).toBe(4);
	
	// FAILING: Content should be clipped to terminal boundaries
	// Only first 2 lines should render, starting at row 4
	expect(lines[3]).toBe("Visible line 1"); // Row 4 (0-based index 3)
	expect(lines[4]).toBe("Visible line 2"); // Row 5 (0-based index 4)
	
	// Lines beyond terminal height should be empty/clipped
	expect(lines.length).toBeLessThanOrEqual(5); // Terminal is only 5 rows
});
