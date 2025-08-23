#!/usr/bin/env bun

/**
 * Test text nodes vs TOMText elements
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('Text Node vs TOMText Test\n');

const tty = createTTYWindow();

// Method 1: TOMText element (like <span>)
const textElement = tty.document.createElement('text');
textElement.textContent = 'This is a TOMText element (like span)';
textElement.style.color = 'green';
textElement.style.marginBottom = 1;
tty.document.body.appendChild(textElement);

// Method 2: Direct text node (should this work?)
try {
  const textNode = tty.document.createTextNode('This is a direct text node');
  tty.document.body.appendChild(textNode);
  console.log('✅ Text nodes work!');
} catch (e) {
  console.log('❌ Text nodes not supported:', e.message);
}

// Method 3: Setting textContent directly on body
try {
  const div = tty.document.createElement('container');
  div.textContent = 'This is textContent on a container';
  div.style.color = 'blue';
  div.style.marginTop = 1;
  tty.document.body.appendChild(div);
  console.log('✅ textContent on containers works!');
} catch (e) {
  console.log('❌ textContent on containers failed:', e.message);
}

tty.document.render();

console.log('\nPress any key to exit');

process.stdin.on('data', () => {
  tty[Symbol.dispose]();
  process.exit(0);
});