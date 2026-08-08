# TermDOM

**Build terminal apps with HTML, CSS and the DOM.**

TermDOM is a JavaScript library that displays HTML and CSS in the terminal. It
renders actual DOM nodes to the screen, and redraws when they mutate, so a TUI
or interactive CLI application can be written like a client-side web app.

```sh
npm install @b9g/termdom
```

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach(); // take the terminal -- the only call that does

const {document} = term;
document.body.innerHTML = `
	<style>
		.card { border: 1px solid #5fafff; padding: 0 1ch; width: 36ch; }
		.title { color: #5fafff; font-weight: bold; }
		.done { color: green; }
		.rest { color: #444; }
		.pct { color: #888; }
	</style>
	<div class="card">
		<div class="title">Installing</div>
		<div><span class="done" id="done"></span><span class="rest" id="rest"></span> <span class="pct" id="pct"></span></div>
	</div>
`;

// TermDOM observes mutations and repaints the next frame.
let n = 0;
setInterval(() => {
	n = (n + 1) % 101;
	const cells = Math.round(n / 4);
	document.getElementById("done").textContent = "█".repeat(cells);
	document.getElementById("rest").textContent = "░".repeat(25 - cells);
	document.getElementById("pct").textContent = String(n).padStart(3) + "%";
}, 50);
```

![The card above, animating in a terminal](./docs/readme.gif)

## Features

- **Stylesheets** CSS from `<style>` elements and `style` attributes
  cascades and inherits like it does in the browser, and resolves to
  terminal colors and text attributes.
- **Layout** Boxes have borders, padding, and marginsand can be laid out
  with flexbox or a `<table>`. Text wraps to the column width.
- **Forms** `<input>`, `<textarea>`, `<select>`, checkboxes, and radios
  take focus and typing, place a real caret, and accept IME composition.
  They restyle with ordinary CSS.
- **Events** Events for keys, mouse, focus, and paste fire on elements,
  the document, and the window, pulled from STDIN.
- **A real DOM** `document.querySelector()`, `MutationObserver`,
  `Element.getBoundingClientRect()`, and shadow DOM work like they do in
  the browser.

## Examples

- [`markdown.ts`](./examples/markdown.ts) — a Markdown viewer that pages
  when the document is taller than the terminal.
- [`chat.ts`](./examples/chat.ts) — a streaming LLM chat client with a
  transcript and composer.
- [`todomvc.ts`](./examples/todomvc.ts) — the official TodoMVC with its
  component logic unmodified; only the stylesheet was swapped.
- [`fuzzy-finder.ts`](./examples/fuzzy-finder.ts) — a file picker that
  prints the selection to stdout.

More runnable examples can be found in [`examples/`](./examples).

## Runtimes

TermDOM runs on Node, Bun and Deno. The library has no native components and
can be used to create binaries with tools like `bun build --compile`.

## Support

[SUPPORT.md](./SUPPORT.md) is regenerated based on current supported HTML/CSS features.

## License

MIT
