import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("a percentage resolves against the containing block, not the root", async () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 80, rows: 20}).transport,
		html: `<!DOCTYPE html><html><body>
			<div style="width: 20ch"><div id="block" style="width: 50%; height: 1px"></div></div>
			<div style="display: flex; width: 20ch"><div id="item" style="width: 50%; height: 1px"></div></div>
			<div style="width: 20ch; padding-left: 4ch"><div id="padded" style="width: 50%; padding-left: 25%; height: 1px"></div></div>
			<div style="width: 20ch; height: 4px"><div id="tall" style="height: 50%"></div></div>
			<div style="position: relative; width: 20ch; height: 2px"><div id="absolute" style="position: absolute; width: 50%; left: 25%; height: 1px"></div></div>
		</body></html>`,
	});
	await nextFrame(dom);
	const rect = (id: string): DOMRect =>
		dom.document.getElementById(id)!.getBoundingClientRect();
	expect(rect("block").width).toBe(10);
	expect(rect("item").width).toBe(10);
	expect(rect("padded").width).toBe(8);
	expect(rect("tall").height).toBe(2);
	expect(rect("absolute").width).toBe(10);
	expect(rect("absolute").left).toBe(5);
	dom.dispose();
});
