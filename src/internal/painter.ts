/**
 * The paint walk: a document's boxes in paint order, resolved to styled cells.
 *
 * It reads the DOM, computed styles and geometry, changes none of them, and
 * writes only into the CellContext it is handed. Start at Painter.paint and
 * follow the three functions under it: renderStackingContext puts the layers
 * of one stacking context in CSS order, renderElement paints one box and walks
 * its in-flow children, and renderText draws the runs inside it.
 */
import {
	type EngineWindow,
	fieldValueText,
	flatParentElement,
	getSelectionRange,
	getShadowRoot,
	isTextField,
	renderedTopLayer,
	selectionRecordOf,
} from "./dom.js";
import {
	type LayoutEngine,
	flowWalker,
	isPositioned,
	renderTextFragment,
} from "./layout.js";
import {
	type ComputedValues,
	type StyleManager,
	getComputedValues,
	getBoxModel,
	getPseudoStyle,
	resolveBorderSides,
	cssColorToNumber,
	isTransparentColor,
} from "./cssom.js";
import type {CellStyle, CellContext, LineStyle} from "./screen.js";

/**
 * A clip in EDGE coordinates, not origin+size, and deliberately not a DOMRect:
 * an axis that nothing clips is unbounded, and the only honest spelling of
 * that is -Infinity to +Infinity. A DOMRect would have to store it as
 * `x: -Infinity, width: Infinity`, whose `right` is then `NaN` -- which every
 * intersection downstream would silently propagate.
 */
type ClipRect = {left: number; top: number; right: number; bottom: number};

/**
 * Whether a computed style asks for an underline.
 *
 * `text-decoration` is a shorthand whose value lives in the longhands, so an
 * author writing `text-decoration-line: underline` leaves the shorthand
 * computing to "none" -- and reading only the shorthand meant the longhand did
 * nothing at all. Read the longhand first, since it is where the value is, and
 * fall back to the shorthand for the styles that set it that way.
 */
function hasUnderline(style: ComputedValues): boolean {
	return style.getComputedValue("text-decoration-line").includes("underline");
}

/** Whether a computed style asks for a line-through (SGR strikethrough). */
function hasLineThrough(style: ComputedValues): boolean {
	return style
		.getComputedValue("text-decoration-line")
		.includes("line-through");
}

/** Whether an overflow value clips its axis: everything but visible does. */
function overflowClips(value: string): boolean {
	return (
		value === "hidden" ||
		value === "clip" ||
		value === "auto" ||
		value === "scroll"
	);
}

/**
 * The clip a non-visible overflow (hidden/clip, and auto/scroll -- a scroll
 * container clips what is scrolled out of it) imposes on the element's own
 * children, intersected with whatever clip was already active from an
 * ancestor. The clip is the PADDING box: content scrolled past the edge must
 * not paint over the border glyphs, so each clipping axis is inset by that
 * side's border. An axis that stays visible is unbounded (+-Infinity), not
 * just "this element's own edge", so overflow-x:hidden;overflow-y:visible
 * only bounds columns, matching CSS's independent per-axis overflow.
 */
