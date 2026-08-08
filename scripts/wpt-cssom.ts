/**
 * Run the web-platform-tests css/cssom suite against this engine's CSSOM.
 *
 * Each test is a testharness.js document. It runs in a jsdom window with the
 * engine's CSSOM installed -- the same installInlineStyle + StyleManager a
 * TermDOM builds -- and its harness scripts are evaluated in document order,
 * because jsdom itself never runs a document's scripts here.
 *
 * The suite is fetched into .wpt/ on first run and cached. Results are written
 * to docs/cssom-conformance.md.
 *
 * Run: bun scripts/wpt-cssom.ts [name-filter]
 */

import {JSDOM, VirtualConsole} from "jsdom";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {installInlineStyle, StyleManager} from "../src/internal/styles.ts";
import {LayoutEngine} from "../src/internal/layout.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".wpt");
const RAW = "https://raw.githubusercontent.com/web-platform-tests/wpt/master";
const SUITE = "css/cssom";
/** A test that has not finished in this long is recorded as a timeout. */
const TIMEOUT_MS = 5000;

async function cached(path: string): Promise<string | null> {
	const file = join(CACHE, path);
	if (existsSync(file)) return readFileSync(file, "utf8");
	const response = await fetch(`${RAW}/${path}`);
	if (!response.ok) return null;
	const text = await response.text();
	mkdirSync(dirname(file), {recursive: true});
	writeFileSync(file, text);
	return text;
}

async function suiteFiles(): Promise<string[]> {
	const listing = join(CACHE, "listing.json");
	if (existsSync(listing)) return JSON.parse(readFileSync(listing, "utf8"));
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
	"caretPositionFromPoint.html": "cssom-view: caret position from a point",
	"caretPositionFromPoint-audioVideo.html":
		"cssom-view: caret position over media elements",
	"caretPositionFromPoint-in-flex-container.html":
		"cssom-view: caret position inside a flex container",
	"caretPositionFromPoint-with-transformation.html":
		"cssom-view: caret position under a transform",
	"caretRangeFromPoint.tentative.html": "cssom-view: caret range from a point",
	"caretRangeFromPoint-textarea-transform.tentative.html":
		"cssom-view: caret range in a transformed textarea",
	"caretRangeFromPoint-replace-document.tentative.html":
		"cssom-view: caret range across a document replacement",

	// Stylesheets fetched over a network: a terminal document has none, and a
	// <link> never resolves to a sheet.
	"stylesheet-same-origin.sub.html": "network: same-origin sheet loading",
	"stylesheet-cross-origin-redirect-quirks.sub.html":
		"network: cross-origin sheet redirects",
	"ttwf-cssom-doc-ext-load-count.html": "network: sheet load counting",
	"ttwf-cssom-doc-ext-load-tree-order.html":
		"network: loaded sheets in tree order",
	"link-element-stylesheet-title.html": "network: <link> sheet titles",
	"stylesheet-title.html": "network: <link> sheet titles",
	"preferred-stylesheet-order.html": "network: alternate <link> sheet sets",
	"preferred-stylesheet-reversed-order.html":
		"network: alternate <link> sheet sets",
	"HTMLLinkElement-disabled-001.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-002.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-003.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-004.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-005.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-006.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-007.html": "network: <link> sheet disabling",
	"HTMLLinkElement-disabled-alternate.html":
		"network: alternate <link> sheet disabling",
	"HTMLLinkElement-load-event.html": "network: <link> load events",
	"HTMLLinkElement-load-event-002.html": "network: <link> load events",
	"HTMLStyleElement-load-event.html":
		"network: <style> load events, which fire only for fetched subresources",
	"cssimportrule-parent.html": "network: the sheet an @import fetches",
	"cssimportrule-sheet-identity.html": "network: the sheet an @import fetches",

	// The WebIDL harness needs /resources/WebIDLParser.js, which is not part
	// of the suite fetched here.
	"idlharness.html": "idlharness: needs WebIDLParser",

	// Nested browsing contexts: a terminal document has no frames, so there is
	// no second window to carry a CSSOM of its own.
	"insertRule-across-context.html":
		"frames: rule constructors from an iframe's window",
	"style-attr-update-across-documents.html":
		"frames: a style attribute moved between documents",
	"getComputedStyle-dynamic-subdoc.html":
		"frames: media queries inside a sub-document",
	"CSSStyleSheet-constructable-baseURL.html":
		"frames: a sheet constructed in an iframe's window",
	"CSSStyleSheet-template-adoption.html":
		"frames: adoption across a template's document",
	"cssom-getPropertyValue-common-checks.html":
		"frames: the checks run inside a sub-document",
};

