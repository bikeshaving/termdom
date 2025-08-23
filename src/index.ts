/**
 * TTY Object Model (TTYOM) - Main export
 * 
 * Revolutionary DOM-like API for terminal user interfaces.
 * Brings familiar web development patterns to terminal applications.
 */

import { Window } from 'happy-dom';
// @ts-ignore - NodeFactory not exported from main module
import NodeFactory from 'happy-dom/lib/nodes/NodeFactory.js';
// @ts-ignore - PropertySymbol not exported from main module
import * as PropertySymbol from 'happy-dom/lib/PropertySymbol.js';
import { TTYTTYElement, type TTYOptions } from './core/TTYTTYElement.js';

// === New TTY Core Classes ===
export { TTYTTYElement } from './core/TTYTTYElement.js';
export { TTYElement } from './core/TTYElement.js';
export { TTYRuntime, detectTTYRuntime } from './core/TTYRuntime.js';


// TTY Runtime Implementations
export { BunTTYRuntime } from './runtime/BunTTYRuntime.js';
export { MockTTYRuntime } from './runtime/MockTTYRuntime.js';

// TTY Elements
export { TTYContainerElement, TTYContainer } from './elements/TTYContainer.js';
export { TTYTextElement } from './elements/TTYTextElement.js';


// Rendering
export { ScreenBuffer } from './rendering/ScreenBuffer.js';
export type { Cell, Rect, ScreenBufferOptions } from './rendering/ScreenBuffer.js';

// Layout
// export { LayoutEngine } from './layout/LayoutEngine.js';

// Types
export type { TTYOptions, ViewportMode } from './core/TTYTTYElement.js';
export type { TTYStyle } from './core/TTYElement.js';
export type { 
  TTYDimensions, 
  TTYCapabilities, 
  TTYKeyEvent, 
  TTYMouseEvent 
} from './core/TTYRuntime.js';


/**
 * Create a new TTY interface - the modern entry point for TTYOM applications
 * Auto-detects runtime environment (Bun/Node/Deno) and provides clean namespace-based API
 * 
 * @example
 * ```typescript
 * // Simple usage with auto-detection
 * const tty = createTTY();
 * const container = tty.createElement('container');
 * tty.appendChild(container);
 * 
 * // With custom options
 * const mockRuntime = new MockTTYRuntime();
 * const tty = createTTY({ runtime: mockRuntime });
 * ```
 */
export function createTTY(options: TTYOptions = {}): TTYTTYElement {
  // Create standard HappyDOM window and document - no custom classes!
  const window = new Window();
  const document = window.document;
  
  // Use factory pattern to create TTY root element (same as TTYDocument._createTTYElement)
  const tty = NodeFactory.createNode(document, TTYTTYElement) as TTYTTYElement;
  
  // Set up the TTY root element with proper DOM properties for HappyDOM compatibility
  tty[PropertySymbol.tagName] = 'TTY';
  tty[PropertySymbol.localName] = 'tty'; 
  tty[PropertySymbol.prefix] = null;
  tty[PropertySymbol.namespaceURI] = null;
  tty[PropertySymbol.isValue] = null;
  
  // Initialize TTY functionality
  tty.initialize(options, document);
  
  // Set up MutationObserver for automatic rendering (from HappyDOM window)
  const observer = new window.MutationObserver((mutations) => {
    let shouldRender = false;
    
    for (const mutation of mutations) {
      // Check if any TTY elements were added, removed, or modified
      if (mutation.type === 'childList') {
        // Check added nodes
        mutation.addedNodes.forEach(node => {
          if (node instanceof TTYTTYElement || 
              (node instanceof Element && node.closest('tty-root'))) {
            shouldRender = true;
          }
        });
        
        // Check removed nodes
        mutation.removedNodes.forEach(node => {
          if (node instanceof TTYTTYElement) {
            // TTY root was removed - dispose it
            (node as TTYTTYElement).dispose();
          } else if (node instanceof Element && node.closest('tty-root')) {
            shouldRender = true;
          }
        });
      }
      
      // Check attribute changes on TTY elements
      if (mutation.type === 'attributes' && 
          mutation.target instanceof Element &&
          mutation.target.closest('tty-root')) {
        shouldRender = true;
      }
    }
    
    // Trigger render if needed
    if (shouldRender) {
      queueMicrotask(() => {
        tty.render();
      });
    }
  });
  
  // Observe the entire document for changes
  observer.observe(document, {
    childList: true,
    attributes: true,
    subtree: true
  });
  
  // Attach TTY root to DOM
  document.body.appendChild(tty);
  
  return tty;
}

