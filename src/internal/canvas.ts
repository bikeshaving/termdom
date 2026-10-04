/**
 * <canvas> contexts: "2d", a pixel bitmap drawn into cells two pixels
 * at a time, and "charactergrid", a grid of cells written directly.
 *
 * The 2d context rasterizes in software into an RGBA bitmap: paths with
 * the nonzero and even-odd rules, strokes with joins, caps and dashes,
 * clipping, transforms, gradients, patterns, compositing, drawImage and
 * the ImageData calls. A terminal has no fonts to rasterize, so text a
 * 2d context draws stays text: it is painted as cells over the pixels,
 * at the cell its anchor falls in.
 *
 * The charactergrid context is for drawing in cells, the way terminal
 * programs draw: one glyph, one color and one background a cell.
 */
import {parseColor, toCellColor} from "./cssvalues.ts";
import {
	type CellContext,
	type CellStyle,
	LINE_STYLES,
	type LineStyle,
	readCell,
} from "./framebuffer.ts";
import {
	averageBitmap,
	type Bitmap,
	createBitmap,
	encodePNG,
	MAX_IMAGE_PIXELS,
	naturalHeightOf,
	naturalWidthOf,
	sampleBitmap,
} from "./images.ts";
import {getStringWidth, graphemeSegmenter} from "./text.ts";

// ---------------------------------------------------------------------------
// What drawImage() and createPattern() take.

const drawables = new WeakMap<object, () => Bitmap | null>();

/**
 * Register what an image source holds: an <img>'s decoded image, a
 * <canvas>'s bitmap, an ImageBitmap. Null while there is nothing to draw
 * yet, which drawImage() skips, as a browser skips an image still
 * loading.
 */
export function registerDrawable(
	owner: object,
	read: () => Bitmap | null,
): void {
	drawables.set(owner, read);
}

function readDrawable(source: unknown): Bitmap | null {
	if (source instanceof ImageData) {
		return {width: source.width, height: source.height, data: source.data};
	}
	const read = typeof source === "object" && source !== null
		? drawables.get(source)
		: undefined;
	if (read === undefined) {
		throw new TypeError(
			"The image is not an HTMLImageElement, an HTMLCanvasElement or an ImageBitmap",
		);
	}
	return read();
}

// ---------------------------------------------------------------------------
// ImageData and ImageBitmap.

export class ImageData {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8ClampedArray;
	readonly colorSpace: "srgb";
	readonly pixelFormat: "rgba-unorm8";

	constructor(
		dataOrWidth: Uint8ClampedArray | number,
		widthOrHeight: number,
		height?: number,
	) {
		let width: number;
		let data: Uint8ClampedArray;
		if (typeof dataOrWidth === "number") {
			width = Math.floor(dataOrWidth);
			height = Math.floor(widthOrHeight);
			if (!(width > 0) || !(height > 0)) {
				throw domException(
					"IndexSizeError",
					"The width and height must be positive",
				);
			}
			if (width * height > MAX_IMAGE_PIXELS) {
				throw new RangeError(
					`ImageData is limited to ${MAX_IMAGE_PIXELS} pixels`,
				);
			}
			data = new Uint8ClampedArray(width * height * 4);
		} else {
			data = dataOrWidth;
			width = Math.floor(widthOrHeight);
			if (
				!(width > 0) || data.length === 0 || data.length % (4 * width) !== 0
			) {
				throw domException(
					"IndexSizeError",
					"The data does not hold whole rows of that width",
				);
			}
			const rows = data.length / (4 * width);
			if (height !== undefined && Math.floor(height) !== rows) {
				throw domException(
					"IndexSizeError",
					"The data does not hold that many rows",
				);
			}
			height = rows;
		}
		this.width = width;
		this.height = height;
		this.data = data;
		this.colorSpace = "srgb";
		this.pixelFormat = "rgba-unorm8";
	}
}

const kBitmapData = Symbol("bitmapData");

export interface ImageBitmap {
	[kBitmapData]: Bitmap | null;
}

export class ImageBitmap {
	constructor(bitmap: Bitmap) {
		this[kBitmapData] = bitmap;
		registerDrawable(this, () => this[kBitmapData]);
	}

	get width(): number {
		const bitmap = this[kBitmapData];
		return bitmap ? naturalWidthOf(bitmap) : 0;
	}

	get height(): number {
		const bitmap = this[kBitmapData];
		return bitmap ? naturalHeightOf(bitmap) : 0;
	}

	close(): void {
		this[kBitmapData] = null;
	}
}

/** createImageBitmap(): a copy of a source's pixels, cropped if asked. */
export function createImageBitmapFrom(
	source: unknown,
	sx?: number,
	sy?: number,
	sw?: number,
	sh?: number,
): ImageBitmap {
	const bitmap = readDrawable(source);
	if (bitmap === null) {
		throw domException(
			"InvalidStateError",
			"The image has nothing to copy yet",
		);
	}
	const x = Math.floor(sx ?? 0);
	const y = Math.floor(sy ?? 0);
	const width = Math.floor(sw ?? naturalWidthOf(bitmap));
	const height = Math.floor(sh ?? naturalHeightOf(bitmap));
	if (width <= 0 || height <= 0) {
		throw domException("IndexSizeError", "The crop rectangle is empty");
	}
	if (bitmap.width === naturalWidthOf(bitmap)) {
		const copy = createBitmap(width, height);
		copyRect(bitmap, x, y, copy, 0, 0, width, height);
		return new ImageBitmap(copy);
	}
	// From an image kept smaller than it is, the copy is kept as small,
	// and measures the crop. What the crop takes past the image's edge is
	// transparent.
	const keptX = bitmap.width / naturalWidthOf(bitmap);
	const keptY = bitmap.height / naturalHeightOf(bitmap);
	const copy = createBitmap(
		Math.max(1, Math.round(width * keptX)),
		Math.max(1, Math.round(height * keptY)),
	);
	const left = Math.max(x, 0);
	const top = Math.max(y, 0);
	const right = Math.min(x + width, naturalWidthOf(bitmap));
	const bottom = Math.min(y + height, naturalHeightOf(bitmap));
	const toLeft = Math.round((left - x) * keptX);
	const toTop = Math.round((top - y) * keptY);
	const toWidth = Math.round((right - x) * keptX) - toLeft;
	const toHeight = Math.round((bottom - y) * keptY) - toTop;
	if (toWidth > 0 && toHeight > 0) {
		const part = {
			width: toWidth,
			height: toHeight,
			data: sampleBitmap(bitmap, toWidth, toHeight, {
				x: left,
				y: top,
				width: right - left,
				height: bottom - top,
			}),
		};
		copyRect(part, 0, 0, copy, toLeft, toTop, toWidth, toHeight);
	}
	return new ImageBitmap({...copy, naturalWidth: width, naturalHeight: height});
}

function copyRect(
	from: Bitmap,
	fx: number,
	fy: number,
	to: Bitmap,
	tx: number,
	ty: number,
	width: number,
	height: number,
): void {
	for (let row = 0; row < height; row++) {
		const sy = fy + row;
		const dy = ty + row;
		if (sy < 0 || sy >= from.height || dy < 0 || dy >= to.height) {
			continue;
		}
		for (let col = 0; col < width; col++) {
			const sx = fx + col;
			const dx = tx + col;
			if (sx < 0 || sx >= from.width || dx < 0 || dx >= to.width) {
				continue;
			}
			const s = (sy * from.width + sx) * 4;
			const d = (dy * to.width + dx) * 4;
			to.data[d] = from.data[s];
			to.data[d + 1] = from.data[s + 1];
			to.data[d + 2] = from.data[s + 2];
			to.data[d + 3] = from.data[s + 3];
		}
	}
}

// The platform's DOMException where there is one, which every runtime
// this engine supports has.
function domException(name: string, message: string): Error {
	const Constructor = (globalThis as {DOMException?: typeof DOMException})
		.DOMException;
	return Constructor ? new Constructor(message, name) : new Error(message);
}

// ---------------------------------------------------------------------------
// Colors.

interface RGBA {
	r: number;
	g: number;
	b: number;
	a: number;
}

function parseCanvasColor(value: string): RGBA | null {
	const parsed = parseColor(value);
	if (parsed === null) {
		return null;
	}
	return {
		r: (parsed.color >> 16) & 0xff,
		g: (parsed.color >> 8) & 0xff,
		b: parsed.color & 0xff,
		a: parsed.alpha,
	};
}

