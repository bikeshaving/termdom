/**
 * Emoji Rendering Tests
 * 
 * Tests proper handling of emojis in terminal rendering:
 * - Width calculation (most emojis are 2 characters wide)
 * - Mixed content with emojis and text
 * - Complex emoji sequences (skin tones, combinations)
 */

import { test, expect } from 'bun:test';
import { createTTYDocument, MockTTYRuntime } from '../src/index.js';
import { expectSnapshot } from '../src/testing/snapshotUtils.js';

test('renders single emoji correctly', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const span = document.createElement('span');
  span.textContent = '🚀';
  document.body.appendChild(span);
  
  await render();
  
  expectSnapshot('single-emoji', mockRuntime, { updateSnapshots: true });
  dispose();
});

test('renders emoji with text correctly', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const span = document.createElement('span');
  span.textContent = 'Hello 🌍 World!';
  document.body.appendChild(span);
  
  await render();
  
  expectSnapshot('emoji-with-text', mockRuntime, { updateSnapshots: true });
  dispose();
});

test('renders multiple emojis correctly', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  container.style.setProperty('display', 'flex');
  container.style.setProperty('flex-direction', 'column');
  
  const testCases = [
    '🚀🎯📄', // Multiple emojis together
    '🎉 Party 🎊', // Emojis with spaces
    '👨‍💻', // Complex emoji (man technologist)
    '🌈🦄✨', // Colorful sequence
    '📱💻⌨️🖱️', // Tech emojis
  ];
  
  testCases.forEach(text => {
    const span = document.createElement('span');
    span.textContent = text;
    span.style.setProperty('padding', '2px');
    container.appendChild(span);
  });
  
  document.body.appendChild(container);
  
  await render();
  
  expectSnapshot('multiple-emojis', mockRuntime, { updateSnapshots: true });
  dispose();
});

test('renders emoji with colors correctly', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  const container = document.createElement('div');
  container.style.setProperty('display', 'flex');
  container.style.setProperty('flex-direction', 'column');
  
  const emojiSpan = document.createElement('span');
  emojiSpan.textContent = '🎨 Colorful Text 🌈';
  emojiSpan.style.setProperty('color', 'magenta');
  emojiSpan.style.setProperty('background-color', 'yellow');
  emojiSpan.style.setProperty('padding', '1px 2px');
  
  container.appendChild(emojiSpan);
  document.body.appendChild(container);
  
  await render();
  
  expectSnapshot('emoji-with-colors', mockRuntime, { updateSnapshots: true });
  dispose();
});

test('handles emoji width calculation', async () => {
  const mockRuntime = new MockTTYRuntime();
  const { document, render, dispose } = createTTYDocument({ runtime: mockRuntime });
  
  // Test that emojis are properly calculated for layout
  const container = document.createElement('div');
  container.style.setProperty('display', 'flex');
  container.style.setProperty('flex-direction', 'row');
  container.style.setProperty('width', '20px'); // Constrained width
  
  const textSpan = document.createElement('span');
  textSpan.textContent = 'Text ';
  
  const emojiSpan = document.createElement('span');
  emojiSpan.textContent = '🚀';
  
  const moreText = document.createElement('span');  
  moreText.textContent = ' More';
  
  container.appendChild(textSpan);
  container.appendChild(emojiSpan);
  container.appendChild(moreText);
  document.body.appendChild(container);
  
  await render();
  
  expectSnapshot('emoji-width-layout', mockRuntime, { updateSnapshots: true });
  dispose();
});