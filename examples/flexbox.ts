// A page layout in flexbox: masthead, sidebar, article, footer. The
// sidebar is navigation: each entry selects an article.
//
//   node examples/flexbox.ts
//
//   ↑/↓  select a section
//   q    quit
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const SECTIONS = [
	{
		name: "Layout",
		body: "Every box on this screen is a div. The masthead is a flex row with space-between, the sidebar and this article split another, and lengths compute to cells: 1ch wide, 1px tall.",
	},
	{
		name: "Text",
		body: "Text wraps at the edge of its box, takes color, weight and underline from CSS, and reflows when the terminal is resized.",
	},
	{
		name: "Widgets",
		body: "input, textarea and select are real form controls rendered through user-agent shadow trees, with a caret, a placeholder and focus styles.",
	},
	{
		name: "Events",
		body: "The arrow keys changing this page are a keydown listener on the document. Clicks, focus and input arrive the same way, on real targets.",
	},
];

document.body.innerHTML = `
	<style>
		.page { border: 1px solid #444; }
		.masthead {
			display: flex; flex-direction: row; justify-content: space-between;
			padding: 0 1ch; border-bottom: 1px solid #444;
		}
		.brand { color: #5fafff; font-weight: bold; }
		.masthead nav { color: #888; }
		.middle { display: flex; flex-direction: row; }
		.sidebar { width: 12ch; padding: 0 1ch; border-right: 1px solid #444; }
		.sidebar div { color: #888; }
		.sidebar div.selected { color: #5fafff; font-weight: bold; }
		.article { flex: 1; padding: 0 1ch; }
		.article h2 { color: white; font-weight: bold; }
		.footer { color: #666; padding: 0 1ch; border-top: 1px solid #444; }
	</style>
	<div class="page">
		<div class="masthead"><span class="brand">TermDOM</span><nav>docs · examples · github</nav></div>
		<div class="middle">
			<div class="sidebar"></div>
			<div class="article"><h2></h2><p></p></div>
		</div>
		<div class="footer">↑/↓ select · q quits</div>
	</div>
`;

const sidebar = document.querySelector(".sidebar")!;
const heading = document.querySelector(".article h2")!;
const body = document.querySelector(".article p")!;

for (const section of SECTIONS) {
	const entry = document.createElement("div");
	entry.textContent = section.name;
	sidebar.appendChild(entry);
}

let selected = 0;
function show(index: number): void {
	selected = index;
	const entries = sidebar.children;
	for (let i = 0; i < entries.length; i++) {
		entries[i].className = i === selected ? "selected" : "";
	}
	heading.textContent = SECTIONS[selected].name;
	body.textContent = SECTIONS[selected].body;
}
show(0);

document.addEventListener("keydown", (ev) => {
	if (ev.key === "ArrowDown") show((selected + 1) % SECTIONS.length);
	else if (ev.key === "ArrowUp") {
		show((selected + SECTIONS.length - 1) % SECTIONS.length);
	} else if (ev.key === "q") term.window.close();
});
