import {
	type Cascade,
	declaredPseudoProperties,
	getBoxModel,
	getCellBorderWidths,
	getComputedValue,
	getDeclaredDisplay,
	getMarkerContent,
	getStyleGroup,
	getTabSize,
	getUsedOverflow,
	getWhiteSpace,
	resolveBorderSides,
	resolveLength,
	type StyleGroup,
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
	hasSystemFocus,
	HTMLElement,
	isDocumentElement,
	renderedTopLayer,
	takesTextCursor,
	type Window,
} from "./dom.ts";
import {getEditingCaretPoint} from "./editing.ts";
import {
	type Caret,
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
import {implementsInterface} from "./slots.ts";
import {getStringWidth} from "./text.ts";
import {getLocalName, getNodeType, nodeContains} from "./tree.ts";
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
	// opacity: 0, which draws nothing of the box or what it holds, though
	// they keep their place and take pointer events. A terminal cell has no
	// partial opacity, so any other value draws whole.
	transparent: boolean;
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

type SharedPaintStyle = Omit<PaintStyle, "overflowX" | "overflowY">;

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
	"caret-shape",
	"caret-animation",
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
	if (
		before !== after &&
		(isDocumentElement(element) || element === painter.document.body) &&
		(before.fill !== after.fill ||
			before.gradient !== after.gradient ||
			before.display !== after.display)
	) {
		return "whole";
	}
	return before === after;
}

function readPaintStyle(element: Element): SharedPaintStyle {
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
		transparent: parseFloat(getComputedValue(element, "opacity")) === 0,
		fg,
		bg,
		fill,
		gradient,
		border: border.top || border.right || border.bottom || border.left
			? border
			: null,
		outlineColor,
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
	// What resolving the run works from: the line each box's last rect is
	// on.
	boxLines: Map<Element, number>;
}

// A run is painted before the next one at its depth is resolved, and an
// inline-block in it paints its own runs one deeper, so the maps of one
// run a depth are reused, cleared once it is painted so they hold no
// node past it. Clearing a map makes it a new table, so an empty one is
// left as it is.
const runs: PainterRun[] = [];
let runDepth = 0;

function takeRun(): PainterRun {
	runs[runDepth] ??= {
		texts: new Map(),
		boxes: new Map(),
		leaves: new Map(),
		boxLines: new Map(),
	};
	return runs[runDepth++];
}

function releaseRun(run: PainterRun): void {
	clearMap(run.texts);
	clearMap(run.boxes);
	clearMap(run.leaves);
	clearMap(run.boxLines);
	runDepth--;
}

function clearMap(map: Map<unknown, unknown>): void {
	if (map.size > 0) {
		map.clear();
	}
}

