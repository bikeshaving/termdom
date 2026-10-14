/**
 * An application can reach cssvalues before anything else of the engine,
 * and a module-level constant that needs a module not yet evaluated throws
 * a TDZ ReferenceError for that first importer and nobody else, which is
 * why the entry point never saw it.
 *
 * The import is the whole test: nothing else here is imported, so
 * cssvalues is the first module evaluated.
 */
import {expect, test} from "@b9g/libuild/test";

import {isInheritedProperty} from "../src/internal/cssvalues.ts";

test("cssvalues can be the first module of the cycle to be imported", () => {
	expect(isInheritedProperty("color")).toBe(true);
});
