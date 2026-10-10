---
title: API
description: The TermDOM class, installGlobals, the TerminalTransport interface, transportFromProcess and transportFromSSH.
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
  | `{width, height}` | that size, such as `{width: 8, height: 16}`, each side from 0.01 to 1000 px |

  With `"auto"`, the first frame waits for the terminal's answer, a
  second at most, and a font zoom asks again.

  Whatever the size:
  - A box's edges round to the nearest cell, so columns that add up to
    their container still fit it. A border is whole cells, at least one.
  - `1ch` is one cell: a column across, a row down.
  - `1ic` is a wide character's cell: two columns across, a row down.
  - `1lh` is one row.

  So a stylesheet written in `ch` and `lh` looks the same at every size.

- `csp?: string` — what the document's markup may load, as a
  `Content-Security-Policy` header states it. Left out, there is no
  policy and every load is allowed, as in a browser. A program showing
  markup it does not trust sets one; the images guide has recipes.
- `images?: "auto" | "cells" | "none"` — how an `<img>` draws. `"auto"`
  (default) uses the best way the terminal has, `"cells"` draws two
  pixels to a cell in half blocks, and `"none"` draws nothing: an image
  loads nothing and shows its `alt` text.
- `canvas?: "auto" | "cells" | "none"` — how a canvas's `"2d"` context
  draws, the same way. With `"none"`, `getContext("2d")` returns `null`
  and the canvas shows its fallback content. The `"termdom-cellgrid"`
  context works either way, except that its `drawImage()` draws
  nothing.
- `colorDepth?: "auto" | ColorDepth` — the colors the terminal shows:
  `24`, `8` or `4`, the bits `screen.colorDepth` reports, or `"rgb"`,
  `"256"` or `"ansi"`, the same three by name. With `"auto"` (default),
  TermDOM asks the terminal. Any other value throws a `TypeError`. See "Color depth" in the
  styling guide.
- `colorScheme?: "auto" | "light" | "dark"` — whether the terminal's
  background is light or dark, which `prefers-color-scheme` reports.
  With `"auto"` (default), TermDOM asks the terminal, and takes light
  when it gives no answer. Any other value throws a `TypeError`.

TermDOM reads no environment variables. What the terminal can say, it is
asked, and the rest is an option.

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
- `close()` — quit: fire `beforeunload`, then flush the final frame to
  scrollback, restore terminal modes, dispose, and call
  `transport.close({status})`, which exits the process on the default
  transport. A `beforeunload` listener that calls `preventDefault()`
  keeps the session. Ctrl-C calls `close()`; it does not reach `keydown`.
  The status is 130 when Ctrl-C closed the window, as a shell reports an
  interrupt, 1 when the page let an exception escape, and otherwise
  `process.exitCode`, or 0 if the app set none.
  On the default transport, a `SIGINT`, `SIGHUP` or `SIGTERM` sent to the
  process ends the session and exits with 130, 129 or 143. If the app
  listens for that signal itself, the session still ends, but the exit is
  left to the app, as in Node.

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
| `<progress>`, `<meter>` | `::slider-track`, `::slider-fill` |
| `<input type="range">` | `::slider-track`, `::slider-fill`, `::slider-thumb` |

`::picker(select)` and `::picker-icon` are a customizable `<select>`'s,
as Chromium ships them.

```css
select::picker(select) { background-color: #1c1c1c; }
select::picker-icon { color: gray; }
```

`::slider-track`, `::slider-fill` and `::slider-thumb` are CSS Form
Control Styling's (css-forms-1). A gauge's track and fill are painted by
their backgrounds, as in a browser: the fill covers the track as far as
the value reaches. A range input draws its track and fill as lines, which
`color` colors, and its thumb follows the fill. A meter
matches `:optimal-value` when its value is in its optimum region,
`:low-value` below `low`, and `:high-value` above `high`. css-forms-1 is
an editor's draft, so these follow it as it changes; the WebKit and
Firefox names below have shipped for years and are the stable choice.

