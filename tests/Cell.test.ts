import {test, expect, describe} from "bun:test";
import {Cell, type CellStyle, createBuffer} from "../src/rendering/CellBuffer.js";

describe("Cell", () => {
	describe("constructor", () => {
		test("throws on empty grapheme", () => {
			expect(() => new Cell("")).toThrow("Cell grapheme cannot be empty - use null for empty cells");
		});

		test("creates cell with character", () => {
			const cell = new Cell("A");
			
			expect(cell.grapheme).toBe("A");
			expect(cell.fg).toBe(0);
			expect(cell.bg).toBe(0);
			expect(cell.style).toBe(0);
		});

		test("creates cell with character and style", () => {
			const style: CellStyle = {
				fg: 0xff0000,
				bg: 0x00ff00,
				bold: true,
				italic: true
			};
			const cell = new Cell("A", style);
			
			expect(cell.grapheme).toBe("A");
			expect(cell.fg).toBe(0xff0000);
			expect(cell.bg).toBe(0x00ff00);
			
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
				overline: true
			};
			const cell = new Cell("X", style);
			
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
			const cell = Cell.create("A");
			
			expect(cell.grapheme).toBe("A");
			expect(cell.fg).toBe(0);
			expect(cell.bg).toBe(0);
			expect(cell.style).toBe(0);
		});

		test("interns identical cells", () => {
			const cell1 = Cell.create("A", {fg: 0xff0000, bold: true});
			const cell2 = Cell.create("A", {fg: 0xff0000, bold: true});
			
			// Should return the exact same object reference due to interning
			expect(cell1).toBe(cell2);
		});

		test("creates different instances for different styles", () => {
			const cell1 = Cell.create("A", {fg: 0xff0000});
			const cell2 = Cell.create("A", {fg: 0x00ff00});
			
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
			const cell1 = Cell.create("A", {fg: 0xff0000, bold: true});
			const cell2 = Cell.create("A", {fg: 0xff0000, bold: true});
			
			expect(cell1.equals(cell2)).toBe(true);
		});

		test("different characters return false", () => {
			const cell1 = Cell.create("A");
			const cell2 = Cell.create("B");
			
			expect(cell1.equals(cell2)).toBe(false);
		});

		test("different colors return false", () => {
			const cell1 = Cell.create("A", {fg: 0xff0000});
			const cell2 = Cell.create("A", {fg: 0x00ff00});
			
			expect(cell1.equals(cell2)).toBe(false);
		});

		test("different styles return false", () => {
			const cell1 = Cell.create("A", {bold: true});
			const cell2 = Cell.create("A", {italic: true});
			
			expect(cell1.equals(cell2)).toBe(false);
		});
	});

	describe("styleEquals", () => {
		test("same style different characters return true", () => {
			const cell1 = Cell.create("A", {fg: 0xff0000, bold: true});
			const cell2 = Cell.create("B", {fg: 0xff0000, bold: true});
			
			expect(cell1.styleEquals(cell2)).toBe(true);
		});

		test("different styles return false", () => {
			const cell1 = Cell.create("A", {fg: 0xff0000});
			const cell2 = Cell.create("A", {fg: 0x00ff00});
			
			expect(cell1.styleEquals(cell2)).toBe(false);
		});
	});

	describe("immutability", () => {
		test("cells are frozen and cannot be mutated", () => {
			const cell = Cell.create("A", {fg: 0xff0000});
			
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
			const cell = Cell.create("A");
			expect(Object.isFrozen(cell)).toBe(true);
		});
	});


	describe("width and isWide", () => {
		test("ASCII character has width 1", () => {
			const cell = Cell.create("A");
			expect(cell.width).toBe(1);
			expect(cell.isWide).toBe(false);
		});

		test("wide character has width 2", () => {
			const cell = Cell.create("你");
			expect(cell.width).toBe(2);
			expect(cell.isWide).toBe(true);
		});

		test("emoji has width 2", () => {
			const cell = Cell.create("😀");
			expect(cell.width).toBe(2);
			expect(cell.isWide).toBe(true);
		});

		test("combining character has width 1", () => {
			// U+0300 is a combining grave accent  
			const cell = Cell.create("a\u0300");
			expect(cell.width).toBe(1); // Still 1 because base character is ASCII
		});
	});

	describe("getStyleFlags", () => {
		test("returns all flags as false for default cell", () => {
			const cell = Cell.create("X");
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
			const cell = Cell.create("X", {
				bold: true,
				underline: true,
				inverse: true
			});
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