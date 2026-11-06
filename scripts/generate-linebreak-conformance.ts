/**
 * Run src/internal/linebreak.ts over Unicode's full line breaking
 * conformance file, LineBreakTest.txt, print the pass count, and
 * regenerate the subset tests/linebreak-conformance.test.ts runs:
 * tests/fixtures/linebreak-test.txt. The full file is about 3 MB.
 *
 * The subset keeps the file's sample sentences whole (its lines of more
 * than four code points), one line in PAIR_STRIDE of the generated pairs
 * and triples before them, and drops the comments.
 *
 * Run: node --experimental-strip-types scripts/generate-linebreak-conformance.ts
 */

import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import {forEachLineBreak} from "../src/internal/linebreak.ts";
import {runLineBreakTest} from "../tests/linebreak-conformance.ts";

const UNICODE_VERSION = "17.0.0";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;
const PAIR_STRIDE = 8;

const response = await fetch(`${BASE}/auxiliary/LineBreakTest.txt`);
if (!response.ok) {
	throw new Error(`LineBreakTest.txt: ${response.status}`);
}
const file = await response.text();

function breaks(text: string): number[] {
	const out: number[] = [];
	forEachLineBreak(text, (position) => out.push(position));
	return out;
}

const result = runLineBreakTest(breaks, file);
console.log(
	`LineBreakTest ${result.passed}/${result.passed + result.failed.length} (Unicode ${UNICODE_VERSION})`,
);
for (const line of result.failed.slice(0, 20)) {
	console.log(`FAIL ${line}`);
}

const kept: string[] = [];
let seen = 0;
for (const line of file.split("\n")) {
	const body = line.split("#")[0].trim();
	if (!body) {
		continue;
	}
	const codes = body.split(/\s+/).length >> 1;
	if (codes > 4 || seen++ % PAIR_STRIDE === 0) {
		kept.push(body);
	}
}
writeFileSync(
	join(ROOT, "tests/fixtures/linebreak-test.txt"),
	`# Subset of LineBreakTest.txt ${UNICODE_VERSION}, from scripts/generate-linebreak-conformance.ts.\n` +
		kept.join("\n") +
		"\n",
);
if (result.failed.length) {
	process.exitCode = 1;
}
