/**
 * Unit Tests for DOM Layout APIs
 * 
 * Tests the new getBoundingClientRect() and related layout APIs
 * to ensure they work correctly with Yoga layout integration.
 */

import { test, expect } from 'bun:test';
import { DOMRect } from 'happy-dom';
import { createTTY, MockTTYRuntime } from '../src/index.js';

test('getBoundingClientRect returns DOMRect with element bounds', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const element = tty.createElement('container');
  
  // Initially bounds should be zeros
  const rect = element.getBoundingClientRect();
  expect(rect).toBeInstanceOf(DOMRect);
  expect(rect.x).toBe(0);
  expect(rect.y).toBe(0);
  expect(rect.width).toBe(0);
  expect(rect.height).toBe(0);
  
  // Manually set bounds to test the API
  element.bounds = { x: 10, y: 20, width: 100, height: 50 };
  
  const updatedRect = element.getBoundingClientRect();
  expect(updatedRect.x).toBe(10);
  expect(updatedRect.y).toBe(20);
  expect(updatedRect.width).toBe(100);
  expect(updatedRect.height).toBe(50);
  expect(updatedRect.left).toBe(10);
  expect(updatedRect.top).toBe(20);
  expect(updatedRect.right).toBe(110);
  expect(updatedRect.bottom).toBe(70);
  
  tty.dispose();
});

test('offset properties return element position and dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const element = tty.createElement('container');
  element.bounds = { x: 15, y: 25, width: 200, height: 100 };
  
  expect(element.offsetLeft).toBe(15);
  expect(element.offsetTop).toBe(25);
  expect(element.offsetWidth).toBe(200);
  expect(element.offsetHeight).toBe(100);
  
  tty.dispose();
});

test('client properties return content area dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const element = tty.createElement('container');
  element.bounds = { x: 5, y: 10, width: 150, height: 80 };
  
  // For TTY elements, client dimensions are same as offset (no borders)
  expect(element.clientWidth).toBe(150);
  expect(element.clientHeight).toBe(80);
  
  tty.dispose();
});

test('scroll properties return scrollable dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const element = tty.createElement('container');
  element.bounds = { x: 0, y: 0, width: 120, height: 60 };
  
  // Currently same as client dimensions (no scrolling yet)
  expect(element.scrollWidth).toBe(120);
  expect(element.scrollHeight).toBe(60);
  
  tty.dispose();
});

test('getClientRects returns single rect for block elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const element = tty.createElement('container');
  element.bounds = { x: 30, y: 40, width: 80, height: 20 };
  
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
  
  tty.dispose();
});

test('layout APIs work with text elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const text = tty.createElement('text');
  text.textContent = 'Hello World';
  text.bounds = { x: 5, y: 8, width: 11, height: 1 };
  
  const rect = text.getBoundingClientRect();
  expect(rect.width).toBe(11);
  expect(rect.height).toBe(1);
  
  expect(text.offsetWidth).toBe(11);
  expect(text.offsetHeight).toBe(1);
  expect(text.clientWidth).toBe(11);
  expect(text.clientHeight).toBe(1);
  
  tty.dispose();
});

test('layout APIs work with nested elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const container = tty.createElement('container');
  const text = tty.createElement('text');
  
  container.appendChild(text);
  tty.appendChild(container);
  
  // Set bounds manually for testing
  container.bounds = { x: 0, y: 0, width: 80, height: 24 };
  text.bounds = { x: 10, y: 5, width: 20, height: 1 };
  
  // Both elements should report their individual bounds
  const containerRect = container.getBoundingClientRect();
  expect(containerRect.width).toBe(80);
  expect(containerRect.height).toBe(24);
  
  const textRect = text.getBoundingClientRect();
  expect(textRect.x).toBe(10);
  expect(textRect.y).toBe(5);
  expect(textRect.width).toBe(20);
  expect(textRect.height).toBe(1);
  
  tty.dispose();
});

test('DOMRect properties are correctly calculated', () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const element = tty.createElement('container');
  element.bounds = { x: 10, y: 15, width: 50, height: 30 };
  
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
  
  tty.dispose();
});