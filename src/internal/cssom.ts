import * as CSSTree from "css-tree/dist/csstree.esm";

import {
	CSS_AT_RULE_DESCRIPTORS,
	CSS_INITIAL_VALUES,
	CSS_LONGHANDS,
	CSS_PROPERTIES,
} from "../generated/cssproperties.ts";
import {
	type CompiledSelector,
	compileSelector,
	type HasResults,
	matchesCompiled,
	parseSelectorList,
	selectAllCompiled,
	type SelectorNamespaces,
} from "./cssselectors.ts";
import * as CSSValues from "./cssvalues.ts";
import {
	dispatchAsUserAgent,
	type Document as DOMDocument,
	type Element as DOMElement,
	type Node as DOMNode,
	dropPseudoElement,
	ensurePseudoElement,
	flatParentElement,
	flushLayout,
	flushStyle,
	getAttributeList,
	getCellPixels,
	getCellSizeSetting,
	getClassTokens,
	getDocumentExchange,
	getHighlightRegistry,
	getPseudoHost,
	getPseudoName,
	getShadowRoot,
	HTML_NAMESPACE,
	isButtonInput,
	isUAShadowTree,
	MATHML_NAMESPACE,
	pseudoElement,
	pseudoElementCount,
	releaseRemovedNodes,
	reobserveShadowRoot,
	styleElementCount,
	TransitionEvent,
	type Window,
} from "./dom.ts";
import {LINE_STYLES, type LineStyle} from "./framebuffer.ts";
import {
	getPresentationalHints,
	isHintAttribute,
	isLayoutHintAttribute,
} from "./hints.ts";
import type {Layout} from "./layout.ts";
import {getStringWidth, splitOnASCIIWhitespace} from "./text.ts";
import {
	UA_CONTROL_STYLES,
	UA_DOCUMENT_STYLES,
	UA_ELEMENT_STYLES,
} from "./useragent.ts";

// What one terminal cell measures in CSS pixels, per document. Layout
// counts cells; everything a page writes or reads counts CSS pixels. At
// the default unit size the two are the same number.

export interface CellSize {
	width: number;
	height: number;
}

export const UNIT_CELL: Readonly<CellSize> = {width: 1, height: 1};

/**
 * How the page's lengths map to cells: one CSS pixel a cell, the
 * terminal's pixels once it reports them, or a size the program gives.
 */
export type CellSizeSetting = "unit" | "auto" | Readonly<CellSize>;

export function getCellSize(node: Node | null | undefined): Readonly<CellSize> {
	const setting = node ? getCellSizeSetting(node) : undefined;
	if (setting === undefined || setting === "unit") {
		return UNIT_CELL;
	}
	return setting === "auto" ? getCellPixels(node!)! : setting;
}

/**
 * The cell an image's pixels divide by. An image's pixels are CSS
 * pixels, so this is the page's cell. Under the unit cell that would be
 * a cell per pixel, so the screen's cell stands in. A document no TermDOM
 * draws has no screen, and draws no image.
 */
export function getImageCellSize(
	node: Node | null | undefined,
): Readonly<CellSize> {
	const page = getCellSize(node);
	if (page !== UNIT_CELL) {
		return page;
	}
	return (node && getCellPixels(node)) ?? page;
}

/**
 * CSS pixels along one axis as cells, fractions kept. Layout rounds the
 * edges of the boxes it places, not each length, so lengths that add up
 * still add up.
 */
function cellsFromPx(
	px: number,
	vertical: boolean,
	node: Node | null | undefined,
): number {
	const cell = getCellSize(node);
	const size = vertical ? cell.height : cell.width;
	return px / size;
}

/** Cells along one axis as CSS pixels. */
export function pxFromCells(
	cells: number,
	vertical: boolean,
	node: Node | null | undefined,
): number {
	const cell = getCellSize(node);
	return cells * (vertical ? cell.height : cell.width);
}

// Per-element defaults that are STATE, not stylesheet: the fullscreen
// element's viewport block, a select sized to its widest option label so
// the text control never jumps, the size attribute driving an input's width.
// Everything expressible as CSS lives in UA_ELEMENT_STYLES.
function getElementDefaults(
	element: Element,
): Record<string, string> | undefined {
	if (element.namespaceURI === MATHML_NAMESPACE) {
		return getMathMLDefaults(element);
	}
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return undefined;
	}
	const name = element.localName;
	const document = element.ownerDocument;
	if (document !== null && document.fullscreenElement === element) {
		const window = document.defaultView;
		if (window) {
			return {
				position: "fixed",
				top: "0px",
				left: "0px",
				width: `${window.innerWidth}px`,
				height: `${window.innerHeight}px`,
				"background-color": "Canvas",
			};
		}
	}
	if (name === "select") {
		const select = element as HTMLSelectElement;
		let widest = 0;
		for (const option of select.options) {
			widest = Math.max(widest, getStringWidth(option.label));
		}
		return {width: `${widest + 2}ch`};
	}
	if (name === "input") {
		const input = element as HTMLInputElement;
		if (
			input.type === "checkbox" ||
			input.type === "radio" ||
			isButtonInput(input)
		) {
			return undefined;
		}
		// A text input's width is attribute state: size columns when the
		// attribute is set, the spec's 20 otherwise. It lives here rather than
		// in the sheet so the attribute can override the default without a
		// width the sheet cannot express (there is no attr() length).
		const size = parseInt(input.getAttribute("size") ?? "", 10);
		return {width: `${Number.isFinite(size) && size > 0 ? size : 20}ch`};
	}
	return undefined;
}

// MathML Core's presentational hints: mathcolor, mathbackground and
// displaystyle map onto color, background-color and math-style.
function getMathMLDefaults(
	element: Element,
): Record<string, string> | undefined {
	let defaults: Record<string, string> | undefined;
	const color = element.getAttribute("mathcolor");
	if (color !== null && color.trim() !== "") {
		(defaults ??= {}).color = color.trim();
	}
	const background = element.getAttribute("mathbackground");
	if (background !== null && background.trim() !== "") {
		(defaults ??= {})["background-color"] = background.trim();
	}
	const displaystyle = element
		.getAttribute("displaystyle")
		?.trim()
		.toLowerCase();
	if (displaystyle === "true" || displaystyle === "false") {
		(defaults ??= {})["math-style"] = displaystyle === "true"
			? "normal"
			: "compact";
	}
	return defaults;
}

function getInitialStyle(element: Element | null, property: string): string {
	const elementDefaults = element ? getElementDefaults(element) : null;
	if (elementDefaults && elementDefaults[property]) {
		return elementDefaults[property];
	}
	return getInitialValueFor(element, property);
}

// A cell's height is the medium font size: one line of text is one row.
function getInitialValueFor(node: Node | null, property: string): string {
	return property === "font-size"
		? `${getCellSize(node).height}px`
		: CSSValues.getInitialValue(property);
}

/**
 * A length the engine reads, in whole cells along its axis. A percentage
 * stays one, for the caller to resolve against a basis in cells.
 */
export function toCellLength(
	value: CSSValues.UnitValue,
	vertical: boolean,
	node: Node,
): CSSValues.UnitValue {
	return typeof value === "number" ? cellsFromPx(value, vertical, node) : value;
}

// A border a terminal draws is a line of glyphs, so a border that is
// there at all is at least one cell.
export function toCellBorder(
	value: CSSValues.UnitValue,
	vertical: boolean,
	node: Node,
): CSSValues.UnitValue {
	if (typeof value !== "number" || value <= 0) {
		return value;
	}
	const cell = getCellSize(node);
	return (vertical ? cell.height : cell.width) === 1
		? value
		: Math.max(1, Math.round(cellsFromPx(value, vertical, node)));
}

/**
 * How many cells a tab stop spans: a count of spaces, each a cell, or a
 * length measured across. 8 where the value is neither.
 */
export function getTabSize(element: Element | null): number {
	if (element === null) {
		return 8;
	}
	const value = getComputedValue(element, "tab-size").trim();
	if (/^\d+(?:\.\d+)?$/.test(value)) {
		return parseFloat(value);
	}
	const length = toCellLength(CSSValues.parseUnitValue(value), false, element);
	return typeof length === "number" && length >= 0 ? Math.round(length) : 8;
}

/** A length in whole cells, an exact half rounding toward zero. */
export function toWholeCells(cells: number): number {
	return Math.sign(cells) * Math.ceil(Math.abs(cells) - 0.5);
}

/**
 * An element's vertical margin in whole rows, so the same margin draws the
 * same gap, or what toCellLength gives one it cannot resolve yet.
 */
export function getCellBlockMargin(
	element: Element,
	edge: "top" | "bottom",
): ReturnType<typeof toCellLength> {
	const margin = toCellLength(
		CSSValues.parseSignedUnitValue(getComputedValue(element, `margin-${edge}`)),
		true,
		element,
	);
	return typeof margin === "number" ? toWholeCells(margin) : margin;
}

/** A vertical size in whole rows, as a vertical margin is. */
export function getCellBlockSize(
	element: Element,
	property: "height" | "min-height" | "max-height",
): ReturnType<typeof toCellLength> {
	const size = toCellLength(
		CSSValues.parseUnitValue(getComputedValue(element, property)),
		true,
		element,
	);
	return typeof size === "number" ? toWholeCells(size) : size;
}

/**
 * An element's padding in cells, or what toCellLength gives a side it
 * cannot resolve yet. Equal opposite sides stay equal: each is a whole
 * number of cells, an exact half rounding down.
 */
export function getCellPadding(
	element: Element,
): Record<
	"top" | "right" | "bottom" | "left",
	ReturnType<typeof toCellLength>
> {
	const side = (edge: string, vertical: boolean) =>
		toCellLength(
			CSSValues.parseUnitValue(getComputedValue(element, `padding-${edge}`)),
			vertical,
			element,
		);
	const padding = {
		top: side("top", true),
		right: side("right", false),
		bottom: side("bottom", true),
		left: side("left", false),
	};
	for (const [start, end] of [["top", "bottom"], ["left", "right"]] as const) {
		const length = padding[start];
		if (typeof length === "number" && length === padding[end]) {
			padding[start] = padding[end] = toWholeCells(length);
		}
	}
	return padding;
}

/** An element's margins, borders and padding, in cells. */
export function getBoxModel(element: Element): CSSValues.BoxModel {
	// The engine's own read: the cascade's declaration directly, without
	// the author path's resolved-value work.
	const length = (property: string, vertical: boolean, signed = false) =>
		toCellLength(
			signed
				? CSSValues.parseSignedUnitValue(getComputedValue(element, property))
				: CSSValues.parseUnitValue(getComputedValue(element, property)),
			vertical,
			element,
		);
	const widthValue = length("width", false);
	const heightValue = getCellBlockSize(element, "height");

	const {
		top: paddingTop,
		right: paddingRight,
		bottom: paddingBottom,
		left: paddingLeft,
	} = getCellPadding(element);

	const marginTop = getCellBlockMargin(element, "top");
	const marginRight = length("margin-right", false, true);
	const marginBottom = getCellBlockMargin(element, "bottom");
	const marginLeft = length("margin-left", false, true);

	// The used width is 0 when the side's style is none or hidden
	// (css-backgrounds §3.3). `border-style: none` must release the space.
	const borderWidthFor = (side: string) => {
		const style = getComputedValue(element, `border-${side}-style`);
		if (!style || style === "none" || style === "hidden") {
			return null;
		}
		return toCellBorder(
			CSSValues.parseBorderWidthValue(
				getComputedValue(element, `border-${side}-width`),
			),
			side === "top" || side === "bottom",
			element,
		);
	};
	const borderTopWidth = borderWidthFor("top");
	const borderRightWidth = borderWidthFor("right");
	const borderBottomWidth = borderWidthFor("bottom");
	const borderLeftWidth = borderWidthFor("left");

	return {
		width: typeof widthValue === "number" ? widthValue : undefined,
		height: typeof heightValue === "number" ? heightValue : undefined,
		paddingTop: typeof paddingTop === "number" ? paddingTop : 0,
		paddingRight: typeof paddingRight === "number" ? paddingRight : 0,
		paddingBottom: typeof paddingBottom === "number" ? paddingBottom : 0,
		paddingLeft: typeof paddingLeft === "number" ? paddingLeft : 0,
		marginTop: typeof marginTop === "number" ? marginTop : 0,
		marginRight: typeof marginRight === "number" ? marginRight : 0,
		marginBottom: typeof marginBottom === "number" ? marginBottom : 0,
		marginLeft: typeof marginLeft === "number" ? marginLeft : 0,
		borderTopWidth: typeof borderTopWidth === "number" ? borderTopWidth : 0,
		borderRightWidth: typeof borderRightWidth === "number"
			? borderRightWidth
			: 0,
		borderBottomWidth: typeof borderBottomWidth === "number"
			? borderBottomWidth
			: 0,
		borderLeftWidth: typeof borderLeftWidth === "number" ? borderLeftWidth : 0,
	};
}

// The entry point for every read of the cascade from a node, including
// reads deep inside the cascade itself that have no Cascade in
// hand.
const documentCascades = new WeakMap<object, Cascade>();
const kHasResults = Symbol("hasResults");
const kHasStates = Symbol("hasStates");

// What list-style-type spells, quoted the way a content value is
// written. Null outside a list.
function getDefaultMarkerContent(hostElement: Element): string | null {
	const listParent = hostElement.parentElement;
	if (!listParent) {
		return null;
	}
	const marker = getListMarker(hostElement, listParent);
	return marker ? `"${CSSValues.withMarkerSeparator(marker)}"` : null;
}

// What a list numbers: an li, or anything an author styled as one. A
// parent of any kind can hold them; ol's start and reversed read as
// absent on any other.
function isListItem(element: Element): boolean {
	return (
		(element.localName === "li" && element.namespaceURI === HTML_NAMESPACE) ||
		getComputedValue(element, "display") === "list-item"
	);
}

function getListItems(listParent: Element): Element[] {
	return Array.from(listParent.children).filter(isListItem);
}

function getListNestingDepth(element: Element): number {
	let depth = 0;
	for (
		let parent = element.parentElement; parent; parent = parent.parentElement
	) {
		if (parent.tagName === "UL" || parent.tagName === "OL") {
			depth++;
		}
	}
	return depth;
}

/** Lists whose gutter is being measured, to stop re-entrant computation. */
const listGutterInProgress = new WeakSet<Element>();

/** Minimum gutter a UL/OL reserves for its markers, in cells. */
const DEFAULT_LIST_GUTTER = 4;

// Markers are right-aligned against the content edge, so the gutter
// must fit the widest one, measured from the resolved ::marker content
// in cells. The default marker misses `::marker { content: ">>>>>> " }`,
// and .length undercounts a wide-character marker.
function getListGutterWidth(listElement: Element): number {
	if (listGutterInProgress.has(listElement)) {
		return DEFAULT_LIST_GUTTER;
	}
	listGutterInProgress.add(listElement);
	try {
		const cascade = documentCascades.get(listElement.ownerDocument);

		let widest = 0;
		for (const child of Array.from(listElement.children)) {
			if (child.tagName !== "LI") {
				continue;
			}
			const marker = cascade
				? cascade.getMarkerContent(child)
				: CSSValues.withMarkerSeparator(getListMarker(child, listElement));
			if (!marker) {
				continue;
			}
			widest = Math.max(widest, getStringWidth(marker));
		}
		return Math.max(DEFAULT_LIST_GUTTER, widest);
	} finally {
		listGutterInProgress.delete(listElement);
	}
}

const CSSNamespace = {
	escape(ident: string): string {
		if (arguments.length === 0) {
			throw typeError("escape requires an identifier");
		}
		return CSSValues.serializeCSSIdentifier(String(ident));
	},
	supports: CSSValues.cssSupports,
};
// A namespace object's class string is its name, and is not writable.
Object.defineProperty(CSSNamespace, Symbol.toStringTag, {
	value: "CSS",
	writable: false,
	enumerable: false,
	configurable: true,
});

// The highlight registry belongs to one document, so each window gets a
// CSS of its own. A namespace object's members are its own properties,
// class string included, so they are copied rather than inherited.
function createCSSNamespace(document: Document): typeof CSSNamespace {
	const namespace =
		Object.defineProperties({}, Object.getOwnPropertyDescriptors(
			CSSNamespace,
		)) as typeof CSSNamespace;
	Object.defineProperty(namespace, "highlights", {
		value: getHighlightRegistry(document),
		enumerable: true,
	});
	return namespace;
}

const inlineStyles = new WeakMap<Element, CSSStyleDeclaration>();

const kLayout = Symbol("layout");
const kStylesheetsDirty = Symbol("stylesheetsDirty");
const kParsing = Symbol("parsing");
const kPseudoHosts = Symbol("pseudoHosts");
// The root of the shared tables, emptied by a full parse: every key holds
// rule ids, which a parse renews, so nothing under the old root is reached
// again.
const kSharedRoot = Symbol("sharedRoot");
const kElement = Symbol("element");
const kViewOf = Symbol("viewOf");
const kComputedValue = Symbol("computedValue");
const kCustomProperties = Symbol("customProperties");
const kParentRule = Symbol("parentRule");
const kOnChange = Symbol("onChange");
const kDescriptors = Symbol("descriptors");
const kKeyframe = Symbol("keyframe");
const kAttributeText = Symbol("attributeText");
const kDeclarations = Symbol("declarations");
const kByName = Symbol("byName");
const kBlock = Symbol("block");
const kIndexed = Symbol("indexed");
const kSync = Symbol("sync");

// Declarations are stored as longhands. A shorthand write expands and a
// shorthand read reconstructs. An element-owned block and the `style`
// attribute are one store seen from two sides: a property write
// serializes through setAttribute, so attribute invalidation fires
// either way, and an attribute write reparses on the next read, detected
// by the text differing from what this object last serialized.
interface CSSStyleDeclaration {
	// Set on what getComputedStyle() hands a page: a plain declaration
	// that reads through to the engine's own computed one.
	[kViewOf]?: CSSStyleDeclaration;
	[kElement]: Element | null;
	[kParentRule]: CSSRule | null;
	[kOnChange]: (() => void) | null;

	// The at-rule whose descriptors this block holds, or empty for a block
	// of CSS properties. Only an at-rule's own grammar can validate its
	// descriptors.
	[kDescriptors]: string;

	[kKeyframe]: boolean;
	[kDeclarations]: CSSValues.CSSDeclaration[];

	// `all` expands to every longhand there is, and a scan per lookup would
	// make serializing such a block cubic in its size.
	[kByName]: Map<string, CSSValues.CSSDeclaration>;

	// The `style` attribute text this object last serialized or parsed.
	[kAttributeText]: string | null;

	// The declarations expanded to longhands for the cascade.
	[kBlock]: CSSValues.DeclarationBlock | null;

	// How many numeric index properties currently name a declaration.
	[kIndexed]: number;
}

class CSSStyleDeclaration {
	[index: number]: string;
	constructor(
		owner: {
			element?: Element;
			parentRule?: CSSRule;
			onChange?: () => void;
			descriptors?: string;
			keyframe?: boolean;
		} = {},
	) {
		this[kDeclarations] = [];
		this[kByName] = new Map<string, CSSValues.CSSDeclaration>();
		this[kAttributeText] = null;
		this[kBlock] = null;
		this[kIndexed] = 0;
		this[kElement] = owner.element ?? null;
		this[kParentRule] = owner.parentRule ?? null;
		this[kOnChange] = owner.onChange ?? null;
		this[kDescriptors] = owner.descriptors ?? "";
		this[kKeyframe] = Boolean(owner.keyframe);
	}

	get parentRule(): CSSRule | null {
		if (this[kViewOf] !== undefined) {
			return this[kViewOf].parentRule;
		}
		return this[kParentRule];
	}

	get length(): number {
		if (this[kViewOf] !== undefined) {
			syncViewIndices(this);
			return this[kViewOf].length;
		}
		this[kSync]!();
		return this[kDeclarations].length;
	}

	get cssText(): string {
		if (this[kViewOf] !== undefined) {
			return this[kViewOf].cssText;
		}
		this[kSync]!();
		return serializeDeclarations(this);
	}

	set cssText(text: string) {
		if (this[kViewOf] !== undefined) {
			this[kViewOf].cssText = text;
			return;
		}
		this[kSync]!();
		this[kDeclarations] = [];
		this[kByName].clear();
		for (const declaration of CSSValues.parseDeclarationText(text ?? "")) {
			if (!isSupportedDeclaration(this, declaration.name)) {
				continue;
			}
			applyDeclaration(
				this,
				declaration.name,
				declaration.value,
				declaration.important,
				true,
			);
		}
		flushStyleAttribute(this);
	}

	item(index: number): string {
		if (this[kViewOf] !== undefined) {
			return this[kViewOf].item(index);
		}
		this[kSync]!();
		return this[kDeclarations][index]?.name ?? "";
	}

	[Symbol.iterator](): IterableIterator<string> {
		if (this[kViewOf] !== undefined) {
			syncViewIndices(this);
			return this[kViewOf][Symbol.iterator]();
		}
		this[kSync]!();
		return this[kDeclarations].map((entry) => entry.name)[Symbol.iterator]();
	}

	getPropertyValue(property: string): string {
		if (this[kViewOf] !== undefined) {
			return this[kViewOf].getPropertyValue(property);
		}
		this[kSync]!();
		const name = CSSValues.normalizePropertyName(property);
		const declared = findDeclaration(this, name);
		if (declared) {
			return declared.value;
		}
		const longhands = CSSValues.getLonghands(name);
		return longhands ? getShorthandValue(this, name, longhands) : "";
	}

	getPropertyPriority(property: string): string {
		if (this[kViewOf] !== undefined) {
			return this[kViewOf].getPropertyPriority(property);
		}
		this[kSync]!();
		const name = CSSValues.normalizePropertyName(property);
		const declared = findDeclaration(this, name);
		if (declared) {
			return declared.important ? "important" : "";
		}
		const longhands = CSSValues.getLonghands(name);
		if (
			longhands &&
			longhands.every((longhand) => findDeclaration(this, longhand)?.important)
		) {
			return "important";
		}
		return "";
	}

	setProperty(property: string, value: string, priority?: string): void {
		if (this[kViewOf] !== undefined) {
			this[kViewOf].setProperty(property, value, priority);
			return;
		}
		this[kSync]!();
		const name = CSSValues.normalizePropertyName(property);
		if (!isSupportedDeclaration(this, name)) {
			return;
		}
		// `[LegacyNullToEmptyString]`: null means the empty value, which
		// removes the declaration. Every other value is stringified, and
		// `undefined` stringifies to a value no property accepts, so the call
		// does nothing.
		const text = CSSValues.serializeCSSValue(
			value === null ? "" : String(value),
			name,
		);
		if (text === "") {
			this.removeProperty(name);
			return;
		}
		const priorityText = String(priority ?? "").toLowerCase();
		if (priorityText !== "" && priorityText !== "important") {
			return;
		}
		if (applyDeclaration(this, name, text, priorityText === "important")) {
			flushStyleAttribute(this);
		}
	}

	removeProperty(property: string): string {
		if (this[kViewOf] !== undefined) {
			return this[kViewOf].removeProperty(property);
		}
		this[kSync]!();
		const name = CSSValues.normalizePropertyName(property);
		const previous = this.getPropertyValue(name);
		let changed = removeDeclaration(this, name);
		for (const longhand of CSSValues.getLonghands(name) ?? []) {
			changed = removeDeclaration(this, longhand) || changed;
		}
		if (changed) {
			flushStyleAttribute(this);
		}
		return previous;
	}

	/**
	 * Reparse the `style` attribute if it changed since this object last wrote
	 * it.
	 */
	[kSync]?(): void {
		if (!this[kElement]) {
			return;
		}
		const text = this[kElement].getAttribute("style") ?? "";
		if (text === this[kAttributeText]) {
			return;
		}
		this[kAttributeText] = text;
		this[kDeclarations] = [];
		this[kByName].clear();
		for (const declaration of CSSValues.parseDeclarationText(text)) {
			applyDeclaration(
				this,
				declaration.name,
				declaration.value,
				declaration.important,
				true,
			);
		}
		invalidateDeclaration(this);
	}
}

const kTransitionsExist = Symbol("transitionsExist");

const EMPTY_DECLARATIONS: CSSValues.DeclarationBlock = {
	declarations: {},
	important: {},
	order: {},
};

function getDeclarationBlock(
	style: CSSStyleDeclaration,
): CSSValues.DeclarationBlock {
	style[kSync]!();
	if (style[kDeclarations].length === 0) {
		return EMPTY_DECLARATIONS;
	}
	if (style[kBlock]) {
		return style[kBlock];
	}

	const declarations: Record<string, string> = {};
	const important: Record<string, boolean> = {};
	const order: Record<string, number> = {};
	const importantValues: Record<string, string> = {};
	let undecomposed = false;
	style[kDeclarations].forEach((entry, index) => {
		// An invalid declaration never enters the cascade. Dropping it lets a
		// lower-priority rule keep winning, as in a browser.
		if (!CSSValues.isValidDeclaration(entry.name, entry.value)) {
			return;
		}
		declarations[entry.name] = entry.value;
		order[entry.name] = index;
		if (entry.important) {
			important[entry.name] = true;
			importantValues[entry.name] = entry.value;
		}
		if (CSSValues.getLonghands(entry.name) !== undefined) {
			undecomposed = true;
		}
	});

	// The block parse is the one path both the attribute and setProperty
	// forms of an inline transition come through.
	if (
		style[kElement] &&
		(declarations["transition"] !== undefined ||
			declarations["transition-duration"] !== undefined ||
			declarations["transition-delay"] !== undefined)
	) {
		const document = style[kElement].ownerDocument;
		const cascade = document ? documentCascades.get(document) : undefined;
		if (cascade) {
			cascade[kTransitionsExist] = true;
		}
	}

	// A shorthand this engine does not decompose reaches the cascade as
	// whatever longhands it can name, with its importance applied to each.
	if (undecomposed) {
		for (const property of Object.keys(
			CSSValues.expandShorthands(importantValues),
		)) {
			important[property] = true;
		}
		style[kDeclarations].forEach((entry, index) => {
			const expanded = CSSValues.expandShorthands({[entry.name]: entry.value});
			for (const property in expanded) {
				order[property] = index;
			}
		});
		return (
			style[kBlock] = {
				declarations: CSSValues.expandShorthands(declarations),
				important,
				order,
			}
		);
	}
	return (style[kBlock] = {declarations, important, order});
}

// Reconstructs shorthands and keeps priority.
function serializeDeclarations(block: CSSStyleDeclaration): string {
	const parts: string[] = [];
	const serialized = new Set<string>();
	// A shorthand this block cannot express is unexpressible at every one
	// of its longhands, because the declarations do not change during the
	// walk.
	const unserializable = new Set<string>();
	for (const declaration of block[kDeclarations]) {
		if (serialized.has(declaration.name)) {
			continue;
		}
		let text = "";
		for (const shorthand of CSSValues.getShorthands(declaration.name)) {
			if (unserializable.has(shorthand)) {
				continue;
			}
			const longhands = CSSValues.getLonghands(shorthand)!;
			// A shorthand covering more properties than the block holds cannot
			// be serialized from it, and `all` covers hundreds.
			if (longhands.length > block[kDeclarations].length) {
				continue;
			}
			const value = getShorthandValue(block, shorthand, longhands);
			if (!value) {
				unserializable.add(shorthand);
				continue;
			}
			const important = findDeclaration(block, longhands[0])!.important;
			text = `${shorthand}: ${value}${important ? " !important" : ""};`;
			for (const longhand of longhands) {
				serialized.add(longhand);
			}
			break;
		}
		if (!text) {
			const priority = declaration.important ? " !important" : "";
			text = `${CSSValues.serializePropertyName(declaration.name)}: ${
				declaration.value
			}${priority};`;
			serialized.add(declaration.name);
		}
		parts.push(text);
	}
	return parts.join(" ");
}

// Serializes to the `style` attribute, which is what invalidation
// observes.
function flushStyleAttribute(declaration: CSSStyleDeclaration): void {
	invalidateDeclaration(declaration);
	if (declaration[kElement]) {
		declaration[kAttributeText] = serializeDeclarations(declaration);
		declaration[kElement].setAttribute("style", declaration[kAttributeText]);
	}
	declaration[kOnChange]?.();
}

function invalidateDeclaration(declaration: CSSStyleDeclaration): void {
	declaration[kBlock] = null;
	for (let i = 0; i < declaration[kIndexed]; i++) {
		delete declaration[i];
	}
	declaration[kIndexed] = declaration[kDeclarations].length;
	for (let i = 0; i < declaration[kIndexed]; i++) {
		declaration[i] = declaration[kDeclarations][i].name;
	}
}

function findDeclaration(
	declaration: CSSStyleDeclaration,
	property: string,
): CSSValues.CSSDeclaration | undefined {
	return declaration[kByName].get(property);
}

const KEYFRAME_EXCLUDED = /^animation(?:-|$)/;

const DESCRIPTOR_NAMES = new Map(
	Object.entries(CSS_AT_RULE_DESCRIPTORS)
		.map(([atRule, descriptors]) => [atRule, new Set(descriptors)] as const),
);

function isSupportedDeclaration(
	declaration: CSSStyleDeclaration,
	name: string,
): boolean {
	// A keyframe's block is one step of an animation, and the animation's
	// own properties describe the whole rather than the step.
	if (declaration[kKeyframe] && KEYFRAME_EXCLUDED.test(name)) {
		return false;
	}
	if (declaration[kDescriptors]) {
		// An at-rule's block holds its own descriptors. One this engine has no
		// descriptor list for accepts whatever it is given, which keeps
		// @font-feature-values' feature blocks working.
		const names = DESCRIPTOR_NAMES.get(declaration[kDescriptors]);
		return names ? names.has(name) : name !== "";
	}

	return CSSValues.isSupportedProperty(name);
}

// A declaration that changes the value moves to the END of the block.
// Restating one unchanged leaves it in place.
function storeDeclaration(
	declaration: CSSStyleDeclaration,
	name: string,
	value: string,
	important: boolean,
	cascade = false,
): boolean {
	const declared = findDeclaration(declaration, name);
	if (declared) {
		// Parsing a block is a cascade in miniature. A normal declaration does
		// not displace an important one already there.
		if (cascade && declared.important && !important) {
			return false;
		}
		if (declared.value === value && declared.important === important) {
			return false;
		}
		removeDeclaration(declaration, name);
	}
	const entry = {name, value, important};
	declaration[kDeclarations].push(entry);
	declaration[kByName].set(name, entry);
	return true;
}

function removeDeclaration(
	declaration: CSSStyleDeclaration,
	name: string,
): boolean {
	const index = declaration[kDeclarations].findIndex(
		(entry) => entry.name === name,
	);
	if (index === -1) {
		return false;
	}
	declaration[kDeclarations].splice(index, 1);
	declaration[kByName].delete(name);
	return true;
}

function applyDeclaration(
	declaration: CSSStyleDeclaration,
	name: string,
	value: string,
	important: boolean,
	cascade = false,
): boolean {
	// A declaration whose value does not parse is not stored at all, so a
	// shorthand with one bad component is dropped whole rather than leaving
	// its good components behind.
	if (!CSSValues.isValidDeclaration(name, value, declaration[kDescriptors])) {
		return false;
	}
	const expanded = CSSValues.expandShorthandValue(name, value);
	// A shorthand this engine does not decompose (`font: menu`, a system
	// font) is stored whole, and still covers its longhands: any declared
	// on their own are dropped, as the standard's set-a-declaration does.
	let changed = false;
	if (!expanded) {
		for (const longhand of CSSValues.getLonghands(name) ?? []) {
			if (
				cascade &&
				findDeclaration(declaration, longhand)?.important &&
				!important
			) {
				continue;
			}
			changed = removeDeclaration(declaration, longhand) || changed;
		}
		return storeDeclaration(declaration, name, value, important, cascade) ||
			changed;
	}
	changed = removeDeclaration(declaration, name);
	for (const longhand of CSSValues.getLonghands(name)!) {
		if (longhand in expanded) {
			continue;
		}
		if (
			cascade && findDeclaration(declaration, longhand)?.important && !important
		) {
			continue;
		}
		changed = removeDeclaration(declaration, longhand) || changed;
	}
	for (const [longhand, longhandValue] of Object.entries(expanded)) {
		changed =
			storeDeclaration(
				declaration,
				longhand,
				longhandValue,
				important,
				cascade,
			) || changed;
	}
	return changed;
}

// Returns "" when the longhands do not agree on one value.
function getShorthandValue(
	declaration: CSSStyleDeclaration,
	shorthand: string,
	longhands: readonly string[],
): string {
	let important: boolean | null = null;
	for (const longhand of longhands) {
		const declared = findDeclaration(declaration, longhand);
		if (!declared) {
			return "";
		}
		if (important === null) {
			important = declared.important;
		} else if (important !== declared.important) {
			return "";
		}
	}
	return CSSValues.serializeShorthandValue(
		shorthand,
		longhands,
		(longhand) => findDeclaration(declaration, longhand)!.value,
	);
}

// Reflects every property in the index as an IDL attribute, which is
// what separates it from an at-rule's descriptor blocks. `cssFloat`
// exists on a style rule's block and not on an @page's.
class CSSStyleProperties extends CSSStyleDeclaration {}

for (const property of CSS_PROPERTIES) {
	const descriptor: PropertyDescriptor = {
		get(this: CSSStyleDeclaration) {
			return this.getPropertyValue(property);
		},
		set(this: CSSStyleDeclaration, value: unknown) {
			this.setProperty(property, value == null ? "" : String(value));
		},
		configurable: true,
		enumerable: true,
	};
	const names = [CSSValues.camelCaseProperty(property)];
	if (property.startsWith("-webkit-")) {
		names.push(CSSValues.camelCaseProperty(property, true));
	}
	if (property !== names[0]) {
		names.push(property);
	}
	if (property === "float") {
		names.push("cssFloat");
	}
	for (const [index, name] of names.entries()) {
		Object.defineProperty(CSSStyleProperties.prototype, name, {
			...descriptor,
			enumerable: index === 0,
		});
	}
}

const pageViews = new WeakMap<CSSStyleDeclaration, CSSStyleProperties>();

// The engine resolves a computed style through classes of its own, which
// a page must not find in a prototype chain. What a page gets is a plain
// CSSStyleProperties that reads through to the engine's, one per
// declaration, so asking again returns the same object.
function getPageView(source: CSSStyleDeclaration): CSSStyleProperties {
	let view = pageViews.get(source);
	if (view === undefined) {
		view = Object.create(CSSStyleProperties.prototype) as CSSStyleProperties;
		view[kViewOf] = source;
		view[kIndexed] = 0;
		pageViews.set(source, view);
	}
	syncViewIndices(view);
	return view;
}

// A computed style lists a custom property only while one applies, so
// its indices follow its length each time the page reads it.
function syncViewIndices(view: CSSStyleDeclaration): void {
	const length = view[kViewOf]!.length;
	for (let index = view[kIndexed]; index < length; index++) {
		Object.defineProperty(view, index, {
			get(this: CSSStyleDeclaration): string {
				return this.item(index);
			},
			enumerable: true,
			configurable: true,
		});
	}
	for (let index = length; index < view[kIndexed]; index++) {
		delete (view as unknown as Record<number, string>)[index];
	}
	view[kIndexed] = length;
}

// An error thrown out of a stylesheet has to be the document's own
// DOMException. A sheet reaches its document through its owner node. A
// constructed sheet has none, and uses the window its constructor came
// from.
let cssomWindow: Window | null = null;

function getSheetView(
	sheet: CSSStyleSheet | null | undefined,
): object | undefined {
	const owner = sheet ? sheet.ownerNode : null;
	const document = owner === null ? null : owner.ownerDocument;
	return document === null ? undefined : (document.defaultView ?? undefined);
}

function typeError(message: string, sheet?: CSSStyleSheet | null): TypeError {
	const view = getSheetView(sheet) ?? cssomWindow ?? undefined;
	const Constructor =
		(view as unknown as {TypeError?: typeof TypeError} | undefined)
			?.TypeError ?? TypeError;
	return new Constructor(message);
}

function domException(
	message: string,
	name: string,
	sheet?: CSSStyleSheet | null,
): DOMException {
	const view = getSheetView(sheet) ?? cssomWindow ?? undefined;
	const Exception =
		(view as unknown as {DOMException?: typeof DOMException} | undefined)
			?.DOMException ?? DOMException;
	return new Exception(message, name);
}

// Registered per sheet rather than exposed on it, so a rule can reach
// its sheet's consumer without the sheet exposing a method authors
// should not see.
const sheetNotifiers = new WeakMap<CSSStyleSheet, () => void>();

// A rule tells its sheet when it changes, and a rule being built changes
// as it is filled in. Those changes are the sheet's own construction, so
// they reach no one: told per rule, a shadow root's sheet re-ran its
// root's restyle once for every rule, from inside the parse that restyle
// had started.
const sheetsBeingBuilt = new WeakSet<CSSStyleSheet>();

