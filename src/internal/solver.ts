import type {
	GridAreaMap,
	GridPlacement,
	TrackBreadth,
	TrackList,
	TrackListTrack,
	TrackSize,
	Value,
} from "./cssvalues.ts";

// `normal` means whatever the mode says: stretch on a grid item,
// flex-start across flex lines (css-align-3).
export type Align =
	"auto" |
	"flex-start" |
	"center" |
	"flex-end" |
	"stretch" |
	"baseline" |
	"space-between" |
	"space-around" |
	"space-evenly" |
	"normal";

export type Justify =
	"flex-start" |
	"center" |
	"flex-end" |
	"space-between" |
	"space-around" |
	"space-evenly" |
	"normal" |
	"stretch";

export type Wrap = "nowrap" | "wrap" | "wrap-reverse";

export type FlexDirection = "column" | "column-reverse" | "row" | "row-reverse";

export type Gutter = "column" | "row";

type DisplayType =
	"flex" |
	"none" |
	"block" |
	"table" |
	"table-row-group" |
	"table-header-group" |
	"table-footer-group" |
	"table-row" |
	"table-cell" |
	"table-caption" |
	"grid";

// `fixed` is contained by the viewport however deep it is, so no
// ancestor between may claim it.
type PositionType = "static" | "relative" | "absolute" | "fixed";

function isOutOfFlowType(positionType: PositionType): boolean {
	return positionType === "absolute" || positionType === "fixed";
}

function isContainingBlockType(positionType: PositionType): boolean {
	return positionType !== "static";
}

export type AvailableSpace = "indefinite" | "definite" | "shrink-to-fit";

type Edges<T> = {left: T; top: T; right: T; bottom: T};

export type Edge = keyof Edges<unknown>;

// css-sizing-3 §5 keywords, stored beside a width of `auto` rather than
// as a unit of it, so min/max, percentages and flex arithmetic still
// read auto.
export type Sizing = "none" | "min-content" | "max-content" | "fit-content";

export interface Size {
	width: number;
	height: number;
}

// `performLayout` is true for the measurement that places the box and
// false for the sizing probes before it. Only the placing one may keep
// its line breaks.
type Measure = (
	width: number,
	widthSpace: AvailableSpace,
	performLayout: boolean,
) => Size;

// The origin of CSS 2 §10.3.7's hypothetical box, in the containing
// block's border-box coordinates. Null means the containing block's
// alignment places it.
type StaticPosition = (
	containingBlock: LayoutNode,
) => {left: number; top: number} | null;

// NaN is the undefined length everywhere below. 0 is a length.
const UNDEFINED_VALUE: Value = {unit: "undefined", value: NaN};
const AUTO_VALUE: Value = {unit: "auto", value: NaN};

export type Length = number | "auto" | {percentage: number} | undefined | null;

function resolveValue(value: Value, ownerSize: number): number {
	switch (value.unit) {
		case "cell":
			return value.value;
		case "percent":
			return Number.isNaN(ownerSize) ? NaN : (value.value * ownerSize) / 100;
		default:
			return NaN;
	}
}

function isDefined(n: number): boolean {
	return !Number.isNaN(n);
}

function resolveMargin(value: Value, ownerWidth: number): number {
	if (value.unit === "auto") {
		return 0;
	}
	const resolved = resolveValue(value, ownerWidth);
	return isDefined(resolved) ? resolved : 0;
}

function isRow(axis: FlexDirection): boolean {
	return axis === "row" || axis === "row-reverse";
}

function isColumn(axis: FlexDirection): boolean {
	return (axis === "column" || axis === "column-reverse");
}

function isReverse(axis: FlexDirection): boolean {
	return (axis === "row-reverse" || axis === "column-reverse");
}

function getCrossAxis(axis: FlexDirection): FlexDirection {
	return isRow(axis) ? "column" : "row";
}

function getLeadingEdge(axis: FlexDirection): Edge {
	switch (axis) {
		case "row":
			return "left";
		case "row-reverse":
			return "right";
		case "column":
			return "top";
		default:
			return "bottom";
	}
}

function getTrailingEdge(axis: FlexDirection): Edge {
	switch (axis) {
		case "row":
			return "right";
		case "row-reverse":
			return "left";
		case "column":
			return "bottom";
		default:
			return "top";
	}
}

export interface Style {
	flexDirection: FlexDirection;
	justifyContent: Justify;
	alignContent: Align;
	alignItems: Align;
	alignSelf: Align;
	positionType: PositionType;
	flexWrap: Wrap;
	displayType: DisplayType;

	gap: {column: number; row: number};

	// A flex container reads neither. Its inline axis is justify-content's
	// (css-align-3 §6). Grid only.
	justifyItems: Align;
	justifySelf: Align;

	gridTemplateColumns: TrackList;
	gridTemplateRows: TrackList;
	gridTemplateAreas: GridAreaMap | null;
	gridAutoColumns: TrackSize[];
	gridAutoRows: TrackSize[];

	gridAutoFlowColumn: boolean;
	gridAutoFlowDense: boolean;

	gridRowStart: GridPlacement;
	gridRowEnd: GridPlacement;
	gridColumnStart: GridPlacement;
	gridColumnEnd: GridPlacement;

	colSpan: number;
	rowSpan: number;
	borderCollapse: boolean;

	// Children's margins are contained. None collapses through this box's
	// edges (css2 §8.3.1, §9.4.1).
	blockFormattingContext: boolean;

	flexGrow: number;
	order: number;
	flexShrink: number;
	flexBasis: Value;

	margin: Edges<Value>;
	position: Edges<Value>;
	padding: Edges<Value>;
	border: Edges<number>;

	width: Value;
	widthSizing: Sizing;
	height: Value;
	minWidth: Value;
	minHeight: Value;
	maxWidth: Value;
	maxHeight: Value;

	// width / height in cells on both axes, so 1 makes a 10-wide box 10
	// rows tall. NaN is auto.
	aspectRatio: number;
}

interface LayoutResult {
	left: number;
	top: number;
	width: number;
	height: number;
	margin: Edges<number>;
	padding: Edges<number>;
	computedFlexBasis: number;

	// css-flexbox-1 §4.5, along the parent's main axis.
	automaticMinimumSize: number;

	// Used track sizes in the implicit grid's order, which is what
	// getComputedStyle reports for grid-template-*. Null when not a grid
	// container.
	gridColumns: number[] | null;
	gridRows: number[] | null;

	// How many of those tracks are before the explicit grid's first line.
	gridColumnOffset: number;
	gridRowOffset: number;

	// The margins escaping the box's top and bottom edges, each stored as
	// its largest positive and most negative member (css2 §8.3.1). The
	// block container above reads them to place the box.
	collapseTopPositive: number;
	collapseTopNegative: number;
	collapseBottomPositive: number;
	collapseBottomNegative: number;

	// A zero-height block with nothing at either vertical edge. Its
	// neighbours' margins pass through it (css2 §8.3.1).
	selfCollapsing: boolean;
}

interface CachedSize {
	availableWidth: number;
	availableHeight: number;
	widthSpace: AvailableSpace;
	heightSpace: AvailableSpace;
	ownerWidth: number;
	ownerHeight: number;
	width: number;
	height: number;
}

// Undefined constraints are NaN, and NaN !== NaN.
function isSameConstraint(a: number, b: number): boolean {
	return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

function isMatchingConstraints(
	cache: CachedSize,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
): boolean {
	return (
		cache.widthSpace === widthSpace &&
		cache.heightSpace === heightSpace &&
		isSameConstraint(cache.availableWidth, availableWidth) &&
		isSameConstraint(cache.availableHeight, availableHeight) &&
		isSameConstraint(cache.ownerWidth, ownerWidth) &&
		isSameConstraint(cache.ownerHeight, ownerHeight)
	);
}

// The cache reuse rules, after Yoga. Beyond an identical request, a
// cached size satisfies a `definite` request of that same size, a
// `shrink-to-fit` bound over an unbounded result that fits it, and a tighter
// `shrink-to-fit` bound the result still fits. Sizing only. A full layout
// placed children against its request.
function isCachedSizeValid(
	cachedSpace: AvailableSpace,
	cachedAvailable: number,
	cachedComputed: number,
	mode: AvailableSpace,
	available: number,
): boolean {
	if (cachedSpace === mode && isSameConstraint(cachedAvailable, available)) {
		return true;
	}
	if (mode === "definite" && available === cachedComputed) {
		return true;
	}
	if (mode === "shrink-to-fit") {
		if (cachedSpace === "indefinite") {
			return cachedComputed <= available;
		}
		if (cachedSpace === "shrink-to-fit") {
			return cachedAvailable > available && cachedComputed <= available;
		}
	}
	return false;
}

function isMinContent(mode: AvailableSpace, available: number): boolean {
	return mode === "shrink-to-fit" && available === 0;
}

const CACHE_SLOT_COUNT = 9;

// One cache slot per query shape, after Taffy, so the probes one pass makes
// of a child (min-content, max-content, fixed) never evict each other.
function getCacheSlot(
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
): number {
	const knownWidth = widthSpace === "definite";
	const knownHeight = heightSpace === "definite";
	if (knownWidth && knownHeight) {
		return 0;
	}
	if (knownWidth) {
		return 1 + (isMinContent(heightSpace, availableHeight) ? 1 : 0);
	}
	if (knownHeight) {
		return 3 + (isMinContent(widthSpace, availableWidth) ? 1 : 0);
	}
	return (
		5 +
		(isMinContent(widthSpace, availableWidth) ? 2 : 0) +
		(isMinContent(heightSpace, availableHeight) ? 1 : 0)
	);
}

const kMeasure = Symbol("measure");
const kStaticPosition = Symbol("staticPosition");

export interface LayoutNode {
	[kMeasure]: Measure | null;
	[kStaticPosition]: StaticPosition | null;
}

export class LayoutNode {
	// Replaced whole by a restyle or written in place, with invalidate()
	// after either.
	style: Style;
	layout: LayoutResult;
	children: LayoutNode[];
	parent: LayoutNode | null;
	stale: boolean;

	// The rows this subtree can paint, in absolute document rows. Absolutely
	// positioned children push it outside the box. Set by
	// computePaintExtents.
	extentTop: number;
	extentBottom: number;

	// Children whose extent need not follow document order: positioned
	// ones, and display:none ones, whose layout.top is never updated.
	// children[] is sorted by extentTop only when this is 0.
	unstackedChildCount: number;

	// One sizing result per query shape (getCacheSlot), so a placing pass's
	// several probes of one child keep their own. `stale` invalidates both.
	cachedSizes: Array<CachedSize | null>;
	cachedLayout: CachedSize | null;

	// The layout pass that last styled this node. A node re-added within
	// the pass that styled it is not styled again.
	styledPass: number;

	// The computed values that shape text measurement without being part
	// of the style record, joined, so a restyle can tell whether the
	// measurement is still good. Set with the style.
	measureKey: string;

	// Null for a node no DOM node owns: an anonymous run, an independent
	// formatting context, the viewport. Stored on the node rather than in a map
	// because it is read during paint culling and every child sweep, and a node
	// that left the tree cannot go stale.
	owner: object | null;

	constructor() {
		this.children = [];
		this.parent = null;
		this[kMeasure] = null;
		this[kStaticPosition] = null;
		this.stale = true;
		this.extentTop = 0;
		this.extentBottom = 0;
		this.unstackedChildCount = 0;
		this.cachedSizes = new Array(CACHE_SLOT_COUNT).fill(null);
		this.cachedLayout = null;
		this.owner = null;
		this.styledPass = 0;
		this.measureKey = "";
		this.style = createStyle();
		this.layout = createLayout();
	}

	get measure(): Measure | null {
		return this[kMeasure];
	}

	set measure(fn: Measure | null) {
		this[kMeasure] = fn;
		this.invalidate();
	}

	get staticPosition(): StaticPosition | null {
		return this[kStaticPosition];
	}

	set staticPosition(fn: StaticPosition | null) {
		this[kStaticPosition] = fn;
		this.invalidate();
	}

	insertChild(child: LayoutNode, index: number): void {
		child.parent = this;
		this.children.splice(index, 0, child);
		invalidateAncestors(this);
	}

	removeChild(child: LayoutNode): void {
		const index = this.children.indexOf(child);
		if (index !== -1) {
			this.children.splice(index, 1);
			child.parent = null;
			invalidateAncestors(this);
		}
	}

	// Searches from the tail. Callers mostly ask about the child they just
	// appended.
	getChildIndex(child: LayoutNode): number {
		return this.children.lastIndexOf(child);
	}

	invalidate(): void {
		this.stale = true;
		invalidateAncestors(this);
	}

	computePaintExtents(originTop: number): void {
		const top = originTop + this.layout.top;
		let extentTop = top;
		let extentBottom = top + this.getComputedHeight();
		let unstacked = 0;
		for (const child of this.children) {
			child.computePaintExtents(top);
			if (isUnstacked(child)) {
				unstacked++;
			}
			if (child.extentTop < extentTop) {
				extentTop = child.extentTop;
			}
			if (child.extentBottom > extentBottom) {
				extentBottom = child.extentBottom;
			}
		}
		this.extentTop = extentTop;
		this.extentBottom = extentBottom;
		this.unstackedChildCount = unstacked;
	}

	getComputedGridTracks(
		rows: boolean,
	): {sizes: number[]; offset: number} | null {
		const sizes = rows ? this.layout.gridRows : this.layout.gridColumns;
		if (!sizes) {
			return null;
		}
		return {
			sizes,
			offset: rows ? this.layout.gridRowOffset : this.layout.gridColumnOffset,
		};
	}

	getComputedWidth(): number {
		return isDefined(this.layout.width) ? this.layout.width : 0;
	}

	getComputedHeight(): number {
		return isDefined(this.layout.height) ? this.layout.height : 0;
	}

	performLayout(ownerWidth: number, ownerHeight: number): void {
		const width = resolveValue(this.style.width, ownerWidth);
		const height = resolveValue(this.style.height, ownerHeight);

		let availableWidth = isDefined(width) ? width : ownerWidth;
		let widthSpace: AvailableSpace = isDefined(availableWidth)
			? "definite"
			: "indefinite";
		// A sizing keyword on a root turns the owner's width from the used
		// width into a probe: zero for min-content, a ceiling for fit-content,
		// and no request at all for max-content.
		if (!isDefined(width) && this.style.widthSizing !== "none") {
			if (this.style.widthSizing === "min-content") {
				availableWidth = 0;
				widthSpace = "shrink-to-fit";
			} else if (this.style.widthSizing === "max-content") {
				availableWidth = NaN;
				widthSpace = "indefinite";
			} else if (isDefined(availableWidth)) {
				widthSpace = "shrink-to-fit";
			}
		}
		const availableHeight = isDefined(height) ? height : ownerHeight;

		layoutNode(
			this,
			availableWidth,
			availableHeight,
			widthSpace,
			isDefined(availableHeight) ? "definite" : "indefinite",
			ownerWidth,
			ownerHeight,
			true,
		);

		roundToGrid(this, 0, 0);
		this.computePaintExtents(0);
		this.stale = false;
	}
}

export function toValue(input: Length): Value {
	if (input === undefined || input === null) {
		return UNDEFINED_VALUE;
	}
	if (typeof input === "object") {
		return {unit: "percent", value: input.percentage};
	}
	if (typeof input === "number") {
		return Number.isNaN(input) ? UNDEFINED_VALUE : {unit: "cell", value: input};
	}
	return AUTO_VALUE;
}

const AUTO_PLACEMENT: GridPlacement = {span: false, index: null, name: null};

/** The `auto` track size: the initial value of grid-auto-rows/columns. */
const AUTO_TRACK: TrackSize = {min: {kind: "auto"}, max: {kind: "auto"}};

const EMPTY_TRACK_LIST: TrackList = {parts: [], endNames: []};

// Browser defaults, not Yoga's: row direction, align-content stretch,
// flex-shrink 1.
export function createStyle(): Style {
	return {
		flexDirection: "row",
		justifyContent: "flex-start",
		alignContent: "stretch",
		alignItems: "stretch",
		alignSelf: "auto",
		positionType: "relative",
		flexWrap: "nowrap",
		displayType: "flex",

		gap: {column: 0, row: 0},

		justifyItems: "normal",
		justifySelf: "auto",

		gridTemplateColumns: EMPTY_TRACK_LIST,
		gridTemplateRows: EMPTY_TRACK_LIST,
		gridTemplateAreas: null,
		gridAutoColumns: [AUTO_TRACK],
		gridAutoRows: [AUTO_TRACK],
		gridAutoFlowColumn: false,
		gridAutoFlowDense: false,

		gridRowStart: AUTO_PLACEMENT,
		gridRowEnd: AUTO_PLACEMENT,
		gridColumnStart: AUTO_PLACEMENT,
		gridColumnEnd: AUTO_PLACEMENT,

		colSpan: 1,
		rowSpan: 1,
		borderCollapse: false,
		blockFormattingContext: false,

		flexGrow: NaN,
		order: 0,
		flexShrink: NaN,
		flexBasis: AUTO_VALUE,

		margin: {
			left: UNDEFINED_VALUE,
			top: UNDEFINED_VALUE,
			right: UNDEFINED_VALUE,
			bottom: UNDEFINED_VALUE,
		},
		position: {
			left: UNDEFINED_VALUE,
			top: UNDEFINED_VALUE,
			right: UNDEFINED_VALUE,
			bottom: UNDEFINED_VALUE,
		},
		padding: {
			left: UNDEFINED_VALUE,
			top: UNDEFINED_VALUE,
			right: UNDEFINED_VALUE,
			bottom: UNDEFINED_VALUE,
		},
		border: {left: 0, top: 0, right: 0, bottom: 0},

		width: AUTO_VALUE,
		widthSizing: "none",
		height: AUTO_VALUE,
		minWidth: UNDEFINED_VALUE,
		minHeight: UNDEFINED_VALUE,
		maxWidth: UNDEFINED_VALUE,
		maxHeight: UNDEFINED_VALUE,
		aspectRatio: NaN,
	};
}

function createLayout(): LayoutResult {
	return {
		left: 0,
		top: 0,
		width: NaN,
		height: NaN,
		margin: {left: 0, top: 0, right: 0, bottom: 0},
		padding: {left: 0, top: 0, right: 0, bottom: 0},
		computedFlexBasis: NaN,
		automaticMinimumSize: NaN,
		gridColumns: null,
		gridRows: null,
		gridColumnOffset: 0,
		gridRowOffset: 0,
		collapseTopPositive: 0,
		collapseTopNegative: 0,
		collapseBottomPositive: 0,
		collapseBottomNegative: 0,
		selfCollapsing: false,
	};
}

function isUnstacked(node: LayoutNode): boolean {
	return (
		node.style.positionType !== "static" || node.style.displayType === "none"
	);
}

function invalidateAncestors(start: LayoutNode): void {
	for (let node: LayoutNode | null = start; node; node = node.parent) {
		node.stale = true;
	}
}

function resolveFlexGrow(node: LayoutNode): number {
	if (!node.parent) {
		return 0;
	}
	return isDefined(node.style.flexGrow) ? node.style.flexGrow : 0;
}

function resolveFlexShrink(node: LayoutNode): number {
	if (!node.parent) {
		return 0;
	}
	if (isDefined(node.style.flexShrink)) {
		return node.style.flexShrink;
	}
	return 1;
}

function resolveFlexBasis(node: LayoutNode, mainAxis: FlexDirection): Value {
	const basis = node.style.flexBasis;
	if (basis.unit !== "auto" && basis.unit !== "undefined") {
		return basis;
	}
	return isRow(mainAxis) ? node.style.width : node.style.height;
}

function getAlignSelf(parent: LayoutNode, child: LayoutNode): Align {
	const align =
		child.style.alignSelf === "auto"
			? parent.style.alignItems
			: child.style.alignSelf;
	// css-align-3 §4.2.
	return align === "normal" ? "stretch" : align;
}

// A cell grid has no font metrics, so a text run's baseline is the top
// of its first row. A box takes its first in-flow child's baseline
// (css-flexbox-1 §8.5), and an empty one its content edge. Not
// flex-start: leading border and padding push the first row down, and
// this compensates for them.
function getBaselineWithinBorderBox(
	node: LayoutNode,
	ownerWidth: number,
): number {
	const contentTop = getEdgePaddingAndBorder(node, "top", ownerWidth);

	for (const child of node.children) {
		if (child.style.displayType === "none") {
			continue;
		}
		if (isOutOfFlowType(child.style.positionType)) {
			continue;
		}
		return child.layout.top + getBaselineWithinBorderBox(child, ownerWidth);
	}

	return contentTop;
}

// The row gap separates rows, so it is the gap along the column axis,
// and vice versa.
function getAxisGap(node: LayoutNode, axis: FlexDirection): number {
	return isRow(axis) ? node.style.gap["column"] : node.style.gap["row"];
}

function getAxisMargin(
	node: LayoutNode,
	axis: FlexDirection,
	ownerWidth: number,
): number {
	return (
		resolveMargin(node.style.margin[getLeadingEdge(axis)], ownerWidth) +
		resolveMargin(node.style.margin[getTrailingEdge(axis)], ownerWidth)
	);
}

function getEdgePaddingAndBorder(
	node: LayoutNode,
	edge: Edge,
	ownerWidth: number,
): number {
	const padding = resolveValue(node.style.padding[edge], ownerWidth);
	return (
		(isDefined(padding) ? Math.max(padding, 0) : 0) + node.style.border[edge]
	);
}

function getAxisPaddingAndBorder(
	node: LayoutNode,
	axis: FlexDirection,
	ownerWidth: number,
): number {
	return (
		getEdgePaddingAndBorder(node, getLeadingEdge(axis), ownerWidth) +
		getEdgePaddingAndBorder(node, getTrailingEdge(axis), ownerWidth)
	);
}

function isStyleDimensionDefined(
	node: LayoutNode,
	axis: FlexDirection,
	ownerSize: number,
): boolean {
	const value = isRow(axis) ? node.style.width : node.style.height;
	if (value.unit === "auto" || value.unit === "undefined") {
		return false;
	}
	if (value.unit === "cell" && value.value < 0) {
		return false;
	}
	if (
		value.unit === "percent" && (value.value < 0 || Number.isNaN(ownerSize))
	) {
		return false;
	}
	return true;
}

function boundAxisWithinMinMax(
	node: LayoutNode,
	axis: FlexDirection,
	value: number,
	axisSize: number,
): number {
	const min = resolveValue(
		isRow(axis) ? node.style.minWidth : node.style.minHeight,
		axisSize,
	);
	const max = resolveValue(
		isRow(axis) ? node.style.maxWidth : node.style.maxHeight,
		axisSize,
	);

	let bounded = value;
	if (isDefined(max) && max >= 0 && bounded > max) {
		bounded = max;
	}
	if (isDefined(min) && min >= 0 && bounded < min) {
		bounded = min;
	}
	return bounded;
}

// Floored at padding+border. A box never goes below its own chrome.
function boundAxis(
	node: LayoutNode,
	axis: FlexDirection,
	value: number,
	axisSize: number,
	ownerWidth: number,
): number {
	return Math.max(
		boundAxisWithinMinMax(node, axis, value, axisSize),
		getAxisPaddingAndBorder(node, axis, ownerWidth),
	);
}

function constrainMaxSizeForMode(
	node: LayoutNode,
	axis: FlexDirection,
	ownerAxisSize: number,
	mode: {value: number; mode: AvailableSpace},
): void {
	const max = resolveValue(
		isRow(axis) ? node.style.maxWidth : node.style.maxHeight,
		ownerAxisSize,
	);
	if (!isDefined(max)) {
		return;
	}

	if (mode.mode === "definite" || mode.mode === "shrink-to-fit") {
		// A max caps the size without making it indefinite. Downgrading
		// `definite` to `shrink-to-fit` tells an empty box it is
		// shrink-wrapped, and it collapses to zero instead of taking the size
		// flex just resolved for it.
		mode.value = isDefined(mode.value) ? Math.min(mode.value, max) : max;
	} else {
		mode.value = max;
		mode.mode = "shrink-to-fit";
	}
}

function resolveNodeMargins(node: LayoutNode, ownerWidth: number): void {
	node.layout.margin.left = resolveMargin(node.style.margin.left, ownerWidth);
	node.layout.margin.top = resolveMargin(node.style.margin.top, ownerWidth);
	node.layout.margin.right = resolveMargin(node.style.margin.right, ownerWidth);
	node.layout.margin.bottom = resolveMargin(
		node.style.margin.bottom,
		ownerWidth,
	);
}

function setMeasuredSize(
	node: LayoutNode,
	width: number,
	height: number,
	ownerWidth: number,
	ownerHeight: number,
): void {
	node.layout.width = boundAxis(node, "row", width, ownerWidth, ownerWidth);
	node.layout.height = boundAxis(
		node,
		"column",
		height,
		ownerHeight,
		ownerWidth,
	);
}

function layoutMeasuredContent(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(node, "row", ownerWidth);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);

	const innerWidth = isDefined(availableWidth)
		? Math.max(0, availableWidth - marginRow - paddingBorderRow)
		: NaN;

	if (
		widthSpace === "definite" &&
		heightSpace === "definite" &&
		// Only on a sizing pass. The measure also breaks the text into the
		// lines that get painted, and skipping it on the placing pass left a
		// stretched item painting the lines of its last probe, the min-content
		// one.
		!performLayout
	) {
		setMeasuredSize(
			node,
			availableWidth - marginRow,
			availableHeight - marginColumn,
			ownerWidth,
			ownerHeight,
		);
		return;
	}

	const measured = node.measure!(innerWidth, widthSpace, performLayout);

	const width =
		widthSpace === "definite"
			? availableWidth - marginRow
			: measured.width + paddingBorderRow;
	const height =
		heightSpace === "definite"
			? availableHeight - marginColumn
			: measured.height + paddingBorderColumn;

	// Not clamped to an `shrink-to-fit` request. An unbreakable word overflows,
	// and a box claiming less than it occupies made min-content zero and let
	// a long word paint over its neighbour.
	setMeasuredSize(node, width, height, ownerWidth, ownerHeight);
}

