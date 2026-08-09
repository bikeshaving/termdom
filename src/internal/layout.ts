import type {EngineWindow} from "./termdom.js";
import {currentInvalidationEpoch, invalidateStructure} from "./termdom.js";
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
	selectorInvalidationScope,
} from "./styles.js";
import {
	compositionBoxParentElement,
	compositionIsConnected,
	compositionParentElement,
	compositionShadowRoot,
	createExpandedTreeWalker,
	ExpandedTreeWalker,
	getPseudoMetadata,
} from "./composition.js";
import {
	hasRTL,
	inferParagraphDirection,
	stringWidth as runtimeStringWidth,
	toVisualOrder,
} from "./text.js";

/**
 * Whether a box takes part in positioned layout -- the predicate both the
 * containing-block chain and stacking-context collection are built on. Also
 * consulted by the painter's in-flow walk, so it is exported.
 */
export function isPositioned(window: EngineWindow, element: Element): boolean {
	const position = computedStyleOf(element).computedValueOf("position");
	return Boolean(position) && position !== "static";
}

/**
 * z-index only means anything on a positioned box; "auto" stays distinct from 0
 * -- auto paints in the same layer but does NOT form a context.
 */
function zIndexValueOf(
	window: EngineWindow,
	element: Element,
): number | "auto" {
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
	if (align === "right" || align === "end") {
		return Math.max(0, containerWidth - lineWidth);
	}
	// `start` is the start of the READING direction, so an RTL paragraph with no
	// text-align of its own begins at the right edge. Unset behaves as start.
	if (
		(align === "" || align === "start") &&
		getPropertyValue(container, "direction") === "rtl"
	) {
		return Math.max(0, containerWidth - lineWidth);
	}
	return 0;
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
	"inline-flex",
	"grid",
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
 * Advance a walker past the current node's subtree, in document order,
 * without descending into it. nextSibling() alone is not that: it gives up
 * the moment the skipped node is its parent's last child, and an inline run
 * does not end there. `<span><b>x</b></span> tail` collects the <b>, finds
 * no sibling inside the span, and must climb out to reach " tail". Stopping
 * at the parent's last child instead drops every leaf after a nested
 * inline-block (or a display:none/absolute box) from the line.
 */
function skipSubtree(walker: ExpandedTreeWalker): boolean {
	while (!walker.nextSibling()) {
		if (!walker.parentNode()) return false;
	}
	return true;
}

// ---- CSS 2.2 §8.3.1 margin collapsing (the block-emulation half) ----
//
// The flex engine SUMS adjacent margins; CSS block layout collapses them.
// The collapse resolves here, at style-application time, as a pure function
// of the DOM: the gap between siblings lives entirely on the lower box's
// top margin, and a margin that collapses THROUGH a parent's edge is hoisted
// into the ancestor whose edge stops it and zeroed where it was declared.
// Not modeled: self-collapsing empty blocks (their two margins stay distinct).

/** Adjoining margins combine as largest positive plus most negative. */
function combineMargins(margins: number[]): number {
	let maxPositive = 0;
	let minNegative = 0;
	for (const margin of margins) {
		if (margin > maxPositive) maxPositive = margin;
		if (margin < minNegative) minNegative = margin;
	}
	return maxPositive + minNegative;
}

function numericMargin(
	element: Element,
	property: "margin-top" | "margin-bottom",
): number {
	const value = parseSignedUnitValue(getPropertyValue(element, property));
	return typeof value === "number" ? value : 0;
}

/** In the parent's flow: rendered, and not taken out by abs/fixed. */
function isInFlow(element: Element): boolean {
	if (getPropertyValue(element, "display") === "none") return false;
	const position = getPropertyValue(element, "position");
	return position !== "absolute" && position !== "fixed";
}

/** Block-LEVEL: occupies its own rows in a block formatting context. */
function isBlockLevel(element: Element): boolean {
	const display = getPropertyValue(element, "display");
	return (
		display === "block" ||
		display === "list-item" ||
		display === "flex" ||
		display === "table"
	);
}

/**
 * A new block formatting context contains its children's margins: nothing
 * collapses through its edges (css2 §8.3.1, §9.4.1).
 */
function establishesBFC(element: Element): boolean {
	if (getPropertyValue(element, "overflow") !== "visible") return true;
	const position = getPropertyValue(element, "position");
	return position === "absolute" || position === "fixed";
}

/**
 * The nearest in-flow block-level sibling in `direction`, or null when text
 * or an inline box sits between -- content separates the margins.
 */
function adjacentBlockSibling(
	element: Element,
	direction: "previousSibling" | "nextSibling",
): Element | null {
	for (let node = element[direction]; node; node = node[direction]) {
		if (node.nodeType === node.TEXT_NODE) {
			if ((node as Text).data.trim() !== "") return null;
			continue;
		}
		if (node.nodeType !== node.ELEMENT_NODE) continue;
		const sibling = node as Element;
		if (!isInFlow(sibling)) continue;
		return isBlockLevel(sibling) ? sibling : null;
	}
	return null;
}

/**
 * The first (or last) in-flow child when it is block-level and no inline
 * content precedes (follows) it -- the child whose margin can adjoin the
 * parent's edge.
 */
function edgeBlockChild(
	element: Element,
	edge: "top" | "bottom",
): Element | null {
	const [start, step] =
		edge === "top"
			? (["firstChild", "nextSibling"] as const)
			: (["lastChild", "previousSibling"] as const);
	for (let node = element[start]; node; node = node[step]) {
		if (node.nodeType === node.TEXT_NODE) {
			if ((node as Text).data.trim() !== "") return null;
			continue;
		}
		if (node.nodeType !== node.ELEMENT_NODE) continue;
		const child = node as Element;
		if (!isInFlow(child)) continue;
		return isBlockLevel(child) ? child : null;
	}
	return null;
}

/**
 * Whether `element`'s own margin at `edge` adjoins its edge-child's margin:
 * a block container with nothing at that edge -- no border, no padding, no
 * BFC, no inline content, and (for the bottom) no definite height. The BODY
 * is the outermost block; margins stop there rather than escaping the
 * document.
 */
function collapsesThrough(element: Element, edge: "top" | "bottom"): boolean {
	if (element.tagName === "BODY") return false;
	const display = getPropertyValue(element, "display");
	if (display !== "block" && display !== "list-item") return false;
	if (establishesBFC(element)) return false;
	const side = edge === "top" ? "top" : "bottom";
	if (parseFloat(getPropertyValue(element, `border-${side}-width`)) > 0) {
		return false;
	}
	const padding = parseUnitValue(getPropertyValue(element, `padding-${side}`));
	if (typeof padding === "number" && padding > 0) return false;
	if (edge === "bottom") {
		const height = getPropertyValue(element, "height");
		if (height && height !== "auto") return false;
	}
	return edgeBlockChild(element, edge) !== null;
}

/** All margins adjoining `element`'s `edge`: its own plus every descendant
 * margin that collapses through. */
function adjoiningMargins(
	element: Element,
	edge: "top" | "bottom",
	out: number[],
): number[] {
	out.push(
		numericMargin(element, edge === "top" ? "margin-top" : "margin-bottom"),
	);
	if (collapsesThrough(element, edge)) {
		adjoiningMargins(edgeBlockChild(element, edge)!, edge, out);
	}
	return out;
}

/**
 * A SELF-COLLAPSING block (css2 §8.3.1): zero-height, nothing at either
 * vertical edge -- its own top and bottom margins adjoin each other, and
 * the margins of its neighbors pass straight through it.
 */
function isSelfCollapsing(element: Element): boolean {
	if (!isInFlow(element)) return false;
	const display = getPropertyValue(element, "display");
	if (display !== "block" && display !== "list-item") return false;
	if (establishesBFC(element)) return false;
	for (const side of ["top", "bottom"]) {
		if (parseFloat(getPropertyValue(element, `border-${side}-width`)) > 0) {
			return false;
		}
		const padding = parseUnitValue(
			getPropertyValue(element, `padding-${side}`),
		);
		if (typeof padding === "number" && padding > 0) return false;
	}
	const height = getPropertyValue(element, "height");
	if (height && height !== "auto") return false;
	const minHeight = parseUnitValue(getPropertyValue(element, "min-height"));
	if (typeof minHeight === "number" && minHeight > 0) return false;
	for (const node of element.childNodes) {
		if (node.nodeType === node.TEXT_NODE) {
			if ((node as Text).data.trim() !== "") return false;
			continue;
		}
		if (node.nodeType !== node.ELEMENT_NODE) continue;
		if (isInFlow(node as Element)) return false;
	}
	return true;
}

/**
 * Walk to the nearest NON-self-collapsing block sibling, gathering the
 * margins of every empty block passed through into `margins`.
 */
function siblingThroughEmpties(
	element: Element,
	direction: "previousSibling" | "nextSibling",
	margins: number[] | null,
): Element | null {
	let sibling = adjacentBlockSibling(element, direction);
	while (sibling && isSelfCollapsing(sibling)) {
		margins?.push(
			numericMargin(sibling, "margin-top"),
			numericMargin(sibling, "margin-bottom"),
		);
		sibling = adjacentBlockSibling(sibling, direction);
	}
	return sibling;
}

/** Whether `element`'s vertical margins are subject to collapsing at all:
 * an in-flow block-level box in a block container. Flex items never
 * collapse (css-flexbox-1 §4). */
function marginCollapseApplies(element: Element): boolean {
	const parent = element.parentElement;
	if (!parent) return false;
	const parentDisplay = getPropertyValue(parent, "display");
	if (parentDisplay !== "block" && parentDisplay !== "list-item") return false;
	return isBlockLevel(element) && isInFlow(element);
}

/** The used margin-top after collapsing, or null to keep the declared one. */
function collapsedMarginTop(element: Element): number | null {
	if (!marginCollapseApplies(element)) return null;
	const parent = element.parentElement!;
	// Absorbed into the parent's edge: the ancestor that stops the collapse
	// carries the combined margin instead.
	if (
		collapsesThrough(parent, "top") &&
		edgeBlockChild(parent, "top") === element
	) {
		return 0;
	}
	// A self-collapsing box between real siblings owns no gap: the following
	// box's top margin gathers everything (both of the empty's margins
	// included), so the empty contributes zero of its own.
	if (
		isSelfCollapsing(element) &&
		siblingThroughEmpties(element, "nextSibling", null)
	) {
		return 0;
	}
	const margins = adjoiningMargins(element, "top", []);
	if (isSelfCollapsing(element)) {
		// Last in its run: nothing after it will gather, so this box carries
		// the whole collapsed set -- both its own margins adjoin.
		margins.push(numericMargin(element, "margin-bottom"));
	}
	const previous = siblingThroughEmpties(element, "previousSibling", margins);
	if (previous) adjoiningMargins(previous, "bottom", margins);
	return combineMargins(margins);
}

/** The used margin-bottom after collapsing, or null to keep the declared one. */
function collapsedMarginBottom(element: Element): number | null {
	if (!marginCollapseApplies(element)) return null;
	const parent = element.parentElement!;
	if (
		collapsesThrough(parent, "bottom") &&
		edgeBlockChild(parent, "bottom") === element
	) {
		return 0;
	}
	// A following sibling's top margin owns the whole collapsed gap (an
	// empty follower still gathers: its own top walk collects this box's
	// bottom chain) -- and a self-collapsing box's bottom is already counted
	// wherever its top went.
	if (isSelfCollapsing(element)) return 0;
	if (adjacentBlockSibling(element, "nextSibling")) return 0;
	return combineMargins(adjoiningMargins(element, "bottom", []));
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
	const parentIsFlex =
		element.parentElement !== null &&
		getPropertyValue(element.parentElement, "display") === "flex";
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

		// Apply min/max constraints for inline-block elements (like block elements)
		const minWidth = parseUnitValue(computedStyle.computedValueOf("min-width"));
		if (typeof minWidth === "number") {
			flexNode.setMinWidth(minWidth);
		} else if (minWidth && "percentage" in minWidth) {
			flexNode.setMinWidthPercent(minWidth.percentage);
		} else {
			// Leave it unset rather than forcing 0. min-width defaults to `auto`,
			// which on a flex item means its content-based minimum -- pinning it to
			// 0 lets the item shrink to nothing while its text stays as wide as its
			// longest word, and paint straight over whatever is next to it.
			flexNode.setMinWidth(undefined);
		}

		const minHeight = parseUnitValue(
			computedStyle.computedValueOf("min-height"),
		);
		if (typeof minHeight === "number") {
			flexNode.setMinHeight(minHeight);
		} else if (minHeight && "percentage" in minHeight) {
			flexNode.setMinHeightPercent(minHeight.percentage);
		} else {
			flexNode.setMinHeight(undefined);
		}

		const maxWidth = parseUnitValue(computedStyle.computedValueOf("max-width"));
		if (typeof maxWidth === "number") {
			flexNode.setMaxWidth(maxWidth);
		} else if (maxWidth && "percentage" in maxWidth) {
			flexNode.setMaxWidthPercent(maxWidth.percentage);
		} else {
			flexNode.setMaxWidth(undefined);
		}

		const maxHeight = parseUnitValue(
			computedStyle.computedValueOf("max-height"),
		);
		if (typeof maxHeight === "number") {
			flexNode.setMaxHeight(maxHeight);
		} else if (maxHeight && "percentage" in maxHeight) {
			flexNode.setMaxHeightPercent(maxHeight.percentage);
		} else {
			flexNode.setMaxHeight(undefined);
		}
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

		// Apply min/max constraints for block elements
		const minWidth = parseUnitValue(computedStyle.computedValueOf("min-width"));
		if (typeof minWidth === "number") {
			flexNode.setMinWidth(minWidth);
		} else if (minWidth && "percentage" in minWidth) {
			flexNode.setMinWidthPercent(minWidth.percentage);
		} else {
			// Leave it unset rather than forcing 0. min-width defaults to `auto`,
			// which on a flex item means its content-based minimum -- pinning it to
			// 0 lets the item shrink to nothing while its text stays as wide as its
			// longest word, and paint straight over whatever is next to it.
			flexNode.setMinWidth(undefined);
		}

		const minHeight = parseUnitValue(
			computedStyle.computedValueOf("min-height"),
		);
		if (typeof minHeight === "number") {
			flexNode.setMinHeight(minHeight);
		} else if (minHeight && "percentage" in minHeight) {
			flexNode.setMinHeightPercent(minHeight.percentage);
		} else {
			flexNode.setMinHeight(undefined);
		}

		const maxWidth = parseUnitValue(computedStyle.computedValueOf("max-width"));
		if (typeof maxWidth === "number") {
			flexNode.setMaxWidth(maxWidth);
		} else if (maxWidth && "percentage" in maxWidth) {
			flexNode.setMaxWidthPercent(maxWidth.percentage);
		} else {
			flexNode.setMaxWidth(undefined);
		}

		const maxHeight = parseUnitValue(
			computedStyle.computedValueOf("max-height"),
		);
		if (typeof maxHeight === "number") {
			flexNode.setMaxHeight(maxHeight);
		} else if (maxHeight && "percentage" in maxHeight) {
			flexNode.setMaxHeightPercent(maxHeight.percentage);
		} else {
			flexNode.setMaxHeight(undefined);
		}
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

		// Vertical margins COLLAPSE in block layout (css2 §8.3.1); the raw
		// values above are replaced with their used, collapsed forms.
		const collapsedTop = collapsedMarginTop(element);
		if (collapsedTop !== null) {
			flexNode.setMargin(Flex.EDGE_TOP, collapsedTop);
		}
		const collapsedBottom = collapsedMarginBottom(element);
		if (collapsedBottom !== null) {
			flexNode.setMargin(Flex.EDGE_BOTTOM, collapsedBottom);
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

	const parentDisplay = element.parentElement
		? getPropertyValue(element.parentElement, "display")
		: null;

	if (parentDisplay === "block") {
		// We emulate display: block with flexbox, but this means we need the children
		// to not have configurable flex properties, or surprising layout behavior
		// might occur.
		flexNode.setFlexGrow(0);
		flexNode.setFlexShrink(0); // Prevent shrinking in block containers
		flexNode.setFlexBasisAuto();
		flexNode.setAlignSelf(Flex.ALIGN_AUTO);
		flexNode.setOrder(undefined); // order only applies to flex items
	} else {
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

		const flexBasis = parseUnitValue(
			computedStyle.computedValueOf("flex-basis"),
		);
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
		// A real table layout mode, not a flex column: columns are shared across
		// rows, which a flex row per <tr> structurally cannot express.
		flexNode.setDisplay(Flex.DISPLAY_TABLE);
		flexNode.setBorderCollapse(
			computedStyle.computedValueOf("border-collapse") === "collapse",
		);

		// A table shrink-wraps to its content instead of filling its container.
		// Block layout here is a flex column with align-items: stretch, which would
		// otherwise stretch the table to the full terminal width, so opt it out --
		// unless the author aligned it themselves.
		if (computedStyle.computedValueOf("align-self") === "auto") {
			flexNode.setAlignSelf(Flex.ALIGN_FLEX_START);
		}
	} else if (display === "table-header-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_HEADER_GROUP);
	} else if (display === "table-footer-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_FOOTER_GROUP);
	} else if (display === "table-row-group") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_ROW_GROUP);
	} else if (display === "table-caption") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_CAPTION);
		// The caption's own content is laid out as a block.
		flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		flexNode.setAlignItems(Flex.ALIGN_STRETCH);
	} else if (display === "table-column" || display === "table-column-group") {
		// Columns carry style, not a box of their own.
		flexNode.setDisplay(Flex.DISPLAY_NONE);
	} else if (display === "table-row") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_ROW);
	} else if (display === "table-cell") {
		flexNode.setDisplay(Flex.DISPLAY_TABLE_CELL);
		flexNode.setColSpan(parseSpanAttribute(element, "colspan"));
		flexNode.setRowSpan(parseSpanAttribute(element, "rowspan"));
		// A cell establishes a block formatting context for its own content.
		flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		flexNode.setAlignItems(Flex.ALIGN_STRETCH);

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
		// Default block layout. Displays decided above (table parts, `none`)
		// must not be overwritten here. Resetting a table-caption to flex
		// leaves the table unable to find its own caption; resetting a
		// runtime-hidden element (DISPLAY_NONE, set a hundred lines up) back to
		// flex keeps its rows painting and pushes everything below it down.
		flexNode.setDisplay(Flex.DISPLAY_FLEX);
		flexNode.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
		flexNode.setAlignItems(Flex.ALIGN_STRETCH);
	}

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

		// Handle left positioning
		const left = parseUnitValue(computedStyle.computedValueOf("left"));
		if (typeof left === "number") {
			flexNode.setPosition(Flex.EDGE_LEFT, left);
		} else if (left && "percentage" in left) {
			flexNode.setPositionPercent(Flex.EDGE_LEFT, left.percentage);
		} else {
			const originalLeft = computedStyle.computedValueOf("left");
			if (originalLeft === "auto" || !originalLeft) {
				flexNode.setPositionAuto(Flex.EDGE_LEFT);
			}
		}

		// Handle top positioning
		const top = parseUnitValue(computedStyle.computedValueOf("top"));
		if (typeof top === "number") {
			flexNode.setPosition(Flex.EDGE_TOP, top);
		} else if (top && "percentage" in top) {
			flexNode.setPositionPercent(Flex.EDGE_TOP, top.percentage);
		} else {
			const originalTop = computedStyle.computedValueOf("top");
			if (originalTop === "auto" || !originalTop) {
				flexNode.setPositionAuto(Flex.EDGE_TOP);
			}
		}

		// Handle right positioning
		const right = parseUnitValue(computedStyle.computedValueOf("right"));
		if (typeof right === "number") {
			flexNode.setPosition(Flex.EDGE_RIGHT, right);
		} else if (right && "percentage" in right) {
			flexNode.setPositionPercent(Flex.EDGE_RIGHT, right.percentage);
		} else {
			const originalRight = computedStyle.computedValueOf("right");
			if (originalRight === "auto" || !originalRight) {
				flexNode.setPositionAuto(Flex.EDGE_RIGHT);
			}
		}

		// Handle bottom positioning
		const bottom = parseUnitValue(computedStyle.computedValueOf("bottom"));
		if (typeof bottom === "number") {
			flexNode.setPosition(Flex.EDGE_BOTTOM, bottom);
		} else if (bottom && "percentage" in bottom) {
			flexNode.setPositionPercent(Flex.EDGE_BOTTOM, bottom.percentage);
		} else {
			const originalBottom = computedStyle.computedValueOf("bottom");
			if (originalBottom === "auto" || !originalBottom) {
				flexNode.setPositionAuto(Flex.EDGE_BOTTOM);
			}
		}
	} else if (position === "relative") {
		flexNode.setPositionType(Flex.POSITION_TYPE_RELATIVE);
		// For relative positioning, also apply left/top/right/bottom offsets
		// (same pattern as absolute, but with relative position type)
		const left = parseUnitValue(computedStyle.computedValueOf("left"));
		if (typeof left === "number") {
			flexNode.setPosition(Flex.EDGE_LEFT, left);
		} else if (left && "percentage" in left) {
			flexNode.setPositionPercent(Flex.EDGE_LEFT, left.percentage);
		}

		const top = parseUnitValue(computedStyle.computedValueOf("top"));
		if (typeof top === "number") {
			flexNode.setPosition(Flex.EDGE_TOP, top);
		} else if (top && "percentage" in top) {
			flexNode.setPositionPercent(Flex.EDGE_TOP, top.percentage);
		}
	} else if (position === "fixed") {
		// In terminal context, fixed positioning is treated like absolute
		// positioning relative to the root element (the viewport).
		// The engine has no fixed position type, so we use absolute.
		flexNode.setPositionType(Flex.POSITION_TYPE_ABSOLUTE);

		const left = parseUnitValue(computedStyle.computedValueOf("left"));
		if (typeof left === "number") {
			flexNode.setPosition(Flex.EDGE_LEFT, left);
		} else if (left && "percentage" in left) {
			flexNode.setPositionPercent(Flex.EDGE_LEFT, left.percentage);
		}

		const top = parseUnitValue(computedStyle.computedValueOf("top"));
		if (typeof top === "number") {
			flexNode.setPosition(Flex.EDGE_TOP, top);
		} else if (top && "percentage" in top) {
			flexNode.setPositionPercent(Flex.EDGE_TOP, top.percentage);
		}

		const right = parseUnitValue(computedStyle.computedValueOf("right"));
		if (typeof right === "number") {
			flexNode.setPosition(Flex.EDGE_RIGHT, right);
		} else if (right && "percentage" in right) {
			flexNode.setPositionPercent(Flex.EDGE_RIGHT, right.percentage);
		}

		const bottom = parseUnitValue(computedStyle.computedValueOf("bottom"));
		if (typeof bottom === "number") {
			flexNode.setPosition(Flex.EDGE_BOTTOM, bottom);
		} else if (bottom && "percentage" in bottom) {
			flexNode.setPositionPercent(Flex.EDGE_BOTTOM, bottom.percentage);
		}
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
	}>;
	text: string;
}

