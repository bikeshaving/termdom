/**
 * TTY Object Model (TTYOM) - HTML-to-Terminal Renderer
 * 
 * Revolutionary approach: Use familiar HTML/CSS to create terminal UIs!
 * Write standard HTML elements with CSS styling, render to ANSI terminal output.
 */

// === HTML-to-Terminal API ===
export { createTTY } from './core/createTTYDocument.js';
export type { TTYDocumentOptions, TTYResult } from './core/createTTYDocument.js';
export { initializeHTMLExtensions, YOGA_BOUNDS, YOGA_NODE } from './core/HTMLExtensions.js';

// TTY Runtime (terminal-specific functionality)
export { TTYRuntime, detectTTYRuntime } from './core/TTYRuntime.js';
export { BunTTYRuntime } from './runtime/BunTTYRuntime.js';
export { MockTTYRuntime } from './runtime/MockTTYRuntime.js';

// Event System
export { TTYEventTranslator } from './events/TTYEventTranslator.js';
export type { TTYEventTranslatorOptions } from './events/TTYEventTranslator.js';

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

// No backwards compatibility - clean modern API only

