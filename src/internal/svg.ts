/**
 * SVG images, drawn into an RGBA bitmap with the 2d canvas's rasterizer.
 * currentColor is black, and nothing outside the file is loaded.
 *
 * Read: the shape elements, groups, <use> within the file, viewBox and
 * preserveAspectRatio, transform, the fill, stroke and opacity properties
 * as attributes, style attributes or a <style> sheet of simple selectors,
 * linear and radial gradients, and clip-path. Not read: text, images,
 * patterns, filters, masks, markers and animation.
 */
import * as Parse5 from "parse5";

import {
	type CanvasGradient,
	type CanvasRenderingContext2D,
	createContext2D,
	getPathBounds,
	parseSVGPath,
	Path2D,
	transformGradient,
} from "./canvas.ts";
import {parseColor} from "./cssvalues.ts";
import {
	type Bitmap,
	createBitmap,
	createYielder,
	MAX_KEPT_PIXELS,
} from "./images.ts";

interface SVGNode {
	nodeName: string;
	tagName?: string;
	value?: string;
	attrs?: Array<{name: string; value: string}>;
	childNodes?: SVGNode[];
}

type Matrix = [number, number, number, number, number, number];

type Attributes = Map<string, string>;

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Paint {
	fill: string;
	stroke: string;
	strokeWidth: string;
	fillRule: "nonzero" | "evenodd";
	lineCap: string;
	lineJoin: string;
	miterLimit: number;
	dashes: string;
	dashOffset: string;
	fillOpacity: number;
	strokeOpacity: number;
	color: string;
	visible: boolean;
}

const INITIAL_PAINT: Paint = {
	fill: "black",
	stroke: "none",
	strokeWidth: "1",
	fillRule: "nonzero",
	lineCap: "butt",
	lineJoin: "miter",
	miterLimit: 4,
	dashes: "none",
	dashOffset: "0",
	fillOpacity: 1,
	strokeOpacity: 1,
	color: "black",
	visible: true,
};

// Elements whose children are not drawn where they stand.
const UNDRAWN = new Set([
	"defs",
	"symbol",
	"clipPath",
	"mask",
	"marker",
	"pattern",
	"linearGradient",
	"radialGradient",
	"filter",
	"style",
	"script",
	"title",
	"desc",
	"metadata",
]);

const CONTAINERS = new Set(["svg", "g", "a", "symbol", "switch"]);

const SHAPES = new Set([
	"path",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
]);

// The most a file may be: in bytes, in shapes with every <use> followed,
// in nesting, and in <use> within <use>.
export const MAX_SVG_BYTES = 1 << 22;
const MAX_SHAPES = 1 << 17;
const MAX_DEPTH = 64;
const MAX_USE_DEPTH = 8;

// ---------------------------------------------------------------------------
// The <style> sheet.

// A selector of a type, an id and classes. No other selector is read.
interface Rule {
	tag: string | null;
	id: string | null;
	classes: string[];
	specificity: number;
	declarations: Array<[string, string]>;
}

const SIMPLE_SELECTOR = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/;

function readDeclarations(text: string): Array<[string, string]> {
	const declarations: Array<[string, string]> = [];
	for (const declaration of text.split(";")) {
		const colon = declaration.indexOf(":");
		if (colon > 0) {
			declarations.push([
				declaration.slice(0, colon).trim().toLowerCase(),
				declaration.slice(colon + 1).replace(/!important\s*$/i, "").trim(),
			]);
		}
	}
	return declarations;
}

