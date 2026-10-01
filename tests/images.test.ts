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
	encodePNG,
	readDataURL,
	resolveImageURL,
	sampleBitmap,
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

test("data: URLs decode percent-encoded bytes, binary ones included", () => {
	const bytes = readDataURL("data:application/octet-stream,%89PNG%0d%0a");
	expect(Array.from(bytes!)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
	expect(Array.from(readDataURL("data:;base64,AQ%3D%3D")!)).toEqual([1]);
});

test("a Windows path is a file URL, not a URL with a drive-letter scheme", () => {
	expect(resolveImageURL("C:\\art\\cover.png", "about:blank")).toBe(
		"file:///C:/art/cover.png",
	);
});

test("data: URLs decode base64 and percent-encoding", () => {
	expect(Array.from(readDataURL("data:image/png;base64,AQID")!)).toEqual([
		1,
		2,
		3,
	]);
	expect(new TextDecoder().decode(readDataURL("data:,a%20b")!)).toBe("a b");
	expect(readDataURL("https://example.com/a.png")).toBeNull();
});

test("a relative src resolves against the document, or the working directory", () => {
	expect(resolveImageURL("b.png", "https://example.com/a/")).toBe(
		"https://example.com/a/b.png",
	);
	const local = resolveImageURL("art/cover.png", "about:blank");
	expect(local?.startsWith("file:///")).toBe(true);
	expect(local?.endsWith("/art/cover.png")).toBe(true);
});
