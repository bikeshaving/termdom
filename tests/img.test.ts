/**
 * <img>
 *
 * An image loads from its src, fires load or error, sizes from its
 * natural dimensions, and paints into its content box two pixels a cell:
 * the upper half block in the upper pixel's color over the lower
 * pixel's. The tests read the painted cells' colors out of the mock
 * terminal's buffer.
 *
 * The images are built here as PNGs, so each test states its pixels.
 * Under the guessed 8 by 16 pixel cell, an image 8n wide and 16m tall
 * covers n columns and m rows.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {encodePNG} from "../src/internal/images.ts";
import {MockProcess, nextFrame, scriptReplies, until} from "./test-utils.ts";

type RGBA = [number, number, number, number];

/** A PNG as a data: URL, each pixel from `paint`. */
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
	const bytes = encodePNG({width, height, data});
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return `data:image/png;base64,${btoa(binary)}`;
}

const RED: RGBA = [255, 0, 0, 255];
const GREEN: RGBA = [0, 255, 0, 255];
const BLUE: RGBA = [0, 0, 255, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const CLEAR: RGBA = [0, 0, 0, 0];

// 16 by 32: bands 8 pixels tall of red, green, blue and white. Under 8 by
// 16 cells that is 2 columns by 2 rows: red over green, then blue over
// white.
const BANDS = png(
	16,
	32,
	(_x, y) => [RED, GREEN, BLUE, WHITE][Math.floor(y / 8)],
);

interface Cell {
	char: string;
	fg: number;
	bg: number;
}

function cell(terminal: MockProcess, col: number, row: number): Cell {
	const line = (terminal as any).terminal.buffer.active.getLine(row);
	const at = line.getCell(col);
	return {
		char: at.getChars() || " ",
		fg: at.isFgRGB() ? at.getFgColor() : -1,
		bg: at.isBgRGB() ? at.getBgColor() : -1,
	};
}

function rowText(terminal: MockProcess, row: number): string {
	return (terminal as any)
		.terminal.buffer.active.getLine(row)
		.translateToString(true);
}

const hex = (rgba: RGBA): number => (rgba[0] << 16) | (rgba[1] << 8) | rgba[2];

async function mount(
	html: string,
	options: {cols?: number; rows?: number; cellPixels?: [number, number]} = {},
): Promise<{dom: TermDOM; terminal: MockProcess; document: Document}> {
	const terminal = new MockProcess({
		cols: options.cols ?? 40,
		rows: options.rows ?? 12,
	});
	if (options.cellPixels) {
		const [width, height] = options.cellPixels;
		scriptReplies(terminal, [
			{ask: "\x1b[16t", reply: `\x1b[6;${height};${width}t`},
		]);
	}
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {dom, terminal, document: dom.document};
}

async function loaded(image: HTMLImageElement): Promise<void> {
	if (!image.complete) {
		await new Promise<void>((resolve) => {
			image.addEventListener("load", () => resolve(), {once: true});
			image.addEventListener("error", () => resolve(), {once: true});
		});
	}
}

test("an image loads, fires load, and reports its natural size", async () => {
	const {dom, document} = await mount("");
	const image = document.createElement("img");
	const events: string[] = [];
	image.addEventListener("load", () => events.push("load"));
	image.addEventListener("error", () => events.push("error"));
	image.src = BANDS;
	expect(image.complete).toBe(false);
	document.body.appendChild(image);
	await until(() => events.length > 0);
	expect(events).toEqual(["load"]);
	expect(image.complete).toBe(true);
	expect(image.naturalWidth).toBe(16);
	expect(image.naturalHeight).toBe(32);
	expect(image.currentSrc).toBe(BANDS);
	await image.decode();
	dom.dispose();
});

test("an image paints two pixels a cell in their own colors", async () => {
	const {dom, terminal, document} = await mount(`<img src="${BANDS}">`);
	await loaded(document.querySelector("img")!);
	await nextFrame(dom);
	for (const [col, row, top, bottom] of [
		[0, 0, RED, GREEN],
		[1, 0, RED, GREEN],
		[0, 1, BLUE, WHITE],
		[1, 1, BLUE, WHITE],
	] as const) {
		const painted = cell(terminal, col, row);
		expect(painted.char).toBe("▀");
		expect(painted.fg).toBe(hex(top));
		expect(painted.bg).toBe(hex(bottom));
	}
	// Two columns wide and no more.
	expect(cell(terminal, 2, 0).char).toBe(" ");
	expect(document.querySelector("img")!.getBoundingClientRect().width).toBe(2);
	expect(document.querySelector("img")!.getBoundingClientRect().height).toBe(2);
	dom.dispose();
});

test("a pixel that matches the one under it is a space in that color", async () => {
	const solid = png(8, 16, () => BLUE);
	const {dom, terminal, document} = await mount(`<img src="${solid}">`);
	await loaded(document.querySelector("img")!);
	await nextFrame(dom);
	expect(cell(terminal, 0, 0)).toEqual({char: " ", fg: -1, bg: hex(BLUE)});
	dom.dispose();
});

test("transparent pixels leave what is under them", async () => {
	// Top half transparent, bottom half red, over a green box.
	const half = png(8, 16, (_x, y) => (y < 8 ? CLEAR : RED));
	const {dom, terminal, document} = await mount(
		`<div style="background-color: #00ff00; width: 4ch"><img src="${half}"></div>` +
		`<img id=bare src="${half}">`,
	);
	for (const image of document.querySelectorAll("img")) {
		await loaded(image as HTMLImageElement);
	}
	await nextFrame(dom);
	// Over the green box: a lower half block, the box's green behind it.
	expect(cell(terminal, 0, 0)).toEqual({
		char: "▄",
		fg: hex(RED),
		bg: hex(GREEN),
	});
	// Over nothing: the lower half block alone.
	const bare = cell(terminal, 0, 1);
	expect(bare.char).toBe("▄");
	expect(bare.fg).toBe(hex(RED));
	expect(bare.bg).toBe(-1);
	dom.dispose();
});

test("a translucent pixel blends over the image's own background", async () => {
	const translucent = png(8, 16, () => [255, 0, 0, 128]);
	const {dom, terminal, document} =
		await mount(`<img src="${translucent}" style="background-color: #0000ff">`);
	await loaded(document.querySelector("img")!);
	await nextFrame(dom);
	const painted = cell(terminal, 0, 0);
	const red = (painted.bg >> 16) & 0xff;
	const blue = painted.bg & 0xff;
	expect(Math.abs(red - 128)).toBeLessThanOrEqual(2);
	expect(Math.abs(blue - 127)).toBeLessThanOrEqual(2);
	dom.dispose();
});

test("the natural size in cells follows the cell size the terminal reports", async () => {
	// 40 by 40 pixels: 5 by 3 cells under the 8 by 16 guess (40 / 16 rounds
	// to 3), 4 by 2 under 10 by 20 cells.
	const square = png(40, 40, () => RED);
	const {dom, document} = await mount(`<img src="${square}">`, {
		cellPixels: [10, 20],
	});
	const image = document.querySelector("img")!;
	await loaded(image);
	await until(() => image.getBoundingClientRect().width === 4);
	expect(image.getBoundingClientRect().width).toBe(4);
	expect(image.getBoundingClientRect().height).toBe(2);
	dom.dispose();

	const guessed = await mount(`<img src="${square}">`);
	const other = guessed.document.querySelector("img")!;
	await loaded(other);
	await nextFrame(guessed.dom);
	expect(other.getBoundingClientRect().width).toBe(5);
	expect(other.getBoundingClientRect().height).toBe(3);
	guessed.dom.dispose();
});

test("width or height alone takes the other from the image's ratio", async () => {
	// 32 by 32 pixels is 4 by 2 cells: twice as many columns as rows.
	const square = png(32, 32, () => GREEN);
	const {dom, document} = await mount(
		`<img id=w src="${square}" width="10">` +
		`<img id=h src="${square}" style="display: block; height: 3px">` +
		`<img id=both src="${square}" style="display: block; width: 6ch; height: 1px">`,
	);
	for (const image of document.querySelectorAll("img")) {
		await loaded(image as HTMLImageElement);
	}
	await nextFrame(dom);
	const size = (id: string) => {
		const rect = document.getElementById(id)!.getBoundingClientRect();
		return [rect.width, rect.height];
	};
	expect(size("w")).toEqual([10, 5]);
	expect(size("h")).toEqual([6, 3]);
	expect(size("both")).toEqual([6, 1]);
	dom.dispose();
});

test("max-width: 100% keeps an image inside its container, at its ratio", async () => {
	const wide = png(320, 64, () => BLUE); // 40 by 4 cells
	const {dom, document} = await mount(
		`<div style="width: 20ch"><img src="${wide}" style="max-width: 100%"></div>`,
	);
	const image = document.querySelector("img")!;
	await loaded(image);
	await nextFrame(dom);
	const rect = image.getBoundingClientRect();
	expect(rect.width).toBe(20);
	expect(rect.height).toBe(2);
	expect(image.width).toBe(20);
	expect(image.height).toBe(2);
	dom.dispose();
});

test("an image sits on a line with the text around it", async () => {
	const {dom, terminal, document} =
		await mount(`<p>before <img src="${BANDS}"> after</p>`);
	await loaded(document.querySelector("img")!);
	await nextFrame(dom);
	expect(rowText(terminal, 0)).toBe("before ▀▀ after");
	// The image's computed display stays inline, as in a browser.
	expect(
		dom.window.getComputedStyle(document.querySelector("img")!).display,
	).toBe("inline");
	dom.dispose();
});

test("object-fit: contain letterboxes and cover crops", async () => {
	// 16 by 16 pixels: left half red, right half blue. That is 2 by 1 cells.
	const halves = png(16, 16, (x) => (x < 8 ? RED : BLUE));
	const {dom, terminal, document} = await mount(
		`<img src="${halves}" style="display: block; width: 4ch; height: 2px; object-fit: contain">` +
		`<img src="${halves}" style="display: block; width: 2ch; height: 2px; object-fit: cover">`,
	);
	for (const image of document.querySelectorAll("img")) {
		await loaded(image as HTMLImageElement);
	}
	await nextFrame(dom);
	// contain: the 2 by 1 image is scaled to 4 by 2 and fills the box.
	expect(cell(terminal, 0, 0).bg).toBe(hex(RED));
	expect(cell(terminal, 3, 1).bg).toBe(hex(BLUE));
	// cover: scaled to 4 by 2 and centered in 2 by 2, so its middle shows:
	// one column of red, one of blue.
	expect(cell(terminal, 0, 2).bg).toBe(hex(RED));
	expect(cell(terminal, 1, 2).bg).toBe(hex(BLUE));
	dom.dispose();
});

test("object-fit: contain centers the image and leaves the rest alone", async () => {
	const solid = png(8, 16, () => RED); // 1 by 1 cell
	const {dom, terminal, document} = await mount(
		`<img src="${solid}" style="display: block; width: 5ch; height: 1px; object-fit: contain">`,
	);
	await loaded(document.querySelector("img")!);
	await nextFrame(dom);
	expect(cell(terminal, 2, 0).bg).toBe(hex(RED));
	expect(cell(terminal, 0, 0).bg).toBe(-1);
	expect(cell(terminal, 4, 0).bg).toBe(-1);
	dom.dispose();
});

test("a broken image fires error, rejects decode() and shows its alt text", async () => {
	const {dom, terminal, document} = await mount("<p></p>");
	const image = document.createElement("img");
	image.alt = "cover art";
	let failed = false;
	image.addEventListener("error", () => {
		failed = true;
	});
	image.src = "data:image/png;base64,AAAA";
	document.querySelector("p")!.append("[", image, "]");
	await until(() => failed);
	expect(failed).toBe(true);
	expect(image.complete).toBe(true);
	expect(image.naturalWidth).toBe(0);
	let rejected: unknown = null;
	await image.decode().catch((error: unknown) => {
		rejected = error;
	});
	expect((rejected as Error | null)?.name).toBe("EncodingError");
	await nextFrame(dom);
	expect(rowText(terminal, 0)).toBe("[cover art]");
	dom.dispose();
});

test("a missing file is an error, and a file on disk loads by path", async () => {
	const {dom, document} = await mount("");
	const missing = document.createElement("img");
	const outcome = new Promise<string>((resolve) => {
		missing.addEventListener("load", () => resolve("load"));
		missing.addEventListener("error", () => resolve("error"));
	});
	missing.src = "file:///nonexistent/termdom-test-image.png";
	expect(await outcome).toBe("error");
	dom.dispose();
});

test("changing src replaces the image, and only the newest load counts", async () => {
	const red = png(8, 16, () => RED);
	const blue = png(8, 16, () => BLUE);
	const {dom, terminal, document} = await mount(`<img src="${red}">`);
	const image = document.querySelector("img")!;
	await loaded(image);
	let loads = 0;
	image.addEventListener("load", () => loads++);
	image.src = BANDS;
	image.src = blue;
	await until(() => loads > 0);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(loads).toBe(1);
	expect(image.currentSrc).toBe(blue);
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).bg).toBe(hex(BLUE));
	dom.dispose();
});

