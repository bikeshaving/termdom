#!/usr/bin/env bun

/**
 * Demonstrates proper cleanup and unload events
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('🧹 Unload Event Demo');
console.log('Press Ctrl+C to exit and see cleanup in action\n');

const tty = createTTYWindow();
const { document, window } = tty;

// Enable input and mouse
tty.enableInputMode();
tty.enableMouse();

// Register cleanup handlers
document.registerCleanupHandler(() => {
  console.log('\n🧹 Document cleanup handler called');
});

// Listen for unload event
window.addEventListener('unload', () => {
  console.log('📦 Window unload event fired');
});

// Another unload listener
window.addEventListener('unload', () => {
  console.log('👋 Goodbye from unload event!');
});

// Create interactive button
const button = tty.document.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'blue';
button.style.color = 'white';
button.style.padding = [1, 3, 1, 3];
button.style.minHeight = 3;
button.style.minWidth = 15;
tty.document.body.appendChild(button);

let clicks = 0;
button.addEventListener('click', () => {
  clicks++;
  button.textContent = `Clicked ${clicks} times`;
  tty.document.render();
});

// Info text
const info = tty.document.createElement('text');
info.textContent = 'Press Ctrl+C to exit gracefully';
info.style.color = 'gray';
info.style.marginTop = 2;
tty.document.body.appendChild(info);

// Initial render
tty.document.render();

console.log('\n✅ Ready! Try clicking the button, then press Ctrl+C');