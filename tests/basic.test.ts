/**
 * Basic TTY Tests
 */

import { test, expect } from 'bun:test';
import { createTTY, TTYElement, MockTTYRuntime } from '../src/index.js';
import { TTYTextElement } from '../src/elements/TTYTextElement.js';

test('createTTY provides TTY API', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  expect(tty).toBeDefined();
  expect(tty.createElement).toBeDefined();
  expect(tty.render).toBeDefined();
  expect(tty.innerWidth).toBeDefined();
  expect(tty.innerHeight).toBeDefined();
  
  tty.dispose();
});

test('can create elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const container = tty.createElement('container');
  const text = tty.createElement('text');
  const button = tty.createElement('button');
  
  expect(container.tagName).toBe('CONTAINER');
  expect(text.tagName).toBe('TEXT');
  expect(button.tagName).toBe('BUTTON');
  
  tty.dispose();
});

test('can build DOM tree', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const container = tty.createElement('container');
  const text = tty.createElement('text');
  
  text.textContent = 'Hello TTY!';
  container.appendChild(text);
  tty.appendChild(container);
  
  expect(container.children.length).toBe(1);
  expect(container.children[0]).toBe(text);
  expect(text.textContent).toBe('Hello TTY!');
  expect(tty.children.length).toBe(1);
  expect(tty.children[0]).toBe(container);
  
  tty.dispose();
});

test('can set TTY styles', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const element = tty.createElement('container') as TTYElement;
  
  // Test that element is a TTYElement instance
  expect(element).toBeDefined();
  expect(element.tagName).toBe('CONTAINER');
  expect(element).toBeInstanceOf(TTYElement);
  
  // Test TTY-specific style system
  expect(element.style).toBeDefined();
  expect(typeof element.style).toBe('object');
  
  // Set TTY styles using proper CSSOM API
  element.style.setProperty('background-color', 'red');
  element.style.setProperty('color', 'white');
  element.style.setProperty('padding', '10px');
  
  // Test that TTY styles were set
  expect(element.style.getPropertyValue('background-color')).toBe('red');
  expect(element.style.getPropertyValue('color')).toBe('white');
  expect(element.style.getPropertyValue('padding')).toBe('10px');
  
  tty.dispose();
});

test('document has correct dimensions', () => {
  const mockRuntime = new MockTTYRuntime({
    dimensions: { columns: 100, rows: 50 }
  });
  const tty = createTTY({ runtime: mockRuntime });
  
  const dimensions = tty.runtime.getTerminalSize();
  expect(dimensions.columns).toBe(100);
  expect(dimensions.rows).toBe(50);
  
  tty.dispose();
});

test('createElement returns appropriate element subtypes', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  // Test generic container elements
  const container = tty.createElement('div');
  expect(container).toBeInstanceOf(TTYElement);
  expect(container.tagName).toBe('DIV');
  
  const section = tty.createElement('container');
  expect(section).toBeInstanceOf(TTYElement);
  expect(section.tagName).toBe('CONTAINER');
  
  // Test text elements
  const textElement = tty.createElement('text');
  expect(textElement).toBeInstanceOf(TTYTextElement);
  expect(textElement.tagName).toBe('TEXT');
  
  // Test that TTYTextElement is also a TTYElement (inheritance)
  expect(textElement).toBeInstanceOf(TTYElement);
  
  tty.dispose();
});