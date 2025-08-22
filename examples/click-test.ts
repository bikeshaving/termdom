#!/usr/bin/env bun

/**
 * Simple click test
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('Click Test - Try slow and fast clicks\n');

const tom = createTOM();
tom.enableInputMode();
tom.enableMouse();

// Big button
const button = tom.createElement('button');
button.textContent = 'CLICK ME';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minHeight = 10;
button.style.minWidth = 40;
button.style.padding = [3, 8, 3, 8];
button.style.textAlign = 'center';
button.style.fontSize = 'large';
button.style.fontWeight = 'bold';
tom.body.appendChild(button);

let clicks = 0;

button.addEventListener('click', () => {
  clicks++;
  button.textContent = `CLICKED ${clicks} TIMES!`;
  button.style.backgroundColor = 'green';
  tom.render();
  
  setTimeout(() => {
    button.style.backgroundColor = 'red';
    button.textContent = 'CLICK ME';
    tom.render();
  }, 300);
});

// Instructions
const info = tom.createElement('text');
info.textContent = 'Press Q to quit | Try clicking slowly and quickly';
info.style.color = 'gray';
info.style.marginTop = 2;
info.style.textAlign = 'center';
tom.body.appendChild(info);

// Quit
tom.addEventListener('keydown', (e: any) => {
  if (e.key?.toLowerCase() === 'q') {
    console.log(`\nTotal clicks: ${clicks}`);
    tom.destroy();
    process.exit(0);
  }
});

tom.render();