function sheetChanged(sheet: CSSStyleSheet | null | undefined): void {
	if (sheet && !sheetsBeingBuilt.has(sheet)) {
		sheetNotifiers.get(sheet)?.();
	}
}

function buildRules<T>(sheet: CSSStyleSheet | null, build: () => T): T {
	if (sheet === null || sheetsBeingBuilt.has(sheet)) {
		return build();
	}
	sheetsBeingBuilt.add(sheet);
	try {
		return build();
	} finally {
		sheetsBeingBuilt.delete(sheet);
	}
}

const kIndexCount = Symbol("index count");

interface IndexedCollection {
	readonly length: number;
	item(index: number): unknown;
	[kIndexCount]?: number;
	[index: number]: unknown;
}

// Provides `list[0]` alongside `list.item(0)`, reading through item() so
// the values stay live. Accessors beat a Proxy: every non-index read of
// a proxied list pays the get trap, and each method read pays a bind.
function syncIndexed(collection: object, items?: readonly unknown[]): void {
	const list = collection as IndexedCollection;
	const previous = list[kIndexCount] ?? 0;
	const length = items ? items.length : list.length;
	for (let index = previous; index < length; index++) {
		Object.defineProperty(list, index, {
			get: items
				? (): unknown => items[index]
				: (): unknown => list.item(index) ?? undefined,
			enumerable: true,
			configurable: true,
		});
	}
	for (let index = length; index < previous; index++) {
		delete list[index];
	}
	list[kIndexCount] = length;
}

const kMedia = Symbol("media");

export interface MediaList {
	// Mutated in place, so a list an author holds stays current.
	[kMedia]: string[];
	[kOnChange]: (() => void) | null;
}

/** The media queries a sheet or an `@media` rule applies under. */
export class MediaList implements globalThis.MediaList {
	[index: number]: string;

	constructor(mediaText = "", onChange?: () => void) {
		this[kMedia] = [];
		this[kOnChange] = onChange ?? null;
		parseMediaText(this, mediaText);
	}

	get mediaText(): string {
		return this[kMedia].join(", ");
	}

	set mediaText(text: string) {
		parseMediaText(this, text);
		this[kOnChange]?.();
	}

	get length(): number {
		return this[kMedia].length;
	}

	item(index: number): string | null {
		return this[kMedia][index] ?? null;
	}

	// Parsed as a SINGLE media query. A comma-separated list parses to
	// nothing and the call does nothing.
	appendMedium(medium: string): void {
		if (arguments.length === 0) {
			throw typeError("appendMedium requires a medium");
		}
		const text = CSSValues.stripCSSComments(String(medium));
		if (CSSValues.splitMediaQueryList(text).length !== 1) {
			return;
		}
		const query = CSSValues.serializeMediaQuery(text);
		if (!query || this[kMedia].includes(query)) {
			return;
		}
		this[kMedia].push(query);
		syncIndexed(this);
		this[kOnChange]?.();
	}

	deleteMedium(medium: string): void {
		if (arguments.length === 0) {
			throw typeError("deleteMedium requires a medium");
		}
		const text = CSSValues.stripCSSComments(String(medium));
		const query = CSSValues.splitMediaQueryList(text).length === 1
			? CSSValues.serializeMediaQuery(text)
			: "";
		const kept = this[kMedia].filter((entry) => entry !== query);
		if (kept.length === this[kMedia].length) {
			throw domException(`No such medium: ${medium}`, "NotFoundError");
		}
		this[kMedia].length = 0;
		this[kMedia].push(...kept);
		syncIndexed(this);
		this[kOnChange]?.();
	}

	[Symbol.iterator](): ArrayIterator<string> {
		return this[kMedia][Symbol.iterator]();
	}

	toString(): string {
		return this.mediaText;
	}
}

function parseMediaText(list: MediaList, text: string): void {
	list[kMedia].length = 0;
	for (const query of CSSValues.splitMediaQueryList(
		CSSValues.stripCSSComments(String(text ?? "")),
	)) {
		const serialized = CSSValues.serializeMediaQuery(query);
		if (serialized) {
			list[kMedia].push(serialized);
		}
	}
	syncIndexed(list);
}

// Stored beside the rule so deleting one can cut the link. A removed
// rule belongs to no stylesheet, and reports that.
const ruleSheets = new WeakMap<CSSRule, CSSStyleSheet | null>();

function detachRule(rule: CSSRule): void {
	ruleSheets.set(rule, null);
	const group = rule as {cssRules?: CSSRuleList};
	if (group.cssRules) {
		for (const child of Array.from(group.cssRules)) {
			detachRule(child);
		}
	}
}

const RULE_TYPES = {
	STYLE_RULE: 1,
	CHARSET_RULE: 2,
	IMPORT_RULE: 3,
	MEDIA_RULE: 4,
	FONT_FACE_RULE: 5,
	PAGE_RULE: 6,
	KEYFRAMES_RULE: 7,
	KEYFRAME_RULE: 8,
	NAMESPACE_RULE: 10,
	COUNTER_STYLE_RULE: 11,
	SUPPORTS_RULE: 12,
	FONT_FEATURE_VALUES_RULE: 14,
} as const;

interface CSSRule {
	[kParentRule]: CSSRule | null;
}

abstract class CSSRule {
	static readonly STYLE_RULE = RULE_TYPES.STYLE_RULE;
	static readonly CHARSET_RULE = RULE_TYPES.CHARSET_RULE;
	static readonly IMPORT_RULE = RULE_TYPES.IMPORT_RULE;
	static readonly MEDIA_RULE = RULE_TYPES.MEDIA_RULE;
	static readonly FONT_FACE_RULE = RULE_TYPES.FONT_FACE_RULE;
	static readonly PAGE_RULE = RULE_TYPES.PAGE_RULE;
	static readonly KEYFRAMES_RULE = RULE_TYPES.KEYFRAMES_RULE;
	static readonly KEYFRAME_RULE = RULE_TYPES.KEYFRAME_RULE;
	static readonly NAMESPACE_RULE = RULE_TYPES.NAMESPACE_RULE;
	static readonly COUNTER_STYLE_RULE = RULE_TYPES.COUNTER_STYLE_RULE;
	static readonly SUPPORTS_RULE = RULE_TYPES.SUPPORTS_RULE;
	static readonly FONT_FEATURE_VALUES_RULE =
		RULE_TYPES.FONT_FEATURE_VALUES_RULE;

	constructor(
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		ruleSheets.set(this, parentStyleSheet);
		this[kParentRule] = parentRule;
	}

	abstract get type(): number;
	abstract get cssText(): string;

	get parentRule(): CSSRule | null {
		return this[kParentRule];
	}

	get parentStyleSheet(): CSSStyleSheet | null {
		return ruleSheets.get(this) ?? null;
	}
}

for (const [name, value] of Object.entries(RULE_TYPES)) {
	Object.defineProperty(CSSRule.prototype, name, {value, enumerable: true});
}

function notifyRule(rule: CSSRule): void {
	sheetChanged(rule.parentStyleSheet);
}

const kRuleList = Symbol("ruleList");
const kRules = Symbol("rules");

interface CSSGroupingRule {
	[kRules]: CSSRule[];
	[kRuleList]: CSSRuleList;
}

abstract class CSSGroupingRule extends CSSRule {
	constructor(
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule);
		this[kRules] = [];
		this[kRuleList] = createRuleList(this[kRules]);
		if (build) {
			this[kRules].push(...build(this));
			syncIndexed(this[kRuleList]);
		}
	}

	get cssRules(): CSSRuleList {
		return this[kRuleList];
	}

	insertRule(text: string, index = 0): number {
		if (arguments.length === 0) {
			throw typeError(
				"insertRule requires a rule",
				this.parentStyleSheet ?? undefined,
			);
		}
		if (index > this[kRules].length) {
			throw domException(
				`Cannot insert at index ${index}`,
				"IndexSizeError",
				this.parentStyleSheet,
			);
		}
		const inserted = parseRuleText(text, this.parentStyleSheet, this);
		if (
			inserted instanceof CSSImportRule || inserted instanceof CSSNamespaceRule
		) {
			throw domException(
				"Only a stylesheet may hold that rule",
				"HierarchyRequestError",
				this.parentStyleSheet,
			);
		}
		this[kRules].splice(index, 0, inserted);
		syncIndexed(this[kRuleList]);
		notifyRule(this);
		return index;
	}

	deleteRule(index: number): void {
		if (arguments.length === 0) {
			throw typeError(
				"deleteRule requires an index",
				this.parentStyleSheet ?? undefined,
			);
		}
		if (index >= this[kRules].length) {
			throw domException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
				this.parentStyleSheet,
			);
		}
		detachRule(this[kRules][index]);
		this[kRules].splice(index, 1);
		syncIndexed(this[kRuleList]);
		notifyRule(this);
	}
}

function serializeGroupRules(group: CSSGroupingRule): string {
	return Array.from(group.cssRules)
		.map((rule) => `\n  ${rule.cssText.replace(/\n/g, "\n  ")}`)
		.join("");
}

abstract class CSSConditionRule extends CSSGroupingRule {
	abstract get conditionText(): string;
}

const kSelectors = Symbol("selectors");
const kStyle = Symbol("style");
const kSelectorText = Symbol("selectorText");

// Avoids the serialize-and-reparse a cssText assignment would run. The
// filters are the cssText setter's.
function assignDeclarations(
	block: CSSStyleDeclaration,
	declarations: readonly CSSValues.CSSDeclaration[],
): void {
	for (const declaration of declarations) {
		if (!isSupportedDeclaration(block, declaration.name)) {
			continue;
		}
		const {name, value, important} = declaration;
		applyDeclaration(block, name, value, important, true);
	}
	flushStyleAttribute(block);
}

interface CSSStyleRule {
	[kSelectors]: CSSTree.SelectorNode;
	[kSelectorText]: string | null;
	[kStyle]: CSSStyleDeclaration;
}

class CSSStyleRule extends CSSGroupingRule {
	constructor(
		selectors: CSSTree.SelectorNode,
		block: string | readonly CSSValues.CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kSelectorText] = null;
		this[kSelectors] = selectors;
		this[kStyle] = new CSSStyleProperties({
			parentRule: this,
			onChange: () => notifyRule(this),
		});
		if (typeof block === "string") {
			this[kStyle].cssText = block;
		} else {
			assignDeclarations(this[kStyle], block);
		}
	}

	get type(): number {
		return RULE_TYPES.STYLE_RULE;
	}

	// Serialized on first read, because whether `*|E` keeps its prefix
	// depends on `@namespace` rules that are only in place once parsing
	// finishes.
	get selectorText(): string {
		return (
			this[kSelectorText] ??= CSSValues.serializeSelectorList(
				this[kSelectors],
				getSheetNamespaces(this.parentStyleSheet),
			)
		);
	}

	/** A selector that does not parse leaves the rule unchanged. */
	set selectorText(selector: string) {
		const selectors = parseSelectorList(selector);
		if (!selectors) {
			return;
		}
		this[kSelectors] = selectors;
		this[kSelectorText] = null;
		notifyRule(this);
	}

	get style(): CSSStyleDeclaration {
		return this[kStyle];
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this[kStyle].cssText = String(text);
	}

	get cssText(): string {
		const declarations = this[kStyle].cssText;
		const nested = serializeGroupRules(this);
		const selector = this.selectorText;
		if (nested) {
			return `${selector} { ${declarations}${nested}\n}`;
		}
		return declarations ? `${selector} { ${declarations} }` : `${selector} { }`;
	}
}

function getSheetNamespaces(
	sheet: CSSStyleSheet | null,
): SelectorNamespaces | undefined {
	if (!sheet) {
		return undefined;
	}
	const namespaces: SelectorNamespaces = {default: null, prefixes: new Map()};
	for (const rule of Array.from(sheet.cssRules)) {
		if (!(rule instanceof CSSNamespaceRule)) {
			continue;
		}
		if (rule.prefix === "") {
			namespaces.default = rule.namespaceURI;
		} else {
			namespaces.prefixes.set(
				CSSTree.ident.decode(rule.prefix),
				rule.namespaceURI,
			);
		}
	}
	return namespaces;
}

// One class per at-rule that declares descriptors. A descriptor is
// named only inside its own at-rule, so `src` exists on
// CSSFontFaceDescriptors and nothing else.

const DESCRIPTOR_BLOCKS = new Map<string, typeof CSSStyleDeclaration>();

for (const [atRule, descriptors] of Object.entries(CSS_AT_RULE_DESCRIPTORS)) {
	const name = `CSS${atRule.slice(1).replace(
		/(?:^|-)([a-z])/g,
		(_, letter: string) => letter.toUpperCase(),
	)}Descriptors`;
	const block = class extends CSSStyleDeclaration {};
	Object.defineProperty(block, "name", {value: name, configurable: true});
	Object.defineProperty(block.prototype, Symbol.toStringTag, {
		value: name,
		configurable: true,
	});
	for (const descriptor of descriptors) {
		const attribute = CSSValues.camelCaseProperty(descriptor);
		for (const [index, key] of [attribute, descriptor].entries()) {
			if (index === 1 && key === attribute) {
				continue;
			}
			Object.defineProperty(block.prototype, key, {
				get(this: CSSStyleDeclaration) {
					return this.getPropertyValue(descriptor);
				},
				set(this: CSSStyleDeclaration, value: unknown) {
					this.setProperty(descriptor, value == null ? "" : String(value));
				},
				configurable: true,
				enumerable: index === 0,
			});
		}
	}
	DESCRIPTOR_BLOCKS.set(atRule, block);
}

interface CSSDeclarationBlockOwner extends CSSRule {
	[kStyle]: CSSStyleDeclaration;
}

// The block an at-rule with descriptors holds: @font-face, @page, a
// keyframe, @counter-style, @property and @font-palette-values each call
// this from their constructor.
function initDeclarationBlock(
	rule: CSSDeclarationBlockOwner,
	atRule: string,
	block: string | readonly CSSValues.CSSDeclaration[],
): void {
	const Block =
		(atRule ? DESCRIPTOR_BLOCKS.get(atRule) : undefined) ?? CSSStyleProperties;
	rule[kStyle] = new Block({
		parentRule: rule,
		onChange: () => notifyRule(rule),
		// A descriptor block declares descriptors, not CSS properties, so
		// the property index does not restrict what it may hold.
		descriptors: atRule,
		keyframe: rule instanceof CSSKeyframeRule,
	});
	if (typeof block === "string") {
		rule[kStyle].cssText = block;
	} else {
		assignDeclarations(rule[kStyle], block);
	}
}

function declarationBlockText(
	prelude: string,
	style: CSSStyleDeclaration,
): string {
	const declarations = style.cssText;
	return declarations ? `${prelude} { ${declarations} }` : `${prelude} { }`;
}

interface CSSFontFaceRule extends CSSDeclarationBlockOwner {}

/** `@font-face`: the descriptors of a font this terminal will never load. */
class CSSFontFaceRule extends CSSRule {
	constructor(
		block: string | readonly CSSValues.CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		initDeclarationBlock(this, "@font-face", block);
	}

	get type(): number {
		return RULE_TYPES.FONT_FACE_RULE;
	}

	get style(): CSSStyleDeclaration {
		return this[kStyle];
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this[kStyle].cssText = String(text);
	}

	get cssText(): string {
		return declarationBlockText("@font-face", this[kStyle]);
	}
}

// Declarations that follow a nested rule, or sit in a conditional rule
// nested in a style rule. They apply with the enclosing style rule's
// selectors, in the place they were written.
interface CSSNestedDeclarations {
	[kStyle]: CSSStyleProperties;
}

class CSSNestedDeclarations extends CSSRule {
	constructor(
		block: readonly CSSValues.CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		this[kStyle] = new CSSStyleProperties({
			parentRule: this,
			onChange: () => notifyRule(this),
		});
		assignDeclarations(this[kStyle], block);
	}

	get type(): number {
		return 0;
	}

	get style(): CSSStyleDeclaration {
		return this[kStyle];
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this[kStyle].cssText = String(text);
	}

	get cssText(): string {
		return this[kStyle].cssText;
	}
}

Object.defineProperty(CSSNestedDeclarations.prototype, Symbol.toStringTag, {
	value: "CSSNestedDeclarations",
	configurable: true,
});

interface CSSPageRule extends CSSDeclarationBlockOwner {
	[kSelectorText]: string;
}

/** `@page`: the page selector and its descriptors. */
class CSSPageRule extends CSSRule {
	constructor(
		selectorText: string,
		block: string | readonly CSSValues.CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		initDeclarationBlock(this, "@page", block);
		this[kSelectorText] = CSSValues.serializePageSelector(selectorText);
	}

	get type(): number {
		return RULE_TYPES.PAGE_RULE;
	}

	get selectorText(): string {
		return this[kSelectorText];
	}

	set selectorText(selector: string) {
		this[kSelectorText] = CSSValues.serializePageSelector(String(selector));
		notifyRule(this);
	}

	get style(): CSSStyleDeclaration {
		return this[kStyle];
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this[kStyle].cssText = String(text);
	}

	get cssText(): string {
		return declarationBlockText(
			this[kSelectorText] ? `@page ${this[kSelectorText]}` : "@page",
			this[kStyle],
		);
	}
}

const kName = Symbol("name");

// A named at-rule with a descriptor block, `@counter-style x { ... }`
// and the like: the name is the prelude and the block holds the
// descriptors.
interface CSSNamedRule extends CSSDeclarationBlockOwner {
	[kName]: string;
}

function initNamedRule(
	rule: CSSNamedRule,
	atRule: string,
	name: string,
	block: string | readonly CSSValues.CSSDeclaration[],
): void {
	initDeclarationBlock(rule, atRule, block);
	rule[kName] = name.trim();
}

interface CSSCounterStyleRule extends CSSNamedRule {}

/** `@counter-style`: a counter's name and the descriptors that define it. */
class CSSCounterStyleRule extends CSSRule {
	constructor(
		name: string,
		block: string | readonly CSSValues.CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		initNamedRule(this, "@counter-style", name, block);
	}

	get type(): number {
		return RULE_TYPES.COUNTER_STYLE_RULE;
	}

	get name(): string {
		return this[kName];
	}

	set name(name: string) {
		const text = String(name).trim();
		if (!text) {
			return;
		}
		this[kName] = text;
		notifyRule(this);
	}

	get cssText(): string {
		return declarationBlockText(`@counter-style ${this[kName]}`, this[kStyle]);
	}
}

interface CSSPropertyRule extends CSSNamedRule {}

/** `@property`: a custom property's registration. */
class CSSPropertyRule extends CSSRule {
	constructor(
		name: string,
		block: string | readonly CSSValues.CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		initNamedRule(this, "@property", name, block);
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this[kName];
	}

	get syntax(): string {
		return this[kStyle].getPropertyValue("syntax");
	}

	get inherits(): boolean {
		return this[kStyle].getPropertyValue("inherits") === "true";
	}

	get initialValue(): string | null {
		return this[kStyle].getPropertyValue("initial-value") || null;
	}

	get cssText(): string {
		return declarationBlockText(`@property ${this[kName]}`, this[kStyle]);
	}
}

interface CSSFontPaletteValuesRule extends CSSNamedRule {}

/** `@font-palette-values`: a palette's name and its descriptors. */
class CSSFontPaletteValuesRule extends CSSRule {
	constructor(
		name: string,
		block: string | readonly CSSValues.CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		initNamedRule(this, "@font-palette-values", name, block);
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this[kName];
	}

	get fontFamily(): string {
		return this[kStyle].getPropertyValue("font-family");
	}

	get basePalette(): string {
		return this[kStyle].getPropertyValue("base-palette");
	}

	get overrideColors(): string {
		return this[kStyle].getPropertyValue("override-colors");
	}

	get cssText(): string {
		return declarationBlockText(
			`@font-palette-values ${this[kName]}`,
			this[kStyle],
		);
	}
}

const kKeyText = Symbol("keyText");

interface CSSKeyframeRule extends CSSDeclarationBlockOwner {
	[kKeyText]: string;
}

/** One keyframe of an `@keyframes` rule: its offsets and its declarations. */
class CSSKeyframeRule extends CSSRule {
	constructor(
		keyText: string,
		block: string | readonly CSSValues.CSSDeclaration[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		initDeclarationBlock(this, "", block);
		this[kKeyText] = CSSValues.serializeKeyText(keyText);
	}

	get type(): number {
		return RULE_TYPES.KEYFRAME_RULE;
	}

	get keyText(): string {
		return this[kKeyText];
	}

	set keyText(text: string) {
		const serialized = CSSValues.serializeKeyText(String(text));
		if (!serialized) {
			throw domException(
				`Cannot parse keyText: ${text}`,
				"SyntaxError",
				this.parentStyleSheet,
			);
		}
		this[kKeyText] = serialized;
		notifyRule(this);
	}

	get style(): CSSStyleDeclaration {
		return this[kStyle];
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this[kStyle].cssText = String(text);
	}

	get cssText(): string {
		return declarationBlockText(this[kKeyText], this[kStyle]);
	}
}

interface CSSMediaRule {
	[kMedia]: MediaList;
}

/** `@media`: the rules that apply when the viewport matches. */
class CSSMediaRule extends CSSConditionRule {
	constructor(
		mediaText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kMedia] = new MediaList(mediaText, () => notifyRule(this));
	}

	get type(): number {
		return RULE_TYPES.MEDIA_RULE;
	}

	get media(): MediaList {
		return this[kMedia];
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this[kMedia].mediaText = String(text);
	}

	/** Read-only. The media list behind it is what an author sets. */
	get conditionText(): string {
		return this[kMedia].mediaText;
	}

	get cssText(): string {
		return `@media ${this.conditionText} {${serializeGroupRules(this)}\n}`;
	}
}

const kConditionText = Symbol("conditionText");

// The text of a condition rule this engine keeps as authored:
// `@supports` and `@container`.
function conditionRuleText(
	atKeyword: string,
	conditionText: string,
	rule: CSSGroupingRule,
): string {
	const condition = conditionText ? ` ${conditionText}` : "";
	return `${atKeyword}${condition} {${serializeGroupRules(rule)}\n}`;
}

/** `@supports`: its rules apply, since what this engine supports it renders. */
interface CSSSupportsRule {
	[kConditionText]: string;
}

class CSSSupportsRule extends CSSConditionRule {
	constructor(
		conditionText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kConditionText] = conditionText.trim();
	}

	get type(): number {
		return RULE_TYPES.SUPPORTS_RULE;
	}

	get conditionText(): string {
		return this[kConditionText];
	}

	get cssText(): string {
		return conditionRuleText("@supports", this[kConditionText], this);
	}
}

const kContainerName = Symbol("containerName");
const kContainerQuery = Symbol("containerQuery");

interface CSSContainerRule {
	[kConditionText]: string;
	[kContainerName]: string;
	[kContainerQuery]: string;
}

/** `@container`: parsed, with no container query engine behind it. */
class CSSContainerRule extends CSSConditionRule {
	constructor(
		conditionText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kConditionText] = conditionText.trim();
		// The prelude does not change for this rule, so its parts are read
		// once here.
		const parts = CSSValues.getContainerParts(this.conditionText);
		this[kContainerName] = parts.name;
		this[kContainerQuery] = parts.query;
	}

	get type(): number {
		return 0;
	}

	get conditionText(): string {
		return this[kConditionText];
	}

	get cssText(): string {
		return conditionRuleText("@container", this[kConditionText], this);
	}

	get containerName(): string {
		return this[kContainerName];
	}

	get containerQuery(): string {
		return this[kContainerQuery];
	}
}

const kPrelude = Symbol("prelude");
const kScopeStart = Symbol("scopeStart");
const kScopeEnd = Symbol("scopeEnd");

interface CSSScopeRule {
	[kPrelude]: string;
	[kScopeStart]: string | null;
	[kScopeEnd]: string | null;
}

/** `@scope`: parsed, and its rules apply unscoped. */
class CSSScopeRule extends CSSGroupingRule {
	constructor(
		prelude: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kPrelude] = prelude.trim();
		// The prelude does not change for this rule, so its parts are read
		// once here.
		const limits = CSSValues.getScopeLimits(this[kPrelude]);
		this[kScopeStart] = limits.start;
		this[kScopeEnd] = limits.end;
	}

	get type(): number {
		return 0;
	}

	get start(): string | null {
		return this[kScopeStart];
	}

	get end(): string | null {
		return this[kScopeEnd];
	}

	get cssText(): string {
		const prelude = this[kPrelude] ? ` ${this[kPrelude]}` : "";
		return `@scope${prelude} {${serializeGroupRules(this)}\n}`;
	}
}

/** `@starting-style`: parsed, and its rules never apply. */
class CSSStartingStyleRule extends CSSGroupingRule {
	get type(): number {
		return 0;
	}

	get cssText(): string {
		return `@starting-style {${serializeGroupRules(this)}\n}`;
	}
}

interface CSSLayerBlockRule {
	[kName]: string;
}

/** `@layer name { ... }`: its rules cascade in source order. */
class CSSLayerBlockRule extends CSSGroupingRule {
	constructor(
		name: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kName] = name;
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this[kName];
	}

	get cssText(): string {
		const name = this[kName] ? ` ${this[kName]}` : "";
		return `@layer${name} {${serializeGroupRules(this)}\n}`;
	}
}

const kNames = Symbol("names");

interface CSSLayerStatementRule {
	[kNames]: string[];
}

/** `@layer a, b;`: the layer order, declared without a block. */
class CSSLayerStatementRule extends CSSRule {
	constructor(
		names: readonly string[],
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		this[kNames] = [...names];
	}

	get type(): number {
		return 0;
	}

	get nameList(): readonly string[] {
		return this[kNames];
	}

	get cssText(): string {
		return `@layer ${this[kNames].join(", ")};`;
	}
}

const kPrefix = Symbol("prefix");
const kNamespaceURI = Symbol("namespaceURI");

interface CSSNamespaceRule {
	[kPrefix]: string;
	[kNamespaceURI]: string;
}

/** `@namespace`: a prefix bound to a namespace URI. */
class CSSNamespaceRule extends CSSRule {
	constructor(
		prefix: string,
		namespaceURI: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this[kPrefix] = prefix;
		this[kNamespaceURI] = namespaceURI;
	}

	get type(): number {
		return RULE_TYPES.NAMESPACE_RULE;
	}

	get prefix(): string {
		return this[kPrefix];
	}

	get namespaceURI(): string {
		return this[kNamespaceURI];
	}

	get cssText(): string {
		const prefix = this[kPrefix] ? `${this[kPrefix]} ` : "";
		return `@namespace ${prefix}url(${CSSValues.serializeCSSString(this[kNamespaceURI])});`;
	}
}

const kHref = Symbol("href");
const kLayerName = Symbol("layerName");
const kSupportsText = Symbol("supportsText");

// There is no network behind a terminal document. Nothing is fetched,
// the rule declares nothing, and its styleSheet is null.
interface CSSImportRule {
	[kHref]: string;
	[kMedia]: MediaList;
	[kLayerName]: string | null;
	[kSupportsText]: string | null;
}

class CSSImportRule extends CSSRule {
	constructor(
		href: string,
		mediaText: string,
		layerName: string | null,
		supportsText: string | null,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this[kHref] = href;
		this[kMedia] = new MediaList(mediaText);
		this[kLayerName] = layerName;
		this[kSupportsText] = supportsText;
	}

	get type(): number {
		return RULE_TYPES.IMPORT_RULE;
	}

	get href(): string {
		return this[kHref];
	}

	get media(): MediaList {
		return this[kMedia];
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this[kMedia].mediaText = String(text);
	}

	get layerName(): string | null {
		return this[kLayerName];
	}

	get supportsText(): string | null {
		return this[kSupportsText];
	}

	get styleSheet(): CSSStyleSheet | null {
		return null;
	}

	get cssText(): string {
		let out = `@import url(${CSSValues.serializeCSSString(this[kHref])})`;
		if (this[kLayerName] !== null) {
			out += this[kLayerName] ? ` layer(${this[kLayerName]})` : " layer";
		}
		if (this[kSupportsText] !== null) {
			out += ` supports(${this[kSupportsText]})`;
		}
		const media = this[kMedia].mediaText;
		if (media) {
			out += ` ${media}`;
		}
		return `${out};`;
	}
}

const kFontFamily = Symbol("fontFamily");
const kBlocks = Symbol("blocks");

interface CSSFontFeatureValuesRule {
	[kFontFamily]: string;
	[kBlocks]: Map<string, CSSStyleDeclaration>;
}

/** `@font-feature-values`: a font family and the feature blocks it names. */
class CSSFontFeatureValuesRule extends CSSRule {
	constructor(
		fontFamily: string,
		node: CSSTree.StyleSheetNode,
		source: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this[kBlocks] = new Map<string, CSSStyleDeclaration>();
		this[kFontFamily] = fontFamily.trim();
		for (const child of CSSValues.getNodes(node.block ?? {})) {
			if (child.type !== "Atrule" || !child.name) {
				continue;
			}
			const block = new CSSStyleDeclaration({
				parentRule: this,
				onChange: () => notifyRule(this),
				descriptors: "@font-feature-values",
			});
			assignDeclarations(block, CSSValues.getBlockDeclarations(child, source));
			this[kBlocks].set(child.name.toLowerCase(), block);
		}
	}

	get type(): number {
		return RULE_TYPES.FONT_FEATURE_VALUES_RULE;
	}

	get fontFamily(): string {
		return this[kFontFamily];
	}

	set fontFamily(family: string) {
		this[kFontFamily] = String(family).trim();
		notifyRule(this);
	}

	get annotation(): CSSStyleDeclaration {
		return getFeatureBlock(this, "annotation");
	}

	get ornaments(): CSSStyleDeclaration {
		return getFeatureBlock(this, "ornaments");
	}

	get stylistic(): CSSStyleDeclaration {
		return getFeatureBlock(this, "stylistic");
	}

	get swash(): CSSStyleDeclaration {
		return getFeatureBlock(this, "swash");
	}

	get characterVariant(): CSSStyleDeclaration {
		return getFeatureBlock(this, "character-variant");
	}

	get styleset(): CSSStyleDeclaration {
		return getFeatureBlock(this, "styleset");
	}

	get cssText(): string {
		const blocks: string[] = [];
		for (const [name, block] of this[kBlocks]) {
			const declarations = block.cssText;
			if (declarations) {
				blocks.push(`\n  @${name} { ${declarations} }`);
			}
		}
		return `@font-feature-values ${this[kFontFamily]} {${blocks.join("")}\n}`;
	}
}

function getFeatureBlock(
	rule: CSSFontFeatureValuesRule,
	name: string,
): CSSStyleDeclaration {
	let block = rule[kBlocks].get(name);
	if (!block) {
		block = new CSSStyleDeclaration({
			parentRule: rule,
			onChange: () => notifyRule(rule),
			descriptors: "@font-feature-values",
		});
		rule[kBlocks].set(name, block);
	}
	return block;
}

interface CSSKeyframesRule {
	[kName]: string;
	[kRules]: CSSRule[];
	[kRuleList]: CSSRuleList;
}

/** `@keyframes`: its name and the keyframes it holds. */
class CSSKeyframesRule extends CSSRule {
	constructor(
		name: string,
		parentStyleSheet: CSSStyleSheet | null,
		build?: (rule: CSSKeyframesRule) => CSSRule[],
	) {
		super(parentStyleSheet, null);
		this[kRules] = [];
		this[kName] = name.trim();
		this[kRuleList] = createRuleList(this[kRules]);
		if (build) {
			this[kRules].push(...build(this));
			syncIndexed(this[kRuleList]);
		}
		syncIndexed(this, this[kRules]);
	}

	get type(): number {
		return RULE_TYPES.KEYFRAMES_RULE;
	}

	get name(): string {
		return this[kName];
	}

	set name(name: string) {
		this[kName] = String(name);
		notifyRule(this);
	}

	get cssRules(): CSSRuleList {
		return this[kRuleList];
	}

	get length(): number {
		return this[kRules].length;
	}

	get cssText(): string {
		const frames = this[kRules].map((rule) => `\n  ${rule.cssText}`).join("");
		const name = CSSValues.serializeKeyframesName(this[kName]);
		return `@keyframes ${name} {${frames}\n}`;
	}

	appendRule(text: string): void {
		const rule = parseRuleText(
			`@keyframes k { ${text} }`,
			this.parentStyleSheet,
			this,
		);
		if (rule instanceof CSSKeyframesRule) {
			this[kRules].push(...Array.from(rule.cssRules));
			syncIndexed(this[kRuleList]);
			syncIndexed(this, this[kRules]);
			notifyRule(this);
		}
	}

	deleteRule(select: string): void {
		const key = CSSValues.serializeKeyText(String(select));
		for (let index = this[kRules].length - 1; index >= 0; index--) {
			if ((this[kRules][index] as CSSKeyframeRule).keyText !== key) {
				continue;
			}
			this[kRules].splice(index, 1);
			syncIndexed(this[kRuleList]);
			syncIndexed(this, this[kRules]);
			notifyRule(this);
			return;
		}
	}

	findRule(select: string): CSSKeyframeRule | null {
		const key = CSSValues.serializeKeyText(String(select));
		for (let index = this[kRules].length - 1; index >= 0; index--) {
			const rule = this[kRules][index] as CSSKeyframeRule;
			if (rule.keyText === key) {
				return rule;
			}
		}
		return null;
	}
}

interface CSSRuleList {
	[kRules]: readonly CSSRule[];
}

/** The rules of a stylesheet or a grouping rule. */
class CSSRuleList {
	constructor(rules: readonly CSSRule[]) {
		this[kRules] = rules;
	}

	get length(): number {
		return this[kRules].length;
	}

	item(index: number): CSSRule | null {
		return this[kRules][index] ?? null;
	}

	[Symbol.iterator](): IterableIterator<CSSRule> {
		return this[kRules][Symbol.iterator]();
	}
}

function createRuleList(rules: readonly CSSRule[]): CSSRuleList {
	const list = new CSSRuleList(rules);
	syncIndexed(list);
	return list;
}

const kSheets = Symbol("sheets");

interface StyleSheetList {
	[kSheets]: readonly CSSStyleSheet[];
}

/** The stylesheets of a document or a shadow root. */
class StyleSheetList {
	constructor(sheets: readonly CSSStyleSheet[]) {
		this[kSheets] = sheets;
	}

	get length(): number {
		return this[kSheets].length;
	}

	item(index: number): CSSStyleSheet | null {
		return this[kSheets][index] ?? null;
	}

	[Symbol.iterator](): IterableIterator<CSSStyleSheet> {
		return this[kSheets][Symbol.iterator]();
	}
}

const kOwnerNode = Symbol("ownerNode");
const kConstructed = Symbol("constructed");
const kTitle = Symbol("title");
const kDisabled = Symbol("disabled");
const kText = Symbol("text");
const kOwnerRule = Symbol("ownerRule");

/** Only a constructed sheet may be adopted, per spec. */
const constructedSheets = new WeakSet<CSSStyleSheet>();

// The rules belong to this object. The cascade reads them rather than
// re-parsing text, so every mutation path reaches the render through the
// same invalidation a `<style>` text change does.
interface CSSStyleSheet {
	[kRules]: CSSRule[];
	[kRuleList]: CSSRuleList;
	[kMedia]: MediaList;
	[kOwnerNode]: Element | null;
	[kOwnerRule]: CSSRule | null;
	[kConstructed]: boolean;
	[kDisabled]: boolean;
	[kHref]: string | null;
	[kTitle]: string | null;

	// The owner node's text this sheet last parsed.
	[kText]: string | null;
}

class CSSStyleSheet {
	// A sheet with an owner element is one the document parsed:
	// replace(Sync) is refused on it, and its rules follow the element's
	// text. The exposed constructor takes options only, so authors can only
	// make the constructed kind.
	constructor(
		options: {media?: string; title?: string; disabled?: boolean} = {},
		ownerNode: Element | null = null,
	) {
		this[kRules] = [];
		this[kOwnerRule] = null;
		this[kText] = null;
		this[kOwnerNode] = ownerNode;
		this[kConstructed] = ownerNode === null;
		if (this[kConstructed]) {
			constructedSheets.add(this);
		}
		this[kHref] = ownerNode?.getAttribute("href") ?? null;
		this[kTitle] = ownerNode?.getAttribute("title") ?? options.title ?? null;
		this[kDisabled] = Boolean(options.disabled);
		this[kMedia] = new MediaList(
			ownerNode?.getAttribute("media") ?? options.media ?? "",
			() => sheetChanged(this),
		);
		this[kRuleList] = createRuleList(this[kRules]);
	}

	get cssRules(): CSSRuleList {
		this[kSync]!();
		return this[kRuleList];
	}

	// The legacy alias every engine still supports.
	get rules(): CSSRuleList {
		return this.cssRules;
	}

	get type(): string {
		return "text/css";
	}

	get href(): string | null {
		return this[kHref];
	}

	get title(): string | null {
		return this[kTitle];
	}

	get ownerNode(): Element | null {
		return this[kOwnerNode];
	}

	get ownerRule(): CSSRule | null {
		return this[kOwnerRule];
	}

