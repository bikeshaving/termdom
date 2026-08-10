/**
 * Byte-exact ANSI scenarios.
 *
 * Each scenario is a deterministic sequence of renderer calls whose emitted
 * bytes are recorded in `fixtures/ansi-output.ts`. The recorded strings are
 * the contract: any change to the cell buffer, the diff, or the SGR emitter
 * that alters a single byte fails the fixture test.
 */

import {
	Renderer,
	type ColorDepth,
	type CellStyle,
} from "../src/internal/ansi.js";
import {BorderEdgeStyle} from "../src/internal/styles.js";

export interface Scenario {
	name: string;
	run(): string;
}

const BOX = {
	topEdge: BorderEdgeStyle.Solid,
	rightEdge: BorderEdgeStyle.Solid,
	bottomEdge: BorderEdgeStyle.Solid,
	leftEdge: BorderEdgeStyle.Solid,
	hasAnyBorder: true,
};

const DOUBLE_BOX = {
	topEdge: BorderEdgeStyle.Double,
	rightEdge: BorderEdgeStyle.Double,
	bottomEdge: BorderEdgeStyle.Double,
	leftEdge: BorderEdgeStyle.Double,
	hasAnyBorder: true,
};

/** Every per-cell attribute the model carries, one cell each. */
const EVERY_ATTRIBUTE: Array<[string, CellStyle]> = [
	["plain", {}],
	["fg", {fg: 0x00afff}],
	["bg", {bg: 0x5f0000}],
	["both", {fg: 0xffffff, bg: 0x000080}],
	["bold", {bold: true}],
	["dim", {dim: true}],
	["italic", {italic: true}],
	["underline", {underline: true}],
	["double", {underline: true, underlineStyle: "double"}],
	["blink", {blink: true}],
	["inverse", {inverse: true}],
	["strike", {strikethrough: true}],
	["overline", {overline: true}],
	[
		"everything",
		{
			fg: 0xff8700,
			bg: 0x005f5f,
			bold: true,
			dim: true,
			italic: true,
			underline: true,
			underlineStyle: "double",
			blink: true,
			inverse: true,
			strikethrough: true,
			overline: true,
		},
	],
];

function attributeSweep(colorDepth: ColorDepth): string {
	const renderer = new Renderer(EVERY_ATTRIBUTE.length + 2, 40, colorDepth);
	return renderer.renderFrame(0, (ctx) => {
		EVERY_ATTRIBUTE.forEach(([label, style], row) => {
			ctx.setText(0, row, label.padEnd(12), style);
			ctx.setText(14, row, "Sample", style);
		});
	});
}

