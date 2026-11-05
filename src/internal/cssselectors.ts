import * as CSSTree from "./csstree.ts";
import type * as DOM from "./dom.ts";
import type {Element, Node} from "./dom.ts";
import {bidi, splitOnASCIIWhitespace, toASCIILowercase} from "./text.ts";
import {
	CDATA_SECTION_NODE,
	DOCUMENT_NODE,
	ELEMENT_NODE,
	getAttributeList,
	getAttributeValue,
	getElementChildren,
	getFirstChildNode,
	getLocalName,
	getNamespace,
	getNextSiblingNode,
	getNodeType,
	getParentNode,
	getPreviousSiblingNode,
	getRoot,
	hasAttributeByName,
	HTML_NAMESPACE,
	isElement,
	nextInTree,
	parentElement,
	SVG_NAMESPACE,
	TEXT_NODE,
	XLINK_NAMESPACE,
	XML_NAMESPACE,
} from "./tree.ts";

/**
 * What the matcher asks the DOM about an element's state: focus, hover,
 * a form control's validity and the rest, which only dom.ts can answer.
 * dom.ts hands them over as it loads, so this module never imports it.
 */
type ElementStates = Pick<
	typeof DOM,
	"getClassTokens" |
	"getHeadingLevel" |
	"getMeterLevel" |
	"getOpenAssignedSlot" |
	"getPartNames" |
	"getRangeMatch" |
	"getShadowHost" |
	"getUserValidityMatch" |
	"getValidityMatch" |
	"hasCustomState" |
	"hasFocus" |
	"hasFocusWithin" |
	"isActive" |
	"isActuallyDisabled" |
	"isCheckedControl" |
	"isDefaultControl" |
	"isDefinedElement" |
	"isFocusVisible" |
	"isFormAssociatedCustom" |
	"isFullscreenElement" |
	"isHovered" |
	"isHTMLNode" |
	"isIndeterminateControl" |
	"isInQuirksMode" |
	"isMeterValue" |
	"isModalDialog" |
	"isOpenElement" |
	"isPlaceholderShown" |
	"isShowingPopover" |
	"isTargetElement" |
	"READONLY_INPUT_TYPES" |
	"REQUIRED_INPUT_TYPES"
>;

let states: ElementStates;

export function setElementStates(given: ElementStates): void {
	states = given;
}

// CSS Selectors: the language, and the matcher a selector compiles to.
// css-tree parses the selector. It is checked against the pseudo-classes
// and pseudo-elements this engine knows and compiled into one closure per
// compound selector. The closures read the node's structure and the
// document state around it: which element the pointer is over, which has
// focus, what a shadow root's host is, whether a dialog is modal. A bug
// in a pseudo-class is a bug in one function rather than in generated
// source. bidi-js finds the first strong character for `:dir(auto)`.
// Matching runs right to left, from the subject compound outwards, which
// makes a long descendant selector cheap: the first compound that fails
// ends the walk.

// A selector naming anything else does not parse, which makes
// `:gibberish` invalid rather than merely unmatched.
const PSEUDO_CLASSES: ReadonlySet<string> = new Set([
	"-moz-meter-optimum",
	"-moz-meter-sub-optimum",
	"-moz-meter-sub-sub-optimum",
	"active",
	"any-link",
	"autofill",
	"blank",
	"buffering",
	"checked",
	"closed",
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
	"heading",
	"host",
	"host-context",
	"hover",
	"in-range",
	"high-value",
	"indeterminate",
	"invalid",
	"is",
	"lang",
	"last-child",
	"last-of-type",
	"left",
	"low-value",
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
	"optimal-value",
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

const PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
	"-moz-meter-bar",
	"-moz-progress-bar",
	"-webkit-meter-bar",
	"-webkit-meter-even-less-good-value",
	"-webkit-meter-optimum-value",
	"-webkit-meter-suboptimum-value",
	"-webkit-progress-bar",
	"-webkit-progress-value",
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
	"slider-fill",
	"slider-thumb",
	"slider-track",
	"slotted",
	"spelling-error",
	"target-text",
	"view-transition",
	"view-transition-group",
	"view-transition-image-pair",
	"view-transition-new",
	"view-transition-old",
]);

// Written only in functional form: `::part(name)`, never a bare
// `::part`.
const FUNCTIONAL_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
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

/** May also be written with one colon, per CSS 2. */
const LEGACY_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
	"after",
	"before",
	"first-letter",
	"first-line",
]);

export function isLegacyPseudoElement(name: string): boolean {
	return LEGACY_PSEUDO_ELEMENTS.has(name);
}

const ARGUMENTLESS_PSEUDO_CLASSES: ReadonlySet<string> = new Set([
	"-moz-meter-optimum",
	"-moz-meter-sub-optimum",
	"-moz-meter-sub-sub-optimum",
	"active",
	"any-link",
	"autofill",
	"blank",
	"buffering",
	"checked",
	"closed",
	"current",
	"default",
	"defined",
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
	"hover",
	"in-range",
	"high-value",
	"indeterminate",
	"invalid",
	"last-child",
	"last-of-type",
	"left",
	"low-value",
	"link",
	"local-link",
	"modal",
	"muted",
	"only-child",
	"only-of-type",
	"open",
	"optimal-value",
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
	"target",
	"target-current",
	"target-within",
	"user-invalid",
	"user-valid",
	"valid",
	"visited",
	"volume-locked",
	"window-inactive",
]);

export function getChildren(
	node: CSSTree.SelectorNode,
): CSSTree.SelectorNode[] {
	const children = node.children;
	if (!children) {
		return [];
	}
	return Array.isArray(children) ? children : children.toArray();
}

/**
 * The identifier the source escapes spell, ASCII-lowercased.
 * `::\000041fter` and `::AFTER` are both `::after`. An escape is part of
 * the spelling, not of the name.
 */
export function pseudoName(name: string): string {
	return toASCIILowercase(CSSTree.ident.decode(name));
}

/** The namespaces a selector's prefixes resolve against. */
export interface SelectorNamespaces {
	default: string | null;
	prefixes: Map<string, string>;
}

/** A selector this engine rejects, thrown from compilation. */
export class SelectorError extends Error {}

function matchNothing(): boolean {
	return false;
}

interface MatchState {

	// Each parent's element children, gathered once per query, with each
	// child's index and the children by type. :nth-child and the of-type
	// tests read a candidate's siblings, and without the index a query over
	// a long list counted through the same siblings once per candidate.
	siblings: SiblingIndexes;

	// The siblings each `of S` list keeps, apart from the indexes, since
	// an attribute that changes which siblings match S leaves their order.
	filteredSiblings: FilteredSiblingIndexes;

	// The node `:scope` refers to, or null when the selector uses none.
	scope: Node | null;

	// The shadow root the selector was written inside, for `:host`.
	shadow: Node | null;

	// The node a relative selector inside `:has()` is anchored to.
	anchor: Node | null;

	// The caller's store of `:has()` answers, by anchor and argument.
	hasResults: HasResults | null;
}

/** `:has()` answers, kept by a caller that knows when they go stale. */
export type HasResults = WeakMap<Element, Map<object, boolean>>;

/** Each parent's element children, as a caller keeps them across matches. */
export type SiblingIndexes = WeakMap<Node, SiblingIndex>;
export type FilteredSiblingIndexes = WeakMap<
	SiblingIndex,
	Map<CompiledComplex[], FilteredSiblings>
>;

type Predicate = (element: Element, state: MatchState) => boolean;

export type Combinator = " " | ">" | "+" | "~";

/** A pseudo-class, with the selectors it takes compiled. */
export interface CompiledPseudoClass {
	name: string;

	// `:not(.a, .b)`, `:has(> .b)` and `:nth-child(2n of .a)` hold
	// selectors. `:hover` and `:lang(en)` hold none.
	args: CompiledComplex[];
}

/** A pseudo-element, as a style rule for one is written. */
export interface CompiledPseudoElement {
	name: string;

	// What it names, as `::part(label)` names `label`, or null.
	argument: string | null;

	// The pseudo-classes written after it, which the pseudo-element itself
	// must match: `::part(inner):dir(rtl)`.
	after: CompiledCompound | null;
}

export interface CompiledCompound {

	tests: Predicate[];

	// The element the compound really describes, when a pseudo-element
	// moves the subject. `slot::slotted(span)` selects the span and
	// describes the slot. `host::part(x)` selects the part and describes the
	// host. The combinator to the left steps from what this returns.
	origin: ((element: Element, state: MatchState) => Element | null) | null;

	originTests: Predicate[];

	// May match a featureless shadow host.
	host: boolean;

	// The compound's own simple selectors, none inside an argument. The
	// type is the lowercase local name, null for none or `*`, and an
	// attribute is the lowercase local name a mutation reports.
	tag: string | null;
	ids: string[];
	classes: string[];
	attributes: string[];
	pseudoClasses: CompiledPseudoClass[];

