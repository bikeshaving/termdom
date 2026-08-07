# TermDOM

**Build Terminal UIs with HTML, CSS and DOM.**

```sh
npm install @b9g/termdom
```

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

// attach to bun/node process
term.attach();

const {document} = term;

// The document is a real JSDOM document
// TermDOM works with any UI framework

const box = document.createElement("div");
box.style.backgroundColor = "blue";
box.style.color = "white";
// 1px = 1ch = 1 terminal cell
box.style.padding = "0 1px";
box.textContent = "Hello, terminal";

// TermDOM detects mutations to document.body and re-renders
document.body.appendChild(box);
```

## Runtimes

Node, Bun and Deno. The library has no native or WASM dependency, so nothing
about it is tied to a particular runtime — and a TermDOM app also compiles to a
single binary with `bun build --compile`.

## License

MIT
