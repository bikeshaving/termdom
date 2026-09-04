import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

test("cursor detection sets window.screenTop from the command-start row", async () => {
	const terminal = new MockProcess();

	// Position cursor at row 15 (1-based) before construction.
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[15;1H", () => resolve());
	});

	const dom = new TermDOM({transport: terminal.sharedTransport});

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

	const dom = new TermDOM({transport: terminal.sharedTransport});

	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(22);
});

test("cursor detection handles row 1 (top of terminal)", async () => {
	const terminal = new MockProcess();

	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[1;1H", () => resolve());
	});

	const dom = new TermDOM({transport: terminal.sharedTransport});

	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(0);
});

test("rendering small content from command start (fits in available space)", async () => {
	const terminal = new MockProcess({rows: 10, cols: 40});

	// Position cursor at row 8 (leaving 2 lines available)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[8;1H", () => resolve());
	});

	const dom = new TermDOM({transport: terminal.sharedTransport});
	await nextFrame(dom);

	// Add small content that fits in available space
	dom.document.body.innerHTML = "<div>Content Line</div>";

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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

		const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	// The shared transport is what lets cursor detection -- and therefore
	// push-up -- run at all. Over a plain transport screenTop stays 0
	// regardless of content, which is not what this test is about.
	await new Promise<void>((resolve) => {
		smallTerminal.stdout.write("\x1b[3;1H", () => resolve());
	});
	const smallDOM = new TermDOM({transport: smallTerminal.sharedTransport});
	await nextFrame(smallDOM);
	smallDOM.document.body.innerHTML = content;
	await nextFrame(smallDOM);

	// Large terminal test
	await new Promise<void>((resolve) => {
		largeTerminal.stdout.write("\x1b[25;1H", () => resolve());
	});
	const largeDOM = new TermDOM({transport: largeTerminal.sharedTransport});
	await nextFrame(largeDOM);
	largeDOM.document.body.innerHTML = content;
	await nextFrame(largeDOM);

	// Small terminal: cursor at row 3 (screenTop=2), only 3 rows below (rows
	// 3-5). At 20 columns, "First line of content" wraps into two lines, so
	// the content is really 4 rows -- one more than fits. Push up by 1: from
	// screenTop=2 to 1.
	expect(smallDOM.window.screenTop).toBe(1);

	// Large terminal: cursor at row 25 (screenTop=24), 120 columns is wide
	// enough that nothing wraps and all 3 lines fit easily -- no push-up.
	expect(largeDOM.window.screenTop).toBe(24);
});

