# TermDOM Scrollback Architecture

## Core Philosophy

TermDOM applications should behave exactly like normal terminal commands, except all output is mutable. This means:

- Commands start at the current cursor position
- Output flows downward, scrolling the terminal naturally as needed
- Unlike regular commands, TermDOM can update/change any of that output

The `git diff` command is exactly the UX I want to emulate.

## Buffer Architecture

### Viewport Buffer

- **CellBuffer dimensions**: Always `terminalHeight × terminalWidth`
- **Purpose**: Represents exactly what's visible on screen
- **Content**: A rendering window into the DOM tree

### DOM Tree

- **Scope**: Holds all application content (visible + scrolled off-screen)
- **Mutability**: Any DOM element can be updated at any time
- **Layout**: Drives what content appears in the viewport buffer

## Rendering Model

### Initial Rendering

Commands begin at `commandStart` row and render DOM content downward:

```
┌─────────────────┐
│ [previous cmds] │
│                 │
│ $ my-command    │ ← commandStart
│ [DOM content]   │ ← render from here downward
│                 │
└─────────────────┘
```

### Growth Pattern

When DOM content exceeds available space, emit newlines to push `commandStart` upward:

```
┌─────────────────┐
│ [DOM content]   │ ← expanded content fills upward
│ [DOM content]   │
│ [DOM content]   │
│ $ my-command    │ ← commandStart moved up via \n
│ [more content]  │
└─────────────────┘
```

### Full Terminal Usage

Eventually content can use the entire terminal height:

```
┌─────────────────┐ ← renderStartRow = 0
│ [DOM content]   │
│ [DOM content]   │
│ [DOM content]   │
│ [DOM content]   │
└─────────────────┘ ← terminal bottom
```

## Mathematical Model

### Variables

- `terminalHeight` = total terminal rows (viewport height)
- `commandStart` = initial command start row
- `contentHeight` = total DOM content height in rows
- `commandHeight` = `terminalHeight - commandStart` (initial available space)

### Rendering Formula

```javascript
if (contentHeight <= commandHeight) {
  renderStartRow = commandStart;
} else {
  renderStartRow = Math.max(0, commandStart - (contentHeight - commandHeight));
}
```

### Buffer Population

1. Always create buffer with `terminalHeight` rows
2. Render DOM content starting from `renderStartRow`
3. Fill downward until terminal bottom or content ends
4. Generate ANSI from populated buffer (includes newlines for line breaks)
5. When `contentHeight > commandHeight`: newlines in ANSI output cause terminal to scroll up, pushing `commandStart` upward into native scrollback

## ANSI Generation

### Scrolling Optimization

When content changes, prefer ANSI scrolling sequences over full redraws:

- `\x1b[S` - Scroll up (insert blank line at bottom)
- `\x1b[T` - Scroll down (insert blank line at top)
- `\x1b[L` - Insert line at cursor
- `\x1b[M` - Delete line at cursor

### Linear Processing

Since buffer represents fixed viewport:

- Process cells left-to-right, top-to-bottom
- No absolute positioning needed
- Emit characters and styles sequentially
- Use `\r\n` for line breaks


## The invariant, and where it breaks

Committed rows are **frozen**. The cursor cannot address scrollback, so once a row
has scrolled off the top it can never be redrawn. Everything below is the live
viewport, and is ours.

That gives flow mode its whole value -- output lands in real scrollback, so it is
searchable, selectable, copy-pasteable and survives the process exiting -- and it
costs exactly one thing:

> **The committed prefix must never change -- neither its text nor its height.
> Everything in the viewport may do as it likes.**

"Append-only" would be too strong, and wrong. The document is not required to be
append-only: the viewport is fully addressable, so the live region can mutate,
reflow, grow, shrink, animate and be interactive on every frame. Only what has
*already scrolled off* is frozen.

Nor is "only the viewport can be interactive" a restriction this library imposes.
The terminal delivers no events for content in scrollback and offers no escape
sequence that addresses it. Committed content is readable -- the user can scroll
up, select it, copy it -- but it cannot be live. That is what a terminal
transcript has always been, and it is how every well-behaved CLI already works:
the history scrolls up and freezes; the prompt, the spinner and the dialogs stay
at the bottom, in the viewport, changing freely.

Three cases, and they are not equivalent:

