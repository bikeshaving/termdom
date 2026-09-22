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

// The lines with an underlined blank cell shown as _ and an overlined
// one as ‾: the bars of a drawn sum and a radical are underlines and
// overlines, flush with the strokes.
async function renderMarked(html: string, cols = 40): Promise<string[]> {
	const {dom, terminal} = await render(html, cols);
	const lines = readMarked(terminal);
	dom.dispose();
	return lines;
}

function readMarked(terminal: MockProcess): string[] {
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
			text += chars !== " "
				? chars
				: cell.isUnderline() ? "_" : cell.isOverline() ? "‾" : " ";
		}
		lines.push(text.trimEnd());
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

// The cells of a row the terminal shows overlined.
function overlined(terminal: MockProcess, row: number): string {
	const line = (terminal as any).terminal.buffer.active.getLine(row);
	let text = "";
	for (let x = 0; x < terminal.stdout.columns; x++) {
		const cell = line?.getCell(x);
		if (cell && cell.getWidth() !== 0 && cell.isOverline()) {
			text += cell.getChars() || " ";
		}
	}
	return text;
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

test("a single-letter mi is italic unless mathvariant or text-transform says not", async () => {
	expect(await renderANSI(block("<mi>x</mi>"))).toContain("\x1b[3m");
	expect(
		await renderANSI(block("<mi mathvariant=\"normal\">x</mi>")),
	).not.toContain("\x1b[3m");
	expect(await renderANSI(block("<mi>sin</mi>"))).not.toContain("\x1b[3m");
	expect(
		await renderANSI(block("<mi style=\"text-transform: none\">x</mi>")),
	).not.toContain("\x1b[3m");
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
	const lines = await renderMarked(
		block(
			"<mfrac><mrow><mi>n</mi><mo>(</mo><mi>n</mi><mo>+</mo><mn>1</mn><mo>)</mo></mrow><mn>2</mn></mfrac>",
		),
		20,
	);
	expect(lines).toEqual(["      n(n + 1)", "     ──────────", "         2"]);
});

test("a fraction beside an equals sign shares its baseline with the bar", async () => {
	const lines = await renderMarked(
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

test("a display root stands a stem up from its sign to the bar, index before it", async () => {
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
	).toEqual(["    ___", "   ▕ a", "   ▕───", "   ⎷ b"]);
	expect(
		await renderMarked(block("<mroot><mi>x</mi><mn>3</mn></mroot>"), 10),
	).toEqual(
		["     _", "   ³⎷x"],
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
		["  ⎛ a ⎞", "  ⎜───⎟", "  ⎝ b ⎠"],
	);
	expect(
		await renderMarked(block(`<mo>{</mo>${fraction}<mo>}</mo>`), 10),
	).toEqual(
		["  ⎧ a ⎫", "  ⎨───⎬", "  ⎩ b ⎭"],
	);
	expect(
		await renderMarked(block(`<mo>∫</mo>${fraction}<mi>dx</mi>`), 12),
	).toEqual(
		["  ⌠  a", "  ⎮ ───dx", "  ⌡  b"],
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
		"   ╲   k²",
		"   ╱__",
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
	).toEqual(["    a", "  (───)", "    b"]);
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

test("innerText is the one-line form, and an annotation is no part of it", async () => {
	const {dom} = await render(
		block("<mfrac><mi>a</mi><mi>b</mi></mfrac>") +
		"<math id=\"t\"><semantics><mi>x</mi>" +
		"<annotation encoding=\"application/x-tex\">\\frac{1}{2}</annotation>" +
		"</semantics></math>",
	);
	const [display, tex] = dom.document.querySelectorAll("math");
	expect((display as HTMLElement).innerText).toBe("a/b");
	expect((tex as HTMLElement).innerText).toBe("x");
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
		"              -b ± ⎷b² − 4ac",
		"          x = ───────────────",
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
		"     ⎛ ∂u        ⎞",
		"    ρ⎜──── + u⋅∇u⎟ = -∇p + μ∇²u + f",
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
	).toEqual(["       1", "  lim ───", "   n   n"]);
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
	).toEqual(["  │___  │", "  │╲   a│", "  │╱__  │", "  │ i   │"]);
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
	).toEqual(["   ⎛ a ⎞²", "   ⎜───⎟", "   ⎝ b ⎠ₙ"]);
});

test("a column lines up its operands under a hanging negation sign", async () => {
	expect(
		await renderLines(
			block(
				"<mtable><mtr><mtd><mo>−</mo><mi>sin</mi></mtd><mtd><mn>1</mn></mtd></mtr>" +
				"<mtr><mtd><mi>cos</mi></mtd><mtd><mo>−</mo><mn>10</mn></mtd></mtr></mtable>",
			),
			12,
		),
	).toEqual(["  -sin  1", "   cos -10"]);
});

test("bars become overlines once the terminal reports SGR 53 through DECRQSS", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const output = captureRawOutput(terminal);
	// The mock terminal answers DECRQSS with a style that leaves 53 out.
	// A terminal that draws overlines keeps it in.
	const stdin =
		terminal.stdin as unknown as {emit(event: string, data: Buffer): boolean};
	const emit = stdin.emit.bind(stdin);
	let answered = false;
	stdin.emit = (event: string, data: Buffer) => {
		const text = data.toString();
		if (event === "data" && text.includes("\x1bP1$r0m\x1b\\")) {
			answered = true;
			return emit(
				event,
				Buffer.from(text.replace("\x1bP1$r0m\x1b\\", "\x1bP1$r0;53m\x1b\\")),
			);
		}
		return emit(event, data);
	};
	const dom = new TermDOM({transport: terminal.transport});
	const sum =
		"<munderover><mo>∑</mo><mi>i</mi><mi>n</mi></munderover><mi>a</mi>";
	dom.document.body.innerHTML =
		block("<msqrt><mi>x</mi><mo>+</mo><mn>1</mn></msqrt>") + block(sum);
	await nextFrame(dom);
	// The probe sets the attribute, asks for the style, and resets it.
	expect(output()).toContain("\x1b[53m\x1bP$qm\x1b\\\x1b[55m");
	expect(answered).toBe(true);
	await nextFrame(dom);
	// The radical needs no row for its bar, and the sum none for its
	// top bar, which its first stroke carries.
	expect(readMarked(terminal)).toEqual([
		"            ⎷x‾+‾1",
		"             n",
		"            ╲‾‾ a",
		"            ╱__",
		"             i",
	]);
	expect(overlined(terminal, 0)).toBe("x + 1");
	expect(overlined(terminal, 2)).toBe("╲  ");
	dom.dispose();
});

function send(terminal: MockProcess, data: string): Promise<void> {
	(terminal.stdin as unknown as {emit(e: string, d: Buffer): void}).emit(
		"data",
		Buffer.from(data),
	);
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("a drag inside display math selects the text its cells render", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		block("<mfrac><mi>a</mi><mi>b</mi></mfrac><mo>=</mo><mi>c</mi>");
	await nextFrame(dom);
	const [a, , c] = dom.document.querySelectorAll("mi");
	const from = a.getBoundingClientRect();
	const to = c.getBoundingClientRect();
	// From the a cell to just past the c cell. Print and the rest of the
	// engine take the offset before the cell the pointer is on, so the
	// last character comes in from the cell after it.
	await send(terminal, `\x1b[<0;${from.x + 1};${from.y + 1}M`);
	await send(terminal, `\x1b[<32;${to.x + 2};${to.y + 1}M`);
	await send(terminal, `\x1b[<0;${to.x + 2};${to.y + 1}m`);
	await nextFrame(dom);
	// Range.toString: the text nodes' data in order, as the DOM has it.
	expect(dom.window.getSelection()!.toString()).toBe("ab=c");
	// The cells of the selected text paint with ::selection, the bar and
	// the blank cells of the fraction do not.
	const buffer = (terminal as any).terminal.buffer.active;
	const inverse = (x: number, y: number): boolean =>
		!!buffer.getLine(y).getCell(x).isInverse();
	expect(inverse(from.x, from.y)).toBe(true);
	expect(inverse(from.x, from.y + 2)).toBe(true);
	expect(inverse(to.x, to.y)).toBe(true);
	expect(inverse(from.x + 1, from.y)).toBe(false);
	dom.dispose();
});

test("a token inside math has the rect of its cells", async () => {
	const {dom, lines} = await render(
		block("<mfrac><mi>x</mi><mn>10</mn></mfrac>"),
		20,
	);
	const row = lines[2];
	const column = row.indexOf("10");
	const rect = dom.document.querySelector("mn")!.getBoundingClientRect();
	expect([rect.x, rect.y, rect.width, rect.height]).toEqual([column, 2, 2, 1]);
	const fraction = dom.document.querySelector("mfrac")!.getBoundingClientRect();
	expect([fraction.y, fraction.height]).toEqual([0, 3]);
	dom.dispose();
});

test("a drag over a drawn stroke takes the nearest text", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = block("<msqrt><mi>x</mi></msqrt>");
	await nextFrame(dom);
	const {x, y} = dom.document.querySelector("mi")!.getBoundingClientRect();
	const drag =
		async (fromX: number, fromY: number, toX: number, toY: number) => {
			await send(terminal, `\x1b[<0;${fromX + 1};${fromY + 1}M`);
			await send(terminal, `\x1b[<32;${toX + 1};${toY + 1}M`);
			await send(terminal, `\x1b[<0;${toX + 1};${toY + 1}m`);
			await nextFrame(dom);
			return dom.window.getSelection()!.toString();
		};
	// From the radical sign, left of x, to the cell right of it.
	expect(await drag(x - 1, y, x + 1, y)).toBe("x");
	// From the bar row above x, whose nearest text is x, to right of it.
	expect(await drag(x, y - 1, x + 1, y)).toBe("x");
	dom.dispose();
});

