import bidiFactory from "bidi-js";
import * as CSSTree from "css-tree";

import {
	type Element,
	getElementChildren,
	getFirstChildNode,
	getNextSiblingNode,
	getOpenAssignedSlot,
	getParentNode,
	getPartNames,
	getPreviousSiblingNode,
	getRoot,
	getShadowHost,
	hasCustomState,
	hasFocus,
	hasFocusWithin,
	isActuallyDisabled,
	isCheckedControl,
	isDefaultControl,
	isDefinedElement,
	isElement,
	isFocusVisible,
	isFormAssociatedCustom,
	isFullscreenElement,
	isHovered,
	isHTMLNode,
	isIndeterminateControl,
	isInQuirksMode,
	isModalDialog,
	isOpenElement,
	isPlaceholderShown,
	isShowingPopover,
	isTargetElement,
	nextInTree,
	Node,
	parentElement,
} from "./dom.ts";
import {HTML_NAMESPACE, XML_NAMESPACE} from "./dom.ts";
import {toASCIILowercase} from "./text.ts";

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

const PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
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
	"indeterminate",
	"invalid",
	"last-child",
	"last-of-type",
	"left",
	"link",
	"local-link",
	"modal",
	"muted",
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
	return CSSTree.ident.decode(name).toLowerCase();
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
	siblings: Map<Node, SiblingIndex>;

	// The node `:scope` refers to, or null when the selector uses none.
	scope: Node | null;

	// The shadow root the selector was written inside, for `:host`.
	shadow: Node | null;

	// The node a relative selector inside `:has()` is anchored to.
	anchor: Node | null;
}

type Predicate = (element: Element, state: MatchState) => boolean;

type Combinator = " " | ">" | "+" | "~";

interface CompiledCompound {

	tests: Predicate[];

	// The element the compound really describes, when a pseudo-element
	// moves the subject. `slot::slotted(span)` selects the span and
	// describes the slot. `host::part(x)` selects the part and describes the
	// host. The combinator to the left steps from what this returns.
	origin: ((element: Element, state: MatchState) => Element | null) | null;

	originTests: Predicate[];

	// May match a featureless shadow host.
	host: boolean;
}

interface CompiledComplex {
	compounds: CompiledCompound[];

	// Joins compound `index` to compound `index + 1`.
	combinators: Combinator[];
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
	if (list === null) {
		return null;
	}
	try {
		compileSelector(text, GRAMMAR_ONLY);
	} catch (_err) {
		return null;
	}
	return list;
}

interface CompileOptions {

	// Null leaves the prefixes unresolved: the selector is checked for
	// shape and every prefix is accepted. A grammar check wants that; a
	// match does not.
	namespaces?: SelectorNamespaces | null;

