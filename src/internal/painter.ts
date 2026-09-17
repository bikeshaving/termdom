import {
	type Cascade,
	getBoxModel,
	getComputedValue,
	resolveBorderSides,
} from "./cssom.ts";
import * as CSSValues from "./cssvalues.ts";
import {
	flatParentElement,
	flowContent,
	getHighlightedTextNodes,
	getPaintedHighlights,
	getSelectionRecord,
	getShadowRoot,
	getTextControlSelectionRange,
	getTextControlValueText,
	getTopLayer,
	hasPaintedHighlights,
	HTMLElement,
	renderedTopLayer,
	type Window,
} from "./dom.ts";
import {getEditingCaretPoint} from "./editing.ts";
import {
	type Box,
	type BreakResult,
	type Display,
	getLineAlignOffset,
	getLineIndent,
	hasItemParent,
	type InlineBlockLeaf,
	isAtomicInline,
	isPositioned,
	isStackingContext,
	type Layout,
	renderTextFragment,
} from "./layout.ts";
import type {LayoutNode} from "./layoutsolver.ts";
import type {CellContext, CellStyle, LineStyle, Screen} from "./screen.ts";

// Edges, not origin and size. An unclipped axis is +-Infinity, and an
// edge computed from an infinite origin and size is NaN.
type ClipRect = {left: number; top: number; right: number; bottom: number};

function isClippingOverflow(value: string): boolean {
	return (
		value === "hidden" ||
		value === "clip" ||
		value === "auto" ||
		value === "scroll"
	);
}

// The clip is the padding box, so scrolled-out content does not paint
// over the border glyphs. An axis that stays visible is unbounded, per
// axis.
function getOverflowClipRect(
	element: Element,
	rect: {left: number; top: number; width: number; height: number} | null,
	overflowX: string,
	overflowY: string,
	parent: ClipRect | null,
): ClipRect | null {
	if (!rect) {
		return parent;
	}
	const clipsX = isClippingOverflow(overflowX);
	const clipsY = isClippingOverflow(overflowY);
	if (!clipsX && !clipsY) {
		return parent;
	}

	const box = getBoxModel(element);
	const left = clipsX ? rect.left + (box.borderLeftWidth || 0) : -Infinity;
	const right = clipsX
		? rect.left + rect.width - (box.borderRightWidth || 0)
		: Infinity;
	const top = clipsY ? rect.top + (box.borderTopWidth || 0) : -Infinity;
	const bottom = clipsY
		? rect.top + rect.height - (box.borderBottomWidth || 0)
		: Infinity;

	if (!parent) {
		return {left, top, right, bottom};
	}
	return {
		left: Math.max(parent.left, left),
		top: Math.max(parent.top, top),
		right: Math.min(parent.right, right),
		bottom: Math.min(parent.bottom, bottom),
	};
}

function resolveFontWeight(weight: string): {bold: boolean; dim: boolean} {
	const number = CSSValues.parseFontWeight(weight);
	return {bold: number >= 600, dim: number <= 300};
}

// Canvas is the terminal's own background. Highlight is inverse.
function getBackgroundFill(
	value: string,
): number | "default" | "inverse" | null {
	if (!value || value === "initial" || CSSValues.isTransparentColor(value)) {
		return null;
	}
	if (CSSValues.isCanvasColor(value)) {
		return "default";
	}
	if (CSSValues.isHighlightColor(value)) {
		return "inverse";
	}
	return CSSValues.cssColorToNumber(value);
}

