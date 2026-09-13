/**
 * `<img>`: the box it lays out as, the alt text it falls back to, and the
 * escape sequences that put pixels in a terminal that can show them.
 *
 * The PNGs are built here rather than checked in, so every byte a test
 * asserts about -- the signature, the IHDR dimensions, the payload the
 * terminal is handed -- is one this file wrote.
 */
import {deflateSync} from "node:zlib";

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let value = i;
	for (let bit = 0; bit < 8; bit++) {
		value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	}
	CRC_TABLE[i] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(body.length + 12);
	const view = new DataView(out.buffer);
	view.setUint32(0, body.length);
	for (let i = 0; i < 4; i++) {
		out[4 + i] = type.charCodeAt(i);
	}
	out.set(body, 8);
	view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
	return out;
}

/** A real, decodable PNG: 8-bit truecolor, one solid color, no interlace. */
function makePNG(width: number, height: number): Uint8Array {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8;
	header[9] = 2;

	// Every scanline is a filter byte and then three bytes a pixel.
	const raw = new Uint8Array(height * (1 + width * 3));
	for (let row = 0; row < height; row++) {
		const start = row * (1 + width * 3);
		for (let i = 0; i < width * 3; i++) {
			raw[start + 1 + i] = i % 3 === 0 ? 0xd7 : 0x5f;
		}
	}

	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", new Uint8Array(deflateSync(raw))),
		chunk("IEND", new Uint8Array(0)),
	];
	const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		png.set(part, at);
		at += part.length;
	}
	return png;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function toDataURL(bytes: Uint8Array): string {
	return `data:image/png;base64,${toBase64(bytes)}`;
}

/**
 * A mock whose replies to the startup questions are this test's, not the
 * headless emulator's: each pattern that matches an outgoing write is
 * stripped from it and its answer is fed back on stdin.
 *
 * The stripping matters. xterm-headless answers XTWINOPS itself with the
 * pixel size of a terminal that has no window, and an unstripped kitty
 * query would sit in the emulator's buffer as text.
 */
function scriptReplies(
	terminal: MockProcess,
	answers: Array<{ask: string; reply: string | null}>,
): void {
	const stdout =
		terminal.stdout as unknown as {write: (...args: unknown[]) => boolean};
	const stdin =
		terminal.stdin as unknown as {simulateResponse: (data: string) => void};
	const original = stdout.write.bind(stdout);
	stdout.write = (...args: unknown[]) => {
		let data = String(args[0]);
		let matched = false;
		for (const {ask, reply} of answers) {
			if (!data.includes(ask)) {
				continue;
			}
			matched = true;
			data = data.replace(ask, "");
			if (reply !== null) {
				setTimeout(() => stdin.simulateResponse(reply), 0);
			}
		}
		if (!matched) {
			return original(...args);
		}
		if (data) {
			return original(data, ...args.slice(1));
		}
		// A swallowed write still has to complete: the transport's sink
		// resolves on the callback, and everything queued behind it waits.
		const callback = args.find((arg) => typeof arg === "function");
		if (callback) {
			(callback as () => void)();
		}
		return true;
	};
}

const CELL_SIZE_QUERY = "\x1b[16t";

/** Wait for a condition a reply or a load has to arrive before. */
async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/* ------------------------------------------------------------ the box */

test("an img with no src lays out as its alt text", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<img alt=\"a picture\">";
	await nextFrame(dom);

	const img = dom.document.querySelector("img")!;
	const rect = img.getBoundingClientRect();
	expect(rect.width).toBe("a picture".length);
	expect(rect.height).toBe(1);
	expect(terminal.getPlainText()).toContain("a picture");

	dom.dispose();
});

test("width and height size the box and clip the alt text", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<img width=\"10\" height=\"2\" alt=\"an alt far wider than ten cells\">";
	await nextFrame(dom);

	const img = dom.document.querySelector("img")!;
	const rect = img.getBoundingClientRect();
	expect(rect.width).toBe(10);
	expect(rect.height).toBe(2);

	const first = terminal.getPlainText().split("\n")[0];
	expect(first).toBe("an alt far");

	dom.dispose();
});

