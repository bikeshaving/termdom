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

test("nested nth-child of lists over hundreds of siblings match fast", async () => {
	const terminal = new MockProcess({cols: 30, rows: 12});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.head.innerHTML = `<style>
		:nth-child(2n+1 of :nth-child(2n+1 of :nth-child(2n+1 of div))) {
			color: red;
		}
		:nth-last-child(2n+1 of :nth-last-child(2n+1 of :nth-last-child(2n+1 of div))) {
			background-color: blue;
		}
	</style>`;
	document.body.innerHTML = `<section>${"<div>x</div>".repeat(300)}</section>`;
	const start = performance.now();
	await nextFrame(dom);
	const divs = document.querySelectorAll("section > div");
	const red = (n: number) => dom.window.getComputedStyle(divs[n]).color;
	const blue =
		(n: number) => dom.window.getComputedStyle(divs[n]).backgroundColor;
	expect(red(296)).toBe(red(0));
	expect(red(8)).toBe(red(0));
	expect(red(4)).not.toBe(red(0));
	expect(red(1)).not.toBe(red(0));
	expect(blue(299)).toBe(blue(291));
	expect(blue(298)).not.toBe(blue(299));
	expect(
		document.querySelectorAll(
			"section > :nth-child(2n+1 of :nth-child(2n+1 of :nth-child(2n+1 of div)))",
		).length,
	).toBe(38);
	expect(performance.now() - start).toBeLessThan(10000);
});
