# TermDOM

**Build Terminal UIs with HTML, CSS and DOM.**

TermDOM gives you a real DOM, a real cascade and a real CSS layout engine that
paint to a terminal. You build a page; it renders in cells. No new API to learn,
no native or WASM dependency.

```sh
npm install @b9g/termdom
```

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
// No render call. Mutations are observed and painted on the next frame,
// exactly like a browser.
```

One cell is `1ch` wide and `1px` tall. Every box lands on whole cells. An
interactive app calls `dom.dispose()` on the way out to hand the terminal back.

## What you get

**Real CSS layout.** `block`, `inline`, `inline-block`, and **flexbox** written
from css-flexbox-1 rather than approximated — including `flex-shrink` and
automatic minimum sizes. **CSS tables** with shared column widths,
`colspan`/`rowspan` and `border-collapse`. Lists with markers and counters,
borders, `position: relative`/`absolute`/`fixed`, `z-index` and stacking
contexts, `overflow: hidden` clipping, and inlines that break around
block-level children the way CSS says (`<a href="..."><div>card</div></a>`
renders like a card, not like nothing).

**Form controls that behave.** `<input>` (text, `[x]` checkboxes, `( )` radios),
`<textarea>`, `<select>` with a picker that opens on click, `<button>`. Tab
traverses focus, `:focus` styles apply, `input` and `change` events fire. The
caret is the real terminal cursor, so IME composition — CJK and friends —
anchors in the field and is measured in cells.

**Selection you can copy.** Drag to select in the document or inside a field;
`::selection` styles it through the `Highlight`/`HighlightText` system colors;
the result goes to your system clipboard over OSC 52, even across SSH.

**Shadow DOM.** `attachShadow`, slots, `:host`, scoped stylesheets. The built-in
controls are themselves UA shadow trees, which is why `::placeholder` and
part-based styling work on them.

**Media queries.** `@media` rules and `window.matchMedia` answer through one
evaluator. A terminal resize re-evaluates both and fires `change` on live
`MediaQueryList` objects, so a responsive layout is just CSS.

**Right-to-left text.** Hebrew and Arabic land in the right order, including
Latin words and numbers embedded in them, and Arabic letters are joined into
their contextual forms. `direction: rtl` starts lines at the right edge; text
with no declared direction takes it from its first strong character. A browser
hands bidi to the platform; a terminal will not, so termdom takes the explicit
side of ECMA-48's `BDSM` contract — it asks for explicit mode, asks back what it
got (`DECRQM`), and emits cells already in visual order. A terminal that insists
on reordering is detected and left to it.

**Mouse events.** Dispatched at the element under the cell: `wheel` scrolls,
`mousedown` moves focus, `click` is a click.

**Scrollback-native output.** Your app starts where the command started and its
output lands in real scrollback — searchable, permanent, resize-safe. When the
document grows taller than the room below it, earlier output *scrolls away* into
the scrollback instead of being painted over, and a camera moves over the
document (`window.scrollTo`, `scrollBy`, `scrollY`). Nothing of yours is ever
frozen: any row stays mutable, however far above the fold.

**Fullscreen when you want it.** `element.requestFullscreen()` takes the
alternate screen and `:fullscreen` styles it; exiting gives the terminal back
untouched.

**Framework-agnostic.** Anything that renders to a DOM works unchanged — see the
Crank and TanStack Table examples, and TodoMVC running on its own unmodified
markup and logic.

**Browser-grade rendering economics.** Incremental layout (a one-line edit
relays out its chain, not the document), viewport culling (paint is O(screen),
not O(document)), diffed frames, and tokenized input that keeps up with any
keyboard repeat rate.

## Examples

Build the package once with `npm run build`, then run any of these with
`node examples/<file>`.

| example | shows |
| --- | --- |
| `tree.ts [dir]` | NERDTree-style file tree: navigation, lazy loading, camera-follow |
| `form.ts` | text inputs, Tab focus, `:focus` styling, live preview, IME-correct carets |
| `commit-editor.ts` | a git-commit editor: input, textarea and select together |
| `todomvc.tsx` | TodoMVC on its own unmodified markup and logic, under Crank |
| `tanstack-table.ts` | TanStack Table driving a real `<table>` |
| `timer.tsx` | a Crank component rendered to the terminal |
| `animated.ts` | an animated frame that respects your shell history |
| `rtl.ts` | Hebrew and Arabic: visual reordering, `direction: rtl`, embedded Latin |
| `fullscreen-demo.ts` | the Fullscreen API over the alternate screen |
| `ssh-server.ts` | the whole library behind an SSH server; every connection gets its own DOM |
| `hello-world.ts`, `flexbox-demo.ts`, `borders.ts`, `lists.ts`, `input-styles.ts` | focused layout showcases |

Each example imports `@b9g/termdom` exactly as your own code would, so they run
on Node, Bun and Deno alike.

The exception is `todomvc.tsx`, which is JSX and therefore needs a transform —
run it with `bun examples/todomvc.tsx`, or any JSX-aware runner. It is written
in JSX because it is verbatim upstream Crank code, and the point of the example
is that it runs unmodified.

## What is not supported

TermDOM implements the parts of CSS that mean something on a character grid, and
is honest about the rest:

- **CSS Grid** — not yet. Flexbox and table layout are implemented.
- **Arabic ligature widths** — a lam-alef pair shapes into one ligature glyph, so
  such a line paints one cell narrower than it measured, leaving a small gap.
  Shaping is deliberately the last thing that happens, because doing it earlier
  would slide the character offsets the caret and selection are expressed in.
- **`aspect-ratio`** — deliberately omitted; a ratio has no meaning on a grid
  whose cells are not square.
- **Sub-cell sizing** — a cell is indivisible. All layout is in whole cells.
- **`text-decoration: line-through`** — `underline` maps to SGR 4; strike-through
  is not wired up.
- **`<input type="password">`** — renders its value in the clear. There is no
  masking yet, so do not use it for secrets.
- **Overflow that paints outside its box** — content larger than an explicit
  `width` is clipped to the box rather than painted over what follows, which is
  what `overflow: visible` asks for.
- **`:hover`** — mouse events are dispatched, but there is no hover state.
- **Animations and transitions** — `@keyframes`, `@supports` and `@import` parse
  and are dropped. Drive animation from `requestAnimationFrame` instead.


## Runtimes

Node, Bun and Deno. The library has no native or WASM dependency, so nothing
about it is tied to a particular runtime — and a TermDOM app also compiles to a
single binary with `bun build --compile`.

## License

MIT
