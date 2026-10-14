import {measure, TermDOM} from "../harness.ts";

const rows = Array.from(
	{length: 1000},
	(_, i) => `<tr><td>${i}</td><td class=a>row ${i}</td><td><b>x</b></td></tr>`,
).join("");
const html =
	`<style>td { padding: 0 1ch } .a { color: red }</style><table>${rows}</table>`;
await measure(
	"table: render 1000 rows",
	7,
	() => {
		new TermDOM({html}).renderANSI();
	},
	2,
);