	get parentStyleSheet(): CSSStyleSheet | null {
		return this[kOwnerRule]?.parentStyleSheet ?? null;
	}

	get media(): MediaList {
		return this[kMedia];
	}

	/** `[PutForwards=mediaText]`: assigning a media list assigns its text. */
	set media(text: string) {
		this[kMedia].mediaText = String(text);
	}

	get disabled(): boolean {
		return this[kDisabled];
	}

	set disabled(disabled: boolean) {
		const value = Boolean(disabled);
		if (value === this[kDisabled]) {
			return;
		}
		this[kDisabled] = value;
		sheetChanged(this);
	}

	insertRule(text: string, index = 0): number {
		if (arguments.length === 0) {
			throw typeError("insertRule requires a rule", this);
		}
		this[kSync]!();
		if (index > this[kRules].length) {
			throw domException(
				`Cannot insert at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		const inserted = parseRuleText(text, this, null);
		// A constructed sheet cannot import another. `@import` is not a rule it
		// accepts.
		if (inserted instanceof CSSImportRule && this[kConstructed]) {
			throw domException(
				"A constructed stylesheet holds no @import rule",
				"SyntaxError",
				this,
			);
		}
		checkRuleOrder(this, inserted, index);
		this[kRules].splice(index, 0, inserted);
		syncIndexed(this[kRuleList]);
		sheetChanged(this);
		return index;
	}

	deleteRule(index: number): void {
		if (arguments.length === 0) {
			throw typeError("deleteRule requires an index", this);
		}
		this[kSync]!();
		if (index >= this[kRules].length) {
			throw domException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		const removed = this[kRules][index];
		// Removing a namespace declaration would change the meaning of
		// selectors already parsed against it, so a sheet holding any other
		// rule keeps it.
		if (
			removed instanceof CSSNamespaceRule && this[kRules].some((other) =>
				!(
					other instanceof CSSImportRule || other instanceof CSSNamespaceRule
				))
		) {
			throw domException(
				"A @namespace rule cannot be removed from a sheet that holds other rules",
				"InvalidStateError",
				this,
			);
		}
		detachRule(removed);
		this[kRules].splice(index, 1);
		syncIndexed(this[kRuleList]);
		sheetChanged(this);
	}

	// The legacy IE spellings, defined in terms of the modern pair.
	addRule(selector = "undefined", block = "", index?: number): number {
		this.insertRule(`${selector} { ${block} }`, index ?? this.cssRules.length);
		return -1;
	}

	removeRule(index = 0): void {
		this[kSync]!();
		if (index >= this.cssRules.length) {
			throw domException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		this.deleteRule(index);
	}

	replaceSync(text: string): void {
		if (!this[kConstructed]) {
			throw domException(
				"replaceSync is only allowed on a constructed stylesheet",
				"NotAllowedError",
				this,
			);
		}
		// An adopted sheet cannot import another. `@import` is dropped rather
		// than parsed, per the constructable-stylesheet rules.
		this[kRules].length = 0;
		this[kRules].push(
			...parseRules(String(text ?? ""), this, null).filter(
				(rule) => !(rule instanceof CSSImportRule),
			),
		);
		syncIndexed(this[kRuleList]);
		sheetChanged(this);
	}

	replace(text: string): Promise<CSSStyleSheet> {
		try {
			this.replaceSync(text);
		} catch (error) {
			return Promise.reject(error);
		}
		return Promise.resolve(this);
	}

	// Reparse the owner element's text if it changed.
	[kSync]?(): void {
		const node = this[kOwnerNode];
		if (!node || node.tagName !== "STYLE") {
			return;
		}
		const text = node.textContent ?? "";
		if (text === this[kText]) {
			return;
		}
		this[kText] = text;
		this[kRules].length = 0;
		this[kRules].push(...parseRules(text, this, null));
		syncIndexed(this[kRuleList]);
	}
}

// `@import` must precede every rule except another `@import`, and
// `@namespace` every rule except those two. A `@namespace` also needs a
// sheet holding nothing else, because a selector parsed before the
// declaration cannot use it.
function checkRuleOrder(
	sheet: CSSStyleSheet,
	rule: CSSRule,
	index: number,
): void {
	const hierarchy = (): never => {
		throw domException(
			"That rule cannot stand at that index",
			"HierarchyRequestError",
			sheet,
		);
	};
	const prelude = (other: CSSRule): boolean =>
		other instanceof CSSImportRule || other instanceof CSSNamespaceRule;
	const before = sheet[kRules].slice(0, index);
	const after = sheet[kRules].slice(index);
	if (rule instanceof CSSImportRule) {
		if (before.some((other) => !(other instanceof CSSImportRule))) {
			hierarchy();
		}
		return;
	}
	if (rule instanceof CSSNamespaceRule) {
		if (before.some((other) => !prelude(other))) {
			hierarchy();
		}
		if (after.some((other) => other instanceof CSSImportRule)) {
			hierarchy();
		}
		if (sheet[kRules].some((other) => !prelude(other))) {
			throw domException(
				"A @namespace rule needs a sheet of nothing but @import and @namespace rules",
				"InvalidStateError",
				sheet,
			);
		}
		return;
	}
	if (after.some(prelude)) {
		hierarchy();
	}
}

// css-tree reads a style block's items as declarations, and one that
// fails becomes a Raw node running to the next semicolon, so `.title {}`
// nested in a rule vanished with everything after it. CSS Syntax reads an
// item that is not a declaration as a nested rule (css-nesting-1 §2), and
// so does this: a declaration is tried first, and an item that fails, or
// that holds a {} block without being a custom property, is read again as
// a rule.
const {
	AtKeyword,
	Comment,
	LeftCurlyBracket,
	RightCurlyBracket,
	Semicolon,
	WhiteSpace,
} = (CSSTree as unknown as {tokenTypes: Record<string, number>}).tokenTypes;

interface BlockParser {
	eof: boolean;
	tokenType: number;
	tokenIndex: number;
	tokenStart: number;
	createList(): {push(node: unknown): void};
	eat(type: number): void;
	next(): void;
	skip(count: number): void;
	getTokenStart(index: number): number;
	substrToCursor(start: number): string;
	getLocation(start: number, end: number): unknown;
	parseWithFallback(consumer: unknown, fallback: unknown): unknown;
	consumeUntilSemicolonIncluded: unknown;
	Raw(consumer: unknown, excludeWhiteSpace: boolean): unknown;
	Rule(): unknown;
	Declaration(): {property?: string};
	Atrule(isStyleBlock: boolean): unknown;
}

function consumeBlockItem(this: BlockParser): unknown {
	if (this.tokenType === Semicolon) {
		return this.Raw(this.consumeUntilSemicolonIncluded, true);
	}
	const start = this.tokenIndex;
	const startOffset = this.getTokenStart(start);
	let declaration: {property?: string} | null;
	try {
		declaration = this.Declaration();
	} catch (_err) {
		declaration = null;
	}
	if (
		declaration !== null &&
		(String(declaration.property ?? "").startsWith("--") ||
			!this.substrToCursor(startOffset).includes("{"))
	) {
		if (this.tokenType === Semicolon) {
			this.next();
		}
		return declaration;
	}
	this.skip(start - this.tokenIndex);
	return this.parseWithFallback(this.Rule, function (this: BlockParser) {
		return this.Raw(this.consumeUntilSemicolonIncluded, true);
	});
}

const nestingSyntax = (CSSTree.fork as (extension: object) => typeof CSSTree)({
	node: {
		Block: {
			parse(this: BlockParser, isStyleBlock: boolean) {
				const start = this.tokenStart;
				const children = this.createList();
				this.eat(LeftCurlyBracket);
				scan: while (!this.eof) {
					switch (this.tokenType) {
						case RightCurlyBracket:
							break scan;
						case WhiteSpace:
						case Comment:
							this.next();
							break;
						case AtKeyword:
							children.push(
								this.parseWithFallback(
									() => this.Atrule(isStyleBlock),
									function (this: BlockParser) {
										return this.Raw(null, true);
									},
								),
							);
							break;
						default:
							children.push(
								isStyleBlock
									? consumeBlockItem.call(this)
									: this.parseWithFallback(
										this.Rule,
										function (this: BlockParser) {
											return this.Raw(null, true);
										},
									),
							);
					}
				}
				if (!this.eof) {
					this.eat(RightCurlyBracket);
				}
				return {
					type: "Block",
					loc: this.getLocation(start, this.tokenStart),
					children,
				};
			},
		},
	},
});

function parseRules(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule[] {
	let ast: {children: {toArray(): CSSTree.StyleSheetNode[]}};
	try {
		// Values parse to nodes in this one pass. A value outside its grammar
		// falls back to a Raw node rather than an error, so the sheet keeps
		// what a raw-text parse would keep. Positions are on because the value
		// TEXT serializes from the authored source, not from the parsed
		// spelling.
		ast = nestingSyntax.parse(text, {
			parseValue: true,
			parseAtrulePrelude: false,
			parseRulePrelude: false,
			parseCustomProperty: false,
			positions: true,
		}) as never;
	} catch (_err) {
		return [];
	}
	return buildRules(sheet, () =>
		convertRules(ast.children.toArray(), text, sheet, parentRule),
	);
}

function parseRuleText(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule {
	const source = String(text ?? "");
	let ast: {children: {toArray(): CSSTree.StyleSheetNode[]}};
	try {
		ast = nestingSyntax.parse(source, {
			parseValue: false,
			parseAtrulePrelude: false,
			parseRulePrelude: false,
			parseCustomProperty: false,
			onParseError(error: Error) {
				throw error;
			},
		}) as never;
	} catch (_err) {
		throw domException(`Cannot parse rule: ${source}`, "SyntaxError", sheet);
	}
	const nodes = ast.children.toArray();
	if (nodes.length !== 1) {
		throw domException(`Cannot parse rule: ${source}`, "SyntaxError", sheet);
	}
	const rule = buildRules(sheet, () =>
		convertRule(nodes[0], source, sheet, parentRule, getSheetNamespaces(sheet)),
	);
	if (!rule) {
		throw domException(`Cannot parse rule: ${source}`, "SyntaxError", sheet);
	}
	return rule;
}

// An @namespace applies only to the rules that follow it, so the
// namespace map is built during the walk rather than read from a sheet
// still being built.
function convertRules(
	nodes: readonly CSSTree.StyleSheetNode[],
	source: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
	namespaces: SelectorNamespaces = {default: null, prefixes: new Map()},
): CSSRule[] {
	const rules: CSSRule[] = [];
	// Declarations among rules nested in a style rule, directly or in a
	// conditional rule inside one, are gathered into runs.
	const nestedContext = isInStyleRule(parentRule);
	let run: CSSTree.StyleSheetNode[] = [];
	const closeRun = (): void => {
		if (run.length > 0) {
			rules.push(
				new CSSNestedDeclarations(
					CSSValues.getDeclarations(run, source),
					sheet,
					parentRule,
				),
			);
			run = [];
		}
	};
	for (const node of nodes) {
		if (node.type === "Declaration") {
			if (nestedContext) {
				run.push(node);
			}
			continue;
		}
		closeRun();
		const rule = convertRule(node, source, sheet, parentRule, namespaces);
		if (!rule) {
			continue;
		}
		if (rule instanceof CSSNamespaceRule) {
			if (rule.prefix === "") {
				namespaces.default = rule.namespaceURI;
			} else {
				namespaces.prefixes.set(
					CSSTree.ident.decode(rule.prefix),
					rule.namespaceURI,
				);
			}
		}
		rules.push(rule);
	}
	closeRun();
	return rules;
}

function isInStyleRule(rule: CSSRule | null): boolean {
	for (let current = rule; current !== null; current = current.parentRule) {
		if (current instanceof CSSStyleRule) {
			return true;
		}
	}
	return false;
}

function convertRule(
	node: CSSTree.StyleSheetNode,
	source: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
	namespaces?: SelectorNamespaces,
): CSSRule | null {
	if (node.type === "Rule") {
		const prelude = CSSValues.getPreludeText(node);
		const selectors = parseSelectorList(prelude);
		if (!selectors) {
			return null;
		}
		// A prefix no @namespace declared names no namespace, and a selector
		// using one does not parse.
		if (
			prelude.includes("|") &&
			!CSSValues.namespacePrefixesDeclared(prelude, namespaces)
		) {
			return null;
		}
		// The declarations before the first nested rule are the rule's own.
		// Any that follow a nested rule keep their place among the rules as
		// nested declarations (css-nesting-1 §3.2).
		const items = CSSValues.getNodes(node.block ?? {});
		const split = items.findIndex(
			(item) => item.type === "Rule" || item.type === "Atrule",
		);
		const own = split === -1 ? items : items.slice(0, split);
		const nested = split === -1 ? [] : items.slice(split);
		return new CSSStyleRule(
			selectors,
			CSSValues.getDeclarations(own, source),
			sheet,
			parentRule,
			(rule) => convertRules(nested, source, sheet, rule, namespaces),
		);
	}
	if (node.type !== "Atrule") {
		return null;
	}
	const prelude = CSSValues.getPreludeText(node);
	switch ((node.name ?? "").toLowerCase()) {
		// A charset rule is not exposed in a sheet's rule list, per CSSOM.
		case "charset":
			return null;
		case "container":
			return new CSSContainerRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					CSSValues.getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "counter-style":
			return new CSSCounterStyleRule(
				prelude,
				CSSValues.getBlockDeclarations(node, source),
				sheet,
			);
		case "font-face":
			return new CSSFontFaceRule(
				CSSValues.getBlockDeclarations(node, source),
				sheet,
				parentRule,
			);
		case "font-feature-values":
			return new CSSFontFeatureValuesRule(prelude, node, source, sheet);
		case "font-palette-values":
			return new CSSFontPaletteValuesRule(
				prelude,
				CSSValues.getBlockDeclarations(node, source),
				sheet,
			);
		case "import":
			return convertImportRule(prelude, sheet);
		case "keyframes":
		case "-webkit-keyframes":
			return new CSSKeyframesRule(prelude, sheet, (rule) =>
				CSSValues.getNodes(node.block ?? {})
					.filter((frame) => frame.type === "Rule")
					.map((frame) =>
						new CSSKeyframeRule(
							CSSValues.getPreludeText(frame),
							CSSValues.getBlockDeclarations(frame, source),
							sheet,
							rule,
						),
					),
			);
		case "layer": {
			const names = CSSValues.getLayerNames(prelude);
			if (!names) {
				return null;
			}
			if (!node.block) {
				// `@layer;` orders nothing and names nothing to order.
				return names.length === 0
					? null
					: new CSSLayerStatementRule(names, sheet, parentRule);
			}
			// A block opens one layer. A list of names is only valid in the
			// statement form.
			if (names.length > 1) {
				return null;
			}
			return new CSSLayerBlockRule(names[0] ?? "", sheet, parentRule, (group) =>
				convertRules(
					CSSValues.getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		}
		case "media":
			return new CSSMediaRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					CSSValues.getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "namespace":
			return convertNamespaceRule(prelude, sheet);
		case "page":
			return new CSSPageRule(
				prelude,
				CSSValues.getBlockDeclarations(node, source),
				sheet,
				parentRule,
			);
		case "property":
			return new CSSPropertyRule(
				prelude,
				CSSValues.getBlockDeclarations(node, source),
				sheet,
			);
		case "scope":
			return new CSSScopeRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					CSSValues.getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "starting-style":
			return new CSSStartingStyleRule(sheet, parentRule, (group) =>
				convertRules(
					CSSValues.getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		case "supports":
			return new CSSSupportsRule(prelude, sheet, parentRule, (group) =>
				convertRules(
					CSSValues.getNodes(node.block ?? {}),
					source,
					sheet,
					group,
					namespaces,
				),
			);
		default:
			return null;
	}
}

// A prefix keeps its authored spelling, which is what it serializes
// back as and what a selector's prefix is decoded against. Null drops
// the at-rule.
function convertNamespaceRule(
	prelude: string,
	sheet: CSSStyleSheet | null,
): CSSNamespaceRule | null {
	let nodes: CSSTree.NamespacePreludeNode[];
	try {
		const ast = CSSTree.parse(prelude, {
			context: "atrulePrelude",
			atrule: "namespace",
		}) as unknown as {children?: {toArray(): CSSTree.NamespacePreludeNode[]} |
			null;};
		nodes = ast.children ? ast.children.toArray() : [];
	} catch (_err) {
		return null;
	}
	let index = 0;
	let prefix = "";
	if (nodes[index]?.type === "Identifier") {
		prefix = nodes[index].name ?? "";
		index++;
	}
	const uri = nodes[index];
	if (
		nodes.length !== index + 1 || (uri.type !== "Url" && uri.type !== "String")
	) {
		return null;
	}
	return new CSSNamespaceRule(prefix, uri.value ?? "", sheet);
}

// The supports condition and the media list keep their authored text,
// sliced at their nodes' positions. Null for a prelude outside the
// grammar.
function convertImportRule(
	prelude: string,
	sheet: CSSStyleSheet | null,
): CSSImportRule | null {
	const text = prelude.trim();
	let nodes: CSSTree.ImportPreludeNode[];
	try {
		const ast = CSSTree.parse(text, {
			context: "atrulePrelude",
			atrule: "import",
			positions: true,
		}) as unknown as {
			children?: {toArray(): CSSTree.ImportPreludeNode[]} | null;
		};
		nodes = ast.children ? ast.children.toArray() : [];
	} catch (_err) {
		return null;
	}
	const getSlice = (node: CSSTree.ImportPreludeNode): string =>
		node.loc ? text.slice(node.loc.start.offset, node.loc.end.offset) : "";
	const head = nodes[0];
	if (!head || (head.type !== "Url" && head.type !== "String")) {
		return null;
	}
	const href = head.value ?? "";
	let index = 1;

	let layerName: string | null = null;
	let node: CSSTree.ImportPreludeNode | undefined = nodes[index];
	if (
		node &&
		(node.type === "Identifier" || node.type === "Function") &&
		(node.name ?? "").toLowerCase() === "layer"
	) {
		const layer = (node.children?.toArray() ?? []).find(
			(child) => child.type === "Layer",
		);
		if (node.type === "Function" && !layer) {
			// `layer()` takes a layer name and nothing else, so a name outside
			// the grammar invalidates the prelude. The bare word `layer` means
			// the anonymous layer.
			return null;
		}
		layerName = layer?.name ?? "";
		index++;
	}

	let supportsText: string | null = null;
	node = nodes[index];
	if (
		node?.loc &&
		node.type === "Function" &&
		(node.name ?? "").toLowerCase() === "supports"
	) {
		// The slice spans the function: its name, its parentheses and the
		// condition between them. A function whose parenthesis never closes is
		// recovered ending at the text, with no `)` to leave off.
		const spelled = getSlice(node);
		const opened = (node.name ?? "").length + 1;
		supportsText = (
			spelled.endsWith(")") ? spelled.slice(opened, -1) : spelled.slice(opened)
		).trim();
		index++;
	}

	let mediaText = "";
	node = nodes[index];
	if (node) {
		if (node.type !== "MediaQueryList") {
			return null;
		}
		mediaText = getSlice(node);
		index++;
	}
	if (index !== nodes.length) {
		return null;
	}
	return new CSSImportRule(href, mediaText, layerName, supportsText, sheet);
}

// Assigning a rule's text does nothing, as in every engine, but the
// attribute exists, so every rule type gets the setter alongside the
// serialization its own class defines.
for (const type of [
	CSSStyleRule,
	CSSMediaRule,
	CSSSupportsRule,
	CSSContainerRule,
	CSSScopeRule,
	CSSStartingStyleRule,
	CSSLayerBlockRule,
	CSSLayerStatementRule,
	CSSNamespaceRule,
	CSSImportRule,
	CSSFontFaceRule,
	CSSNestedDeclarations,
	CSSPageRule,
	CSSCounterStyleRule,
	CSSPropertyRule,
	CSSFontPaletteValuesRule,
	CSSKeyframeRule,
	CSSFontFeatureValuesRule,
	CSSKeyframesRule,
]) {
	// The getter may live on a base class, so the chain is walked to find
	// it.
	let prototype: object | null = type.prototype;
	let descriptor: PropertyDescriptor | undefined;
	while (prototype && !descriptor) {
		descriptor = Object.getOwnPropertyDescriptor(prototype, "cssText");
		prototype = Object.getPrototypeOf(prototype);
	}
	if (!descriptor?.get) {
		continue;
	}
	Object.defineProperty(type.prototype, "cssText", {...descriptor, set() {}});
}

const elementSheets = new WeakMap<Element, CSSStyleSheet>();

const adoptedSheets = new WeakMap<Node, CSSStyleSheet[]>();

// A bare fragment is a document fragment too and hosts nothing, which
// is what separates it from a tree some element composes.
function isShadowRoot(root: Node): root is ShadowRoot {
	return root.nodeType === 11 && (root as ShadowRoot).host !== undefined;
}

function getSheet(element: Element): CSSStyleSheet {
	let sheet = elementSheets.get(element);
	if (!sheet) {
		sheet = new CSSStyleSheet({}, element);
		sheetNotifiers.set(sheet, () => {
			const cascade = getTreeCascade(element);
			if (!cascade) {
				return;
			}
			// A shadow sheet's change syncs its root. Only a document
			// sheet's change rebuilds the document cascade.
			const root = element.getRootNode();
			if (isShadowRoot(root)) {
				syncShadowRoot(cascade, root);
			} else {
				cascade.syncStylesheets();
			}
		});
		elementSheets.set(element, sheet);
	}
	return sheet;
}

// A <style>'s child list IS its stylesheet. Changing it replaces the
// rules even when the resulting text is the same.
function reparseOwnerText(sheet: CSSStyleSheet): void {
	sheet[kText] = null;
}

// What `styleSheets` lists. An adopted sheet belongs to no element and
// is not included.
function getDeclaredStyleSheets(root: Document | ShadowRoot): CSSStyleSheet[] {
	return Array.from(root.querySelectorAll("style"), getSheet);
}

// A `<link>` never resolves to a sheet, because there is no network
// behind a terminal document.
function getDocumentStyleSheets(document: Document): CSSStyleSheet[] {
	return [
		...getDeclaredStyleSheets(document),
		...(adoptedSheets.get(document) ?? []),
	];
}

function getShadowStyleSheets(root: ShadowRoot): CSSStyleSheet[] {
	return [...getDeclaredStyleSheets(root), ...(adoptedSheets.get(root) ?? [])];
}

function getTreeCascade(tree: Node): Cascade | undefined {
	const document = tree.nodeType === tree.DOCUMENT_NODE
		? (tree as Document)
		: tree.ownerDocument;
	return document ? documentCascades.get(document) : undefined;
}

function checkAdoptable(tree: Node, sheet: unknown): CSSStyleSheet {
	if (!(sheet instanceof CSSStyleSheet)) {
		throw typeError("adoptedStyleSheets takes CSSStyleSheet objects");
	}
	if (!constructedSheets.has(sheet)) {
		throw domException(
			"Can't adopt a stylesheet that was not constructed",
			"NotAllowedError",
			sheet,
		);
	}
	sheetNotifiers.set(sheet, () => getTreeCascade(tree)?.syncStylesheets());
	return sheet;
}

// A constructed sheet has no consumer until something adopts it.
function adopt(target: Node, sheets: unknown): void {
	const adopted = Array.from(sheets as Iterable<unknown>)
		.map((sheet) => checkAdoptable(target, sheet));
	// One array per tree, replaced in place, so the observable array an
	// author already holds is the same object after a whole reassignment.
	let list = adoptedSheets.get(target);
	if (!list) {
		adoptedSheets.set(target, (list = []));
	}
	list.length = 0;
	for (const [index, sheet] of adopted.entries()) {
		defineIndex(list, index, sheet);
	}
}

// A plain assignment consults the prototype chain, so an accessor
// installed at Array.prototype[1] would run with the backing list as its
// receiver, handing an author the list and swallowing the write.
// Defining the property writes with no chain lookup.
function defineIndex(
	list: CSSStyleSheet[],
	index: number | string,
	sheet: unknown,
): boolean {
	return Reflect.defineProperty(list, index, {
		value: sheet,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

const adoptedProxies = new WeakMap<Node, CSSStyleSheet[]>();

// The list an author holds is the list the cascade reads. push, splice
// and an indexed write all take effect the same as a whole reassignment.
function observableAdopted(
	target: Node,
	list: CSSStyleSheet[],
): CSSStyleSheet[] {
	let proxy = adoptedProxies.get(target);
	if (proxy) {
		return proxy;
	}
	const changed = (): void => {
		getTreeCascade(target)?.syncStylesheets();
	};
	// Assignment to arbitrary indices of adoptedStyleSheets must be
	// observed.
	// eslint-disable-next-line no-restricted-globals
	proxy = new Proxy(list, {
		set(array, property, value) {
			if (typeof property === "string" && /^\d+$/.test(property)) {
				checkAdoptable(target, value);
				const defined = defineIndex(array, property, value);
				if (defined) {
					changed();
				}
				return defined;
			}
			const ok = Reflect.set(array, property, value);
			if (ok) {
				changed();
			}
			return ok;
		},
		deleteProperty(array, property) {
			// No notification here. An array method that deletes an index
			// (`pop`, `shift`) writes the new length right after, and the
			// cascade must not read the list between the two.
			return Reflect.deleteProperty(array, property);
		},
	});
	adoptedProxies.set(target, proxy);
	return proxy;
}

// Every CSSOM interface names itself, as any platform object does.
for (const [name, type] of Object.entries({
	CSSStyleSheet,
	StyleSheetList,
	CSSRuleList,
	CSSRule,
	CSSStyleRule,
	CSSGroupingRule,
	CSSConditionRule,
	CSSMediaRule,
	CSSSupportsRule,
	CSSContainerRule,
	CSSImportRule,
	CSSNamespaceRule,
	CSSKeyframesRule,
	CSSKeyframeRule,
	CSSFontFaceRule,
	CSSPageRule,
	CSSCounterStyleRule,
	CSSPropertyRule,
	CSSFontPaletteValuesRule,
	CSSFontFeatureValuesRule,
	CSSLayerBlockRule,
	CSSLayerStatementRule,
	CSSScopeRule,
	CSSStartingStyleRule,
	MediaList,
	CSSStyleDeclaration,
	CSSStyleProperties,
})) {
	Object.defineProperty(
		(type as {prototype: object}).prototype,
		Symbol.toStringTag,
		{value: name, configurable: true},
	);
}

// Parsed once. Its rules never change.
let uaDocumentSheet: CSSStyleSheet | null = null;

function getUAStyleSheet(): CSSStyleSheet {
	if (!uaDocumentSheet) {
		uaDocumentSheet = new CSSStyleSheet();
		uaDocumentSheet.replaceSync(
			UA_ELEMENT_STYLES + UA_DOCUMENT_STYLES + UA_CONTROL_STYLES,
		);
	}
	return uaDocumentSheet;
}

const kCascade = Symbol("cascade");

// A pseudo-element's declaration resolves through a view whose
// [kElement] is the pseudo-element's own node, so there is one copy of
// the measurement arithmetic.
interface MeasuredDeclaration {
	[kElement]: Element;
	[kCascade]: Cascade | null;
	[kComputedValue](property: string): string;
	getPropertyValue(property: string): string;
}

/**
 * The COMPUTED value: what the cascade says before any box exists. This
 * is not what getComputedStyle returns (getResolvedStyle is that). A used
 * value here would feed layout its own output, and this is called
 * thousands of times a frame, so it must never take a branch that needs
 * layout. Asked about a pseudo-element by name, it returns the bare
 * declarations (empty means no rule reached it). Asked about a
 * pseudo-element's NODE, it returns declarations completed with initial
 * values, so a box has a `display` to lay out from.
 */
export function getComputedValue(
	element: Element,
	property: string,
	pseudoElement = "",
): string {
	// A pseudo-element node's style is its host's declaration for the
	// pseudo-element it fills. It matches no selector of its own.
	const host = getPseudoHost(element);
	if (host !== null) {
		const name = getPseudoName(element) as string;
		const cascade = host.ownerDocument
			? documentCascades.get(host.ownerDocument)
			: undefined;
		return cascade
			? getPseudoDeclaration(cascade, host, name).nodeValue(property)
			: getComputedValue(host, property, name);
	}
	const document = element.ownerDocument;
	if (!document) {
		return "";
	}
	const cascade = documentCascades.get(document);
	if (!cascade) {
		return "";
	}
	const declaration = pseudoElement
		? getPseudoDeclaration(cascade, element, pseudoElement)
		: cascade.declarationFor(element);
	return declaration[kComputedValue](property);
}

// Only declarations handed to an author materialize an item list. The
// engine's own computed styles never do. Every computed declaration lists
// the same longhands first, so their indices are accessors on the shared
// prototype, and an instance holds only its custom properties' indices.
function getIndexedDeclaration<T extends CSSStyleDeclaration>(
	declaration: T,
): T {
	const indexed = declaration as unknown as IndexedCollection;
	if (
		indexed[kIndexCount] === undefined &&
		(declaration instanceof ComputedStyleDeclaration ||
			declaration instanceof PseudoStyleDeclaration)
	) {
		indexed[kIndexCount] = CSS_LONGHANDS.length;
	}
	syncIndexed(declaration);
	return declaration;
}

function defineLonghandIndices(prototype: object): void {
	for (let index = 0; index < CSS_LONGHANDS.length; index++) {
		Object.defineProperty(prototype, index, {
			get(this: IndexedCollection): unknown {
				return this.item(index);
			},
			enumerable: true,
			configurable: true,
		});
	}
}

const kCSSRules = Symbol("cssRules");
const kSyncResolved = Symbol("syncResolved");
const kResolved = Symbol("resolved");
const kStyleVersion = Symbol("styleVersion");
const kCustom = Symbol("custom");
const kInlineBlock = Symbol("inlineBlock");
const kUsedValue = Symbol("usedValue");
const kBaseValue = Symbol("baseValue");
const kActiveTransitions = Symbol("activeTransitions");
const kCurrentDeclarations = Symbol("currentDeclarations");

// Writing a computed style is an error, not a no-op. It throws the
// document's own DOMException, since one from another global is not
// what an author catches.
function readOnlyDeclaration(element?: Element): DOMException {
	const document = element ? element.ownerDocument : null;
	const view = document ? document.defaultView : null;
	const Exception =
		(view as unknown as {DOMException?: typeof DOMException} | null)
			?.DOMException ?? DOMException;
	return new Exception(
		"A computed style declaration is read-only",
		"NoModificationAllowedError",
	);
}

// Resolve to the USED track sizes, not the sizing functions the author
// wrote (css-grid-2 §7.2).
const USED_TRACK_PROPERTIES = new Set([
	"grid-template-columns",
	"grid-template-rows",
]);

// `auto` here means a minimum only some boxes have.
const MIN_SIZE_PROPERTIES = new Set(["min-width", "min-height"]);

// `auto` on these means the element's own color, and the resolved value
// CSSOM reports is that used color.
const AUTO_COLOR_PROPERTIES = new Set(["caret-color", "outline-color"]);

// The properties whose resolved value is the used value, per CSSOM.
// Everything else resolves to its computed value.
const USED_VALUE_PROPERTIES = new Set([
	"border-bottom-width",
	"border-left-width",
	"border-right-width",
	"border-top-width",
	"bottom",
	"height",
	"left",
	"margin-bottom",
	"margin-left",
	"margin-right",
	"margin-top",
	"padding-bottom",
	"padding-left",
	"padding-right",
	"padding-top",
	"right",
	"top",
	"width",
]);

// Style sharing. An element's computed values follow from its matched
// rules, its attributes (inline style and the presentational hints the UA
// reads, like an input's size), its tag, and its flat-tree parent's
// values. Elements alike in all of those resolve every property alike, so
// they share one table of resolved values, filled as any of them reads.
// Each parent's values hold the tables of their children, and go with
// them. The page-facing declaration stays per element: its used values
// read the element's own boxes.
const ruleIds = new WeakMap<ParsedCSSRule, number>();
let nextRuleId = 0;
const ruleIndexes = new WeakMap<Cascade, RuleIndex>();
const childTables = new WeakMap<
	Map<string, string>,
	Map<string, Map<string, string>>
>();
const treeTables = new WeakMap<
	ShadowRoot,
	Map<Map<string, string>, Map<string, Map<string, string>>>
>();

// Counters count elements in document order, so a rule that sets or uses
// them gives each element its own values.
const COUNTER_PROPERTIES = [
	"content",
	"counter-reset",
	"counter-increment",
	"counter-set",
];

// One rule per set of hints, so elements with the same attributes share
// their computed values as they would with the same rules.
const hintRules = new Map<string, ParsedCSSRule>();

function getHintRule(element: Element): ParsedCSSRule | null {
	const hints = getPresentationalHints(element);
	if (hints === null) {
		return null;
	}
	const key = JSON.stringify(hints);
	let rule = hintRules.get(key);
	if (rule === undefined) {
		const properties = Object.keys(hints);
		rule = {
			matcher: null,
			relativeMatcher: null,
			declarations: hints,
			important: {},
			order: Object.fromEntries(properties.map((name, i) => [name, i])),
			specificity: "",
			layerRank: -1,
		} as unknown as ParsedCSSRule;
		if (hintRules.size > 1024) {
			hintRules.clear();
		}
		hintRules.set(key, rule);
	}
	return rule;
}

function getRuleId(rule: ParsedCSSRule): number {
	let id = ruleIds.get(rule);
	if (id === undefined) {
		id = COUNTER_PROPERTIES.some((name) =>
			(rule.declarations[name] ?? "").includes("counter"),
		)
			? -1
			: ++nextRuleId;
		ruleIds.set(rule, id);
	}
	return id;
}

// An element whose values read more than those inputs keeps its own: the
// fullscreen element, a select sized by its options, a list whose gutter
// its markers size and whose marker type its depth picks, a dir=auto
// element directed by its text, and MathML, which reads its ancestors.
const UNSHARED_ELEMENTS = new Set(["select", "ul", "ol"]);

function isShareable(element: Element): boolean {
	return (
		element.namespaceURI === HTML_NAMESPACE &&
		!UNSHARED_ELEMENTS.has(element.localName) &&
		element.getAttribute("dir") !== "auto" &&
		element.ownerDocument?.fullscreenElement !== element &&
		getPseudoHost(element) === null
	);
}

// The parent's resolved values, current, or null for a parent a
// transition is moving, whose values are its own.
function getResolvedValues(
	cascade: Cascade,
	element: Element,
): Map<string, string> | null {
	if (cascade.getStyleKey(element) === null) {
		return null;
	}
	return cascade.declarationFor(element)[kResolved];
}

function getSharedResolved(
	cascade: Cascade,
	element: Element,
	rules: readonly ParsedCSSRule[],
): Map<string, string> {
	if (!isShareable(element)) {
		return new Map();
	}
	let key = element.localName;
	for (const rule of rules) {
		const id = getRuleId(rule);
		if (id === -1) {
			return new Map();
		}
		key += `,${id}`;
	}
	for (const attribute of getAttributeList(element)) {
		key += `\0${attribute.namespaceURI ?? ""}:${attribute.localName}=${attribute.value}`;
	}
	const parent = flatParentElement(element);
	let table: Map<string, Map<string, string>>;
	if (parent === null) {
		table = cascade[kSharedRoot];
		if (table.size > 256) {
			table.clear();
		}
	} else {
		const parentValues = getResolvedValues(cascade, parent);
		if (parentValues === null) {
			return new Map();
		}
		// The top of a shadow tree keeps its tables on the tree, so they go
		// with it. The host's values outlive the tree.
		const scope = element.parentNode;
		if (scope !== null && isShadowRoot(scope)) {
			let byParent = treeTables.get(scope);
			if (byParent === undefined) {
				byParent = new Map();
				treeTables.set(scope, byParent);
			}
			table = byParent.get(parentValues) ?? new Map();
			byParent.set(parentValues, table);
		} else {
			table = childTables.get(parentValues) ?? new Map();
			childTables.set(parentValues, table);
		}
		// Bounded as the root's is: each child with an inline style of its
		// own adds a table.
		if (table.size > 256) {
			table.clear();
		}
	}
	let shared = table.get(key);
	if (shared === undefined) {
		shared = new Map();
		table.set(key, shared);
	}
	return shared;
}

// LIVE: the object an author holds stays valid across class changes and
// sheet replacements, because it re-resolves rather than being replaced.
interface ComputedStyleDeclaration {
	[kElement]: Element;
	[kCSSRules]: ParsedCSSRule[];

	[kCascade]: Cascade | null;
	[kInlineBlock]: CSSValues.DeclarationBlock | null;

	// Computed strings, memoized once per property per resolution, ""
	// results included. An inherited property re-resolved on every read
	// would re-walk the whole ancestor chain, thousands of times per
	// keystroke. The declaration is discarded wholesale on invalidation, so
	// the memo needs no invalidation of its own.
	[kResolved]: Map<string, string>;
	// Replaced whenever this declaration is resolved again. What the
	// painter keys its styles by, since the resolved values themselves may
	// be shared, and a restyle that finds the same shared values still asks
	// for the paint style to be derived again.
	[kStyleVersion]: object;

	[kCustom]: string[] | null;
}

class ComputedStyleDeclaration extends CSSStyleProperties {
	constructor(
		element: Element,
		cssRules: ParsedCSSRule[] = [],
		cascade?: Cascade,
	) {
		super();
		this[kCascade] = null;
		this[kResolved] = new Map<string, string>();
		this[kStyleVersion] = {};
		this[kCustom] = null;
		this[kElement] = element;
		this[kCSSRules] = cssRules;
		this[kInlineBlock] = null;
		if (cascade) {
			this[kCascade] = cascade;
			cascade[kCurrentDeclarations].add(this);
			this[kResolved] = getSharedResolved(cascade, element, cssRules);
		}
	}

	override get length(): number {
		return CSS_LONGHANDS.length + getCustomNames(this).length;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement]);
	}

	override get parentRule(): CSSRule | null {
		return null;
	}

	// Fully lazy. Most elements are only ever asked a handful of
	// properties. The composition walker asks each element only `display`.
	override getPropertyValue(property: string): string {
		// The author's read describes the DOM as it currently is. The engine
		// reads through getComputedValue, which does not flush, because style
		// is resolved from inside layout, which a flush would re-enter.
		if (this[kCascade]) {
			flushCascadeStyle(this[kCascade]);
		}
		const current = this[kCascade]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kSyncResolved]();
		}
		// A flow-relative longhand resolves as the physical longhand it maps
		// to: same slot, same measurement, same result.
		property = toPhysicalProperty(this, property);
		if (this[kCascade] && USED_VALUE_PROPERTIES.has(property)) {
			return this[kUsedValue](property);
		}
		if (this[kCascade] && MIN_SIZE_PROPERTIES.has(property)) {
			return getResolvedMinSize(this, this[kComputedValue](property));
		}
		if (this[kCascade] && USED_TRACK_PROPERTIES.has(property)) {
			const tracks = usedGridTracks(
				this[kCascade],
				this[kElement],
				property === "grid-template-rows",
			);
			if (tracks) {
				return tracks.length > 0
					? tracks.map(CSSValues.getUsedLength).join(" ")
					: "none";
			}
		}
		const longhands = CSSValues.getLonghands(property);
		if (longhands) {
			return CSSValues.resolveShorthand(property, longhands, (longhand) =>
				this.getPropertyValue(longhand),
			);
		}
		let computed = this[kComputedValue](property);
		if (AUTO_COLOR_PROPERTIES.has(property) && computed === "auto") {
			computed = this[kComputedValue]("color");
		}
		// A system color computes as its keyword, and reads back as the color
		// it stands for here.
		if (this[kCascade] && CSSValues.isColorProperty(property)) {
			return CSSValues.resolveSystemColor(
				computed,
				getColorScheme(this[kElement].ownerDocument),
			) ?? computed;
		}
		return computed;
	}

	override setProperty(): void {
		throw readOnlyDeclaration(this[kElement]);
	}

	override removeProperty(): string {
		throw readOnlyDeclaration(this[kElement]);
	}

	override getPropertyPriority(): string {
		return "";
	}

	// Every supported longhand in the property index's order, then the
	// custom properties in effect, which have no place in that index.
	override item(index: number): string {
		return (
			CSS_LONGHANDS[index] ??
			getCustomNames(this)[index - CSS_LONGHANDS.length] ??
			""
		);
	}

	override [Symbol.iterator](): IterableIterator<string> {
		return [...CSS_LONGHANDS, ...getCustomNames(this)][Symbol.iterator]();
	}

	[kCustomProperties](): string[] {
		const names: string[] = [];
		for (const rule of this[kCSSRules]) {
			for (const name of Object.keys(rule.declarations)) {
				if (name.startsWith("--") && !names.includes(name)) {
					names.push(name);
				}
			}
		}
		for (const name of Object.keys(getInlineDeclarations(this).declarations)) {
			if (name.startsWith("--") && !names.includes(name)) {
				names.push(name);
			}
		}
		return names;
	}

	// Measured through the same flush a geometry read takes, and memoized
	// behind it, so a property-heavy caller measures once per layout. The
	// memo belongs to the cascade, which lets a flush drop every one.
	[kUsedValue](property: string): string {
		const cascade = this[kCascade]!;
		const used = getUsedValues(cascade, this);
		const memoized = used.get(property);
		if (memoized !== undefined) {
			return memoized;
		}

		const computed = this[kComputedValue](property);
		const value = measureUsedValue(this, property, computed);
		used.set(property, value);
		return value;
	}

	// The cascade's value before a running transition overrides it, meaning
	// the after-change style. An interpolated value moves every frame and
	// must never enter the memo.
	[kBaseValue](property: string): string {
		let value = this[kResolved].get(property);
		if (value === undefined) {
			const longhands = CSSValues.getLonghands(property);
			value = longhands
				? CSSValues.resolveShorthand(property, longhands, (longhand) =>
					this[kBaseValue](longhand),
				)
				: getAbsolutizedValue(this, toPhysicalProperty(this, property));
			this[kResolved].set(property, value);
		}
		return value;
	}

	// Reads call this only when the cascade no longer vouches for this
	// declaration. It runs under every property read of every element.
	[kSyncResolved](): void {
		if (!this[kCascade]) {
			return;
		}
		// Before the work, because resolving below reads back through this
		// declaration.
		this[kCascade][kCurrentDeclarations].add(this);
		this[kCSSRules] = getCascadeRules(this[kCascade], this[kElement]);
		this[kInlineBlock] = null;
		this[kCustom] = null;
		storeTransitionFallback(
			this[kCascade],
			this[kElement],
			"",
			this[kResolved],
		);
		this[kResolved] = getSharedResolved(
			this[kCascade],
			this[kElement],
			this[kCSSRules],
		);
		this[kStyleVersion] = {};
		dropUsedValues(this[kCascade], this);
		if ((this as IndexedCollection)[kIndexCount] !== undefined) {
			syncIndexed(this);
		}
		// The re-resolution is a style change event. Whatever changed against
		// the last snapshot starts, retargets or cancels transitions.
		processTransitionStyle(
			this[kCascade],
			this[kElement],
			(property) => this[kBaseValue](property),
			"",
		);
	}

	[kComputedValue](property: string): string {
		const current = this[kCascade]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kSyncResolved]();
		}
		const value = this[kBaseValue](property);
		const cascade = this[kCascade];
		if (cascade !== null && cascade[kActiveTransitions].size > 0) {
			const transitional = getTransitionValue(
				cascade,
				this[kElement],
				"",
				property,
			);
			if (transitional !== null) {
				return transitional;
			}
		}
		return value;
	}
}

// The cascade's declaration, interned, and absolutized against this
// element when the interned entry says only an element can resolve it.
function getAbsolutizedValue(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	const entry = CSSValues.getComputedEntry(
		property,
		resolvePropertyValue(declaration, property),
	);
	if (!entry.contextual) {
		return entry.value;
	}
	const absolute = CSSValues.absolutizeLengths(
		entry.value,
		getLengthContext(declaration, property),
	);
	// Two radii that differ as written (`1ch 1px`) can measure the same
	// cell, and a corner whose radii agree states one of them.
	return CSSValues.collapseRadius(property, absolute);
}

// Whether a property's lengths run down the page. A font's size and a
// line's height are heights, and a flex basis runs along its container.
const VERTICAL_LENGTH = /(?:^|-)(?:top|bottom|height|block|rows?)(?:-|$)/;

function isVerticalLength(element: Element, property: string): boolean {
	if (property === "flex-basis") {
		const parent = flatParentElement(element);
		return parent !== null &&
			getComputedValue(parent, "flex-direction").startsWith("column");
	}
	return (
		VERTICAL_LENGTH.test(property) ||
		property === "row-gap" ||
		property === "line-height" ||
		property === "font-size" ||
		property === "vertical-align"
	);
}

// `font-size` measures against the PARENT's font size, so it is the one
// property whose own computed value is not in its own context.
function getLengthContext(
	declaration: ComputedStyleDeclaration,
	property: string,
): CSSValues.LengthContext {
	const own = property === "font-size";
	const parent = own ? flatParentElement(declaration[kElement]) : null;
	const initial = getCellSize(declaration[kElement]).height;
	const font = CSSValues.getFontSize(
		own
			? parent ? getComputedValue(parent, "font-size") : ""
			: declaration[kComputedValue]("font-size"),
		initial,
	);
	const root = getRootFontSize(declaration, own);
	const cascade = declaration[kCascade];
	const block = cascade ? cascade[kLayout].initialContainingBlock : null;
	const cell = getCellSize(declaration[kElement]);
	return {
		font,
		root,
		cellWidth: cell.width,
		cellAlong: isVerticalLength(declaration[kElement], property)
			? cell.height
			: cell.width,
		// Every line is drawn one row tall, so a line is a cell's height
		// whatever line-height says.
		line: cell.height,
		viewportWidth: block ? block.width * cell.width : 0,
		viewportHeight: block ? block.height * cell.height : 0,
		// A percentage is font-relative on exactly two properties. On
		// `font-size` it is a share of the parent's, on `line-height` of this
		// element's own. Everywhere else it stays a percentage until used.
		percent: CSSValues.isFontRelativePercentage(property) ? font / 100 : null,
	};
}

function getRootFontSize(
	declaration: ComputedStyleDeclaration,
	ownFontSize: boolean,
): number {
	const root = declaration[kElement].ownerDocument?.documentElement;
	// `rem` in the root's own font-size means the initial value, not the
	// value being computed.
	return CSSValues.getFontSize(
		!root || (ownFontSize && root === declaration[kElement])
			? ""
			: root === declaration[kElement]
				? declaration[kComputedValue]("font-size")
				: getComputedValue(root, "font-size"),
		getCellSize(declaration[kElement]).height,
	);
}

function toPhysicalProperty(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	if (!CSSValues.isFlowRelative(property)) {
		return property;
	}
	return (
		CSSValues.getPhysicalProperty(
			property,
			declaration[kComputedValue]("direction"),
		) ?? property
	);
}

const INSET_PROPERTIES = new Set(["top", "right", "bottom", "left"]);

function measureUsedValue(
	declaration: MeasuredDeclaration,
	property: string,
	computed: string,
): string {
	// A border with no style draws nothing and takes no space, whatever
	// width it declares.
	if (property.startsWith("border-") && property.endsWith("-width")) {
		const style = declaration[kComputedValue](
			`${property.slice(0, -"-width".length)}-style`,
		);
		if (!style || style === "none" || style === "hidden") {
			return "0px";
		}
	}
	const inset = INSET_PROPERTIES.has(property);
	// An inset only applies to a positioned box. On a static one it stays as
	// declared.
	const position = inset ? declaration.getPropertyValue("position") : "";
	if (inset && position === "static") {
		return computed;
	}

	const rect = getUsedRect(declaration[kCascade]!, declaration[kElement]);
	// No box (display:none, or a tree layout never reached), so the
	// computed value is the result, exactly as CSSOM says.
	if (!rect) {
		return computed;
	}

	if (inset) {
		return getUsedInset(declaration, property, computed, rect, position);
	}

	if (property === "width" || property === "height") {
		const vertical = property === "height";
		const border = vertical ? rect.height : rect.width;
		// The used value of width is the box box-sizing names, so a
		// border-box element reads its border box (css-sizing-3 §3.1).
		if (declaration[kComputedValue]("box-sizing") === "border-box") {
			return CSSValues.getUsedLength(Math.max(0, border));
		}
		const edges =
			getEdgeLength(
				declaration,
				vertical ? "border-top-width" : "border-left-width",
			) +
			getEdgeLength(
				declaration,
				vertical ? "border-bottom-width" : "border-right-width",
			) +
			getEdgeLength(declaration, vertical ? "padding-top" : "padding-left") +
			getEdgeLength(declaration, vertical ? "padding-bottom" : "padding-right");
		return CSSValues.getUsedLength(Math.max(0, border - edges));
	}

	// An `auto` margin is whatever space the box was given: the distance
	// between its border box and its containing block's content edge.
	if (computed === "auto" && property.startsWith("margin-")) {
		return CSSValues.getUsedLength(getAutoMargin(declaration, property, rect));
	}

	// Every other used length is already absolute in this engine's own
	// unit, so the computed value carries it. Only a percentage still has to
	// be resolved, against the containing block's width.
	if (computed.endsWith("%")) {
		const basis = getContainingWidth(declaration);
		if (basis === null) {
			return computed;
		}
		return CSSValues.getUsedLength((parseFloat(computed) / 100) * basis);
	}
	return computed || "0px";
}

const OPPOSITE_INSET: Record<string, string> = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left",
};

// A declared inset resolves as written. `auto` is the one that has to be
// measured, to whatever distance the box ended up at.
function getUsedInset(
	declaration: MeasuredDeclaration,
	property: string,
	computed: string,
	rect: DOMRect,
	position: string,
): string {
	const block = getContainingBlockBox(declaration, position);
	if (!block) {
		return computed;
	}
	const vertical = property === "top" || property === "bottom";
	const basis = vertical ? block.height : block.width;
	const own = CSSValues.getInsetLength(computed, basis);
	if (own !== null) {
		return CSSValues.getUsedLength(own);
	}
	// A sticky box keeps its `auto`. It names an edge that constrains
	// nothing, not a distance.
	if (position === "sticky") {
		return computed;
	}

	const opposite = OPPOSITE_INSET[property];
	const other = CSSValues.getInsetLength(
		declaration[kComputedValue](opposite),
		basis,
	);
	// A relatively positioned box is offset from where it already was, so
	// an `auto` inset is the negative of its opposite, and zero when both
	// are auto, which moves the box nowhere.
	if (position === "relative") {
		return CSSValues.getUsedLength(other === null ? 0 : -other);
	}

	// Out of flow: the box hangs in its containing block, so the used inset
	// is the distance from that block's edge to the box's margin edge. That
	// is the far side of the box when the opposite inset placed it, and its
	// static position when neither did.
	const start = vertical ? "margin-top" : "margin-left";
	const end = vertical ? "margin-bottom" : "margin-right";
	if (other !== null) {
		const size =
			(vertical ? rect.height : rect.width) +
			getEdgeLength(declaration, start) +
			getEdgeLength(declaration, end);
		return CSSValues.getUsedLength(basis - other - size);
	}
	switch (property) {
		case "top":
			return CSSValues.getUsedLength(
				rect.y - getEdgeLength(declaration, start) - block.y,
			);
		case "left":
			return CSSValues.getUsedLength(
				rect.x - getEdgeLength(declaration, start) - block.x,
			);
		case "bottom":
			return CSSValues.getUsedLength(
				block.y +
				block.height -
				(rect.y + rect.height + getEdgeLength(declaration, end)),
			);
		default:
			return CSSValues.getUsedLength(
				block.x +
				block.width -
				(rect.x + rect.width + getEdgeLength(declaration, end)),
			);
	}
}

// The padding box of the block an out-of-flow box hangs from, the
// scrollport a sticky box is constrained by, and otherwise the content
// box of the box this one flows in.
function getContainingBlockBox(
	declaration: MeasuredDeclaration,
	position: string,
): DOMRect | null {
	if (position === "fixed") {
		return getViewportBox(declaration);
	}
	if (position === "absolute") {
		for (
			let ancestor = flatParentElement(declaration[kElement]);
			ancestor;
			ancestor = flatParentElement(ancestor)
		) {
			const ancestorPosition = getComputedValue(ancestor, "position");
			if (ancestorPosition && ancestorPosition !== "static") {
				return getUsedBoxRect(declaration, ancestor, false);
			}
		}
		return getViewportBox(declaration);
	}
	if (position === "sticky") {
		for (
			let ancestor = flatParentElement(declaration[kElement]);
			ancestor;
			ancestor = flatParentElement(ancestor)
		) {
			const overflow = getComputedValue(ancestor, "overflow");
			if (overflow && overflow !== "visible") {
				return getUsedBoxRect(declaration, ancestor, true);
			}
		}
	}
	const parent = flatParentElement(declaration[kElement]);
	return parent
		? getUsedBoxRect(declaration, parent, true)
		: getViewportBox(declaration);
}

function getUsedBoxRect(
	declaration: MeasuredDeclaration,
	element: Element,
	content: boolean,
): DOMRect | null {
	const rect = getUsedRect(declaration[kCascade]!, element);
	if (!rect) {
		return null;
	}
	const edge = (name: string): number =>
		parseFloat(getComputedValue(element, name)) || 0;
	let top = edge("border-top-width");
	let left = edge("border-left-width");
	let bottom = edge("border-bottom-width");
	let right = edge("border-right-width");
	if (content) {
		top += edge("padding-top");
		left += edge("padding-left");
		bottom += edge("padding-bottom");
		right += edge("padding-right");
	}
	return new (rect.constructor as typeof DOMRect)(
		rect.x + left,
		rect.y + top,
		rect.width - left - right,
		rect.height - top - bottom,
	);
}

// The initial containing block: the grid itself.
function getViewportBox(declaration: MeasuredDeclaration): DOMRect | null {
	const block = declaration[kCascade]![kLayout].initialContainingBlock;
	const rect = getUsedRect(declaration[kCascade]!, declaration[kElement]);
	if (!rect) {
		return null;
	}
	return new (rect.constructor as typeof DOMRect)(
		0,
		0,
		pxFromCells(block.width, false, declaration[kElement]),
		pxFromCells(block.height, true, declaration[kElement]),
	);
}

const ITEM_DISPLAYS = new Set(["flex", "grid", "inline-flex", "inline-grid"]);

// `auto` means the automatic minimum only a flex or grid item, or an
// aspect-ratio box, actually has. Anywhere else it resolves to 0px.
function getResolvedMinSize(
	declaration: ComputedStyleDeclaration,
	computed: string,
): string {
	if (computed !== "auto") {
		return computed;
	}
	// A box that was never generated has no automatic minimum, whatever
	// else its style says.
	for (
		let element: Element | null = declaration[kElement];
		element;
		element = flatParentElement(element)
	) {
		if (getComputedValue(element, "display") === "none") {
			return "0px";
		}
	}
	if (declaration[kComputedValue]("aspect-ratio") !== "auto") {
		return "auto";
	}
	const parent = flatParentElement(declaration[kElement]);
	const display = parent ? getComputedValue(parent, "display") : "";
	return ITEM_DISPLAYS.has(display) ? "auto" : "0px";
}

// As layout drew it: a whole number of cells, given back in CSS pixels, so
// it measures against the rects it is subtracted from.
function getEdgeLength(
	declaration: MeasuredDeclaration,
	property: string,
): number {
	return toDrawnEdge(
		declaration[kElement],
		property,
		parseFloat(declaration.getPropertyValue(property)) || 0,
	);
}

function toDrawnEdge(element: Element, property: string, px: number): number {
	const vertical = /-(?:top|bottom)(?:-|$)/.test(property);
	if (property.startsWith("border-")) {
		return pxFromCells(
			toCellBorder(px, vertical, element) as number,
			vertical,
			element,
		);
	}
	const paired = property.startsWith("padding-")
		? getCellPadding(element)[
			property.slice("padding-".length) as "top" | "right" | "bottom" | "left"
		]
		: undefined;
	const cells = typeof paired === "number"
		? paired
		: toCellLength(px, vertical, element);
	return pxFromCells(cells as number, vertical, element);
}

// The space an `auto` margin actually took, measured from the two
// boxes.
function getAutoMargin(
	declaration: MeasuredDeclaration,
	property: string,
	rect: DOMRect,
): number {
	const parent = flatParentElement(declaration[kElement]);
	const parentRect = parent
		? getUsedRect(declaration[kCascade]!, parent)
		: null;
	if (!parent || !parentRect) {
		return 0;
	}
	const edge = (name: string): number =>
		toDrawnEdge(parent, name, parseFloat(getComputedValue(parent, name)) || 0);
	const left = parentRect.x + edge("border-left-width") + edge("padding-left");
	const top = parentRect.y + edge("border-top-width") + edge("padding-top");
	const right =
		parentRect.x +
		parentRect.width -
		edge("border-right-width") -
		edge("padding-right");
	const bottom =
		parentRect.y +
		parentRect.height -
		edge("border-bottom-width") -
		edge("padding-bottom");
	switch (property) {
		case "margin-left":
			return Math.max(0, rect.x - left);
		case "margin-top":
			return Math.max(0, rect.y - top);
		case "margin-right":
			return Math.max(0, right - (rect.x + rect.width));
		default:
			return Math.max(0, bottom - (rect.y + rect.height));
	}
}

function getContainingWidth(declaration: MeasuredDeclaration): number | null {
	const parent = flatParentElement(declaration[kElement]);
	if (!parent) {
		return null;
	}
	const rect = getUsedRect(declaration[kCascade]!, parent);
	return rect ? rect.width : null;
}

// The cascade gets the expanded block, so a shorthand's `!important`
// covers every longhand it declares.
function getInlineDeclarations(
	declaration: ComputedStyleDeclaration,
): CSSValues.DeclarationBlock {
	let block = declaration[kInlineBlock];
	if (block === null) {
		const element = declaration[kElement];
		let style = inlineStyles.get(element);
		if (style === undefined && element.hasAttribute("style")) {
			getInlineStyle(element);
			style = inlineStyles.get(element);
		}
		block = style === undefined
			? EMPTY_DECLARATIONS
			: getDeclarationBlock(style);
		declaration[kInlineBlock] = block;
	}
	return block;
}

function resolveFromParent(
	declaration: ComputedStyleDeclaration,
	property: string,
): string | null {
	const parent = flatParentElement(declaration[kElement]);
	if (!parent) {
		return null;
	}
	return getComputedValue(parent, property) || null;
}

// Substituted values are substituted in turn. The depth guard stops a
// property that (invalidly) refers to itself.
function substituteVar(
	declaration: ComputedStyleDeclaration,
	value: string,
	depth = 0,
): string {
	if (depth > 8 || !value.includes("var(")) {
		return value;
	}

	let out = "";
	let i = 0;
	while (i < value.length) {
		const start = value.indexOf("var(", i);
		if (start === -1) {
			out += value.slice(i);
			break;
		}
		out += value.slice(i, start);

		let parenDepth = 1;
		let j = start + 4;
		for (; j < value.length && parenDepth > 0; j++) {
			if (value[j] === "(") {
				parenDepth++;
			} else if (value[j] === ")") {
				parenDepth--;
			}
		}
		const inner = value.slice(start + 4, j - 1);
		const commaIndex = inner.indexOf(",");
		const name = (
			commaIndex === -1 ? inner : inner.slice(0, commaIndex)
		).trim();
		const fallback = commaIndex === -1
			? undefined
			: inner.slice(commaIndex + 1).trim();

		// A custom property is an ordinary (always-inherited) cascade lookup.
		// resolvePropertyValueRaw's step 4 already walks ancestors for it.
		const resolved = resolvePropertyValueRaw(declaration, name) || null;
		if (resolved !== null) {
			out += substituteVar(declaration, resolved, depth + 1);
		} else if (fallback !== undefined) {
			out += substituteVar(declaration, fallback, depth + 1);
		}
		// Neither a value nor a fallback: the guaranteed-invalid value. Omit
		// it, which approximates the property's own initial/inherited fallback.
		i = j;
	}
	return out;
}

/**
 * The white-space keyword layout lays an element's text out by, from the
 * two longhands, the nearest keyword where no keyword stands for them.
 */
export function getWhiteSpace(element: Element): string {
	return CSSValues.getLayoutWhiteSpace(
		getComputedValue(element, "white-space-collapse"),
		getComputedValue(element, "text-wrap-mode"),
	);
}

const declaredDisplays = new WeakMap<ComputedStyleDeclaration, string>();

/**
 * The display an element's rules give it, before blockification. Layout
 * blockifies for itself, as the used value, since an inline item still
 * measures its content as lines. Everything else reads the computed
 * display, blockified.
 */
export function getDeclaredDisplay(element: Element): string {
	const document = element.ownerDocument;
	const cascade = document ? documentCascades.get(document) : undefined;
	if (getPseudoHost(element) !== null || cascade === undefined) {
		return getComputedValue(element, "display");
	}
	const declaration = cascade.declarationFor(element);
	let display = declaredDisplays.get(declaration);
	if (display === undefined) {
		display = CSSValues.getComputedEntry(
			"display",
			resolveCascadedValue(declaration, "display") ||
				getInitialStyle(null, "display"),
		).value;
		declaredDisplays.set(declaration, display);
	}
	return display;
}

// css-display-3 §2.7: the root element, an absolutely positioned or
// floated box, and a flex or grid item are block-level whatever their
// display says, and their computed display says so. The root's contents
// is a block too, since the root has no parent to hand its children to.
function blockifyDisplay(element: Element | null, display: string): string {
	if (element === null || display === "none") {
		return display;
	}
	if (element === element.ownerDocument?.documentElement) {
		return display === "contents"
			? "block"
			: CSSValues.getBlockifiedDisplay(display);
	}
	const position = getComputedValue(element, "position");
	let parent = flatParentElement(element);
	while (
		parent !== null && getComputedValue(parent, "display") === "contents"
	) {
		parent = flatParentElement(parent);
	}
	if (
		position === "absolute" ||
		position === "fixed" ||
		getComputedValue(element, "float") !== "none" ||
		(parent !== null && ITEM_DISPLAYS.has(getComputedValue(parent, "display")))
	) {
		return CSSValues.getBlockifiedDisplay(display);
	}
	return display;
}

// A progress bar's fill, inside the UA shadow tree of a <progress>.
function isProgressFill(element: Element | null): boolean {
	if (element === null) {
		return false;
	}
	const root = element.getRootNode();
	return isUAShadowTree(root) &&
		(root as unknown as ShadowRoot).host.tagName === "PROGRESS" &&
		(element.getAttribute("part") ?? "").split(" ").includes("bar");
}

// What the cascade leaves, with var() substituted, `currentcolor`
// replaced by the color it names, and display blockified.
function resolvePropertyValue(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	// css-ui-4 §6.1: a <progress> draws in its accent color, when the page
	// gives it one.
	if (property === "color" && isProgressFill(declaration[kElement])) {
		const accent = declaration[kComputedValue]("accent-color");
		if (accent !== "" && accent.toLowerCase() !== "auto") {
			return accent;
		}
	}
	const value = resolveCascadedValue(declaration, property);
	if (property === "font-weight") {
		return computeFontWeight(declaration[kElement], value);
	}
	// Every browser resets a legacy alignment at a table, so a centered
	// table's cells start their text where they would anywhere else.
	if (
		property === "text-align" &&
		CSSValues.getLegacyAlignment(value) !== null &&
		/^(?:inline-)?table$/.test(declaration[kComputedValue]("display"))
	) {
		return "start";
	}
	return property === "display"
		? blockifyDisplay(
			declaration[kElement],
			value || getInitialStyle(null, "display"),
		)
		: value;
}

// css-fonts-4 §2.2: a weight computes to a number. `bolder` and `lighter`
// step from the parent's weight by the specification's table.
function computeFontWeight(element: Element | null, value: string): string {
	const keyword = value.trim().toLowerCase();
	if (keyword === "normal") {
		return "400";
	}
	if (keyword === "bold") {
		return "700";
	}
	if (keyword !== "bolder" && keyword !== "lighter") {
		return value;
	}
	const parent = element === null ? null : flatParentElement(element);
	const inherited = parent === null
		? 400
		: CSSValues.parseFontWeight(getComputedValue(parent, "font-weight"));
	if (keyword === "bolder") {
		return inherited < 350 ? "400" : inherited < 550 ? "700" : "900";
	}
	return inherited < 550 ? "100" : inherited < 750 ? "400" : "700";
}

function resolveCascadedValue(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	const raw = resolvePropertyValueRaw(declaration, property);
	// A custom property holds the tokens it was given. Substituting it into
	// a property with its own grammar re-serializes them in that property's
	// spelling.
	const value = raw
		? !raw.includes("var(")
			? raw
			: property.startsWith("--")
				? substituteVar(declaration, raw)
				: CSSValues.serializeCSSValue(substituteVar(declaration, raw), property)
		: raw;
	// `currentcolor` is the element's own color, which is what a resolved
	// value reports. On `color` itself it means the parent's.
	if (
		value.toLowerCase() === "currentcolor" &&
		CSSValues.isColorProperty(property)
	) {
		// The COMPUTED color, on the engine's own read path. The author path
		// flushes, from inside the resolution of a style that layout is waiting
		// on.
		return property === "color"
			? (resolveFromParent(declaration, "color") ?? "")
			: declaration[kComputedValue]("color");
	}
	return value;
}

function resolvePropertyValueRaw(
	declaration: ComputedStyleDeclaration,
	property: string,
): string {
	// A physical property and its flow-relative names are ONE cascade slot
	// (css-logical-1 §2.1). The slot widens to both inline edges and narrows
	// by `direction` only once a block actually declares one of them.
	const names = CSSValues.getSlotCandidates(property);
	let direction: string | null = null;
	const mapsHere = names.length === 1
		? CSSValues.acceptsAnyName
		: (name: string): boolean =>
			name === property ||
			CSSValues.getPhysicalProperty(
				name,
				(direction ??= declaration[kComputedValue]("direction")),
			) === property;

	const inline = getInlineDeclarations(declaration);
	const inlineName = CSSValues.getDeclaredName(inline, names, false, mapsHere);
	const inlineValue = inlineName !== null
		? inline.declarations[inlineName].trim()
		: "";
	const inlineImportantName = CSSValues.getDeclaredName(
		inline,
		names,
		true,
		mapsHere,
	);
	const inlineImportantValue = inlineImportantName !== null
		? inline.declarations[inlineImportantName].trim()
		: "";

	// 1 & 2. Inline style and stylesheet rules, with an !important tier above
	// the normal cascade. The parsed rules are pre-sorted by specificity and
	// source order, so within each tier the last match wins.
	let ruleValue = "";
	let importantRuleValue = "";
	// `!important` reverses the origin and layer order (css-cascade-5 §6.1,
	// §6.4.4): a UA declaration beats an author one, the EARLIEST layer
	// wins, and unlayered declarations, which win the normal cascade, lose
	// to every layer. The rules arrive UA first and earliest layer first, so
	// the first origin and layer to declare the property keeps it, and
	// later rules only tie it within that same origin and layer.
	let importantOrigin = false;
	let importantLayer = 0;
	for (const rule of declaration[kCSSRules]) {
		const name = CSSValues.getDeclaredName(rule, names, false, mapsHere);
		if (name !== null) {
			ruleValue = rule.declarations[name];
		}
		const importantName = CSSValues.getDeclaredName(
			rule,
			names,
			true,
			mapsHere,
		);
		if (
			importantName !== null &&
			(importantRuleValue === "" ||
				(Boolean(rule.uaOrigin) === importantOrigin &&
					rule.layerRank === importantLayer))
		) {
			importantRuleValue = rule.declarations[importantName];
			importantOrigin = Boolean(rule.uaOrigin);
			importantLayer = rule.layerRank;
		}
	}

	const declared =
		inlineImportantValue || importantRuleValue || inlineValue || ruleValue;
	// A CSS-wide keyword on the winning declaration decides the value there:
	// `inherit` takes the parent's whether or not the property inherits,
	// `initial` takes the property's initial value, and the rest send
	// resolution on to the defaults below, as though nothing were declared.
	if (declared === "inherit") {
		return resolveFromParent(declaration, property) ?? "";
	}
	if (declared === "initial") {
		return getInitialValueFor(declaration[kElement], property);
	}
	if (declared !== "" && !CSSValues.isCSSWideKeyword(declared)) {
		return declared;
	}

	// 3. The UA's own per-element defaults, such as strong's bold, which
	// take precedence over anything inherited.
	const element = declaration[kElement];
	const isList =
		element.namespaceURI === HTML_NAMESPACE &&
		(element.localName === "ul" || element.localName === "ol");

	// A list's marker gutter is sized to its widest marker rather than
	// taken from the static table, so it has to be resolved first.
	if (property === "padding-left" && isList) {
		return `${getListGutterWidth(declaration[kElement])}ch`;
	}

	// The UA default marker type depends on nesting depth, exactly as a
	// browser's `ul ul { list-style-type: circle }` rules do. Resolving it
	// here rather than inheriting means an author value on an outer list
	// does not leak into a nested one, while an author rule that matches
	// the nested list still wins because step 2 already returned it.
	if (property === "list-style-type" && isList) {
		if (element.localName === "ol") {
			return "decimal";
		}
		const bullets = ["disc", "circle", "square"];
		const depth = getListNestingDepth(declaration[kElement]);
		return bullets[Math.min(depth, bullets.length - 1)];
	}

	const elementDefaults = getElementDefaults(declaration[kElement]);
	if (elementDefaults && elementDefaults[property]) {
		return elementDefaults[property];
	}

	// 4. What the element inherits: the nearest ancestor with a value for
	// an inherited property, resolved through the same steps so the
	// ancestor's own rules apply. A custom property always inherits; there
	// is no fixed list of names.
	if (CSSValues.isInheritedProperty(property)) {
		const window = declaration[kElement].ownerDocument?.defaultView;
		if (window) {
			// Flat-tree parents. Inheritance crosses the shadow boundary (host
			// to shadow child) and reaches slotted content through its slot's
			// chain, exactly as in a browser.
			for (
				let parent = flatParentElement(declaration[kElement]);
				parent !== null;
				parent = flatParentElement(parent)
			) {
				const parentValue = getComputedValue(parent, property);
				if (parentValue) {
					return parentValue;
				}
			}
		}
	}

	// 5. The property's initial value.
	return getInitialValueFor(declaration[kElement], property);
}

// This element's own custom properties and every ancestor's, since a
// custom property inherits.
function getCustomNames(computed: ComputedStyleDeclaration): string[] {
	const current = computed[kCascade]?.[kCurrentDeclarations];
	if (current !== undefined && !current.has(computed)) {
		computed[kSyncResolved]();
	}
	if (computed[kCustom]) {
		return computed[kCustom];
	}
	const names = new Set<string>();
	for (
		let element: Element | null = computed[kElement];
		element;
		element = flatParentElement(element)
	) {
		const declaration = computed[kCascade]?.declarationFor(element);
		for (const name of declaration?.[kCustomProperties]() ?? []) {
			names.add(name);
		}
	}
	computed[kCustom] = [...names];
	return computed[kCustom];
}

const kPseudoDeclarations = Symbol("pseudo declarations");
const kPseudoElement = Symbol("pseudoElement");
const kNodeResolved = Symbol("nodeResolved");
const kBoxView = Symbol("boxView");

// A flat declaration set: the matched rules plus what the
// pseudo-element inherits from its originating element. LIVE, for the
// same reason an element's declaration is.
interface PseudoStyleDeclaration {
	[kPseudoDeclarations]: Record<string, string>;
	[kResolved]: Map<string, string>;

	// Absent on the engine's own reads (the ::selection and ::marker
	// painters), which want the cascade's declarations and never a used
	// value. Their declarations are passed in whole and are not the
	// cascade's to recompute.
	[kElement]: Element | null;
	[kPseudoElement]: string;
	[kCascade]: Cascade | null;

	[kNodeResolved]: Map<string, string>;
	[kBoxView]: MeasuredDeclaration | null;
}

class PseudoStyleDeclaration extends CSSStyleProperties {
	constructor(
		declarations: Record<string, string>,
		element?: Element,
		cascade?: Cascade,
		pseudoElement = "",
	) {
		super();
		this[kResolved] = new Map<string, string>();
		this[kNodeResolved] = new Map<string, string>();
		this[kBoxView] = null;
		this[kPseudoDeclarations] = declarations;
		this[kElement] = element ?? null;
		this[kPseudoElement] = pseudoElement;
		this[kCascade] = cascade ?? null;
		if (cascade) {
			cascade[kCurrentDeclarations].add(this);
		}
	}

	override get length(): number {
		return CSS_LONGHANDS.length;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	// The style of the NODE a pseudo-element generates: the declarations
	// completed with initial values, so a box is never laid out without a
	// `display`.
	nodeValue(property: string): string {
		const current = this[kCascade]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kSyncResolved]();
		}
		let value = this[kNodeResolved].get(property);
		if (value === undefined) {
			value =
				this[kBaseValue](property) ||
				CSSValues.getComputedValueEntry(
					property,
					getInitialStyle(null, property),
				);
			this[kNodeResolved].set(property, value);
		}
		const transitional = getPseudoTransitionValue(this, property);
		return transitional ?? value;
	}

	override getPropertyValue(property: string): string {
		if (this[kCascade]) {
			flushCascadeStyle(this[kCascade]);
		}
		const computed =
			this[kComputedValue](property) ||
			CSSValues.getComputedValueEntry(
				property,
				getInitialStyle(null, property),
			);
		if (this[kCascade] && USED_VALUE_PROPERTIES.has(property)) {
			return this[kUsedValue](property, computed);
		}
		return computed;
	}

	override setProperty(): void {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override removeProperty(): string {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override getPropertyPriority(): string {
		return "";
	}

	override item(index: number): string {
		return CSS_LONGHANDS[index] ?? "";
	}

	[kSyncResolved](): void {
		// Before the work, because resolving below reads back through this
		// declaration.
		this[kCascade]?.[kCurrentDeclarations].add(this);
		if (this[kCascade] && this[kElement] && this[kPseudoElement]) {
			this[kPseudoDeclarations] = pseudoDeclarationsFor(
				this[kCascade],
				this[kElement],
				this[kPseudoElement],
			);
			storeTransitionFallback(
				this[kCascade],
				this[kElement],
				this[kPseudoElement],
				this[kResolved],
			);
		}
		this[kResolved] = new Map();
		this[kNodeResolved].clear();
		if ((this as IndexedCollection)[kIndexCount] !== undefined) {
			syncIndexed(this);
		}
		if (this[kCascade] && this[kElement] && this[kPseudoElement]) {
			processTransitionStyle(
				this[kCascade],
				this[kElement],
				(property) => this[kBaseValue](property),
				this[kPseudoElement],
			);
		}
	}

	// The cascade's declarations alone, with no transition overriding them.
	[kBaseValue](property: string): string {
		let value = this[kResolved].get(property);
		if (value === undefined) {
			const longhands = CSSValues.getLonghands(property);
			value = longhands && this[kPseudoDeclarations][property] === undefined
				? CSSValues.serializeShorthandValue(property, longhands, (longhand) =>
					this[kBaseValue](longhand) || CSS_INITIAL_VALUES[longhand] || "")
				: CSSValues.getComputedValueEntry(
					property,
					this[kPseudoDeclarations][property] ?? "",
				);
			this[kResolved].set(property, value);
		}
		return value;
	}

	// Measured from the node the composition pass gave the pseudo-element,
	// through the same arithmetic as an element's metrics. A pseudo-element
	// never given a node uses the percentage resolution below, against the
	// box it would be in.
	[kUsedValue](property: string, computed: string): string {
		const originating = this[kElement];
		const cascade = this[kCascade];
		if (originating && cascade) {
			// Flush before the node lookup. The composition pass that runs
			// under the flush is what creates a pseudo-element's node, so a
			// lookup taken first would report "no box" for a box one render
			// away.
			getUsedRect(cascade, originating);
			const node = pseudoElement<Element>(originating, this[kPseudoElement]);
			if (node) {
				return measureUsedValue(getBoxView(this, node), property, computed);
			}
		}
		if (!computed.endsWith("%")) {
			return computed;
		}
		const display = this.getPropertyValue("display");
		if (display === "none" || display === "contents") {
			return computed;
		}
		// An originating element with `display: contents` generates no box of
		// its own, so its pseudo-elements go in the box its parent makes, the
		// same box its children go in.
		let host: Element | null = this[kElement];
		while (host && getComputedValue(host, "display") === "contents") {
			host = flatParentElement(host);
		}
		const box = host && contentBox(this[kCascade]!, host);
		if (!box) {
			return computed;
		}
		// Every percentage except the block-axis sizes resolves against the
		// containing block's width, including in the block direction.
		const vertical =
			property === "height" || property === "top" || property === "bottom";
		const basis = vertical ? box.height : box.width;
		return CSSValues.getUsedLength((parseFloat(computed) / 100) * basis);
	}

	// The engine's read. An empty result means no rule reached the
	// pseudo-element, which is what the ::selection and ::marker painters
	// check.
	[kComputedValue](property: string): string {
		const current = this[kCascade]?.[kCurrentDeclarations];
		if (current !== undefined && !current.has(this)) {
			this[kSyncResolved]();
		}
		const value = this[kBaseValue](property);
		const transitional = getPseudoTransitionValue(this, property);
		return transitional ?? value;
	}
}

defineLonghandIndices(ComputedStyleDeclaration.prototype);
defineLonghandIndices(PseudoStyleDeclaration.prototype);

function getPseudoTransitionValue(
	declaration: PseudoStyleDeclaration,
	property: string,
): string | null {
	const cascade = declaration[kCascade];
	if (
		cascade === null ||
		declaration[kElement] === null ||
		cascade[kActiveTransitions].size === 0
	) {
		return null;
	}
	return getTransitionValue(
		cascade,
		declaration[kElement],
		declaration[kPseudoElement],
		property,
	);
}

// The same cascade with the pseudo-element's own node in place of the
// element. One view per node: composition may drop a node and make
// another, and a view naming the old one would measure a rect no layout
// has.
function getBoxView(
	declaration: PseudoStyleDeclaration,
	node: Element,
): MeasuredDeclaration {
	let view = declaration[kBoxView];
	if (!view || view[kElement] !== node) {
		view = {
			[kElement]: node,
			[kCascade]: declaration[kCascade],
			[kComputedValue]: (property: string): string =>
				declaration.nodeValue(property),
			getPropertyValue: (property: string): string =>
				declaration.getPropertyValue(property),
		};
		declaration[kBoxView] = view;
	}
	return view;
}

// A transitioning value reaches the element's descendants through
// inheritance, so the subtree under each transitioning element is what
// the style cache cannot hold.
function isTransitioning(cascade: Cascade, element: Element): boolean {
	const active = cascade[kActiveTransitions];
	if (active.size === 0) {
		return false;
	}
	for (let node: Element | null = element;
		node;
		node = flatParentElement(node)) {
		if (active.has(node)) {
			return true;
		}
	}
	return false;
}

// A declaration of nothing, which CSSOM specifies for a bad pseudo
// argument.
interface EmptyStyleDeclaration {
	[kElement]: Element | null;
}

class EmptyStyleDeclaration extends CSSStyleProperties {
	constructor(element?: Element) {
		super();
		this[kElement] = element ?? null;
	}

	override get length(): number {
		return 0;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override getPropertyValue(): string {
		return "";
	}

	override getPropertyPriority(): string {
		return "";
	}

	override setProperty(): void {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override removeProperty(): string {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}

	override item(): string {
		return "";
	}
}

for (const property of CSS_PROPERTIES) {
	const camelCase = CSSValues.camelCaseProperty(property);
	for (const name of new Set([property, camelCase])) {
		for (const prototype of [
			ComputedStyleDeclaration.prototype,
			PseudoStyleDeclaration.prototype,
		] as object[]) {
			if (name in prototype) {
				continue;
			}
			Object.defineProperty(prototype, name, {
				get(this: ComputedStyleDeclaration | PseudoStyleDeclaration) {
					return this.getPropertyValue(property);
				},
				configurable: true,
			});
		}
	}
}

interface BorderSides {
	top?: LineStyle["style"];
	right?: LineStyle["style"];
	bottom?: LineStyle["style"];
	left?: LineStyle["style"];
	topLeft?: "round";
	topRight?: "round";
	bottomRight?: "round";
	bottomLeft?: "round";
}

const LINE_KEYWORDS = new Set<string>(LINE_STYLES);

export function resolveBorderSides(element: Element): BorderSides {
	const getSide = (
		width: string,
		style: string,
	): LineStyle["style"] | undefined => {
		const parsed = CSSValues.parseBorderWidthValue(width);
		const widthValue = typeof parsed === "number" ? parsed : NaN;
		if (isNaN(widthValue) || widthValue <= 0 || !style || style === "none") {
			return undefined;
		}
		// An unknown style keyword draws as solid rather than not at all.
		return LINE_KEYWORDS.has(style) ? (style as LineStyle["style"]) : "solid";
	};

	// Rounded when the radius is nonzero on BOTH axes, as a browser squares
	// off a collapsed ellipse. A cell grid has one size of curve.
	const roundedCorner = (corner: string): "round" | undefined => {
		const radii = getComputedValue(element, `border-${corner}-radius`)
			.split(/\s+/)
			.filter(Boolean);
		if (radii.length === 0) {
			return undefined;
		}
		return radii.every((radius) => parseFloat(radius) > 0)
			? "round"
			: undefined;
	};

	const of = (side: string): LineStyle["style"] | undefined =>
		getSide(
			getComputedValue(element, `border-${side}-width`) ||
			getComputedValue(element, "border-width"),
			getComputedValue(element, `border-${side}-style`) ||
			getComputedValue(element, "border-style"),
		);

	return {
		top: of("top"),
		right: of("right"),
		bottom: of("bottom"),
		left: of("left"),
		topLeft: roundedCorner("top-left"),
		topRight: roundedCorner("top-right"),
		bottomRight: roundedCorner("bottom-right"),
		bottomLeft: roundedCorner("bottom-left"),
	};
}

// `<ol start>` sets where counting begins, `<ol reversed>` counts down,
// and a `<li value>` resets the counter mid-list and carries forward.
function getListItemOrdinal(listItem: Element, listParent: Element): number {
	const items = getListItems(listParent);

	const reversed = listParent.hasAttribute("reversed");
	const start = parseInt(listParent.getAttribute("start") ?? "", 10);

	let counter = Number.isFinite(start) ? start : reversed ? items.length : 1;

	for (const item of items) {
		const value = parseInt(item.getAttribute("value") ?? "", 10);
		if (Number.isFinite(value)) {
			counter = value;
		}
		if (item === listItem) {
			return counter;
		}
		counter += reversed ? -1 : 1;
	}

	return counter;
}

// Keyed by the COMPUTED list-style-type, not the parent's tag name. A
// ul can be decimal, an ol disc, either none.
function getListMarker(listItem: Element, listParent: Element): string {
	const listStyleType = getComputedValue(listItem, "list-style-type");

	if (!listStyleType || listStyleType === "none") {
		return "";
	}

	const bullet = CSSValues.getBulletMarker(listStyleType);
	if (bullet) {
		return bullet;
	}

	if (CSSValues.isCounterStyle(listStyleType)) {
		if (!getListItems(listParent).includes(listItem)) {
			return "";
		}
		return `${CSSValues.formatOrdinal(getListItemOrdinal(listItem, listParent), listStyleType)}.`;
	}

	return "";
}

// Filled on first use, not at evaluation. cssvalues imports this module
// back around through cssselectors and dom, so whichever end is imported
// first runs before the other's tables exist.
let inheritedProperties: readonly string[] | null = null;

// TODO: Just use the CSSOM CSSRule interface from the DOM
interface ParsedCSSRule {

	// Compiled against the namespaces the sheet declared, once, at parse. A
	// rule is matched through this and never through its text. Null for a
	// selector this engine cannot read, which styles nothing.
	matcher: CompiledSelector | null;

	// The same selector read relative to a scoping root, which is what
	// `@scope { > .a { } }` writes. Only a rule inside an @scope has one.
	relativeMatcher: CompiledSelector | null;

	// Every rule is tried against every element, so this check keeps a
	// document of divs from running the selector engine over a sheet's
	// worth of rules about summaries and legends. Absent when any element
	// could match.
	subjectTag?: string;
	// The id or a class the rightmost compound requires, as "#id" or
	// ".class", which files the rule where only elements with it look.
	// Absent when the compound requires neither.
	subjectKey?: string;
	declarations: Record<string, string>;
	important: Record<string, boolean>;

	// Each declaration's position in the rule's block. See CSSValues.DeclarationBlock.
	order: Record<string, number>;

	// Zero-padded for lexicographic comparison.
	specificity: string;
	pseudoElement?: string;

	// The pseudo-classes written after `::part()`, which the part element
	// itself must match: `::part(inner):dir(rtl)`.
	partMatcher?: CompiledSelector | null;

	// The tree scope whose stylesheet declared this rule. Undefined for
	// document rules. A rule only ever matches elements of its own tree,
	// which is the cascade's encapsulation boundary in both directions.
	scope?: Node;

	// `:host` is the one thing that reaches outside the tree its
	// stylesheet belongs to.
	reachesHost?: boolean;

	// A pseudo-element of a part, as `input::part(label)::before` is. It
	// originates on the part element, inside the host's shadow tree.
	ofPart?: boolean;

	// For a rule with a :has(), what its anchors must have, as kHasAnchors
	// keeps them, and the pseudo-classes inside it.
	hasAnchors?: readonly string[];
	hasStates?: readonly string[];

	// Cascade ORIGIN, the tier above specificity. Every author rule beats
	// every UA rule, which lets `input::placeholder { color }` beat the UA
	// sheet's gray despite that selector's higher specificity.
	uaOrigin?: boolean;

	// Dot-joined through every enclosing @layer. Null for a rule in no
	// layer.
	layer: string | null;

	// Layers in declaration order, then every unlayered rule last, which
	// wins the normal cascade. Filled in once the whole order is known.
	layerRank: number;

	// The @scope conditions the rule was declared inside, outermost first.
	// Absent for a rule no @scope encloses, which is in scope everywhere.
	scopes?: readonly CSSValues.ScopeCondition[];
}

function isScopeRootMatch(
	element: Element,
	condition: CSSValues.ScopeCondition,
	outer: Element | null,
): boolean {
	if (condition.roots === null) {
		return element === condition.owner;
	}
	// Relative to the enclosing scope's root, which is what `:scope` refers
	// to.
	return outer
		? condition.rootsInOuter.some((root) => isSelectedBy(element, root, outer))
		: condition.roots.some((root) => isSelectedBy(element, root, element));
}

// Inside the root with no scoping limit between the two. The root is
// always in its own scope.
function isInScope(
	element: Element,
	root: Element,
	condition: CSSValues.ScopeCondition,
): boolean {
	let node: Element | null = element;
	for (; node && node !== root; node = node.parentElement) {
		if (condition.limits.some((limit) => isSelectedBy(node!, limit, root))) {
			return false;
		}
	}
	return node === root;
}

// The cascade types its nodes as the platform's interfaces and the
// matcher as this DOM's own classes. They are the same objects under two
// names, cast here.
function isSelectedBy(
	element: Element,
	selector: CompiledSelector,
	scope: Node,
	shadow: Node | null = null,
): boolean {
	const cascade = documentCascades.get(element.ownerDocument as object);
	return matchesCompiled(element as unknown as DOMElement, selector, {
		scope: scope as unknown as DOMNode,
		shadow: shadow as DOMNode | null,
		hasResults: cascade === undefined
			? null
			: (cascade[kHasResults] ??= new WeakMap()),
	});
}

function shouldCreatePseudoElement(
	cascade: Cascade,
	element: Element,
	pseudoType: string,
): boolean {
	if (pseudoType === "::marker") {
		const computedStyle = cascade.declarationFor(element);
		const display = computedStyle[kComputedValue]("display");
		const listStylePosition =
			computedStyle[kComputedValue]("list-style-position") || "outside";

		if (display === "list-item" && listStylePosition !== "outside") {
			return true;
		}
	}

	const styles = computePseudoElementStyle(cascade, element, pseudoType);
	const content = styles.content;
	return !!(content && content !== "none" && content !== "normal");
}

// The pseudo-elements this engine gives a node of their own.
const PSEUDO_ELEMENT_NAMES = ["::before", "::after", "::marker"];

// The entry point for mutations.
function attachPseudoElementsToElement(
	cascade: Cascade,
	element: Element,
): void {
	// If no pseudo rule names this element's type and it has no
	// pseudo-element to reconsider, everything below would return no, at
	// the cost of one matches() call per rule. Counters are built when a
	// content value first reads them.
	const tags = getPseudoSubjects(cascade);
	if (
		tags !== null &&
		!tags.has(element.tagName) &&
		!element.hasAttribute("part") &&
		pseudoElementCount(element) === 0 &&
		!(element.getAttribute("style") ?? "").includes("list-item")
	) {
		return;
	}

	for (const pseudoType of PSEUDO_ELEMENT_NAMES) {
		attachPseudoElementToElementForType(cascade, element, pseudoType);
	}
}

const kWindow = Symbol("window");
const kDocument = Symbol("document");
const FOCUS_STATES = ["focus", "focus-within", "focus-visible"];
const kParsedStyleSheetCount = Symbol("parsedStyleSheetCount");
const kFlushing = Symbol("flushing");
const kUsedValues = Symbol("usedValues");
const kUsedStale = Symbol("used values stale");
const kShadowRoots = Symbol("shadowRoots");
const kSiblingIndexes = Symbol("siblingIndexes");
const kComputedStyleCache = Symbol("computedStyleCache");
const kPseudoElementStyleCache = Symbol("pseudoElementStyleCache");
const kParsedRules = Symbol("parsedRules");
const kReachingClasses = Symbol("reachingClasses");
const kKeyProperties = Symbol("keyProperties");
const kReachingIds = Symbol("reachingIds");
const kReachingAttributes = Symbol("reachingAttributes");
const kReachingStates = Symbol("reachingStates");
const kDescendantPseudoClasses = Symbol("descendantPseudoClasses");
const kClassSubjects = Symbol("classSubjects");
const kSiblingPseudoClasses = Symbol("siblingPseudoClasses");
const kPseudoRulesByType = Symbol("pseudoRulesByType");
const kPseudoSubjectTags = Symbol("pseudoSubjectTags");
const kCounterRulesExist = Symbol("counterRulesExist");
const kListItemRulesExist = Symbol("listItemRulesExist");
const kScopedRulesExist = Symbol("scopedRulesExist");
const kHasRulesExist = Symbol("hasRulesExist");
const kHasAnchors = Symbol("hasAnchors");
const kHoverRulesExist = Symbol("hoverRulesExist");
const kLayerPaths = Symbol("layerPaths");
const kAnonymousLayers = Symbol("anonymousLayers");
const kUnlayeredRank = Symbol("unlayeredRank");
const kCounterScopes = Symbol("counterScopes");
const kTransitionSnapshots = Symbol("transitionSnapshots");
const kTransitionFallback = Symbol("transitionFallback");
const kTransitionClock = Symbol("transitionClock");
const kTransitionTimer = Symbol("transitionTimer");
const kTransitionEvents = Symbol("transitionEvents");
const kTransitionFlushQueued = Symbol("transitionFlushQueued");

function isStyleElement(element: Element): boolean {
	return (
		element.tagName === "STYLE" ||
		(element.tagName === "LINK" && element.getAttribute("rel") === "stylesheet")
	);
}

// The list's padding-left is a function of its items' markers and
// their ordinals. Only the NEAREST list is affected.
// TODO(box-tree): the gutter is a layout question answered here in the
// cascade. Computing it during block layout deletes this.
function mutationChangesListItems(mutation: MutationRecord): boolean {
	const target = mutation.target;
	if (
		target.nodeType === 1 &&
		((target as Element).tagName === "UL" ||
			(target as Element).tagName === "OL")
	) {
		return true;
	}
	for (const list of [mutation.addedNodes, mutation.removedNodes]) {
		for (const node of list) {
			if (node.nodeType !== 1) {
				continue;
			}
			const element = node as Element;
			if (element.tagName === "LI" || element.querySelector("li") !== null) {
				return true;
			}
		}
	}
	return false;
}

export interface Cascade {
	[kComputedStyleCache]: WeakMap<Element, ComputedStyleDeclaration>;

	// Every declaration resolved against the current cascade. Dropping one, or
	// replacing the set, sends it back through kSyncResolved on its next read.
	// Weak, so a declaration nobody holds costs nothing.
	[kCurrentDeclarations]: WeakSet<object>;

	// Nothing else tracks a shadow tree's sheets, so a parse walks these.
	[kShadowRoots]: Set<ShadowRoot>;
	[kSharedRoot]: Map<string, Map<string, string>>;
	[kPseudoElementStyleCache]: WeakMap<
		Element,
		Map<string, PseudoStyleDeclaration>
	>;

	[kParsedRules]: ParsedCSSRule[];
	[kStylesheetsDirty]: boolean;
	[kParsing]: boolean;
	// Every element holding a pseudo-element node, so a sheet change
	// reconsiders them without walking the document.
	[kPseudoHosts]: Set<Element>;

	// What each tree's sibling selectors can reach, by the tree whose
	// sheets declared them: the document, or a shadow root. A rule matches
	// only in its own tree (css-scoping-1 §3.3), so `* + *` in a shadow
	// root restyles nothing in the document.
	[kSiblingIndexes]: Map<Node, SiblingIndex>;

	// The keys whose change can affect an element's DESCENDANTS: those a
	// selector tests left of a combinator (`.editing .view`), and those on
	// rules declaring an inherited property. Collected loosely. A false
	// positive only widens the invalidation.
	[kReachingClasses]: Set<string>;
	// Every property a rule declares, by each class, id and attribute its
	// selector tests, as `.name`, `#name` and `[name]`. A change to a key
	// whose properties are all paint decides nothing layout reads.
	[kKeyProperties]: Map<string, Set<string>>;
	[kReachingIds]: Set<string>;
	[kReachingAttributes]: Set<string>;

	// Whether any of those keys is a STATE pseudo-class (`:checked ~`),
	// which is driven by attributes not in the sets above. While this is
	// set, a change to any state attribute invalidates widely.
	[kReachingStates]: boolean;
	// The pseudo-classes whose change on one element can restyle its
	// descendants: tested on a compound that is not the subject, or on a
	// rule that sets an inherited property. And those tested before a
	// sibling combinator, which can restyle its later siblings.
	[kDescendantPseudoClasses]: Map<string, StateAnchor[]>;
	// For each class a rule tests above its subject, the subjects that
	// rule can style, or null when it can style any descendant: its subject
	// could be anyone, or it sets something they inherit.
	[kClassSubjects]: Map<string, StateAnchor[] | null>;
	[kSiblingPseudoClasses]: Map<string, StateAnchor[]>;

	// Rule-existence gates. Attaching pseudo-elements and initializing
	// counters both build full computed-style declarations per element per
	// mutation. A document with no such rules must not pay that, and these
	// let the hot paths decide "could any rule apply" with a few matches()
	// calls.
	[kPseudoRulesByType]: Map<string, ParsedCSSRule[]>;
	[kCounterRulesExist]: boolean;
	[kListItemRulesExist]: boolean;

	// Whether any rule is scoped, which is what adds proximity to the sort.
	[kScopedRulesExist]: boolean;
	[kHasRulesExist]: boolean;

	// What an element must have for a :has() to be tested on it: an id as
	// "#id", a class as ".class", a local name, or "*" for anything. A
	// change inside an element that has none of them leaves every :has()
	// as it was.
	[kHasAnchors]: Set<string>;

	// The engine reads this to decide whether the terminal must report
	// pointer motion. A sheet that never tests :hover cannot show it, and
	// motion reporting has a per-cell cost.
	[kHoverRulesExist]: boolean;

	// -1 means never parsed. A changed count re-parses on the next style
	// computation, which lets a sheet appended right before the first paint
	// apply with no MutationObserver attached.
	[kParsedStyleSheetCount]: number;

	[kCounterScopes]: WeakMap<Element, CSSValues.CounterScope>;

	// The transition gate is STICKY. It opens the first time anything
	// declares a transition and never closes, so a document with none pays
	// two checks per style change event. Snapshots live in a WeakMap. Only
	// elements with RUNNING transitions are in the strong map the tick
	// iterates.
	[kTransitionsExist]: boolean;
	[kTransitionSnapshots]: WeakMap<Element, Map<string, Map<string, string>>>;

	// A dropped declaration's resolved values, kept as the before-change
	// style for a transition declared and retargeted in one style change,
	// the case the snapshot cannot cover. These are the original maps, not
	// copies. The declaration replacing its memo is what makes the old map
	// safe to hold.
	[kTransitionFallback]: WeakMap<Element, Map<string, Map<string, string>>>;

	[kActiveTransitions]: Map<
		Element,
		Map<string, Map<string, CSSValues.RunningTransition>>
	>;

	// The timeline instant a frame's reads interpolate against.
	[kTransitionClock]: number;
	[kTransitionTimer]: ReturnType<typeof setTimeout> | null;
	[kTransitionEvents]: QueuedTransitionEvent[];
	[kTransitionFlushQueued]: boolean;

	// Fixed for the window's lifetime, so held directly.
	[kDocument]: Document;
	[kWindow]: Window;
	[kLayout]: Layout;

	[kFlushing]: boolean;

	// The used values measured behind the last flush, held here rather
	// than on the declarations so a cascade rebuild drops them all at once.
	[kUsedValues]: WeakMap<object, Map<string, string>>;

	// `:has()` answers, which go stale exactly when computed styles do, so
	// they are dropped wherever a computed style is.
	[kHasResults]: HasResults | null;

	// The pseudo-classes named anywhere inside a :has() argument. A change
	// to one of those states can restyle an anchor's whole subtree, far
	// from the element whose state changed.
	[kHasStates]: Set<string>;

	// Set by the layout engine when geometry changed under the used values.
	[kUsedStale]: boolean;

	// Every cascade layer, in the order its name was first declared. A
	// nested layer's path is dot-joined, the name `@layer a.b` writes for
	// itself.
	[kLayerPaths]: string[];
	[kAnonymousLayers]: number;

	// Where an unlayered rule sorts: after every layer, and so above them.
	[kUnlayeredRank]: number;

	// The element types a pseudo rule originates on, uppercased. Null when
	// a rule reaches any type, as a counter rule does through the scope
	// chain.
	[kPseudoSubjectTags]: Set<string> | null | undefined;
}

export class Cascade {
	constructor(window: Window, layout: Layout) {
		this[kComputedStyleCache] =
			new WeakMap<Element, ComputedStyleDeclaration>();
		this[kCurrentDeclarations] = new WeakSet<object>();
		this[kShadowRoots] = new Set<ShadowRoot>();
		this[kSharedRoot] = new Map();
		this[kPseudoElementStyleCache] = new WeakMap<
			Element,
			Map<string, PseudoStyleDeclaration>
		>();
		this[kParsedRules] = [];
		this[kStylesheetsDirty] = false;
		this[kParsing] = false;
		this[kPseudoHosts] = new Set();
		this[kSiblingIndexes] = new Map();
		this[kReachingClasses] = new Set<string>();
		this[kKeyProperties] = new Map<string, Set<string>>();
		this[kReachingIds] = new Set<string>();
		this[kReachingAttributes] = new Set<string>();
		this[kReachingStates] = false;
		this[kDescendantPseudoClasses] = new Map();
		this[kClassSubjects] = new Map();
		this[kSiblingPseudoClasses] = new Map();
		this[kPseudoRulesByType] = new Map<string, ParsedCSSRule[]>();
		this[kCounterRulesExist] = false;
		this[kListItemRulesExist] = false;
		this[kScopedRulesExist] = false;
		this[kHasRulesExist] = false;
		this[kHasAnchors] = new Set();
		this[kHasStates] = new Set();
		this[kHoverRulesExist] = false;
		this[kParsedStyleSheetCount] = -1;
		this[kCounterScopes] = new WeakMap<Element, CSSValues.CounterScope>();
		this[kFlushing] = false;
		this[kUsedValues] = new WeakMap();
		this[kHasResults] = null;
		this[kUsedStale] = true;
		this[kLayerPaths] = [];
		this[kAnonymousLayers] = 0;
		this[kUnlayeredRank] = 0;
		this[kTransitionsExist] = false;
		this[kTransitionSnapshots] = new WeakMap();
		this[kTransitionFallback] = new WeakMap();
		this[kActiveTransitions] = new Map();
		this[kTransitionClock] = 0;
		this[kTransitionTimer] = null;
		this[kTransitionEvents] = [];
		this[kTransitionFlushQueued] = false;
		this[kWindow] = window;
		this[kLayout] = layout;
		this[kDocument] = window.document;

		documentCascades.set(this[kDocument], this);
		window.getComputedStyle = (
			element: Element,
			pseudoElt?: string | null,
		): globalThis.CSSStyleDeclaration =>
			getPageView(
				getResolvedStyle(this, element, pseudoElt) as unknown as
					CSSStyleDeclaration,
			) as unknown as globalThis.CSSStyleDeclaration;

		setupInvalidationHooks(this);

		parseStylesheets(this);
	}

	registerShadowRoot(root: ShadowRoot): void {
		if (this[kShadowRoots].has(root)) {
			return;
		}
		this[kShadowRoots].add(root);
		// Incrementally. Rebuilding every sheet per UA shadow tree upgrade made
		// a document of n UA shadow trees reparse everything n times.
		syncShadowRoot(this, root);
	}

	// A root filled with its content after it registered, as a declarative
	// shadow root is, has sheets its registration did not see.
	syncShadowRoot(root: ShadowRoot): void {
		if (this[kShadowRoots].has(root)) {
			syncShadowRoot(this, root);
		} else {
			this.registerShadowRoot(root);
		}
	}

	handleMutations(mutations: MutationRecord[]): void {
		const Node = this[kWindow].Node;
		let shouldSyncStylesheets = false;
		let removedElements = false;
		const changedParents = new Set<Element>();

		// A :has() anchor sits above what changed it, or before it among its
		// siblings for :has(+ x) and :has(~ x), and the rule can style the
		// anchor's descendants too. So each such element a :has() could be
		// tested on restyles, with everything under it.
		if (this[kHasRulesExist]) {
			const anchors = new Set<Element>();
			for (const mutation of mutations) {
				const start = mutation.target.nodeType === 1
					? (mutation.target as Element)
					: mutation.target.parentElement;
				for (
					let ancestor: Element | null = start;
					ancestor;
					ancestor = flatParentElement(ancestor)
				) {
					for (
						let element: Element | null = ancestor;
						element !== null;
						element = element.previousElementSibling
					) {
						if (!anchors.has(element) && couldAnchorHas(this, element)) {
							anchors.add(element);
							invalidateSubtree(this, element);
						}
					}
				}
			}
		}

		// A root's sheets sync once a batch, after its records: each sync
		// restyles the whole tree, and a page that fills its sheets a rule at
		// a time sent a record per rule.
		const rootsToSync = new Set<ShadowRoot>();
		for (const mutation of mutations) {
			if (mutation.type === "childList") {
				// A <style>'s children ARE its stylesheet text. A shadow
				// sheet's sync stays inside its root.
				if ((mutation.target as Element).tagName === "STYLE") {
					reparseOwnerText(getSheet(mutation.target as Element));
					const styleRoot = mutation.target.getRootNode();
					if (isShadowRoot(styleRoot)) {
						rootsToSync.add(styleRoot);
					} else {
						shouldSyncStylesheets = true;
					}
				}
				// A list's gutter is derived from its items' markers, so a
				// change to the ITEMS invalidates the list: a wider marker added
				// later overran the gutter the original items set. A change
				// inside an item's content moves no marker.
				if (mutationChangesListItems(mutation)) {
					invalidateEnclosingList(this, mutation.target);
				}

				for (const node of mutation.addedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (isStyleElement(element)) {
							const addedRoot = element.tagName === "STYLE"
								? element.getRootNode()
								: null;
							if (addedRoot !== null && isShadowRoot(addedRoot)) {
								rootsToSync.add(addedRoot);
							} else {
								shouldSyncStylesheets = true;
							}
						} else {
							invalidateElementCaches(this, element);
							attachPseudoElementsToElement(this, element);
							registerConnectedShadowRoots(this, element);

							const childElements = element.querySelectorAll("*");
							for (const childElement of childElements) {
								invalidateElementCaches(this, childElement);
								attachPseudoElementsToElement(this, childElement);
								registerConnectedShadowRoots(this, childElement);
							}
						}
					}
				}

				for (const node of mutation.removedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (isStyleElement(element)) {
							shouldSyncStylesheets = true;
						}
						removedElements = true;
					}
				}
				// A child that came or went changes what `li + li`,
				// `:first-child` and `:empty` match on the children around it
				// and on the parent, none of which the mutation names. Once
				// per parent per batch: appending n children one at a time
				// is n records against the same parent.
				if (
					mutation.target.nodeType === Node.ELEMENT_NODE &&
					getSiblingIndex(this, mutation.target as Element)?.reachesSiblings
				) {
					changedParents.add(mutation.target as Element);
				}
			} else if (mutation.type === "attributes") {
				const element = mutation.target as Element;
				// A value written over itself changes no style.
				if (
					mutation.oldValue !== null &&
					mutation.oldValue === element.getAttribute(mutation.attributeName!)
				) {
					continue;
				}
				// A change to keys whose rules declare only paint properties
				// leaves every box where it was. The styles are dropped so the
				// next read resolves them, and layout is not told.
				const notifyLayout = !isPaintOnlyChange(
					this,
					element,
					mutation.attributeName!,
					mutation.oldValue,
				);
				// Only a change the sheets USE that way reaches descendants.
				// When no rule tests the class outside its own subject and none
				// declares an inherited property, descendant styles are
				// unchanged.
				const subjects = mutation.attributeName === "class"
					? classChangeSubjects(this, element, mutation.oldValue)
					: null;
				if (subjects !== null) {
					invalidateElementCaches(this, element, notifyLayout);
					attachPseudoElementsToElement(this, element);
					if (subjects.length > 0) {
						for (const descendant of element.querySelectorAll("*")) {
							const parent = descendant.parentElement;
							if (
								subjects.some(
									(anchor) =>
										couldAnchor(descendant, anchor) ||
										// A display change blockifies the changed element's
										// own children, and those of anyone else it anchors.
										(anchor.children === true &&
											parent !== null &&
											(parent === element || couldAnchor(parent, anchor))),
								)
							) {
								invalidateElementCaches(this, descendant, notifyLayout);
								attachPseudoElementsToElement(this, descendant);
							}
						}
					}
				} else if (
					attributeReachesDescendants(
						this,
						element,
						mutation.attributeName!,
						mutation.oldValue,
					)
				) {
					invalidateSubtree(this, element, notifyLayout);
				} else {
					invalidateElementCaches(this, element, notifyLayout);
					attachPseudoElementsToElement(this, element);
				}
				if (!notifyLayout) {
					this[kLayout].invalidateFrame();
				}
				// `.on ~ .light` matches a FOLLOWING sibling whose cached
				// styles know nothing of this change.
				if (
					changeReachesLaterSiblings(
						getSiblingIndex(this, element),
						element,
						mutation.attributeName!,
						mutation.oldValue,
					)
				) {
					for (
						let sibling = element.nextElementSibling;
						sibling;
						sibling = sibling.nextElementSibling
					) {
						invalidateSibling(this, sibling);
					}
				}
			} else if (mutation.type === "characterData") {
				const owner = mutation.target.parentElement;
				if (owner?.tagName === "STYLE") {
					reparseOwnerText(getSheet(owner));
					const ownerRoot = owner.getRootNode();
					if (isShadowRoot(ownerRoot)) {
						rootsToSync.add(ownerRoot);
					} else {
						shouldSyncStylesheets = true;
					}
				}
			}
		}
		for (const root of rootsToSync) {
			syncShadowRoot(this, root);
		}

		for (const parent of changedParents) {
			invalidateChildren(this, parent);
		}
		// What left the document is let go: elements given a pseudo-element,
		// and shadow roots with their rules. A host connected again registers
		// its root on the way in.
		if (removedElements) {
			for (const host of this[kPseudoHosts]) {
				if (!host.isConnected) {
					this[kPseudoHosts].delete(host);
				}
			}
			for (const root of this[kShadowRoots]) {
				if (!root.host.isConnected) {
					this[kShadowRoots].delete(root);
					forgetShadowRoot(this, root);
				}
			}
			releaseRemovedNodes(this[kDocument]);
		}
		if (shouldSyncStylesheets) {
			this.syncStylesheets();
		}
	}

