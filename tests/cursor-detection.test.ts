import {test, expect} from "bun:test";
import {TermDOM} from "../src/index.js";
import {TestTerminal} from "./test-utils.js";

test("detectCommandStart queries and parses cursor position", async () => {
	const terminal = new TestTerminal();

	// Position cursor at row 15 using raw ANSI (1-based coordinates)
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[15;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});

	// This should detect we're at row 15
	const row = await dom.detectCommandStart();
	expect(row).toBe(15);
	expect(dom.commandStartRow).toBe(15);
});

test("detectCommandStart handles different cursor positions", async () => {
	const terminal = new TestTerminal();

	// Position cursor at row 23
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[23;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});

	const row = await dom.detectCommandStart();
	expect(row).toBe(23);
	expect(dom.commandStartRow).toBe(23);
});

test("detectCommandStart handles row 1 (top of terminal)", async () => {
	const terminal = new TestTerminal();

	// Position cursor at top of terminal
	await new Promise<void>((resolve) => {
		terminal.stdout.write("\x1b[1;1H", () => resolve());
	});

	const dom = new TermDOM({process: terminal});

	const row = await dom.detectCommandStart();
	expect(row).toBe(1);
	expect(dom.commandStartRow).toBe(1);
});
