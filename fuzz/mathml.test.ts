/**
 * Properties of the math box every MathML tree must lay out to, driven by
 * fast-check over random trees of tokens, rows, fractions, scripts, roots,
 * limits and tables:
 *
 *   - the baseline is a row of the box;
 *   - every row is exactly the box's width, cell widths summed;
 *   - every cell measures the width it was laid out at;
 *   - inline mode is one row;
 *   - the ASCII glyph set never emits a code point above U+007F;
 *   - beside is associative, and stacking an empty box changes nothing.
 *
 * `FC_NUM_RUNS=200` widens the search, `FC_SEED=...` replays one.
 */
import {expect, test} from "@b9g/libuild/test";
import fc from "fast-check";

import {TermDOM} from "../src/index.ts";
import {
	beside,
	createTextBox,
	getBoxText,
	layoutMath,
	type MathBox,
	stack,
} from "../src/internal/mathml.ts";
import {getStringWidth} from "../src/internal/text.ts";
import {MockProcess, nextFrame} from "../tests/test-utils.ts";

const RUNS = Number(process.env.FC_NUM_RUNS ?? 20);
const SEED = Number(process.env.FC_SEED ?? 1);

const token = fc.oneof(
	fc.constantFrom("x", "y", "ab", "α", "∞", "lim").map((t) => `<mi>${t}</mi>`),
	fc.constantFrom("1", "23", "0.5").map((t) => `<mn>${t}</mn>`),
	fc
		.constantFrom(
			"+",
			"=",
			"(",
			")",
			"−",
			"×",
			"∑",
			"∫",
			",",
			"!",
			"{",
			"}",
			"|",
		)
		.map((t) => `<mo>${t}</mo>`),
	fc.constant("<mtext>if</mtext>"),
	fc.constant("<mspace width=\"2em\"></mspace>"),
	fc.constant("<ms>s</ms>"),
);

const tree = fc.letrec<{node: string}>((tie) => ({
	node: fc.oneof({depthSize: "small", maxDepth: 3}, token, fc
		.array(tie("node"), {maxLength: 4})
		.map((children) => `<mrow>${children.join("")}</mrow>`), fc
		.tuple(tie("node"), tie("node"))
		.map(([a, b]) => `<mfrac>${a}${b}</mfrac>`), fc
		.tuple(fc.constantFrom("msup", "msub"), tie("node"), tie("node"))
		.map(([name, a, b]) => `<${name}>${a}${b}</${name}>`), fc
		.tuple(tie("node"), tie("node"), tie("node"))
		.map(([a, b, c]) => `<msubsup>${a}${b}${c}</msubsup>`), tie("node").map(
		(a) => `<msqrt>${a}</msqrt>`,
	), fc
		.tuple(tie("node"), tie("node"))
		.map(([a, b]) => `<mroot>${a}${b}</mroot>`), fc
		.tuple(fc.constantFrom("munder", "mover"), tie("node"), tie("node"))
		.map(([name, a, b]) => `<${name}>${a}${b}</${name}>`), fc
		.tuple(tie("node"), tie("node"), tie("node"))
		.map(([a, b, c]) => `<munderover>${a}${b}${c}</munderover>`), fc
		.array(fc.array(tie("node"), {maxLength: 3}), {maxLength: 3})
		.map(
			(rows) =>
				"<mtable frame=\"solid\" columnlines=\"solid\">" +
					rows
						.map((cells) =>
							`<mtr>${cells.map((c) => `<mtd>${c}</mtd>`).join("")}</mtr>`,
						)
						.join("") +
					"</mtable>",
		), tie("node").map((a) =>
		`<mpadded width="+1em" lspace="1em">${a}</mpadded>`,
	), tie("node").map((a) => `<mphantom>${a}</mphantom>`), tie("node").map((a) =>
		`<merror>${a}</merror>`,
	)),
}));

function checkBox(box: MathBox, ascii: boolean): void {
	expect(box.height).toBeGreaterThanOrEqual(1);
	expect(box.baseline).toBeGreaterThanOrEqual(0);
	expect(box.baseline).toBeLessThan(box.height);
	expect(box.cells.length).toBe(box.height);
	for (const row of box.cells) {
		let width = 0;
		for (const cell of row) {
			expect(getStringWidth(cell.text)).toBe(cell.width);
			width += cell.width;
			if (ascii) {
				for (const char of cell.text) {
					expect(char.codePointAt(0)!).toBeLessThanOrEqual(0x7f);
				}
			}
		}
		expect(width).toBe(box.width);
	}
}

test("every random MathML tree lays out to a well-formed box", async () => {
	await fc.assert(fc.asyncProperty(tree.node, async (markup) => {
		const terminal = new MockProcess({cols: 80, rows: 24});
		const dom = new TermDOM({transport: terminal.transport});
		try {
			dom.document.body.innerHTML =
					`<math display="block" id="d">${markup}</math>` +
					`<p><math id="i">${markup}</math></p>` +
					`<math display="block" id="a" style="--math-glyphs: ascii">${markup}</math>`;
			await nextFrame(dom);
			const display = dom.document.getElementById("d")!;
			const inline = dom.document.getElementById("i")!;
			const ascii = dom.document.getElementById("a")!;
			checkBox(layoutMath(display, true), false);
			const one = layoutMath(inline, false);
			checkBox(one, false);
			expect(one.height).toBe(1);
			checkBox(layoutMath(ascii, true), true);
			checkBox(layoutMath(ascii, false), true);
		} finally {
			dom.dispose();
		}
	}), {numRuns: RUNS, seed: SEED});
});

const box = fc
	.tuple(
		fc.stringMatching(/^[a-z0-9+=]{1,4}$/),
		fc.integer({min: 1, max: 3}),
		fc.integer({min: 0, max: 2}),
	)
	.map(([text, height, baseline]) => {
		let built = createTextBox(text, null);
		for (let row = 1; row < height; row++) {
			built = stack(built, createTextBox(text, null), "left", 0);
		}
		return {...built, baseline: Math.min(baseline, height - 1)};
	});

test("beside is associative", () => {
	fc.assert(fc.property(box, box, box, (a, b, c) => {
		const left = beside(beside(a, b), c);
		const right = beside(a, beside(b, c));
		expect(getBoxText(left)).toEqual(getBoxText(right));
		expect(left.baseline).toBe(right.baseline);
	}), {numRuns: 100, seed: SEED});
});

test("stacking an empty box is the identity", () => {
	const empty: MathBox = {width: 0, height: 0, baseline: 0, cells: []};
	fc.assert(fc.property(box, (a) => {
		expect(getBoxText(stack(a, empty, "left", a.baseline))).toEqual(
			getBoxText(a),
		);
		expect(getBoxText(stack(empty, a, "left", a.baseline))).toEqual(
			getBoxText(a),
		);
	}), {numRuns: 100, seed: SEED});
});
