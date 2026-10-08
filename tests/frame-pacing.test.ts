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
	dom.document.body.textContent = "b";
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(frames(written().slice(before))).toBe(1);
	dom.dispose();
});
