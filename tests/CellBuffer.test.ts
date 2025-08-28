import {test, expect, describe} from "bun:test";
import {
	createBuffer,
	createNullCell,
	isCellEmpty,
	getCellChar,
	getCellWidth,
	setCellChar,
	setCellFg,
	setCellBg,
	copyCell,
	cellsEqual,
	type Cell,
	type CellBuffer,
} from "../src/rendering/CellBuffer.js";

describe("CellBuffer", () => {
	describe("createBuffer", () => {
		test("creates buffer with correct dimensions", () => {
			const buffer = createBuffer(3, 5);
			expect(buffer.length).toBe(3);
			expect(buffer[0].length).toBe(5);
			expect(buffer[1].length).toBe(5);
			expect(buffer[2].length).toBe(5);
		});

		test("initializes all cells as null cells", () => {
			const buffer = createBuffer(2, 2);
			const nullCell = createNullCell();

			for (let row = 0; row < 2; row++) {
				for (let col = 0; col < 2; col++) {
					expect(buffer[row][col]).toEqual(nullCell);
				}
			}
		});
	});

	describe("createNullCell", () => {
		test("creates empty cell", () => {
			const cell = createNullCell();
			expect(isCellEmpty(cell)).toBe(true);
			expect(getCellChar(cell)).toBe("");
			expect(getCellWidth(cell)).toBe(0);
		});
	});

	describe("isCellEmpty", () => {
		test("returns true for null cell", () => {
			const cell = createNullCell();
			expect(isCellEmpty(cell)).toBe(true);
		});

		test("returns false for cell with character", () => {
			const cell = createNullCell();
			setCellChar(cell, "A");
			expect(isCellEmpty(cell)).toBe(false);
		});

		test("returns true for cell with only style", () => {
			const cell = createNullCell();
			setCellFg(cell, 0xff0000);
			expect(isCellEmpty(cell)).toBe(true);
		});
	});

	describe("getCellChar", () => {
		test("returns empty string for null cell", () => {
			const cell = createNullCell();
			expect(getCellChar(cell)).toBe("");
		});

		test("returns character from cell", () => {
			const cell = createNullCell();
			setCellChar(cell, "X");
			expect(getCellChar(cell)).toBe("X");
		});

		test("handles Unicode characters", () => {
			const cell = createNullCell();
			setCellChar(cell, "🔥");
			expect(getCellChar(cell)).toBe("🔥");
		});
	});

	describe("getCellWidth", () => {
		test("returns 0 for null cell", () => {
			const cell = createNullCell();
			expect(getCellWidth(cell)).toBe(0);
		});

		test("returns 1 for normal character", () => {
			const cell = createNullCell();
			setCellChar(cell, "A");
			expect(getCellWidth(cell)).toBe(1);
		});
	});

	describe("setCellChar", () => {
		test("sets character making cell non-empty", () => {
			const cell = createNullCell();
			setCellChar(cell, "B");

			expect(getCellChar(cell)).toBe("B");
			expect(getCellWidth(cell)).toBe(1);
			expect(isCellEmpty(cell)).toBe(false);
		});

		test("handles empty string by creating null cell", () => {
			const cell = createNullCell();
			setCellChar(cell, "");

			expect(getCellChar(cell)).toBe("");
			expect(isCellEmpty(cell)).toBe(true);
		});
	});

	describe("setCellFg", () => {
		test("changes cell when setting foreground color", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();

			setCellFg(cell1, 0xff5733);

			expect(cellsEqual(cell1, cell2)).toBe(false);
		});

		test("different colors result in different cells", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();

			setCellFg(cell1, 0xff0000);
			setCellFg(cell2, 0x00ff00);

			expect(cellsEqual(cell1, cell2)).toBe(false);
		});
	});

	describe("setCellBg", () => {
		test("changes cell when setting background color", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();

			setCellBg(cell1, 0x3366ff);

			expect(cellsEqual(cell1, cell2)).toBe(false);
		});

		test("different colors result in different cells", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();

			setCellBg(cell1, 0xff0000);
			setCellBg(cell2, 0x00ff00);

			expect(cellsEqual(cell1, cell2)).toBe(false);
		});
	});

	describe("copyCell", () => {
		test("copies all cell data", () => {
			const src = createNullCell();
			setCellChar(src, "Q");
			setCellFg(src, 0xff0000);
			setCellBg(src, 0x00ff00);

			const dest = createNullCell();
			copyCell(src, dest);

			expect(cellsEqual(dest, src)).toBe(true);
			expect(getCellChar(dest)).toBe("Q");
		});

		test("overwrites destination cell completely", () => {
			const src = createNullCell();
			setCellChar(src, "A");

			const dest = createNullCell();
			setCellChar(dest, "B");
			setCellFg(dest, 0xffffff);

			copyCell(src, dest);

			expect(getCellChar(dest)).toBe("A");
			expect(cellsEqual(dest, src)).toBe(true);
		});
	});

	describe("cellsEqual", () => {
		test("returns true for identical cells", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();
			expect(cellsEqual(cell1, cell2)).toBe(true);
		});

		test("returns true for cells with same data", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();

			setCellChar(cell1, "X");
			setCellFg(cell1, 0xff0000);

			setCellChar(cell2, "X");
			setCellFg(cell2, 0xff0000);

			expect(cellsEqual(cell1, cell2)).toBe(true);
		});

		test("returns false for different content", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();

			setCellChar(cell1, "A");
			setCellChar(cell2, "B");

			expect(cellsEqual(cell1, cell2)).toBe(false);
		});

		test("returns false for different fg color", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();

			setCellFg(cell1, 0xff0000);
			setCellFg(cell2, 0x00ff00);

			expect(cellsEqual(cell1, cell2)).toBe(false);
		});

		test("returns false for different bg color", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();

			setCellBg(cell1, 0xff0000);
			setCellBg(cell2, 0x00ff00);

			expect(cellsEqual(cell1, cell2)).toBe(false);
		});
	});

	describe("Performance", () => {
		test("creating large buffers is fast", () => {
			const start = performance.now();

			const buffer = createBuffer(100, 100);

			const elapsed = performance.now() - start;
			expect(elapsed).toBeLessThan(10); // Should be under 10ms
			expect(buffer.length).toBe(100);
			expect(buffer[0].length).toBe(100);
		});

		test("bulk cell operations are efficient", () => {
			const buffer = createBuffer(50, 50);
			const start = performance.now();

			// Fill entire buffer
			for (let row = 0; row < 50; row++) {
				for (let col = 0; col < 50; col++) {
					setCellChar(buffer[row][col], "X");
					setCellFg(buffer[row][col], 0xff0000);
				}
			}

			const elapsed = performance.now() - start;
			expect(elapsed).toBeLessThan(20); // Should be under 20ms for 2500 cells
		});

		test("cell comparison is fast", () => {
			const cell1 = createNullCell();
			const cell2 = createNullCell();
			setCellChar(cell1, "A");
			setCellChar(cell2, "B");

			const start = performance.now();
			let equalCount = 0;

			// 100k comparisons
			for (let i = 0; i < 100000; i++) {
				if (cellsEqual(cell1, cell2)) {
					equalCount++;
				}
			}

			const elapsed = performance.now() - start;
			expect(elapsed).toBeLessThan(50); // Should be under 50ms for 100k comparisons
			expect(equalCount).toBe(0);
		});

		test("cell copying is efficient", () => {
			const src = createNullCell();
			setCellChar(src, "X");
			setCellFg(src, 0xff0000);
			setCellBg(src, 0x00ff00);

			const start = performance.now();

			// 100k copies
			for (let i = 0; i < 100000; i++) {
				const dest = createNullCell();
				copyCell(src, dest);
			}

			const elapsed = performance.now() - start;
			expect(elapsed).toBeLessThan(50); // Should be under 50ms
		});

		test("cell arrays use minimal memory", () => {
			const cell = createNullCell();

			// Each cell is [string, number, number, number]
			expect(cell.length).toBe(4);
			expect(typeof cell[0]).toBe("string");
			expect(typeof cell[1]).toBe("number");
			expect(typeof cell[2]).toBe("number");
			expect(typeof cell[3]).toBe("number");
		});

		test("buffer memory scales linearly", () => {
			if (typeof process !== "undefined" && process.memoryUsage) {
				const initialMemory = process.memoryUsage().heapUsed;

				// Create a large buffer
				const buffer = createBuffer(200, 200);

				const memoryUsed = process.memoryUsage().heapUsed - initialMemory;

				// 40k cells * 4 numbers * 8 bytes ≈ 1.3MB
				// Allow for some overhead
				expect(memoryUsed).toBeLessThan(3_000_000); // Under 3MB
			}
		});
	});
});
