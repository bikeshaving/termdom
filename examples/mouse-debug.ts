#!/usr/bin/env bun

/**
 * Mouse debug demo - shows what's happening with mouse events
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('🖱️  Mouse Debug Demo');
console.log('Click and hold to see event timing\n');

const tom = createTOM();

// Enable input and mouse
tom.enableInputMode();
tom.enableMouse();

// Create button
const button = tom.createElement('button');
button.textContent = 'Test Button';
button.style.backgroundColor = 'blue';
button.style.color = 'white';
button.style.minHeight = 5;
button.style.minWidth = 20;
button.style.padding = [1, 3, 1, 3];
tom.body.appendChild(button);

// Event log
const log = tom.createElement('text');
log.textContent = 'Events will appear here...';
log.style.color = 'gray';
log.style.marginTop = 2;
tom.body.appendChild(log);

let eventCount = 0;
const logEvent = (type: string, target: string) => {
  eventCount++;
  const time = new Date().toISOString().split('T')[1].slice(0, -1);
  log.textContent = `#${eventCount} [${time}] ${type} on ${target}`;
  tom.render();
};

// Track all mouse events
button.addEventListener('mousedown', (e) => {
  logEvent('mousedown', 'button');
  button.style.backgroundColor = 'darkblue';
  tom.render();
});

button.addEventListener('mouseup', (e) => {
  logEvent('mouseup', 'button');
  button.style.backgroundColor = 'blue';
  tom.render();
});

button.addEventListener('click', (e) => {
  logEvent('CLICK', 'button');
  // Flash green
  button.style.backgroundColor = 'green';
  tom.render();
  setTimeout(() => {
    button.style.backgroundColor = 'blue';
    tom.render();
  }, 200);
});

button.addEventListener('mouseenter', () => {
  logEvent('mouseenter', 'button');
});

button.addEventListener('mouseleave', () => {
  logEvent('mouseleave', 'button');
});

// Also track document-level events
tom.addEventListener('mousedown', (e) => {
  const target = (e as any).target;
  if (target !== button) {
    logEvent('mousedown', 'document');
  }
});

// Quit on Q
tom.addEventListener('keydown', (e: any) => {
  if (e.key && e.key.toLowerCase() === 'q') {
    console.log('\n👋 Goodbye!');
    tom.destroy();
    process.exit(0);
  }
});

// Initial render
tom.render();

console.log('\nPress Q to quit');