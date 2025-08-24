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

test('block elements inside inline are converted to inline-block', () => {
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
  
  // The span should remain inline (we don't modify CSS, just treat children as inline-block)
  const spanComputedStyle = span.ownerDocument!.defaultView!.getComputedStyle(span);
  const spanDisplay = spanComputedStyle.getPropertyValue('display');
  expect(spanDisplay).toBe('inline'); // CSS unchanged
  
  // But the div child should be treated as inline-block during layout
  const divComputedStyle = div.ownerDocument!.defaultView!.getComputedStyle(div);  
  const divDisplay = divComputedStyle.getPropertyValue('display');
  expect(divDisplay).toBe('block'); // CSS unchanged, but treated as inline-block
  
  // The span should now behave as inline-block (conversion happened)
  const spanBounds = span.getBoundingClientRect();
  expect(spanBounds.width).toBeGreaterThan(0);
  expect(spanBounds.height).toBe(1);
  
  // The div inside should also have bounds (regular block child of inline-block parent)
  const divBounds = div.getBoundingClientRect();
  expect(divBounds.width).toBeGreaterThan(0);
  expect(divBounds.height).toBe(1);
  
  dispose();
});

test('flex elements inside inline are converted to inline-block', () => {
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

test('mixed inline and inline-block elements flow together', () => {
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

test('nested inline elements maintain proper layout', () => {
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

test('inline elements wrapping across lines create multiple rectangles', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  container.style.setProperty('width', '10ch'); // Force wrapping
  
  const span = document.createElement('span');
  span.textContent = 'This is a very long text that should wrap across multiple lines';
  
  container.appendChild(span);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  // Get both single bounding rect and multiple client rects
  const boundingRect = span.getBoundingClientRect();
  const clientRects = span.getClientRects();
  
  // Should have multiple rectangles due to line wrapping
  expect(clientRects.length).toBeGreaterThan(1);
  
  // Bounding rect should encompass all client rects
  expect(boundingRect.height).toBeGreaterThan(1); // Multiple lines
  
  // Each client rect should be on a different line
  for (let i = 1; i < clientRects.length; i++) {
    expect(clientRects[i].y).toBeGreaterThan(clientRects[i-1].y);
  }
  
  // All rects should be within the bounding rect
  for (const rect of clientRects) {
    expect(rect.x).toBeGreaterThanOrEqual(boundingRect.x);
    expect(rect.y).toBeGreaterThanOrEqual(boundingRect.y);
    expect(rect.x + rect.width).toBeLessThanOrEqual(boundingRect.x + boundingRect.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(boundingRect.y + boundingRect.height);
  }
  
  dispose();
});

test('nested inline elements within wrapped parent maintain correct positioning', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  container.style.setProperty('width', '15ch'); // Force wrapping
  
  // Create a complex nested structure
  const outerSpan = document.createElement('span');
  outerSpan.textContent = 'Before nested ';
  
  const innerSpan = document.createElement('span');
  innerSpan.textContent = 'inner content';
  
  const afterSpan = document.createElement('span');
  afterSpan.textContent = ' after nested content that continues';
  
  outerSpan.appendChild(innerSpan);
  outerSpan.appendChild(afterSpan);
  container.appendChild(outerSpan);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  // Check positioning
  const outerBounds = outerSpan.getBoundingClientRect();
  const innerBounds = innerSpan.getBoundingClientRect();
  const afterBounds = afterSpan.getBoundingClientRect();
  
  // Outer span should wrap across multiple lines
  expect(outerBounds.height).toBeGreaterThan(1);
  
  // Inner span should be positioned correctly within the outer span
  expect(innerBounds.width).toBeGreaterThan(0);
  expect(innerBounds.height).toBe(1); // Inline elements are single-line
  
  // All nested elements should have valid bounds
  expect(innerBounds.x).toBeGreaterThanOrEqual(0);
  expect(innerBounds.y).toBeGreaterThanOrEqual(0);
  expect(afterBounds.x).toBeGreaterThanOrEqual(0);
  expect(afterBounds.y).toBeGreaterThanOrEqual(0);
  
  dispose();
});

test('mixed inline and inline-block elements with line wrapping', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  container.style.setProperty('width', '12ch'); // Force wrapping
  
  const span1 = document.createElement('span');
  span1.textContent = 'Text before ';
  
  const inlineBlock = document.createElement('span');
  inlineBlock.style.setProperty('display', 'inline-block');
  inlineBlock.style.setProperty('width', '8ch');
  inlineBlock.textContent = 'Button';
  
  const span2 = document.createElement('span');
  span2.textContent = ' text after button';
  
  container.appendChild(span1);
  container.appendChild(inlineBlock);
  container.appendChild(span2);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  const bounds1 = span1.getBoundingClientRect();
  const buttonBounds = inlineBlock.getBoundingClientRect();
  const bounds2 = span2.getBoundingClientRect();
  
  // Inline-block should be atomic (single rectangle)
  const buttonRects = inlineBlock.getClientRects();
  expect(buttonRects.length).toBe(1);
  expect(buttonBounds.width).toBe(8); // Explicit width
  
  // Text spans may wrap
  const rects1 = span1.getClientRects();
  const rects2 = span2.getClientRects();
  
  // All elements should have valid positioning
  expect(bounds1.width).toBeGreaterThan(0);
  expect(buttonBounds.width).toBe(8);
  expect(bounds2.width).toBeGreaterThan(0);
  
  dispose();
});

test('deeply nested inline elements maintain layout integrity', () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  
  // Create a deeply nested structure: span > span > span
  const level1 = document.createElement('span');
  level1.textContent = 'Level 1 ';
  
  const level2 = document.createElement('span');
  level2.textContent = 'Level 2 ';
  
  const level3 = document.createElement('span');
  level3.textContent = 'Level 3';
  
  level2.appendChild(level3);
  level1.appendChild(level2);
  container.appendChild(level1);
  document.body.appendChild(container);
  
  // Trigger layout
  container.getBoundingClientRect();
  
  // All nested elements should have bounds
  const bounds1 = level1.getBoundingClientRect();
  const bounds2 = level2.getBoundingClientRect();
  const bounds3 = level3.getBoundingClientRect();
  
  expect(bounds1.width).toBeGreaterThan(0);
  expect(bounds2.width).toBeGreaterThan(0);
  expect(bounds3.width).toBeGreaterThan(0);
  
  // Nested elements should be positioned after their parent's text
  expect(bounds2.x).toBeGreaterThan(bounds1.x);
  expect(bounds3.x).toBeGreaterThan(bounds2.x);
  
  // All should be on the same line
  expect(bounds1.y).toBe(bounds2.y);
  expect(bounds2.y).toBe(bounds3.y);
  
  dispose();
});