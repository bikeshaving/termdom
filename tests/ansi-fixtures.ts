/**
 * Byte-exact ANSI scenarios.
 *
 * Each scenario is a deterministic sequence of framebuffer calls whose emitted
 * bytes are recorded in `fixtures/ansi-output.ts`. The recorded strings are
 * the contract: any change to the cell buffer, the diff, or the SGR emitter
 * that alters a single byte fails the fixture test.
 */
import type {ColorDepth} from "../src/internal/exchange.ts";
import {
	type CellContext,
	type CellStyle,
	drawBox,
	drawDecoration,
	drawRect,
	drawText,
	Framebuffer,
	repaintAll,
	replaced,
	setCaret,
	wrappedRowsAbovePark,
} from "../src/internal/framebuffer.ts";
import {renderFrame, renderStatic} from "./test-utils.js";

export interface Scenario {
	name: string;
	run(): string;
}

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
	const framebuffer = new Framebuffer(
		EVERY_ATTRIBUTE.length + 2,
		40,
		colorDepth,
	);
	return renderFrame(framebuffer, {offset: 0}, (ctx) => {
		EVERY_ATTRIBUTE.forEach(([label, style], row) => {
			drawText(ctx, label.padEnd(12), 0, row, style);
			drawText(ctx, "Sample", 14, row, style);
		});
	});
}

