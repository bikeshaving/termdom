/**
 * Debug test to understand wide character handling differences
 */

import {test, expect, describe} from "bun:test";
import {TestTerminal} from "./test-utils.js";
import {generateANSI} from "../src/rendering/Renderer.js";
import {Cell, createBuffer} from "../src/rendering/CellBuffer.js";

describe("Debug delta rendering", () => {
	test("Simple wide character test", async () => {
		const buffer = createBuffer(2, 5);

		// Place a wide character at (0, 0) - should occupy columns 0 and 1
		buffer[0][0] = Cell.create("你");
		// Place normal character at (0, 2)
		buffer[0][2] = Cell.create("A");
		// Place another wide char at (1, 0)
		buffer[1][0] = Cell.create("🚀");

		console.log("Buffer content:");
		for (let r = 0; r < 2; r++) {
			let row = "";
			for (let c = 0; c < 5; c++) {
				const cell = buffer[r][c];
				row += cell ? `[${cell.grapheme}]` : "[null]";
			}
			console.log(`Row ${r}: ${row}`);
		}

		// Generate ANSI
		const ansi = generateANSI(buffer);
		console.log("Generated ANSI:", JSON.stringify(ansi));

		// Apply to terminal
		const terminal = new TestTerminal({rows: 2, cols: 5});
		await new Promise<void>((resolve) => {
			terminal.stdout.write(ansi, () => resolve());
		});

		const result = terminal.getVisibleText();
		console.log("Terminal result:", JSON.stringify(result));

		// Expected: 你 should occupy positions 0,1. A should be at position 2
		// Row 0: "你 A  " (你 takes 2 chars, space, A, space)
		// Row 1: "🚀   " (🚀 takes 2 chars, 3 spaces)

		const lines = result.split("\n");
		console.log("Line 0:", JSON.stringify(lines[0]));
		console.log("Line 1:", JSON.stringify(lines[1]));
	});

	test("Test what xterm does with our Cell widths", () => {
		const cell1 = Cell.create("你");
		const cell2 = Cell.create("🚀");
		const cell3 = Cell.create("A");

		console.log("Cell 你 - width:", cell1.width, "isWide:", cell1.isWide);
		console.log("Cell 🚀 - width:", cell2.width, "isWide:", cell2.isWide);
		console.log("Cell A - width:", cell3.width, "isWide:", cell3.isWide);

		console.log("Bun.stringWidth results:");
		console.log("Bun.stringWidth('你'):", Bun.stringWidth("你"));
		console.log("Bun.stringWidth('🚀'):", Bun.stringWidth("🚀"));
		console.log("Bun.stringWidth('A'):", Bun.stringWidth("A"));
	});
});
