import {TermDOM} from "@b9g/termdom";
import {marked} from "marked";
import {markedHighlight} from "marked-highlight";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";

// Prism is a browser syntax highlighter; here it tokenises fenced code blocks
// into <span class="token ..."> markup that the theme below colours. Loaded
// through createRequire because its language packs are CommonJS side-effects.
const require = createRequire(import.meta.url);
const Prism = require("prismjs");
require("prismjs/components/index.js")([
	"javascript",
	"typescript",
	"json",
	"bash",
	"css",
	"python",
]);

// marked and marked-highlight are standard Node/browser libraries used here
// completely unmodified -- the whole point: a real web toolchain feeding a real
// DOM. marked-highlight routes each code block through Prism.
marked.use(
	markedHighlight({
		highlight(code: string, lang: string): string {
			const grammar = Prism.languages[lang];
			if (grammar) {
				return Prism.highlight(code, grammar, lang);
			}
			return code
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
		},
	}),
);

// The sample document, inline: the example is self-contained -- one file to
// read, one to run, no sidecar to locate at runtime.
const SAMPLE = `# Markdown in the Terminal

A single document that exercises the whole element set, rendered from real
Markdown through the **marked** library into a real DOM.

## Inline formatting

Text can be **bold**, *italic*, ***both***, \`inline code\`, ~~struck through~~,
and a [labelled link](https://example.com). Links are underlined by the user
agent; Tab through the document to see a focus ring land on each one.

### Third-level heading
#### Fourth-level heading
##### Fifth-level heading
###### Sixth-level heading

## Lists

An unordered list, with nesting:

- First item
- Second item
  - A nested item
  - Another, with \`code\`
- Third item

An ordered list:

1. Parse the Markdown
2. Build the DOM
3. Render to cells

A task list (GitHub-flavoured, rendered as real checkboxes):

- [x] Write the parser adapter
- [x] Style the headings
- [x] Add a fixed status line

## Blockquote

> The best way to predict the future is to invent it.
>
> Simple things should be simple, complex things should be possible.

## Code block

\`\`\`js
function greet(name) {
  return \`Hello, \${name}!\`;
}
console.log(greet("world"));
\`\`\`

Syntax highlighting comes from Prism, another unmodified web library, across
languages:

\`\`\`json
{
  "name": "termdom",
  "renders": ["markdown", "code"],
  "highlighted": true
}
\`\`\`

## Table

| Element     | Display    | Notes                       |
| ----------- | ---------- | --------------------------- |
| \`h1\`–\`h6\`   | block      | themed bold, coloured       |
| \`blockquote\`| block      | left rule via \`border-left\` |
| \`pre\`       | block      | dark background, monospace  |
| \`table\`     | table      | ruled by the UA stylesheet  |

## Horizontal rule

Above the rule.

---

Below the rule.

## Wrapping

This final paragraph is deliberately long so that it wraps across several
terminal columns, demonstrating that inline text reflows to the viewport width
just as it would in a browser, breaking on word boundaries rather than spilling
off the right edge of the screen.
`;

const file = process.argv[2];
const source = file ? readFileSync(file, "utf8") : SAMPLE;
const html = marked.parse(source, {async: false}) as string;

const term = new TermDOM();

term.attach();
const {document, window} = term;

