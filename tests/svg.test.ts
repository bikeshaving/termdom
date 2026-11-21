/**
 * SVG images
 *
 * An SVG file in an <img> is drawn with the canvas's rasterizer and then
 * shown as any other image is. Its natural size is its own, in CSS
 * pixels, and the pixels drawn for it are more or fewer than that, so
 * the tests read a pixel by where it is in the image, not in the bitmap.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {decodeImage, sniffImageType} from "../src/internal/imagecodecs.ts";
import {type Bitmap, MAX_KEPT_PIXELS} from "../src/internal/images.ts";
import {MAX_SVG_BYTES, rasterizeSVG} from "../src/internal/svg.ts";
import {MockProcess, nextFrame} from "./test-utils.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function draw(svg: string, deadline?: number): Promise<Bitmap> {
	return rasterizeSVG(encode(svg), deadline);
}

/** The pixel under the middle of the image's own pixel at `x`, `y`. */
function pixel(bitmap: Bitmap, x: number, y: number): number[] {
	const col = Math.floor(((x + 0.5) * bitmap.width) / bitmap.naturalWidth!);
	const row = Math.floor(((y + 0.5) * bitmap.height) / bitmap.naturalHeight!);
	return [
		...bitmap.data.subarray((row * bitmap.width + col) * 4).subarray(0, 4),
	];
}

const RED = [255, 0, 0, 255];
const LIME = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const BLACK = [0, 0, 0, 255];
const CLEAR = [0, 0, 0, 0];

async function rejects(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as Error).message;
	}
	return "";
}

test("shapes, groups, transforms and a viewBox are drawn", async () => {
	const bitmap = await draw(
		`<?xml version="1.0"?>
		<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 20 10">
			<rect width="5" height="10" fill="#f00"/>
			<g fill="#00f" transform="translate(10 0)">
				<path d="M0 0h5v10h-5z"/>
				<circle cx="7.5" cy="5" r="2" style="fill:lime"/>
			</g>
			<path d="M6 5h3" stroke="#000" stroke-width="2" fill="none"/>
			<polygon points="0,0 2,0 2,2 0,2" fill="blue" transform="translate(6 8)"/>
			<line x1="18" y1="0" x2="20" y2="0" stroke="red" stroke-width="2"/>
			<ellipse cx="7" cy="1" rx="1" ry="0.5" fill="lime"/>
		</svg>`,
	);
	expect([bitmap.naturalWidth, bitmap.naturalHeight]).toEqual([40, 20]);
	expect(pixel(bitmap, 4, 10)).toEqual(RED);
	expect(pixel(bitmap, 24, 10)).toEqual(BLUE);
	expect(pixel(bitmap, 35, 10)).toEqual(LIME);
	expect(pixel(bitmap, 15, 10)).toEqual(BLACK);
	expect(pixel(bitmap, 15, 5)).toEqual(CLEAR);
	expect(pixel(bitmap, 14, 18)).toEqual(BLUE);
	expect(pixel(bitmap, 38, 0)).toEqual(RED);
	expect(pixel(bitmap, 14, 2)).toEqual(LIME);
	expect(pixel(bitmap, 30, 19)).toEqual(CLEAR);
});

test("an even-odd path leaves its hole", async () => {
	const bitmap = await draw(
		`<svg viewBox="0 0 10 10" width="10" height="10"><path fill-rule="evenodd" d="M0 0h10v10H0zM3 3h4v4H3z"/></svg>`,
	);
	expect(pixel(bitmap, 1, 1)).toEqual(BLACK);
	expect(pixel(bitmap, 5, 5)).toEqual(CLEAR);
});

