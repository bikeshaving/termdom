/**
 * TOM (Terminal Object Model) - Main export
 * 
 * Revolutionary DOM-like API for terminal user interfaces.
 * Brings familiar web development patterns to terminal applications.
 */

// Core classes
export { TOMWindow } from './core/TOMWindow.js';
export { TOMDocument } from './core/TOMDocument.js';
export { TOMElement } from './core/TOMElement.js';
export { TOMRenderer } from './core/TOMRenderer.js';

// Element types
export { TOMContainer } from './elements/TOMContainer.js';
export { TOMText } from './elements/TOMText.js';
export { TOMButton } from './elements/TOMButton.js';

// Rendering
export { ScreenBuffer } from './rendering/ScreenBuffer.js';
export type { Cell, Rect, ScreenBufferOptions } from './rendering/ScreenBuffer.js';

// Layout
export { LayoutEngine } from './layout/LayoutEngine.js';

// Styling
export type { TOMStyle } from './core/TOMElement.js';
export { computeEffectiveStyle, isInheritableProperty, getInheritedValue } from './core/StyleInheritance.js';

// Types
export type { TOMWindowOptions } from './core/TOMWindow.js';
export type { TOMDocumentOptions } from './core/TOMDocument.js';
export type { TOMMouseEvent, TOMKeyboardEvent } from './core/TOMRenderer.js';
export type { ButtonState } from './elements/TOMButton.js';

/**
 * Create a new TOM document (legacy - use createTOM instead)
 */
export function createDocument(options?: import('./core/TOMDocument.js').TOMDocumentOptions) {
  const { TOMDocument } = require('./core/TOMDocument.js');
  return new TOMDocument(options);
}

/**
 * Create a new TOM window - the main entry point for TOM applications
 * Returns a window-like object with DOM APIs and automatic cleanup support
 */
export function createTOM(options?: import('./core/TOMWindow.js').TOMWindowOptions): import('./core/TOMWindow.js').TOMWindow {
  const { TOMWindow } = require('./core/TOMWindow.js');
  return new TOMWindow(options);
}