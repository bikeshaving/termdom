/**
 * Tests that deeply nested CSS rules are dropped instead of hanging
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils";

async function render(css: string): Promise<TermDOM> {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({
		html: `<style>${css}</style><p id="a">hi</p>`,
		transport: terminal.transport,
	});
	await nextFrame(dom);
	return dom;
}

const SHALLOW = "#a{color:rgb(1,2,3)}";

for (const [name, open] of [
	["@media", "@media all{"],
	["@supports", "@supports (color:red){"],
	["@container", "@container (min-width:1px){"],
	["@layer", "@layer a{"],
]) {
	test(`${name} nested 5000 deep renders and shallow rules apply`, async () => {
		const css =
			SHALLOW + open.repeat(5000) + "#a{color:red}" + "}".repeat(5000);
		const dom = await render(css);
		const p = dom.document.getElementById("a")!;
		expect(dom.window.getComputedStyle(p).color).toBe("rgb(1, 2, 3)");
	});
}

test("style rules nested 5000 deep render quickly", async () => {
	const css = SHALLOW + "div{".repeat(5000) + "color:red" + "}".repeat(5000);
	const start = Date.now();
	const dom = await render(css);
	expect(Date.now() - start).toBeLessThan(3000);
	const p = dom.document.getElementById("a")!;
	expect(dom.window.getComputedStyle(p).color).toBe("rgb(1, 2, 3)");
});

test("rules within the nesting limit still apply", async () => {
	const css =
		"@media all{".repeat(10) + "#a{color:rgb(4,5,6)}" + "}".repeat(10);
	const dom = await render(css);
	const p = dom.document.getElementById("a")!;
	expect(dom.window.getComputedStyle(p).color).toBe("rgb(4, 5, 6)");
});
