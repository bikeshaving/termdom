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

declare module "jsdom/lib/jsdom/living/generated/utils.js" {
	// jsdom's private wrapper<->impl bridge. Reached to drive a form control's
	// custom-element upgrade at the impl level, which the public API never
	// exposes for built-ins. Default import (the whole module.exports): these
	// are CommonJS and Node's static export lexer misses the individual names.
	const utils: {
		/** The internal impl object backing a public DOM wrapper. */
		implForWrapper(wrapper: object): any;
	};
	export default utils;
}

declare module "jsdom/lib/jsdom/living/helpers/custom-elements.js" {
	// jsdom's custom-element reactions machinery -- the same code an
	// `<input is="...">` upgrade runs. We use it to upgrade a PLAIN form
	// control (no `is=`) to its UA class in place: no author markup, no custom
	// runtime, jsdom's real connectedCallback/attributeChangedCallback lifecycle.
	const customElements: {
		/** Run the upgrade algorithm: swap prototype, replay attrs, connect. */
		upgradeElement(definition: unknown, elementImpl: object): void;
		/** Open a reactions queue so a following upgrade flushes synchronously. */
		ceReactionsPreSteps(): void;
		/** Close the queue and invoke the reactions it collected, synchronously. */
		ceReactionsPostSteps(): void;
	};
	export default customElements;
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
	const shapers: {
		ArabicShaper: Shaper;
		PersianShaper: Shaper;
	};
	export default shapers;
}
