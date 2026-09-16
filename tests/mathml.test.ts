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

test("a script with Unicode forms adds no rows in either mode", async () => {
	const sup = "<msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>y</mi>";
	expect(await renderLines(block(sup), 20)).toEqual(["       x² + y"]);
	expect(await renderLines(inline(sup))).toEqual(["a x² + y z"]);
	const sub = "<msub><mi>x</mi><mi>i</mi></msub><mo>+</mo><mi>y</mi>";
	expect(await renderLines(inline(sub))).toEqual(["a xᵢ + y z"]);
	const both = "<msubsup><mi>x</mi><mn>3</mn><mn>2</mn></msubsup>";
	expect(await renderLines(inline(both))).toEqual(["a x₃² z"]);
	const exponent =
		"<msup><mi>e</mi><mrow><mo>-</mo><mi>i</mi><mi>t</mi></mrow></msup>";
	expect(await renderLines(inline(exponent))).toEqual(["a e⁻ⁱᵗ z"]);
});

test("a script without Unicode forms shifts a row in display mode", async () => {
	const sup = "<msup><mi>x</mi><mi>q</mi></msup><mo>+</mo><mi>y</mi>";
	expect(await renderLines(block(sup), 20)).toEqual([
		"        q",
		"       x  + y",
	]);
	const sub = "<mi>x</mi><msub><mi>y</mi><mi>ab</mi></msub>";
	expect(await renderLines(block(sub), 20)).toEqual([
		"        xy",
		"          ab",
	]);
	const both = "<msubsup><mi>x</mi><mi>ab</mi><mi>q</mi></msubsup>";
	expect(await renderLines(block(both), 20)).toEqual([
		"         q",
		"        x",
		"         ab",
	]);
});

test("a script without Unicode forms is spelled ^ and _ inline", async () => {
	expect(
		await renderLines(inline("<msup><mi>x</mi><mi>q</mi></msup>")),
	).toEqual(
		["a x^q z"],
	);
	expect(
		await renderLines(inline("<msub><mi>x</mi><mi>ab</mi></msub>")),
	).toEqual(
		["a x_(ab) z"],
	);
	expect(
		await renderLines(
			inline(
				"<msubsup><mi>x</mi><mi>ab</mi><mrow><mi>n</mi><mo>+</mo><mi>q</mi></mrow></msubsup>",
			),
		),
	).toEqual(["a x_(ab)^(n+q) z"]);
});

test("mmultiscripts puts prescripts before the base", async () => {
	expect(
		await renderLines(
			inline(
				"<mmultiscripts><mi>X</mi><mn>1</mn><mn>2</mn>" +
				"<mprescripts/><mn>3</mn><none/></mmultiscripts>",
			),
		),
	).toEqual(["a ₃X₁² z"]);
});

test("a display fraction stacks over a bar with one cell of overhang", async () => {
	const lines = await renderLines(
		block(
			"<mfrac><mrow><mi>n</mi><mo>(</mo><mi>n</mi><mo>+</mo><mn>1</mn><mo>)</mo></mrow><mn>2</mn></mfrac>",
		),
		20,
	);
	expect(lines).toEqual(["      n(n + 1)", "     ──────────", "         2"]);
});

test("a fraction beside an equals sign shares its baseline with the bar", async () => {
	const lines = await renderLines(
		block("<mi>y</mi><mo>=</mo><mfrac><mi>a</mi><mi>b</mi></mfrac>"),
		20,
	);
	expect(lines).toEqual(["           a", "      y = ───", "           b"]);
});

test("linethickness=0 leaves an empty bar row", async () => {
	const lines = await renderLines(
		block("<mfrac linethickness=\"0\"><mi>n</mi><mi>k</mi></mfrac>"),
		10,
	);
	expect(lines).toEqual(["    n", "", "    k"]);
});

