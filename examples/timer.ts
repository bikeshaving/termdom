// A Crank component rendered into termdom's document. Any framework that
// renders to the DOM renders to the terminal, unchanged.
//
// Written with Crank's `jsx` tagged template rather than JSX syntax, so it
// runs on any runtime with no build step and no transform.
//
//   node examples/timer.ts
import {TermDOM} from "@b9g/termdom";
import type {Context} from "@b9g/crank";
import {jsx} from "@b9g/crank/standalone";
import {renderer} from "@b9g/crank/dom";

const termDOM = new TermDOM();

function* Timer(this: Context) {
	let seconds = 0;
	const interval = setInterval(() => this.refresh(() => seconds++), 1000);
	for (const _props of this) {
		yield jsx`
			<div>
				${seconds} second${seconds !== 1 ? "s" : ""}
			</div>
		`;
	}

	clearInterval(interval);
}

const document = termDOM.document;
globalThis.Node = termDOM.window.Node;
globalThis.document = termDOM.document;
renderer.render(jsx`<${Timer} />`, document.body);
