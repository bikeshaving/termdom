/**
 * The modules most pages never use, loaded the first time one is asked
 * for. No other module imports them for their values, only for types.
 */

import type * as Gradients from "./gradients.ts";
import type * as MathML from "./mathml.ts";
import {requireFromSource} from "./require.ts";

declare const require: (id: string) => unknown;

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
