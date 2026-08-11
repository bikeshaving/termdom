---
title: Getting Started
description: Install TermDOM and render a document.
---

## Install

```sh
npm install @b9g/termdom
```

TermDOM runs on Node, Bun, and Deno, and has no native or WASM dependency.

## Usage

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

const box = document.createElement("div");
box.style.backgroundColor = "blue";
box.style.color = "white";
box.style.padding = "0 1ch";
box.textContent = "Hello, terminal";

document.body.appendChild(box);
```

`attach()` takes the terminal. Construction and DOM mutation are inert
until it runs. There is no render call: mutations are observed and painted
on the next frame.

A program that only writes static output does not call `attach()`:
`term.renderANSI(html)` returns an ANSI string, and `term.print(html)`
writes one as ordinary command output.

## Units

A terminal is a grid of character cells. `1ch` is one cell wide and `1px`
is one cell tall, so `width: 12ch` is twelve columns and `height: 3px` is
three rows. Lengths that land between cells resolve to whole cells.

## Stylesheets

```ts
const style = document.createElement("style");
style.textContent = `
	.card {
		border: 1px solid;
		padding: 0 1ch;
		color: cyan;
	}

	.card:focus {
		border-color: yellow;
	}
`;
document.head.appendChild(style);
```

Selectors, specificity, inheritance, `@media` queries, and custom
properties behave as they do in the browser.

## Quitting

`window.close()` ends the session: the final frame is flushed to
scrollback, terminal modes are restored, and the process exits. An
unhandled Ctrl-C performs the same call.

```ts
document.addEventListener("keydown", (e) => {
	if (e.key === "q") term.window.close();
});
```

## Frameworks

A frontend framework renders into TermDOM's document the way it renders into
a browser's. Frameworks read browser globals, so assign the ones yours
expects before it loads:

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
globalThis.document = term.document;
globalThis.window = term.window;
```

React needs nothing further:

```ts
import {createRoot} from "react-dom/client";
createRoot(term.document.body).render(<App />);
```

Vue also reads the DOM constructors for `instanceof` checks, and captures
`document` when its module loads — so the globals go up first and Vue comes
in by dynamic import:

```ts
globalThis.Element = term.window.Element;
globalThis.Node = term.window.Node;
globalThis.Text = term.window.Text;
globalThis.Comment = term.window.Comment;
globalThis.SVGElement = term.window.SVGElement;

const {createApp} = await import("vue");
createApp(App).mount(term.document.body);
```

Crank needs `Node` and `document` — [`examples/todomvc.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/todomvc.ts)
and the solitaire example show it in full.

## Next

- [Layout](/guides/layout/) — the box model, flexbox, and tables.
- [Events and input](/guides/events-and-input/) — keyboard, mouse, focus,
  and form controls.
- [API](/guides/api/) — the full surface.
