import {describe, expect, test} from "bun:test";
import {
	Cell,
	type CellStyle,
	createBuffer,
	generateANSI,
	getBorderChar,
	mergeBorderEncodings,
	Renderer,
} from "../src/ansi.js";
import {BorderEdgeStyle} from "../src/styles.js";
import {stripControlCodes} from "./test-utils.js";

describe("Cell", () => {
	describe("constructor", () => {
		test("throws on empty grapheme", () => {
			expect(() => new Cell("")).toThrow(
				"Cell grapheme cannot be empty. Use null instead.",
			);
		});

		test("creates cell with character", () => {
			const cell = new Cell("A");

			expect(cell.grapheme).toBe("A");
			expect(cell.getFgColor()).toBe(0);
			expect(cell.getBgColor()).toBe(0);
			const flags = cell.getStyleFlags();
			expect(flags.bold).toBe(false);
			expect(flags.italic).toBe(false);
			expect(flags.underline).toBe(false);
			expect(flags.strikethrough).toBe(false);
			expect(flags.inverse).toBe(false);
			expect(flags.blink).toBe(false);
			expect(flags.dim).toBe(false);
			expect(flags.overline).toBe(false);
		});

		test("creates cell with character and style", () => {
			const style: CellStyle = {
				fg: 0xff0000,
				bg: 0x00ff00,
				bold: true,
				italic: true,
			};
			const cell = new Cell({grapheme: "A", ...style});

			expect(cell.grapheme).toBe("A");
			expect(cell.getFgColor()).toBe(0xff0000);
			expect(cell.getBgColor()).toBe(0x00ff00);

			const flags = cell.getStyleFlags();
			expect(flags.bold).toBe(true);
			expect(flags.italic).toBe(true);
			expect(flags.underline).toBe(false);
			expect(flags.strikethrough).toBe(false);
			expect(flags.inverse).toBe(false);
			expect(flags.blink).toBe(false);
			expect(flags.dim).toBe(false);
			expect(flags.overline).toBe(false);
		});
	});

	describe("Cell.create", () => {
		test("returns null for empty string", () => {
			const cell = Cell.create("");
			expect(cell).toBeNull();
		});

		test("caches cells with same properties", () => {
			const style: CellStyle = {
				grapheme: "A",
				fg: 0xff0000,
				bold: true,
			};

			const cell1 = Cell.create(style);
			const cell2 = Cell.create(style);

			expect(cell1).toBe(cell2); // Same reference due to caching
		});
	});

	describe("methods", () => {
		test("equals compares all properties", () => {
			const cell1 = new Cell({grapheme: "A", fg: 0xff0000, bold: true});
			const cell2 = new Cell({grapheme: "A", fg: 0xff0000, bold: true});
			const cell3 = new Cell({grapheme: "B", fg: 0xff0000, bold: true});

			expect(cell1.equals(cell2)).toBe(true);
			expect(cell1.equals(cell3)).toBe(false);
		});

		test("styleEquals compares style properties only", () => {
			const cell1 = new Cell({grapheme: "A", fg: 0xff0000, bold: true});
			const cell2 = new Cell({grapheme: "B", fg: 0xff0000, bold: true});
			const cell3 = new Cell({grapheme: "A", fg: 0x00ff00, bold: true});

			expect(cell1.styleEquals(cell2)).toBe(true);
			expect(cell1.styleEquals(cell3)).toBe(false);
		});

		test("width returns correct character width", () => {
			const normal = new Cell("A");
			const emoji = new Cell("👍");

			expect(normal.width).toBe(1);
			expect(emoji.width).toBe(2);
		});

		test("isWide identifies wide characters", () => {
			const normal = new Cell("A");
			const emoji = new Cell("👍");

			expect(normal.isWide).toBe(false);
			expect(emoji.isWide).toBe(true);
		});
	});
});

