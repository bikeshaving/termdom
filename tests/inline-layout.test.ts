/**
 * Inline Layout Tests
 * 
 * Comprehensive tests for inline and inline-block layout behavior:
 * - Block-inside-inline conversion to inline-block
 * - Complex word-wrapping scenarios 
 * - Multi-rectangle handling for wrapped inline elements
 * - Mixed inline/inline-block positioning
 * - Advanced invalidation for inline content
 */

import { test, expect } from 'bun:test';
import { createTTY, MockTTYRuntime } from '../src/index.js';
import { ELEMENT_BOUNDS, ELEMENT_RECTS } from '../src/core/HTMLExtensions.js';

test.skip('block elements inside inline are converted to inline-block', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  // Create container that will definitely get processed by Yoga
  const container = document.createElement('div');
  
  // Create inline parent with block child (invalid CSS)
  const span = document.createElement('span');
  const div = document.createElement('div');
  
  span.style.setProperty('display', 'inline');
  div.style.setProperty('display', 'block'); // This should get converted
  div.textContent = 'Block content';
  
  span.appendChild(div);
  container.appendChild(span);
  document.body.appendChild(container);
  
  // Trigger layout from container
  container.getBoundingClientRect();
  
  // Debug: Check what we actually got
  console.log('Div bounds:', div.getBoundingClientRect());
  console.log('Span bounds:', span.getBoundingClientRect());
  
  // The div should now behave as inline-block (has its own bounds)
  const divBounds = div.getBoundingClientRect();
  expect(divBounds.width).toBeGreaterThan(0);
  expect(divBounds.height).toBe(1);
  
  // Span should contain the converted div
  const spanBounds = span.getBoundingClientRect();
  expect(spanBounds.width).toBeGreaterThan(0);
  
  dispose();
});

test.skip('flex elements inside inline are converted to inline-block', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const span = document.createElement('span');
  const flexDiv = document.createElement('div');
  
  span.style.setProperty('display', 'inline');
  flexDiv.style.setProperty('display', 'flex'); // This should get converted
  flexDiv.textContent = 'Flex content';
  
  span.appendChild(flexDiv);
  document.body.appendChild(span);
  
  // Trigger layout
  span.getBoundingClientRect();
  
  // The flex div should now behave as inline-block
  const flexBounds = flexDiv.getBoundingClientRect();
  expect(flexBounds.width).toBeGreaterThan(0);
  expect(flexBounds.height).toBe(1);
  
  dispose();
});

test('multiple inline elements with horizontal margins', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span1 = document.createElement('span');
  const span2 = document.createElement('span');
  const span3 = document.createElement('span');
  
  // Set up inline elements with different margins
  span1.textContent = 'First';
  span1.style.setProperty('margin-right', '2ch');
  
  span2.textContent = 'Second';
  span2.style.setProperty('margin-left', '1ch');
  span2.style.setProperty('margin-right', '3ch');
  
  span3.textContent = 'Third';
  span3.style.setProperty('margin-left', '1ch');
  
  container.appendChild(span1);
  container.appendChild(span2);
  container.appendChild(span3);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  // Check positioning: First(5) + margin-right(2) + margin-left(1) + Second(6) + margin-right(3) + margin-left(1) + Third(5)
  const bounds1 = span1.getBoundingClientRect();
  const bounds2 = span2.getBoundingClientRect();
  const bounds3 = span3.getBoundingClientRect();
  
  expect(bounds1.x).toBe(0); // First element at start
  expect(bounds1.width).toBe(5); // "First" = 5 chars
  
  expect(bounds2.x).toBe(8); // 0 + 5(width) + 2(margin-right) + 1(margin-left) = 8
  expect(bounds2.width).toBe(6); // "Second" = 6 chars
  
  expect(bounds3.x).toBe(18); // 8 + 6(width) + 3(margin-right) + 1(margin-left) = 18
  expect(bounds3.width).toBe(5); // "Third" = 5 chars
  
  dispose();
});

