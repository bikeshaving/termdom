import {
	type Cascade,
	declaredPseudoProperties,
	getBoxModel,
	getCellBorderWidths,
	getComputedValue,
	getDeclaredDisplay,
	getMarkerContent,
	getTabSize,
	getUsedOverflow,
	getWhiteSpace,
	resolveBorderSides,
	resolveLength,
	toCellLength,
} from "./cssom.ts";
import * as CSSValues from "./cssvalues.ts";
import {
	flatParentElement,
	flowContent,
	getCanvasTextRuns,
	getFocusedElement,
	getHighlightedTextNodes,
	getPaintedHighlights,
	getScrollOffset,
	getSelectionRecord,
	getShadowRoot,
	getTextControlSelectionRange,
	getTextControlValueText,
	getTopLayer,
	hasPaintedHighlights,
	HTMLElement,
	renderedTopLayer,
	takesTextCursor,
	type Window,
} from "./dom.ts";
import {getEditingCaretPoint} from "./editing.ts";
import {
	CellContext,
	CellGrid,
	type CellStyle,
	drawBox,
	drawDecoration,
	drawRect,
	drawText,
	type Framebuffer,
	insetShiftPays,
	keptCaret,
	type LineStyle,
	setCaret,
} from "./framebuffer.ts";
import {
	type Gradient,
	parseLinearGradient,
	renderGradient,
	resolveGradientLengths,
} from "./gradients.ts";
import {
	applyTextTransform,
	type Box,
	type BreakResult,
	collectStackingLayers,
	type Display,
	fullWidthFixedRows,
	getExtentFrame,
	getLayoutNode,
	getLineAlignOffset,
	getLineIndent,
	getMathBox,
	getOverflowClipRect,
	getPositionedClip,
	getRun,
	hasItemParent,
	hoistedToLayer,
	type InlineBlockLeaf,
	isAtomicInline,
	isStackingContext,
	type Layout,
	paintExtent,
	renderTextFragment,
	scrolledAncestorRows,
	snapToClusters,
} from "./layout.ts";
import {
	getComputedHeight,
	getComputedWidth,
	type LayoutNode,
} from "./layoutsolver.ts";
import {
	getMathAlignOffset,
	isBlankCell,
	isMathRoot,
	type MathCell,
} from "./mathml.ts";
import {isReplacedBox, renderReplaced} from "./replaced.ts";
import {getStringWidth} from "./text.ts";
import {getNodeType, nodeContains} from "./tree.ts";
import {getCellSize} from "./units.ts";

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
	return CSSValues.numberFromCSSColor(value);
}

function getGradient(element: Element): Gradient | null {
	const image = getComputedValue(element, "background-image");
	const gradient = image && image !== "none"
		? parseLinearGradient(image)
		: null;
	return gradient &&
		resolveGradientLengths(gradient, (length, unit, vertical) =>
			resolveLength(element, length, unit, vertical),
		);
}

const paintStyles = new WeakMap<object, PaintStyle>();

