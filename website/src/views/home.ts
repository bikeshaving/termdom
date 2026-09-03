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
	collectWorkspaceFiles,
	EXAMPLES_SCRIPT_ID,
	FILES_SCRIPT_ID,
	SANDBOX_CONFIG_ID,
	serializeFiles,
} from "../models/playground-examples.js";

const container = css`
	max-width: 900px;
	margin: 0 auto;
	padding: 5rem 1.2rem 2rem;
`;

/* The content is markdown (content/home.md); this styles what it emits. */
const content = css`
	figure.cast {
		margin: 2rem 0;
	}

	figure.cast img {
		display: block;
		max-width: 100%;
		border: 1px solid var(--border-color);
		border-radius: 8px;
	}

	figure.cast figcaption {
		margin-top: 0.5rem;
		font-size: 0.8rem;
		color: var(--muted-color);
	}

	figure.playground {
		margin: 2rem 0;
		min-width: 0;
	}

	.playground-preview {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		overflow: hidden;
		background-color: var(--surface-color);
	}

	.playground-preview-bar {
		padding: 0.5rem 0.7rem;
		font-size: 0.8rem;
		color: var(--muted-color);
		background-color: var(--bg-color);
		border-bottom: 1px solid var(--border-color);
	}

	/* About the hydrated editor's height, so booting an embed does not move
	   the page under the reader. */
	.playground-preview > pre {
		margin: 0;
		border: none;
		border-radius: 0;
		max-height: calc(1rem + 20 * 1.5em);
		overflow: auto;
	}

`;

/** The programs the page embeds live, as `playground:id` names them. */
const EMBEDDED = [
	"hello-world",
	"bar-chart",
	"flexbox",
	"form",
	"prism",
];

/* The playground bundle carries the engine, an emulator and a highlighter,
   so it loads when the first embed comes near rather than with the page. */
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
	const files = await collectWorkspaceFiles(
		await self.directories.open("repo"),
	);
	const playgrounds: Record<string, PlaygroundExample> = {};
	for (const example of examples) {
		if (EMBEDDED.includes(example.id)) playgrounds[example.id] = example;
	}

	return jsx`
		<${Root}
			title="TermDOM | Build terminal apps with HTML, CSS and the DOM"
			url=${url}
			description="TermDOM is a JavaScript library that displays HTML and CSS in the terminal. It draws actual DOM nodes to terminal output and redraws the screen when they mutate."
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
					Build terminal apps with HTML, CSS and the DOM.
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
			<script type="application/json" id=${FILES_SCRIPT_ID}>
				<${Raw} value=${serializeFiles(files)} />
			</script>
			<script type="application/json" id=${SANDBOX_CONFIG_ID}>
				<${Raw} value=${JSON.stringify({termdom: assets.sandboxTermdomScript, nodefs: assets.virtualFSScript})} />
			</script>
			<script type="module">
				<${Raw} value=${playgroundLoader(assets.playgroundScript)} />
			</script>
		<//Root>
	`;
}