function getGradient(element: Element): CSSValues.Gradient | null {
	const image = getComputedValue(element, "background-image");
	return image && image !== "none"
		? CSSValues.parseLinearGradient(image)
		: null;
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
	stops: readonly CSSValues.GradientStop[],
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
	return channel(16) | channel(8) | channel(0);
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
function renderGradient(
	ctx: CellContext,
	gradient: CSSValues.Gradient,
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

const paintStyles = new WeakMap<object, PaintStyle>();

interface PaintStyle {
	display: string;
	visible: boolean;
	fg: number | undefined;
	bg: number | undefined;
	fill: number | "default" | "inverse" | null;
	gradient: CSSValues.Gradient | null;
	border: BorderPaint | null;
	outlineColor: number | undefined | null;
	overflowX: string;
	overflowY: string;
	textTransform: string;
	whiteSpace: string;
	cell: CellStyle;
	shiftX: number;
	shiftY: number;
	contentInsetX: number;
	contentInsetY: number;
}

interface BorderPaint {
	top?: LineStyle;
	right?: LineStyle;
	bottom?: LineStyle;
	left?: LineStyle;
	topLeft?: "round";
	topRight?: "round";
	bottomRight?: "round";
	bottomLeft?: "round";
}

function readPaintStyle(element: Element): PaintStyle {
	const color = getComputedValue(element, "color");
	const backgroundColor = getComputedValue(element, "background-color");
	const fg = color && color !== "initial" && !CSSValues.isHighlightColor(color)
		? CSSValues.cssColorToNumber(color)
		: undefined;
	// Canvas clears the box to the terminal's default background, opaque in
	// every theme. Highlight fills it with inverse.
	const isCanvasBg =
		Boolean(backgroundColor) && CSSValues.isCanvasColor(backgroundColor);
	const isHighlightBox =
		Boolean(backgroundColor) && CSSValues.isHighlightColor(backgroundColor);
	const bg =
		backgroundColor &&
		!isCanvasBg &&
		backgroundColor !== "initial" &&
		!CSSValues.isTransparentColor(backgroundColor) &&
		!CSSValues.isHighlightColor(backgroundColor)
			? CSSValues.cssColorToNumber(backgroundColor)
			: undefined;
	const fill = bg != null || isCanvasBg || isHighlightBox
		? isCanvasBg ? "default" : isHighlightBox ? "inverse" : bg!
		: null;
	const sides = resolveBorderSides(element);
	// Unauthored, a border is the terminal's default foreground, because
	// no theme-safe color exists. A transparent side keeps its space and
	// paints no glyph.
	const sideFor = (
		line: LineStyle["style"] | undefined,
		prop: string,
	): LineStyle | undefined => {
		if (!line) {
			return undefined;
		}
		const borderColor = getComputedValue(element, prop);
		if (CSSValues.isTransparentColor(borderColor)) {
			return undefined;
		}
		return {
			style: line,
			color:
				borderColor &&
				borderColor !== "currentcolor" &&
				borderColor !== "currentColor"
					? CSSValues.cssColorToNumber(borderColor)
					: fg,
		};
	};
	const border: BorderPaint = {
		top: sideFor(sides.top, "border-top-color"),
		right: sideFor(sides.right, "border-right-color"),
		bottom: sideFor(sides.bottom, "border-bottom-color"),
		left: sideFor(sides.left, "border-left-color"),
		topLeft: sides.topLeft,
		topRight: sides.topRight,
		bottomRight: sides.bottomRight,
		bottomLeft: sides.bottomLeft,
	};
	// An outline repaints a bordered box's ring in its color. A borderless
	// box gets an underline along its bottom row. Overline (SGR 53) is
	// unreliable.
	const outlineStyle = getComputedValue(element, "outline-style");
	let outlineColor: number | undefined | null = null;
	if (
		outlineStyle &&
		outlineStyle !== "none" &&
		CSSValues.parseBorderWidthValue(
			getComputedValue(element, "outline-width"),
		) !==
		0
	) {
		const outline = getComputedValue(element, "outline-color")
			.trim()
			.toLowerCase();
		const hasColor =
			Boolean(outline) &&
			outline !== "auto" &&
			outline !== "currentcolor" &&
			outline !== "invert" &&
			!CSSValues.isHighlightColor(outline);
		// `auto`, the initial value and what `outline: 1px solid` leaves,
		// takes the element's own color, as a border's currentcolor does.
		outlineColor = hasColor ? CSSValues.cssColorToNumber(outline) : fg;
	}
	const overflow = getComputedValue(element, "overflow");
	let shiftX = 0;
	let shiftY = 0;
	if (getComputedValue(element, "position") === "relative") {
		const left = CSSValues.parseSignedUnitValue(
			getComputedValue(element, "left"),
		);
		const top = CSSValues.parseSignedUnitValue(
			getComputedValue(element, "top"),
		);
		shiftX = typeof left === "number" ? left : 0;
		shiftY = typeof top === "number" ? top : 0;
	}
	const decoration = CSSValues.parseTextDecorationLine(
		getComputedValue(element, "text-decoration-line"),
	);
	const {bold, dim} = resolveFontWeight(
		getComputedValue(element, "font-weight"),
	);
	const gradient = getGradient(element);
	const model = getBoxModel(element);
	return {
		contentInsetX: model.paddingLeft + model.borderLeftWidth,
		contentInsetY: model.paddingTop + model.borderTopWidth,
		display: getComputedValue(element, "display"),
		visible: getComputedValue(element, "visibility") !== "hidden",
		fg,
		bg,
		fill,
		gradient,
		border: border.top || border.right || border.bottom || border.left
			? border
			: null,
		outlineColor,
		overflowX: getComputedValue(element, "overflow-x") || overflow,
		overflowY: getComputedValue(element, "overflow-y") || overflow,
		textTransform: getComputedValue(element, "text-transform"),
		whiteSpace: getComputedValue(element, "white-space"),
		shiftX,
		shiftY,
		cell: {
			fg,
			// A gradient gives every cell its own background, so naming one
			// here would repaint the run flat under the text. An undefined
			// background leaves each cell the color the gradient put there.
			bg: gradient === null ? bg : undefined,
			// The background alone carries inverse. color: HighlightText alone
			// resolves to nothing, so an author color does not defeat it.
			inverse: isHighlightBox || undefined,
			bold,
			dim,
			italic: getComputedValue(element, "font-style") === "italic",
			underline: decoration.underline,
			underlineStyle:
				getComputedValue(element, "text-decoration-style") ===
				"double"
					? ("double" as const)
					: undefined,
			strikethrough: decoration.lineThrough,
		},
	};
}

// Applied at paint time. Case never changes a cell width, so it cannot
// change wrapping.
function applyTextTransform(text: string, transform: string): string {
	switch (transform) {
		case "capitalize":
			return text.replace(
				/\p{L}[\p{L}\p{M}]*/gu,
				(word) => (word[0]?.toUpperCase() ?? "") + word.slice(1),
			);
		case "lowercase":
			return text.toLowerCase();
		case "uppercase":
			return text.toUpperCase();
		default:
			return text;
	}
}

interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

interface Origin {
	x: number;
	y: number;
}

interface TextFragment {
	rect: Rect;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
}

interface PainterRun {
	texts: Map<Text, TextFragment[]>;
	boxes: Map<Element, Rect[]>;
	leaves: Map<Element, {rect: Rect; leaf: InlineBlockLeaf}>;
}

function unionRect(rects: Rect[]): Rect {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const rect of rects) {
		left = Math.min(left, rect.left);
		top = Math.min(top, rect.top);
		right = Math.max(right, rect.left + rect.width);
		bottom = Math.max(bottom, rect.top + rect.height);
	}
	return {left, top, width: right - left, height: bottom - top};
}

/** One registered highlight's share of one text node, in paint order. */
interface HighlightRun {
	name: string;
	from: number;
	to: number;
}

const kWindow = Symbol("window");
const kDocument = Symbol("document");
const kLayout = Symbol("layout");
const kCascade = Symbol("cascade");
const kScreen = Symbol("screen");
const kTopLayer = Symbol("topLayer");
const kRenderedOutsideMarkers = Symbol("renderedOutsideMarkers");
const kScrolledRows = Symbol("scrolledRows");
const kHighlightedText = Symbol("highlightedText");
const kHighlightStyles = Symbol("highlightStyles");
export interface Painter {
	[kWindow]: Window;
	[kDocument]: Document;
	[kLayout]: Layout;
	[kCascade]: Cascade;
	[kScreen]: Screen;
	[kTopLayer]: Set<Element>;
	// Each list marker paints at most once per frame.
	[kRenderedOutsideMarkers]: WeakSet<Element>;
	// Paint extents are cached in unscrolled rows. A scrolled subtree
	// paints this many rows higher, so culling shifts the viewport instead.
	[kScrolledRows]: number;
	[kHighlightedText]: Map<Text, HighlightRun[]>;
	[kHighlightStyles]: Map<Element, Map<string, HighlightPaint | null>>;
}

export class Painter {
	constructor(
		document: Document,
		layout: Layout,
		cascade: Cascade,
		screen: Screen,
	) {
		this[kRenderedOutsideMarkers] = new WeakSet<Element>();
		this[kScrolledRows] = 0;
		this[kHighlightedText] = new Map();
		this[kHighlightStyles] = new Map();
		this[kWindow] = document.defaultView as unknown as Window;
		this[kDocument] = document;
		this[kLayout] = layout;
		this[kCascade] = cascade;
		this[kScreen] = screen;
		this[kTopLayer] = getTopLayer(document) as unknown as Set<Element>;
	}

	/**
	 * The buffer rows a journalled element scroll covers, or null when the
	 * terminal cannot shift them. DECSTBM margins are horizontal, so a scroll
	 * shift is the region's full width or nothing. Content overlapping the
	 * shift is dragged along and the diff repairs it.
	 */
	resolveScrollShift(
		regionHeight: number,
		record: {element: Element; delta: number} | null,
	): {delta: number; top: number; end: number} | null {
		const screen = this[kScreen];
		const layout = this[kLayout];
		if (
			record === null ||
			record.delta === 0 ||
			// One scroll shift per frame. The document scroll's region already
			// contains this box.
			screen.journal.frameScroll !== 0 ||
			// The rows the terminal would shift are not the rows the last
			// frame painted.
			layout.moved ||
			hasPaintedHighlights(this[kDocument]) ||
			!record.element.isConnected
		) {
			return null;
		}
		const rect = layout.getRect(record.element);
		if (rect === null) {
			return null;
		}

		// The scroll port is the padding box.
		const box = getBoxModel(record.element);
		const left = rect.left + (box.borderLeftWidth || 0);
		const right = rect.left + rect.width - (box.borderRightWidth || 0);
		if (left > 0 || right < screen.cols) {
			return null;
		}

		// Layout rows are document rows. Buffer rows are the document
		// scroll's. A fixed box is laid out in viewport rows and the paint
		// cancels the document scroll for it.
		const lift = layout.isInFixedSpace(record.element) ? 0 : screen.scrollTop;
		const top = Math.max(
			0,
			Math.round(rect.top + (box.borderTopWidth || 0)) - lift,
		);
		const end = Math.min(
			regionHeight,
			Math.round(rect.top + rect.height - (box.borderBottomWidth || 0)) - lift,
		);
		if (end - top <= Math.abs(record.delta)) {
			return null;
		}
		return {delta: record.delta, top, end};
	}

	paint(ctx: CellContext): void {
		this[kRenderedOutsideMarkers] = new WeakSet<Element>();
		this[kScrolledRows] = 0;
		this[kHighlightedText] = collectHighlightedText(this[kDocument]);
		this[kHighlightStyles] = new Map();
		const layers = this[kLayout].collectStackingLayers(this[kTopLayer]);
		renderStackingContext(this, this[kDocument].body, ctx, layers);
		const rendered = renderedTopLayer(this[kDocument]) as unknown as Element[];
		for (const element of rendered) {
			const previousClip = ctx.clipRect;
			ctx.clipRect = null;
			// Entered from outside its ancestor chain, so seed the culling
			// shift.
			this[kScrolledRows] = this[kLayout].scrolledAncestorRows(element);
			try {
				renderBackdrop(element, ctx);
				renderStackingContext(this, element, ctx, layers);
			} finally {
				ctx.clipRect = previousClip;
				this[kScrolledRows] = 0;
			}
		}
	}
}

function getPaintStyle(painter: Painter, element: Element): PaintStyle {
	const key = painter[kCascade].getStyleKey(element);
	const known = key === null ? undefined : paintStyles.get(key);
	if (known !== undefined) {
		return known;
	}
	const style = readPaintStyle(element);
	if (key !== null) {
		paintStyles.set(key, style);
	}
	return style;
}

// Whatever the ::backdrop rules resolve to, the UA sheet's included.
function renderBackdrop(element: Element, ctx: CellContext): void {
	const fill = getBackgroundFill(
		getComputedValue(element, "background-color", "::backdrop"),
	);
	if (fill === null) {
		return;
	}
	// The viewport in document coordinates.
	ctx.drawRect(0, -ctx.viewportOffset, ctx.cols, ctx.rows, fill);
}

// CSS layer order: the root's box, negative-z contexts, in-flow
// content, the positioned z:auto/0 layer, positive-z contexts. A z:auto
// member does not isolate. Its own positioned descendants sit in this
// context's buckets.
function renderStackingContext(
	painter: Painter,
	root: Element,
	ctx: CellContext,
	layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
): void {
	const bucket = layers.get(root);
	if (!bucket) {
		paintEntry(painter, root, ctx);
		return;
	}
	const contextClip = ctx.clipRect;
	const paintMember = (element: Element) => {
		const previousClip = ctx.clipRect;
		const previousOffset = ctx.viewportOffset;
		const previousScrolled = painter[kScrolledRows];
		ctx.clipRect = getPositionedClip(painter, element, root, contextClip);
		// Entered from its stacking context, not its ancestor chain.
		painter[kScrolledRows] = painter[kLayout].scrolledAncestorRows(element);
		// Fixed space cancels the document scroll for the whole subtree. An
		// absolute box inside a fixed bar moves with it.
		if (painter[kLayout].isInFixedSpace(element)) {
			ctx.viewportOffset = previousOffset + painter[kScreen].scrollTop;
		}
		try {
			if (isStackingContext(element)) {
				renderStackingContext(painter, element, ctx, layers);
			} else {
				paintEntry(painter, element, ctx);
			}
		} finally {
			ctx.clipRect = previousClip;
			ctx.viewportOffset = previousOffset;
			painter[kScrolledRows] = previousScrolled;
		}
	};
	paintEntry(painter, root, ctx, () => {
		for (const element of bucket.neg) {
			paintMember(element);
		}
	});
	for (const element of bucket.zero) {
		paintMember(element);
	}
	for (const element of bucket.pos) {
		paintMember(element);
	}
}

function paintEntry(
	painter: Painter,
	element: Element,
	ctx: CellContext,
	afterOwnBox?: () => void,
): void {
	const layout = painter[kLayout];
	const node = layout.getLayoutNode(element);
	if (node === null) {
		return;
	}
	const rect = layout.getRect(element);
	if (rect === null) {
		return;
	}
	paintBlock(painter, element, node, {x: rect.x, y: rect.y}, ctx, afterOwnBox);
}

function isOutsideViewport(
	painter: Painter,
	ctx: CellContext,
	node: LayoutNode,
	element: Element | null,
): boolean {
	const extent = painter[kLayout].paintExtent(node);
	if (extent === undefined) {
		return false;
	}
	const top = -ctx.viewportOffset + painter[kScrolledRows];
	const bottom = top + ctx.rows;
	if (extent.bottom > top && extent.top < bottom) {
		return false;
	}
	// A broken inline paints boxes outside its own layout subtree, so its
	// extent says nothing about them.
	return element === null || !painter[kLayout].getBox(element)?.broken;
}

function paintBlock(
	painter: Painter,
	element: Element,
	node: LayoutNode,
	origin: Origin,
	ctx: CellContext,
	afterOwnBox?: () => void,
): void {
	if (isOutsideViewport(painter, ctx, node, element)) {
		return;
	}
	const style = getPaintStyle(painter, element);
	if (style.display === "none") {
		return;
	}
	const rect: Rect = {
		left: origin.x,
		top: origin.y,
		width: node.getComputedWidth(),
		height: node.getComputedHeight(),
	};
	paintBox(painter, style, [rect], rect, ctx);
	if (style.visible) {
		renderOutsideMarker(painter, element, style, rect, ctx);
	}
	paintCaret(painter, element, style, ctx);

	// The negative-z layer goes here, after the box and before its content.
	if (afterOwnBox) {
		afterOwnBox();
	}

	paintContent(painter, element, style, rect, ctx, (origin) => {
		paintNodes(painter, node, origin, ctx);
	});
	paintOutline(painter, element, style, rect, ctx);
}

function paintContent(
	painter: Painter,
	element: Element,
	style: PaintStyle,
	rect: Rect,
	ctx: CellContext,
	paintLayoutChildren: (origin: Origin) => void,
): void {
	const layout = painter[kLayout];
	const isRoot =
		element === painter[kDocument].body ||
		element === painter[kDocument].documentElement;
	const scrolledRows = isRoot ? 0 : element.scrollTop || 0;
	const scrolledCols = isRoot ? 0 : element.scrollLeft || 0;
	const origin: Origin = {
		x: rect.left - scrolledCols,
		y: rect.top - scrolledRows,
	};

	// Overflow clips descendants, never the element's own box.
	const previousClip = ctx.clipRect;
	const previousScrolled = painter[kScrolledRows];
	ctx.clipRect = getOverflowClipRect(
		element,
		rect,
		style.overflowX,
		style.overflowY,
		previousClip,
	);
	painter[kScrolledRows] = previousScrolled + scrolledRows;
	try {
		const box = layout.getBox(element);
		const context = box?.independentFormattingContext ?? null;
		const own = box?.fragments ? ownLeaf(box.fragments, element) : null;
		if (own !== null && own.breakResult) {
			paintLines(
				painter,
				own.breakResult,
				flowContent(element),
				element,
				element,
				{x: origin.x + style.contentInsetX, y: origin.y + style.contentInsetY},
				ctx,
			);
		} else if (own === null && box?.fragments) {
			// A blockified inline reserved padding and border in its box
			// that its lines count from the inside of.
			const inset = style.display === "inline" && hasItemParent(element);
			paintLines(
				painter,
				box.fragments,
				flowContent(element),
				element,
				box.container,
				{
					x: origin.x + (inset ? style.contentInsetX : 0),
					y: origin.y + (inset ? style.contentInsetY : 0),
				},
				ctx,
			);
		} else if (context !== null) {
			paintNodes(
				painter,
				context,
				{x: origin.x + style.contentInsetX, y: origin.y + style.contentInsetY},
				ctx,
			);
		} else {
			paintLayoutChildren(origin);
		}
	} finally {
		ctx.clipRect = previousClip;
		painter[kScrolledRows] = previousScrolled;
	}
}

function ownLeaf(lines: BreakResult, element: Element): InlineBlockLeaf | null {
	const line = lines.lines[0];
	if (lines.lines.length !== 1 || line.segments.length !== 1) {
		return null;
	}
	const {leaf} = line.segments[0];
	return leaf.type === "inline-block" && leaf.node === element ? leaf : null;
}

function paintNodes(
	painter: Painter,
	node: LayoutNode,
	origin: Origin,
	ctx: CellContext,
): void {
	const layout = painter[kLayout];
	for (const child of visibleChildren(painter, ctx, node)) {
		const owner = child.owner as Node | null;
		if (owner === null) {
			continue;
		}
		const childOrigin = {
			x: origin.x + child.result.left,
			y: origin.y + child.result.top,
		};
		const run = layout.getRun(child);
		if (run !== null) {
			paintRun(painter, run, childOrigin, ctx);
		} else if (
			owner.nodeType === owner.ELEMENT_NODE &&
			owner instanceof HTMLElement &&
			!layout.hoistedToLayer(owner)
		) {
			paintBlock(painter, owner, child, childOrigin, ctx);
		}
	}
}

function visibleChildren(
	painter: Painter,
	ctx: CellContext,
	node: LayoutNode,
): LayoutNode[] {
	const layout = painter[kLayout];
	const children = node.children;
	const top = -ctx.viewportOffset + painter[kScrolledRows];
	const bottom = top + ctx.rows;
	const extent = layout.paintExtent(node);
	const owner = node.owner as Node | null;
	if (
		extent === undefined ||
		extent.unstackedChildren !== 0 ||
		node.measure !== null ||
		node.style.displayType !== "block" ||
		(owner !== null &&
			owner.nodeType === owner.ELEMENT_NODE &&
			layout.getBox(owner as Element)?.holdsFragments === true)
	) {
		return children;
	}
	let lo = 0;
	let hi = children.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const childExtent = layout.paintExtent(children[mid]);
		if (childExtent !== undefined && childExtent.bottom <= top) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	const visible: LayoutNode[] = [];
	for (let i = lo; i < children.length; i++) {
		const childExtent = layout.paintExtent(children[i]);
		if (childExtent !== undefined && childExtent.top >= bottom) {
			break;
		}
		visible.push(children[i]);
	}
	return visible;
}

function paintBox(
	painter: Painter,
	style: PaintStyle,
	fragments: Rect[],
	rect: Rect,
	ctx: CellContext,
): void {
	if (!style.visible) {
		return;
	}
	if (style.fill !== null) {
		for (const fragment of fragments) {
			ctx.drawRect(
				fragment.left,
				fragment.top,
				fragment.width,
				fragment.height,
				style.fill,
			);
		}
	}
	// Over the flat fill, which a transparent stop composites onto.
	if (style.gradient !== null) {
		const cell = painter[kScreen].cellPixels;
		for (const fragment of fragments) {
			renderGradient(
				ctx,
				style.gradient,
				fragment,
				style.bg ?? null,
				cell.height / cell.width,
			);
		}
	}
	if (style.border !== null) {
		ctx.drawBox(
			Math.round(rect.left),
			Math.round(rect.top),
			Math.round(rect.width),
			Math.round(rect.height),
			style.border,
		);
	}
}

function paintOutline(
	painter: Painter,
	element: Element,
	style: PaintStyle,
	rect: Rect,
	ctx: CellContext,
): void {
	if (!style.visible || style.outlineColor === null) {
		return;
	}
	const color = style.outlineColor;
	const sides = resolveBorderSides(element);
	if (sides.top || sides.right || sides.bottom || sides.left) {
		const ring =
			(line: LineStyle["style"] | undefined): LineStyle | undefined =>
				line && {style: line, color};
		ctx.drawBox(
			Math.round(rect.left),
			Math.round(rect.top),
			Math.round(rect.width),
			Math.round(rect.height),
			{
				top: ring(sides.top),
				right: ring(sides.right),
				bottom: ring(sides.bottom),
				left: ring(sides.left),
				topLeft: sides.topLeft,
				topRight: sides.topRight,
				bottomRight: sides.bottomRight,
				bottomLeft: sides.bottomLeft,
			},
		);
	} else {
		ctx.drawDecoration(
			Math.round(rect.left),
			Math.round(rect.top + rect.height) - 1,
			Math.round(rect.width),
			{underline: true, fg: color},
		);
	}
}

function paintCaret(
	painter: Painter,
	element: Element,
	style: PaintStyle,
	ctx: CellContext,
): void {
	if (!style.visible || element !== painter[kDocument].activeElement) {
		return;
	}
	const record = getSelectionRecord(element);
	if (record === null) {
		renderEditingCaret(painter, element, ctx);
		return;
	}
	const focus = record.direction === "backward" ? record.start : record.end;
	const node = getTextControlValueText(element) ?? getGlyphText(element);
	let caret: {x: number; y: number} | null = null;
	if (node) {
		const range = element.ownerDocument.createRange();
		range.setStart(node, Math.min(focus, node.data.length));
		range.collapse(true);
		const rects = painter[kLayout].getRangeRects(range);
		if (rects.length > 0) {
			caret = {x: Math.round(rects[0].x), y: Math.round(rects[0].y)};
		}
	}
	if (caret === null) {
		const content = painter[kLayout].contentRect(element);
		if (content) {
			caret = {x: Math.round(content.x), y: Math.round(content.y)};
		}
	}
	if (caret !== null) {
		ctx.setCaret(caret.x, caret.y);
	}
}

// A run's lines, from the box that broke them. The origin is the run's
// layout node's; an atomic inline heading its run has that node at its
// margin edge while its segment counts from its margin box.
function paintRun(
	painter: Painter,
	box: Box,
	origin: Origin,
	ctx: CellContext,
): void {
	const lines = box.fragments;
	if (lines === null) {
		return;
	}
	const head = box.head;
	let x = origin.x;
	if (
		head.nodeType === head.ELEMENT_NODE &&
		isAtomicInline(getPaintStyle(painter, head as Element).display as Display)
	) {
		x -= getBoxModel(head as Element).marginLeft;
	}
	paintLines(
		painter,
		lines,
		box.members,
		box.container,
		box.container,
		{x, y: origin.y},
		ctx,
	);
}

function paintLines(
	painter: Painter,
	lines: BreakResult,
	members: Iterable<Node>,
	container: Element,
	alignContainer: Element,
	origin: Origin,
	ctx: CellContext,
): void {
	const run = resolveRun(painter, lines, container, alignContainer, origin);
	for (const member of members) {
		paintMember(painter, member, run, ctx);
	}
}

function paintMember(
	painter: Painter,
	node: Node,
	run: PainterRun,
	ctx: CellContext,
): void {
	if (node.nodeType === node.TEXT_NODE) {
		paintText(painter, node as Text, run, ctx);
		return;
	}
	if (node.nodeType !== node.ELEMENT_NODE) {
		return;
	}
	const element = node as Element;
	const leaf = run.leaves.get(element);
	if (leaf !== undefined) {
		paintAtomic(painter, element, leaf.leaf, leaf.rect, ctx);
		return;
	}
	if (painter[kLayout].hoistedToLayer(element)) {
		return;
	}
	paintInline(painter, element, run, ctx);
}

function paintInline(
	painter: Painter,
	element: Element,
	run: PainterRun,
	ctx: CellContext,
): void {
	const style = getPaintStyle(painter, element);
	if (style.display === "none") {
		return;
	}
	const fragments = run.boxes.get(element) ?? [];
	const rect = fragments.length > 0 ? unionRect(fragments) : null;
	if (rect !== null) {
		paintBox(painter, style, fragments, rect, ctx);
		paintCaret(painter, element, style, ctx);
	}
	for (const child of flowContent(element)) {
		paintMember(painter, child, run, ctx);
	}
	if (rect !== null) {
		paintOutline(painter, element, style, rect, ctx);
	}
}

function paintAtomic(
	painter: Painter,
	element: Element,
	leaf: InlineBlockLeaf,
	rect: Rect,
	ctx: CellContext,
): void {
	const style = getPaintStyle(painter, element);
	if (style.display === "none") {
		return;
	}
	paintBox(painter, style, [rect], rect, ctx);
	if (style.visible) {
		renderOutsideMarker(painter, element, style, rect, ctx);
	}
	paintCaret(painter, element, style, ctx);

	paintContent(painter, element, style, rect, ctx, (origin) => {
		if (leaf.breakResult) {
			const model = leaf.boxModel;
			paintLines(
				painter,
				leaf.breakResult,
				flowContent(element),
				element,
				element,
				{
					x: origin.x + model.paddingLeft + model.borderLeftWidth,
					y: origin.y + model.paddingTop + model.borderTopWidth,
				},
				ctx,
			);
		}
	});
	paintOutline(painter, element, style, rect, ctx);
}

function resolveRun(
	painter: Painter,
	lines: BreakResult,
	container: Element,
	alignContainer: Element,
	origin: Origin,
): PainterRun {
	const run: PainterRun = {
		texts: new Map(),
		boxes: new Map(),
		leaves: new Map(),
	};
	const boxLines = new Map<Element, Map<number, Rect>>();
	const shifts = new Map<Node, Origin>();
	const getShift = (node: Node): Origin => {
		let shift = shifts.get(node);
		if (shift === undefined) {
			shift = {x: 0, y: 0};
			for (
				let ancestor = node.nodeType === node.ELEMENT_NODE
					? (node as Element)
					: flatParentElement(node);
				ancestor !== null && ancestor !== container;
				ancestor = flatParentElement(ancestor)
			) {
				const style = getPaintStyle(painter, ancestor);
				shift.x += style.shiftX;
				shift.y += style.shiftY;
			}
			shifts.set(node, shift);
		}
		return shift;
	};
	const first = lines.lines[0];
	for (const line of lines.lines) {
		const alignOffset = getLineAlignOffset(
			alignContainer,
			lines.containerWidth,
			line.width,
		);
		const indent = getLineIndent(
			line === first,
			alignContainer,
			lines.containerWidth,
		);
		const lineX = origin.x + alignOffset + indent;
		const lineY = origin.y + line.y;
		const textSpans = new Map<
			Text,
			{
				left: number;
				right: number;
				start: number;
				end: number;
				visualBase: "ltr" | "rtl" | null;
			}
		>();
		for (const segment of line.segments) {
			const {leaf} = segment;
			if (leaf.type === "text") {
				const span = textSpans.get(leaf.node);
				const left = lineX + segment.x;
				const right = left + segment.width;
				if (span === undefined) {
					textSpans.set(leaf.node, {
						left,
						right,
						start: segment.dataStart,
						end: segment.dataEnd,
						visualBase: segment.visualBase,
					});
				} else {
					span.left = Math.min(span.left, left);
					span.right = Math.max(span.right, right);
					span.end = segment.dataEnd;
				}
			} else if (leaf.type === "inline-block") {
				const shift = getShift(leaf.node);
				const rect = {
					left: lineX + segment.x + shift.x,
					top: lineY + shift.y,
					width: segment.width,
					height: line.height,
				};
				run.leaves.set(leaf.node, {rect, leaf});
				coverAncestors(boxLines, leaf.node, container, lineY, rect);
			}
		}
		for (const [textNode, span] of textSpans) {
			const shift = getShift(textNode);
			const rect = {
				left: span.left + shift.x,
				top: lineY + shift.y,
				width: span.right - span.left,
				height: line.height,
			};
			let fragments = run.texts.get(textNode);
			if (fragments === undefined) {
				run.texts.set(textNode, (fragments = []));
			}
			fragments.push({
				rect,
				startOffset: span.start,
				endOffset: span.end,
				visualBase: span.visualBase,
			});
			coverAncestors(boxLines, textNode, container, lineY, rect);
		}
	}
	for (const [element, byLine] of boxLines) {
		run.boxes.set(element, [...byLine.values()]);
	}
	return run;
}

function coverAncestors(
	boxLines: Map<Element, Map<number, Rect>>,
	node: Node,
	container: Element,
	lineY: number,
	rect: Rect,
): void {
	for (
		let ancestor = flatParentElement(node);
		ancestor !== null && ancestor !== container;
		ancestor = flatParentElement(ancestor)
	) {
		let byLine = boxLines.get(ancestor);
		if (byLine === undefined) {
			boxLines.set(ancestor, (byLine = new Map()));
		}
		const known = byLine.get(lineY);
		if (known === undefined) {
			byLine.set(lineY, {...rect});
		} else {
			const left = Math.min(known.left, rect.left);
			const right = Math.max(known.left + known.width, rect.left + rect.width);
			known.left = left;
			known.width = right - left;
		}
	}
}

function paintText(
	painter: Painter,
	textNode: Text,
	run: PainterRun,
	ctx: CellContext,
): void {
	const fragments = run.texts.get(textNode);
	if (fragments === undefined || !textNode.data) {
		return;
	}
	// The flat-tree parent. Slotted text inherits through the slot, not
	// the host.
	const parentElement = flatParentElement(textNode);
	if (!parentElement) {
		return;
	}
	const style = getPaintStyle(painter, parentElement);
	if (!style.visible) {
		return;
	}
	let painted = false;
	for (const fragment of fragments) {
		if (fragment.endOffset <= fragment.startOffset) {
			continue;
		}
		const text = renderTextFragment(
			textNode.data,
			style.whiteSpace,
			fragment.startOffset,
			fragment.endOffset,
			fragment.visualBase,
		);
		if (!text) {
			continue;
		}
		painted = true;
		ctx.drawText(
			applyTextTransform(text, style.textTransform),
			Math.round(fragment.rect.left),
			Math.round(fragment.rect.top),
			style.cell,
		);
	}
	if (painted) {
		renderTextHighlights(
			painter,
			textNode,
			style.cell,
			style.textTransform,
			ctx,
		);
	}
}

function renderOutsideMarker(
	painter: Painter,
	element: Element,
	style: PaintStyle,
	rect: Rect,
	ctx: CellContext,
): void {
	if (style.display !== "list-item") {
		return;
	}

	const listStylePosition =
		getComputedValue(element, "list-style-position") || "outside";

	if (listStylePosition !== "outside") {
		return;
	}

	if (painter[kRenderedOutsideMarkers].has(element)) {
		return;
	}
	painter[kRenderedOutsideMarkers].add(element);

	const markerContent = painter[kCascade].getMarkerContent(element);
	if (!markerContent) {
		return;
	}

	// Cells, not code units. "日本 " is 3 characters and 5 cells.
	const markerWidth = ctx.measureText(markerContent).width;

	const markerColor =
		getComputedValue(element, "color", "::marker") ||
		getComputedValue(element, "color");
	const {bold: markerBold, dim: markerDim} = resolveFontWeight(
		getComputedValue(element, "font-weight", "::marker"),
	);
	const markerItalic =
		getComputedValue(element, "font-style", "::marker") === "italic";
	const markerUnderline = CSSValues.parseTextDecorationLine(
		getComputedValue(element, "text-decoration-line", "::marker"),
	).underline;

	const markerTextStyle = {
		fg: markerColor && markerColor !== "initial"
			? CSSValues.cssColorToNumber(markerColor)
			: undefined,
		bold: markerBold,
		dim: markerDim,
		italic: markerItalic,
		underline: markerUnderline,
	};

	// Outside the content box, as css-lists-3 §3.3 places it. A marker
	// that would start before the first column is clipped away whole,
	// as a browser clips it at the viewport.
	const model = getBoxModel(element);
	const markerX =
		Math.round(rect.left + model.borderLeftWidth + model.paddingLeft) -
		markerWidth;
	if (markerX < 0) {
		return;
	}
	ctx.drawText(markerContent, markerX, Math.round(rect.top), markerTextStyle);
}

// A focused editing host parks the cursor at the document selection's
// focus, the way a focused text control parks it at its own.
function renderEditingCaret(
	painter: Painter,
	element: Element,
	ctx: CellContext,
): void {
	const point = getEditingCaretPoint(painter[kDocument]);
	if (point === null || !element.contains(point.node)) {
		return;
	}
	const rect = painter[kLayout].getCaretRect(point.node, point.offset);
	if (rect !== null) {
		ctx.setCaret(Math.round(rect.x), Math.round(rect.y));
		return;
	}
	const box = point.node.nodeType === point.node.ELEMENT_NODE
		? (point.node as Element)
		: (flatParentElement(point.node) ?? element);
	const content = painter[kLayout].contentRect(box);
	if (content) {
		ctx.setCaret(Math.round(content.x), Math.round(content.y));
	}
}

// The context root's clip intersected with the overflow of the
// positioned ancestors only. A non-positioned overflow ancestor does not
// contain the box.
function getPositionedClip(
	painter: Painter,
	element: Element,
	contextRoot: Element,
	contextClip: ClipRect | null,
): ClipRect | null {
	let clip = contextClip;
	for (
		let ancestor = flatParentElement(element);
		ancestor && ancestor !== contextRoot;
		ancestor = flatParentElement(ancestor)
	) {
		if (!isPositioned(ancestor)) {
			continue;
		}
		const overflow = getComputedValue(ancestor, "overflow");
		const overflowX = getComputedValue(ancestor, "overflow-x") || overflow;
		const overflowY = getComputedValue(ancestor, "overflow-y") || overflow;
		if (isClippingOverflow(overflowX) || isClippingOverflow(overflowY)) {
			const rect = painter[kLayout].getRect(ancestor);
			if (rect) {
				clip = getOverflowClipRect(ancestor, rect, overflowX, overflowY, clip);
			}
		}
	}
	return clip;
}

function getGlyphText(element: Element): Text | null {
	const root = getShadowRoot(element);
	const glyph = root ? root.querySelector('[part="glyph"]') : null;
	return (glyph?.firstChild as Text | null) ?? null;
}

// A focused control's own selection when the node renders its value
// (the document selection cannot see inside a control), else the
// document's, narrowed to this node's offsets.
function getPaintSelectionRange(
	painter: Painter,
	textNode: Text,
): {from: number; to: number; selectionParent: Element} | null {
	const textControl = getTextControlSelectionRange(
		painter[kDocument],
		textNode,
	);
	if (textControl) {
		const {range} = textControl;
		if (range.endOffset <= range.startOffset) {
			return null;
		}
		// ::selection resolves on the text control, not the shadow value span.
		return {
			from: range.startOffset,
			to: range.endOffset,
			selectionParent: textControl.textControl,
		};
	}

	const selection = painter[kWindow].getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return null;
	}
	const documentRange = selection.getRangeAt(0);
	if (!documentRange.intersectsNode(textNode)) {
		return null;
	}
	const selectionParent = flatParentElement(textNode);
	if (!selectionParent) {
		return null;
	}
	if (!painter[kCascade].isSelectable(selectionParent)) {
		return null;
	}
	// ::selection resolves per parent.
	const from = documentRange.startContainer === textNode
		? documentRange.startOffset
		: 0;
	const to = documentRange.endContainer === textNode
		? documentRange.endOffset
		: textNode.data.length;
	if (to <= from) {
		return null;
	}
	return {from, to, selectionParent};
}

