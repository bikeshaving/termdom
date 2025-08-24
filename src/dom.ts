/**
 * DOM Types - Singleton JSDOM instance for consistent DOM types
 * 
 * Re-exports all DOM types from a single JSDOM instance to ensure
 * consistency across the entire TTYOM library.
 */

import { JSDOM } from 'jsdom';

// Create singleton JSDOM instance
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
const window = dom.window;

// Re-export all DOM types and constructors
export const {
  HTMLElement,
  Element,
  Node,
  Document,
  DOMRect,
  MutationObserver,
  EventTarget,
  Event,
  MouseEvent,
  KeyboardEvent,
  FocusEvent,
  WheelEvent,
  CustomEvent,
  window: DOMWindow
} = window;

// Re-export types that are available on window but not as constructors
export type CSSStyleDeclaration = typeof window.CSSStyleDeclaration.prototype;

// Re-export the window for createTTYDocument to use
export { window };