test('inline elements ignore vertical margins and width/height', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span = document.createElement('span');
  
  span.textContent = 'Test';
  span.style.setProperty('display', 'inline');
  span.style.setProperty('width', '100ch');     // Should be ignored
  span.style.setProperty('height', '10ch');     // Should be ignored  
  span.style.setProperty('margin-top', '5ch');  // Should be ignored
  span.style.setProperty('margin-bottom', '3ch'); // Should be ignored
  span.style.setProperty('margin-left', '2ch'); // Should work
  span.style.setProperty('margin-right', '1ch'); // Should work
  
  container.appendChild(span);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  const bounds = span.getBoundingClientRect();
  
  // Position respects horizontal margins only
  expect(bounds.x).toBe(2); // margin-left works
  expect(bounds.y).toBe(0); // margin-top ignored
  
  // Size based on content, not CSS
  expect(bounds.width).toBe(4); // "Test" = 4 chars, not 100ch
  expect(bounds.height).toBe(1); // Single line, not 10ch
  
  dispose();
});

test.skip('mixed inline and inline-block elements flow together', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  
  // Create mixed content: inline text, inline-block button, more inline text
  const span1 = document.createElement('span');
  span1.textContent = 'Before ';
  
  const button = document.createElement('button');
  button.textContent = 'Click';
  button.style.setProperty('display', 'inline-block');
  button.style.setProperty('width', '10ch');
  button.style.setProperty('margin', '0 2ch');
  
  const span2 = document.createElement('span');
  span2.textContent = ' after';
  
  container.appendChild(span1);
  container.appendChild(button);
  container.appendChild(span2);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  const bounds1 = span1.getBoundingClientRect();
  const buttonBounds = button.getBoundingClientRect();
  const bounds2 = span2.getBoundingClientRect();
  
  // Check flow: "Before "(7) + margin-left(2) + button(10) + margin-right(2) + " after"(6)
  expect(bounds1.x).toBe(0);
  expect(bounds1.width).toBe(7); // "Before " = 7 chars
  
  expect(buttonBounds.x).toBe(9); // 7 + 2(margin-left) = 9
  expect(buttonBounds.width).toBe(10); // Explicit width
  
  expect(bounds2.x).toBe(21); // 9 + 10 + 2(margin-right) = 21
  expect(bounds2.width).toBe(6); // " after" = 6 chars
  
  dispose();
});

test('inline-block elements are atomic and never break internally', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const inlineBlock = document.createElement('span');
  
  // Create inline-block with long text that would wrap if it were inline
  inlineBlock.style.setProperty('display', 'inline-block');
  inlineBlock.style.setProperty('width', '5ch'); // Fixed width, text will be truncated
  inlineBlock.textContent = 'Very long text that exceeds width';
  
  container.appendChild(inlineBlock);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  const bounds = inlineBlock.getBoundingClientRect();
  
  // Should have exactly the specified width (truncated, not wrapped)
  expect(bounds.width).toBe(5);
  expect(bounds.height).toBe(1); // Single line, never breaks
  
  // Should have only one rectangle (atomic element)
  const rects = inlineBlock.getClientRects();
  expect(rects.length).toBe(1);
  
  dispose();
});

test('empty inline elements have minimum dimensions', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const emptySpan = document.createElement('span');
  
  // Empty inline element
  emptySpan.textContent = '';
  
  container.appendChild(emptySpan);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  const bounds = emptySpan.getBoundingClientRect();
  
  // Should have minimum width/height for layout purposes
  expect(bounds.width).toBe(1); // Minimum width for empty content
  expect(bounds.height).toBe(1); // Single line height
  
  dispose();
});

