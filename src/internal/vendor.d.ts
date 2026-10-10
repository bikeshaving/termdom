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

declare module "css-tree/dist/csstree.esm";

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
		} | undefined;
}
