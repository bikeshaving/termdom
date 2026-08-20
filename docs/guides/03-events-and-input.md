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

A terminal sends bytes, not key states, and some keystrokes send the same
byte. These limits apply to every terminal application:

- `Shift+Enter` sends the same byte as `Enter`. Bind `Ctrl+J` for the
  second action instead.
- `Enter` is the byte for `Ctrl+M` and `Tab` for `Ctrl+I`; the named key
  is what you get, and those chords never arrive.
- `Ctrl+C` is the interrupt; it never reaches the document.
- `Ctrl+Shift+letter` is indistinguishable from `Ctrl+letter`.
- A key press is one `keydown`, one `keypress` if printable, one `keyup`.
  There is no held-key state and `event.repeat` is always false.
- A modifier pressed on its own sends nothing.
- Arrow and function keys carry modifiers only where the terminal encodes
  them, which most do for `Ctrl` and `Alt`.

### Editing chords in text fields

`<input>` and `<textarea>` bind the readline chords as default actions;
`preventDefault` on `keydown` suppresses them like any other.

| Chord | Effect |
| --- | --- |
| `Ctrl+A` / `Ctrl+E` | Start / end of the line |
| `Ctrl+B` / `Ctrl+F` | Back / forward one character |
| `Ctrl+K` / `Ctrl+U` | Cut to the end / start of the line |
| `Ctrl+W` | Cut the word before the caret |
| `Ctrl+D` | Delete forward |
| `Ctrl+J` | Insert a newline, in a `<textarea>` |

`Ctrl+A` moves the caret rather than selecting all, as in a shell.

## Mouse

Mouse events dispatch at the element under the cell: `mousedown` moves
focus, `click` clicks, `wheel` scrolls. Coordinates are in cells.

```ts
row.addEventListener("click", () => open(row.dataset.path!));
```

A terminal reports the mouse position only while a button is down, so
`:hover` is not implemented. While an app has the mouse, the terminal's
own select-to-copy is still available by holding `Shift`.

## Focus

Tab traverses focusable elements in document order, `:focus` styles
apply, and `element.focus()` works. Typing goes to the focused element.

## Form controls

`<input>` (text, number, checkbox, radio), `<textarea>`, `<select>`, and
`<button>` are implemented and fire `input` and `change`:

```html
<div class="field">
	<div class="label">Name</div><input id="name">
</div>
```

```ts
field.addEventListener("input", updatePreview);
```

The controls are UA shadow trees, so `::placeholder` and `::part()`
styling apply. The caret is the real terminal cursor, and IME composition
works: CJK input methods compose in the field. `<input type="password">`
masks its value.

## Selection and the clipboard

Drag to select, in the document or inside a field; style it with
`::selection`. `navigator.clipboard.writeText(text)` copies to the system
clipboard over OSC 52, which travels in-band and works across SSH.

## Scrolling

Output starts at the command line and flows down; when the document
outgrows the terminal, earlier rows move into the terminal's scrollback.
The document scrolls with the standard calls:

```ts
window.scrollTo(0, 0);
element.scrollIntoView();
```

`window.scrollY` reports the position.

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` takes the alternate screen and applies `:fullscreen`
styles. Exiting restores the main screen and scrollback. Escape exits;
if a text field is focused, the first Escape blurs it instead.

## Resizing

A terminal resize fires `resize` at the window:

```ts
window.addEventListener("resize", () => {
	draw(window.innerWidth, window.innerHeight);
});
```

The event carries no dimensions; read them off the window or any element —
the new size is in place before listeners run.

The same resize re-evaluates `@media` rules and fires `change` on live
`MediaQueryList` objects, after `resize`, as in a browser:

```ts
const wide = window.matchMedia("(min-width: 80ch)");
wide.addEventListener("change", relayout);
```
