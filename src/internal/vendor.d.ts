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
