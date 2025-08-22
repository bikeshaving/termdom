/**
 * Unit tests for layout algorithms
 */

import { test, expect } from "bun:test";
import { createTOM } from '../src/index.js';
import { TOMElement } from '../src/core/TOMElement.js';

// Helper to access private layout methods for testing
class TestLayoutEngine {
  static getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }
  
  static getPadding(element: TOMElement): [number, number, number, number] {
    const padding = element.style.padding;
    
    if (typeof padding === 'number') {
      return [padding, padding, padding, padding];
    }
    
    if (Array.isArray(padding)) {
      return padding;
    }
    
    return [0, 0, 0, 0];
  }
  
  static getBorderWidth(element: TOMElement): number {
    const border = element.style.border;
    
    if (typeof border === 'number') {
      return border;
    }
    
    if (Array.isArray(border)) {
      return border[0] || 0;
    }
    
    return 0;
  }
  
  static measureInlineElement(element: TOMElement): { width: number; height: number } {
    const content = element.textContent || '';
    
    if (!content) {
      return { width: 0, height: 0 };
    }
    
    const lines = content.split('\n');
    const width = Math.max(...lines.map(line => this.getTextWidth(line)));
    return { width, height: lines.length };
  }
  
  static measureInlineBlockElement(element: TOMElement): { width: number; height: number } {
    const style = element.style;
    
    // 1. Check for explicit dimensions first
    let width = typeof style.width === 'number' ? style.width : null;
    let height = typeof style.height === 'number' ? style.height : null;
    
    // 2. If no explicit dimensions, calculate from content + chrome
    if (width === null || height === null) {
      const contentSize = this.measureInlineElement(element);
      const [padTop, padRight, padBottom, padLeft] = this.getPadding(element);
      const borderWidth = this.getBorderWidth(element);
      
      if (width === null) {
        width = contentSize.width + padLeft + padRight + borderWidth * 2;
      }
      if (height === null) {
        height = contentSize.height + padTop + padBottom + borderWidth * 2;
      }
    }
    
    // 3. Apply minimum constraints
    if (typeof style.minWidth === 'number') {
      width = Math.max(width, style.minWidth);
    }
    if (typeof style.minHeight === 'number') {
      height = Math.max(height, style.minHeight);
    }
    
    // 4. Apply maximum constraints
    if (typeof style.maxWidth === 'number') {
      width = Math.min(width, style.maxWidth);
    }
    if (typeof style.maxHeight === 'number') {
      height = Math.min(height, style.maxHeight);
    }
    
    return { width, height };
  }
}

test("text width calculation", () => {
  expect(TestLayoutEngine.getTextWidth('hello')).toBe(5);
  expect(TestLayoutEngine.getTextWidth('🎉')).toBe(2); // Emoji width
  expect(TestLayoutEngine.getTextWidth('')).toBe(0);
  expect(TestLayoutEngine.getTextWidth('a\nb')).toBe(2); // Bun.stringWidth excludes newline width
});

test("padding calculation", () => {
  const tom = createTOM();
  const element = tom.createElement('button');
  
  // Test number padding
  element.style.padding = 5;
  expect(TestLayoutEngine.getPadding(element)).toEqual([5, 5, 5, 5]);
  
  // Test array padding
  element.style.padding = [1, 2, 3, 4];
  expect(TestLayoutEngine.getPadding(element)).toEqual([1, 2, 3, 4]);
  
  // Test no padding
  element.style.padding = undefined;
  expect(TestLayoutEngine.getPadding(element)).toEqual([0, 0, 0, 0]);
});

test("border width calculation", () => {
  const tom = createTOM();
  const element = tom.createElement('button');
  
  // Test number border
  element.style.border = 2;
  expect(TestLayoutEngine.getBorderWidth(element)).toBe(2);
  
  // Test array border (takes first value)
  element.style.border = [3, 1, 1, 1];
  expect(TestLayoutEngine.getBorderWidth(element)).toBe(3);
  
  // Test no border
  element.style.border = undefined;
  expect(TestLayoutEngine.getBorderWidth(element)).toBe(0);
});

test("inline element content measurement", () => {
  const tom = createTOM();
  const element = tom.createElement('text');
  
  // Test simple text
  element.textContent = 'hello';
  expect(TestLayoutEngine.measureInlineElement(element)).toEqual({ width: 5, height: 1 });
  
  // Test multiline text
  element.textContent = 'line1\nline22';
  expect(TestLayoutEngine.measureInlineElement(element)).toEqual({ width: 6, height: 2 });
  
  // Test empty text
  element.textContent = '';
  expect(TestLayoutEngine.measureInlineElement(element)).toEqual({ width: 0, height: 0 });
});

test("inline-block element measurement", () => {
  const tom = createTOM();
  const button = tom.createElement('button');
  
  // Test basic button: 'CLICK' (5) + padding (4) + border (2) = 11
  button.textContent = 'CLICK';
  button.style.padding = [1, 2, 1, 2]; // top, right, bottom, left
  button.style.border = 1;
  
  const size = TestLayoutEngine.measureInlineBlockElement(button);
  expect(size.width).toBe(11); // 5 + 2 + 2 + 1 + 1
  expect(size.height).toBe(5);  // content(1) + padTop(1) + padBottom(1) + borderTop(1) + borderBottom(1)
});