```css
progress::slider-fill { background-color: green; }
meter:low-value::slider-fill { background-color: orange; }
```

The prefixed names WebKit and Firefox ship work too, as aliases:
`::-webkit-progress-bar` and `::-webkit-meter-bar` are the track,
`::-webkit-progress-value`, `::-moz-progress-bar` and `::-moz-meter-bar`
the fill, `::-webkit-meter-optimum-value`,
`::-webkit-meter-suboptimum-value` and
`::-webkit-meter-even-less-good-value` a meter's fill at each level,
and `:-moz-meter-optimum`, `:-moz-meter-sub-optimum` and
`:-moz-meter-sub-sub-optimum` the meter at each level.

The rest of a control's insides, such as a button's brackets, are
TermDOM's own, as they are a browser's: the
controls are shadow trees inside, and `::part()` does not reach into
them. TermDOM's own rules come first, so a page's `::placeholder` and the
rest override them as they would any built-in style.

### `term.addEventListener("fetch", listener)`

A `TermDOM` is an `EventTarget`. It receives a `"fetch"` event, a
`FetchEvent`, for each image its markup loads that `csp` allows, and a
listener answers it with `event.respondWith()`:

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM({csp: "img-src data:"});
term.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
```

A load `csp` blocks fires `securitypolicyviolation` at its element
instead. The images guide has both.

### `term.attach()`

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
continues; `window.close()` is the quit. It stops the timers set through
`term.window`, as a browser stops an unloaded page's. Under
`installGlobals()`, the global `setTimeout` and `setInterval` report
what their callbacks throw as the page's errors, but are the whole
process's, its libraries' among them, and keep running. Before
releasing the transport it reads the cursor replies the terminal still
owes, for 200ms at most, so they don't land in the shell as typing.
Returns a promise that resolves when every queued restore has reached
the transport, and every call returns the same promise; await it before
writing further output. The process transport also restores
shell-critical modes synchronously, so a caller that exits without
awaiting still leaves the shell usable. `await using term = new TermDOM()`
disposes on scope exit and waits for it.

## `installGlobals(term)`

Defines the window's names on `globalThis`, for code that reads
`document`, `window`, `Element`, `getSelection` and the like as globals:
React, Vue, Svelte, CodeMirror. The process then reads as the window
does. A name the runtime defines too, such as `setTimeout`,
`navigator` or, on Bun and Deno, `addEventListener` and `alert`, is the
window's until uninstalled. Methods are bound to the
window, and other properties read and write through to it, so `scrollY`
stays current.

```ts
import {installGlobals, TermDOM} from "@b9g/termdom";