interface BreakPoint {
	position: number;
	required: boolean;
}

export interface RectText {
	rect: DOMRect;
	text: string; // Processed text to render (replaces textLength)
}

const flexConfig = Flex.Config.create();
flexConfig.setPointScaleFactor(1.0);

/**
 * An anonymous box: one contiguous run of inline-level flow children of a
 * block container (CSS2 §9.2.1.1). The container owns it; it owns the layout
 * node that measures the run and the lines that measurement produced.
 *
 * `head` is whichever flow child opens the run at this moment, and nothing but
 * measurement hangs off it -- a run whose first node leaves the tree keeps its
 * box, its position among the container's boxes, and its break-result slot,
 * and re-measures from the node that now opens it.
 *
 * `styledFrom` is the element the flex node's own style came from, null while
 * a text node heads the run: an anonymous box has no style of its own, so a
 * run headed by an inline box takes that box's, exactly as its measurement
 * does.
 */
class InlineBox {
	head: Node;
	container: Element;
	flexNode: FlexTypes.Node | null = null;
	breakResult: BreakResult | null = null;
	styledFrom: Element | null = null;

	constructor(container: Element, head: Node) {
		this.container = container;
		this.head = head;
	}
}

/**
 * One entry of a block container's ordered box list: an anonymous box, or the
 * node of a box that belongs to a DOM node of its own (block-level children,
 * and the blockified element children of a flex container).
 */
type ContainerBox = Node | InlineBox;

// Symbol-keyed so the invalidation test can spy on it (a #private method's
// internal calls are invisible to a spy). Not on the public LayoutEngine type;
// index.ts does not re-export it.
const kInvalidateInlineRun = Symbol("invalidateInlineRun");
export {kInvalidateInlineRun};

export class LayoutEngine {
	declare DOMRect: typeof DOMRect;
	declare rootElement: Element;
	declare window: EngineWindow;

	declare terminalWidth: number;
	declare terminalHeight: number;

	// Viewport root node - represents terminal dimensions, no DOM element associated
	declare viewportRootNode: FlexTypes.Node;

	// Public Maps for debugging
	nodeMap: Map<Node, FlexTypes.Node>;
	breakResultMap: Map<Node, BreakResult>;

	// The reverse of nodeMap -- always kept in sync with it via #trackNode/
	// #untrackNode, never written directly elsewhere. Lets paint-time culling
	// go from a flex child (found by binary search over its parent's already-
	// ordered children[]) back to the DOM/pseudo-element node it needs to
	// paint, without re-deriving that order with a second full tree walk.
	#domNodeByFlexNode: Map<FlexTypes.Node, Node>;

	// Track nodes that were invalidated and need re-adding during calculateLayout
	#invalidatedNodes: Set<Node>;
	/**
	 * Every element whose computed position is not static, maintained by
	 * styleFlexNode. The paint side groups these under their stacking
	 * contexts each frame -- positioned boxes are rare, so per-frame work
	 * is O(positioned), never O(document).
	 */
	positionedElements = new Set<Element>();

	// Track layout nodes that have measure functions (for resize invalidation)
	#measureNodes: Set<FlexTypes.Node>;

	/**
	 * Inline boxes a block-level box broke apart, noted as the container
	 * enumerates its flow children through them. They paint boxes that live
	 * OUTSIDE their own layout subtree, so paint culling cannot trust their
	 * extents. Add-only and weak: an element that stops splitting merely stops
	 * being culled, which costs a walk, never a frame.
	 */
	#brokenInlines = new WeakSet<Element>();

