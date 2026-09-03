/**
 * Regenerate src/generated/widthtables.ts from the Unicode Character
 * Database, so the wide, zero-width, and ambiguous ranges all come from one
 * source instead of hand-maintained lists.
 *
 * - WIDE_RANGES: EastAsianWidth W and F.
 * - ZERO_WIDTH_RANGES: general categories Mn, Me, and Cf, the
 *   Default_Ignorable_Code_Point property, and the conjoining Hangul
 *   jungseong and jongseong blocks, which compose into the leading
 *   consonant's cells.
 * - UNCERTAIN_RANGES: EastAsianWidth A.
 *
 * Run: node --experimental-strip-types scripts/generate-width-tables.ts
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

type Range = [number, number];

/** Parse `XXXX[..YYYY] ; VALUE` lines, keeping the values `wanted` names. */
function parseRanges(text: string, wanted: Set<string>): Range[] {
	const ranges: Range[] = [];
	for (const line of text.split("\n")) {
		const body = line.split("#")[0].trim();
		if (!body) {
			continue;
		}
		const [codes, value] = body.split(";").map((part) => part.trim());
		if (!wanted.has(value)) {
			continue;
		}
		const [start, end] = codes.split("..");
		ranges.push([parseInt(start, 16), parseInt(end ?? start, 16)]);
	}
	return ranges;
}

/** Sort and merge adjacent or overlapping ranges. */
function merge(ranges: Range[]): Range[] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const out: Range[] = [];
	for (const [start, end] of sorted) {
		const last = out[out.length - 1];
		if (last && start <= last[1] + 1) {
			last[1] = Math.max(last[1], end);
		} else {
			out.push([start, end]);
		}
	}
	return out;
}

/** Remove `holes` from `ranges`, splitting ranges the holes land inside. */
function subtract(ranges: Range[], holes: Range[]): Range[] {
	let out = ranges;
	for (const [holeStart, holeEnd] of holes) {
		const next: Range[] = [];
		for (const [start, end] of out) {
			if (holeEnd < start || holeStart > end) {
				next.push([start, end]);
				continue;
			}
			if (start < holeStart) {
				next.push([start, holeStart - 1]);
			}
			if (holeEnd < end) {
				next.push([holeEnd + 1, end]);
			}
		}
		out = next;
	}
	return out;
}

function render(name: string, doc: string, ranges: Range[]): string {
	const hex = (code: number) => `0x${code.toString(16)}`;
	const body = ranges
		.map(([start, end]) => `\t[${hex(start)}, ${hex(end)}],`)
		.join("\n");
	return `/** ${doc} */\nexport const ${name}: ReadonlyArray<readonly [number, number]> = [\n${body}\n];`;
}

const eaw = await fetchUCD("EastAsianWidth.txt");
const categories = await fetchUCD("extracted/DerivedGeneralCategory.txt");
const core = await fetchUCD("DerivedCoreProperties.txt");

const wide = merge(parseRanges(eaw, new Set(["W", "F"])));
const ambiguous = merge(parseRanges(eaw, new Set(["A"])));
const zero = subtract(
	merge([
		...parseRanges(categories, new Set(["Mn", "Me", "Cf"])),
		...parseRanges(core, new Set(["Default_Ignorable_Code_Point"])),
		// Conjoining jungseong and jongseong, both blocks of each: they
		// render into the leading consonant's two cells.
		[0x1160, 0x11ff],
		[0xd7b0, 0xd7c6],
		[0xd7cb, 0xd7fb],
	]),
	// The Hangul fillers are Default_Ignorable but occupy their East Asian
	// Width like any other Hangul: terminals space them.
	[
		[0x115f, 0x115f],
		[0x3164, 0x3164],
		[0xffa0, 0xffa0],
	],
);

const target = join(ROOT, "src/generated/widthtables.ts");
const output = `/**
 * Character width tables, generated from the Unicode Character Database at
 * ${UNICODE_VERSION}. Do not edit; run
 * \`node --experimental-strip-types scripts/generate-width-tables.ts\`
 * to regenerate.
 */

${render(
	"WIDE_RANGES",
	"East Asian Width W and F: two cells.",
	wide,
)}

${render(
	"ZERO_WIDTH_RANGES",
	"Marks, format characters, default-ignorables, and conjoining jamo: no cells when leading a cluster.",
	zero,
)}

${render(
	"UNCERTAIN_RANGES",
	"East Asian Width A: one or two cells depending on the emulator, so the width is probed at runtime.",
	ambiguous,
)}
`;
writeFileSync(target, output);
// The emitted file must be canonical: eslint is the one formatter, and a
// failure here is a failure of the generation.
execFileSync("npx", ["eslint", "--fix", target], {stdio: "inherit"});
console.log(
	`WIDE ${wide.length} ranges, ZERO ${zero.length}, AMBIGUOUS ${ambiguous.length} (Unicode ${UNICODE_VERSION})`,
);
