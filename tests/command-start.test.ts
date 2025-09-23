import {test, expect} from "bun:test";
import {TermDOM} from "../src/index.js";
import {TestTerminal} from "./test-utils.js";

test("detectCommandStart queries and sets window.screenTop", async () => {
	const terminal = new TestTerminal();

	// Position cursor at row 15 using raw ANSI (1-based coordinates)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[15;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});

	// This should detect we're at row 15 and set window.screenTop to 14 (0-based)
	const row = await dom.detectCommandStart();
	expect(row).toBe(15);
	expect(dom.window.screenTop).toBe(14);
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
	expect(dom.window.screenTop).toBe(22);
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
	expect(dom.window.screenTop).toBe(0);
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
	const lines = terminal.getPlainText().split("\n");

	// Content should render starting at row 8 (command start)
	expect(dom.window.screenTop).toBe(7); // Row 8 -> 0-based = 7

	// FAILING: Currently renders at top, should render at row 8
	expect(lines[7]).toBe("Content Line"); // Row 8 (0-based index 7)
	expect(lines[0]).toBe(""); // Top should be empty
});

test("push-up calculation when content exceeds available space", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 8 (leaving 3 lines available: 8, 9, 10)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();
	expect(dom.window.screenTop).toBe(7); // Row 8 -> 0-based = 7

	// Add content that needs 5 lines (exceeds available 3 lines by 2)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
		<div>Line 5</div>
	`;

	await dom.render();

	// window.screenTop should be pushed up by 2 lines (from 7 to 5)
	// This accommodates all 5 lines of content in the 10-row terminal
	expect(dom.window.screenTop).toBe(5); // Row 6 -> 0-based = 5
});

test("no push-up when content fits in available space", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 7 (leaving 4 lines available: 7, 8, 9, 10)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[7;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();
	expect(dom.window.screenTop).toBe(6); // Row 7 -> 0-based = 6

	// Add content that needs exactly 3 lines (fits in available 4 lines)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
	`;

	await dom.render();

	// window.screenTop should NOT be pushed up - content fits
	expect(dom.window.screenTop).toBe(6);
});

test("push-up to terminal top when content is very large", async () => {
	const terminal = new TestTerminal({rows: 5, cols: 30});

	// Position cursor at row 4 (leaving 2 lines available: 4, 5)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[4;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();
	expect(dom.window.screenTop).toBe(3); // Row 4 -> 0-based = 3

	// Add content that needs all 5 terminal lines
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
		<div>Line 5</div>
	`;

	await dom.render();

	// window.screenTop should be pushed all the way to 0 (row 1)
	expect(dom.window.screenTop).toBe(0);
});

test("document height calculation with auto layout", async () => {
	const terminal = new TestTerminal({rows: 20, cols: 60});

	// Position cursor at row 10
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[10;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Add content with known height (3 lines)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
	`;

	await dom.render();

	// Verify document height was calculated and used for push-up logic
	// Available space: 20 - 10 + 1 = 11 lines
	// Content needs: 3 lines
	// No push-up needed since 3 <= 11
	expect(dom.window.screenTop).toBe(9); // Row 10 -> 0-based = 9, should remain unchanged
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
	dom.document.body.innerHTML = lines.join("\n");

	await dom.render();

	// Content should render from top without needing push-up
	expect(dom.window.screenTop).toBe(0); // Row 1 -> 0-based = 0
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
	const lines = terminal.getPlainText().split("\n");

	expect(dom.window.screenTop).toBe(4); // Row 5 -> 0-based = 4

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
	expect(dom.window.screenTop).toBe(7); // Row 8 -> 0-based = 7, initial position before push-up
});

