---
title: Events and Input
description: Keyboard, mouse, focus, form controls, and selection.
---

Input arrives as DOM events, through `addEventListener`. Events the
engine fires, such as decoded input, a resize or a focus change, have
`isTrusted` set to true. Events the program creates and dispatches
itself have it set to false.

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
- `Ctrl+C` is the interrupt; it never reaches the document. It calls
  `window.close()`, and a `beforeunload` listener that calls
  `preventDefault()` keeps the session.
- `Ctrl+Z` suspends the program, as a shell's job control does, unless
  a `keydown` listener calls `preventDefault()`, as an editor that uses
  it for undo does. The terminal is handed back and
  `document.visibilityState` is `"hidden"` until the shell continues the
  program with `fg`; a document in flow starts again below the shell's
  lines. Over SSH, and on Windows, where nothing can suspend the program,
  `Ctrl+Z` is an ordinary key.
- `Ctrl+L` redraws the screen, as it does in a shell, unless a `keydown`
  listener calls `preventDefault()`.
- `Ctrl+Shift+letter` is indistinguishable from `Ctrl+letter`.
- `Alt+key` arrives as one key press with `altKey` set.
- A terminal set up to report extended keys (CSI u, or xterm's
  `modifyOtherKeys`) lifts the limits above: `Shift+Enter`,
  `Ctrl+Shift+letter` and the rest arrive as themselves. TermDOM decodes
  these reports but does not turn them on, so most terminals never send
  them.
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
| Wheel left or right, or Shift with wheel up or down | `wheel` with `deltaX` of −3 or 3 |
| Shift, Alt, or Ctrl held | `shiftKey`, `altKey`, `ctrlKey` |
| Motion | `mousemove`, and the hover events below |

The terminal reports wheel notches, not distances, so each notch
scrolls three rows or columns, as a browser counts lines. The engine
turns on mouse reporting when it attaches. The right and middle buttons
reach the page as ordinary presses; there is no context menu.

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
listener canceled it. Tab from the last focusable element focuses
nothing, and the next Tab goes to the first, as when a browser's focus
passes through its toolbar.

## Dialogs, popovers, and details

`<dialog>` opens with `show()` or `showModal()`, and a modal one sits in
the top layer, centered, with a `Canvas` backdrop that covers the page.
Escape closes it and fires `cancel` then `close`. A `[popover]` opens
with `showPopover()` or `togglePopover()`, or a `popovertarget` button,
and light dismiss works: a click outside, or Escape, closes it and
fires `toggle`. `<details>` opens on a click of its `<summary>`, or
Enter or Space with the summary focused, and fires `toggle`. Opening or
closing it does not scroll the page.

## Form controls

`<input>` (text, number, checkbox, radio, range), `<textarea>`,
`<select>`, and `<button>` are implemented and fire `input` and
`change`:

```html
<div class="field">
	<div class="label">Name</div><input id="name">
</div>
```

```ts
field.addEventListener("input", updatePreview);
```

`::placeholder` styles a field's placeholder. The caret is the real
terminal cursor, so CJK input methods compose in the field.
`<input type="password">` masks its value. A `<textarea>` scrolls to
keep its caret in view. A number input accepts only numbers, and
ArrowUp and ArrowDown step it within `min` and `max`. The arrows move a radio's
check to the previous or next radio of its group, wrapping at the ends.
A range input is a slider: the arrows move its thumb a step, PageUp and
PageDown a tenth of the range, and Home and End to its ends, each firing
`input` and `change`. A press on its track moves the thumb there and a
drag carries it, firing `input` as it moves and `change` on release.

`new FormData(form)` collects the name and value of each control in
the form, in document order, as a browser does. Submitting a form
collects the same list. `requestSubmit()` fires `submit` first and
stops there if a listener cancels it; `submit()` skips that event.
Either way the form then fires `formdata`, and a listener can add to or
change `event.formData` before the form is submitted:

```ts
form.addEventListener("formdata", (event) => {
	event.formData.append("token", token);
});
form.requestSubmit();
```

Submission stops there. There is no page to go to, so the form never
sends anything over the network.

## Editing

An element with `contenteditable` is an editing host: click into it and
the caret becomes the real terminal cursor, and what you type goes into
the tree. `document.designMode = "on"` makes the whole body one. A
`contenteditable="false"` element inside a host is stepped over as one
piece and never takes the caret, and Up and Down skip a line made only
of such elements.

```html
<div id="note" contenteditable>Type here.</div>
```

The arrows move the caret by character, Alt or Ctrl with them by word,
Up and Down by line, and Home and End to the line's ends; Shift extends
the selection instead of moving it. Backspace and Delete take one
grapheme cluster, or the selection. The readline chords the text fields
use work here too: Ctrl+W deletes the word before the caret, Ctrl+U the
line before it, and Ctrl+K the line after it. Enter splits the block
the caret is in. Shift+Enter inserts a `<br>`, on a terminal that
reports Shift+Enter. A block left empty keeps a `<br>` so it stays one
line tall, as in Chrome.

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

