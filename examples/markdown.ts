#!/usr/bin/env node
// Render a Markdown file to the terminal: `marked` (an unmodified web library)
// turns it into HTML, TermDOM renders that HTML with a small CSS theme. A good
// stress test -- headings, lists, tables, code, blockquotes, task lists, rules
// all in one document.
//
// If the rendered page fits the viewport it prints and exits (flow mode); if it
// is taller, it stays open as a pager and the camera scrolls over it.
//
//   node examples/markdown.ts [file.md]
//
//   space / f     page down     b        page up
//   j / Down      line down     k / Up   line up
//   g / G         top / bottom  q        quit
import {TermDOM} from "@b9g/termdom";
import {marked} from "marked";
import {markedHighlight} from "marked-highlight";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
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
			if (grammar) return Prism.highlight(code, grammar, lang);
			return code
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
		},
	}),
);

const file = process.argv[2]
	? process.argv[2]
	: fileURLToPath(new URL("sample.md", import.meta.url));
const source = readFileSync(file, "utf8");
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
`;
document.head.appendChild(style);

const article = document.createElement("article");
article.innerHTML = html;
document.body.appendChild(article);

// Let layout settle and the first frame paint before measuring the page.
await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
await new Promise<void>((r) => window.requestAnimationFrame(() => r()));

// Flow mode: a page that fits (or output that isn't a terminal, e.g. piped to a
// file) just prints and exits -- dispose pays the whole document out to the
// terminal's scrollback on the way.
const fits = document.body.scrollHeight <= window.innerHeight;
if (!process.stdout.isTTY || fits) {
	term.dispose();
	process.exit(0);
}

// Pager mode: the document is taller than the screen, so move the camera over
// it. window.scrollBy IS the camera (clamped to the document), so this is the
// same scrolling any web page gets -- no terminal-specific plumbing.
const page = () => Math.max(1, window.innerHeight - 1);
const height = () => document.body.scrollHeight;
const bindings: Record<string, () => void> = {
	q: () => {
		term.dispose();
		process.exit(0);
	},
	" ": () => window.scrollBy(0, page()),
	f: () => window.scrollBy(0, page()),
	PageDown: () => window.scrollBy(0, page()),
	b: () => window.scrollBy(0, -page()),
	PageUp: () => window.scrollBy(0, -page()),
	j: () => window.scrollBy(0, 1),
	ArrowDown: () => window.scrollBy(0, 1),
	k: () => window.scrollBy(0, -1),
	ArrowUp: () => window.scrollBy(0, -1),
	g: () => window.scrollBy(0, -height()),
	G: () => window.scrollBy(0, height()),
};
document.addEventListener("keydown", (event: Event) => {
	bindings[(event as KeyboardEvent).key]?.();
});
