import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";

// An embedder that puts the window's objects on globalThis itself, as one
// that runs pages in an isolate does, before TermDOM first reads the
// runtime's random source.
test("the window's crypto reads the runtime's after an embedder puts the window's on globalThis", () => {
	const dom = new TermDOM();
	const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	try {
		Object.defineProperty(globalThis, "crypto", {
			value: dom.window.crypto,
			writable: true,
			configurable: true,
		});
		expect(dom.window.crypto.randomUUID()).toHaveLength(36);
		expect(dom.window.crypto.getRandomValues(new Uint8Array(4)))
			.toHaveLength(4);
	} finally {
		if (saved !== undefined) {
			Object.defineProperty(globalThis, "crypto", saved);
		}
		dom.dispose();
	}
});