describe("createBuffer", () => {
	test("creates buffer with specified dimensions", () => {
		const buffer = createBuffer(3, 5);

		expect(buffer.length).toBe(3);
		expect(buffer[0].length).toBe(5);
		expect(buffer[1].length).toBe(5);
		expect(buffer[2].length).toBe(5);

		// All cells should be null initially
		for (let row = 0; row < 3; row++) {
			for (let col = 0; col < 5; col++) {
				expect(buffer[row][col]).toBeNull();
			}
		}
	});

	test("creates empty buffer for zero dimensions", () => {
		const empty = createBuffer(0, 0);
		expect(empty.length).toBe(0);
	});
});

describe("Renderer with callback API", () => {
	describe("initialization", () => {
		test("creates renderer with specified dimensions", () => {
			const renderer = new Renderer(5, 10);

			// Test basic drawing functionality
			const output = renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "X");
			});

			expect(output).toContain("X");
		});

		test("handles color depth settings", () => {
			const renderer = new Renderer(5, 10, "ansi");

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "X", {fg: 0xff0000});
			});

			// Should contain ANSI color codes for red
			expect(output).toContain("\x1b[31m");
		});
	});

	describe("drawing operations", () => {
		test("setText draws text at position", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.setText(1, 2, "Hello");
			});

			expect(output).toContain("Hello");
		});

		test("fillRect fills rectangular area", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.fillRect(0, 0, 3, 2, 0xff0000);
			});

			// Should contain background color ANSI codes
			expect(output).toContain("\x1b[48;2;255;0;0m");
		});

		test("handles viewport offset", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(2, (ctx) => {
				ctx.setText(0, 0, "Test");
			});

			// Should contain cursor positioning for offset
			expect(output).toContain("\x1b[3;1H"); // Row 3 (offset 2 + 1 for 1-based)
		});
	});

	describe("frame management", () => {
		test("generates proper ANSI framing", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "Test");
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
			const renderer = new Renderer(5, 10);

			// First frame
			renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "First");
			});

			renderer.clearPreviousBuffer();

			// Second frame should render everything (no diff)
			const output = renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "Second");
			});

			expect(output).toContain("Second");
		});
	});

	describe("viewport and scrolling", () => {
		test("generates scroll down command for positive viewport offset", () => {
			const renderer = new Renderer(10, 40);

			// Frame 1: Initial content at offset 0
			renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "Initial");
			});

			// Frame 2: Move to offset 3 (scroll down 3 lines)
			const output = renderer.renderFrame(3, (ctx) => {
				ctx.setText(0, 0, "Scrolled");
			});

			expect(output).toContain("\x1b[3S"); // Scroll up 3 lines
		});

		test("generates scroll up command for negative viewport offset", () => {
			const renderer = new Renderer(10, 40);

			// Frame 1: Initial content at offset 3
			renderer.renderFrame(3, (ctx) => {
				ctx.setText(0, 0, "Initial");
			});

			// Frame 2: Move to offset 0 (scroll up 3 lines)
			const output = renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "Scrolled");
			});

			expect(output).toContain("\x1b[3T"); // Scroll down 3 lines
		});

		test("no scroll command when offset unchanged", () => {
			const renderer = new Renderer(10, 40);

			// Frame 1
			renderer.renderFrame(2, (ctx) => {
				ctx.setText(0, 0, "Frame1");
			});

			// Frame 2 with same offset
			const output = renderer.renderFrame(2, (ctx) => {
				ctx.setText(0, 1, "Frame2");
			});

			expect(output).not.toContain("S");
			expect(output).not.toContain("T");
		});
	});

	describe("content optimization", () => {
		test("generates empty output when no content", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (_ctx) => {
				// No drawing operations
			});

			expect(output).toBe("");
		});

		test("only outputs changed cells between frames", () => {
			const renderer = new Renderer(5, 10);

			// First frame
			renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "Hello");
				ctx.setText(1, 0, "World");
			});

			// Second frame - only change second line
			const output = renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "Hello"); // Same
				ctx.setText(1, 0, "Test"); // Changed
			});

			// Should contain new content but not duplicate unchanged content
			expect(output).toContain("Test");
			// First line should not be re-rendered (no Hello in diff)
			expect(output).not.toContain("Hello");
		});
	});
});

