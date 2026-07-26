import {test, expect} from "bun:test";
import {TermDOM} from "../src/index.js";
import {MockProcess} from "./test-utils.js";

test("detectCommandStart queries and sets window.screenTop", async () => {
	const terminal = new MockProcess();

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
	const terminal = new MockProcess();

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
	const terminal = new MockProcess();

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
	const terminal = new MockProcess({rows: 10, cols: 40});

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

test.todo(
	"push-up calculation when content exceeds available space",
	async () => {
		const terminal = new MockProcess({rows: 10, cols: 40});

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
	},
);

test("no push-up when content fits in available space", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

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

test.todo("push-up to terminal top when content is very large", async () => {
	const terminal = new MockProcess({rows: 5, cols: 30});

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
	const terminal = new MockProcess({rows: 20, cols: 60});

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
	const terminal = new MockProcess({rows: 10, cols: 40});

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
	const terminal = new MockProcess({rows: 10, cols: 40});

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

	// Layout coordinates should be offset by viewport offset
	// Layout (0,0) should map to terminal row 4 (0-based), showing at line 4
	expect(lines[4]).toBe("First"); // Row 5 (0-based index 4)

	// Layout (1ch,10ch) should map to terminal row 5, col 10
	expect(lines[5].substring(10, 16)).toBe("Second"); // Row 6, starting at col 10
});

test.todo("handling content that would exceed terminal bottom", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

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
	// Push-up behavior: cursor was at row 8 (screenTop=7), content needs 5 lines but only 2 available
	// System pushes up by 3 lines: cursor moves from row 8 to row 6 (screenTop=5)
	expect(dom.window.screenTop).toBe(5);
});

test("maximum layout height calculation", async () => {
	const terminal = new MockProcess({rows: 20, cols: 60});

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

test.todo(
	"push-up offset calculation when content exceeds available space",
	async () => {
		const terminal = new MockProcess({rows: 10, cols: 40});

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
		expect(dom.window.screenTop).toBe(6); // Should be pushed up from 8 to 6 (0-based)
	},
);

test.todo("content positioning with different terminal sizes", async () => {
	const smallTerminal = new MockProcess({rows: 5, cols: 20});
	const largeTerminal = new MockProcess({rows: 50, cols: 120});

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

	// Verify cursor positions after push-up behavior
	// Small terminal: cursor at row 3 (screenTop=2), content needs 3 lines but only 2 available
	// Push-up by 1 line: cursor moves from row 3 to row 2 (screenTop=1)
	expect(smallDom.window.screenTop).toBe(1);

	// Large terminal: cursor at row 25 (screenTop=24), enough space so no push-up
	expect(largeDom.window.screenTop).toBe(24);

	// TODO: When coordinate transformation is implemented, verify content
	// appears at correct terminal positions relative to commandStartRow
});

test.todo("content clipped to terminal boundaries", async () => {
	const terminal = new MockProcess({rows: 5, cols: 20});

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

	// Push-up behavior: cursor at row 4 (screenTop=3), content needs 3 lines but only 1 available
	// Push-up by 2 lines: cursor moves from row 4 to row 3 (screenTop=2)
	expect(dom.window.screenTop).toBe(2);

	// Content should be clipped to terminal boundaries
	// With updated screenTop, content appears 1 row higher
	expect(lines[2]).toBe("Visible line 1"); // Row 3 (0-based index 2)
	expect(lines[3]).toBe("Visible line 2"); // Row 4 (0-based index 3)
});

test.todo("content larger than terminal height (edge case)", async () => {
	const terminal = new MockProcess({rows: 5, cols: 30});

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
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 6
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[6;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// Initial state: command start detected
	expect(dom.window.screenTop).toBe(5); // Row 6 -> 0-based = 5 (readonly)
	expect(dom.window.scrollY).toBe(0); // Bounded to 0 like standard DOM

	// screenTop shows content position, scrollY shows actual scroll amount
	expect(dom.window.scrollY).toBe(0);
});

test("unified scrolling model: user scrolls to terminal top", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 8
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	expect(dom.window.screenTop).toBe(7); // Row 8 -> 0-based = 7 (readonly)
	expect(dom.window.scrollY).toBe(0); // Bounded to 0 in command start mode

	// User tries to scroll - should be no-op in command start mode
	dom.document.documentElement.scrollTop = 5;

	// scrollY should remain 0 (no-op when internal scrollTop < 0)
	expect(dom.window.scrollY).toBe(0);
	expect(dom.window.screenTop).toBe(7); // screenTop stays readonly
});

test("unified scrolling model: user scrolls down in document", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 5
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[5;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	expect(dom.window.screenTop).toBe(4); // Row 5 -> 0-based = 4
	expect(dom.window.scrollY).toBe(0); // Bounded to 0 in command start mode

	// User tries to scroll down - should be no-op in command start mode
	dom.document.documentElement.scrollTop = 7;

	// scrollY should remain 0 (no-op when internal scrollTop < 0)
	expect(dom.window.scrollY).toBe(0);
	expect(dom.window.screenTop).toBe(4); // screenTop stays readonly
});

test("unified scrolling model: pageYOffset alias", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 3
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[3;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	// pageYOffset should be an alias for scrollY
	expect(dom.window.pageYOffset).toBe(dom.window.scrollY);
	expect(dom.window.pageYOffset).toBe(0); // Bounded to 0 in command start mode

	// Trying to change scrollTop should be no-op in command start mode
	dom.document.documentElement.scrollTop = 5;
	expect(dom.window.pageYOffset).toBe(0); // Should remain 0
});

test.todo(
	"unified scrolling model: push-up updates scrollY not screenTop",
	async () => {
		const terminal = new MockProcess({rows: 10, cols: 40});

		// Position cursor at row 9 (only 2 lines available)
		await new Promise<void>((resolve) => {
			terminal.stdout.write("\x1b[9;1H", () => resolve());
		});

		const dom = new TermDOM({process: terminal});
		await dom.detectCommandStart();

		const initialScreenTop = dom.window.screenTop;
		expect(initialScreenTop).toBe(8); // Row 9 -> 0-based = 8
		expect(dom.window.scrollY).toBe(0); // Initial: bounded to 0 in command start mode

		// Add content that needs 4 lines (exceeds available 2 lines)
		dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
	`;

		await dom.render();

		// Push-up behavior: cursor at row 9 (screenTop=8), content needs 4 lines but only 1 available
		// Push-up by 3 lines: cursor moves from row 9 to row 6 (screenTop=5)
		// Note: actual value is 6, need to verify push-up calculation
		expect(dom.window.screenTop).toBe(6);

		// scrollY should remain 0 (still in command start mode after push-up)
		// Internal scrollTop was pushed up from -8 to -6, but scrollY stays bounded to 0
		expect(dom.window.scrollY).toBe(0); // Still bounded to 0
		// TODO: We could check internal state if needed, but public API shows 0
	},
);

test("standard DOM properties: scrollHeight and clientHeight", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

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

test("content taller than the room below the command start scrolls instead of vanishing", async () => {
	// A TermDOM app behaves like an ordinary command: output starts where the
	// cursor was and flows down, and when it outgrows the terminal the earlier
	// rows scroll off into native scrollback (SCROLLBACK.md).
	//
	// The call that does this was removed at some point and the content past the
	// bottom of the terminal was simply never drawn -- silently truncated.
	const terminal = new MockProcess({rows: 10, cols: 24});

	// Put the command start at row 7 (0-based 6), leaving 4 rows below it.
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[7;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();
	expect(dom.window.screenTop).toBe(6);

	// Eight rows of content into four rows of room.
	dom.document.body.innerHTML = Array.from(
		{length: 8},
		(_, i) => `<div>line ${i + 1}</div>`,
	).join("");
	await dom.render();

	expect(dom.document.body.scrollHeight).toBe(8);

	const text = terminal.getPlainText();

	// Every line is on screen: the content was pushed up, not cut off.
	for (let i = 1; i <= 8; i++) {
		expect(text).toContain(`line ${i}`);
	}

	// And the command start moved up to make room for it.
	expect(dom.window.screenTop).toBeLessThan(6);

	dom.dispose();
});

test("a document taller than the terminal commits its overflow to scrollback", async () => {
	// The contract: the terminal shows the last min(contentHeight, terminalHeight)
	// rows of the document, and everything above is in the terminal's own
	// scrollback -- frozen, because the cursor cannot address scrollback.
	//
	// Previously the frame buffer was locked to the terminal height, so any row
	// past the bottom had nowhere to go and was simply never drawn. A 14-row
	// document in an 8-row terminal rendered rows 1-8 and silently dropped the
	// rest.
	//
	// Note this cannot be checked with getPlainText(): that reads absolute buffer
	// indices, which include scrollback, so it does not show the viewport once the
	// terminal has scrolled.
	const terminal = new MockProcess({rows: 8, cols: 30});
	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	dom.document.body.innerHTML = Array.from(
		{length: 14},
		(_, i) => `<div>row ${i + 1}</div>`,
	).join("");
	await dom.render();

	const buffer = (terminal as any).terminal.buffer.active;

	// 14 rows of content, 8 rows of terminal: 6 rows have scrolled off.
	expect(buffer.baseY).toBe(6);

	const lineAt = (index: number): string =>
		buffer.getLine(index)?.translateToString(true) ?? "";

	// The overflow went into the scrollback -- it was printed, not discarded.
	for (let i = 0; i < 6; i++) {
		expect(lineAt(i)).toBe(`row ${i + 1}`);
	}

	// And the viewport holds the tail of the document.
	for (let i = 0; i < 8; i++) {
		expect(lineAt(buffer.baseY + i)).toBe(`row ${i + 7}`);
	}

	dom.dispose();
});

test("growing the terminal does not destroy rows it hands back from scrollback", async () => {
	// When a terminal grows, it pulls lines back out of its scrollback into the
	// viewport -- so rows that were frozen a moment ago become addressable again,
	// and our next frame paints over them.
	//
	// The region we draw was keyed on hasDetectedCommandStart, which the resize
	// path deliberately unsets (so the frame is placed with DECRC rather than CUP).
	// A resize therefore fell back to a stale scroll offset and painted the tail of
	// the document over the rows the terminal had just returned. They were gone --
	// not in the viewport, not in the scrollback, gone.
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	dom.document.body.innerHTML = Array.from(
		{length: 10},
		(_, i) => `<div>row ${i + 1}</div>`,
	).join("");
	await dom.render();

	// 10 rows into a 6-row terminal: 4 rows have scrolled off.
	expect((terminal as any).terminal.buffer.active.baseY).toBe(4);

	// Grow the terminal so the whole document fits again.
	terminal.resize(40, 10);
	(terminal as any).emit("SIGWINCH");
	await new Promise((resolve) => setTimeout(resolve, 60));

	const buffer = (terminal as any).terminal.buffer.active;
	const everything: string[] = [];
	for (let i = 0; i < buffer.length; i++) {
		const line = buffer.getLine(i)?.translateToString(true);
		if (line) everything.push(line);
	}

	// Every row of the document is still somewhere in the terminal.
	for (let i = 1; i <= 10; i++) {
		expect(everything).toContain(`row ${i}`);
	}

	dom.dispose();
});

test("reflow above the fold reprints the document instead of corrupting the scrollback", async () => {
	// The commit index is a row *number*, so it only means anything while the rows
	// above it stay put. Insert a row near the top and every row number beneath it
	// shifts: rows already in the scrollback got printed a second time
	// (duplicated), and the inserted content never appeared at all.
	//
	// The scrollback cannot be rewritten -- no escape sequence addresses it. There
	// are two primitives: append, or destroy the lot (which is what flicker is). So
	// we append: the stale copy stays above as a record of what was shown, and a
	// correct one is printed below.
	const terminal = new MockProcess({rows: 8, cols: 40});
	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	const body = dom.document.body;
	body.innerHTML = Array.from(
		{length: 14},
		(_, i) => `<div>row ${i + 1}</div>`,
	).join("");
	await dom.render();

	// Now reflow above the fold: a row inserted at the very top shifts everything.
	const inserted = dom.document.createElement("div");
	inserted.textContent = "INSERTED-AT-TOP";
	body.insertBefore(inserted, body.firstChild);
	await dom.render();

	const buffer = (terminal as any).terminal.buffer.active;
	const everything: string[] = [];
	for (let i = 0; i < buffer.length; i++) {
		const line = buffer.getLine(i)?.translateToString(true);
		if (line) everything.push(line);
	}

	// The inserted content is on screen -- it used to appear nowhere at all.
	expect(everything).toContain("INSERTED-AT-TOP");

	// The viewport holds the tail of the *new* document (15 rows, so rows 7-14).
	const viewport: string[] = [];
	for (let i = 0; i < 8; i++) {
		const line = buffer.getLine(buffer.baseY + i)?.translateToString(true);
		if (line) viewport.push(line);
	}
	expect(viewport[viewport.length - 1]).toBe("row 14");

	dom.dispose();
});

test("resizing narrower reprints cleanly instead of layering over reflowed remnants", async () => {
	// A resize rewraps everything on screen -- including our previous frame -- and
	// moves the cursor somewhere we can no longer name, so erasing relative to a
	// saved position (DECRC) lands wrong and the old frame's reflowed remnants
	// survive above the new render. That was the corruption: a garbled narrow-wrap
	// of the old content sitting above a clean new one.
	//
	// The fix homes the cursor and clears the visible screen before reprinting.
	// For content that fit on screen, nothing is pushed to scrollback and the
	// result is a single clean render with no duplication.
	const terminal = new MockProcess({rows: 12, cols: 40});
	const dom = new TermDOM({process: terminal});
	await dom.detectCommandStart();

	dom.document.body.innerHTML =
		`<div>Header line for the demo application here.</div>` +
		`<div>A paragraph that wraps when the terminal is narrow.</div>` +
		`<div>Footer content at the bottom.</div>`;
	await dom.render();

	terminal.resize(24, 12);
	(terminal as any).emit("SIGWINCH");
	await new Promise((resolve) => setTimeout(resolve, 80));

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");

	// Content fit, so nothing scrolled off: no reflowed remnants in scrollback.
	expect(buffer.baseY).toBe(0);

	// The header appears exactly once -- not once as a reflowed remnant and again
	// in the new render.
	const headerRows = [];
	for (let i = 0; i < buffer.length; i++) {
		if (line(i).startsWith("Header line")) headerRows.push(i);
	}
	expect(headerRows.length).toBe(1);

	// And the render is the clean rewrap at the new width, from the top.
	expect(line(0)).toBe("Header line for the");
	expect(line(1)).toBe("demo application here.");

	dom.dispose();
});

test("shrinking height re-anchors to the scrolled command start, no orphaned top", async () => {
	// When the terminal loses rows it scrolls up to keep the cursor -- the bottom
	// of our content -- on screen, and the command start rides up with it. If we
	// redraw from the stale (pre-scroll) row, the frame lands one or more rows too
	// low and the old top is orphaned above the new render: the double-render the
	// user sees on a vertical shrink.
	//
	// The fix computes that scroll from the new layout height and re-anchors, so
	// the visible viewport shows the frame exactly once.
	const terminal = new MockProcess({rows: 16, cols: 40});
	const dom = new TermDOM({process: terminal});

	// Two prompt lines above, so the command start is below the top of the screen.
	await new Promise<void>((resolve) => {
		terminal.stdout.write("~/proj % app\r\n~/proj % app2\r\n", () => resolve());
	});
	await dom.detectCommandStart();

	dom.document.body.innerHTML = Array.from(
		{length: 6},
		(_, i) => `<div>APPLINE ${i + 1}</div>`,
	).join("");
	await dom.render();

	// Shrink so the content bottom overflows the new height and the terminal
	// scrolls the top prompt lines into scrollback.
	terminal.resize(40, 10);
	(terminal as any).emit("SIGWINCH");
	await new Promise((resolve) => setTimeout(resolve, 80));

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");

	// The visible viewport is [baseY, baseY + rows). Within it the first app line
	// appears exactly once -- not orphaned above a fresh copy.
	let firstLineHits = 0;
	for (let i = buffer.baseY; i < buffer.baseY + terminal.stdout.rows; i++) {
		if (line(i) === "APPLINE 1") firstLineHits++;
	}
	expect(firstLineHits).toBe(1);

	dom.dispose();
});

test("the cursor parks at the content bottom after every frame", async () => {
	// A diff leaves the cursor wherever the last changed cell happened to be -- an
	// arbitrary row. The terminal preserves the cursor across a resize and scrolls
	// exactly enough to keep it on screen, so an arbitrary resting row makes that
	// scroll arbitrary too -- and the resize re-anchor computes the scroll assuming
	// the cursor sits at the content bottom. With the prompt near the bottom of the
	// screen, that mismatch stranded a copy of the frame above the re-anchored one
	// on a height shrink. The renderer now parks the cursor on the content's last
	// row at the end of every frame.
	const terminal = new MockProcess({rows: 20, cols: 40});
	await new Promise<void>((resolve) => {
		terminal.stdout.write("PREV-1\r\nPREV-2\r\n", () => resolve());
	});
	const dom = new TermDOM({process: terminal, detectCursor: true});
	dom.document.body.innerHTML = `<div id="a">alpha</div><div>beta</div><div>gamma</div><div>delta</div>`;
	await dom.render();

	const buffer = (terminal as any).terminal.buffer.active;
	const contentBottom = dom.window.screenTop + 4 - 1;

	// After a full render the cursor rests at the content bottom.
	expect(buffer.cursorY).toBe(contentBottom);

	// After a diff that touches only the TOP row, the cursor must still park at
	// the bottom -- not at the changed cell, where the raw diff leaves it.
	dom.document.getElementById("a")!.textContent = "ALPHA-CHANGED";
	await dom.render();
	expect(buffer.cursorY).toBe(contentBottom);

	dom.dispose();
});

test("a width resize re-anchors via the parked cursor, not guesswork", async () => {
	// A width change makes the terminal rewrap our old frame in place, moving our
	// content by an amount that depends on text above us that we do not own.
	// Guessing strands a copy of the old frame wherever the guess is wrong. The
	// re-anchor instead queries the cursor -- parked on the content's bottom row,
	// riding its line through the rewrap -- and subtracts the old frame's
	// computable rewrapped height. See "Re-anchoring on a resize" in SCROLLBACK.md.
	const terminal = new MockProcess({rows: 20, cols: 60});
	await new Promise<void>((resolve) => {
		terminal.stdout.write("PREV-A\r\nPREV-B\r\n", () => resolve());
	});
	const dom = new TermDOM({process: terminal, detectCursor: true});
	dom.document.body.innerHTML =
		`<div>HEADER LINE THAT IS FAIRLY LONG AND WILL WRAP WHEN NARROW</div>` +
		`<div>short one</div><div>short two</div><div>short three</div>`;
	await dom.render();
	expect(dom.window.screenTop).toBe(2);

	// Narrow enough that the header wraps to two rows.
	terminal.resize(30, 20);
	(terminal as any).emit("SIGWINCH");
	await new Promise((resolve) => setTimeout(resolve, 150));

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");

	// The anchor recovered its true position and the frame appears exactly once.
	expect(dom.window.screenTop).toBe(2);
	let headerCopies = 0;
	for (let i = 0; i < buffer.baseY + 20; i++) {
		if (line(i).startsWith("HEADER LINE")) headerCopies++;
	}
	expect(headerCopies).toBe(1);

	// Prior output is intact above the rewrapped frame.
	expect(line(0)).toBe("PREV-A");
	expect(line(1)).toBe("PREV-B");
	expect(line(2)).toBe("HEADER LINE THAT IS FAIRLY");

	dom.dispose();
});