test("an inline fraction is a/b with parentheses around a wide mrow", async () => {
	expect(
		await renderLines(
			inline(
				"<mfrac><mi>a</mi><mrow><mi>b</mi><mo>+</mo><mn>1</mn></mrow></mfrac>",
			),
		),
	).toEqual(["a a/(b + 1) z"]);
	expect(
		await renderLines(
			inline("<mfrac><msup><mi>x</mi><mn>2</mn></msup><mn>2</mn></mfrac>"),
		),
	).toEqual(["a x²/2 z"]);
});

test("math-style: compact forces the inline forms in display mode", async () => {
	const lines = await renderLines(
		"<math display=\"block\" style=\"math-style: compact\">" +
		"<mfrac><mi>a</mi><mi>b</mi></mfrac></math>",
		10,
	);
	expect(lines).toEqual(["   a/b"]);
});

test("a display root draws an overline and a sign on the baseline", async () => {
	expect(
		await renderLines(
			block("<msqrt><mi>x</mi><mo>+</mo><mn>1</mn></msqrt>"),
			20,
		),
	).toEqual(["        ─────", "       √x + 1"]);
	expect(
		await renderLines(
			block("<msqrt><mfrac><mi>a</mi><mi>b</mi></mfrac></msqrt>"),
			10,
		),
	).toEqual(["    ───", "   ╱ a", "   √───", "     b"]);
	expect(
		await renderLines(block("<mroot><mi>x</mi><mn>3</mn></mroot>"), 10),
	).toEqual(
		["    3─", "    √x"],
	);
});

test("an inline root is √(x) with the index as a superscript", async () => {
	expect(
		await renderLines(inline("<msqrt><mi>x</mi><mo>+</mo><mn>1</mn></msqrt>")),
	).toEqual(["a √(x + 1) z"]);
	expect(
		await renderLines(inline("<mroot><mi>x</mi><mn>3</mn></mroot>")),
	).toEqual(
		["a ³√(x) z"],
	);
});

test("stretchy fences grow to the height of their siblings", async () => {
	const fraction = "<mfrac><mi>a</mi><mi>b</mi></mfrac>";
	expect(
		await renderLines(block(`<mo>(</mo>${fraction}<mo>)</mo>`), 10),
	).toEqual(
		["  ⎛ a ⎞", "  ⎜───⎟", "  ⎝ b ⎠"],
	);
	expect(
		await renderLines(block(`<mo>{</mo>${fraction}<mo>}</mo>`), 10),
	).toEqual(
		["  ⎧ a ⎫", "  ⎨───⎬", "  ⎩ b ⎭"],
	);
	expect(
		await renderLines(block(`<mo>∫</mo>${fraction}<mi>dx</mi>`), 12),
	).toEqual(
		["   ⌠ a", "   ⎮───dx", "   ⌡ b"],
	);
	expect(await renderLines(inline(`<mo>(</mo>${fraction}<mo>)</mo>`))).toEqual([
		"a (a/b) z",
	]);
});

test("large operators stack their limits in display mode", async () => {
	const sum =
		"<munderover><mo>∑</mo><mrow><mi>k</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover>" +
		"<msup><mi>k</mi><mn>2</mn></msup>";
	expect(await renderLines(block(sum), 12)).toEqual([
		"    n",
		"    ∑ k²",
		"   k=1",
	]);
	expect(await renderLines(inline(sum))).toEqual(["a ∑ₖ₌₁ⁿk² z"]);
});

test("an accent over a one-cell base is a combining mark", async () => {
	expect(
		await renderLines(
			inline("<mover accent=\"true\"><mi>x</mi><mo>¯</mo></mover>"),
		),
	).toEqual(["a x̄ z"]);
	expect(
		await renderLines(
			block(
				"<mover><mrow><mi>a</mi><mi>b</mi><mi>c</mi></mrow><mo>⏞</mo></mover>",
			),
			10,
		),
	).toEqual(["   ╭─╮", "   abc"]);
	expect(
		await renderLines(
			block(
				"<munder><mi>lim</mi><mrow><mi>n</mi><mo>→</mo><mi>∞</mi></mrow></munder>",
			),
			10,
		),
	).toEqual(["   lim", "   n→∞"]);
});

