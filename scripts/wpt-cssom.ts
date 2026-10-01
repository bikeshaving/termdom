/**
 * Run the web-platform-tests css/cssom, css/selectors/invalidation and
 * css/mediaqueries suites against this engine's CSSOM.
 *
 * Each test is a testharness.js document of this engine's own DOM, attached
 * in a window with the engine's CSSOM, which the styles module defines on
 * the DOM's own prototypes at load, plus the Cascade a TermDOM builds. Its harness scripts are evaluated in
 * document order, at the global scope of a realm of the file's own whose
 * global is that window, because nothing here runs a document's scripts on
 * its own.
 *
 * The suites are fetched into .wpt/ on first run and cached. Results are
 * written to docs/cssom-conformance.md and
 * docs/selector-invalidation-conformance.md.
 *
 * Run: bun scripts/wpt-cssom.ts [name-filter]
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {createContext, runInContext} from "node:vm";

import {TermDOM} from "../src/index.ts";
import type {Window} from "../src/internal/dom.ts";
import type {
	TerminalCloseInfo,
	TerminalSize,
} from "../src/internal/exchange.ts";
import {WPT_COMMIT, WPT_RAW} from "./wpt-ref.ts";
import {TESTDRIVER_VENDOR} from "./wpt-testdriver.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".wpt");

/**
 * A test that has not finished in this long is recorded as a timeout.
 *
 * testharness.js runs a watchdog of its own -- ten seconds, after which it
 * ends every unfinished subtest and reports the file. A subtest waiting on an
 * event this environment never fires (a <link> load, say) is ended by that
 * watchdog and its file still scores, so this outlasts it: a file recorded as
 * a timeout here is one that never reached even testharness's own limit.
 */
const TIMEOUT_MS = 15000;

// Everything a file leaves behind: its engines, the frames' engines among
// them, and the timers its realm set. Each file's are released when it is
// done. Kept, five hundred documents' worth held gigabytes.
const fileEngines: TermDOM[] = [];

// An error no script caught goes where a browser sends it: an error or
// unhandledrejection event at the running file's window, which testharness
// listens for. One from a file already scored, a testdriver action still
// pending when its harness finished, is logged and does not stop the run.
let reportUncaught:
	((type: "error" | "unhandledrejection", reason: unknown) => void) | null =
		null;

function onUncaught(
	type: "error" | "unhandledrejection",
	reason: unknown,
): void {
	if (reportUncaught !== null) {
		reportUncaught(type, reason);
	} else {
		console.error(`uncaught after its file finished (${type}):`, reason);
	}
}

const fileTimers = new Set<ReturnType<typeof setTimeout>>();

async function cached(path: string): Promise<string | null> {
	const file = join(CACHE, path);
	if (existsSync(file)) {
		return readFileSync(file, "utf8");
	}
	const response = await fetch(`${WPT_RAW}/${path}`);
	if (!response.ok) {
		return null;
	}
	const text = await response.text();
	mkdirSync(dirname(file), {recursive: true});
	writeFileSync(file, text);
	return text;
}

async function suiteFiles(suite: string): Promise<string[]> {
	const listing = join(CACHE, suite, "listing.json");
	if (existsSync(listing)) {
		return JSON.parse(readFileSync(listing, "utf8"));
	}
	const response = await fetch(
		`https://api.github.com/repos/web-platform-tests/wpt/contents/${suite}?ref=${WPT_COMMIT}`,
	);
	const entries =
		(await response.json()) as Array<{name: string; type: string}>;
	const names = entries
		.filter((entry) => entry.type === "file" && entry.name.endsWith(".html"))
		.filter(
			(entry) =>
				!/-ref\.html$|-manual\.html$|-crash\.html$|^reference\//.test(
					entry.name,
				),
		)
		.map((entry) => entry.name)
		.sort();
	mkdirSync(dirname(listing), {recursive: true});
	writeFileSync(listing, JSON.stringify(names, null, "\t"));
	return names;
}