// HTML's serialization of a canvas color: #rrggbb when opaque, rgba()
// otherwise.
function serializeColor(color: RGBA): string {
	if (color.a === 1) {
		const hex = (n: number) => n.toString(16).padStart(2, "0");
		return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
	}
	const alpha = Math.round(color.a * 1000) / 1000;
	return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Matrices: [a, b, c, d, e, f], as setTransform() takes them.

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

function invert(m: Matrix): Matrix | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (det === 0 || !Number.isFinite(det)) {
		return null;
	}
	return [
		m[3] / det,
		-m[1] / det,
		-m[2] / det,
		m[0] / det,
		(m[2] * m[5] - m[3] * m[4]) / det,
		(m[1] * m[4] - m[0] * m[5]) / det,
	];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function isFiniteAll(...values: number[]): boolean {
	return values.every(Number.isFinite);
}

/** A DOMMatrix's 2D members, for getTransform(). */
export class CanvasMatrix {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;

	constructor(m: Matrix) {
		[this.a, this.b, this.c, this.d, this.e, this.f] = m;
	}

	get m11(): number {
		return this.a;
	}

	get m12(): number {
		return this.b;
	}

	get m21(): number {
		return this.c;
	}

	get m22(): number {
		return this.d;
	}

	get m41(): number {
		return this.e;
	}

	get m42(): number {
		return this.f;
	}

	get is2D(): boolean {
		return true;
	}

	get isIdentity(): boolean {
		return this.a === 1 &&
			this.b === 0 &&
			this.c === 0 &&
			this.d === 1 &&
			this.e === 0 &&
			this.f === 0;
	}
}

// ---------------------------------------------------------------------------
// Paths. A path is subpaths of points in device space; curves are
// flattened as they are added, finely enough that the segments are under
// a quarter pixel from the curve.

interface Subpath {
	points: number[];
	closed: boolean;
}

const kSubpaths = Symbol("subpaths");

const kLast = Symbol("last");
const kStart = Symbol("start");
const kCurrent = Symbol("current");
const kEmit = Symbol("emit");
const kEnsure = Symbol("ensure");
const kSegments = Symbol("segments");

interface PathBuilder {
	[kSubpaths]: Subpath[];
	[kLast]: [number, number] | null;
	[kStart]: [number, number] | null;
}

class PathBuilder {
	// The last point, in the space the caller writes coordinates in.
	transform: Matrix;

	constructor() {
		this[kSubpaths] = [];
		this[kLast] = null;
		this[kStart] = null;
		this.transform = [1, 0, 0, 1, 0, 0];
	}

	clear(): void {
		this[kSubpaths] = [];
		this[kLast] = null;
		this[kStart] = null;
	}

	moveTo(x: number, y: number): void {
		if (!isFiniteAll(x, y)) {
			return;
		}
		this[kSubpaths].push({points: [], closed: false});
		this[kEmit](x, y);
		this[kLast] = [x, y];
		this[kStart] = [x, y];
	}

	lineTo(x: number, y: number): void {
		if (!isFiniteAll(x, y)) {
			return;
		}
		if (this[kLast] === null) {
			this.moveTo(x, y);
			return;
		}
		this[kEmit](x, y);
		this[kLast] = [x, y];
	}

	closePath(): void {
		const current = this[kCurrent]();
		if (current === null || this[kStart] === null) {
			return;
		}
		current.closed = true;
		this[kLast] = this[kStart];
	}

	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
		if (!isFiniteAll(cx, cy, x, y)) {
			return;
		}
		this[kEnsure](cx, cy);
		const [x0, y0] = this[kLast]!;
		const n = this[kSegments](
			Math.hypot(cx - x0, cy - y0) + Math.hypot(x - cx, y - cy),
		);
		for (let i = 1; i <= n; i++) {
			const t = i / n;
			const u = 1 - t;
			this[kEmit](
				u * u * x0 + 2 * u * t * cx + t * t * x,
				u * u * y0 + 2 * u * t * cy + t * t * y,
			);
		}
		this[kLast] = [x, y];
	}

	bezierCurveTo(
		c1x: number,
		c1y: number,
		c2x: number,
		c2y: number,
		x: number,
		y: number,
	): void {
		if (!isFiniteAll(c1x, c1y, c2x, c2y, x, y)) {
			return;
		}
		this[kEnsure](c1x, c1y);
		const [x0, y0] = this[kLast]!;
		const n = this[kSegments](
			Math.hypot(c1x - x0, c1y - y0) +
				Math.hypot(c2x - c1x, c2y - c1y) +
				Math.hypot(x - c2x, y - c2y),
		);
		for (let i = 1; i <= n; i++) {
			const t = i / n;
			const u = 1 - t;
			this[kEmit](
				u * u * u * x0 +
				3 * u * u * t * c1x +
				3 * u * t * t * c2x +
				t * t * t * x,
				u * u * u * y0 +
				3 * u * u * t * c1y +
				3 * u * t * t * c2y +
				t * t * t * y,
			);
		}
		this[kLast] = [x, y];
	}

	ellipse(
		x: number,
		y: number,
		rx: number,
		ry: number,
		rotation: number,
		start: number,
		end: number,
		counterclockwise = false,
	): void {
		if (!isFiniteAll(x, y, rx, ry, rotation, start, end)) {
			return;
		}
		if (rx < 0 || ry < 0) {
			throw domException("IndexSizeError", "The radius is negative");
		}
		// HTML's sweep rules: a full turn or more draws the whole ellipse,
		// and otherwise the sweep is brought into (0, 2π) in its direction.
		const tau = Math.PI * 2;
		let sweep = end - start;
		if (!counterclockwise && sweep >= tau) {
			sweep = tau;
		} else if (counterclockwise && sweep <= -tau) {
			sweep = -tau;
		} else {
			sweep %= tau;
			if (!counterclockwise && sweep < 0) {
				sweep += tau;
			} else if (counterclockwise && sweep > 0) {
				sweep -= tau;
			}
		}
		const cos = Math.cos(rotation);
		const sin = Math.sin(rotation);
		const at = (angle: number): [number, number] => {
			const px = rx * Math.cos(angle);
			const py = ry * Math.sin(angle);
			return [x + px * cos - py * sin, y + px * sin + py * cos];
		};
		const [sx, sy] = at(start);
		if (this[kLast] === null) {
			this.moveTo(sx, sy);
		} else {
			this.lineTo(sx, sy);
		}
		const n = this[kSegments](Math.abs(sweep) * Math.max(rx, ry));
		for (let i = 1; i <= n; i++) {
			const [px, py] = at(start + (sweep * i) / n);
			this[kEmit](px, py);
			this[kLast] = [px, py];
		}
	}

	arc(
		x: number,
		y: number,
		radius: number,
		start: number,
		end: number,
		counterclockwise = false,
	): void {
		this.ellipse(x, y, radius, radius, 0, start, end, counterclockwise);
	}

	arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
		if (!isFiniteAll(x1, y1, x2, y2, radius)) {
			return;
		}
		if (radius < 0) {
			throw domException("IndexSizeError", "The radius is negative");
		}
		this[kEnsure](x1, y1);
		const [x0, y0] = this[kLast]!;
		const ax = x0 - x1;
		const ay = y0 - y1;
		const bx = x2 - x1;
		const by = y2 - y1;
		const la = Math.hypot(ax, ay);
		const lb = Math.hypot(bx, by);
		const cross = ax * by - ay * bx;
		if (radius === 0 || la === 0 || lb === 0 || Math.abs(cross) < 1e-9) {
			this.lineTo(x1, y1);
			return;
		}
		const angle = Math.acos(
			Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))),
		);
		const tangent = radius / Math.tan(angle / 2);
		const t0x = x1 + (ax / la) * tangent;
		const t0y = y1 + (ay / la) * tangent;
		const t1x = x1 + (bx / lb) * tangent;
		const t1y = y1 + (by / lb) * tangent;
		// The center is off the corner along the bisector.
		const bisectorX = ax / la + bx / lb;
		const bisectorY = ay / la + by / lb;
		const bisector = Math.hypot(bisectorX, bisectorY);
		const distance = Math.hypot(tangent, radius);
		const cx = x1 + (bisectorX / bisector) * distance;
		const cy = y1 + (bisectorY / bisector) * distance;
		this.lineTo(t0x, t0y);
		const a0 = Math.atan2(t0y - cy, t0x - cx);
		const a1 = Math.atan2(t1y - cy, t1x - cx);
		this.ellipse(cx, cy, radius, radius, 0, a0, a1, cross > 0);
	}

	rect(x: number, y: number, w: number, h: number): void {
		if (!isFiniteAll(x, y, w, h)) {
			return;
		}
		this.moveTo(x, y);
		this.lineTo(x + w, y);
		this.lineTo(x + w, y + h);
		this.lineTo(x, y + h);
		this.closePath();
	}

	roundRect(
		x: number,
		y: number,
		w: number,
		h: number,
		radii: number | DOMPointInit | Array<number | DOMPointInit> = 0,
	): void {
		if (!isFiniteAll(x, y, w, h)) {
			return;
		}
		const list = Array.isArray(radii) ? radii : [radii];
		if (list.length < 1 || list.length > 4) {
			throw new RangeError("roundRect takes one to four radii");
		}
		const read = (value: number | DOMPointInit): [number, number] => {
			if (typeof value === "number") {
				if (value < 0) {
					throw new RangeError("A radius is negative");
				}
				return [value, value];
			}
			const rx = value.x ?? 0;
			const ry = value.y ?? 0;
			if (rx < 0 || ry < 0) {
				throw new RangeError("A radius is negative");
			}
			return [rx, ry];
		};
		const r = list.map(read);
		const [tl, tr, br, bl] = r.length === 1
			? [r[0], r[0], r[0], r[0]]
			: r.length === 2
				? [r[0], r[1], r[0], r[1]]
				: r.length === 3 ? [r[0], r[1], r[2], r[1]] : [r[0], r[1], r[2], r[3]];
		// Radii that do not fit are scaled down together.
		const fit = Math.min(
			1,
			Math.abs(w) / (tl[0] + tr[0] || 1),
			Math.abs(w) / (bl[0] + br[0] || 1),
			Math.abs(h) / (tl[1] + bl[1] || 1),
			Math.abs(h) / (tr[1] + br[1] || 1),
		);
		const s = (p: [number, number]): [number, number] => [
			p[0] * fit,
			p[1] * fit,
		];
		const [a, b, c, d] = [s(tl), s(tr), s(br), s(bl)];
		const half = Math.PI / 2;
		this.moveTo(x + a[0], y);
		this.lineTo(x + w - b[0], y);
		this.ellipse(x + w - b[0], y + b[1], b[0], b[1], 0, -half, 0);
		this.lineTo(x + w, y + h - c[1]);
		this.ellipse(x + w - c[0], y + h - c[1], c[0], c[1], 0, 0, half);
		this.lineTo(x + d[0], y + h);
		this.ellipse(x + d[0], y + h - d[1], d[0], d[1], 0, half, Math.PI);
		this.lineTo(x, y + a[1]);
		this.ellipse(x + a[0], y + a[1], a[0], a[1], 0, Math.PI, Math.PI + half);
		this.closePath();
	}

	// For Path2D.addPath(): the other path's subpaths, through a matrix.
	append(subpaths: Subpath[], matrix: Matrix): void {
		for (const subpath of subpaths) {
			const points: number[] = [];
			for (let i = 0; i < subpath.points.length; i += 2) {
				const [x, y] = apply(matrix, subpath.points[i], subpath.points[i + 1]);
				points.push(x, y);
			}
			this[kSubpaths].push({points, closed: subpath.closed});
		}
		const last = this[kSubpaths].at(-1);
		if (last && last.points.length >= 2) {
			this[kLast] = [last.points.at(-2)!, last.points.at(-1)!];
		}
	}

	[kCurrent](): Subpath | null {
		return this[kSubpaths].at(-1) ?? null;
	}

	[kEmit](x: number, y: number): void {
		let current = this[kCurrent]();
		// A segment after closePath() starts a new subpath where the closed
		// one started.
		if (current === null || current.closed) {
			current = {points: [], closed: false};
			this[kSubpaths].push(current);
			if (this[kLast] !== null) {
				current.points.push(...apply(this.transform, ...this[kLast]));
			}
		}
		const [dx, dy] = apply(this.transform, x, y);
		current.points.push(dx, dy);
	}

	[kEnsure](x: number, y: number): void {
		if (this[kLast] === null) {
			this.moveTo(x, y);
		}
	}

	[kSegments](length: number): number {
		const scale =
			Math.sqrt(
				Math.abs(
					this.transform[0] * this.transform[3] -
					this.transform[1] * this.transform[2],
				),
			) || 1;
		return Math.max(
			1,
			Math.min(1000, Math.ceil(Math.sqrt(length * scale) * 2)),
		);
	}
}

interface DOMPointInit {
	x?: number;
	y?: number;
}

/** Path2D: a path built once and filled, stroked or clipped later. */
const kBuilder = Symbol("builder");

export interface Path2D {
	[kBuilder]: PathBuilder;
}

export class Path2D {
	constructor(path?: Path2D | string) {
		this[kBuilder] = new PathBuilder();
		if (path instanceof Path2D) {
			this[kBuilder].append(path[kBuilder][kSubpaths], [1, 0, 0, 1, 0, 0]);
		} else if (typeof path === "string") {
			parseSVGPath(path, this);
		}
	}

	get [kSubpaths](): Subpath[] {
		return this[kBuilder][kSubpaths];
	}

	addPath(path: Path2D, transform?: Partial<CanvasMatrix>): void {
		const m: Matrix = [
			transform?.a ?? 1,
			transform?.b ?? 0,
			transform?.c ?? 0,
			transform?.d ?? 1,
			transform?.e ?? 0,
			transform?.f ?? 0,
		];
		this[kBuilder].append(path[kBuilder][kSubpaths], m);
	}

	moveTo(x: number, y: number): void {
		this[kBuilder].moveTo(x, y);
	}

	lineTo(x: number, y: number): void {
		this[kBuilder].lineTo(x, y);
	}

	closePath(): void {
		this[kBuilder].closePath();
	}

	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
		this[kBuilder].quadraticCurveTo(cx, cy, x, y);
	}

	bezierCurveTo(
		c1x: number,
		c1y: number,
		c2x: number,
		c2y: number,
		x: number,
		y: number,
	): void {
		this[kBuilder].bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
	}

	arc(
		x: number,
		y: number,
		radius: number,
		start: number,
		end: number,
		counterclockwise?: boolean,
	): void {
		this[kBuilder].arc(x, y, radius, start, end, counterclockwise);
	}

	arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
		this[kBuilder].arcTo(x1, y1, x2, y2, radius);
	}

	ellipse(
		x: number,
		y: number,
		rx: number,
		ry: number,
		rotation: number,
		start: number,
		end: number,
		counterclockwise?: boolean,
	): void {
		this[kBuilder].ellipse(
			x,
			y,
			rx,
			ry,
			rotation,
			start,
			end,
			counterclockwise,
		);
	}

	rect(x: number, y: number, w: number, h: number): void {
		this[kBuilder].rect(x, y, w, h);
	}

	roundRect(
		x: number,
		y: number,
		w: number,
		h: number,
		radii?: number | DOMPointInit | Array<number | DOMPointInit>,
	): void {
		this[kBuilder].roundRect(x, y, w, h, radii);
	}
}

