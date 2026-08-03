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

TermDOM runs on Node, Bun and Deno. It has no native or WASM dependency and
nothing about it is tied to a particular runtime — which also means an app built
on it compiles to a single binary with `bun build --compile`, if you want one.

## Your first document

```ts
import {TermDOM} from "@b9g/termdom";

const dom = new TermDOM();
const {document} = dom;

const box = document.createElement("div");
box.style.backgroundColor = "blue";
box.style.color = "white";
box.style.padding = "0 1ch";
box.textContent = "Hello, terminal";

document.body.appendChild(box);
```

There is no render call, and that is not a convenience — it is the same
contract a browser gives you. Mutations are observed and painted on the next
frame. Append a node, set a style, change some text: the frame that follows
shows it.

## The one rule: everything is cells

A terminal is a grid of character cells, and every box lands on whole ones.
That gives you two units that mean exactly what they say:

- `1ch` is one cell wide.
- `1px` is one cell tall.

So `width: 12ch` is twelve columns, and `height: 3px` is three rows. Lengths
that would land between cells are resolved to whole cells, because there is no
such thing as half a cell to paint.

This is also why a few CSS features are deliberately absent rather than
approximated. `aspect-ratio` has no meaning on a grid whose cells are not
square, and sub-cell sizing has nowhere to go. The
[support matrix](/support/) records exactly what is and is not implemented,
measured rather than asserted.

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

Selectors, specificity, inheritance, `@media` queries and custom properties all
behave the way they do in a browser, because they are resolved by a real
cascade rather than a lookalike.

## Interactive apps

An interactive app hands the terminal back when it exits:

```ts
process.on("SIGINT", () => {
	dom.dispose();
	process.exit(0);
});
```

`dispose()` restores the modes TermDOM negotiated on the way in — mouse
reporting, bracketed paste, cursor visibility — so the shell you return to is
the shell you left.

## Where to go next

- [Layout](/guides/layout/) — flexbox, tables and the box model on a grid.
- [Events and input](/guides/events-and-input/) — keyboard, mouse, focus and
  form controls.
- [Examples](/examples/) — runnable programs, from a file tree to TodoMVC.