Not supported yet: undo and redo, `execCommand`, the formatting
commands, HTML paste, IME composition in an editing host, and
spellcheck.

## Errors

An exception that escapes a listener, an event handler attribute, an
observer callback, a frame callback, or a callback given to
`window.setTimeout()`, `setInterval()` or `queueMicrotask()` is reported
as in a browser. The global `setTimeout()` is the runtime's unless
`installGlobals()` has replaced it, and an exception from the runtime's
timer ends the program. With the globals installed, a promise rejected
with no handler fires `unhandledrejection` on the window and is
reported the same way. The window gets a cancelable `error` event
first:

```ts
window.addEventListener("error", (event) => {
	status.textContent = event.message;
	event.preventDefault();
});
```

A listener that calls `preventDefault()` has handled the error. An
unhandled one does not stop the program, and it is not printed over the
screen. If the transport has a log separate from the screen, the error
goes there: the process transport writes it to stderr when stderr is
not the terminal, so `node app.ts 2> errors.log` gives a log to tail in
another pane. Otherwise the engine keeps it and prints it below the
document when the session ends.

Methods throw the errors a browser throws, such as an
`InvalidStateError` from `showModal()` on an open dialog or a
`SyntaxError` from a bad selector. A failure inside the engine's own
rendering ends the session: the last frame is left in the scrollback,
the terminal is restored, and the error is thrown.

## Selection and the clipboard

Drag to select, in the document or inside a field; style it with
`::selection`. A double click selects the word under the pointer and a
triple click the paragraph, or in a `<textarea>` the line and in an
`<input>` the whole value, and a drag that follows extends the selection
a whole word or paragraph at a time. Clicks count as a double or triple
click only on the same cell, within half a second. All of it is the
default action of `mousedown`, so a listener that calls
`preventDefault()` does its own selecting, as CodeMirror does.

`getSelection().toString()` is the rendered text, as in a browser:
nothing from a closed `<details>`, a `<select>`'s options, a hidden
element, or `user-select: none` content, and a line break between
blocks. `user-select: none` also keeps a drag from starting in or
extending into an element, which suits a game board or a toolbar.
`getSelection().modify(alter, direction, granularity)` moves or extends
the selection by character, word, line or line boundary. Lines are the
laid-out lines, so a soft wrap counts as a line.

`navigator.clipboard.writeText(text)` copies to the system clipboard over
OSC 52, which travels in-band and works across SSH. `readText()` asks the
terminal for its clipboard by OSC 52 query, and rejects when the terminal
refuses to answer, as most do. Both work only during the dispatch of a
trusted event the user caused — a keystroke, a mouse press, a click, a
paste — and reject with `NotAllowedError` otherwise. Unlike in a
browser, that permission ends at the first `await`.

A paste arrives as a cancelable `paste` event at the focused element, or
at `document.body` when nothing is focused, with the text on
`event.clipboardData`; left uncanceled, it inserts into a focused text
field:

```ts
document.addEventListener("paste", (event) => {
	console.log(event.clipboardData!.getData("text/plain"));
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

The keys scroll as a browser's do, as the default action of a `keydown`
no listener canceled: ArrowUp and ArrowDown a row, PageUp, PageDown and
Space a page, keeping one row of overlap, and Home and End to the top
or bottom. The key scrolls the nearest box around the focused element
that can scroll that way, or else the document. Keys used by a field, a
`<select>` or editable content, and Space on a button, do not
scroll. A program that uses those keys itself calls `preventDefault()`,
as it would in a browser.

`scroll` fires on the box, or on the document for the document scroll,
and `scrollend` follows once scrolling stops. `window.scrollY` reports
the document position, clamped to the end as soon as it is set.
`scrollIntoView()` aligns the element to the top, as in a browser; pass
`{block: "nearest"}` to move only as far as it takes to show it, which
suits a selection moving through a list. The mouse wheel scrolls the
innermost scrollable box under the pointer, and passes what is left
over to the boxes around it. A `wheel` listener that calls
`preventDefault()` stops it. A sideways notch scrolls the innermost box
that can scroll sideways; the document itself never scrolls sideways.
The [rendering guide](/guides/rendering/#flow-mode) says how the
document and the terminal's scrollback share the wheel.

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` takes the alternate screen and applies `:fullscreen`
styles. `document.exitFullscreen()` restores the main screen and
scrollback. Escape does not exit on its own; it reaches `keydown` like
any other key. The [rendering guide](/guides/rendering/#fullscreen) has
the details.

## Resizing

A terminal resize fires `resize` at the window:

```ts
window.addEventListener("resize", () => {
	draw(window.innerWidth, window.innerHeight);
});
```

The event carries no size. Read it from the window or any element,
which have the new size before listeners run.

The same resize re-evaluates `@media` rules and fires `change` on live
`MediaQueryList` objects, after `resize`, as in a browser:

```ts
const wide = window.matchMedia("(min-width: 80ch)");
wide.addEventListener("change", relayout);
```
