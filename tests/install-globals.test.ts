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

test("installGlobals puts the window's names over the runtime's, and uninstalling puts them back", () => {
	const term = new TermDOM();
	const names = [
		"Event",
		"FormData",
		"setTimeout",
		"queueMicrotask",
		"navigator",
	];
	const before = names.map((name) =>
		Object.getOwnPropertyDescriptor(globalThis, name),
	);
	const uninstall = installGlobals(term);
	try {
		expect(global.FormData).toBe(term.window.FormData);
		expect(global.navigator).toBe(term.window.navigator);
		// The runtime's event classes stay, and serve the document too.
		expect(Object.getOwnPropertyDescriptor(globalThis, "Event"))
			.toEqual(before[0]);
		const p = term.document.createElement("p");
		let heard = 0;
		p.addEventListener("ping", () => heard++);
		p.dispatchEvent(new global.Event("ping"));
		expect(heard).toBe(1);
		// The window's timers still run, and report what they let escape.
		let ran = false;
		global.queueMicrotask(() => {
			ran = true;
		});
		return Promise.resolve().then(() => {
			expect(ran).toBe(true);
		});
	} finally {
		uninstall();
		term.dispose();
		names.forEach((name, i) => {
			expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(
				before[i],
			);
		});
	}
});

test("the runtime's own EventTargets and events go on working", () => {
	const RuntimeEventTarget = EventTarget;
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	try {
		const target = new RuntimeEventTarget();
		let heard = 0;
		target.addEventListener("ping", () => heard++);
		target.dispatchEvent(new global.Event("ping"));
		expect(heard).toBe(1);
		const controller = new AbortController();
		let aborted = 0;
		controller.signal.addEventListener("abort", () => aborted++);
		controller.abort();
		expect(aborted).toBe(1);
	} finally {
		uninstall();
		term.dispose();
	}
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

test("what a terminal does not have is left undefined, for feature detection", () => {
	const term = new TermDOM();
	expect(term.window.indexedDB).toBeUndefined();
	expect(term.window.TrustedHTML).toBeUndefined();
	const video = term.document.createElement("video");
	expect([video.buffered.length, video.textTracks.length]).toEqual([0, 0]);
	expect(() => video.buffered.start(0)).toThrow();
	expect(video.remote.state).toBe("disconnected");
	expect(video.textTracks).toBe(video.textTracks);
	expect(term.window.navigator.hardwareConcurrency).toBeGreaterThan(0);
	expect(term.window.navigator.onLine).toBe(true);
	const uninstall = installGlobals(term);
	try {
		expect(typeof global.indexedDB).toBe("undefined");
		expect(typeof global.cookieStore).toBe("undefined");
		expect("indexedDB" in globalThis).toBe(false);
	} finally {
		uninstall();
		term.dispose();
	}
});

test("uninstalling leaves a name that other code has since redefined", () => {
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	Object.defineProperty(globalThis, "scrollY", {
		value: 42,
		configurable: true,
		writable: true,
	});
	uninstall();
	expect(global.scrollY).toBe(42);
	delete global.scrollY;
	expect("document" in globalThis).toBe(false);
	term.dispose();
});

test("the installed state is shared by every copy of the module", () => {
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	try {
		expect(Reflect.get(globalThis, Symbol.for("@b9g/termdom.globalsInstalled")))
			.toBe(true);
	} finally {
		uninstall();
		term.dispose();
	}
	expect(Symbol.for("@b9g/termdom.globalsInstalled") in globalThis).toBe(false);
});

test("while installed, an unhandled rejection fires unhandledrejection and is reported", () => {
	const term = new TermDOM();
	const listeners = process.listenerCount("unhandledRejection");
	const uninstall = installGlobals(term);
	expect(process.listenerCount("unhandledRejection")).toBe(listeners + 1);
	const heard: unknown[] = [];
	const listener = (event: Event) => {
		const rejection = event as PromiseRejectionEvent;
		heard.push(rejection.reason);
		expect(rejection.promise).toBeInstanceOf(Promise);
		expect(rejection.cancelable).toBe(true);
		event.preventDefault();
	};
	term.window.addEventListener("unhandledrejection", listener);
	const reason = new Error("nobody caught me");
	const promise = Promise.resolve();
	try {
		// The listener installGlobals added, called as the runtime calls it.
		// Emitting the event would reach the test runner's own listener too.
		const ours = process.listeners("unhandledRejection").at(-1)!;
		ours(reason, promise);
		expect(heard).toEqual([reason]);
	} finally {
		uninstall();
	}
	// Uninstalled, the runtime's own handling is back.
	expect(process.listenerCount("unhandledRejection")).toBe(listeners);
	term.window.removeEventListener("unhandledrejection", listener);
	term.dispose();
});

test("the runtime's storage stays where it has one, and the window's fills in where it has none", () => {
	const had = {
		localStorage: "localStorage" in globalThis,
		sessionStorage: "sessionStorage" in globalThis,
	};
	const before = {
		localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
		sessionStorage: Object.getOwnPropertyDescriptor(
			globalThis,
			"sessionStorage",
		),
	};
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	try {
		for (const name of ["localStorage", "sessionStorage"] as const) {
			if (had[name]) {
				expect(Object.getOwnPropertyDescriptor(globalThis, name))
					.toEqual(before[name]);
			} else {
				expect(global[name]).toBe(term.window[name]);
			}
		}
	} finally {
		uninstall();
		term.dispose();
	}
});