/**
 * The tests this engine does not run, each with the one reason it does not.
 *
 * A test is excludable only when it asks for something outside CSSOM itself:
 * a pixel comparison, a stylesheet fetched over a network, the WebIDL harness,
 * or the separate CSSOM View spec. "Hard" is not a reason -- everything else
 * either passes or is a failure this table does not hide.
 */
const CSSOM_EXCLUSIONS: Record<string, string> = {
	// CSSOM View -- a separate spec, hit-testing a rendered box tree.
	"caretPositionFromPoint-audioVideo.html":
		"cssom-view: caret position over media elements",
	"caretPositionFromPoint-in-flex-container.html":
		"cssom-view: caret position inside a flex container",
	"caretPositionFromPoint-with-transformation.html":
		"cssom-view: caret position under a transform",
	"caretPositionFromPoint.html": "cssom-view: caret position from a point",
	"caretRangeFromPoint-replace-document.tentative.html":
		"cssom-view: caret range across a document replacement",
	"caretRangeFromPoint-textarea-transform.tentative.html":
		"cssom-view: caret range in a transformed textarea",
	"caretRangeFromPoint.tentative.html": "cssom-view: caret range from a point",

	// Stylesheets fetched over a network: a terminal document has none, and a
	// <link> never resolves to a sheet.
	"cssimportrule-parent.html": "network: the sheet an @import fetches",
	"cssimportrule-sheet-identity.html": "network: the sheet an @import fetches",
	"HTMLLinkElement-disabled-001.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-002.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-003.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-004.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-005.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-006.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-007.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-alternate.html":
		"network: alternate <link> sheet disabling",
	"HTMLLinkElement-load-event-002.html": "network: <link> load events",
	"HTMLLinkElement-load-event.html": "network: <link> load events",
	"HTMLStyleElement-load-event.html":
		"network: <style> load events, which fire only for fetched subresources",
	"insertRule-charset-no-index.html":
		"network: the rules are inserted into a <link> sheet",
	"link-element-stylesheet-title.html": "network: <link> sheet titles",
	"preferred-stylesheet-order.html": "network: alternate <link> sheet sets",
	"preferred-stylesheet-reversed-order.html":
		"network: alternate <link> sheet sets",
	"stylesheet-cross-origin-redirect-quirks.sub.html":
		"network: cross-origin sheet redirects",
	"stylesheet-same-origin.sub.html": "network: same-origin sheet loading",
	"stylesheet-title.html": "network: <link> sheet titles",
	"ttwf-cssom-doc-ext-load-count.html": "network: sheet load counting",
	"ttwf-cssom-doc-ext-load-tree-order.html":
		"network: loaded sheets in tree order",

	// The WebIDL harness needs /resources/WebIDLParser.js, which is not part
	// of the suite fetched here.
	"idlharness.html": "idlharness: needs WebIDLParser",

	// Nested browsing contexts: a terminal document has no frames, so there is
	// no second window to carry a CSSOM of its own.
	"cssom-getPropertyValue-common-checks.html":
		"frames: the checks run inside a sub-document",
	"CSSStyleSheet-constructable-baseURL.html":
		"frames: a sheet constructed in an iframe's window",
	"CSSStyleSheet-template-adoption.html":
		"frames: adoption across a template's document",
	"getComputedStyle-dynamic-subdoc.html":
		"frames: media queries inside a sub-document",
	"insertRule-across-context.html":
		"frames: rule constructors from an iframe's window",
	"style-attr-update-across-documents.html":
		"frames: a style attribute moved between documents",
};

/** What css/selectors/invalidation asks for that a terminal cannot give. */
const INVALIDATION_EXCLUSIONS: Record<string, string> = {
	"media-loading-pseudo-classes-in-has.sub.html":
		"media: nothing loads or plays audio or video in a terminal",
	"media-pseudo-classes-in-has.html":
		"media: nothing loads or plays audio or video in a terminal",
};

/**
 * Failures this engine owns as design, not as gaps. They stay counted in the
 * table; this is what they are and why.
 */
