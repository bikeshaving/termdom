Virtual Scrollback Buffer Design Document

## Overview

The Virtual Scrollback Buffer enables **fully mutable terminal content** that can grow beyond the viewport while maintaining DOM-like update capabilities. Since all content must remain editable, **native terminal scrollback is not used** - the application maintains complete authority over all content in a virtual buffer.

The system operates in two modes:
- **Anchored Mode**: Normal screen buffer with virtual scrollback for content that exceeds viewport
- **Managed Mode**: Alternate screen buffer entered only upon explicit `requestFullscreen()` call

This approach provides **browser-like infinite scrollable documents** with the ability to update any content at any time, regardless of viewport position.
## Goals

1. **Full Content Mutability**: All rendered content remains editable at all times
2. **Virtual Scrollback**: Application owns all content history in virtual buffer
3. **Natural Growth**: Content starts small and grows beyond viewport as needed
4. **Efficient Delta Rendering**: Use xterm.js SerializeAddon for minimal ANSI generation
5. **Anchored Updates**: Stay on normal screen even when content exceeds viewport
6. **Explicit Fullscreen**: Only use alternate screen when explicitly requested
7. **Browser-Like Scrolling**: Implement scrolling within virtual buffer, not native scrollback
## Core Concepts

### Fully Virtual Buffer Model

All content lives in a **virtual buffer** that can grow infinitely, independent of terminal viewport:

```typescript
class TTYOMRenderer {
  // Virtual buffer holds ALL content (can exceed terminal height)
  private virtualBuffer: Buffer;
  
  // Viewport window into virtual buffer
  private viewport: {
    scrollOffset: number;  // Top line of virtual buffer visible in terminal
    height: number;        // Terminal rows
    width: number;         // Terminal columns
  };
  
  // Rendering always uses viewport slice
  render(domTree: Element) {
    // 1. Update virtual buffer with DOM content
    this.updateVirtualBuffer(domTree);
    
    // 2. Extract viewport slice from virtual buffer
    const viewportSlice = this.getViewportSlice();
    
    // 3. Serialize only visible portion to ANSI
    const ansi = this.serializeAddon.serialize(viewportSlice);
    
    // 4. Position and render in terminal viewport
    this.renderToTerminal(ansi);
  }
}
```

### Auto-Promotion When Exceeding Viewport

Content automatically continues in virtual buffer when exceeding viewport, **without switching screens**:

```typescript
class AnchoredRenderer {
  render(domTree: Element) {
    const contentHeight = this.calculateDOMHeight(domTree);
    const terminalHeight = process.stdout.rows;
    
    if (contentHeight > terminalHeight) {
      // Content exceeds viewport - auto-promote to virtual scrolling
      // But STAY in normal screen (no alternate screen switch)
      this.virtualBuffer.resize(contentHeight);
      this.enableVirtualScrolling();
    }
    
    // Always render viewport slice, whether content fits or not
    this.renderViewportSlice();
  }
}
```

### Explicit Fullscreen Request

Alternate screen is **only** used when explicitly requested:

```typescript
// DOM element explicitly requests fullscreen
element.requestTerminalFullscreen();

// Only then switch to alternate screen
class ManagedRenderer {
  enterFullscreen() {
    process.stdout.write('\x1b[?1049h'); // Enter alternate screen
    this.mode = 'managed';
    // Now have complete control without terminal chrome
  }
}
## Rendering Model

### Progressive Buffer Control

The system starts by controlling only the terminal from the cursor position downward, gradually expanding control as content grows:

```typescript
class ProgressiveRenderer {
  private buffer: CellBuffer;
  private controlledStartRow: number; // First row we control (1-based)
  private cursorStartPosition: { row: number; col: number };
  private terminalHeight: number;
  private terminalWidth: number;
  
  async initialize() {
    // Enter raw mode immediately
    process.stdin.setRawMode(true);
    
    // Get initial cursor position once
    this.cursorStartPosition = await this.requestCursorPosition();
    this.controlledStartRow = this.cursorStartPosition.row;
    
    // Create full terminal-sized buffer
    const termSize = await this.getTerminalSize();
    this.buffer = createBuffer(termSize.rows, termSize.cols);
    this.terminalHeight = termSize.rows;
    this.terminalWidth = termSize.cols;
    
    // Set up resize handling
    process.on('SIGWINCH', () => this.handleResize());
  }
  