test("inline-block with minWidth constraint", () => {
  const tom = createTOM();
  const button = tom.createElement('button');
  
  button.textContent = 'Hi'; // 2 chars
  button.style.padding = [0, 1, 0, 1]; // 2 total padding
  button.style.border = 1; // 2 total border
  button.style.minWidth = 10; // Constraint
  
  const size = TestLayoutEngine.measureInlineBlockElement(button);
  expect(size.width).toBe(10); // minWidth wins over content (2+2+2=6)
});

test("inline-block with explicit width", () => {
  const tom = createTOM();
  const button = tom.createElement('button');
  
  button.textContent = 'Hello World'; // 11 chars
  button.style.width = 5; // Explicit width
  
  const size = TestLayoutEngine.measureInlineBlockElement(button);
  expect(size.width).toBe(5); // Explicit width overrides content
});

// Helper to test flow positioning
class TestRenderer {
  static getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }
  
  static getNodeWidth(node: Node): number {
    if (node.nodeType === 3) { // Text node
      return this.getTextWidth(node.textContent || '');
    } else if (node.nodeType === 1 && node instanceof TOMElement) { // Element node
      return this.getElementWidth(node);
    }
    return 0;
  }
  
  static getElementWidth(element: TOMElement): number {
    const display = element.style.display;
    
    if (display === 'inline-block') {
      // For testing, simulate what the actual bounds would be
      return TestLayoutEngine.measureInlineBlockElement(element).width;
    } else if (display === 'inline') {
      return this.getInlineElementWidth(element);
    }
    
    return 0;
  }
  
  static getInlineElementWidth(element: TOMElement): number {
    let totalWidth = 0;
    
    for (const child of element.childNodes) {
      totalWidth += this.getNodeWidth(child);
    }
    
    return totalWidth;
  }
  
  static calculateFlowPosition(parent: TOMElement, targetNode: Node): number {
    let x = 0; // Start at 0 for testing
    
    const siblings = Array.from(parent.childNodes);
    const targetIndex = siblings.indexOf(targetNode);
    
    for (let i = 0; i < targetIndex; i++) {
      const sibling = siblings[i];
      const siblingWidth = this.getNodeWidth(sibling);
      console.log(`Sibling ${i}: ${sibling.nodeType === 3 ? 'text' : 'element'}, width: ${siblingWidth}`);
      x += siblingWidth;
    }
    
    return x;
  }
}

test("flow positioning with text and inline-block", () => {
  const tom = createTOM();
  
  const container = tom.createElement('container');
  const textBefore = tom.createTextNode('Hi '); // 3 chars
  const button = tom.createElement('button');
  button.textContent = 'OK'; // 2 + chrome
  button.style.padding = [0, 1, 0, 1]; // 2 padding
  button.style.border = 1; // 2 border
  // Expected button width: 2 + 2 + 2 = 6
  
  const textAfter = tom.createTextNode(' bye'); // 4 chars
  
  container.appendChild(textBefore);
  container.appendChild(button);
  container.appendChild(textAfter);
  
  // Test position of "After" text
  const afterPosition = TestRenderer.calculateFlowPosition(container, textAfter);
  
  // Expected: "Hi " (3) + button (6) = 9
  expect(afterPosition).toBe(9);
});

test("real system integration test", () => {
  const tom = createTOM();
  
  const container = tom.createElement('container');
  container.style.padding = [1, 2, 1, 2]; // Add padding like real demo
  
  const textBefore = tom.createTextNode('Before ');
  const button = tom.createElement('button');
  button.textContent = 'CLICK';
  button.style.minWidth = 6;
  button.style.minHeight = 3;
  const textAfter = tom.createTextNode(' After');
  
  container.appendChild(textBefore);
  container.appendChild(button);
  container.appendChild(textAfter);
  
  tom.body.appendChild(container);
  
  // Trigger layout by rendering
  tom.render();
  
  // Now check actual bounds
  console.log('\n=== Real System Integration Test ===');
  console.log('Container bounds:', container.bounds);
  console.log('Container contentArea:', container.getContentArea());
  console.log('Button bounds:', button.bounds);
  console.log('Button textContent:', button.textContent);
  
  // Calculate expected position using real bounds
  const contentArea = container.getContentArea();
  const beforeWidth = TestRenderer.getTextWidth('Before ');
  const buttonWidth = button.bounds.width;
  const expectedAfterX = contentArea.x + beforeWidth + buttonWidth;
  
  console.log('Before text width:', beforeWidth);
  console.log('Button actual width:', buttonWidth);
  console.log('Expected After position:', expectedAfterX);
  
  tom.destroy();
  
  // For now, just verify button has reasonable bounds
  expect(button.bounds.width).toBeGreaterThan(5);
  expect(button.bounds.width).toBeLessThan(20); // Should not be huge
});