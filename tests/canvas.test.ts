/**
 * <canvas>
 *
 * "2d" rasterizes into a bitmap that is shown two pixels a cell, like an
 * image; most tests read the bitmap back with getImageData(), which is
 * exact, and a few read the painted cells. "charactergrid" writes cells
 * directly, and its tests read the cells.
 *
 * A canvas shows at its pixel size over the cell size, 8 by 16 until
 * the terminal says otherwise, so a 16 by 32 canvas covers 2 by 2 cells.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {decodeImage, encodePNG} from "../src/internal/images.ts";
import {MockProcess, nextFrame, until} from "./test-utils.ts";

interface Cell {
	char: string;
	fg: number;
	bg: number;
	bold: boolean;
	italic: boolean;
	inverse: boolean;
}

function cell(terminal: MockProcess, col: number, row: number): Cell {
	const line = (terminal as any).terminal.buffer.active.getLine(row);
	const at = line.getCell(col);
	return {
		char: at.getChars() || " ",
		fg: at.isFgRGB() ? at.getFgColor() : -1,
		bg: at.isBgRGB() ? at.getBgColor() : -1,
		bold: Boolean(at.isBold()),
		italic: Boolean(at.isItalic()),
		inverse: Boolean(at.isInverse()),
	};
}

function rowText(terminal: MockProcess, row: number): string {
	return (terminal as any)
		.terminal.buffer.active.getLine(row)
		.translateToString(true);
}

async function mount(
	html: string,
	cols = 40,
	rows = 12,
): Promise<{dom: TermDOM; terminal: MockProcess; document: Document}> {
	const terminal = new MockProcess({cols, rows});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return {dom, terminal, document: dom.document};
}

function context2d(document: Document, id = "c"): CanvasRenderingContext2D {
	return (document.getElementById(id) as HTMLCanvasElement).getContext("2d")!;
}

function pixel(ctx: CanvasRenderingContext2D, x: number, y: number): number[] {
	return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

test("getContext hands back one context per canvas, and null for the rest", async () => {
	const {dom, document} =
		await mount("<canvas id=a></canvas><canvas id=b></canvas>");
	const a = document.getElementById("a") as HTMLCanvasElement;
	const b = document.getElementById("b") as HTMLCanvasElement;
	const ctx = a.getContext("2d");
	expect(ctx).not.toBeNull();
	expect(a.getContext("2d")).toBe(ctx);
	expect(ctx!.canvas).toBe(a);
	expect(a.getContext("charactergrid" as "2d")).toBeNull();
	expect(a.getContext("webgl")).toBeNull();
	expect(b.getContext("bitmaprenderer")).toBeNull();
	const grid = b.getContext("charactergrid" as "2d");
	expect(grid).not.toBeNull();
	expect(b.getContext("2d")).toBeNull();
	expect(ctx).toBeInstanceOf((dom.window as any).CanvasRenderingContext2D);
	expect(grid).toBeInstanceOf((dom.window as any).CanvasCharacterGridContext);
	dom.dispose();
});

test("a canvas is 300 by 150 pixels until sized, and sizes in cells from them", async () => {
	const {dom, document} = await mount(
		"<canvas id=c></canvas><canvas id=d width=16 height=32></canvas>",
	);
	const canvas = document.getElementById("c") as HTMLCanvasElement;
	expect(canvas.width).toBe(300);
	expect(canvas.height).toBe(150);
	// 300 / 8 rounds to 38 and 150 / 16 to 9.
	expect(canvas.getBoundingClientRect().width).toBe(38);
	expect(canvas.getBoundingClientRect().height).toBe(9);
	const small = document.getElementById("d")!.getBoundingClientRect();
	expect([small.width, small.height]).toEqual([2, 2]);
	dom.dispose();
});

test("fillRect fills pixels, and fillStyle reads back as HTML serializes it", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=16 height=16></canvas>");
	const ctx = context2d(document);
	expect(ctx.fillStyle).toBe("#000000");
	ctx.fillStyle = "red";
	expect(ctx.fillStyle).toBe("#ff0000");
	ctx.fillStyle = "rgba(0, 0, 255, 0.5)";
	expect(ctx.fillStyle).toBe("rgba(0, 0, 255, 0.5)");
	ctx.fillStyle = "not a color";
	expect(ctx.fillStyle).toBe("rgba(0, 0, 255, 0.5)");
	ctx.fillStyle = "#00ff00";
	ctx.fillRect(2, 2, 4, 4);
	expect(pixel(ctx, 3, 3)).toEqual([0, 255, 0, 255]);
	expect(pixel(ctx, 6, 6)).toEqual([0, 0, 0, 0]);
	expect(pixel(ctx, 1, 1)).toEqual([0, 0, 0, 0]);
	dom.dispose();
});

test("drawing repaints the canvas's cells without any DOM change", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=c width=16 height=32></canvas>");
	const ctx = context2d(document);
	ctx.fillStyle = "#ff0000";
	ctx.fillRect(0, 0, 16, 8);
	ctx.fillStyle = "#0000ff";
	ctx.fillRect(0, 8, 16, 8);
	await nextFrame(dom);
	expect(cell(terminal, 0, 0)).toMatchObject({
		char: "▀",
		fg: 0xff0000,
		bg: 0x0000ff,
	});
	expect(cell(terminal, 1, 0)).toMatchObject({
		char: "▀",
		fg: 0xff0000,
		bg: 0x0000ff,
	});
	// The second row of cells is still empty.
	expect(cell(terminal, 0, 1).char).toBe(" ");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 16, 8, 16);
	await until(() => cell(terminal, 0, 1).bg === 0xffffff);
	expect(cell(terminal, 0, 1)).toMatchObject({char: " ", bg: 0xffffff});
	dom.dispose();
});

test("clearRect, globalAlpha and the compositing operations", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=8 height=8></canvas>");
	const ctx = context2d(document);
	ctx.fillStyle = "#ff0000";
	ctx.fillRect(0, 0, 8, 8);
	ctx.clearRect(0, 0, 2, 2);
	expect(pixel(ctx, 0, 0)).toEqual([0, 0, 0, 0]);
	expect(pixel(ctx, 2, 2)).toEqual([255, 0, 0, 255]);

	// Half blue over red.
	ctx.globalAlpha = 0.5;
	ctx.fillStyle = "#0000ff";
	ctx.fillRect(2, 2, 1, 1);
	const [r, g, b, a] = pixel(ctx, 2, 2);
	expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
	expect(g).toBe(0);
	expect(Math.abs(b - 128)).toBeLessThanOrEqual(1);
	expect(a).toBe(255);
	ctx.globalAlpha = 1;

	// destination-out erases, destination-over paints behind.
	ctx.globalCompositeOperation = "destination-out";
	ctx.fillRect(4, 4, 1, 1);
	expect(pixel(ctx, 4, 4)[3]).toBe(0);
	ctx.globalCompositeOperation = "destination-over";
	ctx.fillStyle = "#00ff00";
	ctx.fillRect(0, 0, 8, 8);
	expect(pixel(ctx, 4, 4)).toEqual([0, 255, 0, 255]);
	expect(pixel(ctx, 5, 5)).toEqual([255, 0, 0, 255]);
	// copy replaces even what the shape does not cover.
	ctx.globalCompositeOperation = "copy";
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, 1, 1);
	expect(pixel(ctx, 0, 0)).toEqual([255, 255, 255, 255]);
	expect(pixel(ctx, 5, 5)).toEqual([0, 0, 0, 0]);
	ctx.globalCompositeOperation = "no such thing" as GlobalCompositeOperation;
	expect(ctx.globalCompositeOperation).toBe("copy");
	dom.dispose();
});

test("paths fill with the nonzero and even-odd rules, anti-aliased at the edges", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=40 height=40></canvas>");
	const ctx = context2d(document);
	ctx.fillStyle = "#ffffff";
	// A square inside a square, both clockwise: nonzero fills the hole.
	ctx.beginPath();
	ctx.rect(0, 0, 20, 20);
	ctx.rect(5, 5, 10, 10);
	ctx.fill();
	expect(pixel(ctx, 10, 10)[3]).toBe(255);
	ctx.clearRect(0, 0, 40, 40);
	ctx.fill("evenodd");
	expect(pixel(ctx, 10, 10)[3]).toBe(0);
	expect(pixel(ctx, 2, 2)[3]).toBe(255);

	// A circle: its center is in, the box's corner is out, and an edge
	// pixel is partly covered.
	ctx.clearRect(0, 0, 40, 40);
	ctx.beginPath();
	ctx.arc(20, 20, 10.5, 0, Math.PI * 2);
	ctx.fill();
	expect(pixel(ctx, 20, 20)[3]).toBe(255);
	expect(pixel(ctx, 11, 11)[3]).toBe(0);
	const edge = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
		.map((x) => pixel(ctx, x, 20)[3])
		.find((alpha) => alpha > 0 && alpha < 255);
	expect(edge).toBeDefined();
	dom.dispose();
});

test("strokes take their width, caps, joins and dashes", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=40 height=20></canvas>");
	const ctx = context2d(document);
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 4;
	ctx.beginPath();
	ctx.moveTo(10, 10);
	ctx.lineTo(30, 10);
	ctx.stroke();
	// Four rows thick, centered on the line, ending at its ends.
	expect(pixel(ctx, 20, 8)[3]).toBe(255);
	expect(pixel(ctx, 20, 11)[3]).toBe(255);
	expect(pixel(ctx, 20, 12)[3]).toBe(0);
	expect(pixel(ctx, 8, 10)[3]).toBe(0);
	// A square cap reaches half the width past each end.
	ctx.clearRect(0, 0, 40, 20);
	ctx.lineCap = "square";
	ctx.stroke();
	expect(pixel(ctx, 8, 10)[3]).toBe(255);
	expect(pixel(ctx, 31, 10)[3]).toBe(255);
	// Dashes of 4 on and 4 off leave gaps.
	ctx.clearRect(0, 0, 40, 20);
	ctx.lineCap = "butt";
	ctx.setLineDash([4, 4]);
	expect(ctx.getLineDash()).toEqual([4, 4]);
	ctx.stroke();
	expect(pixel(ctx, 11, 10)[3]).toBe(255);
	expect(pixel(ctx, 15, 10)[3]).toBe(0);
	expect(pixel(ctx, 19, 10)[3]).toBe(255);
	// An odd dash list repeats itself, as HTML says.
	ctx.setLineDash([1, 2, 3]);
	expect(ctx.getLineDash()).toEqual([1, 2, 3, 1, 2, 3]);
	dom.dispose();
});

test("a miter join fills the corner a bevel cuts", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=30 height=30></canvas>");
	const ctx = context2d(document);
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 6;
	const corner = () => {
		ctx.beginPath();
		ctx.moveTo(5, 20);
		ctx.lineTo(20, 20);
		ctx.lineTo(20, 5);
		ctx.stroke();
	};
	ctx.lineJoin = "miter";
	corner();
	expect(pixel(ctx, 22, 22)[3]).toBe(255);
	ctx.clearRect(0, 0, 30, 30);
	ctx.lineJoin = "bevel";
	corner();
	expect(pixel(ctx, 22, 22)[3]).toBe(0);
	dom.dispose();
});

test("transforms move what is drawn, and save and restore keep them", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=20 height=20></canvas>");
	const ctx = context2d(document);
	ctx.fillStyle = "#ffffff";
	ctx.save();
	ctx.translate(10, 10);
	ctx.scale(2, 2);
	ctx.fillRect(0, 0, 2, 2);
	expect(pixel(ctx, 13, 13)[3]).toBe(255);
	expect(pixel(ctx, 14, 14)[3]).toBe(0);
	const matrix = ctx.getTransform();
	expect([matrix.a, matrix.d, matrix.e, matrix.f]).toEqual([2, 2, 10, 10]);
	ctx.restore();
	expect(ctx.getTransform().isIdentity).toBe(true);
	// A quarter turn about the origin swaps the axes: x goes down.
	ctx.clearRect(0, 0, 20, 20);
	ctx.rotate(Math.PI / 2);
	ctx.fillRect(2, -6, 4, 4);
	expect(pixel(ctx, 4, 3)[3]).toBe(255);
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.resetTransform();
	expect(ctx.getTransform().isIdentity).toBe(true);
	dom.dispose();
});

test("clip limits drawing to a path until restore", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=20 height=20></canvas>");
	const ctx = context2d(document);
	ctx.save();
	ctx.beginPath();
	ctx.rect(5, 5, 10, 10);
	ctx.clip();
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, 20, 20);
	expect(pixel(ctx, 10, 10)[3]).toBe(255);
	expect(pixel(ctx, 2, 2)[3]).toBe(0);
	ctx.restore();
	ctx.fillRect(0, 0, 3, 3);
	expect(pixel(ctx, 2, 2)[3]).toBe(255);
	dom.dispose();
});

test("linear and radial gradients, and patterns, fill by position", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=20 height=20></canvas>");
	const ctx = context2d(document);
	const linear = ctx.createLinearGradient(0, 0, 20, 0);
	linear.addColorStop(0, "#000000");
	linear.addColorStop(1, "#ffffff");
	ctx.fillStyle = linear;
	ctx.fillRect(0, 0, 20, 10);
	expect(pixel(ctx, 0, 0)[0]).toBeLessThan(16);
	expect(Math.abs(pixel(ctx, 10, 0)[0] - 134)).toBeLessThan(10);
	expect(pixel(ctx, 19, 0)[0]).toBeGreaterThan(240);
	expect(() => linear.addColorStop(2, "red")).toThrow();
	expect(() => linear.addColorStop(0.5, "nope")).toThrow();

	const radial = ctx.createRadialGradient(10, 15, 0, 10, 15, 5);
	radial.addColorStop(0, "#ff0000");
	radial.addColorStop(1, "#0000ff");
	ctx.fillStyle = radial;
	ctx.fillRect(0, 10, 20, 10);
	expect(pixel(ctx, 10, 15)[0]).toBeGreaterThan(200);
	expect(pixel(ctx, 0, 19)[2]).toBe(255);

	// A 2 by 1 tile, red then green, repeated across.
	const tile = document.createElement("canvas");
	tile.width = 2;
	tile.height = 1;
	const tileContext = tile.getContext("2d")!;
	tileContext.fillStyle = "#ff0000";
	tileContext.fillRect(0, 0, 1, 1);
	tileContext.fillStyle = "#00ff00";
	tileContext.fillRect(1, 0, 1, 1);
	ctx.fillStyle = ctx.createPattern(tile, "repeat")!;
	ctx.fillRect(0, 0, 6, 1);
	expect(pixel(ctx, 4, 0)).toEqual([255, 0, 0, 255]);
	expect(pixel(ctx, 5, 0)).toEqual([0, 255, 0, 255]);
	dom.dispose();
});

test("drawImage copies, scales and crops from a canvas", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=20 height=20></canvas>");
	const ctx = context2d(document);
	const source = document.createElement("canvas");
	source.width = 4;
	source.height = 4;
	const sourceContext = source.getContext("2d")!;
	sourceContext.fillStyle = "#ff0000";
	sourceContext.fillRect(0, 0, 2, 4);
	sourceContext.fillStyle = "#0000ff";
	sourceContext.fillRect(2, 0, 2, 4);
	ctx.drawImage(source, 0, 0);
	expect(pixel(ctx, 1, 1)).toEqual([255, 0, 0, 255]);
	expect(pixel(ctx, 3, 1)).toEqual([0, 0, 255, 255]);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(source, 10, 0, 8, 8);
	expect(pixel(ctx, 13, 4)).toEqual([255, 0, 0, 255]);
	expect(pixel(ctx, 14, 4)).toEqual([0, 0, 255, 255]);
	// The right half only, stretched over 4 by 4.
	ctx.drawImage(source, 2, 0, 2, 4, 0, 10, 4, 4);
	expect(pixel(ctx, 0, 10)).toEqual([0, 0, 255, 255]);
	expect(() => ctx.drawImage({} as CanvasImageSource, 0, 0)).toThrow();
	dom.dispose();
});

test("drawImage draws a loaded <img>, skips one still loading, and throws for a broken one", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=8 height=8></canvas>");
	const ctx = context2d(document);
	const data = new Uint8ClampedArray(2 * 2 * 4);
	for (let i = 0; i < 4; i++) {
		data.set([0, 255, 0, 255], i * 4);
	}
	const bytes = encodePNG({width: 2, height: 2, data});
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	const image = document.createElement("img");
	image.src = `data:image/png;base64,${btoa(binary)}`;
	ctx.drawImage(image, 0, 0);
	expect(pixel(ctx, 0, 0)[3]).toBe(0);
	await image.decode();
	ctx.drawImage(image, 0, 0);
	expect(pixel(ctx, 1, 1)).toEqual([0, 255, 0, 255]);

	const broken = document.createElement("img");
	broken.src = "data:image/png;base64,AAAA";
	await broken.decode().catch(() => undefined);
	let thrown: unknown = null;
	try {
		ctx.drawImage(broken, 0, 0);
	} catch (error) {
		thrown = error;
	}
	expect((thrown as Error | null)?.name).toBe("InvalidStateError");
	dom.dispose();
});

test("getImageData and putImageData, with a dirty rectangle", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=4 height=4></canvas>");
	const ctx = context2d(document);
	const ImageDataClass = (dom.window as any).ImageData as typeof ImageData;
	const image = new ImageDataClass(2, 2);
	image.data.fill(200);
	ctx.putImageData(image, 1, 1);
	expect(pixel(ctx, 1, 1)).toEqual([200, 200, 200, 200]);
	expect(pixel(ctx, 0, 0)).toEqual([0, 0, 0, 0]);
	// Only the dirty rectangle's pixels are written.
	const other = new ImageDataClass(2, 2);
	other.data.fill(50);
	ctx.putImageData(other, 1, 1, 1, 1, 1, 1);
	expect(pixel(ctx, 1, 1)).toEqual([200, 200, 200, 200]);
	expect(pixel(ctx, 2, 2)).toEqual([50, 50, 50, 50]);
	// Reads outside the canvas are transparent.
	expect(Array.from(ctx.getImageData(-1, -1, 1, 1).data)).toEqual([0, 0, 0, 0]);
	expect(() => ctx.getImageData(0, 0, 0, 1)).toThrow();
	expect(() => new ImageDataClass(new Uint8ClampedArray(5), 1)).toThrow();
	expect(ctx.createImageData(3, 2).data.length).toBe(24);
	dom.dispose();
});

test("toDataURL and toBlob encode PNG", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=3 height=2></canvas>");
	const canvas = document.getElementById("c") as HTMLCanvasElement;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#123456";
	ctx.fillRect(0, 0, 3, 2);
	const url = canvas.toDataURL();
	expect(url.startsWith("data:image/png;base64,")).toBe(true);
	const bytes = Uint8Array.from(atob(url.slice(22)), (char) =>
		char.charCodeAt(0),
	);
	const decoded = await decodeImage(bytes);
	expect(Array.from(decoded.data.subarray(0, 4))).toEqual([
		0x12,
		0x34,
		0x56,
		255,
	]);
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve),
	);
	expect(blob?.type).toBe("image/png");
	canvas.width = 0;
	expect(canvas.toDataURL()).toBe("data:,");
	dom.dispose();
});

test("setting width or height clears the canvas and resets its state", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=8 height=8></canvas>");
	const canvas = document.getElementById("c") as HTMLCanvasElement;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#ff0000";
	ctx.translate(2, 2);
	ctx.fillRect(0, 0, 4, 4);
	canvas.width = 8;
	expect(pixel(ctx, 3, 3)).toEqual([0, 0, 0, 0]);
	expect(ctx.fillStyle).toBe("#000000");
	expect(ctx.getTransform().isIdentity).toBe(true);
	canvas.height = 48;
	await nextFrame(dom);
	expect(canvas.getBoundingClientRect().height).toBe(3);
	dom.dispose();
});

test("hit testing: isPointInPath and isPointInStroke, with Path2D", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=20 height=20></canvas>");
	const ctx = context2d(document);
	const Path = (dom.window as any).Path2D as typeof Path2D;
	const square = new Path("M 2 2 h 10 v 10 h -10 Z");
	expect(ctx.isPointInPath(square, 5, 5)).toBe(true);
	expect(ctx.isPointInPath(square, 15, 5)).toBe(false);
	ctx.lineWidth = 2;
	expect(ctx.isPointInStroke(square, 2, 7)).toBe(true);
	expect(ctx.isPointInStroke(square, 7, 7)).toBe(false);
	// The current path, and a Path2D filled through a transform.
	ctx.beginPath();
	ctx.ellipse(10, 10, 5, 3, 0, 0, Math.PI * 2);
	expect(ctx.isPointInPath(10, 10)).toBe(true);
	expect(ctx.isPointInPath(10, 15)).toBe(false);
	const rounded = new Path();
	rounded.roundRect(0, 0, 10, 10, 4);
	ctx.translate(5, 5);
	ctx.fillStyle = "#ffffff";
	ctx.fill(rounded);
	expect(pixel(ctx, 10, 10)[3]).toBe(255);
	// The rounded corner is cut away.
	expect(pixel(ctx, 5, 5)[3]).toBe(0);
	dom.dispose();
});

test("fillText draws text as cells over the pixels", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=c width=80 height=32></canvas>");
	const ctx = context2d(document);
	ctx.fillStyle = "#202020";
	ctx.fillRect(0, 0, 80, 32);
	ctx.fillStyle = "#ffff00";
	ctx.font = "bold 12px sans-serif";
	ctx.textBaseline = "top";
	ctx.fillText("Hello", 8, 16);
	await nextFrame(dom);
	expect(rowText(terminal, 1).slice(1, 6)).toBe("Hello");
	expect(cell(terminal, 1, 1)).toMatchObject({fg: 0xffff00, bold: true});
	// Painting over the text's anchor paints over the text.
	ctx.fillStyle = "#000080";
	ctx.fillRect(0, 16, 80, 16);
	await nextFrame(dom);
	expect(rowText(terminal, 1).includes("Hello")).toBe(false);
	// A cell of text measures one cell of pixels.
	expect(ctx.measureText("abc").width).toBe(24);
	expect(ctx.measureText("界").width).toBe(16);
	dom.dispose();
});

test("textAlign centers and right-aligns text on its anchor", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=c width=160 height=48></canvas>");
	const ctx = context2d(document);
	ctx.fillStyle = "#ffffff";
	ctx.textBaseline = "top";
	ctx.textAlign = "center";
	ctx.fillText("mid", 80, 0);
	ctx.textAlign = "right";
	ctx.fillText("end", 160, 16);
	await nextFrame(dom);
	expect(rowText(terminal, 0).indexOf("mid")).toBe(9);
	expect(rowText(terminal, 1).indexOf("end")).toBe(17);
	dom.dispose();
});

test("createImageBitmap copies a canvas, and the copy draws", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=4 height=4></canvas>");
	const canvas = document.getElementById("c") as HTMLCanvasElement;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#ff00ff";
	ctx.fillRect(0, 0, 4, 4);
	const bitmap = await dom.window.createImageBitmap(canvas, 1, 1, 2, 2);
	expect([bitmap.width, bitmap.height]).toEqual([2, 2]);
	ctx.clearRect(0, 0, 4, 4);
	ctx.drawImage(bitmap, 0, 0);
	expect(pixel(ctx, 1, 1)).toEqual([255, 0, 255, 255]);
	expect(pixel(ctx, 3, 3)).toEqual([0, 0, 0, 0]);
	bitmap.close();
	expect(bitmap.width).toBe(0);
	dom.dispose();
});

test("a canvas stretched by CSS scales its pixels to the box", async () => {
	const {dom, terminal, document} = await mount(
		"<canvas id=c width=2 height=2 style='display: block; width: 4ch; height: 2px'></canvas>",
	);
	const ctx = context2d(document);
	ctx.fillStyle = "#ff0000";
	ctx.fillRect(0, 0, 1, 2);
	ctx.fillStyle = "#0000ff";
	ctx.fillRect(1, 0, 1, 2);
	await nextFrame(dom);
	expect(cell(terminal, 0, 0).bg).toBe(0xff0000);
	expect(cell(terminal, 1, 1).bg).toBe(0xff0000);
	expect(cell(terminal, 2, 0).bg).toBe(0x0000ff);
	expect(cell(terminal, 3, 1).bg).toBe(0x0000ff);
	dom.dispose();
});

// ---------------------------------------------------------------------------
// charactergrid

function grid(document: Document, id = "g"): any {
	return (document.getElementById(id) as HTMLCanvasElement)
		.getContext("charactergrid" as "2d");
}

test("a charactergrid canvas is width columns by height rows of cells", async () => {
	const {dom, document} =
		await mount("<canvas id=g width=12 height=3></canvas>");
	const ctx = grid(document);
	await nextFrame(dom);
	const rect = document.getElementById("g")!.getBoundingClientRect();
	expect([rect.width, rect.height]).toEqual([12, 3]);
	expect([ctx.columns, ctx.rows]).toEqual([12, 3]);
	dom.dispose();
});

test("fillText writes glyphs, fillRect fills backgrounds, clearRect empties", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=g width=12 height=3></canvas>");
	const ctx = grid(document);
	ctx.fillStyle = "#003366";
	ctx.fillRect(0, 0, 12, 1);
	ctx.fillStyle = "#ffcc00";
	ctx.font = "bold italic";
	ctx.fillText("score: 42", 1, 0);
	ctx.fillStyle = "currentcolor";
	ctx.font = "";
	ctx.fillText("plain", 0, 2);
	await nextFrame(dom);
	expect(rowText(terminal, 0).trimEnd()).toBe(" score: 42");
	expect(cell(terminal, 1, 0)).toMatchObject({
		char: "s",
		fg: 0xffcc00,
		bg: 0x003366,
		bold: true,
		italic: true,
	});
	expect(cell(terminal, 11, 0).bg).toBe(0x003366);
	expect(cell(terminal, 0, 2)).toMatchObject({char: "p", fg: -1});
	expect(ctx.getCell(1, 0)).toEqual({
		char: "s",
		color: "#ffcc00",
		background: "#003366",
		bold: true,
		italic: true,
		underline: false,
	});
	ctx.clearRect(0, 0, 12, 1);
	expect(ctx.getCell(1, 0)).toBeNull();
	await nextFrame(dom);
	expect(rowText(terminal, 0).trimEnd()).toBe("");
	expect(cell(terminal, 11, 0).bg).toBe(-1);
	dom.dispose();
});

test("text that runs past the grid is cut, and wide glyphs take two columns", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=g width=6 height=1></canvas>|");
	const ctx = grid(document);
	ctx.fillText("漢字abcdef", 0, 0);
	await nextFrame(dom);
	expect(rowText(terminal, 0)).toBe("漢字ab|");
	expect(ctx.getCell(0, 0).char).toBe("漢");
	expect(ctx.measureText("漢字a").width).toBe(5);
	ctx.textAlign = "right";
	ctx.fillText("Z", 6, 0);
	expect(ctx.getCell(5, 0).char).toBe("Z");
	dom.dispose();
});

test("currentcolor fills a cell in the terminal's own colors, inverted", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=g width=4 height=1></canvas>");
	const ctx = grid(document);
	ctx.fillRect(0, 0, 2, 1);
	ctx.fillText("x", 0, 0);
	await nextFrame(dom);
	expect(cell(terminal, 1, 0).inverse).toBe(true);
	dom.dispose();
});

test("drawImage draws pixels into cells, two a cell", async () => {
	const {dom, terminal, document} = await mount(
		"<canvas id=g width=4 height=2></canvas><canvas id=src width=2 height=2></canvas>",
	);
	const source =
		(document.getElementById("src") as HTMLCanvasElement).getContext("2d")!;
	source.fillStyle = "#ff0000";
	source.fillRect(0, 0, 2, 1);
	source.fillStyle = "#00ff00";
	source.fillRect(0, 1, 2, 1);
	const ctx = grid(document);
	ctx.drawImage(document.getElementById("src"), 1, 0, 2, 1);
	await nextFrame(dom);
	expect(cell(terminal, 1, 0)).toMatchObject({
		char: "▀",
		fg: 0xff0000,
		bg: 0x00ff00,
	});
	expect(cell(terminal, 2, 0)).toMatchObject({
		char: "▀",
		fg: 0xff0000,
		bg: 0x00ff00,
	});
	expect(cell(terminal, 0, 0).char).toBe(" ");
	dom.dispose();
});

test("resizing a charactergrid canvas resizes and clears its grid", async () => {
	const {dom, document} =
		await mount("<canvas id=g width=4 height=1></canvas>");
	const canvas = document.getElementById("g") as HTMLCanvasElement;
	const ctx = grid(document);
	ctx.fillText("abcd", 0, 0);
	canvas.width = 8;
	expect(ctx.columns).toBe(8);
	expect(ctx.getCell(0, 0)).toBeNull();
	await nextFrame(dom);
	expect(canvas.getBoundingClientRect().width).toBe(8);
	dom.dispose();
});

test("round caps and joins fill without holes where pieces overlap", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=40 height=30></canvas>");
	const ctx = context2d(document);
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 8;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.beginPath();
	ctx.moveTo(10, 10);
	ctx.lineTo(30, 10);
	ctx.lineTo(30, 25);
	ctx.stroke();
	for (const [x, y] of [
		[7, 10],
		[11, 10],
		[20, 10],
		[29, 10],
		[30, 11],
		[30, 20],
	]) {
		expect(pixel(ctx, x, y)[3]).toBe(255);
	}
	dom.dispose();
});

test("drawImage from a canvas onto itself reads the pixels as they were", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=10 height=1></canvas>");
	const canvas = document.getElementById("c") as HTMLCanvasElement;
	const ctx = canvas.getContext("2d")!;
	for (let x = 0; x < 10; x++) {
		ctx.fillStyle = `rgb(${x * 20}, 0, 0)`;
		ctx.fillRect(x, 0, 1, 1);
	}
	ctx.drawImage(canvas, 1, 0);
	expect([1, 2, 3].map((x) => pixel(ctx, x, 0)[0])).toEqual([0, 20, 40]);
	dom.dispose();
});

test("drawImage takes negative sizes as the same rectangle, and clips the source", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=4 height=1></canvas>");
	const ctx = context2d(document);
	const source = document.createElement("canvas");
	source.width = 4;
	source.height = 1;
	const sourceContext = source.getContext("2d")!;
	for (let x = 0; x < 4; x++) {
		sourceContext.fillStyle = `rgb(${50 + x * 50}, 0, 0)`;
		sourceContext.fillRect(x, 0, 1, 1);
	}
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(source, 4, 0, -4, 1);
	expect([0, 1, 2, 3].map((x) => pixel(ctx, x, 0)[0])).toEqual([
		50,
		100,
		150,
		200,
	]);
	// Two columns past the source's right edge: only two columns draw, at
	// the scale the full rectangle had.
	ctx.clearRect(0, 0, 4, 1);
	ctx.drawImage(source, 2, 0, 4, 1, 0, 0, 4, 1);
	expect(
		[0, 1, 2, 3].map((x) => pixel(ctx, x, 0)[3]),
	).toEqual([255, 255, 0, 0]);
	expect(pixel(ctx, 1, 0)[0]).toBe(200);
	dom.dispose();
});

test("text a canvas drew goes with what clears or replaces it", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=80 height=32></canvas>");
	const ctx = context2d(document);
	const runs = () => (ctx as any)[Object.getOwnPropertySymbols(ctx)
		.find((symbol) => symbol.description === "text")!].length;
	ctx.fillStyle = "#ffffff";
	for (let frame = 0; frame < 20; frame++) {
		ctx.clearRect(0, 0, 80, 32);
		ctx.textAlign = "right";
		ctx.fillText("right", 80, 8);
		ctx.textAlign = "left";
		ctx.textBaseline = "bottom";
		ctx.fillText("bottom", 0, 32);
	}
	expect(runs()).toBe(2);
	ctx.putImageData(ctx.createImageData(80, 32), 0, 0);
	expect(runs()).toBe(0);
	dom.dispose();
});

test("gradients interpolate their colors and alpha without premultiplying", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=3 height=1></canvas>");
	const ctx = context2d(document);
	const gradient = ctx.createLinearGradient(0, 0, 2, 0);
	gradient.addColorStop(0, "rgba(255, 0, 0, 1)");
	gradient.addColorStop(1, "rgba(0, 0, 255, 0)");
	ctx.globalCompositeOperation = "copy";
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 3, 1);
	// Halfway (pixel 1's center is at 1.5 of 2, three quarters along).
	const [r, , b, a] = pixel(ctx, 1, 0);
	expect(Math.abs(r - 64)).toBeLessThanOrEqual(2);
	expect(Math.abs(b - 191)).toBeLessThanOrEqual(2);
	expect(Math.abs(a - 64)).toBeLessThanOrEqual(2);
	dom.dispose();
});

test("a canvas too large to allocate lays out and draws nothing", async () => {
	const {dom, document} =
		await mount("<canvas id=c width=60000 height=60000></canvas>");
	const canvas = document.getElementById("c") as HTMLCanvasElement;
	expect(canvas.getBoundingClientRect().width).toBe(7500);
	const ctx = canvas.getContext("2d")!;
	ctx.fillRect(0, 0, 10, 10);
	expect(canvas.toDataURL()).toBe("data:,");
	dom.dispose();
});

test("text over a currentcolor fill stays in inverse video", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=g width=4 height=1></canvas>");
	const ctx = grid(document);
	ctx.fillRect(0, 0, 4, 1);
	ctx.fillText("ab", 1, 0);
	await nextFrame(dom);
	expect(cell(terminal, 1, 0)).toMatchObject({char: "a", inverse: true});
	expect(cell(terminal, 0, 0)).toMatchObject({char: " ", inverse: true});
	dom.dispose();
});

test("strokeRect draws a box and strokeLine joins it as tees", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=g width=6 height=4></canvas>");
	const ctx = grid(document);
	ctx.strokeRect(0, 0, 6, 4);
	ctx.strokeLine(0, 2, 5, 2);
	ctx.strokeLine(3, 0, 3, 2);
	await nextFrame(dom);
	expect(rowText(terminal, 0)).toBe("┌──┬─┐");
	expect(rowText(terminal, 1)).toBe("│  │ │");
	expect(rowText(terminal, 2)).toBe("├──┴─┤");
	expect(rowText(terminal, 3)).toBe("└────┘");
	expect(ctx.getCell(3, 2).char).toBe("┴");
	dom.dispose();
});

test("lineStyle, lineJoin and strokeStyle set how lines draw", async () => {
	const {dom, terminal, document} =
		await mount("<canvas id=g width=4 height=6></canvas>");
	const ctx = grid(document);
	ctx.lineStyle = "double";
	ctx.strokeRect(0, 0, 4, 3);
	ctx.lineStyle = "solid";
	ctx.lineJoin = "round";
	ctx.strokeStyle = "#ff0000";
	ctx.strokeRect(0, 3, 4, 3);
	ctx.lineStyle = "wavy";
	expect(ctx.lineStyle).toBe("solid");
	await nextFrame(dom);
	expect(rowText(terminal, 0)).toBe("╔══╗");
	expect(rowText(terminal, 2)).toBe("╚══╝");
	expect(rowText(terminal, 3)).toBe("╭──╮");
	expect(cell(terminal, 1, 3)).toMatchObject({char: "─", fg: 0xff0000});
	expect(cell(terminal, 1, 0).fg).toBe(-1);
	dom.dispose();
});

test("a slanted line draws nothing", async () => {
	const {dom, document} =
		await mount("<canvas id=g width=4 height=4></canvas>");
	const ctx = grid(document);
	ctx.strokeLine(0, 0, 3, 3);
	expect(ctx.getCell(0, 0)).toBeNull();
	dom.dispose();
});

test("a canvas's lines do not join the page's borders beside it", async () => {
	const {dom, terminal, document} = await mount(
		"<div style=\"border: 1px solid; width: 6ch\">" +
		"<canvas id=g width=4 height=3 style=\"display: block\"></canvas></div>",
	);
	const ctx = grid(document);
	ctx.strokeLine(0, 1, 0, 1);
	await nextFrame(dom);
	expect(rowText(terminal, 2).slice(0, 2)).toBe("│─");
	dom.dispose();
});
