/**
 * DOM API Tests
 * 
 * Tests our Yoga-powered implementations of standard DOM APIs:
 * - document.elementFromPoint() 
 * - element.contains()
 * - element.closest()
 */

import { test, expect } from 'bun:test';
import { createTTYDocument, MockTTYRuntime } from '../src/index.js';
import { YOGA_BOUNDS } from '../src/core/HTMLExtensions.js';

test('document.elementFromPoint() finds element at coordinates', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  // Create a button with known layout
  const button = document.createElement('button');
  button.textContent = 'Test Button';
  button.style.setProperty('position', 'absolute');
  button.style.setProperty('left', '10px');
  button.style.setProperty('top', '5px');
  button.style.setProperty('width', '20px');
  button.style.setProperty('height', '3px');
  document.body.appendChild(button);
  
  // Manually set bounds for testing (normally set by layout engine)
  // We need to set bounds for HTML, body, and button elements
  (document.documentElement as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(0, 0, 80, 25);
  (document.body as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(0, 0, 80, 25);
  (button as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(10, 5, 20, 3);
  
  // Test hit detection
  const elementAt12_6 = document.elementFromPoint(12, 6);
  const elementAt5_6 = document.elementFromPoint(5, 6); // Outside button
  const elementAt35_6 = document.elementFromPoint(35, 6); // Outside button
  
  expect(elementAt12_6).toBe(button); // Should hit button
  expect(elementAt5_6).toBe(document.body); // Should hit body (parent)  
  expect(elementAt35_6).toBe(document.body); // Should hit body (parent)
  
  dispose();
});

test('document.elementFromPoint() finds deepest element', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  // Create nested elements
  const container = document.createElement('div');
  const button = document.createElement('button');
  const span = document.createElement('span');
  
  span.textContent = 'Click me';
  button.appendChild(span);
  container.appendChild(button);
  document.body.appendChild(container);
  
  // Set up nested bounds (span inside button inside container)
  // We need to set bounds for HTML, body, and all nested elements
  (document.documentElement as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(0, 0, 80, 25);
  (document.body as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(0, 0, 80, 25);
  (container as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(0, 0, 50, 10);
  (button as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(10, 2, 30, 6);
  (span as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(12, 3, 26, 4);
  
  // Test that deepest element is returned
  const elementAt15_4 = document.elementFromPoint(15, 4);
  
  expect(elementAt15_4).toBe(span); // Should return deepest element (span)
  
  dispose();
});

test('element.contains() works correctly', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const button = document.createElement('button');
  const span = document.createElement('span');
  
  button.appendChild(span);
  container.appendChild(button);
  document.body.appendChild(container);
  
  // Test containment relationships
  expect(container.contains(button)).toBe(true);
  expect(container.contains(span)).toBe(true);
  expect(button.contains(span)).toBe(true);
  expect(button.contains(container)).toBe(false);
  expect(span.contains(button)).toBe(false);
  expect(container.contains(container)).toBe(true); // Element contains itself
  
  dispose();
});

test('element.closest() finds ancestor by tag name', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const form = document.createElement('form');
  const div = document.createElement('div');
  const button = document.createElement('button');
  const span = document.createElement('span');
  
  form.appendChild(div);
  div.appendChild(button);
  button.appendChild(span);
  document.body.appendChild(form);
  
  // Test closest ancestor matching
  expect(span.closest('button')?.tagName).toBe('BUTTON');
  expect(span.closest('div')?.tagName).toBe('DIV'); 
  expect(span.closest('form')?.tagName).toBe('FORM');
  expect(span.closest('body')?.tagName).toBe('BODY');
  expect(span.closest('table')).toBe(null); // Not found
  
  // Test case insensitivity
  expect(span.closest('BUTTON')?.tagName).toBe('BUTTON');
  expect(span.closest('Button')?.tagName).toBe('BUTTON');
  
  dispose();
});

test('elementFromPoint returns null for coordinates outside any element', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  // Add a button with specific bounds but no body bounds
  const button = document.createElement('button');
  (button as any)[YOGA_BOUNDS] = new (document.defaultView as any).DOMRect(10, 10, 5, 3);
  document.body.appendChild(button);
  
  // Body has no bounds set, so should return null for any coordinates
  expect(document.elementFromPoint(12, 12)).toBe(null); // Even inside button bounds
  expect(document.elementFromPoint(0, 0)).toBe(null);
  expect(document.elementFromPoint(100, 100)).toBe(null);
  
  dispose();
});