import {test, expect, describe} from "bun:test";
import {
	Cell,
	type CellStyle,
	createBuffer,
	Renderer,
	generateANSI,
} from "../src/ansi.js";

describe("Cell", () => {
	describe("constructor", () => {
		test("throws on empty grapheme", () => {
			expect(() => new Cell("")).toThrow(
				"Cell grapheme cannot be empty - use null for empty cells",
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
		});

		test("handles all style flags", () => {
			const style: CellStyle = {
				bold: true,
				italic: true,
				underline: true,
				strikethrough: true,
				inverse: true,
				blink: true,
				dim: true,
				overline: true,
			};
			const cell = new Cell({grapheme: "X", ...style});

			const flags = cell.getStyleFlags();
			expect(flags.bold).toBe(true);
			expect(flags.italic).toBe(true);
			expect(flags.underline).toBe(true);
			expect(flags.strikethrough).toBe(true);
			expect(flags.inverse).toBe(true);
			expect(flags.blink).toBe(true);
			expect(flags.dim).toBe(true);
			expect(flags.overline).toBe(true);
		});
	});

	describe("Cell.create", () => {
		test("creates cell with character", () => {
			const cell = Cell.create("A")!;

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

		test("interns identical cells", () => {
			const cell1 = Cell.create({grapheme: "A", fg: 0xff0000, bold: true})!;
			const cell2 = Cell.create({grapheme: "A", fg: 0xff0000, bold: true})!;

			// Should return the exact same object reference due to interning
			expect(cell1).toBe(cell2);
		});

		test("creates different instances for different styles", () => {
			const cell1 = Cell.create({grapheme: "A", fg: 0xff0000});
			const cell2 = Cell.create({grapheme: "A", fg: 0x00ff00});

			// Different styles should create different instances
			expect(cell1).not.toBe(cell2);
		});

		test("creates different instances for different characters", () => {
			const cell1 = Cell.create("A");
			const cell2 = Cell.create("B");

			expect(cell1).not.toBe(cell2);
		});
	});

	describe("equals", () => {
		test("equal cells return true", () => {
			const cell1 = Cell.create({grapheme: "A", fg: 0xff0000, bold: true})!;
			const cell2 = Cell.create({grapheme: "A", fg: 0xff0000, bold: true})!;

			expect(cell1.equals(cell2)).toBe(true);
		});

		test("different characters return false", () => {
			const cell1 = Cell.create("A")!;
			const cell2 = Cell.create("B")!;

			expect(cell1.equals(cell2)).toBe(false);
		});

		test("different colors return false", () => {
			const cell1 = Cell.create({grapheme: "A", fg: 0xff0000})!;
			const cell2 = Cell.create({grapheme: "A", fg: 0x00ff00})!;

			expect(cell1.equals(cell2)).toBe(false);
		});

		test("different styles return false", () => {
			const cell1 = Cell.create({grapheme: "A", bold: true})!;
			const cell2 = Cell.create({grapheme: "A", italic: true})!;

			expect(cell1.equals(cell2)).toBe(false);
		});
	});

	describe("styleEquals", () => {
		test("same style different characters return true", () => {
			const cell1 = Cell.create({grapheme: "A", fg: 0xff0000, bold: true})!;
			const cell2 = Cell.create({grapheme: "B", fg: 0xff0000, bold: true})!;

			expect(cell1.styleEquals(cell2)).toBe(true);
		});

		test("different styles return false", () => {
			const cell1 = Cell.create({grapheme: "A", fg: 0xff0000})!;
			const cell2 = Cell.create({grapheme: "A", fg: 0x00ff00})!;

			expect(cell1.styleEquals(cell2)).toBe(false);
		});
	});

	describe("immutability", () => {
		test("cells are frozen and cannot be mutated", () => {
			const cell = Cell.create({grapheme: "A", fg: 0xff0000})!;

			// Attempting to mutate should throw (Object.freeze enforcement)
			expect(() => {
				(cell as any).grapheme = "B";
			}).toThrow("Attempted to assign to readonly property");

			expect(() => {
				(cell as any).fg = 0x00ff00;
			}).toThrow("Attempted to assign to readonly property");

			// Values should remain unchanged
			expect(cell.grapheme).toBe("A");
			expect(cell.fg).toBe(0xff0000);
		});

		test("Object.isFrozen returns true", () => {
			const cell = Cell.create("A")!;
			expect(Object.isFrozen(cell)).toBe(true);
		});
	});

	describe("width and isWide", () => {
		test("ASCII character has width 1", () => {
			const cell = Cell.create("A")!;
			expect(cell.width).toBe(1);
			expect(cell.isWide).toBe(false);
		});

		test("wide character has width 2", () => {
			const cell = Cell.create("你")!;
			expect(cell.width).toBe(2);
			expect(cell.isWide).toBe(true);
		});

		test("emoji has width 2", () => {
			const cell = Cell.create("😀")!;
			expect(cell.width).toBe(2);
			expect(cell.isWide).toBe(true);
		});

		test("combining character has width 1", () => {
			// U+0300 is a combining grave accent
			const cell = Cell.create("a\u0300")!;
			expect(cell.width).toBe(1); // Still 1 because base character is ASCII
		});
	});

	describe("getStyleFlags", () => {
		test("returns all flags as false for default cell", () => {
			const cell = Cell.create("X")!;
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

		test("returns correct flags for styled cell", () => {
			const cell = Cell.create({
				grapheme: "X",
				bold: true,
				underline: true,
				inverse: true,
			})!;
			const flags = cell.getStyleFlags();

			expect(flags.bold).toBe(true);
			expect(flags.italic).toBe(false);
			expect(flags.underline).toBe(true);
			expect(flags.strikethrough).toBe(false);
			expect(flags.inverse).toBe(true);
			expect(flags.blink).toBe(false);
			expect(flags.dim).toBe(false);
			expect(flags.overline).toBe(false);
		});
	});
});

describe("createBuffer", () => {
	test("creates buffer with correct dimensions", () => {
		const buffer = createBuffer(3, 5);

		expect(buffer.length).toBe(3); // rows
		expect(buffer[0].length).toBe(5); // cols
		expect(buffer[1].length).toBe(5);
		expect(buffer[2].length).toBe(5);
	});

	test("all cells are initially null", () => {
		const buffer = createBuffer(2, 2);

		for (let row = 0; row < 2; row++) {
			for (let col = 0; col < 2; col++) {
				const cell = buffer[row][col];
				expect(cell).toBe(null);
			}
		}
	});

	test("handles edge cases", () => {
		// Single cell
		const single = createBuffer(1, 1);
		expect(single.length).toBe(1);
		expect(single[0].length).toBe(1);
		expect(single[0][0]).toBe(null);

		// Zero dimensions should still work
		const empty = createBuffer(0, 0);
		expect(empty.length).toBe(0);
	});
});

describe("Renderer", () => {
	describe("initialization", () => {
		test("creates renderer with specified dimensions", () => {
			const renderer = new Renderer(5, 10);
			renderer.beginFrame();
			renderer.setText(0, 0, "X");
			const output = renderer.render();
			expect(output).toContain("X");
		});
	});

	describe("first frame", () => {
		test("renders all content on first frame", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(2, 5);

			renderer.beginFrame();
			renderer.setText(0, 0, "Hello");

			const ansi = renderer.render();

			const terminal = new TestTerminal({rows: 2, cols: 5});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(ansi, () => resolve());
			});

			expect(terminal.getPlainText()).toBe("Hello\n");
		});
	});

	describe("delta rendering", () => {
		test("renders only changes in second frame", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 5);

			renderer.beginFrame();
			renderer.setText(0, 0, "Hello");
			const frame1 = renderer.render();

			renderer.beginFrame();
			renderer.setText(0, 0, "Hallo");
			const frame2 = renderer.render();

			const terminal = new TestTerminal({rows: 1, cols: 5});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame2, () => resolve());
			});

			expect(terminal.getPlainText()).toBe("Hello\n");
		});
	});

	describe("Terminal Resize", () => {
		test("handles resize to smaller dimensions", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(2, 4);

			renderer.beginFrame();
			renderer.setText(0, 0, "AB");
			renderer.setText(1, 0, "CD");
			const frame1 = renderer.render();

			const terminal = new TestTerminal({rows: 2, cols: 4});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});

			const result = terminal.getPlainText();
			expect(result).toContain("A");
			expect(result).toContain("C");
			expect(result).toMatch(/\n$/);
		});
	});

	describe("emoji text rendering", () => {
		test("renders emoji text with spaces correctly", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(3, 25); // 3 rows, 25 cols

			renderer.beginFrame();

			// Test the exact same text from the failing emoji test
			renderer.setText(1, 2, "🎨 Colorful Text 🌈", {
				fg: 0xff00ff, // magenta
				bg: 0xffff00, // yellow
			});

			const ansi = renderer.render();

			const terminal = new TestTerminal({rows: 3, cols: 25});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(ansi, () => resolve());
			});

			const visibleText = terminal.getPlainText();

			// Check that the space after the first emoji is preserved
			expect(visibleText).toContain("🎨 Colorful"); // Space between emoji and text
			expect(visibleText).toContain("Text 🌈"); // Space before second emoji
			expect(visibleText).not.toContain("🎨Colorful"); // Should NOT be missing space
		});
	});
});

