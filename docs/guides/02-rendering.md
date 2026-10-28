---
title: Rendering
description: Flow mode, fullscreen, static output, and what TermDOM asks the terminal.
---

TermDOM draws a document in one of three ways, depending on how the
terminal is used.

## Flow mode

After `attach()`, TermDOM draws the document below the shell prompt,
where a command's output goes. This is the default.

```ts
const term = new TermDOM();
term.attach();
term.document.body.textContent = "Hello";
```

TermDOM asks the terminal for the cursor's row and draws from there.
The region is as tall as the document, up to the terminal's height. As
it grows, the rows above scroll into the scrollback. TermDOM never
draws above the region, so the prompt and earlier output stay intact.

A document taller than the terminal scrolls. The program scrolls it
with `window.scrollTo()` and `scrollBy()`, the user with the wheel.
`window.scrollY` reports the position.

When the document fits, the rows above it hold earlier shell output,
and turning the wheel up over them scrolls the terminal's scrollback.
Over the document, the wheel always scrolls the document. Terminals
don't report scrolling back down, so the document takes the mouse back
on the next key, paste, or return of focus. Until then,
`document.visibilityState` is `"hidden"` and the document is blurred.

When the program ends, by `window.close()`, `dispose()`, or Ctrl-C,
TermDOM erases the region and prints the document once more as plain
output, which stays in the scrollback with the prompt below it.

### Resizing

On a resize, TermDOM asks for the cursor position again, lays out at
the new width, and redraws. If the terminal doesn't answer in time, it
estimates. `resize` fires on the window once the new size is in place.

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` switches to the terminal's alternate screen,
where the element fills the terminal. `:fullscreen` matches it, and
`fullscreenchange` fires on the document.

`document.exitFullscreen()` switches back. The shell, the scrollback,
and the flow-mode region come back as they were.

Escape doesn't leave fullscreen. It reaches `keydown` like any key, so
call `exitFullscreen()` yourself if you want that.

To take the whole terminal for the life of the program, call
`document.documentElement.requestFullscreen()` right after `attach()`.
On exit, the alternate screen is discarded and nothing is left in the
scrollback, as when you quit vim. If the program drew in flow mode
first, the cursor ends one line below that output.

The document doesn't scroll in fullscreen. Boxes inside it with
`overflow: auto` do.

## Static output

`renderANSI()` turns HTML into a string, and `print()` writes it as
ordinary output:

```ts
const term = new TermDOM();
await term.print(`<div style="color: red">error: file not found</div>`);
```

The string holds only colors and line breaks, so it can go to a file,
a log, or stderr. Nothing keeps the process alive.

These use 256 colors until `attach()` has asked the terminal, and
always when output is a pipe or file. For 24-bit color, set it:

```ts
const term = new TermDOM({colorDepth: 24});
await term.print(`<div style="color: #ff8800">orange</div>`);
```

When stdout isn't a terminal, `attach()` acts like `print()`: it writes
the document once, as plain lines, when the program ends, and reads no
input. The same program works in a pipe or a CI log.

## Frames

TermDOM draws after the task that changed the document, once its
microtasks have run, so a change and whatever a microtask does in
response land in the same frame. It draws at most once every 16 ms.
Each frame it:

- recomputes style and layout for what changed,
- paints into a buffer of cells,
- compares the buffer with the last frame, and
- writes the difference.

Each frame is wrapped in synchronized output markers, so terminals that
support them show it all at once.

The terminal cursor is hidden except at the caret of a focused text
field or editing host, where an input method can compose text. Other
focused elements show an outline.

CSS on the caret styles the cursor:

| Property | Effect |
| --- | --- |
| `caret-shape` | `block`, `underscore`, or `bar`. `auto` keeps the terminal's |
| `caret-animation` | With a shape set, `manual` holds the cursor steady and `auto` lets it blink |
| `caret-color` | The cursor's color. `auto` and system colors keep the terminal's |

An editor can switch between a block and a bar by toggling a class.
TermDOM restores the terminal's own cursor when the session ends or is
suspended. Terminals that can't style the cursor ignore this.

When the document or a box scrolls, TermDOM has the terminal shift the
rows and repaints whatever the shift got wrong. Terminals only shift
full rows, so a box narrower than the terminal is repainted instead.

## What TermDOM asks the terminal

TermDOM doesn't read the terminal's name or environment. It asks the
terminal and falls back to a safe default if there's no answer.

| Query | Used for |
| --- | --- |
| Cursor position report | The flow-mode region's first row, before and after a resize |
| Mode 2027 | Measuring text by grapheme cluster, so TermDOM and the terminal agree on emoji widths |
| Mode 8 | Whether the terminal reorders bidirectional text itself |
| SGR 53 by DECRQSS | Whether the terminal draws an overline, which MathML roots use |
| XTWINOPS 16 | Cell size in pixels, for gradient angles and image and canvas sizes |
| OSC 52 query | `navigator.clipboard.readText()` |
| 24-bit SGR by DECRQSS, XTGETTCAP `RGB` and `Tc`, DA2 | Whether to send 24-bit color, unless `colorDepth` is set |

TermDOM sets these modes and resets them on exit:

- mouse reporting
- mouse motion reporting, while something watches hover
- focus reporting
- bracketed paste
- the alternate screen, in fullscreen
- the title stack, when the document has a title
- mode 2027, when the terminal accepts it

If the program exits without `dispose()`, an exit hook resets them, so
a crash doesn't leave the shell without a cursor or with the mouse
captured.

`document.title` sets the window title. The old title comes back on
exit.
