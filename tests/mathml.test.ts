/**
 * Presentation MathML rendering, read back as the cells the terminal
 * shows. Display mode may take several rows; inline mode is one line.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {createWindow} from "../src/internal/dom.ts";
import {captureRawOutput, MockProcess, nextFrame} from "./test-utils.ts";

async function render(
	html: string,
	cols = 40,
	rows = 12,
): Promise<{lines: string[]; dom: TermDOM; terminal: MockProcess}> {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	const lines = terminal.getVisibleText().replace(/\n$/, "").split("\n");
	return {lines, dom, terminal};
}

async function renderLines(html: string, cols = 40): Promise<string[]> {
	const {lines, dom} = await render(html, cols);
	dom.dispose();
	return lines;
}

async function renderANSI(html: string): Promise<string> {
	const terminal = new MockProcess({cols: 40, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	const output = captureRawOutput(terminal);
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	dom.dispose();
	return output();
}

function block(body: string): string {
	return `<math display="block">${body}</math>`;
}

function inline(body: string): string {
	return `<p>a <math>${body}</math> z</p>`;
}

test("the parser puts <math> and its children in the MathML namespace", () => {
	const window =
		createWindow("<p><math><mi>x</mi><mtext>b <b>c</b></mtext></math></p>");
	const math = window.document.querySelector("math")!;
	expect(math.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
	expect(math.querySelector("mi")!.namespaceURI).toBe(math.namespaceURI);
	expect(math.querySelector("b")!.namespaceURI).toBe(
		"http://www.w3.org/1999/xhtml",
	);
	expect(math instanceof (window as any).MathMLElement).toBe(true);
	expect(typeof (window as any).MathMLElement).toBe("function");
});

test("inline math sits on its line as one box", async () => {
	const lines = await renderLines(
		inline("<mi>x</mi><mo>+</mo><mn>2</mn><mo>=</mo><mi>y</mi>"),
	);
	expect(lines).toEqual(["a x + 2 = y z"]);
});

test("block math is centered on a row of its own", async () => {
	const lines = await renderLines(
		"<p>before</p>" + block("<mi>x</mi><mo>+</mo><mn>1</mn>") + "<p>after</p>",
		20,
	);
	expect(lines).toEqual(["before", "       x + 1", "after"]);
});

test("prefix and postfix operators get no gap", async () => {
	const lines = await renderLines(
		inline("<mo>-</mo><mi>a</mi><mo>+</mo><mi>n</mi><mo>!</mo>"),
	);
	expect(lines).toEqual(["a -a + n! z"]);
});

test("fences and invisible operators take no space of their own", async () => {
	const lines = await renderLines(
		inline(
			"<mi>sin</mi><mo>&#x2061;</mo><mo>(</mo><mi>θ</mi><mo>)</mo>" +
			"<mo>&#x2062;</mo><mi>x</mi>",
		),
	);
	expect(lines).toEqual(["a sin(θ)x z"]);
});

test("ms wraps its text in quotes and mspace is empty cells", async () => {
	const lines = await renderLines(
		inline("<ms>hi</ms><mspace width=\"2em\"></mspace><mn>1</mn>"),
	);
	expect(lines).toEqual(["a \"hi\"  1 z"]);
});

test("an empty mrow is one blank cell", async () => {
	const lines = await renderLines(inline("<mi>x</mi><mrow></mrow><mi>y</mi>"));
	expect(lines).toEqual(["a x y z"]);
});

test("a single-letter mi is italic and mathvariant=normal is not", async () => {
	expect(await renderANSI(block("<mi>x</mi>"))).toContain("\x1b[3m");
	expect(
		await renderANSI(block("<mi mathvariant=\"normal\">x</mi>")),
	).not.toContain("\x1b[3m");
	expect(await renderANSI(block("<mi>sin</mi>"))).not.toContain("\x1b[3m");
});

test("mathcolor and mathbackground color the token's cells", async () => {
	const output = await renderANSI(
		block("<mn mathcolor=\"red\" mathbackground=\"blue\">7</mn>"),
	);
	expect(output).toMatch(/38;2;255;0;0/);
	expect(output).toMatch(/48;2;0;0;255/);
});

test("editing a token relayouts the line around the math", async () => {
	const {dom, terminal} = await render(inline("<mn>2</mn>"), 40);
	dom.document.querySelector("mn")!.textContent = "1234";
	await nextFrame(dom);
	const lines = terminal.getVisibleText().replace(/\n$/, "").split("\n");
	dom.dispose();
	expect(lines).toEqual(["a 1234 z"]);
});

test("a display:none child and an annotation render nothing", async () => {
	const lines = await renderLines(
		inline(
			"<semantics><mi>x</mi><annotation encoding=\"application/x-tex\">x</annotation></semantics>" +
			"<mn style=\"display:none\">9</mn>",
		),
	);
	expect(lines).toEqual(["a x z"]);
});

test("HTML inside mtext renders as text", async () => {
	const lines = await renderLines(inline("<mtext>if <b>x</b></mtext>"));
	expect(lines).toEqual(["a if x z"]);
});

test("getBoundingClientRect reports the math box in cells", async () => {
	const {dom} = await render(inline("<mi>x</mi><mo>+</mo><mi>y</mi>"), 40);
	const rect = dom.document.querySelector("math")!.getBoundingClientRect();
	dom.dispose();
	expect([rect.x, rect.y, rect.width, rect.height]).toEqual([2, 0, 5, 1]);
});