	/**
	 * Set when the terminal answered that it reorders bidirectional text itself
	 * (see #negotiateBidi). Then lines stay in logical order: one reordering is
	 * correct, two is a sentence backwards again.
	 */
	#terminalReordersText = false;

	setTerminalReordersText(value: boolean): void {
		// Flips the visual order of every RTL run without a mutation.
		invalidateStructure();
		if (this.#terminalReordersText === value) return;
		this.#terminalReordersText = value;
		// Every cached line was built for the other contract.
		this.breakResultMap = new Map();
		for (const box of this.#inlineBoxes.values()) box.breakResult = null;
		for (const flexNode of this.#measureNodes) flexNode.markDirty();
	}

	/**
	 * Containers whose box list reaches through a broken inline, which is what
	 * makes their children[] stop corresponding to their childNodes. Add-only,
	 * like #brokenInlines: a container that stops holding split boxes only
	 * loses a paint fast path.
	 */
	#splitContainers = new WeakSet<Element>();

	/**
	 * Detached layout trees for inline-blocks that hold block-level content,
	 * both ways round (see #buildBlockContent). Strong maps, not weak: the
	 * reverse lookup runs per coordinate read, and `size` is what keeps that
	 * check free for every document that has none.
	 */
	#blockContentRoots = new Map<Element, FlexTypes.Node>();
	#blockContentHosts = new Map<FlexTypes.Node, Element>();

	constructor(window: EngineWindow) {
		this.window = window;
		this.DOMRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new Map<Node, FlexTypes.Node>();
		this.breakResultMap = new Map<Node, BreakResult>();
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

		// Clear all cached break results so text re-wraps at new width
		this.breakResultMap.clear();
		for (const box of this.#inlineBoxes.values()) box.breakResult = null;

		// Mark all leaf nodes (those with measure functions) as dirty
		// so the engine re-invokes their measure functions with the new available width
		for (const flexNode of this.#measureNodes) {
			flexNode.markDirty();
		}

		// Force recalculation of all layout after size change
		this.calculateLayout();
	}

	calculateLayout() {
		// The DOM may have changed since the last pass without an invalidate()
		// (callers may mutate and then call this directly, with no observer in
		// between), and run heads must reflect the tree as it stands NOW. One
		// bump serves the whole pass: entries memoized during it stay warm --
		// the O(N^2) this cache exists for is intra-pass -- and the pass's
		// entries remain valid afterward for paint and hit-testing, until the
		// next mutation or pass.
		this.#boxEpoch++;
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
				let parent = compositionBoxParentElement(node);
				while (parent) {
					const parentFlexNode = this.nodeMap.get(parent);
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
					if (this.#isInlineLevel(parent) && !this.#brokenInlines.has(parent)) {
						break;
					}
					parent = compositionBoxParentElement(parent);
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
		// Composition-connected, not isConnected: a UA shadow tree's nodes
		// live in a fragment and are never DOM-connected, but ones with
		// layout presence (a hoisted picker part) render like anything else
		// -- the prune sweep must not reap them every frame.
		if (compositionIsConnected(node)) return true;
		const pseudoMetadata = getPseudoMetadata(node);
		return Boolean(pseudoMetadata?.hostElement.isConnected);
	}

	#pruneDisconnectedNodes(): void {
		// A box outlives the nodes that pass through it, but not its container.
		for (const box of [...this.#inlineBoxes.values()]) {
			if (!this.#isNodeLive(box.container)) this.#retireInlineBox(box);
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
			this.breakResultMap.delete(node);
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
		this.breakResultMap = new Map();
		this.#domNodeByFlexNode = new Map();
		this.#invalidatedNodes = new Set();
		this.#measureNodes = new Set();
		this.#inlineBoxes = new Map();
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
	 * True when nothing in the element's subtree can paint inside the document
	 * rows [top, bottom) -- its cached paint extent (own box unioned with every
	 * descendant's, absolutes included) lies entirely outside the band.
	 *
	 * Conservative: an element without its own layout node is never culled, and
	 * a stale answer is impossible because extents are recomputed with layout
	 * and layout is recomputed whenever the tree is dirty.
	 */
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
		return !this.#brokenInlines.has(element);
	}

	/**
	 * The direct DOM/pseudo-element children of `element` whose paint extent
	 * could intersect document rows [top, bottom), in document order -- found
	 * with a binary search instead of visiting every child, which is what let
	 * paint-time culling of a long list cost O(total children) per frame
	 * instead of O(visible children). Returns null when that search can't be
	 * trusted: children[] is only guaranteed sorted top-to-bottom by extentTop
	 * when the container stacks its children vertically in document order
	 * (flex-direction: column -- block flow's internal representation here,
	 * see styleFlexNode) and none of them is position:relative/absolute
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
			flexNode.getFlexDirection() !== Flex.FLEX_DIRECTION_COLUMN ||
			// A non-run-head member of an inline run (a plain <span> inside
			// running text, but also -- unlike that span -- an inline-block
			// sibling, which paints its own box independently rather than
			// through the run head's text) never gets its own flex node either;
			// it's counted zero times here despite being a real DOM child. Cheap
			// proxy for "every DOM child has exactly one children[] entry,"
			// without walking to find out: pseudo-elements/shadow content
			// widen this the other way (present in children[], absent from
			// childNodes), so it's an equality check, not just child count.
			element.childNodes.length !== flexNode.children.length ||
			// A shadow host's childNodes are its LIGHT children, unrelated to
			// the composed children the layout tree holds -- the counts can
			// collide by accident (1 light child, 1 run head) and the fast
			// path then paints an incomplete child list. Hosts always take the
			// walker.
			compositionShadowRoot(element) !== null ||
			// So can a container that a broken inline handed boxes to: those
			// boxes are children[] entries whose DOM node lives a level DOWN,
			// while this element's own later children own no entry at all.
			// `<span>a<div/><span>c</span></span>d<input>` collides at three
			// and three, and the fast path painted the fragments while
			// dropping the text and the input after them.
			this.#splitContainers.has(element)
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
		// parked at 0,0, which is what an inline-block'd widget used to
		// position itself by.
		let runHead: Node | null = this.findInlineRunHead(element);
		let runFlexNode = runHead ? this.#runFlexNode(runHead) : undefined;
		let breakResult = runHead ? this.#runBreakResult(runHead) : undefined;
		while (runHead && !(runFlexNode && breakResult)) {
			const parent = compositionBoxParentElement(runHead);
			if (!parent) return null;
			runHead = this.findInlineRunHead(parent) ?? parent;
			runFlexNode = this.#runFlexNode(runHead);
			breakResult = this.#runBreakResult(runHead);
		}
		if (!runHead || !runFlexNode || !breakResult) return null;

		const runPosition = this.#absolutePosition(runFlexNode);
		// The run may itself live in an inline-block's detached content tree,
		// where positions start at that box's content edge rather than the
		// document's origin.
		const runOffset = this.#contentRootOffset(runFlexNode);
		let originX = runPosition.x + runOffset.x;
		let originY = runPosition.y + runOffset.y;

		// Outermost-first, so each hop's offsets are expressed in the frame the
		// previous hop just established. The run head itself is IN the chain
		// when it is an inline-block: it heads the run its own box sits in, and
		// the content it wraps lives one break result further down.
		const enclosing: Element[] = [];
		for (
			let ancestor = compositionParentElement(element);
			ancestor;
			ancestor = compositionParentElement(ancestor)
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
			const {x, y} = this.#absolutePosition(ownFlexNode);
			const offset = this.#contentRootOffset(ownFlexNode);
			return new this.DOMRect(
				x + offset.x,
				y + offset.y,
				target.segment.width,
				target.line.height,
			);
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

	getRect(element: Element): DOMRect | null {
		const display = getPropertyValue(element, "display");

		// A blockified box's box is the one the layout tree sized, not the
		// extent of the text it happens to hold: its layout node is the truth,
		// and the run machinery below would report the text union instead. Two
		// kinds blockify (css-display-3 §2.7): a flex container's children, and
		// an out-of-flow box, which no run holds any record of at all.
		const isBlockified =
			(display === "inline" || display === "inline-block") &&
			this.nodeMap.has(element) &&
			(this.#isOutOfFlow(element) ||
				(element.parentElement !== null &&
					getPropertyValue(element.parentElement, "display") === "flex"));

		// For inline/inline-block elements, check if they appear in breakResults
		if (!isBlockified && (display === "inline" || display === "inline-block")) {
			// For inline-block elements, search through all breakResults to find this element
			if (display === "inline-block") {
				const rect = this.#inlineBlockRect(element);
				if (rect) {
					return rect;
				}
			}

			// For inline elements, use getRectTexts
			const rectTexts = this.getRectTexts(element);
			if (rectTexts.length > 0) {
				// Calculate bounding box from all rectTexts
				let minX = Infinity;
				let minY = Infinity;
				let maxX = -Infinity;
				let maxY = -Infinity;

				for (const rectText of rectTexts) {
					const rect = rectText.rect;
					minX = Math.min(minX, rect.x);
					minY = Math.min(minY, rect.y);
					maxX = Math.max(maxX, rect.x + rect.width);
					maxY = Math.max(maxY, rect.y + rect.height);
				}

				return new this.DOMRect(minX, minY, maxX - minX, maxY - minY);
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

		const {x, y} = this.#absolutePosition(flexNode);
		// Zero unless this box lives in an inline-block's detached tree, where
		// positions are relative to a box the RUN placed.
		const offset = this.#contentRootOffset(flexNode);

		return new this.DOMRect(
			x + offset.x,
			y + offset.y,
			flexNode.getComputedWidth(),
			flexNode.getComputedHeight(),
		);
	}

	getRectTexts(node: Node): RectText[] {
		// This method handles two main scenarios:
		// 1. Direct calls on inline-block elements (special case below)
		// 2. Calls on elements/text inside inline-blocks (general walk-up logic)

		// Handle element nodes
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");

			// For block elements, return empty array (no inline text layout)
			if (display !== "inline" && display !== "inline-block") {
				return [];
			}

			// Special case: inline-block element called directly (e.g., getRectTexts(inlineBlockDiv))
			// The element's breakResult contains itself as an inline-block segment with nested content
			if (display === "inline-block" && this.isInlineRunHead(element)) {
				const breakResult = this.#runBreakResult(element);
				if (breakResult) {
					// The breakResult contains this inline-block as a segment with nested content
					const rectTexts: RectText[] = [];
					const flexNode = this.#runFlexNode(element);
					if (!flexNode) return [];

					const position = this.#absolutePosition(flexNode);
					const offset = this.#contentRootOffset(flexNode);
					const containerX = position.x + offset.x;
					const containerY = position.y + offset.y;

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

		let {x: containerX, y: containerY} = this.#absolutePosition(flexNode);
		// A run inside an inline-block's detached tree is positioned relative to
		// that box, which only the run that placed it can locate.
		const contentOffset = this.#contentRootOffset(flexNode);
		containerX += contentOffset.x;
		containerY += contentOffset.y;

		// getAbsolutePosition gives the run head's BORDER box. A blockified
		// inline flex item reserved its own padding and border in that box (see
		// styleFlexNode's parentIsFlex exception) but its text ignored them,
		// painting at the border edge instead of below the padding. Push the run
		// in by that box. Scoped to exactly the blockified case: a normal inline
		// has its flex-node box model cleared even when the author declared
		// padding (so getBoxModel would over-report), an inline-block's content
		// offset is already handled by #contentRootOffset above, and a block's
		// run head is a text node with no box.
		if (runHead.nodeType === runHead.ELEMENT_NODE) {
			const runHeadElement = runHead as Element;
			const parent = runHeadElement.parentElement;
			if (
				getPropertyValue(runHeadElement, "display") === "inline" &&
				parent !== null &&
				getPropertyValue(parent, "display") === "flex"
			) {
				const runHeadBox = getBoxModel(runHeadElement);
				containerX += runHeadBox.paddingLeft + runHeadBox.borderLeftWidth;
				containerY += runHeadBox.paddingTop + runHeadBox.borderTopWidth;
			}
		}

		// Walk from target node up to runHead, handling nested inline-blocks
		// This handles the case where getRectTexts is called on elements/text inside inline-blocks
		let currentBreakResult = breakResult;
		let accumulatedOffsetX = 0;
		let accumulatedOffsetY = 0;
		let currentNode = node;
		// The element whose text-align governs this breakResult's lines -- the
		// block container normally, but an inline-block's own style once the walk
		// below descends into its nested breakResult, since that's a fresh inline
		// formatting context with its own alignment.
		let alignContainer: Element | null = compositionParentElement(runHead);

		// COMPOSITION parents: a widget's UA shadow text has no parentElement
		// chain to its host at all, so a parentElement walk dies at the shadow
		// boundary and the value resolves to zero fragments.
		while (currentNode !== runHead && compositionParentElement(currentNode)) {
			const parent = compositionParentElement(currentNode)!;

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
					: compositionParentElement(node);
			ancestor && ancestor !== runHead && !this.nodeMap.has(ancestor);
			ancestor = compositionParentElement(ancestor)
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

			// Use ExpandedTreeWalker for traversal
			const walker = createExpandedTreeWalker(this.window, node);

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
		const byLine = new Map<
			number,
			Array<{x: number; width: number; text: string; ord: number}>
		>();
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
			});
		}

		return rectTexts;
	}

	// Text-fragment index per break result: text node -> the fragments the
	// breaker placed for it, each with its OUTER line index, x offset (nested
	// inline-block content already shifted by its box's position and padding,
	// as the merge in getRectTexts expects), width, processed text, and a
	// global ordinal preserving segment order. WeakMap-keyed on the break
	// result object: re-breaking builds a fresh object, so entries can never
	// go stale.
	#rectTextIndices = new WeakMap<
		object,
		Map<
			Text,
			Array<{line: number; x: number; width: number; text: string; ord: number}>
		>
	>();

	#breakResultTextIndex(
		breakResult: BreakResult,
	): Map<
		Text,
		Array<{line: number; x: number; width: number; text: string; ord: number}>
	> {
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
			const display = getPropertyValue(element, "display");

			if (display !== "inline") {
				const rect = this.getRect(element);
				return rect ? [rect] : [];
			}
		}

		// Inline content is one rect per text run, one per line it spans.
		return this.getRectTexts(node).map((rectText) => rectText.rect);
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
	 * Two offset regimes, matched to the two callers. The caret path walks line
	 * fragments annotated with their data range (a pre-wrap field value, blank
	 * lines and all -- 1:1 offset<->column), so a caret lands on the right line
	 * including empty ones. The selection path bridges each painted column back
	 * to a data offset through visualToDataOffsets, so it stays correct over
	 * collapsing whitespace, where column and offset diverge.
	 */
	getRangeRects(range: Range): globalThis.DOMRect[] {
		const rects: globalThis.DOMRect[] = [];
		for (const textNode of this.#rangeTextNodes(range)) {
			const from = range.startContainer === textNode ? range.startOffset : 0;
			const to =
				range.endContainer === textNode
					? range.endOffset
					: textNode.data.length;
			if (range.collapsed) {
				const caret = this.#caretRect(textNode, from);
				if (caret) rects.push(caret);
			} else if (to > from) {
				for (const run of this.#selectionRuns(textNode, from, to)) {
					rects.push(run.rect);
				}
			}
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
	 * Each laid-out line of a text node, annotated with the data range it spans.
	 * A blank line between two newlines owns a real but EMPTY layout fragment
	 * with no columns to place an offset by, so its offset is carried forward
	 * through the hard separators the previous line's characters did not consume
	 * -- the same accounting a caret in an empty line depends on.
	 *
	 * The one place a text node's laid-out lines get their data ranges, shared by
	 * range geometry here and the textarea's own visual-line navigation.
	 */
	lineFragments(textNode: Text): Array<{
		x: number;
		y: number;
		height: number;
		text: string;
		startOffset: number;
		endOffset: number;
	}> {
		const data = textNode.data;
		const rectTexts = this.getRectTexts(textNode);
		const visToData = visualToDataOffsets(data, rectTexts);
		const lines = [];
		let visualBase = 0;
		let cursor = 0;
		for (const rectText of rectTexts) {
			const length = rectText.text.length;
			const startOffset = length > 0 ? visToData[visualBase] : cursor;
			const endOffset =
				length > 0 ? visToData[visualBase + length - 1] + 1 : startOffset;
			lines.push({
				x: Math.round(rectText.rect.x),
				y: Math.round(rectText.rect.y),
				height: rectText.rect.height,
				text: rectText.text,
				startOffset,
				endOffset,
			});
			visualBase += length;
			cursor =
				endOffset < data.length && data[endOffset] === "\n"
					? endOffset + 1
					: endOffset;
		}
		// A value ending in a newline has an empty last line no fragment
		// represents -- the caret's row after a final Enter. It sits one line
		// below the last, at the same left edge.
		if (lines.length > 0 && data.endsWith("\n")) {
			const last = lines[lines.length - 1];
			lines.push({
				x: last.x,
				y: last.y + last.height,
				height: last.height,
				text: "",
				startOffset: data.length,
				endOffset: data.length,
			});
		}
		// Empty text has no fragment at all, so its one line sits at the
		// containing block's content-box origin -- where a caret rests in an
		// empty field. Derived from the block itself, not any widget.
		if (lines.length === 0) {
			const parent = textNode.parentElement;
			const rect = parent && this.getRect(parent);
			if (rect && parent) {
				const box = getBoxModel(parent);
				lines.push({
					x:
						Math.round(rect.x) +
						(box.borderLeftWidth || 0) +
						(box.paddingLeft || 0),
					y:
						Math.round(rect.y) +
						(box.borderTopWidth || 0) +
						(box.paddingTop || 0),
					height: rect.height || 1,
					text: "",
					startOffset: 0,
					endOffset: 0,
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
		const within = Math.max(
			0,
			Math.min(offset, line.endOffset) - line.startOffset,
		);
		const x = line.x + runtimeStringWidth(line.text.slice(0, within));
		return this.createDOMRect(x, line.y, 0, line.height);
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
		const rectTexts = this.getRectTexts(textNode);
		if (rectTexts.length === 0) return runs;
		const visToData = visualToDataOffsets(textNode.data, rectTexts);
		let visualBase = 0;
		for (const rectText of rectTexts) {
			let runStart = -1;
			for (let i = 0; i <= rectText.text.length; i++) {
				const dataOffset =
					i < rectText.text.length ? visToData[visualBase + i] : -1;
				const selected = dataOffset >= from && dataOffset < to;
				if (selected && runStart === -1) {
					runStart = i;
				} else if (!selected && runStart !== -1) {
					const x =
						Math.round(rectText.rect.x) +
						runtimeStringWidth(rectText.text.slice(0, runStart));
					const width = runtimeStringWidth(rectText.text.slice(runStart, i));
					runs.push({
						rect: this.createDOMRect(
							x,
							Math.round(rectText.rect.y),
							width,
							rectText.rect.height,
						),
						text: rectText.text.slice(runStart, i),
					});
					runStart = -1;
				}
			}
			visualBase += rectText.text.length;
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
		return (
			isPositioned(this.window, element) &&
			zIndexValueOf(this.window, element) !== "auto"
		);
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
			if (!isPositioned(this.window, element)) continue; // stale registry entry
			let root: Element = body;
			for (
				let ancestor = compositionParentElement(element);
				ancestor;
				ancestor = compositionParentElement(ancestor)
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
			const z = zIndexValueOf(this.window, element);
			if (z === "auto" || z === 0) bucket.zero.push(element);
			else if (z < 0) bucket.neg.push(element);
			else bucket.pos.push(element);
		}
		const treeOrder = (a: Element, b: Element) =>
			a.compareDocumentPosition(b) & 4 ? -1 : 1; // 4: b follows a
		for (const bucket of layers.values()) {
			const byZ = (a: Element, b: Element) => {
				const za = zIndexValueOf(this.window, a) as number;
				const zb = zIndexValueOf(this.window, b) as number;
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
		const paintRoot = root === document.documentElement ? document.body : root;
		for (const element of [...topLayer].reverse()) {
			if (!compositionIsConnected(element)) continue;
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
			const probeY = this.#inFixedSpace(element) ? y - cameraScrollTop : y;
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
		try {
			const rects = this.getRects(element);
			if (!isPointInRects(x, y, rects)) return null;
		} catch {
			return null;
		}
		const children: Element[] = [];
		const walker = createExpandedTreeWalker(this.window, element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (child.nodeType !== 1) continue;
			if (isPositioned(this.window, child as Element)) continue;
			children.push(child as Element);
		}
		for (let i = children.length - 1; i >= 0; i--) {
			const hit = this.#hitTestInFlow(children[i], x, y);
			if (hit) return hit;
		}
		return element;
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
	 * The enumeration is what every membership question reads: `heads` maps each
	 * flow child (and, through the walk in #boxEntryOf, everything nested inside
	 * one) to the box it falls under, so membership is a parent-side lookup
	 * rather than a walk backward through siblings -- a run of N boxes costs one
	 * enumeration, not N of them. `boxes` is the same enumeration read as the
	 * container's ordered child list, which is what places a box among its
	 * siblings.
	 *
	 * Elements that generate no box in the flow (display:none, out of flow) take
	 * no run position: they neither open nor close a run, and map to whichever
	 * box is open around them so that content nested inside them still resolves.
	 *
	 * The epoch stamps the enumeration as derived data, dropped whenever the
	 * tree or the cascade under it may have moved. The boxes themselves outlive
	 * it: a rebuild reconciles against the entry it replaces.
	 */
	#boxesByContainer = new WeakMap<
		Element,
		{
			epoch: number;
			heads: Map<Node, ContainerBox>;
			boxes: ContainerBox[];
			runs: InlineBox[];
		}
	>();
	#boxEpoch = 0;

	/**
	 * A counter that moves whenever geometry could have: every layout pass and
	 * every invalidation bumps it, and so does every cascade invalidation --
	 * a style written and then measured has moved geometry the engine has not
	 * been told about yet, and a counter that stood still there would hand the
	 * reader the layout standing behind the write. A resolved value memoizes
	 * against it, the way a rect read does.
	 */
	get layoutEpoch(): number {
		return currentInvalidationEpoch() + this.#boxEpoch;
	}

	/**
	 * Every live anonymous box, by the layout node it owns: the reverse of
	 * InlineBox.flexNode, and the registry the sweeps that must reach every box
	 * (resize, pruning, disposal) walk. Strong, because a container's
	 * enumeration is dropped whenever the tree moves under it and the boxes it
	 * held must still be retired.
	 */
	#inlineBoxes = new Map<FlexTypes.Node, InlineBox>();

	/**
	 * Containers whose box list may no longer match their layout children.
	 * Reconciled once per pass, in calculateLayout, however many mutations
	 * dirtied them.
	 */
	#dirtyRunContainers = new Set<Element>();

	#containerBoxes(container: Element): {
		heads: Map<Node, ContainerBox>;
		boxes: ContainerBox[];
		runs: InlineBox[];
	} {
		const cached = this.#boxesByContainer.get(container);
		const epoch = currentInvalidationEpoch() + this.#boxEpoch;
		if (cached && cached.epoch === epoch) return cached;

		const heads = new Map<Node, ContainerBox>();
		const boxes: ContainerBox[] = [];
		// Anonymous boxes are matched to the previous enumeration's by their
		// ordinal among the container's runs, which is the identity a run has:
		// the third run of a paragraph stays the third run when its first node
		// is deleted, when its text changes, when a member is inserted. Only a
		// change to the NUMBER of runs -- a block-level box splitting one in
		// two, or leaving and merging two into one -- creates or retires a box.
		const previous = cached ? cached.runs : [];
		const runs: InlineBox[] = [];
		// A flex container puts every element child in a box of its own and
		// gathers only its contiguous text into anonymous ones.
		const inFlex = getPropertyValue(container, "display") === "flex";
		let run: InlineBox | null = null;
		for (const child of this.#flowChildren(container)) {
			if (child.nodeType === child.ELEMENT_NODE) {
				const element = child as Element;
				const display = getPropertyValue(element, "display");
				const inlineLevel = display === "inline" || display === "inline-block";
				if (display === "none" || this.#isOutOfFlow(element)) {
					heads.set(child, run ?? child);
					// A hidden block still holds a box slot; an out-of-flow one
					// hangs from its containing block, and an inline that left the
					// flow was never a box of this container's to begin with.
					if (!inlineLevel) boxes.push(child);
					continue;
				}
				if (!inlineLevel) {
					run = null; // block-level box: the run ends here
					boxes.push(child);
					continue;
				}
				if (inFlex) {
					// Blockified (css-display-3 §2.7): the element's box is its
					// own, not an anonymous one gathered around it.
					heads.set(child, child);
					boxes.push(child);
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
				run = previous[runs.length] ?? new InlineBox(container, child);
				run.head = child;
				runs.push(run);
				boxes.push(run);
			}
			heads.set(child, run);
		}

		// Runs the container no longer has: their content merged into a
		// neighbour's box or left the tree entirely.
		for (let i = runs.length; i < previous.length; i++) {
			this.#retireInlineBox(previous[i]);
		}

		const entry = {epoch, heads, boxes, runs};
		this.#boxesByContainer.set(container, entry);
		return entry;
	}

	/** Free an anonymous box's layout node and forget the box. */
	#retireInlineBox(box: InlineBox): void {
		const flexNode = box.flexNode;
		box.flexNode = null;
		box.breakResult = null;
		if (!flexNode) return;
		flexNode.getParent()?.removeChild(flexNode);
		this.#measureNodes.delete(flexNode);
		this.#inlineBoxes.delete(flexNode);
		this.#domNodeByFlexNode.delete(flexNode);
		flexNode.freeRecursive();
	}

	/** The anonymous box a node's content is laid out in, if it is in one. */
	#boxOf(node: Node): InlineBox | null {
		const entry = this.#boxEntryOf(node);
		return entry instanceof InlineBox ? entry : null;
	}

	/** The container box entry a node's content falls under. */
	#boxEntryOf(node: Node): ContainerBox | null {
		if (!compositionIsConnected(node)) {
			const pseudoMetadata = getPseudoMetadata(node);
			if (!pseudoMetadata || !pseudoMetadata.hostElement.isConnected) {
				return null;
			}
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			// An out-of-flow element is never a run head or run member -- it
			// left the flow entirely. Letting run invalidation "ensure" it a
			// bare layout node makes later rebuilds skip its full build, so its
			// pseudo-only content vanishes on a runtime class flip.
			if (this.#isOutOfFlow(element)) return null;
			const display = getPropertyValue(element, "display");
			if (display !== "inline" && display !== "inline-block") return null;
		} else if (node.nodeType !== node.TEXT_NODE) {
			return null;
		}

		const container = this.#runContainerOf(node);
		if (!container) return node;
		const {heads} = this.#containerBoxes(container);
		// Up from the node to whichever of its ancestors the container counts
		// among its own flow children: that is the box the content falls under.
		for (let current: Node = node; current !== container; ) {
			const entry = heads.get(current);
			if (entry) return entry;
			const parent = this.#boxParentOf(current);
			if (!parent) return current;
			current = parent;
		}
		return node;
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
			return box.head === node ? (box.breakResult ?? undefined) : undefined;
		}
		return this.breakResultMap.get(node);
	}

	/**
	 * Apply an element's style to the layout node that carries its box, and
	 * keep the one thing that style alone cannot answer wired up: an
	 * out-of-flow box is placed by its containing block, which asks the flow
	 * the box left where it would have been. Nothing in flow is ever asked, so
	 * nothing in flow carries the question.
	 */
	#styleNode(element: Element, flexNode: FlexTypes.Node): void {
		styleFlexNode(element, flexNode, this.positionedElements);
		if (this.#isOutOfFlow(element)) {
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
		const containerNode =
			this.#blockContentRoots.get(container) ?? this.nodeMap.get(container);
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

		const {boxes, heads} = this.#containerBoxes(container);
		let entry: ContainerBox | null = null;
		for (let current: Node = element; current !== container; ) {
			const found = heads.get(current);
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
		if (entry instanceof InlineBox) {
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
		const index = boxes.indexOf(entry ?? element);
		for (let i = index - 1; i >= 0; i--) {
			const previous = boxes[i];
			const previousNode =
				previous instanceof InlineBox
					? previous.flexNode
					: (this.nodeMap.get(previous) ?? null);
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
	#inlineCursorBefore(
		run: InlineBox,
		element: Element,
	): {x: number; y: number} {
		const breakResult = run.breakResult;
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
		const containerFlexNode =
			this.#blockContentRoots.get(container) ?? this.nodeMap.get(container);
		// No layout node, a node that measures its content as one opaque unit,
		// or a subtree display:none removed from layout: nothing here lays out
		// boxes of its own.
		if (!containerFlexNode || containerFlexNode.measureFunc) return;
		if (
			getPropertyValue(container, "display") === "none" ||
			this.#hiddenByAncestor(container)
		) {
			return;
		}

		const {boxes} = this.#containerBoxes(container);
		let index = 0;
		for (const entry of boxes) {
			if (entry instanceof InlineBox) {
				let flexNode = entry.flexNode;
				const styledFrom =
					entry.head.nodeType === entry.head.ELEMENT_NODE
						? (entry.head as Element)
						: null;
				// The head decides the box's own flex styles (an anonymous box has
				// none), so a run that changes hands starts from a fresh node
				// rather than wearing the last head's margins and flex factors.
				if (flexNode && entry.styledFrom !== styledFrom) {
					this.#retireInlineBox(entry);
					flexNode = null;
				}
				if (!flexNode) {
					flexNode = Flex.Node.createWithConfig(flexConfig);
					entry.flexNode = flexNode;
					entry.styledFrom = styledFrom;
					if (styledFrom) {
						styleFlexNode(styledFrom, flexNode, this.positionedElements);
					}
					flexNode.setMeasureFunc((width, widthMode, height, heightMode) =>
						this.#measureInlineRun(entry, width, widthMode, height, heightMode),
					);
					this.#measureNodes.add(flexNode);
					this.#inlineBoxes.set(flexNode, entry);
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
			if (!this.#isOutOfFlow(entry)) {
				const existing = this.nodeMap.get(entry);
				if (!existing || existing.getParent() !== containerFlexNode) {
					this.#addNode(entry, containerFlexNode);
				}
			}
			const flexNode = this.nodeMap.get(entry);
			if (flexNode && flexNode.getParent() === containerFlexNode) index++;
		}
	}

	/** The flat-tree parent that can hold a box, pseudo-elements included. */
	#boxParentOf(node: Node): Element | null {
		const pseudoMetadata = getPseudoMetadata(node);
		if (pseudoMetadata) return pseudoMetadata.hostElement;
		return compositionBoxParentElement(node);
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
		const startsOwnRun =
			node.nodeType === node.ELEMENT_NODE &&
			getPropertyValue(node as Element, "display") !== "inline";
		for (let current: Node = node; ; ) {
			const parent = this.#boxParentOf(current);
			if (!parent) return null;
			if (this.#isOutOfFlow(parent)) return parent;
			const display = getPropertyValue(parent, "display");
			if (display === "inline") {
				current = parent;
				continue;
			}
			if (display === "inline-block") {
				// A box with a layout tree of its own establishes a block
				// container; and an inline-block nested in one starts a run
				// there rather than joining the run its host sits in.
				if (this.#blockContentRoots.has(parent) || startsOwnRun) return parent;
				current = parent;
				continue;
			}
			return parent;
		}
	}

	/** The node an inline-level node's box is measured from. */
	findInlineRunHead(node: Node): Node | null {
		const entry = this.#boxEntryOf(node);
		if (!entry) return null;
		return entry instanceof InlineBox ? entry.head : entry;
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
		// Run membership may have moved (the invalidated node could be, or
		// displace, a run head); drop every enumerated container. Once for the
		// whole subtree below: invalidation rearranges layout nodes, never the
		// DOM or the cascade the enumeration reads.
		this.#boxEpoch++;
		this.#invalidateNode(node);
	}

	#invalidateNode(node: Node): void {
		// Track this node for re-adding during calculateLayout
		this.#invalidatedNodes.add(node);

		// If it's an inline-level node, invalidate the entire run
		if (this.#isInlineLevel(node)) {
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
		const walker = createExpandedTreeWalker(this.window, element);
		let child = walker.firstChild();

		while (child) {
			this.#invalidateNode(child);
			child = walker.nextSibling();
		}
	}

	#clearBreakResultCache(node: Node): void {
		const entry = this.#boxEntryOf(node);
		if (entry instanceof InlineBox) {
			this.#invalidateBox(entry);
		} else if (entry) {
			this.breakResultMap.delete(entry);
			// Dirty the measure that refills it, always: a clean node keeps its
			// cached height, so the run lays out at its old size and then paints
			// nothing, having no break result left to paint FROM.
			this.#markRunMeasureDirty(entry);
		}
	}

	/**
	 * Drop an anonymous box's lines and dirty the measure that refills them --
	 * including, when the box sits in an inline-block's detached tree, the box
	 * whose measure is the only thing that ever lays that tree out.
	 */
	#invalidateBox(box: InlineBox): void {
		box.breakResult = null;
		const flexNode = box.flexNode;
		if (!flexNode) return;
		flexNode.markDirty();
		const host = this.#hostOfContentRoot(flexNode);
		if (host) this.#invalidateEnclosingMeasure(host);
	}

	/**
	 * Drop the lines of every box a container lays out, not just the one that
	 * changed: `text<div/><input>` puts the leading text and the input in
	 * SEPARATE boxes, and what reshapes one commonly reshapes the other. A
	 * cleared result whose flex node is still clean is never recomputed, so
	 * such a box measures, lays out at the right rect, and paints nothing.
	 */
	#invalidateContainerBoxes(container: Element): void {
		for (const entry of this.#containerBoxes(container).boxes) {
			if (entry instanceof InlineBox) {
				this.#invalidateBox(entry);
			} else if (this.breakResultMap.has(entry)) {
				this.breakResultMap.delete(entry);
				this.#markRunMeasureDirty(entry);
			}
		}
	}

	/**
	 * Find the container element that holds the inline run containing the given node
	 */
	#findInlineRunContainer(node: Node): Element | null {
		let current =
			node.nodeType === node.ELEMENT_NODE
				? (node as Element)
				: node.parentElement;

		while (current) {
			const display = getPropertyValue(current, "display");
			// Stop at block-level containers that can contain inline runs
			if (display !== "inline" && display !== "inline-block") {
				return current;
			}
			current = current.parentElement;
		}

		return null;
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
		const entry = this.#boxEntryOf(node);
		if (entry instanceof InlineBox) {
			if (entry.flexNode) {
				this.#invalidateBox(entry);
				return;
			}
			entry.breakResult = null;
		} else if (entry) {
			this.breakResultMap.delete(entry);
			const headFlexNode = this.nodeMap.get(entry);
			if (headFlexNode && headFlexNode.measureFunc) {
				headFlexNode.markDirty();
				// Keep climbing out of any detached content tree this run sits
				// in: only the box that owns the tree can run it again.
				const host = this.#hostOfContentRoot(headFlexNode);
				if (host) this.#invalidateEnclosingMeasure(host);
				return;
			}
		}
		let current = compositionBoxParentElement(node);
		while (current) {
			const flexNode = this.nodeMap.get(current);
			if (flexNode) {
				this.breakResultMap.delete(current);
				if (flexNode.measureFunc) {
					flexNode.markDirty();
				}
				const host = this.#hostOfContentRoot(flexNode);
				if (host) this.#invalidateEnclosingMeasure(host);
				return;
			}
			current = compositionBoxParentElement(current);
		}
	}

	[kInvalidateInlineRun](node: Node): void {
		const entry = this.#boxEntryOf(node);
		if (!entry) return;
		if (entry instanceof InlineBox) {
			this.#invalidateContainerBoxes(entry.container);
			this.#dirtyRunContainers.add(entry.container);
			// Content an anonymous box lays out owns no layout node of its own.
			// One left over from an earlier shape of the container measures the
			// same content a second time, in a box the container no longer has.
			const stale = this.nodeMap.get(node);
			if (stale) {
				stale.getParent()?.removeChild(stale);
				this.#measureNodes.delete(stale);
				stale.freeRecursive();
				this.#untrackNode(node);
			}
			return;
		}
		// A box of the element's own (a flex container blockifies its inline
		// children) measures only itself.
		const container = this.#runContainerOf(entry);
		if (container) this.#invalidateContainerBoxes(container);
		this.breakResultMap.delete(entry);
		this.nodeMap.get(entry)?.markDirty();
	}

	#isInlineLevel(node: Node): boolean {
		if (node.nodeType === node.TEXT_NODE) {
			// Regular text nodes and pseudo-element text nodes are inline-level
			return true;
		}

		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getPropertyValue(element, "display");
			if (display !== "inline" && display !== "inline-block") return false;
			// A flex item is BLOCKIFIED (css-display-3 §2.7): an inline child of
			// a flex container is not inline-level -- it takes a block's box
			// model (its own padding, its width/height) instead of being folded
			// into an inline run that drops them. Mirrors styleFlexNode's
			// blockify. inline-block already carries its padding, so leaving it
			// inline-level here keeps its existing (correct) layout path.
			if (
				display === "inline" &&
				element.parentElement !== null &&
				getPropertyValue(element.parentElement, "display") === "flex"
			) {
				return false;
			}
			return true;
		}

		return false;
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

		// Check parent's display type - only collapse in block formatting contexts
		const parentDisplay = getPropertyValue(parent, "display");
		if (parentDisplay === "inline" || parentDisplay === "inline-block") {
			// In inline contexts, preserve whitespace as spaces
			return false;
		}

		// Check if this whitespace is between block-level elements
		const prevSibling = textNode.previousSibling;
		const nextSibling = textNode.nextSibling;

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
		this.#handleMutationRecords(mutations);
	}

	#handleMutationRecords(mutations: MutationRecord[]): void {
		for (let i = 0; i < mutations.length; i++) {
			const record = mutations[i];
			if (record.type === "attributes") {
				if (record.attributeName === "style") {
					const element = record.target as Element;
					const flexNode = this.nodeMap.get(element);
					if (flexNode) {
						this.#styleNode(element, flexNode);
						// Invalidate inline runs if style changes might affect layout
						this[kInvalidateInlineRun](element);
					} else {
						// No flex node: an inline run MEMBER (or a shadow part).
						// Its style feeds the enclosing measurement -- and the
						// element itself may have just become display:none (a
						// textarea's placeholder hiding), which makes its own
						// run head unresolvable, so the walk starts from the
						// box parent chain when needed.
						this.#invalidateEnclosingMeasure(element);
					}
				} else if (
					record.attributeName === "class" ||
					record.attributeName === "id"
				) {
					// Selector-bearing attributes change which rules match the
					// whole SUBTREE -- a class flip can toggle a descendant's
					// display and reshape every box under it. But no further:
					// the style manager knows whether any sheet's selectors
					// can reach past the subtree (sibling combinators, :has),
					// and answers with the outermost element the flip can
					// affect. Rebuilding from body here made every selection
					// highlight in a 200-row list cost the whole document.
					const element = record.target as Element;
					let scope =
						selectorInvalidationScope(element) ??
						record.target.ownerDocument?.body;
					if (scope === element) {
						// An element in inline context participates in
						// structures wider than its subtree: an inline's box
						// lives in a run owned by the nearest block container,
						// and a block INSIDE an inline breaks that inline into
						// fragments owned by the same container. Rebuild from
						// the container, or the fragments reassemble wrong (a
						// block-in-inline's content vanishes on a no-op flip).
						// Iterated, because the container reached can itself
						// be a fragment of a broken inline one level further
						// out -- climb until the scope sits in block context.
						let lifted: Element | null = scope;
						while (lifted) {
							if (this.#isInlineLevel(lifted)) {
								lifted = this.#findInlineRunContainer(lifted);
								continue;
							}
							const parent: Element | null = lifted.parentElement;
							if (parent && this.#isInlineLevel(parent)) {
								lifted = this.#findInlineRunContainer(parent);
								continue;
							}
							break;
						}
						scope = lifted ?? scope;
					}
					if (scope) {
						this.invalidate(scope);
						if (scope === element) {
							// The flip can also change the element's OWN outer
							// display, moving it into or out of an enclosing
							// inline run -- a run the subtree rebuild above
							// never touches. Clearing the enclosing measure is
							// cheap and local, so do it unconditionally.
							this.#invalidateEnclosingMeasure(element);
						}
					}
				} else if (record.attributeName === "slot") {
					// Reassigning a slot moves the node in the COMPOSED tree while
					// the light tree stands still -- no childList record will ever
					// arrive. Both the run it left and the run it joined are stale,
					// and the old slot isn't recoverable statelessly (the DOM has
					// already reassigned), so rebuild the host's whole composed
					// subtree; slot reassignment is rare enough for the hammer.
					const host = (record.target as Element).parentElement;
					if (host && compositionShadowRoot(host)) {
						this.invalidate(host);
					}
				}
				// On to the next record -- returning here would silently drop every
				// remaining mutation in the batch, so a class flip followed by a
				// sibling's text change lost the text change entirely.
				continue;
			} else if (record.type === "characterData") {
				const textNode = record.target as Text;
				// Invalidate the inline run containing this text node
				this[kInvalidateInlineRun](textNode);
				continue;
			}

			// Handle added nodes
			for (let j = 0; j < record.addedNodes.length; j++) {
				const node = record.addedNodes[j];
				// A mutation at a shadow root's top level reports the ROOT as
				// its target; for layout its children belong to the HOST.
				const parentElement =
					record.target.nodeType === 11 && (record.target as ShadowRoot).host
						? (record.target as ShadowRoot).host
						: (record.target as Element);
				const parentFlexNode = this.nodeMap.get(parentElement);

				// An out-of-flow box doesn't care what its DOM parent is -- it
				// hoists to its containing block (inside #addNode), even out of
				// a measure-function subtree.
				if (this.#isOutOfFlow(node)) {
					this.#addNode(node, parentFlexNode ?? null);
					continue;
				}

				// An inline-block parent gets no layout-tree children (it measures
				// as a unit), but the addition still changes what that unit
				// measures -- a widget's UA tree populating, a label gaining a
				// span. Invalidate the enclosing MEASURE (never the run-head
				// machinery: a nested inline-block must not be given a layout
				// node of its own).
				const parentDisplay = getPropertyValue(parentElement, "display");
				if (parentDisplay === "inline-block") {
					this.#invalidateEnclosingMeasure(parentElement);
					continue;
				}

				if (!parentFlexNode) {
					// If parent has no layout node, it might be an inline element that's part of a run
					// Instead of adding to the layout tree, just invalidate the inline run
					if (this.#isInlineLevel(node)) {
						this[kInvalidateInlineRun](node);
						this[kInvalidateInlineRun](parentElement); // Also invalidate parent's run
						continue; // Skip normal layout tree addition
					} else if (!parentElement.isConnected) {
						// The parent isn't in the document yet -- its own
						// arrival later in this batch (or a later one) walks
						// composed children and picks this node up. Shadow
						// trees hit this ordering routinely: attachShadow +
						// populate fire records before the host's append.
						continue;
					} else {
						// Connected parent with no layout node: defer to the
						// calculateLayout re-add sweep rather than throwing --
						// it walks up for the nearest laid-out ancestor.
						this.#invalidatedNodes.add(node);
						continue;
					}
				}

				// Add the node to Flex layout
				this.#addNode(node, parentFlexNode);

				// Invalidate inline runs that might be affected by this addition
				if (this.#isInlineLevel(node)) {
					// If adding an inline node, invalidate the run it joins
					this[kInvalidateInlineRun](node);

					// Also check if this changes the run head of existing runs
					const nextSibling = node.nextSibling;
					if (nextSibling && this.#isInlineLevel(nextSibling)) {
						this[kInvalidateInlineRun](nextSibling);
					}

					const prevSibling = node.previousSibling;
					if (prevSibling && this.#isInlineLevel(prevSibling)) {
						this[kInvalidateInlineRun](prevSibling);
					}
				} else {
					// Block element added - might split inline runs
					const nextSibling = node.nextSibling;
					if (nextSibling && this.#isInlineLevel(nextSibling)) {
						this[kInvalidateInlineRun](nextSibling);
					}

					const prevSibling = node.previousSibling;
					if (prevSibling && this.#isInlineLevel(prevSibling)) {
						this[kInvalidateInlineRun](prevSibling);
					}
				}
			}

			// Handle removed nodes
			for (let j = 0; j < record.removedNodes.length; j++) {
				const node = record.removedNodes[j];
				const parent = record.target as Element;

				// Invalidate inline runs that might be affected by the removal
				// Use MutationRecord siblings since the removed node is disconnected
				if (
					record.previousSibling &&
					this.#isInlineLevel(record.previousSibling)
				) {
					this[kInvalidateInlineRun](record.previousSibling);
				}
				if (record.nextSibling && this.#isInlineLevel(record.nextSibling)) {
					this[kInvalidateInlineRun](record.nextSibling);
				}

				this.#removeNode(node, parent);
			}
		}
	}

	/** position:absolute (and fixed, approximated as absolute-to-ICB) takes
	 * a box out of normal flow entirely. */
	#isOutOfFlow(node: Node): boolean {
		if (node.nodeType !== node.ELEMENT_NODE) return false;
		const position = getPropertyValue(node as Element, "position");
		return position === "absolute" || position === "fixed";
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
	/** Whether the element or any composed ancestor is position: fixed. */
	/** Whether the element's containing-block chain reaches a fixed box. */
	isInFixedSpace(element: Element): boolean {
		return this.#inFixedSpace(element);
	}

	#inFixedSpace(element: Element): boolean {
		for (
			let el: Element | null = element;
			el;
			el = compositionParentElement(el)
		) {
			if (getPropertyValue(el, "position") === "fixed") return true;
		}
		return false;
	}

	#containingBlockFlexNode(element: Element): FlexTypes.Node | null {
		for (
			let ancestor = compositionParentElement(element);
			ancestor;
			ancestor = compositionParentElement(ancestor)
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
			let ancestor = compositionParentElement(node);
			ancestor;
			ancestor = compositionParentElement(ancestor)
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
			return;
		}

		// display:contents generates NO box: fresh builds flatten it via the
		// walker, and a REBUILD must not resurrect a stale box from an
		// earlier display value -- its children re-add as the box parent's
		// own. Retire whatever node it had.
		if (
			node.nodeType === node.ELEMENT_NODE &&
			getPropertyValue(node as Element, "display") === "contents"
		) {
			const staleNode = this.nodeMap.get(node);
			if (staleNode) {
				staleNode.getParent()?.removeChild(staleNode);
				// Sever the children BEFORE freeing: they belong to other DOM
				// nodes that the re-add sweep will re-attach at the box parent
				// -- freeRecursive on a still-populated node would leave their
				// nodeMap entries pointing at corpses.
				while (staleNode.children.length > 0) {
					staleNode.removeChild(staleNode.children[0]);
				}
				this.#measureNodes.delete(staleNode);
				staleNode.freeRecursive();
				this.#untrackNode(node);
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
		if (this.#isOutOfFlow(node)) {
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
			if (this.#isInlineLevel(node) && this.#boxOf(node)) {
				existingFlexNode.getParent()?.removeChild(existingFlexNode);
				while (existingFlexNode.children.length > 0) {
					existingFlexNode.removeChild(existingFlexNode.children[0]);
				}
				this.#measureNodes.delete(existingFlexNode);
				existingFlexNode.freeRecursive();
				this.#untrackNode(node);
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
				const display = getPropertyValue(element, "display");
				const needsMeasure =
					!this.#isOutOfFlow(element) &&
					(display === "inline" || display === "inline-block");
				if (needsMeasure !== this.#measureNodes.has(existingFlexNode)) {
					existingFlexNode.getParent()?.removeChild(existingFlexNode);
					// Sever children before freeing: they belong to other DOM
					// nodes (see the display:contents retirement above).
					while (existingFlexNode.children.length > 0) {
						existingFlexNode.removeChild(existingFlexNode.children[0]);
					}
					this.#measureNodes.delete(existingFlexNode);
					existingFlexNode.freeRecursive();
					this.#untrackNode(node);
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
					// Add to new parent
					const flexIndex = this.#isOutOfFlow(node)
						? parentFlexNode.children.length
						: this.#getFlexIndex(node as Element, parentFlexNode);
					parentFlexNode.insertChild(existingFlexNode, flexIndex);
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
		const walker = createExpandedTreeWalker(this.window, element);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.nodeType === node.ELEMENT_NODE && this.#isOutOfFlow(node)) {
				this.#addNode(node, null);
			}
		}
	}

	#addElementNode(
		element: Element,
		parentFlexNode: FlexTypes.Node | null = null,
	): void {
		const outOfFlow = this.#isOutOfFlow(element);
		const display = getPropertyValue(element, "display");

		// Inline-level content lays out in its container's anonymous boxes,
		// which the container reconciles as a whole -- unless the box is out of
		// flow, which blockifies it per CSS: it never joins a run.
		if (!outOfFlow && (display === "inline" || display === "inline-block")) {
			const box = this.#boxOf(element);
			if (box) {
				this.#invalidateBox(box);
				this.#dirtyRunContainers.add(box.container);
				this.#adoptOutOfFlowDescendants(element);
				this.#buildBlockContent(element);
				return;
			}
			// No anonymous box holds it: its own box is what lays it out (a
			// flex container's blockified children) -- proceed to create it.
		}

		// After the run-member return: members never insert a node of their
		// own, and the index is a backward sibling walk -- paying it for every
		// member makes adding a run of N boxes O(N^2).
		const flexIndex = outOfFlow
			? (parentFlexNode?.children.length ?? 0)
			: this.#getFlexIndex(element, parentFlexNode);

		let flexNode = this.nodeMap.get(element);
		if (!flexNode) {
			flexNode = Flex.Node.createWithConfig(flexConfig);
			this.#trackNode(element, flexNode);
		}

		this.#styleNode(element, flexNode);

		if (display === "none") {
			flexNode.setDisplay(Flex.DISPLAY_NONE);
			if (flexNode && parentFlexNode) {
				parentFlexNode.insertChild(flexNode, flexIndex);
			}
			return;
		} else if (
			!outOfFlow &&
			(display === "inline" || display === "inline-block")
		) {
			flexNode.setMeasureFunc((width, widthMode, height, heightMode) => {
				return this.#measureInlineRun(
					element,
					width,
					widthMode,
					height,
					heightMode,
				);
			});
			this.#measureNodes.add(flexNode);

			// Note: Automatic minimum size for flex items is now handled in measureInlineRun

			if (flexNode && parentFlexNode) {
				parentFlexNode.insertChild(flexNode, flexIndex);
			}

			this.#adoptOutOfFlowDescendants(element);
			this.#buildBlockContent(element);
			return;
		}

		// Block elements should NOT get measure functions - only their inline children do.
		// This prevents Flex constraint violations (nodes with measure functions cannot have children)

		// Inline-block elements cannot have children in the layout tree because they use measure functions
		if (!outOfFlow && display === "inline-block") {
			return;
		}

		// Use ExpandedTreeWalker to traverse children including pseudo-elements.
		// Only DIRECT children: an inline child broken apart by a block-level
		// box holds boxes this container lays out, and those reach the tree
		// through its own box reconciliation.
		const walker = createExpandedTreeWalker(this.window, element);
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
			parentFlexNode.insertChild(flexNode, flexIndex);
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
		const display = getPropertyValue(parent, "display");
		if (display !== "flex" && display !== "inline-flex") return false;
		const whiteSpace = getPropertyValue(parent, "white-space");
		if (whiteSpace === "pre" || whiteSpace === "pre-wrap") return false;
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
			if (siblingDisplay === "inline" || siblingDisplay === "inline-block") {
				return false;
			}
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

		flexNode.setMeasureFunc(
			(
				width: number,
				widthMode: FlexTypes.MeasureMode,
				height: number,
				heightMode: FlexTypes.MeasureMode,
			) => {
				return this.#measureInlineRun(
					text,
					width,
					widthMode,
					height,
					heightMode,
				);
			},
		);
		this.#measureNodes.add(flexNode);

		// Note: Automatic minimum size for flex items is now handled in measureInlineRun

		parentFlexNode.insertChild(flexNode, parentFlexNode.getChildCount());
	}

	/**
	 * Remove a node from the layout tree, handling both elements and text nodes
	 */
	#removeNode(node: Node, parent: Element): void {
		if (node.nodeType === node.ELEMENT_NODE) {
			this.#removeElement(node as Element, parent);
		} else if (node.nodeType === node.TEXT_NODE) {
			this.#removeText(node as Text, parent);
		}
	}

	/**
	 * Remove an element node from the layout tree
	 */
	#removeElement(element: Element, parent: Element): void {
		// Invalidate inline runs before removing the element
		if (this.#isInlineLevel(element)) {
			this.#invalidateInlineRemoval(element);
		} else {
			this.#invalidateBlockRemoval(parent);
		}

		// Remove from Flex layout, through the flex node's ACTUAL parent: a
		// hoisted out-of-flow box hangs from its containing block, not from
		// the DOM parent this record names.
		const flexNode = this.nodeMap.get(element);
		if (flexNode) {
			const actualParent = flexNode.getParent();
			if (actualParent) {
				actualParent.removeChild(flexNode);
			}

			// Check if element was actually removed vs just moved
			if (!element.isConnected) {
				// Element was truly removed from DOM - free it
				const pseudoMeta = getPseudoMetadata(element);
				if (pseudoMeta) {
					// Removing pseudo element from nodeMap during mutation removal
				}
				this.#measureNodes.delete(flexNode);
				flexNode.freeRecursive();
				this.#untrackNode(element);
			}
			// If element.isConnected is true, element was moved - keep layout node and nodeMap entry
			// It will be re-added to the new parent when that mutation is processed
		}

		// Clear any cached break results for this element
		this.#clearBreakResultCache(element);
	}

	/**
	 * Remove a text node from the layout tree
	 */
	#removeText(text: Text, parent: Element): void {
		// Text nodes are always inline-level
		this.#invalidateInlineRemoval(text);

		// Remove from the layout tree (if it has a layout node as run head)
		const flexNode = this.nodeMap.get(text);
		if (flexNode) {
			const parentFlexNode = this.nodeMap.get(parent);
			if (parentFlexNode) {
				parentFlexNode.removeChild(flexNode);
			}

			// Check if text was actually removed vs just moved
			if (!text.isConnected) {
				// Text was truly removed from DOM - free it
				this.#measureNodes.delete(flexNode);
				flexNode.freeRecursive();
				this.#untrackNode(text);
			}
		}

		// Clear any cached break results for this text node
		this.#clearBreakResultCache(text);
	}

	/**
	 * Invalidate inline runs affected by removing an inline-level node
	 */
	#invalidateInlineRemoval(node: Node): void {
		// Note: Invalidation is now handled at the MutationRecord level using previousSibling/nextSibling
		// This method is kept for compatibility but the real work happens in #handleMutationRecords
		// Just clear any cached break results for the removed node itself
		this.#clearBreakResultCache(node);
	}

	/**
	 * Invalidate inline runs when a block element is removed (might merge previously separate runs)
	 */
	#invalidateBlockRemoval(parent: Element): void {
		// Use tree walker to find all inline children that need invalidation
		const walker = createExpandedTreeWalker(this.window, parent);
		let child = walker.firstChild();

		while (child) {
			if (this.#isInlineLevel(child)) {
				this[kInvalidateInlineRun](child);
			}
			child = walker.nextSibling();
		}
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
		const walker = createExpandedTreeWalker(this.window, container);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			into.push(child);
			if (
				child.nodeType === child.ELEMENT_NODE &&
				this.#splitsAroundBlock(child as Element)
			) {
				// Remembered rather than recomputed: paint culling asks per
				// element per frame, and re-walking an inline's subtree there
				// would cost every off-screen row of a long list.
				this.#brokenInlines.add(child as Element);
				this.#splitContainers.add(root);
				this.#flowChildren(child as Element, into, root);
			}
		}
		return into;
	}

	/**
	 * Give an inline-block that holds block-level content a layout tree of its
	 * own. An inline-block establishes a block container, so `<span
	 * style="display:inline-block"><p>x</p></span>` is legal and common -- but
	 * the box is measured as ONE opaque unit by the run it sits on, and a run
	 * ends at a block-level box, so the p's content was simply dropped.
	 *
	 * The tree is DETACHED: nothing above may lay these boxes out, because the
	 * run decides where the inline-block lands and only afterwards is there an
	 * origin to hang them from (see #contentRootOffset). The root is laid out
	 * during measurement instead, and its children's coordinates are read back
	 * relative to the box's content edge.
	 */
	#buildBlockContent(element: Element): void {
		// Only an inline-block, never a plain inline: an inline containing a
		// block is BROKEN around it, and building a content tree here would
		// steal back the boxes that belong to its container.
		if (
			getPropertyValue(element, "display") !== "inline-block" ||
			!this.#containsBlockLevelBox(element)
		) {
			this.#dropBlockContent(element);
			return;
		}

		let root = this.#blockContentRoots.get(element);
		if (!root) {
			root = Flex.Node.createWithConfig(flexConfig);
			root.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
			root.setAlignItems(Flex.ALIGN_STRETCH);
			this.#blockContentRoots.set(element, root);
			this.#blockContentHosts.set(root, element);
		}

		const walker = createExpandedTreeWalker(this.window, element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (
				child.nodeType === child.ELEMENT_NODE ||
				child.nodeType === child.TEXT_NODE
			) {
				this.#addNode(child, root);
			}
		}

		// The tree is laid out by the measure that reaches it, which may be the
		// one running right now: its boxes have to be in it before it returns.
		if (this.#dirtyRunContainers.has(element)) {
			this.#syncContainerRuns(element);
		}
	}

	/** Build the content tree if this box needs one and has none yet. */
	#ensureBlockContent(element: Element): void {
		if (this.#blockContentRoots.has(element)) return;
		if (!this.#containsBlockLevelBox(element)) return;
		this.#buildBlockContent(element);
	}

	/** Retire an inline-block's content tree once its content is all inline again. */
	#dropBlockContent(element: Element): void {
		const root = this.#blockContentRoots.get(element);
		if (!root) return;
		this.#blockContentRoots.delete(element);
		this.#blockContentHosts.delete(root);
		// Sever first: the children belong to DOM nodes that re-add themselves
		// through the run machinery, and freeing them would leave nodeMap
		// pointing at corpses.
		while (root.children.length > 0) {
			root.removeChild(root.children[0]);
		}
		root.freeRecursive();
	}

	/**
	 * How far to shift coordinates read out of a detached content tree to put
	 * them in document space: the host inline-block's own content edge, which
	 * only the run that placed the box can say.
	 */
	/** The inline-block whose detached tree this node lives in, if any. */
	#hostOfContentRoot(flexNode: FlexTypes.Node): Element | null {
		if (this.#blockContentHosts.size === 0) return null;
		let root = flexNode;
		for (let parent = root.getParent(); parent; parent = root.getParent()) {
			root = parent;
		}
		return this.#blockContentHosts.get(root) ?? null;
	}

	/**
	 * Dirty the measure that refills a run's break result -- and, when the run
	 * lives in an inline-block's detached tree, the box whose measure is the
	 * only thing that ever lays that tree out. Dirtying just the run there
	 * invalidates it forever: nothing above the box ever visits those nodes, so
	 * the cleared break result is never rebuilt and the run paints nothing.
	 */
	#markRunMeasureDirty(runHead: Node): void {
		const flexNode = this.nodeMap.get(runHead);
		if (!flexNode) return;
		if (flexNode.measureFunc) flexNode.markDirty();
		const host = this.#hostOfContentRoot(flexNode);
		if (host) this.#invalidateEnclosingMeasure(host);
	}

	#contentRootOffset(flexNode: FlexTypes.Node): {x: number; y: number} {
		const host = this.#hostOfContentRoot(flexNode);
		if (!host) return ZERO_OFFSET;
		const hostRect = this.getRect(host);
		if (!hostRect) return ZERO_OFFSET;
		const boxModel = getBoxModel(host);
		return {
			x: hostRect.x + boxModel.borderLeftWidth + boxModel.paddingLeft,
			y: hostRect.y + boxModel.borderTopWidth + boxModel.paddingTop,
		};
	}

	/** An inline box with block-level content inside it: CSS breaks it apart. */
	#splitsAroundBlock(element: Element): boolean {
		if (this.#isOutOfFlow(element)) return false;
		if (getPropertyValue(element, "display") !== "inline") return false;
		return this.#containsBlockLevelBox(element);
	}

	#containsBlockLevelBox(element: Element): boolean {
		const walker = createExpandedTreeWalker(this.window, element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (child.nodeType !== child.ELEMENT_NODE) continue;
			const childElement = child as Element;
			if (this.#isOutOfFlow(childElement)) continue;
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

	#getFlexIndex(
		element: Element,
		parentFlexNode: FlexTypes.Node | null,
	): number {
		// Composition parent, not parentElement: a shadow root's child has no
		// parentElement, and returning 0 for every one inserted each at the
		// FRONT -- shadow children rendered in reverse document order. The
		// CHEAP flat parent suffices here: the fast path below only needs a
		// walker root somewhere above the element (previousSibling hops never
		// consult it), and the box-parent resolution -- a computed-style read
		// per ancestor -- is deferred to the slow path, off the hot
		// sequential-append route.
		const compositionParent = compositionParentElement(element);
		if (!compositionParent) {
			return 0;
		}

		// Fast path: walk backward from element for the nearest preceding
		// sibling that already has a flex node, and reuse its position.
		// Sequential building -- pushing rows into a list/tree in document
		// order, by far the common case -- finds one on the very first step:
		// the immediately preceding sibling was just added moments before by
		// this same mutation-processing pass. getChildIndex searches from the
		// tail for the same reason (a just-added node sits at or near the
		// end), so the whole thing is O(1) instead of re-walking every earlier
		// sibling from the start on every single insertion -- which makes
		// appending N children one at a time cost O(N) each, O(N^2) total.
		// Falls through to the full forward walk
		// below only when no tracked sibling is found nearby (inserting at
		// the front, or a run of skipped inline elements) -- correctness
		// matches it exactly, since both count only siblings with a flex node.
		if (parentFlexNode) {
			const backward = createExpandedTreeWalker(this.window, compositionParent);
			backward.currentNode = element;
			let prev = backward.previousSibling();
			while (prev) {
				let skippedInline = false;
				if (prev.nodeType === prev.ELEMENT_NODE) {
					// A broken inline's own node covers only its FIRST fragment;
					// the block that split it and everything after sit between
					// that node and this element. Its index says nothing about
					// where we go -- the full walk below counts them.
					if (this.#brokenInlines.has(prev as Element)) break;
					const display = getPropertyValue(prev as Element, "display");
					skippedInline =
						(display === "inline" || display === "inline-block") &&
						!this.isInlineRunHead(prev as Element);
				}
				if (!skippedInline) {
					const prevFlexNode = this.nodeMap.get(prev);
					if (prevFlexNode) {
						const idx = parentFlexNode.getChildIndex(prevFlexNode);
						if (idx !== -1) return idx + 1;
						break; // stale mapping -- fall back to the full walk
					}
				}
				prev = backward.previousSibling();
			}
		}

		// The container's own box list, so it roots at the box parent -- the slot
		// a projected element sits in generates no box, and rooting there would
		// miss its box siblings. It climbs out of inline wrappers for the same
		// reason addElementNode descends through them: a block-level box inside
		// an inline is a box of the CONTAINER, and its position is counted among
		// the container's children.
		let boxParent = compositionBoxParentElement(element) ?? compositionParent;
		for (
			let ancestor = compositionBoxParentElement(boxParent);
			ancestor && this.#splitsAroundBlock(boxParent);
			ancestor = compositionBoxParentElement(boxParent)
		) {
			boxParent = ancestor;
		}

		// Every box before this one that has reached the layout tree. Boxes are
		// added as their DOM nodes arrive, so a sibling still to come holds no
		// slot yet and must not be counted.
		let flexIndex = 0;
		for (const sibling of this.#containerBoxes(boxParent).boxes) {
			if (sibling === element) break;
			if (sibling instanceof InlineBox) {
				if (sibling.flexNode) flexIndex++;
			} else if (this.nodeMap.has(sibling)) {
				flexIndex++;
			}
		}

		return flexIndex;
	}

	#measureInlineRun(
		box: Node | InlineBox,
		width: number,
		widthMode: FlexTypes.MeasureMode,
		height: number,
		heightMode: FlexTypes.MeasureMode,
	): {width: number; height: number} {
		// An anonymous box measures from whatever opens it now, which is what
		// makes losing a head a re-measure rather than a rebuild.
		const node = box instanceof InlineBox ? box.head : box;
		const breakResult = this.#breakNodes(
			node,
			width,
			widthMode,
			height,
			heightMode,
		);
		if (Number.isFinite(width)) {
			breakResult.containerWidth = width;
		}

		// Store the BreakResult for later use by getRects()
		if (box instanceof InlineBox) {
			box.breakResult = breakResult;
		} else {
			this.breakResultMap.set(box, breakResult);
		}

		const result = {
			width: breakResult.maxLineWidth,
			height: breakResult.totalHeight,
		};

		return result;
	}

	/**
	 * The first composed (flat-tree) child that can start an inline run:
	 * shadow content for hosts, projected content through slots, skipping
	 * display:none elements -- a UA shadow tree's <style> would otherwise
	 * terminate leaf collection at position zero.
	 */
	#firstComposedRenderableChild(element: Element): Node | null {
		const walker = createExpandedTreeWalker(this.window, element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (
				child.nodeType === child.ELEMENT_NODE &&
				(getPropertyValue(child as Element, "display") === "none" ||
					this.#isOutOfFlow(child))
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
		const parent = compositionParentElement(element);
		if (!parent) return false;
		const display = getPropertyValue(parent, "display");
		if (display !== "flex" && display !== "inline-flex") return false;
		const direction = getPropertyValue(parent, "flex-direction") || "row";
		return direction === "row" || direction === "row-reverse";
	}

	#collectLeafNodes(
		runHead: Node,
		availableWidth: number,
		availableWidthMode: FlexTypes.MeasureMode = Flex.MEASURE_MODE_UNDEFINED,
	): Leaf[] {
		const leafNodes: Leaf[] = [];

		// For pseudo elements, use the host element as the parent
		const pseudoMetadata = getPseudoMetadata(runHead);
		const parentElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: compositionBoxParentElement(runHead);

		// Inline run heads should always have a parent element (a shadow
		// root's direct child resolves to its HOST -- a ShadowRoot is not an
		// Element, and this exact spot crashed on native attachShadow content
		// before compositionParentElement existed). The BOX parent: rooting
		// the walk at a display:contents slot would truncate the run at the
		// slot's edge, and the run may extend past it.
		if (!parentElement) {
			throw new Error("Inline run head must have a parent element");
		}

		// Determine the appropriate traversal root based on parent display type
		const parentDisplay = getPropertyValue(parentElement, "display");

		let traversalRoot: Node;
		if (parentDisplay === "flex" && runHead.nodeType === runHead.ELEMENT_NODE) {
			// For flex items that are elements, traverse only within that element
			traversalRoot = runHead;
		} else {
			// The block container, not the immediate parent: a run that starts
			// INSIDE an inline box -- the fragment after a block-level box split
			// it -- carries on past that box's end. `<span>a<div/>b</span>c`
			// puts "b" and "c" on one line, so the walk cannot stop at </span>.
			// An out-of-flow inline is where the climb stops: it is blockified
			// (css-display-3 §2.7) and lays its own content out, so the run
			// inside it is its own and ends with it.
			let root: Element = parentElement;
			for (
				let ancestor = compositionBoxParentElement(root);
				ancestor &&
				getPropertyValue(root, "display") === "inline" &&
				!this.#isOutOfFlow(root);
				ancestor = compositionBoxParentElement(root)
			) {
				root = ancestor;
			}
			traversalRoot = root;
		}

		// Text directly inside a flex container forms an ANONYMOUS flex item out
		// of the contiguous text runs, and every element child is an item of its
		// own -- so this run ends at the first one. Without the stop, the text's
		// item measured the following box into itself: `<p style="display:flex">
		// text <input> more</p>` gave the text a 21-cell item, which pushed
		// " more" off the far edge of a line it had room for.
		const stopsAtFlexItems =
			parentDisplay === "flex" && runHead.nodeType === runHead.TEXT_NODE;

		// Use ExpandedTreeWalker for traversal
		const walker = createExpandedTreeWalker(this.window, traversalRoot);

		walker.currentNode = runHead;
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
					this.#isOutOfFlow(element)
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
					// Before anything reads its size or asks what its content
					// runs from: an inline-block nested inside another inline is
					// a run MEMBER, and #addElementNode is never called on one,
					// so this is the first moment its block content is known to
					// need a tree.
					this.#ensureBlockContent(element);

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
					// Row flex items only: in column flex, width is the cross axis
					// and a definite width wins over stretch; a block container is
					// emulated as column flex, and its EXACTLY stretch offer
					// describes the CONTAINER's width, not this element's own
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
					const contentRoot = this.#blockContentRoots.get(element);
					let inlineBlockResult: BreakResult | undefined;
					let finalContentWidth: number;
					let finalContentHeight: number;

					if (contentRoot) {
						// Block-level content inside: lay the box's own tree out
						// here, since nothing above it will. An indefinite width
						// shrinks to fit, which is what an inline-block does.
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
								contentStart,
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
					// Block element - stop traversal
					break;
				}
			} else {
				// Unknown node type - continue
				if (!walker.nextNode()) break;
			}
		}

		return leafNodes;
	}

	#breakNodes(
		runHead: Node,
		width: number,
		widthMode: FlexTypes.MeasureMode,
		_height: number,
		_heightMode: FlexTypes.MeasureMode,
	): BreakResult {
		// Collect leaf nodes from the run head. An UNDEFINED width offer means
		// "measure your natural size" -- indefinite, so percentage widths in
		// the run cannot resolve against it (NaN); any definite offer,
		// including an AT_MOST 0 min-content probe, resolves them.
		const leafNodes = this.#collectLeafNodes(
			runHead,
			widthMode === Flex.MEASURE_MODE_UNDEFINED ? NaN : width,
			widthMode,
		);

		// Handle empty case
		if (leafNodes.length === 0) {
			return {lines: [], totalHeight: 0, maxLineWidth: 0};
		}

		// Get CSS properties from the appropriate element
		// For pseudo elements, use the host element, otherwise use parent for text nodes
		const pseudoMetadata = getPseudoMetadata(runHead);
		const styleElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: runHead.nodeType === runHead.TEXT_NODE
				? compositionParentElement(runHead)!
				: (runHead as Element);

		// Get default CSS properties from the run head element
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
		// preserving whitespace and honouring newlines, which #collapseWhitespace
		// already handles. Treating it as wrappable meant a narrow box folded text
		// that a browser lets overflow, and the bug hid behind `nowrap` working.
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

	#collapseWhitespace(text: string, whiteSpace: string): string {
		if (whiteSpace === "pre" || whiteSpace === "pre-wrap") {
			// Preserve all whitespace exactly as-is
			return text;
		}

		if (whiteSpace === "pre-line") {
			// Preserve newlines, collapse other whitespace to single spaces
			return text
				.split("\n")
				.map((line) => line.replace(/[ \t\r\f]+/g, " "))
				.join("\n");
		}

		// For "normal" and "nowrap": collapse all whitespace sequences to single space
		// This includes spaces, tabs, newlines, etc.
		return text.replace(/\s+/g, " ");
	}

	#processWhitespace(leafNodes: Leaf[]): ProcessedContent {
		const items: ProcessedContent["items"] = [];
		let text = "";

		for (let leafIndex = 0; leafIndex < leafNodes.length; leafIndex++) {
			const leaf = leafNodes[leafIndex];
			const start = text.length;

			if (leaf.type === "text" && leaf.content) {
				// Get the white-space property for this specific leaf's parent element
				const leafWhiteSpace = leaf.node.parentElement
					? getPropertyValue(leaf.node.parentElement, "white-space")
					: "normal";

				// Process the text content according to its white-space property
				let processed = this.#collapseWhitespace(leaf.content, leafWhiteSpace);

				// Handle boundary whitespace between adjacent text nodes
				if (leafIndex > 0 && processed.length > 0) {
					const prevItem = items[items.length - 1];
					if (prevItem && prevItem.leafNode.type === "text") {
						// Check if we have adjacent spaces at the boundary
						const prevEndsWithSpace =
							text.length > 0 && text[text.length - 1] === " ";
						const thisStartsWithSpace = processed[0] === " ";

						if (prevEndsWithSpace && thisStartsWithSpace) {
							// Remove the leading space to avoid double spaces at boundaries
							processed = processed.substring(1);
						}
					}
				}

				text += processed;

				items.push({
					leafNode: leaf,
					start: start,
					end: text.length,
					processedContent: processed,
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
				if (leaf.type === "text" && leaf.node.parentElement) {
					const ws = getPropertyValue(leaf.node.parentElement, "white-space");
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
						}
						item.start = clampedStart - trimStart;
						item.end = clampedEnd - trimStart;
					}
				}
			}
		}

		return {items, text};
	}

