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
			expect(result).toBe("A\x1b[0m");
		});

		test("outputs consecutive characters without cursor movement", () => {
			const buffer = createBuffer(1, 3);
			buffer[0][0] = Cell.create("A");
			buffer[0][1] = Cell.create("B");
			buffer[0][2] = Cell.create("C");
			
			const result = generateANSI(buffer);
			expect(result).toBe("ABC\x1b[0m");
		});

		test("moves cursor for gaps", () => {
			const buffer = createBuffer(1, 5);
			buffer[0][0] = Cell.create("A");
			buffer[0][3] = Cell.create("B");
			
			const result = generateANSI(buffer);
			expect(result).toBe("A\x1b[2CB\x1b[0m");
		});
	});

	describe("cursor movement", () => {
		test("uses carriage return for clean line positioning", () => {
			const buffer = createBuffer(3, 2);
			buffer[0][1] = Cell.create("A");
			buffer[1][0] = Cell.create("B");
			buffer[2][0] = Cell.create("C");
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[1CA\x1b[0m\r\nB\x1b[0m\r\nC\x1b[0m");
		});

		test("moves down with correct offsets", () => {
			const buffer = createBuffer(3, 3);
			buffer[0][0] = Cell.create("A");
			buffer[2][2] = Cell.create("B");
			
			const result = generateANSI(buffer);
			// After A at (0,0), cursor is at (0,1). To get to (2,2):
			// Move down 2 rows with newlines, carriage return, then move right 2
			expect(result).toBe("A\x1b[0m\r\n\r\n\x1b[2CB\x1b[0m");
		});

		test("moves up when processing in order", () => {
			const buffer = createBuffer(3, 1);
			buffer[0][0] = Cell.create("A");
			buffer[1][0] = Cell.create("B");
			buffer[2][0] = Cell.create("C");
			
			const result = generateANSI(buffer);
			expect(result).toBe("A\x1b[0m\r\nB\x1b[0m\r\nC\x1b[0m");
		});

		test("uses \\r for column 0", () => {
			const buffer = createBuffer(1, 5);
			buffer[0][3] = Cell.create("A");
			buffer[0][0] = Cell.create("B");
			
			const result = generateANSI(buffer);
			// Processing happens left-to-right, so B first at (0,0), then A at (0,3)
			// After B, cursor is at (0,1). To get to A at (0,3), move right 2 columns
			expect(result).toBe("B\x1b[2CA\x1b[0m");
		});
	});

	describe("RGB colors", () => {
		test("outputs RGB foreground color", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0xff0000}); // Red
			
			const result = generateANSI(buffer, "rgb");
			expect(result).toBe("\x1b[38;2;255;0;0mX\x1b[0m");
		});

		test("outputs RGB background color", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {bg: 0x00ff00}); // Green
			
			const result = generateANSI(buffer, "rgb");
			expect(result).toBe("\x1b[48;2;0;255;0mX\x1b[0m");
		});

		test("outputs both fg and bg colors", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0xff0000, bg: 0x0000ff});
			
			const result = generateANSI(buffer, "rgb");
			expect(result).toBe("\x1b[38;2;255;0;0;48;2;0;0;255mX\x1b[0m");
		});
	});

	describe("256-color mode", () => {
		test("converts RGB to 256-color palette", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0xff0000}); // Pure red
			
			const result = generateANSI(buffer, "256");
			expect(result).toBe("\x1b[38;5;196mX\x1b[0m"); // Red in 256-color palette
		});

		test("handles grayscale conversion", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0x808080}); // Gray
			
			const result = generateANSI(buffer, "256");
			expect(result).toContain("\x1b[38;5;"); // Should be some gray color
			expect(result).toContain("\x1b[0m"); // Should end with reset
		});
	});

	describe("ANSI color mode", () => {
		test("converts to basic 8 colors", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {fg: 0xff0000}); // Red
			
			const result = generateANSI(buffer, "ansi");
			expect(result).toBe("\x1b[31mX\x1b[0m"); // ANSI red foreground
		});

		test("handles background colors", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {bg: 0x00ff00}); // Green
			
			const result = generateANSI(buffer, "ansi");
			expect(result).toBe("\x1b[42mX\x1b[0m"); // ANSI green background
		});
	});

	describe("style flags", () => {
		test("outputs bold style", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {bold: true});
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[1mX\x1b[0m");
		});

		test("outputs multiple styles", () => {
			const buffer = createBuffer(1, 1);
			buffer[0][0] = Cell.create("X", {bold: true, italic: true, underline: true});
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[1;3;4mX\x1b[0m");
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
			expect(result).toBe("\x1b[38;2;255;0;0;1mAB\x1b[0m");
		});

		test("only outputs changed styles", () => {
			const buffer = createBuffer(1, 2);
			buffer[0][0] = Cell.create("A", {fg: 0xff0000});
			buffer[0][1] = Cell.create("B", {fg: 0xff0000, bold: true}); // Same color, add bold
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[38;2;255;0;0mA\x1b[1mB\x1b[0m");
		});

		test("resets to default when needed", () => {
			const buffer = createBuffer(1, 2);
			buffer[0][0] = Cell.create("A", {fg: 0xff0000, bold: true});
			buffer[0][1] = Cell.create("B"); // Default style
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[38;2;255;0;0;1mA\x1b[0mB\x1b[0m");
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
			expect(result).toBe("你A\x1b[0m");
		});
	});

	describe("line resets for truncation robustness", () => {
		test("resets at end of single line", () => {
			const buffer = createBuffer(1, 3);
			buffer[0][0] = Cell.create("A", {fg: 0xff0000});
			buffer[0][1] = Cell.create("B", {fg: 0xff0000});
			buffer[0][2] = Cell.create("C", {fg: 0xff0000});
			
			const result = generateANSI(buffer);
			expect(result).toBe("\x1b[38;2;255;0;0mABC\x1b[0m");
		});

		test("resets at end of each line", () => {
			const buffer = createBuffer(3, 2);
			buffer[0][0] = Cell.create("A", {fg: 0xff0000});
			buffer[0][1] = Cell.create("B", {fg: 0xff0000});
			buffer[1][0] = Cell.create("C", {fg: 0x00ff00});
			buffer[1][1] = Cell.create("D", {fg: 0x00ff00});
			buffer[2][0] = Cell.create("E", {fg: 0x0000ff});
			
			const result = generateANSI(buffer);
			// Each line should end with reset
			expect(result).toContain("AB\x1b[0m");
			expect(result).toContain("CD\x1b[0m");
			expect(result).toContain("E\x1b[0m");
		});

		test("doesn't reset empty lines", () => {
			const buffer = createBuffer(3, 2);
			buffer[0][0] = Cell.create("A");
			// Row 1 is empty
			buffer[2][0] = Cell.create("B");
			
			const result = generateANSI(buffer);
			// Should only have reset after lines with content
			const resetCount = (result.match(/\x1b\[0m/g) || []).length;
			expect(resetCount).toBe(2); // One for each line with content
		});

		test("resets prevent style bleeding across lines", () => {
			const buffer = createBuffer(2, 2);
			buffer[0][0] = Cell.create("A", {fg: 0xff0000, bold: true});
			buffer[1][0] = Cell.create("B"); // Default styling
			
			const result = generateANSI(buffer);
			// First line should have bold red A with reset
			expect(result).toMatch(/\x1b\[38;2;255;0;0;1mA\x1b\[0m/);
			// Second line should start fresh without needing explicit style changes
			expect(result).toContain("B\x1b[0m");
		});

		test("handles mixed styled and unstyled content", () => {
			const buffer = createBuffer(2, 3);
			buffer[0][0] = Cell.create("A", {fg: 0xff0000});
			buffer[0][1] = Cell.create("B"); // No style
			buffer[0][2] = Cell.create("C", {bold: true});
			buffer[1][0] = Cell.create("D"); // New line, no style
			
			const result = generateANSI(buffer);
			expect(result).toMatch(/A\x1b\[0mB\x1b\[1mC\x1b\[0m/);
			expect(result).toContain("D\x1b[0m");
		});
	});

	describe("cursor movement debug", () => {
		test("simple single line with background - no weird movements", () => {
			const buffer = createBuffer(1, 10);
			// Fill a line with background color like the failing tests
			for (let i = 0; i < 10; i++) {
				buffer[0][i] = Cell.create(" ", {bg: 0xff0000}); // Red background spaces
			}
			
			const result = generateANSI(buffer);
			console.log("Single line result:", JSON.stringify(result));
			
			// Should not contain any up/down movements
			expect(result).not.toContain("\x1b[A"); // No up movement
			expect(result).not.toContain("\x1b[B"); // No down movement
			expect(result).toMatch(/^\x1b\[48;2;255;0;0m {10}\x1b\[0m$/);
		});

		test("multiple lines with backgrounds - track cursor properly", () => {
			const buffer = createBuffer(3, 5);
			// Line 1: red background
			for (let i = 0; i < 5; i++) {
				buffer[0][i] = Cell.create(" ", {bg: 0xff0000});
			}
			// Line 2: green background  
			for (let i = 0; i < 5; i++) {
				buffer[1][i] = Cell.create(" ", {bg: 0x00ff00});
			}
			// Line 3: blue background
			for (let i = 0; i < 5; i++) {
				buffer[2][i] = Cell.create(" ", {bg: 0x0000ff});
			}
			
			const result = generateANSI(buffer);
			console.log("Multi-line result:", JSON.stringify(result));
			
			// Should not contain weird cursor movements
			expect(result).not.toMatch(/\x1b\[\d+A\x1b\[\d+C/); // No "up then right" patterns
			
			// Should contain proper line structure
			expect(result).toContain("\x1b[0m"); // Has resets
			expect(result.match(/\x1b\[0m/g)?.length).toBe(3); // Three resets for three lines
		});

		test("sparse cells across multiple lines - minimal reproduction", () => {
			const buffer = createBuffer(3, 10);
			// Just a few cells scattered across lines - mimics real usage
			buffer[0][5] = Cell.create("A", {bg: 0xff0000}); 
			buffer[1][3] = Cell.create("B", {bg: 0x00ff00}); 
			buffer[2][7] = Cell.create("C", {bg: 0x0000ff});
			
			const result = generateANSI(buffer);
			console.log("Sparse result:", JSON.stringify(result));
			
			// Let's trace what should happen:
			// 1. Move to (0,5): \x1b[5C (right 5 from origin)
			// 2. Output A with red background: \x1b[48;2;255;0;0mA
			// 3. Reset: \x1b[0m (cursor now at (0,6))
			// 4. Move to (1,3): down 1, then position at column 3
			//    - Should be: \x1b[1B\x1b[4G (down 1, then absolute column 4 - 1-indexed)
			//    - OR: \x1b[1B\r\x1b[3C (down 1, carriage return, right 3)
			
			// New output should use carriage return: \x1b[1B\r\x1b[3C (down 1, CR, right 3)
			expect(result).not.toMatch(/\x1b\[\d+D/); // Should not have any left movements in sparse case
			expect(result).toContain("\r"); // Should use carriage returns for clean positioning
		});
	});

	describe("edge cases", () => {
		test("handles single cell at far corner", () => {
			const buffer = createBuffer(5, 5);
			buffer[4][4] = Cell.create("X");
			
			const result = generateANSI(buffer);
			expect(result).toBe("\r\n\r\n\r\n\r\n\x1b[4CX\x1b[0m");
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
			// Should have resets for each line
			const resetCount = (result.match(/\x1b\[0m/g) || []).length;
			expect(resetCount).toBe(3);
		});

		test("handles space characters vs empty cells", () => {
			const buffer = createBuffer(1, 3);
			buffer[0][0] = Cell.create("A");
			buffer[0][1] = Cell.create(" "); // Space character
			buffer[0][2] = Cell.create("B");
			// buffer[0][1] is empty (default)
			
			const result = generateANSI(buffer);
			expect(result).toBe("A B\x1b[0m"); // Space should be included, line should reset
		});
	});
});