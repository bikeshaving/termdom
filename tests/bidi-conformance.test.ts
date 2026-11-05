/**
 * Unicode's bidi conformance files, a checked-in subset of each.
 * scripts/generate-bidi-conformance.ts runs the full files and regenerates
 * the subset.
 */
import {readFileSync} from "node:fs";

import {expect, test} from "@b9g/libuild/test";

import * as Bidi from "../src/internal/bidi.ts";
import {runCharacterTest, runClassTest} from "./bidi-conformance.ts";

function fixture(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("BidiCharacterTest.txt resolves levels and order", () => {
	const result = runCharacterTest(Bidi, fixture("bidi-character-test.txt"));
	expect(result.failed).toEqual([]);
	expect(result.passed).toBeGreaterThan(2000);
});

test("BidiTest.txt resolves levels and order", () => {
	const result = runClassTest(Bidi, fixture("bidi-test.txt"));
	expect(result.failed).toEqual([]);
	expect(result.passed).toBeGreaterThan(5000);
});
