---
title: Rendering
description: Flow mode, fullscreen, static output, and what the engine asks the terminal.
---

TermDOM paints the document in one of three ways. No option picks the
way. It depends on how the terminal is being used.

## Flow mode

When you call `attach()` on a terminal, TermDOM renders in flow mode.
The document is drawn where a command's output would go, on the row
below the shell prompt. It stays there while the program runs. Flow
mode is the default, and the examples use it unless they ask for
fullscreen.

```ts
const term = new TermDOM();
term.attach();
term.document.body.textContent = "Hello";
```

The engine asks the terminal where the cursor is, and uses that row as
the top of the region it paints in. The region is as tall as the
document, up to the height of the terminal. When the document grows,
the region grows with it. The rows above the region scroll up into the
terminal's scrollback, in the same way that any command's output pushes
earlier output up. The engine never paints over anything above the
region. The prompt that started the program and the output before it
stay where they are.

When the document is taller than the terminal, the region shows one
window's worth of it. The program can scroll this window with
`window.scrollTo()` and `scrollBy()`, and the user can scroll it with
the mouse wheel. `window.scrollY` reports the current position. The
window cannot scroll above the document's first row.

When the document fits in the terminal, the rows above it hold the
shell's earlier output. Turning the wheel up over those rows scrolls
the terminal's own scrollback instead. Over the document, the wheel
always belongs to the document, even where nothing there can scroll.
No terminal reports when the user has scrolled back down, so the
document takes the mouse back on the next key, paste, or return of
focus. Until then, `document.visibilityState` is `"hidden"` and the
document is blurred.

Each frame repaints the region in place. The program can end with
`window.close()`, with `dispose()`, or by the user pressing Ctrl-C. In
each case the engine erases the region and prints the whole document
once more as plain output. The final state then sits in the scrollback
like the output of any other command, and the shell prompt returns
below it.

### Resizing

When the terminal is resized, the engine asks for the cursor position
again to find where its region ended up. It then lays out the document
again at the new width and repaints. If the terminal does not answer in
time, the engine computes a guess. The `resize` event fires on the
window after the new size is in place.

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` switches the terminal to its alternate screen. The
engine paints the fullscreen element from row zero, and the element
fills the terminal. The `:fullscreen` pseudo-class matches the element,
and `fullscreenchange` fires on the document.

`document.exitFullscreen()` switches back to the main screen. The
terminal then restores the shell, the scrollback, and the flow-mode
region as they were.

In fullscreen, Escape is an ordinary key. It reaches `keydown`
listeners. If a program wants Escape to leave fullscreen, it must call
`exitFullscreen()` itself.

A program that wants the whole terminal for as long as it runs can call
`document.documentElement.requestFullscreen()` right after `attach()`.
When the program exits, the terminal discards the alternate screen.
Nothing is left in the scrollback, and the cursor goes back to where it
was before the program ran. This is the same thing that happens when you
quit vim or less. If the program painted in flow mode before it went
fullscreen, it exits with the cursor one line below that output, so the
shell's prompt does not land on top of it.

The document does not scroll in fullscreen, because the element fills
the screen. Boxes inside it with `overflow: auto` still scroll.

## Static output

Output that does not change needs neither mode. `renderANSI()` turns
HTML into a string of colored lines, and `print()` writes such a string
to the terminal as ordinary output:

```ts
const term = new TermDOM();
await term.print(`<div style="color: red">error: file not found</div>`);
```

The string contains only colors and line breaks. It has no cursor
movement and no mode changes, so you can pipe it to a file, log it, or
write it to stderr. There is no `attach()` call, and nothing keeps the
process alive.

`print()` and `renderANSI()` use `colorDepth: 8` until `attach()` has
asked the terminal what it supports. When output goes to a pipe or a
file, they always use `colorDepth: 8`, because there is no terminal to
ask. To print in 24-bit color, set the option yourself:

```ts
const term = new TermDOM({colorDepth: 24});
await term.print(`<div style="color: #ff8800">orange</div>`);
```

When stdout is not a terminal, `attach()` behaves like `print()`. The
engine writes the document once, as plain lines, when the program ends,
and it does not read input. This means a program can run under a pipe
or in a CI log without needing separate code for that case.

## Frames

The engine paints a frame after the task that changed the document,
once that task's microtasks have run. This matches the browser's
timing. A change and anything a microtask does in response to it land
in the same frame. For example, when a keystroke edits a line and an
editor updates that line in a microtask, both show up together.

The engine paints at most one frame every 16 ms. Changes that come
faster than that share one frame. For each frame, the engine:

- recomputes style and layout for what changed,
- paints the document into a buffer of cells,
- compares the buffer with the previous frame, and
- writes only the difference.

The engine wraps each frame in synchronized output markers, so a
terminal that supports them shows the whole frame at once.

The engine hides the terminal cursor between frames. When a text field
or an editing host has focus, the engine shows the cursor at its caret,
and an input method can compose text at that spot. Any other focused
element shows an outline instead.

The caret's CSS styles the terminal's cursor:

| Property | Effect |
| --- | --- |
| `caret-shape` | `block`, `underscore` or `bar` sets the cursor's shape. `auto` keeps the terminal's own |
| `caret-animation` | With a shape set, `manual` holds the cursor steady and `auto` lets it blink |
| `caret-color` | Sets the cursor's color. `auto` and system colors keep the terminal's own |

An editor can show a block cursor in one mode and a bar in another by
switching a class on the field. The engine writes the cursor's style
only when it changes, and puts back the terminal's own when the session
ends or is suspended, and only if a page set one. Terminals that do not
support styling the cursor ignore these.

When the document or a box scrolls, the engine asks the terminal to
shift the rows itself. The diff then repaints any cells the shift got
wrong. Terminals can only shift full rows, so when a scrolling box is
narrower than the terminal, the engine repaints it instead.

## What the engine asks the terminal

The engine never reads the terminal's name or its environment to decide
what the terminal can do. It asks the terminal directly, in-band, and
uses the answer. If the terminal does not answer, the engine uses the
safe default.

| Ask | Used for |
| --- | --- |
| Cursor position report | The starting row of the flow-mode region, and its row after a resize |
| Mode 2027 | Measuring text by grapheme cluster, so that a terminal that also does this agrees with the engine on the width of emoji sequences |
| Mode 8 | Whether the terminal reorders bidirectional text itself; if it does, the engine leaves the ordering to the terminal |
| SGR 53 by DECRQSS | Whether the terminal draws an overline, which MathML uses for the bar of a root |
| XTWINOPS 16 | The size of a cell in pixels, which sets the angle of a gradient and the natural size in cells of an image or a canvas |
| OSC 52 query | Reading the clipboard in `navigator.clipboard.readText()` |
| 24-bit SGR by DECRQSS, XTGETTCAP `RGB` and `Tc`, DA2 | Whether to send 24-bit color, unless the `colorDepth` option sets it |

The engine sets these modes and resets them on exit:

- mouse reporting
- mouse motion reporting, while something watches hover
- bracketed paste
- the alternate screen, in fullscreen
- the title stack, when the document has a title
- mode 2027, when the terminal agreed to it

If a program exits without calling `dispose()`, an exit hook resets
these modes. A crash then does not leave the shell with no cursor or
with the mouse still captured.

Setting `document.title` sets the terminal window title. The engine
puts the previous title back on exit.
