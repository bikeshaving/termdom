/**
 * Comprehensive unit tests for ScreenBuffer
 */

import { test, expect } from "bun:test";
import { Writable } from "stream";
import { ScreenBuffer } from '../src/rendering/ScreenBuffer.js';

// Reuse the MockStdout from our previous test
class MockStdout extends Writable {
  public output: string = '';
  public columns: number = 80;
  public rows: number = 24;
  public isTTY: boolean = true;

  _write(chunk: any, encoding: any, callback: any) {
    this.output += chunk.toString();
    callback();
  }

  hasColors(): boolean {
    return true;
  }

  getOutput(): string {
    return this.output;
  }

  clearOutput(): void {
    this.output = '';
  }

  // Helper to extract text content without ANSI codes
  getPlainText(): string {
    return this.output.replace(/\x1b\[[0-9;]*[mGKHJ]/g, '');
  }

  // Helper to extract cursor positions
  getCursorPositions(): Array<{x: number, y: number}> {
    const positions: Array<{x: number, y: number}> = [];
    const regex = /\x1b\[(\d+);(\d+)H/g;
    let match;
    
    while ((match = regex.exec(this.output)) !== null) {
      positions.push({
        y: parseInt(match[1]) - 1, // Convert to 0-based
        x: parseInt(match[2]) - 1  // Convert to 0-based
      });
    }
    
    return positions;
  }

  // Helper to extract color codes
  getColorCodes(): string[] {
    const colors: string[] = [];
    const regex = /\x1b\[([0-9;]+)m/g;
    let match;
    
    while ((match = regex.exec(this.output)) !== null) {
      colors.push(match[1]);
    }
    
    return colors;
  }
}

test("ScreenBuffer basic construction", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    output: mockOut
  });

  expect(buffer.width).toBe(10);
  expect(buffer.height).toBe(5);
  expect(buffer.x).toBe(0);
  expect(buffer.y).toBe(0);
});

test("ScreenBuffer with custom position", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    x: 5,
    y: 3,
    output: mockOut
  });

  expect(buffer.x).toBe(5);
  expect(buffer.y).toBe(3);
});

test("ScreenBuffer put single character", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    output: mockOut
  });

  buffer.put(2, 1, 'A');
  buffer.render();

  const positions = mockOut.getCursorPositions();
  expect(positions).toContainEqual({ x: 0, y: 0 }); // Line 0 start
  expect(positions).toContainEqual({ x: 0, y: 1 }); // Line 1 start

  const plainText = mockOut.getPlainText();
  expect(plainText).toContain('A');
});

test("ScreenBuffer put string", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 20,
    height: 5,
    output: mockOut
  });

  buffer.put(0, 0, 'Hello World');
  buffer.render();

  const plainText = mockOut.getPlainText();
  expect(plainText).toContain('Hello World');
});

test("ScreenBuffer with colors", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 20,
    height: 5,
    output: mockOut
  });

  buffer.put(0, 0, 'Red Text', { fgColor: 'red' });
  buffer.render();

  const colors = mockOut.getColorCodes();
  expect(colors.length).toBeGreaterThan(0);
  
  const plainText = mockOut.getPlainText();
  expect(plainText).toContain('Red Text');
});

test("ScreenBuffer with background color", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 20,
    height: 5,
    output: mockOut
  });

  buffer.put(0, 0, 'Text', { bgColor: 'blue', fgColor: 'white' });
  buffer.render();

  const colors = mockOut.getColorCodes();
  expect(colors.length).toBeGreaterThan(0);
});

test("ScreenBuffer text clipping", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 5,
    height: 3,
    output: mockOut
  });

  // Text should be clipped at buffer width
  buffer.put(0, 0, 'This text is too long');
  buffer.render();

  const plainText = mockOut.getPlainText();
  // Should only contain the first 5 characters per line
  expect(plainText).toContain('This ');
  expect(plainText).not.toContain('text is too long');
});