function readSheet(text: string): Rule[] {
	const rules: Rule[] = [];
	const source = text
		.replace(/<!\[CDATA\[|\]\]>|<!--|-->/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "");
	const pattern = /([^{}]*)\{([^{}]*)\}/g;
	for (
		let match = pattern.exec(source);
		match !== null;
		match = pattern.exec(source)
	) {
		const declarations = readDeclarations(match[2]);
		for (const selector of match[1].split(",")) {
			const parts = SIMPLE_SELECTOR.exec(selector.trim());
			if (parts === null || selector.trim() === "") {
				continue;
			}
			const names = parts[2].match(/[.#][\w-]+/g) ?? [];
			const ids = names.filter((name) => name[0] === "#");
			const classes = names
				.filter((name) => name[0] === ".")
				.map((name) => name.slice(1));
			const tag = parts[1] === undefined || parts[1] === "*" ? null : parts[1];
			rules.push({
				tag,
				id: ids.length > 0 ? ids[0].slice(1) : null,
				classes,
				specificity:
					ids.length * 10000 + classes.length * 100 + (tag === null ? 0 : 1),
				declarations,
			});
		}
	}
	// A stable sort, so of two rules as specific the later one wins.
	return rules.sort((a, b) => a.specificity - b.specificity);
}

function collectSheet(node: SVGNode, depth = 0): string {
	if (depth > MAX_DEPTH) {
		return "";
	}
	let text = "";
	for (const child of node.childNodes ?? []) {
		text += node.tagName === "style" && child.nodeName === "#text"
			? child.value ?? ""
			: collectSheet(child, depth + 1);
	}
	return text;
}

// ---------------------------------------------------------------------------
// Reading values.

interface Drawing {
	context: CanvasRenderingContext2D;
	rules: Rule[];
	ids: Map<string, SVGNode>;
	// The viewport a percentage is a share of, in user units.
	viewport: {width: number; height: number};
	shapes: number;
	pause: () => Promise<void> | undefined;
}

// Presentation attributes, then the sheet's rules, then the style
// attribute.
function getAttributes(node: SVGNode, rules: Rule[]): Attributes {
	const attributes: Attributes = new Map();
	for (const {name, value} of node.attrs ?? []) {
		attributes.set(name, value);
	}
	if (rules.length > 0) {
		const id = attributes.get("id");
		const classes = (attributes.get("class") ?? "").split(/\s+/);
		for (const rule of rules) {
			if (
				(rule.tag === null || rule.tag === node.tagName) &&
				(rule.id === null || rule.id === id) &&
				rule.classes.every((name) => classes.includes(name))
			) {
				for (const [name, value] of rule.declarations) {
					attributes.set(name, value);
				}
			}
		}
	}
	const style = attributes.get("style");
	if (style !== undefined) {
		for (const [name, value] of readDeclarations(style)) {
			attributes.set(name, value);
		}
	}
	return attributes;
}

// In pixels, against a 16 pixel font.
const UNITS: Record<string, number> = {
	"": 1,
	px: 1,
	pt: 4 / 3,
	pc: 16,
	in: 96,
	cm: 96 / 2.54,
	mm: 96 / 25.4,
	q: 96 / 101.6,
	em: 16,
	rem: 16,
	ex: 8,
	ch: 8,
};

const LENGTH =
	/^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/;

/** A length in user units. A percentage is a share of `whole`. */
function readLength(
	value: string | undefined,
	fallback: number,
	whole: number,
): number {
	const match = value === undefined ? null : LENGTH.exec(value);
	if (match === null) {
		return fallback;
	}
	const number = parseFloat(match[1]);
	const unit = match[2].toLowerCase();
	if (unit === "%") {
		return (number / 100) * whole;
	}
	const scale = UNITS[unit];
	return scale === undefined || !Number.isFinite(number)
		? fallback
		: number * scale;
}

function readNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	const number = parseFloat(value);
	if (!Number.isFinite(number)) {
		return fallback;
	}
	return value.trim().endsWith("%") ? number / 100 : number;
}

function readNumbers(value: string | undefined): number[] {
	const numbers =
		(value ?? "").match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
	return numbers === null ? [] : numbers.map(Number);
}

function readOpacity(value: string | undefined, fallback: number): number {
	return Math.min(1, Math.max(0, readNumber(value, fallback)));
}

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

/** A transform list (SVG 2 §8.5) as one matrix. */
function readTransform(value: string | undefined): Matrix {
	let matrix: Matrix = [1, 0, 0, 1, 0, 0];
	const text = value ?? "";
	const pattern = /(\w+)\s*\(([^)]*)\)/g;
	for (
		let match = pattern.exec(text); match !== null; match = pattern.exec(text)
	) {
		const n = readNumbers(match[2]);
		const angle = ((n[0] ?? 0) * Math.PI) / 180;
		let next: Matrix | null = null;
		switch (match[1]) {
			case "matrix":
				next = n.length === 6 ? (n as Matrix) : null;
				break;
			case "translate":
				next = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
				break;
			case "scale":
				next = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
				break;
			case "rotate": {
				const cos = Math.cos(angle);
				const sin = Math.sin(angle);
				const cx = n.length >= 3 ? n[1] : 0;
				const cy = n.length >= 3 ? n[2] : 0;
				next = multiply(
					multiply([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]),
					[1, 0, 0, 1, -cx, -cy],
				);
				break;
			}
			case "skewX":
				next = [1, 0, Math.tan(angle), 1, 0, 0];
				break;
			case "skewY":
				next = [1, Math.tan(angle), 0, 1, 0, 0];
				break;
		}
		if (next !== null && next.every(Number.isFinite)) {
			matrix = multiply(matrix, next);
		}
	}
	return matrix;
}