/**
 * What a `::highlight()` rule can change about a cell. A property it does
 * not declare is absent here, so the layer under it shows through.
 */
interface HighlightPaint {
	fg?: number;
	bg?: number;
	inverse?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
}

/**
 * What `::highlight(name)` paints on this element, each property taken
 * from the nearest flat-tree ancestor whose rules declare it. Null when
 * none of them do, since an unstyled name paints nothing.
 */
function readHighlightStyle(
	painter: Painter,
	element: Element,
	name: string,
): HighlightPaint | null {
	const pseudo = `::highlight(${name})`;
	const declared = painter[kCascade].declaredPseudoProperties(element, pseudo);
	const parent = flatParentElement(element);
	const inherited = parent === null
		? null
		: getHighlightStyle(painter, parent, name);
	if (declared.size === 0) {
		return inherited;
	}
	const paint: HighlightPaint = {...inherited};
	if (declared.has("color")) {
		const color = getComputedValue(element, "color", pseudo);
		paint.fg = color && !CSSValues.isHighlightColor(color)
			? CSSValues.cssColorToNumber(color)
			: undefined;
	}
	if (declared.has("background-color")) {
		const background = getComputedValue(element, "background-color", pseudo);
		paint.bg = undefined;
		paint.inverse = undefined;
		if (CSSValues.isHighlightColor(background)) {
			paint.inverse = true;
		} else if (
			background &&
			!CSSValues.isTransparentColor(background) &&
			!CSSValues.isCanvasColor(background)
		) {
			paint.bg = CSSValues.cssColorToNumber(background);
		}
	}
	if (declared.has("text-decoration-line")) {
		const decoration = CSSValues.parseTextDecorationLine(
			getComputedValue(element, "text-decoration-line", pseudo),
		);
		paint.underline = decoration.underline || undefined;
		paint.strikethrough = decoration.lineThrough || undefined;
	}
	return paint;
}