// A compact terminal theme. The UA sheet already makes links underlined and
// tables ruled; this adds the heading hierarchy, code and blockquote styling a
// Markdown reader wants. Everything here is ordinary author CSS.
const style = document.createElement("style");
style.textContent = `
	article { padding: 0 1ch; }
	h1, h2, h3, h4, h5, h6 { font-weight: bold; margin-top: 1px; }
	h1 { color: #ff8700; text-decoration: underline; }
	h2 { color: #ffaf00; }
	h3 { color: #ffd700; }
	h4, h5, h6 { color: #afaf00; }
	p { margin-top: 1px; }
	a { color: #5fafff; }
	code { color: #ff5f5f; }
	pre { background-color: #1c1c1c; color: #d0d0d0; padding: 0 1ch; margin-top: 1px; }
	pre code { color: inherit; background-color: transparent; }
	li:has(> input[type="checkbox"]) { list-style: none; }

	/* Prism token theme (Monokai-ish), scoped to highlighted code. */
	.token.comment, .token.prolog, .token.doctype, .token.cdata { color: #75715e; }
	.token.punctuation { color: #808080; }
	.token.property, .token.tag, .token.constant, .token.symbol { color: #f92672; }
	.token.boolean, .token.number { color: #ae81ff; }
	.token.selector, .token.attr-name, .token.string, .token.char, .token.builtin { color: #a6e22e; }
	.token.operator, .token.entity, .token.url { color: #d0d0d0; }
	.token.atrule, .token.attr-value, .token.keyword { color: #66d9ef; }
	.token.function, .token.class-name { color: #e6db74; }
	.token.regex, .token.important, .token.variable { color: #fd971f; }
	blockquote { border-left: 1px solid #5f5f5f; padding-left: 1ch; color: #8a8a8a; margin-top: 1px; }
	ul, ol { margin-top: 1px; }
	li > ul, li > ol { margin-top: 0; }
	hr { color: #444444; margin-top: 1px; }
	th { font-weight: bold; color: #ffd700; }
	del { text-decoration: line-through; }

	/* The pager's status line: position: fixed pins it to the VIEWPORT, so
	   the camera scrolls the document underneath it -- the same contract as
	   a web page's sticky footer. The body pads for it, as a web page pads
	   for its own fixed footer, so the last line can scroll clear of it. */
	body { padding-bottom: 1px; }
	.status {
		position: fixed;
		bottom: 0;
		left: 0;
		width: 100%;
		background-color: #262626;
		color: #9e9e9e;
		padding: 0 1ch;
	}
	.status .pct { position: absolute; right: 1ch; top: 0; color: #ffd700; }
`;
document.head.appendChild(style);

const article = document.createElement("article");
article.innerHTML = html;
document.body.appendChild(article);

// Let layout settle and the first frame paint before measuring the page.
await new Promise<void>((r) => window.requestAnimationFrame(() => r()));

// Flow mode: a page that fits (or output that isn't a terminal, e.g. piped to a
// file) just prints and exits -- dispose pays the whole document out to the
// terminal's scrollback on the way.
const fits = document.body.scrollHeight <= window.innerHeight;
if (!process.stdout.isTTY || fits) {
	term.window.close();
}

// Pager mode: the document is taller than the screen, so move the camera over
// it. window.scrollBy IS the camera (clamped to the document), so this is the
// same scrolling any web page gets -- no terminal-specific plumbing.
function page() {
	return Math.max(1, window.innerHeight - 1);
}
function height() {
	return document.body.scrollHeight;
}

// The status line the sample's own task list asked for.
const status = document.createElement("div");
status.className = "status";
const statusName = document.createElement("span");
statusName.textContent = `${file?.split("/").pop() ?? "sample"} · j/k scroll · q quit`;
const pct = document.createElement("span");
pct.className = "pct";
status.append(statusName, pct);
document.body.appendChild(status);

function updateStatus() {
	const max = Math.max(1, height() - window.innerHeight);
	pct.textContent = `${Math.min(100, Math.round((window.scrollY / max) * 100))}%`;
}
updateStatus();
const bindings: Record<string, () => void> = {
	"q": () => {
		term.window.close();
	},
	" ": () => window.scrollBy(0, page()),
	"f": () => window.scrollBy(0, page()),
	"PageDown": () => window.scrollBy(0, page()),
	"b": () => window.scrollBy(0, -page()),
	"PageUp": () => window.scrollBy(0, -page()),
	"j": () => window.scrollBy(0, 1),
	"ArrowDown": () => window.scrollBy(0, 1),
	"k": () => window.scrollBy(0, -1),
	"ArrowUp": () => window.scrollBy(0, -1),
	"g": () => window.scrollBy(0, -height()),
	"G": () => window.scrollBy(0, height()),
};
document.addEventListener("keydown", (event: Event) => {
	bindings[(event as KeyboardEvent).key]?.();
	updateStatus();
});