test("push-up prevents content from being clipped, when it still fits the terminal", async () => {
	const terminal = new MockProcess({rows: 5, cols: 20});

	// Position cursor at row 4 (only 2 lines available: 4, 5)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[4;1H", () => resolve());
	});

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});
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

	const dom = new TermDOM({transport: terminal.sharedTransport});

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
	const dom = new TermDOM({transport: terminal.sharedTransport});
	await nextFrame(dom);

	dom.document.body.innerHTML =
		"<div>Header line for the demo application here.</div>" +
		"<div>A paragraph that wraps when the terminal is narrow.</div>" +
		"<div>Footer content at the bottom.</div>";
	await nextFrame(dom);

	terminal.resize(24, 12);
	(terminal as any).emit("SIGWINCH");

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");

	// The rewrap arrives after the resize debounce plus a cursor-query round
	// trip; poll for the final wrap rather than a fixed delay the parallel
	// runner can outrun. The settled marker is the narrow wrap of the first
	// line -- an intermediate render can leave a wider break ("...for the demo")
	// on the way there.
	for (
		let waited = 0;
		line(0) !== "Header line for the" && waited < 2000;
		waited += 25
	) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	// Content fit, so nothing scrolled off: no reflowed remnants in scrollback.
	expect(buffer.baseY).toBe(0);

	// The header appears exactly once -- not once as a reflowed remnant and again
	// in the new render.
	const headerRows = [];
	for (let i = 0; i < buffer.length; i++) {
		if (line(i).startsWith("Header line")) {
			headerRows.push(i);
		}
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
	const dom = new TermDOM({transport: terminal.sharedTransport});

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
		if (line(i) === "APPLINE 1") {
			firstLineHits++;
		}
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
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML = "<div id=\"a\">alpha</div><div>beta</div><div>gamma</div><div>delta</div>";
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
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML =
		"<div>HEADER LINE THAT IS FAIRLY LONG AND WILL WRAP WHEN NARROW</div>" +
		"<div>short one</div><div>short two</div><div>short three</div>";
	await nextFrame(dom);
	expect(dom.window.screenTop).toBe(2);

	// Narrow enough that the header wraps to two rows.
	terminal.resize(30, 20);
	(terminal as any).emit("SIGWINCH");

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");
	const headerCopiesOnScreen = (): number => {
		let copies = 0;
		for (let i = 0; i < buffer.baseY + 20; i++) {
			if (line(i).startsWith("HEADER LINE")) {
				copies++;
			}
		}
		return copies;
	};

	// The redraw arrives after the resize debounce plus a cursor-query round
	// trip; poll for the settled screen rather than betting on a fixed delay,
	// which the parallel test runner can outrun under load. The settled marker
	// is the REWRAP itself -- line 2 holding the header broken at the 30-column
	// edge ("...FAIRLY", not the wider "...FAIRLY LON") -- because screenTop and
	// the single-copy count are already true of the pre-resize screen and would
	// let the poll exit before the rewrap landed.
	const rewrapped = () => line(2) === "HEADER LINE THAT IS FAIRLY";
	for (let waited = 0; !rewrapped() && waited < 2000; waited += 25) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	// The anchor recovered its true position and the frame appears exactly once.
	expect(dom.window.screenTop).toBe(2);
	expect(headerCopiesOnScreen()).toBe(1);

	// Prior output is intact above the rewrapped frame.
	expect(line(0)).toBe("PREV-A");
	expect(line(1)).toBe("PREV-B");
	expect(line(2)).toBe("HEADER LINE THAT IS FAIRLY");

	dom.dispose();
});

test("a superseded resize drops the answer to the query it sent", async () => {
	// The re-anchor asks the terminal where the cursor is and waits. A second
	// SIGWINCH during that wait retires the question: the row coming back was
	// measured at a width the terminal has left, and placing the frame by it
	// would anchor the redraw somewhere the content no longer is. The resize
	// that is settling now is the one allowed to place the frame, and the
	// suppression that keeps animation ticks off the screen holds until it
	// does.
	const terminal = new MockProcess({rows: 20, cols: 60});
	await new Promise<void>((resolve) => {
		terminal.stdout.write("PREV-A\r\nPREV-B\r\n", () => resolve());
	});
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML =
		"<div>HEADER LINE THAT IS FAIRLY LONG AND WILL WRAP WHEN NARROW</div>" +
		"<div>short one</div>";
	await nextFrame(dom);

	// Hold the cursor replies so a resize can be superseded mid-query.
	const stdin = terminal.stdin as any;
	const deliver = stdin.simulateResponse.bind(stdin);
	const held: string[] = [];
	stdin.simulateResponse = (data: string): void => {
		if (/\x1b\[\d+;\d+R/.test(data)) {
			held.push(data);
			return;
		}
		deliver(data);
	};

	const sleep = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));
	const waitForQuery = async (): Promise<void> => {
		for (let waited = 0; held.length === 0 && waited < 2000; waited += 5) {
			await sleep(5);
		}
		expect(held.length).toBe(1);
	};

	terminal.resize(30, 20);
	(terminal as any).emit("SIGWINCH");
	await waitForQuery();

	// Nothing may paint while a resize settles, so this mutation is the proof
	// of whether a redraw happened: it reaches the screen only through one.
	dom.document.body.innerHTML += "<div>SENTINEL</div>";

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");
	const onScreen = (text: string): number => {
		let copies = 0;
		for (let i = 0; i < buffer.baseY + 20; i++) {
			if (line(i).includes(text)) {
				copies++;
			}
		}
		return copies;
	};

	// A second SIGWINCH, then the first resize's answer. The debounce has not
	// run out, so the second resize has issued no query of its own and this
	// reply is the only one outstanding.
	terminal.resize(24, 20);
	(terminal as any).emit("SIGWINCH");
	deliver(held.shift()!);
	await sleep(20);
	expect(onScreen("SENTINEL")).toBe(0);

	// The second resize's own query is what places the frame.
	await waitForQuery();
	deliver(held.shift()!);
	for (
		let waited = 0;
		onScreen("SENTINEL") === 0 && waited < 2000;
		waited += 25
	) {
		await sleep(25);
	}

	expect(onScreen("SENTINEL")).toBe(1);
	expect(onScreen("HEADER LINE")).toBe(1);
	expect(line(0)).toBe("PREV-A");
	expect(line(1)).toBe("PREV-B");

	dom.dispose();
});