// Everything comes from ::selection rules. The UA sheet's Highlight
// pair is what makes an unstyled selection inverse at all, and an
// author color of either half means the terminal's inverse is not what
// the author asked for.
function readSelectionStyle(element: Element): HighlightPaint | null {
	const fg = getComputedValue(element, "color", "::selection");
	const bg = getComputedValue(element, "background-color", "::selection");
	const decoration = CSSValues.parseTextDecorationLine(
		getComputedValue(element, "text-decoration-line", "::selection"),
	);
	const paint: HighlightPaint = {};
	if (decoration.underline) {
		paint.underline = true;
	}
	if (decoration.lineThrough) {
		paint.strikethrough = true;
	}
	if (!fg && !bg) {
		return paint.underline || paint.strikethrough ? paint : null;
	}
	const fgAuthored = Boolean(fg) && !CSSValues.isHighlightColor(fg);
	const bgAuthored = Boolean(bg) && !CSSValues.isHighlightColor(bg);
	if (!fgAuthored && !bgAuthored) {
		paint.inverse = true;
		return paint;
	}
	if (fgAuthored) {
		paint.fg = CSSValues.cssColorToNumber(fg);
	}
	if (bgAuthored) {
		paint.bg = CSSValues.cssColorToNumber(bg);
	}
	return paint;
}

