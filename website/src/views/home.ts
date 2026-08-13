import {jsx, Raw} from "@b9g/crank/standalone";
import {css} from "@emotion/css";
import {Marked} from "@b9g/crankdown";

import {Root} from "../components/root.js";
import {components} from "../components/marked-components.js";
import {assets, castGifs} from "../server.js";
import type {PlaygroundExample} from "../models/playground-examples.js";
import {
	collectExamples,
	serializeExamples,
	EXAMPLES_SCRIPT_ID,
} from "../models/playground-examples.js";

const container = css`
	max-width: 900px;
	margin: 0 auto;
	padding: 5rem 1.2rem 2rem;
`;

const heroCommand = css`
	background-color: var(--surface-color);
	border: 1px solid var(--border-color);
	border-radius: 8px;
	padding: 1.1rem 1.5rem;
	font-size: 1.5rem;
	text-align: center;
	margin: 0;
	user-select: all;
	color: var(--text-color);
`;

const heroNote = css`
	color: var(--muted-color);
	text-align: center;
	font-size: 0.85rem;
	margin: 0.75rem 0 3.5rem;
`;

/* The content is markdown (content/home.md); this styles what it emits.
   The one structural opinion: the "Why it can do this" list renders as a
   two-column feature grid. */
const content = css`
	figure.cast {
		margin: 1.5rem 0;
	}

	figure.cast img {
		display: block;
		max-width: 100%;
		border-radius: 6px;
	}

	/* A live embed: the program until it comes near, an editor and a terminal
	   after. Both states are the same width as the prose above them. */
	figure.playground {
		margin: 1.5rem 0;
		min-width: 0;
	}

	/* Held to about the height the editor takes, so hydrating an embed does
	   not move the page under whoever is reading it. */
	figure.playground > pre {
		margin: 0;
		max-height: 420px;
		overflow: auto;
	}

	ul {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 1.25rem;
		grid-template-columns: 1fr;

		@media screen and (min-width: 700px) {
			grid-template-columns: 1fr 1fr;
		}
	}

	ul li {
		margin: 0;
		font-size: 0.9rem;
		color: var(--muted-color);
	}

	ul li strong {
		color: var(--highlight-color);
		display: block;
		margin-bottom: 0.15rem;
	}
`;

/**
 * The programs the page embeds live, keyed the way `playground:id` names them.
 * A recording is still the right answer where the program cannot run in a
 * browser: solitaire needs an import the runner cannot resolve, and the tree
 * browser needs a filesystem.
 */
const EMBEDDED = ["animated", "form"];

/**
 * Fetch the playground bundle when the first embed comes near, rather than
 * with the page. It carries the engine, an emulator and a highlighter, which
 * is a lot to hand someone who came to read.
 */
function playgroundLoader(src: string): string {
	return `
const embeds = document.querySelectorAll("[data-playground]");
if (embeds.length) {
	const observer = new IntersectionObserver((entries) => {
		if (!entries.some((entry) => entry.isIntersecting)) return;
		observer.disconnect();
		import(${JSON.stringify(src)});
	}, {rootMargin: "600px"});
	for (const embed of embeds) observer.observe(embed);
}
`;
}

export default async function Home({url}: {url: string}) {
	// Resolved at call time: server.ts imports the views (the router), so a
	// module-level read of its exports lands mid-cycle, before they exist.
	const casts = castGifs;
	const contentDir = await self.directories.open("content");
	const file = await (await contentDir.getFileHandle("home.md")).getFile();
	const body = await file.text();

	const examples = await collectExamples(
		await self.directories.open("examples"),
	);
	const playgrounds: Record<string, PlaygroundExample> = {};
	for (const example of examples) {
		if (EMBEDDED.includes(example.id)) playgrounds[example.id] = example;
	}

	return jsx`
		<${Root}
			title="TermDOM | Build Terminal UIs with HTML, CSS and DOM"
			url=${url}
			description="A real DOM, a real cascade and a real CSS layout engine that paint to a terminal. No new API to learn, no native or WASM dependency."
			stylesheets=${[assets.xtermCSS]}
		>
			<main data-pagefind-body class=${container}>
				<h1 class=${css`
					font-size: 2.2rem;
					margin-bottom: 0.5rem;
				`}>termdom</h1>
				<p class=${css`
					color: var(--muted-color);
					margin: 0 0 2.5rem;
					font-size: 1.05rem;
				`}>
					Build Terminal UIs with HTML, CSS and DOM.
				</p>

				<p class=${heroCommand}>npm install @b9g/termdom</p>
				<p class=${heroNote}>
					a real DOM, a real cascade, a real layout engine ${"—"} rendered to your terminal
				</p>

				<div class=${content}>
					<${Marked}
						markdown=${body}
						components=${components}
						casts=${casts}
						playgrounds=${playgrounds}
					/>
				</div>
			</main>
			<script type="application/json" id=${EXAMPLES_SCRIPT_ID}>
				<${Raw} value=${serializeExamples(Object.values(playgrounds))} />
			</script>
			<script type="module">
				<${Raw} value=${playgroundLoader(assets.playgroundScript)} />
			</script>
		<//Root>
	`;
}