test("currentColor is black, or the color the file gives", async () => {
	const plain = await draw(
		`<svg width="4" height="4"><rect width="4" height="4" fill="currentColor"/></svg>`,
	);
	expect(pixel(plain, 2, 2)).toEqual(BLACK);
	const colored = await draw(
		`<svg width="4" height="4" color="#102030"><g><rect width="4" height="2" fill="currentColor"/><rect y="2" width="4" height="2" color="red" stroke="currentColor" fill="currentcolor"/></g></svg>`,
	);
	expect(pixel(colored, 2, 0)).toEqual([16, 32, 48, 255]);
	expect(pixel(colored, 2, 3)).toEqual(RED);
});

test("the natural size is the file's, in CSS pixels", async () => {
	const size = async (attributes: string): Promise<number[]> => {
		const bitmap = await draw(`<svg ${attributes}></svg>`);
		return [bitmap.naturalWidth!, bitmap.naturalHeight!];
	};
	expect(await size("width=\"40\" height=\"20\"")).toEqual([40, 20]);
	expect(await size("width=\"1in\" height=\"12pt\"")).toEqual([96, 16]);
	// A missing side keeps the viewBox's proportions.
	expect(await size("viewBox=\"0 0 24 12\"")).toEqual([24, 12]);
	expect(await size("width=\"48\" viewBox=\"0 0 24 12\"")).toEqual([48, 24]);
	expect(await size("height=\"6\" viewBox=\"0 0 24 12\"")).toEqual([12, 6]);
	// A percentage is a share of nothing, and no size at all is 300 by 150.
	expect(await size("width=\"100%\" height=\"100%\" viewBox=\"0 0 8 8\""))
		.toEqual([8, 8]);
	expect(await size("")).toEqual([300, 150]);
	expect(await size("width=\"50\"")).toEqual([50, 150]);
});

test("a small image is drawn finer than it measures, and a huge one coarser", async () => {
	const icon = await draw(
		`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>`,
	);
	expect([icon.naturalWidth, icon.naturalHeight]).toEqual([24, 24]);
	expect(icon.width).toBe(24 * 16);
	expect(icon.full).toBeUndefined();
	// The edge of the circle is a curve at that size, not a 24 pixel stair.
	expect(pixel(icon, 12, 12)).toEqual(BLACK);
	expect(icon.data[(Math.round(icon.height / 2) * icon.width + 33) * 4 + 3])
		.toBe(255);
	expect(icon.data[(Math.round(icon.height / 2) * icon.width + 30) * 4 + 3])
		.toBe(0);
	const huge = await draw(
		`<svg width="4000" height="2000"><rect width="2000" height="2000" fill="red"/></svg>`,
	);
	expect([huge.naturalWidth, huge.naturalHeight]).toEqual([4000, 2000]);
	expect(huge.width * huge.height).toBeLessThanOrEqual(MAX_KEPT_PIXELS);
	expect(pixel(huge, 1000, 1000)).toEqual(RED);
	expect(pixel(huge, 3000, 1000)).toEqual(CLEAR);
});

test("preserveAspectRatio places the viewBox in the image", async () => {
	const at = async (preserve: string, x: number, y: number) =>
		pixel(
			await draw(
				`<svg width="20" height="10" viewBox="0 0 10 10" preserveAspectRatio="${preserve}"><rect width="10" height="10" fill="red"/></svg>`,
			),
			x,
			y,
		);
	// The default centers it, and leaves the sides clear.
	expect(await at("xMidYMid", 2, 5)).toEqual(CLEAR);
	expect(await at("xMidYMid", 10, 5)).toEqual(RED);
	expect(await at("xMinYMin meet", 2, 5)).toEqual(RED);
	expect(await at("xMinYMin meet", 17, 5)).toEqual(CLEAR);
	expect(await at("xMaxYMax", 17, 5)).toEqual(RED);
	expect(await at("none", 2, 5)).toEqual(RED);
	expect(await at("none", 17, 5)).toEqual(RED);
	expect(await at("xMidYMid slice", 1, 5)).toEqual(RED);
});

