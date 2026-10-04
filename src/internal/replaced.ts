/**
 * Replaced elements: <img> and <canvas>. Their content comes from
 * outside the CSS formatting model, so they size from their natural
 * dimensions (CSS 2 §10.3.2, §10.6.2) and paint what they hold into
 * their content box instead of laying out children.
 *
 * An image's pixels are CSS pixels, so its natural size in cells is its
 * size over the page's cell size. Under the default unit cell, where a
 * CSS pixel is a cell, that would be one cell per pixel, so the image
 * takes the screen's cell size instead, which the terminal reports
 * (XTWINOPS 16) and which is guessed at 8 by 16 until it does. A
 * charactergrid canvas is already in cells.
 */
import {type CanvasTextRun, halfBlockCell} from "./canvas.ts";
import {
	getBoxModel,
	getComputedValue,
	getImageCellSize,
	toCellLength,
} from "./cssom.ts";
import * as CSSValues from "./cssvalues.ts";
import {
	CellContext,
	CellGrid,
	type CellStyle,
	settleBorders,
} from "./framebuffer.ts";
import {
	type Bitmap,
	getReplacedContent,
	isReplacedElement,
	MAX_IMAGE_PIXELS,
	type ReplacedContent,
	sampleBitmap,
} from "./images.ts";
import {getStringWidth} from "./text.ts";

export {isReplacedElement};

/** The natural size in cells, or null for content with none. */
export function getNaturalSize(
	element: Element,
	content: ReplacedContent = getReplacedContent(element),
): {width: number; height: number} | null {
	if (content === null) {
		return null;
	}
	if (content.kind === "grid") {
		return {width: content.grid.cols, height: content.grid.rows};
	}
	if (content.kind === "text") {
		// The alt text on one line inside a border, or an empty cell
		// inside one when there is none.
		return {width: Math.max(1, textWidth(content.text)) + 2, height: 3};
	}
	const {width, height} = content.kind === "blank" ? content : content.bitmap;
	if (width === 0 || height === 0) {
		return {width: 0, height: 0};
	}
	const cell = getImageCellSize(element as unknown as Node);
	return {
		width: Math.max(1, Math.round(width / cell.width)),
		height: Math.max(1, Math.round(height / cell.height)),
	};
}

/** Width over height in cells, unrounded, or NaN for content with none. */
export function getNaturalRatio(
	element: Element,
	content: ReplacedContent = getReplacedContent(element),
): number {
	if (content === null || content.kind === "text") {
		return NaN;
	}
	if (content.kind === "grid") {
		return content.grid.rows > 0 ? content.grid.cols / content.grid.rows : NaN;
	}
	const {width, height} = content.kind === "blank" ? content : content.bitmap;
	if (width === 0 || height === 0) {
		return NaN;
	}
	const cell = getImageCellSize(element as unknown as Node);
	return (width / cell.width) / (height / cell.height);
}

function textWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += Math.max(0, getStringWidth(char));
	}
	return width;
}

// A length or a percentage of `base`, in cells, or undefined for auto,
// none, or a percentage with no base to resolve against.
function resolveLength(
	element: Element,
	value: string,
	base: number,
	vertical: boolean,
): number | undefined {
	const parsed = toCellLength(
		CSSValues.parseUnitValue(value),
		vertical,
		element as unknown as Node,
	);
	if (typeof parsed === "number") {
		return parsed;
	}
	if (
		parsed !== null &&
		typeof parsed === "object" &&
		"percentage" in parsed &&
		Number.isFinite(base)
	) {
		return (parsed.percentage / 100) * base;
	}
	return undefined;
}

/**
 * The content box's used size in cells: CSS 2's rules for a replaced
 * element. A size set on one axis takes the other from the natural
 * ratio; with neither set, the natural size; then min and max clamp,
 * carrying the ratio across to an axis that was not set. `width` and
 * `height` here are border-box lengths, as this engine computes them.
 */
