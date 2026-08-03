import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {Root} from "../components/root.js";

const REPO = "https://github.com/bikeshaving/termdom/blob/main/examples";

const EXAMPLES: Array<{file: string; shows: string}> = [
	{
		file: "tree.ts",
		shows: "NERDTree-style file tree: navigation, lazy loading, camera-follow.",
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
	{
		file: "todomvc.tsx",
		shows:
			"TodoMVC on its own unmodified markup and logic, rendered under Crank.",
	},
	{file: "todo-app.ts", shows: "A small interactive app in vanilla DOM."},
	{file: "tanstack-table.ts", shows: "TanStack Table driving a real <table>."},
	{file: "timer.tsx", shows: "A Crank component rendered to the terminal."},
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
		file: "fullscreen-demo.ts",
		shows: "The Fullscreen API over the alternate screen.",
	},
	{
		file: "ssh-server.ts",
		shows:
			"The whole library behind an SSH server; every connection gets its own DOM.",
	},
	{file: "hello-world.ts", shows: "The smallest possible document."},
	{file: "flexbox-demo.ts", shows: "Flex containers, wrapping and alignment."},
	{file: "borders.ts", shows: "Border styles, collapsing and box drawing."},
	{file: "lists.ts", shows: "Markers, counters and nested list gutters."},
	{file: "input-styles.ts", shows: "Styling the built-in form controls."},
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