function isPaint(value: string): boolean {
	const text = value.toLowerCase();
	return text === "none" ||
		text === "currentcolor" ||
		text.startsWith("url(") ||
		parseColor(text) !== null;
}

function readPaint(attributes: Attributes, parent: Paint): Paint {
	const paint = {...parent};
	const inherited = (name: string): string | undefined => {
		const value = attributes.get(name);
		return value === undefined || value.trim() === "inherit"
			? undefined
			: value.trim();
	};
	const color = inherited("color");
	if (color !== undefined && color.toLowerCase() !== "currentcolor") {
		paint.color = color;
	}
	// A paint that does not parse is no declaration at all.
	const paintOf = (name: string): string | undefined => {
		const value = inherited(name);
		return value !== undefined && isPaint(value) ? value : undefined;
	};
	paint.fill = paintOf("fill") ?? paint.fill;
	paint.stroke = paintOf("stroke") ?? paint.stroke;
	paint.strokeWidth = inherited("stroke-width") ?? paint.strokeWidth;
	const rule = inherited("fill-rule");
	if (rule === "nonzero" || rule === "evenodd") {
		paint.fillRule = rule;
	}
	paint.lineCap = inherited("stroke-linecap") ?? paint.lineCap;
	paint.lineJoin = inherited("stroke-linejoin") ?? paint.lineJoin;
	paint.miterLimit = readNumber(
		inherited("stroke-miterlimit"),
		paint.miterLimit,
	);
	paint.dashes = inherited("stroke-dasharray") ?? paint.dashes;
	paint.dashOffset = inherited("stroke-dashoffset") ?? paint.dashOffset;
	paint.fillOpacity = readOpacity(inherited("fill-opacity"), paint.fillOpacity);
	paint.strokeOpacity = readOpacity(
		inherited("stroke-opacity"),
		paint.strokeOpacity,
	);
	const visibility = inherited("visibility");
	if (visibility !== undefined) {
		paint.visible = visibility === "visible";
	}
	return paint;
}

/** A color as the canvas takes one, at an opacity. Null if it is none. */
function readColor(value: string, color: string, opacity = 1): string | null {
	const text = value.trim().toLowerCase();
	const parsed = parseColor(text === "currentcolor" ? color : text);
	if (parsed === null) {
		return null;
	}
	const {color: rgb, alpha} = parsed;
	return `rgba(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff}, ${alpha * opacity})`;
}

// ---------------------------------------------------------------------------
// Gradients.

