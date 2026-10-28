---
title: Getting Started
description: Install TermDOM and render a document.
---

## Install

```sh
npm install @b9g/termdom
```

TermDOM runs on Node, Bun, and Deno, with no native or WASM
dependencies.

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
no render call: changes to the document appear on the next frame.

The document is drawn below the shell prompt and stays live until the
program ends, then stays in the scrollback. The
[rendering guide](/guides/rendering/) covers this, fullscreen, and
static output.

For static output, skip `attach()`. `term.renderANSI(html)` returns an
ANSI string, and `term.print(html)` writes it to stdout.

## Units

By default, `1px` and `1ch` are both one cell, so `width: 12ch` is
twelve columns and `height: 3px` is three rows. Lengths round to whole
cells. The `cellSize` option changes how many CSS pixels a cell is.

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

Selectors, specificity, inheritance, `@media`, and custom properties
all work.

## Quitting

`window.close()` ends the session. It leaves the last frame in the
scrollback, restores the terminal, and exits the process. Ctrl-C does
the same by default.

```ts
document.addEventListener("keydown", (ev) => {
	if (ev.key === "q") term.window.close();
});
```

## Frameworks

Frameworks render into `term.document`. Most also read globals such as
`document`, `window`, and `Element`. `installGlobals(term)` copies the
TermDOM window's properties onto `globalThis` and returns a function
that restores the originals. A few runtime globals are left alone; the
API guide lists them.

Frameworks read these globals when their modules load, and static
imports load before your code runs. Install the globals first, then
import the framework with `import()`:

```ts
import {installGlobals, TermDOM} from "@b9g/termdom";

const term = new TermDOM();
installGlobals(term);
const {createRoot} = await import("react-dom/client");
createRoot(term.document.body).render(<App />);
```

Imported too early, React misses edits that don't come from a key
press, such as a paste, and CodeMirror on a Mac binds Cmd, which a
terminal can't send.

Vue:

```ts
installGlobals(term);
const {createApp} = await import("vue");
createApp(App).mount(term.document.body);
```

Svelte components must be compiled first, with `svelte/compiler` and
`generate: "client"` or a bundler plugin. Run with the `browser` export
condition:

```sh
node --conditions=browser app.js
```

```ts
import {mount} from "svelte";
import App from "./App.js"; // compiled from App.svelte

installGlobals(term);
mount(App, {target: term.document.body});
```

Crank doesn't need the globals:

```ts
import {renderer} from "@b9g/crank/dom";

renderer.render(<App />, term.document.body);
```

The [hello examples](https://github.com/bikeshaving/termdom/tree/main/examples)
run each framework.
[`examples/todomvc.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/todomvc.ts)
is a full program.

## Next

- [Rendering](/guides/rendering/): flow mode, fullscreen, static
  output, and what TermDOM asks the terminal.
- [Layout](/guides/layout/): the box model, flexbox, grid, tables, and
  MathML.
- [Styling](/guides/styling/): how CSS maps to the terminal.
- [Events and input](/guides/events-and-input/): keyboard, mouse,
  focus, and form controls.
- [Images and canvas](/guides/images-and-canvas/): `<img>` and
  `<canvas>`.
- [API](/guides/api/): everything else.
