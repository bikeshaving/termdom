/**
 * What a page, or the program embedding TermDOM, can reach holds nothing of
 * the engine's or the runtime's: no symbol-keyed state or steps on any
 * object or prototype, and no object the runtime made where a browser
 * would hand out its own.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
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

test("DOMException is the DOM's own, an Error with WebIDL's members", () => {
	const dom = create();
	const window = dom.window as unknown as Global;
	const {DOMException} = window;
	expect(DOMException).not.toBe(globalThis.DOMException);
	const error = new DOMException("gone", "NotFoundError");
	expect(error).toBeInstanceOf(Error);
	expect(Object.getPrototypeOf(DOMException.prototype)).toBe(Error.prototype);
	expect([error.name, error.message, error.code]).toEqual([
		"NotFoundError",
		"gone",
		8,
	]);
	expect(new DOMException().name).toBe("Error");
	expect(new DOMException("x", "Unlisted").code).toBe(0);
	expect([DOMException.NOT_FOUND_ERR, error.NOT_FOUND_ERR]).toEqual([8, 8]);
	expect(String(error)).toBe("NotFoundError: gone");
	expect(Object.prototype.toString.call(error)).toBe("[object DOMException]");
	const name = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")!;
	expect(() => name.get!.call({})).toThrow(TypeError);
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