interface PaintStyle {
	display: string;
	visible: boolean;
	fg: number | undefined;
	bg: number | undefined;
	fill: number | "default" | "inverse" | null;
	gradient: Gradient | null;
	border: BorderPaint | null;
	outlineColor: number | undefined | null;
	overflowX: string;
	overflowY: string;
	textTransform: string;
	whiteSpace: string;
	tabSize: number;
	cell: CellStyle;
	shiftX: number;
	shiftY: number;
	contentInsetX: number;
	contentInsetY: number;
	// What else the painter reads from the element's style, so two paint
	// styles that match paint alike.
	others: string;
	// The counters the element sets, which number markers and content
	// after it, not its own cells.
	counters: string;
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

const PAINTED_ELSEWHERE = [
	"z-index",
	"position",
	"text-overflow",
	"list-style-type",
	"list-style-position",
	"list-style-image",
	"outline-offset",
	"caret-color",
	"direction",
	"text-align",
	"text-indent",
];

/**
 * Whether the element paints as it did under the style key it had, so a
 * restyle that changed nothing it draws repaints no rows. False when the
 * old style was never painted to compare, and "whole" when its counters
 * changed, which renumber what comes after it.
 */
export function paintsAsBefore(
	painter: Painter,
	element: Element,
	key: object,
): boolean | "whole" {
	const before = paintStyles.get(key);
	if (before === undefined || painter.cascade.getStyleKey(element) === null) {
		return false;
	}
	const after = getPaintStyle(painter, element);
	if (before.counters !== after.counters) {
		return "whole";
	}
	return JSON.stringify(before) === JSON.stringify(after);
}

function readPaintStyle(element: Element): PaintStyle {
	const color = getComputedValue(element, "color");
	const backgroundColor = getComputedValue(element, "background-color");
	const fg = color && color !== "initial" && !CSSValues.isHighlightColor(color)
		? CSSValues.numberFromCSSColor(color)
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
			? CSSValues.numberFromCSSColor(backgroundColor)
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
					? CSSValues.numberFromCSSColor(borderColor)
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
	// box gets an overline along its top row and an underline along its
	// bottom row.
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
		outlineColor = hasColor ? CSSValues.numberFromCSSColor(outline) : fg;
	}
	let shiftX = 0;
	let shiftY = 0;
	if (getComputedValue(element, "position") === "relative") {
		const left = toCellLength(
			CSSValues.parseSignedUnitValue(getComputedValue(element, "left")),
			false,
			element,
		);
		const top = toCellLength(
			CSSValues.parseSignedUnitValue(getComputedValue(element, "top")),
			true,
			element,
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
		others: PAINTED_ELSEWHERE.map((property) =>
			getComputedValue(element, property),
		).join("\0"),
		counters: ["counter-reset", "counter-increment", "counter-set"]
			.map((property) => getComputedValue(element, property))
			.join("\0"),
		// Whole cells, as layout rounds the content edge.
		contentInsetX: Math.round(model.paddingLeft + model.borderLeftWidth),
		contentInsetY: Math.round(model.paddingTop + model.borderTopWidth),
		display: getDeclaredDisplay(element),
		visible: getComputedValue(element, "visibility") !== "hidden",
		fg,
		bg,
		fill,
		gradient,
		border: border.top || border.right || border.bottom || border.left
			? border
			: null,
		outlineColor,
		overflowX: getUsedOverflow(element, "x"),
		overflowY: getUsedOverflow(element, "y"),
		textTransform: getComputedValue(element, "text-transform"),
		whiteSpace: getWhiteSpace(element),
		tabSize: getTabSize(element),
		shiftX,
		shiftY,
		cell: {
			fg,
			// A gradient gives every cell its own background, so naming one
			// here would repaint the run flat under the text. An undefined
			// background leaves each cell the color the gradient put there.
			// A translucent one is blended once, by the fill, and the text
			// sits on what that left.
			bg:
				gradient === null &&
				(bg === undefined || bg < CSSValues.TRANSPARENCY_UNIT)
					? bg
					: undefined,
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
	column: number;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
}

// The spaces a line hangs past its end are in the fragment's data, for the
// caret, but not in its rect, and drawing them would cover what lies past
// the box. Right to left, the end of the line is its left.
function withoutHangingSpaces(text: string, fragment: TextFragment): string {
	let excess = getStringWidth(text) - Math.round(fragment.rect.width);
	if (fragment.visualBase === "rtl") {
		let start = 0;
		while (excess > 0 && text[start] === " ") {
			start++;
			excess--;
		}
		return text.slice(start);
	}
	let end = text.length;
	while (excess > 0 && text[end - 1] === " ") {
		end--;
		excess--;
	}
	return text.slice(0, end);
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

export class Painter {
	window: Window;
	document: Document;
	layout: Layout;
	cascade: Cascade;
	framebuffer: Framebuffer;
	topLayer: Set<Element>;
	// Each list marker paints at most once per frame.
	renderedOutsideMarkers: WeakSet<Element>;
	// Paint extents are cached in unscrolled rows of a frame: the
	// document's, or an inline-block's own root's. The band is culled
	// against them in the frame being painted, which a scrolled subtree
	// paints this many rows higher than it counts.
	frame: LayoutNode;
	scrolledRows: number;
	highlightedText: Map<Text, HighlightRun[]>;
	highlightStyles: Map<Element, Map<string, HighlightPaint | null>>;
	// Where this frame painted each text, for the overflow markers drawn
	// after it, which would otherwise ask layout to place it again.
	paintedText: Map<Text, TextFragment[]>;

	constructor(
		document: Document,
		layout: Layout,
		cascade: Cascade,
		framebuffer: Framebuffer,
	) {
		this.renderedOutsideMarkers = new WeakSet<Element>();
		this.frame = layout.initialBlock;
		this.scrolledRows = 0;
		this.highlightedText = new Map();
		this.highlightStyles = new Map();
		this.paintedText = new Map();
		this.window = document.defaultView as unknown as Window;
		this.document = document;
		this.layout = layout;
		this.cascade = cascade;
		this.framebuffer = framebuffer;
		this.topLayer = getTopLayer(document) as unknown as Set<Element>;
	}
}

/**
 * The buffer rows a journalled element scroll covers, or null when the
 * terminal cannot shift them. DECSTBM margins are horizontal, so a scroll
 * shift is the region's full width or nothing. Content overlapping the
 * shift is dragged along and the diff repairs it. A box narrower than the
 * terminal shifts only when repairing what lies beside it costs less than
 * repainting the box.
 */
export function resolveScrollShift(
	painter: Painter,
	regionHeight: number,
	record: {element: Element; delta: number} | null,
): {delta: number; top: number; end: number} | null {
	const framebuffer = painter.framebuffer;
	const layout = painter.layout;
	if (
		record === null ||
		record.delta === 0 ||
		// One scroll shift per frame. The document scroll's region already
		// contains this box.
		framebuffer.journal.frameScroll !== 0 ||
		hasPaintedHighlights(painter.document) ||
		!record.element.isConnected
	) {
		return null;
	}
	const rect = layout.getRect(record.element);
	if (rect === null) {
		return null;
	}

	// The scroll port is the padding box.
	const border = getCellBorderWidths(record.element);
	const left = rect.left + border.left;
	const right = rect.left + rect.width - border.right;

	// Layout rows are document rows. Buffer rows are the document
	// scroll's. A fixed box is laid out in viewport rows and the paint
	// cancels the document scroll for it.
	const lift = layout.isInFixedSpace(record.element)
		? 0
		: framebuffer.scrollTop;
	const top = Math.max(0, Math.round(rect.top + border.top) - lift);
	const end = Math.min(
		regionHeight,
		Math.round(rect.top + rect.height - border.bottom) - lift,
	);
	if (end - top <= Math.abs(record.delta)) {
		return null;
	}
	const delta = record.delta;
	if (
		(left > 0 || right < framebuffer.cols) &&
		!insetShiftPays(framebuffer, {delta, top, end, left, right})
	) {
		return null;
	}
	return {delta, top, end};
}

/**
 * The rows a document scroll shifts: the region, less the full-width
 * fixed bars at its top and bottom edges, which stay where they are on
 * screen. Null when no bar trims it.
 */
export function resolveDocumentScrollBand(
	painter: Painter,
	regionHeight: number,
	delta: number,
): {delta: number; top: number; end: number} | null {
	const bars = fullWidthFixedRows(painter.layout, painter.framebuffer.cols);
	if (bars.length === 0) {
		return null;
	}
	let top = 0;
	let end = regionHeight;
	for (let trimmed = true; trimmed;) {
		trimmed = false;
		for (const [barTop, barBottom] of bars) {
			if (barTop <= top && barBottom > top) {
				top = barBottom;
				trimmed = true;
			}
			if (barTop < end && barBottom >= end) {
				end = barTop;
				trimmed = true;
			}
		}
	}
	if ((top === 0 && end === regionHeight) || end - top <= Math.abs(delta)) {
		return null;
	}
	return {delta, top, end};
}

export function paint(painter: Painter, ctx: CellContext): void {
	painter.highlightedText = collectHighlightedText(painter.document);
	painter.paintedText.clear();
	painter.highlightStyles = new Map();
	const layers = collectStackingLayers(painter.layout, painter.topLayer);
	// From the body, the root stacking context's content. A body that
	// is inline, inline-block or display: contents puts its content in
	// the root element's boxes rather than its own, so painting starts
	// at the root.
	const document = painter.document;
	const bodyDisplay = getDeclaredDisplay(document.body as Element);
	const fromRoot =
		document.documentElement !== null &&
		(bodyDisplay === "contents" || bodyDisplay.startsWith("inline"));
	const root = (fromRoot ? document.documentElement : document.body) as Element;
	const rendered = renderedTopLayer(painter.document) as unknown as Element[];
	for (const [top, bottom] of ctx.bands) {
		ctx.bandTop = top;
		ctx.bandBottom = bottom;
		paintBand(painter, ctx, root, rendered, layers);
	}
}

/**
 * Checks a frame that repainted only some rows against one painted
 * whole, for tests. Set, a frame that differs throws, naming the cells,
 * and checked counts the frames compared.
 */
export const partialFrameCheck = {enabled: false, checked: 0};

export function checkPartialFrame(
	painter: Painter,
	ctx: CellContext,
	previousCaret: {col: number; row: number} | null,
): void {
	partialFrameCheck.checked++;
	const whole = new CellContext(
		new CellGrid(ctx.rows, ctx.cols),
		ctx.rows,
		ctx.cols,
		ctx.viewportOffset,
	);
	whole.backdrop = ctx.backdrop;
	paint(painter, whole);
	const differences: string[] = [];
	const a = ctx.grid;
	const b = whole.grid;
	for (let index = 0; index < a.cluster.length; index++) {
		if (
			a.cluster[index] !== b.cluster[index] ||
			a.fg[index] !== b.fg[index] ||
			a.bg[index] !== b.bg[index] ||
			a.attrs[index] !== b.attrs[index] ||
			a.border[index] !== b.border[index]
		) {
			differences.push(
				`row ${Math.floor(index / ctx.cols)} col ${index % ctx.cols}`,
			);
		}
	}
	const caret = keptCaret(ctx, previousCaret);
	if (JSON.stringify(caret) !== JSON.stringify(whole.caret)) {
		differences.push(
			`caret ${JSON.stringify(caret)}, whole ${JSON.stringify(whole.caret)}`,
		);
	}
	if (differences.length > 0) {
		throw new Error(
			`A frame repainting rows ${JSON.stringify(ctx.bands)} differs from ` +
				`a whole one at ${differences.slice(0, 8).join(", ")}`,
		);
	}
}

function paintBand(
	painter: Painter,
	ctx: CellContext,
	root: Element,
	rendered: Element[],
	layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
): void {
	painter.renderedOutsideMarkers = new WeakSet<Element>();
	painter.frame = painter.layout.initialBlock;
	painter.scrolledRows = 0;
	renderStackingContext(painter, root, ctx, layers);
	for (const element of rendered) {
		const previousClip = ctx.clipRect;
		ctx.clipRect = null;
		// Entered from outside its ancestor chain, so seed the culling
		// shift.
		painter.scrolledRows = scrolledAncestorRows(painter.layout, element);
		try {
			renderBackdrop(element, ctx);
			renderStackingContext(painter, element, ctx, layers);
		} finally {
			ctx.clipRect = previousClip;
			painter.scrolledRows = 0;
		}
	}
}

function getPaintStyle(painter: Painter, element: Element): PaintStyle {
	const key = painter.cascade.getStyleKey(element);
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
	drawRect(ctx, 0, -ctx.viewportOffset, ctx.cols, ctx.rows, fill);
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
		const previousScrolled = painter.scrolledRows;
		ctx.clipRect = getPositionedClip(
			painter.layout,
			element,
			root,
			contextClip,
		);
		// Entered from its stacking context, not its ancestor chain.
		painter.scrolledRows = scrolledAncestorRows(painter.layout, element);
		// Fixed space cancels the document scroll for the whole subtree. An
		// absolute box inside a fixed bar moves with it.
		if (painter.layout.isInFixedSpace(element)) {
			ctx.viewportOffset = previousOffset + painter.framebuffer.scrollTop;
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
			painter.scrolledRows = previousScrolled;
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
	const layout = painter.layout;
	const node = getLayoutNode(layout, element);
	if (node === null) {
		return;
	}
	const rect = layout.getRect(element);
	if (rect === null) {
		return;
	}
	const paint = () =>
		paintBlock(
			painter,
			element,
			node,
			{x: rect.x, y: rect.y},
			ctx,
			afterOwnBox,
		);
	// A box an inline-block lays out has its extents counted from that
	// box's own root, so the band is counted from there too, as it is when
	// the inline-block paints its content.
	const frame = getExtentFrame(node);
	const extent = frame === undefined ? undefined : paintExtent(node, frame);
	if (
		frame === undefined || extent === undefined || frame === layout.initialBlock
	) {
		paint();
		return;
	}
	paintInFrame(painter, frame, extent.origin - Math.round(rect.y), paint);
}

// Paint with the band counted in another frame's rows.
function paintInFrame(
	painter: Painter,
	frame: LayoutNode,
	scrolledRows: number,
	paint: () => void,
): void {
	const previousFrame = painter.frame;
	const previousScrolled = painter.scrolledRows;
	painter.frame = frame;
	painter.scrolledRows = scrolledRows;
	try {
		paint();
	} finally {
		painter.frame = previousFrame;
		painter.scrolledRows = previousScrolled;
	}
}

function isOutsideViewport(
	painter: Painter,
	ctx: CellContext,
	node: LayoutNode,
	element: Element | null,
): boolean {
	const extent = paintExtent(node, painter.frame);
	if (extent === undefined) {
		return false;
	}
	const top = -ctx.viewportOffset + painter.scrolledRows + ctx.bandTop;
	const bottom = top + ctx.bandBottom - ctx.bandTop;
	if (extent.bottom > top && extent.top < bottom) {
		return false;
	}
	// A broken inline paints boxes outside its own layout subtree, so its
	// extent says nothing about them.
	return element === null || !painter.layout.getBox(element)?.broken;
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
		width: getComputedWidth(node),
		height: getComputedHeight(node),
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

	if (isReplacedBox(element)) {
		paintReplaced(element, style, rect, ctx);
		paintOutline(element, style, rect, ctx);
		return;
	}

	// The math engine laid the whole subtree out into one box of cells.
	if (isMathRoot(element)) {
		if (style.visible) {
			renderMath(painter, element, rect, ctx);
		}
		paintOutline(element, style, rect, ctx);
		return;
	}
	paintContent(painter, element, style, rect, ctx, (origin) => {
		paintNodes(painter, node, origin, ctx);
	});
	paintOutline(element, style, rect, ctx);
}

function paintContent(
	painter: Painter,
	element: Element,
	style: PaintStyle,
	rect: Rect,
	ctx: CellContext,
	paintLayoutChildren: (origin: Origin) => void,
): void {
	const layout = painter.layout;
	const isRoot =
		element === painter.document.body ||
		element === painter.document.documentElement;
	const scrolledRows = isRoot ? 0 : getScrollOffset(element, "top");
	const scrolledCols = isRoot ? 0 : getScrollOffset(element, "left");
	const origin: Origin = {
		x: rect.left - scrolledCols,
		y: rect.top - scrolledRows,
	};

	// Overflow clips descendants, never the element's own box.
	const previousClip = ctx.clipRect;
	const previousScrolled = painter.scrolledRows;
	ctx.clipRect = getOverflowClipRect(
		element,
		rect,
		style.overflowX,
		style.overflowY,
		previousClip,
	);
	painter.scrolledRows = previousScrolled + scrolledRows;
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
			// The box lays its content out from 0, so what the viewport shows
			// of it is counted from where it paints, not from the document.
			const top = origin.y + style.contentInsetY;
			paintInFrame(painter, context, -top, () =>
				paintNodes(
					painter,
					context,
					{x: origin.x + style.contentInsetX, y: top},
					ctx,
				),
			);
		} else {
			paintLayoutChildren(origin);
		}
		if (style.overflowX !== "visible") {
			paintOverflowMarkers(painter, element, style, ctx);
		}
	} finally {
		ctx.clipRect = previousClip;
		painter.scrolledRows = previousScrolled;
	}
}

// The text an element's own lines hold: its inline content, not what a
// nested block or inline-block lays out in lines of its own.
function *getOwnLineText(element: Element): Generator<Text> {
	for (const child of flowContent(element)) {
		if (getNodeType(child) === child.TEXT_NODE) {
			yield child as Text;
		} else if (
			getNodeType(child) === child.ELEMENT_NODE &&
			getComputedValue(child as Element, "display") === "inline"
		) {
			yield *getOwnLineText(child as Element);
		}
	}
}

// What text-overflow puts at each edge a line overflows: nothing for
// clip, an ellipsis, or a string. One value is for the end edge, the
// right or, in a right-to-left box, the left (css-ui-3). Two are for the
// line-left edge and then the line-right, and a string is its own
// marker, as css-overflow-4 drafts it and Firefox ships it.
function getOverflowMarkers(
	element: Element,
): {left: string; right: string} | null {
	const value = getComputedValue(element, "text-overflow");
	if (value === "" || value === "clip") {
		return null;
	}
	const markers = (value.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/g) ??
		[])
		.map((token) =>
			token === "ellipsis"
				? "…"
				: /^["']/.test(token) ? token.slice(1, -1).replace(/\\(.)/g, "$1") : "",
		);
	if (markers.length === 2) {
		return {left: markers[0], right: markers[1]};
	}
	const rtl = getComputedValue(element, "direction") === "rtl";
	return rtl
		? {left: markers[0] ?? "", right: ""}
		: {left: "", right: markers[0] ?? ""};
}

// A line that runs past a clipped edge ends there in the marker
// text-overflow asks for, in the box's own text style, covering the cells
// it needs.
function paintOverflowMarkers(
	painter: Painter,
	element: Element,
	style: PaintStyle,
	ctx: CellContext,
): void {
	const clip = ctx.clipRect;
	const markers = getOverflowMarkers(element);
	if (clip === null || markers === null) {
		return;
	}
	const rows = new Map<number, {left: number; right: number}>();
	for (const text of getOwnLineText(element)) {
		const fragments =
			painter.paintedText.get(text) ?? painter.layout.lineFragments(text);
		for (const fragment of fragments) {
			if (fragment.endOffset <= fragment.startOffset) {
				continue;
			}
			const row = Math.round(fragment.rect.top);
			const span = rows.get(row) ?? {left: Infinity, right: -Infinity};
			span.left = Math.min(span.left, Math.round(fragment.rect.left));
			span.right = Math.max(
				span.right,
				Math.round(fragment.rect.left + fragment.rect.width),
			);
			rows.set(row, span);
		}
	}
	for (const [row, span] of rows) {
		if (row < clip.top || row >= clip.bottom) {
			continue;
		}
		if (markers.left !== "" && span.left < clip.left) {
			drawText(ctx, markers.left, clip.left, row, style.cell);
		}
		if (
			markers.right !== "" &&
			span.right > clip.right &&
			Number.isFinite(clip.right)
		) {
			const width = ctx.measureText(markers.right).width;
			drawText(ctx, markers.right, clip.right - width, row, style.cell);
		}
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
	const layout = painter.layout;
	for (const child of visibleChildren(painter, ctx, node)) {
		const owner = child.owner as Node | null;
		const childOrigin = {
			x: origin.x + child.grid.left,
			y: origin.y + child.grid.top,
		};
		// An anonymous table paints nothing of its own, only its parts.
		if (owner === null) {
			paintNodes(painter, child, childOrigin, ctx);
			continue;
		}
		const run = getRun(layout, child);
		if (run !== null) {
			paintRun(painter, run, childOrigin, ctx);
		} else if (
			getNodeType(owner) === owner.ELEMENT_NODE &&
			(owner instanceof HTMLElement || isMathRoot(owner)) &&
			!hoistedToLayer(layout, owner as Element)
		) {
			paintBlock(painter, owner as Element, child, childOrigin, ctx);
		}
	}
}

function visibleChildren(
	painter: Painter,
	ctx: CellContext,
	node: LayoutNode,
): LayoutNode[] {
	const layout = painter.layout;
	const children = node.children;
	const top = -ctx.viewportOffset + painter.scrolledRows + ctx.bandTop;
	const bottom = top + ctx.bandBottom - ctx.bandTop;
	const extent = paintExtent(node, painter.frame);
	const owner = node.owner as Node | null;
	if (
		extent === undefined ||
		extent.unstackedChildren !== 0 ||
		!extent.rowOrdered ||
		node.measure !== null ||
		(owner !== null &&
			getNodeType(owner) === owner.ELEMENT_NODE &&
			layout.getBox(owner as Element)?.holdsFragments === true)
	) {
		return children;
	}
	let lo = 0;
	let hi = children.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const childExtent = paintExtent(children[mid], painter.frame);
		if (childExtent !== undefined && childExtent.bottom <= top) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	const visible: LayoutNode[] = [];
	for (let i = lo; i < children.length; i++) {
		const childExtent = paintExtent(children[i], painter.frame);
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
			drawRect(
				ctx,
				Math.round(fragment.left),
				Math.round(fragment.top),
				Math.round(fragment.width),
				Math.round(fragment.height),
				style.fill,
			);
		}
	}
	// Over the flat fill, which a transparent stop composites onto.
	if (style.gradient !== null) {
		const cell = painter.framebuffer.cellPixels;
		for (const fragment of fragments) {
			renderGradient(
				ctx,
				style.gradient,
				fragment,
				style.bg ?? null,
				cell.height / cell.width,
				getCellSize(painter.document),
			);
		}
	}
	if (style.border !== null) {
		drawBox(
			ctx,
			Math.round(rect.left),
			Math.round(rect.top),
			Math.round(rect.width),
			Math.round(rect.height),
			style.border,
		);
	}
}

// A borderless outline is an overline and an underline on each of the
// box's fragments, so an inline broken across lines is marked along
// its own text on each line and not across the union of them.
function paintOutline(
	element: Element,
	style: PaintStyle,
	rect: Rect,
	ctx: CellContext,
	fragments: readonly Rect[] = [rect],
): void {
	// A box paints only the rows it covers, which is what its extent
	// says, so one with no height has no row to ring.
	if (
		!style.visible || style.outlineColor === null || Math.round(rect.height) < 1
	) {
		return;
	}
	const color = style.outlineColor;
	const sides = resolveBorderSides(element);
	if (sides.top || sides.right || sides.bottom || sides.left) {
		const ring =
			(line: LineStyle["style"] | undefined): LineStyle | undefined =>
				line && {style: line, color};
		drawBox(ctx,
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
		for (const fragment of fragments) {
			if (Math.round(fragment.height) < 1) {
				continue;
			}
			drawDecoration(ctx,
				Math.round(fragment.left),
				Math.round(fragment.top),
				Math.round(fragment.width),
				{overline: true, fg: color},
			);
			drawDecoration(ctx,
				Math.round(fragment.left),
				Math.round(fragment.top + fragment.height) - 1,
				Math.round(fragment.width),
				{underline: true, fg: color},
			);
		}
	}
}

function paintCaret(
	painter: Painter,
	element: Element,
	style: PaintStyle,
	ctx: CellContext,
): void {
	if (!style.visible || element !== getFocusedElement(painter.document)) {
		return;
	}
	const record = getSelectionRecord(element);
	if (record === null) {
		renderEditingCaret(painter, element, ctx);
		return;
	}
	// A control with a value but no text to edit, a checkbox or a select,
	// shows focus as an outline instead. A selection shows as its
	// highlight, with no caret, as in a browser.
	if (!takesTextCursor(element) || record.start !== record.end) {
		return;
	}
	const focus = record.direction === "backward" ? record.start : record.end;
	const node = getTextControlValueText(element) ?? getGlyphText(element);
	let caret: {x: number; y: number} | null = null;
	if (node) {
		const range = element.ownerDocument.createRange();
		range.setStart(node, Math.min(focus, node.data.length));
		range.collapse(true);
		const rects = painter.layout.getRangeRects(range);
		if (rects.length > 0) {
			caret = {x: Math.round(rects[0].x), y: Math.round(rects[0].y)};
		}
	}
	if (caret === null) {
		const content = painter.layout.contentRect(element);
		if (content) {
			caret = {x: Math.round(content.x), y: Math.round(content.y)};
		}
	}
	if (caret !== null) {
		setCaretAt(painter, element, ctx, caret.x, caret.y);
	}
}

// A caret in fixed space, as a fullscreen element is, moves with the
// boxes there, which are painted against the document scroll.
function setCaretAt(
	painter: Painter,
	element: Element,
	ctx: CellContext,
	x: number,
	y: number,
): void {
	const lift = painter.layout.isInFixedSpace(element)
		? painter.framebuffer.scrollTop
		: 0;
	setCaret(ctx, x, y + lift);
}

// A run's lines, from the box that broke them. The origin is the run's
// layout node's; an atomic inline heading a run styled from it has that
// node at its margin edge while its segment counts from its margin box.
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
		box.styledFrom === head &&
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
	if (getNodeType(node) === node.TEXT_NODE) {
		paintText(painter, node as Text, run, ctx);
		return;
	}
	if (getNodeType(node) !== node.ELEMENT_NODE) {
		return;
	}
	const element = node as Element;
	const leaf = run.leaves.get(element);
	if (leaf !== undefined) {
		paintAtomic(painter, element, leaf.leaf, leaf.rect, ctx);
		return;
	}
	if (hoistedToLayer(painter.layout, element)) {
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
		paintBox(painter, {...style, border: null}, fragments, rect, ctx);
		paintInlineBorder(style, fragments, ctx);
		paintCaret(painter, element, style, ctx);
	}
	for (const child of flowContent(element)) {
		paintMember(painter, child, run, ctx);
	}
	if (rect !== null) {
		paintOutline(element, style, rect, ctx, fragments);
	}
}

// An inline box is one row of text, with no rows above and below it for
// a top and a bottom border to take. Its sides close the first fragment
// on the left and the last on the right.
function paintInlineBorder(
	style: PaintStyle,
	fragments: Rect[],
	ctx: CellContext,
): void {
	if (!style.visible || style.border === null) {
		return;
	}
	const first = fragments[0];
	const last = fragments[fragments.length - 1];
	if (style.border.left) {
		drawBox(ctx,
			Math.round(first.left),
			Math.round(first.top),
			1,
			Math.round(first.height),
			{left: style.border.left},
		);
	}
	if (style.border.right) {
		drawBox(ctx,
			Math.round(last.left + last.width) - 1,
			Math.round(last.top),
			1,
			Math.round(last.height),
			{right: style.border.right},
		);
	}
}

// An image's or a canvas's pixels, cells or alt text in its content box.
// Pixels that are partly transparent blend over the element's own
// background where it has one.
function paintReplaced(
	element: Element,
	style: PaintStyle,
	rect: Rect,
	ctx: CellContext,
): void {
	if (!style.visible) {
		return;
	}
	renderReplaced(
		element,
		rect,
		ctx,
		style.cell,
		style.bg === undefined ? null : style.bg,
		getCanvasTextRuns(element),
	);
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

	if (isReplacedBox(element)) {
		paintReplaced(element, style, rect, ctx);
		paintOutline(element, style, rect, ctx);
		return;
	}
	if (isMathRoot(element)) {
		if (style.visible) {
			renderMath(painter, element, rect, ctx);
		}
		paintOutline(element, style, rect, ctx);
		return;
	}
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
	paintOutline(element, style, rect, ctx);
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
				let ancestor = getNodeType(node) === node.ELEMENT_NODE
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
				column: number;
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
						column: segment.x,
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
					top: lineY + segment.dy + shift.y,
					width: segment.width,
					height: segment.height,
				};
				run.leaves.set(leaf.node, {rect, leaf});
				coverAncestors(boxLines, leaf.node, container, lineY, rect);
			} else if (leaf.type === "edge") {
				// The margin is outside the box it edges and inside the ones
				// around it.
				const shift = getShift(leaf.node);
				const rect = {
					left: lineX + segment.x + shift.x,
					top: lineY + line.textTop + shift.y,
					width: segment.width,
					height: line.height - line.textTop,
				};
				coverAncestors(boxLines, leaf.node, container, lineY, rect);
				const margin = Math.max(0, leaf.margin);
				coverBox(boxLines, leaf.node, lineY, {
					...rect,
					left: leaf.side === "start" ? rect.left + margin : rect.left,
					width: Math.max(0, rect.width - margin),
				});
			}
		}
		for (const [textNode, span] of textSpans) {
			const shift = getShift(textNode);
			const rect = {
				left: span.left + shift.x,
				top: lineY + line.textTop + shift.y,
				width: span.right - span.left,
				height: line.height - line.textTop,
			};
			let fragments = run.texts.get(textNode);
			if (fragments === undefined) {
				run.texts.set(textNode, (fragments = []));
			}
			fragments.push({
				rect,
				column: span.column,
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
		coverBox(boxLines, ancestor, lineY, rect);
	}
}

function coverBox(
	boxLines: Map<Element, Map<number, Rect>>,
	element: Element,
	lineY: number,
	rect: Rect,
): void {
	let byLine = boxLines.get(element);
	if (byLine === undefined) {
		boxLines.set(element, (byLine = new Map()));
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
	painter.paintedText.set(textNode, fragments);
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
		let text = renderTextFragment(
			textNode.data,
			style.whiteSpace,
			fragment.startOffset,
			fragment.endOffset,
			fragment.visualBase,
			{tabSize: style.tabSize, column: fragment.column},
		);
		text = withoutHangingSpaces(text, fragment);
		if (!text) {
			continue;
		}
		painted = true;
		drawText(
			ctx,
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

	if (painter.renderedOutsideMarkers.has(element)) {
		return;
	}
	painter.renderedOutsideMarkers.add(element);

	const markerContent = getMarkerContent(painter.cascade, element);
	if (!markerContent) {
		return;
	}

	// Cells, not code units. "日本 " is 3 characters and 5 cells.
	const markerWidth = ctx.measureText(markerContent).width;

	const markerTextStyle = getMarkerTextStyle(painter, element);

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
	drawText(ctx, markerContent, markerX, Math.round(rect.top), markerTextStyle);
}

// A marker's text style, by the object its element's style keeps until it
// changes.
const markerTextStyles = new WeakMap<object, CellStyle>();

function getMarkerTextStyle(painter: Painter, element: Element): CellStyle {
	const key = painter.cascade.getStyleKey(element);
	const known = key === null ? undefined : markerTextStyles.get(key);
	if (known !== undefined) {
		return known;
	}
	const color =
		getComputedValue(element, "color", "::marker") ||
		getComputedValue(element, "color");
	const {bold, dim} = resolveFontWeight(
		getComputedValue(element, "font-weight", "::marker"),
	);
	const style: CellStyle = {
		fg: color && color !== "initial"
			? CSSValues.numberFromCSSColor(color)
			: undefined,
		bold,
		dim,
		italic: getComputedValue(element, "font-style", "::marker") === "italic",
		underline: CSSValues.parseTextDecorationLine(
			getComputedValue(element, "text-decoration-line", "::marker"),
		).underline,
	};
	if (key !== null) {
		markerTextStyles.set(key, style);
	}
	return style;
}

// A focused editing host parks the cursor at the document selection's
// focus, the way a focused text control parks it at its own, and shows
// none while the selection holds text.
function renderEditingCaret(
	painter: Painter,
	element: Element,
	ctx: CellContext,
): void {
	const point = getEditingCaretPoint(painter.document);
	if (
		point === null ||
		!nodeContains(element, point.node) ||
		painter.document.getSelection()?.isCollapsed === false
	) {
		return;
	}
	const rect = painter.layout.getCaretRect(point.node, point.offset);
	if (rect !== null) {
		setCaretAt(painter, element, ctx, Math.round(rect.x), Math.round(rect.y));
		return;
	}
	const box = getNodeType(point.node) === point.node.ELEMENT_NODE
		? (point.node as Element)
		: (flatParentElement(point.node) ?? element);
	const content = painter.layout.contentRect(box);
	if (content) {
		setCaretAt(
			painter,
			element,
			ctx,
			Math.round(content.x),
			Math.round(content.y),
		);
	}
}

// Blits the math box into the content box, placed by text-align when the
// content box is wider (a block-level <math> is centered by the UA sheet).
function renderMath(
	painter: Painter,
	element: Element,
	rect: Rect,
	ctx: CellContext,
): void {
	const box = getMathBox(painter.layout, element);
	const boxModel = getBoxModel(element);
	const contentWidth =
		Math.round(rect.width) -
		boxModel.borderLeftWidth -
		boxModel.borderRightWidth -
		boxModel.paddingLeft -
		boxModel.paddingRight;
	const left =
		Math.round(rect.left) +
		boxModel.borderLeftWidth +
		boxModel.paddingLeft +
		getMathAlignOffset(
			contentWidth - box.width,
			getComputedValue(element, "text-align"),
		);
	const top =
		Math.round(rect.top) + boxModel.borderTopWidth + boxModel.paddingTop;
	const selections = new Map<Text, MathSelection | null>();
	for (let row = 0; row < box.height; row++) {
		let x = left;
		for (const cell of box.cells[row]) {
			const style = getMathCellStyle(painter, cell, selections);
			if (!isBlankCell(cell) || style !== cell.style) {
				drawText(ctx, cell.text, x, top + row, style ?? undefined);
			}
			x += cell.width;
		}
	}
}

interface MathSelection {
	from: number;
	to: number;
	paint: HighlightPaint;
}

// A cell's style under the highlights and the selection over the text
// it renders, as a run of text gets in renderTextHighlights.
function getMathCellStyle(
	painter: Painter,
	cell: MathCell,
	selections: Map<Text, MathSelection | null>,
): CellStyle | null {
	const source = cell.source;
	if (source === undefined) {
		return cell.style;
	}
	const parent = flatParentElement(source.node);
	if (parent === null) {
		return cell.style;
	}
	let style = cell.style;
	const covers = (from: number, to: number): boolean =>
		from <= source.offset && source.offset < to;
	for (const run of painter.highlightedText.get(source.node) ?? []) {
		if (covers(run.from, run.to)) {
			const paint = getHighlightStyle(painter, parent, run.name);
			if (paint !== null) {
				style = foldHighlight(style ?? {}, paint);
			}
		}
	}
	let selection = selections.get(source.node);
	if (selection === undefined) {
		const selected = getPaintSelectionRange(painter, source.node);
		const paint = selected && readSelectionStyle(selected.selectionParent);
		selection = selected && paint ? {...selected, paint} : null;
		selections.set(source.node, selection);
	}
	if (selection !== null && covers(selection.from, selection.to)) {
		style = foldHighlight(style ?? {}, selection.paint);
	}
	return style;
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
	const textControl = getTextControlSelectionRange(painter.document, textNode);
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

	const selection = painter.window.getSelection();
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
	if (!painter.cascade.isSelectable(selectionParent)) {
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
	const declared = declaredPseudoProperties(painter.cascade, element, pseudo);
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
			? CSSValues.numberFromCSSColor(color)
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
			paint.bg = CSSValues.numberFromCSSColor(background);
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
		paint.fg = CSSValues.numberFromCSSColor(fg);
	}
	if (bgAuthored) {
		paint.bg = CSSValues.numberFromCSSColor(bg);
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
	let byName = painter.highlightStyles.get(element);
	if (byName === undefined) {
		byName = new Map<string, HighlightPaint | null>();
		painter.highlightStyles.set(element, byName);
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
	const runs = painter.highlightedText.get(textNode);
	if (parent !== null && runs !== undefined) {
		for (const run of runs) {
			const paint = getHighlightStyle(painter, parent, run.name);
			if (paint !== null) {
				layers.push({
					...snapToClusters(painter.layout, textNode, run.from, run.to),
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
				...snapToClusters(painter.layout, textNode, selected.from, selected.to),
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
		for (const run of painter.layout.getTextSpans(textNode, from, to)) {
			drawText(
				ctx,
				applyTextTransform(run.text, textTransform),
				run.rect.x,
				run.rect.y,
				style,
			);
		}
	}
}