	/** Does ANY text leaf in the run carry white-space: nowrap? */
	#hasNowrapLeaf(content: ProcessedContent): boolean {
		return content.items.some((item) => {
			if (item.leafNode.type === "text" && item.leafNode.node.parentElement) {
				const leafWhiteSpace = getPropertyValue(
					item.leafNode.node.parentElement,
					"white-space",
				);
				return leafWhiteSpace === "nowrap";
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

		while (lineStart < content.text.length) {
			let bestBreak = lineStart;
			let bestBreakWidth = 0;

			for (const breakPoint of breaks) {
				if (breakPoint.position <= lineStart) continue;

				const width = this.#measureText(
					content.text,
					content.items,
					lineStart,
					breakPoint.position,
				);

				if (width <= maxWidth) {
					bestBreak = breakPoint.position;
					bestBreakWidth = width;
				} else {
					break;
				}

				if (breakPoint.required) {
					bestBreak = breakPoint.position;
					bestBreakWidth = width;
					break;
				}
			}

			// No break opportunity fits. Under overflow-wrap: normal the line
			// takes the whole unbreakable unit and OVERFLOWS, exactly as a
			// browser lets a long word escape its box; only break-word/
			// anywhere/break-all may synthesize a break inside the word.
			if (bestBreak === lineStart && !breakAnywhere) {
				const next = breaks.find((b) => b.position > lineStart);
				bestBreak = next ? next.position : content.text.length;
				bestBreakWidth = this.#measureText(
					content.text,
					content.items,
					lineStart,
					bestBreak,
				);
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

					const width = this.#measureText(
						content.text,
						content.items,
						lineStart,
						pos,
					);
					if (width > maxWidth && pos > lineStart + 1) {
						pos--;
						break;
					}
					pos++;
				}
				bestBreak = Math.min(pos, content.text.length);
				bestBreakWidth = this.#measureText(
					content.text,
					content.items,
					lineStart,
					bestBreak,
				);
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

