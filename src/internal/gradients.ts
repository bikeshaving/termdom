/**
 * CSS Images' linear gradients: `linear-gradient()` and
 * `repeating-linear-gradient()` read from a `background-image`, and drawn
 * one background color per cell.
 */
import * as CSSTree from "css-tree/dist/csstree.esm";

import {
	getCSSValueChildren,
	parseAngle,
	parseColor,
	toCellColor,
	type UnitValue,
} from "./cssvalues.ts";
import type {CellContext} from "./framebuffer.ts";

/**
 * One `<color-stop>`. The position is what the author wrote: a fraction
 * of the gradient line, a length in cells, or null for one the fixup
 * fills in. The color is packed RGB, with alpha kept apart because a
 * cell either takes a color or keeps what is under it.
 */
interface GradientStop {
	color: number;
	alpha: number;
	position: UnitValue;
}

/**
 * A parsed `linear-gradient()`. The angle is the gradient line's, in
 * degrees clockwise from straight up. Stop positions stay as authored
 * because css-images-3 §3.4.3 resolves them against the line's length,
 * which the painter knows and the parser does not.
 */
export interface Gradient {
	repeating: boolean;
	angle: number;
	stops: GradientStop[];
}

// A corner's angle is the diagonal of a box whose cells make it square,
// which is what a terminal's two-to-one cells make of a bar twice as
// wide as it is tall.
const DIRECTION_ANGLES: Record<string, number> = {
	top: 0,
	right: 90,
	bottom: 180,
	left: 270,
	"top-left": 315,
	"top-right": 45,
	"bottom-right": 135,
	"bottom-left": 225,
};

const VERTICAL_SIDES = new Set(["top", "bottom"]);

// Null when the group is not a direction, in which case it is the first
// color stop instead.
function readGradientDirection(nodes: CSSTree.ValueNode[]): number | null {
	if (nodes.length === 1 && nodes[0].type === "Dimension") {
		return parseAngle(CSSTree.generate(nodes[0] as never));
	}
	if (
		nodes.length < 2 ||
		nodes.length > 3 ||
		nodes[0].type !== "Identifier" ||
		(nodes[0].name ?? "").toLowerCase() !== "to"
	) {
		return null;
	}
	const sides = nodes
		.slice(1)
		.map((node) =>
			node.type === "Identifier" ? (node.name ?? "").toLowerCase() : "",
		);
	// `to left top` and `to top left` name the same corner.
	const corner = sides.length === 1
		? sides[0]
		: VERTICAL_SIDES.has(sides[0])
			? `${sides[0]}-${sides[1]}`
			: `${sides[1]}-${sides[0]}`;
	return DIRECTION_ANGLES[corner] ?? null;
}

function readGradientColor(
	node: CSSTree.ValueNode,
): {color: number; alpha: number} | null {
	const text = CSSTree.generate(node as never).trim().toLowerCase();
	// A transparent stop still names a place on the line; the painter
	// borrows its neighbour's channels so the fade does not run to black.
	if (text === "transparent") {
		return {color: 0, alpha: 0};
	}
	return parseColor(text);
}

// Undefined, not null, for a node that is no position at all: null is a
// position the fixup has yet to fill in.
function readStopPosition(node: CSSTree.ValueNode): UnitValue | undefined {
	const number = parseFloat(node.value ?? "");
	if (!Number.isFinite(number)) {
		return undefined;
	}
	if (node.type === "Percentage") {
		return {percentage: number};
	}
	// px and ch both measure one cell, and nothing else does.
	if (node.type === "Dimension") {
		const unit = (node.unit ?? "").toLowerCase();
		return unit === "px" || unit === "ch" ? number : undefined;
	}
	return node.type === "Number" && number === 0 ? 0 : undefined;
}

