import {measure, TermDOM} from "../harness.ts";

const term = new TermDOM();
const {document} = term;
await measure(
	"dom: build, render and remove 20000 spans",
	15,
	() => {
		const root = document.createElement("div");
		document.body.appendChild(root);
		for (let k = 0; k < 20000; k++) {
			const span = document.createElement("span");
			span.className = `c${k % 7}`;
			span.textContent = "t";
			root.appendChild(span);
		}
		root.remove();
		term.renderANSI();
	},
	3,
);
term.dispose();
