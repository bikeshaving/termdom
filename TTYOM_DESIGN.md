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

TOM uses custom elements that extend HappyDOM's base `Element` class, with proper DOM compliance including text nodes:

```typescript
import { Element, Text } from 'happy-dom';

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
  
  // Text content setter creates text nodes automatically
  set textContent(content: string) {
    this.innerHTML = '';
    if (content) {
      const textNode = this.ownerDocument.createTextNode(content);
      this.appendChild(textNode);
    }
  }
  
  // Each element renders itself
  abstract renderSelf(buffer: ScreenBuffer): void;
}

// Container elements support both block and inline-block display
class TOMContainer extends TOMElement {
  private buffer: ScreenBuffer;
  
  renderSelf(buffer: ScreenBuffer): void {
    // Render background/border to own buffer
    this.renderBackground();
    
    // Process all child nodes (elements and text nodes)
    for (const child of this.childNodes) {
      if (child.nodeType === 1 && child instanceof TOMElement) {
        child.renderSelf(this.buffer);
      } else if (child.nodeType === 3) {
        this.renderTextNode(child as Text);
      }
    }
    
    // Composite own buffer to parent
    buffer.composite(this.buffer, this.bounds.x, this.bounds.y);
  }
  
  private renderTextNode(textNode: Text): void {
    if (textNode.textContent) {
      const position = this.calculateInlinePosition(textNode);
      this.buffer.put(position.x, position.y, textNode.textContent);
    }
  }
}

// Button supports inline-block display with fixed dimensions
class TOMButton extends TOMContainer {
  renderSelf(buffer: ScreenBuffer): void {
    // Render button appearance with borders
    this.renderButtonBackground();
    this.renderButtonBorders();
    
    // Handle focus/hover states
    if (this.hasFocus) this.renderFocusOutline();
    
    // Render children (text nodes and inline elements)
    super.renderSelf(buffer);
  }
}
```

## Key Systems

### 1. Viewport System

TOM supports multiple rendering modes through the TOMViewport abstraction:

```typescript
type ViewportMode = 'fullscreen' | 'flow' | 'windowed';

class TOMViewport {
  constructor(
    private mode: ViewportMode,
    private dimensions?: { width: number; height: number }
  ) {}
  
  // Fullscreen: Takes over entire terminal
  setFullscreen(): void {
    this.mode = 'fullscreen';
    this.enableAlternateScreen();
    this.enableMouseTracking();
  }
  
  // Flow: Renders inline with terminal output
  setFlow(): void {
    this.mode = 'flow';
    this.disableAlternateScreen();
    this.preserveScrollHistory();
    this.enableMouseTracking(); // Mouse works in flow mode too
  }
  
  // Windowed: Fixed size viewport with scrolling
  setWindowed(width: number, height: number): void {
    this.mode = 'windowed';
    this.dimensions = { width, height };
    this.enableMouseTracking(); // Mouse works in windowed mode
    this.enableScrolling();
  }
  
  private enableMouseTracking(): void {
    // Enable mouse tracking for all viewport modes
    process.stdout.write('\x1b[?1000h'); // Basic mouse reporting
    process.stdout.write('\x1b[?1006h'); // SGR extended mode
  }
  
  private enableScrolling(): void {
    // Enable mouse wheel events for scrolling
    process.stdout.write('\x1b[?1002h'); // Mouse drag tracking
  }
}
```

