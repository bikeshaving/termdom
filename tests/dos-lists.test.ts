/**
 * Pages whose size is small but whose work used to grow with the square
 * of their siblings. Each size here took seconds before it was fixed.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame, stripControlCodes} from "./test-utils.ts";

test("an ordered list of thousands of items numbers the last one fast", async () => {
	const terminal = new MockProcess({cols: 30, rows: 12});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		`<div id="box" style="height:3px;overflow:auto"><ol>${"<li>x".repeat(20000)}</ol></div>`;
	const start = performance.now();
	await nextFrame(dom);
	dom.document.getElementById("box")!.scrollTop = 1e9;
	await nextFrame(dom);
	const text = stripControlCodes(terminal.getStaticANSI());
	expect(text).toContain("20000. x");
	expect(performance.now() - start).toBeLessThan(45000);
});
