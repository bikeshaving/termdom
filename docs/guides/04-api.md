---
title: API
description: The TermDOM class, the TerminalTransport contract, and the process wrapper — the entire surface that isn't the DOM itself.
---

Almost everything in TermDOM is the DOM: `document`, `window`, elements,
events, observers, all behaving as they do in a browser. This page documents
the part that isn't — one class, one interface, and one function.

## `new TermDOM(options?)`

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
```

Construction is inert: no bytes are written, no terminal modes change, and
input is untouched until `attach()`. The document is live immediately —
build it, style it, measure it with `getBoundingClientRect()` — all before
(or without) taking the terminal.

Options:

- `transport` — the terminal to render to, as a [`TerminalTransport`](#terminaltransport).
  Defaults to a wrapper around the global `process`, so the zero-config path
  renders to the real terminal.

### `term.document`, `term.window`

The DOM. `document` is a real `Document`; `window` carries the platform:
`requestAnimationFrame` (resolves when the frame that includes your pending
mutations has been written), `matchMedia`, `getSelection`, scrolling
(`scrollY`, `scrollTo`, `scrollBy`), `innerWidth`/`innerHeight` in cells,
and the observers.

Two window members reach the terminal itself:

- **`window.close()`** — end the session, the way it closes a tab: the final
  frame is flushed to scrollback, modes are restored, and the transport is
  closed. On the default process transport that exits the process. An
  unhandled Ctrl-C performs exactly this call as its default action; handle
  `keydown` and `preventDefault()` to override it.
- **`document.title`** — sets the terminal's window title (OSC 2, in-band).
  The previous title is saved on `attach()` and restored on `dispose()`.

### `term.attach(transport?)`

Take the terminal. This is the only call that does: raw mode, input,
mouse reporting, bracketed paste, and capability negotiation all begin here,
and the document paints whatever it already holds. Idempotent.

Passing a transport rebinds the instance to it — allowed only before the
first attach.

### `term.renderToString(lineEnding?)`

The document as an ANSI string: colors and line breaks, no cursor controls,
no modes. Needs no `attach()` and touches nothing. For files, tests, and
piped output.

### `term.print()`

`renderToString()` written to the transport once, as ordinary command
output — `console.log` for a DOM. No takeover.

### `term.dispose()`

Reverse of `attach()`: flush the document into scrollback, restore every
mode and the title, release the transport, and tear down timers and
listeners. `using term = new TermDOM()` disposes on scope exit.

## `TerminalTransport`

The wire between the engine and a terminal — a structural interface modeled
on the common subset of WebTransport and WebSocketStream, so a future
network relay speaks it natively:

```ts
interface TerminalTransport {
	readonly cols: number;
	readonly rows: number;
	readonly readable: ReadableStream<string>; // user input
	readonly writable: WritableStream<string>; // frames out
	readonly resizes?: ReadableStream<{cols: number; rows: number}>;
	readonly closed: Promise<TerminalCloseInfo | void>;
	close?(info?: {code?: number; reason?: string}): void;
	colorDepth?: "ansi" | "256" | "rgb"; // absent = rgb
	interactive?: boolean; // absent = true; false = piped output
	sharesScreen?: boolean; // prior content above: anchor at the cursor
}
```

You read *from* the terminal (keystrokes) and write *to* it (frames), the
`WebSocketStream` orientation. `closed` settles when the terminal goes away
(hangup, disconnect); `close()` is the app being done with it — an exit
code on the process, `channel.end()` on an SSH relay, the embedder's own
decision under xterm.js.

Anything satisfying this shape is a terminal: a Node process via
`transportFromProcess` (the default), an xterm.js instance behind a
fifteen-line adapter, an SSH PTY channel.

## `transportFromProcess(proc?, options?)`

The default wrapper, exported for explicit use:

```ts
import {TermDOM, transportFromProcess} from "@b9g/termdom";

const term = new TermDOM({transport: transportFromProcess(process)});
```

Everything Node-shaped lives inside it: raw mode (engaged on first read,
released on teardown), `SIGWINCH` → `resizes`, signal handling → `closed`,
`TERM`/`COLORTERM` sniffing → `colorDepth`, `stdout.isTTY` → `interactive`,
and a process exit hook that restores the cursor if an app dies without
disposing. `proc` is a structural subset of Node's `process` (the
`ProcessLike` type), so tests can hand it mocks.
