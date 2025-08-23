/**
 * Simple mouse test with TOM
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('🖱️  Simple Mouse Test');
console.log('Click anywhere, press Q to quit\n');

const tty = createTTYWindow();

// Enable input and mouse
tty.enableInputMode();
tty.enableMouse();

// Hide cursor
process.stdout.write('\x1b[?25l');

// Create a big button
const button = tty.document.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'blue';
button.style.color = 'white';
button.style.minHeight = 10;
button.style.padding = [2, 5, 2, 5];
tty.document.body.appendChild(button);

// Status
const status = tty.document.createElement('text');
status.textContent = 'Waiting for mouse events...';
status.style.color = 'yellow';
status.style.padding = [2, 0, 0, 0];
tty.document.body.appendChild(status);

let eventCount = 0;

// Add all mouse events
['mousedown', 'mouseup', 'click', 'mouseenter', 'mouseleave', 'mousemove'].forEach(eventType => {
  button.addEventListener(eventType, (e: any) => {
    eventCount++;
    status.textContent = `Event #${eventCount}: ${eventType} at (${e.clientX}, ${e.clientY})`;
    console.log(`Event: ${eventType}`, e.clientX, e.clientY);
    tty.document.render();
  });
});

// Also listen on document
tty.addEventListener('mousemove', (e: any) => {
  // console.log('Document mousemove:', e.clientX, e.clientY);
});

// Keyboard
tty.addEventListener('keydown', (e: any) => {
  if (e.key.toLowerCase() === 'q') {
    process.stdout.write('\x1b[?25h');
    tty[Symbol.dispose]();
    console.log('\nBye!');
    process.exit(0);
  }
});

// Initial render
tty.document.render();

// Debug: log the button bounds
console.log('Button bounds:', button.bounds);

// Timeout
setTimeout(() => {
  process.stdout.write('\x1b[?25h');
  tty[Symbol.dispose]();
  console.log('\nTimeout');
  process.exit(0);
}, 30000);