---
title: API
description: The TermDOM class, installGlobals, the TerminalTransport interface, transportFromProcess and transportFromSSH.
---

## `new TermDOM(options?)`

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
```

The constructor writes nothing. You can build, style, and measure the
document before `attach()`, or without ever calling it.

Options:

- `transport?: TerminalTransport`: the terminal to render to. Defaults
  to `transportFromProcess()` over the global `process`.
- `html?: string`: the initial document's markup, parsed as a full
  page. Defaults to an empty document.

  ```ts
  import {readFile} from "node:fs/promises";

  const term = new TermDOM({html: await readFile("page.html", "utf8")});
  ```

- `url?: string`: the document's URL, reported by `document.URL` and
  `location.href`.
- `cellSize?: "unit" | "auto" | {width, height}`: the size of a cell in
  CSS pixels. Keep the default for terminal programs. Use `"auto"` to
  show pages written for a browser, such as a 600px-wide email, at
  roughly browser size.

  | Value | One cell is |
  | --- | --- |
  | `"unit"` (default) | 1×1 px |
  | `"auto"` | What the terminal reports, or 8×16 |
  | `{width, height}` | The given size, 0.01 to 1000 px a side |

  With `"auto"`, the first frame waits up to a second for the terminal
  to answer, and TermDOM asks again when the font is zoomed.

  At any cell size, box edges round to the nearest cell, borders are at
  least one cell, `1ch` and `1lh` are one cell, and `1ic` is two
  columns. Stylesheets written in `ch` and `lh` look the same at every
  cell size.

- `csp?: string`: a `Content-Security-Policy` that limits what markup
  may load. Without it, everything loads. Set one for untrusted markup;
  the images guide has examples.
- `scripting?: "none" | "enabled"`: what the markup treats as the
  scripting state, matching `@media (scripting)`. TermDOM never runs
  `<script>`. With `"none"` (default), `<noscript>` content shows and
  handler attributes such as `onclick="..."` don't run. With
  `"enabled"`, `<noscript>` is hidden and handler attributes run with
  your program's full access, so enable it only for trusted markup. A
  `csp` whose `script-src-attr` (or `script-src`, or `default-src`) is
  `'none'` turns it off.
- `reducedMotion?: "no-preference" | "reduce"`: what
  `@media (prefers-reduced-motion)` reports. Defaults to
  `"no-preference"`.
- `images?: "auto" | "cells" | "none"`: how `<img>` draws. `"auto"`
  (default) uses the best method available, `"cells"` draws half
  blocks, and `"none"` loads nothing and shows `alt` text.
- `canvas?: "auto" | "cells" | "none"`: the same for the `"2d"`
  context. With `"none"`, `getContext("2d")` returns `null`. The
  `"termdom-cellgrid"` context always works, but its `drawImage()`
  draws nothing under `"none"`.
- `colorDepth?: "auto" | ColorDepth`: `24`, `8`, or `4` bits, or
  `"rgb"`, `"256"`, or `"ansi"`. `"auto"` (default) asks the terminal.
  See "Color depth" in the styling guide.
- `colorScheme?: "auto" | "light" | "dark"`: whether the terminal's
  background is light or dark, as `prefers-color-scheme` reports it.
  `"auto"` (default) asks the terminal, falling back to light.
- `failFast?: boolean`: whether an uncaught exception ends the session.
  With `false` (default), it's reported and the program continues. With
  `true`, the first one restores the terminal, prints the error, and
  closes the transport with status 1. See "Errors" in the events guide.

Invalid values for `colorDepth`, `colorScheme`, and `failFast` throw a
`TypeError`.

TermDOM reads no environment variables. It asks the terminal what it
can, and everything else is an option.

### `term.document`, `term.window`

`document` is a `Document`. `document.title` sets the terminal window's
title, and `dispose()` restores the old one.

`window` is typed `Window & typeof globalThis` from TypeScript 6's DOM
types. TypeScript 5's DOM types are missing some interfaces, so set
`skipLibCheck` there.

`window` has the DOM interfaces and event constructors. These members
reflect the terminal:

- `innerWidth`, `innerHeight`, `outerWidth`, `outerHeight`: the
  terminal size in cells.
- `screenTop`: the row where the rendered region starts.
- `scrollY`, `pageYOffset`, `scrollTo()`, `scrollBy()`, `scroll()`:
  document scrolling.
- `requestAnimationFrame()`, `cancelAnimationFrame()`: callbacks run
  before the next frame is laid out, so their changes appear in it.
- `matchMedia()`: live `MediaQueryList`s, re-evaluated on resize.
- `resize`: fires when the terminal resizes, before any
  `MediaQueryList` `change` events.
- `getSelection()`: the document selection, including `modify()`.
- `CSS.highlights`: the highlight registry.
- `navigator.clipboard.writeText()` / `readText()`: the system
  clipboard over OSC 52, during user events only. `readText()` rejects
  if the terminal doesn't answer.
- `navigator.userActivation`: `hasBeenActive` and `isActive`.
- `MutationObserver`, `ResizeObserver`, `IntersectionObserver`: entries
  are delivered once per frame.
- `close()`: quits. It fires `beforeunload`, leaves the last frame in
  the scrollback, restores the terminal, disposes, and calls
  `transport.close({status})`, which exits the process on the default
  transport. A `beforeunload` listener can cancel it. Ctrl-C calls it.

  The exit status is 130 after Ctrl-C, 1 after an uncaught exception,
  and otherwise `process.exitCode` or 0.

  On the default transport, `SIGINT`, `SIGHUP`, and `SIGTERM` end the
  session and exit with 130, 129, or 143. If the program listens for
  the signal itself, the session ends but the process doesn't exit, as
  in Node.

Everything else follows the DOM and CSSOM standards.

### Styling the built-in controls

| Control | Pseudo-elements |
| --- | --- |
| `<input>` text types, `<textarea>` | `::placeholder` |
| `<select>` | `::picker(select)`, `::picker-icon` |
| `<details>` | `::details-content` |
| `<progress>`, `<meter>` | `::slider-track`, `::slider-fill` |
| `<input type="range">` | `::slider-track`, `::slider-fill`, `::slider-thumb` |

`::picker(select)` and `::picker-icon` are Chromium's names for a
customizable `<select>`.

```css
select::picker(select) { background-color: #1c1c1c; }
select::picker-icon { color: gray; }
```

`::slider-track`, `::slider-fill`, and `::slider-thumb` come from the
CSS Form Control Styling draft and may change with it.

- On `<progress>` and `<meter>`, the track and fill are painted with
  their backgrounds, the fill up to the value.
- A range input draws its track and fill as lines in its `color`, with
  the thumb at the end of the fill.
- A meter matches `:optimal-value` in its optimum range, `:low-value`
  below `low`, and `:high-value` above `high`.

```css
progress::slider-fill { background-color: green; }
meter:low-value::slider-fill { background-color: orange; }
```

The WebKit and Firefox names also work, and won't change:

- Track: `::-webkit-progress-bar`, `::-webkit-meter-bar`.
- Fill: `::-webkit-progress-value`, `::-moz-progress-bar`,
  `::-moz-meter-bar`.
- Meter fill by level: `::-webkit-meter-optimum-value`,
  `::-webkit-meter-suboptimum-value`,
  `::-webkit-meter-even-less-good-value`.
- Meter by level: `:-moz-meter-optimum`, `:-moz-meter-sub-optimum`,
  `:-moz-meter-sub-sub-optimum`.

Other parts of a control, such as a button's brackets, can't be styled.
The controls are shadow trees that `::part()` doesn't reach. Page rules
override TermDOM's own rules for the pseudo-elements above.

### `term.addEventListener("fetch", listener)`

A `TermDOM` is an `EventTarget`. Each image load that `csp` allows
fires a `"fetch"` event, a `FetchEvent`, which a listener can answer
with `respondWith()`:

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM({csp: "img-src data:"});
term.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
```

Blocked loads fire `securitypolicyviolation` at the element instead.
The images guide covers both.

### `term.measureCell()`

Resolves to the terminal's cell size in its own pixels, `{width,
height}`, whatever `cellSize` says. Resolves to `null` with no terminal
to ask (before `attach()`, after `dispose()`, or when output isn't a
terminal) or no answer. Most terminals answer XTWINOPS 16; the Linux
console doesn't.

Cells are rarely square. Use the ratio to draw true shapes on a canvas:

```ts
const cell = await term.measureCell();
const aspect = cell ? cell.height / cell.width : 2;
```

Each call asks again. Concurrent calls share one answer.

### `term.addEventListener("cellchange", listener)`

Fires a `CellChangeEvent`, with `width` and `height`, when the cell
size changes: when the terminal's first answer replaces the assumed
size, and after a font zoom. Images resize on their own; redraw
anything else drawn to the cell's shape here.

```ts
term.addEventListener("cellchange", (event) => {
  drawChart(event.height / event.width);
});
```

### `term.attach()`

Puts the terminal in raw mode, starts input, mouse reporting, and
bracketed paste, and draws the document. Calling it again does nothing.
Only `attach()` and `print()` write to the terminal. Returns a promise
that resolves once the first frame is written.

While attached to the process transport, the process stays alive until
`dispose()` or `window.close()`.

`document.visibilityState` is `"hidden"` before `attach()` and after
`dispose()`, and `"visible"` in between, except while the wheel is
scrolling the terminal's scrollback. `visibilitychange` fires on each
change.

### `term.renderANSI(html?)`

Returns the document as an ANSI string at the terminal's width, with
colors and line breaks but no cursor movement. Given an HTML string, it
renders that instead, leaving the document alone.

```ts
const page = term.renderANSI();
const error = term.renderANSI(`<div style="color:red">error</div>`);
```

It works attached or not, without disturbing a live session.

### `term.print(html?)`

Writes `renderANSI(html)` as ordinary output. Await it before exiting.

### `term.dispose()`

Undoes `attach()`: leaves the document in the scrollback, restores the
terminal and its title, and releases the transport. The process keeps
running; only `window.close()` quits.

It stops timers set through `term.window`. Under `installGlobals()`,
the global `setTimeout` and `setInterval` keep running, since the whole
process and its libraries share them.

It waits up to 200 ms for replies the terminal still owes, so they
don't show up in the shell as typed text. It returns a promise that
resolves when the terminal is restored, the same promise on every call.
Await it before writing more output.

The process transport restores what the shell needs immediately, so
exiting without awaiting still leaves the shell usable.

`await using term = new TermDOM()` disposes at the end of the scope.

## `installGlobals(term)`

Copies the window's globals onto `globalThis`, for code that reads
`document`, `window`, `Element`, and so on as globals, such as React,
Vue, Svelte, and CodeMirror.

Names both the window and runtime define, such as `setTimeout`,
`navigator`, and on Bun and Deno `addEventListener` and `alert`, point
to the window's until you uninstall. Methods are bound to the window;
other properties read and write through to it, so `scrollY` stays
current.

```ts
import {installGlobals, TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const uninstall = installGlobals(term);
const {createRoot} = await import("react-dom/client");
```

Install before importing the framework, and import it with `await
import()`: frameworks inspect globals when they load, and static
imports load first. A side-effect import placed first doesn't help,
because Bun runs CommonJS packages imported by name, such as React,
before the modules above them.

It returns a function that restores the previous globals. Calling it
again before uninstalling throws.

These keep the runtime's version:

- `Event`, `EventTarget`, `CustomEvent`, `ErrorEvent`, and
  `MessageEvent`. On Bun and Deno, the runtime's event targets accept
  only the runtime's events, and the document accepts both.
- `localStorage` and `sessionStorage`, if the runtime has them. Deno's,
  and Node's with `--localstorage-file`, persist between runs. The
  window's are in memory only, and are installed on Bun and on Node
  without `--localstorage-file`.

Features a terminal lacks, such as `indexedDB` and `caches`, aren't on
the window, so feature detection falls back.

While installed, unhandled rejections fire `unhandledrejection` on the
window. If uncanceled, they're reported like uncaught exceptions and
the program continues, where the runtime would have exited.

Uninstalling leaves alone any name that other code has redefined.

## `TerminalTransport`

The interface between TermDOM and a terminal. Implement it to run
TermDOM over something other than a process, such as an SSH server, a
browser terminal, or a test harness.

A transport serves one TermDOM, permanently. A second TermDOM's
`attach()` rejects with `InvalidStateError`, even after the first is
disposed. To show a different document, replace the document's
contents, or on a process, attach a new TermDOM with a new
`transportFromProcess()`. An SSH session opens its shell once, so it
has one transport and one TermDOM.

```ts
interface TerminalTransport {
	readonly cols: number; // live: always the current size
	readonly rows: number;
	readonly interactive: boolean; // false: plain line output (a pipe)
	// Optional. Takes an error's text somewhere the frame does not share;
	// true when it did. The engine keeps what it cannot place and prints
	// it below the document at the end.
	logError?(text: string): boolean;
	// Optional. Writes to the terminal at once, ahead of anything queued,
	// for what has to reach it as the process ends.
	writeSync?(text: string): void;
	readonly sharesScreen: boolean; // true: anchor below existing content
	readonly readable: ReadableStream<string>; // user input
	readonly writable: WritableStream<string>; // frames out
	readonly resizes: ReadableStream<{cols: number; rows: number}>;
	readonly ready: Promise<void>; // established; Promise.resolve() if born so
	readonly closed: Promise<TerminalCloseInfo>; // the terminal went away
	// Optional. Stops the program as a shell's job control does, and
	// resolves when it continues; the engine hands the terminal back before
	// and takes it again after. Without it, Ctrl+Z is an ordinary key.
	suspend?(): Promise<void>;
	// Ends the medium if the transport owns it (the process transport exits
	// the process); a no-op otherwise.
	close(info?: TerminalCloseInfo): void;
}

interface TerminalCloseInfo {
	status?: number; // the exit status: process.exit, or SSH's exit-status
}
```

`readable` yields strings. A wrapper reading bytes must use a streaming
decoder so code points aren't split; escape sequences may be split, and
TermDOM reassembles them. When `closed` fulfills, TermDOM disposes.

## `transportFromProcess(proc?, options?)`

Returns a `TerminalTransport` over a Node-style process.

```ts
import {TermDOM, transportFromProcess} from "@b9g/termdom";

const term = new TermDOM({transport: transportFromProcess(process)});
```

- `proc`: an object with `stdin`, `stdout`, `stderr`, `on`,
  `removeListener`, and `exit`, as the exported `ProcessLike` type
  describes. Defaults to the global `process`.
- `options.sharesScreen`: defaults to true for the global process and
  false otherwise.

It handles:

- raw mode
- `SIGWINCH` as `resizes`, and signals as `closed`
- `stdout.isTTY` as `interactive`
- sending no queries when stdin isn't a terminal, since it couldn't
  read the answers
- `stderr` as `logError`, when stderr isn't the terminal
- `suspend()`: leaves raw mode, sends `SIGTSTP`, and waits for
  `SIGCONT` (not on Windows)
- an exit hook that restores the terminal if the program exits without
  disposing, before an uncaught exception is printed

## `transportFromSSH(session, options?)`

Returns a `TerminalTransport` over an
[ssh2](https://github.com/mscdex/ssh2) session, for a program that is
its own SSH server and gives each session a document.

```ts
import {readFileSync} from "node:fs";
import {TermDOM, transportFromSSH} from "@b9g/termdom";
import ssh2 from "ssh2";

const hostKey = readFileSync("host_key");
new ssh2.Server({hostKeys: [hostKey]}, (client) => {
	client.on("authentication", (context) => context.accept());
	client.on("session", (accept) => {
		const term = new TermDOM({transport: transportFromSSH(accept())});
		term.document.body.textContent = "Hello over SSH";
		term.attach();
	});
}).listen(2222);
```

- `session`: what accepting ssh2's `"session"` event returns, or
  anything matching the exported `SSHSessionLike` type. TermDOM doesn't
  depend on ssh2.
- `options.sharesScreen`: defaults to true, so the document appears
  below the client's earlier output.

The transport:

- accepts the pty request and takes its size, or 80×24 without one
- accepts the shell request, and resolves `ready` when its channel
  opens
- turns window changes into resizes
- leaves other requests, such as `exec`, to ssh2, which refuses them
- closes when the channel closes or the client's input ends, as with
  `ssh host < /dev/null`, after restoring the terminal
- sends the exit status and ends the channel on `window.close()`

To serve real users, you can instead use an OpenSSH `Match` block with
`ForceCommand node /path/to/app.ts`, which runs the program on a real
pty with `transportFromProcess`.
[`examples/ssh.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/ssh.ts)
is a complete server.

Each session gets its own `TermDOM`, and its errors are reported to its
own window and log. Two things are shared by the whole process:

- Globals. `installGlobals()` installs one window. Pass each session's
  `document` to its framework instead, such as
  `createRoot(term.document.body)`.
- Unhandled rejections, which end the process on Node. Listen with
  `process.on("unhandledRejection", ...)` to survive them.

## Other exports

Besides `TermDOM`, `installGlobals`, `transportFromProcess`, and
`transportFromSSH`, the package exports:

- `FetchEvent`, `ExtendableEvent`, and `FetchEventInit`, for `"fetch"`.
- `CellChangeEvent` and `CellChangeEventInit`, for `"cellchange"`.
- The types `TermDOMOptions`, `TermDOMEventMap`, `CellSize`,
  `ColorDepth`, `TerminalTransport`, `TerminalCloseInfo`,
  `TerminalSize`, `ProcessLike`, and `SSHSessionLike`.
- `CanvasCellGridContext`, the experimental `"termdom-cellgrid"`
  context's type.

Members added to the transport and process types later will be
optional, so custom transports and mocks keep working.