function getReference(value: string | undefined): string | null {
	const match = /^\s*url\(\s*["']?#([^"')]+)["']?\s*\)/.exec(value ?? "");
	return match === null ? null : match[1];
}

function getHref(attributes: Attributes): string | null {
	const href = attributes.get("href") ?? attributes.get("xlink:href") ?? "";
	return href.startsWith("#") ? href.slice(1) : null;
}

function isGradient(node: SVGNode | undefined): node is SVGNode {
	return node !== undefined &&
		(node.tagName === "linearGradient" || node.tagName === "radialGradient");
}

// A gradient that names another takes what it does not say from it.
function resolveGradient(
	drawing: Drawing,
	node: SVGNode,
): {attributes: Attributes; stops: SVGNode[]} {
	const merged: Attributes = new Map();
	let stops: SVGNode[] = [];
	let current: SVGNode | undefined = node;
	for (let depth = 0; isGradient(current) && depth < MAX_USE_DEPTH; depth++) {
		const attributes = getAttributes(current, drawing.rules);
		for (const [name, value] of attributes) {
			if (!merged.has(name)) {
				merged.set(name, value);
			}
		}
		if (stops.length === 0) {
			stops = (current.childNodes ?? []).filter(
				(child) => child.tagName === "stop",
			);
		}
		const href = getHref(attributes);
		current = href === null ? undefined : drawing.ids.get(href);
	}
	return {attributes: merged, stops};
}

/**
 * The gradient an element is painted with (SVG 2 §14.2). Null where it
 * paints nothing, and a color where it has one stop.
 */
function readGradient(
	drawing: Drawing,
	node: SVGNode,
	paint: Paint,
	opacity: number,
	bounds: () => Box | null,
): CanvasGradient | string | null {
	const {attributes, stops} = resolveGradient(drawing, node);
	const colors: Array<{offset: number; color: string}> = [];
	for (const stop of stops) {
		const stopAttributes = getAttributes(stop, drawing.rules);
		const color = readColor(
			stopAttributes.get("stop-color") ?? "black",
			paint.color,
			readOpacity(stopAttributes.get("stop-opacity"), 1) * opacity,
		);
		// An offset is never before the one before it.
		const offset = Math.max(
			Math.min(1, Math.max(0, readNumber(stopAttributes.get("offset"), 0))),
			colors.length > 0 ? colors[colors.length - 1].offset : 0,
		);
		colors.push({offset, color: color ?? "rgba(0, 0, 0, 0)"});
	}
	if (colors.length === 0) {
		return null;
	}
	if (colors.length === 1) {
		return colors[0].color;
	}
	const boxed = attributes.get("gradientUnits") !== "userSpaceOnUse";
	let matrix = readTransform(attributes.get("gradientTransform"));
	// objectBoundingBox: a unit square stretched over the shape's box.
	let whole = drawing.viewport;
	if (boxed) {
		const box = bounds();
		if (box === null || box.width <= 0 || box.height <= 0) {
			return null;
		}
		matrix = multiply([box.width, 0, 0, box.height, box.x, box.y], matrix);
		whole = {width: 1, height: 1};
	}
	const diagonal = Math.hypot(whole.width, whole.height) / Math.SQRT2;
	const length = (name: string, fallback: number, of: number): number =>
		readLength(attributes.get(name), fallback * of, of);
	const {context} = drawing;
	let gradient: CanvasGradient;
	if (node.tagName === "linearGradient") {
		gradient = context.createLinearGradient(
			length("x1", 0, whole.width),
			length("y1", 0, whole.height),
			length("x2", 1, whole.width),
			length("y2", 0, whole.height),
		);
	} else {
		const cx = length("cx", 0.5, whole.width);
		const cy = length("cy", 0.5, whole.height);
		const radius = length("r", 0.5, diagonal);
		if (radius <= 0) {
			return colors[colors.length - 1].color;
		}
		gradient = context.createRadialGradient(
			readLength(attributes.get("fx"), cx, whole.width),
			readLength(attributes.get("fy"), cy, whole.height),
			Math.max(0, length("fr", 0, diagonal)),
			cx,
			cy,
			radius,
		);
	}
	for (const {offset, color} of colors) {
		gradient.addColorStop(offset, color);
	}
	return transformGradient(gradient, matrix) ? gradient : null;
}

