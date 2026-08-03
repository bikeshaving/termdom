import {jsx, Raw} from "@b9g/crank/standalone";
import {css} from "@emotion/css";
import Prism from "prismjs";

// Prism's language components are side-effect modules that look for a global
// `Prism`. In bundled ESM the import above is only a local binding, so hand
// them the global they expect before loading any of them.
(globalThis as unknown as {Prism: typeof Prism}).Prism = Prism;
Prism.manual = true;

import "prismjs/components/prism-markup.js";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-bash.js";

const ALIASES: Record<string, string> = {
	ts: "typescript",
	js: "javascript",
	sh: "bash",
	shell: "bash",
	html: "markup",
	console: "bash",
};

/**
 * Highlighting happens here, on the server, once per build. A reader gets
 * coloured code with no JavaScript at all -- which is the right trade for a
 * documentation site whose code samples never change after deploy.
 */
export function CodeBlock({code, lang = "ts"}: {code: string; lang?: string}) {
	const language = ALIASES[lang] ?? lang;
	const grammar = Prism.languages[language];
	const html = grammar
		? Prism.highlight(code, grammar, language)
		: escapeHTML(code);

	return jsx`
		<pre class="language-${language} ${css`
			margin: 1.25rem 0;
		`}"><code class="language-${language}"><${Raw} value=${html} /></code></pre>
	`;
}

function escapeHTML(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
