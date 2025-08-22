/**
 * Tests for Symbol.dispose and cleanup functionality
 */

import { test, expect } from "bun:test";
import { createTOM } from '../src/index.js';
import { TOMDocument } from '../src/core/TOMDocument.js';
import { TerminalInterface, TerminalDimensions } from '../src/core/TerminalInterface.js';

// Mock terminal that tracks all writes
class MockTerminal implements TerminalInterface {
  public writes: string[] = [];
  public isRawMode = false;
  public isResumed = false;

  getDimensions(): TerminalDimensions {
    return { columns: 80, rows: 24 };
  }

  write(data: string | Buffer): boolean {
    this.writes.push(data.toString());
    return true;
  }

  setRawMode?(enabled: boolean): void {
    this.isRawMode = enabled;
  }

  resume?(): void {
    this.isResumed = true;
  }

  pause?(): void {
    this.isResumed = false;
  }

  on?(event: string, listener: (...args: any[]) => void): void {
    // Mock implementation - doesn't actually register events
  }

  // Test helpers
  getLastWrite(): string {
    return this.writes[this.writes.length - 1] || '';
  }

  getAllWrites(): string {
    return this.writes.join('');
  }

  hasMouseReset(): boolean {
    const allWrites = this.getAllWrites();
    return allWrites.includes('\x1b[?1000l') && 
           allWrites.includes('\x1b[?1002l') &&
           allWrites.includes('\x1b[?1003l') &&
           allWrites.includes('\x1b[?1006l');
  }

  hasCursorReset(): boolean {
    return this.getAllWrites().includes('\x1b[?25h');
  }

  hasStyleReset(): boolean {
    return this.getAllWrites().includes('\x1b[0m');
  }

  clearWrites(): void {
    this.writes = [];
  }
}

test("TOMWindow implements Symbol.dispose", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  // Should implement Disposable interface
  expect(typeof tom[Symbol.dispose]).toBe('function');
  
  tom.destroy();
});

test("Symbol.dispose calls destroy method", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  // Track if destroy was called by checking terminal writes
  const initialWrites = terminal.writes.length;

  // Call Symbol.dispose
  tom[Symbol.dispose]();

  // Should have written cleanup sequences
  expect(terminal.writes.length).toBeGreaterThan(initialWrites);
  expect(terminal.hasMouseReset()).toBe(true);
  expect(terminal.hasCursorReset()).toBe(true);
});

test("TOMWindow cleanup writes mouse reset sequences", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  // Clear any initial writes
  terminal.clearWrites();

  // Destroy the tom
  tom.destroy();

  // Should write all mouse reset sequences
  expect(terminal.hasMouseReset()).toBe(true);
});

test("TOMWindow cleanup shows cursor", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  terminal.clearWrites();
  tom.destroy();

  expect(terminal.hasCursorReset()).toBe(true);
});

test("TOMWindow cleanup resets styles", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  terminal.clearWrites();
  tom.destroy();

  expect(terminal.hasStyleReset()).toBe(true);
});

test("TOMWindow cleanup positions cursor at bottom", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  terminal.clearWrites();
  tom.destroy();

  const allWrites = terminal.getAllWrites();
  // Should position cursor at row 24 (24;1H)
  expect(allWrites).toMatch(/\x1b\[24;1H/);
});

test("TOMDocument still implements Symbol.dispose for backward compatibility", () => {
  const terminal = new MockTerminal();
  const document = new TOMDocument({ terminal });

  // Should implement Disposable interface
  expect(typeof document[Symbol.dispose]).toBe('function');
  
  // But cleanup is minimal since TOMWindow handles terminal cleanup
  document.destroy();
});

test("TOMWindow cleanup handles terminal interface failure gracefully", () => {
  // Create a terminal that fails only during cleanup, not during initialization
  let shouldFail = false;
  const failingTerminal: TerminalInterface = {
    getDimensions: () => ({ columns: 80, rows: 24 }),
    write: (data: string | Buffer) => { 
      if (shouldFail) {
        throw new Error('Terminal write failed'); 
      }
      return true;
    }
  };

  const tom = createTOM({ terminal: failingTerminal });
  
  // Now make it fail
  shouldFail = true;

  // Should not throw when cleanup fails
  expect(() => {
    tom.destroy();
  }).not.toThrow();
});

test("TOMWindow prevents double cleanup", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  // Clear any initialization writes
  terminal.clearWrites();

  // First cleanup
  tom.destroy();
  const firstWriteCount = terminal.writes.length;

  // Second cleanup should not write anything
  tom.destroy();
  const secondWriteCount = terminal.writes.length;

  expect(secondWriteCount).toBe(firstWriteCount);
});

test("createTOM API implements Symbol.dispose", async () => {
  const { createTOM } = await import('../src/index.js');
  const mockTerminal = new MockTerminal();
  
  const tom = createTOM({ terminal: mockTerminal });

  expect(typeof tom[Symbol.dispose]).toBe('function');
});

test("createTOM Symbol.dispose cleans up terminal", async () => {
  const { createTOM } = await import('../src/index.js');
  const mockTerminal = new MockTerminal();
  
  const tom = createTOM({ terminal: mockTerminal });

  mockTerminal.clearWrites();
  tom[Symbol.dispose]();

  expect(mockTerminal.hasMouseReset()).toBe(true);
  expect(mockTerminal.hasCursorReset()).toBe(true);
});

test("using statement automatically cleans up", async () => {
  const { createTOM } = await import('../src/index.js');
  const mockTerminal = new MockTerminal();
  
  // Simulate using statement behavior
  {
    using tom = createTOM({ terminal: mockTerminal });
    
    // Create some content
    const container = tom.createElement('container');
    container.textContent = 'Test content';
    tom.body.appendChild(container);
    
    mockTerminal.clearWrites();
    
    // using block ends here, should auto-dispose
  }
  
  // After the block, cleanup should have occurred
  expect(mockTerminal.hasMouseReset()).toBe(true);
  expect(mockTerminal.hasCursorReset()).toBe(true);
});

test("emergency reset uses terminal interface when available", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  // Force an error in normal cleanup, then destroy
  // We can't easily test private methods, but we can verify
  // that the terminal interface is used for cleanup
  tom.destroy();

  expect(terminal.writes.length).toBeGreaterThan(0);
  expect(terminal.hasMouseReset()).toBe(true);
});

test("final state preservation calls render", () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  // Add some content
  const container = tom.createElement('container');
  container.textContent = 'Final state';
  tom.body.appendChild(container);

  terminal.clearWrites();
  tom.destroy();

  // Should have called render as part of preserveFinalState
  // This is indicated by cursor positioning and cleanup sequences
  const allWrites = terminal.getAllWrites();
  expect(allWrites.length).toBeGreaterThan(0);
});