  render() {
    // Save cursor position
    let output = '\x1b[s';
    
    // Calculate rows we control
    const controlledRows = this.terminalHeight - this.controlledStartRow + 1;
    
    // Only render the portion we control
    const startIdx = this.controlledStartRow - 1;
    const endIdx = Math.min(this.buffer.length, this.terminalHeight);
    const visibleBuffer = this.buffer.slice(startIdx, endIdx);
    
    // Move to start of controlled area
    output += `\x1b[${this.controlledStartRow};1H`;
    
    // Render our controlled content
    output += this.serialize(visibleBuffer);
    
    // Restore cursor position
    output += '\x1b[u';
    
    process.stdout.write(output);
  }
  
  addContent(newRows: number) {
    const availableRows = this.terminalHeight - this.controlledStartRow + 1;
    const totalContentRows = this.getContentHeight();
    
    if (totalContentRows > availableRows) {
      // Terminal will scroll!
      const scrollAmount = totalContentRows - availableRows;
      
      // We now control more rows (terminal scrolled up)
      this.controlledStartRow = Math.max(1, this.controlledStartRow - scrollAmount);
      
      if (this.controlledStartRow === 1) {
        // We now control the entire screen
        this.transitionToVirtualScrollback();
      } else {
        // Shift our buffer content up to match terminal scroll
        this.shiftBufferUp(scrollAmount);
      }
    }
  }
  
  private transitionToVirtualScrollback() {
    // We now control the full screen - can implement virtual scrolling
    this.mode = 'virtual-scrollback';
    // Buffer can now grow beyond terminal height
  }
}
```

### Anchored Mode (Normal Screen)

Once the progressive buffer controls the full screen, it transitions to virtual scrollback while staying on the normal screen:

```typescript
class AnchoredRenderer {
  render(domTree: Element) {
    if (this.controlledStartRow > 1) {
      // Still in progressive mode
      this.progressiveRender(domTree);
    } else {
      // Full control - use virtual scrollback
      this.virtualScrollbackRender(domTree);
    }
  }
  
  private virtualScrollbackRender(domTree: Element) {
    // 1. Update entire virtual buffer with DOM content
    this.updateVirtualBuffer(domTree);
    
    // 2. Determine viewport slice to render
    const viewportRange = {
      start: this.viewport.scrollOffset,
      end: this.viewport.scrollOffset + this.viewport.height
    };
    
    // 3. Serialize only the visible slice
    const viewportAnsi = this.serializeAddon.serialize(viewportRange);
    
    // 4. Save cursor, render, restore cursor
    const output = '\x1b[s\x1b[1;1H' + viewportAnsi + '\x1b[u';
    process.stdout.write(output);
  }
  
  scroll(delta: number) {
    // Only available once we have full control
    if (this.controlledStartRow === 1) {
      this.viewport.scrollOffset = Math.max(0, 
        Math.min(this.virtualBuffer.length - this.viewport.height,
          this.viewport.scrollOffset + delta));
      this.render(this.currentDOM);
    }
  }
}
```

**Characteristics:**
- ✅ Respects existing terminal content above cursor
- ✅ Natural progressive takeover as content grows
- ✅ No flicker - cursor save/restore for all rendering
- ✅ Smooth transition to virtual scrollback
- ✅ All content remains mutable in buffer

### Managed Mode (Alternate Screen)

Only entered upon explicit fullscreen request:

```typescript
class ManagedRenderer {
  requestTerminalFullscreen() {
    // Enter alternate screen ONLY when explicitly requested
    process.stdout.write('\x1b[?1049h');
    process.stdout.write('\x1b[2J\x1b[H');
    
    // Same rendering model, but now own entire screen
    this.render(this.currentDOM);
  }
  
