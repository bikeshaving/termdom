---
title: API
description: The TermDOM class, installGlobals, the TerminalTransport interface, transportFromProcess and transportFromSSH.
---

## `new TermDOM(options?)`

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
```

The constructor writes nothing to the terminal. You can use the document
right away. You can build it, style it, and measure it before you call
`attach()`, or without ever calling `attach()`.

Options:

- `transport?: TerminalTransport`: the terminal to render to. The
  default is `transportFromProcess()`, a wrapper around the global
  `process`.
- `html?: string`: the markup of the initial document. TermDOM parses
  it as a whole page. The default is an empty document. To start from a
  page stored in a file, pass the file's contents here:

  ```ts
  import {readFile} from "node:fs/promises";

  const term = new TermDOM({html: await readFile("page.html", "utf8")});
  ```

- `url?: string`: the document's URL. `document.URL` and `location.href`
  report this value.
- `cellSize?: "unit" | "auto" | {width, height}`: the size of one
  terminal cell, in CSS pixels.

  For a program written for the terminal, leave this at its default. To
  show a page written for a browser, such as a 600px-wide email, set it
  to `"auto"`. The page then shows at about the size it would have in a
  browser.

  ```ts
  const term = new TermDOM({cellSize: "auto"});
  ```

  | Value | One cell is |
  | --- | --- |
  | `"unit"` (default) | 1×1 px |
  | `"auto"` | the size the terminal reports, or 8×16 if it does not report one |
  | `{width, height}` | the given size, such as `{width: 8, height: 16}`; each side can be 0.01 to 1000 px |

  With `"auto"`, the first frame waits up to one second for the
  terminal's answer. When the user zooms the font, TermDOM asks the
  terminal again.

  These rules hold at every cell size:
  - Each box edge rounds to the nearest cell. Columns that add up to the
    width of their container still fit inside it.
  - A border is a whole number of cells, and at least one cell.
  - `1ch` is one cell: one column across and one row down.
  - `1ic` is the cell of a wide character: two columns across and one
    row down.
  - `1lh` is one row.

  A stylesheet written in `ch` and `lh` therefore looks the same at
  every cell size.

- `csp?: string`: a `Content-Security-Policy` header value that limits
  what the document's markup may load. If you leave it out, there is no
  policy and every load is allowed, which is also what a browser does
  without the header. A program that shows untrusted markup should set
  a policy. The images guide has recipes.
- `scripting?: "none" | "enabled"`: whether the page's scripts run, as
  far as its markup is concerned. The values are those of
  `@media (scripting)`. TermDOM runs no `<script>` itself, so you say.
  With `"none"` (default), a `<noscript>`'s markup is parsed and shown,
  as in a browser with scripting off, and handler attributes such as
  `onclick="..."` never run. With `"enabled"`, a `<noscript>` shows
  nothing and handler attributes run with the same access as your
  program, so only enable it for markup you trust. A `csp` whose
  `script-src-attr`, or the `script-src` or `default-src` it falls back
  to, is `'none'` turns it off.
- `reducedMotion?: "no-preference" | "reduce"`: what
  `@media (prefers-reduced-motion)` tells the page. With
  `"no-preference"` (default), its transitions run as written. With
  `"reduce"`, `@media (prefers-reduced-motion: reduce)` matches.
- `images?: "auto" | "cells" | "none"`: how an `<img>` draws.
  - `"auto"` (default) uses the best method the terminal supports.
  - `"cells"` draws two pixels per cell with half-block characters.
  - `"none"` draws nothing. The image loads nothing and shows its `alt`
    text.
- `canvas?: "auto" | "cells" | "none"`: how the `"2d"` context of a
  canvas draws. The values mean the same as for `images`. With
  `"none"`, `getContext("2d")` returns `null` and the canvas shows its
  fallback content. The `"termdom-cellgrid"` context works with every
  value, except that its `drawImage()` draws nothing.
- `colorDepth?: "auto" | ColorDepth`: how many colors the terminal can
  show. Pass the number of bits that `screen.colorDepth` reports (`24`,
  `8` or `4`), or the matching name (`"rgb"`, `"256"` or `"ansi"`).
  With `"auto"` (default), TermDOM asks the terminal. Any other value
  throws a `TypeError`. See "Color depth" in the styling guide.
- `colorScheme?: "auto" | "light" | "dark"`: whether the terminal's
  background is light or dark. `prefers-color-scheme` reports this
  value. With `"auto"` (default), TermDOM asks the terminal, and uses
  light if the terminal does not answer. Any other value throws a
  `TypeError`.
- `failFast?: boolean`: whether an uncaught exception from the page
  ends the session. With `false` (default), TermDOM reports the error
  and the program keeps running, as a browser does. With `true`, the
  first one restores the terminal, prints the error and closes the
  transport with status 1. The process transport exits, and an SSH
  transport ends that client's session only. Use it during development,
  for example `failFast: process.env.NODE_ENV !== "production"`.
  Any value that is not a boolean throws a `TypeError`. See "Errors" in
  the events guide.

TermDOM reads no environment variables. It asks the terminal for what
the terminal can report. You set everything else through options.

### `term.document`, `term.window`

`document` is a `Document`. Setting `document.title` sets the title of
the terminal window. `dispose()` restores the previous title.

`window` has the same type as a browser's window,
`Window & typeof globalThis`, taken from the DOM types in TypeScript 6.
The DOM types in TypeScript 5 lack some of the interfaces that this
type uses. On TypeScript 5, set `skipLibCheck` in your tsconfig.

`window` has the DOM interfaces and event constructors. These members
are connected to the terminal:

- `innerWidth`, `innerHeight`, `outerWidth`, `outerHeight`: the terminal
  size, in cells.
- `screenTop`: the row where the rendered region starts.
- `scrollY`, `pageYOffset`, `scrollTo()`, `scrollBy()`, `scroll()`:
  document scrolling.
- `requestAnimationFrame()`, `cancelAnimationFrame()`: the callback runs
  at the start of the next frame, before that frame is laid out and
  painted, as in a browser. Changes the callback makes appear in that
  frame.
- `matchMedia()`: live `MediaQueryList` objects. TermDOM evaluates them
  again on each resize.
- `resize`: fires when the terminal size changes. It fires before the
  `change` events that the resize causes on `MediaQueryList` objects.
- `getSelection()`: the document selection, including `modify()`.
- `CSS.highlights`: the highlight registry. `::highlight()` rules paint
  its highlights.
- `navigator.clipboard.writeText()` / `readText()`: the system
  clipboard, over OSC 52. A program can use them only while a trusted
  user event is being dispatched. `readText()` rejects when the terminal
  does not answer.
- `navigator.userActivation`: `hasBeenActive` and `isActive`.
- `MutationObserver`, `ResizeObserver`, `IntersectionObserver`: TermDOM
  delivers their entries once per rendered frame.
- `close()`: quits. In order, it:
  1. fires `beforeunload`,
  2. leaves the final frame in the scrollback,
  3. restores terminal modes,
  4. disposes,
  5. calls `transport.close({status})`. On the default transport, this
     exits the process.

  If a `beforeunload` listener calls `preventDefault()`, the session
  stays open. Ctrl-C calls `close()` and does not reach `keydown`.

  The exit status is:
  - 130 when Ctrl-C closed the window. This is the status a shell
    reports for an interrupt.
  - 1 when the page let an exception escape.
  - otherwise `process.exitCode`, or 0 if the program did not set it.

  On the default transport, a `SIGINT`, `SIGHUP` or `SIGTERM` sent to
  the process ends the session and exits with status 130, 129 or 143.
  If the program listens for that signal itself, the session still
  ends, but TermDOM does not exit the process. The program decides when
  to exit, which matches how Node treats a signal that has a listener.

Everything not listed here behaves as the DOM and CSSOM standards
specify, with no connection to the terminal.

### Styling the built-in controls

A page styles the inner parts of form controls with the same
pseudo-elements that browsers provide:

| Control | Pseudo-elements |
| --- | --- |
| `<input>` text types, `<textarea>` | `::placeholder` |
| `<select>` | `::picker(select)`, `::picker-icon` |
| `<details>` | `::details-content` |
| `<progress>`, `<meter>` | `::slider-track`, `::slider-fill` |
| `<input type="range">` | `::slider-track`, `::slider-fill`, `::slider-thumb` |

Chromium uses the names `::picker(select)` and `::picker-icon` for a
customizable `<select>`.

```css
select::picker(select) { background-color: #1c1c1c; }
select::picker-icon { color: gray; }
```

The names `::slider-track`, `::slider-fill` and `::slider-thumb` come
from the CSS Form Control Styling draft (css-forms-1).

- On a `<progress>` or `<meter>`, TermDOM paints the track and the fill
  with their backgrounds. The fill covers the track up to the value.
- A range input draws its track and fill as lines in its `color`. The
  thumb sits at the end of the fill.
- A meter matches `:optimal-value` when its value is in its optimum
  range, `:low-value` when the value is below `low`, and `:high-value`
  when the value is above `high`.

The draft may still change, and these names will change with it. The
WebKit and Firefox names below have shipped for years, so they are the
stable choice.

```css
progress::slider-fill { background-color: green; }
meter:low-value::slider-fill { background-color: orange; }
```

TermDOM accepts the prefixed names from WebKit and Firefox as aliases:

- Track: `::-webkit-progress-bar` and `::-webkit-meter-bar`.
- Fill: `::-webkit-progress-value`, `::-moz-progress-bar` and
  `::-moz-meter-bar`.
- A meter's fill at each level: `::-webkit-meter-optimum-value`,
  `::-webkit-meter-suboptimum-value` and
  `::-webkit-meter-even-less-good-value`.
- The meter itself at each level: `:-moz-meter-optimum`,
  `:-moz-meter-sub-optimum` and `:-moz-meter-sub-sub-optimum`.

A page cannot style the other parts of a control, such as the brackets
around a button. Browsers have the same limit. The controls are shadow
trees, and `::part()` does not reach into them. TermDOM's own styles
for the pseudo-elements above come first, so the page's rules override
them.

### `term.addEventListener("fetch", listener)`

A `TermDOM` is an `EventTarget`. For each image that its markup loads
and `csp` allows, it receives a `"fetch"` event, which is a
`FetchEvent`. A listener answers the event with `event.respondWith()`:

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM({csp: "img-src data:"});
term.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
```

When `csp` blocks a load, TermDOM fires `securitypolicyviolation` at
the element instead. The images guide covers both events.

### `term.measureCell()`

Asks the terminal how many of its pixels one cell covers, and resolves
to `{width, height}`, or to `null` when there is no terminal to ask
(before `attach()`, after `dispose()`, or when output is not a
terminal) or the terminal does not answer. Most terminals answer
(XTWINOPS 16); the Linux console does not.

This is the terminal's own measurement, whatever the `cellSize` option
says. Cells are seldom square: an 11 by 25 pixel cell is about 2.27
times as tall as it is wide. Divide by it to draw something to its
true shape on a canvas.

```ts
const cell = await term.measureCell();
const aspect = cell ? cell.height / cell.width : 2;
```

Each call asks the terminal again. Calls made while a question is out
share its answer.

### `term.addEventListener("cellchange", listener)`

Fires a `CellChangeEvent`, with `width` and `height`, when the
terminal's cell is measured at a different size: when its first answer
after `attach()` replaces the size TermDOM assumed until then, and
after a font zoom. Images resize with it on their own. Anything drawn
to the cell's shape can redraw here.

```ts
term.addEventListener("cellchange", (event) => {
  drawChart(event.height / event.width);
});
```

### `term.attach()`

`attach()` puts the terminal in raw mode. It starts input handling,
mouse reporting, and bracketed paste, and it paints the current
document. Calling it a second time does nothing. Apart from `print()`,
it is the only call that writes to the terminal. It returns a promise
that resolves once the first frame has been written.

While a TermDOM is attached to the process transport, the process stays
alive until `dispose()` or `window.close()`.

`document.visibilityState` is `"hidden"` before `attach()`, `"visible"`
until `dispose()`, and `"hidden"` after that. It is also `"hidden"`
while the terminal's scrollback has control of the mouse wheel, until
the next keystroke. `visibilitychange` fires on each change.

### `term.renderANSI(html?)`

Returns the whole document as an ANSI string at the terminal's width.
The string contains colors and line breaks, but no cursor movement. If
you pass an HTML string, `renderANSI()` renders that string instead and
does not change the document.

```ts
const page = term.renderANSI();
const error = term.renderANSI(`<div style="color:red">error</div>`);
```

It works whether or not the TermDOM is attached, and it does not
disturb a live session.

### `term.print(html?)`

Writes `renderANSI(html)` to the terminal as ordinary output. Await it
before the program exits.

### `term.dispose()`

`dispose()` undoes `attach()`. It leaves the document in the
scrollback, restores every terminal mode and the title, and releases
the transport. The process keeps running. Only `window.close()` quits.

It stops the timers set through `term.window`, as a browser stops the
timers of a page it unloads. Under `installGlobals()`, the global
`setTimeout` and `setInterval` report errors as the page's, but they
keep running after `dispose()`, because the whole process uses them,
including its libraries.

Before it releases the transport, `dispose()` waits up to 200 ms for
replies the terminal still owes. Otherwise those replies would show up
in the shell as typed text. It returns a promise that resolves when the
terminal has been restored. Every call returns the same promise. Await
it before you write more output.

The process transport also restores the modes the shell needs right
away. A program that exits without awaiting `dispose()` still leaves
the shell usable.

`await using term = new TermDOM()` disposes the TermDOM when the scope
ends, and waits for that to finish.

## `installGlobals(term)`

Copies the window's globals onto `globalThis`. Use it for code that
reads `document`, `window`, `Element`, `getSelection` and similar names
as globals, such as React, Vue, Svelte and CodeMirror.

Some names are defined by both the window and the runtime, such as
`setTimeout`, `navigator`, and, on Bun and Deno, `addEventListener` and
`alert`. Those names refer to the window's version until you uninstall.
Methods are bound to the window. Other properties read from and write
to the window, so a value such as `scrollY` stays current.

```ts
import {installGlobals, TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const uninstall = installGlobals(term);
const {createRoot} = await import("react-dom/client");
```

Install the globals before you import the framework, and import the
framework with `await import()`. Frameworks inspect the environment
when their modules load, and static imports load before any of your
code runs. Putting a side-effect import first does not help. Bun runs a
CommonJS package imported by name, such as React, before the modules
imported above it.

`installGlobals()` returns a function that restores the previous
globals. Only one TermDOM's globals can be installed at a time. Calling
`installGlobals()` again before uninstalling throws.

A few names keep the runtime's version:

- `Event`, `EventTarget`, `CustomEvent`, `ErrorEvent` and
  `MessageEvent`. On Bun and Deno, the runtime's own event targets
  accept only the runtime's events. The document accepts the runtime's
  events too, so the runtime's classes work for both.
- `localStorage` and `sessionStorage`, when the runtime has them.
  Deno's storage, and Node's with `--localstorage-file`, keeps data
  between runs. The window's storage keeps data in memory only. Bun,
  and Node without `--localstorage-file`, have no storage, so
  `installGlobals()` installs the window's.

Features a terminal does not have, such as `indexedDB` or `caches`, are
not on the window and are not installed. Feature detection finds them
missing and uses its fallback.

While the globals are installed, a promise rejected with no handler
belongs to the page. TermDOM fires `unhandledrejection` on the window.
If no listener cancels that event, TermDOM reports the rejection the
same way it reports an uncaught exception, and the program keeps
running. Without the globals, the runtime would end the process.

When you uninstall, TermDOM does not touch a name that other code has
redefined since the install.

## `TerminalTransport`

The interface between the engine and a terminal. Implement it to embed
TermDOM somewhere other than a process, such as an SSH server, a
terminal in a browser, or a test harness.

A transport serves one TermDOM. The first TermDOM to attach takes the
transport's streams permanently. If another TermDOM attaches to the
same transport, its `attach()` rejects with an `InvalidStateError`,
even if the first TermDOM has been disposed. To show a different
document on the same terminal, you have two choices:

- Keep the TermDOM and replace the contents of its document.
- On a process, attach a new TermDOM with a new
  `transportFromProcess()`.

An SSH session opens its shell only once, so it has one transport and
one TermDOM.

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

Chunks on `readable` are strings. A wrapper that reads bytes must
decode them with a streaming decoder, so that no code point is split
between chunks. Escape sequences may be split between chunks; the
engine joins them back together. When `closed` fulfills, the engine
disposes.

## `transportFromProcess(proc?, options?)`

Returns a `TerminalTransport` over an object shaped like a Node
process.

```ts
import {TermDOM, transportFromProcess} from "@b9g/termdom";

const term = new TermDOM({transport: transportFromProcess(process)});
```

- `proc`: an object with a subset of the members of Node's `process`.
  The exported `ProcessLike` type lists them: `stdin`, `stdout`,
  `stderr`, `on`, `removeListener` and `exit`. The default is the
  global `process`.
- `options.sharesScreen`: overrides `sharesScreen`. The default is true
  for the global process, because it runs below a shell, and false for
  any other object.

The wrapper handles everything at the process level:

- raw mode
- `SIGWINCH` as `resizes`, and signals as `closed`
- `stdout.isTTY` as `interactive`
- sending the terminal no queries when stdin is not a terminal, because
  the wrapper could not read the answers
- `stderr` as `logError`, when stderr is not the terminal
- `suspend()`, which leaves raw mode and sends the process `SIGTSTP`,
  then waits for `SIGCONT` (not on Windows)
- an exit hook that restores the terminal if the program exits without
  disposing. The hook runs before an uncaught exception is printed.

## `transportFromSSH(session, options?)`

Returns a `TerminalTransport` over an SSH session from
[ssh2](https://github.com/mscdex/ssh2). Use it in a program that acts
as its own SSH server and gives each session its own document.

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

- `session`: the value returned by accepting ssh2's `"session"` event,
  or any object with the same shape (the exported `SSHSessionLike`
  type). TermDOM does not depend on ssh2.
- `options.sharesScreen`: defaults to true. The client's shell output
  is above the `ssh` command, so the document anchors below it.

How the transport handles the session:

- It accepts the session's pty request and takes the terminal size from
  it. Without a pty request, the size is 80×24.
- It accepts the shell request. That request opens the channel that
  carries input and frames, and `ready` resolves when the channel opens.
- Each window change becomes a resize.
- It leaves other requests, such as `exec`, to ssh2, which refuses them.
- The session closes when the channel closes or when the client's input
  ends, as with `ssh host < /dev/null`. The channel ends once the
  terminal's modes are restored.
- `window.close()` sends the exit status and ends the channel.

To serve a program to real users, you can instead use an OpenSSH
`Match` block with `ForceCommand node /path/to/app.ts`. That runs the
program on a real pty with `transportFromProcess`.
[`examples/ssh.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/ssh.ts)
is a complete server.

A server that holds many sessions in one process gives each session its
own `TermDOM`. If a session's listeners, timers or frames let an
exception escape, TermDOM reports it to that session's window and log.
Two things still belong to the whole server, because the process has
only one of each:

- Globals. `installGlobals()` puts one window on `globalThis`. A server
  instead passes each session's `document` to its framework. For
  example, React's `createRoot()` takes `term.document.body`.
- Unhandled promise rejections. The runtime decides what happens to
  them, and Node ends the process along with every session in it. A
  server that should survive one session's mistake listens for them
  itself, with `process.on("unhandledRejection", ...)`.

## Other exports

`TermDOM`, `installGlobals`, `transportFromProcess` and
`transportFromSSH` are the entry points described above. The package
also exports:

- `FetchEvent`, `ExtendableEvent` and the `FetchEventInit` type, for
  the `"fetch"` event.
- `CellChangeEvent` and the `CellChangeEventInit` type, for the
  `"cellchange"` event.
- The types `TermDOMOptions`, `TermDOMEventMap`, `CellSize`,
  `ColorDepth`, `TerminalTransport`, `TerminalCloseInfo`,
  `TerminalSize`, `ProcessLike` and `SSHSessionLike`.
- `CanvasCellGridContext`, the type of the experimental
  `"termdom-cellgrid"` context. It may change in a minor release.

Custom transports and mocks implement `TerminalTransport` and the
shapes that `transportFromProcess` and `transportFromSSH` accept. Any
member added to these types later will therefore be optional.