test("removing src empties the image", async () => {
	const {dom, document} = await mount(`<img src="${BANDS}">`);
	const image = document.querySelector("img")!;
	await loaded(image);
	image.removeAttribute("src");
	expect(image.complete).toBe(true);
	expect(image.naturalWidth).toBe(0);
	await nextFrame(dom);
	expect(image.getBoundingClientRect().width).toBe(0);
	dom.dispose();
});

test("new Image() makes an <img>, and srcset picks the 1x candidate", async () => {
	const {dom} = await mount("");
	const image = new (dom.window as any).Image(3, 2) as HTMLImageElement;
	expect(image).toBeInstanceOf((dom.window as any).HTMLImageElement);
	expect(image.getAttribute("width")).toBe("3");
	expect(image.getAttribute("height")).toBe("2");
	const red = png(8, 16, () => RED);
	image.srcset = `${BANDS} 2x, ${red} 1x`;
	await loaded(image);
	expect(image.currentSrc).toBe(red);
	expect(image.naturalWidth).toBe(8);
	// Not rendered, width reads the attribute.
	expect(image.width).toBe(3);
	dom.dispose();
});

test("an image clips to a scroller and paints the rows scrolled into view", async () => {
	// 8 by 64 pixels: four cells tall, one band color a cell.
	const tall = png(
		8,
		64,
		(_x, y) => [RED, GREEN, BLUE, WHITE][Math.floor(y / 16)],
	);
	const {dom, terminal, document} = await mount(
		`<div id=s style="height: 2px; overflow: hidden"><img src="${tall}"></div><p>below</p>`,
	);
	await loaded(document.querySelector("img")!);
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).bg).toBe(hex(RED));
	expect(cell(terminal, 0, 1).bg).toBe(hex(GREEN));
	expect(rowText(terminal, 2)).toBe("below");
	document.getElementById("s")!.scrollTop = 2;
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).bg).toBe(hex(BLUE));
	expect(cell(terminal, 0, 1).bg).toBe(hex(WHITE));
	expect(rowText(terminal, 2)).toBe("below");
	dom.dispose();
});

