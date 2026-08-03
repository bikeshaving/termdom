/**
 * Type declarations for imports TypeScript cannot resolve on its own.
 *
 * Asset imports (`*.svg`, `*.css`, `*.cast`, ...) are NOT declared here:
 * `@b9g/assets` already declares them globally, including a `*` catch-all, and
 * redeclaring them collides. This file is only for packages that ship no types.
 */

declare module "asciinema-player" {
	export interface CreateOptions {
		cols?: number;
		rows?: number;
		autoPlay?: boolean;
		loop?: boolean;
		idleTimeLimit?: number;
		preload?: boolean;
		fit?: "width" | "height" | "both" | false;
		theme?: string;
		terminalFontFamily?: string;
		terminalLineHeight?: number;
		speed?: number;
		poster?: string;
	}

	export interface Player {
		play(): Promise<void>;
		pause(): void;
		dispose(): void;
	}

	export function create(
		src: string,
		element: HTMLElement,
		options?: CreateOptions,
	): Player;
}