/** What a fill or stroke property paints with. Null for nothing. */
function resolvePaint(
	drawing: Drawing,
	value: string,
	paint: Paint,
	opacity: number,
	bounds: () => Box | null,
): CanvasGradient | string | null {
	const reference = getReference(value);
	if (reference === null) {
		return readColor(value, paint.color, opacity);
	}
	const server = drawing.ids.get(reference);
	const painted = isGradient(server)
		? readGradient(drawing, server, paint, opacity, bounds)
		: null;
	if (painted !== null) {
		return painted;
	}
	// A paint server that is not read, or not there: the color after it.
	const fallback = value.slice(value.indexOf(")") + 1).trim();
	return fallback === "" ? null : readColor(fallback, paint.color, opacity);
}

// ---------------------------------------------------------------------------
// Shapes.

// False for a shape with nothing to draw.
function shapePath(
	path: CanvasRenderingContext2D | Path2D,
	name: string,
	a: Attributes,
	viewport: {width: number; height: number},
): boolean {
	const x = (key: string) => readLength(a.get(key), 0, viewport.width);
	const y = (key: string) => readLength(a.get(key), 0, viewport.height);
	switch (name) {
		case "path": {
			const data = a.get("d");
			if (!data) {
				return false;
			}
			parseSVGPath(data, path);
			return true;
		}
		case "rect": {
			const width = x("width");
			const height = y("height");
			if (width <= 0 || height <= 0) {
				return false;
			}
			// One radius given stands for both.
			const hasX = a.has("rx") && a.get("rx") !== "auto";
			const hasY = a.has("ry") && a.get("ry") !== "auto";
			const rx = Math.min(Math.max(0, hasX ? x("rx") : y("ry")), width / 2);
			const ry = Math.min(Math.max(0, hasY ? y("ry") : x("rx")), height / 2);
			const left = x("x");
			const top = y("y");
			const right = left + width;
			const bottom = top + height;
			if (rx > 0 && ry > 0) {
				const quarter = Math.PI / 2;
				path.moveTo(left + rx, top);
				path.lineTo(right - rx, top);
				path.ellipse(right - rx, top + ry, rx, ry, 0, -quarter, 0);
				path.lineTo(right, bottom - ry);
				path.ellipse(right - rx, bottom - ry, rx, ry, 0, 0, quarter);
				path.lineTo(left + rx, bottom);
				path.ellipse(left + rx, bottom - ry, rx, ry, 0, quarter, Math.PI);
				path.lineTo(left, top + ry);
				path.ellipse(
					left + rx,
					top + ry,
					rx,
					ry,
					0,
					Math.PI,
					Math.PI + quarter,
				);
				path.closePath();
			} else {
				path.rect(left, top, width, height);
			}
			return true;
		}
		case "circle":
		case "ellipse": {
			const diagonal = Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
			const rx = name === "circle"
				? readLength(a.get("r"), 0, diagonal)
				: x("rx");
			const ry = name === "circle" ? rx : y("ry");
			if (rx <= 0 || ry <= 0) {
				return false;
			}
			path.ellipse(x("cx"), y("cy"), rx, ry, 0, 0, Math.PI * 2);
			path.closePath();
			return true;
		}
		case "line": {
			path.moveTo(x("x1"), y("y1"));
			path.lineTo(x("x2"), y("y2"));
			return true;
		}
		case "polyline":
		case "polygon": {
			const points = readNumbers(a.get("points"));
			if (points.length < 4) {
				return false;
			}
			path.moveTo(points[0], points[1]);
			for (let i = 2; i + 1 < points.length; i += 2) {
				path.lineTo(points[i], points[i + 1]);
			}
			if (name === "polygon") {
				path.closePath();
			}
			return true;
		}
	}
	return false;
}

