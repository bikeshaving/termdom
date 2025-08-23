/**
 * Integration Tests for TTY Rendering Pipeline
 * 
 * These tests verify that our DOM-aware rendering actually produces
 * the expected terminal output using snapshot testing.
 */

import { test, expect } from 'bun:test';
import { createTTY, MockTTYRuntime } from '../src/index.js';
import { expectSnapshot } from '../src/testing/snapshotUtils.js';

test('renders simple text element', async () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const text = tty.createElement('text');
  text.textContent = 'Hello World!';
  tty.appendChild(text);
  
  await tty.render();
  
  expectSnapshot('simple-text', mockRuntime, { updateSnapshots: true });
  tty.dispose();
});

test('renders nested container with multiple text elements', async () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const container = tty.createElement('container');
  const text1 = tty.createElement('text');
  const text2 = tty.createElement('text');
  
  text1.textContent = 'First line';
  text2.textContent = 'Second line';
  
  container.appendChild(text1);
  container.appendChild(text2);
  tty.appendChild(container);
  
  await tty.render();
  
  expectSnapshot('nested-container', mockRuntime, { updateSnapshots: true });
  tty.dispose();
});

test('renders text with colors', async () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const text1 = tty.createElement('text');
  const text2 = tty.createElement('text');
  
  text1.textContent = 'Red text';
  text1.style.setProperty('color', 'red');
  
  text2.textContent = 'Green text';
  text2.style.setProperty('color', 'green');
  
  tty.appendChild(text1);
  tty.appendChild(text2);
  
  await tty.render();
  
  expectSnapshot('colored-text', mockRuntime, { updateSnapshots: true });
  tty.dispose();
});

test('renders background colors', async () => {
  const mockRuntime = new MockTTYRuntime();
  const tty = createTTY({ runtime: mockRuntime });
  
  const text = tty.createElement('text');
  text.textContent = 'Text on blue background';
  text.style.setProperty('background-color', 'blue');
  
  tty.appendChild(text);
  
  await tty.render();
  
  expectSnapshot('background-colors', mockRuntime, { updateSnapshots: true });
  tty.dispose();
});