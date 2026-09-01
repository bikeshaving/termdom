import {
	type Cascade,
	cssColorToNumber,
	getBoxModel,
	getComputedValue,
	isTransparentColor,
	resolveBorderSides,
} from "./cssom.js";
import {
	type EngineWindow,
	flatParentElement,
	getFieldSelectionRange,
	getFieldValueText,
	getSelectionRecord,
	getShadowRoot,
	getTopLayer,
	renderedTopLayer,
} from "./dom.js";
import {
	flowWalker,
	formsStackingContext,
	isPositioned,
	type Layout,
	renderTextFragment,
} from "./layout.js";
import type {CellContext, CellStyle, LineStyle, Screen} from "./screen.js";

// Edges, not origin and size. An unclipped axis is +-Infinity, and an
// edge computed from an infinite origin and size is NaN.
type ClipRect = {left: number; top: number; right: number; bottom: number};

function hasUnderline(decorationLine: string): boolean {
	return decorationLine.includes("underline");
}

function hasLineThrough(decorationLine: string): boolean {
	return decorationLine.includes("line-through");
}

function overflowClips(value: string): boolean {
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
	const clipsX = overflowClips(overflowX);
	const clipsY = overflowClips(overflowY);
	if (!clipsX && !clipsY) {
		return parent;
	}

	const box = getBoxModel(element);
	const left = clipsX ? rect.left + (box.borderLeftWidth || 0) : -Infinity;
	const right =
		clipsX ? rect.left + rect.width - (box.borderRightWidth || 0) : Infinity;
	const top = clipsY ? rect.top + (box.borderTopWidth || 0) : -Infinity;
	const bottom =
		clipsY ? rect.top + rect.height - (box.borderBottomWidth || 0) : Infinity;

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

// Three weights: faint, normal, bold. The relative keywords resolve
// absolutely. Bolder than bold does not exist here anyway.
function resolveFontWeight(weight: string): {bold: boolean; dim: boolean} {
	if (weight === "bold" || weight === "bolder") {
		return {bold: true, dim: false};
	}
	if (weight === "lighter") {
		return {bold: false, dim: true};
	}
	const numeric = parseInt(weight, 10);
	if (Number.isFinite(numeric)) {
		if (numeric >= 600) {
			return {bold: true, dim: false};
		}
		if (numeric <= 300) {
			return {bold: false, dim: true};
		}
	}
	return {bold: false, dim: false};
}

// Highlight/HighlightText and SelectedItem/SelectedItemText. On a
// terminal the pair means SGR inverse.
function isSystemHighlightColor(value: string): boolean {
	return /^(?:highlight|selecteditem)(?:text)?$/i.test(value.trim());
}

// Canvas is the terminal's own background. Highlight is inverse.
function getBackgroundFill(
	value: string,
): number | "default" | "inverse" | null {
	if (!value || value === "initial" || isTransparentColor(value)) {
		return null;
	}
	if (/^canvas$/i.test(value.trim())) {
		return "default";
	}
	if (isSystemHighlightColor(value)) {
		return "inverse";
	}
	return cssColorToNumber(value);
}

function getCellStyle(element: Element): CellStyle {
	const color = getComputedValue(element, "color");
	const bgColor = getComputedValue(element, "background-color");
	const {bold, dim} = resolveFontWeight(
		getComputedValue(element, "font-weight"),
	);
	// The background alone carries inverse. color: HighlightText alone
	// resolves to nothing, so an author color does not defeat it.
	const isHighlightPair = isSystemHighlightColor(bgColor);
	return {
		fg:
			color && color !== "initial" && !isSystemHighlightColor(color)
				? cssColorToNumber(color)
				: undefined,
		bg:
			bgColor &&
			bgColor !== "initial" &&
			!isTransparentColor(bgColor) &&
			!/^canvas$/i.test(bgColor.trim()) &&
			!isSystemHighlightColor(bgColor)
				? cssColorToNumber(bgColor)
				: undefined,
		inverse: isHighlightPair || undefined,
		bold,
		dim,
		italic: getComputedValue(element, "font-style") === "italic",
		underline: hasUnderline(getComputedValue(element, "text-decoration-line")),
		underlineStyle:
			getComputedValue(element, "text-decoration-style") === "double"
				? ("double" as const)
				: undefined,
		strikethrough: hasLineThrough(
			getComputedValue(element, "text-decoration-line"),
		),
	};
}

// Everything comes from ::selection rules. The UA sheet's Highlight
// pair is what makes an unstyled selection inverse at all.
function getSelectionStyle(
	element: Element,
	base: CellStyle,
): CellStyle {
	const fg = getComputedValue(element, "color", "::selection");
	const bg = getComputedValue(element, "background-color", "::selection");
	if (!fg && !bg) {
		return base;
	}
	const fgAuthored = Boolean(fg) && !isSystemHighlightColor(fg);
	const bgAuthored = Boolean(bg) && !isSystemHighlightColor(bg);
	if (!fgAuthored && !bgAuthored) {
		return {...base, inverse: true};
	}
	return {
		...base,
		fg: fgAuthored ? cssColorToNumber(fg) : base.fg,
		bg: bgAuthored ? cssColorToNumber(bg) : base.bg,
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

/** Reads the DOM, styles and geometry. Writes only into the CellContext. */
export class Painter {
	declare [kWindow]: EngineWindow;
	declare [kDocument]: Document;
	declare [kLayout]: Layout;
	declare [kCascade]: Cascade;
	declare [kScreen]: Screen;
	declare [kTopLayer]: Set<Element>;
	// Each list marker paints at most once per frame.
	declare [kRenderedOutsideMarkers]: WeakSet<Element>;
	// Paint extents are cached in unscrolled rows. A scrolled subtree
	// paints this many rows higher, so culling shifts the band instead.
	declare [kScrolledRows]: number;

	constructor(
		document: Document,
		layout: Layout,
		cascade: Cascade,
		screen: Screen,
	) {
		this[kRenderedOutsideMarkers] = new WeakSet<Element>();
		this[kScrolledRows] = 0;
		this[kWindow] = document.defaultView as unknown as EngineWindow;
		this[kDocument] = document;
		this[kLayout] = layout;
		this[kCascade] = cascade;
		this[kScreen] = screen;
		this[kTopLayer] = getTopLayer(document) as unknown as Set<Element>;
	}

	paint(ctx: CellContext): void {
		this[kRenderedOutsideMarkers] = new WeakSet<Element>();
		this[kScrolledRows] = 0;
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
	// A subtree wholly outside the buffer's band would be styled, shaped
	// and drawn, then discarded cell by cell.
	const scrolledRows = painter[kScrolledRows];
	let bandTop = -ctx.viewportOffset + scrolledRows;
	let bandBottom = bandTop + ctx.rows;
	if (painter[kLayout].isSubtreeOutsideBand(element, bandTop, bandBottom)) {
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
		Boolean(backgroundColor) && /^canvas$/i.test(backgroundColor.trim());
	const isHighlightBox =
		Boolean(backgroundColor) && isSystemHighlightColor(backgroundColor);
	const style = {
		fg:
			color && color !== "initial" && !isSystemHighlightColor(color)
				? cssColorToNumber(color)
				: undefined,
		bg:
			backgroundColor &&
			!isCanvasBg &&
			backgroundColor !== "initial" &&
			!isTransparentColor(backgroundColor) &&
			!isSystemHighlightColor(backgroundColor)
				? cssColorToNumber(backgroundColor)
				: undefined,
	};

	if (rect && visible && (style.bg != null || isCanvasBg || isHighlightBox)) {
		const fill = isCanvasBg
			? "default"
			: isHighlightBox
				? "inverse"
				: style.bg;
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
			if (isTransparentColor(borderColor)) {
				return undefined;
			}
			return {
				style: line,
				color:
					borderColor &&
					borderColor !== "currentcolor" &&
					borderColor !== "currentColor"
						? cssColorToNumber(borderColor)
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
			const focus =
				record.direction === "backward" ? record.start : record.end;
			const node = getFieldValueText(element) ?? getGlyphText(element);
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
	// document roots' scrollTop is the camera, applied at
	// ctx.viewportOffset.
	const ownScrolledRows =
		element === painter[kDocument].body ||
		element === painter[kDocument].documentElement
			? 0
			: element.scrollTop || 0;
	bandTop += ownScrolledRows;
	bandBottom += ownScrolledRows;

	const children: Node[] = [];

	// For a plain vertical stack the layout tree knows which children are
	// in band. The walk below costs every sibling.
	const fastChildren = painter[kLayout].visibleChildrenInBand(
		element,
		bandTop,
		bandBottom,
	);
	if (fastChildren) {
		for (const childNode of fastChildren) {
			children.push(childNode);
		}
	} else {
		const walker = flowWalker(element);
		for (
			let childNode = walker.firstChild();
			childNode;
			childNode = walker.nextSibling()
		) {
			// Before any style read. An off-band child costs one lookup.
			if (
				childNode.nodeType === childNode.ELEMENT_NODE &&
				painter[kLayout].isSubtreeOutsideBand(
					childNode as Element,
					bandTop,
					bandBottom,
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
				if (childElement instanceof (painter[kWindow] as any).HTMLElement) {
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
			parseFloat(getComputedValue(element, "outline-width")) !== 0
		) {
			const outlineColor = getComputedValue(element, "outline-color")
				.trim()
				.toLowerCase();
			const hasColor =
				Boolean(outlineColor) &&
				outlineColor !== "currentcolor" &&
				outlineColor !== "invert" &&
				!isSystemHighlightColor(outlineColor);
			const sides = resolveBorderSides(element);
			if (sides.top || sides.right || sides.bottom || sides.left) {
				if (hasColor) {
					const ring = (
						line: LineStyle["style"] | undefined,
					): LineStyle | undefined =>
						line && {style: line, color: cssColorToNumber(outlineColor)};
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
				}
			} else {
				ctx.drawDecoration(
					Math.round(rect.left),
					Math.round(rect.bottom) - 1,
					Math.round(rect.width),
					hasColor
						? {underline: true, fg: cssColorToNumber(outlineColor)}
						: {underline: true},
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
		let ancestor = flatParentElement<Element>(element);
		ancestor && ancestor !== contextRoot;
		ancestor = flatParentElement<Element>(ancestor)
	) {
		if (!isPositioned(ancestor)) {
			continue;
		}
		const overflow = getComputedValue(ancestor, "overflow");
		const overflowX = getComputedValue(ancestor, "overflow-x") || overflow;
		const overflowY = getComputedValue(ancestor, "overflow-y") || overflow;
		if (overflowClips(overflowX) || overflowClips(overflowY)) {
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
		// Fixed space cancels the camera for the whole subtree. An absolute box
		// inside a fixed bar moves with it.
		if (painter[kLayout].isInFixedSpace(element)) {
			ctx.viewportOffset = previousOffset + painter[kScreen].scrollTop;
		}
		try {
			if (formsStackingContext(element)) {
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
	const markerItalic = getComputedValue(element, "font-style", "::marker") ===
		"italic";
	const markerUnderline = hasUnderline(
		getComputedValue(element, "text-decoration-line", "::marker"),
	);

	const markerTextStyle = {
		fg:
			markerColor && markerColor !== "initial"
				? cssColorToNumber(markerColor)
				: undefined,
		bold: markerBold,
		dim: markerDim,
		italic: markerItalic,
		underline: markerUnderline,
	};

	const markerX = Math.max(0, Math.round(rect.left) - markerWidth);
	const markerY = Math.round(rect.top);

	ctx.drawText(markerContent, markerX, markerY, markerTextStyle);
}

function getGlyphText(element: Element): Text | null {
	const root = getShadowRoot<ShadowRoot>(element);
	const glyph = root ? root.querySelector('[part="glyph"]') : null;
	return (glyph?.firstChild as Text | null) ?? null;
}

function renderText(
	painter: Painter,
	textNode: Text,
	ctx: CellContext,
): void {
	const textContent = textNode.data;
	if (!textContent) {
		return;
	}

	// The flat-tree parent. Slotted text inherits through the slot, not
	// the host.
	const parentElement = flatParentElement<Element>(textNode);
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
		renderTextSelection(painter, textNode, textStyle, textTransform, ctx);
	}
}

// A focused control's own selection when the node renders its value
// (the document selection cannot see inside a control), else the
// document's.
function getPaintSelectionRange(
	painter: Painter,
	textNode: Text,
): {range: Range; selectionParent: Element} | null {
	const field = getFieldSelectionRange(painter[kDocument], textNode);
	if (field) {
		// ::selection resolves on the field, not the shadow value span.
		return {range: field.range, selectionParent: field.field};
	}

	const selection = painter[kWindow].getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return null;
	}
	const getDocumentRange = selection.getRangeAt(0);
	if (!getDocumentRange.intersectsNode(textNode)) {
		return null;
	}
	const selectionParent = flatParentElement<Element>(textNode);
	if (!selectionParent) {
		return null;
	}
	if (!painter[kCascade].isSelectable(selectionParent)) {
		return null;
	}
	// Narrowed to this node. ::selection resolves per parent.
	const from =
		getDocumentRange.startContainer === textNode
			? getDocumentRange.startOffset
			: 0;
	const to =
		getDocumentRange.endContainer === textNode
			? getDocumentRange.endOffset
			: textNode.data.length;
	if (to <= from) {
		return null;
	}
	const range = textNode.ownerDocument.createRange();
	range.setStart(textNode, from);
	range.setEnd(textNode, to);
	return {range, selectionParent};
}

// Redraws the selected runs in the highlight style over the base pass.
function renderTextSelection(
	painter: Painter,
	textNode: Text,
	textStyle: CellStyle,
	textTransform: string,
	ctx: CellContext,
): void {
	const found = getPaintSelectionRange(painter, textNode);
	if (!found) {
		return;
	}
	const {range, selectionParent} = found;
	const selectionStyle = getSelectionStyle(selectionParent, textStyle);
	if (selectionStyle === textStyle) {
		return;
	}

	for (const run of painter[kLayout].getRangeRuns(range)) {
		ctx.drawText(
			applyTextTransform(run.text, textTransform),
			run.rect.x,
			run.rect.y,
			selectionStyle,
		);
	}
}
