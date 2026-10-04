/**
 * Image decoding
 *
 * Every decoder reads the same picture: 16 by 16 pixels in four
 * quadrants, red and green over blue and white, saved by ImageMagick in
 * each format and variant the decoders handle. A pixel is read from the
 * middle of each quadrant. Lossless formats match exactly; JPEG is
 * allowed the error its quantization leaves.
 */

import {expect, test} from "@b9g/libuild/test";

import {
	type Bitmap,
	decodeImage,
	decodeImageOffThread,
	encodePNG,
	MAX_IMAGE_BYTES,
	readImageResponse,
	resolveImageURL,
	sampleBitmap,
	setDecodeTimeout,
	setDecodeWorkerURL,
	sniffImageType,
} from "../src/internal/images.ts";
import {IMAGES} from "./fixtures/images.ts";

function bytesOf(name: string): Uint8Array {
	const binary = atob(IMAGES[name]);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function pixel(bitmap: Bitmap, x: number, y: number): number[] {
	const at = (y * bitmap.width + x) * 4;
	return Array.from(bitmap.data.subarray(at, at + 4));
}

const QUADRANTS: Array<[number, number, number[]]> = [
	[3, 3, [255, 0, 0]],
	[12, 3, [0, 255, 0]],
	[3, 12, [0, 0, 255]],
	[12, 12, [255, 255, 255]],
];

function expectQuadrants(bitmap: Bitmap, tolerance: number): void {
	expect(bitmap.width).toBe(16);
	expect(bitmap.height).toBe(16);
	for (const [x, y, rgb] of QUADRANTS) {
		const [r, g, b, a] = pixel(bitmap, x, y);
		expect(Math.abs(r - rgb[0])).toBeLessThanOrEqual(tolerance);
		expect(Math.abs(g - rgb[1])).toBeLessThanOrEqual(tolerance);
		expect(Math.abs(b - rgb[2])).toBeLessThanOrEqual(tolerance);
		expect(a).toBe(255);
	}
}

for (const name of [
	"png-rgb.png",
	"png-palette.png",
	"png-rgb16.png",
	"png-interlaced.png",
	"gif.gif",
	"gif-interlaced.gif",
	"bmp-24.bmp",
	"bmp-4.bmp",
	"bmp-rle8.bmp",
]) {
	test(`decodes ${name} pixel for pixel`, async () => {
		expectQuadrants(await decodeImage(bytesOf(name)), 0);
	});
}

for (const name of [
	"jpeg-444.jpg",
	"jpeg-420.jpg",
	"jpeg-progressive.jpg",
	"jpeg-restart.jpg",
	"jpeg-progressive-restart.jpg",
	"jpeg-cmyk.jpg",
]) {
	test(`decodes ${name} within JPEG's error`, async () => {
		expectQuadrants(await decodeImage(bytesOf(name)), 12);
	});
}

test("grayscale images decode to equal channels", async () => {
	for (const name of ["png-gray.png", "jpeg-gray.jpg"]) {
		const bitmap = await decodeImage(bytesOf(name));
		for (const [x, y] of QUADRANTS) {
			const [r, g, b, a] = pixel(bitmap, x, y);
			expect(r).toBe(g);
			expect(g).toBe(b);
			expect(a).toBe(255);
		}
		// White stays white and blue is the darkest of the four.
		expect(pixel(bitmap, 12, 12)[0]).toBeGreaterThan(250);
		expect(pixel(bitmap, 3, 12)[0]).toBeLessThan(pixel(bitmap, 3, 3)[0]);
	}
});

test("one-bit images decode to black and white", async () => {
	for (const name of ["png-mono.png", "bmp-1.bmp"]) {
		const bitmap = await decodeImage(bytesOf(name));
		expect(pixel(bitmap, 3, 3)).toEqual([0, 0, 0, 255]);
		expect(pixel(bitmap, 12, 3)).toEqual([255, 255, 255, 255]);
		expect(pixel(bitmap, 3, 12)).toEqual([255, 255, 255, 255]);
		expect(pixel(bitmap, 12, 12)).toEqual([0, 0, 0, 255]);
	}
});

test("alpha comes through: an alpha channel, tRNS, and GIF and BMP transparency", async () => {
	const rgba = await decodeImage(bytesOf("png-rgba.png"));
	const [r, g, b, a] = pixel(rgba, 3, 3);
	expect([r, g, b]).toEqual([255, 0, 0]);
	expect(Math.abs(a - 128)).toBeLessThanOrEqual(1);
	expect(pixel(rgba, 12, 12)).toEqual([255, 255, 255, 255]);

	for (const name of [
		"png-palette-alpha.png",
		"gif-transparent.gif",
		"bmp-32.bmp",
	]) {
		const bitmap = await decodeImage(bytesOf(name));
		expect(pixel(bitmap, 3, 3)[3]).toBe(0);
		expect(pixel(bitmap, 12, 3)).toEqual([0, 255, 0, 255]);
	}
});

test("the format is sniffed from the bytes, not named", () => {
	expect(sniffImageType(bytesOf("png-rgb.png"))).toBe("image/png");
	expect(sniffImageType(bytesOf("jpeg-444.jpg"))).toBe("image/jpeg");
	expect(sniffImageType(bytesOf("gif.gif"))).toBe("image/gif");
	expect(sniffImageType(bytesOf("bmp-24.bmp"))).toBe("image/bmp");
	expect(sniffImageType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
});

test("an unknown format or damaged data rejects", async () => {
	let error: unknown = null;
	try {
		await decodeImage(new TextEncoder().encode("<svg></svg>"));
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);

	const truncated = bytesOf("png-rgb.png").subarray(0, 40);
	error = null;
	try {
		await decodeImage(truncated);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
});

// An Exif APP1 segment holding only an orientation, after SOI.
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
	const tiff = [
		0x49,
		0x49,
		0x2a,
		0,
		8,
		0,
		0,
		0,
		1,
		0,
		0x12,
		0x01,
		3,
		0,
		1,
		0,
		0,
		0,
		orientation,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
	];
	const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
	const segment = [0xff, 0xe1, 0, body.length + 2, ...body];
	return Uint8Array.from([0xff, 0xd8, ...segment, ...jpeg.subarray(2)]);
}

test("a JPEG's Exif orientation turns the image, as browsers do by default", async () => {
	const source = bytesOf("jpeg-444.jpg");
	// 6: rotate 90 degrees clockwise. Red moves from top left to top right.
	const turned = await decodeImage(withOrientation(source, 6));
	expect(pixel(turned, 12, 3)[0]).toBeGreaterThan(240);
	expect(pixel(turned, 12, 3)[1]).toBeLessThan(16);
	// Blue moves from bottom left to top left.
	expect(pixel(turned, 3, 3)[2]).toBeGreaterThan(240);
	// 3: half a turn. White moves to top left.
	const flipped = await decodeImage(withOrientation(source, 3));
	expect(pixel(flipped, 3, 3).slice(0, 3).every((c) => c > 240)).toBe(true);
	// 2: mirrored. Green moves to top left.
	const mirrored = await decodeImage(withOrientation(source, 2));
	expect(pixel(mirrored, 3, 3)[1]).toBeGreaterThan(240);
	expect(pixel(mirrored, 3, 3)[0]).toBeLessThan(16);
});

test("encodePNG writes a PNG the decoder reads back exactly", async () => {
	const bitmap: Bitmap = {
		width: 3,
		height: 2,
		data: new Uint8ClampedArray([
			255,
			0,
			0,
			255,
			0,
			255,
			0,
			128,
			0,
			0,
			255,
			0,
			10,
			20,
			30,
			40,
			50,
			60,
			70,
			80,
			90,
			100,
			110,
			120,
		]),
	};
	const png = encodePNG(bitmap);
	expect(sniffImageType(png)).toBe("image/png");
	const back = await decodeImage(png);
	expect(back.width).toBe(3);
	expect(back.height).toBe(2);
	expect(Array.from(back.data)).toEqual(Array.from(bitmap.data));
});

test("encodePNG splits data past one stored block", async () => {
	const width = 200;
	const height = 100;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i++) {
		data[i] = (i * 7) & 0xff;
	}
	const back = await decodeImage(encodePNG({width, height, data}));
	expect(Array.from(back.data.subarray(0, 64))).toEqual(
		Array.from(data.subarray(0, 64)),
	);
	expect(back.data[data.length - 1]).toBe(data[data.length - 1]);
});

test("sampling averages the pixels a cell half covers, weighted by alpha", () => {
	// Two by two: red, transparent / blue, blue.
	const bitmap: Bitmap = {
		width: 2,
		height: 2,
		data: new Uint8ClampedArray([
			255,
			0,
			0,
			255,
			0,
			255,
			0,
			0,
			0,
			0,
			255,
			255,
			0,
			0,
			255,
			255,
		]),
	};
	// One column, one cell: the top half averages red with a transparent
	// pixel whose green must not bleed in.
	const out = sampleBitmap(bitmap, 1, 2);
	expect(Array.from(out.subarray(0, 4))).toEqual([255, 0, 0, 128]);
	expect(Array.from(out.subarray(4, 8))).toEqual([0, 0, 255, 255]);
	// Scaled up, each output pixel is the nearest source pixel.
	const up = sampleBitmap(bitmap, 4, 4);
	expect(Array.from(up.subarray(0, 4))).toEqual([255, 0, 0, 255]);
	expect(Array.from(up.subarray((3 * 4 + 3) * 4, (3 * 4 + 3) * 4 + 4)))
		.toEqual([0, 0, 255, 255]);
});

test("a Windows path is a file URL, not a URL with a drive-letter scheme", () => {
	expect(resolveImageURL("C:\\art\\cover.png", "about:blank")).toBe(
		"file:///C:/art/cover.png",
	);
});

test("a relative src resolves against the document, or the working directory", () => {
	expect(resolveImageURL("b.png", "https://example.com/a/")).toBe(
		"https://example.com/a/b.png",
	);
	const local = resolveImageURL("art/cover.png", "about:blank");
	expect(local?.startsWith("file:///")).toBe(true);
	expect(local?.endsWith("/art/cover.png")).toBe(true);
});

// Images that ask for more than they are: a header's size, a stream
// that inflates past its image, more scans or components than an image
// has, or more bytes than an image file may have.

function patched(name: string, at: number, ...values: number[]): Uint8Array {
	const bytes = bytesOf(name).slice();
	bytes.set(values, at);
	return bytes;
}

function findMarker(bytes: Uint8Array, marker: number): number {
	for (let i = 2; i < bytes.length - 1; i++) {
		if (bytes[i] === 0xff && bytes[i + 1] === marker) {
			return i;
		}
	}
	throw new Error(`no marker ${marker.toString(16)}`);
}

test("a size no image may have rejects before it is allocated", async () => {
	const big = [0x00, 0x01, 0x86, 0xa0];
	await expect(decodeImage(patched("png-rgb.png", 16, ...big, ...big)))
		.rejects.toThrow("more than an image may be");
	await expect(decodeImage(patched("png-rgb.png", 16, 0, 0, 0x9c, 0x40)))
		.rejects.toThrow("more than an image may be");
	const sof = findMarker(bytesOf("jpeg-444.jpg"), 0xc0);
	await expect(
		decodeImage(patched("jpeg-444.jpg", sof + 5, 0xff, 0xff, 0xff, 0xff)),
	).rejects.toThrow("more than an image may be");
	await expect(decodeImage(patched("gif.gif", 6, 0xff, 0xff, 0xff, 0xff)))
		.rejects.toThrow("more than an image may be");
	await expect(
		decodeImage(
			patched("bmp-24.bmp", 18, 0xa0, 0x86, 0x01, 0x00, 0xa0, 0x86, 0x01, 0x00),
		),
	).rejects.toThrow("more than an image may be");
});

test("a JPEG with more components, sampling or scans than an image has rejects", async () => {
	const sof = findMarker(bytesOf("jpeg-444.jpg"), 0xc0);
	await expect(decodeImage(patched("jpeg-444.jpg", sof + 9, 5)))
		.rejects.toThrow("more than four components");
	await expect(decodeImage(patched("jpeg-444.jpg", sof + 11, 0x55)))
		.rejects.toThrow("past four");
	// The last scan again and again, ahead of the end marker.
	const bytes = bytesOf("jpeg-progressive.jpg");
	let last = -1;
	for (let at = findMarker(bytes, 0xda); at !== -1;) {
		last = at;
		let next = -1;
		for (let i = at + 2; i < bytes.length - 1; i++) {
			if (bytes[i] === 0xff && bytes[i + 1] === 0xda) {
				next = i;
				break;
			}
		}
		at = next;
	}
	const end = bytes.length - 2;
	const scan = bytes.subarray(last, end);
	const many = new Uint8Array(last + scan.length * 501 + 2);
	many.set(bytes.subarray(0, last));
	for (let i = 0; i < 501; i++) {
		many.set(scan, last + i * scan.length);
	}
	many.set([0xff, 0xd9], many.length - 2);
	await expect(decodeImage(many)).rejects.toThrow("more than 500 scans");
});

test("a GIF frame's code size past 8 bits rejects", async () => {
	const bytes = bytesOf("gif.gif");
	const descriptor = bytes.indexOf(0x2c, 13);
	const flags = bytes[descriptor + 9];
	const table = flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0;
	await expect(decodeImage(patched("gif.gif", descriptor + 10 + table, 12)))
		.rejects.toThrow("code size");
});

test("PNG data that inflates past its image is read only as far as the image", async () => {
	// 16 by 16 gray, filter byte 0 and a ramp on each row, and then
	// megabytes of zeros the image has no room for.
	const raw = new Uint8Array(16 * 17 + (1 << 24));
	for (let y = 0; y < 16; y++) {
		for (let x = 0; x < 16; x++) {
			raw[y * 17 + 1 + x] = x * 16;
		}
	}
	const deflated = new Uint8Array(
		await new Response(
			new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
		).arrayBuffer(),
	);
	const header = new Uint8Array(13);
	header.set([0, 0, 0, 16, 0, 0, 0, 16, 8, 0, 0, 0, 0]);
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.length);
		new DataView(out.buffer).setUint32(0, data.length);
		out.set([...type].map((c) => c.charCodeAt(0)), 4);
		out.set(data, 8);
		return out;
	};
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflated),
		chunk("IEND", new Uint8Array(0)),
	];
	const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		png.set(part, at);
		at += part.length;
	}
	const bitmap = await decodeImage(png);
	expect([bitmap.width, bitmap.height]).toEqual([16, 16]);
	expect(pixel(bitmap, 15, 15)).toEqual([240, 240, 240, 255]);
});

