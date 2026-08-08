---
title: Getting Started
description: Install TermDOM, render your first document, and learn the one rule that makes a terminal different from a browser.
---

TermDOM gives you a real DOM, a real cascade and a real CSS layout engine that
paint to a terminal. You build a page; it renders in cells.

## Install

```sh
npm install @b9g/termdom
```

TermDOM runs on Node, Bun and Deno. It has no native or WASM dependency, and
an app built on it compiles to a single binary with `bun build --compile`.

## Your first document

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
// Take the terminal. Nothing touches stdout before this call.
term.attach();
const {document} = term;

const box = document.createElement("div");
box.style.backgroundColor = "blue";
box.style.color = "white";
box.style.padding = "0 1ch";
box.textContent = "Hello, terminal";

document.body.appendChild(box);
```

`attach()` is the only call that takes the terminal — construction and DOM
mutation are inert until it runs. A program that only wants static output
never calls it: `term.renderANSI(html)` returns the ANSI string, and
`term.print(html)` writes it as ordinary command output.

There is no render call. Mutations are observed and painted on the next
frame, the same contract a browser gives you: append a node, set a style,
change some text, and the frame that follows shows it.

## The one rule: everything is cells

A terminal is a grid of character cells, and every box lands on whole ones.
That gives you two units that mean exactly what they say:

- `1ch` is one cell wide.
- `1px` is one cell tall.

So `width: 12ch` is twelve columns, and `height: 3px` is three rows. Lengths
that would land between cells are resolved to whole cells, because there is no
such thing as half a cell to paint.

## Styling with a stylesheet

Inline styles work, but a stylesheet is usually what you want, and the cascade
is real:

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

Selectors, specificity, inheritance, `@media` queries and custom properties
behave the way they do in a browser.

## Quitting

`window.close()` ends the session: the final frame is flushed to scrollback,
every terminal mode is restored, and the process exits. An unhandled Ctrl-C
performs the same call. A quit key is one listener:

```ts
document.addEventListener("keydown", (e) => {
	if (e.key === "q") term.window.close();
});
```

## Where to go next

- [Layout](/guides/layout/) — flexbox, tables and the box model on a grid.
- [Events and input](/guides/events-and-input/) — keyboard, mouse, focus and
  form controls.
- [Examples on GitHub](https://github.com/bikeshaving/termdom/tree/main/examples)
  — runnable programs, from a file tree to TodoMVC.
