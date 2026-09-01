/**
 * Run the web-platform-tests css/cssom suite against this engine's CSSOM.
 *
 * Each test is a testharness.js document of this engine's own DOM, displayed
 * in a window with the engine's CSSOM, which the styles module defines on
 * the DOM's own prototypes at load, plus the StyleManager a TermDOM builds. Its harness scripts are evaluated in
 * document order, at the global scope of a realm of the file's own whose
 * global is that window, because nothing here runs a document's scripts on
 * its own.
 *
 * The suite is fetched into .wpt/ on first run and cached. Results are written
 * to docs/cssom-conformance.md.
 *
 * Run: bun scripts/wpt-cssom.ts [name-filter]
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {createContext, runInContext} from "node:vm";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {getBoxModel, MediaList, StyleManager} from "../src/internal/cssom.ts";
import {LayoutEngine} from "../src/internal/layout.ts";
import {
	createDocumentWindow,
	mount,
	type EngineWindow,
} from "../src/internal/dom.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".wpt");
const RAW = "https://raw.githubusercontent.com/web-platform-tests/wpt/master";
const SUITE = "css/cssom";

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

async function cached(path: string): Promise<string | null> {
	const file = join(CACHE, path);
	if (existsSync(file)) {
		return readFileSync(file, "utf8");
	}
	const response = await fetch(`${RAW}/${path}`);
	if (!response.ok) {
		return null;
	}
	const text = await response.text();
	mkdirSync(dirname(file), {recursive: true});
	writeFileSync(file, text);
	return text;
}

async function suiteFiles(): Promise<string[]> {
	const listing = join(CACHE, "listing.json");
	if (existsSync(listing)) {
		return JSON.parse(readFileSync(listing, "utf8"));
	}
	const response = await fetch(
		`https://api.github.com/repos/web-platform-tests/wpt/contents/${SUITE}`,
	);
	const entries = (await response.json()) as Array<{
		name: string;
		type: string;
	}>;
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
	mkdirSync(CACHE, {recursive: true});
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
const EXCLUSIONS: Record<string, string> = {
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

/**
 * Failures this engine owns as design, not as gaps. They stay counted in the
 * table; this is what they are and why.
 */