// SVG path data (SVG 2 §9.3), the string Path2D's constructor takes.
function parseSVGPath(data: string, path: Path2D): void {
	const tokens =
		data.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
	let i = 0;
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	let controlX = 0;
	let controlY = 0;
	let command = "";
	let previous = "";
	const number = () => parseFloat(tokens[i++]);
	const hasNumber = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
	while (i < tokens.length) {
		if (/^[a-zA-Z]$/.test(tokens[i])) {
			command = tokens[i++];
		} else if (command === "") {
			return;
		}
		const relative = command === command.toLowerCase();
		const ox = relative ? x : 0;
		const oy = relative ? y : 0;
		switch (command.toUpperCase()) {
			case "M":
				x = ox + number();
				y = oy + number();
				path.moveTo(x, y);
				startX = x;
				startY = y;
				// Pairs after a moveto are linetos.
				command = relative ? "l" : "L";
				break;
			case "L":
				x = ox + number();
				y = oy + number();
				path.lineTo(x, y);
				break;
			case "H":
				x = ox + number();
				path.lineTo(x, y);
				break;
			case "V":
				y = oy + number();
				path.lineTo(x, y);
				break;
			case "C": {
				const c1x = ox + number();
				const c1y = oy + number();
				controlX = ox + number();
				controlY = oy + number();
				x = ox + number();
				y = oy + number();
				path.bezierCurveTo(c1x, c1y, controlX, controlY, x, y);
				break;
			}
			case "S": {
				const reflect = /[CcSs]/.test(previous);
				const c1x = reflect ? 2 * x - controlX : x;
				const c1y = reflect ? 2 * y - controlY : y;
				controlX = ox + number();
				controlY = oy + number();
				x = ox + number();
				y = oy + number();
				path.bezierCurveTo(c1x, c1y, controlX, controlY, x, y);
				break;
			}
			case "Q":
				controlX = ox + number();
				controlY = oy + number();
				x = ox + number();
				y = oy + number();
				path.quadraticCurveTo(controlX, controlY, x, y);
				break;
			case "T": {
				const reflect = /[QqTt]/.test(previous);
				controlX = reflect ? 2 * x - controlX : x;
				controlY = reflect ? 2 * y - controlY : y;
				x = ox + number();
				y = oy + number();
				path.quadraticCurveTo(controlX, controlY, x, y);
				break;
			}
			case "A": {
				const rx = Math.abs(number());
				const ry = Math.abs(number());
				const rotation = (number() * Math.PI) / 180;
				const large = number() !== 0;
				const sweep = number() !== 0;
				const tx = ox + number();
				const ty = oy + number();
				svgArc(path, x, y, rx, ry, rotation, large, sweep, tx, ty);
				x = tx;
				y = ty;
				break;
			}
			case "Z":
				path.closePath();
				x = startX;
				y = startY;
				break;
			default:
				return;
		}
		previous = command;
		if (command.toUpperCase() === "Z" && hasNumber()) {
			return;
		}
	}
}

// SVG's endpoint arc, converted to a center arc (SVG 2 Appendix B.2.4).
function svgArc(
	path: Path2D,
	x1: number,
	y1: number,
	rx: number,
	ry: number,
	phi: number,
	large: boolean,
	sweep: boolean,
	x2: number,
	y2: number,
): void {
	if (rx === 0 || ry === 0) {
		path.lineTo(x2, y2);
		return;
	}
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (x1 - x2) / 2;
	const dy = (y1 - y2) / 2;
	const px = cos * dx + sin * dy;
	const py = -sin * dx + cos * dy;
	const lambda = (px * px) / (rx * rx) + (py * py) / (ry * ry);
	if (lambda > 1) {
		rx *= Math.sqrt(lambda);
		ry *= Math.sqrt(lambda);
	}
	const sign = large === sweep ? -1 : 1;
	const numerator = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
	const denominator = rx * rx * py * py + ry * ry * px * px;
	const factor = sign * Math.sqrt(Math.max(0, numerator / denominator));
	const cxp = (factor * rx * py) / ry;
	const cyp = (-factor * ry * px) / rx;
	const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
	const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) => {
		const value = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
		return value;
	};
	const start = angle(1, 0, (px - cxp) / rx, (py - cyp) / ry);
	let delta = angle(
		(px - cxp) / rx,
		(py - cyp) / ry,
		(-px - cxp) / rx,
		(-py - cyp) / ry,
	);
	if (!sweep && delta > 0) {
		delta -= Math.PI * 2;
	} else if (sweep && delta < 0) {
		delta += Math.PI * 2;
	}
	path.ellipse(cx, cy, rx, ry, phi, start, start + delta, !sweep);
}

// ---------------------------------------------------------------------------
// Rasterizing: a coverage mask, 0 to 1 a pixel, from polygons. Each pixel
// row is sampled on four lines, and each line's spans count fractional
// pixels at their ends, so edges come out anti-aliased.

const SUBSAMPLES = 4;

type FillRule = "nonzero" | "evenodd";

function rasterize(
	polygons: number[][],
	width: number,
	height: number,
	rule: FillRule,
): Float32Array {
	const mask = new Float32Array(width * height);
	interface Edge {
		x0: number;
		y0: number;
		x1: number;
		y1: number;
		dir: number;
	}
	const edges: Edge[] = [];
	let minY = Infinity;
	let maxY = -Infinity;
	for (const points of polygons) {
		const count = points.length / 2;
		if (count < 2) {
			continue;
		}
		for (let i = 0; i < count; i++) {
			const ax = points[i * 2];
			const ay = points[i * 2 + 1];
			const j = (i + 1) % count;
			const bx = points[j * 2];
			const by = points[j * 2 + 1];
			if (ay === by) {
				continue;
			}
			edges.push(
				ay < by
					? {x0: ax, y0: ay, x1: bx, y1: by, dir: 1}
					: {x0: bx, y0: by, x1: ax, y1: ay, dir: -1},
			);
			minY = Math.min(minY, ay, by);
			maxY = Math.max(maxY, ay, by);
		}
	}
	if (edges.length === 0) {
		return mask;
	}
	const rowStart = Math.max(0, Math.floor(minY));
	const rowEnd = Math.min(height, Math.ceil(maxY));
	const crossings: Array<{x: number; dir: number}> = [];
	for (let row = rowStart; row < rowEnd; row++) {
		for (let s = 0; s < SUBSAMPLES; s++) {
			const y = row + (s + 0.5) / SUBSAMPLES;
			crossings.length = 0;
			for (const edge of edges) {
				if (y < edge.y0 || y >= edge.y1) {
					continue;
				}
				const t = (y - edge.y0) / (edge.y1 - edge.y0);
				crossings.push({x: edge.x0 + t * (edge.x1 - edge.x0), dir: edge.dir});
			}
			if (crossings.length < 2) {
				continue;
			}
			crossings.sort((a, b) => a.x - b.x);
			let winding = 0;
			for (let k = 0; k < crossings.length - 1; k++) {
				winding += crossings[k].dir;
				const inside = rule === "nonzero" ? winding !== 0 : (winding & 1) !== 0;
				if (!inside) {
					continue;
				}
				const left = Math.max(0, crossings[k].x);
				const right = Math.min(width, crossings[k + 1].x);
				if (right <= left) {
					continue;
				}
				addSpan(mask, row * width, left, right);
			}
		}
	}
	for (let i = 0; i < mask.length; i++) {
		mask[i] = Math.min(1, mask[i] / SUBSAMPLES);
	}
	return mask;
}

function addSpan(
	mask: Float32Array,
	base: number,
	left: number,
	right: number,
): void {
	const first = Math.floor(left);
	const last = Math.floor(right);
	if (first === last) {
		mask[base + first] += right - left;
		return;
	}
	mask[base + first] += first + 1 - left;
	for (let x = first + 1; x < last; x++) {
		mask[base + x] += 1;
	}
	if (right > last) {
		mask[base + last] += right - last;
	}
}

// The polygons a stroke covers, in device space. Each segment is a
// quadrilateral its width wide, each join and cap a shape of its own,
// and the rasterizer's nonzero rule unions them.
interface StrokeStyle {
	width: number;
	cap: CanvasLineCap;
	join: CanvasLineJoin;
	miterLimit: number;
	dash: number[];
	dashOffset: number;
}

type CanvasLineCap = "butt" | "round" | "square";
type CanvasLineJoin = "round" | "bevel" | "miter";

function circlePolygon(cx: number, cy: number, r: number): number[] {
	const n = Math.max(8, Math.min(64, Math.ceil(r * 4)));
	const points: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		points.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
	}
	return points;
}

function dashSubpath(
	points: number[],
	closed: boolean,
	style: StrokeStyle,
): number[][] {
	const all = closed && points.length >= 4
		? [...points, points[0], points[1]]
		: points;
	if (style.dash.length === 0) {
		return [all];
	}
	const pattern = style.dash.length % 2 === 0
		? style.dash
		: [...style.dash, ...style.dash];
	const total = pattern.reduce((sum, value) => sum + value, 0);
	if (total <= 0) {
		return [all];
	}
	const out: number[][] = [];
	let index = 0;
	let remaining = pattern[0];
	let on = true;
	let offset = ((style.dashOffset % total) + total) % total;
	while (offset > 0) {
		if (offset >= remaining) {
			offset -= remaining;
			index = (index + 1) % pattern.length;
			remaining = pattern[index];
			on = !on;
		} else {
			remaining -= offset;
			offset = 0;
		}
	}
	let current: number[] | null = on ? [all[0], all[1]] : null;
	for (let i = 2; i < all.length; i += 2) {
		let x0 = all[i - 2];
		let y0 = all[i - 1];
		const x1 = all[i];
		const y1 = all[i + 1];
		let length = Math.hypot(x1 - x0, y1 - y0);
		while (length > 0) {
			const step = Math.min(remaining, length);
			const t = step / length;
			const x = x0 + (x1 - x0) * t;
			const y = y0 + (y1 - y0) * t;
			if (on) {
				current!.push(x, y);
			}
			remaining -= step;
			length -= step;
			x0 = x;
			y0 = y;
			if (remaining <= 1e-9) {
				if (on && current !== null && current.length >= 4) {
					out.push(current);
				}
				on = !on;
				index = (index + 1) % pattern.length;
				remaining = pattern[index];
				current = on ? [x, y] : null;
			}
		}
	}
	if (on && current !== null && current.length >= 4) {
		out.push(current);
	}
	return out;
}

function strokePolygons(
	subpaths: Subpath[],
	style: StrokeStyle,
	scale: number,
): number[][] {
	const half = (style.width * scale) / 2;
	const polygons: number[][] = [];
	if (!(half > 0)) {
		return polygons;
	}
	for (const subpath of subpaths) {
		// Repeated points are dropped, so no segment has zero length.
		const cleaned: number[] = [];
		for (let i = 0; i < subpath.points.length; i += 2) {
			const x = subpath.points[i];
			const y = subpath.points[i + 1];
			if (
				cleaned.length === 0 ||
				Math.hypot(x - cleaned.at(-2)!, y - cleaned.at(-1)!) > 1e-9
			) {
				cleaned.push(x, y);
			}
		}
		if (cleaned.length === 2) {
			// A zero-length segment draws its caps, if they have area. A
			// moveTo() alone draws nothing.
			if (subpath.points.length >= 4 && style.cap === "round") {
				polygons.push(circlePolygon(cleaned[0], cleaned[1], half));
			} else if (subpath.points.length >= 4 && style.cap === "square") {
				const [x, y] = cleaned;
				polygons.push([
					x - half,
					y - half,
					x + half,
					y - half,
					x + half,
					y + half,
					x - half,
					y + half,
				]);
			}
			continue;
		}
		const closed = subpath.closed && cleaned.length >= 6;
		for (const run of dashSubpath(cleaned, closed, style)) {
			const count = run.length / 2;
			for (let i = 0; i < count - 1; i++) {
				let x0 = run[i * 2];
				let y0 = run[i * 2 + 1];
				let x1 = run[i * 2 + 2];
				let y1 = run[i * 2 + 3];
				const length = Math.hypot(x1 - x0, y1 - y0);
				if (length === 0) {
					continue;
				}
				const nx = (-(y1 - y0) / length) * half;
				const ny = ((x1 - x0) / length) * half;
				const isOpenEnd = !(closed && style.dash.length === 0);
				if (style.cap === "square" && isOpenEnd) {
					const ex = ((x1 - x0) / length) * half;
					const ey = ((y1 - y0) / length) * half;
					if (i === 0) {
						x0 -= ex;
						y0 -= ey;
					}
					if (i === count - 2) {
						x1 += ex;
						y1 += ey;
					}
				}
				polygons.push([
					x0 + nx,
					y0 + ny,
					x1 + nx,
					y1 + ny,
					x1 - nx,
					y1 - ny,
					x0 - nx,
					y0 - ny,
				]);
			}
			// Joins at the inner vertices, and at the start of a closed run.
			const joinAt = (i: number, prev: number, next: number) => {
				const x = run[i * 2];
				const y = run[i * 2 + 1];
				if (style.join === "round") {
					polygons.push(circlePolygon(x, y, half));
					return;
				}
				const ax = x - run[prev * 2];
				const ay = y - run[prev * 2 + 1];
				const bx = run[next * 2] - x;
				const by = run[next * 2 + 1] - y;
				const la = Math.hypot(ax, ay);
				const lb = Math.hypot(bx, by);
				if (la === 0 || lb === 0) {
					return;
				}
				const cross = ax * by - ay * bx;
				// The outer side of the turn.
				const side = cross > 0 ? -1 : 1;
				const n0x = (-ay / la) * half * side;
				const n0y = (ax / la) * half * side;
				const n1x = (-by / lb) * half * side;
				const n1y = (bx / lb) * half * side;
				const bevel = [x, y, x + n0x, y + n0y, x + n1x, y + n1y];
				if (style.join === "miter") {
					const cos = (ax * bx + ay * by) / (la * lb);
					const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
					const ratio = 1 / Math.sin((Math.PI - theta) / 2);
					if (Number.isFinite(ratio) && ratio <= style.miterLimit) {
						const mx = n0x + n1x;
						const my = n0y + n1y;
						const ml = Math.hypot(mx, my);
						if (ml > 0) {
							const reach = half * ratio;
							polygons.push([
								x,
								y,
								x + n0x,
								y + n0y,
								x + (mx / ml) * reach,
								y + (my / ml) * reach,
								x + n1x,
								y + n1y,
							]);
							return;
						}
					}
				}
				polygons.push(bevel);
			};
			for (let i = 1; i < count - 1; i++) {
				joinAt(i, i - 1, i + 1);
			}
			const isLoop = closed && style.dash.length === 0;
			if (isLoop && count > 2) {
				joinAt(count - 1, count - 2, 1);
			}
			if (style.cap === "round" && !isLoop) {
				polygons.push(circlePolygon(run[0], run[1], half));
				polygons.push(circlePolygon(run.at(-2)!, run.at(-1)!, half));
			}
		}
	}
	// Every piece winds the same way, so the nonzero rule unions them
	// where they overlap instead of cancelling.
	return polygons.map(windPositive);
}