test("matchMedia answers with the stylesheet evaluator and goes live on resize", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
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

test("a terminal resize fires a resize event at the window", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {window, document} = dom;

	document.body.innerHTML = "<div id=\"d\" style=\"width: 100%\">x</div>";
	await nextFrame(dom);

	const seen: any[] = [];
	window.addEventListener("resize", (event: any) => {
		seen.push({
			type: event.type,
			bubbles: event.bubbles,
			cancelable: event.cancelable,
			isWindow: event.target === window,
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			divWidth: document.getElementById("d")!.getBoundingClientRect().width,
		});
	});

	terminal.resize(50, 20);
	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 100));

	expect(seen).toEqual([
		{
			type: "resize",
			bubbles: false,
			cancelable: false,
			isWindow: true,
			innerWidth: 50,
			innerHeight: 20,
			divWidth: 50,
		},
	]);

	dom.dispose();
});

test("the resize event precedes MediaQueryList change, which already answers with the new size", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {window, document} = dom;

	const mql = window.matchMedia("(max-width: 60px)");
	expect(mql.matches).toBe(false);

	document.body.innerHTML = "<div>x</div>";
	await nextFrame(dom);

	const order: string[] = [];
	window.addEventListener("resize", () => {
		order.push(`resize matches=${mql.matches}`);
	});
	mql.addEventListener("change", (event: any) => {
		order.push(`change matches=${event.matches}`);
	});

	terminal.resize(50, 30);
	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 100));

	expect(order).toEqual(["resize matches=true", "change matches=true"]);

	dom.dispose();
});

test("every resize listener runs, onresize among them, until it is removed", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {window, document} = dom;

	document.body.innerHTML = "<div>x</div>";
	await nextFrame(dom);

	const calls: string[] = [];
	const first = () => calls.push(`first:${window.innerWidth}`);
	const second = () => calls.push(`second:${window.innerWidth}`);
	window.addEventListener("resize", first);
	window.addEventListener("resize", second);
	window.onresize = () => calls.push(`onresize:${window.innerWidth}`);

	terminal.resize(50, 30);
	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 100));
	expect(calls).toEqual(["first:50", "second:50", "onresize:50"]);

	window.removeEventListener("resize", first);
	window.onresize = null;
	calls.length = 0;

	terminal.resize(40, 30);
	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 100));
	expect(calls).toEqual(["second:40"]);
	expect(window.onresize).toBe(null);

	dom.dispose();
});

