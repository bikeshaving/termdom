import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {Root} from "../components/root.js";

export default function NotFound({url}: {url?: string}) {
	return jsx`
		<${Root} title="TermDOM | Not found" url=${url ?? "/404.html"} description="Page not found.">
			<main class=${css`
				max-width: 100ch;
				margin: 0 auto;
				padding: calc(var(--bar-height) + 2lh) 2ch 2lh;
			`}>
				<h1>404</h1>
				<p>
					${
						url
							? jsx`There is no page at <code>${url}</code>.`
							: "That page does not exist."
					}
				</p>
				<p>
					Try the <a href="/guides/getting-started/">guides</a>, the
					<a href="/examples/">examples</a>, the <a href="/blog/">blog</a>,
					the <a href="/compatibility/">compatibility matrix</a>, or
					<a href="/">the home page</a>.
				</p>
			</main>
		<//Root>
	`;
}