export function getReplacedSize(
	element: Element,
	availableWidth = NaN,
): {width: number; height: number} {
	const box = getBoxModel(element);
	const horizontal =
		box.paddingLeft +
		box.paddingRight +
		box.borderLeftWidth +
		box.borderRightWidth;
	const vertical =
		box.paddingTop +
		box.paddingBottom +
		box.borderTopWidth +
		box.borderBottomWidth;
	const content = getReplacedContent(element);
	const natural = getNaturalSize(element, content);
	const ratio = getNaturalRatio(element, content);
	const hasRatio = Number.isFinite(ratio) && ratio > 0;

	const cssWidth = resolveLength(
		element,
		getComputedValue(element, "width"),
		availableWidth,
		false,
	);
	const cssHeight = box.height;
	let width = cssWidth === undefined
		? undefined
		: Math.max(0, cssWidth - horizontal);
	let height = cssHeight === undefined
		? undefined
		: Math.max(0, cssHeight - vertical);
	const widthSet = width !== undefined;
	const heightSet = height !== undefined;
	if (width === undefined && height === undefined) {
		width = natural?.width ?? 0;
		height = natural?.height ?? 0;
	} else if (width === undefined) {
		width = hasRatio ? height! * ratio : (natural?.width ?? 0);
	} else if (height === undefined) {
		height = hasRatio ? width / ratio : (natural?.height ?? 0);
	}

	const edge = (
		property: string,
		base: number,
		inset: number,
		isVertical: boolean,
	) => {
		const value = resolveLength(
			element,
			getComputedValue(element, property),
			base,
			isVertical,
		);
		return value === undefined ? undefined : Math.max(0, value - inset);
	};
	const maxWidth = edge("max-width", availableWidth, horizontal, false);
	const minWidth = edge("min-width", availableWidth, horizontal, false);
	const maxHeight = edge("max-height", NaN, vertical, true);
	const minHeight = edge("min-height", NaN, vertical, true);
	if (maxWidth !== undefined && width! > maxWidth) {
		width = maxWidth;
		if (!heightSet && hasRatio) {
			height = width / ratio;
		}
	}
	if (minWidth !== undefined && width! < minWidth) {
		width = minWidth;
		if (!heightSet && hasRatio) {
			height = width / ratio;
		}
	}
	if (maxHeight !== undefined && height! > maxHeight) {
		height = maxHeight;
		if (!widthSet && hasRatio) {
			width = height * ratio;
		}
	}
	if (minHeight !== undefined && height! < minHeight) {
		height = minHeight;
		if (!widthSet && hasRatio) {
			width = height * ratio;
		}
	}
	return {
		width: Math.max(0, Math.round(width!)),
		height: Math.max(0, Math.round(height!)),
	};
}

/**
 * The measure for a replaced element's layout node: offered a definite
 * width, the height follows from the ratio; otherwise the natural size.
 */
export function measureReplaced(
	element: Element,
	width: number,
	widthSpace: string,
): {width: number; height: number} {
	if (widthSpace === "definite" && Number.isFinite(width)) {
		const content = getReplacedContent(element);
		const ratio = getNaturalRatio(element, content);
		const natural = getNaturalSize(element, content);
		return {
			width,
			height: Number.isFinite(ratio) && ratio > 0
				? Math.round(width / ratio)
				: (natural?.height ?? 0),
		};
	}
	return getReplacedSize(element, width);
}

// ---------------------------------------------------------------------------
// Painting.

interface Placement {
	// The image's box in the content box, in columns and half rows, which
	// may run past the content box (object-fit: cover, none).
	x: number;
	y: number;
	width: number;
	height: number;
}

// object-position: two keywords, lengths or percentages, center by default.
function readObjectPosition(element: Element): [string, string] {
	const value = getComputedValue(element, "object-position")
		.trim()
		.toLowerCase();
	const parts = value === "" ? ["50%", "50%"] : value.split(/\s+/);
	let x = "50%";
	let y = "50%";
	const vertical = new Set(["top", "bottom"]);
	const horizontal = new Set(["left", "right"]);
	if (parts.length === 1) {
		if (vertical.has(parts[0])) {
			y = parts[0];
		} else {
			x = parts[0];
		}
	} else if (vertical.has(parts[0]) || horizontal.has(parts[1])) {
		y = parts[0];
		x = parts[1];
	} else {
		x = parts[0];
		y = parts[1];
	}
	return [x, y];
}

function positionOffset(value: string, free: number, unit: number): number {
	switch (value) {
		case "left":
		case "top":
			return 0;
		case "right":
		case "bottom":
			return free;
		case "center":
			return free / 2;
	}
	const parsed = CSSValues.parseSignedUnitValue(value);
	if (typeof parsed === "number") {
		return parsed * unit;
	}
	const percent = /^(-?[\d.]+)%$/.exec(value);
	return percent ? (parseFloat(percent[1]) / 100) * free : free / 2;
}

