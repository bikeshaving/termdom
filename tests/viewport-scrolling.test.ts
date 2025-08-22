/**
 * Tests for viewport scrolling functionality
 */

import { test, expect } from "bun:test";
import { TOMDocument } from '../src/core/TOMDocument.js';
import { TerminalInterface, TerminalDimensions } from '../src/core/TerminalInterface.js';

// Mock terminal for testing
class MockTerminal implements TerminalInterface {
  public writes: string[] = [];

  getDimensions(): TerminalDimensions {
    return { columns: 20, rows: 10 };
  }

  write(data: string | Buffer): boolean {
    this.writes.push(data.toString());
    return true;
  }

  on?(event: string, listener: (...args: any[]) => void): void {
    // Mock implementation
  }
}

test("TOMDocument with viewport can scroll", () => {
  const terminal = new MockTerminal();
  const document = new TOMDocument({ 
    terminal,
    viewport: { 
      height: 5, // Smaller than terminal height to enable scrolling
      overflow: 'scroll' 
    }
  });

  expect(document.viewport).toBeTruthy();
  
  // Set document size manually to enable scrolling (simulate content that extends beyond viewport)
  document.viewport.setDocumentSize(20, 20); // 20x20 document, 5 height viewport
  
  // Initial scroll position should be 0
  const docBefore = document.viewport.getDocument();
  expect(docBefore.scrollTop).toBe(0);
  
  // Test viewport scrolling directly without triggering render
  const directScrolled = document.viewport.scroll(0, 3);
  expect(directScrolled).toBe(true);
  
  const afterDirectScroll = document.viewport.getDocument();
  expect(afterDirectScroll.scrollTop).toBe(3);
});

test("TOMDocument without viewport returns false for scroll attempts", () => {
  const terminal = new MockTerminal();
  const document = new TOMDocument({ terminal }); // No viewport

  expect(document.viewport).toBe(null);
  
  // Scroll attempts should return false
  const scrolled = document.scroll(0, 3);
  expect(scrolled).toBe(false);
});

test("TOMDocument viewport scrollTo works", () => {
  const terminal = new MockTerminal();
  const document = new TOMDocument({ 
    terminal,
    viewport: { 
      height: 5,
      overflow: 'scroll' 
    }
  });

  // Set document size to enable scrolling
  document.viewport.setDocumentSize(20, 20);

  // Test viewport scrollTo directly without triggering render
  const scrolled = document.viewport.scrollTo(0, 10);
  expect(scrolled).toBe(true);
  
  const doc = document.viewport.getDocument();
  expect(doc.scrollTop).toBe(10);
});

test("TOMDocument viewport scrollIntoView works", () => {
  const terminal = new MockTerminal();
  const document = new TOMDocument({ 
    terminal,
    viewport: { 
      height: 5,
      overflow: 'scroll' 
    }
  });

  // Set document size to enable scrolling
  document.viewport.setDocumentSize(20, 20);

  // Test viewport scrollIntoView directly
  const scrolled = document.viewport.scrollIntoView(0, 15, 10, 2);
  expect(scrolled).toBe(true);
  
  const doc = document.viewport.getDocument();
  expect(doc.scrollTop).toBeGreaterThan(0);
});

test("Mouse wheel scrolling with viewport enabled", () => {
  const terminal = new MockTerminal();
  const document = new TOMDocument({ 
    terminal,
    viewport: { 
      height: 5,
      overflow: 'scroll' 
    }
  });

  // Set document size to enable scrolling
  document.viewport.setDocumentSize(20, 20);

  // Test that mouse wheel scrolling calls the viewport scroll method
  // We'll test the handler directly since the full integration would trigger render
  const mouseHandler = document.mouseHandler as any;
  
  let scrollCalled = false;
  const originalScroll = document.viewport.scroll;
  document.viewport.scroll = (deltaX: number, deltaY: number) => {
    scrollCalled = true;
    return originalScroll.call(document.viewport, deltaX, deltaY);
  };

  // Simulate wheel handler call directly
  mouseHandler.handleWheel(10, 5, 1); // x=10, y=5, delta=1 (scroll down)
  
  expect(scrollCalled).toBe(true);
});

test("Mouse wheel with no viewport dispatches to element", () => {
  const terminal = new MockTerminal();
  const document = new TOMDocument({ terminal }); // No viewport

  // Create a container element to receive wheel events
  const container = document.createElement('container');
  container.style.width = '20';
  container.style.height = '10';
  document.body.appendChild(container);
  
  let wheelEventReceived = false;
  container.addEventListener('wheel', () => {
    wheelEventReceived = true;
  });

  // Render to establish element bounds
  document.render();
  
  // Simulate mouse wheel input  
  const wheelData = '\x1b[<64;1;1M'; // Button 64 = wheel at position 1,1
  const handled = document.mouseHandler.handleMouseInput(wheelData);
  
  expect(handled).toBe(true);
  expect(wheelEventReceived).toBe(true);
});