/**
 * Module hooks for running src/ directly under node: a relative `.js`
 * specifier whose file does not exist resolves to the `.ts` beside it.
 * The source imports compiled names (`./text.js`) because that is what
 * tsc and the published build resolve; node's type stripping loads the
 * `.ts` files but does not remap the specifiers.
 *
 * A `?wpt=N` query on a parent PROPAGATES to its relative children, so
 * importing `termdom.ts?wpt=7` evaluates a fresh copy of the whole
 * engine graph -- each WPT file runs a realm no other file has touched.
 *
 * Registered by the WPT harnesses via module.register().
 */
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

export function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith(".") && context.parentURL) {
		const parent = new URL(context.parentURL);
		const generation = parent.searchParams.get("wpt");
		const asURL = new URL(specifier, context.parentURL);
		if (asURL.pathname.includes("/src/")) {
			let resolved = specifier;
			if (
				specifier.endsWith(".js") &&
				!existsSync(fileURLToPath(asURL))
			) {
				resolved = specifier.slice(0, -3) + ".ts";
			}
			if (generation !== null && !resolved.includes("?")) {
				resolved += `?wpt=${generation}`;
			}
			if (resolved !== specifier) {
				return nextResolve(resolved, context);
			}
		}
	}
	return nextResolve(specifier, context);
}
