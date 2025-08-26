# TermDOM Design Document: HTML-to-Terminal Renderer

## HTML in the Terminal!

**TermDOM** is the world's first HTML-to-Terminal renderer. Write familiar
HTML/CSS and get beautiful ANSI terminal output with proper layout, styling,
and interaction.

```typescript
// Just write HTML/CSS like web development!
const termDOM = new TermDOM();
const document = termDOM.document;
const div = document.createElement('div');
div.style.backgroundColor = 'blue';
div.style.color = 'white';
div.style.padding = '2';
div.textContent = 'Hello Terminal!';
document.body.appendChild(div);
```

## The Big Idea: "Your Terminal is Now a Browser"

**HTML + CSS + Yoga Layout → ANSI Terminal Output**

TermDOM treats the terminal like a browser:
- **Document**: Standard `HTMLDocument` from JSDOM
- **Elements**: Regular `div`, `span`, `table`, `input`, `button` elements
- **Styling**: CSS properties via `element.style`
- **Layout**: Yoga flexbox engine computes positions
- **Rendering**: XTerm.js converts to ANSI escape sequences

## Revolutionary Value Proposition

### For Web Developers
- ✅ **Familiar APIs**: `document.createElement('div')`
- ✅ **CSS Styling**: `background-color`, `padding`, `margin`, `display: flex`
- ✅ **Standard Events**: `addEventListener('click')`, mouse/keyboard handling
- ✅ **Layout APIs**: `getBoundingClientRect()`, `offsetWidth`, etc.

### For Terminal UIs
- ✅ **Rich Elements**: `<table>`, `<form>`, `<input>`, `<button>` all work
- ✅ **Proper Layout**: Yoga flexbox for complex layouts
- ✅ **Beautiful Output**: ANSI colors, styling, and formatting
- ✅ **Interactive**: Full mouse and keyboard support

## HTML Element Support Matrix

### ✅ Tier 1: Core Elements (Working Now)
- `<div>`, `<span>`, `<p>` - Layout containers with styling
- `<h1>`-`<h6>` - Headers (styled with font-weight)
- `<strong>`, `<em>`, `<b>`, `<i>` - Text formatting
- `<br>` - Line breaks

### 🎯 Tier 2: Layout & Structure (High Priority)
- `<section>`, `<article>`, `<header>`, `<footer>`, `<main>`, `<nav>` - Semantic layout
- `<ul>`, `<ol>`, `<li>` - Lists perfect for terminal menus
- `<table>`, `<tr>`, `<td>`, `<th>` - Tabular data (excellent terminal fit)
- `<pre>`, `<code>` - Code blocks with proper formatting

### 🚀 Tier 3: Interactive Elements (Game Changers)
- `<button>` - Clickable buttons with focus states
- `<input type="text">` - Text input fields
- `<input type="password">` - Hidden input
- `<select>`, `<option>` - Dropdown menus
- `<textarea>` - Multi-line text input
- `<progress>` - Progress bars (perfect for CLIs!)
- `<form>` - Form handling and validation

### 🤔 Tier 4: Advanced Features (Future)
- `<img>` - sixel support?
- `<canvas>` - Terminal-based drawing/charts
- `<audio>`, `<video>` - Metadata display or system integration
- `<svg>`

## CSS Properties Support

### Layout Properties
- `display`: `flex`, `block`, `inline`, `inline-block`, `none`
- `flex-direction`, `justify-content`, `align-items`
- `width`, `height`, `min-width`, `max-width`, `min-height`, `max-height`
- `margin`, `padding` (shorthand and individual)

### Visual Properties
- `color`, `background-color` - Full ANSI color support
- `font-weight` (bold), `font-style` (italic)
- `text-decoration` (underline), `text-align`
- `border` (basic terminal borders)

### Text Properties
- `white-space`: `normal`, `nowrap`, `pre`
- `word-wrap`: `normal`, `break-word`
- `overflow`: `visible`, `hidden` (scroll coming later)

## Layout Architecture & Design Decisions

### **Fundamental Layout Philosophy**

TermDOM uses a **hybrid layout system** that combines the power of Yoga's
flexbox engine with custom inline layout algorithms, designed specifically for
terminal constraints and single-pass efficiency.

#### **Key Design Principles:**
1. **Single-Pass Layout** - Avoids iterative settlement like browsers
2. **Clear Separation** - Block layout (Yoga) vs Inline layout (custom)
3. **Deferred Computation** - Layout only computed when needed
4. **Efficient Invalidation** - Smart dirty tracking with MutationObserver

### **Layout System Architecture**

#### **Block Layout Elements** (Yoga-powered)
Elements that get Yoga nodes and participate in flexbox/block layout:
- `display: block` - div, p, h1-h6, button (by default)
- `display: flex` - Explicit flexbox containers
- `display: inline-block` - **NO** (handled by inline system)

