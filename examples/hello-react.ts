// React's stock DOM renderer, rendering into the terminal's document.
//
//   node examples/hello-react.ts
//
//   any key  increments the counter
//   q        quit
import {TermDOM} from "@b9g/termdom";
import htm from "htm";
import {createElement, useEffect, useState} from "react";
import {createRoot} from "react-dom/client";

// JSX without a build step: htm parses the same shape from a template
// literal, straight to createElement.
const html = htm.bind(createElement);

const term = new TermDOM();
term.attach();
const {document} = term;
// react-dom reads `window.event` to pick an update priority, and
// `document.documentMode` and `"TextEvent" in window` to detect input features.
globalThis.document = document as never;
globalThis.window = term.window as never;

const style = document.createElement("style");
style.textContent = `
	.card { border: 1px solid #5fafff; padding: 0 1ch; margin: 1px 2ch; }
	.greeting { color: cyan; font-weight: bold; }
	.count { color: #ffd75f; }
	.hint { color: #666666; margin-left: 2ch; }
`;
document.head.appendChild(style);

function Hello() {
	const [count, setCount] = useState(0);
	useEffect(() => {
		const onkeydown = (ev: any) => {
			if (ev.key === "q") {
				term.window.close();
				return;
			}

			setCount((value) => value + 1);
		};

		document.addEventListener("keydown", onkeydown);
		return () => document.removeEventListener("keydown", onkeydown);
	}, []);

	return html`
		<div>
			<div className="card">
				<div className="greeting">Hello from React!</div>
				<div className="count">Keys pressed: ${count}</div>
			</div>
			<div className="hint">any key counts · [q]uit</div>
		</div>
	`;
}

createRoot(document.body as never).render(createElement(Hello));
