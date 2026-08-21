---
title: Getting Started
description: Install TermDOM and render a document.
---

## Install

```sh
npm install @b9g/termdom
```

TermDOM runs on Node, Bun, and Deno. No native or WASM dependencies.

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

`attach()` puts the terminal in raw mode and starts rendering. There is
no render call: DOM mutations are observed and painted on the next
frame, so whatever changes the document changes the screen.

For static output, skip `attach()`: `term.renderANSI(html)` returns an
ANSI string, and `term.print(html)` writes one to stdout.

## Units

A terminal is a grid of character cells. `1px` and `1ch` are both one
cell, so `width: 12ch` is twelve columns and `height: 3px` is three rows.
Lengths that land between cells resolve to whole cells.

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
properties work as in a browser.

## Quitting

`window.close()` ends the session: the final frame stays in the
terminal's scrollback, terminal modes are restored, and the process
exits. Ctrl-C does the same by default.

```ts
document.addEventListener("keydown", (ev) => {
	if (ev.key === "q") term.window.close();
});
```

## Frameworks

A framework renders into `term.document` the same way it renders into a
browser document. Most frameworks read a few DOM globals; assign the
ones yours needs before rendering.

React:

```ts
import {createRoot} from "react-dom/client";

globalThis.document = term.document;
globalThis.window = term.window;
createRoot(term.document.body).render(<App />);
```

Vue reads `document` when its module loads, so assign the globals before
a dynamic import:

```ts
globalThis.document = term.document;
globalThis.window = term.window;
globalThis.Element = term.window.Element;
globalThis.SVGElement = term.window.SVGElement;

const {createApp} = await import("vue");
createApp(App).mount(term.document.body);
```

Svelte components compile first (`svelte/compiler` with
`generate: "client"`, or a bundler plugin), and the client runtime
resolves under the `browser` export condition:

```sh
node --conditions=browser app.js
```

```ts
import {mount} from "svelte";
import App from "./App.js"; // compiled from App.svelte

globalThis.document = term.document;
globalThis.window = term.window;
globalThis.Node = term.window.Node;
globalThis.Element = term.window.Element;
globalThis.Text = term.window.Text;
globalThis.Comment = term.window.Comment;

mount(App, {target: term.document.body});
```

Crank needs no globals:

```ts
import {renderer} from "@b9g/crank/dom";

renderer.render(<App />, term.document.body);
```

The [hello examples](https://github.com/bikeshaving/termdom/tree/main/examples)
show each framework running;
[`examples/todomvc.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/todomvc.ts)
is a full app.

## Next

- [Layout](/guides/layout/) — the box model, flexbox, and tables.
- [Events and input](/guides/events-and-input/) — keyboard, mouse, focus,
  and form controls.
- [API](/guides/api/) — the full surface.