describe("generateANSI", () => {
	test("generates empty output for empty buffer", () => {
		const buffer = createBuffer(3, 5);
		const output = generateANSI(buffer);

		expect(output).toBe("");
	});

	test("generates ANSI for simple text", () => {
		const buffer = createBuffer(2, 5);
		buffer[0][0] = new Cell("H");
		buffer[0][1] = new Cell("i");

		const output = generateANSI(buffer);

		expect(output).toContain("Hi");
		expect(output).toContain("\r\n"); // Line ending
	});

	test("generates color codes", () => {
		const buffer = createBuffer(1, 1);
		buffer[0][0] = new Cell({
			grapheme: "X",
			fg: 0xff0000,
			bg: 0x00ff00,
		});

		const output = generateANSI(buffer);

		expect(output).toContain("38;2;255;0;0"); // Red foreground
		expect(output).toContain("48;2;0;255;0"); // Green background
		expect(output).toContain("X");
		expect(output).toContain("\x1b[0m"); // Reset
	});

	test("handles wide characters", () => {
		const buffer = createBuffer(1, 3);
		buffer[0][0] = new Cell("👍"); // 2-width emoji
		buffer[0][2] = new Cell("A"); // Normal char after emoji

		const output = generateANSI(buffer);

		expect(output).toContain("👍");
		expect(output).toContain("A");
	});
});

describe("Border Functions", () => {
	describe("getBorderChar", () => {
		test("returns space for no borders", () => {
			const char = getBorderChar(0);
			expect(char).toBe(" ");
		});

		// The four bits say which way a line LEAVES the cell -- up, right, down,
		// left -- which is what a box-drawing glyph actually encodes.
		//
		// They used to mean "which edge of a box this cell sits on", and these
		// tests asserted that: a lone `top` bit rendered a horizontal line, and
		// top+bottom+left rendered ├. That reading is self-contradictory (a line
		// running up, down and left cannot point right), and it only survived
		// because for a single box the two happen to coincide. It broke as soon
		// as two boxes shared a cell: a collapsed table's colspan boundary merged
		// a horizontal run with two downward corners and produced ┼ instead of ┬.
		const UP = BorderEdgeStyle.Solid << 0;
		const RIGHT = BorderEdgeStyle.Solid << 8;
		const DOWN = BorderEdgeStyle.Solid << 16;
		const LEFT = BorderEdgeStyle.Solid << 24;

		test("generates corner characters", () => {
			// ┌ turns from rightward to downward.
			expect(getBorderChar(RIGHT | DOWN)).toBe("┌");
			// ┐ arrives from the left and turns down.
			expect(getBorderChar(LEFT | DOWN)).toBe("┐");
			// └ comes up and turns right.
			expect(getBorderChar(UP | RIGHT)).toBe("└");
			// ┘ comes up and turns left.
			expect(getBorderChar(UP | LEFT)).toBe("┘");
		});

		test("generates T-junction characters", () => {
			// A tee points the way the fourth arm is missing.
			expect(getBorderChar(LEFT | RIGHT | DOWN)).toBe("┬");
			expect(getBorderChar(LEFT | RIGHT | UP)).toBe("┴");
			expect(getBorderChar(UP | DOWN | RIGHT)).toBe("├");
			expect(getBorderChar(UP | DOWN | LEFT)).toBe("┤");
		});

		test("generates cross junction", () => {
			expect(getBorderChar(UP | RIGHT | DOWN | LEFT)).toBe("┼");
		});

		test("generates straight lines", () => {
			// A line that leaves left and right is horizontal.
			expect(getBorderChar(LEFT | RIGHT)).toBe("─");
			// A line that leaves up and down is vertical.
			expect(getBorderChar(UP | DOWN)).toBe("│");
		});

		test("a single stub still draws its line", () => {
			// The end of a run: only one direction is set, but it is still a line.
			expect(getBorderChar(BorderEdgeStyle.Solid << 8)).toBe("─"); // right
			expect(getBorderChar(BorderEdgeStyle.Solid << 0)).toBe("│"); // up
		});

		test("handles different border styles", () => {
			const doubleHorizontal =
				(BorderEdgeStyle.Double << 8) | (BorderEdgeStyle.Double << 24);
			expect(getBorderChar(doubleHorizontal)).toBe("═");

			const dashedHorizontal =
				(BorderEdgeStyle.Dashed << 8) | (BorderEdgeStyle.Dashed << 24);
			expect(getBorderChar(dashedHorizontal)).toBe("╌");
		});

		test("handles rounded corners", () => {
			const rounded = BorderEdgeStyle.Solid | BorderEdgeStyle.Rounded;
			// ╭ is the rounded ┌: rightward and downward.
			const roundedTopLeft = (rounded << 8) | (rounded << 16);
			expect(getBorderChar(roundedTopLeft)).toBe("╭");
		});
	});

	describe("mergeBorderEncodings", () => {
		test("merges non-conflicting edges", () => {
			const topEdge = BorderEdgeStyle.Solid << 0;
			const leftEdge = BorderEdgeStyle.Solid << 24;

			const merged = mergeBorderEncodings(topEdge, leftEdge);

			// Should have both edges (extract the edge values properly)
			expect((merged & (0xff << 0)) >> 0).toBe(BorderEdgeStyle.Solid); // top
			expect((merged & (0xff << 24)) >> 24).toBe(BorderEdgeStyle.Solid); // left
		});

		test("chooses higher priority style for conflicting edges", () => {
			const solidTop = BorderEdgeStyle.Solid << 0;
			const doubleTop = BorderEdgeStyle.Double << 0;

			const merged = mergeBorderEncodings(solidTop, doubleTop);

			// Double has higher priority than solid
			expect((merged & (0xff << 0)) >> 0).toBe(BorderEdgeStyle.Double);
		});

		test("preserves existing edges when incoming has none", () => {
			const existing = BorderEdgeStyle.Solid << 0;
			const incoming = 0;

			const merged = mergeBorderEncodings(existing, incoming);

			expect(merged).toBe(existing);
		});

		test("uses incoming edges when existing has none", () => {
			const existing = 0;
			const incoming = BorderEdgeStyle.Solid << 8;

			const merged = mergeBorderEncodings(existing, incoming);

			expect(merged).toBe(incoming);
		});
	});
});