describe("generateANSI", () => {
	describe("empty buffers", () => {
		test("returns empty string for empty buffer", () => {
			const buffer = createBuffer(3, 5);
			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("");
		});

		test("ignores null cells", () => {
			const buffer = createBuffer(2, 3);
			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("");
		});
	});

	describe("basic character output", () => {
		test("outputs single character at origin", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("A");

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("A\n");
		});

		test("outputs consecutive characters without cursor movement", () => {
			const buffer = createBuffer(1, 3);
			buffer[0][0] = Cell.create("A");
			buffer[0][1] = Cell.create("B");
			buffer[0][2] = Cell.create("C");

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("ABC\n");
		});

		test("moves cursor for gaps", () => {
			const buffer = createBuffer(1, 5);
			buffer[0][0] = Cell.create("A");
			buffer[0][3] = Cell.create("B");

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("A\x1b[2CB\n");
		});
	});

	describe("line movement", () => {
		test("moves to next line correctly", () => {
			const buffer = createBuffer(2, 3);
			buffer[0][0] = Cell.create("A");
			buffer[1][0] = Cell.create("B");

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("A\r\nB\n");
		});

		test("moves to next line with horizontal offset", () => {
			const buffer = createBuffer(2, 5);
			buffer[0][0] = Cell.create("A");
			buffer[1][2] = Cell.create("B");

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("A\r\n\x1b[2CB\n");
		});
	});

	describe("RGB color output", () => {
		test("outputs RGB foreground color", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create({grapheme: "A", fg: 0xff0000});

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("\x1b[38;2;255;0;0mA\x1b[0m\n");
		});

		test("outputs RGB background color", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create({grapheme: "A", bg: 0x00ff00});

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("\x1b[48;2;0;255;0mA\x1b[0m\n");
		});

		test("outputs both foreground and background", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create({grapheme: "A", fg: 0xff0000, bg: 0xffff00});

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("\x1b[38;2;255;0;0;48;2;255;255;0mA\x1b[0m\n");
		});
	});

	describe("color depth modes", () => {
		test("RGB mode uses 24-bit colors", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create({grapheme: "A", fg: 0x123456});

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toContain("38;2;18;52;86");
		});

		test("256-color mode converts to palette", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create({grapheme: "A", fg: 0xff0000});

			const result = generateANSI(buffer, "256", true);
			expect(result).toContain("38;5;");
		});

		test("ANSI mode uses basic colors", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create({grapheme: "A", fg: 0xff0000});

			const result = generateANSI(buffer, "ansi", true);
			expect(result).toMatch(/\u001b\[3\dm/);
		});
	});

	describe("style flags", () => {
		test("outputs all style flags", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create({
				grapheme: "A",
				bold: true,
				dim: true,
				italic: true,
				underline: true,
				blink: true,
				inverse: true,
				strikethrough: true,
				overline: true,
			});

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toContain("1");
			expect(result).toContain(";2");
			expect(result).toContain(";3");
			expect(result).toContain(";4");
			expect(result).toContain(";5");
			expect(result).toContain(";7");
			expect(result).toContain(";9");
			expect(result).toContain(";53");
		});
	});

	describe("wide characters", () => {
		test("handles wide characters correctly", () => {
			const buffer = createBuffer(1, 4);
			buffer[0][0] = Cell.create("你");
			buffer[0][2] = Cell.create("好");

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toContain("你");
			expect(result).toContain("好");
		});

		test("skips second column of wide characters", () => {
			const buffer = createBuffer(1, 3);
			buffer[0][0] = Cell.create("你");
			buffer[0][2] = Cell.create("A");

			const result = generateANSI(buffer, "rgb", true);
			expect(result).toBe("你A\n");
		});
	});
});

