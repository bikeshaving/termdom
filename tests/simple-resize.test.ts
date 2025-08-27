/**
 * Simple Terminal Resize Tests
 * Focus on basic CSSOM compliance without layout complexity
 */

import { test, expect } from 'bun:test';
import { TermDOM } from '../src/index.js';

test('window dimensions reflect initial terminal size', () => {
  const dom = new TermDOM({ width: 100, height: 30 });
  const { window } = dom;

  expect(window.innerWidth).toBe(100);
  expect(window.innerHeight).toBe(30);
  expect(window.outerWidth).toBe(100);
  expect(window.outerHeight).toBe(30);

  dom.dispose();
});

test('window dimensions are read-only', () => {
  const dom = new TermDOM({ width: 80, height: 24 });
  const { window } = dom;

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

  dom.dispose();
});

// TODO: Resize tests require runtime event system which was removed
// These tests are disabled until resize functionality is reimplemented