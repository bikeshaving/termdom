/**
 * TOMRenderer - Orchestrates layout calculation and terminal rendering
 * 
 * Coordinates between HappyDOM's tree structure, Yoga layout engine,
 * and ScreenBuffer rendering to efficiently update the terminal.
 */

import { TOMElement } from './TOMElement.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';
import { LayoutEngine } from '../layout/LayoutEngine.js';
import { SimpleGreedyTextBreaker } from '../text/SimpleGreedyTextBreaker.js';
import { type InlineElement } from '../text/index.js';

export interface TOMMouseEvent {
  x: number;
  y: number;
  button: number;
  type: 'click' | 'mousedown' | 'mouseup' | 'mousemove';
}

export interface TOMKeyboardEvent {
  key: string;
  char?: string;
  sequence: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * TOMRenderer orchestrates the rendering pipeline
 */
export class TOMRenderer {
  private document: any; // TOMDocument reference
  private rootBuffer: ScreenBuffer;
  private layoutEngine: LayoutEngine;
  private textBreaker: SimpleGreedyTextBreaker;
  private renderScheduled = false;
  private destroyed = false;
  private output: NodeJS.WriteStream;
  
  // Input handling
  private inputEnabled = false;
  private focusedElement: TOMElement | null = null;

  constructor(document: any, output: NodeJS.WriteStream) {
    this.document = document;
    this.output = output;
    this.rootBuffer = new ScreenBuffer({
      width: document.terminalWidth,
      height: document.terminalHeight,
      output
    });
    this.layoutEngine = new LayoutEngine();
    this.textBreaker = new SimpleGreedyTextBreaker();
    
    this.setupInputHandling();
  }

  /**
   * Schedule a render for the next microtask (batches multiple changes)
   */
  scheduleRender(): void {
    if (this.renderScheduled || this.destroyed) return;
    
    this.renderScheduled = true;
    
    // Use microtask to batch renders
    queueMicrotask(() => {
      if (!this.destroyed) {
        this.render();
      }
      this.renderScheduled = false;
    });
  }

  /**
   * Perform a full render cycle
   */
  render(): void {
    if (this.destroyed) return;

    try {
      // 1. Layout pass - calculate positions and sizes
      this.layoutEngine.computeLayout(
        this.document.body,
        this.document.terminalWidth,
        this.document.terminalHeight
      );

      // 2. Clear root buffer
      this.rootBuffer.clear();

      // 3. Render all elements
      this.renderElement(this.document.body, this.rootBuffer);

      // 4. Output to terminal (use delta rendering for efficiency)
      this.rootBuffer.renderDelta();

      // 5. Clear render flags
      this.clearRenderFlags(this.document.body);

    } catch (error) {
      console.error('TOM render error:', error);
    }
  }

  /**
   * Recursively render an element and its children
   */
  private renderElement(element: Element, buffer: ScreenBuffer): void {
    if (element instanceof TOMElement) {
      // Skip hidden elements
      if (element.style.display === 'none') {
        return;
      }

      // Render the element itself
      element.renderSelf(buffer);
      element.clearRenderFlag();
    }

    // Render all child nodes (including Text nodes)
    for (const child of element.childNodes) {
      if (child.nodeType === 1) { // Element node
        this.renderElement(child as Element, buffer);
      } else if (child.nodeType === 3) { // Text node
        this.renderTextNode(child as Text, buffer);
      }
    }
  }

  /**
   * Render a text node - now handled by inline layout algorithm
   */
  private renderTextNode(textNode: Text, buffer: ScreenBuffer): void {
    const content = textNode.textContent || '';
    if (!content) return;
    
    // Get parent element for style inheritance
    const parent = textNode.parentElement;
    
    if (parent instanceof TOMElement) {
      const textStyle = parent.getTextStyle();
      
      if (parent.style.display === 'inline') {
        // Inline elements: text is positioned by the inline layout algorithm
        this.renderInlineText(parent, textNode, content, textStyle, buffer);
      } else if (parent.style.display === 'inline-block') {
        // Inline-block elements: text within content area (like flex, but inline-positioned)
        this.renderInlineBlockText(parent, textNode, content, textStyle, buffer);
      } else {
        // Flex elements: render text within the element's content area
        this.renderFlexText(parent, textNode, content, textStyle, buffer);
      }
    }
  }
  
