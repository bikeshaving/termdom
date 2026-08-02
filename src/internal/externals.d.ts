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

declare module "rrweb-cssom" {
	// The CSSOM parser jsdom itself uses. Only parse() is consumed, and its
	// output is shaped like a CSSStyleSheet (cssRules with selectorText/style/
	// media), which #parseStyleSheet already speaks.
	export function parse(cssText: string): {cssRules: CSSRuleList};
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
	/**
	 * Arabic contextual shaping: base letters in, presentation forms out. Note
	 * that it is NOT length-preserving -- lam-alef pairs collapse to a single
	 * ligature codepoint.
	 */
	export const ArabicShaper: {
		convertArabic(text: string): string;
	};
	export const PersianShaper: {
		convertArabic(text: string): string;
	};
}
