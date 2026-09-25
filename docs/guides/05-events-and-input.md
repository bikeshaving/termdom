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
`key`, `ctrlKey`, `altKey`, and `shiftKey` set. `key` is the printed
character for a printable key, and one of the browser's names for the
rest:

| Terminal sends | `key` |
| --- | --- |
| Carriage return | `Enter` |
| Tab, and Shift+Tab | `Tab`, with `shiftKey` on the second |
| Delete byte | `Backspace` |
| A lone escape | `Escape` |
| Cursor keys, in either of the two encodings | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` |
| Home and End, in any of the three encodings | `Home`, `End` |
| The tilde keys | `Insert`, `Delete`, `PageUp`, `PageDown` |
| Function keys | `F1` through `F12` |
| A control byte | The letter, lowercase, with `ctrlKey`; NUL is `Ctrl+Space` |
| A cursor key with a modifier parameter | The key, with `shiftKey`, `altKey`, `ctrlKey`, and `metaKey` from the parameter's bits |

A character outside the Basic Multilingual Plane arrives as one
character. `keypress` fires after `keydown` for a printable key, and
`keyup` follows at once, since a terminal never says when a key is
released.

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

| Terminal reports | Event |
| --- | --- |
| Left, middle, or right button press | `mousedown` with `button` 0, 1, or 2 |
| The release | `mouseup`, then `click` when it lands on the same element |
| Two presses within the double-click interval | `detail` counts them, and `dblclick` fires on the second |
| Wheel up or down | `wheel` with `deltaY` of −3 or 3 and `deltaMode` of lines |
| Shift, Alt, or Ctrl held | `shiftKey`, `altKey`, `ctrlKey` |
| Motion | `mousemove`, and the hover events below |

The terminal reports a wheel notch, not a distance, so a notch is three
rows, the browser's line-mode convention. The engine turns on mouse
reporting when it attaches, and the right and middle buttons reach the
page as ordinary presses; there is no context menu.

A link's text is painted as a terminal hyperlink (OSC 8) when its `href`
resolves to an absolute `http`, `https`, `mailto`, `file` or `ftp` URL, so
a terminal that supports them opens it on its own modifier-click or hover,
whether or not the page has the mouse. The engine never follows a link
itself; a `click` listener is where an app acts on one.

```ts
row.addEventListener("click", () => open(row.dataset.path!));
```

`:hover` styles the element under the pointer, and `mouseover`,
`mouseout`, `mouseenter`, `mouseleave` and `mousemove` fire as in a
browser. A terminal reports mouse motion only when asked, so the engine
asks while a stylesheet has a `:hover` rule or the page has a listener
for one of those events, and stops when the last one goes. While an app
has the mouse, the terminal's own select-to-copy is still available by
holding `Shift`.

```ts
document.head.innerHTML = "<style>li:hover { background-color: blue }</style>";
```

## Focus

Tab traverses focusable elements in document order, `:focus` styles
apply, and `element.focus()` works. Typing goes to the focused element.
Enter and Space click a focused button or summary, and Enter follows a
focused link, as in a browser. Escape closes whatever is on top of the
top layer, a modal dialog or an open popover, whether or not a `keydown`
listener canceled it.
Tab past the last focusable element rests on nothing before re-entering
at the first — the page's view of a browser's cycle through its chrome.

## Dialogs, popovers, and details

`<dialog>` opens with `show()` or `showModal()`, and a modal one sits in
the top layer, centered, with a `Canvas` backdrop that covers the page.
Escape closes it and fires `cancel` then `close`. A `[popover]` opens
with `showPopover()` or `togglePopover()`, or a `popovertarget` button,
and light dismiss works: a click outside, or Escape, closes it and
fires `toggle`. `<details>` opens on a click of its `<summary>`, or
Enter or Space with the summary focused, and fires `toggle`.

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
masks its value. A number input takes float syntax only, and ArrowUp and
ArrowDown step it within `min` and `max`.

`new FormData(form)` builds the form's entry list: every submittable
control it owns, in tree order, by the rule its kind has. Submitting a
form builds the same list. `requestSubmit()` fires `submit` first and
stops there if a listener cancels it; `submit()` skips that event. Either
way the form then fires `formdata`, whose `event.formData` a listener can
add to or rewrite before the entries count as sent:

```ts
form.addEventListener("formdata", (event) => {
	event.formData.append("token", token);
});
form.requestSubmit();
```

Submission stops there. There is no page to navigate to, so the form
never sends anything over the network.

## Editing

An element with `contenteditable` is an editing host: click into it and
the caret becomes the real terminal cursor, and what you type goes into
the tree. `document.designMode = "on"` makes the whole body one. A
`contenteditable="false"` element inside a host is stepped over as one
piece and never takes the caret.

```html
<div id="note" contenteditable>Type here.</div>
```

The arrows move the caret by character, Alt or Ctrl with them by word,
Up and Down by line, and Home and End to the line's ends; Shift extends
the selection instead of moving it. Backspace and Delete take one
grapheme cluster, or the selection. The readline chords the text fields
use work here too: Ctrl+W takes back a word, Ctrl+U the line before the
caret, Ctrl+K the line after it. Enter splits the block the caret is in,
Shift+Enter puts a `<br>` in, and a block left empty keeps a `<br>` so
it stays a line tall — the same tree Chrome writes.

Every edit is a cancelable `beforeinput` first and an `input` after, both
bubbling from the element the caret is in, with the spec's input types:
`insertText`, `insertFromPaste`, `insertParagraph`, `insertLineBreak`,
`deleteContentBackward`, `deleteContentForward`, `deleteWordBackward`,
`deleteSoftLineBackward` and `deleteSoftLineForward`. Cancel the
`beforeinput` and nothing in the tree moves:

```ts
note.addEventListener("beforeinput", (event) => {
	if (event.inputType === "insertParagraph") {
		event.preventDefault();
	}
});
```

Undo and redo are not here yet, and neither are `execCommand`, the
formatting commands, HTML paste, IME composition in a host, or
spellcheck.

## Errors

An exception that escapes a listener, an event handler attribute, an
observer callback, or a frame callback is reported as a browser reports
it. The window hears a cancelable `error` event first:

```ts
window.addEventListener("error", (event) => {
	status.textContent = event.message;
	event.preventDefault();
});
```

A listener that calls `preventDefault()` has handled the error. An
unhandled one is not printed over the screen, and it does not stop the
program. It goes to the transport's log when the transport has one
apart from the screen: the process transport writes it to stderr when
stderr is not the terminal, so `node app.ts 2> errors.log` gives a live
log to tail in another pane. Otherwise the engine keeps it and prints
it below the document when the session ends, so it is seen either way.

Errors the engine throws at a call, an `InvalidStateError` from
`showModal()` on an open dialog, a `SyntaxError` from a bad selector,
are the ones a browser throws, and a caller catches them as it would
there. A failure inside the engine's own rendering ends the session:
the last frame is left in the scrollback, the terminal is restored, and
the error is thrown.

## Selection and the clipboard

Drag to select, in the document or inside a field; style it with
`::selection`. A double click selects the word under the pointer and a
triple click the paragraph, or in a `<textarea>` the line and in an
`<input>` the whole value, and a drag that follows extends the selection
a whole word or paragraph at a time. Clicks count as a double or triple
click only on the same cell, within half a second. All of it is the
default action of `mousedown`, so a listener that calls
`preventDefault()` does its own selecting, as CodeMirror does. `getSelection().toString()` is the rendered text, as in a
browser: nothing from a closed `<details>`, a `<select>`'s options, a
hidden element, or `user-select: none` content, and a line break
between blocks. `user-select: none` also keeps a drag from anchoring
or extending into an element, which is what a game board or a toolbar
wants. `getSelection().modify(alter, direction, granularity)`
moves the caret or drags the focus by character, word, line or line
boundary; the line granularities read the laid-out lines, so a soft wrap
counts as a line.

`navigator.clipboard.writeText(text)` copies to the system clipboard over
OSC 52, which travels in-band and works across SSH. `readText()` asks the
terminal for its clipboard by OSC 52 query, and rejects when the terminal
refuses to answer, as most do. Both work only during the dispatch of a
trusted event the user caused — a keystroke, a mouse press, a click, a
paste — and reject with `NotAllowedError` otherwise. The gate is stricter
than a browser's activation window: it does not survive an `await`.

A paste arrives as a cancelable `paste` event at the focused element, or
at `document.body` when nothing is focused, with the text on
`event.clipboardData`; left uncanceled, it inserts into a focused text
field:

```ts
document.addEventListener("paste", (event) => {
	console.log(event.clipboardData.getData("text/plain"));
	event.preventDefault();
});
```

`copy` and `cut` never fire from the user: the terminal keeps the copy
gesture — Cmd+C, Shift+drag — and Ctrl+C is the interrupt.

## Scrolling

The document scrolls with the standard calls, and so does a box whose
`overflow` is `auto` or `scroll`:

```ts
window.scrollTo(0, 0);
pane.scrollTop += 5;
element.scrollIntoView();
```

`scroll` fires on the box, or on the document for the document scroll,
and `window.scrollY` reports the document position. The mouse wheel
moves the innermost scrollable box under the pointer and hands what
remains to its ancestors, and a `wheel` listener that calls
`preventDefault()` stops it. How the document's own scroll shares the
wheel with the terminal's scrollback is in the
[rendering guide](/guides/rendering/#flow-mode).

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` takes the alternate screen and applies `:fullscreen`
styles. Exiting restores the main screen and scrollback. Escape exits;
if a text field is focused, the first Escape blurs it instead. The
[rendering guide](/guides/rendering/#fullscreen) has the details.

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
