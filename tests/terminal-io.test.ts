/**
 * Test terminal I/O abstraction with Bun's file system
 */

import { test, expect } from "bun:test";
import { StringDecoder } from "string_decoder";

// Test Bun's file abstractions for terminal testing
test("Bun file abstractions exploration", () => {
  // Check what Bun provides for stdin/stdout testing
  console.log("Bun.stdin:", typeof Bun.stdin);
  console.log("Bun.stdout:", typeof Bun.stdout);
  console.log("Bun.stderr:", typeof Bun.stderr);
  
  // Check if Bun files have terminal properties
  if (Bun.stdout) {
    console.log("Bun.stdout properties:", Object.getOwnPropertyNames(Bun.stdout));
  }
  
  // Test process streams
  console.log("process.stdout.columns:", process.stdout.columns);
  console.log("process.stdout.rows:", process.stdout.rows);
  console.log("process.stdout.isTTY:", process.stdout.isTTY);
});

// Create a mock terminal interface for testing
export interface MockTerminalOptions {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
}

export class MockTerminal {
  public columns: number;
  public rows: number;
  public isTTY: boolean;
  private output: string[] = [];
  private input: string[] = [];
  private inputIndex = 0;
  
  constructor(options: MockTerminalOptions = {}) {
    this.columns = options.columns ?? 80;
    this.rows = options.rows ?? 24;
    this.isTTY = options.isTTY ?? true;
  }
  
  // Mock stdout
  write(data: string | Buffer): boolean {
    const str = typeof data === 'string' ? data : data.toString();
    this.output.push(str);
    return true;
  }
  
  // Mock stdin
  setInput(input: string[]): void {
    this.input = input;
    this.inputIndex = 0;
  }
  
  read(): string | null {
    if (this.inputIndex < this.input.length) {
      return this.input[this.inputIndex++];
    }
    return null;
  }
  
  // Get captured output
  getOutput(): string {
    return this.output.join('');
  }
  
  getOutputLines(): string[] {
    return [...this.output];
  }
  
  // Clear output buffer
  clearOutput(): void {
    this.output = [];
  }
  
  // Mock methods for Node.js streams compatibility
  on(event: string, listener: (...args: any[]) => void): this {
    return this;
  }
  
  once(event: string, listener: (...args: any[]) => void): this {
    return this;
  }
  
  setRawMode(mode: boolean): this {
    return this;
  }
  
  pause(): this {
    return this;
  }
  
  resume(): this {
    return this;
  }
}

test("MockTerminal basic functionality", () => {
  const terminal = new MockTerminal({ columns: 40, rows: 10 });
  
  // Test writing
  terminal.write("Hello World");
  terminal.write("\x1b[31mRed text\x1b[0m");
  
  expect(terminal.getOutput()).toBe("Hello World\x1b[31mRed text\x1b[0m");
  expect(terminal.columns).toBe(40);
  expect(terminal.rows).toBe(10);
  
  // Test input
  terminal.setInput(["a", "b", "c"]);
  expect(terminal.read()).toBe("a");
  expect(terminal.read()).toBe("b");
  expect(terminal.read()).toBe("c");
  expect(terminal.read()).toBe(null);
});

test("ANSI escape sequence detection", () => {
  const terminal = new MockTerminal();
  
  // Test various ANSI sequences
  terminal.write("\x1b[2J");        // Clear screen
  terminal.write("\x1b[H");         // Home cursor
  terminal.write("\x1b[31mRed\x1b[0m");  // Color
  terminal.write("\x1b[1;1H");      // Position cursor
  
  const output = terminal.getOutput();
  
  // Should contain ANSI sequences
  expect(output).toContain("\x1b[2J");
  expect(output).toContain("\x1b[H");
  expect(output).toContain("\x1b[31m");
  expect(output).toContain("\x1b[0m");
  expect(output).toContain("\x1b[1;1H");
});

// Helper to extract cursor positioning from ANSI output
export function extractCursorPositions(output: string): Array<{x: number, y: number}> {
  const positions: Array<{x: number, y: number}> = [];
  const regex = /\x1b\[(\d+);(\d+)H/g;
  let match;
  
  while ((match = regex.exec(output)) !== null) {
    positions.push({
      y: parseInt(match[1]) - 1, // Convert to 0-based
      x: parseInt(match[2]) - 1  // Convert to 0-based
    });
  }
  
  return positions;
}

test("ANSI cursor position extraction", () => {
  const output = "\x1b[1;1HHello\x1b[2;5HWorld\x1b[10;20HTest";
  const positions = extractCursorPositions(output);
  
  expect(positions).toEqual([
    { x: 0, y: 0 },   // 1;1H -> 0,0
    { x: 4, y: 1 },   // 2;5H -> 4,1  
    { x: 19, y: 9 }   // 10;20H -> 19,9
  ]);
});

// Helper to strip ANSI codes for text-only comparison
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[mGKHJ]/g, '');
}

test("ANSI stripping", () => {
  const coloredText = "\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m";
  expect(stripAnsi(coloredText)).toBe("Red Green");
  
  const positioned = "\x1b[1;1HHello\x1b[2;1HWorld";
  expect(stripAnsi(positioned)).toBe("HelloWorld");
});