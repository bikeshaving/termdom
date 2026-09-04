import {readFileSync} from "node:fs";

import {describe, expect, test} from "@b9g/libuild/test";

import {getStringWidth, isWidthUncertain} from "../src/internal/text.ts";
import {
	ORACLE_CASES,
	oracleSweepWidth,
	randomMixedStrings,
} from "./width-oracle-domain.js";

/**
 * Width drives line breaking and cell alignment, so the pure-JS width path
 * and Bun.getStringWidth have to agree exactly: if they diverge, the same
 * document renders with different wrapping on Node and Bun. The oracle's
 * answers live in a committed fixture a sufficiently new bun regenerates
 * (scripts/generate-width-oracle.ts). Under node, getStringWidth IS the
 * pure-JS path, so holding it to the fixture is the parity check; under
 * bun, getStringWidth IS the oracle, so the same run holds the fixture fresh.
 */
const oracleFixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/width-oracle.json", import.meta.url),
		"utf8",
	),
) as {cases: Record<string, number>; planes?: string; mixed?: number[]};

describe("getStringWidth matches the recorded oracle", () => {
	for (const [name, input] of ORACLE_CASES) {
		test(name, () => {
			expect(`${name}: ${getStringWidth(input)}`).toBe(
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
				const actual = oracleSweepWidth(code, getStringWidth, isWidthUncertain);
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
				if (getStringWidth(input) !== oracleFixture.mixed![i]) {
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

/**
 * The one place getStringWidth and Bun.getStringWidth deliberately DISAGREE, and why
 * getStringWidth() gates on it: Bun.getStringWidth charges a cell per code point, so a
 * combining mark -- which renders onto the character before it and advances
 * nothing -- is counted as if it were a letter of its own.
 */
test("combining marks take the grapheme-aware path, not Bun's", () => {
	// "שָׁלוֹם": four Hebrew letters carrying three niqqud. Four cells.
	expect(getStringWidth("שָׁלוֹם")).toBe(4);
	// Arabic with harakat: five letters, three marks.
	expect(getStringWidth("مَرْحَبًا")).toBe(5);
	// Cyrillic with a combining titlo.
	expect(getStringWidth("и҃")).toBe(1);
	// And the fast path is still exact for everything without them.
	expect(getStringWidth("hello")).toBe(5);
	expect(getStringWidth("中文")).toBe(4);
});
