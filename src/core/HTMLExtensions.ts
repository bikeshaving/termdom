/**
 * HTML Extensions - Monkey-patch HTMLElement with Yoga layout capabilities
 * 
 * This module extends HappyDOM's HTMLElement with terminal layout APIs,
 * enabling standard HTML elements to work seamlessly with Yoga layout engine.
 * 
 * Following HappyDOM's pattern of using Symbol properties for private data.
 */

import { HTMLElement, DOMRect, Element } from 'happy-dom';
// @ts-ignore - DOMRectList not exported from main module, but we can import it directly
import DOMRectList from 'happy-dom/lib/dom/DOMRectList.js';
import type * as Yoga from 'yoga-layout';

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

// Augment HappyDOM's HTMLElement with our Symbol properties
declare module 'happy-dom' {
  interface HTMLElement {
    [YOGA_BOUNDS]?: DOMRect;
    [YOGA_NODE]?: Yoga.Node;
  }
}

/**
 * Initialize HTML extensions by monkey-patching HTMLElement prototype
 * This should be called once at module initialization
 */
export function initializeHTMLExtensions(): void {
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
}