function overflowClipRect(
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

/**
 * The terminal has exactly three font weights, and CSS names all three:
 * light maps to SGR faint (dim), normal to nothing, bold to SGR bold.
 * Numeric values follow the CSS scale (100-300 light, 600+ bold). The
 * relative keywords resolve absolutely rather than against the parent's
 * weight -- an approximation, documented rather than hidden: "bolder" from
 * a bold parent cannot get bolder on a terminal anyway.
 */
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

/**
 * Highlight / HighlightText -- the system-color pair whose combined
 * meaning on a terminal is "swap the cell's colors", SGR inverse.
 * SelectedItem / SelectedItemText name the same thing on a non-text
 * selection (a chosen option, a picked row), so the pair rides the same
 * pathway.
 */
function isSystemHighlightColor(value: string): boolean {
	return /^(?:highlight|selecteditem)(?:text)?$/i.test(value.trim());
}

/**
 * A background-color as `drawRect` takes it: the two system colors keep their
 * terminal meanings (Canvas the terminal's own background, Highlight a swap of
 * each cell's colors), every other color is its cells' background, and a
 * background that paints nothing answers null.
 */
function backgroundFill(value: string): number | "default" | "inverse" | null {
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

/** A computed style reduced to the cell attributes a text run draws with. */
function cellStyleFromComputed(
	computedStyle: ComputedValues,
): CellStyle {
	const color = computedStyle.getComputedValue("color");
	const bgColor = computedStyle.getComputedValue("background-color");
	const {bold, dim} = resolveFontWeight(
		computedStyle.getComputedValue("font-weight"),
	);
	// background-color: Highlight is CSS's spelling of "swap the cell's
	// colors": SGR inverse, the terminal-native highlight with no color
	// assumptions -- the same translation ::selection's resolver makes.
	// The background alone carries the signal, so an author color on the
	// element (a restyled link keeping its UA focus ring) does not defeat
	// it; color: HighlightText alone resolves to nothing.
	const isHighlightPair = isSystemHighlightColor(bgColor);
	return {
		fg:
			color && color !== "initial" && !isSystemHighlightColor(color) ?
					cssColorToNumber(color) :
				undefined,
		bg:
			bgColor &&
			bgColor !== "initial" &&
			!isTransparentColor(bgColor) &&
			!/^canvas$/i.test(bgColor.trim()) &&
			!isSystemHighlightColor(bgColor) ?
					cssColorToNumber(bgColor) :
				undefined,
		inverse: isHighlightPair || undefined,
		bold,
		dim,
		italic: computedStyle.getComputedValue("font-style") === "italic",
		underline: hasUnderline(computedStyle),
		underlineStyle:
			computedStyle.getComputedValue("text-decoration-style") === "double" ?
					("double" as const) :
				undefined,
		strikethrough: hasLineThrough(computedStyle),
	};
}

/**
 * The style a selection highlight paints with, over `base`. Everything
 * comes from ::selection rules -- there is no built-in fallback. The UA
 * document sheet declares the Highlight/HighlightText system-color
 * pair, which is CSS's spelling of "swap the cell's colors" and
 * translates to SGR 7 (inverse), the terminal-native highlight with no
 * color assumptions; author colors replace the system keywords through
 * the ordinary cascade. An element no ::selection rule reaches paints
 * no highlight at all -- the UA rule is load-bearing.
 */
function selectionStyleFor(
	element: Element,
	base: CellStyle,
): CellStyle {
	const declaration = getPseudoStyle(element, "::selection");
	const fg = declaration.getComputedValue("color");
	const bg = declaration.getComputedValue("background-color");
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

/**
 * Apply CSS `text-transform` at paint time, not layout time. Every character
 * occupies the same cell width regardless of case in a terminal, so unlike a
 * browser's proportional font this can never change line wrapping -- there's
 * no need to re-measure, just transform the already-shaped text right before
 * it's drawn.
 */
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
const kStyleManager = Symbol("styleManager");
const kScrollTop = Symbol("scrollTop");
const kTopLayer = Symbol("topLayer");
const kRenderedOutsideMarkers = Symbol("renderedOutsideMarkers");
const kScrolledRows = Symbol("scrolledRows");

/**
 * The paint walk: the pure transformation of a laid-out DOM tree into terminal
 * cells. It reads geometry from the {@link LayoutEngine}, computed styles from
 * the {@link StyleManager} and the DOM, and form controls' shadow parts and caret
 * from the composed tree (the shell upgrades the widgets on connect, so their
 * shadow is already there), then draws into a `CellContext`. It owns no
 * scheduling and mutates no DOM -- callers hand it a fresh context and call
 * {@link Painter.paint}.
 *
 * The top layer is the one piece of render state shared with TermDOM rather
 * than owned here: the shell decides what is promoted, and the walk only reads
 * it, passing over a member that has left the flat tree rather than dropping
 * it. It arrives by reference through the constructor.
 */
export class Painter {
	declare [kWindow]: EngineWindow;
	// The document, cached the way TermDOM caches it: a stray post-dispose frame
	// paints against this reference rather than reaching through a torn-down
	// window. The live window still serves getComputedStyle/getSelection.
	declare [kDocument]: Document;
	declare [kLayout]: LayoutEngine;
	declare [kStyleManager]: StyleManager;
	// The document camera, read at paint time: a fixed subtree is laid out in
	// viewport space and paints where the camera is looking.
	declare [kScrollTop]: () => number;
	// Shared with TermDOM by reference -- see the class doc.
	declare [kTopLayer]: Set<Element>;
	// List markers already painted this frame; each renders at most once.
	declare [kRenderedOutsideMarkers]: WeakSet<Element>;
	// The rows the walk's ancestor scroll boxes have scrolled so far. Paint
	// extents are cached in unscrolled layout rows while a scrolled subtree
	// paints that many rows higher, so every band-culling comparison moves
	// the band by this amount instead of the extents.
	declare [kScrolledRows]: number;

	constructor(deps: {
		window: EngineWindow;
		document: Document;
		layout: LayoutEngine;
		styleManager: StyleManager;
		scrollTop: () => number;
		topLayer: Set<Element>;
	}) {
		this[kRenderedOutsideMarkers] = new WeakSet<Element>();
		this[kScrolledRows] = 0;
		this[kWindow] = deps.window;
		this[kDocument] = deps.document;
		this[kLayout] = deps.layout;
		this[kStyleManager] = deps.styleManager;
		this[kScrollTop] = deps.scrollTop;
		this[kTopLayer] = deps.topLayer;
	}

	/** The whole document: the root stacking context, then the top layer. */
	paint(ctx: CellContext): void {
		this[kRenderedOutsideMarkers] = new WeakSet<Element>();
		this[kScrolledRows] = 0;
		const layers = this[kLayout].collectStackingLayers(this[kTopLayer]);
		renderStackingContext(this, this[kDocument].body, ctx, layers);
		const rendered = renderedTopLayer(this[kDocument]) as unknown as Element[];
		for (const element of rendered) {
			const previousClip = ctx.clipRect;
			ctx.clipRect = null;
			// A top-layer element enters the walk from outside its ancestor
			// chain; seed the culling shift its scrolled ancestors impose.
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

/**
 * The ::backdrop of a top-layer element: the box between it and everything
 * the document already painted, covering the viewport. Like ::selection,
 * it has no node of its own -- what it paints comes entirely from the
 * ::backdrop rules the cascade resolves, the UA sheet's included, so an
 * author writing `dialog::backdrop { background-color: ... }` replaces the
 * scrim and one writing `transparent` removes it.
 */
function renderBackdrop(element: Element, ctx: CellContext): void {
	const fill = backgroundFill(
		getPseudoStyle(element, "::backdrop").getComputedValue("background-color"),
	);
	if (fill === null) {
		return;
	}
	// The viewport, in the document coordinates every draw call takes: the
	// band the buffer holds, which is where a fixed box paints too.
	ctx.drawRect(0, -ctx.viewportOffset, ctx.cols, ctx.rows, fill);
}

function renderElement(
	painter: Painter,
	element: Element,
	ctx: CellContext,
	afterOwnBox?: () => void,
): void {
	// Viewport culling. The buffer only keeps document rows in
	// [-viewportOffset, -viewportOffset + rows); a subtree whose paint extent
	// lies wholly outside that band would be walked -- styles computed, text
	// shaped, borders drawn -- and then discarded cell by cell. Skip it here
	// and the paint costs what is on screen, not what is in the document.
	// Extents are cached in unscrolled layout rows; a subtree inside scrolled
	// boxes paints that many rows higher, so the band moves down instead.
	const scrolledRows = painter[kScrolledRows];
	let bandTop = -ctx.viewportOffset + scrolledRows;
	let bandBottom = bandTop + ctx.rows;
	if (painter[kLayout].isSubtreeOutsideBand(element, bandTop, bandBottom)) {
		return;
	}

	// One computed-style read per element per paint; every property below
	// comes off this declaration.
	const computed = getComputedValues(element);
	// display:none generates NO box and no descendant boxes -- final, per
	// CSS. Stray run state under a hidden subtree (an editing todo's hidden
	// .view) could otherwise ghost-paint at whatever coordinates it last held.
	if (computed.getComputedValue("display") === "none") {
		return;
	}

	const rect = painter[kLayout].getRect(element);

	const color = computed.getComputedValue("color");
	const backgroundColor = computed.getComputedValue("background-color");
	// visibility:hidden reserves the box (layout is untouched) but paints
	// nothing of it -- unlike display:none, which removes the box entirely. A
	// descendant that sets visibility:visible still paints, since visibility
	// inherits and each element resolves its own computed value here.
	const visible = computed.getComputedValue("visibility") !== "hidden";

	// background-color: Canvas -- the CSS system color for the document
	// background -- clears the box to the terminal's DEFAULT background:
	// opaque in every theme without asserting any color, the same
	// system-color translation ::selection's Highlight pair uses. The UA
	// picker sheet relies on it; authors can too. background-color:
	// Highlight fills the box with SGR inverse instead -- the browser's
	// blue dropdown row, in the terminal's own colors. The background
	// alone carries the signal: an author color on the element (a
	// restyled link keeping its UA focus ring) must not defeat it.
	const isCanvasBg =
		Boolean(backgroundColor) && /^canvas$/i.test(backgroundColor.trim());
	const isHighlightBox =
		Boolean(backgroundColor) && isSystemHighlightColor(backgroundColor);
	// Only the two colors: an element's own box is a background fill and a
	// border ring, and the weight, slant and decorations it computes reach the
	// terminal through the text runs inside it, never through the box.
	const style = {
		fg:
			color && color !== "initial" && !isSystemHighlightColor(color) ?
					cssColorToNumber(color) :
				undefined,
		bg:
			backgroundColor &&
			!isCanvasBg &&
			backgroundColor !== "initial" &&
			!isTransparentColor(backgroundColor) &&
			!isSystemHighlightColor(backgroundColor) ?
					cssColorToNumber(backgroundColor) :
				undefined,
	};

	if (rect && visible && (style.bg != null || isCanvasBg || isHighlightBox)) {
		const fill = isCanvasBg ?
			"default" :
			isHighlightBox ?
				"inverse" :
				style.bg;
		// A box that broke across lines has a fragment on each of them, and
		// its background belongs to those fragments rather than to the
		// rectangle enclosing them: the enclosing one covers the whole width
		// of every line it spans, including the cells before the box begins
		// and after it ends, which are its neighbours' to paint. A box that
		// did not break has one fragment and fills it.
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
		// Border color per CSS: each side's border-<side>-color, whose
		// initial value is currentColor -- the element's own color -- and,
		// with nothing authored anywhere, the terminal's DEFAULT
		// foreground. Never a hardcoded white: no theme-safe color exists,
		// and forcing one breaks light terminals. A transparent side
		// reserves its layout space but paints no glyph -- the browser
		// behavior authors use for invisible spacing borders; layout reads
		// the widths elsewhere and is unaffected.
		const sideFor = (
			line: LineStyle["style"] | undefined,
			prop: string,
		): LineStyle | undefined => {
			if (!line) {
				return undefined;
			}
			const borderColor = computed.getComputedValue(prop);
			if (isTransparentColor(borderColor)) {
				return undefined;
			}
			return {
				style: line,
				color:
					borderColor &&
					borderColor !== "currentcolor" &&
					borderColor !== "currentColor" ?
							cssColorToNumber(borderColor) :
						style.fg,
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

	// The ACTIVE element wears the terminal cursor at the focus of its
	// selection: a field's caret, a select's label, a toggle's glyph. The
	// record and the closed tree come through the UA-side accessors; the
	// geometry is the measurement any Range takes. The content origin stands
	// in when the focus has no box (an empty value); an element with no
	// selection record leaves the cursor where the frame parked it.
	if (rect && visible && element === painter[kDocument].activeElement) {
		const record = selectionRecordOf(element);
		if (record !== null) {
			const focus =
				record.direction === "backward" ? record.start : record.end;
			const node = fieldValueText(element) ?? getGlyphText(element);
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

	// The stacking-context painter slots its negative-z layer here: after
	// this element's own background and border, before any of its in-flow
	// content -- the CSS position for negative z-index.
	if (afterOwnBox) {
		afterOwnBox();
	}

	// The IN-FLOW walk: children paint in tree order, and POSITIONED
	// children don't paint here at all -- per CSS they are hoisted to
	// their nearest stacking context and painted in its layer order (see
	// renderStackingContext). That hoist is what lets a modal or a dropdown
	// paint over subtrees unrelated to its parent's siblings.
	// The element's own scroll shifts its children, not itself: the child
	// walk below culls against the band moved by that much more, and the
	// walk state carries the accumulated shift to every descendant. The
	// document roots' scrollTop is the camera, applied at ctx.viewportOffset,
	// never here.
	const ownScrolledRows =
		element === painter[kDocument].body ||
		element === painter[kDocument].documentElement ?
			0 :
			element.scrollTop || 0;
	bandTop += ownScrolledRows;
	bandBottom += ownScrolledRows;

	const children: Node[] = [];

	// Fast path: for a plain vertically-stacked container (no position:
	// relative/absolute child, no flex-direction other than column -- see
	// visibleChildrenInBand's own doc comment for exactly what that rules
	// out), the layout tree already knows which children are in band
	// without visiting the rest to rule them out. Without it, a long list
	// scrolled to any depth costs O(total children) per frame -- worse
	// the longer the list gets, though only ~O(screen) of it can ever be
	// visible -- because the walker below has no choice but to step
	// through every sibling to find out which ones are off-band.
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
			// Cull before any style read: an off-band child costs one map
			// lookup instead of a computed-style resolution, which is what keeps a
			// wide container of mostly off-screen children O(screen).
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
				isPositioned(childNode as Element) &&
				painter[kLayout].positionedElements.has(childNode as Element)
			) {
				// Hoisted to its stacking context. Registry membership is
				// the gate: a positioned INLINE run member owns no box of
				// its own -- no layer would ever paint it, so it stays with
				// its run (offsets on run members are an unsupported edge).
				continue;
			}
			children.push(childNode);
		}
	}

	// A non-visible overflow clips *descendants* to this element's own box --
	// never the element's own border/background painted above, which is why
	// this is scoped to just the children, not the whole function.
	const overflow = computed.getComputedValue("overflow");
	const overflowX = computed.getComputedValue("overflow-x") || overflow;
	const overflowY = computed.getComputedValue("overflow-y") || overflow;
	const previousClip = ctx.clipRect;
	ctx.clipRect = overflowClipRect(
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

	// An `outline` paints last (a focus ring). A bordered box already has a
	// ring of glyphs at its perimeter, so the outline repaints them in the
	// outline color rather than underlining them. A borderless box gets an
	// underline along its bottom row in the same color. Bottom only:
	// overline (SGR 53) is unreliable.
	if (rect && visible) {
		const outlineStyle = computed.getComputedValue("outline-style");
		if (
			outlineStyle &&
			outlineStyle !== "none" &&
			parseFloat(computed.getComputedValue("outline-width")) !== 0
		) {
			const outlineColor = computed
				.getComputedValue("outline-color")
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
					hasColor ?
							{underline: true, fg: cssColorToNumber(outlineColor)} :
							{underline: true},
				);
			}
		}
	}
}

/**
 * The clip a deferred positioned box paints under: the context root's
 * clip, intersected with every overflow-clipping box along the CSS
 * containing-block chain (its positioned ancestors up to the context
 * root) -- and nothing else: intervening non-positioned overflow
 * ancestors don't clip a box they don't contain.
 */
function positionedClipFor(
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
		const style = getComputedValues(ancestor);
		const overflow = style.getComputedValue("overflow");
		const overflowX = style.getComputedValue("overflow-x") || overflow;
		const overflowY = style.getComputedValue("overflow-y") || overflow;
		if (overflowClips(overflowX) || overflowClips(overflowY)) {
			const rect = painter[kLayout].getRect(ancestor);
			if (rect) {
				clip = overflowClipRect(ancestor, rect, overflowX, overflowY, clip);
			}
		}
	}
	return clip;
}

/**
 * Paint a stacking context in the CSS layer order: the root's own box,
 * negative-z child contexts, in-flow content (the renderElement walk,
 * which skips positioned descendants), the positioned z:auto/0 layer,
 * then positive-z contexts. A z:auto member doesn't isolate: it paints
 * as an in-flow subtree here while its own positioned descendants sit
 * in THIS context's buckets. Deferred layers paint under the context
 * root's clip -- a positioned box escapes overflow ancestors between
 * itself and its context, the common CSS escape (per-containing-block
 * clipping is layer-2 work).
 */
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
		// Clips apply along the CONTAINING BLOCK chain only: an overflow
		// ancestor that isn't a positioned ancestor doesn't clip a
		// deferred box, but its own containing blocks' overflow does.
		ctx.clipRect = positionedClipFor(painter, element, root, contextClip);
		// A hoisted box enters the walk from its stacking context, not its
		// ancestor chain: re-derive the culling shift its own scrolled
		// ancestors impose rather than inheriting the context root's.
		painter[kScrolledRows] = painter[kLayout].scrolledAncestorRows(element);
		// position:fixed anchors to the VIEWPORT: cancel the camera by
		// undoing the scroll offset for the whole subtree. Fixed-space is
		// a property of the containing-block CHAIN: an absolute box inside
		// a fixed bar is laid out against the bar's viewport coordinates
		// and must ride with it, so the walk includes ancestors.
		if (painter[kLayout].isInFixedSpace(element)) {
			ctx.viewportOffset = previousOffset + painter[kScrollTop]();
		}
		try {
			if (painter[kLayout].formsStackingContext(element)) {
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

/** Render outside-positioned list markers, once per element per frame. */
function renderOutsideMarker(
	painter: Painter,
	element: Element,
	ctx: CellContext,
): void {
	const computedStyle = getComputedValues(element);
	const display = computedStyle.getComputedValue("display");

	if (display !== "list-item") {
		return;
	}

	const listStylePosition =
		computedStyle.getComputedValue("list-style-position") || "outside";

	if (listStylePosition !== "outside") {
		return;
	}

	if (painter[kRenderedOutsideMarkers].has(element)) {
		return;
	}
	painter[kRenderedOutsideMarkers].add(element);

	const markerContent = painter[kStyleManager].getMarkerContent(element);
	if (!markerContent) {
		return;
	}

	const rect = painter[kLayout].getRect(element);
	if (!rect) {
		return;
	}

	// Cells, not code units: a marker like "日本 " is 3 characters but 5 cells
	// wide, and right-aligning it by its length would paint it over the item's
	// own text.
	const markerWidth = ctx.measureText(markerContent).width;

	const markerStyle = getPseudoStyle(element, "::marker");
	// ::marker inherits color from its originating element, so fall back to the
	// list item's own color rather than rendering the marker unstyled.
	const markerColor =
		markerStyle.getComputedValue("color") ||
		computedStyle.getComputedValue("color");
	const {bold: markerBold, dim: markerDim} = resolveFontWeight(
		markerStyle.getComputedValue("font-weight"),
	);
	const markerItalic = markerStyle.getComputedValue("font-style") === "italic";
	const markerUnderline = hasUnderline(markerStyle);

	const markerTextStyle = {
		fg:
			markerColor && markerColor !== "initial" ?
					cssColorToNumber(markerColor) :
				undefined,
		bold: markerBold,
		dim: markerDim,
		italic: markerItalic,
		underline: markerUnderline,
	};

	const markerX = Math.max(0, Math.round(rect.left) - markerWidth);
	const markerY = Math.round(rect.top);

	ctx.drawText(markerContent, markerX, markerY, markerTextStyle);
}

/** The text a toggle's glyph renders through, from its closed tree. */
function getGlyphText(element: Element): Text | null {
	const root = getShadowRoot<ShadowRoot>(element);
	const glyph = root ? root.querySelector('[part="glyph"]') : null;
	return (glyph?.firstChild as Text | null) ?? null;
}

/** Draw a text node's fragments, in the style its flat-tree parent computes. */
function renderText(
	painter: Painter,
	textNode: Text,
	ctx: CellContext,
): void {
	const textContent = textNode.data;
	if (!textContent) {
		return;
	}

	// The FLAT-tree parent: slotted bare text draws its inherited styles
	// through the slot's shadow chain, not from the host it came from, and
	// the text of a pseudo-element draws the pseudo-element's own.
	const parentElement = flatParentElement<Element>(textNode);
	if (!parentElement) {
		return;
	}

	const computedStyle: ComputedValues = getComputedValues(parentElement);

	// visibility inherits, so the parent's own resolved value already accounts
	// for a closer ancestor overriding back to visible.
	if (computedStyle.getComputedValue("visibility") === "hidden") {
		return;
	}

	const textTransform = computedStyle.getComputedValue("text-transform");
	const textStyle = cellStyleFromComputed(computedStyle);

	// One fragment per line the node covers -- the same geometry
	// `Range.getClientRects()` reports over the node -- each carrying the
	// range of `data` its line renders. The characters to draw come from the
	// node itself, rendered under its own `white-space` and then transformed:
	// nothing of the line breaker's is read here.
	const whiteSpace = computedStyle.getComputedValue("white-space");
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

/**
 * The Range to highlight over a text node, and the element whose ::selection
 * rules style it. Two sources, one shape: a focused form control's own
 * selection when this text node is the one the control renders its value
 * through -- getSelection() cannot see inside a control, per spec, so the
 * control hands its selection out as a Range of its own -- otherwise the
 * document selection.
 */
function selectionRangeFor(
	painter: Painter,
	textNode: Text,
): {range: Range; selectionParent: Element} | null {
	const active = painter[kDocument].activeElement;
	if (active && isTextField(active)) {
		const fieldRange = getSelectionRange(active);
		// The control's range names the text it renders its value through, so
		// node identity is the whole test -- no widget anatomy to know.
		if (fieldRange && fieldRange.startContainer === textNode) {
			// ::selection resolves on the field host (`input::selection`), not
			// the shadow value span.
			return {range: fieldRange, selectionParent: active};
		}
	}

	const selection = painter[kWindow].getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return null;
	}
	const documentRange = selection.getRangeAt(0);
	if (!documentRange.intersectsNode(textNode)) {
		return null;
	}
	const selectionParent = flatParentElement<Element>(textNode);
	if (!selectionParent) {
		return null;
	}
	// user-select: none keeps this node's text out of the selection, so no
	// share of the highlight lands on it either.
	if (!painter[kStyleManager].isSelectable(selectionParent)) {
		return null;
	}
	// Narrowed to this node: ::selection resolves per node's parent, so each
	// node's share of the selection is painted in its own style.
	const from =
		documentRange.startContainer === textNode ? documentRange.startOffset : 0;
	const to =
		documentRange.endContainer === textNode ?
			documentRange.endOffset :
			textNode.data.length;
	if (to <= from) {
		return null;
	}
	const range = textNode.ownerDocument.createRange();
	range.setStart(textNode, from);
	range.setEnd(textNode, to);
	return {range, selectionParent};
}

/**
 * Overlay the selection on a text node as inverse video (or the author's
 * ::selection colors) by redrawing its selected runs in the highlight style.
 * The selected Range comes from selectionRangeFor; the runs' rects and text
 * come from the layout's Range geometry, so the painter does no offset math.
 * Case transforms never change cell width, so transforming each run's raw
 * text repaints exactly the cells the base pass laid down.
 */
function renderTextSelection(
	painter: Painter,
	textNode: Text,
	textStyle: CellStyle,
	textTransform: string,
	ctx: CellContext,
): void {
	const found = selectionRangeFor(painter, textNode);
	if (!found) {
		return;
	}
	const {range, selectionParent} = found;
	const selectionStyle = selectionStyleFor(selectionParent, textStyle);
	// Nothing came back changed, so no ::selection rule reaches this node.
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
