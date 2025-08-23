#!/usr/bin/env bun

/**
 * Mouse debug demo - shows what's happening with mouse events
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('🖱️  Mouse Debug Demo');
console.log('Click and hold to see event timing\n');

const tty = createTTYWindow();

// Enable input and mouse
tty.enableInputMode();
tty.enableMouse();

// Create button
const button = tty.document.createElement('button');
button.textContent = 'Test Button';
button.style.backgroundColor = 'blue';
button.style.color = 'white';
button.style.minHeight = 5;
button.style.minWidth = 20;
button.style.padding = [1, 3, 1, 3];
tty.document.body.appendChild(button);

// Event log
const log = tty.document.createElement('text');
log.textContent = 'Events will appear here...';
log.style.color = 'gray';
log.style.marginTop = 2;
tty.document.body.appendChild(log);

let eventCount = 0;
const logEvent = (type: string, target: string) => {
  eventCount++;
  const time = new Date().toISOString().split('T')[1].slice(0, -1);
  log.textContent = `#${eventCount} [${time}] ${type} on ${target}`;
  tty.document.render();
};

// Track all mouse events
button.addEventListener('mousedown', (e) => {
  logEvent('mousedown', 'button');
  button.style.backgroundColor = 'darkblue';
  tty.document.render();
});

button.addEventListener('mouseup', (e) => {
  logEvent('mouseup', 'button');
  button.style.backgroundColor = 'blue';
  tty.document.render();
});

button.addEventListener('click', (e) => {
  logEvent('CLICK', 'button');
  // Flash green
  button.style.backgroundColor = 'green';
  tty.document.render();
  setTimeout(() => {
    button.style.backgroundColor = 'blue';
    tty.document.render();
  }, 200);
});

button.addEventListener('mouseenter', () => {
  logEvent('mouseenter', 'button');
});

button.addEventListener('mouseleave', () => {
  logEvent('mouseleave', 'button');
});

// Also track document-level events
tty.addEventListener('mousedown', (e) => {
  const target = (e as any).target;
  if (target !== button) {
    logEvent('mousedown', 'document');
  }
});

// Quit on Q
tty.addEventListener('keydown', (e: any) => {
  if (e.key && e.key.toLowerCase() === 'q') {
    console.log('\n👋 Goodbye!');
    tty[Symbol.dispose]();
    process.exit(0);
  }
});

// Initial render
tty.document.render();

console.log('\nPress Q to quit');