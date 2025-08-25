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
import type { DOMWindow } from 'jsdom';
import { RectUtils } from '../layout/RectUtils.js';

// Use ReturnType to match Element's getClientRects return type
type ClientRectsReturnType = ReturnType<Element['getClientRects']>;

// Symbol properties for storing layout data (following HappyDOM's pattern)
export const ELEMENT_BOUNDS = Symbol('elementBounds'); // Single bounding rect for all elements
export const ELEMENT_RECTS = Symbol('elementRects');   // Multiple rects for inline elements spanning lines
export const ELEMENT_TEXT_RECTS = Symbol('elementTextRects'); // Text content for each rect in ELEMENT_RECTS
export const YOGA_NODE = Symbol('yogaNode');           // Yoga layout node (block/flex elements only)

// Interface for text rectangles with content
export interface TextRect extends DOMRect {
  text: string; // The text content for this line fragment
}

// Type for elements with layout properties
export interface LayoutElement extends HTMLElement {
  [ELEMENT_BOUNDS]?: DOMRect;
  [ELEMENT_RECTS]?: DOMRect[];
  [ELEMENT_TEXT_RECTS]?: TextRect[];
  [YOGA_NODE]?: Yoga.Node;
}

// Augment global DOM types with our extensions
declare global {
	interface Element {
    [ELEMENT_BOUNDS]?: DOMRect;
    [ELEMENT_RECTS]?: DOMRect[];
    [ELEMENT_TEXT_RECTS]?: TextRect[];
    [YOGA_NODE]?: Yoga.Node;
	}

  // Document already has elementFromPoint, but JSDOM returns null by default
  // We'll override it with our layout-powered implementation
}

/**
 * Initialize HTML extensions by monkey-patching HTMLElement prototype
 * This should be called once at module initialization
 */
export function initializeHTMLExtensions(window: DOMWindow): void {
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
   * For elements with multiple rects (inline elements spanning lines),
   * returns the bounding box that encompasses all rects.
   */
  HTMLElement.prototype.getBoundingClientRect = function(this: HTMLElement): DOMRect {
    // If element is not in document, return empty rect (like browsers do)
    if (!this.isConnected) {
      return new DOMRect(0, 0, 0, 0);
    }

    // Process any pending mutations first (like browsers do)
    const processPendingMutations = (window as any)._processPendingMutations;
    const computeLayoutIfNeeded = (window as any)._computeLayoutIfNeeded;

    if (processPendingMutations) {
      processPendingMutations();
    }

    // Now compute layout only if there are dirty nodes
    if (computeLayoutIfNeeded) {
      computeLayoutIfNeeded();
    }

    // Check for multiple rects first (inline elements)
    if (this[ELEMENT_RECTS] && this[ELEMENT_RECTS].length > 0) {
      return RectUtils.computeBoundingRect(this[ELEMENT_RECTS], window);
    }

    // Fall back to single rect (block/flex elements)
    if (!this[ELEMENT_BOUNDS]) {
      throw new Error('Layout computation did not set ELEMENT_BOUNDS for element');
    }

    return this[ELEMENT_BOUNDS];
  };

  /**
   * Get all client rectangles for this element
   * For inline elements spanning multiple lines, returns multiple rects.
   * For block elements, returns single rect.
   */
  HTMLElement.prototype.getClientRects = function(): ClientRectsReturnType {
    // If element is not in document, return empty list
    if (!this.isConnected) {
      return RectUtils.createDOMRectList([]) as ClientRectsReturnType;
    }

    // Process mutations and compute layout (same as getBoundingClientRect)
    const processPendingMutations = (window as any)._processPendingMutations;
    const computeLayoutIfNeeded = (window as any)._computeLayoutIfNeeded;

    if (processPendingMutations) {
      processPendingMutations();
    }

    if (computeLayoutIfNeeded) {
      computeLayoutIfNeeded();
    }

    // Return multiple rects if available (inline elements)
    if (this[ELEMENT_RECTS] && this[ELEMENT_RECTS].length > 0) {
      return RectUtils.createDOMRectList(this[ELEMENT_RECTS]) as ClientRectsReturnType;
    }

    // Fall back to single rect (block/flex elements)
    if (this[ELEMENT_BOUNDS]) {
      return RectUtils.createDOMRectList([this[ELEMENT_BOUNDS]]) as ClientRectsReturnType;
    }

    // No layout computed yet
    throw new Error('Layout computation did not set element bounds');
  };

  // === Offset Properties ===

  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    get: function(this: HTMLElement) {
      if (!this.isConnected) return 0;
      return this.getBoundingClientRect().x;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    get: function(this: HTMLElement) {
      if (!this.isConnected) return 0;
      return this.getBoundingClientRect().y;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get: function(this: HTMLElement) {
      if (!this.isConnected) return 0;
      return this.getBoundingClientRect().width;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get: function(this: HTMLElement) {
      if (!this.isConnected) return 0;
      return this.getBoundingClientRect().height;
    },
    enumerable: true,
    configurable: true
  });

  // === Client Properties ===

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    get: function(this: HTMLElement) {
      if (!this.isConnected) return 0;
      // For terminals, client area is same as offset (no borders/scrollbars)
      return this.getBoundingClientRect().width;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    get: function(this: HTMLElement) {
      if (!this.isConnected) return 0;
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
    // Process any pending mutations first (like browsers do)
    const window = this.defaultView!;
    const processPendingMutations = (window as any)._processPendingMutations;
    const computeLayoutIfNeeded = (window as any)._computeLayoutIfNeeded;

    if (processPendingMutations) {
      processPendingMutations();
    }

    // Now compute layout only if there are dirty nodes
    if (computeLayoutIfNeeded) {
      computeLayoutIfNeeded();
    }

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
 * Helper function to find element at specific point using getClientRects
 * Performs depth-first search to find the deepest element at coordinates
 */
function findElementAtPoint(element: Element, x: number, y: number): Element | null {
  // Skip non-HTMLElements (text nodes, etc.)
  if (element.nodeType !== 1) {
    return null;
  }

  const htmlElement = element;

  // Use getClientRects for accurate hit-testing (handles multi-rect inline elements)
  try {
    const rects = htmlElement.getClientRects();
    if (!RectUtils.isPointInAnyRect(x, y, rects)) {
      return null;
    }
  } catch (error) {
    // Element doesn't have layout computed yet, skip it
    return null;
  }

  // Check children first (deepest first)
  const children = Array.from(element.children);
  for (const child of children) {
    const result = findElementAtPoint(child, x, y);
    if (result) {
      return result;
    }
  }

  // If no child contains the point, this element is the target
  return element;
}

// Point-in-rect logic moved to RectUtils class
