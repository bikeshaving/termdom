import LineBreaker from "linebreak";

import {
	establishesFixedContainingBlock,
	getBoxModel,
	getCellBlockMargin,
	getCellBlockSize,
	getCellBorderWidths,
	getCellPadding,
	getComputedValue,
	getDeclaredDisplay,
	getWhiteSpace as getElementWhiteSpace,
	getFixedContainingBlock,
	getStyleGroup,
	getTabSize,
	getUsedOverflow,
	hasLayoutOrPaintContainment,
	readStyleAgain,
	recordStyleReads,
	replayStyleReads,
	resolveLength,
	type StyleGroup,
	toCellBorder,
	toCellLength,
	toWholeCells,
	usedValuesChanged,
} from "./cssom.ts";
import * as CSSValues from "./cssvalues.ts";
import {
	DOMRectList,
	flatChildren,
	flatDescendants,
	flatIsConnected,
	flatParentElement,
	flowContent,
	flowNext,
	getAddedNodes,
	getScrollOffset,
	getShadowRoot,
	getUnlinkCount,
	isConnectedNode,
	isDocumentElement,
	isInFlatTree,
	isModalDialog,
	isShadowIncludingAncestor,
	pseudoElementCount,
	renderedTopLayer,
	type Window,
} from "./dom.ts";
import {
	type Align,
	type AvailableSpace,
	CachePool,
	createStyle,
	type Edge,
	type FlexDirection,
	forgetLayout,
	getChildIndex,
	getComputedGridTracks,
	getComputedHeight,
	getComputedWidth,
	getDrawnColumns,
	type Gutter,
	insertChild,
	isContainingBlock,
	type Justify,
	LayoutNode,
	type Measure,
	NO_TRANSLATION,
	type PositionType,
	releaseCache,
	resolveValue,
	shareStyle,
	type Size,
	type Sizing,
	type Style,
	toValue,
	type Translation,
	type Wrap,
} from "./layoutsolver.ts";
import {
	findMathPosition,
	getMathAlignOffset,
	getMathCellRects,
	isMathRoot,
	layoutMath,
	linearizeMath,
	type MathBox,
} from "./mathml.ts";
import {
	getNaturalRatio,
	getNaturalSize,
	getReplacedSize,
	isReplacedBox,
	measureReplaced,
} from "./replaced.ts";
import {implementsInterface} from "./slots.ts";
import {
	getParagraphDirection,
	getStringWidth,
	graphemeSegmenter,
	hasRTL,
	toVisualOrder,
	writeClusterWidths,
} from "./text.ts";
import {
	getAttributeValue,
	getCharacterData,
	getDefaultView,
	getHTMLLocalName,
	getLocalName,
	getNodeType,
	getOwnerDocument,
} from "./tree.ts";
import {getCellSize, pxFromCells, UNIT_CELL} from "./units.ts";

type Position = "static" | "relative" | "absolute" | "fixed" | "sticky";

// The most cols or rows a textarea attribute can ask for, far past a terminal.
const MAX_TEXTAREA_SIZE = 1000;

const POSITIONS = new Set<string>([
	"static",
	"relative",
	"absolute",
	"fixed",
	"sticky",
]);

// A fixed box an ancestor contains is laid out, scrolled and clipped as
// an absolute one in that ancestor.
function getPosition(element: Element): Position {
	const value = getComputedValue(element, "position");
	if (value === "fixed" && getFixedContainingBlock(element) !== null) {
		return "absolute";
	}
	return POSITIONS.has(value) ? (value as Position) : "static";
}

export function isPositioned(element: Element): boolean {
	return getPosition(element) !== "static";
}

// Unless an ancestor contains it, fixed is approximated as absolute
// against the initial containing block.
function isOutOfFlow(node: Node): boolean {
	if (getNodeType(node) !== node.ELEMENT_NODE) {
		return false;
	}
	const position = getPosition(node as Element);
	return position === "absolute" || position === "fixed";
}

// display:contents generates no box. The UA sheet gives slots this, so
// a slot vanishes from layout while its projected content flows
// through.
function isDisplayContents(node: Node): boolean {
	return getLayoutDisplay(node as Element) === "contents";
}

export type Display =
	"none" |
	"contents" |
	"block" |
	"inline" |
	"inline-block" |
	"inline-flex" |
	"inline-grid" |
	"inline-table" |
	"flex" |
	"grid" |
	"list-item" |
	"table" |
	"table-row" |
	"table-row-group" |
	"table-header-group" |
	"table-footer-group" |
	"table-column" |
	"table-column-group" |
	"table-cell" |
	"table-caption";

// An unimplemented display lays out as a block.
const DISPLAYS = new Set<string>([
	"none",
	"contents",
	"block",
	"inline",
	"inline-block",
	"inline-flex",
	"inline-grid",
	"inline-table",
	"flex",
	"grid",
	"list-item",
	"table",
	"table-row",
	"table-row-group",
	"table-header-group",
	"table-footer-group",
	"table-column",
	"table-column-group",
	"table-cell",
	"table-caption",
]);

const TABLE_DISPLAYS = new Set<string>([
	"table",
	"table-row",
	"table-row-group",
	"table-header-group",
	"table-footer-group",
	"table-column",
	"table-column-group",
	"table-cell",
	"table-caption",
]);

const BLOCKIFIED_TABLE_PARTS = new Set<Display>([
	"table-header-group",
	"table-footer-group",
	"table-row-group",
	"table-caption",
	"table-row",
	"table-cell",
]);

// display has two axes (css-display-3 §2), and blockification (§2.7) changes
// only the OUTER one. An absolutely positioned inline-grid sits on rows of its
// own and is still a grid inside. So the outer question (is this box on a line)
// goes through `isInlineLevel`, which reads the USED display, and the inner
// ones (hasItemChildren, isGridDisplay, isFlexContainer,
// establishesIndependentFormattingContext) read the display the rules
// declare, before blockification, whose inner axis is the same. `none` and
// `contents` are on neither axis and are used as declared.
function getLayoutDisplay(element: Element): Display {
	// The root is on no line and in no container, so the one thing its
	// blockification changes is its own, and layout reads it computed.
	const value = isDocumentElement(element)
		? getComputedValue(element, "display")
		: getDeclaredDisplay(element);
	if (value === "inline math") {
		return "inline-block";
	}
	// An image or a canvas on a line sits there whole, as an inline-block
	// does, though its computed display stays inline.
	if (value === "inline" && isReplacedBox(element)) {
		return "inline-block";
	}
	if (value === "block math" || value === "math") {
		return "block";
	}
	return DISPLAYS.has(value) ? (value as Display) : "block";
}

// An inline-block flex item's measure returns a border-box size, so its
// layout node must not add padding and border again on the cross axis (a
// bordered textarea in a flex row came out too tall). The main axis is
// masked by flex sizing. The node then holds none on those edges, though
// the box has them.
function getMaskedEdges(element: Element): readonly Edge[] {
	if (getLayoutDisplay(element) !== "inline-block" || !hasFlexParent(element)) {
		return [];
	}
	const direction = getComputedValue(
		boxParentElement(element)!,
		"flex-direction",
	);
	return direction === "column" || direction === "column-reverse"
		? ["left", "right"]
		: ["top", "bottom"];
}

function applyTableContainer(style: Style, element: Element): void {
	style.displayType = "table";
	style.borderCollapse =
		getComputedValue(element, "border-collapse") === "collapse";
	style.tableLayoutFixed =
		getComputedValue(element, "table-layout") === "fixed";
}

// A box that sits on a line whole, measured as one opaque unit.
export function isAtomicInline(display: Display): boolean {
	return display === "inline-block" ||
		display === "inline-flex" ||
		display === "inline-grid" ||
		display === "inline-table";
}

// About a display value. For a node, ask isInlineLevel.
function isInlineDisplay(display: Display): boolean {
	return display === "inline" || isAtomicInline(display);
}

function isFlexContainer(element: Element): boolean {
	const display = getLayoutDisplay(element);
	return display === "flex" || display === "inline-flex";
}

// Each child gets a box of its own, blockified. No inline run gathers
// across them (css-display-3 §2.7).
function hasItemChildren(display: Display): boolean {
	return display === "flex" || isGridDisplay(display);
}

function isGridDisplay(display: Display): boolean {
	return display === "grid" || display === "inline-grid";
}

// The element whose box holds this node's box. display: contents
// generates no box, so its children belong to the nearest ancestor
// that does (css-display-3 §2.5).
function boxParentElement(node: Node): Element | null {
	let parent = flatParentElement(node);
	while (parent !== null && isDisplayContents(parent)) {
		parent = flatParentElement(parent);
	}
	return parent;
}

function hasFlexParent(element: Element): boolean {
	const parent = boxParentElement(element);
	return parent !== null && getLayoutDisplay(parent) === "flex";
}

export function hasItemParent(element: Element): boolean {
	const parent = boxParentElement(element);
	return parent !== null && hasItemChildren(getLayoutDisplay(parent));
}

// css-display-3 §2.7.
function isBlockified(element: Element): boolean {
	return isOutOfFlow(element) || hasItemParent(element);
}

// An inline box, whose content flows on the lines of the run it heads or
// joins. A blockified inline holding a block, and one taken out of flow,
// is a block container instead, and lays its content out on lines of its
// own. A flex or grid item holding only inline content still measures as a
// run, headed by itself in its container's.
function isInlineBox(element: Element): boolean {
	return getLayoutDisplay(element) === "inline" && isMeasuredAsRun(element);
}

function getUsedDisplay(element: Element): Display {
	const display = getLayoutDisplay(element);
	if (!isInlineDisplay(display)) {
		return display;
	}
	return isBlockified(element) ? "block" : display;
}

function isInlineLevel(node: Node): boolean {
	if (getNodeType(node) === node.TEXT_NODE) {
		return true;
	}
	if (getNodeType(node) !== node.ELEMENT_NODE) {
		return false;
	}
	return isInlineDisplay(getUsedDisplay(node as Element));
}

// Computed display, not used. A flex item's inline-block is
// blockified off its line but still measures its content as one unit
// under a root of its own, and the used display would take that root away.
function establishesIndependentFormattingContext(element: Element): boolean {
	return isAtomicInline(getLayoutDisplay(element));
}

// A blockified inline holding block-level content is a block
// container. Measured as a run, its content would end at the first
// block inside it. One holding only inline content still measures as a
// run, which is what gives a flex item its intrinsic size.
function isMeasuredAsRun(element: Element): boolean {
	if (isOutOfFlow(element)) {
		return false;
	}
	const display = getLayoutDisplay(element);
	if (!isInlineDisplay(display)) {
		return false;
	}
	if (isAtomicInline(display)) {
		return true;
	}
	if (isInlineLevel(element)) {
		return true;
	}
	return !hasBlockLevelBox(element);
}

// An inline holding block-level content is broken apart (CSS2 §9.2.1.1).
function isSplitAroundBlock(element: Element): boolean {
	if (isOutOfFlow(element)) {
		return false;
	}
	if (getLayoutDisplay(element) !== "inline") {
		return false;
	}
	// A flex or grid item is already a block container. Splitting it would
	// hand its own children to the container as items of their own.
	const parent = boxParentElement(element);
	if (parent && hasItemChildren(getLayoutDisplay(parent))) {
		return false;
	}
	return hasBlockLevelBox(element);
}

function hasBlockLevelBox(element: Element): boolean {
	for (const child of flowContent(element)) {
		if (getNodeType(child) !== child.ELEMENT_NODE) {
			continue;
		}
		const childElement = child as Element;
		if (isOutOfFlow(childElement)) {
			continue;
		}
		const display = getLayoutDisplay(childElement);
		// An atomic inline contains its own blocks without splitting.
		if (display === "none" || isAtomicInline(display)) {
			continue;
		}
		if (display === "inline") {
			if (hasBlockLevelBox(childElement)) {
				return true;
			}
			continue;
		}
		return true;
	}
	return false;
}

// pre-line is absent: it collapses spaces and tabs, keeping only newlines
// (css-text-3 §4.1.1).
function isSpacePreserving(whiteSpace: string): boolean {
	return (
		whiteSpace === "pre" ||
		whiteSpace === "pre-wrap" ||
		whiteSpace === "break-spaces"
	);
}

// css-text-3 §4.1.1 names the characters that collapse. A no-break
// space and the fixed-width spaces are content, whatever white-space
// says.
const COLLAPSIBLE_RUN = /[ \t\n\r\f]+/g;
const PRE_LINE_RUN = /[ \t\r\f]+/g;
const COLLAPSIBLE_ONLY = /^[ \t\n\r\f]*$/;

// Whether rendering would change anything: two collapsible characters
// in a row, or one that is not already the space it collapses to.
const COLLAPSES = /[ \t\n\r\f][ \t\n\r\f]|[\t\n\r\f]/;
const PRE_LINE_COLLAPSES = /[ \t\r\f][ \t\r\f]|[\t\r\f]/;

// Stateful (`g`). Reset lastIndex before scanning.
function getCollapsiblePattern(whiteSpace: string): RegExp {
	return whiteSpace === "pre-line" ? PRE_LINE_RUN : COLLAPSIBLE_RUN;
}

// The one definition of white-space rendering. The breaker records data
// ranges per fragment through it and the painter renders them back
// through it. The two agree because rendering a range equals the range
// of the rendering whenever the range begins and ends on a rendered
// character, which is how fragment offsets are defined.
function renderWhiteSpace(data: string, whiteSpace: string): string {
	if (isSpacePreserving(whiteSpace)) {
		return data;
	}
	// Most text renders as itself. Checking first skips building an equal
	// string.
	const collapses = whiteSpace === "pre-line" ? PRE_LINE_COLLAPSES : COLLAPSES;
	if (!collapses.test(data)) {
		return data;
	}
	return data.replace(getCollapsiblePattern(whiteSpace), " ");
}

// offsets[i] is the data offset rendered code unit i came from. Null
// means verbatim. Dense on purpose: one lookup beats a run-table search
// everywhere the breaker needs it.
function renderWhiteSpaceOffsets(
	data: string,
	whiteSpace: string,
): {text: string; offsets: Int32Array | null} {
	if (isSpacePreserving(whiteSpace)) {
		return {text: data, offsets: null};
	}
	const collapses = whiteSpace === "pre-line" ? PRE_LINE_COLLAPSES : COLLAPSES;
	if (!collapses.test(data)) {
		return {text: data, offsets: null};
	}
	const pattern = getCollapsiblePattern(whiteSpace);
	pattern.lastIndex = 0;
	let text = "";
	const offsets: number[] = [];
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(data))) {
		for (let i = last; i < match.index; i++) {
			text += data[i];
			offsets.push(i);
		}
		// Each run's one space maps to the run's first character.
		text += " ";
		offsets.push(match.index);
		last = match.index + match[0].length;
	}
	for (let i = last; i < data.length; i++) {
		text += data[i];
		offsets.push(i);
	}
	return {text, offsets: Int32Array.from(offsets)};
}

function getDataOffset(offsets: Int32Array | null, index: number): number {
	return offsets === null ? index : offsets[index];
}

// A verbatim rendering needs a real mapping once shifted.
function shiftRenderedOffsets(
	offsets: Int32Array | null,
	by: number,
	length: number,
): Int32Array {
	if (offsets !== null) {
		return offsets.subarray(by);
	}
	const identity = new Int32Array(length);
	for (let i = 0; i < length; i++) {
		identity[i] = i + by;
	}
	return identity;
}

// A fragment's tab stops count from the start of its line, so the
// fragment's column there is what a preserved tab expands against.
interface TabStops {
	tabSize: number;
	column: number;
}

