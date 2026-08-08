import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {Root} from "../components/root.js";

export default function NotFound({url}: {url: string}) {
	return jsx`
		<${Root} title="TermDOM | Not found" url=${url} description="Page not found.">
			<main class=${css`
				max-width: 900px;
				margin: 0 auto;
				padding: 6rem 1.2rem 4rem;
			`}>
				<h1>404</h1>
				<p>
					There is no page at <code>${url}</code>.
				</p>
				<p>
					Try the <a href="/guides/getting-started/">guides</a>, the
					<a href="/compatibility/">compatibility matrix</a>, or
					<a href="/">the home page</a>.
				</p>
			</main>
		<//Root>
	`;
}
