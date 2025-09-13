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
			console.log('Direct renderer test - visible text:', JSON.stringify(visibleText));
			console.log('Direct renderer test - ANSI:', JSON.stringify(ansi));
			
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