test("half-block art keeps its colors through repaints of the rest of the page", async () => {
	const {dom, terminal, document} =
		await mount(`<p id=status>one</p><img src="${BANDS}">`);
	await loaded(document.querySelector("img")!);
	await nextFrame(dom);
	const before = [cell(terminal, 0, 1), cell(terminal, 1, 2)];
	document.getElementById("status")!.textContent = "two";
	await nextFrame(dom);
	expect(rowText(terminal, 0)).toBe("two");
	expect([cell(terminal, 0, 1), cell(terminal, 1, 2)]).toEqual(before);
	dom.dispose();
});

test("image-rendering: pixelated keeps hard edges when scaling down", async () => {
	// A 1-pixel checkerboard averaged down is gray; pixelated keeps a pixel.
	const checker = png(16, 32, (x, y) =>
		((x + y) % 2 === 0 ? WHITE : [0, 0, 0, 255]),
	);
	const {dom, terminal, document} = await mount(
		`<img src="${checker}" style="display: block; width: 1ch; height: 1px">` +
		`<img src="${checker}" style="display: block; width: 1ch; height: 1px; image-rendering: pixelated">`,
	);
	for (const image of document.querySelectorAll("img")) {
		await loaded(image as HTMLImageElement);
	}
	await nextFrame(dom);
	const smooth = cell(terminal, 0, 0).bg & 0xff;
	expect(smooth > 100 && smooth < 156).toBe(true);
	const crisp = cell(terminal, 0, 1);
	expect([0, 255]).toContain(crisp.fg & 0xff);
	dom.dispose();
});