// Per element and name, for the frame. A highlight over many text nodes
// resolves its style on the few elements they share.
function getHighlightStyle(
	painter: Painter,
	element: Element,
	name: string,
): HighlightPaint | null {
	let byName = painter[kHighlightStyles].get(element);
	if (byName === undefined) {
		byName = new Map<string, HighlightPaint | null>();
		painter[kHighlightStyles].set(element, byName);
	}
	let paint = byName.get(name);
	if (paint === undefined) {
		paint = readHighlightStyle(painter, element, name);
		byName.set(name, paint);
	}
	return paint;
}

/**
 * One highlight layer over the style under it. A background of the
 * layer's own is the whole background, so it turns off the inverse under
 * it, which would otherwise swap the colors this layer named.
 */
function foldHighlight(base: CellStyle, paint: HighlightPaint): CellStyle {
	return {
		...base,
		fg: paint.fg ?? base.fg,
		bg: paint.bg ?? base.bg,
		inverse: paint.inverse ?? (paint.bg === undefined ? base.inverse : false),
		underline: paint.underline || base.underline,
		strikethrough: paint.strikethrough || base.strikethrough,
	};
}

interface HighlightLayer {
	from: number;
	to: number;
	paint: HighlightPaint;
}

// The offsets where the covering layers change, so each run of cells
// every layer agrees on is drawn once rather than once per layer.
function getHighlightSegments(
	layers: HighlightLayer[],
): Array<[number, number]> {
	const edges =
		[...new Set(layers.flatMap((layer) => [layer.from, layer.to]))].sort(
			(a, b) => a - b,
		);
	const segments: Array<[number, number]> = [];
	for (let i = 0; i + 1 < edges.length; i++) {
		const covered = layers.some(
			(layer) => layer.from <= edges[i] && layer.to >= edges[i + 1],
		);
		if (covered) {
			segments.push([edges[i], edges[i + 1]]);
		}
	}
	return segments;
}