const term = new TermDOM();
const uninstall = installGlobals(term);
const {createRoot} = await import("react-dom/client");
```

Install them before importing the framework, with `await import()`.
Frameworks read the environment when their modules load, and static
imports load before any code runs. A side-effect import placed first
does not help: Bun runs a CommonJS package that is imported by name,
as React is, before the modules imported above it.

It returns a function that puts back what was there. One TermDOM's
globals can be installed at a time; calling it again before uninstalling
throws.

The runtime's event classes, `Event`, `EventTarget`, `CustomEvent`,
`ErrorEvent` and `MessageEvent`, stay its own: on Bun and Deno the
runtime's own event targets accept only its own events, and the
document accepts them too, so they serve both. So do `localStorage` and
`sessionStorage` where the runtime has them: Deno's, and Node's given
`--localstorage-file`, keep what is stored between runs, where the
window's keep it in memory. On Bun, and on Node without
`--localstorage-file`, which have none, the window's are installed.
What a terminal does not have, such as `indexedDB` or `caches`, is not
on the window and is not installed, so feature detection, with `in` or
by reading it, takes its fallback.

While installed, a promise rejected with no handler is the page's: it
fires `unhandledrejection` on the window, and one no listener cancels is
reported as an uncaught exception is, where the runtime would end the
process. Uninstalling leaves any name that other code has redefined
since.

## `TerminalTransport`

The interface between the engine and a terminal, for embedding TermDOM
somewhere other than a process — an SSH server, a browser terminal, a
test harness. A transport serves one TermDOM: the first to attach takes
its streams for good, and another that attaches to it, even after the
first is disposed, rejects with an `InvalidStateError`. To show another
document on the same terminal, keep the TermDOM and replace its
document's contents, or, on the process, attach a new TermDOM with a new
`transportFromProcess()`. An SSH session opens its shell once, so it has
one transport, and one TermDOM.

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
  `ProcessLike` type: `stdin`, `stdout`, `stderr`, `on`, `removeListener`
  and `exit`). Defaults to the global `process`.
- `options.sharesScreen` — overrides `sharesScreen`, which defaults to
  true for the global process (it sits below a shell) and false for
  anything else.

The wrapper owns all process-level behavior: raw mode, `SIGWINCH` →
`resizes`, signals → `closed`, `stdout.isTTY` → `interactive`,
asking the terminal nothing when stdin is not a terminal, since its
answers could not be read, `stderr` when it is not a terminal →
`logError`, `suspend()` by leaving raw mode and sending the process
`SIGTSTP` until `SIGCONT` (not on Windows), and an exit hook that
restores the cursor if the app exits without disposing, written before
an exception nothing handles is printed.

## `transportFromSSH(session, options?)`

Returns a `TerminalTransport` over an SSH session from
[ssh2](https://github.com/mscdex/ssh2), for a program that is its own
SSH server and gives each session a document of its own.

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

- `session` — what accepting ssh2's `"session"` event returns, or
  anything of its shape (the exported `SSHSessionLike` type). TermDOM
  does not depend on ssh2.
- `options.sharesScreen` — defaults to true: the client's shell is above
  the `ssh` command, so the document anchors below it.

The transport accepts the session's pty request and takes its size, or
80×24 without one. It accepts the shell request, and `ready` resolves
when that opens the channel that carries input and frames. Each window
change is a resize. Other requests, such as `exec`, are left to ssh2,
which refuses them. The session closes when the channel closes or the
client's input ends, as with `ssh host < /dev/null`, and the channel
ends once the terminal's modes are restored. `window.close()` sends the
exit status and ends the channel.

To serve an app to real users, an OpenSSH `Match` block with
`ForceCommand node /path/to/app.ts` runs it on a real pty instead, with
`transportFromProcess`.
[`examples/ssh.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/ssh.ts)
is a whole server.

A server that holds many sessions in one process gives each its own
`TermDOM`, and an exception a session's listeners, timers or frames let
escape is reported to that session's window and log. Two things stay
the server's, because the process has only one of each:

- Globals. `installGlobals()` puts one window on `globalThis`, so a
  server passes each session's `document` to its framework instead, as
  React's `createRoot(term.document.body)` takes it.
- Promise rejections no one handles. The runtime decides what one does,
  and Node ends the process, with every session in it. A server that
  should outlive one session's mistake listens for them itself, with
  `process.on("unhandledRejection", ...)`.

## Other exports

`TermDOM`, `installGlobals`, `transportFromProcess` and
`transportFromSSH` are the entry points above. The package also exports:

- `FetchEvent`, `ExtendableEvent` and the `FetchEventInit` type, for the
  `"fetch"` event.
- The types `TermDOMOptions`, `TermDOMEventMap`, `CellSize`, `ColorDepth`,
  `TerminalTransport`, `TerminalCloseInfo`, `TerminalSize`, `ProcessLike`
  and `SSHSessionLike`, and `CanvasCellGridContext`, the experimental
  `"termdom-cellgrid"` context, which may change in a minor release.

`TerminalTransport` and the shapes `transportFromProcess` and
`transportFromSSH` take are written against by custom transports and
mocks, so a member added to them will always be optional.