test("ScreenBuffer out of bounds", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 5,
    height: 3,
    output: mockOut
  });

  // These should not crash or render
  buffer.put(-1, 0, 'Negative X');
  buffer.put(0, -1, 'Negative Y'); 
  buffer.put(0, 10, 'Too far Y');
  buffer.render();

  // Should render empty buffer
  const plainText = mockOut.getPlainText();
  expect(plainText).not.toContain('Negative');
  expect(plainText).not.toContain('Too far');
});

test("ScreenBuffer clear", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 3,
    output: mockOut
  });

  buffer.put(0, 0, 'Hello');
  buffer.clear();
  buffer.render();

  const plainText = mockOut.getPlainText();
  // Should contain only spaces
  expect(plainText.replace(/\s/g, '')).toBe('');
});

test("ScreenBuffer fill region", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    output: mockOut
  });

  const region = { x: 2, y: 1, width: 4, height: 2 };
  buffer.fill(region, '#', { fgColor: 'red' });
  buffer.render();

  const plainText = mockOut.getPlainText();
  expect(plainText).toContain('#');
  
  const colors = mockOut.getColorCodes();
  expect(colors.length).toBeGreaterThan(0);
});

test("ScreenBuffer delta rendering", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 5,
    output: mockOut
  });

  // First render
  buffer.put(0, 0, 'Hello');
  buffer.renderDelta();
  
  const firstOutput = mockOut.getOutput();
  mockOut.clearOutput();

  // Second render with changes
  buffer.put(6, 0, 'World');
  buffer.renderDelta();
  
  const secondOutput = mockOut.getOutput();
  
  // Second render should be smaller (only changed cells)
  expect(secondOutput.length).toBeLessThan(firstOutput.length);
  
  // Delta rendering puts each character individually, so check for individual letters
  const plainSecond = mockOut.getPlainText();
  expect(plainSecond).toContain('W');
  expect(plainSecond).toContain('o');
  expect(plainSecond).toContain('r');
  expect(plainSecond).toContain('l');
});

test("ScreenBuffer Unicode handling", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 20,
    height: 5,
    output: mockOut
  });

  buffer.put(0, 0, '👋 Hello 🌍');
  buffer.render();

  const plainText = mockOut.getPlainText();
  expect(plainText).toContain('👋');
  expect(plainText).toContain('🌍');
});

test("ScreenBuffer style inheritance", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 20,
    height: 5,
    output: mockOut
  });

  // Put text with different styles
  buffer.put(0, 0, 'Bold', { bold: true });
  buffer.put(5, 0, 'Normal');
  buffer.put(12, 0, 'Italic', { italic: true });
  
  buffer.render();

  const colors = mockOut.getColorCodes();
  const plainText = mockOut.getPlainText();
  
  expect(plainText).toContain('Bold');
  expect(plainText).toContain('Normal');  
  expect(plainText).toContain('Italic');
});

test("ScreenBuffer multiple lines", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 3,
    output: mockOut
  });

  buffer.put(0, 0, 'Line 1');
  buffer.put(0, 1, 'Line 2');
  buffer.put(0, 2, 'Line 3');
  
  buffer.render();

  const positions = mockOut.getCursorPositions();
  const plainText = mockOut.getPlainText();
  
  // Should have cursor positions for each line
  expect(positions.length).toBeGreaterThanOrEqual(3);
  expect(plainText).toContain('Line 1');
  expect(plainText).toContain('Line 2');
  expect(plainText).toContain('Line 3');
});

test("ScreenBuffer positioned rendering", () => {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({
    width: 5,
    height: 3,
    x: 10,  // Offset position
    y: 5,
    output: mockOut
  });

  buffer.put(0, 0, 'Test');
  buffer.render();

  const positions = mockOut.getCursorPositions();
  
  // Should position cursor at offset coordinates
  // Note: ANSI coordinates are 1-based
  expect(positions).toContainEqual({ x: 10, y: 5 }); // First line at offset
});

// Helper function for testing with mock terminal
function createTestBuffer(width = 20, height = 10, x = 0, y = 0) {
  const mockOut = new MockStdout();
  const buffer = new ScreenBuffer({ width, height, x, y, output: mockOut });
  return { buffer, mockOut };
}