# Terminal Object Model (TOM) Design Document

## Overview

The Terminal Object Model (TOM) is a revolutionary framework that brings the familiar DOM API to terminal user interfaces. By leveraging HappyDOM for tree structure and events, combined with custom terminal-specific rendering, TOM enables web developers to build rich CLI applications using the same patterns they already know.

## The Big Idea

**HappyDOM + Custom Terminal Rendering = Universal DOM**

TOM separates the DOM tree structure (handled by HappyDOM) from the rendering target (terminal via ScreenBuffers). This creates a universal UI framework where the same DOM manipulation code can target different output mediums:

```typescript
// Same DOM API, different renderers
const document = new TOMDocument();
const button = document.createElement('button');
button.textContent = 'Click me';
button.addEventListener('click', handler);
document.body.appendChild(button);

// Could render to:
// - Terminal (TOM)
// - Browser (standard DOM)
// - PDF, Images, VR, etc. (future renderers)
```

## Core Philosophy

### DOM-First Architecture
- **Familiar API**: Use querySelector, appendChild, addEventListener - same as web development
- **HappyDOM Foundation**: Mature DOM implementation providing tree structure, events, and queries
- **Custom Elements**: Terminal-specific elements (container, text, button) extending base Element class
- **Framework Agnostic**: Works with React, Vue, Crank, or vanilla JavaScript

### Automatic Reactivity
- **MutationObserver**: HappyDOM's built-in observer automatically triggers re-renders on DOM changes
- **Zero Manual Renders**: Any DOM manipulation (appendChild, style changes, etc.) automatically updates the terminal
- **Efficient Batching**: Multiple changes are batched into single render passes
- **Granular Updates**: Only re-render elements that actually changed

### Performance-First Design
- **ScreenBuffer Foundation**: Efficient rendering with compositing and clipping
- **Bun-Native Optimizations**: Leverages Bun's fast string processing and color utilities
- **Delta Rendering**: Only redraw screen regions that changed
- **Layout Engine**: Yoga provides fast flexbox layout calculations

### Terminal-Optimized Features
- **Semantic Elements**: `<container>`, `<text>`, `<button>` designed for terminal contexts
- **Simple Styling**: JavaScript objects instead of CSS strings
- **Rich Text**: Full ANSI color support, Unicode, and text formatting
- **Input Handling**: Mouse and keyboard events with proper focus management
- **Terminal Awareness**: Built-in terminal size detection and resize handling

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────┐
│                   Application Layer                 │
│  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │   Frameworks    │  │      Component Library     │ │
│  │ (React, Crank,  │  │   (Button, Input, Table,   │ │
│  │  Vue, Vanilla)  │  │    Menu, Modal, etc.)      │ │
│  └─────────────────┘  └─────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│                     TOM Layer                       │
│  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │   TOMDocument   │  │      TOM Elements          │ │
│  │  (Custom DOM)   │  │  (container, text, button) │ │
│  └─────────────────┘  └─────────────────────────────┘ │
│  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │   TOMRenderer   │  │      TOMStyleEngine        │ │
│  │  (Orchestrator) │  │   (Simple JS Objects)     │ │
│  └─────────────────┘  └─────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│                   Foundation Layer                  │
│  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │    HappyDOM     │  │     Yoga Layout            │ │
│  │ (Tree, Events,  │  │   (Flexbox Engine)         │ │
│  │  Observers)     │  │                            │ │
│  └─────────────────┘  └─────────────────────────────┘ │
│  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │  ScreenBuffer   │  │      Bun APIs              │ │
│  │  (Compositing)  │  │ (stringWidth, color, etc.) │ │
│  └─────────────────┘  └─────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│                   Platform Layer                    │
│  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │  Terminal I/O   │  │      ANSI Escape           │ │
│  │ (stdin/stdout)  │  │    (Colors, Cursor)        │ │
│  └─────────────────┘  └─────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### TOM Element Hierarchy

TOM uses custom elements that extend HappyDOM's base `Element` class, bypassing all HTML/CSS-specific behavior:

