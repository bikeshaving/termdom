import {test, expect, describe} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

// These tests exercise the interactive render path's cursor positioning by
// observing where content actually lands in the terminal buffer. Content
// appearing at row N proves the renderer emitted the ANSI to move there, so we
// assert the observable result rather than grepping escape codes -- and drive
// the anchor through real cursor detection (park the cursor, let TermDOM detect
// it) rather than poking internal state.

/** Park the terminal cursor at a 1-based row before construction. */
async function parkCursor(terminal: MockProcess, row: number): Promise<void> {
	await new Promise<void>((resolve) => {
		terminal.stdout.write(`\x1b[${row};1H`, () => resolve());
	});
}

describe("Viewport Integration Tests", () => {
	test("content renders from the home row when the cursor starts at home", async () => {
		const terminal = new MockProcess({rows: 24, cols: 80});
		const dom = new TermDOM({process: terminal});

		dom.document.body.innerHTML = "<div>Hello World</div>";
		await nextFrame(dom);

		// Cursor at home -> content lands on the top row, no offset.
		expect(dom.window.screenTop).toBe(0);
		const lines = terminal.getPlainText().split("\n");
		expect(lines[0]).toBe("Hello World");
	});

	test("content renders from the detected command-start row", async () => {
		const terminal = new MockProcess({rows: 24, cols: 80});
		await parkCursor(terminal, 5); // 1-based row 5 -> screenTop 4
		const dom = new TermDOM({process: terminal, detectCursor: true});
		await nextFrame(dom);

		dom.document.body.innerHTML = "<div>Positioned content</div>";
		await nextFrame(dom);

		expect(dom.window.screenTop).toBe(4);
		const lines = terminal.getPlainText().split("\n");
		expect(lines[4]).toBe("Positioned content");
		expect(lines[0]).toBe(""); // nothing painted above the anchor
	});

	test("the anchor offset is applied once, not doubled", async () => {
		const terminal = new MockProcess({rows: 24, cols: 80});
		await parkCursor(terminal, 8); // screenTop 7
		const dom = new TermDOM({process: terminal, detectCursor: true});
		await nextFrame(dom);

		dom.document.body.innerHTML = "<div>No double offset</div>";
		await nextFrame(dom);

		expect(dom.window.screenTop).toBe(7);
		const lines = terminal.getPlainText().split("\n");
		expect(lines[7]).toBe("No double offset"); // row 8: offset applied once
		// If the anchor were applied twice it would land near row 15 instead.
		expect(lines.filter((l) => l === "No double offset").length).toBe(1);
	});

	test("empty content produces an empty frame", async () => {
		const terminal = new MockProcess({rows: 24, cols: 80});
		const dom = new TermDOM({process: terminal});

		await nextFrame(dom);

		expect(terminal.getPlainText()).toBe("");
	});
});
