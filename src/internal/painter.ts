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
import {
	isPositioned,
	isStackingContext,
	type Layout,
	renderTextFragment,
} from "./layout.ts";
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

function getCellStyle(element: Element): CellStyle {
	const color = getComputedValue(element, "color");
	const bgColor = getComputedValue(element, "background-color");
	const decoration = CSSValues.parseTextDecorationLine(
		getComputedValue(element, "text-decoration-line"),
	);
	const {bold, dim} = resolveFontWeight(
		getComputedValue(element, "font-weight"),
	);
	// The background alone carries inverse. color: HighlightText alone
	// resolves to nothing, so an author color does not defeat it.
	const isHighlightPair = CSSValues.isHighlightColor(bgColor);
	// A gradient gives every cell its own background, so naming one here
	// would repaint the run flat under the text. An undefined background
	// leaves each cell the color the gradient put there.
	const isGradientBox = getGradient(element) !== null;
	return {
		fg: color && color !== "initial" && !CSSValues.isHighlightColor(color)
			? CSSValues.cssColorToNumber(color)
			: undefined,
		bg:
			!isGradientBox &&
			bgColor &&
			bgColor !== "initial" &&
			!CSSValues.isTransparentColor(bgColor) &&
			!CSSValues.isCanvasColor(bgColor) &&
			!CSSValues.isHighlightColor(bgColor)
				? CSSValues.cssColorToNumber(bgColor)
				: undefined,
		inverse: isHighlightPair || undefined,
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

/** One registered highlight's share of one text node, in paint order. */
interface HighlightRun {
	name: string;
	from: number;
	to: number;
}

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

/** Reads the DOM, styles and geometry. Writes only into the CellContext. */
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

function renderElement(
	painter: Painter,
	element: Element,
	ctx: CellContext,
	afterOwnBox?: () => void,
): void {
	// A subtree wholly outside the viewport would be styled, shaped
	// and drawn, then discarded cell by cell.
	const scrolledRows = painter[kScrolledRows];
	let viewportTop = -ctx.viewportOffset + scrolledRows;
	let viewportBottom = viewportTop + ctx.rows;
	if (
		painter[kLayout].isSubtreeOutsideViewport(
			element,
			viewportTop,
			viewportBottom,
		)
	) {
		return;
	}

	// Stray run state under a hidden subtree would ghost-paint at whatever
	// coordinates it last held.
	if (getComputedValue(element, "display") === "none") {
		return;
	}

	const rect = painter[kLayout].getRect(element);

	const color = getComputedValue(element, "color");
	const backgroundColor = getComputedValue(element, "background-color");
	const visible = getComputedValue(element, "visibility") !== "hidden";

	// Canvas clears the box to the terminal's default background, opaque in
	// every theme. Highlight fills it with inverse.
	const isCanvasBg =
		Boolean(backgroundColor) && CSSValues.isCanvasColor(backgroundColor);
	const isHighlightBox =
		Boolean(backgroundColor) && CSSValues.isHighlightColor(backgroundColor);
	const style = {
		fg: color && color !== "initial" && !CSSValues.isHighlightColor(color)
			? CSSValues.cssColorToNumber(color)
			: undefined,
		bg:
			backgroundColor &&
			!isCanvasBg &&
			backgroundColor !== "initial" &&
			!CSSValues.isTransparentColor(backgroundColor) &&
			!CSSValues.isHighlightColor(backgroundColor)
				? CSSValues.cssColorToNumber(backgroundColor)
				: undefined,
	};

	if (rect && visible && (style.bg != null || isCanvasBg || isHighlightBox)) {
		const fill = isCanvasBg ? "default" : isHighlightBox ? "inverse" : style.bg;
		// A box broken across lines fills each fragment, not the rectangle
		// enclosing them, whose ends belong to its neighbours.
		const fragments = painter[kLayout].getRects(element);
		if (fragments.length > 1) {
			for (const fragment of fragments) {
				ctx.drawRect(
					fragment.left,
					fragment.top,
					fragment.width,
					fragment.height,
					fill,
				);
			}
		} else {
			ctx.drawRect(rect.left, rect.top, rect.width, rect.height, fill);
		}
	}

	// Over the flat fill, which a transparent stop composites onto.
	const gradient = rect && visible ? getGradient(element) : null;
	if (rect && gradient !== null) {
		const layout = painter[kLayout];
		const cell = layout.cellPixels;
		const fragments = layout.getRects(element);
		for (const fragment of fragments.length > 1 ? fragments : [rect]) {
			renderGradient(
				ctx,
				gradient,
				fragment,
				style.bg ?? null,
				cell.height / cell.width,
			);
		}
	}

	if (rect && visible) {
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
						: style.fg,
			};
		};
		const top = sideFor(sides.top, "border-top-color");
		const borderRight = sideFor(sides.right, "border-right-color");
		const bottom = sideFor(sides.bottom, "border-bottom-color");
		const left = sideFor(sides.left, "border-left-color");
		if (top || borderRight || bottom || left) {
			ctx.drawBox(
				Math.round(rect.left),
				Math.round(rect.top),
				Math.round(rect.width),
				Math.round(rect.height),
				{
					top,
					right: borderRight,
					bottom,
					left,
					topLeft: sides.topLeft,
					topRight: sides.topRight,
					bottomRight: sides.bottomRight,
					bottomLeft: sides.bottomLeft,
				},
			);
		}
	}

	if (visible) {
		renderOutsideMarker(painter, element, ctx);
	}

	// The active element shows the terminal cursor at its selection focus.
	// The content origin is used when the focus has no box.
	if (rect && visible && element === painter[kDocument].activeElement) {
		const record = getSelectionRecord(element);
		if (record !== null) {
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
	}

	// The negative-z layer goes here, after the box and before its content.
	if (afterOwnBox) {
		afterOwnBox();
	}

	// The element's own scroll shifts its children, not itself. The
	// document roots' scrollTop is the document scroll, applied at
	// ctx.viewportOffset.
	const ownScrolledRows =
		element === painter[kDocument].body ||
		element === painter[kDocument].documentElement
			? 0
			: element.scrollTop || 0;
	viewportTop += ownScrolledRows;
	viewportBottom += ownScrolledRows;

	const children: Node[] = [];

	// For a plain vertical stack the layout tree knows which children are
	// in the viewport. The walk below costs every sibling.
	const fastChildren = painter[kLayout].getVisibleChildren(
		element,
		viewportTop,
		viewportBottom,
	);
	if (fastChildren) {
		for (const childNode of fastChildren) {
			children.push(childNode);
		}
	} else {
		for (const childNode of flowContent(element)) {
			// Before any style read. A child outside the viewport costs one
			// lookup.
			if (
				childNode.nodeType === childNode.ELEMENT_NODE &&
				painter[kLayout].isSubtreeOutsideViewport(
					childNode as Element,
					viewportTop,
					viewportBottom,
				)
			) {
				continue;
			}
			if (
				childNode.nodeType === childNode.ELEMENT_NODE &&
				painter[kLayout].hoistedToLayer(childNode as Element)
			) {
				continue;
			}
			children.push(childNode);
		}
	}

	// Overflow clips descendants, never the element's own box.
	const overflow = getComputedValue(element, "overflow");
	const overflowX = getComputedValue(element, "overflow-x") || overflow;
	const overflowY = getComputedValue(element, "overflow-y") || overflow;
	const previousClip = ctx.clipRect;
	ctx.clipRect = getOverflowClipRect(
		element,
		rect,
		overflowX,
		overflowY,
		previousClip,
	);
	painter[kScrolledRows] = scrolledRows + ownScrolledRows;

	try {
		for (const childNode of children) {
			if (childNode.nodeType === childNode.ELEMENT_NODE) {
				const childElement = childNode as Element;
				if (childElement instanceof HTMLElement) {
					renderElement(painter, childElement, ctx);
				}
			} else if (childNode.nodeType === childNode.TEXT_NODE) {
				const textNode = childNode as Text;
				renderText(painter, textNode, ctx);
			}
		}
	} finally {
		ctx.clipRect = previousClip;
		painter[kScrolledRows] = scrolledRows;
	}

	// An outline repaints a bordered box's ring in its color. A borderless
	// box gets an underline along its bottom row. Overline (SGR 53) is
	// unreliable.
	if (rect && visible) {
		const outlineStyle = getComputedValue(element, "outline-style");
		if (
			outlineStyle &&
			outlineStyle !== "none" &&
			CSSValues.parseBorderWidthValue(
				getComputedValue(element, "outline-width"),
			) !== 0
		) {
			const outlineColor = getComputedValue(element, "outline-color")
				.trim()
				.toLowerCase();
			const hasColor =
				Boolean(outlineColor) &&
				outlineColor !== "auto" &&
				outlineColor !== "currentcolor" &&
				outlineColor !== "invert" &&
				!CSSValues.isHighlightColor(outlineColor);
			// `auto`, the initial value and what `outline: 1px solid` leaves,
			// takes the element's own color, as a border's currentcolor does.
			const color = hasColor
				? CSSValues.cssColorToNumber(outlineColor)
				: style.fg;
			const sides = resolveBorderSides(element);
			if (sides.top || sides.right || sides.bottom || sides.left) {
				const ring = (
					line: LineStyle["style"] | undefined,
				): LineStyle | undefined => line && {style: line, color};
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
					Math.round(rect.bottom) - 1,
					Math.round(rect.width),
					{underline: true, fg: color},
				);
			}
		}
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
		renderElement(painter, root, ctx);
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
				renderElement(painter, element, ctx);
			}
		} finally {
			ctx.clipRect = previousClip;
			ctx.viewportOffset = previousOffset;
			painter[kScrolledRows] = previousScrolled;
		}
	};
	renderElement(painter, root, ctx, () => {
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

function renderOutsideMarker(
	painter: Painter,
	element: Element,
	ctx: CellContext,
): void {
	const display = getComputedValue(element, "display");

	if (display !== "list-item") {
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

	const rect = painter[kLayout].getRect(element);
	if (!rect) {
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
	const content = painter[kLayout].contentRect(element) ?? rect;
	const markerX = Math.round(content.left) - markerWidth;
	if (markerX < 0) {
		return;
	}
	ctx.drawText(markerContent, markerX, Math.round(rect.top), markerTextStyle);
}

function getGlyphText(element: Element): Text | null {
	const root = getShadowRoot(element);
	const glyph = root ? root.querySelector('[part="glyph"]') : null;
	return (glyph?.firstChild as Text | null) ?? null;
}

function renderText(painter: Painter, textNode: Text, ctx: CellContext): void {
	const textContent = textNode.data;
	if (!textContent) {
		return;
	}

	// The flat-tree parent. Slotted text inherits through the slot, not
	// the host.
	const parentElement = flatParentElement(textNode);
	if (!parentElement) {
		return;
	}

	if (getComputedValue(parentElement, "visibility") === "hidden") {
		return;
	}

	const textTransform = getComputedValue(parentElement, "text-transform");
	const textStyle = getCellStyle(parentElement);

	// One fragment per line, each naming the range of `data` it renders.
	// The characters come from the node under its own white-space.
	const whiteSpace = getComputedValue(parentElement, "white-space");
	const fragments = painter[kLayout].lineFragments(textNode);
	let painted = false;
	for (const fragment of fragments) {
		if (fragment.endOffset <= fragment.startOffset) {
			continue;
		}
		const text = renderTextFragment(
			textContent,
			whiteSpace,
			fragment.startOffset,
			fragment.endOffset,
			fragment.visualBase,
		);
		if (!text) {
			continue;
		}
		painted = true;
		ctx.drawText(
			applyTextTransform(text, textTransform),
			Math.round(fragment.rect.x),
			Math.round(fragment.rect.y),
			textStyle,
		);
	}
	if (painted) {
		renderTextHighlights(painter, textNode, textStyle, textTransform, ctx);
	}
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
