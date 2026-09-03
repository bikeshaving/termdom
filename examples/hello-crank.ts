// Crank's stock DOM renderer, rendering into the terminal's document.
//
//   node examples/hello-crank.ts
//
//   any key  increments the counter
//   q        quit
import type {Context} from "@b9g/crank";
import {renderer} from "@b9g/crank/dom";
import {jsx} from "@b9g/crank/standalone";
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	.card { border: 1px solid #5fafff; padding: 0 1ch; margin: 1px 2ch; }
	.greeting { color: cyan; font-weight: bold; }
	.count { color: #ffd75f; }
	.hint { color: #666666; margin-left: 2ch; }
`;
document.head.appendChild(style);

function* Hello(this: Context) {
	let count = 0;
	document.addEventListener("keydown", (ev: any) => {
		if (ev.key === "q") {
			term.window.close();
			return;
		}

		this.refresh(() => count++);
	});

	// The empty pattern is Crank's idiom for a component that takes no props.

	for ({} of this) {
		yield jsx`
			<div class="card">
				<div class="greeting">Hello from Crank!</div>
				<div class="count">Keys pressed: ${count}</div>
			</div>
			<div class="hint">any key counts${" · "}<b>[q]</b>uit</div>
		`;
	}
}

renderer.render(jsx`<${Hello} />`, document.body);
