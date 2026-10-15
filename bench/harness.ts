/**
 * What every scenario shares. A scenario runs against the checkout named
 * by its first argument, so the runner can point the same scenario at two
 * checkouts, and prints one JSON line per measurement.
 */
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {availableParallelism} from "node:os";

export const root = process.argv[2];

/** The bench's own checkout, which every input is read from. */
export const benchRoot = new URL("..", import.meta.url).pathname;

const index = await import(`${root}/src/index.ts`);
const utils = await import(`${root}/tests/test-utils.ts`);
const painter = await import(`${root}/src/internal/painter.ts`);
// The test utilities check every partial frame against a whole one, which
// is not what a user's frame costs.
if (painter.partialFrameCheck !== undefined) {
	painter.partialFrameCheck.enabled = false;
}
const layout = await import(`${root}/src/internal/layout.ts`);
if (layout.layoutCheck !== undefined) {
	layout.layoutCheck.enabled = false;
}

export const TermDOM = index.TermDOM;
export const installGlobals = index.installGlobals;
export const MockProcess = utils.MockProcess;
export const nextFrame: (dom: unknown) => Promise<void> = utils.nextFrame;

export function readBenchFile(path: string): string {
	return readFileSync(`${benchRoot}${path}`, "utf8");
}

export async function mount(
	cols = 100,
	rows = 40,
	options: object = {},
): Promise<{proc: any; dom: any}> {
	const proc = new MockProcess({cols, rows});
	const dom = new TermDOM({...options, transport: proc.transport});
	dom.attach();
	await nextFrame(dom);
	return {proc, dom};
}

/**
 * The terminal becomes a sink once the page is up, so what is measured
 * is the engine and not the emulator reading its output.
 */
export function silence(proc: any): void {
	proc.stdout.write = (_chunk: unknown, enc?: unknown, cb?: unknown) => {
		const callback = typeof enc === "function" ? enc : cb;
		if (typeof callback === "function") {
			(callback as () => void)();
		}
		return true;
	};
}

/** CPU time, so the time a frame waits for its turn is not counted. */
export function cpuMs(): number {
	const {user, system} = process.cpuUsage();
	return (user + system) / 1000;
}

export function report(label: string, times: number[]): void {
	const sorted = [...times].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];
	console.log(JSON.stringify({label, median}));
}

export async function measure(
	label: string,
	steps: number,
	step: (i: number) => Promise<void> | void,
	warm = 10,
): Promise<void> {
	for (let i = 0; i < warm; i++) {
		await step(i);
	}
	const times: number[] = [];
	for (let i = warm; i < warm + steps; i++) {
		const start = cpuMs();
		await step(i);
		times.push(cpuMs() - start);
	}
	report(label, times);
}

/**
 * Reports wall times as a measurement, and prints their percentiles, which
 * a median alone hides, to stderr.
 */
export function describeLatency(label: string, times: number[]): void {
	report(label, times);
	const sorted = [...times].sort((a, b) => a - b);
	const at = (q: number): string =>
		sorted[Math.floor(sorted.length * q)].toFixed(1);
	console.error(
		`${label}: p50 ${at(0.5)} p90 ${at(0.9)} p99 ${at(0.99)} max ${sorted.at(-1)!.toFixed(1)}`,
	);
}

/**
 * Times each key from reaching the program to its frame reaching the
 * terminal, typed at a person's pace.
 */
export function keyLatency(proc: any): (key: string) => Promise<number> {
	let wrote: (() => void) | null = null;
	proc.stdout.write = (_chunk: unknown, enc?: unknown, cb?: unknown) => {
		wrote?.();
		const callback = typeof enc === "function" ? enc : cb;
		if (typeof callback === "function") {
			(callback as () => void)();
		}
		return true;
	};
	return async (key) => {
		await new Promise((resolve) => setTimeout(resolve, 40));
		const painted = new Promise<void>((resolve) => {
			wrote = resolve;
		});
		const start = performance.now();
		proc.stdin.simulateResponse(key);
		await painted;
		wrote = null;
		return performance.now() - start;
	};
}

/** Runs the work with an idle machine, every core busy, and two spinners a core. */
export async function underLoad(
	label: string,
	work: () => Promise<number[]>,
): Promise<void> {
	describeLatency(`${label}, idle`, await work());
	for (const [load, perCore] of [
		["every core busy", 1],
		["two spinners a core", 2],
	] as const) {
		const spinners = Array.from(
			{length: availableParallelism() * perCore},
			() => spawn(process.execPath, ["-e", "for (;;) {}"], {stdio: "ignore"}),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		try {
			describeLatency(`${label}, ${load}`, await work());
		} finally {
			for (const spinner of spinners) {
				spinner.kill();
			}
		}
	}
}
