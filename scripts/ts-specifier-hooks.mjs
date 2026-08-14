/**
 * Module hooks for running src/ directly under node: a relative `.js`
 * specifier whose file does not exist resolves to the `.ts` beside it.
 * The source imports compiled names (`./text.js`) because that is what
 * tsc and the published build resolve; node's type stripping loads the
 * `.ts` files but does not remap the specifiers.
 *
 * Registered by the WPT harnesses via module.register().
 */
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

export function resolve(specifier, context, nextResolve) {
	if (
		specifier.startsWith(".") &&
		specifier.endsWith(".js") &&
		context.parentURL?.includes("/src/")
	) {
		const asURL = new URL(specifier, context.parentURL);
		if (!existsSync(fileURLToPath(asURL))) {
			const asTS = specifier.slice(0, -3) + ".ts";
			return nextResolve(asTS, context);
		}
	}
	return nextResolve(specifier, context);
}
