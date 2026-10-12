---
title: Getting Started
description: Install TermDOM and render a document.
---

## Install

```sh
npm install @b9g/termdom
```

TermDOM runs on Node, Bun, and Deno. It has no native or WASM
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
no render call. The engine observes DOM mutations and paints them on
the next frame, so any change to the document shows up on the screen.

The engine draws the document below the shell prompt, where a
command's output goes. The document stays live there until
the program ends. After that, it stays in the scrollback like any
other output. This is called flow mode. The
[rendering guide](/guides/rendering/) describes flow mode, fullscreen
mode, and static output.

For static output, do not call `attach()`. Instead,
`term.renderANSI(html)` returns an ANSI string, and `term.print(html)`
writes that string to stdout.

## Units

A terminal is a grid of character cells. By default, `1px` and `1ch`
are both one cell. So `width: 12ch` is twelve columns, and
`height: 3px` is three rows. The engine rounds lengths that fall
between cells to whole cells. The `cellSize` option sets how many CSS
pixels one cell is.

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
properties work the same way they do in a browser.

## Quitting

`window.close()` ends the session. It leaves the final frame in the
terminal's scrollback, restores the terminal's modes, and exits the
process. By default, Ctrl-C does the same.

```ts
document.addEventListener("keydown", (ev) => {
	if (ev.key === "q") term.window.close();
});
```

## Frameworks

A framework renders into `term.document` the same way it renders into
a browser document. Most frameworks also read DOM globals such as
`document`, `window`, and `Element`. `installGlobals(term)` copies the
properties of the TermDOM window onto `globalThis`, replacing the
runtime's own globals of the same name. It returns a function that
restores the originals. It leaves a few runtime globals in place; the
API guide lists them.

Frameworks read the environment once, when their modules load. For
example:

- React decides at load time which events a text field fires.
- Vue takes `document` at load time.
- CodeMirror reads `navigator` at load time to choose between Cmd and
  Ctrl.

Static imports load before any code in the importing module runs. So
install the globals first, and then import the framework with a
dynamic `import()`:

```ts
import {installGlobals, TermDOM} from "@b9g/termdom";

const term = new TermDOM();
installGlobals(term);
const {createRoot} = await import("react-dom/client");
createRoot(term.document.body).render(<App />);
```

If the program imports the framework before installing the globals,
two things go wrong. React misses edits that do not come from a key
press, such as a paste. CodeMirror on a Mac binds Cmd, which a
terminal cannot send.

Vue:

```ts
installGlobals(term);
const {createApp} = await import("vue");
createApp(App).mount(term.document.body);
```

Svelte components must be compiled first, with `svelte/compiler` and
`generate: "client"`, or with a bundler plugin. The Svelte client
runtime resolves under the `browser` export condition:

```sh
node --conditions=browser app.js
```

```ts
import {mount} from "svelte";
import App from "./App.js"; // compiled from App.svelte

installGlobals(term);
mount(App, {target: term.document.body});
```

Crank does not need the globals:

```ts
import {renderer} from "@b9g/crank/dom";

renderer.render(<App />, term.document.body);
```

The [hello examples](https://github.com/bikeshaving/termdom/tree/main/examples)
show each framework running.
[`examples/todomvc.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/todomvc.ts)
is a full program.

## Next

- [Rendering](/guides/rendering/): flow mode, fullscreen, static
  output, and what the engine asks the terminal.
- [Layout](/guides/layout/): the box model, flexbox, grid, tables, and
  MathML.
- [Styling](/guides/styling/): how each CSS property maps to the
  terminal.
- [Events and input](/guides/events-and-input/): keyboard, mouse,
  focus, and form controls.
- [Images and canvas](/guides/images-and-canvas/): how `<img>` and
  `<canvas>` draw pixels in cells.
- [API](/guides/api/): the full surface.
