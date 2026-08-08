---
title: Events and Input
description: Keyboard, mouse, focus, form controls and selection — all through ordinary DOM events.
---

Interactivity in TermDOM is DOM interactivity. There is no separate input
layer to learn: you add listeners, and events arrive.

## Keyboard

```ts
document.addEventListener("keydown", (ev) => {
	if (ev.key === "j") select(selected + 1);
	if (ev.key === "Enter") open(rows()[selected]);
});
```

Escape sequences from the terminal are tokenized into `KeyboardEvent`s with
the `key`, `ctrlKey`, `altKey` and `shiftKey` you would expect. The tokenizer
keeps up with any keyboard repeat rate, so held keys do not fall behind.

## Mouse

Mouse events are dispatched at the element under the cell: `mousedown` moves
focus, `click` is a click, and `wheel` scrolls. Coordinates are in cells.

```ts
row.addEventListener("click", () => open(row.dataset.path!));
```

There is no `:hover` state. Mouse position is reported, but hover styling is
not wired up.

## Focus

Tab traverses focusable elements in document order, `:focus` styles apply, and
`element.focus()` works. Focus is what decides where typing goes, exactly as
in a browser.

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

The controls are built as UA shadow trees — the same mechanism a browser uses
— which is why `::placeholder` and part-based styling work on them, and why
your own styles reach inside them predictably.

The caret is the real terminal cursor. That is what makes IME composition work:
CJK input methods compose in the field, anchored where the caret is and
measured in cells. `<input type="password">` masks its value.

## Selection and the clipboard

Drag to select, in the document or inside a field. Selection is styled
through `::selection`. Copying is explicit:
`navigator.clipboard.writeText(text)` carries the text to the system
clipboard over OSC 52, which travels in-band and works across SSH. The
terminal's own select-to-copy remains available as Shift+drag, which
bypasses mouse reporting.

## Scrolling and the camera

A TermDOM app starts where the command started and flows down, like any other
command. When the document outgrows the room below it, earlier rows scroll
away into the terminal's own scrollback, where they stay searchable and
selectable.

A camera moves over the document:

```ts
window.scrollTo(0, 0);
element.scrollIntoView();
```

`window.scrollY` and `pageYOffset` report where the camera is.

## Fullscreen

When an app wants the whole screen, it asks for it the way a web page does:

```ts
await element.requestFullscreen();
```

That takes the alternate screen and applies `:fullscreen` styles. Exiting
gives the terminal back untouched, with your scrollback intact.

## Resizing

A terminal resize re-evaluates `@media` rules and fires `change` on live
`MediaQueryList` objects, so a responsive layout is just CSS:

```ts
const wide = window.matchMedia("(min-width: 80ch)");
wide.addEventListener("change", relayout);
```
