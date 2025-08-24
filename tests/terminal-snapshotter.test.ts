/**
 * Tests for TerminalSnapshotter
 * 
 * Comprehensive test suite for ANSI processing and snapshot generation
 */

import { test, expect, describe } from "bun:test";
import { TerminalSnapshotter } from '../src/testing/TerminalSnapshotter.js';

// Helper to create snapshotter from string input
function createSnapshotter(input: string, options: { width?: number; height?: number } = {}): TerminalSnapshotter {
  return TerminalSnapshotter.fromString(input, options);
}

describe('TerminalSnapshotter', () => {
  describe('basic functionality', () => {
    test('creates empty screen initially', async () => {
      using snapshotter = createSnapshotter('', { width: 10, height: 5 });
      const snapshot = await snapshotter.getSnapshot();
      
      // Empty screen should produce empty string
      expect(snapshot).toBe('');
    });

    test('processes simple text output', async () => {
      using snapshotter = createSnapshotter('Hello World', { width: 20, height: 3 });
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toBe('Hello World');
    });

    test('handles text wrapping', async () => {
      using snapshotter = createSnapshotter('Hello World', { width: 5, height: 3 });
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toBe('Hello\n Worl\nd');
    });
  });

  describe('cursor movement', () => {
    test('cursor positioning with H command', async () => {
      using snapshotter = createSnapshotter('A\u001b[2;3HB', { width: 10, height: 5 });
      const snapshot = await snapshotter.getSnapshot();
      const lines = snapshot.split('\n');
      expect(lines[0]).toBe('A');
      expect(lines[1]).toBe('  B');
    });

    test('cursor up (A command)', async () => {
      using snapshotter = createSnapshotter('Line1\nLine2\u001b[1AC', { width: 10, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      const lines = snapshot.split('\n');
      expect(lines[0]).toBe('Line1C');
      expect(lines[1]).toBe('Line2');
    });

    test('cursor down (B command)', async () => {
      using snapshotter = createSnapshotter('A\u001b[2BB', { width: 10, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      const lines = snapshot.split('\n');
      expect(lines[0]).toBe('A');
      expect(lines[2]).toBe(' B'); // B is at column 1 after A moved cursor
    });

    test('cursor forward (C command)', async () => {
      using snapshotter = createSnapshotter('A\u001b[3CB', { width: 10, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toBe('A   B');
    });

    test('cursor backward (D command)', async () => {
      using snapshotter = createSnapshotter('ABCDE\u001b[3DF', { width: 10, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toBe('ABFDE');
    });
  });

  describe('screen clearing', () => {
    test('clear screen (J command with parameter 2)', async () => {
      using snapshotter = createSnapshotter('Hello\nWorld\u001b[2JNew', { width: 10, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toBe('New');
    });

    test('clear line (K command)', async () => {
      using snapshotter = createSnapshotter('Hello World\u001b[5D\u001b[K', { width: 20, height: 5 }); // Use wider screen to avoid wrapping
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toBe('Hello'); // Clears ' World' leaving 'Hello'
    });
  });

  describe('8-color ANSI support', () => {
    test('foreground colors', async () => {
      using snapshotter = createSnapshotter('\u001b[31mRed text\u001b[0m', { width: 20, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[31m');
      expect(snapshot).toContain('Red text');
      expect(snapshot).toContain('\u001b[0m');
    });

    test('background colors', async () => {
      using snapshotter = createSnapshotter('\u001b[44mBlue background\u001b[0m', { width: 20, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[44m');
      expect(snapshot).toContain('Blue background');
    });

    test('combined foreground and background', async () => {
      using snapshotter = createSnapshotter('\u001b[31;44mRed on blue\u001b[0m', { width: 20, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[31m');
      expect(snapshot).toContain('\u001b[44m');
      expect(snapshot).toContain('Red on blue');
    });
  });

  describe('24-bit RGB color support', () => {
    test('RGB foreground colors', async () => {
      using snapshotter = createSnapshotter('\u001b[38;2;255;128;64mOrange text\u001b[0m', { width: 30, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[38;2;255;128;64m');
      expect(snapshot).toContain('Orange text');
    });

    test('RGB background colors', async () => {
      using snapshotter = createSnapshotter('\u001b[48;2;64;128;255mBlue background\u001b[0m', { width: 30, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[48;2;64;128;255m');
      expect(snapshot).toContain('Blue background');
    });

    test('RGB color conversion to hex', async () => {
      using snapshotter = createSnapshotter('\u001b[38;2;171;205;239mCustom color\u001b[0m', { width: 30, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      // Should contain 24-bit RGB in output
      expect(snapshot).toContain('\u001b[38;2;171;205;239m');
    });
  });

  describe('256-color support', () => {
    test('256-color foreground', async () => {
      using snapshotter = createSnapshotter('\u001b[38;5;196mBright red\u001b[0m', { width: 30, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      // Should convert 256-color to named color or RGB
      expect(snapshot).toContain('Bright red');
    });

    test('256-color background', async () => {
      using snapshotter = createSnapshotter('\u001b[48;5;21mBlue background\u001b[0m', { width: 30, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('Blue background');
    });
  });

  describe('text styling', () => {
    test('bold text', async () => {
      using snapshotter = createSnapshotter('\u001b[1mBold text\u001b[0m', { width: 20, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[1m');
      expect(snapshot).toContain('Bold text');
    });

    test('italic text', async () => {
      using snapshotter = createSnapshotter('\u001b[3mItalic text\u001b[0m', { width: 20, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[3m');
      expect(snapshot).toContain('Italic text');
    });

    test('underlined text', async () => {
      using snapshotter = createSnapshotter('\u001b[4mUnderlined text\u001b[0m', { width: 20, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[4m');
      expect(snapshot).toContain('Underlined text');
    });

    test('combined styles', async () => {
      using snapshotter = createSnapshotter('\u001b[1;3;4mBold italic underlined\u001b[0m', { width: 30, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[1m');
      expect(snapshot).toContain('\u001b[3m');
      expect(snapshot).toContain('\u001b[4m');
    });

    test('style reset', async () => {
      using snapshotter = createSnapshotter('\u001b[1;31mBold red\u001b[0mNormal', { width: 30, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      const lines = snapshot.split('\n');
      expect(lines[0]).toContain('\u001b[1m');
      expect(lines[0]).toContain('\u001b[31m');
      expect(lines[0]).toContain('\u001b[0m');
      expect(lines[0]).toContain('Normal');
    });
  });

  describe('edge cases and error handling', () => {
    test('handles malformed ANSI sequences', async () => {
      using snapshotter = createSnapshotter('Hello\u001b[XYZWorld', { width: 20, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      // Should skip malformed sequence and continue with text
      expect(snapshot).toContain('Hello');
      expect(snapshot).toContain('World');
    });

    test('handles cursor movement beyond screen boundaries', async () => {
      using snapshotter = createSnapshotter('A\u001b[100;100HB', { width: 5, height: 3 });
      
      const snapshot = await snapshotter.getSnapshot();
      // Should clamp to screen bounds
      const lines = snapshot.split('\n');
      expect(lines[0]).toBe('A');
      expect(lines[2]).toMatch(/\s*B$/); // B should be at bottom-right
    });

    test('handles empty ANSI parameters', async () => {
      using snapshotter = createSnapshotter('A\u001b[;HB', { width: 10, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      // Empty params default to 1,1 position (0,0), so B overwrites A
      expect(snapshot).toBe('B');
    });

    test('preserves trailing spaces in styled content', async () => {
      using snapshotter = createSnapshotter('\u001b[44m    \u001b[0m', { width: 10, height: 3 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toContain('\u001b[44m');
      expect(snapshot.length).toBeGreaterThan(10); // Should preserve styled spaces
    });
  });

  describe('ReadableStream API', () => {
    test('consumes ReadableStream', async () => {
      const chunks = ['Hello ', '\u001b[31m', 'World', '\u001b[0m'];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach(chunk => controller.enqueue(chunk));
          controller.close();
        }
      });
      
      using snapshotter = new TerminalSnapshotter(stream, { width: 20, height: 5 });
      const snapshot = await snapshotter.getSnapshot();
      
      expect(snapshot).toContain('Hello');
      expect(snapshot).toContain('\u001b[31m');
      expect(snapshot).toContain('World');
      expect(snapshot).toContain('\u001b[0m');
    });

    test('handles empty stream', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        }
      });
      
      using snapshotter = new TerminalSnapshotter(stream, { width: 10, height: 5 });
      const snapshot = await snapshotter.getSnapshot();
      
      expect(snapshot).toBe('');
    });
  });

  describe('snapshot output format', () => {
    test('removes empty trailing lines', async () => {
      using snapshotter = createSnapshotter('Top line', { width: 10, height: 10 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toBe('Top line');
      expect(snapshot.split('\n')).toHaveLength(1);
    });

    test('preserves intermediate empty lines with content after', async () => {
      using snapshotter = createSnapshotter('Line 1\n\n\nLine 4', { width: 10, height: 5 });
      
      const snapshot = await snapshotter.getSnapshot();
      const lines = snapshot.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('Line 1');
      expect(lines[1]).toBe('');
      expect(lines[2]).toBe('');
      expect(lines[3]).toBe('Line 4');
    });

    test('trims trailing spaces on lines without ANSI codes', async () => {
      using snapshotter = createSnapshotter('Hello     ', { width: 20, height: 3 });
      
      const snapshot = await snapshotter.getSnapshot();
      expect(snapshot).toBe('Hello');
    });
  });
});