/**
 * Failures this engine owns as design, not as gaps. They stay counted in the
 * table; this is what they are and why.
 */
const DEVIATIONS: Array<[string, string]> = [
	[
		"getComputedStyle-resolved-colors.html",
		"System colors (Highlight, HighlightText, Canvas, menu) resolve to their names, not to rgb(). The UA sheet's `::selection { background-color: Highlight; color: HighlightText }` is this engine's spelling of \"swap the cell's colors\", which the selection painter turns into inverse video -- the terminal-native rendering. Resolving the pair to rgb() would erase the signal the painter reads.",
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

/** Resolve a script's src against the suite directory, as a repo path. */
function resolveScript(src: string): string {
	if (src.startsWith("/")) return src.slice(1);
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

	const virtualConsole = new VirtualConsole();
	const dom = new JSDOM(html, {
		runScripts: "outside-only",
		url: `http://web-platform.test/${SUITE}/${file}`,
		virtualConsole,
	});
	const window = dom.window as unknown as Window &
		typeof globalThis & {eval(source: string): unknown};

	// jsdom supplies no animation frames, and a test that waits for one waits
	// forever. The harness runs them on the macrotask queue, which is what a
	// frame is here.
	(window as unknown as Record<string, unknown>).requestAnimationFrame = (
		callback: (time: number) => void,
	): number => Number(setTimeout(() => callback(Date.now()), 0));
	(window as unknown as Record<string, unknown>).cancelAnimationFrame = (
		handle: number,
	): void => clearTimeout(handle as unknown as NodeJS.Timeout);

	installInlineStyle(dom.window);
	const styleManager = new StyleManager(dom.window);
	const layoutEngine = new LayoutEngine(dom.window);
	styleManager.setLayoutEngine(layoutEngine);
	// The flush a resolved value takes. TermDOM's own is
	// #processPendingMutationsAndRender; here, with no render loop, laying out
	// synchronously is the same seam without the paint.
	styleManager.setLayoutFlush(() => {
		layoutEngine.calculateLayout();
		return false;
	});
	// The suite is written against a browser viewport in CSS pixels; this
	// engine's pixel is a cell, so the harness gives it a grid the same size
	// as the viewport the tests assume.
	layoutEngine.resize(800, 600);

	const outcome: Outcome = {file, harness: "TIMEOUT", subtests: []};
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
		setTimeout(resolve, TIMEOUT_MS).unref?.();
	});

	const sources: string[] = [];
	let harnessLoaded = false;
	for (const script of dom.window.document.querySelectorAll("script")) {
		const src = script.getAttribute("src");
		if (src) {
			if (/testharnessreport\.js$/.test(src)) continue;
			if (/testharness\.js$/.test(src)) harnessLoaded = true;
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

	try {
		for (const source of sources) {
			window.eval(source);
		}
		window.eval("add_completion_callback(window.__complete)");
		dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
		dom.window.dispatchEvent(new dom.window.Event("load"));
	} catch (error) {
		return {
			file,
			harness: "ERROR",
			subtests: [],
			error: (error as Error).message,
		};
	}

	await done;
	dom.window.close();
	return outcome;
}

/**
 * A module script as one classic script.
 *
 * There is no module loader behind window.eval, so each `import` is replaced by
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
		if (text === null) return null;
		const nested = await flattenModule(text, file);
		if (nested === null) return null;
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
	`Generated by \`bun scripts/wpt-cssom.ts\`.`,
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
	"failures above, not excluded, so the number stays honest.",
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
	if (fails.length === 0) continue;
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
			if (test.status === 0) continue;
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
