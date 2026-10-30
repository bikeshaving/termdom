/**
 * Images in the kitty graphics protocol
 *
 * An image's pixels go to the terminal once, and its box is painted as
 * placeholder cells: U+10EEEE with diacritics naming the row and column,
 * in a 24-bit foreground color that is the image's id. The tests read the
 * escapes the terminal is sent and the cells left in the mock terminal's
 * buffer.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM, type TermDOMOptions} from "../src/index.ts";
import {encodePNG} from "../src/internal/images.ts";
import {getPlaceholder, MAX_PLACEHOLDER_CELLS} from "../src/internal/kitty.ts";
import {
	captureRawOutput,
	MockProcess,
	nextFrame,
	scriptReplies,
} from "./test-utils.ts";

type RGBA = [number, number, number, number];

function png(
	width: number,
	height: number,
	paint: (x: number, y: number) => RGBA,
): string {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			data.set(paint(x, y), (y * width + x) * 4);
		}
	}
	let binary = "";
	for (const byte of encodePNG({width, height, data})) {
		binary += String.fromCharCode(byte);
	}
	return `data:image/png;base64,${btoa(binary)}`;
}

const RED: RGBA = [255, 0, 0, 255];
const GREEN: RGBA = [0, 255, 0, 255];
const BLUE: RGBA = [0, 0, 255, 255];
const WHITE: RGBA = [255, 255, 255, 255];

// 16 by 32 in bands 8 pixels tall: 2 columns by 2 rows of 8 by 16 cells.
const BANDS = png(
	16,
	32,
	(_x, y) => [RED, GREEN, BLUE, WHITE][Math.floor(y / 8)],
);

const KITTY_QUERY = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
const KITTY_OK = "\x1b_Gi=31;OK\x1b\\";
const VERSION_QUERY = "\x1b[>0q";

interface Upload {
	control: Record<string, string>;
	payload: string;
}

// The images sent: each transmission's keys, and its chunks' payloads
// joined.
function readUploads(raw: string): Upload[] {
	const uploads: Upload[] = [];
	for (const [, control, payload] of raw.matchAll(
		/\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g,
	)) {
		const keys = Object.fromEntries(
			control.split(",").map((pair) => pair.split("=")),
		);
		if (keys.a === "T") {
			uploads.push({control: keys, payload: payload ?? ""});
		} else if (keys.a === undefined && uploads.length > 0) {
			uploads[uploads.length - 1].payload += payload ?? "";
		}
	}
	return uploads;
}

async function readPixels(upload: Upload): Promise<Uint8Array> {
	const bytes = Uint8Array.from(atob(upload.payload), (c) => c.charCodeAt(0));
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function cell(
	terminal: MockProcess,
	col: number,
	row: number,
): {char: string; fg: number} {
	const at = (terminal as any).terminal.buffer.active.getLine(row).getCell(col);
	return {
		char: at.getChars() as string,
		fg: at.isFgRGB() ? (at.getFgColor() as number) : -1,
	};
}

async function mount(
	html: string,
	options: TermDOMOptions &
		{replies?: Array<{ask: string; reply: string | null}>} = {},
): Promise<{dom: TermDOM; terminal: MockProcess; output: () => string}> {
	const {replies = [], ...rest} = options;
	const terminal = new MockProcess({cols: 40, rows: 12});
	scriptReplies(terminal, [
		{ask: "\x1b[16t", reply: "\x1b[6;16;8t"},
		...replies,
	]);
	const output = captureRawOutput(terminal);
	const dom = new TermDOM({
		transport: terminal.transport,
		csp: "img-src data:",
		colorDepth: "rgb",
		images: "kitty",
		...rest,
	});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {dom, terminal, output};
}

async function loaded(dom: TermDOM): Promise<void> {
	const images = [...dom.document.images];
	await Promise.all(images.map((image) => image.decode().catch(() => {})));
	await nextFrame(dom);
}

test("an image is sent once and its box painted with placeholders", async () => {
	const {dom, terminal, output} = await mount(`<img src="${BANDS}">`);
	await loaded(dom);
	const [upload, ...rest] = readUploads(output());
	expect(rest).toEqual([]);
	expect(upload.control).toMatchObject({
		U: "1",
		f: "32",
		o: "z",
		s: "16",
		v: "32",
		c: "2",
		r: "2",
		q: "2",
	});
	const id = Number(upload.control.i);
	for (const [col, row] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
		expect(cell(terminal, col, row)).toEqual({
			char: getPlaceholder(row, col),
			fg: id,
		});
	}
	// Pixel for pixel, at the terminal's cell size.
	const pixels = await readPixels(upload);
	expect(pixels.length).toBe(16 * 32 * 4);
	const at = (x: number, y: number) =>
		Array.from(pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
	expect(at(3, 3)).toEqual(RED);
	expect(at(3, 12)).toEqual(GREEN);
	expect(at(12, 20)).toEqual(BLUE);
	expect(at(12, 28)).toEqual(WHITE);
	dom.dispose();
});

test("a repaint of the rest of the page sends nothing again", async () => {
	const {dom, output} = await mount(`<img src="${BANDS}"><p id="p">a</p>`);
	await loaded(dom);
	dom.document.getElementById("p")!.textContent = "b";
	await nextFrame(dom);
	expect(readUploads(output()).length).toBe(1);
	dom.dispose();
});

test("a resized box sends the image again at the new size", async () => {
	const {dom, output} = await mount(`<img id="i" src="${BANDS}">`);
	await loaded(dom);
	dom.document.getElementById("i")!.style.width = "4px";
	await nextFrame(dom);
	const uploads = readUploads(output());
	expect(uploads.length).toBe(2);
	expect(uploads[1].control).toMatchObject({s: "32", v: "64", c: "4", r: "4"});
	expect(uploads[1].control.i).not.toBe(uploads[0].control.i);
	dom.dispose();
});

test("a box clipped by a scroller shows the placeholders of the rows it shows", async () => {
	const {dom, terminal} = await mount(
		`<div id="s" style="height: 1px; overflow: hidden"><img src="${BANDS}"></div>`,
	);
	await loaded(dom);
	expect(cell(terminal, 0, 0).char).toBe(getPlaceholder(0, 0));
	expect(cell(terminal, 0, 1).char).not.toBe(getPlaceholder(1, 0));
	dom.document.getElementById("s")!.scrollTop = 1;
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).char).toBe(getPlaceholder(1, 0));
	expect(cell(terminal, 1, 0).char).toBe(getPlaceholder(1, 1));
	dom.dispose();
});

test("in fewer than 24-bit colors an image draws in cells", async () => {
	const {dom, terminal, output} =
		await mount(`<img src="${BANDS}">`, {colorDepth: "256"});
	await loaded(dom);
	expect(readUploads(output())).toEqual([]);
	expect(cell(terminal, 0, 0).char).toBe("▄");
	dom.dispose();
});

test("a box past what placeholders can number draws in cells", async () => {
	const {dom, terminal, output} = await mount(
		`<img src="${BANDS}" style="width: ${MAX_PLACEHOLDER_CELLS + 1}px">`,
	);
	await loaded(dom);
	expect(readUploads(output())).toEqual([]);
	// Red over red, which is a space in red.
	expect(cell(terminal, 0, 0)).toEqual({char: " ", fg: -1});
	dom.dispose();
});

test("a canvas set to cells draws in cells while images send pixels", async () => {
	const {dom, terminal, output} = await mount(
		"<canvas id=\"c\" width=\"16\" height=\"32\"></canvas>",
		{canvas: "cells"},
	);
	const canvas = dom.document.getElementById("c") as HTMLCanvasElement;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "red";
	context.fillRect(0, 0, 16, 32);
	await nextFrame(dom);
	expect(readUploads(output())).toEqual([]);
	expect(cell(terminal, 0, 0).char).not.toBe(getPlaceholder(0, 0));
	dom.dispose();
});

test("a canvas set to kitty sends each frame it draws", async () => {
	const {dom, terminal, output} = await mount(
		"<canvas id=\"c\" width=\"16\" height=\"32\"></canvas>",
		{canvas: "kitty"},
	);
	const canvas = dom.document.getElementById("c") as HTMLCanvasElement;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "red";
	context.fillRect(0, 0, 16, 32);
	await nextFrame(dom);
	context.fillStyle = "blue";
	context.fillRect(0, 0, 16, 32);
	await nextFrame(dom);
	const uploads = readUploads(output());
	expect(uploads.length).toBe(2);
	expect(cell(terminal, 0, 0).fg).toBe(Number(uploads[1].control.i));
	const pixels = await readPixels(uploads[1]);
	expect(Array.from(pixels.subarray(0, 4))).toEqual(BLUE);
	dom.dispose();
});

for (const [name, version, drawn] of [
	["kitty", "\x1bP>|kitty(0.35.2)\x1b\\", true],
	["Ghostty", "\x1bP>|ghostty 1.1.3\x1b\\", true],
	[
		"WezTerm, which places no placeholders,",
		"\x1bP>|WezTerm 20240203\x1b\\",
		false,
	],
] as const) {
	test(`"auto" sends pixels to ${name} when it answers the query`, async () => {
		const {dom, terminal, output} = await mount(`<img src="${BANDS}">`, {
			images: "auto",
			replies: [
				{ask: KITTY_QUERY, reply: KITTY_OK},
				{ask: VERSION_QUERY, reply: version},
			],
		});
		await loaded(dom);
		expect(readUploads(output()).length).toBe(drawn ? 1 : 0);
		expect(cell(terminal, 0, 0).char === getPlaceholder(0, 0)).toBe(drawn);
		dom.dispose();
	});
}

test("\"auto\" draws in cells where the terminal does not answer", async () => {
	const {dom, terminal, output} =
		await mount(`<img src="${BANDS}">`, {images: "auto"});
	await loaded(dom);
	expect(output()).toContain(KITTY_QUERY);
	expect(readUploads(output())).toEqual([]);
	expect(cell(terminal, 0, 0).char).toBe("▄");
	dom.dispose();
});

test("\"cells\" asks the terminal nothing", async () => {
	const {dom, output} = await mount(`<img src="${BANDS}">`, {
		images: "cells",
		canvas: "cells",
	});
	expect(output()).not.toContain(KITTY_QUERY);
	dom.dispose();
});