test("an image keeps its own height on a line with a taller neighbor", async () => {
	const {dom, terminal, document} = await mount(
		`<p><img src="${BANDS}"><span style="display: inline-block; height: 4px">tall</span></p>`,
	);
	const image = document.querySelector("img")!;
	await loaded(image);
	await nextFrame(dom);
	// Two rows of image, then nothing under it: the line is four rows
	// tall, and the pixels are not stretched to fill it.
	expect(image.getBoundingClientRect().height).toBe(2);
	expect(cell(terminal, 0, 1)).toEqual({
		char: "▀",
		fg: hex(BLUE),
		bg: hex(WHITE),
	});
	expect(cell(terminal, 0, 2).char).toBe(" ");
	dom.dispose();
});

test("half-block art written as spans keeps its alignment through scrolling and repaints", async () => {
	// The text-only way to draw pixels: each cell an upper half block with
	// its two colors in color and background-color.
	const colors = [
		["#ff0000", "#00ff00"],
		["#0000ff", "#ffffff"],
		["#ffff00", "#00ffff"],
		["#ff00ff", "#808080"],
	];
	const art = colors
		.map(([top, bottom]) =>
			`<span style="color: ${top}; background-color: ${bottom}">▀▀▀</span>`,
		)
		.join("\n");
	const {dom, terminal, document} = await mount(
		`<p id=status>ready</p><pre id=s style="height: 2px; overflow: hidden">${art}</pre>`,
	);
	const row = (r: number) => [0, 1, 2].map((c) => cell(terminal, c, r));
	const expectRow = (r: number, [top, bottom]: string[]) => {
		for (const painted of row(r)) {
			expect(painted).toEqual({
				char: "▀",
				fg: parseInt(top.slice(1), 16),
				bg: parseInt(bottom.slice(1), 16),
			});
		}
	};
	expectRow(1, colors[0]);
	expectRow(2, colors[1]);
	document.getElementById("s")!.scrollTop = 2;
	await nextFrame(dom);
	expectRow(1, colors[2]);
	expectRow(2, colors[3]);
	document.getElementById("status")!.textContent = "still";
	await nextFrame(dom);
	expectRow(1, colors[2]);
	expectRow(2, colors[3]);
	dom.dispose();
});