	// user-select, with `auto` resolved through the parent per css-ui-4.
	// `text`, `all` and `contain` all behave as plain isSelectable. Nothing
	// implements the shapes `all` and `contain` ask for yet.
	isSelectable(element: Node): boolean {
		let current = element as Element | null;
		while (current) {
			const value = getComputedValue(current, "user-select");
			if (value === "none") {
				return false;
			}
			if (value !== "auto" && value !== "") {
				return true;
			}
			current = flatParentElement(current);
		}
		return true;
	}

	// Focus is not a mutation, and nothing else invalidates. The cached
	// declarations of the two moved elements hold rule sets matched BEFORE
	// the move, so a :focus rule would never apply or stop applying.
	handleFocusChange(...elements: Array<Element | null>): void {
		if (FOCUS_STATES.some((state) => this[kHasStates].has(state))) {
			restyleAll(this);
			return;
		}
		for (const element of elements) {
			// The whole flat-tree chain can observe focus (:focus-within,
			// :host(:focus)), so every element on it goes stale together.
			for (
				let node: Element | null = element; node; node = flatParentElement(node)
			) {
				invalidateForState(this, node, FOCUS_STATES);
			}
		}
	}

	// State no attribute or tree records changed: a checkbox was checked, a
	// custom element defined, a popover shown. `states` names the
	// pseudo-classes that read it. A rule can test the state on the element
	// itself, on an ancestor of what it styles, or before a sibling
	// combinator, so the element's subtree and its later siblings restyle.
	// One that tests it inside :has() can style anything, so everything
	// restyles.
	handleStateChange(element: Element, states: readonly string[]): void {
		if (states.some((state) => this[kHasStates].has(state))) {
			restyleAll(this);
			return;
		}
		invalidateForState(this, element, states);
		// No mutation record describes the change, so the frame that decides
		// whether anything needs painting is notified here.
		this[kLayout].invalidateFrame();
	}

