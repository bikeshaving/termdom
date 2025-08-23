#!/usr/bin/env bun

/**
 * Test text flow with mixed content
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('Text Flow Test\n');

const tty = createTTYWindow();

// Create a container with mixed text and elements
const container = tty.document.createElement('container');
container.style.padding = [2, 2, 2, 2];
container.style.backgroundColor = 'blue';

// Add mixed content: text node -> element -> text node
container.appendChild(tty.document.createTextNode('Before '));

const emphasis = tty.document.createElement('text');
emphasis.textContent = '[EMPHASIS]';
emphasis.style.fontWeight = 'bold';
emphasis.style.color = 'yellow';
container.appendChild(emphasis);

container.appendChild(tty.document.createTextNode(' After'));

tty.document.body.appendChild(container);

// Also test direct text on body
tty.document.body.appendChild(tty.document.createTextNode('Direct text on body'));

tty.document.render();

setTimeout(() => {
  tty[Symbol.dispose]();
  console.log('\nText flow test completed');
}, 2000);