function layoutEmptyContainer(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(node, "row", ownerWidth);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);

	const width =
		widthSpace === "indefinite" || widthSpace === "shrink-to-fit"
			? paddingBorderRow
			: availableWidth - marginRow;
	const height =
		heightSpace === "indefinite" || heightSpace === "shrink-to-fit"
			? paddingBorderColumn
			: availableHeight - marginColumn;

	setMeasuredSize(node, width, height, ownerWidth, ownerHeight);
}

// css-flexbox-1 §9.2.
function computeFlexBasisForChild(
	node: LayoutNode,
	child: LayoutNode,
	width: number,
	widthSpace: AvailableSpace,
	height: number,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const mainAxis = node.style.flexDirection;
	const mainIsRow = isRow(mainAxis);
	const mainAxisSize = mainIsRow ? width : height;
	const mainAxisOwnerSize = mainIsRow ? ownerWidth : ownerHeight;

	const basis = resolveFlexBasis(child, mainAxis);
	const resolvedBasis = resolveValue(basis, mainAxisOwnerSize);

	const rowDimDefined = isStyleDimensionDefined(child, "row", ownerWidth);
	const columnDimDefined = isStyleDimensionDefined(
		child,
		"column",
		ownerHeight,
	);

	if (isDefined(resolvedBasis) && isDefined(mainAxisSize)) {
		child.layout.computedFlexBasis = Math.max(
			resolvedBasis,
			getAxisPaddingAndBorder(child, mainAxis, ownerWidth),
		);
		return;
	}

	if (mainIsRow && rowDimDefined) {
		child.layout.computedFlexBasis = Math.max(
			resolveValue(child.style.width, ownerWidth),
			getAxisPaddingAndBorder(child, "row", ownerWidth),
		);
		return;
	}

	if (!mainIsRow && columnDimDefined) {
		child.layout.computedFlexBasis = Math.max(
			resolveValue(child.style.height, ownerHeight),
			getAxisPaddingAndBorder(child, "column", ownerWidth),
		);
		return;
	}

	const childWidth = {value: NaN, mode: "indefinite" as AvailableSpace};
	const childHeight = {value: NaN, mode: "indefinite" as AvailableSpace};

	const marginRow = getAxisMargin(child, "row", ownerWidth);
	const marginColumn = getAxisMargin(child, "column", ownerWidth);

	if (rowDimDefined) {
		childWidth.value = resolveValue(child.style.width, ownerWidth) + marginRow;
		childWidth.mode = "definite";
	}
	if (columnDimDefined) {
		childHeight.value =
			resolveValue(child.style.height, ownerHeight) + marginColumn;
		childHeight.mode = "definite";
	}

	if (!isDefined(childWidth.value) && isDefined(width)) {
		childWidth.value = width;
		childWidth.mode = "shrink-to-fit";
	}
	if (!isDefined(childHeight.value) && isDefined(height)) {
		childHeight.value = height;
		childHeight.mode = "shrink-to-fit";
	}

	const stretch = getAlignSelf(node, child) === "stretch";
	if (
		!mainIsRow &&
		isDefined(width) &&
		widthSpace === "definite" &&
		stretch &&
		childWidth.mode !== "definite"
	) {
		childWidth.value = width;
		childWidth.mode = "definite";
	}
	if (
		mainIsRow &&
		isDefined(height) &&
		heightSpace === "definite" &&
		stretch &&
		childHeight.mode !== "definite"
	) {
		childHeight.value = height;
		childHeight.mode = "definite";
	}

	constrainMaxSizeForMode(child, "row", ownerWidth, childWidth);
	constrainMaxSizeForMode(child, "column", ownerHeight, childHeight);

	layoutNode(
		child,
		childWidth.value,
		childHeight.value,
		childWidth.mode,
		childHeight.mode,
		ownerWidth,
		ownerHeight,
		false,
	);

	child.layout.computedFlexBasis = Math.max(
		mainIsRow ? child.layout.width : child.layout.height,
		getAxisPaddingAndBorder(child, mainAxis, ownerWidth),
	);
}

interface FlexLine {
	items: LayoutNode[];
	sizeConsumed: number;
	crossDim: number;
	mainDim: number;
}

// css-flexbox-1 §9.2-9.7.
function layoutFlexbox(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const mainAxis = node.style.flexDirection;
	const cross = getCrossAxis(mainAxis);
	const mainIsRow = isRow(mainAxis);
	const wrap = node.style.flexWrap !== "nowrap";

	const paddingBorderRow = getAxisPaddingAndBorder(node, "row", ownerWidth);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);

	const leadingPaddingBorderMain = getEdgePaddingAndBorder(
		node,
		getLeadingEdge(mainAxis),
		ownerWidth,
	);
	const leadingPaddingBorderCross = getEdgePaddingAndBorder(
		node,
		getLeadingEdge(cross),
		ownerWidth,
	);

	const paddingBorderMain = mainIsRow ? paddingBorderRow : paddingBorderColumn;
	const paddingBorderCross = mainIsRow ? paddingBorderColumn : paddingBorderRow;

	const innerWidth = isDefined(availableWidth)
		? Math.max(0, availableWidth - marginRow - paddingBorderRow)
		: NaN;
	const innerHeight = isDefined(availableHeight)
		? Math.max(0, availableHeight - marginColumn - paddingBorderColumn)
		: NaN;

	// The items' containing block is the container's content box
	// (css-flexbox-1 §4), so their percentages resolve against it.
	const itemOwnerWidth = innerWidth;
	const itemOwnerHeight = innerHeight;

	const innerMain = mainIsRow ? innerWidth : innerHeight;
	const innerCross = mainIsRow ? innerHeight : innerWidth;
	const crossSpace = mainIsRow ? heightSpace : widthSpace;
	const mainSpace = mainIsRow ? widthSpace : heightSpace;

	const mainGap = getAxisGap(node, mainAxis);
	const crossGap = getAxisGap(node, cross);

	const inFlow: LayoutNode[] = [];
	for (const child of node.children) {
		if (child.style.displayType === "none") {
			zeroLayout(child);
			continue;
		}
		resolveNodeMargins(child, itemOwnerWidth);

		if (isOutOfFlowType(child.style.positionType)) {
			continue;
		}

		// Before the basis, because this lays the child out and would clobber a
		// basis computed first.
		child.layout.automaticMinimumSize = getAutoMinimumMainSize(
			node,
			child,
			innerCross,
			crossSpace,
			itemOwnerWidth,
			itemOwnerHeight,
		);

		computeFlexBasisForChild(
			node,
			child,
			innerWidth,
			widthSpace,
			innerHeight,
			heightSpace,
			itemOwnerWidth,
			itemOwnerHeight,
		);
		inFlow.push(child);
	}

	// Order-modified document order. The sort is stable.
	if (inFlow.some((child) => child.style.order !== 0)) {
		inFlow.sort((a, b) => a.style.order - b.style.order);
	}

	const lines: FlexLine[] = [];
	let index = 0;
	while (index < inFlow.length) {
		const line: FlexLine = {
			items: [],
			sizeConsumed: 0,
			crossDim: 0,
			mainDim: 0,
		};

		for (; index < inFlow.length; index++) {
			const child = inFlow[index];
			const childMarginMain = getAxisMargin(child, mainAxis, itemOwnerWidth);
			const basis = boundAxisWithinMinMax(
				child,
				mainAxis,
				child.layout.computedFlexBasis,
				mainIsRow ? itemOwnerWidth : itemOwnerHeight,
			);

			const precedingGap = line.items.length > 0 ? mainGap : 0;

			if (
				wrap &&
				isDefined(innerMain) &&
				line.items.length > 0 &&
				line.sizeConsumed + precedingGap + basis + childMarginMain > innerMain
			) {
				break;
			}

			line.sizeConsumed += precedingGap + basis + childMarginMain;
			line.items.push(child);
		}

		lines.push(line);
		if (line.items.length === 0) {
			break;
		}
	}

	let totalCrossDim = 0;
	let maxMainDim = 0;

	for (const line of lines) {
		const lineGap = mainGap * Math.max(0, line.items.length - 1);
		const mainForItems = isDefined(innerMain)
			? Math.max(0, innerMain - lineGap)
			: innerMain;

		resolveFlexibleLengths(
			line,
			node,
			mainForItems,
			mainSpace,
			itemOwnerWidth,
			itemOwnerHeight,
		);

		for (const child of line.items) {
			layoutFlexItem(
				node,
				child,
				innerWidth,
				innerHeight,
				innerCross,
				crossSpace,
				itemOwnerWidth,
				itemOwnerHeight,
				performLayout,
			);
		}

		positionMainAxis(
			node,
			line,
			mainForItems,
			leadingPaddingBorderMain,
			mainGap,
			itemOwnerWidth,
			performLayout,
		);

		let lineCross = 0;
		for (const child of line.items) {
			const childCross =
				(isRow(cross) ? child.layout.width : child.layout.height) +
				getAxisMargin(child, cross, itemOwnerWidth);
			lineCross = Math.max(lineCross, childCross);
		}
		// Only a definite cross size fills the line. An `shrink-to-fit` bound
		// treated as definite becomes the container's content size, then its
		// basis above.
		if (!wrap && isDefined(innerCross) && crossSpace === "definite") {
			lineCross = Math.max(lineCross, innerCross);
		}
		line.crossDim = lineCross;

		totalCrossDim += lineCross;
		maxMainDim = Math.max(maxMainDim, line.mainDim);
	}

	totalCrossDim += crossGap * Math.max(0, lines.length - 1);

	const measuredMain = mainIsRow
		? widthSpace === "definite"
			? availableWidth - marginRow
			: boundAxis(
				node,
				mainAxis,
				maxMainDim + paddingBorderMain,
				ownerWidth,
				ownerWidth,
			)
		: heightSpace === "definite"
			? availableHeight - marginColumn
			: boundAxis(
				node,
				mainAxis,
				maxMainDim + paddingBorderMain,
				ownerHeight,
				ownerWidth,
			);

	const crossIsRow = isRow(cross);
	const crossExactly = crossIsRow
		? widthSpace === "definite"
		: heightSpace === "definite";
	const crossAvailable = crossIsRow
		? availableWidth - marginRow
		: availableHeight - marginColumn;

	const measuredCross = crossExactly
		? crossAvailable
		: boundAxis(
			node,
			cross,
			totalCrossDim + paddingBorderCross,
			crossIsRow ? ownerWidth : ownerHeight,
			ownerWidth,
		);

	if (mainIsRow) {
		node.layout.width = measuredMain;
		node.layout.height = measuredCross;
	} else {
		node.layout.height = measuredMain;
		node.layout.width = measuredCross;
	}

	if (!performLayout) {
		return;
	}

	const containerInnerCross =
		(crossIsRow ? node.layout.width : node.layout.height) - paddingBorderCross;

	positionCrossAxis(
		node,
		lines,
		containerInnerCross,
		totalCrossDim,
		leadingPaddingBorderCross,
		itemOwnerWidth,
		itemOwnerHeight,
	);

	if (isReverse(mainAxis)) {
		const containerInnerMain =
			(mainIsRow ? node.layout.width : node.layout.height) - paddingBorderMain;
		mirrorWithinContentBox(
			lines,
			mainAxis,
			containerInnerMain,
			leadingPaddingBorderMain,
		);
	}
	if (node.style.flexWrap === "wrap-reverse") {
		mirrorWithinContentBox(
			lines,
			cross,
			containerInnerCross,
			leadingPaddingBorderCross,
		);
	}

	// `position: relative` moves a box after flow placement, without moving
	// anything else.
	const innerWidthFinal = node.layout.width - paddingBorderRow;
	const innerHeightFinal = node.layout.height - paddingBorderColumn;

	for (const line of lines) {
		for (const child of line.items) {
			if (child.style.positionType !== "relative") {
				continue;
			}
			child.layout.left += getRelativeOffset(child, "row", innerWidthFinal);
			child.layout.top += getRelativeOffset(child, "column", innerHeightFinal);
		}
	}

	for (const child of getOutOfFlowDescendants(node, false)) {
		layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
	}
	if (node.parent === null) {
		for (const child of getOutOfFlowDescendants(node, true)) {
			layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
		}
	}
}

