/**
 * Comprehensive unit tests for ScreenBuffer with TTYRuntime
 */

import { test, expect } from "bun:test";
// DOMRect available from standard DOM types in JSDOM
import { ScreenBuffer } from '../src/rendering/ScreenBuffer.js';
import { MockTTYRuntime } from '../src/runtime/MockTTYRuntime.js';
import { createTTY } from '../src/core/createTTYDocument.js';

// Helper to create MockTTYRuntime with testing utilities
function createTestRuntime(width = 80, height = 24) {
  const mockRuntime = new MockTTYRuntime({
    dimensions: { width, height },
    capabilities: { isTTY: true, colorDepth: 24, hasColors: true, supportsUnicode: true }
  });

  // Get a window instance for ScreenBuffer
  const { window, dispose } = createTTY({ runtime: mockRuntime });

  return {
    runtime: mockRuntime,
    window,
    dispose,
    getOutput: () => mockRuntime.getStdoutOutput(),
    getPlainText: () => {
      // Strip ANSI escape sequences for plain text comparison  
      return mockRuntime.getStdoutOutput().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    },
    getColorCodes: () => {
      // Extract color codes from output
      const colorRegex = /\x1b\[(3[0-7]|4[0-7]|[0-9;]*)[m]/g;
      const output = mockRuntime.getStdoutOutput();
      return output.match(colorRegex) || [];
    },
    getCursorPositions: () => {
      // Extract cursor position codes from output
      const posRegex = /\x1b\[(\d+);(\d+)H/g;
      const positions: Array<{x: number, y: number}> = [];
      const output = mockRuntime.getStdoutOutput();
      let match;
      
      while ((match = posRegex.exec(output)) !== null) {
        const y = parseInt(match[1]) - 1; // Convert from 1-based to 0-based
        const x = parseInt(match[2]) - 1; // Convert from 1-based to 0-based
        positions.push({ x, y });
      }
      
      return positions;
    },
    clearOutput: () => mockRuntime.clearOutput()
  };
}

test("ScreenBuffer basic construction", () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  expect(buffer.width).toBe(10);
  expect(buffer.height).toBe(5);
});

test("ScreenBuffer construction with defaults", () => {
  const testEnv = createTestRuntime(80, 24);
  const buffer = new ScreenBuffer({ runtime: testEnv.runtime, window: testEnv.window });

  expect(buffer.width).toBe(80);
  expect(buffer.height).toBe(24);
});

test("ScreenBuffer construction with offset", () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    x: 5,
    y: 3,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  expect(buffer.x).toBe(5);
  expect(buffer.y).toBe(3);
});

test("ScreenBuffer put single character", async () => {
  const testEnv = createTestRuntime(10, 5);
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(2, 1, 'A');
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('A');
});

test("ScreenBuffer put string", async () => {
  const testEnv = createTestRuntime(20, 5);
  const buffer = new ScreenBuffer({
    width: 20,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(0, 0, 'Hello World');
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('Hello World');
});

test("ScreenBuffer with colors", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(0, 0, 'Red Text', { fgColor: 'red' });
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('Red Text');
  
  // MockTTYRuntime should have recorded color changes
  const styles = testEnv.runtime.getCurrentStyles();
  expect(styles.length).toBeGreaterThan(0);
});

test("ScreenBuffer with background color", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(0, 0, 'Text', { bgColor: 'blue', fgColor: 'white' });
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('Text');
  
  // MockTTYRuntime should have recorded color changes
  const styles = testEnv.runtime.getCurrentStyles();
  expect(styles.length).toBeGreaterThan(0);
});

test("ScreenBuffer text clipping", async () => {
  const testEnv = createTestRuntime(5, 1); // Very small buffer
  const buffer = new ScreenBuffer({
    width: 5,
    height: 1,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(0, 0, 'This text is too long');
  await buffer.render();

  const plainText = testEnv.getPlainText();
  // Should only contain the first 5 characters
  expect(plainText).toContain('This ');
  expect(plainText).not.toContain('text is too long');
});

test("ScreenBuffer clear", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  // Put some text
  buffer.put(0, 0, 'Test');
  buffer.clear();
  await buffer.render();

  const plainText = testEnv.getPlainText();
  // Should be mostly empty (just spaces)
  expect(plainText.trim()).toBe('');
});

test("ScreenBuffer fill region", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  const region = new testEnv.window.DOMRect(2, 1, 4, 2);
  buffer.fill(region, '#', { fgColor: 'red' });
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('#');
  
  // Check that we have multiple # characters (filled region)
  const hashCount = (plainText.match(/#/g) || []).length;
  expect(hashCount).toBeGreaterThanOrEqual(4); // At least 4 # chars
});

test("ScreenBuffer delta rendering", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  // First render
  buffer.put(0, 0, 'Initial');
  await buffer.render();
  const firstOutput = testEnv.getOutput();
  
  // Clear mock output and make small change
  testEnv.clearOutput();
  buffer.put(0, 1, 'Changed');
  await buffer.renderDelta();

  const secondOutput = testEnv.getOutput();
  
  // Second render should have some output (the changes)
  expect(secondOutput.length).toBeGreaterThan(0);
  
  // Check that the delta contains the changed text (may be character by character)
  const deltaPlainText = secondOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  expect(deltaPlainText).toContain('Changed');
});

test("ScreenBuffer Unicode handling", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 20,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(0, 0, '👋 Hello 🌍');
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('👋');
  expect(plainText).toContain('🌍');
  expect(plainText).toContain('Hello');
});

test("ScreenBuffer style inheritance", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 20,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(0, 0, 'Bold', { bold: true, fgColor: 'red' });
  buffer.put(5, 0, 'Normal');
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('Bold');
  expect(plainText).toContain('Normal');
});

test("ScreenBuffer multiple lines", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(0, 0, 'Line 1');
  buffer.put(0, 1, 'Line 2');
  buffer.put(0, 2, 'Line 3');
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('Line 1');
  expect(plainText).toContain('Line 2');
  expect(plainText).toContain('Line 3');
});

test("ScreenBuffer positioned rendering", async () => {
  const testEnv = createTestRuntime();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    x: 10,
    y: 5,
    runtime: testEnv.runtime,
    window: testEnv.window
  });

  buffer.put(0, 0, 'Positioned');
  await buffer.render();

  const plainText = testEnv.getPlainText();
  expect(plainText).toContain('Positioned');
});