function clipTo(drawing: Drawing, clip: SVGNode): void {
	const {context} = drawing;
	const attributes = getAttributes(clip, drawing.rules);
	context.save();
	context.transform(...readTransform(attributes.get("transform")));
	context.beginPath();
	let rule: "nonzero" | "evenodd" = "nonzero";
	for (const child of clip.childNodes ?? []) {
		if (child.tagName === undefined || !SHAPES.has(child.tagName)) {
			continue;
		}
		const shape = getAttributes(child, drawing.rules);
		if (shape.get("display") === "none") {
			continue;
		}
		if (shape.get("clip-rule") === "evenodd") {
			rule = "evenodd";
		}
		context.save();
		context.transform(...readTransform(shape.get("transform")));
		shapePath(context, child.tagName, shape, drawing.viewport);
		context.restore();
	}
	// The path keeps its shape, so the clip outlives these transforms.
	context.restore();
	context.clip(rule);
}

function drawShape(
	drawing: Drawing,
	name: string,
	attributes: Attributes,
	paint: Paint,
): void {
	const {context, viewport} = drawing;
	context.beginPath();
	if (!shapePath(context, name, attributes, viewport)) {
		return;
	}
	// Measured only for a gradient laid over the shape's box.
	let box: Box | null = null;
	let measured = false;
	const bounds = (): Box | null => {
		if (!measured) {
			const path = new Path2D();
			shapePath(path, name, attributes, viewport);
			box = getPathBounds(path);
			measured = true;
		}
		return box;
	};
	if (name !== "line") {
		const fill = resolvePaint(
			drawing,
			paint.fill,
			paint,
			paint.fillOpacity,
			bounds,
		);
		if (fill !== null) {
			context.fillStyle = fill;
			context.fill(paint.fillRule);
		}
	}
	const diagonal = Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
	const width = readLength(paint.strokeWidth, 1, diagonal);
	if (width <= 0) {
		return;
	}
	const stroke = resolvePaint(
		drawing,
		paint.stroke,
		paint,
		paint.strokeOpacity,
		bounds,
	);
	if (stroke === null) {
		return;
	}
	context.strokeStyle = stroke;
	context.lineWidth = width;
	context.lineCap = paint.lineCap as CanvasLineCap;
	context.lineJoin = paint.lineJoin as CanvasLineJoin;
	context.miterLimit = paint.miterLimit;
	const dashes = paint.dashes === "none"
		? []
		: paint.dashes
			.split(/[\s,]+/)
			.filter((dash) => dash !== "")
			.map((dash) => readLength(dash, 0, diagonal));
	// A negative dash, or dashes that come to nothing, is a solid line.
	context.setLineDash(
		dashes.some((dash) => dash < 0) || dashes.every((dash) => dash === 0)
			? []
			: dashes,
	);
	context.lineDashOffset = readLength(paint.dashOffset, 0, diagonal);
	context.stroke();
}

