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
 * TOM API object that implements Disposable for automatic cleanup
 */
interface TOMAPI extends Disposable {
  document: import('./core/TOMDocument.js').TOMDocument;
  window: any;
  body: any;
  createElement: (tagName: string) => Element;
  createTextNode: (data: string) => Text;
  querySelector: (selectors: string) => Element | null;
  querySelectorAll: (selectors: string) => NodeList;
  getElementById: (id: string) => Element | null;
  addEventListener: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void;
  removeEventListener: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void;
  render: () => void;
  destroy: () => void;
  activeElement: any;
  setActiveElement: (element: any) => void;
  focusNext: () => void;
  focusPrevious: () => void;
  enableInputMode: () => void;
  disableInputMode: () => void;
  enableMouse: () => void;
  disableMouse: () => void;
}

/**
 * Quick start helper - creates document and returns DOM-like API
 * Supports automatic cleanup with `using` statements
 */
export function createTOM(options?: import('./core/TOMDocument.js').TOMDocumentOptions): TOMAPI {
  const document = createDocument(options);
  
  const api: TOMAPI = {
    document,
    window: document.window,
    body: document.body,
    createElement: document.createElement.bind(document),
    createTextNode: document.createTextNode.bind(document),
    querySelector: document.querySelector.bind(document),
    querySelectorAll: document.querySelectorAll.bind(document),
    getElementById: document.getElementById.bind(document),
    addEventListener: document.addEventListener.bind(document),
    removeEventListener: document.removeEventListener.bind(document),
    render: document.render.bind(document),
    destroy: document.destroy.bind(document),
    
    // Focus and selection management
    get activeElement() { return document.activeElement; },
    setActiveElement: document.setActiveElement.bind(document),
    focusNext: document.focusNext.bind(document),
    focusPrevious: document.focusPrevious.bind(document),
    
    // Input mode management
    enableInputMode: document.enableInputMode.bind(document),
    disableInputMode: document.disableInputMode.bind(document),
    
    // Mouse support
    enableMouse: document.enableMouse.bind(document),
    disableMouse: document.disableMouse.bind(document),

    // Disposable implementation
    [Symbol.dispose](): void {
      document.destroy();
    }
  };

  return api;
}