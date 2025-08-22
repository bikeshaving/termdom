#!/usr/bin/env bun

/**
 * Clean mouse demo - Click the big red button!
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('🖱️  Mouse Demo - Click the Big Red Button!');
console.log('Press Q to quit\n');

const tom = createTOM();

// Enable input and mouse
tom.enableInputMode();
tom.enableMouse();

// Create a big red button
const button = tom.createElement('button');
button.textContent = '🎯 CLICK ME! 🎯';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minHeight = 7;
button.style.minWidth = 30;
button.style.padding = [2, 5, 2, 5];
button.style.fontSize = 'large';
button.style.fontWeight = 'bold';
button.style.margin = [5, 10, 5, 10];
tom.body.appendChild(button);

// Click counter
let clicks = 0;
const counter = tom.createElement('text');
counter.textContent = 'Clicks: 0';
counter.style.color = 'cyan';
counter.style.marginTop = 2;
counter.style.textAlign = 'center';
tom.body.appendChild(counter);

// Button events
button.addEventListener('click', () => {
  clicks++;
  counter.textContent = `Clicks: ${clicks}`;
  
  // Flash effect
  button.style.backgroundColor = 'green';
  button.textContent = '✨ NICE! ✨';
  tom.render();
  
  setTimeout(() => {
    button.style.backgroundColor = 'red';
    button.textContent = '🎯 CLICK ME! 🎯';
    tom.render();
  }, 200);
});

button.addEventListener('mouseenter', () => {
  button.style.backgroundColor = 'darkred';
  button.style.transform = 'scale(1.1)';
  tom.render();
});

button.addEventListener('mouseleave', () => {
  button.style.backgroundColor = 'red';
  button.style.transform = 'scale(1)';
  tom.render();
});

// Quit on Q
tom.addEventListener('keydown', (e: any) => {
  if (e.key && e.key.toLowerCase() === 'q') {
    console.log('\n👋 Thanks for clicking!');
    tom.destroy();
    process.exit(0);
  }
});

// Initial render
tom.render();