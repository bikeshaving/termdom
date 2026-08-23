/**
 * Tables on their user-agent defaults: collapsed borders, bold header
 * cells, caption above. The season selector rebuilds the body to show
 * the borders re-collapse around changing content. q quits.
 */

import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	body { margin: 0; padding: 0 1ch; }
	h1 { background-color: Highlight; color: HighlightText; padding-left: 1ch; }
	p { margin-top: 1px; }
`;
document.head.appendChild(style);

const SEASONS: Record<string, Array<[string, string, string]>> = {
	spring: [
		["daffodil", "march", "yellow"],
		["tulip", "april", "red"],
		["lilac", "may", "purple"],
	],
	autumn: [
		["aster", "september", "violet"],
		["chrysanthemum", "october", "gold"],
	],
};

document.body.innerHTML = `
	<h1>table</h1>
	<p><label>season <select id="season">
		<option>spring</option>
		<option>autumn</option>
	</select></label></p>
	<table>
		<caption>bloom calendar</caption>
		<thead><tr><th>flower</th><th>month</th><th>color</th></tr></thead>
		<tbody id="rows"></tbody>
	</table>
	<p>tab · enter opens the picker · q quits</p>
`;

const rows = document.getElementById("rows")!;
function fill(season: string): void {
	rows.textContent = "";
	for (const [flower, month, color] of SEASONS[season]) {
		const tr = document.createElement("tr");
		for (const text of [flower, month, color]) {
			const td = document.createElement("td");
			td.textContent = text;
			tr.appendChild(td);
		}
		rows.appendChild(tr);
	}
}
fill("spring");

const select = document.getElementById("season") as HTMLSelectElement;
select.addEventListener("change", () => fill(select.value));

document.addEventListener("keydown", (event) => {
	if ((event as KeyboardEvent).key === "q") {
		term.window.close();
	}
});

term.attach();
