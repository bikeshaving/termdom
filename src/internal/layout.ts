import LineBreaker from "linebreak";

import {
	AUTO_PLACEMENT,
	AUTO_TRACK,
	type BoxModel,
	EMPTY_TRACK_LIST,
	getBoxModel,
	getComputedValue,
	type GridAreaMap,
	type GridPlacement,
	parseAspectRatio,
	parseBorderWidthValue,
	parseGridAreas,
	parseGridPlacement,
	parseSignedUnitValue,
	parseTrackList,
	parseTrackSizeList,
	parseUnitValue,
	type TrackBreadth,
	type TrackList,
	type TrackListTrack,
	type TrackSize,
	usedValuesChanged,
	type Value,
} from "./cssom.js";
import {
	DOMRectList,
	type EngineWindow,
	flatIsConnected,
	flatParentElement,
	getShadowRoot,
	isModalDialog,
	NodeFilter,
	pseudoElementCount,
	renderedTopLayer,
	SHOW_FLAT,
	TreeWalker,
} from "./dom.js";
import {
	getParagraphDirection,
	getStringWidth,
	hasRTL,
	toVisualOrder,
	writeClusterWidths,
} from "./text.js";

// `normal` means whatever the mode says: stretch on a grid item,
// flex-start across flex lines (css-align-3).
type Align =
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

type Justify =
	"flex-start" |
	"center" |
	"flex-end" |
	"space-between" |
	"space-around" |
	"space-evenly" |
	"normal" |
	"stretch";

type Wrap = "nowrap" | "wrap" | "wrap-reverse";

type FlexDirection = "column" | "column-reverse" | "row" | "row-reverse";

type Gutter = "column" | "row";

type LayoutMode =
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

type MeasureMode = "unconstrained" | "exactly" | "at-most";

type Edges<T> = {left: T; top: T; right: T; bottom: T};

type Edge = keyof Edges<unknown>;

// css-sizing-3 §5 keywords, stored beside a width of `auto` rather than
// as a unit of it, so min/max, percentages and flex arithmetic still
// read auto.
type Sizing = "none" | "min-content" | "max-content" | "fit-content";

interface Size {
	width: number;
	height: number;
}

// `performLayout` is true for the measurement that places the box and
// false for the sizing probes before it. Only the placing one may keep
// its line breaks.
type MeasureFunction = (
	width: number,
	widthMode: MeasureMode,
	performLayout: boolean,
) => Size;

// The origin of CSS 2 §10.3.7's hypothetical box, in the containing
// block's border-box coordinates. Null means the containing block's
// alignment places it.
type StaticPositionFunction = (
	containingBlock: LayoutNode,
) => {left: number; top: number} | null;

// NaN is the undefined length everywhere below. 0 is a length.
const UNDEFINED_VALUE: Value = {unit: "undefined", value: NaN};
const AUTO_VALUE: Value = {unit: "auto", value: NaN};

type Length = number | "auto" | {percentage: number} | undefined | null;

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
	return (
		axis === "column" || axis === "column-reverse"
	);
}