function windPositive(points: number[]): number[] {
	let area = 0;
	const count = points.length / 2;
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % count;
		area +=
			points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
	}
	if (area >= 0) {
		return points;
	}
	const reversed: number[] = [];
	for (let i = count - 1; i >= 0; i--) {
		reversed.push(points[i * 2], points[i * 2 + 1]);
	}
	return reversed;
}

function pathPolygons(subpaths: Subpath[]): number[][] {
	return subpaths
		.filter((subpath) => subpath.points.length >= 6)
		.map((subpath) => subpath.points);
}

// ---------------------------------------------------------------------------
// Paint sources.

const kStops = Symbol("stops");
const kPosition = Symbol("position");

export interface CanvasGradient {
	[kStops]: Array<{offset: number; color: RGBA}>;
	[kPosition]: (x: number, y: number) => number;
}

export class CanvasGradient {
	constructor(position: (x: number, y: number) => number) {
		this[kStops] = [];
		this[kPosition] = position;
	}

	addColorStop(offset: number, color: string): void {
		if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
			throw domException("IndexSizeError", "The offset is outside 0 to 1");
		}
		const parsed = parseCanvasColor(String(color));
		if (parsed === null) {
			throw domException("SyntaxError", "The color does not parse");
		}
		// A stop at an equal offset goes after the ones there already.
		let index = this[kStops].length;
		while (index > 0 && this[kStops][index - 1].offset > offset) {
			index--;
		}
		this[kStops].splice(index, 0, {offset, color: parsed});
	}

	/** The color at a user-space point, or null where the gradient has none. */
	colorAt(x: number, y: number): RGBA | null {
		const stops = this[kStops];
		if (stops.length === 0) {
			return {r: 0, g: 0, b: 0, a: 0};
		}
		const t = this[kPosition](x, y);
		if (Number.isNaN(t)) {
			return null;
		}
		if (t <= stops[0].offset) {
			return stops[0].color;
		}
		const last = stops[stops.length - 1];
		if (t >= last.offset) {
			return last.color;
		}
		for (let i = 1; i < stops.length; i++) {
			const a = stops[i - 1];
			const b = stops[i];
			if (t <= b.offset) {
				const span = b.offset - a.offset;
				const u = span === 0 ? 1 : (t - a.offset) / span;
				// HTML interpolates the four channels as they are, without
				// premultiplying.
				const mix = (p: number, q: number) => p + (q - p) * u;
				return {
					r: mix(a.color.r, b.color.r),
					g: mix(a.color.g, b.color.g),
					b: mix(a.color.b, b.color.b),
					a: mix(a.color.a, b.color.a),
				};
			}
		}
		return last.color;
	}
}

const kPatternBitmap = Symbol("patternBitmap");
const kRepeatX = Symbol("repeatX");
const kRepeatY = Symbol("repeatY");
const kPatternTransform = Symbol("patternTransform");

export interface CanvasPattern {
	[kPatternBitmap]: Bitmap;
	[kRepeatX]: boolean;
	[kRepeatY]: boolean;
	[kPatternTransform]: Matrix;
}

export class CanvasPattern {
	constructor(bitmap: Bitmap, repetition: string) {
		this[kPatternTransform] = [1, 0, 0, 1, 0, 0];
		this[kPatternBitmap] = bitmap;
		this[kRepeatX] =
			repetition === "repeat" || repetition === "repeat-x" || repetition === "";
		this[kRepeatY] =
			repetition === "repeat" || repetition === "repeat-y" || repetition === "";
	}

	setTransform(transform?: Partial<CanvasMatrix>): void {
		this[kPatternTransform] = [
			transform?.a ?? 1,
			transform?.b ?? 0,
			transform?.c ?? 0,
			transform?.d ?? 1,
			transform?.e ?? 0,
			transform?.f ?? 0,
		];
	}

	colorAt(x: number, y: number): RGBA {
		const inverse = invert(this[kPatternTransform]);
		if (inverse !== null) {
			[x, y] = apply(inverse, x, y);
		}
		const bitmap = this[kPatternBitmap];
		const {width, height, data} = bitmap;
		// The pattern tiles at the image's natural size.
		let px = Math.floor((x * width) / naturalWidthOf(bitmap));
		let py = Math.floor((y * height) / naturalHeightOf(bitmap));
		if (this[kRepeatX]) {
			px = ((px % width) + width) % width;
		}
		if (this[kRepeatY]) {
			py = ((py % height) + height) % height;
		}
		if (px < 0 || py < 0 || px >= width || py >= height) {
			return {r: 0, g: 0, b: 0, a: 0};
		}
		const at = (py * width + px) * 4;
		return {
			r: data[at],
			g: data[at + 1],
			b: data[at + 2],
			a: data[at + 3] / 255,
		};
	}
}

type Paint = string | CanvasGradient | CanvasPattern;

// ---------------------------------------------------------------------------
// Compositing: Porter-Duff on straight RGBA, through a coverage value.

const COMPOSITE_OPERATIONS = new Set<string>([
	"source-over",
	"source-in",
	"source-out",
	"source-atop",
	"destination-over",
	"destination-in",
	"destination-out",
	"destination-atop",
	"lighter",
	"copy",
	"xor",
]);

// The operations that change pixels the shape does not cover: they act
// on the whole clip region, with the source transparent outside the
// shape.
const UNBOUNDED = new Set<string>([
	"source-in",
	"source-out",
	"destination-in",
	"destination-atop",
	"copy",
]);

function composite(
	data: Uint8ClampedArray,
	at: number,
	sr: number,
	sg: number,
	sb: number,
	sa: number,
	operation: string,
): void {
	const da = data[at + 3] / 255;
	const dr = data[at];
	const dg = data[at + 1];
	const db = data[at + 2];
	// The Porter-Duff factors for source and destination.
	let fs: number;
	let fd: number;
	switch (operation) {
		case "source-in":
			fs = da;
			fd = 0;
			break;
		case "source-out":
			fs = 1 - da;
			fd = 0;
			break;
		case "source-atop":
			fs = da;
			fd = 1 - sa;
			break;
		case "destination-over":
			fs = 1 - da;
			fd = 1;
			break;
		case "destination-in":
			fs = 0;
			fd = sa;
			break;
		case "destination-out":
			fs = 0;
			fd = 1 - sa;
			break;
		case "destination-atop":
			fs = 1 - da;
			fd = sa;
			break;
		case "copy":
			fs = 1;
			fd = 0;
			break;
		case "xor":
			fs = 1 - da;
			fd = 1 - sa;
			break;
		case "lighter":
			fs = 1;
			fd = 1;
			break;
		default:
			fs = 1;
			fd = 1 - sa;
			break;
	}
	const outA = Math.min(1, sa * fs + da * fd);
	if (outA <= 0) {
		data[at] = data[at + 1] = data[at + 2] = data[at + 3] = 0;
		return;
	}
	data[at] = Math.min(255, (sr * sa * fs + dr * da * fd) / outA);
	data[at + 1] = Math.min(255, (sg * sa * fs + dg * da * fd) / outA);
	data[at + 2] = Math.min(255, (sb * sa * fs + db * da * fd) / outA);
	data[at + 3] = outA * 255;
}

// ---------------------------------------------------------------------------
// The 2d context.

/** Text a 2d context drew, painted as cells over its pixels. */
export interface CanvasTextRun {
	text: string;
	// The anchor in bitmap pixels, after the transform.
	x: number;
	y: number;
	align: "left" | "center" | "right";
	baseline: string;
	color: RGBA;
	bold: boolean;
	italic: boolean;
}

interface State {
	transform: Matrix;
	fillStyle: Paint;
	strokeStyle: Paint;
	globalAlpha: number;
	globalCompositeOperation: string;
	lineWidth: number;
	lineCap: CanvasLineCap;
	lineJoin: CanvasLineJoin;
	miterLimit: number;
	lineDash: number[];
	lineDashOffset: number;
	font: string;
	textAlign: string;
	textBaseline: string;
	direction: string;
	imageSmoothingEnabled: boolean;
	imageSmoothingQuality: string;
	shadowBlur: number;
	shadowColor: string;
	shadowOffsetX: number;
	shadowOffsetY: number;
	filter: string;
	clip: Float32Array | null;
}

function defaultState(): State {
	return {
		transform: [1, 0, 0, 1, 0, 0],
		fillStyle: "#000000",
		strokeStyle: "#000000",
		globalAlpha: 1,
		globalCompositeOperation: "source-over",
		lineWidth: 1,
		lineCap: "butt",
		lineJoin: "miter",
		miterLimit: 10,
		lineDash: [],
		lineDashOffset: 0,
		font: "10px sans-serif",
		textAlign: "start",
		textBaseline: "alphabetic",
		direction: "inherit",
		imageSmoothingEnabled: true,
		imageSmoothingQuality: "low",
		shadowBlur: 0,
		shadowColor: "rgba(0, 0, 0, 0)",
		shadowOffsetX: 0,
		shadowOffsetY: 0,
		filter: "none",
		clip: null,
	};
}

/** What a context needs from its canvas element. */
export interface CanvasHost {
	canvas: object;
	bitmap(): Bitmap;
	// Called after every change to the pixels or the text runs.
	changed(): void;
	// Bitmap pixels per cell, as the canvas is shown, for measureText().
	pixelsPerCell(): {x: number; y: number};
}

const kHost = Symbol("host");
const kText = Symbol("text");

const kState = Symbol("state");
const kStack = Symbol("stack");
const kPath = Symbol("path");
const kSetMatrix = Symbol("setMatrix");
const kSubpathsFor = Symbol("subpathsFor");
const kReadPathArgs = Symbol("readPathArgs");
const kStrokeStyle = Symbol("strokeStyle");
const kScale = Symbol("scale");
const kRectMask = Symbol("rectMask");
const kPaint = Symbol("paint");
const kDropText = Symbol("dropText");
const kDrawText = Symbol("drawText");

export interface CanvasRenderingContext2D {
	[kHost]: CanvasHost;
	[kText]: CanvasTextRun[];
	[kState]: State;
	[kStack]: State[];
	[kPath]: PathBuilder;
}

export class CanvasRenderingContext2D {
	constructor(host: CanvasHost) {
		this[kText] = [];
		this[kState] = defaultState();
		this[kStack] = [];
		this[kPath] = new PathBuilder();
		this[kHost] = host;
	}

	get canvas(): object {
		return this[kHost].canvas;
	}

	get fillStyle(): Paint {
		return this[kState].fillStyle;
	}

	set fillStyle(value: Paint) {
		this[kState].fillStyle = readPaint(value, this[kState].fillStyle);
	}

	get strokeStyle(): Paint {
		return this[kState].strokeStyle;
	}

	set strokeStyle(value: Paint) {
		this[kState].strokeStyle = readPaint(value, this[kState].strokeStyle);
	}

	get globalAlpha(): number {
		return this[kState].globalAlpha;
	}

	set globalAlpha(value: number) {
		if (Number.isFinite(value) && value >= 0 && value <= 1) {
			this[kState].globalAlpha = value;
		}
	}

	get globalCompositeOperation(): string {
		return this[kState].globalCompositeOperation;
	}

	set globalCompositeOperation(value: string) {
		if (COMPOSITE_OPERATIONS.has(value)) {
			this[kState].globalCompositeOperation = value;
		}
	}

	get lineWidth(): number {
		return this[kState].lineWidth;
	}

	set lineWidth(value: number) {
		if (Number.isFinite(value) && value > 0) {
			this[kState].lineWidth = value;
		}
	}

