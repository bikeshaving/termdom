/**
 * Simple mouse test with TOM
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('🖱️  Simple Mouse Test');
console.log('Click anywhere, press Q to quit\n');

const tom = createTOM();

// Enable input and mouse
tom.enableInputMode();
tom.enableMouse();

// Hide cursor
process.stdout.write('\x1b[?25l');

// Create a big button
const button = tom.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'blue';
button.style.color = 'white';
button.style.minHeight = 10;
button.style.padding = [2, 5, 2, 5];
tom.body.appendChild(button);

// Status
const status = tom.createElement('text');
status.textContent = 'Waiting for mouse events...';
status.style.color = 'yellow';
status.style.padding = [2, 0, 0, 0];
tom.body.appendChild(status);

let eventCount = 0;

// Add all mouse events
['mousedown', 'mouseup', 'click', 'mouseenter', 'mouseleave', 'mousemove'].forEach(eventType => {
  button.addEventListener(eventType, (e: any) => {
    eventCount++;
    status.textContent = `Event #${eventCount}: ${eventType} at (${e.clientX}, ${e.clientY})`;
    console.log(`Event: ${eventType}`, e.clientX, e.clientY);
    tom.render();
  });
});

// Also listen on document
tom.addEventListener('mousemove', (e: any) => {
  // console.log('Document mousemove:', e.clientX, e.clientY);
});

// Keyboard
tom.addEventListener('keydown', (e: any) => {
  if (e.key.toLowerCase() === 'q') {
    process.stdout.write('\x1b[?25h');
    tom.destroy();
    console.log('\nBye!');
    process.exit(0);
  }
});

// Initial render
tom.render();

// Debug: log the button bounds
console.log('Button bounds:', button.bounds);

// Timeout
setTimeout(() => {
  process.stdout.write('\x1b[?25h');
  tom.destroy();
  console.log('\nTimeout');
  process.exit(0);
}, 30000);