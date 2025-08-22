#!/usr/bin/env bun

/**
 * Debug button text rendering
 */

import { createTOM } from '../src/index.js';

const tom = createTOM();

// Create a simple test with just a button
const button = tom.createElement('button');
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

tom.body.appendChild(button);

tom.render();

setTimeout(() => {
  tom.destroy();
}, 2000);