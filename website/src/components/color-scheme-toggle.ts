import {jsx} from "@b9g/crank/standalone";
import type {Context} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {useColorScheme} from "../utils/color-scheme.js";

const toggleStyles = css`
	position: relative;
	width: 54px;
	height: 28px;
	border-radius: 14px;
	border: 1px solid var(--border-color);
	background: transparent;
	color: inherit;
	cursor: pointer;
	padding: 0 4px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: 13px;
	flex: none;

	&:focus-visible {
		outline: none;
		border-color: var(--highlight-color);
	}
`;

const knobStyles = css`
	position: absolute;
	width: 22px;
	height: 22px;
	border-radius: 50%;
	border: 1px solid var(--border-color);
	background: var(--bg-color);
	transition: left 0.2s;
	/* Hidden until hydration: before JS there is no state to point at. */
	display: none;
`;

const IS_CLIENT = typeof window !== "undefined";

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
			>
				<span>${"🌙"}</span>
				<span>${"☀️"}</span>
				<span
					hydrate="!style"
					class=${knobStyles}
					style=${
						IS_CLIENT
							? {display: "block", left: isDark ? "28px" : "2px"}
							: undefined
					}
				/>
			</button>
		`;
	}
}