test("a style sheet, a style attribute and an attribute each paint", async () => {
	const bitmap = await draw(
		`<svg width="50" height="10">
			<style><![CDATA[
				/* a comment */
				rect { fill: blue }
				.a, .unused { fill: red; }
				rect.a.b { fill: lime }
				#one { fill: #102030 !important }
				g > rect { fill: black }
			]]></style>
			<rect width="10" height="10" fill="red"/>
			<rect x="10" width="10" height="10" class="a"/>
			<rect x="20" width="10" height="10" class="b a"/>
			<rect x="30" width="10" height="10" class="a b" id="one"/>
			<rect x="40" width="10" height="10" class="a" style="fill: lime"/>
		</svg>`,
	);
	// A rule wins over an attribute, the more specific rule over the less,
	// and the style attribute over them all.
	expect(pixel(bitmap, 5, 5)).toEqual(BLUE);
	expect(pixel(bitmap, 15, 5)).toEqual(RED);
	expect(pixel(bitmap, 25, 5)).toEqual(LIME);
	expect(pixel(bitmap, 35, 5)).toEqual([16, 32, 48, 255]);
	expect(pixel(bitmap, 45, 5)).toEqual(LIME);
});

test("an entity the doctype declares is written out", async () => {
	const bitmap = await draw(
		`<?xml version="1.0"?>
		<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd" [
			<!ENTITY st0 "fill:red;">
			<!ENTITY st1 'fill:&st0;blue'>
		]>
		<svg width="30" height="10">
			<rect width="10" height="10" style="&st0;"/>
			<rect x="10" width="10" height="10" style="&st1;"/>
			<rect x="20" width="10" height="10" style="&st2;" fill="lime"/>
		</svg>`,
	);
	expect(pixel(bitmap, 5, 5)).toEqual(RED);
	// An entity inside an entity is left as it is written.
	expect(pixel(bitmap, 15, 5)).toEqual(BLACK);
	expect(pixel(bitmap, 25, 5)).toEqual(LIME);
	const many =
		`<!DOCTYPE svg [<!ENTITY a "${"x".repeat(1 << 16)}">]>` +
		`<svg><desc>${"&a;".repeat(100)}</desc></svg>`;
	expect(await rejects(draw(many))).toContain("is more than");
});

test("a linear gradient runs across the box of the shape it paints", async () => {
	const bitmap = await draw(
		`<svg width="100" height="20">
			<defs>
				<linearGradient id="base">
					<stop offset="0" stop-color="red"/>
					<stop offset="100%" style="stop-color: blue"/>
				</linearGradient>
				<linearGradient id="down" href="#base" x2="0" y2="1"/>
				<linearGradient id="user" xlink:href="#base" gradientUnits="userSpaceOnUse" x1="60" x2="80"/>
			</defs>
			<rect x="10" width="40" height="10" fill="url(#base)"/>
			<rect x="10" y="10" width="40" height="10" fill="url(#down)"/>
			<rect x="50" width="50" height="20" fill="url(#user)"/>
		</svg>`,
	);
	const [left, middle, right] = [10, 30, 49].map((x) => pixel(bitmap, x, 5));
	expect(left[0]).toBeGreaterThan(240);
	expect(left[2]).toBeLessThan(16);
	expect(Math.abs(middle[0] - middle[2])).toBeLessThan(16);
	expect(right[2]).toBeGreaterThan(240);
	// The one that names it takes its stops, and runs its own way.
	expect(pixel(bitmap, 12, 10)[0]).toBeGreaterThan(220);
	expect(pixel(bitmap, 48, 10)[0]).toBeGreaterThan(220);
	expect(pixel(bitmap, 30, 19)[2]).toBeGreaterThan(220);
	// In user space the gradient is where it says, whatever it paints.
	expect(pixel(bitmap, 52, 10)).toEqual(RED);
	expect(pixel(bitmap, 70, 10)[0]).toBeGreaterThan(100);
	expect(pixel(bitmap, 70, 10)[2]).toBeGreaterThan(100);
	expect(pixel(bitmap, 95, 10)).toEqual(BLUE);
});

