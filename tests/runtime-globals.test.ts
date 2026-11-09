import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";

// An embedder that puts the window's objects on globalThis itself, as one
// that runs pages in an isolate does, before TermDOM first reads the
// runtime's. This file is the first to construct a FormData or ask for
// randomness in its process.
test("the window's crypto and FormData read the runtime's after an embedder puts the window's on globalThis", () => {
	const dom = new TermDOM();
	const global = globalThis as Record<string, unknown>;
	const saved = ["crypto", "FormData"].map((name) =>
		[name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
	);
	try {
		for (const [name] of saved) {
			Object.defineProperty(globalThis, name, {
				value: (dom.window as unknown as Record<string, unknown>)[name],
				writable: true,
				configurable: true,
			});
		}
		expect(global.crypto).toBe(dom.window.crypto);
		expect(dom.window.crypto.randomUUID()).toHaveLength(36);
		expect(dom.window.crypto.getRandomValues(new Uint8Array(4))).toHaveLength(
			4,
		);
		const data = new dom.window.FormData();
		data.append("name", "value");
		expect(data.get("name")).toBe("value");
	} finally {
		for (const [name, descriptor] of saved) {
			if (descriptor === undefined) {
				delete global[name];
			} else {
				Object.defineProperty(globalThis, name, descriptor);
			}
		}
		dom.dispose();
	}
});
