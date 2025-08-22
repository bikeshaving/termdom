/**
 * TOMMouseHandler - Handles mouse input for TOM
 * 
 * Converts terminal mouse events to DOM MouseEvents and manages
 * hover states, click detection, and element targeting.
 */

import { TOMDocument } from './TOMDocument.js';
import { TOMElement } from './TOMElement.js';
import { TerminalInterface } from './TerminalInterface.js';

export interface MouseState {
  x: number;
  y: number;
  buttons: number;
  hoveredElement: TOMElement | null;
  mouseDownTarget: TOMElement | null;
}

export class TOMMouseHandler {
  private document: TOMDocument;
  private terminal: TerminalInterface;
  private isEnabled = false;
  private mouseState: MouseState = {
    x: 0,
    y: 0,
    buttons: 0,
    hoveredElement: null,
    mouseDownTarget: null
  };

  constructor(document: TOMDocument, terminal: TerminalInterface) {
    this.document = document;
    this.terminal = terminal;
  }

  /**
   * Enable mouse tracking
   */
  enable(): void {
    if (this.isEnabled) return;
    this.isEnabled = true;
    
    // Enable mouse tracking in terminal
    // Use button + drag mode to ensure we get all press/release events
    this.terminal.write('\x1b[?1002h'); // Enable mouse button + drag tracking
    this.terminal.write('\x1b[?1006h'); // Enable SGR extended mode
  }

  /**
   * Disable mouse tracking
   */
  disable(): void {
    if (!this.isEnabled) return;
    this.isEnabled = false;
    
    // Disable all mouse tracking modes
    this.terminal.write('\x1b[?1000l'); // Disable basic mouse reporting
    this.terminal.write('\x1b[?1002l'); // Disable mouse drag tracking
    this.terminal.write('\x1b[?1003l'); // Disable motion tracking
    this.terminal.write('\x1b[?1006l'); // Disable SGR extended mode
  }

  /**
   * Handle raw mouse input from terminal
   * Expected format: \x1b[<button;x;yM (press) or m (release)
   */
  handleMouseInput(data: string): boolean {
    // Check for mouse escape sequence
    if (!data.includes('\x1b[<')) return false;
    
    // Extract mouse sequence (might be in middle of data)
    const match = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (!match) return false;
    
    const [, buttonStr, xStr, yStr, action] = match;
    const button = parseInt(buttonStr);
    const x = parseInt(xStr) - 1; // Terminal coords are 1-based
    const y = parseInt(yStr) - 1;
    const isPress = action === 'M';
    
    // Update mouse state
    this.mouseState.x = x;
    this.mouseState.y = y;
    
    // Decode button (bits: 0-1 = button, 5 = motion, 6 = wheel)
    const isMotion = (button & 32) !== 0;
    const isWheel = (button & 64) !== 0;
    const buttonNum = button & 3;
    
    if (isWheel) {
      this.handleWheel(x, y, buttonNum === 0 ? -1 : 1);
    } else if (isMotion) {
      this.handleMouseMove(x, y);
    } else if (isPress) {
      this.handleMouseDown(x, y, buttonNum);
    } else {
      this.handleMouseUp(x, y, buttonNum);
    }
    
    return true;
  }

  /**
   * Find element at coordinates
   */
  private findElementAt(x: number, y: number): TOMElement | null {
    const body = this.document.body;
    if (!body) return null;
    
    // Search through all children of body (since body might not be TOMElement)
    for (const child of body.children) {
      if (child instanceof TOMElement) {
        const found = this.findInTOMElement(child, x, y);
        if (found) return found;
      }
    }
    
    return null;
  }

  /**
   * Recursively find TOM element at coordinates
   */
  private findInTOMElement(element: TOMElement, x: number, y: number): TOMElement | null {
    if (!element.containsPoint(x, y)) return null;
    
    // Check children first (they're on top)
    const children = element.getTOMChildren();
    for (let i = children.length - 1; i >= 0; i--) {
      const found = this.findInTOMElement(children[i], x, y);
      if (found) return found;
    }
    
    // No child contains point, return this element
    return element;
  }

  /**
   * Handle mouse movement
   */
  private handleMouseMove(x: number, y: number): void {
    const element = this.findElementAt(x, y);
    
    // Handle hover state changes
    if (element !== this.mouseState.hoveredElement) {
      // Mouse leave old element
      if (this.mouseState.hoveredElement) {
        const leaveEvent = this.createMouseEvent('mouseleave', x, y, 0, false, element);
        this.mouseState.hoveredElement.dispatchEvent(leaveEvent);
      }
      
      // Mouse enter new element
      if (element) {
        const enterEvent = this.createMouseEvent('mouseenter', x, y, 0, false, this.mouseState.hoveredElement);
        element.dispatchEvent(enterEvent);
      }
      
      this.mouseState.hoveredElement = element;
    }
    
    // Always dispatch mousemove
    if (element) {
      const moveEvent = this.createMouseEvent('mousemove', x, y, 0, true);
      element.dispatchEvent(moveEvent);
    }
  }

  /**
   * Handle mouse button press
   */
  private handleMouseDown(x: number, y: number, button: number): void {
    const element = this.findElementAt(x, y);
    if (!element) return;
    
    this.mouseState.buttons |= (1 << button);
    
    // Track which element got the mousedown for click detection
    if (button === 0) { // Left button
      this.mouseState.mouseDownTarget = element;
    }
    
    const event = this.createMouseEvent('mousedown', x, y, button, true);
    element.dispatchEvent(event);
  }

  /**
   * Handle mouse button release
   */
  private handleMouseUp(x: number, y: number, button: number): void {
    const element = this.findElementAt(x, y);
    if (!element) return;
    
    this.mouseState.buttons &= ~(1 << button);
    
    const event = this.createMouseEvent('mouseup', x, y, button, true);
    element.dispatchEvent(event);
    
    // Generate click event only if mouseup on same element as mousedown
    if (button === 0 && this.mouseState.mouseDownTarget === element) {
      const clickEvent = this.createMouseEvent('click', x, y, button, true);
      element.dispatchEvent(clickEvent);
    }
    
    // Clear mousedown target
    if (button === 0) {
      this.mouseState.mouseDownTarget = null;
    }
  }

  /**
   * Handle mouse wheel
   */
  private handleWheel(x: number, y: number, delta: number): void {
    const element = this.findElementAt(x, y);
    if (!element) return;
    
    const event = this.createMouseEvent('wheel', x, y, 0, true);
    // Add wheel-specific property
    Object.defineProperty(event, 'deltaY', { value: delta * 100, enumerable: true });
    
    element.dispatchEvent(event);
  }

  /**
   * Create a proper HappyDOM MouseEvent
   */
  private createMouseEvent(type: string, x: number, y: number, button: number, bubbles: boolean = true, relatedTarget: any = null) {
    // Use HappyDOM's MouseEvent constructor
    return new this.document.window.MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: button,
      buttons: this.mouseState.buttons,
      relatedTarget: relatedTarget,
      bubbles: bubbles,
      cancelable: true,
      view: this.document.window
    });
  }

  /**
   * Get current mouse state
   */
  getMouseState(): Readonly<MouseState> {
    return { ...this.mouseState };
  }
}