	// The same staleness a focus move leaves, scoped to the symmetric
	// difference of the two flat-tree chains. The shared ancestors above the
	// fork were hovered before and are hovered still.
	handleHoverChange(previous: Element | null, next: Element | null): void {
		chainStateChange(this, previous, next, "hover");
	}

	// The same for the element a mouse button is held down on, which with
	// its ancestors is :active.
	handleActiveChange(previous: Element | null, next: Element | null): void {
		chainStateChange(this, previous, next, "active");
	}

	// A dirty sheet list parses first, so a value read between frames still
	// describes the current document.
	hoverRulesExist(): boolean {
		parseStylesheetsIfStale(this);
		return this[kHoverRulesExist];
	}

	// The internal read path: no pseudo parsing, no being-rendered check, no
	// resolved-value branch. Called thousands of times per frame, so it does
	// the least it can.
	declarationFor(element: Element): ComputedStyleDeclaration {
		let declaration = this[kComputedStyleCache].get(element);
		if (!declaration) {
			parseStylesheetsIfStale(this);
			declaration = new ComputedStyleDeclaration(
				element,
				getCascadeRules(this, element),
				this,
			);
			this[kComputedStyleCache].set(element, declaration);
			// Building a fresh declaration is the other form of the style
			// change event kSyncResolved sees.
			const fresh = declaration;
			processTransitionStyle(
				this,
				element,
				(property) => fresh[kBaseValue](property),
				"",
			);
		}
		return declaration;
	}

