/**
 * Runs Unicode's line breaking conformance file, LineBreakTest.txt,
 * against a function that answers a string's break opportunities as
 * UTF-16 offsets, the string's length included. Shared by
 * tests/linebreak-conformance.test.ts, which runs a checked-in subset, and
 * scripts/generate-linebreak-conformance.ts, which runs the full file and
 * writes that subset.
 */

export interface ConformanceResult {
	passed: number;
	failed: string[];
}

export function runLineBreakTest(
	breaks: (text: string) => number[],
	file: string,
): ConformanceResult {
	const result: ConformanceResult = {passed: 0, failed: []};
	for (const line of file.split("\n")) {
		const body = line.split("#")[0].trim();
		if (!body) {
			continue;
		}
		let text = "";
		const expected: number[] = [];
		for (const token of body.split(/\s+/)) {
			if (token === "÷") {
				if (text.length > 0) {
					expected.push(text.length);
				}
			} else if (token !== "×") {
				text += String.fromCodePoint(parseInt(token, 16));
			}
		}
		const actual = breaks(text);
		if (actual.join() === expected.join()) {
			result.passed++;
		} else {
			result.failed.push(`${body} got ${actual.join()}`);
		}
	}
	return result;
}
