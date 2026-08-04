import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/index.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("cursor detection sets window.screenTop from the command-start row", async () => {
	const terminal = new MockProcess();

	// Position cursor at row 15 (1-based) before construction.
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[15;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});

	// Construction auto-detects the anchor; a frame settles it. Row 15 (1-based)
	// is screenTop 14 (0-based).
	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(14);
});

test("cursor detection handles a different row", async () => {
	const terminal = new MockProcess();

	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[23;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});

	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(22);
});

test("cursor detection handles row 1 (top of terminal)", async () => {
	const terminal = new MockProcess();

	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[1;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});

	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(0);
});

test("rendering small content from command start (fits in available space)", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 8 (leaving 2 lines available)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	// Add small content that fits in available space
	dom.document.body.innerHTML = `<div>Content Line</div>`;

	await nextFrame(dom);
	const lines = terminal.getPlainText().split("\n");

	// Content should render starting at row 8 (command start)
	expect(dom.window.screenTop).toBe(7); // Row 8 -> 0-based = 7

	// FAILING: Currently renders at top, should render at row 8
	expect(lines[7]).toBe("Content Line"); // Row 8 (0-based index 7)
	expect(lines[0]).toBe(""); // Top should be empty
});

test("push-up calculation when content exceeds available space", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 8 (leaving 3 lines available: 8, 9, 10)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(7); // Row 8 -> 0-based = 7

	// Add content that needs 5 lines (exceeds available 3 lines by 2)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
		<div>Line 5</div>
	`;

	await nextFrame(dom);

	// window.screenTop should be pushed up by 2 lines (from 7 to 5)
	// This accommodates all 5 lines of content in the 10-row terminal
	expect(dom.window.screenTop).toBe(5); // Row 6 -> 0-based = 5
});

test("no push-up when content fits in available space", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 7 (leaving 4 lines available: 7, 8, 9, 10)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[7;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(6); // Row 7 -> 0-based = 6

	// Add content that needs exactly 3 lines (fits in available 4 lines)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
	`;

	await nextFrame(dom);

	// window.screenTop should NOT be pushed up - content fits
	expect(dom.window.screenTop).toBe(6);
});

test("push-up to terminal top when content is very large", async () => {
	const terminal = new MockProcess({rows: 5, cols: 30});

	// Position cursor at row 4 (leaving 2 lines available: 4, 5)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[4;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(3); // Row 4 -> 0-based = 3

	// Add content that needs all 5 terminal lines
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
		<div>Line 5</div>
	`;

	await nextFrame(dom);

	// window.screenTop should be pushed all the way to 0 (row 1)
	expect(dom.window.screenTop).toBe(0);
});

test("document height calculation with auto layout", async () => {
	const terminal = new MockProcess({rows: 20, cols: 60});

	// Position cursor at row 10
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[10;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	// Add content with known height (3 lines)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
	`;

	await nextFrame(dom);

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

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	// Add content that exactly fills terminal height
	const lines = Array.from({length: 10}, (_, i) => `<div>Line ${i + 1}</div>`);
	dom.document.body.innerHTML = lines.join("\n");

	await nextFrame(dom);

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

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	// Add content with known layout coordinates
	dom.document.body.innerHTML = `
		<div style="position: absolute; top: 0; left: 0;">First</div>
		<div style="position: absolute; top: 1ch; left: 10ch;">Second</div>
	`;

	await nextFrame(dom);
	const lines = terminal.getPlainText().split("\n");

	expect(dom.window.screenTop).toBe(4); // Row 5 -> 0-based = 4

	// Layout coordinates should be offset by viewport offset
	// Layout (0,0) should map to terminal row 4 (0-based), showing at line 4
	expect(lines[4]).toBe("First"); // Row 5 (0-based index 4)

	// Layout (1ch,10ch) should map to terminal row 5, col 10
	expect(lines[5].substring(10, 16)).toBe("Second"); // Row 6, starting at col 10
});

