/**
 * CSS Selectors: the language, and the matcher a selector compiles into.
 *
 * A selector arrives as text, is parsed by css-tree, checked against the
 * pseudo-classes and pseudo-elements this engine knows, and compiled into one
 * closure per compound selector. The closures read a node's own structure --
 * its local name, its namespace, its attributes, its links to parent and
 * siblings -- and ask a resolver for everything the tree cannot say: which
 * element the pointer is over, which one has focus, what a shadow root's host
 * is, whether a dialog is modal.
 *
 * Nothing of the engine is here at run time: the DOM's node types are imported
 * for their shape alone. The resolver is the whole of what a matcher knows
 * about the document around it, so a headless tree matches through the same
 * code as one being painted, and a bug in a pseudo-class is a bug in one
 * function rather than in a string of generated source. The two libraries it
 * does import are the ones that read text: css-tree for the selector, and
 * bidi-js for the first strong character `:dir(auto)` turns on.
 *
 * Matching runs right to left, from the subject compound outwards, which is
 * what makes a long descendant selector cheap: the first compound that fails
 * ends the walk.
 */

import * as CSSTree from "css-tree";
import bidiFactory from "bidi-js";
// Types only, so nothing of the DOM is here at run time and the import that
// reads this module back is the only one either file makes.
import type {Element, Node} from "./dom.js";

/* ------------------------------------------------------------- the grammar */

/**
 * The pseudo-classes and pseudo-elements a selector may name. A selector
 * naming anything else does not parse, which is what makes `:gibberish`
 * invalid rather than merely unmatched.
 */
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

/**
 * The pseudo-elements whose selector takes an argument, and so are written
 * only in functional form -- `::part(name)`, never a bare `::part`.
 */
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

/** The pseudo-elements that may also be written with one colon, from CSS 2. */
export const LEGACY_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
	"after",
	"before",
	"first-letter",
	"first-line",
]);

/** The pseudo-classes that take no argument at all. */
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

