---
title: Events and Input
description: Keyboard, mouse, focus, form controls, and selection.
---

Input arrives as DOM events. Events TermDOM fires have `isTrusted` set
to true; events the program dispatches have it set to false.

## Keyboard

```ts
document.addEventListener("keydown", (ev) => {
	if (ev.key === "j") select(selected + 1);
	if (ev.key === "Enter") open(rows()[selected]);
});
```

TermDOM decodes the terminal's escape sequences into `KeyboardEvent`s
with `key`, `ctrlKey`, `altKey`, and `shiftKey`. For a printable key,
`key` is the character. Otherwise it's the standard key name:

| Terminal sends | `key` |
| --- | --- |
| Carriage return | `Enter` |
| Tab, Shift+Tab | `Tab`, with `shiftKey` for Shift+Tab |
| Delete byte | `Backspace` |
| A lone escape | `Escape` |
| Cursor keys, either encoding | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` |
| Home and End, any encoding | `Home`, `End` |
| The tilde keys | `Insert`, `Delete`, `PageUp`, `PageDown` |
| Function keys | `F1` to `F12` |
| A control byte | The lowercase letter with `ctrlKey`; NUL is `Ctrl+Space` |
| A key with a modifier parameter | The key, with `shiftKey`, `altKey`, `ctrlKey`, and `metaKey` from the parameter |

For a printable key, `keypress` follows `keydown`. `keyup` fires
immediately after, since terminals don't report key releases.

### What a terminal can't report

A terminal sends bytes, not key states, and some keys send the same
bytes. These limits apply to every terminal program:

- `Shift+Enter` sends the same byte as `Enter`. Use `Ctrl+J` instead.
- `Enter` is `Ctrl+M` and `Tab` is `Ctrl+I`. You get the named key.
- `Ctrl+Shift+letter` is the same as `Ctrl+letter`.
- `Alt+key` arrives as one key with `altKey` set.
- A modifier on its own sends nothing.
- Arrow and function keys carry modifiers only if the terminal encodes
  them. Most do for `Ctrl` and `Alt`.
- There's no held-key state, and `event.repeat` is always false.

Terminals set up for extended key reports (CSI u or xterm's
`modifyOtherKeys`) remove most of these limits. TermDOM decodes those
reports but doesn't turn them on, so most terminals won't send them.

Three keys act before the page sees them:

- `Ctrl+C` calls `window.close()` and never reaches the document. A
  `beforeunload` listener that calls `preventDefault()` keeps the
  session open.
- `Ctrl+Z` suspends the program, as in a shell, unless a `keydown`
  listener calls `preventDefault()`. While suspended,
  `document.visibilityState` is `"hidden"`. After `fg`, a flow-mode
  document starts again below the shell's output. Over SSH and on
  Windows, `Ctrl+Z` is an ordinary key.
- `Ctrl+L` redraws the screen unless a `keydown` listener calls
  `preventDefault()`.

### Editing keys in text fields

`<input>` and `<textarea>` bind the readline keys. `preventDefault()`
on `keydown` cancels them.

| Keys | Effect |
| --- | --- |
| `Ctrl+A` / `Ctrl+E` | Start / end of the line |
| `Ctrl+B` / `Ctrl+F` | Back / forward one character |
| `Ctrl+K` / `Ctrl+U` | Cut to the end / start of the line |
| `Ctrl+W` | Cut the word before the caret |
| `Ctrl+D` | Delete forward |
| `Ctrl+J` | Newline, in a `<textarea>` |

`Ctrl+A` goes to the start of the line, not select all.

## Mouse

Mouse events go to the element under the cell, with coordinates in
cells. `mousedown` moves focus, and `wheel` scrolls.

| Terminal reports | Event |
| --- | --- |
| Left, middle, or right press | `mousedown` with `button` 0, 1, or 2 |
| Release | `mouseup`, then `click` if on the same element |
| Two quick presses | `detail` counts them; `dblclick` fires on the second |
| Wheel up or down | `wheel` with `deltaY` −3 or 3, in lines |
| Wheel left or right, or Shift+wheel | `wheel` with `deltaX` −3 or 3 |
| Shift, Alt, or Ctrl held | `shiftKey`, `altKey`, `ctrlKey` |
| Motion | `mousemove` and the hover events |

Each wheel notch scrolls three lines. There's no context menu; the
right button is an ordinary press.

```ts
row.addEventListener("click", () => open(row.dataset.path!));
```

`:hover`, `mouseover`, `mouseout`, `mouseenter`, `mouseleave`, and
`mousemove` work. TermDOM asks the terminal for motion reports only
while a `:hover` rule or one of those listeners exists. Users can hold
`Shift` to use the terminal's own text selection.

## Focus

Tab moves through focusable elements in document order, and
`element.focus()` works. Typing goes to the focused element. Enter and
Space click a focused button or summary, and Enter follows a focused
link.

Escape closes the topmost modal dialog or open popover, even if a
`keydown` listener cancels it.

Tab past the last focusable element leaves nothing focused. The next
Tab focuses the first.

When the terminal loses focus, because you switched to another window
or tmux pane, the focused element gets `blur` and `focusout`, then the
window gets `blur`. The element stays `document.activeElement`. When
focus returns, the window gets `focus`, then the element gets `focus`
and `focusin`.

While the terminal is away, `document.hasFocus()` is false, `:focus`
matches nothing, and no cursor shows. The page is also blurred while
the wheel is scrolling the terminal's scrollback.

A terminal that doesn't report focus never fires these. In tmux, turn
on `focus-events`.

## Dialogs, popovers, and details

`<dialog>` opens with `show()` or `showModal()`. A modal dialog is
centered in the top layer over a `Canvas` backdrop. Escape closes it,
firing `cancel`, then `close`.

A `[popover]` opens with `showPopover()`, `togglePopover()`, or a
`popovertarget` button. A click outside or Escape closes it and fires
`toggle`.

`<details>` toggles when its `<summary>` is clicked, or focused and
Enter or Space is pressed, and fires `toggle`.

## Form controls

`<input>` (text, number, checkbox, radio, range), `<textarea>`,
`<select>`, and `<button>` fire `input` and `change`:

```ts
field.addEventListener("input", updatePreview);
```

The caret is the terminal cursor, so input methods compose text in
place. `<input type="password">` masks its value. A `<textarea>`
scrolls to keep its caret in view.

- A number input accepts only numbers. Up and Down step it within
  `min` and `max`.
- In a radio group, the arrow keys move the check, wrapping at the
  ends.
- A range input moves one step with the arrow keys, a tenth of the
  range with PageUp and PageDown, and to the ends with Home and End.
  Clicking the track jumps there, and dragging moves the thumb. Drags
  fire `input` while moving and `change` on release.

`new FormData(form)` collects each control's name and value in
document order. `requestSubmit()` fires `submit`, and stops if it's
canceled; `submit()` skips it. Both then fire `formdata`, where a
listener can change `event.formData`:

```ts
form.addEventListener("formdata", (event) => {
	event.formData.append("token", token);
});
form.requestSubmit();
```

Nothing is sent over the network. Submission ends there.

## Editing

An element with `contenteditable` is an editing host: the caret is the
terminal cursor, and typing edits the tree. `document.designMode =
"on"` makes the whole body editable. The caret skips over
`contenteditable="false"` elements as a unit.

```html
<div id="note" contenteditable>Type here.</div>
```

- Left and Right move by character; with Alt or Ctrl, by word.
- Up and Down move by line.
- Home and End move to the ends of the line.
- Shift with any of these extends the selection.

Backspace and Delete remove a grapheme cluster, or the selection.
Ctrl+W, Ctrl+U, and Ctrl+K delete the word before, the line before, and
the line after the caret. Enter splits the block. Shift+Enter inserts a
`<br>`, where the terminal reports it. An emptied block keeps a `<br>`
so it stays one line tall.

Every edit fires a cancelable `beforeinput`, then `input`, from the
element holding the caret. The input types are:

- `insertText`
- `insertFromPaste`
- `insertParagraph`
- `insertLineBreak`
- `deleteContentBackward`
- `deleteContentForward`
- `deleteWordBackward`
- `deleteSoftLineBackward`
- `deleteSoftLineForward`

Canceling `beforeinput` stops the edit:

```ts
note.addEventListener("beforeinput", (event) => {
	if (event.inputType === "insertParagraph") {
		event.preventDefault();
	}
});
```

Not yet supported: undo and redo, `execCommand`, formatting commands,
HTML paste, IME composition in an editing host, and spellcheck.

## Errors

TermDOM reports uncaught exceptions from:

- event listeners and handler attributes
- observer and animation frame callbacks
- `window.setTimeout()`, `setInterval()`, and `queueMicrotask()`

The global `setTimeout()` is the runtime's unless `installGlobals()`
replaced it, and an exception there ends the program. With the globals
installed, an unhandled rejection fires `unhandledrejection` on the
window and is reported the same way.

Each error first fires a cancelable `error` event on the window:

```ts
window.addEventListener("error", (event) => {
	status.textContent = event.message;
	event.preventDefault();
});
```

Calling `preventDefault()` marks it handled. An unhandled error doesn't
stop the program and isn't printed over the screen. It goes to the
transport's log if there is one; the process transport writes to stderr
when stderr isn't the terminal, so `node app.ts 2> errors.log` gives
you a log to tail. Otherwise the error is printed below the document
when the session ends.

To stop at the first error during development, pass `failFast`:

```ts
const term = new TermDOM({
	failFast: process.env.NODE_ENV !== "production",
});
```

The `error` event still fires first and can still handle it. An
unhandled error then restores the terminal, prints the error, and
closes the transport with status 1. Over SSH, only that session ends.

Methods throw the standard errors: `showModal()` on an open dialog
throws `InvalidStateError`, and a bad selector throws `SyntaxError`. A
failure in TermDOM's own rendering ends the session, restores the
terminal, and rethrows.

## Selection and the clipboard

Drag to select text in the document or a field, styled with
`::selection`. A double click selects a word, a triple click the
paragraph (a line in a `<textarea>`, the whole value in an `<input>`),
and dragging after either extends by that unit. Clicks count as double
or triple only on the same cell within half a second. This is the
default action of `mousedown`, so a listener can cancel it and select
on its own, as CodeMirror does.

`getSelection().toString()` returns the rendered text, with line breaks
between blocks. It leaves out closed `<details>` content, `<select>`
options, hidden elements, and `user-select: none` content.
`user-select: none` also keeps drags from starting in or extending into
an element, which suits game boards and toolbars.

`getSelection().modify(alter, direction, granularity)` moves or extends
by character, word, line, or line boundary, where lines are wrapped
lines.

`navigator.clipboard.writeText(text)` copies over OSC 52, which works
over SSH. `readText()` sends an OSC 52 query, which most terminals
refuse, and then it rejects. Both work only during a user-initiated
event such as a key, click, or paste, and only until the first `await`.
Otherwise they reject with `NotAllowedError`.

A paste fires a cancelable `paste` event at the focused element, or
`document.body`, with the text on `event.clipboardData`. If not
canceled, the text goes into the focused field:

```ts
document.addEventListener("paste", (event) => {
	console.log(event.clipboardData!.getData("text/plain"));
	event.preventDefault();
});
```

`copy` and `cut` never fire from user input: the terminal handles
Cmd+C and Shift+drag itself, and Ctrl+C is the interrupt.

## Scrolling

The document and boxes with `overflow: auto` or `scroll` scroll with
the standard calls:

```ts
window.scrollTo(0, 0);
pane.scrollTop += 5;
element.scrollIntoView();
```

Uncanceled `keydown`s scroll:

- Up and Down by a row.
- PageUp, PageDown, and Space by a page, less one row.
- Home and End to the top or bottom.

The key scrolls the nearest box around the focused element that can
scroll that way, or the document. Keys a field, `<select>`, or editable
content uses don't scroll, nor does Space on a button. Call
`preventDefault()` to use these keys yourself.

`scroll` fires on the box or document, then `scrollend` once it stops.
`window.scrollY` is the document's position, and setting it past the
end clamps immediately.

`scrollIntoView()` aligns to the top. `{block: "nearest"}` scrolls only
as far as needed, which suits moving a selection through a list.

The wheel scrolls the innermost scrollable box under the pointer and
passes what's left to the boxes around it. `preventDefault()` on
`wheel` stops it. A sideways notch scrolls the innermost box that
scrolls sideways; the document never does. The
[rendering guide](/guides/rendering/#flow-mode) explains how the
document and the terminal's scrollback share the wheel.

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` switches to the alternate screen, and
`document.exitFullscreen()` switches back. Escape doesn't exit; it
reaches `keydown`. See the
[rendering guide](/guides/rendering/#fullscreen).

## Resizing

A terminal resize fires `resize` on the window:

```ts
window.addEventListener("resize", () => {
	draw(window.innerWidth, window.innerHeight);
});
```

Sizes are already updated when listeners run. After `resize`, `@media`
rules are re-evaluated and live `MediaQueryList`s fire `change`:

```ts
const wide = window.matchMedia("(min-width: 80ch)");
wide.addEventListener("change", relayout);
```
