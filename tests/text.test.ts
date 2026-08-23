import {describe, expect, test} from "@b9g/libuild/test";
import {readFileSync} from "node:fs";
import {
	dataOffsetAt,
	renderTextFragment,
	renderWhiteSpaceOffsets,
	stringWidth,
	widthIsUncertain,
} from "../src/internal/text.js";
import {
	ORACLE_CASES,
	oracleSweepWidth,
	randomMixedStrings,
} from "./width-oracle-domain.js";

/**
 * Width drives line breaking and cell alignment, so the pure-JS width path
 * and Bun.stringWidth have to agree exactly: if they diverge, the same
 * document renders with different wrapping on Node and Bun. The oracle's
 * answers live in a committed fixture a sufficiently new bun regenerates
 * (scripts/generate-width-oracle.ts). Under node, stringWidth IS the
 * pure-JS path, so holding it to the fixture is the parity check; under
 * bun, stringWidth IS the oracle, so the same run holds the fixture fresh.
 */
const oracleFixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/width-oracle.json", import.meta.url),
		"utf8",
	),
) as {cases: Record<string, number>; planes?: string; mixed?: number[]};

describe("stringWidth matches the recorded oracle", () => {
	for (const [name, input] of ORACLE_CASES) {
		test(name, () => {
			expect(`${name}: ${stringWidth(input)}`).toBe(
				`${name}: ${oracleFixture.cases[name]}`,
			);
		});
	}

	// An old oracle cannot vouch for the sweeps; the fixture says so by
	// omission, and regenerating under a bun with Unicode 15.1 tables
	// fills them in.
	(oracleFixture.planes ? test : test.skip)(
		"every codepoint in the BMP and astral planes",
		() => {
			const widths: number[] = [];
			for (const run of oracleFixture.planes!.split(" ")) {
				const [width, count] = run.split("*").map(Number);
				for (let i = 0; i < count; i++) {
					widths.push(width);
				}
			}
			const mismatches: string[] = [];
			for (let code = 0; code <= 0x3ffff; code++) {
				const expected = widths[code];
				if (expected === -1) {
					continue;
				}
				const actual = oracleSweepWidth(code, stringWidth, widthIsUncertain);
				if (actual !== expected) {
					mismatches.push(`U+${code.toString(16).toUpperCase()}`);
				}
			}
			expect(mismatches).toEqual([]);
		},
	);

	(oracleFixture.mixed ? test : test.skip)(
		"random strings of mixed scripts and emoji",
		() => {
			const mismatches: string[] = [];
			for (const [i, input] of randomMixedStrings()) {
				if (stringWidth(input) !== oracleFixture.mixed![i]) {
					mismatches.push(JSON.stringify(input));
				}
			}
			expect(mismatches).toEqual([]);
		},
	);
});

/**
 * The invariant the painter rests on: a line fragment records the range of data
 * it renders, and rendering that range gives back the characters the line
 * paints. It holds because rendering a range equals the range of the rendering
 * whenever the range begins and ends on a rendered character.
 */
describe("whitespace rendering", () => {
	const cases: Array<[string, string]> = [
		["plain words", "hello world"],
		["a run of spaces", "a   b"],
		["a lone tab", "a\tb"],
		["a lone newline", "a\nb"],
		["mixed whitespace", "a \n\t b  \r\nc"],
		["leading and trailing", "  padded  "],
		["a non-breaking space", "a b"],
		["surrogate pairs", "a  \u{1f600}  b"],
		["nothing", ""],
	];

	for (const whiteSpace of [
		"normal",
		"nowrap",
		"pre-line",
		"pre",
		"pre-wrap",
	]) {
		for (const [name, data] of cases) {
			test(`${whiteSpace}: ${name} maps every rendered character to its data`, () => {
				const {text, offsets} = renderWhiteSpaceOffsets(data, whiteSpace);
				expect(text).toBe(
					renderTextFragment(data, whiteSpace, 0, data.length),
				);
				for (let i = 0; i < text.length; i++) {
					const offset = dataOffsetAt(offsets, i);
					expect(offset).toBeGreaterThanOrEqual(0);
					expect(offset).toBeLessThan(data.length);
					// A rendered character is either the data character it came
					// from, or the single space a collapsed run renders as.
					expect(text[i] === data[offset] || text[i] === " ").toBe(true);
				}
			});

			test(`${whiteSpace}: ${name} renders a range as the range of the rendering`, () => {
				const {text, offsets} = renderWhiteSpaceOffsets(data, whiteSpace);
				for (let from = 0; from < text.length; from++) {
					for (let to = from + 1; to <= text.length; to++) {
						const start = dataOffsetAt(offsets, from);
						const end = dataOffsetAt(offsets, to - 1) + 1;
						expect(renderTextFragment(data, whiteSpace, start, end)).toBe(
							text.slice(from, to),
						);
					}
				}
			});
		}
	}
});

/**
 * The one place stringWidth and Bun.stringWidth deliberately DISAGREE, and why
 * stringWidth() gates on it: Bun.stringWidth charges a cell per code point, so a
 * combining mark -- which renders onto the character before it and advances
 * nothing -- is counted as if it were a letter of its own.
 */
test("combining marks take the grapheme-aware path, not Bun's", () => {
	// "שָׁלוֹם": four Hebrew letters carrying three niqqud. Four cells.
	expect(stringWidth("שָׁלוֹם")).toBe(4);
	// Arabic with harakat: five letters, three marks.
	expect(stringWidth("مَرْحَبًا")).toBe(5);
	// Cyrillic with a combining titlo.
	expect(stringWidth("и҃")).toBe(1);
	// And the fast path is still exact for everything without them.
	expect(stringWidth("hello")).toBe(5);
	expect(stringWidth("中文")).toBe(4);
});
