/**
 * Run src/internal/bidi.ts over Unicode's full bidi conformance files,
 * BidiCharacterTest.txt and BidiTest.txt, print the pass counts, and
 * regenerate the subset tests/bidi-conformance.test.ts runs:
 * tests/fixtures/bidi-character-test.txt and tests/fixtures/bidi-test.txt.
 * The full files are about 15 MB together, too large to check in.
 *
 * The subset keeps BidiCharacterTest's hand-written sections whole (the
 * lines before its generated permutations), one generated line in
 * CHARACTER_STRIDE, BidiTest's @Levels and @Reorder lines, and one data
 * line in CLASS_STRIDE.
 *
 * Run: node --experimental-strip-types scripts/generate-bidi-conformance.ts
 */

import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import * as Bidi from "../src/internal/bidi.ts";
import {runCharacterTest, runClassTest} from "../tests/bidi-conformance.ts";

const UNICODE_VERSION = "17.0.0";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;
const CHARACTER_STRIDE = 40;
const CLASS_STRIDE = 100;

async function fetchUCD(path: string): Promise<string> {
	const response = await fetch(`${BASE}/${path}`);
	if (!response.ok) {
		throw new Error(`${BASE}/${path}: ${response.status}`);
	}
	return response.text();
}

const characterTest = await fetchUCD("BidiCharacterTest.txt");
const classTest = await fetchUCD("BidiTest.txt");

const characters = runCharacterTest(Bidi, characterTest);
const classes = runClassTest(Bidi, classTest);
const total = (result: typeof characters) =>
	result.passed + result.failed.length;
console.log(
	`BidiCharacterTest ${characters.passed}/${total(characters)}, BidiTest ${classes.passed}/${total(classes)} (Unicode ${UNICODE_VERSION})`,
);
for (const line of [...characters.failed, ...classes.failed].slice(0, 20)) {
	console.log(`FAIL ${line}`);
}

const header = (name: string) =>
	`# Subset of ${name} ${UNICODE_VERSION}, from scripts/generate-bidi-conformance.ts.\n`;

const characterLines: string[] = [];
let generated = false;
let seen = 0;
for (const line of characterTest.split("\n")) {
	if (line.startsWith("# Permutations of sequences")) {
		generated = true;
	}
	if (line === "" || line.startsWith("#")) {
		continue;
	}
	if (!generated || seen++ % CHARACTER_STRIDE === 0) {
		characterLines.push(line);
	}
}

const classLines: string[] = [];
seen = 0;
for (const line of classTest.split("\n")) {
	if (line === "" || line.startsWith("#")) {
		continue;
	}
	if (line.startsWith("@") || seen++ % CLASS_STRIDE === 0) {
		classLines.push(line);
	}
}

writeFileSync(
	join(ROOT, "tests/fixtures/bidi-character-test.txt"),
	header("BidiCharacterTest.txt") + characterLines.join("\n") + "\n",
);
writeFileSync(
	join(ROOT, "tests/fixtures/bidi-test.txt"),
	header("BidiTest.txt") + classLines.join("\n") + "\n",
);
if (characters.failed.length || classes.failed.length) {
	process.exitCode = 1;
}
