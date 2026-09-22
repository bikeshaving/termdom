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

// The lines with an underlined blank cell shown as _: the bars of a
// drawn sum and a radical are underlines, flush with the strokes.
async function renderMarked(html: string, cols = 40): Promise<string[]> {
	const {dom, terminal} = await render(html, cols);
	const buffer = (terminal as any).terminal.buffer.active;
	const lines: string[] = [];
	for (let y = 0; y < terminal.stdout.rows; y++) {
		const line = buffer.getLine(y);
		let text = "";
		for (let x = 0; x < terminal.stdout.columns; x++) {
			const cell = line?.getCell(x);
			if (!cell || cell.getWidth() === 0) {
				continue;
			}
			const chars = cell.getChars() || " ";
			text += chars === " " && cell.isUnderline() ? "_" : chars;
		}
		lines.push(text.trimEnd());
	}
	dom.dispose();
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
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

test("a display fraction bars its numerator with one cell of overhang", async () => {
	const lines = await renderMarked(
		block(
			"<mfrac><mrow><mi>n</mi><mo>(</mo><mi>n</mi><mo>+</mo><mn>1</mn><mo>)</mo></mrow><mn>2</mn></mfrac>",
		),
		20,
	);
	expect(lines).toEqual(["     _n(n_+_1)_", "         2"]);
});

test("a fraction beside an equals sign shares its baseline with the bar", async () => {
	const lines = await renderMarked(
		block("<mi>y</mi><mo>=</mo><mfrac><mi>a</mi><mi>b</mi></mfrac>"),
		20,
	);
	expect(lines).toEqual(["      y = _a_", "           b"]);
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

test("a display root draws a bar over the radicand that meets the sign", async () => {
	expect(
		await renderMarked(
			block("<msqrt><mi>x</mi><mo>+</mo><mn>1</mn></msqrt>"),
			20,
		),
	).toEqual(["        _____", "       ⎷x + 1"]);
	expect(
		await renderMarked(
			block("<msqrt><mfrac><mi>a</mi><mi>b</mi></mfrac></msqrt>"),
			10,
		),
	).toEqual(["    ___", "   ╱_a_", "  ⎷  b"]);
	expect(
		await renderMarked(block("<mroot><mi>x</mi><mn>3</mn></mroot>"), 10),
	).toEqual(
		["    3_", "    ⎷x"],
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
		await renderMarked(block(`<mo>(</mo>${fraction}<mo>)</mo>`), 10),
	).toEqual(
		["  ⎛_a_⎞", "  ⎝ b ⎠"],
	);
	expect(
		await renderMarked(block(`<mo>{</mo>${fraction}<mo>}</mo>`), 10),
	).toEqual(
		["  ⎧_a_⎫", "  ⎩ b ⎭"],
	);
	expect(
		await renderMarked(block(`<mo>∫</mo>${fraction}<mi>dx</mi>`), 12),
	).toEqual(
		["  ⌠", "  ⎮ _a_dx", "  ⌡  b"],
	);
	expect(await renderLines(inline(`<mo>(</mo>${fraction}<mo>)</mo>`))).toEqual([
		"a (a/b) z",
	]);
});

test("large operators stack their limits in display mode", async () => {
	const sum =
		"<munderover><mo>∑</mo><mrow><mi>k</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover>" +
		"<msup><mi>k</mi><mn>2</mn></msup>";
	expect(await renderMarked(block(sum), 12)).toEqual([
		"   _n_",
		"   ╲",
		"   ╱__ k²",
		"   k=1",
	]);
	expect(await renderLines(inline(sum))).toEqual(["a ∑ₖ₌₁ⁿ k² z"]);
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
		"  /  a  \\",
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
	const lines = await renderMarked(
		block(
			"<mtable><mtr><mtd><mfrac><mi>a</mi><mi>b</mi></mfrac></mtd>" +
			"<mtd><mi>x</mi></mtd></mtr></mtable>",
		),
		10,
	);
	expect(lines).toEqual(["  _a_ x", "   b"]);
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

test("an operator's form comes from its position unless form says otherwise", async () => {
	expect(
		await renderLines(inline("<mo form=\"infix\">-</mo><mi>x</mi>")),
	).toEqual(
		["a -x z"],
	);
	expect(
		await renderLines(
			inline("<mi>f</mi><mo>(</mo><mi>x</mi><mo>,</mo><mi>y</mi><mo>)</mo>"),
		),
	).toEqual(["a f(x, y) z"]);
	expect(await renderLines(inline("<mi>a</mi><mo>xor</mo><mi>b</mi>"))).toEqual(
		["a a xor b z"],
	);
});

test("lspace and rspace attributes override the dictionary", async () => {
	expect(
		await renderLines(
			inline("<mi>a</mi><mo lspace=\"0\" rspace=\"0\">+</mo><mi>b</mi>"),
		),
	).toEqual(["a a+b z"]);
	expect(
		await renderLines(
			inline("<mi>a</mi><mo lspace=\"1em\" rspace=\"1em\">×</mo><mi>b</mi>"),
		),
	).toEqual(["a a × b z"]);
});

test("stretchy=false keeps a fence plain and minsize grows one", async () => {
	const fraction = "<mfrac><mi>a</mi><mi>b</mi></mfrac>";
	expect(
		await renderMarked(
			block(
				`<mo stretchy="false">(</mo>${fraction}<mo stretchy="false">)</mo>`,
			),
			10,
		),
	).toEqual(["  (_a_)", "    b"]);
	expect(
		await renderMarked(block("<mo minsize=\"3\">(</mo><mi>x</mi>"), 10),
	).toEqual(
		["    ⎛", "    ⎜x", "    ⎝"],
	);
});

test("border and padding on <math> use the box model", async () => {
	expect(
		await renderLines(
			"<math display=\"block\" style=\"border:1px solid\"><mi>x</mi></math>",
			12,
		),
	).toEqual(["┌──────────┐", "│    x     │", "└──────────┘"]);
	expect(
		await renderLines(
			"<math display=\"block\" style=\"text-align:left;padding-left:2ch\">" +
			"<mi>x</mi><mo>+</mo><mn>1</mn></math>",
			12,
		),
	).toEqual(["  x + 1"]);
});

test("innerText is the one-line form, or the TeX annotation", async () => {
	const {dom} = await render(
		block("<mfrac><mi>a</mi><mi>b</mi></mfrac>") +
		"<math id=\"t\"><semantics><mi>x</mi>" +
		"<annotation encoding=\"application/x-tex\">\\frac{1}{2}</annotation>" +
		"</semantics></math>",
	);
	const [display, tex] = dom.document.querySelectorAll("math");
	expect((display as HTMLElement).innerText).toBe("a/b");
	expect((tex as HTMLElement).innerText).toBe("\\frac{1}{2}");
	dom.dispose();
});

test("--math-variant-glyphs: unicode uses the alphanumeric block", async () => {
	const html =
		"<math display=\"block\" style=\"--math-variant-glyphs: unicode\">" +
		"<mi>x</mi><mi mathvariant=\"bold\">A</mi>" +
		"<mi mathvariant=\"double-struck\">R</mi><mi>sin</mi></math>";
	expect(await renderLines(html, 10)).toEqual(["  𝑥𝐀ℝsin"]);
	expect(await renderANSI(html)).not.toContain("\x1b[3m");
});

test("font-style and font-weight on tokens become SGR", async () => {
	const output = await renderANSI(
		block("<mn style=\"font-style: italic; font-weight: bold\">7</mn>"),
	);
	expect(output).toContain("\x1b[1;3m");
});

const QUADRATIC =
	"<mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi><mo>±</mo>" +
	"<msqrt><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></msqrt>" +
	"</mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac>";
const EULER =
	"<msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup><mo>+</mo><mn>1</mn><mo>=</mo><mn>0</mn>";
const NAVIER_STOKES =
	"<mi>ρ</mi><mo>(</mo><mfrac><mrow><mo>∂</mo><mi>u</mi></mrow><mrow><mo>∂</mo><mi>t</mi></mrow></mfrac>" +
	"<mo>+</mo><mi>u</mi><mo>⋅</mo><mo>∇</mo><mi>u</mi><mo>)</mo><mo>=</mo><mo>−</mo><mo>∇</mo><mi>p</mi>" +
	"<mo>+</mo><mi>μ</mi><msup><mo>∇</mo><mn>2</mn></msup><mi>u</mi><mo>+</mo><mi>f</mi>";
const FOURIER =
	"<mover accent=\"true\"><mi>f</mi><mo>^</mo></mover><mo>(</mo><mi>ξ</mi><mo>)</mo><mo>=</mo>" +
	"<msubsup><mo>∫</mo><mrow><mo>−</mo><mi>∞</mi></mrow><mi>∞</mi></msubsup>" +
	"<mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo>" +
	"<msup><mi>e</mi><mrow><mo>−</mo><mn>2</mn><mi>π</mi><mi>i</mi><mi>x</mi><mi>ξ</mi></mrow></msup>" +
	"<mi>d</mi><mi>x</mi>";

test("golden: the quadratic formula", async () => {
	expect(await renderMarked(block(QUADRATIC))).toEqual([
		"                    ________",
		"          x = -b_±_⎷b²_−_4ac_",
		"                    2a",
	]);
	expect(await renderLines(`<math>${QUADRATIC}</math>`)).toEqual([
		"x = (-b ± √(b² − 4ac))/(2a)",
	]);
});

test("golden: Euler's identity", async () => {
	expect(await renderLines(block(EULER))).toEqual([
		"               iπ",
		"              e   + 1 = 0",
	]);
	expect(
		await renderLines(`<math>${EULER}</math>`),
	).toEqual(["e^(iπ) + 1 = 0"]);
});

test("golden: the Navier-Stokes momentum equation", async () => {
	expect(await renderMarked(block(NAVIER_STOKES))).toEqual([
		"    ρ⎛_∂u_ + u⋅∇u⎞ = -∇p + μ∇²u + f",
		"     ⎝ ∂t        ⎠",
	]);
	expect(await renderLines(`<math>${NAVIER_STOKES}</math>`)).toEqual([
		"ρ((∂u)/(∂t) + u⋅∇u) = -∇p + μ∇²u + f",
	]);
});

test("golden: the Fourier transform", async () => {
	expect(await renderMarked(block(FOURIER))).toEqual([
		"         ⎛ ⎞   ⌠∞   ⎛ ⎞ -2πixξ",
		"        f̂⎜ξ⎟ = ⎮   f⎜x⎟e      dx",
		"         ⎝ ⎠   ⌡-∞  ⎝ ⎠",
	]);
	expect(await renderLines(`<math>${FOURIER}</math>`)).toEqual([
		"f̂(ξ) = ∫_(-∞)^∞ f(x)e^(-2πixξ)dx",
	]);
});

test("getBoundingClientRect reports the math box in cells", async () => {
	const {dom} = await render(inline("<mi>x</mi><mo>+</mo><mi>y</mi>"), 40);
	const rect = dom.document.querySelector("math")!.getBoundingClientRect();
	dom.dispose();
	expect([rect.x, rect.y, rect.width, rect.height]).toEqual([2, 0, 5, 1]);
});

test("a function name takes a thin space before its argument, not its parenthesis", async () => {
	const apply = "<mo>⁡</mo>";
	expect(await renderLines(inline(`<mi>sin</mi>${apply}<mi>x</mi>`))).toEqual([
		"a sin x z",
	]);
	expect(
		await renderLines(
			inline(`<mi>sin</mi>${apply}<mo>(</mo><mi>x</mi><mo>)</mo>`),
		),
	).toEqual(["a sin(x) z"]);
	// KaTeX writes lim as a row ending in function application.
	expect(
		await renderMarked(
			block(
				`<munder><mrow><mi>lim</mi>${apply}</mrow><mi>n</mi></munder>` +
				"<mfrac><mn>1</mn><mi>n</mi></mfrac>",
			),
			12,
		),
	).toEqual(["  lim _1_", "   n   n"]);
});

test("blank mtext is one cell and stands in for an operator's gap", async () => {
	expect(
		await renderLines(
			inline("<mi>x</mi><mtext> </mtext><mo>⟺</mo><mtext> </mtext><mi>y</mi>"),
		),
	).toEqual(["a x ⟺ y z"]);
	expect(
		await renderLines(
			inline("<mi>x</mi><mi>y</mi><mtext> </mtext><mi>d</mi><mi>x</mi>"),
		),
	).toEqual(["a xy dx z"]);
});

test("a large operator keeps its spacing through its scripts, but not inside a fence", async () => {
	expect(
		await renderLines(
			inline(
				"<msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup><mi>x</mi>" +
				"<mo>=</mo><mo>(</mo><mo>∑</mo><mi>k</mi><mo>)</mo>",
			),
		),
	).toEqual(["a ∫₀¹ x = (∑ k) z"]);
	expect(
		await renderMarked(
			block(
				"<mo fence=\"true\">∣</mo><munder><mo>∑</mo><mi>i</mi></munder>" +
				"<mi>a</mi><mo fence=\"true\">∣</mo>",
			),
			12,
		),
	).toEqual(["  │___  │", "  │╲    │", "  │╱__ a│", "  │ i   │"]);
});

test("double-struck letters use the letterlike block without the variant flag", async () => {
	expect(
		await renderLines(
			inline(
				"<mi mathvariant=\"double-struck\">R</mi><mo>,</mo>" +
				"<mi mathvariant=\"double-struck\">x</mi>",
			),
		),
	).toEqual(["a ℝ, x z"]);
});

test("scripts on a tall base take its top and bottom rows", async () => {
	expect(
		await renderMarked(
			block(
				"<msubsup><mrow><mo>(</mo><mfrac><mi>a</mi><mi>b</mi></mfrac><mo>)</mo></mrow>" +
				"<mi>n</mi><mn>2</mn></msubsup>",
			),
			12,
		),
	).toEqual(["   ⎛_a_⎞²", "   ⎝ b ⎠ₙ"]);
});