	/**
	 * One object per resolved style, the same until the element's style
	 * changes. Null for a pseudo-element and while a transition runs.
	 */
	getStyleKey(element: Element): object | null {
		if (getPseudoHost(element) !== null || isTransitioning(this, element)) {
			return null;
		}
		const declaration = this.declarationFor(element);
		if (!this[kCurrentDeclarations].has(declaration)) {
			declaration[kSyncResolved]();
		}
		return declaration[kStyleVersion];
	}

	/**
	 * The properties a pseudo-element's own rules set on this element, empty
	 * when no rule reaches it. Unlike getComputedValue, this does not fill in
	 * the originating element's inherited values.
	 */
	declaredPseudoProperties(
		element: Element,
		pseudoElement: string,
	): Set<string> {
		parseStylesheetsIfStale(this);
		return new Set(
			Object.keys(computePseudoElementStyle(this, element, pseudoElement)),
		);
	}

	// Public because window.matchMedia uses the SAME evaluator @media
	// does, so a stylesheet and a script can never disagree. A query that
	// does not parse is `not all`, and the rest of its list still counts.
	mediaQueryMatches(mediaText: string): boolean {
		const text = mediaText.trim();
		if (!text) {
			return true;
		}
		const queries = CSSValues.parseMediaQueryList(text);
		if (queries) {
			return queries.some((query) => mediaQueryNodeMatches(this, query));
		}
		return CSSValues.splitMediaQueryList(text).some((piece) => {
			const parsed = CSSValues.parseMediaQueryList(piece);
			return parsed?.length === 1 && mediaQueryNodeMatches(this, parsed[0]);
		});
	}

	/** The text a list item's marker draws, or null when it draws none. */
	getMarkerContent(hostElement: Element): string | null {
		if (!hostElement || hostElement.nodeType !== hostElement.ELEMENT_NODE) {
			return null;
		}

		const computedStyle = this.declarationFor(hostElement);
		const display = computedStyle[kComputedValue]("display");

		if (display !== "list-item") {
			return null;
		}

		const styles = computePseudoElementStyle(this, hostElement, "::marker");
		let content = styles.content;

		if (!content || content === "none" || content === "normal") {
			content = getDefaultMarkerContent(hostElement) ?? content;
		}
		if (!content || content === "none" || content === "normal") {
			return null;
		}

		let textContent = CSSValues.unquoteContent(content);

		textContent = resolveCounterFunction(this, hostElement, textContent);

		return textContent;
	}

	syncStylesheets(): void {
		// A sheet materializing its rules under the parse in progress
		// notifies once per rule; that parse reads them.
		if (this[kParsing]) {
			return;
		}
		parseStylesheets(this);

		// Boxes may have been built under the pre-parse styles, such as a
		// subtree a .view{display:none} in the same batch hides. Rebuild from
		// the root. Stylesheet changes are rare.
		const body = this[kDocument].body;
		if (body) {
			this[kLayout].invalidate(body);
		}
	}

	// The document is being torn down.
	dispose(): void {
		this[kComputedStyleCache] = new WeakMap();
		this[kHasResults] = null;
		this[kPseudoElementStyleCache] = new WeakMap();
		this[kCounterScopes] = new WeakMap();
		if (this[kTransitionTimer] !== null) {
			clearTimeout(this[kTransitionTimer]);
			this[kTransitionTimer] = null;
		}
		this[kActiveTransitions].clear();
		this[kTransitionEvents] = [];
	}
}

// Null for a box that generated no grid. The resolved value then stays
// the computed track list, as CSSOM says.
function usedGridTracks(
	cascade: Cascade,
	element: Element,
	rows: boolean,
): number[] | null {
	if (!getUsedRect(cascade, element)) {
		return null;
	}
	return cascade[kLayout].gridTracks(element, rows)
		?.map((size) => pxFromCells(size, rows, element),
		) ?? null;
}

// Re-parse ONE shadow root's sheets in place. Only trees the root's
// rules can reach restyle. A pending full rebuild covers this root.
// An element arriving connected brings its shadow tree, and any nested in
// it, back into the cascade: one it registered on attach is let go when it
// leaves the document.
function registerConnectedShadowRoots(
	cascade: Cascade,
	element: Element,
): void {
	const root = getShadowRoot(element) as ShadowRoot | null;
	if (
		root === null || !element.isConnected || cascade[kShadowRoots].has(root)
	) {
		return;
	}
	reobserveShadowRoot(root);
	cascade.registerShadowRoot(root);
	for (const child of root.querySelectorAll("*")) {
		registerConnectedShadowRoots(cascade, child);
	}
}

// In place rather than by a full parse, which renews every rule's id and
// leaves no shared table reusable.
function noteHasRule(
	cascade: Cascade,
	anchors: readonly string[],
	states: readonly string[],
): void {
	cascade[kHasRulesExist] = true;
	for (const anchor of anchors) {
		cascade[kHasAnchors].add(anchor);
	}
	for (const state of states) {
		cascade[kHasStates].add(state);
	}
}

// For each :has() in a selector, what the compound it is written on asks
// of an element: its id, else a class, else its local name, else
// anything. What a functional pseudo-class or an attribute selector asks
// is left out, so the answer only ever asks for less.
function getHasAnchors(selector: string): string[] {
	const anchors: string[] = [];
	for (
		let at = selector.indexOf(":has(");
		at !== -1;
		at = selector.indexOf(":has(", at + 5)
	) {
		let start = at;
		let depth = 0;
		while (start > 0) {
			const char = selector[start - 1];
			if (char === ")" || char === "]") {
				depth++;
			} else if (char === "(" || char === "[") {
				if (depth === 0) {
					break;
				}
				depth--;
			} else if (depth === 0 && /[\s>+~,]/.test(char)) {
				break;
			}
			start--;
		}
		let compound = selector.slice(start, at);
		if (/[\\|]/.test(compound)) {
			anchors.push("*");
			continue;
		}
		let previous;
		do {
			previous = compound;
			compound = compound
				.replace(/:[\w-]+\([^()]*\)/g, "")
				.replace(/\[[^[\]]*\]/g, "");
		} while (compound !== previous);
		const id = /#([\w-]+)/.exec(compound);
		const className = /\.([\w-]+)/.exec(compound);
		const tag = /^([a-zA-Z][\w-]*)/.exec(compound);
		anchors.push(
			id
				? `#${id[1]}`
				: className ? `.${className[1]}` : tag ? tag[1].toLowerCase() : "*",
		);
	}
	return anchors;
}

function couldAnchorHas(cascade: Cascade, element: Element): boolean {
	const anchors = cascade[kHasAnchors];
	if (anchors.has("*") || anchors.has(element.localName.toLowerCase())) {
		return true;
	}
	const id = element.getAttribute("id");
	if (id !== null && anchors.has(`#${id}`)) {
		return true;
	}
	for (const className of element.classList) {
		if (anchors.has(`.${className}`)) {
			return true;
		}
	}
	return false;
}

function forgetShadowRoot(cascade: Cascade, root: ShadowRoot): void {
	dropScopedRules(cascade, root);
	cascade[kSiblingIndexes].delete(root);
	// The root's :has() rules went with it, and so does what they asked for.
	cascade[kHasRulesExist] = false;
	cascade[kHasAnchors] = new Set();
	cascade[kHasStates] = new Set();
	for (const rule of cascade[kParsedRules]) {
		if (rule.hasAnchors !== undefined) {
			noteHasRule(cascade, rule.hasAnchors, rule.hasStates ?? []);
		}
	}
	// A parse already due builds without the root. One that is not would
	// see the sheet count drop and rebuild everything.
	if (!cascade[kStylesheetsDirty] && cascade[kParsedStyleSheetCount] >= 0) {
		cascade[kParsedStyleSheetCount] = getStyleSheetCount(cascade);
	}
}

// A tree's rules, wherever the cascade files them: the pseudo-element rules
// are filed twice.
function dropScopedRules(cascade: Cascade, root: ShadowRoot): void {
	cascade[kParsedRules] = cascade[kParsedRules].filter(
		(rule) => rule.scope !== root,
	);
	for (const [type, rules] of cascade[kPseudoRulesByType]) {
		const kept = rules.filter((rule) => rule.scope !== root);
		if (kept.length === 0) {
			cascade[kPseudoRulesByType].delete(type);
		} else if (kept.length !== rules.length) {
			cascade[kPseudoRulesByType].set(type, kept);
		}
	}
	// Rebuilt on the next match, which may not come soon after a removal.
	ruleIndexes.delete(cascade);
}

function syncShadowRoot(cascade: Cascade, root: ShadowRoot): void {
	if (cascade[kStylesheetsDirty] || cascade[kParsedStyleSheetCount] < 0) {
		cascade[kStylesheetsDirty] = true;
		return;
	}
	dropScopedRules(cascade, root);
	const before = cascade[kParsedRules].length;
	for (const sheet of getShadowStyleSheets(root)) {
		parseStyleSheet(cascade, sheet, root);
	}
	// Without this sync the drift check orders the full rebuild this path
	// exists to avoid, once per UA shadow tree.
	cascade[kParsedStyleSheetCount] = getStyleSheetCount(cascade);
	const fresh = cascade[kParsedRules].slice(before);
	if (fresh.length === 0) {
		return;
	}
	const layerRanks = rankLayers(cascade);
	for (const rule of cascade[kParsedRules]) {
		rule.layerRank = rule.layer === null
			? cascade[kUnlayeredRank]
			: (layerRanks.get(rule.layer) ?? cascade[kUnlayeredRank]);
	}
	sortRulesForCascade(cascade);
	const host = root.host as Element | null;
	if (host) {
		invalidateSubtree(cascade, host);
	} else {
		for (const child of root.children) {
			invalidateSubtree(cascade, child);
		}
	}
	// The UA shadow trees' sheets have no pseudo-generating rules, so the
	// attach sweep runs only for an author shadow root that does.
	if (fresh.some((rule) => generatesPseudoElement(rule.pseudoElement))) {
		attachPseudoElements(cascade);
	}
}

// Everything restyles, as it does when a stylesheet changes.
function restyleAll(cascade: Cascade): void {
	dropCache(cascade);
	const root = cascade[kDocument].documentElement;
	if (root) {
		cascade[kLayout].invalidate(root);
	} else {
		cascade[kLayout].invalidateFrame();
	}
}

