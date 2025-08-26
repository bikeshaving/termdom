// === HTML-to-Terminal API ===
export { TermDOM } from './core/createTTYDocument.js';
export type { TTYDocumentOptions, TTYResult } from './core/createTTYDocument.js';
export { initializeHTMLExtensions, ELEMENT_BOUNDS, ELEMENT_RECTS, YOGA_NODE } from './core/HTMLExtensions.js';

// Event System
export { TTYEventTranslator } from './events/TTYEventTranslator.js';
export type { TTYEventTranslatorOptions } from './events/TTYEventTranslator.js';

// 🚀 Direct ANSI Rendering Pipeline (deprecated - use ScreenBuffer)
// export { DirectTTYRenderer } from './rendering/DirectTTYRenderer.js';

// ScreenBuffer - Terminal rendering engine
export { ScreenBuffer } from './rendering/ScreenBuffer.js';
export type { Cell, ScreenBufferOptions } from './rendering/ScreenBuffer.js';

// DirectBuffer - Virtual scrollback buffer implementation
export { DirectBuffer } from './rendering/DirectBuffer.js';

// Renderer - Efficient delta rendering without xterm.js
export { Renderer } from './rendering/Renderer.js';
export type { CellStyle } from './rendering/Renderer.js';
export { ANSIGenerator } from './rendering/ANSIGenerator.js';
export type { ColorDepth } from './rendering/ANSIGenerator.js';

// Cell buffer utilities
export { 
  createBuffer, createNullCell, isCellEmpty,
  getCellChar, getCellWidth, setCellChar, setCellFg, setCellBg,
  type Cell, type CellBuffer
} from './rendering/CellBuffer.js';

// Layout Engine
export { LayoutEngine } from './layout/LayoutEngine.js';

// Runtime Implementations
export { BunTTYRuntime } from './runtime/BunTTYRuntime.js';
export { MockTTYRuntime } from './runtime/MockTTYRuntime.js';
export { TTYRuntime } from './core/TTYRuntime.js';
export type { TTYDimensions, TTYCapabilities, TTYKeyEvent, TTYMouseEvent, CellStyleOptions } from './core/TTYRuntime.js';
