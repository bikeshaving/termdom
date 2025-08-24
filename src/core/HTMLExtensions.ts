/**
 * HTML Extensions - Monkey-patch HTMLElement with Yoga layout capabilities
 * 
 * This module extends HappyDOM's HTMLElement with terminal layout APIs,
 * enabling standard HTML elements to work seamlessly with Yoga layout engine.
 * 
 * Following HappyDOM's pattern of using Symbol properties for private data.
 */

// JSDOM provides standard DOM types that are compatible with lib.dom.d.ts
import type * as Yoga from 'yoga-layout';
import { HTMLElement as DOMHTMLElement } from '../dom.js';

// Use ReturnType to match Element's getClientRects return type
type ClientRectsReturnType = ReturnType<Element['getClientRects']>;

// Symbol properties for storing Yoga layout data (following HappyDOM's pattern)
export const YOGA_BOUNDS = Symbol('yogaBounds');
export const YOGA_NODE = Symbol('yogaNode');

// Type for elements with Yoga properties
export interface YogaElement extends HTMLElement {
  [YOGA_BOUNDS]?: DOMRect;
  [YOGA_NODE]?: Yoga.Node;
}

// Augment global DOM types with our extensions
declare global {
  interface HTMLElement {
    [YOGA_BOUNDS]?: DOMRect;
    [YOGA_NODE]?: Yoga.Node;
  }

  // Document already has elementFromPoint, but JSDOM returns null by default
  // We'll override it with our Yoga-powered implementation
}

/**
 * Initialize HTML extensions by monkey-patching HTMLElement prototype
 * This should be called once at module initialization
 */
export function initializeHTMLExtensions(window: Window & typeof globalThis): void {
  const { HTMLElement, Document, DOMRect } = window;
  // Prevent double initialization
  if ((HTMLElement.prototype as any)._ttyomExtended) {
    return;
  }

  // Mark as extended to prevent double patching
  (HTMLElement.prototype as any)._ttyomExtended = true;

  // === DOM Layout APIs (Yoga-powered) ===

  /**
   * Get element bounds as DOMRect
   * This is the main layout API that integrates with Yoga layout engine
   */
  HTMLElement.prototype.getBoundingClientRect = function(this: HTMLElement): DOMRect {
    // If bounds are already computed, return them
    if (this[YOGA_BOUNDS]) {
      return this[YOGA_BOUNDS];
    }
    
    // Trigger layout computation on-demand (like browsers do)
    const document = this.ownerDocument;
    if (document && document.defaultView) {
      // Find the layout engine from the document's window
      const layoutEngine = (document.defaultView as any)._layoutEngine;
      if (layoutEngine) {
        // Compute layout from root element (document.documentElement)
        const termSize = (document.defaultView as any)._terminalSize || { columns: 80, rows: 24 };
        layoutEngine.computeLayout(document.documentElement, termSize.columns, termSize.rows);
      }
    }
    
    return this[YOGA_BOUNDS] || new DOMRect(0, 0, 0, 0);
  };

  /**
   * For inline elements that may span multiple lines
   * Currently returns single rect, but extensible for text wrapping
   */
  HTMLElement.prototype.getClientRects = function(): ClientRectsReturnType {
    const rect = this.getBoundingClientRect();
    // Since DOMRectList extends Array<DOMRect>, we can create it properly
    const rectArray = [rect];
    // Add the item method to match DOMRectList interface
    (rectArray as any).item = (index: number) => index === 0 ? rect : null;
    return rectArray as ClientRectsReturnType;
  };

  // === Offset Properties ===
  
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    get: function(this: HTMLElement) {
      return this.getBoundingClientRect().x;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    get: function(this: HTMLElement) {
      return this.getBoundingClientRect().y;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get: function(this: HTMLElement) {
      return this.getBoundingClientRect().width;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get: function(this: HTMLElement) {
      return this.getBoundingClientRect().height;
    },
    enumerable: true,
    configurable: true
  });

  // === Client Properties ===
  
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    get: function(this: HTMLElement) {
      // For terminals, client area is same as offset (no borders/scrollbars)
      return this.getBoundingClientRect().width;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    get: function(this: HTMLElement) {
      // For terminals, client area is same as offset (no borders/scrollbars)
      return this.getBoundingClientRect().height;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'clientLeft', {
    get: function(this: HTMLElement) {
      // No borders in terminal context
      return 0;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'clientTop', {
    get: function(this: HTMLElement) {
      // No borders in terminal context
      return 0;
    },
    enumerable: true,
    configurable: true
  });

  // === Scroll Properties ===
  
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    get: function(this: HTMLElement) {
      // TODO: Return actual content width when scrolling is implemented
      return this.clientWidth;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    get: function(this: HTMLElement) {
      // TODO: Return actual content height when scrolling is implemented  
      return this.clientHeight;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    get: function(this: HTMLElement) {
      // TODO: Implement when we add scrolling
      return 0;
    },
    set: function(this: HTMLElement, _value: number) {
      // TODO: Implement when we add scrolling
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    get: function(this: HTMLElement) {
      // TODO: Implement when we add scrolling
      return 0;
    },
    set: function(this: HTMLElement, _value: number) {
      // TODO: Implement when we add scrolling
    },
    enumerable: true,
    configurable: true
  });

  // === Document API Extensions ===
  
  /**
   * elementFromPoint - Find element at specific coordinates using Yoga layout
   * This is the core API that TTYEventTranslator will use for hit testing
   */
  Document.prototype.elementFromPoint = function(x: number, y: number): Element | null {
    return findElementAtPoint(this.documentElement, x, y);
  };

  // === Element Navigation APIs ===
  
  /**
   * Check if this element contains another element
   */
  HTMLElement.prototype.contains = function(other: Node | null): boolean {
    if (!other || other === this) return other === this;
    
    let current: Node | null = other;
    while (current && current !== this) {
      current = current.parentNode;
    }
    return current === this;
  };

  /**
   * Find closest ancestor matching selector
   * For now, just supports simple tag name selectors
   */
  HTMLElement.prototype.closest = function(selector: string): Element | null {
    let current: Element | null = this;
    
    // Simple tag name matching (can be enhanced later)
    const tagName = selector.toUpperCase();
    
    while (current) {
      if (current.tagName === tagName) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  };
}

/**
 * Helper function to find element at specific point using YOGA_BOUNDS
 * Performs depth-first search to find the deepest element at coordinates
 */
function findElementAtPoint(element: Element, x: number, y: number): Element | null {
  if (!(element instanceof DOMHTMLElement)) {
    return null;
  }

  const bounds = element[YOGA_BOUNDS];
  if (!bounds || !isPointInRect(x, y, bounds)) {
    return null;
  }

  // Check children first (deepest first)
  const children = Array.from(element.children) as HTMLElement[];
  for (const child of children) {
    const result = findElementAtPoint(child, x, y);
    if (result) {
      return result;
    }
  }

  // If no child contains the point, this element is the target
  return element;
}

/**
 * Check if point is inside rectangle
 */
function isPointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.x && 
         x < rect.x + rect.width && 
         y >= rect.y && 
         y < rect.y + rect.height;
}