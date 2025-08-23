/**
 * HTML Extensions - Monkey-patch HTMLElement with Yoga layout capabilities
 * 
 * This module extends HappyDOM's HTMLElement with terminal layout APIs,
 * enabling standard HTML elements to work seamlessly with Yoga layout engine.
 * 
 * Following HappyDOM's pattern of using Symbol properties for private data.
 */

import { HTMLElement, DOMRect } from 'happy-dom';
import type * as Yoga from 'yoga-layout';

// Symbol properties for storing Yoga layout data (following HappyDOM's pattern)
export const YOGA_BOUNDS = Symbol('yogaBounds');
export const YOGA_NODE = Symbol('yogaNode');

// Extend HTMLElement interface to include our Symbol properties
declare global {
  namespace globalThis {
    interface HTMLElement {
      [YOGA_BOUNDS]?: DOMRect;
      [YOGA_NODE]?: Yoga.Node;
    }
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
  HTMLElement.prototype.getBoundingClientRect = function(): DOMRect {
    return this[YOGA_BOUNDS] || new DOMRect(0, 0, 0, 0);
  };

  /**
   * For inline elements that may span multiple lines
   * Currently returns single rect, but extensible for text wrapping
   */
  HTMLElement.prototype.getClientRects = function(): DOMRectList {
    const rect = this.getBoundingClientRect();
    return {
      length: 1,
      item: (index: number) => index === 0 ? rect : null,
      [Symbol.iterator]: function* () { yield rect; },
      0: rect
    } as DOMRectList;
  };

  // === Offset Properties ===
  
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    get: function() {
      return this.getBoundingClientRect().x;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    get: function() {
      return this.getBoundingClientRect().y;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get: function() {
      return this.getBoundingClientRect().width;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get: function() {
      return this.getBoundingClientRect().height;
    },
    enumerable: true,
    configurable: true
  });

  // === Client Properties ===
  
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    get: function() {
      // For terminals, client area is same as offset (no borders/scrollbars)
      return this.getBoundingClientRect().width;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    get: function() {
      // For terminals, client area is same as offset (no borders/scrollbars)
      return this.getBoundingClientRect().height;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'clientLeft', {
    get: function() {
      // No borders in terminal context
      return 0;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'clientTop', {
    get: function() {
      // No borders in terminal context
      return 0;
    },
    enumerable: true,
    configurable: true
  });

  // === Scroll Properties ===
  
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    get: function() {
      // TODO: Return actual content width when scrolling is implemented
      return this.clientWidth;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    get: function() {
      // TODO: Return actual content height when scrolling is implemented  
      return this.clientHeight;
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    get: function() {
      // TODO: Implement when we add scrolling
      return 0;
    },
    set: function(_value: number) {
      // TODO: Implement when we add scrolling
    },
    enumerable: true,
    configurable: true
  });

  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    get: function() {
      // TODO: Implement when we add scrolling
      return 0;
    },
    set: function(_value: number) {
      // TODO: Implement when we add scrolling
    },
    enumerable: true,
    configurable: true
  });
}