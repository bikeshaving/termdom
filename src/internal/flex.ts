/**
 * The box sizing and placement solver: where a box ends up on the integer
 * cell grid, and how big it is.
 *
 * Three layout modes over one node type, chosen by the node's display: flex
 * (css-flexbox-1 / CSS Box Alignment), grid (css-grid-2 -- track sizing, line
 * resolution, area placement), and the table grid rows and cells resolve to.
 * All three are implemented from the spec rather than ported.
 *
 * The node API is shaped like Yoga's, which is what this replaced. Nothing
 * depends on that shape any more; a caller assigning styles one setter at a
 * time is the cost of it.
 *
 * Omitted, because the engine resolves them elsewhere or a cell grid has no
 * use for them: writing modes and the direction property -- bidi is resolved
 * when text is shaped, not when boxes are placed -- scrollable overflow
 * sizing, and sub-cell scaling, the grid being integer cells, so
 * pointScaleFactor is always 1.
 *
 * Undefined values are represented as NaN throughout, matching the convention
 * that "undefined" is a distinct state from 0.
 */

// ---------------------------------------------------------------------------
// Constants
//
// Names mirror Yoga's, which is where they came from. Every one is now reached
// statically -- the engine spells its keyword tables out -- so these can be
// renumbered or renamed without a name built at runtime missing one.
// ---------------------------------------------------------------------------

const ALIGN_AUTO = 0;
const ALIGN_FLEX_START = 1;
const ALIGN_CENTER = 2;
const ALIGN_FLEX_END = 3;
const ALIGN_STRETCH = 4;
const ALIGN_BASELINE = 5;
const ALIGN_SPACE_BETWEEN = 6;
const ALIGN_SPACE_AROUND = 7;
const ALIGN_SPACE_EVENLY = 8;
/**
 * css-align-3 `normal`, which names no behaviour of its own: it takes the
 * meaning the layout mode gives it -- stretch for a grid item, flex-start for
 * a flex container's lines.
 */
const ALIGN_NORMAL = 9;

const JUSTIFY_FLEX_START = 0;
const JUSTIFY_CENTER = 1;
const JUSTIFY_FLEX_END = 2;
const JUSTIFY_SPACE_BETWEEN = 3;
const JUSTIFY_SPACE_AROUND = 4;
const JUSTIFY_SPACE_EVENLY = 5;
/** See ALIGN_NORMAL. */
const JUSTIFY_NORMAL = 6;
const JUSTIFY_STRETCH = 7;

const WRAP_NO_WRAP = 0;
const WRAP_WRAP = 1;
const WRAP_WRAP_REVERSE = 2;

const FLEX_DIRECTION_COLUMN = 0;
const FLEX_DIRECTION_COLUMN_REVERSE = 1;
const FLEX_DIRECTION_ROW = 2;
const FLEX_DIRECTION_ROW_REVERSE = 3;

const GUTTER_COLUMN = 0;
const GUTTER_ROW = 1;
const GUTTER_ALL = 2;

const DISPLAY_FLEX = 0;
const DISPLAY_NONE = 1;
const DISPLAY_BLOCK = 2;
const DISPLAY_TABLE = 3;
const DISPLAY_TABLE_ROW_GROUP = 4;
const DISPLAY_TABLE_HEADER_GROUP = 5;
const DISPLAY_TABLE_FOOTER_GROUP = 6;
const DISPLAY_TABLE_ROW = 7;
const DISPLAY_TABLE_CELL = 8;
const DISPLAY_TABLE_CAPTION = 9;
const DISPLAY_GRID = 10;

const POSITION_TYPE_STATIC = 0;
const POSITION_TYPE_RELATIVE = 1;
const POSITION_TYPE_ABSOLUTE = 2;

const MEASURE_MODE_UNDEFINED = 0;
const MEASURE_MODE_EXACTLY = 1;
const MEASURE_MODE_AT_MOST = 2;

const EDGE_LEFT = 0;
const EDGE_TOP = 1;
const EDGE_RIGHT = 2;
const EDGE_BOTTOM = 3;
const EDGE_START = 4;
const EDGE_END = 5;
const EDGE_HORIZONTAL = 6;
const EDGE_VERTICAL = 7;
const EDGE_ALL = 8;

const UNIT_UNDEFINED = 0;
const UNIT_POINT = 1;
const UNIT_PERCENT = 2;
const UNIT_AUTO = 3;

/**
 * The intrinsic sizing keywords of css-sizing-3 §5, carried beside a width of
 * auto rather than as units of it: min/max resolution, percentages and flex
 * arithmetic go on reading auto, and only the places that decide how wide an
 * auto box comes out consult the keyword.
 */
const SIZING_NONE = 0;
const SIZING_MIN_CONTENT = 1;
const SIZING_MAX_CONTENT = 2;
const SIZING_FIT_CONTENT = 3;

export type Align = number;
export type Justify = number;
export type Wrap = number;
type FlexDirection = number;
export type Display = number;
type PositionType = number;
export type MeasureMode = number;
export type Edge = number;

export interface Size {
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
	height: number,
	heightMode: MeasureMode,
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
	if (input === undefined || input === null) {
		return UNDEFINED_VALUE;
	}
	if (typeof input === "number") {
		return Number.isNaN(input) ?
			UNDEFINED_VALUE :
				{unit: UNIT_POINT, value: input};
	}
	const trimmed = input.trim();
	if (trimmed === "auto") {
		return AUTO_VALUE;
	}
	if (trimmed.endsWith("%")) {
		const parsed = parseFloat(trimmed.slice(0, -1));
		return Number.isNaN(parsed) ?
			UNDEFINED_VALUE :
				{unit: UNIT_PERCENT, value: parsed};
	}
	const parsed = parseFloat(trimmed);
	return Number.isNaN(parsed) ?
		UNDEFINED_VALUE :
			{unit: UNIT_POINT, value: parsed};
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
	if (value.unit === UNIT_AUTO) {
		return 0;
	}
	const resolved = resolveValue(value, ownerWidth);
	return isDefined(resolved) ? resolved : 0;
}

// ---------------------------------------------------------------------------
// Grid values (css-grid-2 §7, §8)
//
// The compute core takes these already parsed: a track list arrives as the
// structure the grammar describes, never as CSS text. Lengths keep the Value
// shape everything else here uses, so a percentage track resolves against the
// grid container the same way a percentage width does.
// ---------------------------------------------------------------------------

