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
import {toCellColor} from "../src/internal/cssvalues.ts";
import {CellGrid} from "../src/internal/framebuffer.ts";
import {encodePNG, toBase64} from "../src/internal/images.ts";
import {
	getPlaceholder,
	isPlaceholderChar,
	KittyImages,
	MAX_PLACEHOLDER_CELLS,
	PLACEHOLDER,
	placeKittyImage,
	takeKittyOutput,
} from "../src/internal/kitty.ts";
import {_} from "../src/internal/slots.ts";
import {
	captureRawOutput,
	MockProcess,
	nextFrame,
	scriptReplies,
	until,
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
const TMUX_VERSION = "\x1bP>|tmux 3.6b\x1b\\";

function wrapForTmux(escape: string): string {
	return `\x1bPtmux;${escape.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

// The graphics escapes sent through tmux, unwrapped.
function unwrapTmux(raw: string): string {
	const wrapped =
		raw.match(/\x1bPtmux;\x1b\x1b_G[^\x1b]*\x1b\x1b\\\x1b\\/g) ?? [];
	return wrapped
		.map((escape) => escape.slice(7, -2).replaceAll("\x1b\x1b", "\x1b"))
		.join("");
}

function settle(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Swaps in a CompressionStream that holds its output until `release`, to
// end a session while a frame's images encode.
function holdCompression(): {
	started: Promise<void>;
	release: () => void;
	restore: () => void;
} {
	const global = globalThis as {CompressionStream: typeof CompressionStream};
	const Real = global.CompressionStream;
	let started!: () => void;
	const startedPromise = new Promise<void>((resolve) => (started = resolve));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	global.CompressionStream = class {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<BufferSource>;
		constructor(format: CompressionFormat) {
			const real = new Real(format);
			this.writable = real.writable;
			this.readable = real.readable.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({start: () => gate}),
			);
			started();
		}
	} as unknown as typeof CompressionStream;
	return {
		started: startedPromise,
		release,
		restore: () => {
			global.CompressionStream = Real;
		},
	};
}

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

test("without CompressionStream the pixels are sent as they are", async () => {
	const global = globalThis as {CompressionStream?: unknown};
	const saved = global.CompressionStream;
	delete global.CompressionStream;
	try {
		const {dom, terminal, output} =
			await mount(`<p>a</p><img src="${BANDS}"><p>b</p>`);
		await loaded(dom);
		const [upload] = readUploads(output());
		expect(upload.control.o).toBe(undefined);
		const pixels =
			Uint8Array.from(atob(upload.payload), (c) => c.charCodeAt(0));
		expect(pixels.length).toBe(16 * 32 * 4);
		expect(Array.from(pixels.subarray(0, 4))).toEqual(RED);
		expect(cell(terminal, 0, 0).char).toBe("a");
		dom.dispose();
	} finally {
		global.CompressionStream = saved;
	}
});

test("a repaint of the rest of the page sends nothing again", async () => {
	const {dom, output} = await mount(`<img src="${BANDS}"><p id="p">a</p>`);
	await loaded(dom);
	dom.document.getElementById("p")!.textContent = "b";
	await nextFrame(dom);
	expect(readUploads(output()).length).toBe(1);
	dom.dispose();
});

test("the image is sent again on the screen fullscreen switches to", async () => {
	const {dom, output} =
		await mount(`<div id="stage"><img src="${BANDS}"></div>`);
	await loaded(dom);
	const [before] = readUploads(output());
	await dom.document.getElementById("stage")!.requestFullscreen();
	await nextFrame(dom);
	const text = output();
	const switched = text.indexOf("\x1b[?1049h");
	const freed = text.indexOf(`\x1b_Ga=d,d=I,i=${before.control.i},q=2\x1b\\`);
	expect(switched).toBeGreaterThan(-1);
	expect(freed).toBeGreaterThan(-1);
	expect(freed).toBeLessThan(switched);
	expect(readUploads(text.slice(switched)).length).toBe(1);
	dom.dispose();
});

test("dispose frees the images it sent", async () => {
	const {dom, output} = await mount(`<img src="${BANDS}">`);
	await loaded(dom);
	const [upload] = readUploads(output());
	await dom.dispose();
	expect(output()).toContain(`\x1b_Ga=d,d=I,i=${upload.control.i},q=2\x1b\\`);
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

test("a canvas set to kitty sends each frame it draws under one id", async () => {
	const {dom, terminal, output} = await mount(
		"<canvas id=\"c\" width=\"16\" height=\"32\"></canvas>",
		{canvas: "kitty"},
	);
	const canvas = dom.document.getElementById("c") as HTMLCanvasElement;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "red";
	context.fillRect(0, 0, 16, 32);
	await nextFrame(dom);
	const first = output().length;
	context.fillStyle = "blue";
	context.fillRect(0, 0, 16, 32);
	await nextFrame(dom);
	const uploads = readUploads(output());
	expect(uploads.length).toBe(2);
	expect(uploads[1].control.i).toBe(uploads[0].control.i);
	expect(cell(terminal, 0, 0).fg).toBe(Number(uploads[1].control.i));
	// The cells name the same image, so they are not written again.
	expect(output().slice(first)).not.toContain(PLACEHOLDER);
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

test("a query answer split across reads is no keystrokes", async () => {
	for (const [head, tail] of [
		["\x1b_Gi=31;O", "K\x1b\\"],
		["\x1b_Gi=31;OK\x1b", "\\"],
	]) {
		const terminal = new MockProcess({cols: 40, rows: 12});
		scriptReplies(terminal, [
			{ask: "\x1b[16t", reply: "\x1b[6;16;8t"},
			{ask: VERSION_QUERY, reply: "\x1bP>|kitty(0.35.2)\x1b\\"},
		]);
		const stdin = terminal.stdin as unknown as
			{simulateResponse: (data: string) => void};
		const stdout =
			terminal.stdout as unknown as {write: (...args: unknown[]) => boolean};
		const write = stdout.write.bind(stdout);
		stdout.write = (...args: unknown[]) => {
			if (String(args[0]).includes(KITTY_QUERY)) {
				setTimeout(() => {
					stdin.simulateResponse(head);
					setTimeout(() => stdin.simulateResponse(tail), 0);
				}, 0);
			}
			return write(...args);
		};
		const output = captureRawOutput(terminal);
		const dom = new TermDOM({
			transport: terminal.transport,
			csp: "img-src data:",
			colorDepth: "rgb",
			images: "auto",
		});
		const keys: string[] = [];
		dom.document.addEventListener("keydown", (event) => {
			keys.push((event as KeyboardEvent).key);
		});
		dom.document.body.innerHTML = `<img src="${BANDS}">`;
		await nextFrame(dom);
		await loaded(dom);
		expect(keys).toEqual([]);
		expect(readUploads(output()).length).toBe(1);
		dom.dispose();
	}
});

test("\"auto\" in tmux asks the terminal it runs in, through it", async () => {
	const {dom, terminal, output} = await mount(`<img src="${BANDS}">`, {
		images: "auto",
		replies: [
			{ask: wrapForTmux(KITTY_QUERY), reply: KITTY_OK},
			{ask: wrapForTmux(VERSION_QUERY), reply: "\x1bP>|ghostty 1.4.0\x1b\\"},
			{ask: wrapForTmux("\x1b[>c"), reply: "\x1b[>1;10;0c"},
			{ask: VERSION_QUERY, reply: TMUX_VERSION},
		],
	});
	await loaded(dom);
	await until(() => readUploads(unwrapTmux(output())).length > 0);
	const text = output();
	expect(readUploads(text)).toEqual([]);
	const [upload] = readUploads(unwrapTmux(text));
	expect(cell(terminal, 0, 0)).toEqual({
		char: getPlaceholder(0, 0),
		fg: Number(upload.control.i),
	});
	dom.dispose();
});

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

test("\"auto\" in a tmux that drops passthrough does not hold the first frame", async () => {
	const started = performance.now();
	// The questions asked through tmux go nowhere, and the wait for them
	// is a second.
	const {dom, terminal, output} = await mount(`<img src="${BANDS}">`, {
		images: "auto",
		replies: [
			{ask: wrapForTmux(KITTY_QUERY), reply: null},
			{ask: wrapForTmux(VERSION_QUERY), reply: null},
			{ask: wrapForTmux("\x1b[>c"), reply: null},
			{ask: VERSION_QUERY, reply: TMUX_VERSION},
		],
	});
	expect(performance.now() - started).toBeLessThan(1000);
	expect(output()).toContain(wrapForTmux(KITTY_QUERY));
	await loaded(dom);
	expect(cell(terminal, 0, 0).char).toBe("▄");
	dom.dispose();
});

test("\"kitty\" in tmux sends its images through tmux", async () => {
	const {dom, terminal, output} = await mount(`<img src="${BANDS}">`, {
		replies: [{ask: VERSION_QUERY, reply: TMUX_VERSION}],
	});
	await loaded(dom);
	const text = output();
	expect(readUploads(text)).toEqual([]);
	const [upload] = readUploads(unwrapTmux(text));
	expect(cell(terminal, 0, 0)).toEqual({
		char: getPlaceholder(0, 0),
		fg: Number(upload.control.i),
	});
	dom.dispose();
});

test("a frame whose images are encoding when dispose runs is not written", async () => {
	const {dom, output} = await mount(`<img id="i" src="${BANDS}">`);
	await loaded(dom);
	const [before] = readUploads(output());
	const held = holdCompression();
	try {
		dom.document.getElementById("i")!.style.width = "4px";
		await held.started;
		const mark = output().length;
		const disposed = dom.dispose();
		held.release();
		await disposed;
		await settle();
		const after = output().slice(mark);
		expect(after).toContain(`\x1b_Ga=d,d=I,i=${before.control.i},q=2\x1b\\`);
		expect(readUploads(after)).toEqual([]);
		expect(after).not.toContain(PLACEHOLDER);
	} finally {
		held.restore();
	}
});

test("a frame whose images are encoding when the document seals is not written", async () => {
	const {dom, output} = await mount(`<img id="i" src="${BANDS}">`);
	await loaded(dom);
	const held = holdCompression();
	try {
		dom.document.getElementById("i")!.style.width = "4px";
		await held.started;
		const mark = output().length;
		dom.document.close();
		held.release();
		await settle();
		const after = output().slice(mark);
		expect(readUploads(after)).toEqual([]);
		expect(after).not.toContain(PLACEHOLDER);
	} finally {
		held.restore();
		dom.dispose();
	}
});

test("a frame whose images are encoding when the session suspends is drawn whole on resume", async () => {
	const terminal = new MockProcess({cols: 40, rows: 12});
	scriptReplies(terminal, [{ask: "\x1b[16t", reply: "\x1b[6;16;8t"}]);
	const output = captureRawOutput(terminal);
	let suspended = false;
	let resume!: () => void;
	const dom = new TermDOM({
		transport: {
			...terminal.transport,
			cols: terminal.transport.cols,
			rows: terminal.transport.rows,
			suspend: () => {
				suspended = true;
				return new Promise<void>((resolve) => (resume = resolve));
			},
		},
		csp: "img-src data:",
		colorDepth: "rgb",
		images: "kitty",
	});
	dom.document.body.innerHTML = `<img id="i" src="${BANDS}">`;
	dom.attach();
	await nextFrame(dom);
	await loaded(dom);
	const held = holdCompression();
	try {
		dom.document.getElementById("i")!.style.width = "4px";
		await held.started;
		const mark = output().length;
		terminal.stdin.simulateResponse("\x1a");
		await until(() => suspended);
		held.release();
		await settle();
		const away = output().slice(mark);
		expect(readUploads(away)).toEqual([]);
		expect(away).not.toContain(PLACEHOLDER);
		held.restore();
		resume();
		await until(() => readUploads(output().slice(mark)).length > 0);
		const [upload] = readUploads(output().slice(mark));
		expect(upload.control).toMatchObject({c: "4", r: "4"});
		// The suspend sealed the page above, so the page starts again below.
		const last = () => {
			const buffer = (terminal as any).terminal.buffer.active;
			for (let row = buffer.length - 1; row >= 0; row--) {
				if (
					buffer.getLine(row).getCell(3).getChars() === getPlaceholder(3, 3)
				) {
					return buffer.getLine(row).getCell(3).getFgColor() as number;
				}
			}
			return -1;
		};
		await until(() => last() !== -1);
		expect(last()).toBe(Number(upload.control.i));
	} finally {
		held.restore();
		await dom.dispose();
	}
});

test("text in the color of an image's id does not keep the image", async () => {
	const images = new KittyImages(() => ({width: 8, height: 16}));
	// 64 MB of pixels, past what the terminal may keep of unshown images.
	const size = {width: 4096, height: 4096, cols: 1, rows: 1};
	const draw = () => new Uint8ClampedArray(4);
	const dropped = placeKittyImage(images, "dropped", 0, size, draw);
	await takeKittyOutput(images, null);
	const screen = new CellGrid(1, 2);
	screen.setCell(0, "a", {fg: toCellColor(dropped)});
	expect(await takeKittyOutput(images, screen))
		.toContain(`\x1b_Ga=d,d=I,i=${dropped},q=2\x1b\\`);
	const kept = placeKittyImage(images, "kept", 0, size, draw);
	await takeKittyOutput(images, null);
	screen.setPlaceholder(1, 0, 0, {fg: toCellColor(kept)});
	expect(await takeKittyOutput(images, screen)).not.toContain(`i=${kept},`);
});

test("an image's cells hold placeholder codes, not clusters", async () => {
	const {dom} = await mount(`<img src="${BANDS}">`);
	await loaded(dom);
	const grid = (_(dom as never) as {framebuffer: {prev: CellGrid}})
		.framebuffer.prev;
	expect(
		[0, 1, grid.cols, grid.cols + 1].map((index) =>
			isPlaceholderChar(grid.cluster[index]),
		),
	).toEqual([true, true, true, true]);
	expect(isPlaceholderChar("\u{10EEEE}".codePointAt(0)!)).toBe(false);
	dom.dispose();
});

test("toBase64 encodes slice by slice into one string", () => {
	const bytes = Uint8Array.from({length: 0x6000 * 2 + 5}, (_, index) => (index *
		7) & 0xff);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	expect(toBase64(bytes)).toBe(btoa(binary));
});

test("images and canvas each take their own setting and protocol", async () => {
	for (const name of ["images", "canvas"] as const) {
		expect(() => new TermDOM({[name]: "pixels" as never})).toThrow(
			`${name} must be "auto", "cells", "kitty" or "none"`,
		);
	}
	const {dom, output} = await mount(
		`<p><img alt="gone" src="${BANDS}"></p>` +
			"<canvas id=\"c\" width=\"16\" height=\"32\"></canvas>",
		{images: "none", canvas: "kitty"},
	);
	const canvas = dom.document.getElementById("c") as HTMLCanvasElement;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "red";
	context.fillRect(0, 0, 16, 32);
	await nextFrame(dom);
	await nextFrame(dom);
	expect(readUploads(output()).length).toBe(1);
	expect(output()).toContain("gone");
	dom.dispose();
});
