/**
 * Reattach bun's test sub-methods that libuild 0.2.12's snapshot wrapper drops.
 *
 * The snapshot matcher wraps `test`/`describe`/`it` to track the snapshot-key
 * hierarchy, copying each sub-method (`.todo`/`.skip`/`.only`) onto the wrapper
 * via Object.getOwnPropertyNames(real). That works on node, which exposes them
 * as own properties -- but bun exposes them on the PROTOTYPE
 * (Object.getOwnPropertyNames(bunTest) is just `length,name`), so the wrapper
 * copies none of them and every bun file that calls `test.todo` throws
 * "test.todo is not a function". Patch them back from the native bun:test here,
 * on bun only. The real fix is in libuild's wrapBlock (walk the proto chain);
 * delete this file once that ships.
 */
import {describe, it, test} from "@b9g/libuild/test";

if (typeof Bun !== "undefined") {
	const native = (await import("bun:test")) as unknown as Record<
		string,
		unknown
	>;
	const SUBMETHODS = ["todo", "skip", "only", "skipIf", "todoIf", "if", "each"];
	const reattach = (wrapped: unknown, sourceName: string): void => {
		const target = wrapped as Record<string, unknown>;
		const source = native[sourceName] as Record<string, unknown> | undefined;
		if (!source) return;
		for (const key of SUBMETHODS) {
			if (
				typeof target[key] !== "function" &&
				typeof source[key] === "function"
			) {
				target[key] = (source[key] as (...args: unknown[]) => unknown).bind(
					source,
				);
			}
		}
	};
	reattach(test, "test");
	reattach(describe, "describe");
	reattach(it, "it");
}