// Where object-fit and object-position put an image of `natural` cells
// (unrounded) in a content box `cols` by `rows`.
function placeImage(
	element: Element,
	cols: number,
	rows: number,
	naturalWidth: number,
	naturalHeight: number,
): Placement {
	const boxWidth = cols;
	const boxHeight = rows * 2;
	const imageWidth = naturalWidth;
	const imageHeight = naturalHeight * 2;
	const fit =
		getComputedValue(element, "object-fit").trim().toLowerCase() || "fill";
	if (fit === "fill" || imageWidth <= 0 || imageHeight <= 0) {
		return {x: 0, y: 0, width: boxWidth, height: boxHeight};
	}
	const contain = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
	const scale = fit === "contain"
		? contain
		: fit === "cover"
			? Math.max(boxWidth / imageWidth, boxHeight / imageHeight)
			: fit === "scale-down" ? Math.min(1, contain) : 1;
	const width = imageWidth * scale;
	const height = imageHeight * scale;
	const [px, py] = readObjectPosition(element);
	return {
		x: positionOffset(px, boxWidth - width, 1),
		y: positionOffset(py, boxHeight - height, 2),
		width,
		height,
	};
}

interface CellCache {
	key: string;
	cells: CellGrid;
}

const bitmapCells = new WeakMap<Bitmap, CellCache>();

// The bitmap as cells over a content box `cols` by `rows`, kept until
// the pixels, the box or the placement change.
function getBitmapCells(
	element: Element,
	content: Extract<ReplacedContent, {kind: "bitmap"}>,
	cols: number,
	rows: number,
	under: number | null,
): CellGrid {
	const {bitmap} = content;
	const cell = getImageCellSize(element as unknown as Node);
	const naturalWidth = bitmap.width / cell.width;
	const naturalHeight = bitmap.height / cell.height;
	const place = placeImage(element, cols, rows, naturalWidth, naturalHeight);
	const rendering = getComputedValue(element, "image-rendering")
		.trim()
		.toLowerCase();
	const smooth =
		content.smooth && rendering !== "pixelated" && rendering !== "crisp-edges";
	const key = [
		content.version,
		cols,
		rows,
		under,
		place.x,
		place.y,
		place.width,
		place.height,
		smooth,
	].join(",");
	const cached = bitmapCells.get(bitmap);
	if (cached !== undefined && cached.key === key) {
		return cached.cells;
	}
	// The part of the image inside the content box, snapped to whole
	// columns and half rows.
	const left = Math.max(0, Math.round(place.x));
	const top = Math.max(0, Math.round(place.y));
	const right = Math.min(cols, Math.round(place.x + place.width));
	const bottom = Math.min(rows * 2, Math.round(place.y + place.height));
	const pixels = new Uint8ClampedArray(cols * rows * 2 * 4);
	if (right > left && bottom > top && place.width > 0 && place.height > 0) {
		const scaleX = bitmap.width / place.width;
		const scaleY = bitmap.height / place.height;
		const sampled = sampleBitmap(
			bitmap,
			right - left,
			bottom - top,
			{
				x: (left - place.x) * scaleX,
				y: (top - place.y) * scaleY,
				width: (right - left) * scaleX,
				height: (bottom - top) * scaleY,
			},
			smooth,
		);
		const width = right - left;
		for (let y = top; y < bottom; y++) {
			pixels.set(
				sampled.subarray((y - top) * width * 4, (y - top + 1) * width * 4),
				(y * cols + left) * 4,
			);
		}
	}
	const cells = new CellContext(new CellGrid(rows, cols), rows, cols, 0);
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const half = halfBlockCell(
				pixels,
				(row * 2 * cols + col) * 4,
				((row * 2 + 1) * cols + col) * 4,
				under,
			);
			if (half !== null) {
				cells.drawText(half.char, col, row, half.style);
			}
		}
	}
	bitmapCells.set(bitmap, {key, cells: cells.grid});
	return cells.grid;
}

const settledGrids = new WeakMap<CellGrid, {version: number; grid: CellGrid}>();

// A charactergrid's cells with its lines joined among themselves and
// drawn, kept until the canvas draws again.
function getSettledGrid(
	content: Extract<ReplacedContent, {kind: "grid"}>,
): CellGrid {
	const cached = settledGrids.get(content.grid);
	if (cached?.version === content.version) {
		return cached.grid;
	}
	const grid = content.grid.clone();
	settleBorders(grid);
	settledGrids.set(content.grid, {version: content.version, grid});
	return grid;
}

/**
 * Paint what a replaced element holds into its content box, whose border
 * box is `rect`. `style` is the element's text style, for alt text and
 * for grid cells in the terminal's own colors. `under` is the element's
 * background as a cell color, which partly transparent pixels blend
 * over, or null to let only pixels at least half opaque show.
 */