	// The DOM's own query methods accept `a::before` and match nothing with
	// it. The cascade, which matches `::slotted()` and `::part()` for real,
	// sets this.
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

function compileComplex(
	selector: CSSTree.SelectorNode,
	compiling: Compiling,
	relative: boolean,
): CompiledComplex {
	const parts = getChildren(selector);
	if (parts.length === 0) {
		throw new SelectorError("a selector selects something");
	}
	const compounds: CompiledCompound[] = [];
	const combinators: Combinator[] = [];
	let pending: CSSTree.SelectorNode[] = [];
	let started = false;
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
	if (pending.length === 0) {
		throw new SelectorError("a combinator joins two compounds");
	}
	compounds.push(compileCompound(pending, compiling));
	return {compounds, combinators};
}

// The compound a relative selector hangs from: the element `:has()` was
// asked about.
const ANCHOR_COMPOUND: CompiledCompound = {
	tests: [
		(element: Element, state: MatchState): boolean =>
			element === state.anchor,
	],
	origin: null,
	originTests: [],
	host: false,
};

function compileCompound(
	parts: CSSTree.SelectorNode[],
	compiling: Compiling,
): CompiledCompound {
	const compound: CompiledCompound = {
		tests: [],
		origin: null,
		originTests: [],
		host: false,
	};
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
		compound.tests.push((element) => element.namespaceURI === declared);
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
			compound.tests.push(compileType(String(part.name ?? ""), compiling));
			return;
		case "IdSelector": {
			const id = CSSTree.ident.decode(String(part.name ?? ""));
			if (id === "") {
				throw new SelectorError("an id selector names an id");
			}
			const folded = toASCIILowercase(id);
			compound.tests.push((element) => {
				const value = element.getAttribute("id");
				if (value === null) {
					return false;
				}
				return isInQuirksMode(element)
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
			const folded = toASCIILowercase(name);
			compound.tests.push((element) => {
				const value = element.getAttribute("class");
				if (value === null) {
					return false;
				}
				const quirks = isInQuirksMode(element);
				for (const token of splitOnWhitespace(value)) {
					if (quirks ? toASCIILowercase(token) === folded : token === name) {
						return true;
					}
				}
				return false;
			});
			return;
		}
		case "AttributeSelector":
			compound.tests.push(compileAttribute(part, compiling));
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
function compileType(name: string, compiling: Compiling): Predicate {
	const {namespace, local} = qualifiedName(name, compiling.namespaces, false);
	const folded = local === null ? null : toASCIILowercase(local);
	return (element) => {
		if (element.nodeType !== Node.ELEMENT_NODE) {
			return false;
		}
		if (namespace !== undefined && element.namespaceURI !== namespace) {
			return false;
		}
		if (local === null) {
			return true;
		}
		if (element.localName === local) {
			return true;
		}
		return (
			element.namespaceURI === HTML_NAMESPACE &&
			isHTMLNode(element) &&
			toASCIILowercase(element.localName) === folded
		);
	};
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
	compiling: Compiling,
): Predicate {
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
	const flags = part.flags == null ? "" : toASCIILowercase(String(part.flags));
	if (flags !== "" && flags !== "i" && flags !== "s") {
		throw new SelectorError(`unknown attribute flag ${flags}`);
	}
	// Read the attribute the way HTML reads a name. An HTML element in an
	// HTML document lowercases its attribute names.
	const read = (element: Element): string | null => {
		const fold = element.namespaceURI === HTML_NAMESPACE && isHTMLNode(element);
		const attributes = element.attributes;
		for (let index = 0; index < attributes.length; index++) {
			const attribute = attributes[index];
			if (namespace !== undefined && attribute.namespaceURI !== namespace) {
				continue;
			}
			const name = attribute.localName;
			if (name === local || (fold && toASCIILowercase(name) === folded)) {
				return attribute.value;
			}
		}
		return null;
	};
	const operator = part.matcher ?? null;
	if (operator === null) {
		return (element) => read(element) !== null;
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
	return (element) => {
		const value = read(element);
		if (value === null) {
			return false;
		}
		const insensitive =
			flags === "i" ||
			(flags === "" &&
				element.namespaceURI === HTML_NAMESPACE &&
				isHTMLNode(element) &&
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
				return splitOnWhitespace(subject).includes(target);
			case "|=":
				return subject === target || subject.startsWith(`${target}-`);
			case "^=":
				return target !== "" && subject.startsWith(target);
			case "$=":
				return target !== "" && subject.endsWith(target);
			default:
				return target !== "" && subject.includes(target);
		}
	};
}

function compilePseudoClass(
	part: CSSTree.SelectorNode,
	compound: CompiledCompound,
	compiling: Compiling,
): void {
	const name = pseudoName(String(part.name ?? ""));
	const args = getChildren(part);
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
			compound.tests.push((element, state) =>
				inner.some((complex) => matchComplex(complex, element, state, false)),
			);
			return;
		}
		case "not": {
			const inner = compileArgumentList(args, compiling, false);
			compound.tests.push(
				(element, state) =>
					!inner.some((complex) =>
						matchComplex(complex, element, state, false),
					),
			);
			return;
		}
		case "has": {
			const inner = compileArgumentList(args, compiling, true);
			compound.tests.push((element, state) => hasMatch(inner, element, state));
			return;
		}
		case "host":
		case "host-context": {
			compound.host = true;
			const inner = args.length === 0
				? null
				: compileArgumentList(args, compiling, false);
			const context = name === "host-context";
			compound.tests.push((element, state) => {
				const shadow = state.shadow;
				if (shadow === null || getShadowHost(shadow) !== element) {
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
		case "scope":
			compound.tests.push((element, state) => element === state.scope);
			return;
		case "root":
			compound.tests.push((element) => {
				const parent = getParentNode(element);
				return parent !== null && parent.nodeType === Node.DOCUMENT_NODE;
			});
			return;
		case "empty":
			compound.tests.push(isEmpty);
			return;
		case "first-child":
			compound.tests.push((element) => getPreviousElement(element) === null);
			return;
		case "last-child":
			compound.tests.push((element) => getNextElement(element) === null);
			return;
		case "only-child":
			compound.tests.push(
				(element) =>
					getPreviousElement(element) === null &&
					getNextElement(element) === null,
			);
			return;
		case "first-of-type":
			compound.tests.push(
				(element, state) => getOfTypeIndex(element, false, state) === 1,
			);
			return;
		case "last-of-type":
			compound.tests.push(
				(element, state) => getOfTypeIndex(element, true, state) === 1,
			);
			return;
		case "only-of-type":
			compound.tests.push(
				(element, state) =>
					getOfTypeIndex(element, false, state) === 1 &&
					getOfTypeIndex(element, true, state) === 1,
			);
			return;
		case "nth-child":
		case "nth-last-child":
		case "nth-of-type":
		case "nth-last-of-type":
			compound.tests.push(compileNth(name, args, compiling));
			return;
		case "lang":
			compound.tests.push(compileLang(args));
			return;
		case "dir":
			compound.tests.push(compileDir(args));
			return;
		case "state": {
			const wanted = getIdentifierArgument(args, "state");
			compound.tests.push((element) => hasCustomState(element, wanted));
			return;
		}
		case "link":
		case "any-link":
			compound.tests.push(isHyperlink);
			return;
		case "visited":
			// A terminal has never recorded a visited link, and answering would
			// leak history even if it had.
			compound.tests.push(matchNothing);
			return;
		case "target":
			compound.tests.push((element) => isTargetElement(element));
			return;
		case "hover":
			compound.tests.push((element) => isHovered(element));
			return;
		case "active":
			// Nothing here is ever between a press and a release. A terminal
			// reports the key or the click, not half of it.
			compound.tests.push(() => false);
			return;
		case "focus":
			compound.tests.push((element) => hasFocus(element));
			return;
		case "focus-visible":
			compound.tests.push((element) => isFocusVisible(element));
			return;
		case "focus-within":
			compound.tests.push((element) => hasFocusWithin(element));
			return;
		case "modal":
			compound.tests.push((element) => isModalDialog(element));
			return;
		case "popover-open":
			compound.tests.push((element) => isShowingPopover(element));
			return;
		case "fullscreen":
			compound.tests.push((element) => isFullscreenElement(element));
			return;
		case "defined":
			compound.tests.push((element) => isDefinedElement(element));
			return;
		case "open":
			compound.tests.push((element) => isOpenElement(element));
			return;
		case "closed":
			compound.tests.push(
				(element) => canOpen(element) && !isOpenElement(element),
			);
			return;
		case "checked":
			compound.tests.push((element) => isCheckedControl(element));
			return;
		case "indeterminate":
			compound.tests.push((element) => isIndeterminateControl(element));
			return;
		case "placeholder-shown":
			compound.tests.push((element) => isPlaceholderShown(element));
			return;
		case "default":
			compound.tests.push((element) => isDefaultControl(element));
			return;
		case "disabled":
			compound.tests.push(isDisabled);
			return;
		case "enabled":
			compound.tests.push(
				(element, state) => isDisableable(element) &&
					!isDisabled(element, state),
			);
			return;
		case "required":
			compound.tests.push((element) =>
				isRequirable(element) && element.getAttribute("required") !== null);
			return;
		case "optional":
			compound.tests.push((element) =>
				isRequirable(element) && element.getAttribute("required") === null);
			return;
		case "read-only":
			compound.tests.push((element, state) => !isMutable(element, state));
			return;
		case "read-write":
			compound.tests.push(isMutable);
			return;
		default:
			// Everything left names a state this user agent never enters: a
			// media element's buffering, a page box's side, a spatial
			// navigation target, autofill, and the constraint validation
			// family, which the conformance notes record as deliberately
			// absent.
			compound.tests.push(matchNothing);
	}
}

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
	if (!/^(?:[\w\u0080-\uFFFF-]|\\[^\n])+$/.test(text)) {
		throw new SelectorError(`:${name} takes one identifier`);
	}
	// The escapes spell the name, and the name has to be an identifier. `1`
	// is a number however it is written.
	const identifier = CSSTree.ident.decode(text);
	if (!/^[a-zA-Z_\u0080-\uFFFF-][\w\u0080-\uFFFF-]*$/.test(identifier)) {
		throw new SelectorError(`:${name} takes one identifier`);
	}
	return identifier;
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
				compileComplex(selector, {...compiling, nested: true}, relative),
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
): void {
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
	if (name === "slotted") {
		const inner = compileArgumentList(args, compiling, false);
		if (!compiling.pseudoElements) {
			compound.tests.push(matchNothing);
			return;
		}
		// The slotted element is what the compound selects. Everything written
		// before `::slotted()` describes the slot it landed in.
		compound.originTests = compound.tests;
		compound.tests = [];
		compound.origin = (element) => getOpenAssignedSlot(element);
		compound.tests.push(
			(element, state) =>
				getOpenAssignedSlot(element) !== null &&
				inner.some((complex) => matchComplex(complex, element, state, false)),
		);
		return;
	}
	if (name === "part") {
		const wanted = getIdentifierArgument(args, "part");
		if (!compiling.pseudoElements) {
			compound.tests.push(matchNothing);
			return;
		}
		// The part is what the compound selects. What is written before
		// `::part()` describes the host whose tree the part lives in.
		compound.originTests = compound.tests;
		compound.tests = [];
		compound.origin = (element) => getShadowHost(getRoot(element));
		compound.tests.push((element) => getPartNames(element).includes(wanted));
		return;
	}
	if (name === "picker") {
		const argument = getIdentifierArgument(args, "picker");
		if (argument !== "select") {
			throw new SelectorError("::picker names the select it belongs to");
		}
	} else if (FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) {
		getIdentifierArgument(args, name);
	}
	// Every other pseudo-element names a box the tree has no node for, so a
	// query over the tree never selects one.
	compound.tests.push(matchNothing);
}

function compileNth(
	name: string,
	args: CSSTree.SelectorNode[],
	compiling: Compiling,
): Predicate {
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
	const fromEnd = name === "nth-last-child" || name === "nth-last-of-type";
	const ofType = name === "nth-of-type" || name === "nth-last-of-type";
	return (element, state) => {
		if (element.nodeType !== Node.ELEMENT_NODE) {
			return false;
		}
		// The plain forms read the element's place in a list built once per
		// parent. An `of S` list is filtered per candidate, since which
		// siblings match S is not known until each is tried.
		let index: number;
		let count: number;
		if (filter !== null) {
			const counted = getSiblingIndex(element, state).elements.filter(
				(sibling) =>
					filter.some((complex) =>
						matchComplex(complex, sibling, state, false),
					),
			);
			index = counted.indexOf(element);
			count = counted.length;
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
function isHyperlink(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
	return (
		(name === "a" || name === "area") && element.getAttribute("href") !== null
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
		(element.namespaceURI === HTML_NAMESPACE &&
			DISABLEABLE.has(element.localName)) || isFormAssociatedCustom(element)
	);
}

// The selector matches what HTML calls actually disabled.
function isDisabled(element: Element, _state: MatchState): boolean {
	return isActuallyDisabled(element);
}

const UNREQUIRABLE_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"hidden",
	"image",
	"range",
	"reset",
	"submit",
]);

function isRequirable(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
	if (name === "select" || name === "textarea") {
		return true;
	}
	if (name !== "input") {
		return false;
	}
	const type = toASCIILowercase(element.getAttribute("type") ?? "text");
	return !UNREQUIRABLE_INPUT_TYPES.has(type);
}

const IMMUTABLE_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"hidden",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

// `:read-write`: a text control the user can type into, or anything an
// editing host contains.
function isMutable(element: Element, state: MatchState): boolean {
	if (element.namespaceURI === HTML_NAMESPACE) {
		const name = element.localName;
		if (name === "input" || name === "textarea") {
			const type = name === "input"
				? toASCIILowercase(element.getAttribute("type") ?? "text")
				: "text";
			if (!IMMUTABLE_INPUT_TYPES.has(type)) {
				return (
					element.getAttribute("readonly") === null &&
					!isDisabled(element, state)
				);
			}
		}
	}
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		const editable = node.getAttribute("contenteditable");
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
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
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
		if (child.nodeType === Node.ELEMENT_NODE) {
			return false;
		}
		if (
			(child.nodeType === Node.TEXT_NODE ||
				child.nodeType === Node.CDATA_SECTION_NODE) &&
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
function getElementLanguage(element: Element): string | null {
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		const attributes = node.attributes;
		for (let index = 0; index < attributes.length; index++) {
			const attribute = attributes[index];
			if (
				attribute.localName === "lang" &&
				(attribute.namespaceURI === null ||
					attribute.namespaceURI === XML_NAMESPACE)
			) {
				return attribute.value;
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

const bidi = bidiFactory();

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
		element.nodeType === Node.ELEMENT_NODE &&
		getDirectionality(element) === wanted;
}

// Per HTML: the element's own `dir`, the first strong character under a
// `dir=auto`, or the inherited direction. The first-strong scan is the
// bidirectional algorithm's own paragraph rule, so a run of spaces,
// digits or punctuation before the first letter decides nothing, which
// is the point of `dir=auto`.
function getDirectionality(element: Element): "ltr" | "rtl" {
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
	if (element.nodeType !== Node.ELEMENT_NODE) {
		return null;
	}
	const html = element.namespaceURI === HTML_NAMESPACE;
	const value = toASCIILowercase(element.getAttribute("dir") ?? "");
	if (html && (value === "ltr" || value === "rtl" || value === "auto")) {
		return value;
	}
	// A bdi with no direction of its own is what `dir=auto` was invented
	// for. It isolates its content and reads the direction from it.
	return html && element.localName === "bdi" ? "auto" : null;
}

function getAutoDirection(element: Element): "ltr" | "rtl" {
	if (element.namespaceURI === HTML_NAMESPACE) {
		const name = element.localName;
		if (name === "input") {
			const type = toASCIILowercase(element.getAttribute("type") ?? "text");
			if (type === "tel") {
				return "ltr";
			}
			if (!AUTO_INPUT_TYPES.has(type)) {
				return "ltr";
			}
			return getFirstStrong(element.getAttribute("value") ?? "");
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
			child.nodeType === Node.TEXT_NODE ||
			child.nodeType === Node.CDATA_SECTION_NODE
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
			OPAQUE_TO_AUTO.has(child.localName) ||
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

function matchFrom(
	complex: CompiledComplex,
	index: number,
	element: Element,
	state: MatchState,
	featureless: boolean,
): boolean {
	const compound = complex.compounds[index];
	if (featureless && !compound.host) {
		return false;
	}
	if (element.nodeType !== Node.ELEMENT_NODE) {
		return false;
	}
	for (const test of compound.tests) {
		if (!test(element, state)) {
			return false;
		}
	}
	let subject = element;
	if (compound.origin !== null) {
		const origin = compound.origin(element, state);
		if (origin === null) {
			return false;
		}
		for (const test of compound.originTests) {
			if (!test(origin, state)) {
				return false;
			}
		}
		subject = origin;
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

// In a shadow tree the step up ends at the featureless host.
function getParentStep(
	element: Element,
	state: MatchState,
): {element: Element; featureless: boolean} | null {
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
		const host = getShadowHost(parent);
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
): boolean {
	// The anchor is what a leading combinator hangs from. `:scope` is not
	// changed: inside `:has()` it still refers to whatever the query scoped
	// to.
	const inside: MatchState = {...state, anchor: element};
	for (const complex of inner) {
		const selects = (node: Element): boolean =>
			matchComplex(complex, node, inside, false);
		const leading = complex.combinators[0] ?? " ";
		if (leading === "+" || leading === "~") {
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

interface SiblingIndex {
	elements: Element[];
	index: Map<Element, number>;
	byType: Map<string, Element[]>;
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

// The siblings of the element's type and namespace, in order.
function getTypeSiblings(element: Element, state: MatchState): Element[] {
	const siblings = getSiblingIndex(element, state);
	const key = `${element.namespaceURI ?? ""}|${element.localName}`;
	let ofType = siblings.byType.get(key);
	if (ofType === undefined) {
		ofType = siblings.elements.filter(
			(sibling) =>
				sibling.localName === element.localName &&
				sibling.namespaceURI === element.namespaceURI,
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

function splitOnWhitespace(text: string): string[] {
	return text.split(/[\t\n\f\r ]+/).filter((token) => token !== "");
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
		if (compiled.size > 1024) {
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
}

interface QueryOptions extends CompileOptions, MatchOptions {}

function createMatchState(options: MatchOptions): MatchState {
	return {
		scope: options.scope ?? null,
		shadow: options.shadow ?? null,
		// A relative selector hangs from the scoping root, which is also what
		// `:scope` refers to. Inside `:has()` both become the anchor instead.
		anchor: options.scope ?? null,
		siblings: new Map(),
	};
}

function matchesAny(
	selector: CompiledSelector,
	element: Element,
	state: MatchState,
): boolean {
	return selector.list.some((complex) =>
		matchComplex(complex, element, state, false),
	);
}

export function matchesCompiled(
	element: Element,
	selector: CompiledSelector,
	options: MatchOptions = {},
): boolean {
	return matchesAny(selector, element, createMatchState(options));
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
