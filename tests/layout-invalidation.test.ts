import { expect, test, describe } from 'bun:test';
import { createTTY, MockTTYRuntime } from '../src/index.js';

describe('Layout Invalidation System', () => {
  test('sibling addition invalidates parent layout', () => {
    const mockRuntime = new MockTTYRuntime();
    const { document, dispose } = createTTY({ runtime: mockRuntime });
    
    // Create flex container
    const container = document.createElement('div');
    container.style.setProperty('display', 'flex');
    container.style.setProperty('flex-direction', 'row');
    container.style.setProperty('width', '60ch');
    document.body.appendChild(container);
    
    // Add first child
    const child1 = document.createElement('div');
    child1.style.setProperty('width', '20ch');
    child1.style.setProperty('height', '5ch');
    child1.textContent = 'Child 1';
    container.appendChild(child1);
    
    // Get initial positions
    const initialChild1 = child1.getBoundingClientRect();
    expect(initialChild1.x).toBe(0);
    expect(initialChild1.width).toBe(20);
    
    // Add second child - should trigger invalidation
    const child2 = document.createElement('div');
    child2.style.setProperty('width', '20ch');
    child2.style.setProperty('height', '5ch');
    child2.textContent = 'Child 2';
    container.appendChild(child2);
    
    // Check layout updated correctly
    const updatedChild1 = child1.getBoundingClientRect();
    const child2Bounds = child2.getBoundingClientRect();
    
    expect(updatedChild1.x).toBe(0); // Child 1 still at start
    expect(child2Bounds.x).toBe(20); // Child 2 positioned after child 1
    expect(child2Bounds.width).toBe(20);
    
    dispose();
  });

  test('sibling removal invalidates parent layout', () => {
    const mockRuntime = new MockTTYRuntime();
    const { document, dispose } = createTTY({ runtime: mockRuntime });
    
    // Create flex container with three children
    const container = document.createElement('div');
    container.style.setProperty('display', 'flex');
    container.style.setProperty('flex-direction', 'row');
    container.style.setProperty('width', '60ch');
    document.body.appendChild(container);
    
    const child1 = document.createElement('div');
    child1.style.setProperty('width', '15ch');
    child1.textContent = 'Child 1';
    container.appendChild(child1);
    
    const child2 = document.createElement('div');
    child2.style.setProperty('width', '15ch');
    child2.textContent = 'Child 2';
    container.appendChild(child2);
    
    const child3 = document.createElement('div');
    child3.style.setProperty('width', '15ch');
    child3.textContent = 'Child 3';
    container.appendChild(child3);
    
    // Get initial positions
    const initialChild3 = child3.getBoundingClientRect();
    expect(initialChild3.x).toBe(30); // After both siblings
    
    // Remove middle child - should trigger invalidation
    container.removeChild(child2);
    
    // Check child3 moved to child2's position
    const updatedChild3 = child3.getBoundingClientRect();
    expect(updatedChild3.x).toBe(15); // Should move from 30 to 15
    
    dispose();
  });

  test('display property change invalidates layout', () => {
    const mockRuntime = new MockTTYRuntime();
    const { document, dispose } = createTTY({ runtime: mockRuntime });
    
    // Create flex container with three children
    const container = document.createElement('div');
    container.style.setProperty('display', 'flex');
    container.style.setProperty('flex-direction', 'row');
    document.body.appendChild(container);
    
    const child1 = document.createElement('div');
    child1.style.setProperty('width', '20ch');
    child1.style.setProperty('height', '5ch');
    child1.textContent = 'Child 1';
    container.appendChild(child1);
    
    const child2 = document.createElement('div');
    child2.style.setProperty('width', '20ch');
    child2.style.setProperty('height', '5ch');
    child2.textContent = 'Child 2';
    container.appendChild(child2);
    
    const child3 = document.createElement('div');
    child3.style.setProperty('width', '20ch');
    child3.style.setProperty('height', '5ch');
    child3.textContent = 'Child 3';
    container.appendChild(child3);
    
    // Initial state - row layout
    const initialChild3 = child3.getBoundingClientRect();
    expect(initialChild3.x).toBe(40); // After two 20ch siblings
    
    // Change to display: none on middle child
    child2.style.setProperty('display', 'none');
    
    // Child3 should move to child2's position
    const updatedChild3 = child3.getBoundingClientRect();
    expect(updatedChild3.x).toBe(20); // Should move from 40 to 20
    
    // Change back to display: flex
    child2.style.setProperty('display', 'block');
    
    // Child3 should move back
    const finalChild3 = child3.getBoundingClientRect();
    expect(finalChild3.x).toBe(40); // Back to original position
    
    dispose();
  });

  test('flex-direction change invalidates layout', () => {
    const mockRuntime = new MockTTYRuntime();
    const { document, dispose } = createTTY({ runtime: mockRuntime });
    
    // Create flex container
    const container = document.createElement('div');
    container.style.setProperty('display', 'flex');
    container.style.setProperty('flex-direction', 'row');
    container.style.setProperty('width', '60ch');
    container.style.setProperty('height', '20ch');
    document.body.appendChild(container);
    
    const child1 = document.createElement('div');
    child1.style.setProperty('width', '20ch');
    child1.style.setProperty('height', '8ch');
    child1.textContent = 'Child 1';
    container.appendChild(child1);
    
    const child2 = document.createElement('div');
    child2.style.setProperty('width', '20ch');
    child2.style.setProperty('height', '8ch');
    child2.textContent = 'Child 2';
    container.appendChild(child2);
    
    // Initial state - row layout (horizontal)
    const initialChild1 = child1.getBoundingClientRect();
    const initialChild2 = child2.getBoundingClientRect();
    
    expect(initialChild1.x).toBe(0);
    expect(initialChild1.y).toBe(0);
    expect(initialChild2.x).toBe(20); // Side by side
    expect(initialChild2.y).toBe(0);
    
    // Change to column layout
    container.style.setProperty('flex-direction', 'column');
    
    // Now should be stacked vertically
    const columnChild1 = child1.getBoundingClientRect();
    const columnChild2 = child2.getBoundingClientRect();
    
    expect(columnChild1.x).toBe(0);
    expect(columnChild1.y).toBe(0);
    expect(columnChild2.x).toBe(0); // Same x position
    expect(columnChild2.y).toBe(8); // Stacked below child1
    
    dispose();
  });

  test('nested container style changes invalidate correctly', () => {
    const mockRuntime = new MockTTYRuntime();
    const { document, dispose } = createTTY({ runtime: mockRuntime });
    
    // Create nested structure
    const outerContainer = document.createElement('div');
    outerContainer.style.setProperty('display', 'flex');
    outerContainer.style.setProperty('flex-direction', 'column');
    outerContainer.style.setProperty('width', '80ch');
    document.body.appendChild(outerContainer);
    
    const innerContainer = document.createElement('div');
    innerContainer.style.setProperty('display', 'flex');
    innerContainer.style.setProperty('flex-direction', 'row');
    innerContainer.style.setProperty('margin-top', '5ch');
    outerContainer.appendChild(innerContainer);
    
    const child = document.createElement('div');
    child.style.setProperty('width', '30ch');
    child.style.setProperty('height', '10ch');
    child.textContent = 'Nested Child';
    innerContainer.appendChild(child);
    
    // Get initial position
    const initialChild = child.getBoundingClientRect();
    expect(initialChild.y).toBe(5); // Should include parent's margin-top
    
    // Change inner container's margin - should only invalidate inner container
    innerContainer.style.setProperty('margin-top', '15ch');
    
    // Child should move down
    const updatedChild = child.getBoundingClientRect();
    expect(updatedChild.y).toBe(15); // New margin-top value
    expect(updatedChild.x).toBe(0); // x position unchanged
    
    dispose();
  });

  test('multiple simultaneous style changes batch correctly', () => {
    const mockRuntime = new MockTTYRuntime();
    const { document, dispose } = createTTY({ runtime: mockRuntime });
    
    const container = document.createElement('div');
    container.style.setProperty('display', 'flex');
    container.style.setProperty('flex-direction', 'row');
    document.body.appendChild(container);
    
    const element = document.createElement('div');
    element.style.setProperty('width', '20ch');
    element.style.setProperty('height', '10ch');
    element.style.setProperty('margin-left', '5ch');
    element.style.setProperty('margin-top', '3ch');
    element.textContent = 'Test Element';
    container.appendChild(element);
    
    // Get initial position
    const initial = element.getBoundingClientRect();
    expect(initial.x).toBe(5);
    expect(initial.y).toBe(3);
    expect(initial.width).toBe(20);
    expect(initial.height).toBe(10);
    
    // Make multiple changes at once
    element.style.setProperty('width', '30ch');
    element.style.setProperty('height', '15ch');
    element.style.setProperty('margin-left', '10ch');
    element.style.setProperty('margin-top', '8ch');
    
    // All changes should be reflected
    const updated = element.getBoundingClientRect();
    expect(updated.x).toBe(10);
    expect(updated.y).toBe(8);
    expect(updated.width).toBe(30);
    expect(updated.height).toBe(15);
    
    dispose();
  });

  test('text content changes invalidate measure functions', () => {
    const mockRuntime = new MockTTYRuntime();
    const { document, dispose } = createTTY({ runtime: mockRuntime });
    
    const container = document.createElement('div');
    container.style.setProperty('display', 'flex');
    container.style.setProperty('flex-direction', 'row'); // Allow children to size naturally
    document.body.appendChild(container);
    
    // Use inline element which sizes based on text content
    const textElement = document.createElement('span');
    textElement.style.setProperty('display', 'inline');
    textElement.textContent = 'Short';
    container.appendChild(textElement);
    
    // Get initial size (should be based on text content)
    const initial = textElement.getBoundingClientRect();
    const initialWidth = initial.width;
    
    // Change text content to something longer
    textElement.textContent = 'This is much longer text content that should change the width';
    
    // Size should update based on new text
    const updated = textElement.getBoundingClientRect();
    expect(updated.width).toBeGreaterThan(initialWidth);
    
    dispose();
  });

  test('justify-content changes affect child positions', () => {
    const mockRuntime = new MockTTYRuntime();
    const { document, dispose } = createTTY({ runtime: mockRuntime });
    
    const container = document.createElement('div');
    container.style.setProperty('display', 'flex');
    container.style.setProperty('flex-direction', 'row');
    container.style.setProperty('width', '60ch');
    container.style.setProperty('justify-content', 'flex-start');
    document.body.appendChild(container);
    
    const child = document.createElement('div');
    child.style.setProperty('width', '20ch');
    child.style.setProperty('height', '5ch');
    child.textContent = 'Child';
    container.appendChild(child);
    
    // Initial - flex-start (left aligned)
    const flexStart = child.getBoundingClientRect();
    expect(flexStart.x).toBe(0);
    
    // Change to center
    container.style.setProperty('justify-content', 'center');
    const centered = child.getBoundingClientRect();
    expect(centered.x).toBe(20); // (60 - 20) / 2 = 20
    
    // Change to flex-end (right aligned)
    container.style.setProperty('justify-content', 'flex-end');
    const flexEnd = child.getBoundingClientRect();
    expect(flexEnd.x).toBe(40); // 60 - 20 = 40
    
    dispose();
  });
});