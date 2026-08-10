---
title: Events and Input
description: Keyboard, mouse, focus, form controls, and selection.
---

Input arrives as DOM events, through `addEventListener`.

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
through `::selection`. Copying is explicit:
`navigator.clipboard.writeText(text)` carries the text to the system
clipboard over OSC 52, which travels in-band and works across SSH. The
terminal's own select-to-copy remains available as Shift+drag, which
bypasses mouse reporting.

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

A terminal resize re-evaluates `@media` rules and fires `change` on live
`MediaQueryList` objects:

```ts
const wide = window.matchMedia("(min-width: 80ch)");
wide.addEventListener("change", relayout);
```