test("a gradient takes a transform, an opacity and a stroke", async () => {
	const bitmap = await draw(
		`<svg width="20" height="20">
			<linearGradient id="turned" gradientTransform="rotate(90 0.5 0.5)">
				<stop offset="0" stop-color="red"/>
				<stop offset="1" stop-color="blue" stop-opacity="0"/>
			</linearGradient>
			<rect width="20" height="10" fill="url(#turned)"/>
			<path d="M0 15h20" stroke="url(#turned) lime" stroke-width="4"/>
			<rect y="18" width="20" height="2" fill="url(#missing) lime"/>
			<rect y="18" width="2" height="2" fill="url(#missing)"/>
		</svg>`,
	);
	// Turned a quarter, across becomes down: every column is the same.
	expect(pixel(bitmap, 2, 0)).toEqual(pixel(bitmap, 17, 0));
	expect(pixel(bitmap, 2, 0)[0]).toBeGreaterThan(240);
	expect(pixel(bitmap, 2, 0)[3]).toBeGreaterThan(240);
	expect(pixel(bitmap, 2, 9)[3]).toBeLessThan(16);
	// A line has no height for a gradient's box, so its fallback paints.
	expect(pixel(bitmap, 10, 15)).toEqual(LIME);
	expect(pixel(bitmap, 10, 19)).toEqual(LIME);
});

test("a radial gradient spreads from the middle of the shape", async () => {
	const bitmap = await draw(
		`<svg width="20" height="20">
			<radialGradient id="glow">
				<stop offset="0" stop-color="#fff"/>
				<stop offset="1" stop-color="#000"/>
			</radialGradient>
			<rect width="20" height="20" fill="url(#glow)"/>
		</svg>`,
	);
	const middle = pixel(bitmap, 10, 10)[0];
	const side = pixel(bitmap, 2, 10)[0];
	expect(middle).toBeGreaterThan(230);
	expect(side).toBeLessThan(80);
	// The same all round, to within the pixel the reading lands on.
	expect(Math.abs(pixel(bitmap, 17, 10)[0] - side)).toBeLessThan(4);
	expect(Math.abs(pixel(bitmap, 10, 2)[0] - side)).toBeLessThan(4);
	expect(pixel(bitmap, 0, 0)).toEqual(BLACK);
});

test("a clip-path keeps a shape to the shapes it names", async () => {
	const bitmap = await draw(
		`<svg width="20" height="10">
			<clipPath id="left"><rect width="5" height="10"/><circle cx="15" cy="5" r="2"/></clipPath>
			<g clip-path="url(#left)"><rect width="20" height="10" fill="red"/></g>
			<rect y="8" width="20" height="2" fill="blue"/>
		</svg>`,
	);
	expect(pixel(bitmap, 2, 2)).toEqual(RED);
	expect(pixel(bitmap, 8, 2)).toEqual(CLEAR);
	expect(pixel(bitmap, 15, 5)).toEqual(RED);
	expect(pixel(bitmap, 19, 5)).toEqual(CLEAR);
	// The clip ends with the group it was on.
	expect(pixel(bitmap, 10, 9)).toEqual(BLUE);
});

test("<use> draws an element again, where it says", async () => {
	const bitmap = await draw(
		`<svg width="30" height="10" fill="lime">
			<defs><rect id="box" width="10" height="10"/></defs>
			<symbol id="mark"><rect width="10" height="5" fill="blue"/></symbol>
			<use href="#box"/>
			<use xlink:href="#box" x="10" fill="red"/>
			<use href="#mark" x="20" y="5"/>
			<use href="other.svg#box" x="20"/>
		</svg>`,
	);
	// What is in <defs> draws only where it is used, in the color around
	// the use.
	expect(pixel(bitmap, 5, 5)).toEqual(LIME);
	expect(pixel(bitmap, 15, 5)).toEqual(RED);
	expect(pixel(bitmap, 25, 7)).toEqual(BLUE);
	expect(pixel(bitmap, 25, 2)).toEqual(CLEAR);
});

