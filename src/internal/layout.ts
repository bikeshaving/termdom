/**
 * The box tree: which boxes a document generates, and where they sit on the
 * cell grid.
 *
 * It reads computed styles and produces geometry. Every rect the DOM answers
 * with, and every cell the painter places, comes from what it computed.
 */
import type {EngineWindow} from "./termdom.js";
import Flex from "./flex.js";
import type * as FlexTypes from "./flex.js";
import LineBreaker from "linebreak";
import {
	getBoxModel,
	parseBorderWidthValue,
	parseSignedUnitValue,
	type BoxModel,
} from "./styles.js";
import {
	computedStyleOf,
	getPropertyValue,
	parseUnitValue,
	type ComputedStyle,
} from "./styles.js";
import {
	caretRangeOf,
	createFlatTreeWalker,
	pseudoElementCount,
	type FlatTreeWalker,
	flatIsConnected,
	flatParentElement,
	shadowRootOf,
} from "./dom.js";
import {
	dataOffsetAt,
	hasRTL,
	inferParagraphDirection,
	renderTextFragment,
	renderWhiteSpaceOffsets,
	shiftRenderedOffsets,
	type RenderedOffsets,
	stringWidth as runtimeStringWidth,
	toVisualOrder,
	writeClusterWidths,
} from "./text.js";

/**
 * Whether a box takes part in positioned layout -- the predicate both the
 * containing-block chain and stacking-context collection are built on. Also
 * consulted by the painter's in-flow walk, so it is exported.
 */
export function isPositioned(element: Element): boolean {
	const position = computedStyleOf(element).computedValueOf("position");
	return Boolean(position) && position !== "static";
}

/**
 * z-index only means anything on a positioned box; "auto" stays distinct from 0
 * -- auto paints in the same layer but does NOT form a context.
 */
function zIndexValueOf(element: Element): number | "auto" {
	const zIndex = computedStyleOf(element).computedValueOf("z-index");
	if (!zIndex || zIndex === "auto") return "auto";
	const value = parseInt(zIndex, 10);
	return Number.isFinite(value) ? value : "auto";
}

/**
 * How far a line's content should shift right for text-align:center/right --
 * left/start/justify all offset zero. (justify -- distributing extra space
 * between words on a line -- is intentionally not implemented; it would need
 * to redistribute space during the line-breaking pass itself, not just shift
 * an already-broken line.)
 */
function lineAlignOffset(
	container: Element | null,
	containerWidth: number | undefined,
	lineWidth: number,
): number {
	if (!container || containerWidth === undefined) return 0;
	const align = getPropertyValue(container, "text-align");
	if (align === "center") return Math.max(0, (containerWidth - lineWidth) / 2);
	if (align === "right") return Math.max(0, containerWidth - lineWidth);
	if (align === "left") return 0;
	// `start` and `end` name the READING direction's ends, so they trade sides
	// in an RTL paragraph: an undeclared alignment is `start`, which puts an
	// RTL line at the right edge, and `end` puts it at the left.
	const rtl = getPropertyValue(container, "direction") === "rtl";
	const atRightEdge = align === "end" ? !rtl : rtl;
	return atRightEdge ? Math.max(0, containerWidth - lineWidth) : 0;
}

/**
 * text-indent shifts only a block's first formatted line. Simplification: this
 * is added on top of whatever text-align already offsets the line by, rather
 * than shrinking the line box the way a browser would -- indent's overwhelming
 * real use (indenting the first line of a left-aligned paragraph) is unaffected
 * by that difference; indent combined with center/right is rare enough not to
 * be worth the extra bookkeeping.
 */
function lineIndent(
	isFirstLine: boolean,
	container: Element | null,
	containerWidth: number | undefined,
): number {
	if (!isFirstLine || !container) return 0;
	const parsed = parseUnitValue(getPropertyValue(container, "text-indent"));
	if (parsed === null) return 0;
	if (typeof parsed === "number") return parsed;
	return containerWidth === undefined
		? 0
		: (parsed.percentage / 100) * containerWidth;
}

interface EnumMap {
	align: FlexTypes.Align;
	justify: FlexTypes.Justify;
	wrap: FlexTypes.Wrap;
}

function getFlexConstant<TEnumName extends keyof EnumMap>(
	enumName: TEnumName,
	propertyName: string,
): EnumMap[TEnumName] | null {
	const name =
		enumName.toUpperCase() + "_" + propertyName.replace("-", "_").toUpperCase();
	return (Flex as any)[name] || null;
}

/** A colspan/rowspan attribute, defaulting to 1 when absent or nonsense. */
function parseSpanAttribute(element: Element, name: string): number {
	const raw = element.getAttribute(name);
	if (!raw) return 1;
	const span = parseInt(raw, 10);
	return Number.isFinite(span) && span > 0 ? span : 1;
}

const ZERO_OFFSET = {x: 0, y: 0};

/**
 * Containers that lay out no flow an out-of-flow child could have taken a
 * position in: its static position is the container's own content-box corner,
 * as its alignment properties place it (css-flexbox-1 §4.1, css-grid-2 §9).
 */
const NO_STATIC_POSITION_DISPLAYS = new Set([
	"flex",
	"grid",
	"inline-flex",
	"inline-grid",
]);

/** The line and segment a break result placed an inline-block box on. */
function findInlineBlockSegment(
	breakResult: BreakResult,
	element: Element,
): {
	line: LineResult;
	segment: LineResult["segments"][number] & {leaf: InlineBlockLeaf};
} | null {
	for (const line of breakResult.lines) {
		for (const segment of line.segments) {
			if (
				segment.leaf.type === "inline-block" &&
				segment.leaf.node === element
			) {
				return {
					line,
					segment: segment as LineResult["segments"][number] & {
						leaf: InlineBlockLeaf;
					},
				};
			}
		}
	}
	return null;
}

/**
 * A `display: contents` element generates no box: the box tree splices it away
 * and its children take its place. This is the whole of what the flat tree's
 * consumers need to know about it -- a slot disappears from layout this way
 * (UA default `slot { display: contents }`, as in browsers) while its projected
 * content flows through.
 */
function dissolvesIntoChildren(node: Node): boolean {
	return getPropertyValue(node as Element, "display") === "contents";
}

/**
 * position:absolute (and fixed, approximated as absolute-to-ICB) takes a box
 * out of normal flow entirely.
 */
function isOutOfFlow(node: Node): boolean {
	if (node.nodeType !== node.ELEMENT_NODE) return false;
	const position = getPropertyValue(node as Element, "position");
	return position === "absolute" || position === "fixed";
}

/** Whether a display value puts a box on a line rather than on rows of its own. */
function isInlineDisplay(display: string): boolean {
	return display === "inline" || display === "inline-block";
}

/** Whether an element lays its children out as flex items. */
function isFlexContainer(element: Element): boolean {
	const display = getPropertyValue(element, "display");
	return display === "flex" || display === "inline-flex";
}

/** Whether an element's box is a flex item of its parent's. */
function hasFlexParent(element: Element): boolean {
	const parent = element.parentElement;
	return parent !== null && getPropertyValue(parent, "display") === "flex";
}

/**
 * Whether an element's box is blockified (css-display-3 §2.7): an out-of-flow
 * box takes a block's box model, and so does every child of a flex container,
 * which has no lines for an inline-level box to sit on.
 */
function isBlockifiedBox(element: Element): boolean {
	return isOutOfFlow(element) || hasFlexParent(element);
}

/**
 * The display an element's box is generated with: its computed value, with
 * blockification applied. `none` and `contents` generate no box of their own
 * and stand as they compute.
 */
function usedDisplay(element: Element): string {
	const display = getPropertyValue(element, "display");
	if (!isInlineDisplay(display)) return display;
	return isBlockifiedBox(element) ? "block" : display;
}

/**
 * Whether a node's box sits on a line of its container's rather than on rows of
 * its own. Text is always inline-level; an element is whatever its used display
 * makes it.
 */
function isInlineLevel(node: Node): boolean {
	if (node.nodeType === node.TEXT_NODE) return true;
	if (node.nodeType !== node.ELEMENT_NODE) return false;
	return isInlineDisplay(usedDisplay(node as Element));
}

/** Whether a `white-space` value keeps a space as content rather than collapsing it. */
function preservesSpaces(whiteSpace: string): boolean {
	return (
		whiteSpace === "pre" ||
		whiteSpace === "pre-wrap" ||
		whiteSpace === "break-spaces"
	);
}

/**
 * Put a flex node at a position under a parent. A node is one child of one
 * parent: one already under this parent is MOVED, because a build that reaches
 * the same element twice -- a deferred re-add drained by the layout pass, then
 * the mutation record that deferred it -- would otherwise leave the flex tree
 * holding it twice and lay its box out twice over.
 */
function placeChild(
	parent: FlexTypes.Node,
	child: FlexTypes.Node,
	index: number,
): void {
	if (child.getParent() === parent) {
		if (parent.getChildIndex(child) === index) return;
		parent.removeChild(child);
	}
	parent.insertChild(child, index);
}

/** A walk of the boxes a node's content lays out from. */
export function flowWalker(root: Node): FlatTreeWalker<Node> {
	return createFlatTreeWalker<Node>(root, dissolvesIntoChildren);
}

/**
 * The flat-tree parent that generates a box: the flat parent, skipping the
 * elements that generate none. A projected node's box lives under the slot's
 * own box parent, and rooting an inline-run walk at the slot would truncate
 * the run at the slot's edge.
 */
function boxParentElement(node: Node): Element | null {
	let parent = flatParentElement<Element>(node);
	while (parent !== null && dissolvesIntoChildren(parent)) {
		parent = flatParentElement<Element>(parent);
	}
	return parent;
}

/**
 * Advance a walker past the current node's subtree, in document order,
 * without descending into it. nextSibling() alone is not that: it gives up
 * the moment the skipped node is its parent's last child, and an inline run
 * does not end there. `<span><b>x</b></span> tail` collects the <b>, finds
 * no sibling inside the span, and must climb out to reach " tail". Stopping
 * at the parent's last child instead drops every leaf after a nested
 * inline-block (or a display:none/absolute box) from the line.
 */
function skipSubtree(walker: FlatTreeWalker<Node>): boolean {
	while (!walker.nextSibling()) {
		if (!walker.parentNode()) return false;
	}
	return true;
}

/**
 * The min and max constraints on a box, from the cascade to the layout node.
 *
 * Left UNSET where the cascade leaves it, never pinned to 0: min-width
 * defaults to `auto`, which on a flex item is its content-based minimum --
 * pinning it to 0 lets the item shrink to nothing while its text stays as wide
 * as its longest word, and paint straight over whatever is next to it.
 */
function applyMinMax(
	flexNode: FlexTypes.Node,
	computedStyle: ComputedStyle,
): void {
	const constraints = [
		["min-width", flexNode.setMinWidth, flexNode.setMinWidthPercent],
		["min-height", flexNode.setMinHeight, flexNode.setMinHeightPercent],
		["max-width", flexNode.setMaxWidth, flexNode.setMaxWidthPercent],
		["max-height", flexNode.setMaxHeight, flexNode.setMaxHeightPercent],
	] as const;
	for (const [property, setLength, setPercent] of constraints) {
		const value = parseUnitValue(computedStyle.computedValueOf(property));
		if (typeof value === "number") {
			setLength.call(flexNode, value);
		} else if (value && "percentage" in value) {
			setPercent.call(flexNode, value.percentage);
		} else {
			setLength.call(flexNode, undefined);
		}
	}
}

/** The four insets, each with the edge it names. */
const INSET_EDGES = [
	["left", Flex.EDGE_LEFT],
	["top", Flex.EDGE_TOP],
	["right", Flex.EDGE_RIGHT],
	["bottom", Flex.EDGE_BOTTOM],
] as const;

/**
 * The insets on a positioned box, from the cascade to the layout node.
 *
 * `auto` is a declaration only an absolutely positioned box acts on -- there it
 * says "wherever the box would have been", which the compute core has to be
 * told; a relative or fixed box simply takes no offset on that edge.
 */
function applyInsets(
	flexNode: FlexTypes.Node,
	computedStyle: ComputedStyle,
	edges: ReadonlyArray<readonly [string, number]>,
	autoWhenUnset: boolean,
): void {
	for (const [property, edge] of edges) {
		const value = parseUnitValue(computedStyle.computedValueOf(property));
		if (typeof value === "number") {
			flexNode.setPosition(edge, value);
		} else if (value && "percentage" in value) {
			flexNode.setPositionPercent(edge, value.percentage);
		} else if (autoWhenUnset) {
			const declared = computedStyle.computedValueOf(property);
			if (declared === "auto" || !declared) flexNode.setPositionAuto(edge);
		}
	}
}

function styleFlexNode(
	element: Element,
	flexNode: FlexTypes.Node,
	positionedElements?: Set<Element>,
): void {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element must have an ownerDocument with defaultView");
	}
	const computedStyle = computedStyleOf(element);

	// Skip box model properties for inline elements (not inline-block)
	const display = computedStyle.computedValueOf("display");
	// A flex item is BLOCKIFIED (css-display-3 §2.7): `display: inline` on a
	// flex container's child computes to block, so its width and height apply
	// like any block's. Forcing them auto here let the measure function answer
	// with the content size instead, and `<span style="width:30ch">` inside a
	// flex row came out as wide as its text.
	const parentIsFlex = hasFlexParent(element);
	// Handle width/height based on display type
	if (display === "inline" && !parentIsFlex) {
		// For pure inline elements, unset dimensions since they handle dimensions in their measure function
		flexNode.setWidthAuto();
		flexNode.setHeightAuto();
		// Also unset min/max constraints for pure inline elements
		flexNode.setMinWidth(undefined);
		flexNode.setMinHeight(undefined);
		flexNode.setMaxWidth(undefined);
		flexNode.setMaxHeight(undefined);
	} else if (display === "inline-block") {
		// For inline-block elements, unset width/height but preserve min/max constraints
		// This allows the measure function to work while still respecting CSS constraints
		flexNode.setWidthAuto();
		flexNode.setHeightAuto();

		applyMinMax(flexNode, computedStyle);
	} else {
		// For block elements, apply explicit dimensions normally
		const width = parseUnitValue(computedStyle.computedValueOf("width"));
		if (typeof width === "number") {
			flexNode.setWidth(width);
		} else if (width && "percentage" in width) {
			flexNode.setWidthPercent(width.percentage);
		} else {
			flexNode.setWidthAuto();
		}

		const height = parseUnitValue(computedStyle.computedValueOf("height"));
		if (typeof height === "number") {
			flexNode.setHeight(height);
		} else if (height && "percentage" in height) {
			flexNode.setHeightPercent(height.percentage);
		} else {
			flexNode.setHeightAuto();
		}

		applyMinMax(flexNode, computedStyle);
	}

	// Box model properties: clear for inline elements, apply for block/
	// inline-block -- and for a blockified inline flex item, which keeps its
	// padding, margin and border like any block (css-display-3 §2.7). Without
	// the parentIsFlex exception, `.row{display:flex} .row span{padding:1}`
	// dropped the span's padding entirely.
	if (display === "inline" && !parentIsFlex) {
		// Clear all box model properties for inline elements
		flexNode.setMargin(Flex.EDGE_TOP, 0);
		flexNode.setMargin(Flex.EDGE_RIGHT, 0);
		flexNode.setMargin(Flex.EDGE_BOTTOM, 0);
		flexNode.setMargin(Flex.EDGE_LEFT, 0);

		flexNode.setPadding(Flex.EDGE_TOP, 0);
		flexNode.setPadding(Flex.EDGE_RIGHT, 0);
		flexNode.setPadding(Flex.EDGE_BOTTOM, 0);
		flexNode.setPadding(Flex.EDGE_LEFT, 0);

		flexNode.setBorder(Flex.EDGE_TOP, 0);
		flexNode.setBorder(Flex.EDGE_RIGHT, 0);
		flexNode.setBorder(Flex.EDGE_BOTTOM, 0);
		flexNode.setBorder(Flex.EDGE_LEFT, 0);
	} else {
		// Apply normal box model properties for block/inline-block elements

		// Margins
		const marginTop = parseSignedUnitValue(
			computedStyle.computedValueOf("margin-top"),
		);
		if (typeof marginTop === "number") {
			flexNode.setMargin(Flex.EDGE_TOP, marginTop);
		} else if (marginTop && "percentage" in marginTop) {
			flexNode.setMarginPercent(Flex.EDGE_TOP, marginTop.percentage);
		} else {
			const originalValue = computedStyle.computedValueOf("margin-top");
			if (originalValue === "auto") {
				flexNode.setMarginAuto(Flex.EDGE_TOP);
			} else {
				flexNode.setMargin(Flex.EDGE_TOP, undefined);
			}
		}

		const marginRight = parseSignedUnitValue(
			computedStyle.computedValueOf("margin-right"),
		);
		if (typeof marginRight === "number") {
			flexNode.setMargin(Flex.EDGE_RIGHT, marginRight);
		} else if (marginRight && "percentage" in marginRight) {
			flexNode.setMarginPercent(Flex.EDGE_RIGHT, marginRight.percentage);
		} else {
			const originalValue = computedStyle.computedValueOf("margin-right");
			if (originalValue === "auto") {
				flexNode.setMarginAuto(Flex.EDGE_RIGHT);
			} else {
				flexNode.setMargin(Flex.EDGE_RIGHT, undefined);
			}
		}

		const marginBottom = parseSignedUnitValue(
			computedStyle.computedValueOf("margin-bottom"),
		);
		if (typeof marginBottom === "number") {
			flexNode.setMargin(Flex.EDGE_BOTTOM, marginBottom);
		} else if (marginBottom && "percentage" in marginBottom) {
			flexNode.setMarginPercent(Flex.EDGE_BOTTOM, marginBottom.percentage);
		} else {
			const originalValue = computedStyle.computedValueOf("margin-bottom");
			if (originalValue === "auto") {
				flexNode.setMarginAuto(Flex.EDGE_BOTTOM);
			} else {
				flexNode.setMargin(Flex.EDGE_BOTTOM, undefined);
			}
		}

		const marginLeft = parseSignedUnitValue(
			computedStyle.computedValueOf("margin-left"),
		);
		if (typeof marginLeft === "number") {
			flexNode.setMargin(Flex.EDGE_LEFT, marginLeft);
		} else if (marginLeft && "percentage" in marginLeft) {
			flexNode.setMarginPercent(Flex.EDGE_LEFT, marginLeft.percentage);
		} else {
			const originalValue = computedStyle.computedValueOf("margin-left");
			if (originalValue === "auto") {
				flexNode.setMarginAuto(Flex.EDGE_LEFT);
			} else {
				flexNode.setMargin(Flex.EDGE_LEFT, undefined);
			}
		}

		// Paddings
		const paddingTop = parseUnitValue(
			computedStyle.computedValueOf("padding-top"),
		);
		if (typeof paddingTop === "number") {
			flexNode.setPadding(Flex.EDGE_TOP, paddingTop);
		} else if (paddingTop && "percentage" in paddingTop) {
			flexNode.setPaddingPercent(Flex.EDGE_TOP, paddingTop.percentage);
		} else {
			flexNode.setPadding(Flex.EDGE_TOP, undefined);
		}

		const paddingRight = parseUnitValue(
			computedStyle.computedValueOf("padding-right"),
		);
		if (typeof paddingRight === "number") {
			flexNode.setPadding(Flex.EDGE_RIGHT, paddingRight);
		} else if (paddingRight && "percentage" in paddingRight) {
			flexNode.setPaddingPercent(Flex.EDGE_RIGHT, paddingRight.percentage);
		} else {
			flexNode.setPadding(Flex.EDGE_RIGHT, undefined);
		}

		const paddingBottom = parseUnitValue(
			computedStyle.computedValueOf("padding-bottom"),
		);
		if (typeof paddingBottom === "number") {
			flexNode.setPadding(Flex.EDGE_BOTTOM, paddingBottom);
		} else if (paddingBottom && "percentage" in paddingBottom) {
			flexNode.setPaddingPercent(Flex.EDGE_BOTTOM, paddingBottom.percentage);
		} else {
			flexNode.setPadding(Flex.EDGE_BOTTOM, undefined);
		}

		const paddingLeft = parseUnitValue(
			computedStyle.computedValueOf("padding-left"),
		);
		if (typeof paddingLeft === "number") {
			flexNode.setPadding(Flex.EDGE_LEFT, paddingLeft);
		} else if (paddingLeft && "percentage" in paddingLeft) {
			flexNode.setPaddingPercent(Flex.EDGE_LEFT, paddingLeft.percentage);
		} else {
			flexNode.setPadding(Flex.EDGE_LEFT, undefined);
		}

		// Border widths. The USED width is 0 when the side's style is none or
		// hidden (css-backgrounds §3.3) -- same gate as getBoxModel, or the
		// two box models disagree about the same element.
		const usedBorderWidth = (side: string) => {
			const style = computedStyle.computedValueOf(`border-${side}-style`);
			if (!style || style === "none" || style === "hidden") return null;
			return parseBorderWidthValue(
				computedStyle.computedValueOf(`border-${side}-width`),
			);
		};
		const borderTopWidth = usedBorderWidth("top");
		if (typeof borderTopWidth === "number" && borderTopWidth > 0) {
			flexNode.setBorder(Flex.EDGE_TOP, borderTopWidth);
		} else {
			flexNode.setBorder(Flex.EDGE_TOP, 0);
		}

		const borderRightWidth = usedBorderWidth("right");
		if (typeof borderRightWidth === "number" && borderRightWidth > 0) {
			flexNode.setBorder(Flex.EDGE_RIGHT, borderRightWidth);
		} else {
			flexNode.setBorder(Flex.EDGE_RIGHT, 0);
		}

		const borderBottomWidth = usedBorderWidth("bottom");
		if (typeof borderBottomWidth === "number" && borderBottomWidth > 0) {
			flexNode.setBorder(Flex.EDGE_BOTTOM, borderBottomWidth);
		} else {
			flexNode.setBorder(Flex.EDGE_BOTTOM, 0);
		}

		const borderLeftWidth = usedBorderWidth("left");
		if (typeof borderLeftWidth === "number" && borderLeftWidth > 0) {
			flexNode.setBorder(Flex.EDGE_LEFT, borderLeftWidth);
		} else {
			flexNode.setBorder(Flex.EDGE_LEFT, 0);
		}
	}

	// An inline-block flex item's measure already returns a border-box size, so
	// the flex node must not add padding+border again on the CROSS axis (it
	// double-counts, e.g. a bordered textarea in a flex row is too tall). Zero the
	// cross-axis edges only -- the main axis is masked by flex sizing.
	if (display === "inline-block" && parentIsFlex) {
		const direction = getPropertyValue(
			element.parentElement!,
			"flex-direction",
		);
		const crossEdges =
			direction === "column" || direction === "column-reverse"
				? [Flex.EDGE_LEFT, Flex.EDGE_RIGHT]
				: [Flex.EDGE_TOP, Flex.EDGE_BOTTOM];
		for (const edge of crossEdges) {
			flexNode.setPadding(edge, 0);
			flexNode.setBorder(edge, 0);
		}
	}

	// Flex item properties. A block container reads none of them -- they are
	// applied whatever the parent is, and simply go unasked outside a flex
	// container, which is what CSS says of them.
	const flexGrow = computedStyle.computedValueOf("flex-grow");
	const growValue = parseFloat(flexGrow);
	if (!isNaN(growValue) && growValue >= 0) {
		flexNode.setFlexGrow(growValue);
	} else {
		flexNode.setFlexGrow(undefined);
	}

	const orderValue = parseInt(computedStyle.computedValueOf("order"), 10);
	flexNode.setOrder(Number.isNaN(orderValue) ? undefined : orderValue);

	const flexShrink = computedStyle.computedValueOf("flex-shrink");
	const shrinkValue = parseFloat(flexShrink);
	if (!isNaN(shrinkValue) && shrinkValue >= 0) {
		flexNode.setFlexShrink(shrinkValue);
	} else {
		flexNode.setFlexShrink(undefined);
	}

	const flexBasis = parseUnitValue(computedStyle.computedValueOf("flex-basis"));
	if (typeof flexBasis === "number") {
		flexNode.setFlexBasis(flexBasis);
	} else if (flexBasis && "percentage" in flexBasis) {
		flexNode.setFlexBasisPercent(flexBasis.percentage);
	} else {
		const originalValue = computedStyle.computedValueOf("flex-basis");
		if (originalValue === "auto") {
			flexNode.setFlexBasisAuto();
		} else {
			flexNode.setFlexBasis(undefined);
		}
	}

	const alignSelf = computedStyle.computedValueOf("align-self");
	if (alignSelf === "auto") {
		flexNode.setAlignSelf(Flex.ALIGN_AUTO);
	} else {
		const alignValue = getFlexConstant("align", alignSelf);
		if (alignValue !== null) {
			flexNode.setAlignSelf(alignValue);
		} else {
			flexNode.setAlignSelf(Flex.ALIGN_AUTO);
		}
	}

	// gap. The `gap` shorthand is expanded in the cascade, so reading the
	// longhands here is enough and gets the precedence right.
	const rowGap = parseUnitValue(computedStyle.computedValueOf("row-gap"));
	if (typeof rowGap === "number") {
		flexNode.setGap(Flex.GUTTER_ROW, rowGap);
	}

	const columnGap = parseUnitValue(computedStyle.computedValueOf("column-gap"));
	if (typeof columnGap === "number") {
		flexNode.setGap(Flex.GUTTER_COLUMN, columnGap);
	}

	if (display === "none") {
		flexNode.setDisplay(Flex.DISPLAY_NONE);
	} else if (display === "flex") {
		flexNode.setDisplay(Flex.DISPLAY_FLEX);
	} else if (display === "table") {
		// A layout mode of its own: columns are shared across rows, which a box
		// per <tr> stacked on its own structurally cannot express.
		flexNode.setDisplay(Flex.DISPLAY_TABLE);
		flexNode.setBorderCollapse(
			computedStyle.computedValueOf("border-collapse") === "collapse",
		);
	} else if (display === "table-header-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_HEADER_GROUP);
	} else if (display === "table-footer-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_FOOTER_GROUP);
	} else if (display === "table-row-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_ROW_GROUP);
	} else if (display === "table-caption") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_CAPTION);
	} else if (display === "table-column" || display === "table-column-group") {
		// Columns carry style, not a box of their own.
		flexNode.setDisplay(Flex.DISPLAY_NONE);
	} else if (display === "table-row") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_ROW);
	} else if (display === "table-cell") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_CELL);
		flexNode.setColSpan(parseSpanAttribute(element, "colspan"));
		flexNode.setRowSpan(parseSpanAttribute(element, "rowspan"));

		// Add default padding for table cells if not explicitly set
		const paddingLeft = computedStyle.computedValueOf("padding-left");
		const paddingRight = computedStyle.computedValueOf("padding-right");
		if (!paddingLeft || paddingLeft === "0px") {
			flexNode.setPadding(Flex.EDGE_LEFT, 1); // 1 character padding
		}
		if (!paddingRight || paddingRight === "0px") {
			flexNode.setPadding(Flex.EDGE_RIGHT, 1); // 1 character padding
		}
	}

	// Handle flex direction for flex containers (not table-row which has fixed direction)
	if (display === "flex") {
		const flexDirection = computedStyle.computedValueOf("flex-direction");
		if (flexDirection === "row") {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_ROW);
		} else if (flexDirection === "row-reverse") {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_ROW_REVERSE);
		} else if (flexDirection === "column") {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		} else if (flexDirection === "column-reverse") {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN_REVERSE);
		} else {
			flexNode.setFlexDirection(Flex.FLEX_DIRECTION_ROW);
		}

		const flexWrap = computedStyle.computedValueOf("flex-wrap");
		if (flexWrap === "nowrap") {
			flexNode.setFlexWrap(Flex.WRAP_NO_WRAP);
		} else if (flexWrap === "wrap") {
			flexNode.setFlexWrap(Flex.WRAP_WRAP);
		} else if (flexWrap === "wrap-reverse") {
			flexNode.setFlexWrap(Flex.WRAP_WRAP_REVERSE);
		} else {
			flexNode.setFlexWrap(Flex.WRAP_NO_WRAP);
		}

		const justifyContent = computedStyle.computedValueOf("justify-content");
		const justifyValue = getFlexConstant("justify", justifyContent);
		if (justifyValue !== null) {
			flexNode.setJustifyContent(justifyValue);
		} else {
			flexNode.setJustifyContent(Flex.JUSTIFY_FLEX_START);
		}

		const alignItems = computedStyle.computedValueOf("align-items");
		const alignValue = getFlexConstant("align", alignItems);
		if (alignValue !== null) {
			flexNode.setAlignItems(alignValue);
		} else {
			flexNode.setAlignItems(Flex.ALIGN_STRETCH);
		}

		const alignContent = computedStyle.computedValueOf("align-content");
		const alignContentValue = getFlexConstant("align", alignContent);
		if (alignContentValue !== null) {
			flexNode.setAlignContent(alignContentValue);
		} else {
			flexNode.setAlignContent(Flex.ALIGN_FLEX_START);
		}
	} else if (display !== "none" && !display.startsWith("table")) {
		// Block layout. Displays decided above (table parts, `none`) must not be
		// overwritten here. Resetting a table-caption to block leaves the table
		// unable to find its own caption; resetting a runtime-hidden element
		// (DISPLAY_NONE, set a hundred lines up) back keeps its rows painting
		// and pushes everything below it down.
		flexNode.setDisplay(Flex.DISPLAY_BLOCK);
	}

	// A block formatting context contains its children's margins: none of them
	// collapses through its edges (css2 §8.3.1, §9.4.1). `block` and `list-item`
	// are the only displays whose box joins the formatting context around it;
	// every other one -- an atomic inline, a flex or grid container, a table
	// part -- establishes its own. The document element is the outermost one,
	// and BODY is the box the camera measures the document by, so margins stop
	// there rather than escaping into the viewport.
	flexNode.setBlockFormattingContext(
		element === element.ownerDocument?.documentElement ||
			element.tagName === "BODY" ||
			(display !== "block" && display !== "list-item") ||
			computedStyle.computedValueOf("overflow") !== "visible" ||
			isOutOfFlow(element) ||
			parentIsFlex,
	);

	// Handle positioning properties
	const position = computedStyle.computedValueOf("position");
	// The stacking-context painter hoists positioned boxes to their context
	// root; this registry is how it finds them without an O(document) sweep
	// per frame. Membership follows the style application that created or
	// restyled the box.
	if (positionedElements) {
		if (position && position !== "static") {
			positionedElements.add(element);
		} else {
			positionedElements.delete(element);
		}
	}
	if (position === "absolute") {
		flexNode.setPositionType(Flex.POSITION_TYPE_ABSOLUTE);
		applyInsets(flexNode, computedStyle, INSET_EDGES, true);
	} else if (position === "relative") {
		flexNode.setPositionType(Flex.POSITION_TYPE_RELATIVE);
		// A relative box is offset from where it would have sat, and the offset
		// this engine applies is the start-edge one: `right`/`bottom` alone do
		// not move it.
		applyInsets(flexNode, computedStyle, INSET_EDGES.slice(0, 2), false);
	} else if (position === "fixed") {
		// The viewport is the containing block, and there is no fixed position
		// type in the compute core: absolute against the root is the same
		// placement, and the camera is what keeps it still.
		flexNode.setPositionType(Flex.POSITION_TYPE_ABSOLUTE);
		applyInsets(flexNode, computedStyle, INSET_EDGES, false);
	} else if (position === "static") {
		flexNode.setPositionType(Flex.POSITION_TYPE_STATIC);
	} else {
		flexNode.setPositionType(Flex.POSITION_TYPE_STATIC);
	}
}

