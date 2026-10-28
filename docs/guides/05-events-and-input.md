---
title: Events and Input
description: Keyboard, mouse, focus, form controls, and selection.
---

Input arrives as DOM events, which you handle with `addEventListener`.
Events that the engine fires, such as decoded input, a resize, or a
focus change, have `isTrusted` set to true. Events that the program
creates and dispatches itself have `isTrusted` set to false.

## Keyboard

```ts
document.addEventListener("keydown", (ev) => {
	if (ev.key === "j") select(selected + 1);
	if (ev.key === "Enter") open(rows()[selected]);
});
```

The engine decodes escape sequences from the terminal into
`KeyboardEvent`s and sets `key`, `ctrlKey`, `altKey`, and `shiftKey`.
For a printable key, `key` is the printed character. For other keys,
`key` is the name a browser uses for that key:

| Terminal sends | `key` |
| --- | --- |
| Carriage return | `Enter` |
| Tab, and Shift+Tab | `Tab`, with `shiftKey` set for Shift+Tab |
| Delete byte | `Backspace` |
| A lone escape | `Escape` |
| Cursor keys, in either of the two encodings | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` |
| Home and End, in any of the three encodings | `Home`, `End` |
| The tilde keys | `Insert`, `Delete`, `PageUp`, `PageDown` |
| Function keys | `F1` through `F12` |
| A control byte | The lowercase letter, with `ctrlKey` set; NUL is `Ctrl+Space` |
| A cursor key with a modifier parameter | The key, with `shiftKey`, `altKey`, `ctrlKey`, and `metaKey` set from the bits of the parameter |

A character outside the Basic Multilingual Plane arrives as one
character. For a printable key, `keypress` fires after `keydown`. Then
`keyup` fires right away, because a terminal never reports when a key
is released.

### What a terminal can report

A terminal sends bytes, not key states, and some keystrokes send the
same byte. These limits apply to every terminal program:

- `Shift+Enter` sends the same byte as `Enter`. Bind the second action
  to `Ctrl+J` instead.
- `Enter` sends the same byte as `Ctrl+M`, and `Tab` the same byte as
  `Ctrl+I`. You get the named key, and the `Ctrl` chords never arrive.
- `Ctrl+C` is the interrupt, and it never reaches the document. It
  calls `window.close()`. A `beforeunload` listener that calls
  `preventDefault()` keeps the session open.
- `Ctrl+Z` suspends the program, the way a shell's job control does.
  A `keydown` listener can call `preventDefault()` to stop this, for
  example in an editor that uses `Ctrl+Z` for undo. While the program
  is suspended, the shell has the terminal and
  `document.visibilityState` is `"hidden"`. When the shell continues
  the program with `fg`, a document in flow mode starts again below the
  shell's output. Over SSH and on Windows, nothing can suspend the
  program, so `Ctrl+Z` is an ordinary key there.
- `Ctrl+L` redraws the screen, as it does in a shell, unless a
  `keydown` listener calls `preventDefault()`.
- `Ctrl+Shift+letter` looks the same as `Ctrl+letter`.
- `Alt+key` arrives as one key press with `altKey` set.
- A terminal set up to report extended keys (CSI u, or xterm's
  `modifyOtherKeys`) removes the limits above. `Shift+Enter`,
  `Ctrl+Shift+letter`, and the other chords then arrive as themselves.
  TermDOM decodes these reports but does not turn them on, so most
  terminals never send them.
- A key press is one `keydown`, then one `keypress` if the key is
  printable, then one `keyup`. There is no held-key state, and
  `event.repeat` is always false.
- A modifier pressed on its own sends nothing.
- Arrow keys and function keys carry modifiers only when the terminal
  encodes them. Most terminals do this for `Ctrl` and `Alt`.

### Editing chords in text fields

`<input>` and `<textarea>` bind the readline chords as default actions.
Calling `preventDefault()` on `keydown` cancels them, as it cancels any
other default action.

| Chord | Effect |
| --- | --- |
| `Ctrl+A` / `Ctrl+E` | Start / end of the line |
| `Ctrl+B` / `Ctrl+F` | Back / forward one character |
| `Ctrl+K` / `Ctrl+U` | Cut to the end / start of the line |
| `Ctrl+W` | Cut the word before the caret |
| `Ctrl+D` | Delete forward |
| `Ctrl+J` | Insert a newline, in a `<textarea>` |

`Ctrl+A` moves the caret to the start of the line, as it does in a
shell. It does not select all.

## Mouse

The engine dispatches mouse events at the element under the cell.
`mousedown` moves focus, `click` clicks, and `wheel` scrolls.
Coordinates are in cells.

| Terminal reports | Event |
| --- | --- |
| Left, middle, or right button press | `mousedown` with `button` 0, 1, or 2 |
| The release | `mouseup`, then `click` if the release lands on the same element |
| Two presses within the double-click interval | `detail` counts them, and `dblclick` fires on the second |
| Wheel up or down | `wheel` with `deltaY` of −3 or 3 and `deltaMode` of lines |
| Wheel left or right, or Shift with wheel up or down | `wheel` with `deltaX` of −3 or 3 |
| Shift, Alt, or Ctrl held | `shiftKey`, `altKey`, `ctrlKey` |
| Motion | `mousemove`, and the hover events below |

The terminal reports wheel notches, not distances. Each notch scrolls
three rows or columns, which matches how a browser counts lines. The
engine turns on mouse reporting when it attaches. The right and middle
buttons reach the page as ordinary presses. There is no context menu.

```ts
row.addEventListener("click", () => open(row.dataset.path!));
```

`:hover` styles the element under the pointer. `mouseover`,
`mouseout`, `mouseenter`, `mouseleave`, and `mousemove` fire as they do
in a browser. A terminal reports mouse motion only when asked. The
engine asks for it while a stylesheet has a `:hover` rule or the page
has a listener for one of those events, and stops when the last one is
gone. While a program has the mouse, the user can still hold `Shift`
to use the terminal's own select-to-copy.

```ts
document.head.innerHTML = "<style>li:hover { background-color: blue }</style>";
```

## Focus

Tab moves through focusable elements in document order. `:focus`
styles apply, and `element.focus()` works. Typing goes to the focused
element. Enter and Space click a focused button or summary, and Enter
follows a focused link.

Escape closes the element on top of the top layer, which is a modal
dialog or an open popover. It does this even if a `keydown` listener
canceled the key.

Tab from the last focusable element leaves nothing focused. The next
Tab then focuses the first element. A browser behaves the same way when
focus leaves the page for its toolbar and comes back.

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

`<dialog>` opens with `show()` or `showModal()`. A modal dialog sits in
the top layer, centered, with a `Canvas` backdrop that covers the page.
Escape closes it and fires `cancel`, then `close`.

A `[popover]` opens with `showPopover()`, `togglePopover()`, or a
`popovertarget` button. Light dismiss works: a click outside the
popover, or Escape, closes it and fires `toggle`.

`<details>` opens when the user clicks its `<summary>`, or presses
Enter or Space while the summary has focus. It fires `toggle`. Opening
or closing it does not scroll the page.

## Form controls

TermDOM implements `<input>` (text, number, checkbox, radio, range),
`<textarea>`, `<select>`, and `<button>`. They fire `input` and
`change`:

```html
<div class="field">
	<div class="label">Name</div><input id="name">
