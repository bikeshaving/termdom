/**
 * What every scenario shares. A scenario runs against the checkout named
 * by its first argument, so the runner can point the same scenario at two
 * checkouts, and prints one JSON line per measurement.
 */
import {readFileSync} from "node:fs";

export const root = process.argv[2];

/** The bench's own checkout, which every input is read from. */
export const benchRoot = new URL("..", import.meta.url).pathname;

const index = await import(`${root}/src/index.ts`);
const utils = await import(`${root}/tests/test-utils.ts`);

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