// Replace each counter(name[, style]) with the number it stands at
// here.
function resolveCounterFunction(
	cascade: Cascade,
	element: Element,
	content: string,
): string {
	initializeCounters(cascade, element);
	const scope = cascade[kCounterScopes].get(element);
	return content.replace(
		/counter\s*\(\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g,
		(_match, counterName, style) => {
			const trimmedName = counterName.trim();
			const trimmedStyle = style?.trim() || "decimal";
			return CSSValues.formatCounterValue(
				CSSValues.getCounterValueInScope(scope, trimmedName),
				trimmedStyle,
			);
		},
	);
}

function reachesSiblings(
	cascade: Cascade,
	element: Element,
	states: readonly string[],
): boolean {
	parseStylesheetsIfStale(cascade);
	return states.some((state) =>
		cascade[kSiblingPseudoClasses]
			.get(state)?.some((anchor) => couldAnchor(element, anchor)),
	);
}

// Whether a change to any of these states on the element can restyle
// its descendants, or its later siblings, under the rules as parsed.
function reachesDescendants(
	cascade: Cascade,
	element: Element,
	states: readonly string[],
): boolean {
	parseStylesheetsIfStale(cascade);
	return states.some((state) =>
		cascade[kDescendantPseudoClasses]
			.get(state)?.some((anchor) => couldAnchor(element, anchor)),
	);
}

function pseudoDeclarationsFor(
	cascade: Cascade,
	element: Element,
	pseudoElement: string,
): Record<string, string> {
	const declarations: Record<string, string> = {
		...computePseudoElementStyle(cascade, element, pseudoElement),
	};
	// A pseudo-element INHERITS from its originating element. Rule
	// declarations win, and inherited values only fill the gaps.
	const hostStyle = cascade.declarationFor(element);
	inheritedProperties ??= CSS_PROPERTIES.filter(CSSValues.isInheritedProperty);
	for (const property of inheritedProperties) {
		if (!declarations[property]) {
			const inherited = hostStyle[kComputedValue](property);
			if (inherited) {
				declarations[property] = inherited;
			}
		}
	}
	// A pseudo-element of a flex or grid container is one of its items,
	// and an item's display isBlockified, including the initial `inline`.
	if (ITEM_DISPLAYS.has(hostStyle[kComputedValue]("display"))) {
		declarations.display = CSSValues.getBlockifiedDisplay(
			declarations.display || getInitialStyle(null, "display"),
		);
	}
	return declarations;
}

function getCascadeRules(cascade: Cascade, element: Element): ParsedCSSRule[] {
	parseStylesheetsIfStale(cascade);
	const rules = getMatchingRules(cascade, element);
	const hints = getHintRule(element);
	if (hints === null) {
		return rules;
	}
	// Author level, zero specificity, ahead of every author rule and
	// layer (HTML §15.1).
	const at = rules.findIndex((rule) => !rule.uaOrigin);
	return at === -1
		? [...rules, hints]
		: [...rules.slice(0, at), hints, ...rules.slice(at)];
}

// A state changed on the element. The element restyles. Its subtree and
// its shadow tree do when a rule tests the state above what it styles,
// as :hover .x or :host(:focus) do, or sets something they inherit.
// Its later siblings do when a rule tests it before + or ~.
function invalidateForState(
	cascade: Cascade,
	element: Element,
	states: readonly string[],
): void {
	if (reachesDescendants(cascade, element, states)) {
		invalidateSubtree(cascade, element);
		const shadowRoot = getShadowRoot(element);
		if (shadowRoot) {
			for (const descendant of shadowRoot.querySelectorAll("*")) {
				invalidateElementCaches(cascade, descendant);
			}
		}
	} else {
		invalidateElementCaches(cascade, element);
		attachPseudoElementsToElement(cascade, element);
	}
	if (reachesSiblings(cascade, element, states)) {
		invalidateLaterSiblings(cascade, element);
	}
}

// Every author-facing style read goes through this flush, so a value
// read right after a DOM change describes it. It settles style only: a
// value that is measured lays out first through getUsedRect. The
// engine's own reads never flush. Not re-entrant: layout and paint
// resolve styles as they run, and asking for the flush from inside it
// would compute it inside itself.
function flushCascadeStyle(cascade: Cascade): void {
	if (cascade[kFlushing]) {
		return;
	}
	cascade[kFlushing] = true;
	try {
		if (flushStyle(cascade[kDocument])) {
			cascade[kUsedValues] = new WeakMap();
		}
	} finally {
		cascade[kFlushing] = false;
	}
}

function dropCache(cascade: Cascade): void {
	// Every computed style ever handed out re-resolves on its next read.
	cascade[kCurrentDeclarations] = new WeakSet<object>();
	cascade[kUsedValues] = new WeakMap();
	cascade[kComputedStyleCache] = new WeakMap();
	cascade[kHasResults] = null;
	cascade[kPseudoElementStyleCache] = new WeakMap();
	cascade[kCounterScopes] = new WeakMap();
}

// The box a child's or a pseudo-element's percentage resolves against,
// measured behind the same flush a rect read takes.
function contentBox(cascade: Cascade, element: Element): DOMRect | null {
	if (!getUsedRect(cascade, element)) {
		return null;
	}
	return toPxRect(cascade[kLayout].contentRect(element), element);
}

// The descendants a class change can restyle, as the subjects of the
// rules that test the classes that came or went, or null when the change
// needs the general answer: any descendant, or an old value unknown.
function classChangeSubjects(
	cascade: Cascade,
	element: Element,
	oldValue: string | null,
): StateAnchor[] | null {
	if (oldValue === null || cascade[kReachingAttributes].has("class")) {
		return null;
	}
	const before = new Set(oldValue.split(/\s+/));
	const after = getClassTokens(element);
	const changed = [
		...[...after].filter((token) => !before.has(token)),
		...[...before].filter((token) => token !== "" && !after.has(token)),
	];
	const anchors: StateAnchor[] = [];
	for (const token of changed) {
		const subjects = cascade[kClassSubjects].get(token);
		if (subjects === null) {
			return null;
		}
		if (subjects !== undefined) {
			anchors.push(...subjects);
		}
	}
	return anchors;
}

// A state that follows one element and its flat-tree ancestors, :hover or
// :active, moved from one chain to another. Only the elements on one
// chain and not the other changed.
function chainStateChange(
	cascade: Cascade,
	previous: Element | null,
	next: Element | null,
	state: string,
): void {
	if (cascade[kHasStates].has(state)) {
		restyleAll(cascade);
		return;
	}
	const getChain = (element: Element | null): Set<Element> => {
		const chain = new Set<Element>();
		for (
			let node: Element | null = element; node; node = flatParentElement(node)
		) {
			chain.add(node);
		}
		return chain;
	};
	const previousChain = getChain(previous);
	const nextChain = getChain(next);
	const invalidate = (node: Element): void => {
		invalidateForState(cascade, node, [state]);
	};
	for (const node of previousChain) {
		if (!nextChain.has(node)) {
			invalidate(node);
		}
	}
	for (const node of nextChain) {
		if (!previousChain.has(node)) {
			invalidate(node);
		}
	}
}

// Whether this attribute change can affect a DESCENDANT's style, by a
// rule that matches one or a value they inherit. An inline style always
// can, because what it declares is not known until parsed.
function attributeReachesDescendants(
	cascade: Cascade,
	element: Element,
	name: string,
	oldValue: string | null,
): boolean {
	if (isHintAttribute(element, name)) {
		return true;
	}
	if (name === "style") {
		if (oldValue === null) {
			return true;
		}
		return inlineChangeReachesDescendants(
			oldValue,
			element.getAttribute("style") ?? "",
		);
	}
	if (name === "class") {
		if (cascade[kReachingAttributes].has("class")) {
			return true;
		}
		if (cascade[kReachingClasses].size === 0) {
			return false;
		}
		// With no old value, the classes that LEFT cannot be known.
		if (oldValue === null) {
			return element.hasAttribute("class");
		}
		// Only the classes that came or went can have changed a match.
		const before = new Set(oldValue.split(/\s+/));
		const after = getClassTokens(element);
		for (const token of after) {
			if (!before.has(token) && cascade[kReachingClasses].has(token)) {
				return true;
			}
		}
		for (const token of before) {
			if (
				token !== "" &&
				!after.has(token) &&
				cascade[kReachingClasses].has(token)
			) {
				return true;
			}
		}
		return false;
	}
	if (name === "id") {
		if (cascade[kReachingAttributes].has("id")) {
			return true;
		}
		if (oldValue !== null && cascade[kReachingIds].has(oldValue)) {
			return true;
		}
		const id = element.getAttribute("id");
		return id !== null && cascade[kReachingIds].has(id);
	}
	if (cascade[kReachingAttributes].has(name)) {
		return true;
	}
	return cascade[kReachingStates] && CSSValues.isStateAttribute(name);
}

// The flush runs once per change, not once per read. A caller reading
// four properties off two hundred elements pays one flush, not eight
// hundred. Nothing under the flush can call back into this.
// In CSS pixels, the unit every used value is reported in.
function getUsedRect(cascade: Cascade, element: Element): DOMRect | null {
	if (cascade[kUsedStale]) {
		flushLayout(cascade[kDocument]);
		cascade[kUsedStale] = false;
		cascade[kUsedValues] = new WeakMap();
	}
	return toPxRect(cascade[kLayout].getRect(element), element);
}

function toPxRect(rect: DOMRect | null, node: Node): DOMRect | null {
	if (rect === null || getCellSize(node) === UNIT_CELL) {
		return rect;
	}
	return new (rect.constructor as typeof DOMRect)(
		pxFromCells(rect.x, false, node),
		pxFromCells(rect.y, true, node),
		pxFromCells(rect.width, false, node),
		pxFromCells(rect.height, true, node),
	);
}

// A pseudo-element's declaration, on the same internal read path.
function getPseudoDeclaration(
	cascade: Cascade,
	element: Element,
	pseudoElement: string,
): PseudoStyleDeclaration {
	const cached = cascade[kPseudoElementStyleCache]
		.get(element)?.get(pseudoElement);
	if (cached) {
		return cached;
	}
	const declarations = pseudoDeclarationsFor(cascade, element, pseudoElement);
	const declaration = new PseudoStyleDeclaration(
		declarations,
		element,
		cascade,
		pseudoElement,
	);
	// The cache is fetched HERE, not before the work. Resolving the host's
	// style can reparse the stylesheets, which replaces every cache on this
	// cascade, and a map fetched before that would be orphaned.
	let elementCache = cascade[kPseudoElementStyleCache].get(element);
	if (!elementCache) {
		elementCache = new Map();
		cascade[kPseudoElementStyleCache].set(element, elementCache);
	}
	elementCache.set(pseudoElement, declaration);
	processTransitionStyle(
		cascade,
		element,
		(property) => declaration[kBaseValue](property),
		pseudoElement,
	);
	return declaration;
}

// A registered highlight name is a DOMString, so the escapes a selector
// spells it with are not part of it: `::highlight(a\.b)` and
// CSS.highlights.set("a.b", ...) name the same highlight.
function unescapeHighlightName(pseudoElement: string): string {
	const written = pseudoElement.match(/^::highlight\((.*)\)$/);
	if (written === null) {
		return pseudoElement;
	}
	return `::highlight(${CSSTree.ident.decode(written[1].trim())})`;
}

// The pseudo-elements a page styles a built-in control's parts through,
// by the part names its UA shadow tree gives them. Author shadow trees
// are not eligible: their parts are theirs to style from inside.
const PART_PSEUDOS: Readonly<Record<string, Readonly<Record<string, string>>>> =
	{
		"*": {
			placeholder: "::placeholder",
			selection: "::selection",
			"details-content": "::details-content",
		},
		SELECT: {picker: "::picker(select)", indicator: "::picker-icon"},
	};

const PART_PSEUDO_NAMES = new Set(
	Object.values(PART_PSEUDOS).flatMap((names) => Object.values(names)),
);

// True for a pseudo-element the tree needs a node of its own for. The
// rest -- ::placeholder, ::selection, ::part() and ::highlight() --
// style boxes that already exist.
function generatesPseudoElement(
	pseudoElement: string | undefined,
): pseudoElement is string {
	return Boolean(
		pseudoElement &&
		pseudoElement !== "::placeholder" &&
		pseudoElement !== "::selection" &&
		pseudoElement !== "::details-content" &&
		!PART_PSEUDO_NAMES.has(pseudoElement) &&
		!pseudoElement.startsWith("::part(") &&
		!pseudoElement.startsWith("::highlight("),
	);
}

// Driven from the rules rather than the tree, so the walk costs what
// the sheets ask for rather than what the document holds.
function attachPseudoElementsToDocument(cascade: Cascade): void {
	const pseudoRulesByType = new Map<string, ParsedCSSRule[]>();

	for (const rule of cascade[kParsedRules]) {
		if (generatesPseudoElement(rule.pseudoElement)) {
			const rules = pseudoRulesByType.get(rule.pseudoElement) || [];
			rules.push(rule);
			pseudoRulesByType.set(rule.pseudoElement, rules);
		}
	}

	for (const [pseudoType, rules] of pseudoRulesByType) {
		const matchingElements = new Set<Element>();

		for (const rule of rules) {
			// Within the rule's own tree scope. A :host rule reaches the one
			// element outside it.
			const scope = (rule.scope ?? cascade[kDocument]) as Node;
			for (const element of selectForRule(scope, rule)) {
				matchingElements.add(element);
			}
			if (rule.ofPart) {
				for (const root of cascade[kShadowRoots]) {
					for (const element of selectForRule(root, rule)) {
						matchingElements.add(element);
					}
				}
			}
			const host = rule.reachesHost
				? ((rule.scope as ShadowRoot).host as Element | null)
				: null;
			if (host && ruleSelectorMatches(host, rule)) {
				matchingElements.add(host);
			}
		}

		for (const element of matchingElements) {
			attachPseudoElementToElementForType(cascade, element, pseudoType);
		}
	}

	// A ::marker needs no rule to exist, since list-style-type gives it
	// content on its own, so the items are found by tag, by inline style,
	// and by every rule that declares the display.
	const listItems = new Set<Element>(
		cascade[kDocument].querySelectorAll('[style*="list-item"], li, summary'),
	);
	for (const rule of cascade[kParsedRules]) {
		if (rule.declarations["display"] === "list-item" && !rule.uaOrigin) {
			const scope = (rule.scope ?? cascade[kDocument]) as Node;
			for (const element of selectForRule(scope, rule)) {
				listItems.add(element);
			}
		}
	}
	for (const element of listItems) {
		const computedStyle = cascade.declarationFor(element);
		const display = computedStyle[kComputedValue]("display");
		const listStylePosition =
			computedStyle[kComputedValue]("list-style-position") || "outside";

		if (display === "list-item" && listStylePosition !== "outside") {
			attachPseudoElementToElementForType(cascade, element, "::marker");
		}
	}
}

// The parent's scope is read, never built. Building it recursively up a
// deep tree is what this avoids.
// Built on first read, not on invalidation: a counter's value depends
// on the element's ancestors, and for a list item on the items before
// it, so the parent is built first and a dropped scope comes back when
// something next asks.
function initializeCounters(cascade: Cascade, element: Element): void {
	if (cascade[kCounterScopes].has(element)) {
		return;
	}
	if (element.parentElement) {
		initializeCounters(cascade, element.parentElement);
	}

	// With no counter rules anywhere, only lists carry counters. But an
	// element under a scope-holding parent still joins, so a chain like ol >
	// li > div > ol keeps its inheritance path unbroken.
	const tag = element.tagName;
	if (
		!cascade[kCounterRulesExist] &&
		tag !== "OL" &&
		tag !== "UL" &&
		tag !== "LI" &&
		!(
			element.parentElement &&
			cascade[kCounterScopes].has(element.parentElement)
		) &&
		!(element.getAttribute("style") ?? "").includes("counter")
	) {
		return;
	}

	const computedStyle = cascade.declarationFor(element);
	const counterReset = computedStyle[kComputedValue]("counter-reset");
	const counterIncrement = computedStyle[kComputedValue]("counter-increment");

	const parentElement = element.parentElement;
	const parentScope = parentElement
		? cascade[kCounterScopes].get(parentElement)
		: undefined;

	const scope: CSSValues.CounterScope = {
		element,
		counters: {},
		parent: parentScope,
	};
	cascade[kCounterScopes].set(element, scope);

	if (counterReset && counterReset !== "none") {
		CSSValues.parseCounterReset(scope, counterReset);
	}

	if (element.tagName === "OL" || element.tagName === "UL") {
		const startValue = element.tagName === "OL"
			? parseInt(element.getAttribute("start") || "1", 10)
			: 0;
		// start - 1, so the first increment gives start.
		scope.counters["list-item"] = startValue - 1;
	}

	if (counterIncrement && counterIncrement !== "none") {
		parseCounterIncrement(cascade, scope, counterIncrement);
	}

	if (element.tagName === "LI") {
		incrementCounter(cascade, scope, "list-item", 1);
	}
}

function parseCounterIncrement(
	cascade: Cascade,
	scope: CSSValues.CounterScope,
	counterIncrement: string,
): void {
	for (const [name, increment] of CSSValues.getCounterPairs(
		counterIncrement,
		1,
	)) {
		incrementCounter(cascade, scope, name, increment);
	}
}

function incrementCounter(
	cascade: Cascade,
	scope: CSSValues.CounterScope,
	counterName: string,
	increment: number,
): void {
	// A list item counts from the item before it, not from its scope.
	// Siblings share one list, and each scope only ever holds its own
	// element's value.
	if (counterName === "list-item" && scope.element.tagName === "LI") {
		const currentValue = getListItemCounterValue(cascade, scope.element);
		scope.counters[counterName] = currentValue + increment;
	} else {
		const currentValue = CSSValues.getCounterValueInScope(
			scope.parent,
			counterName,
		);
		scope.counters[counterName] = currentValue + increment;
	}
}

// The list's start value plus the items before this one. Siblings
// share one counter, and each scope holds only its own element's value.
function getListItemCounterValue(cascade: Cascade, element: Element): number {
	let parent = element.parentElement;
	while (parent && parent.tagName !== "OL" && parent.tagName !== "UL") {
		parent = parent.parentElement;
	}

	if (!parent) {
		return 0;
	}

	// Items initialize in document order, so the nearest earlier item that
	// has a scope already holds the count up to itself. Counting from the
	// list's start for every item made a long list quadratic.
	let uncounted = 0;
	for (
		let previous = element.previousElementSibling;
		previous !== null;
		previous = previous.previousElementSibling
	) {
		if (previous.tagName !== "LI") {
			continue;
		}
		const scope = cascade[kCounterScopes].get(previous as Element);
		if (scope !== undefined && "list-item" in scope.counters) {
			return scope.counters["list-item"] + uncounted;
		}
		uncounted++;
	}
	const parentScope = cascade[kCounterScopes].get(parent);
	return (parentScope?.counters["list-item"] ?? 0) + uncounted;
}

function getUsedValues(
	cascade: Cascade,
	declaration: object,
): Map<string, string> {
	let values = cascade[kUsedValues].get(declaration);
	if (!values) {
		values = new Map();
		cascade[kUsedValues].set(declaration, values);
	}
	return values;
}

function dropUsedValues(cascade: Cascade, declaration: object): void {
	cascade[kUsedValues].delete(declaration);
}

// In a document, and reachable through the flat tree it composes. A
// light-DOM child its host never slots has no computed style to report.
function isBeingRendered(element: Element): boolean {
	// Walk out through every shadow root the element is under. A tree whose
	// outermost root is the document is composed into the rendering. One
	// that ends in a bare fragment is not.
	let node: Node = element;
	for (let depth = 0; depth < 32; depth++) {
		const root = node.getRootNode();
		if (root === element.ownerDocument) {
			break;
		}
		const host = (root as ShadowRoot).host;
		if (!host) {
			return false;
		}
		node = host;
	}
	// A light-DOM child an open shadow root never slots is outside the flat
	// tree. A closed root is this engine's own UA shadow tree internals, whose
	// parts the UA shadow tree itself reads styles for.
	for (
		let child: Element | null = element; child; child = child.parentElement
	) {
		const parent = child.parentElement;
		if (
			parent?.shadowRoot &&
			parent.shadowRoot.mode === "open" &&
			!(child as HTMLElement).assignedSlot
		) {
			return false;
		}
	}
	return true;
}

// What window.getComputedStyle returns: CSSOM's RESOLVED value, which
// is computed for most properties and used for the ones that need
// layout. The platform method is misnamed, and this is the one place the
// engine uses that name.
function getResolvedStyle(
	cascade: Cascade,
	element: Element,
	pseudoElt?: string | null,
): globalThis.CSSStyleDeclaration {
	flushCascadeStyle(cascade);
	parseStylesheetsIfStale(cascade);
	// An element out of the document, or out of the flat tree it composes,
	// has no style to report. Only an author read comes through here.
	if (!isBeingRendered(element)) {
		return new EmptyStyleDeclaration(
			element,
		) as unknown as globalThis.CSSStyleDeclaration;
	}

	let pseudoElement = "";
	if (pseudoElt) {
		const parsed = CSSValues.parsePseudoElementArgument(String(pseudoElt));
		if (parsed === null) {
			return new EmptyStyleDeclaration(
				element,
			) as unknown as globalThis.CSSStyleDeclaration;
		}
		pseudoElement = unescapeHighlightName(parsed);
	}

	if (pseudoElement) {
		return getIndexedDeclaration(
			getPseudoDeclaration(cascade, element, pseudoElement),
		) as unknown as globalThis.CSSStyleDeclaration;
	}

	return getIndexedDeclaration(
		cascade.declarationFor(element),
	) as unknown as globalThis.CSSStyleDeclaration;
}

interface QueuedTransitionEvent {
	element: Element;
	type: string;
	propertyName: string;
	elapsedTime: number;
	pseudoElement: string;
}

// Only properties something read are here, which is enough: a value
// nothing computed has nothing to transition from. Runs regardless of
// the sticky gate, because the write declaring an element's first
// transition lands AFTER the invalidation that drops the values it
// transitions from.
function storeTransitionFallback(
	cascade: Cascade,
	element: Element,
	pseudo: string,
	resolved: Map<string, string>,
): void {
	if (resolved.size === 0) {
		return;
	}
	let byPseudo = cascade[kTransitionFallback].get(element);
	if (!byPseudo) {
		byPseudo = new Map();
		cascade[kTransitionFallback].set(element, byPseudo);
	}
	byPseudo.set(pseudo, resolved);
}

// One style change event: compare the new base values against the last
// snapshot; start, retarget or cancel; store the new snapshot. The early
// returns are all each style change in a transition-free document pays.
function processTransitionStyle(
	cascade: Cascade,
	element: Element,
	read: (property: string) => string,
	pseudo: string,
): void {
	const active = cascade[kActiveTransitions].get(element)?.get(pseudo);
	if (!cascade[kTransitionsExist] && !active) {
		// An inline transition written right before this event may not have
		// parsed yet. The attribute text is the one place it already shows.
		const attribute = element.getAttribute("style");
		if (!attribute || !attribute.includes("transition")) {
			return;
		}
		cascade[kTransitionsExist] = true;
	}
	const candidates = CSSValues.getMatchedTransitions(read);
	let snapshots = cascade[kTransitionSnapshots].get(element);
	const previous = snapshots?.get(pseudo);
	const fallbacks = cascade[kTransitionFallback].get(element);
	const fallback = fallbacks?.get(pseudo);
	if (fallback) {
		fallbacks!.delete(pseudo);
	}
	if (!candidates && !active && !previous) {
		return;
	}
	const now = performance.now();
	const names = new Set<string>([
		...(candidates?.keys() ?? []),
		...(active?.keys() ?? []),
	]);
	for (const property of names) {
		const after = CSSValues.getTransitionBase(read, property);
		const timing = candidates?.get(property);
		const runnable =
			timing !== undefined && timing.duration + Math.max(timing.delay, 0) > 0;
		const running = active?.get(property);
		if (running) {
			if (!runnable) {
				cancelTransition(cascade, element, pseudo, property, now);
				continue;
			}
			if (after === running.to) {
				continue;
			}
			const current = CSSValues.getCurrentTransitionValue(running, now);
			cancelTransition(cascade, element, pseudo, property, now);
			if (current === after) {
				continue;
			}
			// A change back toward where an unfinished transition came from
			// plays in the portion already covered (css-transitions-1 §3).
			let duration = timing.duration;
			let factor = 1;
			if (after === running.reversingAdjustedStartValue) {
				const progress = CSSValues.getTransitionProgress(running, now);
				factor = Math.min(
					Math.max(
						progress * running.reversingShorteningFactor +
						(1 - running.reversingShorteningFactor),
						0,
					),
					1,
				);
				duration *= factor;
			}
			startTransition(cascade, element, pseudo, property, {
				from: current,
				to: after,
				timing: {...timing, duration},
				now,
				reversingAdjustedStartValue: running.to,
				reversingShorteningFactor: factor,
			});
			continue;
		}
		// An element styled for the first time transitions nothing. The
		// fallback's raw entries store "no declaration" as the empty string,
		// and the snapshot stores the initial value explicitly.
		const raw = previous?.get(property) ?? fallback?.get(property);
		const before = raw === ""
			? CSSValues.getComputedValueEntry(
				property,
				CSS_INITIAL_VALUES[property] ?? "",
			)
			: raw;
		if (before === undefined || before === after || !runnable) {
			continue;
		}
		startTransition(cascade, element, pseudo, property, {
			from: before,
			to: after,
			timing: timing!,
			now,
			reversingAdjustedStartValue: before,
			reversingShorteningFactor: 1,
		});
	}
	if (candidates) {
		const snapshot = new Map<string, string>();
		for (const property of candidates.keys()) {
			snapshot.set(property, CSSValues.getTransitionBase(read, property));
		}
		if (!snapshots) {
			snapshots = new Map();
			cascade[kTransitionSnapshots].set(element, snapshots);
		}
		snapshots.set(pseudo, snapshot);
	} else if (previous) {
		snapshots!.delete(pseudo);
	}
}

function startTransition(
	cascade: Cascade,
	element: Element,
	pseudo: string,
	property: string,
	options: {
		from: string;
		to: string;
		timing: CSSValues.TransitionTiming;
		now: number;
		reversingAdjustedStartValue: string;
		reversingShorteningFactor: number;
	},
): void {
	let byPseudo = cascade[kActiveTransitions].get(element);
	if (!byPseudo) {
		byPseudo = new Map();
		cascade[kActiveTransitions].set(element, byPseudo);
	}
	let transitions = byPseudo.get(pseudo);
	if (!transitions) {
		transitions = new Map();
		byPseudo.set(pseudo, transitions);
	}
	const {timing, now} = options;
	const transition: CSSValues.RunningTransition = {
		property,
		from: options.from,
		to: options.to,
		start: now,
		delay: timing.delay,
		duration: timing.duration,
		easing: CSSValues.parseEasing(timing.easing),
		started: timing.delay <= 0,
		reversingAdjustedStartValue: options.reversingAdjustedStartValue,
		reversingShorteningFactor: options.reversingShorteningFactor,
	};
	transitions.set(property, transition);
	cascade[kTransitionClock] = now;
	// A negative delay starts partway in, which is what elapsedTime
	// reports.
	const elapsed = Math.min(Math.max(-timing.delay, 0), timing.duration) / 1000;
	queueTransitionEvent(
		cascade,
		element,
		"transitionrun",
		property,
		elapsed,
		pseudo,
	);
	if (transition.started) {
		queueTransitionEvent(
			cascade,
			element,
			"transitionstart",
			property,
			elapsed,
			pseudo,
		);
	}
	scheduleTransitionTick(cascade);
}

function cancelTransition(
	cascade: Cascade,
	element: Element,
	pseudo: string,
	property: string,
	now: number,
): void {
	const byPseudo = cascade[kActiveTransitions].get(element);
	const transitions = byPseudo?.get(pseudo);
	const transition = transitions?.get(property);
	if (!transition || !transitions || !byPseudo) {
		return;
	}
	transitions.delete(property);
	if (transitions.size === 0) {
		byPseudo.delete(pseudo);
	}
	if (byPseudo.size === 0) {
		cascade[kActiveTransitions].delete(element);
	}
	const elapsed = Math.min(
		Math.max((now - transition.start - transition.delay) / 1000, 0),
		transition.duration / 1000,
	);
	queueTransitionEvent(
		cascade,
		element,
		"transitioncancel",
		property,
		elapsed,
		pseudo,
	);
}

// Interpolates against the cascade's clock rather than the wall clock.
// The clock moves once per tick, so a frame's reads agree with each
// other and with what the painter draws.
function getTransitionValue(
	cascade: Cascade,
	element: Element,
	pseudo: string,
	property: string,
): string | null {
	const transitions = cascade[kActiveTransitions].get(element)?.get(pseudo);
	const transition = transitions ? transitions.get(property) : undefined;
	if (!transition) {
		return null;
	}
	return CSSValues.getCurrentTransitionValue(
		transition,
		cascade[kTransitionClock],
	);
}

function queueTransitionEvent(
	cascade: Cascade,
	element: Element,
	type: string,
	propertyName: string,
	elapsedTime: number,
	pseudoElement: string,
): void {
	cascade[kTransitionEvents].push({
		element,
		type,
		propertyName,
		elapsedTime,
		pseudoElement,
	});
	if (cascade[kTransitionFlushQueued]) {
		return;
	}
	cascade[kTransitionFlushQueued] = true;
	// Style change events run under layout, and a listener can mutate the
	// DOM, so dispatch waits for the stack that queued it to unwind.
	queueMicrotask(() => flushTransitionEvents(cascade));
}

function flushTransitionEvents(cascade: Cascade): void {
	cascade[kTransitionFlushQueued] = false;
	if (cascade[kTransitionEvents].length === 0) {
		return;
	}
	const queued = cascade[kTransitionEvents];
	cascade[kTransitionEvents] = [];
	for (const item of queued) {
		const event = new TransitionEvent(item.type, {
			bubbles: true,
			cancelable: item.type === "transitionend",
			propertyName: item.propertyName,
			elapsedTime: item.elapsedTime,
			pseudoElement: item.pseudoElement,
		});
		dispatchAsUserAgent(item.element, event);
	}
}

function scheduleTransitionTick(cascade: Cascade): void {
	if (
		cascade[kTransitionTimer] !== null || cascade[kActiveTransitions].size === 0
	) {
		return;
	}
	cascade[kTransitionTimer] = setTimeout(() => {
		cascade[kTransitionTimer] = null;
		tickTransitions(cascade);
	}, 16);
}

// Promote delayed transitions, finish elapsed ones, cancel those whose
// element left the document, then invalidate so the next read returns
// the new interpolated values.
function tickTransitions(cascade: Cascade): void {
	const now = performance.now();
	cascade[kTransitionClock] = now;
	for (const [element, byPseudo] of [...cascade[kActiveTransitions]]) {
		const disconnected = !element.isConnected;
		for (const [pseudo, transitions] of [...byPseudo]) {
			for (const [property, transition] of [...transitions]) {
				if (disconnected) {
					cancelTransition(cascade, element, pseudo, property, now);
					continue;
				}
				if (!transition.started && now >= transition.start + transition.delay) {
					transition.started = true;
					queueTransitionEvent(
						cascade,
						element,
						"transitionstart",
						property,
						Math.min(Math.max(-transition.delay, 0), transition.duration) /
						1000,
						pseudo,
					);
				}
				if (now >= transition.start + transition.delay + transition.duration) {
					transitions.delete(property);
					queueTransitionEvent(
						cascade,
						element,
						"transitionend",
						property,
						transition.duration / 1000,
						pseudo,
					);
				}
			}
			if (transitions.size === 0) {
				byPseudo.delete(pseudo);
			}
		}
		if (byPseudo.size === 0) {
			cascade[kActiveTransitions].delete(element);
		}
		invalidateElementCaches(cascade, element);
	}
	cascade[kLayout].invalidateFrame();
	flushTransitionEvents(cascade);
	// A window no engine set up has no requestAnimationFrame, and its reads
	// interpolate on their own.
	const raf = (
		cascade[kWindow] as {requestAnimationFrame?: (cb: () => void) => number}
	).requestAnimationFrame;
	if (typeof raf === "function") {
		raf.call(cascade[kWindow], () => {});
	}
	scheduleTransitionTick(cascade);
}

// The document counts <style> elements as they join and leave, so this
// is cheap enough to poll on every computed-style read. That catches a
// sheet appended in the same tick, before the mutation observer
// delivers.
function getStyleSheetCount(cascade: Cascade): number {
	return styleElementCount(cascade[kDocument] as unknown as DOMDocument);
}

function parseStylesheetsIfStale(cascade: Cascade): void {
	if (
		cascade[kStylesheetsDirty] ||
		getStyleSheetCount(cascade) !== cascade[kParsedStyleSheetCount]
	) {
		parseStylesheets(cascade);
	}
}

// Descendants and the hosted shadow tree too, since inheritance crosses
// that boundary.
function invalidateSubtree(
	cascade: Cascade,
	element: Element,
	notifyLayout = true,
): void {
	// A paint-only change cannot create or remove a pseudo-element, since
	// `content` is not a paint property, so the attachment pass is skipped
	// with layout.
	for (const each of [element, ...element.querySelectorAll("*")]) {
		invalidateElementCaches(cascade, each, notifyLayout);
		if (notifyLayout) {
			attachPseudoElementsToElement(cascade, each);
		}
		// Closed and UA shadow trees inherit as an open one does.
		const root = getShadowRoot(each);
		if (root) {
			for (const child of root.children) {
				invalidateSubtree(cascade, child as Element, notifyLayout);
			}
		}
	}
}

function invalidateElement(cascade: Cascade, element: Element): void {
	// A computed style an author still holds is the one this cache handed
	// out, so it is told the cascade changed rather than merely dropped.
	const dropped = cascade[kComputedStyleCache].get(element);
	if (dropped) {
		cascade[kCurrentDeclarations].delete(dropped);
		storeTransitionFallback(cascade, element, "", dropped[kResolved]);
	}
	cascade[kComputedStyleCache].delete(element);
	cascade[kHasResults] = null;
	cascade[kPseudoElementStyleCache].delete(element);
	// A style change can flip display: contents, which moves the node's
	// flat-tree BOX parent, so every box enumeration is stale.
	cascade[kLayout].invalidateFrame();
}

// A child that came or went can change what the element's other
// children match, and the element itself through :empty. Their
// descendants only follow when a sheet tests siblings outside a subject
// or inherits through one.
function invalidateChildren(cascade: Cascade, element: Element): void {
	if (getSiblingIndex(cascade, element)?.reachesDescendants) {
		invalidateSubtree(cascade, element);
		return;
	}
	invalidateSibling(cascade, element);
	for (const child of element.children) {
		invalidateSibling(cascade, child);
	}
}

// `:focus ~ .card` and `:hover + label` match siblings AFTER the element
// whose state changed, and their cached styles know nothing of it.
function invalidateLaterSiblings(cascade: Cascade, element: Element): void {
	if (!getSiblingIndex(cascade, element)?.reachesSiblings) {
		return;
	}
	for (
		let sibling = element.nextElementSibling;
		sibling;
		sibling = sibling.nextElementSibling
	) {
		invalidateSibling(cascade, sibling);
	}
}

function invalidateSibling(cascade: Cascade, element: Element): void {
	const index = getSiblingIndex(cascade, element);
	if (index === undefined || !isSiblingTested(index, element)) {
		return;
	}
	if (index.reachesDescendants) {
		invalidateSubtree(cascade, element);
		return;
	}
	invalidateElementCaches(cascade, element);
	attachPseudoElementsToElement(cascade, element);
}

interface SiblingIndex {
	// Whether a selector can reach OUTSIDE a mutated element's subtree, to
	// its following siblings. The string tests are deliberately loose. A
	// false positive only widens the rebuild.
	reachesSiblings: boolean;
	reachesDescendants: boolean;
	// The tag, class, id and attribute keys of every sibling-tested
	// compound, so a change among an element's children restyles only the
	// children such a compound could name.
	keys: Set<string>;
	universal: boolean;
	// The class, id and attribute keys of every compound before a sibling
	// combinator, the `.on` of `.on ~ .light`, whose change on one element
	// changes what its later siblings match. Universal when that can't be
	// told from keys: an anchor under :not(), one with a pseudo-class an
	// attribute can flip, or an `of S` that counts siblings.
	anchorKeys: Set<string>;
	anchorsUniversal: boolean;
}

// The index of the tree whose rules could match the element: its shadow
// root's, or the document's.
function getSiblingIndex(
	cascade: Cascade,
	element: Element,
): SiblingIndex | undefined {
	const root = element.getRootNode();
	return cascade[kSiblingIndexes].get(
		isShadowRoot(root) ? root : cascade[kDocument],
	);
}

function getOrCreateSiblingIndex(
	cascade: Cascade,
	scope: Node | undefined,
): SiblingIndex {
	const key = scope ?? cascade[kDocument];
	let index = cascade[kSiblingIndexes].get(key);
	if (index === undefined) {
		index = {
			reachesSiblings: false,
			reachesDescendants: false,
			keys: new Set(),
			universal: false,
			anchorKeys: new Set(),
			anchorsUniversal: false,
		};
		cascade[kSiblingIndexes].set(key, index);
	}
	return index;
}

// Whether an attribute change could change what a sibling-tested
// compound makes of the element, and so what its later siblings match.
// Only a class, id or attribute such a compound names can: `.on ~ .light`
// cares about `on`, and `summary:first-of-type` about no attribute at all.
function changeReachesLaterSiblings(
	index: SiblingIndex | undefined,
	element: Element,
	attributeName: string,
	oldValue: string | null,
): boolean {
	if (index === undefined || !index.reachesSiblings) {
		return false;
	}
	if (index.anchorsUniversal) {
		return true;
	}
	const keys = index.anchorKeys;
	if (attributeName === "class") {
		const before = new Set((oldValue ?? "").split(/[\t\n\f\r ]+/));
		const after = new Set(getClassTokens(element));
		for (const token of before) {
			if (token !== "" && !after.has(token) && keys.has(`.${token}`)) {
				return true;
			}
		}
		for (const token of after) {
			if (!before.has(token) && keys.has(`.${token}`)) {
				return true;
			}
		}
		return false;
	}
	if (attributeName === "id") {
		const id = element.getAttribute("id");
		return (oldValue !== null && keys.has(`#${oldValue}`)) ||
			(id !== null && keys.has(`#${id}`)) ||
			keys.has("[id]");
	}
	return keys.has(`[${attributeName.slice(attributeName.indexOf(":") + 1)}]`);
}

// Whether some sibling-tested compound could name the element.
function isSiblingTested(index: SiblingIndex, element: Element): boolean {
	if (index.universal) {
		return true;
	}
	const keys = index.keys;
	if (keys.has(element.localName)) {
		return true;
	}
	for (const name of getClassTokens(element)) {
		if (keys.has(`.${name}`)) {
			return true;
		}
	}
	const id = element.getAttribute("id");
	if (id !== null && keys.has(`#${id}`)) {
		return true;
	}
	for (const name of element.getAttributeNames()) {
		if (keys.has(`[${name.slice(name.indexOf(":") + 1)}]`)) {
			return true;
		}
	}
	return false;
}

function invalidateElementCaches(
	cascade: Cascade,
	element: Element,
	notifyLayout = true,
): void {
	// The one place an element's computed style goes stale, so the one
	// place layout, which measured it under the style being dropped, is
	// notified, unless the caller knows nothing layout reads changed.
	if (notifyLayout) {
		cascade[kLayout].styleInvalidated(element);
	}
	// A computed style an author still holds is the one this cache handed
	// out, so it is told the cascade changed rather than merely dropped.
	const dropped = cascade[kComputedStyleCache].get(element);
	if (dropped) {
		cascade[kCurrentDeclarations].delete(dropped);
		storeTransitionFallback(cascade, element, "", dropped[kResolved]);
	}
	cascade[kComputedStyleCache].delete(element);
	cascade[kHasResults] = null;
	const droppedPseudos = cascade[kPseudoElementStyleCache].get(element);
	if (droppedPseudos) {
		for (const [name, declaration] of droppedPseudos) {
			cascade[kCurrentDeclarations].delete(declaration);
			storeTransitionFallback(cascade, element, name, declaration[kResolved]);
		}
	}
	cascade[kPseudoElementStyleCache].delete(element);
	cascade[kCounterScopes].delete(element);
}

// Properties the painter reads and layout never does. A rule declaring
// only these moves nothing when it starts or stops matching.
const PAINT_ONLY_PROPERTIES = new Set([
	"color",
	"background",
	"background-color",
	"background-image",
	"background-position",
	"background-repeat",
	"background-size",
	"background-attachment",
	"background-clip",
	"background-origin",
	"border-color",
	"border-top-color",
	"border-right-color",
	"border-bottom-color",
	"border-left-color",
	"border-block-color",
	"border-inline-color",
	"outline",
	"outline-color",
	"outline-style",
	"outline-width",
	"outline-offset",
	"text-decoration",
	"text-decoration-line",
	"text-decoration-color",
	"text-decoration-style",
	"text-decoration-thickness",
	"font-weight",
	"font-style",
	"caret-color",
	"accent-color",
	"cursor",
	"visibility",
	"opacity",
	"user-select",
	"pointer-events",
]);

// Whether every rule an attribute change can turn on or off declares
// paint properties only. The style attribute can declare anything; a
// key no rule tests changes nothing at all.
// Only a property that inherits, or display or all, which reshape the
// children, can change a descendant's style. A height or a margin
// written inline changes the element alone.
function inlineChangeReachesDescendants(
	before: string,
	after: string,
): boolean {
	const read = (text: string): Map<string, string> => {
		const values = new Map<string, string>();
		for (const declaration of CSSValues.parseDeclarationText(text)) {
			values.set(
				declaration.name,
				`${declaration.value}${declaration.important ? "!" : ""}`,
			);
		}
		return values;
	};
	const was = read(before);
	const now = read(after);
	for (const property of new Set([...was.keys(), ...now.keys()])) {
		if (was.get(property) === now.get(property)) {
			continue;
		}
		if (
			property === "all" ||
			property === "display" ||
			CSSValues.isInheritedProperty(property)
		) {
			return true;
		}
	}
	return false;
}

function isPaintOnlyChange(
	cascade: Cascade,
	element: Element,
	name: string,
	oldValue: string | null,
): boolean {
	if (
		name === "style" ||
		isLayoutHintAttribute(element, name) ||
		(cascade[kReachingStates] && CSSValues.isStateAttribute(name))
	) {
		return false;
	}
	const keys: string[] = [`[${name}]`];
	if (name === "class") {
		const before = oldValue === null ? [] : oldValue.split(/\s+/);
		for (const token of [...before, ...getClassTokens(element)]) {
			if (token !== "") {
				keys.push(`.${token}`);
			}
		}
	} else if (name === "id") {
		for (const token of [oldValue, element.getAttribute("id")]) {
			if (token !== null && token !== "") {
				keys.push(`#${token}`);
			}
		}
	}
	for (const key of keys) {
		const properties = cascade[kKeyProperties].get(key);
		if (properties === undefined) {
			continue;
		}
		for (const property of properties) {
			if (!PAINT_ONLY_PROPERTIES.has(property)) {
				return false;
			}
		}
	}
	return true;
}

// The list's padding-left is a function of its items' markers and
// their ordinals. Only the NEAREST list is affected. See
// mutationChangesListItems for why this lives in the cascade.
function invalidateEnclosingList(cascade: Cascade, target: Node): void {
	let element: Element | null =
		target.nodeType ===
		cascade[kWindow].Node.ELEMENT_NODE
			? (target as Element)
			: target.parentElement;

	for (; element; element = element.parentElement) {
		if (element.tagName !== "UL" && element.tagName !== "OL") {
			continue;
		}

		invalidateElementCaches(cascade, element);
		cascade[kLayout].invalidate(element);
		for (const item of Array.from(element.children)) {
			invalidateElementCaches(cascade, item);
		}
		return;
	}
}

// Every style cached against the previous rule set is dropped. A
// declaration built before this parse was resolved against rules that
// no longer describe the cascade, and nothing else would tell it.
function parseStylesheets(cascade: Cascade): void {
	// Materializing a sheet's rules notifies the sheet once per rule, and
	// each notification asked for a parse from inside this one. The parse
	// under way reads those rules itself.
	if (cascade[kParsing]) {
		return;
	}
	cascade[kParsing] = true;
	try {
		parseStylesheetsNow(cascade);
	} finally {
		cascade[kParsing] = false;
	}
}

function parseStylesheetsNow(cascade: Cascade): void {
	const document = cascade[kDocument];
	cascade[kParsedRules] = [];
	cascade[kSharedRoot] = new Map();
	cascade[kSiblingIndexes] = new Map();
	cascade[kReachingClasses].clear();
	cascade[kKeyProperties].clear();
	cascade[kReachingIds].clear();
	cascade[kReachingAttributes].clear();
	cascade[kReachingStates] = false;
	cascade[kDescendantPseudoClasses] = new Map();
	cascade[kClassSubjects] = new Map();
	cascade[kSiblingPseudoClasses] = new Map();
	cascade[kPseudoRulesByType] = new Map();
	cascade[kPseudoSubjectTags] = undefined;
	cascade[kCounterRulesExist] = false;
	cascade[kListItemRulesExist] = false;
	cascade[kScopedRulesExist] = false;
	cascade[kHasRulesExist] = false;
	cascade[kHasAnchors] = new Set();
	cascade[kHasStates] = new Set();
	cascade[kHoverRulesExist] = false;
	cascade[kStylesheetsDirty] = false;
	cascade[kLayerPaths] = [];
	cascade[kAnonymousLayers] = 0;
	cascade[kParsedStyleSheetCount] = getStyleSheetCount(cascade);

	// Origin ordering, not source order, keeps the UA sheet beneath every
	// author rule.
	parseStyleSheet(cascade, getUAStyleSheet(), undefined, true);

	for (const sheet of getDocumentStyleSheets(document)) {
		parseStyleSheet(cascade, sheet);
	}

	// Disconnected roots parse too. attach-populate-connect is the standard
	// order, and a scope-gated rule matches nothing until its tree renders.
	for (const root of cascade[kShadowRoots]) {
		for (const sheet of getShadowStyleSheets(root)) {
			parseStyleSheet(cascade, sheet, root);
		}
	}

	const layerRanks = rankLayers(cascade);
	for (const rule of cascade[kParsedRules]) {
		rule.layerRank = rule.layer === null
			? cascade[kUnlayeredRank]
			: (layerRanks.get(rule.layer) ?? cascade[kUnlayeredRank]);
	}

	sortRulesForCascade(cascade);
	dropCache(cascade);
	// Only now, because invalidated layout re-derives boxes by asking the
	// cascade for display, and the result must come from the rules just
	// parsed.
	cascade[kLayout].invalidate();
	attachPseudoElements(cascade);
}

// Origin first (UA below every author rule, later wins), then layer,
// then specificity, then the order the rules were read in.
function sortRulesForCascade(cascade: Cascade): void {
	const sourceOrder = new Map(
		cascade[kParsedRules].map((rule, index) => [rule, index] as const),
	);
	cascade[kParsedRules].sort((a, b) => {
		if (Boolean(a.uaOrigin) !== Boolean(b.uaOrigin)) {
			return a.uaOrigin ? -1 : 1;
		}
		if (a.layerRank !== b.layerRank) {
			return a.layerRank - b.layerRank;
		}
		if (a.specificity !== b.specificity) {
			return a.specificity < b.specificity ? -1 : 1;
		}
		return sourceOrder.get(a)! - sourceOrder.get(b)!;
	});
}

// Declare a layer and every layer its path nests inside.
function declareLayer(
	cascade: Cascade,
	outer: string | null,
	name: string,
): string {
	const path = outer === null ? name : `${outer}.${name}`;
	const segments = path.split(".");
	for (let depth = 1; depth <= segments.length; depth++) {
		const prefix = segments.slice(0, depth).join(".");
		if (!cascade[kLayerPaths].includes(prefix)) {
			cascade[kLayerPaths].push(prefix);
		}
	}
	return path;
}

// A layer's OWN rules sort after every layer nested inside it, the same
// relation unlayered rules have to layers, one level down. The important
// cascade reads the same order backwards.
function rankLayers(cascade: Cascade): Map<string, number> {
	const nested = new Map<string, string[]>();
	for (const path of cascade[kLayerPaths]) {
		const dot = path.lastIndexOf(".");
		const outer = dot === -1 ? "" : path.slice(0, dot);
		const siblings = nested.get(outer);
		if (siblings) {
			siblings.push(path);
		} else {
			nested.set(outer, [path]);
		}
	}
	const ranks = new Map<string, number>();
	let next = 0;
	const rank = (path: string): void => {
		for (const inner of nested.get(path) ?? []) {
			rank(inner);
		}
		if (path !== "") {
			ranks.set(path, next++);
		}
	};
	rank("");
	cascade[kUnlayeredRank] = next;
	return ranks;
}

const UNCONDITIONAL: CSSValues.RuleContext = {layer: null, scopes: []};

// A disabled sheet and an unmatched @media contribute nothing.
// @supports contributes, since what this engine supports it renders. A
// grouping rule this walk has no branch for is walked THROUGH: a rule
// that applies too widely is one an author can see, and one that
// vanishes with the whole at-rule is not.
function parseStyleSheet(
	cascade: Cascade,
	container: CSSStyleSheet | CSSGroupingRule,
	scope?: Node,
	uaOrigin?: boolean,
	context: CSSValues.RuleContext = UNCONDITIONAL,
): void {
	if (container instanceof CSSStyleSheet) {
		if (container.disabled) {
			return;
		}
		if (!cascade.mediaQueryMatches(container.media.mediaText)) {
			return;
		}
	}
	for (const rule of container.cssRules) {
		if (rule instanceof CSSStyleRule) {
			parseStyleRule(cascade, rule, scope, uaOrigin, context);
		} else if (rule instanceof CSSMediaRule) {
			if (cascade.mediaQueryMatches(rule.conditionText)) {
				parseStyleSheet(cascade, rule, scope, uaOrigin, context);
			}
		} else if (rule instanceof CSSSupportsRule) {
			parseStyleSheet(cascade, rule, scope, uaOrigin, context);
		} else if (rule instanceof CSSLayerStatementRule) {
			// `@layer a, b;` declares layer order and nothing else.
			for (const name of rule.nameList) {
				declareLayer(cascade, context.layer, name);
			}
		} else if (rule instanceof CSSLayerBlockRule) {
			// An unnamed block opens a layer nothing else can name or reach.
			const layer = rule.name
				? declareLayer(cascade, context.layer, rule.name)
				: declareLayer(
					cascade,
					context.layer,
					`\0${cascade[kAnonymousLayers]++}`,
				);
			parseStyleSheet(cascade, rule, scope, uaOrigin, {...context, layer});
		} else if (rule instanceof CSSScopeRule) {
			parseStyleSheet(cascade, rule, scope, uaOrigin, {
				...context,
				scopes: [...context.scopes, readScopeCondition(rule)],
			});
		} else if (rule instanceof CSSStartingStyleRule) {
			// `@starting-style` declares the style a box starts a transition
			// FROM, a moment nothing here gives a rule. A rule inside it would
			// have no moment to stop applying and would style the box
			// permanently, so it never reaches the cascade.
			continue;
		} else if (rule instanceof CSSGroupingRule) {
			parseStyleSheet(cascade, rule, scope, uaOrigin, context);
		}
	}
}

// Media Queries 4 evaluates with three values: true, false and unknown
// (null here). A feature this engine does not know, a value outside a
// feature's grammar, or text in parentheses that is no feature is
// unknown. `not` keeps unknown unknown, and a whole query that comes out
// unknown does not match.
type MediaResult = boolean | null;

// Only `all` and `screen` name this screen, so `print`, `speech` and
// the deprecated types match nothing.
function mediaQueryNodeMatches(
	cascade: Cascade,
	query: CSSTree.MediaQueryNode,
): boolean {
	const type = (query.mediaType ?? "").toLowerCase();
	let result: MediaResult = type === "" || type === "all" || type === "screen";
	if (result && query.condition) {
		result = mediaConditionMatches(cascade, query.condition);
	}
	if (result !== null && (query.modifier ?? "").toLowerCase() === "not") {
		result = !result;
	}
	return result === true;
}

function mediaConditionMatches(
	cascade: Cascade,
	condition: CSSTree.MediaConditionNode,
): MediaResult {
	let result: MediaResult | undefined;
	let disjunction = false;
	let negate = false;
	for (const part of CSSValues.getMediaConditionParts(condition)) {
		if (part.type === "Identifier") {
			const word = (part.name ?? "").toLowerCase();
			if (word === "not") {
				negate = true;
			} else if (word === "and" || word === "or") {
				disjunction = word === "or";
			} else {
				return null;
			}
			continue;
		}
		let operand = mediaOperandMatches(cascade, part);
		if (negate) {
			operand = operand === null ? null : !operand;
			negate = false;
		}
		if (result === undefined) {
			result = operand;
		} else if (disjunction) {
			result = result === true || operand === true
				? true
				: result === null || operand === null ? null : false;
		} else {
			result = result === false || operand === false
				? false
				: result === null || operand === null ? null : true;
		}
	}
	return result === undefined ? null : result;
}

function mediaOperandMatches(
	cascade: Cascade,
	part: CSSTree.MediaConditionNode,
): MediaResult {
	if (part.type === "Condition") {
		return mediaConditionMatches(cascade, part);
	}
	if (part.type === "Feature") {
		return mediaFeatureMatches(cascade, part);
	}
	if (part.type === "FeatureRange") {
		return mediaFeatureRangeMatches(cascade, part);
	}
	return null;
}

type MediaRangeKind = "length" | "height" | "ratio" | "resolution" | "integer";

// The terminal's, for a document a TermDOM draws.
function getColorScheme(
	document: globalThis.Document | null,
): "light" | "dark" {
	return getDocumentExchange(document)?.colorScheme ?? "light";
}

// What a range feature measures on this terminal. Its px are cells.
const MEDIA_RANGE_FEATURES: Record<
	string,
	{kind: MediaRangeKind; value(window: Window): number}
> = {
	width: {kind: "length", value: (window) => window.innerWidth},
	height: {kind: "height", value: (window) => window.innerHeight},
	"device-width": {kind: "length", value: (window) => window.screen.width},
	"device-height": {kind: "height", value: (window) => window.screen.height},
	"aspect-ratio": {
		kind: "ratio",
		value: (window) => window.innerWidth / window.innerHeight,
	},
	"device-aspect-ratio": {
		kind: "ratio",
		value: (window) => window.screen.width / window.screen.height,
	},
	resolution: {kind: "resolution", value: (window) => window.devicePixelRatio},
	// A palette's entries are full RGB, so an indexed terminal still has 8
	// bits a component; what tells it apart is the size of its index.
	color: {kind: "integer", value: () => 8},
	"color-index": {
		kind: "integer",
		value: (window) =>
			window.screen.colorDepth === 24 ? 0 : 2 ** window.screen.colorDepth,
	},
	monochrome: {kind: "integer", value: () => 0},
};

// What a discrete feature is on this terminal, among the values its
// grammar allows. `falsy` is the value the boolean context reads as
// false. A terminal reports the pointer it has, and no preference a
// person has not given it.
const MEDIA_DISCRETE_FEATURES: Record<
	string,
	{values: readonly string[]; falsy?: string; value(window: Window): string}
> = {
	orientation: {
		values: ["portrait", "landscape"],
		value: (window) =>
			window.innerHeight >= window.innerWidth ? "portrait" : "landscape",
	},
	hover: {values: ["none", "hover"], falsy: "none", value: () => "hover"},
	"any-hover": {values: ["none", "hover"], falsy: "none", value: () => "hover"},
	pointer: {
		values: ["none", "coarse", "fine"],
		falsy: "none",
		value: () => "fine",
	},
	"any-pointer": {
		values: ["none", "coarse", "fine"],
		falsy: "none",
		value: () => "fine",
	},
	scan: {values: ["interlace", "progressive"], value: () => "progressive"},
	update: {
		values: ["none", "slow", "fast"],
		falsy: "none",
		value: () => "fast",
	},
	"overflow-block": {
		values: ["none", "scroll", "paged"],
		falsy: "none",
		value: () => "scroll",
	},
	"overflow-inline": {
		values: ["none", "scroll"],
		falsy: "none",
		value: () => "scroll",
	},
	// Only true color reaches sRGB; a palette of 256 or 16 matches none.
	"color-gamut": {
		values: ["srgb", "p3", "rec2020"],
		falsy: "",
		value: (window) => window.screen.colorDepth === 24 ? "srgb" : "",
	},
	"dynamic-range": {values: ["standard", "high"], value: () => "standard"},
	"video-dynamic-range": {
		values: ["standard", "high"],
		value: () => "standard",
	},
	"display-mode": {
		values: [
			"browser",
			"fullscreen",
			"standalone",
			"minimal-ui",
			"picture-in-picture",
		],
		value: () => "browser",
	},
	scripting: {
		values: ["none", "initial-only", "enabled"],
		falsy: "none",
		value: () => "enabled",
	},
	"forced-colors": {
		values: ["none", "active"],
		falsy: "none",
		value: () => "none",
	},
	"inverted-colors": {
		values: ["none", "inverted"],
		falsy: "none",
		value: () => "none",
	},
	// Light unless the terminal's background is dark, which a person
	// chose when they chose it.
	"prefers-color-scheme": {
		values: ["light", "dark"],
		value: (window) => getColorScheme(window.document),
	},
	"prefers-contrast": {
		values: ["no-preference", "more", "less", "custom"],
		falsy: "no-preference",
		value: () => "no-preference",
	},
	"prefers-reduced-motion": {
		values: ["no-preference", "reduce"],
		falsy: "no-preference",
		value: () => "no-preference",
	},
	"prefers-reduced-transparency": {
		values: ["no-preference", "reduce"],
		falsy: "no-preference",
		value: () => "no-preference",
	},
	"prefers-reduced-data": {
		values: ["no-preference", "reduce"],
		falsy: "no-preference",
		value: () => "no-preference",
	},
};

// `em` and `rem` in a media query are the initial font size, one cell
// tall.
function getMediaLength(
	cascade: Cascade,
	node: CSSTree.ValueNode,
	vertical: boolean,
): number | null {
	if (node.type === "Number") {
		return parseFloat(node.value ?? "") === 0 ? 0 : null;
	}
	if (node.type !== "Dimension" && node.type !== "Function") {
		return null;
	}
	const window = cascade[kWindow];
	const cell = getCellSize(cascade[kDocument]);
	const text = CSSValues.absolutizeLengths(
		CSSTree.generate(node as unknown as CSSTree.CSSTreeNode),
		{
			font: cell.height,
			root: cell.height,
			cellWidth: cell.width,
			cellAlong: vertical ? cell.height : cell.width,
			line: cell.height,
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
			percent: null,
		},
	);
	const match = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px$/i.exec(text);
	return match ? parseFloat(match[1]) : null;
}

function getMediaValue(
	cascade: Cascade,
	kind: MediaRangeKind,
	node: CSSTree.ValueNode | null | undefined,
): number | null {
	if (!node) {
		return null;
	}
	switch (kind) {
		case "length":
			return getMediaLength(cascade, node, false);
		case "height":
			return getMediaLength(cascade, node, true);
		case "integer":
			return node.type === "Number" && /^[+-]?\d+$/.test(node.value ?? "")
				? parseInt(node.value ?? "", 10)
				: null;
		case "ratio": {
			if (node.type === "Number") {
				const value = parseFloat(node.value ?? "");
				return value >= 0 ? value : null;
			}
			if (
				node.type !== "Ratio" ||
				node.left?.type !== "Number" ||
				(node.right && node.right.type !== "Number")
			) {
				return null;
			}
			const left = parseFloat(node.left.value ?? "");
			const right = node.right ? parseFloat(node.right.value ?? "") : 1;
			if (!(left >= 0 && right >= 0)) {
				return null;
			}
			// A degenerate ratio, 0/0, equals nothing.
			return left === 0 && right === 0 ? NaN : left / right;
		}
		case "resolution": {
			const value = parseFloat(node.value ?? "");
			if (node.type !== "Dimension" || !(value >= 0)) {
				return null;
			}
			switch ((node.unit ?? "").toLowerCase()) {
				case "dppx":
				case "x":
					return value;
				case "dpi":
					return value / 96;
				case "dpcm":
					return (value * 2.54) / 96;
				default:
					return null;
			}
		}
	}
}

function compareMedia(
	left: number,
	comparison: string | null | undefined,
	right: number,
): boolean {
	switch (comparison) {
		case "<":
			return left < right;
		case "<=":
			return left <= right;
		case ">":
			return left > right;
		case ">=":
			return left >= right;
		default:
			return left === right;
	}
}

function mediaFeatureMatches(
	cascade: Cascade,
	feature: CSSTree.MediaConditionNode,
): MediaResult {
	const window = cascade[kWindow];
	const name = (feature.name ?? "").toLowerCase();
	const value = feature.value ?? null;
	const discrete = MEDIA_DISCRETE_FEATURES[name];
	if (discrete) {
		const actual = discrete.value(window);
		if (value === null) {
			return actual !== discrete.falsy;
		}
		const wanted = value.type === "Identifier"
			? (value.name ?? "").toLowerCase()
			: "";
		return discrete.values.includes(wanted) ? wanted === actual : null;
	}
	// A terminal draws on a cell grid, but its px are those cells, so it
	// is the bitmap device the rest of CSS already measures.
	if (name === "grid") {
		if (value === null) {
			return false;
		}
		return value.type === "Number" && /^[01]$/.test(value.value ?? "")
			? value.value === "0"
			: null;
	}
	const bound = name.startsWith("min-")
		? ">="
		: name.startsWith("max-") ? "<=" : null;
	const range = MEDIA_RANGE_FEATURES[bound === null ? name : name.slice(4)];
	if (!range || (bound !== null && value === null)) {
		return null;
	}
	const actual = range.value(window);
	if (value === null) {
		return actual !== 0;
	}
	const wanted = getMediaValue(cascade, range.kind, value);
	return wanted === null ? null : compareMedia(actual, bound, wanted);
}

// The feature name is in the middle of a two-sided range, and on either
// side of the value in a one-sided one.
function mediaFeatureRangeMatches(
	cascade: Cascade,
	range: CSSTree.MediaConditionNode,
): MediaResult {
	const named = (node: CSSTree.ValueNode | null | undefined): string =>
		node?.type === "Identifier" ? (node.name ?? "").toLowerCase() : "";
	const window = cascade[kWindow];
	if (range.right) {
		const feature = MEDIA_RANGE_FEATURES[named(range.middle)];
		if (!feature) {
			return null;
		}
		const low = getMediaValue(cascade, feature.kind, range.left);
		const high = getMediaValue(cascade, feature.kind, range.right);
		if (low === null || high === null) {
			return null;
		}
		const actual = feature.value(window);
		return (
			compareMedia(low, range.leftComparison, actual) &&
			compareMedia(actual, range.rightComparison, high)
		);
	}
	const leftName = named(range.left);
	const feature = MEDIA_RANGE_FEATURES[leftName || named(range.middle)];
	if (!feature) {
		return null;
	}
	const wanted = getMediaValue(
		cascade,
		feature.kind,
		leftName ? range.middle : range.left,
	);
	if (wanted === null) {
		return null;
	}
	const actual = feature.value(window);
	return leftName
		? compareMedia(actual, range.leftComparison, wanted)
		: compareMedia(wanted, range.leftComparison, actual);
}

function readScopeCondition(rule: CSSScopeRule): CSSValues.ScopeCondition {
	const namespaces = getSheetNamespaces(rule.parentStyleSheet);
	const start = rule.start;
	const owner = rule.parentStyleSheet?.ownerNode ?? null;
	return {
		roots: start === null
			? null
			: CSSValues.compileSelectors(start, {namespaces}),
		rootsInOuter: start === null
			? []
			: CSSValues.compileSelectors(start, {namespaces, relative: true}),
		limits: rule.end
			? CSSValues.compileSelectors(rule.end, {namespaces, relative: true})
			: [],
		owner: owner ? owner.parentElement : null,
	};
}

// `parent` is the selector list of the rule this one is nested in, which
// its own selectors are resolved against.
function parseStyleRule(
	cascade: Cascade,
	styleRule: CSSStyleRule,
	scope?: Node,
	uaOriginSheet?: boolean,
	context: CSSValues.RuleContext = UNCONDITIONAL,
	parent: string | null = null,
): void {
	// Each selector of the list is matched and weighed on its own.
	// `#a::before, #b` is one pseudo rule and one ordinary rule.
	const block = getDeclarationBlock(styleRule.style);
	const namespaces = getSheetNamespaces(styleRule.parentStyleSheet);
	const selectors = CSSValues.splitSelectorList(styleRule.selectorText)
		.map((selector) =>
			parent === null
				? selector
				: CSSValues.resolveNestedSelector(selector, parent),
		);
	for (const selector of selectors) {
		parseSelector(
			cascade,
			selector,
			block,
			scope,
			uaOriginSheet,
			namespaces,
			context,
		);
	}
	parseNestedRules(
		cascade,
		styleRule,
		selectors.join(", "),
		scope,
		uaOriginSheet,
		context,
	);
}

// The rules nested in a style rule, and in the conditional rules nested
// in it, resolved against the style rule's selectors.
function parseNestedRules(
	cascade: Cascade,
	container: CSSGroupingRule,
	parent: string,
	scope: Node | undefined,
	uaOriginSheet: boolean | undefined,
	context: CSSValues.RuleContext,
): void {
	for (const rule of container.cssRules) {
		if (rule instanceof CSSNestedDeclarations) {
			const block = getDeclarationBlock(rule.style);
			const namespaces = getSheetNamespaces(rule.parentStyleSheet);
			for (const selector of CSSValues.splitSelectorList(parent)) {
				parseSelector(
					cascade,
					selector,
					block,
					scope,
					uaOriginSheet,
					namespaces,
					context,
				);
			}
		} else if (rule instanceof CSSStyleRule) {
			parseStyleRule(cascade, rule, scope, uaOriginSheet, context, parent);
		} else if (rule instanceof CSSMediaRule) {
			if (cascade.mediaQueryMatches(rule.conditionText)) {
				parseNestedRules(cascade, rule, parent, scope, uaOriginSheet, context);
			}
		} else if (rule instanceof CSSSupportsRule) {
			parseNestedRules(cascade, rule, parent, scope, uaOriginSheet, context);
		} else if (rule instanceof CSSLayerBlockRule) {
			const layer = rule.name
				? declareLayer(cascade, context.layer, rule.name)
				: declareLayer(
					cascade,
					context.layer,
					`\0${cascade[kAnonymousLayers]++}`,
				);
			parseNestedRules(cascade, rule, parent, scope, uaOriginSheet, {
				...context,
				layer,
			});
		}
	}
}

// The element a compound's state is tested on, as far as its keys tell:
// it has every key the compound names outside an argument. A compound
// whose arguments hold combinators describes other elements too, and could
// be anyone. :host tests only a shadow host, and :host-context the
// ancestors of one.
interface StateAnchor {
	anyElement: boolean;
	host: boolean;
	// Whether the element's children restyle with it, as a display change
	// blockifies them.
	children?: boolean;
	tag: string | null;
	classes: string[];
	ids: string[];
	attributes: string[];
}

function getStateAnchor(
	keys: CSSValues.SelectorReading["compounds"][number],
): StateAnchor {
	return {
		anyElement:
			keys.nestedCombinator || keys.pseudoClasses.includes("host-context"),
		host: keys.pseudoClasses.includes("host"),
		...keys.required,
	};
}

function addStateAnchor(
	anchors: Map<string, StateAnchor[]>,
	name: string,
	anchor: StateAnchor,
): void {
	const list = anchors.get(name);
	if (list === undefined) {
		anchors.set(name, [anchor]);
	} else {
		list.push(anchor);
	}
}

function couldAnchor(element: Element, anchor: StateAnchor): boolean {
	if (anchor.anyElement) {
		return true;
	}
	if (anchor.host && getShadowRoot(element) === null) {
		return false;
	}
	return (
		(anchor.tag === null || anchor.tag === element.localName) &&
		anchor.classes.every((name) => getClassTokens(element).has(name)) &&
		anchor.ids.every((id) => element.id === id) &&
		anchor.attributes.every((name) => element.hasAttribute(name))
	);
}

// A key reaches descendants two ways: tested on a NON-SUBJECT compound,
// or on a rule declaring an INHERITED property. In neither position, it
// changes nothing but the element's own box.
function indexReachingKeys(
	cascade: Cascade,
	selector: string,
	reading: CSSValues.SelectorReading,
	declarations: Record<string, string>,
	scope: Node | undefined,
): void {
	let inherits = false;
	let blockifies = false;
	for (const property in declarations) {
		// `display` is not inherited but reaches descendants anyway. A flex
		// container isBlockified its children (css-display-3 §2.7).
		if (property === "display") {
			blockifies = true;
		} else if (property === "all" || CSSValues.isInheritedProperty(property)) {
			inherits = true;
		}
	}
	const subjectInherits = inherits;
	inherits ||= blockifies;
	const compounds = reading.compounds;
	if (reading.reachesSiblings) {
		const index = getOrCreateSiblingIndex(cascade, scope);
		index.reachesSiblings = true;
		if (reading.siblingsReachDescendants || inherits) {
			index.reachesDescendants = true;
		}
		if (/:nth-[a-z-]*\([^)]*\bof\b/i.test(selector)) {
			index.anchorsUniversal = true;
		}
		for (const keys of compounds) {
			if (!keys.precedesSibling) {
				continue;
			}
			if (keys.anyElement || keys.pseudoClasses.length > 0 || keys.states) {
				index.anchorsUniversal = true;
			}
			for (const key of [
				...keys.classes.map((name) => `.${name}`),
				...keys.ids.map((name) => `#${name}`),
				...keys.attributes.map((name) => `[${name}]`),
			]) {
				index.anchorKeys.add(key);
			}
		}
	}
	for (const keys of compounds) {
		if (!keys.siblingTested) {
			continue;
		}
		const index = getOrCreateSiblingIndex(cascade, scope);
		if (
			keys.anyElement ||
			(keys.tag === null &&
				keys.classes.length === 0 &&
				keys.ids.length === 0 &&
				keys.attributes.length === 0)
		) {
			index.universal = true;
		}
		if (keys.tag !== null) {
			index.keys.add(keys.tag);
		}
		for (const key of [
			...keys.classes.map((name) => `.${name}`),
			...keys.ids.map((name) => `#${name}`),
			...keys.attributes.map((name) => `[${name}]`),
		]) {
			index.keys.add(key);
		}
	}
	const names = Object.keys(declarations);
	for (const keys of compounds) {
		for (const key of [
			...keys.classes.map((name) => `.${name}`),
			...keys.ids.map((name) => `#${name}`),
			...keys.attributes.map((name) => `[${name}]`),
		]) {
			let properties = cascade[kKeyProperties].get(key);
			if (properties === undefined) {
				properties = new Set<string>();
				cascade[kKeyProperties].set(key, properties);
			}
			for (const name of names) {
				properties.add(name);
			}
		}
	}
	const last = inherits ? compounds.length : compounds.length - 1;
	for (const [i, keys] of compounds.entries()) {
		// A compound with a combinator inside an argument describes other
		// elements too, so what it tests can reach anywhere, from anyone.
		const nested = keys.nestedCombinator;
		const anchor = getStateAnchor(keys);
		for (const name of keys.pseudoClasses) {
			if (i < last || nested) {
				addStateAnchor(cascade[kDescendantPseudoClasses], name, anchor);
			}
			if (keys.precedesSibling || nested) {
				addStateAnchor(cascade[kSiblingPseudoClasses], name, anchor);
			}
		}
	}
	const subject = compounds.length === 0
		? null
		: getStateAnchor(compounds[compounds.length - 1]);
	const reach = subjectInherits || subject === null || subject.anyElement
		? null
		: {...subject, children: blockifies};
	for (let i = 0; i < last; i++) {
		const keys = compounds[i];
		for (const name of keys.classes) {
			cascade[kReachingClasses].add(name);
			const subjects = cascade[kClassSubjects].get(name);
			if (reach === null || subjects === null) {
				cascade[kClassSubjects].set(name, null);
			} else if (subjects === undefined) {
				cascade[kClassSubjects].set(name, [reach]);
			} else {
				subjects.push(reach);
			}
		}
		for (const name of keys.ids) {
			cascade[kReachingIds].add(name);
		}
		for (const name of keys.attributes) {
			cascade[kReachingAttributes].add(name);
		}
		if (keys.states) {
			cascade[kReachingStates] = true;
		}
	}
}

// A selector this engine cannot read compiles to neither reading, and
// the rule styles nothing.
function compileRuleSelector(
	selector: string,
	namespaces: SelectorNamespaces | undefined,
	scopes: readonly CSSValues.ScopeCondition[] | undefined,
	pseudoElements = false,
): Pick<ParsedCSSRule, "matcher" | "relativeMatcher"> {
	const read = (relative: boolean): CompiledSelector | null => {
		try {
			return compileSelector(selector, {namespaces, relative, pseudoElements});
		} catch (_err) {
			// Only the shape of a sheet's selector was checked when the rule
			// was parsed. A prefix no `@namespace` declared is rejected here.
			return null;
		}
	};
	return {matcher: read(false), relativeMatcher: scopes ? read(true) : null};
}

function parseSelector(
	cascade: Cascade,
	selector: string,
	block: CSSValues.DeclarationBlock,
	scope?: Node,
	uaOriginSheet?: boolean,
	namespaces?: SelectorNamespaces,
	context: CSSValues.RuleContext = UNCONDITIONAL,
): void {
	const {declarations, important, order} = block;
	// Only a duration or delay can make a transition run, so the property
	// list alone does not open the sticky gate.
	if (declarations["transition-duration"] || declarations["transition-delay"]) {
		cascade[kTransitionsExist] = true;
	}
	const layer = context.layer;
	// A :has() rule reads DOWN the tree, the one relational direction the
	// per-target invalidation cannot see, so the flag enables the ancestor
	// sweep only for documents that need it.
	let hasAnchors: string[] | undefined;
	let hasStates: string[] | undefined;
	if (selector.includes(":has(")) {
		hasAnchors = getHasAnchors(selector);
		const inside = selector.slice(selector.indexOf(":has(") + 5);
		hasStates = Array.from(inside.matchAll(/:([a-zA-Z-]+)/g), (match) =>
			match[1].toLowerCase(),
		);
		noteHasRule(cascade, hasAnchors, hasStates);
	}
	if (selector.includes(":hover")) {
		cascade[kHoverRulesExist] = true;
	}
	let scopes: readonly CSSValues.ScopeCondition[] | undefined;
	if (context.scopes.length > 0) {
		scopes = context.scopes;
		cascade[kScopedRulesExist] = true;
	}
	if (
		selector.includes("|") &&
		!CSSValues.namespacePrefixesDeclared(selector, namespaces)
	) {
		return;
	}
	const reading = CSSValues.readSelector(selector);
	indexReachingKeys(cascade, selector, reading, declarations, scope);
	if (
		declarations["counter-reset"] ||
		declarations["counter-increment"] ||
		declarations["content"]?.includes("counter")
	) {
		cascade[kCounterRulesExist] = true;
	}
	const specificity = reading.specificity;
	const uaOrigin = Boolean(
		uaOriginSheet || (scope != null && isUAShadowTree(scope)),
	);
	// The UA sheet's own `li { display: list-item }` is covered by the tag
	// tests that read this flag. Set by the UA sheet too, the flag was
	// always on, and every element paid for a ::marker it could not have.
	if (!uaOrigin && declarations["display"] === "list-item") {
		cascade[kListItemRulesExist] = true;
	}

	const subjectTag = reading.subjectTag;
	const required = reading.compounds.at(-1)?.required;
	const subjectKey = required === undefined
		? undefined
		: required.ids.length > 0
			? `#${required.ids[0]}`
			: required.classes.length > 0 ? `.${required.classes[0]}` : undefined;
	// A :host rule is tried against the host as well as the tree's
	// elements.
	const reachesHost = scope !== undefined && selector.includes(":host");

	// Any pseudo-element, not just the ones this engine gives a box. A rule
	// for `::highlight(x)` still has to be visible through
	// getComputedStyle.
	const pseudoMatch = selector.match(
		/^(.*?)(::[-\w]+(?:\([^)]*\))?)((?::[-\w]+(?:\([^)]*\))?)*)$/,
	);

	if (pseudoMatch) {
		const [, baseSelector, , trailing] = pseudoMatch;
		const pseudoElement = unescapeHighlightName(pseudoMatch[2]);
		let partMatcher: CompiledSelector | null | undefined;
		if (trailing && pseudoElement.startsWith("::part(")) {
			try {
				partMatcher = compileSelector(`*${trailing}`, {namespaces});
			} catch (_err) {
				partMatcher = null;
			}
		}
		const ofPart = baseSelector.includes("::part(");
		const rule: ParsedCSSRule = {
			// A pseudo-element written with no originating selector originates
			// on every element, which is what `*` means.
			...compileRuleSelector(
				baseSelector.trim() || "*",
				namespaces,
				scopes,
				ofPart,
			),
			subjectTag: ofPart ? undefined : reading.subjectTag,
			ofPart,
			declarations,
			important,
			order,
			specificity,
			pseudoElement,
			partMatcher,
			scope,
			uaOrigin,
			reachesHost,
			hasAnchors,
			hasStates,
			layer,
			layerRank: 0,
			scopes,
		};
		cascade[kParsedRules].push(rule);
		const byType = cascade[kPseudoRulesByType].get(pseudoElement);
		if (byType) {
			byType.push(rule);
		} else {
			cascade[kPseudoRulesByType].set(pseudoElement, [rule]);
		}
	} else {
		cascade[kParsedRules].push({
			...compileRuleSelector(selector, namespaces, scopes),
			subjectTag,
			subjectKey,
			declarations,
			important,
			order,
			specificity,
			scope,
			uaOrigin,
			reachesHost,
			hasAnchors,
			hasStates,
			layer,
			layerRank: 0,
			scopes,
		});
	}
}