</div>
```

```ts
field.addEventListener("input", updatePreview);
```

`::placeholder` styles the placeholder of a field. The caret is the
real terminal cursor, so CJK input methods compose text in the field.
`<input type="password">` masks its value. A `<textarea>` scrolls to
keep its caret in view.

- A number input accepts only numbers. ArrowUp and ArrowDown step its
  value within `min` and `max`.
- In a radio group, the arrow keys move the check to the previous or
  next radio, and wrap around at the ends.
- A range input is a slider. The arrow keys move its thumb one step.
  PageUp and PageDown move it a tenth of the range, and Home and End
  move it to the ends. Each of these fires `input` and `change`. A
  press on the track moves the thumb to that point, and dragging moves
  it along. A drag fires `input` while it moves and `change` on
  release.

`new FormData(form)` collects the name and value of each control in
the form, in document order, as a browser does. Submitting a form
collects the same list. `requestSubmit()` fires `submit` first, and
stops if a listener cancels it. `submit()` skips the `submit` event.
In both cases the form then fires `formdata`. A listener can add to or
change `event.formData` before the form is submitted:

```ts
form.addEventListener("formdata", (event) => {
	event.formData.append("token", token);
});
form.requestSubmit();
```

Submission ends there. There is no page to navigate to, so the form
never sends anything over the network.

## Editing

An element with `contenteditable` is an editing host. When the user
clicks into it, the caret becomes the real terminal cursor, and typed
text goes into the tree. `document.designMode = "on"` makes the whole
body an editing host. Inside a host, the caret steps over a
`contenteditable="false"` element as one piece and never enters it. Up
and Down skip a line that holds only such elements.

```html
<div id="note" contenteditable>Type here.</div>
```

The keys move the caret as follows:

- Left and Right move it by character.
- Alt or Ctrl with an arrow key moves it by word.
- Up and Down move it by line.
- Home and End move it to the ends of the line.
- Shift with any of these extends the selection instead of moving the
  caret.

Backspace and Delete remove one grapheme cluster, or the selection if
there is one. The readline chords from text fields work here too:
Ctrl+W deletes the word before the caret, Ctrl+U deletes the line
before it, and Ctrl+K deletes the line after it. Enter splits the block
that holds the caret. Shift+Enter inserts a `<br>`, on a terminal that
reports Shift+Enter. A block left empty keeps a `<br>` so it stays one
line tall, as in Chrome.

Every edit fires a cancelable `beforeinput` first and an `input`
after. Both bubble from the element that holds the caret, and both use
the input types from the spec:

- `insertText`
- `insertFromPaste`
- `insertParagraph`
- `insertLineBreak`
- `deleteContentBackward`
- `deleteContentForward`
- `deleteWordBackward`
- `deleteSoftLineBackward`
- `deleteSoftLineForward`

If a listener cancels the `beforeinput`, the tree does not change:

```ts
note.addEventListener("beforeinput", (event) => {
	if (event.inputType === "insertParagraph") {
		event.preventDefault();
	}
});
```

These are not supported yet: undo and redo, `execCommand`, the
formatting commands, HTML paste, IME composition in an editing host,
and spellcheck.

## Errors

The engine reports an uncaught exception the way a browser does when it
comes from any of these:

- an event listener
- an event handler attribute
- an observer callback
- a frame callback
- a callback passed to `window.setTimeout()`, `setInterval()`, or
  `queueMicrotask()`

The global `setTimeout()` belongs to the runtime unless
`installGlobals()` has replaced it. An exception from the runtime's
timer ends the program. With the globals installed, a promise that is
rejected with no handler fires `unhandledrejection` on the window, and
the engine reports it the same way. The window first gets a cancelable
`error` event:

```ts
window.addEventListener("error", (event) => {
	status.textContent = event.message;
	event.preventDefault();
});
```

A listener that calls `preventDefault()` has handled the error. An
unhandled error does not stop the program, and the engine does not
print it over the screen. If the transport has a log separate from the
screen, the error goes there. The process transport writes it to
stderr when stderr is not the terminal, so `node app.ts 2> errors.log`
gives you a log to tail in another pane. Otherwise the engine keeps the
error and prints it below the document when the session ends.

During development you may want the program to stop at the first
error instead. Pass `failFast: true` to the constructor:

```ts
const term = new TermDOM({
	failFast: process.env.NODE_ENV !== "production",
});
```

The window still gets its `error` event first, and a listener that
calls `preventDefault()` still handles the error. An unhandled error
ends the session: the engine restores the terminal, prints the error
below the document, and closes the transport with status 1. A process
exits with that status. Over SSH, only the session that failed ends,
and the server keeps running.

Methods throw the same errors a browser throws. For example,
`showModal()` on an open dialog throws an `InvalidStateError`, and a
bad selector throws a `SyntaxError`. A failure inside the engine's own
rendering ends the session. The engine leaves the last frame in the
scrollback, restores the terminal, and throws the error.

## Selection and the clipboard

Drag to select text, in the document or inside a field. Style the
selection with `::selection`. A double click selects the word under
the pointer. A triple click selects the paragraph, or the line in a
`<textarea>`, or the whole value in an `<input>`. A drag after a double
or triple click extends the selection a whole word or paragraph at a
time. Clicks count as a double or triple click only when they are on
the same cell and within half a second of each other. All of this is
the default action of `mousedown`. A listener that calls
`preventDefault()` can do its own selecting, as CodeMirror does.

`getSelection().toString()` returns the rendered text, as in a browser.
It leaves out:

- the contents of a closed `<details>`
- the options of a `<select>`
- hidden elements
- content with `user-select: none`

It puts a line break between blocks. `user-select: none` also stops a
drag from starting in an element or extending into it, which is useful
for a game board or a toolbar.

`getSelection().modify(alter, direction, granularity)` moves or extends
the selection by character, word, line, or line boundary. Lines are
the lines as laid out, so each line of a wrapped paragraph counts as
its own line.

`navigator.clipboard.writeText(text)` copies to the system clipboard
over OSC 52, which travels in-band and works over SSH. `readText()`
asks the terminal for its clipboard with an OSC 52 query. It rejects
when the terminal refuses to answer, and most terminals refuse. Both
methods work only while the engine is dispatching a trusted event that
the user caused, such as a keystroke, a mouse press, a click, or a
paste. Otherwise they reject with `NotAllowedError`. Unlike in a
browser, this permission ends at the first `await`.

A paste arrives as a cancelable `paste` event at the focused element,
or at `document.body` when nothing has focus. The text is on
`event.clipboardData`. If no listener cancels the event, the text goes
into the focused text field:

```ts
document.addEventListener("paste", (event) => {
	console.log(event.clipboardData!.getData("text/plain"));
	event.preventDefault();
});
```

`copy` and `cut` never fire from user input. The terminal handles the
copy gestures itself (Cmd+C, Shift+drag), and Ctrl+C is the interrupt.

## Scrolling

The document scrolls with the standard calls. So does a box whose
`overflow` is `auto` or `scroll`:

```ts
window.scrollTo(0, 0);
pane.scrollTop += 5;
element.scrollIntoView();
```

Keys scroll as the default action of a `keydown` that no listener
canceled, as they do in a browser:

- ArrowUp and ArrowDown scroll one row.
- PageUp, PageDown, and Space scroll one page, keeping one row of
  overlap.
- Home and End scroll to the top or bottom.

The key scrolls the nearest box around the focused element that can
scroll in that direction. If there is none, it scrolls the document.
Keys that a field, a `<select>`, or editable content uses do not
scroll, and neither does Space on a button. A program that uses these
keys itself should call `preventDefault()`.

`scroll` fires on the box, or on the document when the document
scrolls. `scrollend` follows once scrolling stops. `window.scrollY`
reports the document position. When you set it past the end, it is
clamped to the end right away.

`scrollIntoView()` aligns the element to the top, as a browser does.
Pass `{block: "nearest"}` to scroll only as far as needed to show the
element. This works well for moving a selection through a list.

The mouse wheel scrolls the innermost scrollable box under the pointer,
and passes any leftover distance to the boxes around it. A `wheel`
listener that calls `preventDefault()` stops the scroll. A sideways
notch scrolls the innermost box that can scroll sideways. The document
itself never scrolls sideways. The
[rendering guide](/guides/rendering/#flow-mode) explains how the
document and the terminal's scrollback share the wheel.

## Fullscreen

```ts
await element.requestFullscreen();
```

`requestFullscreen()` switches to the alternate screen and applies
`:fullscreen` styles. `document.exitFullscreen()` restores the main
screen and the scrollback. Escape does not exit fullscreen by itself.
It reaches `keydown` like any other key. The
[rendering guide](/guides/rendering/#fullscreen) has the details.

## Resizing

A terminal resize fires `resize` at the window:

```ts
window.addEventListener("resize", () => {
	draw(window.innerWidth, window.innerHeight);
});
```

The event does not carry the size. Read it from the window or from any
element. Both have the new size before listeners run.

The same resize re-evaluates `@media` rules. After `resize`, it fires
`change` on live `MediaQueryList` objects, as in a browser:

```ts
const wide = window.matchMedia("(min-width: 80ch)");
wide.addEventListener("change", relayout);
```