describe("Border Drawing", () => {
	describe("drawBorder method", () => {
		test("draws simple rectangle border", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.drawBorder(1, 1, 4, 3, {
					topEdge: BorderEdgeStyle.Solid,
					rightEdge: BorderEdgeStyle.Solid,
					bottomEdge: BorderEdgeStyle.Solid,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: true,
				});
			});

			// Should contain complete box border pattern
			expect(output).toContain("┌──┐"); // top border with corners
			expect(output).toContain("└──┘"); // bottom border with corners
			expect(output).toContain("│"); // vertical sides
		});

		test("draws partial borders", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.drawBorder(1, 1, 4, 3, {
					topEdge: BorderEdgeStyle.Solid,
					rightEdge: 0, // no right border
					bottomEdge: BorderEdgeStyle.Solid,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: true,
				});
			});

			// Should have partial borders (no right edge)
			expect(output).toContain("┌──"); // top-left with horizontal line but no right corner
			expect(output).toContain("└──"); // bottom-left with horizontal line but no right corner
			expect(output).not.toContain("┐"); // no top-right corner
			expect(output).not.toContain("┘"); // no bottom-right corner
		});

		test("handles border merging at intersections", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				// Draw two overlapping rectangles to create border intersections
				ctx.drawBorder(1, 1, 4, 3, {
					topEdge: BorderEdgeStyle.Solid,
					rightEdge: BorderEdgeStyle.Solid,
					bottomEdge: BorderEdgeStyle.Solid,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: true,
				});

				ctx.drawBorder(2, 0, 4, 3, {
					topEdge: BorderEdgeStyle.Solid,
					rightEdge: BorderEdgeStyle.Solid,
					bottomEdge: BorderEdgeStyle.Solid,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: true,
				});
			});

			// Should contain overlapping border patterns with intersections
			expect(output).toMatch(/[┌┐└┘├┤┬┴┼]/); // Junction characters from overlapping borders
			expect(output).toContain("─"); // Horizontal border segments
			expect(output).toContain("│"); // Vertical border segments
		});

		test("respects viewport offset", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(2, (ctx) => {
				ctx.drawBorder(0, 0, 3, 2, {
					topEdge: BorderEdgeStyle.Solid,
					rightEdge: BorderEdgeStyle.Solid,
					bottomEdge: BorderEdgeStyle.Solid,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: true,
				});
			});

			// Should position cursor accounting for viewport offset
			expect(output).toContain("\x1b[3;1H"); // Row 3 (offset 2 + 1)
			expect(output).toContain("┌─┐"); // Top border pattern at offset position
		});

		test("handles different border styles", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.drawBorder(1, 1, 4, 3, {
					topEdge: BorderEdgeStyle.Double,
					rightEdge: BorderEdgeStyle.Double,
					bottomEdge: BorderEdgeStyle.Double,
					leftEdge: BorderEdgeStyle.Double,
					hasAnyBorder: true,
				});
			});

			// Should contain complete double-line border pattern
			expect(output).toContain("╔══╗"); // double top border
			expect(output).toContain("╚══╝"); // double bottom border
			expect(output).toContain("║"); // double vertical sides
		});

		test("skips drawing when hasAnyBorder is false", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.drawBorder(1, 1, 4, 3, {
					topEdge: BorderEdgeStyle.Solid,
					rightEdge: BorderEdgeStyle.Solid,
					bottomEdge: BorderEdgeStyle.Solid,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: false, // Should skip drawing
				});
			});

			// Should not contain any border patterns
			expect(output).not.toMatch(/[┌┐└┘├┤┬┴┼─│═║╔╗╚╝]/); // No box drawing characters at all
		});

		test("handles border colors and styles", () => {
			const renderer = new Renderer(5, 10);

			const output = renderer.renderFrame(0, (ctx) => {
				ctx.drawBorder(
					1,
					1,
					4,
					3,
					{
						topEdge: BorderEdgeStyle.Solid,
						rightEdge: BorderEdgeStyle.Solid,
						bottomEdge: BorderEdgeStyle.Solid,
						leftEdge: BorderEdgeStyle.Solid,
						hasAnyBorder: true,
					},
					{
						fg: 0xff0000, // Red border
						bold: true,
					},
				);
			});

			// Should contain colored border with styling
			expect(output).toContain("\x1b[38;2;255;0;0;1m┌"); // Red bold top-left corner
			expect(output).toContain("38;2;255;0;0"); // Red foreground color
			expect(output).toContain("1m"); // Bold style
		});

		test("clips borders to viewport bounds", () => {
			const renderer = new Renderer(3, 5); // Small viewport

			const output = renderer.renderFrame(0, (ctx) => {
				// Draw border that extends beyond viewport
				ctx.drawBorder(0, 0, 10, 10, {
					topEdge: BorderEdgeStyle.Solid,
					rightEdge: BorderEdgeStyle.Solid,
					bottomEdge: BorderEdgeStyle.Solid,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: true,
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
		const renderer = new Renderer(4, 8);

		const output = renderer.renderFrame(0, (ctx) => {
			ctx.drawBorder(1, 0, 6, 4, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});
			// Fill inside to ensure proper spacing
			ctx.setText(2, 1, "    ");
			ctx.setText(2, 2, "    ");
		});

		// Strip control codes but keep ANSI colors for testing
		const cleanOutput = stripControlCodes(output);
		// We should see the border box pattern
		expect(cleanOutput).toContain("┌────┐");
		expect(cleanOutput).toContain("│    │");
		expect(cleanOutput).toContain("└────┘");
	});

	test("renders borders with text content", () => {
		const renderer = new Renderer(5, 10);

		const output = renderer.renderFrame(0, (ctx) => {
			// Draw border
			ctx.drawBorder(1, 1, 6, 3, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			// Add text inside border
			ctx.setText(2, 2, "Hi");
		});

		expect(output).toContain("┌────┐"); // Complete top border
		expect(output).toContain("Hi"); // Text content inside border
		expect(output).toContain("└────┘"); // Complete bottom border
	});

	test("borders work with fillRect backgrounds", () => {
		const renderer = new Renderer(5, 10);

		const output = renderer.renderFrame(0, (ctx) => {
			// Fill background
			ctx.fillRect(1, 1, 4, 3, 0x00ff00);

			// Draw border on top
			ctx.drawBorder(1, 1, 4, 3, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});
		});

		expect(output).toContain("48;2;0;255;0"); // Green background color
		expect(output).toContain("┌──┐"); // Border corners with background
	});

	test("renders double border box without styles", () => {
		const renderer = new Renderer(5, 7);

		const output = renderer.renderFrame(0, (ctx) => {
			ctx.drawBorder(0, 0, 5, 4, {
				topEdge: BorderEdgeStyle.Double,
				rightEdge: BorderEdgeStyle.Double,
				bottomEdge: BorderEdgeStyle.Double,
				leftEdge: BorderEdgeStyle.Double,
				hasAnyBorder: true,
			});
		});

		// Check that double-line border characters are present
		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toContain("╔═══╗");
		expect(cleanOutput).toContain("║");
		expect(cleanOutput).toContain("╚═══╝");
	});

	test("renders partial border without right edge", () => {
		const renderer = new Renderer(5, 8);

		const output = renderer.renderFrame(0, (ctx) => {
			ctx.drawBorder(0, 0, 6, 4, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: 0, // No right edge
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
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
		const renderer = new Renderer(3, 10);

		const output = renderer.renderFrame(0, (ctx) => {
			ctx.setText(0, 0, "Hello");
			ctx.setText(0, 1, "World");
			ctx.setText(0, 2, "Test");
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
		const renderer = new Renderer(6, 10);

		const output = renderer.renderFrame(0, (ctx) => {
			// First box
			ctx.drawBorder(0, 0, 5, 4, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			// Second box overlapping
			ctx.drawBorder(2, 2, 5, 4, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
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
		const renderer = new Renderer(5, 10);

		// Clear previous buffer to ensure output
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Draw a simple box that fits in viewport
			ctx.drawBorder(1, 1, 3, 3, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
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
		const renderer = new Renderer(4, 12);

		// First render to establish baseline
		renderer.renderFrame(0, (ctx) => {
			ctx.setText(0, 0, "Line 1");
			ctx.setText(0, 1, "Line 2");
			ctx.setText(0, 2, "Line 3");
			ctx.setText(0, 3, "Line 4");
		});

		// Second render with minimal changes
		const output = renderer.renderFrame(0, (ctx) => {
			ctx.setText(0, 0, "Line 1");
			ctx.setText(0, 1, "Line TWO"); // Changed
			ctx.setText(0, 2, "Line 3");
			ctx.setText(0, 3, "Line 4");
		});

		// The renderer optimizes by only updating changed content
		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toContain("TWO"); // Changed part
		expect(cleanOutput).not.toContain("Line 1"); // Unchanged
		expect(cleanOutput).not.toContain("Line 3"); // Unchanged
		expect(cleanOutput).not.toContain("Line 4"); // Unchanged
	});

	test("renders box with text inside - full output", () => {
		const renderer = new Renderer(5, 8);

		// Clear any previous state
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Draw box
			ctx.drawBorder(0, 0, 8, 5, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});
			// Add text inside
			ctx.setText(1, 1, " TEST ");
			ctx.setText(1, 2, " BOX  ");
			ctx.setText(1, 3, " HERE ");
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
		const renderer = new Renderer(5, 9);

		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Simulate CSS collapsed table borders by drawing each cell's borders
			// This should create proper junctions where borders meet

			// Cell (0,0) - top-left
			ctx.drawBorder(0, 0, 5, 3, {
				topEdge: BorderEdgeStyle.Solid, // table top
				rightEdge: BorderEdgeStyle.Solid, // shared with cell (0,1)
				bottomEdge: BorderEdgeStyle.Solid, // shared with cell (1,0)
				leftEdge: BorderEdgeStyle.Solid, // table left
				hasAnyBorder: true,
			});

			// Cell (0,1) - top-right
			ctx.drawBorder(4, 0, 5, 3, {
				topEdge: BorderEdgeStyle.Solid, // table top
				rightEdge: BorderEdgeStyle.Solid, // table right
				bottomEdge: BorderEdgeStyle.Solid, // shared with cell (1,1)
				leftEdge: BorderEdgeStyle.Solid, // shared with cell (0,0)
				hasAnyBorder: true,
			});

			// Cell (1,0) - bottom-left
			ctx.drawBorder(0, 2, 5, 3, {
				topEdge: BorderEdgeStyle.Solid, // shared with cell (0,0)
				rightEdge: BorderEdgeStyle.Solid, // shared with cell (1,1)
				bottomEdge: BorderEdgeStyle.Solid, // table bottom
				leftEdge: BorderEdgeStyle.Solid, // table left
				hasAnyBorder: true,
			});

			// Cell (1,1) - bottom-right
			ctx.drawBorder(4, 2, 5, 3, {
				topEdge: BorderEdgeStyle.Solid, // shared with cell (0,1)
				rightEdge: BorderEdgeStyle.Solid, // table right
				bottomEdge: BorderEdgeStyle.Solid, // table bottom
				leftEdge: BorderEdgeStyle.Solid, // shared with cell (1,0)
				hasAnyBorder: true,
			});

			// Add cell content
			ctx.setText(1, 1, "A1");
			ctx.setText(5, 1, "B1");
			ctx.setText(1, 3, "A2");
			ctx.setText(5, 3, "B2");
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders collapsed table borders - mixed border styles", () => {
		const renderer = new Renderer(3, 11);

		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Test border merging with different styles
			// Left cell with solid borders
			ctx.drawBorder(0, 0, 6, 3, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			// Right cell with double borders (should merge with solid)
			ctx.drawBorder(5, 0, 6, 3, {
				topEdge: BorderEdgeStyle.Double,
				rightEdge: BorderEdgeStyle.Double,
				bottomEdge: BorderEdgeStyle.Double,
				leftEdge: BorderEdgeStyle.Double,
				hasAnyBorder: true,
			});

			// Add content to differentiate the cells
			ctx.setText(1, 1, "Sol");
			ctx.setText(6, 1, "Dbl");
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders collapsed table borders - header and data rows", () => {
		const renderer = new Renderer(5, 13); // 3 columns x 4 chars + 1 = 13 width

		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Simulate a typical HTML table with header and data rows
			// For collapsed borders, cells share borders at their edges

			// Header row cells (row 0-2)
			ctx.drawBorder(0, 0, 5, 3, {
				// Header cell 1: "Name"
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			ctx.drawBorder(4, 0, 5, 3, {
				// Header cell 2: "Age" (shares border at x=4)
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			ctx.drawBorder(8, 0, 5, 3, {
				// Header cell 3: "City" (shares border at x=8)
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			// Data row cells (row 2-4, sharing top border with header cells)
			ctx.drawBorder(0, 2, 5, 3, {
				// Data cell 1: "John"
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			ctx.drawBorder(4, 2, 5, 3, {
				// Data cell 2: "25"
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			ctx.drawBorder(8, 2, 5, 3, {
				// Data cell 3: "NYC"
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			// Cell content - placed inside the cells (max 3 chars per cell)
			ctx.setText(1, 1, "Nam");
			ctx.setText(5, 1, "Age");
			ctx.setText(9, 1, "Cty");
			ctx.setText(1, 3, "Jon");
			ctx.setText(5, 3, "25");
			ctx.setText(9, 3, "NYC");
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders simple single cell with border", () => {
		const renderer = new Renderer(4, 6);
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			ctx.drawBorder(1, 1, 4, 2, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders double border box", () => {
		const renderer = new Renderer(5, 8);
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			ctx.drawBorder(1, 1, 6, 3, {
				topEdge: BorderEdgeStyle.Double,
				rightEdge: BorderEdgeStyle.Double,
				bottomEdge: BorderEdgeStyle.Double,
				leftEdge: BorderEdgeStyle.Double,
				hasAnyBorder: true,
			});
			ctx.setText(2, 2, "Test");
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders partial borders - top and left only", () => {
		const renderer = new Renderer(4, 6);
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			ctx.drawBorder(0, 0, 5, 3, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: 0,
				bottomEdge: 0,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});
			ctx.setText(1, 1, "Part");
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders L-shaped table border pattern", () => {
		const renderer = new Renderer(4, 7);
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Top row - 2 cells
			ctx.drawBorder(0, 0, 4, 2, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			ctx.drawBorder(3, 0, 4, 2, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			// Bottom left cell only
			ctx.drawBorder(0, 1, 4, 2, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders mixed border styles in adjacent cells", () => {
		const renderer = new Renderer(3, 9);
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Solid border cell
			ctx.drawBorder(0, 0, 3, 3, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			// Double border cell
			ctx.drawBorder(2, 0, 3, 3, {
				topEdge: BorderEdgeStyle.Double,
				rightEdge: BorderEdgeStyle.Double,
				bottomEdge: BorderEdgeStyle.Double,
				leftEdge: BorderEdgeStyle.Double,
				hasAnyBorder: true,
			});

			// Heavy border cell
			ctx.drawBorder(4, 0, 3, 3, {
				topEdge: BorderEdgeStyle.Groove, // Uses heavy style
				rightEdge: BorderEdgeStyle.Groove,
				bottomEdge: BorderEdgeStyle.Groove,
				leftEdge: BorderEdgeStyle.Groove,
				hasAnyBorder: true,
			});

			ctx.setText(1, 1, "S");
			ctx.setText(3, 1, "D");
			ctx.setText(5, 1, "H");
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders nested borders", () => {
		const renderer = new Renderer(7, 11); // Wider to accommodate text
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Outer border
			ctx.drawBorder(0, 0, 9, 7, {
				topEdge: BorderEdgeStyle.Double,
				rightEdge: BorderEdgeStyle.Double,
				bottomEdge: BorderEdgeStyle.Double,
				leftEdge: BorderEdgeStyle.Double,
				hasAnyBorder: true,
			});

			// Inner border
			ctx.drawBorder(2, 2, 5, 3, {
				topEdge: BorderEdgeStyle.Solid,
				rightEdge: BorderEdgeStyle.Solid,
				bottomEdge: BorderEdgeStyle.Solid,
				leftEdge: BorderEdgeStyle.Solid,
				hasAnyBorder: true,
			});

			ctx.setText(1, 1, "Out");
			ctx.setText(3, 3, "In");
			ctx.setText(5, 5, "Out"); // Moved left by 2 to avoid overlap
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders grid layout - 3x3 table", () => {
		const renderer = new Renderer(7, 11);
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			// Draw 3x3 grid of cells
			for (let row = 0; row < 3; row++) {
				for (let col = 0; col < 3; col++) {
					const x = col * 3;
					const y = row * 2;

					ctx.drawBorder(x, y, 4, 3, {
						topEdge: BorderEdgeStyle.Solid,
						rightEdge: BorderEdgeStyle.Solid,
						bottomEdge: BorderEdgeStyle.Solid,
						leftEdge: BorderEdgeStyle.Solid,
						hasAnyBorder: true,
					});

					ctx.setText(x + 1, y + 1, `${row + 1}${col + 1}`);
				}
			}
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});

	test("renders borders with background colors", () => {
		const renderer = new Renderer(3, 7);
		renderer.clearPreviousBuffer();

		const output = renderer.renderFrame(0, (ctx) => {
			ctx.drawBorder(
				1,
				0,
				5,
				3,
				{
					topEdge: BorderEdgeStyle.Solid,
					rightEdge: BorderEdgeStyle.Solid,
					bottomEdge: BorderEdgeStyle.Solid,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: true,
				},
				{
					fg: 0xff0000, // Red border
					bg: 0x00ff00, // Green background
				},
			);

			ctx.setText(2, 1, "Col");
		});

		const cleanOutput = stripControlCodes(output);
		expect(cleanOutput).toMatchSnapshot();
	});
});
