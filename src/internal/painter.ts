/**
 * The paint walk: a document's boxes in paint order, resolved to styled cells.
 *
 * It reads the DOM, computed styles and geometry, and writes nothing but cells.
 */
import {isTextField, selectionRangeOf} from "./dom.js";
import type {EngineWindow} from "./termdom.js";
import {type LayoutEngine, flowWalker, isPositioned} from "./layout.js";
import type {Viewport} from "./viewport.js";
import {type StyleManager, resolveBorderSides} from "./styles.js";
import {cssColorToNumber, isTransparentColor} from "./color.js";
import {renderTextFragment} from "./text.js";
import {flatIsConnected, flatParentElement, shadowRootOf} from "./dom.js";
import {computedStyleOf, pseudoStyleOf, type ComputedStyle} from "./styles.js";
import type {CellStyle, CellContext, LineStyle} from "./ansi.js";

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
function hasUnderline(style: ComputedStyle): boolean {
	return style.computedValueOf("text-decoration-line").includes("underline");
}

/** Whether a computed style asks for a line-through (SGR strikethrough). */
function hasLineThrough(style: ComputedStyle): boolean {
	return style.computedValueOf("text-decoration-line").includes("line-through");
}

/**
 * The clip an overflow:hidden (or overflow-x/-y:hidden) element imposes on its
 * own children, intersected with whatever clip was already active from an
 * ancestor. overflow:auto/scroll/visible impose no clip on that axis -- there
 * are no scrollable containers, only the document camera, so "auto/scroll"
 * degrades to "visible" rather than clipping content nobody can scroll to see.
 * An axis that isn't hidden stays unbounded (+-Infinity), not just "this
 * element's own edge", so overflow-x:hidden;overflow-y:visible only bounds
 * columns, matching CSS's independent per-axis overflow.
 */