// Applied at paint time, and read back by innerText. Case never changes
// a cell width, so it cannot change wrapping.
export function applyTextTransform(text: string, transform: string): string {
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

/** The characters one line fragment paints, in the line's visual order. */
export function renderTextFragment(
	data: string,
	whiteSpace: string,
	startOffset: number,
	endOffset: number,
	visualBase?: "ltr" | "rtl" | null,
	tabs?: TabStops,
): string {
	let text = renderWhiteSpace(data.slice(startOffset, endOffset), whiteSpace);
	if (
		tabs !== undefined && text.includes("\t") && isSpacePreserving(whiteSpace)
	) {
		text = expandTabRun(text, null, tabs.tabSize, tabs.column).text;
	}
	return visualBase ? toVisualOrder(text, visualBase) : text;
}

// White space renders nothing where the run it would open has no
// content to sit beside (css2 §9.4.2 with css-text-3 §4.1.1).
function shouldCollapseWhitespaceTextNode(textNode: Text): boolean {
	const data = getCharacterData(textNode);
	if (!data || !COLLAPSIBLE_ONLY.test(data)) {
		return false;
	}

	const parent = textNode.parentElement;
	if (!parent) {
		return false;
	}

	// Under the preserving values a space is content. A card's blank
	// middle row is three spaces, and this is what makes it a row. Under
	// pre-line a newline is a forced break and keeps its line.
	const {whiteSpace} = getTextStyle(parent);
	if (isSpacePreserving(whiteSpace)) {
		return false;
	}
	if (whiteSpace === "pre-line" && textNode.textContent.includes("\n")) {
		return false;
	}

	// A space is as wide as its font makes it, and at font-size 0 that is
	// nothing (css-text-3 §4.1.1). Mail sets it on a row of inline-block
	// columns so the spaces between them take no room.
	if (parseFloat(getComputedValue(parent, "font-size")) === 0) {
		return true;
	}

	// Inside an inline box the space is on a line with content, and is a
	// space.
	if (
		isInlineDisplay(getLayoutDisplay(parent)) &&
		(isAtomicInline(getLayoutDisplay(parent)) || isInlineBox(parent))
	) {
		return false;
	}

	// A comment generates no box, so it is never what the space sits next
	// to.
	const rendered = (
		node: Node | null,
		step: (from: Node) => Node | null,
	): Node | null => {
		let current = node;
		while (current && getNodeType(current) === current.COMMENT_NODE) {
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

	// USED display. An out-of-flow box takes no part in the flow, and
	// white space beside one has nothing to sit next to, as if it were not
	// written.
	const isBlockLevel = (node: Node | null): boolean => {
		if (!node || getNodeType(node) !== node.ELEMENT_NODE) {
			return false;
		}
		return !isInlineDisplay(getUsedDisplay(node as Element));
	};

	if (isBlockLevel(prevSibling) && isBlockLevel(nextSibling)) {
		return true;
	}
	if (isBlockLevel(prevSibling) && !nextSibling) {
		return true;
	}
	if (!prevSibling && isBlockLevel(nextSibling)) {
		return true;
	}
	return !prevSibling && !nextSibling;
}

// css-flexbox-1 §4: an anonymous item of collapsible white space is not
// rendered, or multi-line markup's indentation eats gap and
// justify-content space. Nor is one in a table, a row group or a row
// (CSS2 §17.2.1, rule 1), so any run left there has content, which an
// anonymous cell holds.
function isSuppressedWhitespace(text: Text): boolean {
	const parent = boxParentElement(text);
	if (!parent) {
		return false;
	}
	const display = getLayoutDisplay(parent);
	if (!hasItemChildren(display) && !isTableInternal(display)) {
		return false;
	}
	if (isSpacePreserving(getTextStyle(parent).whiteSpace)) {
		return false;
	}
	for (let node: Node | null = text; node; node = node.nextSibling) {
		if (getNodeType(node) === node.TEXT_NODE) {
			if (!COLLAPSIBLE_ONLY.test((node as Text).data)) {
				return false;
			}
			continue;
		}
		if (getNodeType(node) !== node.ELEMENT_NODE) {
			continue;
		}
		// USED display. A blockified item opens a box of its own
		// rather than joining the run. A display:none child does not interrupt
		// it.
		const siblingDisplay = getUsedDisplay(node as Element);
		if (siblingDisplay === "none") {
			continue;
		}
		// An inline sibling gives the run content. A block-level one ends it.
		if (isInlineDisplay(siblingDisplay)) {
			return false;
		}
		break;
	}
	return true;
}

// A value this engine does not implement falls back rather than
// reaching the solver as something it cannot read.
const DIRECTIONS = new Set<string>([
	"row",
	"row-reverse",
	"column",
	"column-reverse",
]);

const WRAPS = new Set<string>(["nowrap", "wrap", "wrap-reverse"]);

function parseFlexDirection(value: string): FlexDirection {
	return DIRECTIONS.has(value) ? (value as FlexDirection) : "row";
}

function parseFlexWrap(value: string): Wrap {
	return WRAPS.has(value) ? (value as Wrap) : "nowrap";
}

const EDGES = ["top", "right", "bottom", "left"] as const;

const GRID_PLACEMENTS = [
	["gridRowStart", "grid-row-start"],
	["gridRowEnd", "grid-row-end"],
	["gridColumnStart", "grid-column-start"],
	["gridColumnEnd", "grid-column-end"],
] as const;

// A block-level box in a container with a legacy alignment (a <center>,
// an align attribute) lines up as its margins would put it, were the
// margins toward that side auto (HTML §15.3.3, "align descendants").
function applyLegacyAlignment(
	style: Style,
	element: Element,
	display: Display,
	parentIsFlex: boolean,
): void {
	if (parentIsFlex || isInlineDisplay(display) || isOutOfFlow(element)) {
		return;
	}
	const parent = boxParentElement(element);
	const legacy = parent === null
		? null
		: CSSValues.getLegacyAlignment(getTextStyle(parent).textAlign);
	if (
		legacy === null ||
		getComputedValue(element, "margin-left") === "auto" ||
		getComputedValue(element, "margin-right") === "auto"
	) {
		return;
	}
	if (legacy !== "left") {
		style.margin.left = toValue("auto");
	}
	if (legacy !== "right") {
		style.margin.right = toValue("auto");
	}
}

// Left unset, never pinned to 0. min-width auto is a flex item's
// content-based minimum, and 0 lets it shrink under its own text. A length
// in content-box sizing gets the box's edges, as width and height do.
function applyMinMax(style: Style, element: Element): void {
	const read = (property: string, vertical: boolean): CSSValues.Value => {
		const value = vertical
			? getCellBlockSize(element, property as "min-height" | "max-height")
			: toCellLength(
				CSSValues.parseUnitValue(getComputedValue(element, property)),
				false,
				element,
			);
		return toValue(
			typeof value === "number"
				? value + getContentBoxEdges(element, vertical)
				: value,
		);
	};
	style.minWidth = read("min-width", false);
	style.minHeight = read("min-height", true);
	style.maxWidth = read("max-width", false);
	style.maxHeight = read("max-height", true);
	// A scroll container's content scrolls rather than sizes it, so its
	// automatic minimum is zero (css-flexbox-1 §4.5, css-grid-2 §6.6).
	if (isScrollContainer(element)) {
		for (const key of ["minWidth", "minHeight"] as const) {
			if (style[key].unit === "auto" || style[key].unit === "undefined") {
				style[key] = toValue(0);
			}
		}
	}
	// An outside marker sits on a line of the item's own, so an item with
	// nothing on its lines still has the one the marker needs.
	if (
		getLayoutDisplay(element) === "list-item" &&
		getComputedValue(element, "height") === "auto" &&
		getComputedValue(element, "list-style-position") !== "inside" &&
		getComputedValue(element, "list-style-type") !== "none"
	) {
		const box = getBoxModel(element);
		const line =
			1 +
			box.paddingTop +
			box.paddingBottom +
			box.borderTopWidth +
			box.borderBottomWidth;
		const min = style.minHeight;
		if (!(min.unit === "cell" && min.value >= line)) {
			style.minHeight = toValue(line);
		}
	}
}

const INSET_EDGES = ["left", "top", "right", "bottom"] as const;

const TRANSFORM_FUNCTION = /([a-z0-9]+)\(([^()]*)\)/gi;
const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*|%)$/i;

// The part of `translate` and `transform` that moves the box, which is the
// part a grid of cells can draw. A rotation, scale or skew draws the box
// as it is.
function getTranslation(element: Element): Translation {
	const translation = {x: 0, y: 0, xPercent: 0, yPercent: 0};
	const add = (value: string | undefined, vertical: boolean, unit = "") => {
		const match = LENGTH.exec((value ?? "").trim());
		if (match === null) {
			return;
		}
		const number = parseFloat(match[1]);
		if (match[2] === "%") {
			translation[vertical ? "yPercent" : "xPercent"] += number;
			return;
		}
		const px = match[2] === "" && unit === ""
			? number === 0 ? 0 : null
			: resolveLength(element, number, match[2] || unit, vertical);
		const cells = px === null ? null : toCellLength(px, vertical, element);
		if (typeof cells === "number") {
			translation[vertical ? "y" : "x"] += cells;
		}
	};

	const translate = getComputedValue(element, "translate");
	if (translate !== "" && translate !== "none") {
		const [x, y] = translate.trim().split(/\s+/);
		add(x, false);
		add(y, true);
	}

	const transform = getComputedValue(element, "transform");
	if (transform !== "" && transform !== "none") {
		for (const [, name, args] of transform.matchAll(TRANSFORM_FUNCTION)) {
			const values = args.split(",");
			switch (name.toLowerCase()) {
				case "translate":
				case "translate3d":
					add(values[0], false);
					add(values[1], true);
					break;
				case "translatex":
					add(values[0], false);
					break;
				case "translatey":
					add(values[0], true);
					break;
				case "matrix":
					add(values[4], false, "px");
					add(values[5], true, "px");
					break;
				case "matrix3d":
					add(values[12], false, "px");
					add(values[13], true, "px");
					break;
			}
		}
	}

	return translation.x === 0 &&
		translation.y === 0 &&
		translation.xPercent === 0 &&
		translation.yPercent === 0
		? NO_TRANSLATION
		: translation;
}

// `auto` is a declaration only an absolute box acts on ("wherever the
// box would have been"). A relative or fixed box takes no offset on that
// edge.
function applyInsets(
	style: Style,
	element: Element,
	edges: readonly Edge[],
	autoWhenUnset: boolean,
): void {
	for (const edge of edges) {
		const value = toCellLength(
			CSSValues.parseSignedUnitValue(getComputedValue(element, edge)),
			edge === "top" || edge === "bottom",
			element,
		);
		if (value !== null) {
			style.position[edge] = toValue(value);
		} else if (autoWhenUnset) {
			const declared = getComputedValue(element, edge);
			if (declared === "auto" || !declared) {
				style.position[edge] = toValue("auto");
			}
		}
	}
}

// A table cell's vertical-align, as the align-content that places its
// content in the row (css-align-3 §5.1). Any value but these four aligns
// a cell at the baseline (CSS 2.1 §17.5.4).
function getCellAlignment(verticalAlign: string): Align {
	switch (verticalAlign) {
		case "top":
			return "flex-start";
		case "middle":
			return "center";
		case "bottom":
			return "flex-end";
		default:
			return "baseline";
	}
}

// safe/unsafe make no difference on whole cells (the item overflows
// either way). first/last baseline both name the one baseline a cell
// grid has.
const ALIGNMENT_CONSTANTS: Record<string, Align> = {
	normal: "normal",
	stretch: "stretch",
	center: "center",
	baseline: "baseline",
	start: "flex-start",
	end: "flex-end",
	"flex-start": "flex-start",
	"flex-end": "flex-end",
	"self-start": "flex-start",
	"self-end": "flex-end",
	left: "flex-start",
	right: "flex-end",
	"space-between": "space-between",
	"space-around": "space-around",
	"space-evenly": "space-evenly",
};

const JUSTIFY_CONTENT_CONSTANTS: Record<string, Justify> = {
	normal: "normal",
	stretch: "stretch",
	center: "center",
	start: "flex-start",
	end: "flex-end",
	"flex-start": "flex-start",
	"flex-end": "flex-end",
	left: "flex-start",
	right: "flex-end",
	"space-between": "space-between",
	"space-around": "space-around",
	"space-evenly": "space-evenly",
};

function getAlignmentConstant(value: string, fallback: Align): Align {
	if (!value || value === "auto") {
		return fallback;
	}
	const constant = ALIGNMENT_CONSTANTS[CSSValues.parseAlignmentKeyword(value)];
	return constant === undefined ? fallback : constant;
}

function getJustifyContentConstant(value: string): Justify {
	const constant =
		JUSTIFY_CONTENT_CONSTANTS[CSSValues.parseAlignmentKeyword(value)];
	return constant === undefined ? "normal" : constant;
}

// A track's lengths in cells along its axis. The parsed lists are shared,
// so these are copies.
function toCellValue(
	value: CSSValues.Value,
	vertical: boolean,
	element: Element,
): CSSValues.Value {
	return value.unit === "cell"
		? toValue(toCellLength(value.value, vertical, element) as number)
		: value;
}

function toCellBreadth(
	breadth: CSSValues.TrackBreadth,
	vertical: boolean,
	element: Element,
): CSSValues.TrackBreadth {
	return breadth.kind === "length"
		? {kind: "length", value: toCellValue(breadth.value, vertical, element)}
		: breadth;
}

function toCellTrackSize(
	size: CSSValues.TrackSize,
	vertical: boolean,
	element: Element,
): CSSValues.TrackSize {
	return {
		min: toCellBreadth(size.min, vertical, element),
		max: toCellBreadth(size.max, vertical, element),
		...(size.fitContent
			? {fitContent: toCellValue(size.fitContent, vertical, element)}
			: {}),
	};
}

function toCellTrackList(
	list: CSSValues.TrackList,
	vertical: boolean,
	element: Element,
): CSSValues.TrackList {
	if (getCellSize(element) === UNIT_CELL) {
		return list;
	}
	const track = (entry: CSSValues.TrackListTrack) => ({
		names: entry.names,
		size: toCellTrackSize(entry.size, vertical, element),
	});
	return {
		endNames: list.endNames,
		parts: list.parts.map((part) =>
			part.type === "track"
				? {type: "track", track: track(part.track)}
				: {
					type: "repeat",
					repeat: {...part.repeat, tracks: part.repeat.tracks.map(track)},
				},
		),
	};
}

function applyFlexContainer(style: Style, element: Element): void {
	style.flexDirection = parseFlexDirection(
		getComputedValue(element, "flex-direction"),
	);
	style.flexWrap = parseFlexWrap(getComputedValue(element, "flex-wrap"));
	style.justifyContent = getJustifyContentConstant(
		getComputedValue(element, "justify-content"),
	);
	style.alignItems = getAlignmentConstant(
		getComputedValue(element, "align-items"),
		"stretch",
	);
	style.alignContent = getAlignmentConstant(
		getComputedValue(element, "align-content"),
		"flex-start",
	);
}

function applyGridContainer(style: Style, element: Element): void {
	const columns = CSSValues.parseTrackList(
		getComputedValue(element, "grid-template-columns"),
	);
	if (columns) {
		style.gridTemplateColumns = toCellTrackList(columns, false, element);
	}
	const rows = CSSValues.parseTrackList(
		getComputedValue(element, "grid-template-rows"),
	);
	if (rows) {
		style.gridTemplateRows = toCellTrackList(rows, true, element);
	}
	style.gridTemplateAreas = CSSValues.parseGridAreas(
		getComputedValue(element, "grid-template-areas"),
	);
	const autoColumns = CSSValues.parseTrackSizeList(
		getComputedValue(element, "grid-auto-columns"),
	);
	if (autoColumns && autoColumns.length > 0) {
		style.gridAutoColumns = autoColumns.map((size) =>
			toCellTrackSize(size, false, element),
		);
	}
	const autoRows = CSSValues.parseTrackSizeList(
		getComputedValue(element, "grid-auto-rows"),
	);
	if (autoRows && autoRows.length > 0) {
		style.gridAutoRows = autoRows.map((size) =>
			toCellTrackSize(size, true, element),
		);
	}

	const flow = CSSValues.parseGridAutoFlow(
		getComputedValue(element, "grid-auto-flow"),
	);
	style.gridAutoFlowColumn = flow.column;
	style.gridAutoFlowDense = flow.dense;

	style.justifyContent = getJustifyContentConstant(
		getComputedValue(element, "justify-content"),
	);
	style.alignContent = getAlignmentConstant(
		getComputedValue(element, "align-content"),
		"normal",
	);
	style.alignItems = getAlignmentConstant(
		getComputedValue(element, "align-items"),
		"normal",
	);
	style.justifyItems = getAlignmentConstant(
		getComputedValue(element, "justify-items"),
		"normal",
	);
}

function getWidthSizingConstant(value: string): Sizing {
	switch (value) {
		case "min-content":
		case "max-content":
		case "fit-content":
			return value;
		default:
			return "none";
	}
}

// The solver sizes border boxes, so a content-box width gets its edges
// added (css-sizing-3 §5.1). These are the edges the box model resolved,
// so a none/hidden side or a percentage edge adds nothing.
function getContentBoxEdges(element: Element, vertical: boolean): number {
	if (getComputedValue(element, "box-sizing") !== "content-box") {
		return 0;
	}
	const box = getBoxModel(element);
	if (vertical) {
		return (
			box.paddingTop +
			box.paddingBottom +
			box.borderTopWidth +
			box.borderBottomWidth
		);
	}
	return (
		box.paddingLeft +
		box.paddingRight +
		box.borderLeftWidth +
		box.borderRightWidth
	);
}

interface Styling {
	// The layout pass that last styled the node. A node re-added within
	// the pass that styled it is not styled again.
	pass: number;
	// The text style the node measured with. A restyle that keeps it keeps
	// the measurement.
	measureKey: TextStyle;
	// The display layout read, which the style record does not tell apart:
	// a block and an inline-block, or a box and display: contents, style
	// alike and lay out differently.
	display: Display;
}

const stylings = new WeakMap<LayoutNode, Styling>();

interface Extent {
	// The root its rows are counted from: the document's, or the one an
	// inline-block lays its own content out under, whose rows start at 0.
	frame: LayoutNode;
	// The box's own top, in absolute rows of its frame, and its left edge
	// and size, which a repaint compares to find what moved.
	origin: number;
	left: number;
	width: number;
	height: number;
	// The rows the subtree can paint, in rows of its frame. Absolutely
	// positioned children push it outside the box.
	top: number;
	bottom: number;
	// Children whose extent need not follow document order: positioned
	// ones, and display:none ones, whose result.top is never updated. The
	// children are sorted by extent top only when this is 0.
	unstackedChildren: number;
	// Whether the children's extents never move up, top or bottom, in
	// document order, so a binary search can find the ones on some rows.
	rowOrdered: boolean;
	// Where the box and its scrollable overflow reach, from the box's own
	// origin: its border box, and past it the lines it measures and the
	// boxes it holds, unless it clips them (css-overflow-3 §2.2). A fixed
	// box moves with the viewport, so it is no one's overflow.
	overflowRight: number;
	overflowBottom: number;
	// For a box that clips, where its content reaches from its own origin:
	// what it scrolls through. The right edge is null when a line inside
	// took the width it was offered and the true one is unknowable, and
	// both are null when the box's own lines are not broken yet.
	scrollRight: number | null;
	scrollBottom: number | null;
}

// Written after every solve, and read by the painter's row culling for
// every child, so the records are kept and rewritten rather than remade.
// A subtree roundToGrid left alone keeps its record while its top holds.
function getStoredExtent(node: LayoutNode): Extent | undefined {
	return node.extent as Extent | undefined;
}

// The lines a measured box painted at the last paint extents, to tell a
// box laid out again into the same lines from one whose text changed.
const lineRecords = new WeakMap<LayoutNode, BreakResult>();

function computePaintExtents(
	layout: Layout,
	node: LayoutNode,
	originLeft: number,
	originTop: number,
	settled = false,
	fixed = false,
	frame = node,
): Extent {
	const top = originTop + node.grid.top;
	const left = originLeft + node.grid.left;
	let extent = getStoredExtent(node);
	// A box rounding left alone, with nothing under it laid out again, keeps
	// its record while it holds its place and size, though its parent was
	// laid out again around it. A box that measured its lines again was laid
	// out again, so it moved since the last extents. A child that left takes
	// rows with it, so a box that lost one does not keep its record.
	if (
		extent !== undefined &&
		extent.origin === top &&
		extent.frame === frame &&
		(settled ||
			(node.settled &&
				!node.movedSinceExtents &&
				!node.lostChild &&
				extent.left === left &&
				extent.width === getComputedWidth(node) &&
				extent.height === getComputedHeight(node)))
	) {
		return extent;
	}
	fixed ||= node.style.positionType === "fixed";
	let moved = false;
	if (layout.collecting) {
		const lines = node.measure === null
			? undefined
			: getMeasuredLines(layout, node);
		const shifted =
			extent === undefined || extent.origin !== top || extent.left !== left;
		const resized =
			extent !== undefined &&
			(extent.width !== getComputedWidth(node) ||
				extent.height !== getComputedHeight(node));
		moved =
			node.lostChild ||
			((shifted || resized) &&
				(layout.restyledForPaint.has(node.owner as Element) ||
					paintsOwnBox(layout, node))) ||
			(node.measure !== null &&
				(shifted ||
					(!settled &&
						(!node.settled || node.movedSinceExtents) &&
						!isSameLines(node, lineRecords.get(node), lines))));
		if (lines !== undefined) {
			lineRecords.set(node, lines);
		}
	}
	node.lostChild = false;
	if (moved && layout.collecting && extent !== undefined) {
		addDamage(layout, node, extent.top, extent.bottom, fixed);
	}
	if (extent === undefined) {
		extent = {
			frame,
			origin: top,
			left: 0,
			width: 0,
			height: 0,
			top,
			bottom: top,
			unstackedChildren: 0,
			rowOrdered: true,
			overflowRight: 0,
			overflowBottom: 0,
			scrollRight: null,
			scrollBottom: null,
		};
		node.extent = extent;
	}
	let highest = top;
	let lowest = top + getComputedHeight(node);
	let unstacked = 0;
	let right = getComputedWidth(node);
	let bottom = getComputedHeight(node);
	const lines = node.style.clipsOverflow || node.measure === null
		? undefined
		: getMeasuredLines(layout, node);
	if (lines !== undefined) {
		right = Math.max(
			right,
			node.style.border.left + node.result.paddingLeft + lines.maxLineWidth,
		);
		// An inline-block on a line paints its content, which can reach past
		// its own box and the line.
		const contentTop = top + node.style.border.top + node.result.paddingTop;
		for (const [reach, overflow] of getInlineBlockReaches(layout, lines)) {
			highest = Math.min(highest, contentTop + reach);
			lowest = Math.max(lowest, contentTop + overflow);
			bottom = Math.max(bottom, contentTop - top + overflow);
		}
	}
	const clips = node.style.clipsOverflow;
	let scrollRight: number | null = 0;
	let scrollBottom: number | null = 0;
	if (clips && node.measure !== null) {
		const own = getMeasuredLines(layout, node);
		if (own === undefined) {
			scrollRight = scrollBottom = null;
		} else {
			scrollRight =
				node.style.border.left + node.result.paddingLeft + own.maxLineWidth;
			scrollBottom =
				node.style.border.top + node.result.paddingTop + own.totalHeight;
		}
	}
	let rowOrdered = true;
	let previousTop = -Infinity;
	let previousBottom = -Infinity;
	for (const child of node.children) {
		const childExtent = computePaintExtents(
			layout,
			child,
			left,
			top,
			settled || (node.settled && !node.movedSinceExtents),
			fixed,
			frame,
		);
		if (childExtent.top < previousTop || childExtent.bottom < previousBottom) {
			rowOrdered = false;
		}
		previousTop = childExtent.top;
		previousBottom = childExtent.bottom;
		if (clips && scrollBottom !== null && child.style.displayType !== "none") {
			if (scrollRight !== null) {
				scrollRight =
					child.measure !== null &&
						getMeasuredLines(layout, child) === undefined
						? null
						: Math.max(
							scrollRight,
							child.grid.left + childExtent.overflowRight,
						);
			}
			scrollBottom = Math.max(
				scrollBottom,
				child.grid.top + childExtent.overflowBottom,
			);
		}
		if (
			child.style.positionType !== "static" ||
			child.style.displayType === "none"
		) {
			unstacked++;
		}
		if (childExtent.top < highest) {
			highest = childExtent.top;
		}
		if (childExtent.bottom > lowest) {
			lowest = childExtent.bottom;
		}
		if (
			!node.style.clipsOverflow &&
			child.style.displayType !== "none" &&
			child.style.positionType !== "fixed"
		) {
			right = Math.max(right, child.grid.left + childExtent.overflowRight);
			bottom = Math.max(bottom, child.grid.top + childExtent.overflowBottom);
		}
	}
	node.movedSinceExtents = false;
	extent.frame = frame;
	extent.origin = top;
	extent.left = left;
	extent.width = getComputedWidth(node);
	extent.height = getComputedHeight(node);
	extent.top = highest;
	extent.bottom = lowest;
	if (moved && layout.collecting) {
		addDamage(layout, node, highest, lowest, fixed);
	}
	extent.unstackedChildren = unstacked;
	extent.rowOrdered = rowOrdered;
	extent.overflowRight = right;
	extent.overflowBottom = bottom;
	extent.scrollRight = clips ? scrollRight : null;
	extent.scrollBottom = clips ? scrollBottom : null;
	return extent;
}

// The rows each inline-block on these lines paints, from the top of the
// lines: its content box's, reaching as far as what it lays out does.
function *getInlineBlockReaches(
	layout: Layout,
	lines: BreakResult,
	from = 0,
): Generator<[number, number]> {
	for (const line of lines.lines) {
		for (const segment of line.segments) {
			const leaf = segment.leaf;
			if (leaf.type !== "inline-block") {
				continue;
			}
			const top =
				from +
				line.y +
				segment.dy +
				leaf.boxModel.borderTopWidth +
				leaf.boxModel.paddingTop;
			const context = layout.boxes.get(leaf.node)?.independentFormattingContext;
			const extent = context ? getStoredExtent(context) : undefined;
			if (extent !== undefined) {
				yield [top + extent.top, top + extent.bottom];
			} else if (leaf.breakResult !== undefined) {
				yield [top, top + leaf.breakResult.totalHeight];
				yield *getInlineBlockReaches(layout, leaf.breakResult, top);
			}
		}
	}
}

function styleLayoutNode(
	element: Element,
	layoutNode: LayoutNode,
	positionedElements?: Set<Element>,
	pass = 0,
): void {
	const style = createStyle();
	styleLayoutNodeProperties(element, style, positionedElements);
	layoutNode.style = shareStyle(style);
	stylings.set(layoutNode, {
		pass,
		measureKey: getTextStyle(element),
		display: getLayoutDisplay(element),
	});
	layoutNode.invalidate();
}

// A block-level image or canvas with an auto width is as wide as its
// natural size, or as its height through its natural ratio, and does not
// stretch to its container (CSS 2 §10.3.4). Its height then follows from
// the used width in its measure, after max-width has clamped it. In a
// grid, `normal` self-alignment is `start` for a box with a ratio.
function sizeReplacedBox(
	element: Element,
	style: Style,
	display: Display,
): void {
	// On a line, an atomic inline sizes itself; a flex or grid item is
	// blockified and sizes here.
	if (isAtomicInline(display) && !hasItemParent(element)) {
		return;
	}
	const width = CSSValues.parseUnitValue(getComputedValue(element, "width"));
	if (width == null) {
		const box = getBoxModel(element);
		const horizontal =
			box.paddingLeft +
			box.paddingRight +
			box.borderLeftWidth +
			box.borderRightWidth;
		const vertical =
			box.paddingTop +
			box.paddingBottom +
			box.borderTopWidth +
			box.borderBottomWidth;
		const natural = getNaturalSize(element);
		const ratio = getNaturalRatio(element);
		const height = getCellBlockSize(element, "height");
		const contentWidth =
			typeof height === "number" &&
			Number.isFinite(ratio) &&
				ratio > 0
				? Math.max(0, height + getContentBoxEdges(element, true) - vertical) *
				ratio
				: (natural?.width ?? 0);
		style.width = toValue(Math.round(contentWidth) + horizontal);
	}
	const parent = flatParentElement(element);
	if (parent !== null && isGridDisplay(getLayoutDisplay(parent))) {
		if (style.alignSelf === "auto" || style.alignSelf === "normal") {
			style.alignSelf = "flex-start";
		}
		if (style.justifySelf === "auto" || style.justifySelf === "normal") {
			style.justifySelf = "flex-start";
		}
	}
}

// What lays text out beyond the style record: where it breaks, how wide
// it is, and where a line sits in its box.
interface TextStyle {
	whiteSpace: string;
	direction: string;
	wordBreak: string;
	overflowWrap: string;
	textIndent: string;
	textAlign: string;
	textTransform: string;
	letterSpacing: string;
	tabSize: string;
	listStyleType: string;
	listStylePosition: string;
	verticalAlign: string;
	lineHeightRows: number;
}

const TEXT_STYLE: StyleGroup<TextStyle> = {
	name: "text",
	read: (element) => ({
		whiteSpace: getElementWhiteSpace(element),
		direction: getComputedValue(element, "direction"),
		wordBreak: getComputedValue(element, "word-break"),
		overflowWrap: getComputedValue(element, "overflow-wrap"),
		textIndent: getComputedValue(element, "text-indent"),
		textAlign: getComputedValue(element, "text-align"),
		textTransform: getComputedValue(element, "text-transform"),
		letterSpacing: getComputedValue(element, "letter-spacing"),
		tabSize: getComputedValue(element, "tab-size"),
		listStyleType: getComputedValue(element, "list-style-type"),
		listStylePosition: getComputedValue(element, "list-style-position"),
		verticalAlign: getComputedValue(element, "vertical-align"),
		lineHeightRows: getLineHeightRows(
			getComputedValue(element, "line-height"),
			getComputedValue(element, "font-size"),
		),
	}),
};

function getTextStyle(element: Element): TextStyle {
	return getStyleGroup(element, TEXT_STYLE);
}

// Fills a fresh record, so a property the element no longer declares
// falls back to its initial value rather than to the last restyle's.
function styleLayoutNodeProperties(
	element: Element,
	style: Style,
	positionedElements?: Set<Element>,
): void {
	const document = getOwnerDocument(element);
	const window = document && getDefaultView(document);
	if (!window) {
		throw new Error("Element must have an ownerDocument with defaultView");
	}

	const display = getLayoutDisplay(element);
	const overflowX = getUsedOverflow(element, "x");
	const overflowY = getUsedOverflow(element, "y");
	style.clipsOverflow = overflowX !== "visible" || overflowY !== "visible";
	style.scrollContainer =
		isScrollingOverflow(overflowX) || isScrollingOverflow(overflowY);
	// A blockified inline's width applies like any block's. Forced
	// auto, `<span style="width:30ch">` in a flex row came out as wide as its
	// text.
	const parentIsFlex = hasItemParent(element);
	const inlineBox = display === "inline" && !isBlockified(element);
	// An inline box has no size, ratio, margin, padding or border of its
	// own: the record's initial values stand, and the edges are zero.
	if (inlineBox) {
		for (const edge of EDGES) {
			style.margin[edge] = toValue(0);
			style.padding[edge] = toValue(0);
		}
	} else if (isAtomicInline(display) && !parentIsFlex) {
		applyMinMax(style, element);
	} else {
		const widthValue = getComputedValue(element, "width");
		const width = toCellLength(
			CSSValues.parseUnitValue(widthValue),
			false,
			element,
		);
		style.width = toValue(
			typeof width === "number"
				? width + getContentBoxEdges(element, false)
				: (width ?? "auto"),
		);
		style.widthSizing = getWidthSizingConstant(widthValue);

		const height = getCellBlockSize(element, "height");
		style.height = toValue(
			typeof height === "number"
				? height + getContentBoxEdges(element, true)
				: (height ?? "auto"),
		);

		applyMinMax(style, element);
	}

	if (!inlineBox) {
		const ratio = CSSValues.parseAspectRatio(
			getComputedValue(element, "aspect-ratio"),
		);
		// The ratio is of CSS pixels, and layout's is of cells.
		const cell = getCellSize(element);
		style.aspectRatio =
			ratio !== undefined &&
			Number.isFinite(ratio) &&
			ratio > 0
				? (ratio * cell.height) / cell.width
				: NaN;

		// A blockified inline, a flex item or a positioned span, keeps its
		// padding, margin and border like any block (css-display-3 §2.7).
		const padding = getCellPadding(element);
		for (const edge of EDGES) {
			const property = `margin-${edge}`;
			const vertical = edge === "top" || edge === "bottom";
			const margin = vertical
				? getCellBlockMargin(element, edge as "top" | "bottom")
				: toCellLength(
					CSSValues.parseSignedUnitValue(getComputedValue(element, property)),
					false,
					element,
				);
			style.margin[edge] = toValue(
				margin ??
				(getComputedValue(element, property) === "auto" ? "auto" : undefined),
			);
			style.padding[edge] = toValue(padding[edge]);
			// The used width is 0 when the side's style is none or hidden
			// (css-backgrounds §3.3), the same rule as getBoxModel, or the two
			// box models disagree about the same element.
			const borderStyle = getComputedValue(element, `border-${edge}-style`);
			const borderWidth =
				!borderStyle ||
				borderStyle === "none" ||
				borderStyle === "hidden"
					? null
					: toCellBorder(
						CSSValues.parseBorderWidthValue(
							getComputedValue(element, `border-${edge}-width`),
						),
						vertical,
						element,
					);
			style.border[edge] = typeof borderWidth === "number" && borderWidth > 0
				? borderWidth
				: 0;
		}
		applyLegacyAlignment(style, element, display, parentIsFlex);
	}

	for (const edge of getMaskedEdges(element)) {
		style.padding[edge] = toValue(0);
		style.border[edge] = 0;
	}

	// Item properties are consulted only inside a flex or grid container,
	// which is what CSS says of them. Outside one they are read as their
	// initial values without asking the cascade, which is most elements.
	const item = (property: string, initial: string): string =>
		parentIsFlex ? getComputedValue(element, property) : initial;
	const grow = CSSValues.parseCSSNumber(item("flex-grow", "0"));
	style.flexGrow = grow !== null && grow >= 0 ? grow : NaN;
	style.order = CSSValues.parseCSSInteger(item("order", "0")) ?? 0;
	const shrink = CSSValues.parseCSSNumber(item("flex-shrink", "1"));
	style.flexShrink = shrink !== null && shrink >= 0 ? shrink : NaN;

	// A basis runs along the container's main axis.
	const flexBasisText = item("flex-basis", "auto");
	const flexBasis = toCellLength(
		CSSValues.parseUnitValue(flexBasisText),
		parentIsFlex &&
		getComputedValue(boxParentElement(element)!, "flex-direction")
			.startsWith("column"),
		element,
	);
	style.flexBasis = toValue(
		flexBasis ?? (flexBasisText === "auto" ? "auto" : undefined),
	);

	style.alignSelf = getAlignmentConstant(item("align-self", "auto"), "auto");
	style.justifySelf = getAlignmentConstant(
		item("justify-self", "auto"),
		"auto",
	);
	if (isReplacedBox(element) && !inlineBox) {
		sizeReplacedBox(element, style, display);
	}

	for (const [key, property] of GRID_PLACEMENTS) {
		const placement = CSSValues.parseGridPlacement(item(property, "auto"));
		if (placement) {
			style[key] = placement;
		}
	}

	// The gap shorthand is expanded in the cascade. The longhands are
	// enough, and only a flex or grid container has a gap.
	if (hasItemChildren(display)) {
		const rowGap = toCellLength(
			CSSValues.parseUnitValue(getComputedValue(element, "row-gap")),
			true,
			element,
		);
		// Whole rows, as a vertical margin is, so equal gaps draw equal.
		if (typeof rowGap === "number") {
			style.gap.row = Math.max(0, toWholeCells(rowGap));
		}

		const columnGap = toCellLength(
			CSSValues.parseUnitValue(getComputedValue(element, "column-gap")),
			false,
			element,
		);
		if (typeof columnGap === "number") {
			style.gap.column = Math.max(0, columnGap);
		}
	}

	// An absolutely positioned part of a table is a block (css2 §9.7). It
	// leaves the table, and lays out as any positioned box does.
	const outOfFlow =
		getPosition(element) === "absolute" || getPosition(element) === "fixed";
	if (outOfFlow && BLOCKIFIED_TABLE_PARTS.has(display)) {
		style.displayType = "block";
	} else if (display === "none") {
		style.displayType = "none";
	} else if (display === "grid" || display === "inline-grid") {
		style.displayType = "grid";
		applyGridContainer(style, element);
	} else if (display === "flex") {
		style.displayType = "flex";
	} else if (display === "table" || display === "inline-table") {
		applyTableContainer(style, element);
	} else if (display === "table-header-group") {
		style.displayType = "table-header-group";
	} else if (display === "table-footer-group") {
		style.displayType = "table-footer-group";
	} else if (display === "table-row-group") {
		style.displayType = "table-row-group";
	} else if (display === "table-caption") {
		style.displayType = "table-caption";
	} else if (display === "table-column" || display === "table-column-group") {
		// Columns carry style, not a box of their own.
		style.displayType = "none";
	} else if (display === "table-row") {
		style.displayType = "table-row";
	} else if (display === "table-cell") {
		style.displayType = "table-cell";
		style.alignContent = getCellAlignment(getTextStyle(element).verticalAlign);
		// The reflected properties carry HTML's ranges. rowspan 0 ("to the end
		// of the row group") is not implemented. Such a cell covers one row.
		const cell = element as {colSpan?: number; rowSpan?: number};
		style.colSpan = Math.max(1, Math.floor(cell.colSpan ?? 1) || 1);
		style.rowSpan = Math.max(1, Math.floor(cell.rowSpan ?? 1) || 1);
	}

	if (display === "flex" || display === "inline-flex") {
		style.displayType = "flex";
		applyFlexContainer(style, element);
	} else if (
		display !== "none" &&
		display !== "grid" &&
		display !== "inline-grid" &&
		!TABLE_DISPLAYS.has(display)
	) {
		// Displays decided above must not be reset. A caption reset to block
		// is lost to its table, and a hidden element reset keeps painting.
		style.displayType = "block";
	}

	// Only block and list-item join the formatting context around them
	// (css2 §8.3.1, §9.4.1). BODY is the box the document scroll measures the
	// document by, so margins stop there rather than escaping into the
	// viewport. Layout and paint containment give a box its own context
	// (css-contain-2 §3.2).
	style.blockFormattingContext =
		isDocumentElement(element) ||
		getHTMLLocalName(element) === "body" ||
		(display !== "block" && display !== "list-item") ||
		getComputedValue(element, "overflow") !== "visible" ||
		isOutOfFlow(element) ||
		hasLayoutOrPaintContainment(element) ||
		parentIsFlex;

	const position = getPosition(element);
	style.containsPositioned = establishesFixedContainingBlock(element);
	style.translate = getTranslation(element);
	// How the stacking-context painter finds positioned and isolated boxes
	// without an O(document) sweep per frame.
	if (positionedElements) {
		if (position !== "static" || isIsolated(element)) {
			positionedElements.add(element);
		} else {
			positionedElements.delete(element);
		}
	}
	if (position === "absolute") {
		style.positionType = "absolute";
		applyInsets(style, element, INSET_EDGES, true);
	} else if (position === "relative") {
		style.positionType = "relative";
		// Only the start-edge offsets apply. right/bottom alone do not move it.
		applyInsets(style, element, INSET_EDGES.slice(0, 2), false);
	} else if (position === "fixed") {
		// The viewport contains it, and the document scroll is what keeps it
		// still.
		style.positionType = "fixed";
		applyInsets(style, element, INSET_EDGES, false);
	} else if (position === "sticky") {
		style.positionType = "sticky";
		applyInsets(style, element, INSET_EDGES, false);
	} else {
		style.positionType = "static";
	}
}

// Only an out-of-flow box is asked where it would have been, so only it
// carries the static-position function.
function styleNode(
	layout: Layout,
	element: Element,
	layoutNode: LayoutNode,
): void {
	const wasHidden = layoutNode.style.displayType === "none";
	styleLayoutNode(element, layoutNode, layout.positionedElements, layout.pass);
	const context = layout.boxes.get(element)?.independentFormattingContext;
	if (context) {
		styleContextRoot(element, context);
	}
	// Turning on display:none makes the whole subtree box-less, and every
	// path that restyles a box passes through here.
	if (!wasHidden && layoutNode.style.displayType === "none") {
		dropHiddenContent(layout, element);
	}
	if (isOutOfFlow(element)) {
		layoutNode.staticPosition = (containingBlock) =>
			getStaticPosition(layout, element, containingBlock);
	} else if (layoutNode.staticPosition) {
		layoutNode.staticPosition = null;
	}
}

// `node` is a DOM node's principal box. `anonymous` is one contiguous
// run of inline-level flow children of a block container (CSS2
// §9.2.1.1), belonging to no DOM node at all. `table` is the anonymous
// table around table parts a container that is no table holds (CSS2
// §17.2.1).
type BoxKind = "node" | "anonymous" | "table";

// A box either is LAID OUT (it has a layout node the solver sized) or
// is a run MEMBER whose geometry lives in the break result of the run
// around it. `getOwnLayoutNode` tells them apart. Identity outlives derivation:
// a principal box is its node's, an anonymous box is its ordinal among
// its container's runs, and a rebuild syncs against the boxes it
// replaces. That is what lets layout nodes and fragments be keyed by
// box.
export class Box {
	readonly kind: BoxKind;

	// Null for an anonymous box.
	readonly node: Node | null;
	parent: Box | null;

	// The nodes an anonymous box lays out. Owned, never re-derived by a
	// walk. A walk would have to decide where the run ends, which the
	// derivation already decided, from a node that may since have left the
	// tree.
	members: Node[];

	// Null until a derivation has run, which is not the same as none.
	children: Box[] | null;
	heads: Heads | null;
	// The anonymous table each of a container's children falls in, for
	// those that fall in one. The children stay in the container's list,
	// in order, and their layout nodes hang from the table's.
	tables: Map<Box, Box> | null;

	// An inline broken around a block-level box lays out none of its own
	// content. The fragments and the block between them are the container's
	// boxes (css2 §9.2.1.1). Written by the container's enumeration.
	broken: boolean;

	// Holds fragments a broken inline handed over, so children no longer
	// correspond to the child nodes it was written with.
	holdsFragments: boolean;

	// An anonymous box's own layout node. A principal box's lives in
	// nodeMap. Use getOwnLayoutNode rather than either store.
	layoutNode: LayoutNode | null;

	// The element an anonymous box's layout node took its style from. Null
	// while a text node heads the run.
	styledFrom: Element | null;

	// The root an atomic inline's own children lay out under. The run
	// measures the box as one opaque unit, so only the box's own measurement
	// can lay them out, relative to its content edge.
	independentFormattingContext: LayoutNode | null;

	// The lines of the last PLACING measurement. A probe at another width
	// never becomes what the painter sees.
	fragments: BreakResult | null;

	constructor(kind: BoxKind, node: Node | null, parent: Box | null = null) {
		this.parent = null;
		this.members = [];
		this.children = null;
		this.heads = null;
		this.tables = null;
		this.broken = false;
		this.holdsFragments = false;
		this.layoutNode = null;
		this.styledFrom = null;
		this.independentFormattingContext = null;
		this.fragments = null;
		this.kind = kind;
		this.node = node;
		this.parent = parent;
	}

	// The node that opens the box, and so where its styles, if any, come
	// from.
	get head(): Node {
		return this.node ?? this.members[0];
	}

	get container(): Element {
		return this.parent!.node as Element;
	}
}

// The one builder of boxes. Nothing else creates one. Inline content
// lays out in anonymous boxes, one per contiguous run of inline-level
// flow children (CSS2 §9.2.1.1), each a measuring leaf. `heads` maps
// every flow child to the box it falls under, so membership is a lookup
// rather than a walk back through siblings. Box-less elements
// (display:none, out of flow) take no run position and map to the box
// open around them, so nested content still resolves. Redone when a
// mutation drops the container from derivedContainers. The boxes
// themselves are synced, not remade.
function getContainerBox(layout: Layout, container: Element): Box {
	const box = getPrincipalBox(layout, container);
	if (box.children && layout.derivedContainers.has(container)) {
		return box;
	}

	const heads: Array<Node | Box> = [];
	const children: Box[] = [];
	// Matched by ordinal. Only a change to the NUMBER of runs creates or
	// drops a box.
	const previous = (box.children ?? []).filter(
		(child) => child.kind === "anonymous",
	);
	let runCount = 0;
	// The membership each reused box had before this rebuild.
	const opened = new Map<Box, Node[]>();
	let run: Box | null = null;
	box.holdsFragments = false;
	for (const child of flowChildren(layout, container)) {
		if (getNodeType(child) === child.ELEMENT_NODE) {
			const element = child as Element;
			if (getLayoutDisplay(element) === "none" || isOutOfFlow(element)) {
				// Named here so the one path that builds a box reaches them.
				// Neither joins the run around it.
				const own = getPrincipalBox(layout, child, box);
				heads.push(child, run ?? own);
				children.push(own);
				continue;
			}
			// Blockification is included in this check. A flex or grid item is
			// a box of its own, and the run ends at it like any block-level
			// box.
			if (!isInlineLevel(element)) {
				const own = getPrincipalBox(layout, child, box);
				heads.push(child, own);
				children.push(own);
				run = null;
				continue;
			}
		} else if (getNodeType(child) !== child.TEXT_NODE) {
			continue;
		} else if (isSuppressedWhitespace(child as Text)) {
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
		heads.push(child, run);
	}

	// A box whose membership changed measures differently at the same
	// width, and nothing about the space it is offered says so.
	for (const [reused, before] of opened) {
		const now = reused.members;
		if (
			before.length !== now.length ||
			before.some((node, index) => node !== now[index])
		) {
			reused.layoutNode?.invalidate();
		}
	}

	// Runs the container no longer has.
	for (let i = runCount; i < previous.length; i++) {
		dropAnonymousBox(layout, previous[i]);
	}
	box.tables = wrapStrayTableParts(container, box, children);

	// The walk flattens a dissolved element and never names it, so a box
	// it held under an earlier display would outlive the change. A display:
	// contents flip left the old box in place, holding rows nothing removed.
	dropSteppedOver(layout, container);

	for (const child of children) {
		if (child.kind === "anonymous") {
			child.members = fitToLength(child.members);
		}
	}
	box.children = fitToLength(children);
	box.heads = packHeads(heads);
	layout.derivedContainers.add(container);
	return box;
}

// Which box each flow child of a container falls under. Most containers
// hold a few children, kept as node and box in turn, which costs a
// fraction of a map. A container with more keeps a map, so a lookup
// stays one step.
type Heads = Array<Node | Box> | Map<Node, Box>;

const LISTED_HEADS = 8;

function packHeads(pairs: Array<Node | Box>): Heads {
	if (pairs.length <= LISTED_HEADS * 2) {
		return fitToLength(pairs);
	}
	const heads = new Map<Node, Box>();
	for (let i = 0; i < pairs.length; i += 2) {
		heads.set(pairs[i] as Node, pairs[i + 1] as Box);
	}
	return heads;
}

function getHead(heads: Heads, node: Node): Box | undefined {
	if (!Array.isArray(heads)) {
		return heads.get(node);
	}
	for (let i = 0; i < heads.length; i += 2) {
		if (heads[i] === node) {
			return heads[i + 1] as Box;
		}
	}
	return undefined;
}

// A list grown by push keeps room for many more entries than most of
// what layout keeps ever holds, so a list that is kept is copied to its
// length.
function fitToLength<T>(list: T[]): T[] {
	return list.slice();
}

const TABLE_PARTS = new Set<Display>([
	"table-row",
	"table-row-group",
	"table-header-group",
	"table-footer-group",
	"table-cell",
	"table-caption",
	"table-column",
	"table-column-group",
]);

// Consecutive table parts in a container that is no table, row group
// or row share one anonymous table, with the white space and the boxless
// elements between them (CSS2 §17.2.1, rule 3). The table's own layout
// wraps a cell or stray content in the anonymous row and cell around it.
// Matched by ordinal, as runs are.
function wrapStrayTableParts(
	container: Element,
	box: Box,
	children: Box[],
): Map<Box, Box> | null {
	const previous = box.tables === null ? [] : [...new Set(box.tables.values())];
	const display = getLayoutDisplay(container);
	let tables: Map<Box, Box> | null = null;
	let count = 0;
	if (!hasItemChildren(display) && !isTableInternal(display)) {
		let table: Box | null = null;
		let between: Box[] = [];
		for (const child of children) {
			if (child.kind === "node" && isTablePart(child.node!)) {
				if (table === null) {
					table = previous[count] ?? new Box("table", null, box);
					count++;
				}
				tables ??= new Map();
				for (const each of [...between, child]) {
					tables.set(each, table);
				}
				between = [];
			} else if (table !== null && isPassedOver(container, child)) {
				between.push(child);
			} else {
				table = null;
				between = [];
			}
		}
	}
	for (let i = count; i < previous.length; i++) {
		dropTableBox(previous[i]);
	}
	return tables;
}

function isTablePart(node: Node): boolean {
	return getNodeType(node) === node.ELEMENT_NODE &&
		!isOutOfFlow(node) &&
		TABLE_PARTS.has(getUsedDisplay(node as Element));
}

function isTableInternal(display: Display): boolean {
	return display === "table" ||
		display === "inline-table" ||
		display === "table-row" ||
		display === "table-row-group" ||
		display === "table-header-group" ||
		display === "table-footer-group";
}

// What stays inside an anonymous table between two of its parts: white
// space, which renders nothing there, and elements that take no place.
function isPassedOver(container: Element, child: Box): boolean {
	if (child.kind === "anonymous") {
		return !isSpacePreserving(getTextStyle(container).whiteSpace) &&
			child.members.every((member) =>
				getNodeType(member) === member.TEXT_NODE &&
				COLLAPSIBLE_ONLY.test((member as Text).data),
			);
	}
	const node = child.node;
	return node !== null &&
		getNodeType(node) === node.ELEMENT_NODE &&
		(getLayoutDisplay(node as Element) === "none" || isOutOfFlow(node));
}

// The parts go back under the container, or another table, when it next
// places them.
function dropTableBox(box: Box): void {
	const wrapper = box.layoutNode;
	if (wrapper !== null) {
		wrapper.parent?.removeChild(wrapper);
		box.layoutNode = null;
	}
}

function getPrincipalBox(
	layout: Layout,
	node: Node,
	parent: Box | null = null,
): Box {
	let box = layout.boxes.get(node);
	if (!box) {
		box = new Box("node", node);
		layout.boxes.set(node, box);
	}
	if (parent) {
		box.parent = parent;
	}
	return box;
}

function getContainerLayoutNode(
	layout: Layout,
	container: Element,
): LayoutNode | undefined {
	return (
		layout.boxes.get(container)?.independentFormattingContext ??
		layout.nodeMap.get(container)
	);
}

// The children are severed first. They belong to other DOM nodes, which
// keep pointing at them.
function dropLayoutNode(layout: Layout, node: Node): void {
	const layoutNode = layout.nodeMap.get(node);
	if (!layoutNode) {
		return;
	}
	layoutNode.parent?.removeChild(layoutNode);
	while (layoutNode.children.length > 0) {
		layoutNode.removeChild(layoutNode.children[0]);
	}
	layout.measureNodes.delete(layoutNode);
	forgetReads(layoutNode);
	untrackNode(layout, node);
}

// Whether the node is still the KIND of box the element generates:
// measured (a run, a replaced box or a math root) vs boxes of its own,
// and hidden vs not. Neither is fixable by re-measuring. A block image
// that loads after showing its alt text goes from boxes of its own to
// replaced.
function isBoxKindMatch(
	layout: Layout,
	element: Element,
	layoutNode: LayoutNode,
): boolean {
	const hidden = getLayoutDisplay(element) === "none";
	const measured =
		!hidden && (
			isReplacedBox(element) || isMathRoot(element) || isMeasuredAsRun(element)
		);
	if (measured !== layout.measureNodes.has(layoutNode)) {
		return false;
	}
	return hidden === (layoutNode.style.displayType === "none");
}

function dropAnonymousBox(layout: Layout, box: Box): void {
	const layoutNode = box.layoutNode;
	box.layoutNode = null;
	box.fragments = null;
	if (!layoutNode) {
		return;
	}
	layoutNode.parent?.removeChild(layoutNode);
	layout.measureNodes.delete(layoutNode);
	forgetReads(layoutNode);
	layout.anonymousBoxes.delete(layoutNode);
	layoutNode.owner = null;
	releaseCache(layoutNode);
}

function getBox(layout: Layout, node: Node): Box | null {
	const entry = getBoxEntry(layout, node);
	return entry?.kind === "anonymous" ? entry : null;
}

function getBoxEntry(layout: Layout, node: Node): Box | null {
	if (!flatIsConnected(node)) {
		return null;
	}

	if (getNodeType(node) === node.ELEMENT_NODE) {
		const element = node as Element;
		// USED display. An out-of-flow element heads no run and joins none.
		// When run invalidation gave it a bare layout node, later rebuilds
		// skipped its full build and its pseudo-only content vanished on a
		// class flip.
		if (!isInlineLevel(element)) {
			return null;
		}
	} else if (getNodeType(node) !== node.TEXT_NODE) {
		return null;
	}

	const container = getRunContainer(layout, node);
	if (!container) {
		return getPrincipalBox(layout, node);
	}
	const heads = getContainerBox(layout, container).heads!;
	// Up to whichever ancestor the container counts among its flow
	// children.
	for (let current: Node = node; current !== container;) {
		const entry = getHead(heads, current);
		if (entry) {
			return entry;
		}
		const parent = getBoxParentElement(current);
		if (!parent) {
			return getPrincipalBox(layout, current);
		}
		current = parent;
	}
	return getPrincipalBox(layout, node);
}

function getOwnLayoutNode(layout: Layout, box: Box): LayoutNode | null {
	if (box.kind !== "node") {
		return box.layoutNode;
	}
	return box.node === null ? null : (layout.nodeMap.get(box.node) ?? null);
}

function runLayoutNode(layout: Layout, node: Node): LayoutNode | undefined {
	const box = getBox(layout, node);
	if (box) {
		return box.head === node ? (box.layoutNode ?? undefined) : undefined;
	}
	return layout.nodeMap.get(node);
}

function runBreakResult(layout: Layout, node: Node): BreakResult | undefined {
	const box = getBox(layout, node);
	if (box) {
		return box.head === node ? (box.fragments ?? undefined) : undefined;
	}
	return layout.boxes.get(node)?.fragments ?? undefined;
}

// Bring a container's layout children into line with its box list.
// Positions are counted, not searched. A box sits after every earlier
// box of the container that reached the layout tree.
function syncContainerRuns(layout: Layout, container: Element): void {
	layout.dirtyRunContainers.delete(container);
	if (
		getLayoutDisplay(container) === "none" ||
		isHiddenByAncestor(layout, container)
	) {
		// The only pass that ever visits a hidden container.
		dropHiddenContent(layout, container);
		return;
	}
	// A broken inline's fragments are the CONTAINER's boxes (CSS2
	// §9.2.1.1). Taking them here would steal them from the container that
	// places them.
	if (isSplitAroundBlock(container)) {
		return;
	}

	const containerFlex = getContainerLayoutNode(layout, container);
	if (!containerFlex || containerFlex.measure) {
		// One box holds all of it, except an out-of-flow box, which no box
		// list names and no run walk finds. This is the derivation that reaches
		// it.
		if (containerFlex || getBox(layout, container)) {
			dropRunContent(layout, container);
		}
		return;
	}

	const containerBox = getContainerBox(layout, container);
	const children = containerBox.children!;
	let index = 0;
	let table: Box | null = null;
	let partIndex = 0;
	for (const entry of children) {
		const wrapping = containerBox.tables?.get(entry) ?? null;
		if (wrapping !== table) {
			if (table !== null) {
				dropUnplacedParts(table.layoutNode!, partIndex);
			}
			table = wrapping;
			partIndex = 0;
			if (table !== null) {
				placeTableBox(containerFlex, table, index);
				index++;
			}
		}
		if (table !== null) {
			const wrapper = table.layoutNode!;
			if (entry.kind === "anonymous") {
				dropAnonymousBox(layout, entry);
				continue;
			}
			const node = entry.node!;
			const kept = layout.nodeMap.get(node);
			if (kept?.parent !== wrapper || isTouched(layout, node)) {
				addNode(layout, node, wrapper, null);
			}
			const layoutNode = layout.nodeMap.get(node);
			if (!isOutOfFlow(node) && layoutNode?.parent === wrapper) {
				if (wrapper.children[partIndex] !== layoutNode) {
					wrapper.removeChild(layoutNode);
					insertChild(wrapper, layoutNode, partIndex);
				}
				partIndex++;
			}
			continue;
		}
		if (entry.kind === "anonymous") {
			let layoutNode = entry.layoutNode;
			// A flex or grid item measured as a run is that item's box. In a
			// block, a run is an anonymous box, which takes nothing from the
			// element it starts with.
			const styledFrom =
				getNodeType(entry.head) === entry.head.ELEMENT_NODE &&
				hasItemChildren(getLayoutDisplay(container))
					? (entry.head as Element)
					: null;
			// A run that changes hands starts fresh rather than keeping the
			// last head's margins and flex factors.
			if (layoutNode && entry.styledFrom !== styledFrom) {
				dropAnonymousBox(layout, entry);
				layoutNode = null;
			}
			if (!layoutNode) {
				layoutNode = new LayoutNode(layout.cachePool);
				entry.layoutNode = layoutNode;
				entry.styledFrom = styledFrom;
				if (styledFrom) {
					styleLayoutNode(styledFrom, layoutNode, layout.positionedElements);
				}
				layoutNode.measure = recordReads(
					layout,
					layoutNode,
					(width, widthSpace, placing, left) =>
						measureInlineRun(layout, entry, width, widthSpace, placing, left),
				);
				layout.measureNodes.add(layoutNode);
				layout.anonymousBoxes.set(layoutNode, entry);
				layoutNode.owner = entry.head;
			} else if (layoutNode.owner !== entry.head) {
				layoutNode.owner = entry.head;
			}
			if (containerFlex.children[index] !== layoutNode) {
				layoutNode.parent?.removeChild(layoutNode);
				insertChild(containerFlex, layoutNode, index);
			}
			index++;
			syncRunMembers(layout, entry);
			continue;
		}
		// A box a fresh build would have made differently is remade, and one
		// whose own box changed is re-derived onto its node. The rest keep
		// their nodes and only move into place.
		const node = entry.node!;
		const kept = layout.nodeMap.get(node);
		if (kept?.parent !== containerFlex || isTouched(layout, node)) {
			addNode(layout, node, containerFlex, null);
		}
		// An out-of-flow box hangs from its containing block, which the build
		// above hoisted it to, and takes no place among the boxes counted here.
		if (isOutOfFlow(node)) {
			continue;
		}
		const layoutNode = layout.nodeMap.get(node);
		if (layoutNode && layoutNode.parent === containerFlex) {
			// DOM siblings know nothing of the anonymous boxes between them, so
			// the position is decided here, with the whole list available.
			if (containerFlex.children[index] !== layoutNode) {
				containerFlex.removeChild(layoutNode);
				insertChild(containerFlex, layoutNode, index);
			}
			index++;
		}
	}

	if (table !== null) {
		dropUnplacedParts(table.layoutNode!, partIndex);
	}

	// Children the box list does not name, left past its end by the
	// reordering above. A node that moved under a display:none ancestor is
	// never re-placed, and a container that kept it would go on laying it
	// out.
	for (let i = containerFlex.children.length - 1; i >= index; i--) {
		const child = containerFlex.children[i];
		const node = child.owner as Node | undefined;
		if (node && isOutOfFlow(node)) {
			continue;
		}
		containerFlex.removeChild(child);
	}
}

function placeTableBox(
	containerFlex: LayoutNode,
	table: Box,
	index: number,
): void {
	let wrapper = table.layoutNode;
	if (!wrapper) {
		wrapper = new LayoutNode(containerFlex.pool);
		const style = createStyle();
		style.displayType = "table";
		wrapper.style = style;
		table.layoutNode = wrapper;
	}
	if (containerFlex.children[index] !== wrapper) {
		wrapper.parent?.removeChild(wrapper);
		insertChild(containerFlex, wrapper, index);
	}
}

function dropUnplacedParts(wrapper: LayoutNode, count: number): void {
	for (let i = wrapper.children.length - 1; i >= count; i--) {
		const child = wrapper.children[i];
		const node = child.owner as Node | undefined;
		if (node && isOutOfFlow(node)) {
			continue;
		}
		wrapper.removeChild(child);
	}
}

// One run measures the members as a single unit, so no box under them
// is laid out. This is also the only path that finds an out-of-flow box
// written among them.
function syncRunMembers(layout: Layout, run: Box): void {
	for (const member of run.members) {
		if (getNodeType(member) !== member.ELEMENT_NODE) {
			continue;
		}
		const element = member as Element;
		if (isOutOfFlow(element)) {
			addNode(layout, element, null);
			continue;
		}
		// Whether it lays its content out under a root of its own follows
		// its display as it is now. A root it keeps is restyled with it.
		if (
			needsContextRoot(element) !==
			Boolean(getPrincipalBox(layout, element).independentFormattingContext)
		) {
			syncIndependentFormattingContext(layout, element);
		}
		// A member is measured by its run, and has no box of its own for a
		// node to describe. One left from an earlier shape answers for where
		// the element was.
		dropLayoutNode(layout, element);
		dropRunContent(layout, element);
	}
}

// The flat parent, skipping elements that generate no box. A projected
// node's box lives under the slot's own box parent.
function getBoxParentElement(node: Node): Element | null {
	let parent = flatParentElement(node);
	while (parent !== null && isDisplayContents(parent)) {
		parent = flatParentElement(parent);
	}
	return parent;
}

function getRunContainer(layout: Layout, node: Node): Element | null {
	const parent = getBoxParentElement(node);
	if (!parent) {
		return null;
	}
	const startsOwnRun =
		getNodeType(node) === node.ELEMENT_NODE && !isInlineBox(node as Element);
	return getRunContainerFromParent(layout, parent, startsOwnRun);
}

// getRunContainer for a node whose box parent is known without the
// node. This is how a removed node, with no parent left to climb from,
// is handled.
function getRunContainerFromParent(
	layout: Layout,
	box: Element,
	startsOwnRun: boolean,
): Element | null {
	for (
		let current: Element | null = box;
		current;
		current = getBoxParentElement(current)
	) {
		if (isOutOfFlow(current)) {
			return current;
		}
		// An inline box is transparent. Its content belongs to the run around
		// it.
		if (isInlineBox(current)) {
			continue;
		}
		const display = getLayoutDisplay(current);
		if (isAtomicInline(display)) {
			// An atomic inline nested in one starts a run there rather than
			// joining the run its host is in.
			if (
				layout.boxes.get(current)?.independentFormattingContext || startsOwnRun
			) {
				return current;
			}
			continue;
		}
		return current;
	}
	return null;
}

function isReachableFrom(from: LayoutNode | null, target: LayoutNode): boolean {
	for (let node = from; node !== null; node = node.parent) {
		if (node === target) {
			return true;
		}
	}
	return false;
}

// `known` is the anonymous run box holding the node, or null when the
// node has a box of its own, from a caller that has the container's box
// list in hand. Undefined asks for it, which climbs to the container.
// `shownAncestors` is set by a parent adding its own children, having
// been shown itself.
function addNode(
	layout: Layout,
	node: Node,
	parentLayoutNode: LayoutNode | null = null,
	known?: Box | null,
	shownAncestors = false,
): void {
	// Fresh builds never descend past a display:none boundary, and rebuild
	// sweeps must not bring descendants back in under it.
	if (!shownAncestors && isHiddenByAncestor(layout, node)) {
		dropLayoutNode(layout, node);
		if (getNodeType(node) === node.ELEMENT_NODE) {
			dropHiddenContent(layout, node as Element);
		}
		return;
	}

	// A rebuild must not resurrect a stale box from an earlier display
	// value. A display:contents element's children re-add as the box
	// parent's own.
	if (getNodeType(node) === node.ELEMENT_NODE && isDisplayContents(node)) {
		dropLayoutNode(layout, node);
		// The container learns of the dissolved children only by enumerating.
		const container = getRunContainer(layout, node);
		if (container) {
			layout.derivedContainers.delete(container);
			layout.dirtyRunContainers.add(container);
		}
		return;
	}
	// An out-of-flow box stays where it is for its containing block to reach
	// down to, unless the two are in different layout trees (an independent
	// formatting context's block cannot reach in). Then the box moves.
	if (isOutOfFlow(node)) {
		const containingBlock = getPosition(node as Element) === "fixed"
			? layout.initialBlock
			: getContainingBlockLayoutNode(layout, node as Element);
		if (
			containingBlock && !isReachableFrom(parentLayoutNode, containingBlock)
		) {
			parentLayoutNode = containingBlock;
		}
	}

	// A measure-function node owns no layout children. Inserting under one
	// leaves a node the flex engine never lays out, with extent 0..0, which
	// paint culling reads as nothing to draw. An <input> alone inside an
	// inline-block painted nothing while the same input beside a letter of
	// text painted fine.
	if (parentLayoutNode?.measure) {
		const stale = layout.nodeMap.get(node);
		if (stale && stale.parent === parentLayoutNode) {
			parentLayoutNode.removeChild(stale);
			layout.measureNodes.delete(stale);
			forgetReads(stale);
			untrackNode(layout, node);
		}
		return;
	}

	if (layout.nodeMap.has(node)) {
		const existingLayoutNode = layout.nodeMap.get(node)!;
		// A node left from when this content was block-level is dropped, so
		// the anonymous box is the only thing measuring it.
		if (
			isInlineLevel(node) &&
			(known !== undefined ? known : getBox(layout, node))
		) {
			dropLayoutNode(layout, node);
			if (getNodeType(node) === node.ELEMENT_NODE) {
				addElementNode(layout, node as Element, parentLayoutNode, known);
			} else {
				addTextNode(layout, node as Text, parentLayoutNode, known);
			}
			return;
		}
		// Reuse is only sound while the node is the same KIND of box. A run
		// member flipped out of flow keeps a run measure that skips out-of-flow
		// boxes, measures 0x0, and silently vanishes.
		if (existingLayoutNode && getNodeType(node) === node.ELEMENT_NODE) {
			const element = node as Element;
			if (!isBoxKindMatch(layout, element, existingLayoutNode)) {
				dropLayoutNode(layout, node);
				addElementNode(layout, element, parentLayoutNode);
				return;
			}
			// Whatever moved the node may also have restyled it, unless this
			// pass already styled it.
			if (stylings.get(existingLayoutNode)?.pass !== layout.pass) {
				styleNode(layout, element, existingLayoutNode);
			}
			// A kept box is re-derived exactly as if built from scratch.
			if (isMeasuredAsRun(element)) {
				syncIndependentFormattingContext(layout, element);
				dropRunContent(layout, element);
			}
		}
		if (existingLayoutNode && parentLayoutNode) {
			const currentParent = existingLayoutNode.parent;
			if (currentParent !== parentLayoutNode) {
				if (currentParent) {
					currentParent.removeChild(existingLayoutNode);
				}
				// Appended. The container's box list decides the order.
				insertChild(
					parentLayoutNode,
					existingLayoutNode,
					parentLayoutNode.children.length,
				);
				const container = getRunContainer(layout, node);
				if (container) {
					layout.dirtyRunContainers.add(container);
				}
			}
		}
		return;
	}

	if (getNodeType(node) === node.ELEMENT_NODE) {
		addElementNode(layout, node as Element, parentLayoutNode, known);
	} else if (getNodeType(node) === node.TEXT_NODE) {
		addTextNode(layout, node as Text, parentLayoutNode, known);
	}
}

function addElementNode(
	layout: Layout,
	element: Element,
	parentLayoutNode: LayoutNode | null = null,
	known?: Box | null,
): void {
	const display = getLayoutDisplay(element);
	const asRun = isMeasuredAsRun(element);

	if (asRun) {
		const box = known !== undefined ? known : getBox(layout, element);
		if (box) {
			invalidateBox(layout, box);
			layout.dirtyRunContainers.add(box.container);
			syncIndependentFormattingContext(layout, element);
			dropRunContent(layout, element);
			return;
		}
		// No anonymous box holds it (a flex container's blockified
		// children). Its own box lays it out below.
	}

	// Appended. The container's box list decides the order.
	const flexIndex = parentLayoutNode?.children.length ?? 0;

	let layoutNode = layout.nodeMap.get(element);
	if (!layoutNode) {
		layoutNode = new LayoutNode(layout.cachePool);
		trackNode(layout, element, layoutNode);
	}

	styleNode(layout, element, layoutNode);

	if (display === "none") {
		if (layoutNode && parentLayoutNode) {
			placeChild(parentLayoutNode, layoutNode, flexIndex);
		}
		return;
	} else if (isReplacedBox(element)) {
		layoutNode.measuresText = false;
		layoutNode.measure = recordReads(layout, layoutNode, (width, widthSpace) =>
			measureReplaced(element, width, widthSpace),
		);
		layout.measureNodes.add(layoutNode);
		if (parentLayoutNode) {
			placeChild(parentLayoutNode, layoutNode, flexIndex);
		}
		return;
	} else if (isMathRoot(element)) {
		layoutNode.measure = recordReads(layout, layoutNode, () => {
			const box = measureMath(layout, element);
			return {width: box.width, height: box.height};
		});
		layout.measureNodes.add(layoutNode);
		if (parentLayoutNode) {
			placeChild(parentLayoutNode, layoutNode, flexIndex);
		}
		return;
	} else if (asRun) {
		const box = getPrincipalBox(layout, element);
		layoutNode.measure = recordReads(
			layout,
			layoutNode,
			(width, widthSpace, placing, left) =>
				measureInlineRun(layout, box, width, widthSpace, placing, left),
		);
		layout.measureNodes.add(layoutNode);

		if (layoutNode && parentLayoutNode) {
			placeChild(parentLayoutNode, layoutNode, flexIndex);
		}

		syncIndependentFormattingContext(layout, element);
		dropRunContent(layout, element);
		return;
	}

	// A independent formatting context left behind would go on claiming the
	// same children.
	dropIndependentFormattingContext(getPrincipalBox(layout, element));

	// Only DIRECT children. A broken inline's boxes reach the tree through
	// this container's own box reconciliation. The container's box list
	// says which run each child falls in, so no child climbs to find out.
	// An out-of-flow child heads no run whatever the list says of it.
	const heads = flatIsConnected(element)
		? getContainerBox(layout, element).heads
		: null;
	for (const child of flowContent(element)) {
		if (
			getNodeType(child) === child.ELEMENT_NODE ||
			getNodeType(child) === child.TEXT_NODE
		) {
			let known: Box | null | undefined;
			const entry = heads === null ? undefined : getHead(heads, child);
			if (entry !== undefined && !isOutOfFlow(child)) {
				known = entry.kind === "anonymous" ? entry : null;
			}
			addNode(layout, child, layoutNode, known, true);
		}
	}

	// Here rather than in performLayout's drain. A container built from
	// inside a measure is laid out the moment the measure returns, with no
	// drain in between.
	if (layout.dirtyRunContainers.has(element)) {
		syncContainerRuns(layout, element);
	}

	if (layoutNode && parentLayoutNode) {
		placeChild(parentLayoutNode, layoutNode, flexIndex);
		// The index counted DOM siblings, which know nothing of the anonymous
		// boxes between them. The container's box list decides the order.
		const container = getRunContainer(layout, element);
		if (container) {
			layout.dirtyRunContainers.add(container);
		}
	}
}

function addTextNode(
	layout: Layout,
	text: Text,
	parentLayoutNode: LayoutNode | null = null,
	known?: Box | null,
): void {
	if (!parentLayoutNode) {
		return;
	}

	if (isSuppressedWhitespace(text)) {
		return;
	}

	const box = known !== undefined ? known : getBox(layout, text);
	if (box) {
		invalidateBox(layout, box);
		layout.dirtyRunContainers.add(box.container);
		return;
	}

	let layoutNode = layout.nodeMap.get(text);
	if (!layoutNode) {
		layoutNode = new LayoutNode(layout.cachePool);
		trackNode(layout, text, layoutNode);
	}

	const own = getPrincipalBox(layout, text);
	layoutNode.measure = recordReads(
		layout,
		layoutNode,
		(width, widthSpace, placing, left) =>
			measureInlineRun(layout, own, width, widthSpace, placing, left),
	);
	layout.measureNodes.add(layoutNode);

	insertChild(parentLayoutNode, layoutNode, parentLayoutNode.children.length);
}

// Sees THROUGH an inline wrapping block-level content (CSS2 §9.2.1.1).
// <p><span>a<div>b</div>c</span></p> gives the paragraph THREE boxes.
// The wrapper is yielded before its children because it heads the first
// fragment's run. <a href><div>card</div></a> is this shape. Without the
// split, everything from the block onward rendered as nothing.
function flowChildren(
	layout: Layout,
	container: Element,
	into: Node[] = [],
	root = container,
): Node[] {
	for (const child of flowContent(container)) {
		into.push(child);
		if (getNodeType(child) !== child.ELEMENT_NODE) {
			continue;
		}
		// Written on the way past. Paint culling asks per element per frame,
		// and re-walking an inline's subtree there costs every off-screen row.
		const splits = isSplitAroundBlock(child as Element);
		getPrincipalBox(layout, child).broken = splits;
		if (splits) {
			getPrincipalBox(layout, root).holdsFragments = true;
			flowChildren(layout, child as Element, into, root);
		}
	}
	return into;
}

// The box each independent formatting context's root lays content out
// for, which places the root's rows on a line of its own frame.
const contextHosts = new WeakMap<LayoutNode, Element>();

// An inline-grid or inline-table always lays its own content out,
// because a line cannot contain a grid or a table piecemeal. An
// inline-block does so only once it holds a block-level box. Never a
// plain inline: it is broken instead, and taking its content here would
// steal back the container's boxes. Only a run's measure lays the root
// out, so a box no run measures, as an out-of-flow one, lays its content
// out on its own node.
function needsContextRoot(element: Element): boolean {
	const display = getLayoutDisplay(element);
	return (
		establishesIndependentFormattingContext(element) &&
		isMeasuredAsRun(element) &&
		(display === "inline-grid" ||
			display === "inline-table" ||
			hasBlockLevelBox(element))
	);
}

// An inline-block is measured as ONE unit by its run, and a run ends at
// a block-level box, so block content inside it is laid out by the box's
// own measurement. Only the run that placed the box knows its content
// edge.
function syncIndependentFormattingContext(
	layout: Layout,
	element: Element,
): void {
	const box = getPrincipalBox(layout, element);
	if (!needsContextRoot(element)) {
		if (box.independentFormattingContext) {
			dropIndependentFormattingContext(box);
			invalidateOutOfFlowDescendants(layout, element);
		}
		return;
	}

	let root = box.independentFormattingContext;
	if (!root) {
		root = new LayoutNode(layout.cachePool);
		box.independentFormattingContext = root;
		contextHosts.set(root, element);
		// What it holds moves under another root, so an out-of-flow box among
		// it may no longer reach its containing block from where it hangs.
		invalidateOutOfFlowDescendants(layout, element);
		// A change inside, a restyle no run records, leaves the box's
		// measure answering with the old size unless the box hears of it.
		root.onStale = () => {
			layout.staleHosts.add(element);
		};
		styleContextRoot(element, root);
	}

	for (const child of flowContent(element)) {
		if (getNodeType(child) === child.ELEMENT_NODE) {
			// The box's children have it as their parent, as a container's
			// enumeration gives them: a blockified inline among them paints
			// its own lines from it.
			getPrincipalBox(layout, child, box);
			addNode(layout, child, root);
		} else if (getNodeType(child) === child.TEXT_NODE) {
			addNode(layout, child, root);
		}
	}

	// The measure laying this root out may be running right now. Its boxes
	// have to be in it before that measure returns.
	if (layout.dirtyRunContainers.has(element)) {
		syncContainerRuns(layout, element);
	}
}

// The root IS the box's formatting context, so it gets the display and
// the grid or table container properties, from the element as it is now.
// The element's own node is the run's.
function styleContextRoot(element: Element, root: LayoutNode): void {
	const display = getLayoutDisplay(element);
	const style = createStyle();
	style.blockFormattingContext = true;
	style.displayType = "block";
	if (display === "inline-table") {
		applyTableContainer(style, element);
	} else if (display === "inline-grid" || display === "inline-flex") {
		// The root holds the box's content, so it lays its children out as
		// the box would: an inline-flex box's children are flex items, not
		// blocks stacked in turn.
		if (display === "inline-grid") {
			style.displayType = "grid";
			applyGridContainer(style, element);
		} else {
			style.displayType = "flex";
			applyFlexContainer(style, element);
		}
		const gaps: Array<[string, Gutter]> = [
			["row-gap", "row"],
			["column-gap", "column"],
		];
		for (const [property, gutter] of gaps) {
			const gap = toCellLength(
				CSSValues.parseUnitValue(getComputedValue(element, property)),
				gutter === "row",
				element,
			);
			style.gap[gutter] = typeof gap === "number" ? Math.max(0, gap) : 0;
		}
	}
	root.style = style;
	root.invalidate();
}

function dropIndependentFormattingContext(box: Box): void {
	const root = box.independentFormattingContext;
	if (!root) {
		return;
	}
	box.independentFormattingContext = null;
	// The children stay tracked in nodeMap, so only the root is dropped.
	while (root.children.length > 0) {
		root.removeChild(root.children[0]);
	}
}

// Layout never descends past a display:none boundary, so a node built
// while the subtree was visible goes on returning stale geometry from
// getRect until dropped.
function dropHiddenContent(layout: Layout, element: Element): void {
	dropContainerBoxes(layout, element);
	const box = layout.boxes.get(element);
	if (box) {
		dropIndependentFormattingContext(box);
	}
	for (const child of flatChildren(element)) {
		dropLayoutNode(layout, child);
		if (getNodeType(child) === child.ELEMENT_NODE) {
			dropHiddenContent(layout, child as Element);
		}
	}
}

// A box list left in place is what the next read uses.
function dropContainerBoxes(layout: Layout, element: Element): void {
	const box = layout.boxes.get(element);
	if (box?.children) {
		for (const child of box.children) {
			if (child.kind === "anonymous") {
				dropAnonymousBox(layout, child);
			}
		}
		for (const table of new Set(box.tables?.values())) {
			dropTableBox(table);
		}
		box.tables = null;
		box.children = null;
		box.heads = null;
	}
	layout.dirtyRunContainers.delete(element);
}

// A run measures everything inside it as one unit, so no box in there
// keeps a layout node. One left over is laid out a second time, in a
// box the tree no longer has. Boxes the run does not measure are left
// alone: out-of-flow boxes (hoisted instead) and atomic inlines with
// independent formatting contexts.
function dropRunContent(layout: Layout, element: Element): void {
	if (layout.boxes.get(element)?.independentFormattingContext) {
		return;
	}
	dropContainerBoxes(layout, element);
	for (let node = flowNext(element, element, false); node !== null;) {
		if (getNodeType(node) === node.ELEMENT_NODE) {
			const child = node as Element;
			if (isOutOfFlow(child)) {
				addNode(layout, child, null);
				node = flowNext(node, element, true);
				continue;
			}
			if (layout.boxes.get(child)?.independentFormattingContext) {
				node = flowNext(node, element, true);
				continue;
			}
			dropContainerBoxes(layout, child);
		}
		dropLayoutNode(layout, node);
		node = flowNext(node, element, false);
	}
}

// Retire the boxes of elements the enumeration saw THROUGH: dissolved
// ones, and inline boxes, which a block inside breaks. A dissolved one
// generates no box, and one left in place is laid out from a shape the
// container no longer has. The walk descends where the enumeration
// does, into every inline box, since one that held a block before this
// derivation may hold none now.
function dropSteppedOver(layout: Layout, parent: Element): void {
	for (const child of flatChildren(parent)) {
		if (getNodeType(child) !== child.ELEMENT_NODE) {
			continue;
		}
		const element = child as Element;
		const dissolves = isDisplayContents(element);
		if (!dissolves && !isInlineBox(element)) {
			continue;
		}
		// addNode drops the box of a box-less element.
		if (dissolves && layout.nodeMap.has(element)) {
			addNode(layout, element, null);
		}
		dropSteppedOver(layout, element);
	}
}

// The hoist that makes absolute positioning containing-block-correct
// (the solver's absolute type only knows its parent) and frees an
// absolute box from a measure-function subtree. Paint order is
// unaffected. The stacking-context painter never uses flex order for
// positioned boxes.
function getContainingBlockLayoutNode(
	layout: Layout,
	element: Element,
): LayoutNode | null {
	for (
		let ancestor = flatParentElement(element);
		ancestor;
		ancestor = flatParentElement(ancestor)
	) {
		if (
			getPosition(ancestor) !== "static" ||
			establishesFixedContainingBlock(ancestor)
		) {
			const layoutNode = layout.nodeMap.get(ancestor);
			// A measure-function node cannot take flex children, so a
			// positioned inline-block cannot serve, and the hoist keeps
			// climbing.
			if (layoutNode && !layoutNode.measure) {
				return layoutNode;
			}
		}
	}
	return layout.nodeMap.get(layout.rootElement) ?? null;
}

function isHiddenByAncestor(layout: Layout, node: Node): boolean {
	const memo = layout.hiddenElements;
	const unknown: Element[] = [];
	let hidden = false;
	for (
		let ancestor = flatParentElement(node);
		ancestor;
		ancestor = flatParentElement(ancestor)
	) {
		const known = memo?.get(ancestor);
		if (known !== undefined) {
			hidden = known;
			break;
		}
		unknown.push(ancestor);
		if (getLayoutDisplay(ancestor) === "none") {
			hidden = true;
			break;
		}
	}
	if (memo !== null) {
		for (const element of unknown) {
			memo.set(element, hidden);
		}
	}
	return hidden;
}

function getLayoutRoot(node: LayoutNode): LayoutNode {
	let root = node;
	while (root.parent !== null) {
		root = root.parent;
	}
	return root;
}

// Coordinates under an independent formatting context start at the box that owns
// it: the ancestor whose root the node was actually laid out under, not the
// nearest one. An out-of-flow descendant hangs from its containing block
// instead.
function getDocumentPosition(
	layout: Layout,
	node: Node,
	layoutNode: LayoutNode,
): {x: number; y: number} {
	const position = getAbsolutePosition(layout, layoutNode);
	let root = layoutNode;
	for (let parent = root.parent; parent; parent = root.parent) {
		root = parent;
	}
	if (root === layout.initialBlock) {
		return position;
	}
	let host: Element | null = null;
	for (
		let current = getBoxParentElement(node);
		current && !host;
		current = getBoxParentElement(current)
	) {
		if (layout.boxes.get(current)?.independentFormattingContext === root) {
			host = current;
		}
	}
	const hostRect = host && layout.getRect(host);
	if (!host || !hostRect) {
		return position;
	}
	const boxModel = getBoxModel(host);
	return {
		x:
			position.x + hostRect.x + boxModel.borderLeftWidth + boxModel.paddingLeft,
		y: position.y + hostRect.y + boxModel.borderTopWidth + boxModel.paddingTop,
	};
}

// A node already under this parent is MOVED. A build that reaches the
// same element twice would otherwise hold it twice and lay its box out
// twice.
function placeChild(
	parent: LayoutNode,
	child: LayoutNode,
	index: number,
): void {
	if (child.parent === parent) {
		if (getChildIndex(parent, child) === index) {
			return;
		}
		parent.removeChild(child);
	}
	insertChild(parent, child, index);
}

function trackNode(
	layout: Layout,
	domNode: Node,
	layoutNode: LayoutNode,
): void {
	layout.nodeMap.set(domNode, layoutNode);
	layoutNode.owner = domNode;
}

function untrackNode(layout: Layout, domNode: Node): void {
	const layoutNode = layout.nodeMap.get(domNode);
	if (layoutNode) {
		layoutNode.owner = null;
		forgetReads(layoutNode);
		releaseCache(layoutNode);
	}
	// The lines are the product of the layout node that is being removed,
	// and would describe a box that no longer exists.
	const box = layout.boxes.get(domNode);
	if (box) {
		box.fragments = null;
	}
	layout.nodeMap.delete(domNode);
	if (getNodeType(domNode) === domNode.ELEMENT_NODE) {
		layout.positionedElements.delete(domNode as Element);
	}
}

// The first flat-tree child that can start an inline run. A UA shadow
// tree's <style> would otherwise end leaf collection at position zero.
function flatFirstRenderableChild(element: Element): Node | null {
	for (const child of flowContent(element)) {
		if (
			getNodeType(child) === child.ELEMENT_NODE &&
			(getLayoutDisplay(child as Element) === "none" || isOutOfFlow(child))
		) {
			continue;
		}
		return child;
	}
	return null;
}

// Then the flex algorithm, not the element's own CSS width, owns its
// used width.
function isRowFlexItem(element: Element): boolean {
	const parent = boxParentElement(element);
	if (!parent) {
		return false;
	}
	if (!isFlexContainer(parent)) {
		return false;
	}
	const direction = getComputedValue(parent, "flex-direction") || "row";
	return direction === "row" || direction === "row-reverse";
}

// Both sets, because they mean different things. Dropping derivation
// says the ENUMERATION is wrong. Dirtying says only that the layout
// children must be synced against it, which is what the far commoner
// change needs. Sites that only dirty would otherwise rebuild a correct
// enumeration per mutation.
function invalidateContainerDerivation(
	layout: Layout,
	container: Element,
): void {
	layout.derivedContainers.delete(container);
	layout.dirtyRunContainers.add(container);
}

function invalidateBoxDerivation(layout: Layout, node: Node): void {
	touch(layout, node);
	const container = getRunContainer(layout, node);
	if (container) {
		invalidateContainerDerivation(layout, container);
	}
}

// For an inline, this is the block container around it. An inline's
// children belong to the run the inline is on.
function invalidateChildDerivation(layout: Layout, parent: Element): void {
	let box: Element | null = parent;
	while (box && isDisplayContents(box)) {
		box = getBoxParentElement(box);
	}
	if (!box) {
		return;
	}
	// What a box holds decides whether it measures its content as a run or
	// lays out boxes of its own, so the box itself is derived again.
	touch(layout, box);
	invalidateContainerDerivation(layout, box);
	const container = getRunContainerFromParent(layout, box, false);
	if (container) {
		invalidateContainerDerivation(layout, container);
	}
}

function invalidateSubtreeDerivation(layout: Layout, node: Node): void {
	invalidateBoxDerivation(layout, node);
	if (getNodeType(node) !== node.ELEMENT_NODE) {
		return;
	}
	invalidateChildDerivation(layout, node as Element);
	// A subtree layout has never seen holds no enumeration to unsettle.
	// Anything that HAS been laid out is reachable from its own record.
	if (!layout.nodeMap.has(node) && !layout.boxes.get(node)?.children) {
		return;
	}
	// The flat tree, not the flow. Which elements dissolve is the cascade's
	// question, and marking one that generates no box costs nothing.
	for (const child of flatDescendants(node)) {
		touch(layout, child);
		if (getNodeType(child) === child.ELEMENT_NODE) {
			invalidateContainerDerivation(layout, child as Element);
		}
	}
}

function touch(layout: Layout, node: Node): void {
	const touched = layout.touched;
	if (touched !== "all") {
		touched.add(node);
	}
}

function isTouched(layout: Layout, node: Node): boolean {
	const touched = layout.touched;
	return touched === "all" || touched.has(node);
}

// A container whose own display changed can make items of its children,
// or stop, and their boxes are derived again.
function touchChildren(layout: Layout, element: Element): void {
	for (const child of flatChildren(element)) {
		touch(layout, child);
	}
}

function invalidateInlineRun(layout: Layout, node: Node): void {
	const entry = getBoxEntry(layout, node);
	if (!entry) {
		return;
	}
	if (entry.kind === "anonymous") {
		invalidateContainerBoxes(layout, entry.container);
		layout.dirtyRunContainers.add(entry.container);
		// A node left over from an earlier shape of the container measures the
		// same content a second time, in a box the container no longer has.
		dropLayoutNode(layout, node);
		return;
	}
	const container = getRunContainer(layout, entry.node!);
	if (container) {
		invalidateContainerBoxes(layout, container);
	}
	layout.nodeMap.get(entry.node!)?.invalidate();
}

function invalidateNode(layout: Layout, node: Node): void {
	layout.invalidatedNodes.add(node);
	touch(layout, node);

	if (isInlineLevel(node)) {
		invalidateInlineRun(layout, node);
	} else if (getNodeType(node) === node.ELEMENT_NODE) {
		const layoutNode = layout.nodeMap.get(node);
		if (layoutNode) {
			// The re-add sweep puts a node back under its parent element, and
			// the root element has none, so the root stays where it is.
			const parent = layoutNode.parent;
			if (parent && !isDocumentElement(node)) {
				parent.removeChild(layoutNode);
			}

			if (!node.isConnected) {
				layout.measureNodes.delete(layoutNode);
				forgetReads(layoutNode);
				untrackNode(layout, node);
			} else {
				// Kept for performLayout's re-add sweep, but restyled. A
				// list's padding-left is derived from its items' markers, and
				// reusing the node as-is kept the stale gutter.
				styleNode(layout, node as Element, layoutNode);

				// Sever its children too. The flat-tree child set may have
				// changed wholesale (attachShadow on a host already rendering
				// its light children), and stale children keep painting.
				// Survivors reattach through the re-add sweep. The rest stay
				// tracked but detached.
				while (layoutNode.children.length > 0) {
					const childLayoutNode = layoutNode.children[0];
					layoutNode.removeChild(childLayoutNode);
					const childDOMNode = childLayoutNode.owner as Node | undefined;
					if (childDOMNode) {
						dropBreakResultCache(layout, childDOMNode);
					}
				}
			}
		}

		invalidateNodeChildren(layout, node as Element);
	}
}

function invalidateNodeChildren(layout: Layout, element: Element): void {
	for (const child of flowContent(element)) {
		invalidateNode(layout, child);
	}
}

function dropBreakResultCache(layout: Layout, node: Node): void {
	const entry = getBoxEntry(layout, node);
	if (entry?.kind === "anonymous") {
		invalidateBox(layout, entry);
	} else if (entry) {
		// Dirtying the measure is what drops the lines. A clean node keeps
		// both.
		markRunMeasureDirty(layout, entry.node!);
	}
}

// Drop an anonymous box's lines and dirty the measure that refills them,
// including, under an independent formatting context, the box whose measure is
// the only thing that ever lays that content out.
function invalidateBox(layout: Layout, box: Box): void {
	box.layoutNode?.invalidate();
	const host = getEnclosingIndependentFormattingContext(layout, box.container);
	if (host) {
		invalidateEnclosingMeasure(layout, host);
	}
}

// A DOM question, not a flex-tree one. A box whose layout node is
// momentarily detached would report that it is in no tree at all,
// leaving the only measure that ever runs it un-dirtied.
function getEnclosingIndependentFormattingContext(
	layout: Layout,
	from: Element | null,
): Element | null {
	for (let current = from; current; current = getBoxParentElement(current)) {
		if (layout.boxes.get(current)?.independentFormattingContext) {
			return current;
		}
	}
	return null;
}

// Every box, not just the one that changed. What reshapes one commonly
// reshapes the others, and a cleared result on a clean node is never
// recomputed: the box lays out at the right rect and paints nothing.
function invalidateContainerBoxes(layout: Layout, container: Element): void {
	for (const entry of getContainerBox(layout, container).children!) {
		if (entry.kind === "anonymous") {
			invalidateBox(layout, entry);
		} else if (entry.fragments) {
			markRunMeasureDirty(layout, entry.node!);
		}
	}
}

// Dirty the measure that contains a node without touching the tree's
// shape. A nested inline-block is a run head only inside its parent's
// measurement, and manufacturing a layout node for it would insert a
// child under a measure-function node. Walks to the nearest ancestor
// that owns one.
function invalidateEnclosingMeasure(layout: Layout, node: Node): void {
	// A restyle may have given the node a box or taken one away. The
	// container's box list is what records that.
	const runContainer = getRunContainer(layout, node);
	if (runContainer) {
		layout.dirtyRunContainers.add(runContainer);
	}
	// The box may be an ANCESTOR's. A node inside a run member is not
	// itself a member, and the climb below would walk straight past its
	// box.
	let entry = getBoxEntry(layout, node);
	for (
		let ancestor = entry === null ? getBoxParentElement(node) : null;
		ancestor && entry === null;
		ancestor = getBoxParentElement(ancestor)
	) {
		entry = getBoxEntry(layout, ancestor);
	}
	if (entry?.kind === "anonymous") {
		if (entry.layoutNode) {
			invalidateBox(layout, entry);
			return;
		}
		// A run with no layout node is measured INSIDE another run. The
		// measure to drop is that outer one, up through the container.
		if (entry.container !== node) {
			invalidateEnclosingMeasure(layout, entry.container);
			return;
		}
	} else if (entry) {
		const headLayoutNode = layout.nodeMap.get(entry.node!);
		if (headLayoutNode && headLayoutNode.measure) {
			headLayoutNode.invalidate();
			// Out of any independent formatting context too. Only its owner
			// runs that layout.
			const host = getEnclosingIndependentFormattingContext(
				layout,
				getBoxParentElement(entry.node!),
			);
			if (host) {
				invalidateEnclosingMeasure(layout, host);
			}
			return;
		}
	}
	let current = getBoxParentElement(node);
	while (current) {
		// An ancestor that is itself a run member is measured by its box, and
		// everything nested inside it with it. The climb ends here.
		const enclosing = getBoxEntry(layout, current);
		if (enclosing?.kind === "anonymous" && enclosing.layoutNode) {
			invalidateBox(layout, enclosing);
			return;
		}
		const layoutNode = layout.nodeMap.get(current);
		if (layoutNode) {
			if (layoutNode.measure) {
				layoutNode.invalidate();
			}
			const host = getEnclosingIndependentFormattingContext(
				layout,
				getBoxParentElement(current),
			);
			if (host) {
				invalidateEnclosingMeasure(layout, host);
			}
			return;
		}
		current = getBoxParentElement(current);
	}
}

// Under an independent formatting context, dirtying just the run invalidates it
// forever. Nothing above the box ever visits those nodes, so the cleared break
// result is never rebuilt and the run paints nothing.
function markRunMeasureDirty(layout: Layout, runHead: Node): void {
	const layoutNode = layout.nodeMap.get(runHead);
	if (!layoutNode) {
		return;
	}
	if (layoutNode.measure) {
		layoutNode.invalidate();
	}
	const host = getEnclosingIndependentFormattingContext(
		layout,
		getBoxParentElement(runHead),
	);
	if (host) {
		invalidateEnclosingMeasure(layout, host);
	}
}

export interface InlineBlockLeaf {
	type: "inline-block";
	node: Element;
	breakResult?: BreakResult;
	boxModel: CSSValues.BoxModel;
	contentWidth: number;
	contentHeight: number;
}

// Where an inline box opens or closes on its line (css2 §10.3.1): its
// margin, border and padding on that side, which take cells of the line.
// Only the first fragment has the start edge and only the last the end.
interface EdgeLeaf {
	type: "edge";
	node: Element;
	side: "start" | "end";
	margin: number;
	border: number;
	padding: number;
}

type Leaf =
	InlineBlockLeaf |
	EdgeLeaf |
	{type: "text"; node: Text; content: string} |
	{type: "br"; node: HTMLBRElement};

function getEdgeWidth(leaf: EdgeLeaf): number {
	return Math.max(0, leaf.margin + leaf.border + leaf.padding);
}

// A blockified inline lays its edges out in its own box.
function hasInlineEdges(element: Element): boolean {
	return getLayoutDisplay(element) === "inline" && !isBlockified(element);
}

function pushEdge(
	leafNodes: Leaf[],
	element: Element,
	side: "start" | "end",
): void {
	const box = getBoxModel(element);
	const left =
		(side === "start") === (getTextStyle(element).direction !== "rtl");
	const leaf: EdgeLeaf = {
		type: "edge",
		node: element,
		side,
		margin: left ? box.marginLeft : box.marginRight,
		border: left ? box.borderLeftWidth : box.borderRightWidth,
		padding: left ? box.paddingLeft : box.paddingRight,
	};
	if (getEdgeWidth(leaf) > 0) {
		leafNodes.push(leaf);
	}
}

// The inline boxes a step of the walk from `from` to `next` leaves, inner
// first, up to and including `root`.
function pushExitedEdges(
	leafNodes: Leaf[],
	from: Node,
	next: Node | null,
	root: Node,
): void {
	const inside = new Set<Node>();
	for (let node: Node | null = next;
		node !== null;
		node = flatParentElement(node)) {
		inside.add(node);
		if (node === root) {
			break;
		}
	}
	for (
		let node: Node | null = from;
		node !== null && !inside.has(node);
		node = node === root ? null : flatParentElement(node)
	) {
		if (
			getNodeType(node) === node.ELEMENT_NODE && hasInlineEdges(node as Element)
		) {
			pushEdge(leafNodes, node as Element, "end");
		}
	}
}

interface LineResult {
	segments: Array<
		{
			leaf: Leaf;
			start: number;
			end: number;
			x: number;
			width: number;
			processedText: string;

			// The raw-data range this segment renders, trimmed to begin and end on
			// a rendered character, so rendering it reproduces processedText
			// exactly. Both zero for a leaf that is not text.
			dataStart: number;
			dataEnd: number;

			// The direction the characters were reordered into. Null in logical
			// order (no bidi on the line, or a terminal that reorders for itself).
			visualBase: "ltr" | "rtl" | null;

			// An atomic inline's top below the line's, and its height, as
			// vertical-align puts it on the line. Zero for anything else.
			dy: number;
			height: number;
		}
	>;
	y: number;
	width: number;
	height: number;
	// The row the line's text sits on, below the line's top: its baseline,
	// which an atomic inline taller above it pushes down.
	textTop: number;
}

export interface BreakResult {
	lines: LineResult[];
	maxLineWidth: number;
	totalHeight: number;
	// Whether a line ended where nothing forced it to, so the text is wider
	// unbroken than the width it broke against.
	wrapped?: boolean;

	// The width lines broke against, for text-align to offset within. Unset
	// when the constraint was not finite (nothing to center within).
	containerWidth?: number;
}

interface ProcessedContent {
	items: Array<
		{
			leafNode: Leaf;
			start: number;
			end: number;
			processedContent?: string;

			// Back to offsets in the leaf's raw data. Null where the two are equal.
			dataOffsets?: Int32Array | null;
		}
	>;
	text: string;

	// Entry i is the cell width of text[0..i), so a range measures as one
	// subtraction. An inline-block's whole box sits on its placeholder
	// character. A fragment of a grapheme cluster carries none of its
	// width.
	getPrefixWidths: Float64Array;

	// Whether any text keeps the spaces that end its lines.
	keepsEndSpaces: boolean;
}

interface BreakPoint {
	position: number;
	required: boolean;
}

// One laid-out line of a text node. The raw-data range begins and ends
// on a rendered character, so renderTextFragment over it reproduces the
// painted characters.
interface LineFragment {
	rect: DOMRect;

	// Cells from the start of the line box, where a preserved tab's stops
	// count from.
	column: number;

	// Data offset of the line's first character / caret slot.
	startOffset: number;

	// Data offset of the caret slot AFTER the line's last character.
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
}

interface TextFragmentEntry {
	line: number;
	x: number;
	column: number;
	width: number;
	text: string;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
	ord: number;

	// An inline box's edge, indexed under its element. It widens the rects
	// of the boxes it is in, and carries no text.
	edge?: EdgeLeaf;
}

// A line requested over an ELEMENT merges the fragments of every text
// node it covers, so its offsets are a range of the run, not of one
// node's data.
interface RectText {
	rect: DOMRect;
	column: number;
	text: string;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
}

function getWhiteSpace(textNode: Text): string {
	const parent = flatParentElement(textNode);
	return parent ? getTextStyle(parent).whiteSpace : "normal";
}

function getInlineBlockWidth(leaf: InlineBlockLeaf): number {
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

function getPrefixWidths(
	items: ProcessedContent["items"],
	text: string,
): Float64Array {
	const widths = new Float64Array(text.length + 1);
	for (const item of items) {
		if (item.leafNode.type === "text") {
			writeClusterWidths(text.slice(item.start, item.end), widths, item.start);
		} else if (item.leafNode.type === "inline-block") {
			// The placeholder stands for the whole margin box. A <br>'s newline
			// stands for nothing.
			widths[item.end - 1] = getInlineBlockWidth(item.leafNode);
		} else if (item.leafNode.type === "edge") {
			widths[item.end - 1] = getEdgeWidth(item.leafNode);
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

// Set while a run is measured when its content's size depends on the
// width the run is given other than through where its lines break.
let readsLineWidth = false;

// Only the placing measurement's lines become the box's. A probe's are
// a result about a box nothing was laid out in, and painting them
// rendered a stretched item at its narrowest.
function measureInlineRun(
	layout: Layout,
	box: Box,
	width: number,
	widthSpace: AvailableSpace,
	placing: boolean,
	left: number,
): Size {
	const outer = readsLineWidth;
	// The block the lines are indented in: the run's container, or for a
	// box measured as a run of its own, the box's element.
	const block = box.parent !== null
		? box.container
		: box.node !== null && getNodeType(box.node) === box.node.ELEMENT_NODE
		? (box.node as Element)
		: box.node === null ? null : flatParentElement(box.node);
	readsLineWidth =
		block !== null && getTextStyle(block).textIndent.includes("%");
	const breakResult = breakNodes(layout, box, width, widthSpace, left);
	const widthDependent = readsLineWidth;
	readsLineWidth = outer || widthDependent;
	if (Number.isFinite(width)) {
		breakResult.containerWidth = width;
	}
	if (placing) {
		box.fragments = breakResult;
	}

	// css2 §10.3.5: shrink-to-fit is the lesser of the preferred width and
	// the space offered, so text that had to wrap takes all the space, not
	// its longest line.
	const fills =
		widthSpace === "shrink-to-fit" && width > 0 && breakResult.wrapped === true;
	return {
		width: fills
			? Math.max(breakResult.maxLineWidth, width)
			: breakResult.maxLineWidth,
		height: breakResult.totalHeight,
		columns: widthSpace !== "indefinite" && width > 0
			? getDrawnColumns(left, width)
			: undefined,
		wrapped: breakResult.wrapped === true,
		lineColumns: Math.round(breakResult.maxLineWidth),
		widthDependent,
	};
}

// The <math> element a node is inside, itself included.
function getEnclosingMath(layout: Layout, node: Node): Element | null {
	if (!layout.laidOutMath) {
		return null;
	}
	for (
		let element: Element | null = getNodeType(node) === node.ELEMENT_NODE
			? (node as Element)
			: node.parentElement; element !== null; element = element.parentElement
	) {
		if (isMathRoot(element)) {
			return element;
		}
	}
	return null;
}

// A <math> element is laid out whole by the math engine. The block and
// inline engines see only its size, and never descend into it.
function measureMath(layout: Layout, element: Element): MathBox {
	const box = layoutMath(element, !isInlineDisplay(getUsedDisplay(element)));
	layout.mathBoxes.set(element, box);
	layout.laidOutMath = true;
	return box;
}

// The members are the box's own, so nothing here decides where a run
// ends, and a member that has left the tree is not among them.
function collectLeafNodes(
	layout: Layout,
	source: Box,
	availableWidth: number,
	availableWidthMode: AvailableSpace = "indefinite",
): Leaf[] {
	const leafNodes: Leaf[] = [];
	if (source.kind === "anonymous") {
		for (const member of source.members) {
			// A broken inline heads the run of its first fragment, and its
			// content is among the members on its own. Walking into it too
			// would lay that content out twice.
			if (
				getNodeType(member) === member.ELEMENT_NODE &&
				layout.boxes.get(member as Element)?.broken
			) {
				continue;
			}
			collectLeaves(
				layout,
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
	const parentElement = getBoxParentElement(node);
	if (!parentElement) {
		return leafNodes;
	}

	// A run starting inside an inline box carries on past its end.
	// `<span>a<div/>b</span>c` puts "b" and "c" on one line, so the walk
	// cannot stop at </span>. The climb stops at an out-of-flow inline,
	// which is blockified and lays its own content out.
	const parentDisplay = getLayoutDisplay(parentElement);
	let traversalRoot: Node;
	if (
		hasItemChildren(parentDisplay) && getNodeType(node) === node.ELEMENT_NODE
	) {
		traversalRoot = node;
	} else {
		let root: Element = parentElement;
		for (
			let ancestor = getBoxParentElement(root);
			ancestor && isInlineBox(root);
			ancestor = getBoxParentElement(root)
		) {
			root = ancestor;
		}
		traversalRoot = root;
	}

	// Text directly inside a flex container is an anonymous item that ends
	// at the first element, every element child being an item of its own.
	const stopsAtFlexItems =
		hasItemChildren(parentDisplay) && getNodeType(node) === node.TEXT_NODE;

	collectLeaves(
		layout,
		traversalRoot,
		node,
		stopsAtFlexItems,
		leafNodes,
		availableWidth,
		availableWidthMode,
	);
	return leafNodes;
}

const ATOMIC_WIDTH_PROPERTIES = [
	"width",
	"min-width",
	"max-width",
	"margin-left",
	"margin-right",
	"padding-left",
	"padding-right",
];

function hasPercentage(
	element: Element,
	properties: readonly string[],
): boolean {
	return properties.some((property) =>
		getComputedValue(element, property).includes("%"),
	);
}

// How many times a measure has laid out an atomic inline's own content.
// A probe that did leaves that content at the probe's width, so the box
// it measured cannot keep the layout it was placed with.
let contextLayouts = 0;

function collectLeaves(
	layout: Layout,
	root: Node,
	start: Node,
	stopsAtFlexItems: boolean,
	leafNodes: Leaf[],
	availableWidth: number,
	availableWidthMode: AvailableSpace,
): void {
	let cursor: Node | null = start;
	while (cursor !== null) {
		const node: Node = cursor;
		if (stopsAtFlexItems && getNodeType(node) === node.ELEMENT_NODE) {
			break;
		}

		if (getNodeType(node) === node.TEXT_NODE) {
			const textNode = node as Text;

			const content = getCharacterData(textNode);
			if (content) {
				const isWhitespaceOnly = COLLAPSIBLE_ONLY.test(content);

				if (isWhitespaceOnly && shouldCollapseWhitespaceTextNode(textNode)) {
					cursor = flowNext(node, root, false);
					pushExitedEdges(leafNodes, node, cursor, root);
					if (cursor === null) {
						break;
					}
					continue;
				}

				leafNodes.push({type: "text", node: textNode, content});
			}
			cursor = flowNext(node, root, false);
			pushExitedEdges(leafNodes, node, cursor, root);
			if (cursor === null) {
				break;
			}
		} else if (getNodeType(node) === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getLayoutDisplay(element);
			// A box sized whole on the line takes a percentage of the line's
			// width however it is sized, and with no width takes it as auto.
			if (
				isAtomicInline(display) &&
				hasPercentage(element, ATOMIC_WIDTH_PROPERTIES)
			) {
				readsLineWidth = true;
			}

			if (getLayoutDisplay(element) === "none" || isOutOfFlow(element)) {
				// Neither occupies run space nor interrupts the run. Before the
				// display branches, or an absolute inline span measures into
				// the run it left.
				cursor = flowNext(node, root, true);
				pushExitedEdges(leafNodes, node, cursor, root);
				if (cursor === null) {
					break;
				}
			} else if (getHTMLLocalName(element) === "br") {
				leafNodes.push({type: "br", node: element as HTMLBRElement});
				cursor = flowNext(node, root, false);
				pushExitedEdges(leafNodes, node, cursor, root);
				if (cursor === null) {
					break;
				}
			} else if (isAtomicInline(display) && isReplacedBox(element)) {
				const size = getReplacedSize(element, availableWidth);
				leafNodes.push({
					type: "inline-block",
					node: element,
					boxModel: getBoxModel(element),
					contentWidth: size.width,
					contentHeight: size.height,
				});
				cursor = flowNext(node, root, true);
				pushExitedEdges(leafNodes, node, cursor, root);
				if (cursor === null) {
					break;
				}
			} else if (isAtomicInline(display) && isMathRoot(element)) {
				const box = measureMath(layout, element);
				leafNodes.push({
					type: "inline-block",
					node: element,
					boxModel: getBoxModel(element),
					contentWidth: box.width,
					contentHeight: box.height,
				});
				cursor = flowNext(node, root, true);
				pushExitedEdges(leafNodes, node, cursor, root);
				if (cursor === null) {
					break;
				}
			} else if (isAtomicInline(display)) {
				const ownBox = getPrincipalBox(layout, element);
				// An inline-block nested in another inline is a run member, and
				// addElementNode is never called on one. This is the first
				// moment its block content is known to need a root.
				if (!ownBox.independentFormattingContext) {
					syncIndependentFormattingContext(layout, element);
				}

				const boxModel = {...getBoxModel(element)};

				// getBoxModel carries only absolute widths. A percentage
				// resolves here against the run's available width, which is
				// what lets `input { width: 100% }` fill its container instead
				// of collapsing to a void element's zero. Indefinite width
				// falls through to auto.
				if (boxModel.width === undefined) {
					const widthValue = CSSValues.parseUnitValue(
						getComputedValue(element, "width"),
					);
					if (
						widthValue !== null &&
						typeof widthValue === "object" &&
						Number.isFinite(availableWidth) &&
						availableWidth < Number.MAX_SAFE_INTEGER
					) {
						boxModel.width = Math.max(
							0,
							(widthValue.percentage / 100) * availableWidth,
						);
					}
				}

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

				let contentWidth = Number.MAX_SAFE_INTEGER;
				let contentHeight = Number.MAX_SAFE_INTEGER;
				let contentWidthMode: AvailableSpace = "indefinite";
				let contentHeightMode: AvailableSpace = "indefinite";

				// A sizing keyword picks the probe the content is measured under.
				// An auto width fits its content to the line, as fit-content
				// does, wherever the line's width is known.
				const declaredSizing = boxModel.width === undefined
					? getWidthSizingConstant(getComputedValue(element, "width"))
					: "none";
				const widthSizing =
					declaredSizing === "none" &&
						boxModel.width === undefined &&
						getHTMLLocalName(element) !== "textarea" &&
						Number.isFinite(availableWidth) &&
						availableWidth < Number.MAX_SAFE_INTEGER
						? "fit-content"
						: declaredSizing;
				if (boxModel.width !== undefined) {
					contentWidth = Math.max(0, boxModel.width - horizontalBoxSpace);
					contentWidthMode = "definite";
				} else if (widthSizing === "min-content") {
					contentWidth = 0;
					contentWidthMode = "shrink-to-fit";
				} else if (
					widthSizing === "fit-content" &&
					Number.isFinite(availableWidth) &&
					availableWidth < Number.MAX_SAFE_INTEGER
				) {
					// The content's widest line, capped at the space the line
					// offers less the box's own edges (css2 §10.3.9, §10.3.5).
					contentWidth = Math.max(
						0,
						availableWidth -
						horizontalBoxSpace -
						boxModel.marginLeft -
						boxModel.marginRight,
					);
					contentWidthMode = "shrink-to-fit";
				} else if (getHTMLLocalName(element) === "textarea") {
					// cols sizes the CONTENT box (spec default 20). The UA
					// sheet carries no width for it. A constant that pre-baked
					// the UA chrome could not be undone by an author's `border:
					// none`.
					const cols = parseInt(getAttributeValue(element, "cols") ?? "", 10);
					contentWidth = Number.isFinite(cols) && cols > 0
						? Math.min(cols, MAX_TEXTAREA_SIZE)
						: 20;
					contentWidthMode = "definite";
				}

				// On a row flex item's main axis the flex engine owns the used
				// width, and the requests carry that authority: an `definite`
				// request is the resolved width, and an `shrink-to-fit` request
				// below the CSS width is an intrinsic probe wanting the
				// CONTENT's minimum, not the basis. Row flex items only.
				// Elsewhere an `definite` request describes the container, and
				// a definite-width inline-block in a narrow block overflows
				// rather than re-wrapping.
				let offerOwnsWidth = false;
				if (Number.isFinite(availableWidth) && isRowFlexItem(element)) {
					const offered = Math.max(0, availableWidth - horizontalBoxSpace);
					if (availableWidthMode === "definite") {
						contentWidth = offered;
						contentWidthMode = "definite";
						offerOwnsWidth = true;
					} else if (
						availableWidthMode === "shrink-to-fit" && offered < contentWidth
					) {
						contentWidth = offered;
						contentWidthMode = "shrink-to-fit";
						offerOwnsWidth = true;
					}
				}

				// max-width caps the width the content BREAKS at, not just the
				// reported box. Otherwise it wraps at its natural width and
				// overflows the capped box. A percentage resolves against the
				// run's available width, or `max-width: 100%` (every text
				// control's value part) broke at its natural width and
				// overflowed its text control.
				const maxWidthValue = toCellLength(
					CSSValues.parseUnitValue(getComputedValue(element, "max-width")),
					false,
					element,
				);
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
						if (contentWidthMode === "indefinite") {
							contentWidthMode = "shrink-to-fit";
						}
					}
				}

				if (boxModel.height !== undefined) {
					contentHeight = Math.max(0, boxModel.height - verticalBoxSpace);
					contentHeightMode = "definite";
				}

				// The COMPOSED first child. A shadow host renders its shadow
				// content, and measuring the light children sized it to zero.
				const independentFormattingContext =
					ownBox.independentFormattingContext;
				let inlineBlockResult: BreakResult | undefined;
				let finalContentWidth: number;
				let finalContentHeight: number;

				if (independentFormattingContext) {
					// Laid out here because nothing above the box will. NaN
					// shrinks the axis to fit. A sizing keyword on the root
					// turns a passed width into the matching probe.
					if (independentFormattingContext.style.widthSizing !== widthSizing) {
						independentFormattingContext.style.widthSizing = widthSizing;
						independentFormattingContext.invalidate();
					}
					independentFormattingContext.performLayout(
						contentWidthMode === "definite" ||
						(widthSizing !== "none" && contentWidthMode === "shrink-to-fit")
							? contentWidth
							: Number.NaN,
						contentHeightMode === "definite" ? contentHeight : Number.NaN,
					);
					computePaintExtents(layout, independentFormattingContext, 0, 0);
					contextLayouts++;
					finalContentWidth = getComputedWidth(independentFormattingContext);
					finalContentHeight = getComputedHeight(independentFormattingContext);
				} else {
					const contentStart = flatFirstRenderableChild(element);
					if (contentStart) {
						inlineBlockResult = breakNodes(
							layout,
							getPrincipalBox(layout, contentStart),
							contentWidth,
							contentWidthMode,
						);
					}
					finalContentWidth = inlineBlockResult?.maxLineWidth ?? 0;
					finalContentHeight = inlineBlockResult?.totalHeight ?? 0;
					// Shrink-to-fit is the lesser of the preferred width and the
					// space offered, so content that had to wrap takes all the
					// space, not its longest line (css2 §10.3.5).
					if (
						contentStart &&
						widthSizing === "fit-content" &&
						contentWidthMode === "shrink-to-fit" &&
						inlineBlockResult !== undefined &&
						inlineBlockResult.lines.length > 1 &&
						finalContentWidth < contentWidth
					) {
						const preferred = breakNodes(
							layout,
							getPrincipalBox(layout, contentStart),
							Number.MAX_SAFE_INTEGER,
							"indefinite",
						).maxLineWidth;
						finalContentWidth = Math.max(
							finalContentWidth,
							Math.min(preferred, contentWidth),
						);
					}
				}

				// And the REPORTED box. Content that cannot wrap (a single-line
				// text control's pre text) overflows and is clipped rather than
				// stretching the box, or the text control's horizontal scroll
				// has nothing to window.
				if (maxWidthCap !== undefined) {
					finalContentWidth = Math.min(
						finalContentWidth,
						Math.max(0, maxWidthCap - horizontalBoxSpace),
					);
				}

				// An input whose UA parts are all empty text still occupies a row.
				if (!element.firstChild && finalContentHeight === 0) {
					finalContentHeight = 1;
				}

				// rows floor the content height (spec default 2). A floor, not
				// a height: the text control grows with its content, where a
				// browser would scroll inside a fixed box. cols fix the
				// reported width. The box is attribute-sized however short the
				// value is.
				if (getHTMLLocalName(element) === "textarea") {
					if (boxModel.height === undefined) {
						const rows = parseInt(getAttributeValue(element, "rows") ?? "", 10);
						finalContentHeight = Math.max(
							finalContentHeight,
							Number.isFinite(rows) && rows > 0
								? Math.min(rows, MAX_TEXTAREA_SIZE)
								: 2,
						);
					}
					if (boxModel.width === undefined && !offerOwnsWidth) {
						finalContentWidth = contentWidth;
					}
				}

				// This leaf IS where an inline-block's box gets its size (the
				// layout node only reports the whole run), so min/max apply here.
				// Values are border-box. Convert to content-box.
				const minWidthValue = toCellLength(
					CSSValues.parseUnitValue(getComputedValue(element, "min-width")),
					false,
					element,
				);
				if (typeof minWidthValue === "number") {
					finalContentWidth = Math.max(
						finalContentWidth,
						minWidthValue - horizontalBoxSpace,
					);
				}
				const minHeightValue = getCellBlockSize(element, "min-height");
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
				const maxHeightValue = getCellBlockSize(element, "max-height");
				if (typeof maxHeightValue === "number") {
					finalContentHeight = Math.min(
						finalContentHeight,
						maxHeightValue - verticalBoxSpace,
					);
				}

				// Explicit dimensions win, unless the request owned the width
				// above. An intrinsic probe's result must be the content's.
				// max-width still caps a width, and min-width floors both
				// (css2 §10.4).
				if (boxModel.width !== undefined && !offerOwnsWidth) {
					let width = boxModel.width;
					if (maxWidthCap !== undefined) {
						width = Math.min(width, maxWidthCap);
					}
					if (typeof minWidthValue === "number") {
						width = Math.max(width, minWidthValue);
					}
					finalContentWidth = Math.max(0, width - horizontalBoxSpace);
				}
				if (boxModel.height !== undefined) {
					finalContentHeight = Math.max(0, boxModel.height - verticalBoxSpace);
				}

				// Its lines align within the box it ended up in, as text-align
				// asks, not within the space they were broken in.
				if (inlineBlockResult !== undefined) {
					inlineBlockResult.containerWidth = finalContentWidth;
				}
				leafNodes.push({
					type: "inline-block",
					node: element,
					breakResult: inlineBlockResult,
					boxModel,
					contentWidth: finalContentWidth,
					contentHeight: finalContentHeight,
				});
				// The children were measured inside the box above.
				cursor = flowNext(node, root, true);
				pushExitedEdges(leafNodes, node, cursor, root);
				if (cursor === null) {
					break;
				}
			} else if (display === "inline") {
				if (hasInlineEdges(element)) {
					pushEdge(leafNodes, element, "start");
				}
				cursor = flowNext(node, root, false);
				pushExitedEdges(leafNodes, node, cursor, root);
				if (cursor === null) {
					break;
				}
			} else {
				// A block-level box broke the inline that holds it. The
				// fragments on either side are members of their own.
				break;
			}
		} else {
			cursor = flowNext(node, root, false);
			pushExitedEdges(leafNodes, node, cursor, root);
			if (cursor === null) {
				break;
			}
		}
	}
}

// A run's leaves, its text with white space processed, and where its
// lines may break: the same at every width unless an atomic inline in it
// sizes against the width. A pass that measures a run more than once,
// as a table's min- and max-content probes do, splits it once, and each
// measure replays the style reads the split made, so it is invalidated
// as though it had read them itself.
interface SplitRun {
	leafNodes: Leaf[];
	styleElement: Element;
	processedContent: ProcessedContent;
	breaks: ReturnType<typeof findBreakPoints>;
	nowrap: boolean;
	nowrapLeaf: boolean;
	wordBreak: string;
	overflowWrap: string;
	reads: Array<Element | string>;
}

function splitRun(
	layout: Layout,
	source: Box,
	width: number,
	widthSpace: AvailableSpace,
): SplitRun | null {
	const known = layout.splitRuns?.get(source);
	if (known !== undefined) {
		replayStyleReads(known.reads);
		return known;
	}
	const reads: Array<Element | string> = [];
	const split = recordStyleReads((element, read, value) => {
		reads.push(element, read, value);
	}, () => readSplitRun(layout, source, width, widthSpace));
	replayStyleReads(reads);
	if (split === null) {
		return null;
	}
	const run = {...split, reads};
	if (run.leafNodes.every((leaf) => leaf.type !== "inline-block")) {
		layout.splitRuns?.set(source, run);
	}
	return run;
}

function readSplitRun(
	layout: Layout,
	source: Box,
	width: number,
	widthSpace: AvailableSpace,
): Omit<SplitRun, "reads"> | null {
	// An `indefinite` request is indefinite (NaN), so percentages in
	// the content cannot resolve. Any definite request, an `shrink-to-fit` 0
	// included, resolves them.
	const leafNodes = collectLeafNodes(
		layout,
		source,
		widthSpace === "indefinite" ? NaN : width,
		widthSpace,
	);
	if (leafNodes.length === 0) {
		return null;
	}
	// Text properties come from what opens the box. A text node styles
	// from its flat-tree parent.
	const opener = source.head;
	const styleElement = getNodeType(opener) === opener.TEXT_NODE
		? flatParentElement(opener)!
		: (opener as Element);
	const {whiteSpace, wordBreak, overflowWrap} = getTextStyle(styleElement);
	const processedContent = processWhitespace(layout, leafNodes);
	// `pre` suppresses wrapping as `nowrap` does. Treating it as wrappable
	// folds text a browser lets overflow.
	const preservesLines = whiteSpace === "pre";
	const nowrap = preservesLines || (whiteSpace || "normal") === "nowrap";
	const breaks = withoutBreaksInsideNowrap(
		processedContent,
		findBreakPoints(processedContent, whiteSpace || "normal", nowrap),
	);
	return {
		leafNodes,
		styleElement,
		processedContent,
		breaks,
		nowrap,
		nowrapLeaf: hasNowrapLeaf(processedContent),
		wordBreak,
		overflowWrap,
	};
}

function breakNodes(
	layout: Layout,
	source: Box,
	width: number,
	widthSpace: AvailableSpace,
	left = NaN,
): BreakResult {
	const split = splitRun(layout, source, width, widthSpace);
	if (split === null) {
		return {lines: [], totalHeight: 0, maxLineWidth: 0};
	}
	const {
		styleElement,
		processedContent,
		breaks,
		nowrap,
		wordBreak,
		overflowWrap,
	} = split;

	// A width of 0 is a real constraint, the min-content probe. Treated as
	// unlimited it returned max-content, making min-content zero
	// everywhere. A line fits the whole columns its box is drawn across,
	// since its pieces are drawn at whole columns too: a fraction of a
	// margin does not wrap the word after it, and a box 30.5 cells wide
	// drawn across 30 columns does not take a line of 31.
	const maxWidth = widthSpace === "indefinite"
		? Number.MAX_SAFE_INTEGER
		: width > 0 ? getDrawnColumns(left, width) + 0.4999 : width;

	// break-word does NOT shrink min-content (the word still measures whole
	// at the `shrink-to-fit` 0 probe), while anywhere and break-all do.
	const breakAnywhere =
		!nowrap &&
		!split.nowrapLeaf &&
		(wordBreak === "break-all" ||
			overflowWrap === "anywhere" ||
			(overflowWrap === "break-word" && maxWidth > 0));
	// The base direction is the block's the lines are in, not whatever
	// opens them (css-writing-modes-3 §2.4), unless the run is an item's own
	// box. Undeclared, the first strong character wins (UAX #9 §P2), which
	// is what makes an Arabic string in an undeclared <div> come out right.
	// That is how such a string usually arrives.
	const block =
		source.styledFrom ??
		(source.parent ? source.container : flatParentElement(source.head)) ??
		styleElement;
	const declared = getTextStyle(block).direction;
	const base: "ltr" | "rtl" = declared === "rtl"
		? "rtl"
		: declared === "ltr" ? "ltr" : getParagraphDirection(processedContent.text);

	const {lines, wrapped, height} = buildLines(
		layout,
		processedContent,
		breaks,
		maxWidth,
		breakAnywhere,
		block,
		base,
	);

	return {
		lines,
		totalHeight: height,
		maxLineWidth: Math.max(...lines.map((l) => l.width), 0),
		wrapped,
	};
}

// A preserved tab advances to the next tab stop, measured in cells from
// the start of its line across every leaf on it (css-text-3 §5.2). Each
// space it becomes maps back to the tab's own data offset.
function expandTabRun(
	text: string,
	offsets: Int32Array | null,
	tabSize: number,
	column: number,
): {text: string; offsets: Int32Array; column: number} {
	const mapped: number[] = [];
	let expanded = "";
	let lineStart = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\t") {
			column += getStringWidth(expanded.slice(lineStart));
			const count = tabSize > 0 ? tabSize - (column % tabSize) : 0;
			for (let k = 0; k < count; k++) {
				expanded += " ";
				mapped.push(getDataOffset(offsets, i));
			}
			column += count;
			lineStart = expanded.length;
		} else {
			if (char === "\n") {
				column = 0;
				lineStart = expanded.length + 1;
			}
			expanded += char;
			mapped.push(getDataOffset(offsets, i));
		}
	}
	column += getStringWidth(expanded.slice(lineStart));
	return {text: expanded, offsets: Int32Array.from(mapped), column};
}

// Collapsing leaves already rendered their tabs as spaces, so only the
// preserving ones expand, at the column the leaves before them reached.
function expandTabs(items: ProcessedContent["items"]): string {
	let text = "";
	let column = 0;
	for (const item of items) {
		const leaf = item.leafNode;
		const start = text.length;
		let content = item.processedContent;
		if (content === undefined) {
			content = leaf.type === "br" ? "\n" : "\uFFFC";
		} else if (
			leaf.type === "text" &&
			content.includes("\t") &&
			isSpacePreserving(getWhiteSpace(leaf.node))
		) {
			const expanded = expandTabRun(
				content,
				item.dataOffsets ?? null,
				getTextTabSize(leaf.node),
				column,
			);
			item.processedContent = expanded.text;
			item.dataOffsets = expanded.offsets;
			column = expanded.column;
			text += expanded.text;
			item.start = start;
			item.end = text.length;
			continue;
		}
		const newline = content.lastIndexOf("\n");
		column = newline === -1
			? column + getStringWidth(content)
			: getStringWidth(content.slice(newline + 1));
		text += content;
		item.start = start;
		item.end = text.length;
	}
	return text;
}

function getTextTabSize(textNode: Text): number {
	return getTabSize(flatParentElement(textNode));
}

function renderLeaf(
	layout: Layout,
	textNode: Text,
	whiteSpace: string,
): {text: string; offsets: Int32Array | null} {
	const data = getCharacterData(textNode);
	const key = `${whiteSpace}\u0000${data}`;
	const cached = layout.renderedLeaves.get(textNode);
	if (cached?.key === key) {
		return cached;
	}
	const rendered = renderWhiteSpaceOffsets(data, whiteSpace);
	layout.renderedLeaves.set(textNode, {
		key,
		text: rendered.text,
		offsets: rendered.offsets,
	});
	return rendered;
}

function processWhitespace(
	layout: Layout,
	leafNodes: Leaf[],
): ProcessedContent {
	const items: ProcessedContent["items"] = [];
	let text = "";

	for (let leafIndex = 0; leafIndex < leafNodes.length; leafIndex++) {
		const leaf = leafNodes[leafIndex];
		const start = text.length;

		if (leaf.type === "text" && leaf.content) {
			const leafWhiteSpace = getWhiteSpace(leaf.node);
			const rendered = renderLeaf(layout, leaf.node, leafWhiteSpace);
			let processed = rendered.text;
			let dataOffsets = rendered.offsets;

			// Boundary whitespace collapses only where this leaf's white-space
			// collapses at all. Under the preserving values a run of
			// single-space spans is as wide as it has spans.
			if (
				leafIndex > 0 &&
				processed.length > 0 &&
				!isSpacePreserving(leafWhiteSpace)
			) {
				// An inline box's edges do not separate its spaces from the
				// ones around it (css-text-3 §4.1.1).
				let prevItem: (typeof items)[number] | undefined;
				for (let i = items.length - 1; i >= 0 && prevItem === undefined; i--) {
					if (items[i].leafNode.type !== "edge") {
						prevItem = items[i];
					}
				}
				if (prevItem && prevItem.leafNode.type === "text") {
					const prevEndsWithSpace =
						prevItem.end > prevItem.start && text[prevItem.end - 1] === " ";
					const thisStartsWithSpace = processed[0] === " ";

					if (prevEndsWithSpace && thisStartsWithSpace) {
						processed = processed.substring(1);
						dataOffsets = shiftRenderedOffsets(
							dataOffsets,
							1,
							processed.length,
						);
					}
				} else if (prevItem?.leafNode.type === "br" && processed[0] === " ") {
					// A line a <br> opens starts on its content, not a space.
					processed = processed.substring(1);
					dataOffsets = shiftRenderedOffsets(dataOffsets, 1, processed.length);
				}
			}

			text += processed;

			items.push({
				leafNode: leaf,
				start,
				end: text.length,
				processedContent: processed,
				dataOffsets,
			});
		} else if (leaf.type === "br") {
			// Nor does the line it ends close on one.
			const prevItem = items.at(-1);
			const prevText = prevItem === undefined
				? undefined
				: prevItem.processedContent;
			if (
				prevItem !== undefined &&
				prevText !== undefined &&
				prevText.endsWith(" ") &&
				prevItem.end === text.length &&
				prevItem.leafNode.type === "text" &&
				!isSpacePreserving(getWhiteSpace(prevItem.leafNode.node))
			) {
				prevItem.processedContent = prevText.slice(0, -1);
				prevItem.dataOffsets = shiftRenderedOffsets(
					prevItem.dataOffsets ?? null,
					0,
					prevItem.processedContent.length,
				);
				prevItem.end--;
				text = text.slice(0, -1);
			}
			const at = text.length;
			text += "\n";
			items.push({leafNode: leaf, start: at, end: text.length});
		} else if (leaf.type === "inline-block" || leaf.type === "edge") {
			text += "\uFFFC";
			items.push({leafNode: leaf, start, end: text.length});
		}
	}

	if (text.includes("\t")) {
		text = expandTabs(items);
	}

	// The spaces a run opens and closes on sit at a line's edge, and
	// css-text-3 §4.1.1 removes them there.
	if (text.length > 0) {
		// A `pre` leaf keeps its own spaces and ONLY its own. Asking whether
		// anything in the run preserves spaces spared both edges, and
		// `   <b class="pre">x</b>` opened on a space no browser draws.
		let guardStart = text.length;
		let guardEnd = 0;
		for (const item of items) {
			const leaf = item.leafNode;
			if (leaf.type === "text" && isSpacePreserving(getWhiteSpace(leaf.node))) {
				guardStart = Math.min(guardStart, item.start);
				guardEnd = Math.max(guardEnd, item.end);
			}
		}

		// Never the newline a <br> contributes. That is a forced break, and
		// trimming it dropped the blank line `<br>text` opens with.
		const leading = text.match(/^[ \t\r\f]*/)?.[0].length || 0;
		const trailing = text.match(/[ \t\r\f]*$/)?.[0].length || 0;
		const trimStart = Math.min(leading, guardStart);
		const trimmedEnd = Math.max(text.length - trailing, guardEnd);

		if (trimStart > 0 || trimmedEnd < text.length) {
			text = text.slice(trimStart, trimmedEnd);

			// Each leaf's text is trimmed by exactly what its offsets moved.
			// Shifting the offsets alone sliced the untrimmed string at trimmed
			// positions, and "<br> abcdef" rendered " abcde".
			for (const item of items) {
				const clampedStart = Math.min(
					Math.max(item.start, trimStart),
					trimmedEnd,
				);
				const clampedEnd = Math.min(Math.max(item.end, trimStart), trimmedEnd);
				if (item.processedContent !== undefined) {
					item.processedContent = item.processedContent.slice(
						clampedStart - item.start,
						clampedEnd - item.start,
					);
					item.dataOffsets = shiftRenderedOffsets(
						item.dataOffsets ?? null,
						clampedStart - item.start,
						item.processedContent.length,
					);
				}
				item.start = clampedStart - trimStart;
				item.end = clampedEnd - trimStart;
			}
		}
	}

	const keepsEndSpaces = items.some((item) => {
		if (item.leafNode.type !== "text") {
			return false;
		}
		const whiteSpace = getWhiteSpace(item.leafNode.node);
		return whiteSpace === "pre" || whiteSpace === "break-spaces";
	});
	return {
		items,
		text,
		getPrefixWidths: getPrefixWidths(items, text),
		keepsEndSpaces,
	};
}

function hasNowrapLeaf(content: ProcessedContent): boolean {
	return content.items.some((item) => {
		if (item.leafNode.type === "text") {
			return getWhiteSpace(item.leafNode.node) === "nowrap";
		}
		return false;
	});
}

// white-space applies to the text it styles, not to the line (css-text-3
// §5.1). A nowrap span keeps its own text whole, and the text around it
// still breaks, at the span's edges too.
function withoutBreaksInsideNowrap(
	content: ProcessedContent,
	breaks: BreakPoint[],
): BreakPoint[] {
	if (!hasNowrapLeaf(content)) {
		return breaks;
	}
	const nowrapAt = new Uint8Array(content.text.length);
	for (const item of content.items) {
		if (
			item.leafNode.type === "text" &&
			getWhiteSpace(item.leafNode.node) === "nowrap"
		) {
			nowrapAt.fill(1, item.start, item.end);
		}
	}
	return breaks.filter(({position, required}) =>
		required ||
		position >= content.text.length ||
		!(nowrapAt[position - 1] === 1 && nowrapAt[position] === 1),
	);
}

function findBreakPoints(
	content: ProcessedContent,
	whiteSpace: string,
	nowrap: boolean,
): BreakPoint[] {
	// A nowrap run still breaks where the content demands (a newline under
	// `pre`, a <br>). Dropping every break point collapsed a three-line pre
	// block onto one line.
	if (nowrap) {
		const forced = new Set<number>();
		if (whiteSpace === "pre" || whiteSpace === "pre-wrap") {
			for (let i = content.text.indexOf("\n"); i !== -1;) {
				forced.add(i + 1);
				i = content.text.indexOf("\n", i + 1);
			}
		}
		for (const item of content.items) {
			if (item.leafNode.type === "br" && item.end < content.text.length) {
				forced.add(item.end);
			}
		}
		return [
			...[...forced]
				.sort((a, b) => a - b)
				.map((position) => ({position, required: true})),
			{position: content.text.length, required: false},
		];
	}

	// The breaks are the text's, found without the edges. One falls after
	// the edges that close boxes and before those that open them, so each
	// edge stays on the line of the content it borders.
	const edges = content.items.filter((item) => item.leafNode.type === "edge");
	let text = content.text;
	let toContent: ((position: number) => number) | null = null;
	if (edges.length > 0) {
		const positions: number[] = [];
		text = "";
		let edge = 0;
		for (let i = 0; i < content.text.length; i++) {
			if (edge < edges.length && edges[edge].start === i) {
				edge++;
				continue;
			}
			positions.push(i);
			text += content.text[i];
		}
		positions.push(content.text.length);
		const opens = new Set(
			edges
				.filter((item) => (item.leafNode as EdgeLeaf).side === "start")
				.map((item) => item.start),
		);
		toContent = (position) => {
			let at = positions[position];
			while (at > 0 && opens.has(at - 1)) {
				at--;
			}
			return position === text.length ? content.text.length : at;
		};
	}

	const breaker = new LineBreaker(text);
	const breaks: BreakPoint[] = [];

	let lastPos = 0;
	let bk;
	while ((bk = breaker.nextBreak())) {
		let required = bk.required || false;

		if (
			whiteSpace === "pre" ||
			whiteSpace === "pre-wrap" ||
			whiteSpace === "pre-line"
		) {
			const segment = text.slice(lastPos, bk.position);
			if (segment.includes("\n")) {
				required = true;
			}
		}

		breaks.push({
			position: toContent === null ? bk.position : toContent(bk.position),
			required,
		});
		lastPos = bk.position;
	}

	return breaks;
}

function buildLines(
	layout: Layout,
	content: ProcessedContent,
	breaks: BreakPoint[],
	maxWidth: number,
	breakAnywhere: boolean,
	block: Element,
	base: "ltr" | "rtl" = "ltr",
): {lines: LineResult[]; wrapped: boolean; height: number} {
	const lines: LineResult[] = [];
	let wrapped = false;
	const blockRows = getTextStyle(block).lineHeightRows;
	const rowsByElement = new Map<Element, number>([[block, blockRows]]);
	let currentY = 0;
	let lineStart = 0;
	// Break positions ascend, so a line's candidates are a suffix of the
	// array. The cursor only moves forward.
	let cursor = 0;
	// The first required break at or after each index, so a line finds a
	// forced break in its span without walking the candidates.
	const nextRequired = new Int32Array(breaks.length + 1);
	nextRequired[breaks.length] = breaks.length;
	for (let i = breaks.length - 1; i >= 0; i--) {
		nextRequired[i] = breaks[i].required ? i : nextRequired[i + 1];
	}

	while (lineStart < content.text.length) {
		let bestBreak = lineStart;

		while (cursor < breaks.length && breaks[cursor].position <= lineStart) {
			cursor++;
		}

		// Widths rise with position. Bisect for the last fitting candidate.
		let low = cursor;
		let high = breaks.length - 1;
		let lastFitting = cursor - 1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			const end = breaks[mid].position;
			const hang = getHangingSpaces(content, lineStart, end);
			if (measureText(content, lineStart, end - hang) <= maxWidth) {
				lastFitting = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		// A required break ends the line however much room is left.
		const required = nextRequired[cursor];
		const chosen = required <= lastFitting ? required : lastFitting;
		if (chosen >= cursor) {
			bestBreak = breaks[chosen].position;
		}

		// No break opportunity fits. The line takes the whole unbreakable unit
		// and overflows, as a browser lets a long word escape its box.
		if (bestBreak === lineStart && !breakAnywhere) {
			bestBreak = cursor < breaks.length
				? breaks[cursor].position
				: content.text.length;
		}

		if (bestBreak === lineStart) {
			let pos = lineStart + 1;
			while (pos <= content.text.length) {
				let crossesInlineBlock = false;
				for (const item of content.items) {
					if (item.leafNode.type === "inline-block") {
						if (pos > item.start && pos < item.end) {
							pos = item.end;
							crossesInlineBlock = true;
							break;
						}
					}
				}

				if (crossesInlineBlock) {
					continue;
				}

				const width = measureText(content, lineStart, pos);
				if (width > maxWidth && pos > lineStart + 1) {
					pos--;
					break;
				}
				pos++;
			}
			bestBreak = Math.min(pos, content.text.length);
		}

		const hang = getHangingSpaces(content, lineStart, bestBreak);
		const bestBreakWidth = measureText(content, lineStart, bestBreak - hang);
		const lineNodes = getNodesInRange(content.items, lineStart, bestBreak);
		const last = lineNodes[lineNodes.length - 1];
		if (hang > 0 && last?.leaf.type === "text") {
			last.width = Math.max(0, last.width - hang);
		}

		if (lineNodes.length > 0) {
			const {lineHeight, textTop} = placeOnLine(layout, lineNodes);

			// css2 §10.8.1: a line is as tall as the line-height of its block
			// and of the text on it, with the leading split above and below.
			// The odd row goes below.
			let rows = blockRows;
			for (const node of lineNodes) {
				if (node.leaf.type !== "text") {
					continue;
				}
				const element = flatParentElement(node.leaf.node);
				if (element === null) {
					continue;
				}
				let own = rowsByElement.get(element);
				if (own === undefined) {
					own = getTextStyle(element).lineHeightRows;
					rowsByElement.set(element, own);
				}
				rows = Math.max(rows, own);
			}
			const leading = Math.max(0, rows - lineHeight);

			// Visual order here rather than at paint time, so hit-testing and
			// selection read the coordinates the user is looking at.
			toVisualLine(layout, lineNodes, bestBreakWidth, base);

			lines.push({
				segments: fitToLength(lineNodes),
				y: currentY + Math.floor(leading / 2),
				height: lineHeight,
				width: bestBreakWidth,
				textTop,
			});

			currentY += lineHeight + leading;
		}

		if (
			bestBreak < content.text.length && content.text[bestBreak - 1] !== "\n"
		) {
			wrapped = true;
		}
		lineStart = bestBreak;
	}

	return {lines: fitToLength(lines), wrapped, height: currentY};
}

// css2 §10.8: each box on a line is placed by its vertical-align, text on
// the line's baseline and an atomic inline with its baseline on it, and
// the line is as tall as what reaches furthest above the baseline and
// below it. In whole rows: text is a row, with the baseline its bottom.
function placeOnLine(
	layout: Layout,
	segments: LineResult["segments"],
): {lineHeight: number; textTop: number} {
	let above = 1;
	let below = 0;
	const atomics: Array<{
		segment: LineResult["segments"][number];
		height: number;
		baseline: number;
		align: string;
	}> = [];
	for (const segment of segments) {
		if (segment.leaf.type !== "inline-block") {
			continue;
		}
		const leaf = segment.leaf;
		const height = Math.round(
			leaf.contentHeight +
				leaf.boxModel.paddingTop +
				leaf.boxModel.paddingBottom +
				leaf.boxModel.borderTopWidth +
				leaf.boxModel.borderBottomWidth,
		);
		const align = getTextStyle(leaf.node).verticalAlign;
		const baseline = getAtomicBaseline(layout, leaf, height);
		atomics.push({segment, height, baseline, align});
		if (align !== "top" && align !== "bottom" && align !== "middle") {
			above = Math.max(above, baseline);
			below = Math.max(below, height - baseline);
		}
	}
	let lineHeight = above + below;
	for (const {height} of atomics) {
		lineHeight = Math.max(lineHeight, height);
	}
	for (const {segment, height, baseline, align} of atomics) {
		segment.height = height;
		segment.dy = align === "top"
			? 0
			: align === "bottom"
			? lineHeight - height
			: align === "middle"
			? Math.floor((lineHeight - height) / 2)
			: above - baseline;
	}
	return {lineHeight, textTop: above - 1};
}

// The rows from an atomic inline's top through the row its baseline is
// the bottom of (css2 §10.8.1): an inline-table's, an inline-grid's or an
// inline-flex's first line, an inline-block's last when it shows its
// content past its edges, and otherwise, a replaced box's included, its
// bottom edge.
function getAtomicBaseline(
	layout: Layout,
	leaf: InlineBlockLeaf,
	height: number,
): number {
	const element = leaf.node;
	const display = getLayoutDisplay(element);
	const first =
		display === "inline-table" ||
		display === "inline-grid" ||
		display === "inline-flex";
	if (
		isReplacedBox(element) ||
		(!first &&
			(getComputedValue(element, "overflow-x") !== "visible" ||
				getComputedValue(element, "overflow-y") !== "visible"))
	) {
		return height;
	}
	const inset = leaf.boxModel.borderTopWidth + leaf.boxModel.paddingTop;
	const context = layout.boxes.get(element)?.independentFormattingContext;
	const line = context
		? getLineInTree(layout, context, first)
		: leaf.breakResult === undefined || leaf.breakResult.lines.length === 0
		? null
		: first ? leaf.breakResult.lines[0].y : leaf.breakResult.lines.at(-1)!.y;
	return line === null
		? height
		: Math.min(height, Math.max(1, Math.round(inset + line + 1)));
}

// The top of the first or last line laid out in a tree, from its root's
// top, depth first through the boxes in flow.
function getLineInTree(
	layout: Layout,
	node: LayoutNode,
	first: boolean,
): number | null {
	const children = first ? node.children : [...node.children].reverse();
	for (const child of children) {
		if (
			child.style.displayType === "none" ||
			child.style.positionType === "absolute" ||
			child.style.positionType === "fixed"
		) {
			continue;
		}
		const lines = child.measure === null
			? undefined
			: getMeasuredLines(layout, child);
		const line = lines !== undefined && lines.lines.length > 0
			? (first ? lines.lines[0] : lines.lines.at(-1)!).y +
				child.style.border.top +
				child.result.paddingTop
			: getLineInTree(layout, child, first);
		if (line !== null) {
			return child.grid.top + line;
		}
	}
	return null;
}

// The rows a line-height asks for: as many as it is times the text's font
// size, rounded down, and at least one. A terminal draws every glyph one row
// tall whatever its size, so the ratio is what carries the spacing the
// author set: 1.5 is one row and 2 is two, at any font size and any cell.
// One that resolves to no length (normal, or a font size the engine cannot
// measure) is one row.
function getLineHeightRows(value: string, fontSizeValue: string): number {
	const fontSize = parseFloat(fontSizeValue);
	const ratio = value.endsWith("px")
		? parseFloat(value) / fontSize
		: /^\d*\.?\d+$/.test(value) ? parseFloat(value) : NaN;
	return ratio >= 2 && Number.isFinite(ratio) ? Math.floor(ratio) : 1;
}

// css-text-3 §4.1.3: the spaces that end a line hang, so they neither keep
// it from fitting nor count toward its width or its last segment's. They
// stay in the segment's data range, where the caret and selection walk.
// `pre` and `break-spaces` keep theirs. A line of nothing but spaces keeps
// one, so it still has a box.
function getHangingSpaces(
	content: ProcessedContent,
	start: number,
	end: number,
): number {
	let count = 0;
	while (end - count - 1 > start && content.text[end - count - 1] === " ") {
		count++;
	}
	if (count === 0 || !content.keepsEndSpaces) {
		return count;
	}
	for (const item of content.items) {
		if (
			item.leafNode.type === "text" &&
			item.start < end &&
			item.end > end - count
		) {
			const whiteSpace = getWhiteSpace(item.leafNode.node);
			if (whiteSpace === "pre" || whiteSpace === "break-spaces") {
				return 0;
			}
		}
	}
	return count;
}

function measureText(
	content: ProcessedContent,
	start: number,
	end: number,
): number {
	return content.getPrefixWidths[end] - content.getPrefixWidths[start];
}

// Both halves are needed. Each segment's characters reorder (bidi-js, through text.ts),
// and in an RTL paragraph the segments mirror across the line.
// Reordering stays within each leaf. Whole-line reordering would merge
// and re-split segments, losing the leaf identity painting, hit-testing
// and selection key on.
function toVisualLine(
	layout: Layout,
	segments: LineResult["segments"],
	lineWidth: number,
	base: "ltr" | "rtl",
): void {
	if (layout.terminalReordersText) {
		return;
	}
	// The common case pays one scan.
	if (base === "ltr" && !segments.some((s) => hasRTL(s.processedText))) {
		return;
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
			// Shaping is not length-preserving (a lam-alef pair collapses into
			// one glyph). Pin the RIGHT edge, the RTL flush edge, and let the
			// spare cell fall on the left, where an RTL reader expects ragged.
			if (segment.leaf.type === "text") {
				const shaped = getStringWidth(segment.processedText);
				const delta = segment.width - shaped;
				if (delta > 0) {
					segment.x += delta;
					segment.width = shaped;
				}
			}
		}
	}
}

// justify is not implemented. It would redistribute space during
// breaking, not shift an already-broken line.
export function getLineAlignOffset(
	container: Element | null,
	containerWidth: number | undefined,
	lineWidth: number,
): number {
	if (!container || containerWidth === undefined) {
		return 0;
	}
	const {direction, textAlign} = getTextStyle(container);
	const rtl = direction === "rtl";
	// A line too long for its box is start-aligned, whatever text-align
	// says, and overflows at its end edge (css-text-3 §7.1). In a
	// right-to-left paragraph that edge is the left.
	// Whole cells: a line starts at a column. Centered, the odd cell goes
	// before the line.
	if (lineWidth > containerWidth) {
		return rtl ? Math.round(containerWidth - lineWidth) : 0;
	}
	const align = CSSValues.getLineAlignment(textAlign);
	if (align === "center") {
		return Math.max(0, Math.round((containerWidth - lineWidth) / 2));
	}
	if (align === "right") {
		return Math.max(0, Math.round(containerWidth - lineWidth));
	}
	if (align === "left") {
		return 0;
	}
	// `start` and `end` name the reading direction's ends, trading sides
	// in an RTL paragraph. An undeclared alignment is `start`.
	const atRightEdge = align === "end" ? !rtl : rtl;
	return atRightEdge ? Math.max(0, Math.round(containerWidth - lineWidth)) : 0;
}

// Added on top of text-align's offset rather than shrinking the line
// box as a browser would. Indent with center/right is rare enough not
// to matter.
export function getLineIndent(
	isFirstLine: boolean,
	container: Element | null,
	containerWidth: number | undefined,
): number {
	if (!isFirstLine || !container) {
		return 0;
	}
	const parsed = toCellLength(
		CSSValues.parseUnitValue(getTextStyle(container).textIndent),
		false,
		container,
	);
	if (parsed === null) {
		return 0;
	}
	if (typeof parsed === "number") {
		return parsed;
	}
	return containerWidth === undefined
		? 0
		: (parsed.percentage / 100) * containerWidth;
}

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
				segment.leaf.type === "inline-block" && segment.leaf.node === element
			) {
				return {
					line,
					segment: segment as LineResult["segments"][number] &
					{leaf: InlineBlockLeaf},
				};
			}
		}
	}
	return null;
}

// Where a line's boxes start across its container: text-align's offset
// and the first line's indent, as the painter places them.
function getLineStart(
	container: Element | null,
	lines: BreakResult,
	line: LineResult,
): number {
	return (
		getLineAlignOffset(container, lines.containerWidth, line.width) +
		getLineIndent(line === lines.lines[0], container, lines.containerWidth)
	);
}

// The element whose scroll offsets a box carries as its own: any but html
// and body, whose scroll is the document's and is applied once at paint.
function getScrollOwner(layout: Layout, node: LayoutNode): Element | null {
	const owner = node.owner as Node | undefined;
	if (!owner || getNodeType(owner) !== owner.ELEMENT_NODE) {
		return null;
	}
	const element = owner as Element;
	return isRootBox(layout, element) ? null : element;
}

function scrollsContent(layout: Layout, node: LayoutNode): boolean {
	const element = getScrollOwner(layout, node);
	return element !== null && isScrollContainer(element);
}

// A sticky box is laid out in flow and then moved, as far as the box it
// flows in allows, to keep its insets against the scrollport of the
// nearest scroller above it, or against the viewport when there is none.
function getStickyShift(
	layout: Layout,
	node: LayoutNode,
): {x: number; y: number} {
	const parent = node.parent;
	if (parent === null) {
		return {x: 0, y: 0};
	}
	// The box's position in the scroller's own coordinates, carrying the
	// shifts of the sticky boxes between.
	let x = 0;
	let y = 0;
	let scroller: LayoutNode | null = null;
	let current = node;
	for (; current.parent !== null; current = current.parent) {
		x += current.grid.left;
		y += current.grid.top;
		if (current !== node && current.style.positionType === "sticky") {
			const shift = getStickyShift(layout, current);
			x += shift.x;
			y += shift.y;
		}
		if (scrollsContent(layout, current.parent)) {
			scroller = current.parent;
			break;
		}
	}
	// Past an inline-block's own root the walk goes on from the
	// inline-block, which places the root's rows in its own frame. Both it
	// and the scroller are read where they are drawn, and the scroller's
	// own offset undone, so the position counts as the scroller's do.
	let crossedScroller: Element | null = null;
	let crossedRect: DOMRect | null = null;
	if (scroller === null && current !== layout.initialBlock) {
		const host = contextHosts.get(current);
		const hostRect = host === undefined ? null : layout.getRect(host);
		if (host === undefined || hostRect === null) {
			return {x: 0, y: 0};
		}
		const hostBox = getBoxModel(host);
		x += hostRect.x + hostBox.borderLeftWidth + hostBox.paddingLeft;
		y += hostRect.y + hostBox.borderTopWidth + hostBox.paddingTop;
		for (
			let outer = flatParentElement(host);
			outer !== null;
			outer = flatParentElement(outer)
		) {
			if (isScrollContainer(outer) && !isRootBox(layout, outer)) {
				crossedRect = layout.getRect(outer);
				crossedScroller = crossedRect === null ? null : outer;
				break;
			}
		}
		if (crossedScroller !== null) {
			x += getScrollOffset(crossedScroller, "left") - crossedRect!.x;
			y += getScrollOffset(crossedScroller, "top") - crossedRect!.y;
		}
	}
	let portLeft = 0;
	let portTop: number;
	let portWidth: number;
	let portHeight: number;
	if (crossedScroller !== null) {
		const box = getBoxModel(crossedScroller);
		portLeft =
			(box.borderLeftWidth || 0) + getScrollOffset(crossedScroller, "left");
		portTop =
			(box.borderTopWidth || 0) + getScrollOffset(crossedScroller, "top");
		portWidth =
			crossedRect!.width -
			(box.borderLeftWidth || 0) -
			(box.borderRightWidth || 0);
		portHeight =
			crossedRect!.height -
			(box.borderTopWidth || 0) -
			(box.borderBottomWidth || 0);
	} else if (scroller === null) {
		// scrollY is CSS pixels: a whole number of rows, each a cell tall.
		const window = layout.window;
		portTop = window.scrollY / getCellSize(window.document).height;
		portWidth = layout.initialBlock.grid.width;
		portHeight = layout.initialBlock.style.height.value;
	} else {
		const element = scroller.owner as Element;
		const box = getBoxModel(element);
		portLeft = (box.borderLeftWidth || 0) + getScrollOffset(element, "left");
		portTop = (box.borderTopWidth || 0) + getScrollOffset(element, "top");
		portWidth =
			scroller.grid.width -
			(box.borderLeftWidth || 0) -
			(box.borderRightWidth || 0);
		portHeight =
			scroller.grid.height -
			(box.borderTopWidth || 0) -
			(box.borderBottomWidth || 0);
	}
	// The box the sticky one flows in bounds the shift: its content box,
	// or everything it scrolls when it is the scroller itself.
	const parentX = x - node.grid.left;
	const parentY = y - node.grid.top;
	const owner = parent.owner as Node | undefined;
	const edges = owner && getNodeType(owner) === owner.ELEMENT_NODE
		? getBoxModel(owner as Element)
		: null;
	let left = parentX + (edges?.borderLeftWidth || 0);
	let top = parentY + (edges?.borderTopWidth || 0);
	let right = parentX + parent.grid.width - (edges?.borderRightWidth || 0);
	let bottom = parentY + parent.grid.height - (edges?.borderBottomWidth || 0);
	const scrolled = parent === scroller
		? layout.getScrollExtent(owner as Element)
		: null;
	if (scrolled !== null) {
		right = scrolled.width === null ? right : left + scrolled.width;
		bottom = top + scrolled.height;
	} else {
		left += edges?.paddingLeft || 0;
		top += edges?.paddingTop || 0;
		right -= edges?.paddingRight || 0;
		bottom -= edges?.paddingBottom || 0;
	}
	return {
		x: stickyShiftAlong(
			x,
			node.grid.width,
			portLeft,
			portWidth,
			left,
			right,
			resolveValue(node.style.position.left, portWidth),
			resolveValue(node.style.position.right, portWidth),
		),
		y: stickyShiftAlong(
			y,
			node.grid.height,
			portTop,
			portHeight,
			top,
			bottom,
			resolveValue(node.style.position.top, portHeight),
			resolveValue(node.style.position.bottom, portHeight),
		),
	};
}

// The start inset pushes the box down the axis, the end inset pulls it
// back, and neither takes it past the container's edges.
function stickyShiftAlong(
	position: number,
	size: number,
	portStart: number,
	portSize: number,
	containerStart: number,
	containerEnd: number,
	startInset: number,
	endInset: number,
): number {
	let shift = 0;
	if (!Number.isNaN(startInset)) {
		const wanted = portStart + startInset;
		if (position < wanted) {
			shift = Math.min(wanted - position, containerEnd - (position + size));
		}
	}
	if (!Number.isNaN(endInset)) {
		const wanted = portStart + portSize - endInset - size;
		if (position + shift > wanted) {
			shift = Math.max(wanted - position, containerStart - position);
		}
	}
	return Math.round(shift);
}

// What scrolling does to a box's position. The scrollers in its
// containing block chain move it by their scroll offsets, and a sticky
// box in that chain, itself included, is shifted to hold its insets. An
// in-flow box is contained by its parent, so every ancestor is in the
// chain. An absolute box is contained by the nearest positioned or
// containing ancestor, so the scrollers below that leave it alone. A
// fixed box is contained by the viewport, so none of them move it. A
// sticky shift comes from the finished layout, so a solve still running
// goes without it.
function getScrollShift(
	layout: Layout,
	layoutNode: LayoutNode,
	solving: boolean,
): {x: number; y: number} {
	let x = 0;
	let y = 0;
	let current: LayoutNode | null = layoutNode;
	while (current !== null) {
		const type: PositionType = current.style.positionType;
		if (type === "sticky" && !solving) {
			const shift = getStickyShift(layout, current);
			x += shift.x;
			y += shift.y;
		}
		if (type === "fixed") {
			break;
		}
		let next: LayoutNode | null = current.parent;
		if (type === "absolute") {
			while (
				next !== null && next.parent !== null && !isContainingBlock(next.style)
			) {
				next = next.parent;
			}
		}
		if (next === null) {
			break;
		}
		const owner = next.owner as Node | undefined;
		if (owner && getNodeType(owner) === owner.ELEMENT_NODE) {
			const left = getScrollOffset(owner as Element, "left");
			const top = getScrollOffset(owner as Element, "top");
			if ((left !== 0 || top !== 0) && !isRootBox(layout, owner as Element)) {
				x -= left;
				y -= top;
			}
		}
		current = next;
	}
	return {x, y};
}

// Document-space geometry: the layout position under what scrolling has
// done to it. Applied in this one function so paint, getRect,
// hit-testing and Range geometry all inherit it at once. In whole cells,
// or, for a solve still running, as layout writes it.
function getAbsolutePosition(
	layout: Layout,
	layoutNode: LayoutNode,
	solving = false,
): {x: number; y: number} {
	let x = 0;
	let y = 0;
	for (
		let current: LayoutNode | null = layoutNode;
		current;
		current = current.parent
	) {
		const place = solving ? current.result : current.grid;
		x += place.left;
		y += place.top;
	}
	const shift = getScrollShift(layout, layoutNode, solving);
	return {x: x + shift.x, y: y + shift.y};
}

function getBreakResultTextIndex(
	layout: Layout,
	breakResult: BreakResult,
): Map<Node, TextFragmentEntry[]> {
	let index = layout.rectTextIndices.get(breakResult);
	if (index) {
		return index;
	}
	index = new Map();
	let ord = 0;
	const visit = (segments: any[], baseX: number, lineIndex: number): void => {
		for (const segment of segments) {
			if (segment.leaf.type === "text" || segment.leaf.type === "br") {
				const node = segment.leaf.node as Node;
				let entries = index!.get(node);
				if (!entries) {
					index!.set(node, (entries = []));
				}
				entries.push({
					line: lineIndex,
					x: baseX + segment.x,
					column: segment.x,
					width: segment.width,
					text: segment.processedText,
					startOffset: segment.dataStart,
					endOffset: segment.dataEnd,
					visualBase: segment.visualBase,
					ord: ord++,
				});
			} else if (segment.leaf.type === "edge") {
				const node = segment.leaf.node as Node;
				let entries = index!.get(node);
				if (!entries) {
					index!.set(node, (entries = []));
				}
				entries.push({
					line: lineIndex,
					x: baseX + segment.x,
					column: segment.x,
					width: segment.width,
					text: "",
					startOffset: 0,
					endOffset: 0,
					visualBase: null,
					ord: ord++,
					edge: segment.leaf,
				});
			} else if (
				segment.leaf.type === "inline-block" && segment.leaf.breakResult
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
	layout.rectTextIndices.set(breakResult, index);
	return index;
}

// Children are probed in REVERSE tree order (last-painted wins).
// Positioned children are skipped. Their context probes them.
function hitTestInFlow(
	layout: Layout,
	element: Element,
	x: number,
	y: number,
): Element | null {
	if (getNodeType(element) !== 1) {
		return null;
	}
	if (getComputedValue(element, "display") === "none") {
		return null;
	}
	// A display:contents element has no box to contain the point, and a
	// broken inline covers only its fragments, so neither gates the
	// descent.
	const boxless = isDisplayContents(element);
	let contained = false;
	if (!boxless) {
		try {
			contained = isPointInRects(x, y, layout.getRects(element));
		} catch (_err) {
			return null;
		}
		// A box that does not clip may have a child lying outside it, which
		// the pointer can still reach. The paint extent says whether any
		// row of the subtree is there at all.
		if (!contained && !isSplitAroundBlock(element)) {
			if (
				getUsedOverflow(element, "x") !== "visible" ||
				getUsedOverflow(element, "y") !== "visible"
			) {
				return null;
			}
			// A box measured on a line is covered by the line's extent. With no
			// extent counted in document rows, nothing is ruled out.
			const node =
				getLayoutNode(layout, element) ?? getBox(layout, element)?.layoutNode;
			const extent = node ? paintExtent(node, layout.initialBlock) : undefined;
			if (extent !== undefined && (y < extent.top || y >= extent.bottom)) {
				return null;
			}
		}
	}
	// A plain vertical stack knows which children reach the row, so a
	// long list is not walked whole for every pointer move. Paint extents
	// are unscrolled document rows, so only an unscrolled element asks.
	const candidates =
		scrolledAncestorRows(layout, element) === 0 &&
		getScrollOffset(element, "top") === 0
			? getVisibleChildren(layout, element, y, y + 1)
			: null;
	const children: Element[] = [];
	for (const child of candidates ?? flowContent(element)) {
		if (getNodeType(child) !== 1) {
			continue;
		}
		if (isPositioned(child as Element)) {
			continue;
		}
		children.push(child as Element);
	}
	for (let i = children.length - 1; i >= 0; i--) {
		const hit = hitTestInFlow(layout, children[i], x, y);
		if (hit) {
			return hit;
		}
	}
	// pointer-events: none lets the point through to what is behind, while
	// a descendant that sets it back to auto still takes it.
	return contained && getComputedValue(element, "pointer-events") !== "none"
		? element
		: null;
}

// CSS 2 §10.3.7, read from the flow the box left: after the previous
// box of a block container, or at the inline position in the line it
// would have joined. A flex container reports none (css-flexbox-1
// §4.1). Called during the containing block's layout, so its own offset
// is not final, but it appears in both sums and cancels in the
// difference.
function getStaticPosition(
	layout: Layout,
	element: Element,
	containingBlock: LayoutNode,
): {left: number; top: number} | null {
	const container = getRunContainer(layout, element);
	if (!container) {
		return null;
	}
	if (hasItemChildren(getLayoutDisplay(container))) {
		return null;
	}
	const containerNode = getContainerLayoutNode(layout, container);
	if (!containerNode) {
		return null;
	}

	// Positions count from the root of the tree a node is in, the
	// document's or an inline-block's own, and one from another root says
	// nothing about where this box would be.
	if (getLayoutRoot(containerNode) !== getLayoutRoot(containingBlock)) {
		return null;
	}
	const origin = getAbsolutePosition(layout, containerNode, true);
	const containingOrigin = getAbsolutePosition(layout, containingBlock, true);
	const offsetLeft = origin.x - containingOrigin.x;
	const offsetTop = origin.y - containingOrigin.y;
	const contentLeft =
		containerNode.style.border.left + containerNode.result.paddingLeft;
	const contentTop =
		containerNode.style.border.top + containerNode.result.paddingTop;

	const box = getContainerBox(layout, container);
	const children = box.children!;
	let entry: Box | null = null;
	for (let current: Node = element; current !== container;) {
		const found = getHead(box.heads!, current);
		if (found) {
			entry = found;
			break;
		}
		const parent = getBoxParentElement(current);
		if (!parent) {
			break;
		}
		current = parent;
	}

	// In an inline formatting context: the position the line had reached.
	if (entry?.kind === "anonymous") {
		const runNode = entry.layoutNode;
		if (runNode) {
			const runOrigin = getAbsolutePosition(layout, runNode, true);
			const cursor = getInlineCursorBefore(entry, element);
			return {
				left: runOrigin.x - containingOrigin.x + cursor.x,
				top: runOrigin.y - containingOrigin.y + cursor.y,
			};
		}
	}

	// A block container: after the last IN-FLOW box that took a position.
	const index = children.indexOf(entry ?? getPrincipalBox(layout, element));
	for (let i = index - 1; i >= 0; i--) {
		const previous = children[i];
		// A table part takes its place in the anonymous table around it.
		const previousNode = getOwnLayoutNode(
			layout,
			box.tables?.get(previous) ?? previous,
		);
		if (
			!previousNode ||
			previousNode.parent !== containerNode ||
			(previous.node !== null && isOutOfFlow(previous.node))
		) {
			continue;
		}
		return {
			left: offsetLeft + contentLeft,
			top:
				offsetTop +
				previousNode.result.top +
				(!Number.isNaN(previousNode.result.height)
					? previousNode.result.height
					: 0) +
				previousNode.result.marginBottom,
		};
	}
	return {left: offsetLeft + contentLeft, top: offsetTop + contentTop};
}

const ZERO_OFFSET = {x: 0, y: 0};

// How far the run's line had advanced when it reached a node that
// generates no box in it, relative to the run's box.
function getInlineCursorBefore(
	run: Box,
	element: Element,
): {x: number; y: number} {
	const breakResult = run.fragments;
	if (!breakResult) {
		return ZERO_OFFSET;
	}
	let cursor = ZERO_OFFSET;
	for (const line of breakResult.lines) {
		for (const segment of line.segments) {
			const position = element.compareDocumentPosition(segment.leaf.node);
			if (!(position & element.DOCUMENT_POSITION_PRECEDING)) {
				return cursor;
			}
			cursor = {
				x:
					segment.x +
					segment.width +
					(segment.leaf.type === "inline-block"
						? segment.leaf.boxModel.marginRight
						: 0),
				y: line.y + line.textTop,
			};
		}
	}
	return cursor;
}

function getNodesInRange(
	items: ProcessedContent["items"],
	start: number,
	end: number,
): LineResult["segments"] {
	const nodes: LineResult["segments"] = [];
	let x = 0;

	for (const item of items) {
		if (item.start >= end || item.end <= start) {
			continue;
		}

		const itemStart = Math.max(item.start, start);
		const itemEnd = Math.min(item.end, end);

		if (itemStart < itemEnd) {
			let width = 0;
			if (item.leafNode.type === "text" && item.processedContent) {
				const relativeStart = itemStart - item.start;
				const relativeEnd = itemEnd - item.start;
				// A preserved newline is a break, never a glyph. A literal \n
				// reaching the painter would feed the terminal a raw line feed,
				// shifting every later cell of the frame.
				const portion = item.processedContent
					.slice(relativeStart, relativeEnd)
					.replace(/\n+$/, "");
				width = getStringWidth(portion);

				// The data range that renders back to `portion`. An empty
				// fragment still reports where it sits, since that is a blank
				// line's caret slot.
				const offsets = item.dataOffsets ?? null;
				const dataStart = relativeStart < item.processedContent.length
					? getDataOffset(offsets, relativeStart)
					: item.leafNode.node.data.length;
				const dataEnd = portion.length > 0
					? getDataOffset(offsets, relativeStart + portion.length - 1) + 1
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
					dy: 0,
					height: 0,
				});
			} else if (item.leafNode.type === "inline-block") {
				// The placeholder advances by the margin box, so the line fits it
				// whole; the segment is the border box, which is what a rect,
				// a paint and a nested offset are of.
				const {marginLeft, marginRight} = item.leafNode.boxModel;
				width = getInlineBlockWidth(item.leafNode);
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
					x: x + marginLeft,
					width: width - marginLeft - marginRight,
					processedText,
					dataStart: 0,
					dataEnd: 0,
					visualBase: null,
					dy: 0,
					height: 0,
				});
			} else if (item.leafNode.type === "edge") {
				width = getEdgeWidth(item.leafNode);
				nodes.push({
					leaf: item.leafNode,
					start: 0,
					end: 0,
					x,
					width,
					processedText: "",
					dataStart: 0,
					dataEnd: 0,
					visualBase: null,
					dy: 0,
					height: 0,
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
					dy: 0,
					height: 0,
				});
			}

			x += width;
		}
	}

	return nodes;
}

function isPointInRects(
	x: number,
	y: number,
	...rects: Array<DOMRect | DOMRect[] | DOMRectList>
): boolean {
	const allRects = rects.flat();
	return allRects.some((rect) => {
		if (Array.isArray(rect) || implementsInterface(rect, DOMRectList)) {
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

function layoutRect(engine: Layout, element: Element): DOMRect | null {
	return element.isConnected ? engine.getRect(element) : null;
}

// Every layout node the document can reach: its trees, the detached
// nodes it keeps for the re-add sweep, and the trees of its independent
// formatting contexts.
function *getLiveLayoutNodes(layout: Layout): Generator<LayoutNode> {
	const pending: LayoutNode[] = [layout.initialBlock];
	for (const [node, layoutNode] of layout.nodeMap) {
		pending.push(layoutNode);
		const root = layout.boxes.get(node)?.independentFormattingContext;
		if (root) {
			pending.push(root);
		}
	}
	for (const layoutNode of layout.anonymousBoxes.keys()) {
		pending.push(layoutNode);
	}
	const seen = new Set<LayoutNode>();
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (!seen.has(node)) {
			seen.add(node);
			yield node;
			pending.push(...node.children);
		}
	}
}

export class Layout {
	domRect: typeof DOMRect;
	rootElement: Element;
	window: Window;

	// The terminal-sized root every box hangs from. It has no DOM node.
	initialBlock: LayoutNode;

	// The cached results of every layout node of the document.
	cachePool: CachePool;

	// Not every node has one. A run member is measured by the run around
	// it and owns none, which is what getOwnLayoutNode checks.
	nodeMap: Map<Node, LayoutNode>;

	invalidatedNodes: Set<Node>;

	// The nodes whose own box changed since the last pass: invalidated,
	// re-derived, or under a subtree that was. A container's sync builds and
	// styles these and only moves its other children into place. Everything,
	// after an invalidation of the whole layout.
	touched: Set<Node> | "all";

	// A SUPERSET hint. An element whose position went static without a
	// restyle reaching its node is still listed, so every reader checks
	// isPositioned too and uses the set only for the enumeration it saves.
	// An isolated box is listed too, since it paints in a layer. The paint
	// side's grouping is O(positioned), never O(document).
	positionedElements: Set<Element>;

	// Re-measured on resize. What they returned was for another width.
	measureNodes: Set<LayoutNode>;

	// The terminal reorders bidirectional text itself (negotiateBidi), so
	// lines stay logical. One reordering is correct and two is backwards
	// again.
	terminalReordersText: boolean;

	// Each text node's last rendering, keyed by the data and white-space it
	// was rendered under. One run is broken once per width the sizing pass
	// tries, and the rendering is the same every time.
	renderedLeaves: WeakMap<
		Text,
		{key: string; text: string; offsets: Int32Array | null}
	>;

	// Per break result, each text node's placed fragments in segment order.
	// Keyed on the break result object. Re-breaking builds a fresh object,
	// so entries can never go stale.
	rectTextIndices: WeakMap<object, Map<Node, TextFragmentEntry[]>>;

	// The identity a derivation syncs against. A container rebuilt
	// around a node finds the box the node already had, with its layout
	// node and fragments.
	boxes: WeakMap<Node, Box>;

	// Each <math> element's last laid-out box. Written by whichever
	// measurement placed the element and read back by the painter.
	mathBoxes: WeakMap<Element, MathBox>;
	// Whether any <math> was ever laid out, so a page without one never
	// searches an element's ancestors for it.
	laidOutMath: boolean;

	// The reverse of Box.layoutNode, and the registry the sweeps that must
	// reach every box (resize, pruning, disposal) walk. Strong, because
	// boxes a re-derivation drops must still be dropped.
	anonymousBoxes: Map<LayoutNode, Box>;
	// The unlink count when nodes that left the document were last swept.
	prunedAtUnlinks: number;

	// Containers whose enumeration still describes their children. A
	// mutation drops the ones it disturbs, so flipping a class on one row
	// of a long list re-enumerates that row and not the boxes around it. An
	// unbounded change drops the set. Weak, because a container listed here
	// may be the last thing holding a removed subtree.
	derivedContainers: WeakSet<Element>;

	// Containers whose box list may not match their layout children.
	// Reconciled once per pass however many mutations dirtied them.
	dirtyRunContainers: Set<Element>;

	// Collected rather than acted on. The cascade announces these
	// mid-invalidation, while descendants still hold the styles they are
	// about to lose, and every question layout would ask is about styles
	// that have not finished arriving.
	restyled: Set<Element>;

	// Geometry moved since the last painted frame.
	geometryMoved: boolean;
	// Counts layout passes, so a node styled in this pass is not styled
	// again when a container re-adds it.
	pass: number;
	// Whether each element looked up during a pass is hidden, by its own
	// display or an ancestor's, which no pass can change. Null between
	// passes.
	hiddenElements: Map<Element, boolean> | null;
	// The runs split in the pass under way, by the box they lay out.
	splitRuns: WeakMap<Box, SplitRun> | null;
	// Counts the passes that solved the tree, so a reader can tell whether
	// geometry changed since it last looked.
	solves: number;
	// The rows the next frame repaints, [top, bottom, fixed] in document
	// rows, or in viewport rows for a box in fixed space. Every row
	// repaints when wholeDamage is set. collecting is set while the paint
	// extents of the document, not of a box's own formatting context, are
	// written, which is when moved boxes add their rows.
	damage: Array<[number, number, boolean]>;
	wholeDamage: boolean;
	collecting: boolean;
	// Elements whose style changed with no layout change, and whether the
	// selection moved. Their rows are found once layout is current.
	restyledForPaint: Map<Element, object | null>;
	// Every element restyled since the last layout, for the measures that
	// read it.
	restyledSinceLayout: Set<Element>;
	// Boxes whose own formatting context went stale, so that their measure,
	// which lays it out, is answered again.
	staleHosts: Set<Element>;
	selectionMoved: boolean;
	// The rows each sticky box painted at the last solve, shift included.
	// A shift moves a box's rows with no change to its rect, and only a
	// solve or a scroll changes one, so a solve compares them.
	stickyRows: Map<LayoutNode, StickyRows>;
	// The rows the selection covered at the last frame, from its ends.
	selectionRows: [number, number] | null;

	constructor(window: Window, width: number, height: number) {
		this.geometryMoved = false;
		this.pass = 0;
		this.hiddenElements = null;
		this.splitRuns = null;
		this.solves = 0;
		this.damage = [];
		this.wholeDamage = true;
		this.collecting = false;
		this.restyledForPaint = new Map();
		this.restyledSinceLayout = new Set();
		this.staleHosts = new Set();
		this.selectionMoved = false;
		this.stickyRows = new Map();
		this.selectionRows = null;
		this.positionedElements = new Set<Element>();
		this.terminalReordersText = false;
		this.rectTextIndices =
			new WeakMap<object, Map<Node, TextFragmentEntry[]>>();
		this.boxes = new WeakMap<Node, Box>();
		this.mathBoxes = new WeakMap<Element, MathBox>();
		this.laidOutMath = false;
		this.derivedContainers = new WeakSet<Element>();
		this.anonymousBoxes = new Map<LayoutNode, Box>();
		this.prunedAtUnlinks = -1;
		this.dirtyRunContainers = new Set<Element>();
		this.restyled = new Set<Element>();
		this.renderedLeaves = new WeakMap<
			Text,
			{key: string; text: string; offsets: Int32Array | null}
		>();
		this.window = window;
		this.domRect = window.DOMRect;
		this.rootElement = window.document.documentElement;
		this.nodeMap = new Map<Node, LayoutNode>();
		this.invalidatedNodes = new Set<Node>();
		this.touched = new Set<Node>();
		this.measureNodes = new Set<LayoutNode>();

		// The initial containing block is a formatting context of its own, so
		// the root element's margins stay inside it rather than escaping to
		// nothing.
		this.cachePool = new CachePool(() => getLiveLayoutNodes(this));
		const root = new LayoutNode(this.cachePool);
		root.style = createStyle();
		root.style.displayType = "block";
		root.style.blockFormattingContext = true;
		root.style.width = toValue(width);
		root.style.height = toValue(height);
		this.initialBlock = root;
	}

	/** The block the document lays out in: the terminal's size, in cells. */
	get initialContainingBlock(): {width: number; height: number} {
		return {
			width: this.initialBlock.style.width.value,
			height: this.initialBlock.style.height.value,
		};
	}

	get moved(): boolean {
		return this.geometryMoved;
	}

	// The engine keeps no copy of the size. The root it sizes here is the
	// copy, and the document holds the one everything else reads.
	resize(width: number, height: number): void {
		const root = this.initialBlock;
		root.style.width = toValue(width);
		root.style.height = toValue(height);
		root.invalidate();

		for (const layoutNode of this.measureNodes) {
			layoutNode.invalidate();
		}

		this.invalidateFrame();
		this.performLayout();
	}

	performLayout(): void {
		this.hiddenElements = new Map();
		this.splitRuns = new WeakMap();
		try {
			this.runLayoutPass();
		} finally {
			this.hiddenElements = null;
			this.splitRuns = null;
		}
	}

	runLayoutPass(): void {
		this.pass++;
		// Built on the first pass, not at construction. The engine is
		// constructed before the cascade that provides display exists.
		if (!this.nodeMap.has(this.rootElement)) {
			addNode(this, this.rootElement, this.initialBlock);
		}
		// The cascade has finished for this frame, so the boxes it unsettled
		// can be resolved against the current styles.
		applyRestyles(this);
		flushStaleHosts(this);
		// Every mutation path dirties the tree on its way in, so a clean tree
		// cannot be hiding a disconnection, and even the pruning sweep below is
		// not worth paying.
		if (
			!this.initialBlock.stale &&
			this.invalidatedNodes.size === 0 &&
			this.dirtyRunContainers.size === 0
		) {
			return;
		}

		// Callers may run synchronously after a DOM removal, before the
		// MutationObserver microtask, and a detached run head measured then has
		// no parent to collect leaves from.
		pruneDisconnectedNodes(this);

		for (const node of this.invalidatedNodes) {
			if (isConnectedNode(node)) {
				// The flat-tree BOX parent. A shadow root's direct child has no
				// parentElement, and attaching under a display:contents element
				// strands the child in an orphan subtree.
				let parent = getBoxParentElement(node);
				while (parent) {
					const parentLayoutNode = getContainerLayoutNode(this, parent);
					if (parentLayoutNode) {
						addNode(this, node, parentLayoutNode);
						break;
					}
					// Climbing past an inline box lands the content in the
					// run's own container, as a sibling of the line it belongs
					// to. A broken inline's fragments really are the
					// container's boxes.
					if (isInlineLevel(parent) && !this.boxes.get(parent)?.broken) {
						break;
					}
					parent = getBoxParentElement(parent);
				}
			}
		}
		this.invalidatedNodes.clear();

		// Drained rather than iterated. Building a box a broken inline handed
		// over reaches containers of its own.
		const synced = new Set<Element>();
		while (this.dirtyRunContainers.size > 0) {
			const containers = [...this.dirtyRunContainers];
			this.dirtyRunContainers.clear();
			for (const container of containers) {
				if (synced.has(container)) {
					continue;
				}
				synced.add(container);
				syncContainerRuns(this, container);
			}
		}
		this.touched = new Set<Node>();
		// A formatting context a box lays out for itself hangs off that box's
		// measure, not off the tree, so a sync that changed one leaves the
		// tree clean. Its box is measured again, and the tree with it.
		for (const container of synced) {
			const host = getEnclosingIndependentFormattingContext(this, container);
			if (
				host !== null &&
				host.isConnected &&
				this.boxes.get(host)!.independentFormattingContext!.stale
			) {
				invalidateEnclosingMeasure(this, host);
			}
		}

		// The boxes added above may have joined a box's own formatting
		// context.
		flushStaleHosts(this);

		// A clean root means the previous layout is still exact. Recomputing
		// would be a full-tree relayout per frame for an animation repainting
		// one span.
		if (!this.initialBlock.stale) {
			return;
		}

		// The root's own size is the request. The terminal is the viewport, so
		// html can size to its content and still resolve percentages and
		// viewport units against it.
		const root = this.initialBlock;
		root.performLayout(root.style.width.value, root.style.height.value);
		// A context that went stale while the solve ran and was not laid out
		// after, as one whose box's measure was already answered, is laid out
		// now. One its own measure rebuilt is laid out already.
		for (let pass = 0; pass < 2 && this.staleHosts.size > 0; pass++) {
			const hosts = [...this.staleHosts];
			this.staleHosts.clear();
			let again = false;
			for (const host of hosts) {
				const context = this.boxes.get(host)?.independentFormattingContext;
				if (host.isConnected && context?.stale) {
					invalidateHost(this, host);
					again = true;
				}
			}
			if (!again) {
				break;
			}
			root.performLayout(root.style.width.value, root.style.height.value);
		}
		this.staleHosts.clear();
		this.collecting = !this.wholeDamage;
		computePaintExtents(this, root, 0, 0);
		damageShiftedStickyBoxes(this);
		this.collecting = false;
		this.solves++;
	}

	dispose(): void {
		// The maps are not the only owners: every box hangs from the root,
		// holding a style record and a measure closure, so the tree goes too.
		const root = this.initialBlock;
		while (root.children.length > 0) {
			root.removeChild(root.children[0]);
		}
		this.nodeMap = new Map();
		this.invalidatedNodes = new Set();
		this.measureNodes = new Set();
		this.anonymousBoxes = new Map();
		this.dirtyRunContainers = new Set();
	}

	gridTracks(element: Element, rows: boolean): number[] | null {
		const layoutNode = getContainerLayoutNode(this, element);
		if (!layoutNode) {
			return null;
		}
		return getComputedGridTracks(layoutNode, rows)?.sizes ?? null;
	}

	// The root box's height extended to cover top-layer boxes, which
	// contribute nothing to the flow's height. A picker opening at the
	// bottom edge must still get rows to paint into, and a modal's
	// ::backdrop takes the whole viewport. Reserving less lets the frame's
	// last rows push the terminal past its bottom, a physical scroll no
	// bookkeeping records. The root, not body's scroll height: an inline
	// body's box measures one line however many rows its hoisted block
	// children paint.
	documentPaintHeight(): number {
		const root = this.rootElement;
		const rootRect = this.getRect(root);
		let height = Math.max(
			rootRect ? Math.ceil(rootRect.height) : 0,
			getDocumentOverflowBottom(this),
		);
		const rendered =
			renderedTopLayer(root.ownerDocument!) as unknown as Element[];
		for (const element of rendered) {
			if (isModalDialog(element)) {
				return this.initialBlock.style.height.value;
			}
			const rect = this.getRect(element);
			if (rect) {
				height = Math.max(height, Math.ceil(rect.bottom));
			}
		}
		return height;
	}

	contentRect(element: Element): DOMRect | null {
		const rect = this.getRect(element);
		if (!rect) {
			return null;
		}
		// A box of its own has its border and padding in the solver's
		// result. A box inside a run has only the cascade's.
		const node = this.nodeMap.get(element);
		let left: number;
		let top: number;
		let right: number;
		let bottom: number;
		if (node !== undefined) {
			const {border} = node.style;
			const {result} = node;
			left = border.left + result.paddingLeft;
			top = border.top + result.paddingTop;
			right = border.right + result.paddingRight;
			bottom = border.bottom + result.paddingBottom;
			// Edges its measure counts in its size are not on its node.
			const masked = getMaskedEdges(element);
			if (masked.length > 0) {
				const box = getBoxModel(element);
				if (masked.includes("top")) {
					top = (box.borderTopWidth || 0) + (box.paddingTop || 0);
					bottom = (box.borderBottomWidth || 0) + (box.paddingBottom || 0);
				} else {
					left = (box.borderLeftWidth || 0) + (box.paddingLeft || 0);
					right = (box.borderRightWidth || 0) + (box.paddingRight || 0);
				}
			}
		} else {
			const box = getBoxModel(element);
			left = (box.borderLeftWidth || 0) + (box.paddingLeft || 0);
			top = (box.borderTopWidth || 0) + (box.paddingTop || 0);
			right = (box.borderRightWidth || 0) + (box.paddingRight || 0);
			bottom = (box.borderBottomWidth || 0) + (box.paddingBottom || 0);
		}
		return new this.domRect(
			rect.x + left,
			rect.y + top,
			Math.max(0, rect.width - left - right),
			Math.max(0, rect.height - top - bottom),
		);
	}

	// What scrollWidth/scrollHeight report and scroll offsets clamp
	// against. A measured inline run's leaf takes the width it was offered,
	// so with one present the horizontal extent is unknowable and reported
	// null. Callers must not clamp against a result that does not exist.
	// Null overall for a box the tree does not decompose into child boxes.
	getScrollExtent(
		element: Element,
	): {width: number | null; height: number} | null {
		return measureScrollExtent(this, element);
	}

	offsetSize(element: Element): {width: number; height: number} {
		const rect = layoutRect(this, element);
		return {
			width: Math.round(rect?.width ?? 0),
			height: Math.round(rect?.height ?? 0),
		};
	}

	offsetPosition(element: Element): {top: number; left: number} {
		const rect = layoutRect(this, element);
		if (!rect) {
			return {top: 0, left: 0};
		}
		const parent = this.offsetParent(element);
		const parentRect = parent ? layoutRect(this, parent) : null;
		return {
			top: Math.round(rect.top - (parentRect?.top ?? 0)),
			left: Math.round(rect.left - (parentRect?.left ?? 0)),
		};
	}

	// CSSOM View's offsetParent: the nearest flat-tree ancestor that
	// contains positioned boxes, the body, or a table cell or table,
	// skipping one the element cannot see from its own tree (a slotted
	// node's ancestors inside the shadow tree). A fixed box no ancestor
	// contains has viewport offsets and so no offsetParent, and a fixed
	// ancestor the element cannot see ends the walk with null.
	offsetParent(element: Element): Element | null {
		if (!element.isConnected || !isInFlatTree(element)) {
			return null;
		}
		const document = this.window.document;
		const body = document.body ?? null;
		if (element === body || element === document.documentElement) {
			return null;
		}
		if (
			getComputedValue(element, "position") === "fixed" &&
			getFixedContainingBlock(element) === null
		) {
			return null;
		}
		for (
			let ancestor = flatParentElement(element);
			ancestor !== null;
			ancestor = flatParentElement(ancestor)
		) {
			const position = getComputedValue(ancestor, "position");
			if (!isShadowIncludingAncestor(ancestor, element)) {
				if (position === "fixed") {
					return null;
				}
				continue;
			}
			const name = getLocalName(ancestor);
			if (
				(position !== "" && position !== "static") ||
				establishesFixedContainingBlock(ancestor) ||
				ancestor === body ||
				name === "td" ||
				name === "th" ||
				name === "table"
			) {
				return ancestor;
			}
		}
		return null;
	}

	clientSize(element: Element): {width: number; height: number} {
		const box = getContentBoxSize(this, element);
		return {
			width: Math.round(box?.width ?? 0),
			height: isRootBox(this, element)
				? this.initialBlock.style.height.value
				: Math.round(box?.height ?? 0),
		};
	}

	// A box the tree does not decompose (an inline, a run member) has no
	// readable extent and falls back to its client size.
	scrollSize(element: Element): {width: number; height: number} {
		const extent = element.isConnected ? this.getScrollExtent(element) : null;
		const box = getContentBoxSize(this, element);
		return {
			width: extent?.width ?? Math.round(box?.width ?? 0),
			height: isRootBox(this, element)
				? getDocumentContentHeight(this)
				: (extent?.height ?? Math.round(box?.height ?? 0)),
		};
	}

	// A visible axis does not scroll and pins to 0. hidden scrolls
	// programmatically, as in a browser. Null where the layout cannot
	// determine the extent, which must not be clamped against.
	scrollRange(element: Element, axis: "left" | "top"): number | null {
		const extent = this.getScrollExtent(element);
		const size = extent === null
			? null
			: axis === "top" ? extent.height : extent.width;
		const rect = this.getRect(element);
		const node = this.nodeMap.get(element);
		if (size === null || !rect || node === undefined) {
			return null;
		}
		const overflow =
			getComputedValue(element, `overflow-${axis === "top" ? "y" : "x"}`) ||
			getComputedValue(element, "overflow");
		// The extent reaches the far padding edge, as scrollHeight does, so
		// the port it scrolls in is the padding box, as clientHeight is.
		const {border} = node.style;
		const port = axis === "top"
			? rect.height - border.top - border.bottom
			: rect.width - border.left - border.right;
		const room = size - Math.round(port);
		return isScrollingOverflow(overflow) ? Math.max(0, room) : 0;
	}

	// Innermost first. Each scroll moves the element in every outer port's
	// coordinates, so the rect is re-read per level. What remains is the
	// screen's to reveal.
	alignmentDelta(
		start: number,
		end: number,
		portStart: number,
		portEnd: number,
		align: ScrollLogicalPosition,
	): number {
		return getAlignmentDelta(start, end, portStart, portEnd, align);
	}

	revealInScrollPorts(
		element: Element,
		block: ScrollLogicalPosition = "nearest",
		inline: ScrollLogicalPosition = "nearest",
	): void {
		revealRectInScrollPorts(
			this,
			element,
			() => this.getRect(element),
			block,
			inline,
		);
	}

	/** Scrolls every port around a caret so the caret shows, nearest first. */
	revealCaret(node: Node, offset: number): void {
		const box = getNodeType(node) === node.ELEMENT_NODE
			? (node as Element)
			: flatParentElement(node);
		if (box === null) {
			return;
		}
		revealRectInScrollPorts(
			this,
			box,
			() => {
				const caret = this.getCaretRect(node, offset);
				if (caret !== null) {
					return new this.domRect(caret.x, caret.y, 1, 1);
				}
				const content = this.contentRect(box);
				return content === null
					? null
					: new this.domRect(content.x, content.y, 1, 1);
			},
			"nearest",
			"nearest",
		);
	}

	getRect(element: Element): DOMRect | null {
		const display = getLayoutDisplay(element);

		// The layout node a hidden element keeps is a placeholder holding its
		// slot, not a box (CSSOM View §4).
		if (display === "none") {
			return null;
		}

		// An element inside <math> covers the cells that render its text.
		const math = getEnclosingMath(this, element);
		if (math !== null && math !== element) {
			const rects = getMathNodeRects(this, math, element);
			return rects.length === 0 ? null : unionRects(this, rects);
		}

		// A blockified box's layout node is the truth, not the text
		// union the run machinery below reports, but only once one has been
		// built.
		const blockified =
			isBlockifiedByLayout(element) && this.nodeMap.has(element);

		if (!blockified && isInlineDisplay(display)) {
			if (isAtomicInline(display)) {
				const rect = getInlineBlockRect(this, element);
				if (rect) {
					return rect;
				}
			}

			const rectTexts = getRectTexts(this, element);
			if (rectTexts.length > 0) {
				return unionRects(this, rectTexts.map((rectText) => rectText.rect));
			}

			// An empty inline gets a zero-width rect at its position, as in a
			// browser. The block fallback below would give it the layout node's
			// width, which for an empty inline is its containing block's.
			// inline-block keeps the fallback, since its node IS its box.
			if (display === "inline") {
				const elementLayoutNode = runLayoutNode(this, element);
				if (elementLayoutNode) {
					const position = getAbsolutePosition(this, elementLayoutNode);
					return new this.domRect(position.x, position.y, 0, 0);
				}
				// An empty inline that does not open its run still has a place:
				// the cursor the line had reached, so the span in
				// `<div>ab<span></span>cd</div>` sits at 2.
				const run = getBox(this, element);
				if (run?.layoutNode) {
					const origin = getAbsolutePosition(this, run.layoutNode);
					const cursor = getInlineCursorBefore(run, element);
					return new this.domRect(
						origin.x + cursor.x,
						origin.y + cursor.y,
						0,
						0,
					);
				}
				// Removed, or never laid out.
				return null;
			}
		}

		const layoutNode =
			this.nodeMap.get(element) ?? runLayoutNode(this, element);

		if (!layoutNode) {
			return null;
		}

		const {x, y} = getDocumentPosition(this, element, layoutNode);

		return new this.domRect(
			x,
			y,
			getComputedWidth(layoutNode),
			getComputedHeight(layoutNode),
		);
	}

	getRects(node: Node): DOMRect[] {
		const math = getEnclosingMath(this, node);
		if (math !== null && math !== node) {
			return getMathNodeRects(this, math, node);
		}
		// Everything but true inline content is an atomic box with one rect,
		// inline-block included. An <input> has no text runs at all, and
		// returning none made it invisible to elementFromPoint.
		if (getNodeType(node) === node.ELEMENT_NODE) {
			const element = node as Element;
			if (getUsedDisplay(element) !== "inline") {
				const rect = this.getRect(element);
				return rect ? [rect] : [];
			}
		}

		// One rect per text run per line it spans.
		return getRectTexts(this, node).map((rectText) => rectText.rect);
	}

	// What Range.getClientRects reports, and what the painter reads for the
	// caret and selection. A collapsed range yields one zero-width caret
	// rect. A spanning range yields a rect per contiguous selected run per
	// line.
	getRangeRects(range: Range): DOMRect[] {
		if (!range.collapsed) {
			return getRangeSpans(this, range).map((run) => run.rect);
		}
		const caret = this.getCaretRect(range.startContainer, range.startOffset);
		return caret === null ? [] : [caret];
	}

	/**
	 * The zero-width rect of a caret at the point. Between two nodes, and in
	 * a text node that shows nothing, it stands at the margin edge of the
	 * inline box before it, or else at the start of the one after it.
	 */
	getCaretRect(node: Node, offset: number): DOMRect | null {
		if (getNodeType(node) === node.TEXT_NODE) {
			const shown = this.getRects(node).length > 0;
			return (shown
				? getCaretRectInFragment(this, node as Text, offset)
				: null) ??
				getCaretRectBetween(this, node.previousSibling, node.nextSibling) ??
				getCaretRectInFragment(this, node as Text, offset);
		}
		const next = node.childNodes[offset];
		if (next !== undefined && isLineBreak(next)) {
			return this.getRects(next)[0] ?? null;
		}
		const between = getCaretRectBetween(
			this,
			offset > 0 ? node.childNodes[offset - 1] : null,
			next ?? null,
		);
		if (between !== null) {
			return between;
		}
		const point = textPointAt(node, offset);
		return point === null
			? null
			: getCaretRectInFragment(this, point[0], point[1]);
	}

	// One text node's share of the work above. A highlight narrows its
	// ranges to the node it is painting over, and has no live range to
	// hand getRangeSpans.
	getTextSpans(
		textNode: Text,
		from: number,
		to: number,
	): Array<{rect: DOMRect; text: string}> {
		return to > from ? getSelectionSpans(this, textNode, from, to) : [];
	}

	// The text a text node's boxes show, in logical order, as innerText
	// reads it: white space processed, case transformed, and a preserved
	// newline between two lines kept. A soft wrap is no break, and the
	// space it swallowed is a space again.
	// The one-line text of a <math> element, for innerText. The DOM asks
	// here rather than importing the MathML layout, which reads the DOM.
	getMathText(element: Element): string {
		return linearizeMath(element);
	}

	getRenderedText(textNode: Text): string {
		const data = textNode.data;
		const whiteSpace = getWhiteSpace(textNode);
		const keepsBreaks =
			isSpacePreserving(whiteSpace) || whiteSpace === "pre-line";
		let text = "";
		let previous: number | null = null;
		for (const fragment of this.lineFragments(textNode)) {
			if (previous !== null) {
				const gap = data.slice(previous, fragment.startOffset);
				const breaks = keepsBreaks ? gap.split("\n").length - 1 : 0;
				if (breaks > 0) {
					text += "\n".repeat(breaks);
				} else if (gap.length > 0 && !text.endsWith(" ")) {
					text += " ";
				}
			}
			text += renderWhiteSpace(
				data.slice(fragment.startOffset, fragment.endOffset),
				whiteSpace,
			);
			previous = fragment.endOffset;
		}
		const parent = flatParentElement(textNode);
		return parent === null
			? text
			: applyTextTransform(text, getComputedValue(parent, "text-transform"));
	}

	// The one place laid-out lines get their data ranges. Range geometry,
	// the caret, the painter and textarea navigation all read them here.
	// Two lines exist that no layout fragment produces (the row after a
	// value's final newline, and the sole row of an empty value) because a
	// caret rests on both.
	lineFragments(textNode: Text): LineFragment[] {
		const data = textNode.data;
		const lines: LineFragment[] = [];
		for (const rectText of getRectTexts(this, textNode)) {
			lines.push({
				rect: rectText.rect,
				column: rectText.column,
				startOffset: rectText.startOffset,
				endOffset: rectText.endOffset,
				visualBase: rectText.visualBase,
			});
		}
		// The caret's row after a final Enter: one line below the last, at the
		// same left edge.
		if (lines.length > 0 && data.endsWith("\n")) {
			const last = lines[lines.length - 1].rect;
			lines.push({
				rect: new this.domRect(last.x, last.y + last.height, 0, last.height),
				column: 0,
				startOffset: data.length,
				endOffset: data.length,
				visualBase: null,
			});
		}
		// Empty text's one line sits at the containing block's content-box
		// origin, where a caret rests in an empty text control. An inline
		// parent is passed over: empty, it has no line of its own to place
		// the text on.
		if (lines.length === 0) {
			for (
				let parent = flatParentElement(textNode);
				parent;
				parent = flatParentElement(parent)
			) {
				if (isInlineBox(parent)) {
					continue;
				}
				const content = this.contentRect(parent);
				if (content) {
					lines.push({
						rect: new this.domRect(
							Math.round(content.x),
							Math.round(content.y),
							0,
							this.getRect(parent)!.height || 1,
						),
						column: 0,
						startOffset: 0,
						endOffset: 0,
						visualBase: null,
					});
				}
				break;
			}
		}
		return lines;
	}

	// The inversion of painting. A line's data range renders back to the
	// characters it painted, so walking that rendering by cell width turns
	// a column into an offset, correct over collapsing white space. Landing
	// past the last character means "after it", so a drag selects through
	// end-of-line. With clampToNearestLine a point on no line resolves to
	// the nearest, so a drag that leaves a text control still tracks it.
	caretPositionFromPoint(
		x: number,
		y: number,
		root: Node,
		clampToNearestLine = false,
	): {node: Text; offset: number} | null {
		// Math has no text runs. Its cells know what text they render.
		const math = getEnclosingMath(this, root);
		if (math !== null) {
			const origin = getMathOrigin(this, math);
			return origin === null
				? null
				: findMathPosition(getMathBox(this, math), x - origin.x, y - origin.y);
		}
		let best: {node: Text; offset: number; distance: number} | null = null;
		let nearest: {node: Text; fragment: LineFragment; rows: number} | null =
			null;

		for (const textNode of getTextNodes(root)) {
			const whiteSpace = getWhiteSpace(textNode);
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
				// An empty line is a caret slot in a control's value. In
				// document text it renders nothing and owns no position.
				if (!clampToNearestLine && fragment.endOffset <= fragment.startOffset) {
					continue;
				}
				const found = getOffsetInFragment(textNode, whiteSpace, fragment, x);
				if (!best || found.distance < best.distance) {
					best = {
						node: textNode,
						offset: found.offset,
						distance: found.distance,
					};
				}
			}
		}

		if (best) {
			return {node: best.node, offset: best.offset};
		}
		if (!nearest) {
			return null;
		}
		const found = getOffsetInFragment(
			nearest.node,
			getWhiteSpace(nearest.node),
			nearest.fragment,
			x,
		);
		return {node: nearest.node, offset: found.offset};
	}

	// The inverse of the paint order collectStackingLayers produces. A
	// positioned box is probed at its CONTEXT, not through its parents, so a
	// box hanging outside its parent's rect is still clickable.
	hitTest(
		root: Element,
		x: number,
		y: number,
		topLayer: Set<Element>,
		documentScrollTop: number,
	): Element | null {
		const layers = collectStackingLayers(this, topLayer);
		const document = this.window.document;
		if (!document?.body) {
			return null;
		}
		// Painting starts at the body, unless its content sits in the root's
		// boxes: a body that is inline, inline-block or display: contents.
		const bodyDisplay = getDeclaredDisplay(document.body);
		const paintRoot =
			root === document.documentElement &&
			bodyDisplay !== "contents" &&
			!bodyDisplay.startsWith("inline")
				? document.body
				: root;
		for (const element of [...topLayer].reverse()) {
			if (!flatIsConnected(element)) {
				continue;
			}
			const hit = hitTestContext(
				this,
				element,
				x,
				y,
				layers,
				documentScrollTop,
			);
			if (hit) {
				return hit;
			}
		}
		return hitTestContext(this, paintRoot, x, y, layers, documentScrollTop);
	}

	// The observer drain calls this once per mutation batch. The cascade calls
	// it for style changes no record describes. Every entry that moves geometry
	// announces it here, and the pass itself moves nothing unannounced.
	invalidateFrame(whole = true): void {
		const document = this.rootElement.ownerDocument;
		if (document === null) {
			return;
		}
		usedValuesChanged(document);
		this.geometryMoved = true;
		if (whole) {
			this.wholeDamage = true;
		}
	}

	// A node re-enumerates its whole subtree, because run membership may
	// have changed. No node means an UNBOUNDED change (a stylesheet
	// reparse, a shadow attachment, the bidi flip), and the record of what
	// is derived is dropped whole.
	invalidate(node?: Node): void {
		// Before the first pass nothing is derived, and that pass builds the
		// whole tree from the styles as they are then. Walking the tree now,
		// as attaching a page to its terminal does, matched every rule
		// against every element for nothing.
		if (!this.nodeMap.has(this.rootElement)) {
			this.invalidateFrame();
			return;
		}
		if (node === undefined) {
			// Every box re-derives, and takes its style as it does. The root
			// element is no container's box, so it is restyled on its own.
			this.derivedContainers = new WeakSet<Element>();
			this.restyled.add(this.rootElement);
			this.touched = "all";
			this.invalidateFrame();
			return;
		}
		invalidateSubtreeDerivation(this, node);
		invalidateNode(this, node);
		this.invalidateFrame();
	}

	// Every record's enumerations are dropped before any measure is found.
	// Finding one derives its container again, so a batch that changes
	// many children of one container would otherwise derive it once for
	// each of them.
	handleMutations(mutations: MutationRecord[]): void {
		const measured = new Set<Node>();
		for (const record of mutations) {
			invalidateForRecord(this, record, measured);
		}
		for (const node of measured) {
			invalidateEnclosingMeasure(this, node);
		}
	}

	// Whatever measured the element measured it under the style that is
	// gone, and nothing about the space it was offered says so.
	// Deliberately over-approximate: a change that moves no geometry costs
	// a re-measurement, and one that moves geometry is never missed.
	styleInvalidated(element: Element): void {
		this.restyled.add(element);
	}

	// A chain reaching a fixed box puts the geometry in viewport space
	// rather than document space.
	// Read from the boxes, whose position type is a field, rather than
	// from every ancestor's computed style. A box laid out in an
	// inline-block's own context has no parent past it, and the elements
	// answer from there.
	isInFixedSpace(element: Element): boolean {
		let box: Element | null = element;
		while (box !== null && !this.nodeMap.has(box)) {
			box = flatParentElement(box);
		}
		let node = box === null ? undefined : this.nodeMap.get(box);
		for (; node !== undefined; node = node.parent ?? undefined) {
			if (node.style.positionType === "fixed") {
				return true;
			}
			if (node.parent === null && node !== this.initialBlock) {
				break;
			}
		}
		if (node === undefined) {
			return false;
		}
		for (let el: Element | null = element; el; el = flatParentElement(el)) {
			if (getPosition(el) === "fixed") {
				return true;
			}
		}
		return false;
	}

	/** The principal box of an element, or null before its container derived one. */
	getBox(element: Element): Box | null {
		return this.boxes.get(element) ?? null;
	}
}

export function adoptTerminalReordering(layout: Layout): void {
	if (layout.terminalReordersText) {
		layout.invalidate();
		return;
	}
	layout.terminalReordersText = true;
	// Every measured line was built for the other contract.
	invalidateTextMeasurement(layout);
}

export function invalidateTextMeasurement(layout: Layout): void {
	layout.invalidate();
	for (const layoutNode of layout.measureNodes) {
		layoutNode.invalidate();
	}
}

// A sticky box's extent holds its descendants', so its rows before and
// after cover everything its shift moved. One an inline-block lays out
// moves only within the box it flows in, inside the inline-block, so the
// inline-block's rows cover it.
function damageShiftedStickyBoxes(layout: Layout): void {
	const before = layout.stickyRows;
	const after = new Map<LayoutNode, StickyRows>();
	for (const element of layout.positionedElements) {
		const node = layout.nodeMap.get(element);
		if (node?.style.positionType !== "sticky") {
			continue;
		}
		const rows = getStickyRows(layout, node);
		if (rows === "unknown") {
			layout.wholeDamage = true;
			layout.collecting = false;
			continue;
		}
		if (rows === null) {
			continue;
		}
		after.set(node, rows);
		const old = before.get(node);
		if (
			old === undefined ||
			old.top !== rows.top ||
			old.bottom !== rows.bottom ||
			old.shift !== rows.shift
		) {
			pushDamage(layout, rows.top, rows.bottom, rows.fixed);
			if (old !== undefined) {
				pushDamage(layout, old.top, old.bottom, old.fixed);
			}
		}
		before.delete(node);
	}
	for (const old of before.values()) {
		pushDamage(layout, old.top, old.bottom, old.fixed);
	}
	layout.stickyRows = after;
}

interface StickyRows {
	top: number;
	bottom: number;
	fixed: boolean;
	shift: number;
}

// The document rows a sticky box paints on, and its shift. Null for one
// that shows nowhere, and "unknown" for one whose rows no extent in the
// document's rows covers.
function getStickyRows(
	layout: Layout,
	node: LayoutNode,
): StickyRows | null | "unknown" {
	let root: LayoutNode = node;
	for (; root.parent !== null; root = root.parent) {
		if (root.style.displayType === "none") {
			return null;
		}
	}
	const shift = getStickyShift(layout, node).y;
	if (root === layout.initialBlock) {
		const extent = paintExtent(node, layout.initialBlock);
		if (extent === undefined) {
			return null;
		}
		const moved = getScrollShift(layout, node, false).y;
		return {
			top: extent.top + moved,
			bottom: extent.bottom + moved,
			fixed: isInFixedSpace(node),
			shift,
		};
	}
	const host = contextHosts.get(root);
	if (host === undefined || !host.isConnected) {
		return null;
	}
	const hostNode =
		getLayoutNode(layout, host) ?? getBox(layout, host)?.layoutNode;
	const extent = hostNode
		? paintExtent(hostNode, layout.initialBlock)
		: undefined;
	if (!hostNode || extent === undefined) {
		return "unknown";
	}
	const moved = getScrollShift(layout, hostNode, false).y;
	return {
		top: extent.top + moved,
		bottom: extent.bottom + moved,
		fixed: isInFixedSpace(hostNode),
		shift,
	};
}

function isInFixedSpace(node: LayoutNode): boolean {
	for (let current: LayoutNode | null = node;
		current;
		current = current.parent) {
		if (current.style.positionType === "fixed") {
			return true;
		}
	}
	return false;
}

export function framePainted(layout: Layout): void {
	layout.geometryMoved = false;
	layout.damage = [];
	layout.wholeDamage = false;
	layout.restyledForPaint.clear();
	layout.selectionMoved = false;
}

// Past this many moved boxes a frame repaints whole, which is cheaper
// than merging them, and bounds what a document never painted keeps.
const MAX_DAMAGE = 64;

function addDamage(
	layout: Layout,
	node: LayoutNode,
	top: number,
	bottom: number,
	fixed: boolean,
): void {
	const shift = getScrollShift(layout, node, false).y;
	pushDamage(layout, top + shift, bottom + shift, fixed);
}

function pushDamage(
	layout: Layout,
	top: number,
	bottom: number,
	fixed: boolean,
): void {
	if (!layout.collecting || bottom <= top) {
		return;
	}
	if (layout.damage.length >= MAX_DAMAGE) {
		layout.wholeDamage = true;
		layout.collecting = false;
		layout.damage = [];
		return;
	}
	layout.damage.push([top, bottom, fixed]);
}

function isSameLines(
	node: LayoutNode,
	a: BreakResult | undefined,
	b: BreakResult | undefined,
): boolean {
	if (a === b) {
		return true;
	}
	if (
		a === undefined ||
		b === undefined ||
		a.lines.length !== b.lines.length ||
		(a.containerWidth !== b.containerWidth && !isStartAligned(node))
	) {
		return false;
	}
	for (let index = 0; index < a.lines.length; index++) {
		const x = a.lines[index];
		const y = b.lines[index];
		if (
			x.y !== y.y ||
			x.width !== y.width ||
			x.height !== y.height ||
			x.segments.length !== y.segments.length
		) {
			return false;
		}
		for (let at = 0; at < x.segments.length; at++) {
			const p = x.segments[at];
			const q = y.segments[at];
			if (
				!isSameLeaf(p.leaf, q.leaf) ||
				p.x !== q.x ||
				p.width !== q.width ||
				p.processedText !== q.processedText ||
				p.dataStart !== q.dataStart ||
				p.dataEnd !== q.dataEnd ||
				p.visualBase !== q.visualBase
			) {
				return false;
			}
		}
	}
	return true;
}

// Leaves are made again whenever a run breaks. An inline-block lays its
// content out apart, so a line holding one never counts as the same.
function isSameLeaf(a: Leaf, b: Leaf): boolean {
	if (a.type !== b.type || a.node !== b.node || a.type === "inline-block") {
		return false;
	}
	if (a.type === "edge") {
		const edge = b as EdgeLeaf;
		return a.side === edge.side &&
			a.margin === edge.margin &&
			a.border === edge.border &&
			a.padding === edge.padding;
	}
	return true;
}

// Whether a box's lines start at its left edge whatever width they broke
// against, so that width alone moves none of them.
function isStartAligned(node: LayoutNode): boolean {
	const owner = node.owner as Node | null;
	const element = owner === null
		? null
		: getNodeType(owner) === owner.ELEMENT_NODE
		? (owner as Element)
		: flatParentElement(owner);
	if (element === null || getTextStyle(element).direction === "rtl") {
		return false;
	}
	const align = CSSValues.getLineAlignment(getTextStyle(element).textAlign);
	return align !== "center" &&
		align !== "right" &&
		align !== "end" &&
		!getTextStyle(element).textIndent.includes("%");
}

// Whether a box draws anything of its own that its size or place decides:
// a fill, a border, an outline, a marker, a clip. One that draws nothing
// changes no cell by moving, and what it holds reports its own moves.
function paintsOwnBox(layout: Layout, node: LayoutNode): boolean {
	const owner = node.owner as Node | null;
	// A run paints its lines from its origin, whatever its size.
	if (owner === null || getRun(layout, node) !== null) {
		return false;
	}
	if (getNodeType(owner) !== owner.ELEMENT_NODE) {
		return false;
	}
	const element = owner as Element;
	const style = node.style;
	if (
		style.clipsOverflow ||
		style.border.top !== 0 ||
		style.border.right !== 0 ||
		style.border.bottom !== 0 ||
		style.border.left !== 0 ||
		(style.displayType !== "block" &&
			style.displayType !== "flex" &&
			style.displayType !== "grid") ||
		isReplacedBox(element) ||
		isMathRoot(element) ||
		layout.getBox(element)?.fragments
	) {
		return true;
	}
	const fill = getComputedValue(element, "background-color");
	return !(fill === "transparent" || fill === "rgba(0, 0, 0, 0)") ||
		getComputedValue(element, "background-image") !== "none" ||
		getComputedValue(element, "outline-style") !== "none" ||
		getComputedValue(element, "box-shadow") !== "none" ||
		getComputedValue(element, "display") === "list-item";
}

/**
 * Checks each frame's layout against a solve from nothing, for tests:
 * every box where a solve that forgot every cache would place it. Run at
 * every frame, not every solve, since a change that wrongly asks for no
 * solve leaves the last one standing. Set, a box placed elsewhere throws,
 * naming the boxes.
 */
export const layoutCheck = {enabled: false, checked: 0};

// Every box of the document's tree and of the formatting contexts boxes
// in it lay out for themselves.
function forEachLayoutNode(
	layout: Layout,
	visit: (node: LayoutNode) => void,
): void {
	const walk = (node: LayoutNode): void => {
		visit(node);
		for (const child of node.children) {
			walk(child);
		}
		const owner = node.owner as Node | null;
		if (owner !== null && getNodeType(owner) === owner.ELEMENT_NODE) {
			const context = layout.boxes.get(owner as Element)
				?.independentFormattingContext;
			if (context) {
				walk(context);
			}
		}
	};
	walk(layout.initialBlock);
}

// The tree is one: every child names the node that holds it, no node is
// held twice, and every node that hangs from another is reachable from
// the root, so no box is laid out where nothing paints it. A box belongs
// to a connected element that generates one.
function checkTreeShape(layout: Layout): string[] {
	const problems: string[] = [];
	const seen = new Set<LayoutNode>();
	const name = (node: LayoutNode): string => {
		const owner = node.owner as Node | null;
		return owner === null
			? "anonymous"
			: getNodeType(owner) === owner.ELEMENT_NODE
			? (owner as Element).localName +
				((owner as Element).id ? `#${(owner as Element).id}` : "")
			: "#text";
	};
	const visit = (node: LayoutNode): void => {
		if (seen.has(node)) {
			problems.push(`${name(node)} held twice`);
		}
		seen.add(node);
		for (const child of node.children) {
			if (child.parent !== node) {
				problems.push(`${name(child)} names another parent`);
			}
			visit(child);
		}
	};
	// The root, and the formatting context of every box that lays its own
	// content out, which a run measures and no parent holds.
	visit(layout.initialBlock);
	const document = layout.rootElement.ownerDocument!;
	for (const each of flatDescendants(document.documentElement!)) {
		if (getNodeType(each) !== each.ELEMENT_NODE) {
			continue;
		}
		const context = layout.boxes.get(each as Element)
			?.independentFormattingContext;
		if (context && !seen.has(context)) {
			visit(context);
		}
	}
	for (const [domNode, node] of layout.nodeMap) {
		if (node.parent !== null && !seen.has(node)) {
			problems.push(`${name(node)} hangs where the root cannot reach`);
		}
		if (node.parent === null && !seen.has(node) && flatIsConnected(domNode)) {
			problems.push(`${name(node)} is held by no box`);
		}
		if (
			seen.has(node) &&
			getNodeType(domNode) === domNode.ELEMENT_NODE &&
			isOutOfFlow(domNode) &&
			getPosition(domNode as Element) !== "fixed"
		) {
			const containingBlock = getContainingBlockLayoutNode(
				layout,
				domNode as Element,
			);
			if (
				containingBlock !== null &&
				!isReachableFrom(node.parent, containingBlock)
			) {
				problems.push(
					`${name(node)} hangs out of its containing block's reach`,
				);
			}
		}
		if (
			seen.has(node) &&
			getNodeType(domNode) === domNode.ELEMENT_NODE &&
			isDisplayContents(domNode as Element)
		) {
			problems.push(`${name(node)} has a box and generates none`);
		}
		if (seen.has(node) && !flatIsConnected(domNode)) {
			problems.push(`${name(node)} has a box and is not in the document`);
		}
	}
	return problems;
}

export function checkLayoutFromScratch(layout: Layout): void {
	layoutCheck.checked++;
	const shape = checkTreeShape(layout);
	if (shape.length > 0) {
		throw new Error(
			`The layout tree is malformed: ${shape.slice(0, 8).join("; ")}`,
		);
	}
	const document = layout.window.document;
	const elements = [...document.querySelectorAll("*")] as Element[];
	const describe = (): string[] => elements.map((element) => {
		const rect = layout.getRect(element);
		return rect === null
			? "none"
			: `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
	});
	const before = describe();
	// The frame's own damage stands: the check repaints nothing.
	const damage = [...layout.damage];
	const wholeDamage = layout.wholeDamage;
	const geometryMoved = layout.geometryMoved;
	// Every box derived again and styled again, then solved with nothing
	// remembered.
	layout.invalidate();
	forEachLayoutNode(layout, forgetLayout);
	layout.performLayout();
	layout.damage = damage;
	layout.wholeDamage = wholeDamage;
	layout.geometryMoved = geometryMoved;
	const after = describe();
	const differences: string[] = [];
	for (let index = 0; index < elements.length; index++) {
		if (before[index] !== after[index]) {
			const element = elements[index];
			differences.push(
				`${element.localName}${element.id ? `#${element.id}` : ""} ${
					before[index]
				}, from nothing ${after[index]}`,
			);
		}
	}
	if (differences.length > 0) {
		throw new Error(
			`A layout differs from one from nothing at ${
				differences.slice(0, 8).join("; ")
			}`,
		);
	}
}

// A box whose own formatting context went stale lays it out again in its
// measure, which is what is invalidated.
function flushStaleHosts(layout: Layout): void {
	for (const host of layout.staleHosts) {
		invalidateHost(layout, host);
	}
	layout.staleHosts.clear();
}

// The box's own node when it has one, a block in a flex or grid
// container, and the run that measures it when it sits on a line.
function invalidateHost(layout: Layout, host: Element): void {
	if (!host.isConnected) {
		return;
	}
	layout.nodeMap.get(host)?.invalidate();
	invalidateEnclosingMeasure(layout, host);
}

function isInFixedBox(node: LayoutNode): boolean {
	for (let at: LayoutNode | null = node; at !== null; at = at.parent) {
		if (at.style.positionType === "fixed") {
			return true;
		}
	}
	return false;
}

// The rows from the first end of the selection to the last, or null
// when an end has no caret position to measure.
function getSelectionRows(layout: Layout): [number, number] | null {
	const selection = layout.window.document.getSelection();
	if (selection === null || selection.rangeCount === 0) {
		return null;
	}
	let top = Infinity;
	let bottom = -Infinity;
	for (let index = 0; index < selection.rangeCount; index++) {
		const range = selection.getRangeAt(index);
		for (const [node, offset] of [
			[range.startContainer, range.startOffset],
			[range.endContainer, range.endOffset],
		] as const) {
			const rect = layout.getCaretRect(node, offset);
			if (rect === null) {
				return null;
			}
			top = Math.min(top, Math.floor(rect.y));
			bottom = Math.max(bottom, Math.ceil(rect.y + Math.max(rect.height, 1)));
		}
	}
	return [top, bottom];
}

/**
 * The buffer rows the next frame must repaint, merged into bands, or
 * undefined when every row must. offset turns document rows into buffer
 * rows, as the frame's viewport offset does.
 */
export function takeDamageBands(
	layout: Layout,
	offset: number,
	paintsAsBefore: (element: Element, key: object) => boolean | "whole",
): Array<[number, number]> | undefined {
	const selectionRows = getSelectionRows(layout);
	const previousSelection = layout.selectionRows;
	layout.selectionRows = selectionRows;
	if (layout.wholeDamage) {
		return undefined;
	}
	const rows: Array<[number, number]> = [];
	const add = (top: number, bottom: number, fixed: boolean): void => {
		rows.push(fixed ? [top, bottom] : [top + offset, bottom + offset]);
	};
	for (const [top, bottom, fixed] of layout.damage) {
		add(top, bottom, fixed);
	}
	for (const [element, key] of layout.restyledForPaint) {
		if (!element.isConnected) {
			continue;
		}
		const same = key === null ? false : paintsAsBefore(element, key);
		if (same === "whole") {
			return undefined;
		}
		if (same) {
			continue;
		}
		let box: Element | null = element;
		while (box !== null && !layout.nodeMap.has(box)) {
			box = flatParentElement(box);
		}
		let node = box === null ? undefined : layout.nodeMap.get(box);
		// A box an inline-block lays out in its own context has rows counted
		// from that context. The inline-block's own rows hold them.
		while (
			box !== null &&
			node !== undefined &&
			getExtentFrame(node) !== layout.initialBlock
		) {
			box = getEnclosingIndependentFormattingContext(
				layout,
				getBoxParentElement(box),
			);
			node = box === null ? undefined : layout.nodeMap.get(box);
		}
		const extent = node === undefined
			? undefined
			: paintExtent(node, layout.initialBlock);
		if (node === undefined || extent === undefined) {
			return undefined;
		}
		const shift = getScrollShift(layout, node, false).y;
		add(extent.top + shift, extent.bottom + shift, isInFixedBox(node));
	}
	if (layout.selectionMoved) {
		if (selectionRows === null || previousSelection === null) {
			return undefined;
		}
		for (const [top, bottom] of [previousSelection, selectionRows]) {
			add(top, bottom, false);
			add(top, bottom, true);
		}
	}
	// A row beside a change can change too: a border there joins the
	// changed one, and an outline reaches past its box.
	rows.sort((a, b) => a[0] - b[0]);
	const bands: Array<[number, number]> = [];
	for (const [top, bottom] of rows) {
		const from = top - 1;
		const to = bottom + 1;
		const last = bands.at(-1);
		if (last !== undefined && from <= last[1]) {
			last[1] = Math.max(last[1], to);
		} else {
			bands.push([from, to]);
		}
	}
	return bands;
}

// Membership gates. A positioned inline run member owns no box of its
// own, and no layer would ever paint it, so it stays with its run.
export function hoistedToLayer(layout: Layout, element: Element): boolean {
	return isLayerMember(element) && layout.positionedElements.has(element);
}

// The children whose paint extent could intersect rows [top, bottom),
// found by binary search. Culling a long list cost O(total children)
// per frame instead of O(visible). Null when the search cannot be
// trusted (children[] not sorted by extent top), in which case callers
// walk every child.
function getVisibleChildren(
	layout: Layout,
	element: Element,
	top: number,
	bottom: number,
): Node[] | null {
	const layoutNode = layout.nodeMap.get(element);
	if (
		!layoutNode ||
		// A measure-function leaf never decomposes into layout children, so
		// empty children[] means "not decomposed," not "nothing to paint."
		layoutNode.measure !== null ||
		paintExtent(layoutNode, layout.initialBlock)?.unstackedChildren !== 0 ||
		layoutNode.style.displayType !== "block" ||
		// Cheap proxy for "every DOM child has exactly one children[]
		// entry". A run member owns no layout node, and a pseudo-element is a
		// box-tree child with no childNodes entry. Uncounted, an element
		// whose one child is text and whose ::before heads the run collides
		// at one and one, and the fast path paints the pseudo alone.
		element.childNodes.length + pseudoElementCount(element) !==
		layoutNode.children.length ||
		// A host's childNodes are its LIGHT children, unrelated to the
		// composed ones the layout tree holds. The counts collide by
		// accident. Hosts always take the walker.
		getShadowRoot(element) !== null ||
		// A broken inline's boxes are children[] entries whose DOM node
		// lives a level DOWN. `<span>a<div/><span>c</span></span>d<input>`
		// collides at three and three, and the fast path dropped the text
		// and the input after the fragments.
		layout.boxes.get(element)?.holdsFragments === true
	) {
		return null;
	}

	const children = layoutNode.children;
	let lo = 0;
	let hi = children.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (getStoredExtent(children[mid])!.bottom <= top) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	const result: Node[] = [];
	for (let i = lo; i < children.length; i++) {
		const child = children[i];
		if (getStoredExtent(child)!.top >= bottom) {
			break;
		}
		const domNode = child.owner as Node | undefined;
		if (domNode) {
			result.push(domNode);
		}
	}
	return result;
}

/** The cells a <math> element paints, laid out if no pass has yet. */
export function getMathBox(layout: Layout, element: Element): MathBox {
	return layout.mathBoxes.get(element) ?? measureMath(layout, element);
}

// Where a <math> element's cells start, in document coordinates: its
// content box, with the cells placed in it by text-align.
function getMathOrigin(
	layout: Layout,
	element: Element,
): {x: number; y: number} | null {
	const rect = layout.getRect(element);
	if (rect === null) {
		return null;
	}
	const box = getMathBox(layout, element);
	const model = getBoxModel(element);
	const contentWidth =
		Math.round(rect.width) -
		model.borderLeftWidth -
		model.borderRightWidth -
		model.paddingLeft -
		model.paddingRight;
	return {
		x:
			Math.round(rect.left) +
			model.borderLeftWidth +
			model.paddingLeft +
			getMathAlignOffset(
				contentWidth - box.width,
				getComputedValue(element, "text-align"),
			),
		y: Math.round(rect.top) + model.borderTopWidth + model.paddingTop,
	};
}

// The rectangles of the cells inside a <math> element that render a
// node's text, in document coordinates.
function getMathNodeRects(
	layout: Layout,
	math: Element,
	node: Node,
): DOMRect[] {
	const origin = getMathOrigin(layout, math);
	if (origin === null) {
		return [];
	}
	return getMathCellRects(getMathBox(layout, math), node).map((rect) =>
		new layout.domRect(
			origin.x + rect.x,
			origin.y + rect.y,
			rect.width,
			rect.height,
		),
	);
}

// Paint extents are cached in unscrolled layout rows, so viewport culling
// of a scrolled subtree compares against the viewport moved by this amount
// rather than recomputing extents per scroll.
export function scrolledAncestorRows(layout: Layout, element: Element): number {
	const layoutNode =
		layout.nodeMap.get(element) ?? runLayoutNode(layout, element);
	return layoutNode ? -getScrollShift(layout, layoutNode, false).y : 0;
}

// The text lets a caller repaint the run in the selection style.
// getRangeRects is this without the text.
function getRangeSpans(
	layout: Layout,
	range: Range,
): Array<{rect: DOMRect; text: string}> {
	if (range.collapsed) {
		return [];
	}
	const runs: Array<{rect: DOMRect; text: string}> = [];
	for (const textNode of rangeTextNodes(layout, range)) {
		const from = range.startContainer === textNode ? range.startOffset : 0;
		const to = range.endContainer === textNode
			? range.endOffset
			: textNode.data.length;
		if (to > from) {
			runs.push(...getSelectionSpans(layout, textNode, from, to));
		}
	}
	return runs;
}

// The offsets the cells above actually cover, since a cell holds a
// whole cluster.
export function snapToClusters(
	layout: Layout,
	textNode: Text,
	from: number,
	to: number,
): {from: number; to: number} {
	let start = from;
	let end = to;
	const whiteSpace = getWhiteSpace(textNode);
	for (const fragment of layout.lineFragments(textNode)) {
		const {text, offsets} = renderWhiteSpaceOffsets(
			textNode.data.slice(fragment.startOffset, fragment.endOffset),
			whiteSpace,
		);
		const clusterStarts = getClusterStarts(text);
		for (let i = 0; i < text.length; i++) {
			const dataOffset = fragment.startOffset + getDataOffset(offsets, i);
			if (dataOffset < from || dataOffset >= to) {
				continue;
			}
			const before = clusterStarts.at(i);
			start = Math.min(
				start,
				fragment.startOffset + getDataOffset(offsets, before),
			);
			const after = clusterStarts.after(i + 1);
			end = Math.max(
				end,
				after < text.length
					? fragment.startOffset + getDataOffset(offsets, after)
					: fragment.endOffset,
			);
		}
	}
	return {from: start, to: end};
}

// Positioned elements under their nearest stacking-context ancestor,
// bucketed into the CSS paint layers: negative-z, z:auto/0, positive-z.
// Walks only the positioned registry, so O(positioned x depth) per
// frame, never O(document). The painter walks these forward and
// hit-testing in reverse.
export function collectStackingLayers(
	layout: Layout,
	topLayer: Set<Element>,
): Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}> {
	const layers = new Map<
		Element,
		{neg: Element[]; zero: Element[]; pos: Element[]}
	>();
	// A stray frame can fire after the window is torn down.
	const body = layout.window.document?.body;
	if (!body) {
		return layers;
	}
	for (const element of layout.positionedElements) {
		if (!element.isConnected || element === body) {
			continue;
		}
		// Painted above everything.
		if (topLayer.has(element)) {
			continue;
		}
		// The registry is a superset. Re-check before trusting membership.
		if (!isLayerMember(element)) {
			continue;
		}
		let root: Element = body;
		for (
			let ancestor = flatParentElement(element);
			ancestor;
			ancestor = flatParentElement(ancestor)
		) {
			if (isStackingContext(ancestor)) {
				root = ancestor;
				break;
			}
		}
		let bucket = layers.get(root);
		if (!bucket) {
			bucket = {neg: [], zero: [], pos: []};
			layers.set(root, bucket);
		}
		const z = isPositioned(element) ? getZIndexValue(element) : "auto";
		if (z === "auto" || z === 0) {
			bucket.zero.push(element);
		} else if (z < 0) {
			bucket.neg.push(element);
		} else {
			bucket.pos.push(element);
		}
	}
	// 4: b follows a.
	const treeOrder = (a: Element, b: Element) =>
		a.compareDocumentPosition(b) & 4 ? -1 : 1;
	for (const bucket of layers.values()) {
		const byZ = (a: Element, b: Element) => {
			const za = getZIndexValue(a) as number;
			const zb = getZIndexValue(b) as number;
			return za !== zb ? za - zb : treeOrder(a, b);
		};
		bucket.neg.sort(byZ);
		bucket.zero.sort(treeOrder);
		bucket.pos.sort(byZ);
	}
	return layers;
}

/**
 * The viewport rows covered by fixed boxes as wide as the viewport, as
 * [top, bottom) pairs: a header or a status bar the document scrolls
 * under.
 */
export function fullWidthFixedRows(
	layout: Layout,
	cols: number,
): Array<[number, number]> {
	const rows: Array<[number, number]> = [];
	for (const element of layout.positionedElements) {
		if (
			!element.isConnected ||
			getPosition(element) !== "fixed" ||
			!layout.isInFixedSpace(element)
		) {
			continue;
		}
		const rect = layout.getRect(element);
		if (
			rect === null ||
			rect.height <= 0 ||
			Math.round(rect.left) > 0 ||
			Math.round(rect.left + rect.width) < cols
		) {
			continue;
		}
		rows.push([Math.round(rect.top), Math.round(rect.top + rect.height)]);
	}
	return rows;
}

/** The layout node an element's principal box was laid out as, if any. */
export function getLayoutNode(
	layout: Layout,
	element: Element,
): LayoutNode | null {
	return layout.nodeMap.get(element) ?? null;
}

/** The rows a node's subtree can paint, in document rows. */
// The extent, when its rows are counted in the frame the caller counts
// in. Rows of another frame mean nothing there, so there is none.
export function paintExtent(
	node: LayoutNode,
	frame: LayoutNode,
): Extent | undefined {
	const extent = getStoredExtent(node);
	return extent?.frame === frame ? extent : undefined;
}

// The root a node's extent counts from, once it has one.
export function getExtentFrame(node: LayoutNode): LayoutNode | undefined {
	return getStoredExtent(node)?.frame;
}

/**
 * The box whose lines a layout node lays out, when it is a run's. Null
 * for a principal box's node.
 */
export function getRun(layout: Layout, node: LayoutNode): Box | null {
	const owner = node.owner as Node | null;
	if (owner === null) {
		return null;
	}
	const box = getBox(layout, owner);
	return box !== null && box.layoutNode === node ? box : null;
}

// "auto" stays distinct from 0. It paints in the same layer but does
// NOT form a context.
function getZIndexValue(element: Element): number | "auto" {
	const zIndex = getComputedValue(element, "z-index");
	if (!zIndex || zIndex === "auto") {
		return "auto";
	}
	return CSSValues.parseCSSInteger(zIndex) ?? "auto";
}

// Positioned with a non-auto z-index, or isolated. opacity/transform/filter
// have no terminal meaning. The root context belongs to <body>, the paint
// root.
export function isStackingContext(element: Element): boolean {
	if (element === element.ownerDocument.body) {
		return true;
	}
	if (isIsolated(element)) {
		return true;
	}
	return isPositioned(element) && getZIndexValue(element) !== "auto";
}

function isIsolated(element: Element): boolean {
	return getComputedValue(element, "isolation") === "isolate";
}

// What paints in its stacking context's layers rather than in flow: a
// positioned box, and an isolated one, which paints as a positioned box
// with z-index 0 would (CSS 2 Appendix E), so its own layers paint with
// it. Its z-index applies only if it is positioned.
function isLayerMember(element: Element): boolean {
	return isPositioned(element) ||
		(element !== element.ownerDocument.body && isIsolated(element));
}

// The one place that legitimately holds the computed and used display
// at once, because it checks whether they disagree.
function isBlockifiedByLayout(element: Element): boolean {
	return isInlineDisplay(getLayoutDisplay(element)) && isBlockified(element);
}

function unionRects(layout: Layout, rects: readonly DOMRect[]): DOMRect {
	if (rects.length === 0) {
		return new layout.domRect();
	}
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
	return new layout.domRect(left, top, right - left, bottom - top);
}

function pruneDisconnectedNodes(layout: Layout): void {
	// Nothing can have left the document while no node left its parent.
	const unlinks = getUnlinkCount();
	if (unlinks === layout.prunedAtUnlinks) {
		return;
	}
	layout.prunedAtUnlinks = unlinks;
	// A box outlives the nodes that pass through it, but not its
	// container.
	for (const box of [...layout.anonymousBoxes.values()]) {
		if (!flatIsConnected(box.container)) {
			dropAnonymousBox(layout, box);
		}
	}
	for (const [node, layoutNode] of layout.nodeMap) {
		if (node === layout.rootElement || flatIsConnected(node)) {
			continue;
		}

		const parent = layoutNode.parent;
		if (parent) {
			parent.removeChild(layoutNode);
		}

		layout.measureNodes.delete(layoutNode);
		forgetReads(layoutNode);
		untrackNode(layout, node);
		layout.invalidatedNodes.delete(node);
	}
}

// Nothing here builds a box. A restyle says only that the boxes around
// an element may no longer match the enumeration, and what the element
// now generates is derived where every box is derived.
// Measures are dropped after every restyle has dropped its enumerations,
// as handleMutations does with records.
// The style values each box's measure last read, as element, read and
// value in turn, and the boxes that read each element. A measure's result
// is a function of what it read, so it stands until one of those reads
// differently.
const measureReads = new WeakMap<LayoutNode, Array<Element | string>>();
// Most elements are read by one box, kept alone until a second reads it.
const measureReaders = new WeakMap<Element, LayoutNode | Set<LayoutNode>>();

function addMeasureReader(element: Element, node: LayoutNode): void {
	const readers = measureReaders.get(element);
	if (readers === undefined) {
		measureReaders.set(element, node);
	} else if (readers instanceof Set) {
		readers.add(node);
	} else if (readers !== node) {
		measureReaders.set(element, new Set([readers, node]));
	}
}

function removeMeasureReader(element: Element, node: LayoutNode): void {
	const readers = measureReaders.get(element);
	if (readers === node) {
		measureReaders.delete(element);
	} else if (readers instanceof Set) {
		readers.delete(node);
	}
}

// The readers are registered once the measure has returned, and only
// while the layout still measures the box: a measure can drop its own box
// on the way, and a reader dropped would be held by every element it read.
function recordReads(
	layout: Layout,
	node: LayoutNode,
	measure: Measure,
): Measure {
	return (width, widthSpace, placing, left) => {
		const contextLayoutsBefore = contextLayouts;
		const reads: Array<Element | string> = [];
		// Reads come in runs on one element, and a run reads few
		// properties, so a read is looked for only in its own run.
		let runStart = 0;
		const size = recordStyleReads((element, read, value) => {
			if (reads[runStart] !== element) {
				runStart = reads.length;
			}
			for (let i = runStart; i < reads.length; i += 3) {
				if (reads[i + 1] === read) {
					reads[i + 2] = value;
					return;
				}
			}
			reads.push(element, read, value);
		}, () => measure(width, widthSpace, placing, left));
		if (!placing && contextLayouts !== contextLayoutsBefore) {
			node.hasCachedLayout = false;
		}
		forgetReads(node);
		if (layout.measureNodes.has(node)) {
			for (let i = 0; i < reads.length; i += 3) {
				if (reads[i] !== reads[i - 3]) {
					addMeasureReader(reads[i] as Element, node);
				}
			}
			measureReads.set(node, fitToLength(reads));
		}
		return size;
	};
}

// A box that leaves takes its reads with it, so no element it read keeps
// it.
function forgetReads(node: LayoutNode): void {
	const reads = measureReads.get(node);
	if (reads !== undefined) {
		for (let i = 0; i < reads.length; i += 3) {
			if (reads[i] !== reads[i - 3]) {
				removeMeasureReader(reads[i] as Element, node);
			}
		}
		measureReads.delete(node);
	}
}

// Every measure that read the element and would read it differently now
// measures again.
function invalidateMeasureReaders(element: Element): void {
	const readers = measureReaders.get(element);
	if (readers === undefined) {
		return;
	}
	for (const node of readers instanceof Set ? readers : [readers]) {
		const reads = measureReads.get(node);
		if (reads === undefined || !reads.includes(element)) {
			removeMeasureReader(element, node);
			continue;
		}
		for (let i = 0; i < reads.length; i += 3) {
			if (
				reads[i] === element &&
				readStyleAgain(element, reads[i + 1] as string) !== reads[i + 2]
			) {
				node.invalidate();
				break;
			}
		}
	}
}

function applyRestyles(layout: Layout): void {
	// What a measure read is checked first, whatever the restyle changed,
	// a property the cascade calls paint-only included.
	for (const element of layout.restyledSinceLayout) {
		if (flatIsConnected(element)) {
			invalidateMeasureReaders(element);
		}
	}
	layout.restyledSinceLayout.clear();
	const measured = new Set<Element>();
	while (layout.restyled.size > 0) {
		const restyled = [...layout.restyled];
		layout.restyled.clear();
		for (const element of restyled) {
			if (!flatIsConnected(element)) {
				continue;
			}
			const layoutNode = layout.nodeMap.get(element);
			if (
				layoutNode !== undefined &&
				layoutNode.style.containsPositioned !==
					establishesFixedContainingBlock(element)
			) {
				invalidateOutOfFlowDescendants(layout, element);
			}
			// A pseudo-element's style is the host's to change, and its box is
			// the host's child, so a host with any takes the full path.
			const probe =
				layoutNode !== undefined &&
				pseudoElementCount(element) === 0
					? probeLayoutStyle(element)
					: null;
			// A box that starts or stops being positioned starts or stops
			// containing its absolute descendants.
			if (
				probe !== null &&
				probe.style.positionType !== layoutNode!.style.positionType
			) {
				invalidateOutOfFlowDescendants(layout, element);
			}
			if (probe !== null) {
				// A restyle that left every property layout reads as it was (a
				// color, a decoration) changes no box and no measurement, and
				// rebuilding would restyle every descendant for nothing. A
				// child whose own style changed is in this set itself.
				const styling = stylings.get(layoutNode!);
				const measureKey = styling?.measureKey;
				const sameDisplay = getLayoutDisplay(element) === styling?.display;
				if (
					probe.measureKey === measureKey &&
					sameDisplay &&
					isSameValue(probe.style, layoutNode!.style)
				) {
					continue;
				}
				// The same kind of box as before takes its parent's box list as
				// it stands: the node reads its new style, and only a display
				// or measurement change re-derives its own children.
				// A display the style record cannot tell apart, block for
				// inline-block, still changes the box the parent derives.
				if (
					sameDisplay &&
					isBoxKindMatch(layout, element, layoutNode!) &&
					!isDisplayContents(element) &&
					probe.style.positionType === layoutNode!.style.positionType
				) {
					const displayChanged =
						probe.style.displayType !== layoutNode!.style.displayType;
					const measureChanged = probe.measureKey !== measureKey;
					styleNode(layout, element, layoutNode!);
					if (displayChanged || measureChanged) {
						touchChildren(layout, element);
						invalidateChildDerivation(layout, element);
						if (layout.boxes.get(element)?.children) {
							invalidateContainerBoxes(layout, element);
							layout.dirtyRunContainers.add(element);
						}
					}
					continue;
				}
			}
			invalidateBoxDerivation(layout, element);
			measured.add(element);
			touchChildren(layout, element);
			invalidateChildDerivation(layout, element);
			// Whether it lays its content out under a root of its own follows
			// its display, and a node kept through the change keeps no root it
			// no longer has.
			syncIndependentFormattingContext(layout, element);
			if (layout.boxes.get(element)?.children) {
				invalidateContainerBoxes(layout, element);
				// An element that becomes a flex container, or stops being one,
				// holds a different set of boxes than it did.
				layout.dirtyRunContainers.add(element);
			}
		}
	}
	for (const element of measured) {
		invalidateEnclosingMeasure(layout, element);
	}
}

// The box an out-of-flow descendant hangs from, and for a fixed one its
// position type, depend on every ancestor between, so an element that
// starts or stops containing them sends each back to be placed again.
function invalidateOutOfFlowDescendants(
	layout: Layout,
	element: Element,
): void {
	for (const child of flatChildren(element)) {
		if (getNodeType(child) !== child.ELEMENT_NODE) {
			continue;
		}
		if (isOutOfFlow(child)) {
			layout.restyled.add(child as Element);
			invalidateNode(layout, child);
		}
		invalidateOutOfFlowDescendants(layout, child as Element);
	}
}

// The element's layout style recomputed from the cascade, to compare
// with what the element's node holds.
function probeLayoutStyle(element: Element): {
	style: Style;
	measureKey: TextStyle;
} {
	const style = createStyle();
	styleLayoutNodeProperties(element, style, new Set());
	return {style, measureKey: getTextStyle(element)};
}

function isSameValue(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (
		typeof a !== "object" || typeof b !== "object" || a === null || b === null
	) {
		return Number.isNaN(a as number) && Number.isNaN(b as number);
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return false;
	}
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) {
		return false;
	}
	for (const key of keysA) {
		if (
			!isSameValue(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
			)
		) {
			return false;
		}
	}
	return true;
}

// Nothing here builds a box. A mutation says only which containers no
// longer hold the boxes their enumeration names, and which nodes' measures
// to drop once every record has said so.
function invalidateForRecord(
	layout: Layout,
	record: MutationRecord,
	measured: Set<Node>,
): void {
	// A record on a shadow root describes the HOST's flat-tree children.
	const target =
		getNodeType(record.target) ===
		record.target.DOCUMENT_FRAGMENT_NODE
			? (record.target as ShadowRoot).host
			: record.target;
	if (record.type === "attributes") {
		// Which rules now match is the cascade's to announce, through
		// styleInvalidated, and it does so for every attribute change. Only
		// an attribute layout reads for itself dirties anything here.
		if (record.attributeName === "rows" || record.attributeName === "cols") {
			invalidateBoxDerivation(layout, target);
			invalidateChildDerivation(layout, target as Element);
		}
		if (record.attributeName === "slot") {
			// Moves the node in the COMPOSED tree while the light tree is
			// unchanged. No childList record arrives, and the container it left
			// is unreachable from where it now is. Rare enough for the blunt
			// approach.
			const host = (target as Element).parentElement;
			if (host && getShadowRoot(host)) {
				invalidateSubtreeDerivation(layout, host);
			}
		}
		return;
	}
	if (record.type === "characterData") {
		invalidateBoxDerivation(layout, target);
		measured.add(target);
		return;
	}
	measured.add(target);
	// A tree that has left the document holds no boxes. Inserted again, it
	// is derived whole from the record that brings it back.
	if (!isConnectedNode(target)) {
		return;
	}
	// The removed nodes are already detached, so the container is reached
	// through the target rather than through them.
	if (getNodeType(target) === target.ELEMENT_NODE) {
		invalidateChildDerivation(layout, target as Element);
	}
	// A member gaining or losing a descendant changes no box list (the
	// member is still there, holding more or less), so the box measuring it
	// is notified directly, above.
	for (const node of getAddedNodes(record)) {
		invalidateSubtreeDerivation(layout, node);
	}
}

function *getTextNodes(root: Node): Generator<Text> {
	if (getNodeType(root) === root.TEXT_NODE) {
		yield root as Text;
		return;
	}
	for (const child of Array.from(root.childNodes)) {
		yield *getTextNodes(child);
	}
}

// Where a run head's lines count from. An atomic inline heading a run
// styled from it, as a flex or grid item's is, has the run's layout node,
// which the container's layout placed at the head's own margin edge,
// while the segments count from its margin box: its own segment sits one
// margin in. Every other head's node is where its lines start. A head
// whose own box holds the lines, as a flex item's of only text does,
// scrolls them by its own offsets.
function getRunOrigin(
	layout: Layout,
	runHead: Node,
	headLayoutNode: LayoutNode,
): {x: number; y: number} {
	const position = getDocumentPosition(layout, runHead, headLayoutNode);
	if (getNodeType(runHead) !== runHead.ELEMENT_NODE) {
		return position;
	}
	const head = runHead as Element;
	const anonymous = layout.anonymousBoxes.get(headLayoutNode);
	if (anonymous !== undefined && anonymous.styledFrom !== head) {
		return position;
	}
	if (isAtomicInline(getLayoutDisplay(head))) {
		if (anonymous !== undefined) {
			position.x -= getBoxModel(head).marginLeft;
		}
		return position;
	}
	// html and body report the document scroll, which is applied elsewhere.
	const document = head.ownerDocument;
	if (head === document.documentElement || head === document.body) {
		return position;
	}
	position.x -= getScrollOffset(head, "left");
	position.y -= getScrollOffset(head, "top");
	return position;
}

// Three depths, only the first direct. The box heads its own run (ask
// the flex tree); it is a MEMBER of a run headed elsewhere, whose
// segment.x is run-relative and must be anchored at the head's
// position; or it sits inside ANOTHER inline-block, with its coordinates
// only in a break result nested under that box's leaf. Without
// descending there, `<div style="display:inline-block"><input></div>`
// paints nothing.
function getInlineBlockRect(layout: Layout, element: Element): DOMRect | null {
	// Climb to the nearest run actually laid out on its own. One measured
	// inside an inline-block publishes no break result, and its head may
	// still hold a stale layout node parked at 0,0. The climb goes OUTWARD. A
	// box's position is read from the run that PLACED it, never a run
	// inside it, which would return the coordinates of the very frame being
	// resolved. A stale enumeration can name a head that has since moved in
	// here, walking in a circle.
	const outward = (node: Node): boolean => {
		for (
			let current: Node | null = node;
			current;
			current = getBoxParentElement(current)
		) {
			if (current === element) {
				return false;
			}
		}
		return true;
	};
	const headOutside = (node: Node): Node | null => {
		const head = getBoxEntry(layout, node)?.head ?? null;
		return head && outward(head) ? head : null;
	};
	let runHead: Node | null = headOutside(element) ?? element;
	let headLayoutNode = runLayoutNode(layout, runHead);
	let breakResult = runBreakResult(layout, runHead);
	while (runHead && !(headLayoutNode && breakResult)) {
		const parent = getBoxParentElement(runHead);
		if (!parent) {
			return null;
		}
		runHead = headOutside(parent) ?? parent;
		headLayoutNode = runLayoutNode(layout, runHead);
		breakResult = runBreakResult(layout, runHead);
	}
	if (!runHead || !headLayoutNode || !breakResult) {
		return null;
	}

	const runPosition = getRunOrigin(layout, runHead, headLayoutNode);
	let originX = runPosition.x;
	let originY = runPosition.y;

	// Outermost first. Each hop's offsets are expressed in the frame the
	// previous hop established. The run head itself is in the chain when it
	// is an inline-block.
	const enclosing: Element[] = [];
	for (
		let ancestor = flatParentElement(element);
		ancestor;
		ancestor = flatParentElement(ancestor)
	) {
		enclosing.unshift(ancestor);
		if (ancestor === runHead) {
			break;
		}
	}
	let descended = false;
	let alignContainer: Element | null = flatParentElement(runHead);
	for (const ancestor of enclosing) {
		if (!establishesIndependentFormattingContext(ancestor)) {
			continue;
		}
		const hop = findInlineBlockSegment(breakResult, ancestor);
		if (!hop) {
			continue;
		}
		// Border and padding both occupy cells. A run headed in its own box
		// starts at its head's origin.
		originX +=
			(ancestor === runHead &&
					getNodeType(runHead) === runHead.ELEMENT_NODE &&
					!layout.anonymousBoxes.get(headLayoutNode)
				? 0
				: getLineStart(alignContainer, breakResult, hop.line) + hop.segment.x) +
			hop.segment.leaf.boxModel.paddingLeft +
			hop.segment.leaf.boxModel.borderLeftWidth;
		originY +=
			hop.line.y +
			hop.segment.dy +
			hop.segment.leaf.boxModel.paddingTop +
			hop.segment.leaf.boxModel.borderTopWidth;
		if (hop.segment.leaf.breakResult) {
			breakResult = hop.segment.leaf.breakResult;
			alignContainer = ancestor;
			descended = true;
		}
	}

	const target = findInlineBlockSegment(breakResult, element);
	if (!target) {
		return null;
	}

	// Once the walk descends into a nested measurement, any layout node the
	// box still holds belongs to a layout it is no longer part of. The run
	// a box heads in a block is not its box.
	const ownLayoutNode = descended ? undefined : runLayoutNode(layout, element);
	const anonymous = ownLayoutNode && layout.anonymousBoxes.get(ownLayoutNode);
	const height = target.segment.height;
	if (ownLayoutNode && (!anonymous || anonymous.styledFrom === element)) {
		const {x, y} = getDocumentPosition(layout, element, ownLayoutNode);
		return new layout.domRect(x, y, target.segment.width, height);
	}
	return new layout.domRect(
		originX +
		getLineStart(alignContainer, breakResult, target.line) +
			target.segment.x,
		originY + target.line.y + target.segment.dy,
		target.segment.width,
		height,
	);
}

function rangeTextNodes(layout: Layout, range: Range): Text[] {
	const root = range.commonAncestorContainer;
	if (getNodeType(root) === root.TEXT_NODE) {
		return [root as Text];
	}
	const nodes: Text[] = [];
	const walker = layout.window.document.createTreeWalker(
		root,
		layout.window.NodeFilter.SHOW_TEXT,
	);
	let node: Node | null;
	while ((node = walker.nextNode())) {
		if (range.intersectsNode(node)) {
			nodes.push(node as Text);
		}
	}
	return nodes;
}

// A point in an element names the seam between two children. The
// caret shows at the end of the text the seam follows, else at the start
// of the text it precedes.
function textPointAt(node: Node, offset: number): [Text, number] | null {
	const children = node.childNodes;
	const before = offset > 0 ? lastTextIn(children[offset - 1]) : null;
	if (before !== null) {
		return [before, before.data.length];
	}
	const after = offset < children.length ? firstTextIn(children[offset]) : null;
	return after === null ? null : [after, 0];
}

function isLineBreak(node: Node): boolean {
	return getNodeType(node) === node.ELEMENT_NODE &&
		getHTMLLocalName(node as Element) === "br";
}

function firstTextIn(node: Node): Text | null {
	if (getNodeType(node) === node.TEXT_NODE) {
		return node as Text;
	}
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		const text = firstTextIn(child);
		if (text !== null) {
			return text;
		}
	}
	return null;
}

function lastTextIn(node: Node): Text | null {
	if (getNodeType(node) === node.TEXT_NODE) {
		return node as Text;
	}
	for (let child = node.lastChild;
		child !== null;
		child = child.previousSibling) {
		const text = lastTextIn(child);
		if (text !== null) {
			return text;
		}
	}
	return null;
}

// The caret between two siblings, either of which may be missing or show
// nothing, as an empty text node or collapsed white space does. A block
// box ends the search on its side.
function getCaretRectBetween(
	layout: Layout,
	before: Node | null,
	after: Node | null,
): DOMRect | null {
	for (let node = before; node !== null; node = node.previousSibling) {
		if (getNodeType(node) === node.TEXT_NODE) {
			const text = node as Text;
			const rect = getCaretRectInFragment(layout, text, text.data.length);
			if (rect !== null) {
				return rect;
			}
			continue;
		}
		if (isLineBreak(node) || !isInlineLevel(node)) {
			break;
		}
		const rect = layout.getRects(node).at(-1);
		if (rect !== undefined) {
			const x =
				Math.round(rect.right) + getBoxModel(node as Element).marginRight;
			return new layout.domRect(x, Math.round(rect.y), 0, rect.height);
		}
	}
	for (let node = after; node !== null; node = node.nextSibling) {
		if (getNodeType(node) === node.TEXT_NODE) {
			const rect = getCaretRectInFragment(layout, node as Text, 0);
			if (rect !== null) {
				return rect;
			}
			continue;
		}
		if (isLineBreak(node) || !isInlineLevel(node)) {
			break;
		}
		const rect = layout.getRects(node)[0];
		if (rect !== undefined) {
			const x = Math.round(rect.left) - getBoxModel(node as Element).marginLeft;
			return new layout.domRect(x, Math.round(rect.y), 0, rect.height);
		}
	}
	return null;
}

function getCaretRectInFragment(
	layout: Layout,
	textNode: Text,
	offset: number,
): DOMRect | null {
	const lines = layout.lineFragments(textNode);
	if (lines.length === 0) {
		return null;
	}
	// A caret exactly on a soft-wrap boundary belongs to the next line's
	// start.
	let lineIndex = lines.length - 1;
	for (let i = 0; i < lines.length; i++) {
		if (offset <= lines[i].endOffset) {
			const next = lines[i + 1];
			if (next && next.startOffset <= offset) {
				continue;
			}
			lineIndex = i;
			break;
		}
	}
	const line = lines[lineIndex];
	// The data up to the offset, rendered the way the line renders it.
	const before = renderTextFragment(
		textNode.data,
		getWhiteSpace(textNode),
		line.startOffset,
		Math.max(line.startOffset, Math.min(offset, line.endOffset)),
		null,
		{tabSize: getTextTabSize(textNode), column: line.column},
	);
	const x = Math.round(line.rect.x) + getStringWidth(before);
	return new layout.domRect(x, Math.round(line.rect.y), 0, line.rect.height);
}

// The distance is zero when the point landed on the line, which is what
// picks between two lines painted on the same row.
function getOffsetInFragment(
	textNode: Text,
	whiteSpace: string,
	fragment: LineFragment,
	x: number,
): {offset: number; distance: number} {
	let {text, offsets} = renderWhiteSpaceOffsets(
		textNode.data.slice(fragment.startOffset, fragment.endOffset),
		whiteSpace,
	);
	if (text.includes("\t") && isSpacePreserving(whiteSpace)) {
		({text, offsets} = expandTabRun(
			text,
			offsets,
			getTextTabSize(textNode),
			fragment.column,
		));
	}
	let cellX = fragment.rect.x;
	let index = 0;
	for (const {segment} of graphemeSegmenter.segment(text)) {
		if (cellX >= x) {
			break;
		}
		const width = getStringWidth(segment);
		if (cellX + width > x) {
			break;
		}
		cellX += width;
		index += segment.length;
	}
	const distance = x < fragment.rect.x
		? fragment.rect.x - x
		: x >= cellX && index === text.length ? x - cellX : 0;
	return {
		offset: index < text.length
			? fragment.startOffset + getDataOffset(offsets, index)
			: fragment.endOffset,
		distance,
	};
}

// The cluster boundaries of a string: where the cluster holding an
// index starts, and where the first cluster at or after an index starts.
function getClusterStarts(text: string): {
	at(index: number): number;
	after(index: number): number;
} {
	const starts: number[] = [];
	for (const {index} of graphemeSegmenter.segment(text)) {
		starts.push(index);
	}
	return {
		at(index) {
			let start = 0;
			for (const candidate of starts) {
				if (candidate > index) {
					break;
				}
				start = candidate;
			}
			return start;
		},
		after(index) {
			for (const candidate of starts) {
				if (candidate >= index) {
					return candidate;
				}
			}
			return text.length;
		},
	};
}

// The text is included because the only way to restyle a cell is to
// redraw its glyph.
function getSelectionSpans(
	layout: Layout,
	textNode: Text,
	from: number,
	to: number,
): Array<{rect: DOMRect; text: string}> {
	const runs: Array<{rect: DOMRect; text: string}> = [];
	const whiteSpace = getWhiteSpace(textNode);
	for (const fragment of layout.lineFragments(textNode)) {
		// A collapsing run makes column and offset diverge.
		const {text, offsets} = renderWhiteSpaceOffsets(
			textNode.data.slice(fragment.startOffset, fragment.endOffset),
			whiteSpace,
		);
		// A cell holds a whole cluster, so a run that starts or ends inside
		// one takes the cluster whole. Measured off a cluster boundary, a run
		// landed inside the span of the glyph before it.
		const clusterStarts = getClusterStarts(text);
		let runStart = -1;
		for (let i = 0; i <= text.length; i++) {
			const dataOffset = i < text.length
				? fragment.startOffset + getDataOffset(offsets, i)
				: -1;
			const selected = dataOffset >= from && dataOffset < to;
			if (selected && runStart === -1) {
				runStart = clusterStarts.at(i);
			} else if (!selected && runStart !== -1) {
				i = clusterStarts.after(i);
				const x =
					Math.round(fragment.rect.x) + getStringWidth(text.slice(0, runStart));
				const width = getStringWidth(text.slice(runStart, i));
				runs.push({
					rect: new layout.domRect(
						x,
						Math.round(fragment.rect.y),
						width,
						fragment.rect.height,
					),
					// Painted order. A selected run of a bidirectional line
					// reverses just as the line it sits on did.
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

// Edges, not origin and size. An unclipped axis is +-Infinity, and an
// edge computed from an infinite origin and size is NaN.
export type ClipRect = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};

function isClippingOverflow(value: string): boolean {
	return (
		value === "hidden" ||
		value === "clip" ||
		value === "auto" ||
		value === "scroll"
	);
}

// The clip is the padding box, so scrolled-out content does not paint
// over the border glyphs. Its edges round as the box's own border and
// fill do, so a child flush with the box keeps its first column. An axis
// that stays visible is unbounded, per axis.
export function getOverflowClipRect(
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

	const border = getCellBorderWidths(element);
	const x = Math.round(rect.left);
	const y = Math.round(rect.top);
	const left = clipsX ? x + border.left : -Infinity;
	const right = clipsX ? x + Math.round(rect.width) - border.right : Infinity;
	const top = clipsY ? y + border.top : -Infinity;
	const bottom = clipsY
		? y + Math.round(rect.height) - border.bottom
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

// css-masking-1 §6.1: `clip` cuts an absolutely positioned box to a
// rectangle measured from its border box's top left corner, `auto`
// standing for that edge of the box. A rectangle that encloses nothing,
// as the visually hidden pattern's rect(1px, 1px, 1px, 1px) does, paints
// nothing and takes no clicks.
function getClipPropertyRect(
	layout: Layout,
	element: Element,
): ClipRect | null {
	const value = getComputedValue(element, "clip");
	if (!value.startsWith("rect(") || !value.endsWith(")")) {
		return null;
	}
	const position = getComputedValue(element, "position");
	if (position !== "absolute" && position !== "fixed") {
		return null;
	}
	const rect = layout.getRect(element);
	const parts = value.slice(5, -1).trim().split(/\s*,\s*|\s+/);
	if (rect === null || parts.length !== 4) {
		return null;
	}
	const edge = (part: string, vertical: boolean, auto: number): number => {
		const match = /^(-?\d*\.?\d+)([a-z]*)$/i.exec(part);
		if (part === "auto" || match === null) {
			return auto;
		}
		const px = resolveLength(
			element,
			parseFloat(match[1]),
			match[2] || "px",
			vertical,
		);
		const cells = px === null ? null : toCellLength(px, vertical, element);
		return typeof cells === "number" ? cells : auto;
	};
	return {
		top: rect.top + edge(parts[0], true, 0),
		right: rect.left + edge(parts[1], false, rect.width),
		bottom: rect.top + edge(parts[2], true, rect.height),
		left: rect.left + edge(parts[3], false, 0),
	};
}

// The context root's clip intersected with the overflow of the ancestors
// in the box's containing block chain (css-overflow-3 §3). A relative or
// sticky box is contained by its parent, so every scroller around it
// clips it. An absolute box skips to its nearest positioned or containing
// ancestor, and a fixed box to its nearest containing ancestor or the
// viewport.
export function getPositionedClip(
	layout: Layout,
	element: Element,
	contextRoot: Element,
	contextClip: ClipRect | null,
): ClipRect | null {
	let clip = contextClip;
	const own = getClipPropertyRect(layout, element);
	if (own !== null) {
		clip = clip === null
			? own
			: {
				left: Math.max(clip.left, own.left),
				top: Math.max(clip.top, own.top),
				right: Math.min(clip.right, own.right),
				bottom: Math.min(clip.bottom, own.bottom),
			};
	}
	let position = getComputedValue(element, "position");
	for (
		let ancestor = flatParentElement(element);
		ancestor && ancestor !== contextRoot;
		ancestor = flatParentElement(ancestor)
	) {
		if (
			(position === "fixed" ||
				(position === "absolute" && !isPositioned(ancestor))) &&
			!establishesFixedContainingBlock(ancestor)
		) {
			continue;
		}
		position = getComputedValue(ancestor, "position");
		const overflowX = getUsedOverflow(ancestor, "x");
		const overflowY = getUsedOverflow(ancestor, "y");
		if (isClippingOverflow(overflowX) || isClippingOverflow(overflowY)) {
			const rect = layout.getRect(ancestor);
			if (rect) {
				clip = getOverflowClipRect(ancestor, rect, overflowX, overflowY, clip);
			}
		}
	}
	return clip;
}

function hitTestContext(
	layout: Layout,
	root: Element,
	x: number,
	y: number,
	layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
	documentScrollTop: number,
	contextClip: ClipRect | null = null,
): Element | null {
	const bucket = layers.get(root) ?? null;
	const probeMember = (element: Element): Element | null => {
		// A fixed box's layout lives in viewport space, and fixed-space is a
		// property of the chain. An absolute box inside a fixed bar lives there
		// too.
		const probeY = layout.isInFixedSpace(element) ? y - documentScrollTop : y;
		// Clipped as the painter clips it, so a box cut out of view takes
		// no clicks.
		const clip = getPositionedClip(layout, element, root, contextClip);
		if (
			clip &&
			!(x >= clip.left &&
				x < clip.right &&
				probeY >= clip.top &&
				probeY < clip.bottom)
		) {
			return null;
		}
		return isStackingContext(element)
			? hitTestContext(
				layout,
				element,
				x,
				probeY,
				layers,
				documentScrollTop,
				clip,
			)
			: hitTestInFlow(layout, element, x, probeY);
	};
	if (bucket) {
		for (let i = bucket.pos.length - 1; i >= 0; i--) {
			const hit = probeMember(bucket.pos[i]);
			if (hit) {
				return hit;
			}
		}
		for (let i = bucket.zero.length - 1; i >= 0; i--) {
			const hit = probeMember(bucket.zero[i]);
			if (hit) {
				return hit;
			}
		}
	}
	const inFlow = hitTestInFlow(layout, root, x, y);
	if (inFlow) {
		return inFlow;
	}
	if (bucket) {
		for (let i = bucket.neg.length - 1; i >= 0; i--) {
			const hit = probeMember(bucket.neg[i]);
			if (hit) {
				return hit;
			}
		}
	}
	return null;
}

// Nothing outside layout may reason about processed text. Geometry
// consumers read getRects, getRangeRects or lineFragments, whose
// fragments carry data offsets a consumer can render for itself.
function getRectTexts(layout: Layout, node: Node): RectText[] {
	if (getNodeType(node) === node.ELEMENT_NODE) {
		const element = node as Element;
		const display = getLayoutDisplay(element);

		if (!isInlineDisplay(display)) {
			return [];
		}

		// A broken inline is a member of no run. Its fragments each know the
		// run they sit on, and the block between them belongs to the container
		// (CSS2 §9.2.1.1).
		if (isSplitAroundBlock(element)) {
			const fragments: RectText[] = [];
			const walk = (parent: Element): void => {
				for (const child of Array.from(parent.childNodes) as Node[]) {
					if (getNodeType(child) === child.TEXT_NODE) {
						fragments.push(...getRectTexts(layout, child));
					} else if (
						getNodeType(child) === child.ELEMENT_NODE &&
						// USED display. An out-of-flow child's box is no part
						// of the fragments this inline was broken into.
						isInlineDisplay(getUsedDisplay(child as Element))
					) {
						walk(child as Element);
					}
				}
			};
			walk(element);
			return fragments;
		}

		// An inline-block asked for directly. The text to report is in the
		// break result nested under its own segment's leaf.
		if (
			isAtomicInline(display) && getBoxEntry(layout, element)?.head === element
		) {
			const breakResult = runBreakResult(layout, element);
			if (breakResult) {
				const rectTexts: RectText[] = [];
				const layoutNode = runLayoutNode(layout, element);
				if (!layoutNode) {
					return [];
				}

				const position = getRunOrigin(layout, element, layoutNode);
				const containerX = position.x;
				const containerY = position.y;

				for (const line of breakResult.lines) {
					for (const segment of line.segments) {
						if (
							segment.leaf.type === "inline-block" &&
							segment.leaf.node === element &&
							segment.leaf.breakResult
						) {
							// The border occupies real cells, so content starts
							// after border AND padding.
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
											column: nestedSegment.x,
											startOffset: nestedSegment.dataStart,
											endOffset: nestedSegment.dataEnd,
											visualBase: nestedSegment.visualBase,
											rect: new layout.domRect(
												containerX + segment.x + paddingLeft + nestedSegment.x,
												containerY +
													line.y +
													segment.dy +
													paddingTop +
													nestedLine.y +
													nestedLine.textTop,
												nestedSegment.width,
												nestedLine.height - nestedLine.textTop,
											),
										});
									} else if (
										nestedSegment.leaf.type === "inline-block" &&
										nestedSegment.leaf.breakResult
									) {
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
														column: innerSegment.x,
														startOffset: innerSegment.dataStart,
														endOffset: innerSegment.dataEnd,
														visualBase: innerSegment.visualBase,
														rect: new layout.domRect(
															containerX +
															segment.x +
															paddingLeft +
															nestedSegment.x +
															nestedPaddingLeft +
															innerSegment.x,
															containerY +
															line.y +
															segment.dy +
															paddingTop +
															nestedLine.y +
															nestedSegment.dy +
															nestedPaddingTop +
															innerLine.y +
															innerLine.textTop,
															innerSegment.width,
															innerLine.height,
														),
													});
												}
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

	const runHead = getBoxEntry(layout, node)?.head ?? null;
	if (!runHead) {
		return [];
	}

	let breakResult = runBreakResult(layout, runHead);
	if (!breakResult) {
		return [];
	}

	const layoutNode = runLayoutNode(layout, runHead);
	if (!layoutNode) {
		return [];
	}

	let {x: containerX, y: containerY} = getRunOrigin(
		layout,
		runHead,
		layoutNode,
	);

	// getDocumentPosition gives the border box, and a blockified inline flex
	// item heading its own run reserved padding and border in it (the
	// parentIsFlex exception) that its text sits inside, as the painter
	// insets it. A normal inline's box model is cleared, an inline-block's
	// offset is getDocumentPosition's, and a block's run head is a text node
	// with no box.
	if (getNodeType(runHead) === runHead.ELEMENT_NODE) {
		const runHeadElement = runHead as Element;
		if (
			getLayoutDisplay(runHeadElement) === "inline" &&
			hasItemParent(runHeadElement)
		) {
			const runHeadBox = getBoxModel(runHeadElement);
			containerX += runHeadBox.paddingLeft + runHeadBox.borderLeftWidth;
			containerY += runHeadBox.paddingTop + runHeadBox.borderTopWidth;
		}
	}

	// A run an element heads in its own box, as a blockified flex item
	// does, starts at that element's origin, as the painter draws it. One
	// it heads in an anonymous box of its parent's lines sits in them.
	const headsOwnBox =
		getNodeType(runHead) === runHead.ELEMENT_NODE &&
		!layout.anonymousBoxes.get(layoutNode);
	let currentBreakResult = breakResult;
	let accumulatedOffsetX = 0;
	let accumulatedOffsetY = 0;
	let currentNode = node;
	// Whose text-align governs these lines: the block container, until the
	// walk descends into an inline-block's nested breakResult, a fresh
	// formatting context with its own alignment.
	let alignContainer: Element | null = flatParentElement(runHead);

	// Flat-tree parents. A UA shadow tree's UA shadow text has no parentElement
	// chain to its host, and the walk would stop at the shadow boundary.
	while (currentNode !== runHead && flatParentElement(currentNode)) {
		const parent = flatParentElement(currentNode)!;

		if (establishesIndependentFormattingContext(parent)) {
			// A text control's windowed value shifts its content by its own
			// scroll, so the caret stays in view, independent of whether its
			// segment is found below.
			accumulatedOffsetX -= getScrollOffset(parent as Element, "left");
			accumulatedOffsetY -= getScrollOffset(parent as Element, "top");
			let found = false;
			for (const line of currentBreakResult.lines) {
				for (const segment of line.segments) {
					if (
						segment.leaf.type === "inline-block" && segment.leaf.node === parent
					) {
						// To the CONTENT edge. Border and padding occupy cells.
						accumulatedOffsetX +=
							(parent === runHead && headsOwnBox
								? 0
								: getLineStart(alignContainer, currentBreakResult, line) +
									segment.x) +
							segment.leaf.boxModel.paddingLeft +
							segment.leaf.boxModel.borderLeftWidth;
						accumulatedOffsetY +=
							line.y +
							segment.dy +
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
				if (found) {
					break;
				}
			}
		}
		currentNode = parent;
	}

	containerX += accumulatedOffsetX;
	containerY += accumulatedOffsetY;
	breakResult = currentBreakResult;

	// position:relative on a run member shifts its painted fragments. The
	// box-less ancestors up to the run head accumulate offsets.
	for (
		let ancestor = getNodeType(node) === node.ELEMENT_NODE
			? (node as Element)
			: flatParentElement(node);
		ancestor && ancestor !== runHead && !layout.nodeMap.has(ancestor);
		ancestor = flatParentElement(ancestor)
	) {
		if (getPosition(ancestor) === "relative") {
			const left = toCellLength(
				CSSValues.parseSignedUnitValue(getComputedValue(ancestor, "left")),
				false,
				ancestor,
			);
			const top = toCellLength(
				CSSValues.parseSignedUnitValue(getComputedValue(ancestor, "top")),
				true,
				ancestor,
			);
			if (typeof left === "number") {
				containerX += left;
			}
			if (typeof top === "number") {
				containerY += top;
			}
		}
	}

	let targetTextNodes: Set<Node>;

	if (getNodeType(node) === node.TEXT_NODE || isLineBreak(node)) {
		targetTextNodes = new Set([node]);
	} else {
		targetTextNodes = new Set<Node>();

		targetTextNodes.add(node);
		for (
			let found = flowNext(node, node, false);
			found !== null;
			found = flowNext(found, node, false)
		) {
			if (
				getNodeType(found) === found.TEXT_NODE ||
				getNodeType(found) === found.ELEMENT_NODE
			) {
				targetTextNodes.add(found);
			}
		}
	}

	const rectTexts: RectText[] = [];

	// Without the index every text node's lookup scanned every segment of
	// its run. Painting a run of N boxes cost O(N^2) segment visits per
	// frame.
	const index = getBreakResultTextIndex(layout, breakResult);

	const byLine = new Map<number, TextFragmentEntry[]>();
	for (const textNode of targetTextNodes) {
		const entries = index.get(textNode);
		if (!entries) {
			continue;
		}
		for (const entry of entries) {
			let bucket = byLine.get(entry.line);
			if (!bucket) {
				byLine.set(entry.line, (bucket = []));
			}
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
			let {x, width} = targetText;
			// The node's own margin is outside its box. A descendant's is
			// inside it.
			const edge = targetText.edge;
			if (edge !== undefined && edge.node === node) {
				const margin = Math.max(0, edge.margin);
				x += edge.side === "start" ? margin : 0;
				width = Math.max(0, width - margin);
			}
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x + width);
			concatenatedText += targetText.text;
		}
		const texts = bucket.filter((entry) => entry.edge === undefined);
		const first = texts[0] ?? bucket[0];
		const last = texts[texts.length - 1] ?? bucket[bucket.length - 1];

		const alignOffset = getLineAlignOffset(
			alignContainer,
			currentBreakResult.containerWidth,
			line.width,
		);
		const indent = getLineIndent(
			line === currentBreakResult.lines[0],
			alignContainer,
			currentBreakResult.containerWidth,
		);

		const rect = new layout.domRect(
			containerX + minX + alignOffset + indent,
			containerY + line.y + line.textTop,
			maxX - minX,
			line.height - line.textTop,
		);
		rectTexts.push({
			rect,
			column: first.column,
			text: concatenatedText,
			startOffset: first.startOffset,
			endOffset: last.endOffset,
			visualBase: first.visualBase,
		});
	}

	return rectTexts;
}

function getDocumentContentHeight(engine: Layout): number {
	const bodyRect = engine.getRect(engine.rootElement.ownerDocument?.body);
	return Math.max(
		bodyRect ? Math.ceil(bodyRect.height) : 0,
		getDocumentOverflowBottom(engine),
	);
}

// The bottom of the viewport's scrollable overflow (css-overflow-3 §2.2):
// how far down the in-flow and absolutely positioned boxes reach, past
// the root's own box. A box that clips its content reaches no further
// than itself, and a fixed box moves with the viewport, not in it.
function getDocumentOverflowBottom(engine: Layout): number {
	const root = engine.nodeMap.get(engine.rootElement);
	const extent = root ? getStoredExtent(root) : undefined;
	return extent ? Math.ceil(root!.grid.top + extent.overflowBottom) : 0;
}

function measureScrollExtent(
	layout: Layout,
	element: Element,
): {width: number | null; height: number} | null {
	const layoutNode = layout.nodeMap.get(element);
	if (!layoutNode) {
		return null;
	}
	const border = layoutNode.style.border;
	const result = layoutNode.result;
	let right: number | null = 0;
	let bottom = 0;
	const extent = layoutNode.style.clipsOverflow
		? getStoredExtent(layoutNode)
		: undefined;
	if (extent !== undefined) {
		// The layout pass found it.
		if (extent.scrollBottom === null) {
			return null;
		}
		right = extent.scrollRight;
		bottom = extent.scrollBottom;
	} else {
		if (layoutNode.measure !== null) {
			// Its own lines are its content.
			const lines = getMeasuredLines(layout, layoutNode);
			if (lines === undefined) {
				return null;
			}
			right = border.left + result.paddingLeft + lines.maxLineWidth;
			bottom = border.top + result.paddingTop + lines.totalHeight;
		}
		for (const child of layoutNode.children) {
			// A display:none placeholder holds a stale layout.
			if (child.style.displayType === "none") {
				continue;
			}
			const reach = getStoredExtent(child)!;
			if (right !== null) {
				right =
					child.measure !== null &&
						getMeasuredLines(layout, child) === undefined
						? null
						: Math.max(right, child.grid.left + reach.overflowRight);
			}
			bottom = Math.max(bottom, child.grid.top + reach.overflowBottom);
		}
	}
	const clientWidth = getComputedWidth(layoutNode) - border.left - border.right;
	const clientHeight =
		getComputedHeight(layoutNode) - border.top - border.bottom;
	return {
		width: right === null
			? null
			: Math.round(
				Math.max(clientWidth, right - border.left + result.paddingRight),
			),
		height: Math.round(
			Math.max(clientHeight, bottom - border.top + result.paddingBottom),
		),
	};
}

// The lines a measured node broke: an anonymous run's, or those of the
// element whose own box is the run.
function getMeasuredLines(
	layout: Layout,
	node: LayoutNode,
): BreakResult | undefined {
	const anonymous = layout.anonymousBoxes.get(node);
	if (anonymous !== undefined) {
		return anonymous.fragments ?? undefined;
	}
	return node.owner === null
		? undefined
		: runBreakResult(layout, node.owner as Node);
}

function getContentBoxSize(
	engine: Layout,
	element: Element,
): {width: number; height: number} | null {
	const rect = layoutRect(engine, element);
	if (!rect) {
		return null;
	}
	const box = getBoxModel(element);
	return {
		width: rect.width - box.borderLeftWidth - box.borderRightWidth,
		height: rect.height - box.borderTopWidth - box.borderBottomWidth,
	};
}

// html and body scroll the document itself: one viewport, however
// reached.
function isRootBox(engine: Layout, element: Element): boolean {
	const document = engine.window.document;
	return element === document.documentElement || element === document.body;
}

// Document-relative rects on both sides: the element wherever its
// current offsets put it, against the scroller's padding box.
// How far a scroll port moves to show [start, end) at the given place in
// [portStart, portEnd). "nearest" moves the least, and not at all when the
// span is already in view.
function getAlignmentDelta(
	start: number,
	end: number,
	portStart: number,
	portEnd: number,
	align: ScrollLogicalPosition,
): number {
	if (align === "start") {
		return start - portStart;
	}
	if (align === "end") {
		return end - portEnd;
	}
	if (align === "center") {
		return (start + end) / 2 - (portStart + portEnd) / 2;
	}
	// "nearest" (CSSOM View): a box that overhangs both edges stays put, and
	// one that overhangs one edge lines that edge up if it fits, or the
	// other edge if it does not.
	const fits = end - start <= portEnd - portStart;
	if (start < portStart && end > portEnd) {
		return 0;
	}
	if (start < portStart) {
		return fits ? start - portStart : end - portEnd;
	}
	if (end > portEnd) {
		return fits ? end - portEnd : start - portStart;
	}
	return 0;
}

// Innermost port first. Each scroll moves the target in every outer
// port's coordinates, so the rect is read again for each.
function revealRectInScrollPorts(
	engine: Layout,
	element: Element,
	getRect: () => DOMRect | null,
	block: ScrollLogicalPosition,
	inline: ScrollLogicalPosition,
): void {
	for (
		let ancestor = flatParentElement(element);
		ancestor && !isRootBox(engine, ancestor);
		ancestor = flatParentElement(ancestor)
	) {
		if (isScrollContainer(ancestor)) {
			revealInPort(engine, getRect(), ancestor, block, inline);
		}
	}
}

function revealInPort(
	engine: Layout,
	rect: DOMRect | null,
	scroller: Element,
	block: ScrollLogicalPosition,
	inline: ScrollLogicalPosition,
): void {
	const scrollerRect = engine.getRect(scroller);
	if (!rect || !scrollerRect) {
		return;
	}
	const box = getBoxModel(scroller);
	const portTop = scrollerRect.top + (box.borderTopWidth || 0);
	const portBottom = scrollerRect.bottom - (box.borderBottomWidth || 0);
	const portLeft = scrollerRect.left + (box.borderLeftWidth || 0);
	const portRight = scrollerRect.right - (box.borderRightWidth || 0);
	const down = Math.round(
		getAlignmentDelta(rect.top, rect.bottom, portTop, portBottom, block),
	);
	// The offsets are cells here, and scrollTop is CSS pixels.
	if (down !== 0) {
		scroller.scrollTop += pxFromCells(down, true, scroller);
	}
	const across = Math.round(
		getAlignmentDelta(rect.left, rect.right, portLeft, portRight, inline),
	);
	if (across !== 0) {
		scroller.scrollLeft += pxFromCells(across, false, scroller);
	}
}

function isScrollingOverflow(overflow: string): boolean {
	return overflow === "auto" || overflow === "scroll" || overflow === "hidden";
}

// Whether either axis clips its content into a scroll port. A longhand
// left unset takes the shorthand's value.
function isScrollContainer(element: Element): boolean {
	const overflow = getComputedValue(element, "overflow");
	return (
		isScrollingOverflow(getComputedValue(element, "overflow-x") || overflow) ||
		isScrollingOverflow(getComputedValue(element, "overflow-y") || overflow)
	);
}
