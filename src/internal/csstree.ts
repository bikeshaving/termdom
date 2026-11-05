import * as Runtime from "css-tree/dist/csstree.esm";

// The CSS text parser behind this engine's CSSOM: it turns stylesheet,
// selector and value text into ASTs, which cssom.ts serializes per the
// CSSOM algorithms and matches the cascade against. Only the parse,
// generate and lexer surface is consumed.
export interface CSSTreeNode {
	type: string;
	[key: string]: unknown;
}

export interface ParseOptions {
	context?: string;
	atrule?: string;
	positions?: boolean;
	parseAtrulePrelude?: boolean;
	parseRulePrelude?: boolean;
	parseValue?: boolean;
	parseCustomProperty?: boolean;
	onParseError?(error: Error): void;
}

export const parse: (text: string, options?: ParseOptions) => CSSTreeNode =
	Runtime.parse;

export interface Span {
	start: {offset: number};
	end: {offset: number};
}

/** A node of a parsed value. */
export interface ValueNode {
	type: string;
	name?: string;
	value?: string;
	unit?: string;
	children?: {toArray(): ValueNode[]};
	left?: ValueNode | null;
	right?: ValueNode | null;
}

/** A rule, at-rule or declaration of a parsed stylesheet. */
export interface StyleSheetNode {
	type: string;
	name?: string;
	prelude?: {type: string; value?: string} | null;
	block?: {children: {toArray(): StyleSheetNode[]}} | null;
	property?: string;
	value?: {
		type: string;
		value?: string;
		loc?: Span | null;
		children?: {toArray(): ValueNode[]} | null;
	} | null;
	important?: boolean | string;
	children?: {toArray(): StyleSheetNode[]} | null;
}

/** A selector AST node. */
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

/** A node of a parsed `@supports` prelude. */
export interface SupportsNode {
	type: string;
	name?: string;
	feature?: string;
	property?: string;
	loc?: Span | null;
	children?: {toArray(): SupportsNode[]} | null;
	declaration?: SupportsNode | null;
	value?: SupportsNode | null;
}

/** A query of a parsed media query list. */
export interface MediaQueryNode {
	modifier?: string | null;
	mediaType?: string | null;
	condition?: MediaConditionNode | null;
}

export interface MediaConditionNode {
	type: string;
	name?: string;
	loc?: Span | null;
	value?: ValueNode | null;
	children?: {toArray(): MediaConditionNode[]} | null;
	left?: ValueNode | null;
	leftComparison?: string | null;
	middle?: ValueNode | null;
	rightComparison?: string | null;
	right?: ValueNode | null;
}

/** A top-level node of a parsed `@container` prelude. */
export interface ContainerPreludeNode {
	type: string;
	name?: string;
	loc?: Span | null;
}

/** A node of a parsed `@scope` prelude. */
export interface ScopePreludeNode {
	type: string;
	loc?: Span | null;
	root?: ScopePreludeNode | null;
	limit?: ScopePreludeNode | null;
}

/** A top-level node of a parsed `@namespace` prelude. */
export interface NamespacePreludeNode {
	type: string;
	name?: string;
	value?: string;
}

/** A node of a parsed `@layer` prelude. */
export interface LayerPreludeNode {
	type: string;
	name?: string;
	children?: {toArray(): LayerPreludeNode[]} | null;
}

/** A node of a parsed `@import` prelude. */
export interface ImportPreludeNode {
	type: string;
	name?: string;
	value?: string;
	loc?: Span | null;
	children?: {toArray(): ImportPreludeNode[]} | null;
}

export const generate: (node: CSSTreeNode) => string = Runtime.generate;

export interface MatchResult {
	matched: unknown;
	error: Error | null;
}

export const ident: {
	decode(text: string): string;
	encode(text: string): string;
} = Runtime.ident;

export interface Lexer {
	matchProperty(property: string, value: CSSTreeNode | string): MatchResult;
	matchAtruleDescriptor(
		atRule: string,
		descriptor: string,
		value: CSSTreeNode | string,
	): MatchResult;
}

/** The tokenizer's token type numbers, by name. */
export const tokenTypes: Record<string, number> = Runtime.tokenTypes;

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
} = Runtime.tokenTypes;

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

function parseBlock(this: BlockParser, isStyleBlock: boolean): unknown {
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
						: this.parseWithFallback(this.Rule, function (this: BlockParser) {
							return this.Raw(null, true);
						}),
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
}

interface GrammarLexer extends Lexer {
	properties: Record<string, {syntax: unknown}>;
	types: Record<string, {syntax: unknown}>;
	addProperty_(name: string, syntax: string): void;
	addType_(name: string, syntax: string): void;
}

interface SyntaxConfig {
	node: Record<string, object>;
	[key: string]: unknown;
}

// The property index's grammars, with entries the index states from an
// older spec level brought up to date. The deprecated system colors still
// parse, per CSS Color 4. Each entry extends the grammar the index states.
const PROPERTY_GRAMMARS: Record<string, string> = {
	"alignment-baseline": "| text-bottom | text-top",
	"text-align":
		"| -webkit-left | -webkit-center | -webkit-right | -moz-left | -moz-center | -moz-right",
	"baseline-shift": "| top | center | bottom",
	display: "| [ block | inline ]? math",
	"outline-color": "| invert",
};

const TYPE_GRAMMARS: Record<string, string> = {
	color: "| <deprecated-system-color>",
	"family-name":
		"| generic( <custom-ident>+ ) | -webkit-generic( <custom-ident>+ )",
};

// css-tree builds its default syntax, lexer included, when it loads, and a
// fork builds a second lexer of over a thousand grammar entries. The
// default lexer takes the amended grammars, and the fork holds the parser
// that reads nested rules, with an empty dictionary.
const lexer = Runtime.lexer as GrammarLexer;
const generateGrammar: (ast: unknown) => string =
	Runtime.definitionSyntax.generate;
for (const [name, extension] of Object.entries(PROPERTY_GRAMMARS)) {
	lexer.addProperty_(
		name,
		generateGrammar(lexer.properties[name].syntax) + " " + extension,
	);
}
for (const [name, extension] of Object.entries(TYPE_GRAMMARS)) {
	lexer.addType_(
		name,
		generateGrammar(lexer.types[name].syntax) + " " + extension,
	);
}

const parser = (
	Runtime.fork as (
		extend: (base: SyntaxConfig) => SyntaxConfig,
	) => {parse: typeof parse}
)((base) => ({
	...base,
	generic: false,
	types: null,
	properties: null,
	atrules: null,
	node: {...base.node, Block: {...base.node.Block, parse: parseBlock}},
}));

/**
 * The engine's syntax: style blocks read nested rules, and the value
 * matcher reads the amended grammar dictionary.
 */
export const syntax: {parse: typeof parse; lexer: Lexer} = {
	parse: parser.parse,
	lexer,
};
