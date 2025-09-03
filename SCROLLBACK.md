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