// An out-of-flow box is placed by its containing block, not by the box
// that contains it, so the search reaches through in-flow boxes and
// stops at any containing block. Whatever is under that one is its to
// place.
function getOutOfFlowDescendants(
	node: LayoutNode,
	viewport: boolean,
): LayoutNode[] {
	const found: LayoutNode[] = [];
	const enter = (parent: LayoutNode): void => {
		for (const child of parent.children) {
			if (child.style.displayType === "none") {
				continue;
			}
			const type = child.style.positionType;
			const wanted = viewport ? "fixed" : "absolute";
			if (type === wanted) {
				found.push(child);
			}
			// A fixed box belongs to the viewport however deep it is. An
			// absolute one stops at the first containing block, itself
			// included.
			if (!viewport && isContainingBlockType(type)) {
				continue;
			}
			enter(child);
		}
	};
	enter(node);
	return found;
}

function getRelativeOffset(
	node: LayoutNode,
	axis: FlexDirection,
	axisSize: number,
): number {
	const leading = resolveValue(
		node.style.position[getLeadingEdge(axis)],
		axisSize,
	);
	if (isDefined(leading)) {
		return leading;
	}

	const trailing = resolveValue(
		node.style.position[getTrailingEdge(axis)],
		axisSize,
	);
	if (isDefined(trailing)) {
		return -trailing;
	}

	return 0;
}

// css-flexbox-1 §9.7.
function resolveFlexibleLengths(
	line: FlexLine,
	node: LayoutNode,
	innerMain: number,
	mainSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const mainAxis = node.style.flexDirection;
	const mainOwnerSize = isRow(mainAxis) ? ownerWidth : ownerHeight;

	// Free space is measured against an unfrozen item's BASE size, never
	// the size it was last given, or each pass counts the space it took
	// twice.
	const base = new Map<LayoutNode, number>();
	const target = new Map<LayoutNode, number>();
	const frozen = new Set<LayoutNode>();

	// The automatic minimum floors every clamp, not only the hypothetical
	// size.
	const clampMain = (child: LayoutNode, value: number): number => {
		const bounded = boundAxisWithinMinMax(
			child,
			mainAxis,
			value,
			mainOwnerSize,
		);
		const floor = child.layout.automaticMinimumSize;
		return isDefined(floor) ? Math.max(bounded, floor) : bounded;
	};

	for (const child of line.items) {
		const flexBase = child.layout.computedFlexBasis;
		base.set(child, flexBase);
		target.set(child, clampMain(child, flexBase));
	}

	const commit = () => {
		for (const child of line.items) {
			child.layout.computedFlexBasis = target.get(child)!;
		}
	};

	if (!isDefined(innerMain)) {
		commit();
		return;
	}

	const outerMargin = (child: LayoutNode) =>
		getAxisMargin(child, mainAxis, ownerWidth);

	// §9.7.3: grow or shrink is decided once, from the outer hypothetical
	// sizes.
	let hypotheticalTotal = 0;
	for (const child of line.items) {
		hypotheticalTotal += target.get(child)! + outerMargin(child);
	}
	const growing = innerMain - hypotheticalTotal > 0;

	// Growing needs a definite main size. Under `shrink-to-fit` the container
	// shrink-wraps. Shrinking still applies.
	if (growing && mainSpace !== "definite") {
		commit();
		return;
	}

	const factorOf = (child: LayoutNode) =>
		growing
			? resolveFlexGrow(child)
			: resolveFlexShrink(child) * base.get(child)!;

	// §9.7.4.a: an item whose base is already past its clamp in the flexing
	// direction is inflexible.
	for (const child of line.items) {
		const flexBase = base.get(child)!;
		const hypothetical = target.get(child)!;
		const factor = growing ? resolveFlexGrow(child) : resolveFlexShrink(child);

		if (
			factor === 0 ||
			(growing && flexBase > hypothetical) ||
			(!growing && flexBase < hypothetical)
		) {
			frozen.add(child);
		}
	}

	// §9.7.4: each pass freezes at least one item.
	for (let guard = 0; guard <= line.items.length; guard++) {
		const unfrozen = line.items.filter((child) => !frozen.has(child));
		if (unfrozen.length === 0) {
			break;
		}

		let used = 0;
		for (const child of line.items) {
			const size = frozen.has(child) ? target.get(child)! : base.get(child)!;
			used += size + outerMargin(child);
		}
		const remaining = innerMain - used;

		let totalFactor = 0;
		for (const child of unfrozen) {
			totalFactor += factorOf(child);
		}
		if (totalFactor === 0) {
			break;
		}

		let violation = 0;
		const minViolations: LayoutNode[] = [];
		const maxViolations: LayoutNode[] = [];

		for (const child of unfrozen) {
			const unclamped =
				base.get(child)! + (remaining * factorOf(child)) / totalFactor;
			const bounded = clampMain(child, unclamped);

			target.set(child, bounded);
			violation += bounded - unclamped;

			if (bounded > unclamped) {
				minViolations.push(child);
			} else if (bounded < unclamped) {
				maxViolations.push(child);
			}
		}

		// §9.7.4.e: freeze by the sign of the total violation. Freezing both
		// directions strands the space an over-clamped item gave back.
		if (violation === 0) {
			for (const child of unfrozen) {
				frozen.add(child);
			}
			break;
		} else if (violation > 0) {
			for (const child of minViolations) {
				frozen.add(child);
			}
		} else {
			for (const child of maxViolations) {
				frozen.add(child);
			}
		}
	}

	commit();
}

// css-flexbox-1 §4.5: min-width/height `auto` floors a flex item at
// its min-content size, or it shrinks to nothing and its text paints
// over its neighbour. NaN when a specified minimum wins or the item
// cannot shrink.
function getAutoMinimumMainSize(
	node: LayoutNode,
	child: LayoutNode,
	innerCross: number,
	crossSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
): number {
	const mainAxis = node.style.flexDirection;
	const mainIsRow = isRow(mainAxis);
	const mainOwnerSize = mainIsRow ? ownerWidth : ownerHeight;

	const specifiedMin = mainIsRow ? child.style.minWidth : child.style.minHeight;
	if (specifiedMin.unit !== "undefined" && specifiedMin.unit !== "auto") {
		return NaN;
	}

	if (resolveFlexShrink(child) === 0) {
		return NaN;
	}

	// The cross axis keeps its real size. A column item's min-content
	// height depends on its width, and unlimited width puts its text on one
	// line.
	const crossAvailable = isDefined(innerCross) ? innerCross : NaN;
	const crossAvailableSpace = isDefined(innerCross) ? crossSpace : "indefinite";

	layoutNode(
		child,
		mainIsRow ? 0 : crossAvailable,
		mainIsRow ? crossAvailable : 0,
		mainIsRow ? "shrink-to-fit" : crossAvailableSpace,
		mainIsRow ? crossAvailableSpace : "shrink-to-fit",
		ownerWidth,
		ownerHeight,
		false,
	);

	let floor = mainIsRow ? child.layout.width : child.layout.height;

	// Never past a specified size or the item's own maximum.
	const size = mainIsRow ? child.style.width : child.style.height;
	const specified = resolveValue(size, mainOwnerSize);
	if (isDefined(specified)) {
		floor = Math.min(floor, specified);
	}

	const maxSize = mainIsRow ? child.style.maxWidth : child.style.maxHeight;
	const max = resolveValue(maxSize, mainOwnerSize);
	if (isDefined(max)) {
		floor = Math.min(floor, max);
	}

	return floor;
}

function layoutFlexItem(
	node: LayoutNode,
	child: LayoutNode,
	innerWidth: number,
	innerHeight: number,
	innerCross: number,
	crossSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const mainAxis = node.style.flexDirection;
	const cross = getCrossAxis(mainAxis);
	const mainIsRow = isRow(mainAxis);

	const mainSize = child.layout.computedFlexBasis;
	const align = getAlignSelf(node, child);

	const crossDimDefined = isStyleDimensionDefined(
		child,
		cross,
		isRow(cross) ? ownerWidth : ownerHeight,
	);

	const childWidth = {value: NaN, mode: "indefinite" as AvailableSpace};
	const childHeight = {value: NaN, mode: "indefinite" as AvailableSpace};

	const marginMainForChild = getAxisMargin(child, mainAxis, ownerWidth);
	const marginCrossForChild = getAxisMargin(child, cross, ownerWidth);

	if (mainIsRow) {
		childWidth.value = mainSize + marginMainForChild;
		childWidth.mode = "definite";
	} else {
		childHeight.value = mainSize + marginMainForChild;
		childHeight.mode = "definite";
	}

	const crossTarget = crossDimDefined
		? resolveValue(
			isRow(cross) ? child.style.width : child.style.height,
			isRow(cross) ? ownerWidth : ownerHeight,
		)
		: NaN;

	if (isDefined(crossTarget)) {
		// Unclamped, `min-width` did nothing on a column container's items.
		const bounded = boundAxisWithinMinMax(
			child,
			cross,
			crossTarget,
			innerCross,
		);
		if (isRow(cross)) {
			childWidth.value = bounded + marginCrossForChild;
			childWidth.mode = "definite";
		} else {
			childHeight.value = bounded + marginCrossForChild;
			childHeight.mode = "definite";
		}
	} else if (
		align === "stretch" && isDefined(innerCross) && crossSpace === "definite"
	) {
		// Only against a definite cross size. Stretching to a bound makes every
		// item's basis the whole container. positionCrossAxis stretches the
		// rest.
		if (isRow(cross)) {
			childWidth.value = innerCross;
			childWidth.mode = "definite";
		} else {
			childHeight.value = innerCross;
			childHeight.mode = "definite";
		}
	} else {
		const available = isRow(cross) ? innerWidth : innerHeight;
		if (isDefined(available)) {
			if (isRow(cross)) {
				childWidth.value = available;
				childWidth.mode = "shrink-to-fit";
			} else {
				childHeight.value = available;
				childHeight.mode = "shrink-to-fit";
			}
		}
	}

	constrainMaxSizeForMode(child, "row", ownerWidth, childWidth);
	constrainMaxSizeForMode(child, "column", ownerHeight, childHeight);

	layoutNode(
		child,
		childWidth.value,
		childHeight.value,
		childWidth.mode,
		childHeight.mode,
		ownerWidth,
		ownerHeight,
		performLayout,
	);
}

function stretchFlexItem(
	node: LayoutNode,
	child: LayoutNode,
	targetCross: number,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const mainAxis = node.style.flexDirection;
	const cross = getCrossAxis(mainAxis);
	const mainIsRow = isRow(mainAxis);

	const mainSize = mainIsRow ? child.layout.width : child.layout.height;
	const marginMain = getAxisMargin(child, mainAxis, ownerWidth);
	const marginCross = getAxisMargin(child, cross, ownerWidth);

	const width = mainIsRow ? mainSize + marginMain : targetCross + marginCross;
	const height = mainIsRow ? targetCross + marginCross : mainSize + marginMain;

	layoutNode(
		child,
		width,
		height,
		"definite",
		"definite",
		ownerWidth,
		ownerHeight,
		true,
	);
}

function positionMainAxis(
	node: LayoutNode,
	line: FlexLine,
	innerMain: number,
	leadingPaddingBorderMain: number,
	mainGap: number,
	ownerWidth: number,
	performLayout: boolean,
): void {
	const mainAxis = node.style.flexDirection;
	const mainIsRow = isRow(mainAxis);

	let contentMain = 0;
	for (const child of line.items) {
		contentMain +=
			(mainIsRow ? child.layout.width : child.layout.height) +
			getAxisMargin(child, mainAxis, ownerWidth);
	}

	const free = isDefined(innerMain) ? innerMain - contentMain : 0;

	// Auto margins take the free space before justify-content does.
	let autoMarginCount = 0;
	for (const child of line.items) {
		if (child.style.margin[getLeadingEdge(mainAxis)].unit === "auto") {
			autoMarginCount++;
		}
		if (child.style.margin[getTrailingEdge(mainAxis)].unit === "auto") {
			autoMarginCount++;
		}
	}

	let leading = 0;
	let between = 0;

	if (autoMarginCount > 0 && free > 0) {
		// Handled per-child below.
	} else {
		const count = line.items.length;
		switch (node.style.justifyContent) {
			case "center":
				leading = free / 2;
				break;
			case "flex-end":
				leading = free;
				break;
			case "space-between":
				if (count > 1) {
					between = Math.max(free, 0) / (count - 1);
				}
				break;
			case "space-around":
				if (count > 0) {
					between = Math.max(free, 0) / count;
					leading = between / 2;
				}
				break;
			case "space-evenly":
				if (count > 0) {
					between = Math.max(free, 0) / (count + 1);
					leading = between;
				}
				break;
			default:
				leading = 0;
		}
	}

	const autoShare =
		autoMarginCount > 0 && free > 0 ? free / autoMarginCount : 0;

	let cursor = leadingPaddingBorderMain + leading;
	for (const child of line.items) {
		const leadingAuto =
			child.style.margin[getLeadingEdge(mainAxis)].unit === "auto";
		const trailingAuto =
			child.style.margin[getTrailingEdge(mainAxis)].unit === "auto";

		if (leadingAuto) {
			cursor += autoShare;
		}

		cursor += resolveMargin(
			child.style.margin[getLeadingEdge(mainAxis)],
			ownerWidth,
		);

		if (performLayout) {
			if (mainIsRow) {
				child.layout.left = cursor;
			} else {
				child.layout.top = cursor;
			}
		}

		cursor += mainIsRow ? child.layout.width : child.layout.height;
		cursor += resolveMargin(
			child.style.margin[getTrailingEdge(mainAxis)],
			ownerWidth,
		);

		if (trailingAuto) {
			cursor += autoShare;
		}
		cursor += between;
		cursor += mainGap;
	}

	line.mainDim = contentMain + mainGap * Math.max(0, line.items.length - 1);
}

function positionCrossAxis(
	node: LayoutNode,
	lines: FlexLine[],
	containerInnerCross: number,
	totalCrossDim: number,
	leadingPaddingBorderCross: number,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const mainAxis = node.style.flexDirection;
	const cross = getCrossAxis(mainAxis);
	const crossIsRow = isRow(cross);
	const crossGap = getAxisGap(node, cross);

	const freeCross = isDefined(containerInnerCross)
		? containerInnerCross - totalCrossDim
		: 0;

	let lineLeading = 0;
	let lineBetween = 0;
	const lineCount = lines.length;

	switch (node.style.alignContent) {
		case "flex-end":
			lineLeading = freeCross;
			break;
		case "center":
			lineLeading = freeCross / 2;
			break;
		case "space-between":
			if (lineCount > 1) {
				lineBetween = Math.max(freeCross, 0) / (lineCount - 1);
			}
			break;
		case "space-around":
			if (lineCount > 0) {
				lineBetween = Math.max(freeCross, 0) / lineCount;
				lineLeading = lineBetween / 2;
			}
			break;
		case "space-evenly":
			if (lineCount > 0) {
				lineBetween = Math.max(freeCross, 0) / (lineCount + 1);
				lineLeading = lineBetween;
			}
			break;
		case "stretch":
			break;
		default:
			lineLeading = 0;
	}

	const stretchPerLine =
		node.style.alignContent === "stretch" && lineCount > 0 && freeCross > 0
			? freeCross / lineCount
			: 0;

	let cursor = leadingPaddingBorderCross + lineLeading;

	for (const line of lines) {
		const lineCross = line.crossDim + stretchPerLine;

		// The furthest baseline goes flush and the rest are pushed down to it.
		// Row containers only. A column's cross axis is horizontal, and
		// baseline degenerates to flex-start.
		let maxBaseline = 0;
		const lineHasBaseline =
			!crossIsRow &&
			line.items.some((child) => getAlignSelf(node, child) === "baseline");
		if (lineHasBaseline) {
			for (const child of line.items) {
				if (getAlignSelf(node, child) !== "baseline") {
					continue;
				}
				const childBaseline =
					resolveMargin(child.style.margin[getLeadingEdge(cross)], ownerWidth) +
					getBaselineWithinBorderBox(child, ownerWidth);
				maxBaseline = Math.max(maxBaseline, childBaseline);
			}
		}

		for (const child of line.items) {
			const align = getAlignSelf(node, child);
			const leadingMargin = resolveMargin(
				child.style.margin[getLeadingEdge(cross)],
				ownerWidth,
			);
			const trailingMargin = resolveMargin(
				child.style.margin[getTrailingEdge(cross)],
				ownerWidth,
			);

			const leadingAuto =
				child.style.margin[getLeadingEdge(cross)].unit === "auto";
			const trailingAuto =
				child.style.margin[getTrailingEdge(cross)].unit === "auto";

			// Auto margins opt out of stretching. They absorb the space
			// instead.
			const crossDimDefined = isStyleDimensionDefined(
				child,
				cross,
				crossIsRow ? ownerWidth : ownerHeight,
			);
			if (
				align === "stretch" && !crossDimDefined && !leadingAuto && !trailingAuto
			) {
				const targetCross = lineCross - leadingMargin - trailingMargin;
				const currentCross = crossIsRow
					? child.layout.width
					: child.layout.height;
				if (!approximatelyEqual(currentCross, targetCross)) {
					stretchFlexItem(node, child, targetCross, ownerWidth, ownerHeight);
				}
			}

			const childCross = crossIsRow ? child.layout.width : child.layout.height;
			const availableCross =
				lineCross - childCross - leadingMargin - trailingMargin;

			let offset: number;
			if (leadingAuto && trailingAuto) {
				offset = Math.max(availableCross, 0) / 2;
			} else if (trailingAuto) {
				offset = 0;
			} else if (leadingAuto) {
				offset = Math.max(availableCross, 0);
			} else {
				switch (align) {
					case "center":
						offset = availableCross / 2;
						break;
					case "flex-end":
						offset = availableCross;
						break;
					case "baseline":
						if (crossIsRow) {
							offset = 0;
						} else {
							const childBaseline =
								leadingMargin + getBaselineWithinBorderBox(child, ownerWidth);
							offset = maxBaseline - childBaseline;
						}
						break;
					default:
						offset = 0;
				}
			}

			const position = cursor + leadingMargin + offset;
			if (crossIsRow) {
				child.layout.left = position;
			} else {
				child.layout.top = position;
			}
		}

		cursor += lineCross + lineBetween + crossGap;
	}
}

