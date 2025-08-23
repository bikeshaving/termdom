/**
 * TTY Element - Base class for all TTY elements
 *
 * Extends HappyDOM's Element but bypasses HTML/CSS behavior to create
 * terminal-specific elements with custom styling and rendering.
 */

import { Element, Node, CSSStyleDeclaration, Event, PropertySymbol } from 'happy-dom';
import { ScreenBuffer, type Cell, type Rect } from '../rendering/ScreenBuffer.js';
import type * as Yoga from 'yoga-layout';

/**
 * Base TTY element class - extends HappyDOM Element but NOT HTMLElement
 * This gives us the DOM tree structure and events without HTML/CSS baggage.
 * This is a concrete class that can be instantiated directly for generic elements.
 */
export class TTYElement extends Element {
  // TTY-specific properties
  private _ttyFocused = false;
  private _ttyFocusable = false;
  public bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  public yogaNode?: Yoga.Node;
  private [PropertySymbol.style]: CSSStyleDeclaration | null = null;

  constructor() {
    super();
    // Yoga nodes will be created by LayoutEngine when needed
  }

  /**
   * Get the style property - creates CSSStyleDeclaration on demand like HTMLElement
   */
  get style(): CSSStyleDeclaration {
    if (!this[PropertySymbol.style]) {
      this[PropertySymbol.style] = new CSSStyleDeclaration(
        PropertySymbol.illegalConstructor,
        this[PropertySymbol.window],
        { element: this }
      );
    }
    return this[PropertySymbol.style];
  }

  /**
   * TTY-specific style system (not CSS)
   */
  // HappyDOM provides style property automatically via Element base class
  // No need to override - it already has proper CSSStyleDeclaration


  /**
   * Request fullscreen mode for this element
   */
  async requestFullscreen(): Promise<void> {
    // Find the TTYWindow instance
    const ttyWindow = this.getTTYWindow();
    if (!ttyWindow) {
      throw new Error('Element is not connected to a TTY window');
    }

    return ttyWindow.requestFullscreen(this);
  }

  /**
   * Get the TTYWindow instance from the ownerDocument
   */
  private getTTYWindow(): any {
    if (!this.ownerDocument) {
      return null;
    }

    // Walk up to find the TTYDocument and its associated TTYWindow
    // This is a bit hacky but works for our architecture
    const ttyDoc = (this.ownerDocument as any)._ttyDocument;
    return ttyDoc?._ttyWindow;
  }


  /**
   * Initialize Yoga node - called by LayoutEngine
   */
  public initializeYogaNode(yogaNode: Yoga.Node): void {
    this.yogaNode = yogaNode;
  }

  /**
   * Update Yoga node with current styles
   */
  private updateYogaStyles(): void {
    if (!this.yogaNode) return;

    // TODO: Use computed styles for proper layout calculation
    const style = this.style;

    // Map TTY styles to Yoga properties
    if (style.getPropertyValue('display') === 'flex') {
      // yogaNode.setDisplay(Yoga.DISPLAY_FLEX);
    }

    const flexDirection = style.getPropertyValue('flex-direction');
    if (flexDirection) {
      // Map flex direction values
    }

    const width = style.getPropertyValue('width');
    if (width && !isNaN(parseFloat(width))) {
      // yogaNode.setWidth(parseFloat(width));
    }

    const height = style.getPropertyValue('height');
    if (height && !isNaN(parseFloat(height))) {
      // yogaNode.setHeight(parseFloat(height));
    }

    // TODO: Complete Yoga integration
  }

  /**
   * Calculate text styling for terminal output using computed styles
   */
  protected getTextStyle(): Partial<Cell> {
    // Use proper getComputedStyle API for inheritance
    const window = this[PropertySymbol.window];
    const computedStyle = window ? window.getComputedStyle(this) : this.style;

    return {
      fgColor: computedStyle.getPropertyValue('color'),
      bgColor: computedStyle.getPropertyValue('background-color'),
      bold: computedStyle.getPropertyValue('font-weight') === 'bold',
      italic: computedStyle.getPropertyValue('font-style') === 'italic',
      underline: computedStyle.getPropertyValue('text-decoration') === 'underline'
    };
  }

