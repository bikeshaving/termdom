/**
 * <script>: when each runs, what the page sees while it does, and the
 * "script" event a program answers to run scripts its own way.
 */
import {expect, test} from "@b9g/libuild/test";

import {type ScriptEvent, TermDOM} from "../src/index.ts";
import {MockProcess, until} from "./test-utils.js";

interface Page {
	dom: TermDOM;
	window: Record<string, any>;
	log: () => string[];
	errors: string[];
}

// A page whose scripts push to a global log. A "fetch" listener answers
// each file `files` names, and a 404 for anything else.
function page(
	html: string,
	{files = {}, scripting = "enabled", csp, listen}: {
		files?: Record<string, string>;
		scripting?: "enabled" | "none";
		csp?: string;
		listen?: (dom: TermDOM) => void;
	} = {},
): Page {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({
		transport: terminal.transport,
		scripting,
		csp,
		url: "https://example.com/app/page.html",
		html: `<!doctype html><head><script nonce="abc">var log = [];</script></head><body>${html}</body>`,
	});
	dom.addEventListener("fetch", (event) => {
		const name = new URL(event.request.url).pathname.slice(1);
		event.respondWith(
			name in files
				? new Response(files[name], {
					headers: {"content-type": "text/javascript"},
				})
				: new Response("", {status: 404}),
		);
	});
	listen?.(dom);
	const window = dom.window as unknown as Record<string, any>;
	const errors: string[] = [];
	window.addEventListener("error", (event: ErrorEvent) => {
		errors.push(event.message);
		event.preventDefault();
	});
	return {dom, window, log: () => window.log ?? [], errors};
}

async function loaded(page: Page): Promise<void> {
	await until(() => page.dom.document.readyState === "complete");
}

test("scripts run in HTML's order, and the document's state follows", async () => {
	const p = page(`<script>
			document.addEventListener("readystatechange", () => log.push("state " + document.readyState));
			document.addEventListener("DOMContentLoaded", () => log.push("DOMContentLoaded"));
			window.addEventListener("load", () => log.push("load"));
			log.push("inline " + document.readyState);
		</script>
		<script defer src="deferred.js"></script>
		<script async src="async.js"></script>
		<script src="blocking.js"></script>
		<script>log.push("after blocking");</script>`, {
		files: {
			"app/deferred.js": `log.push("deferred " + document.readyState)`,
			"app/async.js": `log.push("async")`,
			"app/blocking.js": `log.push("blocking")`,
		},
	});
	await loaded(p);
	const log = p.log();
	expect(log.filter((entry) => entry !== "async")).toEqual([
		"inline loading",
		"blocking",
		"after blocking",
		"state interactive",
		"deferred interactive",
		"DOMContentLoaded",
		"state complete",
		"load",
	]);
	expect(log.indexOf("async")).toBeLessThan(log.indexOf("load"));
	await p.dom.dispose();
});