	get lineCap(): CanvasLineCap {
		return this[kState].lineCap;
	}

	set lineCap(value: CanvasLineCap) {
		if (value === "butt" || value === "round" || value === "square") {
			this[kState].lineCap = value;
		}
	}

	get lineJoin(): CanvasLineJoin {
		return this[kState].lineJoin;
	}

	set lineJoin(value: CanvasLineJoin) {
		if (value === "round" || value === "bevel" || value === "miter") {
			this[kState].lineJoin = value;
		}
	}

	get miterLimit(): number {
		return this[kState].miterLimit;
	}

	set miterLimit(value: number) {
		if (Number.isFinite(value) && value > 0) {
			this[kState].miterLimit = value;
		}
	}

	get lineDashOffset(): number {
		return this[kState].lineDashOffset;
	}

	set lineDashOffset(value: number) {
		if (Number.isFinite(value)) {
			this[kState].lineDashOffset = value;
		}
	}

	get font(): string {
		return this[kState].font;
	}

	set font(value: string) {
		this[kState].font = String(value);
	}

	get textAlign(): string {
		return this[kState].textAlign;
	}

	set textAlign(value: string) {
		if (["start", "end", "left", "right", "center"].includes(value)) {
			this[kState].textAlign = value;
		}
	}

	get textBaseline(): string {
		return this[kState].textBaseline;
	}

	set textBaseline(value: string) {
		if (["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"]
			.includes(value)) {
			this[kState].textBaseline = value;
		}
	}

	get direction(): string {
		return this[kState].direction;
	}

	set direction(value: string) {
		if (value === "ltr" || value === "rtl" || value === "inherit") {
			this[kState].direction = value;
		}
	}

	get imageSmoothingEnabled(): boolean {
		return this[kState].imageSmoothingEnabled;
	}

	set imageSmoothingEnabled(value: boolean) {
		this[kState].imageSmoothingEnabled = Boolean(value);
	}

	get imageSmoothingQuality(): string {
		return this[kState].imageSmoothingQuality;
	}

	set imageSmoothingQuality(value: string) {
		if (value === "low" || value === "medium" || value === "high") {
			this[kState].imageSmoothingQuality = value;
		}
	}

	// Shadows and filters are kept for an author to read back. A cell
	// cannot hold a blur, so they paint nothing.
	get shadowBlur(): number {
		return this[kState].shadowBlur;
	}

	set shadowBlur(value: number) {
		if (Number.isFinite(value) && value >= 0) {
			this[kState].shadowBlur = value;
		}
	}

	get shadowColor(): string {
		return this[kState].shadowColor;
	}

	set shadowColor(value: string) {
		const color = parseCanvasColor(String(value));
		if (color !== null) {
			this[kState].shadowColor = serializeColor(color);
		}
	}

	get shadowOffsetX(): number {
		return this[kState].shadowOffsetX;
	}

	set shadowOffsetX(value: number) {
		if (Number.isFinite(value)) {
			this[kState].shadowOffsetX = value;
		}
	}

	get shadowOffsetY(): number {
		return this[kState].shadowOffsetY;
	}

	set shadowOffsetY(value: number) {
		if (Number.isFinite(value)) {
			this[kState].shadowOffsetY = value;
		}
	}

	get filter(): string {
		return this[kState].filter;
	}

	set filter(value: string) {
		this[kState].filter = String(value);
	}

	getContextAttributes(): {
		alpha: boolean;
		colorSpace: string;
		desynchronized: boolean;
		willReadFrequently: boolean;
	} {
		return {
			alpha: true,
			colorSpace: "srgb",
			desynchronized: false,
			willReadFrequently: false,
		};
	}

	isContextLost(): boolean {
		return false;
	}

	save(): void {
		this[kStack].push({...this[kState], lineDash: [...this[kState].lineDash]});
	}

	restore(): void {
		const state = this[kStack].pop();
		if (state !== undefined) {
			this[kState] = state;
			this[kPath].transform = state.transform;
		}
	}

	reset(): void {
		this[kState] = defaultState();
		this[kStack] = [];
		this[kPath] = new PathBuilder();
		this[kHost].bitmap().data.fill(0);
		this[kText] = [];
		this[kHost].changed();
	}

	scale(x: number, y: number): void {
		this[kSetMatrix](multiply(this[kState].transform, [x, 0, 0, y, 0, 0]));
	}

	rotate(angle: number): void {
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		this[kSetMatrix](
			multiply(this[kState].transform, [cos, sin, -sin, cos, 0, 0]),
		);
	}

	translate(x: number, y: number): void {
		this[kSetMatrix](multiply(this[kState].transform, [1, 0, 0, 1, x, y]));
	}

	transform(
		a: number,
		b: number,
		c: number,
		d: number,
		e: number,
		f: number,
	): void {
		this[kSetMatrix](multiply(this[kState].transform, [a, b, c, d, e, f]));
	}

	setTransform(
		a?: number | Partial<CanvasMatrix>,
		b?: number,
		c?: number,
		d?: number,
		e?: number,
		f?: number,
	): void {
		if (typeof a === "number") {
			this[kSetMatrix]([a, b!, c!, d!, e!, f!]);
		} else {
			this[kSetMatrix]([
				a?.a ?? 1,
				a?.b ?? 0,
				a?.c ?? 0,
				a?.d ?? 1,
				a?.e ?? 0,
				a?.f ?? 0,
			]);
		}
	}

	resetTransform(): void {
		this[kSetMatrix]([1, 0, 0, 1, 0, 0]);
	}

	getTransform(): CanvasMatrix {
		return new CanvasMatrix([...this[kState].transform] as Matrix);
	}

	setLineDash(segments: number[]): void {
		if (segments.some((value) => !Number.isFinite(value) || value < 0)) {
			return;
		}
		this[kState].lineDash = segments.length % 2 === 0
			? [...segments]
			: [...segments, ...segments];
	}

	getLineDash(): number[] {
		return [...this[kState].lineDash];
	}

	createLinearGradient(
		x0: number,
		y0: number,
		x1: number,
		y1: number,
	): CanvasGradient {
		if (!isFiniteAll(x0, y0, x1, y1)) {
			throw new TypeError("The gradient's points must be finite");
		}
		const dx = x1 - x0;
		const dy = y1 - y0;
		const length = dx * dx + dy * dy;
		return new CanvasGradient((x, y) =>
			length === 0 ? NaN : ((x - x0) * dx + (y - y0) * dy) / length,
		);
	}

	createRadialGradient(
		x0: number,
		y0: number,
		r0: number,
		x1: number,
		y1: number,
		r1: number,
	): CanvasGradient {
		if (!isFiniteAll(x0, y0, r0, x1, y1, r1)) {
			throw new TypeError("The gradient's circles must be finite");
		}
		if (r0 < 0 || r1 < 0) {
			throw domException("IndexSizeError", "A radius is negative");
		}
		// The largest t whose circle passes through the point (HTML's
		// two-circle gradient), solved as a quadratic.
		const cdx = x1 - x0;
		const cdy = y1 - y0;
		const dr = r1 - r0;
		const a = cdx * cdx + cdy * cdy - dr * dr;
		return new CanvasGradient((x, y) => {
			const px = x - x0;
			const py = y - y0;
			const b = px * cdx + py * cdy + r0 * dr;
			const c = px * px + py * py - r0 * r0;
			if (Math.abs(a) < 1e-9) {
				if (b === 0) {
					return NaN;
				}
				const t = c / (2 * b);
				return r0 + t * dr >= 0 ? t : NaN;
			}
			const discriminant = b * b - a * c;
			if (discriminant < 0) {
				return NaN;
			}
			const root = Math.sqrt(discriminant);
			for (const t of [(b + root) / a, (b - root) / a].sort((p, q) => q - p)) {
				if (r0 + t * dr >= 0) {
					return t;
				}
			}
			return NaN;
		});
	}

	createConicGradient(start: number, x: number, y: number): CanvasGradient {
		if (!isFiniteAll(start, x, y)) {
			throw new TypeError("The gradient's center and angle must be finite");
		}
		return new CanvasGradient((px, py) => {
			const angle = Math.atan2(py - y, px - x) - start;
			const turn = Math.PI * 2;
			return (((angle % turn) + turn) % turn) / turn;
		});
	}

	createPattern(
		image: unknown,
		repetition: string | null,
	): CanvasPattern | null {
		const bitmap = readDrawable(image);
		const mode = repetition ?? "";
		if (!["", "repeat", "repeat-x", "repeat-y", "no-repeat"].includes(mode)) {
			throw domException("SyntaxError", "The repetition is not one HTML names");
		}
		if (bitmap === null || bitmap.width === 0 || bitmap.height === 0) {
			return null;
		}
		const copy = createBitmap(bitmap.width, bitmap.height);
		copy.data.set(bitmap.data);
		copy.naturalWidth = naturalWidthOf(bitmap);
		copy.naturalHeight = naturalHeightOf(bitmap);
		return new CanvasPattern(copy, mode);
	}

	beginPath(): void {
		this[kPath].clear();
	}

	closePath(): void {
		this[kPath].closePath();
	}

	moveTo(x: number, y: number): void {
		this[kPath].moveTo(x, y);
	}

