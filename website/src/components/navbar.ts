import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {ColorSchemeToggle} from "./color-scheme-toggle.js";

const positionFixed = css`
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	height: var(--bar-height);
	z-index: 999;
`;

const navbarGroupLayout = css`
	display: flex;
	flex-direction: row;
	justify-content: center;
	align-items: center;
	gap: 2ch;
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
				width: 1ch;
				height: 1lh;
				background-color: var(--highlight-color);
				vertical-align: bottom;
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
					background: var(--rule) bottom 0.5lh center / 100% 1px no-repeat var(--bg-color);
					overflow-x: auto;
					padding: 0 1ch 1lh;

					a {
						text-decoration: none;
						font-weight: bold;
						color: var(--text-color);
						white-space: nowrap;
					}

					a:hover {
						background-color: var(--highlight-color);
						color: var(--bg-color);
					}

					a[aria-current="page"] {
						color: var(--highlight-color);
					}

					@media screen and (min-width: 800px) {
						padding: 0 2ch;
					}

					display: flex;
					flex-direction: row;
					justify-content: space-between;
					align-items: center;
					gap: 2ch;
				`}
			"
		>
			<div class=${navbarGroupLayout}>
				<a
					class=${navbarGroupLayout}
					aria-current=${url === "/" && "page"}
					style="gap: 1ch"
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
					href="/examples/"
					aria-current=${url.startsWith("/examples") && "page"}
				>Examples</a>
				<a
					href="/blog/"
					aria-current=${url.startsWith("/blog") && "page"}
				>Blog</a>
				<a
					href="/compatibility/"
					aria-current=${url.startsWith("/compatibility") && "page"}
				>Compatibility</a>
			</div>
			<div class=${navbarGroupLayout}>
				<a href="https://github.com/bikeshaving/termdom">GitHub</a>
				<a href="https://www.npmjs.com/package/@b9g/termdom">NPM</a>
				<${ColorSchemeToggle} />
			</div>
		</nav>
	`;
}
