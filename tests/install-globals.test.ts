import {expect, test} from "@b9g/libuild/test";

import {installGlobals, TermDOM} from "../src/index.ts";
import {MockProcess} from "./test-utils.ts";

const global = globalThis as Record<string, any>;
declare const event: unknown;

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

test("names that are null or primitive on the window and the runtime alike are still the window's", () => {
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	try {
		const heard: string[] = [];
		global.onerror = (message: string) => {
			heard.push(message);
		};
		term.window.dispatchEvent(
			new term.window.ErrorEvent("error", {message: "boom"}),
		);
		expect(heard).toEqual(["boom"]);
		expect(term.window.onerror).toBe(global.onerror);
		global.name = "x";
		expect(term.window.name).toBe("x");
		expect(global.closed).toBe(term.window.closed);
		global.onerror = null;
	} finally {
		uninstall();
		term.dispose();
	}
});

test("a bare event reads the window's event, undefined, rather than throwing", () => {
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	try {
		expect("event" in globalThis).toBe(true);
		expect(typeof event).toBe("undefined");
		expect(event).toBe(term.window.event);
	} finally {
		uninstall();
		term.dispose();
	}
	expect("event" in globalThis).toBe(false);
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

test("what a terminal does not have is missing, for feature detection", () => {
	const term = new TermDOM();
	expect(term.window.indexedDB).toBeUndefined();
	for (
		const name of [
			"indexedDB",
			"caches",
			"cookieStore",
			"navigation",
			"scheduler",
			"speechSynthesis",
			"trustedTypes",
			"TrustedHTML",
		]
	) {
		expect(name in term.window).toBe(false);
	}
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

test("fetch goes to the network while installed, and to a mock put in its place", async () => {
	const term = new TermDOM();
	const uninstall = installGlobals(term);
	try {
		const response = await global.fetch("data:text/plain,hello");
		expect(await response.text()).toBe("hello");
		const real = global.fetch;
		global.fetch = async () => new Response("mocked");
		try {
			const mocked = await term.window.fetch("https://example.test/");
			expect(await mocked.text()).toBe("mocked");
		} finally {
			global.fetch = real;
		}
	} finally {
		uninstall();
		await term.dispose();
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

test("while installed, a rejection handled late fires rejectionhandled on the window once", () => {
	const term = new TermDOM();
	const listeners = process.listenerCount("rejectionHandled");
	const uninstall = installGlobals(term);
	// Deno fires its own at the global, which is the window's.
	if ("Deno" in globalThis) {
		expect(process.listenerCount("rejectionHandled")).toBe(listeners);
		uninstall();
		term.dispose();
		return;
	}
	expect(process.listenerCount("rejectionHandled")).toBe(listeners + 1);
	const heard: PromiseRejectionEvent[] = [];
	const listener = (event: Event) => {
		heard.push(event as PromiseRejectionEvent);
	};
	term.window.addEventListener("rejectionhandled", listener);
	const reason = new Error("late");
	const promise = Promise.resolve();
	try {
		const unhandled = process.listeners("unhandledRejection").at(-1)!;
		const handledLate = process.listeners("rejectionHandled").at(-1)!;
		term.window.addEventListener("unhandledrejection", (event) =>
			event.preventDefault(),
		);
		unhandled(reason, promise);
		handledLate(promise);
		expect(heard.length).toBe(1);
		expect(heard[0].type).toBe("rejectionhandled");
		expect(heard[0].promise).toBe(promise);
		expect(heard[0].reason).toBe(reason);
	} finally {
		uninstall();
	}
	expect(process.listenerCount("rejectionHandled")).toBe(listeners);
	term.window.removeEventListener("rejectionhandled", listener);
	term.dispose();
});

test("the runtime's storage stays where it has one, and the window's fills in where it has none", () => {
	// Node defines its storage as undefined without --localstorage-file,
	// and warns when it is read.
	const emitWarning = process.emitWarning;
	process.emitWarning = () => {};
	const had = {
		localStorage: global.localStorage != null,
		sessionStorage: global.sessionStorage != null,
	};
	process.emitWarning = emitWarning;
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

test("animate() finishes on the next task, for code that waits on it", async () => {
	const term = new TermDOM();
	const element = term.document.createElement("div");
	const animation = element.animate([{opacity: 0}, {opacity: 1}], 300);
	const heard: string[] = [];
	animation.onfinish = () => heard.push("onfinish");
	animation.addEventListener("finish", () => heard.push("finish"));
	expect(animation.playState).toBe("running");
	await animation.finished;
	expect(heard).toEqual(["onfinish", "finish"]);
	expect(animation.playState).toBe("finished");
	expect(animation.currentTime).toBe(300);

	const canceled = element.animate([{opacity: 0}], {duration: 300});
	canceled.onfinish = () => heard.push("late");
	canceled.cancel();
	let outcome = "";
	await canceled.finished.catch(
		(error: DOMException) => (outcome = error.name),
	);
	expect(outcome).toBe("AbortError");
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(heard).toEqual(["onfinish", "finish"]);
	term.dispose();
});

test("dispose() settles under installGlobals, and stops only the window's own timers", async () => {
	const terminal = new MockProcess({cols: 20, rows: 4});
	const term = new TermDOM({transport: terminal.transport});
	const uninstall = installGlobals(term);
	const ran: string[] = [];
	try {
		await term.attach();
		term.window.setTimeout(() => ran.push("window"), 20);
		global.setTimeout(() => ran.push("global"), 20);
		await term.dispose();
	} finally {
		uninstall();
	}
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(ran).toEqual(["global"]);
});
