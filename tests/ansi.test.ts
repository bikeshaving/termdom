import {describe, expect, test} from "@b9g/libuild/test";
import {
	Screen,
	type CellContext,
	type LineStyle,
} from "../src/internal/screen.js";
import {renderFrame, stripControlCodes} from "./test-utils.js";

describe("cells through the pen", () => {
	// The grid itself is interior; what a cell HOLDS is observable in the
	// emitted bytes, so its round trips are asserted there.
	test("a multi-code-point grapheme survives to the output whole", () => {
		const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
		const renderer = new Screen(1, 8);
		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawText(family, 0, 0);
			ctx.drawText("é", 2, 0);
			ctx.drawText("\u{1f1ef}\u{1f1f5}", 3, 0);
			ctx.drawText("日", 5, 0);
		});

		expect(output).toContain(family);
		expect(output).toContain("é");
		expect(output).toContain("\u{1f1ef}\u{1f1f5}");
		expect(output).toContain("日");
	});

	test("measureText and the layout agree on widths", () => {
		const renderer = new Screen(1, 10);
		const context = renderer.beginFrame({offset: 0});
		expect(
			context.measureText("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}")
				.width,
		).toBe(2);
		expect(context.measureText("é").width).toBe(1);
		expect(context.measureText("\u{1f1ef}\u{1f1f5}").width).toBe(2);
		expect(context.measureText("日本").width).toBe(4);
	});
});

describe("Screen", () => {
	describe("initialization", () => {
		test("creates renderer with specified dimensions", () => {
			const renderer = new Screen(5, 10);

			// Test basic drawing functionality
			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("X", 0, 0);
			});

			expect(output).toContain("X");
		});

		test("handles color depth settings", () => {
			const renderer = new Screen(5, 10, "ansi");

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("X", 0, 0, {fg: 0xff0000});
			});

			// Should contain ANSI color codes for red
			expect(output).toContain("\x1b[31m");
		});
	});

	describe("drawing operations", () => {
		test("drawText draws text at position", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("Hello", 1, 2);
			});

			expect(output).toContain("Hello");
		});

		test("drawRect fills rectangular area", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawRect(0, 0, 3, 2, 0xff0000);
			});

			// Should contain background color ANSI codes
			expect(output).toContain("\x1b[48;2;255;0;0m");
		});

		test("handles viewport offset", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 2}, (ctx) => {
				ctx.drawText("Test", 0, 0);
			});

			// Should contain cursor positioning for offset
			expect(output).toContain("\x1b[3;1H"); // Row 3 (offset 2 + 1 for 1-based)
		});
	});

	describe("frame management", () => {
		test("generates proper ANSI framing", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("Test", 0, 0);
			});

			// Should hide cursor and enable sync mode. The cursor stays hidden
			// between frames -- it is parked for resize bookkeeping, not UI --
			// and dispose() is what shows it again on the way out.
			expect(output).toContain("\x1b[?25l"); // Hide cursor
			expect(output).toContain("\x1b[?2026h"); // Sync mode start
			expect(output).not.toContain("\x1b[?25h"); // Cursor stays hidden
			expect(output).toContain("\x1b[?2026l"); // Sync mode end
		});

		test("clears previous buffer", () => {
			const renderer = new Screen(5, 10);

			// First frame
			renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("First", 0, 0);
			});

			renderer.repaintAll();

			// Second frame should render everything (no diff)
			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("Second", 0, 0);
			});

			expect(output).toContain("Second");
		});
	});

	describe("viewport and scrolling", () => {
		// Offset changes are rendered by repainting cells. SU/SD move the whole
		// terminal screen -- they would drag a shell prompt above the region
		// through the frame, and SU commits rows to the scrollback, which
		// document mode promises never to do.
		test("increasing the offset repaints; it never emits SU", () => {
			const renderer = new Screen(10, 40);

			renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("Initial", 0, 0);
			});

			const output = renderFrame(renderer, {offset: 3}, (ctx) => {
				ctx.drawText("Scrolled", 0, 0);
			});

			expect(output).not.toContain("\x1b[3S");
			expect(output).toContain("Scrolled"); // painted at the new offset
			expect(output).toContain("       "); // old row blanked by the diff
		});

		test("decreasing the offset repaints; it never emits SD", () => {
			const renderer = new Screen(10, 40);

			renderFrame(renderer, {offset: 3}, (ctx) => {
				ctx.drawText("Initial", 0, 0);
			});

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("Scrolled", 0, 0);
			});

			expect(output).not.toContain("\x1b[3T");
			expect(output).toContain("Scrolled");
			expect(output).toContain("       ");
		});

		test("no scroll command when offset unchanged", () => {
			const renderer = new Screen(10, 40);

			// Frame 1
			renderFrame(renderer, {offset: 2}, (ctx) => {
				ctx.drawText("Frame1", 0, 0);
			});

			// Frame 2 with same offset
			const output = renderFrame(renderer, {offset: 2}, (ctx) => {
				ctx.drawText("Frame2", 0, 1);
			});

			expect(output).not.toContain("S");
			expect(output).not.toContain("T");
		});
	});

	describe("content optimization", () => {
		test("generates empty output when no content", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (_ctx) => {
				// No drawing operations
			});

			expect(output).toBe("");
		});

		test("only outputs changed cells between frames", () => {
			const renderer = new Screen(5, 10);

			// First frame
			renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("Hello", 0, 0);
				ctx.drawText("World", 1, 0);
			});

			// Second frame - only change second line
			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("Hello", 0, 0); // Same
				ctx.drawText("Test", 1, 0); // Changed
			});

			// Should contain new content but not duplicate unchanged content
			expect(output).toContain("Test");
			// First line should not be re-rendered (no Hello in diff)
			expect(output).not.toContain("Hello");
		});
	});
});

