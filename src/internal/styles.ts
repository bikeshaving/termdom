/**
 * The cascade and the CSSOM: stylesheets, the values an element computes to,
 * and the object model an author writes through.
 *
 * Nothing below this file decides what an element's style is. Layout and the
 * painter read what it resolved.
 */

import type {EngineWindow} from "./termdom.js";
import type {LineStyle} from "./ansi.js";
import {
	clearPseudoElement,
	type Document as DOMDocument,
	flatParentElement,
	ensurePseudoElement,
	pseudoElementCount,
	isUAShadowRoot,
	pseudoElement,
	pseudoHostOf,
	pseudoNameOf,
	shadowRootOf,
	styleElementCount,
} from "./dom.js";
import * as cssTree from "css-tree";
import {parseCSSColor} from "./color.js";
import {stringWidth} from "./text.js";
import type {LayoutEngine} from "./layout.js";
import {
	CSS_INITIAL_VALUES,
	CSS_LONGHANDS,
	CSS_PROPERTIES,
	CSS_AT_RULE_DESCRIPTORS,
	CSS_RESET_ONLY_LONGHANDS,
	CSS_SHORTHANDS,
} from "./cssproperties.js";
import {
	INHERITED_PROPERTIES,
	INITIAL_KEYWORDS,
	UA_DOCUMENT_STYLES,
	expandShorthands,
	getElementDefaults,
	getInitialStyle,
} from "./useragent.js";

const kElement = Symbol("element");
const kParentRule = Symbol("parentRule");
const kOnChange = Symbol("onChange");
const kDescriptors = Symbol("descriptors");
const kKeyframe = Symbol("keyframe");
const kAttributeText = Symbol("attributeText");
const kDeclarations = Symbol("declarations");
const kPseudoDeclarations = Symbol("pseudo declarations");
const kByName = Symbol("byName");
const kApply = Symbol("apply");
const kInvalidate = Symbol("invalidate");
const kShorthandValue = Symbol("shorthandValue");
const kFind = Symbol("find");
const kSerialize = Symbol("serialize");
const kBlock = Symbol("block");
const kIndexed = Symbol("indexed");
const kRemove = Symbol("remove");
const kStore = Symbol("store");
const kSync = Symbol("sync");
const kSupports = Symbol("supports");
const kFlush = Symbol("flush");
const kParse = Symbol("parse");
const kMedia = Symbol("media");
const kRuleList = Symbol("ruleList");
const kRules = Symbol("rules");
const kSelectors = Symbol("selectors");
const kStyle = Symbol("style");
const kSelectorText = Symbol("selectorText");
const kName = Symbol("name");
const kKeyText = Symbol("keyText");
const kConditionText = Symbol("conditionText");
const kPrelude = Symbol("prelude");
const kNames = Symbol("names");
const kPrefix = Symbol("prefix");
const kNamespaceURI = Symbol("namespaceURI");
const kHref = Symbol("href");
const kLayerName = Symbol("layerName");
const kSupportsText = Symbol("supportsText");
const kFontFamily = Symbol("fontFamily");
const kBlocks = Symbol("blocks");
const kSheets = Symbol("sheets");
const kOwnerNode = Symbol("ownerNode");
const kConstructed = Symbol("constructed");
const kTitle = Symbol("title");
const kDisabled = Symbol("disabled");
const kChanged = Symbol("changed");
const kText = Symbol("text");
const kOwnerRule = Symbol("ownerRule");
const kCheckRuleOrder = Symbol("checkRuleOrder");
const kCSSRules = Symbol("cssRules");
const kManager = Symbol("manager");
const kEpoch = Symbol("epoch");
const kSeenEpoch = Symbol("seenEpoch");
const kUsed = Symbol("used");
const kUsedEpoch = Symbol("usedEpoch");
const kMeasure = Symbol("measure");
const kResolvePropertyValue = Symbol("resolvePropertyValue");
const kLengthContext = Symbol("lengthContext");
const kRootFontSize = Symbol("rootFontSize");
const kStale = Symbol("stale");
const kRefresh = Symbol("refresh");
const kResolved = Symbol("resolved");
const kShorthand = Symbol("shorthand");
const kComputed = Symbol("computed");
const kPhysicalOf = Symbol("physicalOf");
const kUsedInset = Symbol("usedInset");
const kEdge = Symbol("edge");
const kAutoMargin = Symbol("autoMargin");
const kContainingWidth = Symbol("containingWidth");
const kContainingBlockBox = Symbol("containingBlockBox");
const kViewportBox = Symbol("viewportBox");
const kBoxOf = Symbol("boxOf");
const kCustom = Symbol("custom");
const kResolveCustomProperty = Symbol("resolveCustomProperty");
const kSubstituteVar = Symbol("substituteVar");
const kResolvePropertyValueRaw = Symbol("resolvePropertyValueRaw");
const kResolveFromParent = Symbol("resolveFromParent");
const kInlineDeclarations = Symbol("inlineDeclarations");
const kUsedValue = Symbol("usedValue");
const kResolvedMinSize = Symbol("resolvedMinSize");
const kCustomNames = Symbol("customNames");
const kPseudoElement = Symbol("pseudoElement");
const kNodeResolved = Symbol("nodeResolved");
const kNodeStyle = Symbol("nodeStyle");
const kWindow = Symbol("window");
const kLayoutEngine = Symbol("layoutEngine");
const kDocument = Symbol("document");
const kGetComputedStyle = Symbol("getComputedStyle");
const kSetupInvalidationHooks = Symbol("setupInvalidationHooks");
const kStyleEpoch = Symbol("styleEpoch");
const kStylesheetsDirty = Symbol("stylesheetsDirty");
const kStyleSheetCount = Symbol("styleSheetCount");
const kParsedStyleSheetCount = Symbol("parsedStyleSheetCount");
const kParseStylesheets = Symbol("parseStylesheets");
const kGetMatchingRules = Symbol("getMatchingRules");
const kLayoutFlush = Symbol("layoutFlush");
const kFlushing = Symbol("flushing");
const kUsedGeneration = Symbol("usedGeneration");
const kFlushedEpoch = Symbol("flushedEpoch");
const kShadowRoots = Symbol("shadowRoots");
const kInvalidateEnclosingList = Symbol("invalidateEnclosingList");
const kInvalidateElementCaches = Symbol("invalidateElementCaches");
const kInvalidateSubtree = Symbol("invalidateSubtree");
const kSelectorsReachAncestors = Symbol("selectorsReachAncestors");
const kSelectorsReachSiblings = Symbol("selectorsReachSiblings");
const kStyleSheetList = Symbol("styleSheetList");
const kPendingStyleDamage = Symbol("pendingStyleDamage");
const kFocusVisibleActive = Symbol("focusVisibleActive");
const kComputedStyleCache = Symbol("computedStyleCache");
const kPseudoElementStyleCache = Symbol("pseudoElementStyleCache");
const kPseudoNodeStyles = Symbol("pseudoNodeStyles");
const kCounterScopes = Symbol("counterScopes");
const kComputePseudoElementStyle = Symbol("computePseudoElementStyle");
const kParsedRules = Symbol("parsedRules");
const kReachingClasses = Symbol("reachingClasses");
const kReachingIds = Symbol("reachingIds");
const kReachingAttributes = Symbol("reachingAttributes");
const kReachingStates = Symbol("reachingStates");
const kPseudoRulesByType = Symbol("pseudoRulesByType");
const kPseudoSubjectTags = Symbol("pseudoSubjectTags");
const kCounterRulesExist = Symbol("counterRulesExist");
const kListItemRulesExist = Symbol("listItemRulesExist");
const kScopedRulesExist = Symbol("scopedRulesExist");
const kLayerPaths = Symbol("layerPaths");
const kAnonymousLayers = Symbol("anonymousLayers");
const kParseStyleSheet = Symbol("parseStyleSheet");
const kRankLayers = Symbol("rankLayers");
const kUnlayeredRank = Symbol("unlayeredRank");
const kAttachPseudoElements = Symbol("attachPseudoElements");
const kParseStyleRule = Symbol("parseStyleRule");
const kDeclareLayer = Symbol("declareLayer");
const kMediaQueryPartMatches = Symbol("mediaQueryPartMatches");
const kMediaFeatureMatches = Symbol("mediaFeatureMatches");
const kParseSelector = Symbol("parseSelector");
const kIndexReachingKeys = Symbol("indexReachingKeys");
const kPartPseudoFor = Symbol("partPseudoFor");
const kRuleMatches = Symbol("ruleMatches");
const kScopeProximity = Symbol("scopeProximity");
const kScopingRoot = Symbol("scopingRoot");
const kMatchesRule = Symbol("matchesRule");
const kAttachPseudoElementToElementForType = Symbol(
	"attachPseudoElementToElementForType",
);
const kPseudoSubjects = Symbol("pseudoSubjects");
const kPseudoRuleCouldMatch = Symbol("pseudoRuleCouldMatch");
const kRemovePseudoElement = Symbol("removePseudoElement");
const kPseudoContentFor = Symbol("pseudoContentFor");
const kParseCounterReset = Symbol("parseCounterReset");
const kParseCounterIncrement = Symbol("parseCounterIncrement");
const kIncrementCounter = Symbol("incrementCounter");
const kGetListItemCounterValue = Symbol("getListItemCounterValue");
const kGetCounterValueFromScope = Symbol("getCounterValueFromScope");

/**
 * Helper to get computed style property value for an element.
 */
export function getPropertyValue(element: Element, property: string): string {
	// The COMPUTED value, not the resolved one: layout and paint decide
	// geometry from this, and a used value here would feed layout its own
	// output. It is the internal path by construction -- computedStyleOf
	// reaches the cascade's declaration directly -- so there is no branch to
	// guard, nothing to unwind, and nothing between here and the value but
	// two map lookups.
	return computedStyleOf(element).computedValueOf(property);
}

export function parseUnitValue(
	value: string,
): number | {percentage: number} | null {
	if (!value) {
		return null;
	}

	// Handle values that start with a digit or are "0" variants
	if (!/^[\d.]/.test(value)) {
		return null;
	}

	if (value.endsWith("%")) {
		const num = parseFloat(value.slice(0, -1));
		if (isNaN(num)) {
			return null;
		}
		return {percentage: num};
	}

	// Handle "ch" units (character width) - treat as character units
	if (value.endsWith("ch")) {
		const num = parseFloat(value.slice(0, -2));
		if (isNaN(num)) {
			return null;
		}
		return num; // In TermDOM, 1ch = 1 character
	}

	const num = parseFloat(value);
	return isNaN(num) ? null : num;
}

/**
 * CSS Box Model representation for layout calculations
 */
export interface BoxModel {
	width?: number;
	height?: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
	borderTopWidth: number;
	borderRightWidth: number;
	borderBottomWidth: number;
	borderLeftWidth: number;
}

/**
 * Lengths that may be negative: margins (and offsets). parseUnitValue's
 * digit gate is the right default -- negative widths, paddings and borders
 * are invalid CSS and must stay rejected -- so the sign lives in a separate
 * parser the margin paths opt into.
 */
export function parseSignedUnitValue(
	value: string,
): ReturnType<typeof parseUnitValue> {
	const trimmed = value?.trim();
	if (trimmed?.startsWith("-")) {
		const inner = parseUnitValue(trimmed.slice(1));
		if (typeof inner === "number") {
			return -inner;
		}
		if (inner && "percentage" in inner) {
			return {percentage: -inner.percentage};
		}
		return null;
	}
	return parseUnitValue(value);
}

/**
 * Border widths, keywords included: thin/medium/thick all land on one cell
 * -- the grid cannot grade them, and medium is the initial that a bare
 * `border: solid` carries, which must be a VISIBLE border as in a browser.
 */
export function parseBorderWidthValue(
	value: string,
): ReturnType<typeof parseUnitValue> {
	const keyword = value.trim().toLowerCase();
	if (keyword === "thin" || keyword === "medium" || keyword === "thick") {
		return 1;
	}
	return parseUnitValue(value);
}

/**
 * Parse CSS box model properties from an element's computed style
 */

export function getBoxModel(element: Element): BoxModel {
	// The engine's own read: the cascade's declaration, straight, with none of
	// the author path's resolved-value work between here and the values layout
	// is about to decide geometry from.
	return readBoxModel(computedStyleOf(element));
}

function readBoxModel(computedStyle: ComputedStyle): BoxModel {
	// Parse explicit width/height
	const widthValue = parseUnitValue(computedStyle.computedValueOf("width"));
	const heightValue = parseUnitValue(computedStyle.computedValueOf("height"));

	// Parse padding
	const paddingTop = parseUnitValue(
		computedStyle.computedValueOf("padding-top"),
	);
	const paddingRight = parseUnitValue(
		computedStyle.computedValueOf("padding-right"),
	);
	const paddingBottom = parseUnitValue(
		computedStyle.computedValueOf("padding-bottom"),
	);
	const paddingLeft = parseUnitValue(
		computedStyle.computedValueOf("padding-left"),
	);

	// Parse margin
	const marginTop = parseSignedUnitValue(
		computedStyle.computedValueOf("margin-top"),
	);
	const marginRight = parseSignedUnitValue(
		computedStyle.computedValueOf("margin-right"),
	);
	const marginBottom = parseSignedUnitValue(
		computedStyle.computedValueOf("margin-bottom"),
	);
	const marginLeft = parseSignedUnitValue(
		computedStyle.computedValueOf("margin-left"),
	);

	// Parse border. The USED width is 0 when the side's style is none or
	// hidden (css-backgrounds §3.3), however wide the width property says --
	// `border-style: none` must release the space, not just the glyphs.
	const borderWidthFor = (side: string) => {
		const style = computedStyle.computedValueOf(`border-${side}-style`);
		if (!style || style === "none" || style === "hidden") {
			return null;
		}
		return parseBorderWidthValue(
			computedStyle.computedValueOf(`border-${side}-width`),
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
		borderRightWidth:
			typeof borderRightWidth === "number" ? borderRightWidth : 0,
		borderBottomWidth:
			typeof borderBottomWidth === "number" ? borderBottomWidth : 0,
		borderLeftWidth: typeof borderLeftWidth === "number" ? borderLeftWidth : 0,
	};
}

/**
 * Properties whose every numeric component must carry a unit. CSS accepts
 * a bare `0` for any length, and accepts bare numbers for the properties
 * that are typed as numbers (line-height, z-index, flex-grow, order,
 * opacity, font-weight) -- those are NOT listed here.
 */
const LENGTH_PROPERTIES = new Set([
	"border-bottom-left-radius",
	"border-bottom-right-radius",
	"border-bottom-width",
	"border-left-width",
	"border-radius",
	"border-right-width",
	"border-top-left-radius",
	"border-top-right-radius",
	"border-top-width",
	"border-width",
	"bottom",
	"column-gap",
	"flex-basis",
	"font-size",
	"gap",
	"height",
	"inset",
	"left",
	"letter-spacing",
	"margin",
	"margin-bottom",
	"margin-left",
	"margin-right",
	"margin-top",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"outline-offset",
	"outline-width",
	"padding",
	"padding-bottom",
	"padding-left",
	"padding-right",
	"padding-top",
	"right",
	"row-gap",
	"text-indent",
	"top",
	"width",
	"word-spacing",
]);

/**
 * A nonzero length written without a unit (`padding-top: 1`) is invalid
 * CSS. Browsers reject the declaration at PARSE time, so it never enters
 * the cascade and a lower-priority rule still wins -- coercing it to 0
 * instead would let the bad declaration beat the good one. Terminal
 * authoring makes this an easy slip to write, since 1px is exactly one
 * cell here, so the check earns its keep: `padding-top: 1` means nothing,
 * `padding-top: 1px` means one cell.
 */
function isValidDeclaration(
	property: string,
	value: string,
	atRule = "",
): boolean {
	if (!matchesGrammar(property, value, atRule)) {
		return false;
	}
	if (!LENGTH_PROPERTIES.has(property)) {
		return true;
	}
	// A shorthand is invalid as a WHOLE if any of its components is, so
	// every component is checked and one failure rejects the declaration.
	return value
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.every((token) => {
			if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
				return true; // carries a unit, or is a keyword like auto
			}
			return parseFloat(token) === 0; // bare 0 is the one legal bare number
		});
}

/**
 * The grammars a value is matched against: the property index's, with the
 * entries it states from an older level of the specs brought up to date.
 * `generic()` family names, the SVG baseline keywords and `outline-color:
 * invert` are all in the current specs and missing from the index.
 */
const grammarLexer = cssTree.fork({
	properties: {
		"alignment-baseline": "| text-bottom | text-top",
		"baseline-shift": "| top | center | bottom",
		"outline-color": "| invert",
	},
	types: {
		"family-name":
			"| generic( <custom-ident>+ ) | -webkit-generic( <custom-ident>+ )",
	},
}).lexer;

/**
 * Whether a value fits its property's grammar, memoized: a declaration is
 * parsed once for every element that declares it, and the same handful of
 * values recur across a whole document.
 */
const grammarMatches = new Map<string, boolean>();

/**
 * Whether a declared value matches the property's grammar, as the property
 * index states it. A value that does not is not a declaration at all: it
 * leaves whatever stood there standing, which is what makes `color: notacolor`
 * a no-op rather than a value.
 *
 * A value carrying a substitution is not judged: what it means depends on what
 * the custom property holds, which is not known here.
 */
function matchesGrammar(property: string, value: string, atRule = ""): boolean {
	if (property.startsWith("--")) {
		return true;
	}
	if (!atRule && !SUPPORTED_PROPERTIES.has(property)) {
		return true;
	}
	const text = value.trim();
	if (!text || CSS_WIDE_KEYWORDS.has(text.toLowerCase())) {
		return true;
	}
	if (/\b(?:var|env|attr)\(/i.test(text)) {
		return true;
	}
	const key = `${atRule}|${property}|${text}`;
	const memoized = grammarMatches.get(key);
	if (memoized !== undefined) {
		return memoized;
	}
	let valid = true;
	try {
		const match = atRule ?
				grammarLexer.matchAtruleDescriptor(atRule.slice(1), property, text) :
				grammarLexer.matchProperty(property, text);
		// A descriptor or property the grammars do not describe is one this
		// cannot judge.
		valid =
			match.matched !== null ||
			/Unknown (?:property|at-rule)/i.test(match.error?.message ?? "");
	} catch (_err) {
		valid = true;
	}
	if (grammarMatches.size > 4096) {
		grammarMatches.clear();
	}
	grammarMatches.set(key, valid);
	return valid;
}

/** Minimum gutter a UL/OL reserves for its markers, in cells. */
const DEFAULT_LIST_GUTTER = 4;

/** Lists currently having their gutter measured, to stop re-entrant computation. */
const listGutterInProgress = new WeakSet<Element>();

/**
 * The active StyleManager for a window.
 *
 * The gutter is resolved deep inside the cascade, which has no StyleManager to
 * hand, but it has to measure the *resolved* ::marker content -- the same string
 * the renderer will draw -- and only the StyleManager can produce that.
 */
const styleManagers = new WeakMap<object, StyleManager>();

/**
 * The same registry keyed by DOCUMENT rather than window.
 *
 * A window is one object per document, and an element holds its document
 * rather than its window: the internal read path takes this door so that a
 * cascade is found from a node without a hop through the window.
 */
const documentManagers = new WeakMap<object, StyleManager>();

/** A marker is separated from its item's text by one cell. */
function withMarkerSeparator(marker: string): string {
	return marker ? `${marker} ` : "";
}

/**
 * Strip the quotes from a CSS `content` value.
 *
 * A content value is a *sequence* of components -- quoted strings, and functions
 * like counter() -- so `counter(list-item) ") "` has to yield
 * `counter(list-item)) ` for the counter pass to expand, not keep its literal
 * quote characters. Only stripping when the whole value is one quoted string
 * left `"` and `'` in the rendered marker.
 */
function unquoteContent(content: string): string {
	let out = "";
	let index = 0;

	while (index < content.length) {
		const char = content[index];

		if (char === '"' || char === "'") {
			// A quote or a backslash inside the string carries a backslash of
			// its own, which is spelling, not content.
			let close = index + 1;
			for (; close < content.length && content[close] !== char; close++) {
				if (content[close] === "\\") {
					close++;
				}
			}
			out += content.slice(index + 1, close).replace(/\\(.)/g, "$1");
			index = close + 1;
		} else if (/\s/.test(char)) {
			// Whitespace *between* components is not rendered.
			index++;
		} else {
			// A function or keyword: copy it verbatim, parens and all.
			let depth = 0;
			let end = index;
			for (; end < content.length; end++) {
				const c = content[end];
				if (c === "(") {
					depth++;
				} else if (c === ")") {
					depth--;
				} else if (depth === 0 && /\s/.test(c)) {
					break;
				}
			}
			out += content.slice(index, end);
			index = end;
		}
	}

	return out;
}

/**
 * Width of the gutter a list reserves for `list-style-position: outside` markers.
 *
 * Markers are right-aligned against the content edge, so the gutter must fit the
 * widest marker in the list. A fixed gutter silently collides with wide markers:
 * "iii. Third" renders as "iii.Third" once the marker fills all four cells.
 *
 * This must measure exactly what renderOutsideMarker() will draw -- the resolved
 * ::marker content, in terminal cells. Measuring the *default* marker instead
 * lets `::marker { content: ">>>>>> " }` overrun the gutter, and measuring with
 * String#length instead of stringWidth() lets a wide-character marker like
 * "日本 " do the same: .length is 3 where the cells occupied are 5.
 */
function getListGutterWidth(listElement: Element): number {
	if (listGutterInProgress.has(listElement)) {
		return DEFAULT_LIST_GUTTER;
	}
	listGutterInProgress.add(listElement);
	try {
		const window = listElement.ownerDocument.defaultView;
		const styleManager = window ? styleManagers.get(window) : undefined;

		let widest = 0;
		for (const child of Array.from(listElement.children)) {
			if (child.tagName !== "LI") {
				continue;
			}
			const marker = styleManager ?
					styleManager.getMarkerContent(child) :
					withMarkerSeparator(getListMarker(child, listElement));
			if (!marker) {
				continue;
			}
			widest = Math.max(widest, stringWidth(marker));
		}
		return Math.max(DEFAULT_LIST_GUTTER, widest);
	} finally {
		listGutterInProgress.delete(listElement);
	}
}

/**
 * The box shorthands whose computed answer is serialized from their four
 * longhands rather than resolved in its own right. Border shorthands are
 * excluded on purpose: resolveBorderStyles reads the longhands directly, and
 * `border` answers what was authored.
 */
const BOX_SHORTHAND_LONGHANDS = new Map<string, readonly string[]>([
	["margin", ["margin-top", "margin-right", "margin-bottom", "margin-left"]],
	[
		"padding",
		["padding-top", "padding-right", "padding-bottom", "padding-left"],
	],
]);

/** Properties whose value is a `<color>`. */
const COLOR_PROPERTIES = new Set([
	"accent-color",
	"background-color",
	"border-block-end-color",
	"border-block-start-color",
	"border-bottom-color",
	"border-inline-end-color",
	"border-inline-start-color",
	"border-left-color",
	"border-right-color",
	"border-top-color",
	"caret-color",
	"color",
	"column-rule-color",
	"outline-color",
	"text-decoration-color",
	"text-emphasis-color",
]);

/**
 * Properties whose value carries author text -- strings, family names,
 * function bodies -- and so is never case-folded.
 */
const VERBATIM_PROPERTIES = new Set([
	"background-image",
	"content",
	"counter-increment",
	"counter-reset",
	"font",
	"font-family",
	"list-style-image",
	"quotes",
]);

/** A value that is one bare CSS identifier, which computes case-folded. */
const IDENTIFIER_VALUE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * `#rgb`/`#rrggbb` (and their alpha forms) in the rgb()/rgba() serialization
 * a computed color carries. Null for anything that is not a valid hex color.
 */
function hexColorToRGB(hex: string): string | null {
	const digits = hex.slice(1);
	if (!/^[0-9a-fA-F]+$/.test(digits)) {
		return null;
	}
	const short = digits.length === 3 || digits.length === 4;
	if (!short && digits.length !== 6 && digits.length !== 8) {
		return null;
	}
	const size = short ? 1 : 2;
	const channel = (index: number): number => {
		const part = digits.substr(index * size, size);
		return parseInt(short ? part + part : part, 16);
	};
	const rgb = `${channel(0)}, ${channel(1)}, ${channel(2)}`;
	if (digits.length === 4 || digits.length === 8) {
		const alpha = Math.round((channel(3) / 255) * 1000) / 1000;
		return `rgba(${rgb}, ${alpha})`;
	}
	return `rgb(${rgb})`;
}

/**
 * A numeric component in its computed spelling: the sign and any trailing
 * zeros dropped, the unit case-folded, and a unitless zero given the `px` a
 * length always computes to.
 */
function computedNumber(token: string): string {
	const match = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-zA-Z%]*)$/.exec(token);
	if (!match) {
		return token;
	}
	const number = parseFloat(match[1]);
	if (!Number.isFinite(number)) {
		return token;
	}
	const unit = match[2].toLowerCase() || (number === 0 ? "px" : "");
	return `${number}${unit}`;
}

/** The corner radii, whose value is a horizontal radius and a vertical one. */
const RADIUS_LONGHANDS = new Set([
	"border-top-left-radius",
	"border-top-right-radius",
	"border-bottom-right-radius",
	"border-bottom-left-radius",
]);

/**
 * A corner radius with its second component dropped where the two agree: a
 * circular corner states one radius, an elliptical one states both.
 */
function collapseRadius(value: string): string {
	const parts = value.split(/\s+/).filter(Boolean);
	return parts.length === 2 && parts[0] === parts[1] ? parts[0] : value;
}

/**
 * The computed spelling of a declared value: the one place a struct becomes
 * a string, at the getPropertyValue boundary.
 */
function normalizeValue(property: string, declared: string): string {
	const value = declared.trim();
	if (
		!value ||
		property.startsWith("--") ||
		VERBATIM_PROPERTIES.has(property)
	) {
		return value;
	}
	if (COLOR_PROPERTIES.has(property)) {
		return serializeColor(value) ?? value;
	}
	if (LENGTH_PROPERTIES.has(property)) {
		const lengths = value.split(/\s+/).map(computedNumber).join(" ");
		return RADIUS_LONGHANDS.has(property) ? collapseRadius(lengths) : lengths;
	}
	return IDENTIFIER_VALUE.test(value) ? value.toLowerCase() : value;
}

/**
 * A color's resolved spelling: `rgb(r, g, b)`, or `rgba(r, g, b, a)` when it
 * is not opaque. Null for a value that names no color -- `currentcolor` before
 * it resolves, a keyword this engine's color table does not carry.
 */
function serializeColor(value: string): string | null {
	const text = value.trim();
	if (!text || text.toLowerCase() === "currentcolor") {
		return null;
	}
	if (/^transparent$/i.test(text)) {
		return "rgba(0, 0, 0, 0)";
	}
	if (text.startsWith("#")) {
		return hexColorToRGB(text);
	}
	const packed = parseCSSColor(text);
	if (packed === null) {
		return null;
	}
	const red = (packed >> 16) & 0xff;
	const green = (packed >> 8) & 0xff;
	const blue = packed & 0xff;
	// An alpha component survives the 24-bit packing as its own text.
	const functional = /^(?:rgba|hsla)\(([^)]*)\)$/i.exec(text);
	const parts = functional ? functional[1].split(/\s*[,/]\s*/) : [];
	if (parts.length === 4) {
		const raw = parts[3].trim();
		const opacity = raw.endsWith("%") ?
			Number(raw.slice(0, -1)) / 100 :
				Number(raw);
		if (Number.isFinite(opacity) && opacity < 1) {
			return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
		}
	}
	return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * The properties whose value absolutizes against the element it is computed
 * on: every property that takes a length, plus the two whose percentage is
 * font-relative. A value on any other property is the same string on every
 * element, and interning is the whole of its computation.
 */
const ABSOLUTIZED_PROPERTIES = new Set([
	...LENGTH_PROPERTIES,
	"border-spacing",
	"line-height",
	"text-underline-offset",
	"vertical-align",
]);

/**
 * The properties whose percentage resolves at computed-value time, against
 * the font size: `font-size` against the parent's, `line-height` against the
 * element's own. Every other percentage stays a percentage until it is used.
 */
const FONT_RELATIVE_PERCENTAGES = new Set(["font-size", "line-height"]);

/** A number carrying a unit that only an element can measure. */
const RELATIVE_UNIT = /[\d.](?:r?em|ex|ch|vw|vh|vmin|vmax)\b/i;

/**
 * One interned computed value: the string, and whether answering it needs
 * the element -- a relative length to absolutize, a calc() to reduce, a
 * font-relative percentage to resolve. The flag is decided once per declared
 * text, so the common value (a keyword, an integer, a px or ch length) is
 * still nothing but two map lookups.
 */
interface ComputedEntry {
	value: string;
	contextual: boolean;
}

const EMPTY_ENTRY: ComputedEntry = {value: "", contextual: false};

/**
 * Computed strings interned by property and declared text. A document draws
 * its declared values from a small vocabulary -- a handful of colors, a
 * handful of lengths, the same keywords on every element -- so the same pair
 * recurs across thousands of elements and every generation after the first.
 */
const computedValues = new Map<string, Map<string, ComputedEntry>>();

function computedEntry(property: string, declared: string): ComputedEntry {
	if (!declared) {
		return EMPTY_ENTRY;
	}
	let byValue = computedValues.get(property);
	if (!byValue) {
		byValue = new Map();
		computedValues.set(property, byValue);
	}
	let entry = byValue.get(declared);
	if (entry === undefined) {
		const value = normalizeValue(property, declared);
		entry = {
			value,
			contextual:
				ABSOLUTIZED_PROPERTIES.has(property) &&
				(RELATIVE_UNIT.test(value) ||
					value.includes("calc(") ||
					(FONT_RELATIVE_PERCENTAGES.has(property) && value.includes("%"))),
		};
		if (byValue.size >= 512) {
			byValue.clear();
		}
		byValue.set(declared, entry);
	}
	return entry;
}

function computedValue(property: string, declared: string): string {
	return computedEntry(property, declared).value;
}

/** The unit a length measures in, and the px each one of it is worth. */
interface LengthContext {
	/** The font size relative units measure against, in px. */
	font: number;
	/** The root element's font size, for `rem`. */
	root: number;
	viewportWidth: number;
	viewportHeight: number;
	/** What a percentage is worth, or null where percentages stay. */
	percent: number | null;
}

/**
 * The font size a terminal draws with: one cell. It is the initial value
 * `font-size` computes to, so `1em` is one cell in a document that declares
 * no font size -- and a document that declares one still gets the spec's
 * arithmetic, which the grid then rounds to cells.
 */
const INITIAL_FONT_SIZE = 1;

function fontSizeOf(style: ComputedStyle): number {
	const size = parseFloat(style.computedValueOf("font-size"));
	return Number.isFinite(size) ? size : INITIAL_FONT_SIZE;
}

function unitFactor(unit: string, context: LengthContext): number | null {
	switch (unit.toLowerCase()) {
		case "em":
			return context.font;
		case "rem":
			return context.root;
		// A terminal has no font metrics: every glyph is one cell, so the
		// x-height a browser measures is the half-em it falls back to.
		case "ex":
			return context.font / 2;
		// One cell wide, whatever font size the document declares -- the grid's
		// column is not something a style can resize.
		case "ch":
			return 1;
		case "vw":
			return context.viewportWidth / 100;
		case "vh":
			return context.viewportHeight / 100;
		case "vmin":
			return Math.min(context.viewportWidth, context.viewportHeight) / 100;
		case "vmax":
			return Math.max(context.viewportWidth, context.viewportHeight) / 100;
		case "%":
			return context.percent;
		default:
			return null;
	}
}

/** A length in the spelling a computed value carries: px, six decimals at most. */
function absoluteLength(px: number): string {
	return `${Math.round(px * 1e6) / 1e6}px`;
}

/** A number token followed by its unit, anywhere in a value. */
const LENGTH_TOKEN = /([+-]?(?:\d+\.?\d*|\.\d+))(%|[a-zA-Z]+)/g;

/**
 * A computed value with every relative length replaced by the absolute one it
 * computes to, and every calc() reduced. What is left is px, the percentages
 * a property keeps until it is used, and whatever this engine does not
 * measure -- which passes through untouched.
 */
function absolutizeLengths(value: string, context: LengthContext): string {
	const reduced = value.includes("calc(") ? replaceCalc(value, context) : value;
	return reduced.replace(
		LENGTH_TOKEN,
		(token, number: string, unit: string) => {
			const factor = unitFactor(unit, context);
			return factor === null ?
				token :
					absoluteLength(parseFloat(number) * factor);
		},
	);
}

/** Each calc() in a value, replaced by the value it reduces to. */
function replaceCalc(value: string, context: LengthContext): string {
	let out = "";
	let index = 0;
	while (index < value.length) {
		const start = value.toLowerCase().indexOf("calc(", index);
		if (start === -1) {
			out += value.slice(index);
			break;
		}
		out += value.slice(index, start);
		let depth = 0;
		let end = start + 4;
		for (; end < value.length; end++) {
			if (value[end] === "(") {
				depth++;
			} else if (value[end] === ")" && --depth === 0) {
				break;
			}
		}
		const body = value.slice(start + 5, end);
		const terms = evaluateCalc(body, context);
		out += terms === null ? value.slice(start, end + 1) : serializeCalc(terms);
		index = end + 1;
	}
	return out;
}

/**
 * What a math function reduces to: a length in px, a percentage, and a plain
 * number, at most one of which a valid calc() leaves nonzero alongside the
 * others.
 */
interface CalcTerms {
	px: number;
	percent: number;
	number: number;
}

/**
 * The reduced form of a sum, per css-values: a lone term serializes as
 * itself, and a length that still carries a percentage keeps the calc() it
 * needs to hold the two together.
 */
function serializeCalc(terms: CalcTerms): string {
	const round = (value: number): number => Math.round(value * 1e6) / 1e6;
	const px = round(terms.px);
	const percent = round(terms.percent);
	const number = round(terms.number);
	if (percent === 0 && px === 0 && number !== 0) {
		return `${number}`;
	}
	if (percent === 0) {
		return `${px}px`;
	}
	if (px === 0 && number === 0) {
		return `${percent}%`;
	}
	return `calc(${px}px ${percent < 0 ? "-" : "+"} ${Math.abs(percent)}%)`;
}

/**
 * A calc() body reduced to its terms. Null for anything this cannot reduce --
 * a nested min()/max()/clamp(), a unit with no cell length, an unsubstituted
 * var() -- which leaves the value as the author wrote it.
 */
function evaluateCalc(body: string, context: LengthContext): CalcTerms | null {
	const tokens = body.match(
		/[+-]?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?|[()*/+-]/g,
	);
	if (!tokens) {
		return null;
	}
	let position = 0;
	const peek = (): string | undefined => tokens[position];

	const scale = (terms: CalcTerms, by: number): CalcTerms => ({
		px: terms.px * by,
		percent: terms.percent * by,
		number: terms.number * by,
	});

	const primary = (): CalcTerms | null => {
		const token = tokens[position++];
		if (token === undefined) {
			return null;
		}
		if (token === "(") {
			const inner = sum();
			if (inner === null || tokens[position++] !== ")") {
				return null;
			}
			return inner;
		}
		if (token === "-" || token === "+") {
			const inner = primary();
			return inner === null ? null : scale(inner, token === "-" ? -1 : 1);
		}
		const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(%|[a-zA-Z]+)?$/.exec(token);
		if (!match) {
			return null;
		}
		const number = parseFloat(match[1]);
		if (!match[2]) {
			return {px: 0, percent: 0, number};
		}
		if (match[2] === "px") {
			return {px: number, percent: 0, number: 0};
		}
		if (match[2] === "%" && context.percent === null) {
			return {px: 0, percent: number, number: 0};
		}
		const factor = unitFactor(match[2], context);
		if (factor === null) {
			return null;
		}
		return {px: number * factor, percent: 0, number: 0};
	};

	const product = (): CalcTerms | null => {
		let left = primary();
		while (left !== null && (peek() === "*" || peek() === "/")) {
			const operator = tokens[position++];
			const right = primary();
			if (right === null) {
				return null;
			}
			if (operator === "/") {
				if (right.px !== 0 || right.percent !== 0 || right.number === 0) {
					return null;
				}
				left = scale(left, 1 / right.number);
			} else if (right.px === 0 && right.percent === 0) {
				left = scale(left, right.number);
			} else if (left.px === 0 && left.percent === 0) {
				left = scale(right, left.number);
			} else {
				return null;
			}
		}
		return left;
	};

	const sum = (): CalcTerms | null => {
		let left = product();
		while (left !== null && (peek() === "+" || peek() === "-")) {
			const operator = tokens[position++];
			const right = product();
			if (right === null) {
				return null;
			}
			const sign = operator === "-" ? -1 : 1;
			left = {
				px: left.px + sign * right.px,
				percent: left.percent + sign * right.percent,
				number: left.number + sign * right.number,
			};
		}
		return left;
	};

	const terms = sum();
	return terms !== null && position === tokens.length ? terms : null;
}

