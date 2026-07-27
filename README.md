# TermDOM

**HTML/CSS/JavaScript/DOM for Terminal Emulators**

TermDOM brings the familiar web development model — HTML, CSS, JavaScript and
the DOM interface — to terminal applications. Build complex, interactive
terminal interfaces just as you would a web application, without learning a new
API.

```sh
bun add @b9g/termdom   # or npm install @b9g/termdom
```

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
// No render call: mutations paint automatically, like the browser.
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
- **Two viewport modes.** *Flow* behaves like an ordinary command: output lands
  in real scrollback, searchable and permanent, and resizes re-anchor exactly.
  *Document* mode holds a camera over a mutable document -- pagers, pickers,
  dashboards -- and never touches your scrollback.
- **Real text input.** `<input>` elements with focus traversal, `:focus`
  styling, `input` events -- and the caret is the real terminal cursor, so IME
  composition (CJK and friends) anchors in the field, measured in cells.
- **Real mouse events.** In document mode and fullscreen the mouse is captured
  and dispatched as DOM events at the element under the cell -- `wheel` scrolls
  the camera, `mousedown` moves focus, `click` is a click. Flow mode leaves the
  mouse native, so your scrollback and selection stay yours.
- **Browser-grade rendering economics.** Incremental layout (a one-line edit
  relays out its chain, not the document), viewport culling (paint is
  O(screen), not O(document)), diffed frames, and tokenized input that keeps
  up with any keyboard repeat rate.

## Quickstart

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const doc = term.document;

const header = doc.createElement("div");
header.textContent = "TermDOM Demo";
header.style.color = "green";
doc.body.appendChild(header);
// Rendering is automatic on DOM mutation. `await term.render()` is only
// needed to await a frame, or after changes the DOM cannot observe
// (e.g. moving the document-mode camera).
```

## Examples

| example | shows |
| --- | --- |
| `bun examples/tree.ts [dir]` | NERDTree-style interactive file tree: navigation, lazy loading, selection, camera-follow -- in ~200 lines of vanilla DOM |
| `bun examples/form.ts` | text inputs, Tab focus, `:focus` styling, live preview, IME-correct carets |
| `bun examples/animated.ts` | flow mode: an animated frame that respects your shell history |
| `bun examples/animated-paged.ts` | document mode: the same frame under a scrollable camera |
| `bun examples/todo-app.ts` | a small interactive app |
| `bun examples/ssh-server.ts` | the whole library behind an SSH server; every connection gets its own DOM |
| `bun examples/tanstack-table.ts` | TanStack Table driving a real `<table>` -- DOM libraries work unchanged |
| `bun examples/timer.tsx` | a Crank component rendered to the terminal -- DOM frameworks work unchanged |
| `bun examples/hello-world.ts`, `flexbox-demo`, `borders`, `lists`, `fullscreen-demo` | focused showcases of layout features |

Examples import the library's TypeScript source directly, so they run under Bun.
Node and Deno consumers use the built package (`npm install @b9g/termdom`).

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
