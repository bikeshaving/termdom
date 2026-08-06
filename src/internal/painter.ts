import {type DOMWindow} from "jsdom";
import {type LayoutEngine, isPositioned} from "./layout.js";
import {type Viewport} from "./viewport.js";
import {type StyleManager, resolveBorderStyles, getBoxModel} from "./styles.js";
import {cssColorToNumber} from "./color.js";
import {stringWidth} from "./text.js";
import {
	compositionIsConnected,
	compositionParentElement,
	compositionShadowRoot,
	createExpandedTreeWalker,
	fieldCaretRange,
	getPseudoMetadata,
} from "./composition.js";

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
function hasUnderline(style: CSSStyleDeclaration): boolean {
	const line = style.getPropertyValue("text-decoration-line");
	if (line) return line.includes("underline");
	return style.getPropertyValue("text-decoration").includes("underline");
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
	if (!rect) return parent;
	const hiddenX = overflowX === "hidden";
	const hiddenY = overflowY === "hidden";
	if (!hiddenX && !hiddenY) return parent;

	const left = hiddenX ? rect.left : -Infinity;
	const right = hiddenX ? rect.left + rect.width : Infinity;
	const top = hiddenY ? rect.top : -Infinity;
	const bottom = hiddenY ? rect.top + rect.height : Infinity;

	if (!parent) return {left, top, right, bottom};
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
		if (numeric >= 600) return {bold: true, dim: false};
		if (numeric <= 300) return {bold: false, dim: true};
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
 * A computed style reduced to terminal cell attributes -- one mapping,
 * shared by text nodes and the input painter's shadow parts.
 */
function cellStyleFromComputed(
	computedStyle: CSSStyleDeclaration,
): import("./ansi.js").CellStyle {
	const color = computedStyle.getPropertyValue("color");
	const bgColor = computedStyle.getPropertyValue("background-color");
	const {bold, dim} = resolveFontWeight(
		computedStyle.getPropertyValue("font-weight"),
	);
	// The Highlight/HighlightText system-color pair is CSS's spelling of
	// "swap the cell's colors": it translates to SGR inverse, the
	// terminal-native highlight with no color assumptions -- the same
	// translation ::selection's resolver makes. Either name alone (the
	// other overridden by an author color) can't mean "swap", so the
	// system side simply resolves to nothing.
	const isHighlightPair =
		isSystemHighlightColor(bgColor) && isSystemHighlightColor(color);
	return {
		fg:
			color && color !== "initial" && !isSystemHighlightColor(color)
				? cssColorToNumber(color)
				: undefined,
		bg:
			bgColor &&
			bgColor !== "initial" &&
			bgColor !== "transparent" &&
			!/^canvas$/i.test(bgColor.trim()) &&
			!isSystemHighlightColor(bgColor)
				? cssColorToNumber(bgColor)
				: undefined,
		inverse: isHighlightPair || undefined,
		bold,
		dim,
		italic: computedStyle.getPropertyValue("font-style") === "italic",
		underline: hasUnderline(computedStyle),
		underlineStyle:
			computedStyle.getPropertyValue("text-decoration-style") === "double"
				? ("double" as const)
				: undefined,
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
	window: DOMWindow,
	element: Element,
	base: import("./ansi.js").CellStyle,
): import("./ansi.js").CellStyle {
	const declaration = window.getComputedStyle(element, "::selection");
	const fg = declaration.getPropertyValue("color");
	const bg = declaration.getPropertyValue("background-color");
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
		case "uppercase":
			return text.toUpperCase();
		case "lowercase":
			return text.toLowerCase();
		case "capitalize":
			return text.replace(
				/\p{L}[\p{L}\p{M}]*/gu,
				(word) => (word[0]?.toUpperCase() ?? "") + word.slice(1),
			);
		default:
			return text;
	}
}

/**
 * The paint walk: the pure transformation of a laid-out DOM tree into terminal
 * cells. It reads geometry from the {@link LayoutEngine}, computed styles from
 * the {@link StyleManager} and jsdom, and form controls' shadow parts and caret
 * from the composed tree (the shell upgrades the widgets on connect, so their
 * shadow is already there), then draws into a `DrawingContext`. It owns no
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
	#window: DOMWindow;
	// The document, cached the way TermDOM caches it: a stray post-dispose frame
	// paints against this stale reference rather than crashing on window.document,
	// which jsdom nulls when the window closes. The live window still serves
	// getComputedStyle/getSelection, which tolerate a torn-down document.
	#document: Document;
	#layout: LayoutEngine;
	#styleManager: StyleManager;
	#viewport: Viewport;
	// Shared with TermDOM by reference -- see the class doc.
	#topLayer: Set<Element>;
	#inputScrollOffsets: WeakMap<Element, number>;
	// List markers already painted this frame; each renders at most once.
	#renderedOutsideMarkers = new WeakSet<Element>();

	constructor(deps: {
		window: DOMWindow;
		document: Document;
		layout: LayoutEngine;
		styleManager: StyleManager;
		viewport: Viewport;
		topLayer: Set<Element>;
		inputScrollOffsets: WeakMap<Element, number>;
	}) {
		this.#window = deps.window;
		this.#document = deps.document;
		this.#layout = deps.layout;
		this.#styleManager = deps.styleManager;
		this.#viewport = deps.viewport;
		this.#topLayer = deps.topLayer;
		this.#inputScrollOffsets = deps.inputScrollOffsets;
	}

	/** The whole document: the root stacking context, then the top layer. */
	paint(ctx: import("./ansi.js").DrawingContext): void {
		this.#renderedOutsideMarkers = new WeakSet<Element>();
		const layers = this.#layout.collectStackingLayers(this.#topLayer);
		this.#renderStackingContext(this.#document.body, ctx, layers);
		for (const element of this.#topLayer) {
			// COMPOSITION-connected: a UA part (the select's picker) lives in
			// a fragment and is never DOM-connected while very much on screen.
			if (!compositionIsConnected(element)) {
				this.#topLayer.delete(element);
				continue;
			}
			const previousClip = ctx.clipRect;
			ctx.clipRect = null;
			try {
				this.#renderStackingContext(element, ctx, layers);
			} finally {
				ctx.clipRect = previousClip;
			}
		}
	}

	#renderElement(
		element: Element,
		ctx: import("./ansi.js").DrawingContext,
		afterOwnBox?: () => void,
	): void {
		// Viewport culling. The buffer only keeps document rows in
		// [-viewportOffset, -viewportOffset + rows); a subtree whose paint extent
		// lies wholly outside that band would be walked -- styles computed, text
		// shaped, borders drawn -- and then discarded cell by cell. Skip it here
		// and the paint costs what is on screen, not what is in the document.
		const bandTop = -ctx.viewportOffset;
		if (
			this.#layout.isSubtreeOutsideBand(element, bandTop, bandTop + ctx.rows)
		) {
			return;
		}

		// display:none generates NO box and no descendant boxes -- final, per
		// CSS. Stray run state under a hidden subtree (an editing todo's
		// hidden .view) could otherwise ghost-paint at whatever coordinates
		// it last held.
		if (
			this.#window.getComputedStyle(element).getPropertyValue("display") ===
			"none"
		) {
			return;
		}

		const rect = this.#layout.getRect(element);

		const color = this.#window
			.getComputedStyle(element)
			.getPropertyValue("color");
		const backgroundColor = this.#window
			.getComputedStyle(element)
			.getPropertyValue("background-color");
		const {bold, dim} = resolveFontWeight(
			this.#window.getComputedStyle(element).getPropertyValue("font-weight"),
		);
		const italic =
			this.#window.getComputedStyle(element).getPropertyValue("font-style") ===
			"italic";
		const underline = hasUnderline(this.#window.getComputedStyle(element));
		const underlineStyle =
			this.#window
				.getComputedStyle(element)
				.getPropertyValue("text-decoration-style") === "double"
				? ("double" as const)
				: undefined;
		// visibility:hidden reserves the box (layout is untouched) but paints
		// nothing of it -- unlike display:none, which removes the box entirely. A
		// descendant that sets visibility:visible still paints, since visibility
		// inherits and each element resolves its own computed value here.
		const visible =
			this.#window.getComputedStyle(element).getPropertyValue("visibility") !==
			"hidden";

		// background-color: Canvas -- the CSS system color for the document
		// background -- clears the box to the terminal's DEFAULT background:
		// opaque in every theme without asserting any color, the same
		// system-color translation ::selection's Highlight pair uses. The UA
		// picker sheet relies on it; authors can too. The Highlight/
		// HighlightText pair fills the box with SGR inverse instead -- the
		// browser's blue dropdown row, in the terminal's own colors (the UA
		// select sheet's highlighted option rides this).
		const isCanvasBg =
			Boolean(backgroundColor) && /^canvas$/i.test(backgroundColor.trim());
		const isHighlightBox =
			Boolean(backgroundColor) &&
			isSystemHighlightColor(backgroundColor) &&
			Boolean(color) &&
			isSystemHighlightColor(color);
		const style = {
			fg:
				color && color !== "initial" && !isSystemHighlightColor(color)
					? cssColorToNumber(color)
					: undefined,
			bg:
				backgroundColor &&
				!isCanvasBg &&
				backgroundColor !== "initial" &&
				backgroundColor !== "transparent" &&
				!isSystemHighlightColor(backgroundColor)
					? cssColorToNumber(backgroundColor)
					: undefined,
			bold,
			dim,
			italic,
			underline,
			underlineStyle,
		};

		if (rect && visible && (style.bg != null || isCanvasBg || isHighlightBox)) {
			ctx.fillRect(
				rect.left,
				rect.top,
				rect.width,
				rect.height,
				isCanvasBg ? "default" : isHighlightBox ? "inverse" : style.bg,
			);
		}

		// Handle borders
		if (rect && visible) {
			const borderStyles = resolveBorderStyles(element);
			if (borderStyles.hasAnyBorder) {
				// Border color per CSS: border-color, whose initial value is
				// currentColor -- the element's own color -- and, with nothing
				// authored anywhere, the terminal's DEFAULT foreground. Never a
				// hardcoded white: no theme-safe color exists, and forcing one
				// breaks light terminals.
				const borderColor = this.#window
					.getComputedStyle(element)
					.getPropertyValue("border-top-color");
				const borderCellStyle = {
					fg:
						borderColor &&
						borderColor !== "currentcolor" &&
						borderColor !== "currentColor"
							? cssColorToNumber(borderColor)
							: style.fg,
					bg: style.bg, // Inherit element's background color
				};
				ctx.drawBorder(
					Math.round(rect.left),
					Math.round(rect.top),
					Math.round(rect.width),
					Math.round(rect.height),
					borderStyles,
					borderCellStyle,
				);
			}
		}

		// Handle list-style-position: outside markers
		if (visible) this.#renderOutsideMarker(element, ctx);

		// A textarea's content IS its UA shadow tree, built on connect and
		// painted by the normal child walk below; parking the real terminal
		// caret at the multiline position is the rest.
		if (element.tagName === "TEXTAREA" && rect) {
			const textarea = element as HTMLTextAreaElement;
			if (visible && textarea === this.#document.activeElement) {
				const range = fieldCaretRange(textarea);
				const [caret] = range ? this.#layout.getRangeRects(range) : [];
				if (caret) ctx.setCaret(caret.x, caret.y);
			}
		}

		// A select's content is its UA shadow tree (label + indicator + picker),
		// built on connect and painted by the normal child walk; an OPEN picker
		// (the widget shows it by flipping display) paints in the top layer, over
		// following content. Parking the caret at the field origin is the rest.
		if (element.tagName === "SELECT" && rect) {
			const select = element as HTMLSelectElement;
			const picker =
				compositionShadowRoot(select)?.querySelector<HTMLElement>(
					'[part="picker"]',
				);
			// The widget flips the picker's display inline on open/close, so its
			// own intent reads straight off style.display -- no style resolution,
			// and exactly the open/closed signal the top-layer decision wants.
			if (picker) {
				if (picker.style.display !== "none") this.#topLayer.add(picker);
				else this.#topLayer.delete(picker);
			}
			if (visible && select === this.#document.activeElement) {
				const boxModel = getBoxModel(select);
				ctx.setCaret(
					Math.round(rect.left) +
						(boxModel.borderLeftWidth || 0) +
						(boxModel.paddingLeft || 0),
					Math.round(rect.top) +
						(boxModel.borderTopWidth || 0) +
						(boxModel.paddingTop || 0),
				);
			}
		}

		// Render input elements (void elements with no children)
		if (
			element.tagName === "INPUT" &&
			rect &&
			(element as HTMLInputElement).type !== "hidden"
		) {
			if (visible) {
				this.#renderInputElement(element as HTMLInputElement, rect, ctx);
			}
			return; // Input elements have no children to render
		}

		// Note: JSDOM automatically calls connectedCallback() when elements are added to DOM
		// No manual lifecycle management needed

		// The stacking-context painter slots its negative-z layer here: after
		// this element's own background and border, before any of its in-flow
		// content -- the CSS position for negative z-index.
		if (afterOwnBox) afterOwnBox();

		// The IN-FLOW walk: children paint in tree order, and POSITIONED
		// children don't paint here at all -- per CSS they are hoisted to
		// their nearest stacking context and painted in its layer order (see
		// #renderStackingContext). The old per-sibling z sort could never
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
		const fastChildren = this.#layout.visibleChildrenInBand(
			element,
			bandTop,
			bandTop + ctx.rows,
		);
		if (fastChildren) {
			for (const childNode of fastChildren) {
				children.push(childNode);
			}
		} else {
			// Use ExpandedTreeWalker to render all children including pseudo-elements and shadow DOM
			const walker = createExpandedTreeWalker(this.#window, element);
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
					this.#layout.isSubtreeOutsideBand(
						childNode as Element,
						bandTop,
						bandTop + ctx.rows,
					)
				) {
					continue;
				}
				if (
					childNode.nodeType === childNode.ELEMENT_NODE &&
					isPositioned(this.#window, childNode as Element) &&
					this.#layout.positionedElements.has(childNode as Element)
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
		const overflow = this.#window
			.getComputedStyle(element)
			.getPropertyValue("overflow");
		const overflowX =
			this.#window.getComputedStyle(element).getPropertyValue("overflow-x") ||
			overflow;
		const overflowY =
			this.#window.getComputedStyle(element).getPropertyValue("overflow-y") ||
			overflow;
		const previousClip = ctx.clipRect;
		ctx.clipRect = overflowClipRect(rect, overflowX, overflowY, previousClip);

		try {
			for (const childNode of children) {
				if (childNode.nodeType === childNode.ELEMENT_NODE) {
					const childElement = childNode as Element;
					if (childElement instanceof (this.#window as any).HTMLElement) {
						this.#renderElement(childElement, ctx);
					}
				} else if (childNode.nodeType === childNode.TEXT_NODE) {
					const textNode = childNode as Text;
					this.#renderText(textNode, ctx);
				}
			}
		} finally {
			ctx.clipRect = previousClip;
		}

		// A focused textarea's own selection now paints inline while the child
		// walk lays down the value text -- #renderTextSelection reads the
		// control's selectionStart/End, the same way it reads a document Range.
	}

	/**
	 * The clip a deferred positioned box paints under: the context root's
	 * clip, intersected with every overflow-clipping box along the CSS
	 * containing-block chain (its positioned ancestors up to the context
	 * root) -- and nothing else: intervening non-positioned overflow
	 * ancestors don't clip a box they don't contain.
	 */
	#positionedClipFor(
		element: Element,
		contextRoot: Element,
		contextClip: import("./ansi.js").DrawingContext["clipRect"],
	): import("./ansi.js").DrawingContext["clipRect"] {
		let clip = contextClip;
		for (
			let ancestor = compositionParentElement(element);
			ancestor && ancestor !== contextRoot;
			ancestor = compositionParentElement(ancestor)
		) {
			if (!isPositioned(this.#window, ancestor)) continue;
			const style = this.#window.getComputedStyle(ancestor);
			const overflow = style.getPropertyValue("overflow");
			const overflowX = style.getPropertyValue("overflow-x") || overflow;
			const overflowY = style.getPropertyValue("overflow-y") || overflow;
			if (overflowX === "hidden" || overflowY === "hidden") {
				const rect = this.#layout.getRect(ancestor);
				if (rect) {
					clip = overflowClipRect(rect, overflowX, overflowY, clip);
				}
			}
		}
		return clip;
	}

	/**
	 * Paint a stacking context in the CSS layer order: the root's own box,
	 * negative-z child contexts, in-flow content (the #renderElement walk,
	 * which skips positioned descendants), the positioned z:auto/0 layer,
	 * then positive-z contexts. A z:auto member doesn't isolate: it paints
	 * as an in-flow subtree here while its own positioned descendants sit
	 * in THIS context's buckets. Deferred layers paint under the context
	 * root's clip -- a positioned box escapes overflow ancestors between
	 * itself and its context, the common CSS escape (per-containing-block
	 * clipping is layer-2 work).
	 */
	#renderStackingContext(
		root: Element,
		ctx: import("./ansi.js").DrawingContext,
		layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
	): void {
		const bucket = layers.get(root);
		if (!bucket) {
			this.#renderElement(root, ctx);
			return;
		}
		const contextClip = ctx.clipRect;
		const paintMember = (element: Element) => {
			const previousClip = ctx.clipRect;
			const previousOffset = ctx.viewportOffset;
			// Clips apply along the CONTAINING BLOCK chain only: an overflow
			// ancestor that isn't a positioned ancestor doesn't clip a
			// deferred box, but its own containing blocks' overflow does.
			ctx.clipRect = this.#positionedClipFor(element, root, contextClip);
			// position:fixed anchors to the VIEWPORT: cancel the camera by
			// undoing the scroll offset for the whole subtree.
			if (
				this.#window.getComputedStyle(element).getPropertyValue("position") ===
				"fixed"
			) {
				ctx.viewportOffset = previousOffset + this.#viewport.scrollTop;
			}
			try {
				if (this.#layout.formsStackingContext(element)) {
					this.#renderStackingContext(element, ctx, layers);
				} else {
					this.#renderElement(element, ctx);
				}
			} finally {
				ctx.clipRect = previousClip;
				ctx.viewportOffset = previousOffset;
			}
		};
		this.#renderElement(root, ctx, () => {
			for (const element of bucket.neg) paintMember(element);
		});
		for (const element of bucket.zero) paintMember(element);
		for (const element of bucket.pos) paintMember(element);
	}

	/** Render outside-positioned list markers, once per element per frame. */
	#renderOutsideMarker(
		element: Element,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const computedStyle = this.#window.getComputedStyle(element);
		const display = computedStyle.getPropertyValue("display");

		// Only handle list items
		if (display !== "list-item") {
			return;
		}

		const listStylePosition =
			computedStyle.getPropertyValue("list-style-position") || "outside";

		// Only handle outside positioning
		if (listStylePosition !== "outside") {
			return;
		}

		// Prevent duplicate rendering in the same frame
		if (this.#renderedOutsideMarkers.has(element)) {
			return;
		}
		this.#renderedOutsideMarkers.add(element);

		// Get marker content from StyleManager
		const markerContent = this.#styleManager.getMarkerContent(element);
		if (!markerContent) {
			return;
		}

		const rect = this.#layout.getRect(element);
		if (!rect) {
			return;
		}

		// Cells, not code units: a marker like "日本 " is 3 characters but 5 cells
		// wide, and right-aligning it by its length would paint it over the item's
		// own text.
		const markerWidth = stringWidth(markerContent);

		// Get marker styles
		const markerStyle = this.#window.getComputedStyle(element, "::marker");
		// ::marker inherits color from its originating element, so fall back to the
		// list item's own color rather than rendering the marker unstyled.
		const markerColor =
			markerStyle.getPropertyValue("color") ||
			computedStyle.getPropertyValue("color");
		const {bold: markerBold, dim: markerDim} = resolveFontWeight(
			markerStyle.getPropertyValue("font-weight"),
		);
		const markerItalic =
			markerStyle.getPropertyValue("font-style") === "italic";
		const markerUnderline = hasUnderline(markerStyle);

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

		// Position marker just before the list item's content area (outside positioning)
		const markerX = Math.max(0, Math.round(rect.left) - markerWidth);
		const markerY = Math.round(rect.top);

		// Render the marker (clipped to available space, never mutate the DOM)
		ctx.setText(markerX, markerY, markerContent, markerTextStyle);
	}

	/**
	 * Render an input element: read its UA widget's shadow parts for their
	 * computed styles and paint them. What remains here is exactly the widget's
	 * editor mechanics -- the scroll-window over an overflowing value and
	 * parking the REAL terminal cursor -- the same split a browser makes between
	 * its input's shadow content and its editor internals.
	 */
	#renderInputElement(
		element: HTMLInputElement,
		rect: DOMRect,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const boxModel = getBoxModel(element);
		const contentX =
			Math.round(rect.left) +
			(boxModel.borderLeftWidth || 0) +
			(boxModel.paddingLeft || 0);
		const contentY =
			Math.round(rect.top) +
			(boxModel.borderTopWidth || 0) +
			(boxModel.paddingTop || 0);
		const contentWidth =
			Math.round(rect.width) -
			(boxModel.borderLeftWidth || 0) -
			(boxModel.borderRightWidth || 0) -
			(boxModel.paddingLeft || 0) -
			(boxModel.paddingRight || 0);

		// The UA widget owns the shadow tree (built on connect) and reconciles it
		// from the input's own state; the painter only reads its parts' computed
		// styles.
		const root = compositionShadowRoot(element);
		if (!root) return;

		if (element.type === "checkbox" || element.type === "radio") {
			const glyphSpan = root.querySelector('[part="glyph"]') as HTMLElement;
			const mark =
				element.type === "checkbox"
					? element.checked
						? "[x]"
						: "[ ]"
					: element.checked
						? "(x)"
						: "( )";
			// The mark is read from live .checked at paint, not reconciled by the
			// widget: a radio's group exclusivity unchecks its siblings with no
			// event or setter on them to hook, so only a paint-time read stays
			// correct. The glyph text node carries it so a width:auto toggle
			// measures; its computed style (the focus underline included) reads
			// back off the tree.
			const glyphText = glyphSpan.firstChild as Text;
			if (glyphText.data !== mark) glyphText.data = mark;
			ctx.setText(
				contentX,
				contentY,
				mark,
				cellStyleFromComputed(this.#window.getComputedStyle(glyphSpan)),
			);
			if (element === this.#document.activeElement) {
				ctx.setCaret(contentX, contentY);
			}
			return;
		}

		const value = element.value || "";
		const placeholder = element.getAttribute("placeholder") || "";
		const isFocused = element === this.#document.activeElement;

		const valueSpan = root.querySelector('[part="value"]') as HTMLElement;
		const placeholderSpan = root.querySelector(
			'[part="placeholder"]',
		) as HTMLElement;
		const blankSpan = root.querySelector('[part="blank"]') as HTMLElement;

		// Region styles come off the tree: the value inherits the input's
		// own text style (solid underline when focused), the placeholder and
		// the blank carry the UA field sheet -- gray ghost label, faint
		// blank when blurred -- plus whatever the author adds.
		const textStyle = cellStyleFromComputed(
			this.#window.getComputedStyle(value ? valueSpan : placeholderSpan),
		);
		const blankStyle = cellStyleFromComputed(
			this.#window.getComputedStyle(blankSpan),
		);

		// Shown focused or not, as in a browser -- the caret just sits at
		// the field start, over the dimmed text.
		const displayText = value || placeholder;

		// Everything below measures in CELLS, not characters. CJK text is two
		// cells per glyph, so character arithmetic put the caret mid-text (IME
		// composition then anchored on top of already-typed glyphs) and padEnd
		// by character count pushed the value's background straight through the
		// input's right border.
		let scrollOffset = this.#inputScrollOffsets.get(element) ?? 0;
		// The caret is the input's own selection (selectionStart/End), so a
		// framework assigning .value can never strand it: per spec, setting
		// value collapses the selection to the end. The caret sits at the
		// selection's FOCUS -- the moving end, per selectionDirection -- which
		// is the end that must stay scrolled into view while extending.
		const selStart = element.selectionStart ?? value.length;
		const selEnd = element.selectionEnd ?? value.length;
		const cursor =
			element.selectionDirection === "backward" ? selStart : selEnd;

		if (isFocused) {
			// Keep the caret's CELL offset inside the box.
			if (cursor < scrollOffset) {
				scrollOffset = cursor;
			}
			while (
				scrollOffset < cursor &&
				stringWidth(displayText.slice(scrollOffset, cursor)) >= contentWidth
			) {
				scrollOffset++;
			}
			// And scroll BACK when there's slack: after deleting at the end of
			// an overflowed value, the window would otherwise stay put and show
			// a shrinking tail with the earlier text still hidden off the left
			// edge. Pull the window left while everything from one character
			// earlier through the end still fits strictly inside the field
			// (strictly: the caret needs its cell when it sits at the end),
			// exactly what a browser's field does on backspace.
			while (
				scrollOffset > 0 &&
				stringWidth(displayText.slice(scrollOffset - 1)) < contentWidth
			) {
				scrollOffset--;
			}
			this.#inputScrollOffsets.set(element, scrollOffset);
		}

		// Take characters from the scroll offset until the next one would no
		// longer fit, then pad with spaces to exactly the content width in cells.
		let visibleText = "";
		let usedCells = 0;
		for (const char of displayText.slice(scrollOffset)) {
			const charCells = stringWidth(char);
			if (usedCells + charCells > contentWidth) break;
			visibleText += char;
			usedCells += charCells;
		}
		const visibleChars = visibleText.length;
		visibleText += " ".repeat(Math.max(0, contentWidth - usedCells));

		// The content region paints with its part's style, and the cells the
		// content spares are the BLANK part -- which the UA sheet renders as
		// the faint underlined blank when blurred, and which inherits the
		// solid focus underline like everything else when focused.
		if (displayText) {
			ctx.setText(
				contentX,
				contentY,
				visibleText.slice(0, visibleChars),
				textStyle,
			);
			ctx.setText(
				contentX + usedCells,
				contentY,
				visibleText.slice(visibleChars),
				blankStyle,
			);
		} else {
			ctx.setText(contentX, contentY, visibleText, blankStyle);
		}

		// A selection paints as inverse video over its visible slice --
		// terminal-native highlight, no color assumptions. (Placeholder text
		// can never be selected: it only shows for an empty value, whose
		// selection is necessarily collapsed.)
		if (isFocused && selEnd > selStart) {
			const visStart = Math.max(selStart, scrollOffset);
			const visEnd = Math.min(selEnd, scrollOffset + visibleChars);
			if (visEnd > visStart) {
				ctx.setText(
					contentX + stringWidth(displayText.slice(scrollOffset, visStart)),
					contentY,
					displayText.slice(visStart, visEnd),
					selectionStyleFor(this.#window, element, textStyle),
				);
			}
		}

		// The caret of a focused input is the REAL terminal cursor, parked there
		// by the frame -- not an inverse-video imitation. IME composition, screen
		// readers and the terminal's own cursor style all anchor to the real one.
		if (isFocused) {
			const cursorX =
				contentX + stringWidth(displayText.slice(scrollOffset, cursor));
			if (cursorX >= contentX && cursorX < contentX + contentWidth) {
				ctx.setCaret(cursorX, contentY);
			}
		}
	}

	/**
	 * Render a text node with proper styling from its parent element or pseudo-element
	 */
	#renderText(textNode: Text, ctx: import("./ansi.js").DrawingContext): void {
		const textContent = textNode.data;
		if (!textContent) return;

		// Check if this is a pseudo-element node
		const pseudoMetadata = getPseudoMetadata(textNode);

		// For pseudo elements, we don't have a parentElement, but we have
		// hostElement. Everything else styles from the FLAT-tree parent:
		// slotted bare text draws its inherited styles through the slot's
		// shadow chain, not from the host it came from.
		const parentElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: compositionParentElement(textNode);
		if (!parentElement) return;

		let computedStyle: CSSStyleDeclaration;

		if (pseudoMetadata) {
			// For pseudo-elements, get the computed style with the pseudo-element selector
			computedStyle = this.#window.getComputedStyle(
				pseudoMetadata.hostElement,
				pseudoMetadata.pseudoType,
			);
		} else {
			// For regular text nodes, use the parent element's style
			computedStyle = this.#window.getComputedStyle(parentElement);
		}

		// visibility inherits, so the parent's own resolved value already accounts
		// for a closer ancestor overriding back to visible.
		if (computedStyle.getPropertyValue("visibility") === "hidden") return;

		const textTransform = computedStyle.getPropertyValue("text-transform");
		const textStyle = cellStyleFromComputed(computedStyle);

		const rectTexts = this.#layout.getRectTexts(textNode);
		if (rectTexts.length > 0) {
			for (const rectText of rectTexts) {
				if (rectText.text.length > 0) {
					ctx.setText(
						Math.round(rectText.rect.x),
						Math.round(rectText.rect.y),
						applyTextTransform(rectText.text, textTransform),
						textStyle,
					);
				}
			}
			this.#renderTextSelection(textNode, textStyle, textTransform, ctx);
		}
	}

	/**
	 * The data-offset range to highlight over a text node, and the element whose
	 * ::selection rules style it. Two sources, one shape: a focused form
	 * control's own selection (selectionStart/End) when this text node is its
	 * shadow value -- getSelection() cannot see inside a control, per spec, so
	 * the painter reads the control directly -- otherwise the document selection.
	 */
	#selectionRangeFor(
		textNode: Text,
	): {from: number; to: number; selectionParent: Element} | null {
		const host = (textNode.getRootNode() as {host?: Element}).host;
		if (
			host &&
			host === this.#document.activeElement &&
			host.tagName === "TEXTAREA" &&
			textNode.parentElement?.getAttribute("part") === "value"
		) {
			const field = host as HTMLTextAreaElement;
			const start = field.selectionStart ?? 0;
			const end = field.selectionEnd ?? 0;
			if (end <= start) return null;
			const length = textNode.data.length;
			return {
				from: Math.max(0, Math.min(start, length)),
				to: Math.max(0, Math.min(end, length)),
				selectionParent: textNode.parentElement,
			};
		}

		const selection = this.#window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			return null;
		}
		const range = selection.getRangeAt(0);
		if (!range.intersectsNode(textNode)) return null;
		const from = range.startContainer === textNode ? range.startOffset : 0;
		const to =
			range.endContainer === textNode ? range.endOffset : textNode.data.length;
		if (to <= from) return null;
		const selectionParent =
			getPseudoMetadata(textNode)?.hostElement ??
			compositionParentElement(textNode);
		if (!selectionParent) return null;
		return {from, to, selectionParent};
	}

	/**
	 * Overlay the selection on a text node as inverse video (or the author's
	 * ::selection colors) by redrawing its selected runs in the highlight style.
	 * The selected region comes from #selectionRangeFor; the runs' rects and text
	 * come from the layout's Range geometry, so the painter does no offset math.
	 * Case transforms never change cell width, so transforming each run's raw
	 * text repaints exactly the cells the base pass laid down.
	 */
	#renderTextSelection(
		textNode: Text,
		textStyle: import("./ansi.js").CellStyle,
		textTransform: string,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const found = this.#selectionRangeFor(textNode);
		if (!found) return;
		const {from, to, selectionParent} = found;
		const selectionStyle = selectionStyleFor(
			this.#window,
			selectionParent,
			textStyle,
		);
		if (selectionStyle === textStyle) return; // no ::selection rule reaches here

		const range = textNode.ownerDocument.createRange();
		range.setStart(textNode, from);
		range.setEnd(textNode, to);
		for (const run of this.#layout.getRangeRuns(range)) {
			ctx.setText(
				run.rect.x,
				run.rect.y,
				applyTextTransform(run.text, textTransform),
				selectionStyle,
			);
		}
	}
}
