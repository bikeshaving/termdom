/**
 * Unicode's line breaking conformance file, a checked-in subset.
 * scripts/generate-linebreak-conformance.ts runs the full file and
 * regenerates the subset.
 */
import {readFileSync} from "node:fs";

import {expect, test} from "@b9g/libuild/test";

import {forEachLineBreak} from "../src/internal/linebreak.ts";
import {runLineBreakTest} from "./linebreak-conformance.ts";

function breaks(text: string): number[] {
	const out: number[] = [];
	forEachLineBreak(text, (position) => out.push(position));
	return out;
}

test("LineBreakTest.txt finds the break opportunities", () => {
	const fixture = readFileSync(
		new URL("./fixtures/linebreak-test.txt", import.meta.url),
		"utf8",
	);
	const result = runLineBreakTest(breaks, fixture);
	expect(result.failed).toEqual([]);
	expect(result.passed).toBeGreaterThan(2500);
});

test("a hard line break is required, at the end of the text too", () => {
	const found: string[] = [];
	forEachLineBreak("a b\nc\r\n", (position, required) =>
		found.push(`${position}${required ? "!" : ""}`),
	);
	expect(found).toEqual(["2", "4!", "7!"]);
});