| Change | Result |
| --- | --- |
| **A committed row's *content* changes** | Ignored. The screen keeps what was printed; the DOM moves on. No corruption. This is correct: you cannot un-print, and a transcript is a record of what happened. |
| **The document shrinks or is cleared** | The commit index is clamped and the live viewport re-renders the remaining document. The scrollback keeps the old transcript. Coherent -- like a command that printed, then printed something else. |
| **The document *reflows* above the fold** (a row inserted or removed near the top) | **Corrupts.** The commit index is a document *row number*, and reflow shifts every row number underneath it. Rows get re-printed into the scrollback (duplicated), and the inserted content never appears. |
| **The terminal is resized** | **Corrupts, and nobody is at fault.** Wrapping is a function of width, so the same document is 8 rows at 40 columns and 12 at 24. The row count itself changes, and a commit index counted in rows no longer refers to the same content. |

Interactivity is not the violator. **Reflow** is, and it has two sources.

The first is the app changing content above the fold, which is avoidable: do not
rewrite what you have already printed. An app that needs to is telling you it is
not a transcript.

The second is **terminal resize**, which is not avoidable by anyone. It is why
Anthropic, having rebuilt Claude Code's renderer from scratch, still reports that
"resize flickers remain" -- resize invalidates the committed prefix by definition
for any content that wraps.

### The two modes are a consequence, not a preference

- **flow** — for output that accumulates: logs, streaming, diffs, transcripts. The
  terminal owns the scrollback; you never clear; there is no flicker, ever.
- **virtualized / alt buffer** — for a document that mutates or that the user
  navigates: pagers, editors, dashboards. You own the screen. Anything can change.
  On exit the alt buffer restores, so the user's scrollback is untouched.

An app that reflows above the fold is telling you it belongs in the second mode.
The library should detect that and either say so or escalate, rather than quietly
producing a corrupt scrollback.

### What it does now: reprint, never repair

Reflow above the fold is detected by anchoring on the first element still below
the fold. If the content above it changes height, that element moves, and the
commit index has stopped meaning what it meant.

When that happens, TermDOM prints the document again, below what is already there.

The scrollback cannot be rewritten -- no escape sequence addresses it. There are
exactly two primitives:

- **append** (print a line)
- **destroy** (`\x1b[3J`, clear the scrollback)

Destroying it and re-rendering *is* what flicker is. So we append: the stale copy
stays above as an honest record of what was shown, and a correct copy is printed
below it. It costs a duplicate. It never flickers, and it never loses anything.

For a transcript that reflows rarely, that is the right trade. An app that reflows
*often* would bury the user in copies -- and that is the app telling you it is a
document, not a transcript, and belongs in the alt buffer.

### Re-anchoring on a vertical resize

A resize moves two things, and only one of them is guessable.

**Horizontal** (width) is the reflow above: a long shell prompt above the frame
rewraps and shifts where our content begins, by an amount that depends on text we
do not own. Not computable. This is the residual reprint-a-copy case above.

**Vertical** (height) is computable exactly. When the terminal loses rows it
scrolls up to keep the cursor -- the bottom of our content -- on screen, and the
command start rides up with it by the same amount. After laying out at the new
size we know the content's height, so we know how far its bottom overflowed the
new height:

```
scrolledUp = max(0, previousStart + contentHeight - newHeight)
startRow   = max(0, previousStart - scrolledUp)
```

Redrawing from `startRow` instead of the stale `previousStart` lands the frame
where the terminal actually scrolled it to, so the visible viewport shows the
frame once. Without it, the frame is drawn too low and the old top row is orphaned
above the new render -- the double-render seen when dragging a window shorter. When
the content is genuinely taller than the shrunk viewport, the overflow still goes
into scrollback: that is not corruption, only content that no longer fits.

## Future Enhancements

### Native Scrollback Integration

Potential hybrid approach:

- Hand-off to native scrollback when reaching top of DOM content
- Take-over when scrolling back into TermDOM managed region
- Requires terminal capability detection and state synchronization

### Advanced Scrolling

- Element-level `overflow-y` (beyond window level)
- Horizontal overflow handling (`overflow-x`)
- Text truncation with ellipses ("...")

## Key Invariants

1. **Viewport Constancy**: CellBuffer always matches terminal dimensions
2. **Linear Flow**: Content renders sequentially from calculated start row
3. **Natural Scrolling**: Terminal handles scrolling mechanics, not manual cursor positioning
4. **Mutable History**: All rendered content remains editable through DOM updates
5. **Command Compatibility**: Behavior matches regular terminal commands with mutability added