  /**
   * Get computed padding as [top, right, bottom, left]
   */
  protected getPadding(): [number, number, number, number] {
    const padding = this.style.getPropertyValue('padding');

    if (!padding) {
      return [0, 0, 0, 0];
    }

    // Parse CSS padding value (e.g., "10px" or "10px 5px")
    const values = padding.split(/\s+/).map(v => parseInt(v) || 0);

    switch (values.length) {
      case 1: return [values[0], values[0], values[0], values[0]];
      case 2: return [values[0], values[1], values[0], values[1]];
      case 3: return [values[0], values[1], values[2], values[1]];
      case 4: return [values[0], values[1], values[2], values[3]];
      default: return [0, 0, 0, 0];
    }
  }

  /**
   * Get computed margin as [top, right, bottom, left]
   */
  protected getMargin(): [number, number, number, number] {
    const margin = this.style.getPropertyValue('margin');

    if (!margin) {
      return [0, 0, 0, 0];
    }

    // Parse CSS margin value (e.g., "10px" or "10px 5px")
    const values = margin.split(/\s+/).map(v => parseInt(v) || 0);

    switch (values.length) {
      case 1: return [values[0], values[0], values[0], values[0]];
      case 2: return [values[0], values[1], values[0], values[1]];
      case 3: return [values[0], values[1], values[2], values[1]];
      case 4: return [values[0], values[1], values[2], values[3]];
      default: return [0, 0, 0, 0];
    }
  }

  /**
   * Calculate content area (bounds minus padding)
   */
  protected getContentArea(): Rect {
    const [padTop, padRight, padBottom, padLeft] = this.getPadding();

    return {
      x: this.bounds.x + padLeft,
      y: this.bounds.y + padTop,
      width: Math.max(0, this.bounds.width - padLeft - padRight),
      height: Math.max(0, this.bounds.height - padTop - padBottom)
    };
  }


  /**
   * Check if point is within element bounds
   */
  containsPoint(x: number, y: number): boolean {
    return (
      x >= this.bounds.x &&
      x < this.bounds.x + this.bounds.width &&
      y >= this.bounds.y &&
      y < this.bounds.y + this.bounds.height
    );
  }

  /**
   * DOM viewport properties implemented with cell coordinates
   */
  get clientLeft(): number {
    // Left border width in cells
    const borderLeft = this.style.getPropertyValue('border-left-width');
    return borderLeft ? parseInt(borderLeft) || 0 : 0;
  }

  get clientTop(): number {
    // Top border width in cells
    const borderTop = this.style.getPropertyValue('border-top-width');
    return borderTop ? parseInt(borderTop) || 0 : 0;
  }

  get clientWidth(): number {
    // Inner width (content + padding, excluding borders)
    const borderLeft = this.clientLeft;
    const borderRight = parseInt(this.style.getPropertyValue('border-right-width')) || 0;
    return Math.max(0, this.bounds.width - borderLeft - borderRight);
  }

  get clientHeight(): number {
    // Inner height (content + padding, excluding borders)
    const borderTop = this.clientTop;
    const borderBottom = parseInt(this.style.getPropertyValue('border-bottom-width')) || 0;
    return Math.max(0, this.bounds.height - borderTop - borderBottom);
  }

  /**
   * Scroll properties (terminals don't have traditional scrollbars)
   */
  override get scrollLeft(): number {
    return 0; // TODO: Implement when we add scrolling
  }

  override get scrollTop(): number {
    return 0; // TODO: Implement when we add scrolling
  }

  override get scrollWidth(): number {
    return this.clientWidth; // TODO: Return actual content width when scrolling is implemented
  }

  override get scrollHeight(): number {
    return this.clientHeight; // TODO: Return actual content height when scrolling is implemented
  }

	// TODO: we should use DOM methods
  /**
   * Focus management methods
   */
  ttyIsFocused(): boolean {
    return this._ttyFocused;
  }

  ttySetFocused(focused: boolean): void {
    this._ttyFocused = focused;
  }

  ttyIsFocusable(): boolean {
    return this._ttyFocusable;
  }

  ttySetFocusable(focusable: boolean): void {
    this._ttyFocusable = focusable;
  }
}