	lineTo(x: number, y: number): void {
		this[kPath].lineTo(x, y);
	}

	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
		this[kPath].quadraticCurveTo(cx, cy, x, y);
	}

	bezierCurveTo(
		c1x: number,
		c1y: number,
		c2x: number,
		c2y: number,
		x: number,
		y: number,
	): void {
		this[kPath].bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
	}

	arc(
		x: number,
		y: number,
		radius: number,
		start: number,
		end: number,
		counterclockwise?: boolean,
	): void {
		this[kPath].arc(x, y, radius, start, end, counterclockwise);
	}

	arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
		this[kPath].arcTo(x1, y1, x2, y2, radius);
	}

	ellipse(
		x: number,
		y: number,
		rx: number,
		ry: number,
		rotation: number,
		start: number,
		end: number,
		counterclockwise?: boolean,
	): void {
		this[kPath].ellipse(x, y, rx, ry, rotation, start, end, counterclockwise);
	}

	rect(x: number, y: number, w: number, h: number): void {
		this[kPath].rect(x, y, w, h);
	}

	roundRect(
		x: number,
		y: number,
		w: number,
		h: number,
		radii?: number | DOMPointInit | Array<number | DOMPointInit>,
	): void {
		this[kPath].roundRect(x, y, w, h, radii);
	}

	fill(pathOrRule?: Path2D | FillRule, rule?: FillRule): void {
		const args = this[kReadPathArgs](pathOrRule, rule);
		const bitmap = this[kHost].bitmap();
		const mask = rasterize(
			pathPolygons(this[kSubpathsFor](args.path)),
			bitmap.width,
			bitmap.height,
			args.rule,
		);
		this[kPaint](mask, this[kState].fillStyle);
	}

	stroke(path?: Path2D): void {
		const bitmap = this[kHost].bitmap();
		const mask = rasterize(
			strokePolygons(
				this[kSubpathsFor](path),
				this[kStrokeStyle](),
				this[kScale](),
			),
			bitmap.width,
			bitmap.height,
			"nonzero",
		);
		this[kPaint](mask, this[kState].strokeStyle);
	}

	clip(pathOrRule?: Path2D | FillRule, rule?: FillRule): void {
		const args = this[kReadPathArgs](pathOrRule, rule);
		const bitmap = this[kHost].bitmap();
		const mask = rasterize(
			pathPolygons(this[kSubpathsFor](args.path)),
			bitmap.width,
			bitmap.height,
			args.rule,
		);
		const previous = this[kState].clip;
		if (previous !== null) {
			for (let i = 0; i < mask.length; i++) {
				mask[i] *= previous[i];
			}
		}
		this[kState].clip = mask;
	}

	isPointInPath(
		pathOrX: Path2D | number,
		xOrY: number,
		yOrRule?: number | FillRule,
		maybeRule?: FillRule,
	): boolean {
		let path: Path2D | undefined;
		let x: number;
		let y: number;
		let rule: FillRule;
		if (pathOrX instanceof Path2D) {
			path = pathOrX;
			x = xOrY;
			y = yOrRule as number;
			rule = maybeRule === "evenodd" ? "evenodd" : "nonzero";
		} else {
			x = pathOrX;
			y = xOrY;
			rule = yOrRule === "evenodd" ? "evenodd" : "nonzero";
		}
		if (!isFiniteAll(x, y)) {
			return false;
		}
		// The point is in canvas coordinates, unaffected by the transform.
		let winding = 0;
		let crossings = 0;
		for (const points of pathPolygons(this[kSubpathsFor](path))) {
			const count = points.length / 2;
			for (let i = 0; i < count; i++) {
				const ax = points[i * 2];
				const ay = points[i * 2 + 1];
				const bx = points[((i + 1) % count) * 2];
				const by = points[((i + 1) % count) * 2 + 1];
				if ((ay <= y) !== (by <= y)) {
					const cross = ax + ((y - ay) / (by - ay)) * (bx - ax);
					if (cross > x) {
						crossings++;
						winding += by > ay ? 1 : -1;
					}
				}
			}
		}
		return rule === "nonzero" ? winding !== 0 : (crossings & 1) === 1;
	}

	isPointInStroke(
		pathOrX: Path2D | number,
		xOrY: number,
		maybeY?: number,
	): boolean {
		const path = pathOrX instanceof Path2D ? pathOrX : undefined;
		const x = path ? xOrY : (pathOrX as number);
		const y = path ? maybeY! : xOrY;
		if (!isFiniteAll(x, y)) {
			return false;
		}
		for (const points of strokePolygons(
			this[kSubpathsFor](path),
			this[kStrokeStyle](),
			this[kScale](),
		)) {
			let inside = false;
			const count = points.length / 2;
			for (let i = 0, j = count - 1; i < count; j = i++) {
				const xi = points[i * 2];
				const yi = points[i * 2 + 1];
				const xj = points[j * 2];
				const yj = points[j * 2 + 1];
				if (
					(yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
				) {
					inside = !inside;
				}
			}
			if (inside) {
				return true;
			}
		}
		return false;
	}

	fillRect(x: number, y: number, w: number, h: number): void {
		if (!isFiniteAll(x, y, w, h) || w === 0 || h === 0) {
			return;
		}
		this[kPaint](this[kRectMask](x, y, w, h), this[kState].fillStyle);
	}

	strokeRect(x: number, y: number, w: number, h: number): void {
		if (!isFiniteAll(x, y, w, h)) {
			return;
		}
		const builder = new PathBuilder();
		builder.transform = this[kState].transform;
		builder.rect(x, y, w, h);
		const bitmap = this[kHost].bitmap();
		const mask = rasterize(
			strokePolygons(builder[kSubpaths], this[kStrokeStyle](), this[kScale]()),
			bitmap.width,
			bitmap.height,
			"nonzero",
		);
		this[kPaint](mask, this[kState].strokeStyle);
	}

	clearRect(x: number, y: number, w: number, h: number): void {
		if (!isFiniteAll(x, y, w, h)) {
			return;
		}
		const mask = this[kRectMask](x, y, w, h);
		const clip = this[kState].clip;
		const data = this[kHost].bitmap().data;
		for (let i = 0; i < mask.length; i++) {
			const cover = mask[i] * (clip === null ? 1 : clip[i]);
			if (cover <= 0) {
				continue;
			}
			const at = i * 4;
			const keep = 1 - cover;
			data[at + 3] *= keep;
			if (data[at + 3] === 0) {
				data[at] = data[at + 1] = data[at + 2] = 0;
			}
		}
		this[kDropText](mask, 0.5);
		this[kHost].changed();
	}

	drawImage(image: unknown, ...args: number[]): void {
		const bitmap = readDrawable(image);
		if (bitmap === null || bitmap.width === 0 || bitmap.height === 0) {
			return;
		}
		let sx = 0;
		let sy = 0;
		let sw = naturalWidthOf(bitmap);
		let sh = naturalHeightOf(bitmap);
		let dx: number;
		let dy: number;
		let dw: number;
		let dh: number;
		if (args.length === 2) {
			[dx, dy] = args;
			dw = sw;
			dh = sh;
		} else if (args.length === 4) {
			[dx, dy, dw, dh] = args;
		} else if (args.length === 8) {
			[sx, sy, sw, sh, dx, dy, dw, dh] = args;
		} else {
			throw new TypeError("drawImage takes 3, 5 or 9 arguments");
		}
		if (
			!isFiniteAll(sx, sy, sw, sh, dx, dy, dw, dh) ||
			sw === 0 ||
			sh === 0 ||
			dw === 0 ||
			dh === 0
		) {
			return;
		}
		// Negative sizes name the same rectangle from its other corner; they
		// do not flip the image.
		[sx, sw] = sw < 0 ? [sx + sw, -sw] : [sx, sw];
		[sy, sh] = sh < 0 ? [sy + sh, -sh] : [sy, sh];
		[dx, dw] = dw < 0 ? [dx + dw, -dw] : [dx, dw];
		[dy, dh] = dh < 0 ? [dy + dh, -dh] : [dy, dh];
		// A source rectangle past the image's edges is clipped to them, and
		// the destination shrinks with it (HTML's drawImage step 6).
		const scaleX = dw / sw;
		const scaleY = dh / sh;
		const clippedX = Math.max(0, sx);
		const clippedY = Math.max(0, sy);
		const clippedRight = Math.min(naturalWidthOf(bitmap), sx + sw);
		const clippedBottom = Math.min(naturalHeightOf(bitmap), sy + sh);
		if (clippedRight <= clippedX || clippedBottom <= clippedY) {
			return;
		}
		dx += (clippedX - sx) * scaleX;
		dy += (clippedY - sy) * scaleY;
		dw = (clippedRight - clippedX) * scaleX;
		dh = (clippedBottom - clippedY) * scaleY;
		sx = clippedX;
		sy = clippedY;
		sw = clippedRight - clippedX;
		sh = clippedBottom - clippedY;
		const target = this[kHost].bitmap();
		// Drawing a canvas onto itself reads the pixels as they were.
		const source = bitmap.data === target.data
			? {...bitmap, data: bitmap.data.slice()}
			: bitmap;
		const builder = new PathBuilder();
		builder.transform = this[kState].transform;
		builder.rect(dx, dy, dw, dh);
		const mask = rasterize(
			pathPolygons(builder[kSubpaths]),
			target.width,
			target.height,
			"nonzero",
		);
		const inverse = invert(this[kState].transform);
		if (inverse === null) {
			return;
		}
		const operation = this[kState].globalCompositeOperation;
		const unbounded = UNBOUNDED.has(operation);
		const alpha = this[kState].globalAlpha;
		const clip = this[kState].clip;
		const smooth = this[kState].imageSmoothingEnabled;
		const {width, height, data} = target;
		// The source rectangle is in natural pixels. An image may keep fewer.
		const keptX = source.width / naturalWidthOf(source);
		const keptY = source.height / naturalHeightOf(source);
		const sample = (u: number, v: number): RGBA => {
			const px = (sx + ((u - dx) / dw) * sw) * keptX;
			const py = (sy + ((v - dy) / dh) * sh) * keptY;
			if (!smooth) {
				const ix = Math.min(source.width - 1, Math.max(0, Math.floor(px)));
				const iy = Math.min(source.height - 1, Math.max(0, Math.floor(py)));
				const at = (iy * source.width + ix) * 4;
				return {
					r: source.data[at],
					g: source.data[at + 1],
					b: source.data[at + 2],
					a: source.data[at + 3] / 255,
				};
			}
			// Bilinear between the four pixels around the point, weighting
			// color by alpha.
			const fx = Math.min(source.width - 1, Math.max(0, px - 0.5));
			const fy = Math.min(source.height - 1, Math.max(0, py - 0.5));
			const x0 = Math.floor(fx);
			const y0 = Math.floor(fy);
			const x1 = Math.min(source.width - 1, x0 + 1);
			const y1 = Math.min(source.height - 1, y0 + 1);
			const tx = fx - x0;
			const ty = fy - y0;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (const [ix, iy, weight] of [
				[x0, y0, (1 - tx) * (1 - ty)],
				[x1, y0, tx * (1 - ty)],
				[x0, y1, (1 - tx) * ty],
				[x1, y1, tx * ty],
			]) {
				const at = (iy * source.width + ix) * 4;
				const pa = (source.data[at + 3] / 255) * weight;
				r += source.data[at] * pa;
				g += source.data[at + 1] * pa;
				b += source.data[at + 2] * pa;
				a += pa;
			}
			return a === 0
				? {r: 0, g: 0, b: 0, a: 0}
				: {r: r / a, g: g / a, b: b / a, a};
		};
		// Large downscales average the source area a pixel covers, so a
		// photo drawn small does not alias.
		const scale = this[kScale]();
		const shrinkX = Math.abs(sw / (dw * scale));
		const shrinkY = Math.abs(sh / (dh * scale));
		const average = smooth && (shrinkX > 2 || shrinkY > 2);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = y * width + x;
				const cover = mask[i];
				const clipCover = clip === null ? 1 : clip[i];
				if ((cover <= 0 && !unbounded) || clipCover <= 0) {
					continue;
				}
				let color: RGBA = {r: 0, g: 0, b: 0, a: 0};
				if (cover > 0) {
					const [u, v] = apply(inverse, x + 0.5, y + 0.5);
					if (average) {
						const [u0, v0] = apply(inverse, x, y);
						const [u1, v1] = apply(inverse, x + 1, y + 1);
						const px0 = sx + ((Math.min(u0, u1) - dx) / dw) * sw;
						const px1 = sx + ((Math.max(u0, u1) - dx) / dw) * sw;
						const py0 = sy + ((Math.min(v0, v1) - dy) / dh) * sh;
						const py1 = sy + ((Math.max(v0, v1) - dy) / dh) * sh;
						const area = averageBitmap(
							source,
							Math.min(px0, px1),
							Math.min(py0, py1),
							Math.max(px0, px1),
							Math.max(py0, py1),
						);
						color = {r: area[0], g: area[1], b: area[2], a: area[3] / 255};
					} else {
						color = sample(u, v);
					}
				}
				const before = clipCover < 1
					? [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]]
					: null;
				composite(
					data,
					i * 4,
					color.r,
					color.g,
					color.b,
					color.a * alpha * cover,
					operation,
				);
				if (before !== null) {
					for (let c = 0; c < 4; c++) {
						data[i * 4 + c] =
							before[c] + (data[i * 4 + c] - before[c]) * clipCover;
					}
				}
			}
		}
		if (operation === "source-over" || operation === "copy") {
			this[kDropText](mask, 0.5);
		}
		this[kHost].changed();
	}

	createImageData(widthOrData: number | ImageData, height?: number): ImageData {
		if (widthOrData instanceof ImageData) {
			return new ImageData(widthOrData.width, widthOrData.height);
		}
		return new ImageData(Math.abs(widthOrData), Math.abs(height ?? 0));
	}

	getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
		if (!isFiniteAll(sx, sy, sw, sh)) {
			throw new TypeError("The rectangle must be finite");
		}
		if (sw === 0 || sh === 0) {
			throw domException("IndexSizeError", "The rectangle is empty");
		}
		if (sw < 0) {
			sx += sw;
			sw = -sw;
		}
		if (sh < 0) {
			sy += sh;
			sh = -sh;
		}
		const out = new ImageData(Math.floor(sw), Math.floor(sh));
		copyRect(
			this[kHost].bitmap(),
			Math.floor(sx),
			Math.floor(sy),
			{width: out.width, height: out.height, data: out.data},
			0,
			0,
			out.width,
			out.height,
		);
		return out;
	}

	putImageData(
		image: ImageData,
		dx: number,
		dy: number,
		dirtyX = 0,
		dirtyY = 0,
		dirtyWidth = image.width,
		dirtyHeight = image.height,
	): void {
		if (!(image instanceof ImageData)) {
			throw new TypeError("putImageData takes an ImageData");
		}
		if (!isFiniteAll(dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight)) {
			return;
		}
		if (dirtyWidth < 0) {
			dirtyX += dirtyWidth;
			dirtyWidth = -dirtyWidth;
		}
		if (dirtyHeight < 0) {
			dirtyY += dirtyHeight;
			dirtyHeight = -dirtyHeight;
		}
		const x0 = Math.max(0, Math.floor(dirtyX));
		const y0 = Math.max(0, Math.floor(dirtyY));
		const x1 = Math.min(image.width, Math.floor(dirtyX + dirtyWidth));
		const y1 = Math.min(image.height, Math.floor(dirtyY + dirtyHeight));
		if (x1 <= x0 || y1 <= y0) {
			return;
		}
		const target = this[kHost].bitmap();
		const left = Math.floor(dx) + x0;
		const top = Math.floor(dy) + y0;
		copyRect({
			width: image.width,
			height: image.height,
			data: image.data,
		}, x0, y0, target, left, top, x1 -
			x0, y1 - y0);
		// The pixels replace whatever text was drawn there.
		this[kText] = this[kText].filter((run) => {
			const x = Math.min(target.width - 1, Math.max(0, Math.floor(run.x)));
			const y = Math.min(target.height - 1, Math.max(0, Math.floor(run.y)));
			return x < left || y < top || x >= left + x1 - x0 || y >= top + y1 - y0;
		});
		this[kHost].changed();
	}

	fillText(text: string, x: number, y: number, _maxWidth?: number): void {
		this[kDrawText](String(text), x, y, this[kState].fillStyle);
	}

	strokeText(text: string, x: number, y: number, _maxWidth?: number): void {
		this[kDrawText](String(text), x, y, this[kState].strokeStyle);
	}

	/** Widths in canvas pixels: a cell's width in pixels for each column. */
	measureText(text: string): {
		width: number;
		actualBoundingBoxLeft: number;
		actualBoundingBoxRight: number;
		actualBoundingBoxAscent: number;
		actualBoundingBoxDescent: number;
		fontBoundingBoxAscent: number;
		fontBoundingBoxDescent: number;
	} {
		const cell = this[kHost].pixelsPerCell();
		let columns = 0;
		for (const char of String(text)) {
			columns += Math.max(0, getStringWidth(char));
		}
		const width = columns * cell.x;
		return {
			width,
			actualBoundingBoxLeft: 0,
			actualBoundingBoxRight: width,
			actualBoundingBoxAscent: cell.y * 0.8,
			actualBoundingBoxDescent: cell.y * 0.2,
			fontBoundingBoxAscent: cell.y * 0.8,
			fontBoundingBoxDescent: cell.y * 0.2,
		};
	}

	drawFocusIfNeeded(): void {}

	[kSetMatrix](m: Matrix): void {
		if (!isFiniteAll(...m)) {
			return;
		}
		this[kState].transform = m;
		this[kPath].transform = m;
	}

	// A Path2D's points are in user space and go through the transform
	// when it is used; the current path's went through as they were added.
	[kSubpathsFor](path?: Path2D): Subpath[] {
		if (path === undefined) {
			return this[kPath][kSubpaths];
		}
		const builder = new PathBuilder();
		builder.append(path[kSubpaths], this[kState].transform);
		return builder[kSubpaths];
	}

	[kReadPathArgs](
		pathOrRule?: Path2D | FillRule,
		maybeRule?: FillRule,
	): {path: Path2D | undefined; rule: FillRule} {
		if (pathOrRule instanceof Path2D) {
			return {
				path: pathOrRule,
				rule: maybeRule === "evenodd" ? "evenodd" : "nonzero",
			};
		}
		return {
			path: undefined,
			rule: pathOrRule === "evenodd" ? "evenodd" : "nonzero",
		};
	}

	[kStrokeStyle](): StrokeStyle {
		const scale = this[kScale]();
		return {
			width: this[kState].lineWidth,
			cap: this[kState].lineCap,
			join: this[kState].lineJoin,
			miterLimit: this[kState].miterLimit,
			dash: this[kState].lineDash.map((value) => value * scale),
			dashOffset: this[kState].lineDashOffset * scale,
		};
	}

	// How much the transform scales lengths, for line widths and dashes.
	[kScale](): number {
		const m = this[kState].transform;
		return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
	}

	[kRectMask](x: number, y: number, w: number, h: number): Float32Array {
		const builder = new PathBuilder();
		builder.transform = this[kState].transform;
		builder.rect(x, y, w, h);
		const bitmap = this[kHost].bitmap();
		return rasterize(
			pathPolygons(builder[kSubpaths]),
			bitmap.width,
			bitmap.height,
			"nonzero",
		);
	}

	[kPaint](mask: Float32Array, paint: Paint): void {
		const bitmap = this[kHost].bitmap();
		const {width, height, data} = bitmap;
		const operation = this[kState].globalCompositeOperation;
		const unbounded = UNBOUNDED.has(operation);
		const alpha = this[kState].globalAlpha;
		const clip = this[kState].clip;
		const solid = typeof paint === "string" ? parseCanvasColor(paint) : null;
		const inverse = typeof paint === "string"
			? null
			: invert(this[kState].transform);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = y * width + x;
				const clipCover = clip === null ? 1 : clip[i];
				if (clipCover <= 0) {
					continue;
				}
				const cover = mask[i];
				if (cover <= 0 && !unbounded) {
					continue;
				}
				let color: RGBA | null = solid;
				if (color === null && cover > 0 && inverse !== null) {
					const [ux, uy] = apply(inverse, x + 0.5, y + 0.5);
					color = (paint as CanvasGradient | CanvasPattern).colorAt(ux, uy);
				}
				const sa = color === null ? 0 : color.a * alpha * cover;
				if (clipCover < 1) {
					// Blend the result back toward the old pixel where the clip
					// only partly covers it.
					const before = [
						data[i * 4],
						data[i * 4 + 1],
						data[i * 4 + 2],
						data[i * 4 + 3],
					];
					composite(
						data,
						i * 4,
						color?.r ?? 0,
						color?.g ?? 0,
						color?.b ?? 0,
						sa,
						operation,
					);
					for (let c = 0; c < 4; c++) {
						data[i * 4 + c] =
							before[c] + (data[i * 4 + c] - before[c]) * clipCover;
					}
				} else {
					composite(
						data,
						i * 4,
						color?.r ?? 0,
						color?.g ?? 0,
						color?.b ?? 0,
						sa,
						operation,
					);
				}
			}
		}
		if (operation === "source-over" || operation === "copy") {
			this[kDropText](mask, 0.5);
		}
		this[kHost].changed();
	}

	// Text under the shape painted last is covered, as it would be
	// in pixels.
	[kDropText](mask: Float32Array, threshold: number): void {
		const bitmap = this[kHost].bitmap();
		if (bitmap.width === 0 || bitmap.height === 0) {
			return;
		}
		// An anchor on or past an edge (right-aligned text at the canvas's
		// width, say) is read at the nearest pixel inside, so clearing the
		// canvas clears it too.
		this[kText] = this[kText].filter((run) => {
			const x = Math.min(bitmap.width - 1, Math.max(0, Math.floor(run.x)));
			const y = Math.min(bitmap.height - 1, Math.max(0, Math.floor(run.y)));
			return mask[y * bitmap.width + x] < threshold;
		});
	}

	[kDrawText](text: string, x: number, y: number, paint: Paint): void {
		if (!isFiniteAll(x, y)) {
			return;
		}
		const [px, py] = apply(this[kState].transform, x, y);
		const color = typeof paint === "string"
			? parseCanvasColor(paint)
			: (paint as CanvasGradient | CanvasPattern).colorAt(x, y);
		if (color === null || color.a * this[kState].globalAlpha === 0) {
			return;
		}
		const rtl = this[kState].direction === "rtl";
		const align = this[kState].textAlign;
		const resolved = align === "center"
			? "center"
			: align === "right" ||
				(align === "end" && !rtl) ||
				(align === "start" && rtl)
				? "right"
				: "left";
		const words = this[kState].font.toLowerCase().split(/\s+/);
		const run: CanvasTextRun = {
			text: text.replace(/[\t\n\f\r]/g, " "),
			x: px,
			y: py,
			align: resolved,
			baseline: this[kState].textBaseline,
			color: {...color, a: color.a * this[kState].globalAlpha},
			bold: words.some(
				(word) => word === "bold" ||
					word === "bolder" ||
				(/^\d+$/.test(word) && Number(word) >= 600),
			),
			italic: words.includes("italic") || words.includes("oblique"),
		};
		this[kText].push(run);
		this[kHost].changed();
	}
}