test("a block-level image is as wide as itself, not its container", async () => {
	const wide = png(320, 64, () => BLUE); // 40 by 4 cells
	const {dom, document} = await mount(
		`<img id=a src="${BANDS}" style="display: block">` +
		`<div style="width: 10ch"><img id=b src="${wide}" style="display: block; max-width: 100%"></div>` +
		`<div style="display: grid; grid-template-columns: 20ch"><img id=c src="${BANDS}"></div>` +
		`<img id=d src="${BANDS}" style="display: block; height: 4px">`,
	);
	for (const image of document.querySelectorAll("img")) {
		await loaded(image as HTMLImageElement);
	}
	await nextFrame(dom);
	const size = (id: string) => {
		const rect = document.getElementById(id)!.getBoundingClientRect();
		return [rect.width, rect.height];
	};
	expect(size("a")).toEqual([2, 2]);
	// Clamped to the container, the height follows the ratio.
	expect(size("b")).toEqual([10, 1]);
	// A grid item with a ratio is not stretched across its track.
	expect(size("c")).toEqual([2, 2]);
	// A height alone sets the width through the ratio.
	expect(size("d")).toEqual([4, 4]);
	dom.dispose();
});

test("an image in a document with no window loads nothing until it is in one", async () => {
	const {dom, document} = await mount("");
	const window = dom.window as any;
	window.fired = 0;
	const parsed = new window.DOMParser().parseFromString(
		`<img src="data:image/png;base64,AAAA" onerror="window.fired++">`,
		"text/html",
	);
	const template = document.createElement("template");
	template.innerHTML = `<img src="${BANDS}">`;
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(window.fired).toBe(0);
	expect((parsed.querySelector("img") as HTMLImageElement).complete).toBe(
		false,
	);
	const image = template.content.querySelector("img") as HTMLImageElement;
	expect(image.naturalWidth).toBe(0);
	document.body.appendChild(image);
	await loaded(image);
	expect(image.naturalWidth).toBe(16);
	dom.dispose();
});

