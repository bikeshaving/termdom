/**
 * Basic TTY Tests
 */

import { test, expect } from 'bun:test';
import { TTYWindow, TTYDocument, TTYElement, MockTTYRuntime } from '../src/index.js';
import { TTYTextElement } from '../src/elements/TTYTextElement.js';

test('TTYWindow provides document API', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = new TTYWindow({ runtime: mockRuntime });
  
  expect(tty.document).toBeDefined();
  expect(tty.document.body).toBeDefined();
  expect(tty.document.createElement).toBeDefined();
  expect(tty.document.render).toBeDefined();
  
  tty.dispose();
});

test('can create elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = new TTYWindow({ runtime: mockRuntime });
  
  const container = tty.document.createElement('container');
  const text = tty.document.createElement('text');
  const button = tty.document.createElement('button');
  
  expect(container.tagName).toBe('CONTAINER');
  expect(text.tagName).toBe('TEXT');
  expect(button.tagName).toBe('BUTTON');
  
  tty.dispose();
});

test('can build DOM tree', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = new TTYWindow({ runtime: mockRuntime });
  
  const container = tty.document.createElement('container');
  const text = tty.document.createElement('text');
  
  text.textContent = 'Hello TTY!';
  container.appendChild(text);
  tty.document.body.appendChild(container);
  
  expect(container.children.length).toBe(1);
  expect(container.children[0]).toBe(text);
  expect(text.textContent).toBe('Hello TTY!');
  expect(tty.document.body.children.length).toBe(1);
  expect(tty.document.body.children[0]).toBe(container);
  
  tty.dispose();
});

test('can set TTY styles', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = new TTYWindow({ runtime: mockRuntime });
  
  const element = tty.document.createElement('container') as TTYElement;
  
  // Test that element is a TTYElement instance
  expect(element).toBeDefined();
  expect(element.tagName).toBe('CONTAINER');
  expect(element).toBeInstanceOf(TTYElement);
  
  // Test TTY-specific style system
  expect(element.style).toBeDefined();
  expect(typeof element.style).toBe('object');
  
  // Set TTY styles
  element.style = {
    backgroundColor: 'red',
    color: 'white',
    padding: 10
  };
  
  // Test that TTY styles were set
  expect(element.style.backgroundColor).toBe('red');
  expect(element.style.color).toBe('white');
  expect(element.style.padding).toBe(10);
  
  tty.dispose();
});

test('document has correct dimensions', () => {
  const mockRuntime = new MockTTYRuntime({
    dimensions: { columns: 100, rows: 50 }
  });
  const tty = new TTYWindow({ runtime: mockRuntime });
  
  const dimensions = tty.runtime.getTerminalSize();
  expect(dimensions.columns).toBe(100);
  expect(dimensions.rows).toBe(50);
  
  tty.dispose();
});

test('createElement returns appropriate element subtypes', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = new TTYWindow({ runtime: mockRuntime });
  
  // Test generic container elements
  const container = tty.document.createElement('div');
  expect(container).toBeInstanceOf(TTYElement);
  expect(container.tagName).toBe('DIV');
  
  const section = tty.document.createElement('container');
  expect(section).toBeInstanceOf(TTYElement);
  expect(section.tagName).toBe('CONTAINER');
  
  // Test text elements
  const textElement = tty.document.createElement('text');
  expect(textElement).toBeInstanceOf(TTYTextElement);
  expect(textElement.tagName).toBe('TEXT');
  
  // Test that TTYTextElement is also a TTYElement (inheritance)
  expect(textElement).toBeInstanceOf(TTYElement);
  
  tty.dispose();
});