function readPaint(value: Paint, previous: Paint): Paint {
	if (value instanceof CanvasGradient || value instanceof CanvasPattern) {
		return value;
	}
	const color = parseCanvasColor(String(value));
	return color === null ? previous : serializeColor(color);
}

/** The text runs a 2d context drew, for the painter. */
export function getCanvasText(
	context: CanvasRenderingContext2D,
): CanvasTextRun[] {
	return context[kText];
}

/**
 * Back to the default state, the path and the text runs emptied, as
 * resizing the canvas does. The bitmap is the canvas's to replace.
 */
export function resetContextState(context: CanvasRenderingContext2D): void {
	context[kState] = defaultState();
	context[kStack] = [];
	context[kPath] = new PathBuilder();
	context[kText] = [];
}

/** Drop a context's text runs, as resizing the canvas does. */
export function clearCanvasText(context: CanvasRenderingContext2D): void {
	context[kText] = [];
}

/** A canvas encoded the way toDataURL() and toBlob() hand it out. */
export function canvasToPNG(bitmap: Bitmap): Uint8Array {
	return encodePNG(bitmap);
}

// ---------------------------------------------------------------------------
// The charactergrid context.

/** What the grid context needs from its canvas. */
export interface GridHost {
	canvas: object;
	// The canvas's cells, `width` columns by `height` rows.
	cells(): CellContext;
	changed(): void;
	// Terminal pixels per cell, for drawing images at their natural size.
	cellPixels(): {width: number; height: number};
}

const kGridHost = Symbol("gridHost");

const kFillStyle = Symbol("fillStyle");
const kGridStrokeStyle = Symbol("gridStrokeStyle");
const kLineStyle = Symbol("lineStyle");
const kLineJoin = Symbol("lineJoin");
const kFont = Symbol("font");
const kTextAlign = Symbol("textAlign");
const kTextDecoration = Symbol("textDecoration");
const kRect = Symbol("rect");

export interface CanvasCharacterGridContext {
	[kGridHost]: GridHost;
	[kFillStyle]: string;
	[kGridStrokeStyle]: string;
	[kLineStyle]: LineStyle["style"];
	[kLineJoin]: "miter" | "round";
	[kFont]: string;
	[kTextAlign]: string;
	[kTextDecoration]: string;
}

/**
 * getContext("charactergrid"): the canvas as `width` columns by `height`
 * rows of cells. fillText() writes glyphs in the fill color over the
 * cells' backgrounds, fillRect() fills cells' backgrounds, strokeLine()
 * and strokeRect() draw box-drawing lines that join where they meet,
 * drawImage() draws an image two pixels a cell, and clearRect() empties
 * cells. Coordinates are cells. Colors are any CSS color, and
 * `currentcolor`, the default, is the terminal's own foreground.
 */
export class CanvasCharacterGridContext {
	constructor(host: GridHost) {
		this[kGridHost] = host;
		this[kFillStyle] = "currentcolor";
		this[kGridStrokeStyle] = "currentcolor";
		this[kLineStyle] = "solid";
		this[kLineJoin] = "miter";
		this[kFont] = "";
		this[kTextAlign] = "left";
		this[kTextDecoration] = "none";
	}

	get canvas(): object {
		return this[kGridHost].canvas;
	}

	get columns(): number {
		return this[kGridHost].cells().cols;
	}

	get rows(): number {
		return this[kGridHost].cells().rows;
	}

	get fillStyle(): string {
		return this[kFillStyle];
	}

	set fillStyle(value: string) {
		this[kFillStyle] = readGridColor(value) ?? this[kFillStyle];
	}

	get strokeStyle(): string {
		return this[kGridStrokeStyle];
	}

	set strokeStyle(value: string) {
		this[kGridStrokeStyle] = readGridColor(value) ?? this[kGridStrokeStyle];
	}

	/** A CSS border style: solid, double, dashed, dotted and the rest. */
	get lineStyle(): string {
		return this[kLineStyle];
	}

	set lineStyle(value: string) {
		const style = LINE_STYLES.find((name) => name === value);
		if (style !== undefined) {
			this[kLineStyle] = style;
		}
	}

	/** miter, round. A round join curves strokeRect()'s corners. */
	get lineJoin(): string {
		return this[kLineJoin];
	}

	set lineJoin(value: string) {
		if (value === "miter" || value === "round") {
			this[kLineJoin] = value;
		}
	}

	/** Keywords from the CSS font shorthand: bold, italic, lighter. */
	get font(): string {
		return this[kFont];
	}

	set font(value: string) {
		this[kFont] = String(value);
	}

	get textAlign(): string {
		return this[kTextAlign];
	}

	set textAlign(value: string) {
		if (["start", "end", "left", "right", "center"].includes(value)) {
			this[kTextAlign] = value;
		}
	}

	/** none, underline. */
	get textDecoration(): string {
		return this[kTextDecoration];
	}

	set textDecoration(value: string) {
		if (value === "none" || value === "underline") {
			this[kTextDecoration] = value;
		}
	}

