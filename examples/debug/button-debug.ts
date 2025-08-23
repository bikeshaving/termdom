#!/usr/bin/env bun

/**
 * Debug button text rendering
 */

import { createTTYWindow } from '../src/index.js';

const tty = createTTYWindow();

// Create a simple test with just a button
const button = tty.document.createElement('button');
button.textContent = 'TEST';
button.style.backgroundColor = 'red';
button.style.color = 'white';

console.log('Button debug info:');
console.log('  display:', button.style.display);
console.log('  childNodes.length:', button.childNodes.length);
console.log('  children.length:', button.children.length);
console.log('  textContent:', button.textContent);

if (button.childNodes.length > 0) {
  console.log('  First child nodeType:', button.childNodes[0].nodeType);
  console.log('  First child textContent:', button.childNodes[0].textContent);
}

tty.document.body.appendChild(button);

tty.document.render();

setTimeout(() => {
  tty[Symbol.dispose]();
}, 2000);