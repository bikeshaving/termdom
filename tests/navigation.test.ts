/**
 * The Navigation API: window.navigation's entries of the document's
 * history, the navigate event every navigation fires first, and the
 * navigations a listener intercepts.
 */
import {expect, test} from "@b9g/libuild/test";

import {type HistoryTraverseEvent, TermDOM} from "../src/index.ts";
import {inputDispatched, MockProcess, nextFrame} from "./test-utils.js";

function created(html = ""): TermDOM {
	return new TermDOM({
		transport: new MockProcess().transport,
		url: "https://example.com/a/b",
		html,
	});
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The names of the errors both of a navigation's promises reject with.
function rejections(result: NavigationResult): Promise<string[]> {
	return Promise.all(
		[result.committed!, result.finished!].map((promise) =>
			promise.then(
				() => "fulfilled",
				(error: unknown) => (error as DOMException).name,
			),
		),
	);
}

function heard(target: EventTarget, types: string[]): string[] {
	const events: string[] = [];
	for (const type of types) {
		target.addEventListener(type, (event) => {
			const navigate = event as NavigateEvent;
			const change = event as NavigationCurrentEntryChangeEvent;
			events.push(
				type === "navigate"
					? `navigate ${navigate.navigationType} ${navigate.destination.url}`
					: type === "currententrychange"
					? `currententrychange ${change.navigationType}`
					: type,
			);
		});
	}
	return events;
}

test("pushState and replaceState add and change the entries", () => {
	const dom = created();
	const {navigation, history} = dom.window;
	const first = navigation.currentEntry!;
	expect(navigation.entries()).toEqual([first]);
	expect(first.url).toBe("https://example.com/a/b");
	expect(first.index).toBe(0);
	expect(first.sameDocument).toBe(true);
	expect(navigation.canGoBack).toBe(false);
	history.pushState(null, "", "/c");
	const second = navigation.currentEntry!;
	expect(second).not.toBe(first);
	expect(second.key).not.toBe(first.key);
	expect(second.url).toBe("https://example.com/c");
	expect(navigation.entries()).toEqual([first, second]);
	expect(navigation.canGoBack).toBe(true);
	expect(navigation.canGoForward).toBe(false);
	history.replaceState(null, "", "/d");
	const third = navigation.currentEntry!;
	expect(third.key).toBe(second.key);
	expect(third.id).not.toBe(second.id);
	expect(second.index).toBe(-1);
	expect(navigation.entries().map((entry) => entry.url)).toEqual([
		"https://example.com/a/b",
		"https://example.com/d",
	]);
	expect(history.length).toBe(2);
	dom.dispose();
});

test("each navigation fires navigate, then currententrychange", async () => {
	const dom = created("<p id=top>t</p>");
	const {window} = dom;
	const events = heard(window.navigation, [
		"navigate",
		"currententrychange",
		"navigatesuccess",
	]);
	window.addEventListener("popstate", () => events.push("popstate"));
	window.addEventListener("hashchange", () => events.push("hashchange"));
	window.history.pushState(null, "", "/c");
	await tick();
	window.location.hash = "top";
	await tick();
	expect(events).toEqual([
		"navigate push https://example.com/c",
		"currententrychange push",
		"navigatesuccess",
		"navigate push https://example.com/c#top",
		"currententrychange push",
		"popstate",
		"navigatesuccess",
		"hashchange",
	]);
	dom.dispose();
});

test("canceling navigate stops pushState and a fragment navigation", () => {
	const dom = created("<a href=#x>x</a>");
	const {window, document} = dom;
	const cancelable: boolean[] = [];
	window.navigation.addEventListener("navigate", (event) => {
		cancelable.push(event.cancelable);
		event.preventDefault();
	});
	const errors: string[] = [];
	window.navigation.onnavigateerror = (event) => {
		errors.push((event as ErrorEvent).error.name);
	};
	window.history.pushState(null, "", "/c");
	document.querySelector("a")!.click();
	expect(window.location.href).toBe("https://example.com/a/b");
	expect(window.history.length).toBe(1);
	expect(cancelable).toEqual([true, true]);
	expect(errors).toEqual(["AbortError", "AbortError"]);
	dom.dispose();
});

test("history.back() goes between the document's own entries", async () => {
	const dom = created();
	const {window} = dom;
	const asked: number[] = [];
	dom.addEventListener("historytraverse", (event: HistoryTraverseEvent) => {
		asked.push(event.delta);
	});
	const states: unknown[] = [];
	window.addEventListener("popstate", (event) => {
		states.push((event as PopStateEvent).state);
	});
	const events = heard(window.navigation, ["navigate", "currententrychange"]);
	window.history.pushState({n: 1}, "", "/c");
	window.history.pushState({n: 2}, "", "/d");
	events.length = 0;
	window.history.back();
	expect(window.location.pathname).toBe("/d");
	await tick();
	expect(window.location.pathname).toBe("/c");
	expect(window.history.state).toEqual({n: 1});
	expect(window.navigation.currentEntry!.index).toBe(1);
	expect(window.navigation.canGoForward).toBe(true);
	window.history.go(-1);
	await tick();
	expect(window.location.pathname).toBe("/a/b");
	window.history.forward();
	window.history.forward();
	await tick();
	await tick();
	expect(window.location.pathname).toBe("/d");
	expect(states).toEqual([{n: 1}, null, {n: 1}, {n: 2}]);
	expect(events.slice(0, 2)).toEqual([
		"navigate traverse https://example.com/c",
		"currententrychange traverse",
	]);
	expect(asked).toEqual([]);
	window.history.forward();
	await tick();
	expect(asked).toEqual([1]);
	dom.dispose();
});

test("navigate() to a fragment commits and finishes with the new entry", async () => {
	const dom = created();
	const {navigation} = dom.window;
	const {committed, finished} = navigation.navigate("#x", {
		state: {saved: 1},
		info: "why",
	});
	const infos: unknown[] = [];
	navigation.addEventListener("navigate", (event) => infos.push(event.info));
	const entry = (await committed)!;
	expect(entry).toBe(navigation.currentEntry);
	expect(await finished).toBe(entry);
	expect(entry.url).toBe("https://example.com/a/b#x");
	expect(entry.getState()).toEqual({saved: 1});
	expect(entry.getState()).not.toBe(entry.getState());
	navigation.navigate("#y", {info: "again"});
	expect(infos).toEqual(["again"]);
	expect(navigation.currentEntry!.getState()).toBe(undefined);
	dom.dispose();
});

test("an intercepted navigation to another path runs its handler", async () => {
	const dom = created("<input autofocus><p id=y>y</p>");
	const {window, document} = dom;
	const {navigation} = window;
	const events = heard(navigation, [
		"navigate",
		"currententrychange",
		"navigatesuccess",
	]);
	let release!: () => void;
	navigation.addEventListener("navigate", (event) => {
		expect(event.canIntercept).toBe(true);
		expect(event.destination.sameDocument).toBe(false);
		event.intercept({
			handler: () => {
				events.push(`handler at ${window.location.pathname}`);
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			},
		});
	});
	document.body.focus();
	const {committed, finished} = navigation.navigate("/other");
	expect(window.location.href).toBe("https://example.com/other");
	expect((await committed)!.url).toBe("https://example.com/other");
	const transition = navigation.transition!;
	expect(transition.navigationType).toBe("push");
	expect(transition.from.url).toBe("https://example.com/a/b");
	expect((transition as unknown as {to: NavigationDestination}).to.url).toBe(
		"https://example.com/other",
	);
	release();
	expect((await finished)!.url).toBe("https://example.com/other");
	await transition.finished;
	expect(navigation.transition).toBe(null);
	expect(events).toEqual([
		"navigate push https://example.com/other",
		"currententrychange push",
		"handler at /other",
		"navigatesuccess",
	]);
	expect(document.activeElement).toBe(document.querySelector("input"));
	expect(navigation.entries().length).toBe(2);
	dom.dispose();
});

test("a handler that rejects fires navigateerror and rejects finished", async () => {
	const dom = created();
	const {navigation} = dom.window;
	navigation.onnavigate = (event) => {
		event.intercept({handler: () => Promise.reject(new Error("no"))});
	};
	let heardError: unknown = null;
	navigation.onnavigateerror = (event) => {
		heardError = (event as ErrorEvent).error;
	};
	const {committed, finished} = navigation.navigate("/x");
	await committed;
	const reason = await finished!.catch((error: unknown) => error);
	expect((reason as Error).message).toBe("no");
	expect(heardError).toBe(reason);
	expect(dom.window.location.pathname).toBe("/x");
	dom.dispose();
});

test("a navigation to another document nothing intercepts is not supported", async () => {
	const dom = created();
	const {window} = dom;
	const errors: string[] = [];
	window.navigation.onnavigateerror = (event) => {
		errors.push((event as ErrorEvent).error.name);
	};
	const {committed, finished} = window.navigation.navigate("/x");
	expect(await rejections({committed, finished})).toEqual([
		"NotSupportedError",
		"NotSupportedError",
	]);
	for (
		const navigate of [
			() => window.location.assign("/x"),
			() => (window.location.search = "?q"),
			() => window.location.reload(),
		]
	) {
		expect(navigate).toThrow();
	}
	expect(errors.length).toBe(4);
	expect(window.location.href).toBe("https://example.com/a/b");
	dom.dispose();
});

test("location navigates through an intercepting listener", async () => {
	const dom = created();
	const {window} = dom;
	const types: string[] = [];
	window.navigation.addEventListener("navigate", (event) => {
		types.push(event.navigationType);
		event.intercept();
	});
	window.location.assign("/x?y");
	expect(window.location.href).toBe("https://example.com/x?y");
	window.location.replace("/z");
	window.location.pathname = "/w";
	window.location.reload();
	expect(window.location.href).toBe("https://example.com/w");
	expect(types).toEqual(["push", "replace", "push", "reload"]);
	expect(window.history.length).toBe(3);
	await tick();
	dom.dispose();
});

test("following a link fires navigate with the link as its source", async () => {
	const proc = new MockProcess();
	const dom = new TermDOM({
		transport: proc.transport,
		url: "https://example.com/a/b",
		html: "<a href=/next>next</a><a href=#f download=f.txt>f</a>",
	});
	dom.attach();
	await nextFrame(dom);
	const {window, document} = dom;
	const seen: Array<[string, boolean, unknown, string | null]> = [];
	window.navigation.addEventListener("navigate", (event) => {
		seen.push([
			event.destination.url,
			event.userInitiated,
			event.sourceElement,
			event.downloadRequest,
		]);
		if (event.downloadRequest === null) {
			event.intercept();
		}
	});
	(proc.stdin as any).emit("data", Buffer.from("\x1b[<0;1;1M\x1b[<0;1;1m"));
	await new Promise((resolve) => setTimeout(resolve, 30));
	await inputDispatched();
	const [next, download] = document.querySelectorAll("a");
	download.click();
	expect(seen).toEqual([
		["https://example.com/next", true, next, null],
		["https://example.com/next#f", false, download, "f.txt"],
	]);
	expect(window.location.href).toBe("https://example.com/next");
	dom.dispose();
});

test("submitting a form fires navigate in a task, with a POST's data", async () => {
	const dom = created(
		"<form method=post action=/save><input name=q value=1></form>" +
			"<form id=get action=/find><input name=s value='a b'></form>",
	);
	const {window, document} = dom;
	const seen: Array<[string, string | null]> = [];
	window.navigation.addEventListener("navigate", (event) => {
		seen.push([
			event.destination.url,
			event.formData === null ? null : String(event.formData.get("q")),
		]);
		event.preventDefault();
	});
	const [post, get] = document.querySelectorAll("form");
	post.requestSubmit();
	post.submit();
	get.submit();
	expect(seen).toEqual([]);
	await tick();
	expect(seen).toEqual([
		["https://example.com/save", "1"],
		["https://example.com/find?s=a+b", null],
	]);
	dom.dispose();
});

test("traverseTo, back and forward settle with the entry they reach", async () => {
	const dom = created();
	const {navigation, history} = dom.window;
	const first = navigation.currentEntry!;
	history.pushState(null, "", "/c");
	history.pushState(null, "", "/d");
	const back = navigation.traverseTo(first.key);
	expect(navigation.traverseTo(first.key).committed).toBe(back.committed);
	expect(await back.finished).toBe(first);
	expect(dom.window.location.pathname).toBe("/a/b");
	const forward = navigation.forward();
	expect((await forward.committed)!.url).toBe("https://example.com/c");
	expect(await rejections(navigation.traverseTo("nope"))).toEqual([
		"InvalidStateError",
		"InvalidStateError",
	]);
	navigation.addEventListener("navigate", (event) => event.preventDefault());
	expect(await rejections(navigation.back())).toEqual([
		"AbortError",
		"AbortError",
	]);
	expect(dom.window.location.pathname).toBe("/c");
	dom.dispose();
});

test("an intercepted traversal commits before its handler runs", async () => {
	const dom = created();
	const {window} = dom;
	window.history.pushState(null, "", "/c");
	let at = "";
	window.navigation.addEventListener("navigate", (event) => {
		event.intercept({
			handler: async () => {
				at = window.location.pathname;
			},
		});
	});
	await window.navigation.back().finished;
	expect(at).toBe("/a/b");
	dom.dispose();
});

test("updateCurrentEntry() changes the state and fires currententrychange", () => {
	const dom = created();
	const {navigation} = dom.window;
	const changes: Array<[unknown, unknown]> = [];
	navigation.oncurrententrychange = (event) => {
		changes.push([event.navigationType, event.from]);
	};
	navigation.updateCurrentEntry({state: [1]});
	expect(navigation.currentEntry!.getState()).toEqual([1]);
	expect(changes).toEqual([[null, navigation.currentEntry]]);
	expect(() =>
		navigation.updateCurrentEntry({} as NavigationUpdateCurrentEntryOptions),
	).toThrow(TypeError);
	dom.dispose();
});

test("entries the history drops hear dispose", () => {
	const dom = created();
	const {navigation, history} = dom.window;
	history.pushState(null, "", "/c");
	history.pushState(null, "", "/d");
	const [, c, d] = navigation.entries();
	const disposed: string[] = [];
	for (const entry of [c, d]) {
		entry.addEventListener("dispose", () => disposed.push(entry.url!));
	}
	history.replaceState(null, "", "/e");
	expect(disposed).toEqual(["https://example.com/d"]);
	dom.dispose();
});

test("a navigate event only the browser fires can be intercepted", () => {
	const dom = created();
	const {window} = dom;
	let fired: NavigateEvent | null = null;
	window.navigation.addEventListener("navigate", (navigate) => {
		fired = navigate;
	});
	window.location.hash = "x";
	expect(fired!.hashChange).toBe(true);
	const event = new window.NavigateEvent("navigate", {
		destination: fired!.destination,
		signal: new window.AbortController().signal,
		canIntercept: true,
	});
	expect(event.navigationType).toBe("push");
	expect(() => event.intercept()).toThrow();
	let name = "";
	try {
		event.intercept();
	} catch (error) {
		name = (error as DOMException).name;
	}
	expect(name).toBe("SecurityError");
	expect(() =>
		new window.NavigateEvent("navigate", {} as NavigateEventInit),
	).toThrow(TypeError);
	dom.dispose();
});

test("a document of an opaque origin has no entries and fires no navigate", () => {
	const dom = new TermDOM({
		transport: new MockProcess().transport,
		html: "<a href=#x>x</a>",
	});
	const {window, document} = dom;
	let fired = false;
	window.navigation.onnavigate = () => {
		fired = true;
	};
	document.querySelector("a")!.click();
	expect(window.location.href).toBe("about:blank#x");
	expect(window.navigation.currentEntry).toBe(null);
	expect(window.navigation.entries()).toEqual([]);
	expect(fired).toBe(false);
	dom.dispose();
});

test("traverse() goes to the nearest entry with the URL", async () => {
	const dom = created();
	const {window} = dom;
	const events = heard(window.navigation, ["navigate"]);
	window.history.pushState(null, "", "/c");
	window.history.pushState(null, "", "/d");
	events.length = 0;
	dom.traverse("https://example.com/a/b", {back: true});
	expect(window.navigation.currentEntry!.index).toBe(0);
	expect(window.history.state).toEqual({back: true});
	expect(window.history.length).toBe(3);
	expect(events).toEqual(["navigate traverse https://example.com/a/b"]);
	await tick();
	dom.dispose();
});

test("a removed frame's navigation is not shown and rejects", async () => {
	const dom = created("<iframe srcdoc=\"<p>hi</p>\"></iframe>");
	await tick();
	const frame = dom.document.querySelector("iframe")!;
	const frameWindow = frame.contentWindow!;
	const {navigation} = frameWindow;
	const entry = navigation.currentEntry!;
	const p = frame.contentDocument!.querySelector("p")!;
	expect(entry.url).toBe("about:srcdoc");
	frame.remove();
	expect(frame.contentWindow).toBe(null);
	expect(p.checkVisibility()).toBe(false);
	p.style.width = "10px";
	p.getBoundingClientRect();
	expect([entry.url, entry.key, entry.index]).toEqual(["", "", -1]);
	expect(await rejections(navigation.navigate("#x"))).toEqual([
		"InvalidStateError",
		"InvalidStateError",
	]);
	expect(await rejections(navigation.reload())).toEqual([
		"InvalidStateError",
		"InvalidStateError",
	]);
	dom.dispose();
});