/** A selector AST node, as the CSS parser hands it over. */
export interface SelectorNode {
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

export function getChildren(node: SelectorNode): SelectorNode[] {
	const children = node.children;
	if (!children) {
		return [];
	}
	return Array.isArray(children) ? children : children.toArray();
}

/**
 * A pseudo's name as it is compared and serialized: the identifier the source
 * escapes spell, ASCII-lowercased. `::\000041fter` and `::AFTER` are both
 * `::after`, and an escape is part of the spelling, not of the name.
 */
export function pseudoName(name: string): string {
	return CSSTree.ident.decode(name).toLowerCase();
}

/** The namespaces a selector's prefixes are read against. */
export interface SelectorNamespaces {
	default: string | null;
	prefixes: Map<string, string>;
}

export const NO_NAMESPACES: SelectorNamespaces = {
	default: null,
	prefixes: new Map(),
};

/** A selector this engine will not accept, thrown out of compilation. */
export class SelectorError extends Error {}

/* -------------------------------------------------------------- the tree */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const DOCUMENT_NODE = 9;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * Everything a match asks of the engine around the tree.
 *
 * Each of these is a question the node itself cannot answer: a state the user
 * agent holds, a link the flat tree draws that the node tree does not, or a
 * fact about the document the element belongs to. The engine that owns them
 * supplies one object; a tree with no engine over it supplies an object that
 * says no to all of it.
 */
export interface SelectorResolver {
	/** The root of the tree a node is in: a document, a fragment, a shadow root. */
	root(node: Node): Node;
	/** The host of a shadow root, or null for any other root. */
	shadowHost(root: Node): Element | null;
	/** The parent an element has in the flat tree, which slots reorder. */
	flatParent(element: Element): Element | null;
	/** The slot an element is assigned to, or null when it is not slotted. */
	assignedSlot(element: Element): Element | null;
	/** The part names an element carries, for `::part()`. */
	parts(element: Element): readonly string[];
	/** Whether the node's document is an HTML document rather than an XML one. */
	html(node: Node): boolean;
	/** Whether the node's document is in quirks mode. */
	quirks(node: Node): boolean;
	hovered(element: Element): boolean;
	active(element: Element): boolean;
	focused(element: Element): boolean;
	focusVisible(element: Element): boolean;
	focusWithin(element: Element): boolean;
	/** Whether the element is the one the document's URL fragment names. */
	target(element: Element): boolean;
	modal(element: Element): boolean;
	popoverOpen(element: Element): boolean;
	fullscreen(element: Element): boolean;
	/** Whether a custom element name is defined, and the element upgraded. */
	defined(element: Element): boolean;
	/** Whether a custom element declares a state of this name. */
	state(element: Element, name: string): boolean;
	checked(element: Element): boolean;
	indeterminate(element: Element): boolean;
	placeholderShown(element: Element): boolean;
	/** Whether a control is its form's default, per `:default`. */
	defaulted(element: Element): boolean;
	/** Whether the element is showing what it can open, per `:open`. */
	open(element: Element): boolean;
}

/** A resolver for a tree no engine is holding: every state is off. */
export const INERT_RESOLVER: SelectorResolver = {
	root(node: Node): Node {
		let root = node;
		for (
			let parent = parentOf(root);
			parent !== null;
			parent = parentOf(root)
		) {
			root = parent;
		}
		return root;
	},
	shadowHost(): Element | null {
		return null;
	},
	flatParent(element: Element): Element | null {
		return parentElement(element);
	},
	assignedSlot(): Element | null {
		return null;
	},
	parts(): readonly string[] {
		return [];
	},
	html(): boolean {
		return true;
	},
	quirks(): boolean {
		return false;
	},
	hovered: no,
	active: no,
	focused: no,
	focusVisible: no,
	focusWithin: no,
	target: no,
	modal: no,
	popoverOpen: no,
	fullscreen: no,
	defined(): boolean {
		return true;
	},
	state: no,
	checked: no,
	indeterminate: no,
	placeholderShown: no,
	defaulted: no,
	open: no,
};

function no(): boolean {
	return false;
}

/** What a match knows beyond the element it starts from. */
interface MatchState {
	resolver: SelectorResolver;
	/** The node `:scope` names, or null when the selector names none. */
	scope: Node | null;
	/** The shadow root a selector was written inside, for `:host`. */
	shadow: Node | null;
	/** The node a relative selector inside `:has()` is anchored to. */
	anchor: Node | null;
}

/* --------------------------------------------------------- compiled shapes */

type Predicate = (element: Element, state: MatchState) => boolean;

type Combinator = " " | ">" | "+" | "~";

interface CompiledCompound {
	/** The tests the element this compound selects must pass. */
	tests: Predicate[];
	/**
	 * The element the compound is really written about, when a pseudo-element
	 * moves the subject: `slot::slotted(span)` selects the span and describes
	 * the slot, `host::part(x)` selects the part and describes the host. The
	 * combinator to the left steps from what this answers.
	 */
	origin: ((element: Element, state: MatchState) => Element | null) | null;
	/** The tests that origin must pass. */
	originTests: Predicate[];
	/** Whether this compound may match a featureless shadow host. */
	host: boolean;
}

interface CompiledComplex {
	compounds: CompiledCompound[];
	/** The combinator joining compound `index` to compound `index + 1`. */
	combinators: Combinator[];
}

/** A selector list, ready to be asked about an element. */
export interface CompiledSelector {
	list: CompiledComplex[];
}

/* ------------------------------------------------------------------ parsing */

/**
 * The text with the blocks an author left open closed, as CSS closes them.
 *
 * CSS Syntax ends an unterminated string, function or block at end of file
 * rather than throwing it away, so `[align="center"` and `::slotted(foo` are
 * both selectors. css-tree wants them closed, so they are closed here.
 */
function closeAtEndOfInput(text: string): string {
	const open: string[] = [];
	let quote = "";
	let dangling = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "\\") {
			// An escape with nothing left to escape stands for U+FFFD, so the
			// name it is part of is a name and the selector is a selector.
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
	return (
		text + (dangling ? "\uFFFD" : "") + quote + open.reverse().join("")
	);
}

/**
 * Whether the text spells a selector list with an empty selector in it, which
 * `div,` and a bare `,` both do. css-tree drops the empty one and reads the
 * rest, and a selector list that cannot be read is not a selector list.
 */
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

/**
 * How a stylesheet's own grammar check reads a selector: for shape alone. A
 * prefix means whatever the sheet declares -- which is not this reading's
 * business -- and `&` stands where a rule encloses it.
 */
const GRAMMAR_ONLY: CompileOptions = {
	namespaces: null,
	pseudoElements: true,
	nesting: true,
	// `@scope` lets a rule open with a combinator. One that does so anywhere
	// else reads as a selector and then selects nothing, since there is no
	// root for it to be relative to.
	relative: true,
};

/**
 * The text as CSS reads it, before anything is parsed: newlines normalized,
 * and every null and lone surrogate standing for U+FFFD (CSS Syntax 3).
 */
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

/** Parse a selector list to an AST, or null when the text is not one. */
function parseSelectorAST(text: string): SelectorNode | null {
	const source = preprocess(String(text));
	if (source.trim() === "" || hasEmptySelector(source)) {
		return null;
	}
	let list: SelectorNode;
	try {
		list = CSSTree.parse(closeAtEndOfInput(source), {
			context: "selectorList",
			onParseError(error: Error) {
				throw error;
			},
		}) as unknown as SelectorNode;
	} catch (_err) {
		return null;
	}
	return list.type === "SelectorList" ? list : null;
}

/**
 * Parse a selector list, or null when it does not parse -- which includes a
 * pseudo this engine does not know, since an unknown pseudo makes the whole
 * selector invalid.
 *
 * The prefixes in it are read for shape only: whether `svg|circle` names a
 * namespace anything declared is a question for whoever knows the declarations.
 */
export function parseSelectorList(text: string): SelectorNode | null {
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

/* -------------------------------------------------------------- compilation */

/** How a selector is read: what its prefixes mean, and what may match. */
export interface CompileOptions {
	/**
	 * The namespaces the selector's prefixes name. Null leaves them unresolved:
	 * the selector is checked for shape and every prefix is accepted, which is
	 * what a grammar check wants and a match does not.
	 */
	namespaces?: SelectorNamespaces | null;
	/**
	 * Whether a pseudo-element may select anything. The DOM's own query methods
	 * accept `a::before` and match nothing with it; the cascade, which asks
	 * about `::slotted()` and `::part()` for real, sets this.
	 */
	pseudoElements?: boolean;
	/** Whether a selector may open with a combinator, as `@scope` lets it. */
	relative?: boolean;
	/**
	 * Whether `&` may stand in the selector, which it may inside a style rule
	 * and nowhere else. It selects nothing on its own: the rule it is nested in
	 * is what gives it something to name.
	 */
	nesting?: boolean;
}

interface Compiling {
	namespaces: SelectorNamespaces | null;
	pseudoElements: boolean;
	nesting: boolean;
}

/** Compile a selector list's AST into the matchers it names. */
function compileList(
	list: SelectorNode,
	options: CompileOptions,
): CompiledSelector {
	const compiling: Compiling = {
		namespaces:
			options.namespaces === undefined ? NO_NAMESPACES : options.namespaces,
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

/** Compile one complex selector: its compounds, and the combinators between. */
function compileComplex(
	selector: SelectorNode,
	compiling: Compiling,
	relative: boolean,
): CompiledComplex {
	const parts = getChildren(selector);
	if (parts.length === 0) {
		throw new SelectorError("a selector selects something");
	}
	const compounds: CompiledCompound[] = [];
	const combinators: Combinator[] = [];
	let pending: SelectorNode[] = [];
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
			// whatever the caller says; anywhere else that is a parse error.
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

/** The compound a relative selector hangs from: the element `:has()` asked. */
const ANCHOR_COMPOUND: CompiledCompound = {
	tests: [
		(element: Element, state: MatchState): boolean =>
			element === state.anchor,
	],
	origin: null,
	originTests: [],
	host: false,
};

/** Compile the simple selectors written together, with no combinator between. */
function compileCompound(
	parts: SelectorNode[],
	compiling: Compiling,
): CompiledCompound {
	const compound: CompiledCompound = {
		tests: [],
		origin: null,
		originTests: [],
		host: false,
	};
	// A type selector is only a type selector where it is written first.
	for (const [index, part] of parts.entries()) {
		if (part.type === "TypeSelector" && index !== 0) {
			throw new SelectorError("a type selector opens its compound");
		}
	}
	for (const part of parts) {
		compileSimple(part, compound, compiling);
	}
	// CSS Namespaces 2: a default namespace qualifies a compound that names no
	// type at all, so where an HTML default is declared `.card` selects no SVG
	// element. A featureless host is outside all of that.
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

/** Compile one simple selector onto the compound it belongs to. */
function compileSimple(
	part: SelectorNode,
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
			const folded = asciiLowercase(id);
			compound.tests.push((element, state) => {
				const value = element.getAttribute("id");
				if (value === null) {
					return false;
				}
				return state.resolver.quirks(element) ?
					asciiLowercase(value) === folded :
					value === id;
			});
			return;
		}
		case "ClassSelector": {
			const name = CSSTree.ident.decode(String(part.name ?? ""));
			if (name === "") {
				throw new SelectorError("a class selector names a class");
			}
			const folded = asciiLowercase(name);
			compound.tests.push((element, state) => {
				const value = element.getAttribute("class");
				if (value === null) {
					return false;
				}
				const quirks = state.resolver.quirks(element);
				for (const token of splitOnWhitespace(value)) {
					if (quirks ? asciiLowercase(token) === folded : token === name) {
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
			compilePseudoElement(part, compound, compiling);
			return;
		case "NestingSelector":
			if (!compiling.nesting) {
				throw new SelectorError("a nesting selector needs a rule around it");
			}
			compound.tests.push(no);
			return;
		default:
			throw new SelectorError(`unreadable selector part ${part.type}`);
	}
}

/* ---------------------------------------------------------------- the parts */

/** A qualified name split into the namespace it asks for and its local name. */
interface QualifiedName {
	/** The namespace URI, null for no namespace, undefined for any. */
	namespace: string | null | undefined;
	/** The local name, or null for `*`. */
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
			// An attribute with no prefix is in no namespace; an element with no
			// prefix is in the default namespace the sheet declared.
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

/**
 * A type selector, which names an element's local name, its namespace, or
 * both.
 *
 * A type selector is ASCII case-insensitive against an HTML element in an HTML
 * document and case-sensitive everywhere else, which is what keeps
 * `feGaussianBlur` selectable and `DIV` matching a `div`.
 */
function compileType(name: string, compiling: Compiling): Predicate {
	const {namespace, local} = qualifiedName(name, compiling.namespaces, false);
	const folded = local === null ? null : asciiLowercase(local);
	return (element, state) => {
		if (element.nodeType !== ELEMENT_NODE) {
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
			state.resolver.html(element) &&
			asciiLowercase(element.localName) === folded
		);
	};
}

/**
 * The attributes HTML compares case-insensitively, on an HTML element in an
 * HTML document, when the selector states no case sensitivity of its own.
 */
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
	part: SelectorNode,
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
	const folded = asciiLowercase(local);
	const flags = part.flags === null || part.flags === undefined ?
		"" :
			asciiLowercase(String(part.flags));
	if (flags !== "" && flags !== "i" && flags !== "s") {
		throw new SelectorError(`unknown attribute flag ${flags}`);
	}
	// The attribute the element carries, read the way HTML reads a name: an
	// HTML element in an HTML document folds its attribute names to lower case.
	const read = (element: Element, state: MatchState): string | null => {
		const fold =
			element.namespaceURI === HTML_NAMESPACE && state.resolver.html(element);
		const attributes = element.attributes;
		for (let index = 0; index < attributes.length; index++) {
			const attribute = attributes[index];
			if (namespace !== undefined && attribute.namespaceURI !== namespace) {
				continue;
			}
			const name = attribute.localName;
			if (name === local || (fold && asciiLowercase(name) === folded)) {
				return attribute.value;
			}
		}
		return null;
	};
	const operator = part.matcher ?? null;
	if (operator === null) {
		return (element, state) => read(element, state) !== null;
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
	const foldedWanted = asciiLowercase(wanted);
	return (element, state) => {
		const value = read(element, state);
		if (value === null) {
			return false;
		}
		const insensitive =
			flags === "i" ||
			(flags === "" &&
				element.namespaceURI === HTML_NAMESPACE &&
				state.resolver.html(element) &&
				CASE_INSENSITIVE_ATTRIBUTES.has(folded));
		const subject = insensitive ? asciiLowercase(value) : value;
		const target = insensitive ? foldedWanted : wanted;
		switch (operator) {
			case "=":
				return subject === target;
			case "~=":
				// A value with whitespace in it, or none at all, is in no list.
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

/* ------------------------------------------------------------ pseudo-classes */

function compilePseudoClass(
	part: SelectorNode,
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
			const inner =
				args.length === 0 ? null : compileArgumentList(args, compiling, false);
			const context = name === "host-context";
			compound.tests.push((element, state) => {
				const shadow = state.shadow;
				if (shadow === null || state.resolver.shadowHost(shadow) !== element) {
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
				const parent = parentOf(element);
				return parent !== null && parent.nodeType === DOCUMENT_NODE;
			});
			return;
		case "empty":
			compound.tests.push(isEmpty);
			return;
		case "first-child":
			compound.tests.push((element) => previousElement(element) === null);
			return;
		case "last-child":
			compound.tests.push((element) => nextElement(element) === null);
			return;
		case "only-child":
			compound.tests.push(
				(element) =>
					previousElement(element) === null && nextElement(element) === null,
			);
			return;
		case "first-of-type":
			compound.tests.push((element) => ofTypeIndex(element, false) === 1);
			return;
		case "last-of-type":
			compound.tests.push((element) => ofTypeIndex(element, true) === 1);
			return;
		case "only-of-type":
			compound.tests.push(
				(element) =>
					ofTypeIndex(element, false) === 1 && ofTypeIndex(element, true) === 1,
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
			const wanted = identifierArgument(args, "state");
			compound.tests.push((element, state) =>
				state.resolver.state(element, wanted),
			);
			return;
		}
		case "link":
		case "any-link":
			compound.tests.push(isHyperlink);
			return;
		case "visited":
			// A visited link is not something a terminal has ever recorded, and
			// answering would leak history even where it had.
			compound.tests.push(no);
			return;
		case "target":
			compound.tests.push((element, state) => state.resolver.target(element));
			return;
		case "hover":
			compound.tests.push((element, state) => state.resolver.hovered(element));
			return;
		case "active":
			compound.tests.push((element, state) => state.resolver.active(element));
			return;
		case "focus":
			compound.tests.push((element, state) => state.resolver.focused(element));
			return;
		case "focus-visible":
			compound.tests.push((element, state) =>
				state.resolver.focusVisible(element),
			);
			return;
		case "focus-within":
			compound.tests.push((element, state) =>
				state.resolver.focusWithin(element),
			);
			return;
		case "modal":
			compound.tests.push((element, state) => state.resolver.modal(element));
			return;
		case "popover-open":
			compound.tests.push((element, state) =>
				state.resolver.popoverOpen(element),
			);
			return;
		case "fullscreen":
			compound.tests.push((element, state) =>
				state.resolver.fullscreen(element),
			);
			return;
		case "defined":
			compound.tests.push((element, state) => state.resolver.defined(element));
			return;
		case "open":
			compound.tests.push((element, state) => state.resolver.open(element));
			return;
		case "closed":
			compound.tests.push(
				(element, state) => canOpen(element) && !state.resolver.open(element),
			);
			return;
		case "checked":
			compound.tests.push((element, state) => state.resolver.checked(element));
			return;
		case "indeterminate":
			compound.tests.push((element, state) =>
				state.resolver.indeterminate(element),
			);
			return;
		case "placeholder-shown":
			compound.tests.push((element, state) =>
				state.resolver.placeholderShown(element),
			);
			return;
		case "default":
			compound.tests.push((element, state) =>
				state.resolver.defaulted(element),
			);
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
			compound.tests.push(
				(element) =>
					isRequirable(element) && element.getAttribute("required") !== null,
			);
			return;
		case "optional":
			compound.tests.push(
				(element) =>
					isRequirable(element) && element.getAttribute("required") === null,
			);
			return;
		case "read-only":
			compound.tests.push((element, state) => !isMutable(element, state));
			return;
		case "read-write":
			compound.tests.push(isMutable);
			return;
		default:
			// Everything left names a state this user agent never enters: a
			// media element's buffering, a page box's side, a spatial navigation
			// target, autofill, and the constraint validation family, which is
			// recorded as deliberately absent in the conformance notes.
			compound.tests.push(no);
	}
}

/** The one identifier a pseudo-class like `:state()` takes. */
function identifierArgument(args: SelectorNode[], name: string): string {
	const text = args
		.map((argument) =>
			argument.type === "Raw" ?
					String((argument as {value?: string}).value ?? "") :
				argument.type === "Identifier" ?
						String(argument.name ?? "") :
					" ",
		)
		.join("")
		.trim();
	if (!/^(?:[\w\u0080-\uFFFF-]|\\[^\n])+$/.test(text)) {
		throw new SelectorError(`:${name} takes one identifier`);
	}
	// The escapes in it spell the name, and the name has to be an identifier:
	// `1` is a number wherever it is written.
	const identifier = CSSTree.ident.decode(text);
	if (!/^[a-zA-Z_\u0080-\uFFFF-][\w\u0080-\uFFFF-]*$/.test(identifier)) {
		throw new SelectorError(`:${name} takes one identifier`);
	}
	return identifier;
}

/** Compile a selector list argument, dropping the branches that do not read. */
function compileForgiving(
	args: SelectorNode[],
	compiling: Compiling,
): CompiledComplex[] {
	const compiled: CompiledComplex[] = [];
	for (const argument of args) {
		const selectors =
			argument.type === "SelectorList" ? getChildren(argument) : [argument];
		for (const selector of selectors) {
			if (selector.type !== "Selector") {
				continue;
			}
			try {
				compiled.push(compileComplex(selector, compiling, false));
			} catch (_err) {
				// A forgiving selector list keeps the branches it can read.
			}
		}
	}
	return compiled;
}

/** Compile a selector list argument, where one bad branch spoils the lot. */
function compileArgumentList(
	args: SelectorNode[],
	compiling: Compiling,
	relative: boolean,
): CompiledComplex[] {
	const compiled: CompiledComplex[] = [];
	for (const argument of args) {
		const selectors =
			argument.type === "SelectorList" ? getChildren(argument) : [argument];
		for (const selector of selectors) {
			if (selector.type !== "Selector") {
				throw new SelectorError("a selector list holds selectors");
			}
			compiled.push(compileComplex(selector, compiling, relative));
		}
	}
	if (compiled.length === 0) {
		throw new SelectorError("a selector list selects something");
	}
	return compiled;
}

/* ---------------------------------------------------------- pseudo-elements */

function compilePseudoElement(
	part: SelectorNode,
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
			compound.tests.push(no);
			return;
		}
		// The slotted element is what the compound selects; everything written
		// before `::slotted()` describes the slot it landed in.
		compound.originTests = compound.tests;
		compound.tests = [];
		compound.origin = (element, state) => state.resolver.assignedSlot(element);
		compound.tests.push(
			(element, state) =>
				state.resolver.assignedSlot(element) !== null &&
				inner.some((complex) => matchComplex(complex, element, state, false)),
		);
		return;
	}
	if (name === "part") {
		const wanted = identifierArgument(args, "part");
		if (!compiling.pseudoElements) {
			compound.tests.push(no);
			return;
		}
		// The part is what the compound selects; what is written before
		// `::part()` describes the host whose tree the part lives in.
		compound.originTests = compound.tests;
		compound.tests = [];
		compound.origin = (element, state) =>
			state.resolver.shadowHost(state.resolver.root(element));
		compound.tests.push((element, state) =>
			state.resolver.parts(element).includes(wanted),
		);
		return;
	}
	if (name === "picker") {
		const argument = identifierArgument(args, "picker");
		if (argument !== "select") {
			throw new SelectorError("::picker names the select it belongs to");
		}
	} else if (FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) {
		identifierArgument(args, name);
	}
	// Every other pseudo-element names a box the tree has no node for, so a
	// query over the tree never selects one.
	compound.tests.push(no);
}

/* ---------------------------------------------------------------- structure */

function compileNth(
	name: string,
	args: SelectorNode[],
	compiling: Compiling,
): Predicate {
	const nth = args.find((argument) => argument.type === "Nth");
	if (!nth) {
		throw new SelectorError(`:${name} takes an An+B`);
	}
	const step = readAnPlusB(nth.nth ?? null);
	const filter = nth.selector ?
			compileArgumentList([nth.selector], compiling, false) :
		null;
	if (filter !== null && !name.endsWith("child")) {
		throw new SelectorError(`:${name} takes no "of" selector`);
	}
	const fromEnd = name === "nth-last-child" || name === "nth-last-of-type";
	const ofType = name === "nth-of-type" || name === "nth-last-of-type";
	return (element, state) => {
		if (element.nodeType !== ELEMENT_NODE) {
			return false;
		}
		const siblings = elementSiblings(element);
		const counted = siblings.filter((sibling) => {
			if (ofType) {
				return (
					sibling.localName === element.localName &&
					sibling.namespaceURI === element.namespaceURI
				);
			}
			if (filter === null) {
				return true;
			}
			return filter.some((complex) =>
				matchComplex(complex, sibling, state, false),
			);
		});
		const ordered = fromEnd ? counted.reverse() : counted;
		const index = ordered.indexOf(element);
		return index !== -1 && matchesAnPlusB(step, index + 1);
	};
}

interface AnPlusB {
	a: number;
	b: number;
}

function readAnPlusB(node: SelectorNode | null): AnPlusB {
	if (node === null) {
		throw new SelectorError("An+B is a step and an offset");
	}
	if (node.type === "Identifier") {
		const keyword = asciiLowercase(String(node.name ?? ""));
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
	const a = node.a === null || node.a === undefined ? 0 : readStep(node.a);
	const b = node.b === null || node.b === undefined ? 0 : Number(node.b);
	if (!Number.isFinite(a) || !Number.isFinite(b)) {
		throw new SelectorError("An+B counts in whole numbers");
	}
	return {a, b};
}

/** The step of an An+B, where `n`, `+n` and `-n` all state one. */
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

/* ------------------------------------------------------------ HTML questions */

/**
 * A hyperlink, which is what `:link` and `:any-link` name: an `a` or an `area`
 * with an href. A `link` element points somewhere too, and HTML leaves it out.
 */
function isHyperlink(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
	return (
		(name === "a" || name === "area") && element.getAttribute("href") !== null
	);
}

/** The elements a `disabled` attribute, on them or on a fieldset, reaches. */
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
		element.namespaceURI === HTML_NAMESPACE &&
		DISABLEABLE.has(element.localName)
	);
}

/**
 * Whether a control is disabled: by its own attribute, by an ancestor
 * fieldset's, or -- for an option -- by the optgroup it sits in.
 *
 * A fieldset disables its descendants except the ones inside its first legend,
 * which is how a disabled fieldset still lets its caption's controls work.
 */
function isDisabled(element: Element, _state: MatchState): boolean {
	if (!isDisableable(element)) {
		return false;
	}
	if (element.getAttribute("disabled") !== null) {
		return true;
	}
	if (element.localName === "option" || element.localName === "optgroup") {
		const parent = parentElement(element);
		return (
			element.localName === "option" &&
			parent !== null &&
			parent.namespaceURI === HTML_NAMESPACE &&
			parent.localName === "optgroup" &&
			parent.getAttribute("disabled") !== null
		);
	}
	if (element.localName === "fieldset") {
		return false;
	}
	for (
		let node = parentElement(element);
		node !== null;
		node = parentElement(node)
	) {
		if (
			node.namespaceURI !== HTML_NAMESPACE ||
			node.localName !== "fieldset" ||
			node.getAttribute("disabled") === null
		) {
			continue;
		}
		if (!insideFirstLegend(element, node)) {
			return true;
		}
	}
	return false;
}

function insideFirstLegend(element: Element, fieldset: Element): boolean {
	let legend: Element | null = null;
	for (const child of elementChildren(fieldset)) {
		if (child.namespaceURI === HTML_NAMESPACE && child.localName === "legend") {
			legend = child;
			break;
		}
	}
	if (legend === null) {
		return false;
	}
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		if (node === legend) {
			return true;
		}
	}
	return false;
}

/** The input types a `required` attribute means anything on. */
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
	const type = asciiLowercase(element.getAttribute("type") ?? "text");
	return !UNREQUIRABLE_INPUT_TYPES.has(type);
}

/** The input types that hold text the user may edit. */
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

/**
 * Whether an element is `:read-write`: a text control the user may type into,
 * or anything an editing host contains.
 */
function isMutable(element: Element, state: MatchState): boolean {
	if (element.namespaceURI === HTML_NAMESPACE) {
		const name = element.localName;
		if (name === "input" || name === "textarea") {
			const type =
				name === "input" ?
						asciiLowercase(element.getAttribute("type") ?? "text") :
					"text";
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
		const value = asciiLowercase(editable);
		if (value === "" || value === "true" || value === "plaintext-only") {
			return true;
		}
		if (value === "false") {
			return false;
		}
	}
	return false;
}

/** The elements `:open` and `:closed` say anything about. */
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
		let child = firstChildOf(element);
		child !== null;
		child = nextOf(child)
	) {
		if (child.nodeType === ELEMENT_NODE) {
			return false;
		}
		if (
			(child.nodeType === TEXT_NODE ||
				child.nodeType === CDATA_SECTION_NODE) &&
				(child.nodeValue ?? "") !== ""
		) {
			return false;
		}
	}
	return true;
}

/* -------------------------------------------------------------- language */

/**
 * `:lang()`, matched by RFC 4647 extended filtering: `:lang(en)` takes
 * `en-GB`, and a `*` in a range stands for any run of subtags.
 */
function compileLang(args: SelectorNode[]): Predicate {
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
	const folded = ranges.map((range) => asciiLowercase(range));
	return (element) => {
		const language = elementLanguage(element);
		if (language === null) {
			return false;
		}
		const tag = asciiLowercase(language);
		return folded.some((range) => rangeMatchesTag(range, tag));
	};
}

/** The language an element is in: the nearest declaration above it. */
function elementLanguage(element: Element): string | null {
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
					attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace")
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
			// A range's subtag may skip over a tag's, but never over a
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

/* ------------------------------------------------------------- directionality */

const bidi = bidiFactory();

/** The elements whose text a `dir=auto` scan above them never reads. */
const OPAQUE_TO_AUTO = new Set(["bdi", "script", "style", "textarea"]);

/** The input types whose value a `dir=auto` scan reads. */
const AUTO_INPUT_TYPES = new Set([
	"email",
	"hidden",
	"password",
	"search",
	"submit",
	"text",
	"url",
]);

function compileDir(args: SelectorNode[]): Predicate {
	const wanted = asciiLowercase(identifierArgument(args, "dir"));
	return (element) =>
		element.nodeType === ELEMENT_NODE && directionality(element) === wanted;
}

/**
 * An element's directionality, per HTML: its own `dir`, the first strong
 * character under a `dir=auto`, or whatever it inherits.
 *
 * The first-strong scan is the bidirectional algorithm's own paragraph rule,
 * so a run of spaces, digits or punctuation before the first letter decides
 * nothing -- which is the whole point of writing `dir=auto`.
 */
function directionality(element: Element): "ltr" | "rtl" {
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		const stated = declaredDirection(node);
		if (stated === "ltr" || stated === "rtl") {
			return stated;
		}
		if (stated === "auto") {
			return autoDirection(node);
		}
	}
	return "ltr";
}

/** What an element's own `dir` attribute states, `bdi`'s default included. */
function declaredDirection(
	element: Element,
): "ltr" | "rtl" | "auto" | null {
	if (element.nodeType !== ELEMENT_NODE) {
		return null;
	}
	const html = element.namespaceURI === HTML_NAMESPACE;
	const value = asciiLowercase(element.getAttribute("dir") ?? "");
	if (html && (value === "ltr" || value === "rtl" || value === "auto")) {
		return value;
	}
	// A bdi with no direction of its own is the element `dir=auto` was
	// invented for: it isolates what it holds and reads it for itself.
	return html && element.localName === "bdi" ? "auto" : null;
}

function autoDirection(element: Element): "ltr" | "rtl" {
	if (element.namespaceURI === HTML_NAMESPACE) {
		const name = element.localName;
		if (name === "input") {
			const type = asciiLowercase(element.getAttribute("type") ?? "text");
			if (type === "tel") {
				return "ltr";
			}
			if (!AUTO_INPUT_TYPES.has(type)) {
				return "ltr";
			}
			return firstStrong(element.getAttribute("value") ?? "");
		}
		if (name === "textarea") {
			return firstStrong(textUnder(element, true));
		}
	}
	return firstStrong(textUnder(element, false));
}

/** The text a `dir=auto` scan reads under an element, in tree order. */
function textUnder(element: Element, all: boolean): string {
	let text = "";
	for (
		let child = firstChildOf(element);
		child !== null;
		child = nextOf(child)
	) {
		if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
			text += child.nodeValue ?? "";
			continue;
		}
		const descendant = asElement(child);
		if (descendant === null || all) {
			continue;
		}
		// A descendant that states its own direction, and one that isolates
		// what it holds, both keep their text out of the scan above them.
		if (
			OPAQUE_TO_AUTO.has(descendant.localName) ||
			declaredDirection(descendant) !== null
		) {
			continue;
		}
		text += textUnder(descendant, false);
	}
	return text;
}

function firstStrong(text: string): "ltr" | "rtl" {
	if (text === "") {
		return "ltr";
	}
	const {paragraphs} = bidi.getEmbeddingLevels(text);
	const paragraph = paragraphs[0];
	return paragraph && (paragraph.level & 1) === 1 ? "rtl" : "ltr";
}

/* ------------------------------------------------------------------ matching */

/** Whether an element matches one complex selector, read right to left. */
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
	if (element.nodeType !== ELEMENT_NODE) {
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
			const step = parentStep(subject, state);
			return (
				step !== null &&
				matchFrom(complex, index - 1, step.element, state, step.featureless)
			);
		}
		case "+": {
			const sibling = previousElement(subject);
			return (
				sibling !== null &&
				matchFrom(complex, index - 1, sibling, state, false)
			);
		}
		case "~": {
			for (
				let sibling = previousElement(subject);
				sibling !== null;
				sibling = previousElement(sibling)
			) {
				if (matchFrom(complex, index - 1, sibling, state, false)) {
					return true;
				}
			}
			return false;
		}
		default: {
			for (
				let step = parentStep(subject, state);
				step !== null;
				step = parentStep(step.element, state)
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

/** One step up the tree, which for a shadow tree ends at its featureless host. */
function parentStep(
	element: Element,
	state: MatchState,
): {element: Element; featureless: boolean} | null {
	const parent = parentOf(element);
	if (parent === null) {
		return null;
	}
	const above = asElement(parent);
	if (above !== null) {
		return {element: above, featureless: false};
	}
	// A selector written in a shadow tree reaches the host it hangs under, and
	// the host is featureless: only `:host` and its two functional forms name
	// it.
	if (state.shadow !== null && parent === state.shadow) {
		const host = state.resolver.shadowHost(parent);
		return host === null ? null : {element: host, featureless: true};
	}
	return null;
}

/**
 * Whether one of `:has()`'s relative selectors selects anything from here.
 *
 * The search space is the anchor's subtree for a selector reaching down, and
 * its following siblings' subtrees for one reaching across -- which is why
 * `li:has(~ li.x)` never counts the `li.x` it was asked about.
 */
function hasMatch(
	inner: CompiledComplex[],
	element: Element,
	state: MatchState,
): boolean {
	// The anchor is what a leading combinator hangs from. `:scope` is not
	// touched: inside `:has()` it still names whatever the query scoped to.
	const inside: MatchState = {...state, anchor: element};
	for (const complex of inner) {
		const selects = (node: Element): boolean =>
			matchComplex(complex, node, inside, false);
		const leading = complex.combinators[0] ?? " ";
		if (leading === "+" || leading === "~") {
			for (
				let sibling = nextElement(element);
				sibling !== null;
				sibling = nextElement(sibling)
			) {
				if (selects(sibling) || walk(sibling, selects)) {
					return true;
				}
			}
		} else if (walk(element, selects)) {
			return true;
		}
	}
	return false;
}

/* ------------------------------------------------------------ tree helpers */

/*
 * The DOM types the links between nodes as the platform does, where a parent is
 * a ParentNode and a sibling a ChildNode -- mixins that describe what may stand
 * in each position rather than what a node is. The matcher walks nodes, so it
 * reads each link back as the node on the other end of it, and these four
 * readers are the whole of where it does that.
 */

function parentOf(node: Node): Node | null {
	return node.parentNode as Node | null;
}

function firstChildOf(node: Node): Node | null {
	return node.firstChild as Node | null;
}

function previousOf(node: Node): Node | null {
	return node.previousSibling as Node | null;
}

function nextOf(node: Node): Node | null {
	return node.nextSibling as Node | null;
}

/** The node, if it is an element, which is what most of a selector reads. */
function asElement(node: Node | null): Element | null {
	return node !== null && node.nodeType === ELEMENT_NODE ?
			(node as Element) :
		null;
}

function parentElement(node: Node): Element | null {
	return asElement(parentOf(node));
}

function elementChildren(node: Node): Element[] {
	const found: Element[] = [];
	for (let child = firstChildOf(node); child !== null; child = nextOf(child)) {
		const element = asElement(child);
		if (element !== null) {
			found.push(element);
		}
	}
	return found;
}

function elementSiblings(element: Element): Element[] {
	const parent = parentOf(element);
	return parent === null ? [element] : elementChildren(parent);
}

function previousElement(element: Element): Element | null {
	for (let node = previousOf(element); node !== null; node = previousOf(node)) {
		const found = asElement(node);
		if (found !== null) {
			return found;
		}
	}
	return null;
}

function nextElement(element: Element): Element | null {
	for (let node = nextOf(element); node !== null; node = nextOf(node)) {
		const found = asElement(node);
		if (found !== null) {
			return found;
		}
	}
	return null;
}

/** How far an element is from one end of its siblings of the same type. */
function ofTypeIndex(element: Element, fromEnd: boolean): number {
	const siblings = elementSiblings(element).filter(
		(sibling) =>
			sibling.localName === element.localName &&
			sibling.namespaceURI === element.namespaceURI,
	);
	const index = siblings.indexOf(element);
	if (index === -1) {
		return 0;
	}
	return fromEnd ? siblings.length - index : index + 1;
}

function asciiLowercase(text: string): string {
	return text.replace(/[A-Z]/g, (char) =>
		String.fromCharCode(char.charCodeAt(0) + 32),
	);
}

function splitOnWhitespace(text: string): string[] {
	return text.split(/[\t\n\f\r ]+/).filter((token) => token !== "");
}

/* ---------------------------------------------------------------- the cache */

/**
 * Compiled selectors, kept by their text and the namespaces they were read
 * against. A selector is compiled once and matched against everything.
 */
const compiled = new Map<string, CompiledSelector | SelectorError>();

function cacheKey(text: string, options: CompileOptions): string {
	const namespaces = options.namespaces;
	const map =
		namespaces == null ?
			"-" :
				[...namespaces.prefixes]
					.map(([prefix, uri]) => `${prefix}=${uri}`)
					.sort()
					.join(" ");
	return `${namespaces?.default ?? ""} ${map} ${
		options.pseudoElements ? "p" : ""
	}${options.relative ? "r" : ""}${options.nesting ? "n" : ""} ${text}`;
}

/**
 * Compile a selector list, throwing a SelectorError at anything this engine
 * will not read. The result is cached, and so is the refusal.
 */
export function compileSelector(
	text: string,
	options: CompileOptions = {},
): CompiledSelector {
	const key = cacheKey(text, options);
	let entry = compiled.get(key);
	if (entry === undefined) {
		try {
			const list = parseSelectorAST(text);
			if (list === null) {
				throw new SelectorError(`'${text}' is not a selector`);
			}
			entry = compileList(list, options);
		} catch (error) {
			entry =
				error instanceof SelectorError ?
					error :
						new SelectorError(String((error as Error).message));
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

/* -------------------------------------------------------------- entry points */

/** What a match knows beyond the element: the resolver, and what `:scope` names. */
export interface MatchOptions {
	resolver?: SelectorResolver;
	/** The node `:scope` stands for. */
	scope?: Node | null;
	/** The shadow root the selector was written in, for `:host`. */
	shadow?: Node | null;
}

/** What a query over selector text knows: how to read it, and what to read it against. */
export interface QueryOptions extends CompileOptions, MatchOptions {}

function stateFor(options: MatchOptions): MatchState {
	return {
		resolver: options.resolver ?? INERT_RESOLVER,
		scope: options.scope ?? null,
		shadow: options.shadow ?? null,
		// A relative selector hangs from the scoping root, which is also what
		// `:scope` names; inside `:has()` both become the anchor instead.
		anchor: options.scope ?? null,
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

/** Whether an element matches a selector compiled already. */
export function matchesCompiled(
	element: Element,
	selector: CompiledSelector,
	options: MatchOptions = {},
): boolean {
	return matchesAny(selector, element, stateFor(options));
}

/** Every element under a root that a compiled selector selects, in tree order. */
export function selectAllCompiled(
	root: Node,
	selector: CompiledSelector,
	options: MatchOptions = {},
): Element[] {
	const state = stateFor(options);
	const found: Element[] = [];
	walk(root, (element) => {
		if (matchesAny(selector, element, state)) {
			found.push(element);
		}
		return false;
	});
	return found;
}

/** Whether an element matches a selector, which is what `matches()` asks. */
export function matchesSelector(
	element: Element,
	text: string,
	options: QueryOptions = {},
): boolean {
	return matchesCompiled(element, compileSelector(text, options), options);
}

/** Every element under a root that a selector selects, in tree order. */
export function selectAll(
	root: Node,
	text: string,
	options: QueryOptions = {},
): Element[] {
	return selectAllCompiled(root, compileSelector(text, options), options);
}

/** The first element under a root that a selector selects, in tree order. */
export function selectFirst(
	root: Node,
	text: string,
	options: QueryOptions = {},
): Element | null {
	const selector = compileSelector(text, options);
	const state = stateFor(options);
	let first: Element | null = null;
	walk(root, (element) => {
		if (matchesAny(selector, element, state)) {
			first = element;
			return true;
		}
		return false;
	});
	return first;
}

/** The nearest inclusive ancestor of an element that a selector selects. */
export function closestSelector(
	element: Element,
	text: string,
	options: QueryOptions = {},
): Element | null {
	const selector = compileSelector(text, options);
	const state = stateFor(options);
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

/**
 * The node after this one in tree order, stopping at a root: its first child,
 * or else the next sibling of the nearest ancestor that has one.
 */
function nextInTree(node: Node, root: Node): Node | null {
	const child = firstChildOf(node);
	if (child !== null) {
		return child;
	}
	for (
		let current: Node | null = node;
		current !== null && current !== root;
		current = parentOf(current)
	) {
		const sibling = nextOf(current);
		if (sibling !== null) {
			return sibling;
		}
	}
	return null;
}

/**
 * Every element under a root, in tree order, until the visitor says stop.
 *
 * The walk steps along the links a node already has rather than recursing, so
 * a deep tree costs no stack and a wide one allocates nothing.
 */
function walk(root: Node, visit: (element: Element) => boolean): boolean {
	for (
		let node = nextInTree(root, root);
		node !== null;
		node = nextInTree(node, root)
	) {
		const element = asElement(node);
		if (element !== null && visit(element)) {
			return true;
		}
	}
	return false;
}