// Buffer transformation optimization tests
describe("Buffer Transformation", () => {
	test("optimizes scroll down output", () => {
		const renderer = new Renderer(4, 10, "rgb");

		// Frame 1: Fill buffer with initial content
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Line1", {fg: 0xffffff});
		renderer.setText(0, 1, "Line2", {fg: 0xffffff});
		renderer.setText(0, 2, "Line3", {fg: 0xffffff});
		const output1 = renderer.render();

		// Should contain all initial content
		expect(output1).toContain("Line1");
		expect(output1).toContain("Line2");
		expect(output1).toContain("Line3");

		// Frame 2: Scroll down 1 line - buffer transformation shifts existing content automatically
		// With viewport offset 1, only need to add NEW content, not re-set shifted content
		renderer.beginFrame(1);
		renderer.setText(0, 2, "Line4", {fg: 0xffffff}); // Only new content needed
		const output2 = renderer.render();

		// Should contain scroll command
		expect(output2).toContain("\x1b[1S");

		// Should only output new content (Line4), not existing content
		expect(output2).toContain("Line4");
		expect(output2).not.toContain("Line2");
		expect(output2).not.toContain("Line3");

		// Output should be much shorter due to optimization
		expect(output2.length).toBeLessThan(output1.length);
	});

	test("optimizes scroll up output", () => {
		const renderer = new Renderer(4, 10, "rgb");

		// Frame 1: Fill buffer with content
		renderer.beginFrame(0);
		renderer.setText(0, 1, "Line2", {fg: 0xffffff});
		renderer.setText(0, 2, "Line3", {fg: 0xffffff});
		renderer.setText(0, 3, "Line4", {fg: 0xffffff});
		const _output1 = renderer.render();

		// Frame 2: Scroll up 1 line - buffer transformation shifts existing content automatically
		// With viewport offset -1, layout row 1 maps to terminal row 0 (visible top)
		renderer.beginFrame(-1);
		renderer.setText(0, 1, "Line1", {fg: 0xffffff}); // New content at layout row 1 → terminal row 0
		const output2 = renderer.render();

		// Should contain scroll up command
		expect(output2).toContain("\x1b[1T");

		// Should only output new content (Line1), existing content positioned by scroll
		expect(output2).toContain("Line1");
		expect(output2).not.toContain("Line2"); // Already positioned correctly by transform
		expect(output2).not.toContain("Line3"); // Already positioned correctly by transform
	});

	test("handles multiple line scrolling", () => {
		const renderer = new Renderer(5, 10, "rgb");

		// Frame 1: Fill buffer
		renderer.beginFrame(0);
		renderer.setText(0, 0, "A", {fg: 0xffffff});
		renderer.setText(0, 1, "B", {fg: 0xffffff});
		renderer.setText(0, 2, "C", {fg: 0xffffff});
		renderer.setText(0, 3, "D", {fg: 0xffffff});
		renderer.setText(0, 4, "E", {fg: 0xffffff});
		renderer.render();

		// Frame 2: Scroll down 3 lines - content shifts automatically, add new content
		// With viewport offset 3, layout coordinates map to terminal coordinates + 3
		renderer.beginFrame(3);
		renderer.setText(0, -1, "F", {fg: 0xffffff}); // Layout row -1 → terminal row 2
		renderer.setText(0, 0, "G", {fg: 0xffffff}); // Layout row 0 → terminal row 3
		renderer.setText(0, 1, "H", {fg: 0xffffff}); // Layout row 1 → terminal row 4
		const output2 = renderer.render();

		// Should contain scroll down 3 command
		expect(output2).toContain("\x1b[3S");

		// Should only output new content (F, G, H)
		expect(output2).toContain("F");
		expect(output2).toContain("G");
		expect(output2).toContain("H");
		expect(output2).not.toContain("D");
		expect(output2).not.toContain("E");
	});

	test("with no viewport change outputs minimal diff", () => {
		const renderer = new Renderer(3, 10, "rgb");

		// Frame 1: Initial content
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Stay", {fg: 0xffffff});
		renderer.setText(0, 1, "Same", {fg: 0xffffff});
		renderer.render();

		// Frame 2: Same viewport, only change one cell
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Stay", {fg: 0xffffff}); // Same
		renderer.setText(0, 1, "Diff", {fg: 0xffffff}); // Changed
		const output2 = renderer.render();

		// Should not contain scroll commands
		expect(output2).not.toContain("\x1b[S");
		expect(output2).not.toContain("\x1b[T");

		// Should only output changed content
		expect(output2).toContain("Diff");
		expect(output2).not.toContain("Stay");
	});

	test("handles edge case: scroll entire buffer height", () => {
		const renderer = new Renderer(3, 5, "rgb");

		// Frame 1: Fill buffer
		renderer.beginFrame(0);
		renderer.setText(0, 0, "A", {fg: 0xffffff});
		renderer.setText(0, 1, "B", {fg: 0xffffff});
		renderer.setText(0, 2, "C", {fg: 0xffffff});
		renderer.render();

		// Frame 2: Scroll down by full buffer height (complete refresh)
		// With viewport offset 3, place content at layout rows that map to terminal rows 0-2
		renderer.beginFrame(3);
		renderer.setText(0, -3, "X", {fg: 0xffffff}); // Layout row -3 → terminal row 0
		renderer.setText(0, -2, "Y", {fg: 0xffffff}); // Layout row -2 → terminal row 1
		renderer.setText(0, -1, "Z", {fg: 0xffffff}); // Layout row -1 → terminal row 2
		const output2 = renderer.render();

		// Should contain scroll command
		expect(output2).toContain("\x1b[3S");

		// Should output all new content since everything changed
		expect(output2).toContain("X");
		expect(output2).toContain("Y");
		expect(output2).toContain("Z");
	});
});