```typescript
import { Element } from 'happy-dom';

// Base TOM element - extends HappyDOM Element but NOT HTMLElement
abstract class TOMElement extends Element {
  private _tomStyle: TOMStyle = {};
  bounds: Rect = new Rect(0, 0, 0, 0);
  yogaNode: Yoga.Node;
  
  get style(): TOMStyle {
    return this._tomStyle;
  }
  
  set style(value: TOMStyle) {
    this._tomStyle = { ...value };
    this.scheduleRender();
  }
  
  // Each element renders itself
  abstract renderSelf(buffer: ScreenBuffer): void;
}

// Container elements get their own buffer for compositing
class TOMContainer extends TOMElement {
  private buffer: ScreenBuffer;
  
  renderSelf(buffer: ScreenBuffer): void {
    // Render background/border to own buffer
    this.renderBackground();
    
    // Children render to this container's buffer
    for (const child of this.children) {
      if (child instanceof TOMElement) {
        child.renderSelf(this.buffer);
      }
    }
    
    // Composite own buffer to parent
    buffer.composite(this.buffer, this.bounds.x, this.bounds.y);
  }
}

// Text elements render directly to parent buffer
class TOMText extends TOMElement {
  renderSelf(buffer: ScreenBuffer): void {
    const styled = BunTextUtils.styleText(this.textContent, this.style);
    buffer.put(this.bounds.x, this.bounds.y, styled);
  }
}

class TOMButton extends TOMContainer {
  renderSelf(buffer: ScreenBuffer): void {
    // Render button appearance
    this.renderButtonBackground();
    
    // Handle focus/hover states
    if (this.hasFocus) this.renderFocusOutline();
    
    // Render children (usually text)
    super.renderSelf(buffer);
  }
}
```

## Key Systems

### 1. TOMDocument (HappyDOM Integration)

```typescript
import { Window } from 'happy-dom';

class TOMDocument {
  private window: Window;
  private elementRegistry: Map<string, typeof TOMElement>;
  private renderer: TOMRenderer;
  private observer: MutationObserver;
  
  // Terminal size properties
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  
  constructor(output: NodeJS.WriteStream = process.stdout) {
    this.window = new Window();
    this.elementRegistry = new Map();
    this.renderer = new TOMRenderer(this);
    
    this.registerDefaultElements();
    this.setupCustomElementCreation();
    this.setupMutationObserver();
    this.setupTerminalSizeTracking(output);
  }
  
  private registerDefaultElements(): void {
    this.elementRegistry.set('container', TOMContainer);
    this.elementRegistry.set('text', TOMText);
    this.elementRegistry.set('button', TOMButton);
    this.elementRegistry.set('input', TOMInput);
  }
  
  private setupCustomElementCreation(): void {
    // Override createElement to use our registry
    this.window.document.createElement = (tagName: string) => {
      const ElementClass = this.elementRegistry.get(tagName);
      if (!ElementClass) {
        throw new Error(`Unknown element: ${tagName}`);
      }
      
      const element = new ElementClass();
      element.ownerDocument = this.window.document;
      element.tagName = tagName.toUpperCase();
      return element;
    };
  }
  
  private setupMutationObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      // Any DOM change triggers re-render
      this.renderer.scheduleRender();
    });
    
    this.observer.observe(this.window.document.body, {
      childList: true,        // appendChild/removeChild
      subtree: true,          // Nested changes
      attributes: true,       // Style changes
      characterData: true     // Text content changes
    });
  }
  
  // Expose familiar DOM APIs
  get body() { return this.window.document.body; }
  createElement = (tagName: string) => this.window.document.createElement(tagName);
  querySelector = this.window.document.querySelector.bind(this.window.document);
  getElementById = this.window.document.getElementById.bind(this.window.document);
  addEventListener = this.window.document.addEventListener.bind(this.window.document);
  
  render(): void {
    this.renderer.render();
  }
}
```

### 2. TOMRenderer (Orchestrator)

