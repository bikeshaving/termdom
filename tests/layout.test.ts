/**
 * Unit Tests for HTML DOM Layout APIs
 * 
 * Tests the new HTML-to-Terminal layout APIs to ensure they work
 * correctly with Yoga layout integration and Symbol properties.
 */

import { test, expect } from 'bun:test';
import { DOMRect } from 'happy-dom';
import { createTTYDocument, MockTTYRuntime, YOGA_BOUNDS } from '../src/index.js';

test('getBoundingClientRect returns DOMRect with element bounds', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const element = document.createElement('div');
  
  // Initially bounds should be zeros
  const rect = element.getBoundingClientRect();
  expect(rect).toBeInstanceOf(DOMRect);
  expect(rect.x).toBe(0);
  expect(rect.y).toBe(0);
  expect(rect.width).toBe(0);
  expect(rect.height).toBe(0);
  
  // Manually set bounds via Symbol property to test the API
  element[YOGA_BOUNDS] = new DOMRect(10, 20, 100, 50);
  
  const updatedRect = element.getBoundingClientRect();
  expect(updatedRect.x).toBe(10);
  expect(updatedRect.y).toBe(20);
  expect(updatedRect.width).toBe(100);
  expect(updatedRect.height).toBe(50);
  expect(updatedRect.left).toBe(10);
  expect(updatedRect.top).toBe(20);
  expect(updatedRect.right).toBe(110);
  expect(updatedRect.bottom).toBe(70);
  
  dispose();
});

test('offset properties return element position and dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const element = document.createElement('div');
  element[YOGA_BOUNDS] = new DOMRect(15, 25, 200, 100);
  
  expect(element.offsetLeft).toBe(15);
  expect(element.offsetTop).toBe(25);
  expect(element.offsetWidth).toBe(200);
  expect(element.offsetHeight).toBe(100);
  
  dispose();
});

test('client properties return content area dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const element = document.createElement('div');
  element[YOGA_BOUNDS] = new DOMRect(5, 10, 150, 80);
  
  // For HTML elements, client dimensions are same as offset (no borders)
  expect(element.clientWidth).toBe(150);
  expect(element.clientHeight).toBe(80);
  
  dispose();
});

test('scroll properties return scrollable dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const element = document.createElement('div');
  element[YOGA_BOUNDS] = new DOMRect(0, 0, 120, 60);
  
  // Currently same as client dimensions (no scrolling yet)
  expect(element.scrollWidth).toBe(120);
  expect(element.scrollHeight).toBe(60);
  
  dispose();
});

test('getClientRects returns single rect for block elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const element = document.createElement('div');
  element[YOGA_BOUNDS] = new DOMRect(30, 40, 80, 20);
  
  const rects = element.getClientRects();
  expect(rects.length).toBe(1);
  
  const rect = rects.item(0);
  expect(rect).not.toBeNull();
  expect(rect!.x).toBe(30);
  expect(rect!.y).toBe(40);
  expect(rect!.width).toBe(80);
  expect(rect!.height).toBe(20);
  
  // Test iterator
  const rectArray = Array.from(rects);
  expect(rectArray).toHaveLength(1);
  expect(rectArray[0].x).toBe(30);
  
  // Test indexed access
  expect(rects[0].x).toBe(30);
  
  dispose();
});

test('layout APIs work with text elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const span = document.createElement('span');
  span.textContent = 'Hello World';
  span[YOGA_BOUNDS] = new DOMRect(5, 8, 11, 1);
  
  const rect = span.getBoundingClientRect();
  expect(rect.width).toBe(11);
  expect(rect.height).toBe(1);
  
  expect(span.offsetWidth).toBe(11);
  expect(span.offsetHeight).toBe(1);
  expect(span.clientWidth).toBe(11);
  expect(span.clientHeight).toBe(1);
  
  dispose();
});

test('layout APIs work with nested elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span = document.createElement('span');
  
  container.appendChild(span);
  document.body.appendChild(container);
  
  // Set bounds manually for testing
  container[YOGA_BOUNDS] = new DOMRect(0, 0, 80, 24);
  span[YOGA_BOUNDS] = new DOMRect(10, 5, 20, 1);
  
  // Both elements should report their individual bounds
  const containerRect = container.getBoundingClientRect();
  expect(containerRect.width).toBe(80);
  expect(containerRect.height).toBe(24);
  
  const textRect = span.getBoundingClientRect();
  expect(textRect.x).toBe(10);
  expect(textRect.y).toBe(5);
  expect(textRect.width).toBe(20);
  expect(textRect.height).toBe(1);
  
  dispose();
});

test('DOMRect properties are correctly calculated', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const element = document.createElement('div');
  element[YOGA_BOUNDS] = new DOMRect(10, 15, 50, 30);
  
  const rect = element.getBoundingClientRect();
  
  // Test all DOMRect properties
  expect(rect.x).toBe(10);
  expect(rect.y).toBe(15);
  expect(rect.width).toBe(50);
  expect(rect.height).toBe(30);
  expect(rect.left).toBe(10);
  expect(rect.top).toBe(15);
  expect(rect.right).toBe(60); // x + width
  expect(rect.bottom).toBe(45); // y + height
  
  dispose();
});