**Implementation Note:** `display: block` is implemented as **flexbox with specific defaults**:
```typescript
// Block display is syntactic sugar for flex column + stretch
if (display === 'block') {
  node.setDisplay(yoga.DISPLAY_FLEX);
  node.setFlexDirection(yoga.FLEX_DIRECTION_COLUMN);  // Stack children vertically
  node.setAlignItems(yoga.ALIGN_STRETCH);             // Children stretch to full width
} else if (display === 'flex') {
  node.setDisplay(yoga.DISPLAY_FLEX);
  // Use explicit flex-direction, align-items from CSS
}
```

This means **all layout is actually flexbox** - there's no separate "block" layout engine. Traditional block behavior emerges naturally from `flex-direction: column` + `align-items: stretch`.

**Yoga Responsibilities:**
- Flexbox layout computation (justify-content, align-items, etc.)
- Block positioning and sizing
- Margin/padding application
- Width/height constraint resolution

#### **Inline Layout Elements** (Custom algorithm)
Elements handled by parent's inline layout system:
- `display: inline` - span, a, strong, em, b, i, code
- `display: inline-block` - **YES** (sized independently, flow inline)

**Inline Layout Responsibilities:**
- Text flow and wrapping
- Inline-block intrinsic sizing
- Multi-line element positioning (ELEMENT_RECTS)
- Character-level positioning

### **Inline-Block Sizing Algorithm**

**Critical Constraint:** Inline-block elements must size themselves in **single pass** without parent interaction.

```typescript
function measureInlineBlock(element: HTMLElement): {width: number, height: number} {
  const style = getComputedStyle(element);

  // Width calculation
  let width: number;
  if (style.width && style.width !== 'auto') {
    width = parseFloat(style.width);
  } else {
    width = element.textContent?.length || 0; // Intrinsic width
  }

  // Height calculation
  let height: number;
  if (style.height && style.height !== 'auto') {
    height = parseFloat(style.height);
  } else if (width && style.width !== 'auto') {
    // Fixed width → calculate wrapped height
    height = calculateWrappedTextHeight(element.textContent, width);
  } else {
    height = 1; // Default single line for terminals
  }

  // Apply min/max constraints
  if (style.minWidth) width = Math.max(width, parseFloat(style.minWidth));
  if (style.maxWidth) width = Math.min(width, parseFloat(style.maxWidth));
  if (style.minHeight) height = Math.max(height, parseFloat(style.minHeight));
  if (style.maxHeight) height = Math.min(height, parseFloat(style.maxHeight));

  return { width, height };
}
```

**Why This Works:**
- **No circular dependencies** - Element size independent of parent constraints
- **Deterministic** - Same inputs always produce same output
- **Composable** - Parent uses result as fixed rectangle in flow
- **Terminal-appropriate** - Height defaults to 1 for TUI context

### **Multi-Rectangle Elements**
#### **ELEMENT_BOUNDS vs ELEMENT_RECTS**
- `ELEMENT_BOUNDS` - Single bounding rectangle (for all elements)
- `ELEMENT_RECTS` - Array of rectangles (for multi-line inline elements)

#### **DOM API Behavior**
```typescript
// Multi-line inline span
element.getBoundingClientRect() // → Single bounding box encompassing all rects
element.getClientRects()        // → DOMRectList with multiple rects

// Hit testing
document.elementFromPoint(x, y)  // → Uses getClientRects() for accuracy
```

#### **Use Cases**
```html
<span>This text wraps across multiple lines in the container</span>
<!-- Results in ELEMENT_RECTS = [rect1, rect2, rect3] for each line -->
```

### **Layout Invalidation System**

TermDOM implements **browser-like deferred layout** with smart invalidation:

#### **Invalidation Triggers**
1. **Style Changes** - `element.style.setProperty()` mutations
2. **DOM Structure Changes** - `appendChild()`, `removeChild()` mutations
3. **Text Content Changes** - `textContent` modifications

#### **Smart Invalidation Algorithm**
```typescript
const processPendingMutations = (): void => {
  const mutations = observer.takeRecords();
  if (mutations.length === 0) return;

  for (const mutation of mutations) {
    const targetElement = mutation.target as HTMLElement;

    if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
      // Style change - only affects this specific element
      // No inherited layout properties in TUI context
      markDirtySingle(targetElement);
    } else if (mutation.type === 'childList') {
      // DOM structure change - affects parent's layout
      markDirtyWithBubbling(targetElement);
    }
  }
};
```

#### **Layout Computation Triggers**
Layout is **only computed when needed**:
```typescript
// These DOM APIs trigger layout computation:
element.getBoundingClientRect()
element.getClientRects()
element.offsetWidth / offsetHeight / offsetLeft / offsetTop
element.clientWidth / clientHeight
document.elementFromPoint(x, y)

// Rendering also triggers layout:
document.render() // → calls computeLayoutIfNeeded()
```

