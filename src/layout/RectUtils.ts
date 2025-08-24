/**
 * Rect Utilities - DOM rectangle manipulation and computation
 * 
 * Provides utilities for working with DOMRect objects, including merging
 * multiple rects into bounding rectangles and hit-testing operations.
 */

import { DOMRect, DOMRectList } from '../dom.js';

/**
 * Utility class for DOMRect operations
 */
export class RectUtils {
  /**
   * Compute bounding rectangle that encompasses all input rectangles
   * 
   * This is used to implement getBoundingClientRect() for elements that
   * span multiple rectangles (e.g., inline elements that wrap across lines).
   * 
   * @param rects Array or DOMRectList of rectangles to merge
   * @returns Single DOMRect that bounds all input rects
   */
  static computeBoundingRect(rects: DOMRect[] | DOMRectList): DOMRect {
    const rectArray: DOMRect[] = Array.from(rects) as DOMRect[];
    
    if (rectArray.length === 0) {
      return new DOMRect(0, 0, 0, 0);
    }
    
    if (rectArray.length === 1) {
      return rectArray[0];
    }
    
    let minLeft = Infinity;
    let minTop = Infinity; 
    let maxRight = -Infinity;
    let maxBottom = -Infinity;
    
    for (const rect of rectArray) {
      minLeft = Math.min(minLeft, rect.left);
      minTop = Math.min(minTop, rect.top);
      maxRight = Math.max(maxRight, rect.right);
      maxBottom = Math.max(maxBottom, rect.bottom);
    }
    
    return new DOMRect(
      minLeft,
      minTop, 
      maxRight - minLeft,
      maxBottom - minTop
    );
  }

  /**
   * Check if a point intersects with any rectangle in a list
   * 
   * Used for hit-testing against elements that may have multiple rectangles
   * (e.g., inline elements spanning multiple lines).
   * 
   * @param x X coordinate
   * @param y Y coordinate  
   * @param rects Array or DOMRectList of rectangles to test against
   * @returns True if point intersects any rectangle
   */
  static isPointInAnyRect(x: number, y: number, rects: DOMRect[] | DOMRectList): boolean {
    const rectArray: DOMRect[] = Array.from(rects) as DOMRect[];
    return rectArray.some(rect => this.isPointInRect(x, y, rect));
  }

  /**
   * Check if point is inside a single rectangle
   * 
   * @param x X coordinate
   * @param y Y coordinate
   * @param rect Rectangle to test against
   * @returns True if point is inside rectangle
   */
  static isPointInRect(x: number, y: number, rect: DOMRect): boolean {
    return x >= rect.x && 
           x < rect.x + rect.width && 
           y >= rect.y && 
           y < rect.y + rect.height;
  }

  /**
   * Create a proper DOMRectList from an array of DOMRect objects
   * 
   * DOMRectList has specific interface requirements including the item() method.
   * This creates a compliant implementation.
   * 
   * @param rects Array of DOMRect objects
   * @returns DOMRectList-compatible object
   */
  static createDOMRectList(rects: DOMRect[]): DOMRectList {
    const rectList = rects.slice(); // Create copy
    
    // Add the item method to match DOMRectList interface
    (rectList as any).item = (index: number): DOMRect | null => {
      return index >= 0 && index < rectList.length ? rectList[index] : null;
    };
    
    return rectList as any as DOMRectList;
  }
}