async function draw(
	drawing: Drawing,
	node: SVGNode,
	parent: Paint,
	depth: number,
	uses: number,
	used: boolean,
): Promise<void> {
	const name = node.tagName;
	if (name === undefined || depth > MAX_DEPTH || (UNDRAWN.has(name) && !used)) {
		return;
	}
	const attributes = getAttributes(node, drawing.rules);
	if (attributes.get("display") === "none") {
		return;
	}
	const {context} = drawing;
	const paint = readPaint(attributes, parent);
	context.save();
	// Group opacity is given to each shape in the group, which is only
	// right where the shapes do not overlap.
	context.globalAlpha *= readOpacity(attributes.get("opacity"), 1);
	context.transform(...readTransform(attributes.get("transform")));
	const clip = getReference(attributes.get("clip-path"));
	const clipNode = clip === null ? undefined : drawing.ids.get(clip);
	if (clipNode !== undefined && clipNode.tagName === "clipPath") {
		clipTo(drawing, clipNode);
	}
	if (name === "use") {
		const href = getHref(attributes);
		const target = href === null ? undefined : drawing.ids.get(href);
		if (target !== undefined && uses < MAX_USE_DEPTH) {
			context.translate(
				readLength(attributes.get("x"), 0, drawing.viewport.width),
				readLength(attributes.get("y"), 0, drawing.viewport.height),
			);
			await draw(drawing, target, paint, depth + 1, uses + 1, true);
		}
	} else if (CONTAINERS.has(name)) {
		for (const child of node.childNodes ?? []) {
			await draw(drawing, child, paint, depth + 1, uses, false);
		}
	} else if (SHAPES.has(name) && paint.visible) {
		if (++drawing.shapes > MAX_SHAPES) {
			throw new Error("The SVG image draws too many shapes");
		}
		drawShape(drawing, name, attributes, paint);
		const turn = drawing.pause();
		if (turn !== undefined) {
			await turn;
		}
	}
	context.restore();
}

// ---------------------------------------------------------------------------
// The file.

function findRoot(node: SVGNode, depth = 0): SVGNode | null {
	if (node.tagName === "svg") {
		return node;
	}
	if (depth > MAX_DEPTH) {
		return null;
	}
	for (const child of node.childNodes ?? []) {
		const found = findRoot(child, depth + 1);
		if (found !== null) {
			return found;
		}
	}
	return null;
}

function collectIds(node: SVGNode, ids: Map<string, SVGNode>, depth = 0): void {
	if (depth > MAX_DEPTH) {
		return;
	}
	for (const attribute of node.attrs ?? []) {
		if (attribute.name === "id" && !ids.has(attribute.value)) {
			ids.set(attribute.value, node);
		}
	}
	for (const child of node.childNodes ?? []) {
		collectIds(child, ids, depth + 1);
	}
}

// The most a small drawing is enlarged, and the pixels it is drawn to.
const MAX_SCALE = 16;
const DRAWN_PIXELS = 1 << 18;

/**
 * How many pixels to draw for each of the image's own: more for a small
 * image, fewer for one too large to keep.
 */
function getScale(width: number, height: number): number {
	const area = width * height;
	const scale = Math.sqrt(DRAWN_PIXELS / area);
	return scale >= 1
		? Math.min(MAX_SCALE, scale)
		: Math.min(1, Math.sqrt(MAX_KEPT_PIXELS / area));
}

/** The matrix that fits the viewBox into the image (SVG 2 §8.2). */
function fitViewBox(
	box: number[],
	width: number,
	height: number,
	preserve: string,
): Matrix {
	const [align = "xMidYMid", mode = "meet"] = preserve
		.trim()
		.split(/\s+/)
		.filter((word) => word !== "" && word !== "defer");
	const scaleX = width / box[2];
	const scaleY = height / box[3];
	if (align === "none") {
		return [scaleX, 0, 0, scaleY, -box[0] * scaleX, -box[1] * scaleY];
	}
	const scale = mode === "slice"
		? Math.max(scaleX, scaleY)
		: Math.min(scaleX, scaleY);
	const shareX = align.includes("xMin") ? 0 : align.includes("xMax") ? 1 : 0.5;
	const shareY = align.includes("YMin") ? 0 : align.includes("YMax") ? 1 : 0.5;
	return [
		scale,
		0,
		0,
		scale,
		(width - box[2] * scale) * shareX - box[0] * scale,
		(height - box[3] * scale) * shareY - box[1] * scale,
	];
}

