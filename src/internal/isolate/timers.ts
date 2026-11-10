import {reportError} from "./console.ts";
import {host} from "./host.ts";

interface Timer {
	callback: (...args: unknown[]) => unknown;
	args: unknown[];
	ms: number;
	repeat: boolean;
	nesting: number;
}

const timers = new Map<number, Timer>();
let nextId = 1;
let currentNesting = 0;

const NESTING_LIMIT = 5;
const NESTED_MINIMUM = 4;

function normalizeDelay(ms: unknown): number {
	const delay = Number(ms);
	return delay > 0 && delay < 2 ** 31 ? delay : 0;
}

function schedule(
	callback: unknown,
	ms: unknown,
	args: unknown[],
	repeat: boolean,
	task = false,
): number {
	const id = nextId++;
	if (typeof callback !== "function") {
		return id;
	}

	const nesting = task ? 0 : currentNesting + 1;
	let delay = normalizeDelay(ms);
	if (nesting > NESTING_LIMIT && delay < NESTED_MINIMUM) {
		delay = NESTED_MINIMUM;
	}

	timers.set(id, {
		callback: callback as Timer["callback"],
		args,
		ms: delay,
		repeat,
		nesting,
	});
	host.setTimer(id, delay);
	return id;
}

function cancel(id: unknown): void {
	const key = Number(id);
	if (timers.delete(key)) {
		host.clearTimer(key);
	}
}

export function setTimeout(
	callback: unknown,
	ms?: unknown,
	...args: unknown[]
): number {
	return schedule(callback, ms, args, false);
}

export function setInterval(
	callback: unknown,
	ms?: unknown,
	...args: unknown[]
): number {
	return schedule(callback, ms, args, true);
}

export function queueTask(callback: () => void): void {
	schedule(callback, 0, [], false, true);
}

export const clearTimeout = cancel;
export const clearInterval = cancel;

export function queueMicrotask(callback: unknown): void {
	if (typeof callback !== "function") {
		throw new TypeError("queueMicrotask expects a function");
	}

	void Promise.resolve().then(() => {
		try {
			(callback as () => void)();
		} catch (error) {
			reportError(error);
		}
	});
}

export function fireTimer(id: number): void {
	const timer = timers.get(id);
	if (timer === undefined) {
		return;
	}

	if (timer.repeat) {
		timer.nesting++;
		if (timer.nesting > NESTING_LIMIT && timer.ms < NESTED_MINIMUM) {
			timer.ms = NESTED_MINIMUM;
		}

		host.setTimer(id, timer.ms);
	} else {
		timers.delete(id);
	}

	const outer = currentNesting;
	currentNesting = timer.nesting;
	try {
		timer.callback(...timer.args);
	} catch (error) {
		reportError(error);
	} finally {
		currentNesting = outer;
	}
}

const origin = Date.now();

export const performance = {
	timeOrigin: origin,
	now(): number {
		return Date.now() - origin;
	},
};
