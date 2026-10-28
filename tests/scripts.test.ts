/**
 * <script>: when each runs, what the page sees while it does, and the
 * "script" event a program answers to run scripts its own way.
 */
import {expect, test} from "@b9g/libuild/test";

import {type ScriptEvent, TermDOM} from "../src/index.ts";
import {canCreateRealms, canRunModules} from "../src/internal/realms.ts";
import {MockProcess, until} from "./test-utils.js";

const withModules = canRunModules() ? test : test.skip;
const withoutModules = canRunModules() ? test.skip : test;
const withRealms = canCreateRealms() ? test : test.skip;

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
	{files = {}, scripting = "enabled", csp, head = "", listen}: {
		files?: Record<string, string>;
		scripting?: "enabled" | "none";
		csp?: string;
		head?: string;
		listen?: (dom: TermDOM) => void;
	} = {},
): Page {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({
		transport: terminal.transport,
		scripting,
		csp,
		url: "https://example.com/app/page.html",
		html: `<!doctype html><head>${head}<script nonce="abc">var log = [];</script></head><body>${html}</body>`,
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

test("a script listener gets modules, with the import maps that count", async () => {
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

withModules(
	"modules run after the parse, with their imports, import maps and import.meta",
	async () => {
		const p = page(`<script type="importmap">{"imports": {"lib": "./lib/index.js", "lib/": "./lib/"}}</script>
		<script type="module" src="main.js" onload="log.push('load')"></script>
		<script>log.push("classic first");</script>
		<script type="module">
			import {name} from "lib/name.js";
			log.push("inline " + name + " " + import.meta.url);
		</script>`, {
			files: {
				"app/main.js": `
					import {value} from "lib";
					import {name} from "./lib/name.js";
					log.push("main " + value + " " + name + " " + import.meta.url);
					const {late} = await import("./late.js");
					log.push(late);
				`,
				"app/lib/index.js": `export const value = "from lib";`,
				"app/lib/name.js": `log.push("name.js runs once"); export const name = "name";`,
				"app/late.js": `export const late = "imported later";`,
			},
		});
		await loaded(p);
		expect(p.log()).toEqual([
			"classic first",
			"name.js runs once",
			"main from lib name https://example.com/app/main.js",
			"imported later",
			"load",
			"inline name https://example.com/app/page.html",
		]);
		await p.dom.dispose();
	},
);

withModules("a classic script can import() a module", async () => {
	const p = page(
		`<script>import("./mod.js").then((m) => log.push(m.answer));</script>`,
		{files: {"app/mod.js": "export const answer = 42;"}},
	);
	await until(() => p.log().length > 0);
	expect(p.log()).toEqual([42]);
	await p.dom.dispose();
});

withModules(
	"a module that cannot load fails its element; one that throws reports it and loads",
	async () => {
		const p = page(
			`<script type="module" src="missing.js" onerror="log.push('missing')"></script>
		<script type="module" src="text.js" onerror="log.push('not JavaScript')"></script>
		<script type="module" src="bare.js" onerror="log.push('unmapped')"></script>
		<script type="module" src="throws.js" onload="log.push('load')"></script>`,
			{
				files: {
					"app/bare.js": `import "nowhere";`,
					"app/throws.js": `throw new Error("in the module");`,
				},
			},
		);
		p.dom.addEventListener("fetch", (event) => {
			if (event.request.url.endsWith("text.js")) {
				event.respondWith(
					new Response("export {}", {headers: {"content-type": "text/plain"}}),
				);
			}
		});
		await loaded(p);
		expect(p.log()).toEqual(["missing", "not JavaScript", "unmapped", "load"]);
		expect(p.errors).toEqual(["in the module"]);
		await p.dom.dispose();
	},
);

withoutModules(
	"without SourceTextModule a module fails, and says what it needs",
	async () => {
		const messages: string[] = [];
		const p = page(`<script type="module">log.push("ran")</script>`);
		p.dom.document.addEventListener(
			"error",
			(event) => messages.push((event as ErrorEvent).message),
			true,
		);
		await loaded(p);
		expect(p.log()).toEqual([]);
		expect(messages[0]).toContain("--experimental-vm-modules");
		await p.dom.dispose();
	},
);

const FRAME = `<iframe srcdoc="
	<script>
		var inFrame = 1;
		parent.log.push(
			'frame script',
			window !== parent,
			document.readyState,
			document.currentScript !== null,
			[] instanceof parent.Array,
		);
		document.addEventListener('DOMContentLoaded', () => parent.log.push('frame DOMContentLoaded'));
	</script>
	<button onclick=&quot;parent.log.push('frame handler', typeof inFrame)&quot;>go</button>
"></iframe>`;

withRealms(
	"a frame's scripts and handlers run in its own realm, with its own document state",
	async () => {
		const p = page(FRAME);
		await until(() => p.log().includes("frame DOMContentLoaded"));
		expect(p.log()).toEqual([
			"frame script",
			true,
			"loading",
			true,
			false,
			"frame DOMContentLoaded",
		]);
		expect(p.window.inFrame).toBe(undefined);
		const frame = p.dom.document.querySelector("iframe")!;
		(frame.contentDocument!.querySelector(
			"button",
		) as HTMLButtonElement).click();
		expect(p.log().slice(-2)).toEqual(["frame handler", "number"]);
		await p.dom.dispose();
	},
);

withRealms(
	"a frame's scripts reach the TermDOM's script listener, with the frame's document",
	async () => {
		const documents: unknown[] = [];
		const p = page(FRAME, {
			listen: (dom) => {
				dom.addEventListener("script", (event) => {
					documents.push(event.document);
				});
			},
		});
		await until(() => p.log().includes("frame DOMContentLoaded"));
		const frame = p.dom.document.querySelector("iframe")!;
		expect(documents).toEqual([p.dom.document, frame.contentDocument]);
		await p.dom.dispose();
	},
);

withRealms("a frame runs nothing when its page runs no scripts", async () => {
	const p = page(FRAME, {scripting: "none"});
	const frame = p.dom.document.querySelector("iframe")!;
	void frame.contentDocument;
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(
		(frame.contentWindow as unknown as {inFrame?: number} | null)?.inFrame,
	).toBe(undefined);
	await p.dom.dispose();
});

test("a clone keeps whether its script started, so innerHTML's and run scripts never run again", async () => {
	const p = page(
		`<div id="holder"></div>
		<script id="ran">log.push("ran once");</script>
		<script>
			const holder = document.getElementById("holder");
			holder.innerHTML = "<script>log.push('innerHTML clone')<\\/script>";
			document.body.append(holder.cloneNode(true));
			document.body.append(document.getElementById("ran").cloneNode(true));
			const made = document.createElement("script");
			made.textContent = "log.push('made clone')";
			document.body.append(made.cloneNode(true));
		</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual(["ran once", "made clone"]);
	await p.dom.dispose();
});

test("scripts innerHTML puts in a template or a shadow root never run", async () => {
	const p = page(
		`<div id="host"></div>
		<script>
			const holder = document.createElement("div");
			holder.innerHTML = "<template><script>log.push('template')<\\/script></template>";
			document.body.append(document.importNode(holder.querySelector("template").content, true));
			document.getElementById("host").setHTMLUnsafe(
				"<div><template shadowrootmode='open'><script>log.push('shadow')<\\/script></template></div>",
			);
			log.push("done");
		</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual(["done"]);
	await p.dom.dispose();
});

test("a parsed script is not async unless it says so; a made one is until set", async () => {
	const p = page(
		`<script id="plain">log.push(document.getElementById("plain").async, document.createElement("script").async)</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual([false, true]);
	await p.dom.dispose();
});

test("a script prepares in its turn: an earlier one can remove it", async () => {
	const p = page(`<script>document.getElementById("later").remove();</script>
		<script id="later" src="later.js"></script>
		<script>log.push("after");</script>`, {
		files: {"app/later.js": `log.push("later ran")`},
	});
	await loaded(p);
	expect(p.log()).toEqual(["after"]);
	await p.dom.dispose();
});

withRealms(
	"a sandboxed frame runs scripts only with allow-scripts",
	async () => {
		const p = page(
			`<iframe sandbox srcdoc="<script>parent.log.push('sandboxed')</script>"></iframe>
		<iframe sandbox="allow-scripts" srcdoc="<script>parent.log.push('allowed')</script>"></iframe>`,
		);
		await until(() => p.log().length > 0);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(p.log()).toEqual(["allowed"]);
		await p.dom.dispose();
	},
);

withRealms("a srcdoc frame is held to its page's meta policy", async () => {
	const p = page(
		`<iframe srcdoc="<script>parent.log.push('frame inline')</script><script nonce='abc'>parent.log.push('frame nonce')</script>"></iframe>`,
		{
			head: `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-abc'">`,
		},
	);
	await until(() => p.log().length > 0);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(p.log()).toEqual(["frame nonce"]);
	await p.dom.dispose();
});

withRealms(
	"a frame's scripts run without a read, and the iframe loads after the frame does",
	async () => {
		const p = page(`<iframe onload="log.push('iframe load')" srcdoc="
				<script>addEventListener('load', () => parent.log.push('frame load'))</script>
				<script src='slow.js'></script>
			"></iframe>`, {
			files: {"app/slow.js": "parent.log.push('frame script')"},
		});
		await until(() => p.log().includes("iframe load"));
		expect(p.log()).toEqual(["frame script", "frame load", "iframe load"]);
		await p.dom.dispose();
	},
);

withModules(
	"an import map a classic script adds counts; one after an inline module does not",
	async () => {
		const p = page(
			`<script>
			const map = document.createElement("script");
			map.type = "importmap";
			map.textContent = '{"imports": {"one": "./one.js"}}';
			document.head.append(map);
		</script>
		<script type="module">import {name} from "one"; log.push(name);</script>
		<script type="importmap">{"imports": {"two": "./two.js"}}</script>
		<script type="module" onerror="log.push('two unmapped')">import "two";</script>`,
			{
				files: {
					"app/one.js": `export const name = "one";`,
					"app/two.js": `log.push("two");`,
				},
			},
		);
		await loaded(p);
		expect(p.log()).toEqual(["one", "two unmapped"]);
		await p.dom.dispose();
	},
);

withModules(
	"an inline classic script's import() resolves against the base URL",
	async () => {
		const p = page(`<base href="https://example.com/lib/">
		<script>import("./mod.js").then((m) => log.push(m.where));</script>`, {
			files: {"lib/mod.js": `export const where = "lib";`},
		});
		await until(() => p.log().length > 0);
		expect(p.log()).toEqual(["lib"]);
		await p.dom.dispose();
	},
);

test("a script parsed with scripting off never runs, even adopted into a page whose scripts run", async () => {
	const p = page(
		`<script>
			const parsed = new DOMParser().parseFromString("<script>log.push('parsed')<\\/script>", "text/html");
			document.body.append(document.adoptNode(parsed.querySelector("script")));
			log.push("done");
		</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual(["done"]);
	await p.dom.dispose();
});

test("a policy an earlier script adds blocks a later file, though it was fetched ahead", async () => {
	const p = page(`<script>
			const meta = document.createElement("meta");
			meta.httpEquiv = "Content-Security-Policy";
			meta.content = "script-src 'nonce-abc'";
			document.head.append(meta);
		</script>
		<script src="later.js"></script>
		<script nonce="abc">log.push("after");</script>`, {
		files: {"app/later.js": `log.push("later ran")`},
	});
	await loaded(p);
	expect(p.log()).toEqual(["after"]);
	await p.dom.dispose();
});

test("an inserted script a listener runs holds DOMContentLoaded, and sees itself as currentScript in dispatch", async () => {
	let finish = () => {};
	const seen: string[] = [];
	const p = page(`<script>
			document.addEventListener("DOMContentLoaded", () => log.push("DOMContentLoaded"));
			const inner = document.createElement("script");
			inner.id = "inner";
			inner.textContent = "inner";
			document.body.append(inner);
		</script>`, {
		listen: (dom) => {
			dom.addEventListener("script", (event) => {
				if (event.source === "inner") {
					seen.push(event.document.currentScript?.id ?? "none");
					event.respondWith(
						new Promise<void>((resolve) => {
								finish = resolve;
						}),
					);
				}
			});
		},
	});
	await until(() => seen.length > 0);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(p.log()).toEqual([]);
	finish();
	await loaded(p);
	expect(seen).toEqual(["inner"]);
	expect(p.log()).toEqual(["DOMContentLoaded"]);
	await p.dom.dispose();
});

test("scripts in a declarative shadow root in the markup run; createContextualFragment's template scripts can", async () => {
	const p = page(
		`<div><template shadowrootmode="open"><script>log.push("shadow")</script></template></div>
		<script>
			const range = document.createRange();
			range.selectNodeContents(document.body);
			const template = range.createContextualFragment("<template><script>log.push('template')<\\/script></template>").firstChild;
			document.body.append(document.importNode(template.content, true));
		</script>`,
	);
	await loaded(p);
	expect(p.log()).toEqual(["shadow", "template"]);
	await p.dom.dispose();
});

withRealms(
	"a script moved into another document before its turn does not run",
	async () => {
		const p = page(`<iframe sandbox></iframe>
		<script>
			const frame = document.querySelector("iframe").contentDocument;
			frame.body.append(document.getElementById("later"));
		</script>
		<script id="later" src="later.js"></script>
		<script>log.push("after");</script>`, {
			files: {"app/later.js": `log.push("later ran")`},
		});
		await loaded(p);
		expect(p.log()).toEqual(["after"]);
		await p.dom.dispose();
	},
);

withRealms(
	"a srcdoc frame's files load under 'self', and resolve against its page's base URL",
	async () => {
		const p = page(
			`<iframe srcdoc="<script nonce='abc' src='frame.js'></script>"></iframe>`,
			{
				csp: "script-src 'self' 'nonce-abc'",
				files: {"app/frame.js": "parent.log.push('frame file')"},
			},
		);
		await until(() => p.log().length > 0);
		expect(p.log()).toEqual(["frame file"]);
		await p.dom.dispose();
	},
);

withModules("an import() ends the time for import maps", async () => {
	const p =
		page(
			`<script>import("./mod.js").then(() => log.push("imported"));</script>
		<script type="importmap" onerror="log.push('map refused')">{"imports": {}}</script>`,
			{files: {"app/mod.js": "export {};"}},
		);
	await until(() => p.log().length === 2);
	expect(p.log().sort()).toEqual(["imported", "map refused"]);
	await p.dom.dispose();
});

test("a second policy an earlier script adds blocks a later file too", async () => {
	const p = page(`<script nonce="abc">
			const meta = document.createElement("meta");
			meta.httpEquiv = "Content-Security-Policy";
			meta.content = "script-src 'nonce-abc'";
			document.head.append(meta);
		</script>
		<script src="later.js"></script>
		<script nonce="abc">log.push("after");</script>`, {
		files: {"app/later.js": `log.push("later ran")`},
		head: `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'nonce-abc'">`,
	});
	await loaded(p);
	expect(p.log()).toEqual(["after"]);
	await p.dom.dispose();
});