const ENTITY = /<!ENTITY\s+([\w.-]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g;

/**
 * The file from its root element on, with its doctype's entities written
 * out, since the HTML parser knows none of them. Each is expanded once.
 */
function expandEntities(source: string): string {
	const start = Math.max(0, source.search(/<svg[\s>]/i));
	const body = source.slice(start);
	const entities = new Map<string, string>();
	for (const match of source.slice(0, start).matchAll(ENTITY)) {
		entities.set(match[1], match[2] ?? match[3] ?? "");
	}
	if (entities.size === 0) {
		return body;
	}
	let length = body.length;
	return body.replace(/&([\w.-]+);/g, (reference, name: string) => {
		const text = entities.get(name);
		if (text === undefined) {
			return reference;
		}
		length += text.length;
		if (length > MAX_SVG_BYTES) {
			throw new Error(`The SVG file is more than ${MAX_SVG_BYTES} bytes`);
		}
		// The text stands in an attribute, which a quote would end.
		return text.replace(/"/g, "&quot;");
	});
}

// A percentage has no page to be a share of, so it is no size.
function readSide(value: string | undefined): number | null {
	const length = value === undefined || value.includes("%")
		? NaN
		: readLength(value, NaN, 0);
	return length > 0 ? length : null;
}

/**
 * Draw an SVG file. The bitmap's natural size is the image's size in CSS
 * pixels. Past `deadline`, a time from Date.now(), the drawing stops.
 */
export async function rasterizeSVG(
	bytes: Uint8Array,
	deadline = Infinity,
): Promise<Bitmap> {
	if (bytes.length > MAX_SVG_BYTES) {
		throw new Error(`The SVG file is more than ${MAX_SVG_BYTES} bytes`);
	}
	// The HTML parser reads <svg> as foreign content, which fixes the case
	// of viewBox and the like, and reads <path/> as closed.
	const fragment = Parse5.parseFragment(
		expandEntities(new TextDecoder().decode(bytes)),
	) as unknown as SVGNode;
	const root = findRoot(fragment);
	if (root === null) {
		throw new Error("Not an SVG image");
	}
	const rules = readSheet(collectSheet(root));
	const attributes = getAttributes(root, rules);
	const box = readNumbers(attributes.get("viewBox"));
	const hasBox = box.length === 4 && box[2] > 0 && box[3] > 0;
	// A missing side keeps the viewBox's proportions. With neither side
	// nor a viewBox, the image is 300 by 150, as a browser has it.
	const sides = {
		width: readSide(attributes.get("width")),
		height: readSide(attributes.get("height")),
	};
	const width =
		sides.width ?? (
			hasBox
				? sides.height === null ? box[2] : (sides.height * box[2]) / box[3]
				: 300
		);
	const height =
		sides.height ?? (
			hasBox
				? sides.width === null ? box[3] : (sides.width * box[3]) / box[2]
				: 150
		);
	const naturalWidth = Math.max(1, Math.round(width));
	const naturalHeight = Math.max(1, Math.round(height));
	const scale = getScale(naturalWidth, naturalHeight);
	const bitmap = createBitmap(
		Math.max(1, Math.round(naturalWidth * scale)),
		Math.max(1, Math.round(naturalHeight * scale)),
	);
	const context = createContext2D({
		canvas: {},
		bitmap: () => bitmap,
		changed() {},
		pixelsPerCell: () => ({x: 1, y: 1}),
		direction: () => "ltr",
	});
	context.scale(bitmap.width / width, bitmap.height / height);
	if (hasBox) {
		context.transform(
			...fitViewBox(
				box,
				width,
				height,
				attributes.get("preserveAspectRatio") ?? "",
			),
		);
	}
	const ids = new Map<string, SVGNode>();
	collectIds(root, ids);
	const drawing: Drawing = {
		context,
		rules,
		ids,
		viewport: hasBox ? {width: box[2], height: box[3]} : {width, height},
		shapes: 0,
		pause: createYielder(deadline),
	};
	const paint = readPaint(attributes, INITIAL_PAINT);
	for (const child of root.childNodes ?? []) {
		await draw(drawing, child, paint, 0, 0, false);
	}
	bitmap.naturalWidth = naturalWidth;
	bitmap.naturalHeight = naturalHeight;
	return bitmap;
}
