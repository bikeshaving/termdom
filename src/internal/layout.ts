/**
 * The box tree: which boxes a document generates, and where they sit on the
 * cell grid.
 *
 * It reads computed styles and produces geometry. Every rect the DOM answers
 * with, and every cell the painter places, comes from what it computed.
 *
 * Two halves. A solver over a tree of LayoutNodes, which knows nothing of the
 * DOM -- `layoutNode` dispatches a box to the mode that sizes and places it.
 * Above that, the walker that derives such a tree from the flat tree and reads
 * geometry back out of it; LayoutEngine is the whole of what it offers, and is
 * where to start reading.
 */
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
	termDOMOf,
	TreeWalker,
} from "./dom.js";
import {kScreen} from "./termdom.js";
import {
	hasRTL,
	inferParagraphDirection,
	stringWidth,
	toVisualOrder,
	writeClusterWidths,
} from "./text.js";

// ---------------------------------------------------------------------------
// The vocabulary boxes are sized and placed in
//
// Four layout modes over one node type, chosen by the node's display: block
// (css2 §9.4.1 and §10.3.3, with §8.3.1 margin collapsing), flex
// (css-flexbox-1 and CSS Box Alignment), grid (css-grid-2 -- track sizing,
// line resolution, area placement), and the table grid rows and cells resolve
// to. All four are written from the spec rather than ported.
//
// Left out, because the cascade resolves them elsewhere or a cell grid has no
// use for them: writing modes and the direction property -- bidi resolves when
// text is shaped, not when boxes are placed -- scrollable overflow sizing, and
// sub-cell scaling, the grid being whole cells.
//
// The values arrive from the cascade as CSS keywords and are compared as
// keywords, so nothing is translated on the way in and a wrong one is a type
// error. NaN means undefined throughout, which is a distinct state from 0.
// ---------------------------------------------------------------------------

/**
 * `normal` names no behaviour of its own (css-align-3): it takes the meaning
 * the layout mode gives it -- stretch for a grid item, flex-start for a flex
 * container's lines.
 */
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

/** Which axis a gap applies to. */
type Gutter = "column" | "row";

/** How a layout node lays its own children out. */
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

/**
 * `fixed` is out of flow against the VIEWPORT rather than the nearest
 * positioned box. Distinct from absolute because its containing block is fixed
 * however deep it sits, so no ancestor between may claim it.
 */
type PositionType = "static" | "relative" | "absolute" | "fixed";

/** Whether a position type takes the box out of its container's flow. */
function isOutOfFlowType(positionType: PositionType): boolean {
	return positionType === "absolute" || positionType === "fixed";
}

/** Whether a box is a containing block for the out-of-flow boxes below it. */
function isContainingBlockType(positionType: PositionType): boolean {
	return positionType !== "static";
}

/** What a measurement is being asked for: no constraint, a size, or a cap. */
type MeasureMode = "unconstrained" | "exactly" | "at-most";

/** A value held against each of the four physical edges of a box. */
type Edges<T> = {left: T; top: T; right: T; bottom: T};

/** An edge a value is stored against. */
type Edge = keyof Edges<unknown>;

/**
 * The intrinsic sizing keywords of css-sizing-3 §5, carried beside a width of
 * auto rather than as units of it: min/max resolution, percentages and flex
 * arithmetic go on reading auto, and only the places that decide how wide an
 * auto box comes out consult the keyword.
 */
type Sizing = "none" | "min-content" | "max-content" | "fit-content";

interface Size {
	width: number;
	height: number;
}

/**
 * What a box's content comes to under an offer. `performLayout` is true for
 * the measurement that PLACES the box and false for the sizing probes taken
 * on the way there: a measurement may produce more than a size -- text also
 * decides where its lines break -- and only the placing one describes the box
 * the content ends up in.
 */
type MeasureFunction = (
	width: number,
	widthMode: MeasureMode,
	performLayout: boolean,
) => Size;

/**
 * Where an out-of-flow box would have sat had it stayed in flow: the origin of
 * CSS 2 §10.3.7's hypothetical box, in the containing block's border-box
 * coordinates. Only the flow the box left knows this, so the owner of that
 * flow supplies it; null means it has no static position to offer, and the
 * containing block's own alignment places the box instead.
 */
type StaticPositionFunction = (
	containingBlock: LayoutNode,
) => {left: number; top: number} | null;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const UNDEFINED_VALUE: Value = {unit: "undefined", value: NaN};
const AUTO_VALUE: Value = {unit: "auto", value: NaN};

/**
 * A length as a setter takes it: cells, a parsed percentage (the shape the
 * cascade's parseUnitValue hands over), `auto`, or nothing.
 */
type Length = number | "auto" | {percentage: number} | undefined | null;

/** Resolve a Value against an owner size. Returns NaN when unresolvable. */
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

/** Resolve a margin Value; `auto` and undefined both contribute 0 of length. */
function resolveMargin(value: Value, ownerWidth: number): number {
	if (value.unit === "auto") {
		return 0;
	}
	const resolved = resolveValue(value, ownerWidth);
	return isDefined(resolved) ? resolved : 0;
}

// ---------------------------------------------------------------------------
// Axis helpers
// ---------------------------------------------------------------------------

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

function crossAxis(axis: FlexDirection): FlexDirection {
	return isRow(axis) ? "column" : "row";
}

