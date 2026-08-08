import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {ColorSchemeToggle} from "./color-scheme-toggle.js";

const positionFixed = css`
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	height: 50px;
	z-index: 999;
`;

const navbarGroupLayout = css`
	display: flex;
	flex-direction: row;
	justify-content: center;
	align-items: center;
	gap: 1em;
`;

/**
 * The block cursor is the logo. It is one character of the thing the library
 * paints to, which is as much branding as a terminal library needs.
 */
function BlockCursor() {
	return jsx`
		<span
			aria-hidden="true"
			class=${css`
				display: inline-block;
				width: 0.6em;
				height: 1.05em;
				background-color: var(--highlight-color);
				vertical-align: text-bottom;
			`}
		/>
	`;
}

export function Navbar({url}: {url: string}) {
	return jsx`
		<nav
			class="
				${positionFixed}
				${css`
					border-bottom: 1px solid var(--border-color);
					background-color: var(--bg-color);
					overflow-x: auto;
					padding: 0 1em;
					font-size: 0.9rem;

					a {
						text-decoration: none;
						font-weight: bold;
						color: var(--text-color);
						white-space: nowrap;
					}

					a:hover,
					a[aria-current="page"] {
						color: var(--highlight-color);
					}

					@media screen and (min-width: 800px) {
						padding: 0 2em;
					}

					display: flex;
					flex-direction: row;
					justify-content: space-between;
					align-items: center;
					gap: 1em;
				`}
			"
		>
			<div class=${navbarGroupLayout}>
				<a
					class=${navbarGroupLayout}
					aria-current=${url === "/" && "page"}
					style="gap: 0.4em"
					href="/"
				>
					<${BlockCursor} />
					termdom
				</a>
				<a
					href="/guides/getting-started/"
					aria-current=${url.startsWith("/guides") && "page"}
				>Guides</a>
				<a
					href="/support/"
					aria-current=${url.startsWith("/support") && "page"}
				>Support</a>
			</div>
			<div class=${navbarGroupLayout}>
				<a href="https://github.com/bikeshaving/termdom">GitHub</a>
				<a href="https://www.npmjs.com/package/@b9g/termdom">NPM</a>
				<${ColorSchemeToggle} />
			</div>
		</nav>
	`;
}