	fillRect(x: number, y: number, w: number, h: number): void {
		const rect = this[kRect](x, y, w, h);
		const color = toGridColor(this[kFillStyle]);
		if (rect === null || color === undefined) {
			return;
		}
		const [x0, y0, x1, y1] = rect;
		// The terminal's foreground as a background is its inverse.
		this[kGridHost].cells()
			.drawRect(x0, y0, x1 - x0, y1 - y0, color ?? "inverse");
		this[kGridHost].changed();
	}

	clearRect(x: number, y: number, w: number, h: number): void {
		const rect = this[kRect](x, y, w, h);
		if (rect === null) {
			return;
		}
		const {grid, cols, rows} = this[kGridHost].cells();
		const x0 = Math.max(0, rect[0]);
		const x1 = Math.min(cols, rect[2]);
		for (let row = Math.max(0, rect[1]); row < Math.min(rows, rect[3]); row++) {
			grid.clearRange(row * cols + x0, row * cols + x1);
		}
		this[kGridHost].changed();
	}

	fillText(text: string, x: number, y: number, maxWidth?: number): void {
		if (!isFiniteAll(x, y)) {
			return;
		}
		const color = toGridColor(this[kFillStyle]);
		if (color === undefined) {
			return;
		}
		const cells = this[kGridHost].cells();
		const clusters = [
			...graphemeSegmenter.segment(String(text).replace(/[\t\n\f\r]/g, " ")),
		]
			.map((segment) => segment.segment)
			.filter((cluster) => getStringWidth(cluster) > 0);
		const width = clusters.reduce(
			(sum, cluster) => sum + getStringWidth(cluster),
			0,
		);
		let col = Math.round(x);
		const align = this[kTextAlign];
		if (align === "center") {
			col -= Math.floor(width / 2);
		} else if (align === "right" || align === "end") {
			col -= width;
		}
		const row = Math.round(y);
		const limit = maxWidth !== undefined && Number.isFinite(maxWidth)
			? col + Math.max(0, Math.floor(maxWidth))
			: Infinity;
		const words = this[kFont].toLowerCase().split(/\s+/);
		const base: CellStyle = {
			bold: words.includes("bold") || words.includes("bolder"),
			italic: words.includes("italic") || words.includes("oblique"),
			dim: words.includes("lighter"),
			underline: this[kTextDecoration] === "underline",
		};
		const {grid} = cells;
		for (const cluster of clusters) {
			const columns = getStringWidth(cluster);
			if (col + columns > limit) {
				break;
			}
			const index = row * cells.cols + col;
			const inside =
				row >= 0 && row < cells.rows && col >= 0 && col < cells.cols;
			// Over a cell filled with the terminal's foreground, which only
			// inverse video can show, the cell stays inverse: its background
			// is then what shows as the glyph's color.
			const inverse =
				inside &&
				grid.cluster[index] !== 0 &&
				readCell(grid, index)?.inverse === true;
			cells.drawText(
				cluster,
				col,
				row,
				inverse ? {...base, inverse: true, bg: color} : {...base, fg: color},
			);
			// A wide glyph covers the columns after its first.
			for (let extra = 1; extra < columns; extra++) {
				if (inside && col + extra < cells.cols) {
					grid.cluster[index + extra] = 0;
				}
			}
			col += columns;
		}
		this[kGridHost].changed();
	}

	/**
	 * A line from the cell at (x1, y1) to the cell at (x2, y2), both
	 * included, in strokeStyle and lineStyle. A line meeting another
	 * joins it in a corner, a tee or a cross. Only rows and columns: a
	 * slanted line draws nothing.
	 */
	strokeLine(x1: number, y1: number, x2: number, y2: number): void {
		if (!isFiniteAll(x1, y1, x2, y2)) {
			return;
		}
		const color = toGridColor(this[kGridStrokeStyle]);
		if (color === undefined) {
			return;
		}
		const [a, b, c, d] = [x1, y1, x2, y2].map(Math.round);
		const line: LineStyle = {style: this[kLineStyle], color};
		const cells = this[kGridHost].cells();
		if (b === d) {
			cells.drawLine(Math.min(a, c), b, Math.max(a, c) + 1, b, {
				...line,
				startCap: a === c ? "square" : undefined,
				endCap: a === c ? "square" : undefined,
			});
		} else if (a === c) {
			cells.drawLine(a, Math.min(b, d), a, Math.max(b, d) + 1, line);
		} else {
			return;
		}
		this[kGridHost].changed();
	}

	/** A box on the cells `w` by `h` from (x, y), in strokeStyle and lineStyle. */
	strokeRect(x: number, y: number, w: number, h: number): void {
		const rect = this[kRect](x, y, w, h);
		const color = toGridColor(this[kGridStrokeStyle]);
		if (rect === null || color === undefined) {
			return;
		}
		const [x0, y0, x1, y1] = rect;
		const side: LineStyle = {style: this[kLineStyle], color};
		const corner = this[kLineJoin] === "round" ? "round" : undefined;
		this[kGridHost].cells()
			.drawBox(x0, y0, x1 - x0, y1 - y0, {
				top: side,
				right: side,
				bottom: side,
				left: side,
				topLeft: corner,
				topRight: corner,
				bottomRight: corner,
				bottomLeft: corner,
			});
		this[kGridHost].changed();
	}

	measureText(text: string): {width: number} {
		return this[kGridHost].cells().measureText(String(text));
	}

	/**
	 * drawImage(image, x, y), (image, x, y, w, h) or (image, sx, sy, sw,
	 * sh, x, y, w, h). The destination is in cells, and the source in the
	 * image's pixels. With no size, the image covers the cells its pixels
	 * fill on this terminal.
	 */
	drawImage(image: unknown, ...args: number[]): void {
		const bitmap = readDrawable(image);
		if (bitmap === null || bitmap.width === 0 || bitmap.height === 0) {
			return;
		}
		let sx = 0;
		let sy = 0;
		let sw = naturalWidthOf(bitmap);
		let sh = naturalHeightOf(bitmap);
		let dx: number;
		let dy: number;
		let dw: number;
		let dh: number;
		const cell = this[kGridHost].cellPixels();
		if (args.length === 2) {
			[dx, dy] = args;
			dw = Math.max(1, Math.round(sw / cell.width));
			dh = Math.max(1, Math.round(sh / cell.height));
		} else if (args.length === 4) {
			[dx, dy, dw, dh] = args;
		} else if (args.length === 8) {
			[sx, sy, sw, sh, dx, dy, dw, dh] = args;
		} else {
			throw new TypeError("drawImage takes 3, 5 or 9 arguments");
		}
		if (!isFiniteAll(sx, sy, sw, sh, dx, dy, dw, dh)) {
			return;
		}
		const cols = Math.round(dw);
		const rows = Math.round(dh);
		if (cols <= 0 || rows <= 0) {
			return;
		}
		const left = Math.round(dx);
		const top = Math.round(dy);
		const cells = this[kGridHost].cells();
		const {grid} = cells;
		// Only the cells on the grid are sampled, from the part of the
		// source that lands on them.
		const firstCol = Math.max(0, -left);
		const firstRow = Math.max(0, -top);
		const shownCols = Math.min(cols, cells.cols - left) - firstCol;
		const shownRows = Math.min(rows, cells.rows - top) - firstRow;
		if (shownCols <= 0 || shownRows <= 0) {
			return;
		}
		const pixels = sampleBitmap(bitmap, shownCols, shownRows * 2, {
			x: sx + (firstCol / cols) * sw,
			y: sy + (firstRow / rows) * sh,
			width: (shownCols / cols) * sw,
			height: (shownRows / rows) * sh,
		});
		for (let row = 0; row < shownRows; row++) {
			for (let col = 0; col < shownCols; col++) {
				const x = left + firstCol + col;
				const y = top + firstRow + row;
				const index = y * cells.cols + x;
				const half = halfBlockCell(
					pixels,
					(row * 2 * shownCols + col) * 4,
					((row * 2 + 1) * shownCols + col) * 4,
					grid.cluster[index] !== 0 && grid.bg[index] !== 0
						? grid.bg[index]
						: null,
				);
				if (half !== null) {
					cells.drawText(half.char, x, y, half.style);
				}
			}
		}
		this[kGridHost].changed();
	}

	/** The cell at a column and row, with CSS colors, or null for an empty one. */
	getCell(
		x: number,
		y: number,
	): {
		char: string;
		color: string | null;
		background: string | null;
		bold: boolean;
		italic: boolean;
		underline: boolean;
	} | null {
		const {grid, cols, rows} = this[kGridHost].cells();
		const col = Math.floor(x);
		const row = Math.floor(y);
		if (col < 0 || row < 0 || col >= cols || row >= rows) {
			return null;
		}
		const cell = readCell(grid, row * cols + col);
		if (cell === null) {
			return null;
		}
		const css = (value: number) => {
			if (value === 0) {
				return null;
			}
			const rgb = value & 0xffffff;
			return serializeColor({
				r: rgb >> 16,
				g: (rgb >> 8) & 0xff,
				b: rgb & 0xff,
				a: 1,
			});
		};
		return {
			char: cell.char,
			color: css(cell.fg),
			background: css(cell.bg),
			bold: cell.bold,
			italic: cell.italic,
			underline: cell.underline,
		};
	}

	reset(): void {
		this[kGridHost].cells().grid.clear();
		this[kFillStyle] = "currentcolor";
		this[kGridStrokeStyle] = "currentcolor";
		this[kLineStyle] = "solid";
		this[kLineJoin] = "miter";
		this[kFont] = "";
		this[kTextAlign] = "left";
		this[kTextDecoration] = "none";
		this[kGridHost].changed();
	}

	[kRect](
		x: number,
		y: number,
		w: number,
		h: number,
	): [number, number, number, number] | null {
		if (!isFiniteAll(x, y, w, h)) {
			return null;
		}
		if (w < 0) {
			x += w;
			w = -w;
		}
		if (h < 0) {
			y += h;
			h = -h;
		}
		return [Math.round(x), Math.round(y), Math.round(x + w), Math.round(y + h)];
	}
}

// A color as the grid context keeps it, serialized, or null when the
// value is not a color.
function readGridColor(value: string): string | null {
	const text = String(value).trim().toLowerCase();
	if (text === "currentcolor") {
		return "currentcolor";
	}
	const color = parseCanvasColor(text);
	return color === null ? null : serializeColor(color);
}

// A kept color as a cell color: null for the terminal's foreground, or
// undefined for a transparent one, which draws nothing.
function toGridColor(value: string): number | null | undefined {
	if (value === "currentcolor") {
		return null;
	}
	const color = parseCanvasColor(value)!;
	if (color.a === 0) {
		return undefined;
	}
	return toCellColor((color.r << 16) | (color.g << 8) | color.b);
}

/**
 * The cell two stacked pixels make: the lower half block in the lower
 * pixel's color over a background in the upper's, the upper half block
 * when only the upper pixel shows, a space in one color when both match,
 * and null when neither shows. A pixel at least half opaque shows; a
 * partly transparent one is first blended over `under` when there is a
 * color under it. A half block with no background keeps the one under it.
 *
 * Two colors go in the lower half block, not the upper, because a
 * terminal that draws block characters from the font shows the font's
 * glyph, and Menlo's and SF Mono's both sit low in the cell: the upper
 * one leaves the cell's top in the wrong color and runs past the middle.
 * The background fills whatever the glyph leaves, so with the lower half
 * block only the seam is off. Terminals that draw the blocks themselves
 * show either one exactly.
 */
export function halfBlockCell(
	pixels: Uint8ClampedArray,
	upper: number,
	lower: number,
	under: number | null,
): {char: string; style: CellStyle} | null {
	const read = (at: number): number | null => {
		const alpha = pixels[at + 3] / 255;
		let r = pixels[at];
		let g = pixels[at + 1];
		let b = pixels[at + 2];
		if (under !== null && alpha < 1) {
			const ur = (under >> 16) & 0xff;
			const ug = (under >> 8) & 0xff;
			const ub = under & 0xff;
			if (alpha === 0) {
				return null;
			}
			r = Math.round(r * alpha + ur * (1 - alpha));
			g = Math.round(g * alpha + ug * (1 - alpha));
			b = Math.round(b * alpha + ub * (1 - alpha));
		} else if (alpha < 0.5) {
			return null;
		}
		return toCellColor((r << 16) | (g << 8) | b);
	};
	const top = read(upper);
	const bottom = read(lower);
	if (top === null && bottom === null) {
		return null;
	}
	if (top === null) {
		return {char: "▄", style: {fg: bottom}};
	}
	if (bottom === null) {
		return {char: "▀", style: {fg: top}};
	}
	if (top === bottom) {
		return {char: " ", style: {bg: top}};
	}
	return {char: "▄", style: {fg: bottom, bg: top}};
}