```typescript
class TOMRenderer {
  private document: TOMDocument;
  private rootBuffer: ScreenBuffer;
  private layoutEngine: LayoutEngine;
  private renderScheduled = false;
  
  constructor(document: TOMDocument) {
    this.document = document;
    this.rootBuffer = new ScreenBuffer(document.terminalWidth, document.terminalHeight);
    this.layoutEngine = new LayoutEngine();
    this.setupInputHandling();
  }
  
  scheduleRender(): void {
    if (this.renderScheduled) return;
    
    this.renderScheduled = true;
    
    // Batch renders using microtask queue
    queueMicrotask(() => {
      this.render();
      this.renderScheduled = false;
    });
  }
  
  render(): void {
    // 1. Layout pass - calculate positions/sizes
    this.layoutEngine.computeLayout(
      this.document.body, 
      this.document.terminalWidth, 
      this.document.terminalHeight
    );
    
    // 2. Clear and render
    this.rootBuffer.clear();
    this.renderElement(this.document.body, this.rootBuffer);
    
    // 3. Output to terminal
    this.rootBuffer.render();
  }
  
  private renderElement(element: Element, buffer: ScreenBuffer): void {
    if (element instanceof TOMElement) {
      element.renderSelf(buffer);
    }
    
    // Recursively render children
    for (const child of element.children) {
      this.renderElement(child, buffer);
    }
  }
  
  private setupInputHandling(): void {
    process.stdin.setRawMode(true);
    process.stdin.on('data', (data) => {
      const input = data.toString();
      
      if (this.isMouseInput(input)) {
        this.handleMouseInput(input);
      } else {
        this.handleKeyboardInput(input);
      }
    });
  }
  
  private handleMouseInput(input: string): void {
    const { x, y, button } = this.parseMouseInput(input);
    const targetElement = this.hitTest(x, y);
    
    if (targetElement) {
      const event = new MouseEvent('click', { clientX: x, clientY: y, button });
      targetElement.dispatchEvent(event);
    }
  }
  
  private hitTest(x: number, y: number): TOMElement | null {
    // Walk DOM tree to find element at coordinates
    return this.hitTestRecursive(this.document.body, x, y);
  }
}
```

### 3. Layout System (Yoga Integration)

```typescript
interface TOMStyle {
  // Display & Positioning
  display?: 'flex' | 'block' | 'inline' | 'none';
  position?: 'relative' | 'absolute' | 'fixed';
  
  // Flexbox
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around';
  alignItems?: 'stretch' | 'flex-start' | 'center' | 'flex-end';
  flex?: number;
  flexGrow?: number;
  flexShrink?: number;
  
  // Box Model
  width?: number | string;
  height?: number | string;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  
  margin?: [number, number, number, number] | number;
  padding?: [number, number, number, number] | number;
  border?: [number, number, number, number] | number;
  
  // Visual
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  
  // Text
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline';
  textAlign?: 'left' | 'center' | 'right';
  
  // Overflow
  overflow?: 'visible' | 'hidden' | 'scroll';
  overflowX?: 'visible' | 'hidden' | 'scroll';
  overflowY?: 'visible' | 'hidden' | 'scroll';
}

class LayoutEngine {
  static computeLayout(root: TOMNode, containerWidth: number, containerHeight: number): void {
    // 1. Apply styles to Yoga nodes
    this.applyStylesToYoga(root);
    
    // 2. Calculate layout
    root.yogaNode.calculateLayout(containerWidth, containerHeight);
    
    // 3. Extract computed values
    this.extractComputedLayout(root);
  }
  
  private static applyStylesToYoga(node: TOMNode): void {
    const yoga = node.yogaNode;
    const style = node.style;
    
    // Map TOM styles to Yoga properties
    if (style.display) yoga.setDisplay(this.mapDisplay(style.display));
    if (style.flexDirection) yoga.setFlexDirection(this.mapFlexDirection(style.flexDirection));
    if (style.width) yoga.setWidth(style.width);
    if (style.height) yoga.setHeight(style.height);
    // ... etc
    
    // Recursively apply to children
    for (const child of node.children) {
      this.applyStylesToYoga(child);
    }
  }
}
```

### 2. Event System

