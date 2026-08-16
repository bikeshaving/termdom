/**
 * Byte-exact ANSI scenarios.
 *
 * Each scenario is a deterministic sequence of renderer calls whose emitted
 * bytes are recorded in `fixtures/ansi-output.ts`. The recorded strings are
 * the contract: any change to the cell buffer, the diff, or the SGR emitter
 * that alters a single byte fails the fixture test.
 */

import {Screen, type ColorDepth, type CellStyle} from "../src/internal/ansi.js";
import {BorderEdgeStyle} from "../src/internal/styles.js";
import {renderFrame, renderStatic} from "./test-utils.js";

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
	const renderer = new Screen(EVERY_ATTRIBUTE.length + 2, 40, colorDepth);
	return renderFrame(renderer, {offset: 0}, (ctx) => {
		EVERY_ATTRIBUTE.forEach(([label, style], row) => {
			ctx.drawText(label.padEnd(12), 0, row, style);
			ctx.drawText("Sample", 14, row, style);
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
			const renderer = new Screen(4, 40, "rgb");
			return renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("AB", 0, 0, {bold: true, underline: true, fg: 0xff0000});
				ctx.drawText("CD", 2, 0, {underline: true, fg: 0xff0000});
				ctx.drawText("EF", 4, 0, {
					underline: true,
					underlineStyle: "double",
					fg: 0xff0000,
				});
				ctx.drawText("GH", 6, 0, {underline: true, fg: 0xff0000});
				ctx.drawText("IJ", 8, 0, {fg: 0xff0000});
				ctx.drawText("KL", 10, 0, {});
				ctx.drawText("MN", 12, 0, {inverse: true, blink: true, dim: true});
				ctx.drawText("OP", 14, 0, {strikethrough: true, overline: true});
				ctx.drawText("QR", 16, 0, {italic: true, bg: 0x008000});
				ctx.drawText("ST", 18, 0);
			});
		},
	},
	{
		name: "wide characters and combining marks",
		run: () => {
			const renderer = new Screen(8, 30, "rgb");
			return renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("CJK 日本語 end", 0, 0);
				ctx.drawText("emoji 👍🏽 end", 0, 1);
				ctx.drawText("zwj 👨‍👩‍👧‍👦 end", 0, 2);
				ctx.drawText("flag 🇯🇵 end", 0, 3);
				ctx.drawText("combining éxá end", 0, 4);
				ctx.drawText("styled 日本", 0, 5, {fg: 0xff0000, bold: true});
				// A wide glyph at the very last usable column, and one that does
				// not fit at all.
				ctx.drawText("日", 28, 6);
				ctx.drawText("日", 29, 7);
			});
		},
	},
	{
		// The continuation column of a wide glyph is a hole in the buffer; a
		// second frame that overwrites the pair with narrow cells has to fill
		// that hole.
		name: "wide-char boundary rewrite",
		run: () => {
			const renderer = new Screen(4, 20, "rgb");
			let out = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("ab日本cd", 0, 0);
				ctx.drawText("日本日本", 0, 1);
			});
			out += "|";
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("abxycd", 0, 0);
				ctx.drawText("日xy日本", 0, 1);
			});
			out += "|";
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("ab日本cd", 0, 0);
				ctx.drawText("日本日本", 0, 1);
			});
			return out;
		},
	},
	{
		name: "borders, merged and styled",
		run: () => {
			const renderer = new Screen(9, 24, "rgb");
			return renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawBorder({x: 0, y: 0, width: 6, height: 3}, {border: BOX});
				ctx.drawBorder({x: 5, y: 0, width: 6, height: 3}, {border: BOX});
				ctx.drawBorder({x: 0, y: 2, width: 6, height: 3}, {border: BOX});
				ctx.drawBorder({x: 5, y: 2, width: 6, height: 3}, {border: DOUBLE_BOX});
				ctx.drawBorder(
					{x: 12, y: 0, width: 8, height: 5},
					{
						border: BOX,
						style: {fg: 0xff0000, bold: true},
						edges: {
							top: {fg: 0x00ff00},
							right: {fg: 0x0000ff},
							bottom: {fg: 0xffff00},
							left: {fg: 0xff00ff},
						},
					},
				);
				ctx.drawBorder(
					{x: 0, y: 5, width: 10, height: 4},
					{
						border: {
							topEdge: 0,
							rightEdge: 0,
							bottomEdge: 0,
							leftEdge: BorderEdgeStyle.Solid,
							hasAnyBorder: true,
						},
					},
				);
				ctx.drawBorder(
					{x: 12, y: 5, width: 10, height: 4},
					{
						border: {
							topEdge: BorderEdgeStyle.Dashed,
							rightEdge: BorderEdgeStyle.Dotted,
							bottomEdge: BorderEdgeStyle.Groove,
							leftEdge: BorderEdgeStyle.Solid | BorderEdgeStyle.Rounded,
							hasAnyBorder: true,
						},
					},
				);
				ctx.drawText("A1", 1, 1);
				ctx.drawText("B2", 6, 3);
			});
		},
	},
	{
		name: "drawRect backgrounds, default and inverse",
		run: () => {
			const renderer = new Screen(6, 20, "rgb");
			return renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawRect({x: 0, y: 0, width: 20, height: 2}, 0x202020);
				ctx.drawText("selected text", 1, 0);
				ctx.drawRect({x: 1, y: 0, width: 8, height: 1}, "inverse");
				ctx.drawRect({x: 0, y: 3, width: 10, height: 1}, "default");
				ctx.drawRect({x: 0, y: 4, width: 10, height: 1}, null);
				ctx.drawText("under", 0, 5, {fg: 0x00ff00});
			});
		},
	},
	{
		// A style that names no background takes the one already in the cell;
		// one that names its own replaces it. And a cluster led by a combining
		// mark occupies no columns, so the grapheme after it lands in the same
		// cell.
		name: "inherited background and zero-width graphemes",
		run: () => {
			const renderer = new Screen(5, 20, "rgb");
			return renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawRect({x: 0, y: 0, width: 12, height: 1}, 0x004000);
				ctx.drawText("over", 2, 0, {fg: 0xffff00, bold: true});
				ctx.drawRect({x: 0, y: 1, width: 12, height: 1}, 0x400000);
				ctx.drawText("own", 2, 1, {bg: 0x000040});
				ctx.drawText("\u0301abc", 0, 2);
				ctx.drawText("a\u0301bc", 0, 3);
				// Inheritance reads the cell under the write, not the style run.
				ctx.drawText("\u0301x", 0, 4, {italic: true});
			});
		},
	},
	{
		// An axis the element does not clip is +-Infinity, so only the other
		// axis bounds the write.
		name: "clip rect with unbounded axes",
		run: () => {
			const renderer = new Screen(6, 24, "rgb");
			return renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.clipRect = {left: 4, top: -Infinity, right: 12, bottom: Infinity};
				ctx.drawText("horizontally bounded", 0, 0);
				ctx.clipRect = {left: -Infinity, top: 2, right: Infinity, bottom: 4};
				ctx.drawText("dropped by the row clip", 0, 1);
				ctx.drawText("kept by the row clip", 0, 2);
				ctx.clipRect = null;
				ctx.drawText("tail", 0, 5);
			});
		},
	},
	{
		// The resize re-anchor measures the previous frame through the cell
		// widths it recorded, so the number is a property of the buffer.
		name: "wrapped rows above the cursor park",
		run: () => {
			const renderer = new Screen(4, 20, "rgb");
			renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("a short line", 0, 0);
				ctx.drawText("日本語 wide and long", 0, 1);
				ctx.drawText("x", 0, 2);
				ctx.drawText("last", 0, 3);
			});
			const before = [20, 10, 7, 5].map((cols) =>
				renderer.wrappedRowsAbovePark(cols),
			);
			// A caret park moves the measurement point.
			renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("a short line", 0, 0);
				ctx.drawText("日本語 wide and long", 0, 1);
				ctx.drawText("x", 0, 2);
				ctx.drawText("last", 0, 3);
				ctx.setCaret(3, 1);
			});
			const after = [20, 10, 7, 5].map((cols) =>
				renderer.wrappedRowsAbovePark(cols),
			);
			return JSON.stringify({before, after});
		},
	},
	{
		name: "drawDecoration outline over existing cells",
		run: () => {
			const renderer = new Screen(5, 20, "rgb");
			return renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("boxed", 0, 1, {fg: 0xff0000, bold: true});
				ctx.drawDecoration(0, 1, 12, {
					line: "underline",
					style: {fg: 0x5fafff},
				});
				ctx.drawText("over", 0, 3, {italic: true});
				ctx.drawDecoration(0, 3, 12, {
					edge: "overline",
					style: {fg: 0x5fafff, dim: true},
				});
			});
		},
	},
	{
		name: "incremental diff across frames",
		run: () => {
			const renderer = new Screen(6, 24, "rgb");
			let out = renderFrame(renderer, {offset: 0}, (ctx) => {
				for (let row = 0; row < 6; row++) {
					ctx.drawText(`row ${row} content`, 0, row);
				}
			});
			out += "|";
			// One cell changes.
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				for (let row = 0; row < 6; row++) {
					ctx.drawText(
						row === 3 ? "row X content" : `row ${row} content`,
						0,
						row,
					);
				}
			});
			out += "|";
			// Nothing changes.
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				for (let row = 0; row < 6; row++) {
					ctx.drawText(
						row === 3 ? "row X content" : `row ${row} content`,
						0,
						row,
					);
				}
			});
			out += "|";
			// Content shrinks, leaving stale rows to clear.
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("row 0 content", 0, 0);
			});
			return out;
		},
	},
	{
		name: "scroll transform frames",
		run: () => {
			const renderer = new Screen(10, 24, "rgb");
			const paint =
				(top: number) =>
				(ctx: import("../src/internal/ansi.js").DrawingContext) => {
					for (let row = 0; row < 10; row++) {
						ctx.drawText(`line ${top + row}`.padEnd(12), 0, row, {
							fg: (top + row) % 2 === 0 ? 0x00ff00 : undefined,
						});
					}
				};
			let out = renderFrame(
				renderer,
				{offset: 0, cursorRow: 0, regionRows: 10},
				paint(0),
			);
			out += "|";
			out += renderFrame(
				renderer,
				{
					offset: 0,
					cursorRow: 0,
					regionRows: 10,
					scroll: {delta: 3, bands: [[7, 10]]},
				},
				paint(3),
			);
			out += "|";
			out += renderFrame(
				renderer,
				{
					offset: 0,
					cursorRow: 0,
					regionRows: 10,
					scroll: {delta: -2, bands: [[0, 2]]},
				},
				paint(1),
			);
			out += "|";
			// Delta zero: a banded repaint with no terminal scroll.
			out += renderFrame(
				renderer,
				{
					offset: 0,
					cursorRow: 0,
					regionRows: 10,
					scroll: {delta: 0, bands: [[4, 6]]},
				},
				paint(1),
			);
			return out;
		},
	},
	{
		name: "overflowing growth frame then reset",
		run: () => {
			const renderer = new Screen(5, 20, "rgb");
			let out = renderFrame(
				renderer,
				{offset: 0, cursorRow: 0, regionRows: 9},
				(ctx) => {
					for (let row = 0; row < 9; row++) ctx.drawText(`L${row}`, 0, row);
				},
			);
			out += "|";
			renderer.replaced(2);
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("after reset", 0, 0);
			});
			out += "|";
			renderer.repaintAll();
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("after clear", 0, 0);
			});
			return out;
		},
	},
	{
		name: "caret parking",
		run: () => {
			const renderer = new Screen(6, 20, "rgb");
			let out = renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("value", 0, 0);
				ctx.setCaret(5, 0);
			});
			out += "|";
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("value!", 0, 0);
				ctx.setCaret(6, 0);
			});
			out += "|";
			// Caret goes away: the frame still emits, to re-park the cursor.
			out += renderFrame(renderer, {offset: 0}, (ctx) => {
				ctx.drawText("value!", 0, 0);
			});
			return out;
		},
	},
	{
		name: "clipRect and viewport offset",
		run: () => {
			const renderer = new Screen(8, 24, "rgb");
			return renderFrame(renderer, {offset: 2}, (ctx) => {
				ctx.drawText("visible row", 0, 0);
				ctx.clipRect = {left: 2, top: 1, right: 10, bottom: 3};
				ctx.drawText("clipped horizontally", 0, 1);
				ctx.drawText("also clipped", 0, 2);
				ctx.drawText("outside the clip", 0, 3);
				ctx.drawBorder({x: 0, y: 1, width: 14, height: 3}, {border: BOX});
				ctx.clipRect = null;
				ctx.drawText("unclipped again", 0, 4);
			});
		},
	},
	{
		name: "static render to a pipe",
		run: () => {
			const renderer = new Screen(6, 30, "rgb");
			let out = renderStatic(renderer, {rows: 5}, (ctx) => {
				ctx.drawText("plain", 0, 0);
				ctx.drawText("styled", 0, 1, {fg: 0xff0000, bold: true});
				ctx.drawText("日本語 wide", 0, 2);
				ctx.drawBorder(
					{x: 0, y: 3, width: 8, height: 2},
					{border: BOX, style: {fg: 0x00ff00}},
				);
				ctx.drawText("👍 tail", 10, 3);
			});
			out += "|";
			out += renderStatic(renderer, {rows: 2, lineEnding: "\r\n"}, (ctx) => {
				ctx.drawText("crlf", 0, 0);
				ctx.drawText("lines", 0, 1);
			});
			return out;
		},
	},
];
