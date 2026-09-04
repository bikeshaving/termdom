/**
 * Regenerate tests/fixtures/width-oracle.json: Bun.stringWidth's answers
 * over the domains the width tests sweep. The node test lane holds the
 * pure-JS width path against this fixture -- the parity that used to need
 * Bun in-process -- and the bun lane holds the fixture itself fresh, since
 * there getStringWidth IS Bun.stringWidth. Regenerate alongside the width
 * tables whenever the Unicode version moves.
 *
 * Run: bun scripts/generate-width-oracle.ts
 */

import {writeFileSync} from "node:fs";

import {isWidthUncertain} from "../src/internal/text.ts";
import {
	ORACLE_CASES,
	oracleSweepWidth,
	randomMixedStrings,
} from "../tests/width-oracle-domain.js";

if (typeof Bun === "undefined") {
	throw new Error("The oracle is Bun.stringWidth; run this under bun.");
}
const oracle = Bun.stringWidth.bind(Bun);
// The planes sweep only means something against an oracle at least as new
// as the tables (the trigrams went wide in Unicode 15.1); an older bun
// still vouches for the named cases.
const sweepable = oracle("☰") === 2;

const cases: Record<string, number> = {};
for (const [name, input] of ORACLE_CASES) {
	cases[name] = oracle(input);
}

// The planes sweep, run-length encoded as "width*count" pairs; skipped
// codepoints encode width -1 so decoding stays positional.
let planes: string | undefined;
let mixed: number[] | undefined;
if (sweepable) {
	const runs: string[] = [];
	let lastWidth = -2;
	let count = 0;
	for (let code = 0; code <= 0x3ffff; code++) {
		const width = oracleSweepWidth(code, oracle, isWidthUncertain);
		if (width === lastWidth) {
			count++;
		} else {
			if (count > 0) {
				runs.push(`${lastWidth}*${count}`);
			}
			lastWidth = width;
			count = 1;
		}
	}
	runs.push(`${lastWidth}*${count}`);
	planes = runs.join(" ");
	mixed = randomMixedStrings().map(([, input]) => oracle(input));
}

writeFileSync(
	new URL("../tests/fixtures/width-oracle.json", import.meta.url),
	`${JSON.stringify({cases, planes, mixed})}\n`,
);
console.log(
	`cases: ${Object.keys(cases).length}, sweep: ${sweepable ? "included" : "omitted (old oracle)"}`,
);
