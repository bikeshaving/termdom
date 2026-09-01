import {expect, test} from "@b9g/libuild/test";
import {TermDOM} from "../src/index.js";
import {Screen} from "../src/internal/screen.js";
import {MockProcess, nextFrame, renderFrame} from "./test-utils.js";

test("line clearing removes terminal artifacts from previous commands", async () => {
	// Create a test terminal to simulate artifacts
	const terminal = new MockProcess({cols: 40, rows: 10});

	// Simulate artifacts from previous commands by writing to stdout asynchronously
	await new Promise<void>((resolve) => {
		terminal.stdout.write("file1.txt\r\n", () => {
			terminal.stdout.write("file2.txt\r\n", () => {
				terminal.stdout.write("directory/\r\n", () => {
					terminal.stdout.write("README.md\r\n", () => {
						// Move cursor back to beginning to simulate overwriting scenario
						terminal.stdout.write("\x1b[H", () => resolve());
					});
				});
			});
		});
	});

	// Capture the terminal state with artifacts
	const beforeText = terminal.getVisibleText();
	expect(beforeText).toContain("file1.txt");
	expect(beforeText).toContain("file2.txt");
	expect(beforeText).toContain("directory/");

	// Now create TermDOM content that will overwrite some of these lines
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div1 = document.createElement("div");
	div1.textContent = "TermDOM Line 1";

	const div2 = document.createElement("div");
	div2.textContent = "TermDOM Line 2";
	div2.style.marginLeft = "4ch"; // Indented

	document.body.appendChild(div1);
	document.body.appendChild(div2);

	// Render TermDOM content - this should clear lines and replace artifacts
	await nextFrame(dom);

	// Capture final state
	const afterText = terminal.getVisibleText();

	// Verify artifacts are cleared and replaced with TermDOM content
	expect(afterText).toContain("TermDOM Line 1");
	expect(afterText).toContain("TermDOM Line 2");

	// The first two lines (artifacts) should be replaced with TermDOM content
	expect(afterText).not.toContain("file1.txt");
	expect(afterText).not.toContain("file2.txt");

	dom.dispose();
});

test("indented content clears entire line including leading columns", async () => {
	// Create a test terminal with artifacts in the indented area
	const terminal = new MockProcess({cols: 40, rows: 5});

	// Simulate artifacts that would interfere with indented content
	await new Promise<void>((resolve) => {
		terminal.stdout.write("artifact content line\r\n", () => {
			// Move cursor back to beginning to simulate overwriting
			terminal.stdout.write("\x1b[H", () => resolve());
		});
	});

	// Capture initial state
	const beforeText = terminal.getVisibleText();
	expect(beforeText).toContain("artifact content line");

	// Create TermDOM with indented content
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const div = document.createElement("div");
	div.textContent = "Indented";
	div.style.marginLeft = "8ch"; // Start at column 8
	document.body.appendChild(div);

	// Render - this should clear the entire line and place indented content
	await nextFrame(dom);

	// Capture final state
	const afterText = terminal.getVisibleText();

	// Verify entire line was cleared and replaced with indented content
	expect(afterText).toContain("Indented");
	expect(afterText).not.toContain("artifact content line");

	dom.dispose();
});

test("first render includes line clear sequences", async () => {
	// This test verifies that clear sequences are present in the raw output
	const terminal = new MockProcess({cols: 40, rows: 5});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Capture the raw ANSI output by intercepting stdout writes
	let capturedOutput = "";
	const originalWrite = terminal.stdout.write;
	terminal.stdout.write = function (
		chunk: any,
		encoding?: any,
		callback?: any,
	) {
		capturedOutput += chunk.toString();
		return originalWrite.call(this, chunk, encoding, callback);
	};

	const div = document.createElement("div");
	div.textContent = "Test content";
	document.body.appendChild(div);

	// First render - should contain clear sequences
	await nextFrame(dom);

	// Verify first render has clear sequences in the raw output
	expect(capturedOutput).toContain("\r\x1b[K");

	dom.dispose();
});

test("a screen reset clears stale rows without a screen-qualifying erase", async () => {
	// tmux (and terminals like it) preserve a fully-erased screen by pushing
	// it into scrollback -- the courtesy it extends to `clear`. An ED at the
	// home position therefore archives a copy of the old frame on every
	// resize. The reset must instead clear per-row (each painted or blank row
	// erases itself) plus one partial erase below the content, which never
	// qualifies as a whole-screen clear.
	const terminal = new MockProcess({cols: 20, rows: 6});
	const renderer = new Screen(6, 20, "rgb");
	const write = (s: string) =>
		new Promise<void>((r) => terminal.stdout.write(s, () => r()));

	// An initial frame fills five rows.
	await write(
		renderFrame(renderer, {offset: 0, cursorRow: 0, regionRows: 5}, (ctx) => {
			for (let i = 0; i < 5; i++) {
				ctx.drawText(`stale row ${i}`, 0, i);
			}
		}),
	);
	expect(terminal.getVisibleText()).toContain("stale row 4");

	// The resize path resets the screen; the new frame is shorter and leaves
	// row 1 blank.
	renderer.replaced(0);
	const out = renderFrame(
		renderer,
		{offset: 0, cursorRow: 0, regionRows: 3},
		(ctx) => {
			ctx.drawText("fresh top", 0, 0);
			ctx.drawText("fresh mid", 0, 2);
		},
	);
	expect(out).not.toContain("\x1b[2J");
	expect(out).not.toMatch(/\x1b\[1;1H\x1b\[J/);

	await write(out);
	const text = terminal.getVisibleText();
	expect(text).toContain("fresh top");
	expect(text).toContain("fresh mid");
	// Row 1 (blank in the new frame) and rows 3-4 (below it) are stale rows
	// the erase-free reset still has to clear.
	expect(text).not.toContain("stale");
});
