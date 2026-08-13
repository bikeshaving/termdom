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
a browser's. A framework reaches for a global wherever it reads the DOM
without a node in hand; assign the globals it reads, and no others.

| Framework | Globals required | Why |
| --- | --- | --- |
| React 19 | `document`, `window` | `react-dom` reads `window.event` to pick an update priority, and `document.documentMode` and `"TextEvent" in window` for its input feature detection |
| Vue 3 | `document`, `window`, `Element`, `SVGElement` | `@vue/runtime-dom` captures `document` on load to create nodes, and `mount()` tests the container with `instanceof Element` and `instanceof SVGElement` |
| Svelte 5 | `document`, `window`, `Node`, `Element`, `Text`, `Comment` | `init_operations()` takes the `firstChild` and `nextSibling` getters off `Node.prototype` and caches lookups on `Element.prototype` and `Text.prototype`; `Comment` identifies the anchor nodes the compiler emits |
| Crank 0.7.1 | `document`, `Node` | `@b9g/crank/dom` creates nodes with `document.createElement` and `document.createTextNode`, and compares `nodeType` against `Node.ELEMENT_NODE` before rendering or patching |

React:

```ts
import {createRoot} from "react-dom/client";

globalThis.document = term.document;
globalThis.window = term.window;
createRoot(term.document.body).render(<App />);
```

Vue captures `document` when its module loads, so the globals go up first
and Vue comes in by dynamic import:

```ts
globalThis.document = term.document;
globalThis.window = term.window;
globalThis.Element = term.window.Element;
globalThis.SVGElement = term.window.SVGElement;

const {createApp} = await import("vue");
createApp(App).mount(term.document.body);
```

Svelte is a compiler, so its components compile first (`svelte/compiler`
with `generate: "client"`, or any bundler's Svelte plugin), and its package
exports resolve the client runtime under the `browser` condition:

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

Crank:

```ts
import {renderer} from "@b9g/crank/dom";

globalThis.document = term.document;
globalThis.Node = term.window.Node;
renderer.render(<App />, term.document.body);
```

[`examples/todomvc.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/todomvc.ts)
and the solitaire example show Crank in full.

## Next

- [Layout](/guides/layout/) — the box model, flexbox, and tables.
- [Events and input](/guides/events-and-input/) — keyboard, mouse, focus,
  and form controls.
- [API](/guides/api/) — the full surface.