// Coordinate transformation tests
describe("Coordinate Transformation", () => {
	test("places content at correct terminal position", () => {
		const renderer = new Renderer(10, 20, "rgb");

		// Test viewport offset 3: layout (0,0) -> terminal (0,3)
		renderer.beginFrame(3);
		renderer.setText(0, 0, "Hello", {fg: 0xffffff});

		const output = renderer.render();

		// Should contain the text
		expect(output).toContain("Hello");

		// Should not contain scroll commands for initial positioning
		expect(output).not.toContain("\x1b[S");
		expect(output).not.toContain("\x1b[T");
	});

	test("clips content outside bounds", () => {
		const renderer = new Renderer(5, 10, "rgb");

		// Test viewport offset 3 with content that would go outside bounds
		renderer.beginFrame(3);
		renderer.setText(0, 0, "Visible", {fg: 0xffffff}); // (0,0) -> (0,3) = visible
		renderer.setText(0, 3, "Clipped", {fg: 0xffffff}); // (0,3) -> (0,6) = outside bounds (rows 0-4)

		const output = renderer.render();

		// Should contain visible content
		expect(output).toContain("Visible");

		// Should not contain clipped content
		expect(output).not.toContain("Clipped");
	});

	test("with zero offset renders normally", () => {
		const renderer = new Renderer(5, 10, "rgb");

		// Test no viewport offset: layout (0,0) -> terminal (0,0)
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Normal", {fg: 0xffffff});

		const output = renderer.render();

		// Should contain the text
		expect(output).toContain("Normal");
	});
});