  /**
   * Render text within an inline element (positioned by Yoga as flex child)
   */
  private renderInlineText(parent: TOMElement, textNode: Text, content: string, textStyle: any, buffer: ScreenBuffer): void {
    const bounds = parent.bounds;
    
    if (bounds.width > 0 && bounds.height > 0) {
      // For inline elements, text fills the entire bounds (no padding/borders)
      buffer.put(bounds.x, bounds.y, content, textStyle);
    }
  }
  
  /**
   * Render text within an inline-block element (has content area like flex)
   */
  private renderInlineBlockText(parent: TOMElement, textNode: Text, content: string, textStyle: any, buffer: ScreenBuffer): void {
    const contentArea = parent.getContentArea();
    
    if (contentArea.width > 0 && contentArea.height > 0) {
      // For inline-block elements, text goes in content area (respecting padding/borders)
      // TODO: Handle text alignment within content area
      buffer.put(contentArea.x, contentArea.y, content, textStyle);
    }
  }
  
  /**
   * Render text within a flex element using proper inline flow positioning
   */
  private renderFlexText(parent: TOMElement, textNode: Text, content: string, textStyle: any, buffer: ScreenBuffer): void {
    const contentArea = parent.getContentArea();
    
    // Check if text wrapping is enabled and needed
    const wordWrap = parent.style.wordWrap || 'normal';
    const shouldWrap = wordWrap === 'break-word' || wordWrap === 'normal';
    const contentWidth = this.getTextWidth(content);
    
    if (shouldWrap && contentWidth > contentArea.width) {
      // Use TextBreaker for wrapped text rendering
      this.renderWrappedText(parent, textNode, content, textStyle, buffer, contentArea);
    } else {
      // Use existing single-line flow positioning
      const flowPosition = this.calculateInlineFlowPosition(parent, textNode, contentArea);
      
      // Ensure we don't render outside parent bounds
      if (flowPosition.x < contentArea.x + contentArea.width) {
        buffer.put(flowPosition.x, flowPosition.y, content, textStyle);
      }
    }
  }
  
  /**
   * Render wrapped text using TextBreaker algorithm
   */
  private renderWrappedText(parent: TOMElement, textNode: Text, content: string, textStyle: any, buffer: ScreenBuffer, contentArea: any): void {
    // Collect inline elements from siblings for mixed content processing
    const inlineElements: InlineElement[] = [];
    const siblings = Array.from(parent.childNodes);
    const textNodeIndex = siblings.indexOf(textNode);
    
    // Build inline elements array from sibling elements
    let textOffset = 0;
    for (let i = 0; i < textNodeIndex; i++) {
      const sibling = siblings[i];
      if (sibling.nodeType === 3) {
        // Text node - advance offset
        textOffset += (sibling.textContent || '').length;
      } else if (sibling.nodeType === 1 && sibling instanceof TOMElement) {
        // Element - add to inline elements
        if (sibling.style.display === 'inline-block') {
          inlineElements.push({
            position: textOffset,
            width: sibling.bounds.width,
            height: sibling.bounds.height,
            breakable: false,
            element: sibling
          });
        }
      }
    }
    
    // Break text into lines
    const result = this.textBreaker.breakText(content, {
      maxWidth: contentArea.width,
      breakWords: true,
      inlineElements
    });
    
    // Render each line
    let currentY = contentArea.y;
    for (const line of result.lines) {
      if (currentY >= contentArea.y + contentArea.height) {
        break; // Don't render outside content area
      }
      
      buffer.put(contentArea.x, currentY, line.text, textStyle);
      currentY++;
    }
  }
  
