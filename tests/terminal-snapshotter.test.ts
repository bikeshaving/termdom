/**
 * Tests for TestTerminal
 *
 * Basic tests for the xterm.js-based TestTerminal class
 */

import {test, expect, describe} from "bun:test";
import {TestTerminal} from "./test-utils.js";

describe("TestTerminal", () => {
	describe("basic functionality", () => {
		test("creates empty terminal initially", () => {
			const terminal = new TestTerminal({cols: 10, rows: 5});
			const contents = terminal.getScreenContents();

			// Empty screen should be empty
			expect(terminal.getVisibleText().trim()).toBe("");
		});

		test("captures written text", () => {
			const terminal = new TestTerminal({cols: 20, rows: 3});

			// Write some text
			terminal.stdout.write("Hello World");

			const visibleText = terminal.getVisibleText();
			expect(visibleText).toContain("Hello World");
		});

		test("handles ANSI color codes", () => {
			const terminal = new TestTerminal({cols: 20, rows: 5});

			// Write colored text
			terminal.stdout.write("\u001b[31mRed text\u001b[0m");

			const contents = terminal.getScreenContents();
			expect(contents).toContain("\u001b[31m");
			expect(contents).toContain("Red text");
			expect(contents).toContain("\u001b[0m");

			const visibleText = terminal.getVisibleText();
			expect(visibleText).toContain("Red text");
		});

		test("can clear terminal", () => {
			const terminal = new TestTerminal({cols: 20, rows: 3});

			// Write some text
			terminal.stdout.write("Hello World");
			expect(terminal.getVisibleText()).toContain("Hello World");

			// Clear and check
			terminal.clear();
			expect(terminal.getVisibleText().trim()).toBe("");
		});
	});

	describe("write callback handling", () => {
		test("calls callback after write completes", async () => {
			const terminal = new TestTerminal();
			let callbackCalled = false;

			// Write with callback
			await new Promise<void>((resolve, reject) => {
				terminal.stdout.write("Test", (error) => {
					if (error) {
						reject(error);
					} else {
						callbackCalled = true;
						resolve();
					}
				});
			});

			expect(callbackCalled).toBe(true);
			expect(terminal.getVisibleText()).toContain("Test");
		});

		test("handles encoding parameter correctly", async () => {
			const terminal = new TestTerminal();

			// Write with encoding parameter
			await new Promise<void>((resolve, reject) => {
				terminal.stdout.write("Test", "utf8", (error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});

			expect(terminal.getVisibleText()).toContain("Test");
		});
	});

	describe("process interface", () => {
		test("implements ProcessLike interface", () => {
			const terminal = new TestTerminal();

			expect(terminal.stdout).toBeDefined();
			expect(terminal.stdout.isTTY).toBe(true);
			expect(terminal.stdout.columns).toBe(80);
			expect(terminal.stdout.rows).toBe(24);
			expect(typeof terminal.exit).toBe("function");
		});

		test("exit method throws", () => {
			const terminal = new TestTerminal();

			expect(() => terminal.exit(0)).toThrow("Mock process.exit(0)");
			expect(() => terminal.exit(1)).toThrow("Mock process.exit(1)");
			expect(() => terminal.exit()).toThrow("Mock process.exit(0)");
		});
	});

	describe("terminal dimensions", () => {
		test("uses default dimensions", () => {
			const terminal = new TestTerminal();

			expect(terminal.stdout.columns).toBe(80);
			expect(terminal.stdout.rows).toBe(24);
		});

		test("uses custom dimensions", () => {
			const terminal = new TestTerminal({cols: 40, rows: 10});

			expect(terminal.stdout.columns).toBe(40);
			expect(terminal.stdout.rows).toBe(10);
		});
	});
});