// Positions are border-box relative but offset by the leading padding,
// so the mirror is taken in content-box coordinates and shifted back.
function mirrorWithinContentBox(
	lines: FlexLine[],
	axis: FlexDirection,
	innerSize: number,
	leadingPaddingBorder: number,
): void {
	const axisIsRow = isRow(axis);

	for (const line of lines) {
		for (const child of line.items) {
			const childSize = axisIsRow ? child.layout.width : child.layout.height;
			const start = axisIsRow ? child.layout.left : child.layout.top;

			const relative = start - leadingPaddingBorder;
			const mirrored = innerSize - relative - childSize;
			const position = leadingPaddingBorder + mirrored;

			if (axisIsRow) {
				child.layout.left = position;
			} else {
				child.layout.top = position;
			}
		}
	}
}

// CSS 2 §10.3.7: an axis with no inset takes the static position.
function layoutAbsoluteChild(
	node: LayoutNode,
	child: LayoutNode,
	ownerWidth: number,
	ownerHeight: number,
	area: {
		left: number;
		top: number;
		width: number;
		height: number;
	} | null = null,
): void {
	const parentWidth = node.layout.width;
	const parentHeight = node.layout.height;

	const borderLeft = node.style.border.left;
	const borderTop = node.style.border.top;
	const borderRight = node.style.border.right;
	const borderBottom = node.style.border.bottom;

	// The parent's padding box, or the grid area a placed child was given
	// (css-grid-2 §9.2).
	const blockLeft = area ? area.left : borderLeft;
	const blockTop = area ? area.top : borderTop;
	const blockWidth = area ? area.width : parentWidth - borderLeft - borderRight;
	const blockHeight = area
		? area.height
		: parentHeight - borderTop - borderBottom;
	const basisWidth = area ? area.width : parentWidth;
	const basisHeight = area ? area.height : parentHeight;

	const left = resolveValue(child.style.position.left, basisWidth);
	const top = resolveValue(child.style.position.top, basisHeight);
	const right = resolveValue(child.style.position.right, basisWidth);
	const bottom = resolveValue(child.style.position.bottom, basisHeight);

	const marginLeft = resolveMargin(child.style.margin.left, basisWidth);
	const marginTop = resolveMargin(child.style.margin.top, basisWidth);
	const marginRight = resolveMargin(child.style.margin.right, basisWidth);
	const marginBottom = resolveMargin(child.style.margin.bottom, basisWidth);

	// Auto margins between two insets center the box in the space they
	// leave rather than stretch it. That is what centers a modal dialog.
	const autoLeft = child.style.margin.left.unit === "auto";
	const autoRight = child.style.margin.right.unit === "auto";
	const autoTop = child.style.margin.top.unit === "auto";
	const autoBottom = child.style.margin.bottom.unit === "auto";
	const shrinkAcross =
		isDefined(left) && isDefined(right) && autoLeft && autoRight;
	const shrinkDown =
		isDefined(top) && isDefined(bottom) && autoTop && autoBottom;

	const childWidth = {value: NaN, mode: "indefinite" as AvailableSpace};
	const childHeight = {value: NaN, mode: "indefinite" as AvailableSpace};

	if (isStyleDimensionDefined(child, "row", basisWidth)) {
		childWidth.value =
			resolveValue(child.style.width, basisWidth) + marginLeft + marginRight;
		childWidth.mode = "definite";
	} else if (shrinkAcross) {
		childWidth.value = blockWidth - left - right;
		childWidth.mode = "shrink-to-fit";
	} else if (isDefined(left) && isDefined(right)) {
		childWidth.value = blockWidth - left - right - marginLeft - marginRight;
		childWidth.mode = "definite";
	} else if (isDefined(blockWidth)) {
		childWidth.value = blockWidth;
		// `stretch` fills the alignment container when size and both insets are
		// auto (css-align-3 §5.2). Only a grid area has one.
		childWidth.mode =
			area && getGridSelfAlign(node, child, true) === "stretch"
				? "definite"
				: "shrink-to-fit";
	}

	if (isStyleDimensionDefined(child, "column", basisHeight)) {
		childHeight.value =
			resolveValue(child.style.height, basisHeight) + marginTop + marginBottom;
		childHeight.mode = "definite";
	} else if (shrinkDown) {
		childHeight.value = blockHeight - top - bottom;
		childHeight.mode = "shrink-to-fit";
	} else if (isDefined(top) && isDefined(bottom)) {
		childHeight.value = blockHeight - top - bottom - marginTop - marginBottom;
		childHeight.mode = "definite";
	} else if (isDefined(blockHeight)) {
		childHeight.value = blockHeight;
		childHeight.mode =
			area && getGridSelfAlign(node, child, false) === "stretch"
				? "definite"
				: "shrink-to-fit";
	}

	layoutNode(
		child,
		childWidth.value,
		childHeight.value,
		childWidth.mode,
		childHeight.mode,
		ownerWidth,
		ownerHeight,
		true,
	);

	const getStaticPosition =
		(!isDefined(left) && !isDefined(right)) ||
		(!isDefined(top) && !isDefined(bottom))
			? (child.staticPosition?.(node) ?? null)
			: null;

	const isGrid = node.style.displayType === "grid";

	if (shrinkAcross) {
		const free = blockWidth - left - right - child.layout.width;
		child.layout.left = blockLeft + left + Math.max(free, 0) / 2;
	} else if (isDefined(left)) {
		child.layout.left = blockLeft + left + marginLeft;
	} else if (isDefined(right)) {
		child.layout.left =
			blockLeft + blockWidth - child.layout.width - right - marginRight;
	} else if (getStaticPosition) {
		child.layout.left = getStaticPosition.left + marginLeft;
	} else {
		const free = blockWidth - child.layout.width;
		// A grid aligns an out-of-flow box by its own justify-self.
		const align = isGrid
			? getGridSelfAlign(node, child, true)
			: isRow(node.style.flexDirection)
				? node.style.justifyContent === "center"
					? "center"
					: node.style.justifyContent === "flex-end" ? "flex-end" : "flex-start"
				: "flex-start";
		if (align === "center") {
			child.layout.left = blockLeft + free / 2;
		} else if (align === "flex-end") {
			child.layout.left = blockLeft + free;
		} else {
			child.layout.left = blockLeft + marginLeft;
		}
	}

	if (shrinkDown) {
		const free = blockHeight - top - bottom - child.layout.height;
		child.layout.top = blockTop + top + Math.max(free, 0) / 2;
	} else if (isDefined(top)) {
		child.layout.top = blockTop + top + marginTop;
	} else if (isDefined(bottom)) {
		child.layout.top =
			blockTop + blockHeight - child.layout.height - bottom - marginBottom;
	} else if (getStaticPosition) {
		child.layout.top = getStaticPosition.top + marginTop;
	} else {
		const free = blockHeight - child.layout.height;
		const align = isGrid
			? getGridSelfAlign(node, child, false)
			: isColumn(node.style.flexDirection)
				? node.style.alignItems === "center"
					? "center"
					: node.style.alignItems === "flex-end" ? "flex-end" : "flex-start"
				: "flex-start";
		if (align === "center") {
			child.layout.top = blockTop + free / 2;
		} else if (align === "flex-end") {
			child.layout.top = blockTop + free;
		} else {
			child.layout.top = blockTop + marginTop;
		}
	}

	// Placed in the containing block's space, but read relative to the
	// parent, which is rarely the containing block, so subtract the boxes
	// between.
	if (child.parent !== node) {
		let offsetLeft = 0;
		let offsetTop = 0;
		for (
			let between: LayoutNode | null = child.parent;
			between !== null && between !== node;
			between = between.parent
		) {
			offsetLeft += between.layout.left;
			offsetTop += between.layout.top;
		}
		child.layout.left -= offsetLeft;
		child.layout.top -= offsetTop;
	}
}

function zeroLayout(node: LayoutNode): void {
	node.layout.left = 0;
	node.layout.top = 0;
	node.layout.width = 0;
	node.layout.height = 0;
	node.layout.computedFlexBasis = 0;
	node.layout.collapseTopPositive = 0;
	node.layout.collapseTopNegative = 0;
	node.layout.collapseBottomPositive = 0;
	node.layout.collapseBottomNegative = 0;
	node.layout.selfCollapsing = false;
	for (const child of node.children) {
		zeroLayout(child);
	}
}

interface TableCell {
	node: LayoutNode;
	row: number;
	column: number;
	colSpan: number;
	rowSpan: number;
	minWidth: number;
	maxWidth: number;
}

interface TableRow {
	node: LayoutNode;
	group: LayoutNode | null;
}

// Visual order: header groups first and footer groups last, wherever they
// were written.
function collectTableRows(table: LayoutNode): {
	rows: TableRow[];
	captions: LayoutNode[];
	groups: LayoutNode[];
} {
	const captions: LayoutNode[] = [];
	const groups: LayoutNode[] = [];
	const header: TableRow[] = [];
	const body: TableRow[] = [];
	const footer: TableRow[] = [];

	const collectGroup = (group: LayoutNode, into: TableRow[]) => {
		groups.push(group);
		for (const child of group.children) {
			if (child.style.displayType === "table-row") {
				into.push({node: child, group});
			} else {
				zeroLayout(child);
			}
		}
	};

	for (const child of table.children) {
		if (
			child.style.displayType === "none" ||
			isOutOfFlowType(child.style.positionType)
		) {
			zeroLayout(child);
			continue;
		}

		switch (child.style.displayType) {
			case "table-caption":
				captions.push(child);
				break;
			case "table-header-group":
				collectGroup(child, header);
				break;
			case "table-footer-group":
				collectGroup(child, footer);
				break;
			case "table-row-group":
				collectGroup(child, body);
				break;
			case "table-row":
				body.push({node: child, group: null});
				break;
			default:
				zeroLayout(child);
				break;
		}
	}

	return {rows: [...header, ...body, ...footer], captions, groups};
}

// A rowspan reserves its slots in the rows below.
function buildTableGrid(rows: TableRow[]): {
	cells: TableCell[];
	columnCount: number;
} {
	const cells: TableCell[] = [];
	const occupied = new Set<string>();
	let columnCount = 0;

	rows.forEach((row, rowIndex) => {
		let column = 0;

		for (const node of row.node.children) {
			if (node.style.displayType !== "table-cell") {
				zeroLayout(node);
				continue;
			}

			while (occupied.has(`${rowIndex}:${column}`)) {
				column++;
			}

			const colSpan = Math.max(1, node.style.colSpan);
			const rowSpan = Math.max(1, node.style.rowSpan);

			for (let dr = 0; dr < rowSpan; dr++) {
				for (let dc = 0; dc < colSpan; dc++) {
					occupied.add(`${rowIndex + dr}:${column + dc}`);
				}
			}

			cells.push({
				node,
				row: rowIndex,
				column,
				colSpan,
				rowSpan,
				minWidth: 0,
				maxWidth: 0,
			});

			column += colSpan;
			columnCount = Math.max(columnCount, column);
		}
	});

	return {cells, columnCount};
}

function getIntrinsicCellWidth(
	cell: LayoutNode,
	minContent: boolean,
	ownerWidth: number,
	ownerHeight: number,
): number {
	layoutNode(
		cell,
		minContent ? 0 : NaN,
		NaN,
		minContent ? "shrink-to-fit" : "indefinite",
		"indefinite",
		ownerWidth,
		ownerHeight,
		false,
	);
	return cell.layout.width;
}

function distributeAcross(
	widths: number[],
	from: number,
	count: number,
	extra: number,
): void {
	if (extra <= 0) {
		return;
	}
	const share = extra / count;
	for (let i = 0; i < count; i++) {
		widths[from + i] += share;
	}
}

// CSS 2.1 §17.5.2.2. `available` already includes the cells collapsed
// borders overlap away.
function resolveColumnWidths(
	cells: TableCell[],
	columnCount: number,
	available: number,
	widthIsDefinite: boolean,
	ownerWidth: number,
	ownerHeight: number,
): number[] {
	const mins = new Array<number>(columnCount).fill(0);
	const maxs = new Array<number>(columnCount).fill(0);
	// Surplus goes to the auto columns. Otherwise `<td style="width:8ch">`
	// is inflated by the slack it was meant to give away.
	const fixed = new Array<boolean>(columnCount).fill(false);

	for (const cell of cells) {
		const styleWidth = resolveValue(cell.node.style.width, ownerWidth);
		if (isDefined(styleWidth)) {
			cell.minWidth = styleWidth;
			cell.maxWidth = styleWidth;
			if (cell.colSpan === 1) {
				fixed[cell.column] = true;
			}
		} else {
			cell.minWidth = getIntrinsicCellWidth(
				cell.node,
				true,
				ownerWidth,
				ownerHeight,
			);
			cell.maxWidth = getIntrinsicCellWidth(
				cell.node,
				false,
				ownerWidth,
				ownerHeight,
			);
		}

		if (cell.colSpan === 1) {
			mins[cell.column] = Math.max(mins[cell.column], cell.minWidth);
			maxs[cell.column] = Math.max(maxs[cell.column], cell.maxWidth);
		}
	}

	// A spanning cell widens its columns only by what it needs beyond them.
	for (const cell of cells) {
		if (cell.colSpan === 1) {
			continue;
		}

		let spanMin = 0;
		let spanMax = 0;
		for (let i = 0; i < cell.colSpan; i++) {
			spanMin += mins[cell.column + i];
			spanMax += maxs[cell.column + i];
		}

		distributeAcross(mins, cell.column, cell.colSpan, cell.minWidth - spanMin);
		distributeAcross(maxs, cell.column, cell.colSpan, cell.maxWidth - spanMax);
	}

	for (let i = 0; i < columnCount; i++) {
		maxs[i] = Math.max(maxs[i], mins[i]);
	}

	const totalMin = mins.reduce((sum, w) => sum + w, 0);
	const totalMax = maxs.reduce((sum, w) => sum + w, 0);

	// An indefinite width shrink-wraps, as `<table>` does in a browser.
	const target = widthIsDefinite
		? available
		: Math.min(
			Math.max(totalMin, isDefined(available) ? available : totalMax),
			totalMax,
		);

	const widths = new Array<number>(columnCount).fill(0);

	if (columnCount === 0) {
		return widths;
	}

	if (target >= totalMax) {
		// Before the cannot-fit case. With totalMin === totalMax that case
		// would give the surplus to the fixed columns too.
		for (let i = 0; i < columnCount; i++) {
			widths[i] = maxs[i];
		}

		const extra = target - totalMax;
		const autoColumns: number[] = [];
		for (let i = 0; i < columnCount; i++) {
			if (!fixed[i]) {
				autoColumns.push(i);
			}
		}

		// Every column is fixed. Spread it anyway rather than come up short.
		const receivers =
			autoColumns.length > 0
				? autoColumns
				: Array.from({length: columnCount}, (_, i) => i);

		let weight = 0;
		for (const i of receivers) {
			weight += maxs[i];
		}

		for (const i of receivers) {
			widths[i] +=
				weight > 0 ? (extra * maxs[i]) / weight : extra / receivers.length;
		}
	} else if (target <= totalMin) {
		// The table overflows rather than let a word paint over the next cell.
		for (let i = 0; i < columnCount; i++) {
			widths[i] = mins[i];
		}
	} else {
		const ratio = (target - totalMin) / (totalMax - totalMin);
		for (let i = 0; i < columnCount; i++) {
			widths[i] = mins[i] + (maxs[i] - mins[i]) * ratio;
		}
	}

	// Rounded at the column EDGES, so the columns tile the table exactly.
	const snapped = new Array<number>(columnCount).fill(0);
	let edge = 0;
	for (let i = 0; i < columnCount; i++) {
		const next = edge + widths[i];
		snapped[i] = Math.round(next) - Math.round(edge);
		edge = next;
	}

	return snapped;
}

// CSS 2.1 §17: a column's width is decided by every cell in it, across
// rows, which a flex row per <tr> cannot express.
function layoutTable(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(node, "row", ownerWidth);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);

	const leftPaddingBorder = getEdgePaddingAndBorder(node, "left", ownerWidth);
	const topPaddingBorder = getEdgePaddingAndBorder(node, "top", ownerWidth);

	const {rows, captions, groups} = collectTableRows(node);
	const {cells, columnCount} = buildTableGrid(rows);

	// Collapsed borders share the one cell both neighbours draw a border in.
	const overlap = node.style.borderCollapse ? 1 : 0;
	const columnOverlap = overlap * Math.max(0, columnCount - 1);

	const innerWidth = isDefined(availableWidth)
		? Math.max(0, availableWidth - marginRow - paddingBorderRow)
		: NaN;

	const widthIsDefinite = widthSpace === "definite" && isDefined(innerWidth);

	const columnWidths = resolveColumnWidths(
		cells,
		columnCount,
		isDefined(innerWidth) ? innerWidth + columnOverlap : NaN,
		widthIsDefinite,
		ownerWidth,
		ownerHeight,
	);

	const columnEdges = new Array<number>(columnCount + 1).fill(0);
	for (let i = 0; i < columnCount; i++) {
		columnEdges[i + 1] = columnEdges[i] + columnWidths[i];
	}

	const columnStart = (index: number) => columnEdges[index] - overlap * index;
	const spanWidth = (index: number, span: number) =>
		columnEdges[index + span] - columnEdges[index] - overlap * (span - 1);

	const contentWidth = Math.max(0, columnEdges[columnCount] - columnOverlap);

	// A caption sits above the grid, as wide as it.
	let captionHeight = 0;
	for (const caption of captions) {
		layoutNode(
			caption,
			contentWidth,
			NaN,
			"definite",
			"indefinite",
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		caption.layout.left = leftPaddingBorder;
		caption.layout.top = topPaddingBorder + captionHeight;
		captionHeight += caption.layout.height;
	}

	const rowHeights = new Array<number>(rows.length).fill(0);

	for (const cell of cells) {
		const width = spanWidth(cell.column, cell.colSpan);
		layoutNode(
			cell.node,
			width,
			NaN,
			"definite",
			"indefinite",
			ownerWidth,
			ownerHeight,
			performLayout,
		);

		if (cell.rowSpan === 1) {
			rowHeights[cell.row] = Math.max(
				rowHeights[cell.row],
				cell.node.layout.height,
			);
		}
	}

	for (const cell of cells) {
		if (cell.rowSpan === 1) {
			continue;
		}

		let covered = -overlap * (cell.rowSpan - 1);
		for (let i = 0; i < cell.rowSpan && cell.row + i < rows.length; i++) {
			covered += rowHeights[cell.row + i];
		}

		const deficit = cell.node.layout.height - covered;
		if (deficit > 0) {
			const last = Math.min(cell.row + cell.rowSpan - 1, rows.length - 1);
			rowHeights[last] += deficit;
		}
	}

	// A zero-height row (an empty <tr>) shares no border, so it must not
	// consume an overlap, or every later row would move up one.
	const rowTops = new Array<number>(rows.length).fill(0);
	let cursor = 0;
	let previousVisible = false;

	for (let i = 0; i < rows.length; i++) {
		if (rowHeights[i] <= 0) {
			rowTops[i] = cursor;
			continue;
		}
		if (previousVisible) {
			cursor -= overlap;
		}
		rowTops[i] = cursor;
		cursor += rowHeights[i];
		previousVisible = true;
	}

	const rowStart = (index: number) => rowTops[index];
	const spanHeight = (index: number, span: number) => {
		const last = Math.min(index + span, rows.length) - 1;
		return rowTops[last] + rowHeights[last] - rowTops[index];
	};

	const gridHeight = Math.max(0, cursor);
	const contentHeight = captionHeight + gridHeight;

	const width =
		widthSpace === "definite"
			? availableWidth - marginRow
			: contentWidth + paddingBorderRow;
	const height =
		heightSpace === "definite"
			? availableHeight - marginColumn
			: contentHeight + paddingBorderColumn;

	setMeasuredSize(node, width, height, ownerWidth, ownerHeight);

	if (!performLayout) {
		return;
	}

	// Positions are parent-relative: a cell within its row, a row within
	// its group.
	const gridTop = topPaddingBorder + captionHeight;

	for (const group of groups) {
		group.layout.left = leftPaddingBorder;
		group.layout.width = contentWidth;
		group.layout.top = gridTop;
		group.layout.height = gridHeight;
	}

	rows.forEach((row, index) => {
		row.node.layout.left = row.group ? 0 : leftPaddingBorder;
		row.node.layout.top = row.group
			? rowStart(index)
			: gridTop + rowStart(index);
		row.node.layout.width = contentWidth;
		row.node.layout.height = rowHeights[index];
	});

	for (const cell of cells) {
		const cellWidth = spanWidth(cell.column, cell.colSpan);
		const cellHeight = spanHeight(cell.row, cell.rowSpan);

		// The last measure of the cell's text is the one whose line breaks
		// paint.
		layoutNode(
			cell.node,
			cellWidth,
			cellHeight,
			"definite",
			"definite",
			ownerWidth,
			ownerHeight,
			true,
		);

		cell.node.layout.left = columnStart(cell.column);
		cell.node.layout.top = 0;
	}
}

