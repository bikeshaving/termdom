/**
 * Test mocking process.stdout/stdin directly
 */

import { test, expect } from "bun:test";
import { Writable, Readable } from "stream";

// Mock stdout that captures output
class MockStdout extends Writable {
  public output: string = '';
  public width: number = 80;
  public height: number = 24;
  public isTTY: boolean = true;

  override _write(chunk: any, encoding: any, callback: any) {
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

  // Add methods to simulate terminal resize
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.emit('resize');
  }
}

// Mock stdin that can simulate input
class MockStdin extends Readable {
  private inputQueue: Buffer[] = [];
  public isTTY: boolean = true;

  override _read() {
    // Process input queue
    if (this.inputQueue.length > 0) {
      const data = this.inputQueue.shift()!;
      this.push(data);
    }
  }

  // Simulate keyboard input
  simulateInput(data: string): void {
    this.inputQueue.push(Buffer.from(data));
    this.read(); // Trigger read
  }

  // Simulate mouse input
  simulateMouse(button: number, x: number, y: number, press: boolean): void {
    // SGR mouse format: \x1b[<btn;col;row;M/m
    const action = press ? 'M' : 'm';
    const sequence = `\x1b[<${button};${x + 1};${y + 1}${action}`;
    this.simulateInput(sequence);
  }

  // Simulate special keys
  simulateKey(key: string): void {
    const keyMap: Record<string, string> = {
      'up': '\x1b[A',
      'down': '\x1b[B', 
      'right': '\x1b[C',
      'left': '\x1b[D',
      'enter': '\r',
      'escape': '\x1b',
      'backspace': '\x7f',
      'tab': '\t',
      'ctrl-c': '\x03'
    };
    
    const sequence = keyMap[key] || key;
    this.simulateInput(sequence);
  }

  // Mock raw mode
  setRawMode(enabled: boolean): this {
    // Just track the state for testing
    return this;
  }
}

test("Mock stdout captures output", () => {
  const mockOut = new MockStdout();
  
  mockOut.write("Hello World");
  mockOut.write("\x1b[31mRed Text\x1b[0m");
  
  expect(mockOut.getOutput()).toBe("Hello World\x1b[31mRed Text\x1b[0m");
  expect(mockOut.width).toBe(80);
  expect(mockOut.height).toBe(24);
  expect(mockOut.isTTY).toBe(true);
});

test("Mock stdin simulates input", () => {
  const mockIn = new MockStdin();
  const received: string[] = [];
  
  mockIn.on('data', (data) => {
    received.push(data.toString());
  });
  
  mockIn.simulateInput('hello');
  mockIn.simulateKey('enter');
  mockIn.simulateKey('ctrl-c');
  
  expect(received).toEqual(['hello', '\r', '\x03']);
});

test("Mock mouse input", () => {
  const mockIn = new MockStdin();
  const received: string[] = [];
  
  mockIn.on('data', (data) => {
    received.push(data.toString());
  });
  
  // Simulate mouse click at position (10, 5)
  mockIn.simulateMouse(0, 10, 5, true);  // Press
  mockIn.simulateMouse(0, 10, 5, false); // Release
  
  expect(received).toEqual([
    '\x1b[<0;11;6M',  // Press (1-based coordinates)
    '\x1b[<0;11;6m'   // Release
  ]);
});

test("Using mocks with actual components", () => {
  const mockOut = new MockStdout();
  const mockIn = new MockStdin();
  
  // This is how we'd use it with ScreenBuffer
  // const screenBuffer = new ScreenBuffer({
  //   output: mockOut,
  //   width: mockOut.width,
  //   height: mockOut.height
  // });
  
  // Test that our mock behaves like real streams
  expect(typeof mockOut.write).toBe('function');
  expect(typeof mockIn.setRawMode).toBe('function');
  expect(mockOut.isTTY).toBe(true);
  expect(mockIn.isTTY).toBe(true);
});

// Helper to replace process streams temporarily
export function withMockTerminal<T>(
  fn: (mockOut: MockStdout, mockIn: MockStdin) => T
): T {
  const mockOut = new MockStdout();
  const mockIn = new MockStdin();
  
  const originalOut = process.stdout;
  const originalIn = process.stdin;
  
  // Replace process streams
  (process as any).stdout = mockOut;
  (process as any).stdin = mockIn;
  
  try {
    return fn(mockOut, mockIn);
  } finally {
    // Restore original streams
    (process as any).stdout = originalOut;
    (process as any).stdin = originalIn;
  }
}

test("Mock terminal replacement", () => {
  const result = withMockTerminal((mockOut, mockIn) => {
    // Code that uses process.stdout/stdin
    process.stdout.write("Test output");
    
    expect(mockOut.getOutput()).toBe("Test output");
    expect(process.stdout.width).toBe(80);
    
    return "success";
  });
  
  expect(result).toBe("success");
  // Original streams should be restored
  expect(process.stdout.write).toBeDefined();
});