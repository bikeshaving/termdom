/**
 * Integration Tests for HTML-to-Terminal Rendering Pipeline
 * 
 * These tests verify that our HTML-to-Terminal rendering actually produces
 * the expected ANSI terminal output using snapshot testing.
 */

import { test, expect } from 'bun:test';
import { createTTY, MockTTYRuntime } from '../src/index.js';
import { TerminalSnapshotter } from '../src/testing/TerminalSnapshotter.js';
import { saveSnapshot } from '../src/testing/snapshotUtils.js';

async function createSnapshot(setupFn: (document: any) => void): Promise<string> {
  const mockRuntime = new MockTTYRuntime({ 
    dimensions: { columns: 80, rows: 24 } 
  });
  
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  try {
    setupFn(document);
    
    // Wait for MutationObserver to process DOM changes
    await new Promise(resolve => setTimeout(resolve));
    
    // Close stream for snapshot
    mockRuntime.closeStdout();
    
    using snapshotter = new TerminalSnapshotter(
      mockRuntime.getStdoutStream(), 
      { width: 80, height: 24 }
    );
    
    return await snapshotter.getSnapshot();
  } finally {
    dispose();
  }
}

test('renders simple HTML text', async () => {
  const snapshot = await createSnapshot((document) => {
    const div = document.createElement('div');
    div.textContent = 'Hello World!';
    document.body.appendChild(div);
  });
  
  expect(snapshot).toMatchSnapshot();
  saveSnapshot('simple-html-text', snapshot);
});

test('renders nested HTML container with multiple elements', async () => {
  const snapshot = await createSnapshot((document) => {
    const container = document.createElement('div');
    const span1 = document.createElement('span');
    const span2 = document.createElement('span');
    
    span1.textContent = 'First line';
    span2.textContent = 'Second line';
    
    container.appendChild(span1);
    container.appendChild(span2);
    document.body.appendChild(container);
  });
  
  expect(snapshot).toMatchSnapshot();
  saveSnapshot('nested-html-container', snapshot);
});

test('renders HTML text with CSS colors', async () => {
  const snapshot = await createSnapshot((document) => {
    const div1 = document.createElement('div');
    const div2 = document.createElement('div');
    
    div1.textContent = 'Red text';
    div1.style.setProperty('color', 'red');
    
    div2.textContent = 'Green text';
    div2.style.setProperty('color', 'green');
    
    document.body.appendChild(div1);
    document.body.appendChild(div2);
  });
  
  expect(snapshot).toMatchSnapshot();
  saveSnapshot('html-text-with-colors', snapshot);
});

test('renders HTML background colors', async () => {
  const snapshot = await createSnapshot((document) => {
    const div = document.createElement('div');
    div.textContent = 'Text on blue background';
    div.style.setProperty('background-color', 'blue');
    
    document.body.appendChild(div);
  });
  
  expect(snapshot).toMatchSnapshot();
  saveSnapshot('html-background-colors', snapshot);
});