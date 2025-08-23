#!/usr/bin/env bun

/**
 * Test textContent after removing shortcuts
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('TextContent Test (after removing shortcuts)\n');

const tty = createTTYWindow();

// Test 1: Button with textContent (should create text nodes internally)
console.log('Creating button with textContent...');
const button = tty.document.createElement('button');
button.textContent = 'Click Me!';  // This should create text nodes
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.padding = [1, 2, 1, 2];

tty.document.body.appendChild(button);

// Check what HappyDOM created
console.log('Button children count:', button.childNodes.length);
if (button.childNodes.length > 0) {
  console.log('First child type:', button.childNodes[0].constructor.name);
  console.log('First child content:', button.childNodes[0].textContent);
}

// Test 2: Text element with textContent
console.log('Creating text element with textContent...');
const text = tty.document.createElement('text');
text.textContent = 'I am styled text!';
text.style.color = 'green';
text.style.fontWeight = 'bold';
text.style.marginTop = 2;

tty.document.body.appendChild(text);

console.log('Text element children count:', text.childNodes.length);

// Test 3: Mixed manual approach
console.log('Creating mixed content manually...');
const container = tty.document.createElement('container');
container.style.marginTop = 2;

container.appendChild(tty.document.createTextNode('Manual '));

const emphasis = tty.document.createElement('text');
emphasis.appendChild(tty.document.createTextNode('emphasis'));
emphasis.style.fontStyle = 'italic';
emphasis.style.color = 'yellow';
container.appendChild(emphasis);

container.appendChild(tty.document.createTextNode(' text!'));

tty.document.body.appendChild(container);

// Render and see what happens
console.log('Rendering...');
try {
  tty.document.render();
  console.log('✅ Render successful');
} catch (e) {
  console.log('❌ Render failed:', e.message);
}

setTimeout(() => {
  tty[Symbol.dispose]();
  console.log('\nTextContent test completed');
}, 3000);