  /**
   * Calculate position in inline flow using actual element positions (not cumulative widths)
   */
  private calculateInlineFlowPosition(parent: TOMElement, targetNode: Node, contentArea: any): { x: number; y: number } {
    const siblings = Array.from(parent.childNodes);
    const targetIndex = siblings.indexOf(targetNode);
    
    if (targetIndex === 0) {
      // First child starts at contentArea beginning
      return { x: contentArea.x, y: contentArea.y };
    }
    
    // Find the rightmost position of all previous siblings
    let x = contentArea.x;
    let y = contentArea.y;
    
    for (let i = 0; i < targetIndex; i++) {
      const sibling = siblings[i];
      
      if (sibling.nodeType === 3) { // Text node
        // Text nodes flow after previous content
        x += this.getTextWidth(sibling.textContent || '');
      } else if (sibling.nodeType === 1 && sibling instanceof TOMElement) { // Element node
        // Elements use their actual Yoga-positioned bounds
        const elementEnd = sibling.bounds.x + sibling.bounds.width;
        x = Math.max(x, elementEnd); // Position after the rightmost element
      }
    }
    
    return { x, y };
  }
  
  /**
   * Get width of any node (text or element) for inline flow calculations
   */
  private getNodeWidth(node: Node): number {
    if (node.nodeType === 3) { // Text node
      return this.getTextWidth(node.textContent || '');
    } else if (node.nodeType === 1 && node instanceof TOMElement) { // Element node
      return this.getElementWidth(node);
    }
    return 0;
  }
  
  /**
   * Get width of an element for inline flow (recursive for inline elements)
   */
  private getElementWidth(element: TOMElement): number {
    const display = element.style.display;
    
    if (display === 'inline-block') {
      // Inline-block elements use their full rendered bounds
      return element.bounds.width;
    } else if (display === 'inline') {
      // Inline elements: recursively calculate width of their content
      return this.getInlineElementWidth(element);
    } else if (display === 'none') {
      return 0;
    }
    
    // Flex elements in inline context (shouldn't happen, but fallback)
    return element.bounds.width;
  }
  
  /**
   * Recursively calculate width of inline element content
   */
  private getInlineElementWidth(element: TOMElement): number {
    let totalWidth = 0;
    
    // Sum width of all child nodes
    for (const child of element.childNodes) {
      totalWidth += this.getNodeWidth(child);
    }
    
    return totalWidth;
  }
  
  /**
   * Calculate visual width of text (using Bun's stringWidth)
   */
  private getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }

  /**
   * Clear render flags on all TOM elements
   */
  private clearRenderFlags(element: Element): void {
    if (element instanceof TOMElement) {
      element.clearRenderFlag();
    }

    // Process all child nodes
    for (const child of element.childNodes) {
      if (child.nodeType === 1) { // Element node
        this.clearRenderFlags(child as Element);
      }
      // Text nodes don't have render flags to clear
    }
  }

  /**
   * Handle terminal resize
   */
  handleResize(width: number, height: number): void {
    this.rootBuffer = new ScreenBuffer({
      width,
      height,
      output: this.output
    });
    
    // Force a full re-render
    this.scheduleRender();
  }

