/**
 * TOM (Terminal Object Model) - Main export
 * 
 * Revolutionary DOM-like API for terminal user interfaces.
 * Brings familiar web development patterns to terminal applications.
 */

// Core classes
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
export type { TOMDocumentOptions } from './core/TOMDocument.js';
export type { TOMMouseEvent, TOMKeyboardEvent } from './core/TOMRenderer.js';
export type { ButtonState } from './elements/TOMButton.js';

/**
 * Create a new TOM document
 */
export function createDocument(options?: import('./core/TOMDocument.js').TOMDocumentOptions) {
  const { TOMDocument } = require('./core/TOMDocument.js');
  return new TOMDocument(options);
}

/**
 * Quick start helper - creates document and returns DOM-like API
 */
export function createTOM(options?: import('./core/TOMDocument.js').TOMDocumentOptions) {
  const document = createDocument(options);
  
  return {
    document,
    body: document.body,
    createElement: document.createElement.bind(document),
    querySelector: document.querySelector.bind(document),
    querySelectorAll: document.querySelectorAll.bind(document),
    getElementById: document.getElementById.bind(document),
    addEventListener: document.addEventListener.bind(document),
    removeEventListener: document.removeEventListener.bind(document),
    render: document.render.bind(document),
    destroy: document.destroy.bind(document)
  };
}