/**
 * What the memory tests share: a forced collection, the heap read after it,
 * and growth measured over a churn. Those that churn are in files of their
 * own, since each takes up to a minute on a loaded runner and a file has a
 * budget of three.
 */
import {TermDOM} from "../src/index.ts";
import {findCollector, MockProcess, nextFrame} from "./test-utils.js";

export const collect = await findCollector();

export function create(): TermDOM {
	return new TermDOM({
		transport: new MockProcess({cols: 100, rows: 40}).transport,
		cellSize: {width: 8, height: 16},
	});
}

export async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		collect!();
	}
}

// The lowest of three readings. What a collection misses only adds, so
// the lowest is the nearest to what is still held.
export async function heldHeap(): Promise<number> {
	let lowest = Infinity;
	for (let i = 0; i < 3; i++) {
		await settle();
		lowest = Math.min(lowest, process.memoryUsage().heapUsed);
	}
	return lowest;
}

// Mounted, painted, removed and painted again, in a function of its own:
// what an async function holds across an await, it holds until it returns.
export async function mountAndRemove(
	dom: TermDOM,
	html: string,
): Promise<void> {
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	host.innerHTML = html;
	await nextFrame(dom);
	host.remove();
	await nextFrame(dom);
}

// Measured from after a warm-up: the first rounds fill caches and compile
// code, which Deno counts as some megabytes of heap that then stay level.
export const WARM_UP = 10;

// Each leak these tests were written for held at least 17 MB over 80
// rounds on every runtime, twice what it held over 40.
const ROUNDS = 80;
export const MB = 12;

// Without a leak the heap still swings by several megabytes: the tables
// behind the engine's per-element WeakMaps shrink only some collections
// after their elements go, and compiled code comes and goes. One reading
// caught at the top of a swing read as 15 MB held on Deno and Node 20. A
// leak only grows, so what is held after the churn is the lowest of
// readings a few rounds apart.
const SETTLE_ROUNDS = 5;
const READINGS = 3;

async function heldAfter(
	read: () => Promise<number>,
	churn: () => Promise<void>,
): Promise<number> {
	let lowest = await read();
	for (let reading = 1; reading < READINGS; reading++) {
		for (let round = 0; round < SETTLE_ROUNDS; round++) {
			await churn();
		}
		lowest = Math.min(lowest, await read());
	}
	return lowest;
}

// A slow runner compiles later than a fast one, so code can still land
// after the warm-up, and a swing can outlast the readings: quiet runs have
// read 15 MB here on CI, and 3 MB on a laptop. Neither happens twice in a
// row, and a leak adds its share in every window, so the growth is the
// least any window saw. Another window is only spent on a run over MB.
const WINDOWS = 3;

export async function grownOver(
	read: () => Promise<number>,
	churn: () => Promise<void>,
): Promise<number> {
	let before = await read();
	let least = Infinity;
	for (let window = 0; window < WINDOWS && least >= MB; window++) {
		for (let round = 0; round < ROUNDS; round++) {
			await churn();
		}
		const after = await heldAfter(read, churn);
		least = Math.min(least, (after - before) / 1e6);
		before = after;
	}
	return least;
}

// The heap held before and after a churn.
export async function growth(html: (round: number) => string): Promise<number> {
	const dom = create();
	let round = 0;
	const churn = () => mountAndRemove(dom, html(round++));
	while (round < WARM_UP) {
		await churn();
	}
	const grown = await grownOver(heldHeap, churn);
	dom.dispose();
	return grown;
}