test("an empty alt with no image is an empty box", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<img alt=\"\">";
	await nextFrame(dom);

	const img = dom.document.querySelector("img")!;
	expect(img.getBoundingClientRect().width).toBe(0);
	expect(terminal.getPlainText().trim()).toBe("");

	dom.dispose();
});

/* -------------------------------------------------------- loading */

test("a data: PNG loads, reports its natural size, and sizes its box", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		`<img alt="tiny" src="${toDataURL(makePNG(4, 2))}">`;
	const img = dom.document.querySelector("img")!;
	let loaded = false;
	img.addEventListener("load", () => (loaded = true));
	await nextFrame(dom);
	await until(() => loaded);

	expect(loaded).toBe(true);
	expect(img.naturalWidth).toBe(4);
	expect(img.naturalHeight).toBe(2);
	expect(img.complete).toBe(true);
	expect(img.currentSrc).toBe(img.src);
	await expect(img.decode()).resolves.toBe(undefined);

	await nextFrame(dom);
	// A cell is 8 by 16 pixels until the terminal says otherwise, so four
	// pixels across and two down do not fill even one of them.
	const rect = img.getBoundingClientRect();
	expect(rect.width).toBe(1);
	expect(rect.height).toBe(1);

	dom.dispose();
});

test("the box divides the image by the cell size the terminal reports", async () => {
	const wide = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: wide.transport});
	dom.document.body.innerHTML =
		`<img alt="big" src="${toDataURL(makePNG(40, 32))}">`;
	const img = dom.document.querySelector("img")!;
	await nextFrame(dom);
	await until(() => img.complete && img.naturalWidth === 40);
	await nextFrame(dom);

	// 40 by 32 pixels over the default 8 by 16 cell.
	expect(img.getBoundingClientRect().width).toBe(5);
	expect(img.getBoundingClientRect().height).toBe(2);
	dom.dispose();

	const narrow = new MockProcess({cols: 40, rows: 8});
	// CSI 6 ; height ; width t: cells four pixels wide and sixteen tall.
	scriptReplies(narrow, [{ask: CELL_SIZE_QUERY, reply: "\x1b[6;16;4t"}]);
	const narrowDOM = new TermDOM({transport: narrow.transport});
	narrowDOM.document.body.innerHTML =
		`<img alt="big" src="${toDataURL(makePNG(40, 32))}">`;
	const narrowImg = narrowDOM.document.querySelector("img")!;
	await nextFrame(narrowDOM);
	await until(() =>
		narrowImg.complete && narrowImg.getBoundingClientRect().width === 10);
	await nextFrame(narrowDOM);

	expect(narrowImg.getBoundingClientRect().width).toBe(10);
	expect(narrowImg.getBoundingClientRect().height).toBe(2);

	narrowDOM.dispose();
});

test("a missing file fires error and keeps the alt box", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		"<img alt=\"not there\" src=\"tests/__no_such_image__.png\">";
	const img = dom.document.querySelector("img")!;
	let failed = false;
	img.addEventListener("error", () => (failed = true));
	await nextFrame(dom);
	await until(() => failed);

	expect(failed).toBe(true);
	expect(img.naturalWidth).toBe(0);
	expect(img.complete).toBe(true);
	await expect(img.decode()).rejects.toThrow();

	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("not there");
	expect(img.getBoundingClientRect().width).toBe("not there".length);

	dom.dispose();
});

test("changing src reloads", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<img alt="x" src="${
		toDataURL(makePNG(4, 2))
	}">`;
	const img = dom.document.querySelector("img")!;
	await nextFrame(dom);
	await until(() => img.naturalWidth === 4);

	img.setAttribute("src", toDataURL(makePNG(64, 16)));
	expect(img.complete).toBe(false);
	await until(() => img.naturalWidth === 64);
	expect(img.naturalHeight).toBe(16);

	dom.dispose();
});