class DOMRectList extends Array<DOMRect> implements globalThis.DOMRectList {
	item(index: number): globalThis.DOMRect | null {
		if (index < 0 || index >= this.length) {
			return null;
		}
		return this[index];
	}
}

Object.defineProperty(DOMRectList.prototype, Symbol.toStringTag, {
	value: "DOMRectList",
	configurable: true,
});

// Inline layout types (moved from breaker.ts)
interface InlineBlockLeaf {
	type: "inline-block";
	node: Element;
	breakResult?: BreakResult;
	boxModel: BoxModel;
	contentWidth: number;
	contentHeight: number;
}

interface TextLeaf {
	type: "text";
	node: Text;
	content: string;
}

interface BRLeaf {
	type: "br";
	node: HTMLBRElement;
}

type Leaf = InlineBlockLeaf | TextLeaf | BRLeaf;

interface LineResult {
	segments: Array<{
		leaf: Leaf;
		start: number;
		end: number;
		x: number;
		width: number;
		processedText: string;
		/**
		 * The range of the leaf text node's raw `data` this segment renders,
		 * trimmed to begin and end on a rendered character: rendering it under
		 * the node's `white-space` reproduces `processedText` exactly, which is
		 * how a consumer holding nothing but the DOM recovers the characters
		 * painted here. Both zero for a leaf that is not text.
		 */
		dataStart: number;
		dataEnd: number;
		/**
		 * The paragraph direction this segment's characters were reordered into,
		 * null while they stand in logical order (no bidirectional text on the
		 * line, or a terminal that reorders for itself).
		 */
		visualBase: "ltr" | "rtl" | null;
	}>;
	y: number;
	width: number;
	height: number;
}

interface BreakResult {
	lines: LineResult[];
	maxLineWidth: number;
	totalHeight: number;
	/**
	 * The available width lines were broken against, for text-align:center/right
	 * to offset a line's used width (line.width) within it. Unset when the
	 * constraint wasn't a finite width (shrink-to-fit content has nothing to
	 * center/right-align within).
	 */
	containerWidth?: number;
}

interface BreakOptions {
	maxWidth: number;
	whiteSpace?: string;
	nowrap?: boolean;
}

interface ProcessedContent {
	items: Array<{
		leafNode: Leaf;
		start: number;
		end: number;
		processedContent?: string;
		/**
		 * The mapping from `processedContent`'s code units back to offsets in
		 * the leaf text node's raw `data`. Null where the two are the same.
		 */
		dataOffsets?: RenderedOffsets | null;
	}>;
	text: string;
	/**
	 * Cumulative cell widths over `text`: entry i is the width of text[0..i), so
	 * any range measures as prefixWidths[end] - prefixWidths[start]. An
	 * inline-block's whole box sits on its placeholder character, and a leading
	 * or trailing fragment of a grapheme cluster carries none of the cluster's
	 * width.
	 */
	prefixWidths: Float64Array;
}

interface BreakPoint {
	position: number;
	required: boolean;
}

/** An inline-block's margin box: what a line has to reserve for it. */
function inlineBlockWidth(leaf: InlineBlockLeaf): number {
	return (
		leaf.contentWidth +
		leaf.boxModel.paddingLeft +
		leaf.boxModel.paddingRight +
		leaf.boxModel.borderLeftWidth +
		leaf.boxModel.borderRightWidth +
		leaf.boxModel.marginLeft +
		leaf.boxModel.marginRight
	);
}

/** See ProcessedContent.prefixWidths. */
function prefixWidths(
	items: ProcessedContent["items"],
	text: string,
): Float64Array {
	const widths = new Float64Array(text.length + 1);
	for (const item of items) {
		if (item.leafNode.type === "text") {
			// Item offsets address the joined run text, which is what a
			// measurement range addresses too; a leaf's processed text occupies
			// exactly its own range of it.
			writeClusterWidths(text.slice(item.start, item.end), widths, item.start);
		} else if (item.leafNode.type === "inline-block") {
			// The placeholder character stands for the whole margin box. A <br>'s
			// newline stands for nothing and keeps its zero.
			widths[item.end - 1] = inlineBlockWidth(item.leafNode);
		}
	}

	let total = 0;
	for (let i = 0; i < text.length; i++) {
		const cell = widths[i];
		widths[i] = total;
		total += cell;
	}
	widths[text.length] = total;
	return widths;
}

/**
 * One laid-out line of a text node: its box, and the range of the node's raw
 * `data` the line renders. The range begins and ends on a rendered character,
 * so `renderTextFragment` over it reproduces the painted characters.
 */
interface LineFragment {
	rect: globalThis.DOMRect;
	/** Data offset of the line's first character / caret slot. */
	startOffset: number;
	/** Data offset of the caret slot AFTER the line's last character. */
	endOffset: number;
	/** See LineResult segments: the visual order the line was laid out in. */
	visualBase: "ltr" | "rtl" | null;
}

/** The `white-space` a text node renders under: its flat-tree parent's. */
/** Every text node under a node, in tree order -- the node itself included. */
function* textNodesUnder(root: Node): Generator<Text> {
	if (root.nodeType === root.TEXT_NODE) {
		yield root as Text;
		return;
	}
	for (const child of Array.from(root.childNodes)) {
		yield* textNodesUnder(child);
	}
}

function whiteSpaceOf(textNode: Text): string {
	const parent = flatParentElement<Element>(textNode);
	return parent ? getPropertyValue(parent, "white-space") : "normal";
}

/** One text node's placed fragment within a break result. See #rectTextIndices. */
interface TextFragmentEntry {
	line: number;
	x: number;
	width: number;
	text: string;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
	ord: number;
}

/**
 * One line of an inline box as the breaker left it: where it sits, the
 * processed characters it placed there, and the range of raw `data` those
 * characters were rendered from.
 *
 * A line asked for over an ELEMENT merges the fragments of every text node the
 * element covers, so its offsets span from the first node's start to the last
 * node's end -- a range of the run rather than of any one node's data.
 */
export interface RectText {
	rect: DOMRect;
	text: string;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
}

const flexConfig = Flex.Config.create();
flexConfig.setPointScaleFactor(1.0);

/**
 * What generated a box. Two kinds, which is what a document generates here:
 *
 * - `node`: the principal box of a DOM node -- an element's own box (a block
 *   container, a blockified child of a flex container, an atomic inline), and
 *   the box of a text node no anonymous box gathered.
 * - `anonymous`: one contiguous run of inline-level flow children of a block
 *   container (CSS2 §9.2.1.1), belonging to no DOM node at all.
 */
type BoxKind = "node" | "anonymous";

/**
 * A box of the box tree: what a container generates for its content, linked
 * to the box that holds it and to the boxes it holds in turn.
 *
 * Identity is what layout keys on, so it outlives derivation: a principal box
 * is its node's for as long as the node is one, and an anonymous box is its
 * ordinal among its container's runs -- the third run of a paragraph stays the
 * third when its first node is deleted, when its text changes, when a member
 * is inserted. A rebuild reconciles against the boxes it replaces rather than
 * making new ones, which is what lets flex nodes and fragments be keyed by
 * box.
 *
 * `head` is whichever node opens the box at this moment, and nothing but
 * measurement hangs off it -- a run whose first node leaves the tree keeps its
 * box, its position among its container's children, and its fragments, and
 * re-measures from the node that now opens it.
 *
 * `styledFrom` is the element an anonymous box's layout node took its style
 * from, null while a text node heads the run: an anonymous box has no style of
 * its own, so a run headed by an inline box takes that box's, exactly as its
 * measurement does.
 */
class Box {
	readonly kind: BoxKind;

	/** The DOM node this is the principal box of; null for anonymous boxes. */
	readonly node: Node | null;

	/** The box that holds this one, null for a box no container derived. */
	parent: Box | null = null;

	/**
	 * The container-level nodes whose content an anonymous box lays out, in
	 * order. The box OWNS them: they are what the derivation put in it, not
	 * something re-derived by walking the tree from a starting node. A walk has
	 * to decide where the run ends -- a question the derivation has already
	 * answered -- and it asks a node that may since have left the tree, which
	 * is a measurement of nothing at all.
	 */
	members: Node[] = [];

	/**
	 * The boxes this one holds, in order, and the box each flow child's content
	 * falls under. Null until a derivation has run: a box whose children were
	 * never derived is not a box with none.
	 */
	children: Box[] | null = null;
	heads: Map<Node, Box> | null = null;

	/** The structural generation the children were derived at. */
	structure = -1;

	/**
	 * Whether an inline box was broken around a block-level box, so that it lays
	 * out none of its own content: the fragments on either side and the block
	 * between them are boxes of its container (css2 §9.2.1.1). Written by the
	 * container's enumeration, which is where the break is decided.
	 */
	broken = false;

	/**
	 * Whether the box holds fragments a broken inline handed over, which is what
	 * makes its children stop corresponding to the child nodes it was written
	 * with -- those boxes' nodes live a level down, and the inline's own later
	 * children own no box here at all.
	 */
	holdsFragments = false;

	/**
	 * The layout node an anonymous box owns. A principal box's layout node is
	 * its DOM node's, held in `nodeMap`: the layout tree is keyed by node, and
	 * only a box with no node of its own has one to keep here.
	 */
	flexNode: FlexTypes.Node | null = null;
	styledFrom: Element | null = null;

	/**
	 * The layout root an atomic inline's own children are laid out under. The
	 * box measures its content as one opaque unit for the run it sits on, so
	 * nothing above it can lay those children out; its measurement does, and
	 * reads their geometry back relative to the box's content edge. Owned here,
	 * with the box's lifetime: the children under it are this box's children,
	 * and there is nowhere else to ask.
	 */
	contentRoot: FlexTypes.Node | null = null;

	/**
	 * The lines this box's last PLACING measurement broke its content into.
	 * They are the product of the size the box currently has -- a sizing probe
	 * at some other width never becomes what the painter sees, so only the
	 * measurement that placed the box writes here.
	 */
	fragments: BreakResult | null = null;

	constructor(kind: BoxKind, node: Node | null, parent: Box | null = null) {
		this.kind = kind;
		this.node = node;
		this.parent = parent;
	}

	/** The node that opens the box: what its own styles, if any, come from. */
	get head(): Node {
		return this.node ?? this.members[0];
	}

	/** The block container whose box holds this one. */
	get container(): Element {
		return this.parent!.node as Element;
	}
}

// Symbol-keyed so the invalidation test can spy on it (a #private method's
// internal calls are invisible to a spy). Not on the public LayoutEngine type;
// index.ts does not re-export it.
const kInvalidateInlineRun = Symbol("invalidateInlineRun");
export {kInvalidateInlineRun};

// The breaker's own fragments, processed text and all: an inline box's lines as
// the line breaker produced them. Symbol-keyed because nothing outside layout
// may reason about processed text -- geometry consumers read `getRects`,
// `getRangeRects` or `lineFragments`, whose fragments carry data offsets a
// consumer can render for itself. The layout tests reach it through the symbol.
const kRectTexts = Symbol("rectTexts");
export {kRectTexts};

export class LayoutEngine {
	declare DOMRect: typeof DOMRect;
	declare rootElement: Element;
	declare window: EngineWindow;

	declare terminalWidth: number;
	declare terminalHeight: number;

	// Viewport root node - represents terminal dimensions, no DOM element associated
	declare viewportRootNode: FlexTypes.Node;

	// Public Map for debugging
	nodeMap: Map<Node, FlexTypes.Node>;

	/**
	 * Every box currently holding lines, by the node that opens it. Derived on
	 * demand from the boxes themselves: a principal box holds lines only while
	 * its node has a layout node, and an anonymous box that leaves the tree is
	 * retired, so neither can appear here after it is gone.
	 */
	get breakResultMap(): Map<Node, BreakResult> {
		const results = new Map<Node, BreakResult>();
		for (const node of this.nodeMap.keys()) {
			const lines = this.#boxes.get(node)?.fragments;
			if (lines) results.set(node, lines);
		}
		for (const box of this.#anonymousBoxes.values()) {
			if (box.fragments) results.set(box.head, box.fragments);
		}
		return results;
	}

	// The reverse of nodeMap -- always kept in sync with it via #trackNode/
	// #untrackNode, never written directly elsewhere. Lets paint-time culling
	// go from a flex child (found by binary search over its parent's already-
	// ordered children[]) back to the DOM/pseudo-element node it needs to
	// paint, without re-deriving that order with a second full tree walk.
	#domNodeByFlexNode: Map<FlexTypes.Node, Node>;

	// Track nodes that were invalidated and need re-adding during calculateLayout
	#invalidatedNodes: Set<Node>;
	/**
	 * Every element whose computed position was not static when styleFlexNode
	 * last styled it.
	 *
	 * A SUPERSET hint, not a register of what is positioned now: an element
	 * whose position went static without a restyle reaching its flex node is
	 * still named here. So membership is never the answer on its own -- every
	 * reader asks `isPositioned` as well, and takes the set only for the
	 * enumeration it saves. Positioned boxes are rare, so the paint side's
	 * per-frame grouping is O(positioned), never O(document).
	 */
	positionedElements = new Set<Element>();

	// Track layout nodes that have measure functions (for resize invalidation)
	#measureNodes: Set<FlexTypes.Node>;

	/**
	 * Set when the terminal answered that it reorders bidirectional text itself
	 * (see #negotiateBidi). Then lines stay in logical order: one reordering is
	 * correct, two is a sentence backwards again.
	 */
	#terminalReordersText = false;