const CSSOM_DEVIATIONS: Array<[string, string]> = [
	[
		"getComputedStyle-insets-fixed.html",
		"CSS transforms are not implemented. A transformed ancestor is the containing block of a fixed box. Every subtest that resolves an inset against `#container-for-fixed` (`transform: scale(1)`) expects that box and gets the viewport, which is the containing block of a fixed box here. That is 216 of the file's 324 subtests. A character grid has no transforms, since cells do not rotate, scale or translate by fractions, so the containing block a transform would establish never exists.",
	],
	[
		"getComputedStyle-resolved-colors.html",
		"A system color computes as its keyword and reads back as rgb(): the color it paints, or, for one the terminal fills in from its theme, black or white as the terminal's light or dark scheme puts there. A system color inside a longer value, such as a box-shadow, still reads back as its keyword.",
	],
];

interface Subtest {
	name: string;
	status: number;
	message: string | null;
}

interface Outcome {
	file: string;
	harness: string;
	subtests: Subtest[];
	error?: string;
}

/**
 * A TermDOM for a test document, attached to a terminal whose keyboard and
 * mouse are the testdriver shim. The suite is written against a browser
 * viewport of 800 by 600 CSS pixels; this engine's pixel is a cell, so the
 * terminal behind it is a grid of that size. Its output is discarded.
 */
function mountEngine(
	html: string,
	url: string,
	input: ReadableStream<string>,
): TermDOM {
	const termDOM = new TermDOM({
		html,
		url,
		transport: {
			cols: 800,
			rows: 600,
			readable: input,
			writable: new WritableStream<string>({}),
			resizes: new ReadableStream<TerminalSize>({}, {highWaterMark: 0}),
			closed: new Promise<TerminalCloseInfo>(() => {}),
			ready: Promise.resolve(),
			colorDepth: "rgb",
			interactive: true,
			sharesScreen: false,
			close() {},
		},
	});
	fileEngines.push(termDOM);
	return termDOM;
}

/** Resolve a script's src against the suite directory, as a repo path. */
function resolveScript(src: string, suite: string): string {
	if (src.startsWith("/")) {
		return src.slice(1);
	}
	return `${suite}/${src}`;
}

async function runFile(file: string, suite: Suite): Promise<Outcome> {
	try {
		return await runFileIn(file, suite);
	} finally {
		reportUncaught = null;
		for (const timer of fileTimers) {
			clearTimeout(timer);
			clearInterval(timer);
		}
		fileTimers.clear();
		for (const engine of fileEngines.splice(0)) {
			await engine.dispose();
		}
	}
}

