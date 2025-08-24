/**
 * Simple Terminal Resize Tests
 * Focus on basic CSSOM compliance without layout complexity
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

  // Attempting to change dimensions should fail silently or throw
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  try {
    (window as any).innerWidth = 120;
    (window as any).innerHeight = 40;
  } catch (e) {
    // Expected to throw since they're not writable
  }

  // Values should remain unchanged
  expect(window.innerWidth).toBe(originalWidth);
  expect(window.innerHeight).toBe(originalHeight);

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

  dispose();
});

test('resize fires DOM resize event on window', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { window, dispose } = createTTY({ runtime });

  let resizeEventFired = false;

  // Listen for resize event
  window.addEventListener('resize', () => {
    resizeEventFired = true;
  });

  // Allow for initial setup to complete
  await new Promise(resolve => setTimeout(resolve, 10));

  // Simulate terminal resize
  runtime.simulateResize(100, 30);

  // Allow for event processing
  await new Promise(resolve => setTimeout(resolve, 50));

  // Event should have fired
  expect(resizeEventFired).toBe(true);

  dispose();
});

test('document root width updates on resize', async () => {
  const runtime = new MockTTYRuntime({ dimensions: { columns: 80, rows: 24 } });
  const { document, dispose } = createTTY({ runtime });

  // Initial styles
  expect(document.documentElement.style.width).toBe('80ch');

  // Simulate resize
  runtime.simulateResize(120, 40);
  await new Promise(resolve => setTimeout(resolve, 50));

  // Document styles should be updated
  expect(document.documentElement.style.width).toBe('120ch');

  dispose();
});