test("handling content that would exceed terminal bottom", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor near bottom (row 8, leaving only 3 lines: 8, 9, 10)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	// Add content that needs 5 lines (exceeds the 3 available by 2)
	dom.document.body.innerHTML = `
		<div>Content line 1</div>
		<div>Content line 2</div>
		<div>Content line 3</div>
		<div>Content line 4</div>
		<div>Content line 5</div>
	`;

	await nextFrame(dom);

	// The terminal scrolls the earlier content up into scrollback, the anchor
	// moves from row 8 (screenTop=7) up by 2 to row 6 (screenTop=5), and all 5
	// lines now fit below it.
	expect(dom.window.screenTop).toBe(5);
	const lines = terminal.getPlainText().split("\n").filter(Boolean);
	expect(lines).toEqual([
		"Content line 1",
		"Content line 2",
		"Content line 3",
		"Content line 4",
		"Content line 5",
	]);
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

		const dom = new TermDOM({process: terminal, detectCursor: true});
		await nextFrame(dom);

		// TODO: When maxLayoutHeight property is added, verify calculation:
		// maxLayoutHeight = terminalHeight - commandStartRow + 1
		expect(dom.window.screenTop).toBe(commandStart - 1); // Convert 1-based to 0-based
		const calculatedMaxHeight = terminal.stdout.rows - commandStart + 1;
		expect(calculatedMaxHeight).toBe(expectedMaxHeight);
	}
});

