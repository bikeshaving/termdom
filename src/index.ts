/**
 * TTY Object Model (TTYOM) - HTML-to-Terminal Renderer
 * 
 * Revolutionary approach: Use familiar HTML/CSS to create terminal UIs!
 * Write standard HTML elements with CSS styling, render to ANSI terminal output.
 */

// === New HTML-to-Terminal API ===
export { createTTYDocument, createTTYDocumentWithAutoRender } from './core/createTTYDocument.js';
export type { TTYDocumentOptions, TTYDocumentResult } from './core/createTTYDocument.js';
export { initializeHTMLExtensions, YOGA_BOUNDS, YOGA_NODE } from './core/HTMLExtensions.js';

// TTY Runtime (terminal-specific functionality)
export { TTYRuntime, detectTTYRuntime } from './core/TTYRuntime.js';
export { BunTTYRuntime } from './runtime/BunTTYRuntime.js';
export { MockTTYRuntime } from './runtime/MockTTYRuntime.js';

// Rendering Pipeline
export { ScreenBuffer } from './rendering/ScreenBuffer.js';
export type { Cell, ScreenBufferOptions } from './rendering/ScreenBuffer.js';

// Layout Engine
export { LayoutEngine } from './layout/LayoutEngine.js';

// Core Types
export type { 
  TTYDimensions, 
  TTYCapabilities, 
  TTYKeyEvent, 
  TTYMouseEvent 
} from './core/TTYRuntime.js';

// === Backwards Compatibility (DEPRECATED) ===
// Legacy API - use createTTYDocument() for new projects

import { Window, PropertySymbol } from 'happy-dom';
// @ts-ignore - NodeFactory not exported from main module
import NodeFactory from 'happy-dom/lib/nodes/NodeFactory.js';
import { createTTYDocument } from './core/createTTYDocument.js';

// Temporary stub for backwards compatibility
// TODO: Remove in next major version
export function createTTY(options: any = {}): any {
  console.warn('DEPRECATED: createTTY() is deprecated. Use createTTYDocument() instead for HTML-based terminal UIs.');
  
  // For now, delegate to new API but this will be removed
  const { document, runtime, render, dispose } = createTTYDocument(options);
  
  return {
    document,
    runtime,
    render,
    dispose,
    // Legacy compatibility methods
    createElement: (tagName: string) => document.createElement(tagName),
    appendChild: (child: any) => document.body.appendChild(child),
    [Symbol.dispose]: dispose
  };
}