export const scenarios: Scenario[] = [
	{name: "attribute sweep, rgb", run: () => attributeSweep("rgb")},
	{name: "attribute sweep, 256", run: () => attributeSweep("256")},
	{name: "attribute sweep, ansi", run: () => attributeSweep("ansi")},
	{
		// A style run that turns attributes off one at a time exercises every
		// reset code in the SGR delta, which the sweep above (all-on rows
		// separated by a row reset) never reaches.
		name: "SGR delta across adjacent cells",
		run: (): string => {
			const framebuffer = new Framebuffer(4, 40, "rgb");
			return renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "AB", 0, 0, {bold: true, underline: true, fg: 0xff0000});
				drawText(ctx, "CD", 2, 0, {underline: true, fg: 0xff0000});
				drawText(ctx, "EF", 4, 0, {
					underline: true,
					underlineStyle: "double",
					fg: 0xff0000,
				});
				drawText(ctx, "GH", 6, 0, {underline: true, fg: 0xff0000});
				drawText(ctx, "IJ", 8, 0, {fg: 0xff0000});
				drawText(ctx, "KL", 10, 0, {});
				drawText(ctx, "MN", 12, 0, {inverse: true, blink: true, dim: true});
				drawText(ctx, "OP", 14, 0, {strikethrough: true, overline: true});
				drawText(ctx, "QR", 16, 0, {italic: true, bg: 0x008000});
				drawText(ctx, "ST", 18, 0);
			});
		},
	},
	{
		name: "wide characters and combining marks",
		run: (): string => {
			const framebuffer = new Framebuffer(8, 30, "rgb");
			return renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "CJK 日本語 end", 0, 0);
				drawText(ctx, "emoji 👍🏽 end", 0, 1);
				drawText(ctx, "zwj 👨‍👩‍👧‍👦 end", 0, 2);
				drawText(ctx, "flag 🇯🇵 end", 0, 3);
				drawText(ctx, "combining éxá end", 0, 4);
				drawText(ctx, "styled 日本", 0, 5, {fg: 0xff0000, bold: true});
				// A wide glyph at the very last usable column, and one that does
				// not fit at all.
				drawText(ctx, "日", 28, 6);
				drawText(ctx, "日", 29, 7);
			});
		},
	},
	{
		// The continuation column of a wide glyph is a hole in the buffer; a
		// second frame that overwrites the pair with narrow cells has to fill
		// that hole.
		name: "wide-char boundary rewrite",
		run: (): string => {
			const framebuffer = new Framebuffer(4, 20, "rgb");
			let out = renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "ab日本cd", 0, 0);
				drawText(ctx, "日本日本", 0, 1);
			});
			out += "|";
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "abxycd", 0, 0);
				drawText(ctx, "日xy日本", 0, 1);
			});
			out += "|";
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "ab日本cd", 0, 0);
				drawText(ctx, "日本日本", 0, 1);
			});
			return out;
		},
	},
	{
		name: "borders, merged and styled",
		run: (): string => {
			const framebuffer = new Framebuffer(9, 24, "rgb");
			return renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawBox(ctx, 0, 0, 6, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
				drawBox(ctx, 5, 0, 6, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
				drawBox(ctx, 0, 2, 6, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
				drawBox(ctx, 5, 2, 6, 3, {
					top: {style: "double"},
					right: {style: "double"},
					bottom: {style: "double"},
					left: {style: "double"},
				});
				drawBox(ctx, 12, 0, 8, 5, {
					top: {style: "solid", color: 0x00ff00},
					right: {style: "solid", color: 0x0000ff},
					bottom: {style: "solid", color: 0xffff00},
					left: {style: "solid", color: 0xff00ff},
				});
				drawBox(ctx, 0, 5, 10, 4, {left: {style: "solid"}});
				drawBox(ctx, 12, 5, 10, 4, {
					top: {style: "dashed"},
					right: {style: "dotted"},
					bottom: {style: "groove"},
					left: {style: "solid"},
					topLeft: "round",
					bottomLeft: "round",
				});
				drawText(ctx, "A1", 1, 1);
				drawText(ctx, "B2", 6, 3);
			});
		},
	},
	{
		name: "drawRect backgrounds, default and inverse",
		run: (): string => {
			const framebuffer = new Framebuffer(6, 20, "rgb");
			return renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawRect(ctx, 0, 0, 20, 2, 0x202020);
				drawText(ctx, "selected text", 1, 0);
				drawRect(ctx, 1, 0, 8, 1, "inverse");
				drawRect(ctx, 0, 3, 10, 1, "default");
				drawRect(ctx, 0, 4, 10, 1, null);
				drawText(ctx, "under", 0, 5, {fg: 0x00ff00});
			});
		},
	},
	{
		// A style that names no background takes the one already in the cell;
		// one that names its own replaces it. And a cluster led by a combining
		// mark occupies no columns, so the grapheme after it lands in the same
		// cell.
		name: "inherited background and zero-width graphemes",
		run: (): string => {
			const framebuffer = new Framebuffer(5, 20, "rgb");
			return renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawRect(ctx, 0, 0, 12, 1, 0x004000);
				drawText(ctx, "over", 2, 0, {fg: 0xffff00, bold: true});
				drawRect(ctx, 0, 1, 12, 1, 0x400000);
				drawText(ctx, "own", 2, 1, {bg: 0x000040});
				drawText(ctx, "\u0301abc", 0, 2);
				drawText(ctx, "a\u0301bc", 0, 3);
				// Inheritance reads the cell under the write, not the style run.
				drawText(ctx, "\u0301x", 0, 4, {italic: true});
			});
		},
	},
	{
		// An axis the element does not clip is +-Infinity, so only the other
		// axis bounds the write.
		name: "clip rect with unbounded axes",
		run: (): string => {
			const framebuffer = new Framebuffer(6, 24, "rgb");
			return renderFrame(framebuffer, {offset: 0}, (ctx) => {
				ctx.clipRect = {left: 4, top: -Infinity, right: 12, bottom: Infinity};
				drawText(ctx, "horizontally bounded", 0, 0);
				ctx.clipRect = {left: -Infinity, top: 2, right: Infinity, bottom: 4};
				drawText(ctx, "dropped by the row clip", 0, 1);
				drawText(ctx, "kept by the row clip", 0, 2);
				ctx.clipRect = null;
				drawText(ctx, "tail", 0, 5);
			});
		},
	},
	{
		// The resize re-anchor measures the previous frame through the cell
		// widths it recorded, so the number is a property of the buffer.
		name: "wrapped rows above the cursor park",
		run: (): string => {
			const framebuffer = new Framebuffer(4, 20, "rgb");
			renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "a short line", 0, 0);
				drawText(ctx, "日本語 wide and long", 0, 1);
				drawText(ctx, "x", 0, 2);
				drawText(ctx, "last", 0, 3);
			});
			const before = [20, 10, 7, 5].map((cols) =>
				wrappedRowsAbovePark(framebuffer, cols),
			);
			// A caret park moves the measurement point.
			renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "a short line", 0, 0);
				drawText(ctx, "日本語 wide and long", 0, 1);
				drawText(ctx, "x", 0, 2);
				drawText(ctx, "last", 0, 3);
				setCaret(ctx, 3, 1);
			});
			const after = [20, 10, 7, 5].map((cols) =>
				wrappedRowsAbovePark(framebuffer, cols),
			);
			return JSON.stringify({before, after});
		},
	},
	{
		name: "drawDecoration outline over existing cells",
		run: (): string => {
			const framebuffer = new Framebuffer(5, 20, "rgb");
			return renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "boxed", 0, 1, {fg: 0xff0000, bold: true});
				drawDecoration(ctx, 0, 1, 12, {underline: true, fg: 0x5fafff});
				drawText(ctx, "over", 0, 3, {italic: true});
				drawDecoration(ctx, 0, 3, 12, {
					overline: true,
					fg: 0x5fafff,
					dim: true,
				});
			});
		},
	},
	{
		name: "incremental diff across frames",
		run: (): string => {
			const framebuffer = new Framebuffer(6, 24, "rgb");
			let out = renderFrame(framebuffer, {offset: 0}, (ctx) => {
				for (let row = 0; row < 6; row++) {
					drawText(ctx, `row ${row} content`, 0, row);
				}
			});
			out += "|";
			// One cell changes.
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				for (let row = 0; row < 6; row++) {
					drawText(
						ctx,
						row === 3 ? "row X content" : `row ${row} content`,
						0,
						row,
					);
				}
			});
			out += "|";
			// Nothing changes.
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				for (let row = 0; row < 6; row++) {
					drawText(
						ctx,
						row === 3 ? "row X content" : `row ${row} content`,
						0,
						row,
					);
				}
			});
			out += "|";
			// Content shrinks, leaving stale rows to clear.
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "row 0 content", 0, 0);
			});
			return out;
		},
	},
	{
		name: "scroll transform frames",
		run: (): string => {
			const framebuffer = new Framebuffer(10, 24, "rgb");
			const paint = (top: number) => (ctx: CellContext) => {
				for (let row = 0; row < 10; row++) {
					drawText(ctx, `line ${top + row}`.padEnd(12), 0, row, {
						fg: (top + row) % 2 === 0 ? 0x00ff00 : undefined,
					});
				}
			};
			let out = renderFrame(
				framebuffer,
				{offset: 0, cursorRow: 0, regionRows: 10},
				paint(0),
			);
			out += "|";
			out += renderFrame(
				framebuffer,
				{offset: 0, cursorRow: 0, regionRows: 10, delta: 3},
				paint(3),
			);
			out += "|";
			out += renderFrame(
				framebuffer,
				{offset: 0, cursorRow: 0, regionRows: 10, delta: -2},
				paint(1),
			);
			out += "|";
			// Delta zero: a plain repaint with no terminal scroll.
			out += renderFrame(
				framebuffer,
				{offset: 0, cursorRow: 0, regionRows: 10, delta: 0},
				paint(1),
			);
			return out;
		},
	},
	{
		name: "overflowing growth frame then reset",
		run: (): string => {
			const framebuffer = new Framebuffer(5, 20, "rgb");
			let out = renderFrame(
				framebuffer,
				{offset: 0, cursorRow: 0, regionRows: 9},
				(ctx) => {
					for (let row = 0; row < 9; row++) {
						drawText(ctx, `L${row}`, 0, row);
					}
				},
			);
			out += "|";
			replaced(framebuffer, 2);
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "after reset", 0, 0);
			});
			out += "|";
			repaintAll(framebuffer);
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "after clear", 0, 0);
			});
			return out;
		},
	},
	{
		name: "caret parking",
		run: (): string => {
			const framebuffer = new Framebuffer(6, 20, "rgb");
			let out = renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "value", 0, 0);
				setCaret(ctx, 5, 0);
			});
			out += "|";
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "value!", 0, 0);
				setCaret(ctx, 6, 0);
			});
			out += "|";
			// Caret goes away: the frame still emits, to re-park the cursor.
			out += renderFrame(framebuffer, {offset: 0}, (ctx) => {
				drawText(ctx, "value!", 0, 0);
			});
			return out;
		},
	},
	{
		name: "clipRect and viewport offset",
		run: (): string => {
			const framebuffer = new Framebuffer(8, 24, "rgb");
			return renderFrame(framebuffer, {offset: 2}, (ctx) => {
				drawText(ctx, "visible row", 0, 0);
				ctx.clipRect = {left: 2, top: 1, right: 10, bottom: 3};
				drawText(ctx, "clipped horizontally", 0, 1);
				drawText(ctx, "also clipped", 0, 2);
				drawText(ctx, "outside the clip", 0, 3);
				drawBox(ctx, 0, 1, 14, 3, {
					top: {style: "solid"},
					right: {style: "solid"},
					bottom: {style: "solid"},
					left: {style: "solid"},
				});
				ctx.clipRect = null;
				drawText(ctx, "unclipped again", 0, 4);
			});
		},
	},
	{
		name: "static render to a pipe",
		run: (): string => {
			const framebuffer = new Framebuffer(6, 30, "rgb");
			let out = renderStatic(framebuffer, {rows: 5}, (ctx) => {
				drawText(ctx, "plain", 0, 0);
				drawText(ctx, "styled", 0, 1, {fg: 0xff0000, bold: true});
				drawText(ctx, "日本語 wide", 0, 2);
				drawBox(ctx, 0, 3, 8, 2, {
					top: {style: "solid", color: 0x00ff00},
					right: {style: "solid", color: 0x00ff00},
					bottom: {style: "solid", color: 0x00ff00},
					left: {style: "solid", color: 0x00ff00},
				});
				drawText(ctx, "👍 tail", 10, 3);
			});
			out += "|";
			out += renderStatic(framebuffer, {rows: 2, lineEnding: "\r\n"}, (ctx) => {
				drawText(ctx, "crlf", 0, 0);
				drawText(ctx, "lines", 0, 1);
			});
			return out;
		},
	},
];
