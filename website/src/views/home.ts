import {jsx, Raw} from "@b9g/crank/standalone";
import {css} from "@emotion/css";
import {Marked} from "@b9g/crankdown";

import {Root} from "../components/root.js";
import {components} from "../components/marked-components.js";
import {assets, castGifs} from "../server.js";
import type {Example} from "../models/examples.js";
import {
	collectExamples,
	serializeExamples,
	collectWorkspaceFiles,
	EXAMPLES_SCRIPT_ID,
	FILES_SCRIPT_ID,
	SANDBOX_CONFIG_ID,
	serializeFiles,
} from "../models/examples.js";

const container = css`
	max-width: 100ch;
	margin: 0 auto;
	padding: calc(var(--bar-height) + 2lh) 2ch 2lh;
`;

/* The content is markdown (content/home.md); this styles what it emits. */
const content = css`
	figure.cast {
		margin: 1lh 0;
	}

	figure.cast img {
		display: block;
		max-width: 100%;
	}

	figure.cast figcaption {
		color: var(--muted-color);
	}

	figure.example {
		margin: 1lh 0;
		min-width: 0;
	}

	.example-preview {
		position: relative;
		padding: 1lh 2ch;
	}

	.example-preview::before {
		content: "";
		position: absolute;
		inset: 0.5lh 0.5ch;
		border: 1px solid currentColor;
		pointer-events: none;
	}

	.example-preview-bar {
		padding-bottom: 1lh;
		color: var(--muted-color);
		background: var(--rule) bottom 0.5lh center / 100% 1px no-repeat;
	}

	/* About the hydrated editor's height, so booting an embed does not move
	   the page under the reader. */
	.example-preview > pre {
		margin: 0;
		padding: 0;
		max-height: 21lh;
		overflow: auto;
	}

	.example-preview > pre::before {
		content: none;
	}

`;

/** The programs the page embeds live, as `example:id` names them. */
const EMBEDDED = [
	"hello-world",
	"styling",
	"flexbox",
	"form",
	"prism",
];

/* The examples bundle carries the engine, an emulator and a highlighter,
   so it loads when the first embed comes near rather than with the page. */
function examplesLoader(src: string): string {
	return `
const embeds = document.querySelectorAll("[data-example]");
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
	const embedded: Record<string, Example> = {};
	for (const example of examples) {
		if (EMBEDDED.includes(example.id)) embedded[example.id] = example;
	}

	return jsx`
		<${Root}
			title="TermDOM | Build terminal apps with HTML, CSS, and DOM"
			url=${url}
			description="TermDOM is a JavaScript library that displays HTML and CSS in the terminal. It draws actual DOM nodes to terminal output and redraws the screen when they mutate."
			stylesheets=${[assets.xtermCSS]}
		>
			<main data-pagefind-body class=${container}>
				<h1 class=${css`
					margin-bottom: 0;
					border-bottom: none;
				`}>termdom</h1>
				<p class=${css`
					color: var(--muted-color);
					margin: 0 0 2lh;
				`}>
					Build terminal apps with HTML, CSS, and DOM.
				</p>

				<div class=${content}>
					<${Marked}
						markdown=${body}
						components=${components}
						casts=${casts}
						examples=${embedded}
					/>
				</div>
			</main>
			<script type="application/json" id=${EXAMPLES_SCRIPT_ID}>
				<${Raw} value=${serializeExamples(Object.values(embedded))} />
			</script>
			<script type="application/json" id=${FILES_SCRIPT_ID}>
				<${Raw} value=${serializeFiles(files)} />
			</script>
			<script type="application/json" id=${SANDBOX_CONFIG_ID}>
				<${Raw} value=${JSON.stringify({termdom: assets.sandboxTermdomScript, nodefs: assets.virtualFSScript, worker: assets.sandboxWorkerScript})} />
			</script>
			<script type="module">
				<${Raw} value=${examplesLoader(assets.examplesScript)} />
			</script>
		<//Root>
	`;
}