export function renderReplaced(
	element: Element,
	rect: {left: number; top: number; width: number; height: number},
	ctx: CellContext,
	style: CellStyle,
	under: number | null,
	textRuns: CanvasTextRun[] = [],
): void {
	const content = getReplacedContent(element);
	if (content === null || content.kind === "blank") {
		return;
	}
	const box = getBoxModel(element);
	const left = Math.round(rect.left + box.borderLeftWidth + box.paddingLeft);
	const top = Math.round(rect.top + box.borderTopWidth + box.paddingTop);
	const cols = Math.max(
		0,
		Math.round(
			rect.width -
			box.borderLeftWidth -
			box.paddingLeft -
			box.borderRightWidth -
				box.paddingRight,
		),
	);
	const rows = Math.max(
		0,
		Math.round(
			rect.height -
			box.borderTopWidth -
			box.paddingTop -
			box.borderBottomWidth -
				box.paddingBottom,
		),
	);
	if (cols === 0 || rows === 0) {
		return;
	}
	// The content box clips what the element draws, inside any clip
	// already in force.
	const previous = ctx.clipRect;
	const own = {left, top, right: left + cols, bottom: top + rows};
	ctx.clipRect = previous === null
		? own
		: {
			left: Math.max(previous.left, own.left),
			top: Math.max(previous.top, own.top),
			right: Math.min(previous.right, own.right),
			bottom: Math.min(previous.bottom, own.bottom),
		};
	try {
		if (content.kind === "text") {
			drawPlaceholder(content.text, left, top, cols, rows, ctx, style);
		} else if (content.kind === "grid") {
			ctx.drawGrid(getSettledGrid(content), left, top, style);
		} else if (cols * rows * 2 <= MAX_IMAGE_PIXELS) {
			// Past the limit the pixels a box samples are more than an image
			// may hold, and like a canvas past it, the box shows nothing.
			ctx.drawGrid(
				getBitmapCells(element, content, cols, rows, under),
				left,
				top,
				style,
			);
			if (textRuns.length > 0) {
				paintTextRuns(
					element,
					content.bitmap,
					textRuns,
					left,
					top,
					cols,
					rows,
					ctx,
				);
			}
		}
	} finally {
		ctx.clipRect = previous;
	}
}

/**
 * An image that is not showing: a box around the content box with the
 * alt text inside it, cut to fit. A box too small for a border holds
 * the text alone.
 */
function drawPlaceholder(
	text: string,
	left: number,
	top: number,
	cols: number,
	rows: number,
	ctx: CellContext,
	style: CellStyle,
): void {
	if (cols < 3 || rows < 3) {
		ctx.drawText(fitText(text, cols), left, top, style);
		return;
	}
	const side = {style: "solid" as const, color: style.fg};
	ctx.drawBox(left, top, cols, rows, {
		top: side,
		right: side,
		bottom: side,
		left: side,
	});
	ctx.drawText(fitText(text, cols - 2), left + 1, top + 1, style);
}

// The text cut to `width` columns, with an ellipsis where it was cut.
function fitText(text: string, width: number): string {
	if (textWidth(text) <= width) {
		return text;
	}
	if (width <= 0) {
		return "";
	}
	let out = "";
	let used = 0;
	for (const char of text) {
		const columns = Math.max(0, getStringWidth(char));
		if (used + columns > width - 1) {
			break;
		}
		out += char;
		used += columns;
	}
	return out + "…";
}

// A 2d context's text at the cells its anchors fall in, through the same
// placement as the pixels.
function paintTextRuns(
	element: Element,
	bitmap: Bitmap,
	runs: CanvasTextRun[],
	left: number,
	top: number,
	cols: number,
	rows: number,
	ctx: CellContext,
): void {
	const cell = getImageCellSize(element as unknown as Node);
	const place = placeImage(
		element,
		cols,
		rows,
		bitmap.width / cell.width,
		bitmap.height / cell.height,
	);
	const perCol = place.width / bitmap.width;
	const perRow = place.height / 2 / bitmap.height;
	for (const run of runs) {
		if (run.color.a < 0.5) {
			continue;
		}
		const width = textWidth(run.text);
		const anchorCol = place.x + run.x * perCol;
		// Text sits above an alphabetic, ideographic or bottom baseline, so
		// a baseline on a row's top edge puts the text in the row above.
		const anchorRow = place.y / 2 + run.y * perRow;
		const row =
			run.baseline === "top" ||
			run.baseline === "hanging" ||
			run.baseline === "middle"
				? Math.floor(anchorRow)
				: Math.ceil(anchorRow) - 1;
		let col = Math.round(anchorCol);
		if (run.align === "center") {
			col = Math.round(anchorCol - width / 2);
		} else if (run.align === "right") {
			col = Math.round(anchorCol - width);
		}
		if (row < 0 || row >= rows) {
			continue;
		}
		const {r, g, b} = run.color;
		ctx.drawText(run.text, left + col, top + row, {
			fg: CSSValues.toCellColor(
				(Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b),
			),
			bold: run.bold || undefined,
			italic: run.italic || undefined,
		});
	}
}