// css-grid-2 §12.2.
interface GridTrack {
	size: TrackSize;
	base: number;

	// Infinity until §12.5 gives an intrinsic or flexible track one.
	growthLimit: number;

	// Infinity without fit-content().
	fitContentLimit: number;

	// §12.5.1: the limit was set from a content contribution one step ago,
	// so the next distribution grows past it.
	infinitelyGrowable: boolean;

	// Scratch for one distribution pass.
	planned: number;
	position: number;

	// An auto-fit track no item took.
	collapsed: boolean;
}

interface GridItem {
	node: LayoutNode;

	// As authored. A null start is still to be auto-placed.
	column: {start: number | null; span: number};
	row: {start: number | null; span: number};

	// Track indices once the implicit grid is normalized to start at 0.
	columnStart: number;
	columnEnd: number;
	rowStart: number;
	rowEnd: number;
}

function trackLength(breadth: TrackBreadth, ownerSize: number): number {
	if (breadth.kind !== "length") {
		return NaN;
	}
	return resolveValue(breadth.value, ownerSize);
}

// A percentage against an indefinite size behaves as auto (css-grid-2 §7.2.1).
function isIntrinsicBreadth(breadth: TrackBreadth, ownerSize: number): boolean {
	return breadth.kind !== "flex" && !isDefined(trackLength(breadth, ownerSize));
}

// For counting repeat(auto-fill) repetitions.
function getDefiniteTrackSize(size: TrackSize, ownerSize: number): number {
	const max = trackLength(size.max, ownerSize);
	if (isDefined(max)) {
		return Math.max(0, max);
	}
	const min = trackLength(size.min, ownerSize);
	return isDefined(min) ? Math.max(0, min) : 0;
}

function createTrack(size: TrackSize, ownerSize: number): GridTrack {
	const min = trackLength(size.min, ownerSize);
	const max = trackLength(size.max, ownerSize);
	const base = isDefined(min) ? Math.max(0, min) : 0;
	const limit = isDefined(max) ? Math.max(0, max) : Infinity;
	let fitContentLimit = Infinity;
	if (size.fitContent) {
		const clamp = resolveValue(size.fitContent, ownerSize);
		if (isDefined(clamp)) {
			fitContentLimit = Math.max(0, clamp);
		}
	}
	return {
		size,
		base,
		growthLimit: Math.max(limit, base),
		fitContentLimit,
		infinitelyGrowable: false,
		planned: 0,
		position: 0,
		collapsed: false,
	};
}

interface ExpandedTracks {
	sizes: TrackSize[];

	// Line i, for i in [0, sizes.length].
	lineNames: string[][];
	autoFit: {start: number; count: number} | null;
}

// css-grid-2 §7.2.3.2: an auto-fill/auto-fit repeat with no definite
// space repeats once.
function expandTrackList(
	list: TrackList,
	availableSpace: number,
	gap: number,
	ownerSize: number,
): ExpandedTracks {
	const sizes: TrackSize[] = [];
	const lineNames: string[][] = [];
	let autoFit: ExpandedTracks["autoFit"] = null;

	const autoPart = list.parts.find(
		(part) => part.type === "repeat" && typeof part.repeat.count !== "number",
	);

	let repetitions = 1;
	if (autoPart && autoPart.type === "repeat") {
		let fixedSum = 0;
		let fixedCount = 0;
		for (const part of list.parts) {
			if (part === autoPart) {
				continue;
			}
			if (part.type === "track") {
				fixedSum += getDefiniteTrackSize(part.track.size, ownerSize);
				fixedCount++;
				continue;
			}
			const count =
				typeof part.repeat.count === "number" ? part.repeat.count : 1;
			for (const track of part.repeat.tracks) {
				fixedSum += count * getDefiniteTrackSize(track.size, ownerSize);
				fixedCount += count;
			}
		}
		let repeatSum = 0;
		for (const track of autoPart.repeat.tracks) {
			repeatSum += getDefiniteTrackSize(track.size, ownerSize);
		}
		const perRepetition = repeatSum + autoPart.repeat.tracks.length * gap;
		if (isDefined(availableSpace) && perRepetition > 0) {
			// n repetitions and the fixed tracks together take
			//   fixedSum + n*repeatSum + (fixedCount + n*repeatTracks - 1)*gap
			// which must not exceed the space; solved for n.
			const room = availableSpace - fixedSum - fixedCount * gap + gap;
			repetitions = Math.max(1, Math.floor(room / perRepetition));
		}
	}

	let pending: string[] = [];
	const emit = (track: TrackListTrack) => {
		lineNames.push(pending.concat(track.names));
		pending = [];
		sizes.push(track.size);
	};

	for (const part of list.parts) {
		if (part.type === "track") {
			emit(part.track);
			continue;
		}
		const repeat = part.repeat;
		const count = typeof repeat.count === "number" ? repeat.count : repetitions;
		const start = sizes.length;
		for (let i = 0; i < count; i++) {
			for (const track of repeat.tracks) {
				emit(track);
			}
			pending = pending.concat(repeat.endNames);
		}
		if (repeat.count === "auto-fit") {
			autoFit = {start, count: sizes.length - start};
		}
	}
	lineNames.push(pending.concat(list.endNames));

	return {sizes, lineNames, autoFit};
}

// An area `foo` names its edges foo-start and foo-end on both axes
// (css-grid-2 §7.3).
function getAreaLineNames(areas: GridAreaMap): {
	columns: Map<string, number[]>;
	rows: Map<string, number[]>;
} {
	const columns = new Map<string, number[]>();
	const rows = new Map<string, number[]>();
	const bounds = new Map<
		string,
		{top: number; left: number; bottom: number; right: number}
	>();

	areas.rows.forEach((row, rowIndex) => {
		row.forEach((name, columnIndex) => {
			if (name === null) {
				return;
			}
			const found = bounds.get(name);
			if (!found) {
				bounds.set(name, {
					top: rowIndex,
					left: columnIndex,
					bottom: rowIndex + 1,
					right: columnIndex + 1,
				});
				return;
			}
			found.top = Math.min(found.top, rowIndex);
			found.left = Math.min(found.left, columnIndex);
			found.bottom = Math.max(found.bottom, rowIndex + 1);
			found.right = Math.max(found.right, columnIndex + 1);
		});
	});

	for (const [name, box] of bounds) {
		addLineName(columns, `${name}-start`, box.left);
		addLineName(columns, `${name}-end`, box.right);
		addLineName(rows, `${name}-start`, box.top);
		addLineName(rows, `${name}-end`, box.bottom);
	}
	return {columns, rows};
}

function addLineName(
	into: Map<string, number[]>,
	name: string,
	line: number,
): void {
	const lines = into.get(name);
	if (!lines) {
		into.set(name, [line]);
		return;
	}
	if (!lines.includes(line)) {
		lines.push(line);
		lines.sort((a, b) => a - b);
	}
}

function collectLineNames(
	expanded: ExpandedTracks,
	fromAreas: Map<string, number[]>,
): Map<string, number[]> {
	const names = new Map<string, number[]>();
	expanded.lineNames.forEach((line, index) => {
		for (const name of line) {
			addLineName(names, name, index);
		}
	});
	for (const [name, lines] of fromAreas) {
		for (const line of lines) {
			addLineName(names, name, line);
		}
	}
	return names;
}

type ResolvedLine =
	{kind: "auto"} |
	{kind: "line"; index: number} |
	{kind: "span"; count: number} |
	{kind: "spanName"; name: string; count: number};

// Outside the explicit grid every implicit line matches the name
// (css-grid-2 §8.3), so a placement on a missing name stays definite.
function getNamedLine(
	names: Map<string, number[]>,
	name: string,
	index: number,
	explicitCount: number,
): number {
	const matches = names.get(name) ?? [];
	if (index > 0) {
		if (matches.length >= index) {
			return matches[index - 1];
		}
		return explicitCount + (index - matches.length);
	}
	const from = matches.length + index;
	if (from >= 0) {
		return matches[from];
	}
	return from;
}

function resolveGridLine(
	placement: GridPlacement,
	names: Map<string, number[]>,
	explicitCount: number,
	edge: "start" | "end",
): ResolvedLine {
	if (placement.span) {
		const count = Math.max(1, placement.index ?? 1);
		if (placement.name !== null) {
			return {kind: "spanName", name: placement.name, count};
		}
		return {kind: "span", count};
	}
	if (placement.name !== null) {
		// A bare name is tried first as an area's edge on the side it is
		// written on.
		if (placement.index === null) {
			const edgeName = `${placement.name}-${edge}`;
			if (names.has(edgeName)) {
				return {
					kind: "line",
					index: getNamedLine(names, edgeName, 1, explicitCount),
				};
			}
		}
		return {
			kind: "line",
			index: getNamedLine(
				names,
				placement.name,
				placement.index ?? 1,
				explicitCount,
			),
		};
	}
	if (placement.index === null) {
		return {kind: "auto"};
	}
	return {
		kind: "line",
		index:
			placement.index > 0
				? placement.index - 1
				: explicitCount + placement.index + 1,
	};
}

function getSpanName(
	names: Map<string, number[]>,
	name: string,
	count: number,
	from: number,
	forward: boolean,
): number {
	const matches = names.get(name) ?? [];
	const ordered = forward
		? matches.filter((line) => line > from)
		: matches.filter((line) => line < from).reverse();
	if (ordered.length >= count) {
		return ordered[count - 1];
	}
	const shortfall = count - ordered.length;
	const last = ordered.length > 0 ? ordered[ordered.length - 1] : from;
	return forward ? last + shortfall : last - shortfall;
}

// css-grid-2 §8.3. A null start is left for auto-placement, with its span.
function pairGridLines(
	startLine: ResolvedLine,
	endLine: ResolvedLine,
	names: Map<string, number[]>,
): {start: number | null; span: number} {
	const start = startLine;
	let end = endLine;

	const isSpan = (line: ResolvedLine) =>
		line.kind === "span" || line.kind === "spanName";

	// Two spans: the end one is dropped.
	if (isSpan(start) && isSpan(end)) {
		end = {kind: "auto"};
	}

	if (start.kind === "line" && end.kind === "line") {
		let first = start.index;
		let last = end.index;
		if (last < first) {
			const swap = first;
			first = last;
			last = swap;
		}
		if (last === first) {
			last = first + 1;
		}
		return {start: first, span: last - first};
	}

	if (start.kind === "line") {
		if (end.kind === "span") {
			return {start: start.index, span: end.count};
		}
		if (end.kind === "spanName") {
			const line = getSpanName(names, end.name, end.count, start.index, true);
			return {start: start.index, span: Math.max(1, line - start.index)};
		}
		return {start: start.index, span: 1};
	}

	if (end.kind === "line") {
		if (start.kind === "span") {
			return {start: end.index - start.count, span: start.count};
		}
		if (start.kind === "spanName") {
			const line = getSpanName(
				names,
				start.name,
				start.count,
				end.index,
				false,
			);
			return {start: line, span: Math.max(1, end.index - line)};
		}
		return {start: end.index - 1, span: 1};
	}

	const span =
		start.kind === "span" || start.kind === "spanName"
			? start.count
			: end.kind === "span" || end.kind === "spanName" ? end.count : 1;
	return {start: null, span: Math.max(1, span)};
}

// css-grid-2 §8.5, over a major and a minor axis so that grid-auto-flow:
// column is the same walk with the two swapped.
function autoPlaceItems(
	items: GridItem[],
	explicitColumns: number,
	explicitRows: number,
	flowColumn: boolean,
	dense: boolean,
): void {
	const major = (item: GridItem) => (flowColumn ? item.column : item.row);
	const minor = (item: GridItem) => (flowColumn ? item.row : item.column);
	const explicitMinor = flowColumn ? explicitRows : explicitColumns;

	let minorBase = 0;
	let majorBase = 0;
	for (const item of items) {
		const min = minor(item).start;
		const maj = major(item).start;
		if (min !== null) {
			minorBase = Math.min(minorBase, min);
		}
		if (maj !== null) {
			majorBase = Math.min(majorBase, maj);
		}
	}

	// §8.5 step 3. An auto minor position still widens the axis by its
	// span, or the item could never be placed.
	let minorEnd = minorBase + explicitMinor;
	for (const item of items) {
		const line = minor(item);
		if (line.start !== null) {
			minorEnd = Math.max(minorEnd, line.start + line.span);
		} else {
			minorEnd = Math.max(minorEnd, minorBase + line.span);
		}
	}

	const occupied = new Set<string>();
	const occupy = (item: GridItem) => {
		const maj = major(item);
		const min = minor(item);
		for (let a = 0; a < maj.span; a++) {
			for (let b = 0; b < min.span; b++) {
				occupied.add(`${maj.start! + a}:${min.start! + b}`);
			}
		}
	};
	const fits = (
		majorStart: number,
		majorSpan: number,
		minorStart: number,
		minorSpan: number,
	) => {
		for (let a = 0; a < majorSpan; a++) {
			for (let b = 0; b < minorSpan; b++) {
				if (occupied.has(`${majorStart + a}:${minorStart + b}`)) {
					return false;
				}
			}
		}
		return true;
	};

	// §8.5 step 1.
	for (const item of items) {
		if (major(item).start !== null && minor(item).start !== null) {
			occupy(item);
		}
	}

	// §8.5 step 2.
	const rowCursors = new Map<number, number>();
	for (const item of items) {
		const maj = major(item);
		const min = minor(item);
		if (maj.start === null || min.start !== null) {
			continue;
		}
		const from = dense ? minorBase : (rowCursors.get(maj.start) ?? minorBase);
		let position = from;
		while (!fits(maj.start, maj.span, position, min.span)) {
			position++;
		}
		min.start = position;
		if (!dense) {
			rowCursors.set(maj.start, position + min.span);
		}
		occupy(item);
		minorEnd = Math.max(minorEnd, position + min.span);
	}

	// §8.5 step 4.
	let cursorMajor = majorBase;
	let cursorMinor = minorBase;
	for (const item of items) {
		const maj = major(item);
		const min = minor(item);
		if (maj.start !== null) {
			continue;
		}
		if (dense) {
			cursorMajor = majorBase;
			cursorMinor = minorBase;
		}
		if (min.start !== null) {
			if (!dense && min.start < cursorMinor) {
				cursorMajor++;
			}
			if (!dense) {
				cursorMinor = min.start;
			}
			while (!fits(cursorMajor, maj.span, min.start, min.span)) {
				cursorMajor++;
			}
			maj.start = cursorMajor;
			occupy(item);
			continue;
		}
		// An item wider than the whole minor axis still gets a row of its own.
		const span = Math.min(min.span, Math.max(1, minorEnd - minorBase));
		for (;;) {
			if (cursorMinor + span > minorEnd) {
				cursorMajor++;
				cursorMinor = minorBase;
				continue;
			}
			if (fits(cursorMajor, maj.span, cursorMinor, min.span)) {
				break;
			}
			cursorMinor++;
		}
		maj.start = cursorMajor;
		min.start = cursorMinor;
		occupy(item);
		if (!dense) {
			cursorMinor += min.span;
		}
	}
}

interface TrackSizing {
	node: LayoutNode;
	tracks: GridTrack[];
	items: GridItem[];
	columns: boolean;

	// NaN when the container is indefinite.
	availableSpace: number;
	gap: number;
	ownerSize: number;
	ownerWidth: number;
	ownerHeight: number;

	// The row pass measures an item's height at the width its columns
	// resolved to.
	columnSizes: number[] | null;
	columnGap: number;
	stretchesAutoTracks: boolean;

	// How much a baseline-aligned item will be pushed down to meet its
	// row's furthest baseline (§12.5 step 1). Without it the row is sized a
	// cell short. Null on the column pass.
	baselineShims: Map<LayoutNode, number> | null;
}

function getItemTrackRange(sizing: TrackSizing, item: GridItem): [
	number,
	number,
] {
	return sizing.columns
		? [item.columnStart, item.columnEnd]
		: [item.rowStart, item.rowEnd];
}

function getTrackSpan(
	sizes: number[],
	gap: number,
	start: number,
	end: number,
): number {
	let total = 0;
	for (let i = start; i < end && i < sizes.length; i++) {
		total += sizes[i];
	}
	return total + gap * Math.max(0, end - start - 1);
}

