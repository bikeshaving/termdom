/**
 * Terminal Resize Handling Tests
 * 
 * Tests to ensure terminal resize is handled correctly with CSSOM compliance
 */

import { test, expect } from 'bun:test';
import { createTTY } from '../src/index.js';
import { MockTTYRuntime } from '../src/runtime/MockTTYRuntime.js';

test('window dimensions reflect initial terminal size', () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 100, rows: 30 } });
  const { window, dispose } = createTTY({ runtime });

  expect(window.innerWidth).toBe(100);
  expect(window.innerHeight).toBe(30);
  expect(window.outerWidth).toBe(100);
  expect(window.outerHeight).toBe(30);

  dispose();
});

test('window dimensions are read-only', () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { window, dispose } = createTTY({ runtime });

  // Attempting to change dimensions should fail
  expect(() => {
    (window as any).innerWidth = 120;
  }).toThrow();

  expect(() => {
    (window as any).innerHeight = 40;
  }).toThrow();

  // Values should remain unchanged
  expect(window.innerWidth).toBe(80);
  expect(window.innerHeight).toBe(24);

  dispose();
});

test('resize updates window dimensions', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { window, dispose } = createTTY({ runtime });

  // Initial size
  expect(window.innerWidth).toBe(80);
  expect(window.innerHeight).toBe(24);

  // Simulate terminal resize
  runtime.simulateResize(120, 40);

  // Allow for event processing
  await new Promise(resolve => setTimeout(resolve, 10));

  // Window dimensions should be updated
  expect(window.innerWidth).toBe(120);
  expect(window.innerHeight).toBe(40);
  expect(window.outerWidth).toBe(120);
  expect(window.outerHeight).toBe(40);

  dispose();
});

test('resize fires DOM resize event', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { window, dispose } = createTTY({ runtime });

  let resizeEventFired = false;
  let eventDimensions: any = null;

  // Listen for resize event
  window.addEventListener('resize', () => {
    resizeEventFired = true;
    eventDimensions = {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    };
  });

  // Simulate terminal resize
  runtime.simulateResize(100, 30);

  // Allow for event processing
  await new Promise(resolve => setTimeout(resolve, 10));

  // Event should have fired with correct dimensions
  expect(resizeEventFired).toBe(true);
  expect(eventDimensions).toEqual({
    innerWidth: 100,
    innerHeight: 30
  });

  dispose();
});

test('resize updates document root styles', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { document, dispose } = createTTY({ runtime });

  // Initial styles
  expect(document.documentElement.style.width).toBe('80ch');

  // Simulate resize
  runtime.simulateResize(120, 40);
  await new Promise(resolve => setTimeout(resolve, 10));

  // Document styles should be updated
  expect(document.documentElement.style.width).toBe('120ch');

  dispose();
});

test('resize updates fullscreen mode document height', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { document, dispose } = createTTY({ 
    runtime, 
    mode: 'fullscreen' 
  });

  // Initial styles in fullscreen mode
  expect(document.documentElement.style.width).toBe('80ch');
  expect(document.documentElement.style.height).toBe('24ch');

  // Simulate resize
  runtime.simulateResize(100, 30);
  await new Promise(resolve => setTimeout(resolve, 10));

  // Both width and height should be updated in fullscreen mode
  expect(document.documentElement.style.width).toBe('100ch');
  expect(document.documentElement.style.height).toBe('30ch');

  dispose();
});

test('resize triggers layout recomputation', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { document, dispose } = createTTY({ runtime });

  // Create element that should adapt to new width
  const div = document.createElement('div');
  div.style.width = '100%';
  div.style.backgroundColor = 'red';
  div.textContent = 'Full width element';
  document.body.appendChild(div);

  // Wait for initial layout
  await new Promise(resolve => setTimeout(resolve, 10));

  // Check initial bounds
  const initialBounds = div.getBoundingClientRect();
  expect(initialBounds.width).toBe(80);

  // Resize terminal
  runtime.simulateResize(120, 30);
  await new Promise(resolve => setTimeout(resolve, 10));

  // Bounds should reflect new terminal width
  const newBounds = div.getBoundingClientRect();
  expect(newBounds.width).toBe(120);

  dispose();
});

test('multiple rapid resizes are handled gracefully', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { window, dispose } = createTTY({ runtime });

  let resizeCount = 0;
  window.addEventListener('resize', () => {
    resizeCount++;
  });

  // Rapid resize sequence
  runtime.simulateResize(90, 25);
  runtime.simulateResize(100, 26);
  runtime.simulateResize(110, 27);
  runtime.simulateResize(120, 28);

  // Wait for all events to process
  await new Promise(resolve => setTimeout(resolve, 50));

  // Should have fired for each resize
  expect(resizeCount).toBe(4);
  
  // Final dimensions should be correct
  expect(window.innerWidth).toBe(120);
  expect(window.innerHeight).toBe(28);

  dispose();
});

test('resize works with colored backgrounds', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 40, rows: 10 } });
  const { document, dispose } = createTTY({ runtime });

  // Create colored background element
  const div = document.createElement('div');
  div.style.backgroundColor = 'blue';
  div.style.display = 'block';
  div.textContent = 'Blue background';
  document.body.appendChild(div);

  await new Promise(resolve => setTimeout(resolve, 10));

  // Resize to larger terminal
  runtime.simulateResize(80, 20);
  await new Promise(resolve => setTimeout(resolve, 10));

  // Background should now extend to new width
  const bounds = div.getBoundingClientRect();
  expect(bounds.width).toBe(80); // Should fill new terminal width

  dispose();
});