// Farther from any element than any scoping root can be.
const UNSCOPED = Number.MAX_SAFE_INTEGER;

// The parsed rules filed by the id or class their rightmost compound
// requires, as a browser's rule set files them, so an element tries only
// the rules that could match it. Rebuilt when the rule list changes.
interface RuleIndex {
	rules: ParsedCSSRule[];
	length: number;
	keyed: Map<string, number[]>;
	unkeyed: ParsedCSSRule[];
	unkeyedPositions: number[];
	// Candidates by the id and classes that chose them, since elements
	// alike in both, like an editor's lines, try the same rules.
	candidates: Map<string, ParsedCSSRule[]>;
}

const MAX_CANDIDATE_LISTS = 4096;

function getRuleIndex(cascade: Cascade): RuleIndex {
	const rules = cascade[kParsedRules];
	let index = ruleIndexes.get(cascade);
	if (
		index !== undefined &&
		index.rules === rules &&
		index.length === rules.length
	) {
		return index;
	}
	index = {
		rules,
		length: rules.length,
		keyed: new Map(),
		unkeyed: [],
		unkeyedPositions: [],
		candidates: new Map(),
	};
	for (const [position, rule] of rules.entries()) {
		// A pseudo-element's rule matches through its host, and a :host rule
		// through the tree's host, so neither is filed under the element.
		if (
			rule.subjectKey === undefined || rule.pseudoElement || rule.reachesHost
		) {
			index.unkeyed.push(rule);
			index.unkeyedPositions.push(position);
			continue;
		}
		const bucket = index.keyed.get(rule.subjectKey);
		if (bucket === undefined) {
			index.keyed.set(rule.subjectKey, [position]);
		} else {
			bucket.push(position);
		}
	}
	ruleIndexes.set(cascade, index);
	return index;
}

function getIdValue(element: Element): string | null {
	for (const attribute of getAttributeList(element)) {
		if (attribute.localName === "id" && attribute.namespaceURI === null) {
			return attribute.value;
		}
	}
	return null;
}

// The rules an element could match, in the order they were parsed, which
// the cascade's order of appearance relies on. A quirks-mode document
// matches ids and classes without regard to case, so it tries them all.
function getCandidateRules(
	cascade: Cascade,
	element: Element,
): ParsedCSSRule[] {
	if (element.ownerDocument?.compatMode === "BackCompat") {
		return cascade[kParsedRules];
	}
	const index = getRuleIndex(cascade);
	const id = getIdValue(element);
	const classes = getClassTokens(element);
	if (id === null && classes.size === 0) {
		return index.unkeyed;
	}
	let key = id === null ? "" : `#${id}`;
	for (const name of classes) {
		key += ` .${name}`;
	}
	let candidates = index.candidates.get(key);
	if (candidates !== undefined) {
		return candidates;
	}
	const positions = new Set(index.unkeyedPositions);
	if (id !== null) {
		for (const position of index.keyed.get(`#${id}`) ?? []) {
			positions.add(position);
		}
	}
	for (const name of classes) {
		for (const position of index.keyed.get(`.${name}`) ?? []) {
			positions.add(position);
		}
	}
	candidates = Array.from(
		Int32Array.from(positions).sort(),
		(position) => index.rules[position],
	);
	if (index.candidates.size < MAX_CANDIDATE_LISTS) {
		index.candidates.set(key, candidates);
	}
	return candidates;
}

function getMatchingRules(cascade: Cascade, element: Element): ParsedCSSRule[] {
	// A UA shadow part IS the element its part pseudo styles. The host's
	// ::placeholder rules cascade onto the [part="placeholder"] span.
	const root = element.getRootNode();
	const partPseudos = getPartPseudos(element, root as unknown as Node);
	const rootNode = root as unknown as Node;
	const shadowHost = isShadowRoot(root) ? root.host : null;
	const partNames = (element.getAttribute("part") ?? "")
		.split(/\s+/)
		.filter(Boolean);
	const matched = getCandidateRules(cascade, element).filter((rule) => {
		if (rule.pseudoElement) {
			// ::part(name) matches the shadow's HOST, and its declarations
			// cascade onto the part element. This is the standard CSS Shadow
			// Parts crossing. A built-in control's parts are the UA's, as in
			// every browser, and a page reaches them only through the
			// pseudo-elements above.
			const partArg = rule.pseudoElement.match(/^::part\((.+)\)$/);
			if (partArg) {
				return (
					shadowHost !== null &&
					(rule.uaOrigin || !isUAShadowTree(root)) &&
					splitOnASCIIWhitespace(partArg[1])
						.every((name) => partNames.includes(name)) &&
					isRuleMatch(shadowHost, rule) &&
					(rule.partMatcher === undefined ||
						(rule.partMatcher !== null &&
							isSelectedBy(element, rule.partMatcher, element)))
				);
			}
			return (
				shadowHost !== null &&
				partPseudos.includes(rule.pseudoElement) &&
				isRuleMatch(shadowHost, rule)
			);
		}
		return isRuleMatch(element, rule, rootNode);
	});
	// Scope proximity sorts between specificity and order of appearance
	// (css-cascade-6 §3.1.3), and unlike either it depends on THIS element.
	// The sort is stable, so a comparison that only compares proximity
	// leaves every other tier as it was.
	if (!cascade[kScopedRulesExist]) {
		return matched;
	}
	const proximity = new Map(
		matched.map(
			(rule) =>
				[
					rule,
					rule.scopes ? getScopeProximity(element, rule) : UNSCOPED,
				] as const,
		),
	);
	return matched.sort((a, b) => {
		if (Boolean(a.uaOrigin) !== Boolean(b.uaOrigin)) {
			return 0;
		}
		if (a.layerRank !== b.layerRank) {
			return 0;
		}
		if (a.specificity !== b.specificity) {
			return 0;
		}
		return proximity.get(b)! - proximity.get(a)!;
	});
}

function ruleSelectorMatches(
	element: Element,
	rule: ParsedCSSRule,
	root?: Element,
): boolean {
	// From a scoping root, use the relative reading. Anywhere else, the
	// plain one.
	const matcher = root === undefined ? rule.matcher : rule.relativeMatcher;
	if (matcher === null) {
		return false;
	}
	return isSelectedBy(element, matcher, root ?? element, ruleShadow(rule));
}

function selectForRule(root: Node, rule: ParsedCSSRule): Element[] {
	if (rule.matcher === null) {
		return [];
	}
	return selectAllCompiled(root as unknown as DOMNode, rule.matcher, {
		scope: root as unknown as DOMNode,
		shadow: ruleShadow(rule) as DOMNode | null,
	}) as unknown as Element[];
}

function ruleShadow(rule: ParsedCSSRule): Node | null {
	return (rule.reachesHost ? rule.scope : null) ?? null;
}

function matchesRule(element: Element, rule: ParsedCSSRule): boolean {
	if (!rule.scopes) {
		return ruleSelectorMatches(element, rule);
	}
	return getScopingRoot(element, rule) !== null;
}

// Only called for a rule that matches. One out of scope everywhere has
// already been filtered out.
function getScopeProximity(element: Element, rule: ParsedCSSRule): number {
	const root = getScopingRoot(element, rule);
	if (!root) {
		return UNSCOPED;
	}
	let generations = 0;
	for (
		let node: Element | null = element;
		node && node !== root;
		node = node.parentElement
	) {
		generations++;
	}
	return generations;
}

// Read outermost first, each condition taking the HIGHEST root it can
// (which constrains the roots inside it least). The innermost takes the
// NEAREST, which the selector and proximity are measured from.
function getScopingRoot(element: Element, rule: ParsedCSSRule): Element | null {
	const conditions = rule.scopes!;
	let outer: Element | null = null;
	for (let index = 0; index < conditions.length; index++) {
		const condition = conditions[index];
		const innermost = index === conditions.length - 1;
		let found: Element | null = null;
		for (
			let candidate: Element | null = element;
			candidate;
			candidate = candidate.parentElement
		) {
			if (outer && candidate !== outer && !outer.contains(candidate)) {
				break;
			}
			if (!isScopeRootMatch(candidate, condition, outer)) {
				continue;
			}
			if (!isInScope(element, candidate, condition)) {
				continue;
			}
			if (innermost) {
				if (!ruleSelectorMatches(element, rule, candidate)) {
					continue;
				}
				// The nearest root the rule reaches the element from.
				found = candidate;
				break;
			}
			found = candidate;
		}
		if (!found) {
			return null;
		}
		outer = found;
	}
	return outer;
}

function getPartPseudos(element: Element, root: Node): string[] {
	if (!isUAShadowTree(root)) {
		return [];
	}
	const part = element.getAttribute("part");
	if (part === null) {
		return [];
	}
	const host = (root as unknown as ShadowRoot).host.tagName;
	const pseudos: string[] = [];
	for (const name of part.split(/\s+/)) {
		const pseudo = PART_PSEUDOS["*"][name] ?? PART_PSEUDOS[host]?.[name];
		if (pseudo !== undefined) {
			pseudos.push(pseudo);
		}
	}
	return pseudos;
}

// A rule matches only elements of the tree its stylesheet belongs to,
// plus the one deliberate crossing: :host.
function isRuleMatch(
	element: Element,
	rule: ParsedCSSRule,
	elementRoot?: Node,
): boolean {
	// The cheapest rejections come first. One identity check rejects a
	// UA shadow tree's whole sheet for every element outside it.
	const root = elementRoot ?? element.getRootNode();
	if (rule.scope !== undefined && rule.scope !== root) {
		// A :host rule's subject is outside the tree it was written in.
		if (!rule.reachesHost || element !== (rule.scope as ShadowRoot).host) {
			return false;
		}
	} else if (rule.subjectTag !== undefined && !rule.reachesHost) {
		const local = element.localName;
		// A foreign element's local name keeps its case (feGaussianBlur), so
		// the rejection fires only when neither reading matches. The matcher
		// decides the case sensitivity a selector really has.
		if (local !== rule.subjectTag && local.toLowerCase() !== rule.subjectTag) {
			return false;
		}
	}
	if (rule.scope) {
		return matchesRule(element, rule);
	}
	// The selector itself checks the host the part belongs to. A built-in
	// control's parts are the UA's alone.
	if (rule.ofPart) {
		return (rule.uaOrigin || !isUAShadowTree(root)) &&
			matchesRule(element, rule);
	}
	// UA document rules apply in EVERY tree scope, as a browser's own UA
	// sheet styles shadow trees.
	if (rule.uaOrigin) {
		return matchesRule(element, rule);
	}
	// Author document rules match everything outside shadow trees,
	// detached elements included, because styles resolve before insertion.
	return !isShadowRoot(root) && matchesRule(element, rule);
}

function computePseudoElementStyle(
	cascade: Cascade,
	element: Element,
	pseudoElement: string,
): Record<string, string> {
	const pseudoRoot = element.getRootNode() as unknown as Node;
	const matchingRules = cascade[kParsedRules].filter((rule) => {
		if (rule.pseudoElement !== pseudoElement) {
			return false;
		}
		return isRuleMatch(element, rule, pseudoRoot);
	});

	// A pseudo-element's declarations are a flat record, not a per-property
	// cascade, so a flow-relative declaration fills BOTH names of its slot
	// as it lands, and a later rule declaring either name overwrites in
	// turn.
	const computedStyle: Record<string, string> = {};
	let direction: string | null = null;
	for (const rule of matchingRules) {
		const names = Object.keys(rule.declarations)
			.sort((a, b) => (rule.order[a] ?? 0) - (rule.order[b] ?? 0));
		for (const name of names) {
			const value = rule.declarations[name];
			computedStyle[name] = value;
			if (!CSSValues.hasSlotAliases(name)) {
				continue;
			}
			direction ??=
				cascade.declarationFor(element)[kComputedValue]("direction");
			for (const other of CSSValues.getSlotNames(name, direction)) {
				computedStyle[other] = value;
			}
		}
	}

	return computedStyle;
}

function getPseudoContent(
	cascade: Cascade,
	hostElement: Element,
	pseudoType: string,
): string | null {
	const styles = computePseudoElementStyle(cascade, hostElement, pseudoType);
	let content = styles.content;

	if (pseudoType === "::marker") {
		const computedStyle = cascade.declarationFor(hostElement);
		const display = computedStyle[kComputedValue]("display");

		if (display === "list-item") {
			const listStylePosition =
				computedStyle[kComputedValue]("list-style-position") || "outside";

			if (listStylePosition === "outside") {
				return null;
			}

			if (!content || content === "none" || content === "normal") {
				content = getDefaultMarkerContent(hostElement) ?? content;
			}
		}
	}

	if (!content || content === "none" || content === "normal") {
		return null;
	}

	const textContent = CSSValues.unquoteContent(content);

	return resolveCounterFunction(cascade, hostElement, textContent);
}

function attachPseudoElements(cascade: Cascade): void {
	// Preserve identity, never clear wholesale. Layout keys a
	// pseudo-element's boxes by node instance, and a fresh node per sync
	// orphans every mapped one.
	if (!cascade[kDocument].documentElement) {
		return;
	}
	for (const element of [...cascade[kPseudoHosts]]) {
		if (element.isConnected && pseudoElementCount(element) > 0) {
			attachPseudoElementsToElement(cascade, element);
		} else {
			cascade[kPseudoHosts].delete(element);
		}
	}

	attachPseudoElementsToDocument(cascade);
}

function getPseudoSubjects(cascade: Cascade): Set<string> | null {
	if (cascade[kPseudoSubjectTags] !== undefined) {
		return cascade[kPseudoSubjectTags];
	}
	if (cascade[kCounterRulesExist] || cascade[kListItemRulesExist]) {
		return (cascade[kPseudoSubjectTags] = null);
	}
	// A list carries the one counter no rule declares, and its items carry
	// the markers that counter numbers. A details' summary is a list item
	// by the UA sheet, for its disclosure marker.
	const tags = new Set(["OL", "UL", "LI", "SUMMARY"]);
	// Only the pseudo-elements this function attaches. ::marker reaches
	// list items, handled above, and ::placeholder, ::selection and ::part
	// live on nodes the UA shadow tree trees already hold.
	for (const type of ["::before", "::after"]) {
		for (const rule of cascade[kPseudoRulesByType].get(type) ?? []) {
			if (rule.ofPart || !mayGiveContent(rule)) {
				continue;
			}
			if (!rule.subjectTag) {
				return (cascade[kPseudoSubjectTags] = null);
			}
			tags.add(rule.subjectTag.toUpperCase());
		}
	}
	return (cascade[kPseudoSubjectTags] = tags);
}

// A few matches() calls instead of building the full pseudo-element
// declaration just to discover `content` is "none". Over-matching is
// safe. The win is the early false for a document with no pseudo rules
// beyond the UA button brackets.
function pseudoRuleCouldMatch(
	cascade: Cascade,
	element: Element,
	pseudoType: string,
): boolean {
	if (pseudoType === "::marker") {
		// Markers exist only on display:list-item boxes.
		return (
			element.tagName === "LI" ||
			element.tagName === "SUMMARY" ||
			cascade[kListItemRulesExist] ||
			(element.getAttribute("style") ?? "").includes("list-item")
		);
	}
	const rules = cascade[kPseudoRulesByType].get(pseudoType);
	if (!rules) {
		return false;
	}
	for (const rule of rules) {
		if (mayGiveContent(rule) && ruleSelectorMatches(element, rule)) {
			return true;
		}
	}
	return false;
}

// A ::before or ::after exists only while its content is something, and
// content is not inherited, so only a rule that sets it can make one. The
// common reset `*, ::before, ::after { box-sizing: border-box }` matches
// every element's and makes none.
function mayGiveContent(rule: ParsedCSSRule): boolean {
	return rule.declarations.content !== undefined ||
		rule.declarations.all !== undefined;
}

function attachPseudoElementToElementForType(
	cascade: Cascade,
	element: Element,
	pseudoType: string,
): void {
	// An attached pseudo-element still takes the full path, so a rule that
	// STOPPED matching removes it.
	if (
		!pseudoRuleCouldMatch(cascade, element, pseudoType) &&
		!pseudoElement(element, pseudoType)
	) {
		return;
	}

	// counter() in a content value reads these, so they must exist first.
	initializeCounters(cascade, element);

	if (pseudoType === "::marker") {
		const computedStyle = cascade.declarationFor(element);
		const display = computedStyle[kComputedValue]("display");
		const listStylePosition =
			computedStyle[kComputedValue]("list-style-position") || "outside";

		if (display !== "list-item") {
			return;
		}

		if (listStylePosition === "outside") {
			removePseudoElement(cascade, element, "::marker");
			return;
		}
	}

	const content = shouldCreatePseudoElement(cascade, element, pseudoType)
		? getPseudoContent(cascade, element, pseudoType)
		: null;
	const existing = pseudoElement<Element>(element, pseudoType);

	// Node identity is stable. Layout keys the pseudo-element's boxes by
	// instance, and a fresh node per attach orphans the mapped one (a
	// positioned button's ::after glyph simply vanished). Only the text
	// changes.
	if (content === null) {
		if (existing) {
			removePseudoElement(cascade, element, pseudoType);
		}
		return;
	}
	if (existing) {
		const text = existing.firstChild as Text;
		if (text.data !== content) {
			text.data = content;
			cascade[kLayout].invalidate(element);
		}
		return;
	}
	const node = ensurePseudoElement<Element>(element, pseudoType);
	cascade[kPseudoHosts].add(element);
	node.appendChild(element.ownerDocument.createTextNode(content));
	cascade[kLayout].invalidate();
	cascade[kLayout].invalidate(element);
}

function removePseudoElement(
	cascade: Cascade,
	element: Element,
	pseudoType: string,
): void {
	if (!pseudoElement(element, pseudoType)) {
		return;
	}
	dropPseudoElement(element, pseudoType);
	cascade[kLayout].invalidate();
	cascade[kLayout].invalidate(element);
}

const CSSOM_WINDOW_GLOBALS = {
	CSSStyleSheet,
	StyleSheetList,
	CSSRuleList,
	CSSRule,
	CSSStyleRule,
	CSSGroupingRule,
	CSSConditionRule,
	CSSMediaRule,
	CSSSupportsRule,
	CSSImportRule,
	CSSKeyframesRule,
	CSSKeyframeRule,
	CSSNamespaceRule,
	CSSPageRule,
	CSSFontFaceRule,
	CSSCounterStyleRule,
	CSSPropertyRule,
	CSSFontPaletteValuesRule,
	CSSFontFeatureValuesRule,
	CSSContainerRule,
	CSSLayerBlockRule,
	CSSLayerStatementRule,
	CSSScopeRule,
	CSSStartingStyleRule,
	MediaList,
	CSSStyleDeclaration,
	CSSStyleProperties,
};

function setupInvalidationHooks(cascade: Cascade): void {
	// An error thrown out of a constructed sheet belongs to this realm.
	cssomWindow = cascade[kWindow];
	Object.assign(cascade[kWindow], CSSOM_WINDOW_GLOBALS, {
		CSS: createCSSNamespace(cascade[kDocument]),
	});
}

/** The element's inline style declaration, one per element for its lifetime. */
export function getInlineStyle(
	element: Element,
): globalThis.CSSStyleDeclaration {
	let style = inlineStyles.get(element);
	if (!style) {
		style = new CSSStyleProperties({element});
		inlineStyles.set(element, style);
	}
	return style as unknown as globalThis.CSSStyleDeclaration;
}

/** The sheets a tree declares, as document.styleSheets lists them. */
export function getStyleSheets(
	tree: Document | ShadowRoot,
): globalThis.StyleSheetList {
	const list = new StyleSheetList(getDeclaredStyleSheets(tree));
	syncIndexed(list);
	return list as unknown as globalThis.StyleSheetList;
}

/** The tree's adopted sheets, as the observable array the setter replaces. */
export function getAdoptedStyleSheets(tree: Node): globalThis.CSSStyleSheet[] {
	let list = adoptedSheets.get(tree);
	if (!list) {
		adoptedSheets.set(tree, (list = []));
	}
	return observableAdopted(tree, list) as unknown as globalThis.CSSStyleSheet[];
}

export function adoptStyleSheets(tree: Node, sheets: unknown): void {
	adopt(tree, sheets);
	getTreeCascade(tree)?.syncStylesheets();
}

/** A style element's sheet. Null outside a tree, as in a browser. */
export function styleElementSheet(
	element: Element,
): globalThis.CSSStyleSheet | null {
	return element.parentNode
		? (getSheet(element) as unknown as globalThis.CSSStyleSheet)
		: null;
}

/**
 * Called from the DOM's own attribute change algorithms, so classList,
 * className and the parser invalidate the same way setAttribute does.
 */
export function styleAttributeChanged(
	element: Element,
	localName: string,
): void {
	if (localName === "style" || localName === "class" || localName === "id") {
		const cascade = documentCascades.get(element.ownerDocument as object);
		if (cascade) {
			invalidateElement(cascade, element);
		}
	}
}

/**
 * The layout engine moved geometry, so the used values measured under it are
 * stale.
 */
export function usedValuesChanged(document: object): void {
	const cascade = documentCascades.get(document);
	if (cascade !== undefined) {
		cascade[kUsedStale] = true;
	}
}

/** A shadow root registers with the cascade the moment it attaches. */
export function styleShadowAttached(root: ShadowRoot): void {
	documentCascades
		.get((root.host as Element).ownerDocument as object)
		?.registerShadowRoot(root);
}
