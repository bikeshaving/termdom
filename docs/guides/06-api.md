---
title: API
description: The TermDOM class, the TerminalTransport interface, and transportFromProcess.
---

## `new TermDOM(options?)`

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
```

Construction writes nothing to the terminal. The document is usable
immediately: it can be built, styled, and measured before `attach()`, or
without calling it at all.

Options:

- `transport?: TerminalTransport` — the terminal to render to. Defaults to
  `transportFromProcess()`, a wrapper around the global `process`.
- `html?: string` — the initial document's markup, parsed as a whole
  page. Defaults to an empty document. A page written as a file starts
  here:

  ```ts
  import {readFile} from "node:fs/promises";

  const term = new TermDOM({html: await readFile("page.html", "utf8")});
  ```

- `url?: string` — the document's URL, as `document.URL` and
  `location.href` report it.
- `cellSize?: "unit" | "auto" | {width, height}` — how many
  CSS pixels one terminal cell is.

  Leave it alone for an app written for the terminal. Set it to `"auto"`
  to show a page written for a browser, like a 600px-wide email, at
  about the size it would be in one.

  ```ts
  const term = new TermDOM({cellSize: "auto"});
  ```

  | Value | One cell is |
  | --- | --- |
  | `"unit"` (default) | 1×1 px |
  | `"auto"` | what the terminal reports, or 8×16 if it can't say |
  | `{width, height}` | that size, such as `{width: 8, height: 16}` |

  With `"auto"`, the first frame waits for the terminal's answer, a
  second at most, and a font zoom asks again.

  Whatever the size:
  - A box's edges round to the nearest cell, so columns that add up to
    their container still fit it. A border is whole cells, at least one.
  - `1ch` is one cell: a column across, a row down.
  - `1lh` is one row.

  So a stylesheet written in `ch` and `lh` looks the same at every size.

- `csp?: string` — what the document's markup may load, as a
  `Content-Security-Policy` header states it. Defaults to
  `"default-src 'none'"`, so nothing loads until the program allows it;
  `""` sets no policy. The images guide has recipes.
- `graphics?: "auto" | "cells" | "none"` — how the document draws
  pixels, for an `<img>` and a canvas's `"2d"` context. `"auto"`
  (default) uses the best way the terminal has, `"cells"` draws them two
  to a cell in half blocks, and `"none"` draws none: images show their `alt` text and
  `getContext("2d")` returns `null`.
- `colorDepth?: "auto" | 24 | 8 | 3` — the colors the terminal shows,
  in the bits `screen.colorDepth` reports. With `"auto"` (default),
  TermDOM asks the terminal. `"rgb"`, `"256"` and `"ansi"` name 24, 8
  and 3. See "Color depth" in the styling
  guide.

### `term.document`, `term.window`

`document` is a `Document`. Setting `document.title` sets the terminal
window title; the previous title is restored on `dispose()`.
`document.close()` writes the document into the scrollback and seals
it, and the next mutation starts a fresh document below it.

`window` has the DOM interfaces and event constructors, and these members
are wired to the terminal:

- `innerWidth`, `innerHeight`, `outerWidth`, `outerHeight` — the terminal
  size, in cells
- `screenTop` — the row the rendered region starts at
- `scrollY`, `pageYOffset`, `scrollTo()`, `scrollBy()`, `scroll()` —
  document scrolling
- `requestAnimationFrame()`, `cancelAnimationFrame()` — the callback fires
  at the start of the next frame, before it is laid out and painted, as in
  a browser; what the callback changes lands in that frame
- `matchMedia()` — live `MediaQueryList`s, re-evaluated on resize
- `resize` — fired when the terminal size changes, before the
  `MediaQueryList` `change` events that resize triggers
- `getSelection()` — the document selection, `modify()` included
- `CSS.highlights` — the highlight registry, painted by `::highlight()`
  rules
- `navigator.clipboard.writeText()` / `readText()` — the system clipboard
  over OSC 52, reachable only during the dispatch of a trusted user event;
  `readText()` rejects when the terminal does not answer
- `navigator.userActivation` — `hasBeenActive` and `isActive`
- `MutationObserver`, `ResizeObserver`, `IntersectionObserver` — entries
  are delivered per rendered frame
- `close()` — quit: flush the final frame to scrollback, restore terminal
  modes, dispose, and call `transport.close({status: 0})`, which exits the
  process on the default transport. Ctrl-C calls this as its default
  action; a `keydown` listener that calls `preventDefault()` overrides it.

Anything not listed behaves as the DOM and CSSOM standards specify,
without terminal wiring.

### Styling the built-in controls

A page styles the insides of the form controls through the
pseudo-elements browsers give them:

| Control | Pseudo-elements |
| --- | --- |
| `<input>` text types, `<textarea>` | `::placeholder` |
| `<select>` | `::picker(select)`, `::picker-icon` |
| `<details>` | `::details-content` |

`::picker(select)` and `::picker-icon` are a customizable `<select>`'s,
as Chromium ships them.

```css
select::picker(select) { background-color: #1c1c1c; }
select::picker-icon { color: gray; }
```

A `<progress>` draws its fill in its `accent-color`, as browsers do.

```css
progress { accent-color: green; }
```

The rest of a control's insides, such as a meter's fill or a button's
brackets, are TermDOM's own, as they are a browser's: the
controls are shadow trees inside, and `::part()` does not reach into
them. TermDOM's own sheet styles the controls with the same
pseudo-elements, so a page's rules override it as they would any
built-in style.

### `term.attach(transport?)`

Puts the terminal in raw mode, starts input handling, mouse reporting,
and bracketed paste, and paints whatever the document holds. Idempotent;
no other call writes to the terminal. Returns a promise that resolves
once the first frame has been written.

While attached to the process transport, the Node event loop stays alive
until `dispose()` or `window.close()`.

`document.visibilityState` is `"hidden"` before `attach()`, `"visible"`
until `dispose()`, and `"hidden"` after. It is also `"hidden"` while the
wheel has been handed to the terminal's scrollback, until the next
keystroke. `visibilitychange` fires on each change.

Passing a transport rebinds the instance to it, only before the first
attach.

### `term.renderANSI(html?)`

Returns the whole document as an ANSI string at the terminal's width:
colors and line breaks, no cursor movement. Pass an HTML string to
render that instead; the document is left alone.

```ts
const page = term.renderANSI();
const error = term.renderANSI(`<div style="color:red">error</div>`);
```

It works attached or not, and doesn't disturb a live session.

### `term.print(html?)`

Writes `renderANSI(html)` to the terminal as ordinary output. Await it
before exiting.

### `term.dispose()`

Reverses `attach()`: flushes the document into scrollback, restores every
terminal mode and the title, and releases the transport. The process
continues; `window.close()` is the quit. Returns a promise that resolves
when every queued restore has reached the transport; await it before
writing further output. The process transport also restores
shell-critical modes synchronously, so a caller that exits without
awaiting still leaves the shell usable. `using term = new TermDOM()`
disposes on scope exit.

## `TerminalTransport`

The interface between the engine and a terminal, for embedding TermDOM
somewhere other than a process — an SSH server, a browser terminal, a
test harness:

```ts
interface TerminalTransport {
	readonly cols: number; // live: always the current size
	readonly rows: number;
	readonly interactive: boolean; // false: plain line output (a pipe)
	// Optional. Takes an error's text somewhere the frame does not share;
	// true when it did. The engine keeps what it cannot place and prints
	// it below the document at the end.
	logError?(text: string): boolean;
	readonly sharesScreen: boolean; // true: anchor below existing content
	readonly readable: ReadableStream<string>; // user input
	readonly writable: WritableStream<string>; // frames out
	readonly resizes: ReadableStream<{cols: number; rows: number}>;
	readonly ready: Promise<void>; // established; Promise.resolve() if born so
	readonly closed: Promise<TerminalCloseInfo>; // the terminal went away
	// Ends the medium if the transport owns it (the process transport exits
	// the process); a no-op otherwise.
	close(info?: TerminalCloseInfo): void;
}

interface TerminalCloseInfo {
	status?: number; // process-exit semantics
	signal?: string; // "SIGHUP", "SIGTERM", ... when a signal ended it
	reason?: string;
}
```

Chunks on `readable` are strings; a byte-backed wrapper must decode with
a streaming decoder so code points never split. Escape sequences may
split across chunks; the engine reassembles them. When `closed` fulfills,
the engine disposes in response.

## `transportFromProcess(proc?, options?)`

Returns a `TerminalTransport` over a Node-process-shaped object.

```ts
import {TermDOM, transportFromProcess} from "@b9g/termdom";

const term = new TermDOM({transport: transportFromProcess(process)});
```

- `proc` — a structural subset of Node's `process` (the exported
  `ProcessLike` type). Defaults to the global `process`.
- `options.sharesScreen` — overrides `sharesScreen`, which defaults to
  true for the global process (it sits below a shell) and false for
  anything else.
- `options.colorScheme` — `"light"` or `"dark"`, for the frames before
  the terminal reports its background.

The wrapper owns all process-level behavior: raw mode, `SIGWINCH` →
`resizes`, signals → `closed`, `stdout.isTTY` → `interactive`, `stderr`
when it is not a terminal → `logError`, and an exit hook that restores
the cursor if the app exits without disposing.
