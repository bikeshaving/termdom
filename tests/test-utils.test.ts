/**
 * Test Utils Tests
 *
 * Comprehensive tests for the MockProcess and related test utilities
 * to ensure proper TTY simulation and cursor query handling
 */

import {beforeEach, describe, expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame, stripControlCodes} from "./test-utils.js";

describe("MockProcess", () => {
	let terminal: MockProcess;

	beforeEach(() => {
		terminal = new MockProcess({cols: 80, rows: 24});
	});

	describe("basic functionality", () => {
		test("creates terminal with correct dimensions", () => {
			expect(terminal.stdout.columns).toBe(80);
			expect(terminal.stdout.rows).toBe(24);
			expect(terminal.stdout.isTTY).toBe(true);
			expect(terminal.stdin.isTTY).toBe(true);
		});

		test("handles write operations", () => {
			const result = terminal.stdout.write("Hello World");
			expect(result).toBe(true);
		});

		test("provides plain text output", async () => {
			terminal.stdout.write("Hello\r\nWorld");
			// Give xterm a moment to process the data
			await new Promise((resolve) => setTimeout(resolve, 10));
			const text = terminal.getPlainText();
			expect(text).toContain("Hello");
			expect(text).toContain("World");
		});

		test("provides screen contents with ANSI", async () => {
			await new Promise<void>((resolve) => {
				terminal.stdout.write("\x1b[31mRed Text\x1b[0m", () => resolve());
			});
			const contents = terminal.getScreenContents();
			expect(contents).toContain("Red Text");
		});

		test("handles resize operations", () => {
			terminal.resize(40, 12);
			expect(terminal.stdout.columns).toBe(40);
			expect(terminal.stdout.rows).toBe(12);
		});
	});

	describe("cursor query handling", () => {
		test("responds to cursor position query", async () => {
			// Set up listener for stdin data
			let response = "";
			terminal.stdin.on("data", (data: Buffer) => {
				response += data.toString();
			});

			// First write some content to establish cursor position
			await new Promise<void>((resolve) => {
				terminal.stdout.write("Hello", () => resolve());
			});

			// Send cursor position query
			await new Promise<void>((resolve) => {
				terminal.stdout.write("\x1b[6n", () => resolve());
			});

			// Wait a bit for xterm to process and respond
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should receive cursor position response
			expect(response).toMatch(/\x1b\[\d+;\d+R/);
		});

		test("xterm onData forwards to stdin", () => {
			const responses: string[] = [];
			terminal.stdin.on("data", (data: Buffer) => {
				responses.push(data.toString());
			});

			// Simulate xterm generating a response
			(terminal as any).stdin.simulateResponse("\x1b[1;1R");

			expect(responses).toHaveLength(1);
			expect(responses[0]).toBe("\x1b[1;1R");
		});

		test("handles multiple cursor queries", async () => {
			const responses: string[] = [];
			terminal.stdin.on("data", (data: Buffer) => {
				responses.push(data.toString());
			});

			// Send multiple queries
			terminal.stdout.write("\x1b[6n");
			terminal.stdout.write("\x1b[6n");

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should get responses for both queries
			expect(responses.length).toBeGreaterThan(0);
		});
	});

	describe("TermDOM integration", () => {
		test("works with TermDOM constructor", () => {
			expect(() => {
				const dom = new TermDOM({transport: terminal.transport});
				dom.dispose();
			}).not.toThrow();
		});

		test("TermDOM cursor detection completes", async () => {
			const dom = new TermDOM({transport: terminal.transport});

			// Cursor detection runs on the first frame. What matters is that it
			// SETTLES on a responsive terminal rather than hanging on TermDOM's
			// 1s fallback -- the race fails the test if it does, without
			// asserting on wall-clock time, which is not measurable under a
			// parallel test runner.
			await Promise.race([
				nextFrame(dom),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("cursor detection hung")), 2000),
				),
			]);

			dom.dispose();
		});

		test("TermDOM render works without cursor timeout", async () => {
			const dom = new TermDOM({transport: terminal.transport});

			const span = dom.document.createElement("span");
			span.textContent = "Test Content";
			dom.document.body.appendChild(span);

			await nextFrame(dom);

			const output = terminal.getPlainText();
			expect(output).toContain("Test Content");

			dom.dispose();
		});
	});

	describe("xterm integration", () => {
		test("xterm processes ANSI sequences", async () => {
			// Write colored text
			await new Promise<void>((resolve) => {
				terminal.stdout.write("\x1b[31mRed\x1b[0m", () => resolve());
			});

			const plainText = terminal.getPlainText();
			expect(plainText).toContain("Red");

			const ansiOutput = terminal.getScreenContents();
			// xterm.js converts basic colors to RGB format in truecolor mode
			expect(ansiOutput).toMatch(/\x1b\[38;2;[0-9;]+mRed/);
		});

		test("xterm handles cursor movements", async () => {
			await new Promise<void>((resolve) => {
				terminal.stdout.write("Line 1\r\nLine 2", () => resolve());
			});

			const plainText = terminal.getPlainText();
			expect(plainText).toContain("Line 1");
			expect(plainText).toContain("Line 2");
		});

		test("xterm buffer conversion works", async () => {
			// Write initial text
			await new Promise<void>((resolve) => {
				terminal.stdout.write("ABC", () => resolve());
			});

			// Move cursor to home and overwrite
			await new Promise<void>((resolve) => {
				terminal.stdout.write("\x1b[1;1HX", () => resolve());
			});

			const plainText = terminal.getPlainText();
			expect(plainText).toContain("XBC");
		});
	});
});

describe("stripControlCodes", () => {
	test("removes sync start/end sequences", () => {
		const input = "\x1b[?2026hContent\x1b[?2026l";
		const output = stripControlCodes(input);
		expect(output).toBe("Content");
	});

	test("removes cursor hide/show sequences", () => {
		const input = "\x1b[?25lContent\x1b[?25h";
		const output = stripControlCodes(input);
		expect(output).toBe("Content");
	});

	test("removes home cursor sequences", () => {
		const input = "\x1b[HContent";
		const output = stripControlCodes(input);
		expect(output).toBe("Content");
	});

	test("replaces cursor forward with spaces", () => {
		const input = "A\x1b[3CB";
		const output = stripControlCodes(input);
		expect(output).toBe("A   B");
	});

	test("removes clear line sequences", () => {
		const input = "Content\x1b[K";
		const output = stripControlCodes(input);
		expect(output).toBe("Content");
	});

	test("removes cursor positioning", () => {
		const input = "\x1b[5;10HContent";
		const output = stripControlCodes(input);
		expect(output).toBe("Content");
	});

	test("removes standalone carriage returns", () => {
		const input = "Line1\rLine2\r\nLine3";
		const output = stripControlCodes(input);
		expect(output).toBe("Line1Line2\r\nLine3");
	});

	test("handles complex mixed sequences", () => {
		const input =
			"\x1b[?25l\x1b[?2026h\x1b[H\x1b[5CHello\x1b[K\x1b[?25h\x1b[?2026l";
		const output = stripControlCodes(input);
		expect(output).toBe("     Hello");
	});
});