// Every text node a registered highlight covers, in the order the
// painter folds the styles in. Built once a frame: a text node with no
// entry here has no highlight over it.
function collectHighlightedText(document: Document): Map<Text, HighlightRun[]> {
	const highlighted = new Map<Text, HighlightRun[]>();
	for (const highlight of getPaintedHighlights(document)) {
		for (const range of highlight.ranges) {
			for (const {textNode, from, to} of getHighlightedTextNodes(range)) {
				const run = {name: highlight.name, from, to};
				const runs = highlighted.get(textNode);
				if (runs === undefined) {
					highlighted.set(textNode, [run]);
				} else {
					runs.push(run);
				}
			}
		}
	}
	return highlighted;
}

// Redraws the highlighted runs over the base pass, one draw per run of
// cells the same layers cover, the selection included.
function renderTextHighlights(
	painter: Painter,
	textNode: Text,
	textStyle: CellStyle,
	textTransform: string,
	ctx: CellContext,
): void {
	const layers: HighlightLayer[] = [];
	const parent = flatParentElement(textNode);
	const runs = painter[kHighlightedText].get(textNode);
	if (parent !== null && runs !== undefined) {
		for (const run of runs) {
			const paint = getHighlightStyle(painter, parent, run.name);
			if (paint !== null) {
				layers.push({
					...painter[kLayout].snapToClusters(textNode, run.from, run.to),
					paint,
				});
			}
		}
	}
	const selected = getPaintSelectionRange(painter, textNode);
	if (selected !== null) {
		const paint = readSelectionStyle(selected.selectionParent);
		if (paint !== null) {
			layers.push({
				...painter[kLayout].snapToClusters(
					textNode,
					selected.from,
					selected.to,
				),
				paint,
			});
		}
	}
	if (layers.length === 0) {
		return;
	}
	for (const [from, to] of getHighlightSegments(layers)) {
		let style = textStyle;
		for (const layer of layers) {
			if (layer.from <= from && layer.to >= to) {
				style = foldHighlight(style, layer.paint);
			}
		}
		if (style === textStyle) {
			continue;
		}
		for (const run of painter[kLayout].getTextSpans(textNode, from, to)) {
			ctx.drawText(
				applyTextTransform(run.text, textTransform),
				run.rect.x,
				run.rect.y,
				style,
			);
		}
	}
}