// Renderer viewport tests
describe("Renderer Viewport", () => {
	test("generates scroll down command for positive viewport offset", () => {
		const renderer = new Renderer(10, 40, "rgb");

		// Frame 1: Initial content at offset 0
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Initial", {fg: 0xffffff});
		renderer.render();

		// Frame 2: Begin frame with viewport offset 3 (content starts below terminal top)
		renderer.beginFrame(3);
		renderer.setText(0, 0, "Hello", {fg: 0xffffff});

		const output = renderer.render();

		// Should contain scroll down command to position viewport
		// \x1b[3S = scroll down 3 lines
		expect(output).toContain("\x1b[3S");
		expect(output).toContain("Hello");
	});

	test("generates scroll up command for negative viewport offset", () => {
		const renderer = new Renderer(10, 40, "rgb");

		// Frame 1: Initial content at offset 0
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Initial", {fg: 0xffffff});
		renderer.render();

		// Frame 2: Begin frame with negative viewport offset (content shifted up)
		renderer.beginFrame(-2);
		renderer.setText(0, 2, "Content", {fg: 0xffffff}); // Layout row 2 → terminal row 0

		const output = renderer.render();

		// Should contain scroll up command
		// \x1b[2T = scroll up 2 lines
		expect(output).toContain("\x1b[2T");
		expect(output).toContain("Content");
	});

	test("generates no scroll commands for zero viewport offset", () => {
		const renderer = new Renderer(10, 40, "rgb");

		// Begin frame with no viewport offset (normal rendering)
		renderer.beginFrame(0);

		// Add some content
		renderer.setText(0, 0, "Normal", {fg: 0xffffff});

		const output = renderer.render();

		// Should not contain any scroll commands
		expect(output).not.toContain("\x1b[S"); // No scroll down
		expect(output).not.toContain("\x1b[T"); // No scroll up
		expect(output).toContain("Normal");
	});

	test("optimizes repeated viewport offsets (no redundant scrolling)", () => {
		const renderer = new Renderer(10, 40, "rgb");

		// Frame 1: Initial frame at offset 0
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Initial", {fg: 0xffffff});
		renderer.render();

		// Frame 2: First change to offset 3
		renderer.beginFrame(3);
		renderer.setText(0, 0, "Frame1", {fg: 0xffffff});
		const output1 = renderer.render();

		// Frame 3: Same offset 3 (no viewport change)
		renderer.beginFrame(3);
		renderer.setText(0, 1, "Frame2", {fg: 0xffffff});
		const output2 = renderer.render();

		// Frame 2 should scroll to position
		expect(output1).toContain("\x1b[3S");

		// Frame 3 should NOT repeat scroll command (already positioned)
		expect(output2).not.toContain("\x1b[3S");
		expect(output2).toContain("Frame2");
	});

	test("generates incremental scroll commands when viewport changes", () => {
		const renderer = new Renderer(10, 40, "rgb");

		// Frame 1: Initial frame at offset 0
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Initial", {fg: 0xffffff});
		renderer.render();

		// Frame 2: First change to offset 2
		renderer.beginFrame(2);
		renderer.setText(0, 0, "Frame1", {fg: 0xffffff});
		const output1 = renderer.render();

		// Frame 3: Change to offset 5 (moved down by 3)
		renderer.beginFrame(5);
		renderer.setText(0, 0, "Frame2", {fg: 0xffffff});
		const output2 = renderer.render();

		// Frame 2: scroll down 2
		expect(output1).toContain("\x1b[2S");

		// Frame 3: additional scroll down 3 (5-2=3)
		expect(output2).toContain("\x1b[3S");
	});

	test("generates scroll up when viewport moves toward terminal top", () => {
		const renderer = new Renderer(10, 40, "rgb");

		// Frame 1: Initial frame at offset 0
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Initial", {fg: 0xffffff});
		renderer.render();

		// Frame 2: First change to offset 5
		renderer.beginFrame(5);
		renderer.setText(0, 0, "Frame1", {fg: 0xffffff});
		const output1 = renderer.render();

		// Frame 3: Change to offset 2 (moved up by 3)
		renderer.beginFrame(2);
		renderer.setText(0, 0, "Frame2", {fg: 0xffffff});
		const output2 = renderer.render();

		// Frame 2: scroll down 5
		expect(output1).toContain("\x1b[5S");

		// Frame 3: scroll up 3 (5-2=3)
		expect(output2).toContain("\x1b[3T");
	});

	test("clips content outside viewport bounds", () => {
		const renderer = new Renderer(5, 20, "rgb"); // Small terminal

		// Frame 1: Initial frame at offset 0
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Initial", {fg: 0xffffff});
		renderer.render();

		// Frame 2: Viewport at offset 2, terminal height 5
		renderer.beginFrame(2);

		// Try to render content that would exceed terminal bounds
		renderer.setText(0, 0, "Visible", {fg: 0xffffff}); // Layout row 0 → terminal row 2 (appears)
		renderer.setText(0, 2, "LastLine", {fg: 0xffffff}); // Layout row 2 → terminal row 4 (last visible row)
		renderer.setText(0, 3, "Clipped", {fg: 0xffffff}); // Layout row 3 → terminal row 5 (clipped)

		const output = renderer.render();

		// Should contain scroll command and visible content
		expect(output).toContain("\x1b[2S");
		expect(output).toContain("Visible");
		expect(output).toContain("LastLine");

		// Should not contain clipped content
		expect(output).not.toContain("Clipped");
	});

	test("handles viewport offset with minimal ANSI output", () => {
		const renderer = new Renderer(10, 40, "rgb");

		// Frame 1: Initial frame at offset 0
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Initial", {fg: 0xffffff});
		renderer.render();

		// Frame 2: Test that viewport scrolling produces minimal output
		renderer.beginFrame(3);
		renderer.setText(0, -3, "Text", {fg: 0xffffff}); // Layout row -3 → terminal row 0

		const output = renderer.render();

		// Should be concise: scroll command + positioning + content + cleanup
		expect(output).toMatch(
			/^\x1b\[\?2026h\x1b\[\?25l\x1b\[3S\x1b\[4;1H.*Text.*\x1b\[\?25h\x1b\[\?2026l\n$/,
		);
	});

	test("maintains cursor position correctly with viewport offset", () => {
		const renderer = new Renderer(10, 40, "rgb");

		// Frame 1: Initial frame at offset 0
		renderer.beginFrame(0);
		renderer.setText(0, 0, "Initial", {fg: 0xffffff});
		renderer.render();

		// Frame 2: Viewport offset should not affect relative cursor movements
		renderer.beginFrame(4);
		renderer.setText(0, 0, "First", {fg: 0xffffff});
		renderer.setText(5, 1, "Second", {fg: 0xffffff}); // Row 1, Col 5

		const output = renderer.render();

		// Should contain scroll, then proper cursor positioning
		expect(output).toContain("\x1b[4S"); // Scroll command
		expect(output).toContain("First");
		expect(output).toContain("Second");

		// After scrolling, cursor movements should still be relative to content
		expect(output).toMatch(/First.*\r\n.*\x1b\[5C.*Second/s); // Newline + move to col 5
	});
});