test("what is hidden, and what is not read, draws nothing", async () => {
	const bitmap = await draw(
		`<svg width="40" height="10">
			<rect width="10" height="10" display="none"/>
			<g visibility="hidden"><rect x="10" width="5" height="10"/><rect x="15" width="5" height="10" visibility="visible" fill="red"/></g>
			<text x="20" y="8">hi</text>
			<image href="http://example.com/a.png" x="20" width="10" height="10"/>
			<foreignObject x="20" width="10" height="10"><p>hi</p></foreignObject>
			<rect x="30" width="5" height="10" fill="bogus"/>
			<rect x="35" width="5" height="10" fill="none" stroke="red" stroke-width="0"/>
			<rect x="35" width="5" height="10" opacity="0" fill="red"/>
		</svg>`,
	);
	expect(pixel(bitmap, 5, 5)).toEqual(CLEAR);
	expect(pixel(bitmap, 12, 5)).toEqual(CLEAR);
	expect(pixel(bitmap, 17, 5)).toEqual(RED);
	expect(pixel(bitmap, 25, 5)).toEqual(CLEAR);
	// A fill that is no color is no fill declared, which is black.
	expect(pixel(bitmap, 32, 5)).toEqual(BLACK);
	expect(pixel(bitmap, 37, 5)).toEqual(CLEAR);
});

test("opacity and dashes are the stroke's and the fill's", async () => {
	const bitmap = await draw(
		`<svg width="20" height="10">
			<g opacity="0.5"><rect width="10" height="4" fill="red" fill-opacity="0.5"/></g>
			<path d="M0 7h20" stroke="blue" stroke-width="2" stroke-dasharray="5 5"/>
			<path d="M0 9.5h20" stroke="blue" stroke-opacity="0.5"/>
		</svg>`,
	);
	expect(pixel(bitmap, 5, 2)[3]).toBeGreaterThan(60);
	expect(pixel(bitmap, 5, 2)[3]).toBeLessThan(68);
	expect(pixel(bitmap, 2, 7)).toEqual(BLUE);
	expect(pixel(bitmap, 7, 7)).toEqual(CLEAR);
	expect(pixel(bitmap, 12, 7)).toEqual(BLUE);
	expect(pixel(bitmap, 5, 9)[3]).toBeGreaterThan(120);
	expect(pixel(bitmap, 5, 9)[3]).toBeLessThan(136);
});

test("a file that draws without end is stopped", async () => {
	// Each level uses the one below it ten times over.
	let bomb = `<rect id="l0" width="1" height="1"/>`;
	for (let level = 1; level <= 7; level++) {
		bomb += `<g id="l${level}">${
			`<use href="#l${level - 1}"/>`.repeat(10)
		}</g>`;
	}
	expect(
		await rejects(
			draw(
				`<svg width="4" height="4"><defs>${bomb}</defs><use href="#l7"/></svg>`,
			),
		),
	).toBe("The SVG image draws too many shapes");
	// One that uses itself stops where it started.
	const loop = await draw(
		`<svg width="4" height="4"><g id="a"><rect width="4" height="4" fill="red"/><use href="#a"/></g></svg>`,
	);
	expect(pixel(loop, 2, 2)).toEqual(RED);
	const deep = await draw(
		`<svg width="4" height="4">${"<g>".repeat(200)}<rect width="4" height="4"/>${"</g>".repeat(200)}<rect width="2" height="4" fill="red"/></svg>`,
	);
	expect(pixel(deep, 1, 2)).toEqual(RED);
	expect(pixel(deep, 3, 2)).toEqual(CLEAR);
	const large = new Uint8Array(MAX_SVG_BYTES + 1).fill(0x20);
	large.set(encode("<svg>"));
	expect(await rejects(rasterizeSVG(large))).toContain("is more than");
});