function leadingEdge(axis: FlexDirection): Edge {
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

function trailingEdge(axis: FlexDirection): Edge {
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

// ---------------------------------------------------------------------------
// Style / Layout records
// ---------------------------------------------------------------------------

interface Style {
	flexDirection: FlexDirection;
	justifyContent: Justify;
	alignContent: Align;
	alignItems: Align;
	alignSelf: Align;
	positionType: PositionType;
	flexWrap: Wrap;
	mode: LayoutMode;

	/** Gaps between items: [column, row]. */
	gap: {column: number; row: number};

	/**
	 * css-align-3 §6: the inline-axis counterparts of align-items/align-self.
	 * A flex container reads neither -- its inline axis is owned by
	 * justify-content -- so they are grid's alone.
	 */
	justifyItems: Align;
	justifySelf: Align;

	// -- grid container (css-grid-2 §7, §8.5) --------------------------------
	gridTemplateColumns: TrackList;
	gridTemplateRows: TrackList;
	gridTemplateAreas: GridAreaMap | null;
	gridAutoColumns: TrackSize[];
	gridAutoRows: TrackSize[];

	/** grid-auto-flow: the axis the placement cursor advances along, and dense. */
	gridAutoFlowColumn: boolean;
	gridAutoFlowDense: boolean;

	// -- grid item (css-grid-2 §8.3) -----------------------------------------
	gridRowStart: GridPlacement;
	gridRowEnd: GridPlacement;
	gridColumnStart: GridPlacement;
	gridColumnEnd: GridPlacement;

	/** Table cell spans. 1 unless set; only meaningful on a table-cell. */
	colSpan: number;
	rowSpan: number;

	/** Set on the table itself; collapsed cells share their borders. */
	borderCollapse: boolean;

	/**
	 * Whether the box establishes a block formatting context: its children's
	 * margins are contained, so none of them collapses through its own top or
	 * bottom edge (css2 §8.3.1, §9.4.1).
	 */
	blockFormattingContext: boolean;

	flexGrow: number;

	/** CSS order: items lay out in order-modified document order. */
	order: number;
	flexShrink: number;
	flexBasis: Value;

	margin: Edges<Value>;
	position: Edges<Value>;
	padding: Edges<Value>;
	border: Edges<number>;

	width: Value;

	/** See Sizing: how an auto width resolves; none means fill or measure. */
	widthSizing: Sizing;
	height: Value;
	minWidth: Value;
	minHeight: Value;
	maxWidth: Value;
	maxHeight: Value;

	/**
	 * width / height, counted in CELLS on both axes: one cell is one cell,
	 * vertical or horizontal, so a ratio of 1 on a box 10 cells wide makes it
	 * 10 rows tall. NaN means auto.
	 */
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

	/** css-flexbox-1 §4.5 automatic minimum size, along the parent's main axis. */
	autoMinMain: number;

	/**
	 * The used sizes of a grid container's tracks, in the implicit grid's own
	 * order (leading implicit tracks first). Null on a box that is not a grid
	 * container; this is what `getComputedStyle` reports for
	 * grid-template-columns/rows, which resolve to their used track sizes.
	 */
	gridColumns: number[] | null;
	gridRows: number[] | null;

	/** How many of gridColumns/gridRows sit BEFORE the explicit grid's first line. */
	gridColumnOffset: number;
	gridRowOffset: number;

	/**
	 * The margins that adjoin the box's top and bottom edges from the inside and
	 * escape them, each set as its largest positive and most negative member
	 * (css2 §8.3.1). Block layout writes them; the block container above reads
	 * them to place the box, which is how a collapse crosses a box edge.
	 */
	collapseTopPositive: number;
	collapseTopNegative: number;
	collapseBottomPositive: number;
	collapseBottomNegative: number;

	/**
	 * Whether the box's own top and bottom margins adjoin each other: a
	 * zero-height block with nothing at either vertical edge, which its
	 * neighbours' margins pass straight through (css2 §8.3.1).
	 */
	selfCollapsing: boolean;
}

// ---------------------------------------------------------------------------
// LayoutNode
// ---------------------------------------------------------------------------

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

/** NaN-safe equality: undefined constraints are NaN, and NaN !== NaN. */
function sameConstraint(a: number, b: number): boolean {
	return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

function constraintsMatch(
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
		sameConstraint(cache.availableWidth, availableWidth) &&
		sameConstraint(cache.availableHeight, availableHeight) &&
		sameConstraint(cache.ownerWidth, ownerWidth) &&
		sameConstraint(cache.ownerHeight, ownerHeight)
	);
}

/**
 * Whether one axis of a cached SIZING answer still answers a new query, by
 * Yoga's rules (yoga/algorithm/Cache.cpp, canUseCachedMeasurement). Beyond an
 * identical constraint, three offers are answered by a size already computed:
 *
 *  - an `exactly` offer of the size the node last reported: it was asked to be
 *    that big and had already chosen to be;
 *  - an `at-most` bound over an answer computed under no bound at all -- the
 *    natural size fits inside the bound, so the bound changes nothing;
 *  - a TIGHTER `at-most` bound than the one already answered, with the answer
 *    still inside it.
 *
 * Each of these says the node's size under the new offer equals the size it
 * already has, which is all a sizing pass asks for. It says nothing about the
 * INTERNAL arrangement that produced it, so it holds for sizing answers only:
 * a full layout placed children (and broke text into lines) against exact
 * constraints, and a differently-shaped offer may place them elsewhere.
 */
function sizeStillAnswers(
	cachedMode: MeasureMode,
	cachedAvailable: number,
	cachedComputed: number,
	mode: MeasureMode,
	available: number,
): boolean {
	if (cachedMode === mode && sameConstraint(cachedAvailable, available)) {
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

/**
 * A min-content query: an upper bound of no room at all, which asks the box for
 * the width it cannot go below.
 */
function isMinContent(mode: MeasureMode, available: number): boolean {
	return mode === "at-most" && available === 0;
}

const CACHE_SLOT_COUNT = 9;

/**
 * Which slot of the sizing cache holds the answer to a query, chosen by the
 * query's SHAPE -- which axes are fixed, and whether an open axis is asking for
 * min-content (Taffy's, src/tree/cache.rs compute_cache_slot).
 *
 * A shape only ever displaces its own kind, so the probes one pass makes of the
 * same child cannot knock each other out: a min-content probe never lands where
 * the max-content answer lives, and neither lands on the sizing answer for a
 * fixed box.
 */
function cacheSlot(
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
	// The vertical span this node's subtree can paint, in absolute document
	// rows -- its own box unioned with every descendant's, which absolutely
	// positioned children can push outside the parent box. Recomputed by
	// computePaintExtents after each layout pass; used for viewport culling.
	// (Text that overflows a fixed-height box is not included: the box is the
	// extent. Auto-height boxes -- the normal case -- always contain theirs.)
	extentTop: number;
	extentBottom: number;
	// How many direct children can't be trusted to keep children[] sorted
	// top-to-bottom by extentTop -- derived by computePaintExtents, alongside
	// the extents it is a statement about. Two ways a child breaks that:
	// position:relative/absolute (its own extent can land anywhere -- an
	// offset, or full removal from flow -- regardless of DOM position), or
	// display:none (skipped by flow layout entirely, so its layout.top is
	// never updated from a stale default -- its extent doesn't reflect where
	// it sits in document order, unlike a merely zero-height visible box,
	// which is still correctly slotted). children[] is only guaranteed sorted
	// when this is 0, which is what lets paint-time culling skip straight to
	// the visible range instead of visiting every child to rule it out.
	unstackedChildCount: number;
	// Layout caches: the constraints of the last sizing passes and the last full
	// layout pass, with the sizes they produced. A clean node asked again under
	// constraints it has already answered restores its size and skips its whole
	// subtree -- so a one-line edit relays out its ancestor chain while every
	// clean sibling returns in O(1). Sizing answers are held one per query SHAPE
	// (see cacheSlot), so the several probes one placing pass makes of the same
	// child -- flex basis, automatic minimum, the placing probe -- each keep
	// their own slot and none displaces the answer the next probe wants.
	// Invalidation is the dirty flag, which every mutation path already sets on
	// the way in.
	cachedMeasures: Array<CachedLayout | null>;

	cachedLayout: CachedLayout | null;

	/** Set while a whole style is being assigned; see styleAll. */
	styling: boolean;

	/**
	 * The DOM node this lays out, or null for a node no node owns -- an
	 * anonymous run's, a content root, the viewport. Held here rather than in
	 * a map beside the tree: the reverse lookup is asked for during paint
	 * culling and during every sweep that walks children, and a node that has
	 * left the tree cannot go stale against itself.
	 */
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

	// -- tree ---------------------------------------------------------------

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

	/**
	 * This child's position among its siblings, or -1 if it isn't one.
	 * Searches from the tail: callers that just inserted a run of trailing
	 * children (the common case -- appending in document order) ask about the
	 * most recently added one first, which sits at or near the end.
	 */
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
			// Inside a style assignment: the walk up happens once at the end
			// rather than once per property.
			return;
		}
		markDirtyUpward(this);
	}

	/**
	 * Assign a whole style, one property at a time, as one change.
	 *
	 * A caller applying a computed style touches scores of properties on the
	 * same node, and each setter would otherwise walk this node's ancestors to
	 * the root announcing the same thing. The node is dirty from the first
	 * setter either way; only the announcement is deferred.
	 */
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

	/**
	 * Recompute paint extents for this subtree, and with them the count of
	 * children that break the sort. See extentTop/extentBottom and
	 * unstackedChildCount -- both are derived from the same one visit of every
	 * child, which is the visit that decides whether children[] is sorted.
	 */
	computePaintExtents(originTop: number): void {
		const top = originTop + this.layout.top;
		let extentTop = top;
		let extentBottom = top + this.getComputedHeight();
		let unstacked = 0;
		for (const child of this.children) {
			child.computePaintExtents(top);
			if (breaksStacking(child)) {
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

	// -- style setters ------------------------------------------------------

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

	/** See LayoutResult.gridColumns: the used track sizes of the last layout. */
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

	/**
	 * width / height. The ratio counts cells -- one cell is one cell on either
	 * axis -- so 1 makes a 10-cell-wide box 10 rows tall. A non-finite,
	 * zero or negative value means auto.
	 */
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

	// -- computed getters ---------------------------------------------------

	getComputedWidth(): number {
		return isDefined(this.layout.width) ? this.layout.width : 0;
	}

	getComputedHeight(): number {
		return isDefined(this.layout.height) ? this.layout.height : 0;
	}

	// -- entry point --------------------------------------------------------

	calculateLayout(ownerWidth: number, ownerHeight: number): void {
		const width = resolveValue(this.style.width, ownerWidth);
		const height = resolveValue(this.style.height, ownerHeight);

		let availableWidth = isDefined(width) ? width : ownerWidth;
		let widthMode: MeasureMode = isDefined(availableWidth)
			? "exactly"
			: "unconstrained";
		// A sizing keyword on a root turns the owner's width from the used
		// width into a probe: zero for min-content, a ceiling for fit-content,
		// and no offer at all for max-content.
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

/**
 * Web (browser) flex defaults, always: flex-direction row, align-content
 * stretch, flex-shrink 1. Yoga's non-web defaults (column, flex-shrink 0) are
 * React Native's; a DOM renderer never wants them.
 */
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

/** See LayoutNode's unstackedChildCount. */
function breaksStacking(node: LayoutNode): boolean {
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

// ---------------------------------------------------------------------------
// Reading a layout node's own style
// ---------------------------------------------------------------------------

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
	return 1; // web default
}

/** flex-basis: auto falls back to the main-axis size property. */
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
	// `normal` behaves as `stretch` on a flex item (css-align-3 §4.2).
	return align === "normal" ? "stretch" : align;
}

/**
 * Distance from a node's border-box cross-start edge to its first baseline.
 *
 * A terminal cell has no font metrics, so a text run's baseline is taken to be
 * the top of its first row -- aligning baselines then means aligning first rows,
 * which is what "baseline" can mean on a character grid. A box with no text of
 * its own inherits the baseline of its first in-flow child, per css-flexbox-1
 * §8.5; a box with no in-flow children synthesizes one from its content edge.
 *
 * Note this is NOT the same as flex-start whenever items carry different
 * leading border or padding: those offsets push the first row down inside the
 * box, and baseline alignment is precisely what compensates for them.
 */
function baselineWithinBorderBox(node: LayoutNode, ownerWidth: number): number {
	const contentTop = paddingAndBorderForEdge(node, "top", ownerWidth);

	for (const child of node.children) {
		if (child.style.mode === "none") {
			continue;
		}
		if (isOutOfFlowType(child.style.positionType)) {
			continue;
		}
		return child.layout.top + baselineWithinBorderBox(child, ownerWidth);
	}

	return contentTop;
}

/**
 * The gap between two items along an axis.
 *
 * The row gap separates rows, so it is the gap along the *column* axis, and vice
 * versa -- naming them after what they separate rather than the axis they run
 * along is a reliable way to get this backwards.
 */
function gapForAxis(node: LayoutNode, axis: FlexDirection): number {
	return isRow(axis)
		? node.style.gap["column"]
		: node.style.gap["row"];
}

function marginForAxis(
	node: LayoutNode,
	axis: FlexDirection,
	ownerWidth: number,
): number {
	return (
		resolveMargin(node.style.margin[leadingEdge(axis)], ownerWidth) +
		resolveMargin(node.style.margin[trailingEdge(axis)], ownerWidth)
	);
}

function paddingAndBorderForEdge(
	node: LayoutNode,
	edge: Edge,
	ownerWidth: number,
): number {
	const padding = resolveValue(node.style.padding[edge], ownerWidth);
	return (
		(isDefined(padding) ? Math.max(padding, 0) : 0) + node.style.border[edge]
	);
}

function paddingAndBorderForAxis(
	node: LayoutNode,
	axis: FlexDirection,
	ownerWidth: number,
): number {
	return (
		paddingAndBorderForEdge(node, leadingEdge(axis), ownerWidth) +
		paddingAndBorderForEdge(node, trailingEdge(axis), ownerWidth)
	);
}

function styleDimIsDefined(
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

/** Clamp a value to the node's min/max on the given axis. */
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

/** Clamp, then floor at the padding+border so a box never goes below its own chrome. */
function boundAxis(
	node: LayoutNode,
	axis: FlexDirection,
	value: number,
	axisSize: number,
	ownerWidth: number,
): number {
	return Math.max(
		boundAxisWithinMinMax(node, axis, value, axisSize),
		paddingAndBorderForAxis(node, axis, ownerWidth),
	);
}

/**
 * Tighten a measure mode against the node's max-size on that axis, so a child
 * never gets measured against more space than it could ever occupy.
 */
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
		// A max size caps a size; it does not make it indefinite. Clamping the
		// value but *keeping* the mode is the whole point: downgrading `exactly`
		// to `at-most` here tells the box it is being shrink-wrapped, and one with
		// no content of its own then collapses to zero instead of taking the size
		// flex just resolved for it.
		mode.value = isDefined(mode.value) ? Math.min(mode.value, max) : max;
	} else {
		// An indefinite size, on the other hand, is genuinely bounded by the max.
		mode.value = max;
		mode.mode = "at-most";
	}
}

// ---------------------------------------------------------------------------
// Flex layout (css-flexbox-1), and the out-of-flow boxes every mode places
// ---------------------------------------------------------------------------

/** Resolve a node's four margins against the width percentages are taken from. */
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

/** A leaf with a measure function: ask it, within the given constraints. */
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
	const paddingBorderRow = paddingAndBorderForAxis(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = marginForAxis(node, "row", ownerWidth);
	const marginColumn = marginForAxis(node, "column", ownerWidth);

	const innerWidth = isDefined(availableWidth)
		? Math.max(0, availableWidth - marginRow - paddingBorderRow)
		: NaN;
	const innerHeight = isDefined(availableHeight)
		? Math.max(0, availableHeight - marginColumn - paddingBorderColumn)
		: NaN;

	if (
		widthMode === "exactly" &&
		heightMode === "exactly" &&
		// ...on a sizing pass. A measure function may do more than answer with
		// a size -- ours breaks the text into the lines that later get PAINTED,
		// at whatever width it was offered. Skipping it on the final pass left
		// a stretched flex item painting the lines from the last sizing probe
		// it happened to receive, which is the min-content one: an item 19
		// cells wide rendered "aaa bbb" broken across two lines.
		!performLayout
	) {
		// Both axes are fully determined; no need to consult the measure function.
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

	// An `at-most` bound is an upper bound on the *offer*, not a licence to report a
	// smaller box than the content needs. The measure function already fits the
	// content into the offered width wherever it can; when it cannot -- an
	// unbreakable word -- the content genuinely overflows, and clamping here would
	// have the box claim a size it does not occupy. That lie is what made
	// min-content resolve to zero and let a long word paint over its neighbour.
	setMeasuredDimensions(node, width, height, ownerWidth, ownerHeight);
}

/** A container with no in-flow children collapses to its padding + border. */
function layoutEmptyContainer(
	node: LayoutNode,
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const paddingBorderRow = paddingAndBorderForAxis(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = marginForAxis(node, "row", ownerWidth);
	const marginColumn = marginForAxis(node, "column", ownerWidth);

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

/**
 * Establish a child's flex base size (CSS flexbox 9.2), measuring it against
 * an indefinite main axis when the basis is `content`.
 */
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

	const rowDimDefined = styleDimIsDefined(
		child,
		"row",
		ownerWidth,
	);
	const columnDimDefined = styleDimIsDefined(
		child,
		"column",
		ownerHeight,
	);

	if (isDefined(resolvedBasis) && isDefined(mainAxisSize)) {
		child.layout.computedFlexBasis = Math.max(
			resolvedBasis,
			paddingAndBorderForAxis(child, mainAxis, ownerWidth),
		);
		return;
	}

	if (mainIsRow && rowDimDefined) {
		child.layout.computedFlexBasis = Math.max(
			resolveValue(child.style.width, ownerWidth),
			paddingAndBorderForAxis(child, "row", ownerWidth),
		);
		return;
	}

	if (!mainIsRow && columnDimDefined) {
		child.layout.computedFlexBasis = Math.max(
			resolveValue(child.style.height, ownerHeight),
			paddingAndBorderForAxis(child, "column", ownerWidth),
		);
		return;
	}

	// Basis is `content`: measure the child.
	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	const marginRow = marginForAxis(child, "row", ownerWidth);
	const marginColumn = marginForAxis(child, "column", ownerWidth);

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

	// A stretched child on a definite cross axis is measured at the full cross size.
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
		paddingAndBorderForAxis(child, mainAxis, ownerWidth),
	);
}

interface FlexLine {
	items: LayoutNode[];
	sizeConsumed: number;
	crossDim: number;
	mainDim: number;
}

/**
 * The core algorithm. Structure follows CSS flexbox 9.2-9.7: generate flex
 * items, collect into lines, resolve flexible lengths, then align on both axes.
 */
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
	const cross = crossAxis(mainAxis);
	const mainIsRow = isRow(mainAxis);
	const wrap = node.style.flexWrap !== "nowrap";

	const paddingBorderRow = paddingAndBorderForAxis(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = marginForAxis(node, "row", ownerWidth);
	const marginColumn = marginForAxis(node, "column", ownerWidth);

	const leadingPaddingBorderMain = paddingAndBorderForEdge(
		node,
		leadingEdge(mainAxis),
		ownerWidth,
	);
	const leadingPaddingBorderCross = paddingAndBorderForEdge(
		node,
		leadingEdge(cross),
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

	const mainGap = gapForAxis(node, mainAxis);
	const crossGap = gapForAxis(node, cross);

	// -- 9.2 generate flex items -------------------------------------------

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

		// The content-based minimum is measured first: it lays the child out to
		// find its min-content size, which would otherwise clobber the flex basis
		// computed below.
		child.layout.autoMinMain = autoMinimumMainSize(
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

	// CSS order: sort items into order-modified document order before line
	// collection. The sort is stable, so equal values keep document order;
	// the common all-zero case skips the sort entirely.
	if (inFlow.some((child) => child.style.order !== 0)) {
		inFlow.sort((a, b) => a.style.order - b.style.order);
	}

	// -- 9.3 collect into lines --------------------------------------------

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
			const childMarginMain = marginForAxis(child, mainAxis, ownerWidth);
			const basis = boundAxisWithinMinMax(
				child,
				mainAxis,
				child.layout.computedFlexBasis,
				mainIsRow ? ownerWidth : ownerHeight,
			);

			// A gap precedes every item but the first, so it counts against the
			// line's capacity just like the item's own size.
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

	// -- 9.7 resolve flexible lengths, then align --------------------------

	let totalCrossDim = 0;
	let maxMainDim = 0;

	for (const line of lines) {
		// The gaps are not available to the items, so take them off the top before
		// any of it is distributed.
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

		// Lay each item out at its resolved main size.
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

		// Main-axis placement (justify-content + auto margins).
		positionMainAxis(
			node,
			line,
			mainForItems,
			leadingPaddingBorderMain,
			mainGap,
			ownerWidth,
			performLayout,
		);

		// Line cross size is the tallest item (or the definite cross size for a
		// single-line container).
		let lineCross = 0;
		for (const child of line.items) {
			const childCross =
				(isRow(cross) ? child.layout.width : child.layout.height) +
				marginForAxis(child, cross, ownerWidth);
			lineCross = Math.max(lineCross, childCross);
		}
		// A single-line container fills its cross size only when that size is
		// definite. Under `at-most` it is an upper bound, and treating it as definite
		// would make the container report the full available cross size as its
		// content size -- which then becomes its flex basis in the parent.
		if (!wrap && isDefined(innerCross) && crossMode === "exactly") {
			lineCross = Math.max(lineCross, innerCross);
		}
		line.crossDim = lineCross;

		totalCrossDim += lineCross;
		maxMainDim = Math.max(maxMainDim, line.mainDim);
	}

	// Gaps between the lines themselves.
	totalCrossDim += crossGap * Math.max(0, lines.length - 1);

	// -- measured size ------------------------------------------------------

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

	// -- cross-axis placement ----------------------------------------------

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

	// Reverse axes place items from the far edge.
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

	// -- relative offsets ---------------------------------------------------
	//
	// `position: relative` shifts a box from its in-flow position without
	// affecting anything else, so this runs after all flow placement is done.
	// `position: static` ignores insets entirely.

	const innerWidthFinal = node.layout.width - paddingBorderRow;
	const innerHeightFinal = node.layout.height - paddingBorderColumn;

	for (const line of lines) {
		for (const child of line.items) {
			if (child.style.positionType !== "relative") {
				continue;
			}
			child.layout.left += relativeOffset(
				child,
				"row",
				innerWidthFinal,
			);
			child.layout.top += relativeOffset(
				child,
				"column",
				innerHeightFinal,
			);
		}
	}

	// -- absolutely positioned children ------------------------------------

	for (const child of outOfFlowDescendants(node, false)) {
		layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
	}
	if (node.parent === null) {
		for (const child of outOfFlowDescendants(node, true)) {
			layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
		}
	}
}

/**
 * The out-of-flow boxes this node is the containing block for.
 *
 * An out-of-flow box is laid out by its containing block, which is the nearest
 * positioned box above it -- not, in general, the box that holds it. So the
 * search reaches down through the in-flow boxes between, and stops at any box
 * that is a containing block itself, since whatever falls under that one is
 * that one's to place. A box out of flow is a containing block for its own
 * descendants, so it is taken and not entered.
 */
function outOfFlowDescendants(
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
			// A fixed box belongs to the viewport however deep it sits, so
			// that search passes through every containing block between. An
			// absolute one stops at the first, which claims what falls under
			// it -- itself included, since an out-of-flow box is a containing
			// block for its own descendants.
			if (!viewport && isContainingBlockType(type)) {
				continue;
			}
			enter(child);
		}
	};
	enter(node);
	return found;
}

/** A relative box is offset by its leading inset, or pulled back by its trailing one. */
function relativeOffset(
	node: LayoutNode,
	axis: FlexDirection,
	axisSize: number,
): number {
	const leading = resolveValue(
		node.style.position[leadingEdge(axis)],
		axisSize,
	);
	if (isDefined(leading)) {
		return leading;
	}

	const trailing = resolveValue(
		node.style.position[trailingEdge(axis)],
		axisSize,
	);
	if (isDefined(trailing)) {
		return -trailing;
	}

	return 0;
}

/**
 * CSS flexbox 9.7. Distribute free space by grow factor, or take it back by
 * shrink factor scaled by base size, freezing items that hit min/max and
 * redistributing what they could not absorb.
 */
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

	// The flex base size is what an item wants to be; the hypothetical main size
	// is that clamped by min/max. The distinction matters throughout the loop
	// below: free space is always measured against an unfrozen item's *base*
	// size, never against the size it was last handed, or each pass would count
	// the space it already took a second time.
	const base = new Map<LayoutNode, number>();
	const target = new Map<LayoutNode, number>();
	const frozen = new Set<LayoutNode>();

	// An item never shrinks below its automatic minimum size, so that floor has to
	// be applied everywhere the item is clamped -- not just to its hypothetical
	// size, but to every target the redistribution loop lands on.
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
		// Indefinite main size: items stay at their hypothetical size.
		commit();
		return;
	}

	const outerMargin = (child: LayoutNode) =>
		marginForAxis(child, mainAxis, ownerWidth);

	// css-flexbox-1 §9.7.3: grow or shrink is decided once, by comparing the sum
	// of the items' outer hypothetical main sizes against the container.
	let hypotheticalTotal = 0;
	for (const child of line.items) {
		hypotheticalTotal += target.get(child)! + outerMargin(child);
	}
	const growing = innerMain - hypotheticalTotal > 0;

	// Items only grow into a *definite* main size. Under `at-most` the container is
	// being sized to its content against an upper bound, so there is no free space
	// to distribute -- the container will shrink-wrap instead. Shrinking still
	// applies, since content that overflows the bound must be compressed.
	if (growing && mainMode !== "exactly") {
		commit();
		return;
	}

	const factorOf = (child: LayoutNode) =>
		growing
			? resolveFlexGrow(child)
			: resolveFlexShrink(child) * base.get(child)!;

	// §9.7.4.a: freeze the items that cannot flex. An item whose flex base size
	// already sits on the wrong side of its own clamp can never move in the
	// direction we are flexing, so it is inflexible from the start.
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

	// §9.7.4: distribute the free space, clamp, freeze whatever hit a bound, and
	// go again with the rest. Each pass freezes at least one item, so the line
	// always terminates.
	for (let guard = 0; guard <= line.items.length; guard++) {
		const unfrozen = line.items.filter((child) => !frozen.has(child));
		if (unfrozen.length === 0) {
			break;
		}

		// §9.7.4.b: frozen items contribute their target size, unfrozen items
		// their flex base size.
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

		// §9.7.4.c-d: each unfrozen item's target is its flex base size plus its
		// share of the free space, then clamped.
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

		// §9.7.4.e: freeze by the *sign* of the total violation, not by whoever
		// happened to clamp. Freezing both directions at once would strand the
		// space an over-clamped item gave back.
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

/**
 * css-flexbox-1 §4.5: the automatic minimum size of a flex item.
 *
 * A flex item's min-width/min-height default to `auto`, which floors it at its
 * min-content size -- the longest thing in it that cannot be broken. Without
 * this an item shrinks to nothing and its text simply paints over whatever is
 * next to it, because the text is still as wide as its longest word however
 * narrow the box claims to be.
 *
 * Returns NaN when the item has a specified minimum (that wins) or cannot
 * shrink anyway.
 */
function autoMinimumMainSize(
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

	// Offer the item no room along the main axis: what comes back is what it
	// cannot go below.
	//
	// The cross axis has to keep its real size, though. A column item's
	// min-content *height* depends on how wide it is -- give it unlimited width
	// and its text collapses onto one line, and the floor comes out a row short of
	// what the item actually needs.
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

	// The content-based minimum never exceeds a size the author asked for, nor
	// the item's own maximum.
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

/** Lay out one flex item at its resolved main size, stretching the cross axis if asked. */
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
	const cross = crossAxis(mainAxis);
	const mainIsRow = isRow(mainAxis);

	const mainSize = child.layout.computedFlexBasis;
	const align = getAlignSelf(node, child);

	const crossDimDefined = styleDimIsDefined(
		child,
		cross,
		isRow(cross) ? ownerWidth : ownerHeight,
	);

	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	const marginMainForChild = marginForAxis(child, mainAxis, ownerWidth);
	const marginCrossForChild = marginForAxis(child, cross, ownerWidth);

	// Main axis is now definite.
	if (mainIsRow) {
		childWidth.value = mainSize + marginMainForChild;
		childWidth.mode = "exactly";
	} else {
		childHeight.value = mainSize + marginMainForChild;
		childHeight.mode = "exactly";
	}

	// Cross axis: explicit size wins, else stretch to the line, else shrink-to-fit.
	const crossTarget = crossDimDefined
		? resolveValue(
			isRow(cross) ? child.style.width : child.style.height,
			isRow(cross) ? ownerWidth : ownerHeight,
		)
		: NaN;

	if (isDefined(crossTarget)) {
		// Clamped, like every other resolved size: min-width and max-width bound
		// `width` whichever axis it lands on, and a block container is a COLUMN
		// flex container internally -- so width is its children's CROSS axis, and
		// leaving this unclamped meant `min-width` did nothing at all on the
		// ordinary block boxes that make up most of a document. The main axis
		// already clamps through boundAxis; this is the other half.
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
		// Only stretch against a *definite* cross size. While the container is
		// still being measured its cross size is merely an upper bound, and
		// stretching to it here would make every item report a flex basis of the
		// full container size. Items that still need stretching are re-laid out
		// in positionCrossAxis once the container's real cross size is known.
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

/**
 * Re-lay out a stretch item now that the line's cross size is definite. During
 * item layout the container's cross size was still an upper bound, so a
 * stretched item was only measured to its content.
 */
function stretchFlexItem(
	node: LayoutNode,
	child: LayoutNode,
	targetCross: number,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const mainAxis = node.style.flexDirection;
	const cross = crossAxis(mainAxis);
	const mainIsRow = isRow(mainAxis);

	const mainSize = mainIsRow ? child.layout.width : child.layout.height;
	const marginMain = marginForAxis(child, mainAxis, ownerWidth);
	const marginCross = marginForAxis(child, cross, ownerWidth);

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

/** justify-content, plus auto margins which absorb free space before it does. */
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
			marginForAxis(child, mainAxis, ownerWidth);
	}

	const free = isDefined(innerMain) ? innerMain - contentMain : 0;

	// Auto margins on the main axis eat all remaining free space.
	let autoMarginCount = 0;
	for (const child of line.items) {
		if (child.style.margin[leadingEdge(mainAxis)].unit === "auto") {
			autoMarginCount++;
		}
		if (child.style.margin[trailingEdge(mainAxis)].unit === "auto") {
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
			child.style.margin[leadingEdge(mainAxis)].unit === "auto";
		const trailingAuto =
			child.style.margin[trailingEdge(mainAxis)].unit === "auto";

		if (leadingAuto) {
			cursor += autoShare;
		}

		cursor += resolveMargin(
			child.style.margin[leadingEdge(mainAxis)],
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
			child.style.margin[trailingEdge(mainAxis)],
			ownerWidth,
		);

		if (trailingAuto) {
			cursor += autoShare;
		}
		cursor += between;
		cursor += mainGap;
	}

	// The gaps are part of how far the line reaches, so the container's
	// content size has to include them.
	line.mainDim = contentMain + mainGap * Math.max(0, line.items.length - 1);
}

/** align-items / align-self within each line, and align-content across lines. */
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
	const cross = crossAxis(mainAxis);
	const crossIsRow = isRow(cross);
	const crossGap = gapForAxis(node, cross);

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
			// Equal gaps everywhere, including before the first line and after the
			// last: n lines make n+1 gaps.
			if (lineCount > 0) {
				lineBetween = Math.max(freeCross, 0) / (lineCount + 1);
				lineLeading = lineBetween;
			}
			break;
		case "stretch":
			// Extra space is handed to the lines themselves, below.
			break;
		default:
			lineLeading = 0;
	}

	// align-content: stretch grows each line to share the free cross space.
	const stretchPerLine =
		node.style.alignContent === "stretch" &&
		lineCount > 0 &&
		freeCross > 0
			? freeCross / lineCount
			: 0;

	let cursor = leadingPaddingBorderCross + lineLeading;

	for (const line of lines) {
		const lineCross = line.crossDim + stretchPerLine;

		// Baseline alignment needs the whole line before it can place anything:
		// the item whose baseline sits furthest from its cross-start margin edge
		// goes flush against the line, and every other baseline item is pushed
		// down to meet it. Only meaningful when the cross axis is the block axis
		// (a row container); in a column container the cross axis is horizontal
		// and there is nothing to align, so it degenerates to flex-start.
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
					resolveMargin(child.style.margin[leadingEdge(cross)], ownerWidth) +
					baselineWithinBorderBox(child, ownerWidth);
				maxBaseline = Math.max(maxBaseline, childBaseline);
			}
		}

		for (const child of line.items) {
			const align = getAlignSelf(node, child);
			const leadingMargin = resolveMargin(
				child.style.margin[leadingEdge(cross)],
				ownerWidth,
			);
			const trailingMargin = resolveMargin(
				child.style.margin[trailingEdge(cross)],
				ownerWidth,
			);

			const leadingAuto =
				child.style.margin[leadingEdge(cross)].unit === "auto";
			const trailingAuto =
				child.style.margin[trailingEdge(cross)].unit === "auto";

			// Stretch items now that the line's cross size is definite. Auto
			// margins opt an item out of stretching -- they absorb the space instead.
			const crossDimDefined = styleDimIsDefined(
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
							// Column container: no block axis to align along.
							offset = 0;
						} else {
							const childBaseline =
								leadingMargin + baselineWithinBorderBox(child, ownerWidth);
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

/**
 * Mirror each item within the content box. Positions are relative to the border
 * box but offset by the *leading* padding, so the mirror has to be taken in
 * content-box coordinates and then shifted back.
 */
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

/**
 * Absolute children: size from style or content, then place against the
 * insets -- and where an axis has no inset at all, at the static position the
 * flow the box left reports for it (CSS 2 §10.3.7).
 */
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

	// The containing block: the parent's padding box, or -- for a grid child
	// the author placed on lines -- its grid area (css-grid-2 §9.2).
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

	// An auto margin between an inset and the box is the box asking to be
	// placed in the space the insets leave rather than stretched across it --
	// the same reading the in-flow block path gives `margin: auto`, and what
	// centers a modal dialog in the viewport.
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

	if (styleDimIsDefined(child, "row", basisWidth)) {
		childWidth.value =
			resolveValue(child.style.width, basisWidth) + marginLeft + marginRight;
		childWidth.mode = "exactly";
	} else if (shrinkAcross) {
		// Auto margins on both sides: the insets bound the box, they do not
		// size it, so it shrinks to its content within them.
		childWidth.value = blockWidth - left - right;
		childWidth.mode = "at-most";
	} else if (isDefined(left) && isDefined(right)) {
		// Both insets pin the box, so its width is implied.
		childWidth.value = blockWidth - left - right - marginLeft - marginRight;
		childWidth.mode = "exactly";
	} else if (isDefined(blockWidth)) {
		childWidth.value = blockWidth;
		// `stretch` (and the `normal` a grid area gives it) fills the alignment
		// container when the box's size and both its insets are auto
		// (css-align-3 §5.2). Nothing but a grid area has an alignment
		// container to fill, so nothing else stretches.
		childWidth.mode =
			area && gridSelfAlign(node, child, true) === "stretch"
				? "exactly"
				: "at-most";
	}

	if (styleDimIsDefined(child, "column", basisHeight)) {
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
			area && gridSelfAlign(node, child, false) === "stretch"
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

	// An axis with insets on neither side falls back to the static position;
	// one with an inset on either side is pinned and never asks for it.
	const staticPosition =
		(!isDefined(left) && !isDefined(right)) ||
		(!isDefined(top) && !isDefined(bottom))
			? (child.staticPositionFunc?.(node) ?? null)
			: null;

	const isGrid = node.style.mode === "grid";

	// Horizontal placement.
	if (shrinkAcross) {
		// The space the insets left, minus the box, goes to the auto margins:
		// half each, which is centering.
		const free = blockWidth - left - right - child.layout.width;
		child.layout.left = blockLeft + left + Math.max(free, 0) / 2;
	} else if (isDefined(left)) {
		child.layout.left = blockLeft + left + marginLeft;
	} else if (isDefined(right)) {
		child.layout.left =
			blockLeft + blockWidth - child.layout.width - right - marginRight;
	} else if (staticPosition) {
		child.layout.left = staticPosition.left + marginLeft;
	} else {
		const free = blockWidth - child.layout.width;
		// A grid container aligns an out-of-flow box by the box's own
		// justify-self, which is the alignment its area was going to give it.
		const align = isGrid
			? gridSelfAlign(node, child, true)
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

	// Vertical placement.
	if (shrinkDown) {
		const free = blockHeight - top - bottom - child.layout.height;
		child.layout.top = blockTop + top + Math.max(free, 0) / 2;
	} else if (isDefined(top)) {
		child.layout.top = blockTop + top + marginTop;
	} else if (isDefined(bottom)) {
		child.layout.top =
			blockTop + blockHeight - child.layout.height - bottom - marginBottom;
	} else if (staticPosition) {
		child.layout.top = staticPosition.top + marginTop;
	} else {
		const free = blockHeight - child.layout.height;
		const align = isGrid
			? gridSelfAlign(node, child, false)
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

	// Everything above placed the box in its CONTAINING BLOCK's space, but a
	// layout position is read relative to the box's parent, and an out-of-flow
	// box is rarely a child of the block that contains it. Take off what the
	// boxes in between contribute, so accumulating the chain lands it where
	// the containing block put it.
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

// ---------------------------------------------------------------------------
// Table layout (CSS 2.1 §17, automatic table layout)
//
// A table is NOT flexbox. Its defining property is that columns are shared: a
// column's width is decided by every cell in it, across every row. Emulating
// that with a flex row per <tr> cannot work -- each row would size its cells
// independently -- so `display: table` is its own layout mode here.
// ---------------------------------------------------------------------------

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

/**
 * Collect the table's rows in *visual* order.
 *
 * Header groups come first and footer groups last, however they were written --
 * a <tfoot> before <tbody> in the source still renders at the bottom.
 */
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
				// colgroup/col and anything else generate no box of their own.
				zeroLayout(child);
				break;
		}
	}

	return {rows: [...header, ...body, ...footer], captions, groups};
}

/**
 * Place cells on the grid, honouring colspan and rowspan.
 *
 * A cell with rowspan reserves its slots in the rows below, so the next row's
 * cells flow past them rather than under them.
 */
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

/**
 * A cell's intrinsic width.
 *
 * min-content is the width it cannot go below -- its longest unbreakable word --
 * obtained by offering it no room at all and letting it wrap everywhere it can.
 * max-content is what it would take if never wrapped.
 */
function intrinsicCellWidth(
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

/** Spread `extra` over `count` columns, giving the remainder to the earlier ones. */
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

/**
 * Resolve one set of column widths for the whole table (CSS 2.1 §17.5.2.2).
 *
 * `available` is the width the columns have to fill, already including the cells
 * that collapsed borders will overlap away.
 */
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
	// A column whose cell specifies a width is fixed: surplus space goes to the
	// auto columns instead, otherwise `<td style="width:8ch">` would be inflated
	// by the very slack it was meant to give away.
	const fixed = new Array<boolean>(columnCount).fill(false);

	for (const cell of cells) {
		const styleWidth = resolveValue(cell.node.style.width, ownerWidth);
		if (isDefined(styleWidth)) {
			// An explicit width is both the floor and the preference.
			cell.minWidth = styleWidth;
			cell.maxWidth = styleWidth;
			if (cell.colSpan === 1) {
				fixed[cell.column] = true;
			}
		} else {
			cell.minWidth = intrinsicCellWidth(
				cell.node,
				true,
				ownerWidth,
				ownerHeight,
			);
			cell.maxWidth = intrinsicCellWidth(
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

	// A spanning cell only widens its columns by whatever it needs beyond what
	// they already provide between them.
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

	// A table with an indefinite width shrink-wraps to its content rather than
	// filling its container, which is why `<table>` in a browser is only as wide
	// as it needs to be.
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
		// Room to spare: every column gets what it wants, and the surplus goes to
		// the auto columns -- a column with an explicit width keeps it. This has to
		// be tested before the "cannot fit" case below, because when every column
		// is already at its preferred width (totalMin === totalMax) that case would
		// otherwise swallow it and hand the surplus to the fixed columns too.
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

		// If every column is fixed there is nobody to give it to, so spread it out
		// rather than leaving the table short of the width it was told to be.
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
		// Cannot fit: every column takes its minimum and the table overflows. A
		// column never goes below its min-content width, which is what stops a long
		// word painting over the cell next to it.
		for (let i = 0; i < columnCount; i++) {
			widths[i] = mins[i];
		}
	} else {
		// In between: interpolate each column from its min toward its max.
		const ratio = (target - totalMin) / (totalMax - totalMin);
		for (let i = 0; i < columnCount; i++) {
			widths[i] = mins[i] + (maxs[i] - mins[i]) * ratio;
		}
	}

	// Snap to whole cells by rounding the column *edges*, so the columns tile the
	// table exactly instead of drifting by a cell.
	const snapped = new Array<number>(columnCount).fill(0);
	let edge = 0;
	for (let i = 0; i < columnCount; i++) {
		const next = edge + widths[i];
		snapped[i] = Math.round(next) - Math.round(edge);
		edge = next;
	}

	return snapped;
}

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
	const paddingBorderRow = paddingAndBorderForAxis(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = marginForAxis(node, "row", ownerWidth);
	const marginColumn = marginForAxis(node, "column", ownerWidth);

	const leftPaddingBorder = paddingAndBorderForEdge(
		node,
		"left",
		ownerWidth,
	);
	const topPaddingBorder = paddingAndBorderForEdge(node, "top", ownerWidth);

	const {rows, captions, groups} = collectTableRows(node);
	const {cells, columnCount} = buildTableGrid(rows);

	// Collapsed borders are shared: each cell after the first overlaps its
	// neighbour by exactly the one cell they both draw a border in.
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

	/** Where column `index` starts, once the shared borders are folded away. */
	const columnStart = (index: number) => columnEdges[index] - overlap * index;

	/** Width of a cell spanning `span` columns from `index`. */
	const spanWidth = (index: number, span: number) =>
		columnEdges[index + span] - columnEdges[index] - overlap * (span - 1);

	const contentWidth = Math.max(0, columnEdges[columnCount] - columnOverlap);

	// -- captions ----------------------------------------------------------
	// A caption is not part of the grid: it sits above the table, as wide as it.
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

	// -- row heights -------------------------------------------------------
	// Lay each cell out at its resolved column width to find how tall it is; the
	// row is as tall as its tallest cell.
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

	// A row-spanning cell only makes rows taller if the rows it covers cannot
	// already hold it.
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

	// Stack the rows, folding away the border each one shares with the row above.
	// A zero-height row -- an empty <tr> -- has no border to share, so it must not
	// consume an overlap: doing so pulls every row after it up by one and lands
	// their text on top of the row above.
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

	// -- table box ---------------------------------------------------------
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

	// -- placement ---------------------------------------------------------
	// Children are positioned relative to their own parent's border box, so a
	// cell is placed within its row, and a row within its group.
	const gridTop = topPaddingBorder + captionHeight;

	for (const group of groups) {
		group.layout.left = leftPaddingBorder;
		group.layout.width = contentWidth;
		group.layout.top = gridTop;
		group.layout.height = gridHeight;
	}

	rows.forEach((row, index) => {
		// A row inside a group is positioned relative to that group's border box,
		// and every group's box starts at gridTop, so the two cancel out.
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

		// Re-lay the cell at its final size. This has to be the *last* measure of
		// its text: the measure function records the line breaks the renderer will
		// draw, so an earlier intrinsic pass must not be what the renderer sees.
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

		// Relative to the cell's own row, which already sits at the right y.
		cell.node.layout.left = columnStart(cell.column);
		cell.node.layout.top = 0;
	}
}

// ---------------------------------------------------------------------------
// Grid layout (css-grid-2)
//
// A grid is not flexbox and not a table. Its defining property is that items
// are placed onto a two-dimensional set of shared tracks: a track's size is
// decided by every item that crosses it, and an item's position is decided by
// lines that exist whether or not anything sits between them. Neither of the
// other two modes can express that, so `display: grid` is its own layout mode.
//
// Excluded, and named rather than silently missing: `subgrid` (css-grid-2
// §9.5), whose tracks come from an ancestor grid, and `masonry`
// (css-grid-3), which is not a grid at all in the second axis. The track-list
// parser refuses both.
// ---------------------------------------------------------------------------

/** A track as the sizing algorithm works on it (css-grid-2 §12.2). */
interface GridTrack {
	size: TrackSize;

	/** The track's floor: what it has been grown to so far. */
	base: number;

	/** Infinity until §12.5 gives an intrinsic or flexible track a limit. */
	growthLimit: number;

	/** The `fit-content()` clamp; Infinity for every other sizing function. */
	fitContentLimit: number;

	/**
	 * css-grid-2 §12.5.1: the growth limit was set from a content contribution
	 * one step ago and is not the author's word on the track, so the next
	 * distribution grows past it as though it were still infinite.
	 */
	infinitelyGrowable: boolean;

	/** Scratch space for one distribution pass: an increase not yet applied. */
	planned: number;

	/** The track's start edge within the container's content box. */
	position: number;

	/** An `auto-fit` track that took no item: it occupies no space at all. */
	collapsed: boolean;
}

/** A grid item, with the lines its area sits between once placement is done. */
interface GridItem {
	node: LayoutNode;

	/** Placement as authored: a start line (null when auto) and a span. */
	column: {start: number | null; span: number};
	row: {start: number | null; span: number};

	/** Track indices, after the implicit grid is normalized to start at zero. */
	columnStart: number;
	columnEnd: number;
	rowStart: number;
	rowEnd: number;
}

/** A track breadth's length, or NaN when it is not one (or is an unresolvable %). */
function trackLength(breadth: TrackBreadth, ownerSize: number): number {
	if (breadth.kind !== "length") {
		return NaN;
	}
	return resolveValue(breadth.value, ownerSize);
}

/**
 * Whether a breadth sizes from the items in the track rather than from a
 * length. A percentage against an indefinite size is one of them: it cannot be
 * resolved, and css-grid-2 §7.2.1 says it then behaves as `auto`.
 */
function isIntrinsicBreadth(breadth: TrackBreadth, ownerSize: number): boolean {
	return breadth.kind !== "flex" && !isDefined(trackLength(breadth, ownerSize));
}

/** The size a track takes for counting `repeat(auto-fill)` repetitions. */
function definiteTrackSize(size: TrackSize, ownerSize: number): number {
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

/** An expanded `<track-list>`: its tracks, and the names of the lines between them. */
interface ExpandedTracks {
	sizes: TrackSize[];

	/** Names of line i, for i in [0, sizes.length]. */
	lineNames: string[][];

	/** The range an `auto-fit` repeat produced, whose empty tracks collapse. */
	autoFit: {start: number; count: number} | null;
}

/**
 * Expand a track list into tracks and line names, deciding the repetition
 * count of an `auto-fill`/`auto-fit` group from the space available
 * (css-grid-2 §7.2.3.2). With no definite space to fill, the group repeats
 * once, which is what the spec says of an indefinite maximum.
 */
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
				fixedSum += definiteTrackSize(part.track.size, ownerSize);
				fixedCount++;
				continue;
			}
			const count =
				typeof part.repeat.count === "number" ? part.repeat.count : 1;
			for (const track of part.repeat.tracks) {
				fixedSum += count * definiteTrackSize(track.size, ownerSize);
				fixedCount += count;
			}
		}
		let repeatSum = 0;
		for (const track of autoPart.repeat.tracks) {
			repeatSum += definiteTrackSize(track.size, ownerSize);
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

/**
 * The implicit line names a `grid-template-areas` map generates: an area named
 * `foo` names its four edges `foo-start` and `foo-end` on both axes
 * (css-grid-2 §7.3).
 */
function areaLineNames(areas: GridAreaMap): {
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

/** Every line name of one axis: the template's own, plus the areas' implicit ones. */
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

/** One `<grid-line>`, resolved as far as it can be without its opposite end. */
type ResolvedLine =
	{kind: "auto"} |
	{kind: "line"; index: number} |
	{kind: "span"; count: number} |
	{kind: "spanName"; name: string; count: number};

/**
 * The line a name and an ordinal name (css-grid-2 §8.3). Outside the explicit
 * grid every implicit line answers to the name, which is what keeps a
 * placement against a name that does not exist definite rather than dropped.
 */
function namedLine(
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
		// A bare name is first read as a named AREA's edge: an area `foo` names
		// the lines `foo-start` and `foo-end`, and `grid-row-start: foo` means
		// the one on the side it is written on.
		if (placement.index === null) {
			const edgeName = `${placement.name}-${edge}`;
			if (names.has(edgeName)) {
				return {
					kind: "line",
					index: namedLine(names, edgeName, 1, explicitCount),
				};
			}
		}
		return {
			kind: "line",
			index: namedLine(
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

/** The `count`-th line named `name` on one side of `from`. */
function spanToName(
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

/**
 * Pair a start and an end line into a definite position and a span
 * (css-grid-2 §8.3). A start of null is an item the auto-placement pass has
 * still to position; the span it carries is what that pass places.
 */
function pairGridLines(
	startLine: ResolvedLine,
	endLine: ResolvedLine,
	names: Map<string, number[]>,
): {start: number | null; span: number} {
	const start = startLine;
	let end = endLine;

	const isSpan = (line: ResolvedLine) =>
		line.kind === "span" || line.kind === "spanName";

	// Two spans say nothing about where the item goes: the end one is dropped.
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
		// A zero-width area is one track tall: the end line is dropped.
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
			const line = spanToName(names, end.name, end.count, start.index, true);
			return {start: start.index, span: Math.max(1, line - start.index)};
		}
		return {start: start.index, span: 1};
	}

	if (end.kind === "line") {
		if (start.kind === "span") {
			return {start: end.index - start.count, span: start.count};
		}
		if (start.kind === "spanName") {
			const line = spanToName(names, start.name, start.count, end.index, false);
			return {start: line, span: Math.max(1, end.index - line)};
		}
		// Only an end line: the item is one track wide, ending there.
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

/**
 * css-grid-2 §8.5: place the items whose position the author did not give.
 *
 * Written over a major and a minor axis so that `grid-auto-flow: column` is
 * the same walk with the two swapped -- the cursor advances along the major
 * axis and fills the minor one.
 */
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

	// The implicit grid starts at the start-most line anything was placed on.
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

	// §8.5 step 3: how far the minor axis reaches. Items with an auto minor
	// position still widen it by their span, or they could never be placed.
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

	// §8.5 step 1: everything the author placed on both axes.
	for (const item of items) {
		if (major(item).start !== null && minor(item).start !== null) {
			occupy(item);
		}
	}

	// §8.5 step 2: items locked to a major position, free along the minor one.
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

	// §8.5 step 4: the rest, swept by a cursor over the whole implicit grid.
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
			// The minor position is fixed: sweep the major axis for room.
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

// -- track sizing (css-grid-2 §12) ------------------------------------------

/** What one axis of the track sizing algorithm works from. */
interface TrackSizing {
	node: LayoutNode;
	tracks: GridTrack[];
	items: GridItem[];

	/** Whether this pass is sizing the inline axis. */
	columns: boolean;

	/** The space the tracks have to fill; NaN when the container is indefinite. */
	availableSpace: number;
	gap: number;

	/** The size percentages in the track list resolve against. */
	ownerSize: number;
	ownerWidth: number;
	ownerHeight: number;

	/** The sized columns, which an item's height is measured against. */
	columnSizes: number[] | null;
	columnGap: number;

	/** Whether the content alignment on this axis stretches auto tracks (§12.8). */
	stretchesAutoTracks: boolean;

	/**
	 * How much taller a baseline-aligned item makes its row than its own box
	 * (css-grid-2 §12.5 step 1): the distance it will be pushed down to meet
	 * the row's furthest baseline. Sizing a row without it leaves the row a
	 * cell short of what the alignment then needs. Null on the column pass.
	 */
	baselineShims: Map<LayoutNode, number> | null;
}

function itemTrackRange(sizing: TrackSizing, item: GridItem): [number, number] {
	return sizing.columns
		? [item.columnStart, item.columnEnd]
		: [item.rowStart, item.rowEnd];
}

/** The room a run of tracks provides, gaps between them included. */
function spanOfTracks(
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

/**
 * An item's contribution along the axis being sized: the size it needs when it
 * may wrap everywhere it can (min-content) or nowhere at all (max-content).
 *
 * A row-axis contribution is a HEIGHT, which only exists once the item knows
 * how wide it is -- so the row pass measures every item at the width its
 * columns came to, which is why columns are sized first.
 */
function gridItemContribution(
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
			marginForAxis(child, "row", sizing.ownerWidth)
		);
	}
	const width = spanOfTracks(
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
		marginForAxis(child, "column", sizing.ownerWidth) +
		(sizing.baselineShims?.get(child) ?? 0)
	);
}

/**
 * How far each baseline-aligned item will be pushed down within its row, from
 * the item in that row whose first baseline sits furthest from its own top
 * (css-grid-2 §10.1, over the baseline this engine has: see
 * baselineWithinBorderBox).
 */
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
		if (gridSelfAlign(node, item.node, false) !== "baseline") {
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
				spanOfTracks(columnSizes, columnGap, item.columnStart, item.columnEnd),
				NaN,
				"exactly",
				"unconstrained",
				ownerWidth,
				ownerHeight,
				false,
			);
			const baseline =
				resolveMargin(item.node.style.margin.top, ownerWidth) +
				baselineWithinBorderBox(item.node, ownerWidth);
			baselines.set(item, baseline);
			furthest = Math.max(furthest, baseline);
		}
		for (const item of group) {
			shims.set(item.node, furthest - baselines.get(item)!);
		}
	}
	return shims;
}

/**
 * css-grid-2 §6.6: an item's automatic minimum size -- its min-content
 * contribution, except that a fixed maximum on the one track it sits in caps
 * it, so an item never forces a track past a size the author wrote.
 */
function minimumContribution(
	sizing: TrackSizing,
	item: GridItem,
	start: number,
	end: number,
): number {
	const minContent = gridItemContribution(sizing, item, true);
	if (end - start === 1) {
		const max = trackLength(sizing.tracks[start].size.max, sizing.ownerSize);
		if (isDefined(max)) {
			return Math.min(minContent, Math.max(0, max));
		}
	}
	return minContent;
}

const EPSILON = 0.0001;

/**
 * css-grid-2 §12.6: hand `space` to the tracks a spanning item crosses, equally
 * and up to each one's limit, and give whatever no track could take to the ones
 * that are allowed past theirs.
 */
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
	// A base grows toward its own growth limit. A growth limit grows toward
	// nothing at all -- it is already where it stops -- unless it was set from
	// a contribution one step ago, which is what infinitely growable marks:
	// such a limit grows on, up to a fit-content() clamp if the track has one
	// (css-grid-2 §12.5.1).
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

/** css-grid-2 §12.5: size the tracks whose sizing function reads their content. */
function resolveIntrinsicTrackSizes(sizing: TrackSizing): void {
	const {tracks, items, ownerSize} = sizing;

	const intrinsicMin = (track: GridTrack) =>
		isIntrinsicBreadth(track.size.min, ownerSize);
	const intrinsicMax = (track: GridTrack) =>
		isIntrinsicBreadth(track.size.max, ownerSize);
	const flexible = (track: GridTrack) => track.size.max.kind === "flex";

	// -- items in a single track -------------------------------------------
	const limits = new Array<number>(tracks.length).fill(-Infinity);
	for (const item of items) {
		const [start, end] = itemTrackRange(sizing, item);
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
					? gridItemContribution(sizing, item, true)
					: kind === "max-content"
						? gridItemContribution(sizing, item, false)
						: minimumContribution(sizing, item, start, end);
			track.base = Math.max(track.base, floor);
		}
		if (intrinsicMax(track)) {
			const limit =
				track.size.max.kind === "min-content"
					? gridItemContribution(sizing, item, true)
					: gridItemContribution(sizing, item, false);
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

	// -- items spanning more than one track, in span order ------------------
	const spanning = items
		.filter((item) => {
			const [start, end] = itemTrackRange(sizing, item);
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
			const [aStart, aEnd] = itemTrackRange(sizing, a);
			const [bStart, bEnd] = itemTrackRange(sizing, b);
			return aEnd - aStart - (bEnd - bStart);
		});

	for (const item of spanning) {
		const [start, end] = itemTrackRange(sizing, item);
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
		// Every step below measures what the item still needs against what the
		// tracks provide AT THAT POINT: a sum taken before the step before it
		// grew a track would count the same space twice.
		const limitSum = () =>
			indices.reduce(
				(sum, i) =>
					sum +
					(tracks[i].growthLimit === Infinity
						? tracks[i].base
						: tracks[i].growthLimit),
				0,
			);

		const minContent = gridItemContribution(sizing, item, true);
		const maxContent = gridItemContribution(sizing, item, false);
		const minimum = minimumContribution(sizing, item, start, end);

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
		// A limit this step turned from infinite to finite is the item's own
		// contribution, not a size the author asked for, so the step below may
		// grow past it (css-grid-2 §12.5).
		indices.forEach((index, at) => {
			tracks[index].infinitelyGrowable =
				wasInfinite[at] && tracks[index].growthLimit !== Infinity;
		});
		// 5. max-content maximums. `auto` is a max-content maximum here, both
		// for the tracks the space is shared among and for the ones that take
		// what none of them could hold (css-grid-2 §7.2.3).
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

	// -- items crossing a flexible track ------------------------------------
	// A flexible track's share of an item is decided by its flex factor, not
	// shared out equally: §12.5.4 defers the rest to the fr resolution below.
	for (const item of items) {
		const [start, end] = itemTrackRange(sizing, item);
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
		const deficit = gridItemContribution(sizing, item, true) - baseSum - gaps;
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

	// A growth limit still infinite has nothing to grow toward: it is the base.
	for (const track of tracks) {
		if (track.growthLimit === Infinity) {
			track.growthLimit = track.base;
		}
	}
}

/**
 * css-grid-2 §12.7.1: the size of one `fr` over a set of tracks, found by
 * freezing every flexible track whose base size already exceeds its share and
 * dividing what is left again -- the same freeze-and-redistribute shape as
 * flexbox's §9.7.
 */
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
		// A total flex factor below 1 leaves part of the space unclaimed, which
		// is what makes `0.5fr` take half of what `1fr` would.
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

/** The whole of §12.3: initialize, resolve, maximize, expand, stretch. */
function sizeTracks(sizing: TrackSizing): void {
	const {tracks, availableSpace, gap} = sizing;
	const live = tracks.filter((track) => !track.collapsed).length;
	const gaps = gap * Math.max(0, live - 1);

	resolveIntrinsicTrackSizes(sizing);

	// §12.6 maximize tracks.
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
		// Indefinite space: a track takes everything its growth limit allows.
		for (const track of tracks) {
			if (track.growthLimit > track.base) {
				track.base = track.growthLimit;
			}
		}
	}

	// §12.7 expand flexible tracks.
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
			// §12.7.1 with an indefinite container: the fr is the largest any one
			// flexible track already demands.
			frSize = 0;
			for (const index of flexIndices) {
				const factor = (tracks[index].size.max as {factor: number}).factor;
				frSize = Math.max(frSize, tracks[index].base / Math.max(factor, 1));
			}
			for (const item of sizing.items) {
				const [start, end] = itemTrackRange(sizing, item);
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
				const contribution = gridItemContribution(sizing, item, false);
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

	// §12.8 expand stretched auto tracks.
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

// -- alignment (css-align-3, as css-grid-2 §10 uses it) ----------------------

/**
 * How a grid distributes the space left over around its tracks. A separate
 * vocabulary from Align and Justify, and translated into from them: the flex
 * keywords name the edges flex-start and flex-end, the grid ones start and
 * end. `normal` and `stretch` mean the tracks themselves take the free space
 * (css-align-3 §12.8).
 */
type ContentAlign =
	"start" |
	"center" |
	"end" |
	"space-between" |
	"space-around" |
	"space-evenly" |
	"stretch";

function inlineContentAlign(node: LayoutNode): ContentAlign {
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

function blockContentAlign(node: LayoutNode): ContentAlign {
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

/**
 * A grid item's alignment on one axis: its own `*-self`, or the container's
 * `*-items` where that is `auto`. `normal` on a grid item means `stretch`
 * (css-align-3 §4.2), which is why an item with no width fills its area.
 */
function gridSelfAlign(
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

/** Lay the tracks out across the content box, per justify-content/align-content. */
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

/** Lay one item out in its grid area, sized and placed by its own alignment. */
function layoutGridItem(
	node: LayoutNode,
	item: GridItem,
	areaLeft: number,
	areaTop: number,
	areaWidth: number,
	areaHeight: number,
	performLayout: boolean,
): void {
	// The grid AREA is the item's containing block (css-grid-2 §6.4), so it is
	// what the item's own percentages -- its size, its margins, its padding --
	// are a share of, and what it hands down as its owner size.
	const ownerWidth = areaWidth;
	const ownerHeight = areaHeight;
	const child = item.node;
	const justify = gridSelfAlign(node, child, true);
	const align = gridSelfAlign(node, child, false);

	const autoLeft = child.style.margin.left.unit === "auto";
	const autoRight = child.style.margin.right.unit === "auto";
	const autoTop = child.style.margin.top.unit === "auto";
	const autoBottom = child.style.margin.bottom.unit === "auto";

	const marginRow = marginForAxis(child, "row", ownerWidth);
	const marginColumn = marginForAxis(child, "column", ownerWidth);

	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	if (styleDimIsDefined(child, "row", ownerWidth)) {
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				"row",
				resolveValue(child.style.width, ownerWidth),
				areaWidth,
			) + marginRow;
		childWidth.mode = "exactly";
	} else if (justify === "stretch" && !autoLeft && !autoRight) {
		// An area is a definite size, so a stretched item takes all of it --
		// the value offered includes the item's own margins, which the box
		// takes off for itself.
		childWidth.value = Math.max(0, areaWidth);
		childWidth.mode = "exactly";
	} else {
		childWidth.value = Math.max(0, areaWidth);
		childWidth.mode = "at-most";
	}

	if (styleDimIsDefined(child, "column", ownerHeight)) {
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
		alignmentOffset(justify, freeX, autoLeft, autoRight) +
		resolveMargin(child.style.margin.left, ownerWidth);
	child.layout.top =
		areaTop +
		alignmentOffset(align, freeY, autoTop, autoBottom) +
		resolveMargin(child.style.margin.top, ownerWidth);
}

/**
 * Where a box sits in the free space of its area. Auto margins take the space
 * before alignment does (css-align-3 §5.3): two of them center the box, one
 * pushes it to the far edge.
 */
function alignmentOffset(
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

/**
 * css-grid-2 §10.1: within one row, the items asking for baseline alignment
 * put their first baselines on a line -- which on a character grid means their
 * first rows (see baselineWithinBorderBox).
 */
function alignGridBaselines(
	node: LayoutNode,
	items: GridItem[],
	ownerWidth: number,
): void {
	const rows = new Map<number, GridItem[]>();
	for (const item of items) {
		if (gridSelfAlign(node, item.node, false) !== "baseline") {
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
				baselineWithinBorderBox(item.node, ownerWidth),
			);
		}
		for (const item of group) {
			item.node.layout.top +=
				furthest - baselineWithinBorderBox(item.node, ownerWidth);
		}
	}
}

/** See LayoutResult.gridColumns: track sizes taken off rounded track edges. */
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

/**
 * The grid layout algorithm (css-grid-2 §12.1): place the items, size the
 * columns, size the rows against those columns, then align everything.
 *
 * Columns come first because a row-axis contribution is a height, and a box's
 * height is a function of how wide it is -- on a character grid more than
 * anywhere, since a paragraph's row count is decided entirely by where its
 * text wraps.
 */
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
	const paddingBorderRow = paddingAndBorderForAxis(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = marginForAxis(node, "row", ownerWidth);
	const marginColumn = marginForAxis(node, "column", ownerWidth);
	const contentLeft = paddingAndBorderForEdge(node, "left", ownerWidth);
	const contentTop = paddingAndBorderForEdge(node, "top", ownerWidth);

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

	// -- grid items ---------------------------------------------------------
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
	// Auto-placement runs in ORDER-MODIFIED document order (css-grid-2 §8.5),
	// so `order` moves an item's place on the grid, not merely its painting.
	if (children.some((child) => child.style.order !== 0)) {
		children.sort((a, b) => a.style.order - b.style.order);
	}

	// -- the explicit grid --------------------------------------------------
	const areas = node.style.gridTemplateAreas;
	const fromAreas = areas
		? areaLineNames(areas)
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

	// -- placement ----------------------------------------------------------
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

	// The implicit grid, normalized so that track 0 is its start-most track.
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

	/**
	 * The tracks of one axis: the template's where the explicit grid reaches,
	 * and grid-auto-rows/columns cycling over every implicit one.
	 */
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

	/** css-grid-2 §7.2.3.2: an `auto-fit` track with no item in it collapses. */
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

	const inlineAlign = inlineContentAlign(node);
	const blockAlign = blockContentAlign(node);

	// -- size the columns ---------------------------------------------------
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
	// A shrink-to-fit grid that overflows its bound is re-sized against it:
	// the bound is the space the tracks actually have to share out.
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

	// -- size the rows ------------------------------------------------------
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

	// -- the grid container's own box ---------------------------------------
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

	// -- align the tracks in the content box --------------------------------
	const usedInnerWidth = Math.max(0, node.layout.width - paddingBorderRow);
	const usedInnerHeight = Math.max(0, node.layout.height - paddingBorderColumn);

	positionTracks(
		columnTracks,
		usedInnerWidth - columnsTotal,
		columnGap,
		inlineAlign,
	);
	positionTracks(rowTracks, usedInnerHeight - rowsTotal, rowGap, blockAlign);

	// The used track sizes as the grid is actually drawn: snapped the way
	// roundToGrid snaps the boxes in them, by rounding the EDGES, so the
	// reported sizes tile the container exactly rather than each rounding away
	// from its neighbour.
	node.layout.gridColumns = snapTrackSizes(columnTracks, columnGap);
	node.layout.gridRows = snapTrackSizes(rowTracks, rowGap);
	node.layout.gridColumnOffset = -columnBase || 0;
	node.layout.gridRowOffset = -rowBase || 0;

	/**
	 * The content-box position of a grid line, in track-array indices.
	 *
	 * A line has two positions once the tracks are spread apart by
	 * justify-content or a gap: the far edge of the track before it, and the
	 * near edge of the track after it. An area takes the INNER pair, so that
	 * the space distributed between tracks stays between them and does not
	 * become part of anybody's area.
	 */
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

	// -- place the items ----------------------------------------------------
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

	// -- relative offsets ---------------------------------------------------
	for (const item of items) {
		const child = item.node;
		if (child.style.positionType !== "relative") {
			continue;
		}
		child.layout.left += relativeOffset(
			child,
			"row",
			usedInnerWidth,
		);
		child.layout.top += relativeOffset(
			child,
			"column",
			usedInnerHeight,
		);
	}

	// -- absolutely positioned children (css-grid-2 §9) ---------------------
	for (const child of outOfFlowDescendants(node, false)) {
		layoutAbsoluteChild(
			node,
			child,
			ownerWidth,
			ownerHeight,
			absoluteGridArea(
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

/**
 * css-grid-2 §9.2: an absolutely positioned child of a grid container whose
 * grid-placement properties name lines is contained by that grid AREA rather
 * than by the container's padding box. An `auto` line names the padding edge
 * on that side, so `grid-column: 2 / auto` is bounded by the track on one side
 * and the container on the other.
 *
 * Returns null when all four are `auto`, which is the padding box -- what the
 * out-of-flow path already uses.
 */
function absoluteGridArea(
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

// ---------------------------------------------------------------------------
// Block layout (CSS 2.2 §9.4.1 and §10.3.3, with §8.3.1 margin collapsing)
// ---------------------------------------------------------------------------

/**
 * A set of adjoining margins, held as its largest positive and most negative
 * member. That pair is all a collapse needs: the used value is their sum, and
 * two sets that come to adjoin merge edge-wise -- so a set can cross a box edge
 * as two numbers rather than as the whole list of margins in it.
 */
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

function clearMarginSet(set: MarginSet): void {
	set.positive = 0;
	set.negative = 0;
}

/** The used value of an adjoining set: largest positive plus most negative. */
function collapsedMargin(set: MarginSet): number {
	return set.positive + set.negative;
}

/** The margins that adjoin a child's top edge: its own, plus what escapes it. */
function readCollapseTop(child: LayoutNode, into: MarginSet): void {
	clearMarginSet(into);
	addMargin(into, child.layout.margin.top);
	into.positive = Math.max(into.positive, child.layout.collapseTopPositive);
	into.negative = Math.min(into.negative, child.layout.collapseTopNegative);
}

/** The margins that adjoin a child's bottom edge: its own, plus what escapes it. */
function readCollapseBottom(child: LayoutNode, into: MarginSet): void {
	clearMarginSet(into);
	addMargin(into, child.layout.margin.bottom);
	into.positive = Math.max(into.positive, child.layout.collapseBottomPositive);
	into.negative = Math.min(into.negative, child.layout.collapseBottomNegative);
}

/** A box that wraps its own content rather than filling its container. */
function shrinkWrapsWidth(node: LayoutNode): boolean {
	return (
		node.style.mode === "table" ||
		node.style.widthSizing !== "none"
	);
}

/**
 * Lay a block-level child out against the width its container offers it: an
 * explicit width wins, a box that fills takes the whole content width, and one
 * that wraps its content -- a table, or a box whose auto margins are waiting
 * for space to absorb -- takes no more than it.
 */
function layoutBlockChild(
	child: LayoutNode,
	contentWidth: number,
	fill: boolean,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const marginRow = marginForAxis(child, "row", ownerWidth);
	const marginColumn = marginForAxis(child, "column", ownerWidth);

	const childWidth = {value: NaN, mode: "unconstrained" as MeasureMode};
	const childHeight = {value: NaN, mode: "unconstrained" as MeasureMode};

	if (styleDimIsDefined(child, "row", ownerWidth)) {
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
		styleDimIsDefined(child, "column", ownerHeight)
	) {
		// A definite height transfers through the box's aspect ratio, and the
		// transferred width beats fill: the box is as wide as its ratio says,
		// not as wide as the container (css-sizing-4 §5).
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
		// The min-content probe: an `at-most` offer of zero breaks the content
		// at its narrowest, and the wrapped width is the box's.
		childWidth.value = 0;
		childWidth.mode = "at-most";
	} else if (child.style.widthSizing === "max-content") {
		// An undefined offer measures the content unbroken, so the box takes
		// its max-content width whatever the container offers.
	} else if (isDefined(contentWidth)) {
		// A non-filling child's `at-most` offer is fit-content already:
		// min(max-content, max(min-content, available)).
		childWidth.value = contentWidth;
		childWidth.mode = fill ? "exactly" : "at-most";
	}

	if (styleDimIsDefined(child, "column", ownerHeight)) {
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

/**
 * An anonymous box that broke into no line at all -- collapsible white space
 * between two block boxes -- occupies nothing and separates nothing, so the
 * margins on either side of it go on adjoining (css2 §9.4.2, §8.3.1).
 */
function generatesNoLine(child: LayoutNode): boolean {
	return child.measureFunc !== null && child.layout.height === 0;
}

/** Whether a child fills the container's content width rather than wrapping. */
function blockChildFills(child: LayoutNode): boolean {
	return (
		!shrinkWrapsWidth(child) &&
		child.style.margin.left.unit !== "auto" &&
		child.style.margin.right.unit !== "auto"
	);
}

/**
 * Stack a block container's in-flow children down its content box, collapsing
 * the margins between them.
 *
 * The collapse is one running set of adjoining margins. It starts open at the
 * top edge when nothing separates the container's own margin from its first
 * child's -- then those margins escape the box entirely, and the container
 * above applies them. Anything at the edge (a border, padding, a new formatting
 * context) closes it, and the set is spent as a gap the moment content lands
 * under it. A self-collapsing child never closes the set: its two margins join
 * it and the next box's margin adjoins them all.
 */
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
	const paddingBorderRow = paddingAndBorderForAxis(
		node,
		"row",
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		"column",
		ownerWidth,
	);
	const marginRow = marginForAxis(node, "row", ownerWidth);
	const marginColumn = marginForAxis(node, "column", ownerWidth);
	const leftPaddingBorder = paddingAndBorderForEdge(
		node,
		"left",
		ownerWidth,
	);
	const topPaddingBorder = paddingAndBorderForEdge(node, "top", ownerWidth);

	// -- in-flow children ---------------------------------------------------

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

	// -- content width ------------------------------------------------------
	//
	// Resolved before the children are laid out, min/max included, so that each
	// one is measured exactly once at the width it will keep.

	let borderBoxWidth: number;
	if (widthMode === "exactly") {
		borderBoxWidth = availableWidth - marginRow;
	} else {
		// Shrink-to-fit: as wide as the widest child, within what is offered.
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
				marginForAxis(child, "row", ownerWidth),
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

	// -- stacking -----------------------------------------------------------

	const openTop =
		!node.style.blockFormattingContext &&
		paddingAndBorderForEdge(node, "top", ownerWidth) === 0;
	const openBottom =
		!node.style.blockFormattingContext &&
		paddingAndBorderForEdge(node, "bottom", ownerWidth) === 0 &&
		heightMode !== "exactly" &&
		!styleDimIsDefined(node, "column", ownerHeight);

	const escapingTop = marginSet();
	const escapingBottom = marginSet();
	const adjoining = marginSet();
	const childTop = marginSet();
	const childBottom = marginSet();

	// Content-box tops of the in-flow children, parallel to `inFlow`.
	const tops = new Array<number>(inFlow.length).fill(0);
	let collecting = openTop;
	let cursor = 0;
	let placedContent = false;

	for (let i = 0; i < inFlow.length; i++) {
		const child = inFlow[i];
		layoutBlockChild(
			child,
			contentWidth,
			blockChildFills(child),
			ownerWidth,
			ownerHeight,
			performLayout,
		);

		readCollapseTop(child, childTop);
		if (child.layout.selfCollapsing || generatesNoLine(child)) {
			readCollapseBottom(child, childBottom);
			mergeMarginSet(childTop, childBottom);
			if (collecting) {
				mergeMarginSet(escapingTop, childTop);
				tops[i] = cursor;
			} else {
				mergeMarginSet(adjoining, childTop);
				tops[i] = cursor + collapsedMargin(adjoining);
			}
			continue;
		}

		if (collecting) {
			mergeMarginSet(escapingTop, childTop);
			collecting = false;
			tops[i] = cursor;
		} else {
			mergeMarginSet(adjoining, childTop);
			tops[i] = cursor + collapsedMargin(adjoining);
		}
		clearMarginSet(adjoining);
		cursor = tops[i] + child.layout.height;
		placedContent = true;
		readCollapseBottom(child, adjoining);
	}

	// The set still standing at the end either escapes the bottom edge or
	// becomes the last of the container's own content.
	let contentHeight: number;
	if (openBottom) {
		mergeMarginSet(escapingBottom, adjoining);
		contentHeight = cursor;
	} else {
		contentHeight = cursor + collapsedMargin(adjoining);
	}

	const height =
		heightMode === "exactly"
			? availableHeight - marginColumn
			: Math.max(0, contentHeight) + paddingBorderColumn;

	setMeasuredDimensions(node, borderBoxWidth, height, ownerWidth, ownerHeight);

	// Nothing at either edge and nothing between them: the two escaping sets
	// are one set, and the box is a gap its neighbours' margins pass through.
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

	// -- placement ----------------------------------------------------------

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

	// `position: relative` shifts a box from where the flow put it without
	// moving anything else, so it runs after all flow placement is done.
	const innerWidthFinal = node.layout.width - paddingBorderRow;
	const innerHeightFinal = node.layout.height - paddingBorderColumn;
	for (const child of inFlow) {
		if (child.style.positionType !== "relative") {
			continue;
		}
		child.layout.left += relativeOffset(
			child,
			"row",
			innerWidthFinal,
		);
		child.layout.top += relativeOffset(
			child,
			"column",
			innerHeightFinal,
		);
	}

	for (const child of outOfFlowDescendants(node, false)) {
		layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
	}
	if (node.parent === null) {
		for (const child of outOfFlowDescendants(node, true)) {
			layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
		}
	}
}

/**
 * Size and place one box, and every box under it.
 *
 * The way in for every mode and every probe. It transfers an aspect ratio
 * between the axes, answers from the cache where a previous pass already
 * answered the same offer, and hands the rest to layoutNodeImpl, which is
 * where the box's display picks the mode that lays it out.
 */
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
	// css-sizing-4 §5: an aspect ratio takes a box's one settled axis to the
	// other. An axis offered `exactly` is settled -- by a definite size or by
	// stretch-fit -- and the open axis follows it through the ratio; when both
	// axes are settled the ratio yields. Margins sit outside the box, so they
	// come off the settled offer and go back onto the derived one. Min/max on
	// the derived axis still clamp, in setMeasuredDimensions. The ratio counts
	// cells: one cell is one cell, vertical or horizontal.
	const ratio = node.style.aspectRatio;
	if (isDefined(ratio) && ratio > 0) {
		const marginRow = marginForAxis(node, "row", ownerWidth);
		const marginColumn = marginForAxis(
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

	// A clean node under constraints it has already answered: restore the size
	// and skip the whole subtree. Child geometry is parent-relative and was left
	// exactly as the cached pass computed it, so nothing below needs touching.
	// A full layout satisfies a sizing query; a sizing result cannot satisfy a
	// layout query, since it never placed the children.
	if (!node.dirty) {
		let hit: CachedLayout | null = null;
		if (
			node.cachedLayout &&
			constraintsMatch(
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
			// Margins are outside the size a measurement answers with, so both the
			// offer and the remembered offer come down to their content side
			// before they are compared.
			const marginRow = marginForAxis(node, "row", ownerWidth);
			const marginColumn = marginForAxis(
				node,
				"column",
				ownerWidth,
			);
			for (const cached of node.cachedMeasures) {
				if (
					cached !== null &&
					sameConstraint(cached.ownerWidth, ownerWidth) &&
					sameConstraint(cached.ownerHeight, ownerHeight) &&
					cached.width >= 0 &&
					cached.height >= 0 &&
					sizeStillAnswers(
						cached.widthMode,
						cached.availableWidth - marginRow,
						cached.width,
						widthMode,
						availableWidth - marginRow,
					) &&
					sizeStillAnswers(
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

	// Whatever made this node dirty invalidated every cached answer; reset both
	// slots before recomputing so stale entries cannot answer later queries.
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
			cacheSlot(availableWidth, availableHeight, widthMode, heightMode)
		] = entry;
	}
	node.dirty = false;
}

/** The mode a box's display lays it out in, and the two shapes with no mode. */
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

	// A box that is not a block container escapes no margins: only block layout
	// writes these, so every other mode has to say so for itself.
	node.layout.collapseTopPositive = 0;
	node.layout.collapseTopNegative = 0;
	node.layout.collapseBottomPositive = 0;
	node.layout.collapseBottomNegative = 0;
	node.layout.selfCollapsing = false;

	// Used track sizes belong to a grid container and nothing else: a box that
	// stopped being one must stop reporting them.
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

	// A table cell and a table caption are block containers for their own
	// content, whatever the grid around them does with their boxes.
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

// ---------------------------------------------------------------------------
// Grid rounding
// ---------------------------------------------------------------------------

/**
 * Snap the tree to whole cells.
 *
 * Sizes are derived from *rounded absolute edges* rather than by rounding each
 * width directly: that is what makes adjacent boxes tile without gaps or
 * overlaps when a flexible size lands on a fraction (e.g. three items across 80
 * columns). Rounding widths independently would let 26.67 + 26.67 + 26.67 round
 * to 81 columns of content in an 80 column terminal.
 *
 * Leaves with a measure function ceil their trailing edge: text must never be
 * given less room than it measured, or it would re-wrap.
 */
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

// ---------------------------------------------------------------------------
// Walking the flat tree
// ---------------------------------------------------------------------------

function createTreeWalker(
	root: Node,
	filter: ((node: Node) => number) | null = null,
): TreeWalker {
	// Elements and text, over the flat tree. Everything else -- comments,
	// processing instructions -- generates no box and is skipped, so it cannot
	// hide the content around it.
	return new TreeWalker(
		root as never,
		NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | SHOW_FLAT,
		filter as never,
	);
}

// ---------------------------------------------------------------------------
// Flow classification
// ---------------------------------------------------------------------------

/**
 * The computed `position` values, as the keywords themselves. An absent or
 * unrecognised value is static, which is both the initial value and what every
 * question below already treated an empty string as.
 */
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

/** An element's computed position. */
function getPosition(element: Element): Position {
	const value = getComputedValue(element, "position");
	return POSITIONS.has(value) ? (value as Position) : "static";
}

/**
 * Whether a box takes part in positioned layout -- the predicate the
 * containing-block chain, stacking-context collection and the painter's
 * in-flow walk are built on. Everything but static is positioned, which is
 * what the word means in CSS.
 */
export function isPositioned(element: Element): boolean {
	return getPosition(element) !== "static";
}

/**
 * position:absolute (and fixed, approximated as absolute-to-ICB) takes a box
 * out of normal flow entirely.
 */
function isOutOfFlow(node: Node): boolean {
	if (node.nodeType !== node.ELEMENT_NODE) {
		return false;
	}
	const position = getPosition(node as Element);
	return position === "absolute" || position === "fixed";
}

/**
 * A `display: contents` element generates no box: the box tree splices it away
 * and its children take its place. This is the whole of what the flat tree's
 * consumers need to know about it -- a slot disappears from layout this way
 * (UA default `slot { display: contents }`, as in browsers) while its projected
 * content flows through.
 */
function dissolvesIntoChildren(node: Node): boolean {
	return computedDisplay(node as Element) === "contents";
}

/** The computed `display` values this engine lays out. */
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

/** A display this engine does not implement lays out as a block, per CSS. */
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

/** The table box and every part inside it, which lay themselves out. */
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

/**
 * CSS gives `display` two axes (css-display-3 §2). The OUTER type says how a
 * box sits among its siblings: block-level, on rows of its own, or inline-level,
 * on a line with them. The INNER type says how it lays its own children out: as
 * a flow, as flex items, as a grid, as a table. `inline-grid` is the pair
 * spelled out -- inline outside, grid inside -- and most of the other keywords
 * are a shorthand for some such pair.
 *
 * Which axis a question is on decides which display answers it, because
 * blockification reaches only one of them. A box out of flow, and every child
 * of a flex or grid container, takes a block's OUTER type (§2.7). Its inner
 * type is untouched: an absolutely positioned `inline-grid` sits on rows of its
 * own and is still a grid inside.
 *
 * So this module answers the two with different values, and the door you go
 * through says which:
 *
 *   OUTER -- `isInlineLevel`, which takes the node and reads its USED display,
 *            so blockification is already in the answer.
 *   INNER -- `laysOutItems`, `isGridDisplay`, `isFlexContainer`,
 *            `establishesContentRoot`. They read the COMPUTED display, which is
 *            the whole truth on this axis.
 *
 * Asking the outer question of the computed display is a bug with a shape: it
 * puts a box on a line that had left the line. It is how an out-of-flow box
 * came to hold open the space after it, and how a broken inline came to be
 * sized by a descendant that was no longer in it. `wasBlockified` is the one
 * place that legitimately holds both values at once, because it exists to ask
 * whether they disagree.
 *
 * `none` and `contents` sit on neither axis. They are <display-box> values,
 * which say a box is not generated at all rather than how one behaves, so
 * blockification has nothing to change and they stand as they compute.
 */
function computedDisplay(element: Element): Display {
	const value = getComputedValue(element, "display");
	return DISPLAYS.has(value) ? (value as Display) : "block";
}

/**
 * Whether a display makes an ATOMIC inline: a box that sits on a line whole,
 * measured as one opaque unit, whatever it lays out inside itself. A caller
 * asking whether an element lays its own content out under a root of its own
 * wants `establishesContentRoot`.
 */
function isAtomicInline(display: Display): boolean {
	return display === "inline-block" || display === "inline-grid";
}

/**
 * Whether a display value puts a box on a line rather than on rows of its own.
 * A caller asking about a node wants `isInlineLevel`, which reads the used
 * display and so has blockification already in the answer.
 */
function isInlineDisplay(display: Display): boolean {
	return display === "inline" || isAtomicInline(display);
}

/** Whether an element lays its children out as flex items. INNER axis. */
function isFlexContainer(element: Element): boolean {
	const display = computedDisplay(element);
	return display === "flex" || display === "inline-flex";
}

/**
 * Whether a display puts each child in a box of its own: a flex or grid
 * container gathers no inline run across its children, and blockifies every
 * one of them (css-display-3 §2.7). INNER axis.
 */
function laysOutItems(display: Display): boolean {
	return display === "flex" || isGridDisplay(display);
}

/** Whether a display makes a grid container. INNER axis. */
function isGridDisplay(display: Display): boolean {
	return display === "grid" || display === "inline-grid";
}

/** Whether an element's box is a flex item of its parent's. */
function hasFlexParent(element: Element): boolean {
	const parent = element.parentElement;
	return parent !== null && computedDisplay(parent) === "flex";
}

/** Whether an element's box is an item of a flex or grid container's. */
function hasItemParent(element: Element): boolean {
	const parent = element.parentElement;
	return parent !== null && laysOutItems(computedDisplay(parent));
}

/**
 * The two ways a box comes to be blockified (css-display-3 §2.7): it is out of
 * flow, so there is no line left for it to sit on, or its parent lays its
 * children out as items, which gathers no line for it to sit on either.
 */
function blockifies(element: Element): boolean {
	return isOutOfFlow(element) || hasItemParent(element);
}

/**
 * The display an element's box is generated with: its computed value, with
 * blockification applied to the outer axis. `none` and `contents` generate no
 * box at all and stand as they compute.
 */
function usedDisplay(element: Element): Display {
	const display = computedDisplay(element);
	if (!isInlineDisplay(display)) {
		return display;
	}
	return blockifies(element) ? "block" : display;
}

/**
 * Whether a node's box sits on a line of its container's rather than on rows of
 * its own. OUTER axis: text is always inline-level, and an element is whatever
 * its used display makes it.
 */
function isInlineLevel(node: Node): boolean {
	if (node.nodeType === node.TEXT_NODE) {
		return true;
	}
	if (node.nodeType !== node.ELEMENT_NODE) {
		return false;
	}
	return isInlineDisplay(usedDisplay(node as Element));
}

/**
 * Whether an element lays its own content out under a root of its own, rather
 * than handing it to the lines of the container around it.
 *
 * INNER axis, and a good illustration of why the axes are worth separating.
 * Blockification takes an atomic inline off the line it sat on, so the OUTER
 * answer for a flex item's `inline-block` is no, it is not on a line. The inner
 * answer does not move with it: the box still measures its content as one
 * opaque unit under a formatting context of its own, which is the whole reason
 * an `inline-block` can hold a block-level box at all. Asking the used display
 * here would take that root away from every flex item that had one.
 */
function establishesContentRoot(element: Element): boolean {
	return isAtomicInline(computedDisplay(element));
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
function measuresAsRun(element: Element): boolean {
	if (isOutOfFlow(element)) {
		return false;
	}
	const display = computedDisplay(element);
	if (!isInlineDisplay(display)) {
		return false;
	}
	if (isAtomicInline(display)) {
		return true;
	}
	if (isInlineLevel(element)) {
		return true;
	}
	return !containsBlockLevelBox(element);
}

/** An inline box with block-level content inside it: CSS breaks it apart. */
function splitsAroundBlock(element: Element): boolean {
	if (isOutOfFlow(element)) {
		return false;
	}
	if (computedDisplay(element) !== "inline") {
		return false;
	}
	// A grid item is blockified (css-display-3 §2.7) and is a block
	// container already: there is nothing to break it around, and handing
	// its content to the grid would put the item's own children in cells
	// of their own.
	const parent = element.parentElement;
	if (parent && isGridDisplay(computedDisplay(parent))) {
		return false;
	}
	return containsBlockLevelBox(element);
}

function containsBlockLevelBox(element: Element): boolean {
	const walker = flowWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (child.nodeType !== child.ELEMENT_NODE) {
			continue;
		}
		const childElement = child as Element;
		if (isOutOfFlow(childElement)) {
			continue;
		}
		const display = computedDisplay(childElement);
		// An atomic inline contains its own blocks without splitting anything.
		if (display === "none" || isAtomicInline(display)) {
			continue;
		}
		if (display === "inline") {
			if (containsBlockLevelBox(childElement)) {
				return true;
			}
			continue;
		}
		return true;
	}
	return false;
}

/**
 * Whether a `white-space` value keeps every space and tab as written
 * (css-text-3 §4.1.1). `pre-line` does not: it collapses spaces and tabs and
 * preserves only newlines.
 */
function preservesSpaces(whiteSpace: string): boolean {
	return (
		whiteSpace === "pre" ||
		whiteSpace === "pre-wrap" ||
		whiteSpace === "break-spaces"
	);
}

const COLLAPSIBLE_RUN = /\s+/g;
const PRE_LINE_RUN = /[^\S\n]+/g;

// Whether a rendering would change anything: two collapsible characters in a
// row, or one that is not already the space it collapses to.
const COLLAPSES = /\s\s|[^\S ]/;
const PRE_LINE_COLLAPSES = /[^\S\n][^\S\n]|[^\S\n ]/;

/**
 * The runs a `white-space` value collapses to one space: every run the \s class
 * matches, except that `pre-line` exempts the newline it preserves. Stateful
 * (`g`), so a caller resets `lastIndex` before scanning with it.
 */
function collapsiblePattern(whiteSpace: string): RegExp {
	return whiteSpace === "pre-line" ? PRE_LINE_RUN : COLLAPSIBLE_RUN;
}

/**
 * A text node's data as it renders under a `white-space` value: each run of
 * collapsible whitespace becomes one space, `pre` and `pre-wrap` render their
 * data verbatim, and `pre-line` collapses spaces and tabs but keeps newlines.
 *
 * The single definition of that mapping. The line breaker renders whole text
 * leaves through it and records, for each line fragment, the data range the
 * fragment covers; the painter renders that range back through it to recover
 * the characters to draw. The two agree because rendering a range equals the
 * range of the rendering whenever the range begins and ends on a rendered
 * character, which is how fragment offsets are defined.
 */
function renderWhiteSpace(data: string, whiteSpace: string): string {
	if (preservesSpaces(whiteSpace)) {
		return data;
	}
	// Text whose collapsible whitespace is already single spaces renders as
	// itself, which is most text: the question is worth asking before building
	// a second string that would equal the first.
	const collapses = whiteSpace === "pre-line" ? PRE_LINE_COLLAPSES : COLLAPSES;
	if (!collapses.test(data)) {
		return data;
	}
	return data.replace(collapsiblePattern(whiteSpace), " ");
}

/**
 * `renderWhiteSpace` plus the mapping back to data offsets: offsets[i] is
 * the data offset rendered code unit i came from, and null means the
 * rendering is verbatim and every offset maps to itself. Dense on purpose:
 * a text node's data is short, and one array lookup beats a run-table
 * search everywhere the breaker consults it.
 */
function renderWhiteSpaceOffsets(
	data: string,
	whiteSpace: string,
): {text: string; offsets: Int32Array | null} {
	if (preservesSpaces(whiteSpace)) {
		return {text: data, offsets: null};
	}
	const collapses = whiteSpace === "pre-line" ? PRE_LINE_COLLAPSES : COLLAPSES;
	if (!collapses.test(data)) {
		return {text: data, offsets: null};
	}
	const pattern = collapsiblePattern(whiteSpace);
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
		// Each run renders as one space that maps to the run's first
		// character.
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

/** The data offset a rendered code unit came from. */
function dataOffsetAt(offsets: Int32Array | null, index: number): number {
	return offsets === null ? index : offsets[index];
}

/**
 * The mapping over a rendering that lost its first `by` code units, whose
 * remaining length is `length`. A verbatim rendering needs a real mapping
 * once shifted: its offsets are no longer the identity.
 */
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

/**
 * The characters one line fragment paints: its data range rendered under the
 * node's `white-space`, reordered into the visual order the line was laid out
 * in when the line carries bidirectional text.
 */
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

/**
 * Whether a text node of nothing but white space renders nothing at all.
 *
 * It does where the run it would open has no content to sit beside: between two
 * block-level boxes, at either end of a block container, or as the whole of one
 * (css2 §9.4.2 with css-text-3 §4.1.1). A run that reaches any inline content
 * keeps its space, and so does one whose parent preserves spaces.
 */
function shouldCollapseWhitespaceTextNode(textNode: Text): boolean {
	if (!textNode.textContent || !/^\s*$/.test(textNode.textContent)) {
		return false;
	}

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
	const whiteSpace = getComputedValue(parent, "white-space");
	if (preservesSpaces(whiteSpace)) {
		return false;
	}
	if (whiteSpace === "pre-line" && textNode.textContent.includes("\n")) {
		return false;
	}

	// Inside an inline box the space is on a line with content either side of
	// it, and is a space.
	if (isInlineDisplay(computedDisplay(parent))) {
		return false;
	}

	// What the white space sits next to. A comment generates no box, so it is
	// never that.
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

	// Whether a node puts a box on rows of its own rather than on this line.
	// The USED display, so a box that blockifies counts: an out-of-flow box
	// takes no part in the flow at all, and white space beside one has nothing
	// to sit next to, exactly as if the box were not written.
	const isBlockLevel = (node: Node | null): boolean => {
		if (!node || node.nodeType !== node.ELEMENT_NODE) {
			return false;
		}
		return !isInlineDisplay(usedDisplay(node as Element));
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

/**
 * css-flexbox-1 §4: an anonymous flex item containing only collapsible
 * white space is not rendered. The newlines and indentation of
 * multi-line flex markup must not become items that eat gap and
 * justify-content space -- browsers drop them; so do we. Preserved
 * white space (white-space: pre/pre-wrap on the container) stays an
 * item, and a run that reaches any inline content is a real item.
 */
function isSuppressedFlexWhitespace(text: Text): boolean {
	const parent = text.parentElement;
	if (!parent) {
		return false;
	}
	if (!laysOutItems(computedDisplay(parent))) {
		return false;
	}
	if (preservesSpaces(getComputedValue(parent, "white-space"))) {
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
		// The USED display: an item of a flex or grid container is
		// blockified (css-display-3 §2.7), so it opens a box of its own
		// rather than joining this run -- which leaves the run holding
		// nothing but the white space, and rendering nothing. A display:
		// none child generates no box and does not interrupt the run.
		const siblingDisplay = usedDisplay(node as Element);
		if (siblingDisplay === "none") {
			continue;
		}
		// An inline sibling joins this run and gives it content; anything
		// block-level ends the run with only white space collected.
		if (isInlineDisplay(siblingDisplay)) {
			return false;
		}
		break;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Computed style to layout node
// ---------------------------------------------------------------------------

/**
 * The keywords each property accepts, for narrowing a computed value to the
 * type. A value this engine does not implement is absent here, and falls back
 * rather than reaching the solver as something it cannot read.
 */
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

/**
 * The min and max constraints on a box, from the cascade to the layout node.
 *
 * Left UNSET where the cascade leaves it, never pinned to 0: min-width
 * defaults to `auto`, which on a flex item is its content-based minimum --
 * pinning it to 0 lets the item shrink to nothing while its text stays as wide
 * as its longest word, and paint straight over whatever is next to it.
 */
function applyMinMax(flexNode: LayoutNode, element: Element): void {
	flexNode.setMinWidth(parseUnitValue(getComputedValue(element, "min-width")));
	flexNode.setMinHeight(
		parseUnitValue(getComputedValue(element, "min-height")),
	);
	flexNode.setMaxWidth(parseUnitValue(getComputedValue(element, "max-width")));
	flexNode.setMaxHeight(
		parseUnitValue(getComputedValue(element, "max-height")),
	);
}

/** The four insets, each with the edge it names. */
const INSET_EDGES = ["left", "top", "right", "bottom"] as const;

/**
 * The insets on a positioned box, from the cascade to the layout node.
 *
 * `auto` is a declaration only an absolutely positioned box acts on -- there it
 * says "wherever the box would have been", which the compute core has to be
 * told; a relative or fixed box simply takes no offset on that edge.
 */
function applyInsets(
	flexNode: LayoutNode,
	element: Element,
	edges: readonly Edge[],
	autoWhenUnset: boolean,
): void {
	for (const edge of edges) {
		const value = parseUnitValue(getComputedValue(element, edge));
		if (value !== null) {
			flexNode.setPosition(edge, value);
		} else if (autoWhenUnset) {
			const declared = getComputedValue(element, edge);
			if (declared === "auto" || !declared) {
				flexNode.setPosition(edge, "auto");
			}
		}
	}
}

/**
 * An `<self-position>`/`<content-position>` keyword as a layout constant.
 *
 * The `safe`/`unsafe` overflow qualifiers say what to do when the item does
 * not fit, which on a grid of whole cells is the same either way: the item
 * overflows. `first`/`last baseline` both name the one baseline a cell grid
 * has (see baselineWithinBorderBox).
 */
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

/** The inline-axis content distribution constants, which are their own enum. */
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

/** Strip the qualifier a keyword may be written with, and fold its case. */
function alignmentKeyword(value: string): string {
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

function alignmentConstant(value: string, fallback: Align): Align {
	if (!value || value === "auto") {
		return fallback;
	}
	const constant = ALIGNMENT_CONSTANTS[alignmentKeyword(value)];
	return constant === undefined ? fallback : constant;
}

function justifyContentConstant(value: string): Justify {
	const constant = JUSTIFY_CONTENT_CONSTANTS[alignmentKeyword(value)];
	return constant === undefined ? "normal" : constant;
}

/** The grid container properties, from the cascade to the layout node. */
function applyGridContainer(flexNode: LayoutNode, element: Element): void {
	flexNode.setGridTemplateColumns(
		parseTrackList(getComputedValue(element, "grid-template-columns")),
	);
	flexNode.setGridTemplateRows(
		parseTrackList(getComputedValue(element, "grid-template-rows")),
	);
	flexNode.setGridTemplateAreas(
		parseGridAreas(getComputedValue(element, "grid-template-areas")),
	);
	flexNode.setGridAutoColumns(
		parseTrackSizeList(getComputedValue(element, "grid-auto-columns")),
	);
	flexNode.setGridAutoRows(
		parseTrackSizeList(getComputedValue(element, "grid-auto-rows")),
	);

	const flow = getComputedValue(element, "grid-auto-flow")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	flexNode.setGridAutoFlow(flow.includes("column"), flow.includes("dense"));

	flexNode.setJustifyContent(
		justifyContentConstant(getComputedValue(element, "justify-content")),
	);
	flexNode.setAlignContent(
		alignmentConstant(
			getComputedValue(element, "align-content"),
			"normal",
		),
	);
	flexNode.setAlignItems(
		alignmentConstant(
			getComputedValue(element, "align-items"),
			"normal",
		),
	);
	flexNode.setJustifyItems(
		alignmentConstant(
			getComputedValue(element, "justify-items"),
			"normal",
		),
	);
}

/** The css-sizing-3 §5 keyword a width computed to, as the engine's constant. */
function widthSizingConstant(value: string): Sizing {
	switch (value) {
		case "min-content":
		case "max-content":
		case "fit-content":
			return value;
		default:
			return "none";
	}
}

/**
 * The padding and border a `box-sizing: content-box` box adds to its declared
 * size.
 *
 * The solver sizes border boxes: a declared width is the width of the box it
 * draws. A content-box width names the content alone, so the box the solver
 * must be given is that width plus the edges around it (css-sizing-3 §5.1).
 *
 * The edges are the ones the box model already resolved, so they are the ones
 * the painter draws: a keyword border width is the cell it takes, a side whose
 * style is none or hidden takes nothing, and an edge written as a percentage --
 * which resolves against a containing block this pass has not decided -- takes
 * nothing rather than carrying the edges beside it away with it.
 */
function contentBoxEdges(element: Element, vertical: boolean): number {
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

/**
 * An element's computed style, onto its layout node. Assigned as one change:
 * scores of properties land on the same node, and the solver's ancestors need
 * telling once, not once per property.
 */
function styleFlexNode(
	element: Element,
	flexNode: LayoutNode,
	positionedElements?: Set<Element>,
): void {
	flexNode.styleAll(() => {
		styleFlexNodeProperties(element, flexNode, positionedElements);
	});
}

function styleFlexNodeProperties(
	element: Element,
	flexNode: LayoutNode,
	positionedElements?: Set<Element>,
): void {
	const window = element.ownerDocument?.defaultView;
	if (!window) {
		throw new Error("Element must have an ownerDocument with defaultView");
	}

	const display = computedDisplay(element);
	// A flex item is BLOCKIFIED (css-display-3 §2.7): `display: inline` on a
	// flex container's child computes to block, so its width and height apply
	// like any block's. Forcing them auto here let the measure function answer
	// with the content size instead, and `<span style="width:30ch">` inside a
	// flex row came out as wide as its text.
	const parentIsFlex = hasItemParent(element);
	if (display === "inline" && !parentIsFlex) {
		flexNode.setWidth("auto");
		flexNode.setWidthSizing("none");
		flexNode.setHeight("auto");
		flexNode.setMinWidth(undefined);
		flexNode.setMinHeight(undefined);
		flexNode.setMaxWidth(undefined);
		flexNode.setMaxHeight(undefined);
	} else if (isAtomicInline(display)) {
		flexNode.setWidth("auto");
		flexNode.setWidthSizing("none");
		flexNode.setHeight("auto");

		applyMinMax(flexNode, element);
	} else {
		const widthValue = getComputedValue(element, "width");
		const width = parseUnitValue(widthValue);
		flexNode.setWidth(
			typeof width === "number"
				? width + contentBoxEdges(element, false)
				: (width ?? "auto"),
		);
		flexNode.setWidthSizing(widthSizingConstant(widthValue));

		const height = parseUnitValue(getComputedValue(element, "height"));
		flexNode.setHeight(
			typeof height === "number"
				? height + contentBoxEdges(element, true)
				: (height ?? "auto"),
		);

		applyMinMax(flexNode, element);
	}

	// An aspect ratio sizes a box, which an inline box is not; everything
	// else carries it to the engine.
	if (display === "inline" && !parentIsFlex) {
		flexNode.setAspectRatio(undefined);
	} else {
		flexNode.setAspectRatio(
			parseAspectRatio(getComputedValue(element, "aspect-ratio")),
		);
	}

	// Box model properties: clear for inline elements, apply for block/
	// inline-block -- and for a blockified inline flex item, which keeps its
	// padding, margin and border like any block (css-display-3 §2.7). Without
	// the parentIsFlex exception, `.row{display:flex} .row span{padding:1}`
	// dropped the span's padding entirely.
	if (display === "inline" && !parentIsFlex) {
		flexNode.setMargin("top", 0);
		flexNode.setMargin("right", 0);
		flexNode.setMargin("bottom", 0);
		flexNode.setMargin("left", 0);

		flexNode.setPadding("top", 0);
		flexNode.setPadding("right", 0);
		flexNode.setPadding("bottom", 0);
		flexNode.setPadding("left", 0);

		flexNode.setBorder("top", 0);
		flexNode.setBorder("right", 0);
		flexNode.setBorder("bottom", 0);
		flexNode.setBorder("left", 0);
	} else {
		for (const edge of ["top", "right", "bottom", "left"] as const) {
			const property = `margin-${edge}`;
			const margin = parseSignedUnitValue(getComputedValue(element, property));
			flexNode.setMargin(
				edge,
				margin ??
				(getComputedValue(element, property) === "auto"
					? "auto"
					: undefined),
			);
			flexNode.setPadding(
				edge,
				parseUnitValue(getComputedValue(element, `padding-${edge}`)),
			);
		}

		// Border widths. The USED width is 0 when the side's style is none or
		// hidden (css-backgrounds §3.3) -- same gate as getBoxModel, or the
		// two box models disagree about the same element.
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
			flexNode.setBorder("top", borderTopWidth);
		} else {
			flexNode.setBorder("top", 0);
		}

		const borderRightWidth = usedBorderWidth("right");
		if (typeof borderRightWidth === "number" && borderRightWidth > 0) {
			flexNode.setBorder("right", borderRightWidth);
		} else {
			flexNode.setBorder("right", 0);
		}

		const borderBottomWidth = usedBorderWidth("bottom");
		if (typeof borderBottomWidth === "number" && borderBottomWidth > 0) {
			flexNode.setBorder("bottom", borderBottomWidth);
		} else {
			flexNode.setBorder("bottom", 0);
		}

		const borderLeftWidth = usedBorderWidth("left");
		if (typeof borderLeftWidth === "number" && borderLeftWidth > 0) {
			flexNode.setBorder("left", borderLeftWidth);
		} else {
			flexNode.setBorder("left", 0);
		}
	}

	// An inline-block flex item's measure already returns a border-box size, so
	// the flex node must not add padding+border again on the CROSS axis (it
	// double-counts, e.g. a bordered textarea in a flex row is too tall). Zero the
	// cross-axis edges only -- the main axis is masked by flex sizing.
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
			flexNode.setPadding(edge, 0);
			flexNode.setBorder(edge, 0);
		}
	}

	// Solver item properties. A block container reads none of them -- they are
	// applied whatever the parent is, and simply go unasked outside a flex
	// container, which is what CSS says of them.
	const flexGrow = getComputedValue(element, "flex-grow");
	const growValue = parseFloat(flexGrow);
	if (!isNaN(growValue) && growValue >= 0) {
		flexNode.setFlexGrow(growValue);
	} else {
		flexNode.setFlexGrow(undefined);
	}

	const orderValue = parseInt(getComputedValue(element, "order"), 10);
	flexNode.setOrder(Number.isNaN(orderValue) ? undefined : orderValue);

	const flexShrink = getComputedValue(element, "flex-shrink");
	const shrinkValue = parseFloat(flexShrink);
	if (!isNaN(shrinkValue) && shrinkValue >= 0) {
		flexNode.setFlexShrink(shrinkValue);
	} else {
		flexNode.setFlexShrink(undefined);
	}

	const flexBasis = parseUnitValue(
		getComputedValue(element, "flex-basis"),
	);
	flexNode.setFlexBasis(
		flexBasis ??
		(getComputedValue(element, "flex-basis") === "auto"
			? "auto"
			: undefined),
	);

	const alignSelf = getComputedValue(element, "align-self");
	flexNode.setAlignSelf(alignmentConstant(alignSelf, "auto"));
	flexNode.setJustifySelf(
		alignmentConstant(
			getComputedValue(element, "justify-self"),
			"auto",
		),
	);

	// Grid item placement. Read whatever the parent is, like the flex item
	// properties above: outside a grid container nothing asks for them, which
	// is exactly what CSS says of them.
	flexNode.setGridRowStart(
		parseGridPlacement(getComputedValue(element, "grid-row-start")),
	);
	flexNode.setGridRowEnd(
		parseGridPlacement(getComputedValue(element, "grid-row-end")),
	);
	flexNode.setGridColumnStart(
		parseGridPlacement(getComputedValue(element, "grid-column-start")),
	);
	flexNode.setGridColumnEnd(
		parseGridPlacement(getComputedValue(element, "grid-column-end")),
	);

	// gap. The `gap` shorthand is expanded in the cascade, so reading the
	// longhands here is enough and gets the precedence right.
	const rowGap = parseUnitValue(getComputedValue(element, "row-gap"));
	if (typeof rowGap === "number") {
		flexNode.setGap("row", rowGap);
	}

	const columnGap = parseUnitValue(
		getComputedValue(element, "column-gap"),
	);
	if (typeof columnGap === "number") {
		flexNode.setGap("column", columnGap);
	}

	if (display === "none") {
		flexNode.setMode("none");
	} else if (display === "grid" || display === "inline-grid") {
		flexNode.setMode("grid");
		applyGridContainer(flexNode, element);
	} else if (display === "flex") {
		flexNode.setMode("flex");
	} else if (display === "table") {
		// A layout mode of its own: columns are shared across rows, which a box
		// per <tr> stacked on its own structurally cannot express.
		flexNode.setMode("table");
		flexNode.setBorderCollapse(
			getComputedValue(element, "border-collapse") === "collapse",
		);
	} else if (display === "table-header-group") {
		flexNode.setMode("table-header-group");
	} else if (display === "table-footer-group") {
		flexNode.setMode("table-footer-group");
	} else if (display === "table-row-group") {
		flexNode.setMode("table-row-group");
	} else if (display === "table-caption") {
		flexNode.setMode("table-caption");
	} else if (
		display === "table-column" || display === "table-column-group"
	) {
		// Columns carry style, not a box of their own.
		flexNode.setMode("none");
	} else if (display === "table-row") {
		flexNode.setMode("table-row");
	} else if (display === "table-cell") {
		flexNode.setMode("table-cell");
		// The spans are the reflected properties, which carry the ranges HTML
		// gives the attributes: colSpan 1 to 1000, rowSpan 0 to 65534. A zero
		// rowspan means "to the end of the row group", which this table
		// algorithm cannot reach, so such a cell covers the one row it is in --
		// a gap stated here rather than hidden in a parse. An element that is a
		// cell only by `display: table-cell` reflects neither, and spans one of
		// each, as it does in a browser.
		const cell = element as {colSpan?: number; rowSpan?: number};
		flexNode.setColSpan(cell.colSpan ?? 1);
		flexNode.setRowSpan(Math.max(1, cell.rowSpan ?? 1));

		// A cell with no horizontal padding of its own takes one cell either
		// side, so neighbouring columns' text does not run together.
		const paddingLeft = getComputedValue(element, "padding-left");
		const paddingRight = getComputedValue(element, "padding-right");
		if (!paddingLeft || paddingLeft === "0px") {
			flexNode.setPadding("left", 1);
		}
		if (!paddingRight || paddingRight === "0px") {
			flexNode.setPadding("right", 1);
		}
	}

	// The container properties, which only a flex container reads: a table row
	// lays its cells out on a grid with a direction of its own.
	if (display === "flex") {
		flexNode.setFlexDirection(
			asFlexDirection(getComputedValue(element, "flex-direction")),
		);
		flexNode.setFlexWrap(
			asWrap(getComputedValue(element, "flex-wrap")),
		);
		flexNode.setJustifyContent(
			justifyContentConstant(
				getComputedValue(element, "justify-content"),
			),
		);
		flexNode.setAlignItems(
			alignmentConstant(
				getComputedValue(element, "align-items"),
				"stretch",
			),
		);
		flexNode.setAlignContent(
			alignmentConstant(
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
		// Block layout. Displays decided above (table parts, `none`) must not be
		// overwritten here. Resetting a table-caption to block leaves the table
		// unable to find its own caption; resetting a runtime-hidden element
		// ("none", set a hundred lines up) back keeps its rows painting
		// and pushes everything below it down.
		flexNode.setMode("block");
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
		getComputedValue(element, "overflow") !== "visible" ||
		isOutOfFlow(element) ||
		parentIsFlex,
	);

	const position = getPosition(element);
	// The stacking-context painter hoists positioned boxes to their context
	// root; this registry is how it finds them without an O(document) sweep
	// per frame. Membership follows the style application that created or
	// restyled the box.
	if (positionedElements) {
		if (position !== "static") {
			positionedElements.add(element);
		} else {
			positionedElements.delete(element);
		}
	}
	if (position === "absolute") {
		flexNode.setPositionType("absolute");
		applyInsets(flexNode, element, INSET_EDGES, true);
	} else if (position === "relative") {
		flexNode.setPositionType("relative");
		// A relative box is offset from where it would have sat, and the offset
		// this engine applies is the start-edge one: `right`/`bottom` alone do
		// not move it.
		applyInsets(flexNode, element, INSET_EDGES.slice(0, 2), false);
	} else if (position === "fixed") {
		// The viewport is the containing block, whatever it sits inside, and
		// the camera is what keeps it still.
		flexNode.setPositionType("fixed");
		applyInsets(flexNode, element, INSET_EDGES, false);
	} else {
		flexNode.setPositionType("static");
	}
}

const kPositionedElements = Symbol("positionedElements");

/**
 * Apply an element's style to the layout node that carries its box, and
 * keep the one thing that style alone cannot answer wired up: an
 * out-of-flow box is placed by its containing block, which asks the flow
 * the box left where it would have been. Nothing in flow is ever asked, so
 * nothing in flow carries the question.
 */
function styleNode(
	layout: LayoutEngine,
	element: Element,
	flexNode: LayoutNode,
): void {
	const wasHidden = flexNode.style.mode === "none";
	styleFlexNode(element, flexNode, layout[kPositionedElements]);
	// Turning display:none is what makes the whole subtree box-less, and
	// this is the one place every path that restyles a box passes through.
	if (!wasHidden && flexNode.style.mode === "none") {
		retireHiddenContent(layout, element);
	}
	if (isOutOfFlow(element)) {
		flexNode.setStaticPositionFunc((containingBlock) =>
			staticPosition(layout, element, containingBlock),
		);
	} else if (flexNode.staticPositionFunc) {
		flexNode.setStaticPositionFunc(null);
	}
}

// ---------------------------------------------------------------------------
// The box tree
// ---------------------------------------------------------------------------

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
 * Every box is one of two kinds, and never both. A box that is LAID OUT has a
 * layout node the solver sized and placed -- a block, an anonymous run, an
 * atomic inline that holds block content and so is a block container in its
 * own right. A box that is a RUN MEMBER has none: an inline or a text node
 * sitting on a line, whose geometry lives in the break result of the run
 * around it, because that run was measured as one unit. `laidOutBy` is the
 * question, and answering null is what says a box is the second kind.
 *
 * That is why a layout node is not simply this box wearing another name.
 * There are boxes with no node -- the run members -- and the split is a real
 * one in CSS: a box that generates a layout unit, against content that
 * participates in one.
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
	parent: Box | null;

	/**
	 * The container-level nodes whose content an anonymous box lays out, in
	 * order. The box OWNS them: they are what the derivation put in it, not
	 * something re-derived by walking the tree from a starting node. A walk has
	 * to decide where the run ends -- a question the derivation has already
	 * answered -- and it asks a node that may since have left the tree, which
	 * is a measurement of nothing at all.
	 */
	members: Node[];

	/**
	 * The boxes this one holds, in order, and the box each flow child's content
	 * falls under. Null until a derivation has run: a box whose children were
	 * never derived is not a box with none.
	 */
	children: Box[] | null;
	heads: Map<Node, Box> | null;

	/**
	 * Whether an inline box was broken around a block-level box, so that it lays
	 * out none of its own content: the fragments on either side and the block
	 * between them are boxes of its container (css2 §9.2.1.1). Written by the
	 * container's enumeration, which is where the break is decided.
	 */
	broken: boolean;

	/**
	 * Whether the box holds fragments a broken inline handed over, which is what
	 * makes its children stop corresponding to the child nodes it was written
	 * with -- those boxes' nodes live a level down, and the inline's own later
	 * children own no box here at all.
	 */
	holdsFragments: boolean;

	/**
	 * The layout node an anonymous box owns. A principal box's is its DOM
	 * node's, held in `nodeMap`: the layout tree is keyed by node, and only a
	 * box with no node of its own has one to keep here. Ask
	 * {@link laidOutBy} rather than either store.
	 */
	layoutNode: LayoutNode | null;
	styledFrom: Element | null;

	/**
	 * The layout root an atomic inline's own children are laid out under. The
	 * box measures its content as one opaque unit for the run it sits on, so
	 * nothing above it can lay those children out; its measurement does, and
	 * reads their geometry back relative to the box's content edge. Owned here,
	 * with the box's lifetime: the children under it are this box's children,
	 * and there is nowhere else to ask.
	 */
	contentRoot: LayoutNode | null;

	/**
	 * The lines this box's last PLACING measurement broke its content into.
	 * They are the product of the size the box currently has -- a sizing probe
	 * at some other width never becomes what the painter sees, so only the
	 * measurement that placed the box writes here.
	 */
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

	/** The node that opens the box: what its own styles, if any, come from. */
	get head(): Node {
		return this.node ?? this.members[0];
	}

	/** The block container whose box holds this one. */
	get container(): Element {
		return this.parent!.node as Element;
	}
}

const kDerivedContainers = Symbol("derivedContainers");

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
 * flow child (and, through the walk in getBoxEntry, everything nested inside
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
 * when they might have: a container drops out of {@link kDerivedContainers}
 * as a mutation names it, and an unbounded change -- a stylesheet reparse, a
 * pseudo-element appearing, a shadow root attaching -- drops the set itself,
 * so each container rebuilds on its next read. The boxes themselves outlive
 * it: a rebuild reconciles against the children it replaces.
 */
function containerBox(
	layout: LayoutEngine,
	container: Element,
): Box {
	const box = principalBox(layout, container);
	if (box.children && layout[kDerivedContainers].has(container)) {
		return box;
	}

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
	let run: Box | null = null;
	// The enumeration below decides it again; a container that no longer
	// reaches through a broken inline stops holding its fragments.
	box.holdsFragments = false;
	for (const child of flowChildren(layout, container)) {
		if (child.nodeType === child.ELEMENT_NODE) {
			const element = child as Element;
			if (computedDisplay(element) === "none" || isOutOfFlow(element)) {
				// A hidden box holds a slot among its container's children; an
				// out-of-flow one hangs from its containing block instead. Both
				// are named here so the one path that builds a box reaches
				// them, and neither joins the run around it.
				const own = principalBox(layout, child, box);
				heads.set(child, run ?? own);
				children.push(own);
				continue;
			}
			// Blockification is already in this answer, so a flex or grid
			// item arrives here with its computed `inline` spent: its box is
			// its own, never an anonymous one gathered around it, and the run
			// it would have joined ends at it like any other block-level box.
			if (!isInlineLevel(element)) {
				const own = principalBox(layout, child, box);
				heads.set(child, own);
				children.push(own);
				run = null;
				continue;
			}
		} else if (child.nodeType !== child.TEXT_NODE) {
			continue;
		} else if (isSuppressedFlexWhitespace(child as Text)) {
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
			reused.layoutNode?.markDirty();
		}
	}

	// Runs the container no longer has: their content merged into a
	// neighbour's box or left the tree entirely.
	for (let i = runCount; i < previous.length; i++) {
		retireAnonymousBox(layout, previous[i]);
	}

	// A dissolved element is FLATTENED by the walk above: the boxes it
	// yields are its children's, and nothing there ever names the element
	// itself. So a box it held under an earlier display would outlive the
	// change -- a `display: contents` flip whose invalidation scope was an
	// ancestor left the old box standing, holding rows nothing removed.
	retireSteppedOver(layout, container);

	box.children = children;
	box.heads = heads;
	layout[kDerivedContainers].add(container);
	return box;
}

const kBoxes = Symbol("boxes");

/** A DOM node's principal box, created on first mention. */
function principalBox(
	layout: LayoutEngine,
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

/**
 * The layout node a container's own boxes hang from: an atomic inline's
 * content root, and otherwise the node its box is laid out by.
 */
function containerFlexNode(
	layout: LayoutEngine,
	container: Element,
): LayoutNode | undefined {
	return (
		layout[kBoxes].get(container)?.contentRoot ??
		layout[kNodeMap].get(container)
	);
}

const kMeasureNodes = Symbol("measureNodes");

/**
 * Free a node's layout node and forget it. The children are severed
 * first: they belong to other DOM nodes, which keep pointing at them, and
 * an element measured by a box that reuses a freed node lays out nothing
 * at all.
 */
function retireFlexNode(
	layout: LayoutEngine,
	node: Node,
): void {
	const flexNode = layout[kNodeMap].get(node);
	if (!flexNode) {
		return;
	}
	flexNode.parent?.removeChild(flexNode);
	while (flexNode.children.length > 0) {
		flexNode.removeChild(flexNode.children[0]);
	}
	layout[kMeasureNodes].delete(flexNode);
	flexNode.freeRecursive();
	untrackNode(layout, node);
}

/**
 * Whether a layout node is the KIND of box its element now generates. A
 * node with a measure function lays its content out as one run, and one
 * without lays out boxes of its own -- a blockified inline holding a block
 * would end at the first block inside it. A node built display:none is
 * built with no content in it at all. Neither is a re-measurement away.
 */
function boxKindMatches(
	layout: LayoutEngine,
	element: Element,
	flexNode: LayoutNode,
): boolean {
	if (measuresAsRun(element) !== layout[kMeasureNodes].has(flexNode)) {
		return false;
	}
	return (
		(computedDisplay(element) === "none") ===
		(flexNode.style.mode === "none")
	);
}

const kAnonymousBoxes = Symbol("anonymousBoxes");

/** Free an anonymous box's layout node and forget the box. */
function retireAnonymousBox(
	layout: LayoutEngine,
	box: Box,
): void {
	const flexNode = box.layoutNode;
	box.layoutNode = null;
	box.fragments = null;
	if (!flexNode) {
		return;
	}
	flexNode.parent?.removeChild(flexNode);
	layout[kMeasureNodes].delete(flexNode);
	layout[kAnonymousBoxes].delete(flexNode);
	flexNode.owner = null;
	flexNode.freeRecursive();
}

/** The anonymous box a node's content is laid out in, if it is in one. */
function getBox(
	layout: LayoutEngine,
	node: Node,
): Box | null {
	const entry = getBoxEntry(layout, node);
	return entry?.kind === "anonymous" ? entry : null;
}

/** The box a node's content falls under, among its container's children. */
function getBoxEntry(
	layout: LayoutEngine,
	node: Node,
): Box | null {
	if (!flatIsConnected(node)) {
		return null;
	}

	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;
		// The USED display, so that an out-of-flow element answers no here
		// whatever it computes: it left the flow entirely and heads no run
		// and joins none. Letting run invalidation "ensure" it a bare layout
		// node makes later rebuilds skip its full build, so its pseudo-only
		// content vanishes on a runtime class flip.
		if (!isInlineLevel(element)) {
			return null;
		}
	} else if (node.nodeType !== node.TEXT_NODE) {
		return null;
	}

	const container = getRunContainer(layout, node);
	if (!container) {
		return principalBox(layout, node);
	}
	const heads = containerBox(layout, container).heads!;
	// Up from the node to whichever of its ancestors the container counts
	// among its own flow children: that is the box the content falls under.
	for (let current: Node = node; current !== container;) {
		const entry = heads.get(current);
		if (entry) {
			return entry;
		}
		const parent = boxParentElement(current);
		if (!parent) {
			return principalBox(layout, current);
		}
		current = parent;
	}
	return principalBox(layout, node);
}

function laidOutBy(
	layout: LayoutEngine,
	box: Box,
): LayoutNode | null {
	if (box.kind === "anonymous") {
		return box.layoutNode;
	}
	return box.node === null ? null : (layout[kNodeMap].get(box.node) ?? null);
}

function runFlexNode(
	layout: LayoutEngine,
	node: Node,
): LayoutNode | undefined {
	const box = getBox(layout, node);
	if (box) {
		return box.head === node ? (box.layoutNode ?? undefined) : undefined;
	}
	return layout[kNodeMap].get(node);
}

/** The lines the run a node heads was broken into, if it has been measured. */
function runBreakResult(
	layout: LayoutEngine,
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
const kEngineWindow = Symbol("window");

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
function syncContainerRuns(
	layout: LayoutEngine,
	container: Element,
): void {
	layout[kDirtyRunContainers].delete(container);
	if (
		computedDisplay(container) === "none" ||
		hiddenByAncestor(container)
	) {
		// Content that arrives under the boundary generates no box, and
		// whatever boxes it brought from where it was visible are retired
		// here: this is the only pass that ever visits a hidden container.
		retireHiddenContent(layout, container);
		return;
	}
	// An inline broken around a block-level box lays out none of its own
	// content: the fragments and the block between them are boxes of the
	// CONTAINER (CSS2 §9.2.1.1), reconciled there. Taking them here steals
	// them from the container that places them.
	if (splitsAroundBlock(container)) {
		return;
	}

	const containerFlex = containerFlexNode(layout, container);
	if (!containerFlex || containerFlex.measureFunc) {
		// One box holds all of it -- the container's own, when it measures
		// its content as one opaque unit, or the run it is a member of --
		// except an out-of-flow box, which left that box for its containing
		// block. No container's box list names such a box and no child walk
		// descends into a run to find it, so the derivation that reaches it
		// is this one.
		if (containerFlex || getBox(layout, container)) {
			retireRunContent(layout, container);
		}
		return;
	}

	const children = containerBox(layout, container).children!;
	let index = 0;
	for (const entry of children) {
		if (entry.kind === "anonymous") {
			let flexNode = entry.layoutNode;
			const styledFrom =
				entry.head.nodeType === entry.head.ELEMENT_NODE
					? (entry.head as Element)
					: null;
			// The head decides the box's own flex styles (an anonymous box has
			// none), so a run that changes hands starts from a fresh node
			// rather than wearing the last head's margins and flex factors.
			if (flexNode && entry.styledFrom !== styledFrom) {
				retireAnonymousBox(layout, entry);
				flexNode = null;
			}
			if (!flexNode) {
				flexNode = new LayoutNode();
				entry.layoutNode = flexNode;
				entry.styledFrom = styledFrom;
				if (styledFrom) {
					styleFlexNode(styledFrom, flexNode, layout[kPositionedElements]);
				}
				flexNode.setMeasureFunc((width, widthMode, placing) =>
					measureInlineRun(layout, entry, width, widthMode, placing),
				);
				layout[kMeasureNodes].add(flexNode);
				layout[kAnonymousBoxes].set(flexNode, entry);
				flexNode.owner = entry.head;
			} else if (flexNode.owner !== entry.head) {
				// Paint reaches a box through the node that opens it.
				flexNode.owner = entry.head;
			}
			if (containerFlex.getChildIndex(flexNode) !== index) {
				flexNode.parent?.removeChild(flexNode);
				containerFlex.insertChild(flexNode, index);
			}
			index++;
			syncRunMembers(layout, entry);
			continue;
		}
		// Every box the container lays out, built by the one path that
		// builds a box: what it is made of -- whether it generates a box at
		// all, which kind, the styles on it, what it holds in turn -- is
		// derived there, from the styles that stand, however the box came to
		// be named here. A box a fresh build would have made differently is
		// remade; the rest is re-derived onto the node already standing.
		const node = entry.node!;
		addNode(layout, node, containerFlex);
		// An out-of-flow box is not one of the container's: it hangs from its
		// CONTAINING BLOCK, which the build above hoisted it to, and takes no
		// place among the boxes counted here.
		if (isOutOfFlow(node)) {
			continue;
		}
		const flexNode = layout[kNodeMap].get(node);
		if (flexNode && flexNode.parent === containerFlex) {
			// The box list is the order. A box placed among its DOM
			// siblings knows nothing of the anonymous boxes between them --
			// text between two blocks opens one, and the block after it was
			// landing in its place -- so the position is settled here,
			// where the whole list is in hand.
			if (containerFlex.getChildIndex(flexNode) !== index) {
				containerFlex.removeChild(flexNode);
				containerFlex.insertChild(flexNode, index);
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
	for (let i = containerFlex.children.length - 1; i >= index; i--) {
		const child = containerFlex.children[i];
		const node = child.owner as Node | undefined;
		if (node && isOutOfFlow(node)) {
			continue;
		}
		containerFlex.removeChild(child);
	}
}

/**
 * Derive what an anonymous box's members hold: one run measures them all as
 * a single unit, so no box under them is one the layout tree lays out, and
 * the only path that ever finds an out-of-flow box written among them is
 * this one -- no container's box list names it, and no child walk descends
 * into a run.
 */
function syncRunMembers(
	layout: LayoutEngine,
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
			retireFlexNode(layout, element);
		}
		retireRunContent(layout, element);
	}
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
 * The block container whose anonymous boxes a node's content falls under.
 * Inline boxes are transparent -- their content belongs to the run around
 * them -- and so is an inline-block whose content is all inline, since the
 * run measures such a box as one unit and its interior coordinates live in
 * that run's break result. An inline-block that holds block-level content is
 * a block container in its own right, and so is an out-of-flow box.
 */
function getRunContainer(
	layout: LayoutEngine,
	node: Node,
): Element | null {
	const parent = boxParentElement(node);
	if (!parent) {
		return null;
	}
	const startsOwnRun =
		node.nodeType === node.ELEMENT_NODE &&
		computedDisplay(node as Element) !== "inline";
	return runContainerFrom(layout, parent, startsOwnRun);
}

/**
 * The block container the boxes directly inside an element fall under:
 * that element when it establishes one, and otherwise the container its
 * own box joins. This is the answer {@link getRunContainer} gives for a
 * node whose box parent is known without the node itself -- which is how a
 * node that has LEFT the tree is answered for, since a removed node has no
 * parent left to climb from.
 */
function runContainerFrom(
	layout: LayoutEngine,
	box: Element,
	startsOwnRun: boolean,
): Element | null {
	for (
		let current: Element | null = box;
		current;
		current = boxParentElement(current)
	) {
		if (isOutOfFlow(current)) {
			return current;
		}
		const display = computedDisplay(current);
		// An inline box is transparent: its content belongs to the run
		// around it.
		if (display === "inline") {
			continue;
		}
		if (isAtomicInline(display)) {
			// A box laying out children of its own establishes a block
			// container; and an atomic inline nested in one starts a run
			// there rather than joining the run its host sits in.
			if (layout[kBoxes].get(current)?.contentRoot || startsOwnRun) {
				return current;
			}
			continue;
		}
		return current;
	}
	return null;
}

/** Whether climbing from a layout node reaches another one. */
function climbsTo(
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
	layout: LayoutEngine,
	node: Node,
	parentFlexNode: LayoutNode | null = null,
): void {
	// A display:none ancestor removes the whole subtree from layout --
	// fresh builds never descend past the none boundary, and rebuild
	// sweeps must not smuggle descendants back in under the hidden
	// container (the flex engine does not ignore them).
	if (hiddenByAncestor(node)) {
		// Whatever boxes the node brought with it from where it was visible
		// go with it: nothing under the boundary generates one.
		retireFlexNode(layout, node);
		if (node.nodeType === node.ELEMENT_NODE) {
			retireHiddenContent(layout, node as Element);
		}
		return;
	}

	// display:contents generates NO box: fresh builds flatten it via the
	// walker, and a REBUILD must not resurrect a stale box from an
	// earlier display value -- its children re-add as the box parent's
	// own. Retire whatever node it had.
	if (node.nodeType === node.ELEMENT_NODE && dissolvesIntoChildren(node)) {
		retireFlexNode(layout, node);
		// The children it dissolves into are the CONTAINER's boxes, and the
		// container learns of them only by enumerating again: an element
		// that generates no box announces nothing else on its way in.
		const container = getRunContainer(layout, node);
		if (container) {
			layout[kDerivedContainers].delete(container);
			layout[kDirtyRunContainers].add(container);
		}
		return;
	}
	// An out-of-flow box stays where it sits and lets its containing block
	// reach down for it -- unless the two are in different layout trees. An
	// atomic inline lays its content out under a root of its own, in that
	// root's coordinate space, and a containing block outside has no way to
	// reach in. Crossing between trees is the one case that still needs the
	// box moved, and the test is simply whether the block can be climbed to.
	if (isOutOfFlow(node)) {
		const containingBlock =
			getPosition(node as Element) === "fixed"
				? layout[kViewportRoot]
				: containingBlockFlexNode(layout, node as Element);
		if (containingBlock && !climbsTo(parentFlexNode, containingBlock)) {
			parentFlexNode = containingBlock;
		}
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
		const stale = layout[kNodeMap].get(node);
		if (stale && stale.parent === parentFlexNode) {
			parentFlexNode.removeChild(stale);
			layout[kMeasureNodes].delete(stale);
			stale.freeRecursive();
			untrackNode(layout, node);
		}
		return;
	}

	if (layout[kNodeMap].has(node)) {
		const existingFlexNode = layout[kNodeMap].get(node)!;
		// Content that an anonymous box lays out owns no layout node: one
		// left from when this node was block-level, or headed a run under a
		// shape the container no longer has, is retired here so the box is
		// the only thing measuring it.
		if (isInlineLevel(node) && getBox(layout, node)) {
			retireFlexNode(layout, node);
			if (node.nodeType === node.ELEMENT_NODE) {
				addElementNode(layout, node as Element, parentFlexNode);
			} else {
				addTextNode(layout, node as Text, parentFlexNode);
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
			if (!boxKindMatches(layout, element, existingFlexNode)) {
				retireFlexNode(layout, node);
				addElementNode(layout, element, parentFlexNode);
				return;
			}
			// Whatever moved the node may also have restyled it (the flip
			// that hoists a box to its containing block usually did).
			styleNode(layout, element, existingFlexNode);
			// A box kept is a box re-derived: what an element that measures
			// its content as one run holds -- a content root, or nothing at
			// all -- is decided from the styles that stand, exactly as it
			// would be for a node built here from scratch.
			if (measuresAsRun(element)) {
				syncContentRoot(layout, element);
				retireRunContent(layout, element);
			}
		}
		if (existingFlexNode && parentFlexNode) {
			const currentParent = existingFlexNode.parent;
			if (currentParent !== parentFlexNode) {
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
				const container = getRunContainer(layout, node);
				if (container) {
					layout[kDirtyRunContainers].add(container);
				}
			}
		}
		return;
	}

	if (node.nodeType === node.ELEMENT_NODE) {
		addElementNode(layout, node as Element, parentFlexNode);
	} else if (node.nodeType === node.TEXT_NODE) {
		addTextNode(layout, node as Text, parentFlexNode);
	}
}

function addElementNode(
	layout: LayoutEngine,
	element: Element,
	parentFlexNode: LayoutNode | null = null,
): void {
	const display = computedDisplay(element);
	const asRun = measuresAsRun(element);

	// Inline-level content lays out in its container's anonymous boxes,
	// which the container reconciles as a whole -- unless the box is out of
	// flow, which blockifies it per CSS: it never joins a run.
	if (asRun) {
		const box = getBox(layout, element);
		if (box) {
			invalidateBox(layout, box);
			layout[kDirtyRunContainers].add(box.container);
			syncContentRoot(layout, element);
			retireRunContent(layout, element);
			return;
		}
		// No anonymous box holds it: its own box is what lays it out (a
		// flex container's blockified children) -- proceed to create it.
	}

	// Appended: a box's position among its container's children is the
	// container's box list to say, and the reconciliation that reads it
	// settles the order.
	const flexIndex = parentFlexNode?.children.length ?? 0;

	let flexNode = layout[kNodeMap].get(element);
	if (!flexNode) {
		flexNode = new LayoutNode();
		trackNode(layout, element, flexNode);
	}

	styleNode(layout, element, flexNode);

	if (display === "none") {
		flexNode.setMode("none");
		if (flexNode && parentFlexNode) {
			placeChild(parentFlexNode, flexNode, flexIndex);
		}
		return;
	} else if (asRun) {
		const box = principalBox(layout, element);
		flexNode.setMeasureFunc((width, widthMode, placing) =>
			measureInlineRun(layout, box, width, widthMode, placing),
		);
		layout[kMeasureNodes].add(flexNode);

		if (flexNode && parentFlexNode) {
			placeChild(parentFlexNode, flexNode, flexIndex);
		}

		syncContentRoot(layout, element);
		retireRunContent(layout, element);
		return;
	}

	// A box laid out in the tree above lays out no children of its own: an
	// element that stops being an inline-block lays its block content out
	// here, and a content root left behind would go on claiming the same
	// children.
	retireContentRoot(principalBox(layout, element));

	// Only DIRECT children: an inline child broken apart by a block-level
	// box holds boxes this container lays out, and those reach the tree
	// through its own box reconciliation.
	const walker = flowWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (
			child.nodeType === child.ELEMENT_NODE ||
			child.nodeType === child.TEXT_NODE
		) {
			addNode(layout, child, flexNode);
		}
	}

	// The inline children just walked past lay out in boxes of this
	// container's, which only the container can place. Here rather than in
	// calculateLayout's drain, because a container built from inside a
	// measure (an inline-block's block content) is laid out the moment the
	// measure returns, with no drain in between.
	if (layout[kDirtyRunContainers].has(element)) {
		syncContainerRuns(layout, element);
	}

	if (flexNode && parentFlexNode) {
		placeChild(parentFlexNode, flexNode, flexIndex);
		// The index above is counted among the element's DOM siblings,
		// which know nothing of the anonymous boxes between them. The
		// container's box list is what settles the order, so ask for it.
		const container = getRunContainer(layout, element);
		if (container) {
			layout[kDirtyRunContainers].add(container);
		}
	}
}

function addTextNode(
	layout: LayoutEngine,
	text: Text,
	parentFlexNode: LayoutNode | null = null,
): void {
	if (!parentFlexNode) {
		return;
	}

	if (isSuppressedFlexWhitespace(text)) {
		return;
	}

	// Text lays out in its container's anonymous box, which the container
	// reconciles as a whole.
	const box = getBox(layout, text);
	if (box) {
		invalidateBox(layout, box);
		layout[kDirtyRunContainers].add(box.container);
		return;
	}

	let flexNode = layout[kNodeMap].get(text);
	if (!flexNode) {
		flexNode = new LayoutNode();
		trackNode(layout, text, flexNode);
	}

	const own = principalBox(layout, text);
	flexNode.setMeasureFunc((width, widthMode, placing) =>
		measureInlineRun(layout, own, width, widthMode, placing),
	);
	layout[kMeasureNodes].add(flexNode);

	parentFlexNode.insertChild(flexNode, parentFlexNode.children.length);
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
function flowChildren(
	layout: LayoutEngine,
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
		// Written on the way past rather than recomputed by the readers:
		// paint culling asks per element per frame, and re-walking an
		// inline's subtree there would cost every off-screen row of a long
		// list. An inline that stops splitting is told so here, by the
		// enumeration that stops reaching through it.
		const splits = splitsAroundBlock(child as Element);
		principalBox(layout, child).broken = splits;
		if (splits) {
			principalBox(layout, root).holdsFragments = true;
			flowChildren(layout, child as Element, into, root);
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
function syncContentRoot(
	layout: LayoutEngine,
	element: Element,
): void {
	const box = principalBox(layout, element);
	const display = computedDisplay(element);
	// An inline-grid ALWAYS lays its own content out: every one of its
	// children is a grid item, and a grid is not something a line can
	// contain piecemeal. An inline-block only needs a root of its own once
	// it holds a block-level box.
	//
	// Never a plain inline: an inline containing a block is BROKEN around
	// it, and taking its content here would steal back the boxes that
	// belong to its container.
	const grid = display === "inline-grid";
	if (
		!establishesContentRoot(element) ||
		(!grid && !containsBlockLevelBox(element))
	) {
		retireContentRoot(box);
		return;
	}

	let root = box.contentRoot;
	if (!root) {
		root = new LayoutNode();
		root.setBlockFormattingContext(true);
		box.contentRoot = root;
	}
	// The root IS the box's formatting context, so it wears the display
	// and, for a grid, the container properties the element declares --
	// the element's own layout node is the one the run measures.
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

	// The root is laid out by the measure that reaches it, which may be the
	// one running right now: its boxes have to be in it before it returns.
	if (layout[kDirtyRunContainers].has(element)) {
		syncContainerRuns(layout, element);
	}
}

/** Retire a box's content root once its content is all inline again. */
function retireContentRoot(box: Box): void {
	const root = box.contentRoot;
	if (!root) {
		return;
	}
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
 * Retire every box under a display:none element.
 *
 * Nothing in a display:none subtree generates a box, and layout never
 * descends past the boundary to say so: a node built while the subtree was
 * visible is never visited again, and goes on answering getRect -- and the
 * used values resolved off it -- with the geometry it had when it was last
 * laid out. Retiring them is what makes the subtree box-less.
 */
function retireHiddenContent(
	layout: LayoutEngine,
	element: Element,
): void {
	retireContainerBoxes(layout, element);
	const box = layout[kBoxes].get(element);
	if (box) {
		retireContentRoot(box);
	}
	const walker = createTreeWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		retireFlexNode(layout, child);
		if (child.nodeType === child.ELEMENT_NODE) {
			retireHiddenContent(layout, child as Element);
		}
	}
}

/**
 * Forget the boxes an element was holding: the box list, the runs gathered
 * into it, and the map from each flow child to the box its content fell
 * under. An element that lays out no boxes of its own -- hidden, dissolved,
 * or measured as one run -- holds none, and a list left standing is what the
 * next read is answered from.
 */
function retireContainerBoxes(
	layout: LayoutEngine,
	element: Element,
): void {
	const box = layout[kBoxes].get(element);
	if (box?.children) {
		for (const child of box.children) {
			if (child.kind === "anonymous") {
				retireAnonymousBox(layout, child);
			}
		}
		box.children = null;
		box.heads = null;
	}
	layout[kDirtyRunContainers].delete(element);
}

/**
 * Take the layout nodes away from the content of a box that measures itself
 * as one run. There are none to have: a run measures everything inside it as
 * a single unit, positions and all, so no box in there is one the layout tree
 * lays out. A node left over from when the element was a block container is
 * laid out a second time, in a box the tree no longer has.
 *
 * Two subtrees are left alone, and they are the same exception twice -- a box
 * the run does not measure. An out-of-flow box hangs from its containing
 * block wherever it is written, so it is hoisted rather than retired; and an
 * atomic inline that establishes a block container of its own lays its
 * content out under a root only its own measurement reaches.
 */
function retireRunContent(
	layout: LayoutEngine,
	element: Element,
): void {
	if (layout[kBoxes].get(element)?.contentRoot) {
		return;
	}
	retireContainerBoxes(layout, element);
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
			retireContainerBoxes(layout, child);
		}
		retireFlexNode(layout, node);
		node = walker.nextNode();
	}
}

/**
 * Retire the boxes of the elements a container's enumeration saw THROUGH:
 * one that dissolves into its children, and an inline broken around a block,
 * whose fragments are boxes of the container's own. Neither generates a box
 * of its own, and one left standing is laid out from a shape the container no
 * longer has. Only those elements are descended into, so this costs what they
 * cost and nothing for a tree without them.
 */
function retireSteppedOver(
	layout: LayoutEngine,
	parent: Element,
): void {
	const walker = createTreeWalker(parent);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (child.nodeType !== child.ELEMENT_NODE) {
			continue;
		}
		const element = child as Element;
		const dissolves = dissolvesIntoChildren(element);
		if (!dissolves && !layout[kBoxes].get(element)?.broken) {
			continue;
		}
		// addNode is what retires the box of a box-less element.
		if (dissolves && layout[kNodeMap].has(element)) {
			addNode(layout, element, null);
		}
		retireSteppedOver(layout, element);
	}
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
function containingBlockFlexNode(
	layout: LayoutEngine,
	element: Element,
): LayoutNode | null {
	for (
		let ancestor = flatParentElement<Element>(element);
		ancestor;
		ancestor = flatParentElement<Element>(ancestor)
	) {
		if (getPosition(ancestor) !== "static") {
			const flexNode = layout[kNodeMap].get(ancestor);
			// A measure-function node cannot take flex children; a
			// positioned inline-block can't serve as a flex containing
			// block, so the hoist keeps climbing.
			if (flexNode && !flexNode.measureFunc) {
				return flexNode;
			}
		}
	}
	return layout[kNodeMap].get(layout[kRootElement]) ?? null;
}

/** Hidden by an ancestor's display:none anywhere up the flat tree. */
function hiddenByAncestor(node: Node): boolean {
	for (
		let ancestor = flatParentElement<Element>(node);
		ancestor;
		ancestor = flatParentElement<Element>(ancestor)
	) {
		if (computedDisplay(ancestor) === "none") {
			return true;
		}
	}
	return false;
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
function documentPosition(
	layout: LayoutEngine,
	node: Node,
	flexNode: LayoutNode,
): {x: number; y: number} {
	const position = absolutePosition(layout, flexNode);
	let root = flexNode;
	for (let parent = root.parent; parent; parent = root.parent) {
		root = parent;
	}
	if (root === layout[kViewportRoot]) {
		return position;
	}
	let host: Element | null = null;
	for (
		let current = boxParentElement(node);
		current && !host;
		current = boxParentElement(current)
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

/**
 * Put a flex node at a position under a parent. A node is one child of one
 * parent: one already under this parent is MOVED, because a build that reaches
 * the same element twice -- a deferred re-add drained by the layout pass, then
 * the mutation record that deferred it -- would otherwise leave the flex tree
 * holding it twice and lay its box out twice over.
 */
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

/** A walk of the boxes a node's content lays out from. */
export function flowWalker(root: Node): TreeWalker {
	return createTreeWalker(root, contentsSkipped);
}

/**
 * A `display: contents` element is SKIPPED, which is the DOM's own word for
 * what it does: the element itself is never stopped on, and its children are
 * walked in its place. Only elements are asked -- text has no display.
 */
function contentsSkipped(node: Node): number {
	return (
		node.nodeType === node.ELEMENT_NODE && dissolvesIntoChildren(node)
			? NodeFilter.FILTER_SKIP
			: NodeFilter.FILTER_ACCEPT
	);
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
function skipSubtree(walker: TreeWalker): boolean {
	while (!walker.nextSibling()) {
		if (!walker.parentNode()) {
			return false;
		}
	}
	return true;
}

function trackNode(
	layout: LayoutEngine,
	domNode: Node,
	flexNode: LayoutNode,
): void {
	layout[kNodeMap].set(domNode, flexNode);
	flexNode.owner = domNode;
}

function untrackNode(
	layout: LayoutEngine,
	domNode: Node,
): void {
	const flexNode = layout[kNodeMap].get(domNode);
	if (flexNode) {
		flexNode.owner = null;
	}
	// The lines a box holds are the product of the layout node that is
	// going: nothing lays that content out until a box is built for it
	// again, and the lines would describe a box that no longer exists.
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

/**
 * The first composed (flat-tree) child that can start an inline run:
 * shadow content for hosts, projected content through slots, skipping
 * display:none elements -- a UA shadow tree's <style> would otherwise
 * terminate leaf collection at position zero.
 */
function firstComposedRenderableChild(element: Element): Node | null {
	const walker = flowWalker(element);
	for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
		if (
			child.nodeType === child.ELEMENT_NODE &&
			(computedDisplay(child as Element) === "none" ||
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

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

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
 * That is why the sites that only dirty a container do not stale it: they
 * would throw away a correct enumeration and rebuild it, per mutation.
 */
function restageContainer(
	layout: LayoutEngine,
	container: Element,
): void {
	layout[kDerivedContainers].delete(container);
	layout[kDirtyRunContainers].add(container);
}

/**
 * Note that a node's box may no longer sit where its container's
 * enumeration says.
 */
function restageBox(
	layout: LayoutEngine,
	node: Node,
): void {
	const container = getRunContainer(layout, node);
	if (container) {
		restageContainer(layout, container);
	}
}

/**
 * Note that the boxes an element's children generate may no longer be the
 * ones its container's enumeration holds -- for an inline that is the
 * block container around it, since an inline's children belong to the run
 * the inline sits on.
 */
function restageChildren(
	layout: LayoutEngine,
	parent: Element,
): void {
	let box: Element | null = parent;
	while (box && dissolvesIntoChildren(box)) {
		box = boxParentElement(box);
	}
	if (!box) {
		return;
	}
	restageContainer(layout, box);
	const container = runContainerFrom(layout, box, false);
	if (container) {
		restageContainer(layout, container);
	}
}

/** Note that every container in and around a subtree must re-enumerate. */
function restageSubtree(
	layout: LayoutEngine,
	node: Node,
): void {
	restageBox(layout, node);
	if (node.nodeType !== node.ELEMENT_NODE) {
		return;
	}
	restageChildren(layout, node as Element);
	// A subtree layout has never seen holds no enumeration to unsettle, and
	// the walk to discover that would cost more than the boxes it saves.
	// Anything that HAS been laid out is reachable from its own record: a
	// tree assembled off-document announces each piece as it is joined.
	if (!layout[kNodeMap].has(node) && !layout[kBoxes].get(node)?.children) {
		return;
	}
	// The flat tree, not the flow: which elements dissolve into their
	// children is a question for the cascade, and marking one that turns
	// out to generate no box costs nothing.
	const walker = createTreeWalker(node);
	for (let child = walker.nextNode(); child; child = walker.nextNode()) {
		if (child.nodeType === child.ELEMENT_NODE) {
			restageContainer(layout, child as Element);
		}
	}
}

function invalidateInlineRun(layout: LayoutEngine, node: Node): void {
	const entry = getBoxEntry(layout, node);
	if (!entry) {
		return;
	}
	if (entry.kind === "anonymous") {
		invalidateContainerBoxes(layout, entry.container);
		layout[kDirtyRunContainers].add(entry.container);
		// Content an anonymous box lays out owns no layout node of its own.
		// One left over from an earlier shape of the container measures the
		// same content a second time, in a box the container no longer has.
		retireFlexNode(layout, node);
		return;
	}
	// A box of the element's own (a flex container blockifies its inline
	// children) measures only itself.
	const container = getRunContainer(layout, entry.node!);
	if (container) {
		invalidateContainerBoxes(layout, container);
	}
	layout[kNodeMap].get(entry.node!)?.markDirty();
}

function invalidateNode(
	layout: LayoutEngine,
	node: Node,
): void {
	layout[kInvalidatedNodes].add(node);

	if (isInlineLevel(node)) {
		invalidateInlineRun(layout, node);
	} else if (node.nodeType === node.ELEMENT_NODE) {
		const flexNode = layout[kNodeMap].get(node);
		if (flexNode) {
			const parent = flexNode.parent;
			if (parent) {
				parent.removeChild(flexNode);
			}

			if (!node.isConnected) {
				layout[kMeasureNodes].delete(flexNode);
				flexNode.freeRecursive();
				untrackNode(layout, node);
			} else {
				// Still connected, so the node is kept for calculateLayout's re-add
				// sweep to reattach.
				//
				// Re-apply its styles, though: whatever invalidated the element may
				// have changed them. A list's padding-left is derived from its items'
				// markers, so appending a wider item changes the parent's computed
				// padding, and reusing the node as-is would keep the stale gutter.
				styleNode(layout, node as Element, flexNode);

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
					const childDOMNode = childFlexNode.owner as Node | undefined;
					if (childDOMNode) {
						clearBreakResultCache(layout, childDOMNode);
					}
				}
			}
		}

		invalidateNodeChildren(layout, node as Element);
	}
}

/** Invalidate every box the element's own children generate. */
function invalidateNodeChildren(
	layout: LayoutEngine,
	element: Element,
): void {
	const walker = flowWalker(element);
	let child = walker.firstChild();

	while (child) {
		invalidateNode(layout, child);
		child = walker.nextSibling();
	}
}

function clearBreakResultCache(
	layout: LayoutEngine,
	node: Node,
): void {
	const entry = getBoxEntry(layout, node);
	if (entry?.kind === "anonymous") {
		invalidateBox(layout, entry);
	} else if (entry) {
		// Dirtying the measure is what drops the lines: they are the product of
		// a size the layout cache holds, and a clean node keeps both.
		markRunMeasureDirty(layout, entry.node!);
	}
}

/**
 * Drop an anonymous box's lines and dirty the measure that refills them --
 * including, when the box sits under an atomic inline's content root, the
 * box whose measure is the only thing that ever lays that content out.
 */
function invalidateBox(
	layout: LayoutEngine,
	box: Box,
): void {
	box.layoutNode?.markDirty();
	const host = enclosingContentRoot(layout, box.container);
	if (host) {
		invalidateEnclosingMeasure(layout, host);
	}
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
function enclosingContentRoot(
	layout: LayoutEngine,
	from: Element | null,
): Element | null {
	for (let current = from; current; current = boxParentElement(current)) {
		if (layout[kBoxes].get(current)?.contentRoot) {
			return current;
		}
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
function invalidateContainerBoxes(
	layout: LayoutEngine,
	container: Element,
): void {
	for (const entry of containerBox(layout, container).children!) {
		if (entry.kind === "anonymous") {
			invalidateBox(layout, entry);
		} else if (entry.fragments) {
			markRunMeasureDirty(layout, entry.node!);
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
function invalidateEnclosingMeasure(
	layout: LayoutEngine,
	node: Node,
): void {
	// Whatever restyled a node with no box of its own may have given it
	// one, or taken one away: the container's box list is what says.
	const runContainer = getRunContainer(layout, node);
	if (runContainer) {
		layout[kDirtyRunContainers].add(runContainer);
	}
	// The box a node's content sits in may be its ANCESTOR's box: a node
	// inside a run member is not itself a member, and the anonymous box
	// holding it belongs to no DOM node, so the climb below -- which looks
	// for a layout node with a measure function -- walks straight past it.
	let entry = getBoxEntry(layout, node);
	for (
		let ancestor = entry === null ? boxParentElement(node) : null;
		ancestor && entry === null;
		ancestor = boxParentElement(ancestor)
	) {
		entry = getBoxEntry(layout, ancestor);
	}
	if (entry?.kind === "anonymous") {
		if (entry.layoutNode) {
			invalidateBox(layout, entry);
			return;
		}
		// A run with no layout node of its own is measured INSIDE another
		// run: an inline-block nested in an inline-block has no box the
		// flex tree knows about -- its whole content is part of the one
		// unit its host occupies out there. The measure to drop is that
		// outer one, which the container it runs in is the way up to.
		if (entry.container !== node) {
			invalidateEnclosingMeasure(layout, entry.container);
			return;
		}
	} else if (entry) {
		const headFlexNode = layout[kNodeMap].get(entry.node!);
		if (headFlexNode && headFlexNode.measureFunc) {
			headFlexNode.markDirty();
			// Keep climbing out of any content root this run sits under:
			// only the box that owns it can run that layout again.
			const host = enclosingContentRoot(layout, boxParentElement(entry.node!));
			if (host) {
				invalidateEnclosingMeasure(layout, host);
			}
			return;
		}
	}
	let current = boxParentElement(node);
	while (current) {
		// An ancestor that is itself a run member owns no layout node: the
		// anonymous box holding it is what measures it, and everything
		// nested inside it with it. Nothing further out ever re-runs that
		// measure, so the climb ends here.
		const enclosing = getBoxEntry(layout, current);
		if (enclosing?.kind === "anonymous" && enclosing.layoutNode) {
			invalidateBox(layout, enclosing);
			return;
		}
		const flexNode = layout[kNodeMap].get(current);
		if (flexNode) {
			if (flexNode.measureFunc) {
				flexNode.markDirty();
			}
			const host = enclosingContentRoot(layout, boxParentElement(current));
			if (host) {
				invalidateEnclosingMeasure(layout, host);
			}
			return;
		}
		current = boxParentElement(current);
	}
}

const kRestyled = Symbol("restyled");

/**
 * Dirty the measure that refills a run's break result -- and, when the run
 * lives under an atomic inline's content root, the box whose measure is the
 * only thing that ever lays that content out. Dirtying just the run there
 * invalidates it forever: nothing above the box ever visits those nodes, so
 * the cleared break result is never rebuilt and the run paints nothing.
 */
function markRunMeasureDirty(
	layout: LayoutEngine,
	runHead: Node,
): void {
	const flexNode = layout[kNodeMap].get(runHead);
	if (!flexNode) {
		return;
	}
	if (flexNode.measureFunc) {
		flexNode.markDirty();
	}
	const host = enclosingContentRoot(layout, boxParentElement(runHead));
	if (host) {
		invalidateEnclosingMeasure(layout, host);
	}
}

// ---------------------------------------------------------------------------
// Inline formatting (lines)
// ---------------------------------------------------------------------------

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
		dataOffsets?: Int32Array | null;
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

/**
 * One laid-out line of a text node: its box, and the range of the node's raw
 * `data` the line renders. The range begins and ends on a rendered character,
 * so `renderTextFragment` over it reproduces the painted characters.
 */
interface LineFragment {
	rect: DOMRect;

	/** Data offset of the line's first character / caret slot. */
	startOffset: number;

	/** Data offset of the caret slot AFTER the line's last character. */
	endOffset: number;

	/** See LineResult segments: the visual order the line was laid out in. */
	visualBase: "ltr" | "rtl" | null;
}

const kRectTextIndices = Symbol("rectTextIndices");

/** One text node's placed fragment within a break result. See kRectTextIndices. */
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
interface RectText {
	rect: DOMRect;
	text: string;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
}

/** The `white-space` a text node renders under: its flat-tree parent's. */
function getWhiteSpace(textNode: Text): string {
	const parent = flatParentElement<Element>(textNode);
	return parent ? getComputedValue(parent, "white-space") : "normal";
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
 * Break a box's content into lines and report the size they came to.
 *
 * `placing` is the measurement that decides the box the content ends up
 * in, as against the sizing probes a container makes on its way there. Only
 * that one's lines become the box's: a probe at some other width -- the
 * min-content one among them -- is an answer about a box nothing was ever
 * laid out in, and painting it renders a stretched item at its narrowest.
 */
function measureInlineRun(
	layout: LayoutEngine,
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
function collectLeafNodes(
	layout: LayoutEngine,
	source: Box,
	availableWidth: number,
	availableWidthMode: MeasureMode = "unconstrained",
): Leaf[] {
	const leafNodes: Leaf[] = [];
	if (source.kind === "anonymous") {
		// Each member's own subtree, and no further: the enumeration
		// already said where this box's content ends.
		for (const member of source.members) {
			collectLeavesUnder(
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
	const parentElement = boxParentElement(node);
	if (!parentElement) {
		return leafNodes;
	}

	// An element measuring its OWN content walks from itself, out through
	// the block container that holds it: a run that starts inside an inline
	// box -- the fragment after a block-level box split it -- carries on
	// past that box's end. `<span>a<div/>b</span>c` puts "b" and "c" on one
	// line, so the walk cannot stop at </span>. An out-of-flow inline is
	// where the climb stops: it is blockified (css-display-3 §2.7) and lays
	// its own content out.
	const parentDisplay = computedDisplay(parentElement);
	let traversalRoot: Node;
	if (laysOutItems(parentDisplay) && node.nodeType === node.ELEMENT_NODE) {
		traversalRoot = node;
	} else {
		let root: Element = parentElement;
		for (
			let ancestor = boxParentElement(root);
			ancestor &&
			computedDisplay(root) === "inline" &&
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
		laysOutItems(parentDisplay) && node.nodeType === node.TEXT_NODE;

	collectLeavesUnder(
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

/** Collect leaves from `start`, walking within `root`. */
function collectLeavesUnder(
	layout: LayoutEngine,
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
			const display = computedDisplay(element);

			if (
				computedDisplay(element) === "none" ||
				isOutOfFlow(element)
			) {
				// No box here (none) or a box ELSEWHERE (out of flow):
				// neither occupies run space nor interrupts the run. Checked
				// before the display branches -- an absolute inline span
				// otherwise measures into the run it left.
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
				const ownBox = principalBox(layout, element);
				// Before anything reads its size or asks what its content
				// runs from: an inline-block nested inside another inline is
				// a run MEMBER, and addElementNode is never called on one,
				// so this is the first moment its block content is known to
				// need a root.
				if (!ownBox.contentRoot) {
					syncContentRoot(layout, element);
				}

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

				// A sizing keyword never reaches getBoxModel's numbers; it
				// picks the probe the content is measured under instead.
				const widthSizing =
					boxModel.width === undefined
						? widthSizingConstant(getComputedValue(element, "width"))
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
					// fit-content: break at the run's available width, which
					// caps max-content without flooring below min-content.
					contentWidth = Math.max(0, availableWidth - horizontalBoxSpace);
					contentWidthMode = "at-most";
				} else if (element.tagName === "TEXTAREA") {
					// cols sizes the CONTENT box (spec default 20), exactly as the
					// attribute does in a browser; the box then adds whatever
					// border and padding the cascade actually left. The UA sheet
					// deliberately carries no width for it -- a constant that
					// pre-baked the UA chrome could not be unbaked by an author's
					// `border: none`.
					const cols = parseInt(element.getAttribute("cols") ?? "", 10);
					contentWidth = Number.isFinite(cols) && cols > 0 ? cols : 20;
					contentWidthMode = "exactly";
				}

				// When width is this element's flex MAIN axis, its used width is
				// the flex engine's to decide -- basis, grow, shrink and min/max
				// all resolved engine-side -- and the measure offers carry that
				// authority: a definite `exactly` offer is the resolved used width
				// (the final layout pass), and an `at-most` offer
				// below the CSS width is an intrinsic probe (the css-flexbox-1
				// §4.5 min-content floor offers 0) that wants the CONTENT's
				// minimum, not the basis -- the engine clamps the floor by the
				// specified size itself. Both break the content at the offer.
				// Row flex items only: everywhere else a definite width wins
				// over the container's offer, and a block container's `exactly`
				// offer describes the CONTAINER's width, not this element's own
				// resolution -- a definite-width inline-block in a narrow block
				// overflows, it does not re-wrap.
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
				// reported box size the later clamp covers -- otherwise the
				// content wraps at its natural width and overflows the capped box.
				const maxWidthValue = parseUnitValue(
					getComputedValue(element, "max-width"),
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
						if (contentWidthMode === "unconstrained") {
							contentWidthMode = "at-most";
						}
					}
				}

				if (boxModel.height !== undefined) {
					contentHeight = Math.max(0, boxModel.height - verticalBoxSpace);
					contentHeightMode = "exactly";
				}

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
					// A sizing keyword rides on the root, which turns a passed
					// width into the matching probe instead of a used width.
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
					const contentStart = firstComposedRenderableChild(element);
					if (contentStart) {
						inlineBlockResult = breakNodes(
							layout,
							principalBox(layout, contentStart),
							contentWidth,
							contentWidthMode,
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
				if (!skipSubtree(walker)) {
					break;
				}
			} else if (display === "inline") {
				if (!walker.nextNode()) {
					break;
				}
			} else {
				// A block-level box is not this box's content: it broke the
				// inline that holds it, and the fragments on either side are
				// members of their own.
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
	layout: LayoutEngine,
	source: Box,
	width: number,
	widthMode: MeasureMode,
): BreakResult {
	// An `unconstrained` width offer means "measure your natural size" --
	// indefinite, so percentage widths in the content cannot resolve
	// against it (NaN); any definite offer, including an `at-most` 0
	// min-content probe, resolves them.
	const leafNodes = collectLeafNodes(
		layout,
		source,
		widthMode === "unconstrained" ? NaN : width,
		widthMode,
	);

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

	const whiteSpace = getComputedValue(styleElement, "white-space");
	const wordBreak = getComputedValue(styleElement, "word-break");
	const overflowWrap = getComputedValue(styleElement, "overflow-wrap");

	// An offered width of 0 is a real constraint, not "unlimited": it asks for
	// the narrowest the content can be, which is its min-content size -- the
	// longest word that cannot be broken. Treating it as unlimited returns
	// max-content instead, making min-content zero everywhere, with a long
	// word left nothing to stop it overflowing its box.
	const maxWidth =
		widthMode === "unconstrained"
			? Number.MAX_SAFE_INTEGER
			: width;

	const processedContent = processWhitespace(layout, leafNodes);
	// `pre` suppresses wrapping exactly as `nowrap` does -- it differs only in
	// preserving whitespace and honouring newlines, which processWhitespace
	// already handles. Treating it as wrappable folds text a browser lets
	// overflow.
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
	// A word with no break opportunity inside it either overflows its
	// line (overflow-wrap: normal, the browser default) or gains
	// synthetic break points anywhere it needs them (break-word /
	// anywhere / word-break: break-all). break-word deliberately does
	// NOT shrink min-content -- the word still measures whole at the
	// `at-most` 0 probe -- while anywhere and break-all do.
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
	const declared = getComputedValue(styleElement, "direction");
	const base: "ltr" | "rtl" =
		declared === "rtl"
			? "rtl"
			: declared === "ltr"
				? "ltr"
				: inferParagraphDirection(processedContent.text);

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
	layout: LayoutEngine,
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
	layout: LayoutEngine,
	leafNodes: Leaf[],
): ProcessedContent {
	const items: ProcessedContent["items"] = [];
	let text = "";

	for (let leafIndex = 0; leafIndex < leafNodes.length; leafIndex++) {
		const leaf = leafNodes[leafIndex];
		const start = text.length;

		if (leaf.type === "text" && leaf.content) {
			// The white-space this leaf renders under, read the way a painter
			// reads it: from the flat-tree parent whose style it inherits.
			const leafWhiteSpace = getWhiteSpace(leaf.node);

			const rendered = renderLeaf(layout, leaf.node, leafWhiteSpace);
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
			text += "\uFFFC"; // Object replacement character
			items.push({
				leafNode: leaf,
				start,
				end: text.length,
			});
		}
	}

	// The spaces a run opens and closes on collapse away: they sit at the edge
	// of a line, and css-text-3 §4.1.1 removes them there.
	if (text.length > 0) {
		// Where the run stops being collapsible. A `pre` leaf keeps its own
		// spaces and only its own: normal text before it still loses the spaces
		// it opened with, and text after it still loses the ones it ended on.
		// Asking whether ANYTHING in the run preserves spaces spared both edges,
		// so `   <b class="pre">x</b>` opened on a space no browser draws.
		let guardStart = text.length;
		let guardEnd = 0;
		for (const item of items) {
			const leaf = item.leafNode;
			if (leaf.type === "text" && preservesSpaces(getWhiteSpace(leaf.node))) {
				guardStart = Math.min(guardStart, item.start);
				guardEnd = Math.max(guardEnd, item.end);
			}
		}

		// Spaces and tabs, never the newline a <br> contributes: that one is a
		// forced break, not collapsible whitespace, and trimming it dropped the
		// blank line `<br>text` opens with.
		const leading = text.match(/^[^\S\n]*/)?.[0].length || 0;
		const trailing = text.match(/[^\S\n]*$/)?.[0].length || 0;
		const trimStart = Math.min(leading, guardStart);
		const trimmedEnd = Math.max(text.length - trailing, guardEnd);

		if (trimStart > 0 || trimmedEnd < text.length) {
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
						item.processedContent.length,
					);
				}
				item.start = clampedStart - trimStart;
				item.end = clampedEnd - trimStart;
			}
		}
	}

	return {items, text, prefixWidths: prefixWidths(items, text)};
}

/** Whether ANY text leaf in the run carries white-space: nowrap. */
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
	// Nothing may break a nowrap run except a break the CONTENT demands: a
	// newline under `pre`, or a <br>. Dropping every break point suppressed
	// those too, so `pre` -- which does not wrap but does honour newlines --
	// collapsed a three-line block onto one line.
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
	layout: LayoutEngine,
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
				measureText(content, lineStart, breaks[mid].position) <=
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
			bestBreakWidth = measureText(content, lineStart, bestBreak);
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

			// Cells go out in VISUAL order, because the terminal will not
			// reorder them for us (see bidi.ts). Doing it here rather than at
			// paint time means hit-testing and selection read the same
			// coordinates the user is looking at.
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

/** The width of text[start..end) of a run, in terminal cells. */
function measureText(
	content: ProcessedContent,
	start: number,
	end: number,
): number {
	return content.prefixWidths[end] - content.prefixWidths[start];
}

const kTerminalReordersText = Symbol("terminalReordersText");

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
function toVisualLine(
	layout: LayoutEngine,
	segments: LineResult["segments"],
	lineWidth: number,
	base: "ltr" | "rtl",
): void {
	if (layout[kTerminalReordersText]) {
		return;
	} // It insists; let it.
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
				const shaped = stringWidth(segment.processedText);
				const delta = segment.width - shaped;
				if (delta > 0) {
					segment.x += delta;
					segment.width = shaped;
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Geometry and queries
// ---------------------------------------------------------------------------

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
	// `start` and `end` name the READING direction's ends, so they trade sides
	// in an RTL paragraph: an undeclared alignment is `start`, which puts an
	// RTL line at the right edge, and `end` puts it at the left.
	const rtl = getComputedValue(container, "direction") === "rtl";
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
 * A flex node's absolute document position: the sum of computed offsets up
 * the tree, minus the scrollLeft/scrollTop of every ANCESTOR scroll box
 * along the way -- a box's own scroll shifts its descendants, not itself.
 * Scroll is a post-layout content offset, not a flex concept, so it is
 * applied here, in the single funnel every geometry read passes through, so
 * paint, getRect, hit-testing, and Range geometry all inherit it at once.
 */
function absolutePosition(
	layout: LayoutEngine,
	flexNode: LayoutNode,
): {x: number; y: number} {
	// The document roots' scrollLeft/scrollTop ARE the camera (the window
	// shim maps them onto the viewport), and the camera is applied once at
	// paint, not in this document-space geometry. Only per-element scroll on
	// other boxes belongs here.
	const document = layout[kEngineWindow].document;
	const root = document.documentElement;
	const body = document.body;
	let x = 0;
	let y = 0;
	for (
		let current: LayoutNode | null = flexNode;
		current;
		current = current.parent
	) {
		x += current.layout.left;
		y += current.layout.top;
		if (current !== flexNode) {
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

function breakResultTextIndex(
	layout: LayoutEngine,
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

/**
 * In-flow descent: the element must contain the point; children are probed
 * in REVERSE tree order (last-painted wins), positioned children skipped --
 * their context probes them.
 */
function hitTestInFlow(
	layout: LayoutEngine,
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
			contained = isPointInRects(x, y, layout.getRects(element));
		} catch (_err) {
			return null;
		}
		if (!contained && !splitsAroundBlock(element)) {
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
function staticPosition(
	layout: LayoutEngine,
	element: Element,
	containingBlock: LayoutNode,
): {left: number; top: number} | null {
	const container = getRunContainer(layout, element);
	if (!container) {
		return null;
	}
	if (
		laysOutItems(computedDisplay(container))
	) {
		return null;
	}
	const containerNode = containerFlexNode(layout, container);
	if (!containerNode) {
		return null;
	}

	const origin = absolutePosition(layout, containerNode);
	const containingOrigin = absolutePosition(layout, containingBlock);
	const offsetLeft = origin.x - containingOrigin.x;
	const offsetTop = origin.y - containingOrigin.y;
	// The flow starts inside the container's border and padding.
	const contentLeft =
		containerNode.style.border.left +
		containerNode.layout.padding.left;
	const contentTop =
		containerNode.style.border.top +
		containerNode.layout.padding.top;

	const box = containerBox(layout, container);
	const children = box.children!;
	let entry: Box | null = null;
	for (let current: Node = element; current !== container;) {
		const found = box.heads!.get(current);
		if (found) {
			entry = found;
			break;
		}
		const parent = boxParentElement(current);
		if (!parent) {
			break;
		}
		current = parent;
	}

	// In an inline formatting context the box takes the position the line
	// had reached: after everything already on it, on the line that would
	// have carried it.
	if (entry?.kind === "anonymous") {
		const runNode = entry.layoutNode;
		if (runNode) {
			const runOrigin = absolutePosition(layout, runNode);
			const cursor = inlineCursorBefore(entry, element);
			return {
				left: runOrigin.x - containingOrigin.x + cursor.x,
				top: runOrigin.y - containingOrigin.y + cursor.y,
			};
		}
	}

	// A block container: after the last box that took a position before it.
	const index = children.indexOf(entry ?? principalBox(layout, element));
	for (let i = index - 1; i >= 0; i--) {
		const previous = children[i];
		const previousNode = laidOutBy(layout, previous);
		// A box out of flow took no position, so nothing sits after it: the
		// hypothetical box this is placing would have landed where the last
		// IN-FLOW box left off.
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

/**
 * How far a run's line had advanced when it reached a node that generates
 * no box in it: the trailing edge of the last content placed before that
 * node, and the top of the line it landed on, relative to the run's box.
 */
function inlineCursorBefore(
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
				// A preserved newline is a BREAK, never a glyph: lines split
				// right after it, so it can only ever sit at the segment's
				// tail -- and a literal \n reaching the painter would feed
				// the terminal a raw line feed, shifting every later cell
				// of the frame (a segment's data range ends on its last
				// PAINTED character, so offsets stay aligned).
				const portion = item.processedContent
					.slice(relativeStart, relativeEnd)
					.replace(/\n+$/, "");
				width = stringWidth(portion);

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

function layoutRect(engine: LayoutEngine, element: Element): DOMRect | null {
	return element.isConnected ? engine.getRect(element) : null;
}

// ---------------------------------------------------------------------------
// LayoutEngine
// ---------------------------------------------------------------------------

export class LayoutEngine {
	declare [kDOMRect]: typeof DOMRect;
	declare [kRootElement]: Element;
	declare [kEngineWindow]: EngineWindow;

	/** The terminal-sized root every box hangs from; it has no DOM node. */
	declare [kViewportRoot]: LayoutNode;

	/**
	 * The layout node laying out each node that has one. Not every node does:
	 * a run member is measured by the run around it and owns none, which is
	 * what `laidOutBy` answers for.
	 */
	declare [kNodeMap]: Map<Node, LayoutNode>;

	declare [kInvalidatedNodes]: Set<Node>;

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
	declare [kPositionedElements]: Set<Element>;

	/** Re-measured on resize: what they answered was for another width. */
	declare [kMeasureNodes]: Set<LayoutNode>;

	/**
	 * Set when the terminal answered that it reorders bidirectional text itself
	 * (see the session's negotiateBidi). Then lines stay in logical order: one reordering is
	 * correct, two is a sentence backwards again.
	 */
	declare [kTerminalReordersText]: boolean;

	/**
	 * The last rendering of each text node, under the one key its rendering is
	 * a function of: the data and the white-space it was rendered under. A
	 * node holds one, because a text node has one data and one white-space at
	 * a time. One inline run is broken several times per build -- once per
	 * width the sizing pass tries -- and the rendering is the same every time.
	 */
	declare [kRenderedLeaves]: WeakMap<Text, {
		key: string;
		text: string;
		offsets: Int32Array | null;
	}>;

	// Text-fragment index per break result: text node -> the fragments the
	// breaker placed for it, each with its OUTER line index, x offset (nested
	// inline-block content already shifted by its box's position and padding,
	// as the merge in the rect-text walk expects), width, processed text, the
	// data range that renders back to it, and a global ordinal preserving
	// segment order. WeakMap-keyed on the break result object: re-breaking
	// builds a fresh object, so entries can never go stale.
	declare [kRectTextIndices]: WeakMap<object, Map<Text, TextFragmentEntry[]>>;

	/**
	 * The box tree's nodes, by the DOM node each is the principal box of: the
	 * identity a derivation reconciles against, so that a container rebuilt
	 * around a node finds the box that node already had, holding the layout
	 * node and the fragments it was laid out with.
	 */
	declare [kBoxes]: WeakMap<Node, Box>;

	/**
	 * Every live anonymous box, by the layout node it owns: the reverse of
	 * Box.layoutNode, and the registry the sweeps that must reach every box
	 * (resize, pruning, disposal) walk. Strong, because a container's children
	 * are re-derived whenever the tree moves under it and the boxes it held
	 * must still be retired.
	 */
	declare [kAnonymousBoxes]: Map<LayoutNode, Box>;

	/**
	 * The containers whose enumeration still describes their children. A
	 * mutation drops the ones it disturbs as it arrives -- the container a
	 * node's box sits in, and the one an element's own children's boxes sit
	 * in -- so that flipping a class on one row of a long list re-enumerates
	 * that row, and not the nine hundred and ninety-five boxes around it. An
	 * unbounded change drops the set: a fresh one says nothing is derived,
	 * which costs nothing to say and re-derives each container lazily, on the
	 * read that needs it.
	 *
	 * Weak, because a container named here may be the last thing a removed
	 * subtree is held by, and a container never read again is never cleared.
	 */
	declare [kDerivedContainers]: WeakSet<Element>;

	/**
	 * Containers whose box list may no longer match their layout children.
	 * Reconciled once per pass, in calculateLayout, however many mutations
	 * dirtied them.
	 */
	declare [kDirtyRunContainers]: Set<Element>;

	/**
	 * Elements whose computed style the cascade has dropped, awaiting the work
	 * that drop implies for layout. Collected rather than acted on: the cascade
	 * announces them mid-invalidation, while descendants still hold the styles
	 * they are about to lose, and every question layout asks here -- which box
	 * holds this element, what kind of box it is -- is a question about the
	 * styles that have not finished arriving.
	 */
	declare [kRestyled]: Set<Element>;

	constructor(window: EngineWindow) {
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
		this[kEngineWindow] = window;
		this[kDOMRect] = window.DOMRect;
		this[kRootElement] = window.document.documentElement;
		this[kNodeMap] = new Map<Node, LayoutNode>();
		this[kInvalidatedNodes] = new Set<Node>();
		this[kMeasureNodes] = new Set<LayoutNode>();

		this[kViewportRoot] = new LayoutNode();
		this[kViewportRoot].setFlexDirection("column");
		this[kViewportRoot].setAlignItems("stretch");
	}

	adoptTerminalReordering(): void {
		// Flips the visual order of every RTL run without a mutation.
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
		for (const flexNode of this[kMeasureNodes]) {
			flexNode.markDirty();
		}
	}

	/**
	 * Lay the viewport root out at a new terminal size. The engine keeps no
	 * copy of the size: the root it sizes here is the copy, and the document
	 * that adopted the size holds the one everything else reads.
	 */
	resize(width: number, height: number): void {
		this[kViewportRoot].setWidth(width);
		this[kViewportRoot].setHeight(height);

		for (const flexNode of this[kMeasureNodes]) {
			flexNode.markDirty();
		}
		changed(this);

		this.calculateLayout();
	}

	calculateLayout(): void {
		// The tree is built on the first pass, not at construction: building
		// it reads every element's display through the cascade, and the
		// engine is constructed before the cascade that answers exists.
		if (!this[kNodeMap].has(this[kRootElement])) {
			addNode(this, this[kRootElement], this[kViewportRoot]);
		}
		// The cascade has finished for this frame, so the boxes it unsettled
		// can be named against the styles that stand rather than the ones that
		// were on their way out.
		applyRestyles(this);
		// Nothing marked dirty and nothing awaiting re-add: the previous layout
		// still holds, and even the pruning sweep below -- O(nodes) isConnected
		// checks -- is not worth paying. Every mutation path dirties the tree on
		// its way in, so a clean tree cannot be hiding a disconnection.
		if (
			!this[kViewportRoot].dirty &&
			this[kInvalidatedNodes].size === 0 &&
			this[kDirtyRunContainers].size === 0
		) {
			return;
		}

		// Drop nodes whose DOM node is gone. Callers may invoke calculateLayout()
		// synchronously after a DOM removal, before the MutationObserver microtask
		// has run, which would otherwise leave the removed node attached here and
		// get it measured -- and measuring a detached run head has no parent to
		// collect leaves from.
		pruneDisconnectedNodes(this);

		for (const node of this[kInvalidatedNodes]) {
			if (node.isConnected) {
				// The composed BOX parent: a shadow root's direct child has no
				// parentElement at all, and a display:contents element (never
				// re-visited by the flattening walker, so never retired) can
				// still hold a stale severed node -- attaching under it strands
				// the child in an orphan subtree.
				let parent = boxParentElement(node);
				while (parent) {
					// An inline-block holding block-level content owns no layout
					// node in the tree above -- the run measuring it does -- and
					// lays its children out under a root of its own.
					const parentFlexNode = containerFlexNode(this, parent);
					if (parentFlexNode) {
						addNode(this, node, parentFlexNode);
						break;
					}
					// An inline box on the way up owns no layout node because a
					// RUN measures it, and everything inside it with it.
					// Climbing past one lands the content in the run's own
					// container, as a sibling of the line it belongs to. A
					// BROKEN inline is the exception: its fragments really are
					// the container's boxes.
					if (isInlineLevel(parent) && !this[kBoxes].get(parent)?.broken) {
						break;
					}
					parent = boxParentElement(parent);
				}
			}
		}
		this[kInvalidatedNodes].clear();

		// Give every container whose content moved the boxes it lays out now.
		// Draining rather than iterating: building a block-level box a broken
		// inline handed over reaches containers of its own.
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

		// Every mutation path marks the flex tree dirty on its way in -- style
		// setters, child insertion/removal, inline-run invalidation, resize. A
		// clean root therefore means the previous layout is still exact, and
		// recomputing it would be pure waste -- a full-tree relayout per frame
		// for an animation repainting one span.
		if (!this[kViewportRoot].dirty) {
			return;
		}

		// The space offered to the root is the root's own size, which `resize`
		// set: the terminal is the viewport, so the two are the same number
		// read from the one place that holds it. Below the root the html
		// element can size to its content and still resolve percentages and
		// viewport units against the terminal.
		const root = this[kViewportRoot];
		root.calculateLayout(root.style.width.value, root.style.height.value);
	}

	/** Drop the box tree and every registry keyed on it. */
	dispose(): void {
		this[kViewportRoot].freeRecursive();

		this[kNodeMap] = new Map();
		this[kInvalidatedNodes] = new Set();
		this[kMeasureNodes] = new Set();
		this[kAnonymousBoxes] = new Map();
		this[kDirtyRunContainers] = new Set();
	}

	/** The laid-out height of the document, which is the root's scrollHeight. */
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
	 * Whether the element paints as its own stacking layer, hoisted out of
	 * its container's flow walk. Registry membership is the gate: a
	 * positioned INLINE run member owns no box of its own -- no layer would
	 * ever paint it, so it stays with its run.
	 */
	hoistedToLayer(element: Element): boolean {
		return isPositioned(element) && this[kPositionedElements].has(element);
	}

	isSubtreeOutsideBand(element: Element, top: number, bottom: number): boolean {
		// An element with no box of its own is culled by the anonymous box that
		// lays its content out, whose extent covers the whole run it opens.
		const node = this[kNodeMap].get(element) ?? runFlexNode(this, element);
		if (!node) {
			return false;
		}
		if (node.extentBottom > top && node.extentTop < bottom) {
			return false;
		}
		// An inline broken around a block-level box paints boxes that are NOT
		// in its own layout subtree -- the block and the fragment after it are
		// the container's children -- so its extent says nothing about them.
		// The paint walk still reaches them through the DOM, and culling by
		// this node's zero-height first fragment blanked the whole thing:
		// `<a href="..."><div>card</div></a>` rendered empty.
		return !this[kBoxes].get(element)?.broken;
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
		const flexNode = this[kNodeMap].get(element);
		if (
			!flexNode ||
			// A measure-function leaf (an inline/inline-block run head) never gets
			// its DOM children added to the layout tree at all -- they're measured
			// as an opaque unit, not walked -- so an empty children[] here means
			// "not decomposed," not "confirmed nothing to paint." Its real DOM
			// children (e.g. the run head's own text) still need the walker below.
			flexNode.measureFunc !== null ||
			flexNode.unstackedChildCount !== 0 ||
			flexNode.style.mode !== "block" ||
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
			getShadowRoot<ShadowRoot>(element) !== null ||
			// So can a container that a broken inline handed boxes to: those
			// boxes are children[] entries whose DOM node lives a level DOWN,
			// while this element's own later children own no entry at all.
			// `<span>a<div/><span>c</span></span>d<input>` collides at three
			// and three, and the fast path painted the fragments while
			// dropping the text and the input after them.
			this[kBoxes].get(element)?.holdsFragments === true
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

	/**
	 * A grid container's used track sizes, in the implicit grid's own order.
	 * Null for a box that laid out no grid, which is every box but a grid
	 * container -- and a grid container that has not been laid out yet.
	 */
	gridTracks(element: Element, rows: boolean): number[] | null {
		const flexNode = containerFlexNode(this, element);
		if (!flexNode) {
			return null;
		}
		return flexNode.getComputedGridTracks(rows)?.sizes ?? null;
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
	/**
	 * The paint height of the document: the root box's laid-out height,
	 * extended to cover top-layer boxes -- hoisted under the root, they
	 * contribute nothing to the flow's height, and a picker opening at the
	 * bottom edge must still get rows to paint into. A modal's ::backdrop
	 * paints the whole viewport, so the frame emits that many rows whatever
	 * the dialog's own box says: reserving less lets the frame's last rows
	 * push the terminal past its bottom, a physical scroll no bookkeeping
	 * records.
	 *
	 * The root, not body's scroll height: an inline body is a run member
	 * whose block children are hoisted out and laid out beside it, so its
	 * own box measures one line however many rows they paint.
	 */
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

	/**
	 * The laid-out extent of a box's content -- what scrollWidth/scrollHeight
	 * report and scroll offsets clamp against: the farthest right/bottom edge
	 * any child box reaches, measured from the padding-box origin, plus the
	 * padding on that end, floored at the client size. Children keep their
	 * natural heights when they overflow a fixed box, so the vertical extent
	 * is readable off the layout tree directly; a measured inline run's leaf
	 * takes the width it was offered, so once one is present the horizontal
	 * extent is unknowable and reported null -- callers must not clamp
	 * against an answer that does not exist. Null overall for an element the
	 * tree does not decompose into child boxes at all (an inline, a run
	 * member, a leaf of its own).
	 */
	scrollExtentOf(
		element: Element,
	): {width: number | null; height: number} | null {
		const flexNode = this[kNodeMap].get(element);
		if (!flexNode || flexNode.measureFunc !== null) {
			return null;
		}
		const box = getBoxModel(element);
		let right: number | null = 0;
		let bottom = 0;
		for (const child of flexNode.children) {
			// A display:none placeholder holds its slot with a stale layout.
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
			flexNode.getComputedWidth() -
			(box.borderLeftWidth || 0) -
			(box.borderRightWidth || 0);
		const clientHeight =
			flexNode.getComputedHeight() -
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

	/** The border-box size offsetWidth/offsetHeight report, rounded. */
	offsetSize(element: Element): {width: number; height: number} {
		const rect = layoutRect(this, element);
		return {
			width: Math.round(rect?.width ?? 0),
			height: Math.round(rect?.height ?? 0),
		};
	}

	/** The offsetParent-relative position offsetTop/offsetLeft report. */
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

	/**
	 * What offsetTop and offsetLeft are measured from: the nearest positioned
	 * ancestor, else the body. Walks the live DOM tree, not the box tree -- a
	 * separate concern from where the boxes ended up.
	 */
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
		const body = this[kEngineWindow].document.body ?? null;
		return body === element ? null : body;
	}

	/** The content+padding size clientWidth/clientHeight report. */
	clientSize(element: Element): {width: number; height: number} {
		const box = contentBoxSize(this, element);
		return {
			width: Math.round(box?.width ?? 0),
			height:
				isRootBox(this, element)
					// The terminal is the viewport, and the root it was laid
					// out at is where that size is held.
					? this[kViewportRoot].style.height.value
					: Math.round(box?.height ?? 0),
		};
	}

	/**
	 * The size scrollWidth/scrollHeight report: the content's laid-out
	 * extent. A box whose content the tree does not decompose into child
	 * boxes (an inline, a run member) has no readable extent and falls back
	 * to its client size, exact for the no-overflow case.
	 */
	scrollSize(element: Element): {width: number; height: number} {
		const extent = element.isConnected ? this.scrollExtentOf(element) : null;
		const box = contentBoxSize(this, element);
		return {
			width: extent?.width ?? Math.round(box?.width ?? 0),
			height:
				isRootBox(this, element)
					? documentContentHeight(this)
					: (extent?.height ?? Math.round(box?.height ?? 0)),
		};
	}

	/**
	 * How far a box may be scrolled along an axis: how much its content
	 * overflows the port it shows through, floored at zero. An axis whose
	 * overflow is visible does not scroll and pins to 0; hidden scrolls
	 * programmatically, as in a browser. Null where the layout cannot name
	 * the extent (a box whose content is one opaque measured run), which is
	 * not an answer to clamp against.
	 */
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
		return scrollsAt(overflow) ? Math.max(0, room) : 0;
	}

	/**
	 * Reveal an element in every scroll box between it and the document,
	 * innermost first -- each scroll moves the element in every outer port's
	 * coordinates, so the rect is re-read per level. What remains is the
	 * screen's, which the engine behind the document reveals.
	 */
	revealInScrollPorts(element: Element): void {
		for (
			let ancestor = flatParentElement<Element>(element);
			ancestor && !isRootBox(this, ancestor);
			ancestor = flatParentElement<Element>(ancestor)
		) {
			const overflow = getComputedValue(ancestor, "overflow");
			if (
				scrollsAt(getComputedValue(ancestor, "overflow-y") || overflow) ||
				scrollsAt(getComputedValue(ancestor, "overflow-x") || overflow)
			) {
				revealInPort(this, element, ancestor);
			}
		}
	}

	/**
	 * The rows an element's painted position is shifted up by its scrolled
	 * ancestors -- the same walk absolutePosition subtracts, minus the
	 * element's own box. Paint extents are cached in unscrolled layout rows,
	 * so band culling of a scrolled subtree compares against the band moved
	 * by this amount rather than recomputing extents per scroll.
	 */
	scrolledAncestorRows(element: Element): number {
		const flexNode = this[kNodeMap].get(element) ?? runFlexNode(this, element);
		if (!flexNode) {
			return 0;
		}
		const document = this[kEngineWindow].document;
		const root = document.documentElement;
		const body = document.body;
		let rows = 0;
		for (
			let current = flexNode.parent;
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
		const display = computedDisplay(element);

		// A display:none element generates no box, so there is no geometry to
		// report -- the layout node it keeps is a placeholder holding its slot
		// among its container's children, not a box. Its client rects are empty
		// and its resolved values are the computed ones (CSSOM View §4).
		if (display === "none") {
			return null;
		}

		// A blockified box's box is the one the layout tree sized, not the
		// extent of the text it happens to hold: its layout node is the truth,
		// and the run machinery below would report the text union instead. It
		// has a layout node to be the truth only once one has been built, so
		// the two conditions are separate.
		const blockified = wasBlockified(element) && this[kNodeMap].has(element);

		if (!blockified && isInlineDisplay(display)) {
			if (isAtomicInline(display)) {
				const rect = inlineBlockRect(this, element);
				if (rect) {
					return rect;
				}
			}

			const rectTexts = getRectTexts(this, element);
			if (rectTexts.length > 0) {
				return unionRects(this, rectTexts.map((rectText) => rectText.rect));
			}

			// A pure inline element with no text of its own has no inline box to
			// report -- a browser gives a zero-width rect at the position it
			// would occupy. The block fallback below instead returns the layout
			// node's width, which for an empty inline is its containing block's,
			// so `<div style="width:30ch"><span></span></div>` measured the span
			// at 30 columns. inline-block keeps the fallback: its node IS its box.
			if (display === "inline") {
				const elementFlexNode = runFlexNode(this, element);
				if (elementFlexNode) {
					const position = absolutePosition(this, elementFlexNode);
					return new this[kDOMRect](position.x, position.y, 0, 0);
				}
				// An empty inline that does not OPEN its run has no layout node
				// of its own, and it still has a place: the cursor the line had
				// reached when it got there. Reporting null instead put every
				// one of them at the viewport origin -- the `span` in
				// `<div>ab<span></span>cd</div>` answered 0 rather than 2.
				const run = getBox(this, element);
				if (run?.layoutNode) {
					const origin = absolutePosition(this, run.layoutNode);
					const cursor = inlineCursorBefore(run, element);
					return new this[kDOMRect](
						origin.x + cursor.x,
						origin.y + cursor.y,
						0,
						0,
					);
				}
				// No layout node and no run means the element was removed or
				// never laid out -- null, as the block fallback below reports.
				return null;
			}
		}

		// Fall back to the layout node for block elements and containers -- or,
		// for an inline-block whose own segment is unreadable, to the box that
		// measures the run it opens.
		const flexNode = this[kNodeMap].get(element) ?? runFlexNode(this, element);

		if (!flexNode) {
			return null;
		}

		const {x, y} = documentPosition(this, element, flexNode);

		return new this[kDOMRect](
			x,
			y,
			flexNode.getComputedWidth(),
			flexNode.getComputedHeight(),
		);
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
		return getRectTexts(this, node).map((rectText) => rectText.rect);
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
	getRangeRects(range: Range): DOMRect[] {
		if (!range.collapsed) {
			return this.getRangeRuns(range).map((run) => run.rect);
		}
		const rects: DOMRect[] = [];
		for (const textNode of rangeTextNodes(this, range)) {
			const caret = caretRect(
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

	/**
	 * The selected runs a Range covers -- each contiguous painted run as a rect
	 * and its raw text -- across every text node it spans. The text lets a
	 * caller repaint the run in the selection style; `getRangeRects` is this
	 * without the text, for the public `Range` API.
	 */
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
				runs.push(...selectionRuns(this, textNode, from, to));
			}
		}
		return runs;
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
		for (const rectText of getRectTexts(this, textNode)) {
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
				rect: new this[kDOMRect](last.x, last.y + last.height, 0, last.height),
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
				// An empty line is a caret slot in a control's value (a blank
				// line in a textarea is clickable); in document text it renders
				// nothing and owns no position.
				if (!clampToNearestLine && fragment.endOffset <= fragment.startOffset) {
					continue;
				}
				const found = offsetInFragment(textNode, whiteSpace, fragment, x);
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
		const found = offsetInFragment(
			nearest.node,
			getWhiteSpace(nearest.node),
			nearest.fragment,
			x,
		);
		return {node: nearest.node, offset: found.offset};
	}

	/**
	 * Whether an element establishes a stacking context: the paint-atomic unit
	 * of CSS layering. Terminal-relevant predicate: positioned with a non-auto
	 * z-index. The root context belongs to <body>, the paint root. (opacity/
	 * transform/filter have no terminal meaning here.)
	 */
	formsStackingContext(element: Element): boolean {
		if (element === this[kEngineWindow].document.body) {
			return true;
		}
		if (
			getComputedValue(element, "isolation") === "isolate"
		) {
			return true;
		}
		return isPositioned(element) && getZIndexValue(element) !== "auto";
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
		const body = this[kEngineWindow].document?.body;
		if (!body) {
			return layers;
		}
		for (const element of this[kPositionedElements]) {
			if (!element.isConnected || element === body) {
				continue;
			}
			if (topLayer.has(element)) {
				continue;
			} // painted above everything
			// The registry is a superset: re-ask before believing membership.
			if (!isPositioned(element)) {
				continue;
			}
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
			const z = getZIndexValue(element);
			if (z === "auto" || z === 0) {
				bucket.zero.push(element);
			} else if (z < 0) {
				bucket.neg.push(element);
			} else {
				bucket.pos.push(element);
			}
		}
		const treeOrder = (a: Element, b: Element) =>
			a.compareDocumentPosition(b) & 4 ? -1 : 1; // 4: b follows a
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
		const document = this[kEngineWindow].document;
		if (!document?.body) {
			return null;
		}
		// Painting starts at the body, whose box covers everything in flow --
		// unless the body generates no box of its own, and the box its content
		// is laid out in is the root element's.
		const paintRoot =
			root === document.documentElement &&
			!dissolvesIntoChildren(document.body)
				? document.body
				: root;
		for (const element of [...topLayer].reverse()) {
			if (!flatIsConnected(element)) {
				continue;
			}
			const hit = hitTestContext(this, element, x, y, layers, cameraScrollTop);
			if (hit) {
				return hit;
			}
		}
		return hitTestContext(this, paintRoot, x, y, layers, cameraScrollTop);
	}

	/**
	 * Note that something a frame is derived from has moved. The caches the
	 * engine derives a frame from -- the box enumerations, the resolved
	 * geometry -- are stale from here on, and the next frame has something to
	 * paint.
	 *
	 * Mutation records come through the shell's observer drain, which calls
	 * this once per batch; the cascade calls it for the style changes no
	 * record describes.
	 */
	invalidateFrame(): void {
		changed(this);
	}

	/**
	 * Note that boxes must be rebuilt: one node's, or -- with no node in
	 * particular -- every derivation this engine holds.
	 *
	 * A node re-enumerates its whole subtree, because run membership may have
	 * moved: the invalidated node could be, or displace, a run head, and a
	 * restyle inside the subtree can change any descendant's display and with
	 * it the boxes its container holds. That is what the invalidation is about
	 * to rebuild anyway.
	 *
	 * No node means an UNBOUNDED change -- a stylesheet reparse, a shadow
	 * attachment, a pseudo-element change, the bidi reorder flip. Which boxes
	 * a container has can have moved anywhere, so the record of which ones are
	 * derived is dropped whole.
	 */
	invalidate(node?: Node): void {
		if (node === undefined) {
			this[kDerivedContainers] = new WeakSet<Element>();
			this.invalidateFrame();
			return;
		}
		restageSubtree(this, node);
		invalidateNode(this, node);
		changed(this);
	}

	handleMutations(mutations: MutationRecord[]): void {
		for (const record of mutations) {
			restageForRecord(this, record);
		}
	}

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
		this[kRestyled].add(element);
		changed(this);
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
			if (getPosition(el) === "fixed") {
				return true;
			}
		}
		return false;
	}
}

/**
 * z-index only means anything on a positioned box; "auto" stays distinct from 0
 * -- auto paints in the same layer but does NOT form a context.
 */
function getZIndexValue(element: Element): number | "auto" {
	const zIndex = getComputedValue(element, "z-index");
	if (!zIndex || zIndex === "auto") {
		return "auto";
	}
	const value = parseInt(zIndex, 10);
	return Number.isFinite(value) ? value : "auto";
}

/**
 * Whether blockification actually moved this element: it asked to be
 * inline-level and was made block-level anyway. The two displays disagree here
 * and nowhere else, so this is the one place a caller has to care which it
 * holds -- everywhere else, go through the doors below.
 */
function wasBlockified(element: Element): boolean {
	return isInlineDisplay(computedDisplay(element)) && blockifies(element);
}

/** The smallest rect enclosing a set: the box a broken inline reports. */
function unionRects(
	layout: LayoutEngine,
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
	layout: LayoutEngine,
): void {
	// A box outlives the nodes that pass through it, but not its container.
	for (const box of [...layout[kAnonymousBoxes].values()]) {
		if (!flatIsConnected(box.container)) {
			retireAnonymousBox(layout, box);
		}
	}
	for (const [node, flexNode] of layout[kNodeMap]) {
		if (node === layout[kRootElement] || flatIsConnected(node)) {
			continue;
		}

		const parent = flexNode.parent;
		if (parent) {
			parent.removeChild(flexNode);
		}

		layout[kMeasureNodes].delete(flexNode);
		flexNode.freeRecursive();
		untrackNode(layout, node);
		layout[kInvalidatedNodes].delete(node);
	}
}

/**
 * Dirty what measures each restyled element, and restage the enumerations
 * that decide which box that is.
 *
 * Nothing here builds or rebuilds a box. A restyle says only that the boxes
 * around an element may no longer be the ones its container's enumeration
 * names, and that whatever measured it measured it under a style that is
 * gone; what kind of box it now generates, what styles sit on it and what it
 * holds are derived where every box is derived, from the enumeration.
 */
function applyRestyles(
	layout: LayoutEngine,
): void {
	while (layout[kRestyled].size > 0) {
		const restyled = [...layout[kRestyled]];
		layout[kRestyled].clear();
		for (const element of restyled) {
			if (!flatIsConnected(element)) {
				continue;
			}
			// The element's own box may move between runs, and so may the
			// boxes of its children.
			restageBox(layout, element);
			restageChildren(layout, element);
			invalidateEnclosingMeasure(layout, element);
			if (layout[kBoxes].get(element)?.children) {
				invalidateContainerBoxes(layout, element);
				// The children of a flex container are each a box of their
				// own, blockified (css-display-3 §2.7), where a block
				// container gathers the inline ones into anonymous boxes it
				// shares -- so an element that becomes one, or stops being
				// one, holds a different set of boxes than it did.
				layout[kDirtyRunContainers].add(element);
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
function restageForRecord(
	layout: LayoutEngine,
	record: MutationRecord,
): void {
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
		restageBox(layout, target);
		restageChildren(layout, target as Element);
		if (record.attributeName === "slot") {
			// Reassigning a slot moves the node in the COMPOSED tree while
			// the light tree stands still -- no childList record will ever
			// arrive, and the container it left is not reachable from where
			// it now sits. The host's whole composed subtree re-enumerates;
			// slot reassignment is rare enough for the hammer.
			const host = (target as Element).parentElement;
			if (host && getShadowRoot<ShadowRoot>(host)) {
				restageSubtree(layout, host);
			}
		}
		return;
	}
	if (record.type === "characterData") {
		restageBox(layout, target);
		invalidateEnclosingMeasure(layout, target);
		return;
	}
	// Added and removed nodes both change the container's run structure --
	// including the runs on either side of a block that left or arrived.
	// The removed nodes are already detached, so the container is reached
	// through the target rather than through them.
	if (target.nodeType === target.ELEMENT_NODE) {
		restageChildren(layout, target as Element);
	}
	// A member gaining or losing a descendant is not a change to any
	// container's box list: the member is still there, holding more or
	// less. Nothing about the space the box measuring it was offered says
	// so, so that box is told directly.
	invalidateEnclosingMeasure(layout, target);
	for (const node of record.addedNodes) {
		restageSubtree(layout, node);
	}
}

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
function inlineBlockRect(
	layout: LayoutEngine,
	element: Element,
): DOMRect | null {
	// Climb to the nearest enclosing run that was actually laid out on its
	// own: a run measured inside an inline-block publishes no break result
	// (it hangs off that box's leaf instead), and its head may still be
	// holding a flex node left over from before it was absorbed -- one
	// parked at 0,0.
	// The climb goes OUTWARD. A box's position is read out of the run that
	// PLACED it, never out of a run inside it: the box's own content is
	// positioned relative to the box, so a run in there answers with the
	// coordinates of the very frame being resolved. An enumeration read
	// before a mutation is reconciled still describes the tree as it stood,
	// and can name a head that has since moved in here; following it walks
	// in a circle. This is also what keeps documentPosition's host search
	// out of one -- the host of a box is never the box, so a run head from
	// out here is never laid out under the content root of the box itself.
	const outward = (node: Node): boolean => {
		for (
			let current: Node | null = node;
			current;
			current = boxParentElement(current)
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
	let headFlexNode = runFlexNode(layout, runHead);
	let breakResult = runBreakResult(layout, runHead);
	while (runHead && !(headFlexNode && breakResult)) {
		const parent = boxParentElement(runHead);
		if (!parent) {
			return null;
		}
		runHead = headOutside(parent) ?? parent;
		headFlexNode = runFlexNode(layout, runHead);
		breakResult = runBreakResult(layout, runHead);
	}
	if (!runHead || !headFlexNode || !breakResult) {
		return null;
	}

	const runPosition = documentPosition(layout, runHead, headFlexNode);
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
		if (ancestor === runHead) {
			break;
		}
	}
	let descended = false;
	for (const ancestor of enclosing) {
		if (!establishesContentRoot(ancestor)) {
			continue;
		}
		const hop = findInlineBlockSegment(breakResult, ancestor);
		if (!hop) {
			continue;
		}
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
	if (!target) {
		return null;
	}

	// Only the run that owns the box can speak for its position. Once the
	// walk descends into a nested measurement, any flex node the box still
	// holds belongs to a layout it is no longer part of.
	const ownFlexNode = descended ? undefined : runFlexNode(layout, element);
	if (ownFlexNode) {
		const {x, y} = documentPosition(layout, element, ownFlexNode);
		return new layout[kDOMRect](x, y, target.segment.width, target.line.height);
	}
	return new layout[kDOMRect](
		originX + target.segment.x,
		originY + target.line.y,
		target.segment.width,
		target.line.height,
	);
}

/** The text nodes a range covers, in document order. */
function rangeTextNodes(
	layout: LayoutEngine,
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
	const walker = layout[kEngineWindow].document.createTreeWalker(
		root,
		layout[kEngineWindow].NodeFilter.SHOW_TEXT,
	);
	let node: Node | null;
	while ((node = walker.nextNode())) {
		if (range.intersectsNode(node)) {
			nodes.push(node as Text);
		}
	}
	return nodes;
}

/** A zero-width caret rect at a data offset within a text node. */
function caretRect(
	layout: LayoutEngine,
	textNode: Text,
	offset: number,
): DOMRect | null {
	const lines = layout.lineFragments(textNode);
	if (lines.length === 0) {
		return null;
	}
	// The line owning the caret: the first whose end it does not pass, but a
	// caret exactly on a soft-wrap boundary belongs to the next line's start.
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
	// The cells between the line's first character and the caret: the data
	// up to the offset, rendered the way the line renders it.
	const before = renderTextFragment(
		textNode.data,
		getWhiteSpace(textNode),
		line.startOffset,
		Math.max(line.startOffset, Math.min(offset, line.endOffset)),
	);
	const x = Math.round(line.rect.x) + stringWidth(before);
	return new layout[kDOMRect](x, Math.round(line.rect.y), 0, line.rect.height);
}

/**
 * Where a column falls within one painted line: the data offset under it,
 * and how far outside the line's own cells the column was -- zero when the
 * point landed on the line, which is what picks between two lines painted
 * on the same row.
 */
function offsetInFragment(
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
		const width = stringWidth(text[index]);
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
function selectionRuns(
	layout: LayoutEngine,
	textNode: Text,
	from: number,
	to: number,
): Array<{rect: DOMRect; text: string}> {
	const runs: Array<{rect: DOMRect; text: string}> = [];
	const whiteSpace = getWhiteSpace(textNode);
	for (const fragment of layout.lineFragments(textNode)) {
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
					stringWidth(text.slice(0, runStart));
				const width = stringWidth(text.slice(runStart, i));
				runs.push({
					rect: new layout[kDOMRect](
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

function hitTestContext(
	layout: LayoutEngine,
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
		const probeY = layout.isInFixedSpace(element) ? y - cameraScrollTop : y;
		return layout.formsStackingContext(element)
			? hitTestContext(layout, element, x, probeY, layers, cameraScrollTop)
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

// The breaker's own fragments, processed text and all: an inline box's
// lines as the line breaker produced them. Nothing outside layout may
// reason about processed text -- geometry consumers read `getRects`,
// `getRangeRects` or `lineFragments`, whose fragments carry data offsets
// a consumer can render for itself.
function getRectTexts(layout: LayoutEngine, node: Node): RectText[] {
	if (node.nodeType === node.ELEMENT_NODE) {
		const element = node as Element;
		const display = computedDisplay(element);

		if (!isInlineDisplay(display)) {
			return [];
		}

		// An inline broken around a block-level box is a member of no run:
		// its container lays out the fragments on either side as boxes of
		// its own (CSS2 §9.2.1.1). Its fragments are what its inline-level
		// content occupies, which each know the run they sit on; the block
		// between them belongs to the container, not to the inline.
		if (splitsAroundBlock(element)) {
			const fragments: RectText[] = [];
			const walk = (parent: Element): void => {
				for (const child of Array.from(parent.childNodes) as Node[]) {
					if (child.nodeType === child.TEXT_NODE) {
						fragments.push(...getRectTexts(layout, child));
					} else if (
						child.nodeType === child.ELEMENT_NODE &&
						// The USED display: a child out of flow lays out
						// against its containing block, and its box is no part
						// of the fragments this inline was broken into.
						isInlineDisplay(usedDisplay(child as Element))
					) {
						walk(child as Element);
					}
				}
			};
			walk(element);
			return fragments;
		}

		// An inline-block asked for directly: the run it heads holds its own box
		// as one segment, and the text to report is in the break result nested
		// under that segment's leaf.
		if (
			isAtomicInline(display) &&
			getBoxEntry(layout, element)?.head === element
		) {
			const breakResult = runBreakResult(layout, element);
			if (breakResult) {
				const rectTexts: RectText[] = [];
				const flexNode = runFlexNode(layout, element);
				if (!flexNode) {
					return [];
				}

				const position = documentPosition(layout, element, flexNode);
				const containerX = position.x;
				const containerY = position.y;

				for (const line of breakResult.lines) {
					for (const segment of line.segments) {
						if (
							segment.leaf.type === "inline-block" &&
							segment.leaf.node === element &&
							segment.leaf.breakResult
						) {
							// Content starts after border AND padding -- the border
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

	const flexNode = runFlexNode(layout, runHead);
	if (!flexNode) {
		return [];
	}

	let {x: containerX, y: containerY} = documentPosition(
		layout,
		runHead,
		flexNode,
	);

	// documentPosition gives the run head's BORDER box. A blockified
	// inline flex item reserved its own padding and border in that box (see
	// styleFlexNode's parentIsFlex exception) but its text ignored them,
	// painting at the border edge instead of below the padding. Push the run
	// in by that box. Scoped to exactly the blockified case: a normal inline
	// has its flex-node box model cleared even when the author declared
	// padding (so getBoxModel would over-report), an inline-block's content
	// offset is already handled by documentPosition, and a block's
	// run head is a text node with no box.
	if (runHead.nodeType === runHead.ELEMENT_NODE) {
		const runHeadElement = runHead as Element;
		if (
			computedDisplay(runHeadElement) === "inline" &&
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

		if (establishesContentRoot(parent)) {
			// An overflow-scrolled inline-block (a field's windowed value,
			// scrollLeft set by the caret-follow) shifts its content by its
			// own scroll, so the caret stays in view. A property of the box,
			// independent of whether its segment is found below.
			accumulatedOffsetX -= (parent as Element).scrollLeft || 0;
			accumulatedOffsetY -= (parent as Element).scrollTop || 0;
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

	// position:relative on an inline RUN MEMBER (no flex node of its own)
	// shifts its painted fragments; walk the box-less ancestors up to the
	// run head accumulating offsets.
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

	// The break result's text index: which line each text node's fragments
	// landed on, at what x, in what order. Built once per break result and
	// keyed on the result object itself, so a re-break (always a fresh
	// object) invalidates it for free. Without it every text node's lookup
	// scanned every segment of its run -- painting a run of N boxes cost
	// O(N^2) segment visits per frame.
	const index = breakResultTextIndex(layout, breakResult);

	// Merge fragments per line that belong to this node, in segment order.
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

/**
 * The single place that decides "is this element in the document, and what is
 * its border-box rect" -- so offsetWidth and clientWidth can never quietly
 * disagree about which rect they mean. Unrounded: each reader rounds for its
 * own purpose (offsetTop rounds the *difference* of two rects; rounding here
 * first would double-round and drift by a cell).
 */
/** The document content's laid-out height: the body's border-box, whole. */
function documentContentHeight(engine: LayoutEngine): number {
	const bodyRect = engine.getRect(engine[kRootElement].ownerDocument?.body);
	return bodyRect ? Math.ceil(bodyRect.height) : 0;
}

/**
 * The content+padding box: the border-box rect minus the border widths, which
 * both clientWidth/Height and scrollWidth/Height report.
 */
function contentBoxSize(
	engine: LayoutEngine,
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

/**
 * html and body scroll the document itself: their scroll height is the
 * document's and their client height the terminal's. One viewport, however it
 * is reached.
 */
function isRootBox(engine: LayoutEngine, element: Element): boolean {
	const document = engine[kEngineWindow].document;
	return element === document.documentElement || element === document.body;
}

/**
 * Move one scroll box so the element sits inside it. Document-relative rects
 * on both sides: the element wherever its current offsets put it, against the
 * scroller's padding box -- what the scroller actually shows.
 */
function revealInPort(
	engine: LayoutEngine,
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

/** Whether an overflow value scrolls, programmatically or by hand. */
function scrollsAt(overflow: string): boolean {
	return overflow === "auto" || overflow === "scroll" || overflow === "hidden";
}

/**
 * Announce that what this engine reports may differ from a moment ago: the
 * cascade's used values are stale, and the frame the screen last painted no
 * longer describes the layout. Every entry that moves geometry says so; the
 * pass itself moves nothing that was not announced first, which is what
 * lets a frame that ran a pass and found nothing changed skip its paint.
 */
function changed(layout: LayoutEngine): void {
	const document = layout[kRootElement].ownerDocument;
	if (document === null) {
		return;
	}
	usedValuesChanged(document);
	termDOMOf(document)?.[kScreen].invalidateLayout();
}
