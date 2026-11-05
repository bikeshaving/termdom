/**
 * Regenerate src/generated/biditables.ts from the Unicode Character
 * Database, the data src/internal/bidi.ts runs UAX #9 over.
 *
 * - BIDI_CLASS_RUNS: extracted/DerivedBidiClass.txt, with the @missing
 *   defaults the file states for unassigned code points.
 * - BIDI_MIRRORS: BidiMirroring.txt.
 * - BIDI_BRACKETS: BidiBrackets.txt, each bracket keyed to the opening
 *   bracket of its pair under canonical equivalence (UnicodeData.txt
 *   singleton decompositions), the identity rule BD16 matches on.
 *
 * Packed as strings and decoded on first use, so importing the table costs
 * a few kilobytes of source. Numbers are base 36.
 *
 * - BIDI_CLASS_RUNS: one run per class change from U+0000 to U+10FFFF,
 *   an uppercase letter naming the class (A is the first of BIDI_CLASSES)
 *   followed by the run's length.
 * - BIDI_MIRRORS: comma-separated `delta:offset`, where delta is the code
 *   point's distance from the previous entry's code point and offset is
 *   the mirrored code point minus the code point.
 * - BIDI_BRACKETS: comma-separated `delta>offset` for an opening bracket
 *   and `delta<offset` for a closing one, where offset is the pair's
 *   canonical opening bracket minus the code point.
 *
 * Run: node --experimental-strip-types scripts/generate-bidi-tables.ts
 */

import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const UNICODE_VERSION = "17.0.0";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;

async function fetchUCD(path: string): Promise<string> {
	const response = await fetch(`${BASE}/${path}`);
	if (!response.ok) {
		throw new Error(`${BASE}/${path}: ${response.status}`);
	}
	return response.text();
}

const CLASSES = [
	"L",
	"R",
	"EN",
	"ES",
	"ET",
	"AN",
	"CS",
	"B",
	"S",
	"WS",
	"ON",
	"BN",
	"NSM",
	"AL",
	"LRO",
	"RLO",
	"LRE",
	"RLE",
	"PDF",
	"LRI",
	"RLI",
	"FSI",
	"PDI",
];

const LONG_NAMES: Record<string, string> = {
	Left_To_Right: "L",
	Right_To_Left: "R",
	Arabic_Letter: "AL",
	European_Terminator: "ET",
	Boundary_Neutral: "BN",
};

function lines(text: string): string[][] {
	const out: string[][] = [];
	for (const line of text.split("\n")) {
		const body = line.split("#")[0].trim();
		if (body) {
			out.push(body.split(";").map((part) => part.trim()));
		}
	}
	return out;
}

function codeRange(codes: string): [number, number] {
	const [start, end] = codes.split("..");
	return [parseInt(start, 16), parseInt(end ?? start, 16)];
}

const derived = await fetchUCD("extracted/DerivedBidiClass.txt");
const mirroring = await fetchUCD("BidiMirroring.txt");
const brackets = await fetchUCD("BidiBrackets.txt");
const unicodeData = await fetchUCD("UnicodeData.txt");

const classes = new Uint8Array(0x110000);
for (const match of derived.matchAll(/^# @missing: ([0-9A-F.]+); (\w+)$/gm)) {
	const name = LONG_NAMES[match[2]];
	if (name === undefined) {
		throw new Error(`unknown default ${match[2]}`);
	}
	const [start, end] = codeRange(match[1]);
	classes.fill(CLASSES.indexOf(name), start, end + 1);
}
for (const [codes, name] of lines(derived)) {
	const index = CLASSES.indexOf(name);
	if (index === -1) {
		throw new Error(`unknown class ${name}`);
	}
	const [start, end] = codeRange(codes);
	classes.fill(index, start, end + 1);
}

const runs: string[] = [];
for (let start = 0; start < classes.length;) {
	let end = start;
	while (end + 1 < classes.length && classes[end + 1] === classes[start]) {
		end++;
	}
	runs.push(
		String.fromCharCode(65 + classes[start]) + (end - start + 1).toString(36),
	);
	start = end + 1;
}

const mirrors: string[] = [];
let previous = 0;
for (const [code, mirror] of lines(mirroring)) {
	const from = parseInt(code, 16);
	const to = parseInt(mirror, 16);
	mirrors.push(`${(from - previous).toString(36)}:${(to - from).toString(36)}`);
	previous = from;
}

const decomposition = new Map<number, number>();
for (const fields of lines(unicodeData)) {
	if (/^[0-9A-F]+$/.test(fields[5])) {
		decomposition.set(parseInt(fields[0], 16), parseInt(fields[5], 16));
	}
}
const canonical = (code: number) => decomposition.get(code) ?? code;

const bracketRows = lines(brackets).map(([code, pair, type]) => ({
	code: parseInt(code, 16),
	pair: parseInt(pair, 16),
	open: type === "o",
}));
const bracketEntries: string[] = [];
previous = 0;
for (const {code, pair, open} of bracketRows) {
	const id = canonical(open ? code : pair);
	bracketEntries.push(
		`${(code - previous).toString(36)}${open ? ">" : "<"}${(id - code).toString(36)}`,
	);
	previous = code;
}

function chunk(text: string, width = 72): string {
	const parts: string[] = [];
	for (let i = 0; i < text.length; i += width) {
		parts.push(JSON.stringify(text.slice(i, i + width)));
	}
	return parts.join(" +\n\t");
}

const target = join(ROOT, "src/generated/biditables.ts");
const output = `/**
 * Bidirectional class, mirroring and paired-bracket tables, generated from
 * the Unicode Character Database at ${UNICODE_VERSION}. Do not edit; run
 * \`node --experimental-strip-types scripts/generate-bidi-tables.ts\`
 * to regenerate. The script describes the packing.
 */

/** Bidi_Class values in the order BIDI_CLASS_RUNS letters them. */
export const BIDI_CLASSES = ${JSON.stringify(CLASSES.join(" "))};

/** Bidi_Class of U+0000 through U+10FFFF, as runs. */
export const BIDI_CLASS_RUNS =
	${chunk(runs.join(""))};

/** Bidi_Mirroring_Glyph. */
export const BIDI_MIRRORS =
	${chunk(mirrors.join(","))};

/** Bidi_Paired_Bracket and Bidi_Paired_Bracket_Type. */
export const BIDI_BRACKETS =
	${chunk(bracketEntries.join(","))};
`;
writeFileSync(target, output);
execFileSync("npx", ["eslint", "--fix", target], {stdio: "inherit"});
console.log(
	`${runs.length} class runs, ${mirrors.length} mirrors, ${bracketEntries.length} brackets (Unicode ${UNICODE_VERSION})`,
);
