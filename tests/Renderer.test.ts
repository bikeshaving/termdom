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
		test("renders all content on first frame", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(2, 5);

			renderer.beginFrame();
			renderer.setCell(0, 0, "H");
			renderer.setCell(0, 1, "e");
			renderer.setCell(0, 2, "l");
			renderer.setCell(0, 3, "l");
			renderer.setCell(0, 4, "o");

			const ansi = renderer.render();

			// Test visual result instead of raw ANSI
			const terminal = new TestTerminal({rows: 2, cols: 5});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(ansi, () => resolve());
			});

			expect(terminal.getPlainText()).toBe("Hello");
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
		test("renders only changes in second frame", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 5);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "H");
			renderer.setCell(0, 1, "e");
			renderer.setCell(0, 2, "l");
			renderer.setCell(0, 3, "l");
			renderer.setCell(0, 4, "o");
			const frame1 = renderer.render();

			// Frame 2 - change one character
			renderer.beginFrame();
			renderer.setCell(0, 0, "H");
			renderer.setCell(0, 1, "a"); // Changed
			renderer.setCell(0, 2, "l");
			renderer.setCell(0, 3, "l");
			renderer.setCell(0, 4, "o");
			const frame2 = renderer.render();

			// Apply both frames to terminal and verify result
			const terminal = new TestTerminal({rows: 1, cols: 5});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame2, () => resolve());
			});

			expect(terminal.getPlainText()).toBe("Hallo");
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

		test("renders nothing when no changes", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 3);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(0, 2, "C");
			const frame1 = renderer.render();

			// Frame 2 - same content
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(0, 2, "C");

			const frame2 = renderer.render();

			// Apply both frames to terminal and verify result
			const terminal = new TestTerminal({rows: 1, cols: 3});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame2, () => resolve());
			});

			expect(terminal.getPlainText()).toBe("ABC");
		});

		test("handles clearing cells", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 3);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(0, 2, "C");
			const frame1 = renderer.render();

			// Frame 2 - clear middle cell
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 2, "C");

			const frame2 = renderer.render();

			// Apply both frames and verify visual result
			const terminal = new TestTerminal({rows: 1, cols: 3});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame2, () => resolve());
			});

			// Should show "A C" (middle cell cleared)
			expect(terminal.getPlainText()).toBe("A C");
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
		test("handles out of bounds cells", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(3, 3);

			renderer.beginFrame();
			renderer.setCell(-1, 0, "X"); // Out of bounds
			renderer.setCell(0, -1, "X"); // Out of bounds
			renderer.setCell(3, 0, "X"); // Out of bounds
			renderer.setCell(0, 3, "X"); // Out of bounds
			renderer.setCell(1, 1, "O"); // Valid

			const ansi = renderer.render();

			// Apply to terminal and verify only valid cell is rendered
			const terminal = new TestTerminal({rows: 3, cols: 3});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(ansi, () => resolve());
			});

			const result = terminal.getPlainText();
			expect(result).toContain("O");
			expect(result).not.toContain("X");
		});

		test("handles empty strings", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 1);

			// First set content
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			const frame1 = renderer.render();

			// Then clear with empty string
			renderer.beginFrame();
			renderer.setCell(0, 0, "");
			const frame2 = renderer.render();

			// Apply both frames to terminal
			const terminal = new TestTerminal({rows: 1, cols: 1});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame2, () => resolve());
			});

			expect(terminal.getPlainText()).toBe(" "); // Empty string clears to space
		});

		test("handles unicode characters", () => {
			const renderer = new Renderer(1, 6);

			renderer.beginFrame();
			renderer.setCell(0, 0, "🔥"); // columns 0-1
			renderer.setCell(0, 2, "💧"); // columns 2-3
			renderer.setCell(0, 4, "🌍"); // columns 4-5

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
		test("resets buffer for new frame", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 2);

			// Frame 1
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			const frame1 = renderer.render();

			// Frame 2 - beginFrame without setting cells
			renderer.beginFrame();
			// Don't set any cells
			const frame2 = renderer.render();

			// Apply both frames to terminal
			const terminal = new TestTerminal({rows: 1, cols: 2});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame2, () => resolve());
			});

			// Should clear both cells
			expect(terminal.getPlainText()).toBe("  ");
		});

		test("multiple beginFrame calls work correctly", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 1);

			renderer.beginFrame();
			renderer.beginFrame(); // Called twice
			renderer.setCell(0, 0, "X");

			const ansi = renderer.render();

			// Apply to terminal and verify result
			const terminal = new TestTerminal({rows: 1, cols: 1});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(ansi, () => resolve());
			});

			expect(terminal.getPlainText()).toBe("X");
		});
	});

	describe("Delta Rendering Correctness", () => {
		test("ANSI output produces expected terminal state", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(2, 3);

			// Create target state
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 2, "C");
			renderer.setCell(1, 1, "X");

			const ansi = renderer.render();

			// Apply to clean terminal
			const terminal = new TestTerminal({rows: 2, cols: 3});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(ansi, () => resolve());
			});

			const result = terminal.getVisibleText();

			// Should match expected pattern
			expect(result).toContain("A C");
			expect(result).toContain(" X");
		});

		test("wide character ANSI matches terminal behavior", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 4);

			renderer.beginFrame();
			renderer.setCell(0, 0, "你"); // Takes columns 0,1
			renderer.setCell(0, 2, "A"); // Column 2

			const ansi = renderer.render();
			console.log("Wide char ANSI:", JSON.stringify(ansi));

			const terminal = new TestTerminal({rows: 1, cols: 4});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(ansi, () => resolve());
			});

			const result = terminal.getVisibleText();
			console.log("Terminal result:", JSON.stringify(result));

			// Should contain both characters
			expect(result).toContain("你");
			expect(result).toContain("A");
		});

		test("empty vs space cells behave consistently", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(1, 3);

			// First frame: fill all cells
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(0, 2, "C");
			const firstANSI = renderer.render();

			// Second frame: clear middle cell
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			// Don't set (0,1) - should become null
			renderer.setCell(0, 2, "C");
			const deltaANSI = renderer.render();

			// Apply both frames to terminal
			const terminal = new TestTerminal({rows: 1, cols: 3});

			await new Promise<void>((resolve) => {
				terminal.stdout.write(firstANSI, () => resolve());
			});

			await new Promise<void>((resolve) => {
				terminal.stdout.write(deltaANSI, () => resolve());
			});

			const result = terminal.getVisibleText();

			// Should be "A C" (middle cleared to space)
			expect(result).toBe("A C");
		});
	});

	describe("Regression Tests", () => {
		describe("Bug: Must preserve all rows when updating frame", () => {
			test("clearing cells in one row preserves other rows", async () => {
				const {TestTerminal} = await import("./test-utils.js");
				const renderer = new Renderer(3, 5);

				// Initial state: all cells filled
				renderer.beginFrame();
				for (let r = 0; r < 3; r++) {
					for (let c = 0; c < 5; c++) {
						renderer.setCell(r, c, "#");
					}
				}
				const initial = renderer.render();
				// Test visual result instead of raw ANSI
				const terminal = new TestTerminal({rows: 3, cols: 5});
				await new Promise<void>((resolve) => {
					terminal.stdout.write(initial, () => resolve());
				});

				expect(terminal.getPlainText()).toBe("#####\n#####\n#####");

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

				// Apply delta to the same terminal and verify final result
				await new Promise<void>((resolve) => {
					terminal.stdout.write(delta, () => resolve());
				});

				const result = terminal.getPlainText();
				// Should have cleared cells at positions (0,0) and (0,3) but preserved others
				expect(result).toContain(" ## #\n#####\n#####");
			});
		});

		describe("setCellChar empty string behavior", () => {
			test("empty string creates null cell not space", async () => {
				const {TestTerminal} = await import("./test-utils.js");
				const renderer = new Renderer(1, 3);

				// Set some content
				renderer.beginFrame();
				renderer.setCell(0, 0, "A");
				renderer.setCell(0, 1, "B");
				renderer.setCell(0, 2, "C");
				const frame1 = renderer.render();

				// Clear middle cell with empty string
				renderer.beginFrame();
				renderer.setCell(0, 0, "A");
				renderer.setCell(0, 1, ""); // This should clear
				renderer.setCell(0, 2, "C");
				const frame2 = renderer.render();

				// Apply both frames to terminal
				const terminal = new TestTerminal({rows: 1, cols: 3});
				await new Promise<void>((resolve) => {
					terminal.stdout.write(frame1, () => resolve());
				});
				await new Promise<void>((resolve) => {
					terminal.stdout.write(frame2, () => resolve());
				});

				// Should emit space to clear position 1
				expect(terminal.getPlainText()).toBe("A C");
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
			expect(output).toBe(""); // No ANSI sequences when no changes
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

		test("wide characters render correctly", () => {
			const renderer = new Renderer(2, 5);

			renderer.beginFrame();
			renderer.setCell(0, 0, "你"); // Wide char at column 0 (占用 0,1)
			renderer.setCell(0, 2, "A"); // Normal char at column 2
			renderer.setCell(1, 0, "🚀"); // Wide emoji at column 0

			const output = renderer.render();

			// Output should contain the characters
			expect(output).toContain("你");
			expect(output).toContain("A");
			expect(output).toContain("🚀");

			// Plain text wide characters don't get resets with conditional line reset policy
			expect(output).toMatch(/你A/); // First line
			expect(output).toMatch(/🚀/); // Second line
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
				renderer.setCell(10, 10 + idx + 1, "█", {
					fg: Bun.color("white", "number")!,
				});

				renderer.render();
				keypresses.push(performance.now() - start);
			});

			const avgKeypress =
				keypresses.reduce((a, b) => a + b) / keypresses.length;
			expect(avgKeypress).toBeLessThan(2); // Under 2ms per keypress
		});
	});

	describe("Terminal Resize", () => {
		test("handles resize to larger dimensions", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(2, 2);

			// Initial frame in 2x2
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(1, 0, "C");
			renderer.setCell(1, 1, "D");
			const frame1 = renderer.render();

			// Resize to 3x3 and add new content
			renderer.resize(3, 3);
			renderer.beginFrame();
			renderer.setCell(0, 0, "A"); // Same
			renderer.setCell(0, 1, "B"); // Same
			renderer.setCell(0, 2, "X"); // New column
			renderer.setCell(1, 0, "C"); // Same
			renderer.setCell(1, 1, "D"); // Same
			renderer.setCell(2, 0, "Y"); // New row
			renderer.setCell(2, 2, "Z"); // New cell
			const frame2 = renderer.render();

			// Apply both frames to 3x3 terminal
			const terminal = new TestTerminal({rows: 3, cols: 3});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame2, () => resolve());
			});

			const result = terminal.getPlainText();
			expect(result).toContain("ABX");
			expect(result).toContain("CD");
			expect(result).toContain("Y Z");
		});

		test("handles resize to smaller dimensions", async () => {
			const {TestTerminal} = await import("./test-utils.js");
			const renderer = new Renderer(3, 3);

			// Initial frame in 3x3
			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(0, 2, "X");
			renderer.setCell(1, 0, "C");
			renderer.setCell(1, 1, "D");
			renderer.setCell(2, 0, "Y");
			const frame1 = renderer.render();

			// Apply to 3x3 terminal
			const terminal = new TestTerminal({rows: 3, cols: 3});
			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame1, () => resolve());
			});

			// Resize both renderer and terminal to 2x2
			renderer.resize(2, 2);
			terminal.resize(2, 2);

			// After resize, do a full re-render (clear previous buffer)
			renderer.clearPreviousBuffer();

			renderer.beginFrame();
			renderer.setCell(0, 0, "A");
			renderer.setCell(0, 1, "B");
			renderer.setCell(1, 0, "C");
			renderer.setCell(1, 1, "Z"); // Changed from D to Z
			const frame2 = renderer.render();

			await new Promise<void>((resolve) => {
				terminal.stdout.write(frame2, () => resolve());
			});

			const result = terminal.getPlainText();
			expect(result).toBe("AB\nCZ");
		});

		test("resize affects bounds checking", () => {
			const renderer = new Renderer(2, 2);

			// This should work in 2x2
			renderer.beginFrame();
			renderer.setCell(1, 1, "A");
			expect(renderer.render()).toContain("A");

			// Resize to 1x1 - same cell should now be out of bounds
			renderer.resize(1, 1);
			renderer.beginFrame();
			renderer.setCell(1, 1, "B"); // Should be ignored (out of bounds)
			renderer.setCell(0, 0, "C"); // Should work
			const output = renderer.render();

			expect(output).toContain("C");
			expect(output).not.toContain("B");
		});
	});
});
