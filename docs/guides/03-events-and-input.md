---
title: Events and Input
description: Keyboard, mouse, focus, form controls, and selection.
---

Input arrives as DOM events, through `addEventListener`. An event the engine
fires -- decoded input, a resize, a focus move -- reads `isTrusted` true; an
event an application constructs and dispatches itself reads false, so a
listener can tell the two apart.

## Keyboard

```ts
document.addEventListener("keydown", (ev) => {
	if (ev.key === "j") select(selected + 1);
	if (ev.key === "Enter") open(rows()[selected]);
});
```

Escape sequences from the terminal are decoded into `KeyboardEvent`s with
`key`, `ctrlKey`, `altKey`, and `shiftKey` set.

### What a terminal can report

A terminal delivers bytes, not key states, and several distinct keystrokes
arrive as the same byte. These limits come from the terminal, not from
TermDOM, and they apply to every terminal application.

- **`Shift+Enter` cannot be reported.** It sends the same byte as `Enter`.
  Where an application already binds `Enter`, bind `Ctrl+J` for the second
  action: that is a distinct byte, and it is what the chat example uses for a
  soft newline.
- **`Enter` is `Ctrl+M`, and `Tab` is `Ctrl+I`.** One byte each, so the named
  key is what you get. `Ctrl+M` and `Ctrl+I` never arrive as chords.
- **`Ctrl+C` never reaches the document.** It is the interrupt, handled before
  decoding.
- **`Ctrl` with a letter arrives as one byte**, so `Ctrl+Shift+A` is
  indistinguishable from `Ctrl+A`, and `ctrlKey` is never combined with
  `shiftKey` for letters.
- **There is no `keyup` for a held key, and no auto-repeat state.** A key
  press produces one `keydown`, one `keypress` where the key is printable, and
  one `keyup`. `event.repeat` is always false.
- **Modifier keys alone are invisible.** Pressing `Shift` on its own sends
  nothing, so there is no event for it.
- **The function and arrow keys carry modifiers only where the terminal
  encodes them**, which most do for `Ctrl` and `Alt` but not uniformly.

### Editing chords in text fields

Because a terminal user's hands expect them, `<input>` and `<textarea>` bind
the readline motions and cuts as their default action, and an author's
`preventDefault` on `keydown` suppresses them like any other:

| Chord | Effect |
| --- | --- |
| `Ctrl+A` / `Ctrl+E` | Start / end of the line |
| `Ctrl+B` / `Ctrl+F` | Back / forward one character |
| `Ctrl+K` / `Ctrl+U` | Cut to the end / start of the line |
| `Ctrl+W` | Cut the word before the caret |
| `Ctrl+D` | Delete forward |
| `Ctrl+J` | Insert a newline, in a `<textarea>` |

`Ctrl+A` is a caret motion here rather than the browser's select-all, which
has no terminal equivalent to inherit.

## Mouse

Mouse events dispatch at the element under the cell: `mousedown` moves
focus, `click` clicks, `wheel` scrolls. Coordinates are in cells.

```ts
row.addEventListener("click", () => open(row.dataset.path!));
```

A terminal reports a mouse position only while a button is held, or when
motion reporting is on, so `:hover` is not implemented. Mouse reporting also
belongs to the application while it runs: a terminal's own text selection is
usually available by holding `Shift`, which the terminal handles itself and
TermDOM never sees.

## Focus

Tab traverses focusable elements in document order, `:focus` styles apply,
and `element.focus()` works. Typing goes to the focused element.

## Form controls

`<input>` (text, checkbox, radio), `<textarea>`, `<select>` and `<button>` are
all implemented, and they fire `input` and `change` events:

```html
<div class="field">
	<div class="label">Name</div><input id="name">
</div>
```

```ts
field.addEventListener("input", updatePreview);
```

The controls are UA shadow trees, so `::placeholder` and `::part()` styling
apply. The caret is the real terminal cursor, and IME composition works:
CJK input methods compose in the field. `<input type="password">` masks its
value.

## Selection and the clipboard

Drag to select, in the document or inside a field. Selection is styled
through `::selection`. `getSelection().modify(alter, direction,
granularity)` moves the caret or drags the focus by character, word, line
or line boundary -- the line granularities read the laid-out lines, so a
soft wrap counts as a line.

Copying is explicit: `navigator.clipboard.writeText(text)` carries the text
to the system clipboard over OSC 52, which travels in-band and works across
SSH, and `readText()` asks the terminal for the clipboard the same way.
Both are reachable only from inside the dispatch of a trusted event the user
caused -- a keystroke, a mouse press or release, a click, a paste -- and
reject with a `NotAllowedError` otherwise; `navigator.userActivation` reports
the same state. This is stricter than a browser, whose activation window is a
span of time and survives an `await`: here a handler that awaits before
reaching for the clipboard is already too late. Most terminals refuse clipboard reads, and `readText()` rejects
when one does not answer. The terminal's own select-to-copy remains
available as Shift+drag, which bypasses mouse reporting.

`navigator.clipboard` is a `Clipboard`, and `write()` and `read()` work over
`ClipboardItem` under the same gate. OSC 52 carries one payload a terminal
treats as text, so `text/plain` is the type it sends and answers with, and
`ClipboardItem.supports()` says so. `navigator.permissions.query({name:
"clipboard-read"})` and `"clipboard-write"` report `granted` while a gesture
is being dispatched and `prompt` outside one.

A paste from the terminal arrives as a cancelable `paste` event at the
focused element, or at `document.body` when nothing is focused, with the text
on `event.clipboardData`. A paste nobody cancels goes on to insert into a
focused text field:

```ts
document.addEventListener("paste", (event) => {
	console.log(event.clipboardData.getData("text/plain"));
	event.preventDefault();
});
```

`ClipboardEvent` and `DataTransfer` are here, and `copy` and `cut` listeners
attach and receive what an application dispatches, but nothing fires them for
the user: the terminal keeps the copy gesture -- Cmd+C, Shift+drag -- and
never reports it, and Ctrl+C is the interrupt.

## Scrolling and the camera

Output starts at the command line and flows down. When the document
outgrows the terminal, earlier rows scroll into the terminal's scrollback.

A camera scrolls over the document:

```ts
window.scrollTo(0, 0);
element.scrollIntoView();
```

`window.scrollY` and `pageYOffset` report where the camera is.

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` takes the alternate screen and applies `:fullscreen`
styles. Exiting restores the main screen and scrollback.

## Resizing

A terminal resize fires `resize` at the window:

```ts
window.addEventListener("resize", () => {
	draw(window.innerWidth, window.innerHeight);
});
```

The event carries no dimensions; read them off the window, the document, or
any element — the new size is in place before listeners run. `window.onresize`
takes a handler too.

The same resize re-evaluates `@media` rules and fires `change` on live
`MediaQueryList` objects:

```ts
const wide = window.matchMedia("(min-width: 80ch)");
wide.addEventListener("change", relayout);
```

`resize` runs before those `change` events, as in a browser; a `MediaQueryList`
read from a `resize` listener already answers with the new size.

A burst of resizes — dragging a terminal's edge — is coalesced into one
redraw, and fires one `resize`, at the size the drag settled on. A resize
notification that reports the same size fires nothing.