function getGridItemContribution(
	sizing: TrackSizing,
	item: GridItem,
	minContent: boolean,
): number {
	const child = item.node;
	if (sizing.columns) {
		layoutNode(
			child,
			minContent ? 0 : NaN,
			NaN,
			minContent ? "shrink-to-fit" : "indefinite",
			"indefinite",
			sizing.ownerWidth,
			sizing.ownerHeight,
			false,
		);
		return (
			child.layout.width + getAxisMargin(child, "row", sizing.ownerWidth)
		);
	}
	const width = getTrackSpan(
		sizing.columnSizes!,
		sizing.columnGap,
		item.columnStart,
		item.columnEnd,
	);
	layoutNode(
		child,
		width,
		NaN,
		"definite",
		"indefinite",
		sizing.ownerWidth,
		sizing.ownerHeight,
		false,
	);
	return (
		child.layout.height +
		getAxisMargin(child, "column", sizing.ownerWidth) +
		(sizing.baselineShims?.get(child) ?? 0)
	);
}

// css-grid-2 §10.1, over this engine's baseline (getBaselineWithinBorderBox).
function measureBaselineShims(
	node: LayoutNode,
	items: GridItem[],
	columnSizes: number[],
	columnGap: number,
	ownerWidth: number,
	ownerHeight: number,
): Map<LayoutNode, number> {
	const shims = new Map<LayoutNode, number>();
	const rows = new Map<number, GridItem[]>();
	for (const item of items) {
		if (getGridSelfAlign(node, item.node, false) !== "baseline") {
			continue;
		}
		const group = rows.get(item.rowStart);
		if (group) {
			group.push(item);
		} else {
			rows.set(item.rowStart, [item]);
		}
	}

	for (const group of rows.values()) {
		if (group.length < 2) {
			continue;
		}
		const baselines = new Map<GridItem, number>();
		let furthest = 0;
		for (const item of group) {
			layoutNode(
				item.node,
				getTrackSpan(columnSizes, columnGap, item.columnStart, item.columnEnd),
				NaN,
				"definite",
				"indefinite",
				ownerWidth,
				ownerHeight,
				false,
			);
			const baseline =
				resolveMargin(item.node.style.margin.top, ownerWidth) +
				getBaselineWithinBorderBox(item.node, ownerWidth);
			baselines.set(item, baseline);
			furthest = Math.max(furthest, baseline);
		}
		for (const item of group) {
			shims.set(item.node, furthest - baselines.get(item)!);
		}
	}
	return shims;
}

// css-grid-2 §6.6: a fixed max on the one track the item sits in caps its
// min-content contribution.
function getMinimumContribution(
	sizing: TrackSizing,
	item: GridItem,
	start: number,
	end: number,
): number {
	const minContent = getGridItemContribution(sizing, item, true);
	if (end - start === 1) {
		const max = trackLength(sizing.tracks[start].size.max, sizing.ownerSize);
		if (isDefined(max)) {
			return Math.min(minContent, Math.max(0, max));
		}
	}
	return minContent;
}

const EPSILON = 0.0001;

// css-grid-2 §12.6.
function distributeExtraSpace(
	tracks: GridTrack[],
	indices: number[],
	space: number,
	toLimits: boolean,
	affected: (track: GridTrack) => boolean,
	beyondLimit: (track: GridTrack) => boolean,
): void {
	if (!(space > EPSILON)) {
		return;
	}
	const receivers = indices.filter((index) => affected(tracks[index]));
	if (receivers.length === 0) {
		return;
	}

	for (const index of receivers) {
		tracks[index].planned = 0;
	}

	const startOf = (track: GridTrack) =>
		toLimits
			? track.growthLimit === Infinity ? track.base : track.growthLimit
			: track.base;
	// A growth limit has nothing to grow toward unless it is infinitely
	// growable, and then only up to a fit-content() clamp (§12.5.1).
	const limitOf = (track: GridTrack) =>
		toLimits
			? Math.min(
				track.infinitelyGrowable ? Infinity : track.growthLimit,
				track.fitContentLimit,
			)
			: track.growthLimit;

	let remaining = space;
	const frozen = new Set<number>();
	while (remaining > EPSILON && frozen.size < receivers.length) {
		const open = receivers.filter((index) => !frozen.has(index));
		const share = remaining / open.length;
		let used = 0;
		for (const index of open) {
			const track = tracks[index];
			const limit = limitOf(track);
			const room =
				limit === Infinity
					? Infinity
					: Math.max(0, limit - startOf(track) - track.planned);
			const growth = Math.min(share, room);
			track.planned += growth;
			used += growth;
			if (growth < share - EPSILON) {
				frozen.add(index);
			}
		}
		remaining -= used;
		if (used <= EPSILON) {
			break;
		}
	}

	if (remaining > EPSILON) {
		const open = receivers.filter((index) => beyondLimit(tracks[index]));
		if (open.length > 0) {
			const share = remaining / open.length;
			for (const index of open) {
				tracks[index].planned += share;
			}
		}
	}

	for (const index of receivers) {
		const track = tracks[index];
		if (toLimits) {
			const from = startOf(track);
			track.growthLimit = Math.min(from + track.planned, track.fitContentLimit);
			if (track.growthLimit < track.base) {
				track.growthLimit = track.base;
			}
		} else {
			track.base += track.planned;
			if (track.growthLimit !== Infinity && track.growthLimit < track.base) {
				track.growthLimit = track.base;
			}
		}
		track.planned = 0;
	}
}

// css-grid-2 §12.5.
function resolveIntrinsicTrackSizes(sizing: TrackSizing): void {
	const {tracks, items, ownerSize} = sizing;

	const intrinsicMin = (track: GridTrack) =>
		isIntrinsicBreadth(track.size.min, ownerSize);
	const intrinsicMax = (track: GridTrack) =>
		isIntrinsicBreadth(track.size.max, ownerSize);
	const flexible = (track: GridTrack) => track.size.max.kind === "flex";

	const limits = new Array<number>(tracks.length).fill(-Infinity);
	for (const item of items) {
		const [start, end] = getItemTrackRange(sizing, item);
		if (end - start !== 1) {
			continue;
		}
		const track = tracks[start];
		if (track.collapsed) {
			continue;
		}
		if (!intrinsicMin(track) && !intrinsicMax(track)) {
			continue;
		}

		if (intrinsicMin(track)) {
			const kind = track.size.min.kind;
			const floor =
				kind === "min-content"
					? getGridItemContribution(sizing, item, true)
					: kind === "max-content"
						? getGridItemContribution(sizing, item, false)
						: getMinimumContribution(sizing, item, start, end);
			track.base = Math.max(track.base, floor);
		}
		if (intrinsicMax(track)) {
			const limit =
				track.size.max.kind === "min-content"
					? getGridItemContribution(sizing, item, true)
					: getGridItemContribution(sizing, item, false);
			limits[start] = Math.max(limits[start], limit);
		}
	}
	tracks.forEach((track, index) => {
		if (track.collapsed || !intrinsicMax(track)) {
			return;
		}
		if (limits[index] === -Infinity) {
			return;
		}
		track.growthLimit = Math.min(limits[index], track.fitContentLimit);
		if (track.growthLimit < track.base) {
			track.growthLimit = track.base;
		}
	});

	const spanning = items
		.filter((item) => {
			const [start, end] = getItemTrackRange(sizing, item);
			if (end - start < 2) {
				return false;
			}
			for (let i = start; i < end; i++) {
				if (flexible(tracks[i])) {
					return false;
				}
			}
			return true;
		})
		.sort((a, b) => {
			const [aStart, aEnd] = getItemTrackRange(sizing, a);
			const [bStart, bEnd] = getItemTrackRange(sizing, b);
			return aEnd - aStart - (bEnd - bStart);
		});

	for (const item of spanning) {
		const [start, end] = getItemTrackRange(sizing, item);
		const indices: number[] = [];
		for (let i = start; i < end; i++) {
			if (!tracks[i].collapsed) {
				indices.push(i);
			}
		}
		if (indices.length === 0) {
			continue;
		}
		const gaps = sizing.gap * Math.max(0, indices.length - 1);
		const baseSum = indices.reduce((sum, i) => sum + tracks[i].base, 0);
		// Re-summed per step. A sum taken before an earlier step grew a track
		// would count the same space twice.
		const limitSum = () =>
			indices.reduce(
				(sum, i) =>
					sum +
					(tracks[i].growthLimit === Infinity
						? tracks[i].base
						: tracks[i].growthLimit),
				0,
			);

		const minContent = getGridItemContribution(sizing, item, true);
		const maxContent = getGridItemContribution(sizing, item, false);
		const minimum = getMinimumContribution(sizing, item, start, end);

		// 1. intrinsic minimums
		distributeExtraSpace(
			tracks,
			indices,
			minimum - baseSum - gaps,
			false,
			intrinsicMin,
			intrinsicMax,
		);
		// 2. content-based minimums
		distributeExtraSpace(
			tracks,
			indices,
			minContent - indices.reduce((sum, i) => sum + tracks[i].base, 0) - gaps,
			false,
			(track) =>
				track.size.min.kind === "min-content" || track.size.min.kind === "auto",
			intrinsicMax,
		);
		// 3. max-content minimums
		distributeExtraSpace(
			tracks,
			indices,
			maxContent - indices.reduce((sum, i) => sum + tracks[i].base, 0) - gaps,
			false,
			(track) => track.size.min.kind === "max-content",
			intrinsicMax,
		);
		// 4. intrinsic maximums
		const wasInfinite = indices.map(
			(index) => tracks[index].growthLimit === Infinity,
		);
		distributeExtraSpace(
			tracks,
			indices,
			minContent - limitSum() - gaps,
			true,
			intrinsicMax,
			intrinsicMax,
		);
		// A limit this step made finite is the item's contribution, not the
		// author's size, so the next step may grow past it.
		indices.forEach((index, at) => {
			tracks[index].infinitelyGrowable =
				wasInfinite[at] && tracks[index].growthLimit !== Infinity;
		});
		// 5. max-content maximums, `auto` among them (css-grid-2 §7.2.3).
		const maxContentMax = (track: GridTrack) =>
			track.size.max.kind === "max-content" || track.size.max.kind === "auto";
		distributeExtraSpace(
			tracks,
			indices,
			maxContent - limitSum() - gaps,
			true,
			maxContentMax,
			maxContentMax,
		);
		for (const index of indices) {
			tracks[index].infinitelyGrowable = false;
		}
	}

	// Across a flexible track the share goes by flex factor, not equally.
	// §12.5.4 defers the rest to the fr resolution.
	for (const item of items) {
		const [start, end] = getItemTrackRange(sizing, item);
		if (end - start < 2) {
			continue;
		}
		let flexSum = 0;
		for (let i = start; i < end; i++) {
			if (flexible(tracks[i])) {
				flexSum += (tracks[i].size.max as {factor: number}).factor;
			}
		}
		if (flexSum <= 0) {
			continue;
		}
		const gaps = sizing.gap * Math.max(0, end - start - 1);
		let baseSum = 0;
		for (let i = start; i < end; i++) {
			baseSum += tracks[i].base;
		}
		const deficit = getGridItemContribution(sizing, item, true) -
			baseSum -
			gaps;
		if (deficit <= EPSILON) {
			continue;
		}
		for (let i = start; i < end; i++) {
			if (!flexible(tracks[i])) {
				continue;
			}
			const factor = (tracks[i].size.max as {factor: number}).factor;
			tracks[i].base += (deficit * factor) / flexSum;
		}
	}

	for (const track of tracks) {
		if (track.growthLimit === Infinity) {
			track.growthLimit = track.base;
		}
	}
}

// css-grid-2 §12.7.1: freeze every flexible track whose base exceeds its
// share, and divide again.
function findFrSize(
	tracks: GridTrack[],
	indices: number[],
	spaceToFill: number,
): number {
	const inflexible = new Set<number>();
	for (;;) {
		let leftover = spaceToFill;
		let factorSum = 0;
		for (const index of indices) {
			const track = tracks[index];
			if (track.size.max.kind !== "flex" || inflexible.has(index)) {
				leftover -= track.base;
			} else {
				factorSum += track.size.max.factor;
			}
		}
		// A total below 1 leaves space unclaimed. `0.5fr` takes half of `1fr`.
		const hypothetical = leftover / Math.max(1, factorSum);
		if (factorSum <= 0) {
			return 0;
		}

		let restart = false;
		for (const index of indices) {
			const track = tracks[index];
			if (track.size.max.kind !== "flex" || inflexible.has(index)) {
				continue;
			}
			if (track.base > hypothetical * track.size.max.factor + EPSILON) {
				inflexible.add(index);
				restart = true;
			}
		}
		if (!restart) {
			return Math.max(0, hypothetical);
		}
	}
}

// css-grid-2 §12.3.
function sizeTracks(sizing: TrackSizing): void {
	const {tracks, availableSpace, gap} = sizing;
	const live = tracks.filter((track) => !track.collapsed).length;
	const gaps = gap * Math.max(0, live - 1);

	resolveIntrinsicTrackSizes(sizing);

	// §12.6.
	if (isDefined(availableSpace)) {
		let used = gaps;
		for (const track of tracks) {
			used += track.base;
		}
		let free = availableSpace - used;
		if (free > EPSILON) {
			const open = tracks.filter(
				(track) => !track.collapsed && track.growthLimit > track.base + EPSILON,
			);
			const frozen = new Set<GridTrack>();
			while (free > EPSILON && frozen.size < open.length) {
				const growing = open.filter((track) => !frozen.has(track));
				const share = free / growing.length;
				let taken = 0;
				for (const track of growing) {
					const room = track.growthLimit - track.base;
					const growth = Math.min(share, room);
					track.base += growth;
					taken += growth;
					if (growth < share - EPSILON) {
						frozen.add(track);
					}
				}
				free -= taken;
				if (taken <= EPSILON) {
					break;
				}
			}
		}
	} else {
		for (const track of tracks) {
			if (track.growthLimit > track.base) {
				track.base = track.growthLimit;
			}
		}
	}

	// §12.7.
	const flexIndices: number[] = [];
	tracks.forEach((track, index) => {
		if (!track.collapsed && track.size.max.kind === "flex") {
			flexIndices.push(index);
		}
	});
	if (flexIndices.length > 0) {
		const all = tracks
			.map((_, index) => index)
			.filter((index) => !tracks[index].collapsed);
		let frSize: number;
		if (isDefined(availableSpace)) {
			frSize = findFrSize(tracks, all, availableSpace - gaps);
		} else {
			// §12.7.1, indefinite: the largest any one flexible track demands.
			frSize = 0;
			for (const index of flexIndices) {
				const factor = (tracks[index].size.max as {factor: number}).factor;
				frSize = Math.max(frSize, tracks[index].base / Math.max(factor, 1));
			}
			for (const item of sizing.items) {
				const [start, end] = getItemTrackRange(sizing, item);
				let spansFlex = false;
				for (let i = start; i < end; i++) {
					if (tracks[i].size.max.kind === "flex") {
						spansFlex = true;
					}
				}
				if (!spansFlex) {
					continue;
				}
				const indices: number[] = [];
				for (let i = start; i < end; i++) {
					if (!tracks[i].collapsed) {
						indices.push(i);
					}
				}
				const contribution = getGridItemContribution(sizing, item, false);
				frSize = Math.max(
					frSize,
					findFrSize(
						tracks,
						indices,
						contribution - gap * Math.max(0, indices.length - 1),
					),
				);
			}
		}
		for (const index of flexIndices) {
			const factor = (tracks[index].size.max as {factor: number}).factor;
			tracks[index].base = Math.max(tracks[index].base, frSize * factor);
		}
	}

	// §12.8.
	if (sizing.stretchesAutoTracks && isDefined(availableSpace)) {
		const stretchable = tracks.filter(
			(track) => !track.collapsed && track.size.max.kind === "auto",
		);
		if (stretchable.length > 0) {
			let used = gaps;
			for (const track of tracks) {
				used += track.base;
			}
			const free = availableSpace - used;
			if (free > EPSILON) {
				const share = free / stretchable.length;
				for (const track of stretchable) {
					track.base += share;
				}
			}
		}
	}
}

// `normal` and `stretch` give the free space to the tracks (css-align-3 §12.8).
type ContentAlign =
	"start" |
	"center" |
	"end" |
	"space-between" |
	"space-around" |
	"space-evenly" |
	"stretch";

function getInlineContentAlign(node: LayoutNode): ContentAlign {
	switch (node.style.justifyContent) {
		case "center":
			return "center";
		case "flex-end":
			return "end";
		case "space-between":
			return "space-between";
		case "space-around":
			return "space-around";
		case "space-evenly":
			return "space-evenly";
		case "normal":
		case "stretch":
			return "stretch";
		default:
			return "start";
	}
}

function getBlockContentAlign(node: LayoutNode): ContentAlign {
	switch (node.style.alignContent) {
		case "center":
			return "center";
		case "flex-end":
			return "end";
		case "space-between":
			return "space-between";
		case "space-around":
			return "space-around";
		case "space-evenly":
			return "space-evenly";
		case "normal":
		case "stretch":
			return "stretch";
		default:
			return "start";
	}
}

// `normal` on a grid item means stretch (css-align-3 §4.2).
function getGridSelfAlign(
	container: LayoutNode,
	item: LayoutNode,
	inline: boolean,
): Align {
	const own = inline ? item.style.justifySelf : item.style.alignSelf;
	const fallback = inline
		? container.style.justifyItems
		: container.style.alignItems;
	const value = own === "auto" ? fallback : own;
	return value === "auto" || value === "normal" ? "stretch" : value;
}

function positionTracks(
	tracks: GridTrack[],
	free: number,
	gap: number,
	align: ContentAlign,
): void {
	const count = tracks.filter((track) => !track.collapsed).length;
	let leading = 0;
	let between = 0;
	switch (align) {
		case "center":
			leading = free / 2;
			break;
		case "end":
			leading = free;
			break;
		case "space-between":
			if (count > 1) {
				between = Math.max(free, 0) / (count - 1);
			}
			break;
		case "space-around":
			if (count > 0) {
				between = Math.max(free, 0) / count;
				leading = between / 2;
			}
			break;
		case "space-evenly":
			if (count > 0) {
				between = Math.max(free, 0) / (count + 1);
				leading = between;
			}
			break;
		default:
			leading = 0;
	}

	let cursor = leading;
	for (const track of tracks) {
		track.position = cursor;
		if (track.collapsed) {
			continue;
		}
		cursor += track.base + gap + between;
	}
}