	/**
	 * A cluster's advance is now known from the terminal rather than predicted
	 * from the width tables. Nothing in the DOM moved, but every line measured
	 * before the correction was measured against the other answer.
	 */
	invalidateTextMeasurement(): void {
		this.invalidateStructure();
		for (const flexNode of this.#measureNodes) flexNode.markDirty();
	}

	setTerminalReordersText(value: boolean): void {
		// Flips the visual order of every RTL run without a mutation.
		this.invalidateStructure();
		if (this.#terminalReordersText === value) return;
		this.#terminalReordersText = value;
		// Every measured line was built for the other contract.
		for (const flexNode of this.#measureNodes) flexNode.markDirty();
	}

	constructor(window: EngineWindow) {
		this.window = window;
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new Map<Node, FlexTypes.Node>();
		this.#domNodeByFlexNode = new Map<FlexTypes.Node, Node>();
		this.#invalidatedNodes = new Set<Node>();
		this.#measureNodes = new Set<FlexTypes.Node>();

		// Create viewport root node (no DOM element associated)
		this.viewportRootNode = Flex.Node.create();
		this.viewportRootNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		this.viewportRootNode.setAlignItems(Flex.ALIGN_STRETCH);

		// Attach HTML element to viewport root instead of null
		this.#addNode(this.rootElement, this.viewportRootNode);
	}

	resize(width: number, height: number): void {
		this.terminalWidth = width;
		this.terminalHeight = height;

		// Set dimensions on the viewport root node (terminal dimensions)
		this.viewportRootNode.setWidth(width);
		this.viewportRootNode.setHeight(height);

		// Mark all leaf nodes (those with measure functions) as dirty
		// so the engine re-invokes their measure functions with the new available
		// width, dropping the lines measured against the old one
		for (const flexNode of this.#measureNodes) {
			flexNode.markDirty();
		}

		// Force recalculation of all layout after size change
		this.calculateLayout();
	}

	calculateLayout() {
		// Geometry moves with the pass, so anything memoized against the layout
		// epoch -- a resolved value, a rect -- re-measures after it.
		this.#layoutPass++;
		// The cascade has finished for this frame, so the boxes it unsettled
		// can be named against the styles that stand rather than the ones that
		// were on their way out.
		this.#applyRestyles();
		// Nothing marked dirty and nothing awaiting re-add: the previous layout
		// still holds, and even the pruning sweep below -- O(nodes) isConnected
		// checks -- is not worth paying. Every mutation path dirties the tree on
		// its way in, so a clean tree cannot be hiding a disconnection.
		if (
			!this.viewportRootNode.dirty &&
			this.#invalidatedNodes.size === 0 &&
			this.#dirtyRunContainers.size === 0
		) {
			return;
		}

		// Drop nodes whose DOM node is gone. Callers may invoke calculateLayout()
		// synchronously after a DOM removal, before the MutationObserver microtask
		// has run, which would otherwise leave the removed node attached here and
		// get it measured -- and measuring a detached run head has no parent to
		// collect leaves from.
		this.#pruneDisconnectedNodes();

		// Re-add invalidated nodes that are still connected to DOM
		for (const node of this.#invalidatedNodes) {
			if (node.isConnected) {
				// Find parent that has a layout node to attach to. The composed
				// BOX parent: a shadow root's direct child has no parentElement
				// at all, and a display:contents element (never re-visited by
				// the flattening walker, so never retired) can still hold a
				// stale severed node -- attaching under it strands the child
				// in an orphan subtree.
				let parent = boxParentElement(node);
				while (parent) {
					// An inline-block holding block-level content owns no layout
					// node in the tree above -- the run measuring it does -- and
					// lays its children out under a root of its own.
					const parentFlexNode = this.#containerFlexNode(parent);
					if (parentFlexNode) {
						this.#addNode(node, parentFlexNode);
						break;
					}
					// An inline box on the way up owns no layout node because a
					// RUN measures it, and everything inside it with it.
					// Climbing past one lands the content in the run's own
					// container, as a sibling of the line it belongs to. A
					// BROKEN inline is the exception: its fragments really are
					// the container's boxes.
					if (isInlineLevel(parent) && !this.#boxes.get(parent)?.broken) {
						break;
					}
					parent = boxParentElement(parent);
				}
			}
		}
		this.#invalidatedNodes.clear();

		// Give every container whose content moved the boxes it lays out now.
		// Draining rather than iterating: building a block-level box a broken
		// inline handed over reaches containers of its own.
		const synced = new Set<Element>();
		while (this.#dirtyRunContainers.size > 0) {
			const containers = [...this.#dirtyRunContainers];
			this.#dirtyRunContainers.clear();
			for (const container of containers) {
				if (synced.has(container)) continue;
				synced.add(container);
				this.#syncContainerRuns(container);
			}
		}

		// Every mutation path marks the flex tree dirty on its way in -- style
		// setters, child insertion/removal, inline-run invalidation, resize. A
		// clean root therefore means the previous layout is still exact, and
		// recomputing it would be pure waste -- a full-tree relayout per frame
		// for an animation repainting one span.
		if (!this.viewportRootNode.dirty) {
			return;
		}

		// Calculate layout using viewport root node (terminal dimensions)
		// The HTML element can now have auto height and reference viewport via percentages
		this.viewportRootNode.calculateLayout(
			this.terminalWidth,
			this.terminalHeight,
		);
	}

	/**
	 * A node is live if it is still in the document, or -- for pseudo-elements,
	 * which are never "connected" themselves -- if its host element is.
	 */
	#isNodeLive(node: Node): boolean {
		// Flat-tree connectivity: a pseudo-element node and a control's
		// shadow parts are outside the node tree and still render, so the
		// prune sweep must not reap them every frame.
		return flatIsConnected(node);
	}

	#pruneDisconnectedNodes(): void {
		// A box outlives the nodes that pass through it, but not its container.
		for (const box of [...this.#anonymousBoxes.values()]) {
			if (!this.#isNodeLive(box.container)) this.#retireAnonymousBox(box);
		}
		for (const [node, flexNode] of this.nodeMap) {
			if (node === this.rootElement || this.#isNodeLive(node)) {
				continue;
			}

			const parent = flexNode.getParent();
			if (parent) {
				parent.removeChild(flexNode);
			}

			this.#measureNodes.delete(flexNode);
			flexNode.freeRecursive();
			this.#untrackNode(node);
			this.#invalidatedNodes.delete(node);
		}
	}

	/**
	 * Clean up layout nodes and resources
	 */
	dispose(): void {
		// Clean up viewport root node (this will recursively free all child layout nodes)
		this.viewportRootNode.freeRecursive();

		// Clear the maps (now regular Maps for debugging)
		this.nodeMap = new Map();
		this.#domNodeByFlexNode = new Map();
		this.#invalidatedNodes = new Set();
		this.#measureNodes = new Set();
		this.#anonymousBoxes = new Map();
		this.#dirtyRunContainers = new Set();
	}

	/**
	 * Get the actual height of the document content after layout calculation
	 * Used for implementing standard DOM scrollHeight property
	 */
	getContentHeight(): number {
		const bodyRect = this.getRect(this.rootElement.ownerDocument?.body);
		if (bodyRect) {
			return Math.ceil(bodyRect.height);
		}
		return 0;
	}

	/**
	 * The viewport rows occupied by fixed-position content: the hoisted
	 * children of the viewport root, excluding the document's own subtree.
	 */
	fixedRowBands(rows: number): Array<[number, number]> {
		const bands: Array<[number, number]> = [];
		const documentNode = this.nodeMap.get(this.rootElement);
		for (const child of this.viewportRootNode.children) {
			if (child === documentNode) continue;
			const top = Math.max(0, Math.floor(child.getComputedTop()));
			const bottom = Math.min(
				rows,
				Math.ceil(child.getComputedTop() + child.getComputedHeight()),
			);
			if (bottom > top) bands.push([top, bottom]);
		}
		return bands;
	}

	/**
	 * True when nothing in the element's subtree can paint inside the document
	 * rows [top, bottom) -- its cached paint extent (own box unioned with every
	 * descendant's, absolutes included) lies entirely outside the band.
	 *
	 * Conservative: an element without its own layout node is never culled, and
	 * a stale answer is impossible because extents are recomputed with layout
	 * and layout is recomputed whenever the tree is dirty.
	 */
	isSubtreeOutsideBand(element: Element, top: number, bottom: number): boolean {
		// An element with no box of its own is culled by the anonymous box that
		// lays its content out, whose extent covers the whole run it opens.
		const node = this.nodeMap.get(element) ?? this.#runFlexNode(element);
		if (!node) return false;
		if (node.extentBottom > top && node.extentTop < bottom) return false;
		// An inline broken around a block-level box paints boxes that are NOT
		// in its own layout subtree -- the block and the fragment after it are
		// the container's children -- so its extent says nothing about them.
		// The paint walk still reaches them through the DOM, and culling by
		// this node's zero-height first fragment blanked the whole thing:
		// `<a href="..."><div>card</div></a>` rendered empty.
		return !this.#boxes.get(element)?.broken;
	}

	/**
	 * The direct DOM/pseudo-element children of `element` whose paint extent
	 * could intersect document rows [top, bottom), in document order -- found
	 * with a binary search instead of visiting every child, which is what let
	 * paint-time culling of a long list cost O(total children) per frame
	 * instead of O(visible children). Returns null when that search can't be
	 * trusted: children[] is only guaranteed sorted top-to-bottom by extentTop
	 * when the container stacks its children vertically in document order
	 * (a block container) and none of them is position:relative/absolute
	 * (either can land anywhere regardless of DOM order). Callers fall back to
	 * walking every child themselves in that case.
	 */
	visibleChildrenInBand(
		element: Element,
		top: number,
		bottom: number,
	): Node[] | null {
		const flexNode = this.nodeMap.get(element);
		if (
			!flexNode ||
			// A measure-function leaf (an inline/inline-block run head) never gets
			// its DOM children added to the layout tree at all -- they're measured
			// as an opaque unit, not walked -- so an empty children[] here means
			// "not decomposed," not "confirmed nothing to paint." Its real DOM
			// children (e.g. the run head's own text) still need the walker below.
			flexNode.measureFunc !== null ||
			flexNode.unstackedChildCount !== 0 ||
			flexNode.getDisplay() !== Flex.DISPLAY_BLOCK ||
			// A non-run-head member of an inline run (a plain <span> inside
			// running text, but also -- unlike that span -- an inline-block
			// sibling, which paints its own box independently rather than
			// through the run head's text) never gets its own flex node either;
			// it's counted zero times here despite being a real DOM child. Cheap
			// proxy for "every DOM child has exactly one children[] entry,"
			// without walking to find out. A pseudo-element is a child of the
			// box tree with no childNodes entry behind it, so it is counted in:
			// without it, an element whose one child is text and whose ::before
			// heads the run collides at one and one, and the fast path paints
			// the pseudo-element alone.
			element.childNodes.length + pseudoElementCount(element) !==
				flexNode.children.length ||
			// A shadow host's childNodes are its LIGHT children, unrelated to
			// the composed children the layout tree holds -- the counts can
			// collide by accident (1 light child, 1 run head) and the fast
			// path then paints an incomplete child list. Hosts always take the
			// walker.
			shadowRootOf<ShadowRoot>(element) !== null ||
			// So can a container that a broken inline handed boxes to: those
			// boxes are children[] entries whose DOM node lives a level DOWN,
			// while this element's own later children own no entry at all.
			// `<span>a<div/><span>c</span></span>d<input>` collides at three
			// and three, and the fast path painted the fragments while
			// dropping the text and the input after them.
			this.#boxes.get(element)?.holdsFragments === true
		) {
			return null;
		}

		const children = flexNode.children;
		let lo = 0;
		let hi = children.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (children[mid].extentBottom <= top) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}

		const result: Node[] = [];
		for (let i = lo; i < children.length; i++) {
			const child = children[i];
			if (child.extentTop >= bottom) break;
			const domNode = this.#domNodeByFlexNode.get(child);
			if (domNode) result.push(domNode);
		}
		return result;
	}

	#trackNode(domNode: Node, flexNode: FlexTypes.Node): void {
		this.nodeMap.set(domNode, flexNode);
		this.#domNodeByFlexNode.set(flexNode, domNode);
	}

	#untrackNode(domNode: Node): void {
		const flexNode = this.nodeMap.get(domNode);
		if (flexNode) {
			this.#domNodeByFlexNode.delete(flexNode);
		}
		// The lines a box holds are the product of the layout node that is
		// going: nothing lays that content out until a box is built for it
		// again, and the lines would describe a box that no longer exists.
		const box = this.#boxes.get(domNode);
		if (box) box.fragments = null;
		this.nodeMap.delete(domNode);
		if (domNode.nodeType === domNode.ELEMENT_NODE) {
			this.positionedElements.delete(domNode as Element);
		}
	}

	/**
	 * Where an inline-block box landed, read back out of the run that measured
	 * it. Three depths, and only the first is direct:
	 *
	 * - The box owns a layout node (it heads its own run): ask the flex tree.
	 * - It is a MEMBER of a run headed elsewhere ("Name: <input>"): it owns no
	 *   layout node, so segment.x/line.y are RUN-relative and must be anchored
	 *   at the head's absolute position -- returned bare, the input painted at
	 *   the document's own row 0, over whatever lived there.
	 * - It sits inside ANOTHER inline-block, which measured it as part of one
	 *   opaque unit: its coordinates exist only in a break result nested under
	 *   that box's leaf, so the walk below descends into each enclosing
	 *   inline-block at its content edge to reach them. Without that descent,
	 *   `<div style="display:inline-block"><input></div>` -- a widget in any
	 *   inline-block toolbar or card -- resolves to no rect and paints nothing.
	 */
	#inlineBlockRect(element: Element): DOMRect | null {
		// Climb to the nearest enclosing run that was actually laid out on its
		// own: a run measured inside an inline-block publishes no break result
		// (it hangs off that box's leaf instead), and its head may still be
		// holding a flex node left over from before it was absorbed -- one
		// parked at 0,0.
		let runHead: Node | null = this.findInlineRunHead(element);
		let runFlexNode = runHead ? this.#runFlexNode(runHead) : undefined;
		let breakResult = runHead ? this.#runBreakResult(runHead) : undefined;
		while (runHead && !(runFlexNode && breakResult)) {
			const parent = boxParentElement(runHead);
			if (!parent) return null;
			runHead = this.findInlineRunHead(parent) ?? parent;
			runFlexNode = this.#runFlexNode(runHead);
			breakResult = this.#runBreakResult(runHead);
		}
		if (!runHead || !runFlexNode || !breakResult) return null;

		const runPosition = this.#documentPosition(runHead, runFlexNode);
		let originX = runPosition.x;
		let originY = runPosition.y;

		// Outermost-first, so each hop's offsets are expressed in the frame the
		// previous hop just established. The run head itself is IN the chain
		// when it is an inline-block: it heads the run its own box sits in, and
		// the content it wraps lives one break result further down.
		const enclosing: Element[] = [];
		for (
			let ancestor = flatParentElement<Element>(element);
			ancestor;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			enclosing.unshift(ancestor);
			if (ancestor === runHead) break;
		}
		let descended = false;
		for (const ancestor of enclosing) {
			if (getPropertyValue(ancestor, "display") !== "inline-block") continue;
			const hop = findInlineBlockSegment(breakResult, ancestor);
			if (!hop) continue;
			// Border and padding both occupy cells, so the content edge is where
			// the nested run's own origin sits.
			originX +=
				hop.segment.x +
				hop.segment.leaf.boxModel.paddingLeft +
				hop.segment.leaf.boxModel.borderLeftWidth;
			originY +=
				hop.line.y +
				hop.segment.leaf.boxModel.paddingTop +
				hop.segment.leaf.boxModel.borderTopWidth;
			if (hop.segment.leaf.breakResult) {
				breakResult = hop.segment.leaf.breakResult;
				descended = true;
			}
		}

		const target = findInlineBlockSegment(breakResult, element);
		if (!target) return null;

		// Only the run that owns the box can speak for its position. Once the
		// walk descends into a nested measurement, any flex node the box still
		// holds belongs to a layout it is no longer part of.
		const ownFlexNode = descended ? undefined : this.#runFlexNode(element);
		if (ownFlexNode) {
			const {x, y} = this.#documentPosition(element, ownFlexNode);
			return new this.DOMRect(x, y, target.segment.width, target.line.height);
		}
		return new this.DOMRect(
			originX + target.segment.x,
			originY + target.line.y,
			target.segment.width,
			target.line.height,
		);
	}

