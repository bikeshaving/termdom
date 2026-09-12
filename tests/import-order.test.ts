/**
 * cssvalues, cssselectors, dom and cssom form an import cycle, so whichever
 * of them an application reaches first is evaluated before the others'
 * tables exist. A module-level constant that calls across the cycle throws
 * a TDZ ReferenceError for that first importer and nobody else, which is
 * why the entry point never saw it.
 *
 * The import is the whole test: nothing else here reaches the cycle, so
 * cssvalues is the module that evaluates it.
 */
import {expect, test} from "@b9g/libuild/test";

import {isInheritedProperty} from "../src/internal/cssvalues.ts";

test("cssvalues can be the first module of the cycle to be imported", () => {
	expect(isInheritedProperty("color")).toBe(true);
});