#### **Efficient Dirty Tracking**
- **Block elements** - Delete YOGA_NODE to mark dirty, rebuild Yoga tree
- **Inline elements** - Mark parent container dirty, recompute inline layout
- **Batched processing** - Multiple mutations processed together
- **Minimal recomputation** - Only dirty subtrees recalculated

### **Layout vs Rendering Separation**

**Layout Phase:**
- Computes element positions and sizes
- Sets `ELEMENT_BOUNDS` and `ELEMENT_RECTS` properties
- Happens on-demand when layout APIs called

**Rendering Phase:**
- Uses computed bounds to generate ANSI output
- No layout computation during rendering
- Throws error if bounds not available

### **Memory Management**

#### **Symbol Properties**
Private layout data stored in Symbol properties (following HappyDOM pattern):
```typescript
const ELEMENT_BOUNDS = Symbol('elementBounds'); // Single bounding rect
const ELEMENT_RECTS = Symbol('elementRects');   // Multiple rects for inline
const YOGA_NODE = Symbol('yogaNode');           // Yoga layout node
```

#### **Lifecycle**
- **Creation** - Symbols attached during layout computation
- **Updates** - Invalidation clears symbols, recomputation sets new values
- **Cleanup** - Automatic garbage collection when elements removed

### **Why Not Full Browser Layout?**

**Browser Complexity We Avoid:**
- ❌ **Iterative settlement** - Multiple layout passes until convergence
- ❌ **Percentage constraints in inline context** - Circular dependencies
- ❌ **Complex typography** - Baseline alignment, line-height calculations
- ❌ **CSS Grid** - Two-dimensional layout complexity
- ❌ **Transforms** - Matrix calculations and stacking contexts

**TTYOM's Terminal-Focused Simplifications:**
- ✅ **Single-pass layout** - Deterministic, efficient computation
- ✅ **Character-based sizing** - Natural terminal metrics
- ✅ **Simple inline flow** - Left-to-right, top-to-bottom only
- ✅ **Flexbox subset** - Most useful layout features for TUIs
- ✅ **Predictable defaults** - Height=1 for inline-block, etc.

This architecture provides **80% of browser layout power** with **20% of the complexity**, perfectly suited for terminal user interfaces.

## 🚀 Revolutionary Architecture: HTML → Terminal Pipeline

**BREAKTHROUGH**: TermDOM uses XTerm.js components for optimal terminal rendering!

```
┌─────────────────────────────────────────────────────┐
│                HTML/CSS Input                       │
│  document.createElement('div')                      │
│  element.style.setProperty('color', 'blue')         │
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│              JSDOM Layer                            │
│  ┌─────────────────┐  ┌─────────────────────────────┐
│  │ HTMLDocument    │  │    HTML Elements            │
│  │ (DOM Tree)      │  │  (div, span, table, etc)    │
│  └─────────────────┘  └─────────────────────────────┘
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│              Layout Layer                           │
│  ┌─────────────────┐  ┌─────────────────────────────┐
│  │ Symbol Props    │  │     Yoga Engine             │
│  │ (YOGA_BOUNDS,   │  │   (Flexbox Layout)          │
│  │  YOGA_NODE)     │  │                             │
│  └─────────────────┘  └─────────────────────────────┘
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│          🚀 Raw xterm.js Buffer Layer               │
│  ┌─────────────────┐  ┌─────────────────────────────┐
│  │ Buffer/CellData │  │    Delta Diffing            │
│  │ (Character      │  │  (Changed cells only)       │
│  │  Grid State)    │  │                             │
│  └─────────────────┘  └─────────────────────────────┘
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│         🎭 SerializeAddon Magic Layer               │
│  ┌─────────────────┐  ┌─────────────────────────────┐
│  │ ANSI Generation │  │    Cursor Optimization      │
│  │ (Colors, SGR,   │  │  (\x1b[nC positioning)      │
│  │  Styling)       │  │                             │
│  └─────────────────┘  └─────────────────────────────┘
└─────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────┐
│                Terminal Output                      │
│  ✨ PERFECT ANSI escape sequences with:             │
│  • Optimal cursor movement • Battle-tested colors   │
│  • Delta-only updates     • Unicode perfection      │
│  • Terminal compatibility • Zero manual ANSI!       │
└─────────────────────────────────────────────────────┘
```

**Key Innovation**: We bypass manual ANSI generation entirely by:
1. **Converting DOM → Raw xterm Buffer cells**
2. **Using SerializeAddon for perfect ANSI output**
3. **Getting years of terminal compatibility FOR FREE**

### With TermDOM
```typescript
// HTML-to-Terminal - use what you know!
const div = document.createElement("div");
div.style.width = "50%";
div.style.backgroundColor = "blue";
div.style.color, "white";
document.body.appendChild(div);
```

TermDOM brings **25+ years of web development knowledge** directly to the
terminal. No new APIs to learn, no custom element abstractions - just HTML,
CSS, and JavaScript running in your terminal with beautiful ANSI output.
