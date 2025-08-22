/**
 * TOM Element - Composition-based approach
 * 
 * Instead of extending HappyDOM's Element, we compose with it.
 * This gives us all DOM functionality while keeping TOM logic separate.
 */

import { ScreenBuffer, Cell, Rect } from '../rendering/ScreenBuffer.js';
import type * as Yoga from 'yoga-layout';

export interface TOMStyle {
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

/**
 * TOM data attached to DOM elements
 */
export interface TOMData {
  style: TOMStyle;
  bounds: Rect;
  yogaNode?: Yoga.Node;
  needsRender: boolean;
  renderSelf: (buffer: ScreenBuffer) => void;
}

// Symbol to store TOM data on DOM elements
export const TOM_DATA_SYMBOL = Symbol('tom-data');

/**
 * Helper functions for working with TOM elements
 */
export class TOMElement {
  /**
   * Attach TOM data to a DOM element
   */
  static attachTOMData(element: Element, renderFn: (buffer: ScreenBuffer) => void): void {
    const tomData: TOMData = {
      style: {},
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      needsRender: true,
      renderSelf: renderFn
    };
    
    (element as any)[TOM_DATA_SYMBOL] = tomData;
    
    // Add TOM-specific properties to the element
    Object.defineProperties(element, {
      style: {
        get: () => ({ ...tomData.style }),
        set: (value: TOMStyle) => {
          tomData.style = { ...value };
          TOMElement.markForRender(element);
        },
        configurable: true
      },
      bounds: {
        get: () => tomData.bounds,
        set: (value: Rect) => {
          tomData.bounds = value;
          TOMElement.markForRender(element);
        },
        configurable: true
      }
    });
  }

  /**
   * Check if element has TOM data
   */
  static isTOMElement(element: Element): boolean {
    return TOM_DATA_SYMBOL in element;
  }

  /**
   * Get TOM data from element
   */
  static getTOMData(element: Element): TOMData | null {
    return (element as any)[TOM_DATA_SYMBOL] || null;
  }

  /**
   * Mark element for re-render
   */
  static markForRender(element: Element): void {
    const tomData = TOMElement.getTOMData(element);
    if (tomData) {
      tomData.needsRender = true;
      
      // Dispatch event for document to pick up
      const event = new CustomEvent('tom:needsRender', { bubbles: true });
      element.dispatchEvent(event);
    }
  }

  /**
   * Render an element
   */
  static render(element: Element, buffer: ScreenBuffer): void {
    const tomData = TOMElement.getTOMData(element);
    if (tomData && tomData.style.display !== 'none') {
      tomData.renderSelf(buffer);
      tomData.needsRender = false;
    }
  }

  /**
   * Get all TOM children of an element
   */
  static getTOMChildren(element: Element): Element[] {
    const children: Element[] = [];
    
    for (const child of element.children) {
      if (TOMElement.isTOMElement(child)) {
        children.push(child);
      }
    }
    
    return children;
  }

  /**
   * Calculate text styling for terminal output
   */
  static getTextStyle(element: Element): Partial<Cell> {
    const tomData = TOMElement.getTOMData(element);
    if (!tomData) return {};
    
    const style = tomData.style;
    
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
  static getPadding(element: Element): [number, number, number, number] {
    const tomData = TOMElement.getTOMData(element);
    if (!tomData) return [0, 0, 0, 0];
    
    const padding = tomData.style.padding;
    
    if (typeof padding === 'number') {
      return [padding, padding, padding, padding];
    }
    
    if (Array.isArray(padding)) {
      return padding;
    }
    
    return [0, 0, 0, 0];
  }

  /**
   * Calculate content area (bounds minus padding)
   */
  static getContentArea(element: Element): Rect {
    const tomData = TOMElement.getTOMData(element);
    if (!tomData) return { x: 0, y: 0, width: 0, height: 0 };
    
    const [padTop, padRight, padBottom, padLeft] = TOMElement.getPadding(element);
    const bounds = tomData.bounds;
    
    return {
      x: bounds.x + padLeft,
      y: bounds.y + padTop,
      width: Math.max(0, bounds.width - padLeft - padRight),
      height: Math.max(0, bounds.height - padTop - padBottom)
    };
  }

  /**
   * Check if point is within element bounds
   */
  static containsPoint(element: Element, x: number, y: number): boolean {
    const tomData = TOMElement.getTOMData(element);
    if (!tomData) return false;
    
    const bounds = tomData.bounds;
    return (
      x >= bounds.x &&
      x < bounds.x + bounds.width &&
      y >= bounds.y &&
      y < bounds.y + bounds.height
    );
  }
}