test("a SIGWINCH reporting the same size fires no resize event", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {window, document} = dom;

	document.body.innerHTML = "<div>x</div>";
	await nextFrame(dom);

	let count = 0;
	window.addEventListener("resize", () => count++);

	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 100));
	expect(count).toBe(0);

	terminal.resize(50, 30);
	(terminal as any).emit("SIGWINCH");
	await new Promise((r) => setTimeout(r, 100));
	expect(count).toBe(1);

	dom.dispose();
});

test("a burst of SIGWINCHes fires one resize event, at the size it settled on", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {window, document} = dom;

	document.body.innerHTML = "<div>x</div>";
	await nextFrame(dom);

	const widths: number[] = [];
	window.addEventListener("resize", () => widths.push(window.innerWidth));

	for (const cols of [90, 80, 70, 60]) {
		terminal.resize(cols, 30);
		(terminal as any).emit("SIGWINCH");
	}
	await new Promise((r) => setTimeout(r, 100));

	expect(widths).toEqual([60]);

	dom.dispose();
});

test("@media stylesheet rules re-evaluate when the terminal resizes", async () => {
	const terminal = new MockProcess({cols: 100, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {window, document} = dom;

	const style = document.createElement("style");
	style.textContent = "@media (max-width: 60px) { div { color: red; } }";
	document.head.appendChild(style);
	document.body.innerHTML = "<div id=\"d\">narrow-only</div>";
	await nextFrame(dom);
	const div = document.getElementById("d")!;
	expect(window.getComputedStyle(div).getPropertyValue("color")).not.toBe(
		"rgb(255, 0, 0)",
	);

	terminal.resize(50, 30);
	(terminal as any).emit("SIGWINCH");
	await nextFrame(dom);
	await new Promise((r) => setTimeout(r, 100));

	expect(window.getComputedStyle(div).getPropertyValue("color")).toBe(
		"rgb(255, 0, 0)",
	);

	dom.dispose();
});

test("cancelAnimationFrame actually cancels", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
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

test("a height shrink past the fit point repaints one whole frame", async () => {
	// When the new height cannot fit the frame below its anchor, the amount
	// the terminal scrolled is unrecoverable -- a same-cursor DSR reports the
	// frame did not move even when it did, and making room on top of that
	// mis-anchor strands a copy of the frame's own top rows (the duplicated
	// header the commit-editor showed on a vertical shrink). A focused field
	// is the load-bearing ingredient: it parks the cursor at the caret,
	// mid-frame, so the recovery answers a mid-frame row. The engine resolves
	// it by clearing the whole screen and painting from the top -- exactly one
	// frame, no fragment of the previous paint, at the cost of the output that
	// was above it.
	const terminal = new MockProcess({rows: 18, cols: 60});
	await new Promise<void>((resolve) => {
		terminal.stdout.write("~/proj % demo\r\n~ %\r\n", () => resolve());
	});
	const dom = new TermDOM({transport: terminal.sharedTransport});
	dom.document.body.innerHTML =
		"<div>HEADER-ROW</div>" +
		"<div>Subject <input id=\"s\"></div>" +
		Array.from({length: 10}, (_, i) => `<div>BODY-${i + 1}</div>`).join("");
	(dom.document.getElementById("s") as HTMLElement).focus();
	await nextFrame(dom);

	// 12 content rows anchored at row 2: the bottom sits on the last screen
	// row. Shrink so the frame no longer fits at its old anchor.
	terminal.resize(60, 13);
	(terminal as any).emit("SIGWINCH");

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");
	const visibleCopies = (text: string): number => {
		let copies = 0;
		for (let i = buffer.baseY; i < buffer.baseY + terminal.stdout.rows; i++) {
			if (line(i) === text) {
				copies++;
			}
		}
		return copies;
	};

	// The redraw arrives after the resize debounce plus a cursor-query round
	// trip, so poll for the settled screen rather than betting on a delay.
	const settled = () =>
		visibleCopies("HEADER-ROW") === 1 && visibleCopies("BODY-10") === 1;
	for (let waited = 0; !settled() && waited < 2000; waited += 50) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	// Exactly one copy of the frame's header, and the frame is complete: its
	// bottom row made it onto the screen. No stranded remnant of the previous
	// paint, which is the property the clear guarantees.
	expect(visibleCopies("HEADER-ROW")).toBe(1);
	expect(visibleCopies("BODY-10")).toBe(1);

	// The frame is at the top of the cleared screen.
	expect(line(buffer.baseY)).toBe("HEADER-ROW");

	dom.dispose();
});

test("scroll-transform frames match a full repaint exactly", async () => {
	// One-row camera moves ride the DECSTBM+DL/IL scroll transform (shifted
	// previous buffer, banded repaint); a multi-row jump takes the full diff.
	// Whatever path a frame takes, the screen must come out identical --
	// including the fixed bar, whose rows the transform must repaint at both
	// its real and its shifted position.
	const content =
		Array.from(
			{length: 60},
			(_, i) => `<div>line ${i} of the document</div>`,
		).join("") +
		"<div style=\"position:fixed;bottom:0;left:0;right:0;background-color:#333\">BAR</div>";

	const render = async (steps: number[]): Promise<string> => {
		const terminal = new MockProcess({cols: 40, rows: 10});
		const dom = new TermDOM({transport: terminal.transport});
		dom.attach();
		dom.document.body.innerHTML = content;
		await nextFrame(dom);
		for (const step of steps) {
			dom.window.scrollBy(0, step);
			await nextFrame(dom);
		}
		// Erased cells are spaces in default colors -- blank on any terminal.
		const text = terminal
			.getVisibleText()
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n");
		dom.dispose();
		return text;
	};

	const stepped = await render(Array(12).fill(1));
	const jumped = await render([12]);
	expect(stepped).toEqual(jumped);

	// And back up through the IL path.
	const upAndDown = await render([...Array(12).fill(1), ...Array(7).fill(-1)]);
	const direct = await render([5]);
	expect(upAndDown).toEqual(direct);
});

test("bounded-damage frames match a full repaint exactly", async () => {
	// Keystroke-shaped work: each step scrolls AND mutates -- a status-bar
	// percentage in fixed space, and a selected-class flip on a row. Bounded
	// damage rides the banded transform; the same operations done in one
	// jump take the full diff. The screens must be identical.
	const content =
		"<style>.row.selected { background-color: #264f78; color: #ffffff; }</style>" +
		Array.from(
			{length: 40},
			(_, i) => `<div class="row" id="r${i}">row ${i} content here</div>`,
		).join("") +
		"<div style=\"position:fixed;bottom:0;left:0;right:0;background-color:#333\">bar <span id=\"pct\">0%</span></div>";

	const render = async (steps: number): Promise<string> => {
		const terminal = new MockProcess({cols: 40, rows: 10});
		const dom = new TermDOM({transport: terminal.transport});
		dom.attach();
		dom.document.body.innerHTML = content;
		await nextFrame(dom);
		const doc = dom.document;
		if (steps === 1) {
			// One jump: scroll, select, and set the percentage in one frame.
			dom.window.scrollBy(0, 8);
			doc.getElementById("r10")!.classList.add("selected");
			doc.getElementById("pct")!.textContent = "80%";
			await nextFrame(dom);
		} else {
			for (let i = 0; i < 8; i++) {
				dom.window.scrollBy(0, 1);
				doc.querySelector(".row.selected")?.classList.remove("selected");
				doc.getElementById(`r${3 + i}`)!.classList.add("selected");
				doc.getElementById("pct")!.textContent = `${(i + 1) * 10}%`;
				await nextFrame(dom);
			}
			doc.querySelector(".row.selected")?.classList.remove("selected");
			doc.getElementById("r10")!.classList.add("selected");
			await nextFrame(dom);
		}
		const text = terminal
			.getVisibleText()
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n");
		dom.dispose();
		return text;
	};

	expect(await render(8)).toEqual(await render(1));
});
