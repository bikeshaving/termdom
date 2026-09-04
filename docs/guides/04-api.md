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

### `term.document`, `term.window`

`document` is a `Document`. Setting `document.title` sets the terminal
window title; the previous title is restored on `dispose()`.

`window` has the DOM interfaces and event constructors, and these members
are wired to the terminal:

- `innerWidth`, `innerHeight`, `outerWidth`, `outerHeight` — the terminal
  size, in cells
- `screenTop` — the row the rendered region starts at
- `scrollY`, `pageYOffset`, `scrollTo()`, `scrollBy()`, `scroll()` —
  document scrolling
- `requestAnimationFrame()`, `cancelAnimationFrame()` — the callback fires
  after the frame that includes your pending mutations has been written
- `matchMedia()` — live `MediaQueryList`s, re-evaluated on resize
- `resize` — fired when the terminal size changes, before the
  `MediaQueryList` `change` events that resize triggers
- `getSelection()` — the document selection, `modify()` included
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

### `term.attach(transport?)`

Puts the terminal in raw mode, starts input handling, mouse reporting,
and bracketed paste, and paints whatever the document holds. Idempotent;
no other call writes to the terminal. Returns a promise that resolves
once the first frame has been written.

While attached to the process transport, the Node event loop stays alive
until `dispose()` or `window.close()`.

Passing a transport rebinds the instance to it, only before the first
attach.

### `term.renderANSI(html)`

Renders an HTML string to an ANSI string at the transport's width: colors
and line breaks only, no cursor controls or mode changes. `<style>`
elements in the fragment join the cascade. The instance's own document is
untouched.

```ts
const ansi = term.renderANSI(`<div style="color:red">error</div>`);
```

### `term.print(html)`

`renderANSI(html)` written through the transport, as ordinary command
output. Returns a promise that resolves when the bytes have reached the
transport; await it before exiting.

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
	readonly colorDepth: "ansi" | "256" | "rgb";
	readonly interactive: boolean; // false: plain line output (a pipe)
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

The wrapper owns all process-level behavior: raw mode, `SIGWINCH` →
`resizes`, signals → `closed`, `TERM`/`COLORTERM` → `colorDepth`,
`stdout.isTTY` → `interactive`, and an exit hook that restores the cursor
if the app exits without disposing.
