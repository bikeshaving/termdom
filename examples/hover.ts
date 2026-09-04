// Hover: a :hover rule and the mouseover family
//
//   node examples/hover.ts
//
//   Move the mouse over the swatches. The one under the pointer lights up
//   by a :hover rule, and the status line names it from mouseover. The
//   terminal reports mouse motion only while something observes it, so a
//   page with no :hover rule and no hover listener costs the terminal
//   nothing.
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const COLORS = [
	["Red", "#e63946"],
	["Orange", "#f77f00"],
	["Yellow", "#ffd166"],
	["Green", "#06d6a0"],
	["Blue", "#118ab2"],
	["Purple", "#8338ec"],
];

document.head.innerHTML = `
	<style>
		h1 { color: cyan; }
		.swatches { display: flex; flex-direction: row; gap: 1ch;
		            border: 1px solid #444444; padding: 0 1ch; }
		.swatches:hover { border-color: white; }
		.swatch { padding: 1px 2ch; color: black; }
		.swatch:hover { font-weight: bold; text-decoration: underline; }
		a { color: cyan; }
		a:hover { color: white; background-color: blue; }
		.status { margin-top: 1px; color: gray; }
	</style>
`;

document.body.innerHTML = `
	<h1>Hover</h1>
	<div class="swatches">
		${COLORS.map(
			([name, hex]) =>
				`<div class="swatch" style="background-color: ${hex}">${name}</div>`,
		).join("")}
	</div>
	<p>Links respond too: <a>one</a>, <a>two</a>, <a>three</a>.</p>
	<p class="status">Nothing under the pointer.</p>
	<p>Press q or Ctrl+C to quit.</p>
`;

const status = document.querySelector(".status")!;
const swatches = document.querySelector(".swatches")!;

swatches.addEventListener("mouseover", (event) => {
	const swatch = (event.target as Element).closest(".swatch");
	if (swatch) {
		status.textContent = `Over ${swatch.textContent}.`;
	}
});

swatches.addEventListener("mouseleave", () => {
	status.textContent = "Nothing under the pointer.";
});

document.addEventListener("keydown", (event) => {
	if (event.key === "q") {
		term.window.close();
	}
});
