/**
 * TOM Element - Base class for all TOM elements
 * 
 * Extends HappyDOM's Element but bypasses HTML/CSS behavior to create
 * terminal-specific elements with custom styling and rendering.
 */

import { Element } from 'happy-dom';
import { ScreenBuffer, Cell, Rect } from '../rendering/ScreenBuffer.js';
import type * as Yoga from 'yoga-layout';

export interface TOMStyle {
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
 * Base TOM element class - extends HappyDOM Element but NOT HTMLElement
 * This gives us the DOM tree structure and events without HTML/CSS baggage
 */
export abstract class TOMElement extends Element {
  private _tomStyle: TOMStyle = {};
  private _tomFocused = false;
  private _tomFocusable = false;
  public bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  public yogaNode?: Yoga.Node;
  private _needsRender = true;
  
  constructor() {
    super();
    // Yoga nodes will be created by LayoutEngine when needed
  }

  /**
   * TOM-specific style system (not CSS)
   */
  get style(): TOMStyle {
    return { ...this._tomStyle };
  }
  
  set style(value: TOMStyle) {
    this._tomStyle = { ...value };
    this.markForRender();
    this.updateYogaStyles();
  }

  /**
   * Mark element as needing re-render
   */
  markForRender(): void {
    this._needsRender = true;
    
    // Bubble up to trigger document re-render
    if (this.ownerDocument) {
      const event = new CustomEvent('tom:needsRender', { bubbles: true });
      this.dispatchEvent(event);
    }
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
    
    const style = this._tomStyle;
    
    // Map TOM styles to Yoga properties
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
    const style = this.computedStyle || this._tomStyle;
    
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
    const padding = this._tomStyle.padding;
    
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
    const margin = this._tomStyle.margin;
    
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
   * Abstract method: each element renders itself
   */
  abstract renderSelf(buffer: ScreenBuffer): void;

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
  tomIsFocused(): boolean {
    return this._tomFocused;
  }

  tomSetFocused(focused: boolean): void {
    this._tomFocused = focused;
  }

  tomIsFocusable(): boolean {
    return this._tomFocusable;
  }

  tomSetFocusable(focusable: boolean): void {
    this._tomFocusable = focusable;
  }

  /**
   * Get all TOM children (filters out non-TOM nodes)
   */
  getTOMChildren(): TOMElement[] {
    const children: TOMElement[] = [];
    
    for (const child of this.children) {
      if (child instanceof TOMElement) {
        children.push(child);
      }
    }
    
    return children;
  }

  /**
   * Override appendChild to trigger re-render
   */
  appendChild<T extends Node>(child: T): T {
    const result = super.appendChild(child);
    this.markForRender();
    return result;
  }

  /**
   * Override removeChild to trigger re-render
   */
  removeChild<T extends Node>(child: T): T {
    const result = super.removeChild(child);
    this.markForRender();
    return result;
  }

  /**
   * Set text content and trigger re-render
   */
  set textContent(value: string | null) {
    super.textContent = value;
    this.markForRender();
  }

  get textContent(): string | null {
    return super.textContent;
  }
}