function readLinearGradient(value: string): Gradient | null {
	// Only the first layer of a `background-image` list is read: a cell
	// holds one background, so nothing under the topmost image shows.
	const node = getCSSValueChildren(value.trim())?.[0];
	if (!node || node.type !== "Function") {
		return null;
	}
	const name = (node.name ?? "").toLowerCase();
	if (name !== "linear-gradient" && name !== "repeating-linear-gradient") {
		return null;
	}
	const args: CSSTree.ValueNode[][] = [[]];
	for (const child of node.children?.toArray() ?? []) {
		if (child.type === "Operator" && child.value === ",") {
			args.push([]);
		} else {
			args[args.length - 1].push(child);
		}
	}
	const direction = readGradientDirection(args[0]);
	const stops: GradientStop[] = [];
	for (let i = direction === null ? 0 : 1; i < args.length; i++) {
		const group = args[i];
		if (group.length === 0 || group.length > 3) {
			return null;
		}
		// A lone length between two stops is a color hint. It moves the
		// midpoint of a fade, a shift no run of whole cells can show, so it
		// parses and is then dropped.
		if (readStopPosition(group[0]) !== undefined) {
			if (group.length > 1 || stops.length === 0 || i === args.length - 1) {
				return null;
			}
			continue;
		}
		const color = readGradientColor(group[0]);
		if (color === null) {
			return null;
		}
		for (const position of group.length > 1 ? group.slice(1) : [null]) {
			const resolved = position === null ? null : readStopPosition(position);
			if (resolved === undefined) {
				return null;
			}
			// Two positions on one stop are two stops of the same color, so
			// the run between them takes no gradient at all.
			stops.push({color: color.color, alpha: color.alpha, position: resolved});
		}
	}
	if (stops.length < 2) {
		return null;
	}
	return {
		repeating: name === "repeating-linear-gradient",
		angle: direction ?? 180,
		stops,
	};
}

const gradients = new Map<string, Gradient | null>();

/**
 * The first image of a `background-image`, when it is a linear gradient.
 * Null for every other image, which a terminal paints as nothing.
 */
export function parseLinearGradient(value: string): Gradient | null {
	let gradient = gradients.get(value);
	if (gradient === undefined) {
		gradient = readLinearGradient(value);
		if (gradients.size > 1024) {
			gradients.clear();
		}
		gradients.set(value, gradient);
	}
	return gradient;
}

// A stop's position as a fraction of the gradient line, which is what
// the interpolation walks.
interface ResolvedStop {
	color: number;
	alpha: number;
	position: number;
}

/**
 * css-images-3 §3.4.3, against a gradient line of `length` cells: the
 * ends are pinned, a position never runs backwards, and a run of stops
 * without positions spreads evenly between the two that have them.
 */
function resolveStops(
	stops: readonly GradientStop[],
	length: number,
): ResolvedStop[] {
	// NaN marks a position still to be filled in, so the sweeps below can
	// tell "not yet known" from a real zero.
	const resolved = stops.map((stop) => ({
		color: stop.color,
		alpha: stop.alpha,
		position: stop.position === null
			? NaN
			: typeof stop.position === "number"
				? (length > 0 ? stop.position / length : 0)
				: stop.position.percentage / 100,
	}));
	const last = resolved.length - 1;
	if (Number.isNaN(resolved[0].position)) {
		resolved[0].position = 0;
	}
	if (Number.isNaN(resolved[last].position)) {
		resolved[last].position = 1;
	}
	let previous = resolved[0].position;
	for (let i = 1; i <= last; i++) {
		if (Number.isNaN(resolved[i].position)) {
			continue;
		}
		resolved[i].position = Math.max(resolved[i].position, previous);
		previous = resolved[i].position;
	}
	for (let i = 1; i < last; i++) {
		if (!Number.isNaN(resolved[i].position)) {
			continue;
		}
		let end = i;
		while (Number.isNaN(resolved[end].position)) {
			end++;
		}
		const start = resolved[i - 1].position;
		const step = (resolved[end].position - start) / (end - i + 1);
		for (let between = i; between < end; between++) {
			resolved[between].position = start + step * (between - i + 1);
		}
		i = end;
	}
	// A transparent stop names a place, not a color. Interpolating sRGB
	// toward the black it packs would dirty the fade, so it borrows the
	// channels of the nearest stop that paints.
	for (let i = 0; i <= last; i++) {
		if (resolved[i].alpha > 0) {
			continue;
		}
		for (let away = 1; away <= last; away++) {
			const before = resolved[i - away];
			const after = resolved[i + away];
			if (before !== undefined && before.alpha > 0) {
				resolved[i].color = before.color;
				break;
			}
			if (after !== undefined && after.alpha > 0) {
				resolved[i].color = after.color;
				break;
			}
		}
	}
	return resolved;
}

function squareOff(value: number): number {
	return Math.abs(value) < 1e-9 ? 0 : value;
}

