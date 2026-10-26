import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.js";

const SYNC_START = "\x1b[?2026h";

function frames(output: string): number {
	return output.split(SYNC_START).length - 1;
}

test("changes that come faster than the frame interval share frames", async () => {
	const terminal = new MockProcess({cols: 30, rows: 4});
	const written = captureRawOutput(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	await dom.attach();
	dom.document.body.textContent = "0";
	await nextFrame(dom);
	const before = written().length;
	const start = performance.now();
	for (let i = 1; i <= 100; i++) {
		dom.document.body.textContent = String(i);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	await nextFrame(dom);
	const elapsed = performance.now() - start;
	const painted = frames(written().slice(before));
	expect(painted).toBeLessThanOrEqual(Math.ceil(elapsed / 16) + 1);
	expect(terminal.getPlainText().split("\n")[0]).toBe("100");
	dom.dispose();
});

test("a change after a quiet spell is drawn without waiting", async () => {
	const terminal = new MockProcess({cols: 30, rows: 4});
	const written = captureRawOutput(terminal);
	const dom = new TermDOM({transport: terminal.transport});
	await dom.attach();
	dom.document.body.textContent = "a";
	await nextFrame(dom);
	await new Promise((resolve) => setTimeout(resolve, 40));
	const before = written().length;
	// By the order of the timers, not the clock: a frame drawn without
	// waiting comes from a task due at once, which runs before a timer due
	// a frame interval later however busy the machine is. A clock reading
	// would count the drawing itself, which a loaded runner can stretch.
	const atInterval = new Promise<number>((resolve) => {
		setTimeout(() => resolve(frames(written().slice(before))), 16);
	});
	dom.document.body.textContent = "b";
	expect(await atInterval).toBeGreaterThan(0);
	dom.dispose();
});
