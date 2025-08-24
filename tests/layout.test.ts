/**
 * Unit Tests for HTML DOM Layout APIs
 *
 * Tests the new HTML-to-Terminal layout APIs to ensure they work
 * correctly with Yoga layout integration and Symbol properties.
 */

import { test, expect } from 'bun:test';
// DOMRect available from standard DOM types
import { createTTY, MockTTYRuntime, ELEMENT_BOUNDS } from '../src/index.js';

test('getBoundingClientRect returns DOMRect with element bounds', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, window, dispose } = createTTY({ runtime: mockRuntime });

  const element = document.createElement('div');
  document.body.appendChild(element);

  // Block element in flex container should stretch to container width and have intrinsic height
  let rect = element.getBoundingClientRect();
  expect(rect).toBeInstanceOf(window.DOMRect);
  expect(rect.x).toBe(0);
  expect(rect.y).toBe(0);
  expect(rect.width).toBe(80); // Stretches to terminal width (default terminal columns)
  expect(rect.height).toBe(0); // No content, so height is 0

  // Set dimensions via CSS and compute layout
  element.style.setProperty('width', '100ch');
  element.style.setProperty('height', '50ch');
  element.style.setProperty('margin-left', '10ch');
  element.style.setProperty('margin-top', '20ch');

  // getBoundingClientRect triggers layout computation synchronously

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
  const { document, dispose } = createTTY({ runtime: mockRuntime });

  const element = document.createElement('div');
  element.style.setProperty('width', '200ch');
  element.style.setProperty('height', '100ch');
  element.style.setProperty('margin-left', '15ch');
  element.style.setProperty('margin-top', '25ch');
  document.body.appendChild(element);

  // getBoundingClientRect triggers layout computation synchronously

  expect(element.offsetLeft).toBe(15);
  expect(element.offsetTop).toBe(25);
  expect(element.offsetWidth).toBe(200);
  expect(element.offsetHeight).toBe(100);

  dispose();
});

test('client properties return content area dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });

  const element = document.createElement('div');
  element.style.setProperty('width', '150ch');
  element.style.setProperty('height', '80ch');
  element.style.setProperty('margin-left', '5ch');
  element.style.setProperty('margin-top', '10ch');
  document.body.appendChild(element);

  // getBoundingClientRect triggers layout computation synchronously

  // For HTML elements, client dimensions are same as offset (no borders)
  expect(element.clientWidth).toBe(150);
  expect(element.clientHeight).toBe(80);

  dispose();
});

test('scroll properties return scrollable dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });

  const element = document.createElement('div');
  element.style.setProperty('width', '120ch');
  element.style.setProperty('height', '60ch');
  document.body.appendChild(element);

  // getBoundingClientRect triggers layout computation synchronously

  // Currently same as client dimensions (no scrolling yet)
  expect(element.scrollWidth).toBe(120);
  expect(element.scrollHeight).toBe(60);

  dispose();
});

test('getClientRects returns single rect for block elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });

  const element = document.createElement('div');
  element.style.setProperty('width', '80ch');
  element.style.setProperty('height', '20ch');
  element.style.setProperty('margin-left', '30ch');
  element.style.setProperty('margin-top', '40ch');
  document.body.appendChild(element);

  // getBoundingClientRect triggers layout computation synchronously

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
  const { document, dispose } = createTTY({ runtime: mockRuntime });

  const span = document.createElement('span');
  span.textContent = 'Hello World';
  span.style.setProperty('display', 'inline-block');
  span.style.setProperty('width', '11ch');
  span.style.setProperty('height', '1ch');
  span.style.setProperty('margin-left', '5ch');
  span.style.setProperty('margin-top', '8ch');
  document.body.appendChild(span);

  // getBoundingClientRect triggers layout computation synchronously

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
  const { document, dispose } = createTTY({ runtime: mockRuntime });

  const container = document.createElement('div');
  const span = document.createElement('span');

  // Set up container layout
  container.style.setProperty('width', '80ch');
  container.style.setProperty('height', '24ch');
  container.style.setProperty('display', 'flex');
  container.style.setProperty('flex-direction', 'column');

  // Set up span layout
  span.style.setProperty('width', '20ch');
  span.style.setProperty('height', '1ch');
  span.style.setProperty('margin-left', '10ch');
  span.style.setProperty('margin-top', '5ch');

  container.appendChild(span);
  document.body.appendChild(container);

  // getBoundingClientRect triggers layout computation synchronously

  // Both elements should report their individual bounds
  const containerRect = container.getBoundingClientRect();
  expect(containerRect.width).toBe(80);
  expect(containerRect.height).toBe(24);

  const textRect = span.getBoundingClientRect();
  expect(textRect.x).toBe(10); // margin-left works on inline elements
  expect(textRect.y).toBe(0);  // margin-top ignored on inline elements (CSS spec)
  expect(textRect.width).toBe(1); // width ignored, uses content length (empty span = 1 minimum)
  expect(textRect.height).toBe(1); // height ignored, uses line height

  dispose();
});

test('DOMRect properties are correctly calculated', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });

  const element = document.createElement('div');
  element.style.setProperty('width', '50ch');
  element.style.setProperty('height', '30ch');
  element.style.setProperty('margin-left', '10ch');
  element.style.setProperty('margin-top', '15ch');
  document.body.appendChild(element);

  // getBoundingClientRect triggers layout computation synchronously

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