async function runFileIn(file: string, suite: Suite): Promise<Outcome> {
	if (file in suite.exclusions) {
		return {
			file,
			harness: "EXCLUDED",
			subtests: [],
			error: suite.exclusions[file],
		};
	}
	const html = await cached(`${suite.path}/${file}`);
	if (html === null) {
		return {file, harness: "ERROR", subtests: [], error: "not fetched"};
	}

	const url = `http://web-platform.test/${suite.path}/${file}`;
	let push: (text: string) => void = () => {};
	const input = new ReadableStream<string>({
		start(controller) {
			push = (text) => controller.enqueue(text);
		},
	});
	const engine = mountEngine(html, url, input);
	await engine.attach();
	const {window, document} = engine;

	const outcome: Outcome = {file, harness: "TIMEOUT", subtests: []};
	let timer: ReturnType<typeof setTimeout> | null = null;
	const done = new Promise<void>((resolve) => {
		(window as any).__complete = (
			tests: Subtest[],
			status: {status: number; message: string | null},
		) => {
			outcome.harness = ["OK", "ERROR", "TIMEOUT", "PRECONDITION_FAILED"][
				status.status
			];
			outcome.subtests = tests.map((test) => ({
				name: test.name,
				status: test.status,
				message: test.message ?? null,
			}));
			resolve();
		};
		timer = setTimeout(resolve, TIMEOUT_MS);
		timer.unref?.();
	});

	const sources: string[] = [];
	let harnessLoaded = false;
	for (const script of document.querySelectorAll("script")) {
		const src = script.getAttribute("src");
		if (src) {
			if (/testharnessreport\.js$/.test(src)) {
				continue;
			}
			if (/testharness\.js$/.test(src)) {
				harnessLoaded = true;
			}
			if (/testdriver-vendor\.js$/.test(src)) {
				sources.push(TESTDRIVER_VENDOR);
				continue;
			}
			const text = await cached(resolveScript(src, suite.path));
			if (text === null) {
				return {
					file,
					harness: "ERROR",
					subtests: [],
					error: `missing script ${src}`,
				};
			}
			sources.push(text);
		} else if (script.getAttribute("type") === "module") {
			const flattened = await flattenModule(
				script.textContent ?? "",
				suite.path,
			);
			if (flattened === null) {
				return {
					file,
					harness: "ERROR",
					subtests: [],
					error: "unresolved module import",
				};
			}
			sources.push(flattened);
		} else {
			sources.push(script.textContent ?? "");
		}
	}

	// A reftest carries no testharness, so there are no subtests to count: it
	// is scored by pixels a terminal has no way to compare.
	if (!harnessLoaded) {
		return {file, harness: "REFTEST", subtests: []};
	}

	const engineWindow = window as unknown as {
		dispatchEvent(event: object): boolean;
		ErrorEvent: new (type: string, init: object) => object;
		Event: new (type: string) => object;
	};
	reportUncaught = (type, reason) => {
		if (type === "error") {
			engineWindow.dispatchEvent(
				new engineWindow.ErrorEvent("error", {
					error: reason,
					message: (reason as Error)?.message ?? String(reason),
				}),
			);
			return;
		}
		const event = new engineWindow.Event("unhandledrejection");
		Object.defineProperty(event, "reason", {value: reason});
		engineWindow.dispatchEvent(event);
	};
	const realm = createRealm(window);
	(realm as Record<string, unknown>).__termdomDriverInput = (text: string) =>
		push(text);
	try {
		// One block at global scope for the whole file: the harness and the test
		// share it exactly as they share a document's script scope. `var` and
		// function declarations land on the global, where a test that evals a
		// name finds them; `let` and `const` stay in the file's own scope. A
		// browser's global is the window: the realm mirrors the window's
		// members, and a name it does not hold, a named property, resolves
		// through the engine window.
		(realm as Record<string, unknown>).__termdomWindow = windowScope(
			realm,
			window,
		);
		runInContext(
			`with (__termdomWindow) {\n${sources.join("\n;\n")}\n;\nadd_completion_callback(__complete);\n}`,
			realm,
		);
		// The load event is a task of its own, not the tail of the script that
		// built the document. testharness.js starts a promise_test's body on a
		// microtask, and a body whose first act is to wait for load has to get
		// its listener in before the event -- which it cannot if the event is
		// dispatched by the same synchronous run that defined the test.
		setTimeout(() => {
			document.dispatchEvent(new window.Event("DOMContentLoaded"));
			window.dispatchEvent(new window.Event("load"));
		}, 0);
	} catch (error) {
		return {
			file,
			harness: "ERROR",
			subtests: [],
			error: (error as Error).message,
		};
	}

	await done;
	if (timer !== null) {
		clearTimeout(timer);
	}
	// The harness reports its results from a callback of its own after the
	// completion one, so let it run before the file is done with.
	await new Promise((resolve) => setTimeout(resolve, 0));
	return outcome;
}

/**
 * The scope that makes the engine window the realm's global for name
 * lookup. A name the realm owns is the realm's, as it would be the window's
 * own property; any other name the engine window answers is read from and
 * written to the window, so every value is the engine's. A `with` scope
 * must answer `has` for names it cannot list in advance, which only a Proxy
 * can.
 */
function windowScope(realm: object, window: object): object {
	// eslint-disable-next-line no-restricted-globals
	return new Proxy(window, {
		has(target, name): boolean {
			return !Object.prototype.hasOwnProperty.call(realm, name) &&
				name in target;
		},
		get(target, name): unknown {
			return Reflect.get(target, name, target);
		},
		set(target, name, value): boolean {
			return Reflect.set(target, name, value, target);
		},
	});
}