test("push-up offset calculation when content exceeds available space", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 9 (2 lines available: 9, 10)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[9;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	// Add content that needs 4 lines (exceeds available 2 lines by 2)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
	`;

	await nextFrame(dom);
	const lines = terminal.getPlainText().split("\n");

	// Pushed up by 2 lines to accommodate all content: new screenTop is 8-2=6
	// (0-based), content renders from row 7 (1-based) through row 10.
	expect(lines[6]).toBe("Line 1"); // Row 7 (0-based index 6)
	expect(lines[7]).toBe("Line 2"); // Row 8
	expect(lines[8]).toBe("Line 3"); // Row 9
	expect(lines[9]).toBe("Line 4"); // Row 10

	// Initial command start should be updated
	expect(dom.window.screenTop).toBe(6); // Should be pushed up from 8 to 6 (0-based)
});

test("content positioning with different terminal sizes", async () => {
	const smallTerminal = new MockProcess({rows: 5, cols: 20});
	const largeTerminal = new MockProcess({rows: 50, cols: 120});

	// Test same content on different terminal sizes
	const content = `
		<div>First line of content</div>
		<div>Second line here</div>
		<div>Third line content</div>
	`;

	// Small terminal test. detectCursor:true is required for cursor detection
	// (and therefore push-up) to run at all -- without it, screenTop stays 0
	// regardless of content, which is not what this test is about.
	await new Promise<void>((resolve) => {
		smallTerminal.stdout.write("\x1b[3;1H", () => resolve());
	});
	const smallDom = new TermDOM({process: smallTerminal, detectCursor: true});
	await nextFrame(smallDom);
	smallDom.document.body.innerHTML = content;
	await nextFrame(smallDom);

	// Large terminal test
	await new Promise<void>((resolve) => {
		largeTerminal.stdout.write("\x1b[25;1H", () => resolve());
	});
	const largeDom = new TermDOM({process: largeTerminal, detectCursor: true});
	await nextFrame(largeDom);
	largeDom.document.body.innerHTML = content;
	await nextFrame(largeDom);

	// Small terminal: cursor at row 3 (screenTop=2), only 3 rows below (rows
	// 3-5). At 20 columns, "First line of content" wraps into two lines, so
	// the content is really 4 rows -- one more than fits. Push up by 1: from
	// screenTop=2 to 1.
	expect(smallDom.window.screenTop).toBe(1);

	// Large terminal: cursor at row 25 (screenTop=24), 120 columns is wide
	// enough that nothing wraps and all 3 lines fit easily -- no push-up.
	expect(largeDom.window.screenTop).toBe(24);
});

test("push-up prevents content from being clipped, when it still fits the terminal", async () => {
	const terminal = new MockProcess({rows: 5, cols: 20});

	// Position cursor at row 4 (only 2 lines available: 4, 5)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[4;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	// 3 lines of content, only 2 rows available below the cursor -- but the
	// terminal has 5 rows total, so push-up can make room for all of it.
	dom.document.body.innerHTML = `
		<div>Visible line 1</div>
		<div>Visible line 2</div>
		<div>Should also appear</div>
	`;

	await nextFrame(dom);
	const lines = terminal.getPlainText().split("\n");

	// Cursor at row 4 (screenTop=3), content needs 3 lines but only 2 are
	// available -- pushed up by 1 line, to screenTop=2.
	expect(dom.window.screenTop).toBe(2);

	// All three lines fit and render -- nothing is clipped, since the
	// terminal's 5 total rows are enough once the anchor moves.
	expect(lines[2]).toBe("Visible line 1"); // Row 3 (0-based index 2)
	expect(lines[3]).toBe("Visible line 2"); // Row 4
	expect(lines[4]).toBe("Should also appear"); // Row 5
});

test("content larger than terminal height (edge case)", async () => {
	const terminal = new MockProcess({rows: 5, cols: 30});

	// Position cursor at row 3
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[3;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(2); // Row 3 -> 0-based = 2

	// Add content that needs 8 lines -- more than the 5-row terminal could
	// ever show at once, regardless of push-up.
	const contentLines = Array.from(
		{length: 8},
		(_, i) => `<div>Line ${i + 1}</div>`,
	);
	dom.document.body.innerHTML = contentLines.join("\n");

	await nextFrame(dom);

	// Push-up goes as far as it can (to the terminal's own top) but that still
	// isn't enough room for 8 lines in a 5-row terminal. The answer to "what
	// happens to the rest": it clips to what fits, showing the first 5
	// lines -- the same clip-to-viewport behavior any other overflowing
	// content gets, not an error or an auto-scroll/paging mode.
	expect(dom.window.screenTop).toBe(0); // Pushed to top
	const lines = terminal.getPlainText().split("\n").filter(Boolean);
	expect(lines).toEqual(["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"]);
});

test("unified scrolling model: screenTop + scrollY", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 6
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[6;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

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

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

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

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

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

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	// pageYOffset should be an alias for scrollY
	expect(dom.window.pageYOffset).toBe(dom.window.scrollY);
	expect(dom.window.pageYOffset).toBe(0); // Bounded to 0 in command start mode

	// Trying to change scrollTop should be no-op in command start mode
	dom.document.documentElement.scrollTop = 5;
	expect(dom.window.pageYOffset).toBe(0); // Should remain 0
});

test("unified scrolling model: push-up moves screenTop, not scrollY", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 9 (only 2 lines available: 9, 10)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[9;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	const initialScreenTop = dom.window.screenTop;
	expect(initialScreenTop).toBe(8); // Row 9 -> 0-based = 8
	expect(dom.window.scrollY).toBe(0); // Initial: bounded to 0 in command start mode

	// Add content that needs 4 lines (exceeds the 2 available by 2)
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
		<div>Line 4</div>
	`;

	await nextFrame(dom);

	// Push-up moves the anchor (screenTop), from 8 to 6.
	expect(dom.window.screenTop).toBe(6);

	// scrollY is the document camera, a different axis from the anchor --
	// push-up making room below the anchor doesn't move the camera, so it
	// stays exactly where it was (0, bounded in command-start mode).
	expect(dom.window.scrollY).toBe(0);
});

test("standard DOM properties: scrollHeight and clientHeight", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	const dom = new TermDOM({process: terminal, detectCursor: true});

	// Add content with known height
	dom.document.body.innerHTML = `
		<div>Line 1</div>
		<div>Line 2</div>
		<div>Line 3</div>
	`;

	await nextFrame(dom);

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
	const dom = new TermDOM({process: terminal, detectCursor: true});
	await nextFrame(dom);

	dom.document.body.innerHTML =
		`<div>Header line for the demo application here.</div>` +
		`<div>A paragraph that wraps when the terminal is narrow.</div>` +
		`<div>Footer content at the bottom.</div>`;
	await nextFrame(dom);

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
	const dom = new TermDOM({process: terminal, detectCursor: true});

	// Two prompt lines above, so the command start is below the top of the screen.
	await new Promise<void>((resolve) => {
		terminal.stdout.write("~/proj % app\r\n~/proj % app2\r\n", () => resolve());
	});
	await nextFrame(dom);

	dom.document.body.innerHTML = Array.from(
		{length: 6},
		(_, i) => `<div>APPLINE ${i + 1}</div>`,
	).join("");
	await nextFrame(dom);

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
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const contentBottom = dom.window.screenTop + 4 - 1;

	// After a full render the cursor rests at the content bottom.
	expect(buffer.cursorY).toBe(contentBottom);

	// After a diff that touches only the TOP row, the cursor must still park at
	// the bottom -- not at the changed cell, where the raw diff leaves it.
	dom.document.getElementById("a")!.textContent = "ALPHA-CHANGED";
	await nextFrame(dom);
	expect(buffer.cursorY).toBe(contentBottom);

	dom.dispose();
});