test("a product in display mode is its bar and its legs", async () => {
	const product =
		"<munderover><mo>∏</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover>" +
		"<mi>i</mi>";
	expect(await renderLines(block(product), 12)).toEqual([
		"    n",
		"   ┬─┬",
		"   │ │ i",
		"   i=1",
	]);
});

test("a labelled arrow reaches across its label and to its minsize", async () => {
	expect(
		await renderLines(
			block(
				"<mi>A</mi><mover><mo stretchy=\"true\" minsize=\"3em\">→</mo>" +
				"<mpadded width=\"+0.6em\" lspace=\"0.3em\"><mi>f</mi></mpadded></mover><mi>B</mi>",
			),
			12,
		),
	).toEqual(["     f", "  A ──→ B"]);
	expect(
		await renderLines(
			block(
				"<mover><mo stretchy=\"true\">→</mo><mrow><mi>map</mi><mi>ping</mi></mrow></mover>",
			),
			12,
		),
	).toEqual(["  mapping", "  ──────→"]);
});

test("multiple and contour integrals are columns of the integral's pieces", async () => {
	expect(
		await renderLines(block("<msub><mo>∬</mo><mi>S</mi></msub><mi>f</mi>"), 12),
	).toEqual(["   ⌠⌠", "   ⎮⎮  f", "   ⌡⌡S"]);
	expect(
		await renderLines(block("<msub><mo>∮</mo><mi>C</mi></msub><mi>g</mi>"), 12),
	).toEqual(["    ⌠", "    ⌽  g", "    ⌡C"]);
});

