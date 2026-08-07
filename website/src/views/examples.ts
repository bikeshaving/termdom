import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {Root} from "../components/root.js";

const REPO = "https://github.com/bikeshaving/termdom/blob/main/examples";

const EXAMPLES: Array<{file: string; shows: string}> = [
	{file: "hello-world.ts", shows: "The smallest possible document."},
	{
		file: "todomvc.ts",
		shows:
			"TodoMVC on its own unmodified logic, rendered under Crank -- plain node runs it.",
	},
	{
		file: "markdown.ts",
		shows:
			"A Markdown viewer (marked + Prism): flow mode when it fits, a pager when it doesn't.",
	},
	{
		file: "chat.ts",
		shows:
			"A streaming LLM chat client: transcript, composer, tokens reflowing live.",
	},
	{
		file: "password.ts",
		shows: "A password strength meter: a masked input driving live checks.",
	},
	{
		file: "tree.ts",
		shows: "NERDTree-style file tree: navigation, lazy loading, camera-follow.",
	},
	{
		file: "fuzzy-finder.ts",
		shows: "An fzf-style picker: filtering, selection, live highlighting.",
	},
	{
		file: "git-log.ts",
		shows: "A scrolling git log: real repository data in a navigable list.",
	},
	{
		file: "form.ts",
		shows:
			"Text inputs, Tab focus, :focus styling, live preview, IME-correct carets.",
	},
	{
		file: "commit-editor.ts",
		shows: "A git-commit editor: input, textarea and select together.",
	},
	{file: "tanstack-table.ts", shows: "TanStack Table driving a real <table>."},
	{
		file: "animated.ts",
		shows: "An animated frame that respects your shell history.",
	},
	{
		file: "rtl.ts",
		shows:
			"Hebrew and Arabic: visual reordering, direction: rtl, embedded Latin.",
	},
	{
		file: "fullscreen.ts",
		shows: "The Fullscreen API over the alternate screen.",
	},
	{file: "flexbox.ts", shows: "Flex containers, wrapping and alignment."},
	{file: "borders.ts", shows: "Border styles, collapsing and box drawing."},
	{file: "lists.ts", shows: "Markers, counters and nested list gutters."},
];

export default function Examples({url}: {url: string}) {
	return jsx`
		<${Root}
			title="TermDOM | Examples"
			url=${url}
			description="Runnable TermDOM examples: file trees, forms, TodoMVC, tables, SSH servers and layout showcases."
		>
			<main data-pagefind-body class=${css`
				max-width: 900px;
				margin: 0 auto;
				padding: 5rem 1.2rem 2rem;
			`}>
				<h1>Examples</h1>
				<p>
					Every example below is a single file in the repository. Clone it, run
					<code>npm install &amp;&amp; npm run build</code> once, then run any of
					them with <code>node examples/&lt;file&gt;</code>.
				</p>
				<p class=${css`
					color: var(--muted-color);
					font-size: 0.9rem;
				`}>
					Each one imports <code>@b9g/termdom</code> exactly as your own code
					would, so they run on Node, Bun and Deno alike. The exception is
					<code>todomvc.tsx</code>, which is JSX and needs a transform ${" — "}
					run it with Bun, or any JSX-aware runner.
				</p>

				<table>
					<thead>
						<tr><th>example</th><th>shows</th></tr>
					</thead>
					<tbody>
						${EXAMPLES.map(
							({file, shows}) => jsx`
								<tr>
									<td class=${css`
										white-space: nowrap;
									`}>
										<a href=${`${REPO}/${file}`}><code>${file}</code></a>
									</td>
									<td>${shows}</td>
								</tr>
							`,
						)}
					</tbody>
				</table>
			</main>
		<//Root>
	`;
}
