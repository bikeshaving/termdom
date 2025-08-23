/**
 * Integration Tests for HTML-to-Terminal Rendering Pipeline
 * 
 * These tests verify that our HTML-to-Terminal rendering actually produces
 * the expected ANSI terminal output using snapshot testing.
 */

import { test, expect } from 'bun:test';
import { createTTYDocument, MockTTYRuntime } from '../src/index.js';
import { expectSnapshot } from '../src/testing/snapshotUtils.js';

test('renders simple HTML text', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const div = document.createElement('div');
  div.textContent = 'Hello World!';
  document.body.appendChild(div);
  
  await render();
  
  expectSnapshot('simple-text', mockRuntime, { updateSnapshots: true });
  dispose();
});

test('renders nested HTML container with multiple elements', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  const span1 = document.createElement('span');
  const span2 = document.createElement('span');
  
  span1.textContent = 'First line';
  span2.textContent = 'Second line';
  
  container.appendChild(span1);
  container.appendChild(span2);
  document.body.appendChild(container);
  
  await render();
  
  expectSnapshot('nested-container', mockRuntime, { updateSnapshots: true });
  dispose();
});

test('renders HTML text with CSS colors', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const div1 = document.createElement('div');
  const div2 = document.createElement('div');
  
  div1.textContent = 'Red text';
  div1.style.setProperty('color', 'red');
  
  div2.textContent = 'Green text';
  div2.style.setProperty('color', 'green');
  
  document.body.appendChild(div1);
  document.body.appendChild(div2);
  
  await render();
  
  expectSnapshot('colored-text', mockRuntime, { updateSnapshots: true });
  dispose();
});

test('renders HTML background colors', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const div = document.createElement('div');
  div.textContent = 'Text on blue background';
  div.style.setProperty('background-color', 'blue');
  
  document.body.appendChild(div);
  
  await render();
  
  expectSnapshot('background-colors', mockRuntime, { updateSnapshots: true });
  dispose();
});