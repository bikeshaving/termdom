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

`document` is a `Document`. `window` approximates the browser's global
window: the DOM interfaces and event constructors are all present, and
these members are wired to the terminal:

- `innerWidth`, `innerHeight`, `outerWidth`, `outerHeight` — the terminal
  size, in cells
- `screenTop` — the row the rendered region starts at
- `scrollY`, `pageYOffset`, `scrollTo()`, `scrollBy()`, `scroll()` — the
  camera over the document
- `requestAnimationFrame()`, `cancelAnimationFrame()` — the callback fires
  after the frame that includes your pending mutations has been written
- `matchMedia()` — live `MediaQueryList`s, re-evaluated on resize
- `getSelection()` — the document selection
- `navigator.clipboard.writeText()` — the system clipboard, over OSC 52;
  `readText()` rejects, since terminals do not answer clipboard reads
- `MutationObserver`, `ResizeObserver`, `IntersectionObserver` — entries
  are delivered per rendered frame
- `close()` — ends the session (detailed below)

Anything not listed behaves as the DOM and CSSOM standards specify,
without terminal wiring.

`window.close()` ends the session: it flushes the final frame to
scrollback, restores terminal modes, disposes the instance, and calls
`transport.close({status: 0})` — on the default process transport, that
exits the process. An unhandled Ctrl-C performs this call as its default
action; a `keydown` listener that calls `preventDefault()` overrides it.

On `document`, setting `title` sets the terminal window title (OSC 2); the
previous title is saved on `attach()` and restored on `dispose()`.

### `term.attach(transport?)`

Takes the terminal: raw mode, input handling, mouse reporting, bracketed
paste, and capability negotiation begin here, and the document paints
whatever it holds. Idempotent. No other call writes to the terminal.
Returns a promise that resolves once the transport is established and the
first frame has been written.

While attached to the process transport, the Node event loop stays alive
(stdin is held open) until `dispose()` or `window.close()`.

Passing a transport rebinds the instance to it. Rebinding is only allowed
before the first attach.

### `term.renderANSI(html)`

Renders an HTML string to an ANSI string at the transport's width: colors
and line breaks only, no cursor controls or mode changes. `<style>`
elements in the fragment join the cascade. The instance's own document is
not consulted or touched.

```ts
const ansi = term.renderANSI(`<div style="color:red">error</div>`);
```

### `term.print(html)`

`renderANSI(html)` written through the transport, as ordinary command
output. Returns a promise that resolves when the bytes have reached the
transport; await it before exiting.

### `term.dispose()`

Reverses `attach()`: flushes the document into scrollback, restores every
terminal mode and the title, releases the transport, and clears all timers
and listeners. Returns a promise that resolves when every queued restore
has reached the transport; await it before writing further output or
exiting with a status code. The process transport also restores
shell-critical modes (mouse reporting, cursor visibility, bracketed paste)
synchronously, so a caller that exits without awaiting leaves the shell
usable. `using term = new TermDOM()` disposes on scope exit.

`dispose()` releases the terminal; the process continues. `window.close()`
is the application-level quit: it waits for attach to finish, disposes,
and then calls `transport.close({status: 0})` — process exit on the
default transport. Ctrl-C's default action is `window.close()`.

## `TerminalTransport`

The interface between the engine and a terminal:

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
	readonly closed: Promise<TerminalCloseInfo>;
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

- `readable` carries user input: keystrokes, mouse reports, paste bursts,
  and replies to queries. Chunks are strings, decoded incrementally by the
  wrapper (a byte-backed wrapper must use a streaming decoder), so code
  points never split; escape sequences may split across chunks and the
  session reassembles them. `writable` receives frames.
- `resizes` emits the new size on every terminal resize; `cols`/`rows` are
  live getters that already answer with the new size.
- `closed` fulfills with a `TerminalCloseInfo` when the terminal goes away
  (hangup, disconnect). The engine disposes in response.
- `close(info)` is called by `window.close()`. The process transport calls
  `process.exit(info.status)`; an SSH wrapper sends exit-status; an
  embedder decides for itself.
- `interactive: false` disables cursor-addressed frames; output is written
  as plain appended lines.
- `sharesScreen: true` anchors rendering at the current cursor row (found
  with a DSR query) instead of row 0 -- a terminal shared with a shell.

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

The wrapper owns all process-level behavior: raw mode (enabled on first
read of `readable`, released on teardown), `SIGWINCH` → `resizes`, signal
handling → `closed`, `TERM`/`COLORTERM` → `colorDepth`, `stdout.isTTY` →
`interactive`, and a process exit hook that restores the cursor if the app
exits without disposing.
