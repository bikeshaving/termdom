# TermDOM

**HTML/CSS/JavaScript/DOM for Terminal Emulators**

TermDOM brings the familiar web development model — HTML, CSS, JavaScript and
the DOM interface — to terminal applications. Build complex, interactive
terminal interfaces just as you would a web application, without learning a new
API.

> **Status: pre-release.** TermDOM is not published to npm yet. To try it, clone
> the repo and run the examples with `bun examples/flexbox-demo.ts`.

Vanilla DOM example

```ts
import {TermDOM} from "@b9g/termdom";
const termDOM = new TermDOM();
const document = termDOM.document;

const div = document.createElement("div");
div.style.backgroundColor = "blue";
div.style.color = "white";
div.style.padding = "2";
div.textContent = "Hello Terminal!";

document.body.appendChild(div);
termDOM.render(); // Flush to terminal
```

## Why Use Web Technologies in the Terminal?

Terminal emulators provide a simple interface for CLI applications. However,
building CLI applciations can be tedious:

- Raw terminal libraries require low-level ANSI escape sequences and cursor
  management.
- Complex layouts, inline styling, and reusable components are cumbersome to
  implement.

TermDOM solves this by leveraging familiar web concepts:

- **Declarative UI:** Use APIs like `document.createElement()`,
  `document.appendChild()`, and `style="color: red;"` just like in the browser.
- **Real CSS layout:** `block`, `inline`, `inline-block`, **flexbox** (written from
  the CSS spec, not approximated), **CSS table layout** with shared column widths,
  `colspan`/`rowspan` and `border-collapse`, lists with markers and counters,
  borders, `position: relative`/`absolute`, and `z-index` for overlays.
- **No native or WASM dependency.** The layout engine is pure JavaScript on an
  integer cell grid, so a TermDOM app compiles to a single executable with
  `bun build --compile` and runs on Bun, Node and Deno.
- **Framework Agnostic:** Any web framework that can render to the DOM can be
  used with TermDOM.
- **Composability:** Build reusable terminal components using web components,
  or whatever UI framework you desire.
- **Live Updates:** TermDOM implements auto-rerendering like the browser, so
  you can update terminal output reactively.
- **Cross-Context:** Works in interactive terminals or piped output, bridging
  TTY and non-TTY use cases.

## Quickstart

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const doc = term.document;

const header = doc.createElement("div");
header.textContent = "TermDOM Demo";
header.style.color = "green";
doc.body.appendChild(header);

term.render(); // Flush to terminal
```

## What is not supported

TermDOM implements the parts of CSS that mean something on a character grid. It is
honest about the rest:

- **CSS Grid** — not yet. Flexbox and table layout are implemented.
- **RTL / `direction`** and **`aspect-ratio`** — deliberately omitted; neither has a
  coherent meaning on a cell grid where cells are not square.
- **`overflow`** — content is not clipped or scrolled by the engine; a box reports
  its size and the renderer draws what fits.
- **Sub-cell sizing** — a cell is indivisible. All layout is in whole cells.

See [LAYOUT.md](./LAYOUT.md) for the full supported/unsupported list and the places
where TermDOM knowingly departs from the CSS spec.

## Runtimes

Bun, Node and Deno. The library has no native or WASM dependency, so it also
compiles to a single binary with `bun build --compile`.

The *examples* are Bun-only: neither Node nor Deno maps a `.js` import specifier
onto a `.ts` source file, so off-Bun consumers use the built output (`bun run
build`).

## License

MIT
