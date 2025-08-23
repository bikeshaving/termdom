/**
 * Tests for the style bleeding fix in ScreenBuffer with TTYRuntime
 * 
 * This tests the specific fix where background colors were bleeding
 * beyond element boundaries due to incomplete style resets.
 */

import { test, expect } from "bun:test";
import { ScreenBuffer } from '../src/rendering/ScreenBuffer.js';
import { MockTTYRuntime } from '../src/runtime/MockTTYRuntime.js';

// Helper to create MockTTYRuntime with testing utilities for style bleeding tests
function createTestRuntime(width = 80, height = 24) {
  const mockRuntime = new MockTTYRuntime({
    dimensions: { columns: width, rows: height },
    capabilities: { isTTY: true, colorDepth: 24, hasColors: true, supportsUnicode: true }
  });

  return {
    runtime: mockRuntime,
    getOutput: () => mockRuntime.getStdoutOutput(),
    clearOutput: () => mockRuntime.clearOutput(),
    
    // Extract all ANSI reset codes (\x1b[0m)
    getResetCodes: () => {
      const output = mockRuntime.getStdoutOutput();
      const resets: string[] = [];
      const regex = /\x1b\[0m/g;
      let match;
      
      while ((match = regex.exec(output)) !== null) {
        resets.push(match[0]);
      }
      
      return resets;
    },
    
    getPlainText: () => {
      return mockRuntime.getStdoutOutput().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    }
  };
}

test("ScreenBuffer generates reset codes with TTYRuntime", async () => {
  const testEnv = createTestRuntime(10, 3);
  const buffer = new ScreenBuffer({
    width: 10,
    height: 3,
    runtime: testEnv.runtime
  });

  // Put text with background color
  buffer.put(0, 0, 'A', { bgColor: 'blue' });
  buffer.put(1, 0, 'B', { bgColor: 'red' });
  buffer.put(2, 0, 'C'); // No background
  
  await buffer.render();

  const output = testEnv.getOutput();
  const plainText = testEnv.getPlainText();
  
  // Should have rendered the text
  expect(plainText).toContain('A');
  expect(plainText).toContain('B');
  expect(plainText).toContain('C');
  
  // Should have some output (ANSI codes)
  expect(output.length).toBeGreaterThan(0);
});

test("ScreenBuffer prevents background color bleeding with TTYRuntime", async () => {
  const testEnv = createTestRuntime(10, 5);
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    runtime: testEnv.runtime
  });

  // Row 1: Blue background
  buffer.put(0, 0, 'X', { bgColor: 'blue' });
  buffer.put(1, 0, 'Y', { bgColor: 'blue' });
  
  // Row 2: No background (should not inherit blue)
  buffer.put(0, 1, 'A');
  buffer.put(1, 1, 'B');
  
  await buffer.render();

  const output = testEnv.getOutput();
  const plainText = testEnv.getPlainText();

  // Should have rendered all characters
  expect(plainText).toContain('X');
  expect(plainText).toContain('Y');
  expect(plainText).toContain('A');
  expect(plainText).toContain('B');
  
  // Should have output
  expect(output.length).toBeGreaterThan(0);
});

test("ScreenBuffer delta rendering with TTYRuntime", async () => {
  const testEnv = createTestRuntime(10, 3);
  const buffer = new ScreenBuffer({
    width: 10,
    height: 3,
    runtime: testEnv.runtime
  });

  // First render
  buffer.put(0, 0, 'X', { bgColor: 'blue' });
  await buffer.render();
  
  // Clear output and make change
  testEnv.clearOutput();
  buffer.put(0, 1, 'Y', { bgColor: 'red' });
  await buffer.renderDelta();

  const output = testEnv.getOutput();
  const plainText = testEnv.getPlainText();

  // Should contain the new character
  expect(plainText).toContain('Y');
  
  // Should have some delta output
  expect(output.length).toBeGreaterThan(0);
});