describe("glyphs where lines meet", () => {
	// A cell's four stroke slots say which way a line LEAVES it -- which is
	// what a box-drawing glyph actually encodes. They used to mean "which
	// edge of a box this cell sits on": a reading that is self-contradictory
	// (a line running up, down and left cannot point right) and that broke
	// as soon as two boxes shared a cell -- a collapsed table's colspan
	// boundary merged a horizontal run with two downward corners and drew ┼
	// where ┬ belongs. The half-stroke line ends are the honest model, and
	// these read the glyphs straight off emitted frames.
	const solid: LineStyle = {style: "solid"};

	function glyphs(
		rows: number,
		cols: number,
		draw: (ctx: CellContext) => void,
	): string {
		const renderer = new Screen(rows, cols);
		return stripControlCodes(renderFrame(renderer, {offset: 0}, draw));
	}

	test("two lines turning in a cell make its corner", () => {
		const output = glyphs(3, 6, (ctx) => {
			ctx.drawBox(0, 0, 3, 3, {
				top: solid,
				right: solid,
				bottom: solid,
				left: solid,
			});
		});
		expect(output).toContain("┌─┐");
		expect(output).toContain("└─┘");
	});

	test("a line ending on another's run makes the tee", () => {
		const output = glyphs(3, 8, (ctx) => {
			ctx.drawLine(0, 0, 0, 3, solid); // a wall
			ctx.drawLine(0, 1, 4, 1, solid); // a rule leaving it rightward
		});
		expect(output).toContain("├───");
		const inverted = glyphs(3, 8, (ctx) => {
			ctx.drawLine(4, 0, 4, 3, solid);
			ctx.drawLine(0, 1, 5, 1, solid);
		});
		expect(inverted).toContain("───┤");
		const down = glyphs(3, 8, (ctx) => {
			ctx.drawLine(0, 0, 5, 0, solid);
			ctx.drawLine(2, 0, 2, 3, solid);
		});
		expect(down).toContain("─┬─");
		expect(down).not.toContain("┼");
	});

	test("two lines crossing make the cross", () => {
		const output = glyphs(3, 6, (ctx) => {
			ctx.drawLine(0, 1, 5, 1, solid);
			ctx.drawLine(2, 0, 2, 3, solid);
		});
		expect(output).toContain("─┼─");
	});

	test("a line is its line, and its ends still draw", () => {
		const output = glyphs(2, 6, (ctx) => {
			ctx.drawLine(0, 0, 2, 0, solid);
			ctx.drawLine(4, 0, 4, 2, solid);
		});
		expect(output).toContain("──");
		expect(output).toContain("│");
	});

	test("the style is the line's", () => {
		const output = glyphs(2, 8, (ctx) => {
			ctx.drawLine(0, 0, 3, 0, {style: "double"});
			ctx.drawLine(4, 0, 7, 0, {style: "dashed"});
		});
		expect(output).toContain("═");
		expect(output).toContain("╌");
	});

	test("a round cap bends the corner, not the run", () => {
		const output = glyphs(3, 6, (ctx) => {
			ctx.drawLine(0, 0, 3, 0, {style: "solid", startCap: "round"});
			ctx.drawLine(0, 0, 0, 3, {style: "solid", startCap: "round"});
		});
		expect(output).toContain("╭──");

		// The dashes are the border style's; only the turn bends.
		const dashed = glyphs(3, 6, (ctx) => {
			ctx.drawLine(0, 0, 3, 0, {style: "dashed", endCap: "round"});
			ctx.drawLine(2, 0, 2, 3, {style: "dashed", startCap: "round"});
		});
		expect(dashed).toContain("╮");

		// Unicode draws no rounded double corner, so the radius cannot
		// reach one.
		const double = glyphs(3, 6, (ctx) => {
			ctx.drawLine(0, 2, 3, 2, {style: "double", startCap: "round"});
			ctx.drawLine(0, 0, 0, 3, {style: "double", endCap: "round"});
		});
		expect(double).toContain("╚══");
	});
});

