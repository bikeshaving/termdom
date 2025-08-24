/**
 * Visual Layout Snapshot Tests
 * 
 * Tests that capture the actual rendered output of layout scenarios
 * to ensure visual consistency across changes.
 */

import { test, expect } from "bun:test";
import { createTTY, MockTTYRuntime } from '../src/index.js';
import { TerminalSnapshotter } from '../src/testing/TerminalSnapshotter.js';
import { saveSnapshot } from '../src/testing/snapshotUtils.js';

async function createLayoutSnapshot(testName: string, setupFn: (document: any) => void): Promise<string> {
  const mockRuntime = new MockTTYRuntime({ 
    dimensions: { width: 40, height: 20 } 
  });
  
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  try {
    // Set up the test layout
    setupFn(document);
    
    // Wait for MutationObserver to process DOM changes
    await new Promise(resolve => setTimeout(resolve));
    
    // Close the stream and create snapshot
    mockRuntime.closeStdout();
    
    using snapshotter = new TerminalSnapshotter(
      mockRuntime.getStdoutStream(), 
      { width: 40, height: 20 }
    );
    
    return await snapshotter.getSnapshot();
  } finally {
    dispose();
  }
}

test('simple text layout', async () => {
  const snapshot = await createLayoutSnapshot('simple-text', (document) => {
    const div = document.createElement('div');
    div.textContent = 'Hello World';
    document.body.appendChild(div);
  });
  
  // Bun snapshot for test assertion
  expect(snapshot).toMatchSnapshot();
  
  // Save .ansi file for visual inspection
  saveSnapshot('simple-text-layout', snapshot);
});

test('flex column layout', async () => {
  const snapshot = await createLayoutSnapshot('flex-column', (document) => {
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '1ch';
    
    const item1 = document.createElement('div');
    item1.textContent = 'Item 1';
    item1.style.backgroundColor = 'blue';
    item1.style.color = 'white';
    
    const item2 = document.createElement('div');
    item2.textContent = 'Item 2'; 
    item2.style.backgroundColor = 'red';
    item2.style.color = 'white';
    
    container.appendChild(item1);
    container.appendChild(item2);
    document.body.appendChild(container);
  });
  
  expect(snapshot).toMatchSnapshot();
  saveSnapshot('flex-column-layout', snapshot);
});

test('text wrapping layout', async () => {
  const snapshot = await createLayoutSnapshot('text-wrapping', (document) => {
    const div = document.createElement('div');
    div.style.width = '20ch';
    div.textContent = 'This is a long line of text that should wrap across multiple lines when the container is too narrow';
    document.body.appendChild(div);
  });
  
  expect(snapshot).toMatchSnapshot();
  saveSnapshot('text-wrapping-layout', snapshot);
});

test('nested containers layout', async () => {
  const snapshot = await createLayoutSnapshot('nested-containers', (document) => {
    const outer = document.createElement('div');
    outer.style.border = '1px solid white';
    outer.style.padding = '2ch';
    
    const inner = document.createElement('div');
    inner.style.backgroundColor = 'green';
    inner.style.color = 'black';
    inner.style.padding = '1ch';
    inner.textContent = 'Nested content';
    
    outer.appendChild(inner);
    document.body.appendChild(outer);
  });
  
  expect(snapshot).toMatchSnapshot();
  saveSnapshot('nested-containers-layout', snapshot);
});