/**
 * A `<track-breadth>`: one end of a track's sizing function. `flex` is the
 * `fr` unit, whose factor is a share of the leftover space rather than a
 * length; the three keywords are intrinsic, and size from the items in them.
 */
export type TrackBreadth =
	| {kind: "length"; value: Value} |
	{kind: "flex"; factor: number} |
	{kind: "auto"} |
	{kind: "min-content"} |
	{kind: "max-content"};

/**
 * A `<track-size>`: the minimum and maximum a track may take.
 *
 * `fit-content(x)` is `minmax(auto, max-content)` with the maximum clamped by
 * `x` (css-grid-2 §7.2.3), so it is held as exactly that -- the clamp beside
 * the pair, not a fourth kind of sizing function.
 */
export interface TrackSize {
	min: TrackBreadth;
	max: TrackBreadth;
	fitContent?: Value;
}

/** One track of a track list, with the line names written before it. */
export interface TrackListTrack {
	names: string[];
	size: TrackSize;
}

/**
 * A `repeat()` group. `auto-fill` and `auto-fit` decide their own count from
 * the space available; `auto-fit` then collapses the tracks that took no item
 * (css-grid-2 §7.2.3.2).
 */
export interface TrackRepeat {
	count: number | "auto-fill" | "auto-fit";
	tracks: TrackListTrack[];
	/** Line names written after the repeat group's last track. */
	endNames: string[];
}

export type TrackListPart =
	| {type: "track"; track: TrackListTrack} |
	{type: "repeat"; repeat: TrackRepeat};

/** A `<track-list>`: the tracks of one axis, with the lines named between them. */
export interface TrackList {
	parts: TrackListPart[];
	/** Line names written after the last track. */
	endNames: string[];
}

/**
 * A `grid-template-areas` map: one entry per row, one name (or null for a `.`
 * null cell) per column. Every row has `columnCount` entries.
 */
export interface GridAreaMap {
	rows: Array<Array<string | null>>;
	columnCount: number;
}

/**
 * One `<grid-line>` (css-grid-2 §8.3). `auto` is index null with no name and
 * no span; the rest are the grammar's three forms, which the parser has
 * already told apart.
 */
export interface GridPlacement {
	span: boolean;
	index: number | null;
	name: string | null;
}

const AUTO_PLACEMENT: GridPlacement = {span: false, index: null, name: null};

/** The `auto` track size: the initial value of grid-auto-rows/columns. */
const AUTO_TRACK: TrackSize = {min: {kind: "auto"}, max: {kind: "auto"}};

