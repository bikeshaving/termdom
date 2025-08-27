/**
 * Integration Tests for HTML-to-Terminal Rendering Pipeline
 * 
 * These tests verify that our HTML-to-Terminal rendering actually produces
 * the expected ANSI terminal output using snapshot testing.
 */

import { test, expect } from 'bun:test';
import { TermDOM } from '../src/index.js';
import { TestTerminal } from './test-utils.js';

test('renders simple HTML text', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const div = document.createElement('div');
  div.textContent = 'Hello World!';
  document.body.appendChild(div);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('renders nested HTML container with multiple elements', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const container = document.createElement('div');
  const span1 = document.createElement('span');
  const span2 = document.createElement('span');
  
  span1.textContent = 'First line';
  span2.textContent = 'Second line';
  
  container.appendChild(span1);
  container.appendChild(span2);
  document.body.appendChild(container);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('renders HTML text with CSS colors', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const div1 = document.createElement('div');
  const div2 = document.createElement('div');
  
  div1.textContent = 'Red text';
  div1.style.setProperty('color', 'red');
  
  div2.textContent = 'Green text';
  div2.style.setProperty('color', 'green');
  
  document.body.appendChild(div1);
  document.body.appendChild(div2);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});

test('renders HTML background colors', async () => {
  const terminal = new TestTerminal();
  const dom = new TermDOM({ process: terminal });
  const { document } = dom;
  
  const div = document.createElement('div');
  div.textContent = 'Text on blue background';
  div.style.setProperty('background-color', 'blue');
  
  document.body.appendChild(div);
  
  await dom.waitForRender();
  const snapshot = terminal.getScreenContents();
  
  expect(snapshot).toMatchSnapshot();
  
  dom.dispose();
});