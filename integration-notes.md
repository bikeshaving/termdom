# TermDOM Scrollback Integration Notes

## Current Status

We've successfully designed and documented a clean scrollback architecture in `scrollback.md`. The mathematical model is solid and the cursor position detection spike is working. Now we need to integrate this into the existing TermDOM implementation.

## Key Accomplishments Today

### ✅ Scrollback Architecture Design
- **Clean mathematical model**: `renderStartRow = Math.max(0, commandStart - (contentHeight - commandHeight))`
- **Simple buffer approach**: Always terminal-sized viewport, no complex virtual buffers
- **Linear rendering**: Fill buffer sequentially from calculated start row, position to `\x1b[1;1H`, output ANSI
- **Natural scrolling**: Let terminal handle scrolling via newlines in ANSI output

### ✅ Cursor Position Detection
- **Working spike**: `spike-cursor-position.ts` successfully detects cursor position using `\x1b[6n`
- **Proper TTY handling**: Works correctly in real terminal environments
- **Coordinate understanding**: `commandStart = 2` for fresh command (after shell prompt)

### ✅ ANSI Generation Fixes
- **Line resets**: `\x1b[0m` at end of each line for truncation robustness
- **Idiomatic cursor movement**: Use `\r\n` instead of complex positioning
- **Error handling**: Throw on up/left movements that shouldn't happen in row-major processing

## Integration Points Identified

### Current TermDOM Rendering Flow
```typescript
// In TermDOM.render() - lines 252-286
render() {
  this.renderer.beginFrame();
  this.renderElement(this.document.documentElement, 0, 0);  // <-- coordinates start from DOM layout
  const ansiOutput = this.renderer.render();
  this.process.stdout.write(ansiOutput);
}
```

### Required Changes

1. **Add cursor position detection** in constructor or before first render
2. **Calculate content height** from DOM layout engine  
3. **Apply coordinate transformation** in `renderElement()` to offset by `renderStartRow`
4. **Position cursor** to `\x1b[1;1H` before outputting ANSI

## Next Steps for Integration

### 1. Extend TermDOM Constructor
```typescript
constructor(options: TermDOMOptions = {}) {
  // ... existing initialization ...
  
  // Get initial cursor position for commandStart
  this.commandStart = await this.getCursorPosition();
  this.commandHeight = this.height - this.commandStart;
}
```

### 2. Add Content Height Calculation
```typescript
private calculateContentHeight(): number {
  // Use layout engine to determine total DOM content height
  // This drives the renderStartRow calculation
}
```

### 3. Transform Rendering Coordinates
```typescript
private renderElement(element: Element, x: number, y: number): void {
  // Current code uses layout coordinates directly
  // Need to offset by renderStartRow:
  
  const adjustedY = y - this.renderStartRow;
  this.renderer.setText(x + bounds.left, adjustedY + bounds.top, text, style);
}
```

### 4. Position Cursor Before Output
```typescript
render() {
  // ... layout and buffer population ...
  
  const ansiOutput = this.renderer.render();
  // Position to top-left, then output ANSI
  this.process.stdout.write('\x1b[1;1H' + ansiOutput);
}
```

## Implementation Notes

### Coordinate System
- **DOM Layout**: Uses absolute coordinates from layout engine (0,0 at document origin)
- **Buffer Coordinates**: Terminal viewport coordinates (0,0 at buffer top-left)  
- **Transformation**: `bufferY = domY - renderStartRow`

### Async Considerations
- Cursor position detection is async (uses `\x1b[6n` escape sequence)
- May need to make constructor async or defer rendering until position is known
- Could cache `commandStart` after first detection

### Performance
- Cursor position only needs to be detected once at startup
- Content height calculation happens on every render (layout already computes this)
- Coordinate transformation is just arithmetic (very fast)

## Questions for Tomorrow

1. **Async constructor**: How to handle cursor position detection in constructor?
2. **Content height**: Does layout engine already provide total content height?
3. **Coordinate bounds**: What happens when `renderStartRow` makes coordinates negative?
4. **Testing**: How to test this without full terminal integration?

## File Status

- ✅ `scrollback.md` - Complete architecture documentation
- ✅ `spike-cursor-position.ts` - Working cursor detection
- ✅ `src/rendering/Renderer.ts` - ANSI generation fixes complete
- 🚧 `src/core/TermDOM.ts` - Ready for scrollback integration
- ⏳ Integration work - Next priority

## Foundation Quality

The scrollback architecture is built on solid foundations:
- **Mathematical precision**: Clear formulas and invariants
- **Simple implementation**: No complex state machines or modes  
- **Terminal compatibility**: Works with natural terminal behavior
- **Proven components**: Cursor detection and ANSI generation both tested

Ready to integrate when we continue!