function mixColors(before: number, after: number, ratio: number): number {
	const channel = (shift: number): number => {
		const from = (before >> shift) & 0xff;
		const to = (after >> shift) & 0xff;
		return Math.round(from + (to - from) * ratio) << shift;
	};
	return toCellColor(channel(16) | channel(8) | channel(0));
}

// Null where the gradient is more transparent than it is opaque, which
// leaves the cell to the flat background-color under it.
function getStopColor(
	stops: ResolvedStop[],
	position: number,
	repeating: boolean,
	under: number | null,
): number | null {
	const first = stops[0].position;
	const last = stops[stops.length - 1].position;
	let t = position;
	if (repeating && last > first) {
		const period = last - first;
		t = first + (((position - first) % period) + period) % period;
	}
	let index = 1;
	while (index < stops.length - 1 && stops[index].position < t) {
		index++;
	}
	const before = stops[index - 1];
	const after = stops[index];
	const span = after.position - before.position;
	// Two stops in one place are a hard edge, and everything at or past
	// it belongs to the later one.
	const ratio = span > 0
		? Math.min(1, Math.max(0, (t - before.position) / span))
		: t < before.position ? 0 : 1;
	const alpha = before.alpha + (after.alpha - before.alpha) * ratio;
	const color = mixColors(before.color, after.color, ratio);
	// Over a flat color the gradient composites onto it. Over nothing there
	// is no color to composite with, so the cell is the gradient's where
	// it is more opaque than not, and the terminal's otherwise.
	if (under !== null) {
		return alpha >= 1 ? color : mixColors(under, color, alpha);
	}
	return alpha < 0.5 ? null : color;
}

/**
 * css-images-3 §3.4.1: the gradient line runs through the box's center
 * at the gradient's angle and is `|w·sin a| + |h·cos a|` long, so that
 * every corner of the box projects onto it. A cell takes the color at
 * the projection of its own center.
 */
export function renderGradient(
	ctx: CellContext,
	gradient: Gradient,
	rect: {left: number; top: number; width: number; height: number},
	under: number | null,
	aspect: number,
): void {
	const cols = Math.round(rect.width);
	const rows = Math.round(rect.height);
	if (cols <= 0 || rows <= 0) {
		return;
	}
	const radians = (gradient.angle * Math.PI) / 180;
	// 0deg points up the screen, and the angle grows clockwise. A right
	// angle's sine or cosine lands a hair off zero, and a hair is enough
	// to tilt a gradient that should run straight along a row.
	const dx = squareOff(Math.sin(radians));
	const dy = squareOff(-Math.cos(radians));
	// A row counts for as many units as a cell is taller than wide, so the
	// gradient runs at the angle the screen shows and not the one a grid
	// of square cells would.
	const height = rows * aspect;
	const length = Math.abs(cols * dx) + Math.abs(height * dy);
	// The line is centered on the box, so it starts half its length back
	// from the center.
	const startX = (cols - dx * length) / 2;
	const startY = (height - dy * length) / 2;
	const stops = resolveStops(gradient.stops, length);
	const left = Math.round(rect.left);
	const top = Math.round(rect.top);
	const colorAt = (x: number, y: number): number | null =>
		getStopColor(
			stops,
			length > 0 ? (x * dx + y * dy) / length : 0,
			gradient.repeating,
			under,
		);
	// Along a row or a column every cell of the other axis is the same
	// color, so it is one fill. Only a slanted line is cell by cell.
	if (dy === 0) {
		for (let col = 0; col < cols; col++) {
			const color = colorAt(col + 0.5 - startX, 0);
			if (color !== null) {
				ctx.drawRect(left + col, top, 1, rows, color);
			}
		}
	} else if (dx === 0) {
		for (let row = 0; row < rows; row++) {
			const color = colorAt(0, (row + 0.5) * aspect - startY);
			if (color !== null) {
				ctx.drawRect(left, top + row, cols, 1, color);
			}
		}
	} else {
		for (let row = 0; row < rows; row++) {
			const y = (row + 0.5) * aspect - startY;
			for (let col = 0; col < cols; col++) {
				const color = colorAt(col + 0.5 - startX, y);
				if (color !== null) {
					ctx.drawRect(left + col, top + row, 1, 1, color);
				}
			}
		}
	}
}
