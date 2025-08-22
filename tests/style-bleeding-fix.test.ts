/**
 * Tests for the style bleeding fix in ScreenBuffer
 * 
 * This tests the specific fix where background colors were bleeding
 * beyond element boundaries due to incomplete style resets.
 */

import { test, expect } from "bun:test";
import { Writable } from "stream";
import { ScreenBuffer } from '../src/rendering/ScreenBuffer.js';

class MockTerminal extends Writable {
  public output: string = '';
  public columns: number = 80;
  public rows: number = 24;
  public isTTY: boolean = true;

  _write(chunk: any, encoding: any, callback: any) {
    this.output += chunk.toString();
    callback();
  }

  getOutput(): string {
    return this.output;
  }

  clearOutput(): void {
    this.output = '';
  }

  // Extract all ANSI reset codes (\x1b[0m)
  getResetCodes(): string[] {
    const resets: string[] = [];
    const regex = /\x1b\[0m/g;
    let match;
    
    while ((match = regex.exec(this.output)) !== null) {
      resets.push(match[0]);
    }
    
    return resets;
  }

  // Extract all background color codes
  getBackgroundColors(): string[] {
    const colors: string[] = [];
    const regex = /\x1b\[48;[0-9;]+m/g;
    let match;
    
    while ((match = regex.exec(this.output)) !== null) {
      colors.push(match[0]);
    }
    
    return colors;
  }

  // Check if output contains proper style sequence structure
  hasProperStyleSequences(): boolean {
    // Each style sequence should start with reset (\x1b[0m) followed by specific styles
    const sequences = this.output.match(/\x1b\[0m[^\x1b]*/g) || [];
    return sequences.length > 0;
  }
}

test("ScreenBuffer generates reset codes before styles", () => {
  const terminal = new MockTerminal();
  const buffer = new ScreenBuffer({
    width: 10,
    height: 3,
    output: terminal
  });

  // Put text with background color
  buffer.put(0, 0, 'A', { bgColor: 'blue' });
  buffer.put(1, 0, 'B', { bgColor: 'red' });
  buffer.put(2, 0, 'C'); // No background
  
  buffer.render();

  const output = terminal.getOutput();
  const resets = terminal.getResetCodes();
  
  // Should have reset codes before each style change
  expect(resets.length).toBeGreaterThanOrEqual(3); // At least one per character
  
  // Each cell should start with a reset
  expect(output).toMatch(/\x1b\[0m.*A/);
  expect(output).toMatch(/\x1b\[0m.*B/);
  expect(output).toMatch(/\x1b\[0m.*C/);
});

test("ScreenBuffer prevents background color bleeding", () => {
  const terminal = new MockTerminal();
  const buffer = new ScreenBuffer({
    width: 5,
    height: 2,
    output: terminal
  });

  // Row 1: Blue background
  buffer.put(0, 0, 'X', { bgColor: 'blue' });
  buffer.put(1, 0, 'Y', { bgColor: 'blue' });
  
  // Row 2: No background (should not inherit blue)
  buffer.put(0, 1, 'A');
  buffer.put(1, 1, 'B');
  
  buffer.render();

  const output = terminal.getOutput();
  
  // Row 2 characters should have resets, preventing blue bleeding
  expect(output).toMatch(/\x1b\[0m.*A/);
  expect(output).toMatch(/\x1b\[0m.*B/);
  
  // Each position should have its own reset
  const resets = terminal.getResetCodes();
  expect(resets.length).toBeGreaterThanOrEqual(4); // One per character
});

test("ScreenBuffer delta rendering prevents color bleeding", () => {
  const terminal = new MockTerminal();
  const buffer = new ScreenBuffer({
    width: 5,
    height: 2,
    output: terminal
  });

  // Initial render with background
  buffer.put(0, 0, 'X', { bgColor: 'red' });
  buffer.renderDelta();
  
  terminal.clearOutput();
  
  // Change adjacent cell without background
  buffer.put(1, 0, 'Y'); // No background
  buffer.renderDelta();
  
  const output = terminal.getOutput();
  
  // Delta render format: cursor_position + style_sequence + character + final_reset
  // Should contain Y and a reset code somewhere
  expect(output).toContain('Y');
  expect(output).toContain('\x1b[0m');
  
  const resets = terminal.getResetCodes();
  expect(resets.length).toBeGreaterThanOrEqual(1);
});

test("ScreenBuffer handles mixed styles correctly", () => {
  const terminal = new MockTerminal();
  const buffer = new ScreenBuffer({
    width: 8,
    height: 1,
    output: terminal
  });

  // Mixed styles in one row
  buffer.put(0, 0, 'A', { fgColor: 'red', bgColor: 'blue' });
  buffer.put(1, 0, 'B', { fgColor: 'green' }); // Only foreground
  buffer.put(2, 0, 'C', { bgColor: 'yellow' }); // Only background
  buffer.put(3, 0, 'D'); // No styles
  buffer.put(4, 0, 'E', { bold: true, bgColor: 'cyan' });
  
  buffer.render();

  const output = terminal.getOutput();
  
  // Each character should have proper reset
  ['A', 'B', 'C', 'D', 'E'].forEach(char => {
    expect(output).toMatch(new RegExp(`\\x1b\\[0m.*${char}`));
  });
  
  // Should have resets for all positions
  const resets = terminal.getResetCodes();
  expect(resets.length).toBeGreaterThanOrEqual(5);
});

test("ScreenBuffer delta rendering tracks style changes", () => {
  const terminal = new MockTerminal();
  const buffer = new ScreenBuffer({
    width: 3,
    height: 1,
    output: terminal
  });

  // Initial state
  buffer.put(0, 0, 'A', { bgColor: 'red' });
  buffer.put(1, 0, 'B', { bgColor: 'red' });
  buffer.put(2, 0, 'C', { bgColor: 'red' });
  buffer.renderDelta();
  
  terminal.clearOutput();
  
  // Change middle cell to different style
  buffer.put(1, 0, 'X', { bgColor: 'blue', fgColor: 'white' });
  buffer.renderDelta();
  
  const output = terminal.getOutput();
  
  // Should contain the changed character and a reset
  expect(output).toContain('X');
  expect(output).toContain('\x1b[0m');
  
  // Should not render unchanged cells
  expect(output).not.toContain('A');
  expect(output).not.toContain('C');
  
  const resets = terminal.getResetCodes();
  expect(resets.length).toBeGreaterThanOrEqual(1); // At least one reset
});

test("ScreenBuffer clears styles properly", () => {
  const terminal = new MockTerminal();
  const buffer = new ScreenBuffer({
    width: 3,
    height: 1,
    output: terminal
  });

  // Add styled content
  buffer.put(0, 0, 'A', { bgColor: 'red', bold: true });
  buffer.put(1, 0, 'B', { fgColor: 'blue', italic: true });
  
  // Clear and re-render
  buffer.clear();
  buffer.render();
  
  const output = terminal.getOutput();
  
  // Should have resets even for cleared content
  const resets = terminal.getResetCodes();
  expect(resets.length).toBeGreaterThan(0);
  
  // Should contain spaces and reset codes
  expect(output).toContain(' ');
  expect(output).toContain('\x1b[0m');
});

test("ScreenBuffer handles empty cells correctly", () => {
  const terminal = new MockTerminal();
  const buffer = new ScreenBuffer({
    width: 3,
    height: 1,
    output: terminal
  });

  // Put only some characters, leaving gaps
  buffer.put(0, 0, 'A', { bgColor: 'red' });
  // Skip position 1
  buffer.put(2, 0, 'C', { bgColor: 'blue' });
  
  buffer.render();
  
  const output = terminal.getOutput();
  
  // All positions should have resets, including empty ones
  const resets = terminal.getResetCodes();
  expect(resets.length).toBeGreaterThanOrEqual(3); // One per column
  
  // Empty position should also have reset before space
  expect(output).toMatch(/\x1b\[0m.*A/);
  expect(output).toMatch(/\x1b\[0m /); // Empty cell
  expect(output).toMatch(/\x1b\[0m.*C/);
});