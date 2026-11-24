/**
 * An SVG drawing as the page records it and a decode thread draws it:
 * the 2d canvas calls its shapes come to, in order. The page reads the
 * elements, which a worker does not have, and the pixels are made here.
 */
import {
	type CanvasRenderingContext2D,
	createContext2D,
	transformGradient,
} from "./canvas.ts";
import {type Bitmap, createBitmap, createYielder} from "./images.ts";

type Matrix = [number, number, number, number, number, number];

/** A gradient's line or circles, its stops, and its transform. */
export interface SVGGradient {
	coords: number[];
	stops: Array<[number, string]>;
	matrix: Matrix;
}

/** A method's name and arguments, or "=" with a property and its value. */
export type SVGCommand = [name: string, ...args: unknown[]];

export interface SVGDrawing {
	// The bitmap's pixels, and the image's size in CSS pixels.
	width: number;
	height: number;
	naturalWidth: number;
	naturalHeight: number;
	commands: SVGCommand[];
}

const METHODS = [
	"save",
	"restore",
	"transform",
	"translate",
	"scale",
	"beginPath",
	"moveTo",
	"lineTo",
	"bezierCurveTo",
	"quadraticCurveTo",
	"arc",
	"arcTo",
	"ellipse",
	"rect",
	"closePath",
	"clip",
	"fill",
	"stroke",
	"setLineDash",
] as const;

const PROPERTIES = [
	"fillStyle",
	"strokeStyle",
	"lineWidth",
	"lineCap",
	"lineJoin",
	"miterLimit",
	"lineDashOffset",
] as const;

const REPLAYED = new Set<string>([...METHODS, ...PROPERTIES, "globalAlpha"]);

/** Stands where the 2d context does, and keeps what it is asked. */
export class SVGRecorder {
	commands: SVGCommand[];
	alphas: number[];

	constructor() {
		this.commands = [];
		this.alphas = [1];
	}

	get globalAlpha(): number {
		return this.alphas[this.alphas.length - 1];
	}

	set globalAlpha(value: number) {
		this.alphas[this.alphas.length - 1] = value;
		this.commands.push(["=", "globalAlpha", value]);
	}

	save(): void {
		this.alphas.push(this.globalAlpha);
		this.commands.push(["save"]);
	}

	restore(): void {
		if (this.alphas.length > 1) {
			this.alphas.pop();
		}
		this.commands.push(["restore"]);
	}
}

for (const name of METHODS) {
	if (name !== "save" && name !== "restore") {
		(SVGRecorder.prototype as unknown as Record<string, unknown>)[name] =
			function (this: SVGRecorder, ...args: unknown[]): void {
				this.commands.push([name, ...args]);
			};
	}
}
for (const name of PROPERTIES) {
	Object.defineProperty(SVGRecorder.prototype, name, {
		set(this: SVGRecorder, value: unknown) {
			this.commands.push(["=", name, value]);
		},
	});
}

function toStyle(
	context: CanvasRenderingContext2D,
	value: unknown,
): string | CanvasGradient {
	if (typeof value === "string") {
		return value;
	}
	const {coords, stops, matrix} = value as SVGGradient;
	const gradient = coords.length === 4
		? context.createLinearGradient(
			...(coords as [number, number, number, number]),
		)
		: context.createRadialGradient(
			...(coords as [number, number, number, number, number, number]),
		);
	for (const [offset, color] of stops) {
		gradient.addColorStop(offset, color);
	}
	transformGradient(gradient, matrix);
	return gradient;
}

/**
 * Draw what was recorded. Past `deadline`, a time from Date.now(), the
 * drawing stops.
 */
export async function rasterizeDrawing(
	drawing: SVGDrawing,
	deadline = Infinity,
): Promise<Bitmap> {
	const bitmap = createBitmap(drawing.width, drawing.height);
	const context = createContext2D({
		canvas: {},
		bitmap: () => bitmap,
		changed() {},
		pixelsPerCell: () => ({x: 1, y: 1}),
		direction: () => "ltr",
	});
	const target = context as unknown as Record<string, unknown>;
	const pause = createYielder(deadline);
	for (const [name, ...args] of drawing.commands) {
		if (name === "=") {
			const [property, value] = args as [string, unknown];
			if (REPLAYED.has(property)) {
				target[property] = property.endsWith("Style")
					? toStyle(context, value)
					: value;
			}
			continue;
		}
		if (!REPLAYED.has(name)) {
			continue;
		}
		(target[name] as (...given: unknown[]) => void)(...args);
		if (name === "fill" || name === "stroke") {
			const turn = pause();
			if (turn !== undefined) {
				await turn;
			}
		}
	}
	bitmap.naturalWidth = drawing.naturalWidth;
	bitmap.naturalHeight = drawing.naturalHeight;
	return bitmap;
}