	/**
	 * A flex node's absolute document position: the sum of computed offsets up
	 * the tree, minus the scrollLeft/scrollTop of every ANCESTOR scroll box
	 * along the way -- a box's own scroll shifts its descendants, not itself.
	 * Scroll is a post-layout content offset, not a flex concept, so it is
	 * applied here, in the single funnel every geometry read passes through, so
	 * paint, getRect, hit-testing, and Range geometry all inherit it at once.
	 */
	#absolutePosition(flexNode: FlexTypes.Node): {x: number; y: number} {
		// The document roots' scrollLeft/scrollTop ARE the camera (the window
		// shim maps them onto the viewport), and the camera is applied once at
		// paint, not in this document-space geometry. Only per-element scroll on
		// other boxes belongs here.
		const document = this.window.document;
		const root = document.documentElement;
		const body = document.body;
		let x = 0;
		let y = 0;
		for (
			let current: FlexTypes.Node | null = flexNode;
			current;
			current = current.getParent()
		) {
			x += current.getComputedLeft();
			y += current.getComputedTop();
			if (current !== flexNode) {
				const node = this.#domNodeByFlexNode.get(current);
				if (
					node &&
					node.nodeType === node.ELEMENT_NODE &&
					node !== root &&
					node !== body
				) {
					x -= (node as Element).scrollLeft || 0;
					y -= (node as Element).scrollTop || 0;
				}
			}
		}
		return {x, y};
	}

	/**
	 * An element's CONTENT box in document coordinates: its border box inset by
	 * the border and padding on every side. Null for an element that generates
	 * no box.
	 *
	 * The one derivation of it. A caret parked at a field's content origin, the
	 * rect an empty line takes, what a ResizeObserver reports and what a child's
	 * percentage resolves against are the same four numbers, and were four
	 * spellings of the same arithmetic.
	 */
	contentRect(element: Element): DOMRect | null {
		const rect = this.getRect(element);
		if (!rect) return null;
		const box = getBoxModel(element);
		const left = (box.borderLeftWidth || 0) + (box.paddingLeft || 0);
		const top = (box.borderTopWidth || 0) + (box.paddingTop || 0);
		const right = (box.borderRightWidth || 0) + (box.paddingRight || 0);
		const bottom = (box.borderBottomWidth || 0) + (box.paddingBottom || 0);
		return this.createDOMRect(
			rect.x + left,
			rect.y + top,
			Math.max(0, rect.width - left - right),
			Math.max(0, rect.height - top - bottom),
		);
	}

	getRect(element: Element): DOMRect | null {
		const display = getPropertyValue(element, "display");

		// A display:none element generates no box, so there is no geometry to
		// report -- the layout node it keeps is a placeholder holding its slot
		// among its container's children, not a box. Its client rects are empty
		// and its resolved values are the computed ones (CSSOM View §4).
		if (display === "none") return null;

		// A blockified box's box is the one the layout tree sized, not the
		// extent of the text it happens to hold: its layout node is the truth,
		// and the run machinery below would report the text union instead. Two
		// kinds blockify (css-display-3 §2.7): a flex container's children, and
		// an out-of-flow box, which no run holds any record of at all.
		const isBlockified =
			isInlineDisplay(display) &&
			this.nodeMap.has(element) &&
			isBlockifiedBox(element);

		if (!isBlockified && isInlineDisplay(display)) {
			if (display === "inline-block") {
				const rect = this.#inlineBlockRect(element);
				if (rect) {
					return rect;
				}
			}

			// For inline elements, the fragments of its run
			const rectTexts = this[kRectTexts](element);
			if (rectTexts.length > 0) {
				return this.unionRect(rectTexts.map((rectText) => rectText.rect));
			}

			// A pure inline element with no text of its own has no inline box to
			// report -- a browser gives a zero-width rect at the position it
			// would occupy. The block fallback below instead returns the layout
			// node's width, which for an empty inline is its containing block's,
			// so `<div style="width:30ch"><span></span></div>` measured the span
			// at 30 columns. inline-block keeps the fallback: its node IS its box.
			if (display === "inline") {
				const runFlexNode = this.#runFlexNode(element);
				// No layout node means the element was removed or never laid
				// out -- null, exactly as the block fallback below reports it.
				// A laid-out empty inline gets a zero-size rect at its position.
				if (!runFlexNode) return null;
				const position = this.#absolutePosition(runFlexNode);
				return new this.DOMRect(position.x, position.y, 0, 0);
			}
		}

		// Fall back to the layout node for block elements and containers -- or,
		// for an inline-block whose own segment is unreadable, to the box that
		// measures the run it opens.
		const flexNode = this.nodeMap.get(element) ?? this.#runFlexNode(element);

		if (!flexNode) {
			return null;
		}

		const {x, y} = this.#documentPosition(element, flexNode);

		return new this.DOMRect(
			x,
			y,
			flexNode.getComputedWidth(),
			flexNode.getComputedHeight(),
		);
	}

	[kRectTexts](node: Node): RectText[] {
		// This method handles two main scenarios:
		// 1. Direct calls on inline-block elements (special case below)
		// 2. Calls on elements/text inside inline-blocks (general walk-up logic)

		// Handle element nodes
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");

			// For block elements, return empty array (no inline text layout)
			if (!isInlineDisplay(display)) {
				return [];
			}

			// An inline broken around a block-level box is a member of no run:
			// its container lays out the fragments on either side as boxes of
			// its own (CSS2 §9.2.1.1). Its fragments are what its inline-level
			// content occupies, which each know the run they sit on; the block
			// between them belongs to the container, not to the inline.
			if (this.#splitsAroundBlock(element)) {
				const fragments: RectText[] = [];
				const walk = (parent: Element): void => {
					for (const child of Array.from(parent.childNodes) as Node[]) {
						if (child.nodeType === child.TEXT_NODE) {
							fragments.push(...this[kRectTexts](child));
						} else if (
							child.nodeType === child.ELEMENT_NODE &&
							isInlineDisplay(getPropertyValue(child as Element, "display"))
						) {
							walk(child as Element);
						}
					}
				};
				walk(element);
				return fragments;
			}

			// Special case: an inline-block element asked for directly.
			// The element's breakResult contains itself as an inline-block segment with nested content
			if (display === "inline-block" && this.isInlineRunHead(element)) {
				const breakResult = this.#runBreakResult(element);
				if (breakResult) {
					// The breakResult contains this inline-block as a segment with nested content
					const rectTexts: RectText[] = [];
					const flexNode = this.#runFlexNode(element);
					if (!flexNode) return [];

					const position = this.#documentPosition(element, flexNode);
					const containerX = position.x;
					const containerY = position.y;

					for (const line of breakResult.lines) {
						for (const segment of line.segments) {
							if (
								segment.leaf.type === "inline-block" &&
								segment.leaf.node === element &&
								segment.leaf.breakResult
							) {
								// Extract text from the nested breakResult. Content
								// starts after border AND padding -- the border
								// occupies real cells.
								const nestedBreakResult = segment.leaf.breakResult;
								const paddingLeft =
									segment.leaf.boxModel.paddingLeft +
									segment.leaf.boxModel.borderLeftWidth;
								const paddingTop =
									segment.leaf.boxModel.paddingTop +
									segment.leaf.boxModel.borderTopWidth;
								for (const nestedLine of nestedBreakResult.lines) {
									for (const nestedSegment of nestedLine.segments) {
										if (nestedSegment.leaf.type === "text") {
											rectTexts.push({
												text: nestedSegment.processedText,
												startOffset: nestedSegment.dataStart,
												endOffset: nestedSegment.dataEnd,
												visualBase: nestedSegment.visualBase,
												rect: new this.DOMRect(
													containerX +
														segment.x +
														paddingLeft +
														nestedSegment.x,
													containerY + line.y + paddingTop + nestedLine.y,
													nestedSegment.width,
													nestedLine.height,
												),
											});
										} else if (
											nestedSegment.leaf.type === "inline-block" &&
											nestedSegment.leaf.breakResult
										) {
											// Recursively extract text from nested inline-block
											const nestedInlineBlock = nestedSegment.leaf;
											const nestedPaddingLeft =
												nestedInlineBlock.boxModel.paddingLeft +
												nestedInlineBlock.boxModel.borderLeftWidth;
											const nestedPaddingTop =
												nestedInlineBlock.boxModel.paddingTop +
												nestedInlineBlock.boxModel.borderTopWidth;

											for (const innerLine of nestedInlineBlock.breakResult!
												.lines) {
												for (const innerSegment of innerLine.segments) {
													if (innerSegment.leaf.type === "text") {
														rectTexts.push({
															text: innerSegment.processedText,
															startOffset: innerSegment.dataStart,
															endOffset: innerSegment.dataEnd,
															visualBase: innerSegment.visualBase,
															rect: new this.DOMRect(
																containerX +
																	segment.x +
																	paddingLeft +
																	nestedSegment.x +
																	nestedPaddingLeft +
																	innerSegment.x,
																containerY +
																	line.y +
																	paddingTop +
																	nestedLine.y +
																	nestedPaddingTop +
																	innerLine.y,
																innerSegment.width,
																innerLine.height,
															),
														});
													}
													// Could add more nesting levels here if needed
												}
											}
										}
									}
								}
							}
						}
					}
					return rectTexts;
				}
			}
		}

		// Find the inline run head for this node
		const runHead = this.findInlineRunHead(node);
		if (!runHead) {
			return [];
		}

		// Get stored BreakResult for the run head
		let breakResult = this.#runBreakResult(runHead);
		if (!breakResult) {
			return [];
		}

		// Get run head's absolute position by accumulating parent positions
		const flexNode = this.#runFlexNode(runHead);
		if (!flexNode) return [];

		let {x: containerX, y: containerY} = this.#documentPosition(
			runHead,
			flexNode,
		);

		// #documentPosition gives the run head's BORDER box. A blockified
		// inline flex item reserved its own padding and border in that box (see
		// styleFlexNode's parentIsFlex exception) but its text ignored them,
		// painting at the border edge instead of below the padding. Push the run
		// in by that box. Scoped to exactly the blockified case: a normal inline
		// has its flex-node box model cleared even when the author declared
		// padding (so getBoxModel would over-report), an inline-block's content
		// offset is already handled by #documentPosition, and a block's
		// run head is a text node with no box.
		if (runHead.nodeType === runHead.ELEMENT_NODE) {
			const runHeadElement = runHead as Element;
			if (
				getPropertyValue(runHeadElement, "display") === "inline" &&
				hasFlexParent(runHeadElement)
			) {
				const runHeadBox = getBoxModel(runHeadElement);
				containerX += runHeadBox.paddingLeft + runHeadBox.borderLeftWidth;
				containerY += runHeadBox.paddingTop + runHeadBox.borderTopWidth;
			}
		}

		// Walk from target node up to runHead, handling nested inline-blocks
		// This handles elements and text inside inline-blocks
		let currentBreakResult = breakResult;
		let accumulatedOffsetX = 0;
		let accumulatedOffsetY = 0;
		let currentNode = node;
		// The element whose text-align governs this breakResult's lines -- the
		// block container normally, but an inline-block's own style once the walk
		// below descends into its nested breakResult, since that's a fresh inline
		// formatting context with its own alignment.
		let alignContainer: Element | null = flatParentElement<Element>(runHead);

		// COMPOSITION parents: a widget's UA shadow text has no parentElement
		// chain to its host at all, so a parentElement walk dies at the shadow
		// boundary and the value resolves to zero fragments.
		while (currentNode !== runHead && flatParentElement<Element>(currentNode)) {
			const parent = flatParentElement<Element>(currentNode)!;

			if (getPropertyValue(parent, "display") === "inline-block") {
				// An overflow-scrolled inline-block (a field's windowed value,
				// scrollLeft set by the caret-follow) shifts its content by its
				// own scroll, so the caret stays in view. A property of the box,
				// independent of whether its segment is found below.
				accumulatedOffsetX -= (parent as Element).scrollLeft || 0;
				accumulatedOffsetY -= (parent as Element).scrollTop || 0;
				// Find this inline-block in current breakResult
				let found = false;
				for (const line of currentBreakResult.lines) {
					for (const segment of line.segments) {
						if (
							segment.leaf.type === "inline-block" &&
							segment.leaf.node === parent
						) {
							// Accumulate offset to the CONTENT edge -- border and
							// padding both occupy cells -- and switch to the
							// internal breakResult.
							accumulatedOffsetX +=
								segment.x +
								segment.leaf.boxModel.paddingLeft +
								segment.leaf.boxModel.borderLeftWidth;
							accumulatedOffsetY +=
								line.y +
								segment.leaf.boxModel.paddingTop +
								segment.leaf.boxModel.borderTopWidth;
							if (segment.leaf.breakResult) {
								currentBreakResult = segment.leaf.breakResult;
								alignContainer = parent;
							}
							found = true;
							break;
						}
					}
					if (found) break;
				}
			}
			currentNode = parent;
		}

		// Apply accumulated offsets
		containerX += accumulatedOffsetX;
		containerY += accumulatedOffsetY;
		breakResult = currentBreakResult;

		// position:relative on an inline RUN MEMBER (no flex node of its own)
		// shifts its painted fragments; walk the box-less ancestors up to the
		// run head accumulating offsets.
		for (
			let ancestor =
				node.nodeType === node.ELEMENT_NODE
					? (node as Element)
					: flatParentElement<Element>(node);
			ancestor && ancestor !== runHead && !this.nodeMap.has(ancestor);
			ancestor = flatParentElement<Element>(ancestor)
		) {
			if (getPropertyValue(ancestor, "position") === "relative") {
				const left = parseUnitValue(getPropertyValue(ancestor, "left"));
				const top = parseUnitValue(getPropertyValue(ancestor, "top"));
				if (typeof left === "number") containerX += left;
				if (typeof top === "number") containerY += top;
			}
		}

		// Collect target text nodes based on node type
		let targetTextNodes: Set<Text>;

		if (node.nodeType === node.TEXT_NODE) {
			targetTextNodes = new Set([node as Text]);
		} else {
			// For element nodes, collect all descendant text nodes
			targetTextNodes = new Set<Text>();

			const walker = flowWalker(node);

			let textNode;
			while ((textNode = walker.nextNode())) {
				targetTextNodes.add(textNode as Text);
			}
		}

		const rectTexts: RectText[] = [];

		// The break result's text index: which line each text node's fragments
		// landed on, at what x, in what order. Built once per break result and
		// keyed on the result object itself, so a re-break (always a fresh
		// object) invalidates it for free. Without it every text node's lookup
		// scanned every segment of its run -- painting a run of N boxes cost
		// O(N^2) segment visits per frame.
		const index = this.#breakResultTextIndex(breakResult);

		// Merge fragments per line that belong to this node, in segment order.
		const byLine = new Map<number, TextFragmentEntry[]>();
		for (const textNode of targetTextNodes) {
			const entries = index.get(textNode);
			if (!entries) continue;
			for (const entry of entries) {
				let bucket = byLine.get(entry.line);
				if (!bucket) byLine.set(entry.line, (bucket = []));
				bucket.push(entry);
			}
		}

		for (const [lineIndex, bucket] of [...byLine].sort((a, b) => a[0] - b[0])) {
			const line = breakResult.lines[lineIndex];
			bucket.sort((a, b) => a.ord - b.ord);

			let minX = Infinity;
			let maxX = -Infinity;
			let concatenatedText = "";
			for (const targetText of bucket) {
				minX = Math.min(minX, targetText.x);
				maxX = Math.max(maxX, targetText.x + targetText.width);
				concatenatedText += targetText.text;
			}
			const first = bucket[0];
			const last = bucket[bucket.length - 1];

			const alignOffset = lineAlignOffset(
				alignContainer,
				currentBreakResult.containerWidth,
				line.width,
			);
			const indent = lineIndent(
				line === currentBreakResult.lines[0],
				alignContainer,
				currentBreakResult.containerWidth,
			);

			const rect = new this.DOMRect(
				containerX + minX + alignOffset + indent,
				containerY + line.y,
				maxX - minX,
				line.height,
			);
			rectTexts.push({
				rect,
				text: concatenatedText,
				startOffset: first.startOffset,
				endOffset: last.endOffset,
				visualBase: first.visualBase,
			});
		}

		return rectTexts;
	}

	// Text-fragment index per break result: text node -> the fragments the
	// breaker placed for it, each with its OUTER line index, x offset (nested
	// inline-block content already shifted by its box's position and padding,
	// as the merge in the rect-text walk expects), width, processed text, the
	// data range that renders back to it, and a global ordinal preserving
	// segment order. WeakMap-keyed on the break result object: re-breaking
	// builds a fresh object, so entries can never go stale.
	#rectTextIndices = new WeakMap<object, Map<Text, TextFragmentEntry[]>>();

	#breakResultTextIndex(
		breakResult: BreakResult,
	): Map<Text, TextFragmentEntry[]> {
		let index = this.#rectTextIndices.get(breakResult);
		if (index) return index;
		index = new Map();
		let ord = 0;
		const visit = (segments: any[], baseX: number, lineIndex: number): void => {
			for (const segment of segments) {
				if (segment.leaf.type === "text") {
					const textNode = segment.leaf.node as Text;
					let entries = index!.get(textNode);
					if (!entries) index!.set(textNode, (entries = []));
					entries.push({
						line: lineIndex,
						x: baseX + segment.x,
						width: segment.width,
						text: segment.processedText,
						startOffset: segment.dataStart,
						endOffset: segment.dataEnd,
						visualBase: segment.visualBase,
						ord: ord++,
					});
				} else if (
					segment.leaf.type === "inline-block" &&
					segment.leaf.breakResult
				) {
					const paddingLeft = segment.leaf.boxModel.paddingLeft;
					for (const nestedLine of segment.leaf.breakResult.lines) {
						visit(
							nestedLine.segments,
							baseX + segment.x + paddingLeft,
							lineIndex,
						);
					}
				}
			}
		};
		for (let i = 0; i < breakResult.lines.length; i++) {
			visit(breakResult.lines[i].segments, 0, i);
		}
		this.#rectTextIndices.set(breakResult, index);
		return index;
	}

	getRects(node: Node): DOMRect[] {
		// Everything except true inline content is an atomic box with one rect.
		// That includes inline-block: it participates in a line, but it is a
		// box, not a run of text -- an <input> or <button> has no text runs at
		// all, and returning none made it invisible to elementFromPoint.
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			if (usedDisplay(element) !== "inline") {
				const rect = this.getRect(element);
				return rect ? [rect] : [];
			}
		}

		// Inline content is one rect per text run, one per line it spans.
		return this[kRectTexts](node).map((rectText) => rectText.rect);
	}

	/**
	 * The document-space rects a Range covers -- the geometry
	 * `Range.getClientRects()`/`getBoundingClientRect()` report, and the source
	 * the painter reads for the caret and for selection highlighting. A collapsed
	 * range yields one zero-width caret rect; a spanning range yields a rect per
	 * contiguous selected run per line. Boundaries resolve per text node the way
	 * the selection walk does: a node the range starts in uses its offset, one it
	 * only passes through is covered whole.
	 *
	 * Both paths walk the node's line fragments, which carry the data range each
	 * line renders: a caret lands on the line owning its offset, blank lines
	 * included, and a selected run maps each painted column back to the offset it
	 * renders -- correct over collapsing whitespace, where column and offset
	 * diverge.
	 */
	getRangeRects(range: Range): globalThis.DOMRect[] {
		if (!range.collapsed) {
			return this.getRangeRuns(range).map((run) => run.rect);
		}
		const rects: globalThis.DOMRect[] = [];
		for (const textNode of this.#rangeTextNodes(range)) {
			const caret = this.#caretRect(
				textNode,
				range.startContainer === textNode ? range.startOffset : 0,
			);
			if (caret) rects.push(caret);
		}
		return rects;
	}

	/**
	 * The selected runs a Range covers -- each contiguous painted run as a rect
	 * and its raw text -- across every text node it spans. The text lets a
	 * caller repaint the run in the selection style; `getRangeRects` is this
	 * without the text, for the public `Range` API.
	 */
	getRangeRuns(range: Range): Array<{rect: globalThis.DOMRect; text: string}> {
		if (range.collapsed) return [];
		const runs: Array<{rect: globalThis.DOMRect; text: string}> = [];
		for (const textNode of this.#rangeTextNodes(range)) {
			const from = range.startContainer === textNode ? range.startOffset : 0;
			const to =
				range.endContainer === textNode
					? range.endOffset
					: textNode.data.length;
			if (to > from) runs.push(...this.#selectionRuns(textNode, from, to));
		}
		return runs;
	}

	/** The text nodes a range covers, in document order. */
	#rangeTextNodes(range: Range): Text[] {
		if (range.collapsed) {
			const container = range.startContainer;
			return container.nodeType === container.TEXT_NODE
				? [container as Text]
				: [];
		}
		const root = range.commonAncestorContainer;
		if (root.nodeType === root.TEXT_NODE) return [root as Text];
		const nodes: Text[] = [];
		const walker = this.window.document.createTreeWalker(
			root,
			this.window.NodeFilter.SHOW_TEXT,
		);
		let node: Node | null;
		while ((node = walker.nextNode())) {
			if (range.intersectsNode(node)) nodes.push(node as Text);
		}
		return nodes;
	}

	/**
	 * Each laid-out line of a text node: where the line sits -- in raw layout
	 * coordinates, which a caller placing cells rounds -- and the range of the
	 * node's raw `data` it renders. Rendering that range through
	 * `renderTextFragment` under the node's `white-space` gives back exactly the
	 * characters the line paints, so a consumer needs no processed text of the
	 * breaker's to draw, measure or address a line.
	 *
	 * The one place a text node's laid-out lines get their data ranges: range
	 * geometry, the caret, the painter's text pass and the textarea's own
	 * visual-line navigation all read them from here. Two lines exist that no
	 * layout fragment produces -- the row after a value's final newline, and the
	 * sole row of an empty value -- because a caret rests on both.
	 */
	lineFragments(textNode: Text): LineFragment[] {
		const data = textNode.data;
		const lines: LineFragment[] = [];
		for (const rectText of this[kRectTexts](textNode)) {
			lines.push({
				rect: rectText.rect,
				startOffset: rectText.startOffset,
				endOffset: rectText.endOffset,
				visualBase: rectText.visualBase,
			});
		}
		// A value ending in a newline has an empty last line no fragment
		// represents -- the caret's row after a final Enter. It sits one line
		// below the last, at the same left edge.
		if (lines.length > 0 && data.endsWith("\n")) {
			const last = lines[lines.length - 1].rect;
			lines.push({
				rect: this.createDOMRect(last.x, last.y + last.height, 0, last.height),
				startOffset: data.length,
				endOffset: data.length,
				visualBase: null,
			});
		}
		// Empty text has no fragment at all, so its one line sits at the
		// containing block's content-box origin -- where a caret rests in an
		// empty field. Derived from the block itself, not any widget.
		if (lines.length === 0) {
			const parent = textNode.parentElement;
			const content = parent && this.contentRect(parent);
			if (content && parent) {
				lines.push({
					rect: this.createDOMRect(
						Math.round(content.x),
						Math.round(content.y),
						0,
						this.getRect(parent)!.height || 1,
					),
					startOffset: 0,
					endOffset: 0,
					visualBase: null,
				});
			}
		}
		return lines;
	}

	/** A zero-width caret rect at a data offset within a text node. */
	#caretRect(textNode: Text, offset: number): globalThis.DOMRect | null {
		const lines = this.lineFragments(textNode);
		if (lines.length === 0) return null;
		// The line owning the caret: the first whose end it does not pass, but a
		// caret exactly on a soft-wrap boundary belongs to the next line's start.
		let lineIndex = lines.length - 1;
		for (let i = 0; i < lines.length; i++) {
			if (offset <= lines[i].endOffset) {
				const next = lines[i + 1];
				if (next && next.startOffset <= offset) continue;
				lineIndex = i;
				break;
			}
		}
		const line = lines[lineIndex];
		// The cells between the line's first character and the caret: the data
		// up to the offset, rendered the way the line renders it.
		const before = renderTextFragment(
			textNode.data,
			whiteSpaceOf(textNode),
			line.startOffset,
			Math.max(line.startOffset, Math.min(offset, line.endOffset)),
		);
		const x = Math.round(line.rect.x) + runtimeStringWidth(before);
		return this.createDOMRect(x, Math.round(line.rect.y), 0, line.rect.height);
	}

	/**
	 * The caret position under a document-space point: the text node whose
	 * painted line covers the point, and the code-unit offset into its `data`
	 * the point falls at -- what caretPositionFromPoint answers in a browser.
	 *
	 * The inversion of painting: a line's data range renders back to exactly
	 * the characters it painted, so walking that rendering by cell width turns
	 * a column into an offset, correctly over collapsing white space where the
	 * two diverge. Landing past a line's last character means "after the last
	 * character", so a drag selects through end-of-line.
	 *
	 * `root` bounds the search to one subtree -- the document element under the
	 * pointer, or the text a control renders its value through. With
	 * `clampToNearestLine`, a point on no line at all resolves to the nearest
	 * line instead of nothing: a drag that leaves a field still tracks it,
	 * which is the capture model a browser uses.
	 */
	caretPositionFromPoint(
		x: number,
		y: number,
		root: Node,
		clampToNearestLine = false,
	): {node: Text; offset: number} | null {
		let best: {node: Text; offset: number; distance: number} | null = null;
		let nearest: {node: Text; fragment: LineFragment; rows: number} | null =
			null;

		for (const textNode of textNodesUnder(root)) {
			const whiteSpace = whiteSpaceOf(textNode);
			for (const fragment of this.lineFragments(textNode)) {
				const rect = fragment.rect;
				const height = Math.max(1, rect.height);
				if (y < rect.y || y >= rect.y + height) {
					if (clampToNearestLine) {
						const rows = y < rect.y ? rect.y - y : y - (rect.y + height) + 1;
						if (!nearest || rows < nearest.rows) {
							nearest = {node: textNode, fragment, rows};
						}
					}
					continue;
				}
				// An empty line is a caret slot in a control's value (a blank
				// line in a textarea is clickable); in document text it renders
				// nothing and owns no position.
				if (!clampToNearestLine && fragment.endOffset <= fragment.startOffset) {
					continue;
				}
				const found = this.#offsetInFragment(textNode, whiteSpace, fragment, x);
				if (!best || found.distance < best.distance) {
					best = {
						node: textNode,
						offset: found.offset,
						distance: found.distance,
					};
				}
			}
		}

		if (best) return {node: best.node, offset: best.offset};
		if (!nearest) return null;
		const found = this.#offsetInFragment(
			nearest.node,
			whiteSpaceOf(nearest.node),
			nearest.fragment,
			x,
		);
		return {node: nearest.node, offset: found.offset};
	}

	/**
	 * Where a column falls within one painted line: the data offset under it,
	 * and how far outside the line's own cells the column was -- zero when the
	 * point landed on the line, which is what picks between two lines painted
	 * on the same row.
	 */
	#offsetInFragment(
		textNode: Text,
		whiteSpace: string,
		fragment: LineFragment,
		x: number,
	): {offset: number; distance: number} {
		const {text, offsets} = renderWhiteSpaceOffsets(
			textNode.data.slice(fragment.startOffset, fragment.endOffset),
			whiteSpace,
		);
		let cellX = fragment.rect.x;
		let index = 0;
		while (index < text.length && cellX < x) {
			const width = runtimeStringWidth(text[index]);
			if (cellX + width > x) break;
			cellX += width;
			index++;
		}
		const distance =
			x < fragment.rect.x
				? fragment.rect.x - x
				: x >= cellX && index === text.length
					? x - cellX
					: 0;
		return {
			offset:
				index < text.length
					? fragment.startOffset + dataOffsetAt(offsets, index)
					: fragment.endOffset,
			distance,
		};
	}

	/**
	 * The selected runs within one text node's [from, to) data range: each a
	 * contiguous painted run as a rect PLUS its raw (untransformed) text. The
	 * text is what a rect alone cannot carry and what selection highlighting
	 * needs, since the only way to restyle a cell is to redraw its glyph.
	 */
	#selectionRuns(
		textNode: Text,
		from: number,
		to: number,
	): Array<{rect: globalThis.DOMRect; text: string}> {
		const runs: Array<{rect: globalThis.DOMRect; text: string}> = [];
		const whiteSpace = whiteSpaceOf(textNode);
		for (const fragment of this.lineFragments(textNode)) {
			// The line's characters, and the data offset each of them renders --
			// which is where a collapsing run makes column and offset diverge.
			const {text, offsets} = renderWhiteSpaceOffsets(
				textNode.data.slice(fragment.startOffset, fragment.endOffset),
				whiteSpace,
			);
			let runStart = -1;
			for (let i = 0; i <= text.length; i++) {
				const dataOffset =
					i < text.length
						? fragment.startOffset + dataOffsetAt(offsets, i)
						: -1;
				const selected = dataOffset >= from && dataOffset < to;
				if (selected && runStart === -1) {
					runStart = i;
				} else if (!selected && runStart !== -1) {
					const x =
						Math.round(fragment.rect.x) +
						runtimeStringWidth(text.slice(0, runStart));
					const width = runtimeStringWidth(text.slice(runStart, i));
					runs.push({
						rect: this.createDOMRect(
							x,
							Math.round(fragment.rect.y),
							width,
							fragment.rect.height,
						),
						// Painted order, since the caller redraws these cells: a
						// selected run of a bidirectional line reverses just as
						// the line it sits on did.
						text: fragment.visualBase
							? toVisualOrder(text.slice(runStart, i), fragment.visualBase)
							: text.slice(runStart, i),
					});
					runStart = -1;
				}
			}
		}
		return runs;
	}

	/**
	 * Whether an element establishes a stacking context: the paint-atomic unit
	 * of CSS layering. Terminal-relevant predicate: positioned with a non-auto
	 * z-index. The root context belongs to <body>, the paint root. (opacity/
	 * transform/filter have no terminal meaning here.)
	 */
	formsStackingContext(element: Element): boolean {
		if (element === this.window.document.body) return true;
		if (computedStyleOf(element).computedValueOf("isolation") === "isolate") {
			return true;
		}
		return isPositioned(element) && zIndexValueOf(element) !== "auto";
	}

	/**
	 * Group every connected positioned element under its nearest
	 * stacking-context ancestor, bucketed into the CSS paint layers: negative-z
	 * contexts, the z:auto/0 layer, positive-z contexts. Walks only the
	 * positioned registry -- O(positioned x depth) per frame, never
	 * O(document). `topLayer` members paint above everything and are excluded.
	 * The painter walks these forward; hit-testing walks them in reverse.
	 */
	collectStackingLayers(
		topLayer: Set<Element>,
	): Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}> {
		const layers = new Map<
			Element,
			{neg: Element[]; zero: Element[]; pos: Element[]}
		>();
		// A stray frame can fire after the window is torn down (window.document
		// goes null on close), and then there is nothing to layer.
		const body = this.window.document?.body;
		if (!body) return layers;
		for (const element of this.positionedElements) {
			if (!element.isConnected || element === body) continue;
			if (topLayer.has(element)) continue; // painted above everything
			// The registry is a superset: re-ask before believing membership.
			if (!isPositioned(element)) continue;
			let root: Element = body;
			for (
				let ancestor = flatParentElement<Element>(element);
				ancestor;
				ancestor = flatParentElement<Element>(ancestor)
			) {
				if (this.formsStackingContext(ancestor)) {
					root = ancestor;
					break;
				}
			}
			let bucket = layers.get(root);
			if (!bucket) {
				bucket = {neg: [], zero: [], pos: []};
				layers.set(root, bucket);
			}
			const z = zIndexValueOf(element);
			if (z === "auto" || z === 0) bucket.zero.push(element);
			else if (z < 0) bucket.neg.push(element);
			else bucket.pos.push(element);
		}
		const treeOrder = (a: Element, b: Element) =>
			a.compareDocumentPosition(b) & 4 ? -1 : 1; // 4: b follows a
		for (const bucket of layers.values()) {
			const byZ = (a: Element, b: Element) => {
				const za = zIndexValueOf(a) as number;
				const zb = zIndexValueOf(b) as number;
				return za !== zb ? za - zb : treeOrder(a, b);
			};
			bucket.neg.sort(byZ);
			bucket.zero.sort(treeOrder);
			bucket.pos.sort(byZ);
		}
		return layers;
	}

	/**
	 * Hit-test a document-relative point against the stacking order, topmost
	 * first -- the inverse of the paint order collectStackingLayers feeds. A
	 * positioned box is probed at its CONTEXT, not through its parents, so a box
	 * hanging outside its parent's rect is still clickable. `topLayer` paints
	 * above everything; `cameraScrollTop` converts the probe for fixed subtrees,
	 * which live in viewport space.
	 */
	hitTest(
		root: Element,
		x: number,
		y: number,
		topLayer: Set<Element>,
		cameraScrollTop: number,
	): Element | null {
		const layers = this.collectStackingLayers(topLayer);
		const document = this.window.document;
		if (!document?.body) return null;
		// Painting starts at the body, whose box covers everything in flow --
		// unless the body generates no box of its own, and the box its content
		// is laid out in is the root element's.
		const paintRoot =
			root === document.documentElement && !dissolvesIntoChildren(document.body)
				? document.body
				: root;
		for (const element of [...topLayer].reverse()) {
			if (!flatIsConnected(element)) continue;
			const hit = this.#hitTestContext(element, x, y, layers, cameraScrollTop);
			if (hit) return hit;
		}
		return this.#hitTestContext(paintRoot, x, y, layers, cameraScrollTop);
	}

	#hitTestContext(
		root: Element,
		x: number,
		y: number,
		layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
		cameraScrollTop: number,
	): Element | null {
		const bucket = layers.get(root) ?? null;
		const probeMember = (element: Element): Element | null => {
			// A fixed box's layout lives in viewport space; convert the
			// document-space probe point for its whole subtree. Fixed-space is
			// a property of the containing-block CHAIN, so the check walks
			// ancestors -- an absolute box inside a fixed bar lives there too.
			const probeY = this.isInFixedSpace(element) ? y - cameraScrollTop : y;
			return this.formsStackingContext(element)
				? this.#hitTestContext(element, x, probeY, layers, cameraScrollTop)
				: this.#hitTestInFlow(element, x, probeY);
		};
		if (bucket) {
			for (let i = bucket.pos.length - 1; i >= 0; i--) {
				const hit = probeMember(bucket.pos[i]);
				if (hit) return hit;
			}
			for (let i = bucket.zero.length - 1; i >= 0; i--) {
				const hit = probeMember(bucket.zero[i]);
				if (hit) return hit;
			}
		}
		const inFlow = this.#hitTestInFlow(root, x, y);
		if (inFlow) return inFlow;
		if (bucket) {
			for (let i = bucket.neg.length - 1; i >= 0; i--) {
				const hit = probeMember(bucket.neg[i]);
				if (hit) return hit;
			}
		}
		return null;
	}

	/**
	 * In-flow descent: the element must contain the point; children are probed
	 * in REVERSE tree order (last-painted wins), positioned children skipped --
	 * their context probes them.
	 */
	#hitTestInFlow(element: Element, x: number, y: number): Element | null {
		if (element.nodeType !== 1) return null;
		if (computedStyleOf(element).computedValueOf("display") === "none") {
			return null;
		}
		// A display:contents element generates no box, so there is nothing to
		// contain the point and nothing to hit: its children stand in its place
		// and are probed as if they were the parent's own. An inline broken
		// around a block-level box covers only its own fragments, and the block
		// between them is nowhere near them -- so it cannot gate the descent
		// either, though it is still hit on the fragments themselves.
		const boxless = dissolvesIntoChildren(element);
		let contained = false;
		if (!boxless) {
			try {
				contained = isPointInRects(x, y, this.getRects(element));
			} catch {
				return null;
			}
			if (!contained && !this.#splitsAroundBlock(element)) return null;
		}
		const children: Element[] = [];
		const walker = flowWalker(element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (child.nodeType !== 1) continue;
			if (isPositioned(child as Element)) continue;
			children.push(child as Element);
		}
		for (let i = children.length - 1; i >= 0; i--) {
			const hit = this.#hitTestInFlow(children[i], x, y);
			if (hit) return hit;
		}
		return contained ? element : null;
	}

	/**
	 * Where an element's own caret sits, as a rect -- the cell the terminal
	 * cursor parks on, and the row the camera reveals on an edit. The element
	 * answers WHERE its caret is, as a collapsed Range into the tree it
	 * renders; this is that Range measured, so nothing outside asks the caret
	 * question in two currencies. Null for an element with no caret, and for a
	 * caret whose offset the layout placed nothing at.
	 */
	caretRectOf(element: Element): globalThis.DOMRect | null {
		const range = caretRangeOf(element);
		if (!range) return null;
		return this.getRangeRects(range as unknown as Range)[0] ?? null;
	}

	createDOMRectList(rects?: globalThis.DOMRect[]): globalThis.DOMRectList {
		const list = new DOMRectList();
		if (rects) {
			list.push(...rects);
		}
		return list;
	}

	createDOMRect(
		x: number = 0,
		y: number = 0,
		width: number = 0,
		height: number = 0,
	): globalThis.DOMRect {
		return new this.DOMRect(x, y, width, height);
	}

	/**
	 * The smallest rect enclosing a set of fragments -- the bounding box a
	 * broken inline reports for itself, and the one a Range reports over the
	 * runs it covers. An empty set encloses nothing and gives a zero rect at
	 * the origin, which is what both public APIs return for no geometry.
	 */
	unionRect(rects: readonly globalThis.DOMRect[]): globalThis.DOMRect {
		if (rects.length === 0) return this.createDOMRect();
		let left = Infinity;
		let top = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		for (const rect of rects) {
			left = Math.min(left, rect.x);
			top = Math.min(top, rect.y);
			right = Math.max(right, rect.x + rect.width);
			bottom = Math.max(bottom, rect.y + rect.height);
		}
		return this.createDOMRect(left, top, right - left, bottom - top);
	}

	/**
	 * Derive a block container's child boxes from the DOM, and link them into
	 * the box tree under it. The one builder: nothing else creates a box, and
	 * every reader of the tree reads what a derivation put there.
	 *
	 * A block container with inline content lays that content out in anonymous
	 * boxes -- one per contiguous run of inline-level flow children (CSS2
	 * §9.2.1.1). The flex engine only takes a measure function on a leaf, so
	 * each anonymous box is a leaf whose measure breaks the run into lines,
	 * starting from the flow child that opens it.
	 *
	 * Examples:
	 * - "Hello" + <span>world</span>: one box, opened by the "Hello" text node
	 * - <em>text</em> + "more": one box, opened by the <em>
	 * - <div>text</div>: the div's only box, opened by "text"
	 * - In flex containers: every element child is a box of its own
	 * - <span>text</span><div>block</div><span>more</span>: three boxes, the
	 *   block-level one between two anonymous ones
	 *
	 * Pseudo-elements (::before, ::marker, ::after) take run positions exactly
	 * as the text they generate would.
	 *
	 * The derivation is what every membership question reads: `heads` maps each
	 * flow child (and, through the walk in #boxEntryOf, everything nested inside
	 * one) to the box it falls under, so membership is a parent-side lookup
	 * rather than a walk backward through siblings -- a run of N boxes costs one
	 * derivation, not N of them. `children` is the same derivation read as the
	 * container's ordered child list, which is what places a box among its
	 * siblings.
	 *
	 * Elements that generate no box in the flow (display:none, out of flow) take
	 * no run position: they neither open nor close a run, and map to whichever
	 * box is open around them so that content nested inside them still resolves.
	 *
	 * A derivation describes children that may since have moved, so it is redone
	 * when they might have: the containers named in {@link #staleContainers}
	 * rebuild on their next read, and an unbounded change -- a stylesheet
	 * reparse, a pseudo-element appearing, a shadow root attaching -- names every
	 * one of them by moving the structural generation the box carries. The
	 * boxes themselves outlive it: a rebuild reconciles against the children it
	 * replaces.
	 */
	#containerBox(container: Element): Box {
		const box = this.#principalBox(container);
		const structure = this.#structuralGeneration;
		if (
			box.children &&
			box.structure === structure &&
			!this.#staleContainers.has(container)
		) {
			return box;
		}
		this.#staleContainers.delete(container);

		const heads = new Map<Node, Box>();
		const children: Box[] = [];
		// Anonymous boxes are matched to the previous derivation's by their
		// ordinal among the container's runs, which is the identity a run has.
		// Only a change to the NUMBER of runs -- a block-level box splitting one
		// in two, or leaving and merging two into one -- creates or retires a
		// box.
		const previous = (box.children ?? []).filter(
			(child) => child.kind === "anonymous",
		);
		let runCount = 0;
		// The membership each reused box had before this rebuild.
		const opened = new Map<Box, Node[]>();
		// A flex container puts every element child in a box of its own and
		// gathers only its contiguous text into anonymous ones.
		const inFlex = getPropertyValue(container, "display") === "flex";
		let run: Box | null = null;
		// The enumeration below decides it again; a container that no longer
		// reaches through a broken inline stops holding its fragments.
		box.holdsFragments = false;
		for (const child of this.#flowChildren(container)) {
			if (child.nodeType === child.ELEMENT_NODE) {
				const element = child as Element;
				const display = getPropertyValue(element, "display");
				const inlineLevel = isInlineDisplay(display);
				if (display === "none" || isOutOfFlow(element)) {
					const own = this.#principalBox(child, box);
					heads.set(child, run ?? own);
					// A hidden block still holds a box slot; an out-of-flow one
					// hangs from its containing block, and an inline that left the
					// flow was never a box of this container's to begin with.
					if (!inlineLevel) children.push(own);
					continue;
				}
				if (!inlineLevel) {
					run = null; // block-level box: the run ends here
					children.push(this.#principalBox(child, box));
					continue;
				}
				if (inFlex) {
					// Blockified (css-display-3 §2.7): the element's box is its
					// own, not an anonymous one gathered around it.
					const own = this.#principalBox(child, box);
					heads.set(child, own);
					children.push(own);
					run = null;
					continue;
				}
			} else if (child.nodeType !== child.TEXT_NODE) {
				continue;
			} else if (this.#isSuppressedFlexWhitespace(child as Text)) {
				// Collapsible white space between flex items renders nothing at
				// all (css-flexbox-1 §4), so it opens no anonymous item.
				continue;
			}
			if (run === null) {
				run = previous[runCount] ?? new Box("anonymous", null, box);
				opened.set(run, run.members);
				run.members = [];
				runCount++;
				children.push(run);
			}
			run.members.push(child);
			heads.set(child, run);
		}

		// A box whose membership moved measures differently at the same width,
		// and nothing about the space it is offered says so -- an anonymous box
		// whose members left would go on reserving their width forever.
		for (const [reused, before] of opened) {
			const now = reused.members;
			if (
				before.length !== now.length ||
				before.some((node, index) => node !== now[index])
			) {
				reused.flexNode?.markDirty();
			}
		}

		// Runs the container no longer has: their content merged into a
		// neighbour's box or left the tree entirely.
		for (let i = runCount; i < previous.length; i++) {
			this.#retireAnonymousBox(previous[i]);
		}

		// A dissolved element is FLATTENED by the walk above: the boxes it
		// yields are its children's, and nothing there ever names the element
		// itself. So a box it held under an earlier display would outlive the
		// change -- a `display: contents` flip whose invalidation scope was an
		// ancestor left the old box standing, holding rows nothing removed.
		this.#retireDissolved(container);

		box.children = children;
		box.heads = heads;
		box.structure = structure;
		return box;
	}

	/**
	 * The box tree's nodes, by the DOM node each is the principal box of: the
	 * identity a derivation reconciles against, so that a container rebuilt
	 * around a node finds the box that node already had, holding the layout
	 * node and the fragments it was laid out with.
	 */
	#boxes = new WeakMap<Node, Box>();

	/** A DOM node's principal box, created on first mention. */
	#principalBox(node: Node, parent: Box | null = null): Box {
		let box = this.#boxes.get(node);
		if (!box) {
			box = new Box("node", node);
			this.#boxes.set(node, box);
		}
		if (parent) box.parent = parent;
		return box;
	}

	/**
	 * The layout node a container's own boxes hang from: an atomic inline's
	 * content root, and otherwise the node its box is laid out by.
	 */
	#containerFlexNode(container: Element): FlexTypes.Node | undefined {
		return (
			this.#boxes.get(container)?.contentRoot ?? this.nodeMap.get(container)
		);
	}

	/**
	 * The containers whose enumeration no longer describes their children. A
	 * mutation names them as it arrives -- the container a node's box sits in,
	 * and the one an element's own children's boxes sit in -- so that flipping
	 * a class on one row of a long list re-enumerates that row, and not the
	 * nine hundred and ninety-five boxes around it.
	 *
	 * Weak, because a container named here may be the last thing a removed
	 * subtree is held by, and a container never read again is never cleared.
	 */
	#staleContainers = new WeakSet<Element>();

	#layoutPass = 0;

	#invalidationEpoch = 0;
	#structuralGeneration = 0;

	/**
	 * Note that something a frame is derived from has moved. Every cache the
	 * engine keys on {@link invalidationEpoch} -- the box enumerations, the
	 * resolved geometry, the frame-skip check -- is stale from here on.
	 *
	 * Mutation records come through the shell's observer drain, which bumps
	 * this once per batch; the cascade bumps it for the style changes no
	 * record describes.
	 */
	invalidateFrame(): void {
		this.#invalidationEpoch++;
	}

	/**
	 * Note an UNBOUNDED change: a stylesheet reparse, a shadow attachment, a
	 * pseudo-element change, the bidi reorder flip -- damage no per-element
	 * tracking can bound, so a banded repaint has to cover the whole screen.
	 * Bounded damage (mutation records, per-element style invalidation) is
	 * tracked per element and does not come through here.
	 */
	invalidateStructure(): void {
		this.#structuralGeneration++;
		this.#invalidationEpoch++;
	}

	/** The generation of the last unbounded change. */
	get structuralGeneration(): number {
		return this.#structuralGeneration;
	}

	/** The current invalidation epoch: bumped by everything a frame reads. */
	get invalidationEpoch(): number {
		return this.#invalidationEpoch;
	}

	/**
	 * A counter that moves whenever geometry could have: every layout pass
	 * bumps it, and so does every cascade invalidation -- a style written and
	 * then measured has moved geometry the engine has not
	 * been told about yet, and a counter that stood still there would hand the
	 * reader the layout standing behind the write. A resolved value memoizes
	 * against it, the way a rect read does.
	 */
	get layoutEpoch(): number {
		return this.#invalidationEpoch + this.#layoutPass;
	}

	/**
	 * Every live anonymous box, by the layout node it owns: the reverse of
	 * Box.flexNode, and the registry the sweeps that must reach every box
	 * (resize, pruning, disposal) walk. Strong, because a container's children
	 * are re-derived whenever the tree moves under it and the boxes it held
	 * must still be retired.
	 */
	#anonymousBoxes = new Map<FlexTypes.Node, Box>();

	/**
	 * Containers whose box list may no longer match their layout children.
	 * Reconciled once per pass, in calculateLayout, however many mutations
	 * dirtied them.
	 */
	#dirtyRunContainers = new Set<Element>();

	/**
	 * Free a node's layout node and forget it. The children are severed
	 * first: they belong to other DOM nodes, which keep pointing at them, and
	 * an element measured by a box that reuses a freed node lays out nothing
	 * at all.
	 */
	#retireFlexNode(node: Node): void {
		const flexNode = this.nodeMap.get(node);
		if (!flexNode) return;
		flexNode.getParent()?.removeChild(flexNode);
		while (flexNode.children.length > 0) {
			flexNode.removeChild(flexNode.children[0]);
		}
		this.#measureNodes.delete(flexNode);
		flexNode.freeRecursive();
		this.#untrackNode(node);
	}

	/**
	 * Whether a layout node is the KIND of box its element now generates. A
	 * node with a measure function lays its content out as one run, and one
	 * without lays out boxes of its own -- a blockified inline holding a block
	 * would end at the first block inside it. A node built display:none is
	 * built with no content in it at all. Neither is a re-measurement away.
	 */
	#boxKindMatches(element: Element, flexNode: FlexTypes.Node): boolean {
		if (this.#measuresAsRun(element) !== this.#measureNodes.has(flexNode)) {
			return false;
		}
		return (
			(getPropertyValue(element, "display") === "none") ===
			(flexNode.getDisplay() === Flex.DISPLAY_NONE)
		);
	}

	/** Free an anonymous box's layout node and forget the box. */
	#retireAnonymousBox(box: Box): void {
		const flexNode = box.flexNode;
		box.flexNode = null;
		box.fragments = null;
		if (!flexNode) return;
		flexNode.getParent()?.removeChild(flexNode);
		this.#measureNodes.delete(flexNode);
		this.#anonymousBoxes.delete(flexNode);
		this.#domNodeByFlexNode.delete(flexNode);
		flexNode.freeRecursive();
	}

	/** The anonymous box a node's content is laid out in, if it is in one. */
	#boxOf(node: Node): Box | null {
		const entry = this.#boxEntryOf(node);
		return entry?.kind === "anonymous" ? entry : null;
	}

	/** The box a node's content falls under, among its container's children. */
	#boxEntryOf(node: Node): Box | null {
		if (!flatIsConnected(node)) return null;

		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			// An out-of-flow element is never a run head or run member -- it
			// left the flow entirely. Letting run invalidation "ensure" it a
			// bare layout node makes later rebuilds skip its full build, so its
			// pseudo-only content vanishes on a runtime class flip.
			if (isOutOfFlow(element)) return null;
			if (!isInlineDisplay(getPropertyValue(element, "display"))) return null;
		} else if (node.nodeType !== node.TEXT_NODE) {
			return null;
		}

		const container = this.#runContainerOf(node);
		if (!container) return this.#principalBox(node);
		const heads = this.#containerBox(container).heads!;
		// Up from the node to whichever of its ancestors the container counts
		// among its own flow children: that is the box the content falls under.
		for (let current: Node = node; current !== container; ) {
			const entry = heads.get(current);
			if (entry) return entry;
			const parent = this.#boxParentOf(current);
			if (!parent) return this.#principalBox(current);
			current = parent;
		}
		return this.#principalBox(node);
	}

	/**
	 * The layout node that measures the run a node heads: an anonymous box's,
	 * or the node's own when its box belongs to it (a flex container's
	 * blockified inline children).
	 */
	#runFlexNode(node: Node): FlexTypes.Node | undefined {
		const box = this.#boxOf(node);
		if (box) return box.head === node ? (box.flexNode ?? undefined) : undefined;
		return this.nodeMap.get(node);
	}

	/** The lines the run a node heads was broken into, if it has been measured. */
	#runBreakResult(node: Node): BreakResult | undefined {
		const box = this.#boxOf(node);
		if (box) {
			return box.head === node ? (box.fragments ?? undefined) : undefined;
		}
		return this.#boxes.get(node)?.fragments ?? undefined;
	}

	/**
	 * Apply an element's style to the layout node that carries its box, and
	 * keep the one thing that style alone cannot answer wired up: an
	 * out-of-flow box is placed by its containing block, which asks the flow
	 * the box left where it would have been. Nothing in flow is ever asked, so
	 * nothing in flow carries the question.
	 */
	#styleNode(element: Element, flexNode: FlexTypes.Node): void {
		const wasHidden = flexNode.getDisplay() === Flex.DISPLAY_NONE;
		styleFlexNode(element, flexNode, this.positionedElements);
		// Turning display:none is what makes the whole subtree box-less, and
		// this is the one place every path that restyles a box passes through.
		if (!wasHidden && flexNode.getDisplay() === Flex.DISPLAY_NONE) {
			this.#retireHiddenContent(element);
		}
		if (isOutOfFlow(element)) {
			flexNode.setStaticPositionFunc((containingBlock) =>
				this.#staticPosition(element, containingBlock),
			);
		} else if (flexNode.staticPositionFunc) {
			flexNode.setStaticPositionFunc(null);
		}
	}

	/**
	 * Where an out-of-flow box would have been had it stayed in flow: the
	 * origin of CSS 2 §10.3.7's hypothetical box, in the containing block's
	 * border-box coordinates. The containing block places the box there on any
	 * axis whose two insets are both `auto`.
	 *
	 * The flow the box left is what knows the answer, so it is read off the
	 * container that enumerates the box among its flow children: after the
	 * previous box of a block container, or at the inline position in the line
	 * the box would have joined. A flex container has no such point -- an
	 * out-of-flow child of one aligns against the container's own content box
	 * (css-flexbox-1 §4.1) -- and reports none, leaving that placement to the
	 * containing block's alignment.
	 *
	 * Called during the containing block's layout, when every in-flow box
	 * between the two is already placed. The containing block's own offset is
	 * not yet final, but it stands in both sums and cancels in the difference.
	 */
	#staticPosition(
		element: Element,
		containingBlock: FlexTypes.Node,
	): {left: number; top: number} | null {
		const container = this.#runContainerOf(element);
		if (!container) return null;
		if (
			NO_STATIC_POSITION_DISPLAYS.has(getPropertyValue(container, "display"))
		) {
			return null;
		}
		const containerNode = this.#containerFlexNode(container);
		if (!containerNode) return null;

		const origin = this.#absolutePosition(containerNode);
		const containingOrigin = this.#absolutePosition(containingBlock);
		const offsetLeft = origin.x - containingOrigin.x;
		const offsetTop = origin.y - containingOrigin.y;
		// The flow starts inside the container's border and padding.
		const contentLeft =
			containerNode.layout.border[Flex.EDGE_LEFT] +
			containerNode.layout.padding[Flex.EDGE_LEFT];
		const contentTop =
			containerNode.layout.border[Flex.EDGE_TOP] +
			containerNode.layout.padding[Flex.EDGE_TOP];

		const containerBox = this.#containerBox(container);
		const children = containerBox.children!;
		let entry: Box | null = null;
		for (let current: Node = element; current !== container; ) {
			const found = containerBox.heads!.get(current);
			if (found) {
				entry = found;
				break;
			}
			const parent = this.#boxParentOf(current);
			if (!parent) break;
			current = parent;
		}

		// In an inline formatting context the box takes the position the line
		// had reached: after everything already on it, on the line that would
		// have carried it.
		if (entry?.kind === "anonymous") {
			const runNode = entry.flexNode;
			if (runNode) {
				const runOrigin = this.#absolutePosition(runNode);
				const cursor = this.#inlineCursorBefore(entry, element);
				return {
					left: runOrigin.x - containingOrigin.x + cursor.x,
					top: runOrigin.y - containingOrigin.y + cursor.y,
				};
			}
		}

		// A block container: after the last box that took a position before it.
		const index = children.indexOf(entry ?? this.#principalBox(element));
		for (let i = index - 1; i >= 0; i--) {
			const previous = children[i];
			const previousNode =
				previous.kind === "anonymous"
					? previous.flexNode
					: (this.nodeMap.get(previous.node!) ?? null);
			if (!previousNode || previousNode.getParent() !== containerNode) continue;
			return {
				left: offsetLeft + contentLeft,
				top:
					offsetTop +
					previousNode.getComputedTop() +
					previousNode.getComputedHeight() +
					previousNode.layout.margin[Flex.EDGE_BOTTOM],
			};
		}
		return {left: offsetLeft + contentLeft, top: offsetTop + contentTop};
	}

	/**
	 * How far a run's line had advanced when it reached a node that generates
	 * no box in it: the trailing edge of the last content placed before that
	 * node, and the top of the line it landed on, relative to the run's box.
	 */
	#inlineCursorBefore(run: Box, element: Element): {x: number; y: number} {
		const breakResult = run.fragments;
		if (!breakResult) return ZERO_OFFSET;
		let cursor = ZERO_OFFSET;
		for (const line of breakResult.lines) {
			for (const segment of line.segments) {
				const position = element.compareDocumentPosition(segment.leaf.node);
				if (!(position & element.DOCUMENT_POSITION_PRECEDING)) return cursor;
				cursor = {x: segment.x + segment.width, y: line.y};
			}
		}
		return cursor;
	}

	/**
	 * Bring a container's layout children into line with its box list: every
	 * anonymous box owns a measuring layout node at its own position among the
	 * container's boxes, and the block-level boxes an inline handed over (a
	 * block inside an inline breaks it apart, CSS2 §9.2.1.1) are built as the
	 * container's own.
	 *
	 * Positions are counted, not searched: a box sits after every earlier box
	 * of the container that reached the layout tree, which is what the flex
	 * engine's child order has to say.
	 */
	#syncContainerRuns(container: Element): void {
		this.#dirtyRunContainers.delete(container);
		const containerFlexNode = this.#containerFlexNode(container);
		// No layout node, a node that measures its content as one opaque unit,
		// or a subtree display:none removed from layout: nothing here lays out
		// boxes of its own.
		if (!containerFlexNode || containerFlexNode.measureFunc) return;
		if (
			getPropertyValue(container, "display") === "none" ||
			this.#hiddenByAncestor(container)
		) {
			// Content that arrives under the boundary generates no box, and
			// whatever boxes it brought from where it was visible are retired
			// here: this is the only pass that ever visits a hidden container.
			this.#retireHiddenContent(container);
			return;
		}
		// An inline broken around a block-level box lays out none of its own
		// content: the fragments and the block between them are boxes of the
		// CONTAINER (CSS2 §9.2.1.1), reconciled there. Taking them here steals
		// them from the container that places them.
		if (this.#splitsAroundBlock(container)) return;

		const children = this.#containerBox(container).children!;
		let index = 0;
		for (const entry of children) {
			if (entry.kind === "anonymous") {
				let flexNode = entry.flexNode;
				const styledFrom =
					entry.head.nodeType === entry.head.ELEMENT_NODE
						? (entry.head as Element)
						: null;
				// The head decides the box's own flex styles (an anonymous box has
				// none), so a run that changes hands starts from a fresh node
				// rather than wearing the last head's margins and flex factors.
				if (flexNode && entry.styledFrom !== styledFrom) {
					this.#retireAnonymousBox(entry);
					flexNode = null;
				}
				if (!flexNode) {
					flexNode = Flex.Node.createWithConfig(flexConfig);
					entry.flexNode = flexNode;
					entry.styledFrom = styledFrom;
					if (styledFrom) {
						styleFlexNode(styledFrom, flexNode, this.positionedElements);
					}
					flexNode.setMeasureFunc(
						(width, widthMode, height, heightMode, placing) =>
							this.#measureInlineRun(
								entry,
								width,
								widthMode,
								height,
								heightMode,
								placing,
							),
					);
					this.#measureNodes.add(flexNode);
					this.#anonymousBoxes.set(flexNode, entry);
					this.#domNodeByFlexNode.set(flexNode, entry.head);
				} else if (this.#domNodeByFlexNode.get(flexNode) !== entry.head) {
					// Paint reaches a box through the node that opens it.
					this.#domNodeByFlexNode.set(flexNode, entry.head);
				}
				if (containerFlexNode.getChildIndex(flexNode) !== index) {
					flexNode.getParent()?.removeChild(flexNode);
					containerFlexNode.insertChild(flexNode, index);
				}
				index++;
				continue;
			}
			// A box the container lays out but nothing has built: a block-level
			// box inside an inline (the container's own child walk never
			// descends into the inline that holds it, so neither a fresh build
			// nor a rebuild that severed its children ever names it), or a
			// child whose display just turned it from run content into a box.
			// Out-of-flow boxes hang from their containing block instead.
			const node = entry.node!;
			if (!isOutOfFlow(node)) {
				const existing = this.nodeMap.get(node);
				// A box built for one kind cannot be re-measured into another:
				// the element's display has moved it across the line between a
				// node that measures its content as one run and a node that
				// lays out boxes of its own, and only a rebuild follows.
				if (
					existing &&
					node.nodeType === node.ELEMENT_NODE &&
					!this.#boxKindMatches(node as Element, existing)
				) {
					this.#retireFlexNode(node);
				}
				if (
					!this.nodeMap.has(node) ||
					this.nodeMap.get(node)!.getParent() !== containerFlexNode
				) {
					this.#addNode(node, containerFlexNode);
				}
			}
			const flexNode = this.nodeMap.get(node);
			if (flexNode && flexNode.getParent() === containerFlexNode) {
				// The box list is the order. A box placed among its DOM
				// siblings knows nothing of the anonymous boxes between them --
				// text between two blocks opens one, and the block after it was
				// landing in its place -- so the position is settled here,
				// where the whole list is in hand.
				if (containerFlexNode.getChildIndex(flexNode) !== index) {
					containerFlexNode.removeChild(flexNode);
					containerFlexNode.insertChild(flexNode, index);
				}
				index++;
			}
		}

		// Layout children the box list does not name, which the settling above
		// has left past its end: a node that moved into a subtree laying
		// nothing out (under a display:none ancestor) is never re-placed
		// anywhere, and a container that kept it would go on laying it out. An
		// out-of-flow box is not among the container's boxes at all -- it hangs
		// here from its CONTAINING BLOCK -- so it stays where it is.
		for (let i = containerFlexNode.children.length - 1; i >= index; i--) {
			const child = containerFlexNode.children[i];
			const node = this.#domNodeByFlexNode.get(child);
			if (node && isOutOfFlow(node)) continue;
			containerFlexNode.removeChild(child);
		}
	}

	/** The flat-tree parent that can hold a box, pseudo-elements included. */
	#boxParentOf(node: Node): Element | null {
		return boxParentElement(node);
	}

	/**
	 * The block container whose anonymous boxes a node's content falls under.
	 * Inline boxes are transparent -- their content belongs to the run around
	 * them -- and so is an inline-block whose content is all inline, since the
	 * run measures such a box as one unit and its interior coordinates live in
	 * that run's break result. An inline-block that holds block-level content is
	 * a block container in its own right, and so is an out-of-flow box.
	 */
	#runContainerOf(node: Node): Element | null {
		const parent = this.#boxParentOf(node);
		if (!parent) return null;
		const startsOwnRun =
			node.nodeType === node.ELEMENT_NODE &&
			getPropertyValue(node as Element, "display") !== "inline";
		return this.#runContainerFrom(parent, startsOwnRun);
	}

	/**
	 * The block container the boxes directly inside an element fall under:
	 * that element when it establishes one, and otherwise the container its
	 * own box joins. This is the answer {@link #runContainerOf} gives for a
	 * node whose box parent is known without the node itself -- which is how a
	 * node that has LEFT the tree is answered for, since a removed node has no
	 * parent left to climb from.
	 */
	#runContainerFrom(box: Element, startsOwnRun: boolean): Element | null {
		for (
			let current: Element | null = box;
			current;
			current = this.#boxParentOf(current)
		) {
			if (isOutOfFlow(current)) return current;
			const display = getPropertyValue(current, "display");
			// An inline box is transparent: its content belongs to the run
			// around it.
			if (display === "inline") continue;
			if (display === "inline-block") {
				// A box laying out children of its own establishes a block
				// container; and an inline-block nested in one starts a run
				// there rather than joining the run its host sits in.
				if (this.#boxes.get(current)?.contentRoot || startsOwnRun) {
					return current;
				}
				continue;
			}
			return current;
		}
		return null;
	}

	/** The node an inline-level node's box is measured from. */
	findInlineRunHead(node: Node): Node | null {
		return this.#boxEntryOf(node)?.head ?? null;
	}

	isInlineRunHead(node: Node): boolean {
		return this.findInlineRunHead(node) === node;
	}

	/**
	 * Invalidate a node, handling both block and inline elements appropriately
	 * For inline elements, invalidates the entire inline run
	 * For block elements, invalidates their layout by removing from nodeMap
	 */
	invalidate(node: Node): void {
		// Run membership may have moved: the invalidated node could be, or
		// displace, a run head, and a restyle inside the subtree can change any
		// descendant's display and with it the boxes its container holds. So
		// the whole subtree re-enumerates -- which is what the invalidation
		// itself is about to rebuild anyway.
		this.#restageSubtree(node);
		this.#invalidateNode(node);
	}

	/**
	 * Note that a container's box list is out of date, and that the layout
	 * children it holds must be brought back into line with it.
	 *
	 * Both sets, because the two say different things. Stale says the
	 * ENUMERATION is wrong -- which boxes the container has, and which node
	 * each covers -- and only a change to what the container's children are, or
	 * to a display that decides whether one takes a box, makes it so. Dirty
	 * says only that the layout children must be reconciled against the
	 * enumeration, which the far commoner change -- a box that moved, split or
	 * remeasured within a list that still describes it -- needs on its own.
	 * That is why the seven sites that dirty a container do not stale it: they
	 * would throw away a correct enumeration and rebuild it, per mutation.
	 */
	#restageContainer(container: Element): void {
		this.#staleContainers.add(container);
		this.#dirtyRunContainers.add(container);
	}

	/**
	 * Note that a node's box may no longer sit where its container's
	 * enumeration says.
	 */
	#restageBox(node: Node): void {
		const container = this.#runContainerOf(node);
		if (container) this.#restageContainer(container);
	}

	/**
	 * Note that the boxes an element's children generate may no longer be the
	 * ones its container's enumeration holds -- for an inline that is the
	 * block container around it, since an inline's children belong to the run
	 * the inline sits on.
	 */
	#restageChildren(parent: Element): void {
		let box: Element | null = parent;
		while (box && dissolvesIntoChildren(box)) box = boxParentElement(box);
		if (!box) return;
		this.#restageContainer(box);
		const container = this.#runContainerFrom(box, false);
		if (container) this.#restageContainer(container);
	}

	/** Note that every container in and around a subtree must re-enumerate. */
	#restageSubtree(node: Node): void {
		this.#restageBox(node);
		if (node.nodeType !== node.ELEMENT_NODE) return;
		this.#restageChildren(node as Element);
		// A subtree layout has never seen holds no enumeration to unsettle, and
		// the walk to discover that would cost more than the boxes it saves.
		// Anything that HAS been laid out is reachable from its own record: a
		// tree assembled off-document announces each piece as it is joined.
		if (!this.nodeMap.has(node) && !this.#boxes.get(node)?.children) {
			return;
		}
		// The flat tree, not the flow: which elements dissolve into their
		// children is a question for the cascade, and marking one that turns
		// out to generate no box costs nothing.
		const walker = createFlatTreeWalker<Node>(node);
		for (let child = walker.nextNode(); child; child = walker.nextNode()) {
			if (child.nodeType === child.ELEMENT_NODE) {
				this.#restageContainer(child as Element);
			}
		}
	}

	#invalidateNode(node: Node): void {
		// Track this node for re-adding during calculateLayout
		this.#invalidatedNodes.add(node);

		// If it's an inline-level node, invalidate the entire run
		if (isInlineLevel(node)) {
			this[kInvalidateInlineRun](node);
		} else if (node.nodeType === node.ELEMENT_NODE) {
			// For block-level elements, remove from nodeMap to force recreation
			// We can't call markDirty() on container nodes as the engine only allows
			// leaf nodes with measure functions to be marked dirty
			const flexNode = this.nodeMap.get(node);
			if (flexNode) {
				// Get parent before removing from map
				const parent = flexNode.getParent();
				if (parent) {
					parent.removeChild(flexNode);
				}

				// Check if node was actually removed vs just being invalidated (e.g., for pseudo-elements)
				if (!node.isConnected) {
					// Node was truly removed from DOM - free it
					this.#measureNodes.delete(flexNode);
					flexNode.freeRecursive();
					this.#untrackNode(node);
				} else {
					// Node is still connected - just remove from parent but keep the layout
					// node for reuse. It will be reattached during layout calculation.
					//
					// Re-apply its styles, though: whatever invalidated the element may
					// have changed them. A list's padding-left is derived from its items'
					// markers, so appending a wider item changes the parent's computed
					// padding, and reusing the node as-is would keep the stale gutter.
					this.#styleNode(node as Element, flexNode);

					// Sever its current flex CHILDREN too: this element's composed
					// child set may have changed wholesale (attachShadow on a host
					// that was already rendering its light children), and reusing
					// the node with stale children keeps painting content that is
					// no longer composed. Children that remain in the composed tree
					// are re-invalidated by the recursion below and reattach
					// through calculateLayout's re-add sweep; the rest stay
					// tracked-but-detached, exactly like a moved node.
					while (flexNode.children.length > 0) {
						const childFlexNode = flexNode.children[0];
						flexNode.removeChild(childFlexNode);
						const childDomNode = this.#domNodeByFlexNode.get(childFlexNode);
						if (childDomNode) {
							this.#clearBreakResultCache(childDomNode);
						}
					}
				}
			}

			// Recursively invalidate all children (including inline runs within this block element)
			this.#invalidateNodeChildren(node as Element);
		}
	}

	/**
	 * Recursively invalidate all children of an element
	 */
	#invalidateNodeChildren(element: Element): void {
		const walker = flowWalker(element);
		let child = walker.firstChild();

		while (child) {
			this.#invalidateNode(child);
			child = walker.nextSibling();
		}
	}

	#clearBreakResultCache(node: Node): void {
		const entry = this.#boxEntryOf(node);
		if (entry?.kind === "anonymous") {
			this.#invalidateBox(entry);
		} else if (entry) {
			// Dirtying the measure is what drops the lines: they are the product of
			// a size the layout cache holds, and a clean node keeps both.
			this.#markRunMeasureDirty(entry.node!);
		}
	}

	/**
	 * Drop an anonymous box's lines and dirty the measure that refills them --
	 * including, when the box sits under an atomic inline's content root, the
	 * box whose measure is the only thing that ever lays that content out.
	 */
	#invalidateBox(box: Box): void {
		box.flexNode?.markDirty();
		const host = this.#enclosingContentRoot(box.container);
		if (host) this.#invalidateEnclosingMeasure(host);
	}

	/**
	 * The atomic inline under whose content root an element's boxes are laid
	 * out, the element itself included -- since a box directly inside a content
	 * root is laid out by the box that owns it.
	 *
	 * A DOM question, not a flex-tree one: the tree above a box is severed and
	 * rebuilt constantly, and a box whose layout node is momentarily detached
	 * would answer that it is in no tree at all -- leaving the only measure
	 * that ever runs it un-dirtied.
	 */
	#enclosingContentRoot(from: Element | null): Element | null {
		for (let current = from; current; current = boxParentElement(current)) {
			if (this.#boxes.get(current)?.contentRoot) return current;
		}
		return null;
	}

	/**
	 * Drop the lines of every box a container lays out, not just the one that
	 * changed: `text<div/><input>` puts the leading text and the input in
	 * SEPARATE boxes, and what reshapes one commonly reshapes the other. A
	 * cleared result whose flex node is still clean is never recomputed, so
	 * such a box measures, lays out at the right rect, and paints nothing.
	 */
	#invalidateContainerBoxes(container: Element): void {
		for (const entry of this.#containerBox(container).children!) {
			if (entry.kind === "anonymous") {
				this.#invalidateBox(entry);
			} else if (entry.fragments) {
				this.#markRunMeasureDirty(entry.node!);
			}
		}
	}

	/**
	 * Invalidate the MEASURE that contains a node, without touching the
	 * layout tree's shape. The full run invalidation (below) also ensures
	 * the run head owns a layout node -- correct at flex level, but a
	 * NESTED inline-block is a run head only inside its parent's
	 * measurement, and manufacturing a layout node for it would insert a
	 * child under a measure-function node. This walks to the nearest
	 * ancestor that actually owns a measuring flex node, clears the cached
	 * break results on the way, and dirties it.
	 */
	#invalidateEnclosingMeasure(node: Node): void {
		// Whatever restyled a node with no box of its own may have given it
		// one, or taken one away: the container's box list is what says.
		const runContainer = this.#runContainerOf(node);
		if (runContainer) this.#dirtyRunContainers.add(runContainer);
		// The box a node's content sits in may be its ANCESTOR's box: a node
		// inside a run member is not itself a member, and the anonymous box
		// holding it belongs to no DOM node, so the climb below -- which looks
		// for a layout node with a measure function -- walks straight past it.
		let entry = this.#boxEntryOf(node);
		for (
			let ancestor = entry === null ? boxParentElement(node) : null;
			ancestor && entry === null;
			ancestor = boxParentElement(ancestor)
		) {
			entry = this.#boxEntryOf(ancestor);
		}
		if (entry?.kind === "anonymous") {
			if (entry.flexNode) {
				this.#invalidateBox(entry);
				return;
			}
			// A run with no layout node of its own is measured INSIDE another
			// run: an inline-block nested in an inline-block has no box the
			// flex tree knows about -- its whole content is part of the one
			// unit its host occupies out there. The measure to drop is that
			// outer one, which the container it runs in is the way up to.
			if (entry.container !== node) {
				this.#invalidateEnclosingMeasure(entry.container);
				return;
			}
		} else if (entry) {
			const headFlexNode = this.nodeMap.get(entry.node!);
			if (headFlexNode && headFlexNode.measureFunc) {
				headFlexNode.markDirty();
				// Keep climbing out of any content root this run sits under:
				// only the box that owns it can run that layout again.
				const host = this.#enclosingContentRoot(boxParentElement(entry.node!));
				if (host) this.#invalidateEnclosingMeasure(host);
				return;
			}
		}
		let current = boxParentElement(node);
		while (current) {
			// An ancestor that is itself a run member owns no layout node: the
			// anonymous box holding it is what measures it, and everything
			// nested inside it with it. Nothing further out ever re-runs that
			// measure, so the climb ends here.
			const enclosing = this.#boxEntryOf(current);
			if (enclosing?.kind === "anonymous" && enclosing.flexNode) {
				this.#invalidateBox(enclosing);
				return;
			}
			const flexNode = this.nodeMap.get(current);
			if (flexNode) {
				if (flexNode.measureFunc) {
					flexNode.markDirty();
				}
				const host = this.#enclosingContentRoot(boxParentElement(current));
				if (host) this.#invalidateEnclosingMeasure(host);
				return;
			}
			current = boxParentElement(current);
		}
	}

	[kInvalidateInlineRun](node: Node): void {
		const entry = this.#boxEntryOf(node);
		if (!entry) return;
		if (entry.kind === "anonymous") {
			this.#invalidateContainerBoxes(entry.container);
			this.#dirtyRunContainers.add(entry.container);
			// Content an anonymous box lays out owns no layout node of its own.
			// One left over from an earlier shape of the container measures the
			// same content a second time, in a box the container no longer has.
			this.#retireFlexNode(node);
			return;
		}
		// A box of the element's own (a flex container blockifies its inline
		// children) measures only itself.
		const container = this.#runContainerOf(entry.node!);
		if (container) this.#invalidateContainerBoxes(container);
		this.nodeMap.get(entry.node!)?.markDirty();
	}

	/**
	 * Determines if a whitespace-only text node should be collapsed to nothing
	 * according to CSS whitespace collapsing rules in block formatting contexts
	 */
	#shouldCollapseWhitespaceTextNode(textNode: Text): boolean {
		// Only collapse whitespace-only text nodes
		if (!textNode.textContent || !/^\s*$/.test(textNode.textContent)) {
			return false;
		}

		// Get parent element
		const parent = textNode.parentElement;
		if (!parent) {
			return false;
		}

		// White space is collapsible only where the parent says it is. Under
		// `pre`, `pre-wrap` and `break-spaces` a space is content, and a block
		// holding nothing but spaces is a line tall; under `pre-line` the
		// spaces still collapse, but a newline is a forced break and keeps its
		// line. A card's blank middle row is three spaces, and this is what
		// makes it a row.
		const whiteSpace = getPropertyValue(parent, "white-space");
		if (preservesSpaces(whiteSpace)) return false;
		if (whiteSpace === "pre-line" && textNode.textContent.includes("\n")) {
			return false;
		}

		// Check parent's display type - only collapse in block formatting contexts
		const parentDisplay = getPropertyValue(parent, "display");
		if (parentDisplay === "inline" || parentDisplay === "inline-block") {
			// In inline contexts, preserve whitespace as spaces
			return false;
		}

		// Check if this whitespace is between block-level elements. A comment
		// generates no box, so it is never what the white space sits next to.
		const rendered = (
			node: Node | null,
			step: (from: Node) => Node | null,
		): Node | null => {
			let current = node;
			while (current && current.nodeType === current.COMMENT_NODE) {
				current = step(current);
			}
			return current;
		};
		const prevSibling = rendered(
			textNode.previousSibling,
			(from) => from.previousSibling,
		);
		const nextSibling = rendered(
			textNode.nextSibling,
			(from) => from.nextSibling,
		);

		// Helper to check if a node is block-level
		const isBlockLevel = (node: Node | null): boolean => {
			if (!node || node.nodeType !== node.ELEMENT_NODE) {
				return false;
			}
			const display = getPropertyValue(node as Element, "display");
			return display !== "inline" && display !== "inline-block";
		};

		// If whitespace is between two block elements, collapse it
		if (isBlockLevel(prevSibling) && isBlockLevel(nextSibling)) {
			return true;
		}

		// If whitespace is at the start/end of a block container next to a block element, collapse it
		if (isBlockLevel(prevSibling) && !nextSibling) {
			return true; // End of container after block element
		}

		if (!prevSibling && isBlockLevel(nextSibling)) {
			return true; // Start of container before block element
		}

		// If whitespace is the only content at start/end of block container, collapse it
		if (!prevSibling && !nextSibling) {
			return true; // Only content in block container
		}

		return false;
	}

	handleMutations(mutations: MutationRecord[]): void {
		for (const record of mutations) {
			this.#restageForRecord(record);
		}
	}

	/**
	 * Elements whose computed style the cascade has dropped, awaiting the work
	 * that drop implies for layout. Collected rather than acted on: the cascade
	 * announces them mid-invalidation, while descendants still hold the styles
	 * they are about to lose, and every question layout asks here -- which box
	 * holds this element, what kind of box it is -- is a question about the
	 * styles that have not finished arriving.
	 */
	#restyled = new Set<Element>();

	/**
	 * The cascade dropped an element's computed style.
	 *
	 * Whatever measured that element measured it under the style that is gone,
	 * and nothing about the space that measurement was offered says so: a
	 * member that turns display:none leaves its width behind, one that changes
	 * shape measures at a size nothing re-asked for, and a flex container
	 * blockifies children whose boxes were built as inline ones. So the box is
	 * dirtied and the enumerations around it restaged. Over-approximate by
	 * construction -- a style change that moves no geometry costs a
	 * re-measurement, and one that moves geometry is never missed.
	 */
	styleInvalidated(element: Element): void {
		this.#restyled.add(element);
	}

	/**
	 * Dirty what measures each restyled element, and restage the enumerations
	 * that decide which box that is.
	 */
	#applyRestyles(): void {
		while (this.#restyled.size > 0) {
			const restyled = [...this.#restyled];
			this.#restyled.clear();
			for (const element of restyled) {
				if (!flatIsConnected(element)) continue;
				// The element's own box may move between runs, and so may the
				// boxes of its children.
				this.#restageBox(element);
				this.#restageChildren(element);
				const flexNode = this.nodeMap.get(element);
				// Which side of the line the element falls on: an anonymous box
				// lays its content out, or it owns a layout node. A style change
				// moves elements across that line, and a node left over on the
				// wrong side lays the same content out a second time -- or, on
				// the other side, there is no node to lay it out at all.
				//
				// An out-of-flow box is left alone: it hangs from its containing
				// block, not from the tree it is written in, and rebuilding it
				// from there is how it loses its place -- the select's picker
				// sits in the top layer and simply vanished.
				const boxed =
					this.#measuresAsRun(element) && this.#boxOf(element) !== null;
				if (isOutOfFlow(element)) {
					// An out-of-flow box hangs from its containing block, and no
					// container's box list names it -- so no reconciliation ever
					// asks again what kind of box it is, and rebuilding it from
					// the tree it is written in is how it loses its place: the
					// select's picker sits in the top layer and simply vanished.
					// Rebuilt where it hangs, or not at all.
					if (flexNode && !this.#boxKindMatches(element, flexNode)) {
						this.#retireFlexNode(element);
						this.#addNode(element, null);
					}
				} else if (
					!dissolvesIntoChildren(element) &&
					(boxed === (flexNode !== undefined) ||
						(flexNode !== undefined &&
							!this.#boxKindMatches(element, flexNode)))
				) {
					this.invalidate(element);
				}
				// The layout node carries the element's own margins, padding and
				// dimensions, which are the style that just went. Looked up
				// again: a rebuild above freed whatever node was there before.
				const boxNode = this.nodeMap.get(element);
				if (boxNode) this.#styleNode(element, boxNode);
				this.#invalidateEnclosingMeasure(element);
				if (this.#boxes.get(element)?.children) {
					this.#invalidateContainerBoxes(element);
					// The children of a flex container are each a box of their
					// own, blockified (css-display-3 §2.7), where a block
					// container gathers the inline ones into anonymous boxes it
					// shares -- so an element that becomes one, or stops being
					// one, holds a different set of boxes than it did.
					this.#dirtyRunContainers.add(element);
				}
			}
		}
	}

	/**
	 * The work a single mutation record implies for layout.
	 *
	 * Nothing here builds or places a box. A mutation says only which
	 * containers no longer hold the boxes their enumeration names, and what
	 * measured content that has changed underneath it; the boxes themselves are
	 * reconciled from the enumerations, by the one path a fresh build uses.
	 */
	#restageForRecord(record: MutationRecord): void {
		// A record on a shadow root describes the HOST's composed children.
		const target =
			record.target.nodeType === record.target.DOCUMENT_FRAGMENT_NODE
				? (record.target as ShadowRoot).host
				: record.target;
		if (record.type === "attributes") {
			// The element's own box may move between runs (its display could
			// have changed), and so may the boxes of its children (a flex
			// container gives each child a box of its own). Which rules now
			// match, and what that costs the boxes under them, is the cascade's
			// to announce -- it does, through styleInvalidated.
			this.#restageBox(target);
			this.#restageChildren(target as Element);
			if (record.attributeName === "slot") {
				// Reassigning a slot moves the node in the COMPOSED tree while
				// the light tree stands still -- no childList record will ever
				// arrive, and the container it left is not reachable from where
				// it now sits. The host's whole composed subtree re-enumerates;
				// slot reassignment is rare enough for the hammer.
				const host = (target as Element).parentElement;
				if (host && shadowRootOf<ShadowRoot>(host)) {
					this.#restageSubtree(host);
				}
			}
			return;
		}
		if (record.type === "characterData") {
			this.#restageBox(target);
			this.#invalidateEnclosingMeasure(target);
			return;
		}
		// Added and removed nodes both change the container's run structure --
		// including the runs on either side of a block that left or arrived.
		// The removed nodes are already detached, so the container is reached
		// through the target rather than through them.
		if (target.nodeType === target.ELEMENT_NODE) {
			this.#restageChildren(target as Element);
		}
		// A member gaining or losing a descendant is not a change to any
		// container's box list: the member is still there, holding more or
		// less. Nothing about the space the box measuring it was offered says
		// so, so that box is told directly.
		this.#invalidateEnclosingMeasure(target);
		for (const node of record.addedNodes) {
			this.#restageSubtree(node);
			// An out-of-flow box hangs from its CONTAINING BLOCK, not from the
			// container it is written in, so no container's box list ever names
			// it and no reconciliation ever builds it. It is built where it
			// arrives -- and so is every out-of-flow box inside a subtree that
			// arrives as run content, which no child walk descends into.
			if (isOutOfFlow(node)) {
				this.#addNode(node, null);
			} else if (node.nodeType === node.ELEMENT_NODE) {
				this.#adoptOutOfFlowDescendants(node as Element);
			}
		}
	}

	/**
	 * Whether the element's containing-block chain reaches a fixed box, which
	 * is what puts its geometry in viewport space rather than document space.
	 * The one answer to that question: hit-testing converts its probe point by
	 * it, and the public client-rect wrappers skip the camera conversion by it.
	 */
	isInFixedSpace(element: Element): boolean {
		for (
			let el: Element | null = element;
			el;
			el = flatParentElement<Element>(el)
		) {
			if (getPropertyValue(el, "position") === "fixed") return true;
		}
		return false;
	}

	/**
	 * The flex node an out-of-flow box belongs under: its CSS containing
	 * block -- the nearest ancestor whose position isn't static -- or the
	 * initial containing block (the document root) when there is none. This
	 * is the hoist that makes absolute positioning containing-block-correct
	 * (flex's own absolute type only knows its parent) AND what frees an
	 * absolute box from a measure-function subtree: its layout node hangs
	 * from the containing block, wherever its DOM sits. Paint order is
	 * unaffected -- the stacking-context painter never uses flex order for
	 * positioned boxes.
	 */
	#containingBlockFlexNode(element: Element): FlexTypes.Node | null {
		for (
			let ancestor = flatParentElement<Element>(element);
			ancestor;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			const position = getPropertyValue(ancestor, "position");
			if (position && position !== "static") {
				const flexNode = this.nodeMap.get(ancestor);
				// A measure-function node cannot take flex children; a
				// positioned inline-block can't serve as a flex containing
				// block, so the hoist keeps climbing.
				if (flexNode && !flexNode.measureFunc) return flexNode;
			}
		}
		return this.nodeMap.get(this.rootElement) ?? null;
	}

	/** Hidden by an ancestor's display:none anywhere up the flat tree. */
	#hiddenByAncestor(node: Node): boolean {
		for (
			let ancestor = flatParentElement<Element>(node);
			ancestor;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			if (getPropertyValue(ancestor, "display") === "none") return true;
		}
		return false;
	}

	#addNode(node: Node, parentFlexNode: FlexTypes.Node | null = null): void {
		// A display:none ancestor removes the whole subtree from layout --
		// fresh builds never descend past the none boundary, and rebuild
		// sweeps must not smuggle descendants back in under the hidden
		// container (the flex engine does not ignore them).
		if (this.#hiddenByAncestor(node)) {
			// Whatever boxes the node brought with it from where it was visible
			// go with it: nothing under the boundary generates one.
			this.#retireFlexNode(node);
			if (node.nodeType === node.ELEMENT_NODE) {
				this.#retireHiddenContent(node as Element);
			}
			return;
		}

		// display:contents generates NO box: fresh builds flatten it via the
		// walker, and a REBUILD must not resurrect a stale box from an
		// earlier display value -- its children re-add as the box parent's
		// own. Retire whatever node it had.
		if (node.nodeType === node.ELEMENT_NODE && dissolvesIntoChildren(node)) {
			this.#retireFlexNode(node);
			// The children it dissolves into are the CONTAINER's boxes, and the
			// container learns of them only by enumerating again: an element
			// that generates no box announces nothing else on its way in.
			const container = this.#runContainerOf(node);
			if (container) {
				this.#staleContainers.add(container);
				this.#dirtyRunContainers.add(container);
			}
			return;
		}
		// Out-of-flow boxes hoist to their containing block, appended at the
		// end -- they neither displace siblings nor depend on tree position.
		// position: fixed skips the ancestor climb entirely: its containing
		// block is the VIEWPORT (the terminal-sized root the document node
		// itself hangs from), so bottom/right resolve against the screen and
		// the box holds still under the camera -- which is the coordinate
		// space the painter's camera-cancel and hit-testing's conversion
		// always assumed.
		if (isOutOfFlow(node)) {
			const containingBlock =
				getPropertyValue(node as Element, "position") === "fixed"
					? this.viewportRootNode
					: this.#containingBlockFlexNode(node as Element);
			if (containingBlock) parentFlexNode = containingBlock;
		}

		// A measure-function node owns no layout children: everything under an
		// inline-block was measured as one opaque unit, positions and all.
		// (Out-of-flow boxes already hoisted above -- they left that unit.) A
		// rebuild sweep that resolves a parent by climbing to the nearest
		// tracked ancestor lands here, and inserting would leave the element
		// holding a node the flex engine never lays out -- extent 0..0 at 0,0,
		// which paint culling reads as "nothing to draw" -- so an <input> alone
		// inside an inline-block box paints nothing, while the same input
		// beside a single letter of text paints fine.
		if (parentFlexNode?.measureFunc) {
			const stale = this.nodeMap.get(node);
			if (stale && stale.getParent() === parentFlexNode) {
				parentFlexNode.removeChild(stale);
				this.#measureNodes.delete(stale);
				stale.freeRecursive();
				this.#untrackNode(node);
			}
			return;
		}

		if (this.nodeMap.has(node)) {
			// Node already exists - this might be a moved node that needs reparenting
			const existingFlexNode = this.nodeMap.get(node)!;
			// Content that an anonymous box lays out owns no layout node: one
			// left from when this node was block-level, or headed a run under a
			// shape the container no longer has, is retired here so the box is
			// the only thing measuring it.
			if (isInlineLevel(node) && this.#boxOf(node)) {
				this.#retireFlexNode(node);
				if (node.nodeType === node.ELEMENT_NODE) {
					this.#addElementNode(node as Element, parentFlexNode);
				} else {
					this.#addTextNode(node as Text, parentFlexNode);
				}
				return;
			}
			// Reuse is only sound while the node is still the same KIND of box.
			// A run member flipped out of flow at runtime (or back) changes
			// kind: the stale node keeps its inline-run measure func, and that
			// measure skips out-of-flow boxes -- so it measures 0x0 and the
			// element (pseudo content included) silently vanishes. Retire the
			// mismatched node and rebuild from scratch instead.
			if (existingFlexNode && node.nodeType === node.ELEMENT_NODE) {
				const element = node as Element;
				if (!this.#boxKindMatches(element, existingFlexNode)) {
					this.#retireFlexNode(node);
					this.#addElementNode(element, parentFlexNode);
					return;
				}
				// Whatever moved the node may also have restyled it (the flip
				// that hoists a box to its containing block usually did).
				this.#styleNode(element, existingFlexNode);
			}
			if (existingFlexNode && parentFlexNode) {
				// Check if it's already a child of the correct parent
				const currentParent = existingFlexNode.getParent();
				if (currentParent !== parentFlexNode) {
					// Remove from current parent first (if any)
					if (currentParent) {
						currentParent.removeChild(existingFlexNode);
					}
					// Appended: where a box sits among its container's
					// children is the container's box list to say, and the
					// reconciliation that reads it settles the order.
					parentFlexNode.insertChild(
						existingFlexNode,
						parentFlexNode.children.length,
					);
					const container = this.#runContainerOf(node);
					if (container) this.#dirtyRunContainers.add(container);
				}
			}
			return;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			this.#addElementNode(node as Element, parentFlexNode);
		} else if (node.nodeType === node.TEXT_NODE) {
			this.#addTextNode(node as Text, parentFlexNode);
		}
	}

	/**
	 * Add layout nodes for every out-of-flow box in a subtree the child
	 * walk will never descend into (an inline run member, an inline-block's
	 * measured content). #addNode hoists each to its containing block; the
	 * run machinery skips them, so this is the only path that finds them.
	 */
	#adoptOutOfFlowDescendants(element: Element): void {
		const walker = flowWalker(element);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.nodeType === node.ELEMENT_NODE && isOutOfFlow(node)) {
				this.#addNode(node, null);
			}
		}
	}

	/**
	 * Whether an element's box measures its content as one run. An inline is
	 * blockified by a flex container (css-display-3 §2.7), and a blockified one
	 * holding block-level content is a block CONTAINER: measured as a run
	 * instead, its content would end at the first block inside it and
	 * everything from there on would be dropped. A blockified inline holding
	 * only inline content still measures as a run -- that is what gives a flex
	 * item its intrinsic size.
	 */
	#measuresAsRun(element: Element): boolean {
		if (isOutOfFlow(element)) return false;
		const display = getPropertyValue(element, "display");
		if (!isInlineDisplay(display)) return false;
		if (display === "inline-block") return true;
		if (isInlineLevel(element)) return true;
		return !this.#containsBlockLevelBox(element);
	}

	#addElementNode(
		element: Element,
		parentFlexNode: FlexTypes.Node | null = null,
	): void {
		const display = getPropertyValue(element, "display");
		const measuresAsRun = this.#measuresAsRun(element);

		// Inline-level content lays out in its container's anonymous boxes,
		// which the container reconciles as a whole -- unless the box is out of
		// flow, which blockifies it per CSS: it never joins a run.
		if (measuresAsRun) {
			const box = this.#boxOf(element);
			if (box) {
				this.#invalidateBox(box);
				this.#dirtyRunContainers.add(box.container);
				this.#adoptOutOfFlowDescendants(element);
				this.#syncContentRoot(element);
				return;
			}
			// No anonymous box holds it: its own box is what lays it out (a
			// flex container's blockified children) -- proceed to create it.
		}

		// Appended: a box's position among its container's children is the
		// container's box list to say, and the reconciliation that reads it
		// settles the order.
		const flexIndex = parentFlexNode?.children.length ?? 0;

		let flexNode = this.nodeMap.get(element);
		if (!flexNode) {
			flexNode = Flex.Node.createWithConfig(flexConfig);
			this.#trackNode(element, flexNode);
		}

		this.#styleNode(element, flexNode);

		if (display === "none") {
			flexNode.setDisplay(Flex.DISPLAY_NONE);
			if (flexNode && parentFlexNode) {
				placeChild(parentFlexNode, flexNode, flexIndex);
			}
			return;
		} else if (measuresAsRun) {
			const box = this.#principalBox(element);
			flexNode.setMeasureFunc((width, widthMode, height, heightMode, placing) =>
				this.#measureInlineRun(
					box,
					width,
					widthMode,
					height,
					heightMode,
					placing,
				),
			);
			this.#measureNodes.add(flexNode);

			// Note: Automatic minimum size for flex items is now handled in measureInlineRun

			if (flexNode && parentFlexNode) {
				placeChild(parentFlexNode, flexNode, flexIndex);
			}

			this.#adoptOutOfFlowDescendants(element);
			this.#syncContentRoot(element);
			return;
		}

		// Block elements should NOT get measure functions - only their inline children do.
		// This prevents Flex constraint violations (nodes with measure functions cannot have children)

		// A box laid out in the tree above lays out no children of its own: an
		// element that stops being an inline-block lays its block content out
		// here, and a content root left behind would go on claiming the same
		// children.
		this.#retireContentRoot(this.#principalBox(element));

		// Only DIRECT children: an inline child broken apart by a block-level
		// box holds boxes this container lays out, and those reach the tree
		// through its own box reconciliation.
		const walker = flowWalker(element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (
				child.nodeType === child.ELEMENT_NODE ||
				child.nodeType === child.TEXT_NODE
			) {
				this.#addNode(child, flexNode);
			}
		}

		// The inline children just walked past lay out in boxes of this
		// container's, which only the container can place. Here rather than in
		// calculateLayout's drain, because a container built from inside a
		// measure (an inline-block's block content) is laid out the moment the
		// measure returns, with no drain in between.
		if (this.#dirtyRunContainers.has(element)) {
			this.#syncContainerRuns(element);
		}

		if (flexNode && parentFlexNode) {
			placeChild(parentFlexNode, flexNode, flexIndex);
			// The index above is counted among the element's DOM siblings,
			// which know nothing of the anonymous boxes between them. The
			// container's box list is what settles the order, so ask for it.
			const container = this.#runContainerOf(element);
			if (container) this.#dirtyRunContainers.add(container);
		}
	}

	/**
	 * Retire every box under a display:none element.
	 *
	 * Nothing in a display:none subtree generates a box, and layout never
	 * descends past the boundary to say so: a node built while the subtree was
	 * visible is never visited again, and goes on answering getRect -- and the
	 * used values resolved off it -- with the geometry it had when it was last
	 * laid out. Retiring them is what makes the subtree box-less.
	 */
	#retireHiddenContent(element: Element): void {
		const box = this.#boxes.get(element);
		if (box?.children) {
			for (const child of box.children) {
				if (child.kind === "anonymous") this.#retireAnonymousBox(child);
			}
			// The children a hidden container holds are none, and a box that
			// kept the ones it had would answer with them on the next read.
			box.children = null;
			box.heads = null;
			box.structure = -1;
		}
		this.#dirtyRunContainers.delete(element);
		if (box) this.#retireContentRoot(box);
		const walker = createFlatTreeWalker<Node>(element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			this.#retireFlexNode(child);
			if (child.nodeType === child.ELEMENT_NODE) {
				this.#retireHiddenContent(child as Element);
			}
		}
	}

	/**
	 * Retire the boxes of the dissolved elements under a container: those the
	 * flattening walk steps over. Only dissolved elements are descended into,
	 * so this costs what they cost and nothing for a tree without them.
	 */
	#retireDissolved(parent: Element): void {
		const walker = createFlatTreeWalker<Node>(parent);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (
				child.nodeType !== child.ELEMENT_NODE ||
				!dissolvesIntoChildren(child as Element)
			) {
				continue;
			}
			// #addNode is what retires the box of a box-less element.
			if (this.nodeMap.has(child)) this.#addNode(child, null);
			this.#retireDissolved(child as Element);
		}
	}

	/**
	 * css-flexbox-1 §4: an anonymous flex item containing only collapsible
	 * white space is not rendered. The newlines and indentation of
	 * multi-line flex markup must not become items that eat gap and
	 * justify-content space -- browsers drop them; so do we. Preserved
	 * white space (white-space: pre/pre-wrap on the container) stays an
	 * item, and a run that reaches any inline content is a real item.
	 */
	#isSuppressedFlexWhitespace(text: Text): boolean {
		const parent = text.parentElement;
		if (!parent) return false;
		if (!isFlexContainer(parent)) return false;
		if (preservesSpaces(getPropertyValue(parent, "white-space"))) return false;
		for (let node: Node | null = text; node; node = node.nextSibling) {
			if (node.nodeType === node.TEXT_NODE) {
				if ((node as Text).data.trim() !== "") return false;
				continue;
			}
			if (node.nodeType !== node.ELEMENT_NODE) continue;
			const sibling = node as Element;
			const siblingDisplay = getPropertyValue(sibling, "display");
			if (siblingDisplay === "none") continue;
			// An inline sibling joins this run and gives it content; anything
			// block-level ends the run with only white space collected.
			if (isInlineDisplay(siblingDisplay)) return false;
			break;
		}
		return true;
	}

	#addTextNode(text: Text, parentFlexNode: FlexTypes.Node | null = null): void {
		if (!parentFlexNode) {
			return;
		}

		if (this.#isSuppressedFlexWhitespace(text)) {
			return;
		}

		// Text lays out in its container's anonymous box, which the container
		// reconciles as a whole.
		const box = this.#boxOf(text);
		if (box) {
			this.#invalidateBox(box);
			this.#dirtyRunContainers.add(box.container);
			return;
		}

		let flexNode = this.nodeMap.get(text);
		if (!flexNode) {
			flexNode = Flex.Node.createWithConfig(flexConfig);
			this.#trackNode(text, flexNode);
		}

		const own = this.#principalBox(text);
		flexNode.setMeasureFunc((width, widthMode, height, heightMode, placing) =>
			this.#measureInlineRun(
				own,
				width,
				widthMode,
				height,
				heightMode,
				placing,
			),
		);
		this.#measureNodes.add(flexNode);

		// Note: Automatic minimum size for flex items is now handled in measureInlineRun

		parentFlexNode.insertChild(flexNode, parentFlexNode.getChildCount());
	}

	/**
	 * The boxes a block container lays out, in document order, seeing THROUGH
	 * any inline box that wraps block-level content. CSS breaks such an inline
	 * apart (CSS2 §9.2.1.1): `<p><span>a<div>b</div>c</span></p>` gives the
	 * paragraph THREE boxes -- an anonymous block holding "a", the div, and
	 * another holding "c" -- not one inline. The wrapper is yielded before its
	 * own children because it heads the first fragment's run.
	 *
	 * `<a href="..."><div>card</div></a>` is this shape; without the split,
	 * everything from the block onward renders as nothing.
	 */
	#flowChildren(
		container: Element,
		into: Node[] = [],
		root = container,
	): Node[] {
		const walker = flowWalker(container);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			into.push(child);
			if (child.nodeType !== child.ELEMENT_NODE) continue;
			// Written on the way past rather than recomputed by the readers:
			// paint culling asks per element per frame, and re-walking an
			// inline's subtree there would cost every off-screen row of a long
			// list. An inline that stops splitting is told so here, by the
			// enumeration that stops reaching through it.
			const splits = this.#splitsAroundBlock(child as Element);
			this.#principalBox(child).broken = splits;
			if (splits) {
				this.#principalBox(root).holdsFragments = true;
				this.#flowChildren(child as Element, into, root);
			}
		}
		return into;
	}

	/**
	 * Give an atomic inline that holds block-level content the layout root its
	 * children hang from. An inline-block establishes a block container, so
	 * `<span style="display:inline-block"><p>x</p></span>` is legal and common
	 * -- but the box is measured as ONE opaque unit by the run it sits on, and
	 * a run ends at a block-level box, so the p's content is not the run's to
	 * lay out. The box's own measurement lays it out instead, since only the
	 * run that placed the box can say where its content edge is.
	 */
	#syncContentRoot(element: Element): void {
		const box = this.#principalBox(element);
		// Only an inline-block, never a plain inline: an inline containing a
		// block is BROKEN around it, and taking its content here would steal
		// back the boxes that belong to its container.
		if (
			getPropertyValue(element, "display") !== "inline-block" ||
			!this.#containsBlockLevelBox(element)
		) {
			this.#retireContentRoot(box);
			return;
		}

		let root = box.contentRoot;
		if (!root) {
			root = Flex.Node.createWithConfig(flexConfig);
			root.setDisplay(Flex.DISPLAY_BLOCK);
			root.setBlockFormattingContext(true);
			box.contentRoot = root;
		}

		const walker = flowWalker(element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (
				child.nodeType === child.ELEMENT_NODE ||
				child.nodeType === child.TEXT_NODE
			) {
				this.#addNode(child, root);
			}
		}

		// The root is laid out by the measure that reaches it, which may be the
		// one running right now: its boxes have to be in it before it returns.
		if (this.#dirtyRunContainers.has(element)) {
			this.#syncContainerRuns(element);
		}
	}

	/** Retire a box's content root once its content is all inline again. */
	#retireContentRoot(box: Box): void {
		const root = box.contentRoot;
		if (!root) return;
		box.contentRoot = null;
		// Sever first: the children belong to DOM nodes that re-add themselves
		// through the run machinery, and freeing them would leave nodeMap
		// pointing at corpses.
		while (root.children.length > 0) {
			root.removeChild(root.children[0]);
		}
		root.freeRecursive();
	}

	/**
	 * Dirty the measure that refills a run's break result -- and, when the run
	 * lives under an atomic inline's content root, the box whose measure is the
	 * only thing that ever lays that content out. Dirtying just the run there
	 * invalidates it forever: nothing above the box ever visits those nodes, so
	 * the cleared break result is never rebuilt and the run paints nothing.
	 */
	#markRunMeasureDirty(runHead: Node): void {
		const flexNode = this.nodeMap.get(runHead);
		if (!flexNode) return;
		if (flexNode.measureFunc) flexNode.markDirty();
		const host = this.#enclosingContentRoot(boxParentElement(runHead));
		if (host) this.#invalidateEnclosingMeasure(host);
	}

	/**
	 * A box's position in document space: the sum up its layout tree, and then
	 * the content edge of the atomic inline that tree belongs to, if it belongs
	 * to one. Coordinates under a content root start at the box that owns it,
	 * which only the run that placed that box can locate.
	 *
	 * The owner is the ancestor whose root the node was actually laid out
	 * under, not merely the nearest one above it: an out-of-flow descendant of
	 * an atomic inline hangs from its containing block, wherever that is, and
	 * takes its position from that layout instead.
	 */
	#documentPosition(
		node: Node,
		flexNode: FlexTypes.Node,
	): {x: number; y: number} {
		const position = this.#absolutePosition(flexNode);
		let root = flexNode;
		for (let parent = root.getParent(); parent; parent = root.getParent()) {
			root = parent;
		}
		if (root === this.viewportRootNode) return position;
		let host: Element | null = null;
		for (
			let current = boxParentElement(node);
			current && !host;
			current = boxParentElement(current)
		) {
			if (this.#boxes.get(current)?.contentRoot === root) host = current;
		}
		const hostRect = host && this.getRect(host);
		if (!host || !hostRect) return position;
		const boxModel = getBoxModel(host);
		return {
			x:
				position.x +
				hostRect.x +
				boxModel.borderLeftWidth +
				boxModel.paddingLeft,
			y:
				position.y + hostRect.y + boxModel.borderTopWidth + boxModel.paddingTop,
		};
	}

	/** An inline box with block-level content inside it: CSS breaks it apart. */
	#splitsAroundBlock(element: Element): boolean {
		if (isOutOfFlow(element)) return false;
		if (getPropertyValue(element, "display") !== "inline") return false;
		return this.#containsBlockLevelBox(element);
	}

	#containsBlockLevelBox(element: Element): boolean {
		const walker = flowWalker(element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (child.nodeType !== child.ELEMENT_NODE) continue;
			const childElement = child as Element;
			if (isOutOfFlow(childElement)) continue;
			const display = getPropertyValue(childElement, "display");
			// An inline-block contains its own blocks without splitting anything.
			if (display === "none" || display === "inline-block") continue;
			if (display === "inline") {
				if (this.#containsBlockLevelBox(childElement)) return true;
				continue;
			}
			return true;
		}
		return false;
	}

	/**
	 * Break a box's content into lines and report the size they came to.
	 *
	 * `placing` is the measurement that decides the box the content ends up
	 * in, as against the sizing probes a container makes on its way there. Only
	 * that one's lines become the box's: a probe at some other width -- the
	 * min-content one among them -- is an answer about a box nothing was ever
	 * laid out in, and painting it renders a stretched item at its narrowest.
	 */
	#measureInlineRun(
		box: Box,
		width: number,
		widthMode: FlexTypes.MeasureMode,
		height: number,
		heightMode: FlexTypes.MeasureMode,
		placing: boolean,
	): FlexTypes.Size {
		const breakResult = this.#breakNodes(
			box,
			width,
			widthMode,
			height,
			heightMode,
		);
		if (Number.isFinite(width)) {
			breakResult.containerWidth = width;
		}
		if (placing) box.fragments = breakResult;

		return {
			width: breakResult.maxLineWidth,
			height: breakResult.totalHeight,
		};
	}

	/**
	 * The first composed (flat-tree) child that can start an inline run:
	 * shadow content for hosts, projected content through slots, skipping
	 * display:none elements -- a UA shadow tree's <style> would otherwise
	 * terminate leaf collection at position zero.
	 */
	#firstComposedRenderableChild(element: Element): Node | null {
		const walker = flowWalker(element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (
				child.nodeType === child.ELEMENT_NODE &&
				(getPropertyValue(child as Element, "display") === "none" ||
					isOutOfFlow(child))
			) {
				continue;
			}
			return child;
		}
		return null;
	}

	/**
	 * Whether width is this element's flex MAIN axis: its composed parent is
	 * a row-direction flex container, so the flex algorithm -- not its own
	 * CSS width -- owns its used width.
	 */
	#isRowFlexItem(element: Element): boolean {
		const parent = flatParentElement<Element>(element);
		if (!parent) return false;
		if (!isFlexContainer(parent)) return false;
		const direction = getPropertyValue(parent, "flex-direction") || "row";
		return direction === "row" || direction === "row-reverse";
	}

	/**
	 * The leaves a box lays out: the text, the atomic boxes and the breaks
	 * reachable through its members.
	 *
	 * The members are the box's own -- what the container's enumeration put in
	 * it -- so nothing here decides where a run ends or walks past a member to
	 * find out. Each member's subtree is collected in turn, which is the same
	 * content the enumeration already assigned, and a member that has left the
	 * tree is not among them.
	 */
	#collectLeafNodes(
		source: Box,
		availableWidth: number,
		availableWidthMode: FlexTypes.MeasureMode = Flex.MEASURE_MODE_UNDEFINED,
	): Leaf[] {
		const leafNodes: Leaf[] = [];
		if (source.kind === "anonymous") {
			// Each member's own subtree, and no further: the enumeration
			// already said where this box's content ends.
			for (const member of source.members) {
				this.#collectLeavesUnder(
					member,
					member,
					false,
					leafNodes,
					availableWidth,
					availableWidthMode,
				);
			}
			return leafNodes;
		}

		const node = source.node!;
		const parentElement = boxParentElement(node);
		if (!parentElement) return leafNodes;

		// An element measuring its OWN content walks from itself, out through
		// the block container that holds it: a run that starts inside an inline
		// box -- the fragment after a block-level box split it -- carries on
		// past that box's end. `<span>a<div/>b</span>c` puts "b" and "c" on one
		// line, so the walk cannot stop at </span>. An out-of-flow inline is
		// where the climb stops: it is blockified (css-display-3 §2.7) and lays
		// its own content out.
		const parentDisplay = getPropertyValue(parentElement, "display");
		let traversalRoot: Node;
		if (parentDisplay === "flex" && node.nodeType === node.ELEMENT_NODE) {
			traversalRoot = node;
		} else {
			let root: Element = parentElement;
			for (
				let ancestor = boxParentElement(root);
				ancestor &&
				getPropertyValue(root, "display") === "inline" &&
				!isOutOfFlow(root);
				ancestor = boxParentElement(root)
			) {
				root = ancestor;
			}
			traversalRoot = root;
		}

		// Text directly inside a flex container forms an ANONYMOUS flex item
		// out of the contiguous text runs, and every element child is an item
		// of its own -- so this one ends at the first element.
		const stopsAtFlexItems =
			parentDisplay === "flex" && node.nodeType === node.TEXT_NODE;

		this.#collectLeavesUnder(
			traversalRoot,
			node,
			stopsAtFlexItems,
			leafNodes,
			availableWidth,
			availableWidthMode,
		);
		return leafNodes;
	}

	/** Collect leaves from `start`, walking within `root`. */
	#collectLeavesUnder(
		root: Node,
		start: Node,
		stopsAtFlexItems: boolean,
		leafNodes: Leaf[],
		availableWidth: number,
		availableWidthMode: FlexTypes.MeasureMode,
	): void {
		const walker = flowWalker(root);
		walker.currentNode = start;
		while (walker.currentNode) {
			const node = walker.currentNode;
			if (stopsAtFlexItems && node.nodeType === node.ELEMENT_NODE) {
				break;
			}

			if (node.nodeType === node.TEXT_NODE) {
				// Text node - add as leaf
				const textNode = node as Text;

				if (textNode.textContent) {
					// Check if this is a whitespace-only text node between block elements
					const isWhitespaceOnly = /^\s*$/.test(textNode.textContent);

					if (
						isWhitespaceOnly &&
						this.#shouldCollapseWhitespaceTextNode(textNode)
					) {
						// Skip this whitespace text node - it should be collapsed to nothing
						if (!walker.nextNode()) break;
						continue;
					}

					leafNodes.push({
						type: "text",
						node: textNode,
						content: textNode.textContent,
					});
				}
				// Continue with normal traversal
				if (!walker.nextNode()) break;
			} else if (node.nodeType === node.ELEMENT_NODE) {
				const element = node as Element;
				const display = getPropertyValue(element, "display");

				if (
					getPropertyValue(element, "display") === "none" ||
					isOutOfFlow(element)
				) {
					// No box here (none) or a box ELSEWHERE (out of flow):
					// neither occupies run space nor interrupts the run. Checked
					// before the display branches -- an absolute inline span
					// otherwise measures into the run it left.
					if (!skipSubtree(walker)) break;
				} else if (element.tagName === "BR") {
					leafNodes.push({
						type: "br",
						node: element as HTMLBRElement,
					});
					// Continue with normal traversal
					if (!walker.nextNode()) break;
				} else if (display === "inline-block") {
					const ownBox = this.#principalBox(element);
					// Before anything reads its size or asks what its content
					// runs from: an inline-block nested inside another inline is
					// a run MEMBER, and #addElementNode is never called on one,
					// so this is the first moment its block content is known to
					// need a root.
					if (!ownBox.contentRoot) this.#syncContentRoot(element);

					// Parse CSS box model properties
					const boxModel = getBoxModel(element);

					// getBoxModel only carries absolute widths; a percentage
					// resolves here, against the run's available width -- the
					// containing block's content width by the time layout asks.
					// This is what lets `input { width: 100% }` (TodoMVC's own
					// stylesheet) fill its container instead of collapsing to a
					// void element's contentless zero. Against an indefinite
					// width (a min-content probe offers 0, which IS definite and
					// correctly resolves a percentage to 0), auto behavior falls
					// through as before, per CSS.
					if (boxModel.width === undefined) {
						const widthValue = parseUnitValue(
							getPropertyValue(element, "width"),
						);
						if (
							widthValue !== null &&
							typeof widthValue === "object" &&
							Number.isFinite(availableWidth) &&
							availableWidth < Number.MAX_SAFE_INTEGER
						) {
							boxModel.width = Math.max(
								0,
								Math.round((widthValue.percentage / 100) * availableWidth),
							);
						}
					}

					// Calculate available content dimensions
					const horizontalBoxSpace =
						boxModel.paddingLeft +
						boxModel.paddingRight +
						boxModel.borderLeftWidth +
						boxModel.borderRightWidth;
					const verticalBoxSpace =
						boxModel.paddingTop +
						boxModel.paddingBottom +
						boxModel.borderTopWidth +
						boxModel.borderBottomWidth;

					// Determine content constraints
					let contentWidth = Number.MAX_SAFE_INTEGER;
					let contentHeight = Number.MAX_SAFE_INTEGER;
					let contentWidthMode = Flex.MEASURE_MODE_UNDEFINED;
					let contentHeightMode = Flex.MEASURE_MODE_UNDEFINED;

					if (boxModel.width !== undefined) {
						contentWidth = Math.max(0, boxModel.width - horizontalBoxSpace);
						contentWidthMode = Flex.MEASURE_MODE_EXACTLY;
					} else if (element.tagName === "TEXTAREA") {
						// cols sizes the CONTENT box (spec default 20), exactly as the
						// attribute does in a browser; the box then adds whatever
						// border and padding the cascade actually left. The UA sheet
						// deliberately carries no width for it -- a constant that
						// pre-baked the UA chrome could not be unbaked by an author's
						// `border: none`.
						const cols = parseInt(element.getAttribute("cols") ?? "", 10);
						contentWidth = Number.isFinite(cols) && cols > 0 ? cols : 20;
						contentWidthMode = Flex.MEASURE_MODE_EXACTLY;
					}

					// When width is this element's flex MAIN axis, its used width is
					// the flex engine's to decide -- basis, grow, shrink and min/max
					// all resolved engine-side -- and the measure offers carry that
					// authority: a definite EXACTLY offer is the resolved used width
					// (the final layout pass, see flex.ts), and an AT_MOST offer
					// below the CSS width is an intrinsic probe (the css-flexbox-1
					// §4.5 min-content floor offers 0) that wants the CONTENT's
					// minimum, not the basis -- the engine clamps the floor by the
					// specified size itself. Both break the content at the offer.
					// Row flex items only: everywhere else a definite width wins
					// over the container's offer, and a block container's EXACTLY
					// offer describes the CONTAINER's width, not this element's own
					// resolution -- a definite-width inline-block in a narrow block
					// overflows, it does not re-wrap.
					let offerOwnsWidth = false;
					if (Number.isFinite(availableWidth) && this.#isRowFlexItem(element)) {
						const offered = Math.max(0, availableWidth - horizontalBoxSpace);
						if (availableWidthMode === Flex.MEASURE_MODE_EXACTLY) {
							contentWidth = offered;
							contentWidthMode = Flex.MEASURE_MODE_EXACTLY;
							offerOwnsWidth = true;
						} else if (
							availableWidthMode === Flex.MEASURE_MODE_AT_MOST &&
							offered < contentWidth
						) {
							contentWidth = offered;
							contentWidthMode = Flex.MEASURE_MODE_AT_MOST;
							offerOwnsWidth = true;
						}
					}

					// max-width caps the width the content BREAKS at, not just the
					// reported box size the later clamp covers -- otherwise the
					// content wraps at its natural width and overflows the capped box.
					const maxWidthValue = parseUnitValue(
						getPropertyValue(element, "max-width"),
					);
					// A percentage resolves against the containing block's content
					// width -- the run's available width -- as `width` does above.
					// Without it a `max-width: 100%` value part (every text field's
					// own) breaks at its natural width and overflows its field rather
					// than clipping to it. Indefinite width leaves nothing to resolve
					// against, so it falls through.
					let maxWidthCap: number | undefined;
					if (typeof maxWidthValue === "number") {
						maxWidthCap = maxWidthValue;
					} else if (
						maxWidthValue &&
						"percentage" in maxWidthValue &&
						Number.isFinite(availableWidth) &&
						availableWidth < Number.MAX_SAFE_INTEGER
					) {
						maxWidthCap = (maxWidthValue.percentage / 100) * availableWidth;
					}
					if (maxWidthCap !== undefined) {
						const cap = Math.max(0, maxWidthCap - horizontalBoxSpace);
						if (cap < contentWidth) {
							contentWidth = cap;
							if (contentWidthMode === Flex.MEASURE_MODE_UNDEFINED) {
								contentWidthMode = Flex.MEASURE_MODE_AT_MOST;
							}
						}
					}

					if (boxModel.height !== undefined) {
						contentHeight = Math.max(0, boxModel.height - verticalBoxSpace);
						contentHeightMode = Flex.MEASURE_MODE_EXACTLY;
					}

					// Recursively measure inline-block content with constraints.
					// The COMPOSED first child, not element.firstChild: an
					// inline-block shadow host (author tree or a widget's UA
					// tree) renders its shadow content, and measuring the light
					// children sized every such host to zero. display:none
					// children (a UA tree's <style>, chiefly) can't start the
					// run -- they'd terminate leaf collection before it began.
					const contentRoot = ownBox.contentRoot;
					let inlineBlockResult: BreakResult | undefined;
					let finalContentWidth: number;
					let finalContentHeight: number;

					if (contentRoot) {
						// Block-level content inside: lay the box's own children
						// out here, since nothing above it will. An indefinite
						// width shrinks to fit, which is what an inline-block does.
						// NaN is the engine's "undefined": the axis shrinks to fit.
						contentRoot.calculateLayout(
							contentWidthMode === Flex.MEASURE_MODE_EXACTLY
								? contentWidth
								: Number.NaN,
							contentHeightMode === Flex.MEASURE_MODE_EXACTLY
								? contentHeight
								: Number.NaN,
						);
						finalContentWidth = contentRoot.getComputedWidth();
						finalContentHeight = contentRoot.getComputedHeight();
					} else {
						const contentStart = this.#firstComposedRenderableChild(element);
						if (contentStart) {
							inlineBlockResult = this.#breakNodes(
								this.#principalBox(contentStart),
								contentWidth,
								contentWidthMode,
								contentHeight,
								contentHeightMode,
							);
						}
						finalContentWidth = inlineBlockResult?.maxLineWidth ?? 0;
						finalContentHeight = inlineBlockResult?.totalHeight ?? 0;
					}

					// max-width caps the REPORTED box, not just the width content
					// broke against: content that cannot wrap to fit (a single-line
					// field's pre text, an unbreakable word) overflows the capped
					// box and is clipped by overflow:hidden, rather than stretching
					// it. Without this the box grows to its content and there is
					// nothing for the field's horizontal scroll to window.
					if (maxWidthCap !== undefined) {
						finalContentWidth = Math.min(
							finalContentWidth,
							Math.max(0, maxWidthCap - horizontalBoxSpace),
						);
					}

					// Void elements (input, br, etc.) with no LIGHT children keep a
					// minimum height of 1 -- an input whose UA parts are all empty
					// text still occupies its row.
					if (!element.firstChild && finalContentHeight === 0) {
						finalContentHeight = 1;
					}

					// A textarea's rows floor its CONTENT height (spec default 2) --
					// a floor, not a height: the field grows with its content, the
					// terminal-native reading of a multiline field (a browser scrolls
					// inside a fixed box instead; element scrolling is machinery this
					// engine doesn't have). An author height wins below. cols likewise
					// fix the reported content width: the box is attribute-sized, not
					// content-sized, however short the value or placeholder runs.
					if (element.tagName === "TEXTAREA") {
						if (boxModel.height === undefined) {
							const rows = parseInt(element.getAttribute("rows") ?? "", 10);
							finalContentHeight = Math.max(
								finalContentHeight,
								Number.isFinite(rows) && rows > 0 ? rows : 2,
							);
						}
						if (boxModel.width === undefined && !offerOwnsWidth) {
							finalContentWidth = contentWidth;
						}
					}

					// min/max constraints clamp the measured content. This leaf IS
					// where an inline-block's box gets its size (the flex node
					// only ever reports the whole run), so min-height on a
					// textarea -- or any author inline-block -- lands here.
					// Values are border-box, like width; convert to content-box.
					const minWidthValue = parseUnitValue(
						getPropertyValue(element, "min-width"),
					);
					if (typeof minWidthValue === "number") {
						finalContentWidth = Math.max(
							finalContentWidth,
							minWidthValue - horizontalBoxSpace,
						);
					}
					const minHeightValue = parseUnitValue(
						getPropertyValue(element, "min-height"),
					);
					if (typeof minHeightValue === "number") {
						finalContentHeight = Math.max(
							finalContentHeight,
							minHeightValue - verticalBoxSpace,
						);
					}
					if (typeof maxWidthValue === "number") {
						finalContentWidth = Math.min(
							finalContentWidth,
							maxWidthValue - horizontalBoxSpace,
						);
					}
					const maxHeightValue = parseUnitValue(
						getPropertyValue(element, "max-height"),
					);
					if (typeof maxHeightValue === "number") {
						finalContentHeight = Math.min(
							finalContentHeight,
							maxHeightValue - verticalBoxSpace,
						);
					}

					// If explicit dimensions were set, use those instead of measured
					// content -- unless the measure offer owned the width above: an
					// intrinsic probe's answer must be the content's, not the basis
					// the engine already knows.
					if (boxModel.width !== undefined && !offerOwnsWidth) {
						finalContentWidth = Math.max(
							0,
							boxModel.width - horizontalBoxSpace,
						);
					}
					if (boxModel.height !== undefined) {
						finalContentHeight = Math.max(
							0,
							boxModel.height - verticalBoxSpace,
						);
					}

					leafNodes.push({
						type: "inline-block",
						node: element,
						breakResult: inlineBlockResult,
						boxModel,
						contentWidth: finalContentWidth,
						contentHeight: finalContentHeight,
					});
					// Skip children -- they were measured inside the box above
					if (!skipSubtree(walker)) break;
				} else if (display === "inline") {
					// Inline element - traverse into its children
					if (!walker.nextNode()) break;
				} else {
					// A block-level box is not this box's content: it broke the
					// inline that holds it, and the fragments on either side are
					// members of their own.
					break;
				}
			} else {
				// Unknown node type - continue
				if (!walker.nextNode()) break;
			}
		}
	}

	#breakNodes(
		source: Box,
		width: number,
		widthMode: FlexTypes.MeasureMode,
		_height: number,
		_heightMode: FlexTypes.MeasureMode,
	): BreakResult {
		// An UNDEFINED width offer means "measure your natural size" --
		// indefinite, so percentage widths in the content cannot resolve
		// against it (NaN); any definite offer, including an AT_MOST 0
		// min-content probe, resolves them.
		const leafNodes = this.#collectLeafNodes(
			source,
			widthMode === Flex.MEASURE_MODE_UNDEFINED ? NaN : width,
			widthMode,
		);

		// Handle empty case
		if (leafNodes.length === 0) {
			return {lines: [], totalHeight: 0, maxLineWidth: 0};
		}

		// The box's own text properties come from what opens it. A text node
		// styles from its flat-tree parent, which for the text of a
		// pseudo-element is the pseudo-element's own node.
		const opener = source.head;
		const styleElement =
			opener.nodeType === opener.TEXT_NODE
				? flatParentElement<Element>(opener)!
				: (opener as Element);

		// Get default CSS properties from the opening element
		const whiteSpace = getPropertyValue(styleElement, "white-space");
		const wordBreak = getPropertyValue(styleElement, "word-break");
		const overflowWrap = getPropertyValue(styleElement, "overflow-wrap");

		// An offered width of 0 is a real constraint, not "unlimited": it asks for
		// the narrowest the content can be, which is its min-content size -- the
		// longest word that cannot be broken. Treating it as unlimited returns
		// max-content instead, making min-content zero everywhere, with a long
		// word left nothing to stop it overflowing its box.
		const maxWidth =
			widthMode === Flex.MEASURE_MODE_UNDEFINED
				? Number.MAX_SAFE_INTEGER
				: width;

		// Process and break the content with dynamic per-element styling
		const processedContent = this.#processWhitespace(leafNodes);
		// `pre` suppresses wrapping exactly as `nowrap` does -- it differs only in
		// preserving whitespace and honouring newlines, which #processWhitespace
		// already handles. Treating it as wrappable folds text a browser lets
		// overflow.
		const preservesLines = whiteSpace === "pre";
		const nowrap =
			preservesLines ||
			(whiteSpace || "normal") === "nowrap" ||
			this.#hasNowrapLeaf(processedContent);
		const breaks = this.#findBreakPoints(processedContent, {
			maxWidth,
			whiteSpace: whiteSpace || "normal",
			nowrap,
		});
		// A word with no break opportunity inside it either overflows its
		// line (overflow-wrap: normal, the browser default) or gains
		// synthetic break points anywhere it needs them (break-word /
		// anywhere / word-break: break-all). break-word deliberately does
		// NOT shrink min-content -- the word still measures whole at the
		// AT_MOST 0 probe -- while anywhere and break-all do.
		const breakAnywhere =
			!nowrap &&
			(wordBreak === "break-all" ||
				overflowWrap === "anywhere" ||
				(overflowWrap === "break-word" && maxWidth > 0));
		// The paragraph's base direction: `direction: rtl` states it, and
		// otherwise the content decides it the way UAX #9 §P2 does -- the first
		// strong character wins. That second half is what makes an Arabic string
		// dropped into an undeclared <div> come out right, which is how such a
		// string usually arrives.
		const declared = getPropertyValue(styleElement, "direction");
		const base: "ltr" | "rtl" =
			declared === "rtl"
				? "rtl"
				: declared === "ltr"
					? "ltr"
					: inferParagraphDirection(processedContent.text);

		const lines = this.#buildLines(
			processedContent,
			breaks,
			maxWidth,
			breakAnywhere,
			base,
		);

		return {
			lines,
			totalHeight: lines.reduce((sum, line) => sum + line.height, 0),
			maxLineWidth: Math.max(...lines.map((l) => l.width), 0),
		};
	}

	/**
	 * A text node's data rendered under a `white-space` value, held until either
	 * changes. One inline run is broken several times per build -- once per
	 * width the sizing pass tries -- and the rendering is the same every time.
	 */
	/**
	 * The last rendering of each text node, under the one key its rendering is
	 * a function of: the data and the white-space it was rendered under. A node
	 * holds one, because a text node has one data and one white-space at a
	 * time, and the previous rendering of a node whose data just changed is of
	 * no use to anyone.
	 */
	#renderedLeaves = new WeakMap<
		Text,
		{
			key: string;
			text: string;
			offsets: RenderedOffsets | null;
		}
	>();

	#renderLeaf(
		textNode: Text,
		whiteSpace: string,
	): {text: string; offsets: RenderedOffsets | null} {
		const key = `${whiteSpace}\u0000${textNode.data}`;
		const cached = this.#renderedLeaves.get(textNode);
		if (cached?.key === key) return cached;
		const rendered = renderWhiteSpaceOffsets(textNode.data, whiteSpace);
		this.#renderedLeaves.set(textNode, {
			key,
			text: rendered.text,
			offsets: rendered.offsets,
		});
		return rendered;
	}

	#processWhitespace(leafNodes: Leaf[]): ProcessedContent {
		const items: ProcessedContent["items"] = [];
		let text = "";

		for (let leafIndex = 0; leafIndex < leafNodes.length; leafIndex++) {
			const leaf = leafNodes[leafIndex];
			const start = text.length;

			if (leaf.type === "text" && leaf.content) {
				// The white-space this leaf renders under, read the way a painter
				// reads it: from the flat-tree parent whose style it inherits.
				const leafWhiteSpace = whiteSpaceOf(leaf.node);

				// Process the text content according to its white-space property,
				// keeping the mapping back to raw data offsets.
				const rendered = this.#renderLeaf(leaf.node, leafWhiteSpace);
				let processed = rendered.text;
				let dataOffsets = rendered.offsets;

				// Collapse boundary whitespace between adjacent text nodes -- but
				// only where this leaf's white-space collapses at all. Under the
				// preserving values every space is content, and a run of
				// single-space spans is as wide as it has spans.
				if (
					leafIndex > 0 &&
					processed.length > 0 &&
					!preservesSpaces(leafWhiteSpace)
				) {
					const prevItem = items[items.length - 1];
					if (prevItem && prevItem.leafNode.type === "text") {
						const prevEndsWithSpace =
							text.length > 0 && text[text.length - 1] === " ";
						const thisStartsWithSpace = processed[0] === " ";

						if (prevEndsWithSpace && thisStartsWithSpace) {
							processed = processed.substring(1);
							dataOffsets = shiftRenderedOffsets(dataOffsets, 1);
						}
					}
				}

				text += processed;

				items.push({
					leafNode: leaf,
					start: start,
					end: text.length,
					processedContent: processed,
					dataOffsets,
				});
			} else if (leaf.type === "br") {
				// BR elements always create a line break
				text += "\n";
				items.push({
					leafNode: leaf,
					start,
					end: text.length,
				});
			} else if (leaf.type === "inline-block") {
				// Inline-block elements are treated as a single unit
				// Add a placeholder character for measurement
				text += "\uFFFC"; // Object replacement character
				items.push({
					leafNode: leaf,
					start,
					end: text.length,
				});
			}
		}

		// Final cleanup: trim leading/trailing spaces from the entire run
		// But preserve them for pre text or isolated measurement scenarios
		if (text.length > 0) {
			// Check if any leaf has pre-style whitespace that should be preserved
			const hasPreWhitespace = leafNodes.some((leaf) => {
				if (leaf.type === "text") {
					const ws = whiteSpaceOf(leaf.node);
					return ws === "pre" || ws === "pre-wrap" || ws === "pre-line";
				}
				return false;
			});

			// Only trim if we don't have pre whitespace and we have multiple leaf nodes
			// For isolated text (single leaf), preserve trailing spaces for measurement
			const shouldTrim = !hasPreWhitespace && leafNodes.length > 1;

			if (shouldTrim) {
				// Spaces and tabs, never the newline a <br> contributes: that
				// one is a forced break, not collapsible whitespace, and
				// trimming it dropped the blank line `<br>text` opens with.
				const trimStart = text.match(/^[^\S\n]*/)?.[0].length || 0;
				const trimEnd = text.match(/[^\S\n]*$/)?.[0].length || 0;

				if (trimStart > 0 || trimEnd > 0) {
					const trimmedEnd = text.length - trimEnd;
					text = text.slice(trimStart, trimmedEnd);

					// Each leaf's own text must be trimmed by exactly what its
					// offsets moved. Shifting the offsets alone left the painter
					// slicing the UNtrimmed string at trimmed positions, so a run
					// whose first leaf lost a leading space painted one character
					// past its measured width -- and the line clipped the last
					// one off: "<br> abcdef" rendered " abcde".
					for (const item of items) {
						const clampedStart = Math.min(
							Math.max(item.start, trimStart),
							trimmedEnd,
						);
						const clampedEnd = Math.min(
							Math.max(item.end, trimStart),
							trimmedEnd,
						);
						if (item.processedContent !== undefined) {
							item.processedContent = item.processedContent.slice(
								clampedStart - item.start,
								clampedEnd - item.start,
							);
							item.dataOffsets = shiftRenderedOffsets(
								item.dataOffsets ?? null,
								clampedStart - item.start,
							);
						}
						item.start = clampedStart - trimStart;
						item.end = clampedEnd - trimStart;
					}
				}
			}
		}

		return {items, text, prefixWidths: prefixWidths(items, text)};
	}

	/** Does ANY text leaf in the run carry white-space: nowrap? */
	#hasNowrapLeaf(content: ProcessedContent): boolean {
		return content.items.some((item) => {
			if (item.leafNode.type === "text") {
				return whiteSpaceOf(item.leafNode.node) === "nowrap";
			}
			return false;
		});
	}

	#findBreakPoints(
		content: ProcessedContent,
		options: BreakOptions,
	): BreakPoint[] {
		// Nothing may break a nowrap run except a break the CONTENT demands: a
		// newline under `pre`, or a <br>. Dropping every break point suppressed
		// those too, so `pre` -- which does not wrap but does honour newlines --
		// collapsed a three-line block onto one line.
		if (options.nowrap) {
			const forced: BreakPoint[] = [];
			if (options.whiteSpace === "pre" || options.whiteSpace === "pre-wrap") {
				for (let i = content.text.indexOf("\n"); i !== -1; ) {
					forced.push({position: i + 1, required: true});
					i = content.text.indexOf("\n", i + 1);
				}
			}
			forced.push({position: content.text.length, required: false});
			return forced;
		}

		const breaker = new LineBreaker(content.text);
		const breaks: BreakPoint[] = [];

		let lastPos = 0;
		let bk;
		while ((bk = breaker.nextBreak())) {
			let required = bk.required || false;

			const {whiteSpace = "normal"} = options;
			if (
				whiteSpace === "pre" ||
				whiteSpace === "pre-wrap" ||
				whiteSpace === "pre-line"
			) {
				const segment = content.text.slice(lastPos, bk.position);
				if (segment.includes("\n")) {
					required = true;
				}
			}

			breaks.push({
				position: bk.position,
				required,
			});
			lastPos = bk.position;
		}

		return breaks;
	}

	#buildLines(
		content: ProcessedContent,
		breaks: BreakPoint[],
		maxWidth: number,
		breakAnywhere: boolean,
		base: "ltr" | "rtl" = "ltr",
	): LineResult[] {
		const lines: LineResult[] = [];
		let currentY = 0;
		let lineStart = 0;
		// Break positions ascend, and each line starts where the last one ended,
		// so the candidates for a line are a suffix of the array: the cursor only
		// ever moves forward, and no line rescans what an earlier one consumed.
		let cursor = 0;
		// The first required break at or after each index, so a line can tell
		// whether a forced break falls inside the span that fits without walking
		// the candidates one by one.
		const nextRequired = new Int32Array(breaks.length + 1);
		nextRequired[breaks.length] = breaks.length;
		for (let i = breaks.length - 1; i >= 0; i--) {
			nextRequired[i] = breaks[i].required ? i : nextRequired[i + 1];
		}

		while (lineStart < content.text.length) {
			let bestBreak = lineStart;
			let bestBreakWidth = 0;

			while (cursor < breaks.length && breaks[cursor].position <= lineStart) {
				cursor++;
			}

			// Cumulative widths rise with position, so the candidates that fit are
			// a run starting at the cursor -- bisect for its last member instead of
			// measuring every one.
			let low = cursor;
			let high = breaks.length - 1;
			let lastFitting = cursor - 1;
			while (low <= high) {
				const mid = (low + high) >> 1;
				if (
					this.#measureText(content, lineStart, breaks[mid].position) <=
					maxWidth
				) {
					lastFitting = mid;
					low = mid + 1;
				} else {
					high = mid - 1;
				}
			}

			// A required break inside the fitting run ends the line there, however
			// much room is left.
			const required = nextRequired[cursor];
			const chosen = required <= lastFitting ? required : lastFitting;
			if (chosen >= cursor) {
				bestBreak = breaks[chosen].position;
				bestBreakWidth = this.#measureText(content, lineStart, bestBreak);
			}

			// No break opportunity fits. Under overflow-wrap: normal the line
			// takes the whole unbreakable unit and OVERFLOWS, exactly as a
			// browser lets a long word escape its box; only break-word/
			// anywhere/break-all may synthesize a break inside the word.
			if (bestBreak === lineStart && !breakAnywhere) {
				bestBreak =
					cursor < breaks.length
						? breaks[cursor].position
						: content.text.length;
				bestBreakWidth = this.#measureText(content, lineStart, bestBreak);
			}

			if (bestBreak === lineStart) {
				let pos = lineStart + 1;
				while (pos <= content.text.length) {
					// Check if we would break within an inline-block element
					let crossesInlineBlock = false;
					for (const item of content.items) {
						if (item.leafNode.type === "inline-block") {
							// If our position would split this inline-block, skip to its end
							if (pos > item.start && pos < item.end) {
								pos = item.end;
								crossesInlineBlock = true;
								break;
							}
						}
					}

					if (crossesInlineBlock) {
						continue; // Try again with the new position
					}

					const width = this.#measureText(content, lineStart, pos);
					if (width > maxWidth && pos > lineStart + 1) {
						pos--;
						break;
					}
					pos++;
				}
				bestBreak = Math.min(pos, content.text.length);
				bestBreakWidth = this.#measureText(content, lineStart, bestBreak);
			}

			const lineNodes = this.#getNodesInRange(
				content.items,
				lineStart,
				bestBreak,
			);

			if (lineNodes.length > 0) {
				const lineHeight = Math.max(
					...lineNodes.map((n) =>
						n.leaf.type === "inline-block"
							? n.leaf.contentHeight +
								n.leaf.boxModel.paddingTop +
								n.leaf.boxModel.paddingBottom +
								n.leaf.boxModel.borderTopWidth +
								n.leaf.boxModel.borderBottomWidth
							: 1,
					),
					1,
				);

				// Cells go out in VISUAL order, because the terminal will not
				// reorder them for us (see bidi.ts). Doing it here rather than at
				// paint time means hit-testing and selection read the same
				// coordinates the user is looking at.
				this.#toVisualLine(lineNodes, bestBreakWidth, base);

				lines.push({
					segments: lineNodes,
					y: currentY,
					height: lineHeight,
					width: bestBreakWidth,
				});

				currentY += lineHeight;
			}

			lineStart = bestBreak;
		}

		return lines;
	}

	/** The width of text[start..end) of a run, in terminal cells. */
	#measureText(content: ProcessedContent, start: number, end: number): number {
		return content.prefixWidths[end] - content.prefixWidths[start];
	}

	/**
	 * Rewrite one built line from logical order into visual order, in place.
	 *
	 * Two halves, and both are needed: each segment's characters are reordered
	 * (bidi.ts), and in an RTL paragraph the segments themselves are mirrored
	 * across the line, since the line now starts at its right edge.
	 *
	 * Segment boundaries are leaf boundaries, so a directional run split across
	 * two leaves -- `<span>مرحبا</span><span>Bun</span>` -- reorders within each
	 * leaf rather than across the pair. Whole-line reordering would need the
	 * segments merged and re-split, which loses the leaf identity that painting,
	 * hit-testing and selection all key on.
	 */
	#toVisualLine(
		segments: LineResult["segments"],
		lineWidth: number,
		base: "ltr" | "rtl",
	): void {
		if (this.#terminalReordersText) return; // It insists; let it.
		if (base === "ltr" && !segments.some((s) => hasRTL(s.processedText))) {
			return; // Nothing bidirectional here; the common case pays one scan.
		}

		for (const segment of segments) {
			if (segment.leaf.type === "text") {
				segment.processedText = toVisualOrder(segment.processedText, base);
				segment.visualBase = base;
			}
		}

		if (base === "rtl") {
			for (const segment of segments) {
				segment.x = lineWidth - segment.x - segment.width;
				// Shaping is not length-preserving: a lam-alef pair collapses
				// into one ligature glyph, so the painted run can be narrower
				// than the measured segment. Pin the RIGHT edge -- the RTL
				// flush edge -- and let the spare cell fall on the left, where
				// an RTL reader expects ragged. Offsets stay logical; only the
				// painted box moves.
				if (segment.leaf.type === "text") {
					const shaped = runtimeStringWidth(segment.processedText);
					const delta = segment.width - shaped;
					if (delta > 0) {
						segment.x += delta;
						segment.width = shaped;
					}
				}
			}
		}
	}

	#getNodesInRange(
		items: ProcessedContent["items"],
		start: number,
		end: number,
	): LineResult["segments"] {
		const nodes: LineResult["segments"] = [];
		let x = 0;

		for (const item of items) {
			if (item.start >= end || item.end <= start) continue;

			const itemStart = Math.max(item.start, start);
			const itemEnd = Math.min(item.end, end);

			if (itemStart < itemEnd) {
				let width = 0;
				if (item.leafNode.type === "text" && item.processedContent) {
					const relativeStart = itemStart - item.start;
					const relativeEnd = itemEnd - item.start;
					// A preserved newline is a BREAK, never a glyph: lines split
					// right after it, so it can only ever sit at the segment's
					// tail -- and a literal \n reaching the painter would feed
					// the terminal a raw line feed, shifting every later cell
					// of the frame (a segment's data range ends on its last
					// PAINTED character, so offsets stay aligned).
					const portion = item.processedContent
						.slice(relativeStart, relativeEnd)
						.replace(/\n+$/, "");
					width = runtimeStringWidth(portion);

					// The data range that renders back to `portion`: from the
					// offset its first character came from, through the end of
					// the code unit its last one came from. A preserved newline
					// the line broke on is outside it, as it is outside the
					// painted text, but an empty fragment still reports where it
					// sits -- the caret slot of a blank line.
					const offsets = item.dataOffsets ?? null;
					const dataStart =
						relativeStart < item.processedContent.length
							? dataOffsetAt(offsets, relativeStart)
							: item.leafNode.node.data.length;
					const dataEnd =
						portion.length > 0
							? dataOffsetAt(offsets, relativeStart + portion.length - 1) + 1
							: dataStart;

					nodes.push({
						leaf: item.leafNode,
						start: relativeStart,
						end: relativeEnd,
						x,
						width,
						processedText: portion,
						dataStart,
						dataEnd,
						visualBase: null,
					});
				} else if (item.leafNode.type === "inline-block") {
					width = inlineBlockWidth(item.leafNode);
					// Extract text content from the inline-block's breakResult
					let processedText = "";
					if (item.leafNode.breakResult) {
						for (const line of item.leafNode.breakResult.lines) {
							for (const segment of line.segments) {
								processedText += segment.processedText;
							}
						}
					}
					nodes.push({
						leaf: item.leafNode,
						start: 0,
						end: 0,
						x,
						width,
						processedText,
						dataStart: 0,
						dataEnd: 0,
						visualBase: null,
					});
				} else if (item.leafNode.type === "br") {
					nodes.push({
						leaf: item.leafNode,
						start: 0,
						end: 0,
						x,
						width: 0,
						processedText: "",
						dataStart: 0,
						dataEnd: 0,
						visualBase: null,
					});
				}

				x += width;
			}
		}

		return nodes;
	}
}

function isPointInRects(
	x: number,
	y: number,
	...rects: Array<DOMRect | DOMRect[] | DOMRectList>
): boolean {
	const allRects = rects.flat();
	return allRects.some((rect) => {
		if (Array.isArray(rect) || rect instanceof DOMRectList) {
			// Handle nested arrays/lists
			return isPointInRects(x, y, ...rect);
		}
		return (
			x >= rect.x &&
			x < rect.x + rect.width &&
			y >= rect.y &&
			y < rect.y + rect.height
		);
	});
}
