/**
 * Combined debug - raw mouse + TOM integration
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('🔍 Combined Mouse Debug');
console.log('This will show both raw mouse data AND TOM events');
console.log('Press Q to quit\n');

const tom = createTOM();

// Enable TOM mouse
tom.enableInputMode();
tom.enableMouse();

// ALSO set up our own raw mouse handler to see what's happening
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let rawBuffer = '';
let tomEventCount = 0;
let rawEventCount = 0;

// Our own raw handler (will compete with TOM's)
process.stdin.on('data', (data: Buffer) => {
  const str = data.toString();
  
  // Log raw mouse data
  if (str.includes('\x1b[<')) {
    rawEventCount++;
    console.log(`RAW #${rawEventCount}: ${str.replace(/\x1b/g, 'ESC')}`);
    
    // Parse it ourselves
    const match = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (match) {
      const [, btn, x, y, action] = match;
      console.log(`  → Parsed: button=${btn} x=${x} y=${y} action=${action}`);
    }
  }
  
  // Handle quit
  if (str === 'q' || str === 'Q') {
    process.stdout.write('\x1b[?1003l\x1b[?1006l\x1b[?25h');
    process.exit(0);
  }
});

// Create TOM button
const button = tom.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'red';
button.style.minHeight = 5;
button.style.padding = [2, 5, 2, 5];
tom.body.appendChild(button);

// Add TOM event listeners
button.addEventListener('click', () => {
  tomEventCount++;
  console.log(`TOM CLICK #${tomEventCount}!`);
});

button.addEventListener('mouseenter', () => {
  console.log('TOM MOUSE ENTER!');
});

button.addEventListener('mouseleave', () => {
  console.log('TOM MOUSE LEAVE!');
});

process.stdout.write('\x1b[?25l'); // Hide cursor
tom.render();

console.log(`Button bounds: x=${button.bounds.x} y=${button.bounds.y} w=${button.bounds.width} h=${button.bounds.height}`);

// Timeout
setTimeout(() => {
  process.stdout.write('\x1b[?1003l\x1b[?1006l\x1b[?25h');
  console.log('\nTimeout');
  process.exit(0);
}, 30000);