describe("Border Drawing", () => {
	describe("drawBorder method", () => {
		test("draws simple rectangle border", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawBox(1, 1, 4, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
			});

			// Should contain complete box border pattern
			expect(output).toContain("┌──┐"); // top border with corners
			expect(output).toContain("└──┘"); // bottom border with corners
			expect(output).toContain("│"); // vertical sides
		});

		test("draws partial borders", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawBox(1, 1, 4, 3, {
					top: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
			});

			// Should have partial borders (no right edge)
			expect(output).toContain("┌──"); // top-left with horizontal line but no right corner
			expect(output).toContain("└──"); // bottom-left with horizontal line but no right corner
			expect(output).not.toContain("┐"); // no top-right corner
			expect(output).not.toContain("┘"); // no bottom-right corner
		});

		test("handles border merging at intersections", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				// Draw two overlapping rectangles to create border intersections
				ctx.drawBox(1, 1, 4, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});

				ctx.drawBox(2, 0, 4, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
			});

			// Should contain overlapping border patterns with intersections
			expect(output).toMatch(/[┌┐└┘├┤┬┴┼]/); // Junction characters from overlapping borders
			expect(output).toContain("─"); // Horizontal border segments
			expect(output).toContain("│"); // Vertical border segments
		});

		test("weaves junctions where separate borders touch", () => {
			const renderer = new Screen(6, 12);

			// A page box, and a rule running wall to wall inside it -- a
			// masthead's border-bottom. The rule's ends reach the cells of the
			// page's verticals, which take the connecting stub: ├ and ┤, as a
			// browser's touching one-pixel lines would draw.
			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawBox(0, 0, 10, 5, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
				ctx.drawBox(1, 2, 8, 1, {top: {style: "solid"}});
			});

			expect(output).toContain("├────────┤");
		});

		test("boxes that sit flush stay separate", () => {
			const renderer = new Screen(4, 12);

			// Two bordered siblings side by side: their verticals touch as
			// parallel strokes, which meet nothing head-on. No junction forms
			// -- the seam stays ┐┌, the way two browser boxes stay two boxes.
			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawBox(0, 0, 4, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
				ctx.drawBox(4, 0, 4, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
			});

			expect(output).toContain("┐┌");
			expect(output).toContain("┘└");
			expect(output).not.toMatch(/[┬┴┼]/);
		});

		test("respects viewport offset", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 2}, (ctx) => {
				ctx.drawBox(0, 0, 3, 2, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
			});

			// Should position cursor accounting for viewport offset
			expect(output).toContain("\x1b[3;1H"); // Row 3 (offset 2 + 1)
			expect(output).toContain("┌─┐"); // Top border pattern at offset position
		});

		test("handles different border styles", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawBox(1, 1, 4, 3, {
					top: {style: "double"},
					right: {style: "double"},
					bottom: {style: "double"},
					left: {style: "double"},
				});
			});

			// Should contain complete double-line border pattern
			expect(output).toContain("╔══╗"); // double top border
			expect(output).toContain("╚══╝"); // double bottom border
			expect(output).toContain("║"); // double vertical sides
		});

		test("no sides given draws nothing", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawBox(1, 1, 4, 3, {});
			});

			// Should not contain any border patterns
			expect(output).not.toMatch(/[┌┐└┘├┤┬┴┼─│═║╔╗╚╝]/); // No box drawing characters at all
		});

		test("handles border colors and styles", () => {
			const renderer = new Screen(5, 10);

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawBox(1, 1, 4, 3, {
					top: {style: "solid", color: 0xff0000},
					right: {style: "solid", color: 0xff0000},
					bottom: {style: "solid", color: 0xff0000},
					left: {style: "solid", color: 0xff0000},
				});
			});

			// The side's color is the line's; a border takes no text styling.
			expect(output).toContain("\x1b[38;2;255;0;0m┌");
			expect(output).not.toContain(";1m");
		});

		test("clips borders to viewport bounds", () => {
			const renderer = new Screen(3, 5); // Small viewport

			const output = renderFrame(renderer, {offset: 0}, (ctx) => {
				// Draw border that extends beyond viewport
				ctx.drawBox(0, 0, 10, 10, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
			});

			// Should only render visible border portions without crashing
			expect(output).toContain("┌────"); // Top-left and horizontal line should be visible
			expect(output).toContain("│"); // Left vertical should be visible
			// Border extends beyond viewport but renderer handles clipping gracefully
		});
	});
});

