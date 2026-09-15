import {jsx} from "@b9g/crank/standalone";
import type {Context} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {useColorScheme} from "../utils/color-scheme.js";

/*
 * Both glyphs are in the markup and the root's scheme class picks one, so the
 * server's HTML and the client's agree before hydration and nothing flashes.
 */
const toggleStyles = css`
	flex: none;
`;

export function* ColorSchemeToggle(this: Context) {
	const colorScheme = useColorScheme(this);

	for ({} of this) {
		const isDark = colorScheme.get() === "dark";
		const onclick = () => colorScheme.toggle();

		// The emoji are interpolated rather than written inline: Bun escapes
		// them inside tagged templates. https://github.com/oven-sh/bun/issues/19654
		yield jsx`
			<button
				onclick=${onclick}
				role="switch"
				aria-label="toggle color scheme"
				aria-checked=${isDark ? "true" : "false"}
				hydrate="!aria-checked"
				class=${toggleStyles}
			><span class="scheme-dark">${"🌙"}</span><span class="scheme-light">${"☀️"}</span></button>
		`;
	}
}