test('getClientRects returns single rect for inline elements', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span = document.createElement('span');
  
  span.textContent = 'Single line text';
  container.appendChild(span);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  // Should return single rectangle for single-line inline element
  const rects = span.getClientRects();
  expect(rects.length).toBe(1);
  
  // Should match getBoundingClientRect for single-rect elements
  const boundingRect = span.getBoundingClientRect();
  expect(rects[0].x).toBe(boundingRect.x);
  expect(rects[0].y).toBe(boundingRect.y);
  expect(rects[0].width).toBe(boundingRect.width);
  expect(rects[0].height).toBe(boundingRect.height);
  
  dispose();
});

test.skip('nested inline elements maintain proper layout', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const outerSpan = document.createElement('span');
  const innerSpan = document.createElement('span');
  
  outerSpan.textContent = 'Outer ';
  innerSpan.textContent = 'inner';
  outerSpan.appendChild(innerSpan);
  container.appendChild(outerSpan);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  // Check nested positioning
  const outerBounds = outerSpan.getBoundingClientRect();
  const innerBounds = innerSpan.getBoundingClientRect();
  
  expect(outerBounds.width).toBeGreaterThan(0);
  expect(innerBounds.width).toBeGreaterThan(0);
  
  // Inner span should be positioned after outer span's text content
  expect(innerBounds.x).toBeGreaterThan(outerBounds.x);
  expect(innerBounds.y).toBe(outerBounds.y); // Same line
  
  dispose();
});

test('inline element invalidation clears cached bounds', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span = document.createElement('span');
  
  span.textContent = 'Initial';
  container.appendChild(span);
  document.body.appendChild(container);
  
  // Get initial layout
  const initial = span.getBoundingClientRect();
  expect(initial.width).toBe(7); // "Initial" = 7 chars
  
  // Verify ELEMENT_BOUNDS is set
  expect(span[ELEMENT_BOUNDS]).toBeDefined();
  
  // Change text content (should trigger invalidation)
  span.textContent = 'Much longer text content';
  
  // Get updated layout
  const updated = span.getBoundingClientRect();
  expect(updated.width).toBe(24); // New text length
  expect(updated.width).toBeGreaterThan(initial.width);
  
  dispose();
});

test('inline elements with padding have correct content area', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span = document.createElement('span');
  
  span.textContent = 'Content';
  // Note: inline elements ignore padding in CSS spec, but we can test our behavior
  span.style.setProperty('padding', '1ch');
  
  container.appendChild(span);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  const bounds = span.getBoundingClientRect();
  
  // Should be sized based on content, padding ignored for inline elements
  expect(bounds.width).toBe(7); // "Content" = 7 chars, padding ignored
  expect(bounds.height).toBe(1); // Single line
  
  dispose();
});

test('empty inline elements with margins still flow correctly', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span1 = document.createElement('span');
  const emptySpan = document.createElement('span');
  const span2 = document.createElement('span');
  
  span1.textContent = 'Before';
  emptySpan.textContent = ''; // Empty span with margin
  emptySpan.style.setProperty('margin-left', '2ch');
  emptySpan.style.setProperty('margin-right', '2ch');
  span2.textContent = 'After';
  
  container.appendChild(span1);
  container.appendChild(emptySpan);
  container.appendChild(span2);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  const bounds1 = span1.getBoundingClientRect();
  const emptyBounds = emptySpan.getBoundingClientRect();
  const bounds2 = span2.getBoundingClientRect();
  
  // Check flow: "Before"(6) + margin-left(2) + empty(1 min) + margin-right(2) = 11
  expect(bounds1.x).toBe(0);
  expect(bounds1.width).toBe(6);
  
  expect(emptyBounds.x).toBe(8); // 6 + 2(margin-left)
  expect(emptyBounds.width).toBe(1); // Minimum width for empty
  
  expect(bounds2.x).toBe(11); // 6 + 2 + 1 + 2 = 11
  expect(bounds2.width).toBe(5); // "After" = 5 chars
  
  dispose();
});