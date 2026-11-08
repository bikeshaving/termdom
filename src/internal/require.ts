/**
 * Loading a module the first time it is asked for.
 *
 * In a bundle, which is what the build and the tests make, a module
 * reached only through require() is wrapped in an init function the
 * first require() runs, synchronously, with the same instances of what it
 * shares with the rest of the bundle. Run from source there is no bundle,
 * and an ES module has no require() where the runtime gives it none, so
 * createRequire() loads the module there.
 *
 * A caller tries require() with a literal path, which the bundler can
 * see, and passes what it throws here.
 */

declare const require: unknown;

let requireSource: ((id: string) => unknown) | null = null;

/** Load `id` from source when `error` says there is no require(). */
export function requireFromSource(id: string, error: unknown): unknown {
	if (!(error instanceof ReferenceError) || typeof require !== "undefined") {
		throw error;
	}
	requireSource ??= (process.getBuiltinModule("node:module") as {
		createRequire(from: string): (id: string) => unknown;
	}).createRequire(import.meta.url);
	return requireSource(id);
}
