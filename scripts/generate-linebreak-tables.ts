/**
 * Regenerate src/generated/linebreaktables.ts from the Unicode Character
 * Database, the data src/internal/linebreak.ts runs UAX #14 over.
 *
 * Each code point gets one kind: its Line_Break class after rule LB1
 * (AI, SG and XX resolve to AL, SA to CM when its General_Category is Mn
 * or Mc and to AL otherwise, CJ to NS), with QU split by General_Category
 * into QU_Pi, QU_Pf and QU, and two flags the rules read:
 *
 * - +W: East_Asian_Width is F, W or H (EastAsianWidth.txt), for LB19a
 *   and LB30.
 * - +P: Extended_Pictographic (emoji/emoji-data.txt) and unassigned
 *   (extracted/DerivedGeneralCategory.txt), for LB30b.
 *
 * Packed as strings and decoded on first use:
 *
 * - LINEBREAK_KINDS: the kinds, space-separated.
 * - LINEBREAK_RUN_KINDS: one character per run from U+0000 to U+10FFFF,
 *   naming the run's kind by its place in KIND_LETTERS.
 * - LINEBREAK_RUN_LENGTHS: the runs' lengths, comma-separated, base 36.
 *
 * Run: node --experimental-strip-types scripts/generate-linebreak-tables.ts
 */

import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const UNICODE_VERSION = "17.0.0";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;
const KIND_LETTERS =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

async function fetchUCD(path: string): Promise<string> {
	const response = await fetch(`${BASE}/${path}`);
	if (!response.ok) {
		throw new Error(`${BASE}/${path}: ${response.status}`);
	}
	return response.text();
}

const CLASSES = [
	"BK",
	"CR",
	"LF",
	"NL",
	"SP",
	"ZW",
	"ZWJ",
	"CM",
	"WJ",
	"GL",
	"CB",
	"CL",
	"CP",
	"EX",
	"SY",
	"OP",
	"QU",
	"QU_Pi",
	"QU_Pf",
	"IS",
	"NS",
	"B2",
	"BA",
	"HH",
	"HY",
	"BB",
	"IN",
	"NU",
	"PR",
	"PO",
	"AL",
	"HL",
	"ID",
	"EB",
	"EM",
	"JL",
	"JV",
	"JT",
	"H2",
	"H3",
	"RI",
	"AK",
	"AP",
	"AS",
	"VF",
	"VI",
];

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

function missing(text: string): Array<[number, number, string]> {
	return [...text.matchAll(/^# @missing: ([0-9A-F.]+); (\w+)$/gm)].map(
		(match) => [...codeRange(match[1]), match[2]],
	);
}

const lineBreak = await fetchUCD("LineBreak.txt");
const eastAsianWidth = await fetchUCD("EastAsianWidth.txt");
const emoji = await fetchUCD("emoji/emoji-data.txt");
const generalCategory = await fetchUCD("extracted/DerivedGeneralCategory.txt");

const SIZE = 0x110000;
const lb: string[] = new Array<string>(SIZE);
const fillLB = (start: number, end: number, value: string) =>
	lb.fill(value, start, end + 1);
for (const [start, end, value] of missing(lineBreak)) {
	fillLB(start, end, value);
}
for (const [codes, value] of lines(lineBreak)) {
	fillLB(...codeRange(codes), value);
}

const gc: string[] = new Array<string>(SIZE).fill("Cn");
const fillGC = (start: number, end: number, value: string) =>
	gc.fill(value, start, end + 1);
for (const [codes, value] of lines(generalCategory)) {
	fillGC(...codeRange(codes), value);
}

const wide = new Uint8Array(SIZE);
if (missing(eastAsianWidth).some(([, , value]) => value !== "N")) {
	throw new Error("unexpected East_Asian_Width default");
}
for (const [codes, value] of lines(eastAsianWidth)) {
	const [start, end] = codeRange(codes);
	wide.fill(
		value === "F" || value === "W" || value === "H" ? 1 : 0,
		start,
		end + 1,
	);
}

const pictographic = new Uint8Array(SIZE);
for (const [codes, value] of lines(emoji)) {
	if (value === "Extended_Pictographic") {
		const [start, end] = codeRange(codes);
		pictographic.fill(1, start, end + 1);
	}
}

const kinds: string[] = [];
const kindOf = new Uint8Array(SIZE);
for (let code = 0; code < SIZE; code++) {
	let name = lb[code];
	if (name === "AI" || name === "SG" || name === "XX") {
		name = "AL";
	} else if (name === "SA") {
		name = gc[code] === "Mn" || gc[code] === "Mc" ? "CM" : "AL";
	} else if (name === "CJ") {
		name = "NS";
	} else if (name === "QU" && (gc[code] === "Pi" || gc[code] === "Pf")) {
		name = `QU_${gc[code]}`;
	}
	if (!CLASSES.includes(name)) {
		throw new Error(`unknown class ${name}`);
	}
	let flags = "";
	if (wide[code]) {
		flags += "W";
	}
	if (pictographic[code] && gc[code] === "Cn") {
		flags += "P";
	}
	const kind = flags ? `${name}+${flags}` : name;
	let index = kinds.indexOf(kind);
	if (index === -1) {
		index = kinds.push(kind) - 1;
	}
	kindOf[code] = index;
}
if (kinds.length > KIND_LETTERS.length) {
	throw new Error(`${kinds.length} kinds, more than KIND_LETTERS holds`);
}

const runKinds: string[] = [];
const runLengths: string[] = [];
for (let start = 0; start < SIZE;) {
	let end = start;
	while (end + 1 < SIZE && kindOf[end + 1] === kindOf[start]) {
		end++;
	}
	runKinds.push(KIND_LETTERS[kindOf[start]]);
	runLengths.push((end - start + 1).toString(36));
	start = end + 1;
}

function chunk(text: string, width = 72): string {
	const parts: string[] = [];
	for (let i = 0; i < text.length; i += width) {
		parts.push(JSON.stringify(text.slice(i, i + width)));
	}
	return parts.join(" +\n\t");
}

const target = join(ROOT, "src/generated/linebreaktables.ts");
const output = `/**
 * Line breaking classes, generated from the Unicode Character Database at
 * ${UNICODE_VERSION}. Do not edit; run
 * \`node --experimental-strip-types scripts/generate-linebreak-tables.ts\`
 * to regenerate. The script describes the packing.
 */

/** The classes a kind names, in the order src/internal/linebreak.ts numbers them. */
export const LINEBREAK_CLASSES = ${JSON.stringify(CLASSES.join(" "))};

/** A class and its flags: +W East Asian, +P unassigned pictographic. */
export const LINEBREAK_KINDS = ${JSON.stringify(kinds.join(" "))};

/** The kind of each run, as a letter of ${JSON.stringify(KIND_LETTERS)}. */
export const LINEBREAK_RUN_KINDS =
	${chunk(runKinds.join(""))};

/** The length of each run, base 36. */
export const LINEBREAK_RUN_LENGTHS =
	${chunk(runLengths.join(","))};
`;
writeFileSync(target, output);
execFileSync("npx", ["eslint", "--fix", target], {stdio: "inherit"});
console.log(
	`${kinds.length} kinds, ${runKinds.length} runs (Unicode ${UNICODE_VERSION})`,
);
