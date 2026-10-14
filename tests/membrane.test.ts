/**
 * What a page, or the program embedding TermDOM, can reach holds nothing of
 * the engine's: no internal state or steps on any object or prototype but
 * the runtime's own. Where the runtime has a class, the page gets it.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {SealedAbortController, SealedAbortSignal} from "../src/internal/dom.ts";
import {MockProcess} from "./test-utils.js";

function create(html = ""): TermDOM {
	return new TermDOM({
		transport: new MockProcess({cols: 40, rows: 12}).transport,
		html,
	});
}

type Global = typeof globalThis;

const WELL_KNOWN = new Set(
	Object.getOwnPropertyNames(Symbol)
		.map((name) => (Symbol as unknown as Record<string, unknown>)[name])
		.filter((value) => typeof value === "symbol"),
);

const RUNTIME_SYMBOLS = new Set<symbol>();
for (const object of [
	new Event("x"),
	new EventTarget(),
	new DOMException("x"),
	new AbortController().signal,
	new AbortController(),
	Event,
	EventTarget,
	DOMException,
	AbortController,
	AbortSignal,
]) {
	for (let o: object | null = object;
		o !== null;
		o = Object.getPrototypeOf(o)) {
		for (const key of Object.getOwnPropertySymbols(o)) {
			RUNTIME_SYMBOLS.add(key);
		}
	}
}

// Every object reachable from `roots` through data properties and
// prototypes, with the symbol keys of its own.
function findSymbols(roots: unknown[]): string[] {
	const found: string[] = [];
	const seen = new Set<object>();
	const visit = (value: unknown, depth: number) => {
		if (
			value === null ||
			(typeof value !== "object" && typeof value !== "function") ||
			seen.has(value) ||
			depth > 5
		) {
			return;
		}
		seen.add(value);
		const keys = Reflect.ownKeys(value);
		for (const key of keys) {
			if (
				typeof key === "symbol" &&
				!WELL_KNOWN.has(key) &&
				!RUNTIME_SYMBOLS.has(key) &&
				Symbol.keyFor(key) === undefined
			) {
				const owner = typeof value === "function"
					? value.name
					: (value as {constructor?: {name?: string}}).constructor?.name;
				found.push(`${String(key)} on ${owner}`);
			}
		}
		visit(Object.getPrototypeOf(value), depth + 1);
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor !== undefined && "value" in descriptor) {
				visit(descriptor.value, depth + 1);
			}
		}
	};
	for (const root of roots) {
		visit(root, 0);
	}
	return found;
}

test("nothing a page or its program reaches carries a symbol", () => {
	const dom = create(
		"<table><tr><td>1</td></tr></table><form><input><select><option>x" +
			"</select><textarea></textarea></form><canvas></canvas><p>hi " +
			"<a href=#>a</a><!--c--></p><template><b>t</b></template>",
	);
	const window = dom.window as unknown as Global;
	const {document} = dom;
	const body = document.body;
	const roots: unknown[] = [
		dom,
		window,
		document,
		body,
		document.querySelector("p")!.firstChild,
		document.querySelector("input"),
		document.querySelector("canvas")!.getContext("2d"),
		window.getComputedStyle(body),
		body.style,
		body.classList,
		body.childNodes,
		body.children,
		body.attributes,
		document.styleSheets,
		document.createRange(),
		document.createTreeWalker(body),
		new window.Event("x"),
		new window.MouseEvent("click"),
		new window.MutationObserver(() => {}),
		new window.DOMException("x"),
		window.performance,
		window.performance.mark("m"),
		window.crypto,
		document.getSelection(),
	];
	expect(findSymbols(roots)).toEqual([]);
	dom.dispose();
});

test("the program's TermDOM is the DOM's EventTarget, with nothing of the runtime's", () => {
	const dom = create();
	const window = dom.window as unknown as Global;
	expect(dom instanceof window.EventTarget).toBe(true);
	expect(Object.getOwnPropertySymbols(dom)).toEqual([]);
	let heard = 0;
	dom.addEventListener("ping", () => heard++);
	dom.dispatchEvent(new window.Event("ping"));
	expect(heard).toBe(1);
	dom.dispose();
});

test("a window's DOMException is the runtime's where the runtime has one", () => {
	const dom = create();
	const window = dom.window as unknown as Global;
	expect(window.DOMException).toBe(globalThis.DOMException);
	expect(() => document(dom).querySelector("::bad")).toThrow(DOMException);
	dom.dispose();
});

function document(dom: TermDOM): Document {
	return dom.document;
}

test("performance keeps a page's marks and measures on the runtime's clock", () => {
	const dom = create();
	const window = dom.window as unknown as Global;
	const {performance} = window;
	expect(performance).not.toBe(globalThis.performance);
	expect(performance).toBe(window.performance);
	expect(() => new window.Performance()).toThrow(TypeError);
	expect(Math.abs(performance.timeOrigin - globalThis.performance.timeOrigin))
		.toBeLessThan(1);
	const before = performance.now();
	expect(performance.now()).toBeGreaterThanOrEqual(before);
	const start = performance.mark("start", {startTime: 10, detail: {a: 1}});
	expect([start.name, start.entryType, start.startTime, start.duration])
		.toEqual(["start", "mark", 10, 0]);
	expect(start.detail).toEqual({a: 1});
	performance.mark("end", {startTime: 25});
	const measure = performance.measure("span", "start", "end");
	expect([measure.entryType, measure.startTime, measure.duration]).toEqual([
		"measure",
		10,
		15,
	]);
	expect(performance.measure("both", {start: 5, duration: 3}).duration)
		.toBe(3);
	expect(() => performance.measure("x", "missing")).toThrow(
		window.DOMException,
	);
	expect(performance.getEntriesByType("mark").map((entry) => entry.name))
		.toEqual(["start", "end"]);
	performance.clearMarks("start");
	expect(performance.getEntriesByName("start")).toEqual([]);
	performance.clearMeasures();
	expect(performance.getEntriesByType("measure")).toEqual([]);
	const mark = new window.PerformanceMark("made", {startTime: 1});
	expect(mark.startTime).toBe(1);
	expect(() => new window.PerformanceMeasure()).toThrow(TypeError);
	dom.dispose();
});

test("crypto fills integer arrays from the runtime's random source", () => {
	const dom = create();
	const window = dom.window as unknown as Global;
	const {crypto} = window;
	expect(crypto).not.toBe(globalThis.crypto);
	expect(() => new window.Crypto()).toThrow(TypeError);
	const bytes = crypto.getRandomValues(new Uint8Array(64));
	expect(bytes.some((byte) => byte !== 0)).toBe(true);
	expect(() => crypto.getRandomValues(new Float32Array(4) as never)).toThrow(
		window.DOMException,
	);
	expect(() => crypto.getRandomValues(new Uint8Array(65537))).toThrow(
		window.DOMException,
	);
	expect(crypto.randomUUID()).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	const getRandomValues = crypto.getRandomValues;
	expect(() => getRandomValues.call({}, new Uint8Array(1))).toThrow(TypeError);
	dom.dispose();
});

test("a window's AbortController is the runtime's where the runtime has one", () => {
	const dom = create();
	const window = dom.window as unknown as Global;
	expect(window.AbortController).toBe(globalThis.AbortController);
	expect(window.AbortSignal).toBe(globalThis.AbortSignal);
	dom.dispose();
});

test("the sealed AbortController's signal aborts as the DOM says", async () => {
	const dom = create();
	const window = {
		AbortController: SealedAbortController,
		AbortSignal: SealedAbortSignal,
		DOMException: globalThis.DOMException,
	} as unknown as Global;
	expect(() => new window.AbortSignal()).toThrow(TypeError);
	const controller = new window.AbortController();
	const {signal} = controller;
	const heard: string[] = [];
	signal.onabort = (event) => heard.push(`onabort ${event.isTrusted}`);
	signal.addEventListener("abort", () => heard.push("listener"));
	expect([signal.aborted, signal.reason]).toEqual([false, undefined]);
	controller.abort();
	expect(signal.aborted).toBe(true);
	expect(signal.reason).toBeInstanceOf(window.DOMException);
	expect((signal.reason as DOMException).name).toBe("AbortError");
	expect(heard).toEqual(["onabort true", "listener"]);
	expect(() => signal.throwIfAborted()).toThrow(window.DOMException);
	controller.abort("again");
	expect(heard.length).toBe(2);

	expect(window.AbortSignal.abort("why").reason).toBe("why");
	const first = new window.AbortController();
	const second = new window.AbortController();
	const either = window.AbortSignal.any([first.signal, second.signal]);
	const nested = window.AbortSignal.any([either]);
	second.abort("second");
	expect([either.aborted, either.reason, nested.reason]).toEqual([
		true,
		"second",
		"second",
	]);
	expect(() => window.AbortSignal.any([{} as AbortSignal])).toThrow(TypeError);

	const timed = window.AbortSignal.timeout(1);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect((timed.reason as DOMException).name).toBe("TimeoutError");
	dom.dispose();
});

test("a window's timers are numbers, as a browser's are", async () => {
	const dom = create();
	const window = dom.window as unknown as Global;
	const first = window.setTimeout(() => {}, 1000) as unknown as number;
	const second = window.setInterval(() => {}, 1000) as unknown as number;
	expect([typeof first, typeof second]).toEqual(["number", "number"]);
	expect(first).toBeGreaterThan(0);
	expect(second).toBeGreaterThan(first);
	// One list for both: either clear takes either kind.
	window.clearInterval(first);
	window.clearTimeout(second);
	let ran = 0;
	const kept = window.setTimeout(() => ran++, 1);
	window.setTimeout(() => ran++, 1);
	window.clearTimeout(kept);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(ran).toBe(1);
	dom.dispose();
});