  /**
   * Set up terminal input handling
   */
  private setupInputHandling(): void {
    if (this.output !== process.stdout) return;
    
    // Set up raw mode for input capture
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      
      // Enable mouse reporting
      this.output.write('\x1b[?1003h\x1b[?1015h\x1b[?1006h');
      
      process.stdin.on('data', this.handleInput.bind(this));
      this.inputEnabled = true;
    }
  }

  /**
   * Handle raw input data
   */
  private handleInput(data: Buffer): void {
    const input = data.toString();
    
    if (this.isMouseInput(input)) {
      this.handleMouseInput(input);
    } else {
      this.handleKeyboardInput(input);
    }
  }

  /**
   * Check if input is mouse data
   */
  private isMouseInput(input: string): boolean {
    return input.startsWith('\x1b[<') || input.startsWith('\x1b[M');
  }

  /**
   * Parse and handle mouse input
   */
  private handleMouseInput(input: string): void {
    try {
      const mouseEvent = this.parseMouseInput(input);
      if (mouseEvent) {
        const targetElement = this.hitTest(mouseEvent.x, mouseEvent.y);
        
        if (targetElement) {
          const domEvent = new MouseEvent(mouseEvent.type, {
            clientX: mouseEvent.x,
            clientY: mouseEvent.y,
            button: mouseEvent.button
          });
          
          targetElement.dispatchEvent(domEvent);
        }
      }
    } catch (error) {
      // Ignore mouse parsing errors
    }
  }

  /**
   * Parse mouse input sequence
   */
  private parseMouseInput(input: string): TOMMouseEvent | null {
    // Parse SGR mouse format: \x1b[<btn;col;row;M/m
    const sgrMatch = input.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (sgrMatch) {
      const button = parseInt(sgrMatch[1]);
      const x = parseInt(sgrMatch[2]) - 1; // Convert to 0-based
      const y = parseInt(sgrMatch[3]) - 1; // Convert to 0-based
      const isPress = sgrMatch[4] === 'M';
      
      return {
        x,
        y,
        button,
        type: isPress ? 'mousedown' : 'mouseup'
      };
    }
    
    return null;
  }

  /**
   * Handle keyboard input
   */
  private handleKeyboardInput(input: string): void {
    const keyEvent = this.parseKeyboardInput(input);
    
    if (keyEvent) {
      const target = this.focusedElement || this.document.body;
      
      const KeyboardEventClass = this.document.window.KeyboardEvent;
      const domEvent = new KeyboardEventClass('keydown', {
        key: keyEvent.key,
        ctrlKey: keyEvent.ctrl,
        shiftKey: keyEvent.shift,
        altKey: keyEvent.alt,
        bubbles: true
      });
      
      target.dispatchEvent(domEvent);
    }
  }

  /**
   * Parse keyboard input
   */
  private parseKeyboardInput(input: string): TOMKeyboardEvent | null {
    const sequence = input;
    let key = '';
    let char = '';
    let ctrl = false;
    let shift = false;
    let alt = false;

    // Handle special keys
    if (input === '\x03') {
      key = 'c';
      ctrl = true;
    } else if (input === '\x1b') {
      key = 'Escape';
    } else if (input === '\r' || input === '\n') {
      key = 'Enter';
    } else if (input === '\x7f' || input === '\x08') {
      key = 'Backspace';
    } else if (input === '\t') {
      key = 'Tab';
    } else if (input.startsWith('\x1b[')) {
      // Arrow keys and function keys
      if (input === '\x1b[A') key = 'ArrowUp';
      else if (input === '\x1b[B') key = 'ArrowDown';
      else if (input === '\x1b[C') key = 'ArrowRight';
      else if (input === '\x1b[D') key = 'ArrowLeft';
      else return null; // Unknown escape sequence
    } else if (input.length === 1 && input.charCodeAt(0) >= 32) {
      // Printable character
      key = input;
      char = input;
    } else {
      return null; // Unknown input
    }

    return { key, char, sequence, ctrl, shift, alt };
  }

  /**
   * Find element at coordinates (hit testing)
   */
  private hitTest(x: number, y: number): TOMElement | null {
    return this.hitTestRecursive(this.document.body, x, y);
  }

  /**
   * Recursive hit testing
   */
  private hitTestRecursive(element: Element, x: number, y: number): TOMElement | null {
    if (!(element instanceof TOMElement)) {
      // Check children of non-TOM elements
      for (const child of element.children) {
        const hit = this.hitTestRecursive(child, x, y);
        if (hit) return hit;
      }
      return null;
    }

    // Skip hidden elements
    if (element.style.display === 'none') {
      return null;
    }

    // Check if point is within this element
    if (element.containsPoint(x, y)) {
      // Check children first (front to back)
      for (let i = element.children.length - 1; i >= 0; i--) {
        const child = element.children[i];
        const hit = this.hitTestRecursive(child, x, y);
        if (hit) return hit;
      }
      
      // Return this element if no child was hit
      return element;
    }

    return null;
  }

  /**
   * Set focus to an element
   */
  setFocus(element: TOMElement | null): void {
    if (this.focusedElement) {
      this.focusedElement.dispatchEvent(new FocusEvent('blur'));
    }
    
    this.focusedElement = element;
    
    if (element) {
      element.dispatchEvent(new FocusEvent('focus'));
    }
  }

  /**
   * Get currently focused element
   */
  getFocus(): TOMElement | null {
    return this.focusedElement;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.destroyed = true;
    
    if (this.inputEnabled && process.stdin.setRawMode) {
      // Disable mouse reporting
      this.output.write('\x1b[?1003l\x1b[?1015l\x1b[?1006l');
      
      // Restore normal input mode
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
}