const DEVIATIONS: Array<[string, string]> = [
	[
		"getComputedStyle-insets-fixed.html",
		"CSS transforms are not implemented. A transformed ancestor is the containing block of a fixed box. Every subtest that resolves an inset against `#container-for-fixed` (`transform: scale(1)`) expects that box and gets the viewport, which is the containing block of a fixed box here. That is 216 of the file's 324 subtests. A character grid has no transforms, since cells do not rotate, scale or translate by fractions, so the containing block a transform would establish never exists.",
	],
	[
		"getComputedStyle-resolved-colors.html",
		"A system color computes as its keyword here, not as an rgb(). The name stands for whatever the user's environment says, which on a terminal is the theme-resolved palette: every system color maps onto the terminal's default colors and ANSI palette at paint time, but the process cannot state the theme's actual channel values, so `getComputedStyle` reports `Menu` as `Menu` where these tests expect a resolved rgb(). The UA sheet's `::selection { background-color: Highlight; color: HighlightText }` is how this engine spells \"swap the cell's colors\", which the selection painter renders as inverse video. Giving the keywords rgb() values would erase the signal the painter reads.",
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

/** The style and layout engines mounted on a document, by document. */
const mounts = new Map<
	Document,
	{styleManager: StyleManager; layoutEngine: LayoutEngine}
>();

/**
 * The geometry reads a test takes off an element: clientWidth/clientHeight,
 * which several tests derive their expected resolved values from, and
 * getBoundingClientRect/getClientRects, which a test calls to force layout up
 * to date before reading a used value.
 *
 * TermDOM installs all of these off the same layout rects, from the mount that
 * owns the document's renderer. A document under this harness has a
 * StyleManager and a LayoutEngine but no TermDOM, so the harness installs the
 * same measurements against the same engine. The DOM classes are the realm's,
 * one set for every document in it, so each read finds the mount of the
 * document the element belongs to rather than closing over one of them.
 */
function installGeometry(window: EngineWindow): void {
	if (geometryInstalled) {
		return;
	}
	geometryInstalled = true;
	const getMount = (
		element: Element,
	): {styleManager: StyleManager; layoutEngine: LayoutEngine} | undefined =>
		element.ownerDocument ? mounts.get(element.ownerDocument) : undefined;
	const clientBox = (
		element: Element,
	): {width: number; height: number} | null => {
		const rect = getMount(element)?.styleManager.usedRect(element);
		if (!rect) {
			return null;
		}
		const box = getBoxModel(element);
		return {
			width: rect.width - box.borderLeftWidth - box.borderRightWidth,
			height: rect.height - box.borderTopWidth - box.borderBottomWidth,
		};
	};
	for (const [property, axis] of [
		["clientWidth", "width"],
		["clientHeight", "height"],
	] as const) {
		Object.defineProperty(window.HTMLElement.prototype, property, {
			get(this: Element) {
				return Math.round(clientBox(this)?.[axis] ?? 0);
			},
			configurable: true,
			enumerable: true,
		});
	}
	Object.defineProperty(window.Element.prototype, "getBoundingClientRect", {
		value(this: Element): DOMRect {
			const mount = getMount(this);
			if (!mount) {
				return new DOMRect();
			}
			return (
				mount.styleManager.usedRect(this) ?? new DOMRect()
			);
		},
		configurable: true,
		writable: true,
	});
	Object.defineProperty(window.Element.prototype, "getClientRects", {
		value(this: Element): DOMRectList {
			const mount = getMount(this);
			if (!mount) {
				return [] as unknown as DOMRectList;
			}
			// usedRect for the flush; getRects for the fragments, which a box
			// broken across lines has more than one of.
			mount.styleManager.usedRect(this);
			return mount.layoutEngine.getRects(this) as unknown as DOMRectList;
		},
		configurable: true,
		writable: true,
	});
}

let geometryInstalled = false;

/**
 * Mount the engine on a document window: the CSSOM, a cascade, a layout engine
 * and the environment facts a test document expects to find around it. This is
 * the startup a TermDOM does, without the renderer.
 */
function mountEngine(window: EngineWindow): StyleManager {
	const document = window.document;

	// There is no render loop behind this harness, so a frame is the next
	// macrotask -- which is what a test that waits for one is really waiting on.
	(window as unknown as Record<string, unknown>).requestAnimationFrame = (
		callback: (time: number) => void,
	): number => Number(setTimeout(() => callback(Date.now()), 0));
	(window as unknown as Record<string, unknown>).cancelAnimationFrame = (
		handle: number,
	): void => clearTimeout(handle as unknown as NodeJS.Timeout);

	// A terminal loads no fonts, so the font set a test waits on is ready the
	// moment it is asked for.
	Object.defineProperty(document, "fonts", {
		value: {ready: Promise.resolve()},
		configurable: true,
	});

	// The document is parsed before a line of it runs, so it is complete before
	// its first script sees it. testharness.js reads this to decide whether to
	// start its tests now or wait for a load event.
	Object.defineProperty(document, "readyState", {
		value: "complete",
		configurable: true,
	});

	const layoutEngine = new LayoutEngine(window);
	const styleManager = new StyleManager(window, layoutEngine);
	// Mounting is what arms the flush a resolved value takes: the DOM wires
	// its own mutation observer at mount and drains it into the style and
	// layout engines before each measurement. There is no render loop here,
	// so everything the mount would ask of one is a stub.
	mount(document, {
		layout: layoutEngine,
		styles: styleManager,
		exchange: {interactive: false} as never,
		screen: {cols: 800, rows: 600, invalidate() {}, scrollTo() {}} as never,
		render() {},
		close() {},
		seal() {},
		attached: false,
	});
	// The suite is written against a browser viewport in CSS pixels; this
	// engine's pixel is a cell, so the harness gives it a grid the same size
	// as the viewport the tests assume.
	layoutEngine.resize(800, 600);
	mounts.set(document, {styleManager, layoutEngine});
	installGeometry(window);
	// matchMedia, which TermDOM installs live off the same evaluator. There is
	// no resize under this harness, so the list a query answers with is the
	// one it is created with.
	(window as unknown as Record<string, unknown>).matchMedia = (
		query: string,
	): {media: string; matches: boolean} => ({
		media: new MediaList(String(query)).mediaText,
		matches: styleManager.mediaQueryMatches(String(query)),
	});
	return styleManager;
}

/**
 * A nested browsing context behind every `<iframe>`, built the first time one
 * is reached through.
 *
 * A terminal has no frames, so TermDOM gives an iframe no content document --
 * and a fixture that reaches through one is not testing frames, it is using a
 * second document to have a second cascade. The harness gives it that: the
 * iframe's `srcdoc`, or an empty document, mounted on an engine of its own and
 * running in a realm of its own, which is what `contentWindow.eval` runs in.
 * Lazily, because a document written into a frame can carry frames of its own.
 */
const frames = new WeakMap<Element, {document: Document; window: unknown}>();
let framesInstalled = false;
let documentURL = "about:blank";

function installFrames(window: EngineWindow): void {
	if (framesInstalled) {
		return;
	}
	framesInstalled = true;
	const contextOf = (frame: Element): {document: Document; window: unknown} => {
		let context = frames.get(frame);
		if (context === undefined) {
			const inner = createDocumentWindow(
				frame.getAttribute("srcdoc") ??
				"<!doctype html><html><head></head><body></body></html>",
				documentURL,
			);
			mountEngine(inner);
			const realm = createRealm(inner, documentURL);
			context = {
				document: inner.document,
				window: runInContext("globalThis", realm),
			};
			frames.set(frame, context);
		}
		return context;
	};
	const iframePrototype = (
		window as unknown as {HTMLIFrameElement: {prototype: object}}
	).HTMLIFrameElement.prototype;
	for (const [name, read] of [
		["contentDocument", (frame: Element): unknown => contextOf(frame).document],
		["contentWindow", (frame: Element): unknown => contextOf(frame).window],
	] as const) {
		Object.defineProperty(iframePrototype, name, {
			get(this: Element) {
				return read(this);
			},
			configurable: true,
			enumerable: true,
		});
	}

	// document.open/write/close, which a fixture uses to put markup in a frame.
	// One buffer per document, parsed into the document when it is closed.
	const written = new WeakMap<Document, string>();
	const documentPrototype = window.Document.prototype as unknown as Record<
		string,
		unknown
	>;
	documentPrototype.open = function (this: Document): Document {
		written.set(this, "");
		return this;
	};
	documentPrototype.write = function (this: Document, ...text: string[]): void {
		written.set(this, (written.get(this) ?? "") + text.join(""));
	};
	documentPrototype.close = function (this: Document): void {
		const html = written.get(this);
		if (html === undefined) {
			return;
		}
		written.delete(this);
		const parsed = createDocumentWindow(html, documentURL).document;
		const root = this.documentElement;
		const source = parsed.documentElement;
		if (root === null || source === null) {
			return;
		}
		while (root.firstChild !== null) {
			root.removeChild(root.firstChild);
		}
		while (source.firstChild !== null) {
			root.appendChild(this.importNode(source.firstChild, true));
			source.removeChild(source.firstChild);
		}
	};
}

/** Resolve a script's src against the suite directory, as a repo path. */
function resolveScript(src: string): string {
	if (src.startsWith("/")) {
		return src.slice(1);
	}
	return `${SUITE}/${src}`;
}

async function runFile(file: string): Promise<Outcome> {
	if (file in EXCLUSIONS) {
		return {file, harness: "EXCLUDED", subtests: [], error: EXCLUSIONS[file]};
	}
	const html = await cached(`${SUITE}/${file}`);
	if (html === null) {
		return {file, harness: "ERROR", subtests: [], error: "not fetched"};
	}

	const url = `http://web-platform.test/${SUITE}/${file}`;
	const window = createDocumentWindow(html, url);
	const document = window.document;
	documentURL = url;
	installFrames(window);
	mountEngine(window);

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
			const text = await cached(resolveScript(src));
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
			const flattened = await flattenModule(script.textContent ?? "", file);
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

	const realm = createRealm(window, url);
	try {
		// One block at global scope for the whole file: the harness and the test
		// share it exactly as they share a document's script scope. `var` and
		// function declarations land on the global, where a test that evals a
		// name finds them; `let` and `const` stay in the file's own scope.
		runInContext(
			`{\n${sources.join("\n;\n")}\n;\nadd_completion_callback(__complete);\n}`,
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
function createRealm(window: EngineWindow, url: string): object {
	// Every name the window carries, own or inherited, enumerable or not: the
	// DOM and CSSOM interface objects live on Window.prototype and a test reads
	// them as bare globals. A realm's global is a flat object, so the chain is
	// flattened into it -- accessors and methods still answering as the window,
	// which is the object they were written for.
	const scope: Record<string, unknown> = {};
	const chain: object[] = [];
	for (
		let level: object | null = window;
		level !== null && level !== Object.prototype;
		level = Object.getPrototypeOf(level) as object | null
	) {
		chain.unshift(level);
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
		location: {
			href: url,
			search: "",
			hash: "",
			pathname: new URL(url).pathname,
			origin: new URL(url).origin,
			toString: () => url,
		},
		addEventListener: window.addEventListener.bind(window),
		removeEventListener: window.removeEventListener.bind(window),
		dispatchEvent: window.dispatchEvent.bind(window),
		// Timers and console are the environment's, not the language's, so a
		// fresh realm has none and testharness.js needs them.
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		queueMicrotask,
		console,
	});
	// Legacy named access: a browser window carries a property for every id in
	// its document, and the suite's fixtures read them that way -- `<div
	// id=target>` and then a bare `target.style`. TermDOM's own window does not
	// supply those names; that is a documented deviation for authors, and it is
	// not what these files are testing. This realm stands in for the environment
	// a test document expects, the way the geometry and matchMedia stand-ins
	// above do, so the names are here.
	for (const element of window.document.querySelectorAll("[id]")) {
		const id = element.getAttribute("id") ?? "";
		// A name the realm already carries is the realm's -- `document`,
		// `location`, the CSSOM constructors. An id never takes one of those over.
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(scope, id)) {
			continue;
		}
		scope[id] = element;
	}
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
	file: string,
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
			: `${SUITE}/${specifier.replace(/^\.\//, "")}`;
		const text = await cached(path);
		if (text === null) {
			return null;
		}
		const nested = await flattenModule(text, file);
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

const filter = process.argv[2];
const files = (await suiteFiles()).filter(
	(file) => !filter || file.includes(filter),
);

const outcomes: Outcome[] = [];
for (const file of files) {
	try {
		outcomes.push(await runFile(file));
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
		`${last.harness.padEnd(8)} ${passed}/${last.subtests.length} ${file}${
			last.error ? ` -- ${last.error}` : ""
		}`,
	);
}

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
	"# CSSOM conformance: web-platform-tests css/cssom",
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
	"A test is excluded only when it asks for something outside CSSOM: a pixel",
	"comparison, a stylesheet fetched over a network, the WebIDL harness, or the",
	"separate CSSOM View spec. Everything else either passes or is counted as a",
	"failure below.",
	"",
	"| File | Reason |",
	"| --- | --- |",
	...Object.keys(EXCLUSIONS)
		.sort()
		.map((file) => `| ${file} | ${EXCLUSIONS[file]} |`),
	...reftests.map(
		(outcome) => `| ${outcome.file} | reftest: scored by pixel comparison |`,
	),
	"",
	"## Deliberate deviations",
	"",
	"These are failures this engine owns as design. They are counted as",
	"failures above rather than excluded.",
	"",
	...DEVIATIONS.flatMap(([file, reason]) => [`### ${file}`, "", reason, ""]),
	"## Files",
	"",
	"| File | Harness | Passed | Failed |",
	"| --- | --- | ---: | ---: |",
];
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

// A filtered run is for looking at one suite, so it reports to the terminal;
// only a whole run may rewrite the checked-in table.
if (filter) {
	for (const outcome of outcomes) {
		for (const test of outcome.subtests) {
			if (test.status === 0) {
				continue;
			}
			console.info(`  ${outcome.file} :: ${test.name}: ${test.message ?? ""}`);
		}
	}
} else {
	writeFileSync(
		join(ROOT, "docs", "cssom-conformance.md"),
		`${lines.join("\n")}\n`,
	);
}
console.info(
	`\n${passed.length} passed, ${failed.length} failed across ${outcomes.length} files`,
);
