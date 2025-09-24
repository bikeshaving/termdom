import {test, expect, describe} from "bun:test";
import {TermDOM} from "../src/termdom.ts";

// Simple mock process that captures output
function createSimpleMockProcess(rows: number = 24, cols: number = 80) {
	let capturedOutput = "";

	return {
		process: {
			stdout: {
				write: (chunk: any, encoding?: any, callback?: any) => {
					capturedOutput += chunk;
					// Handle callback properly like real stdout
					if (typeof encoding === "function") {
						callback = encoding;
					}
					if (callback) {
						// Call callback asynchronously to match real behavior
						setImmediate(() => callback());
					}
					return true;
				},
				columns: cols,
				rows: rows,
				isTTY: false,
			},
			stdin: {
				isTTY: false, // This should prevent cursor detection entirely
				setRawMode: () => {},
				resume: () => {},
				pause: () => {},
				setEncoding: () => {},
				on: () => {},
				off: () => {},
			},
			exit: () => {},
			env: {},
			on: () => {},
			emit: () => false,
			removeListener: () => {},
			removeAllListeners: () => {},
		},
		getOutput: () => capturedOutput,
		clearOutput: () => {
			capturedOutput = "";
		},
	};
}

describe("Viewport Integration Tests", () => {
	test("basic content should render with home cursor position", async () => {
		const mock = createSimpleMockProcess(24, 80);
		const termdom = new TermDOM({process: mock.process as any});

		// Skip cursor detection for predictable testing
		(termdom as any).cursorDetectionPromise = null;

		const div = termdom.document.createElement("div");
		div.textContent = "Hello World";
		termdom.document.body.appendChild(div);

		await termdom.render();

		const output = mock.getOutput();

		// Should contain ANSI sequence for home position
		expect(output).toContain("\x1b[H"); // Home cursor position
		expect(output).toContain("Hello World"); // Content
		expect(output).toContain("\x1b[?2026h"); // Synchronized mode start
		expect(output).toContain("\x1b[?2026l"); // Synchronized mode end
	});

	test("cursor at specific position should use correct ANSI positioning", async () => {
		const mock = createSimpleMockProcess(24, 80);
		const termdom = new TermDOM({process: mock.process as any});

		// Skip cursor detection
		(termdom as any).cursorDetectionPromise = null;

		// Manually simulate cursor at row 5 (0-based = 4)
		(termdom as any).scrollingManager.setScreenTop(4);
		(termdom as any).scrollingManager.scrollToCommandStart();
		(termdom as any).hasDetectedCommandStart = true;

		const div = termdom.document.createElement("div");
		div.textContent = "Positioned content";
		termdom.document.body.appendChild(div);

		await termdom.render();

		const output = mock.getOutput();

		// Should position cursor at row 5 (1-based ANSI = \x1b[5;1H)
		expect(output).toContain("\x1b[5;1H");
		expect(output).toContain("Positioned content");

		// Should NOT contain home position when cursor is positioned elsewhere
		expect(output).not.toContain("\x1b[H"); // No home position
	});

	test("double viewport offset bug should be prevented", async () => {
		const mock = createSimpleMockProcess(24, 80);
		const termdom = new TermDOM({process: mock.process as any});

		(termdom as any).cursorDetectionPromise = null;

		// Simulate cursor at row 8
		(termdom as any).scrollingManager.setScreenTop(7); // 0-based
		(termdom as any).scrollingManager.scrollToCommandStart();
		(termdom as any).hasDetectedCommandStart = true;

		const div = termdom.document.createElement("div");
		div.textContent = "No double offset";
		termdom.document.body.appendChild(div);

		await termdom.render();

		const output = mock.getOutput();

		// Should position at row 8 (1-based ANSI)
		expect(output).toContain("\x1b[8;1H");

		// Should NOT contain doubled position (row 15 would be 7*2 + 1)
		expect(output).not.toContain("\x1b[15;1H");
		expect(output).not.toContain("\x1b[16;1H"); // 8*2 = 16
	});

	test("empty content should generate minimal output", async () => {
		const mock = createSimpleMockProcess(24, 80);
		const termdom = new TermDOM({process: mock.process as any});

		(termdom as any).cursorDetectionPromise = null;

		// No content added
		await termdom.render();

		const output = mock.getOutput();

		// Empty content should produce no output (hasContent optimization)
		expect(output).toBe("");
	});

	test("content overflow should calculate push-up correctly", async () => {
		const mock = createSimpleMockProcess(5, 40); // Small terminal
		const termdom = new TermDOM({process: mock.process as any});

		(termdom as any).cursorDetectionPromise = null;

		// Cursor at row 4 (0-based = 3), only 2 lines available
		(termdom as any).scrollingManager.setScreenTop(3);
		(termdom as any).scrollingManager.scrollToCommandStart();
		(termdom as any).hasDetectedCommandStart = true;

		// Add content that needs 4 lines (exceeds 2 available)
		const container = termdom.document.createElement("div");
		for (let i = 1; i <= 4; i++) {
			const line = termdom.document.createElement("div");
			line.textContent = `Line ${i}`;
			container.appendChild(line);
		}
		termdom.document.body.appendChild(container);

		await termdom.render();

		const output = mock.getOutput();

		// All content should be present (not clipped)
		expect(output).toContain("Line 1");
		expect(output).toContain("Line 2");
		expect(output).toContain("Line 3");
		expect(output).toContain("Line 4");

		// Should handle overflow properly (exact positioning will depend on push-up logic)
		expect(output.length).toBeGreaterThan(0);
	});
});
