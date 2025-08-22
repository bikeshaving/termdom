/**
 * Tests for fullscreen API functionality
 */

import { test, expect } from "bun:test";
import { createTOM } from '../src/index.js';
import { TerminalInterface, TerminalDimensions } from '../src/core/TerminalInterface.js';

// Mock terminal for testing
class MockTerminal implements TerminalInterface {
  public writes: string[] = [];

  getDimensions(): TerminalDimensions {
    return { columns: 80, rows: 24 };
  }

  write(data: string | Buffer): boolean {
    this.writes.push(data.toString());
    return true;
  }

  on?(event: string, listener: (...args: any[]) => void): void {
    // Mock implementation
  }
}

test("TOMWindow fullscreen API", async () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  // Initially should be in flow mode
  expect(tom.mode).toBe('flow');
  expect(tom.fullscreenElement).toBe(null);

  // Create an element to fullscreen
  const container = tom.createElement('container');
  container.style.width = '20';
  container.style.height = '10';
  tom.body.appendChild(container);

  // Request fullscreen
  await tom.requestFullscreen(container);
  
  expect(tom.mode).toBe('fullscreen');
  expect(tom.fullscreenElement).toBe(container);

  // Exit fullscreen
  await tom.exitFullscreen();
  
  expect(tom.mode).toBe('flow');
  expect(tom.fullscreenElement).toBe(null);

  tom.destroy();
});

test("TOMElement requestFullscreen method", async () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  const container = tom.createElement('container');
  tom.body.appendChild(container);

  // Element should be able to request fullscreen
  await container.requestFullscreen();
  
  expect(tom.mode).toBe('fullscreen');
  expect(tom.fullscreenElement).toBe(container);

  tom.destroy();
});

test("TOMDocument fullscreen APIs", async () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  const container = tom.createElement('container');
  tom.body.appendChild(container);

  // Document should expose fullscreen properties
  expect(tom.document.fullscreenEnabled).toBe(true);
  expect(tom.document.fullscreenElement).toBe(null);

  await tom.requestFullscreen(container);
  
  expect(tom.document.fullscreenElement).toBe(container);

  // Document should be able to exit fullscreen
  await tom.document.exitFullscreen();
  
  expect(tom.document.fullscreenElement).toBe(null);

  tom.destroy();
});

test("Fullscreen events are dispatched", async () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  const container = tom.createElement('container');
  tom.body.appendChild(container);

  let fullscreenChangeCount = 0;
  tom.addEventListener('fullscreenchange', () => {
    fullscreenChangeCount++;
  });

  // Enter fullscreen
  await tom.requestFullscreen(container);
  expect(fullscreenChangeCount).toBe(1);

  // Exit fullscreen
  await tom.exitFullscreen();
  expect(fullscreenChangeCount).toBe(2);

  tom.destroy();
});

test("Cannot request fullscreen when already in fullscreen", async () => {
  const terminal = new MockTerminal();
  const tom = createTOM({ terminal });

  const container1 = tom.createElement('container');
  const container2 = tom.createElement('container');
  tom.body.appendChild(container1);
  tom.body.appendChild(container2);

  await tom.requestFullscreen(container1);

  // Should throw when trying to enter fullscreen again
  await expect(tom.requestFullscreen(container2)).rejects.toThrow('Already in fullscreen mode');

  tom.destroy();
});