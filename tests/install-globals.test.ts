import {expect, test} from "@b9g/libuild/test";

import {installGlobals, TermDOM} from "../src/index.ts";

const global = globalThis as Record<string, any>;

test("installGlobals defines the window's names the runtime lacks", () => {
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	try {
		expect(global.document).toBe(term.document);
		expect(global.window).toBe(term.window);
		expect(global.Element).toBe(term.window.Element);
		expect(global.MutationObserver).toBe(term.window.MutationObserver);
		term.document.body.innerHTML = "<p>hi</p>";
		const p = global.document.querySelector("p");
		expect(p instanceof global.Element).toBe(true);
		expect(global.getComputedStyle(p).display).toBe("block");
		expect(typeof global.requestAnimationFrame).toBe("function");
	} finally {
		uninstall();
		term.dispose();
	}
});

test("installGlobals leaves the runtime's own globals alone", () => {
	const term = new TermDOM();
	const event = global.Event;
	const fetch = global.fetch;
	const uninstall = installGlobals(term);
	try {
		expect(global.Event).toBe(event);
		expect(global.fetch).toBe(fetch);
	} finally {
		uninstall();
		term.dispose();
	}
	expect(global.Event).toBe(event);
	expect(global.fetch).toBe(fetch);
});

test("installed properties read and write through to the window", () => {
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	try {
		const handler = () => {};
		global.onkeydown = handler;
		expect(term.window.onkeydown).toBe(handler);
		term.window.onkeydown = null;
		expect(global.onkeydown).toBe(null);
		expect(global.innerWidth).toBe(term.window.innerWidth);
	} finally {
		uninstall();
		term.dispose();
	}
});

test("installGlobals throws while installed, and uninstalling removes every name", () => {
	const term = new TermDOM();
	const before = new Set(Object.getOwnPropertyNames(globalThis));
	const uninstall = installGlobals(term);
	try {
		expect(() => installGlobals(term)).toThrow();
	} finally {
		uninstall();
	}
	expect(new Set(Object.getOwnPropertyNames(globalThis))).toEqual(before);
	expect("document" in globalThis).toBe(false);
	installGlobals(term)();
	term.dispose();
});