function unionRect(rects: Rect[]): Rect {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (let index = 0; index < rects.length; index++) {
		const rect = rects[index];
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
	// Whether each layer member looked up in this frame has an ancestor
	// with opacity: 0.
	inTransparent: Map<Element, boolean>;
	// What the document's selection holds this frame, when it holds any.
	selectedRange: Range | null;
	// The root, or the body standing in for it, whose background color
	// fills the whole screen, as a browser paints it across the canvas.
	canvasElement: Element | null;
	// The document rows that color fills, down to the screen's bottom row
	// when the page is drawn in the flow under what came before it, or
	// null for every row the frame has.
	canvasRows: number | null;

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
		this.inTransparent = new Map();
		this.selectedRange = null;
		this.canvasElement = null;
		this.canvasRows = null;
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
 * Whether a frame can paint only the rows a box's scroll exposed, and
 * those that changed, the rest carried by the shift: the shift spans the
 * width, and nothing over the shifted rows stays put while the box's
 * content moves. A background drawn as a gradient stays put too.
 */
export function scrollShiftCarriesPaint(
	painter: Painter,
	element: Element,
	shift: {top: number; end: number},
): boolean {
	const layout = painter.layout;
	const framebuffer = painter.framebuffer;
	if (renderedTopLayer(painter.document).length > 0) {
		return false;
	}
	const rect = layout.getRect(element);
	if (rect === null) {
		return false;
	}
	const border = getCellBorderWidths(element);
	if (
		rect.left + border.left > 0 ||
		rect.left + rect.width - border.right < framebuffer.cols
	) {
		return false;
	}
	const around = new Set<Element>();
	for (
		let box: Element | null = element;
		box !== null;
		box = flatParentElement(box)
	) {
		if (getPaintStyle(painter, box).gradient !== null) {
			return false;
		}
		around.add(box);
	}
	for (const positioned of layout.positionedElements) {
		if (around.has(positioned) || !positioned.isConnected) {
			continue;
		}
		let inside = false;
		for (
			let box = flatParentElement(positioned);
			box !== null;
			box = flatParentElement(box)
		) {
			if (box === element) {
				inside = true;
				break;
			}
		}
		if (inside) {
			// What is positioned in the box moves with its content, unless it
			// sticks or is placed against something outside it.
			const position = getComputedValue(positioned, "position");
			if (position === "relative" || position === "static") {
				continue;
			}
			return false;
		}
		const box = layout.getRect(positioned);
		if (box === null) {
			continue;
		}
		const lift = layout.isInFixedSpace(positioned) ? 0 : framebuffer.scrollTop;
		const top = Math.round(box.top) - lift;
		const bottom = Math.round(box.top + box.height) - lift;
		if (bottom > shift.top && top < shift.end) {
			return false;
		}
	}
	return true;
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
	painter.selectedRange = getSelectedRange(painter.window);
	painter.inTransparent = new Map();
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
	const canvas = painter.canvasElement = findCanvasElement(painter);
	const canvasFill = canvas === null
		? null
		: getPaintStyle(painter, canvas).fill;
	for (const [top, bottom] of ctx.bands) {
		ctx.bandTop = top;
		ctx.bandBottom = bottom;
		const fillBottom = painter.canvasRows === null
			? bottom
			: Math.min(bottom, painter.canvasRows);
		if (canvasFill !== null && fillBottom > top) {
			const clip = ctx.clipRect;
			ctx.clipRect = null;
			drawRect(
				ctx,
				0,
				top - ctx.viewportOffset,
				ctx.cols,
				fillBottom - top,
				canvasFill,
			);
			ctx.clipRect = clip;
		}
		paintBand(painter, ctx, root, rendered, layers);
	}
}

// The root's background is the canvas's. A root <html> with none takes
// its body's, as CSS Backgrounds says.
function findCanvasElement(painter: Painter): Element | null {
	const document = painter.document;
	const html = document.documentElement as Element | null;
	if (html === null) {
		return null;
	}
	const htmlStyle = getPaintStyle(painter, html);
	if (htmlStyle.display === "none") {
		return null;
	}
	if (htmlStyle.fill !== null || htmlStyle.gradient !== null) {
		return html;
	}
	const body = document.body as Element | null;
	if (body === null || getLocalName(html) !== "html") {
		return null;
	}
	const bodyStyle = getPaintStyle(painter, body);
	return bodyStyle.display !== "none" &&
			(bodyStyle.fill !== null || bodyStyle.gradient !== null)
		? body
		: null;
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
	previousCaret: Caret | null,
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

// The paint style of every element that shares its values, and the
// whole paint style, with the used overflow, which reads the element's
// own display. Held once for each pair, so two alike are one object.
const PAINT_STYLE: StyleGroup<SharedPaintStyle> = {
	name: "paint",
	read: readPaintStyle,
};
const overflowedPaintStyles = new WeakMap<
	SharedPaintStyle,
	Map<string, PaintStyle>
>();

function getPaintStyle(painter: Painter, element: Element): PaintStyle {
	const key = painter.cascade.getStyleKey(element);
	const known = key === null ? undefined : paintStyles.get(key);
	if (known !== undefined) {
		return known;
	}
	const shared = getStyleGroup(element, PAINT_STYLE);
	const overflowX = getUsedOverflow(element, "x");
	const overflowY = getUsedOverflow(element, "y");
	let styles = overflowedPaintStyles.get(shared);
	if (styles === undefined) {
		styles = new Map();
		overflowedPaintStyles.set(shared, styles);
	}
	let style = styles.get(`${overflowX} ${overflowY}`);
	if (style === undefined) {
		style = Object.freeze({...shared, overflowX, overflowY});
		styles.set(`${overflowX} ${overflowY}`, style);
	}
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
		// A layer member paints from its stacking context, not through its
		// ancestors, so one inside a transparent ancestor is skipped here.
		if (isInTransparent(painter, element)) {
			return;
		}
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

function isInTransparent(painter: Painter, element: Element): boolean {
	let known = painter.inTransparent.get(element);
	if (known === undefined) {
		const parent = flatParentElement(element);
		known =
			parent !== null &&
			(getPaintStyle(painter, parent).transparent ||
				isInTransparent(painter, parent));
		painter.inTransparent.set(element, known);
	}
	return known;
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
	if (style.display === "none" || style.transparent) {
		return;
	}
	const rect: Rect = {
		left: origin.x,
		top: origin.y,
		width: getComputedWidth(node),
		height: getComputedHeight(node),
	};
	paintBox(painter, element, style, [rect], rect, ctx);
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
	paintContent(painter, element, style, rect, ctx, node);
	paintOutline(element, style, rect, ctx);
}

// What a box lays its content out as: its layout node's children, or the
// lines of the inline-block it is.
function paintContent(
	painter: Painter,
	element: Element,
	style: PaintStyle,
	rect: Rect,
	ctx: CellContext,
	content: LayoutNode | InlineBlockLeaf,
): void {
	const layout = painter.layout;
	const isRoot =
		isDocumentElement(element) ||
		(getLocalName(element) === "body" && element === painter.document.body);
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
			const outerFrame = painter.frame;
			const outerScrolled = painter.scrolledRows;
			painter.frame = context;
			painter.scrolledRows = -top;
			try {
				paintNodes(
					painter,
					context,
					{x: origin.x + style.contentInsetX, y: top},
					ctx,
				);
			} finally {
				painter.frame = outerFrame;
				painter.scrolledRows = outerScrolled;
			}
		} else if (!("type" in content)) {
			paintNodes(painter, content, origin, ctx);
		} else if (content.breakResult) {
			const model = content.boxModel;
			paintLines(
				painter,
				content.breakResult,
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
function getOwnLineText(element: Element, found: Text[] = []): Text[] {
	for (const child of flowContent(element)) {
		if (getNodeType(child) === child.TEXT_NODE) {
			found.push(child as Text);
		} else if (
			getNodeType(child) === child.ELEMENT_NODE &&
			getComputedValue(child as Element, "display") === "inline"
		) {
			getOwnLineText(child as Element, found);
		}
	}
	return found;
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
	const children = visibleChildren(painter, ctx, node);
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
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
		// A box laid out as one run paints as that run, so its opacity is
		// asked of it here. A run an inline box heads is its container's,
		// and the inline box answers for itself as it paints.
		if (getNodeType(owner) === owner.ELEMENT_NODE) {
			const style = getPaintStyle(painter, owner as Element);
			if (style.transparent && style.display !== "inline") {
				continue;
			}
		}
		const run = getRun(layout, child);
		if (run !== null) {
			paintRun(painter, run, childOrigin, ctx);
		} else if (
			getNodeType(owner) === owner.ELEMENT_NODE &&
			(implementsInterface(owner, HTMLElement) || isMathRoot(owner)) &&
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
	element: Element,
	style: PaintStyle,
	fragments: Rect[],
	rect: Rect,
	ctx: CellContext,
): void {
	if (!style.visible) {
		return;
	}
	if (style.fill !== null && element !== painter.canvasElement) {
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
	fragments?: readonly Rect[],
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
		for (const fragment of fragments ?? [rect]) {
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
	if (
		!style.visible ||
		element !== getFocusedElement(painter.document) ||
		!hasSystemFocus(painter.document)
	) {
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
	if (node && node.data.length > 0) {
		const range = element.ownerDocument.createRange();
		range.setStart(node, Math.min(focus, node.data.length));
		range.collapse(true);
		const rects = painter.layout.getRangeRects(range);
		if (rects.length > 0) {
			caret = {x: Math.round(rects[0].x), y: Math.round(rects[0].y)};
		}
	}
	// An empty field's caret is where its line would start, so a centered
	// field's sits in the middle, as its text will. The last column holds
	// it at the end edge, since it can't stand past the box.
	if (caret === null) {
		const content = painter.layout.contentRect(element);
		if (content) {
			const width = Math.round(content.width);
			const offset = Math.min(
				getLineAlignOffset(element, width, 0),
				Math.max(0, width - 1),
			);
			caret = {x: Math.round(content.x) + offset, y: Math.round(content.y)};
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
	setCaret(ctx, x, y + lift, getCursorShape(element), getCursorColor(element));
}

// css-ui-4 §6.2: the shapes the terminal's cursor can take, as the
// blinking DECSCUSR style. caret-animation: manual holds it steady, the
// style after it. auto leaves the terminal's own.
const CURSOR_SHAPES: Readonly<Record<string, number>> = {
	block: 1,
	underscore: 3,
	bar: 5,
};

function getCursorShape(element: Element): number {
	const shape = CURSOR_SHAPES[getComputedValue(element, "caret-shape")];
	if (shape === undefined) {
		return 0;
	}
	return getComputedValue(element, "caret-animation") === "manual"
		? shape + 1
		: shape;
}

// A color the terminal can take for its cursor, or null to leave its own:
// for auto, a system color, which names the terminal's colors, and one it
// could not show.
function getCursorColor(element: Element): number | null {
	let value = getComputedValue(element, "caret-color");
	if (value === "auto") {
		return null;
	}
	if (value.toLowerCase() === "currentcolor") {
		value = getComputedValue(element, "color");
	}
	const parsed = CSSValues.parseColor(value);
	return parsed === null || parsed.alpha === 0 ? null : parsed.color;
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
	members: readonly Node[],
	container: Element,
	alignContainer: Element,
	origin: Origin,
	ctx: CellContext,
): void {
	const run = takeRun();
	try {
		resolveRun(painter, run, lines, container, alignContainer, origin);
		for (let index = 0; index < members.length; index++) {
			paintMember(painter, members[index], run, ctx);
		}
	} finally {
		releaseRun(run);
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
	if (style.display === "none" || style.transparent) {
		return;
	}
	const fragments = run.boxes.get(element) ?? [];
	const rect = fragments.length > 0 ? unionRect(fragments) : null;
	if (rect !== null) {
		paintBox(painter, element, getBorderless(style), fragments, rect, ctx);
		paintInlineBorder(style, fragments, ctx);
		paintCaret(painter, element, style, ctx);
	}
	const children = flowContent(element);
	for (let index = 0; index < children.length; index++) {
		paintMember(painter, children[index], run, ctx);
	}
	if (rect !== null) {
		paintOutline(element, style, rect, ctx, fragments);
	}
}

// An inline box paints its border on its own, beside the box.
const borderlessStyles = new WeakMap<PaintStyle, PaintStyle>();

function getBorderless(style: PaintStyle): PaintStyle {
	if (style.border === null) {
		return style;
	}
	let borderless = borderlessStyles.get(style);
	if (borderless === undefined) {
		borderless = {...style, border: null};
		borderlessStyles.set(style, borderless);
	}
	return borderless;
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
	if (style.display === "none" || style.transparent) {
		return;
	}
	paintBox(painter, element, style, [rect], rect, ctx);
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
	paintContent(painter, element, style, rect, ctx, leaf);
	paintOutline(element, style, rect, ctx);
}

// Most nodes in a run are not moved by relative positioning, and share
// this.
const NO_SHIFT: Origin = Object.freeze({x: 0, y: 0});

interface LineTextSpan {
	node: Text | null;
	left: number;
	right: number;
	column: number;
	start: number;
	end: number;
	visualBase: "ltr" | "rtl" | null;
}

// The text a line spans, a record per node in the order the line meets
// them, reused for each line. A record lets go of its node once the line
// is resolved, so none holds a node past the run. A run resolves its lines
// one at a time and never inside another's.
const lineTextSpans: LineTextSpan[] = [];

// How far relative positioning moves a node in a run, from the boxes
// between it and the run's container.
function getShift(painter: Painter, container: Element, node: Node): Origin {
	let x = 0;
	let y = 0;
	for (
		let ancestor = getNodeType(node) === node.ELEMENT_NODE
			? (node as Element)
			: flatParentElement(node);
		ancestor !== null && ancestor !== container;
		ancestor = flatParentElement(ancestor)
	) {
		const style = getPaintStyle(painter, ancestor);
		x += style.shiftX;
		y += style.shiftY;
	}
	return x === 0 && y === 0 ? NO_SHIFT : {x, y};
}

function resolveRun(
	painter: Painter,
	run: PainterRun,
	lines: BreakResult,
	container: Element,
	alignContainer: Element,
	origin: Origin,
): void {
	const first = lines.lines[0];
	for (let lineIndex = 0; lineIndex < lines.lines.length; lineIndex++) {
		const line = lines.lines[lineIndex];
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
		let spanCount = 0;
		for (let index = 0; index < line.segments.length; index++) {
			const segment = line.segments[index];
			const {leaf} = segment;
			if (leaf.type === "text") {
				let span: LineTextSpan | undefined;
				for (let at = 0; at < spanCount; at++) {
					if (lineTextSpans[at].node === leaf.node) {
						span = lineTextSpans[at];
						break;
					}
				}
				const left = lineX + segment.x;
				const right = left + segment.width;
				if (span === undefined) {
					if (spanCount === lineTextSpans.length) {
						lineTextSpans.push({
							node: null,
							left: 0,
							right: 0,
							column: 0,
							start: 0,
							end: 0,
							visualBase: null,
						});
					}
					span = lineTextSpans[spanCount++];
					span.node = leaf.node;
					span.left = left;
					span.right = right;
					span.column = segment.x;
					span.start = segment.dataStart;
					span.end = segment.dataEnd;
					span.visualBase = segment.visualBase;
				} else {
					span.left = Math.min(span.left, left);
					span.right = Math.max(span.right, right);
					span.end = segment.dataEnd;
				}
			} else if (leaf.type === "inline-block") {
				const shift = getShift(painter, container, leaf.node);
				const rect = {
					left: lineX + segment.x + shift.x,
					top: lineY + segment.dy + shift.y,
					width: segment.width,
					height: segment.height,
				};
				run.leaves.set(leaf.node, {rect, leaf});
				coverAncestors(run, leaf.node, container, lineY, rect);
			} else if (leaf.type === "edge") {
				// The margin is outside the box it edges and inside the ones
				// around it.
				const shift = getShift(painter, container, leaf.node);
				const rect = {
					left: lineX + segment.x + shift.x,
					top: lineY + line.textTop + shift.y,
					width: segment.width,
					height: line.height - line.textTop,
				};
				coverAncestors(run, leaf.node, container, lineY, rect);
				const margin = Math.max(0, leaf.margin);
				coverBox(run, leaf.node, lineY, {
					...rect,
					left: leaf.side === "start" ? rect.left + margin : rect.left,
					width: Math.max(0, rect.width - margin),
				});
			}
		}
		for (let at = 0; at < spanCount; at++) {
			const span = lineTextSpans[at];
			const textNode = span.node as Text;
			span.node = null;
			const shift = getShift(painter, container, textNode);
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
			coverAncestors(run, textNode, container, lineY, rect);
		}
	}
}

function coverAncestors(
	run: PainterRun,
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
		coverBox(run, ancestor, lineY, rect);
	}
}

// A run's lines are resolved top to bottom, so a box already on this line
// has its last rect there.
function coverBox(
	run: PainterRun,
	element: Element,
	lineY: number,
	rect: Rect,
): void {
	const rects = run.boxes.get(element);
	if (rects === undefined) {
		run.boxes.set(element, [{...rect}]);
		run.boxLines.set(element, lineY);
	} else if (run.boxLines.get(element) !== lineY) {
		rects.push({...rect});
		run.boxLines.set(element, lineY);
	} else {
		const known = rects[rects.length - 1];
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
	for (let index = 0; index < fragments.length; index++) {
		const fragment = fragments[index];
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

// A marker no rule styles reads what its item reads, so items that read
// alike share one style, through any restyle.
const itemMarkerStyles = new Map<string, CellStyle>();

const ITEM_MARKER_STYLES = 256;

function getMarkerTextStyle(painter: Painter, element: Element): CellStyle {
	if (!painter.cascade.pseudoRulesByType.has("::marker")) {
		const color = getComputedValue(element, "color");
		const weight = getComputedValue(element, "font-weight");
		const fontStyle = getComputedValue(element, "font-style");
		const line = getComputedValue(element, "text-decoration-line");
		const values = `${color} ${weight} ${fontStyle} ${line}`;
		let style = itemMarkerStyles.get(values);
		if (style === undefined) {
			if (itemMarkerStyles.size === ITEM_MARKER_STYLES) {
				itemMarkerStyles.clear();
			}
			style = createMarkerTextStyle(color, weight, fontStyle, line);
			itemMarkerStyles.set(values, style);
		}
		return style;
	}
	const key = painter.cascade.getStyleKey(element);
	const known = key === null ? undefined : markerTextStyles.get(key);
	if (known !== undefined) {
		return known;
	}
	const color =
		getComputedValue(element, "color", "::marker") ||
		getComputedValue(element, "color");
	const style = createMarkerTextStyle(
		color,
		getComputedValue(element, "font-weight", "::marker"),
		getComputedValue(element, "font-style", "::marker"),
		getComputedValue(element, "text-decoration-line", "::marker"),
	);
	if (key !== null) {
		markerTextStyles.set(key, style);
	}
	return style;
}

function createMarkerTextStyle(
	color: string,
	weight: string,
	fontStyle: string,
	line: string,
): CellStyle {
	const {bold, dim} = resolveFontWeight(weight);
	return {
		fg: color && color !== "initial"
			? CSSValues.numberFromCSSColor(color)
			: undefined,
		bold,
		dim,
		italic: fontStyle === "italic",
		underline: CSSValues.parseTextDecorationLine(line).underline,
	};
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
function getSelectedRange(window: Window): Range | null {
	const selection = window.getSelection();
	return !selection || selection.isCollapsed || selection.rangeCount === 0
		? null
		: selection.getRangeAt(0);
}

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

	const documentRange = painter.selectedRange;
	if (documentRange === null || !documentRange.intersectsNode(textNode)) {
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
