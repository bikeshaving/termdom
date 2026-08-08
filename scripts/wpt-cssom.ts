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

	installInlineStyle(dom.window);
	const styleManager = new StyleManager(dom.window);
	styleManager.setLayoutEngine(new LayoutEngine(dom.window));

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
const brokenFiles = outcomes.filter(
	(outcome) => outcome.harness !== "OK" && outcome.harness !== "REFTEST",
);

const lines: string[] = [
	"# CSSOM conformance: web-platform-tests css/cssom",
	"",
	`Generated by \`bun scripts/wpt-cssom.ts\`.`,
	"",
	`- Test files run: ${outcomes.length}`,
	`- Reference tests (scored by pixels, not runnable here): ${reftests.length}`,
	`- Files whose harness completed: ${
		outcomes.length - brokenFiles.length - reftests.length
	}`,
	`- Files whose harness did not complete: ${brokenFiles.length}`,
	`- Subtests passed: ${passed.length}`,
	`- Subtests failed: ${failed.length}`,
	"",
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

writeFileSync(
	join(ROOT, "docs", "cssom-conformance.md"),
	`${lines.join("\n")}\n`,
);
console.info(
	`\n${passed.length} passed, ${failed.length} failed across ${outcomes.length} files`,
);