test("a script's globals are the window's, and later scripts share them", async () => {
	const p = page(
		`<script>var shared = 1; let lexical = 2; function named() { return 3; }</script>
		<script>log.push(shared + lexical + named(), window.shared, globalThis === window, this === window);</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual([6, 1, true, true]);
	expect(p.window.shared).toBe(1);
	await p.dom.dispose();
});

test("currentScript is the running classic script, and comes back after one it inserts", async () => {
	const p = page(
		`<script id="outer">
			log.push(document.currentScript.id);
			const inner = document.createElement("script");
			inner.id = "inner";
			inner.textContent = "log.push(document.currentScript.id)";
			document.body.append(inner);
			log.push(document.currentScript.id);
		</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual(["outer", "inner", "outer"]);
	expect(p.dom.document.currentScript).toBe(null);
	await p.dom.dispose();
});

test("an inserted inline script runs inside the insertion; innerHTML's never runs", async () => {
	const p = page(
		`<script>
			const made = document.createElement("script");
			made.textContent = "log.push('made')";
			document.body.append(made);
			log.push("after append");
			document.body.insertAdjacentHTML("beforeend", "<script>log.push('innerHTML')<\\/script>");
			const range = document.createRange();
			range.selectNodeContents(document.body);
			document.body.append(range.createContextualFragment("<script>log.push('contextual')<\\/script>"));
			const empty = document.createElement("script");
			document.body.append(empty);
			empty.textContent = "log.push('text added later')";
		</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual([
		"made",
		"after append",
		"contextual",
		"text added later",
	]);
	await p.dom.dispose();
});

test("an inserted src script runs when fetched, unless async was set false, which keeps their order", async () => {
	const p = page(`<script>
			for (const name of ["slow", "fast"]) {
				const script = document.createElement("script");
				script.async = false;
				script.src = name + ".js";
				document.body.append(script);
			}
		</script>`, {
		files: {
			"app/slow.js": `log.push("slow")`,
			"app/fast.js": `log.push("fast")`,
		},
	});
	await loaded(p);
	expect(p.log()).toEqual(["slow", "fast"]);
	await p.dom.dispose();
});

test("a thrown error goes to the window and the script still loads; a failed fetch fails the element", async () => {
	const p = page(`<script src="throws.js" onload="log.push('load')"></script>
		<script src="missing.js" onerror="log.push('error')"></script>
		<script>log.push("next runs");</script>`, {
		files: {"app/throws.js": `throw new RangeError("from the script")`},
	});
	await loaded(p);
	expect(p.log()).toEqual(["load", "error", "next runs"]);
	expect(p.errors).toEqual(["from the script"]);
	await p.dom.dispose();
});

test("only JavaScript types run, and nomodule keeps a classic script from running", async () => {
	const p = page(
		`<script type="text/plain">log.push("plain")</script>
		<script type="application/json">log.push("json")</script>
		<script type="TEXT/JavaScript">log.push("javascript")</script>
		<script language="javascript">log.push("language")</script>
		<script nomodule>log.push("nomodule")</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual(["javascript", "language"]);
	await p.dom.dispose();
});

test("with scripting off nothing runs, and the document is complete", async () => {
	const p = page(`<script>log.push("ran")</script>`, {scripting: "none"});
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(p.window.log).toBe(undefined);
	expect(p.dom.document.readyState).toBe("complete");
	await p.dom.dispose();
});

test("the policy decides which scripts run: inline ones and handlers by 'unsafe-inline' or a nonce, files by script-src", async () => {
	const p = page(`<script nonce="abc">
			log.push("nonce");
			document.addEventListener("error", (event) => log.push("blocked " + event.target.src), true);
		</script>
		<script>log.push("inline")</script>
		<script src="https://elsewhere.com/x.js"></script>
		<button onclick="log.push('handler')"></button>`, {
		csp: "script-src 'self' 'nonce-abc'",
	});
	await until(() => p.window.log !== undefined);
	await loaded(p);
	p.dom.document.querySelector("button")!.click();
	expect(p.log()).toEqual(["nonce", "blocked https://elsewhere.com/x.js"]);
	await p.dom.dispose();
});

test("a script listener runs classic scripts its own way, with currentScript set until it settles", async () => {
	const seen: Array<[string, string | null, string | null]> = [];
	let finish = () => {};
	const p = page(
		`<script id="mine" src="mine.js" onload="log.push('load')"></script>`,
		{
			files: {"app/mine.js": "log.push('default ran')"},
			listen: (dom) => {
				dom.addEventListener("script", (event) => {
					if (!event.url?.endsWith("mine.js")) {
						return;
					}
					seen.push([event.kind, event.url, event.source]);
					event.respondWith(
						new Promise<void>((resolve) => {
							finish = resolve;
						}),
					);
				});
			},
		},
	);
	await until(() => seen.length === 1);
	expect(seen[0]).toEqual([
		"classic",
		"https://example.com/app/mine.js",
		"log.push('default ran')",
	]);
	expect(p.dom.document.currentScript?.id).toBe("mine");
	expect(p.log()).toEqual([]);
	finish();
	await until(() => p.log().length > 0);
	expect(p.log()).toEqual(["load"]);
	expect(p.dom.document.currentScript).toBe(null);
	await p.dom.dispose();
});

test("a listener's rejection is what the script threw, and goes to the window", async () => {
	const p = page(`<script>log.push("default")</script>`, {
		listen: (dom) => {
			dom.addEventListener("script", (event) => {
				if (event.source?.includes("default")) {
					event.respondWith(Promise.reject(new TypeError("thrown inside")));
				}
			});
		},
	});
	await loaded(p);
	expect(p.log()).toEqual([]);
	expect(p.errors).toEqual(["thrown inside"]);
	await p.dom.dispose();
});

test("the script event reaches only the TermDOM, and answers once, during dispatch", async () => {
	let late: ScriptEvent | null = null;
	const errors: string[] = [];
	const p = page(`<script>log.push("ran")</script>`, {
		listen: (dom) => {
			dom.addEventListener("script", (event) => {
				late = event;
				try {
					event.respondWith(Promise.resolve());
					event.respondWith(Promise.resolve());
				} catch (error) {
					errors.push((error as DOMException).name);
				}
			});
		},
	});
	const pageHeard: string[] = [];
	p.dom.document.addEventListener("script", () => pageHeard.push("document"));
	p.window.addEventListener("script", () => pageHeard.push("window"));
	await loaded(p);
	expect(pageHeard).toEqual([]);
	expect(errors).toEqual(["InvalidStateError", "InvalidStateError"]);
	expect(() => late!.respondWith(Promise.resolve())).toThrow();
	await p.dom.dispose();
});

test("the first script runs after the constructor, so a listener added then hears it", async () => {
	const kinds: string[] = [];
	const p = page(`<script>log.push("ran")</script>`);
	expect(p.window.log).toBe(undefined);
	p.dom.addEventListener("script", (event) => {
		kinds.push(event.kind);
	});
	await loaded(p);
	expect(kinds).toEqual(["classic", "classic"]);
	expect(p.log()).toEqual(["ran"]);
	await p.dom.dispose();
});

test("a module needs a script listener until modules run on their own", async () => {
	const requests: Array<[string | null, string | null, string]> = [];
	const p =
		page(`<script type="importmap">{"imports": {"lib": "./lib.js"}}</script>
		<script type="module" src="main.js" onload="log.push('load')"></script>
		<script type="module">export {};</script>`, {
			listen: (dom) => {
				dom.addEventListener("script", (event) => {
					if (event.kind === "module") {
						requests.push([event.url, event.source, event.importMaps.join("")]);
						event.respondWith(Promise.resolve());
					}
				});
			},
		});
	await loaded(p);
	expect(requests).toEqual([
		[
			"https://example.com/app/main.js",
			null,
			`{"imports": {"lib": "./lib.js"}}`,
		],
		[null, "export {};", `{"imports": {"lib": "./lib.js"}}`],
	]);
	expect(p.log()).toEqual(["load"]);
	await p.dom.dispose();
});

test("a document disposed while a listener runs a script hears nothing after", async () => {
	const p = page(`<script src="x.js" onload="log.push('load')"></script>`, {
		files: {"app/x.js": ""},
		listen: (dom) => {
			dom.addEventListener("script", (event) => {
				if (event.url?.endsWith("x.js")) {
					event.respondWith(new Promise<void>(() => {}));
				}
			});
		},
	});
	await until(() => p.dom.document.currentScript !== null);
	await p.dom.dispose();
	expect(p.log()).toEqual([]);
});