	#measureText(
		text: string,
		items: ProcessedContent["items"],
		start: number,
		end: number,
	): number {
		let width = 0;

		for (const item of items) {
			if (item.start >= end || item.end <= start) continue;

			const itemStart = Math.max(item.start, start);
			const itemEnd = Math.min(item.end, end);

			if (item.leafNode.type === "text") {
				const portion = text.slice(itemStart, itemEnd);
				width += runtimeStringWidth(portion);
			} else if (item.leafNode.type === "inline-block") {
				// Only count inline-block width if we're measuring its full range
				if (itemStart === item.start && itemEnd === item.end) {
					const blockWidth =
						item.leafNode.contentWidth +
						item.leafNode.boxModel.paddingLeft +
						item.leafNode.boxModel.paddingRight +
						item.leafNode.boxModel.borderLeftWidth +
						item.leafNode.boxModel.borderRightWidth +
						item.leafNode.boxModel.marginLeft +
						item.leafNode.boxModel.marginRight;
					width += blockWidth;
				} else {
					// Partial inline-block measurement not supported
				}
			}
		}

		return width;
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
					// of the frame (visualToDataOffsets already maps a break to
					// "nothing", so offsets stay aligned).
					const portion = item.processedContent
						.slice(relativeStart, relativeEnd)
						.replace(/\n+$/, "");
					width = runtimeStringWidth(portion);

					nodes.push({
						leaf: item.leafNode,
						start: relativeStart,
						end: relativeEnd,
						x,
						width,
						processedText: portion,
					});
				} else if (item.leafNode.type === "inline-block") {
					width =
						item.leafNode.contentWidth +
						item.leafNode.boxModel.paddingLeft +
						item.leafNode.boxModel.paddingRight +
						item.leafNode.boxModel.borderLeftWidth +
						item.leafNode.boxModel.borderRightWidth +
						item.leafNode.boxModel.marginLeft +
						item.leafNode.boxModel.marginRight;
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
					});
				} else if (item.leafNode.type === "br") {
					nodes.push({
						leaf: item.leafNode,
						start: 0,
						end: 0,
						x,
						width: 0,
						processedText: "",
					});
				}

				x += width;
			}
		}

		return nodes;
	}
}

