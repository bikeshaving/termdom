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

## Mouse

Mouse events dispatch at the element under the cell: `mousedown` moves
focus, `click` clicks, `wheel` scrolls. Coordinates are in cells.

```ts
row.addEventListener("click", () => open(row.dataset.path!));
```

`:hover` is not implemented.

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
