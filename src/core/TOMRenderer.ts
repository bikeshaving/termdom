/**
 * TOMRenderer - Orchestrates layout calculation and terminal rendering
 * 
 * Coordinates between HappyDOM's tree structure, Yoga layout engine,
 * and ScreenBuffer rendering to efficiently update the terminal.
 */

import { TOMElement } from './TOMElement.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';
import { LayoutEngine } from '../layout/LayoutEngine.js';

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

    // Render children
    for (const child of element.children) {
      this.renderElement(child, buffer);
    }
  }

  /**
   * Clear render flags on all TOM elements
   */
  private clearRenderFlags(element: Element): void {
    if (element instanceof TOMElement) {
      element.clearRenderFlag();
    }

    for (const child of element.children) {
      this.clearRenderFlags(child);
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
      
      const domEvent = new KeyboardEvent('keydown', {
        key: keyEvent.key,
        ctrlKey: keyEvent.ctrl,
        shiftKey: keyEvent.shift,
        altKey: keyEvent.alt
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