/** A cascade level's declarations: expanded longhands, and which are `!important`. */
interface DeclarationBlock {
	declarations: Record<string, string>;
	important: Record<string, boolean>;
	/**
	 * Each declaration's position in the block, counting from the first. A
	 * logical property and the physical property it maps to are two names for
	 * one cascade slot, so which of them a block declares LAST decides the
	 * value -- and only this says which that is.
	 */
	order: Record<string, number>;
}

const EMPTY_DECLARATIONS: DeclarationBlock = {
	declarations: {},
	important: {},
	order: {},
};

/**
 * Which of a cascade slot's names a block declares LAST at the given
 * importance -- the declaration whose value the slot takes -- or null when it
 * declares none of them. `accepts` rejects a flow-relative name that maps to
 * the opposite physical edge under the element's direction.
 */
function declaredName(
	block: DeclarationBlock,
	names: readonly string[],
	important: boolean,
	accepts: (name: string) => boolean,
): string | null {
	let winner: string | null = null;
	let winningOrder = -1;
	for (const name of names) {
		if (block.declarations[name] === undefined) {
			continue;
		}
		if (Boolean(block.important[name]) !== important) {
			continue;
		}
		const order = block.order[name] ?? 0;
		if (order < winningOrder || !accepts(name)) {
			continue;
		}
		winner = name;
		winningOrder = order;
	}
	return winner;
}

/** The CSSOM shape a declaration block is read through: a rule's, or an element's. */
interface DeclarationSource {
	readonly [index: number]: string;
	readonly length: number;
	getPropertyValue(property: string): string;
	getPropertyPriority(property: string): string;
}

/** One declaration of a block: a longhand, or a shorthand kept undecomposed. */
interface CSSDeclaration {
	name: string;
	value: string;
	important: boolean;
}

/** Every property CSSOM exposes, shorthands included. */
const SUPPORTED_PROPERTIES = new Set(CSS_PROPERTIES);

const EDGE_NAMES = ["top", "right", "bottom", "left"] as const;

/** The components of a line shorthand, in the order its grammar writes them. */
const LINE_COMPONENTS = ["width", "style", "color"] as const;

/**
 * Every flow-relative longhand and the physical longhand it maps to, one table
 * per inline direction (css-logical-1 §2).
 *
 * This engine renders one writing mode -- `horizontal-tb`, the only one a
 * terminal's row-major grid has -- so the block axis is always vertical and
 * the inline axis always horizontal: block-start is the top edge, block-end
 * the bottom, and `direction` alone decides which side the inline edges name.
 * A `writing-mode` implementation would replace these two tables with four
 * more; nothing else here would move.
 */
const LOGICAL_TO_PHYSICAL: Readonly<
	Record<"ltr" | "rtl", Map<string, string>>
> = {ltr: new Map(), rtl: new Map()};

/**
 * Each physical longhand and the flow-relative longhands that can name it --
 * its block counterpart, or both inline ones, since which of those maps here
 * is not known until an element states its direction.
 */
const PHYSICAL_TO_LOGICAL = new Map<string, readonly string[]>();

{
	const map = (logical: string, ltr: string, rtl = ltr) => {
		LOGICAL_TO_PHYSICAL.ltr.set(logical, ltr);
		LOGICAL_TO_PHYSICAL.rtl.set(logical, rtl);
		for (const physical of ltr === rtl ? [ltr] : [ltr, rtl]) {
			PHYSICAL_TO_LOGICAL.set(physical, [
				...(PHYSICAL_TO_LOGICAL.get(physical) ?? []),
				logical,
			]);
		}
	};
	for (const kind of ["margin", "padding"]) {
		map(`${kind}-block-start`, `${kind}-top`);
		map(`${kind}-block-end`, `${kind}-bottom`);
		map(`${kind}-inline-start`, `${kind}-left`, `${kind}-right`);
		map(`${kind}-inline-end`, `${kind}-right`, `${kind}-left`);
	}
	map("inset-block-start", "top");
	map("inset-block-end", "bottom");
	map("inset-inline-start", "left", "right");
	map("inset-inline-end", "right", "left");
	for (const component of LINE_COMPONENTS) {
		map(`border-block-start-${component}`, `border-top-${component}`);
		map(`border-block-end-${component}`, `border-bottom-${component}`);
		map(
			`border-inline-start-${component}`,
			`border-left-${component}`,
			`border-right-${component}`,
		);
		map(
			`border-inline-end-${component}`,
			`border-right-${component}`,
			`border-left-${component}`,
		);
	}
	// The flow-relative sizes name an axis and no edge, so `direction` does
	// not reach them: only a vertical writing mode could.
	for (const prefix of ["", "min-", "max-"]) {
		map(`${prefix}block-size`, `${prefix}height`);
		map(`${prefix}inline-size`, `${prefix}width`);
	}
}

/** The physical longhand a flow-relative one names under `direction`, if it is one. */
function physicalProperty(
	property: string,
	direction: string,
): string | undefined {
	return LOGICAL_TO_PHYSICAL[direction === "rtl" ? "rtl" : "ltr"].get(property);
}

/**
 * The OTHER names of the cascade slot a longhand belongs to under `direction`:
 * a flow-relative longhand's physical counterpart, or a physical longhand's
 * flow-relative ones. Empty for a longhand that stands alone.
 */
function slotNames(property: string, direction: string): readonly string[] {
	const physical = physicalProperty(property, direction);
	if (physical) {
		return [physical];
	}
	const logical = PHYSICAL_TO_LOGICAL.get(property);
	if (!logical) {
		return [];
	}
	return logical.filter(
		(name) => physicalProperty(name, direction) === property,
	);
}

/** The keywords every property accepts, whatever its own grammar. */
const CSS_WIDE_KEYWORDS = new Set([
	"inherit",
	"initial",
	"revert",
	"revert-layer",
	"unset",
]);

const CORNER_NAMES = [
	"top-left",
	"top-right",
	"bottom-right",
	"bottom-left",
] as const;

/**
 * The shape of a shorthand's grammar, and so how its value serializes: a box
 * of four sides or corners collapsed to one to four values, a radius box
 * whose corners each carry two values, a pair collapsed when both agree, a
 * line's width/style/color, `border`'s three uniform boxes, or a plain
 * sequence of components.
 */
type ShorthandShape =
	| "box" |
	"radius" |
	"pair" |
	"line" |
	"border" |
	"sequence";

/**
 * Each shorthand's longhands, in the order its grammar names them: the
 * property index lists a box's sides alphabetically, where the grammar --
 * and so the order the longhands are stored and serialized in -- runs
 * top, right, bottom, left.
 */
const SHORTHAND_LONGHANDS = new Map<string, readonly string[]>();

/** Each shorthand's shape, classified once rather than per serialization. */
const SHORTHAND_SHAPES = new Map<string, ShorthandShape>();

/**
 * The longhands a shorthand resets but whose values its own grammar cannot
 * state: a block missing them cannot serialize as the shorthand, and they
 * take no place in the value it writes.
 */
const RESET_ONLY_LONGHANDS = new Map<string, ReadonlySet<string>>(
	Object.entries(CSS_RESET_ONLY_LONGHANDS).map(([shorthand, longhands]) => [
		shorthand,
		new Set(longhands),
	]),
);

for (const [shorthand, all] of Object.entries(CSS_SHORTHANDS)) {
	const reset = CSS_RESET_ONLY_LONGHANDS[shorthand];
	const indexed = reset ?
			all.filter((longhand) => !reset.includes(longhand)) :
		all;
	const box = boxOrder(indexed, EDGE_NAMES) ?? boxOrder(indexed, CORNER_NAMES);
	const longhands = box ? [...box, ...(reset ?? [])] : all;
	SHORTHAND_LONGHANDS.set(shorthand, longhands);
	// A corner box whose longhands are radii writes its two axes around a
	// slash rather than one value per corner.
	const radius =
		box !== null && indexed.every((longhand) => longhand.endsWith("-radius"));
	SHORTHAND_SHAPES.set(
		shorthand,
		box ?
			radius ?
				"radius" :
				"box" : // A width, a style and a color stated once for several sides:
		// four for `border`, the axis's two for `border-block` and
		// `border-inline`.
			indexed.length >= 2 * LINE_COMPONENTS.length &&
			LINE_COMPONENTS.every(
				(kind) =>
					indexed.filter((longhand) => longhand.endsWith(`-${kind}`))
						.length ===
						indexed.length / LINE_COMPONENTS.length,
			) ?
				"border" :
				indexed.length === LINE_COMPONENTS.length &&
				indexed.every((longhand, index) =>
					longhand.endsWith(`-${LINE_COMPONENTS[index]}`),
				) ?
					"line" :
					indexed.length === 2 && axisPair(shorthand, indexed) ?
						"pair" :
						"sequence",
	);
}

/**
 * Whether a two-longhand shorthand states ONE property on two axes -- `gap`,
 * `overflow`, `place-content`, `margin-inline` -- rather than two properties
 * side by side. An axis pair writes one value where its two agree, and copies
 * a single stated value to both; a shorthand like `flex-flow` writes each
 * component it has and drops the ones left at their initial value.
 *
 * The two longhands of an axis pair name the shorthand's own property: they
 * are built on it as a stem, or they end in the segment it ends in.
 */
function axisPair(shorthand: string, longhands: readonly string[]): boolean {
	if (longhands.every((longhand) => longhand.startsWith(shorthand))) {
		return true;
	}
	const segment = shorthand.slice(shorthand.lastIndexOf("-") + 1);
	return longhands.every((longhand) => longhand.endsWith(`-${segment}`));
}

/**
 * The shorthands a longhand belongs to, widest first: block serialization
 * prefers the shorthand covering the most declarations, and `all` -- covering
 * every longhand there is -- comes first of all. A vendor-prefixed shorthand
 * comes last however wide it is: `-webkit-border-start` covers exactly the
 * longhands `border-inline-start` does, and is not the name to write them as.
 */
const LONGHAND_SHORTHANDS = new Map<string, readonly string[]>();
{
	const byLonghand = new Map<string, string[]>();
	for (const [shorthand, longhands] of SHORTHAND_LONGHANDS) {
		for (const longhand of longhands) {
			let shorthands = byLonghand.get(longhand);
			if (!shorthands) {
				byLonghand.set(longhand, (shorthands = []));
			}
			shorthands.push(shorthand);
		}
	}
	for (const [longhand, shorthands] of byLonghand) {
		shorthands.sort(
			(a, b) =>
				Number(a.startsWith("-")) - Number(b.startsWith("-")) ||
				SHORTHAND_LONGHANDS.get(b)!.length -
				SHORTHAND_LONGHANDS.get(a)!.length ||
				(a < b ? -1 : 1),
		);
		LONGHAND_SHORTHANDS.set(longhand, shorthands);
	}
}

/**
 * A declared value in its CSSOM spelling: comments removed, runs of whitespace
 * collapsed to one space, no space inside a function's parentheses except the
 * single space that follows each comma. Strings pass through as authored.
 *
 * `property` names the property the value is declared on, and its grammar
 * decides the rest: a custom property is a stream of tokens and keeps every
 * number as it was written, a family name that spells a run of identifiers
 * drops its quotes, and a counter() naming the style every counter already
 * has drops the argument.
 */
function serializeCSSValue(input: string, property = ""): string {
	const custom = property.startsWith("--");
	let out = "";
	let space = false;
	const emit = (token: string): void => {
		if (out.endsWith(",")) {
			out += " ";
		} else if (space && out !== "" && !out.endsWith("(")) {
			out += " ";
		}
		space = false;
		out += token;
	};

	for (let i = 0; i < input.length; i++) {
		const character = input[i];
		if (WHITESPACE.has(character)) {
			space = out !== "";
			continue;
		}
		if (character === "/" && input[i + 1] === "*") {
			const end = input.indexOf("*/", i + 2);
			i = end === -1 ? input.length : end + 1;
			space = out !== "";
			continue;
		}
		if (character === '"' || character === "'") {
			const end = endOfString(input, i);
			emit(serializeCSSString(unescapeCSSString(input.slice(i + 1, end))));
			i = end;
			continue;
		}
		if (character === "," || character === ")") {
			out += character;
			space = false;
			continue;
		}
		if (startsNumber(input, i)) {
			const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(
				input.slice(i),
			)![0];
			i += number.length;
			const unit = /^(?:%|[a-zA-Z\u0080-\uFFFF]+)/.exec(input.slice(i))?.[0];
			if (unit) {
				i += unit.length;
			}
			emit(
				(custom ? number : serializeCSSNumber(number)) +
				(unit === "%" ? "%" : (unit?.toLowerCase() ?? "")),
			);
			i--;
			continue;
		}
		if (startsIdentifier(input, i)) {
			const name = /^[a-zA-Z0-9_\u0080-\uFFFF\\-]+/.exec(input.slice(i))![0];
			i += name.length;
			// A url() token's body is not an identifier list: it runs to the
			// closing parenthesis, quoted or not, and serializes quoted.
			if (name.toLowerCase() === "url" && input[i] === "(") {
				const end = input.indexOf(")", i);
				const body = input.slice(i + 1, end === -1 ? input.length : end).trim();
				const url =
					body.startsWith('"') || body.startsWith("'") ?
							unescapeCSSString(body.slice(1, -1)) :
							unescapeCSSString(body);
				emit(`url(${serializeCSSString(url)})`);
				i = end === -1 ? input.length : end;
				continue;
			}
			emit(name);
			i--;
			continue;
		}
		if (character === "#") {
			const name = /^#[a-zA-Z0-9_\u0080-\uFFFF\\-]*/.exec(input.slice(i))![0];
			emit(name);
			i += name.length - 1;
			continue;
		}
		emit(character);
	}
	return custom ? out : canonicalizeValue(property, out);
}

/**
 * A family name is a sequence of identifiers or a string, and the two spell
 * one name: `"Twisty Tie"` and `Twisty Tie` are the same family. The
 * identifier spelling is the canonical one, so a string that spells a valid
 * sequence loses its quotes.
 */
const FAMILY_IDENTIFIERS =
	/^[a-zA-Z_\u0080-\uffff-][\w\u0080-\uffff-]*(?: [a-zA-Z_\u0080-\uffff-][\w\u0080-\uffff-]*)*$/;

/** The properties whose value may name a font family. */
const FAMILY_PROPERTIES = new Set(["font", "font-family", "voice-family"]);

/**
 * The family names that name no family: the generic families and the reserved
 * words a font-family list may not spell as identifiers. Quoted, each names a
 * family of that name, so the quotes are what distinguishes it and it keeps
 * them.
 */
const RESERVED_FAMILY_NAMES = new Set([
	"cursive",
	"default",
	"emoji",
	"fangsong",
	"fantasy",
	"math",
	"monospace",
	"sans-serif",
	"serif",
	"system-ui",
	"ui-monospace",
	"ui-rounded",
	"ui-sans-serif",
	"ui-serif",
]);

/** The counter style a `counter()` or `counters()` takes when told none. */
const DEFAULT_COUNTER_STYLE = "decimal";

/**
 * The property-specific half of value serialization: what a value's own
 * grammar says its canonical spelling is, once tokenization has given every
 * value a uniform one.
 */
function canonicalizeValue(property: string, value: string): string {
	let out = value;
	if (FAMILY_PROPERTIES.has(property)) {
		out = out.replace(/"((?:[^"\\]|\\.)*)"/g, (quoted, body: string) => {
			const name = unescapeCSSString(body);
			const lower = name.toLowerCase();
			return FAMILY_IDENTIFIERS.test(name) &&
				!CSS_WIDE_KEYWORDS.has(lower) &&
				!RESERVED_FAMILY_NAMES.has(lower) ?
				name :
				quoted;
		});
	}
	// `counter(name, decimal)` counts what `counter(name)` counts, and the
	// shorter spelling is the one CSSOM writes.
	out = out.replace(
		/\b(counters?)\(([^()]*)\)/gi,
		(whole, name: string, args: string) => {
			const parts = args.split(",").map((part) => part.trim());
			const wanted = name.toLowerCase() === "counters" ? 3 : 2;
			if (parts.length !== wanted) {
				return whole;
			}
			if (parts[wanted - 1].toLowerCase() !== DEFAULT_COUNTER_STYLE) {
				return whole;
			}
			return `${name}(${parts.slice(0, wanted - 1).join(", ")})`;
		},
	);
	return out;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

function endOfString(input: string, start: number): number {
	const quote = input[start];
	for (let i = start + 1; i < input.length; i++) {
		if (input[i] === "\\") {
			i++;
		} else if (input[i] === quote) {
			return i;
		}
	}
	return input.length;
}

function unescapeCSSString(text: string): string {
	return text.replace(/\\(.)/g, "$1");
}

/** Whether a number token begins at `index`. */
function startsNumber(input: string, index: number): boolean {
	const rest = input.slice(index, index + 3);
	return /^[+-]?(\d|\.\d)/.test(rest);
}

/** Whether an identifier begins at `index`. */
function startsIdentifier(input: string, index: number): boolean {
	return /^[a-zA-Z_\u0080-\uFFFF\\-]/.test(input[index]);
}

/**
 * Serialize a number as CSSOM says: the shortest form that round-trips, with
 * no leading `+`, no bare leading `.`, and no negative zero.
 */
function serializeCSSNumber(text: string): string {
	const value = Number(text);
	if (!Number.isFinite(value)) {
		return text;
	}
	if (Object.is(value, -0)) {
		return "0";
	}
	const out = String(value);
	return out.includes("e") ? expandExponential(out) : out;
}

/**
 * A number written in base ten, however large or small: CSS has no scientific
 * notation, so `1e24` is written with its twenty-four zeros.
 */