function overflowClipRect(
	rect: {left: number; top: number; width: number; height: number} | null,
	overflowX: string,
	overflowY: string,
	parent: ClipRect | null,
): ClipRect | null {
	if (!rect) {
		return parent;
	}
	const hiddenX = overflowX === "hidden";
	const hiddenY = overflowY === "hidden";
	if (!hiddenX && !hiddenY) {
		return parent;
	}

	const left = hiddenX ? rect.left : -Infinity;
	const right = hiddenX ? rect.left + rect.width : Infinity;
	const top = hiddenY ? rect.top : -Infinity;
	const bottom = hiddenY ? rect.top + rect.height : Infinity;

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
 */
function isSystemHighlightColor(value: string): boolean {
	return /^highlight(?:text)?$/i.test(value.trim());
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

/**
 * A computed style reduced to terminal cell attributes -- one mapping,
 * shared by text nodes and the input painter's shadow parts.
 */
function cellStyleFromComputed(
	computedStyle: ComputedStyle,
): CellStyle {
	const color = computedStyle.computedValueOf("color");
	const bgColor = computedStyle.computedValueOf("background-color");
	const {bold, dim} = resolveFontWeight(
		computedStyle.computedValueOf("font-weight"),
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
		italic: computedStyle.computedValueOf("font-style") === "italic",
		underline: hasUnderline(computedStyle),
		underlineStyle:
			computedStyle.computedValueOf("text-decoration-style") === "double" ?
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
	const declaration = pseudoStyleOf(element, "::selection");
	const fg = declaration.computedValueOf("color");
	const bg = declaration.computedValueOf("background-color");
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
const kViewport = Symbol("viewport");
const kTopLayer = Symbol("topLayer");
const kRenderedOutsideMarkers = Symbol("renderedOutsideMarkers");
const kRenderStackingContext = Symbol("renderStackingContext");
const kRenderBackdrop = Symbol("renderBackdrop");
const kRenderOutsideMarker = Symbol("renderOutsideMarker");
const kRenderToggleGlyph = Symbol("renderToggleGlyph");
const kRenderElement = Symbol("renderElement");
const kRenderText = Symbol("renderText");
const kPositionedClipFor = Symbol("positionedClipFor");
const kRenderTextSelection = Symbol("renderTextSelection");
const kSelectionRangeFor = Symbol("selectionRangeFor");

/**
 * The paint walk: the pure transformation of a laid-out DOM tree into terminal
 * cells. It reads geometry from the {@link LayoutEngine}, computed styles from
 * the {@link StyleManager} and the DOM, and form controls' shadow parts and caret
 * from the composed tree (the shell upgrades the widgets on connect, so their
 * shadow is already there), then draws into a `CellContext`. It owns no
 * scheduling and mutates no DOM -- callers hand it a fresh context and call
 * {@link Painter.paint}.
 *
 * Two pieces of render state are shared with TermDOM rather than owned here: the
 * top layer (the shell decides what is promoted; the walk only reads and prunes
 * disconnected members) and the per-field scroll offsets (the walk writes them
 * as it windows an overflowing value; hit-testing reads them back). Both arrive
 * by reference through the constructor.
 */
export class Painter {
	declare [kWindow]: EngineWindow;
	// The document, cached the way TermDOM caches it: a stray post-dispose frame
	// paints against this reference rather than reaching through a torn-down
	// window. The live window still serves getComputedStyle/getSelection.
	declare [kDocument]: Document;
	declare [kLayout]: LayoutEngine;
	declare [kStyleManager]: StyleManager;
	declare [kViewport]: Viewport;
	// Shared with TermDOM by reference -- see the class doc.
	declare [kTopLayer]: Set<Element>;
	// List markers already painted this frame; each renders at most once.
	declare [kRenderedOutsideMarkers]: WeakSet<Element>;

	constructor(deps: {
		window: EngineWindow;
		document: Document;
		layout: LayoutEngine;
		styleManager: StyleManager;
		viewport: Viewport;
		topLayer: Set<Element>;
	}) {
		this[kRenderedOutsideMarkers] = new WeakSet<Element>();
		this[kWindow] = deps.window;
		this[kDocument] = deps.document;
		this[kLayout] = deps.layout;
		this[kStyleManager] = deps.styleManager;
		this[kViewport] = deps.viewport;
		this[kTopLayer] = deps.topLayer;
	}

	/** The whole document: the root stacking context, then the top layer. */
	paint(ctx: CellContext): void {
		this[kRenderedOutsideMarkers] = new WeakSet<Element>();
		const layers = this[kLayout].collectStackingLayers(this[kTopLayer]);
		this[kRenderStackingContext](this[kDocument].body, ctx, layers);
		for (const element of this[kTopLayer]) {
			// COMPOSITION-connected: a UA part (the select's picker) lives in
			// a fragment and is never DOM-connected while very much on screen.
			if (!flatIsConnected(element)) {
				this[kTopLayer].delete(element);
				continue;
			}
			const previousClip = ctx.clipRect;
			ctx.clipRect = null;
			try {
				this[kRenderBackdrop](element, ctx);
				this[kRenderStackingContext](element, ctx, layers);
			} finally {
				ctx.clipRect = previousClip;
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
	[kRenderBackdrop](
		element: Element,
		ctx: CellContext,
	): void {
		const fill = backgroundFill(
			pseudoStyleOf(element, "::backdrop").computedValueOf("background-color"),
		);
		if (fill === null) {
			return;
		}
		// The viewport, in the document coordinates every draw call takes: the
		// band the buffer holds, which is where a fixed box paints too.
		ctx.drawRect(0, -ctx.viewportOffset, ctx.cols, ctx.rows, fill);
	}

	[kRenderElement](
		element: Element,
		ctx: CellContext,
		afterOwnBox?: () => void,
	): void {
		// Viewport culling. The buffer only keeps document rows in
		// [-viewportOffset, -viewportOffset + rows); a subtree whose paint extent
		// lies wholly outside that band would be walked -- styles computed, text
		// shaped, borders drawn -- and then discarded cell by cell. Skip it here
		// and the paint costs what is on screen, not what is in the document.
		// The enclosing band, for the child-enumeration queries below; the
		// per-band check culls precisely on recursion, and the context's cell
		// mask makes any overshoot harmless.
		let bandTop = -ctx.viewportOffset;
		let bandBottom = bandTop + ctx.rows;
		if (ctx.paintBands) {
			// Skip any subtree outside every band.
			let inside = false;
			bandTop = Infinity;
			bandBottom = -Infinity;
			for (const [start, end] of ctx.paintBands) {
				bandTop = Math.min(bandTop, start - ctx.viewportOffset);
				bandBottom = Math.max(bandBottom, end - ctx.viewportOffset);
				if (
					!this[kLayout].isSubtreeOutsideBand(
						element,
						start - ctx.viewportOffset,
						end - ctx.viewportOffset,
					)
				) {
					inside = true;
				}
			}
			if (!inside) {
				return;
			}
		} else if (
			this[kLayout].isSubtreeOutsideBand(element, bandTop, bandBottom)
		) {
			return;
		}

		// display:none generates NO box and no descendant boxes -- final, per
		// CSS. Stray run state under a hidden subtree (an editing todo's
		// hidden .view) could otherwise ghost-paint at whatever coordinates
		// it last held.
		// One computed-style read per element per paint; every property below
		// comes off this declaration.
		const computed = computedStyleOf(element);
		if (computed.computedValueOf("display") === "none") {
			return;
		}

		const rect = this[kLayout].getRect(element);

		const color = computed.computedValueOf("color");
		const backgroundColor = computed.computedValueOf("background-color");
		const {bold, dim} = resolveFontWeight(
			computed.computedValueOf("font-weight"),
		);
		const italic = computed.computedValueOf("font-style") === "italic";
		const underline = hasUnderline(computed);
		const underlineStyle =
			computed.computedValueOf("text-decoration-style") === "double" ?
					("double" as const) :
				undefined;
		// visibility:hidden reserves the box (layout is untouched) but paints
		// nothing of it -- unlike display:none, which removes the box entirely. A
		// descendant that sets visibility:visible still paints, since visibility
		// inherits and each element resolves its own computed value here.
		const visible = computed.computedValueOf("visibility") !== "hidden";

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
			bold,
			dim,
			italic,
			underline,
			underlineStyle,
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
			const fragments = this[kLayout].getRects(element);
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

		// Handle borders
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
				const borderColor = computed.computedValueOf(prop);
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

		// Handle list-style-position: outside markers
		if (visible) {
			this[kRenderOutsideMarker](element, ctx);
		}

		// A text field's content is its shadow tree, painted by the child walk
		// below; the rest is parking the caret at its Range position, falling back
		// to the content origin when the value is empty (no box for the Range).
		if (rect && visible && isTextField(element)) {
			const field = element as HTMLInputElement | HTMLTextAreaElement;
			if (field === this[kDocument].activeElement) {
				const caret = this[kLayout].caretRectOf(field);
				if (caret) {
					ctx.setCaret(caret.x, caret.y);
				} else {
					const content = this[kLayout].contentRect(field);
					if (content) {
						ctx.setCaret(Math.round(content.x), Math.round(content.y));
					}
				}
			}
		}

		// A select's content is its UA shadow tree (label + indicator + picker),
		// built on connect and painted by the normal child walk; an OPEN picker
		// (the widget shows it by flipping display) paints in the top layer, over
		// following content. Parking the caret at the field origin is the rest.
		if (element.tagName === "SELECT" && rect) {
			const select = element as HTMLSelectElement;
			const picker =
				shadowRootOf<ShadowRoot>(select)?.querySelector<HTMLElement>(
					'[part="picker"]',
				);
			// The widget flips the picker's display inline on open/close, so its
			// own intent reads straight off style.display -- no style resolution,
			// and exactly the open/closed signal the top-layer decision wants.
			if (picker) {
				if (picker.style.display !== "none") {
					this[kTopLayer].add(picker);
				} else {
					this[kTopLayer].delete(picker);
				}
			}
			if (visible && select === this[kDocument].activeElement) {
				const content = this[kLayout].contentRect(select);
				if (content) {
					ctx.setCaret(Math.round(content.x), Math.round(content.y));
				}
			}
		}

		// A checkbox/radio is a single glyph (kRenderToggleGlyph) with nothing to
		// walk; every other input is a text field, painted by the walk below.
		if (element.tagName === "INPUT" && rect) {
			const input = element as HTMLInputElement;
			if (input.type === "checkbox" || input.type === "radio") {
				if (visible) {
					this[kRenderToggleGlyph](input, ctx);
				}
				return;
			}
			if (input.type === "hidden") {
				return;
			}
		}

		// No manual lifecycle management needed

		// The stacking-context painter slots its negative-z layer here: after
		// this element's own background and border, before any of its in-flow
		// content -- the CSS position for negative z-index.
		if (afterOwnBox) {
			afterOwnBox();
		}

		// The IN-FLOW walk: children paint in tree order, and POSITIONED
		// children don't paint here at all -- per CSS they are hoisted to
		// their nearest stacking context and painted in its layer order (see
		// kRenderStackingContext). The old per-sibling z sort could never
		// let a deep overlay escape its parent's siblings; hoisting is what
		// makes a modal or dropdown paint over unrelated subtrees.
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
		const fastChildren = this[kLayout].visibleChildrenInBand(
			element,
			bandTop,
			bandBottom,
		);
		if (fastChildren) {
			for (const childNode of fastChildren) {
				children.push(childNode);
			}
		} else {
			// Use ExpandedTreeWalker to render all children including pseudo-elements and shadow DOM
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
					this[kLayout].isSubtreeOutsideBand(
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
					this[kLayout].positionedElements.has(childNode as Element)
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

		// overflow:hidden clips *descendants* to this element's own box -- never
		// the element's own border/background painted above, which is why this is
		// scoped to just the children, not the whole function.
		const overflow = computedStyleOf(element).computedValueOf("overflow");
		const overflowX =
			computedStyleOf(element).computedValueOf("overflow-x") || overflow;
		const overflowY =
			computedStyleOf(element).computedValueOf("overflow-y") || overflow;
		const previousClip = ctx.clipRect;
		ctx.clipRect = overflowClipRect(rect, overflowX, overflowY, previousClip);

		try {
			for (const childNode of children) {
				if (childNode.nodeType === childNode.ELEMENT_NODE) {
					const childElement = childNode as Element;
					if (childElement instanceof (this[kWindow] as any).HTMLElement) {
						this[kRenderElement](childElement, ctx);
					}
				} else if (childNode.nodeType === childNode.TEXT_NODE) {
					const textNode = childNode as Text;
					this[kRenderText](textNode, ctx);
				}
			}
		} finally {
			ctx.clipRect = previousClip;
		}

		// A focused textarea's own selection now paints inline while the child
		// walk lays down the value text -- kRenderTextSelection reads the
		// control's selectionStart/End, the same way it reads a document Range.

		// An `outline` paints last (a focus ring). A bordered box already has a
		// ring of glyphs at its perimeter, so the outline repaints them in the
		// outline color rather than underlining them. A borderless box gets an
		// underline along its bottom row in the same color. Bottom only:
		// overline (SGR 53) is unreliable.
		if (rect && visible) {
			const computed = computedStyleOf(element);
			const outlineStyle = computed.computedValueOf("outline-style");
			if (
				outlineStyle &&
				outlineStyle !== "none" &&
				parseFloat(computed.computedValueOf("outline-width")) !== 0
			) {
				const outlineColor = computed
					.computedValueOf("outline-color")
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
	[kPositionedClipFor](
		element: Element,
		contextRoot: Element,
		contextClip: CellContext["clipRect"],
	): CellContext["clipRect"] {
		let clip = contextClip;
		for (
			let ancestor = flatParentElement<Element>(element);
			ancestor && ancestor !== contextRoot;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			if (!isPositioned(ancestor)) {
				continue;
			}
			const style = computedStyleOf(ancestor);
			const overflow = style.computedValueOf("overflow");
			const overflowX = style.computedValueOf("overflow-x") || overflow;
			const overflowY = style.computedValueOf("overflow-y") || overflow;
			if (overflowX === "hidden" || overflowY === "hidden") {
				const rect = this[kLayout].getRect(ancestor);
				if (rect) {
					clip = overflowClipRect(rect, overflowX, overflowY, clip);
				}
			}
		}
		return clip;
	}

	/**
	 * Paint a stacking context in the CSS layer order: the root's own box,
	 * negative-z child contexts, in-flow content (the kRenderElement walk,
	 * which skips positioned descendants), the positioned z:auto/0 layer,
	 * then positive-z contexts. A z:auto member doesn't isolate: it paints
	 * as an in-flow subtree here while its own positioned descendants sit
	 * in THIS context's buckets. Deferred layers paint under the context
	 * root's clip -- a positioned box escapes overflow ancestors between
	 * itself and its context, the common CSS escape (per-containing-block
	 * clipping is layer-2 work).
	 */
	[kRenderStackingContext](
		root: Element,
		ctx: CellContext,
		layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
	): void {
		const bucket = layers.get(root);
		if (!bucket) {
			this[kRenderElement](root, ctx);
			return;
		}
		const contextClip = ctx.clipRect;
		const paintMember = (element: Element) => {
			const previousClip = ctx.clipRect;
			const previousOffset = ctx.viewportOffset;
			// Clips apply along the CONTAINING BLOCK chain only: an overflow
			// ancestor that isn't a positioned ancestor doesn't clip a
			// deferred box, but its own containing blocks' overflow does.
			ctx.clipRect = this[kPositionedClipFor](element, root, contextClip);
			// position:fixed anchors to the VIEWPORT: cancel the camera by
			// undoing the scroll offset for the whole subtree. Fixed-space is
			// a property of the containing-block CHAIN: an absolute box inside
			// a fixed bar is laid out against the bar's viewport coordinates
			// and must ride with it, so the walk includes ancestors.
			if (this[kLayout].isInFixedSpace(element)) {
				ctx.viewportOffset = previousOffset + this[kViewport].scrollTop;
			}
			try {
				if (this[kLayout].formsStackingContext(element)) {
					this[kRenderStackingContext](element, ctx, layers);
				} else {
					this[kRenderElement](element, ctx);
				}
			} finally {
				ctx.clipRect = previousClip;
				ctx.viewportOffset = previousOffset;
			}
		};
		this[kRenderElement](root, ctx, () => {
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
	[kRenderOutsideMarker](
		element: Element,
		ctx: CellContext,
	): void {
		const computedStyle = computedStyleOf(element);
		const display = computedStyle.computedValueOf("display");

		// Only handle list items
		if (display !== "list-item") {
			return;
		}

		const listStylePosition =
			computedStyle.computedValueOf("list-style-position") || "outside";

		// Only handle outside positioning
		if (listStylePosition !== "outside") {
			return;
		}

		// Prevent duplicate rendering in the same frame
		if (this[kRenderedOutsideMarkers].has(element)) {
			return;
		}
		this[kRenderedOutsideMarkers].add(element);

		// Get marker content from StyleManager
		const markerContent = this[kStyleManager].getMarkerContent(element);
		if (!markerContent) {
			return;
		}

		const rect = this[kLayout].getRect(element);
		if (!rect) {
			return;
		}

		// Cells, not code units: a marker like "日本 " is 3 characters but 5 cells
		// wide, and right-aligning it by its length would paint it over the item's
		// own text.
		const markerWidth = ctx.measureText(markerContent).width;

		// Get marker styles
		const markerStyle = pseudoStyleOf(element, "::marker");
		// ::marker inherits color from its originating element, so fall back to the
		// list item's own color rather than rendering the marker unstyled.
		const markerColor =
			markerStyle.computedValueOf("color") ||
			computedStyle.computedValueOf("color");
		const {bold: markerBold, dim: markerDim} = resolveFontWeight(
			markerStyle.computedValueOf("font-weight"),
		);
		const markerItalic = markerStyle.computedValueOf("font-style") === "italic";
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

		// Position marker just before the list item's content area (outside positioning)
		const markerX = Math.max(0, Math.round(rect.left) - markerWidth);
		const markerY = Math.round(rect.top);

		// Render the marker (clipped to available space, never mutate the DOM)
		ctx.drawText(markerContent, markerX, markerY, markerTextStyle);
	}

	/**
	 * Draw a checkbox or radio's glyph, and park the caret on it when it has
	 * focus.
	 *
	 * The mark is a text node the control writes when its checkedness moves, so
	 * what is drawn here is what the tree says rather than a state this read
	 * discovers -- a checkedness that changes without an event still schedules
	 * the frame that shows it.
	 */
	[kRenderToggleGlyph](
		element: HTMLInputElement,
		ctx: CellContext,
	): void {
		const root = shadowRootOf<ShadowRoot>(element);
		if (!root) {
			return;
		}
		const glyphSpan = root.querySelector('[part="glyph"]');
		if (glyphSpan === null) {
			return;
		}
		const glyphText = glyphSpan.firstChild as Text | null;
		const mark = glyphText === null ? undefined : glyphText.data;
		if (!mark) {
			return;
		}
		const content = this[kLayout].contentRect(element);
		if (!content) {
			return;
		}
		const contentX = Math.round(content.x);
		const contentY = Math.round(content.y);
		ctx.drawText(
			mark,
			contentX,
			contentY,
			cellStyleFromComputed(computedStyleOf(glyphSpan)),
		);
		if (element === this[kDocument].activeElement) {
			ctx.setCaret(contentX, contentY);
		}
	}

	/**
	 * Render a text node with proper styling from its parent element or pseudo-element
	 */
	[kRenderText](textNode: Text, ctx: CellContext): void {
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

		const computedStyle: ComputedStyle = computedStyleOf(parentElement);

		// visibility inherits, so the parent's own resolved value already accounts
		// for a closer ancestor overriding back to visible.
		if (computedStyle.computedValueOf("visibility") === "hidden") {
			return;
		}

		const textTransform = computedStyle.computedValueOf("text-transform");
		const textStyle = cellStyleFromComputed(computedStyle);

		// One fragment per line the node covers -- the same geometry
		// `Range.getClientRects()` reports over the node -- each carrying the
		// range of `data` its line renders. The characters to draw come from the
		// node itself, rendered under its own `white-space` and then transformed:
		// nothing of the line breaker's is read here.
		const whiteSpace = computedStyle.computedValueOf("white-space");
		const fragments = this[kLayout].lineFragments(textNode);
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
			this[kRenderTextSelection](textNode, textStyle, textTransform, ctx);
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
	[kSelectionRangeFor](
		textNode: Text,
	): {range: Range; selectionParent: Element} | null {
		const active = this[kDocument].activeElement;
		if (active && isTextField(active)) {
			const fieldRange = selectionRangeOf(active);
			// The control's range names the text it renders its value through, so
			// node identity is the whole test -- no widget anatomy to know.
			if (fieldRange && fieldRange.startContainer === textNode) {
				// ::selection resolves on the field host (`input::selection`), not
				// the shadow value span.
				return {range: fieldRange, selectionParent: active};
			}
		}

		const selection = this[kWindow].getSelection();
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
	 * The selected Range comes from kSelectionRangeFor; the runs' rects and text
	 * come from the layout's Range geometry, so the painter does no offset math.
	 * Case transforms never change cell width, so transforming each run's raw
	 * text repaints exactly the cells the base pass laid down.
	 */
	[kRenderTextSelection](
		textNode: Text,
		textStyle: CellStyle,
		textTransform: string,
		ctx: CellContext,
	): void {
		const found = this[kSelectionRangeFor](textNode);
		if (!found) {
			return;
		}
		const {range, selectionParent} = found;
		const selectionStyle = selectionStyleFor(selectionParent, textStyle);
		if (selectionStyle === textStyle) {
			return;
		} // no ::selection rule reaches here

		for (const run of this[kLayout].getRangeRuns(range)) {
			ctx.drawText(
				applyTextTransform(run.text, textTransform),
				run.rect.x,
				run.rect.y,
				selectionStyle,
			);
		}
	}
}
