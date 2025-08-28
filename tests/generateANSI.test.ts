import {test, expect, describe} from "bun:test";
import {generateANSI, type ColorDepth} from "../src/rendering/Renderer.js";
import {Cell, createBuffer, type CellStyle} from "../src/rendering/CellBuffer.js";

describe("generateANSI", () => {
	describe("empty buffers", () => {
		test("returns empty string for empty buffer", () => {
			const buffer = createBuffer(3, 5);
			const result = generateANSI(buffer);
			expect(result).toBe("");
		});

		test("ignores null cells", () => {
			const buffer = createBuffer(2, 3);
			// Cells are null by default, so just verify
			
			const result = generateANSI(buffer);
			expect(result).toBe("");
		});
	});

	describe("basic character output", () => {
		test("outputs single character at origin", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("A");
			
			const result = generateANSI(buffer);
			expect(result).toBe("A");
		});

		test("outputs consecutive characters without cursor movement", () => {
			const buffer = createBuffer(1, 3);
			buffer[0][0] = Cell.create("A");
			buffer[0][1] = Cell.create("B");
			buffer[0][2] = Cell.create("C");
			
			const result = generateANSI(buffer);
			expect(result).toBe("ABC");
		});

		test("moves cursor for gaps", () => {
			const buffer = createBuffer(1, 5);
			buffer[0][0] = Cell.create("A");
			buffer[0][3] = Cell.create("B");
			
			const result = generateANSI(buffer);
			expect(result).toBe("A\x1b[2CB");
		});
	});

	describe("cursor movement", () => {
		test("uses efficient \\r\\n for line breaks", () => {
			const buffer = createBuffer(3, 2);
			buffer[0][1] = Cell.create("A");
			buffer[1][0] = Cell.create("B");
			buffer[2][0] = Cell.create("C");
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[1CA\r\nB\r\nC");
		});

		test("moves down with correct offsets", () => {
			const buffer = createBuffer(3, 3);
			buffer[0][0] = Cell.create("A");
			buffer[2][2] = Cell.create("B");
			
			const result = generateANSI(buffer);
			// After A at (0,0), cursor is at (0,1). To get to (2,2):
			// Move down 2 rows, then move right 1 column
			expect(result).toBe("A\x1b[2B\x1b[1CB");
		});

		test("moves up when processing in order", () => {
			const buffer = createBuffer(3, 1);
			buffer[0][0] = Cell.create("A");
			buffer[1][0] = Cell.create("B");
			buffer[2][0] = Cell.create("C");
			
			const result = generateANSI(buffer);
			expect(result).toBe("A\r\nB\r\nC");
		});

		test("uses \\r for column 0", () => {
			const buffer = createBuffer(1, 5);
			buffer[0][3] = Cell.create("A");
			buffer[0][0] = Cell.create("B");
			
			const result = generateANSI(buffer);
			// Processing happens left-to-right, so B first at (0,0), then A at (0,3)
			// After B, cursor is at (0,1). To get to A at (0,3), move right 2 columns
			expect(result).toBe("B\x1b[2CA");
		});
	});

	describe("RGB colors", () => {
		test("outputs RGB foreground color", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0xff0000}); // Red
			
			const result = generateANSI(buffer, "rgb");
			expect(result).toBe("\x1b[38;2;255;0;0mX");
		});

		test("outputs RGB background color", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {bg: 0x00ff00}); // Green
			
			const result = generateANSI(buffer, "rgb");
			expect(result).toBe("\x1b[48;2;0;255;0mX");
		});

		test("outputs both fg and bg colors", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0xff0000, bg: 0x0000ff});
			
			const result = generateANSI(buffer, "rgb");
			expect(result).toBe("\x1b[38;2;255;0;0;48;2;0;0;255mX");
		});
	});

	describe("256-color mode", () => {
		test("converts RGB to 256-color palette", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0xff0000}); // Pure red
			
			const result = generateANSI(buffer, "256");
			expect(result).toBe("\x1b[38;5;196mX"); // Red in 256-color palette
		});

		test("handles grayscale conversion", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0x808080}); // Gray
			
			const result = generateANSI(buffer, "256");
			expect(result).toContain("\x1b[38;5;"); // Should be some gray color
		});
	});

	describe("ANSI color mode", () => {
		test("converts to basic 8 colors", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0xff0000}); // Red
			
			const result = generateANSI(buffer, "ansi");
			expect(result).toBe("\x1b[31mX"); // ANSI red foreground
		});

		test("handles background colors", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {bg: 0x00ff00}); // Green
			
			const result = generateANSI(buffer, "ansi");
			expect(result).toBe("\x1b[42mX"); // ANSI green background
		});
	});

	describe("style flags", () => {
		test("outputs bold style", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {bold: true});
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[1mX");
		});

		test("outputs multiple styles", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {bold: true, italic: true, underline: true});
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[1;3;4mX");
		});

		test("outputs all supported styles", () => {
			const buffer = createBuffer(1, 1);
			const allStyles: CellStyle = {
				bold: true,
				dim: true,
				italic: true,
				underline: true,
				blink: true,
				inverse: true,
				strikethrough: true,
				overline: true
			};
			buffer[0][0] = Cell.create("X", allStyles);
			
			const result = generateANSI(buffer);
			// Should contain all the ANSI codes
			expect(result).toContain("[1"); // bold
			expect(result).toContain(";2"); // dim
			expect(result).toContain(";3"); // italic
			expect(result).toContain(";4"); // underline
			expect(result).toContain(";5"); // blink
			expect(result).toContain(";7"); // inverse
			expect(result).toContain(";9"); // strikethrough
			expect(result).toContain(";53"); // overline
		});
	});

	describe("style optimization", () => {
		test("doesn't repeat unchanged styles", () => {
			const buffer = createBuffer(1, 2);
			const style = {fg: 0xff0000, bold: true};
			buffer[0][0] = Cell.create("A", style);
			buffer[0][1] = Cell.create("B", style);
			
			const result = generateANSI(buffer);
			// Style should only be set once at the beginning
			expect(result).toBe("\x1b[38;2;255;0;0;1mAB");
		});

		test("only outputs changed styles", () => {
			const buffer = createBuffer(1, 2);
			buffer[0][0] = Cell.create("A", {fg: 0xff0000});
			buffer[0][1] = Cell.create("B", {fg: 0xff0000, bold: true}); // Same color, add bold
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[38;2;255;0;0mA\x1b[1mB");
		});

		test("resets to default when needed", () => {
			const buffer = createBuffer(1, 2);
			buffer[0][0] = Cell.create("A", {fg: 0xff0000, bold: true});
			buffer[0][1] = Cell.create("B"); // Default style
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[38;2;255;0;0;1mA\x1b[0mB");
		});
	});

	describe("wide characters", () => {
		test("handles wide characters correctly", () => {
			const buffer = createBuffer(1, 4);
			buffer[0][0] = Cell.create("你"); // Wide character
			buffer[0][2] = Cell.create("好"); // Another wide character
			
			const result = generateANSI(buffer);
			expect(result).toContain("你");
			expect(result).toContain("好");
		});

		test("skips second column of wide characters", () => {
			const buffer = createBuffer(1, 3);
			buffer[0][0] = Cell.create("你"); // Wide character takes positions 0,1
			buffer[0][2] = Cell.create("A");
			
			const result = generateANSI(buffer);
			// Should not generate extra cursor movement
			expect(result).toBe("你A");
		});
	});

	describe("edge cases", () => {
		test("handles single cell at far corner", () => {
			const buffer = createBuffer(5, 5);
			buffer[4][4] = Cell.create("X");
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[4B\x1b[4CX");
		});

		test("handles sparse patterns efficiently", () => {
			const buffer = createBuffer(10, 10);
			// Only a few cells in a large buffer
			buffer[2][3] = Cell.create("A");
			buffer[5][7] = Cell.create("B");
			buffer[8][1] = Cell.create("C");
			
			const result = generateANSI(buffer);
			expect(result).toContain("A");
			expect(result).toContain("B");  
			expect(result).toContain("C");
			// Should use cursor movements efficiently
			expect(result.length).toBeLessThan(100);
		});

		test("handles space characters vs empty cells", () => {
			const buffer = createBuffer(1, 3);
			buffer[0][0] = Cell.create("A");
			buffer[0][1] = Cell.create(" "); // Space character
			buffer[0][2] = Cell.create("B");
			// buffer[0][1] is empty (default)
			
			const result = generateANSI(buffer);
			expect(result).toBe("A B"); // Space should be included
		});
	});
});