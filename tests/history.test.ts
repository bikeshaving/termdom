/**
 * The history of a page's own document: pushState and replaceState moving
 * the document's URL, the events that tell the embedder of each entry, and
 * traverse(), the embedder's way back or forward to one.
 */
import {expect, test} from "@b9g/libuild/test";

import {
	type HistoryChangeEvent,
	type HistoryTraverseEvent,
	TermDOM,
} from "../src/index.ts";
import {MockProcess} from "./test-utils.js";

function created(html = "<a id=link href=c>c</a>"): TermDOM {
	return new TermDOM({
		transport: new MockProcess().transport,
		url: "https://example.com/a/b",
		html,
	});
}

function heard(
	dom: TermDOM,
): Array<{url: string; state: unknown; replace: boolean}> {
	const changes: Array<{url: string; state: unknown; replace: boolean}> = [];
	dom.addEventListener("historychange", (event: HistoryChangeEvent) => {
		changes.push({url: event.url, state: event.state, replace: event.replace});
	});
	return changes;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("pushState moves the document's URL and what resolves against it", () => {
	const dom = created();
	const {window, document} = dom;
	const changes = heard(dom);
	window.history.pushState({page: 2}, "", "/x/y?q=1");
	expect(window.location.href).toBe("https://example.com/x/y?q=1");
	expect(document.URL).toBe("https://example.com/x/y?q=1");
	expect(document.baseURI).toBe("https://example.com/x/y?q=1");
	expect((document.getElementById("link") as HTMLAnchorElement).href)
		.toBe("https://example.com/x/c");
	expect(window.history.state).toEqual({page: 2});
	expect(window.history.length).toBe(2);
	expect(changes).toEqual([
		{url: "https://example.com/x/y?q=1", state: {page: 2}, replace: false},
	]);
	dom.dispose();
});

test("replaceState changes the current entry and keeps the count", () => {
	const dom = created();
	const {window} = dom;
	const changes = heard(dom);
	window.history.replaceState("s", "", "z");
	window.history.replaceState("t", "");
	expect(window.location.href).toBe("https://example.com/a/z");
	expect(window.history.state).toBe("t");
	expect(window.history.length).toBe(1);
	expect(changes.map((change) => change.replace)).toEqual([true, true]);
	expect(changes[1].url).toBe("https://example.com/a/z");
	dom.dispose();
});

test("the state is a structured clone of what the page passed", () => {
	const dom = created();
	const {window} = dom;
	const data = {list: [1, 2]};
	window.history.pushState(data, "");
	data.list.push(3);
	expect(window.history.state).toEqual({list: [1, 2]});
	expect(window.history.state).toBe(window.history.state);
	expect(() => window.history.pushState(() => {}, "")).toThrow();
	dom.dispose();
});

test("a URL of another origin is a SecurityError and changes nothing", () => {
	const dom = created();
	const {window} = dom;
	const changes = heard(dom);
	for (const url of ["https://other.example/", "http://example.com/a/b"]) {
		let name = "";
		try {
			window.history.pushState(null, "", url);
		} catch (error) {
			name = (error as DOMException).name;
		}
		expect(name).toBe("SecurityError");
	}
	expect(window.location.href).toBe("https://example.com/a/b");
	expect(changes).toEqual([]);
	dom.dispose();
});

test("pushState resolves against the document's base element", () => {
	const dom = created("<base href=/base/dir/>");
	dom.window.history.pushState(null, "", "page");
	expect(dom.window.location.href).toBe("https://example.com/base/dir/page");
	dom.dispose();
});

test("pushState leaves :target where it was and fires no hashchange", async () => {
	const dom = created("<p id=one>1</p><p id=two>2</p>");
	const {window, document} = dom;
	const hashes: string[] = [];
	window.addEventListener("hashchange", () =>
		hashes.push(window.location.hash),
	);
	window.location.hash = "one";
	window.history.pushState(null, "", "#two");
	expect(window.location.hash).toBe("#two");
	expect(document.getElementById("one")!.matches(":target")).toBe(true);
	expect(document.getElementById("two")!.matches(":target")).toBe(false);
	await tick();
	expect(hashes.length).toBe(1);
	dom.dispose();
});

test("going to a fragment is a new entry with no state", () => {
	const dom = created("<a href=#top>top</a><p id=top>t</p>");
	const {window, document} = dom;
	const changes = heard(dom);
	window.history.replaceState("kept", "");
	document.querySelector("a")!.click();
	expect(window.history.state).toBe(null);
	window.location.hash = "top";
	window.location.replace("#else");
	document.querySelector("a")!.click();
	expect(changes.slice(1)).toEqual([
		{url: "https://example.com/a/b#top", state: null, replace: false},
		{url: "https://example.com/a/b#else", state: null, replace: true},
		{url: "https://example.com/a/b#top", state: null, replace: false},
	]);
	dom.dispose();
});

test("traverse() takes an entry's URL and state and fires popstate", async () => {
	const dom = created("<p id=top>t</p>");
	const {window, document} = dom;
	const events: string[] = [];
	window.addEventListener("popstate", (event) => {
		events.push(`popstate ${JSON.stringify((event as PopStateEvent).state)}`);
		events.push(`at ${window.location.href}`);
	});
	window.addEventListener("hashchange", (event) => {
		events.push(`hashchange ${(event as HashChangeEvent).newURL}`);
	});
	window.history.pushState({n: 1}, "", "/c");
	dom.traverse("https://example.com/a/b", null);
	expect(window.history.state).toBe(null);
	dom.traverse("https://example.com/a/b#top", {n: 2});
	expect(document.getElementById("top")!.matches(":target")).toBe(true);
	expect(window.history.state).toEqual({n: 2});
	await tick();
	expect(events).toEqual([
		"popstate null",
		"at https://example.com/a/b",
		'popstate {"n":2}',
		"at https://example.com/a/b#top",
		"hashchange https://example.com/a/b#top",
	]);
	expect(() => dom.traverse("https://other.example/", null)).toThrow();
	dom.dispose();
	expect(() => dom.traverse("https://example.com/a/b", null)).toThrow();
});

test("back, forward and go ask the embedder, after the call returns", async () => {
	const dom = created();
	const {window} = dom;
	const deltas: number[] = [];
	dom.addEventListener("historytraverse", (event: HistoryTraverseEvent) => {
		deltas.push(event.delta);
	});
	window.history.back();
	window.history.forward();
	window.history.go(-3);
	window.history.go();
	expect(deltas).toEqual([]);
	await tick();
	expect(deltas).toEqual([-1, 1, -3, 0]);
	dom.dispose();
});

test("History and PopStateEvent are the window's interfaces", () => {
	const dom = created();
	const {window} = dom;
	expect(window.history instanceof window.History).toBe(true);
	expect(Object.prototype.toString.call(window.history))
		.toBe("[object History]");
	expect(() => new window.History()).toThrow(TypeError);
	const event = new window.PopStateEvent("popstate", {state: 5});
	expect(event.state).toBe(5);
	expect(new window.PopStateEvent("popstate").state).toBe(null);
	window.history.scrollRestoration = "manual";
	window.history.scrollRestoration = "nonsense" as ScrollRestoration;
	expect(window.history.scrollRestoration).toBe("manual");
	dom.dispose();
});