test("an image response past the byte limit is not read whole", async () => {
	const piece = new Uint8Array(1 << 20);
	const declared = new Response(piece, {
		headers: {"content-length": String(MAX_IMAGE_BYTES + 1)},
	});
	await expect(readImageResponse(declared)).rejects.toThrow("more than");
	let pulled = 0;
	const endless = new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(piece);
			},
		}),
	);
	await expect(readImageResponse(endless)).rejects.toThrow("more than");
	expect(pulled).toBeLessThanOrEqual(MAX_IMAGE_BYTES / piece.length + 2);
	await expect(readImageResponse(new Response(null, {status: 404})))
		.rejects.toThrow("status 404");
});

// A worker from source text: it reports ready, then answers each
// request as `reply` says, or never.
function fakeWorker(reply: string): URL {
	const source =
		"const t = globalThis.process?.getBuiltinModule?.(\"node:worker_threads\");" +
		"const port = t?.parentPort ?? globalThis;" +
		"const answer = (data) => {" +
		reply +
		"};" +
		"if (t?.parentPort) t.parentPort.on(\"message\", answer);" +
		"else globalThis.addEventListener(\"message\", (e) => answer(e.data));" +
		"port.postMessage({ready: true});";
	return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

test("a decode that runs past its time on the worker fails, and the next one starts over", async () => {
	try {
		setDecodeTimeout(50);
		setDecodeWorkerURL(fakeWorker(""));
		await expect(decodeImageOffThread(bytesOf("png-rgb.png")))
			.rejects.toThrow("more than 50 ms");
		setDecodeTimeout(10_000);
		setDecodeWorkerURL(
			fakeWorker("port.postMessage({id: data.id, error: \"from the worker\"})"),
		);
		await expect(decodeImageOffThread(bytesOf("png-rgb.png")))
			.rejects.toThrow("from the worker");
	} finally {
		setDecodeTimeout(10_000);
		setDecodeWorkerURL(null);
	}
});

test("where no worker starts, images decode on this thread", async () => {
	try {
		setDecodeWorkerURL(
			new URL(
				`data:text/javascript,${encodeURIComponent("throw new Error(\"no\");")}`,
			),
		);
		const bitmap = await decodeImageOffThread(bytesOf("png-rgb.png"));
		expect([bitmap.width, bitmap.height]).toEqual([16, 16]);
		setDecodeWorkerURL(null);
		const again = await decodeImageOffThread(bytesOf("png-rgb.png"));
		expect(again.width).toBe(16);
	} finally {
		setDecodeWorkerURL(null);
	}
});
