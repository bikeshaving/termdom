---
title: API
description: The TermDOM class, the TerminalTransport interface, and transportFromProcess.
---

## `new TermDOM(options?)`

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
```

Construction writes nothing to the terminal and changes no terminal modes.
The document is usable immediately: it can be built, styled, and measured
before `attach()` is called, or without calling it at all.

Options:

- `transport?: TerminalTransport` — the terminal to render to. Defaults to
  `transportFromProcess()`, a wrapper around the global `process`.

### `term.document`, `term.window`

The DOM. `document` is a `Document`; `window` provides
`requestAnimationFrame` (resolves after the frame that includes your pending
mutations has been written), `matchMedia`, `getSelection`, `scrollY`,
`scrollTo`, `scrollBy`, `innerWidth`/`innerHeight` (in cells),
`MutationObserver`, `ResizeObserver`, and `IntersectionObserver`.

Two members reach the terminal:

- **`window.close()`** — flushes the final frame to scrollback, restores
  terminal modes, disposes the instance, and calls `transport.close({code: 0})`.
  On the default process transport this exits the process. An unhandled
  Ctrl-C performs this call as its default action; a `keydown` listener that
  calls `preventDefault()` overrides it.
- **`document.title`** — setting it sets the terminal window title (OSC 2).
  The previous title is saved on `attach()` and restored on `dispose()`.

### `term.attach(transport?)`

Takes the terminal: raw mode, input handling, mouse reporting, bracketed
paste, and capability negotiation begin here, and the document paints
whatever it holds. Idempotent. No other call writes to the terminal.

Passing a transport rebinds the instance to it. Rebinding is only allowed
before the first attach.

### `term.dispose()`

Reverses `attach()`: flushes the document into scrollback, restores every
terminal mode and the title, releases the transport, and clears all timers
and listeners. Returns a promise that resolves when every queued restore
has reached the transport; await it before writing further output or
exiting with a status code. The process transport also restores
shell-critical modes (mouse reporting, cursor visibility, bracketed paste)
synchronously, so a caller that exits without awaiting leaves the shell
usable. `using term = new TermDOM()` disposes on scope exit.

## `TerminalTransport`

The interface between the engine and a terminal:

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
	interactive?: boolean; // absent = true; false = plain line output
	sharesScreen?: boolean; // screen has prior content: anchor at the cursor
}
```

- `readable` carries user input: keystrokes, mouse reports, paste bursts,
  and replies to queries. `writable` receives frames.
- `resizes` emits the new size whenever the terminal is resized.
- `closed` settles when the terminal goes away (hangup, disconnect). The
  engine disposes in response.
- `close(info)` is called by `window.close()`. The process transport calls
  `process.exit(info.code)`; other transports define their own behavior.
- `interactive: false` disables cursor-addressed frames; output is written
  as plain appended lines.
- `sharesScreen: true` makes rendering anchor at the current cursor row
  (found with a DSR query) instead of row 0. When absent, the default
  process transport anchors and injected transports do not.

## `renderANSI(html, options?)`

Renders an HTML string to an ANSI string: colors and line breaks only, no
cursor controls or mode changes. `<style>` elements in the fragment join
the cascade.

```ts
import {renderANSI} from "@b9g/termdom";

const ansi = renderANSI(`<div style="color:red">error</div>`, {cols: 80});
```

- `options.cols` — line width in cells. Defaults to the terminal's width,
  then 80.

## `print(html, options?)`

`renderANSI(html, options)` appended to stdout as ordinary command output.
Returns a promise that resolves when the bytes have flushed; await it
before exiting.

## `transportFromProcess(proc?, options?)`

Returns a `TerminalTransport` over a Node-process-shaped object.

```ts
import {TermDOM, transportFromProcess} from "@b9g/termdom";

const term = new TermDOM({transport: transportFromProcess(process)});
```

- `proc` — a structural subset of Node's `process` (the exported
  `ProcessLike` type). Defaults to the global `process`.
- `options.sharesScreen` — sets the transport's `sharesScreen` field.

The wrapper owns all process-level behavior: raw mode (enabled on first
read of `readable`, released on teardown), `SIGWINCH` → `resizes`, signal
handling → `closed`, `TERM`/`COLORTERM` → `colorDepth`, `stdout.isTTY` →
`interactive`, and a process exit hook that restores the cursor if the app
exits without disposing.