  exitFullscreen() {
    // Return to normal screen
    process.stdout.write('\x1b[?1049l');
    this.mode = 'anchored';
  }
}
```

**Characteristics:**
- ✅ Complete screen control without terminal chrome
- ✅ Entered only by explicit API call
- ✅ Same virtual buffer model as anchored mode
- ✅ Can return to anchored mode when done
## xterm.js Integration Architecture

### Components Used

The system leverages three key vendored xterm.js components:

1. **Buffer/BufferSet**: Core terminal buffer management
2. **SerializeAddon**: Efficient ANSI delta generation  
3. **EscapeSequenceParser**: Input parsing for mouse/keyboard events

```typescript
// Import from vendored xterm.js source
import { Buffer } from './vendor/xterm.js/src/common/buffer/Buffer';
import { SerializeAddon } from './vendor/xterm.js/addons/addon-serialize/src/SerializeAddon';
import { EscapeSequenceParser } from './vendor/xterm.js/src/common/parser/EscapeSequenceParser';
```

### SerializeAddon Delta Generation

The SerializeAddon naturally generates **relative cursor movements** for efficient updates:

```typescript
// Example SerializeAddon output
const deltaAnsi = serializeAddon.serialize();
// Generates: "Hello\x1b[2B\x1b[5CWorld\x1b[1A\x1b[2CUpdated"
// Meaning: Write "Hello", move down 2/right 5, write "World", move up 1/right 2, write "Updated"
```

**Key ANSI Commands Generated:**
- `\x1b[${n}C` - Move cursor right n columns (relative)
- `\x1b[${n}B` - Move cursor down n rows (relative)  
- `\x1b[${n}A` - Move cursor up n rows (relative)
- `\x1b[${n}X` - Erase n characters (clear right)

### Buffer Positioning Strategy

The xterm.js buffer represents the **managed content area**, always starting from (0,0):

```typescript
// Buffer is viewport-sized, not terminal-sized
buffer: Buffer; // Represents command's managed area

render() {
  // 1. xterm buffer thinks it starts at (0,0)
  // 2. SerializeAddon generates relative movements within buffer  
  // 3. We prefix with absolute position to command start
  
  const relativeAnsi = serializeAddon.serialize();
  const absoluteAnsi = `\x1b[${commandStartRow};${commandStartCol}H${relativeAnsi}`;
  process.stdout.write(absoluteAnsi);
}
```
## Mouse Input and Scrollback Integration

### The Mouse Tracking Limitation

**Critical Issue**: Enabling mouse tracking prevents native scrollback:

```typescript
// This enables mouse tracking but BLOCKS native scrollback
process.stdout.write('\x1b[?1000h'); // Mouse button reporting
process.stdout.write('\x1b[?1002h'); // Mouse movement reporting

// Now ALL mouse events come to app - terminal can't scroll history
// No way to "selectively" handle some scroll events
```

**Implications:**
- ❌ Cannot dynamically decide whether to handle wheel events
- ❌ Once mouse tracking is enabled, native scrollback is blocked
- ❌ No hybrid mouse handling - it's all-or-nothing

### Mouse Strategy Options

**Option 1: No Mouse Tracking (Preserve Native Scrollback)**
```typescript
// Don't enable mouse tracking
// User can scroll through native scrollback normally
// App has no scroll interaction capabilities
```

**Option 2: Full Mouse Tracking (App-Managed Scrolling)**
```typescript  
// Enable mouse tracking - app handles ALL scrolling
process.stdout.write('\x1b[?1000h');
// Must implement complete virtual scrollback
// Native scrollback becomes inaccessible
```

### Revised Architecture: Two Clear Modes

Based on ChatGPT's feedback, the architecture simplifies to two distinct approaches:

**Mode 1: Normal Screen + Append-Only**
```
┌─ Native Terminal Scrollback ─┐
│  [All historical content]    │  ← Fully accessible via terminal
│  [Shell prompts, commands]   │
│  [App content that scrolled] │
├─ Current Viewport ───────────┤  
│  [App-managed area]          │  ← Can update with absolute positioning
│  [Active content only]       │
└───────────────────────────────┘
```

**Mode 2: Alternate Screen + Full Virtual**
```
┌─ Virtual Buffer (App-Managed) ─┐
│  [All app content]             │  ← App provides scrolling
│  [Complete virtual scrollback] │
├─ Current Viewport ─────────────┤
│  [Visible slice]               │  ← Complete control
└─────────────────────────────────┘
```

**No Hybrid**: These modes are mutually exclusive. Choose based on application requirements.

### Resize Handling (SIGWINCH)

```typescript
handleTerminalResize(newCols: number, newRows: number) {
  // Adjust viewport dimensions
  this.terminalRows = newRows;
  this.terminalCols = newCols;
  
  // Recalculate transition point
  const availableRows = newRows - this.commandStartRow;
  if (this.bufferHeight > availableRows) {
    // Still in managed mode
    this.adjustVirtualViewport();
  }
  
  // Re-render current viewport
  this.render(this.currentDOMTree);
}
```
## Critical Architectural Insights

### Native Scrollback is Irrelevant for Mutable Content

Since **all content must remain editable**, native terminal scrollback cannot be relied upon:

```typescript
// Native scrollback = read-only history
// Once content scrolls out, it's immutable
// This is incompatible with DOM-like updates
```

**Key Insight**: The virtual buffer is **authoritative** - it's not a fallback, it's the primary content store.

### Absolute Positioning Within Viewport

Absolute positioning is safe and essential for efficient updates:

```typescript
// Position within viewport to update any visible content
process.stdout.write(`\x1b[${row};${col}H`); // Safe when row ∈ [1, terminalHeight]
process.stdout.write(updatedContent);
```

**Constraints:**
- ✅ Can position anywhere within current viewport
- ❌ Cannot position above viewport (row < 1)
- ❌ Cannot position below viewport (row > terminalHeight)
- ✅ Virtual buffer handles all content outside viewport

### Terminal Multiplexer Trade-offs

**Anchored Mode**: 
- ❌ `Ctrl-B [` only sees terminal's view (not full virtual buffer)
- ❌ Virtual scrollback content not accessible via tmux
- ✅ App can implement custom copy/search modes
- ✅ Terminal sees a naturally flowing command

**Managed Mode**:
- ❌ Alternate screen has no scrollback for tmux
- ✅ Complete application control
- ✅ Can implement any interaction model

**Key Point**: The virtual buffer is application-owned, so terminal multiplexers cannot access the full content. This is a fundamental trade-off of maintaining mutable content.
## Complete Algorithm

### Initialization

```typescript
class TTYOMRenderer {
  private virtualBuffer: Buffer;  // Authoritative content store
  private serializeAddon: SerializeAddon;
  private mode: 'anchored' | 'managed' = 'anchored';
  private viewport: ViewportWindow;
  
  async initialize() {
    // 1. Create unbounded virtual buffer (all content lives here)
    this.virtualBuffer = new Buffer(true, {
      scrollback: Number.MAX_SAFE_INTEGER // Effectively unlimited
    }, bufferService);
    
    // 2. Initialize viewport window
    this.viewport = {
      scrollOffset: 0,
      height: process.stdout.rows,
      width: process.stdout.columns
    };
    
    // 3. Setup SerializeAddon for ANSI generation
    this.serializeAddon = new SerializeAddon();
    
    // 4. Start in anchored mode (normal screen)
    this.mode = 'anchored';
  }
}
```

### Unified Render Pipeline

```typescript
render(domTree: Element) {
  // 1. ALWAYS update virtual buffer first (authoritative store)
  this.updateVirtualBuffer(domTree);
  
  // 2. Calculate viewport slice
  const viewportRange = {
    start: { y: this.viewport.scrollOffset, x: 0 },
    end: { y: this.viewport.scrollOffset + this.viewport.height, x: this.viewport.width }
  };
  
  // 3. Generate ANSI for visible slice only
  const viewportAnsi = this.serializeAddon.serialize(viewportRange);
  
  // 4. Render based on current mode
  if (this.mode === 'anchored') {
    this.renderAnchored(viewportAnsi);
  } else {
    this.renderManaged(viewportAnsi);
  }
}

renderAnchored(ansi: string) {
  // Position to appropriate viewport location
  const viewportTop = this.calculateViewportTop();
  process.stdout.write(`\x1b[${viewportTop};1H`);
  process.stdout.write(ansi);
}

renderManaged(ansi: string) {
  // In alternate screen, always start from top
  process.stdout.write('\x1b[1;1H');
  process.stdout.write(ansi);
}
```

### Auto-Promotion Logic

```typescript
handleContentGrowth(newHeight: number) {
  if (newHeight > this.viewport.height && this.mode === 'anchored') {
    // Content exceeds viewport - enable virtual scrolling
    // but STAY in anchored mode (normal screen)
    this.enableVirtualScrolling();
    
    // Adjust viewport to show bottom of content (like terminal would)
    this.viewport.scrollOffset = Math.max(0, newHeight - this.viewport.height);
  }
}

handleExplicitFullscreen() {
  // Only switch to alternate screen on explicit request
  if (this.mode === 'anchored') {
    process.stdout.write('\x1b[?1049h'); // Enter alternate screen
    process.stdout.write('\x1b[2J\x1b[H'); // Clear and home
    this.mode = 'managed';
    this.render(this.currentDOM);
  }
}
## Comparison to Other Approaches

| Approach | Pros | Cons |
|----------|------|------|
| **Traditional CLI Tools** | Simple append-only; native scrollback | Cannot update content; no interactivity |
| **ncurses/blessed** | Full screen control | Immediate alt-screen takeover; no gradual growth |
| **Native Scrollback Reliance** | Terminal handles history | Content becomes immutable when scrolled |
| **TTYOM Virtual Buffer** | **All content mutable; natural growth** | **Must implement own scrollback; tmux limitations** |

### Key Innovation

TTYOM's **fully virtual scrollback model** provides:

1. **Complete Content Ownership**: Application controls all content history
2. **Natural Growth Pattern**: Start small, grow beyond viewport automatically
3. **Anchored Mode Default**: Stay on normal screen unless fullscreen requested
4. **Unified Rendering Model**: Same virtual buffer approach in both modes
5. **Browser-Like Scrolling**: Scroll through virtual content, not terminal history

This architecture acknowledges that **mutable content is incompatible with native scrollback**, and embraces a fully virtual model as the primary solution.
## Implementation Considerations

### Memory Management
- **Virtual buffer growth**: xterm.js buffers can grow large; implement pruning for very long sessions
- **Viewport slicing**: Only serialize visible portions in managed mode
- **Buffer reuse**: Reuse existing buffer cells when possible

### Performance Optimization  
- **Delta rendering**: SerializeAddon naturally generates minimal ANSI
- **Viewport culling**: Skip rendering for off-screen content
- **Input batching**: Batch multiple DOM updates before rendering

### Scrolling Implementation

All scrolling operates on the virtual buffer, not terminal scrollback:

```typescript
class VirtualScrollManager {
  scroll(delta: number) {
    // Update viewport offset within virtual buffer bounds
    const maxOffset = Math.max(0, this.virtualBuffer.length - this.viewport.height);
    this.viewport.scrollOffset = Math.max(0, 
      Math.min(maxOffset, this.viewport.scrollOffset + delta));
    
    // Re-render viewport slice
    this.render();
  }
  
  scrollToTop() {
    this.viewport.scrollOffset = 0;
    this.render();
  }
  
  scrollToBottom() {
    this.viewport.scrollOffset = Math.max(0, 
      this.virtualBuffer.length - this.viewport.height);
    this.render();
  }
}
```

### Content Updates in Virtual Buffer

Since all content remains mutable, updates happen in the virtual buffer first:

```typescript
updateContent(elementId: string, newContent: string) {
  // 1. Find element's position in virtual buffer
  const position = this.findElementInVirtualBuffer(elementId);
  
  // 2. Update virtual buffer cells
  this.virtualBuffer.updateRange(position, newContent);
  
  // 3. If position is within current viewport, re-render
  if (this.isPositionInViewport(position)) {
    this.render();
  }
  // If not in viewport, changes are stored and will appear when scrolled to
}
```

### Unicode and Wide Characters
- **Use xterm.js cell width handling**: Built-in support for CJK characters
- **Leverage Intl.Segmenter**: For proper grapheme cluster handling in DOM content
- **Bun.stringWidth**: For accurate width calculations

### Testing Strategy
- **Deterministic buffer snapshots**: Export virtual buffer state for testing
- **ANSI output validation**: Compare generated ANSI sequences
- **Integration tests**: Test flow → managed transitions
- **Cross-platform testing**: Verify cursor position detection across terminals

---

## Summary

This design provides a **fully virtual scrollback model** with two rendering modes:

**Anchored Mode (Default)**: 
- ✅ Stays on normal screen, natural command flow
- ✅ Content grows beyond viewport automatically
- ✅ All content remains mutable in virtual buffer
- ✅ Scrolling operates on virtual buffer
- ❌ Terminal multiplexers see only viewport slice

**Managed Mode (Explicit Request)**:
- ✅ Enters alternate screen only on `requestFullscreen()`
- ✅ Full screen control without terminal chrome
- ✅ Same virtual buffer model as anchored mode
- ✅ Can return to anchored mode when done
- ❌ No terminal scrollback integration at all

**Key Architectural Decisions**:

1. **Virtual Buffer is Authoritative**: Not a fallback - it's the primary content store
2. **Native Scrollback Ignored**: Since content must be mutable, native scrollback is irrelevant
3. **Auto-Promotion**: Content exceeding viewport stays in anchored mode, just scrolls virtually
4. **Explicit Fullscreen**: Alternate screen only on explicit API call, not automatic
5. **Unified Model**: Same virtual buffer approach in both modes

This design enables **browser-like infinite documents** in the terminal while maintaining the ability to update any content at any time, trading native scrollback for complete mutability.
