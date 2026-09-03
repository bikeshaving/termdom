import {expect, test} from "@b9g/libuild/test";

import {getLiveRangeCount} from "../src/internal/dom.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("the engine releases the ranges it makes for itself", async () => {
	const dom = new TermDOM({
		transport: new MockProcess().transport,
		html: "<!DOCTYPE html><html><body><div><p>ab<b>cd</b></p><p>ef<i>gh</i></p></div></body></html>",
	});
	const document = dom.window.document;
	await nextFrame(dom);
	const before = getLiveRangeCount(document);

	const first = document.querySelector("p")!.firstChild!;
	const last = document.querySelector("i")!.firstChild!;
	for (let i = 0; i < 20; i++) {
		const range = document.createRange();
		range.setStart(first, 1);
		range.setEnd(last, 1);
		range.cloneContents();
	}
	expect(getLiveRangeCount(document)).toBe(before + 20);

	const selection = dom.window.getSelection()!;
	for (let i = 0; i < 20; i++) {
		selection.collapse(first, i % 2);
		selection.extend(last, 1);
	}
	const withSelection = getLiveRangeCount(document);
	expect(withSelection).toBeLessThanOrEqual(before + 20 + 3);

	for (let i = 0; i < 20; i++) {
		selection.modify("move", "forward", "line");
		selection.modify("move", "backward", "line");
	}
	expect(getLiveRangeCount(document)).toBeLessThanOrEqual(withSelection);

	selection.removeAllRanges();
	expect(getLiveRangeCount(document)).toBe(before + 20);
	dom.dispose();
});