function layoutGridItem(
	node: LayoutNode,
	item: GridItem,
	areaLeft: number,
	areaTop: number,
	areaWidth: number,
	areaHeight: number,
	performLayout: boolean,
): void {
	// The area is the item's containing block (css-grid-2 §6.4).
	const ownerWidth = areaWidth;
	const ownerHeight = areaHeight;
	const child = item.node;
	const justify = getGridSelfAlign(node, child, true);
	const align = getGridSelfAlign(node, child, false);

	const autoLeft = child.style.margin.left.unit === "auto";
	const autoRight = child.style.margin.right.unit === "auto";
	const autoTop = child.style.margin.top.unit === "auto";
	const autoBottom = child.style.margin.bottom.unit === "auto";

	const marginRow = getAxisMargin(child, "row", ownerWidth);
	const marginColumn = getAxisMargin(child, "column", ownerWidth);

	const childWidth = {value: NaN, mode: "indefinite" as AvailableSpace};
	const childHeight = {value: NaN, mode: "indefinite" as AvailableSpace};

	if (isStyleDimensionDefined(child, "row", ownerWidth)) {
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				"row",
				resolveValue(child.style.width, ownerWidth),
				areaWidth,
			) + marginRow;
		childWidth.mode = "definite";
	} else if (justify === "stretch" && !autoLeft && !autoRight) {
		// The request includes the item's margins, which the box subtracts
		// itself.
		childWidth.value = Math.max(0, areaWidth);
		childWidth.mode = "definite";
	} else {
		childWidth.value = Math.max(0, areaWidth);
		childWidth.mode = "shrink-to-fit";
	}

	if (isStyleDimensionDefined(child, "column", ownerHeight)) {
		childHeight.value =
			boundAxisWithinMinMax(
				child,
				"column",
				resolveValue(child.style.height, ownerHeight),
				areaHeight,
			) + marginColumn;
		childHeight.mode = "definite";
	} else if (align === "stretch" && !autoTop && !autoBottom) {
		childHeight.value = Math.max(0, areaHeight);
		childHeight.mode = "definite";
	} else {
		childHeight.value = Math.max(0, areaHeight);
		childHeight.mode = "shrink-to-fit";
	}

	constrainMaxSizeForMode(child, "row", ownerWidth, childWidth);
	constrainMaxSizeForMode(child, "column", ownerHeight, childHeight);

	layoutNode(
		child,
		childWidth.value,
		childHeight.value,
		childWidth.mode,
		childHeight.mode,
		ownerWidth,
		ownerHeight,
		performLayout,
	);

	if (!performLayout) {
		return;
	}

	const freeX = areaWidth - child.layout.width - marginRow;
	const freeY = areaHeight - child.layout.height - marginColumn;

	child.layout.left =
		areaLeft +
		getAlignmentOffset(justify, freeX, autoLeft, autoRight) +
		resolveMargin(child.style.margin.left, ownerWidth);
	child.layout.top =
		areaTop +
		getAlignmentOffset(align, freeY, autoTop, autoBottom) +
		resolveMargin(child.style.margin.top, ownerWidth);
}

// Auto margins take the space before alignment does (css-align-3 §5.3).
function getAlignmentOffset(
	align: Align,
	free: number,
	leadingAuto: boolean,
	trailingAuto: boolean,
): number {
	if (leadingAuto && trailingAuto) {
		return Math.max(free, 0) / 2;
	}
	if (leadingAuto) {
		return Math.max(free, 0);
	}
	if (trailingAuto) {
		return 0;
	}
	switch (align) {
		case "center":
			return free / 2;
		case "flex-end":
			return free;
		default:
			return 0;
	}
}

// css-grid-2 §10.1.
function alignGridBaselines(
	node: LayoutNode,
	items: GridItem[],
	ownerWidth: number,
): void {
	const rows = new Map<number, GridItem[]>();
	for (const item of items) {
		if (getGridSelfAlign(node, item.node, false) !== "baseline") {
			continue;
		}
		const group = rows.get(item.rowStart);
		if (group) {
			group.push(item);
		} else {
			rows.set(item.rowStart, [item]);
		}
	}
	for (const group of rows.values()) {
		if (group.length < 2) {
			continue;
		}
		let furthest = 0;
		for (const item of group) {
			furthest = Math.max(
				furthest,
				getBaselineWithinBorderBox(item.node, ownerWidth),
			);
		}
		for (const item of group) {
			item.node.layout.top +=
				furthest - getBaselineWithinBorderBox(item.node, ownerWidth);
		}
	}
}

function snapTrackSizes(tracks: GridTrack[], gap: number): number[] {
	const sizes = new Array<number>(tracks.length).fill(0);
	let edge = 0;
	tracks.forEach((track, index) => {
		const next = edge + track.base;
		sizes[index] = Math.round(next) - Math.round(edge);
		edge = track.collapsed ? next : next + gap;
	});
	return sizes;
}

// css-grid-2 §12.1. Columns before rows, because a row contribution is
// a height, and a paragraph's height depends on where it wraps.
function layoutGrid(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(node, "row", ownerWidth);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);
	const contentLeft = getEdgePaddingAndBorder(node, "left", ownerWidth);
	const contentTop = getEdgePaddingAndBorder(node, "top", ownerWidth);

	const innerWidth = isDefined(availableWidth)
		? Math.max(0, availableWidth - marginRow - paddingBorderRow)
		: NaN;
	const innerHeight = isDefined(availableHeight)
		? Math.max(0, availableHeight - marginColumn - paddingBorderColumn)
		: NaN;

	const columnGap = node.style.gap["column"];
	const rowGap = node.style.gap["row"];

	const definiteWidth = widthSpace === "definite" && isDefined(innerWidth);
	const definiteHeight = heightSpace === "definite" && isDefined(innerHeight);

	const children: LayoutNode[] = [];
	for (const child of node.children) {
		if (child.style.displayType === "none") {
			zeroLayout(child);
			continue;
		}
		resolveNodeMargins(child, ownerWidth);
		if (isOutOfFlowType(child.style.positionType)) {
			continue;
		}
		children.push(child);
	}
	// Auto-placement runs in order-modified document order (css-grid-2 §8.5).
	if (children.some((child) => child.style.order !== 0)) {
		children.sort((a, b) => a.style.order - b.style.order);
	}

	const areas = node.style.gridTemplateAreas;
	const fromAreas = areas
		? getAreaLineNames(areas)
		: {
			columns: new Map<string, number[]>(),
			rows: new Map<string, number[]>(),
		};

	const columnTemplate = expandTrackList(
		node.style.gridTemplateColumns,
		definiteWidth ? innerWidth : NaN,
		columnGap,
		innerWidth,
	);
	const rowTemplate = expandTrackList(
		node.style.gridTemplateRows,
		definiteHeight ? innerHeight : NaN,
		rowGap,
		innerHeight,
	);

	const explicitColumns = Math.max(
		columnTemplate.sizes.length,
		areas ? areas.columnCount : 0,
	);
	const explicitRows = Math.max(
		rowTemplate.sizes.length,
		areas ? areas.rows.length : 0,
	);

	const columnNames = collectLineNames(columnTemplate, fromAreas.columns);
	const rowNames = collectLineNames(rowTemplate, fromAreas.rows);

	const items: GridItem[] = children.map((child) => ({
		node: child,
		column: pairGridLines(
			resolveGridLine(
				child.style.gridColumnStart,
				columnNames,
				explicitColumns,
				"start",
			),
			resolveGridLine(
				child.style.gridColumnEnd,
				columnNames,
				explicitColumns,
				"end",
			),
			columnNames,
		),
		row: pairGridLines(
			resolveGridLine(
				child.style.gridRowStart,
				rowNames,
				explicitRows,
				"start",
			),
			resolveGridLine(child.style.gridRowEnd, rowNames, explicitRows, "end"),
			rowNames,
		),
		columnStart: 0,
		columnEnd: 0,
		rowStart: 0,
		rowEnd: 0,
	}));

	autoPlaceItems(
		items,
		explicitColumns,
		explicitRows,
		node.style.gridAutoFlowColumn,
		node.style.gridAutoFlowDense,
	);

	// Normalized so that track 0 is the start-most track.
	let columnBase = 0;
	let rowBase = 0;
	let columnLast = explicitColumns;
	let rowLast = explicitRows;
	for (const item of items) {
		columnBase = Math.min(columnBase, item.column.start!);
		rowBase = Math.min(rowBase, item.row.start!);
		columnLast = Math.max(columnLast, item.column.start! + item.column.span);
		rowLast = Math.max(rowLast, item.row.start! + item.row.span);
	}
	const columnCount = Math.max(0, columnLast - columnBase);
	const rowCount = Math.max(0, rowLast - rowBase);
	for (const item of items) {
		item.columnStart = item.column.start! - columnBase;
		item.columnEnd = item.columnStart + item.column.span;
		item.rowStart = item.row.start! - rowBase;
		item.rowEnd = item.rowStart + item.row.span;
	}

	const buildTracks = (
		count: number,
		base: number,
		template: ExpandedTracks,
		autoSizes: TrackSize[],
		ownerSize: number,
	): GridTrack[] => {
		const tracks: GridTrack[] = [];
		let implicit = 0;
		for (let i = 0; i < count; i++) {
			const line = base + i;
			const explicit = line >= 0 && line < template.sizes.length;
			const size = explicit
				? template.sizes[line]
				: autoSizes[implicit++ % autoSizes.length];
			tracks.push(createTrack(size, ownerSize));
		}
		return tracks;
	};

	// css-grid-2 §7.2.3.2.
	const collapseAutoFit = (
		tracks: GridTrack[],
		template: ExpandedTracks,
		base: number,
		occupiedTracks: Set<number>,
	) => {
		if (!template.autoFit) {
			return;
		}
		for (let i = 0; i < template.autoFit.count; i++) {
			const index = template.autoFit.start + i - base;
			if (index < 0 || index >= tracks.length) {
				continue;
			}
			if (occupiedTracks.has(index)) {
				continue;
			}
			tracks[index].collapsed = true;
			tracks[index].base = 0;
			tracks[index].growthLimit = 0;
		}
	};

	const occupiedColumns = new Set<number>();
	const occupiedRows = new Set<number>();
	for (const item of items) {
		for (let i = item.columnStart; i < item.columnEnd; i++) {
			occupiedColumns.add(i);
		}
		for (let i = item.rowStart; i < item.rowEnd; i++) {
			occupiedRows.add(i);
		}
	}

	const inlineAlign = getInlineContentAlign(node);
	const blockAlign = getBlockContentAlign(node);

	const sizeColumns = (space: number): GridTrack[] => {
		const tracks = buildTracks(
			columnCount,
			columnBase,
			columnTemplate,
			node.style.gridAutoColumns,
			innerWidth,
		);
		collapseAutoFit(tracks, columnTemplate, columnBase, occupiedColumns);
		sizeTracks({
			node,
			tracks,
			items,
			columns: true,
			availableSpace: space,
			gap: columnGap,
			ownerSize: innerWidth,
			ownerWidth,
			ownerHeight,
			columnSizes: null,
			columnGap,
			stretchesAutoTracks: inlineAlign === "stretch",
			baselineShims: null,
		});
		return tracks;
	};

	let columnTracks = sizeColumns(definiteWidth ? innerWidth : NaN);
	const totalOf = (tracks: GridTrack[], gap: number) => {
		let total = 0;
		let live = 0;
		for (const track of tracks) {
			if (track.collapsed) {
				continue;
			}
			total += track.base;
			live++;
		}
		return total + gap * Math.max(0, live - 1);
	};

	let columnsTotal = totalOf(columnTracks, columnGap);
	// A shrink-to-fit grid that overflows its bound is re-sized against it.
	if (
		widthSpace === "shrink-to-fit" &&
		isDefined(innerWidth) &&
		columnsTotal > innerWidth + EPSILON
	) {
		columnTracks = sizeColumns(innerWidth);
		columnsTotal = totalOf(columnTracks, columnGap);
	}

	const columnSizes = columnTracks.map((track) => track.base);
	const baselineShims = measureBaselineShims(
		node,
		items,
		columnSizes,
		columnGap,
		ownerWidth,
		ownerHeight,
	);

	const sizeRows = (space: number): GridTrack[] => {
		const tracks = buildTracks(
			rowCount,
			rowBase,
			rowTemplate,
			node.style.gridAutoRows,
			innerHeight,
		);
		collapseAutoFit(tracks, rowTemplate, rowBase, occupiedRows);
		sizeTracks({
			node,
			tracks,
			items,
			columns: false,
			availableSpace: space,
			gap: rowGap,
			ownerSize: innerHeight,
			ownerWidth,
			ownerHeight,
			columnSizes,
			columnGap,
			stretchesAutoTracks: blockAlign === "stretch",
			baselineShims,
		});
		return tracks;
	};

	let rowTracks = sizeRows(definiteHeight ? innerHeight : NaN);
	let rowsTotal = totalOf(rowTracks, rowGap);
	if (
		heightSpace === "shrink-to-fit" &&
		isDefined(innerHeight) &&
		rowsTotal > innerHeight + EPSILON
	) {
		rowTracks = sizeRows(innerHeight);
		rowsTotal = totalOf(rowTracks, rowGap);
	}

	const width =
		widthSpace === "definite"
			? availableWidth - marginRow
			: boundAxis(
				node,
				"row",
				columnsTotal + paddingBorderRow,
				ownerWidth,
				ownerWidth,
			);
	const height =
		heightSpace === "definite"
			? availableHeight - marginColumn
			: boundAxis(
				node,
				"column",
				rowsTotal + paddingBorderColumn,
				ownerHeight,
				ownerWidth,
			);

	setMeasuredSize(node, width, height, ownerWidth, ownerHeight);

	if (!performLayout) {
		return;
	}

	const usedInnerWidth = Math.max(0, node.layout.width - paddingBorderRow);
	const usedInnerHeight = Math.max(0, node.layout.height - paddingBorderColumn);

	positionTracks(
		columnTracks,
		usedInnerWidth - columnsTotal,
		columnGap,
		inlineAlign,
	);
	positionTracks(rowTracks, usedInnerHeight - rowsTotal, rowGap, blockAlign);

	// Snapped by rounding the EDGES, as roundToGrid rounds the boxes, so the
	// reported sizes tile the container.
	node.layout.gridColumns = snapTrackSizes(columnTracks, columnGap);
	node.layout.gridRows = snapTrackSizes(rowTracks, rowGap);
	node.layout.gridColumnOffset = -columnBase || 0;
	node.layout.gridRowOffset = -rowBase || 0;

	// A line has two positions once tracks are spread by justify-content or
	// a gap. An area takes the inner pair, so the space between tracks
	// stays between them.
	const lineStart = (tracks: GridTrack[], line: number): number => {
		if (tracks.length === 0) {
			return 0;
		}
		if (line >= tracks.length) {
			const last = tracks[tracks.length - 1];
			return last.position + last.base;
		}
		return tracks[Math.max(0, line)].position;
	};
	const lineEnd = (tracks: GridTrack[], line: number): number => {
		if (tracks.length === 0) {
			return 0;
		}
		const track = tracks[Math.min(Math.max(0, line - 1), tracks.length - 1)];
		return track.position + track.base;
	};

	for (const item of items) {
		const areaLeft = lineStart(columnTracks, item.columnStart);
		const areaRight = lineEnd(columnTracks, item.columnEnd);
		const areaTop = lineStart(rowTracks, item.rowStart);
		const areaBottom = lineEnd(rowTracks, item.rowEnd);

		layoutGridItem(
			node,
			item,
			contentLeft + areaLeft,
			contentTop + areaTop,
			Math.max(0, areaRight - areaLeft),
			Math.max(0, areaBottom - areaTop),
			true,
		);
	}

	alignGridBaselines(node, items, ownerWidth);

	for (const item of items) {
		const child = item.node;
		if (child.style.positionType !== "relative") {
			continue;
		}
		child.layout.left += getRelativeOffset(child, "row", usedInnerWidth);
		child.layout.top += getRelativeOffset(child, "column", usedInnerHeight);
	}

	for (const child of getOutOfFlowDescendants(node, false)) {
		layoutAbsoluteChild(
			node,
			child,
			ownerWidth,
			ownerHeight,
			getAbsoluteGridArea(
				node,
				child,
				columnTracks,
				rowTracks,
				columnNames,
				rowNames,
				explicitColumns,
				explicitRows,
				columnBase,
				rowBase,
				contentLeft,
				contentTop,
				lineStart,
				lineEnd,
			),
		);
	}
}

// css-grid-2 §9.2: an absolutely positioned grid child placed on lines
// is contained by that area, with an `auto` line meaning the padding
// edge. Null when all four are auto, meaning the padding box.
function getAbsoluteGridArea(
	node: LayoutNode,
	child: LayoutNode,
	columnTracks: GridTrack[],
	rowTracks: GridTrack[],
	columnNames: Map<string, number[]>,
	rowNames: Map<string, number[]>,
	explicitColumns: number,
	explicitRows: number,
	columnBase: number,
	rowBase: number,
	contentLeft: number,
	contentTop: number,
	lineStart: (tracks: GridTrack[], line: number) => number,
	lineEnd: (tracks: GridTrack[], line: number) => number,
): {left: number; top: number; width: number; height: number} | null {
	const style = child.style;
	const placed =
		style.gridColumnStart !== AUTO_PLACEMENT ||
		style.gridColumnEnd !== AUTO_PLACEMENT ||
		style.gridRowStart !== AUTO_PLACEMENT ||
		style.gridRowEnd !== AUTO_PLACEMENT;
	if (!placed) {
		return null;
	}

	const paddingLeft = node.style.border.left;
	const paddingTop = node.style.border.top;
	const paddingRight = Math.max(0, node.layout.width - node.style.border.right);
	const paddingBottom = Math.max(
		0,
		node.layout.height - node.style.border.bottom,
	);

	const edge = (
		placement: GridPlacement,
		names: Map<string, number[]>,
		explicitCount: number,
		tracks: GridTrack[],
		base: number,
		leading: number,
		fallback: number,
		which: "start" | "end",
	): number => {
		if (placement === AUTO_PLACEMENT) {
			return fallback;
		}
		const line = resolveGridLine(placement, names, explicitCount, which);
		if (line.kind !== "line") {
			return fallback;
		}
		const at = which === "start" ? lineStart : lineEnd;
		return leading + at(tracks, line.index - base);
	};

	const left = edge(
		style.gridColumnStart,
		columnNames,
		explicitColumns,
		columnTracks,
		columnBase,
		contentLeft,
		paddingLeft,
		"start",
	);
	const right = edge(
		style.gridColumnEnd,
		columnNames,
		explicitColumns,
		columnTracks,
		columnBase,
		contentLeft,
		paddingRight,
		"end",
	);
	const top = edge(
		style.gridRowStart,
		rowNames,
		explicitRows,
		rowTracks,
		rowBase,
		contentTop,
		paddingTop,
		"start",
	);
	const bottom = edge(
		style.gridRowEnd,
		rowNames,
		explicitRows,
		rowTracks,
		rowBase,
		contentTop,
		paddingBottom,
		"end",
	);

	return {
		left: Math.min(left, right),
		top: Math.min(top, bottom),
		width: Math.abs(right - left),
		height: Math.abs(bottom - top),
	};
}

