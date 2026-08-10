/**
 * A pure-JS CSS flexbox implementation over an integer cell grid.
 *
 * This replaces yoga-layout (WASM/native). It implements CSS Flexible Box
 * Layout (CSS Box Alignment / css-flexbox-1) directly from the spec, and
 * exposes the subset of Yoga's node API that LayoutEngine actually calls.
 *
 * Deliberately omitted, because termdom does not use them: RTL/bidi, writing
 * modes, aspect-ratio, gap, baseline alignment, overflow:scroll semantics, and
 * sub-cell scaling (pointScaleFactor is always 1 -- the grid is integer cells).
 *
 * Undefined values are represented as NaN throughout, matching the convention
 * that "undefined" is a distinct state from 0.
 */

// ---------------------------------------------------------------------------
// Constants
//
// Names mirror Yoga's because LayoutEngine looks some of them up dynamically by
// string (e.g. "ALIGN_" + "space-between".toUpperCase()), so the full enum sets
// must exist, not just the ones referenced statically.
// ---------------------------------------------------------------------------

export const ALIGN_AUTO = 0;
export const ALIGN_FLEX_START = 1;
export const ALIGN_CENTER = 2;
export const ALIGN_FLEX_END = 3;
export const ALIGN_STRETCH = 4;
export const ALIGN_BASELINE = 5;
export const ALIGN_SPACE_BETWEEN = 6;
export const ALIGN_SPACE_AROUND = 7;
export const ALIGN_SPACE_EVENLY = 8;

export const JUSTIFY_FLEX_START = 0;
export const JUSTIFY_CENTER = 1;
export const JUSTIFY_FLEX_END = 2;
export const JUSTIFY_SPACE_BETWEEN = 3;
export const JUSTIFY_SPACE_AROUND = 4;
export const JUSTIFY_SPACE_EVENLY = 5;

export const WRAP_NO_WRAP = 0;
export const WRAP_WRAP = 1;
export const WRAP_WRAP_REVERSE = 2;

export const FLEX_DIRECTION_COLUMN = 0;
export const FLEX_DIRECTION_COLUMN_REVERSE = 1;
export const FLEX_DIRECTION_ROW = 2;
export const FLEX_DIRECTION_ROW_REVERSE = 3;

export const GUTTER_COLUMN = 0;
export const GUTTER_ROW = 1;
export const GUTTER_ALL = 2;

export const DISPLAY_FLEX = 0;
export const DISPLAY_NONE = 1;
export const DISPLAY_TABLE = 3;
export const DISPLAY_TABLE_ROW_GROUP = 4;
export const DISPLAY_TABLE_HEADER_GROUP = 5;
export const DISPLAY_TABLE_FOOTER_GROUP = 6;
export const DISPLAY_TABLE_ROW = 7;
export const DISPLAY_TABLE_CELL = 8;
export const DISPLAY_TABLE_CAPTION = 9;

export const POSITION_TYPE_STATIC = 0;
export const POSITION_TYPE_RELATIVE = 1;
export const POSITION_TYPE_ABSOLUTE = 2;

export const MEASURE_MODE_UNDEFINED = 0;
export const MEASURE_MODE_EXACTLY = 1;
export const MEASURE_MODE_AT_MOST = 2;

export const EDGE_LEFT = 0;
export const EDGE_TOP = 1;
export const EDGE_RIGHT = 2;
export const EDGE_BOTTOM = 3;
export const EDGE_START = 4;
export const EDGE_END = 5;
export const EDGE_HORIZONTAL = 6;
export const EDGE_VERTICAL = 7;
export const EDGE_ALL = 8;

export const UNIT_UNDEFINED = 0;
export const UNIT_POINT = 1;
export const UNIT_PERCENT = 2;
export const UNIT_AUTO = 3;

export type Align = number;
export type Justify = number;
export type Wrap = number;
export type FlexDirection = number;
export type Display = number;
export type PositionType = number;
export type MeasureMode = number;
export type Edge = number;

export interface Size {
	width: number;
	height: number;
}

/**
 * What a measure function reports: the size, and whatever else that
 * measurement produced. A measurement of text also decides where its lines
 * break, and those lines belong to the size they produced -- so they travel
 * with it into the layout cache and come back out with it, rather than being
 * left somewhere for the caller to find.
 */
export interface MeasureResult extends Size {
	payload?: unknown;
}

export type MeasureFunction = (
	width: number,
	widthMode: MeasureMode,
	height: number,
	heightMode: MeasureMode,
) => MeasureResult;

/**
 * Where an out-of-flow box would have sat had it stayed in flow: the origin of
 * CSS 2 §10.3.7's hypothetical box, in the containing block's border-box
 * coordinates. Only the flow the box left knows this, so the owner of that
 * flow supplies it; null means it has no static position to offer, and the
 * containing block's own alignment places the box instead.
 */
export type StaticPositionFunction = (
	containingBlock: Node,
) => {left: number; top: number} | null;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

interface Value {
	unit: number;
	value: number;
}

const UNDEFINED_VALUE: Value = {unit: UNIT_UNDEFINED, value: NaN};
const AUTO_VALUE: Value = {unit: UNIT_AUTO, value: NaN};

/**
 * Coerce a setter argument into a Value. Accepts numbers (points), percent
 * strings like "50%" or "0%", undefined/NaN (undefined), and "auto".
 */
function toValue(input: number | string | undefined | null): Value {
	if (input === undefined || input === null) return UNDEFINED_VALUE;
	if (typeof input === "number") {
		return Number.isNaN(input)
			? UNDEFINED_VALUE
			: {unit: UNIT_POINT, value: input};
	}
	const trimmed = input.trim();
	if (trimmed === "auto") return AUTO_VALUE;
	if (trimmed.endsWith("%")) {
		const parsed = parseFloat(trimmed.slice(0, -1));
		return Number.isNaN(parsed)
			? UNDEFINED_VALUE
			: {unit: UNIT_PERCENT, value: parsed};
	}
	const parsed = parseFloat(trimmed);
	return Number.isNaN(parsed)
		? UNDEFINED_VALUE
		: {unit: UNIT_POINT, value: parsed};
}

