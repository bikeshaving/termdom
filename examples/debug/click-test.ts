#!/usr/bin/env bun

/**
 * Simple click test
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('Click Test - Try slow and fast clicks\n');

const tty = createTTYWindow();
tty.enableInputMode();
tty.enableMouse();

// Big button
const button = tty.document.createElement('button');
button.textContent = 'CLICK ME';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minHeight = 10;
button.style.minWidth = 40;
button.style.padding = [3, 8, 3, 8];
button.style.textAlign = 'center';
button.style.fontSize = 'large';
button.style.fontWeight = 'bold';
tty.document.body.appendChild(button);

let clicks = 0;

button.addEventListener('click', () => {
  clicks++;
  button.textContent = `CLICKED ${clicks} TIMES!`;
  button.style.backgroundColor = 'green';
  tty.document.render();
  
  setTimeout(() => {
    button.style.backgroundColor = 'red';
    button.textContent = 'CLICK ME';
    tty.document.render();
  }, 300);
});

// Instructions
const info = tty.document.createElement('text');
info.textContent = 'Press Q to quit | Try clicking slowly and quickly';
info.style.color = 'gray';
info.style.marginTop = 2;
info.style.textAlign = 'center';
tty.document.body.appendChild(info);

// Quit
tty.addEventListener('keydown', (e: any) => {
  if (e.key?.toLowerCase() === 'q') {
    console.log(`\nTotal clicks: ${clicks}`);
    tty[Symbol.dispose]();
    process.exit(0);
  }
});

tty.document.render();