const EMPTY_TRACK_LIST: TrackList = {parts: [], endNames: []};

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

	margin: Value[];
	position: Value[];
	padding: Value[];
	border: number[];

	width: Value;
	/** SIZING_*: how an auto width resolves; none means fill or measure. */
	widthSizing: number;
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
	margin: number[];
	padding: number[];
	border: number[];
	computedFlexBasis: number;
	/** css-flexbox-1 §4.5 automatic minimum size, along the parent's main axis. */
	autoMinMain: number;
	lineIndex: number;

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

		justifyItems: ALIGN_NORMAL,
		justifySelf: ALIGN_AUTO,

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
		widthSizing: SIZING_NONE,
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
		margin: [0, 0, 0, 0],
		padding: [0, 0, 0, 0],
		border: [0, 0, 0, 0],
		computedFlexBasis: NaN,
		autoMinMain: NaN,
		lineIndex: 0,
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export class Config {
	constructor() {
		this.pointScaleFactor = 1;
	}

	pointScaleFactor: number;

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

/** See FlexNode's unstackedChildCount. */
function breaksStacking(node: Node): boolean {
	return (
		node.style.positionType !== POSITION_TYPE_STATIC ||
		node.style.display === DISPLAY_NONE
	);
}

export class Node {
	style: Style;
	layout: LayoutResult;
	children: Node[];
	parent: Node | null;
	measureFunc: MeasureFunction | null;
	staticPositionFunc: StaticPositionFunction | null;
	config: Config;
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

	constructor(config: Config = defaultConfig) {
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
		markDirtyUpward(this);
	}

	removeChild(child: Node): void {
		const index = this.children.indexOf(child);
		if (index !== -1) {
			this.children.splice(index, 1);
			child.parent = null;
			markDirtyUpward(this);
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

	getDisplay(): Display {
		return this.style.display;
	}

	setDisplay(v: Display): void {
		this.style.display = v;
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

	setWidthSizing(v: number): void {
		if (this.style.widthSizing !== v) {
			this.style.widthSizing = v;
			this.markDirty();
		}
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
		setEdges(this, this.style.margin, edge, toValue(v));
		this.markDirty();
	}

	setMarginPercent(edge: Edge, v: number): void {
		setEdges(this, this.style.margin, edge, {unit: UNIT_PERCENT, value: v});
		this.markDirty();
	}

	setMarginAuto(edge: Edge): void {
		setEdges(this, this.style.margin, edge, AUTO_VALUE);
		this.markDirty();
	}

	setPadding(edge: Edge, v: number | undefined): void {
		setEdges(this, this.style.padding, edge, toValue(v));
		this.markDirty();
	}

	setPaddingPercent(edge: Edge, v: number): void {
		setEdges(this, this.style.padding, edge, {unit: UNIT_PERCENT, value: v});
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
		setEdges(this, this.style.position, edge, toValue(v));
		this.markDirty();
	}

	setPositionPercent(edge: Edge, v: number): void {
		setEdges(this, this.style.position, edge, {unit: UNIT_PERCENT, value: v});
		this.markDirty();
	}

	setPositionAuto(edge: Edge): void {
		setEdges(this, this.style.position, edge, AUTO_VALUE);
		this.markDirty();
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

	getPositionType(): PositionType {
		return this.style.positionType;
	}

	getGap(gutter: number): number {
		return gutter === GUTTER_ROW ?
			this.style.gap[GUTTER_ROW] :
			this.style.gap[GUTTER_COLUMN];
	}

	// -- entry point --------------------------------------------------------

	calculateLayout(ownerWidth: number, ownerHeight: number): void {
		const width = resolveValue(this.style.width, ownerWidth);
		const height = resolveValue(this.style.height, ownerHeight);

		let availableWidth = isDefined(width) ? width : ownerWidth;
		let widthMode = isDefined(availableWidth) ?
			MEASURE_MODE_EXACTLY :
			MEASURE_MODE_UNDEFINED;
		// A sizing keyword on a root turns the owner's width from the used
		// width into a probe: zero for min-content, a ceiling for fit-content,
		// and no offer at all for max-content.
		if (!isDefined(width) && this.style.widthSizing !== SIZING_NONE) {
			if (this.style.widthSizing === SIZING_MIN_CONTENT) {
				availableWidth = 0;
				widthMode = MEASURE_MODE_AT_MOST;
			} else if (this.style.widthSizing === SIZING_MAX_CONTENT) {
				availableWidth = NaN;
				widthMode = MEASURE_MODE_UNDEFINED;
			} else if (isDefined(availableWidth)) {
				widthMode = MEASURE_MODE_AT_MOST;
			}
		}
		const availableHeight = isDefined(height) ? height : ownerHeight;

		layoutNode(
			this,
			availableWidth,
			availableHeight,
			widthMode,
			isDefined(availableHeight) ?
				MEASURE_MODE_EXACTLY :
				MEASURE_MODE_UNDEFINED,
			ownerWidth,
			ownerHeight,
			true,
		);

		roundToGrid(this, 0, 0);
		this.computePaintExtents(0);
		this.dirty = false;
	}
}

function markDirtyUpward(
	start: Node,
): void {
	for (let node: Node | null = start; node; node = node.parent) {
		node.dirty = true;
	}
}

function setEdges(
	node: Node,
	target: Value[],
	edge: Edge,
	value: Value,
): void {
	for (const index of expandEdge(edge)) {
		target[index] = value;
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
	if (!node.parent) {
		return 0;
	}
	return isDefined(node.style.flexGrow) ? node.style.flexGrow : 0;
}

function resolveFlexShrink(node: Node): number {
	if (!node.parent) {
		return 0;
	}
	if (isDefined(node.style.flexShrink)) {
		return node.style.flexShrink;
	}
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
	const align =
		child.style.alignSelf === ALIGN_AUTO ?
			parent.style.alignItems :
			child.style.alignSelf;
	// `normal` behaves as `stretch` on a flex item (css-align-3 §4.2).
	return align === ALIGN_NORMAL ? ALIGN_STRETCH : align;
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
		if (child.style.display === DISPLAY_NONE) {
			continue;
		}
		if (child.style.positionType === POSITION_TYPE_ABSOLUTE) {
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
function gapForAxis(node: Node, axis: FlexDirection): number {
	return isRow(axis) ?
		node.style.gap[GUTTER_COLUMN] :
		node.style.gap[GUTTER_ROW];
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
	if (value.unit === UNIT_AUTO || value.unit === UNIT_UNDEFINED) {
		return false;
	}
	if (value.unit === UNIT_POINT && value.value < 0) {
		return false;
	}
	if (
		value.unit === UNIT_PERCENT &&
		(value.value < 0 || Number.isNaN(ownerSize))
	) {
		return false;
	}
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
	if (!isDefined(max)) {
		return;
	}

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

/** Resolve a node's four margins against the width percentages are taken from. */
function resolveNodeMargins(node: Node, ownerWidth: number): void {
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
}

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

	const innerWidth = isDefined(availableWidth) ?
			Math.max(0, availableWidth - marginRow - paddingBorderRow) :
		NaN;
	const innerHeight = isDefined(availableHeight) ?
			Math.max(0, availableHeight - marginColumn - paddingBorderColumn) :
		NaN;

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
		performLayout,
	);

	const width =
		widthMode === MEASURE_MODE_EXACTLY ?
			availableWidth - marginRow :
			measured.width + paddingBorderRow;
	const height =
		heightMode === MEASURE_MODE_EXACTLY ?
			availableHeight - marginColumn :
			measured.height + paddingBorderColumn;

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
		widthMode === MEASURE_MODE_UNDEFINED || widthMode === MEASURE_MODE_AT_MOST ?
			paddingBorderRow :
			availableWidth - marginRow;
	const height =
		heightMode === MEASURE_MODE_UNDEFINED ||
		heightMode === MEASURE_MODE_AT_MOST ?
			paddingBorderColumn :
			availableHeight - marginColumn;

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

	const innerWidth = isDefined(availableWidth) ?
			Math.max(0, availableWidth - marginRow - paddingBorderRow) :
		NaN;
	const innerHeight = isDefined(availableHeight) ?
			Math.max(0, availableHeight - marginColumn - paddingBorderColumn) :
		NaN;

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
		resolveNodeMargins(child, ownerWidth);

		if (child.style.positionType === POSITION_TYPE_ABSOLUTE) {
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
		const mainForItems = isDefined(innerMain) ?
				Math.max(0, innerMain - lineGap) :
			innerMain;

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

	const measuredMain = mainIsRow ?
		widthMode === MEASURE_MODE_EXACTLY ?
			availableWidth - marginRow :
				boundAxis(
					node,
					mainAxis,
					maxMainDim + paddingBorderMain,
					ownerWidth,
					ownerWidth,
				) :
		heightMode === MEASURE_MODE_EXACTLY ?
			availableHeight - marginColumn :
				boundAxis(
					node,
					mainAxis,
					maxMainDim + paddingBorderMain,
					ownerHeight,
					ownerWidth,
				);

	const crossIsRow = isRow(cross);
	const crossExactly = crossIsRow ?
		widthMode === MEASURE_MODE_EXACTLY :
		heightMode === MEASURE_MODE_EXACTLY;
	const crossAvailable = crossIsRow ?
		availableWidth - marginRow :
		availableHeight - marginColumn;

	const measuredCross = crossExactly ?
		crossAvailable :
			boundAxis(
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
			if (child.style.positionType !== POSITION_TYPE_RELATIVE) {
				continue;
			}
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
		growing ?
				resolveFlexGrow(child) :
			resolveFlexShrink(child) * base.get(child)!;

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
		const minViolations: Node[] = [];
		const maxViolations: Node[] = [];

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
	const crossMeasureMode = isDefined(innerCross) ?
		crossMode :
		MEASURE_MODE_UNDEFINED;

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
	const crossTarget = crossDimDefined ?
			resolveValue(
				isRow(cross) ? child.style.width : child.style.height,
				isRow(cross) ? ownerWidth : ownerHeight,
			) :
		NaN;

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
		if (child.style.margin[leadingEdge(mainAxis)].unit === UNIT_AUTO) {
			autoMarginCount++;
		}
		if (child.style.margin[trailingEdge(mainAxis)].unit === UNIT_AUTO) {
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
			case JUSTIFY_CENTER:
				leading = free / 2;
				break;
			case JUSTIFY_FLEX_END:
				leading = free;
				break;
			case JUSTIFY_SPACE_BETWEEN:
				if (count > 1) {
					between = Math.max(free, 0) / (count - 1);
				}
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

	const freeCross = isDefined(containerInnerCross) ?
		containerInnerCross - totalCrossDim :
		0;

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
			if (lineCount > 1) {
				lineBetween = Math.max(freeCross, 0) / (lineCount - 1);
			}
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
		node.style.alignContent === ALIGN_STRETCH &&
		lineCount > 0 &&
		freeCross > 0 ?
			freeCross / lineCount :
			0;

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
				if (alignSelfOf(node, child) !== ALIGN_BASELINE) {
					continue;
				}
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
				const currentCross = crossIsRow ?
					child.layout.width :
					child.layout.height;
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
	area: {
		left: number;
		top: number;
		width: number;
		height: number;
	} | null = null,
): void {
	const parentWidth = node.layout.width;
	const parentHeight = node.layout.height;

	const borderLeft = node.style.border[EDGE_LEFT];
	const borderTop = node.style.border[EDGE_TOP];
	const borderRight = node.style.border[EDGE_RIGHT];
	const borderBottom = node.style.border[EDGE_BOTTOM];

	// The containing block: the parent's padding box, or -- for a grid child
	// the author placed on lines -- its grid area (css-grid-2 §9.2).
	const blockLeft = area ? area.left : borderLeft;
	const blockTop = area ? area.top : borderTop;
	const blockWidth = area ? area.width : parentWidth - borderLeft - borderRight;
	const blockHeight = area ?
		area.height :
		parentHeight - borderTop - borderBottom;
	const basisWidth = area ? area.width : parentWidth;
	const basisHeight = area ? area.height : parentHeight;

	const left = resolveValue(child.style.position[EDGE_LEFT], basisWidth);
	const top = resolveValue(child.style.position[EDGE_TOP], basisHeight);
	const right = resolveValue(child.style.position[EDGE_RIGHT], basisWidth);
	const bottom = resolveValue(child.style.position[EDGE_BOTTOM], basisHeight);

	const marginLeft = resolveMargin(child.style.margin[EDGE_LEFT], basisWidth);
	const marginTop = resolveMargin(child.style.margin[EDGE_TOP], basisWidth);
	const marginRight = resolveMargin(child.style.margin[EDGE_RIGHT], basisWidth);
	const marginBottom = resolveMargin(
		child.style.margin[EDGE_BOTTOM],
		basisWidth,
	);

	// An auto margin between an inset and the box is the box asking to be
	// placed in the space the insets leave rather than stretched across it --
	// the same reading the in-flow block path gives `margin: auto`, and what
	// centers a modal dialog in the viewport.
	const autoLeft = child.style.margin[EDGE_LEFT].unit === UNIT_AUTO;
	const autoRight = child.style.margin[EDGE_RIGHT].unit === UNIT_AUTO;
	const autoTop = child.style.margin[EDGE_TOP].unit === UNIT_AUTO;
	const autoBottom = child.style.margin[EDGE_BOTTOM].unit === UNIT_AUTO;
	const shrinkAcross =
		isDefined(left) && isDefined(right) && autoLeft && autoRight;
	const shrinkDown =
		isDefined(top) && isDefined(bottom) && autoTop && autoBottom;

	const childWidth = {value: NaN, mode: MEASURE_MODE_UNDEFINED};
	const childHeight = {value: NaN, mode: MEASURE_MODE_UNDEFINED};

	if (styleDimIsDefined(child, FLEX_DIRECTION_ROW, basisWidth)) {
		childWidth.value =
			resolveValue(child.style.width, basisWidth) + marginLeft + marginRight;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else if (shrinkAcross) {
		// Auto margins on both sides: the insets bound the box, they do not
		// size it, so it shrinks to its content within them.
		childWidth.value = blockWidth - left - right;
		childWidth.mode = MEASURE_MODE_AT_MOST;
	} else if (isDefined(left) && isDefined(right)) {
		// Both insets pin the box, so its width is implied.
		childWidth.value = blockWidth - left - right - marginLeft - marginRight;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else if (isDefined(blockWidth)) {
		childWidth.value = blockWidth;
		// `stretch` (and the `normal` a grid area gives it) fills the alignment
		// container when the box's size and both its insets are auto
		// (css-align-3 §5.2). Nothing but a grid area has an alignment
		// container to fill, so nothing else stretches.
		childWidth.mode =
			area && gridSelfAlign(node, child, true) === ALIGN_STRETCH ?
				MEASURE_MODE_EXACTLY :
				MEASURE_MODE_AT_MOST;
	}

	if (styleDimIsDefined(child, FLEX_DIRECTION_COLUMN, basisHeight)) {
		childHeight.value =
			resolveValue(child.style.height, basisHeight) + marginTop + marginBottom;
		childHeight.mode = MEASURE_MODE_EXACTLY;
	} else if (shrinkDown) {
		childHeight.value = blockHeight - top - bottom;
		childHeight.mode = MEASURE_MODE_AT_MOST;
	} else if (isDefined(top) && isDefined(bottom)) {
		childHeight.value = blockHeight - top - bottom - marginTop - marginBottom;
		childHeight.mode = MEASURE_MODE_EXACTLY;
	} else if (isDefined(blockHeight)) {
		childHeight.value = blockHeight;
		childHeight.mode =
			area && gridSelfAlign(node, child, false) === ALIGN_STRETCH ?
				MEASURE_MODE_EXACTLY :
				MEASURE_MODE_AT_MOST;
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
		(!isDefined(top) && !isDefined(bottom)) ?
				(child.staticPositionFunc?.(node) ?? null) :
			null;

	const isGrid = node.style.display === DISPLAY_GRID;

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
		const align = isGrid ?
				gridSelfAlign(node, child, true) :
			isRow(node.style.flexDirection) ?
				node.style.justifyContent === JUSTIFY_CENTER ?
					ALIGN_CENTER :
					node.style.justifyContent === JUSTIFY_FLEX_END ?
						ALIGN_FLEX_END :
						ALIGN_FLEX_START :
				ALIGN_FLEX_START;
		if (align === ALIGN_CENTER) {
			child.layout.left = blockLeft + free / 2;
		} else if (align === ALIGN_FLEX_END) {
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
		const align = isGrid ?
				gridSelfAlign(node, child, false) :
			isColumn(node.style.flexDirection) ?
				node.style.alignItems === ALIGN_CENTER ?
					ALIGN_CENTER :
					node.style.alignItems === ALIGN_FLEX_END ?
						ALIGN_FLEX_END :
						ALIGN_FLEX_START :
				ALIGN_FLEX_START;
		if (align === ALIGN_CENTER) {
			child.layout.top = blockTop + free / 2;
		} else if (align === ALIGN_FLEX_END) {
			child.layout.top = blockTop + free;
		} else {
			child.layout.top = blockTop + marginTop;
		}
	}
}

function zeroLayout(node: Node): void {
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
	const target = widthIsDefinite ?
		available :
			Math.min(
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
			autoColumns.length > 0 ?
				autoColumns :
					Array.from({length: columnCount}, (_, i) => i);

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

	const innerWidth = isDefined(availableWidth) ?
			Math.max(0, availableWidth - marginRow - paddingBorderRow) :
		NaN;

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
		widthMode === MEASURE_MODE_EXACTLY ?
			availableWidth - marginRow :
			contentWidth + paddingBorderRow;
	const height =
		heightMode === MEASURE_MODE_EXACTLY ?
			availableHeight - marginColumn :
			contentHeight + paddingBorderColumn;

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
		row.node.layout.top = row.group ?
				rowStart(index) :
			gridTop + rowStart(index);
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
	 * Whether the growth limit was set from a max-content contribution in this
	 * pass, which lets the next distribution grow the track past it
	 * (css-grid-2 §12.5.1, "infinitely growable").
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
	node: Node;
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
	| {kind: "auto"} |
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
			placement.index > 0 ?
				placement.index - 1 :
				explicitCount + placement.index + 1,
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
	const ordered = forward ?
			matches.filter((line) => line > from) :
			matches.filter((line) => line < from).reverse();
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
		start.kind === "span" || start.kind === "spanName" ?
			start.count :
			end.kind === "span" || end.kind === "spanName" ?
				end.count :
				1;
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
	node: Node;
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
	baselineShims: Map<Node, number> | null;
}

function itemTrackRange(sizing: TrackSizing, item: GridItem): [number, number] {
	return sizing.columns ?
			[item.columnStart, item.columnEnd] :
			[item.rowStart, item.rowEnd];
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
			minContent ? MEASURE_MODE_AT_MOST : MEASURE_MODE_UNDEFINED,
			MEASURE_MODE_UNDEFINED,
			sizing.ownerWidth,
			sizing.ownerHeight,
			false,
		);
		return (
			child.layout.width +
			marginForAxis(child, FLEX_DIRECTION_ROW, sizing.ownerWidth)
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
		MEASURE_MODE_EXACTLY,
		MEASURE_MODE_UNDEFINED,
		sizing.ownerWidth,
		sizing.ownerHeight,
		false,
	);
	return (
		child.layout.height +
		marginForAxis(child, FLEX_DIRECTION_COLUMN, sizing.ownerWidth) +
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
	node: Node,
	items: GridItem[],
	columnSizes: number[],
	columnGap: number,
	ownerWidth: number,
	ownerHeight: number,
): Map<Node, number> {
	const shims = new Map<Node, number>();
	const rows = new Map<number, GridItem[]>();
	for (const item of items) {
		if (gridSelfAlign(node, item.node, false) !== ALIGN_BASELINE) {
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
				MEASURE_MODE_EXACTLY,
				MEASURE_MODE_UNDEFINED,
				ownerWidth,
				ownerHeight,
				false,
			);
			const baseline =
				resolveMargin(item.node.style.margin[EDGE_TOP], ownerWidth) +
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
		toLimits ?
			track.growthLimit === Infinity ?
				track.base :
				track.growthLimit :
			track.base;
	const limitOf = (track: GridTrack) =>
		toLimits ? track.fitContentLimit : track.growthLimit;

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
				limit === Infinity ?
					Infinity :
						Math.max(0, limit - startOf(track) - track.planned);
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
				kind === "min-content" ?
						gridItemContribution(sizing, item, true) :
					kind === "max-content" ?
							gridItemContribution(sizing, item, false) :
							minimumContribution(sizing, item, start, end);
			track.base = Math.max(track.base, floor);
		}
		if (intrinsicMax(track)) {
			const limit =
				track.size.max.kind === "min-content" ?
						gridItemContribution(sizing, item, true) :
						gridItemContribution(sizing, item, false);
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
		track.infinitelyGrowable = track.size.max.kind !== "min-content";
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
					(tracks[i].growthLimit === Infinity ?
						tracks[i].base :
						tracks[i].growthLimit),
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
		distributeExtraSpace(
			tracks,
			indices,
			minContent - limitSum() - gaps,
			true,
			intrinsicMax,
			intrinsicMax,
		);
		// 5. max-content maximums
		distributeExtraSpace(
			tracks,
			indices,
			maxContent - limitSum() - gaps,
			true,
			(track) =>
				track.size.max.kind === "max-content" || track.size.max.kind === "auto",
			(track) => track.size.max.kind === "max-content",
		);
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

const CONTENT_START = 0;
const CONTENT_CENTER = 1;
const CONTENT_END = 2;
const CONTENT_SPACE_BETWEEN = 3;
const CONTENT_SPACE_AROUND = 4;
const CONTENT_SPACE_EVENLY = 5;
/** `normal` and `stretch`: the tracks themselves take the free space (§12.8). */
const CONTENT_STRETCH = 6;

function inlineContentAlign(node: Node): number {
	switch (node.style.justifyContent) {
		case JUSTIFY_CENTER:
			return CONTENT_CENTER;
		case JUSTIFY_FLEX_END:
			return CONTENT_END;
		case JUSTIFY_SPACE_BETWEEN:
			return CONTENT_SPACE_BETWEEN;
		case JUSTIFY_SPACE_AROUND:
			return CONTENT_SPACE_AROUND;
		case JUSTIFY_SPACE_EVENLY:
			return CONTENT_SPACE_EVENLY;
		case JUSTIFY_NORMAL:
		case JUSTIFY_STRETCH:
			return CONTENT_STRETCH;
		default:
			return CONTENT_START;
	}
}

function blockContentAlign(node: Node): number {
	switch (node.style.alignContent) {
		case ALIGN_CENTER:
			return CONTENT_CENTER;
		case ALIGN_FLEX_END:
			return CONTENT_END;
		case ALIGN_SPACE_BETWEEN:
			return CONTENT_SPACE_BETWEEN;
		case ALIGN_SPACE_AROUND:
			return CONTENT_SPACE_AROUND;
		case ALIGN_SPACE_EVENLY:
			return CONTENT_SPACE_EVENLY;
		case ALIGN_NORMAL:
		case ALIGN_STRETCH:
			return CONTENT_STRETCH;
		default:
			return CONTENT_START;
	}
}

/**
 * A grid item's alignment on one axis: its own `*-self`, or the container's
 * `*-items` where that is `auto`. `normal` on a grid item means `stretch`
 * (css-align-3 §4.2), which is why an item with no width fills its area.
 */
function gridSelfAlign(container: Node, item: Node, inline: boolean): Align {
	const own = inline ? item.style.justifySelf : item.style.alignSelf;
	const fallback = inline ?
		container.style.justifyItems :
		container.style.alignItems;
	const value = own === ALIGN_AUTO ? fallback : own;
	return value === ALIGN_AUTO || value === ALIGN_NORMAL ? ALIGN_STRETCH : value;
}

/** Lay the tracks out across the content box, per justify-content/align-content. */
function positionTracks(
	tracks: GridTrack[],
	free: number,
	gap: number,
	align: number,
): void {
	const count = tracks.filter((track) => !track.collapsed).length;
	let leading = 0;
	let between = 0;
	switch (align) {
		case CONTENT_CENTER:
			leading = free / 2;
			break;
		case CONTENT_END:
			leading = free;
			break;
		case CONTENT_SPACE_BETWEEN:
			if (count > 1) {
				between = Math.max(free, 0) / (count - 1);
			}
			break;
		case CONTENT_SPACE_AROUND:
			if (count > 0) {
				between = Math.max(free, 0) / count;
				leading = between / 2;
			}
			break;
		case CONTENT_SPACE_EVENLY:
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
	node: Node,
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

	const autoLeft = child.style.margin[EDGE_LEFT].unit === UNIT_AUTO;
	const autoRight = child.style.margin[EDGE_RIGHT].unit === UNIT_AUTO;
	const autoTop = child.style.margin[EDGE_TOP].unit === UNIT_AUTO;
	const autoBottom = child.style.margin[EDGE_BOTTOM].unit === UNIT_AUTO;

	const marginRow = marginForAxis(child, FLEX_DIRECTION_ROW, ownerWidth);
	const marginColumn = marginForAxis(child, FLEX_DIRECTION_COLUMN, ownerWidth);

	const childWidth = {value: NaN, mode: MEASURE_MODE_UNDEFINED};
	const childHeight = {value: NaN, mode: MEASURE_MODE_UNDEFINED};

	if (styleDimIsDefined(child, FLEX_DIRECTION_ROW, ownerWidth)) {
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				FLEX_DIRECTION_ROW,
				resolveValue(child.style.width, ownerWidth),
				areaWidth,
			) + marginRow;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else if (justify === ALIGN_STRETCH && !autoLeft && !autoRight) {
		// An area is a definite size, so a stretched item takes all of it --
		// the value offered includes the item's own margins, which the box
		// takes off for itself.
		childWidth.value = Math.max(0, areaWidth);
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else {
		childWidth.value = Math.max(0, areaWidth);
		childWidth.mode = MEASURE_MODE_AT_MOST;
	}

	if (styleDimIsDefined(child, FLEX_DIRECTION_COLUMN, ownerHeight)) {
		childHeight.value =
			boundAxisWithinMinMax(
				child,
				FLEX_DIRECTION_COLUMN,
				resolveValue(child.style.height, ownerHeight),
				areaHeight,
			) + marginColumn;
		childHeight.mode = MEASURE_MODE_EXACTLY;
	} else if (align === ALIGN_STRETCH && !autoTop && !autoBottom) {
		childHeight.value = Math.max(0, areaHeight);
		childHeight.mode = MEASURE_MODE_EXACTLY;
	} else {
		childHeight.value = Math.max(0, areaHeight);
		childHeight.mode = MEASURE_MODE_AT_MOST;
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

	if (!performLayout) {
		return;
	}

	const freeX = areaWidth - child.layout.width - marginRow;
	const freeY = areaHeight - child.layout.height - marginColumn;

	child.layout.left =
		areaLeft +
		alignmentOffset(justify, freeX, autoLeft, autoRight) +
		resolveMargin(child.style.margin[EDGE_LEFT], ownerWidth);
	child.layout.top =
		areaTop +
		alignmentOffset(align, freeY, autoTop, autoBottom) +
		resolveMargin(child.style.margin[EDGE_TOP], ownerWidth);
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
		case ALIGN_CENTER:
			return free / 2;
		case ALIGN_FLEX_END:
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
	node: Node,
	items: GridItem[],
	ownerWidth: number,
): void {
	const rows = new Map<number, GridItem[]>();
	for (const item of items) {
		if (gridSelfAlign(node, item.node, false) !== ALIGN_BASELINE) {
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
	const contentLeft = paddingAndBorderForEdge(node, EDGE_LEFT, ownerWidth);
	const contentTop = paddingAndBorderForEdge(node, EDGE_TOP, ownerWidth);

	const innerWidth = isDefined(availableWidth) ?
			Math.max(0, availableWidth - marginRow - paddingBorderRow) :
		NaN;
	const innerHeight = isDefined(availableHeight) ?
			Math.max(0, availableHeight - marginColumn - paddingBorderColumn) :
		NaN;

	const columnGap = node.style.gap[GUTTER_COLUMN];
	const rowGap = node.style.gap[GUTTER_ROW];

	const definiteWidth =
		widthMode === MEASURE_MODE_EXACTLY && isDefined(innerWidth);
	const definiteHeight =
		heightMode === MEASURE_MODE_EXACTLY && isDefined(innerHeight);

	// -- grid items ---------------------------------------------------------
	const children: Node[] = [];
	for (const child of node.children) {
		if (child.style.display === DISPLAY_NONE) {
			zeroLayout(child);
			continue;
		}
		resolveNodeMargins(child, ownerWidth);
		if (child.style.positionType === POSITION_TYPE_ABSOLUTE) {
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
	const fromAreas = areas ?
			areaLineNames(areas) :
			{columns: new Map<string, number[]>(), rows: new Map<string, number[]>()};

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
			const size = explicit ?
				template.sizes[line] :
				autoSizes[implicit++ % autoSizes.length];
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
			stretchesAutoTracks: inlineAlign === CONTENT_STRETCH,
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
		widthMode === MEASURE_MODE_AT_MOST &&
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
			stretchesAutoTracks: blockAlign === CONTENT_STRETCH,
			baselineShims,
		});
		return tracks;
	};

	let rowTracks = sizeRows(definiteHeight ? innerHeight : NaN);
	let rowsTotal = totalOf(rowTracks, rowGap);
	if (
		heightMode === MEASURE_MODE_AT_MOST &&
		isDefined(innerHeight) &&
		rowsTotal > innerHeight + EPSILON
	) {
		rowTracks = sizeRows(innerHeight);
		rowsTotal = totalOf(rowTracks, rowGap);
	}

	// -- the grid container's own box ---------------------------------------
	const width =
		widthMode === MEASURE_MODE_EXACTLY ?
			availableWidth - marginRow :
				boundAxis(
					node,
					FLEX_DIRECTION_ROW,
					columnsTotal + paddingBorderRow,
					ownerWidth,
					ownerWidth,
				);
	const height =
		heightMode === MEASURE_MODE_EXACTLY ?
			availableHeight - marginColumn :
				boundAxis(
					node,
					FLEX_DIRECTION_COLUMN,
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
		if (child.style.positionType !== POSITION_TYPE_RELATIVE) {
			continue;
		}
		child.layout.left += relativeOffset(
			child,
			FLEX_DIRECTION_ROW,
			usedInnerWidth,
		);
		child.layout.top += relativeOffset(
			child,
			FLEX_DIRECTION_COLUMN,
			usedInnerHeight,
		);
	}

	// -- absolutely positioned children (css-grid-2 §9) ---------------------
	for (const child of node.children) {
		if (
			child.style.positionType !== POSITION_TYPE_ABSOLUTE ||
			child.style.display === DISPLAY_NONE
		) {
			continue;
		}
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
	node: Node,
	child: Node,
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

	const paddingLeft = node.style.border[EDGE_LEFT];
	const paddingTop = node.style.border[EDGE_TOP];
	const paddingRight = Math.max(
		0,
		node.layout.width - node.style.border[EDGE_RIGHT],
	);
	const paddingBottom = Math.max(
		0,
		node.layout.height - node.style.border[EDGE_BOTTOM],
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
function readCollapseTop(child: Node, into: MarginSet): void {
	clearMarginSet(into);
	addMargin(into, child.layout.margin[EDGE_TOP]);
	into.positive = Math.max(into.positive, child.layout.collapseTopPositive);
	into.negative = Math.min(into.negative, child.layout.collapseTopNegative);
}

/** The margins that adjoin a child's bottom edge: its own, plus what escapes it. */
function readCollapseBottom(child: Node, into: MarginSet): void {
	clearMarginSet(into);
	addMargin(into, child.layout.margin[EDGE_BOTTOM]);
	into.positive = Math.max(into.positive, child.layout.collapseBottomPositive);
	into.negative = Math.min(into.negative, child.layout.collapseBottomNegative);
}

/** A box that wraps its own content rather than filling its container. */
function shrinkWrapsWidth(node: Node): boolean {
	return (
		node.style.display === DISPLAY_TABLE ||
		node.style.widthSizing !== SIZING_NONE
	);
}

/**
 * Lay a block-level child out against the width its container offers it: an
 * explicit width wins, a box that fills takes the whole content width, and one
 * that wraps its content -- a table, or a box whose auto margins are waiting
 * for space to absorb -- takes no more than it.
 */
function layoutBlockChild(
	child: Node,
	contentWidth: number,
	fill: boolean,
	ownerWidth: number,
	ownerHeight: number,
	performLayout: boolean,
): void {
	const marginRow = marginForAxis(child, FLEX_DIRECTION_ROW, ownerWidth);
	const marginColumn = marginForAxis(child, FLEX_DIRECTION_COLUMN, ownerWidth);

	const childWidth = {value: NaN, mode: MEASURE_MODE_UNDEFINED};
	const childHeight = {value: NaN, mode: MEASURE_MODE_UNDEFINED};

	if (styleDimIsDefined(child, FLEX_DIRECTION_ROW, ownerWidth)) {
		childWidth.value =
			boundAxisWithinMinMax(
				child,
				FLEX_DIRECTION_ROW,
				resolveValue(child.style.width, ownerWidth),
				contentWidth,
			) + marginRow;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else if (
		isDefined(child.style.aspectRatio) &&
		child.style.aspectRatio > 0 &&
		styleDimIsDefined(child, FLEX_DIRECTION_COLUMN, ownerHeight)
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
				FLEX_DIRECTION_ROW,
				transferred,
				contentWidth,
			) + marginRow;
		childWidth.mode = MEASURE_MODE_EXACTLY;
	} else if (child.style.widthSizing === SIZING_MIN_CONTENT) {
		// The min-content probe: an AT_MOST offer of zero breaks the content
		// at its narrowest, and the wrapped width is the box's.
		childWidth.value = 0;
		childWidth.mode = MEASURE_MODE_AT_MOST;
	} else if (child.style.widthSizing === SIZING_MAX_CONTENT) {
		// An undefined offer measures the content unbroken, so the box takes
		// its max-content width whatever the container offers.
	} else if (isDefined(contentWidth)) {
		// A non-filling child's AT_MOST offer is fit-content already:
		// min(max-content, max(min-content, available)).
		childWidth.value = contentWidth;
		childWidth.mode = fill ? MEASURE_MODE_EXACTLY : MEASURE_MODE_AT_MOST;
	}

	if (styleDimIsDefined(child, FLEX_DIRECTION_COLUMN, ownerHeight)) {
		childHeight.value =
			resolveValue(child.style.height, ownerHeight) + marginColumn;
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
		performLayout,
	);
}

/**
 * An anonymous box that broke into no line at all -- collapsible white space
 * between two block boxes -- occupies nothing and separates nothing, so the
 * margins on either side of it go on adjoining (css2 §9.4.2, §8.3.1).
 */
function generatesNoLine(child: Node): boolean {
	return child.measureFunc !== null && child.layout.height === 0;
}

/** Whether a child fills the container's content width rather than wrapping. */
function blockChildFills(child: Node): boolean {
	return (
		!shrinkWrapsWidth(child) &&
		child.style.margin[EDGE_LEFT].unit !== UNIT_AUTO &&
		child.style.margin[EDGE_RIGHT].unit !== UNIT_AUTO
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

	// -- in-flow children ---------------------------------------------------

	const inFlow: Node[] = [];
	for (const child of node.children) {
		if (child.style.display === DISPLAY_NONE) {
			zeroLayout(child);
			continue;
		}
		resolveNodeMargins(child, ownerWidth);
		if (child.style.positionType === POSITION_TYPE_ABSOLUTE) {
			continue;
		}
		inFlow.push(child);
	}

	const innerWidth = isDefined(availableWidth) ?
			Math.max(0, availableWidth - marginRow - paddingBorderRow) :
		NaN;

	// -- content width ------------------------------------------------------
	//
	// Resolved before the children are laid out, min/max included, so that each
	// one is measured exactly once at the width it will keep.

	let borderBoxWidth: number;
	if (widthMode === MEASURE_MODE_EXACTLY) {
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
				marginForAxis(child, FLEX_DIRECTION_ROW, ownerWidth),
			);
		}
		borderBoxWidth = widest + paddingBorderRow;
	}
	borderBoxWidth = boundAxis(
		node,
		FLEX_DIRECTION_ROW,
		borderBoxWidth,
		ownerWidth,
		ownerWidth,
	);
	const contentWidth = Math.max(0, borderBoxWidth - paddingBorderRow);

	// -- stacking -----------------------------------------------------------

	const openTop =
		!node.style.blockFormattingContext &&
		paddingAndBorderForEdge(node, EDGE_TOP, ownerWidth) === 0;
	const openBottom =
		!node.style.blockFormattingContext &&
		paddingAndBorderForEdge(node, EDGE_BOTTOM, ownerWidth) === 0 &&
		heightMode !== MEASURE_MODE_EXACTLY &&
		!styleDimIsDefined(node, FLEX_DIRECTION_COLUMN, ownerHeight);

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
		heightMode === MEASURE_MODE_EXACTLY ?
			availableHeight - marginColumn :
			Math.max(0, contentHeight) + paddingBorderColumn;

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
		const leading = child.layout.margin[EDGE_LEFT];
		const trailing = child.layout.margin[EDGE_RIGHT];
		const leadingAuto = child.style.margin[EDGE_LEFT].unit === UNIT_AUTO;
		const trailingAuto = child.style.margin[EDGE_RIGHT].unit === UNIT_AUTO;
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
		if (child.style.positionType !== POSITION_TYPE_RELATIVE) {
			continue;
		}
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

/** Dispatch: measure leaf, empty container, or full flexbox. */
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
	// css-sizing-4 §5: an aspect ratio takes a box's one settled axis to the
	// other. An axis offered EXACTLY is settled -- by a definite size or by
	// stretch-fit -- and the open axis follows it through the ratio; when both
	// axes are settled the ratio yields. Margins sit outside the box, so they
	// come off the settled offer and go back onto the derived one. Min/max on
	// the derived axis still clamp, in setMeasuredDimensions. The ratio counts
	// cells: one cell is one cell, vertical or horizontal.
	const ratio = node.style.aspectRatio;
	if (isDefined(ratio) && ratio > 0) {
		const marginRow = marginForAxis(node, FLEX_DIRECTION_ROW, ownerWidth);
		const marginColumn = marginForAxis(
			node,
			FLEX_DIRECTION_COLUMN,
			ownerWidth,
		);
		if (
			widthMode === MEASURE_MODE_EXACTLY &&
			heightMode !== MEASURE_MODE_EXACTLY &&
			isDefined(availableWidth)
		) {
			availableHeight = (availableWidth - marginRow) / ratio + marginColumn;
			heightMode = MEASURE_MODE_EXACTLY;
		} else if (
			heightMode === MEASURE_MODE_EXACTLY &&
			widthMode !== MEASURE_MODE_EXACTLY &&
			isDefined(availableHeight)
		) {
			availableWidth = (availableHeight - marginColumn) * ratio + marginRow;
			widthMode = MEASURE_MODE_EXACTLY;
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

	// A box that is not a block container escapes no margins: only block layout
	// writes these, so every other mode has to say so for itself.
	node.layout.collapseTopPositive = 0;
	node.layout.collapseTopNegative = 0;
	node.layout.collapseBottomPositive = 0;
	node.layout.collapseBottomNegative = 0;
	node.layout.selfCollapsing = false;

	// Used track sizes belong to a grid container and nothing else: a box that
	// stopped being one must stop reporting them.
	if (node.style.display !== DISPLAY_GRID) {
		node.layout.gridColumns = null;
		node.layout.gridRows = null;
	}

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

	if (node.style.display === DISPLAY_GRID) {
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

	// A table cell and a table caption are block containers for their own
	// content, whatever the grid around them does with their boxes.
	if (
		node.style.display === DISPLAY_BLOCK ||
		node.style.display === DISPLAY_TABLE_CELL ||
		node.style.display === DISPLAY_TABLE_CAPTION
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
	ALIGN_NORMAL,
	// css-align-3 spells the flex-relative keywords `start` and `end` too, and
	// on a horizontal-tb grid they name the same edges.
	ALIGN_START: ALIGN_FLEX_START,
	ALIGN_END: ALIGN_FLEX_END,
	ALIGN_SELF_START: ALIGN_FLEX_START,
	ALIGN_SELF_END: ALIGN_FLEX_END,
	ALIGN_LEFT: ALIGN_FLEX_START,
	ALIGN_RIGHT: ALIGN_FLEX_END,

	JUSTIFY_FLEX_START,
	JUSTIFY_CENTER,
	JUSTIFY_FLEX_END,
	JUSTIFY_SPACE_BETWEEN,
	JUSTIFY_SPACE_AROUND,
	JUSTIFY_SPACE_EVENLY,
	JUSTIFY_NORMAL,
	JUSTIFY_STRETCH,
	JUSTIFY_START: JUSTIFY_FLEX_START,
	JUSTIFY_END: JUSTIFY_FLEX_END,
	JUSTIFY_LEFT: JUSTIFY_FLEX_START,
	JUSTIFY_RIGHT: JUSTIFY_FLEX_END,

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
	DISPLAY_BLOCK,
	DISPLAY_TABLE,
	DISPLAY_TABLE_ROW_GROUP,
	DISPLAY_TABLE_HEADER_GROUP,
	DISPLAY_TABLE_FOOTER_GROUP,
	DISPLAY_TABLE_ROW,
	DISPLAY_TABLE_CELL,
	DISPLAY_TABLE_CAPTION,
	DISPLAY_GRID,

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

	SIZING_NONE,
	SIZING_MIN_CONTENT,
	SIZING_MAX_CONTENT,
	SIZING_FIT_CONTENT,
};

export default Flex;
