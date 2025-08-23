/**
 * TTY Object Model (TTYOM) - Main export
 * 
 * Revolutionary DOM-like API for terminal user interfaces.
 * Brings familiar web development patterns to terminal applications.
 */

// === New TTY Core Classes ===
export { TTYWindow } from './core/TTYWindow.js';
export { TTYDocument } from './core/TTYDocument.js';
export { TTYElement } from './core/TTYElement.js';
export { TTYRuntime, detectTTYRuntime } from './core/TTYRuntime.js';

// TTY Runtime Implementations
export { BunTTYRuntime } from './runtime/BunTTYRuntime.js';
export { MockTTYRuntime } from './runtime/MockTTYRuntime.js';

// === Legacy TOM Classes (for backward compatibility during transition) ===
export { TTYWindow as TOMWindow } from './core/TTYWindow.js';
export { TTYDocument as TOMDocument } from './core/TTYDocument.js';
export { TTYElement as TOMElement } from './core/TTYElement.js';
// export { TOMRenderer } from './core/TOMRenderer.js';

// Element types (temporarily disabled)
// export { TOMContainer } from './elements/TOMContainer.js';
// export { TOMText } from './elements/TOMText.js';
// export { TOMButton } from './elements/TOMButton.js';

// Rendering
export { ScreenBuffer } from './rendering/ScreenBuffer.js';
export type { Cell, Rect, ScreenBufferOptions } from './rendering/ScreenBuffer.js';

// Layout (temporarily disabled during rename)
// export { LayoutEngine } from './layout/LayoutEngine.js';

// Styling
export type { TTYStyle } from './core/TTYElement.js';
// export type { TOMStyle } from './core/TOMElement.js'; // Legacy - temporarily disabled
// export { computeEffectiveStyle, isInheritableProperty, getInheritedValue } from './core/StyleInheritance.js';

// Types
export type { TTYWindowOptions } from './core/TTYWindow.js';
export type { TTYDocumentOptions } from './core/TTYDocument.js';
export type { 
  TTYDimensions, 
  TTYCapabilities, 
  TTYKeyEvent, 
  TTYMouseEvent 
} from './core/TTYRuntime.js';

// Legacy types (temporarily disabled)
// export type { TOMWindowOptions } from './core/TOMWindow.js';
// export type { TOMDocumentOptions } from './core/TOMDocument.js';
// export type { TOMMouseEvent, TOMKeyboardEvent } from './core/TOMRenderer.js';
// export type { ButtonState } from './elements/TOMButton.js';

/**
 * Create a new TTY window - the modern entry point for TTYOM applications
 * Auto-detects runtime environment (Bun/Node/Deno) and provides clean Web Streams API
 * 
 * @example
 * ```typescript
 * // Simple usage with auto-detection
 * const tty = createTTYWindow();
 * 
 * // With custom runtime for testing
 * const mockRuntime = new MockTTYRuntime();
 * const tty = createTTYWindow({ runtime: mockRuntime });
 * ```
 */
export function createTTYWindow(options?: import('./core/TTYWindow.js').TTYWindowOptions): import('./core/TTYWindow.js').TTYWindow {
  const { TTYWindow } = require('./core/TTYWindow.js');
  return new TTYWindow(options);
}

// Legacy factory functions (for backward compatibility during transition)
/**
 * Create a new TOM window (legacy - use createTTYWindow() instead)
 * @deprecated Use `createTTYWindow()` instead for better architecture and Web Streams support
 */
export function createTOM(options?: import('./core/TTYWindow.js').TTYWindowOptions): import('./core/TTYWindow.js').TTYWindow {
  // Redirect to new TTY implementation
  return createTTYWindow(options);
}