export function isPointInRects(
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

/**
 * Map each painted (visual) character of a text node back to its code-unit
 * offset in node.data. The painted fragments are the node's text after
 * whitespace collapsing and line breaking, so they differ from the raw data
 * only in whitespace: a run of data whitespace becomes one visual space, or
 * nothing at a line break. Non-whitespace code units match one-for-one --
 * including surrogate halves, which is what keeps the returned offsets valid as
 * Range offsets (Ranges address code units, not glyphs).
 *
 * Selection needs this bridge in both directions: a mouse hit lands on a visual
 * cell and must become a Range offset into the data; painting walks the visual
 * fragments and must know which of them a data-offset Range covers. The
 * textarea widget reuses it to place a caret in its laid-out value.
 */
export function visualToDataOffsets(
	data: string,
	fragments: Array<{text: string}>,
): number[] {
	const map: number[] = [];
	let d = 0;
	for (const fragment of fragments) {
		// Code UNITS on both sides, not code points: surrogate halves of
		// non-whitespace text are identical in data and fragment, so they align
		// half-to-half, and the map stays indexable by the same positions
		// String.prototype.slice uses.
		for (let i = 0; i < fragment.text.length; i++) {
			if (!/\s/.test(fragment.text[i])) {
				// A visual char never comes from data whitespace -- skip any
				// collapsed run to the next real char.
				while (d < data.length && /\s/.test(data[d])) d++;
				map.push(Math.min(d, Math.max(0, data.length - 1)));
				d++;
			} else {
				// One visual space stands for the whole whitespace run.
				map.push(Math.min(d, Math.max(0, data.length - 1)));
				while (d < data.length && /\s/.test(data[d])) d++;
			}
		}
	}
	return map;
}
