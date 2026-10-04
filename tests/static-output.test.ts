/**
 * Non-terminal (piped) output.
 *
 * A stdout that is not a terminal -- a pipe, a file, a CI log -- has no viewport,
 * no cursor, no scrollback and no resize. It therefore has no fold, and none of
 * the problems that come with one: nothing to commit, nothing to freeze, nothing
 * to repair.
 *
 * It also cannot interpret cursor movement. The interactive frame would write
 * CUP, EL, DECSC and synchronised-output sequences straight into the file, which
 * is what used to happen: nothing checked stdout.isTTY, while the README promised
 * TermDOM "works in interactive terminals or piped output".
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {transportFromProcess} from "../src/internal/exchange.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

/** Render to a non-terminal stdout and return exactly what was written. */
async function renderPiped(html: string, cols = 40): Promise<string> {
	const terminal = new MockProcess({cols, rows: 10});
	(terminal.stdout as any).isTTY = false;
	const written = captureRawOutput(terminal, {forward: false});

	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	dom.dispose();

	return written();
}

test("piped output contains no terminal control sequences", async () => {
	const output = await renderPiped("<div>hello</div><div>world</div>");

	// Every one of these would be garbage in a file.
	expect(output).not.toContain("\x1b[?25l"); // hide cursor
	expect(output).not.toContain("\x1b[?2026h"); // synchronised output
	expect(output).not.toContain("\x1b[K"); // erase line
	expect(output).not.toContain("\x1b7"); // save cursor
	expect(output).not.toContain("\x1b8"); // restore cursor
	expect(output).not.toMatch(/\x1b\[\d+;\d+H/); // cursor position
	expect(output).not.toMatch(/\x1b\[\d+C/); // cursor forward
});

test("piped output is the document, as plain lines", async () => {
	const output = await renderPiped("<div>hello</div><div>world</div>");
	const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");

	expect(lines[0]).toBe("hello");
	expect(lines[1]).toBe("world");
});

test("layout still happens when piped -- a table is still a table", async () => {
	// The layout engine does not care whether stdout is a terminal. Only the
	// emitter does.
	const output = await renderPiped(
		"<table style=\"border-collapse:collapse\"><tr><td>a</td><td>b</td></tr></table>",
	);
	const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");

	expect(lines[0]).toBe("┌───┬───┐");
	expect(lines[1]).toBe("│ a │ b │");
	expect(lines[2]).toBe("└───┴───┘");
});

test("lines are not padded out to the terminal width", async () => {
	// A file should not be full of trailing spaces.
	const output = await renderPiped("<div>hi</div>", 40);
	const line = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0];

	expect(line).toBe("hi");
	expect(line.length).toBeLessThan(40);
});

test("a document taller than the terminal is emitted in full", async () => {
	// There is no viewport, so there is no fold and nothing is clipped or
	// committed. All 30 rows are simply printed.
	const html = Array.from({length: 30}, (_, i) => `<div>row ${i + 1}</div>`)
		.join("");
	const output = await renderPiped(html);
	const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");

	expect(lines[0]).toBe("row 1");
	expect(lines[29]).toBe("row 30");
});

test("wide characters keep their columns in static output", async () => {
	// A wide grapheme occupies two buffer columns: its glyph cell and a
	// continuation. The continuation must not ALSO print as a space, or every
	// emoji shifts the rest of its line one column right.
	const output = await renderPiped("<div>🙂 ok</div><div>a🙂b end</div>");
	const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");

	expect(stripped).toContain("🙂 ok");
	expect(stripped).toContain("a🙂b end");
});

// A pipe cannot be redrawn, so however many frames run, it gets the
// document once, when the session ends.
async function renderPipedFrames(
	stdoutIsTTY: boolean | undefined,
): Promise<string> {
	const terminal = new MockProcess({cols: 40, rows: 10});
	(terminal.stdout as any).isTTY = stdoutIsTTY;
	const written = captureRawOutput(terminal, {forward: false});
	const dom = new TermDOM({transport: terminal.transport});
	await dom.attach();
	dom.document.body.innerHTML = Array.from(
		{length: 20},
		(_, i) => `<p>row ${i + 1}</p>`,
	).join("");
	await nextFrame(dom);
	await new Promise((resolve) =>
		dom.window.requestAnimationFrame(() =>
			dom.window.requestAnimationFrame(resolve),
		),
	);
	await dom.dispose();
	return written();
}

test("an attached session prints the piped document once, whole", async () => {
	const output = await renderPipedFrames(false);
	expect(output.match(/row \d+/g)?.length).toBe(20);
	expect(output).toContain("row 20");
	expect(output.replace(/\x1b\[0m/g, "")).not.toMatch(/\x1b/);
});

test("print() with no argument takes the place of the print at the end", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	(terminal.stdout as any).isTTY = false;
	const written = captureRawOutput(terminal, {forward: false});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div>once</div>";
	await nextFrame(dom);
	await dom.print();
	await dom.dispose();
	expect(written().match(/once/g)?.length).toBe(1);
});

test("a stdout that does not say it is a terminal is a pipe", async () => {
	const output = await renderPipedFrames(undefined);
	expect(output.match(/row \d+/g)?.length).toBe(20);
	expect(output.replace(/\x1b\[0m/g, "")).not.toMatch(/\x1b/);
});

// A stream that fails is a terminal that is gone: the session closes as
// when its input ends, instead of crashing on the unhandled error.
test("a failing stdout closes the session instead of crashing", async () => {
	const {EventEmitter} = await import("node:events");
	const stdout = Object.assign(new EventEmitter(), {
		write: () => true,
		columns: 20,
		rows: 5,
		isTTY: false,
	});
	let exited: number | undefined;
	const transport = transportFromProcess({
		stdout,
		on: () => {},
		exit: ((code?: number) => {
			exited = code;
		}) as (code?: number) => never,
	});
	const error = Object.assign(new Error("write EPIPE"), {code: "EPIPE"});
	stdout.emit("error", error);
	expect(await transport.closed).toEqual({});
	await new Promise((resolve) => setImmediate(resolve));
	expect(exited).toBe(0);
});