export const scenarios: Scenario[] = [
	{
		name: "attribute sweep, rgb",
		run: () => attributeSweep("rgb"),
	},
	{
		name: "attribute sweep, 256",
		run: () => attributeSweep("256"),
	},
	{
		name: "attribute sweep, ansi",
		run: () => attributeSweep("ansi"),
	},
	{
		// A style run that turns attributes off one at a time exercises every
		// reset code in the SGR delta, which the sweep above (all-on rows
		// separated by a row reset) never reaches.
		name: "SGR delta across adjacent cells",
		run: () => {
			const renderer = new Renderer(4, 40, "rgb");
			return renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "AB", {bold: true, underline: true, fg: 0xff0000});
				ctx.setText(2, 0, "CD", {underline: true, fg: 0xff0000});
				ctx.setText(4, 0, "EF", {
					underline: true,
					underlineStyle: "double",
					fg: 0xff0000,
				});
				ctx.setText(6, 0, "GH", {underline: true, fg: 0xff0000});
				ctx.setText(8, 0, "IJ", {fg: 0xff0000});
				ctx.setText(10, 0, "KL", {});
				ctx.setText(12, 0, "MN", {inverse: true, blink: true, dim: true});
				ctx.setText(14, 0, "OP", {strikethrough: true, overline: true});
				ctx.setText(16, 0, "QR", {italic: true, bg: 0x008000});
				ctx.setText(18, 0, "ST");
			});
		},
	},
	{
		name: "wide characters and combining marks",
		run: () => {
			const renderer = new Renderer(8, 30, "rgb");
			return renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "CJK 日本語 end");
				ctx.setText(0, 1, "emoji 👍🏽 end");
				ctx.setText(0, 2, "zwj 👨‍👩‍👧‍👦 end");
				ctx.setText(0, 3, "flag 🇯🇵 end");
				ctx.setText(0, 4, "combining éxá end");
				ctx.setText(0, 5, "styled 日本", {fg: 0xff0000, bold: true});
				// A wide glyph at the very last usable column, and one that does
				// not fit at all.
				ctx.setText(28, 6, "日");
				ctx.setText(29, 7, "日");
			});
		},
	},
	{
		// The continuation column of a wide glyph is a hole in the buffer; a
		// second frame that overwrites the pair with narrow cells has to fill
		// that hole.
		name: "wide-char boundary rewrite",
		run: () => {
			const renderer = new Renderer(4, 20, "rgb");
			let out = renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "ab日本cd");
				ctx.setText(0, 1, "日本日本");
			});
			out += "|";
			out += renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "abxycd");
				ctx.setText(0, 1, "日xy日本");
			});
			out += "|";
			out += renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "ab日本cd");
				ctx.setText(0, 1, "日本日本");
			});
			return out;
		},
	},
	{
		name: "borders, merged and styled",
		run: () => {
			const renderer = new Renderer(9, 24, "rgb");
			return renderer.renderFrame(0, (ctx) => {
				ctx.drawBorder(0, 0, 6, 3, BOX);
				ctx.drawBorder(5, 0, 6, 3, BOX);
				ctx.drawBorder(0, 2, 6, 3, BOX);
				ctx.drawBorder(5, 2, 6, 3, DOUBLE_BOX);
				ctx.drawBorder(
					12,
					0,
					8,
					5,
					BOX,
					{fg: 0xff0000, bold: true},
					{
						top: {fg: 0x00ff00},
						right: {fg: 0x0000ff},
						bottom: {fg: 0xffff00},
						left: {fg: 0xff00ff},
					},
				);
				ctx.drawBorder(0, 5, 10, 4, {
					topEdge: 0,
					rightEdge: 0,
					bottomEdge: 0,
					leftEdge: BorderEdgeStyle.Solid,
					hasAnyBorder: true,
				});
				ctx.drawBorder(12, 5, 10, 4, {
					topEdge: BorderEdgeStyle.Dashed,
					rightEdge: BorderEdgeStyle.Dotted,
					bottomEdge: BorderEdgeStyle.Groove,
					leftEdge: BorderEdgeStyle.Solid | BorderEdgeStyle.Rounded,
					hasAnyBorder: true,
				});
				ctx.setText(1, 1, "A1");
				ctx.setText(6, 3, "B2");
			});
		},
	},
	{
		name: "fillRect backgrounds, default and inverse",
		run: () => {
			const renderer = new Renderer(6, 20, "rgb");
			return renderer.renderFrame(0, (ctx) => {
				ctx.fillRect(0, 0, 20, 2, 0x202020);
				ctx.setText(1, 0, "selected text");
				ctx.fillRect(1, 0, 8, 1, "inverse");
				ctx.fillRect(0, 3, 10, 1, "default");
				ctx.fillRect(0, 4, 10, 1, null);
				ctx.setText(0, 5, "under", {fg: 0x00ff00});
			});
		},
	},
	{
		name: "edgeRow outline over existing cells",
		run: () => {
			const renderer = new Renderer(5, 20, "rgb");
			return renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 1, "boxed", {fg: 0xff0000, bold: true});
				ctx.edgeRow(0, 1, 12, "underline", {fg: 0x5fafff});
				ctx.setText(0, 3, "over", {italic: true});
				ctx.edgeRow(0, 3, 12, "overline", {fg: 0x5fafff, dim: true});
			});
		},
	},
	{
		name: "incremental diff across frames",
		run: () => {
			const renderer = new Renderer(6, 24, "rgb");
			let out = renderer.renderFrame(0, (ctx) => {
				for (let row = 0; row < 6; row++) {
					ctx.setText(0, row, `row ${row} content`);
				}
			});
			out += "|";
			// One cell changes.
			out += renderer.renderFrame(0, (ctx) => {
				for (let row = 0; row < 6; row++) {
					ctx.setText(
						0,
						row,
						row === 3 ? "row X content" : `row ${row} content`,
					);
				}
			});
			out += "|";
			// Nothing changes.
			out += renderer.renderFrame(0, (ctx) => {
				for (let row = 0; row < 6; row++) {
					ctx.setText(
						0,
						row,
						row === 3 ? "row X content" : `row ${row} content`,
					);
				}
			});
			out += "|";
			// Content shrinks, leaving stale rows to clear.
			out += renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "row 0 content");
			});
			return out;
		},
	},
	{
		name: "scroll transform frames",
		run: () => {
			const renderer = new Renderer(10, 24, "rgb");
			const paint =
				(top: number) =>
				(ctx: import("../src/internal/ansi.js").DrawingContext) => {
					for (let row = 0; row < 10; row++) {
						ctx.setText(0, row, `line ${top + row}`.padEnd(12), {
							fg: (top + row) % 2 === 0 ? 0x00ff00 : undefined,
						});
					}
				};
			let out = renderer.renderFrame(0, paint(0), 0, 10);
			out += "|";
			out += renderer.renderFrame(0, paint(3), 0, 10, {
				delta: 3,
				bands: [[7, 10]],
			});
			out += "|";
			out += renderer.renderFrame(0, paint(1), 0, 10, {
				delta: -2,
				bands: [[0, 2]],
			});
			out += "|";
			// Delta zero: a banded repaint with no terminal scroll.
			out += renderer.renderFrame(0, paint(1), 0, 10, {
				delta: 0,
				bands: [[4, 6]],
			});
			return out;
		},
	},
	{
		name: "overflowing growth frame then reset",
		run: () => {
			const renderer = new Renderer(5, 20, "rgb");
			let out = renderer.renderFrame(
				0,
				(ctx) => {
					for (let row = 0; row < 9; row++) ctx.setText(0, row, `L${row}`);
				},
				0,
				9,
			);
			out += "|";
			renderer.resetScreen(2);
			out += renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "after reset");
			});
			out += "|";
			renderer.clearPreviousBuffer();
			out += renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "after clear");
			});
			return out;
		},
	},
	{
		name: "caret parking",
		run: () => {
			const renderer = new Renderer(6, 20, "rgb");
			let out = renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "value");
				ctx.setCaret(5, 0);
			});
			out += "|";
			out += renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "value!");
				ctx.setCaret(6, 0);
			});
			out += "|";
			// Caret goes away: the frame still emits, to re-park the cursor.
			out += renderer.renderFrame(0, (ctx) => {
				ctx.setText(0, 0, "value!");
			});
			return out;
		},
	},
	{
		name: "clipRect and viewport offset",
		run: () => {
			const renderer = new Renderer(8, 24, "rgb");
			return renderer.renderFrame(2, (ctx) => {
				ctx.setText(0, 0, "visible row");
				ctx.clipRect = {left: 2, top: 1, right: 10, bottom: 3};
				ctx.setText(0, 1, "clipped horizontally");
				ctx.setText(0, 2, "also clipped");
				ctx.setText(0, 3, "outside the clip");
				ctx.drawBorder(0, 1, 14, 3, BOX);
				ctx.clipRect = null;
				ctx.setText(0, 4, "unclipped again");
			});
		},
	},
	{
		name: "static render to a pipe",
		run: () => {
			const renderer = new Renderer(6, 30, "rgb");
			let out = renderer.renderStatic(5, (ctx) => {
				ctx.setText(0, 0, "plain");
				ctx.setText(0, 1, "styled", {fg: 0xff0000, bold: true});
				ctx.setText(0, 2, "日本語 wide");
				ctx.drawBorder(0, 3, 8, 2, BOX, {fg: 0x00ff00});
				ctx.setText(10, 3, "👍 tail");
			});
			out += "|";
			out += renderer.renderStatic(
				2,
				(ctx) => {
					ctx.setText(0, 0, "crlf");
					ctx.setText(0, 1, "lines");
				},
				"\r\n",
			);
			return out;
		},
	},
];
