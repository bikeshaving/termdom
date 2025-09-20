# TermDOM

**HTML/CSS/JavaScript/DOM for Terminal Emulators**

TermDOM brings the familiar web development model — HTML, CSS, JavaScript and
the DOM interface — to terminal applications. Build complex, interactive
terminal interfaces just as you would a web application, without learning a new
API.

TermDOM is available on NPM as:
[`@b9g/termdom`](https://www.npmjs.com/package/@b9g/termdom).

```bash
bun add @b9g/termdom
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
- **Rich Layout:** `block` / `inline` / `flex` layout from the browser
  supported.
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

## License

MIT