```typescript
// Event Types
interface TOMEventMap {
  'keydown': KeyboardEvent;
  'keyup': KeyboardEvent;
  'click': MouseEvent;
  'mousedown': MouseEvent;
  'mouseup': MouseEvent;
  'mousemove': MouseEvent;
  'wheel': WheelEvent;
  'focus': FocusEvent;
  'blur': FocusEvent;
  'resize': ResizeEvent;
  'scroll': ScrollEvent;
}

abstract class TOMEvent {
  type: string;
  target: TOMNode;
  currentTarget: TOMNode;
  bubbles: boolean = true;
  cancelable: boolean = true;
  defaultPrevented: boolean = false;
  stopPropagation: boolean = false;
  
  preventDefault(): void { this.defaultPrevented = true; }
  stopImmediatePropagation(): void { this.stopPropagation = true; }
}

class TOMEventManager {
  private root: TOMNode;
  private focusedElement: TOMNode | null = null;
  
  constructor(root: TOMNode) {
    this.root = root;
    this.setupInputCapture();
  }
  
  private setupInputCapture(): void {
    // Keyboard input
    process.stdin.setRawMode(true);
    process.stdin.on('data', this.handleInput.bind(this));
    
    // Mouse input (if supported)
    process.stdout.write('\x1b[?1003h'); // Enable mouse tracking
  }
  
  private handleInput(buffer: Buffer): void {
    const input = buffer.toString();
    
    if (this.isMouseInput(input)) {
      this.handleMouseInput(input);
    } else {
      this.handleKeyboardInput(input);
    }
  }
  
  private handleKeyboardInput(input: string): void {
    const event = new KeyboardEvent(this.parseKey(input));
    const target = this.focusedElement || this.root;
    target.dispatchEvent(event);
  }
  
  private handleMouseInput(input: string): void {
    const { x, y, button } = this.parseMouseInput(input);
    const target = this.hitTest(x, y);
    
    if (target) {
      const event = new MouseEvent(x, y, button);
      target.dispatchEvent(event);
    }
  }
  
  private hitTest(x: number, y: number): TOMNode | null {
    return this.hitTestRecursive(this.root, x, y);
  }
  
  private hitTestRecursive(node: TOMNode, x: number, y: number): TOMNode | null {
    if (!node.bounds.contains(x, y)) return null;
    
    // Check children first (front to back)
    for (const child of [...node.children].reverse()) {
      const hit = this.hitTestRecursive(child, x, y);
      if (hit) return hit;
    }
    
    return node;
  }
}
```

### 3. ScreenBuffer System

