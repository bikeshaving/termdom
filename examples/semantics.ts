/**
 * Text-level and grouping semantics on their user-agent defaults: what
 * unstyled prose HTML looks like on a terminal. The headings band is the
 * only author rule. Tab reaches the link and the disclosure; q quits.
 */

import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	body { margin: 0; padding: 0 1ch; }
	h2 { background-color: Highlight; color: HighlightText; padding-left: 1ch; }
	section { margin-top: 1px; }
`;
document.head.appendChild(style);

document.body.innerHTML = `
	<h1>semantics</h1>
	<section>
		<h2>text-level</h2>
		<p><b>b bold</b>, <em>em italic</em>, <u>u underline</u>,
		<s>s struck</s>, <code>code faint block</code>, <kbd>kbd</kbd>,
		<small>small lighter</small>, <cite>cite</cite>, <var>var</var>,
		and <a href="https://termdom.org">a link, underlined</a>.</p>
	</section>
	<section>
		<h2>headings</h2>
		<h1>h1</h1><h3>h3</h3><h6>h6</h6>
	</section>
	<section>
		<h2>grouping</h2>
		<blockquote>blockquote, indented</blockquote>
		<pre>pre   preserves   spacing
	and newlines</pre>
		<hr>
	</section>
	<section>
		<h2>disclosure</h2>
		<details>
			<summary>a closed details shows ▸</summary>
			<p>and an open one shows ▾, with this body revealed.</p>
		</details>
	</section>
	<section>
		<h2>hidden</h2>
		<p><button type="button" id="hide">toggle</button>
		<span id="target">the [hidden] attribute removes this span</span></p>
	</section>
	<p>tab moves · enter activates · drag to select · q quits</p>
`;

document.getElementById("hide")!.addEventListener("click", () => {
	document.getElementById("target")!.toggleAttribute("hidden");
});

document.addEventListener("keydown", (event) => {
	if ((event as KeyboardEvent).key === "q") {
		term.window.close();
	}
});

term.attach();
