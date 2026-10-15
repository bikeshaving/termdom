import {spawn} from "node:child_process";
import {availableParallelism} from "node:os";

import {mount, nextFrame, report} from "../harness.ts";

function describe(label: string, times: number[]): void {
	report(label, times);
	const sorted = [...times].sort((a, b) => a - b);
	const at = (q: number): string =>
		sorted[Math.floor(sorted.length * q)].toFixed(1);
	console.error(
		`${label}: p50 ${at(0.5)} p90 ${at(0.9)} p99 ${at(0.99)} max ${sorted.at(-1)!.toFixed(1)}`,
	);
}

// Elapsed time from a key reaching the program to its frame reaching the
// terminal, typed at a person's pace, first on an idle machine and then
// with a process spinning on every core.
const {proc, dom} = await mount();
dom.document.body.innerHTML = "<input id=field>";
const field = dom.document.getElementById("field");
field.focus();
await nextFrame(dom);

let wrote: (() => void) | null = null;
proc.stdout.write = (_chunk: unknown, enc?: unknown, cb?: unknown) => {
	wrote?.();
	const callback = typeof enc === "function" ? enc : cb;
	if (typeof callback === "function") {
		(callback as () => void)();
	}
	return true;
};

async function type(keys: number): Promise<number[]> {
	const times: number[] = [];
	for (let i = 0; i < keys; i++) {
		await new Promise((resolve) => setTimeout(resolve, 40));
		const painted = new Promise<void>((resolve) => {
			wrote = resolve;
		});
		const start = performance.now();
		proc.stdin.simulateResponse(String.fromCharCode(97 + (i % 26)));
		await painted;
		times.push(performance.now() - start);
		wrote = null;
		if (field.value.length > 60) {
			field.value = "";
			await nextFrame(dom);
		}
	}
	return times;
}

await type(20);
describe("latency: key to frame, idle", await type(100));

for (const [label, perCore] of [
	["every core busy", 1],
	["two spinners a core", 2],
] as const) {
	const spinners = Array.from({length: availableParallelism() * perCore}, () =>
		spawn(process.execPath, ["-e", "for (;;) {}"], {stdio: "ignore"}));
	await new Promise((resolve) => setTimeout(resolve, 300));
	try {
		describe(`latency: key to frame, ${label}`, await type(100));
	} finally {
		for (const spinner of spinners) {
			spinner.kill();
		}
	}
}
dom.dispose();