```typescript
interface Cell {
  char: string;
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

class ScreenBuffer {
  private cells: Cell[][];
  private lastFrame?: Cell[][];
  
  constructor(
    public width: number,
    public height: number,
    public x: number = 0,
    public y: number = 0
  ) {
    this.clear();
  }
  
  clear(): void {
    this.cells = Array(this.height).fill(null).map(() =>
      Array(this.width).fill(null).map(() => ({ char: ' ' }))
    );
  }
  
  put(x: number, y: number, text: string, style?: Partial<Cell>): void {
    // Handle clipping
    if (x < 0 || y < 0 || y >= this.height) return;
    
    // Apply text with proper width calculation
    const width = Bun.stringWidth(text);
    for (let i = 0; i < width && x + i < this.width; i++) {
      this.cells[y][x + i] = {
        char: text[i] || ' ',
        ...style
      };
    }
  }
  
  fill(bounds: Rect, char: string = ' ', style?: Partial<Cell>): void {
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
          this.cells[y][x] = { char, ...style };
        }
      }
    }
  }
  
  composite(source: ScreenBuffer, offsetX: number, offsetY: number): void {
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const targetX = offsetX + x;
        const targetY = offsetY + y;
        
        if (targetX >= 0 && targetX < this.width && targetY >= 0 && targetY < this.height) {
          const sourceCell = source.cells[y][x];
          if (sourceCell.char !== ' ' || sourceCell.bgColor) {
            this.cells[targetY][targetX] = { ...sourceCell };
          }
        }
      }
    }
  }
  
  render(): void {
    let output = '';
    
    for (let y = 0; y < this.height; y++) {
      // Move cursor to line start
      output += `\x1b[${this.y + y + 1};${this.x + 1}H`;
      
      let currentStyle: Partial<Cell> = {};
      
      for (let x = 0; x < this.width; x++) {
        const cell = this.cells[y][x];
        
        // Apply style changes
        if (this.styleChanged(currentStyle, cell)) {
          output += this.generateStyleSequence(cell);
          currentStyle = { ...cell };
        }
        
        output += cell.char;
      }
      
      // Reset styles at end of line
      output += '\x1b[0m';
    }
    
    process.stdout.write(output);
    this.lastFrame = this.copyFrame(this.cells);
  }
  
  renderDelta(): void {
    if (!this.lastFrame) {
      this.render();
      return;
    }
    
    let output = '';
    
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const current = this.cells[y][x];
        const last = this.lastFrame[y][x];
        
        if (!this.cellsEqual(current, last)) {
          output += `\x1b[${this.y + y + 1};${this.x + x + 1}H`;
          output += this.generateStyleSequence(current);
          output += current.char;
        }
      }
    }
    
    if (output) {
      output += '\x1b[0m'; // Reset
      process.stdout.write(output);
    }
    
    this.lastFrame = this.copyFrame(this.cells);
  }
  
  private generateStyleSequence(cell: Cell): string {
    let sequence = '';
    
    if (cell.fgColor) {
      sequence += Bun.color(cell.fgColor, 'ansi');
    }
    if (cell.bgColor) {
      sequence += Bun.color(cell.bgColor, 'ansi')?.replace('38', '48');
    }
    if (cell.bold) sequence += '\x1b[1m';
    if (cell.italic) sequence += '\x1b[3m';
    if (cell.underline) sequence += '\x1b[4m';
    
    return sequence;
  }
}
```

### 4. Bun Integration

```typescript
class BunTextUtils {
  static measureText(text: string, style: TOMStyle): { width: number; height: number } {
    // Use Bun's fast string width calculation
    const width = Bun.stringWidth(text);
    
    // Handle line wrapping if needed
    if (style.wordWrap && style.maxWidth) {
      const lines = this.wrapText(text, style.maxWidth);
      return { width: Math.max(...lines.map(line => Bun.stringWidth(line))), height: lines.length };
    }
    
    return { width, height: 1 };
  }
  
  static styleText(text: string, style: TOMStyle): string {
    let result = text;
    let ansiCodes = '';
    
    if (style.color) {
      ansiCodes += Bun.color(style.color, 'ansi') || '';
    }
    if (style.backgroundColor) {
      ansiCodes += Bun.color(style.backgroundColor, 'ansi')?.replace('38', '48') || '';
    }
    if (style.fontWeight === 'bold') {
      ansiCodes += '\x1b[1m';
    }
    if (style.fontStyle === 'italic') {
      ansiCodes += '\x1b[3m';
    }
    if (style.textDecoration === 'underline') {
      ansiCodes += '\x1b[4m';
    }
    
    return ansiCodes + result + '\x1b[0m';
  }
  
  static wrapText(text: string, maxWidth: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine + (currentLine ? ' ' : '') + word;
      
      if (Bun.stringWidth(testLine) <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    
    if (currentLine) lines.push(currentLine);
    return lines;
  }
}
```

## Usage Examples

### Standalone Usage (Vanilla DOM API)

```typescript
import { TOMDocument } from 'tom';

// Create a TOM document  
const document = new TOMDocument(process.stdout);

// Use familiar DOM APIs
const container = document.createElement('container');
container.style = {
  display: 'flex',
  flexDirection: 'column', 
  padding: 2,
  backgroundColor: '#1a1a1a'
};

const title = document.createElement('text');
title.textContent = 'Terminal Object Model Demo';
title.style = {
  color: 'blue',
  fontWeight: 'bold',
  fontSize: '2em'
};

const button = document.createElement('button');
button.textContent = 'Click me!';
button.style = {
  backgroundColor: 'green',
  color: 'white',
  padding: 1,
  marginTop: 1
};

button.addEventListener('click', () => {
  button.textContent = 'Clicked!';
  button.style.backgroundColor = 'red';
  // Changes automatically trigger re-render via MutationObserver!
});

// Build the tree using DOM APIs
container.appendChild(title);
container.appendChild(button);
document.body.appendChild(container);

// Auto-renders on DOM changes, but you can force render
document.render();
```

### DOM Query Examples

```typescript
// All familiar DOM query methods work
const buttons = document.querySelectorAll('button');
const firstContainer = document.querySelector('container');
const titleElement = document.getElementById('title');

// Tree traversal
for (let child = container.firstChild; child; child = child.nextSibling) {
  console.log(child.tagName);
}

// Event delegation
document.addEventListener('click', (event) => {
  if (event.target.tagName === 'BUTTON') {
    console.log('Button clicked via delegation!');
  }
});

// Dynamic manipulation
function addButton(text: string) {
  const button = document.createElement('button');
  button.textContent = text;
  button.className = 'dynamic-button';
  container.appendChild(button); // Auto re-renders!
}

// Class-based styling
const dynamicButtons = document.querySelectorAll('.dynamic-button');
dynamicButtons.forEach(btn => {
  btn.style.color = 'yellow';
});
```

### Framework Integration

TOM provides renderer adapters for popular frameworks:

```typescript
// Crank.js Renderer
class CrankTOMRenderer {
  createElement(tag: string): TOMNode {
    switch (tag) {
      case 'container': return new TOMContainer();
      case 'text': return new TOMText();
      case 'button': return new TOMButton();
      default: throw new Error(`Unknown element: ${tag}`);
    }
  }
  
  // ... other RenderAdapter methods
}

// React Renderer  
class ReactTOMRenderer {
  // Implement React reconciler interface
}

// Vue Renderer
class VueTOMRenderer {
  // Implement Vue renderer interface
}
```

### Usage with JSX (any framework)

```jsx
// With Crank
function CrankApp() {
  const [count, setCount] = useState(0);
  
  return (
    <container style={{ display: 'flex', padding: 2 }}>
      <text style={{ color: 'blue' }}>Count: {count}</text>
      <button onClick={() => setCount(count + 1)}>+</button>
    </container>
  );
}

// With React (hypothetical)
function ReactApp() {
  const [count, setCount] = React.useState(0);
  
  return (
    <TOMContainer style={{ display: 'flex', padding: 2 }}>
      <TOMText style={{ color: 'blue' }}>Count: {count}</TOMText>
      <TOMButton onClick={() => setCount(count + 1)}>+</TOMButton>
    </TOMContainer>
  );
}
```

## Component Library

### Built-in Components

```typescript
// Basic Components
class TOMText extends TOMNode {
  content: string = '';
  
  render(buffer: ScreenBuffer): void {
    const styled = BunTextUtils.styleText(this.content, this.style);
    const lines = this.content.split('\n');
    
    for (let i = 0; i < lines.length && i < this.bounds.height; i++) {
      buffer.put(this.bounds.x, this.bounds.y + i, lines[i], {
        fgColor: this.style.color,
        bgColor: this.style.backgroundColor,
        bold: this.style.fontWeight === 'bold',
        italic: this.style.fontStyle === 'italic',
        underline: this.style.textDecoration === 'underline'
      });
    }
  }
}

class TOMButton extends TOMContainer {
  private pressed: boolean = false;
  
  constructor() {
    super();
    
    this.addEventListener('mousedown', () => {
      this.pressed = true;
      this.render();
    });
    
    this.addEventListener('mouseup', () => {
      this.pressed = false;
      this.render();
    });
    
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        this.dispatchEvent(new MouseEvent(0, 0, 0)); // Simulate click
      }
    });
  }
  
  render(parentBuffer?: ScreenBuffer): void {
    // Apply pressed state styling
    const buttonStyle = {
      ...this.style,
      backgroundColor: this.pressed 
        ? this.darkenColor(this.style.backgroundColor || 'gray')
        : this.style.backgroundColor || 'gray'
    };
    
    // Render with button styling
    this.renderBackground(buttonStyle);
    super.render(parentBuffer);
  }
}

class TOMInput extends TOMContainer {
  private cursor: number = 0;
  private value: string = '';
  private focused: boolean = false;
  
  constructor() {
    super();
    
    this.addEventListener('focus', () => {
      this.focused = true;
      this.render();
    });
    
    this.addEventListener('blur', () => {
      this.focused = false;
      this.render();
    });
    
    this.addEventListener('keydown', (e) => {
      this.handleKeyInput(e);
    });
  }
  
  private handleKeyInput(e: KeyboardEvent): void {
    if (e.key === 'Backspace') {
      this.value = this.value.slice(0, -1);
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (e.key.length === 1) {
      this.value += e.key;
      this.cursor++;
    }
    
    this.dispatchEvent(new Event('change'));
    this.render();
  }
  
  render(parentBuffer?: ScreenBuffer): void {
    // Render input background
    this.buffer.fill(this.bounds, ' ', {
      bgColor: this.focused ? 'white' : 'lightgray',
      fgColor: 'black'
    });
    
    // Render text
    this.buffer.put(1, 0, this.value);
    
    // Render cursor if focused
    if (this.focused) {
      this.buffer.put(this.cursor + 1, 0, '█', {
        fgColor: 'black',
        bgColor: 'white'
      });
    }
    
    super.render(parentBuffer);
  }
}
```

## Performance Optimizations

### 1. Render Batching
- Group multiple updates into single render passes
- Use `requestAnimationFrame` equivalent for terminals
- Debounce rapid updates

### 2. Delta Rendering
- Only redraw changed screen regions
- Track dirty rectangles
- Minimize ANSI escape sequences

### 3. Memory Management
- Pool ScreenBuffer instances
- Reuse Yoga nodes where possible
- Lazy-create buffers for invisible elements

### 4. Layout Optimizations
- Cache layout calculations
- Skip layout for elements that haven't changed
- Use incremental layout updates

## Development Workflow

### 1. Project Structure
```
tom/
├── src/
│   ├── core/           # Core TOM classes
│   ├── layout/         # Yoga integration
│   ├── events/         # Event system
│   ├── rendering/      # ScreenBuffer & ANSI
│   ├── components/     # Built-in components
│   └── renderers/      # Framework renderers
│       ├── crank/      # Crank.js adapter
│       ├── react/      # React adapter  
│       └── vue/        # Vue adapter
├── examples/           # Demo applications
├── tests/              # Test suite
└── docs/               # Documentation
```

### 2. Testing Strategy
- Unit tests for core functionality
- Integration tests for component interactions
- Visual regression tests using buffer snapshots
- Performance benchmarks

### 3. Build & Distribution
- TypeScript compilation
- Bundle for different environments
- Separate builds for Bun vs Node.js
- Component library packaging

## Roadmap

### Phase 1: Core Framework (MVP)
- [ ] Basic TOM node hierarchy
- [ ] ScreenBuffer implementation
- [ ] Simple layout system
- [ ] Basic event handling
- [ ] Crank.js renderer
- [ ] Text and Container components

### Phase 2: Layout & Styling
- [ ] Full Yoga integration
- [ ] Complete CSS-like styling
- [ ] Box model implementation
- [ ] Advanced text rendering
- [ ] Responsive layout features

### Phase 3: Rich Components
- [ ] Form components (Input, Button, Checkbox)
- [ ] Data display (Table, List, Tree)
- [ ] Navigation (Menu, Tabs, Breadcrumbs)
- [ ] Feedback (Modal, Toast, Progress)

### Phase 4: Advanced Features
- [ ] Animation system
- [ ] Theme support
- [ ] Accessibility features
- [ ] Performance profiling tools
- [ ] Developer tools integration

### Phase 5: Ecosystem
- [ ] Plugin architecture
- [ ] Third-party component ecosystem
- [ ] IDE extensions
- [ ] Documentation and tutorials

## Conclusion

The Terminal Object Model (TOM) represents a modern approach to terminal UI development, bringing web-like development patterns to the terminal environment. By leveraging proven technologies like Yoga for layout, Bun for performance, and Crank.js for component management, TOM aims to make terminal UI development as approachable and powerful as web development.

The framework's design prioritizes both developer experience and runtime performance, providing a solid foundation for building complex terminal applications while maintaining the responsiveness and efficiency that terminal users expect.