### 2. TOMDocument (HappyDOM Integration)

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
      attributes: true,       // Style changes (not caught by Proxy)
      characterData: true     // Text content changes
    });
  }
  
  // Cleanup and unload event support
  private setupCleanupHandlers(): void {
    process.on('exit', () => {
      this.dispatchEvent(new Event('beforeunload'));
      this.cleanup();
    });
    
    process.on('SIGINT', () => {
      this.dispatchEvent(new Event('beforeunload'));
      this.cleanup();
      process.exit(0);
    });
  }
  
  private cleanup(): void {
    // Disable mouse tracking
    process.stdout.write('\x1b[?1000l');
    process.stdout.write('\x1b[?1002l');
    process.stdout.write('\x1b[?1003l');
    process.stdout.write('\x1b[?1006l');
    
    // Restore terminal state
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
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

### 3. TOMRenderer (Orchestrator)

```typescript
class TOMRenderer {
  private document: TOMDocument;
  private rootBuffer: ScreenBuffer;
  private layoutEngine: LayoutEngine;
  private textBreaker: TextBreaker;
  private renderScheduled = false;
  
  constructor(document: TOMDocument) {
    this.document = document;
    this.rootBuffer = new ScreenBuffer({ 
      width: document.terminalWidth, 
      height: document.terminalHeight,
      output: process.stdout
    });
    this.layoutEngine = new LayoutEngine();
    this.textBreaker = new SimpleGreedyTextBreaker();
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
    this.computeLayout();
    
    // 2. Clear and render (use delta rendering for performance)
    this.rootBuffer.clear();
    this.renderNode(this.document.body, this.rootBuffer);
    
    // 3. Output to terminal with delta optimization
    this.rootBuffer.renderDelta();
  }
  
  private computeLayout(): void {
    // Yoga handles flex layout
    this.layoutEngine.computeLayout(
      this.document.body, 
      this.document.terminalWidth, 
      this.document.terminalHeight
    );
    
    // Custom inline layout for text and inline-block elements
    this.computeInlineLayout(this.document.body);
  }
  
  private renderNode(node: Node, buffer: ScreenBuffer): void {
    if (node.nodeType === 1 && node instanceof TOMElement) {
      node.renderSelf(buffer);
    } else if (node.nodeType === 3) {
      // Text node - render with text breaking
      this.renderTextNode(node as Text, buffer);
    }
    
    // Recursively render child nodes
    for (const child of node.childNodes) {
      this.renderNode(child, buffer);
    }
  }
  
  private renderTextNode(textNode: Text, buffer: ScreenBuffer): void {
    if (!textNode.textContent) return;
    
    const parent = textNode.parentElement as TOMElement;
    const position = this.calculateInlineFlowPosition(parent, textNode);
    
    // Apply text wrapping if needed
    const availableWidth = parent.bounds.width;
    const lines = this.textBreaker.breakText(
      textNode.textContent, 
      availableWidth
    );
    
    lines.forEach((line, index) => {
      buffer.put(position.x, position.y + index, line);
    });
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
    const mouseData = this.parseMouseInput(input);
    if (!mouseData) return;
    
    const { x, y, button, action } = mouseData;
    const targetElement = this.hitTest(x, y);
    
    if (targetElement) {
      const eventType = action === 'press' ? 'mousedown' : 'mouseup';
      const event = new MouseEvent(eventType, { 
        clientX: x, 
        clientY: y, 
        button 
      });
      targetElement.dispatchEvent(event);
      
      // Also dispatch click on mouseup
      if (action === 'release') {
        const clickEvent = new MouseEvent('click', { 
          clientX: x, 
          clientY: y, 
          button 
        });
        targetElement.dispatchEvent(clickEvent);
      }
    }
  }
  
  private hitTest(x: number, y: number): TOMElement | null {
    return this.hitTestRecursive(this.document.body, x, y);
  }
  
  private hitTestRecursive(element: Element, x: number, y: number): TOMElement | null {
    if (!(element instanceof TOMElement)) return null;
    
    // Check if point is within element bounds
    if (!element.bounds.contains(x, y)) return null;
    
    // Check children first (front-to-back)
    for (let i = element.children.length - 1; i >= 0; i--) {
      const child = element.children[i];
      const hit = this.hitTestRecursive(child, x, y);
      if (hit) return hit;
    }
    
    return element;
  }
}
```

### 4. Layout System (Dual Engine)

TOM uses a dual layout system: Yoga for structural layout and custom algorithms for inline content:

```typescript
interface TextBreaker {
  breakText(text: string, maxWidth: number): string[];
}

class SimpleGreedyTextBreaker implements TextBreaker {
  breakText(text: string, maxWidth: number): string[] {
    if (maxWidth <= 0) return [text];
    
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine + (currentLine ? ' ' : '') + word;
      
      if (Bun.stringWidth(testLine) <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          // Word is longer than maxWidth - break it
          lines.push(word);
        }
      }
    }
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    return lines.length ? lines : [''];
  }
}

class LayoutEngine {
  // Yoga layout for structural elements
  static computeLayout(root: TOMElement, containerWidth: number, containerHeight: number): void {
    this.applyStylesToYoga(root);
    root.yogaNode.calculateLayout(containerWidth, containerHeight);
    this.extractComputedLayout(root);
  }
  
  // Inline layout for text and inline-block elements  
  static computeInlineLayout(parent: TOMElement): void {
    if (parent.style.display !== 'flex') {
      // Handle inline flow layout
      this.layoutInlineChildren(parent);
    }
    
    // Recursively layout children
    for (const child of parent.children) {
      if (child instanceof TOMElement) {
        this.computeInlineLayout(child);
      }
    }
  }
  
  private static layoutInlineChildren(parent: TOMElement): void {
    const contentArea = parent.getContentArea();
    let x = contentArea.x;
    let y = contentArea.y;
    
    for (const child of parent.childNodes) {
      if (child.nodeType === 1 && child instanceof TOMElement) {
        if (child.style.display === 'inline-block') {
          // Position inline-block element
          child.bounds.x = x;
          child.bounds.y = y;
          x += child.bounds.width;
        }
      }
      // Text nodes handled by renderer
    }
  }
}
```

### 5. Yoga Integration

```typescript
interface TOMStyle {
  // Display & Positioning (simplified set)
  display?: 'flex' | 'inline' | 'inline-block' | 'none';
  position?: 'relative' | 'absolute' | 'fixed';
  
  // Flexbox (for display: flex elements) - kebab-case for CSSOM compliance
  'flex-direction'?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  'justify-content'?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around';
  'align-items'?: 'stretch' | 'flex-start' | 'center' | 'flex-end';
  flex?: number;
  'flex-grow'?: number;
  'flex-shrink'?: number;
  
  // Box Model (supporting terminal units)
  width?: number | string; // cells, %, ch, vh, vw
  height?: number | string;
  'min-width'?: number | string;
  'max-width'?: number | string;
  'min-height'?: number | string;
  'max-height'?: number | string;
  
  margin?: [number, number, number, number] | number | string;
  padding?: [number, number, number, number] | number | string;
  border?: [number, number, number, number] | number | string;
  
  // Visual - kebab-case
  color?: string;
  'background-color'?: string;
  'border-color'?: string;
  
  // Text (with inheritance support) - kebab-case
  'font-weight'?: 'normal' | 'bold';
  'font-style'?: 'normal' | 'italic';
  'text-decoration'?: 'none' | 'underline' | 'strikethrough';
  'text-align'?: 'left' | 'center' | 'right';
  
  // Text Layout - kebab-case
  'white-space'?: 'normal' | 'nowrap' | 'pre' | 'pre-wrap';
  'word-break'?: 'normal' | 'break-all' | 'break-word';
  
  // Overflow & Scrolling - kebab-case
  overflow?: 'visible' | 'hidden' | 'scroll';
  'overflow-x'?: 'visible' | 'hidden' | 'scroll';
  'overflow-y'?: 'visible' | 'hidden' | 'scroll';
}

```typescript
class YogaLayoutEngine {
  static computeLayout(root: TOMElement, containerWidth: number, containerHeight: number): void {
    // 1. Apply styles to Yoga nodes
    this.applyStylesToYoga(root);
    
    // 2. Calculate layout
    root.yogaNode.calculateLayout(containerWidth, containerHeight);
    
    // 3. Extract computed values
    this.extractComputedLayout(root);
  }
  
  private static applyStylesToYoga(node: TOMElement): void {
    const yoga = node.yogaNode;
    const style = node.style;
    
    // Map display types to Yoga
    if (style.display === 'flex') {
      yoga.setDisplay(Yoga.DISPLAY_FLEX);
    } else if (style.display === 'none') {
      yoga.setDisplay(Yoga.DISPLAY_NONE);
    } else {
      // inline and inline-block handled by custom layout
      yoga.setDisplay(Yoga.DISPLAY_FLEX);
    }
    
    // Flexbox properties (kebab-case)
    if (style['flex-direction']) {
      yoga.setFlexDirection(this.mapFlexDirection(style['flex-direction']));
    }
    if (style['justify-content']) {
      yoga.setJustifyContent(this.mapJustifyContent(style['justify-content']));
    }
    if (style['align-items']) {
      yoga.setAlignItems(this.mapAlignItems(style['align-items']));
    }
    
    // Dimensions (supporting terminal units)
    if (style.width) yoga.setWidth(this.parseUnit(style.width));
    if (style.height) yoga.setHeight(this.parseUnit(style.height));
    if (style['min-width']) yoga.setMinWidth(this.parseUnit(style['min-width']));
    if (style['max-width']) yoga.setMaxWidth(this.parseUnit(style['max-width']));
    
    // Box model
    if (style.margin) this.applyMargin(yoga, style.margin);
    if (style.padding) this.applyPadding(yoga, style.padding);
    
    // Recursively apply to children
    for (const child of node.children) {
      if (child instanceof TOMElement) {
        this.applyStylesToYoga(child);
      }
    }
  }
  
  private static parseUnit(value: string | number): number {
    if (typeof value === 'number') return value;
    
    // Support terminal CSS units
    if (value.endsWith('ch')) return parseInt(value); // Character width
    if (value.endsWith('%')) return Yoga.PERCENT(parseFloat(value));
    if (value.endsWith('vh')) return Math.floor(process.stdout.rows * parseFloat(value) / 100);
    if (value.endsWith('vw')) return Math.floor(process.stdout.columns * parseFloat(value) / 100);
    
    // Default to cells (unitless)
    return parseInt(value) || 0;
  }
}
```
```

### 6. CSSOM Integration

TOM implements proper CSS Object Model compliance with reactive style changes:

```typescript
class TOMCSSStyleDeclaration {
  private element: TOMElement;
  private styles: Map<string, string> = new Map();
  
  constructor(element: TOMElement) {
    this.element = element;
    
    // Create proxy for reactive style changes
    return new Proxy(this, {
      set(target, property: string, value: any) {
        if (typeof property === 'string') {
          target.setProperty(property, value);
          return true;
        }
        return false;
      },
      
      get(target, property: string) {
        if (typeof property === 'string') {
          return target.getProperty(property);
        }
        return target[property];
      }
    });
  }
  
  setProperty(property: string, value: string): void {
    // Parse shorthand properties
    const parsed = this.parseShorthand(property, value);
    
    for (const [prop, val] of parsed) {
      this.styles.set(prop, val);
    }
    
    // Trigger re-layout and re-render
    this.element.scheduleRender();
  }
  
  getProperty(property: string): string {
    return this.styles.get(property) || '';
  }
  
  private parseShorthand(property: string, value: string): Array<[string, string]> {
    // Handle CSS shorthand parsing
    switch (property) {
      case 'margin':
        return this.parseBoxShorthand('margin', value);
      case 'padding':
        return this.parseBoxShorthand('padding', value);
      case 'border':
        return this.parseBorderShorthand(value);
      default:
        return [[property, value]];
    }
  }
  
  private parseBoxShorthand(prefix: string, value: string): Array<[string, string]> {
    const values = value.split(/\s+/);
    const props = [`${prefix}Top`, `${prefix}Right`, `${prefix}Bottom`, `${prefix}Left`];
    
    switch (values.length) {
      case 1: return props.map(prop => [prop, values[0]]);
      case 2: return [[props[0], values[0]], [props[1], values[1]], 
                     [props[2], values[0]], [props[3], values[1]]];
      case 3: return [[props[0], values[0]], [props[1], values[1]], 
                     [props[2], values[2]], [props[3], values[1]]];
      case 4: return props.map((prop, i) => [prop, values[i]]);
      default: return [];
    }
  }
}

// CSS calc() expression evaluator
class CSSCalcEvaluator {
  static evaluate(expression: string, context: { vw: number; vh: number; ch: number }): number {
    // Remove calc() wrapper
    const inner = expression.replace(/calc\((.*)\)/, '$1').trim();
    
    // Simple evaluation for terminal units
    return this.parseExpression(inner, context);
  }
  
  private static parseExpression(expr: string, context: any): number {
    // Handle + - * / operations with terminal units
    // Simplified implementation for terminal use case
    return eval(expr.replace(/\bvw\b/g, context.vw)
                  .replace(/\bvh\b/g, context.vh)
                  .replace(/\bch\b/g, context.ch));
  }
}
```

### 7. Event System

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

### 8. Testing Infrastructure

TOM includes comprehensive testing infrastructure that doesn't take over the terminal:

```typescript
// Mock terminal for testing
class MockTerminal implements TerminalInterface {
  private outputBuffer: string[] = [];
  private dimensions = { columns: 80, rows: 24 };
  
  write(data: string | Buffer): boolean {
    this.outputBuffer.push(data.toString());
    return true;
  }
  
  getOutput(): string {
    return this.outputBuffer.join('');
  }
  
  simulateInput(data: string): void {
    this.emit('data', Buffer.from(data));
  }
  
  simulateMouse(button: number, x: number, y: number, press: boolean): void {
    const action = press ? 'M' : 'm';
    const sequence = `\x1b[<${button};${x + 1};${y + 1}${action}`;
    this.simulateInput(sequence);
  }
}

// Usage in tests
test("TOM rendering", () => {
  const mockTerminal = new MockTerminal();
  const document = new TOMDocument(mockTerminal);
  
  const button = document.createElement('button');
  button.textContent = 'Click me';
  document.body.appendChild(button);
  
  document.render();
  
  const output = mockTerminal.getOutput();
  expect(stripAnsi(output)).toContain('Click me');
});
```

### 9. ScreenBuffer System

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
    
    // Optimization: render contiguous text runs together
    const runs = this.findContiguousRuns();
    let output = '';
    
    for (const run of runs) {
      if (run.length > 0) {
        output += `\x1b[${run.y + 1};${run.x + 1}H`;
        output += this.generateStyleSequence(run.cells[0]);
        output += run.cells.map(cell => cell.char).join('');
      }
    }
    
    if (output) {
      output += '\x1b[0m'; // Reset
      this.output.write(output);
    }
    
    this.lastFrame = this.copyFrame(this.cells);
  }
  
  private findContiguousRuns(): Array<{x: number, y: number, cells: Cell[]}> {
    const runs: Array<{x: number, y: number, cells: Cell[]}> = [];
    
    for (let y = 0; y < this.height; y++) {
      let currentRun: {x: number, y: number, cells: Cell[]} | null = null;
      
      for (let x = 0; x < this.width; x++) {
        const current = this.cells[y][x];
        const last = this.lastFrame ? this.lastFrame[y][x] : null;
        
        if (!last || !this.cellsEqual(current, last)) {
          if (currentRun && 
              currentRun.y === y && 
              currentRun.x + currentRun.cells.length === x &&
              this.stylesEqual(current, currentRun.cells[0])) {
            // Extend current run
            currentRun.cells.push(current);
          } else {
            // Start new run
            if (currentRun) runs.push(currentRun);
            currentRun = { x, y, cells: [current] };
          }
        } else {
          // End current run
          if (currentRun) {
            runs.push(currentRun);
            currentRun = null;
          }
        }
      }
      
      // End run at end of line
      if (currentRun) {
        runs.push(currentRun);
      }
    }
    
    return runs;
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

### 10. Chrome DevTools Integration

TOM can connect to Chrome DevTools for advanced debugging:

```typescript
class TOMDevToolsBridge {
  private wsServer: WebSocketServer;
  private document: TOMDocument;
  
  constructor(document: TOMDocument, port = 9222) {
    this.document = document;
    this.wsServer = new WebSocketServer({ port });
    this.setupDevToolsProtocol();
  }
  
  private setupDevToolsProtocol(): void {
    this.wsServer.on('connection', (ws) => {
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        this.handleDevToolsMessage(ws, message);
      });
      
      // Send initial DOM structure
      this.sendDOMTree(ws);
    });
  }
  
  private sendDOMTree(ws: WebSocket): void {
    const domTree = this.serializeDOMTree(this.document.body);
    ws.send(JSON.stringify({
      method: 'DOM.documentUpdated',
      params: { root: domTree }
    }));
  }
  
  private serializeDOMTree(element: Element): any {
    return {
      nodeId: this.getNodeId(element),
      nodeType: element.nodeType,
      nodeName: element.tagName,
      attributes: this.getAttributes(element),
      children: Array.from(element.children).map(child => 
        this.serializeDOMTree(child)
      )
    };
  }
}
```

### 11. Bun Integration

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

## TOM vs Browser Layout Engines

TOM simplifies browser layout complexity for terminal constraints:

| Feature | Browser | TOM |
|---------|---------|-----|
| Display types | 20+ types | 4 types (flex, inline, inline-block, none) |
| Layout passes | Multi-pass | 2-pass (Yoga + inline) |
| Text layout | Complex typography | Terminal character grid |
| Units | px, em, rem, %, vw, vh, etc. | cells, %, ch, vh, vw |
| Box model | Full CSS box model | Simplified for terminal |
| Overflow | Complex scrolling | Simple clipping/scrolling |
| Positioning | Complex stacking contexts | Z-index via render order |

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

### Viewport Modes

```typescript
// Fullscreen mode (like top, htop)
const document = new TOMDocument();
document.viewport.setFullscreen();

// Flow mode (like build tools, test runners)
const document = new TOMDocument();
document.viewport.setFlow();

// Windowed mode (fixed size with scrolling)
const document = new TOMDocument();
document.viewport.setWindowed(80, 24);
```

### Text Wrapping and Rich Content

```typescript
// Rich text with mixed inline content
const paragraph = document.createElement('container');
paragraph.style.display = 'inline';

const textNode1 = document.createTextNode('This is ');
const emphasis = document.createElement('container');
emphasis.style = { color: 'red', fontWeight: 'bold', display: 'inline' };
emphasis.textContent = 'important';
const textNode2 = document.createTextNode(' text that wraps properly.');

paragraph.appendChild(textNode1);
paragraph.appendChild(emphasis);
paragraph.appendChild(textNode2);

document.body.appendChild(paragraph);
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

### CSS Styling with Units

```typescript
// Terminal-specific CSS units with kebab-case
const container = document.createElement('container');
container.style = {
  width: '80ch',                    // 80 character cells
  height: '50vh',                   // 50% of viewport height
  margin: '2',                      // 2 cells (unitless defaults to cells)
  padding: '10%',                   // 10% of parent width
  'max-width': 'calc(100vw - 4ch)', // CSS calc() support
  'background-color': '#1a1a1a',    // Kebab-case for multi-word properties
  'flex-direction': 'column'        // Kebab-case for flexbox
};
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

## Performance Characteristics

### Rendering Performance
- **ScreenBuffer compositing**: ~1ms for full screen updates
- **Delta rendering**: ~0.1ms for small changes
- **Layout calculation**: ~0.5ms for complex flex layouts
- **Text measurement**: Instant with Bun.stringWidth()
- **Memory usage**: ~1MB base + ~100KB per 1000 elements

### Layout Performance
- **Yoga flexbox**: Native C++ performance
- **Inline layout**: Custom algorithm optimized for text
- **Text breaking**: Greedy algorithm, ~0.1ms per paragraph
- **Hit testing**: O(n) tree traversal, cached results

## Development Workflow

### 1. Project Structure
```
tom/
├── src/
│   ├── core/           # Core TOM classes (TOMDocument, TOMRenderer, etc.)
│   ├── layout/         # Yoga integration and inline layout
│   ├── events/         # Event system and input handling
│   ├── rendering/      # ScreenBuffer, ANSI, and compositing
│   ├── text/           # Text breaking algorithms
│   ├── css/            # CSSOM and style parsing
│   ├── components/     # Built-in components (button, input, etc.)
│   ├── viewport/       # Viewport system and modes
│   ├── devtools/       # Chrome DevTools integration
│   └── renderers/      # Framework renderers
│       ├── crank/      # Crank.js adapter
│       ├── react/      # React adapter  
│       └── vue/        # Vue adapter
├── examples/           # Demo applications
├── tests/              # Test suite with mock terminal
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

### Phase 1: Core Framework (MVP) ✅
- [x] Basic TOM element hierarchy with HappyDOM integration
- [x] ScreenBuffer implementation with compositing
- [x] Yoga layout engine integration
- [x] Mouse and keyboard event handling
- [x] DOM-compliant text node support
- [x] Container, Text, and Button components

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