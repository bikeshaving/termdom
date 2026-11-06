/**
 * Ambient types for the external packages that ship none.
 *
 * All of them are hand-written against the small surface termdom actually
 * consumes, not the packages' full APIs -- if a call site starts needing more,
 * widen the declaration here rather than casting at the call site.
 */

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