	// The `::part()` or `::slotted()` the compound selects through.
	pseudoElement: CompiledPseudoElement | null;
}

export interface CompiledComplex {
	compounds: CompiledCompound[];

	// Joins compound `index` to compound `index + 1`.
	combinators: Combinator[];

	// Ids, then classes, then types, packed so a greater number is the
	// greater weight.
	specificity: number;

	// The pseudo-element a style rule styles, read when compiled with
	// `pseudoElements`. The compounds select the element it belongs to.
	pseudoElement: CompiledPseudoElement | null;

	// Whether `:host` or `:host-context()` is written in it, at any depth,
	// which only matches with the shadow root it was written in.
	host: boolean;
}

/** A compiled selector list, ready to match against an element. */
export interface CompiledSelector {
	list: CompiledComplex[];
}

// CSS Syntax closes an unterminated string, function or block at end of
// file rather than rejecting it, so `[align="center"` and
// `::slotted(foo` are both selectors. css-tree needs them closed.
function closeAtEndOfInput(text: string): string {
	const open: string[] = [];
	let quote = "";
	let dangling = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "\\") {
			// An escape with nothing left to escape stands for U+FFFD, so the
			// name it is part of is still a name and the selector is still a
			// selector.
			dangling = index === text.length - 1;
			index++;
			continue;
		}
		if (quote !== "") {
			if (char === quote) {
				quote = "";
			}
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(") {
			open.push(")");
		} else if (char === "[") {
			open.push("]");
		} else if (char === ")" || char === "]") {
			if (open[open.length - 1] === char) {
				open.pop();
			}
		}
	}
	if (open.length === 0 && quote === "" && !dangling) {
		return text;
	}
	return (text + (dangling ? "\uFFFD" : "") + quote + open.reverse().join(""));
}

// `div,` and a bare `,` both contain an empty selector. css-tree drops
// the empty one and parses the rest, but a selector list that cannot be
// parsed is not a selector list.
function hasEmptySelector(text: string): boolean {
	let depth = 0;
	let quote = "";
	let start = 0;
	const empty = (end: number): boolean => text.slice(start, end).trim() === "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote !== "") {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = "";
			}
		} else if (char === "\\") {
			index++;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(" || char === "[") {
			depth++;
		} else if (char === ")" || char === "]") {
			depth--;
		} else if (char === "," && depth === 0) {
			if (empty(index)) {
				return true;
			}
			start = index + 1;
		}
	}
	return empty(text.length);
}

interface CompileOptions {

	// Null leaves the prefixes unresolved: the selector is checked for
	// shape and every prefix is accepted. A grammar check wants that; a
	// match does not.
	namespaces?: SelectorNamespaces | null;

	// The DOM's own query methods accept `a::before` and match nothing with
	// it. The cascade sets this: a selector ending with a pseudo-element
	// selects the element the pseudo-element belongs to, and records the
	// pseudo-element, and its `::slotted()` and `::part()` match for real.
	pseudoElements?: boolean;

	// Allow the selector to open with a combinator, as `@scope` does.
	relative?: boolean;

	// `&` is allowed inside a style rule and nowhere else. It selects
	// nothing on its own; the rule it is nested in gives it something to
	// refer to.
	nesting?: boolean;
}

interface Compiling {
	namespaces: SelectorNamespaces | null;
	pseudoElements: boolean;
	nesting: boolean;
	nested?: boolean;
}

// Checks shape only. A prefix means whatever the sheet declares, which
// is not this check's concern, and `&` is allowed where a rule encloses
// it.
const GRAMMAR_ONLY: CompileOptions = {
	namespaces: null,
	pseudoElements: true,
	nesting: true,
	// `@scope` lets a rule open with a combinator. Anywhere else such a
	// rule parses as a selector and then selects nothing, since there is no
	// root for it to be relative to.
	relative: true,
};

