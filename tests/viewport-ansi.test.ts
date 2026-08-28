import {test, expect, describe} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {transportFromProcess} from "../src/internal/exchange.js";
import {MockProcess, nextFrame} from "./test-utils.js";

// A raw-capture mock: it keeps the exact bytes TermDOM writes, so tests can
// assert the wire protocol (synchronized-output wrappers, no redundant cursor
// homing, nothing at all when empty). stdin.isTTY:false disables cursor
// detection entirely, so these tests render from the terminal home row without
// any anchor setup.
function createRawMockProcess(
	rows = 24,
	cols = 80,
): {process: any; getOutput: () => string} {
	let capturedOutput = "";
	return {
		process: {
			stdout: {
				write: (chunk: any, encoding?: any, callback?: any) => {
					capturedOutput += chunk;
					if (typeof encoding === "function") {
						callback = encoding;
					}
					if (callback) {
						setImmediate(() => callback());
					}
					return true;
				},
				columns: cols,
				rows,
				isTTY: true,
			},
			stdin: {
				isTTY: false, // disables cursor detection
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
	};
}

/** Park the terminal cursor at a 1-based row before construction. */
async function parkCursor(terminal: MockProcess, row: number): Promise<void> {
	await new Promise<void>((resolve) => {
		terminal.stdout.write(`\x1b[${row};1H`, () => resolve());
	});
}

describe("Viewport Integration Tests", () => {
	// --- Raw wire-protocol checks (no anchor, cursor at home) -----------------

	test("content renders from home without a redundant cursor-home escape", async () => {
		const mock = createRawMockProcess(24, 80);
		const termdom = new TermDOM({
			transport: transportFromProcess(mock.process as any),
		});

		const div = termdom.document.createElement("div");
		div.textContent = "Hello World";
		termdom.document.body.appendChild(div);
		await nextFrame(termdom);

		const output = mock.getOutput();
		expect(output).toContain("Hello World");
		expect(output).not.toContain("\x1b[H"); // cursor already at home
		expect(output).toContain("\x1b[?2026h"); // synchronized output start
		expect(output).toContain("\x1b[?2026l"); // synchronized output end
	});

	test("empty content writes nothing (hasContent optimization)", async () => {
		const mock = createRawMockProcess(24, 80);
		const termdom = new TermDOM({
			transport: transportFromProcess(mock.process as any),
		});

		await nextFrame(termdom); // no content added

		// attach() writes its session prelude (bracketed paste, title push,
		// mouse reporting); the claim under test is that no FRAME was written.
		expect(mock.getOutput()).not.toContain("\x1b[?2026h");
	});

	// --- Anchor placement, driven by real cursor detection --------------------

	test("content renders from the detected command-start row", async () => {
		const terminal = new MockProcess({rows: 24, cols: 80});
		await parkCursor(terminal, 5); // 1-based row 5 -> screenTop 4
		const dom = new TermDOM({transport: terminal.sharedTransport});
		await nextFrame(dom);

		dom.document.body.innerHTML = "<div>Positioned content</div>";
		await nextFrame(dom);

		// Content landing on row 5 proves the row-5 positioning ANSI was emitted.
		expect(dom.window.screenTop).toBe(4);
		const lines = terminal.getPlainText().split("\n");
		expect(lines[4]).toBe("Positioned content");
		expect(lines[0]).toBe(""); // nothing painted above the anchor
	});

	test("the anchor offset is applied once, not doubled", async () => {
		const terminal = new MockProcess({rows: 24, cols: 80});
		await parkCursor(terminal, 8); // screenTop 7
		const dom = new TermDOM({transport: terminal.sharedTransport});
		await nextFrame(dom);

		dom.document.body.innerHTML = "<div>No double offset</div>";
		await nextFrame(dom);

		expect(dom.window.screenTop).toBe(7);
		const lines = terminal.getPlainText().split("\n");
		expect(lines[7]).toBe("No double offset"); // row 8: offset applied once
		// A doubled offset would land it near row 15 instead.
		expect(lines.filter((l) => l === "No double offset").length).toBe(1);
	});

	// The ANSI-path version of the push-up viewport.test.ts asserts through
	// window.screenTop: the same scenario, read off the bytes instead.
	test(
		"content overflowing the space below the anchor pushes up to fit",
		async () => {
			const terminal = new MockProcess({rows: 5, cols: 40});
			await parkCursor(terminal, 4); // screenTop 3, only 2 rows below
			const dom = new TermDOM({transport: terminal.sharedTransport});
			await nextFrame(dom);

			const container = dom.document.createElement("div");
			for (let i = 1; i <= 4; i++) {
				const line = dom.document.createElement("div");
				line.textContent = `Line ${i}`;
				container.appendChild(line);
			}
			dom.document.body.appendChild(container);
			await nextFrame(dom);

			const text = terminal.getPlainText();
			expect(text).toContain("Line 1");
			expect(text).toContain("Line 2");
			expect(text).toContain("Line 3");
			expect(text).toContain("Line 4");
		},
	);
});