test("the ascii glyph set draws with slashes, pipes and dashes", async () => {
	const lines = await renderLines(
		"<math display=\"block\" style=\"--math-glyphs: ascii\"><mo>(</mo>" +
		"<mfrac><mi>a</mi><msqrt><mi>b</mi></msqrt></mfrac><mo>)</mo></math>",
		12,
	);
	expect(lines).toEqual([
		"  /     \\",
		"  |  a  |",
		"  |-----|",
		"  |   _ |",
		"  \\ \\/b /",
	]);
	for (const line of lines) {
		expect(/^[\x00-\x7f]*$/.test(line)).toBe(true);
	}
});

const TABLE =
	"<mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>10</mn></mtd></mtr>" +
	"<mtr><mtd><mn>100</mn></mtd><mtd><mn>2</mn></mtd></mtr></mtable>";

test("a table sizes columns to their widest cell and centers cells", async () => {
	expect(await renderLines(block(TABLE), 10)).toEqual(["   1  10", "  100 2"]);
	expect(
		await renderLines(
			block(TABLE.replace("<mtable>", "<mtable columnalign=\"left right\">")),
			10,
		),
	).toEqual(["  1   10", "  100  2"]);
	expect(await renderLines(inline(TABLE))).toEqual(["a 1, 10; 100, 2 z"]);
});

test("table rows align on their tallest cell's baseline", async () => {
	const lines = await renderLines(
		block(
			"<mtable><mtr><mtd><mfrac><mi>a</mi><mi>b</mi></mfrac></mtd>" +
			"<mtd><mi>x</mi></mtd></mtr></mtable>",
		),
		10,
	);
	expect(lines).toEqual(["   a", "  ─── x", "   b"]);
});

test("frame, rowlines and columnlines draw box-drawing rules", async () => {
	const lines = await renderLines(
		block(
			"<mtable frame=\"solid\" rowlines=\"solid\" columnlines=\"solid\">" +
			"<mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr>" +
			"<mtr><mtd><mn>3</mn></mtd><mtd><mn>4</mn></mtd></mtr></mtable>",
		),
		10,
	);
	expect(lines).toEqual([
		"  ┌─┬─┐",
		"  │1│2│",
		"  ├─┼─┤",
		"  │3│4│",
		"  └─┴─┘",
	]);
});

test("mphantom takes space and paints nothing", async () => {
	expect(
		await renderLines(
			inline("<mi>x</mi><mphantom><mi>yy</mi></mphantom><mi>z</mi>"),
		),
	).toEqual(["a x  z z"]);
});

test("mpadded grows the box by its attributes", async () => {
	expect(
		await renderLines(
			inline(
				"<mpadded width=\"4em\" lspace=\"1em\"><mi>x</mi></mpadded><mi>y</mi>",
			),
		),
	).toEqual(["a  x  y z"]);
});

test("merror draws a red border in display mode", async () => {
	expect(
		await renderLines(
			block("<merror><mi>x</mi><mo>+</mo><mn>1</mn></merror>"),
			11,
		),
	).toEqual(["  ┌─────┐", "  │x + 1│", "  └─────┘"]);
	expect(await renderANSI(block("<merror><mi>x</mi></merror>"))).toMatch(
		/38;2;255;0;0/,
	);
});

test("getBoundingClientRect reports the math box in cells", async () => {
	const {dom} = await render(inline("<mi>x</mi><mo>+</mo><mi>y</mi>"), 40);
	const rect = dom.document.querySelector("math")!.getBoundingClientRect();
	dom.dispose();
	expect([rect.x, rect.y, rect.width, rect.height]).toEqual([2, 0, 5, 1]);
});