/** Put every name on the realm, over whatever the window already put there. */
function defineAll(
	scope: Record<string, unknown>,
	values: Record<string, unknown>,
): void {
	for (const [name, value] of Object.entries(values)) {
		Object.defineProperty(scope, name, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
}

/**
 * A realm of the file's own, with the file's window as its global.
 *
 * A classic script reads `document`, `window` and the CSSOM interfaces off its
 * global, and a browser gives each document a realm that is thrown away with
 * it. One realm per file is what makes a file's damage the file's: a fixture
 * that installs an accessor on `Array.prototype` -- as
 * adoptedstylesheets-observablearray does, to watch for a backing list -- and
 * does not reach its own cleanup line poisons only its own arrays, not the
 * ones this engine, its parser and the next file are built out of.
 *
 * The realm's intrinsics are its own; the DOM and CSSOM objects in it are this
 * engine's, reached across the boundary exactly as a browser's page script
 * reaches the UA's.
 */
function createRealm(window: Window): object {
	// Every name the window carries, own or inherited, enumerable or not: the
	// DOM and CSSOM interface objects live on Window.prototype and a test reads
	// them as bare globals. A realm's global is a flat object, so the chain is
	// flattened into it -- accessors and methods still answering as the window,
	// which is the object they were written for.
	const scope: Record<string, unknown> = {};
	const chain: object[] = [];
	// The window's named properties object, the one level with no
	// constructor of its own, is left out: its names come and go with the
	// document, so they are read live through the window scope instead.
	for (
		let level: object | null = window;
		level !== null && level !== Object.prototype;
		level = Object.getPrototypeOf(level) as object | null
	) {
		if (
			level === window ||
			Object.prototype.hasOwnProperty.call(level, "constructor")
		) {
			chain.unshift(level);
		}
	}
	for (const level of chain) {
		for (const [name, descriptor] of Object.entries(
			Object.getOwnPropertyDescriptors(level),
		)) {
			if (name === "constructor") {
				continue;
			}
			if (descriptor.get || descriptor.set) {
				const {get, set} = descriptor;
				Object.defineProperty(scope, name, {
					configurable: true,
					enumerable: descriptor.enumerable,
					get: get && ((): unknown => get.call(window)),
					set: set && ((value: unknown): void => set.call(window, value)),
				});
				continue;
			}
			Object.defineProperty(scope, name, {
				...descriptor,
				value:
					typeof descriptor.value === "function" &&
					descriptor.value.prototype === undefined
						? descriptor.value.bind(window)
						: descriptor.value,
				configurable: true,
			});
		}
	}
	// Defined rather than assigned: the loop above copies the window's own
	// accessors onto the realm, and a getter with no setter refuses a write.
	defineAll(scope, {
		document: window.document,
		// The window's own location, on the test's URL. It navigates to a
		// fragment of the document, which is all a test here asks of it.
		location: window.location,
		addEventListener: window.addEventListener.bind(window),
		removeEventListener: window.removeEventListener.bind(window),
		dispatchEvent: window.dispatchEvent.bind(window),
		// Timers and console are the environment's, not the language's, so a
		// fresh realm has none and testharness.js needs them.
		// Recorded, so the file's pending timers go when it does.
		setTimeout: (callback: () => void, delay?: number, ...args: unknown[]) => {
			const timer = setTimeout(() => {
				fileTimers.delete(timer);
				callback(...(args as []));
			}, delay);
			fileTimers.add(timer);
			return timer;
		},
		clearTimeout,
		setInterval: (callback: () => void, delay?: number, ...args: unknown[]) => {
			const timer = setInterval(() => callback(...(args as [])), delay);
			fileTimers.add(timer);
			return timer;
		},
		clearInterval,
		queueMicrotask,
		console,
	});
	const realm = createContext(scope);
	// The realm IS the window: a script that writes `window.foo` and later reads
	// a bare `foo` has to find it.
	runInContext(
		"globalThis.window = globalThis.self = globalThis.parent = globalThis.top = globalThis;",
		realm,
	);
	// A window's error constructors are its realm's. The CSSOM builds what it
	// throws out of `defaultView.TypeError`, and a test compares what it caught
	// against the constructor its own realm names -- the same object, or the
	// exception came from the wrong global.
	(window as unknown as Record<string, unknown>).TypeError = runInContext(
		"TypeError",
		realm,
	);
	return realm;
}

/**
 * A module script as one classic script.
 *
 * There is no module loader behind the evaluation, so each `import` is
 * replaced by
 * the module it names, evaluated ahead of the script that imports it and with
 * its `export` keywords stripped -- which is all these test modules need, since
 * they only ever export functions the test then calls.
 */
async function flattenModule(
	source: string,
	suite: string,
): Promise<string | null> {
	const imports = [
		...source.matchAll(/^\s*import\s+[^;]*?from\s*["']([^"']+)["'];?/gm),
	];
	let out = source.replace(/^\s*import\s+[^;]*?from\s*["'][^"']+["'];?/gm, "");
	const prefix: string[] = [];
	for (const match of imports) {
		const specifier = match[1];
		const path = specifier.startsWith("/")
			? specifier.slice(1)
			: `${suite}/${specifier.replace(/^\.\//, "")}`;
		const text = await cached(path);
		if (text === null) {
			return null;
		}
		const nested = await flattenModule(text, suite);
		if (nested === null) {
			return null;
		}
		prefix.push(nested);
	}
	out = `${prefix.join("\n")}\n${out}`;
	// `export function f()` becomes `function f()`: the names land on the same
	// scope the importing script is evaluated in.
	return out
		.replace(/^\s*export\s+default\s+/gm, "const __default = ")
		.replace(
			/^\s*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm,
			"",
		)
		.replace(/^\s*export\s*\{[^}]*\};?/gm, "");
}

interface Suite {
	path: string;
	title: string;
	report: string;
	exclusions: Record<string, string>;
	deviations: Array<[string, string]>;
	scope: string;
}

const SUITES: Suite[] = [
	{
		path: "css/cssom",
		title: "CSSOM",
		report: "cssom-conformance.md",
		exclusions: CSSOM_EXCLUSIONS,
		deviations: CSSOM_DEVIATIONS,
		scope: "A test is excluded only when it asks for something outside CSSOM: a pixel\ncomparison, a stylesheet fetched over a network, the WebIDL harness, or the\nseparate CSSOM View spec.",
	},
	{
		path: "css/selectors/invalidation",
		title: "Selector invalidation",
		report: "selector-invalidation-conformance.md",
		exclusions: INVALIDATION_EXCLUSIONS,
		deviations: [],
		scope: "Each test changes the document or an element's state after styles were\nfirst computed, and checks that the styles followed. A test is excluded only\nwhen it needs something no terminal document has.",
	},
	{
		path: "css/mediaqueries",
		title: "Media queries",
		report: "mediaqueries-conformance.md",
		exclusions: {},
		deviations: [],
		scope: "Each test parses media queries, evaluates them against the terminal, or\nboth.",
	},
];

process.on("uncaughtException", (error) => onUncaught("error", error));
process.on("unhandledRejection", (reason) =>
	onUncaught("unhandledrejection", reason));

const filter = process.argv[2];
let totalPassed = 0;
let totalFailed = 0;
let totalFiles = 0;
for (const suite of SUITES) {
	const files = (await suiteFiles(suite.path)).filter(
		(file) => !filter || `${suite.path}/${file}`.includes(filter),
	);
	if (files.length === 0) {
		continue;
	}
	const outcomes = await runSuite(suite, files);
	const all = outcomes.flatMap((outcome) => outcome.subtests);
	totalPassed += all.filter((test) => test.status === 0).length;
	totalFailed += all.filter((test) => test.status !== 0).length;
	totalFiles += outcomes.length;
	// A filtered run is for looking at one suite, so it reports to the
	// terminal; only a whole run may rewrite the checked-in table.
	if (filter) {
		for (const outcome of outcomes) {
			for (const test of outcome.subtests) {
				if (test.status === 0) {
					continue;
				}
				console.info(
					`  ${outcome.file} :: ${test.name}: ${test.message ?? ""}`,
				);
			}
		}
	} else {
		writeFileSync(
			join(ROOT, "docs", suite.report),
			`${renderReport(suite, outcomes).join("\n")}\n`,
		);
	}
}
console.info(
	`\n${totalPassed} passed, ${totalFailed} failed across ${totalFiles} files`,
);

async function runSuite(suite: Suite, files: string[]): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	for (const file of files) {
		try {
			outcomes.push(await runFile(file, suite));
		} catch (error) {
			outcomes.push({
				file,
				harness: "ERROR",
				subtests: [],
				error: (error as Error).message,
			});
		}
		const last = outcomes[outcomes.length - 1];
		const passed = last.subtests.filter((test) => test.status === 0).length;
		console.info(
			`${last.harness.padEnd(8)} ${passed}/${last.subtests.length} ${suite.path}/${file}${
				last.error ? ` -- ${last.error}` : ""
			}`,
		);
	}
	return outcomes;
}