test("a drawing past its deadline stops", async () => {
	const shapes =
		`<path d="M0 0C100 0 100 100 0 100S-100 0 0 0z" stroke="red"/>`.repeat(
			4000,
		);
	expect(
		await rejects(
			draw(`<svg width="500" height="500">${shapes}</svg>`, Date.now() - 1),
		),
	).toBe("The image took too long to decode");
});

test("an SVG file is known by its root element", async () => {
	const sniff = (text: string): string | null => sniffImageType(encode(text));
	expect(sniff("<svg></svg>")).toBe("image/svg+xml");
	expect(sniff("<SVG xmlns=\"http://www.w3.org/2000/svg\"/>"))
		.toBe("image/svg+xml");
	expect(sniff("﻿<?xml version=\"1.0\"?>\n<!-- made by hand -->\n<svg>"))
		.toBe("image/svg+xml");
	expect(
		sniff(
			"<?xml version=\"1.0\"?><!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x.dtd\" [\n<!ENTITY ns \"http://ns\">\n]>\n<svg>",
		),
	).toBe("image/svg+xml");
	expect(sniff("<html><svg></svg></html>")).toBeNull();
	expect(sniff("<svgs>")).toBeNull();
	expect(sniff("svg")).toBeNull();
	expect(sniff("")).toBeNull();
	const bitmap = await decodeImage(
		encode(
			"<svg width=\"2\" height=\"2\"><rect width=\"2\" height=\"2\"/></svg>",
		),
	);
	expect(pixel(bitmap, 1, 1)).toEqual(BLACK);
});

test("an <img> draws an SVG file in cells", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const dom =
		new TermDOM({transport: terminal.transport, csp: "img-src data:"});
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="32"><rect width="16" height="16" fill="#f00"/><rect y="16" width="16" height="16" fill="#00f"/></svg>`;
	dom.document.body.innerHTML =
		`<img src="data:image/svg+xml,${encodeURIComponent(svg)}">`;
	await nextFrame(dom);
	const image = dom.document.images[0];
	await image.decode();
	await nextFrame(dom);
	expect([image.naturalWidth, image.naturalHeight]).toEqual([2, 2]);
	const cell = (col: number, row: number) => {
		const at = (terminal as any)
			.terminal.buffer.active.getLine(row)
			.getCell(col);
		return [at.getChars(), at.getFgColor(), at.getBgColor()];
	};
	// Each cell is one flat color: the upper row red, the lower blue.
	for (const col of [0, 1]) {
		expect(cell(col, 0).slice(1)).toContain(0xff0000);
		expect(cell(col, 1).slice(1)).toContain(0x0000ff);
	}
	dom.dispose();
});

test("a canvas draws an SVG image from the pixels drawn for it", async () => {
	const terminal = new MockProcess({cols: 20, rows: 6});
	const dom =
		new TermDOM({transport: terminal.transport, csp: "img-src data:"});
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="4" height="8" fill="#f00"/></svg>`;
	dom.document.body.innerHTML =
		`<img src="data:image/svg+xml,${encodeURIComponent(svg)}">` +
		"<canvas width=\"16\" height=\"16\"></canvas>";
	const image = dom.document.images[0];
	await image.decode();
	const context = dom.document.querySelector("canvas")!.getContext("2d")!;
	// The source rectangle is in the image's own pixels, eight to a side,
	// however many were drawn for it.
	context.drawImage(image, 0, 0, 8, 8, 4, 4, 8, 8);
	const read = (x: number, y: number): number[] =>
		[...context.getImageData(x, y, 1, 1).data];
	expect(read(5, 5)).toEqual(RED);
	expect(read(7, 11)).toEqual(RED);
	expect(read(9, 5)).toEqual(CLEAR);
	expect(read(13, 5)).toEqual(CLEAR);
	expect(read(2, 5)).toEqual(CLEAR);
	dom.dispose();
});
