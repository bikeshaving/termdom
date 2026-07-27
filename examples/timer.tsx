// A Crank component rendered into termdom's document. Any framework that
// renders to the DOM renders to the terminal, unchanged.
//
//   bun examples/timer.tsx
import {TermDOM} from "../src/index.js";
import type {Context} from "@b9g/crank";
import {renderer} from "@b9g/crank/dom";

const termDOM = new TermDOM();

function* Timer(this: Context) {
	let seconds = 0;
	const interval = setInterval(() => this.refresh(() => seconds++), 1000);
	for (const _props of this) {
		yield (
			<div>
				{seconds} second{seconds !== 1 && "s"}
			</div>
		);
	}

	clearInterval(interval);
}

const document = termDOM.document;
globalThis.Node = termDOM.window.Node;
globalThis.document = termDOM.document;
renderer.render(<Timer />, document.body);
