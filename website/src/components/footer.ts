import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

export function Footer() {
	return jsx`
		<footer
			class=${css`
				background-color: var(--bg-color);
				border-top: 1px solid var(--border-color);
				padding: 2em;
				text-align: center;
				font-size: 0.85rem;
			`}
		>
			<nav
				class=${css`
					display: flex;
					justify-content: center;
					gap: 2em;
					flex-wrap: wrap;
					margin-bottom: 1em;
				`}
			>
				<a href="/guides/getting-started/">Guides</a>
				<a href="/support/">Support</a>
				<a href="https://github.com/bikeshaving/termdom">GitHub</a>
				<a href="https://www.npmjs.com/package/@b9g/termdom">NPM</a>
			</nav>
			<p
				class=${css`
					margin: 0;
					color: var(--muted-color);
				`}
			>
				MIT Licensed ${"·"} A ${jsx`<a href="https://bikeshaving.org">bikeshaving</a>`} project
			</p>
		</footer>
	`;
}
