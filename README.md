# TermDOM

**Build terminal apps with HTML, CSS and the DOM.**

TermDOM is a TUI rendering engine: a real DOM (via JSDOM) with real CSS layout
painted to terminal cells so you can use HTML, CSS and any web framework to create interactive CLI applications.

```sh
npm install @b9g/termdom
```

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();

// The document is a real DOM document.
const {document, window} = term;
const box = document.createElement("div");
box.style.backgroundColor = "blue";
box.style.color = "white";
// 1px = 1ch = 1 terminal cell
box.style.padding = "0 1px";
box.textContent = "Hello, terminal";

// TermDOM observes mutations and re-renders automatically
document.body.appendChild(box);

await new Promise((resolve) => window.requestAnimationFrame(resolve));
// Colored ANSI output should show on the screen by this point
```

## What it is

- **Layout** — linebreaking for text, block and inline flow, flexbox, tables,
  `position` and `z-index` stacking, margin collapsing, `overflow` clipping,
  percentage sizing, media queries.
- **Styling** — stylesheets and inline styles through one cascade: selectors
  (`:has()` included), specificity, `!important`, `var()`, `@media`,
  inheritance. Every cell attribute traces to a computed style.
- **Widgets** — `<input>`, `<textarea>`, `<select>`, checkboxes and radios are
  UA shadow trees with terminal-native default styling: flat underlined fields,
  `[ ]`/`( )` toggles, a focus accent. Style them with ordinary CSS,
  `::placeholder`, `::selection`, and `::part()`.
- **Shadow DOM** — author shadow roots, slots, `:host`, scoped styles.
- **Events** — keyboard (modifiers decoded), mouse (click, dblclick, wheel),
  focus, bracketed paste as real paste events, IME composition.
  `addEventListener`, capture phases, and delegation behave as on the web.
- **The rest of the platform** — `getBoundingClientRect`, `elementFromPoint`,
  `scrollIntoView`, `matchMedia`, `requestAnimationFrame`, `MutationObserver`,
  `ResizeObserver`, the Fullscreen API, are all hooked up to the terminal’s
  layout, viewport and runtime.

## Examples

Programs can be found in [`examples/`](./examples):
- [`markdown.ts`](./examples/markdown.ts) — a Markdown viewer (marked +
  Prism): flow mode when it fits, a pager when it doesn't.
- [`chat.ts`](./examples/chat.ts) — a streaming LLM chat client as a web
  page: transcript, composer, tokens reflowing live.
- [`password.ts`](./examples/password.ts) — a password strength meter: a
  masked `<input type="password">` driving live requirement checks.
- [`todomvc.ts`](./examples/todomvc.ts) — the official TodoMVC, component logic
  unmodified; only the stylesheet was swapped.
- [`fuzzy-finder.ts`](./examples/fuzzy-finder.ts)
- [`git-log.ts`](./examples/git-log.ts)

## Runtimes

TermDOM works in Node, Bun and Deno. The library has no native components and
can be used to create binaries with tools like `bun build --compile`.

## Support

[SUPPORT.md](./SUPPORT.md) is regenerated based on current supported HTML/CSS features.

## License

MIT
