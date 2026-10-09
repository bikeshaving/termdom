/**
 * The process transport takes the terminal while a session runs and hands
 * it back when the session ends, leaving the process as it found it.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {transportFromProcess} from "../src/internal/exchange.ts";
import {captureRawOutput, MockProcess, nextFrame, until} from "./test-utils.js";

test("the process transport leaves no error listeners behind", async () => {
	const proc = new MockProcess({cols: 20, rows: 5});
	const listeners = () => [
		proc.stdout.listenerCount("error"),
		proc.stdin.listenerCount("error"),
	];
	for (let i = 0; i < 12; i++) {
		const dom = new TermDOM({transport: transportFromProcess(proc)});
		await dom.dispose();
	}
	expect(listeners()).toEqual([0, 0]);

	const dom = new TermDOM({transport: transportFromProcess(proc)});
	await dom.attach();
	await nextFrame(dom);
	expect(listeners()).toEqual([1, 1]);
	await dom.dispose();
	await until(() => listeners().every((count) => count === 0));
	expect(listeners()).toEqual([0, 0]);
});

test("a broken stream ends a session it engaged", async () => {
	const proc = new MockProcess({cols: 20, rows: 5});
	const exits: number[] = [];
	proc.exit = ((code?: number) => {
		exits.push(code ?? 0);
	}) as never;
	const transport = transportFromProcess(proc);
	const dom = new TermDOM({transport});
	await dom.attach();
	await nextFrame(dom);
	proc.stdout.emit("error", new Error("EPIPE"));
	await transport.closed;
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(exits).toEqual([0]);
	await dom.dispose();
});

test("a stream that breaks as a session ends does not exit the process", async () => {
	const proc = new MockProcess({cols: 20, rows: 5});
	const exits: number[] = [];
	proc.exit = ((code?: number) => {
		exits.push(code ?? 0);
	}) as never;
	const dom = new TermDOM({transport: transportFromProcess(proc)});
	await dom.attach();
	await nextFrame(dom);
	const disposed = dom.dispose();
	proc.stdout.emit("error", new Error("EPIPE"));
	await disposed;
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(exits).toEqual([]);
});

test("nothing is asked of a terminal whose replies stdin cannot read", async () => {
	const proc = new MockProcess({cols: 30, rows: 6});
	proc.stdin.isTTY = false;
	const written = captureRawOutput(proc, {forward: false});
	const dom = new TermDOM({
		transport: transportFromProcess(proc, {sharesScreen: true}),
	});
	dom.document.body.innerHTML = "<p>piped 😀</p>";
	const start = performance.now();
	await dom.attach();
	await nextFrame(dom);
	const ms = performance.now() - start;
	await dom.dispose();
	const questions = [
		"\x1b[c",
		"\x1b[>c",
		"\x1b]11;?",
		"$p",
		"\x1b[16t",
		"\x1b[6n",
		"\x1bP",
	].filter((question) => written().includes(question));
	expect(questions).toEqual([]);
	expect(written()).toContain("piped");
	expect(ms).toBeLessThan(500);
});
