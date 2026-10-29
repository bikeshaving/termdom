import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

// Each input here has one number that, unclamped, drives work far past what a
// terminal can show. The render must come back quickly.
async function renderQuickly(html: string): Promise<void> {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 80, rows: 24}).transport,
	});
	const start = Date.now();
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	expect(Date.now() - start).toBeLessThan(3000);
	dom.dispose();
}

test("huge borders and table sizes draw only the visible cells", async () => {
	for (const html of [
		"<style>p{border:1e9px solid}</style><p>x</p>",
		"<table border=1000000000><tr><td>x</table>",
		"<table width=1000000000><tr><td>x</table>",
		"<table border=1><tr><td height=1000000000>x</table>",
		"<hr width=1000000000>",
		"<table border=1 cellpadding=1000000000 cellspacing=1000000000><tr><td>x</table>",
	]) {
		await renderQuickly(html);
	}
});

test("a huge tab-size pads a tab to a bounded width", async () => {
	await renderQuickly("<style>pre{tab-size:1000000}</style><pre>a\tb</pre>");
	await renderQuickly("<style>pre{tab-size:1000000px}</style><pre>a\tb</pre>");
});

test("huge grid lines, spans and auto-fill counts are clamped", async () => {
	for (const css of [
		".c{grid-row:100000000}",
		".c{grid-column:100000000}",
		".c{grid-column:span 1000000}",
		".c{grid-row:-100000000}",
		".g{width:1e9px;grid-template-columns:repeat(auto-fill,1px)}",
	]) {
		await renderQuickly(
			`<style>.g{display:grid}${css}</style><div class=g><div class=c>x</div></div>`,
		);
	}
});

test("a huge textarea cols or rows is clamped", async () => {
	await renderQuickly("<textarea cols=1000000000>x</textarea>");
	await renderQuickly("<textarea rows=1000000000>x</textarea>");
});

test("a repeating gradient on a huge box colors only the visible rows", async () => {
	await renderQuickly(
		"<div style=\"height:1e8px;overflow:auto;background:repeating-linear-gradient(red 0,blue 1px)\">x</div>",
	);
});

test("renderANSI paints a page taller than any grid in bands, and stops at 100000 rows", () => {
	const dom = new TermDOM({
		transport: new MockProcess({cols: 20, rows: 5}).transport,
	});
	const started = performance.now();
	const output = dom.renderANSI(
		"<table><tr><td height=1000000000>x</td></tr></table><p>after</p>",
	);
	expect(performance.now() - started).toBeLessThan(10000);
	expect(output.split("\n").length).toBe(100001);
	const short = dom.renderANSI(`<p style="margin-top: 1500px">deep</p>`);
	expect(short).toContain("deep");
	dom.dispose();
});
