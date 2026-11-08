/**
 * The modules most pages never use, loaded the first time one is asked
 * for. No other module imports them for their values, only for types.
 *
 * In a bundle, which is what the build and the tests make, a module
 * reached only through require() is wrapped in an init function the
 * first require() runs, synchronously, with the same instances of what it
 * shares with the rest of the bundle. Run from source there is no bundle,
 * and an ES module has no require() where the runtime gives it none, so
 * createRequire() loads the module there.
 */

import type * as Gradients from "./gradients.ts";
import type * as MathML from "./mathml.ts";

declare const require: (id: string) => unknown;

let requireSource: ((id: string) => unknown) | null = null;

function requireFromSource(id: string, error: unknown): unknown {
	if (!(error instanceof ReferenceError) || typeof require !== "undefined") {
		throw error;
	}
	requireSource ??= (process.getBuiltinModule("node:module") as {
		createRequire(from: string): (id: string) => unknown;
	}).createRequire(import.meta.url);
	return requireSource(id);
}

let mathml: typeof MathML | null = null;

export function loadMathML(): typeof MathML {
	if (mathml === null) {
		try {
			mathml = require("./mathml.ts") as typeof MathML;
		} catch (error) {
			mathml = requireFromSource("./mathml.ts", error) as typeof MathML;
		}
	}
	return mathml;
}

let gradients: typeof Gradients | null = null;

export function loadGradients(): typeof Gradients {
	if (gradients === null) {
		try {
			gradients = require("./gradients.ts") as typeof Gradients;
		} catch (error) {
			gradients =
				requireFromSource("./gradients.ts", error) as typeof Gradients;
		}
	}
	return gradients;
}
