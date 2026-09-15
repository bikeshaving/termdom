import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

export function Footer() {
	return jsx`
		<footer
			class=${css`
				background: var(--rule) top 0.5lh center / 100% 1px no-repeat var(--bg-color);
				padding: 2lh 2ch 1lh;
				text-align: center;
			`}
		>
			<nav
				class=${css`
					display: flex;
					justify-content: center;
					gap: 2ch;
					flex-wrap: wrap;
					margin-bottom: 1lh;
				`}
			>
				<a href="/guides/getting-started/">Guides</a>
				<a href="/examples/">Examples</a>
				<a href="/blog/">Blog</a>
				<a href="/compatibility/">Compatibility</a>
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