function renderReport(suite: Suite, outcomes: Outcome[]): string[] {
	const all = outcomes.flatMap((outcome) => outcome.subtests);
	const passed = all.filter((test) => test.status === 0);
	const failed = all.filter((test) => test.status !== 0);
	const reftests = outcomes.filter((outcome) => outcome.harness === "REFTEST");
	const excluded = outcomes.filter((outcome) => outcome.harness === "EXCLUDED");
	const brokenFiles = outcomes.filter(
		(outcome) =>
			outcome.harness !== "OK" &&
			outcome.harness !== "REFTEST" &&
			outcome.harness !== "EXCLUDED",
	);
	const lines: string[] = [
		`# ${suite.title} conformance: web-platform-tests ${suite.path}`,
		"",
		"Generated by `bun scripts/wpt-cssom.ts`.",
		"",
		`- Test files in the suite: ${outcomes.length}`,
		`- Reference tests (scored by pixels, not runnable here): ${reftests.length}`,
		`- Excluded, each with its reason below: ${excluded.length}`,
		`- Files whose harness completed: ${
			outcomes.length - brokenFiles.length - reftests.length - excluded.length
		}`,
		`- Files whose harness did not complete: ${brokenFiles.length}`,
		`- Subtests passed: ${passed.length}`,
		`- Subtests failed: ${failed.length}`,
		"",
		"## Exclusions",
		"",
		suite.scope,
		"Everything else either passes or is counted as a failure below.",
		"",
		"| File | Reason |",
		"| --- | --- |",
		...Object.keys(suite.exclusions)
			.sort()
			.map((file) => `| ${file} | ${suite.exclusions[file]} |`),
		...reftests.map((outcome) =>
			`| ${outcome.file} | reftest: scored by pixel comparison |`,
		),
		"",
	];
	if (suite.deviations.length > 0) {
		lines.push(
			"## Deliberate deviations",
			"",
			"These are failures this engine owns as design. They are counted as",
			"failures above rather than excluded.",
			"",
			...suite.deviations.flatMap(([file, reason]) => [
				`### ${file}`,
				"",
				reason,
				"",
			]),
		);
	}
	lines.push(
		"## Files",
		"",
		"| File | Harness | Passed | Failed |",
		"| --- | --- | ---: | ---: |",
	);
	for (const outcome of outcomes) {
		const filePassed = outcome.subtests.filter((test) => test.status === 0);
		lines.push(
			`| ${outcome.file} | ${outcome.harness}${
				outcome.error ? ` (${outcome.error})` : ""
			} | ${filePassed.length} | ${outcome.subtests.length - filePassed.length} |`,
		);
	}
	lines.push("", "## Failing subtests", "");
	for (const outcome of outcomes) {
		const fails = outcome.subtests.filter((test) => test.status !== 0);
		if (fails.length === 0) {
			continue;
		}
		lines.push(`### ${outcome.file}`, "");
		for (const test of fails) {
			lines.push(`- ${test.name}: ${(test.message ?? "").split("\n")[0]}`);
		}
		lines.push("");
	}
	return lines;
}
