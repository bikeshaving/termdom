/**
 * TTY Element - Base class for all TTY elements
 *
 * Extends HappyDOM's Element but bypasses HTML/CSS behavior to create
 * terminal-specific elements with custom styling and rendering.
 */

import { Element, Node } from 'happy-dom';
// @ts-ignore - HappyDOM Event class for proper event creation
import Event from 'happy-dom/lib/event/Event.js';
import { ScreenBuffer, type Cell, type Rect } from '../rendering/ScreenBuffer.js';
import type * as Yoga from 'yoga-layout';
// Use HappyDOM's built-in CSSStyleDeclaration instead of custom implementation

// TODO: Figure out if this can inherit from CSSStyleDeclaration, probably should be put in a separate file
// TODO: Please make these kebab-case to match CSSOM
export interface TTYStyle {
  // Display & Positioning
  display?: 'flex' | 'block' | 'inline' | 'inline-block' | 'none';
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

	// TOOD: string shorthand. I'm not sure about arrays here
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
  whiteSpace?: 'normal' | 'nowrap' | 'pre' | 'pre-wrap';
  wordWrap?: 'normal' | 'break-word' | 'nowrap';

  // Overflow
  overflow?: 'visible' | 'hidden' | 'scroll';
  overflowX?: 'visible' | 'hidden' | 'scroll';
  overflowY?: 'visible' | 'hidden' | 'scroll';
}

/**
 * Base TTY element class - extends HappyDOM Element but NOT HTMLElement
 * This gives us the DOM tree structure and events without HTML/CSS baggage.
 * This is a concrete class that can be instantiated directly for generic elements.
 */
export class TTYElement extends Element {
  // HappyDOM provides the style property automatically
  private _ttyFocused = false;
  private _ttyFocusable = false;
  public bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  public yogaNode?: Yoga.Node;
  private _needsRender = true;

  constructor() {
    super();
    // Yoga nodes will be created by LayoutEngine when needed
  }

  /**
   * TTY-specific style system (not CSS)
   */
  // HappyDOM provides style property automatically via Element base class
  // No need to override - it already has proper CSSStyleDeclaration

  /**
   * Mark element as needing re-render
   */
  markForRender(): void {
    this._needsRender = true;

    // Bubble up to trigger document re-render
    if (this.ownerDocument) {
      const event = new Event('tty:needsRender', { bubbles: true });
      this.dispatchEvent(event);
    }
  }

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
   * Check if element needs rendering
   */
  get needsRender(): boolean {
    return this._needsRender;
  }

  /**
   * Clear the needs render flag
   */
  clearRenderFlag(): void {
    this._needsRender = false;
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

    const style = this._ttyStyle;

    // Map TTY styles to Yoga properties
    if (style.display === 'flex') {
      // yogaNode.setDisplay(Yoga.DISPLAY_FLEX);
    }

    if (style.flexDirection) {
      // Map flex direction values
    }

    if (typeof style.width === 'number') {
      // yogaNode.setWidth(style.width);
    }

    if (typeof style.height === 'number') {
      // yogaNode.setHeight(style.height);
    }

    // TODO: Complete Yoga integration
  }

  /**
   * Calculate text styling for terminal output using computed styles
   */
  protected getTextStyle(): Partial<Cell> {
    // Use computed style which includes inheritance
    const style = (this as any).computedStyle || this._ttyStyle;

    return {
      fgColor: style.color,
      bgColor: style.backgroundColor,
      bold: style.fontWeight === 'bold',
      italic: style.fontStyle === 'italic',
      underline: style.textDecoration === 'underline'
    };
  }

  /**
   * Get computed padding as [top, right, bottom, left]
   */
  protected getPadding(): [number, number, number, number] {
    const padding = this._ttyStyle.padding;

    if (typeof padding === 'number') {
      return [padding, padding, padding, padding];
    }

    if (Array.isArray(padding)) {
      return padding;
    }

    return [0, 0, 0, 0];
  }

  /**
   * Get computed margin as [top, right, bottom, left]
   */
  protected getMargin(): [number, number, number, number] {
    const margin = this._ttyStyle.margin;

    if (typeof margin === 'number') {
      return [margin, margin, margin, margin];
    }

    if (Array.isArray(margin)) {
      return margin;
    }

    return [0, 0, 0, 0];
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
   * Render this element to the screen buffer
   * Base implementation handles background color and basic styling
   */
  renderSelf(buffer: ScreenBuffer): void {
    // Generic TTY elements render their background and apply basic styling
    if (this.bounds && (this.style.backgroundColor || this.style.color)) {
      const { x, y, width, height } = this.bounds;
      
      // Fill background if specified
      if (this.style.backgroundColor) {
        buffer.fill(
          { x, y, width, height },
          ' ', // Space character for background fill
          { bgColor: this.style.backgroundColor }
        );
      }
      
      // If element has text content, render it
      if (this.textContent) {
        buffer.put(x, y, this.textContent, {
          fgColor: this.style.color,
          bgColor: this.style.backgroundColor,
          bold: this.style.fontWeight === 'bold',
          italic: this.style.fontStyle === 'italic',
          underline: this.style.textDecoration === 'underline'
        });
      }
    }
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

  /**
   * @deprecated Use standard DOM properties instead:
   * 
   * // For all child nodes (including text):
   * for (const child of element.childNodes) { ... }
   * 
   * // For element children only:
   * const elements = Array.from(element.childNodes).filter(child => 
   *   child.nodeType === Node.ELEMENT_NODE
   * ) as TTYElement[];
   * 
   * // Or simply:
   * for (const child of element.children) { ... }
   */
  getTTYChildren(): TTYElement[] {
    return Array.from(this.childNodes).filter(child => 
      child.nodeType === Node.ELEMENT_NODE
    ) as TTYElement[];
  }

  /**
   * Override appendChild to trigger re-render
   */
  override appendChild<T extends Node>(child: T): T {
    super.appendChild(child);
    this.markForRender();
    return child;
  }

  /**
   * Override removeChild to trigger re-render
   */
  override removeChild<T extends Node>(child: T): T {
    super.removeChild(child);
    this.markForRender();
    return child;
  }

  // Note: textContent setter/getter inherited from Element
  // Re-render is triggered via mutation observers or explicit calls
}