test("decode() settles when src changes, and the current image stays up meanwhile", async () => {
	const red = png(8, 16, () => RED);
	const {dom, terminal, document} = await mount(`<img src="${red}">`);
	const image = document.querySelector("img")!;
	await loaded(image);
	await nextFrame(dom);
	// A decode() pending when src changes rejects.
	image.src = BANDS;
	const pending = image.decode();
	image.src = red;
	let outcome = "";
	await pending.then(() => {
		outcome = "resolved";
	}, (error: Error) => {
		outcome = error.name;
	});
	expect(outcome).toBe("EncodingError");
	await loaded(image);
	// While a new image loads, the current one keeps its place. The load
	// is held open until the frame has been drawn.
	const realFetch = globalThis.fetch;
	const bands = await (await realFetch(BANDS)).arrayBuffer();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "https://images.test/bands.png") {
			await held;
			return new Response(bands);
		}
		return realFetch(input);
	}) as typeof fetch;
	try {
		image.src = "https://images.test/bands.png";
		expect(image.complete).toBe(false);
		expect(image.naturalWidth).toBe(8);
		await nextFrame(dom);
		expect(image.complete).toBe(false);
		expect(cell(terminal, 0, 0).bg).toBe(hex(RED));
		release();
		await image.decode();
		expect(image.naturalWidth).toBe(16);
	} finally {
		globalThis.fetch = realFetch;
	}
	dom.dispose();
});

test("with a cell size, an image's pixels and lengths are CSS pixels", async () => {
	// 70 by 30 pixels is 10 by 2 cells of 7 by 15.
	const wide = png(70, 30, () => RED);
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({
		transport: terminal.transport,
		cellSize: {width: 7, height: 15},
	});
	dom.document.body.innerHTML =
		`<img id=natural src="${wide}">` +
		`<img id=styled src="${wide}" style="width: 56px; height: 45px">` +
		`<img id=attributes src="${wide}" width="14" height="15">` +
		`<img id=ratio src="${wide}" style="display: block; height: 45px">`;
	for (const image of dom.document.querySelectorAll("img")) {
		await loaded(image as HTMLImageElement);
	}
	await nextFrame(dom);
	const cells = (id: string) => {
		const rect = dom.document.getElementById(id)!.getBoundingClientRect();
		return [rect.width / 7, rect.height / 15];
	};
	expect(cells("natural")).toEqual([10, 2]);
	expect(cells("styled")).toEqual([8, 3]);
	expect(cells("attributes")).toEqual([2, 1]);
	expect(cells("ratio")).toEqual([15, 3]);
	dom.dispose();
});

test("a new src cancels the request the old one started", async () => {
	const original = globalThis.fetch;
	const signals: AbortSignal[] = [];
	try {
		globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
			const signal = init!.signal!;
			signals.push(signal);
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
			});
		}) as typeof fetch;
		const {dom, document} = await mount("<img id=i>");
		const image = document.getElementById("i") as HTMLImageElement;
		image.src = "https://example.com/first.png";
		image.src = "https://example.com/second.png";
		expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
		dom.dispose();
	} finally {
		globalThis.fetch = original;
	}
});

test("an image whose box is past the pixel limit paints nothing", async () => {
	const square = png(4, 4, () => RED);
	const {dom, terminal, document} = await mount(
		`<img src="${square}" style="display: block; width: 50000px; height: 50000px">`,
	);
	await loaded(document.querySelector("img")!);
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).bg).toBe(-1);
	dom.dispose();
});