test("a bar over or under a wide base is a line on its edge", async () => {
	expect(
		await renderMarked(
			block(
				"<mover accent=\"true\"><mrow><mi>A</mi><mi>B</mi></mrow><mo stretchy=\"true\">‾</mo></mover>" +
				"<mo>+</mo>" +
				"<munder accentunder=\"true\"><mrow><mi>a</mi><mi>b</mi><mi>c</mi></mrow><mo stretchy=\"true\">‾</mo></munder>",
			),
			14,
		),
	).toEqual(["   __", "   AB + abc"]);
	const {dom, terminal} = await render(
		block(
			"<munder accentunder=\"true\"><mrow><mi>a</mi><mi>b</mi><mi>c</mi></mrow><mo stretchy=\"true\">‾</mo></munder>",
		),
		10,
	);
	const buffer = (terminal as any).terminal.buffer.active;
	const row = terminal.getVisibleText().split("\n")[0];
	const column = row.indexOf("abc");
	expect(buffer.getLine(0).getCell(column).isUnderline()).toBeTruthy();
	expect(buffer.getLine(0).getCell(column + 2).isUnderline()).toBeTruthy();
	dom.dispose();
});

test("the ascii glyph set draws bar accents as characters, never attributes", async () => {
	const html =
		"<math display=\"block\" style=\"--math-glyphs: ascii\">" +
		"<mover accent=\"true\"><mrow><mi>A</mi><mi>B</mi></mrow><mo stretchy=\"true\">‾</mo></mover>" +
		"<mo>+</mo>" +
		"<munder accentunder=\"true\"><mrow><mi>a</mi><mi>b</mi><mi>c</mi></mrow><mo stretchy=\"true\">‾</mo></munder>" +
		"</math>";
	expect(await renderMarked(html, 14)).toEqual([
		"   --",
		"   AB + abc",
		"        ---",
	]);
	expect(await renderANSI(html)).not.toContain("\x1b[4m");
});
