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

The document is drawn below the shell prompt, where a command's output
goes, and it stays live there until the program ends. Then it is left
in the scrollback like any other output. This is flow mode, and the
[rendering guide](/guides/rendering/) describes it, along with
fullscreen and static output.

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
browser document. Most frameworks read a few DOM globals. Supply the
ones yours needs before rendering, and only where the runtime has none:
a browser has its own `document` and `window` and will not give them
up, and a program that defines a global that exists already fails there.

React:

```ts
import {createRoot} from "react-dom/client";

const globals = {document: term.document, window: term.window};
for (const [name, value] of Object.entries(globals)) {
	if (!(name in globalThis)) {
		Object.defineProperty(globalThis, name, {
			value,
			configurable: true,
			writable: true,
		});
	}
}
createRoot(term.document.body).render(<App />);
```

Vue reads `document` when its module loads, so assign the globals before
a dynamic import:

```ts
const globals = {
	document: term.document,
	window: term.window,
	Element: term.window.Element,
	SVGElement: term.window.SVGElement,
};
for (const [name, value] of Object.entries(globals)) {
	if (!(name in globalThis)) {
		Object.defineProperty(globalThis, name, {
			value,
			configurable: true,
			writable: true,
		});
	}
}

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

const globals = {
	document: term.document,
	window: term.window,
	Node: term.window.Node,
	Element: term.window.Element,
	Text: term.window.Text,
	Comment: term.window.Comment,
};
for (const [name, value] of Object.entries(globals)) {
	if (!(name in globalThis)) {
		Object.defineProperty(globalThis, name, {
			value,
			configurable: true,
			writable: true,
		});
	}
}

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

- [Rendering](/guides/rendering/) — flow mode, fullscreen, static
  output, and what the engine asks the terminal.
- [Layout](/guides/layout/) — the box model, flexbox, grid, tables, and
  MathML.
- [Styling](/guides/styling/) — how each CSS property maps to the
  terminal.
- [Events and input](/guides/events-and-input/) — keyboard, mouse, focus,
  and form controls.
- [API](/guides/api/) — the full surface.
