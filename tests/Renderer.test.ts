import {test, expect, describe} from "bun:test";
import {Renderer} from "../src/rendering/Renderer.js";

describe("Renderer", () => {
	describe("initialization", () => {
		test("creates renderer with specified dimensions", () => {
			const renderer = new Renderer(5, 10);
			// First render should output everything
			renderer.beginFrame();
			renderer.setCell(0, 0, "X");
			const output = renderer.render();
			expect(output).toContain("X");
		});
	});

	describe("first frame", () => {
		test("renders all content on first frame", () => {
			const renderer = new Renderer(2, 5);

			renderer.beginFrame();
			renderer.setCell(0, 0, "H");
			renderer.setCell(0, 1, "e");
			renderer.setCell(0, 2, "l");
			renderer.setCell(0, 3, "l");
			renderer.setCell(0, 4, "o");

			const output = renderer.render();
			expect(output).toBe("Hello");
		});

		test("renders styled content on first frame", () => {
			const renderer = new Renderer(1, 3);

			renderer.beginFrame();
			renderer.setCell(0, 0, "A", {fg: Bun.color("red", "number")!});
			renderer.setCell(0, 1, "B", {bold: true});
			renderer.setCell(0, 2, "C", {bg: Bun.color("blue", "number")!});

			const output = renderer.render();
			expect(output).toContain("A");
			expect(output).toContain("B");
			expect(output).toContain("C");
			expect(output).toContain("\x1b[38;2;255;0;0m"); // red
			expect(output).toContain("39"); // default fg
			expect(output).toContain("1"); // bold
			expect(output).toContain("48;2;0;0;255"); // blue bg
			expect(output).toContain("22"); // turn off bold
		});
	});

	describe("delta rendering", () => {
		test("renders only changes in second frame", () => {
			const renderer = new Renderer(1, 5);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "H");
			renderer.setCell(0, 1, "e");
			renderer.setCell(0, 2, "l");
			renderer.setCell(0, 3, "l");
			renderer.setCell(0, 4, "o");
			renderer.render();

			// Frame 2 - change one character
			renderer.beginFrame();
			renderer.setCell(0, 0, "H");
			renderer.setCell(0, 1, "a"); // Changed
			renderer.setCell(0, 2, "l");
			renderer.setCell(0, 3, "l");
			renderer.setCell(0, 4, "o");

			const output = renderer.render();
			expect(output).toBe("\x1b[1Ca"); // Move right 1, print 'a'
		});

		test("handles multiple scattered changes", () => {
			const renderer = new Renderer(3, 3);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(1, 1, "B");
			renderer.setCell(2, 2, "C");
			renderer.render();

			// Frame 2 - change all to different positions
			renderer.beginFrame();
			renderer.setCell(0, 2, "X");
			renderer.setCell(1, 0, "Y");
			renderer.setCell(2, 1, "Z");

			const output = renderer.render();
			expect(output).toContain("X");
			expect(output).toContain("Y");
			expect(output).toContain("Z");
			// Should not contain original A, B, C
			expect(output).not.toContain("ABC");
		});

		test("renders nothing when no changes", () => {
			const renderer = new Renderer(1, 3);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(0, 2, "C");
			renderer.render();

			// Frame 2 - same content
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(0, 2, "C");

			const output = renderer.render();
			expect(output).toBe("");
		});

		test("handles clearing cells", () => {
			const renderer = new Renderer(1, 3);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(0, 2, "C");
			renderer.render();

			// Frame 2 - clear middle cell
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 2, "C");

			const output = renderer.render();
			// Should move to position 1 and clear it with space
			expect(output).toBe("\x1b[1C ");
		});
	});

	describe("styling", () => {
		test("applies color from string", () => {
			const renderer = new Renderer(1, 1);

			renderer.beginFrame();
			renderer.setCell(0, 0, "X", {fg: Bun.color("red", "number")!});

			const output = renderer.render();
			expect(output).toContain("\x1b[38;2;255;0;0m");
		});

		test("applies color from number", () => {
			const renderer = new Renderer(1, 1);

			renderer.beginFrame();
			renderer.setCell(0, 0, "X", {fg: 0x00ff00});

			const output = renderer.render();
			expect(output).toContain("\x1b[38;2;0;255;0m");
		});

		test("applies multiple styles", () => {
			const renderer = new Renderer(1, 1);

			renderer.beginFrame();
			renderer.setCell(0, 0, "X", {
				bold: true,
				underline: true,
				italic: true,
			});

			const output = renderer.render();
			expect(output).toContain("1"); // bold
			expect(output).toContain("3"); // italic
			expect(output).toContain("4"); // underline
		});

		test("detects style changes", () => {
			const renderer = new Renderer(1, 2);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "A", {fg: Bun.color("red", "number")!});
			renderer.setCell(0, 1, "B", {fg: Bun.color("blue", "number")!});
			renderer.render();

			// Frame 2 - swap colors
			renderer.beginFrame();
			renderer.setCell(0, 0, "A", {fg: Bun.color("blue", "number")!});
			renderer.setCell(0, 1, "B", {fg: Bun.color("red", "number")!});

			const output = renderer.render();
			// Should re-render both cells with new colors
			expect(output).toContain("\x1b[38;2;0;0;255mA"); // blue A
			expect(output).toContain("\x1b[38;2;255;0;0mB"); // red B
		});

		test("all style flags work", () => {
			const renderer = new Renderer(1, 1);

			const styles = [
				{bold: true},
				{italic: true},
				{underline: true},
				{strikethrough: true},
				{inverse: true},
				{dim: true},
				{blink: true},
				{overline: true},
			];

			styles.forEach((style) => {
				renderer.beginFrame();
				renderer.setCell(0, 0, "X", style);
				const output = renderer.render();
				expect(output).toContain("\x1b["); // Has some escape sequence
				expect(output).toContain("X");
			});
		});
	});

	describe("edge cases", () => {
		test("handles out of bounds cells", () => {
			const renderer = new Renderer(3, 3);

			renderer.beginFrame();
			renderer.setCell(-1, 0, "X"); // Out of bounds
			renderer.setCell(0, -1, "X"); // Out of bounds
			renderer.setCell(3, 0, "X"); // Out of bounds
			renderer.setCell(0, 3, "X"); // Out of bounds
			renderer.setCell(1, 1, "O"); // Valid

			const output = renderer.render();
			expect(output).toBe("\x1b[1B\x1b[1CO");
		});

		test("handles empty strings", () => {
			const renderer = new Renderer(1, 1);

			// First set content
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.render();

			// Then clear with empty string
			renderer.beginFrame();
			renderer.setCell(0, 0, "");

			const output = renderer.render();
			expect(output).toBe(" "); // Empty string clears to space
		});

		test("handles unicode characters", () => {
			const renderer = new Renderer(1, 6);

			renderer.beginFrame();
			renderer.setCell(0, 0, "🔥");  // columns 0-1
			renderer.setCell(0, 2, "💧");  // columns 2-3
			renderer.setCell(0, 4, "🌍");  // columns 4-5

			const output = renderer.render();
			expect(output).toContain("🔥");
			expect(output).toContain("💧");
			expect(output).toContain("🌍");
		});

		test("handles complete clear", () => {
			const renderer = new Renderer(2, 2);

			// Frame 1 - fill everything
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(1, 0, "C");
			renderer.setCell(1, 1, "D");
			renderer.render();

			// Frame 2 - clear everything
			renderer.beginFrame();

			const output = renderer.render();
			// Should clear all cells
			expect(output).toContain(" ");
			expect(output.match(/ /g)?.length).toBeGreaterThanOrEqual(4);
		});
	});

	describe("beginFrame", () => {
		test("resets buffer for new frame", () => {
			const renderer = new Renderer(1, 2);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.render();

			// Frame 2 - beginFrame without setting cells
			renderer.beginFrame();
			// Don't set any cells

			const output = renderer.render();
			// Should clear both cells
			expect(output).toBe("  ");
		});

		test("multiple beginFrame calls work correctly", () => {
			const renderer = new Renderer(1, 1);

			renderer.beginFrame();
			renderer.beginFrame(); // Called twice
			renderer.setCell(0, 0, "X");

			const output = renderer.render();
			expect(output).toBe("X");
		});
	});

	describe("Regression Tests", () => {
		describe("Bug: Must preserve all rows when updating frame", () => {
			test("clearing cells in one row preserves other rows", () => {
				const renderer = new Renderer(3, 5);

				// Initial state: all cells filled
				renderer.beginFrame();
				for (let r = 0; r < 3; r++) {
					for (let c = 0; c < 5; c++) {
						renderer.setCell(r, c, "#");
					}
				}
				const initial = renderer.render();
				expect(initial).toBe("#####\r\n#####\r\n#####");

				// Clear two cells in row 0, but must preserve rows 1 and 2
				renderer.beginFrame();
				// Fix: must preserve ALL rows
				for (let r = 0; r < 3; r++) {
					for (let c = 0; c < 5; c++) {
						// Skip cells we want to clear
						if (r === 0 && (c === 0 || c === 3)) continue;
						renderer.setCell(r, c, "#");
					}
				}

				const delta = renderer.render();
				// Should only emit changes for cleared cells
				expect(delta).toBe(" \x1b[2C ");
			});
		});

		describe("setCellChar empty string behavior", () => {
			test("empty string creates null cell not space", () => {
				const renderer = new Renderer(1, 3);

				// Set some content
				renderer.beginFrame();
				renderer.setCell(0, 0, "A");
				renderer.setCell(0, 1, "B");
				renderer.setCell(0, 2, "C");
				renderer.render();

				// Clear middle cell with empty string
				renderer.beginFrame();
				renderer.setCell(0, 0, "A");
				renderer.setCell(0, 1, ""); // This should clear
				renderer.setCell(0, 2, "C");

				const delta = renderer.render();
				// Should emit space to clear position 1
				expect(delta).toBe("\x1b[1C ");
			});
		});
	});

	describe("Performance", () => {
		test("sparse changes are efficient", () => {
			const renderer = new Renderer(100, 100);

			// Initial frame - full render
			renderer.beginFrame();
			for (let i = 0; i < 100; i++) {
				renderer.setCell(i, i, "X");
			}
			renderer.render();

			// Sparse change
			renderer.beginFrame();
			const start = performance.now();

			// Only change 10 cells
			for (let i = 0; i < 10; i++) {
				renderer.setCell(i * 10, i * 10, "O");
			}

			const output = renderer.render();
			const elapsed = performance.now() - start;

			expect(elapsed).toBeLessThan(5); // Should be very fast
			expect(output).toContain("O"); // Should contain the changes
		});

		test("no changes produce empty output quickly", () => {
			const renderer = new Renderer(50, 50);

			// Initial frame
			renderer.beginFrame();
			for (let row = 0; row < 50; row++) {
				for (let col = 0; col < 50; col++) {
					renderer.setCell(row, col, "#");
				}
			}
			renderer.render();

			// Same content
			renderer.beginFrame();
			const start = performance.now();

			for (let row = 0; row < 50; row++) {
				for (let col = 0; col < 50; col++) {
					renderer.setCell(row, col, "#");
				}
			}

			const output = renderer.render();
			const elapsed = performance.now() - start;

			expect(elapsed).toBeLessThan(20); // Should detect no changes quickly
			expect(output).toBe("");
		});

		test("handles animation patterns efficiently", () => {
			const renderer = new Renderer(20, 80);

			// Simulate 60fps animation for 1 second
			const frames: number[] = [];

			for (let frame = 0; frame < 60; frame++) {
				renderer.beginFrame();
				const start = performance.now();

				// Moving wave pattern
				for (let col = 0; col < 80; col++) {
					const row = Math.floor(10 + 5 * Math.sin((col + frame) * 0.1));
					renderer.setCell(row, col, "~", {fg: Bun.color("blue", "number")!});
				}

				renderer.render();
				const elapsed = performance.now() - start;
				frames.push(elapsed);
			}

			// Average frame time
			const avgTime = frames.reduce((a, b) => a + b) / frames.length;
			expect(avgTime).toBeLessThan(5); // Should average under 5ms per frame

			// No frame should spike too high
			const maxTime = Math.max(...frames);
			expect(maxTime).toBeLessThan(20); // No frame over 20ms
		});

		test("terminal UI update performance", () => {
			const renderer = new Renderer(24, 80); // Standard terminal size

			// Initial UI
			renderer.beginFrame();

			// Title bar
			for (let col = 0; col < 80; col++) {
				renderer.setCell(0, col, "─", {fg: Bun.color("white", "number")!});
			}
			renderer.setCell(0, 0, "┌");
			renderer.setCell(0, 79, "┐");

			// Status bar
			for (let col = 0; col < 80; col++) {
				renderer.setCell(23, col, "─", {fg: Bun.color("white", "number")!});
			}

			renderer.render();

			// Simulate typing - each keypress updates cursor and adds char
			const keypresses: number[] = [];
			const text = "The quick brown fox jumps over the lazy dog";

			text.split("").forEach((char, idx) => {
				renderer.beginFrame();
				const start = performance.now();

				// Redraw UI elements
				for (let col = 0; col < 80; col++) {
					renderer.setCell(0, col, "─", {fg: Bun.color("white", "number")!});
					renderer.setCell(23, col, "─", {fg: Bun.color("white", "number")!});
				}

				// Add typed text
				for (let i = 0; i <= idx; i++) {
					renderer.setCell(10, 10 + i, text[i]);
				}

				// Cursor
				renderer.setCell(10, 10 + idx + 1, "█", {fg: Bun.color("white", "number")!});

				renderer.render();
				keypresses.push(performance.now() - start);
			});

			const avgKeypress =
				keypresses.reduce((a, b) => a + b) / keypresses.length;
			expect(avgKeypress).toBeLessThan(2); // Under 2ms per keypress
		});
	});
});