function expandExponential(text: string): string {
	const parts = /^([+-]?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
	if (!parts) {
		return text;
	}
	const [, sign, whole, fraction = "", exponentText] = parts;
	const exponent = Number(exponentText);
	const digits = whole + fraction;
	const point = whole.length + exponent;
	if (point <= 0) {
		return `${sign}0.${"0".repeat(-point)}${digits}`;
	}
	if (point >= digits.length) {
		return `${sign}${digits}${"0".repeat(point - digits.length)}`;
	}
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Serialize a string: double-quoted, with quotes and backslashes escaped. */
function serializeCSSString(text: string): string {
	return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * Serialize an identifier: what `CSS.escape` answers. A code point that could
 * not stand in an identifier is written as a hex escape, and one that merely
 * needs quoting takes a backslash.
 */
function serializeCSSIdentifier(value: string): string {
	const text = String(value);
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const character = text[i];
		if (code === 0) {
			out += "�";
		} else if (
			(code >= 0x1 && code <= 0x1f) ||
			code === 0x7f ||
			(i === 0 && code >= 0x30 && code <= 0x39) ||
			(i === 1 && code >= 0x30 && code <= 0x39 && text.charCodeAt(0) === 0x2d)
		) {
			out += `\\${code.toString(16)} `;
		} else if (i === 0 && code === 0x2d && text.length === 1) {
			out += `\\${character}`;
		} else if (
			code >= 0x80 ||
			code === 0x2d ||
			code === 0x5f ||
			(code >= 0x30 && code <= 0x39) ||
			(code >= 0x41 && code <= 0x5a) ||
			(code >= 0x61 && code <= 0x7a)
		) {
			out += character;
		} else {
			out += `\\${character}`;
		}
	}
	return out;
}

/**
 * Whether a declaration would be honoured: `CSS.supports(property, value)`, and
 * the one-argument form that takes a `@supports` condition.
 */
function cssSupports(conditionOrProperty: string, value?: string): boolean {
	if (value === undefined) {
		const condition = String(conditionOrProperty).trim();
		// `selector(...)` asks whether a selector parses, which is exactly
		// what the cascade's own selector parser answers.
		const selector = /^selector\(([\s\S]*)\)$/.exec(condition);
		if (selector) {
			return parseSelectorList(selector[1]) !== null;
		}
		if (!condition.startsWith("(") || !condition.endsWith(")")) {
			return false;
		}
		const inner = condition.slice(1, -1);
		const colon = inner.indexOf(":");
		if (colon === -1) {
			return false;
		}
		return cssSupports(inner.slice(0, colon), inner.slice(colon + 1));
	}
	const property = normalizePropertyName(conditionOrProperty);
	if (property.startsWith("--")) {
		return true;
	}
	if (!SUPPORTED_PROPERTIES.has(property)) {
		return false;
	}
	const text = serializeCSSValue(String(value), property);
	return text !== "" && isValidDeclaration(property, text);
}

/** The `CSS` namespace object: identifier escaping and support queries. */
const CSSNamespace = {
	escape(ident: string): string {
		if (arguments.length === 0) {
			throw typeError("escape requires an identifier");
		}
		return serializeCSSIdentifier(String(ident));
	},
	supports: cssSupports,
};
// A namespace object's class string is its name, and it is not writable.
Object.defineProperty(CSSNamespace, Symbol.toStringTag, {
	value: "CSS",
	writable: false,
	enumerable: false,
	configurable: true,
});

/** The declarations of a `style` attribute, a `cssText`, or a rule's block. */
function parseDeclarationText(text: string): CSSDeclaration[] {
	const declarations: CSSDeclaration[] = [];
	let depth = 0;
	let start = 0;
	const push = (end: number): void => {
		const source = text.slice(start, end);
		start = end + 1;
		const colon = source.indexOf(":");
		if (colon === -1) {
			return;
		}
		const name = parsePropertyName(source.slice(0, colon));
		if (!name) {
			return;
		}
		let value = serializeCSSValue(source.slice(colon + 1), name);
		let important = false;
		// `!` and `important` are two tokens, and whitespace or a comment may
		// stand between them.
		const bang = /!\s*important\s*$/i.exec(value);
		if (bang) {
			important = true;
			value = value.slice(0, bang.index).trim();
		}
		if (!value) {
			return;
		}
		declarations.push({name, value, important});
	};
	for (let i = 0; i < text.length; i++) {
		const character = text[i];
		if (character === "\\") {
			i++;
		} else if (character === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 1;
		} else if (character === '"' || character === "'") {
			for (i++; i < text.length && text[i] !== character; i++) {
				if (text[i] === "\\") {
					i++;
				}
			}
		} else if (character === "(" || character === "[" || character === "{") {
			depth++;
		} else if (character === ")" || character === "]" || character === "}") {
			depth--;
		} else if (character === ";" && depth <= 0) {
			push(i);
		}
	}
	push(text.length);
	return declarations;
}

/**
 * A shorthand's value as its longhands, every longhand the shorthand covers
 * given a value -- the ones its grammar leaves out reset to their initial
 * value, as a browser's shorthand write does. Null for a shorthand whose
 * grammar this engine does not decompose, which stays a declaration of its own.
 */
function expandShorthandValue(
	property: string,
	value: string,
): Record<string, string> | null {
	const longhands = SHORTHAND_LONGHANDS.get(property);
	if (!longhands) {
		return null;
	}
	// A CSS-wide keyword is the whole value of every longhand the shorthand
	// covers -- which is all of them, for `all`.
	if (CSS_WIDE_KEYWORDS.has(value.toLowerCase())) {
		return Object.fromEntries(
			longhands.map((longhand) => [longhand, value.toLowerCase()]),
		);
	}
	const expanded = expandShorthands({[property]: value});
	const out: Record<string, string> = {};
	let decomposed = false;
	for (const longhand of longhands) {
		if (expanded[longhand] === undefined) {
			continue;
		}
		out[longhand] = expanded[longhand];
		decomposed = true;
	}
	if (!decomposed) {
		return null;
	}
	for (const longhand of longhands) {
		if (longhand in out) {
			continue;
		}
		const initial = CSS_INITIAL_VALUES[longhand];
		if (initial) {
			out[longhand] = initial;
		}
	}
	// Longhand order follows the shorthand's grammar, not the fill order.
	const ordered: Record<string, string> = {};
	for (const longhand of longhands) {
		if (longhand in out) {
			ordered[longhand] = out[longhand];
		}
	}
	return ordered;
}

/**
 * A corner radius as its two axes, the vertical one taken from the horizontal
 * where the value states a single radius.
 */
function radiusAxes(value: string): [string, string] {
	const [horizontal, vertical = horizontal] = value
		.split(/\s+/)
		.filter(Boolean);
	return [horizontal ?? "0px", vertical ?? "0px"];
}

/** The four values of a box shorthand, collapsed to the shortest equivalent. */
function collapseSides(values: string[]): string {
	const [top, right, bottom, left] = values;
	if (left !== right) {
		return `${top} ${right} ${bottom} ${left}`;
	}
	if (bottom !== top) {
		return `${top} ${right} ${bottom}`;
	}
	if (right !== top) {
		return `${top} ${right}`;
	}
	return top;
}

/**
 * The longhands of `shorthand` grouped by the side or corner each names, in
 * the order the shorthand's grammar writes them, or null when the longhands
 * are not a box.
 */
function boxOrder(
	longhands: readonly string[],
	parts: readonly string[],
): string[] | null {
	if (longhands.length !== parts.length) {
		return null;
	}
	const byPart = new Map<string, string>();
	let stem: string | null = null;
	for (const longhand of longhands) {
		let matched: string | null = null;
		for (const part of parts) {
			const pattern = new RegExp(`(^|-)${part}(-|$)`);
			if (!pattern.test(longhand)) {
				continue;
			}
			if (matched === null || part.length > matched.length) {
				matched = part;
			}
		}
		if (matched === null) {
			return null;
		}
		const rest = longhand.replace(new RegExp(`(^|-)${matched}(-|$)`), "$1$2");
		if (stem === null) {
			stem = rest;
		} else if (stem !== rest) {
			return null;
		}
		if (byPart.has(matched)) {
			return null;
		}
		byPart.set(matched, longhand);
	}
	const ordered = parts.map((part) => byPart.get(part));
	return ordered.every((name): name is string => name !== undefined) ?
		ordered :
		null;
}

/** A shorthand's value, reconstructed from its longhands' values. */
function serializeShorthandValue(
	shorthand: string,
	longhands: readonly string[],
	valueOf: (longhand: string) => string,
): string {
	const all = longhands.map(valueOf);
	// A CSS-wide keyword serializes as itself only when every longhand holds
	// the same one; one longhand overridden and the shorthand has no value.
	if (all.some((value) => CSS_WIDE_KEYWORDS.has(value))) {
		return all.every((value) => value === all[0]) ? all[0] : "";
	}

	// A longhand the shorthand resets without stating -- border-image under
	// `border` -- takes no place in the value written, and a value of its own
	// that the shorthand cannot express means it cannot be written at all.
	const reset = RESET_ONLY_LONGHANDS.get(shorthand);
	if (reset) {
		for (const longhand of longhands) {
			if (
				reset.has(longhand) &&
				valueOf(longhand) !== CSS_INITIAL_VALUES[longhand]
			) {
				return "";
			}
		}
	}
	const stated = reset ?
			longhands.filter((longhand) => !reset.has(longhand)) :
		longhands;
	const values = reset ? stated.map(valueOf) : all;

	switch (SHORTHAND_SHAPES.get(shorthand)) {
		case "box":
			return collapseSides(values);
		// `border-radius` writes the four horizontal radii, then the four
		// vertical ones after a slash -- and drops the slash entirely where
		// the two axes agree, which is every circular corner.
		case "radius": {
			const axes = values.map(radiusAxes);
			const across = collapseSides(axes.map(([horizontal]) => horizontal));
			const down = collapseSides(axes.map(([, vertical]) => vertical));
			return across === down ? across : `${across} / ${down}`;
		}
		// `border` and its logical twins are three uniform boxes -- widths,
		// styles and colors -- and serialize only when every side agrees.
		case "border": {
			const components: Array<[string, string]> = [];
			for (const kind of LINE_COMPONENTS) {
				const sides = stated.filter((longhand) =>
					longhand.endsWith(`-${kind}`),
				);
				const sideValues = sides.map(valueOf);
				if (sideValues.some((value) => value !== sideValues[0])) {
					return "";
				}
				components.push([sides[0], sideValues[0]]);
			}
			return dropInitials(components);
		}
		// `border-top`, `outline`, `column-rule`: a line's width, style and
		// color.
		case "line":
			return dropInitials(
				stated.map((longhand, index) => [longhand, values[index]] as const),
			);
		case "pair":
			return values[0] === values[1] ? values[0] : values.join(" ");
		default:
			return dropInitials(
				stated.map((longhand, index) => [longhand, values[index]] as const),
			);
	}
}

/**
 * A shorthand's components with the ones left at their initial value omitted,
 * which is what makes `border-top: 1px solid` serialize without its color.
 * `required` names a component index written whatever its value.
 */
function dropInitials(
	components: ReadonlyArray<readonly [string, string]>,
	required = -1,
): string {
	const kept = components
		.filter(([longhand, value], index) => {
			if (index === required) {
				return true;
			}
			const initial = CSS_INITIAL_VALUES[longhand];
			return !initial || value !== initial;
		})
		.map(([, value]) => value);
	if (kept.length > 0) {
		return kept.join(" ");
	}
	return components.length > 0 ? components[0][1] : "";
}

/**
 * The CSSOM algorithm turning a property name into the IDL attribute that
 * reflects it: `font-size` to `fontSize`, and -- with the lowercase-first flag
 * a `-webkit-` property also carries -- `-webkit-mask` to `webkitMask` as well
 * as `WebkitMask`.
 */
function camelCaseProperty(property: string, lowercaseFirst = false): string {
	const source = lowercaseFirst ? property.slice(1) : property;
	return source.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
}

/**
 * The inline style objects, one per element, that `element.style` hands out.
 */
const inlineStyles = new WeakMap<Element, CSSStyleDeclaration>();

/** Marks a prototype whose `style` accessor is already the engine's. */
const kInlineStyleInstalled = Symbol("termdom.inlineStyle");

/**
 * A CSS declaration block: what `element.style`, a style rule's `style`, and
 * every other CSSOM block are.
 *
 * Declarations are stored as longhands, so a shorthand write expands and a
 * shorthand read reconstructs -- `style.margin = "1px"` answers
 * `style.marginTop === "1px"`, and `style.marginTop = "2px"` answers
 * `style.margin === "1px 1px 1px 2px"`.
 *
 * An element-owned block and the element's `style` attribute are one store
 * seen from two sides. A write serializes through setAttribute, so the
 * attribute mutation record invalidation listens to fires for a property write
 * exactly as for an attribute write; a write to the attribute (or its removal)
 * reparses into the object on the next read, recognized by the text differing
 * from what this object last serialized.
 */
export class CSSStyleDeclaration implements DeclarationSource {
	[index: number]: string;
	declare [kElement]: Element | null;
	declare [kParentRule]: CSSRule | null;
	declare [kOnChange]: (() => void) | null;
	/**
	 * The at-rule whose descriptors this block holds, empty for a block of CSS
	 * properties. A descriptor is named only inside its own at-rule, and only
	 * its own at-rule's grammar can judge its value.
	 */
	declare [kDescriptors]: string;
	/** Whether this block is one keyframe of an animation. */
	declare [kKeyframe]: boolean;
	declare [kDeclarations]: CSSDeclaration[];
	/**
	 * The declarations by name. A block holds one declaration per property, so
	 * a lookup is a map read; `all` expands to every longhand there is, and a
	 * scan per lookup would make serializing such a block cubic in its size.
	 */
	declare [kByName]: Map<string, CSSDeclaration>;
	/** The `style` attribute text this object last serialized or parsed. */
	declare [kAttributeText]: string | null;
	/** The declarations expanded to longhands for the cascade. */
	declare [kBlock]: DeclarationBlock | null;
	/** How many numeric index properties currently name a declaration. */
	declare [kIndexed]: number;

	constructor(
		owner: {
			element?: Element;
			parentRule?: CSSRule;
			onChange?: () => void;
			descriptors?: string;
			keyframe?: boolean;
		} = {},
	) {
		this[kDescriptors] = "";
		this[kKeyframe] = false;
		this[kDeclarations] = [];
		this[kByName] = new Map<string, CSSDeclaration>();
		this[kAttributeText] = null;
		this[kBlock] = null;
		this[kIndexed] = 0;
		this[kElement] = owner.element ?? null;
		this[kParentRule] = owner.parentRule ?? null;
		this[kOnChange] = owner.onChange ?? null;
		this[kDescriptors] = owner.descriptors ?? "";
		this[kKeyframe] = Boolean(owner.keyframe);
	}

	/** Adopt the `style` attribute when it says something this object did not write. */
	[kSync](): void {
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
		for (const declaration of parseDeclarationText(text)) {
			this[kApply](
				declaration.name,
				declaration.value,
				declaration.important,
				true,
			);
		}
		this[kInvalidate]();
	}

	/** Serialize a CSS declaration block: shorthands reconstructed, priority kept. */
	[kSerialize](): string {
		const parts: string[] = [];
		const serialized = new Set<string>();
		// A shorthand this block cannot express is one it cannot express at
		// any of its longhands: the declarations do not change under the walk.
		const unserializable = new Set<string>();
		for (const declaration of this[kDeclarations]) {
			if (serialized.has(declaration.name)) {
				continue;
			}
			let text = "";
			for (const shorthand of LONGHAND_SHORTHANDS.get(declaration.name) ?? []) {
				if (unserializable.has(shorthand)) {
					continue;
				}
				const longhands = SHORTHAND_LONGHANDS.get(shorthand)!;
				// A shorthand covering more properties than the block holds
				// cannot be serialized from it, and `all` covers hundreds.
				if (longhands.length > this[kDeclarations].length) {
					continue;
				}
				const value = this[kShorthandValue](shorthand, longhands);
				if (!value) {
					unserializable.add(shorthand);
					continue;
				}
				const important = this[kFind](longhands[0])!.important;
				text = `${shorthand}: ${value}${important ? " !important" : ""};`;
				for (const longhand of longhands) {
					serialized.add(longhand);
				}
				break;
			}
			if (!text) {
				const priority = declaration.important ? " !important" : "";
				text = `${serializePropertyName(declaration.name)}: ${
					declaration.value
				}${priority};`;
				serialized.add(declaration.name);
			}
			parts.push(text);
		}
		return parts.join(" ");
	}

	/** Serialize to the `style` attribute, which is what invalidation observes. */
	[kFlush](): void {
		this[kInvalidate]();
		if (this[kElement]) {
			this[kAttributeText] = this[kSerialize]();
			this[kElement].setAttribute("style", this[kAttributeText]);
		}
		this[kOnChange]?.();
	}

	[kInvalidate](): void {
		this[kBlock] = null;
		for (let i = 0; i < this[kIndexed]; i++) {
			delete this[i];
		}
		this[kIndexed] = this[kDeclarations].length;
		for (let i = 0; i < this[kIndexed]; i++) {
			this[i] = this[kDeclarations][i].name;
		}
	}

	[kFind](property: string): CSSDeclaration | undefined {
		return this[kByName].get(property);
	}

	/**
	 * Whether this block may hold `name`: a supported CSS property or a custom
	 * property, or -- in an at-rule's block -- any descriptor it names, since
	 * the property index does not describe descriptors.
	 */
	[kSupports](name: string): boolean {
		// A keyframe's block is a step of an animation, and the animation's own
		// properties describe the whole rather than the step.
		if (this[kKeyframe] && KEYFRAME_EXCLUDED.test(name)) {
			return false;
		}
		if (this[kDescriptors]) {
			// An at-rule's block holds its own descriptors. One this engine
			// has no descriptor list for holds whatever it is given, which is
			// what keeps @font-feature-values' feature blocks working.
			const names = DESCRIPTOR_NAMES.get(this[kDescriptors]);
			return names ? names.has(name) : name !== "";
		}

		return name.startsWith("--") || SUPPORTED_PROPERTIES.has(name);
	}

	/**
	 * Store one declaration; returns whether anything changed.
	 *
	 * A declaration that says something new is the LAST declaration in the
	 * block: it was written after the ones already there, and the order the
	 * block serializes in is the order its declarations were made. Restating
	 * a declaration unchanged leaves it where it stands.
	 */
	[kStore](
		name: string,
		value: string,
		important: boolean,
		cascade = false,
	): boolean {
		const declared = this[kFind](name);
		if (declared) {
			// Parsing a block is a cascade in miniature: a normal declaration
			// does not displace the important one already standing there.
			if (cascade && declared.important && !important) {
				return false;
			}
			if (declared.value === value && declared.important === important) {
				return false;
			}
			this[kRemove](name);
		}
		const entry = {name, value, important};
		this[kDeclarations].push(entry);
		this[kByName].set(name, entry);
		return true;
	}

	[kRemove](name: string): boolean {
		const index = this[kDeclarations].findIndex((entry) => entry.name === name);
		if (index === -1) {
			return false;
		}
		this[kDeclarations].splice(index, 1);
		this[kByName].delete(name);
		return true;
	}

	/** Store a property as its longhands, or as itself; returns whether it changed. */
	[kApply](
		name: string,
		value: string,
		important: boolean,
		cascade = false,
	): boolean {
		// A declaration whose value does not parse is not stored at all, so a
		// shorthand with one bad component drops whole rather than leaving its
		// good components behind.
		if (!isValidDeclaration(name, value, this[kDescriptors])) {
			return false;
		}
		const expanded = expandShorthandValue(name, value);
		if (!expanded) {
			return this[kStore](name, value, important, cascade);
		}
		let changed = this[kRemove](name);
		for (const longhand of SHORTHAND_LONGHANDS.get(name)!) {
			if (longhand in expanded) {
				continue;
			}
			if (cascade && this[kFind](longhand)?.important && !important) {
				continue;
			}
			changed = this[kRemove](longhand) || changed;
		}
		for (const [longhand, longhandValue] of Object.entries(expanded)) {
			changed =
				this[kStore](longhand, longhandValue, important, cascade) || changed;
		}
		return changed;
	}

	/** The shorthand's value, or "" when its longhands do not agree on one. */
	[kShorthandValue](shorthand: string, longhands: readonly string[]): string {
		let important: boolean | null = null;
		for (const longhand of longhands) {
			const declared = this[kFind](longhand);
			if (!declared) {
				return "";
			}
			if (important === null) {
				important = declared.important;
			} else if (important !== declared.important) {
				return "";
			}
		}
		return serializeShorthandValue(
			shorthand,
			longhands,
			(longhand) => this[kFind](longhand)!.value,
		);
	}

	/** The declarations as the cascade consumes them: longhands, importance included. */
	declarationBlock(): DeclarationBlock {
		this[kSync]();
		if (this[kDeclarations].length === 0) {
			return EMPTY_DECLARATIONS;
		}
		if (this[kBlock]) {
			return this[kBlock];
		}

		const declarations: Record<string, string> = {};
		const important: Record<string, boolean> = {};
		const order: Record<string, number> = {};
		const importantValues: Record<string, string> = {};
		let undecomposed = false;
		this[kDeclarations].forEach((entry, index) => {
			// An invalid declaration never enters the cascade: dropping it is
			// what lets a lower-priority rule keep winning, as a browser does.
			if (!isValidDeclaration(entry.name, entry.value)) {
				return;
			}
			declarations[entry.name] = entry.value;
			order[entry.name] = index;
			if (entry.important) {
				important[entry.name] = true;
				importantValues[entry.name] = entry.value;
			}
			if (SHORTHAND_LONGHANDS.has(entry.name)) {
				undecomposed = true;
			}
		});

		// The block holds longhands, which is what the cascade consults --
		// except for a shorthand whose grammar this engine does not decompose,
		// which reaches the cascade as whatever longhands it can name, its
		// importance covering each of them. A longhand a shorthand states
		// stands where the shorthand does.
		if (undecomposed) {
			for (const property of Object.keys(expandShorthands(importantValues))) {
				important[property] = true;
			}
			this[kDeclarations].forEach((entry, index) => {
				const expanded = expandShorthands({[entry.name]: entry.value});
				for (const property in expanded) {
					order[property] = index;
				}
			});
			return (this[kBlock] = {
				declarations: expandShorthands(declarations),
				important,
				order,
			});
		}
		return (this[kBlock] = {declarations, important, order});
	}

	get parentRule(): CSSRule | null {
		return this[kParentRule];
	}

	get length(): number {
		this[kSync]();
		return this[kDeclarations].length;
	}

	item(index: number): string {
		this[kSync]();
		return this[kDeclarations][index]?.name ?? "";
	}

	[Symbol.iterator](): IterableIterator<string> {
		this[kSync]();
		return this[kDeclarations].map((entry) => entry.name)[Symbol.iterator]();
	}

	getPropertyValue(property: string): string {
		this[kSync]();
		const name = normalizePropertyName(property);
		const declared = this[kFind](name);
		if (declared) {
			return declared.value;
		}
		const longhands = SHORTHAND_LONGHANDS.get(name);
		return longhands ? this[kShorthandValue](name, longhands) : "";
	}

	getPropertyPriority(property: string): string {
		this[kSync]();
		const name = normalizePropertyName(property);
		const declared = this[kFind](name);
		if (declared) {
			return declared.important ? "important" : "";
		}
		const longhands = SHORTHAND_LONGHANDS.get(name);
		if (
			longhands &&
			longhands.every((longhand) => this[kFind](longhand)?.important)
		) {
			return "important";
		}
		return "";
	}

	setProperty(property: string, value: string, priority?: string): void {
		this[kSync]();
		const name = normalizePropertyName(property);
		if (!this[kSupports](name)) {
			return;
		}
		// `[LegacyNullToEmptyString]`: null names the empty value, which removes
		// the declaration. Every other value is stringified, and `undefined`
		// stringifies to a value no property has -- so the call does nothing.
		const text = serializeCSSValue(value === null ? "" : String(value), name);
		if (text === "") {
			this.removeProperty(name);
			return;
		}
		const priorityText = String(priority ?? "").toLowerCase();
		if (priorityText !== "" && priorityText !== "important") {
			return;
		}
		if (this[kApply](name, text, priorityText === "important")) {
			this[kFlush]();
		}
	}

	removeProperty(property: string): string {
		this[kSync]();
		const name = normalizePropertyName(property);
		const previous = this.getPropertyValue(name);
		let changed = this[kRemove](name);
		for (const longhand of SHORTHAND_LONGHANDS.get(name) ?? []) {
			changed = this[kRemove](longhand) || changed;
		}
		if (changed) {
			this[kFlush]();
		}
		return previous;
	}

	get cssText(): string {
		this[kSync]();
		return this[kSerialize]();
	}

	set cssText(text: string) {
		this[kSync]();
		this[kDeclarations] = [];
		this[kByName].clear();
		for (const declaration of parseDeclarationText(text ?? "")) {
			if (!this[kSupports](declaration.name)) {
				continue;
			}
			this[kApply](
				declaration.name,
				declaration.value,
				declaration.important,
				true,
			);
		}
		this[kFlush]();
	}
}

/** Custom properties keep their case; everything else is ASCII-lowercased. */
/**
 * The declaration block of CSS PROPERTIES: an element's inline style, a style
 * rule's block, a keyframe's. It reflects every property in the index as an
 * IDL attribute, which is what separates it from the descriptor blocks an
 * at-rule holds -- `cssFloat` reaches a style rule's block and no @page's.
 */
export class CSSStyleProperties extends CSSStyleDeclaration {}

function normalizePropertyName(property: string): string {
	const name = String(property).trim();
	return name.startsWith("--") ? name : name.toLowerCase();
}

/**
 * A property name as CSS source spells it. A custom property's name is an
 * identifier, so the escapes in it spell characters that could not otherwise
 * stand there: the source `--a\;b` names the property `--a;b`.
 */
function parsePropertyName(source: string): string {
	const name = String(source).trim();
	if (!name.startsWith("--")) {
		return normalizePropertyName(name);
	}
	return name.includes("\\") ?
		`--${cssTree.ident.decode(name.slice(2))}` :
		name;
}

/**
 * A property name as a declaration block writes it: a custom property's name
 * escaped so that reparsing the block names the same property, every other
 * name already an identifier.
 */
function serializePropertyName(property: string): string {
	return property.startsWith("--") ?
		`--${serializeCSSIdentifier(property.slice(2))}` :
		property;
}

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
	const names = [camelCaseProperty(property)];
	if (property.startsWith("-webkit-")) {
		names.push(camelCaseProperty(property, true));
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

/** Marks a prototype whose invalidation hooks are already installed. */
const kInvalidationHooksInstalled = Symbol("termdom.invalidationHooks");

/**
 * Tell the cascade about the writes that change what a selector matches: a
 * style, class or id attribute, and a shadow root becoming a tree scope of it.
 *
 * The element prototype is the realm's, shared by every document in it, so
 * this runs once and each call finds the cascade its element belongs to.
 * Installing per cascade would wrap a wrapper and leave every earlier one on
 * the chain.
 */
function installInvalidationHooks(window: EngineWindow): void {
	const Element = window.Element;
	const owner = Element.prototype as unknown as Record<symbol, unknown>;
	if (owner[kInvalidationHooksInstalled]) {
		return;
	}
	owner[kInvalidationHooksInstalled] = true;

	const managerOf = (element: Element): StyleManager | undefined =>
		documentManagers.get(element.ownerDocument as object);

	const originalSetAttribute = Element.prototype.setAttribute;
	const originalRemoveAttribute = Element.prototype.removeAttribute;
	const originalAttachShadow = Element.prototype.attachShadow;

	// A shadow root is a tree scope of the cascade: the rules its own <style>
	// elements and adopted sheets declare reach its elements and no others, so
	// the cascade has to be told the tree exists the moment it does.
	Element.prototype.attachShadow = function (
		this: Element,
		init: ShadowRootInit,
	): ShadowRoot {
		const root = originalAttachShadow.call(this, init);
		managerOf(this)?.registerShadowRoot(root);
		return root;
	};

	Element.prototype.setAttribute = function (
		this: Element,
		name: string,
		value: string,
	) {
		const result = originalSetAttribute.call(this, name, value);
		if (name === "style" || name === "class" || name === "id") {
			managerOf(this)?.invalidateElement(this);
		}
		return result;
	};

	Element.prototype.removeAttribute = function (this: Element, name: string) {
		const result = originalRemoveAttribute.call(this, name);
		if (name === "style" || name === "class" || name === "id") {
			managerOf(this)?.invalidateElement(this);
		}
		return result;
	};
}

/**
 * Put this engine's CSSOM behind `element.style`.
 *
 * ElementCSSInlineStyle is the interface the accessor belongs to, and the DOM
 * of a terminal has no cascade of its own to declare it: the accessor is the
 * cascade's, installed on the HTML and SVG element prototypes that mix the
 * interface in.
 */
export function installInlineStyle(window: EngineWindow): void {
	const roots = [window.HTMLElement?.prototype, window.SVGElement?.prototype];
	for (const root of roots) {
		if (!root) {
			continue;
		}
		let declaring: object | null = root;
		while (declaring) {
			if (Object.prototype.hasOwnProperty.call(declaring, "style")) {
				break;
			}
			declaring = Object.getPrototypeOf(declaring);
		}
		const prototype: object = declaring ?? root;
		const owner = prototype as Record<string | symbol, unknown>;
		if (owner[kInlineStyleInstalled]) {
			continue;
		}
		owner[kInlineStyleInstalled] = true;
		Object.defineProperty(prototype, "style", {
			get(this: Element) {
				let style = inlineStyles.get(this);
				if (!style) {
					style = new CSSStyleProperties({element: this});
					inlineStyles.set(this, style);
				}
				return style;
			},
			set(this: Element, value: unknown) {
				(this as HTMLElement).style.cssText = value == null ? "" : `${value}`;
			},
			configurable: true,
			enumerable: true,
		});
	}
}

// ============================================================================
// CSSOM: STYLESHEETS AND RULES
// ============================================================================

/**
 * The window whose CSSOM was installed last.
 *
 * An error thrown out of a stylesheet has to be the document's own
 * DOMException -- one from another global is not the error an author catches.
 * A sheet reaches its document through its owner node; a constructed one has
 * none, and takes the window its constructor came from.
 */
let cssomWindow: EngineWindow | null = null;

function typeError(message: string, sheet?: CSSStyleSheet | null): TypeError {
	const view =
		sheet?.ownerNode?.ownerDocument?.defaultView ?? cssomWindow ?? undefined;
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
	const view =
		sheet?.ownerNode?.ownerDocument?.defaultView ?? cssomWindow ?? undefined;
	const Exception =
		(view as unknown as {DOMException?: typeof DOMException} | undefined)
			?.DOMException ?? DOMException;
	return new Exception(message, name);
}

/** The rule types CSSRule's legacy constants name. */
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

/**
 * What a sheet does when its rules -- or a declaration inside one of them --
 * change: tell whoever consumes it. Registered per sheet rather than exposed
 * on it, so a rule can reach its sheet's consumer without the sheet carrying
 * a method no author should see.
 */
const sheetNotifiers = new WeakMap<CSSStyleSheet, () => void>();

function sheetChanged(sheet: CSSStyleSheet | null | undefined): void {
	if (sheet) {
		sheetNotifiers.get(sheet)?.();
	}
}

const kIndexCount = Symbol("index count");

interface IndexedCollection {
	readonly length: number;
	item(index: number): unknown;
	[kIndexCount]?: number;
	[index: number]: unknown;
}

/**
 * Define the collection's own index accessors, `list[0]` alongside
 * `list.item(0)`. Each accessor reads through item(), so the values are as
 * live as the collection; only the count is maintained, re-synchronized here
 * by whatever grows or shrinks the collection. Accessors beat a Proxy: every
 * non-index read of a proxied list pays the get trap, and each method read
 * pays a bind.
 */
function syncIndexed(collection: object, items?: readonly unknown[]): void {
	const list = collection as IndexedCollection;
	const previous = list[kIndexCount] ?? 0;
	const length = items ? items.length : list.length;
	for (let index = previous; index < length; index++) {
		Object.defineProperty(list, index, {
			get: items ?
					(): unknown => items[index] :
					(): unknown => list.item(index) ?? undefined,
			enumerable: true,
			configurable: true,
		});
	}
	for (let index = length; index < previous; index++) {
		delete list[index];
	}
	list[kIndexCount] = length;
}

/** The media queries a sheet or an `@media` rule applies under. */
/**
 * The top-level `and`-separated conditions of one media query. Whitespace
 * inside a feature's parentheses belongs to the feature.
 */
function splitMediaConditions(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === "(") {
			depth++;
		} else if (character === ")") {
			depth--;
		} else if (depth === 0 && WHITESPACE.has(character)) {
			const joiner = /^\s+and\s+/i.exec(text.slice(index));
			if (!joiner) {
				continue;
			}
			parts.push(text.slice(start, index));
			index += joiner[0].length - 1;
			start = index + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.map((part) => part.trim()).filter(Boolean);
}

/** One media feature, in its canonical spelling: `(min-width: 480px)`. */
function serializeMediaFeature(feature: string): string {
	const body = feature.slice(1, -1).trim();
	const colon = body.indexOf(":");
	if (colon === -1) {
		return `(${body.toLowerCase()})`;
	}
	const name = body.slice(0, colon).trim().toLowerCase();
	return `(${name}: ${serializeCSSValue(body.slice(colon + 1))})`;
}

/**
 * One media query, in the spelling CSSOM writes: the type and the feature
 * names case-folded, one space after each colon, and the media type dropped
 * where it says nothing -- `all and (color)` is the query `(color)` is, while
 * `not all and (color)` negates the pair and keeps it.
 */
function serializeMediaQuery(query: string): string {
	const text = String(query ?? "").trim();
	if (!text) {
		return "";
	}
	const parts = splitMediaConditions(text);
	if (parts.length === 0) {
		return "";
	}
	let head = parts[0];
	let modifier = "";
	const prefixed = /^(not|only)\s+([^]*)$/i.exec(head);
	if (prefixed) {
		modifier = `${prefixed[1].toLowerCase()} `;
		head = prefixed[2].trim();
	}
	const conditions = parts
		.slice(1)
		.map((part) =>
			part.startsWith("(") ? serializeMediaFeature(part) : part.toLowerCase(),
		);
	if (head.startsWith("(")) {
		return (
			modifier + [serializeMediaFeature(head), ...conditions].join(" and ")
		);
	}
	const type = head.toLowerCase();
	if (type === "all" && !modifier && conditions.length > 0) {
		return conditions.join(" and ");
	}
	return modifier + [type, ...conditions].join(" and ");
}

/** A media query list's queries: split on the commas no parenthesis encloses. */
function splitMediaQueryList(text: string): string[] {
	const queries: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === "(") {
			depth++;
		} else if (character === ")") {
			depth--;
		} else if (character === "," && depth === 0) {
			queries.push(text.slice(start, index));
			start = index + 1;
		}
	}
	queries.push(text.slice(start));
	return queries;
}

export class MediaList {
	/**
	 * The queries, in their canonical spelling. Mutated in place: the indexed
	 * getter reads this array, and a list an author holds keeps answering.
	 */
	declare [kMedia]: string[];
	declare [kOnChange]: (() => void) | null;

	constructor(mediaText = "", onChange?: () => void) {
		this[kMedia] = [];
		this[kOnChange] = onChange ?? null;
		this[kParse](mediaText);
	}

	[kParse](text: string): void {
		this[kMedia].length = 0;
		for (const query of splitMediaQueryList(String(text ?? ""))) {
			const serialized = serializeMediaQuery(query);
			if (serialized) {
				this[kMedia].push(serialized);
			}
		}
		syncIndexed(this);
	}

	get mediaText(): string {
		return this[kMedia].join(", ");
	}

	set mediaText(text: string) {
		this[kParse](text);
		this[kOnChange]?.();
	}

	get length(): number {
		return this[kMedia].length;
	}

	item(index: number): string | null {
		return this[kMedia][index] ?? null;
	}

	/**
	 * Append one query. The argument is parsed as a SINGLE media query, so a
	 * comma-separated list parses to nothing and the call does nothing; a
	 * query the list already holds is not held twice.
	 */
	appendMedium(medium: string): void {
		if (arguments.length === 0) {
			throw typeError("appendMedium requires a medium");
		}
		const text = String(medium);
		if (splitMediaQueryList(text).length !== 1) {
			return;
		}
		const query = serializeMediaQuery(text);
		if (!query || this[kMedia].includes(query)) {
			return;
		}
		this[kMedia].push(query);
		syncIndexed(this);
		this[kOnChange]?.();
	}

	/** Delete every query equal to this one, or throw when the list holds none. */
	deleteMedium(medium: string): void {
		if (arguments.length === 0) {
			throw typeError("deleteMedium requires a medium");
		}
		const text = String(medium);
		const query =
			splitMediaQueryList(text).length === 1 ? serializeMediaQuery(text) : "";
		const kept = this[kMedia].filter((entry) => entry !== query);
		if (kept.length === this[kMedia].length) {
			throw domException(`No such medium: ${medium}`, "NotFoundError");
		}
		this[kMedia].length = 0;
		this[kMedia].push(...kept);
		syncIndexed(this);
		this[kOnChange]?.();
	}

	[Symbol.iterator](): IterableIterator<string> {
		return this[kMedia][Symbol.iterator]();
	}

	toString(): string {
		return this.mediaText;
	}
}

/** A rule of a stylesheet: the base every rule type shares. */
/**
 * A rule's owning sheet, held beside the rule so that deleting a rule can cut
 * the link -- a removed rule belongs to no stylesheet, and says so.
 */
const ruleSheets = new WeakMap<CSSRule, CSSStyleSheet | null>();

/** Cut a removed rule, and everything under it, loose from its sheet. */
function detachRule(rule: CSSRule): void {
	ruleSheets.set(rule, null);
	const group = rule as {cssRules?: CSSRuleList};
	if (group.cssRules) {
		for (const child of Array.from(group.cssRules)) {
			detachRule(child);
		}
	}
}

export abstract class CSSRule {
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

	declare [kParentRule]: CSSRule | null;

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
	Object.defineProperty(CSSRule.prototype, name, {
		value,
		enumerable: true,
	});
}

/** Tell the sheet -- and so the cascade -- that a rule changed. */
function notifyRule(rule: CSSRule): void {
	sheetChanged(rule.parentStyleSheet);
}

/** A rule with a rule list of its own: `@media`, `@supports`, `@layer`. */
export abstract class CSSGroupingRule extends CSSRule {
	declare [kRules]: CSSRule[];
	declare [kRuleList]: CSSRuleList;

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
			inserted instanceof CSSImportRule ||
			inserted instanceof CSSNamespaceRule
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

/** A group's rules, serialized one per line and indented one level. */
function serializeGroupRules(group: CSSGroupingRule): string {
	return Array.from(group.cssRules)
		.map((rule) => `\n  ${rule.cssText.replace(/\n/g, "\n  ")}`)
		.join("");
}

/** A grouping rule gated on a condition: `@media`, `@supports`. */
export abstract class CSSConditionRule extends CSSGroupingRule {
	abstract get conditionText(): string;
}

/** A style rule: a selector and the declaration block it applies. */
export class CSSStyleRule extends CSSGroupingRule {
	declare [kSelectors]: SelectorNode;
	declare [kSelectorText]: string | null;
	declare [kStyle]: CSSStyleDeclaration;

	constructor(
		selectors: SelectorNode,
		cssText: string,
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
		this[kStyle].cssText = cssText;
	}

	get type(): number {
		return RULE_TYPES.STYLE_RULE;
	}

	/**
	 * Serialized on first read rather than at construction: whether `*|E` keeps
	 * its prefix depends on the sheet declaring a default namespace, and the
	 * sheet's `@namespace` rules are only in place once parsing finishes.
	 */
	get selectorText(): string {
		return (this[kSelectorText] ??= serializeSelectorList(
			this[kSelectors],
			sheetNamespaces(this.parentStyleSheet),
		));
	}

	/** A selector that does not parse leaves the rule as it was. */
	set selectorText(selector: string) {
		const selectors = parseSelectorList(selector);
		if (!selectors) {
			return;
		}
		this[kSelectors] = selectors;
		this[kSelectorText] = null;
		notifyRule(this);
	}

	/** The parsed selector, which the cascade matches against. */
	get selectors(): SelectorNode {
		return this[kSelectors];
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

/** The namespaces a sheet's `@namespace` rules declare. */
/**
 * A selector's namespace constraint, and the selector with the prefixes that
 * state it taken off.
 *
 * CSS Namespaces 2: a compound selector with no type selector is qualified by
 * the default namespace all the same, so with an HTML default namespace
 * declared `.style1` selects no SVG element -- `.style1` means `*|*.style1`
 * only where no default namespace was declared. The DOM's own matcher knows
 * nothing of a sheet's namespace map, so the constraint is answered here and
 * the prefixes come off the text handed to that matcher.
 *
 * `namespace` is the URI the subject must be in, null for no namespace at all,
 * and undefined when any will do. It constrains the SUBJECT of the selector;
 * an ancestor written with a prefix is matched on its local name alone.
 */
function selectorNamespace(
	selector: string,
	namespaces: SelectorNamespaces,
): {selector: string; namespace?: string | null; valid: boolean} {
	const list = parseSelectorList(selector);
	if (!list) {
		return {selector, valid: true};
	}
	let subject: string | null | undefined;
	let subjectStated = false;
	let sawPrefix = false;
	let valid = true;
	for (const one of childrenOf(list)) {
		const parts = childrenOf(one);
		let start = 0;
		for (const [index, part] of parts.entries()) {
			if (part.type === "Combinator") {
				start = index + 1;
			}
		}
		for (const [index, part] of parts.entries()) {
			if (part.type !== "TypeSelector") {
				continue;
			}
			const name = part.name as string;
			const bar = name.lastIndexOf("|");
			if (bar === -1) {
				continue;
			}
			sawPrefix = true;
			part.name = name.slice(bar + 1);
			const prefix = name.slice(0, bar);
			let uri: string | null | undefined;
			if (prefix === "") {
				uri = null;
			} else if (prefix !== "*") {
				uri = namespaces.prefixes.get(cssTree.ident.decode(prefix));
				// A prefix no @namespace declared makes the selector invalid,
				// and an invalid selector matches nothing.
				if (uri === undefined) {
					valid = false;
				}
			}
			if (index >= start) {
				subject = uri;
				subjectStated = true;
			}
		}
	}
	if (!subjectStated) {
		subject = namespaces.default ?? undefined;
	}
	return {
		selector: sawPrefix ? serializeSelectorList(list) : selector,
		namespace: subject,
		valid,
	};
}

function sheetNamespaces(sheet: CSSStyleSheet | null): SelectorNamespaces {
	if (!sheet) {
		return NO_NAMESPACES;
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
				cssTree.ident.decode(rule.prefix),
				rule.namespaceURI,
			);
		}
	}
	return namespaces;
}

/** A rule whose body is a declaration block rather than a rule list. */
/**
 * The declaration blocks at-rules hold: one class per at-rule that declares
 * descriptors, each reflecting its own descriptors as IDL attributes and
 * naming itself as the interface it is. A descriptor is not a property -- it
 * is named only inside its own at-rule -- so `src` reaches
 * `CSSFontFaceDescriptors` and nothing else.
 */
const DESCRIPTOR_BLOCKS = new Map<string, typeof CSSStyleDeclaration>();

/** The descriptor names each at-rule's block may hold, and no others. */
const DESCRIPTOR_NAMES = new Map<string, ReadonlySet<string>>();
for (const [atRule, descriptors] of Object.entries(CSS_AT_RULE_DESCRIPTORS)) {
	const name = `CSS${atRule
		.slice(1)
		.replace(/(?:^|-)([a-z])/g, (_, letter: string) =>
			letter.toUpperCase(),
		)}Descriptors`;
	const block = class extends CSSStyleDeclaration {};
	DESCRIPTOR_NAMES.set(atRule, new Set(descriptors));
	Object.defineProperty(block, "name", {value: name, configurable: true});
	Object.defineProperty(block.prototype, Symbol.toStringTag, {
		value: name,
		configurable: true,
	});
	for (const descriptor of descriptors) {
		const attribute = camelCaseProperty(descriptor);
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

export abstract class CSSDeclarationBlockRule extends CSSRule {
	declare [kStyle]: CSSStyleDeclaration;

	constructor(
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		const atRule = (this.constructor as unknown as {atRule?: string}).atRule;
		const Block =
			(atRule ? DESCRIPTOR_BLOCKS.get(atRule) : undefined) ??
			CSSStyleProperties;
		this[kStyle] = new Block({
			parentRule: this,
			onChange: () => notifyRule(this),
			// A descriptor block declares descriptors, not CSS properties, so
			// the property index does not gate what it may hold.
			descriptors: atRule ?? "",
			keyframe: this instanceof CSSKeyframeRule,
		});
		this[kStyle].cssText = cssText;
	}

	get style(): CSSStyleDeclaration {
		return this[kStyle];
	}

	/** `[PutForwards=cssText]`: assigning a block assigns its text. */
	set style(text: string) {
		this[kStyle].cssText = String(text);
	}

	/** The at-keyword and prelude this rule's text opens with. */
	abstract get prelude(): string;

	get cssText(): string {
		const declarations = this[kStyle].cssText;
		return declarations ?
			`${this.prelude} { ${declarations} }` :
			`${this.prelude} { }`;
	}
}

/** `@font-face`: the descriptors of a font this terminal will never load. */
export class CSSFontFaceRule extends CSSDeclarationBlockRule {
	/** The at-rule whose descriptors this rule's block holds. */
	static readonly atRule = "@font-face";

	get type(): number {
		return RULE_TYPES.FONT_FACE_RULE;
	}

	get prelude(): string {
		return "@font-face";
	}
}

/** `@page`: the page selector and its descriptors. */
export class CSSPageRule extends CSSDeclarationBlockRule {
	/** The at-rule whose descriptors this rule's block holds. */
	static readonly atRule = "@page";

	declare [kSelectorText]: string;

	constructor(
		selectorText: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(cssText, parentStyleSheet, parentRule);
		this[kSelectorText] = serializePageSelector(selectorText);
	}

	get type(): number {
		return RULE_TYPES.PAGE_RULE;
	}

	get selectorText(): string {
		return this[kSelectorText];
	}

	set selectorText(selector: string) {
		this[kSelectorText] = serializePageSelector(String(selector));
		notifyRule(this);
	}

	get prelude(): string {
		return this[kSelectorText] ? `@page ${this[kSelectorText]}` : "@page";
	}
}

/** The page pseudo-classes a `@page` selector may name. */
const PAGE_PSEUDO_CLASSES = new Set(["blank", "first", "left", "right"]);

/**
 * A page selector -- an optional page name followed by page pseudo-classes,
 * with no whitespace between them -- or "" when it names no valid page.
 */
function serializePageSelector(selector: string): string {
	const text = String(selector).trim();
	if (!text) {
		return "";
	}
	const match = /^([^\s:]*)((?::[^\s:]+)*)$/.exec(text);
	if (!match) {
		return "";
	}
	const pseudos = match[2] ? match[2].slice(1).split(":") : [];
	for (const pseudo of pseudos) {
		if (!PAGE_PSEUDO_CLASSES.has(pseudo.toLowerCase())) {
			return "";
		}
	}
	const name = match[1] ? serializeCSSIdentifier(match[1]) : "";
	return name + pseudos.map((pseudo) => `:${pseudo.toLowerCase()}`).join("");
}

/** `@counter-style`: a counter's name and the descriptors that define it. */
export class CSSCounterStyleRule extends CSSDeclarationBlockRule {
	/** The at-rule whose descriptors this rule's block holds. */
	static readonly atRule = "@counter-style";

	declare [kName]: string;

	constructor(
		name: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(cssText, parentStyleSheet, null);
		this[kName] = name.trim();
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

	get prelude(): string {
		return `@counter-style ${this[kName]}`;
	}
}

/** `@property`: a custom property's registration. */
export class CSSPropertyRule extends CSSDeclarationBlockRule {
	/** The at-rule whose descriptors this rule's block holds. */
	static readonly atRule = "@property";

	declare [kName]: string;

	constructor(
		name: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(cssText, parentStyleSheet, null);
		this[kName] = name.trim();
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this[kName];
	}

	get syntax(): string {
		return this.style.getPropertyValue("syntax");
	}

	get inherits(): boolean {
		return this.style.getPropertyValue("inherits") === "true";
	}

	get initialValue(): string | null {
		return this.style.getPropertyValue("initial-value") || null;
	}

	get prelude(): string {
		return `@property ${this[kName]}`;
	}
}

/** `@font-palette-values`: a palette's name and its descriptors. */
export class CSSFontPaletteValuesRule extends CSSDeclarationBlockRule {
	/** The at-rule whose descriptors this rule's block holds. */
	static readonly atRule = "@font-palette-values";

	declare [kName]: string;

	constructor(
		name: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(cssText, parentStyleSheet, null);
		this[kName] = name.trim();
	}

	get type(): number {
		return 0;
	}

	get name(): string {
		return this[kName];
	}

	get fontFamily(): string {
		return this.style.getPropertyValue("font-family");
	}

	get basePalette(): string {
		return this.style.getPropertyValue("base-palette");
	}

	get overrideColors(): string {
		return this.style.getPropertyValue("override-colors");
	}

	get prelude(): string {
		return `@font-palette-values ${this[kName]}`;
	}
}

/** One keyframe of an `@keyframes` rule: its offsets and its declarations. */
/**
 * The properties a keyframe cannot declare: an animation's own, which describe
 * the animation rather than a step of it.
 */
const KEYFRAME_EXCLUDED = /^animation(?:-|$)/;

export class CSSKeyframeRule extends CSSDeclarationBlockRule {
	declare [kKeyText]: string;

	constructor(
		keyText: string,
		cssText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(cssText, parentStyleSheet, parentRule);
		this[kKeyText] = serializeKeyText(keyText);
	}

	get type(): number {
		return RULE_TYPES.KEYFRAME_RULE;
	}

	get keyText(): string {
		return this[kKeyText];
	}

	set keyText(text: string) {
		const serialized = serializeKeyText(String(text));
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

	get prelude(): string {
		return this[kKeyText];
	}
}

/** A keyframe's selector, as percentages: `from` is 0%, `to` is 100%. */
function serializeKeyText(text: string): string {
	const keys: string[] = [];
	for (const part of String(text).split(",")) {
		const key = part.trim().toLowerCase();
		if (key === "from") {
			keys.push("0%");
		} else if (key === "to") {
			keys.push("100%");
		} else if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(key)) {
			keys.push(`${serializeCSSNumber(key.slice(0, -1))}%`);
		} else {
			return "";
		}
	}
	return keys.join(", ");
}

/** `@media`: the rules that apply when the viewport matches. */
export class CSSMediaRule extends CSSConditionRule {
	declare [kMedia]: MediaList;

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

	/** A condition is read: the media list behind it is what an author sets. */
	get conditionText(): string {
		return this[kMedia].mediaText;
	}

	get cssText(): string {
		return `@media ${this.conditionText} {${serializeGroupRules(this)}\n}`;
	}
}

/** A grouping rule whose condition is a text this engine keeps as authored. */
abstract class CSSTextConditionRule extends CSSConditionRule {
	declare [kConditionText]: string;

	constructor(
		conditionText: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kConditionText] = conditionText.trim();
	}

	get conditionText(): string {
		return this[kConditionText];
	}

	abstract get atKeyword(): string;

	get cssText(): string {
		const condition = this[kConditionText] ? ` ${this[kConditionText]}` : "";
		return `${this.atKeyword}${condition} {${serializeGroupRules(this)}\n}`;
	}
}

/** `@supports`: its rules apply, since what this engine supports it renders. */
export class CSSSupportsRule extends CSSTextConditionRule {
	get type(): number {
		return RULE_TYPES.SUPPORTS_RULE;
	}

	get atKeyword(): string {
		return "@supports";
	}
}

/** `@container`: parsed, with no container query engine behind it. */
export class CSSContainerRule extends CSSTextConditionRule {
	get type(): number {
		return 0;
	}

	get atKeyword(): string {
		return "@container";
	}

	get containerName(): string {
		const match = /^([a-zA-Z_-][\w-]*)\s+/.exec(this.conditionText);
		return match?.[1] ?? "";
	}

	get containerQuery(): string {
		const name = this.containerName;
		return name ?
				this.conditionText.slice(name.length).trim() :
			this.conditionText;
	}
}

/** `@scope`: parsed, and its rules apply unscoped. */
export class CSSScopeRule extends CSSGroupingRule {
	declare [kPrelude]: string;

	constructor(
		prelude: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kPrelude] = prelude.trim();
	}

	get type(): number {
		return 0;
	}

	get start(): string | null {
		const match = /^\(([^)]*)\)/.exec(this[kPrelude]);
		return match?.[1].trim() ?? null;
	}

	get end(): string | null {
		const match = /\bto\s*\(([^)]*)\)/.exec(this[kPrelude]);
		return match?.[1].trim() ?? null;
	}

	get cssText(): string {
		const prelude = this[kPrelude] ? ` ${this[kPrelude]}` : "";
		return `@scope${prelude} {${serializeGroupRules(this)}\n}`;
	}
}

/** `@starting-style`: parsed, with no transitions behind it. */
export class CSSStartingStyleRule extends CSSGroupingRule {
	get type(): number {
		return 0;
	}

	get cssText(): string {
		return `@starting-style {${serializeGroupRules(this)}\n}`;
	}
}

/** `@layer name { ... }`: its rules cascade in source order. */
export class CSSLayerBlockRule extends CSSGroupingRule {
	declare [kName]: string;

	constructor(
		name: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
		build?: (group: CSSGroupingRule) => CSSRule[],
	) {
		super(parentStyleSheet, parentRule, build);
		this[kName] = name.trim();
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

/** `@layer a, b;`: the layer order, declared without a block. */
export class CSSLayerStatementRule extends CSSRule {
	declare [kNames]: string[];

	constructor(
		prelude: string,
		parentStyleSheet: CSSStyleSheet | null,
		parentRule: CSSRule | null,
	) {
		super(parentStyleSheet, parentRule);
		this[kNames] = prelude
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
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

/** `@namespace`: a prefix bound to a namespace URI. */
export class CSSNamespaceRule extends CSSRule {
	declare [kPrefix]: string;
	declare [kNamespaceURI]: string;

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
		return `@namespace ${prefix}url(${serializeCSSString(this[kNamespaceURI])});`;
	}
}

/**
 * `@import`: parsed into an object with its href, layer, supports condition
 * and media, whose styleSheet is null. There is no network behind a terminal
 * document, so nothing is fetched and the rule declares nothing.
 */
export class CSSImportRule extends CSSRule {
	declare [kHref]: string;
	declare [kMedia]: MediaList;
	declare [kLayerName]: string | null;
	declare [kSupportsText]: string | null;

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
		let out = `@import url(${serializeCSSString(this[kHref])})`;
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

/** `@font-feature-values`: a font family and the feature blocks it names. */
export class CSSFontFeatureValuesRule extends CSSRule {
	declare [kFontFamily]: string;
	declare [kBlocks]: Map<string, CSSStyleDeclaration>;

	constructor(
		fontFamily: string,
		node: ParsedNode,
		parentStyleSheet: CSSStyleSheet | null,
	) {
		super(parentStyleSheet, null);
		this[kBlocks] = new Map<string, CSSStyleDeclaration>();
		this[kFontFamily] = fontFamily.trim();
		for (const child of nodesOf(node.block ?? {})) {
			if (child.type !== "Atrule" || !child.name) {
				continue;
			}
			const block = new CSSStyleDeclaration({
				parentRule: this,
				onChange: () => notifyRule(this),
				descriptors: "@font-feature-values",
			});
			block.cssText = blockText(child);
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

	/** One feature block's values, or an empty block when it was not written. */
	[kBlock](name: string): CSSStyleDeclaration {
		let block = this[kBlocks].get(name);
		if (!block) {
			block = new CSSStyleDeclaration({
				parentRule: this,
				onChange: () => notifyRule(this),
				descriptors: "@font-feature-values",
			});
			this[kBlocks].set(name, block);
		}
		return block;
	}

	get annotation(): CSSStyleDeclaration {
		return this[kBlock]("annotation");
	}

	get ornaments(): CSSStyleDeclaration {
		return this[kBlock]("ornaments");
	}

	get stylistic(): CSSStyleDeclaration {
		return this[kBlock]("stylistic");
	}

	get swash(): CSSStyleDeclaration {
		return this[kBlock]("swash");
	}

	get characterVariant(): CSSStyleDeclaration {
		return this[kBlock]("character-variant");
	}

	get styleset(): CSSStyleDeclaration {
		return this[kBlock]("styleset");
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

/** `@keyframes`: its name and the keyframes it holds. */
export class CSSKeyframesRule extends CSSRule {
	declare [kName]: string;
	declare [kRules]: CSSRule[];
	declare [kRuleList]: CSSRuleList;

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
		const key = serializeKeyText(String(select));
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
		const key = serializeKeyText(String(select));
		for (let index = this[kRules].length - 1; index >= 0; index--) {
			const rule = this[kRules][index] as CSSKeyframeRule;
			if (rule.keyText === key) {
				return rule;
			}
		}
		return null;
	}

	get cssText(): string {
		const frames = this[kRules].map((rule) => `\n  ${rule.cssText}`).join("");
		// An animation's name is a <custom-ident> or a <string>; the words a
		// <custom-ident> excludes -- the CSS-wide keywords and `none`, which
		// animation-name spends on "no animation" -- are written as the
		// strings they are.
		const reserved = this[kName].toLowerCase();
		const name =
			CSS_WIDE_KEYWORDS.has(reserved) || reserved === "none" ?
					serializeCSSString(this[kName]) :
					serializeCSSIdentifier(this[kName]);
		return `@keyframes ${name} {${frames}\n}`;
	}
}

/** The rules of a stylesheet or a grouping rule. */
export class CSSRuleList {
	declare [kRules]: readonly CSSRule[];

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

/** The stylesheets of a document or a shadow root. */
export class StyleSheetList {
	declare [kSheets]: readonly CSSStyleSheet[];

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

/**
 * A stylesheet: the rules of a `<style>` element, or a constructed sheet a
 * document adopts.
 *
 * The rules are this object's own -- the cascade reads them rather than
 * re-parsing text -- so insertRule, deleteRule, replaceSync and a write to any
 * rule's declaration block all reach the render through the same invalidation
 * a `<style>` text change does.
 */
export class CSSStyleSheet {
	declare [kRules]: CSSRule[];
	declare [kRuleList]: CSSRuleList;
	declare [kMedia]: MediaList;
	declare [kOwnerNode]: Element | null;
	declare [kOwnerRule]: CSSRule | null;
	declare [kConstructed]: boolean;
	declare [kDisabled]: boolean;
	declare [kHref]: string | null;
	declare [kTitle]: string | null;
	/** The owner node's text this sheet last parsed. */
	declare [kText]: string | null;

	/**
	 * A sheet with an owner element is one the document parsed: replace and
	 * replaceSync are refused on it, and its rules follow the element's text.
	 * The exposed constructor takes options alone, so author code only ever
	 * makes the constructed kind.
	 */
	constructor(
		options: {media?: string; title?: string; disabled?: boolean} = {},
		ownerNode: Element | null = null,
	) {
		this[kRules] = [];
		this[kOwnerNode] = null;
		this[kOwnerRule] = null;
		this[kDisabled] = false;
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
			() => this[kChanged](),
		);
		this[kRuleList] = createRuleList(this[kRules]);
	}

	[kChanged](): void {
		sheetNotifiers.get(this)?.();
	}

	/** Reparse the owner element's text when it says something new. */
	[kSync](): void {
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

	/**
	 * Forget what the owner element last said, so the next read reparses it.
	 * A <style> element's child list IS its stylesheet: changing it replaces
	 * the sheet's rules even when the text it spells out is the same.
	 */
	reparseOwnerText(): void {
		this[kText] = null;
	}

	get cssRules(): CSSRuleList {
		this[kSync]();
		return this[kRuleList];
	}

	/** The legacy alias every engine still answers to. */
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
		this[kChanged]();
	}

	insertRule(text: string, index = 0): number {
		if (arguments.length === 0) {
			throw typeError("insertRule requires a rule", this);
		}
		this[kSync]();
		if (index > this[kRules].length) {
			throw domException(
				`Cannot insert at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		const inserted = parseRuleText(text, this, null);
		// A sheet an author constructed pulls in no other: `@import` is not a
		// rule it can be given.
		if (inserted instanceof CSSImportRule && this[kConstructed]) {
			throw domException(
				"A constructed stylesheet holds no @import rule",
				"SyntaxError",
				this,
			);
		}
		this[kCheckRuleOrder](inserted, index);
		this[kRules].splice(index, 0, inserted);
		syncIndexed(this[kRuleList]);
		this[kChanged]();
		return index;
	}

	/**
	 * Whether a rule may stand at `index`.
	 *
	 * `@import` precedes every rule but another `@import`, and `@namespace`
	 * every rule but those two -- which is as much a constraint on the rule
	 * being inserted as on the ones already there. A `@namespace` additionally
	 * needs a sheet that holds nothing else: a namespace declared after a
	 * selector has been parsed cannot reach it.
	 */
	[kCheckRuleOrder](rule: CSSRule, index: number): void {
		const hierarchy = (): never => {
			throw domException(
				"That rule cannot stand at that index",
				"HierarchyRequestError",
				this,
			);
		};
		const prelude = (other: CSSRule): boolean =>
			other instanceof CSSImportRule || other instanceof CSSNamespaceRule;
		const before = this[kRules].slice(0, index);
		const after = this[kRules].slice(index);
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
			if (this[kRules].some((other) => !prelude(other))) {
				throw domException(
					"A @namespace rule needs a sheet of nothing but @import and @namespace rules",
					"InvalidStateError",
					this,
				);
			}
			return;
		}
		if (after.some(prelude)) {
			hierarchy();
		}
	}

	deleteRule(index: number): void {
		if (arguments.length === 0) {
			throw typeError("deleteRule requires an index", this);
		}
		this[kSync]();
		if (index >= this[kRules].length) {
			throw domException(
				`Cannot delete at index ${index}`,
				"IndexSizeError",
				this,
			);
		}
		const removed = this[kRules][index];
		// Removing a namespace declaration would change what the selectors
		// already parsed against it mean, so a sheet holding any other rule
		// keeps it.
		if (
			removed instanceof CSSNamespaceRule &&
			this[kRules].some(
				(other) =>
					!(
						other instanceof CSSImportRule || other instanceof CSSNamespaceRule
					),
			)
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
		this[kChanged]();
	}

	/** The legacy IE spellings, defined in terms of the modern pair. */
	addRule(selector = "undefined", block = "", index?: number): number {
		this.insertRule(`${selector} { ${block} }`, index ?? this.cssRules.length);
		return -1;
	}

	removeRule(index = 0): void {
		this[kSync]();
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
		// An adopted sheet cannot pull in another: `@import` is dropped rather
		// than parsed, per the constructable-stylesheet rules.
		this[kRules].length = 0;
		this[kRules].push(
			...parseRules(String(text ?? ""), this, null).filter(
				(rule) => !(rule instanceof CSSImportRule),
			),
		);
		syncIndexed(this[kRuleList]);
		this[kChanged]();
	}

	replace(text: string): Promise<CSSStyleSheet> {
		try {
			this.replaceSync(text);
		} catch (error) {
			return Promise.reject(error);
		}
		return Promise.resolve(this);
	}
}

/** Whether a sheet may be adopted: only a constructed one, per spec. */
const constructedSheets = new WeakSet<CSSStyleSheet>();

// ---- Selectors -------------------------------------------------------------

/**
 * The pseudo-classes and pseudo-elements a selector may name. A selector
 * naming anything else does not parse, which is what makes `:gibberish`
 * invalid rather than merely unmatched.
 */
const PSEUDO_CLASSES = new Set([
	"active",
	"any-link",
	"autofill",
	"blank",
	"buffering",
	"checked",
	"current",
	"default",
	"defined",
	"dir",
	"disabled",
	"empty",
	"enabled",
	"first",
	"first-child",
	"first-of-type",
	"focus",
	"focus-visible",
	"focus-within",
	"fullscreen",
	"future",
	"has",
	"host",
	"host-context",
	"hover",
	"in-range",
	"indeterminate",
	"invalid",
	"is",
	"lang",
	"last-child",
	"last-of-type",
	"left",
	"link",
	"local-link",
	"modal",
	"muted",
	"not",
	"nth-child",
	"nth-col",
	"nth-last-child",
	"nth-last-col",
	"nth-last-of-type",
	"nth-of-type",
	"only-child",
	"only-of-type",
	"open",
	"optional",
	"out-of-range",
	"past",
	"paused",
	"picture-in-picture",
	"placeholder-shown",
	"playing",
	"popover-open",
	"read-only",
	"read-write",
	"required",
	"right",
	"root",
	"scope",
	"seeking",
	"stalled",
	"state",
	"target",
	"target-current",
	"target-within",
	"user-invalid",
	"user-valid",
	"valid",
	"visited",
	"volume-locked",
	"where",
	"window-inactive",
]);

const PSEUDO_ELEMENTS = new Set([
	"after",
	"backdrop",
	"before",
	"checkmark",
	"column",
	"cue",
	"cue-region",
	"details-content",
	"file-selector-button",
	"first-letter",
	"first-line",
	"grammar-error",
	"highlight",
	"marker",
	"part",
	"picker",
	"picker-icon",
	"placeholder",
	"scroll-button",
	"scroll-marker",
	"scroll-marker-group",
	"selection",
	"slotted",
	"spelling-error",
	"target-text",
	"view-transition",
	"view-transition-group",
	"view-transition-image-pair",
	"view-transition-new",
	"view-transition-old",
]);

/**
 * The pseudo-elements whose selector takes an argument, and so are written
 * only in functional form -- `::part(name)`, never a bare `::part`.
 */
const FUNCTIONAL_PSEUDO_ELEMENTS = new Set([
	"highlight",
	"part",
	"picker",
	"scroll-button",
	"slotted",
	"view-transition-group",
	"view-transition-image-pair",
	"view-transition-new",
	"view-transition-old",
]);

/** The pseudo-elements that may also be written with one colon, from CSS 2. */
const LEGACY_PSEUDO_ELEMENTS = new Set([
	"after",
	"before",
	"first-letter",
	"first-line",
]);

/** A selector AST node, as the CSS parser hands it over. */
interface SelectorNode {
	type: string;
	name?: string | {type: string; name: string};
	matcher?: string | null;
	value?: {type: string; value?: string; name?: string} | null;
	flags?: string | null;
	children?: {toArray(): SelectorNode[]} | SelectorNode[] | null;
	nth?: SelectorNode | null;
	selector?: SelectorNode | null;
	a?: string | null;
	b?: string | null;
}

function childrenOf(node: SelectorNode): SelectorNode[] {
	const children = node.children;
	if (!children) {
		return [];
	}
	return Array.isArray(children) ? children : children.toArray();
}

/**
 * A qualified name -- `ns|local`, `*|local`, `local` -- with each part
 * serialized as an identifier and `*` left as itself.
 */
function serializeQualifiedName(
	name: string,
	namespaces: SelectorNamespaces,
): string {
	const bar = name.lastIndexOf("|");
	const local = bar === -1 ? name : name.slice(bar + 1);
	const prefix = bar === -1 ? null : name.slice(0, bar);
	const localText = local === "*" ? "*" : serializeIdentifierSource(local);
	if (prefix === null) {
		return localText;
	}
	// A prefix is written only where it says something an unprefixed name does
	// not: `*|E` says "any namespace", which is what `E` already means with no
	// default namespace declared, and a prefix bound to the default namespace
	// resolves to the same namespace `E` does.
	if (prefix === "*") {
		return namespaces.default === null ? localText : `*|${localText}`;
	}
	if (prefix === "") {
		// `|E` says "no namespace", which is not what a bare `E` says whether or
		// not a default namespace was declared -- so the bar stays. An
		// attribute is the exception: an unprefixed one is already in no
		// namespace, so `[|attr]` and `[attr]` are the same selector.
		return namespaces === ATTRIBUTE_NAMESPACES ? localText : `|${localText}`;
	}
	const decoded = cssTree.ident.decode(prefix);
	if (
		namespaces.default !== null &&
		namespaces.prefixes.get(decoded) === namespaces.default
	) {
		return localText;
	}
	return `${serializeCSSIdentifier(decoded)}|${localText}`;
}

/**
 * The namespaces a selector is read against: the sheet's default namespace, if
 * it declared one, and the prefixes it bound.
 */
interface SelectorNamespaces {
	default: string | null;
	prefixes: Map<string, string>;
}

const NO_NAMESPACES: SelectorNamespaces = {
	default: null,
	prefixes: new Map(),
};

/** The attribute name an attribute selector opens with, whatever follows it. */
const ATTRIBUTE_SELECTOR_NAME = /\[\s*([A-Za-z_][\w:.-]*)/g;

/** The class names a compound selector tests, including inside :not()/:is(). */
const SELECTOR_CLASS_NAME = /\.(-?[A-Za-z_][\w-]*)/g;

/** The ids a compound selector tests. */
const SELECTOR_ID_NAME = /#(-?[A-Za-z_][\w-]*)/g;

/**
 * A selector's weight, as the three counts selectors-4 §17 keeps: ids,
 * then classes/attributes/pseudo-classes, then types/pseudo-elements.
 */
type Specificity = [number, number, number];

/**
 * The pseudo-classes whose weight is the weight of their most specific
 * argument, their own name counting for nothing.
 */
const ARGUMENT_WEIGHTED_PSEUDO_CLASSES = new Set([
	"has",
	"is",
	"matches",
	"not",
	"-moz-any",
	"-webkit-any",
]);

/**
 * The pseudo-classes that weigh as a class AND take the weight of their most
 * specific argument on top: `:host(.a)` is a pseudo-class testing a compound,
 * and `:nth-child(2n of .a)` an index testing one.
 */
const COMPOUND_WEIGHTED_PSEUDO_CLASSES = new Set([
	"host",
	"host-context",
	"nth-child",
	"nth-last-child",
]);

/** The weight of the heaviest selector in a list; zero for an empty one. */
function listSpecificity(list: SelectorNode): Specificity {
	let most: Specificity = [0, 0, 0];
	for (const selector of childrenOf(list)) {
		const weight = selectorSpecificityOf(selector);
		if (
			weight[0] > most[0] ||
			(weight[0] === most[0] &&
				(weight[1] > most[1] || (weight[1] === most[1] && weight[2] > most[2])))
		) {
			most = weight;
		}
	}
	return most;
}

/** The weight of one complex selector: every simple selector in it, summed. */
function selectorSpecificityOf(selector: SelectorNode): Specificity {
	const total: Specificity = [0, 0, 0];
	const add = (weight: Specificity): void => {
		total[0] += weight[0];
		total[1] += weight[1];
		total[2] += weight[2];
	};
	const argumentWeight = (node: SelectorNode): Specificity => {
		for (const child of childrenOf(node)) {
			if (child.type === "SelectorList") {
				return listSpecificity(child);
			}
			if (child.type === "Selector") {
				return selectorSpecificityOf(child);
			}
			if (child.type === "Nth" && child.selector) {
				return listSpecificity(child.selector);
			}
		}
		return [0, 0, 0];
	};
	for (const part of childrenOf(selector)) {
		switch (part.type) {
			case "IdSelector":
				total[0]++;
				break;
			case "ClassSelector":
			case "AttributeSelector":
				total[1]++;
				break;
			// The universal selector weighs nothing, in any namespace.
			case "TypeSelector": {
				const name = String(part.name ?? "");
				if (!name.endsWith("*")) {
					total[2]++;
				}
				break;
			}
			// `::slotted(.a)` and `::part(name)`: the pseudo-element weighs as
			// an element, and a compound it takes weighs on top of that.
			case "PseudoElementSelector":
				total[2]++;
				add(argumentWeight(part));
				break;
			case "PseudoClassSelector": {
				const name = pseudoName(String(part.name ?? ""));
				// `:before` is the CSS 2 spelling of a pseudo-element, and
				// weighs as one.
				if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
					total[2]++;
					break;
				}
				// `:where()` contributes nothing at all, arguments included.
				if (name === "where") {
					break;
				}
				if (ARGUMENT_WEIGHTED_PSEUDO_CLASSES.has(name)) {
					add(argumentWeight(part));
					break;
				}
				total[1]++;
				if (COMPOUND_WEIGHTED_PSEUDO_CLASSES.has(name)) {
					add(argumentWeight(part));
				}
				break;
			}
		}
	}
	return total;
}

/**
 * A selector's specificity, zero-padded to "ids-classes-elements" so the
 * cascade can compare two of them as strings.
 *
 * A selector the parser cannot read weighs nothing: the matcher may still
 * accept it -- it reads a wider selector grammar than this parser does -- and
 * a rule whose weight cannot be counted is the one that should lose a tie.
 */
function selectorSpecificity(selector: string): string {
	let list: SelectorNode | null = null;
	try {
		list = cssTree.parse(selector, {
			context: "selectorList",
			onParseError(error: Error) {
				throw error;
			},
		}) as unknown as SelectorNode;
	} catch (_err) {
		list = null;
	}
	const weight =
		list && list.type === "SelectorList" ? listSpecificity(list) : [0, 0, 0];
	return weight.map((count) => String(count).padStart(3, "0")).join("-");
}

/**
 * The pseudo-classes an attribute can start or stop matching. A selector that
 * tests one of these on an ancestor reaches the ancestor's descendants when the
 * attribute behind it changes, and no attribute NAME in the selector says so.
 */
const STATE_PSEUDO_CLASSES =
	/:(checked|disabled|enabled|required|optional|read-only|read-write|indeterminate|default|placeholder-shown|open|closed|link|any-link|visited|target|valid|invalid|in-range|out-of-range|defined|popover-open)\b/;

/** The attributes those state pseudo-classes are driven by. */
const STATE_ATTRIBUTES = new Set([
	"checked",
	"disabled",
	"href",
	"id",
	"max",
	"min",
	"multiple",
	"open",
	"pattern",
	"placeholder",
	"popover",
	"readonly",
	"required",
	"selected",
	"type",
	"value",
]);

/**
 * A selector's compounds, in source order, split on top-level combinators.
 * Descendant, child, and both sibling combinators all separate compounds;
 * combinators inside parentheses or brackets do not, so `:is(a > b) c` reads as
 * two compounds and `[title~="a b"]` as one.
 */
function selectorCompounds(selector: string): string[] {
	const compounds: string[] = [];
	let depth = 0;
	let start = 0;
	let inBracket = false;
	let quote = "";
	for (let i = 0; i < selector.length; i++) {
		const char = selector[i];
		if (quote) {
			if (char === quote && selector[i - 1] !== "\\") {
				quote = "";
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth--;
		} else if (char === "[") {
			inBracket = true;
		} else if (char === "]") {
			inBracket = false;
		} else if (
			depth === 0 &&
			!inBracket &&
			(char === " " ||
				char === "\t" ||
				char === "\n" ||
				char === ">" ||
				char === "+" ||
				char === "~")
		) {
			if (i > start) {
				compounds.push(selector.slice(start, i));
			}
			start = i + 1;
		}
	}
	if (selector.length > start) {
		compounds.push(selector.slice(start));
	}
	return compounds;
}

/**
 * The element type a selector's subject is anchored to, lowercased, or
 * undefined when the subject names none -- a universal, a class, an id, an
 * attribute or a bare pseudo-class can be any element, and so can anything this
 * reading is not sure of.
 *
 * The subject is the last compound: everything after the final top-level
 * combinator, counted outside brackets and parentheses so that the commas and
 * spaces inside `:not(...)` or `[a=" "]` are not mistaken for one.
 */
function selectorSubjectTag(selector: string): string | undefined {
	let depth = 0;
	let start = 0;
	for (let i = 0; i < selector.length; i++) {
		const c = selector[i];
		if (c === "(" || c === "[") {
			depth++;
		} else if (c === ")" || c === "]") {
			depth--;
		} else if (
			depth === 0 &&
			(c === " " || c === ">" || c === "+" || c === "~")
		) {
			start = i + 1;
		}
	}
	const subject = selector.slice(start);
	const name = /^[A-Za-z][\w-]*/.exec(subject);
	if (!name) {
		return undefined;
	}
	// A namespace prefix leaves the type after the bar, which the caller has
	// already resolved away; anything still carrying one is not read here.
	if (subject.includes("|")) {
		return undefined;
	}
	return name[0].toLowerCase();
}

/**
 * An attribute selector's name is never read against the default namespace: an
 * unprefixed attribute is always in no namespace.
 */
const ATTRIBUTE_NAMESPACES: SelectorNamespaces = {
	default: "",
	prefixes: new Map(),
};

/** An identifier as the selector source spelled it, re-escaped canonically. */
function serializeIdentifierSource(name: string): string {
	return serializeCSSIdentifier(cssTree.ident.decode(name));
}

/**
 * A pseudo's name as it is compared and serialized: the identifier the source
 * escapes spell, ASCII-lowercased. `::\000041fter` and `::AFTER` are both
 * `::after`, and an escape is part of the spelling, not of the name.
 */
function pseudoName(name: string): string {
	return cssTree.ident.decode(name).toLowerCase();
}

/**
 * Serialize a group of selectors, per CSSOM: the selectors joined by ", ",
 * each simple selector in its canonical spelling -- identifiers escaped,
 * attribute values quoted, combinators spaced, An+B reduced.
 */
function serializeSelectorList(
	list: SelectorNode,
	namespaces: SelectorNamespaces = NO_NAMESPACES,
): string {
	return childrenOf(list)
		.map((selector) => serializeSelector(selector, namespaces))
		.join(", ");
}

function serializeSelector(
	selector: SelectorNode,
	namespaces: SelectorNamespaces = NO_NAMESPACES,
): string {
	let out = "";
	// A universal selector is written only when it stands alone in its
	// compound, or carries a namespace prefix.
	const parts = childrenOf(selector);
	for (const [index, part] of parts.entries()) {
		// A universal selector says nothing that the compound around it does
		// not already say, so it is written only when it stands alone.
		if (part.type === "TypeSelector") {
			const text = serializeQualifiedName(part.name as string, namespaces);
			const next = parts[index + 1];
			const alone = !next || next.type === "Combinator";
			if (text === "*" && !alone) {
				continue;
			}
			out += text;
			continue;
		}
		out += serializeSimpleSelector(part, namespaces);
	}
	return out;
}

function serializeSimpleSelector(
	node: SelectorNode,
	namespaces: SelectorNamespaces,
): string {
	switch (node.type) {
		case "TypeSelector":
			return serializeQualifiedName(node.name as string, namespaces);
		case "ClassSelector":
			return `.${serializeIdentifierSource(node.name as string)}`;
		case "IdSelector":
			return `#${serializeIdentifierSource(node.name as string)}`;
		case "NestingSelector":
			return "&";
		case "Combinator": {
			const name = node.name as string;
			return name === " " ? " " : ` ${name} `;
		}
		case "AttributeSelector": {
			const name = node.name as {name: string};
			let out = `[${serializeQualifiedName(name.name, ATTRIBUTE_NAMESPACES)}`;
			if (node.matcher && node.value) {
				const value =
					node.value.type === "String" ?
							(node.value.value ?? "") :
							(node.value.name ?? "");
				out += `${node.matcher}${serializeCSSString(value)}`;
				if (node.flags) {
					out += ` ${node.flags.toLowerCase()}`;
				}
			}
			return `${out}]`;
		}
		case "PseudoClassSelector":
		case "PseudoElementSelector": {
			// A CSS 2 pseudo-element may be written with one colon; it
			// serializes with two, which is the spelling every one of them has.
			const decoded = pseudoName(node.name as string);
			const element =
				node.type === "PseudoElementSelector" ||
				LEGACY_PSEUDO_ELEMENTS.has(decoded);
			const colons = element ? "::" : ":";
			const name = serializeCSSIdentifier(decoded);
			const args = childrenOf(node);
			if (args.length === 0) {
				return `${colons}${name}`;
			}
			const text = args
				.map((argument) => serializeSelectorArgument(argument, namespaces))
				.join(", ");
			return `${colons}${name}(${text})`;
		}
		default:
			return "";
	}
}

function serializeSelectorArgument(
	node: SelectorNode,
	namespaces: SelectorNamespaces,
): string {
	switch (node.type) {
		case "SelectorList":
			return serializeSelectorList(node, namespaces);
		case "Selector":
			return serializeSelector(node, namespaces);
		case "Nth": {
			const nth = node.nth ?
					serializeSelectorArgument(node.nth, namespaces) :
				"";
			const of = node.selector ?
				` of ${serializeSelectorList(node.selector, namespaces)}` :
				"";
			return `${nth}${of}`;
		}
		case "AnPlusB":
			return serializeAnPlusB(node.a ?? null, node.b ?? null);
		case "Identifier": {
			// `even` and `odd` are An+B written in words.
			const word = ((node.name as string) ?? "").toLowerCase();
			if (word === "even") {
				return "2n";
			}
			if (word === "odd") {
				return "2n+1";
			}
			return serializeIdentifierSource((node.name as string) ?? "");
		}
		case "String":
			return serializeCSSString(node.value?.value ?? "");
		case "Raw": {
			const text = String((node as {value?: string}).value ?? "").trim();
			// An argument that is one identifier -- `::highlight(name)`,
			// `:lang(ja)` -- serializes as the identifier its escapes spell.
			// Anything else the parser handed over whole stays as written.
			return /^-?(?:[-\w-￿]|\\[^\n])+$/.test(text) && !/^-?\d/.test(text) ?
					serializeIdentifierSource(text) :
				text;
		}
		default:
			return "";
	}
}

/** `An+B` in the one spelling CSSOM writes: `2n`, `2n+1`, `-n+5`, `10`. */
function serializeAnPlusB(a: string | null, b: string | null): string {
	if (a === null) {
		return String(Number(b ?? 0));
	}
	const step = Number(a);
	let out = step === 1 ? "n" : step === -1 ? "-n" : `${step}n`;
	const offset = Number(b ?? 0);
	if (offset > 0) {
		out += `+${offset}`;
	} else if (offset < 0) {
		out += `${offset}`;
	}
	return out;
}

/**
 * A `getComputedStyle` pseudo-element argument, in its canonical spelling.
 *
 * "" means the argument names no pseudo-element and is ignored -- an argument
 * without a leading colon always is, which is how `getComputedStyle(el,
 * "before")` answers with the element's own style. Null means the argument
 * names something that is not a pseudo-element, for which an empty
 * declaration is the answer.
 */
function parsePseudoElementArgument(text: string): string | null {
	if (!text.startsWith(":")) {
		return "";
	}
	const double = text.startsWith("::");
	let name = text.slice(double ? 2 : 1);
	// CSS tokenization closes a function left open at the end of the input, so
	// `::highlight( name ` names the same pseudo-element `::highlight(name)`
	// does. Anything after the name that is not inside a function is a
	// trailing token, and a trailing token is not part of the selector.
	let open = 0;
	for (let index = 0; index < name.length; index++) {
		const char = name[index];
		if (char === "\\") {
			index++;
		} else if (char === "(") {
			open++;
		} else if (char === ")") {
			open--;
		}
		// A comma outside the arguments starts a second selector, and a list
		// of them names no one pseudo-element.
		else if (char === "," && open === 0) {
			return null;
		}
	}
	if (open > 0) {
		name += ")".repeat(open);
	} else if (name !== name.trimEnd()) {
		return null;
	}
	// One colon is the CSS 2 spelling, which only the four CSS 2
	// pseudo-elements answer to.
	if (!double && !LEGACY_PSEUDO_ELEMENTS.has(pseudoName(name))) {
		return null;
	}
	const selectors = parseSelectorList(`*::${name}`);
	if (!selectors) {
		return null;
	}
	// One pseudo-element, not a list of them.
	const list = childrenOf(selectors);
	if (list.length !== 1) {
		return null;
	}
	const compound = childrenOf(list[0] ?? {type: ""});
	const pseudo = compound[compound.length - 1];
	if (
		compound.length !== 2 ||
		!pseudo ||
		pseudo.type !== "PseudoElementSelector"
	) {
		return null;
	}
	return serializeSimpleSelector(pseudo, NO_NAMESPACES);
}

/**
 * A selector list's selectors: split on the commas that separate them, which
 * are the ones no bracket, paren or string encloses.
 */
function splitSelectorList(text: string): string[] {
	const selectors: string[] = [];
	let depth = 0;
	let start = 0;
	let quote = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = "";
			}
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(" || char === "[") {
			depth++;
		} else if (char === ")" || char === "]") {
			depth--;
		} else if (char === "," && depth === 0) {
			selectors.push(text.slice(start, index).trim());
			start = index + 1;
		}
	}
	selectors.push(text.slice(start).trim());
	return selectors.filter(Boolean);
}

/**
 * Parse a selector list, or null when it does not parse -- which includes a
 * pseudo this engine does not know, since an unknown pseudo makes the whole
 * selector invalid.
 */
function parseSelectorList(text: string): SelectorNode | null {
	let list: SelectorNode;
	// A selector list has to select something: the empty string is not one.
	if (!String(text).trim()) {
		return null;
	}
	try {
		list = cssTree.parse(String(text), {
			context: "selectorList",
			onParseError(error: Error) {
				throw error;
			},
		}) as unknown as SelectorNode;
	} catch (_err) {
		return null;
	}
	if (list.type !== "SelectorList") {
		return null;
	}
	let valid = true;
	const checkSimple = (node: SelectorNode): void => {
		if (!valid) {
			return;
		}
		switch (node.type) {
			case "PseudoClassSelector": {
				const name = pseudoName(node.name as string);
				// `:before` and friends are the CSS 2 spelling of a pseudo-element.
				if (!PSEUDO_CLASSES.has(name) && !LEGACY_PSEUDO_ELEMENTS.has(name)) {
					valid = false;
					return;
				}
				break;
			}
			case "PseudoElementSelector": {
				const name = pseudoName(node.name as string);
				if (!PSEUDO_ELEMENTS.has(name)) {
					valid = false;
					return;
				}
				if (!validPseudoElementArguments(name, childrenOf(node))) {
					valid = false;
					return;
				}
				break;
			}
			// A chunk the parser could not read is not a simple selector.
			case "Raw":
				valid = false;
				return;
		}
		// A functional pseudo's arguments are selectors only for the pseudos
		// that take them; `::part(title)` and `:lang(ja)` name something else,
		// and their arguments carry no selector to validate.
		for (const child of childrenOf(node)) {
			if (child.type === "SelectorList") {
				checkList(child);
			} else if (child.type === "Selector") {
				checkSelector(child);
			} else if (child.type === "Nth" && child.selector) {
				checkList(child.selector);
			}
		}
	};
	const checkSelector = (selector: SelectorNode): void => {
		const parts = childrenOf(selector);
		if (parts.length === 0) {
			valid = false;
			return;
		}
		for (const part of parts) {
			checkSimple(part);
		}
	};
	const checkList = (node: SelectorNode): void => {
		for (const selector of childrenOf(node)) {
			checkSelector(selector);
		}
	};
	checkList(list);
	return valid ? list : null;
}

/**
 * Whether a pseudo-element's arguments fit its grammar: the functional ones
 * take an identifier (or, for `::slotted`, a compound selector), and the rest
 * take nothing at all.
 */
function validPseudoElementArguments(
	name: string,
	args: SelectorNode[],
): boolean {
	if (!FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) {
		return args.length === 0;
	}
	if (args.length === 0) {
		return false;
	}
	if (name === "slotted") {
		return args.every((argument) => argument.type === "Selector");
	}
	const text = args
		.map((argument) =>
			argument.type === "Raw" ?
					String((argument as {value?: string}).value ?? "") :
				"",
		)
		.join("")
		.trim();
	// The argument is an identifier, so the escapes in it spell the name.
	if (!/^(?:[\w\u0080-\uFFFF-]|\\[^\n])+$/.test(text)) {
		return false;
	}
	const identifier = cssTree.ident.decode(text);
	// `::picker` names the element whose picker it is, and nothing else does.
	if (name === "picker") {
		return identifier === "select";
	}
	return /^[a-zA-Z_\u0080-\uFFFF-][\w\u0080-\uFFFF-]*$/.test(identifier);
}

// ---- The text parser -------------------------------------------------------

/** A parsed rule, as the CSS parser hands it over. */
interface ParsedNode {
	type: string;
	name?: string;
	prelude?: {type: string; value?: string} | null;
	block?: {children: {toArray(): ParsedNode[]}} | null;
	property?: string;
	value?: {type: string; value?: string} | null;
	important?: boolean | string;
	children?: {toArray(): ParsedNode[]} | null;
}

function nodesOf(container: {
	children?: {toArray(): ParsedNode[]} | null;
}): ParsedNode[] {
	return container.children ? container.children.toArray() : [];
}

/** The declarations of a rule's block, in source order. */
function blockDeclarations(node: ParsedNode): CSSDeclaration[] {
	const declarations: CSSDeclaration[] = [];
	if (!node.block) {
		return declarations;
	}
	for (const child of nodesOf(node.block)) {
		if (child.type !== "Declaration") {
			continue;
		}
		const name = parsePropertyName(child.property ?? "");
		const value = serializeCSSValue(
			cssTree.generate(child.value as never),
			name,
		);
		if (!value) {
			continue;
		}
		declarations.push({
			name,
			value,
			important: child.important === true,
		});
	}
	return declarations;
}

/** A rule block's text, as a declaration block takes it. */
function blockText(node: ParsedNode): string {
	return blockDeclarations(node)
		.map(
			({name, value, important}) =>
				`${name}: ${value}${important ? " !important" : ""};`,
		)
		.join(" ");
}

/** Parse a rule list, as a sheet's text or a grouping rule's body. */
function parseRules(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule[] {
	let ast: {children: {toArray(): ParsedNode[]}};
	try {
		ast = cssTree.parse(text, {
			parseValue: false,
			parseAtrulePrelude: false,
			parseRulePrelude: false,
			parseCustomProperty: false,
		}) as never;
	} catch (_err) {
		return [];
	}
	return convertRules(ast.children.toArray(), sheet, parentRule);
}

/** One rule's text, as insertRule takes it. */
function parseRuleText(
	text: string,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
): CSSRule {
	const source = String(text ?? "");
	let ast: {children: {toArray(): ParsedNode[]}};
	try {
		ast = cssTree.parse(source, {
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
	const rule = convertRule(nodes[0], sheet, parentRule, sheetNamespaces(sheet));
	if (!rule) {
		throw domException(`Cannot parse rule: ${source}`, "SyntaxError", sheet);
	}
	return rule;
}

/**
 * A sheet's rules, in source order.
 *
 * The namespaces a selector resolves against are the ones declared BEFORE it:
 * a sheet is read top to bottom, and an @namespace reaches only the rules that
 * follow it. The map is therefore built as the walk goes rather than read back
 * off a sheet that is still being built.
 */
function convertRules(
	source: readonly ParsedNode[],
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
	namespaces: SelectorNamespaces = {default: null, prefixes: new Map()},
): CSSRule[] {
	const rules: CSSRule[] = [];
	for (const node of source) {
		const rule = convertRule(node, sheet, parentRule, namespaces);
		if (!rule) {
			continue;
		}
		if (rule instanceof CSSNamespaceRule) {
			if (rule.prefix === "") {
				namespaces.default = rule.namespaceURI;
			} else {
				namespaces.prefixes.set(
					cssTree.ident.decode(rule.prefix),
					rule.namespaceURI,
				);
			}
		}
		rules.push(rule);
	}
	return rules;
}

/** An at-rule's prelude, as written. */
function preludeText(node: ParsedNode): string {
	return (node.prelude?.value ?? "").trim();
}

function convertRule(
	node: ParsedNode,
	sheet: CSSStyleSheet | null,
	parentRule: CSSRule | null,
	namespaces: SelectorNamespaces = NO_NAMESPACES,
): CSSRule | null {
	if (node.type === "Rule") {
		const prelude = preludeText(node);
		const selectors = parseSelectorList(prelude);
		if (!selectors) {
			return null;
		}
		// A prefix no @namespace declared names no namespace, and a selector
		// naming one does not parse.
		if (
			prelude.includes("|") &&
			!selectorNamespace(prelude, namespaces).valid
		) {
			return null;
		}
		return new CSSStyleRule(
			selectors,
			blockText(node),
			sheet,
			parentRule,
			(rule) => convertRules(nestedRules(node), sheet, rule, namespaces),
		);
	}
	if (node.type !== "Atrule") {
		return null;
	}
	const prelude = preludeText(node);
	switch ((node.name ?? "").toLowerCase()) {
		// A charset rule is not exposed in a sheet's rule list, per CSSOM.
		case "charset":
			return null;
		case "container":
			return new CSSContainerRule(prelude, sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group, namespaces),
			);
		case "counter-style":
			return new CSSCounterStyleRule(prelude, blockText(node), sheet);
		case "font-face":
			return new CSSFontFaceRule(blockText(node), sheet, parentRule);
		case "font-feature-values":
			return new CSSFontFeatureValuesRule(prelude, node, sheet);
		case "font-palette-values":
			return new CSSFontPaletteValuesRule(prelude, blockText(node), sheet);
		case "import":
			return convertImportRule(prelude, sheet);
		case "keyframes":
		case "-webkit-keyframes":
			return new CSSKeyframesRule(prelude, sheet, (rule) =>
				nodesOf(node.block ?? {})
					.filter((frame) => frame.type === "Rule")
					.map(
						(frame) =>
							new CSSKeyframeRule(
								preludeText(frame),
								blockText(frame),
								sheet,
								rule,
							),
					),
			);
		case "layer":
			return node.block ?
					new CSSLayerBlockRule(prelude, sheet, parentRule, (group) =>
						convertRules(nodesOf(node.block ?? {}), sheet, group, namespaces),
					) :
					new CSSLayerStatementRule(prelude, sheet, parentRule);
		case "media":
			return new CSSMediaRule(prelude, sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group, namespaces),
			);
		case "namespace": {
			const match = /^(?:([^\s]+)\s+)?(.*)$/.exec(prelude);
			return new CSSNamespaceRule(
				match?.[1] ?? "",
				unwrapURL(match?.[2] ?? ""),
				sheet,
			);
		}
		case "page":
			return new CSSPageRule(prelude, blockText(node), sheet, parentRule);
		case "property":
			return new CSSPropertyRule(prelude, blockText(node), sheet);
		case "scope":
			return new CSSScopeRule(prelude, sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group, namespaces),
			);
		case "starting-style":
			return new CSSStartingStyleRule(sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group, namespaces),
			);
		case "supports":
			return new CSSSupportsRule(prelude, sheet, parentRule, (group) =>
				convertRules(nodesOf(node.block ?? {}), sheet, group, namespaces),
			);
		default:
			return null;
	}
}

/** The style rules nested inside a style rule's own block. */
function nestedRules(node: ParsedNode): ParsedNode[] {
	return nodesOf(node.block ?? {}).filter(
		(child) => child.type === "Rule" || child.type === "Atrule",
	);
}

/** `url("x")` or `"x"` reduced to the URL it names. */
function unwrapURL(text: string): string {
	const trimmed = text.trim();
	const url = /^url\(\s*(.*?)\s*\)$/i.exec(trimmed);
	const body = url ? url[1] : trimmed;
	return /^["']/.test(body) ? body.slice(1, -1) : body;
}

/** `@import <url> [layer] [supports()] [media]`, split into its parts. */
function convertImportRule(
	prelude: string,
	sheet: CSSStyleSheet | null,
): CSSImportRule {
	let rest = prelude.trim();
	const head = /^(url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')/.exec(
		rest,
	);
	const href = unwrapURL(head?.[1] ?? "");
	rest = rest.slice(head?.[1].length ?? 0).trim();

	let layerName: string | null = null;
	const layer = /^layer(?:\(\s*([^)]*)\s*\))?/i.exec(rest);
	if (layer) {
		layerName = layer[1]?.trim() ?? "";
		rest = rest.slice(layer[0].length).trim();
	}

	let supportsText: string | null = null;
	if (/^supports\(/i.test(rest)) {
		// The condition nests parentheses -- `supports((a: b) or (c: d))` --
		// so its end is the parenthesis that closes the one it opened.
		let depth = 0;
		let end = rest.length;
		for (let i = "supports(".length - 1; i < rest.length; i++) {
			if (rest[i] === "(") {
				depth++;
			} else if (rest[i] === ")" && --depth === 0) {
				end = i;
				break;
			}
		}
		supportsText = rest.slice("supports(".length, end).trim();
		rest = rest.slice(end + 1).trim();
	}

	return new CSSImportRule(href, rest, layerName, supportsText, sheet);
}

// Assigning a rule's text does nothing, as in every engine -- but the
// attribute exists, so every rule type carries the setter alongside the
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
	CSSPageRule,
	CSSCounterStyleRule,
	CSSPropertyRule,
	CSSFontPaletteValuesRule,
	CSSKeyframeRule,
	CSSFontFeatureValuesRule,
	CSSKeyframesRule,
]) {
	// The getter may live on a base class, so the chain is walked for it.
	let prototype: object | null = type.prototype;
	let descriptor: PropertyDescriptor | undefined;
	while (prototype && !descriptor) {
		descriptor = Object.getOwnPropertyDescriptor(prototype, "cssText");
		prototype = Object.getPrototypeOf(prototype);
	}
	if (!descriptor?.get) {
		continue;
	}
	Object.defineProperty(type.prototype, "cssText", {
		...descriptor,
		set() {},
	});
}

/** The one sheet a `<style>` (or `<link>`) element owns. */
const elementSheets = new WeakMap<Element, CSSStyleSheet>();

/** The sheets a document or shadow root has adopted. */
const adoptedSheets = new WeakMap<Node, CSSStyleSheet[]>();

/** Marks a prototype whose CSSOM accessors are already the engine's. */
const kStyleSheetsInstalled = Symbol("termdom.styleSheets");

function sheetFor(element: Element): CSSStyleSheet {
	let sheet = elementSheets.get(element);
	if (!sheet) {
		sheet = new CSSStyleSheet({}, element);
		sheetNotifiers.set(sheet, () => {
			const window = element.ownerDocument?.defaultView;
			if (window) {
				styleManagers.get(window)?.refreshStylesheets();
			}
		});
		elementSheets.set(element, sheet);
	}
	return sheet;
}

/**
 * The `<style>` elements a document holds, as a bare length to poll.
 *
 * The document counts them as they join and leave its trees, so a length read
 * answers "has a sheet appeared" without walking for one -- cheap enough to
 * ask on every computed-style read.
 */
function documentStyleSheetList(document: Document): {length: number} {
	const counted = document as unknown as DOMDocument;
	return {
		get length(): number {
			return styleElementCount(counted);
		},
	};
}

/**
 * The sheets a tree's own elements declare, which is what `styleSheets`
 * lists. An adopted sheet belongs to no element and is not one of them.
 */
function declaredStyleSheets(root: Document | ShadowRoot): CSSStyleSheet[] {
	return Array.from(root.querySelectorAll("style"), sheetFor);
}

/**
 * A document's stylesheets: one per `<style>` element in tree order, followed
 * by what the document adopted. A `<link>` never resolves to a sheet -- there
 * is no network behind a terminal document.
 */
function documentStyleSheets(document: Document): CSSStyleSheet[] {
	return [
		...declaredStyleSheets(document),
		...(adoptedSheets.get(document) ?? []),
	];
}

/** A shadow root's stylesheets: its own `<style>` elements, then what it adopted. */
function shadowStyleSheets(root: ShadowRoot): CSSStyleSheet[] {
	return [...declaredStyleSheets(root), ...(adoptedSheets.get(root) ?? [])];
}

/** The cascade a tree's sheets belong to. */
function managerForTree(tree: Node): StyleManager | undefined {
	const document =
		tree.nodeType === tree.DOCUMENT_NODE ?
				(tree as Document) :
			tree.ownerDocument;
	return document ? documentManagers.get(document) : undefined;
}

/** A sheet a tree may adopt: one an author constructed, and nothing else. */
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
	sheetNotifiers.set(sheet, () => managerForTree(tree)?.refreshStylesheets());
	return sheet;
}

/**
 * Adopt a list of constructed sheets, and wire each one's later mutations to
 * the cascade -- a constructed sheet has no consumer until something adopts it.
 */
function adopt(target: Node, sheets: unknown): void {
	const adopted = Array.from(sheets as Iterable<unknown>).map((sheet) =>
		checkAdoptable(target, sheet),
	);
	// One array per tree, replaced in place: the observable array an author
	// already holds is the same object after a whole reassignment.
	let list = adoptedSheets.get(target);
	if (!list) {
		adoptedSheets.set(target, (list = []));
	}
	list.length = 0;
	for (const [index, sheet] of adopted.entries()) {
		defineIndex(list, index, sheet);
	}
}

/**
 * Write one index of a backing list.
 *
 * An ObservableArray's backing list is not a JavaScript object: it has no
 * prototype behind it, and an index write to it consults nothing. A plain
 * assignment to an array does consult the prototype chain, so an accessor
 * installed at `Array.prototype[1]` would run with the backing list as its
 * receiver -- handing an author the list itself and swallowing the write.
 * Defining the property is the write with no chain behind it.
 */
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

/** The observable array behind one tree's `adoptedStyleSheets`. */
const adoptedProxies = new WeakMap<Node, CSSStyleSheet[]>();

/**
 * `adoptedStyleSheets` as an ObservableArray: the list an author holds is the
 * list the cascade reads, so `push`, `splice` and an indexed write all take
 * effect where a whole reassignment would -- and each is checked as one.
 */
function observableAdopted(
	target: Node,
	list: CSSStyleSheet[],
): CSSStyleSheet[] {
	let proxy = adoptedProxies.get(target);
	if (proxy) {
		return proxy;
	}
	const changed = (): void => {
		managerForTree(target)?.refreshStylesheets();
	};
	// Assignment to arbitrary indices of adoptedStyleSheets must be observed.
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
			// No notification: an array method that deletes an index (`pop`,
			// `shift`) writes the new length straight after, and the cascade
			// must not read the list between the two.
			return Reflect.deleteProperty(array, property);
		},
	});
	adoptedProxies.set(target, proxy);
	return proxy;
}

/**
 * Put this engine's CSSOM behind the document's stylesheet surface: a style
 * element's `sheet`, `document.styleSheets`, and the adopted lists.
 */
function installStyleSheets(window: EngineWindow): void {
	cssomWindow = window;

	const documentPrototype = window.Document.prototype;
	const owner = documentPrototype as unknown as Record<
		string | symbol,
		unknown
	>;
	// The prototypes are the realm's, shared by every document in it. Redefining
	// an accessor on one is a change to its shape, so doing it per cascade
	// deoptimizes every read of it that came before.
	if (!owner[kStyleSheetsInstalled]) {
		owner[kStyleSheetsInstalled] = true;

		Object.defineProperty(documentPrototype, "styleSheets", {
			get(this: Document) {
				const sheets = declaredStyleSheets(this);
				const list = new StyleSheetList(sheets);
				syncIndexed(list);
				return list;
			},
			configurable: true,
			enumerable: true,
		});

		for (const prototype of [documentPrototype, window.ShadowRoot?.prototype]) {
			if (!prototype) {
				continue;
			}
			Object.defineProperty(prototype, "adoptedStyleSheets", {
				get(this: Node) {
					let list = adoptedSheets.get(this);
					if (!list) {
						adoptedSheets.set(this, (list = []));
					}
					return observableAdopted(this, list);
				},
				set(this: Node, sheets: unknown) {
					adopt(this, sheets);
					managerForTree(this)?.refreshStylesheets();
				},
				configurable: true,
				enumerable: true,
			});
		}

		if (window.ShadowRoot) {
			Object.defineProperty(window.ShadowRoot.prototype, "styleSheets", {
				get(this: ShadowRoot) {
					const sheets = declaredStyleSheets(this);
					const list = new StyleSheetList(sheets);
					syncIndexed(list);
					return list;
				},
				configurable: true,
				enumerable: true,
			});
		}

		Object.defineProperty(window.HTMLStyleElement.prototype, "sheet", {
			get(this: Element) {
				// A style element outside a tree has no sheet, as in a browser.
				return this.parentNode ? sheetFor(this) : null;
			},
			configurable: true,
			enumerable: true,
		});

		// Nothing is fetched over a terminal's document, so a link never resolves
		// to a sheet.
		Object.defineProperty(window.HTMLLinkElement.prototype, "sheet", {
			get() {
				return null;
			},
			configurable: true,
			enumerable: true,
		});
	}

	Object.assign(window, {
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
		CSS: CSSNamespace,
	});
}

/**
 * Every CSSOM interface names itself: `Object.prototype.toString` on one of
 * its objects gives the interface name, as it does for any platform object.
 */
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

/** The UA document sheet, parsed once: its rules never change. */
let uaDocumentSheet: CSSStyleSheet | null = null;

function uaStyleSheet(): CSSStyleSheet {
	if (!uaDocumentSheet) {
		uaDocumentSheet = new CSSStyleSheet();
		uaDocumentSheet.replaceSync(UA_DOCUMENT_STYLES);
	}
	return uaDocumentSheet;
}

/**
 * The properties whose resolved value is the used value, per CSSOM: the box's
 * own dimensions, its edges, and the offsets that place it. Everything else
 * resolves to its computed value.
 */
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

/** A used length in the one unit a terminal has: a cell, spelled `px`. */
function usedLength(cells: number): string {
	return `${Math.round(cells * 1000) / 1000}px`;
}

/**
 * The colors whose `auto` names the element's own color: a caret is drawn in
 * the text's color, and an outline whose color was left to the UA takes it
 * too. The resolved value CSSOM reports is that used color.
 */
const AUTO_COLOR_PROPERTIES = new Set(["caret-color", "outline-color"]);

/** The two sizes whose `auto` names a minimum only some boxes have. */
const MIN_SIZE_PROPERTIES = new Set(["min-width", "min-height"]);

/** The containers whose children have an automatic minimum size. */
const PSEUDO_ELEMENT_NAMES = ["::before", "::after", "::marker"];

const ITEM_DISPLAYS = new Set(["flex", "grid", "inline-flex", "inline-grid"]);

/** The block-level display an inline-level box takes as a flex or grid item. */
const BLOCKIFIED_DISPLAYS: Record<string, string> = {
	"inline": "block",
	"inline-block": "block",
	"inline-flex": "flex",
	"inline-grid": "grid",
	"inline-table": "table",
};

function blockified(display: string): string {
	return BLOCKIFIED_DISPLAYS[display] ?? display;
}

/** The four properties that place a positioned box against its containing block. */
const INSET_PROPERTIES = new Set(["top", "right", "bottom", "left"]);

const OPPOSITE_INSET: Record<string, string> = {
	top: "bottom",
	bottom: "top",
	left: "right",
	right: "left",
};

/**
 * A computed inset as a length in cells, with percentages -- and the one
 * percentage a calc() can still carry -- resolved against the containing
 * block. Null for `auto`, which is not a length but an instruction to
 * measure.
 */
function insetLength(computed: string, basis: number): number | null {
	if (!computed || computed === "auto") {
		return null;
	}
	const calc = /^calc\(([+-]?[\d.]+)px ([+-]) ([\d.]+)%\)$/.exec(computed);
	if (calc) {
		const percentage = (parseFloat(calc[3]) / 100) * basis;
		return parseFloat(calc[1]) + (calc[2] === "-" ? -percentage : percentage);
	}
	if (computed.endsWith("%")) {
		return (parseFloat(computed) / 100) * basis;
	}
	const length = parseFloat(computed);
	return Number.isFinite(length) ? length : null;
}

/**
 * A computed style as the engine reads it: `computedValueOf` alone, answering
 * the cascade's value with no resolved-value branch and no author-facing
 * bookkeeping. Computed-only by construction, not by flag.
 */
export interface ComputedStyle {
	computedValueOf(property: string): string;
}

/**
 * An element's computed style, for the engine itself.
 *
 * Straight to the declaration the cascade caches: no `getComputedStyle` call,
 * no pseudo-element parsing, no flat-tree walk, no used-value branch. This is
 * the read layout and paint make thousands of times a frame.
 */
export function computedStyleOf(element: Element): ComputedStyle {
	// A pseudo-element node's style is its host's declaration for the
	// pseudo-element it fills; it matches no selector of its own.
	const host = pseudoHostOf<Element>(element);
	if (host !== null) {
		const name = pseudoNameOf(element) as string;
		const manager = host.ownerDocument ?
				documentManagers.get(host.ownerDocument) :
			undefined;
		return manager ?
				manager.pseudoNodeStyleFor(element, host, name) :
				pseudoStyleOf(host, name);
	}
	const document = element.ownerDocument;
	if (!document) {
		return EMPTY_COMPUTED_STYLE;
	}
	const manager = documentManagers.get(document);
	if (manager) {
		return manager.declarationFor(element);
	}
	// A document with no cascade of this engine's behind it -- a bare document,
	// which the tree walker is exercised against -- still answers, through
	// whatever getComputedStyle it has.
	const window = document.defaultView;
	return window ?
			foreignComputedStyle(window.getComputedStyle(element)) :
		EMPTY_COMPUTED_STYLE;
}

function foreignComputedStyle(
	declaration: globalThis.CSSStyleDeclaration,
): ComputedStyle {
	return {
		computedValueOf: (property: string): string =>
			declaration.getPropertyValue(property),
	};
}

/** A pseudo-element's computed style, on the same internal read path. */
export function pseudoStyleOf(
	element: Element,
	pseudoElement: string,
): ComputedStyle {
	const document = element.ownerDocument;
	if (!document) {
		return EMPTY_COMPUTED_STYLE;
	}
	const manager = documentManagers.get(document);
	if (manager) {
		return manager.pseudoDeclarationFor(element, pseudoElement);
	}
	const window = document.defaultView;
	return window ?
			foreignComputedStyle(window.getComputedStyle(element, pseudoElement)) :
		EMPTY_COMPUTED_STYLE;
}

/**
 * Expose a computed style's indices to an author.
 *
 * The index accessors read through item(), so they answer the live list; the
 * count re-synchronizes on refresh, but only for declarations that have been
 * handed out here -- the engine's own computed styles never materialize an
 * item list.
 */
function indexedDeclaration<T extends CSSStyleDeclaration>(declaration: T): T {
	syncIndexed(declaration);
	return declaration;
}

/** What a read answers before a document has a cascade behind it. */
const EMPTY_COMPUTED_STYLE: ComputedStyle = {
	computedValueOf(): string {
		return "";
	},
};

/** The epoch a declaration with no manager behind it watches: one that never moves. */
const NO_STYLE_EPOCH = {value: 0};

export class ComputedStyleDeclaration extends CSSStyleProperties {
	declare [kElement]: Element;
	declare [kCSSRules]: ParsedCSSRule[];
	/**
	 * The manager to re-ask for matching rules, and the epoch it bumps when
	 * every declaration goes stale at once. A computed style is LIVE: the
	 * object an author holds keeps answering the element's current values
	 * across class flips, rule insertions and sheet replacements, so it
	 * re-resolves rather than being replaced.
	 */
	declare [kManager]: StyleManager | null;
	declare [kEpoch]: typeof NO_STYLE_EPOCH;
	declare [kSeenEpoch]: number;
	declare [kStale]: boolean;
	// Lazily resolved properties -- INCLUDING ones that resolved to "".
	// Values here are COMPUTED strings, materialized once per property per
	// generation; an initial-valued property (word-break, visibility, ...)
	// that re-resolved on every read would re-walk the whole ancestor chain
	// for an inherited property, and each ancestor's own read does the same
	// -- thousands of full cascade resolutions per keystroke. The
	// declaration is discarded wholesale on invalidation, so memoizing here
	// needs no invalidation of its own.
	declare [kResolved]: Map<string, string>;

	constructor(
		element: Element,
		cssRules: ParsedCSSRule[] = [],
		manager?: StyleManager,
	) {
		super();
		this[kManager] = null;
		this[kEpoch] = NO_STYLE_EPOCH;
		this[kSeenEpoch] = 0;
		this[kStale] = false;
		this[kResolved] = new Map<string, string>();
		this[kUsed] = null;
		this[kUsedEpoch] = -1;
		this[kCustom] = null;
		this[kElement] = element;
		this[kCSSRules] = cssRules;
		if (manager) {
			this[kManager] = manager;
			this[kEpoch] = manager.styleEpoch;
			this[kSeenEpoch] = this[kEpoch].value;
		}
	}

	/**
	 * Used values, memoized against the layout epoch they were measured in.
	 * Made on the first resolved read: most elements are never asked for one,
	 * and a map per element is a map per element.
	 */
	declare [kUsed]: Map<string, string> | null;
	declare [kUsedEpoch]: number;

	/**
	 * A resolved value that is the used value: measured through the same flush
	 * a geometry read takes, and memoized against the layout epoch so a
	 * property-heavy caller measures once per layout rather than once per read.
	 */
	[kUsedValue](property: string): string {
		const manager = this[kManager]!;
		const epoch = manager.layoutEpoch;
		if (!this[kUsed]) {
			this[kUsed] = new Map();
		} else if (epoch !== this[kUsedEpoch]) {
			this[kUsed].clear();
		}
		this[kUsedEpoch] = epoch;
		const memoized = this[kUsed].get(property);
		if (memoized !== undefined) {
			return memoized;
		}

		const computed = this.computedValueOf(property);
		const value = this[kMeasure](property, computed);
		this[kUsed].set(property, value);
		return value;
	}

	/**
	 * One property's computed value: the cascade's declaration, interned, and
	 * absolutized against this element when the interned entry says only an
	 * element can answer it. The memo both callers write into is the
	 * per-element, per-generation cache that absolutization is paid into once.
	 */
	[kComputed](property: string): string {
		const entry = computedEntry(
			property,
			this[kResolvePropertyValue](property),
		);
		if (!entry.contextual) {
			return entry.value;
		}
		const absolute = absolutizeLengths(
			entry.value,
			this[kLengthContext](property),
		);
		// Two radii that differ as written -- `1ch 1px` -- can measure the same
		// cell, and a corner whose radii agree states one of them.
		return RADIUS_LONGHANDS.has(property) ? collapseRadius(absolute) : absolute;
	}

	/**
	 * What a relative length on this element is worth.
	 *
	 * `font-size` measures against the PARENT's font size, so it is the one
	 * property whose own computed value is not in its own context; every other
	 * property measures against this element's font size, which therefore
	 * computes first.
	 */
	[kLengthContext](property: string): LengthContext {
		const own = property === "font-size";
		const parent = own ? flatParentElement<Element>(this[kElement]) : null;
		const font = own ?
			parent ?
					fontSizeOf(computedStyleOf(parent)) :
				INITIAL_FONT_SIZE :
				fontSizeOf(this);
		const root = this[kRootFontSize](own);
		const viewport = this[kManager]?.viewportSize();
		return {
			font,
			root,
			viewportWidth: viewport ? viewport.width : 0,
			viewportHeight: viewport ? viewport.height : 0,
			// A percentage is font-relative on exactly two properties: on
			// `font-size` it is a share of the parent's, on `line-height` of
			// this element's own. Everywhere else it stays a percentage until
			// something uses it.
			percent: FONT_RELATIVE_PERCENTAGES.has(property) ? font / 100 : null,
		};
	}

	/** The font size `rem` measures against: the root element's. */
	[kRootFontSize](ownFontSize: boolean): number {
		const root = this[kElement].ownerDocument?.documentElement;
		// `rem` in the root's own font-size is the initial value, not the
		// value being computed.
		if (!root || (ownFontSize && root === this[kElement])) {
			return INITIAL_FONT_SIZE;
		}
		return root === this[kElement] ?
				fontSizeOf(this) :
				fontSizeOf(computedStyleOf(root));
	}

	/**
	 * The computed value: what the cascade says, before any box exists. This
	 * is what the engine's own geometry decisions read -- a used value there
	 * would feed layout its own output.
	 */
	computedValueOf(property: string): string {
		if (this[kStale] || this[kEpoch].value !== this[kSeenEpoch]) {
			this[kRefresh]();
		}
		let value = this[kResolved].get(property);
		if (value === undefined) {
			const longhands = SHORTHAND_LONGHANDS.get(property);
			value = longhands ?
					this[kShorthand](property, longhands, (longhand) =>
						this.computedValueOf(longhand),
					) : // A flow-relative longhand shares its computed value with the
					// physical longhand it maps to, so it is answered as that one.
					this[kComputed](this[kPhysicalOf](property));
			this[kResolved].set(property, value);
		}
		return value;
	}

	/**
	 * The name a longhand computes under: itself, or -- for a flow-relative
	 * longhand -- the physical longhand this element's `direction` maps it to.
	 */
	[kPhysicalOf](property: string): string {
		if (!LOGICAL_TO_PHYSICAL.ltr.has(property)) {
			return property;
		}
		return (
			physicalProperty(property, this.computedValueOf("direction")) ?? property
		);
	}

	/**
	 * A shorthand answers as its longhands, each in the spelling `read` gives
	 * it, collapsed: `margin: 10px 10px 10px 10px` is "10px". The reader is the
	 * caller's, because the computed and resolved value paths ask their
	 * longhands different questions -- and their answers must not meet, which
	 * is why only the computed one is memoized.
	 */
	[kShorthand](
		property: string,
		longhands: readonly string[],
		read: (longhand: string) => string,
	): string {
		return serializeShorthandValue(
			property,
			longhands,
			(longhand) => read(longhand) || CSS_INITIAL_VALUES[longhand] || "",
		);
	}

	[kMeasure](property: string, computed: string): string {
		// A border with no style draws nothing and takes no space, whatever
		// width it declares.
		if (property.startsWith("border-") && property.endsWith("-width")) {
			const style = this.computedValueOf(
				`${property.slice(0, -"-width".length)}-style`,
			);
			if (!style || style === "none" || style === "hidden") {
				return "0px";
			}
		}
		const inset = INSET_PROPERTIES.has(property);
		// An inset only applies to a positioned box; on a static one it stays
		// as declared.
		const position = inset ? this.getPropertyValue("position") : "";
		if (inset && position === "static") {
			return computed;
		}

		const rect = this[kManager]!.usedRect(this[kElement]);
		// No box -- display:none, or a tree layout never reached -- so the
		// computed value is the answer, exactly as CSSOM says.
		if (!rect) {
			return computed;
		}

		if (inset) {
			return this[kUsedInset](property, computed, rect, position);
		}

		if (property === "width" || property === "height") {
			const vertical = property === "height";
			const edges =
				this[kEdge](vertical ? "border-top-width" : "border-left-width") +
				this[kEdge](vertical ? "border-bottom-width" : "border-right-width") +
				this[kEdge](vertical ? "padding-top" : "padding-left") +
				this[kEdge](vertical ? "padding-bottom" : "padding-right");
			const border = vertical ? rect.height : rect.width;
			// `box-sizing: border-box` measures the border box itself.
			const content =
				this.getPropertyValue("box-sizing") === "border-box" ?
					border :
					border - edges;
			return usedLength(Math.max(0, content));
		}

		// An `auto` margin is whatever space the box was given: the distance
		// between its border box and its containing block's content edge.
		if (computed === "auto" && property.startsWith("margin-")) {
			return usedLength(this[kAutoMargin](property, rect));
		}

		// Every other used length is already absolute in this engine's own
		// unit, so the computed value carries it; only a percentage still has
		// to be resolved, against the containing block's width.
		if (computed.endsWith("%")) {
			const basis = this[kContainingWidth]();
			if (basis === null) {
				return computed;
			}
			return usedLength((parseFloat(computed) / 100) * basis);
		}
		return computed || "0px";
	}

	/**
	 * A positioned box's inset, as used.
	 *
	 * A declared inset resolves where it stands -- a percentage against the
	 * containing block, everything else as written -- which is also what CSSOM
	 * asks for when the four insets over-constrain the box. `auto` is the one
	 * that has to be measured: it is whatever distance the box ended up at.
	 */
	[kUsedInset](
		property: string,
		computed: string,
		rect: DOMRect,
		position: string,
	): string {
		const block = this[kContainingBlockBox](position);
		if (!block) {
			return computed;
		}
		const vertical = property === "top" || property === "bottom";
		const basis = vertical ? block.height : block.width;
		const own = insetLength(computed, basis);
		if (own !== null) {
			return usedLength(own);
		}
		// A sticky box keeps its `auto`: it names an edge that constrains
		// nothing, not a distance.
		if (position === "sticky") {
			return computed;
		}

		const opposite = OPPOSITE_INSET[property];
		const other = insetLength(this.computedValueOf(opposite), basis);
		// A relatively positioned box is offset from where it already was, so
		// an `auto` inset is the negative of its opposite -- and zero when both
		// are auto, which moves the box nowhere.
		if (position === "relative") {
			return usedLength(other === null ? 0 : -other);
		}

		// Out of flow: the box hangs in its containing block, so the used
		// inset is the distance from that block's edge to the box's margin
		// edge -- the far side of the box when the opposite inset placed it,
		// and its static position when neither did.
		const start = vertical ? "margin-top" : "margin-left";
		const end = vertical ? "margin-bottom" : "margin-right";
		if (other !== null) {
			const size =
				(vertical ? rect.height : rect.width) +
				this[kEdge](start) +
				this[kEdge](end);
			return usedLength(basis - other - size);
		}
		switch (property) {
			case "top":
				return usedLength(rect.y - this[kEdge](start) - block.y);
			case "left":
				return usedLength(rect.x - this[kEdge](start) - block.x);
			case "bottom":
				return usedLength(
					block.y + block.height - (rect.y + rect.height + this[kEdge](end)),
				);
			default:
				return usedLength(
					block.x + block.width - (rect.x + rect.width + this[kEdge](end)),
				);
		}
	}

	/**
	 * The box this element's insets are measured against: the padding box of
	 * the containing block an out-of-flow box hangs from, the scrollport a
	 * sticky box is constrained by, and otherwise the content box of the box
	 * this one flows in.
	 */
	[kContainingBlockBox](position: string): DOMRect | null {
		if (position === "fixed") {
			return this[kViewportBox]();
		}
		if (position === "absolute") {
			for (
				let ancestor = flatParentElement<Element>(this[kElement]);
				ancestor;
				ancestor = flatParentElement<Element>(ancestor)
			) {
				const ancestorPosition =
					computedStyleOf(ancestor).computedValueOf("position");
				if (ancestorPosition && ancestorPosition !== "static") {
					return this[kBoxOf](ancestor, false);
				}
			}
			return this[kViewportBox]();
		}
		if (position === "sticky") {
			for (
				let ancestor = flatParentElement<Element>(this[kElement]);
				ancestor;
				ancestor = flatParentElement<Element>(ancestor)
			) {
				const overflow = computedStyleOf(ancestor).computedValueOf("overflow");
				if (overflow && overflow !== "visible") {
					return this[kBoxOf](ancestor, true);
				}
			}
		}
		const parent = flatParentElement<Element>(this[kElement]);
		return parent ? this[kBoxOf](parent, true) : this[kViewportBox]();
	}

	/** An ancestor's padding box, or its content box, in the same coordinates as a rect. */
	[kBoxOf](element: Element, content: boolean): DOMRect | null {
		const rect = this[kManager]!.usedRect(element);
		if (!rect) {
			return null;
		}
		const style = computedStyleOf(element);
		const edge = (name: string): number =>
			parseFloat(style.computedValueOf(name)) || 0;
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

	/** The initial containing block: the grid itself. */
	[kViewportBox](): DOMRect | null {
		const viewport = this[kManager]!.viewportSize();
		if (!viewport) {
			return null;
		}
		const rect = this[kManager]!.usedRect(this[kElement]);
		if (!rect) {
			return null;
		}
		return new (rect.constructor as typeof DOMRect)(
			0,
			0,
			viewport.width,
			viewport.height,
		);
	}

	/**
	 * `min-width: auto` and `min-height: auto` as resolved.
	 *
	 * The keyword means "the box's automatic minimum size", which only a flex
	 * or grid item, or a box with an aspect ratio, actually has; anywhere else
	 * -- and for a box that was never generated -- it is zero, which is the
	 * value CSSOM reports.
	 */
	[kResolvedMinSize](computed: string): string {
		if (computed !== "auto") {
			return computed;
		}
		// A box that was never generated has no automatic minimum, whatever
		// else its style says.
		for (
			let element: Element | null = this[kElement];
			element;
			element = flatParentElement<Element>(element)
		) {
			if (computedStyleOf(element).computedValueOf("display") === "none") {
				return "0px";
			}
		}
		if (this.computedValueOf("aspect-ratio") !== "auto") {
			return "auto";
		}
		const parent = flatParentElement<Element>(this[kElement]);
		const display = parent ?
				computedStyleOf(parent).computedValueOf("display") :
			"";
		return ITEM_DISPLAYS.has(display) ? "auto" : "0px";
	}

	/** One edge length in cells, for the arithmetic above. */
	[kEdge](property: string): number {
		return parseFloat(this.getPropertyValue(property)) || 0;
	}

	/** The space an `auto` margin actually took, measured off the two boxes. */
	[kAutoMargin](property: string, rect: DOMRect): number {
		const parent = flatParentElement<Element>(this[kElement]);
		const parentRect = parent ? this[kManager]!.usedRect(parent) : null;
		if (!parent || !parentRect) {
			return 0;
		}
		const parentStyle = computedStyleOf(parent);
		const edge = (name: string): number =>
			parseFloat(parentStyle.computedValueOf(name)) || 0;
		const left =
			parentRect.x + edge("border-left-width") + edge("padding-left");
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

	/** The width a percentage on this element resolves against. */
	[kContainingWidth](): number | null {
		const parent = flatParentElement<Element>(this[kElement]);
		if (!parent) {
			return null;
		}
		const rect = this[kManager]!.usedRect(parent);
		return rect ? rect.width : null;
	}

	/** Mark this declaration's values as belonging to a cascade that has moved on. */
	invalidate(): void {
		this[kStale] = true;
	}

	/**
	 * Re-resolve against the current cascade. Reads take the two-field guard
	 * inline and call this only when it has actually moved -- this sits on the
	 * hottest path in the engine, under every property read of every element.
	 */
	[kRefresh](): void {
		if (!this[kManager]) {
			return;
		}
		this[kStale] = false;
		this[kSeenEpoch] = this[kEpoch].value;
		this[kCSSRules] = this[kManager].matchingRules(this[kElement]);
		this[kCustom] = null;
		this[kResolved].clear();
		this[kUsed]?.clear();
		if ((this as IndexedCollection)[kIndexCount] !== undefined) {
			syncIndexed(this);
		}
	}

	/**
	 * The element's inline declarations, expanded to longhands.
	 *
	 * The store behind `element.style` is this engine's own CSSOM, which keeps
	 * a declaration as authored and hands the cascade the expanded block --
	 * so a shorthand's `!important` covers every longhand it declares.
	 */
	[kInlineDeclarations](): DeclarationBlock {
		const style = (this[kElement] as HTMLElement).style;
		return style instanceof CSSStyleDeclaration ?
				style.declarationBlock() :
			EMPTY_DECLARATIONS;
	}

	/** This element's flat-tree parent's computed value for `property`, or null at the root. */
	[kResolveFromParent](property: string): string | null {
		const parent = flatParentElement<Element>(this[kElement]);
		if (!parent) {
			return null;
		}
		return computedStyleOf(parent).computedValueOf(property) || null;
	}

	/**
	 * Resolve `var(--name[, fallback])` references in a declared value.
	 *
	 * Custom properties always inherit (they aren't subject to the fixed
	 * INHERITED_PROPERTIES list), so lookup walks the element's own inline style
	 * and matching rules first, then the parent chain via getComputedStyle --
	 * which recurses through this same substitution at each ancestor, so a
	 * custom property whose own value references another var() resolves too.
	 * A depth guard stops a property that (invalidly) refers to itself.
	 */
	[kSubstituteVar](value: string, depth = 0): string {
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
			const fallback =
				commaIndex === -1 ? undefined : inner.slice(commaIndex + 1).trim();

			const resolved = this[kResolveCustomProperty](name);
			if (resolved !== null) {
				out += this[kSubstituteVar](resolved, depth + 1);
			} else if (fallback !== undefined) {
				out += this[kSubstituteVar](fallback, depth + 1);
			}
			// Neither a value nor a fallback: the guaranteed-invalid value -- omit,
			// which approximates the property's own initial/inherited fallback.

			i = j;
		}
		return out;
	}

	[kResolveCustomProperty](name: string): string | null {
		// A custom property is just an ordinary (always-inherited) cascade lookup
		// -- #resolvePropertyValueRaw's step 4 already walks ancestors for it.
		return this[kResolvePropertyValueRaw](name) || null;
	}

	/**
	 * Resolve property value applying CSS cascade: inline styles > CSS rules >
	 * defaults, with `!important` promoted above all of that (an important
	 * stylesheet rule beats even a non-important inline style, per spec), and
	 * `var()` references substituted in whatever wins.
	 */
	[kResolvePropertyValue](property: string): string {
		const raw = this[kResolvePropertyValueRaw](property);
		// A custom property holds the tokens it was given; substituting it
		// into a property of its own grammar re-serializes them in that
		// property's spelling.
		const value = raw ?
			property.startsWith("--") ?
					this[kSubstituteVar](raw) :
					serializeCSSValue(this[kSubstituteVar](raw), property) :
			raw;
		// `currentcolor` is the element's own color, which is what a resolved
		// value says; on `color` itself it means the parent's.
		if (
			value.toLowerCase() === "currentcolor" &&
			COLOR_PROPERTIES.has(property)
		) {
			// The COMPUTED color, on the engine's own read path: this is the
			// cascade resolving a value, and the author path flushes -- which
			// drains mutations and lays the document out, from inside the
			// resolution of a style that layout is waiting on. `color` has no
			// used value to wait for, so the two answer alike.
			return property === "color" ?
					(this[kResolveFromParent]("color") ?? "") :
					this.computedValueOf("color");
		}
		return value;
	}

	[kResolvePropertyValueRaw](property: string): string {
		// A physical property and the flow-relative properties that map to it
		// are ONE cascade slot (css-logical-1 §2.1): every name in the slot
		// computes to the value of the declaration that comes last in the
		// cascade, whichever name that declaration used. Which flow-relative
		// name maps here depends on the element's `direction`, so the slot's
		// names are widened to both inline edges and narrowed by direction
		// only once a block actually declares one of them.
		const logical = PHYSICAL_TO_LOGICAL.get(property);
		const names = logical ? [property, ...logical] : [property];
		let direction: string | null = null;
		const mapsHere = (name: string): boolean =>
			name === property ||
			physicalProperty(
				name,
				(direction ??= this.computedValueOf("direction")),
			) === property;

		const inline = this[kInlineDeclarations]();
		const inlineName = declaredName(inline, names, false, mapsHere);
		const inlineValue = inlineName ?
				inline.declarations[inlineName].trim() :
			undefined;
		const inlineUsable = !!inlineValue && !INITIAL_KEYWORDS.has(inlineValue);
		const inlineImportantName = declaredName(inline, names, true, mapsHere);
		const inlineImportantValue = inlineImportantName ?
				inline.declarations[inlineImportantName].trim() :
			undefined;
		const inlineImportant =
			!!inlineImportantValue && !INITIAL_KEYWORDS.has(inlineImportantValue);

		// `inherit` skips the rest of the cascade and goes straight to the parent's
		// resolved value, regardless of whether this property normally inherits.
		if (inlineImportant && inlineImportantValue === "inherit") {
			return this[kResolveFromParent](property) ?? "";
		}
		if (!inlineImportant && inlineUsable && inlineValue === "inherit") {
			return this[kResolveFromParent](property) ?? "";
		}

		// 1 & 2. Inline style and stylesheet rules, with an !important tier above
		// the normal cascade. #cssRules is pre-sorted by specificity/source order,
		// so within each tier the last match wins.
		let ruleValue: string | null = null;
		let importantRuleValue: string | null = null;
		// `!important` reverses the layer order (css-cascade-5 §6.4.4): the
		// EARLIEST layer wins, and unlayered declarations -- which win the
		// normal cascade -- lose to every layer. The rules arrive with the
		// earliest layer first, so the first layer to declare the property
		// keeps it, and later ones only tie it within the same layer.
		let importantOrigin = false;
		let importantLayer = 0;
		for (const rule of this[kCSSRules]) {
			const name = declaredName(rule, names, false, mapsHere);
			if (name !== null) {
				ruleValue = rule.declarations[name];
			}
			const importantName = declaredName(rule, names, true, mapsHere);
			if (
				importantName !== null &&
				(importantRuleValue === null ||
					Boolean(rule.uaOrigin) !== importantOrigin ||
					rule.layerRank === importantLayer)
			) {
				importantRuleValue = rule.declarations[importantName];
				importantOrigin = Boolean(rule.uaOrigin);
				importantLayer = rule.layerRank;
			}
		}

		// A CSS-wide keyword a rule declares is not a value: `inherit` takes the
		// parent's, and the rest send resolution on to the defaults below, as
		// though the declaration were not there.
		const declaredByRule = (value: string): string | null => {
			if (value === "inherit") {
				return this[kResolveFromParent](property) ?? "";
			}
			return INITIAL_KEYWORDS.has(value) ? null : value;
		};

		if (inlineImportant) {
			return inlineImportantValue!;
		}
		if (importantRuleValue) {
			const resolved = declaredByRule(importantRuleValue);
			if (resolved !== null) {
				return resolved;
			}
		} else if (inlineUsable) {
			return inlineValue!;
		} else if (ruleValue) {
			const resolved = declaredByRule(ruleValue);
			if (resolved !== null) {
				return resolved;
			}
		}

		// 3. Check element-specific UA defaults (e.g., strong { font-weight: bold })
		// These take priority over inherited values
		const tagName = this[kElement].tagName.toLowerCase();

		// A list's marker gutter is sized to its widest marker rather than taken
		// from the static table, so it has to be resolved before it.
		if (
			property === "padding-left" &&
			(tagName === "ul" || tagName === "ol") &&
			this[kElement].ownerDocument?.defaultView
		) {
			return `${getListGutterWidth(this[kElement])}ch`;
		}

		// The UA default marker type depends on nesting depth, exactly as a browser's
		// `ul ul { list-style-type: circle }` rules do. Resolving it here rather than
		// inheriting means an author value on an outer list does not leak into a
		// nested one, while an author rule that matches the nested list still wins:
		// it was already returned in step 2.
		if (
			property === "list-style-type" &&
			(tagName === "ul" || tagName === "ol")
		) {
			if (tagName === "ol") {
				return "decimal";
			}
			const bullets = ["disc", "circle", "square"];
			const depth = listNestingDepth(this[kElement]);
			return bullets[Math.min(depth, bullets.length - 1)];
		}

		const elementDefaults = getElementDefaults(this[kElement]);
		if (elementDefaults && elementDefaults[property]) {
			return elementDefaults[property];
		}

		// 4. For inherited properties, walk up the DOM using getComputedStyle
		// which correctly resolves CSS rules on parent elements. Custom properties
		// (--x) always inherit -- there's no fixed list for them to be in.
		if (INHERITED_PROPERTIES.has(property) || property.startsWith("--")) {
			const window = this[kElement].ownerDocument?.defaultView;
			if (window) {
				// Flat-tree parents: inheritance crosses the shadow boundary
				// (host -> shadow child) and reaches slotted content through
				// its slot's chain, exactly as in a browser.
				for (
					let parent = flatParentElement<Element>(this[kElement]);
					parent !== null;
					parent = flatParentElement<Element>(parent)
				) {
					const parentValue = computedStyleOf(parent).computedValueOf(property);
					if (parentValue) {
						return parentValue;
					}
				}
			}
		}

		// 5. Fallback to universal defaults and CSS spec defaults
		return getInitialStyle(this[kElement], property);
	}

	// Resolution is fully lazy: construction populates nothing, and each
	// property resolves on first read, then answers from the memo. Most
	// elements are only ever asked a handful of properties -- the
	// composition walker asks each element `display` alone.
	override getPropertyValue(property: string): string {
		// The author's read, and the DOM it describes is the DOM as it stands:
		// a style object held across a class flip answers for the flip. The
		// engine reads through computedValueOf, which takes no flush -- style
		// is resolved from inside layout, which this would re-enter.
		this[kManager]?.flushStyle();
		if (this[kStale] || this[kEpoch].value !== this[kSeenEpoch]) {
			this[kRefresh]();
		}
		// A flow-relative longhand resolves as the physical longhand it maps
		// to: same slot, same measurement, same answer.
		property = this[kPhysicalOf](property);
		if (this[kManager] && USED_VALUE_PROPERTIES.has(property)) {
			return this[kUsedValue](property);
		}
		if (this[kManager] && MIN_SIZE_PROPERTIES.has(property)) {
			return this[kResolvedMinSize](this.computedValueOf(property));
		}
		if (AUTO_COLOR_PROPERTIES.has(property)) {
			const computed = this.computedValueOf(property);
			return computed === "auto" ? this.getPropertyValue("color") : computed;
		}
		const longhands = SHORTHAND_LONGHANDS.get(property);
		if (longhands) {
			return this[kShorthand](property, longhands, (longhand) =>
				this.getPropertyValue(longhand),
			);
		}
		return this.computedValueOf(property);
	}

	/** Computed styles are read-only; writing one is an error, not a no-op. */
	override setProperty(): void {
		throw readOnlyDeclaration(this[kElement]);
	}

	override removeProperty(): string {
		throw readOnlyDeclaration(this[kElement]);
	}

	override getPropertyPriority(): string {
		return "";
	}

	/**
	 * A computed style declares every supported longhand, so its indices name
	 * them in the property index's order rather than the order reads happened
	 * to resolve them in -- followed by the custom properties in effect on the
	 * element, which are declarations too and have no place in that index.
	 */
	override item(index: number): string {
		return (
			CSS_LONGHANDS[index] ??
			this[kCustomNames]()[index - CSS_LONGHANDS.length] ??
			""
		);
	}

	override get length(): number {
		return CSS_LONGHANDS.length + this[kCustomNames]().length;
	}

	override [Symbol.iterator](): IterableIterator<string> {
		return [...CSS_LONGHANDS, ...this[kCustomNames]()][Symbol.iterator]();
	}

	/** The names of the custom properties declared for this element. */
	declaredCustomProperties(): string[] {
		const names: string[] = [];
		for (const rule of this[kCSSRules]) {
			for (const name of Object.keys(rule.declarations)) {
				if (name.startsWith("--") && !names.includes(name)) {
					names.push(name);
				}
			}
		}
		for (const name of Object.keys(this[kInlineDeclarations]().declarations)) {
			if (name.startsWith("--") && !names.includes(name)) {
				names.push(name);
			}
		}
		return names;
	}

	declare [kCustom]: string[] | null;

	/**
	 * The custom properties in effect here: this element's own, and every one
	 * an ancestor declared -- a custom property inherits, so it is part of
	 * this element's computed style whichever element declared it.
	 */
	[kCustomNames](): string[] {
		if (this[kStale] || this[kEpoch].value !== this[kSeenEpoch]) {
			this[kRefresh]();
		}
		if (this[kCustom]) {
			return this[kCustom];
		}
		const names = new Set<string>();
		for (
			let element: Element | null = this[kElement];
			element;
			element = flatParentElement<Element>(element)
		) {
			const declaration = this[kManager]?.declarationFor(element);
			for (const name of declaration?.declaredCustomProperties() ?? []) {
				names.add(name);
			}
		}
		this[kCustom] = [...names];
		return this[kCustom];
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
}

/**
 * Whether an element takes part in rendering: it is in a document, and the
 * flat tree that document composes reaches it. A light-DOM child its host
 * never slots is in neither, and has no computed style to report.
 */
function isBeingRendered(element: Element): boolean {
	// Walk out through every shadow root the element sits under: a tree whose
	// outermost root is the document is composed into the rendering, and one
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
	// tree. A closed root is this engine's own widget internals, whose parts
	// the widget itself reads styles for.
	for (
		let child: Element | null = element;
		child;
		child = child.parentElement
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

/**
 * A pseudo-element's computed style: a flat declaration set -- the matched
 * rules plus what it inherits from its originating element -- read through
 * the same computed-value boundary as an element's.
 */
export class PseudoStyleDeclaration extends CSSStyleProperties {
	declare [kPseudoDeclarations]: Record<string, string>;
	// Lazily resolved properties, cleared by #refresh -- the same one-per
	// -generation memo an element's declaration keeps, for the same reason.
	declare [kResolved]: Map<string, string>;
	/**
	 * The element the pseudo-element originates from, which pseudo-element it
	 * is, and the manager whose flush a resolved value is measured behind.
	 * Absent on the engine's own reads (the ::selection and ::marker painters),
	 * which want the cascade's declarations and never a used value -- and whose
	 * declarations, handed in whole, are not the manager's to recompute.
	 */
	declare [kElement]: Element | null;
	declare [kPseudoElement]: string;
	declare [kManager]: StyleManager | null;
	/**
	 * The epoch every declaration goes stale at once on. A pseudo-element's
	 * computed style is LIVE for the same reason an element's is: the object an
	 * author holds keeps answering the pseudo-element's current values across
	 * class flips and sheet replacements.
	 */
	declare [kEpoch]: typeof NO_STYLE_EPOCH;
	declare [kSeenEpoch]: number;

	constructor(
		declarations: Record<string, string>,
		element?: Element,
		manager?: StyleManager,
		pseudoElement = "",
	) {
		super();
		this[kResolved] = new Map<string, string>();
		this[kEpoch] = NO_STYLE_EPOCH;
		this[kSeenEpoch] = 0;
		this[kNodeStyle] = null;
		this[kNodeResolved] = new Map<string, string>();
		this[kPseudoDeclarations] = declarations;
		this[kElement] = element ?? null;
		this[kPseudoElement] = pseudoElement;
		this[kManager] = manager ?? null;
		if (manager) {
			this[kEpoch] = manager.styleEpoch;
			this[kSeenEpoch] = this[kEpoch].value;
		}
	}

	/** Re-resolve against the current cascade, declarations and all. */
	[kRefresh](): void {
		this[kSeenEpoch] = this[kEpoch].value;
		if (this[kManager] && this[kElement] && this[kPseudoElement]) {
			this[kPseudoDeclarations] = this[kManager].pseudoDeclarations(
				this[kElement],
				this[kPseudoElement],
			);
		}
		this[kResolved].clear();
		this[kNodeResolved].clear();
		if ((this as IndexedCollection)[kIndexCount] !== undefined) {
			syncIndexed(this);
		}
	}

	/**
	 * What the cascade declared for this pseudo-element, and nothing else.
	 *
	 * This is the engine's read: an empty answer means no rule reached the
	 * pseudo-element, which is what the ::selection painter and the ::marker
	 * painter decide on. The author read below completes the same declarations
	 * with the initial values a computed style carries.
	 */
	computedValueOf(property: string): string {
		if (this[kEpoch].value !== this[kSeenEpoch]) {
			this[kRefresh]();
		}
		let value = this[kResolved].get(property);
		if (value === undefined) {
			const longhands = SHORTHAND_LONGHANDS.get(property);
			value =
				longhands && this[kPseudoDeclarations][property] === undefined ?
						serializeShorthandValue(
							property,
							longhands,
							(longhand) =>
								this.computedValueOf(longhand) ||
								CSS_INITIAL_VALUES[longhand] ||
								"",
						) :
						computedValue(property, this[kPseudoDeclarations][property] ?? "");
			this[kResolved].set(property, value);
		}
		return value;
	}

	/**
	 * The style of the NODE a pseudo-element generates: the same declarations,
	 * completed with the initial value of everything no rule and no
	 * inheritance gave a value. A box is laid out and painted from this -- an
	 * empty answer would leave it with no `display` at all -- while the
	 * cascade read above stays the bare declarations the ::selection and
	 * ::marker painters decide on.
	 */
	get nodeStyle(): ComputedStyle {
		let style = this[kNodeStyle];
		if (style === null) {
			// One object for the declaration's life: the memo behind it is a
			// field #refresh clears, so a holder of this view sees the current
			// cascade rather than the one it was first read under.
			style = {
				computedValueOf: (property: string): string => {
					if (this[kEpoch].value !== this[kSeenEpoch]) {
						this[kRefresh]();
					}
					let value = this[kNodeResolved].get(property);
					if (value === undefined) {
						value =
							this.computedValueOf(property) ||
							computedValue(property, getInitialStyle(null, property));
						this[kNodeResolved].set(property, value);
					}
					return value;
				},
			};
			this[kNodeStyle] = style;
		}
		return style;
	}

	declare [kNodeStyle]: ComputedStyle | null;
	declare [kNodeResolved]: Map<string, string>;

	override getPropertyValue(property: string): string {
		this[kManager]?.flushStyle();
		const computed =
			this.computedValueOf(property) ||
			computedValue(property, getInitialStyle(null, property));
		if (this[kManager] && USED_VALUE_PROPERTIES.has(property)) {
			return this[kUsedValue](property, computed);
		}
		return computed;
	}

	/**
	 * A pseudo-element's resolved value, measured behind the same flush an
	 * element's is.
	 *
	 * A pseudo-element box hangs in the content box of the element it
	 * originates from, which is what its percentages resolve against -- the
	 * one measurement the layout it was composed into can answer for it. A
	 * pseudo that generates no box (`display: none`, `display: contents`, an
	 * originating element with no box of its own) keeps its computed value,
	 * exactly as an element with no box does.
	 */
	[kUsedValue](property: string, computed: string): string {
		if (!computed.endsWith("%")) {
			return computed;
		}
		const display = this.getPropertyValue("display");
		if (display === "none" || display === "contents") {
			return computed;
		}
		// An originating element with `display: contents` generates no box of
		// its own, so its pseudo-elements hang in the box its own parent
		// makes -- the same box its children hang in.
		let host: Element | null = this[kElement];
		while (
			host &&
			computedStyleOf(host).computedValueOf("display") === "contents"
		) {
			host = flatParentElement<Element>(host);
		}
		const box = host && this[kManager]!.contentBox(host);
		if (!box) {
			return computed;
		}
		// Every percentage but the block-axis sizes measures against the
		// containing block's width, block direction included.
		const vertical =
			property === "height" || property === "top" || property === "bottom";
		const basis = vertical ? box.height : box.width;
		return usedLength((parseFloat(computed) / 100) * basis);
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

	/**
	 * A pseudo-element's computed style declares every supported longhand,
	 * exactly as an element's does.
	 */
	override item(index: number): string {
		return CSS_LONGHANDS[index] ?? "";
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
}

/**
 * The answer to a `getComputedStyle` pseudo-element argument that names no
 * pseudo-element: a declaration of nothing, as CSSOM says.
 */
export class EmptyStyleDeclaration extends CSSStyleProperties {
	declare [kElement]: Element | null;

	constructor(element?: Element) {
		super();
		this[kElement] = element ?? null;
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

	override get length(): number {
		return 0;
	}

	override get cssText(): string {
		return "";
	}

	override set cssText(_text: string) {
		throw readOnlyDeclaration(this[kElement] ?? undefined);
	}
}

/**
 * A computed style is read-only; writing one is an error, not a no-op. The
 * error is the document's own DOMException where one is reachable -- an error
 * from another global is not the one an author catches.
 */
function readOnlyDeclaration(element?: Element): DOMException {
	const Exception =
		(
			element?.ownerDocument?.defaultView as unknown as {
				DOMException?: typeof DOMException;
			}
		)?.DOMException ?? DOMException;
	return new Exception(
		"A computed style declaration is read-only",
		"NoModificationAllowedError",
	);
}

/**
 * The property accessors (`style.fontWeight`) callers reach for alongside
 * getPropertyValue, installed once for the properties this engine resolves.
 */
const ACCESSOR_PROPERTIES = new Set<string>([
	...LENGTH_PROPERTIES,
	...COLOR_PROPERTIES,
	...INHERITED_PROPERTIES,
	...BOX_SHORTHAND_LONGHANDS.keys(),
	"align-content",
	"align-items",
	"align-self",
	"background",
	"background-image",
	"background-position",
	"background-repeat",
	"border",
	"border-bottom-color",
	"border-bottom-style",
	"border-collapse",
	"border-color",
	"border-left-color",
	"border-left-style",
	"border-radius",
	"border-right-color",
	"border-right-style",
	"border-style",
	"border-top-color",
	"border-top-style",
	"box-sizing",
	"clear",
	"content",
	"counter-increment",
	"counter-reset",
	"display",
	"flex",
	"flex-direction",
	"flex-grow",
	"flex-shrink",
	"flex-wrap",
	"float",
	"gap",
	"inset",
	"isolation",
	"justify-content",
	"opacity",
	"order",
	"outline",
	"outline-color",
	"outline-style",
	"overflow",
	"overflow-x",
	"overflow-y",
	"position",
	"table-layout",
	"text-decoration-color",
	"text-decoration-line",
	"text-decoration-style",
	"vertical-align",
	"z-index",
]);

for (const property of ACCESSOR_PROPERTIES) {
	const camelCase = property.replace(/-([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
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

// ============================================================================
// BORDER UTILITIES
// ============================================================================

export const BorderEdgeStyle = {
	// Style values (bits 3-0)
	None: 0b0000,
	Dotted: 0b0001,
	Dashed: 0b0010,
	Solid: 0b0011,
	Groove: 0b0100,
	Ridge: 0b0101,
	Inset: 0b0110,
	Outset: 0b0111,
	Double: 0b1000,
	Hidden: 0b1111,

	// Flags (bit 4+)
	// Set on the edges that meet in a corner cell whose radius rounds it, and
	// on nothing else: the runs between corners are the same line either way.
	Rounded: 0b00010000,
} as const;
export type BorderEdgeStyle = number;

interface BoxCharSet {
	horizontal: string;
	vertical: string;
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	topTee: string;
	bottomTee: string;
	leftTee: string;
	rightTee: string;
	cross: string;
}

export const BOX_DRAWING: Record<string, BoxCharSet> = {
	dashed: {
		horizontal: "╌",
		vertical: "┆",
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	},
	dotted: {
		horizontal: "┄",
		vertical: "┊",
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	},
	double: {
		horizontal: "═",
		vertical: "║",
		topLeft: "╔",
		topRight: "╗",
		bottomLeft: "╚",
		bottomRight: "╝",
		topTee: "╦",
		bottomTee: "╩",
		leftTee: "╣",
		rightTee: "╠",
		cross: "╬",
	},
	heavy: {
		horizontal: "━",
		vertical: "┃",
		topLeft: "┏",
		topRight: "┓",
		bottomLeft: "┗",
		bottomRight: "┛",
		topTee: "┳",
		bottomTee: "┻",
		leftTee: "┫",
		rightTee: "┣",
		cross: "╋",
	},
	light: {
		horizontal: "─",
		vertical: "│",
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		topTee: "┬",
		bottomTee: "┴",
		leftTee: "┤",
		rightTee: "├",
		cross: "┼",
	},
};

/**
 * The rounded form of a corner glyph.
 *
 * Unicode draws rounded corners for the light single stroke alone, so this is
 * the whole of what a terminal can bend: the light-cornered character sets --
 * solid, dashed, dotted, ridge, inset, outset -- round, and double and heavy
 * corners stay square because no glyph exists that bends those strokes. That
 * is the deliberate adaptation: a radius on a double border is honored as far
 * as the terminal's characters allow, which is not at all.
 */
export const ROUNDED_CORNERS: Readonly<Record<string, string>> = {
	"┌": "╭",
	"┐": "╮",
	"└": "╰",
	"┘": "╯",
};

/** An element's border sides, in `drawBorder`'s own vocabulary. */
export interface BorderSides {
	top?: LineStyle["style"];
	right?: LineStyle["style"];
	bottom?: LineStyle["style"];
	left?: LineStyle["style"];
	corners: {
		topLeft: boolean;
		topRight: boolean;
		bottomRight: boolean;
		bottomLeft: boolean;
	};
}

const LINE_KEYWORDS = new Set<LineStyle["style"]>([
	"solid",
	"double",
	"dashed",
	"dotted",
	"groove",
	"ridge",
	"inset",
	"outset",
	"hidden",
]);

export function resolveBorderSides(element: Element): BorderSides {
	const computedStyle = computedStyleOf(element);

	const sideOf = (
		width: string,
		style: string,
	): LineStyle["style"] | undefined => {
		const parsed = parseBorderWidthValue(width);
		const widthValue = typeof parsed === "number" ? parsed : NaN;
		if (isNaN(widthValue) || widthValue <= 0 || !style || style === "none") {
			return undefined;
		}
		// An unknown style keyword draws as solid rather than not at all.
		return LINE_KEYWORDS.has(style as LineStyle["style"]) ?
				(style as LineStyle["style"]) :
			"solid";
	};

	// A corner is rounded when its radius is nonzero on BOTH axes, exactly as
	// a browser squares off a corner whose ellipse has collapsed. A cell grid
	// has one size of curve, so how large the radius is says nothing further.
	const isRounded = (corner: string): boolean => {
		const radii = computedStyle
			.computedValueOf(`border-${corner}-radius`)
			.split(/\s+/)
			.filter(Boolean);
		if (radii.length === 0) {
			return false;
		}
		return radii.every((radius) => parseFloat(radius) > 0);
	};

	const of = (side: string): LineStyle["style"] | undefined =>
		sideOf(
			computedStyle.computedValueOf(`border-${side}-width`) ||
			computedStyle.computedValueOf("border-width"),
			computedStyle.computedValueOf(`border-${side}-style`) ||
			computedStyle.computedValueOf("border-style"),
		);

	return {
		top: of("top"),
		right: of("right"),
		bottom: of("bottom"),
		left: of("left"),
		corners: {
			topLeft: isRounded("top-left"),
			topRight: isRounded("top-right"),
			bottomRight: isRounded("bottom-right"),
			bottomLeft: isRounded("bottom-left"),
		},
	};
}

/** Roman numeral for 1-3999; callers must range-check. */
function toRoman(num: number): string {
	const romanNumerals = [
		{value: 1000, symbol: "M"},
		{value: 900, symbol: "CM"},
		{value: 500, symbol: "D"},
		{value: 400, symbol: "CD"},
		{value: 100, symbol: "C"},
		{value: 90, symbol: "XC"},
		{value: 50, symbol: "L"},
		{value: 40, symbol: "XL"},
		{value: 10, symbol: "X"},
		{value: 9, symbol: "IX"},
		{value: 5, symbol: "V"},
		{value: 4, symbol: "IV"},
		{value: 1, symbol: "I"},
	];

	let remaining = num;
	let result = "";
	for (const {value, symbol} of romanNumerals) {
		while (remaining >= value) {
			result += symbol;
			remaining -= value;
		}
	}
	return result;
}

/** How many lists this element is nested inside, not counting itself. */
function listNestingDepth(element: Element): number {
	let depth = 0;
	for (
		let parent = element.parentElement;
		parent;
		parent = parent.parentElement
	) {
		if (parent.tagName === "UL" || parent.tagName === "OL") {
			depth++;
		}
	}
	return depth;
}

/** Marker glyphs for the bullet list-style-types. */
const BULLET_MARKERS: Record<string, string> = {
	disc: "\u2022",
	circle: "\u25e6",
	square: "\u25aa",
};

/** list-style-types that produce a counter, and therefore a trailing "." */
const COUNTER_STYLES = new Set([
	"decimal",
	"decimal-leading-zero",
	"lower-alpha",
	"lower-latin",
	"lower-roman",
	"upper-alpha",
	"upper-latin",
	"upper-roman",
]);

/** Alphabetic counters are bijective base-26: 26 -> "z", 27 -> "aa". */
function toAlpha(value: number): string {
	let n = value;
	let out = "";
	while (n > 0) {
		const digit = (n - 1) % 26;
		out = String.fromCharCode(97 + digit) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

/**
 * The ordinal of a list item, honouring the HTML list attributes.
 *
 * `<ol start>` sets where counting begins, `<ol reversed>` counts down, and a
 * `<li value>` resets the counter mid-list and carries forward from there.
 */
function listItemOrdinal(listItem: Element, listParent: Element): number {
	const items = Array.from(listParent.children).filter(
		(child) => child.tagName === "LI",
	);

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

/** Render an ordinal in a counter style, falling back to decimal out of range. */
function formatOrdinal(ordinal: number, listStyleType: string): string {
	switch (listStyleType) {
		case "decimal-leading-zero":
			return ordinal >= 0 && ordinal < 10 ? `0${ordinal}` : `${ordinal}`;
		case "lower-alpha":
		case "lower-latin":
			return ordinal > 0 ? toAlpha(ordinal) : `${ordinal}`;
		case "lower-roman":
			// Roman numerals are undefined outside 1-3999; CSS falls back to decimal.
			return ordinal > 0 && ordinal < 4000 ?
					toRoman(ordinal).toLowerCase() :
				`${ordinal}`;
		case "upper-alpha":
		case "upper-latin":
			return ordinal > 0 ? toAlpha(ordinal).toUpperCase() : `${ordinal}`;
		case "upper-roman":
			return ordinal > 0 && ordinal < 4000 ? toRoman(ordinal) : `${ordinal}`;
		default:
			return `${ordinal}`;
	}
}

/**
 * The default marker text for a list item, e.g. "\u2022" or "iii.".
 *
 * Keyed off the *computed* list-style-type, not the parent's tag name: a `ul`
 * can be `list-style-type: decimal` and an `ol` can be `disc`, and either can be
 * `none`. Reading the type off the tag made all three impossible, and ignored a
 * list-style-type set on the `li` itself.
 */
function getListMarker(listItem: Element, listParent: Element): string {
	const listStyleType =
		computedStyleOf(listItem).computedValueOf("list-style-type");

	if (!listStyleType || listStyleType === "none") {
		return "";
	}

	const bullet = BULLET_MARKERS[listStyleType];
	if (bullet) {
		return bullet;
	}

	if (COUNTER_STYLES.has(listStyleType)) {
		const items = Array.from(listParent.children).filter(
			(child) => child.tagName === "LI",
		);
		if (!items.includes(listItem)) {
			return "";
		}
		return `${formatOrdinal(listItemOrdinal(listItem, listParent), listStyleType)}.`;
	}

	return "";
}

// TODO: Just use the CSSOM CSSRule interface from the DOM
interface ParsedCSSRule {
	selector: string;
	/**
	 * The element type the selector's subject is anchored to, lowercased --
	 * absent when the subject names no type and any element could be it. Every
	 * rule is tried against every element, so this is the reject that keeps a
	 * document of divs from running the selector engine over a sheet's worth of
	 * rules about summaries and legends.
	 */
	subjectTag?: string;
	declarations: Record<string, string>;
	/** Properties declared `!important` in this rule. */
	important: Record<string, boolean>;
	/** Each declaration's position in the rule's block. See DeclarationBlock. */
	order: Record<string, number>;
	specificity: string; // Zero-padded string for lexicographic comparison
	pseudoElement?: string;
	/**
	 * The tree scope whose stylesheet declared this rule: a ShadowRoot for
	 * rules from a shadow tree's <style>, undefined for document rules. A
	 * rule only ever matches elements of its own tree -- the cascade's
	 * encapsulation boundary in both directions.
	 */
	scope?: Node;
	/**
	 * Parsed form of a `:host`-prefixed selector (only meaningful with a
	 * shadow `scope`): `predicate` is the parenthesized/compound condition
	 * the HOST must match (null = unconditional), `rest` targets descendant
	 * shadow-tree elements (null = the rule styles the host itself), and
	 * `child` restricts `rest` to direct children of the shadow root.
	 */
	host?: {predicate: string | null; rest: string | null; child: boolean};
	/**
	 * The namespace the selector's subject must be in: a URI, null for no
	 * namespace, absent when the selector names none and any will do.
	 */
	namespace?: string | null;
	/**
	 * True for rules declared by a UA-internal shadow tree's stylesheet.
	 * Cascade ORIGIN, the tier above specificity: every author rule beats
	 * every UA rule, which is what lets `input::placeholder { color }`
	 * override the UA sheet's gray despite the UA attribute selector's
	 * higher specificity -- exactly the browser's origin ordering.
	 */
	uaOrigin?: boolean;
	/**
	 * The cascade layer this rule was declared in, dot-joined through every
	 * enclosing `@layer`, or null for a rule in no layer.
	 */
	layer: string | null;
	/**
	 * Where the rule's layer sorts, smallest first: layers in the order their
	 * names were declared, then -- last, and so winning the normal cascade --
	 * every unlayered rule. Filled in once the whole layer order is known.
	 */
	layerRank: number;
	/**
	 * The `@scope` conditions the rule was declared inside, outermost first.
	 * Absent for a rule no `@scope` encloses, which is in scope everywhere.
	 */
	scopes?: readonly ScopeCondition[];
}

/**
 * One `@scope (start) to (end)` prelude: the selector lists naming the scoping
 * roots and the scoping limits. `start` is null for `@scope` written without a
 * root, whose root is the element the stylesheet's owner node sits in.
 */
interface ScopeCondition {
	start: string | null;
	end: string | null;
	/** The implicit scoping root, for a condition that names none. */
	owner: Element | null;
}

/** The conditional rules a style rule was found inside, as the cascade reads them. */
interface RuleContext {
	layer: string | null;
	scopes: readonly ScopeCondition[];
}

/** The context of a rule at the top level of a stylesheet. */
const UNCONDITIONAL: RuleContext = {layer: null, scopes: []};

/**
 * The proximity of a declaration in no scope: farther from any element than
 * any scoping root can be, and the same distance for every one of them.
 */
const UNSCOPED = Number.MAX_SAFE_INTEGER;

/**
 * Whether an element is a scoping root of this condition. A condition naming
 * no root has one all the same: the element the stylesheet was written in.
 */
function scopeRootMatches(
	element: Element,
	condition: ScopeCondition,
	outer: Element | null,
): boolean {
	if (condition.start === null) {
		return element === condition.owner;
	}
	return splitSelectorList(condition.start).some((selector) =>
		outer ?
				matchesInScope(element, selector, outer) :
				matchesSelector(element, selector),
	);
}

/**
 * Whether an element is in the scope a root opens: inside it, and with no
 * scoping limit between the two. The root is always in its own scope, limit
 * or no limit.
 */
function inScopeOf(
	element: Element,
	root: Element,
	condition: ScopeCondition,
): boolean {
	const limits = condition.end ? splitSelectorList(condition.end) : [];
	let node: Element | null = element;
	for (; node && node !== root; node = node.parentElement) {
		if (limits.some((selector) => matchesInScope(node!, selector, root))) {
			return false;
		}
	}
	return node === root;
}

/** `element.matches`, with a selector the matcher rejects matching nothing. */
function matchesSelector(element: Element, selector: string): boolean {
	try {
		return element.matches(selector);
	} catch (_err) {
		return false;
	}
}

/**
 * Whether an element matches a scoped selector, `:scope` standing for the
 * given scoping root.
 *
 * A selector opening with a combinator is relative to the root, which is what
 * `@scope { > .a { } }` means. The root's own subtree is the DOM's own scoping
 * root, so a selector reaching down from `:scope` is matched by asking it for
 * the elements it selects; a selector whose subject IS the root cannot be, and
 * matches with `:scope` standing for any element -- the identity it asserts is
 * already established.
 */
function matchesInScope(
	element: Element,
	selector: string,
	root: Element,
): boolean {
	let text = selector.trim();
	if (/^[>+~]/.test(text)) {
		text = `:scope ${text}`;
	}
	try {
		if (!text.includes(":scope")) {
			return element.matches(text);
		}
		if (element === root) {
			const subject = subjectCompoundStart(text);
			// `:scope` on a non-subject compound asks the root to be a strict
			// descendant of itself.
			if (text.slice(0, subject).includes(":scope")) {
				return false;
			}
			return element.matches(
				text.slice(0, subject) + text.slice(subject).replaceAll(":scope", "*"),
			);
		}
		for (const found of root.querySelectorAll(text)) {
			if (found === element) {
				return true;
			}
		}
		return false;
	} catch (_err) {
		return false;
	}
}

/** Where a complex selector's subject compound starts: past its last combinator. */
function subjectCompoundStart(selector: string): number {
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let index = 0; index < selector.length; index++) {
		const char = selector[index];
		if (quote) {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = "";
			}
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(" || char === "[") {
			depth++;
		} else if (char === ")" || char === "]") {
			depth--;
		} else if (depth === 0 && /[\s>+~]/.test(char)) {
			start = index + 1;
		}
	}
	return start;
}

// CSS Counter interfaces
interface CounterState {
	[counterName: string]: number;
}

interface CounterScope {
	element: Element;
	counters: CounterState;
	parent?: CounterScope;
}

export class StyleManager {
	declare [kComputedStyleCache]: WeakMap<Element, ComputedStyleDeclaration>;
	/**
	 * The counter every computed style watches. A bump means the whole cascade
	 * changed -- new rules, a new sheet -- and every declaration handed out
	 * must resolve again.
	 */
	declare [kStyleEpoch]: {value: number};
	/**
	 * Every shadow root whose <style> elements participate in the cascade.
	 * Nothing else parses a shadow tree's stylesheets, so parsing walks these
	 * and feeds each <style>'s text through the parser document sheets take.
	 */
	declare [kShadowRoots]: Set<ShadowRoot>;
	declare [kPseudoElementStyleCache]: WeakMap<
		Element,
		Map<string, PseudoStyleDeclaration>
	>;

	declare [kParsedRules]: ParsedCSSRule[];
	declare [kStylesheetsDirty]: boolean;
	/**
	 * Whether any parsed selector can reach OUTSIDE the mutated element's
	 * subtree: sibling combinators reach following siblings, :has() reaches
	 * ancestors. Set during parsing, read by invalidationScopeFor() to decide
	 * how much layout a class/id flip must rebuild. String tests are
	 * deliberately loose (`~=` in an attribute selector counts as a sibling
	 * combinator): a false positive only widens the rebuild.
	 */
	declare [kSelectorsReachSiblings]: boolean;
	declare [kSelectorsReachAncestors]: boolean;
	/**
	 * The keys a change to which can reach an element's DESCENDANTS: those a
	 * selector tests left of a combinator (`.editing .view` is TodoMVC's edit
	 * row), and those on rules declaring an inherited property, which the
	 * descendants take their own value from. A class the sheets only ever
	 * test on the subject of rules declaring `background` and `display`
	 * (`.row.selected`) reaches nothing below.
	 *
	 * Collected loosely, by scanning compounds for `.name`, `#name` and
	 * `[name`: keys inside :not()/:is() are read the same way, and a false
	 * positive only widens the invalidation.
	 */
	declare [kReachingClasses]: Set<string>;
	declare [kReachingIds]: Set<string>;
	declare [kReachingAttributes]: Set<string>;
	/**
	 * Whether any of those keys is a STATE pseudo-class (`:checked ~`,
	 * `details[open] :not(summary)`) rather than a name. State pseudos are
	 * driven by attributes whose names are not in the sets above, so a change
	 * to any of {@link STATE_ATTRIBUTES} goes wide while this holds.
	 */
	declare [kReachingStates]: boolean;
	/**
	 * Rule-existence gates, also set during parsing. Attaching pseudos and
	 * initializing counters both start by building full computed-style
	 * declarations -- per element, on every insertion and attribute change.
	 * A document whose sheets declare no ::before for divs and no counters
	 * anywhere must not pay that; these let the hot paths answer "could any
	 * rule possibly apply here" with a few matches() calls instead.
	 */
	declare [kPseudoRulesByType]: Map<string, ParsedCSSRule[]>;
	declare [kCounterRulesExist]: boolean;
	declare [kListItemRulesExist]: boolean;
	/** Whether any rule is scoped, which is what puts proximity in the sort. */
	declare [kScopedRulesExist]: boolean;
	// The `:focus-visible` state, driven by TermDOM from the last input modality
	// (keyboard true, pointer false). #ruleMatches gates such rules on it.
	declare [kFocusVisibleActive]: boolean;
	/**
	 * How many document.styleSheets the last parse consumed; -1 = never
	 * parsed. A changed count re-parses on the next style computation --
	 * which is what lets a sheet appended right before the first paint
	 * apply even when no MutationObserver is attached. (The old sentinel
	 * was #parsedRules.length === 0, which stopped meaning "never parsed"
	 * the moment the UA document sheet guaranteed one rule.)
	 */
	declare [kParsedStyleSheetCount]: number;

	// CSS Counter support
	declare [kCounterScopes]: WeakMap<Element, CounterScope>;

	// The document is fixed for the window's lifetime, so hold it directly rather
	// than reaching through window.document on every access.
	declare [kDocument]: Document;
	declare [kWindow]: EngineWindow;
	declare [kLayoutEngine]?: LayoutEngine;

	constructor(window: EngineWindow, layoutEngine?: LayoutEngine) {
		this[kComputedStyleCache] = new WeakMap<
			Element,
			ComputedStyleDeclaration
		>();
		this[kStyleEpoch] = {value: 0};
		this[kShadowRoots] = new Set<ShadowRoot>();
		this[kPseudoElementStyleCache] = new WeakMap<
			Element,
			Map<string, PseudoStyleDeclaration>
		>();
		this[kParsedRules] = [];
		this[kStylesheetsDirty] = false;
		this[kSelectorsReachSiblings] = false;
		this[kSelectorsReachAncestors] = false;
		this[kReachingClasses] = new Set<string>();
		this[kReachingIds] = new Set<string>();
		this[kReachingAttributes] = new Set<string>();
		this[kReachingStates] = false;
		this[kPseudoRulesByType] = new Map<string, ParsedCSSRule[]>();
		this[kCounterRulesExist] = false;
		this[kListItemRulesExist] = false;
		this[kScopedRulesExist] = false;
		this[kFocusVisibleActive] = true;
		this[kParsedStyleSheetCount] = -1;
		this[kCounterScopes] = new WeakMap<Element, CounterScope>();
		this[kLayoutFlush] = null;
		this[kFlushing] = false;
		this[kFlushedEpoch] = -1;
		this[kUsedGeneration] = 0;
		this[kStyleSheetList] = null;
		this[kPseudoNodeStyles] = new WeakMap<Element, ComputedStyle>();
		this[kLayerPaths] = [];
		this[kAnonymousLayers] = 0;
		this[kUnlayeredRank] = 0;
		this[kPendingStyleDamage] = new Set();
		this[kWindow] = window;
		this[kLayoutEngine] = layoutEngine;
		this[kDocument] = window.document;

		// The list gutter is resolved inside the cascade, which cannot reach a
		// StyleManager any other way. See getListGutterWidth().
		styleManagers.set(window, this);
		documentManagers.set(this[kDocument], this);

		// Override window.getComputedStyle with our cached version
		window.getComputedStyle = this[kGetComputedStyle].bind(this);

		// Hook into methods that should invalidate cached styles
		this[kSetupInvalidationHooks]();
	}

	/** The epoch a computed style watches to know its values have gone stale. */
	get styleEpoch(): {value: number} {
		return this[kStyleEpoch];
	}

	/** The rules matching an element, in cascade order. */
	matchingRules(element: Element): ParsedCSSRule[] {
		if (
			this[kStylesheetsDirty] ||
			this[kStyleSheetCount]() !== this[kParsedStyleSheetCount]
		) {
			this[kParseStylesheets]();
		}
		return this[kGetMatchingRules](element);
	}

	/**
	 * The flush a geometry read takes before measuring: pending mutations
	 * drained and layout brought up to date, synchronously. A resolved value
	 * is a measurement, so it goes through the same door -- there is exactly
	 * one place that decides what "laid out now" means.
	 */
	declare [kLayoutFlush]: (() => boolean) | null;

	setLayoutFlush(flush: () => boolean): void {
		this[kLayoutFlush] = flush;
	}

	/**
	 * Take that flush: pending mutations drained into the cascade and layout,
	 * then layout brought up to date. Every author-facing style read goes
	 * through it, so a value read straight after a DOM change describes that
	 * change; the engine's own reads (computedValueOf) never do.
	 */
	flushStyle(): void {
		// Not re-entrant: layout and paint resolve styles as they run, and a
		// read taken from inside the flush sees the layout being computed --
		// asking for it again would compute it inside itself.
		if (this[kFlushing] || !this[kLayoutFlush]) {
			return;
		}
		this[kFlushing] = true;
		try {
			if (this[kLayoutFlush]()) {
				this[kUsedGeneration]++;
			}
		} finally {
			this[kFlushing] = false;
		}
	}

	declare [kFlushing]: boolean;

	/**
	 * The grid a viewport unit measures against, in cells. Null before a
	 * layout engine is wired up, where `1vw` has nothing to be a hundredth of.
	 */
	viewportSize(): {width: number; height: number} | null {
		if (!this[kLayoutEngine]) {
			return null;
		}
		return {
			width: this[kLayoutEngine].terminalWidth,
			height: this[kLayoutEngine].terminalHeight,
		};
	}

	/** The element's border-box rect, measured after that flush. */
	usedRect(element: Element): DOMRect | null {
		// Without a renderer there is no layout pass, and so no used value to
		// report: the computed value is the answer, as it is for any element
		// with no box.
		if (!this[kLayoutEngine] || !this[kLayoutFlush]) {
			return null;
		}
		// The flush is taken once per layout generation, not once per read: an
		// invalidation moves the engine's epoch, and until it does the layout
		// standing behind the last flush is still the answer. A caller reading
		// four properties off two hundred elements pays one flush, not eight
		// hundred. Nothing under the flush can reach back here -- layout reads
		// the cascade through computedValueOf, which has no used value to ask
		// for.
		if (this[kLayoutEngine].layoutEpoch !== this[kFlushedEpoch]) {
			this[kLayoutFlush]();
			this[kFlushedEpoch] = this[kLayoutEngine].layoutEpoch;
			this[kUsedGeneration]++;
		}
		return this[kLayoutEngine].getRect(element);
	}

	/**
	 * An element's content box, measured behind the same flush: the box a
	 * child's -- or a pseudo-element's -- percentage resolves against.
	 */
	contentBox(element: Element): DOMRect | null {
		// The flush first, since the engine's own derivation reads the layout
		// and this read has to stand behind the same one.
		if (!this.usedRect(element)) {
			return null;
		}
		return this[kLayoutEngine]!.contentRect(element);
	}

	/** The layout epoch the last resolved-value flush left behind. */
	declare [kFlushedEpoch]: number;

	/**
	 * The generation a resolved value memoizes against: it moves when the
	 * cascade is rebuilt or a flush finds work, and stands still otherwise.
	 */
	declare [kUsedGeneration]: number;

	get layoutEpoch(): number {
		return this[kUsedGeneration];
	}

	setLayoutEngine(layoutEngine: LayoutEngine): void {
		this[kLayoutEngine] = layoutEngine;

		// Parse initial stylesheets (may be empty at construction time)
		this[kParseStylesheets]();
	}

	/**
	 * Enroll a shadow root's stylesheets in the cascade. Called for every
	 * attached root (author and UA alike); rules parse lazily on the next
	 * stylesheet refresh, which the root's own <style> mutations trigger
	 * through the shared observer.
	 */
	registerShadowRoot(root: ShadowRoot): void {
		this[kShadowRoots].add(root);
		// UA-internal roots are never observer-enrolled, so no STYLE mutation
		// record will trigger a refresh for the <style> they already contain;
		// re-parse lazily on the next style computation instead.
		this[kStylesheetsDirty] = true;
	}

	/**
	 * Handle DOM mutations using invalidation approach
	 */
	handleMutations(mutations: MutationRecord[]): void {
		const Node = this[kWindow].Node;
		let shouldRefreshStylesheets = false;

		for (const mutation of mutations) {
			if (mutation.type === "childList") {
				// A <style> element's children ARE its stylesheet text, so
				// adding or removing one reparses the sheet.
				if ((mutation.target as Element).tagName === "STYLE") {
					sheetFor(mutation.target as Element).reparseOwnerText();
					shouldRefreshStylesheets = true;
				}
				// A list's marker gutter is derived from its children, so adding or
				// removing an item invalidates the *list*, not just the item that
				// moved. Without this the gutter stays at whatever the original items
				// needed, and a wider marker added later overruns it -- the "iii.Third"
				// collision, on any mutation.
				this[kInvalidateEnclosingList](mutation.target);

				// Check for stylesheet changes
				for (const node of mutation.addedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (
							element.tagName === "STYLE" ||
							(element.tagName === "LINK" &&
								element.getAttribute("rel") === "stylesheet")
						) {
							shouldRefreshStylesheets = true;
						} else {
							// Invalidate caches for new elements
							this[kInvalidateElementCaches](element);
							// Process pseudo-elements for new elements
							this.attachPseudoElementsToElement(element);

							// Also handle any child elements
							const childElements = element.querySelectorAll("*");
							for (const childElement of childElements) {
								this[kInvalidateElementCaches](childElement);
								this.attachPseudoElementsToElement(childElement);
							}
						}
					}
				}

				// Check for removed stylesheets
				for (const node of mutation.removedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as Element;
						if (
							element.tagName === "STYLE" ||
							(element.tagName === "LINK" &&
								element.getAttribute("rel") === "stylesheet")
						) {
							shouldRefreshStylesheets = true;
						}
					}
				}
			} else if (mutation.type === "attributes") {
				const element = mutation.target as Element;
				// A class flip on an ancestor changes which rules match its
				// descendants -- `.editing .view {display:none}` is exactly the
				// TodoMVC edit row -- and moves what they inherit. But only a
				// flip the sheets USE that way does: when no rule tests the
				// flipped class outside its own subject and none of the rules
				// that test it declares an inherited property, the descendants'
				// styles stand exactly as they were.
				if (
					this.attributeReachesDescendants(
						element,
						mutation.attributeName!,
						mutation.oldValue,
					)
				) {
					this[kInvalidateSubtree](element);
				} else {
					this[kInvalidateElementCaches](element);
					this.attachPseudoElementsToElement(element);
				}
				// Sibling combinators reach right: `.on ~ .light` matches (or
				// stops matching) a FOLLOWING sibling when this element's
				// attributes change, and that sibling's cached styles know
				// nothing of it. Same flags the layout scope decision uses;
				// :has() reaches ancestors, for which only the nuclear cache
				// clear is honest.
				if (this[kSelectorsReachAncestors]) {
					this.clearCache();
				} else if (this[kSelectorsReachSiblings]) {
					for (
						let sibling = element.nextElementSibling;
						sibling;
						sibling = sibling.nextElementSibling
					) {
						this[kInvalidateSubtree](sibling);
					}
				}
			} else if (mutation.type === "characterData") {
				// Check for changes to <style> element content
				const owner = mutation.target.parentElement;
				if (owner?.tagName === "STYLE") {
					sheetFor(owner).reparseOwnerText();
					shouldRefreshStylesheets = true;
				}
			}
		}

		// If stylesheets changed, refresh everything
		if (shouldRefreshStylesheets) {
			this.refreshStylesheets();
		}
	}

	/**
	 * The document's style-element list, held so the count below is a bare
	 * length read. The count is polled on every computed-style read to catch
	 * a <style> appended in the same tick, before the mutation observer
	 * delivers; adopted sheets and a sheet's own mutations reach the cascade
	 * through refreshStylesheets instead.
	 */
	declare [kStyleSheetList]: {length: number} | null;

	[kStyleSheetCount](): number {
		this[kStyleSheetList] ??= documentStyleSheetList(this[kDocument]);
		return this[kStyleSheetList].length;
	}

	invalidationScopeFor(element: Element): Element {
		if (
			this[kStylesheetsDirty] ||
			this[kStyleSheetCount]() !== this[kParsedStyleSheetCount]
		) {
			this[kParseStylesheets]();
		}
		if (this[kSelectorsReachAncestors]) {
			return this[kDocument].body ?? element;
		}
		if (this[kSelectorsReachSiblings]) {
			return element.parentElement ?? element;
		}
		return element;
	}

	/**
	 * Focus moved: the cached ComputedStyleDeclarations of the elements that
	 * gained and lost focus hold rule sets matched BEFORE the move, so a
	 * `:focus` rule would never apply (or, symmetrically, never stop
	 * applying) -- focus is not a mutation, and nothing else invalidates.
	 * Selector matching itself is live (matches(":focus") follows
	 * activeElement); only these caches go stale. Scoped to the two moved
	 * elements: `:focus-within` on ancestors would need chain invalidation,
	 * which nothing supports or tests yet.
	 */
	handleFocusChange(...elements: Array<Element | null>): void {
		for (const element of elements) {
			if (element) {
				this[kInvalidateElementCaches](element);
				// A host's focus state reaches into its shadow tree through
				// :host(:focus) rules (and inheritance from whatever they
				// set), so the tree's cached styles go stale with it.
				const shadowRoot = shadowRootOf<ShadowRoot>(element);
				if (shadowRoot) {
					for (const descendant of shadowRoot.querySelectorAll("*")) {
						this[kInvalidateElementCaches](descendant);
					}
				}
			}
		}
	}

	/**
	 * A state no attribute records moved: a popover was shown or hidden. The
	 * rules that test it (`:popover-open`, and the UA sheet's display among
	 * them) matched before the move, and a popover that stops being displayed
	 * takes its subtree's styles with it -- so the element and everything
	 * whose style comes through it re-resolve.
	 */
	handleStateChange(element: Element): void {
		this[kInvalidateSubtree](element);
		// No mutation record describes the move, so the frame that decides
		// whether anything is worth painting is told here: the cascade moved,
		// and the rows the element claims are the damage to repaint.
		this[kPendingStyleDamage]?.add(element);
		this[kLayoutEngine]?.invalidateFrame();
	}

	/** Set the `:focus-visible` state; returns whether it changed. */
	setFocusVisible(active: boolean): boolean {
		if (this[kFocusVisibleActive] === active) {
			return false;
		}
		this[kFocusVisibleActive] = active;
		return true;
	}

	/**
	 * Invalidate an element and everything whose style it reaches: its
	 * descendants, and the shadow tree it hosts -- inheritance crosses that
	 * boundary, so a color set on a host reaches the tree it composes.
	 */
	[kInvalidateSubtree](element: Element): void {
		this[kInvalidateElementCaches](element);
		this.attachPseudoElementsToElement(element);
		for (const descendant of element.querySelectorAll("*")) {
			this[kInvalidateElementCaches](descendant);
			this.attachPseudoElementsToElement(descendant);
		}
		const root = element.shadowRoot;
		if (root) {
			for (const descendant of root.querySelectorAll("*")) {
				this[kInvalidateSubtree](descendant);
			}
		}
	}

	[kInvalidateElementCaches](element: Element): void {
		// Layout measured this element under the style being dropped. This is
		// the one place an element's computed style goes stale -- attribute
		// flips, inline styles, subtree and sibling reach, focus all arrive
		// here -- so it is the one place layout has to be told.
		this[kLayoutEngine]?.styleInvalidated(element);
		// A computed style an author still holds is the one this cache handed
		// out, so it is told the cascade moved on rather than merely dropped.
		this[kComputedStyleCache].get(element)?.invalidate();
		this[kComputedStyleCache].delete(element);
		this[kPseudoElementStyleCache].delete(element);
		// The pseudo-element nodes read through the declarations just dropped.
		if (pseudoElementCount(element) > 0) {
			for (const name of PSEUDO_ELEMENT_NAMES) {
				const node = pseudoElement<Element>(element, name);
				if (node) {
					this[kPseudoNodeStyles].delete(node);
				}
			}
		}
		this[kCounterScopes].delete(element);
	}

	/**
	 * Invalidate the nearest enclosing list, and its items, after a child changed.
	 *
	 * The list's padding-left is a function of its items' markers, and the items'
	 * ordinals are a function of their position, so both go stale when the child
	 * list changes. Only the *nearest* list is affected: a deeper list's items do
	 * not contribute to an outer list's gutter.
	 */
	// TODO(box-tree): a list's gutter is a layout question -- the widest
	// marker its items generate -- answered here in the cascade, which is why
	// the cascade must watch child lists and reach into the layout engine.
	// Phase C computes the gutter during block layout and deletes this.
	[kInvalidateEnclosingList](target: Node): void {
		let element: Element | null =
			target.nodeType === this[kWindow].Node.ELEMENT_NODE ?
					(target as Element) :
				target.parentElement;

		for (; element; element = element.parentElement) {
			if (element.tagName !== "UL" && element.tagName !== "OL") {
				continue;
			}

			this[kInvalidateElementCaches](element);
			this[kLayoutEngine]?.invalidate(element);
			for (const item of Array.from(element.children)) {
				this[kInvalidateElementCaches](item);
			}
			return;
		}
	}

	[kGetComputedStyle](
		element: Element,
		pseudoElt?: string | null,
	): globalThis.CSSStyleDeclaration {
		// A computed style describes the DOM as it stands, so an author read
		// goes through the flush a geometry read does.
		this.flushStyle();
		// Ensure stylesheets are parsed if the document's sheet list changed
		// since the last parse, or a newly registered shadow root's sheet
		// awaits
		if (
			this[kStylesheetsDirty] ||
			this[kStyleSheetCount]() !== this[kParsedStyleSheetCount]
		) {
			this[kParseStylesheets]();
		}
		// An element that is not being rendered has no style to report: it is
		// out of the document, or out of the flat tree its document composes.
		// Only an author read comes through here -- the engine reads through
		// declarationFor, which asks nothing of the flat tree.
		if (!isBeingRendered(element)) {
			return new EmptyStyleDeclaration(
				element,
			) as unknown as globalThis.CSSStyleDeclaration;
		}

		// The pseudo-element argument names a pseudo-element, names nothing
		// (and is ignored), or names something that is not one -- for which an
		// empty declaration is the answer.
		let pseudoElement = "";
		if (pseudoElt) {
			const parsed = parsePseudoElementArgument(String(pseudoElt));
			if (parsed === null) {
				return new EmptyStyleDeclaration(
					element,
				) as unknown as globalThis.CSSStyleDeclaration;
			}
			pseudoElement = parsed;
		}

		if (pseudoElement) {
			return indexedDeclaration(
				this.pseudoDeclarationFor(element, pseudoElement),
			) as unknown as globalThis.CSSStyleDeclaration;
		}

		return indexedDeclaration(
			this.declarationFor(element),
		) as unknown as globalThis.CSSStyleDeclaration;
	}

	/**
	 * The declaration behind an element, for the engine itself.
	 *
	 * This is the internal read path: no pseudo-element parsing, no
	 * being-rendered gate, no resolved-value branch -- the cascade's own answer,
	 * which is what layout and paint decide geometry from. It is reached
	 * thousands of times per frame, so it does the least it can.
	 */
	declarationFor(element: Element): ComputedStyleDeclaration {
		let declaration = this[kComputedStyleCache].get(element);
		if (!declaration) {
			if (
				this[kStylesheetsDirty] ||
				this[kStyleSheetCount]() !== this[kParsedStyleSheetCount]
			) {
				this[kParseStylesheets]();
			}
			declaration = new ComputedStyleDeclaration(
				element,
				this[kGetMatchingRules](element),
				this,
			);
			this[kComputedStyleCache].set(element, declaration);
		}
		return declaration;
	}

	/**
	 * The style a pseudo-element's own node is laid out and painted from, on
	 * the same one-lookup read path an element's style takes: layout and paint
	 * ask per property per frame, and rebuilding the view from the host's
	 * declaration each time would put four map hops in front of every read.
	 */
	pseudoNodeStyleFor(
		node: Element,
		host: Element,
		name: string,
	): ComputedStyle {
		let style = this[kPseudoNodeStyles].get(node);
		if (style === undefined) {
			style = this.pseudoDeclarationFor(host, name).nodeStyle;
			this[kPseudoNodeStyles].set(node, style);
		}
		return style;
	}

	declare [kPseudoNodeStyles]: WeakMap<Element, ComputedStyle>;

	/** A pseudo-element's declaration, on the same internal read path. */
	pseudoDeclarationFor(
		element: Element,
		pseudoElement: string,
	): PseudoStyleDeclaration {
		const cached = this[kPseudoElementStyleCache]
			.get(element)
			?.get(pseudoElement);
		if (cached) {
			return cached;
		}
		const declarations = this.pseudoDeclarations(element, pseudoElement);
		const declaration = new PseudoStyleDeclaration(
			declarations,
			element,
			this,
			pseudoElement,
		);
		// The cache is reached HERE, not before the work: resolving the host's
		// style above can reparse the stylesheets, and a reparse replaces every
		// cache on this manager. A map taken before that is an orphan, and
		// storing into it caches nothing -- every read recomputes the
		// declaration, and with it the host's inherited properties.
		let elementCache = this[kPseudoElementStyleCache].get(element);
		if (!elementCache) {
			elementCache = new Map();
			this[kPseudoElementStyleCache].set(element, elementCache);
		}
		elementCache.set(pseudoElement, declaration);
		return declaration;
	}

	/**
	 * What the cascade declares for a pseudo-element: its matched rules,
	 * completed by what it inherits from its originating element. A live
	 * declaration re-asks this when the style epoch moves.
	 */
	pseudoDeclarations(
		element: Element,
		pseudoElement: string,
	): Record<string, string> {
		const declarations: Record<string, string> = {
			...this[kComputePseudoElementStyle](element, pseudoElement),
		};
		// Per CSS, a pseudo-element INHERITS from its originating element: a
		// button's focus underline runs through its UA brackets, a .destroy's
		// color reaches its ::after glyph. Rule declarations above win;
		// inherited values only fill the gaps.
		const hostStyle = this.declarationFor(element);
		for (const property of INHERITED_PROPERTIES) {
			if (!declarations[property]) {
				const inherited = hostStyle.computedValueOf(property);
				if (inherited) {
					declarations[property] = inherited;
				}
			}
		}
		// A pseudo-element of a flex or grid container is one of its items, and
		// an item's display blockifies -- including the `inline` it would
		// otherwise take from the initial value.
		if (ITEM_DISPLAYS.has(hostStyle.computedValueOf("display"))) {
			declarations.display = blockified(
				declarations.display || getInitialStyle(null, "display"),
			);
		}
		return declarations;
	}

	/**
	 * Walk the document's stylesheets -- this engine's own CSSOM objects, the
	 * same ones an author reaches through `styleEl.sheet` -- and collect the
	 * rules the cascade matches against.
	 *
	 * Every style cached against the previous rule set is dropped: a
	 * declaration built before this parse was resolved against rules that no
	 * longer describe the cascade, and nothing else would ever tell it so.
	 */
	[kParseStylesheets](): void {
		this[kLayoutEngine]?.invalidateStructure();
		const document = this[kDocument];
		this[kParsedRules] = [];
		this[kSelectorsReachSiblings] = false;
		this[kSelectorsReachAncestors] = false;
		this[kReachingClasses].clear();
		this[kReachingIds].clear();
		this[kReachingAttributes].clear();
		this[kReachingStates] = false;
		this[kPseudoRulesByType] = new Map();
		this[kPseudoSubjectTags] = undefined;
		this[kCounterRulesExist] = false;
		this[kListItemRulesExist] = false;
		this[kScopedRulesExist] = false;
		this[kStylesheetsDirty] = false;
		this[kLayerPaths] = [];
		this[kAnonymousLayers] = 0;
		this[kParsedStyleSheetCount] = this[kStyleSheetCount]();

		// The UA document sheet parses first; origin ordering (not source
		// order) is what keeps it beneath every author rule.
		this[kParseStyleSheet](uaStyleSheet(), undefined, true);

		for (const sheet of documentStyleSheets(document)) {
			this[kParseStyleSheet](sheet);
		}

		// Shadow-tree stylesheets, scoped to their root. Disconnected roots
		// parse too: attach-populate-connect is the standard order, and a
		// scope-gated rule matches nothing until its tree renders anyway.
		for (const root of this[kShadowRoots]) {
			for (const sheet of shadowStyleSheets(root)) {
				this[kParseStyleSheet](sheet, root);
			}
		}

		const layerRanks = this[kRankLayers]();
		for (const rule of this[kParsedRules]) {
			rule.layerRank =
				rule.layer === null ?
					this[kUnlayeredRank] :
						(layerRanks.get(rule.layer) ?? this[kUnlayeredRank]);
		}

		// Sort rules for cascade resolution: origin first (UA rules sort
		// below every author rule -- later wins), then cascade layer, then
		// specificity, then the order the rules were read in.
		const sourceOrder = new Map(
			this[kParsedRules].map((rule, index) => [rule, index] as const),
		);
		this[kParsedRules].sort((a, b) => {
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
		this.clearCache();
		this[kAttachPseudoElements]();
	}

	/**
	 * Every cascade layer, in the order its name was first declared: a
	 * `@layer a, b;` statement, a `@layer a { }` block, or the anonymous layer
	 * an unnamed block opens. A nested layer's path is dot-joined through its
	 * ancestors, which is the name `@layer a.b` writes for itself.
	 */
	declare [kLayerPaths]: string[];
	declare [kAnonymousLayers]: number;

	/** Where an unlayered rule sorts: after every layer, and so above them. */
	declare [kUnlayeredRank]: number;

	/** Name a layer, and every layer its path nests inside, in declaration order. */
	[kDeclareLayer](outer: string | null, name: string): string {
		const path = outer === null ? name : `${outer}.${name}`;
		const segments = path.split(".");
		for (let depth = 1; depth <= segments.length; depth++) {
			const prefix = segments.slice(0, depth).join(".");
			if (!this[kLayerPaths].includes(prefix)) {
				this[kLayerPaths].push(prefix);
			}
		}
		return path;
	}

	/**
	 * Where each layer sorts. Layers sort in the order their names were
	 * declared, and a layer's OWN rules sort after the rules of every layer
	 * nested inside it -- the same relation unlayered rules have to layers,
	 * one level down. Smallest first, so the last layer, and then the
	 * unlayered rules above it, win the normal cascade; the important cascade
	 * reads the same order backwards.
	 */
	[kRankLayers](): Map<string, number> {
		const nested = new Map<string, string[]>();
		for (const path of this[kLayerPaths]) {
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
		this[kUnlayeredRank] = next;
		return ranks;
	}

	/**
	 * Collect the style rules of a stylesheet, or of a grouping rule's own
	 * rule list. A disabled sheet, and a sheet or `@media` whose condition the
	 * terminal viewport does not match, contribute nothing; `@supports`
	 * contributes its rules, since what this engine supports is what it
	 * renders. `@font-face`, `@keyframes` and `@import` have no terminal
	 * rendering and declare nothing to the cascade.
	 *
	 * A grouping rule this walk has no branch for is walked THROUGH: its rules
	 * cascade without whatever its prelude says about them. For a conditional
	 * rule that is the wrong answer where the condition is false -- a
	 * `@container` query the box does not satisfy still paints -- and it is
	 * the better wrong answer: a rule that applies too widely is one an author
	 * can see, and one that vanishes with the whole at-rule is not.
	 */
	[kParseStyleSheet](
		container: CSSStyleSheet | CSSGroupingRule,
		scope?: Node,
		uaOrigin?: boolean,
		context: RuleContext = UNCONDITIONAL,
	): void {
		if (container instanceof CSSStyleSheet) {
			if (container.disabled) {
				return;
			}
			if (!this.mediaQueryMatches(container.media.mediaText)) {
				return;
			}
		}
		for (const rule of container.cssRules) {
			if (rule instanceof CSSStyleRule) {
				this[kParseStyleRule](rule, scope, uaOrigin, context);
			} else if (rule instanceof CSSMediaRule) {
				if (this.mediaQueryMatches(rule.conditionText)) {
					this[kParseStyleSheet](rule, scope, uaOrigin, context);
				}
			} else if (rule instanceof CSSSupportsRule) {
				this[kParseStyleSheet](rule, scope, uaOrigin, context);
			} else if (rule instanceof CSSLayerStatementRule) {
				// `@layer a, b;` declares the order of layers whose rules come
				// later, and declares nothing else.
				for (const name of rule.nameList) {
					this[kDeclareLayer](context.layer, name);
				}
			} else if (rule instanceof CSSLayerBlockRule) {
				// An unnamed block opens a layer nothing else can name or reach,
				// which is a layer of its own wherever it stands.
				const layer = rule.name ?
						this[kDeclareLayer](context.layer, rule.name) :
						this[kDeclareLayer](context.layer, ` ${this[kAnonymousLayers]++}`);
				this[kParseStyleSheet](rule, scope, uaOrigin, {...context, layer});
			} else if (rule instanceof CSSScopeRule) {
				const owner = rule.parentStyleSheet?.ownerNode ?? null;
				this[kParseStyleSheet](rule, scope, uaOrigin, {
					...context,
					scopes: [
						...context.scopes,
						{
							start: rule.start,
							end: rule.end,
							owner: owner ? owner.parentElement : null,
						},
					],
				});
			} else if (rule instanceof CSSStartingStyleRule) {
				// `@starting-style` declares the style a box starts a transition
				// FROM. This engine runs no transitions, so a rule inside it
				// would have no moment to stop applying in and would style the
				// box for good: it parses into the CSSOM and reaches the
				// cascade never.
				continue;
			} else if (rule instanceof CSSGroupingRule) {
				this[kParseStyleSheet](rule, scope, uaOrigin, context);
			}
		}
	}

	/**
	 * Whether a media query currently matches. There is exactly one "screen" --
	 * the terminal viewport -- so only width/height features are meaningful;
	 * everything else (scripting, color-gamut, pointer, ...) defaults to
	 * matching rather than silently dropping an author's rules. Public: it
	 * answers window.matchMedia through the SAME evaluator @media uses, so
	 * a stylesheet and a script can never disagree about the viewport.
	 */
	mediaQueryMatches(mediaText: string): boolean {
		const text = mediaText.trim();
		if (!text) {
			return true;
		}
		return text.split(",").some((query) => this[kMediaQueryPartMatches](query));
	}

	[kMediaQueryPartMatches](query: string): boolean {
		let q = query.trim();
		let negate = false;
		if (/^not\s+/i.test(q)) {
			negate = true;
			q = q.replace(/^not\s+/i, "");
		}

		const typeMatch = q.match(/^(all|screen|print|speech)\b\s*(and\s+)?/i);
		let matches = true;
		if (typeMatch) {
			matches = typeMatch[1].toLowerCase() !== "print";
			q = q.slice(typeMatch[0].length);
		}

		const features = q.match(/\([^)]*\)/g) || [];
		for (const feature of features) {
			if (!this[kMediaFeatureMatches](feature.slice(1, -1).trim())) {
				matches = false;
			}
		}

		return negate ? !matches : matches;
	}

	[kMediaFeatureMatches](feature: string): boolean {
		const match = feature.match(
			/^(min-|max-)?(width|height)\s*:\s*([\d.]+)(px|ch)?$/i,
		);
		if (!match) {
			return true;
		} // unrecognized feature: permissive default

		const [, boundRaw, dimension, numRaw] = match;
		const bound = boundRaw?.toLowerCase();
		const num = parseFloat(numRaw);
		const actual =
			dimension.toLowerCase() === "width" ?
				this[kWindow].innerWidth :
				this[kWindow].innerHeight;

		if (bound === "min-") {
			return actual >= num;
		}
		if (bound === "max-") {
			return actual <= num;
		}
		return actual === num;
	}

	/**
	 * Parse a single style rule and extract selector/declarations
	 */
	[kParseStyleRule](
		styleRule: CSSStyleRule,
		scope?: Node,
		uaOriginSheet?: boolean,
		context: RuleContext = UNCONDITIONAL,
	): void {
		// A rule's selector list is a set of selectors that share a block, and
		// each is matched -- and weighed -- on its own. `#a::before, #b` is one
		// pseudo-element rule and one ordinary rule, not one of either.
		const block = styleRule.style.declarationBlock();
		const namespaces = sheetNamespaces(styleRule.parentStyleSheet);
		for (const selector of splitSelectorList(styleRule.selectorText)) {
			this[kParseSelector](
				selector,
				block,
				scope,
				uaOriginSheet,
				namespaces,
				context,
			);
		}
	}

	/**
	 * Record the keys a change to which can reach an element's descendants.
	 *
	 * Two ways it can: the key is tested on a NON-SUBJECT compound, so the
	 * rule matches something below the element it names; or the rule declares
	 * an INHERITED property, so starting or stopping it moves a value the
	 * descendants take from the element. A key in neither position changes
	 * nothing but the element's own box.
	 */
	[kIndexReachingKeys](
		selector: string,
		declarations: Record<string, string>,
	): void {
		let inherits = false;
		for (const property in declarations) {
			// A shorthand is stored as its longhands, so this reads longhands --
			// except `all`, which stands for every property there is.
			// `display` is not inherited and reaches them anyway: a flex
			// container blockifies its children (css-display-3 §2.7), which
			// changes what KIND of box each of them is.
			if (
				property === "all" ||
				property === "display" ||
				property.startsWith("--") ||
				INHERITED_PROPERTIES.has(property)
			) {
				inherits = true;
				break;
			}
		}
		const compounds = selectorCompounds(selector);
		const last = inherits ? compounds.length : compounds.length - 1;
		for (let i = 0; i < last; i++) {
			const compound = compounds[i];
			for (const match of compound.matchAll(SELECTOR_CLASS_NAME)) {
				this[kReachingClasses].add(match[1]);
			}
			for (const match of compound.matchAll(SELECTOR_ID_NAME)) {
				this[kReachingIds].add(match[1]);
			}
			for (const match of compound.matchAll(ATTRIBUTE_SELECTOR_NAME)) {
				this[kReachingAttributes].add(match[1].toLowerCase());
			}
			if (STATE_PSEUDO_CLASSES.test(compound)) {
				this[kReachingStates] = true;
			}
		}
	}

	/**
	 * Whether changing this attribute on this element can change the style of
	 * its DESCENDANTS -- by starting or stopping a rule that matches one of
	 * them, or by moving a value they inherit. When it can do neither, the
	 * element's own cached style is the only one the cascade renders stale.
	 *
	 * An inline style is always taken to reach them: what it declares is not
	 * known until it is parsed, and it is written where a value is meant to
	 * change.
	 */
	attributeReachesDescendants(
		element: Element,
		name: string,
		oldValue: string | null,
	): boolean {
		if (name === "style") {
			return true;
		}
		if (name === "class") {
			if (this[kReachingAttributes].has("class")) {
				return true;
			}
			if (this[kReachingClasses].size === 0) {
				return false;
			}
			// A record with no old value can be one for an attribute that did
			// not exist, or one from an observer that records none; the classes
			// that LEFT are unknowable either way.
			if (oldValue === null) {
				return element.hasAttribute("class");
			}
			// Only the classes that came or went can have changed a match.
			const before = new Set(oldValue.split(/\s+/));
			const after = element.classList;
			for (const token of after) {
				if (!before.has(token) && this[kReachingClasses].has(token)) {
					return true;
				}
			}
			for (const token of before) {
				if (
					token !== "" &&
					!after.contains(token) &&
					this[kReachingClasses].has(token)
				) {
					return true;
				}
			}
			return false;
		}
		if (name === "id") {
			if (this[kReachingAttributes].has("id")) {
				return true;
			}
			if (oldValue !== null && this[kReachingIds].has(oldValue)) {
				return true;
			}
			const id = element.getAttribute("id");
			return id !== null && this[kReachingIds].has(id);
		}
		if (this[kReachingAttributes].has(name)) {
			return true;
		}
		return this[kReachingStates] && STATE_ATTRIBUTES.has(name);
	}

	[kParseSelector](
		selector: string,
		block: DeclarationBlock,
		scope?: Node,
		uaOriginSheet?: boolean,
		sheetNamespaces: SelectorNamespaces = NO_NAMESPACES,
		context: RuleContext = UNCONDITIONAL,
	): void {
		const {declarations, important, order} = block;
		// A rule's layer decides where it sorts, and the whole layer order is
		// only known once every sheet has been read: the rank is filled in
		// then, and this is the value it is filled in from.
		const layer = context.layer;
		let scopes: readonly ScopeCondition[] | undefined;
		if (context.scopes.length > 0) {
			scopes = context.scopes;
			this[kScopedRulesExist] = true;
		}
		let namespace: string | null | undefined;
		if (sheetNamespaces !== NO_NAMESPACES || selector.includes("|")) {
			const resolved = selectorNamespace(selector, sheetNamespaces);
			if (!resolved.valid) {
				return;
			}
			selector = resolved.selector;
			namespace = resolved.namespace;
		}
		if (selector.includes("+") || selector.includes("~")) {
			this[kSelectorsReachSiblings] = true;
		}
		if (selector.includes(":has")) {
			this[kSelectorsReachAncestors] = true;
		}
		this[kIndexReachingKeys](selector, declarations);
		if (
			declarations["counter-reset"] ||
			declarations["counter-increment"] ||
			declarations["content"]?.includes("counter")
		) {
			this[kCounterRulesExist] = true;
		}
		if (declarations["display"] === "list-item") {
			this[kListItemRulesExist] = true;
		}
		const specificity = selectorSpecificity(selector);
		const uaOrigin = Boolean(
			uaOriginSheet || (scope != null && isUAShadowRoot(scope)),
		);

		// :host selectors only mean anything inside a shadow tree's own
		// stylesheet; the selector engine rejects them outright, so they parse
		// into a structured predicate matched by #ruleMatches instead.
		const subjectTag = selectorSubjectTag(selector);

		// Supported forms: `:host`, `:host(sel)`, `:host:focus`, and any of
		// those followed by a descendant (or `>` child) selector.
		if (scope && selector.startsWith(":host")) {
			// The argument needs balanced-paren matching, not [^)]*: the UA
			// field sheet's own :host(:not(:focus)) nests one level deep.
			const hostMatch = selector.match(
				/^:host(?:\(((?:[^()]|\([^()]*\))*)\))?([^\s>]*)\s*(>)?\s*(.*)$/,
			);
			if (hostMatch) {
				const [, arg, compound, child, restRaw] = hostMatch;
				const predicate = [arg, compound].filter(Boolean).join("") || null;
				const rest = restRaw.trim() || null;
				this[kParsedRules].push({
					selector,
					declarations,
					important,
					order,
					specificity,
					scope,
					host: {predicate, rest, child: Boolean(child)},
					uaOrigin,
					layer,
					layerRank: 0,
					scopes,
				});
				return;
			}
		}

		// Check if this is a pseudo-element rule. ::placeholder/::selection
		// are widget-part pseudos: no content node ever attaches for them --
		// they resolve onto the UA shadow tree's [part] elements (see
		// #getMatchingRules) or the selection painter.
		// Any pseudo-element, not just the ones this engine gives a box: a
		// rule for `::highlight(x)` still has to answer through
		// getComputedStyle, which is the whole of what CSSOM asks of it.
		const pseudoMatch = selector.match(
			/^(.*?)(::[-\w]+(?:\([^)]*\))?)((?::[-\w]+(?:\([^)]*\))?)*)$/,
		);

		if (pseudoMatch) {
			const [, baseSelector, pseudoElement] = pseudoMatch;
			const rule: ParsedCSSRule = {
				// A pseudo-element written with no originating selector
				// originates on every element, which is what `*` names.
				selector: baseSelector.trim() || "*",
				subjectTag: selectorSubjectTag(baseSelector.trim()),
				declarations,
				important,
				order,
				specificity,
				pseudoElement,
				scope,
				uaOrigin,
				namespace,
				layer,
				layerRank: 0,
				scopes,
			};
			this[kParsedRules].push(rule);
			const byType = this[kPseudoRulesByType].get(pseudoElement);
			if (byType) {
				byType.push(rule);
			} else {
				this[kPseudoRulesByType].set(pseudoElement, [rule]);
			}
		} else {
			this[kParsedRules].push({
				selector,
				subjectTag,
				declarations,
				important,
				order,
				specificity,
				scope,
				uaOrigin,
				namespace,
				layer,
				layerRank: 0,
				scopes,
			});
		}
	}

	/**
	 * Get matching CSS rules for an element
	 */
	[kGetMatchingRules](element: Element): ParsedCSSRule[] {
		// A UA shadow part IS the element its part pseudo styles: the host's
		// ::placeholder rules cascade directly onto the [part="placeholder"]
		// span, the way a browser resolves ::placeholder onto its input's
		// internal placeholder element.
		const partPseudo = this[kPartPseudoFor](element);
		const root = element.getRootNode();
		const shadowHost =
			root.nodeType === 11 ? ((root as ShadowRoot).host ?? null) : null;
		const partNames = (element.getAttribute("part") ?? "")
			.split(/\s+/)
			.filter(Boolean);
		const matched = this[kParsedRules].filter((rule) => {
			if (rule.pseudoElement) {
				// ::part(name): an author styling an exposed shadow part from
				// outside. The rule matches the shadow's HOST; its declarations
				// cascade onto the part element -- any shadow, not just the UA's,
				// which is the standard CSS Shadow Parts crossing.
				const partArg = rule.pseudoElement.match(/^::part\((.+)\)$/);
				if (partArg) {
					return (
						shadowHost !== null &&
						partNames.includes(partArg[1].trim()) &&
						this[kRuleMatches](shadowHost, rule)
					);
				}
				// ::placeholder / ::selection: UA-part pseudo aliases.
				return (
					partPseudo !== null &&
					shadowHost !== null &&
					rule.pseudoElement === partPseudo &&
					this[kRuleMatches](shadowHost, rule)
				);
			}
			return this[kRuleMatches](element, rule);
		});
		// Scope proximity sorts between specificity and order of appearance
		// (css-cascade-6 §3.1.3), and unlike either it is a fact about THIS
		// element: the closer scoping root wins, and a rule in no scope at all
		// is infinitely far from one. The rules arrive in cascade order and
		// the sort is stable, so a comparison that only answers for proximity
		// leaves every other tier as it found it.
		if (!this[kScopedRulesExist]) {
			return matched;
		}
		const proximity = new Map(
			matched.map(
				(rule) =>
					[
						rule,
						rule.scopes ? this[kScopeProximity](element, rule) : UNSCOPED,
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

	/**
	 * Whether an element matches one of a rule's selectors. A scoped rule's
	 * selector is written relative to a scoping root and reaches only the
	 * elements that root has in scope; every other rule's is matched by the
	 * DOM outright.
	 */
	[kMatchesRule](
		element: Element,
		rule: ParsedCSSRule,
		selector: string,
	): boolean {
		if (!rule.scopes) {
			return element.matches(selector);
		}
		return this[kScopingRoot](element, {...rule, selector}) !== null;
	}

	/**
	 * How many generations lie between an element and the nearest scoping root
	 * its rule applies from, or Infinity when the rule names no scope. Only
	 * ever asked of a rule that matches, so a rule out of scope everywhere has
	 * already been filtered out.
	 */
	[kScopeProximity](element: Element, rule: ParsedCSSRule): number {
		const root = this[kScopingRoot](element, rule);
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

	/**
	 * The scoping root a scoped rule reaches this element from, or null when
	 * no chain of roots puts the element in the rule's scope and matches its
	 * selector.
	 *
	 * Every root is an inclusive ancestor of the element -- that is what being
	 * in scope means -- so the chain is read outermost first, each condition
	 * taking the HIGHEST root it can (which constrains the roots inside it
	 * least), and the innermost taking the NEAREST, which is the one the
	 * element's selector and its proximity are measured from.
	 */
	[kScopingRoot](element: Element, rule: ParsedCSSRule): Element | null {
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
				if (!scopeRootMatches(candidate, condition, outer)) {
					continue;
				}
				if (!inScopeOf(element, candidate, condition)) {
					continue;
				}
				if (innermost) {
					if (!matchesInScope(element, rule.selector, candidate)) {
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

	/**
	 * The part pseudo-element a UA shadow part element answers to, if any:
	 * "::placeholder" for the [part="placeholder"] span of an input's
	 * UA-internal tree. Author shadow trees are not eligible -- their parts
	 * are theirs to style from inside.
	 */
	[kPartPseudoFor](element: Element): string | null {
		const root = element.getRootNode();
		if (isUAShadowRoot(root)) {
			const part = element.getAttribute("part");
			if (part === "placeholder" || part === "selection") {
				return `::${part}`;
			}
		}
		return null;
	}

	/**
	 * Whether a rule applies to an element, honoring tree scopes: a rule
	 * matches only elements of the tree its stylesheet belongs to --
	 * document rules stop at every shadow boundary, shadow rules never
	 * escape their root -- plus the one deliberate crossing, :host, which
	 * lets a shadow stylesheet style its own host.
	 */
	[kRuleMatches](element: Element, rule: ParsedCSSRule): boolean {
		// The subject's type, when the selector names one: every rule is tried
		// against every element, and this is the reject that costs a string
		// comparison instead of a selector match. A :host rule's subject is the
		// host, which the branch below resolves for itself.
		if (rule.subjectTag !== undefined && rule.host === undefined) {
			const local = element.localName;
			// A foreign element's local name keeps its case (feGaussianBlur), and
			// the tag here is lowercased, so the reject only fires when neither
			// reading matches -- the case-sensitivity a selector really has is
			// then the matcher's to decide.
			if (
				local !== rule.subjectTag &&
				local.toLowerCase() !== rule.subjectTag
			) {
				return false;
			}
		}
		try {
			// The namespace the selector qualifies its subject with, which the
			// DOM's own matcher cannot answer.
			if (
				rule.namespace !== undefined &&
				element.namespaceURI !== rule.namespace
			) {
				return false;
			}
			// The selector engine treats `:focus-visible` as `:focus`, so gate it
			// on our own flag.
			if (
				!this[kFocusVisibleActive] &&
				rule.selector.includes(":focus-visible")
			) {
				return false;
			}
			if (rule.host) {
				const scope = rule.scope as ShadowRoot;
				const host = scope.host;
				if (!host) {
					return false;
				}
				const {predicate, rest, child} = rule.host;
				if (predicate && !host.matches(predicate)) {
					return false;
				}
				if (!rest) {
					return element === host;
				}
				if (element.getRootNode() !== scope) {
					return false;
				}
				if (!element.matches(rest)) {
					return false;
				}
				return child ? element.parentNode === scope : true;
			}
			const root = element.getRootNode();
			if (rule.scope) {
				return (
					root === rule.scope &&
					this[kMatchesRule](element, rule, rule.selector)
				);
			}
			// UA document rules apply in EVERY tree scope, as a browser's own
			// UA sheet styles shadow trees.
			if (rule.uaOrigin) {
				return this[kMatchesRule](element, rule, rule.selector);
			}
			// AUTHOR document rules match everything OUTSIDE shadow trees --
			// including detached elements (styles resolve before insertion,
			// and always have here); the boundary they must not cross is the
			// shadow root.
			const inShadowTree =
				root.nodeType === 11 && Boolean((root as ShadowRoot).host);
			return !inShadowTree && this[kMatchesRule](element, rule, rule.selector);
		} catch (err) {
			// Fallback for unsupported selectors
			return false;
		}
	}

	/**
	 * Compute style properties for a pseudo-element
	 */
	[kComputePseudoElementStyle](
		element: Element,
		pseudoElement: string,
	): Record<string, string> {
		const matchingRules = this[kParsedRules].filter((rule) => {
			if (rule.pseudoElement !== pseudoElement) {
				return false;
			}
			return this[kRuleMatches](element, rule);
		});

		// Apply rules in cascade order. A pseudo-element's declarations are a
		// flat record rather than a per-property cascade, so a flow-relative
		// declaration fills BOTH names of its slot as it lands: the physical
		// one everything downstream reads, and its own, which a later rule
		// declaring either name overwrites in turn.
		const computedStyle: Record<string, string> = {};
		let direction: string | null = null;
		for (const rule of matchingRules) {
			const names = Object.keys(rule.declarations).sort(
				(a, b) => (rule.order[a] ?? 0) - (rule.order[b] ?? 0),
			);
			for (const name of names) {
				const value = rule.declarations[name];
				computedStyle[name] = value;
				if (
					!LOGICAL_TO_PHYSICAL.ltr.has(name) &&
					!PHYSICAL_TO_LOGICAL.has(name)
				) {
					continue;
				}
				direction ??= this.declarationFor(element).computedValueOf("direction");
				for (const other of slotNames(name, direction)) {
					computedStyle[other] = value;
				}
			}
		}

		return computedStyle;
	}

	/**
	 * Get marker content for outside positioning
	 */
	getMarkerContent(hostElement: Element): string | null {
		if (!hostElement || hostElement.nodeType !== hostElement.ELEMENT_NODE) {
			return null;
		}

		const computedStyle = this.declarationFor(hostElement);
		const display = computedStyle.computedValueOf("display");

		if (display !== "list-item") {
			return null;
		}

		const styles = this[kComputePseudoElementStyle](hostElement, "::marker");
		let content = styles.content;

		// If no explicit CSS content, generate default marker using list-style-type
		if (!content || content === "none" || content === "normal") {
			const listParent = hostElement.parentElement;
			if (
				listParent &&
				(listParent.tagName === "UL" || listParent.tagName === "OL")
			) {
				// Use getListMarker function to handle all list-style-type values
				const marker = getListMarker(hostElement, listParent);
				if (marker) {
					content = `"${withMarkerSeparator(marker)}"`;
				}
			}
		}

		// Only return marker if it has content
		if (!content || content === "none" || content === "normal") {
			return null;
		}

		// Remove quotes from content string
		let textContent = unquoteContent(content);

		// Resolve counter() functions in the content
		textContent = this.resolveCounterFunction(hostElement, textContent);

		return textContent;
	}

	/**
	 * The text a pseudo-element holds, or null when it holds none -- no rule
	 * declared `content`, or the one that did declared `none`.
	 */
	[kPseudoContentFor](hostElement: Element, pseudoType: string): string | null {
		const styles = this[kComputePseudoElementStyle](hostElement, pseudoType);
		let content = styles.content;

		// For ::marker pseudo-elements, generate default content if none specified
		if (pseudoType === "::marker") {
			const computedStyle = this.declarationFor(hostElement);
			const display = computedStyle.computedValueOf("display");

			if (display === "list-item") {
				// Check if explicitly set to outside positioning
				const listStylePosition =
					computedStyle.computedValueOf("list-style-position") || "outside";

				// Skip inline marker creation for outside positioning (the default)
				if (listStylePosition === "outside") {
					return null;
				}

				// If no explicit CSS content, generate default marker using list-style-type
				if (!content || content === "none" || content === "normal") {
					const listParent = hostElement.parentElement;
					if (
						listParent &&
						(listParent.tagName === "UL" || listParent.tagName === "OL")
					) {
						// Use getListMarker function to handle all list-style-type values
						const marker = getListMarker(hostElement, listParent);
						if (marker) {
							content = `"${marker} "`;
						}
					}
				}
			}
		}

		// Only create pseudo-element if it has content
		if (!content || content === "none" || content === "normal") {
			return null;
		}

		// Remove quotes from content string
		const textContent = unquoteContent(content);

		// Resolve counter() functions in the content
		return this.resolveCounterFunction(hostElement, textContent);
	}

	/**
	 * Check if element should have a pseudo-element based on CSS rules
	 */
	shouldCreatePseudoElement(element: Element, pseudoType: string): boolean {
		// For ::marker pseudo-elements, only create them for inside positioning
		if (pseudoType === "::marker") {
			const computedStyle = this.declarationFor(element);
			const display = computedStyle.computedValueOf("display");
			const listStylePosition =
				computedStyle.computedValueOf("list-style-position") || "outside";

			if (display === "list-item" && listStylePosition !== "outside") {
				return true; // Only create inline markers for inside positioning
			}
		}

		const styles = this[kComputePseudoElementStyle](element, pseudoType);
		const content = styles.content;
		return !!(content && content !== "none" && content !== "normal");
	}

	/**
	 * Refresh stylesheet parsing (call when stylesheets change)
	 */
	refreshStylesheets(): void {
		this[kParseStylesheets]();

		// Rules can change LAYOUT (a display flip, new dimensions), and boxes
		// may already have been built under the pre-parse styles -- a
		// .view{display:none} arriving with the same batch as its markup left
		// the hidden subtree's stale boxes ghosting about. Rebuild from the
		// root; stylesheet changes are rare.
		const body = this[kDocument].body;
		if (body) {
			this[kLayoutEngine]?.invalidate(body);
		}
	}

	/**
	 * Bring the document's pseudo-element nodes into line with the rules just
	 * parsed: the ones a rule now reaches gain a node, the ones no rule
	 * reaches lose theirs.
	 */
	[kAttachPseudoElements](): void {
		// Re-evaluate existing pseudos IDENTITY-PRESERVINGLY -- never clear
		// wholesale: layout keys a pseudo's boxes by node instance, and a
		// fresh node per refresh strands every mapped one. Attach handles
		// content updates in place and removal when a pseudo stops matching.
		// Walks every element on stylesheet change.
		if (!this[kDocument].documentElement) {
			return;
		}
		const walker = this[kDocument].createTreeWalker(
			this[kDocument].documentElement,
			this[kWindow].NodeFilter.SHOW_ELEMENT,
			null,
		);
		let element = walker.nextNode() as Element;
		while (element) {
			if (pseudoElementCount(element) > 0) {
				this.attachPseudoElementsToElement(element);
			}
			element = walker.nextNode() as Element;
		}

		this.attachPseudoElementsToDocument();
	}

	/**
	 * Efficiently scan document and attach pseudo-element nodes to elements that have matching pseudo-element rules
	 * Uses CSS rules to find matching elements rather than checking every element
	 */
	attachPseudoElementsToDocument(): void {
		// Group pseudo-element rules by pseudo-type for efficient processing
		const pseudoRulesByType = new Map<string, ParsedCSSRule[]>();

		for (const rule of this[kParsedRules]) {
			if (
				rule.pseudoElement &&
				rule.pseudoElement !== "::placeholder" &&
				rule.pseudoElement !== "::selection" &&
				!rule.pseudoElement.startsWith("::part(")
			) {
				const rules = pseudoRulesByType.get(rule.pseudoElement) || [];
				rules.push(rule);
				pseudoRulesByType.set(rule.pseudoElement, rules);
			}
		}

		// Process each pseudo-element type
		for (const [pseudoType, rules] of pseudoRulesByType) {
			// Collect all matching elements for this pseudo-type
			const matchingElements = new Set<Element>();

			for (const rule of rules) {
				try {
					// Find all elements matching this rule's selector, within the
					// rule's own tree scope -- a document query can't see shadow
					// elements and a shadow rule must never claim document ones.
					const scope = (rule.scope ?? this[kDocument]) as ParentNode;
					const elements = scope.querySelectorAll(rule.selector);
					for (const element of elements) {
						matchingElements.add(element);
					}
				} catch (e) {
					// Skip invalid selectors
					continue;
				}
			}

			// Attach pseudo-elements to matching elements
			for (const element of matchingElements) {
				this[kAttachPseudoElementToElementForType](element, pseudoType);
			}
		}

		// Handle special case: ::marker for list-item elements (only for inside positioning)
		const listItems = this[kDocument].querySelectorAll(
			'[style*="list-item"], li',
		);
		for (const element of listItems) {
			const computedStyle = this.declarationFor(element);
			const display = computedStyle.computedValueOf("display");
			const listStylePosition =
				computedStyle.computedValueOf("list-style-position") || "outside";

			// Only create inline markers for inside positioning
			if (display === "list-item" && listStylePosition !== "outside") {
				this[kAttachPseudoElementToElementForType](element, "::marker");
			}
		}
	}

	/**
	 * The element types a pseudo-element rule originates on, uppercased -- or
	 * null where a rule reaches an element of any type, which is also what a
	 * counter rule does through the scope chain. Built on demand, from the
	 * subject each pseudo rule was parsed with.
	 */
	declare [kPseudoSubjectTags]: Set<string> | null | undefined;

	[kPseudoSubjects](): Set<string> | null {
		if (this[kPseudoSubjectTags] !== undefined) {
			return this[kPseudoSubjectTags];
		}
		if (this[kCounterRulesExist] || this[kListItemRulesExist]) {
			return (this[kPseudoSubjectTags] = null);
		}
		// A list carries the one counter no rule declares, and its items the
		// markers that counter numbers.
		const tags = new Set(["OL", "UL", "LI"]);
		// Only the pseudos this attaches: ::marker reaches list items, named
		// above, and ::placeholder, ::selection and ::part live on nodes the
		// widget trees already hold.
		for (const type of ["::before", "::after"]) {
			for (const rule of this[kPseudoRulesByType].get(type) ?? []) {
				if (!rule.subjectTag) {
					return (this[kPseudoSubjectTags] = null);
				}
				tags.add(rule.subjectTag.toUpperCase());
			}
		}
		return (this[kPseudoSubjectTags] = tags);
	}

	/**
	 * Attach pseudo-element nodes to a specific element if it has matching pseudo-element rules
	 */
	attachPseudoElementsToElement(element: Element): void {
		// No pseudo rule names this element's type, no counter scope reaches
		// it, and it carries no pseudo of its own to reconsider: everything
		// below would answer no, one matches() call per rule at a time. This is
		// the whole cost of the walk over a subtree that just arrived.
		const tags = this[kPseudoSubjects]();
		if (
			tags !== null &&
			!tags.has(element.tagName) &&
			pseudoElementCount(element) === 0 &&
			!this[kCounterScopes].has(element.parentElement!) &&
			!(element.getAttribute("style") ?? "").includes("list-item")
		) {
			return;
		}
		// Initialize counters for this element first
		this.initializeCounters(element);

		const pseudoTypes = ["::before", "::after", "::marker"];

		for (const pseudoType of pseudoTypes) {
			this[kAttachPseudoElementToElementForType](element, pseudoType);
		}
	}

	/**
	 * Could any parsed rule give this element a pseudo of this type? A few
	 * matches() calls against only the rules that declare the pseudo --
	 * instead of building the full pseudo style declaration per element per
	 * type just to discover `content` is "none". Over-matching is safe (the
	 * full path still decides); the win is the early false for the common
	 * document with no pseudo rules beyond the UA button brackets.
	 */
	[kPseudoRuleCouldMatch](element: Element, pseudoType: string): boolean {
		if (pseudoType === "::marker") {
			// Markers exist only on display:list-item boxes: an <li>, a rule
			// declaring it, or an inline style. Nothing else needs the
			// computed-display check below.
			return (
				element.tagName === "LI" ||
				this[kListItemRulesExist] ||
				(element.getAttribute("style") ?? "").includes("list-item")
			);
		}
		const rules = this[kPseudoRulesByType].get(pseudoType);
		if (!rules) {
			return false;
		}
		for (const rule of rules) {
			try {
				if (element.matches(rule.selector)) {
					return true;
				}
			} catch (_err) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Attach a specific pseudo-element type to an element if it should have one
	 */
	[kAttachPseudoElementToElementForType](
		element: Element,
		pseudoType: string,
	): void {
		// No rule can apply and none is attached: skip the counter and style
		// computations wholesale. (An attached pseudo still takes the full
		// path so a rule that STOPPED matching removes it.)
		if (
			!this[kPseudoRuleCouldMatch](element, pseudoType) &&
			!pseudoElement(element, pseudoType)
		) {
			return;
		}

		// Initialize counters for this element first (needed for counter() functions)
		this.initializeCounters(element);

		// Skip ::marker for elements without display: list-item or with outside positioning
		if (pseudoType === "::marker") {
			const computedStyle = this.declarationFor(element);
			const display = computedStyle.computedValueOf("display");
			const listStylePosition =
				computedStyle.computedValueOf("list-style-position") || "outside";

			if (display !== "list-item") {
				return;
			}

			// Remove inline markers for outside positioning
			if (listStylePosition === "outside") {
				this[kRemovePseudoElement](element, "::marker");
				return;
			}
		}

		// Compute what the pseudo should hold now; null means "none".
		const content = this.shouldCreatePseudoElement(element, pseudoType) ?
				this[kPseudoContentFor](element, pseudoType) :
			null;
		const existing = pseudoElement<Element>(element, pseudoType);

		// Pseudo NODE IDENTITY is stable: attaches re-run on every element
		// addition and attribute invalidation, and layout keys the pseudo's
		// boxes by instance -- a fresh node per attach strands the mapped one
		// (an absolutely positioned button's ::after glyph simply vanished).
		// The slot keeps the node; only its text changes.
		if (content === null) {
			if (existing) {
				this[kRemovePseudoElement](element, pseudoType);
			}
			return;
		}
		if (existing) {
			const text = existing.firstChild as Text;
			if (text.data !== content) {
				text.data = content;
				this[kLayoutEngine]?.invalidate(element);
			}
			return;
		}
		const node = ensurePseudoElement<Element>(element, pseudoType);
		node.appendChild(element.ownerDocument.createTextNode(content));
		this[kLayoutEngine]?.invalidateStructure();
		this[kLayoutEngine]?.invalidate(element);
	}

	/** Drop an element's pseudo-element node, and the boxes it held. */
	[kRemovePseudoElement](element: Element, pseudoType: string): void {
		if (!pseudoElement(element, pseudoType)) {
			return;
		}
		clearPseudoElement(element, pseudoType);
		this[kLayoutEngine]?.invalidateStructure();
		this[kLayoutEngine]?.invalidate(element);
	}

	[kSetupInvalidationHooks](): void {
		installInvalidationHooks(this[kWindow]);
		// A property written through element.style lands on the style attribute,
		// so the hooks above are the whole invalidation path for inline styles.
		installInlineStyle(this[kWindow]);
		installStyleSheets(this[kWindow]);
	}

	/**
	 * Invalidate cached computed style for an element
	 */
	// Elements style-invalidated since the last drain; null once the set
	// overflowed. The engine drains this per frame to bound a banded repaint.
	declare [kPendingStyleDamage]: Set<Element> | null;

	/**
	 * The style-invalidated elements since the last call, or null when the
	 * set overflowed (treat as unbounded). Resets the accumulator.
	 */
	drainStyleDamage(): Set<Element> | null {
		const damage = this[kPendingStyleDamage];
		this[kPendingStyleDamage] = new Set();
		return damage;
	}

	invalidateElement(element: Element): void {
		// A computed style an author still holds is the one this cache handed
		// out, so it is told the cascade moved on rather than merely dropped.
		this[kComputedStyleCache].get(element)?.invalidate();
		this[kComputedStyleCache].delete(element);
		this[kPseudoElementStyleCache].delete(element);
		// Kept until the rows it claims cover the screen, which the engine
		// decides as it turns elements into bands: a count cannot tell a
		// hundred one-row changes apart from one that reaches everything.
		this[kPendingStyleDamage]?.add(element);
		// A style change can flip display: contents, which moves the node's
		// flat-tree BOX parent, so every box enumeration keyed on the epoch is
		// stale from here.
		this[kLayoutEngine]?.invalidateFrame();
	}

	/**
	 * Clear all cached computed styles (nuclear option)
	 */
	clearCache(): void {
		// Every computed style ever handed out re-resolves on its next read:
		// there is no enumerating a WeakMap, so the epoch they all watch moves.
		this[kStyleEpoch].value++;
		this[kUsedGeneration]++;
		this[kComputedStyleCache] = new WeakMap();
		this[kPseudoElementStyleCache] = new WeakMap();
		this[kPseudoNodeStyles] = new WeakMap();
		this[kCounterScopes] = new WeakMap();
	}

	// ============================================================================
	// CSS COUNTER SUPPORT
	// ============================================================================
	/**
	 * Initialize counters for an element based on CSS properties
	 * Non-recursive approach to avoid memory issues
	 */
	initializeCounters(element: Element): void {
		// Skip if already initialized
		if (this[kCounterScopes].has(element)) {
			return;
		}

		// With no counter-bearing rules anywhere, only lists carry counters
		// (the automatic list-item one). Skip everything else -- UNLESS the
		// element sits under a scope-holding parent, so a chain like
		// ol > li > div > ol keeps its inheritance path unbroken.
		const tag = element.tagName;
		if (
			!this[kCounterRulesExist] &&
			tag !== "OL" &&
			tag !== "UL" &&
			tag !== "LI" &&
			!(
				element.parentElement && this[kCounterScopes].has(element.parentElement)
			) &&
			!(element.getAttribute("style") ?? "").includes("counter")
		) {
			return;
		}

		const computedStyle = this.declarationFor(element);
		const counterReset = computedStyle.computedValueOf("counter-reset");
		const counterIncrement = computedStyle.computedValueOf("counter-increment");

		// Get parent scope if parent exists (but don't recursively initialize parents)
		const parentElement = element.parentElement;
		const parentScope = parentElement ?
				this[kCounterScopes].get(parentElement) :
			undefined;

		// Create counter scope for this element
		const scope: CounterScope = {
			element,
			counters: {},
			parent: parentScope,
		};
		this[kCounterScopes].set(element, scope);

		// Handle counter-reset first
		if (counterReset && counterReset !== "none") {
			this[kParseCounterReset](scope, counterReset);
		}

		// Handle automatic list-item counter for ol/ul elements
		if (element.tagName === "OL" || element.tagName === "UL") {
			const startValue =
				element.tagName === "OL" ?
						parseInt(element.getAttribute("start") || "1", 10) :
					0;
			scope.counters["list-item"] = startValue - 1; // Reset to start-1 so first increment gives start
		}

		// Handle counter-increment after reset
		if (counterIncrement && counterIncrement !== "none") {
			this[kParseCounterIncrement](scope, counterIncrement);
		}

		// Handle automatic list-item increment for li elements
		if (element.tagName === "LI") {
			this[kIncrementCounter](scope, "list-item", 1);
		}
	}

	/**
	 * Parse counter-reset CSS property
	 */
	[kParseCounterReset](scope: CounterScope, counterReset: string): void {
		// Parse "counter1 value1 counter2 value2" format
		const tokens = counterReset.trim().split(/\s+/);
		for (let i = 0; i < tokens.length; i += 2) {
			const counterName = tokens[i];
			const value = tokens[i + 1] ? parseInt(tokens[i + 1], 10) : 0;
			if (counterName && !isNaN(value)) {
				scope.counters[counterName] = value;
			}
		}
	}

	/**
	 * Parse counter-increment CSS property
	 */
	[kParseCounterIncrement](
		scope: CounterScope,
		counterIncrement: string,
	): void {
		// Parse "counter1 increment1 counter2 increment2" format
		const tokens = counterIncrement.trim().split(/\s+/);
		for (let i = 0; i < tokens.length; i += 2) {
			const counterName = tokens[i];
			const increment = tokens[i + 1] ? parseInt(tokens[i + 1], 10) : 1;
			if (counterName && !isNaN(increment)) {
				this[kIncrementCounter](scope, counterName, increment);
			}
		}
	}

	/**
	 * Increment a counter by a specific amount
	 */
	[kIncrementCounter](
		scope: CounterScope,
		counterName: string,
		increment: number,
	): void {
		// For list-item counters, we need to check previous siblings for the most recent value
		if (counterName === "list-item" && scope.element.tagName === "LI") {
			const currentValue = this[kGetListItemCounterValue](scope.element);
			scope.counters[counterName] = currentValue + increment;
		} else {
			// For other counters, get value from parent scopes
			const currentValue = this[kGetCounterValueFromScope](
				scope.parent,
				counterName,
			);
			scope.counters[counterName] = currentValue + increment;
		}
	}

	/**
	 * Get the current list-item counter value by checking previous siblings
	 */
	[kGetListItemCounterValue](element: Element): number {
		// Find the parent OL/UL that establishes the counter scope
		let parent = element.parentElement;
		while (parent && parent.tagName !== "OL" && parent.tagName !== "UL") {
			parent = parent.parentElement;
		}

		if (!parent) {
			return 0;
		}

		// Get the reset value from the OL/UL
		const parentScope = this[kCounterScopes].get(parent);
		let currentValue = parentScope?.counters["list-item"] ?? 0;

		// Add increments from all previous LI siblings
		const siblings = Array.from(parent.children);
		const currentIndex = siblings.indexOf(element);

		for (let i = 0; i < currentIndex; i++) {
			const sibling = siblings[i];
			if (sibling.tagName === "LI") {
				currentValue += 1; // Each LI increments by 1
			}
		}

		return currentValue;
	}

	/**
	 * Get counter value from a specific scope (without current scope)
	 */
	[kGetCounterValueFromScope](
		scope: CounterScope | undefined,
		counterName: string,
	): number {
		// Look for counter in current scope or parent scopes
		let currentScope = scope;
		while (currentScope) {
			if (counterName in currentScope.counters) {
				return currentScope.counters[counterName];
			}
			currentScope = currentScope.parent;
		}
		return 0; // Counter not found
	}

	getCounterValue(element: Element, counterName: string): number {
		const scope = this[kCounterScopes].get(element);
		if (!scope) {
			return 0;
		}

		// Look for counter in current scope or parent scopes
		let currentScope: CounterScope | undefined = scope;
		while (currentScope) {
			if (counterName in currentScope.counters) {
				return currentScope.counters[counterName];
			}
			currentScope = currentScope.parent;
		}

		return 0; // Counter not found
	}

	/**
	 * Resolve counter() function in CSS content
	 * Supports: counter(name), counter(name, style)
	 */
	resolveCounterFunction(element: Element, content: string): string {
		// Replace all counter() functions in the content
		return content.replace(
			/counter\s*\(\s*([^,)]+)(?:\s*,\s*([^)]+))?\s*\)/g,
			(_match, counterName, style) => {
				const trimmedName = counterName.trim();
				const trimmedStyle = style?.trim() || "decimal";
				const value = this.getCounterValue(element, trimmedName);
				return formatCounterValue(value, trimmedStyle);
			},
		);
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		this[kComputedStyleCache] = new WeakMap();
		this[kPseudoElementStyleCache] = new WeakMap();
		this[kPseudoNodeStyles] = new WeakMap();
		this[kCounterScopes] = new WeakMap();
	}
}

/**
 * A counter's value in the counter style `counter()` named. A bullet style
 * names a glyph and ignores the value; everything else is the ordinal a list
 * marker of the same style would show, so `counter(x, lower-alpha)` and
 * `list-style-type: lower-alpha` agree at every value.
 */
function formatCounterValue(value: number, style: string): string {
	return BULLET_MARKERS[style] ?? formatOrdinal(value, style);
}
