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

> **Flow mode is sound only while the document is append-only.**

Three cases, and they are not equivalent:

| Change | Result |
| --- | --- |
| **A committed row's *content* changes** | Ignored. The screen keeps what was printed; the DOM moves on. No corruption. This is correct: you cannot un-print, and a transcript is a record of what happened. |
| **The document shrinks or is cleared** | The commit index is clamped and the live viewport re-renders the remaining document. The scrollback keeps the old transcript. Coherent -- like a command that printed, then printed something else. |
| **The document *reflows* above the fold** (a row inserted or removed near the top) | **Corrupts.** The commit index is a document *row number*, and reflow shifts every row number underneath it. Rows get re-printed into the scrollback (duplicated), and the inserted content never appears. |

The third case is unsolved. It is not a bug to be patched -- it is the terminal
telling you that the document is not append-only, and therefore does not belong in
flow mode.

### The two modes are a consequence, not a preference

- **flow** — for output that accumulates: logs, streaming, diffs, transcripts. The
  terminal owns the scrollback; you never clear; there is no flicker, ever.
- **virtualized / alt buffer** — for a document that mutates or that the user
  navigates: pagers, editors, dashboards. You own the screen. Anything can change.
  On exit the alt buffer restores, so the user's scrollback is untouched.

An app that reflows above the fold is telling you it belongs in the second mode.
The library should detect that and either say so or escalate, rather than quietly
producing a corrupt scrollback.

**This is the open decision.** The options are: ignore it (today's behaviour,
which corrupts), escalate to the alt buffer automatically, warn in development, or
reprint the document as a fresh block below the transcript (never rewriting
history, at the cost of re-emitting everything).

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
