/**
 * Basic TOM Tests
 */

import { test, expect } from 'bun:test';
import { createTOM, TOMDocument, TOMElement } from '../src/index.js';

test('createTOM returns document API', () => {
  const tom = createTOM();
  
  expect(tom.document).toBeDefined();
  expect(tom.body).toBeDefined();
  expect(tom.createElement).toBeDefined();
  expect(tom.render).toBeDefined();
  
  tom.destroy();
});

test('can create elements', () => {
  const tom = createTOM();
  
  const container = tom.createElement('container');
  const text = tom.createElement('text');
  const button = tom.createElement('button');
  
  expect(container.tagName).toBe('CONTAINER');
  expect(text.tagName).toBe('TEXT');
  expect(button.tagName).toBe('BUTTON');
  
  tom.destroy();
});

test('can build DOM tree', () => {
  const tom = createTOM();
  
  const container = tom.createElement('container');
  const text = tom.createElement('text');
  
  text.textContent = 'Hello TOM!';
  container.appendChild(text);
  tom.body.appendChild(container);
  
  expect(container.children.length).toBe(1);
  expect(container.children[0]).toBe(text);
  expect(text.textContent).toBe('Hello TOM!');
  
  tom.destroy();
});

test('can set styles', () => {
  const tom = createTOM();
  
  const element = tom.createElement('container') as TOMElement;
  element.style = {
    backgroundColor: 'red',
    color: 'white',
    padding: 10
  };
  
  expect(element.style.backgroundColor).toBe('red');
  expect(element.style.color).toBe('white');
  expect(element.style.padding).toBe(10);
  
  tom.destroy();
});

test('document has correct dimensions', () => {
  const tom = createTOM({ width: 100, height: 50 });
  
  expect(tom.document.terminalWidth).toBe(100);
  expect(tom.document.terminalHeight).toBe(50);
  
  tom.destroy();
});