test("a width resize re-anchors via the parked cursor, not guesswork", async () => {
	// A width change makes the terminal rewrap our old frame in place, moving our
	// content by an amount that depends on text above us that we do not own.
	// Guessing strands a copy of the old frame wherever the guess is wrong. The
	// re-anchor instead queries the cursor -- parked on the content's bottom row
	// after every frame, so its resting place is deterministic and it rides its
	// line through the rewrap -- and subtracts the old frame's computable
	// rewrapped height. Both halves are load-bearing: without the parking the
	// cursor sits wherever the last diff happened to leave it, and the query
	// answers about a row we cannot reason about.
	const terminal = new MockProcess({rows: 20, cols: 60});
	await new Promise<void>((resolve) => {
		terminal.stdout.write("PREV-A\r\nPREV-B\r\n", () => resolve());
	});
	const dom = new TermDOM({process: terminal, detectCursor: true});
	dom.document.body.innerHTML =
		`<div>HEADER LINE THAT IS FAIRLY LONG AND WILL WRAP WHEN NARROW</div>` +
		`<div>short one</div><div>short two</div><div>short three</div>`;
	await nextFrame(dom);
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

test("matchMedia answers with the stylesheet evaluator and goes live on resize", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({process: terminal});
	const {window, document} = dom;

	const mql = window.matchMedia("(min-width: 90px)");
	expect(mql.media).toBe("(min-width: 90px)");
	expect(mql.matches).toBe(true);

	const events: boolean[] = [];
	mql.onchange = (ev: any) => events.push(ev.matches);
	const listener = (ev: any) => events.push(ev.matches);
	mql.addEventListener("change", listener);

	document.body.innerHTML = "<div>x</div>";
	await nextFrame(dom);

	terminal.resize(50, 30);
	(terminal as any).emit("SIGWINCH");
	await nextFrame(dom);
	await new Promise((r) => setTimeout(r, 100));

	expect(mql.matches).toBe(false);
	expect(events).toEqual([false, false]); // onchange + listener, once each

	// A resize that doesn't flip the answer fires nothing.
	terminal.resize(40, 30);
	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 100));
	expect(events.length).toBe(2);

	dom.dispose();
});

test("@media stylesheet rules re-evaluate when the terminal resizes", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({process: terminal});
	const {window, document} = dom;

	const style = document.createElement("style");
	style.textContent = `@media (max-width: 60px) { div { color: red; } }`;
	document.head.appendChild(style);
	document.body.innerHTML = `<div id="d">narrow-only</div>`;
	await nextFrame(dom);
	const div = document.getElementById("d")!;
	expect(window.getComputedStyle(div).getPropertyValue("color")).not.toBe(
		"red",
	);

	terminal.resize(50, 30);
	(terminal as any).emit("SIGWINCH");
	await nextFrame(dom);
	await new Promise((r) => setTimeout(r, 100));

	expect(window.getComputedStyle(div).getPropertyValue("color")).toBe("red");

	dom.dispose();
});

test("cancelAnimationFrame actually cancels", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {window, document} = dom;

	let canceled = false;
	let kept = false;
	const id = window.requestAnimationFrame(() => {
		canceled = true;
	});
	window.requestAnimationFrame(() => {
		kept = true;
	});
	window.cancelAnimationFrame(id);

	document.body.innerHTML = "<div>x</div>";
	await nextFrame(dom);
	expect(kept).toBe(true);
	expect(canceled).toBe(false);

	dom.dispose();
});