// A set of adjoining margins, stored as its largest positive and most
// negative member. That is enough to compute the used value and to
// merge two sets, so a set crosses a box edge as two numbers rather
// than as the margins in it.
interface MarginSet {
	positive: number;
	negative: number;
}

function marginSet(): MarginSet {
	return {positive: 0, negative: 0};
}

function addMargin(set: MarginSet, margin: number): void {
	if (margin > set.positive) {
		set.positive = margin;
	}
	if (margin < set.negative) {
		set.negative = margin;
	}
}

function mergeMarginSet(set: MarginSet, other: MarginSet): void {
	if (other.positive > set.positive) {
		set.positive = other.positive;
	}
	if (other.negative < set.negative) {
		set.negative = other.negative;
	}
}

function resetMarginSet(set: MarginSet): void {
	set.positive = 0;
	set.negative = 0;
}

function getCollapsedMargin(set: MarginSet): number {
	return set.positive + set.negative;
}

// The child's own margin, plus what escapes its edge.
function readCollapseTop(child: LayoutNode, into: MarginSet): void {
	resetMarginSet(into);
	addMargin(into, child.layout.margin.top);
	into.positive = Math.max(into.positive, child.layout.collapseTopPositive);
	into.negative = Math.min(into.negative, child.layout.collapseTopNegative);
}

function readCollapseBottom(child: LayoutNode, into: MarginSet): void {
	resetMarginSet(into);
	addMargin(into, child.layout.margin.bottom);
	into.positive = Math.max(into.positive, child.layout.collapseBottomPositive);
	into.negative = Math.min(into.negative, child.layout.collapseBottomNegative);
}

function isShrinkToFitWidth(node: LayoutNode): boolean {
	return (
		node.style.displayType === "table" || node.style.widthSizing !== "none"
	);
}

function layoutBlockChild(
	child: LayoutNode,
	contentWidth: number,
	fill: boolean,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const marginRow = getAxisMargin(child, "row", ownerWidth);
	const marginColumn = getAxisMargin(child, "column", ownerWidth);

	const childWidth = {value: NaN, mode: "indefinite" as AvailableSpace};
	const childHeight = {value: NaN, mode: "indefinite" as AvailableSpace};

	if (isStyleDimensionDefined(child, "row", ownerWidth)) {
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				"row",
				resolveValue(child.style.width, ownerWidth),
				contentWidth,
			) + marginRow;
		childWidth.mode = "definite";
	} else if (
		isDefined(child.style.aspectRatio) &&
		child.style.aspectRatio > 0 &&
		isStyleDimensionDefined(child, "column", ownerHeight)
	) {
		// A transferred width beats fill. The box is as wide as its ratio
		// says, not as wide as the container (css-sizing-4 §5).
		const transferred =
			resolveValue(child.style.height, ownerHeight) * child.style.aspectRatio;
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				"row",
				transferred,
				contentWidth,
			) + marginRow;
		childWidth.mode = "definite";
	} else if (child.style.widthSizing === "min-content") {
		childWidth.value = 0;
		childWidth.mode = "shrink-to-fit";
	} else if (child.style.widthSizing === "max-content") {
		// An undefined request measures the content unbroken.
	} else if (isDefined(contentWidth)) {
		// A non-filling child's `shrink-to-fit` request is already fit-content.
		childWidth.value = contentWidth;
		childWidth.mode = fill ? "definite" : "shrink-to-fit";
	}

	if (isStyleDimensionDefined(child, "column", ownerHeight)) {
		childHeight.value =
			resolveValue(child.style.height, ownerHeight) + marginColumn;
		childHeight.mode = "definite";
	}

	constrainMaxSizeForMode(child, "row", ownerWidth, childWidth);
	constrainMaxSizeForMode(child, "column", ownerHeight, childHeight);

	layoutNode(
		child,
		childWidth.value,
		childHeight.value,
		childWidth.mode,
		childHeight.mode,
		ownerWidth,
		ownerHeight,
		performLayout,
	);
}

// Collapsible white space between two blocks produces no line, so the
// margins on either side of it keep adjoining (css2 §9.4.2, §8.3.1).
function hasNoLineBox(child: LayoutNode): boolean {
	return child.measure !== null && child.layout.height === 0;
}

function isStretchFit(child: LayoutNode): boolean {
	return (
		!isShrinkToFitWidth(child) &&
		child.style.margin.left.unit !== "auto" &&
		child.style.margin.right.unit !== "auto"
	);
}

// One running set of adjoining margins. It starts open at the top edge
// when nothing separates the container's margin from its first child's.
// Those margins escape, and the container above applies them. A border,
// padding or a formatting context closes the set, and content under it
// spends it as a gap. A self-collapsing child never closes it.
function layoutBlock(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(node, "row", ownerWidth);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);
	const leftPaddingBorder = getEdgePaddingAndBorder(node, "left", ownerWidth);
	const topPaddingBorder = getEdgePaddingAndBorder(node, "top", ownerWidth);

	const inFlow: LayoutNode[] = [];
	for (const child of node.children) {
		if (child.style.displayType === "none") {
			zeroLayout(child);
			continue;
		}
		resolveNodeMargins(child, ownerWidth);
		if (isOutOfFlowType(child.style.positionType)) {
			continue;
		}
		inFlow.push(child);
	}

	const innerWidth = isDefined(availableWidth)
		? Math.max(0, availableWidth - marginRow - paddingBorderRow)
		: NaN;
	// The children's containing block is the content box (css2 §10.1),
	// so their percentages resolve against it: a width they can read
	// before it is known is not definite.
	const innerHeight =
		heightSpace === "definite"
			? Math.max(0, availableHeight - marginColumn - paddingBorderColumn)
			: NaN;

	// The width is resolved before the children lay out, min/max included,
	// so each is measured once at the width it keeps.
	let borderBoxWidth: number;
	if (widthSpace === "definite") {
		borderBoxWidth = availableWidth - marginRow;
	} else {
		let widest = 0;
		for (const child of inFlow) {
			layoutBlockChild(
				child,
				innerWidth,
				false,
				innerWidth,
				innerHeight,
				false,
			);
			widest = Math.max(
				widest,
				child.layout.width + getAxisMargin(child, "row", innerWidth),
			);
		}
		borderBoxWidth = widest + paddingBorderRow;
	}
	borderBoxWidth = boundAxis(
		node,
		"row",
		borderBoxWidth,
		ownerWidth,
		ownerWidth,
	);
	const contentWidth = Math.max(0, borderBoxWidth - paddingBorderRow);

	const openTop =
		!node.style.blockFormattingContext &&
		getEdgePaddingAndBorder(node, "top", ownerWidth) === 0;
	const openBottom =
		!node.style.blockFormattingContext &&
		getEdgePaddingAndBorder(node, "bottom", ownerWidth) === 0 &&
		heightSpace !== "definite" &&
		!isStyleDimensionDefined(node, "column", ownerHeight);

	const escapingTop = marginSet();
	const escapingBottom = marginSet();
	const adjoining = marginSet();
	const childTop = marginSet();
	const childBottom = marginSet();

	// Content-box tops, parallel to `inFlow`.
	const tops = new Array<number>(inFlow.length).fill(0);
	let collecting = openTop;
	let cursor = 0;
	let placedContent = false;

	for (let i = 0; i < inFlow.length; i++) {
		const child = inFlow[i];
		resolveNodeMargins(child, contentWidth);
		layoutBlockChild(
			child,
			contentWidth,
			isStretchFit(child),
			contentWidth,
			innerHeight,
			performLayout,
		);

		readCollapseTop(child, childTop);
		if (child.layout.selfCollapsing || hasNoLineBox(child)) {
			readCollapseBottom(child, childBottom);
			mergeMarginSet(childTop, childBottom);
			if (collecting) {
				mergeMarginSet(escapingTop, childTop);
				tops[i] = cursor;
			} else {
				mergeMarginSet(adjoining, childTop);
				tops[i] = cursor + getCollapsedMargin(adjoining);
			}
			continue;
		}

		if (collecting) {
			mergeMarginSet(escapingTop, childTop);
			collecting = false;
			tops[i] = cursor;
		} else {
			mergeMarginSet(adjoining, childTop);
			tops[i] = cursor + getCollapsedMargin(adjoining);
		}
		resetMarginSet(adjoining);
		cursor = tops[i] + child.layout.height;
		placedContent = true;
		readCollapseBottom(child, adjoining);
	}

	let contentHeight: number;
	if (openBottom) {
		mergeMarginSet(escapingBottom, adjoining);
		contentHeight = cursor;
	} else {
		contentHeight = cursor + getCollapsedMargin(adjoining);
	}

	const height =
		heightSpace === "definite"
			? availableHeight - marginColumn
			: Math.max(0, contentHeight) + paddingBorderColumn;

	setMeasuredSize(node, borderBoxWidth, height, ownerWidth, ownerHeight);

	// Nothing at either edge and nothing between. The box is a gap its
	// neighbours' margins pass through, and its two escaping sets are one.
	const selfCollapsing =
		openTop && openBottom && !placedContent && node.layout.height === 0;
	if (selfCollapsing) {
		mergeMarginSet(escapingTop, escapingBottom);
		mergeMarginSet(escapingBottom, escapingTop);
	}
	node.layout.collapseTopPositive = escapingTop.positive;
	node.layout.collapseTopNegative = escapingTop.negative;
	node.layout.collapseBottomPositive = escapingBottom.positive;
	node.layout.collapseBottomNegative = escapingBottom.negative;
	node.layout.selfCollapsing = selfCollapsing;

	if (!performLayout) {
		return;
	}

	for (let i = 0; i < inFlow.length; i++) {
		const child = inFlow[i];
		const leading = child.layout.margin.left;
		const trailing = child.layout.margin.right;
		const leadingAuto = child.style.margin.left.unit === "auto";
		const trailingAuto = child.style.margin.right.unit === "auto";
		const free = contentWidth - child.layout.width - leading - trailing;

		let offset = 0;
		if (leadingAuto && trailingAuto) {
			offset = Math.max(free, 0) / 2;
		} else if (leadingAuto) {
			offset = Math.max(free, 0);
		}

		child.layout.left = leftPaddingBorder + leading + offset;
		child.layout.top = topPaddingBorder + tops[i];
	}

	const innerWidthFinal = node.layout.width - paddingBorderRow;
	const innerHeightFinal = node.layout.height - paddingBorderColumn;
	for (const child of inFlow) {
		if (child.style.positionType !== "relative") {
			continue;
		}
		child.layout.left += getRelativeOffset(child, "row", innerWidthFinal);
		child.layout.top += getRelativeOffset(child, "column", innerHeightFinal);
	}

	for (const child of getOutOfFlowDescendants(node, false)) {
		layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
	}
	if (node.parent === null) {
		for (const child of getOutOfFlowDescendants(node, true)) {
			layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
		}
	}
}

// The entry point for every mode and every probe.
function layoutNode(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	// css-sizing-4 §5: the open axis follows a settled (`definite`) one
	// through the ratio. With both settled the ratio yields. Margins come
	// off the settled request and back onto the derived one. min/max on the
	// derived axis still clamp in setMeasuredSize.
	const ratio = node.style.aspectRatio;
	if (isDefined(ratio) && ratio > 0) {
		const marginRow = getAxisMargin(node, "row", ownerWidth);
		const marginColumn = getAxisMargin(node, "column", ownerWidth);
		if (
			widthSpace === "definite" &&
			heightSpace !== "definite" &&
			isDefined(availableWidth)
		) {
			availableHeight = (availableWidth - marginRow) / ratio + marginColumn;
			heightSpace = "definite";
		} else if (
			heightSpace === "definite" &&
			widthSpace !== "definite" &&
			isDefined(availableHeight)
		) {
			availableWidth = (availableHeight - marginColumn) * ratio + marginRow;
			widthSpace = "definite";
		}
	}

	// A clean node under a request it has already satisfied restores its
	// size and skips its whole subtree. A full layout satisfies a sizing
	// query. A sizing result never satisfies a layout query, since it
	// placed no children.
	if (!node.stale) {
		let hit: CachedSize | null = null;
		if (
			node.cachedLayout &&
			isMatchingConstraints(
				node.cachedLayout,
				availableWidth,
				availableHeight,
				widthSpace,
				heightSpace,
				ownerWidth,
				ownerHeight,
			)
		) {
			hit = node.cachedLayout;
		} else if (!performLayout) {
			// Margins are outside the size a measurement returns, so both
			// requests are reduced to their content side before being compared.
			const marginRow = getAxisMargin(node, "row", ownerWidth);
			const marginColumn = getAxisMargin(node, "column", ownerWidth);
			for (const cached of node.cachedSizes) {
				if (
					cached !== null &&
					isSameConstraint(cached.ownerWidth, ownerWidth) &&
					isSameConstraint(cached.ownerHeight, ownerHeight) &&
					cached.width >= 0 &&
					cached.height >= 0 &&
					isCachedSizeValid(
						cached.widthSpace,
						cached.availableWidth - marginRow,
						cached.width,
						widthSpace,
						availableWidth - marginRow,
					) &&
					isCachedSizeValid(
						cached.heightSpace,
						cached.availableHeight - marginColumn,
						cached.height,
						heightSpace,
						availableHeight - marginColumn,
					)
				) {
					hit = cached;
					break;
				}
			}
		}
		if (hit) {
			node.layout.width = hit.width;
			node.layout.height = hit.height;
			return;
		}
	}

	// Whatever dirtied the node invalidated every cached result.
	if (node.stale) {
		node.cachedLayout = null;
		node.cachedSizes.fill(null);
	}

	layoutNodeImpl(
		node,
		availableWidth,
		availableHeight,
		widthSpace,
		heightSpace,
		ownerWidth,
		ownerHeight,
		performLayout,
	);

	const entry: CachedSize = {
		availableWidth,
		availableHeight,
		widthSpace,
		heightSpace,
		ownerWidth,
		ownerHeight,
		width: node.layout.width,
		height: node.layout.height,
	};
	if (performLayout) {
		node.cachedLayout = entry;
	} else {
		node.cachedSizes[
			getCacheSlot(availableWidth, availableHeight, widthSpace, heightSpace)
		] = entry;
	}
	node.stale = false;
}

function layoutNodeImpl(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthSpace: AvailableSpace,
	heightSpace: AvailableSpace,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	node.layout.padding.left = getPadding(node, "left", ownerWidth);
	node.layout.padding.top = getPadding(node, "top", ownerWidth);
	node.layout.padding.right = getPadding(node, "right", ownerWidth);
	node.layout.padding.bottom = getPadding(node, "bottom", ownerWidth);

	resolveNodeMargins(node, ownerWidth);

	// Only block layout writes these, so every other mode must clear them.
	node.layout.collapseTopPositive = 0;
	node.layout.collapseTopNegative = 0;
	node.layout.collapseBottomPositive = 0;
	node.layout.collapseBottomNegative = 0;
	node.layout.selfCollapsing = false;

	// A box that stopped being a grid container must stop reporting them.
	if (node.style.displayType !== "grid") {
		node.layout.gridColumns = null;
		node.layout.gridRows = null;
	}

	if (node.style.displayType === "none") {
		zeroLayout(node);
		return;
	}

	if (node.measure) {
		layoutMeasuredContent(
			node,
			availableWidth,
			availableHeight,
			widthSpace,
			heightSpace,
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		return;
	}

	if (node.style.displayType === "grid") {
		layoutGrid(
			node,
			availableWidth,
			availableHeight,
			widthSpace,
			heightSpace,
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		return;
	}

	if (node.style.displayType === "table") {
		layoutTable(
			node,
			availableWidth,
			availableHeight,
			widthSpace,
			heightSpace,
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		return;
	}

	// A cell and a caption are block containers for their own content.
	if (
		node.style.displayType === "block" ||
		node.style.displayType === "table-cell" ||
		node.style.displayType === "table-caption"
	) {
		layoutBlock(
			node,
			availableWidth,
			availableHeight,
			widthSpace,
			heightSpace,
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		return;
	}

	const hasInFlowChild = node.children.some(
		(child) =>
			child.style.displayType !== "none" &&
			!isOutOfFlowType(child.style.positionType),
	);

	if (!hasInFlowChild && node.children.length === 0) {
		layoutEmptyContainer(
			node,
			availableWidth,
			availableHeight,
			widthSpace,
			heightSpace,
			ownerWidth,
			ownerHeight,
		);
		return;
	}

	layoutFlexbox(
		node,
		availableWidth,
		availableHeight,
		widthSpace,
		heightSpace,
		ownerWidth,
		ownerHeight,
		performLayout,
	);
}

function getPadding(node: LayoutNode, edge: Edge, ownerWidth: number): number {
	const padding = resolveValue(node.style.padding[edge], ownerWidth);
	return isDefined(padding) ? Math.max(padding, 0) : 0;
}

// Snap to whole cells from rounded absolute EDGES, not rounded widths:
// 26.67 x 3 rounded separately is 81 columns in an 80-column terminal. A
// measured leaf ceils its trailing edge so text never gets less room than it
// measured.
function roundToGrid(
	node: LayoutNode,
	absoluteLeft: number,
	absoluteTop: number,
): void {
	const nodeLeft = node.layout.left;
	const nodeTop = node.layout.top;
	const nodeWidth = isDefined(node.layout.width) ? node.layout.width : 0;
	const nodeHeight = isDefined(node.layout.height) ? node.layout.height : 0;

	const absLeft = absoluteLeft + nodeLeft;
	const absTop = absoluteTop + nodeTop;
	const absRight = absLeft + nodeWidth;
	const absBottom = absTop + nodeHeight;

	const isText = node.measure !== null;

	node.layout.left = roundValue(nodeLeft, false, isText);
	node.layout.top = roundValue(nodeTop, false, isText);

	node.layout.width =
		roundValue(absRight, isText, false) - roundValue(absLeft, isText, false);
	node.layout.height =
		roundValue(absBottom, isText, false) - roundValue(absTop, isText, false);

	for (const child of node.children) {
		roundToGrid(child, absLeft, absTop);
	}
}

function roundValue(
	value: number,
	forceCeil: boolean,
	forceFloor: boolean,
): number {
	if (!isDefined(value)) {
		return value;
	}

	const fraction = value - Math.floor(value);

	if (approximatelyEqual(fraction, 0)) {
		return value - fraction;
	}
	if (approximatelyEqual(fraction, 1)) {
		return value - fraction + 1;
	}
	if (forceCeil) {
		return value - fraction + 1;
	}
	if (forceFloor) {
		return value - fraction;
	}
	// Round half up.
	return value - fraction + (fraction >= 0.5 ? 1 : 0);
}

function approximatelyEqual(a: number, b: number): boolean {
	return Math.abs(a - b) < 0.0001;
}
