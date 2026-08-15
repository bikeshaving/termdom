// React's stock DOM renderer, rendering into the terminal's document.
//
//   node examples/hello-react.ts
//
//   any key  increments the counter
//   q        quit
import {TermDOM} from "@b9g/termdom";
import {createElement as h, useEffect, useState} from "react";
import {createRoot} from "react-dom/client";

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

	return h(
		"div",
		null,
		h(
			"div",
			{className: "card"},
			h("div", {className: "greeting"}, "Hello from React!"),
			h("div", {className: "count"}, `Keys pressed: ${count}`),
		),
		h("div", {className: "hint"}, "any key counts · [q]uit"),
	);
}

createRoot(document.body as never).render(h(Hello));