test("a height shrink that still fits moves nothing and erases nothing", async () => {
	// The invariant that holds in EVERY terminal: when the frame still fits
	// below its anchor, no terminal has any reason to move our content, so the
	// anchor stands and the prompt above is untouched. (When the frame does
	// NOT fit, terminals disagree about whether they scroll the content or
	// discard rows from the bottom, and no query distinguishes the two -- that
	// case is covered by the drag test below, which asserts the property that
	// survives the disagreement: exactly one copy.)
	const terminal = new MockProcess({rows: 18, cols: 60});
	await new Promise<void>((resolve) => {
		terminal.stdout.write("~/proj % demo\r\n~ %\r\n", () => resolve());
	});
	const dom = new TermDOM({process: terminal, detectCursor: true});
	dom.document.body.innerHTML =
		`<div>HEADER-ROW</div>` +
		`<div>Subject <input id="s"></div>` +
		Array.from({length: 10}, (_, i) => `<div>BODY-${i + 1}</div>`).join("");
	(dom.document.getElementById("s") as HTMLElement).focus();
	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(2);

	// 12 content rows anchored at row 2 need 14; 16 rows leave room to spare.
	terminal.resize(60, 16);
	(terminal as any).emit("SIGWINCH");
	await new Promise((resolve) => setTimeout(resolve, 200));

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");

	// Both prompt lines still on the visible screen, exactly where they were.
	expect(line(0)).toBe("~/proj % demo");
	expect(line(1)).toBe("~ %");
	expect(dom.window.screenTop).toBe(2);

	// And one copy of the frame, top and bottom.
	let headers = 0;
	let bottoms = 0;
	for (let i = buffer.baseY; i < buffer.baseY + terminal.stdout.rows; i++) {
		if (line(i) === "HEADER-ROW") headers++;
		if (line(i) === "BODY-10") bottoms++;
	}
	expect(headers).toBe(1);
	expect(bottoms).toBe(1);

	dom.dispose();
});

test("a height-only resize re-anchors by computation, not by asking the cursor", async () => {
	// A height change reflows nothing, so the only movement is the scroll the
	// terminal performs to keep the bottom in view -- exactly the overflow,
	// and computable. Measuring it with DSR instead is wrong: a terminal
	// scrolls the content without carrying the cursor's ROW NUMBER along
	// (tmux does not), so the recovered anchor lands a row too low and the
	// erase leaves the old frame's top row stranded above the new one. That
	// is the doubling a window drag produced, one row per scrolled resize.
	const terminal = new MockProcess({rows: 24, cols: 60});
	await new Promise<void>((resolve) => {
		terminal.stdout.write("~/proj % demo\r\n~ %\r\n", () => resolve());
	});
	const dom = new TermDOM({process: terminal, detectCursor: true});
	dom.document.body.innerHTML =
		`<div>HEADER-ROW</div>` +
		`<div>Subject <input id="s"></div>` +
		Array.from({length: 10}, (_, i) => `<div>BODY-${i + 1}</div>`).join("");
	// A focused field parks the cursor mid-frame, which is what makes the
	// terminal's cursor bookkeeping and the content's disagree.
	(dom.document.getElementById("s") as HTMLElement).focus();
	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");
	const visibleCopies = (text: string): number => {
		let copies = 0;
		for (let i = buffer.baseY; i < buffer.baseY + terminal.stdout.rows; i++) {
			if (line(i) === text) copies++;
		}
		return copies;
	};

	// Shrink one row at a time, the way a drag does, past the point where the
	// frame stops fitting below its anchor.
	for (const rows of [23, 22, 21, 20, 19, 18]) {
		terminal.resize(60, rows);
		(terminal as any).emit("SIGWINCH");
		const settled = () =>
			visibleCopies("HEADER-ROW") === 1 && visibleCopies("BODY-10") === 1;
		for (let waited = 0; !settled() && waited < 2000; waited += 50) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(visibleCopies("HEADER-ROW")).toBe(1);
		expect(visibleCopies("BODY-10")).toBe(1);
	}

	dom.dispose();
});
