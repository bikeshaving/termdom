/**
 * Ambient types for the external packages that ship none.
 *
 * All of them are hand-written against the small surface termdom actually
 * consumes, not the packages' full APIs -- if a call site starts needing more,
 * widen the declaration here rather than casting at the call site.
 */

declare module "linebreak" {

	/** UAX #14 line breaking. */
	export default class LineBreaker {
		constructor(text: string);
		nextBreak(): {position: number; required: boolean} | null;
	}
}

declare module "css-tree" {
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

	export function parse(text: string, options?: ParseOptions): CSSTreeNode;

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

	export function generate(node: CSSTreeNode): string;

	export interface MatchResult {
		matched: unknown;
		error: Error | null;
	}

	export const ident: {
		decode(text: string): string;
		encode(text: string): string;
	};

	export interface Lexer {
		matchProperty(property: string, value: CSSTreeNode | string): MatchResult;
		matchAtruleDescriptor(
			atRule: string,
			descriptor: string,
			value: CSSTreeNode | string,
		): MatchResult;
	}

	export const lexer: Lexer;

	/**
	 * A css-tree with an amended grammar dictionary. A syntax beginning with
	 * `|` extends the entry the property index states rather than replacing it.
	 */
	export function fork(extension: {
		properties?: Record<string, string>;
		types?: Record<string, string>;
	}): {lexer: Lexer};
}

declare module "webidl2" {
	// The WebIDL parser the table generator reads webref's IDL with. Only
	// the definition shapes the generator walks are declared.
	export interface Type {
		idlType: string | Type | Type[];
		nullable: boolean;
		generic?: string;
	}

	export interface ExtendedAttribute {
		name: string;
		rhs: {value: unknown} | null;
	}

	export interface Member {
		type: string;
		name: string;
		idlType: Type;
		readonly: boolean;
		extAttrs: ExtendedAttribute[];
	}

	export interface Definition {
		type: string;
		name?: string;
		partial?: boolean;
		target?: string;
		includes?: string;
		members?: Member[];
	}

	export function parse(text: string): Definition[];
}

declare module "color-name" {

	/** The CSS Color 4 named colors, each as its RGB channels. */
	const colors: Readonly<Record<string, readonly [number, number, number]>>;
	export default colors;
}

declare module "bidi-js" {

	/** UAX #9, the Unicode bidirectional algorithm. */
	export interface EmbeddingLevels {
		levels: Uint8Array;
		paragraphs: Array<{start: number; end: number; level: number}>;
	}

	export interface Bidi {

		/**
		 * Resolve embedding levels for a string. `explicitDirection` forces the
		 * paragraph direction; omitted, it is inferred per §P2 from the first
		 * strong character.
		 */
		getEmbeddingLevels(
			text: string,
			explicitDirection?: "ltr" | "rtl" | "auto",
		): EmbeddingLevels;

		/**
		 * The string in visual order, with mirrored characters substituted
		 * (§L2 and §L4 together).
		 *
		 * Deliberately NOT declaring getMirroredCharactersMap: in 1.0.3 it tests
		 * `embeddingLevels[i] & 1` on the result OBJECT rather than its `levels`
		 * array, so it always returns an empty map. This function does the same
		 * job correctly, so there is no reason to reach for the broken one.
		 */
		getReorderedString(
			text: string,
			embeddingLevels: EmbeddingLevels,
			start?: number,
			end?: number,
		): string;
	}

	export default function bidiFactory(): Bidi;
}

declare module "arabic-persian-reshaper" {
	interface Shaper {
		convertArabic(text: string): string;
	}

	/**
	 * Arabic contextual shaping: base letters in, presentation forms out. Note
	 * that it is NOT length-preserving -- lam-alef pairs collapse to a single
	 * ligature codepoint.
	 *
	 * Declared as a DEFAULT export even though the package is an object of two
	 * named shapers. It is CommonJS, and Node's static export detection reads
	 * only `PersianShaper` off it -- `ArabicShaper` is invisible to the lexer,
	 * so importing it by name throws at load time in Node while working in
	 * Bun. The default is the whole `module.exports`, which every runtime
	 * agrees on.
	 */
	const shapers: {ArabicShaper: Shaper; PersianShaper: Shaper};
	export default shapers;
}

/**
 * Bun's global, of which termdom uses one function: a width measurement that
 * knows the Unicode tables. Declared here rather than taken from @types/bun,
 * whose global `Event` merges with lib.dom's and leaves `composedPath` with an
 * overload no DOM can satisfy (oven-sh/bun#40574).
 */
declare namespace globalThis {
	// eslint-disable-next-line no-var
	var Bun:
		{

			/** The rendered column width of a string. */
			stringWidth(input: string): number;
		} |
		undefined;
}
