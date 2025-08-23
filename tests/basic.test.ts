/**
 * Basic HTML-to-Terminal Tests
 */

import { test, expect } from 'bun:test';
import { createTTYDocument, MockTTYRuntime } from '../src/index.js';

test('createTTYDocument provides HTML document with terminal capabilities', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, runtime, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  expect(document).toBeDefined();
  expect(document.createElement).toBeDefined();
  expect(render).toBeDefined();
  expect(runtime).toBeDefined();
  expect(typeof dispose).toBe('function');
  
  dispose();
});

test('can create standard HTML elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const div = document.createElement('div');
  const span = document.createElement('span');
  const button = document.createElement('button');
  
  expect(div.tagName).toBe('DIV');
  expect(span.tagName).toBe('SPAN');
  expect(button.tagName).toBe('BUTTON');
  
  dispose();
});

test('can build HTML DOM tree', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span = document.createElement('span');
  
  span.textContent = 'Hello HTML Terminal!';
  container.appendChild(span);
  document.body.appendChild(container);
  
  expect(container.children.length).toBe(1);
  expect(container.children[0]).toBe(span);
  expect(span.textContent).toBe('Hello HTML Terminal!');
  expect(document.body.children.length).toBe(1);
  expect(document.body.children[0]).toBe(container);
  
  dispose();
});

test('HTML elements have CSS styling', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const element = document.createElement('div');
  
  // Test that element has proper HTML styling APIs
  expect(element).toBeDefined();
  expect(element.tagName).toBe('DIV');
  expect(element.style).toBeDefined();
  expect(typeof element.style.setProperty).toBe('function');
  
  // Set CSS styles using standard CSSStyleDeclaration API
  element.style.setProperty('background-color', 'red');
  element.style.setProperty('color', 'white');
  element.style.setProperty('padding', '10px');
  
  // Test that CSS styles were set
  expect(element.style.getPropertyValue('background-color')).toBe('red');
  expect(element.style.getPropertyValue('color')).toBe('white');
  expect(element.style.getPropertyValue('padding')).toBe('10px');
  
  dispose();
});

test('runtime provides correct terminal dimensions', () => {
  const mockRuntime = new MockTTYRuntime({
    dimensions: { columns: 100, rows: 50 }
  });
  const { runtime, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const dimensions = runtime.getTerminalSize();
  expect(dimensions.columns).toBe(100);
  expect(dimensions.rows).toBe(50);
  
  dispose();
});

test('HTML elements support layout APIs', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  // Test that standard HTML elements have layout APIs
  const div = document.createElement('div');
  const span = document.createElement('span');
  const p = document.createElement('p');
  
  // All elements should have layout APIs
  expect(typeof div.getBoundingClientRect).toBe('function');
  expect(typeof span.offsetWidth).toBe('number');
  expect(typeof p.clientHeight).toBe('number');
  
  // Initially should return zero (no layout computed yet)
  expect(div.getBoundingClientRect().width).toBe(0);
  expect(span.offsetWidth).toBe(0);
  expect(p.clientHeight).toBe(0);
  
  dispose();
});

test('can render HTML to terminal without errors', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const div = document.createElement('div');
  div.textContent = 'Test content';
  div.style.setProperty('color', 'blue');
  document.body.appendChild(div);
  
  // Should render without throwing errors
  await expect(render()).resolves.toBeUndefined();
  
  dispose();
});