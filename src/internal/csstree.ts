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

export const lexer: Lexer = Runtime.lexer;

/** The tokenizer's token type numbers, by name. */
export const tokenTypes: Record<string, number> = Runtime.tokenTypes;

/**
 * A css-tree with an amended grammar dictionary. A syntax beginning with
 * `|` extends the entry the property index states rather than replacing it.
 */
export const fork: (extension: {
	properties?: Record<string, string>;
	types?: Record<string, string>;
}) => {lexer: Lexer} = Runtime.fork;