/** Resolve a Value against an owner size. Returns NaN when unresolvable. */
function resolveValue(value: Value, ownerSize: number): number {
	switch (value.unit) {
		case UNIT_POINT:
			return value.value;
		case UNIT_PERCENT:
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
	if (value.unit === UNIT_AUTO) return 0;
	const resolved = resolveValue(value, ownerWidth);
	return isDefined(resolved) ? resolved : 0;
}

// ---------------------------------------------------------------------------
// Axis helpers
// ---------------------------------------------------------------------------

function isRow(axis: FlexDirection): boolean {
	return axis === FLEX_DIRECTION_ROW || axis === FLEX_DIRECTION_ROW_REVERSE;
}

function isColumn(axis: FlexDirection): boolean {
	return (
		axis === FLEX_DIRECTION_COLUMN || axis === FLEX_DIRECTION_COLUMN_REVERSE
	);
}

function isReverse(axis: FlexDirection): boolean {
	return (
		axis === FLEX_DIRECTION_ROW_REVERSE ||
		axis === FLEX_DIRECTION_COLUMN_REVERSE
	);
}

function crossAxis(axis: FlexDirection): FlexDirection {
	return isRow(axis) ? FLEX_DIRECTION_COLUMN : FLEX_DIRECTION_ROW;
}

function leadingEdge(axis: FlexDirection): Edge {
	switch (axis) {
		case FLEX_DIRECTION_ROW:
			return EDGE_LEFT;
		case FLEX_DIRECTION_ROW_REVERSE:
			return EDGE_RIGHT;
		case FLEX_DIRECTION_COLUMN:
			return EDGE_TOP;
		default:
			return EDGE_BOTTOM;
	}
}

function trailingEdge(axis: FlexDirection): Edge {
	switch (axis) {
		case FLEX_DIRECTION_ROW:
			return EDGE_RIGHT;
		case FLEX_DIRECTION_ROW_REVERSE:
			return EDGE_LEFT;
		case FLEX_DIRECTION_COLUMN:
			return EDGE_BOTTOM;
		default:
			return EDGE_TOP;
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
	display: Display;

	/** Gaps between items: [column, row]. */
	gap: number[];

	/** Table cell spans. 1 unless set; only meaningful on a table-cell. */
	colSpan: number;
	rowSpan: number;
	/** Set on the table itself; collapsed cells share their borders. */
	borderCollapse: boolean;

	flexGrow: number;
	/** CSS order: items lay out in order-modified document order. */
	order: number;
	flexShrink: number;
	flexBasis: Value;

	margin: Value[];
	position: Value[];
	padding: Value[];
	border: number[];

	width: Value;
	height: Value;
	minWidth: Value;
	minHeight: Value;
	maxWidth: Value;
	maxHeight: Value;
}

interface LayoutResult {
	left: number;
	top: number;
	width: number;
	height: number;
	margin: number[];
	padding: number[];
	border: number[];
	computedFlexBasis: number;
	/** css-flexbox-1 §4.5 automatic minimum size, along the parent's main axis. */
	autoMinMain: number;
	lineIndex: number;
}

/**
 * Web (browser) flex defaults, always: flex-direction row, align-content
 * stretch, flex-shrink 1. Yoga's non-web defaults (column, flex-shrink 0) are
 * React Native's; a DOM renderer never wants them.
 */
function createStyle(): Style {
	return {
		flexDirection: FLEX_DIRECTION_ROW,
		justifyContent: JUSTIFY_FLEX_START,
		alignContent: ALIGN_STRETCH,
		alignItems: ALIGN_STRETCH,
		alignSelf: ALIGN_AUTO,
		positionType: POSITION_TYPE_RELATIVE,
		flexWrap: WRAP_NO_WRAP,
		display: DISPLAY_FLEX,

		gap: [0, 0],

		colSpan: 1,
		rowSpan: 1,
		borderCollapse: false,

		flexGrow: NaN,
		order: 0,
		flexShrink: NaN,
		flexBasis: AUTO_VALUE,

		margin: [
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
		],
		position: [
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
		],
		padding: [
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
			UNDEFINED_VALUE,
		],
		border: [0, 0, 0, 0],

		width: AUTO_VALUE,
		height: AUTO_VALUE,
		minWidth: UNDEFINED_VALUE,
		minHeight: UNDEFINED_VALUE,
		maxWidth: UNDEFINED_VALUE,
		maxHeight: UNDEFINED_VALUE,
	};
}

function createLayout(): LayoutResult {
	return {
		left: 0,
		top: 0,
		width: NaN,
		height: NaN,
		margin: [0, 0, 0, 0],
		padding: [0, 0, 0, 0],
		border: [0, 0, 0, 0],
		computedFlexBasis: NaN,
		autoMinMain: NaN,
		lineIndex: 0,
	};
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export class Config {
	pointScaleFactor = 1;

	static create(): Config {
		return new Config();
	}

	setPointScaleFactor(value: number): void {
		this.pointScaleFactor = value;
	}
}

const defaultConfig = new Config();

// ---------------------------------------------------------------------------
// Node
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
	/** What the measure function produced with this size, if one ran. */
	payload: unknown;
}

/**
 * The payload the measure function reported during the layout of the node
 * currently being computed, or NO_PAYLOAD when none ran. layoutNode clears it
 * around each node it computes, so a container -- whose children each clear it
 * again on their way out -- never picks up a descendant's.
 */
const NO_PAYLOAD = Symbol("no payload");
let measuredPayload: unknown = NO_PAYLOAD;

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
 *  - an EXACTLY offer of the size the node last reported: it was asked to be
 *    that big and had already chosen to be;
 *  - an AT_MOST bound over an answer computed under no bound at all -- the
 *    natural size fits inside the bound, so the bound changes nothing;
 *  - a TIGHTER AT_MOST bound than the one already answered, with the answer
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
	if (mode === MEASURE_MODE_EXACTLY && available === cachedComputed) {
		return true;
	}
	if (mode === MEASURE_MODE_AT_MOST) {
		if (cachedMode === MEASURE_MODE_UNDEFINED) {
			return cachedComputed <= available;
		}
		if (cachedMode === MEASURE_MODE_AT_MOST) {
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
	return mode === MEASURE_MODE_AT_MOST && available === 0;
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
	const knownWidth = widthMode === MEASURE_MODE_EXACTLY;
	const knownHeight = heightMode === MEASURE_MODE_EXACTLY;
	if (knownWidth && knownHeight) return 0;
	if (knownWidth)
		return 1 + (isMinContent(heightMode, availableHeight) ? 1 : 0);
	if (knownHeight) return 3 + (isMinContent(widthMode, availableWidth) ? 1 : 0);
	return (
		5 +
		(isMinContent(widthMode, availableWidth) ? 2 : 0) +
		(isMinContent(heightMode, availableHeight) ? 1 : 0)
	);
}

/** See Node#unstackedChildCount. */
function breaksStacking(node: Node): boolean {
	return (
		node.style.positionType !== POSITION_TYPE_STATIC ||
		node.style.display === DISPLAY_NONE
	);
}

export class Node {
	style: Style;
	layout: LayoutResult;
	children: Node[] = [];
	parent: Node | null = null;
	measureFunc: MeasureFunction | null = null;
	staticPositionFunc: StaticPositionFunction | null = null;
	config: Config;
	dirty = true;
	// The vertical span this node's subtree can paint, in absolute document
	// rows -- its own box unioned with every descendant's, which absolutely
	// positioned children can push outside the parent box. Recomputed by
	// computePaintExtents after each layout pass; used for viewport culling.
	// (Text that overflows a fixed-height box is not included: the box is the
	// extent. Auto-height boxes -- the normal case -- always contain theirs.)
	extentTop = 0;
	extentBottom = 0;
	// How many direct children can't be trusted to keep children[] sorted
	// top-to-bottom by extentTop -- incrementally maintained by insertChild/
	// removeChild/setPositionType/setDisplay. Two ways a child breaks that:
	// position:relative/absolute (its own extent can land anywhere -- an
	// offset, or full removal from flow -- regardless of DOM position), or
	// display:none (skipped by flow layout entirely, so its layout.top is
	// never updated from a stale default -- its extent doesn't reflect where
	// it sits in document order, unlike a merely zero-height visible box,
	// which is still correctly slotted). children[] is only guaranteed sorted
	// when this is 0, which is what lets paint-time culling skip straight to
	// the visible range instead of visiting every child to rule it out.
	unstackedChildCount = 0;
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
	cachedMeasures: Array<CachedLayout | null> = new Array(CACHE_SLOT_COUNT).fill(
		null,
	);
	cachedLayout: CachedLayout | null = null;

	/**
	 * What this node's measure function produced alongside the size it was
	 * placed at -- the lines a text run was broken into, for whoever paints it.
	 *
	 * It is read out of the layout cache, so it always describes the box the
	 * node currently has: a sizing probe's product goes into that probe's own
	 * cache slot and is never mistaken for this, and a node whose cached layout
	 * answered this pass hands back the product of the pass that placed it.
	 */
	get measuredPayload(): unknown {
		return this.cachedLayout ? this.cachedLayout.payload : null;
	}

	constructor(config: Config = defaultConfig) {
		this.config = config;
		this.style = createStyle();
		this.layout = createLayout();
	}

	static create(): Node {
		return new Node(defaultConfig);
	}

	static createWithConfig(config: Config): Node {
		return new Node(config);
	}

	// -- tree ---------------------------------------------------------------

	insertChild(child: Node, index: number): void {
		child.parent = this;
		this.children.splice(index, 0, child);
		if (breaksStacking(child)) {
			this.unstackedChildCount++;
		}
		this.#markDirtyUpward();
	}

	removeChild(child: Node): void {
		const index = this.children.indexOf(child);
		if (index !== -1) {
			this.children.splice(index, 1);
			child.parent = null;
			if (breaksStacking(child)) {
				this.unstackedChildCount--;
			}
			this.#markDirtyUpward();
		}
	}

	getParent(): Node | null {
		return this.parent;
	}

	getChildCount(): number {
		return this.children.length;
	}

	/**
	 * This child's position among its siblings, or -1 if it isn't one.
	 * Searches from the tail: callers that just inserted a run of trailing
	 * children (the common case -- appending in document order) ask about the
	 * most recently added one first, which sits at or near the end.
	 */
	getChildIndex(child: Node): number {
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
		this.#markDirtyUpward();
	}

	/** Recompute paint extents for this subtree. See extentTop/extentBottom. */
	computePaintExtents(originTop: number): void {
		const top = originTop + this.layout.top;
		let extentTop = top;
		let extentBottom = top + this.getComputedHeight();
		for (const child of this.children) {
			child.computePaintExtents(top);
			if (child.extentTop < extentTop) extentTop = child.extentTop;
			if (child.extentBottom > extentBottom) extentBottom = child.extentBottom;
		}
		this.extentTop = extentTop;
		this.extentBottom = extentBottom;
	}

	#markDirtyUpward(): void {
		for (let node: Node | null = this; node; node = node.parent) {
			node.dirty = true;
		}
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
		const before = breaksStacking(this);
		this.style.positionType = v;
		this.#updateParentUnstackedCount(before);
		this.markDirty();
	}
	setFlexWrap(v: Wrap): void {
		this.style.flexWrap = v;
		this.markDirty();
	}
	setGap(gutter: number, value: number): void {
		const gap = Number.isFinite(value) ? Math.max(0, value) : 0;
		if (gutter === GUTTER_COLUMN || gutter === GUTTER_ALL) {
			this.style.gap[GUTTER_COLUMN] = gap;
		}
		if (gutter === GUTTER_ROW || gutter === GUTTER_ALL) {
			this.style.gap[GUTTER_ROW] = gap;
		}
		this.markDirty();
	}

	setColSpan(v: number): void {
		this.style.colSpan = Math.max(1, Math.floor(v) || 1);
		this.markDirty();
	}

	setRowSpan(v: number): void {
		this.style.rowSpan = Math.max(1, Math.floor(v) || 1);
		this.markDirty();
	}

	setBorderCollapse(v: boolean): void {
		this.style.borderCollapse = v;
		this.markDirty();
	}

	setDisplay(v: Display): void {
		const before = breaksStacking(this);
		this.style.display = v;
		this.#updateParentUnstackedCount(before);
		this.markDirty();
	}

	/** Keeps the parent's unstackedChildCount correct after a style setter that can flip breaksStacking(this). */
	#updateParentUnstackedCount(before: boolean): void {
		const after = breaksStacking(this);
		if (this.parent && before !== after) {
			this.parent.unstackedChildCount += after ? 1 : -1;
		}
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
	setFlexBasis(v: number | string | undefined): void {
		this.style.flexBasis = toValue(v);
		this.markDirty();
	}
	setFlexBasisPercent(v: number | undefined): void {
		this.style.flexBasis =
			v === undefined ? UNDEFINED_VALUE : {unit: UNIT_PERCENT, value: v};
		this.markDirty();
	}
	setFlexBasisAuto(): void {
		this.style.flexBasis = AUTO_VALUE;
		this.markDirty();
	}

	setWidth(v: number | string | undefined): void {
		this.style.width = toValue(v);
		this.markDirty();
	}
	setWidthPercent(v: number): void {
		this.style.width = {unit: UNIT_PERCENT, value: v};
		this.markDirty();
	}
	setWidthAuto(): void {
		this.style.width = AUTO_VALUE;
		this.markDirty();
	}
	setHeight(v: number | string | undefined): void {
		this.style.height = toValue(v);
		this.markDirty();
	}
	setHeightPercent(v: number): void {
		this.style.height = {unit: UNIT_PERCENT, value: v};
		this.markDirty();
	}
	setHeightAuto(): void {
		this.style.height = AUTO_VALUE;
		this.markDirty();
	}

	setMinWidth(v: number | undefined): void {
		this.style.minWidth = toValue(v);
		this.markDirty();
	}
	setMinWidthPercent(v: number): void {
		this.style.minWidth = {unit: UNIT_PERCENT, value: v};
		this.markDirty();
	}
	setMinHeight(v: number | undefined): void {
		this.style.minHeight = toValue(v);
		this.markDirty();
	}
	setMinHeightPercent(v: number): void {
		this.style.minHeight = {unit: UNIT_PERCENT, value: v};
		this.markDirty();
	}
	setMaxWidth(v: number | undefined): void {
		this.style.maxWidth = toValue(v);
		this.markDirty();
	}
	setMaxWidthPercent(v: number): void {
		this.style.maxWidth = {unit: UNIT_PERCENT, value: v};
		this.markDirty();
	}
	setMaxHeight(v: number | undefined): void {
		this.style.maxHeight = toValue(v);
		this.markDirty();
	}
	setMaxHeightPercent(v: number): void {
		this.style.maxHeight = {unit: UNIT_PERCENT, value: v};
		this.markDirty();
	}

	setMargin(edge: Edge, v: number | undefined): void {
		this.#setEdges(this.style.margin, edge, toValue(v));
		this.markDirty();
	}
	setMarginPercent(edge: Edge, v: number): void {
		this.#setEdges(this.style.margin, edge, {unit: UNIT_PERCENT, value: v});
		this.markDirty();
	}
	setMarginAuto(edge: Edge): void {
		this.#setEdges(this.style.margin, edge, AUTO_VALUE);
		this.markDirty();
	}

	setPadding(edge: Edge, v: number | undefined): void {
		this.#setEdges(this.style.padding, edge, toValue(v));
		this.markDirty();
	}
	setPaddingPercent(edge: Edge, v: number): void {
		this.#setEdges(this.style.padding, edge, {unit: UNIT_PERCENT, value: v});
		this.markDirty();
	}

	setBorder(edge: Edge, v: number | undefined): void {
		const width = v === undefined || Number.isNaN(v) ? 0 : v;
		for (const index of expandEdge(edge)) {
			this.style.border[index] = width;
		}
		this.markDirty();
	}

	setPosition(edge: Edge, v: number | undefined): void {
		this.#setEdges(this.style.position, edge, toValue(v));
		this.markDirty();
	}
	setPositionPercent(edge: Edge, v: number): void {
		this.#setEdges(this.style.position, edge, {unit: UNIT_PERCENT, value: v});
		this.markDirty();
	}
	setPositionAuto(edge: Edge): void {
		this.#setEdges(this.style.position, edge, AUTO_VALUE);
		this.markDirty();
	}

	#setEdges(target: Value[], edge: Edge, value: Value): void {
		for (const index of expandEdge(edge)) {
			target[index] = value;
		}
	}

	// -- computed getters ---------------------------------------------------

	getComputedLeft(): number {
		return this.layout.left;
	}
	getComputedTop(): number {
		return this.layout.top;
	}
	getComputedWidth(): number {
		return isDefined(this.layout.width) ? this.layout.width : 0;
	}
	getComputedHeight(): number {
		return isDefined(this.layout.height) ? this.layout.height : 0;
	}
	getComputedRight(): number {
		return this.layout.left + this.getComputedWidth();
	}
	getComputedBottom(): number {
		return this.layout.top + this.getComputedHeight();
	}

	getComputedLayout(): {
		left: number;
		top: number;
		right: number;
		bottom: number;
		width: number;
		height: number;
	} {
		return {
			left: this.layout.left,
			top: this.layout.top,
			right: this.getComputedRight(),
			bottom: this.getComputedBottom(),
			width: this.getComputedWidth(),
			height: this.getComputedHeight(),
		};
	}

	getFlexDirection(): FlexDirection {
		return this.style.flexDirection;
	}
	getPositionType(): PositionType {
		return this.style.positionType;
	}
	getGap(gutter: number): number {
		return gutter === GUTTER_ROW
			? this.style.gap[GUTTER_ROW]
			: this.style.gap[GUTTER_COLUMN];
	}

	getFlexShrink(): number {
		return resolveFlexShrink(this);
	}

	// -- entry point --------------------------------------------------------

	calculateLayout(ownerWidth: number, ownerHeight: number): void {
		const width = resolveValue(this.style.width, ownerWidth);
		const height = resolveValue(this.style.height, ownerHeight);

		const availableWidth = isDefined(width) ? width : ownerWidth;
		const availableHeight = isDefined(height) ? height : ownerHeight;

		layoutNode(
			this,
			availableWidth,
			availableHeight,
			isDefined(availableWidth) ? MEASURE_MODE_EXACTLY : MEASURE_MODE_UNDEFINED,
			isDefined(availableHeight)
				? MEASURE_MODE_EXACTLY
				: MEASURE_MODE_UNDEFINED,
			ownerWidth,
			ownerHeight,
			true,
		);

		roundToGrid(this, 0, 0);
		this.computePaintExtents(0);
		this.dirty = false;
	}
}

function expandEdge(edge: Edge): number[] {
	switch (edge) {
		case EDGE_LEFT:
		case EDGE_START:
			return [EDGE_LEFT];
		case EDGE_TOP:
			return [EDGE_TOP];
		case EDGE_RIGHT:
		case EDGE_END:
			return [EDGE_RIGHT];
		case EDGE_BOTTOM:
			return [EDGE_BOTTOM];
		case EDGE_HORIZONTAL:
			return [EDGE_LEFT, EDGE_RIGHT];
		case EDGE_VERTICAL:
			return [EDGE_TOP, EDGE_BOTTOM];
		case EDGE_ALL:
			return [EDGE_LEFT, EDGE_TOP, EDGE_RIGHT, EDGE_BOTTOM];
		default:
			return [];
	}
}

// ---------------------------------------------------------------------------
// Resolved style accessors
// ---------------------------------------------------------------------------

function resolveFlexGrow(node: Node): number {
	if (!node.parent) return 0;
	return isDefined(node.style.flexGrow) ? node.style.flexGrow : 0;
}

function resolveFlexShrink(node: Node): number {
	if (!node.parent) return 0;
	if (isDefined(node.style.flexShrink)) return node.style.flexShrink;
	return 1; // web default
}

/** flex-basis: auto falls back to the main-axis size property. */
function resolveFlexBasis(node: Node, mainAxis: FlexDirection): Value {
	const basis = node.style.flexBasis;
	if (basis.unit !== UNIT_AUTO && basis.unit !== UNIT_UNDEFINED) {
		return basis;
	}
	return isRow(mainAxis) ? node.style.width : node.style.height;
}

function alignSelfOf(parent: Node, child: Node): Align {
	return child.style.alignSelf === ALIGN_AUTO
		? parent.style.alignItems
		: child.style.alignSelf;
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
function baselineWithinBorderBox(node: Node, ownerWidth: number): number {
	const contentTop = paddingAndBorderForEdge(node, EDGE_TOP, ownerWidth);

	for (const child of node.children) {
		if (child.style.display === DISPLAY_NONE) continue;
		if (child.style.positionType === POSITION_TYPE_ABSOLUTE) continue;
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
function gapForAxis(node: Node, axis: FlexDirection): number {
	return isRow(axis)
		? node.style.gap[GUTTER_COLUMN]
		: node.style.gap[GUTTER_ROW];
}

function marginForAxis(
	node: Node,
	axis: FlexDirection,
	ownerWidth: number,
): number {
	return (
		resolveMargin(node.style.margin[leadingEdge(axis)], ownerWidth) +
		resolveMargin(node.style.margin[trailingEdge(axis)], ownerWidth)
	);
}

function paddingAndBorderForEdge(
	node: Node,
	edge: Edge,
	ownerWidth: number,
): number {
	const padding = resolveValue(node.style.padding[edge], ownerWidth);
	return (
		(isDefined(padding) ? Math.max(padding, 0) : 0) + node.style.border[edge]
	);
}

function paddingAndBorderForAxis(
	node: Node,
	axis: FlexDirection,
	ownerWidth: number,
): number {
	return (
		paddingAndBorderForEdge(node, leadingEdge(axis), ownerWidth) +
		paddingAndBorderForEdge(node, trailingEdge(axis), ownerWidth)
	);
}

function styleDimIsDefined(
	node: Node,
	axis: FlexDirection,
	ownerSize: number,
): boolean {
	const value = isRow(axis) ? node.style.width : node.style.height;
	if (value.unit === UNIT_AUTO || value.unit === UNIT_UNDEFINED) return false;
	if (value.unit === UNIT_POINT && value.value < 0) return false;
	if (
		value.unit === UNIT_PERCENT &&
		(value.value < 0 || Number.isNaN(ownerSize))
	)
		return false;
	return true;
}

/** Clamp a value to the node's min/max on the given axis. */
function boundAxisWithinMinMax(
	node: Node,
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
	if (isDefined(max) && max >= 0 && bounded > max) bounded = max;
	if (isDefined(min) && min >= 0 && bounded < min) bounded = min;
	return bounded;
}

/** Clamp, then floor at the padding+border so a box never goes below its own chrome. */
function boundAxis(
	node: Node,
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
	node: Node,
	axis: FlexDirection,
	ownerAxisSize: number,
	mode: {value: number; mode: MeasureMode},
): void {
	const max = resolveValue(
		isRow(axis) ? node.style.maxWidth : node.style.maxHeight,
		ownerAxisSize,
	);
	if (!isDefined(max)) return;

	if (
		mode.mode === MEASURE_MODE_EXACTLY ||
		mode.mode === MEASURE_MODE_AT_MOST
	) {
		// A max size caps a size; it does not make it indefinite. Clamping the
		// value but *keeping* the mode is the whole point: downgrading an EXACTLY
		// to AT_MOST here tells the box it is being shrink-wrapped, and a box with
		// no content of its own then collapses to zero instead of taking the size
		// flex just resolved for it.
		mode.value = isDefined(mode.value) ? Math.min(mode.value, max) : max;
	} else {
		// An indefinite size, on the other hand, is genuinely bounded by the max.
		mode.value = max;
		mode.mode = MEASURE_MODE_AT_MOST;
	}
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function setMeasuredDimensions(
	node: Node,
	width: number,
	height: number,
	ownerWidth: number,
	ownerHeight: number,
): void {
	node.layout.width = boundAxis(
		node,
		FLEX_DIRECTION_ROW,
		width,
		ownerWidth,
		ownerWidth,
	);
	node.layout.height = boundAxis(
		node,
		FLEX_DIRECTION_COLUMN,
		height,
		ownerHeight,
		ownerWidth,
	);
}

/** A leaf with a measure function: ask it, within the given constraints. */
function layoutMeasureNode(
	node: Node,
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
		FLEX_DIRECTION_ROW,
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		FLEX_DIRECTION_COLUMN,
		ownerWidth,
	);
	const marginRow = marginForAxis(node, FLEX_DIRECTION_ROW, ownerWidth);
	const marginColumn = marginForAxis(node, FLEX_DIRECTION_COLUMN, ownerWidth);

	const innerWidth = isDefined(availableWidth)
		? Math.max(0, availableWidth - marginRow - paddingBorderRow)
		: NaN;
	const innerHeight = isDefined(availableHeight)
		? Math.max(0, availableHeight - marginColumn - paddingBorderColumn)
		: NaN;

	if (
		widthMode === MEASURE_MODE_EXACTLY &&
		heightMode === MEASURE_MODE_EXACTLY &&
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

	const measured = node.measureFunc!(
		innerWidth,
		widthMode,
		innerHeight,
		heightMode,
	);
	measuredPayload = measured.payload ?? null;

	const width =
		widthMode === MEASURE_MODE_EXACTLY
			? availableWidth - marginRow
			: measured.width + paddingBorderRow;
	const height =
		heightMode === MEASURE_MODE_EXACTLY
			? availableHeight - marginColumn
			: measured.height + paddingBorderColumn;

	// An AT_MOST bound is an upper bound on the *offer*, not a licence to report a
	// smaller box than the content needs. The measure function already fits the
	// content into the offered width wherever it can; when it cannot -- an
	// unbreakable word -- the content genuinely overflows, and clamping here would
	// have the box claim a size it does not occupy. That lie is what made
	// min-content resolve to zero and let a long word paint over its neighbour.
	setMeasuredDimensions(node, width, height, ownerWidth, ownerHeight);
}

/** A container with no in-flow children collapses to its padding + border. */
function layoutEmptyContainer(
	node: Node,
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const paddingBorderRow = paddingAndBorderForAxis(
		node,
		FLEX_DIRECTION_ROW,
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		FLEX_DIRECTION_COLUMN,
		ownerWidth,
	);
	const marginRow = marginForAxis(node, FLEX_DIRECTION_ROW, ownerWidth);
	const marginColumn = marginForAxis(node, FLEX_DIRECTION_COLUMN, ownerWidth);

	const width =
		widthMode === MEASURE_MODE_UNDEFINED || widthMode === MEASURE_MODE_AT_MOST
			? paddingBorderRow
			: availableWidth - marginRow;
	const height =
		heightMode === MEASURE_MODE_UNDEFINED || heightMode === MEASURE_MODE_AT_MOST
			? paddingBorderColumn
			: availableHeight - marginColumn;

	setMeasuredDimensions(node, width, height, ownerWidth, ownerHeight);
}

/**
 * Establish a child's flex base size (CSS flexbox 9.2), measuring it against
 * an indefinite main axis when the basis is `content`.
 */
function computeFlexBasisForChild(
	node: Node,
	child: Node,
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
		FLEX_DIRECTION_ROW,
		ownerWidth,
	);
	const columnDimDefined = styleDimIsDefined(
		child,
		FLEX_DIRECTION_COLUMN,
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
			paddingAndBorderForAxis(child, FLEX_DIRECTION_ROW, ownerWidth),
		);
		return;
	}

	if (!mainIsRow && columnDimDefined) {
		child.layout.computedFlexBasis = Math.max(
			resolveValue(child.style.height, ownerHeight),
			paddingAndBorderForAxis(child, FLEX_DIRECTION_COLUMN, ownerWidth),
		);
		return;
	}

	// Basis is `content`: measure the child.
	const childWidth = {value: NaN, mode: MEASURE_MODE_UNDEFINED};
	const childHeight = {value: NaN, mode: MEASURE_MODE_UNDEFINED};

	const marginRow = marginForAxis(child, FLEX_DIRECTION_ROW, ownerWidth);
	const marginColumn = marginForAxis(child, FLEX_DIRECTION_COLUMN, ownerWidth);

	if (rowDimDefined) {
		childWidth.value = resolveValue(child.style.width, ownerWidth) + marginRow;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	}
	if (columnDimDefined) {
		childHeight.value =
			resolveValue(child.style.height, ownerHeight) + marginColumn;
		childHeight.mode = MEASURE_MODE_EXACTLY;
	}

	if (!isDefined(childWidth.value) && isDefined(width)) {
		childWidth.value = width;
		childWidth.mode = MEASURE_MODE_AT_MOST;
	}
	if (!isDefined(childHeight.value) && isDefined(height)) {
		childHeight.value = height;
		childHeight.mode = MEASURE_MODE_AT_MOST;
	}

	// A stretched child on a definite cross axis is measured at the full cross size.
	const stretch = alignSelfOf(node, child) === ALIGN_STRETCH;
	if (
		!mainIsRow &&
		isDefined(width) &&
		widthMode === MEASURE_MODE_EXACTLY &&
		stretch &&
		childWidth.mode !== MEASURE_MODE_EXACTLY
	) {
		childWidth.value = width;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	}
	if (
		mainIsRow &&
		isDefined(height) &&
		heightMode === MEASURE_MODE_EXACTLY &&
		stretch &&
		childHeight.mode !== MEASURE_MODE_EXACTLY
	) {
		childHeight.value = height;
		childHeight.mode = MEASURE_MODE_EXACTLY;
	}

	constrainMaxSizeForMode(child, FLEX_DIRECTION_ROW, ownerWidth, childWidth);
	constrainMaxSizeForMode(
		child,
		FLEX_DIRECTION_COLUMN,
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
	items: Node[];
	sizeConsumed: number;
	totalGrow: number;
	totalShrinkScaled: number;
	crossDim: number;
	mainDim: number;
}

/**
 * The core algorithm. Structure follows CSS flexbox 9.2-9.7: generate flex
 * items, collect into lines, resolve flexible lengths, then align on both axes.
 */
function layoutFlexbox(
	node: Node,
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
	const wrap = node.style.flexWrap !== WRAP_NO_WRAP;

	const paddingBorderRow = paddingAndBorderForAxis(
		node,
		FLEX_DIRECTION_ROW,
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		FLEX_DIRECTION_COLUMN,
		ownerWidth,
	);
	const marginRow = marginForAxis(node, FLEX_DIRECTION_ROW, ownerWidth);
	const marginColumn = marginForAxis(node, FLEX_DIRECTION_COLUMN, ownerWidth);

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

	const inFlow: Node[] = [];
	for (const child of node.children) {
		if (child.style.display === DISPLAY_NONE) {
			zeroLayout(child);
			continue;
		}
		child.layout.margin[EDGE_LEFT] = resolveMargin(
			child.style.margin[EDGE_LEFT],
			ownerWidth,
		);
		child.layout.margin[EDGE_TOP] = resolveMargin(
			child.style.margin[EDGE_TOP],
			ownerWidth,
		);
		child.layout.margin[EDGE_RIGHT] = resolveMargin(
			child.style.margin[EDGE_RIGHT],
			ownerWidth,
		);
		child.layout.margin[EDGE_BOTTOM] = resolveMargin(
			child.style.margin[EDGE_BOTTOM],
			ownerWidth,
		);

		if (child.style.positionType === POSITION_TYPE_ABSOLUTE) continue;

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
			totalGrow: 0,
			totalShrinkScaled: 0,
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
			line.totalGrow += resolveFlexGrow(child);
			line.totalShrinkScaled += resolveFlexShrink(child) * basis;
			line.items.push(child);
			child.layout.lineIndex = lines.length;
		}

		lines.push(line);
		if (line.items.length === 0) break;
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
		// definite. Under AT_MOST it is an upper bound, and treating it as definite
		// would make the container report the full available cross size as its
		// content size -- which then becomes its flex basis in the parent.
		if (!wrap && isDefined(innerCross) && crossMode === MEASURE_MODE_EXACTLY) {
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
		? widthMode === MEASURE_MODE_EXACTLY
			? availableWidth - marginRow
			: boundAxis(
					node,
					mainAxis,
					maxMainDim + paddingBorderMain,
					mainIsRow ? ownerWidth : ownerHeight,
					ownerWidth,
				)
		: heightMode === MEASURE_MODE_EXACTLY
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
		? widthMode === MEASURE_MODE_EXACTLY
		: heightMode === MEASURE_MODE_EXACTLY;
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

	if (!performLayout) return;

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
	if (node.style.flexWrap === WRAP_WRAP_REVERSE) {
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
			if (child.style.positionType !== POSITION_TYPE_RELATIVE) continue;
			child.layout.left += relativeOffset(
				child,
				FLEX_DIRECTION_ROW,
				innerWidthFinal,
			);
			child.layout.top += relativeOffset(
				child,
				FLEX_DIRECTION_COLUMN,
				innerHeightFinal,
			);
		}
	}

	// -- absolutely positioned children ------------------------------------

	for (const child of node.children) {
		if (
			child.style.positionType !== POSITION_TYPE_ABSOLUTE ||
			child.style.display === DISPLAY_NONE
		) {
			continue;
		}
		layoutAbsoluteChild(node, child, ownerWidth, ownerHeight);
	}
}

/** A relative box is offset by its leading inset, or pulled back by its trailing one. */
function relativeOffset(
	node: Node,
	axis: FlexDirection,
	axisSize: number,
): number {
	const leading = resolveValue(
		node.style.position[leadingEdge(axis)],
		axisSize,
	);
	if (isDefined(leading)) return leading;

	const trailing = resolveValue(
		node.style.position[trailingEdge(axis)],
		axisSize,
	);
	if (isDefined(trailing)) return -trailing;

	return 0;
}

/**
 * CSS flexbox 9.7. Distribute free space by grow factor, or take it back by
 * shrink factor scaled by base size, freezing items that hit min/max and
 * redistributing what they could not absorb.
 */
function resolveFlexibleLengths(
	line: FlexLine,
	node: Node,
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
	const base = new Map<Node, number>();
	const target = new Map<Node, number>();
	const frozen = new Set<Node>();

	// An item never shrinks below its automatic minimum size, so that floor has to
	// be applied everywhere the item is clamped -- not just to its hypothetical
	// size, but to every target the redistribution loop lands on.
	const clampMain = (child: Node, value: number): number => {
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

	const outerMargin = (child: Node) =>
		marginForAxis(child, mainAxis, ownerWidth);

	// css-flexbox-1 §9.7.3: grow or shrink is decided once, by comparing the sum
	// of the items' outer hypothetical main sizes against the container.
	let hypotheticalTotal = 0;
	for (const child of line.items) {
		hypotheticalTotal += target.get(child)! + outerMargin(child);
	}
	const growing = innerMain - hypotheticalTotal > 0;

	// Items only grow into a *definite* main size. Under AT_MOST the container is
	// being sized to its content against an upper bound, so there is no free space
	// to distribute -- the container will shrink-wrap instead. Shrinking still
	// applies, since content that overflows the bound must be compressed.
	if (growing && mainMode !== MEASURE_MODE_EXACTLY) {
		commit();
		return;
	}

	const factorOf = (child: Node) =>
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
		if (unfrozen.length === 0) break;

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
		if (totalFactor === 0) break;

		// §9.7.4.c-d: each unfrozen item's target is its flex base size plus its
		// share of the free space, then clamped.
		let violation = 0;
		const minViolations: Node[] = [];
		const maxViolations: Node[] = [];

		for (const child of unfrozen) {
			const unclamped =
				base.get(child)! + (remaining * factorOf(child)) / totalFactor;
			const bounded = clampMain(child, unclamped);

			target.set(child, bounded);
			violation += bounded - unclamped;

			if (bounded > unclamped) minViolations.push(child);
			else if (bounded < unclamped) maxViolations.push(child);
		}

		// §9.7.4.e: freeze by the *sign* of the total violation, not by whoever
		// happened to clamp. Freezing both directions at once would strand the
		// space an over-clamped item gave back.
		if (violation === 0) {
			for (const child of unfrozen) frozen.add(child);
			break;
		} else if (violation > 0) {
			for (const child of minViolations) frozen.add(child);
		} else {
			for (const child of maxViolations) frozen.add(child);
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
	node: Node,
	child: Node,
	innerCross: number,
	crossMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
): number {
	const mainAxis = node.style.flexDirection;
	const mainIsRow = isRow(mainAxis);
	const mainOwnerSize = mainIsRow ? ownerWidth : ownerHeight;

	const specifiedMin = mainIsRow ? child.style.minWidth : child.style.minHeight;
	if (specifiedMin.unit !== UNIT_UNDEFINED && specifiedMin.unit !== UNIT_AUTO) {
		return NaN;
	}

	if (resolveFlexShrink(child) === 0) return NaN;

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
		: MEASURE_MODE_UNDEFINED;

	layoutNode(
		child,
		mainIsRow ? 0 : crossAvailable,
		mainIsRow ? crossAvailable : 0,
		mainIsRow ? MEASURE_MODE_AT_MOST : crossMeasureMode,
		mainIsRow ? crossMeasureMode : MEASURE_MODE_AT_MOST,
		ownerWidth,
		ownerHeight,
		false,
	);

	let floor = mainIsRow ? child.layout.width : child.layout.height;

	// The content-based minimum never exceeds a size the author asked for, nor
	// the item's own maximum.
	const size = mainIsRow ? child.style.width : child.style.height;
	const specified = resolveValue(size, mainOwnerSize);
	if (isDefined(specified)) floor = Math.min(floor, specified);

	const maxSize = mainIsRow ? child.style.maxWidth : child.style.maxHeight;
	const max = resolveValue(maxSize, mainOwnerSize);
	if (isDefined(max)) floor = Math.min(floor, max);

	return floor;
}

/** Lay out one flex item at its resolved main size, stretching the cross axis if asked. */
function layoutFlexItem(
	node: Node,
	child: Node,
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
	const align = alignSelfOf(node, child);

	const crossDimDefined = styleDimIsDefined(
		child,
		cross,
		isRow(cross) ? ownerWidth : ownerHeight,
	);

	const childWidth = {value: NaN, mode: MEASURE_MODE_UNDEFINED};
	const childHeight = {value: NaN, mode: MEASURE_MODE_UNDEFINED};

	const marginMainForChild = marginForAxis(child, mainAxis, ownerWidth);
	const marginCrossForChild = marginForAxis(child, cross, ownerWidth);

	// Main axis is now definite.
	if (mainIsRow) {
		childWidth.value = mainSize + marginMainForChild;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else {
		childHeight.value = mainSize + marginMainForChild;
		childHeight.mode = MEASURE_MODE_EXACTLY;
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
			childWidth.mode = MEASURE_MODE_EXACTLY;
		} else {
			childHeight.value = bounded + marginCrossForChild;
			childHeight.mode = MEASURE_MODE_EXACTLY;
		}
	} else if (
		align === ALIGN_STRETCH &&
		isDefined(innerCross) &&
		crossMode === MEASURE_MODE_EXACTLY
	) {
		// Only stretch against a *definite* cross size. While the container is
		// still being measured its cross size is merely an upper bound, and
		// stretching to it here would make every item report a flex basis of the
		// full container size. Items that still need stretching are re-laid out
		// in positionCrossAxis once the container's real cross size is known.
		if (isRow(cross)) {
			childWidth.value = innerCross;
			childWidth.mode = MEASURE_MODE_EXACTLY;
		} else {
			childHeight.value = innerCross;
			childHeight.mode = MEASURE_MODE_EXACTLY;
		}
	} else {
		const available = isRow(cross) ? innerWidth : innerHeight;
		if (isDefined(available)) {
			if (isRow(cross)) {
				childWidth.value = available;
				childWidth.mode = MEASURE_MODE_AT_MOST;
			} else {
				childHeight.value = available;
				childHeight.mode = MEASURE_MODE_AT_MOST;
			}
		}
	}

	constrainMaxSizeForMode(child, FLEX_DIRECTION_ROW, ownerWidth, childWidth);
	constrainMaxSizeForMode(
		child,
		FLEX_DIRECTION_COLUMN,
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
	node: Node,
	child: Node,
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
		MEASURE_MODE_EXACTLY,
		MEASURE_MODE_EXACTLY,
		ownerWidth,
		ownerHeight,
		true,
	);
}

/** justify-content, plus auto margins which absorb free space before it does. */
function positionMainAxis(
	node: Node,
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
		if (child.style.margin[leadingEdge(mainAxis)].unit === UNIT_AUTO)
			autoMarginCount++;
		if (child.style.margin[trailingEdge(mainAxis)].unit === UNIT_AUTO)
			autoMarginCount++;
	}

	let leading = 0;
	let between = 0;

	if (autoMarginCount > 0 && free > 0) {
		// Handled per-child below.
	} else {
		const count = line.items.length;
		switch (node.style.justifyContent) {
			case JUSTIFY_CENTER:
				leading = free / 2;
				break;
			case JUSTIFY_FLEX_END:
				leading = free;
				break;
			case JUSTIFY_SPACE_BETWEEN:
				if (count > 1) between = Math.max(free, 0) / (count - 1);
				break;
			case JUSTIFY_SPACE_AROUND:
				if (count > 0) {
					between = Math.max(free, 0) / count;
					leading = between / 2;
				}
				break;
			case JUSTIFY_SPACE_EVENLY:
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
			child.style.margin[leadingEdge(mainAxis)].unit === UNIT_AUTO;
		const trailingAuto =
			child.style.margin[trailingEdge(mainAxis)].unit === UNIT_AUTO;

		if (leadingAuto) cursor += autoShare;

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

		if (trailingAuto) cursor += autoShare;
		cursor += between;
		cursor += mainGap;
	}

	// The gaps are part of how far the line reaches, so the container's
	// content size has to include them.
	line.mainDim = contentMain + mainGap * Math.max(0, line.items.length - 1);
}

/** align-items / align-self within each line, and align-content across lines. */
function positionCrossAxis(
	node: Node,
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
		case ALIGN_FLEX_END:
			lineLeading = freeCross;
			break;
		case ALIGN_CENTER:
			lineLeading = freeCross / 2;
			break;
		case ALIGN_SPACE_BETWEEN:
			if (lineCount > 1) lineBetween = Math.max(freeCross, 0) / (lineCount - 1);
			break;
		case ALIGN_SPACE_AROUND:
			if (lineCount > 0) {
				lineBetween = Math.max(freeCross, 0) / lineCount;
				lineLeading = lineBetween / 2;
			}
			break;
		case ALIGN_SPACE_EVENLY:
			// Equal gaps everywhere, including before the first line and after the
			// last: n lines make n+1 gaps.
			if (lineCount > 0) {
				lineBetween = Math.max(freeCross, 0) / (lineCount + 1);
				lineLeading = lineBetween;
			}
			break;
		case ALIGN_STRETCH:
			// Extra space is handed to the lines themselves, below.
			break;
		default:
			lineLeading = 0;
	}

	// align-content: stretch grows each line to share the free cross space.
	const stretchPerLine =
		node.style.alignContent === ALIGN_STRETCH && lineCount > 0 && freeCross > 0
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
			line.items.some((child) => alignSelfOf(node, child) === ALIGN_BASELINE);
		if (lineHasBaseline) {
			for (const child of line.items) {
				if (alignSelfOf(node, child) !== ALIGN_BASELINE) continue;
				const childBaseline =
					resolveMargin(child.style.margin[leadingEdge(cross)], ownerWidth) +
					baselineWithinBorderBox(child, ownerWidth);
				maxBaseline = Math.max(maxBaseline, childBaseline);
			}
		}

		for (const child of line.items) {
			const align = alignSelfOf(node, child);
			const leadingMargin = resolveMargin(
				child.style.margin[leadingEdge(cross)],
				ownerWidth,
			);
			const trailingMargin = resolveMargin(
				child.style.margin[trailingEdge(cross)],
				ownerWidth,
			);

			const leadingAuto =
				child.style.margin[leadingEdge(cross)].unit === UNIT_AUTO;
			const trailingAuto =
				child.style.margin[trailingEdge(cross)].unit === UNIT_AUTO;

			// Stretch items now that the line's cross size is definite. Auto
			// margins opt an item out of stretching -- they absorb the space instead.
			const crossDimDefined = styleDimIsDefined(
				child,
				cross,
				crossIsRow ? ownerWidth : ownerHeight,
			);
			if (
				align === ALIGN_STRETCH &&
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
					case ALIGN_CENTER:
						offset = availableCross / 2;
						break;
					case ALIGN_FLEX_END:
						offset = availableCross;
						break;
					case ALIGN_BASELINE:
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
	node: Node,
	child: Node,
	ownerWidth: number,
	ownerHeight: number,
): void {
	const parentWidth = node.layout.width;
	const parentHeight = node.layout.height;

	const borderLeft = node.style.border[EDGE_LEFT];
	const borderTop = node.style.border[EDGE_TOP];
	const borderRight = node.style.border[EDGE_RIGHT];
	const borderBottom = node.style.border[EDGE_BOTTOM];

	const left = resolveValue(child.style.position[EDGE_LEFT], parentWidth);
	const top = resolveValue(child.style.position[EDGE_TOP], parentHeight);
	const right = resolveValue(child.style.position[EDGE_RIGHT], parentWidth);
	const bottom = resolveValue(child.style.position[EDGE_BOTTOM], parentHeight);

	const marginLeft = resolveMargin(child.style.margin[EDGE_LEFT], parentWidth);
	const marginTop = resolveMargin(child.style.margin[EDGE_TOP], parentWidth);
	const marginRight = resolveMargin(
		child.style.margin[EDGE_RIGHT],
		parentWidth,
	);
	const marginBottom = resolveMargin(
		child.style.margin[EDGE_BOTTOM],
		parentWidth,
	);

	const childWidth = {value: NaN, mode: MEASURE_MODE_UNDEFINED};
	const childHeight = {value: NaN, mode: MEASURE_MODE_UNDEFINED};

	if (styleDimIsDefined(child, FLEX_DIRECTION_ROW, parentWidth)) {
		childWidth.value =
			resolveValue(child.style.width, parentWidth) + marginLeft + marginRight;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else if (isDefined(left) && isDefined(right)) {
		// Both insets pin the box, so its width is implied.
		childWidth.value =
			parentWidth -
			borderLeft -
			borderRight -
			left -
			right -
			marginLeft -
			marginRight;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else if (isDefined(parentWidth)) {
		childWidth.value = parentWidth - borderLeft - borderRight;
		childWidth.mode = MEASURE_MODE_AT_MOST;
	}

	if (styleDimIsDefined(child, FLEX_DIRECTION_COLUMN, parentHeight)) {
		childHeight.value =
			resolveValue(child.style.height, parentHeight) + marginTop + marginBottom;
		childHeight.mode = MEASURE_MODE_EXACTLY;
	} else if (isDefined(top) && isDefined(bottom)) {
		childHeight.value =
			parentHeight -
			borderTop -
			borderBottom -
			top -
			bottom -
			marginTop -
			marginBottom;
		childHeight.mode = MEASURE_MODE_EXACTLY;
	} else if (isDefined(parentHeight)) {
		childHeight.value = parentHeight - borderTop - borderBottom;
		childHeight.mode = MEASURE_MODE_AT_MOST;
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

	// Horizontal placement.
	if (isDefined(left)) {
		child.layout.left = borderLeft + left + marginLeft;
	} else if (isDefined(right)) {
		child.layout.left =
			parentWidth - borderRight - child.layout.width - right - marginRight;
	} else if (staticPosition) {
		child.layout.left = staticPosition.left + marginLeft;
	} else {
		const align = node.style.justifyContent;
		const free = parentWidth - borderLeft - borderRight - child.layout.width;
		const isMainRow = isRow(node.style.flexDirection);
		if (isMainRow && align === JUSTIFY_CENTER) {
			child.layout.left = borderLeft + free / 2;
		} else if (isMainRow && align === JUSTIFY_FLEX_END) {
			child.layout.left = borderLeft + free;
		} else {
			child.layout.left = borderLeft + marginLeft;
		}
	}

	// Vertical placement.
	if (isDefined(top)) {
		child.layout.top = borderTop + top + marginTop;
	} else if (isDefined(bottom)) {
		child.layout.top =
			parentHeight - borderBottom - child.layout.height - bottom - marginBottom;
	} else if (staticPosition) {
		child.layout.top = staticPosition.top + marginTop;
	} else {
		const align = node.style.alignItems;
		const free = parentHeight - borderTop - borderBottom - child.layout.height;
		const isMainColumn = isColumn(node.style.flexDirection);
		if (isMainColumn && align === ALIGN_CENTER) {
			child.layout.top = borderTop + free / 2;
		} else if (isMainColumn && align === ALIGN_FLEX_END) {
			child.layout.top = borderTop + free;
		} else {
			child.layout.top = borderTop + marginTop;
		}
	}
}

function zeroLayout(node: Node): void {
	node.layout.left = 0;
	node.layout.top = 0;
	node.layout.width = 0;
	node.layout.height = 0;
	node.layout.computedFlexBasis = 0;
	for (const child of node.children) {
		zeroLayout(child);
	}
}

/** Dispatch: measure leaf, empty container, or full flexbox. */
// ---------------------------------------------------------------------------
// Table layout (CSS 2.1 §17, automatic table layout)
//
// A table is NOT flexbox. Its defining property is that columns are shared: a
// column's width is decided by every cell in it, across every row. Emulating
// that with a flex row per <tr> cannot work -- each row would size its cells
// independently -- so `display: table` is its own layout mode here.
// ---------------------------------------------------------------------------

interface TableCell {
	node: Node;
	row: number;
	column: number;
	colSpan: number;
	rowSpan: number;
	minWidth: number;
	maxWidth: number;
}

interface TableRow {
	node: Node;
	group: Node | null;
}

/**
 * Collect the table's rows in *visual* order.
 *
 * Header groups come first and footer groups last, however they were written --
 * a <tfoot> before <tbody> in the source still renders at the bottom.
 */
function collectTableRows(table: Node): {
	rows: TableRow[];
	captions: Node[];
	groups: Node[];
} {
	const captions: Node[] = [];
	const groups: Node[] = [];
	const header: TableRow[] = [];
	const body: TableRow[] = [];
	const footer: TableRow[] = [];

	const collectGroup = (group: Node, into: TableRow[]) => {
		groups.push(group);
		for (const child of group.children) {
			if (child.style.display === DISPLAY_TABLE_ROW) {
				into.push({node: child, group});
			} else {
				zeroLayout(child);
			}
		}
	};

	for (const child of table.children) {
		if (
			child.style.display === DISPLAY_NONE ||
			child.style.positionType === POSITION_TYPE_ABSOLUTE
		) {
			zeroLayout(child);
			continue;
		}

		switch (child.style.display) {
			case DISPLAY_TABLE_CAPTION:
				captions.push(child);
				break;
			case DISPLAY_TABLE_HEADER_GROUP:
				collectGroup(child, header);
				break;
			case DISPLAY_TABLE_FOOTER_GROUP:
				collectGroup(child, footer);
				break;
			case DISPLAY_TABLE_ROW_GROUP:
				collectGroup(child, body);
				break;
			case DISPLAY_TABLE_ROW:
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
			if (node.style.display !== DISPLAY_TABLE_CELL) {
				zeroLayout(node);
				continue;
			}

			while (occupied.has(`${rowIndex}:${column}`)) column++;

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
	cell: Node,
	minContent: boolean,
	ownerWidth: number,
	ownerHeight: number,
): number {
	layoutNode(
		cell,
		minContent ? 0 : NaN,
		NaN,
		minContent ? MEASURE_MODE_AT_MOST : MEASURE_MODE_UNDEFINED,
		MEASURE_MODE_UNDEFINED,
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
	if (extra <= 0) return;
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
			if (cell.colSpan === 1) fixed[cell.column] = true;
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
		if (cell.colSpan === 1) continue;

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

	if (columnCount === 0) return widths;

	if (target >= totalMax) {
		// Room to spare: every column gets what it wants, and the surplus goes to
		// the auto columns -- a column with an explicit width keeps it. This has to
		// be tested before the "cannot fit" case below, because when every column
		// is already at its preferred width (totalMin === totalMax) that case would
		// otherwise swallow it and hand the surplus to the fixed columns too.
		for (let i = 0; i < columnCount; i++) widths[i] = maxs[i];

		const extra = target - totalMax;
		const autoColumns: number[] = [];
		for (let i = 0; i < columnCount; i++) {
			if (!fixed[i]) autoColumns.push(i);
		}

		// If every column is fixed there is nobody to give it to, so spread it out
		// rather than leaving the table short of the width it was told to be.
		const receivers =
			autoColumns.length > 0
				? autoColumns
				: Array.from({length: columnCount}, (_, i) => i);

		let weight = 0;
		for (const i of receivers) weight += maxs[i];

		for (const i of receivers) {
			widths[i] +=
				weight > 0 ? (extra * maxs[i]) / weight : extra / receivers.length;
		}
	} else if (target <= totalMin) {
		// Cannot fit: every column takes its minimum and the table overflows. A
		// column never goes below its min-content width, which is what stops a long
		// word painting over the cell next to it.
		for (let i = 0; i < columnCount; i++) widths[i] = mins[i];
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
	node: Node,
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
		FLEX_DIRECTION_ROW,
		ownerWidth,
	);
	const paddingBorderColumn = paddingAndBorderForAxis(
		node,
		FLEX_DIRECTION_COLUMN,
		ownerWidth,
	);
	const marginRow = marginForAxis(node, FLEX_DIRECTION_ROW, ownerWidth);
	const marginColumn = marginForAxis(node, FLEX_DIRECTION_COLUMN, ownerWidth);

	const leftPaddingBorder = paddingAndBorderForEdge(
		node,
		EDGE_LEFT,
		ownerWidth,
	);
	const topPaddingBorder = paddingAndBorderForEdge(node, EDGE_TOP, ownerWidth);

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
		widthMode === MEASURE_MODE_EXACTLY && isDefined(innerWidth);

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
			MEASURE_MODE_EXACTLY,
			MEASURE_MODE_UNDEFINED,
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
			MEASURE_MODE_EXACTLY,
			MEASURE_MODE_UNDEFINED,
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
		if (cell.rowSpan === 1) continue;

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
		if (previousVisible) cursor -= overlap;
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
		widthMode === MEASURE_MODE_EXACTLY
			? availableWidth - marginRow
			: contentWidth + paddingBorderRow;
	const height =
		heightMode === MEASURE_MODE_EXACTLY
			? availableHeight - marginColumn
			: contentHeight + paddingBorderColumn;

	setMeasuredDimensions(node, width, height, ownerWidth, ownerHeight);

	if (!performLayout) return;

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
			MEASURE_MODE_EXACTLY,
			MEASURE_MODE_EXACTLY,
			ownerWidth,
			ownerHeight,
			true,
		);

		// Relative to the cell's own row, which already sits at the right y.
		cell.node.layout.left = columnStart(cell.column);
		cell.node.layout.top = 0;
	}
}

function layoutNode(
	node: Node,
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
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
			const marginRow = marginForAxis(node, FLEX_DIRECTION_ROW, ownerWidth);
			const marginColumn = marginForAxis(
				node,
				FLEX_DIRECTION_COLUMN,
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

	measuredPayload = NO_PAYLOAD;
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
	const payload = measuredPayload;
	measuredPayload = NO_PAYLOAD;

	const entry: CachedLayout = {
		availableWidth,
		availableHeight,
		widthMode,
		heightMode,
		ownerWidth,
		ownerHeight,
		width: node.layout.width,
		height: node.layout.height,
		// A pass that consulted no measure function -- every container, and a box
		// whose size was settled without asking -- has no product to record.
		payload: payload === NO_PAYLOAD ? null : payload,
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

function layoutNodeImpl(
	node: Node,
	availableWidth: number,
	availableHeight: number,
	widthMode: MeasureMode,
	heightMode: MeasureMode,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	node.layout.padding[EDGE_LEFT] = paddingOf(node, EDGE_LEFT, ownerWidth);
	node.layout.padding[EDGE_TOP] = paddingOf(node, EDGE_TOP, ownerWidth);
	node.layout.padding[EDGE_RIGHT] = paddingOf(node, EDGE_RIGHT, ownerWidth);
	node.layout.padding[EDGE_BOTTOM] = paddingOf(node, EDGE_BOTTOM, ownerWidth);

	node.layout.border[EDGE_LEFT] = node.style.border[EDGE_LEFT];
	node.layout.border[EDGE_TOP] = node.style.border[EDGE_TOP];
	node.layout.border[EDGE_RIGHT] = node.style.border[EDGE_RIGHT];
	node.layout.border[EDGE_BOTTOM] = node.style.border[EDGE_BOTTOM];

	node.layout.margin[EDGE_LEFT] = resolveMargin(
		node.style.margin[EDGE_LEFT],
		ownerWidth,
	);
	node.layout.margin[EDGE_TOP] = resolveMargin(
		node.style.margin[EDGE_TOP],
		ownerWidth,
	);
	node.layout.margin[EDGE_RIGHT] = resolveMargin(
		node.style.margin[EDGE_RIGHT],
		ownerWidth,
	);
	node.layout.margin[EDGE_BOTTOM] = resolveMargin(
		node.style.margin[EDGE_BOTTOM],
		ownerWidth,
	);

	if (node.style.display === DISPLAY_NONE) {
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

	if (node.style.display === DISPLAY_TABLE) {
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

	const hasInFlowChild = node.children.some(
		(child) =>
			child.style.display !== DISPLAY_NONE &&
			child.style.positionType !== POSITION_TYPE_ABSOLUTE,
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

function paddingOf(node: Node, edge: Edge, ownerWidth: number): number {
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
	node: Node,
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
	if (!isDefined(value)) return value;

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
// Yoga-compatible default export
// ---------------------------------------------------------------------------

const Flex = {
	Node,
	Config,

	ALIGN_AUTO,
	ALIGN_FLEX_START,
	ALIGN_CENTER,
	ALIGN_FLEX_END,
	ALIGN_STRETCH,
	ALIGN_BASELINE,
	ALIGN_SPACE_BETWEEN,
	ALIGN_SPACE_AROUND,
	ALIGN_SPACE_EVENLY,

	JUSTIFY_FLEX_START,
	JUSTIFY_CENTER,
	JUSTIFY_FLEX_END,
	JUSTIFY_SPACE_BETWEEN,
	JUSTIFY_SPACE_AROUND,
	JUSTIFY_SPACE_EVENLY,

	WRAP_NO_WRAP,
	WRAP_WRAP,
	WRAP_WRAP_REVERSE,

	FLEX_DIRECTION_COLUMN,
	FLEX_DIRECTION_COLUMN_REVERSE,
	FLEX_DIRECTION_ROW,
	FLEX_DIRECTION_ROW_REVERSE,

	GUTTER_COLUMN,
	GUTTER_ROW,
	GUTTER_ALL,

	DISPLAY_FLEX,
	DISPLAY_NONE,
	DISPLAY_TABLE,
	DISPLAY_TABLE_ROW_GROUP,
	DISPLAY_TABLE_HEADER_GROUP,
	DISPLAY_TABLE_FOOTER_GROUP,
	DISPLAY_TABLE_ROW,
	DISPLAY_TABLE_CELL,
	DISPLAY_TABLE_CAPTION,

	POSITION_TYPE_STATIC,
	POSITION_TYPE_RELATIVE,
	POSITION_TYPE_ABSOLUTE,

	MEASURE_MODE_UNDEFINED,
	MEASURE_MODE_EXACTLY,
	MEASURE_MODE_AT_MOST,

	EDGE_LEFT,
	EDGE_TOP,
	EDGE_RIGHT,
	EDGE_BOTTOM,
	EDGE_START,
	EDGE_END,
	EDGE_HORIZONTAL,
	EDGE_VERTICAL,
	EDGE_ALL,

	UNIT_UNDEFINED,
	UNIT_POINT,
	UNIT_PERCENT,
	UNIT_AUTO,
};

export default Flex;