// Normalizes newlines and replaces every null and lone surrogate with
// U+FFFD (CSS Syntax 3).
function preprocess(text: string): string {
	if (!/[\0\r\f\uD800-\uDFFF]/.test(text)) {
		return text;
	}
	return text
		.replace(/\r\n?|\f/g, "\n")
		.replace(/\0/g, "\uFFFD")
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
		.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function parseSelectorAST(text: string): CSSTree.SelectorNode | null {
	const source = preprocess(String(text));
	if (source.trim() === "" || hasEmptySelector(source)) {
		return null;
	}
	let list: CSSTree.SelectorNode;
	try {
		list = CSSTree.parse(closeAtEndOfInput(source), {
			context: "selectorList",
			onParseError(error: Error) {
				throw error;
			},
		}) as unknown as CSSTree.SelectorNode;
	} catch (_err) {
		return null;
	}
	return list.type === "SelectorList" ? list : null;
}

/**
 * Returns null when the text does not parse, including when it uses a
 * pseudo this engine does not know, since an unknown pseudo makes the
 * whole selector invalid. Prefixes are checked for shape only. Whether
 * `svg|circle` names a declared namespace is for whoever knows the
 * declarations.
 */
export function parseSelectorList(text: string): CSSTree.SelectorNode | null {
	const list = parseSelectorAST(text);
	return list !== null && isInGrammar(text, list) ? list : null;
}

// Whether a selector compiles, by its text, since a sheet repeats its
// selectors and a page may load a sheet twice.
const grammarChecks = new Map<string, boolean>();

function isInGrammar(text: string, list: CSSTree.SelectorNode): boolean {
	let valid = grammarChecks.get(text);
	if (valid === undefined) {
		try {
			compileList(list, GRAMMAR_ONLY);
			valid = true;
		} catch (_err) {
			valid = false;
		}
		if (grammarChecks.size > 16384) {
			grammarChecks.clear();
		}
		grammarChecks.set(text, valid);
	}
	return valid;
}

function compileList(
	list: CSSTree.SelectorNode,
	options: CompileOptions,
): CompiledSelector {
	const compiling: Compiling = {
		namespaces: options.namespaces === undefined
			? {default: null, prefixes: new Map()}
			: options.namespaces,
		pseudoElements: options.pseudoElements ?? false,
		nesting: options.nesting ?? false,
	};
	const compiled: CompiledComplex[] = [];
	for (const selector of getChildren(list)) {
		if (selector.type !== "Selector") {
			throw new SelectorError("a selector list holds selectors");
		}
		compiled.push(
			compileComplex(selector, compiling, options.relative ?? false),
		);
	}
	if (compiled.length === 0) {
		throw new SelectorError("a selector list selects something");
	}
	return {list: compiled};
}

function createCompound(): CompiledCompound {
	return {
		tests: [],
		origin: null,
		originTests: [],
		host: false,
		tag: null,
		ids: [],
		classes: [],
		attributes: [],
		pseudoClasses: [],
		pseudoElement: null,
	};
}

// The compound a relative selector hangs from: the element `:has()` was
// asked about. That can be a featureless shadow host, asked as :host.
const ANCHOR_COMPOUND: CompiledCompound = {
	...createCompound(),
	tests: [
		(element: Element, state: MatchState): boolean =>
			element === state.anchor,
	],
	host: true,
};

// The anchor of a `:has()` argument written with no combinator of its
// own, which reaches down from it.
const IMPLIED_ANCHOR: CompiledCompound = {...ANCHOR_COMPOUND};

/** Whether the selector opens with a combinator, as a relative one may. */
export function opensWithCombinator(complex: CompiledComplex): boolean {
	return complex.compounds[0] === ANCHOR_COMPOUND;
}

/** Whether the selector is written with a combinator. */
export function writesCombinator(complex: CompiledComplex): boolean {
	return complex.combinators.length >
		(complex.compounds[0] === IMPLIED_ANCHOR ? 1 : 0);
}

function mentionsScope(node: CSSTree.SelectorNode): boolean {
	if (
		node.type === "PseudoClassSelector" &&
		pseudoName(String(node.name ?? "")) === "scope"
	) {
		return true;
	}
	return getChildren(node).some(mentionsScope);
}

// `anchored` is for an argument of :has(), which with no combinator of its
// own reaches down from the anchor. An @scope rule's relative reading
// matches where it stands and is limited by its root elsewhere.
function compileComplex(
	selector: CSSTree.SelectorNode,
	outer: Compiling,
	relative: boolean,
	anchored = false,
): CompiledComplex {
	const written = getChildren(selector);
	if (written.length === 0) {
		throw new SelectorError("a selector selects something");
	}
	// A style rule's own selector may end with the pseudo-element it styles.
	// Anywhere else a pseudo-element selects nothing.
	const trailing = outer.pseudoElements && !outer.nested
		? findTrailingPseudoElement(written)
		: -1;
	const compiling = trailing === -1 && outer.pseudoElements
		? {...outer, pseudoElements: false}
		: outer;
	const parts = trailing === -1 ? written : written.slice(0, trailing);
	const compounds: CompiledCompound[] = [];
	const combinators: Combinator[] = [];
	let pending: CSSTree.SelectorNode[] = [];
	let started = false;
	// `:has(span + span)` is `:has(:scope span + span)`.
	if (anchored && parts[0].type !== "Combinator") {
		compounds.push(IMPLIED_ANCHOR);
		combinators.push(" ");
		started = true;
	}
	for (const [index, part] of parts.entries()) {
		if (part.type !== "Combinator") {
			pending.push(part);
			continue;
		}
		const combinator = String(part.name ?? " ").trim() || " ";
		if (combinator !== " " && !"> + ~".includes(combinator)) {
			throw new SelectorError(`unknown combinator ${combinator}`);
		}
		if (index === 0) {
			// A relative selector opens with a combinator and is anchored to
			// whatever the caller says. Anywhere else that is a parse error.
			if (!relative || started) {
				throw new SelectorError("a selector may not open with a combinator");
			}
			compounds.push(ANCHOR_COMPOUND);
			combinators.push(combinator as Combinator);
			started = true;
			continue;
		}
		if (pending.length === 0) {
			throw new SelectorError("two combinators in a row");
		}
		compounds.push(compileCompound(pending, compiling));
		combinators.push(combinator as Combinator);
		pending = [];
		started = true;
	}
	if (pending.length === 0 && trailing === -1) {
		throw new SelectorError("a combinator joins two compounds");
	}
	compounds.push(compileCompound(pending, compiling));
	const pseudoElement = trailing === -1
		? null
		: compileTrailingPseudoElement(
			written[trailing],
			written.slice(trailing + 1),
			compiling,
		);
	const after = pseudoElement?.after ?? null;
	return {
		compounds,
		combinators,
		specificity: getSpecificity(selector),
		pseudoElement,
		host: (after === null ? compounds : [...compounds, after]).some(
			(compound) => compound.pseudoClasses.some(({name, args}) =>
				name.startsWith("host") || args.some((inner) => inner.host)),
		),
	};
}

// selectors-4 §17: ids, then classes/attributes/pseudo-classes, then
// types/pseudo-elements.
type Specificity = [number, number, number];

// Their weight is their most specific argument's. The name itself
// counts nothing.
const ARGUMENT_WEIGHTED_PSEUDO_CLASSES = new Set([
	"has",
	"is",
	"matches",
	"not",
	"-moz-any",
	"-webkit-any",
]);

// Weigh as a class AND add their most specific argument's weight.
const COMPOUND_WEIGHTED_PSEUDO_CLASSES = new Set([
	"host",
	"host-context",
	"nth-child",
	"nth-last-child",
]);

function getSpecificity(selector: CSSTree.SelectorNode): number {
	const [ids, classes, types] = getSelectorSpecificity(selector);
	return (ids * 2 ** 16 + classes) * 2 ** 16 + types;
}

function getListSpecificity(list: CSSTree.SelectorNode): Specificity {
	let most: Specificity = [0, 0, 0];
	for (const selector of getChildren(list)) {
		const weight = getSelectorSpecificity(selector);
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

function getSelectorSpecificity(selector: CSSTree.SelectorNode): Specificity {
	const total: Specificity = [0, 0, 0];
	const add = (weight: Specificity): void => {
		total[0] += weight[0];
		total[1] += weight[1];
		total[2] += weight[2];
	};
	const argumentWeight = (node: CSSTree.SelectorNode): Specificity => {
		for (const child of getChildren(node)) {
			if (child.type === "SelectorList") {
				return getListSpecificity(child);
			}
			if (child.type === "Selector") {
				return getSelectorSpecificity(child);
			}
			if (child.type === "Nth" && child.selector) {
				return getListSpecificity(child.selector);
			}
		}
		return [0, 0, 0];
	};
	for (const part of getChildren(selector)) {
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
			// an element, and a compound argument adds to that.
			case "PseudoElementSelector":
				total[2]++;
				add(argumentWeight(part));
				break;
			case "PseudoClassSelector": {
				const name = pseudoName(String(part.name ?? ""));
				// `:before` is the CSS 2 spelling of a pseudo-element, and
				// weighs as one.
				if (isLegacyPseudoElement(name)) {
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

function compileCompound(
	parts: CSSTree.SelectorNode[],
	compiling: Compiling,
): CompiledCompound {
	const compound = createCompound();
	// A type selector is only a type selector when written first.
	for (const [index, part] of parts.entries()) {
		if (part.type === "TypeSelector" && index !== 0) {
			throw new SelectorError("a type selector opens its compound");
		}
	}
	for (const part of parts) {
		compileSimple(part, compound, compiling);
	}
	// CSS Namespaces 2: a default namespace applies to a compound that
	// names no type, so with an HTML default declared, `.card` selects no
	// SVG element. A featureless host is outside all of that.
	const declared = compiling.namespaces?.default ?? null;
	if (
		declared !== null &&
		!compound.host &&
		!parts.some((part) => part.type === "TypeSelector")
	) {
		compound.tests.push((element) => getNamespace(element) === declared);
	}
	return compound;
}

function compileSimple(
	part: CSSTree.SelectorNode,
	compound: CompiledCompound,
	compiling: Compiling,
): void {
	switch (part.type) {
		case "TypeSelector":
			compileType(String(part.name ?? ""), compound, compiling);
			return;
		case "IdSelector": {
			const id = CSSTree.ident.decode(String(part.name ?? ""));
			if (id === "") {
				throw new SelectorError("an id selector names an id");
			}
			compound.ids.push(id);
			const folded = toASCIILowercase(id);
			compound.tests.push((element) => {
				const value = getAttributeValue(element, "id");
				if (value === null) {
					return false;
				}
				return states.isInQuirksMode(element)
					? toASCIILowercase(value) === folded
					: value === id;
			});
			return;
		}
		case "ClassSelector": {
			const name = CSSTree.ident.decode(String(part.name ?? ""));
			if (name === "") {
				throw new SelectorError("a class selector names a class");
			}
			compound.classes.push(name);
			const folded = toASCIILowercase(name);
			compound.tests.push((element) => {
				const tokens = states.getClassTokens(element);
				if (!states.isInQuirksMode(element)) {
					return tokens.has(name);
				}
				for (const token of tokens) {
					if (toASCIILowercase(token) === folded) {
						return true;
					}
				}
				return false;
			});
			return;
		}
		case "AttributeSelector":
			compileAttribute(part, compound, compiling);
			return;
		case "PseudoClassSelector":
			compilePseudoClass(part, compound, compiling);
			return;
		case "PseudoElementSelector":
			if (compiling.nested) {
				throw new SelectorError(
					"a pseudo-element cannot appear inside a pseudo-class",
				);
			}
			compilePseudoElement(part, compound, compiling);
			return;
		case "NestingSelector":
			if (!compiling.nesting) {
				throw new SelectorError("a nesting selector needs a rule around it");
			}
			compound.tests.push(matchNothing);
			return;
		default:
			throw new SelectorError(`unreadable selector part ${part.type}`);
	}
}

interface QualifiedName {

	// Null for no namespace, undefined for any.
	namespace: string | null | undefined;

	// Null for `*`.
	local: string | null;
}

function qualifiedName(
	name: string,
	namespaces: SelectorNamespaces | null,
	attribute: boolean,
): QualifiedName {
	const bar = name.lastIndexOf("|");
	if (bar === -1) {
		const local = CSSTree.ident.decode(name);
		return {
			// An attribute with no prefix is in no namespace. An element with
			// no prefix is in the default namespace the sheet declared.
			namespace: attribute ? null : (namespaces?.default ?? undefined),
			local: local === "*" ? null : local,
		};
	}
	const prefix = name.slice(0, bar);
	const rest = name.slice(bar + 1);
	const local = rest === "*" ? null : CSSTree.ident.decode(rest);
	if (prefix === "*") {
		return {namespace: undefined, local};
	}
	if (prefix === "") {
		return {namespace: null, local};
	}
	if (namespaces === null) {
		return {namespace: undefined, local};
	}
	const uri = namespaces.prefixes.get(CSSTree.ident.decode(prefix));
	if (uri === undefined) {
		throw new SelectorError(`no namespace is declared for ${prefix}`);
	}
	return {namespace: uri, local};
}

// ASCII case-insensitive against an HTML element in an HTML document,
// case-sensitive everywhere else. That keeps `feGaussianBlur` selectable
// and lets `DIV` match a `div`.
function compileType(
	name: string,
	compound: CompiledCompound,
	compiling: Compiling,
): void {
	const {namespace, local} = qualifiedName(name, compiling.namespaces, false);
	const folded = local === null ? null : toASCIILowercase(local);
	compound.tag = folded;
	compound.tests.push((element) => {
		if (getNodeType(element) !== ELEMENT_NODE) {
			return false;
		}
		const elementNamespace = getNamespace(element);
		if (namespace !== undefined && elementNamespace !== namespace) {
			return false;
		}
		if (local === null) {
			return true;
		}
		const elementLocal = getLocalName(element);
		if (elementLocal === local) {
			return true;
		}
		return (
			elementNamespace === HTML_NAMESPACE &&
			states.isHTMLNode(element) &&
			toASCIILowercase(elementLocal) === folded
		);
	});
}

// Compared case-insensitively on an HTML element in an HTML document
// when the selector does not state its own case sensitivity.
const CASE_INSENSITIVE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"accept",
	"accept-charset",
	"align",
	"alink",
	"axis",
	"bgcolor",
	"charset",
	"checked",
	"clear",
	"codetype",
	"color",
	"compact",
	"declare",
	"defer",
	"dir",
	"direction",
	"disabled",
	"enctype",
	"face",
	"frame",
	"frameborder",
	"hreflang",
	"http-equiv",
	"lang",
	"language",
	"link",
	"media",
	"method",
	"multiple",
	"nohref",
	"noresize",
	"noshade",
	"nowrap",
	"readonly",
	"rel",
	"rev",
	"rules",
	"scope",
	"scrolling",
	"selected",
	"shape",
	"target",
	"text",
	"type",
	"valign",
	"valuetype",
	"vlink",
]);

const ATTRIBUTE_OPERATORS = new Set(["=", "~=", "|=", "^=", "$=", "*="]);

function compileAttribute(
	part: CSSTree.SelectorNode,
	compound: CompiledCompound,
	compiling: Compiling,
): void {
	const qualified = (part.name as {name?: string} | undefined)?.name;
	const {namespace, local} = qualifiedName(
		String(qualified ?? ""),
		compiling.namespaces,
		true,
	);
	if (local === null) {
		throw new SelectorError("an attribute selector names an attribute");
	}
	const folded = toASCIILowercase(local);
	compound.attributes.push(folded);
	const flags = part.flags == null ? "" : toASCIILowercase(String(part.flags));
	if (flags !== "" && flags !== "i" && flags !== "s") {
		throw new SelectorError(`unknown attribute flag ${flags}`);
	}
	// Read the attribute the way HTML reads a name. An HTML element in an
	// HTML document lowercases its attribute names.
	const read = (element: Element): string | null => {
		const fold =
			getNamespace(element) === HTML_NAMESPACE && states.isHTMLNode(element);
		const attributes = getAttributeList(element);
		for (let index = 0; index < attributes.length; index++) {
			const attribute = attributes[index];
			if (namespace !== undefined && attribute.extra.namespace !== namespace) {
				continue;
			}
			const name = attribute.extra.localName;
			if (name === local || (fold && toASCIILowercase(name) === folded)) {
				return attribute.extra.value;
			}
		}
		return null;
	};
	const operator = part.matcher ?? null;
	if (operator === null) {
		compound.tests.push((element) => read(element) !== null);
		return;
	}
	if (!ATTRIBUTE_OPERATORS.has(operator)) {
		throw new SelectorError(`unknown attribute operator ${operator}`);
	}
	const raw = part.value;
	let wanted: string;
	if (raw && raw.type === "String") {
		wanted = String(raw.value ?? "");
	} else if (raw && raw.type === "Identifier") {
		wanted = CSSTree.ident.decode(String(raw.name ?? ""));
	} else {
		throw new SelectorError("an attribute selector compares to one value");
	}
	const foldedWanted = toASCIILowercase(wanted);
	compound.tests.push((element) => {
		const value = read(element);
		if (value === null) {
			return false;
		}
		const insensitive =
			flags === "i" ||
			(flags === "" &&
				getNamespace(element) === HTML_NAMESPACE &&
				states.isHTMLNode(element) &&
				CASE_INSENSITIVE_ATTRIBUTES.has(folded));
		const subject = insensitive ? toASCIILowercase(value) : value;
		const target = insensitive ? foldedWanted : wanted;
		switch (operator) {
			case "=":
				return subject === target;
			case "~=":
				// A value with whitespace in it, or an empty value, is in no
				// list.
				if (target === "" || /[\t\n\f\r ]/.test(target)) {
					return false;
				}
				return splitOnASCIIWhitespace(subject).includes(target);
			case "|=":
				return subject === target || subject.startsWith(`${target}-`);
			case "^=":
				return target !== "" && subject.startsWith(target);
			case "$=":
				return target !== "" && subject.endsWith(target);
			default:
				return target !== "" && subject.includes(target);
		}
	});
}

// The pseudo-classes that take no argument and test the element alone,
// or with the match state.
const PSEUDO_CLASS_TESTS: Readonly<Record<string, Predicate>> = {
	scope: (element, state) => element === state.scope,
	root: (element) => {
		const parent = getParentNode(element);
		return parent !== null && getNodeType(parent) === DOCUMENT_NODE;
	},
	empty: isEmpty,
	"first-child": (element) => getPreviousElement(element) === null,
	"last-child": (element) => getNextElement(element) === null,
	"only-child": (element) =>
		getPreviousElement(element) === null && getNextElement(element) === null,
	"first-of-type": (element, state) =>
		getOfTypeIndex(element, false, state) === 1,
	"last-of-type": (element, state) =>
		getOfTypeIndex(element, true, state) === 1,
	"only-of-type": (element, state) =>
		getOfTypeIndex(element, false, state) === 1 &&
		getOfTypeIndex(element, true, state) === 1,
	link: isHyperlink,
	"any-link": isHyperlink,
	// A terminal has never recorded a visited link, and answering would
	// leak history even if it had.
	visited: matchNothing,
	target: (element) => states.isTargetElement(element),
	hover: (element) => states.isHovered(element),
	// Between a mouse press and its release, which a terminal's mouse
	// reporting sends apart.
	active: (element) => states.isActive(element),
	focus: (element) => states.hasFocus(element),
	"focus-visible": (element) => states.isFocusVisible(element),
	"focus-within": (element) => states.hasFocusWithin(element),
	// A dialog shown modally, or an element in fullscreen.
	modal: (element) =>
		states.isModalDialog(element) || states.isFullscreenElement(element),
	"popover-open": (element) => states.isShowingPopover(element),
	fullscreen: (element) => states.isFullscreenElement(element),
	defined: (element) => states.isDefinedElement(element),
	open: (element) => states.isOpenElement(element),
	closed: (element) => canOpen(element) && !states.isOpenElement(element),
	checked: (element) => states.isCheckedControl(element),
	indeterminate: (element) => states.isIndeterminateControl(element),
	"low-value": (element) => states.isMeterValue(element, "low"),
	"high-value": (element) => states.isMeterValue(element, "high"),
	"optimal-value": (element) => states.getMeterLevel(element) === "optimum",
	"-moz-meter-optimum": (element) =>
		states.getMeterLevel(element) === "optimum",
	"-moz-meter-sub-optimum": (element) =>
		states.getMeterLevel(element) === "suboptimum",
	"-moz-meter-sub-sub-optimum": (element) =>
		states.getMeterLevel(element) === "even-less-good",
	"placeholder-shown": (element) => states.isPlaceholderShown(element),
	default: (element) => states.isDefaultControl(element),
	disabled: (element) => states.isActuallyDisabled(element),
	enabled: (element) =>
		isDisableable(element) && !states.isActuallyDisabled(element),
	valid: (element) => states.getValidityMatch(element) === "valid",
	invalid: (element) => states.getValidityMatch(element) === "invalid",
	"user-valid": (element) => states.getUserValidityMatch(element) === "valid",
	"user-invalid": (element) =>
		states.getUserValidityMatch(element) === "invalid",
	"in-range": (element) => states.getRangeMatch(element) === "in",
	"out-of-range": (element) => states.getRangeMatch(element) === "out",
	required: (element) =>
		isRequirable(element) && getAttributeValue(element, "required") !== null,
	optional: (element) =>
		isRequirable(element) && getAttributeValue(element, "required") === null,
	"read-only": (element) => !isMutable(element),
	"read-write": isMutable,
};

function compilePseudoClass(
	part: CSSTree.SelectorNode,
	compound: CompiledCompound,
	compiling: Compiling,
): void {
	const name = pseudoName(String(part.name ?? ""));
	const args = getChildren(part);
	const pseudoClass: CompiledPseudoClass = {name, args: []};
	compound.pseudoClasses.push(pseudoClass);
	if (LEGACY_PSEUDO_ELEMENTS.has(name) && !PSEUDO_CLASSES.has(name)) {
		compilePseudoElement(part, compound, compiling);
		return;
	}
	if (!PSEUDO_CLASSES.has(name)) {
		throw new SelectorError(`unknown pseudo-class :${name}`);
	}
	if (ARGUMENTLESS_PSEUDO_CLASSES.has(name) && args.length !== 0) {
		throw new SelectorError(`:${name} takes no argument`);
	}
	if (
		!ARGUMENTLESS_PSEUDO_CLASSES.has(name) &&
		args.length === 0 &&
		name !== "host"
	) {
		throw new SelectorError(`:${name} takes an argument`);
	}
	switch (name) {
		case "is":
		case "where":
		case "matches": {
			const inner = compileForgiving(args, compiling);
			pseudoClass.args = inner;
			compound.tests.push((element, state) =>
				inner.some((complex) => matchComplex(complex, element, state, false)),
			);
			return;
		}
		case "not": {
			const inner = compileArgumentList(args, compiling, false);
			pseudoClass.args = inner;
			compound.tests.push(
				(element, state) =>
					!inner.some((complex) =>
						matchComplex(complex, element, state, false),
					),
			);
			return;
		}
		case "has": {
			const inner = compileArgumentList(args, compiling, true, true);
			pseudoClass.args = inner;
			// Without :scope, whose meaning changes with each query, the
			// answer depends only on the anchor and the document, so a caller
			// can keep it for as long as the document is unchanged.
			const cacheable = !args.some(mentionsScope);
			compound.tests.push((element, state) =>
				hasMatch(inner, element, state, cacheable),
			);
			return;
		}
		case "host":
		case "host-context": {
			compound.host = true;
			const inner = args.length === 0
				? null
				: compileArgumentList(args, compiling, false);
			pseudoClass.args = inner ?? [];
			const context = name === "host-context";
			compound.tests.push((element, state) => {
				const shadow = state.shadow;
				if (shadow === null || states.getShadowHost(shadow) !== element) {
					return false;
				}
				if (inner === null) {
					return true;
				}
				const outer = {...state, shadow: null};
				if (!context) {
					return inner.some((complex) =>
						matchComplex(complex, element, outer, false),
					);
				}
				for (
					let node: Element | null = element;
					node !== null;
					node = parentElement(node)
				) {
					if (
						inner.some((complex) => matchComplex(complex, node!, outer, false))
					) {
						return true;
					}
				}
				return false;
			});
			return;
		}
		case "nth-child":
		case "nth-last-child":
		case "nth-of-type":
		case "nth-last-of-type":
			compound.tests.push(compileNth(pseudoClass, args, compiling));
			return;
		case "lang":
			compound.tests.push(compileLang(args));
			return;
		case "dir":
			compound.tests.push(compileDir(args));
			return;
		case "heading": {
			// Bare, any heading. With arguments, a heading at one of the
			// listed levels (selectors-5 §7.4).
			if (args.length === 0) {
				compound.tests.push(
					(element) => states.getHeadingLevel(element) !== null,
				);
				return;
			}
			const levels = getIntegerArguments(args, "heading");
			compound.tests.push((element) => {
				const level = states.getHeadingLevel(element);
				return level !== null && levels.includes(level);
			});
			return;
		}
		case "state": {
			const wanted = getIdentifierArgument(args, "state");
			compound.tests.push((element) => states.hasCustomState(element, wanted));
			return;
		}
		default:
			// A pseudo-class the table leaves out names a state this user agent
			// never enters: a media element's buffering, a page box's side, a
			// spatial navigation target, and autofill.
			compound.tests.push(PSEUDO_CLASS_TESTS[name] ?? matchNothing);
	}
}

// An identifier is what the argument has to be written as: `1` is a
// number however it is read. What its escapes spell is another matter,
// and can be anything, so `a\.b` names "a.b".
const CSS_IDENTIFIER =
	/^(?:--|-?(?:[a-zA-Z_\u0080-\uFFFF]|\\[^\n]))(?:[\w\u0080-\uFFFF-]|\\[^\n])*$/;

/** The name a `::part()`, `::highlight()` or `:state()` was written with. */
function getIdentifierArgument(
	args: CSSTree.SelectorNode[],
	name: string,
): string {
	const text = args
		.map((argument) =>
			argument.type === "Raw"
				? String((argument as {value?: string}).value ?? "")
				: argument.type === "Identifier" ? String(argument.name ?? "") : " ",
		)
		.join("")
		.trim();
	if (!CSS_IDENTIFIER.test(text)) {
		throw new SelectorError(`:${name} takes one identifier`);
	}
	return CSSTree.ident.decode(text);
}

/** One or more identifiers, as `::part(option highlighted)` is written. */
function getIdentifierListArgument(
	args: CSSTree.SelectorNode[],
	name: string,
): string[] {
	const words = args
		.map((argument) =>
			argument.type === "Raw"
				? String((argument as {value?: string}).value ?? "")
				: argument.type === "Identifier" ? String(argument.name ?? "") : " ",
		)
		.join("")
		.trim()
		.split(/\s+/);
	if (!words.every((word) => CSS_IDENTIFIER.test(word))) {
		throw new SelectorError(`::${name} takes identifiers`);
	}
	return words.map((word) => CSSTree.ident.decode(word));
}

/** A comma-separated list of integers, as `:heading(1, 2)` is written. */
function getIntegerArguments(
	args: CSSTree.SelectorNode[],
	name: string,
): number[] {
	const text = args
		.map((argument) =>
			argument.type === "Raw"
				? String((argument as {value?: string}).value ?? "")
				: CSSTree.generate(argument as never),
		)
		.join("");
	const items = text.split(",").map((item) => item.trim());
	if (items.some((item) => !/^\+?\d+$/.test(item))) {
		throw new SelectorError(`:${name} takes a list of integers`);
	}
	return items.map(Number);
}

/** Drops the branches that do not parse. */
function compileForgiving(
	args: CSSTree.SelectorNode[],
	compiling: Compiling,
): CompiledComplex[] {
	const compiled: CompiledComplex[] = [];
	for (const argument of args) {
		const selectors = argument.type === "SelectorList"
			? getChildren(argument)
			: [argument];
		for (const selector of selectors) {
			if (selector.type !== "Selector") {
				continue;
			}
			try {
				compiled.push(
					compileComplex(selector, {...compiling, nested: true}, false),
				);
			} catch (_err) {
				// A forgiving selector list keeps the branches it can parse.
			}
		}
	}
	return compiled;
}

/** One bad branch invalidates the whole list. */
function compileArgumentList(
	args: CSSTree.SelectorNode[],
	compiling: Compiling,
	relative: boolean,
	anchored = false,
): CompiledComplex[] {
	const compiled: CompiledComplex[] = [];
	for (const argument of args) {
		const selectors = argument.type === "SelectorList"
			? getChildren(argument)
			: [argument];
		for (const selector of selectors) {
			if (selector.type !== "Selector") {
				throw new SelectorError("a selector list holds selectors");
			}
			compiled.push(
				compileComplex(
					selector,
					{...compiling, nested: true},
					relative,
					anchored,
				),
			);
		}
	}
	if (compiled.length === 0) {
		throw new SelectorError("a selector list selects something");
	}
	return compiled;
}

function compilePseudoElement(
	part: CSSTree.SelectorNode,
	compound: CompiledCompound,
	compiling: Compiling,
): CompiledPseudoElement {
	const name = pseudoName(String(part.name ?? ""));
	if (!PSEUDO_ELEMENTS.has(name)) {
		throw new SelectorError(`unknown pseudo-element ::${name}`);
	}
	const args = getChildren(part);
	if (!FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) {
		if (args.length !== 0) {
			throw new SelectorError(`::${name} takes no argument`);
		}
	} else if (args.length === 0) {
		throw new SelectorError(`::${name} takes an argument`);
	}
	const pseudoElement: CompiledPseudoElement = {
		name,
		argument: null,
		after: null,
	};
	if (name === "slotted") {
		const inner = compileArgumentList(args, compiling, false);
		if (!compiling.pseudoElements) {
			compound.tests.push(matchNothing);
			return pseudoElement;
		}
		// The slotted element is what the compound selects. Everything written
		// before `::slotted()` describes the slot it landed in.
		compound.originTests = compound.tests;
		compound.tests = [];
		compound.pseudoElement = pseudoElement;
		compound.origin = (element) => states.getOpenAssignedSlot(element);
		compound.tests.push(
			(element, state) =>
				states.getOpenAssignedSlot(element) !== null &&
				inner.some((complex) => matchComplex(complex, element, state, false)),
		);
		return pseudoElement;
	}
	if (name === "part") {
		const wanted = getIdentifierListArgument(args, "part");
		pseudoElement.argument = wanted.join(" ");
		if (!compiling.pseudoElements) {
			compound.tests.push(matchNothing);
			return pseudoElement;
		}
		// The part is what the compound selects. What is written before
		// `::part()` describes the host whose tree the part lives in.
		compound.originTests = compound.tests;
		compound.tests = [];
		compound.pseudoElement = pseudoElement;
		compound.origin = (element) => states.getShadowHost(getRoot(element));
		compound.tests.push((element) => {
			const names = states.getPartNames(element);
			return wanted.every((name) => names.includes(name));
		});
		return pseudoElement;
	}
	if (FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) {
		pseudoElement.argument = getIdentifierArgument(args, name);
	}
	if (name === "picker" && pseudoElement.argument !== "select") {
		throw new SelectorError("::picker names the select it belongs to");
	}
	// Every other pseudo-element names a box the tree has no node for, so a
	// query over the tree never selects one.
	compound.tests.push(matchNothing);
	return pseudoElement;
}

// The pseudo-element a style rule's selector ends with, which only
// pseudo-classes may follow, read apart from the compound it is written
// on. The rule styles that pseudo-element of what the rest selects.
function compileTrailingPseudoElement(
	part: CSSTree.SelectorNode,
	after: CSSTree.SelectorNode[],
	compiling: Compiling,
): CompiledPseudoElement {
	const pseudoElement = compilePseudoElement(part, createCompound(), {
		...compiling,
		pseudoElements: false,
	});
	if (after.length > 0) {
		pseudoElement.after = compileCompound(after, compiling);
	}
	return pseudoElement;
}

function findTrailingPseudoElement(parts: CSSTree.SelectorNode[]): number {
	let index = parts.length - 1;
	while (index >= 0 && parts[index].type === "PseudoClassSelector") {
		index--;
	}
	return index >= 0 && parts[index].type === "PseudoElementSelector"
		? index
		: -1;
}

function compileNth(
	pseudoClass: CompiledPseudoClass,
	args: CSSTree.SelectorNode[],
	compiling: Compiling,
): Predicate {
	const name = pseudoClass.name;
	const nth = args.find((argument) => argument.type === "Nth");
	if (!nth) {
		throw new SelectorError(`:${name} takes an An+B`);
	}
	const step = readAnPlusB(nth.nth ?? null);
	const filter = nth.selector
		? compileArgumentList([nth.selector], compiling, false)
		: null;
	if (filter !== null && !name.endsWith("child")) {
		throw new SelectorError(`:${name} takes no "of" selector`);
	}
	pseudoClass.args = filter ?? [];
	const fromEnd = name === "nth-last-child" || name === "nth-last-of-type";
	const ofType = name === "nth-of-type" || name === "nth-last-of-type";
	return (element, state) => {
		if (getNodeType(element) !== ELEMENT_NODE) {
			return false;
		}
		let index: number;
		let count: number;
		if (filter !== null) {
			const counted = getFilteredSiblings(element, filter, state);
			index = counted.index.get(element) ?? -1;
			count = counted.elements.length;
		} else if (ofType) {
			const siblings = getTypeSiblings(element, state);
			index = siblings.indexOf(element);
			count = siblings.length;
		} else {
			const siblings = getSiblingIndex(element, state);
			index = siblings.index.get(element) ?? -1;
			count = siblings.elements.length;
		}
		if (index === -1) {
			return false;
		}
		return matchesAnPlusB(step, (fromEnd ? count - index - 1 : index) + 1);
	};
}

interface AnPlusB {
	a: number;
	b: number;
}

function readAnPlusB(node: CSSTree.SelectorNode | null): AnPlusB {
	if (node === null) {
		throw new SelectorError("An+B is a step and an offset");
	}
	if (node.type === "Identifier") {
		const keyword = toASCIILowercase(String(node.name ?? ""));
		if (keyword === "odd") {
			return {a: 2, b: 1};
		}
		if (keyword === "even") {
			return {a: 2, b: 0};
		}
		throw new SelectorError(`${keyword} is not an An+B`);
	}
	if (node.type !== "AnPlusB") {
		throw new SelectorError("An+B is a step and an offset");
	}
	const a = node.a == null ? 0 : readStep(node.a);
	const b = node.b == null ? 0 : Number(node.b);
	if (!Number.isFinite(a) || !Number.isFinite(b)) {
		throw new SelectorError("An+B counts in whole numbers");
	}
	return {a, b};
}

// `n`, `+n` and `-n` all mean a step of one.
function readStep(text: string): number {
	const trimmed = text.trim();
	if (trimmed === "" || trimmed === "+") {
		return 1;
	}
	if (trimmed === "-") {
		return -1;
	}
	return Number(trimmed);
}

function matchesAnPlusB(step: AnPlusB, position: number): boolean {
	if (step.a === 0) {
		return position === step.b;
	}
	const times = (position - step.b) / step.a;
	return Number.isInteger(times) && times >= 0;
}

// What `:link` and `:any-link` match: an `a` or `area` with an href. A
// `link` element points somewhere too, but HTML leaves it out.
// HTML's a and area with an href, and SVG's a with an href or the older
// xlink:href.
function isHyperlink(element: Element): boolean {
	const name = getLocalName(element);
	if (getNamespace(element) === HTML_NAMESPACE) {
		return (
			(name === "a" || name === "area") &&
			getAttributeValue(element, "href") !== null
		);
	}
	return (
		getNamespace(element) === SVG_NAMESPACE &&
		name === "a" &&
		(hasAttributeByName(element, "href") ||
			element.hasAttributeNS(XLINK_NAMESPACE, "href"))
	);
}

const DISABLEABLE = new Set([
	"button",
	"fieldset",
	"input",
	"optgroup",
	"option",
	"select",
	"textarea",
]);

function isDisableable(element: Element): boolean {
	return (
		(getNamespace(element) === HTML_NAMESPACE &&
			DISABLEABLE.has(getLocalName(element))) ||
		states.isFormAssociatedCustom(element)
	);
}

function isRequirable(element: Element): boolean {
	if (getNamespace(element) !== HTML_NAMESPACE) {
		return false;
	}
	const name = getLocalName(element);
	if (name === "select" || name === "textarea") {
		return true;
	}
	if (name !== "input") {
		return false;
	}
	// The type property, which an unknown type reads as text.
	return states.REQUIRED_INPUT_TYPES.has(
		(element as unknown as {type: string}).type,
	);
}

// `:read-write`: a text control the user can type into, or anything an
// editing host contains.
function isMutable(element: Element): boolean {
	if (getNamespace(element) === HTML_NAMESPACE) {
		const name = getLocalName(element);
		if (name === "input" || name === "textarea") {
			const type = name === "input"
				? (element as unknown as {type: string}).type
				: "text";
			if (states.READONLY_INPUT_TYPES.has(type)) {
				return (
					getAttributeValue(element, "readonly") === null &&
					!states.isActuallyDisabled(element)
				);
			}
		}
	}
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		const editable = getAttributeValue(node, "contenteditable");
		if (editable === null) {
			continue;
		}
		const value = toASCIILowercase(editable);
		if (value === "" || value === "true" || value === "plaintext-only") {
			return true;
		}
		if (value === "false") {
			return false;
		}
	}
	return false;
}

// The elements `:open` and `:closed` apply to.
function canOpen(element: Element): boolean {
	if (getNamespace(element) !== HTML_NAMESPACE) {
		return false;
	}
	const name = getLocalName(element);
	return (
		name === "details" ||
		name === "dialog" ||
		name === "select" ||
		name === "input"
	);
}

function isEmpty(element: Element): boolean {
	for (
		let child = getFirstChildNode(element);
		child !== null;
		child = getNextSiblingNode(child)
	) {
		if (getNodeType(child) === ELEMENT_NODE) {
			return false;
		}
		if (
			(getNodeType(child) === TEXT_NODE ||
				getNodeType(child) === CDATA_SECTION_NODE) &&
				(child.nodeValue ?? "") !== ""
		) {
			return false;
		}
	}
	return true;
}

// RFC 4647 extended filtering: `:lang(en)` matches `en-GB`, and a `*`
// in a range matches any run of subtags.
function compileLang(args: CSSTree.SelectorNode[]): Predicate {
	const ranges: string[] = [];
	for (const argument of args) {
		if (argument.type === "Operator") {
			continue;
		}
		if (argument.type === "String") {
			ranges.push(String(argument.value ?? ""));
		} else if (argument.type === "Identifier") {
			ranges.push(CSSTree.ident.decode(String(argument.name ?? "")));
		} else if (argument.type === "Raw") {
			for (const piece of String(
				(argument as {value?: string}).value ?? "",
			).split(",")) {
				const text = piece.trim();
				if (text !== "") {
					ranges.push(CSSTree.ident.decode(text));
				}
			}
		} else {
			throw new SelectorError(":lang takes language ranges");
		}
	}
	if (ranges.length === 0) {
		throw new SelectorError(":lang takes language ranges");
	}
	const folded = ranges.map((range) => toASCIILowercase(range));
	return (element) => {
		const language = getElementLanguage(element);
		if (language === null) {
			return false;
		}
		const tag = toASCIILowercase(language);
		return folded.some((range) => rangeMatchesTag(range, tag));
	};
}

// The nearest declaration above the element.
function getLanguageParent(node: Element): Element | null {
	const parent = getParentNode(node);
	if (parent === null) {
		return null;
	}
	return isElement(parent) ? parent : states.getShadowHost(parent);
}

// The nearest lang attribute, climbing out of a shadow tree into its host
// when the tree names none (HTML §3.2.6.2).
function getElementLanguage(element: Element): string | null {
	for (
		let node: Element | null = element;
		node !== null;
		node = getLanguageParent(node)
	) {
		const attributes = getAttributeList(node);
		for (let index = 0; index < attributes.length; index++) {
			const attribute = attributes[index];
			const namespace = attribute.extra.namespace;
			if (
				attribute.extra.localName === "lang" &&
				(namespace === null || namespace === XML_NAMESPACE)
			) {
				return attribute.extra.value;
			}
		}
	}
	return null;
}

function rangeMatchesTag(range: string, tag: string): boolean {
	const wanted = range.split("-");
	const have = tag.split("-");
	if (wanted[0] !== "*" && wanted[0] !== have[0]) {
		return false;
	}
	let index = 1;
	for (let part = 1; part < wanted.length; part++) {
		const subtag = wanted[part];
		if (subtag === "*") {
			continue;
		}
		while (index < have.length && have[index].length === 1) {
			index++;
		}
		while (index < have.length && have[index] !== subtag) {
			// A range's subtag may skip over a tag's subtag, but never over a
			// singleton, which starts a private or extension sequence.
			if (have[index].length === 1) {
				return false;
			}
			index++;
		}
		if (index >= have.length) {
			return false;
		}
		index++;
	}
	return true;
}

// Elements whose text a `dir=auto` scan above them never reads.
const OPAQUE_TO_AUTO = new Set(["bdi", "script", "style", "textarea"]);

const AUTO_INPUT_TYPES = new Set([
	"email",
	"hidden",
	"password",
	"search",
	"submit",
	"text",
	"url",
]);

function compileDir(args: CSSTree.SelectorNode[]): Predicate {
	const wanted = toASCIILowercase(getIdentifierArgument(args, "dir"));
	return (element) =>
		getNodeType(element) === ELEMENT_NODE &&
		getDirectionality(element) === wanted;
}

// Per HTML: the element's own `dir`, the first strong character under a
// `dir=auto`, or the inherited direction. The first-strong scan is the
// bidirectional algorithm's own paragraph rule, so a run of spaces,
// digits or punctuation before the first letter decides nothing, which
// is the point of `dir=auto`.
export function getDirectionality(element: Element): "ltr" | "rtl" {
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		const stated = getDeclaredDirection(node);
		if (stated === "ltr" || stated === "rtl") {
			return stated;
		}
		if (stated === "auto") {
			return getAutoDirection(node);
		}
	}
	return "ltr";
}

// Includes `bdi`'s default.
function getDeclaredDirection(element: Element): "ltr" | "rtl" | "auto" | null {
	if (getNodeType(element) !== ELEMENT_NODE) {
		return null;
	}
	const html = getNamespace(element) === HTML_NAMESPACE;
	const value = toASCIILowercase(getAttributeValue(element, "dir") ?? "");
	if (html && (value === "ltr" || value === "rtl" || value === "auto")) {
		return value;
	}
	// A bdi with no direction of its own is what `dir=auto` was invented
	// for. It isolates its content and reads the direction from it.
	return html && getLocalName(element) === "bdi" ? "auto" : null;
}

function getAutoDirection(element: Element): "ltr" | "rtl" {
	if (getNamespace(element) === HTML_NAMESPACE) {
		const name = getLocalName(element);
		if (name === "input") {
			const type = toASCIILowercase(
				getAttributeValue(element, "type") ?? "text",
			);
			if (type === "tel") {
				return "ltr";
			}
			if (!AUTO_INPUT_TYPES.has(type)) {
				return "ltr";
			}
			return getFirstStrong(getAttributeValue(element, "value") ?? "");
		}
		if (name === "textarea") {
			return getFirstStrong(getTextUnder(element, true));
		}
	}
	return getFirstStrong(getTextUnder(element, false));
}

function getTextUnder(element: Element, all: boolean): string {
	let text = "";
	for (
		let child = getFirstChildNode(element);
		child !== null;
		child = getNextSiblingNode(child)
	) {
		if (
			getNodeType(child) === TEXT_NODE ||
			getNodeType(child) === CDATA_SECTION_NODE
		) {
			text += child.nodeValue ?? "";
			continue;
		}
		if (!isElement(child) || all) {
			continue;
		}
		// A child that states its own direction, and one that isolates its
		// content, both keep their text out of the scan above them.
		if (
			OPAQUE_TO_AUTO.has(getLocalName(child)) ||
			getDeclaredDirection(child) !== null
		) {
			continue;
		}
		text += getTextUnder(child, false);
	}
	return text;
}

function getFirstStrong(text: string): "ltr" | "rtl" {
	if (text === "") {
		return "ltr";
	}
	const {paragraphs} = bidi.getEmbeddingLevels(text);
	const paragraph = paragraphs[0];
	return paragraph && (paragraph.level & 1) === 1 ? "rtl" : "ltr";
}

// Matches right to left.
function matchComplex(
	complex: CompiledComplex,
	element: Element,
	state: MatchState,
	featureless: boolean,
): boolean {
	return matchFrom(
		complex,
		complex.compounds.length - 1,
		element,
		state,
		featureless,
	);
}

// The element the compound describes when it matches, which the
// combinator to its left steps from, or null.
function matchCompound(
	compound: CompiledCompound,
	element: Element,
	state: MatchState,
	featureless: boolean,
): Element | null {
	if (featureless && !compound.host) {
		return null;
	}
	if (getNodeType(element) !== ELEMENT_NODE) {
		return null;
	}
	const tests = compound.tests;
	for (let at = 0; at < tests.length; at++) {
		if (!tests[at](element, state)) {
			return null;
		}
	}
	if (compound.origin === null) {
		return element;
	}
	const origin = compound.origin(element, state);
	if (origin === null) {
		return null;
	}
	const originTests = compound.originTests;
	for (let at = 0; at < originTests.length; at++) {
		if (!originTests[at](origin, state)) {
			return null;
		}
	}
	return origin;
}

function matchFrom(
	complex: CompiledComplex,
	index: number,
	element: Element,
	state: MatchState,
	featureless: boolean,
): boolean {
	const subject = matchCompound(
		complex.compounds[index],
		element,
		state,
		featureless,
	);
	if (subject === null) {
		return false;
	}
	if (index === 0) {
		return true;
	}
	const combinator = complex.combinators[index - 1];
	switch (combinator) {
		case ">": {
			const step = getParentStep(subject, state);
			return (
				step !== null &&
				matchFrom(complex, index - 1, step.element, state, step.featureless)
			);
		}
		case "+": {
			const sibling = getPreviousElement(subject);
			return (
				sibling !== null && matchFrom(complex, index - 1, sibling, state, false)
			);
		}
		case "~": {
			for (
				let sibling = getPreviousElement(subject);
				sibling !== null;
				sibling = getPreviousElement(sibling)
			) {
				if (matchFrom(complex, index - 1, sibling, state, false)) {
					return true;
				}
			}
			return false;
		}
		default: {
			for (
				let step = getParentStep(subject, state);
				step !== null;
				step = getParentStep(step.element, state)
			) {
				if (
					matchFrom(complex, index - 1, step.element, state, step.featureless)
				) {
					return true;
				}
			}
			return false;
		}
	}
}

// In a shadow tree the step up ends at the featureless host. Nothing above
// the host is in the tree the selector was written for.
function getParentStep(
	element: Element,
	state: MatchState,
): {element: Element; featureless: boolean} | null {
	if (state.shadow !== null && states.getShadowHost(state.shadow) === element) {
		return null;
	}
	const parent = getParentNode(element);
	if (parent === null) {
		return null;
	}
	if (isElement(parent)) {
		return {element: parent, featureless: false};
	}
	// A selector written in a shadow tree can reach the host above it, and
	// the host is featureless. Only `:host` and its two functional forms can
	// match it.
	if (state.shadow !== null && parent === state.shadow) {
		const host = states.getShadowHost(parent);
		return host === null ? null : {element: host, featureless: true};
	}
	return null;
}

// The search space is the anchor's subtree for a selector reaching
// down, and its following siblings' subtrees for one reaching across.
// That is why `li:has(~ li.x)` never counts the `li.x` it was asked
// about.
function hasMatch(
	inner: CompiledComplex[],
	element: Element,
	state: MatchState,
	cacheable: boolean,
): boolean {
	// Asked of the host from inside its shadow tree, :has() searches that
	// tree, and the answer is not the one a light-tree rule would get.
	const hostOfShadow =
		state.shadow !== null && states.getShadowHost(state.shadow) === element;
	const store = cacheable && !hostOfShadow ? state.hasResults : null;
	let answers = store?.get(element);
	const known = answers?.get(inner);
	if (known !== undefined) {
		return known;
	}
	const result = findHasMatch(inner, element, state);
	if (store) {
		if (answers === undefined) {
			answers = new Map();
			store.set(element, answers);
		}
		answers.set(inner, result);
	}
	return result;
}

function findHasMatch(
	inner: CompiledComplex[],
	element: Element,
	state: MatchState,
): boolean {
	// The anchor is what a leading combinator hangs from. `:scope` is not
	// changed: inside `:has()` it still refers to whatever the query scoped
	// to.
	const inside: MatchState = {...state, anchor: element};
	const hostOfShadow =
		state.shadow !== null && states.getShadowHost(state.shadow) === element;
	for (const complex of inner) {
		const selects = (node: Element): boolean =>
			matchComplex(complex, node, inside, false);
		const leading = complex.combinators[0] ?? " ";
		if (hostOfShadow) {
			// The host is the shadow tree's root, which has no siblings.
			if (
				leading !== "+" &&
				leading !== "~" &&
				walkElements(state.shadow as Node, selects)
			) {
				return true;
			}
		} else if (leading === "+" || leading === "~") {
			for (
				let sibling = getNextElement(element);
				sibling !== null;
				sibling = getNextElement(sibling)
			) {
				if (selects(sibling) || walkElements(sibling, selects)) {
					return true;
				}
			}
		} else if (walkElements(element, selects)) {
			return true;
		}
	}
	return false;
}

export interface SiblingIndex {
	elements: Element[];
	index: Map<Element, number>;
	byType: Map<string, Element[]>;
}

interface FilteredSiblings {
	elements: Element[];
	index: Map<Element, number>;
	// What `:scope` and a relative selector meant when it was filtered.
	scope: Node | null;
	anchor: Node | null;
}

function getSiblingIndex(element: Element, state: MatchState): SiblingIndex {
	const parent = getParentNode(element);
	const key = parent ?? element;
	let siblings = state.siblings.get(key);
	if (siblings === undefined) {
		const elements = parent === null ? [element] : getElementChildren(parent);
		siblings = {
			elements,
			index: new Map(elements.map((child, i) => [child, i])),
			byType: new Map(),
		};
		state.siblings.set(key, siblings);
	}
	return siblings;
}

// The element's siblings that match an `of S` list, in order.
function getFilteredSiblings(
	element: Element,
	filter: CompiledComplex[],
	state: MatchState,
): FilteredSiblings {
	const siblings = getSiblingIndex(element, state);
	let filtered = state.filteredSiblings.get(siblings);
	if (filtered === undefined) {
		filtered = new Map();
		state.filteredSiblings.set(siblings, filtered);
	}
	let counted = filtered.get(filter);
	if (
		counted === undefined ||
		counted.scope !== state.scope ||
		counted.anchor !== state.anchor
	) {
		const elements = siblings.elements.filter((sibling) =>
			filter.some((complex) => matchComplex(complex, sibling, state, false)),
		);
		counted = {
			elements,
			index: new Map(elements.map((child, i) => [child, i])),
			scope: state.scope,
			anchor: state.anchor,
		};
		filtered.set(filter, counted);
	}
	return counted;
}

// The siblings of the element's type and namespace, in order.
function getTypeSiblings(element: Element, state: MatchState): Element[] {
	const siblings = getSiblingIndex(element, state);
	const key = `${getNamespace(element) ?? ""}|${getLocalName(element)}`;
	let ofType = siblings.byType.get(key);
	if (ofType === undefined) {
		ofType = siblings.elements.filter(
			(sibling) =>
				getLocalName(sibling) === getLocalName(element) &&
				getNamespace(sibling) === getNamespace(element),
		);
		siblings.byType.set(key, ofType);
	}
	return ofType;
}

function getPreviousElement(element: Element): Element | null {
	for (let node = getPreviousSiblingNode(element);
		node !== null;
		node = getPreviousSiblingNode(node)) {
		if (isElement(node)) {
			return node;
		}
	}
	return null;
}

function getNextElement(element: Element): Element | null {
	for (let node = getNextSiblingNode(element);
		node !== null;
		node = getNextSiblingNode(node)) {
		if (isElement(node)) {
			return node;
		}
	}
	return null;
}

function getOfTypeIndex(
	element: Element,
	fromEnd: boolean,
	state: MatchState,
): number {
	const siblings = getTypeSiblings(element, state);
	const index = siblings.indexOf(element);
	if (index === -1) {
		return 0;
	}
	return fromEnd ? siblings.length - index : index + 1;
}

// Keyed by text and the namespaces it was compiled against. A selector
// is compiled once and matched against everything.
const compiled = new Map<string, CompiledSelector | SelectorError>();

function getCacheKey(text: string, options: CompileOptions): string {
	const namespaces = options.namespaces;
	const map = namespaces == null
		? "-"
		: [...namespaces.prefixes]
			.map(([prefix, uri]) => `${prefix}=${uri}`)
			.sort()
			.join(" ");
	return `${namespaces?.default ?? ""} ${map} ${
		options.pseudoElements ? "p" : ""
	}${options.relative ? "r" : ""}${options.nesting ? "n" : ""} ${text}`;
}

/**
 * Throws a SelectorError for anything this engine rejects. The result is
 * cached, and so is the rejection.
 */
export function compileSelector(
	text: string,
	options: CompileOptions = {},
): CompiledSelector {
	const key = getCacheKey(text, options);
	let entry = compiled.get(key);
	if (entry === undefined) {
		try {
			const list = parseSelectorAST(text);
			if (list === null) {
				throw new SelectorError(`'${text}' is not a selector`);
			}
			entry = compileList(list, options);
		} catch (error) {
			entry = error instanceof SelectorError
				? error
				: new SelectorError(String((error as Error).message));
		}
		if (compiled.size > 16384) {
			compiled.clear();
		}
		compiled.set(key, entry);
	}
	if (entry instanceof SelectorError) {
		throw entry;
	}
	return entry;
}

interface MatchOptions {

	// The node `:scope` refers to.
	scope?: Node | null;

	// The shadow root the selector was written in, for `:host`.
	shadow?: Node | null;

	// Where `:has()` answers are kept between matches, by a caller that
	// drops them whenever the document changes.
	hasResults?: HasResults | null;

	// Where each parent's children are kept between matches, by a caller
	// that drops them whenever the tree changes.
	siblings?: SiblingIndexes | null;

	// Where the siblings `of S` lists keep are, by a caller that drops them
	// whenever the document changes.
	filteredSiblings?: FilteredSiblingIndexes | null;
}

interface QueryOptions extends CompileOptions, MatchOptions {}

function createMatchState(options: MatchOptions): MatchState {
	return {
		scope: options.scope ?? null,
		shadow: options.shadow ?? null,
		// A relative selector hangs from the scoping root, which is also what
		// `:scope` refers to. Inside `:has()` both become the anchor instead.
		anchor: options.scope ?? null,
		siblings: options.siblings ?? new WeakMap(),
		filteredSiblings: options.filteredSiblings ?? new WeakMap(),
		hasResults: options.hasResults ?? null,
	};
}

function matchesAny(
	selector: CompiledSelector,
	element: Element,
	state: MatchState,
): boolean {
	const list = selector.list;
	for (let index = 0; index < list.length; index++) {
		if (matchComplex(list[index], element, state, false)) {
			return true;
		}
	}
	return false;
}

export function matchesCompiled(
	element: Element,
	selector: CompiledSelector,
	options: MatchOptions = {},
): boolean {
	return matchesAny(selector, element, createMatchState(options));
}

/** Whether the element matches one compound, with no combinator. */
export function matchesCompound(
	element: Element,
	compound: CompiledCompound,
	options: MatchOptions = {},
): boolean {
	return matchCompound(compound, element, createMatchState(options), false) !==
		null;
}

/** In tree order. */
export function selectAllCompiled(
	root: Node,
	selector: CompiledSelector,
	options: MatchOptions = {},
): Element[] {
	const state = createMatchState(options);
	const found: Element[] = [];
	walkElements(root, (element) => {
		if (matchesAny(selector, element, state)) {
			found.push(element);
		}
		return false;
	});
	return found;
}

export function matchesSelector(
	element: Element,
	text: string,
	options: QueryOptions = {},
): boolean {
	return matchesCompiled(element, compileSelector(text, options), options);
}

export function selectAll(
	root: Node,
	text: string,
	options: QueryOptions = {},
): Element[] {
	return selectAllCompiled(root, compileSelector(text, options), options);
}

export function selectFirst(
	root: Node,
	text: string,
	options: QueryOptions = {},
): Element | null {
	const selector = compileSelector(text, options);
	const state = createMatchState(options);
	let first: Element | null = null;
	walkElements(root, (element) => {
		if (matchesAny(selector, element, state)) {
			first = element;
			return true;
		}
		return false;
	});
	return first;
}

export function closestSelector(
	element: Element,
	text: string,
	options: QueryOptions = {},
): Element | null {
	const selector = compileSelector(text, options);
	const state = createMatchState(options);
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		if (matchesAny(selector, node, state)) {
			return node;
		}
	}
	return null;
}

// The walk follows the links a node already has rather than recursing,
// so a deep tree costs no stack and a wide one allocates nothing.
function walkElements(
	root: Node,
	visit: (element: Element) => boolean,
): boolean {
	for (
		let node = nextInTree(root, root);
		node !== null;
		node = nextInTree(node, root)
	) {
		if (isElement(node) && visit(node)) {
			return true;
		}
	}
	return false;
}