function isReverse(axis: FlexDirection): boolean {
	return (
		axis === "row-reverse" ||
		axis === "column-reverse"
	);
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

interface Style {
	flexDirection: FlexDirection;
	justifyContent: Justify;
	alignContent: Align;
	alignItems: Align;
	alignSelf: Align;
	positionType: PositionType;
	flexWrap: Wrap;
	mode: LayoutMode;

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
	autoMinMain: number;

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

interface CachedLayout {
	availableWidth: number;
	availableHeight: number;
	widthMode: MeasureMode;
	heightMode: MeasureMode;
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
	cache: CachedLayout,
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
): boolean {
	return (
		cache.widthMode === widthMode &&
		cache.heightMode === heightMode &&
		isSameConstraint(cache.availableWidth, availableWidth) &&
		isSameConstraint(cache.availableHeight, availableHeight) &&
		isSameConstraint(cache.ownerWidth, ownerWidth) &&
		isSameConstraint(cache.ownerHeight, ownerHeight)
	);
}

// Yoga's canUseCachedMeasurement rules. Beyond an identical request, a
// cached size satisfies an `exactly` request of that same size, an
// `at-most` bound over an unbounded result that fits it, and a tighter
// `at-most` bound the result still fits. Sizing only. A full layout
// placed children against its request.
function isCachedSizeValid(
	cachedMode: MeasureMode,
	cachedAvailable: number,
	cachedComputed: number,
	mode: MeasureMode,
	available: number,
): boolean {
	if (cachedMode === mode && isSameConstraint(cachedAvailable, available)) {
		return true;
	}
	if (mode === "exactly" && available === cachedComputed) {
		return true;
	}
	if (mode === "at-most") {
		if (cachedMode === "unconstrained") {
			return cachedComputed <= available;
		}
		if (cachedMode === "at-most") {
			return cachedAvailable > available && cachedComputed <= available;
		}
	}
	return false;
}

function isMinContent(mode: MeasureMode, available: number): boolean {
	return mode === "at-most" && available === 0;
}

const CACHE_SLOT_COUNT = 9;

// Taffy's compute_cache_slot: one slot per query shape, so the probes
// one pass makes of a child (min-content, max-content, fixed) never evict
// each other.
function getCacheSlot(
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
): number {
	const knownWidth = widthMode === "exactly";
	const knownHeight = heightMode === "exactly";
	if (knownWidth && knownHeight) {
		return 0;
	}
	if (knownWidth) {
		return 1 + (isMinContent(heightMode, availableHeight) ? 1 : 0);
	}
	if (knownHeight) {
		return 3 + (isMinContent(widthMode, availableWidth) ? 1 : 0);
	}
	return (
		5 +
		(isMinContent(widthMode, availableWidth) ? 2 : 0) +
		(isMinContent(heightMode, availableHeight) ? 1 : 0)
	);
}

export class LayoutNode {
	style: Style;
	layout: LayoutResult;
	children: LayoutNode[];
	parent: LayoutNode | null;
	measureFunc: MeasureFunction | null;
	staticPositionFunc: StaticPositionFunction | null;
	dirty: boolean;

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
	// several probes of one child keep their own. The dirty flag invalidates
	// both.
	cachedMeasures: Array<CachedLayout | null>;
	cachedLayout: CachedLayout | null;
	styling: boolean;

	// Null for a node no DOM node owns: an anonymous run's, a content root,
	// the viewport. Stored on the node rather than in a map because it is
	// read during paint culling and every child sweep, and a node that left
	// the tree cannot go stale.
	owner: object | null;

	constructor() {
		this.children = [];
		this.parent = null;
		this.measureFunc = null;
		this.staticPositionFunc = null;
		this.dirty = true;
		this.extentTop = 0;
		this.extentBottom = 0;
		this.unstackedChildCount = 0;
		this.cachedMeasures = new Array(CACHE_SLOT_COUNT).fill(
			null,
		);
		this.cachedLayout = null;
		this.styling = false;
		this.owner = null;
		this.style = createStyle();
		this.layout = createLayout();
	}

	insertChild(child: LayoutNode, index: number): void {
		child.parent = this;
		this.children.splice(index, 0, child);
		markDirtyUpward(this);
	}

	removeChild(child: LayoutNode): void {
		const index = this.children.indexOf(child);
		if (index !== -1) {
			this.children.splice(index, 1);
			child.parent = null;
			markDirtyUpward(this);
		}
	}

	// Searches from the tail. Callers mostly ask about the child they just
	// appended.
	getChildIndex(child: LayoutNode): number {
		return this.children.lastIndexOf(child);
	}

	freeRecursive(): void {
		for (const child of this.children) {
			child.freeRecursive();
		}
		this.children = [];
		this.parent = null;
		this.measureFunc = null;
		this.staticPositionFunc = null;
	}

	markDirty(): void {
		this.dirty = true;
		if (this.styling) {
			return;
		}
		markDirtyUpward(this);
	}

	// A computed style sets scores of properties on one node. The ancestor
	// walk happens once at the end instead of once per setter.
	styleAll(assign: () => void): void {
		const outer = this.styling;
		this.styling = true;
		try {
			assign();
		} finally {
			this.styling = outer;
		}
		this.markDirty();
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

	setMeasureFunc(fn: MeasureFunction | null): void {
		this.measureFunc = fn;
		this.markDirty();
	}

	setStaticPositionFunc(fn: StaticPositionFunction | null): void {
		this.staticPositionFunc = fn;
		this.markDirty();
	}

	setFlexDirection(v: FlexDirection): void {
		this.style.flexDirection = v;
		this.markDirty();
	}

	setJustifyContent(v: Justify): void {
		this.style.justifyContent = v;
		this.markDirty();
	}

	setAlignContent(v: Align): void {
		this.style.alignContent = v;
		this.markDirty();
	}

	setAlignItems(v: Align): void {
		this.style.alignItems = v;
		this.markDirty();
	}

	setAlignSelf(v: Align): void {
		this.style.alignSelf = v;
		this.markDirty();
	}

	setPositionType(v: PositionType): void {
		this.style.positionType = v;
		this.markDirty();
	}

	setFlexWrap(v: Wrap): void {
		this.style.flexWrap = v;
		this.markDirty();
	}

	setGap(gutter: Gutter, value: number): void {
		this.style.gap[gutter] = Number.isFinite(value) ? Math.max(0, value) : 0;
		this.markDirty();
	}

	setJustifyItems(v: Align): void {
		this.style.justifyItems = v;
		this.markDirty();
	}

	setJustifySelf(v: Align): void {
		this.style.justifySelf = v;
		this.markDirty();
	}

	setGridTemplateColumns(v: TrackList | null): void {
		this.style.gridTemplateColumns = v ?? EMPTY_TRACK_LIST;
		this.markDirty();
	}

	setGridTemplateRows(v: TrackList | null): void {
		this.style.gridTemplateRows = v ?? EMPTY_TRACK_LIST;
		this.markDirty();
	}

	setGridTemplateAreas(v: GridAreaMap | null): void {
		this.style.gridTemplateAreas = v;
		this.markDirty();
	}

	setGridAutoColumns(v: TrackSize[] | null): void {
		this.style.gridAutoColumns = v && v.length > 0 ? v : [AUTO_TRACK];
		this.markDirty();
	}

	setGridAutoRows(v: TrackSize[] | null): void {
		this.style.gridAutoRows = v && v.length > 0 ? v : [AUTO_TRACK];
		this.markDirty();
	}

	setGridAutoFlow(column: boolean, dense: boolean): void {
		this.style.gridAutoFlowColumn = column;
		this.style.gridAutoFlowDense = dense;
		this.markDirty();
	}

	setGridRowStart(v: GridPlacement | null): void {
		this.style.gridRowStart = v ?? AUTO_PLACEMENT;
		this.markDirty();
	}

	setGridRowEnd(v: GridPlacement | null): void {
		this.style.gridRowEnd = v ?? AUTO_PLACEMENT;
		this.markDirty();
	}

	setGridColumnStart(v: GridPlacement | null): void {
		this.style.gridColumnStart = v ?? AUTO_PLACEMENT;
		this.markDirty();
	}

	setGridColumnEnd(v: GridPlacement | null): void {
		this.style.gridColumnEnd = v ?? AUTO_PLACEMENT;
		this.markDirty();
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

	setColSpan(v: number): void {
		this.style.colSpan = Math.max(1, Math.floor(v) || 1);
		this.markDirty();
	}

	setRowSpan(v: number): void {
		this.style.rowSpan = Math.max(1, Math.floor(v) || 1);
		this.markDirty();
	}

	setBlockFormattingContext(v: boolean): void {
		this.style.blockFormattingContext = v;
		this.markDirty();
	}

	setBorderCollapse(v: boolean): void {
		this.style.borderCollapse = v;
		this.markDirty();
	}

	setMode(v: LayoutMode): void {
		this.style.mode = v;
		this.markDirty();
	}

	setOrder(v: number | undefined): void {
		this.style.order = v ?? 0;
		this.markDirty();
	}

	setFlexGrow(v: number | undefined): void {
		this.style.flexGrow = v === undefined ? NaN : v;
		this.markDirty();
	}

	setFlexShrink(v: number | undefined): void {
		this.style.flexShrink = v === undefined ? NaN : v;
		this.markDirty();
	}

	setFlexBasis(v: Length): void {
		this.style.flexBasis = toValue(v);
		this.markDirty();
	}

	setWidth(v: Length): void {
		this.style.width = toValue(v);
		this.markDirty();
	}

	setWidthSizing(v: Sizing): void {
		if (this.style.widthSizing !== v) {
			this.style.widthSizing = v;
			this.markDirty();
		}
	}

	setHeight(v: Length): void {
		this.style.height = toValue(v);
		this.markDirty();
	}

	setAspectRatio(v: number | undefined): void {
		this.style.aspectRatio =
			v !== undefined && Number.isFinite(v) && v > 0 ? v : NaN;
		this.markDirty();
	}

	setMinWidth(v: Length): void {
		this.style.minWidth = toValue(v);
		this.markDirty();
	}

	setMinHeight(v: Length): void {
		this.style.minHeight = toValue(v);
		this.markDirty();
	}

	setMaxWidth(v: Length): void {
		this.style.maxWidth = toValue(v);
		this.markDirty();
	}

	setMaxHeight(v: Length): void {
		this.style.maxHeight = toValue(v);
		this.markDirty();
	}

	setMargin(edge: Edge, v: Length): void {
		this.style.margin[edge] = toValue(v);
		this.markDirty();
	}

	setPadding(edge: Edge, v: Length): void {
		this.style.padding[edge] = toValue(v);
		this.markDirty();
	}

	setBorder(edge: Edge, v: number | undefined): void {
		const width = v === undefined || Number.isNaN(v) ? 0 : v;
		this.style.border[edge] = width;
		this.markDirty();
	}

	setPosition(edge: Edge, v: Length): void {
		this.style.position[edge] = toValue(v);
		this.markDirty();
	}

	getComputedWidth(): number {
		return isDefined(this.layout.width) ? this.layout.width : 0;
	}

	getComputedHeight(): number {
		return isDefined(this.layout.height) ? this.layout.height : 0;
	}

	calculateLayout(ownerWidth: number, ownerHeight: number): void {
		const width = resolveValue(this.style.width, ownerWidth);
		const height = resolveValue(this.style.height, ownerHeight);

		let availableWidth = isDefined(width) ? width : ownerWidth;
		let widthMode: MeasureMode = isDefined(availableWidth)
			? "exactly"
			: "unconstrained";
		// A sizing keyword on a root turns the owner's width from the used
		// width into a probe: zero for min-content, a ceiling for fit-content,
		// and no request at all for max-content.
		if (!isDefined(width) && this.style.widthSizing !== "none") {
			if (this.style.widthSizing === "min-content") {
				availableWidth = 0;
				widthMode = "at-most";
			} else if (this.style.widthSizing === "max-content") {
				availableWidth = NaN;
				widthMode = "unconstrained";
			} else if (isDefined(availableWidth)) {
				widthMode = "at-most";
			}
		}
		const availableHeight = isDefined(height) ? height : ownerHeight;

		layoutNode(
			this,
			availableWidth,
			availableHeight,
			widthMode,
			isDefined(availableHeight)
				? "exactly"
				: "unconstrained",
			ownerWidth,
			ownerHeight,
			true,
		);

		roundToGrid(this, 0, 0);
		this.computePaintExtents(0);
		this.dirty = false;
	}
}

function toValue(input: Length): Value {
	if (input === undefined || input === null) {
		return UNDEFINED_VALUE;
	}
	if (typeof input === "object") {
		return {unit: "percent", value: input.percentage};
	}
	if (typeof input === "number") {
		return Number.isNaN(input)
			? UNDEFINED_VALUE
			: {unit: "cell", value: input};
	}
	return AUTO_VALUE;
}

// Browser defaults, not Yoga's: row direction, align-content stretch,
// flex-shrink 1.
function createStyle(): Style {
	return {
		flexDirection: "row",
		justifyContent: "flex-start",
		alignContent: "stretch",
		alignItems: "stretch",
		alignSelf: "auto",
		positionType: "relative",
		flexWrap: "nowrap",
		mode: "flex",

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
		autoMinMain: NaN,
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
		node.style.positionType !== "static" ||
		node.style.mode === "none"
	);
}

function markDirtyUpward(
	start: LayoutNode,
): void {
	for (let node: LayoutNode | null = start; node; node = node.parent) {
		node.dirty = true;
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
		if (child.style.mode === "none") {
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
	return isRow(axis)
		? node.style.gap["column"]
		: node.style.gap["row"];
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
		value.unit === "percent" &&
		(value.value < 0 || Number.isNaN(ownerSize))
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
	mode: {value: number; mode: MeasureMode},
): void {
	const max = resolveValue(
		isRow(axis) ? node.style.maxWidth : node.style.maxHeight,
		ownerAxisSize,
	);
	if (!isDefined(max)) {
		return;
	}

	if (
		mode.mode === "exactly" ||
		mode.mode === "at-most"
	) {
		// A max caps the size without making it indefinite. Downgrading
		// `exactly` to `at-most` tells an empty box it is shrink-wrapped, and
		// it collapses to zero instead of taking the size flex just resolved
		// for it.
		mode.value = isDefined(mode.value) ? Math.min(mode.value, max) : max;
	} else {
		mode.value = max;
		mode.mode = "at-most";
	}
}

function resolveNodeMargins(node: LayoutNode, ownerWidth: number): void {
	node.layout.margin.left = resolveMargin(
		node.style.margin.left,
		ownerWidth,
	);
	node.layout.margin.top = resolveMargin(
		node.style.margin.top,
		ownerWidth,
	);
	node.layout.margin.right = resolveMargin(
		node.style.margin.right,
		ownerWidth,
	);
	node.layout.margin.bottom = resolveMargin(
		node.style.margin.bottom,
		ownerWidth,
	);
}

function setMeasuredDimensions(
	node: LayoutNode,
	width: number,
	height: number,
	ownerWidth: number,
	ownerHeight: number,
): void {
	node.layout.width = boundAxis(
		node,
		"row",
		width,
		ownerWidth,
		ownerWidth,
	);
	node.layout.height = boundAxis(
		node,
		"column",
		height,
		ownerHeight,
		ownerWidth,
	);
}

function layoutMeasureNode(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(
		node,
		"row",
		ownerWidth,
	);
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
		widthMode === "exactly" &&
		heightMode === "exactly" &&
		// Only on a sizing pass. The measure also breaks the text into the
		// lines that get painted, and skipping it on the placing pass left a
		// stretched item painting the lines of its last probe, the min-content
		// one.
		!performLayout
	) {
		setMeasuredDimensions(
			node,
			availableWidth - marginRow,
			availableHeight - marginColumn,
			ownerWidth,
			ownerHeight,
		);
		return;
	}

	const measured = node.measureFunc!(innerWidth, widthMode, performLayout);

	const width =
		widthMode === "exactly"
			? availableWidth - marginRow
			: measured.width + paddingBorderRow;
	const height =
		heightMode === "exactly"
			? availableHeight - marginColumn
			: measured.height + paddingBorderColumn;

	// Not clamped to an `at-most` request. An unbreakable word overflows,
	// and a box claiming less than it occupies made min-content zero and let
	// a long word paint over its neighbour.
	setMeasuredDimensions(node, width, height, ownerWidth, ownerHeight);
}

function layoutEmptyContainer(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);

	const width =
		widthMode === "unconstrained" || widthMode === "at-most"
			? paddingBorderRow
			: availableWidth - marginRow;
	const height =
		heightMode === "unconstrained" ||
		heightMode === "at-most"
			? paddingBorderColumn
			: availableHeight - marginColumn;

	setMeasuredDimensions(node, width, height, ownerWidth, ownerHeight);
}

// css-flexbox-1 §9.2.
function computeFlexBasisForChild(
	node: LayoutNode,
	child: LayoutNode,
	width: number,
	widthMode: MeasureMode,
	height: number,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const mainAxis = node.style.flexDirection;
	const mainIsRow = isRow(mainAxis);
	const mainAxisSize = mainIsRow ? width : height;
	const mainAxisOwnerSize = mainIsRow ? ownerWidth : ownerHeight;

	const basis = resolveFlexBasis(child, mainAxis);
	const resolvedBasis = resolveValue(basis, mainAxisOwnerSize);

	const rowDimDefined = isStyleDimensionDefined(
		child,
		"row",
		ownerWidth,
	);
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

	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	const marginRow = getAxisMargin(child, "row", ownerWidth);
	const marginColumn = getAxisMargin(child, "column", ownerWidth);

	if (rowDimDefined) {
		childWidth.value = resolveValue(child.style.width, ownerWidth) + marginRow;
		childWidth.mode = "exactly";
	}
	if (columnDimDefined) {
		childHeight.value =
			resolveValue(child.style.height, ownerHeight) + marginColumn;
		childHeight.mode = "exactly";
	}

	if (!isDefined(childWidth.value) && isDefined(width)) {
		childWidth.value = width;
		childWidth.mode = "at-most";
	}
	if (!isDefined(childHeight.value) && isDefined(height)) {
		childHeight.value = height;
		childHeight.mode = "at-most";
	}

	const stretch = getAlignSelf(node, child) === "stretch";
	if (
		!mainIsRow &&
		isDefined(width) &&
		widthMode === "exactly" &&
		stretch &&
		childWidth.mode !== "exactly"
	) {
		childWidth.value = width;
		childWidth.mode = "exactly";
	}
	if (
		mainIsRow &&
		isDefined(height) &&
		heightMode === "exactly" &&
		stretch &&
		childHeight.mode !== "exactly"
	) {
		childHeight.value = height;
		childHeight.mode = "exactly";
	}

	constrainMaxSizeForMode(child, "row", ownerWidth, childWidth);
	constrainMaxSizeForMode(
		child,
		"column",
		ownerHeight,
		childHeight,
	);

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
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const mainAxis = node.style.flexDirection;
	const cross = getCrossAxis(mainAxis);
	const mainIsRow = isRow(mainAxis);
	const wrap = node.style.flexWrap !== "nowrap";

	const paddingBorderRow = getAxisPaddingAndBorder(
		node,
		"row",
		ownerWidth,
	);
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

	const innerMain = mainIsRow ? innerWidth : innerHeight;
	const innerCross = mainIsRow ? innerHeight : innerWidth;
	const crossMode = mainIsRow ? heightMode : widthMode;
	const mainMode = mainIsRow ? widthMode : heightMode;

	const mainGap = getAxisGap(node, mainAxis);
	const crossGap = getAxisGap(node, cross);

	const inFlow: LayoutNode[] = [];
	for (const child of node.children) {
		if (child.style.mode === "none") {
			zeroLayout(child);
			continue;
		}
		resolveNodeMargins(child, ownerWidth);

		if (isOutOfFlowType(child.style.positionType)) {
			continue;
		}

		// Before the basis, because this lays the child out and would clobber a
		// basis computed first.
		child.layout.autoMinMain = getAutoMinimumMainSize(
			node,
			child,
			innerCross,
			crossMode,
			ownerWidth,
			ownerHeight,
		);

		computeFlexBasisForChild(
			node,
			child,
			innerWidth,
			widthMode,
			innerHeight,
			heightMode,
			ownerWidth,
			ownerHeight,
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
			const childMarginMain = getAxisMargin(child, mainAxis, ownerWidth);
			const basis = boundAxisWithinMinMax(
				child,
				mainAxis,
				child.layout.computedFlexBasis,
				mainIsRow ? ownerWidth : ownerHeight,
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
			mainMode,
			ownerWidth,
			ownerHeight,
		);

		for (const child of line.items) {
			layoutFlexItem(
				node,
				child,
				innerWidth,
				innerHeight,
				innerCross,
				crossMode,
				ownerWidth,
				ownerHeight,
				performLayout,
			);
		}

		positionMainAxis(
			node,
			line,
			mainForItems,
			leadingPaddingBorderMain,
			mainGap,
			ownerWidth,
			performLayout,
		);

		let lineCross = 0;
		for (const child of line.items) {
			const childCross =
				(isRow(cross) ? child.layout.width : child.layout.height) +
				getAxisMargin(child, cross, ownerWidth);
			lineCross = Math.max(lineCross, childCross);
		}
		// Only a definite cross size fills the line. An `at-most` bound treated
		// as definite becomes the container's content size, then its basis
		// above.
		if (!wrap && isDefined(innerCross) && crossMode === "exactly") {
			lineCross = Math.max(lineCross, innerCross);
		}
		line.crossDim = lineCross;

		totalCrossDim += lineCross;
		maxMainDim = Math.max(maxMainDim, line.mainDim);
	}

	totalCrossDim += crossGap * Math.max(0, lines.length - 1);

	const measuredMain = mainIsRow
		? widthMode === "exactly"
			? availableWidth - marginRow
			: boundAxis(
				node,
				mainAxis,
				maxMainDim + paddingBorderMain,
				ownerWidth,
				ownerWidth,
			)
		: heightMode === "exactly"
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
		? widthMode === "exactly"
		: heightMode === "exactly";
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
		ownerWidth,
		ownerHeight,
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
			child.layout.left += getRelativeOffset(
				child,
				"row",
				innerWidthFinal,
			);
			child.layout.top += getRelativeOffset(
				child,
				"column",
				innerHeightFinal,
			);
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
			if (child.style.mode === "none") {
				continue;
			}
			const type = child.style.positionType;
			const wanted =
				viewport ? "fixed" : "absolute";
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
	mainMode: MeasureMode,
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
		const floor = child.layout.autoMinMain;
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

	// Growing needs a definite main size. Under `at-most` the container
	// shrink-wraps. Shrinking still applies.
	if (growing && mainMode !== "exactly") {
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
	crossMode: MeasureMode,
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
	const crossMeasureMode = isDefined(innerCross)
		? crossMode
		: "unconstrained";

	layoutNode(
		child,
		mainIsRow ? 0 : crossAvailable,
		mainIsRow ? crossAvailable : 0,
		mainIsRow ? "at-most" : crossMeasureMode,
		mainIsRow ? crossMeasureMode : "at-most",
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
	crossMode: MeasureMode,
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

	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	const marginMainForChild = getAxisMargin(child, mainAxis, ownerWidth);
	const marginCrossForChild = getAxisMargin(child, cross, ownerWidth);

	if (mainIsRow) {
		childWidth.value = mainSize + marginMainForChild;
		childWidth.mode = "exactly";
	} else {
		childHeight.value = mainSize + marginMainForChild;
		childHeight.mode = "exactly";
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
			childWidth.mode = "exactly";
		} else {
			childHeight.value = bounded + marginCrossForChild;
			childHeight.mode = "exactly";
		}
	} else if (
		align === "stretch" &&
		isDefined(innerCross) &&
		crossMode === "exactly"
	) {
		// Only against a definite cross size. Stretching to a bound makes every
		// item's basis the whole container. positionCrossAxis stretches the
		// rest.
		if (isRow(cross)) {
			childWidth.value = innerCross;
			childWidth.mode = "exactly";
		} else {
			childHeight.value = innerCross;
			childHeight.mode = "exactly";
		}
	} else {
		const available = isRow(cross) ? innerWidth : innerHeight;
		if (isDefined(available)) {
			if (isRow(cross)) {
				childWidth.value = available;
				childWidth.mode = "at-most";
			} else {
				childHeight.value = available;
				childHeight.mode = "at-most";
			}
		}
	}

	constrainMaxSizeForMode(child, "row", ownerWidth, childWidth);
	constrainMaxSizeForMode(
		child,
		"column",
		ownerHeight,
		childHeight,
	);

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
		"exactly",
		"exactly",
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
		node.style.alignContent === "stretch" &&
		lineCount > 0 &&
		freeCross > 0
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
				align === "stretch" &&
				!crossDimDefined &&
				!leadingAuto &&
				!trailingAuto
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
	const marginBottom = resolveMargin(
		child.style.margin.bottom,
		basisWidth,
	);

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

	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	if (isStyleDimensionDefined(child, "row", basisWidth)) {
		childWidth.value =
			resolveValue(child.style.width, basisWidth) + marginLeft + marginRight;
		childWidth.mode = "exactly";
	} else if (shrinkAcross) {
		childWidth.value = blockWidth - left - right;
		childWidth.mode = "at-most";
	} else if (isDefined(left) && isDefined(right)) {
		childWidth.value = blockWidth - left - right - marginLeft - marginRight;
		childWidth.mode = "exactly";
	} else if (isDefined(blockWidth)) {
		childWidth.value = blockWidth;
		// `stretch` fills the alignment container when size and both insets are
		// auto (css-align-3 §5.2). Only a grid area has one.
		childWidth.mode =
			area && getGridSelfAlign(node, child, true) === "stretch"
				? "exactly"
				: "at-most";
	}

	if (isStyleDimensionDefined(child, "column", basisHeight)) {
		childHeight.value =
			resolveValue(child.style.height, basisHeight) + marginTop + marginBottom;
		childHeight.mode = "exactly";
	} else if (shrinkDown) {
		childHeight.value = blockHeight - top - bottom;
		childHeight.mode = "at-most";
	} else if (isDefined(top) && isDefined(bottom)) {
		childHeight.value = blockHeight - top - bottom - marginTop - marginBottom;
		childHeight.mode = "exactly";
	} else if (isDefined(blockHeight)) {
		childHeight.value = blockHeight;
		childHeight.mode =
			area && getGridSelfAlign(node, child, false) === "stretch"
				? "exactly"
				: "at-most";
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
			? (child.staticPositionFunc?.(node) ?? null)
			: null;

	const isGrid = node.style.mode === "grid";

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
					: node.style.justifyContent === "flex-end"
						? "flex-end"
						: "flex-start"
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
					: node.style.alignItems === "flex-end"
						? "flex-end"
						: "flex-start"
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
			if (child.style.mode === "table-row") {
				into.push({node: child, group});
			} else {
				zeroLayout(child);
			}
		}
	};

	for (const child of table.children) {
		if (
			child.style.mode === "none" ||
			isOutOfFlowType(child.style.positionType)
		) {
			zeroLayout(child);
			continue;
		}

		switch (child.style.mode) {
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
			if (node.style.mode !== "table-cell") {
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
		minContent ? "at-most" : "unconstrained",
		"unconstrained",
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
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);

	const leftPaddingBorder = getEdgePaddingAndBorder(
		node,
		"left",
		ownerWidth,
	);
	const topPaddingBorder = getEdgePaddingAndBorder(node, "top", ownerWidth);

	const {rows, captions, groups} = collectTableRows(node);
	const {cells, columnCount} = buildTableGrid(rows);

	// Collapsed borders share the one cell both neighbours draw a border in.
	const overlap = node.style.borderCollapse ? 1 : 0;
	const columnOverlap = overlap * Math.max(0, columnCount - 1);

	const innerWidth = isDefined(availableWidth)
		? Math.max(0, availableWidth - marginRow - paddingBorderRow)
		: NaN;

	const widthIsDefinite =
		widthMode === "exactly" && isDefined(innerWidth);

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
			"exactly",
			"unconstrained",
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
			"exactly",
			"unconstrained",
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

	const getRowStart = (index: number) => rowTops[index];
	const spanHeight = (index: number, span: number) => {
		const last = Math.min(index + span, rows.length) - 1;
		return rowTops[last] + rowHeights[last] - rowTops[index];
	};

	const gridHeight = Math.max(0, cursor);
	const contentHeight = captionHeight + gridHeight;

	const width =
		widthMode === "exactly"
			? availableWidth - marginRow
			: contentWidth + paddingBorderRow;
	const height =
		heightMode === "exactly"
			? availableHeight - marginColumn
			: contentHeight + paddingBorderColumn;

	setMeasuredDimensions(node, width, height, ownerWidth, ownerHeight);

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
			? getRowStart(index)
			: gridTop + getRowStart(index);
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
			"exactly",
			"exactly",
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
	getRowStart: number;
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
			: end.kind === "span" || end.kind === "spanName"
				? end.count
				: 1;
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
		: [item.getRowStart, item.rowEnd];
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
			minContent ? "at-most" : "unconstrained",
			"unconstrained",
			sizing.ownerWidth,
			sizing.ownerHeight,
			false,
		);
		return (
			child.layout.width +
			getAxisMargin(child, "row", sizing.ownerWidth)
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
		"exactly",
		"unconstrained",
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
		const group = rows.get(item.getRowStart);
		if (group) {
			group.push(item);
		} else {
			rows.set(item.getRowStart, [item]);
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
				"exactly",
				"unconstrained",
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
			? track.growthLimit === Infinity
				? track.base
				: track.growthLimit
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

	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	if (isStyleDimensionDefined(child, "row", ownerWidth)) {
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				"row",
				resolveValue(child.style.width, ownerWidth),
				areaWidth,
			) + marginRow;
		childWidth.mode = "exactly";
	} else if (justify === "stretch" && !autoLeft && !autoRight) {
		// The request includes the item's margins, which the box subtracts
		// itself.
		childWidth.value = Math.max(0, areaWidth);
		childWidth.mode = "exactly";
	} else {
		childWidth.value = Math.max(0, areaWidth);
		childWidth.mode = "at-most";
	}

	if (isStyleDimensionDefined(child, "column", ownerHeight)) {
		childHeight.value =
			boundAxisWithinMinMax(
				child,
				"column",
				resolveValue(child.style.height, ownerHeight),
				areaHeight,
			) + marginColumn;
		childHeight.mode = "exactly";
	} else if (align === "stretch" && !autoTop && !autoBottom) {
		childHeight.value = Math.max(0, areaHeight);
		childHeight.mode = "exactly";
	} else {
		childHeight.value = Math.max(0, areaHeight);
		childHeight.mode = "at-most";
	}

	constrainMaxSizeForMode(child, "row", ownerWidth, childWidth);
	constrainMaxSizeForMode(
		child,
		"column",
		ownerHeight,
		childHeight,
	);

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
		const group = rows.get(item.getRowStart);
		if (group) {
			group.push(item);
		} else {
			rows.set(item.getRowStart, [item]);
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
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(
		node,
		"row",
		ownerWidth,
	);
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

	const definiteWidth =
		widthMode === "exactly" && isDefined(innerWidth);
	const definiteHeight =
		heightMode === "exactly" && isDefined(innerHeight);

	const children: LayoutNode[] = [];
	for (const child of node.children) {
		if (child.style.mode === "none") {
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
		getRowStart: 0,
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
		item.getRowStart = item.row.start! - rowBase;
		item.rowEnd = item.getRowStart + item.row.span;
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
		for (let i = item.getRowStart; i < item.rowEnd; i++) {
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
		widthMode === "at-most" &&
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
		heightMode === "at-most" &&
		isDefined(innerHeight) &&
		rowsTotal > innerHeight + EPSILON
	) {
		rowTracks = sizeRows(innerHeight);
		rowsTotal = totalOf(rowTracks, rowGap);
	}

	const width =
		widthMode === "exactly"
			? availableWidth - marginRow
			: boundAxis(
				node,
				"row",
				columnsTotal + paddingBorderRow,
				ownerWidth,
				ownerWidth,
			);
	const height =
		heightMode === "exactly"
			? availableHeight - marginColumn
			: boundAxis(
				node,
				"column",
				rowsTotal + paddingBorderColumn,
				ownerHeight,
				ownerWidth,
			);

	setMeasuredDimensions(node, width, height, ownerWidth, ownerHeight);

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
		const areaTop = lineStart(rowTracks, item.getRowStart);
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
		child.layout.left += getRelativeOffset(
			child,
			"row",
			usedInnerWidth,
		);
		child.layout.top += getRelativeOffset(
			child,
			"column",
			usedInnerHeight,
		);
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
	const paddingRight = Math.max(
		0,
		node.layout.width - node.style.border.right,
	);
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
		node.style.mode === "table" ||
		node.style.widthSizing !== "none"
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

	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	if (isStyleDimensionDefined(child, "row", ownerWidth)) {
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				"row",
				resolveValue(child.style.width, ownerWidth),
				contentWidth,
			) + marginRow;
		childWidth.mode = "exactly";
	} else if (
		isDefined(child.style.aspectRatio) &&
		child.style.aspectRatio > 0 &&
		isStyleDimensionDefined(child, "column", ownerHeight)
	) {
		// A transferred width beats fill. The box is as wide as its ratio
		// says, not as wide as the container (css-sizing-4 §5).
		const transferred =
			resolveValue(child.style.height, ownerHeight) *
			child.style.aspectRatio;
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				"row",
				transferred,
				contentWidth,
			) + marginRow;
		childWidth.mode = "exactly";
	} else if (child.style.widthSizing === "min-content") {
		childWidth.value = 0;
		childWidth.mode = "at-most";
	} else if (child.style.widthSizing === "max-content") {
		// An undefined request measures the content unbroken.
	} else if (isDefined(contentWidth)) {
		// A non-filling child's `at-most` request is already fit-content.
		childWidth.value = contentWidth;
		childWidth.mode = fill ? "exactly" : "at-most";
	}

	if (isStyleDimensionDefined(child, "column", ownerHeight)) {
		childHeight.value =
			resolveValue(child.style.height, ownerHeight) + marginColumn;
		childHeight.mode = "exactly";
	}

	constrainMaxSizeForMode(child, "row", ownerWidth, childWidth);
	constrainMaxSizeForMode(
		child,
		"column",
		ownerHeight,
		childHeight,
	);

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
	return child.measureFunc !== null && child.layout.height === 0;
}

function isFillingBlockChild(child: LayoutNode): boolean {
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
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const paddingBorderRow = getAxisPaddingAndBorder(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = getAxisPaddingAndBorder(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = getAxisMargin(node, "row", ownerWidth);
	const marginColumn = getAxisMargin(node, "column", ownerWidth);
	const leftPaddingBorder = getEdgePaddingAndBorder(
		node,
		"left",
		ownerWidth,
	);
	const topPaddingBorder = getEdgePaddingAndBorder(node, "top", ownerWidth);

	const inFlow: LayoutNode[] = [];
	for (const child of node.children) {
		if (child.style.mode === "none") {
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

	// The width is resolved before the children lay out, min/max included,
	// so each is measured once at the width it keeps.
	let borderBoxWidth: number;
	if (widthMode === "exactly") {
		borderBoxWidth = availableWidth - marginRow;
	} else {
		let widest = 0;
		for (const child of inFlow) {
			layoutBlockChild(
				child,
				innerWidth,
				false,
				ownerWidth,
				ownerHeight,
				false,
			);
			widest = Math.max(
				widest,
				child.layout.width +
				getAxisMargin(child, "row", ownerWidth),
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
		heightMode !== "exactly" &&
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
		layoutBlockChild(
			child,
			contentWidth,
			isFillingBlockChild(child),
			ownerWidth,
			ownerHeight,
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
		heightMode === "exactly"
			? availableHeight - marginColumn
			: Math.max(0, contentHeight) + paddingBorderColumn;

	setMeasuredDimensions(node, borderBoxWidth, height, ownerWidth, ownerHeight);

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
		child.layout.left += getRelativeOffset(
			child,
			"row",
			innerWidthFinal,
		);
		child.layout.top += getRelativeOffset(
			child,
			"column",
			innerHeightFinal,
		);
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
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	// css-sizing-4 §5: the open axis follows a settled (`exactly`) one
	// through the ratio. With both settled the ratio yields. Margins come
	// off the settled request and back onto the derived one. min/max on the
	// derived axis still clamp in setMeasuredDimensions.
	const ratio = node.style.aspectRatio;
	if (isDefined(ratio) && ratio > 0) {
		const marginRow = getAxisMargin(node, "row", ownerWidth);
		const marginColumn = getAxisMargin(
			node,
			"column",
			ownerWidth,
		);
		if (
			widthMode === "exactly" &&
			heightMode !== "exactly" &&
			isDefined(availableWidth)
		) {
			availableHeight = (availableWidth - marginRow) / ratio + marginColumn;
			heightMode = "exactly";
		} else if (
			heightMode === "exactly" &&
			widthMode !== "exactly" &&
			isDefined(availableHeight)
		) {
			availableWidth = (availableHeight - marginColumn) * ratio + marginRow;
			widthMode = "exactly";
		}
	}

	// A clean node under a request it has already satisfied restores its
	// size and skips its whole subtree. A full layout satisfies a sizing
	// query. A sizing result never satisfies a layout query, since it
	// placed no children.
	if (!node.dirty) {
		let hit: CachedLayout | null = null;
		if (
			node.cachedLayout &&
			isMatchingConstraints(
				node.cachedLayout,
				availableWidth,
				availableHeight,
				widthMode,
				heightMode,
				ownerWidth,
				ownerHeight,
			)
		) {
			hit = node.cachedLayout;
		} else if (!performLayout) {
			// Margins are outside the size a measurement returns, so both
			// requests are reduced to their content side before being compared.
			const marginRow = getAxisMargin(node, "row", ownerWidth);
			const marginColumn = getAxisMargin(
				node,
				"column",
				ownerWidth,
			);
			for (const cached of node.cachedMeasures) {
				if (
					cached !== null &&
					isSameConstraint(cached.ownerWidth, ownerWidth) &&
					isSameConstraint(cached.ownerHeight, ownerHeight) &&
					cached.width >= 0 &&
					cached.height >= 0 &&
					isCachedSizeValid(
						cached.widthMode,
						cached.availableWidth - marginRow,
						cached.width,
						widthMode,
						availableWidth - marginRow,
					) &&
					isCachedSizeValid(
						cached.heightMode,
						cached.availableHeight - marginColumn,
						cached.height,
						heightMode,
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
	if (node.dirty) {
		node.cachedLayout = null;
		node.cachedMeasures.fill(null);
	}

	layoutNodeImpl(
		node,
		availableWidth,
		availableHeight,
		widthMode,
		heightMode,
		ownerWidth,
		ownerHeight,
		performLayout,
	);

	const entry: CachedLayout = {
		availableWidth,
		availableHeight,
		widthMode,
		heightMode,
		ownerWidth,
		ownerHeight,
		width: node.layout.width,
		height: node.layout.height,
	};
	if (performLayout) {
		node.cachedLayout = entry;
	} else {
		node.cachedMeasures[
			getCacheSlot(availableWidth, availableHeight, widthMode, heightMode)
		] = entry;
	}
	node.dirty = false;
}

function layoutNodeImpl(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
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
	if (node.style.mode !== "grid") {
		node.layout.gridColumns = null;
		node.layout.gridRows = null;
	}

	if (node.style.mode === "none") {
		zeroLayout(node);
		return;
	}

	if (node.measureFunc) {
		layoutMeasureNode(
			node,
			availableWidth,
			availableHeight,
			widthMode,
			heightMode,
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		return;
	}

	if (node.style.mode === "grid") {
		layoutGrid(
			node,
			availableWidth,
			availableHeight,
			widthMode,
			heightMode,
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		return;
	}

	if (node.style.mode === "table") {
		layoutTable(
			node,
			availableWidth,
			availableHeight,
			widthMode,
			heightMode,
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		return;
	}

	// A cell and a caption are block containers for their own content.
	if (
		node.style.mode === "block" ||
		node.style.mode === "table-cell" ||
		node.style.mode === "table-caption"
	) {
		layoutBlock(
			node,
			availableWidth,
			availableHeight,
			widthMode,
			heightMode,
			ownerWidth,
			ownerHeight,
			performLayout,
		);
		return;
	}

	const hasInFlowChild = node.children.some(
		(child) =>
			child.style.mode !== "none" &&
			!isOutOfFlowType(child.style.positionType),
	);

	if (!hasInFlowChild && node.children.length === 0) {
		layoutEmptyContainer(
			node,
			availableWidth,
			availableHeight,
			widthMode,
			heightMode,
			ownerWidth,
			ownerHeight,
		);
		return;
	}

	layoutFlexbox(
		node,
		availableWidth,
		availableHeight,
		widthMode,
		heightMode,
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

	const isText = node.measureFunc !== null;

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

function createTreeWalker(
	root: Node,
	filter: ((node: Node) => number) | null = null,
): TreeWalker {
	// Elements and text over the flat tree. Comments and processing
	// instructions generate no box and must not hide the content around
	// them.
	return new TreeWalker(
		root as never,
		NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | SHOW_FLAT,
		filter as never,
	);
}

type Position =
	"static" |
	"relative" |
	"absolute" |
	"fixed" |
	"sticky";

const POSITIONS = new Set<string>([
	"static",
	"relative",
	"absolute",
	"fixed",
	"sticky",
]);

function getPosition(element: Element): Position {
	const value = getComputedValue(element, "position");
	return POSITIONS.has(value) ? (value as Position) : "static";
}

export function isPositioned(element: Element): boolean {
	return getPosition(element) !== "static";
}

// fixed is approximated as absolute against the initial containing block.
function isOutOfFlow(node: Node): boolean {
	if (node.nodeType !== node.ELEMENT_NODE) {
		return false;
	}
	const position = getPosition(node as Element);
	return position === "absolute" || position === "fixed";
}

// display:contents generates no box. The UA sheet gives slots this, so
// a slot vanishes from layout while its projected content flows
// through.
function isDisplayContents(node: Node): boolean {
	return getComputedDisplay(node as Element) === "contents";
}

type Display =
	"none" |
	"contents" |
	"block" |
	"inline" |
	"inline-block" |
	"inline-flex" |
	"inline-grid" |
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

// display has two axes (css-display-3 §2), and blockification (§2.7) changes
// only the OUTER one. An absolutely positioned inline-grid sits on rows of its
// own and is still a grid inside. So the outer question (is this box on a line)
// goes through `isInlineLevel`, which reads the USED display, and the inner
// ones (hasItemChildren, isGridDisplay, isFlexContainer,
// establishesIndependentFormattingContext) read the COMPUTED one. Asking an
// outer question of the computed display put out-of-flow boxes back on lines
// they had left. `none` and `contents` are on neither axis and are used as
// computed.
function getComputedDisplay(element: Element): Display {
	const value = getComputedValue(element, "display");
	return DISPLAYS.has(value) ? (value as Display) : "block";
}

// A box that sits on a line whole, measured as one opaque unit.
function isAtomicInline(display: Display): boolean {
	return display === "inline-block" || display === "inline-grid";
}

// About a display value. For a node, ask isInlineLevel.
function isInlineDisplay(display: Display): boolean {
	return display === "inline" || isAtomicInline(display);
}

function isFlexContainer(element: Element): boolean {
	const display = getComputedDisplay(element);
	return display === "flex" || display === "inline-flex";
}

// Each child gets a box of its own, getBlockifiedDisplay. No inline run gathers
// across them (css-display-3 §2.7).
function hasItemChildren(display: Display): boolean {
	return display === "flex" || isGridDisplay(display);
}

function isGridDisplay(display: Display): boolean {
	return display === "grid" || display === "inline-grid";
}

function hasFlexParent(element: Element): boolean {
	const parent = element.parentElement;
	return parent !== null && getComputedDisplay(parent) === "flex";
}

function hasItemParent(element: Element): boolean {
	const parent = element.parentElement;
	return parent !== null && hasItemChildren(getComputedDisplay(parent));
}

// css-display-3 §2.7.
function isBlockified(element: Element): boolean {
	return isOutOfFlow(element) || hasItemParent(element);
}

function getUsedDisplay(element: Element): Display {
	const display = getComputedDisplay(element);
	if (!isInlineDisplay(display)) {
		return display;
	}
	return isBlockified(element) ? "block" : display;
}

function isInlineLevel(node: Node): boolean {
	if (node.nodeType === node.TEXT_NODE) {
		return true;
	}
	if (node.nodeType !== node.ELEMENT_NODE) {
		return false;
	}
	return isInlineDisplay(getUsedDisplay(node as Element));
}

// Computed display, not used. A flex item's inline-block is
// getBlockifiedDisplay off its line but still measures its content as one unit
// under a root of its own, and the used display would take that root away.
function establishesIndependentFormattingContext(element: Element): boolean {
	return isAtomicInline(getComputedDisplay(element));
}

// A getBlockifiedDisplay inline holding block-level content is a block
// container. Measured as a run, its content would end at the first
// block inside it. One holding only inline content still measures as a
// run, which is what gives a flex item its intrinsic size.
function isMeasuredAsRun(element: Element): boolean {
	if (isOutOfFlow(element)) {
		return false;
	}
	const display = getComputedDisplay(element);
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
	if (getComputedDisplay(element) !== "inline") {
		return false;
	}
	// A grid item is already a block container. Handing its content to the
	// grid would put its own children in cells of their own.
	const parent = element.parentElement;
	if (parent && isGridDisplay(getComputedDisplay(parent))) {
		return false;
	}
	return hasBlockLevelBox(element);
}

function hasBlockLevelBox(element: Element): boolean {
	const walker = flowWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (child.nodeType !== child.ELEMENT_NODE) {
			continue;
		}
		const childElement = child as Element;
		if (isOutOfFlow(childElement)) {
			continue;
		}
		const display = getComputedDisplay(childElement);
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

const COLLAPSIBLE_RUN = /\s+/g;
const PRE_LINE_RUN = /[^\S\n]+/g;

// Whether rendering would change anything: two collapsible characters
// in a row, or one that is not already the space it collapses to.
const COLLAPSES = /\s\s|[^\S ]/;
const PRE_LINE_COLLAPSES = /[^\S\n][^\S\n]|[^\S\n ]/;

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

/** The characters one line fragment paints, in the line's visual order. */
export function renderTextFragment(
	data: string,
	whiteSpace: string,
	startOffset: number,
	endOffset: number,
	visualBase?: "ltr" | "rtl" | null,
): string {
	const text = renderWhiteSpace(data.slice(startOffset, endOffset), whiteSpace);
	return visualBase ? toVisualOrder(text, visualBase) : text;
}

// White space renders nothing where the run it would open has no
// content to sit beside (css2 §9.4.2 with css-text-3 §4.1.1).
function shouldCollapseWhitespaceTextNode(textNode: Text): boolean {
	if (!textNode.textContent || !/^\s*$/.test(textNode.textContent)) {
		return false;
	}

	const parent = textNode.parentElement;
	if (!parent) {
		return false;
	}

	// Under the preserving values a space is content. A card's blank
	// middle row is three spaces, and this is what makes it a row. Under
	// pre-line a newline is a forced break and keeps its line.
	const whiteSpace = getComputedValue(parent, "white-space");
	if (isSpacePreserving(whiteSpace)) {
		return false;
	}
	if (whiteSpace === "pre-line" && textNode.textContent.includes("\n")) {
		return false;
	}

	// Inside an inline box the space is on a line with content, and is a
	// space.
	if (isInlineDisplay(getComputedDisplay(parent))) {
		return false;
	}

	// A comment generates no box, so it is never what the space sits next
	// to.
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

	// USED display. An out-of-flow box takes no part in the flow, and
	// white space beside one has nothing to sit next to, as if it were not
	// written.
	const isBlockLevel = (node: Node | null): boolean => {
		if (!node || node.nodeType !== node.ELEMENT_NODE) {
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
// justify-content space.
function isSuppressedFlexWhitespace(text: Text): boolean {
	const parent = text.parentElement;
	if (!parent) {
		return false;
	}
	if (!hasItemChildren(getComputedDisplay(parent))) {
		return false;
	}
	if (isSpacePreserving(getComputedValue(parent, "white-space"))) {
		return false;
	}
	for (let node: Node | null = text; node; node = node.nextSibling) {
		if (node.nodeType === node.TEXT_NODE) {
			if ((node as Text).data.trim() !== "") {
				return false;
			}
			continue;
		}
		if (node.nodeType !== node.ELEMENT_NODE) {
			continue;
		}
		// USED display. A getBlockifiedDisplay item opens a box of its own
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

function asFlexDirection(value: string): FlexDirection {
	return DIRECTIONS.has(value) ? (value as FlexDirection) : "row";
}

function asWrap(value: string): Wrap {
	return WRAPS.has(value) ? (value as Wrap) : "nowrap";
}

// Left unset, never pinned to 0. min-width auto is a flex item's
// content-based minimum, and 0 lets it shrink under its own text.
function applyMinMax(layoutNode: LayoutNode, element: Element): void {
	layoutNode.setMinWidth(
		parseUnitValue(getComputedValue(element, "min-width")),
	);
	layoutNode.setMinHeight(
		parseUnitValue(getComputedValue(element, "min-height")),
	);
	layoutNode.setMaxWidth(
		parseUnitValue(getComputedValue(element, "max-width")),
	);
	layoutNode.setMaxHeight(
		parseUnitValue(getComputedValue(element, "max-height")),
	);
}

const INSET_EDGES = ["left", "top", "right", "bottom"] as const;

// `auto` is a declaration only an absolute box acts on ("wherever the
// box would have been"). A relative or fixed box takes no offset on that
// edge.
function applyInsets(
	layoutNode: LayoutNode,
	element: Element,
	edges: readonly Edge[],
	autoWhenUnset: boolean,
): void {
	for (const edge of edges) {
		const value = parseUnitValue(getComputedValue(element, edge));
		if (value !== null) {
			layoutNode.setPosition(edge, value);
		} else if (autoWhenUnset) {
			const declared = getComputedValue(element, edge);
			if (declared === "auto" || !declared) {
				layoutNode.setPosition(edge, "auto");
			}
		}
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

function getAlignmentKeyword(value: string): string {
	const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
	while (
		tokens.length > 1 &&
		(tokens[0] === "safe" ||
			tokens[0] === "unsafe" ||
			tokens[0] === "first" ||
			tokens[0] === "last")
	) {
		tokens.shift();
	}
	return tokens[0] ?? "";
}

function getAlignmentConstant(value: string, fallback: Align): Align {
	if (!value || value === "auto") {
		return fallback;
	}
	const constant = ALIGNMENT_CONSTANTS[getAlignmentKeyword(value)];
	return constant === undefined ? fallback : constant;
}

function getJustifyContentConstant(value: string): Justify {
	const constant = JUSTIFY_CONTENT_CONSTANTS[getAlignmentKeyword(value)];
	return constant === undefined ? "normal" : constant;
}

function applyGridContainer(layoutNode: LayoutNode, element: Element): void {
	layoutNode.setGridTemplateColumns(
		parseTrackList(getComputedValue(element, "grid-template-columns")),
	);
	layoutNode.setGridTemplateRows(
		parseTrackList(getComputedValue(element, "grid-template-rows")),
	);
	layoutNode.setGridTemplateAreas(
		parseGridAreas(getComputedValue(element, "grid-template-areas")),
	);
	layoutNode.setGridAutoColumns(
		parseTrackSizeList(getComputedValue(element, "grid-auto-columns")),
	);
	layoutNode.setGridAutoRows(
		parseTrackSizeList(getComputedValue(element, "grid-auto-rows")),
	);

	const flow = getComputedValue(element, "grid-auto-flow")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	layoutNode.setGridAutoFlow(flow.includes("column"), flow.includes("dense"));

	layoutNode.setJustifyContent(
		getJustifyContentConstant(getComputedValue(element, "justify-content")),
	);
	layoutNode.setAlignContent(
		getAlignmentConstant(
			getComputedValue(element, "align-content"),
			"normal",
		),
	);
	layoutNode.setAlignItems(
		getAlignmentConstant(
			getComputedValue(element, "align-items"),
			"normal",
		),
	);
	layoutNode.setJustifyItems(
		getAlignmentConstant(
			getComputedValue(element, "justify-items"),
			"normal",
		),
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

function styleLayoutNode(
	element: Element,
	layoutNode: LayoutNode,
	positionedElements?: Set<Element>,
): void {
	layoutNode.styleAll(() => {
		styleLayoutNodeProperties(element, layoutNode, positionedElements);
	});
}

function styleLayoutNodeProperties(
	element: Element,
	layoutNode: LayoutNode,
	positionedElements?: Set<Element>,
): void {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element must have an ownerDocument with defaultView");
	}

	const display = getComputedDisplay(element);
	// A getBlockifiedDisplay inline's width applies like any block's. Forced
	// auto, `<span style="width:30ch">` in a flex row came out as wide as its
	// text.
	const parentIsFlex = hasItemParent(element);
	if (display === "inline" && !parentIsFlex) {
		layoutNode.setWidth("auto");
		layoutNode.setWidthSizing("none");
		layoutNode.setHeight("auto");
		layoutNode.setMinWidth(undefined);
		layoutNode.setMinHeight(undefined);
		layoutNode.setMaxWidth(undefined);
		layoutNode.setMaxHeight(undefined);
	} else if (isAtomicInline(display)) {
		layoutNode.setWidth("auto");
		layoutNode.setWidthSizing("none");
		layoutNode.setHeight("auto");

		applyMinMax(layoutNode, element);
	} else {
		const widthValue = getComputedValue(element, "width");
		const width = parseUnitValue(widthValue);
		layoutNode.setWidth(
			typeof width === "number"
				? width + getContentBoxEdges(element, false)
				: (width ?? "auto"),
		);
		layoutNode.setWidthSizing(getWidthSizingConstant(widthValue));

		const height = parseUnitValue(getComputedValue(element, "height"));
		layoutNode.setHeight(
			typeof height === "number"
				? height + getContentBoxEdges(element, true)
				: (height ?? "auto"),
		);

		applyMinMax(layoutNode, element);
	}

	// An aspect ratio sizes a box, which an inline box is not.
	if (display === "inline" && !parentIsFlex) {
		layoutNode.setAspectRatio(undefined);
	} else {
		layoutNode.setAspectRatio(
			parseAspectRatio(getComputedValue(element, "aspect-ratio")),
		);
	}

	// A getBlockifiedDisplay inline flex item keeps its padding, margin and
	// border like any block (css-display-3 §2.7). Without the parentIsFlex
	// exception, `.row{display:flex} .row span{padding:1}` dropped the span's
	// padding.
	if (display === "inline" && !parentIsFlex) {
		layoutNode.setMargin("top", 0);
		layoutNode.setMargin("right", 0);
		layoutNode.setMargin("bottom", 0);
		layoutNode.setMargin("left", 0);

		layoutNode.setPadding("top", 0);
		layoutNode.setPadding("right", 0);
		layoutNode.setPadding("bottom", 0);
		layoutNode.setPadding("left", 0);

		layoutNode.setBorder("top", 0);
		layoutNode.setBorder("right", 0);
		layoutNode.setBorder("bottom", 0);
		layoutNode.setBorder("left", 0);
	} else {
		for (const edge of ["top", "right", "bottom", "left"] as const) {
			const property = `margin-${edge}`;
			const margin = parseSignedUnitValue(getComputedValue(element, property));
			layoutNode.setMargin(
				edge,
				margin ??
				(getComputedValue(element, property) === "auto"
					? "auto"
					: undefined),
			);
			layoutNode.setPadding(
				edge,
				parseUnitValue(getComputedValue(element, `padding-${edge}`)),
			);
		}

		// The used width is 0 when the side's style is none or hidden
		// (css-backgrounds §3.3), the same rule as getBoxModel, or the two box
		// models disagree about the same element.
		const usedBorderWidth = (side: string) => {
			const style = getComputedValue(element, `border-${side}-style`);
			if (!style || style === "none" || style === "hidden") {
				return null;
			}
			return parseBorderWidthValue(
				getComputedValue(element, `border-${side}-width`),
			);
		};
		const borderTopWidth = usedBorderWidth("top");
		if (typeof borderTopWidth === "number" && borderTopWidth > 0) {
			layoutNode.setBorder("top", borderTopWidth);
		} else {
			layoutNode.setBorder("top", 0);
		}

		const borderRightWidth = usedBorderWidth("right");
		if (typeof borderRightWidth === "number" && borderRightWidth > 0) {
			layoutNode.setBorder("right", borderRightWidth);
		} else {
			layoutNode.setBorder("right", 0);
		}

		const borderBottomWidth = usedBorderWidth("bottom");
		if (typeof borderBottomWidth === "number" && borderBottomWidth > 0) {
			layoutNode.setBorder("bottom", borderBottomWidth);
		} else {
			layoutNode.setBorder("bottom", 0);
		}

		const borderLeftWidth = usedBorderWidth("left");
		if (typeof borderLeftWidth === "number" && borderLeftWidth > 0) {
			layoutNode.setBorder("left", borderLeftWidth);
		} else {
			layoutNode.setBorder("left", 0);
		}
	}

	// An inline-block flex item's measure returns a border-box size, so
	// the layout node must not add padding+border again on the cross axis (a
	// bordered textarea in a flex row came out too tall). The main axis is
	// masked by flex sizing.
	if (display === "inline-block" && hasFlexParent(element)) {
		const direction = getComputedValue(
			element.parentElement!,
			"flex-direction",
		);
		const crossEdges: readonly Edge[] =
			direction === "column" || direction === "column-reverse"
				? ["left", "right"]
				: ["top", "bottom"];
		for (const edge of crossEdges) {
			layoutNode.setPadding(edge, 0);
			layoutNode.setBorder(edge, 0);
		}
	}

	// Item properties apply whatever the parent is and are simply not
	// consulted outside a flex container, which is what CSS says of them.
	const flexGrow = getComputedValue(element, "flex-grow");
	const growValue = parseFloat(flexGrow);
	if (!isNaN(growValue) && growValue >= 0) {
		layoutNode.setFlexGrow(growValue);
	} else {
		layoutNode.setFlexGrow(undefined);
	}

	const orderValue = parseInt(getComputedValue(element, "order"), 10);
	layoutNode.setOrder(Number.isNaN(orderValue) ? undefined : orderValue);

	const flexShrink = getComputedValue(element, "flex-shrink");
	const shrinkValue = parseFloat(flexShrink);
	if (!isNaN(shrinkValue) && shrinkValue >= 0) {
		layoutNode.setFlexShrink(shrinkValue);
	} else {
		layoutNode.setFlexShrink(undefined);
	}

	const flexBasis = parseUnitValue(
		getComputedValue(element, "flex-basis"),
	);
	layoutNode.setFlexBasis(
		flexBasis ??
		(getComputedValue(element, "flex-basis") === "auto"
			? "auto"
			: undefined),
	);

	const alignSelf = getComputedValue(element, "align-self");
	layoutNode.setAlignSelf(getAlignmentConstant(alignSelf, "auto"));
	layoutNode.setJustifySelf(
		getAlignmentConstant(
			getComputedValue(element, "justify-self"),
			"auto",
		),
	);

	layoutNode.setGridRowStart(
		parseGridPlacement(getComputedValue(element, "grid-row-start")),
	);
	layoutNode.setGridRowEnd(
		parseGridPlacement(getComputedValue(element, "grid-row-end")),
	);
	layoutNode.setGridColumnStart(
		parseGridPlacement(getComputedValue(element, "grid-column-start")),
	);
	layoutNode.setGridColumnEnd(
		parseGridPlacement(getComputedValue(element, "grid-column-end")),
	);

	// The gap shorthand is expanded in the cascade. The longhands are
	// enough.
	const rowGap = parseUnitValue(getComputedValue(element, "row-gap"));
	if (typeof rowGap === "number") {
		layoutNode.setGap("row", rowGap);
	}

	const columnGap = parseUnitValue(
		getComputedValue(element, "column-gap"),
	);
	if (typeof columnGap === "number") {
		layoutNode.setGap("column", columnGap);
	}

	if (display === "none") {
		layoutNode.setMode("none");
	} else if (display === "grid" || display === "inline-grid") {
		layoutNode.setMode("grid");
		applyGridContainer(layoutNode, element);
	} else if (display === "flex") {
		layoutNode.setMode("flex");
	} else if (display === "table") {
		layoutNode.setMode("table");
		layoutNode.setBorderCollapse(
			getComputedValue(element, "border-collapse") === "collapse",
		);
	} else if (display === "table-header-group") {
		layoutNode.setMode("table-header-group");
	} else if (display === "table-footer-group") {
		layoutNode.setMode("table-footer-group");
	} else if (display === "table-row-group") {
		layoutNode.setMode("table-row-group");
	} else if (display === "table-caption") {
		layoutNode.setMode("table-caption");
	} else if (
		display === "table-column" || display === "table-column-group"
	) {
		// Columns carry style, not a box of their own.
		layoutNode.setMode("none");
	} else if (display === "table-row") {
		layoutNode.setMode("table-row");
	} else if (display === "table-cell") {
		layoutNode.setMode("table-cell");
		// The reflected properties carry HTML's ranges. rowspan 0 ("to the end
		// of the row group") is not implemented. Such a cell covers one row.
		const cell = element as {colSpan?: number; rowSpan?: number};
		layoutNode.setColSpan(cell.colSpan ?? 1);
		layoutNode.setRowSpan(Math.max(1, cell.rowSpan ?? 1));

		// A cell with no horizontal padding gets one cell either side, so
		// neighbouring columns' text does not run together.
		const paddingLeft = getComputedValue(element, "padding-left");
		const paddingRight = getComputedValue(element, "padding-right");
		if (!paddingLeft || paddingLeft === "0px") {
			layoutNode.setPadding("left", 1);
		}
		if (!paddingRight || paddingRight === "0px") {
			layoutNode.setPadding("right", 1);
		}
	}

	if (display === "flex") {
		layoutNode.setFlexDirection(
			asFlexDirection(getComputedValue(element, "flex-direction")),
		);
		layoutNode.setFlexWrap(
			asWrap(getComputedValue(element, "flex-wrap")),
		);
		layoutNode.setJustifyContent(
			getJustifyContentConstant(
				getComputedValue(element, "justify-content"),
			),
		);
		layoutNode.setAlignItems(
			getAlignmentConstant(
				getComputedValue(element, "align-items"),
				"stretch",
			),
		);
		layoutNode.setAlignContent(
			getAlignmentConstant(
				getComputedValue(element, "align-content"),
				"flex-start",
			),
		);
	} else if (
		display !== "none" &&
		display !== "grid" &&
		display !== "inline-grid" &&
		!TABLE_DISPLAYS.has(display)
	) {
		// Displays decided above must not be reset. A caption reset to block
		// is lost to its table, and a hidden element reset keeps painting.
		layoutNode.setMode("block");
	}

	// Only block and list-item join the formatting context around them
	// (css2 §8.3.1, §9.4.1). BODY is the box the document scroll measures the
	// document by, so margins stop there rather than escaping into the
	// viewport.
	layoutNode.setBlockFormattingContext(
		element === element.ownerDocument?.documentElement ||
		element.tagName === "BODY" ||
		(display !== "block" && display !== "list-item") ||
		getComputedValue(element, "overflow") !== "visible" ||
		isOutOfFlow(element) ||
		parentIsFlex,
	);

	const position = getPosition(element);
	// How the stacking-context painter finds positioned boxes without an
	// O(document) sweep per frame.
	if (positionedElements) {
		if (position !== "static") {
			positionedElements.add(element);
		} else {
			positionedElements.delete(element);
		}
	}
	if (position === "absolute") {
		layoutNode.setPositionType("absolute");
		applyInsets(layoutNode, element, INSET_EDGES, true);
	} else if (position === "relative") {
		layoutNode.setPositionType("relative");
		// Only the start-edge offsets apply. right/bottom alone do not move it.
		applyInsets(layoutNode, element, INSET_EDGES.slice(0, 2), false);
	} else if (position === "fixed") {
		// The viewport contains it, and the document scroll is what keeps it
		// still.
		layoutNode.setPositionType("fixed");
		applyInsets(layoutNode, element, INSET_EDGES, false);
	} else {
		layoutNode.setPositionType("static");
	}
}

const kPositionedElements = Symbol("positionedElements");

// Only an out-of-flow box is asked where it would have been, so only it
// carries the static-position function.
function styleNode(
	layout: Layout,
	element: Element,
	layoutNode: LayoutNode,
): void {
	const wasHidden = layoutNode.style.mode === "none";
	styleLayoutNode(element, layoutNode, layout[kPositionedElements]);
	// Turning on display:none makes the whole subtree box-less, and every
	// path that restyles a box passes through here.
	if (!wasHidden && layoutNode.style.mode === "none") {
		dropHiddenContent(layout, element);
	}
	if (isOutOfFlow(element)) {
		layoutNode.setStaticPositionFunc((containingBlock) =>
			getStaticPosition(layout, element, containingBlock),
		);
	} else if (layoutNode.staticPositionFunc) {
		layoutNode.setStaticPositionFunc(null);
	}
}

// `node` is a DOM node's principal box. `anonymous` is one contiguous
// run of inline-level flow children of a block container (CSS2
// §9.2.1.1), belonging to no DOM node at all.
type BoxKind = "node" | "anonymous";

// A box either is LAID OUT (it has a layout node the solver sized) or
// is a run MEMBER whose geometry lives in the break result of the run
// around it. `getOwnLayoutNode` tells them apart. Identity outlives derivation:
// a principal box is its node's, an anonymous box is its ordinal among
// its container's runs, and a rebuild syncs against the boxes it
// replaces. That is what lets layout nodes and fragments be keyed by
// box.
class Box {
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
	heads: Map<Node, Box> | null;

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
	contentRoot: LayoutNode | null;

	// The lines of the last PLACING measurement. A probe at another width
	// never becomes what the painter sees.
	fragments: BreakResult | null;

	constructor(kind: BoxKind, node: Node | null, parent: Box | null = null) {
		this.parent = null;
		this.members = [];
		this.children = null;
		this.heads = null;
		this.broken = false;
		this.holdsFragments = false;
		this.layoutNode = null;
		this.styledFrom = null;
		this.contentRoot = null;
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

const kDerivedContainers = Symbol("derivedContainers");

// The one builder of boxes. Nothing else creates one. Inline content
// lays out in anonymous boxes, one per contiguous run of inline-level
// flow children (CSS2 §9.2.1.1), each a measuring leaf. `heads` maps
// every flow child to the box it falls under, so membership is a lookup
// rather than a walk back through siblings. Box-less elements
// (display:none, out of flow) take no run position and map to the box
// open around them, so nested content still resolves. Redone when a
// mutation drops the container from kDerivedContainers. The boxes
// themselves are synced, not remade.
function getContainerBox(
	layout: Layout,
	container: Element,
): Box {
	const box = getPrincipalBox(layout, container);
	if (box.children && layout[kDerivedContainers].has(container)) {
		return box;
	}

	const heads = new Map<Node, Box>();
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
		if (child.nodeType === child.ELEMENT_NODE) {
			const element = child as Element;
			if (getComputedDisplay(element) === "none" || isOutOfFlow(element)) {
				// Named here so the one path that builds a box reaches them.
				// Neither joins the run around it.
				const own = getPrincipalBox(layout, child, box);
				heads.set(child, run ?? own);
				children.push(own);
				continue;
			}
			// Blockification is included in this check. A flex or grid item is
			// a box of its own, and the run ends at it like any block-level
			// box.
			if (!isInlineLevel(element)) {
				const own = getPrincipalBox(layout, child, box);
				heads.set(child, own);
				children.push(own);
				run = null;
				continue;
			}
		} else if (child.nodeType !== child.TEXT_NODE) {
			continue;
		} else if (isSuppressedFlexWhitespace(child as Text)) {
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

	// A box whose membership changed measures differently at the same
	// width, and nothing about the space it is offered says so.
	for (const [reused, before] of opened) {
		const now = reused.members;
		if (
			before.length !== now.length ||
			before.some((node, index) => node !== now[index])
		) {
			reused.layoutNode?.markDirty();
		}
	}

	// Runs the container no longer has.
	for (let i = runCount; i < previous.length; i++) {
		dropAnonymousBox(layout, previous[i]);
	}

	// The walk flattens a dissolved element and never names it, so a box
	// it held under an earlier display would outlive the change. A display:
	// contents flip left the old box in place, holding rows nothing removed.
	dropSteppedOver(layout, container);

	box.children = children;
	box.heads = heads;
	layout[kDerivedContainers].add(container);
	return box;
}

const kBoxes = Symbol("boxes");

function getPrincipalBox(
	layout: Layout,
	node: Node,
	parent: Box | null = null,
): Box {
	let box = layout[kBoxes].get(node);
	if (!box) {
		box = new Box("node", node);
		layout[kBoxes].set(node, box);
	}
	if (parent) {
		box.parent = parent;
	}
	return box;
}

const kNodeMap = Symbol("nodeMap");

function getContainerLayoutNode(
	layout: Layout,
	container: Element,
): LayoutNode | undefined {
	return (
		layout[kBoxes].get(container)?.contentRoot ??
		layout[kNodeMap].get(container)
	);
}

const kMeasureNodes = Symbol("measureNodes");

// The children are severed first. They belong to other DOM nodes, which
// keep pointing at them.
function dropLayoutNode(
	layout: Layout,
	node: Node,
): void {
	const layoutNode = layout[kNodeMap].get(node);
	if (!layoutNode) {
		return;
	}
	layoutNode.parent?.removeChild(layoutNode);
	while (layoutNode.children.length > 0) {
		layoutNode.removeChild(layoutNode.children[0]);
	}
	layout[kMeasureNodes].delete(layoutNode);
	layoutNode.freeRecursive();
	untrackNode(layout, node);
}

// Whether the node is still the KIND of box the element generates: run
// vs boxes of its own, and hidden vs not. Neither is fixable by
// re-measuring.
function isBoxKindMatch(
	layout: Layout,
	element: Element,
	layoutNode: LayoutNode,
): boolean {
	if (isMeasuredAsRun(element) !== layout[kMeasureNodes].has(layoutNode)) {
		return false;
	}
	return (
		(getComputedDisplay(element) === "none") ===
		(layoutNode.style.mode === "none")
	);
}

const kAnonymousBoxes = Symbol("anonymousBoxes");

function dropAnonymousBox(
	layout: Layout,
	box: Box,
): void {
	const layoutNode = box.layoutNode;
	box.layoutNode = null;
	box.fragments = null;
	if (!layoutNode) {
		return;
	}
	layoutNode.parent?.removeChild(layoutNode);
	layout[kMeasureNodes].delete(layoutNode);
	layout[kAnonymousBoxes].delete(layoutNode);
	layoutNode.owner = null;
	layoutNode.freeRecursive();
}

function getBox(
	layout: Layout,
	node: Node,
): Box | null {
	const entry = getBoxEntry(layout, node);
	return entry?.kind === "anonymous" ? entry : null;
}

function getBoxEntry(
	layout: Layout,
	node: Node,
): Box | null {
	if (!flatIsConnected(node)) {
		return null;
	}

	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;
		// USED display. An out-of-flow element heads no run and joins none.
		// When run invalidation gave it a bare layout node, later rebuilds
		// skipped its full build and its pseudo-only content vanished on a
		// class flip.
		if (!isInlineLevel(element)) {
			return null;
		}
	} else if (node.nodeType !== node.TEXT_NODE) {
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
		const entry = heads.get(current);
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

function getOwnLayoutNode(
	layout: Layout,
	box: Box,
): LayoutNode | null {
	if (box.kind === "anonymous") {
		return box.layoutNode;
	}
	return box.node === null ? null : (layout[kNodeMap].get(box.node) ?? null);
}

function runLayoutNode(
	layout: Layout,
	node: Node,
): LayoutNode | undefined {
	const box = getBox(layout, node);
	if (box) {
		return box.head === node ? (box.layoutNode ?? undefined) : undefined;
	}
	return layout[kNodeMap].get(node);
}

function runBreakResult(
	layout: Layout,
	node: Node,
): BreakResult | undefined {
	const box = getBox(layout, node);
	if (box) {
		return box.head === node ? (box.fragments ?? undefined) : undefined;
	}
	return layout[kBoxes].get(node)?.fragments ?? undefined;
}

const kDirtyRunContainers = Symbol("dirtyRunContainers");
const kDOMRect = Symbol("DOMRect");
const kRootElement = Symbol("rootElement");
const kViewportRoot = Symbol("viewportRootNode");
const kWindow = Symbol("window");

// Bring a container's layout children into line with its box list.
// Positions are counted, not searched. A box sits after every earlier
// box of the container that reached the layout tree.
function syncContainerRuns(
	layout: Layout,
	container: Element,
): void {
	layout[kDirtyRunContainers].delete(container);
	if (
		getComputedDisplay(container) === "none" ||
		isHiddenByAncestor(container)
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
	if (!containerFlex || containerFlex.measureFunc) {
		// One box holds all of it, except an out-of-flow box, which no box
		// list names and no run walk finds. This is the derivation that reaches
		// it.
		if (containerFlex || getBox(layout, container)) {
			dropRunContent(layout, container);
		}
		return;
	}

	const children = getContainerBox(layout, container).children!;
	let index = 0;
	for (const entry of children) {
		if (entry.kind === "anonymous") {
			let layoutNode = entry.layoutNode;
			const styledFrom =
				entry.head.nodeType === entry.head.ELEMENT_NODE
					? (entry.head as Element)
					: null;
			// A run that changes hands starts fresh rather than keeping the
			// last head's margins and flex factors.
			if (layoutNode && entry.styledFrom !== styledFrom) {
				dropAnonymousBox(layout, entry);
				layoutNode = null;
			}
			if (!layoutNode) {
				layoutNode = new LayoutNode();
				entry.layoutNode = layoutNode;
				entry.styledFrom = styledFrom;
				if (styledFrom) {
					styleLayoutNode(styledFrom, layoutNode, layout[kPositionedElements]);
				}
				layoutNode.setMeasureFunc((width, widthMode, placing) =>
					measureInlineRun(layout, entry, width, widthMode, placing),
				);
				layout[kMeasureNodes].add(layoutNode);
				layout[kAnonymousBoxes].set(layoutNode, entry);
				layoutNode.owner = entry.head;
			} else if (layoutNode.owner !== entry.head) {
				layoutNode.owner = entry.head;
			}
			if (containerFlex.getChildIndex(layoutNode) !== index) {
				layoutNode.parent?.removeChild(layoutNode);
				containerFlex.insertChild(layoutNode, index);
			}
			index++;
			syncRunMembers(layout, entry);
			continue;
		}
		// A box a fresh build would have made differently is remade. The rest
		// is re-derived onto the existing node.
		const node = entry.node!;
		addNode(layout, node, containerFlex);
		// An out-of-flow box hangs from its containing block, which the build
		// above hoisted it to, and takes no place among the boxes counted here.
		if (isOutOfFlow(node)) {
			continue;
		}
		const layoutNode = layout[kNodeMap].get(node);
		if (layoutNode && layoutNode.parent === containerFlex) {
			// DOM siblings know nothing of the anonymous boxes between them, so
			// the position is decided here, with the whole list available.
			if (containerFlex.getChildIndex(layoutNode) !== index) {
				containerFlex.removeChild(layoutNode);
				containerFlex.insertChild(layoutNode, index);
			}
			index++;
		}
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

// One run measures the members as a single unit, so no box under them
// is laid out. This is also the only path that finds an out-of-flow box
// written among them.
function syncRunMembers(
	layout: Layout,
	run: Box,
): void {
	for (const member of run.members) {
		if (member.nodeType !== member.ELEMENT_NODE) {
			continue;
		}
		const element = member as Element;
		if (isOutOfFlow(element)) {
			addNode(layout, element, null);
			continue;
		}
		if (!layout[kBoxes].get(element)?.contentRoot) {
			dropLayoutNode(layout, element);
		}
		dropRunContent(layout, element);
	}
}

// The flat parent, skipping elements that generate no box. A projected
// node's box lives under the slot's own box parent.
function getBoxParentElement(node: Node): Element | null {
	let parent = flatParentElement<Element>(node);
	while (parent !== null && isDisplayContents(parent)) {
		parent = flatParentElement<Element>(parent);
	}
	return parent;
}

function getRunContainer(
	layout: Layout,
	node: Node,
): Element | null {
	const parent = getBoxParentElement(node);
	if (!parent) {
		return null;
	}
	const startsOwnRun =
		node.nodeType === node.ELEMENT_NODE &&
		getComputedDisplay(node as Element) !== "inline";
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
		const display = getComputedDisplay(current);
		// An inline box is transparent. Its content belongs to the run around
		// it.
		if (display === "inline") {
			continue;
		}
		if (isAtomicInline(display)) {
			// An atomic inline nested in one starts a run there rather than
			// joining the run its host is in.
			if (layout[kBoxes].get(current)?.contentRoot || startsOwnRun) {
				return current;
			}
			continue;
		}
		return current;
	}
	return null;
}

function isReachableFrom(
	from: LayoutNode | null,
	target: LayoutNode,
): boolean {
	for (let node = from; node !== null; node = node.parent) {
		if (node === target) {
			return true;
		}
	}
	return false;
}

function addNode(
	layout: Layout,
	node: Node,
	parentLayoutNode: LayoutNode | null = null,
): void {
	// Fresh builds never descend past a display:none boundary, and rebuild
	// sweeps must not bring descendants back in under it.
	if (isHiddenByAncestor(node)) {
		dropLayoutNode(layout, node);
		if (node.nodeType === node.ELEMENT_NODE) {
			dropHiddenContent(layout, node as Element);
		}
		return;
	}

	// A rebuild must not resurrect a stale box from an earlier display
	// value. A display:contents element's children re-add as the box
	// parent's own.
	if (node.nodeType === node.ELEMENT_NODE && isDisplayContents(node)) {
		dropLayoutNode(layout, node);
		// The container learns of the dissolved children only by enumerating.
		const container = getRunContainer(layout, node);
		if (container) {
			layout[kDerivedContainers].delete(container);
			layout[kDirtyRunContainers].add(container);
		}
		return;
	}
	// An out-of-flow box stays where it is for its containing block to
	// reach down to, unless the two are in different layout trees (a
	// content root's block cannot reach in). Then the box moves.
	if (isOutOfFlow(node)) {
		const containingBlock =
			getPosition(node as Element) === "fixed"
				? layout[kViewportRoot]
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
	if (parentLayoutNode?.measureFunc) {
		const stale = layout[kNodeMap].get(node);
		if (stale && stale.parent === parentLayoutNode) {
			parentLayoutNode.removeChild(stale);
			layout[kMeasureNodes].delete(stale);
			stale.freeRecursive();
			untrackNode(layout, node);
		}
		return;
	}

	if (layout[kNodeMap].has(node)) {
		const existingLayoutNode = layout[kNodeMap].get(node)!;
		// A node left from when this content was block-level is dropped, so
		// the anonymous box is the only thing measuring it.
		if (isInlineLevel(node) && getBox(layout, node)) {
			dropLayoutNode(layout, node);
			if (node.nodeType === node.ELEMENT_NODE) {
				addElementNode(layout, node as Element, parentLayoutNode);
			} else {
				addTextNode(layout, node as Text, parentLayoutNode);
			}
			return;
		}
		// Reuse is only sound while the node is the same KIND of box. A run
		// member flipped out of flow keeps a run measure that skips out-of-flow
		// boxes, measures 0x0, and silently vanishes.
		if (existingLayoutNode && node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			if (!isBoxKindMatch(layout, element, existingLayoutNode)) {
				dropLayoutNode(layout, node);
				addElementNode(layout, element, parentLayoutNode);
				return;
			}
			// Whatever moved the node may also have restyled it.
			styleNode(layout, element, existingLayoutNode);
			// A kept box is re-derived exactly as if built from scratch.
			if (isMeasuredAsRun(element)) {
				syncContentRoot(layout, element);
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
				parentLayoutNode.insertChild(
					existingLayoutNode,
					parentLayoutNode.children.length,
				);
				const container = getRunContainer(layout, node);
				if (container) {
					layout[kDirtyRunContainers].add(container);
				}
			}
		}
		return;
	}

	if (node.nodeType === node.ELEMENT_NODE) {
		addElementNode(layout, node as Element, parentLayoutNode);
	} else if (node.nodeType === node.TEXT_NODE) {
		addTextNode(layout, node as Text, parentLayoutNode);
	}
}

function addElementNode(
	layout: Layout,
	element: Element,
	parentLayoutNode: LayoutNode | null = null,
): void {
	const display = getComputedDisplay(element);
	const asRun = isMeasuredAsRun(element);

	if (asRun) {
		const box = getBox(layout, element);
		if (box) {
			invalidateBox(layout, box);
			layout[kDirtyRunContainers].add(box.container);
			syncContentRoot(layout, element);
			dropRunContent(layout, element);
			return;
		}
		// No anonymous box holds it (a flex container's getBlockifiedDisplay
		// children). Its own box lays it out below.
	}

	// Appended. The container's box list decides the order.
	const flexIndex = parentLayoutNode?.children.length ?? 0;

	let layoutNode = layout[kNodeMap].get(element);
	if (!layoutNode) {
		layoutNode = new LayoutNode();
		trackNode(layout, element, layoutNode);
	}

	styleNode(layout, element, layoutNode);

	if (display === "none") {
		layoutNode.setMode("none");
		if (layoutNode && parentLayoutNode) {
			placeChild(parentLayoutNode, layoutNode, flexIndex);
		}
		return;
	} else if (asRun) {
		const box = getPrincipalBox(layout, element);
		layoutNode.setMeasureFunc((width, widthMode, placing) =>
			measureInlineRun(layout, box, width, widthMode, placing),
		);
		layout[kMeasureNodes].add(layoutNode);

		if (layoutNode && parentLayoutNode) {
			placeChild(parentLayoutNode, layoutNode, flexIndex);
		}

		syncContentRoot(layout, element);
		dropRunContent(layout, element);
		return;
	}

	// A content root left behind would go on claiming the same children.
	dropContentRoot(getPrincipalBox(layout, element));

	// Only DIRECT children. A broken inline's boxes reach the tree through
	// this container's own box reconciliation.
	const walker = flowWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (
			child.nodeType === child.ELEMENT_NODE ||
			child.nodeType === child.TEXT_NODE
		) {
			addNode(layout, child, layoutNode);
		}
	}

	// Here rather than in calculateLayout's drain. A container built from
	// inside a measure is laid out the moment the measure returns, with no
	// drain in between.
	if (layout[kDirtyRunContainers].has(element)) {
		syncContainerRuns(layout, element);
	}

	if (layoutNode && parentLayoutNode) {
		placeChild(parentLayoutNode, layoutNode, flexIndex);
		// The index counted DOM siblings, which know nothing of the anonymous
		// boxes between them. The container's box list decides the order.
		const container = getRunContainer(layout, element);
		if (container) {
			layout[kDirtyRunContainers].add(container);
		}
	}
}

function addTextNode(
	layout: Layout,
	text: Text,
	parentLayoutNode: LayoutNode | null = null,
): void {
	if (!parentLayoutNode) {
		return;
	}

	if (isSuppressedFlexWhitespace(text)) {
		return;
	}

	const box = getBox(layout, text);
	if (box) {
		invalidateBox(layout, box);
		layout[kDirtyRunContainers].add(box.container);
		return;
	}

	let layoutNode = layout[kNodeMap].get(text);
	if (!layoutNode) {
		layoutNode = new LayoutNode();
		trackNode(layout, text, layoutNode);
	}

	const own = getPrincipalBox(layout, text);
	layoutNode.setMeasureFunc((width, widthMode, placing) =>
		measureInlineRun(layout, own, width, widthMode, placing),
	);
	layout[kMeasureNodes].add(layoutNode);

	parentLayoutNode.insertChild(layoutNode, parentLayoutNode.children.length);
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
	const walker = flowWalker(container);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		into.push(child);
		if (child.nodeType !== child.ELEMENT_NODE) {
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

// An inline-block is measured as ONE unit by its run, and a run ends at
// a block-level box, so block content inside it is laid out by the box's
// own measurement. Only the run that placed the box knows its content
// edge.
function syncContentRoot(
	layout: Layout,
	element: Element,
): void {
	const box = getPrincipalBox(layout, element);
	const display = getComputedDisplay(element);
	// An inline-grid always lays its own content out, because a line cannot
	// contain a grid piecemeal. An inline-block does so only once it holds a
	// block-level box. Never a plain inline: it is broken instead, and
	// taking its content here would steal back the container's boxes.
	const grid = display === "inline-grid";
	if (
		!establishesIndependentFormattingContext(element) ||
		(!grid && !hasBlockLevelBox(element))
	) {
		dropContentRoot(box);
		return;
	}

	let root = box.contentRoot;
	if (!root) {
		root = new LayoutNode();
		root.setBlockFormattingContext(true);
		box.contentRoot = root;
	}
	// The root IS the box's formatting context, so it gets the display and
	// the grid container properties. The element's own node is the run's.
	root.setMode(grid ? "grid" : "block");
	if (grid) {
		applyGridContainer(root, element);
		const gaps: Array<[string, Gutter]> = [
			["row-gap", "row"],
			["column-gap", "column"],
		];
		for (const [property, gutter] of gaps) {
			const gap = parseUnitValue(
				getComputedValue(element, property),
			);
			root.setGap(gutter, typeof gap === "number" ? gap : 0);
		}
	}

	const walker = flowWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (
			child.nodeType === child.ELEMENT_NODE ||
			child.nodeType === child.TEXT_NODE
		) {
			addNode(layout, child, root);
		}
	}

	// The measure laying this root out may be running right now. Its boxes
	// have to be in it before that measure returns.
	if (layout[kDirtyRunContainers].has(element)) {
		syncContainerRuns(layout, element);
	}
}

function dropContentRoot(box: Box): void {
	const root = box.contentRoot;
	if (!root) {
		return;
	}
	box.contentRoot = null;
	// Sever first. Freeing the children would leave nodeMap pointing at
	// freed nodes.
	while (root.children.length > 0) {
		root.removeChild(root.children[0]);
	}
	root.freeRecursive();
}

// Layout never descends past a display:none boundary, so a node built
// while the subtree was visible goes on returning stale geometry from
// getRect until dropped.
function dropHiddenContent(
	layout: Layout,
	element: Element,
): void {
	dropContainerBoxes(layout, element);
	const box = layout[kBoxes].get(element);
	if (box) {
		dropContentRoot(box);
	}
	const walker = createTreeWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		dropLayoutNode(layout, child);
		if (child.nodeType === child.ELEMENT_NODE) {
			dropHiddenContent(layout, child as Element);
		}
	}
}

// A box list left in place is what the next read uses.
function dropContainerBoxes(
	layout: Layout,
	element: Element,
): void {
	const box = layout[kBoxes].get(element);
	if (box?.children) {
		for (const child of box.children) {
			if (child.kind === "anonymous") {
				dropAnonymousBox(layout, child);
			}
		}
		box.children = null;
		box.heads = null;
	}
	layout[kDirtyRunContainers].delete(element);
}

// A run measures everything inside it as one unit, so no box in there
// keeps a layout node. One left over is laid out a second time, in a
// box the tree no longer has. Boxes the run does not measure are left
// alone: out-of-flow boxes (hoisted instead) and atomic inlines with
// content roots.
function dropRunContent(
	layout: Layout,
	element: Element,
): void {
	if (layout[kBoxes].get(element)?.contentRoot) {
		return;
	}
	dropContainerBoxes(layout, element);
	const walker = flowWalker(element);
	for (let node = walker.nextNode(); node;) {
		if (node.nodeType === node.ELEMENT_NODE) {
			const child = node as Element;
			if (isOutOfFlow(child)) {
				addNode(layout, child, null);
				node = skipSubtree(walker) ? walker.currentNode : null;
				continue;
			}
			if (layout[kBoxes].get(child)?.contentRoot) {
				node = skipSubtree(walker) ? walker.currentNode : null;
				continue;
			}
			dropContainerBoxes(layout, child);
		}
		dropLayoutNode(layout, node);
		node = walker.nextNode();
	}
}

// Retire the boxes of elements the enumeration saw THROUGH (dissolved,
// or broken around a block). Neither generates a box, and one left in
// place is laid out from a shape the container no longer has. Only
// those elements are descended into.
function dropSteppedOver(
	layout: Layout,
	parent: Element,
): void {
	const walker = createTreeWalker(parent);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (child.nodeType !== child.ELEMENT_NODE) {
			continue;
		}
		const element = child as Element;
		const dissolves = isDisplayContents(element);
		if (!dissolves && !layout[kBoxes].get(element)?.broken) {
			continue;
		}
		// addNode drops the box of a box-less element.
		if (dissolves && layout[kNodeMap].has(element)) {
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
		let ancestor = flatParentElement<Element>(element);
		ancestor;
		ancestor = flatParentElement<Element>(ancestor)
	) {
		if (getPosition(ancestor) !== "static") {
			const layoutNode = layout[kNodeMap].get(ancestor);
			// A measure-function node cannot take flex children, so a
			// positioned inline-block cannot serve, and the hoist keeps
			// climbing.
			if (layoutNode && !layoutNode.measureFunc) {
				return layoutNode;
			}
		}
	}
	return layout[kNodeMap].get(layout[kRootElement]) ?? null;
}

function isHiddenByAncestor(node: Node): boolean {
	for (
		let ancestor = flatParentElement<Element>(node);
		ancestor;
		ancestor = flatParentElement<Element>(ancestor)
	) {
		if (getComputedDisplay(ancestor) === "none") {
			return true;
		}
	}
	return false;
}

// Coordinates under a content root start at the box that owns it: the
// ancestor whose root the node was actually laid out under, not the
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
	if (root === layout[kViewportRoot]) {
		return position;
	}
	let host: Element | null = null;
	for (
		let current = getBoxParentElement(node);
		current && !host;
		current = getBoxParentElement(current)
	) {
		if (layout[kBoxes].get(current)?.contentRoot === root) {
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
			position.x +
			hostRect.x +
			boxModel.borderLeftWidth +
			boxModel.paddingLeft,
		y:
			position.y + hostRect.y + boxModel.borderTopWidth + boxModel.paddingTop,
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
		if (parent.getChildIndex(child) === index) {
			return;
		}
		parent.removeChild(child);
	}
	parent.insertChild(child, index);
}

export function flowWalker(root: Node): TreeWalker {
	return createTreeWalker(root, getContentsFilter);
}

function getContentsFilter(node: Node): number {
	return (
		node.nodeType === node.ELEMENT_NODE && isDisplayContents(node)
			? NodeFilter.FILTER_SKIP
			: NodeFilter.FILTER_ACCEPT
	);
}

// nextSibling() alone gives up at a parent's last child, and an inline
// run does not end there. `<span><b>x</b></span> tail` must climb out
// of the span to reach " tail".
function skipSubtree(walker: TreeWalker): boolean {
	while (!walker.nextSibling()) {
		if (!walker.parentNode()) {
			return false;
		}
	}
	return true;
}

function trackNode(
	layout: Layout,
	domNode: Node,
	layoutNode: LayoutNode,
): void {
	layout[kNodeMap].set(domNode, layoutNode);
	layoutNode.owner = domNode;
}

function untrackNode(
	layout: Layout,
	domNode: Node,
): void {
	const layoutNode = layout[kNodeMap].get(domNode);
	if (layoutNode) {
		layoutNode.owner = null;
	}
	// The lines are the product of the layout node that is being removed,
	// and would describe a box that no longer exists.
	const box = layout[kBoxes].get(domNode);
	if (box) {
		box.fragments = null;
	}
	layout[kNodeMap].delete(domNode);
	if (domNode.nodeType === domNode.ELEMENT_NODE) {
		layout[kPositionedElements].delete(domNode as Element);
	}
}

const kInvalidatedNodes = Symbol("invalidatedNodes");

// The first flat-tree child that can start an inline run. A UA shadow
// tree's <style> would otherwise end leaf collection at position zero.
function flatFirstRenderableChild(element: Element): Node | null {
	const walker = flowWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (
			child.nodeType === child.ELEMENT_NODE &&
			(getComputedDisplay(child as Element) === "none" ||
				isOutOfFlow(child))
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
	const parent = flatParentElement<Element>(element);
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
	layout[kDerivedContainers].delete(container);
	layout[kDirtyRunContainers].add(container);
}

function invalidateBoxDerivation(
	layout: Layout,
	node: Node,
): void {
	const container = getRunContainer(layout, node);
	if (container) {
		invalidateContainerDerivation(layout, container);
	}
}

// For an inline, this is the block container around it. An inline's
// children belong to the run the inline is on.
function invalidateChildDerivation(
	layout: Layout,
	parent: Element,
): void {
	let box: Element | null = parent;
	while (box && isDisplayContents(box)) {
		box = getBoxParentElement(box);
	}
	if (!box) {
		return;
	}
	invalidateContainerDerivation(layout, box);
	const container = getRunContainerFromParent(layout, box, false);
	if (container) {
		invalidateContainerDerivation(layout, container);
	}
}

function invalidateSubtreeDerivation(
	layout: Layout,
	node: Node,
): void {
	invalidateBoxDerivation(layout, node);
	if (node.nodeType !== node.ELEMENT_NODE) {
		return;
	}
	invalidateChildDerivation(layout, node as Element);
	// A subtree layout has never seen holds no enumeration to unsettle.
	// Anything that HAS been laid out is reachable from its own record.
	if (!layout[kNodeMap].has(node) && !layout[kBoxes].get(node)?.children) {
		return;
	}
	// The flat tree, not the flow. Which elements dissolve is the cascade's
	// question, and marking one that generates no box costs nothing.
	const walker = createTreeWalker(node);
	for (let child = walker.nextNode(); child; child = walker.nextNode()) {
		if (child.nodeType === child.ELEMENT_NODE) {
			invalidateContainerDerivation(layout, child as Element);
		}
	}
}

function invalidateInlineRun(layout: Layout, node: Node): void {
	const entry = getBoxEntry(layout, node);
	if (!entry) {
		return;
	}
	if (entry.kind === "anonymous") {
		invalidateContainerBoxes(layout, entry.container);
		layout[kDirtyRunContainers].add(entry.container);
		// A node left over from an earlier shape of the container measures the
		// same content a second time, in a box the container no longer has.
		dropLayoutNode(layout, node);
		return;
	}
	const container = getRunContainer(layout, entry.node!);
	if (container) {
		invalidateContainerBoxes(layout, container);
	}
	layout[kNodeMap].get(entry.node!)?.markDirty();
}

function invalidateNode(
	layout: Layout,
	node: Node,
): void {
	layout[kInvalidatedNodes].add(node);

	if (isInlineLevel(node)) {
		invalidateInlineRun(layout, node);
	} else if (node.nodeType === node.ELEMENT_NODE) {
		const layoutNode = layout[kNodeMap].get(node);
		if (layoutNode) {
			const parent = layoutNode.parent;
			if (parent) {
				parent.removeChild(layoutNode);
			}

			if (!node.isConnected) {
				layout[kMeasureNodes].delete(layoutNode);
				layoutNode.freeRecursive();
				untrackNode(layout, node);
			} else {
				// Kept for calculateLayout's re-add sweep, but restyled. A
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

function invalidateNodeChildren(
	layout: Layout,
	element: Element,
): void {
	const walker = flowWalker(element);
	let child = walker.firstChild();

	while (child) {
		invalidateNode(layout, child);
		child = walker.nextSibling();
	}
}

function dropBreakResultCache(
	layout: Layout,
	node: Node,
): void {
	const entry = getBoxEntry(layout, node);
	if (entry?.kind === "anonymous") {
		invalidateBox(layout, entry);
	} else if (entry) {
		// Dirtying the measure is what drops the lines. A clean node keeps
		// both.
		markRunMeasureDirty(layout, entry.node!);
	}
}

// Drop an anonymous box's lines and dirty the measure that refills
// them, including, under a content root, the box whose measure is the
// only thing that ever lays that content out.
function invalidateBox(
	layout: Layout,
	box: Box,
): void {
	box.layoutNode?.markDirty();
	const host = getEnclosingContentRoot(layout, box.container);
	if (host) {
		invalidateEnclosingMeasure(layout, host);
	}
}

// A DOM question, not a flex-tree one. A box whose layout node is
// momentarily detached would report that it is in no tree at all,
// leaving the only measure that ever runs it un-dirtied.
function getEnclosingContentRoot(
	layout: Layout,
	from: Element | null,
): Element | null {
	for (let current = from; current; current = getBoxParentElement(current)) {
		if (layout[kBoxes].get(current)?.contentRoot) {
			return current;
		}
	}
	return null;
}

// Every box, not just the one that changed. What reshapes one commonly
// reshapes the others, and a cleared result on a clean node is never
// recomputed: the box lays out at the right rect and paints nothing.
function invalidateContainerBoxes(
	layout: Layout,
	container: Element,
): void {
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
function invalidateEnclosingMeasure(
	layout: Layout,
	node: Node,
): void {
	// A restyle may have given the node a box or taken one away. The
	// container's box list is what records that.
	const runContainer = getRunContainer(layout, node);
	if (runContainer) {
		layout[kDirtyRunContainers].add(runContainer);
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
		const headLayoutNode = layout[kNodeMap].get(entry.node!);
		if (headLayoutNode && headLayoutNode.measureFunc) {
			headLayoutNode.markDirty();
			// Out of any content root too. Only its owner runs that layout.
			const host = getEnclosingContentRoot(
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
		const layoutNode = layout[kNodeMap].get(current);
		if (layoutNode) {
			if (layoutNode.measureFunc) {
				layoutNode.markDirty();
			}
			const host = getEnclosingContentRoot(
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

const kRestyled = Symbol("restyled");

// Under a content root, dirtying just the run invalidates it forever.
// Nothing above the box ever visits those nodes, so the cleared break
// result is never rebuilt and the run paints nothing.
function markRunMeasureDirty(
	layout: Layout,
	runHead: Node,
): void {
	const layoutNode = layout[kNodeMap].get(runHead);
	if (!layoutNode) {
		return;
	}
	if (layoutNode.measureFunc) {
		layoutNode.markDirty();
	}
	const host = getEnclosingContentRoot(layout, getBoxParentElement(runHead));
	if (host) {
		invalidateEnclosingMeasure(layout, host);
	}
}

interface InlineBlockLeaf {
	type: "inline-block";
	node: Element;
	breakResult?: BreakResult;
	boxModel: BoxModel;
	contentWidth: number;
	contentHeight: number;
}

type Leaf =
	InlineBlockLeaf |
	{type: "text"; node: Text; content: string} |
	{type: "br"; node: HTMLBRElement};

interface LineResult {
	segments: Array<{
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
	}>;
	y: number;
	width: number;
	height: number;
}

interface BreakResult {
	lines: LineResult[];
	maxLineWidth: number;
	totalHeight: number;

	// The width lines broke against, for text-align to offset within. Unset
	// when the constraint was not finite (nothing to center within).
	containerWidth?: number;
}

interface ProcessedContent {
	items: Array<{
		leafNode: Leaf;
		start: number;
		end: number;
		processedContent?: string;

		// Back to offsets in the leaf's raw data. Null where the two are equal.
		dataOffsets?: Int32Array | null;
	}>;
	text: string;

	// Entry i is the cell width of text[0..i), so a range measures as one
	// subtraction. An inline-block's whole box sits on its placeholder
	// character. A fragment of a grapheme cluster carries none of its
	// width.
	getPrefixWidths: Float64Array;
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

	// Data offset of the line's first character / caret slot.
	startOffset: number;

	// Data offset of the caret slot AFTER the line's last character.
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
}

const kRectTextIndices = Symbol("rectTextIndices");

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

// A line requested over an ELEMENT merges the fragments of every text
// node it covers, so its offsets are a range of the run, not of one
// node's data.
interface RectText {
	rect: DOMRect;
	text: string;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
}

function getWhiteSpace(textNode: Text): string {
	const parent = flatParentElement<Element>(textNode);
	return parent ? getComputedValue(parent, "white-space") : "normal";
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

// Only the placing measurement's lines become the box's. A probe's are
// a result about a box nothing was laid out in, and painting them
// rendered a stretched item at its narrowest.
function measureInlineRun(
	layout: Layout,
	box: Box,
	width: number,
	widthMode: MeasureMode,
	placing: boolean,
): Size {
	const breakResult = breakNodes(layout, box, width, widthMode);
	if (Number.isFinite(width)) {
		breakResult.containerWidth = width;
	}
	if (placing) {
		box.fragments = breakResult;
	}

	return {
		width: breakResult.maxLineWidth,
		height: breakResult.totalHeight,
	};
}

// The members are the box's own, so nothing here decides where a run
// ends, and a member that has left the tree is not among them.
function collectLeafNodes(
	layout: Layout,
	source: Box,
	availableWidth: number,
	availableWidthMode: MeasureMode = "unconstrained",
): Leaf[] {
	const leafNodes: Leaf[] = [];
	if (source.kind === "anonymous") {
		for (const member of source.members) {
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
	// which is getBlockifiedDisplay and lays its own content out.
	const parentDisplay = getComputedDisplay(parentElement);
	let traversalRoot: Node;
	if (hasItemChildren(parentDisplay) && node.nodeType === node.ELEMENT_NODE) {
		traversalRoot = node;
	} else {
		let root: Element = parentElement;
		for (
			let ancestor = getBoxParentElement(root);
			ancestor &&
			getComputedDisplay(root) === "inline" &&
			!isOutOfFlow(root);
			ancestor = getBoxParentElement(root)
		) {
			root = ancestor;
		}
		traversalRoot = root;
	}

	// Text directly inside a flex container is an anonymous item that ends
	// at the first element, every element child being an item of its own.
	const stopsAtFlexItems =
		hasItemChildren(parentDisplay) && node.nodeType === node.TEXT_NODE;

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

function collectLeaves(
	layout: Layout,
	root: Node,
	start: Node,
	stopsAtFlexItems: boolean,
	leafNodes: Leaf[],
	availableWidth: number,
	availableWidthMode: MeasureMode,
): void {
	const walker = flowWalker(root);
	walker.currentNode = start;
	while (walker.currentNode) {
		const node = walker.currentNode;
		if (stopsAtFlexItems && node.nodeType === node.ELEMENT_NODE) {
			break;
		}

		if (node.nodeType === node.TEXT_NODE) {
			const textNode = node as Text;

			if (textNode.textContent) {
				const isWhitespaceOnly = /^\s*$/.test(textNode.textContent);

				if (
					isWhitespaceOnly &&
					shouldCollapseWhitespaceTextNode(textNode)
				) {
					if (!walker.nextNode()) {
						break;
					}
					continue;
				}

				leafNodes.push({
					type: "text",
					node: textNode,
					content: textNode.textContent,
				});
			}
			if (!walker.nextNode()) {
				break;
			}
		} else if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;
			const display = getComputedDisplay(element);

			if (
				getComputedDisplay(element) === "none" ||
				isOutOfFlow(element)
			) {
				// Neither occupies run space nor interrupts the run. Before the
				// display branches, or an absolute inline span measures into
				// the run it left.
				if (!skipSubtree(walker)) {
					break;
				}
			} else if (element.tagName === "BR") {
				leafNodes.push({
					type: "br",
					node: element as HTMLBRElement,
				});
				if (!walker.nextNode()) {
					break;
				}
			} else if (isAtomicInline(display)) {
				const ownBox = getPrincipalBox(layout, element);
				// An inline-block nested in another inline is a run member, and
				// addElementNode is never called on one. This is the first
				// moment its block content is known to need a root.
				if (!ownBox.contentRoot) {
					syncContentRoot(layout, element);
				}

				const boxModel = getBoxModel(element);

				// getBoxModel carries only absolute widths. A percentage
				// resolves here against the run's available width, which is
				// what lets `input { width: 100% }` fill its container instead
				// of collapsing to a void element's zero. Indefinite width
				// falls through to auto.
				if (boxModel.width === undefined) {
					const widthValue = parseUnitValue(
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
							Math.round((widthValue.percentage / 100) * availableWidth),
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
				let contentWidthMode: MeasureMode = "unconstrained";
				let contentHeightMode: MeasureMode = "unconstrained";

				// A sizing keyword picks the probe the content is measured under.
				const widthSizing =
					boxModel.width === undefined
						? getWidthSizingConstant(getComputedValue(element, "width"))
						: "none";
				if (boxModel.width !== undefined) {
					contentWidth = Math.max(0, boxModel.width - horizontalBoxSpace);
					contentWidthMode = "exactly";
				} else if (widthSizing === "min-content") {
					contentWidth = 0;
					contentWidthMode = "at-most";
				} else if (
					widthSizing === "fit-content" &&
					Number.isFinite(availableWidth) &&
					availableWidth < Number.MAX_SAFE_INTEGER
				) {
					contentWidth = Math.max(0, availableWidth - horizontalBoxSpace);
					contentWidthMode = "at-most";
				} else if (element.tagName === "TEXTAREA") {
					// cols sizes the CONTENT box (spec default 20). The UA
					// sheet carries no width for it. A constant that pre-baked
					// the UA chrome could not be undone by an author's `border:
					// none`.
					const cols = parseInt(element.getAttribute("cols") ?? "", 10);
					contentWidth = Number.isFinite(cols) && cols > 0 ? cols : 20;
					contentWidthMode = "exactly";
				}

				// On a row flex item's main axis the flex engine owns the used
				// width, and the requests carry that authority: an `exactly`
				// request is the resolved width, and an `at-most` request below
				// the CSS width is an intrinsic probe wanting the CONTENT's
				// minimum, not the basis. Row flex items only. Elsewhere an
				// `exactly` request describes the container, and a
				// definite-width inline-block in a narrow block overflows
				// rather than re-wrapping.
				let offerOwnsWidth = false;
				if (
					Number.isFinite(availableWidth) && isRowFlexItem(element)
				) {
					const offered = Math.max(0, availableWidth - horizontalBoxSpace);
					if (availableWidthMode === "exactly") {
						contentWidth = offered;
						contentWidthMode = "exactly";
						offerOwnsWidth = true;
					} else if (
						availableWidthMode === "at-most" &&
						offered < contentWidth
					) {
						contentWidth = offered;
						contentWidthMode = "at-most";
						offerOwnsWidth = true;
					}
				}

				// max-width caps the width the content BREAKS at, not just the
				// reported box. Otherwise it wraps at its natural width and
				// overflows the capped box. A percentage resolves against the
				// run's available width, or `max-width: 100%` (every text
				// field's value part) broke at its natural width and overflowed
				// its field.
				const maxWidthValue = parseUnitValue(
					getComputedValue(element, "max-width"),
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
						if (contentWidthMode === "unconstrained") {
							contentWidthMode = "at-most";
						}
					}
				}

				if (boxModel.height !== undefined) {
					contentHeight = Math.max(0, boxModel.height - verticalBoxSpace);
					contentHeightMode = "exactly";
				}

				// The COMPOSED first child. A shadow host renders its shadow
				// content, and measuring the light children sized it to zero.
				const contentRoot = ownBox.contentRoot;
				let inlineBlockResult: BreakResult | undefined;
				let finalContentWidth: number;
				let finalContentHeight: number;

				if (contentRoot) {
					// Laid out here because nothing above the box will. NaN
					// shrinks the axis to fit. A sizing keyword on the root
					// turns a passed width into the matching probe.
					contentRoot.setWidthSizing(widthSizing);
					contentRoot.calculateLayout(
						contentWidthMode === "exactly" ||
						(widthSizing !== "none" &&
							contentWidthMode === "at-most")
							? contentWidth
							: Number.NaN,
						contentHeightMode === "exactly"
							? contentHeight
							: Number.NaN,
					);
					finalContentWidth = contentRoot.getComputedWidth();
					finalContentHeight = contentRoot.getComputedHeight();
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
				}

				// And the REPORTED box. Content that cannot wrap (a single-line
				// field's pre text) overflows and is clipped rather than
				// stretching the box, or the field's horizontal scroll has
				// nothing to window.
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
				// a height: the field grows with its content, where a browser
				// would scroll inside a fixed box. cols fix the reported width.
				// The box is attribute-sized however short the value is.
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

				// This leaf IS where an inline-block's box gets its size (the
				// layout node only reports the whole run), so min/max apply here.
				// Values are border-box. Convert to content-box.
				const minWidthValue = parseUnitValue(
					getComputedValue(element, "min-width"),
				);
				if (typeof minWidthValue === "number") {
					finalContentWidth = Math.max(
						finalContentWidth,
						minWidthValue - horizontalBoxSpace,
					);
				}
				const minHeightValue = parseUnitValue(
					getComputedValue(element, "min-height"),
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
					getComputedValue(element, "max-height"),
				);
				if (typeof maxHeightValue === "number") {
					finalContentHeight = Math.min(
						finalContentHeight,
						maxHeightValue - verticalBoxSpace,
					);
				}

				// Explicit dimensions win, unless the request owned the width
				// above. An intrinsic probe's result must be the content's.
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
				// The children were measured inside the box above.
				if (!skipSubtree(walker)) {
					break;
				}
			} else if (display === "inline") {
				if (!walker.nextNode()) {
					break;
				}
			} else {
				// A block-level box broke the inline that holds it. The
				// fragments on either side are members of their own.
				break;
			}
		} else {
			if (!walker.nextNode()) {
				break;
			}
		}
	}
}

function breakNodes(
	layout: Layout,
	source: Box,
	width: number,
	widthMode: MeasureMode,
): BreakResult {
	// An `unconstrained` request is indefinite (NaN), so percentages in
	// the content cannot resolve. Any definite request, an `at-most` 0
	// included, resolves them.
	const leafNodes = collectLeafNodes(
		layout,
		source,
		widthMode === "unconstrained" ? NaN : width,
		widthMode,
	);

	if (leafNodes.length === 0) {
		return {lines: [], totalHeight: 0, maxLineWidth: 0};
	}

	// Text properties come from what opens the box. A text node styles
	// from its flat-tree parent.
	const opener = source.head;
	const styleElement =
		opener.nodeType === opener.TEXT_NODE
			? flatParentElement<Element>(opener)!
			: (opener as Element);

	const whiteSpace = getComputedValue(styleElement, "white-space");
	const wordBreak = getComputedValue(styleElement, "word-break");
	const overflowWrap = getComputedValue(styleElement, "overflow-wrap");

	// A width of 0 is a real constraint, the min-content probe. Treated as
	// unlimited it returned max-content, making min-content zero
	// everywhere.
	const maxWidth =
		widthMode === "unconstrained"
			? Number.MAX_SAFE_INTEGER
			: width;

	const processedContent = processWhitespace(layout, leafNodes);
	// `pre` suppresses wrapping as `nowrap` does. Treating it as wrappable
	// folds text a browser lets overflow.
	const preservesLines = whiteSpace === "pre";
	const nowrap =
		preservesLines ||
		(whiteSpace || "normal") === "nowrap" ||
		hasNowrapLeaf(processedContent);
	const breaks = findBreakPoints(
		processedContent,
		whiteSpace || "normal",
		nowrap,
	);
	// break-word does NOT shrink min-content (the word still measures whole
	// at the `at-most` 0 probe), while anywhere and break-all do.
	const breakAnywhere =
		!nowrap &&
		(wordBreak === "break-all" ||
			overflowWrap === "anywhere" ||
			(overflowWrap === "break-word" && maxWidth > 0));
	// Undeclared, the first strong character wins (UAX #9 §P2), which is
	// what makes an Arabic string in an undeclared <div> come out right.
	// That is how such a string usually arrives.
	const declared = getComputedValue(styleElement, "direction");
	const base: "ltr" | "rtl" =
		declared === "rtl"
			? "rtl"
			: declared === "ltr"
				? "ltr"
				: getParagraphDirection(processedContent.text);

	const lines = buildLines(
		layout,
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

const kRenderedLeaves = Symbol("renderedLeaves");

function renderLeaf(
	layout: Layout,
	textNode: Text,
	whiteSpace: string,
): {text: string; offsets: Int32Array | null} {
	const key = `${whiteSpace}\u0000${textNode.data}`;
	const cached = layout[kRenderedLeaves].get(textNode);
	if (cached?.key === key) {
		return cached;
	}
	const rendered = renderWhiteSpaceOffsets(textNode.data, whiteSpace);
	layout[kRenderedLeaves].set(textNode, {
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
				const prevItem = items[items.length - 1];
				if (prevItem && prevItem.leafNode.type === "text") {
					const prevEndsWithSpace =
						text.length > 0 && text[text.length - 1] === " ";
					const thisStartsWithSpace = processed[0] === " ";

					if (prevEndsWithSpace && thisStartsWithSpace) {
						processed = processed.substring(1);
						dataOffsets = shiftRenderedOffsets(
							dataOffsets,
							1,
							processed.length,
						);
					}
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
			text += "\n";
			items.push({
				leafNode: leaf,
				start,
				end: text.length,
			});
		} else if (leaf.type === "inline-block") {
			text += "\uFFFC";
			items.push({
				leafNode: leaf,
				start,
				end: text.length,
			});
		}
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
		const leading = text.match(/^[^\S\n]*/)?.[0].length || 0;
		const trailing = text.match(/[^\S\n]*$/)?.[0].length || 0;
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
						item.processedContent.length,
					);
				}
				item.start = clampedStart - trimStart;
				item.end = clampedEnd - trimStart;
			}
		}
	}

	return {items, text, getPrefixWidths: getPrefixWidths(items, text)};
}

function hasNowrapLeaf(content: ProcessedContent): boolean {
	return content.items.some((item) => {
		if (item.leafNode.type === "text") {
			return getWhiteSpace(item.leafNode.node) === "nowrap";
		}
		return false;
	});
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
		const forced: BreakPoint[] = [];
		if (whiteSpace === "pre" || whiteSpace === "pre-wrap") {
			for (let i = content.text.indexOf("\n"); i !== -1;) {
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

function buildLines(
	layout: Layout,
	content: ProcessedContent,
	breaks: BreakPoint[],
	maxWidth: number,
	breakAnywhere: boolean,
	base: "ltr" | "rtl" = "ltr",
): LineResult[] {
	const lines: LineResult[] = [];
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
		let bestBreakWidth = 0;

		while (cursor < breaks.length && breaks[cursor].position <= lineStart) {
			cursor++;
		}

		// Widths rise with position. Bisect for the last fitting candidate.
		let low = cursor;
		let high = breaks.length - 1;
		let lastFitting = cursor - 1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (
				measureText(content, lineStart, breaks[mid].position) <=
				maxWidth
			) {
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
			bestBreakWidth = measureText(content, lineStart, bestBreak);
		}

		// No break opportunity fits. The line takes the whole unbreakable unit
		// and overflows, as a browser lets a long word escape its box.
		if (bestBreak === lineStart && !breakAnywhere) {
			bestBreak =
				cursor < breaks.length
					? breaks[cursor].position
					: content.text.length;
			bestBreakWidth = measureText(content, lineStart, bestBreak);
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
			bestBreakWidth = measureText(content, lineStart, bestBreak);
		}

		const lineNodes = getNodesInRange(content.items, lineStart, bestBreak);

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

			// Visual order here rather than at paint time, so hit-testing and
			// selection read the coordinates the user is looking at.
			toVisualLine(layout, lineNodes, bestBreakWidth, base);

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

function measureText(
	content: ProcessedContent,
	start: number,
	end: number,
): number {
	return content.getPrefixWidths[end] - content.getPrefixWidths[start];
}

const kTerminalReordersText = Symbol("terminalReordersText");
const kMoved = Symbol("moved");

// Both halves are needed. Each segment's characters reorder (bidi.ts),
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
	if (layout[kTerminalReordersText]) {
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
function getLineAlignOffset(
	container: Element | null,
	containerWidth: number | undefined,
	lineWidth: number,
): number {
	if (!container || containerWidth === undefined) {
		return 0;
	}
	const align = getComputedValue(container, "text-align");
	if (align === "center") {
		return Math.max(0, (containerWidth - lineWidth) / 2);
	}
	if (align === "right") {
		return Math.max(0, containerWidth - lineWidth);
	}
	if (align === "left") {
		return 0;
	}
	// `start` and `end` name the reading direction's ends, trading sides
	// in an RTL paragraph. An undeclared alignment is `start`.
	const rtl = getComputedValue(container, "direction") === "rtl";
	const atRightEdge = align === "end" ? !rtl : rtl;
	return atRightEdge ? Math.max(0, containerWidth - lineWidth) : 0;
}

// Added on top of text-align's offset rather than shrinking the line
// box as a browser would. Indent with center/right is rare enough not
// to matter.
function getLineIndent(
	isFirstLine: boolean,
	container: Element | null,
	containerWidth: number | undefined,
): number {
	if (!isFirstLine || !container) {
		return 0;
	}
	const parsed = parseUnitValue(getComputedValue(container, "text-indent"));
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

// Subtracts every ANCESTOR's scroll. A box's own scroll shifts its
// descendants, not itself. Applied in this one function so paint,
// getRect, hit-testing and Range geometry all inherit it at once.
function getAbsolutePosition(
	layout: Layout,
	layoutNode: LayoutNode,
): {x: number; y: number} {
	// The document roots' scroll IS the document scroll, applied once at paint.
	// Only per-element scroll belongs in this document-space geometry.
	const document = layout[kWindow].document;
	const root = document.documentElement;
	const body = document.body;
	let x = 0;
	let y = 0;
	for (
		let current: LayoutNode | null = layoutNode;
		current;
		current = current.parent
	) {
		x += current.layout.left;
		y += current.layout.top;
		if (current !== layoutNode) {
			const node = current.owner as Node | undefined;
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

function getBreakResultTextIndex(
	layout: Layout,
	breakResult: BreakResult,
): Map<Text, TextFragmentEntry[]> {
	let index = layout[kRectTextIndices].get(breakResult);
	if (index) {
		return index;
	}
	index = new Map();
	let ord = 0;
	const visit = (segments: any[], baseX: number, lineIndex: number): void => {
		for (const segment of segments) {
			if (segment.leaf.type === "text") {
				const textNode = segment.leaf.node as Text;
				let entries = index!.get(textNode);
				if (!entries) {
					index!.set(textNode, (entries = []));
				}
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
	layout[kRectTextIndices].set(breakResult, index);
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
	if (element.nodeType !== 1) {
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
		if (!contained && !isSplitAroundBlock(element)) {
			return null;
		}
	}
	const children: Element[] = [];
	const walker = flowWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (child.nodeType !== 1) {
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
	return contained ? element : null;
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
	if (
		hasItemChildren(getComputedDisplay(container))
	) {
		return null;
	}
	const containerNode = getContainerLayoutNode(layout, container);
	if (!containerNode) {
		return null;
	}

	const origin = getAbsolutePosition(layout, containerNode);
	const containingOrigin = getAbsolutePosition(layout, containingBlock);
	const offsetLeft = origin.x - containingOrigin.x;
	const offsetTop = origin.y - containingOrigin.y;
	const contentLeft =
		containerNode.style.border.left +
		containerNode.layout.padding.left;
	const contentTop =
		containerNode.style.border.top +
		containerNode.layout.padding.top;

	const box = getContainerBox(layout, container);
	const children = box.children!;
	let entry: Box | null = null;
	for (let current: Node = element; current !== container;) {
		const found = box.heads!.get(current);
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
			const runOrigin = getAbsolutePosition(layout, runNode);
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
		const previousNode = getOwnLayoutNode(layout, previous);
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
				previousNode.layout.top +
				previousNode.getComputedHeight() +
				previousNode.layout.margin.bottom,
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
			cursor = {x: segment.x + segment.width, y: line.y};
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
				const dataStart =
					relativeStart < item.processedContent.length
						? getDataOffset(offsets, relativeStart)
						: item.leafNode.node.data.length;
				const dataEnd =
					portion.length > 0
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
				});
			} else if (item.leafNode.type === "inline-block") {
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

function isPointInRects(
	x: number,
	y: number,
	...rects: Array<DOMRect | DOMRect[] | DOMRectList>
): boolean {
	const allRects = rects.flat();
	return allRects.some((rect) => {
		if (Array.isArray(rect) || rect instanceof DOMRectList) {
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

export class Layout {
	declare [kDOMRect]: typeof DOMRect;
	declare [kRootElement]: Element;
	declare [kWindow]: EngineWindow;

	// The terminal-sized root every box hangs from. It has no DOM node.
	declare [kViewportRoot]: LayoutNode;

	// Not every node has one. A run member is measured by the run around
	// it and owns none, which is what getOwnLayoutNode checks.
	declare [kNodeMap]: Map<Node, LayoutNode>;

	declare [kInvalidatedNodes]: Set<Node>;

	// A SUPERSET hint. An element whose position went static without a
	// restyle reaching its node is still listed, so every reader checks
	// isPositioned too and uses the set only for the enumeration it saves.
	// The paint side's grouping is O(positioned), never O(document).
	declare [kPositionedElements]: Set<Element>;

	// Re-measured on resize. What they returned was for another width.
	declare [kMeasureNodes]: Set<LayoutNode>;

	// The terminal reorders bidirectional text itself (negotiateBidi), so
	// lines stay logical. One reordering is correct and two is backwards
	// again.
	declare [kTerminalReordersText]: boolean;

	// Each text node's last rendering, keyed by the data and white-space it
	// was rendered under. One run is broken once per width the sizing pass
	// tries, and the rendering is the same every time.
	declare [kRenderedLeaves]: WeakMap<Text, {
		key: string;
		text: string;
		offsets: Int32Array | null;
	}>;

	// Per break result, each text node's placed fragments in segment order.
	// Keyed on the break result object. Re-breaking builds a fresh object,
	// so entries can never go stale.
	declare [kRectTextIndices]: WeakMap<object, Map<Text, TextFragmentEntry[]>>;

	// The identity a derivation syncs against. A container rebuilt
	// around a node finds the box the node already had, with its layout
	// node and fragments.
	declare [kBoxes]: WeakMap<Node, Box>;

	// The reverse of Box.layoutNode, and the registry the sweeps that must
	// reach every box (resize, pruning, disposal) walk. Strong, because
	// boxes a re-derivation drops must still be dropped.
	declare [kAnonymousBoxes]: Map<LayoutNode, Box>;

	// Containers whose enumeration still describes their children. A
	// mutation drops the ones it disturbs, so flipping a class on one row
	// of a long list re-enumerates that row and not the boxes around it. An
	// unbounded change drops the set. Weak, because a container listed here
	// may be the last thing holding a removed subtree.
	declare [kDerivedContainers]: WeakSet<Element>;

	// Containers whose box list may not match their layout children.
	// Reconciled once per pass however many mutations dirtied them.
	declare [kDirtyRunContainers]: Set<Element>;

	// Collected rather than acted on. The cascade announces these
	// mid-invalidation, while descendants still hold the styles they are
	// about to lose, and every question layout would ask is about styles
	// that have not finished arriving.
	declare [kRestyled]: Set<Element>;

	// Geometry moved since the last painted frame.
	declare [kMoved]: boolean;

	constructor(window: EngineWindow, width: number, height: number) {
		this[kMoved] = false;
		this[kPositionedElements] = new Set<Element>();
		this[kTerminalReordersText] = false;
		this[kRectTextIndices] = new WeakMap<
			object,
			Map<Text, TextFragmentEntry[]>
		>();
		this[kBoxes] = new WeakMap<Node, Box>();
		this[kDerivedContainers] = new WeakSet<Element>();
		this[kAnonymousBoxes] = new Map<LayoutNode, Box>();
		this[kDirtyRunContainers] = new Set<Element>();
		this[kRestyled] = new Set<Element>();
		this[kRenderedLeaves] = new WeakMap<
			Text,
			{
				key: string;
				text: string;
				offsets: Int32Array | null;
			}
		>();
		this[kWindow] = window;
		this[kDOMRect] = window.DOMRect;
		this[kRootElement] = window.document.documentElement;
		this[kNodeMap] = new Map<Node, LayoutNode>();
		this[kInvalidatedNodes] = new Set<Node>();
		this[kMeasureNodes] = new Set<LayoutNode>();

		this[kViewportRoot] = new LayoutNode();
		this[kViewportRoot].setFlexDirection("column");
		this[kViewportRoot].setAlignItems("stretch");
		this[kViewportRoot].setWidth(width);
		this[kViewportRoot].setHeight(height);
	}

	/** The block the document lays out in: the terminal's size, in cells. */
	get initialContainingBlock(): {width: number; height: number} {
		return {
			width: this[kViewportRoot].style.width.value,
			height: this[kViewportRoot].style.height.value,
		};
	}

	get moved(): boolean {
		return this[kMoved];
	}

	adoptTerminalReordering(): void {
		if (this[kTerminalReordersText]) {
			this.invalidate();
			return;
		}
		this[kTerminalReordersText] = true;
		// Every measured line was built for the other contract.
		this.invalidateTextMeasurement();
	}

	invalidateTextMeasurement(): void {
		this.invalidate();
		for (const layoutNode of this[kMeasureNodes]) {
			layoutNode.markDirty();
		}
	}

	// The engine keeps no copy of the size. The root it sizes here is the
	// copy, and the document holds the one everything else reads.
	resize(width: number, height: number): void {
		this[kViewportRoot].setWidth(width);
		this[kViewportRoot].setHeight(height);

		for (const layoutNode of this[kMeasureNodes]) {
			layoutNode.markDirty();
		}
		markChanged(this);

		this.calculateLayout();
	}

	framePainted(): void {
		this[kMoved] = false;
	}

	calculateLayout(): void {
		// Built on the first pass, not at construction. The engine is
		// constructed before the cascade that provides display exists.
		if (!this[kNodeMap].has(this[kRootElement])) {
			addNode(this, this[kRootElement], this[kViewportRoot]);
		}
		// The cascade has finished for this frame, so the boxes it unsettled
		// can be resolved against the current styles.
		applyRestyles(this);
		// Every mutation path dirties the tree on its way in, so a clean tree
		// cannot be hiding a disconnection, and even the pruning sweep below is
		// not worth paying.
		if (
			!this[kViewportRoot].dirty &&
			this[kInvalidatedNodes].size === 0 &&
			this[kDirtyRunContainers].size === 0
		) {
			return;
		}

		// Callers may run synchronously after a DOM removal, before the
		// MutationObserver microtask, and a detached run head measured then has
		// no parent to collect leaves from.
		pruneDisconnectedNodes(this);

		for (const node of this[kInvalidatedNodes]) {
			if (node.isConnected) {
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
					if (isInlineLevel(parent) && !this[kBoxes].get(parent)?.broken) {
						break;
					}
					parent = getBoxParentElement(parent);
				}
			}
		}
		this[kInvalidatedNodes].clear();

		// Drained rather than iterated. Building a box a broken inline handed
		// over reaches containers of its own.
		const synced = new Set<Element>();
		while (this[kDirtyRunContainers].size > 0) {
			const containers = [...this[kDirtyRunContainers]];
			this[kDirtyRunContainers].clear();
			for (const container of containers) {
				if (synced.has(container)) {
					continue;
				}
				synced.add(container);
				syncContainerRuns(this, container);
			}
		}

		// A clean root means the previous layout is still exact. Recomputing
		// would be a full-tree relayout per frame for an animation repainting
		// one span.
		if (!this[kViewportRoot].dirty) {
			return;
		}

		// The root's own size is the request. The terminal is the viewport, so
		// html can size to its content and still resolve percentages and
		// viewport units against it.
		const root = this[kViewportRoot];
		root.calculateLayout(root.style.width.value, root.style.height.value);
	}

	dispose(): void {
		this[kViewportRoot].freeRecursive();

		this[kNodeMap] = new Map();
		this[kInvalidatedNodes] = new Set();
		this[kMeasureNodes] = new Set();
		this[kAnonymousBoxes] = new Map();
		this[kDirtyRunContainers] = new Set();
	}

	// Membership gates. A positioned inline run member owns no box of its
	// own, and no layer would ever paint it, so it stays with its run.
	hoistedToLayer(element: Element): boolean {
		return isPositioned(element) && this[kPositionedElements].has(element);
	}

	// Conservative. An element without a layout node is never culled, and
	// extents are recomputed with layout, so a stale result is impossible.
	isSubtreeOutsideViewport(
		element: Element,
		top: number,
		bottom: number,
	): boolean {
		const node = this[kNodeMap].get(element) ?? runLayoutNode(this, element);
		if (!node) {
			return false;
		}
		if (node.extentBottom > top && node.extentTop < bottom) {
			return false;
		}
		// A broken inline paints boxes outside its own layout subtree, so its
		// extent says nothing about them. Culling by its zero-height first
		// fragment rendered <a href><div>card</div></a> empty.
		return !this[kBoxes].get(element)?.broken;
	}

	// The children whose paint extent could intersect rows [top, bottom),
	// found by binary search. Culling a long list cost O(total children)
	// per frame instead of O(visible). Null when the search cannot be
	// trusted (children[] not sorted by extentTop), in which case callers
	// walk every child.
	getVisibleChildren(
		element: Element,
		top: number,
		bottom: number,
	): Node[] | null {
		const layoutNode = this[kNodeMap].get(element);
		if (
			!layoutNode ||
			// A measure-function leaf never decomposes into layout children, so
			// empty children[] means "not decomposed," not "nothing to paint."
			layoutNode.measureFunc !== null ||
			layoutNode.unstackedChildCount !== 0 ||
			layoutNode.style.mode !== "block" ||
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
			getShadowRoot<ShadowRoot>(element) !== null ||
			// A broken inline's boxes are children[] entries whose DOM node
			// lives a level DOWN. `<span>a<div/><span>c</span></span>d<input>`
			// collides at three and three, and the fast path dropped the text
			// and the input after the fragments.
			this[kBoxes].get(element)?.holdsFragments === true
		) {
			return null;
		}

		const children = layoutNode.children;
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
			if (child.extentTop >= bottom) {
				break;
			}
			const domNode = child.owner as Node | undefined;
			if (domNode) {
				result.push(domNode);
			}
		}
		return result;
	}

	gridTracks(element: Element, rows: boolean): number[] | null {
		const layoutNode = getContainerLayoutNode(this, element);
		if (!layoutNode) {
			return null;
		}
		return layoutNode.getComputedGridTracks(rows)?.sizes ?? null;
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
		const root = this[kRootElement];
		const rootRect = this.getRect(root);
		let height = rootRect ? Math.ceil(rootRect.height) : 0;
		const rendered = renderedTopLayer(
			root.ownerDocument!) as unknown as Element[];
		for (const element of rendered) {
			if (isModalDialog(element)) {
				return this[kViewportRoot].style.height.value;
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
		const box = getBoxModel(element);
		const left = (box.borderLeftWidth || 0) + (box.paddingLeft || 0);
		const top = (box.borderTopWidth || 0) + (box.paddingTop || 0);
		const right = (box.borderRightWidth || 0) + (box.paddingRight || 0);
		const bottom = (box.borderBottomWidth || 0) + (box.paddingBottom || 0);
		return new this[kDOMRect](
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
	scrollExtentOf(
		element: Element,
	): {width: number | null; height: number} | null {
		const layoutNode = this[kNodeMap].get(element);
		if (!layoutNode || layoutNode.measureFunc !== null) {
			return null;
		}
		const box = getBoxModel(element);
		let right: number | null = 0;
		let bottom = 0;
		for (const child of layoutNode.children) {
			// A display:none placeholder holds a stale layout.
			if (child.style.mode === "none") {
				continue;
			}
			if (right !== null) {
				right =
					child.measureFunc !== null
						? null
						: Math.max(
							right,
							child.layout.left + child.getComputedWidth(),
						);
			}
			bottom = Math.max(
				bottom,
				child.layout.top + child.getComputedHeight(),
			);
		}
		const clientWidth =
			layoutNode.getComputedWidth() -
			(box.borderLeftWidth || 0) -
			(box.borderRightWidth || 0);
		const clientHeight =
			layoutNode.getComputedHeight() -
			(box.borderTopWidth || 0) -
			(box.borderBottomWidth || 0);
		return {
			width:
				right === null
					? null
					: Math.round(
						Math.max(
							clientWidth,
							right - (box.borderLeftWidth || 0) + (box.paddingRight || 0),
						),
					),
			height: Math.round(
				Math.max(
					clientHeight,
					bottom - (box.borderTopWidth || 0) + (box.paddingBottom || 0),
				),
			),
		};
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

	// The live DOM tree, not the box tree. A separate concern from where
	// the boxes ended up.
	offsetParent(element: Element): Element | null {
		if (!element.isConnected) {
			return null;
		}
		for (
			let ancestor = element.parentElement;
			ancestor;
			ancestor = ancestor.parentElement
		) {
			const position = getComputedValue(ancestor, "position");
			if (position && position !== "static") {
				return ancestor;
			}
		}
		const body = this[kWindow].document.body ?? null;
		return body === element ? null : body;
	}

	clientSize(element: Element): {width: number; height: number} {
		const box = getContentBoxSize(this, element);
		return {
			width: Math.round(box?.width ?? 0),
			height:
				isRootBox(this, element)
					? this[kViewportRoot].style.height.value
					: Math.round(box?.height ?? 0),
		};
	}

	// A box the tree does not decompose (an inline, a run member) has no
	// readable extent and falls back to its client size.
	scrollSize(element: Element): {width: number; height: number} {
		const extent = element.isConnected ? this.scrollExtentOf(element) : null;
		const box = getContentBoxSize(this, element);
		return {
			width: extent?.width ?? Math.round(box?.width ?? 0),
			height:
				isRootBox(this, element)
					? getDocumentContentHeight(this)
					: (extent?.height ?? Math.round(box?.height ?? 0)),
		};
	}

	// A visible axis does not scroll and pins to 0. hidden scrolls
	// programmatically, as in a browser. Null where the layout cannot
	// determine the extent, which must not be clamped against.
	scrollRange(element: Element, axis: "left" | "top"): number | null {
		const extent = this.scrollExtentOf(element);
		const port = this.contentRect(element);
		const size =
			extent === null
				? null
				: axis === "top"
					? extent.height
					: extent.width;
		if (size === null || !port) {
			return null;
		}
		const overflow =
			getComputedValue(element, `overflow-${axis === "top" ? "y" : "x"}`) ||
			getComputedValue(element, "overflow");
		const room = size - Math.round(axis === "top" ? port.height : port.width);
		return isScrollingOverflow(overflow) ? Math.max(0, room) : 0;
	}

	// Innermost first. Each scroll moves the element in every outer port's
	// coordinates, so the rect is re-read per level. What remains is the
	// screen's to reveal.
	revealInScrollPorts(element: Element): void {
		for (
			let ancestor = flatParentElement<Element>(element);
			ancestor && !isRootBox(this, ancestor);
			ancestor = flatParentElement<Element>(ancestor)
		) {
			const overflow = getComputedValue(ancestor, "overflow");
			if (
				isScrollingOverflow(
					getComputedValue(ancestor, "overflow-y") || overflow,
				) ||
				isScrollingOverflow(
					getComputedValue(ancestor, "overflow-x") || overflow,
				)
			) {
				revealInPort(this, element, ancestor);
			}
		}
	}

	// Paint extents are cached in unscrolled layout rows, so viewport culling
	// of a scrolled subtree compares against the viewport moved by this amount
	// rather than recomputing extents per scroll.
	scrolledAncestorRows(element: Element): number {
		const layoutNode = this[kNodeMap].get(element) ??
			runLayoutNode(this, element);
		if (!layoutNode) {
			return 0;
		}
		const document = this[kWindow].document;
		const root = document.documentElement;
		const body = document.body;
		let rows = 0;
		for (
			let current = layoutNode.parent;
			current;
			current = current.parent
		) {
			const node = current.owner as Node | undefined;
			if (
				node &&
				node.nodeType === node.ELEMENT_NODE &&
				node !== root &&
				node !== body
			) {
				rows += (node as Element).scrollTop || 0;
			}
		}
		return rows;
	}

	getRect(element: Element): DOMRect | null {
		const display = getComputedDisplay(element);

		// The layout node a hidden element keeps is a placeholder holding its
		// slot, not a box (CSSOM View §4).
		if (display === "none") {
			return null;
		}

		// A getBlockifiedDisplay box's layout node is the truth, not the text
		// union the run machinery below reports, but only once one has been
		// built.
		const getBlockifiedDisplay = isBlockifiedByLayout(element) &&
			this[kNodeMap].has(element);

		if (!getBlockifiedDisplay && isInlineDisplay(display)) {
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
			// browser. The block fallback below returns the layout node's
			// width, which for an empty inline is its containing block's, and
			// `<div style="width:30ch"><span></span></div>` measured the span
			// at 30 columns. inline-block keeps the fallback, since its node IS
			// its box.
			if (display === "inline") {
				const elementLayoutNode = runLayoutNode(this, element);
				if (elementLayoutNode) {
					const position = getAbsolutePosition(this, elementLayoutNode);
					return new this[kDOMRect](position.x, position.y, 0, 0);
				}
				// An empty inline that does not open its run still has a place:
				// the cursor the line had reached. Null put the `span` in
				// `<div>ab<span></span>cd</div>` at 0 rather than 2.
				const run = getBox(this, element);
				if (run?.layoutNode) {
					const origin = getAbsolutePosition(this, run.layoutNode);
					const cursor = getInlineCursorBefore(run, element);
					return new this[kDOMRect](
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

		const layoutNode = this[kNodeMap].get(element) ??
			runLayoutNode(this, element);

		if (!layoutNode) {
			return null;
		}

		const {x, y} = getDocumentPosition(this, element, layoutNode);

		return new this[kDOMRect](
			x,
			y,
			layoutNode.getComputedWidth(),
			layoutNode.getComputedHeight(),
		);
	}

	getRects(node: Node): DOMRect[] {
		// Everything but true inline content is an atomic box with one rect,
		// inline-block included. An <input> has no text runs at all, and
		// returning none made it invisible to elementFromPoint.
		if (node.nodeType === node.ELEMENT_NODE) {
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
			return this.getRangeRuns(range).map((run) => run.rect);
		}
		const rects: DOMRect[] = [];
		for (const textNode of rangeTextNodes(this, range)) {
			const caret = getCaretRectInFragment(
				this,
				textNode,
				range.startContainer === textNode ? range.startOffset : 0,
			);
			if (caret) {
				rects.push(caret);
			}
		}
		return rects;
	}

	// The text lets a caller repaint the run in the selection style.
	// getRangeRects is this without the text.
	getRangeRuns(range: Range): Array<{rect: DOMRect; text: string}> {
		if (range.collapsed) {
			return [];
		}
		const runs: Array<{rect: DOMRect; text: string}> = [];
		for (const textNode of rangeTextNodes(this, range)) {
			const from = range.startContainer === textNode ? range.startOffset : 0;
			const to =
				range.endContainer === textNode
					? range.endOffset
					: textNode.data.length;
			if (to > from) {
				runs.push(...getSelectionSpans(this, textNode, from, to));
			}
		}
		return runs;
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
				rect: new this[kDOMRect](last.x, last.y + last.height, 0, last.height),
				startOffset: data.length,
				endOffset: data.length,
				visualBase: null,
			});
		}
		// Empty text's one line sits at the containing block's content-box
		// origin, where a caret rests in an empty field.
		if (lines.length === 0) {
			const parent = textNode.parentElement;
			const content = parent && this.contentRect(parent);
			if (content && parent) {
				lines.push({
					rect: new this[kDOMRect](
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

	// The inversion of painting. A line's data range renders back to the
	// characters it painted, so walking that rendering by cell width turns
	// a column into an offset, correct over collapsing white space. Landing
	// past the last character means "after it", so a drag selects through
	// end-of-line. With clampToNearestLine a point on no line resolves to
	// the nearest, so a drag that leaves a field still tracks it.
	caretPositionFromPoint(
		x: number,
		y: number,
		root: Node,
		clampToNearestLine = false,
	): {node: Text; offset: number} | null {
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

	// Positioned elements under their nearest stacking-context ancestor,
	// bucketed into the CSS paint layers: negative-z, z:auto/0, positive-z.
	// Walks only the positioned registry, so O(positioned x depth) per
	// frame, never O(document). The painter walks these forward and
	// hit-testing in reverse.
	collectStackingLayers(
		topLayer: Set<Element>,
	): Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}> {
		const layers = new Map<
			Element,
			{neg: Element[]; zero: Element[]; pos: Element[]}
		>();
		// A stray frame can fire after the window is torn down.
		const body = this[kWindow].document?.body;
		if (!body) {
			return layers;
		}
		for (const element of this[kPositionedElements]) {
			if (!element.isConnected || element === body) {
				continue;
			}
			// Painted above everything.
			if (topLayer.has(element)) {
				continue;
			}
			// The registry is a superset. Re-check before trusting membership.
			if (!isPositioned(element)) {
				continue;
			}
			let root: Element = body;
			for (
				let ancestor = flatParentElement<Element>(element);
				ancestor;
				ancestor = flatParentElement<Element>(ancestor)
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
			const z = getZIndexValue(element);
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
		const layers = this.collectStackingLayers(topLayer);
		const document = this[kWindow].document;
		if (!document?.body) {
			return null;
		}
		// Painting starts at the body, unless it generates no box of its own.
		const paintRoot =
			root === document.documentElement &&
			!isDisplayContents(document.body)
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

	// The observer drain calls this once per mutation batch. The cascade
	// calls it for style changes no record describes.
	invalidateFrame(): void {
		markChanged(this);
	}

	// A node re-enumerates its whole subtree, because run membership may
	// have changed. No node means an UNBOUNDED change (a stylesheet
	// reparse, a shadow attachment, the bidi flip), and the record of what
	// is derived is dropped whole.
	invalidate(node?: Node): void {
		if (node === undefined) {
			this[kDerivedContainers] = new WeakSet<Element>();
			this.invalidateFrame();
			return;
		}
		invalidateSubtreeDerivation(this, node);
		invalidateNode(this, node);
		markChanged(this);
	}

	handleMutations(mutations: MutationRecord[]): void {
		for (const record of mutations) {
			invalidateForRecord(this, record);
		}
	}

	// Whatever measured the element measured it under the style that is
	// gone, and nothing about the space it was offered says so.
	// Deliberately over-approximate: a change that moves no geometry costs
	// a re-measurement, and one that moves geometry is never missed.
	styleInvalidated(element: Element): void {
		this[kRestyled].add(element);
		markChanged(this);
	}

	// A chain reaching a fixed box puts the geometry in viewport space
	// rather than document space.
	isInFixedSpace(element: Element): boolean {
		for (
			let el: Element | null = element;
			el;
			el = flatParentElement<Element>(el)
		) {
			if (getPosition(el) === "fixed") {
				return true;
			}
		}
		return false;
	}
}

// "auto" stays distinct from 0. It paints in the same layer but does
// NOT form a context.
function getZIndexValue(element: Element): number | "auto" {
	const zIndex = getComputedValue(element, "z-index");
	if (!zIndex || zIndex === "auto") {
		return "auto";
	}
	const value = parseInt(zIndex, 10);
	return Number.isFinite(value) ? value : "auto";
}

// Positioned with a non-auto z-index. opacity/transform/filter have no
// terminal meaning. The root context belongs to <body>, the paint root.
export function isStackingContext(element: Element): boolean {
	if (element === element.ownerDocument.body) {
		return true;
	}
	if (getComputedValue(element, "isolation") === "isolate") {
		return true;
	}
	return isPositioned(element) && getZIndexValue(element) !== "auto";
}

// The one place that legitimately holds the computed and used display
// at once, because it checks whether they disagree.
function isBlockifiedByLayout(element: Element): boolean {
	return isInlineDisplay(getComputedDisplay(element)) && isBlockified(element);
}

function unionRects(
	layout: Layout,
	rects: readonly DOMRect[],
): DOMRect {
	if (rects.length === 0) {
		return new layout[kDOMRect]();
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
	return new layout[kDOMRect](left, top, right - left, bottom - top);
}

function pruneDisconnectedNodes(
	layout: Layout,
): void {
	// A box outlives the nodes that pass through it, but not its
	// container.
	for (const box of [...layout[kAnonymousBoxes].values()]) {
		if (!flatIsConnected(box.container)) {
			dropAnonymousBox(layout, box);
		}
	}
	for (const [node, layoutNode] of layout[kNodeMap]) {
		if (node === layout[kRootElement] || flatIsConnected(node)) {
			continue;
		}

		const parent = layoutNode.parent;
		if (parent) {
			parent.removeChild(layoutNode);
		}

		layout[kMeasureNodes].delete(layoutNode);
		layoutNode.freeRecursive();
		untrackNode(layout, node);
		layout[kInvalidatedNodes].delete(node);
	}
}

// Nothing here builds a box. A restyle says only that the boxes around
// an element may no longer match the enumeration, and what the element
// now generates is derived where every box is derived.
function applyRestyles(
	layout: Layout,
): void {
	while (layout[kRestyled].size > 0) {
		const restyled = [...layout[kRestyled]];
		layout[kRestyled].clear();
		for (const element of restyled) {
			if (!flatIsConnected(element)) {
				continue;
			}
			invalidateBoxDerivation(layout, element);
			invalidateChildDerivation(layout, element);
			invalidateEnclosingMeasure(layout, element);
			if (layout[kBoxes].get(element)?.children) {
				invalidateContainerBoxes(layout, element);
				// An element that becomes a flex container, or stops being one,
				// holds a different set of boxes than it did.
				layout[kDirtyRunContainers].add(element);
			}
		}
	}
}

// Nothing here builds a box. A mutation says only which containers no
// longer hold the boxes their enumeration names.
function invalidateForRecord(
	layout: Layout,
	record: MutationRecord,
): void {
	// A record on a shadow root describes the HOST's flat-tree children.
	const target =
		record.target.nodeType === record.target.DOCUMENT_FRAGMENT_NODE
			? (record.target as ShadowRoot).host
			: record.target;
	if (record.type === "attributes") {
		// Which rules now match is the cascade's to announce, through
		// styleInvalidated.
		invalidateBoxDerivation(layout, target);
		invalidateChildDerivation(layout, target as Element);
		if (record.attributeName === "slot") {
			// Moves the node in the COMPOSED tree while the light tree is
			// unchanged. No childList record arrives, and the container it left
			// is unreachable from where it now is. Rare enough for the blunt
			// approach.
			const host = (target as Element).parentElement;
			if (host && getShadowRoot<ShadowRoot>(host)) {
				invalidateSubtreeDerivation(layout, host);
			}
		}
		return;
	}
	if (record.type === "characterData") {
		invalidateBoxDerivation(layout, target);
		invalidateEnclosingMeasure(layout, target);
		return;
	}
	// The removed nodes are already detached, so the container is reached
	// through the target rather than through them.
	if (target.nodeType === target.ELEMENT_NODE) {
		invalidateChildDerivation(layout, target as Element);
	}
	// A member gaining or losing a descendant changes no box list (the
	// member is still there, holding more or less), so the box measuring it
	// is notified directly.
	invalidateEnclosingMeasure(layout, target);
	for (const node of record.addedNodes) {
		invalidateSubtreeDerivation(layout, node);
	}
}

function* getTextNodes(root: Node): Generator<Text> {
	if (root.nodeType === root.TEXT_NODE) {
		yield root as Text;
		return;
	}
	for (const child of Array.from(root.childNodes)) {
		yield* getTextNodes(child);
	}
}

// Three depths, only the first direct. The box heads its own run (ask
// the flex tree); it is a MEMBER of a run headed elsewhere, whose
// segment.x is run-relative and must be anchored at the head's
// position; or it sits inside ANOTHER inline-block, with its coordinates
// only in a break result nested under that box's leaf. Without
// descending there, `<div style="display:inline-block"><input></div>`
// paints nothing.
function getInlineBlockRect(
	layout: Layout,
	element: Element,
): DOMRect | null {
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

	const runPosition = getDocumentPosition(layout, runHead, headLayoutNode);
	let originX = runPosition.x;
	let originY = runPosition.y;

	// Outermost first. Each hop's offsets are expressed in the frame the
	// previous hop established. The run head itself is in the chain when it
	// is an inline-block.
	const enclosing: Element[] = [];
	for (
		let ancestor = flatParentElement<Element>(element);
		ancestor;
		ancestor = flatParentElement<Element>(ancestor)
	) {
		enclosing.unshift(ancestor);
		if (ancestor === runHead) {
			break;
		}
	}
	let descended = false;
	for (const ancestor of enclosing) {
		if (!establishesIndependentFormattingContext(ancestor)) {
			continue;
		}
		const hop = findInlineBlockSegment(breakResult, ancestor);
		if (!hop) {
			continue;
		}
		// Border and padding both occupy cells.
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
	if (!target) {
		return null;
	}

	// Once the walk descends into a nested measurement, any layout node the
	// box still holds belongs to a layout it is no longer part of.
	const ownLayoutNode = descended ? undefined : runLayoutNode(layout, element);
	if (ownLayoutNode) {
		const {x, y} = getDocumentPosition(layout, element, ownLayoutNode);
		return new layout[kDOMRect](x, y, target.segment.width, target.line.height);
	}
	return new layout[kDOMRect](
		originX + target.segment.x,
		originY + target.line.y,
		target.segment.width,
		target.line.height,
	);
}

function rangeTextNodes(
	layout: Layout,
	range: Range,
): Text[] {
	if (range.collapsed) {
		const container = range.startContainer;
		return container.nodeType === container.TEXT_NODE
			? [container as Text]
			: [];
	}
	const root = range.commonAncestorContainer;
	if (root.nodeType === root.TEXT_NODE) {
		return [root as Text];
	}
	const nodes: Text[] = [];
	const walker = layout[kWindow].document.createTreeWalker(
		root,
		layout[kWindow].NodeFilter.SHOW_TEXT,
	);
	let node: Node | null;
	while ((node = walker.nextNode())) {
		if (range.intersectsNode(node)) {
			nodes.push(node as Text);
		}
	}
	return nodes;
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
	);
	const x = Math.round(line.rect.x) + getStringWidth(before);
	return new layout[kDOMRect](x, Math.round(line.rect.y), 0, line.rect.height);
}

// The distance is zero when the point landed on the line, which is what
// picks between two lines painted on the same row.
function getOffsetInFragment(
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
		const width = getStringWidth(text[index]);
		if (cellX + width > x) {
			break;
		}
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
				? fragment.startOffset + getDataOffset(offsets, index)
				: fragment.endOffset,
		distance,
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
		let runStart = -1;
		for (let i = 0; i <= text.length; i++) {
			const dataOffset =
				i < text.length
					? fragment.startOffset + getDataOffset(offsets, i)
					: -1;
			const selected = dataOffset >= from && dataOffset < to;
			if (selected && runStart === -1) {
				runStart = i;
			} else if (!selected && runStart !== -1) {
				const x =
					Math.round(fragment.rect.x) +
					getStringWidth(text.slice(0, runStart));
				const width = getStringWidth(text.slice(runStart, i));
				runs.push({
					rect: new layout[kDOMRect](
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

function hitTestContext(
	layout: Layout,
	root: Element,
	x: number,
	y: number,
	layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
	documentScrollTop: number,
): Element | null {
	const bucket = layers.get(root) ?? null;
	const probeMember = (element: Element): Element | null => {
		// A fixed box's layout lives in viewport space, and fixed-space is a
		// property of the chain. An absolute box inside a fixed bar lives there
		// too.
		const probeY = layout.isInFixedSpace(element) ? y - documentScrollTop : y;
		return isStackingContext(element)
			? hitTestContext(layout, element, x, probeY, layers, documentScrollTop)
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
	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;
		const display = getComputedDisplay(element);

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
					if (child.nodeType === child.TEXT_NODE) {
						fragments.push(...getRectTexts(layout, child));
					} else if (
						child.nodeType === child.ELEMENT_NODE &&
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
			isAtomicInline(display) &&
			getBoxEntry(layout, element)?.head === element
		) {
			const breakResult = runBreakResult(layout, element);
			if (breakResult) {
				const rectTexts: RectText[] = [];
				const layoutNode = runLayoutNode(layout, element);
				if (!layoutNode) {
					return [];
				}

				const position = getDocumentPosition(layout, element, layoutNode);
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
											startOffset: nestedSegment.dataStart,
											endOffset: nestedSegment.dataEnd,
											visualBase: nestedSegment.visualBase,
											rect: new layout[kDOMRect](
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
														rect: new layout[kDOMRect](
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

	let {x: containerX, y: containerY} = getDocumentPosition(
		layout,
		runHead,
		layoutNode,
	);

	// getDocumentPosition gives the border box, and a getBlockifiedDisplay
	// inline flex item reserved padding and border in it (styleLayoutNode's
	// parentIsFlex exception) that its text ignored, painting at the border
	// edge. Scoped to exactly that case. A normal inline's box model is
	// cleared, an inline-block's offset is getDocumentPosition's, and a block's
	// run head is a text node with no box.
	if (runHead.nodeType === runHead.ELEMENT_NODE) {
		const runHeadElement = runHead as Element;
		if (
			getComputedDisplay(runHeadElement) === "inline" &&
			hasItemParent(runHeadElement)
		) {
			const runHeadBox = getBoxModel(runHeadElement);
			containerX += runHeadBox.paddingLeft + runHeadBox.borderLeftWidth;
			containerY += runHeadBox.paddingTop + runHeadBox.borderTopWidth;
		}
	}

	let currentBreakResult = breakResult;
	let accumulatedOffsetX = 0;
	let accumulatedOffsetY = 0;
	let currentNode = node;
	// Whose text-align governs these lines: the block container, until the
	// walk descends into an inline-block's nested breakResult, a fresh
	// formatting context with its own alignment.
	let alignContainer: Element | null = flatParentElement<Element>(runHead);

	// Flat-tree parents. A widget's UA shadow text has no parentElement
	// chain to its host, and the walk would stop at the shadow boundary.
	while (currentNode !== runHead && flatParentElement<Element>(currentNode)) {
		const parent = flatParentElement<Element>(currentNode)!;

		if (establishesIndependentFormattingContext(parent)) {
			// A field's windowed value shifts its content by its own scroll, so
			// the caret stays in view, independent of whether its segment is
			// found below.
			accumulatedOffsetX -= (parent as Element).scrollLeft || 0;
			accumulatedOffsetY -= (parent as Element).scrollTop || 0;
			let found = false;
			for (const line of currentBreakResult.lines) {
				for (const segment of line.segments) {
					if (
						segment.leaf.type === "inline-block" &&
						segment.leaf.node === parent
					) {
						// To the CONTENT edge. Border and padding occupy cells.
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
		let ancestor =
			node.nodeType === node.ELEMENT_NODE
				? (node as Element)
				: flatParentElement<Element>(node);
		ancestor && ancestor !== runHead && !layout[kNodeMap].has(ancestor);
		ancestor = flatParentElement<Element>(ancestor)
	) {
		if (getPosition(ancestor) === "relative") {
			const left = parseUnitValue(getComputedValue(ancestor, "left"));
			const top = parseUnitValue(getComputedValue(ancestor, "top"));
			if (typeof left === "number") {
				containerX += left;
			}
			if (typeof top === "number") {
				containerY += top;
			}
		}
	}

	let targetTextNodes: Set<Text>;

	if (node.nodeType === node.TEXT_NODE) {
		targetTextNodes = new Set([node as Text]);
	} else {
		targetTextNodes = new Set<Text>();

		const walker = flowWalker(node);

		let textNode;
		while ((textNode = walker.nextNode())) {
			targetTextNodes.add(textNode as Text);
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
			minX = Math.min(minX, targetText.x);
			maxX = Math.max(maxX, targetText.x + targetText.width);
			concatenatedText += targetText.text;
		}
		const first = bucket[0];
		const last = bucket[bucket.length - 1];

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

		const rect = new layout[kDOMRect](
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

function getDocumentContentHeight(engine: Layout): number {
	const bodyRect = engine.getRect(engine[kRootElement].ownerDocument?.body);
	return bodyRect ? Math.ceil(bodyRect.height) : 0;
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
	const document = engine[kWindow].document;
	return element === document.documentElement || element === document.body;
}

// Document-relative rects on both sides: the element wherever its
// current offsets put it, against the scroller's padding box.
function revealInPort(
	engine: Layout,
	element: Element,
	scroller: Element,
): void {
	const rect = engine.getRect(element);
	const scrollerRect = engine.getRect(scroller);
	if (!rect || !scrollerRect) {
		return;
	}
	const box = getBoxModel(scroller);
	const portTop = scrollerRect.top + (box.borderTopWidth || 0);
	const portBottom = scrollerRect.bottom - (box.borderBottomWidth || 0);
	const portLeft = scrollerRect.left + (box.borderLeftWidth || 0);
	const portRight = scrollerRect.right - (box.borderRightWidth || 0);
	if (rect.top < portTop) {
		scroller.scrollTop -= Math.round(portTop - rect.top);
	} else if (rect.bottom > portBottom) {
		scroller.scrollTop += Math.round(rect.bottom - portBottom);
	}
	if (rect.left < portLeft) {
		scroller.scrollLeft -= Math.round(portLeft - rect.left);
	} else if (rect.right > portRight) {
		scroller.scrollLeft += Math.round(rect.right - portRight);
	}
}

function isScrollingOverflow(overflow: string): boolean {
	return overflow === "auto" || overflow === "scroll" || overflow === "hidden";
}

// Every entry that moves geometry announces it here, and the pass
// itself moves nothing unannounced. That is what lets a frame that ran
// a pass and found nothing changed skip its paint.
function markChanged(layout: Layout): void {
	const document = layout[kRootElement].ownerDocument;
	if (document === null) {
		return;
	}
	usedValuesChanged(document);
	layout[kMoved] = true;
}