describe("Border Integration", () => {
	test("renders complete border box without styles", () => {
		const renderer = new Screen(4, 8);

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawBox(1, 0, 6, 4, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});
			// Fill inside to ensure proper spacing
			ctx.drawText("    ", 2, 1);
			ctx.drawText("    ", 2, 2);
		});

		// Strip control codes but keep ANSI colors for testing
		const cleanOutput = stripControlCodes(output);
		// We should see the border box pattern
		expect(cleanOutput).toContain("┌────┐");
		expect(cleanOutput).toContain("│    │");
		expect(cleanOutput).toContain("└────┘");
	});

	test("renders borders with text content", () => {
		const renderer = new Screen(5, 10);

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Draw border
			ctx.drawBox(1, 1, 6, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Add text inside border
			ctx.drawText("Hi", 2, 2);
		});

		expect(output).toContain("┌────┐"); // Complete top border
		expect(output).toContain("Hi"); // Text content inside border
		expect(output).toContain("└────┘"); // Complete bottom border
	});

	test("borders work with drawRect backgrounds", () => {
		const renderer = new Screen(5, 10);

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Fill background
			ctx.drawRect(1, 1, 4, 3, 0x00ff00);

			// Draw border on top
			ctx.drawBox(1, 1, 4, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});
		});

		expect(output).toContain("48;2;0;255;0"); // Green background color
		expect(output).toContain("┌──┐"); // Border corners with background
	});

	test("renders double border box without styles", () => {
		const renderer = new Screen(5, 7);

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawBox(0, 0, 5, 4, {
				top: {style: "double"},
				right: {style: "double"},
				bottom: {style: "double"},
				left: {style: "double"},
			});
		});

		// Check that double-line border characters are present
		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toContain("╔═══╗");
		expect(cleanOutput).toContain("║");
		expect(cleanOutput).toContain("╚═══╝");
	});

	test("renders partial border without right edge", () => {
		const renderer = new Screen(5, 8);

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawBox(0, 0, 6, 4, {
				top: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});
		});

		// Check for partial border patterns
		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toContain("┌─────"); // Top left with horizontal line
		expect(cleanOutput).toContain("│"); // Left vertical
		expect(cleanOutput).toContain("└─────"); // Bottom left with horizontal line
		expect(cleanOutput).not.toContain("┐"); // No top-right corner
		expect(cleanOutput).not.toContain("┘"); // No bottom-right corner
	});

	test("renders text with no ANSI color styles", () => {
		const renderer = new Screen(3, 10);

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawText("Hello", 0, 0);
			ctx.drawText("World", 0, 1);
			ctx.drawText("Test", 0, 2);
		});

		// Strip control codes but keep ANSI colors for testing
		const cleanOutput = stripControlCodes(output);
		// The renderer optimizes output with cursor movements, so we check contains
		expect(cleanOutput).toContain("Hello");
		expect(cleanOutput).toContain("World");
		expect(cleanOutput).toContain("Test");

		// Verify no color codes are present
		expect(output).not.toContain("38;"); // No foreground colors
		expect(output).not.toContain("48;"); // No background colors
		expect(output).not.toContain("1m"); // No bold
		expect(output).not.toContain("3m"); // No italic
	});

	test("renders overlapping borders", () => {
		const renderer = new Screen(6, 10);

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// First box
			ctx.drawBox(0, 0, 5, 4, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Second box overlapping
			ctx.drawBox(2, 2, 5, 4, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});
		});

		// Check for all border characters
		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toContain("┌"); // Top-left corners
		expect(cleanOutput).toContain("┐"); // Top-right corners
		expect(cleanOutput).toContain("└"); // Bottom-left corners
		expect(cleanOutput).toContain("┘"); // Bottom-right corners
		// The overlapping creates a pattern with multiple boxes
		expect(cleanOutput).toContain("│"); // Vertical lines
		expect(cleanOutput).toContain("─"); // Horizontal lines
	});

	test("renders simple border pattern", () => {
		const renderer = new Screen(5, 10);

		// Clear previous buffer to ensure output
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Draw a simple box that fits in viewport
			ctx.drawBox(1, 1, 3, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});
		});

		// Should have border output
		const cleanOutput = stripControlCodes(output);

		// Should see border characters
		expect(output.length).toBeGreaterThan(0); // Should have some output
		expect(cleanOutput).toContain("┌"); // Top-left
		expect(cleanOutput).toContain("┐"); // Top-right
		expect(cleanOutput).toContain("└"); // Bottom-left
		expect(cleanOutput).toContain("┘"); // Bottom-right
	});

	test("renders exact multi-line text output", () => {
		const renderer = new Screen(4, 12);

		// First render to establish baseline
		renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawText("Line 1", 0, 0);
			ctx.drawText("Line 2", 0, 1);
			ctx.drawText("Line 3", 0, 2);
			ctx.drawText("Line 4", 0, 3);
		});

		// Second render with minimal changes
		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawText("Line 1", 0, 0);
			ctx.drawText("Line TWO", 0, 1); // Changed
			ctx.drawText("Line 3", 0, 2);
			ctx.drawText("Line 4", 0, 3);
		});

		// The renderer optimizes by only updating changed content
		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toContain("TWO"); // Changed part
		expect(cleanOutput).not.toContain("Line 1"); // Unchanged
		expect(cleanOutput).not.toContain("Line 3"); // Unchanged
		expect(cleanOutput).not.toContain("Line 4"); // Unchanged
	});

	test("renders box with text inside - full output", () => {
		const renderer = new Screen(5, 8);

		// Clear any previous state
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Draw box
			ctx.drawBox(0, 0, 8, 5, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});
			// Add text inside
			ctx.drawText(" TEST ", 1, 1);
			ctx.drawText(" BOX  ", 1, 2);
			ctx.drawText(" HERE ", 1, 3);
		});

		// Check that we have a complete box with text
		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toContain("┌──────┐");
		expect(cleanOutput).toContain("│ TEST │");
		expect(cleanOutput).toContain("│ BOX  │");
		expect(cleanOutput).toContain("│ HERE │");
		expect(cleanOutput).toContain("└──────┘");
	});

	test("renders collapsed table borders - 2x2 grid", () => {
		const renderer = new Screen(5, 9);

		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Simulate CSS collapsed table borders by drawing each cell's borders
			// This should create proper junctions where borders meet

			// Cell (0,0) - top-left
			ctx.drawBox(0, 0, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Cell (0,1) - top-right
			ctx.drawBox(4, 0, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Cell (1,0) - bottom-left
			ctx.drawBox(0, 2, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Cell (1,1) - bottom-right
			ctx.drawBox(4, 2, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Add cell content
			ctx.drawText("A1", 1, 1);
			ctx.drawText("B1", 5, 1);
			ctx.drawText("A2", 1, 3);
			ctx.drawText("B2", 5, 3);
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders collapsed table borders - mixed border styles", () => {
		const renderer = new Screen(3, 11);

		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Test border merging with different styles
			// Left cell with solid borders
			ctx.drawBox(0, 0, 6, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Right cell with double borders (should merge with solid)
			ctx.drawBox(5, 0, 6, 3, {
				top: {style: "double"},
				right: {style: "double"},
				bottom: {style: "double"},
				left: {style: "double"},
			});

			// Add content to differentiate the cells
			ctx.drawText("Sol", 1, 1);
			ctx.drawText("Dbl", 6, 1);
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders collapsed table borders - header and data rows", () => {
		const renderer = new Screen(5, 13); // 3 columns x 4 chars + 1 = 13 width

		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Simulate a typical HTML table with header and data rows
			// For collapsed borders, cells share borders at their edges

			// Header row cells (row 0-2)
			ctx.drawBox(0, 0, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			ctx.drawBox(4, 0, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			ctx.drawBox(8, 0, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Data row cells (row 2-4, sharing top border with header cells)
			ctx.drawBox(0, 2, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			ctx.drawBox(4, 2, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			ctx.drawBox(8, 2, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Cell content - placed inside the cells (max 3 chars per cell)
			ctx.drawText("Nam", 1, 1);
			ctx.drawText("Age", 5, 1);
			ctx.drawText("Cty", 9, 1);
			ctx.drawText("Jon", 1, 3);
			ctx.drawText("25", 5, 3);
			ctx.drawText("NYC", 9, 3);
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders simple single cell with border", () => {
		const renderer = new Screen(4, 6);
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawBox(1, 1, 4, 2, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders double border box", () => {
		const renderer = new Screen(5, 8);
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawBox(1, 1, 6, 3, {
				top: {style: "double"},
				right: {style: "double"},
				bottom: {style: "double"},
				left: {style: "double"},
			});
			ctx.drawText("Test", 2, 2);
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders partial borders - top and left only", () => {
		const renderer = new Screen(4, 6);
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawBox(0, 0, 5, 3, {
				top: {style: "solid"},
				left: {style: "solid"},
			});
			ctx.drawText("Part", 1, 1);
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("a left-only border spans the full box height", () => {
		// No top or bottom edge means no corner cells -- the vertical run owns
		// the end rows too. Skipping them is what cut a blockquote's border
		// off at its first and last row.
		const renderer = new Screen(5, 8);
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawBox(0, 0, 6, 4, {left: {style: "solid"}});
			ctx.drawText("Quote", 2, 1);
		});

		// includes, not startsWith: the reset frame's erase sequence survives
		// stripControlCodes on the first row.
		const rows = stripControlCodes(output)
			.split("\n")
			.map((l) => l.trimEnd());
		const barRows = rows.filter((l) => l.includes("│")).length;
		expect(barRows).toBe(4);
	});

	test("renders L-shaped table border pattern", () => {
		const renderer = new Screen(4, 7);
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Top row - 2 cells
			ctx.drawBox(0, 0, 4, 2, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			ctx.drawBox(3, 0, 4, 2, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Bottom left cell only
			ctx.drawBox(0, 1, 4, 2, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders mixed border styles in adjacent cells", () => {
		const renderer = new Screen(3, 9);
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Solid border cell
			ctx.drawBox(0, 0, 3, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			// Double border cell
			ctx.drawBox(2, 0, 3, 3, {
				top: {style: "double"},
				right: {style: "double"},
				bottom: {style: "double"},
				left: {style: "double"},
			});

			// Heavy border cell
			ctx.drawBox(4, 0, 3, 3, {
				top: {style: "groove"},
				right: {style: "groove"},
				bottom: {style: "groove"},
				left: {style: "groove"},
			});

			ctx.drawText("S", 1, 1);
			ctx.drawText("D", 3, 1);
			ctx.drawText("H", 5, 1);
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders nested borders", () => {
		const renderer = new Screen(7, 11); // Wider to accommodate text
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Outer border
			ctx.drawBox(0, 0, 9, 7, {
				top: {style: "double"},
				right: {style: "double"},
				bottom: {style: "double"},
				left: {style: "double"},
			});

			// Inner border
			ctx.drawBox(2, 2, 5, 3, {
				top: {style: "solid"},
				right: {style: "solid"},
				bottom: {style: "solid"},
				left: {style: "solid"},
			});

			ctx.drawText("Out", 1, 1);
			ctx.drawText("In", 3, 3);
			ctx.drawText("Out", 5, 5); // Moved left by 2 to avoid overlap
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders grid layout - 3x3 table", () => {
		const renderer = new Screen(7, 11);
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			// Draw 3x3 grid of cells
			for (let row = 0; row < 3; row++) {
				for (let col = 0; col < 3; col++) {
					const x = col * 3;
					const y = row * 2;

					ctx.drawBox(x, y, 4, 3, {
						top: {style: "solid"},
						right: {style: "solid"},
						bottom: {style: "solid"},
						left: {style: "solid"},
					});

					ctx.drawText(`${row + 1}${col + 1}`, x + 1, y + 1);
				}
			}
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders borders with background colors", () => {
		const renderer = new Screen(3, 7);
		renderer.repaintAll();

		const output = renderFrame(renderer, {offset: 0}, (ctx) => {
			ctx.drawRect(1, 0, 5, 3, 0x00ff00);
			ctx.drawBox(1, 0, 5, 3, {
				top: {style: "solid", color: 0xff0000},
				right: {style: "solid", color: 0xff0000},
				bottom: {style: "solid", color: 0xff0000},
				left: {style: "solid", color: 0xff0000},
			});

			ctx.drawText("Col", 2, 1);
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});
});
