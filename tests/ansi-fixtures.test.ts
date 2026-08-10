import {describe, expect, test} from "@b9g/libuild/test";
import {scenarios} from "./ansi-fixtures.js";
import {recordedOutput} from "./fixtures/ansi-output.js";

describe("recorded ANSI output", () => {
	for (const scenario of scenarios) {
		test(scenario.name, () => {
			expect(recordedOutput[scenario.name]).toBeDefined();
			expect(scenario.run()).toBe(recordedOutput[scenario.name]);
		});
	}

	test("every recording still has a scenario", () => {
		expect(Object.keys(recordedOutput).sort()).toEqual(
			scenarios.map((s) => s.name).sort(),
		);
	});
});
