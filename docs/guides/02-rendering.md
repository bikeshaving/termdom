---
title: Rendering
description: Flow mode, fullscreen, static output, and what the engine asks the terminal.
---

TermDOM paints the document one of three ways, and the way is picked by
how the terminal is being used rather than by an option.

## Flow mode

`attach()` on a terminal renders in flow mode. The document is drawn
where a command's output would go: on the row below the shell prompt,
and it stays there while the program runs. This is the default, and it is
what the examples do unless they ask for fullscreen.

```ts
const term = new TermDOM();
term.attach();
term.document.body.textContent = "Hello";
```

The engine finds its starting row by asking the terminal where the
cursor is, and paints the document in a region that begins there. The
region is as tall as the document, up to the height of the terminal.
When the document grows, the region grows with it, and the rows above
the region scroll up into the terminal's scrollback the way any
command's output pushes earlier output up. Nothing above the region is
ever painted over: the prompt that started the program and the output
before it stay where they are.

A document taller than the terminal shows a window of itself. The window
scrolls with `window.scrollTo()`, `scrollBy()`, and the mouse wheel, and
`window.scrollY` reports where it is. Its top is a stop: scrolling above
the first row does nothing, as in an editor. A document that fits has
nothing to scroll, so a wheel up in it goes to the terminal, and the
terminal's own scrollback scrolls. No terminal says when the user has
scrolled back down, so the mouse comes back to the document on the next
keystroke, which also reaches the page. While the wheel is the
terminal's, `document.visibilityState` is `"hidden"`.

Each frame repaints the region in place. When the program ends, whether
by `window.close()`, `dispose()`, or Ctrl-C, the engine erases the
region and prints the whole document once more as plain output, so the
final state sits in the scrollback like the output of any other command,
and the shell prompt returns below it.

`document.close()` does the same thing without ending the program: the
document is written into the scrollback and sealed. The next mutation
starts a fresh document below it, on a new starting row. A program that
prints a sequence of reports, one after another, can build each as a
document and close it.

### Resizing

When the terminal is resized, the engine asks for the cursor position
again to find where its region landed, re-lays out the document at the
new width, and repaints. A terminal that does not answer in time gets a
computed guess. The `resize` event fires on the window after the new
size is in place.

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` switches the terminal to its alternate screen and
paints the fullscreen element from row zero, filling the terminal. The
`:fullscreen` pseudo-class matches it, and `fullscreenchange` fires on
the document. `document.exitFullscreen()`, or Escape, switches back to
the main screen, which restores the shell, the scrollback, and the
flow-mode region as they were. If a text field has focus, the first
Escape blurs it instead.

A program that wants the whole terminal for its lifetime can call
`document.documentElement.requestFullscreen()` right after `attach()`.
When it exits, nothing of it is left in the scrollback, because the
alternate screen is discarded on the switch back, and the cursor is
where the command line left it, as vim leaves it. A program that
painted in flow first exits one line below that content instead, so the
shell's prompt does not land on it.

The document's scroll position has nothing to move in fullscreen: the
element fills the screen. Boxes inside it with `overflow: auto` still
scroll.

## Static output

Neither mode is needed for output that does not change. `renderANSI()`
turns HTML into a string of colored lines, and `print()` writes one to
the terminal as ordinary output:

```ts
const term = new TermDOM();
await term.print(`<div style="color: red">error: file not found</div>`);
```

The string has colors and line breaks only, no cursor movement and no
mode changes, so it can be piped to a file, logged, or written to
stderr. `attach()` is not called, and the process does not stay alive.

When stdout is not a terminal, `attach()` behaves like `print()`: the
document is written once as plain lines when the program ends, and
input is not read. A program can be run under a pipe or in a CI log
without a code path for it.

## Frames

A frame is painted when the document has changed and the next tick of
the event loop arrives. Mutations are observed, so nothing calls a
render. Style and layout are recomputed for what changed, the document
is painted into a buffer of cells, the buffer is diffed against the
previous frame, and only the difference is written. A frame is wrapped
in synchronized output markers so a terminal that supports them shows
it at once.

The terminal cursor is hidden between frames. When a text field or an
editing host has focus, the cursor is shown at its caret, so the
terminal's own cursor shape and blink apply and an input method can
compose there. Every other focused element shows an outline instead.

A scroll of a box, or of the document, that moves rows the terminal can
shift on its own is sent as a terminal scroll, and the diff repairs
what the shift got wrong. A scroll box narrower than the terminal
cannot use this, because terminals shift full rows, so its rows are
repainted.

## What the engine asks the terminal

The engine never reads the terminal's name or its environment to decide
what it can do. It asks the terminal, in-band, and uses the answer. A
terminal that does not answer gets the conservative behavior.

| Ask | Used for |
| --- | --- |
| Cursor position report | The starting row of the flow-mode region, and its row after a resize |
| Mode 2027 | Measuring text by grapheme cluster, so a terminal that does agrees with the engine on the width of emoji sequences |
| Mode 8 | Whether the terminal reorders bidirectional text itself, in which case the engine leaves the order to it |
| SGR 53 by DECRQSS | Whether the terminal draws an overline, which MathML uses for the bar of a root |
| OSC 52 query | Reading the clipboard in `navigator.clipboard.readText()` |

The one exception is color depth, which the process transport reads
from `COLORTERM` and `TERM` because no terminal answers a query for it.
A transport of your own can set `colorDepth` any way it likes.

The modes the engine sets, and resets on exit, are mouse reporting,
mouse motion reporting while something watches hover, bracketed paste,
the alternate screen in fullscreen, the title stack when the document
has a title, and mode 2027 when the terminal agreed to it. An exit
hook resets them if a program exits without disposing, so a crash does
not leave the shell without a cursor or with the mouse captured.

`document.title` sets the terminal window title, and the previous
title is put back on exit.
