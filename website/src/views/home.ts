import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

import {Root} from "../components/root.js";
import {CodeBlock} from "../components/code-block.js";
import {CastPlayer} from "../components/cast-player.js";
import {staticURLs} from "../server.js";

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

const sectionNote = css`
	color: var(--muted-color);
	font-size: 0.9rem;
`;

const featureList = css`
	list-style: none;
	padding: 0;
	display: grid;
	gap: 1.25rem;
	grid-template-columns: 1fr;

	@media screen and (min-width: 700px) {
		grid-template-columns: 1fr 1fr;
	}

	li {
		margin: 0;
	}

	strong {
		color: var(--highlight-color);
		display: block;
		margin-bottom: 0.15rem;
	}

	p {
		margin: 0;
		font-size: 0.9rem;
		color: var(--muted-color);
	}
`;

const HELLO = `import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach(); // take the terminal -- the only call that does
const {document} = term;

const box = document.createElement("div");
box.style.backgroundColor = "blue";
box.style.color = "white";
box.style.padding = "0 1ch";
box.textContent = "Hello, terminal";

document.body.appendChild(box);
// No render call. Mutations are observed and painted on the next frame,
// exactly like a browser.`;

const SPINNER = `const spinner = document.createElement("span");
spinner.className = "spin";           // .spin { color: green }
section.appendChild(spinner);
setInterval(() => {
  spinner.textContent = frames[n++ % frames.length];
}, 30);                               // no render call -- mutations paint`;

const KEYS = `document.addEventListener("keydown", (ev) => {
  if (ev.key === "j") select(selected + 1);
  if (ev.key === "Enter") expand(rows()[selected]);
});
rows()[selected].scrollIntoView();`;

const FORM = `<div class="field">
  <div class="label">Name</div><input id="name">
</div>

field.addEventListener("input", updatePreview);`;

export default function Home({url}: {url: string}) {
	return jsx`
		<${Root}
			title="TermDOM | Build Terminal UIs with HTML, CSS and DOM"
			url=${url}
			description="A real DOM, a real cascade and a real CSS layout engine that paint to a terminal. No new API to learn, no native or WASM dependency."
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
					a real DOM, a real cascade, a real layout engine — rendered to your terminal
				</p>

				<p>
					TermDOM gives you a real DOM, a real cascade and a real CSS layout
					engine that paint to a terminal. You build a page; it renders in
					cells. No new API to learn, no native or WASM dependency.
				</p>

				<${CodeBlock} code=${HELLO} lang="ts" />

				<p class=${sectionNote}>
					One cell is <code>1ch</code> wide and <code>1px</code> tall. Every box
					lands on whole cells.
				</p>

				<h2>Write a web page. Get a TUI.</h2>
				<p>
					Every glyph below is a DOM element. The spinner is a
					<code>&lt;span&gt;</code> whose <code>textContent</code> mutates;
					painting is automatic, like the browser.
				</p>
				<${CodeBlock} code=${SPINNER} lang="ts" />
				<${CastPlayer}
					src=${staticURLs["casts/animated.cast"]}
					rows=${24}
					cols=${78}
					caption="examples/animated.ts"
				/>

				<h2>Interactivity is just DOM events.</h2>
				<p>
					A NERDTree-style file browser in ~200 lines of vanilla DOM:
					<code>querySelectorAll</code> for the rows, <code>classList</code> for
					the selection, <code>keydown</code> for the keys, and
					<code>scrollIntoView()</code> to move the camera.
				</p>
				<${CodeBlock} code=${KEYS} lang="ts" />
				<${CastPlayer}
					src=${staticURLs["casts/tree.cast"]}
					rows=${24}
					cols=${78}
					caption="examples/tree.ts"
				/>

				<h2>Real text input. Real caret. Real IME.</h2>
				<p>
					<code>&lt;input&gt;</code> elements with focus traversal and
					<code>:focus</code> styling ${" — "} and the caret is the real
					terminal cursor, so CJK input methods compose in the field, measured
					in cells.
				</p>
				<${CodeBlock} code=${FORM} lang="html" />
				<${CastPlayer}
					src=${staticURLs["casts/form.cast"]}
					rows=${24}
					cols=${78}
					caption="examples/form.ts"
				/>

				<h2>Why it can do this</h2>
				<ul class=${featureList}>
					<li>
						<strong>A real DOM</strong>
						<p>
							jsdom underneath; anything that renders to the DOM renders to
							the terminal.
						</p>
					</li>
					<li>
						<strong>Real CSS layout</strong>
						<p>
							Flexbox and table layout written from the spec, on an integer
							cell grid.
						</p>
					</li>
					<li>
						<strong>Form controls that behave</strong>
						<p>
							Inputs, textareas, selects and buttons, with focus traversal and
							real events.
						</p>
					</li>
					<li>
						<strong>Selection you can copy</strong>
						<p>
							Drag to select, styled through <code>::selection</code>, onto
							your clipboard over OSC 52 ${" — "} even across SSH.
						</p>
					</li>
					<li>
						<strong>Scrollback-native output</strong>
						<p>
							Output lands in real scrollback: searchable, permanent,
							resize-safe, and still mutable.
						</p>
					</li>
					<li>
						<strong>Bidirectional text</strong>
						<p>
							Hebrew and Arabic in the right order, with contextual letter
							forms and a negotiated terminal contract.
						</p>
					</li>
					<li>
						<strong>Framework-agnostic</strong>
						<p>
							Anything that renders to a DOM works unchanged ${" — "} including
							TodoMVC on its own unmodified markup.
						</p>
					</li>
					<li>
						<strong>No native code</strong>
						<p>
							Pure JavaScript all the way to the escape sequences, on Node,
							Bun and Deno alike ${" — "} and it compiles to a single binary.
						</p>
					</li>
				</ul>

				<h2>Honest about the rest</h2>
				<p>
					Support is measured, not asserted: a generator applies each feature to
					a real document, renders it to a terminal buffer, and records whether
					anything a reader could see actually changed. All 487 standard CSS
					properties are accounted for.
				</p>
				<p>
					<a href="/support/">Read the support matrix ${"→"}</a>
				</p>

				<h2>Get started</h2>
				<${CodeBlock} code=${"npm install @b9g/termdom"} lang="sh" />
				<p>
					<a href="/guides/getting-started/">Guides ${"→"}</a>
					${"  ·  "}
					<a href="/examples/">Examples ${"→"}</a>
				</p>
			</main>
		<//Root>
	`;
}