test("maximum layout height calculation", async () => {
	const terminal = new TestTerminal({rows: 20, cols: 60});

	// Test different command start positions
	const testCases = [
		{commandStart: 1, expectedMaxHeight: 20}, // Full terminal available
		{commandStart: 10, expectedMaxHeight: 11}, // Half terminal available
		{commandStart: 19, expectedMaxHeight: 2}, // Almost at bottom
		{commandStart: 20, expectedMaxHeight: 1}, // At bottom
	];

	for (const {commandStart, expectedMaxHeight} of testCases) {
		await new Promise<void>((resolve) => {
			terminal.stdout.write(`\x1b[${commandStart};1H`, () => resolve());
		});

		const dom = new TermDOM({process: terminal});
		await dom.detectCommandStart();

		// TODO: When maxLayoutHeight property is added, verify calculation:
		// maxLayoutHeight = terminalHeight - commandStartRow + 1
		expect(dom.window.screenTop).toBe(commandStart - 1); // Convert 1-based to 0-based
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
	const lines = terminal.getPlainText().split("\n");

	// FAILING: Should push up by 2 lines to accommodate all content
	// New commandStartRow should be 9 - 2 = 7
	// Content should render from row 7 to row 10
	expect(lines[6]).toBe("Line 1"); // Row 7 (0-based index 6)
	expect(lines[7]).toBe("Line 2"); // Row 8
	expect(lines[8]).toBe("Line 3"); // Row 9
	expect(lines[9]).toBe("Line 4"); // Row 10

	// Initial command start should be updated
	expect(dom.window.screenTop).toBe(7); // Should be pushed up from 9 to 7
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
	expect(smallDom.window.screenTop).toBe(2); // Row 3 -> 0-based = 2
	expect(largeDom.window.screenTop).toBe(24); // Row 25 -> 0-based = 24

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
	const lines = terminal.getPlainText().split("\n");

	expect(dom.window.screenTop).toBe(3); // Row 4 -> 0-based = 3

	// FAILING: Content should be clipped to terminal boundaries
	// Only first 2 lines should render, starting at row 4
	expect(lines[3]).toBe("Visible line 1"); // Row 4 (0-based index 3)
	expect(lines[4]).toBe("Visible line 2"); // Row 5 (0-based index 4)

	// Lines beyond terminal height should be empty/clipped
	expect(lines.length).toBeLessThanOrEqual(5); // Terminal is only 5 rows
});

test("content larger than terminal height (edge case)", async () => {
	const terminal = new TestTerminal({rows: 5, cols: 30});

	// Position cursor at row 3
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[3;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();
	expect(dom.window.screenTop).toBe(2); // Row 3 -> 0-based = 2

	// Add content that needs 8 lines (exceeds 5-row terminal)
	const contentLines = Array.from(
		{length: 8},
		(_, i) => `<div>Line ${i + 1}</div>`,
	);
	dom.document.body.innerHTML = contentLines.join("\n");

	await dom.render();

	// Push-up should go to terminal top, but content will still overflow
	expect(dom.window.screenTop).toBe(0); // Pushed to top

	// TODO: Need to handle content overflow - should we:
	// 1. Clip content to terminal height?
	// 2. Show error/warning?
	// 3. Enable scrolling/paging?
});

test("unified scrolling model: screenTop + scrollY", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 6
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[6;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Initial state: command start detected
	expect(dom.window.screenTop).toBe(5); // Row 6 -> 0-based = 5 (readonly)
	expect(dom.window.scrollY).toBe(5); // Set to screenTop (viewport position)

	// scrollY is now the single source of truth for viewport position
	expect(dom.window.scrollY).toBe(5);
});

test("unified scrolling model: user scrolls to terminal top", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 8
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	expect(dom.window.screenTop).toBe(7); // Row 8 -> 0-based = 7 (readonly)
	expect(dom.window.scrollY).toBe(7); // Initial: screenTop (command start position)

	// User scrolls to show content from terminal top
	dom.document.documentElement.scrollTop = 0;

	// scrollY = 0 means content renders from terminal top
	expect(dom.window.scrollY).toBe(0);
	expect(dom.window.screenTop).toBe(7); // screenTop stays readonly
});

test("unified scrolling model: user scrolls down in document", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 5
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[5;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	expect(dom.window.screenTop).toBe(4); // Row 5 -> 0-based = 4
	expect(dom.window.scrollY).toBe(4); // Initial: screenTop (command start position)

	// User scrolls down 3 lines in document
	dom.document.documentElement.scrollTop = 4 + 3; // 7

	// scrollY = 7 means viewport is at row 8 (showing content 3 lines down from command start)
	expect(dom.window.scrollY).toBe(7);
	expect(dom.window.screenTop).toBe(4); // screenTop stays readonly
});

test("unified scrolling model: pageYOffset alias", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 3
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[3;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// pageYOffset should be an alias for scrollY
	expect(dom.window.pageYOffset).toBe(dom.window.scrollY);
	expect(dom.window.pageYOffset).toBe(2); // screenTop (command start position)

	// Changing scrollTop should affect pageYOffset
	dom.document.documentElement.scrollTop = 5;
	expect(dom.window.pageYOffset).toBe(5);
});

test("unified scrolling model: push-up updates scrollY not screenTop", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	// Position cursor at row 9 (only 2 lines available)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[9;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	const initialScreenTop = dom.window.screenTop;
	expect(initialScreenTop).toBe(8); // Row 9 -> 0-based = 8
	expect(dom.window.scrollY).toBe(8); // Initial: screenTop (command start position)

	// Add content that needs 4 lines (exceeds available 2 lines)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
	`;

	await dom.render();

	// screenTop should remain readonly (unchanged)
	expect(dom.window.screenTop).toBe(initialScreenTop);

	// scrollY should be updated to push content up
	// Push-up amount: 4 lines needed - 2 available = 2 lines
	// New scrollY: 8 - 2 = 6, but may be clamped to 0 (terminal top)
	expect(dom.window.scrollY).toBeGreaterThanOrEqual(0); // Should not go negative
	expect(dom.window.scrollY).toBeLessThan(initialScreenTop); // Should be pushed up
});

test("standard DOM properties: scrollHeight and clientHeight", async () => {
	const terminal = new TestTerminal({rows: 10, cols: 40});

	const dom = new TermDOM({process: terminal});

	// Add content with known height
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
	`;

	await dom.render();

	// Verify standard DOM properties are implemented
	expect(typeof dom.document.body.scrollHeight).toBe("number");
	expect(typeof dom.document.body.clientHeight).toBe("number");
	expect(typeof dom.document.documentElement.scrollHeight).toBe("number");
	expect(typeof dom.document.documentElement.clientHeight).toBe("number");

	// clientHeight should be terminal height
	expect(dom.document.body.clientHeight).toBe(10);
	expect(dom.document.documentElement.clientHeight).toBe(10);

	// scrollHeight should be content height (should be >= clientHeight)
	expect(dom.document.body.scrollHeight).toBeGreaterThanOrEqual(3); // At least 3 lines
	expect(dom.document.documentElement.scrollHeight).toBe(
		dom.document.body.scrollHeight,
	);
});
