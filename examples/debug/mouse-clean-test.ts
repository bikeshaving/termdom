/**
 * Clean mouse test - only TOM handling input
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('🖱️  Clean Mouse Test - Only TOM');
console.log('Move mouse and click the button');
console.log('Press Q to quit\n');

const tty = createTTYWindow();

// Add debug logging to TOM's mouse handler
const mouseHandler = (tty.document as any).mouseHandler;
const originalHandle = mouseHandler.handleMouseInput;
mouseHandler.handleMouseInput = function(data: string) {
  console.log('🔍 TOM MouseHandler received:', data.replace(/\x1b/g, 'ESC'));
  const result = originalHandle.call(this, data);
  console.log('🔍 TOM MouseHandler returned:', result);
  return result;
};

// Add debug to TOM's input handler
const originalHandleInput = (tty.document as any).handleInput;
(tty.document as any).handleInput = function(data: string) {
  if (data.includes('\x1b[<')) {
    console.log('🔍 TOM handleInput got mouse data:', data.replace(/\x1b/g, 'ESC'));
  }
  return originalHandleInput.call(this, data);
};

tty.enableInputMode();
tty.enableMouse();

// Create button
const button = tty.document.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minHeight = 5;
button.style.padding = [2, 5, 2, 5];
tty.document.body.appendChild(button);

let eventCount = 0;

// Add event listeners
button.addEventListener('click', (e: any) => {
  eventCount++;
  console.log(`✅ BUTTON CLICKED #${eventCount}! at (${e.clientX}, ${e.clientY})`);
});

button.addEventListener('mouseenter', (e: any) => {
  console.log('✅ MOUSE ENTER BUTTON!');
  button.style.backgroundColor = 'yellow';
  tty.document.render();
});

button.addEventListener('mouseleave', (e: any) => {
  console.log('✅ MOUSE LEAVE BUTTON!');
  button.style.backgroundColor = 'red';
  tty.document.render();
});

// Keyboard quit
tty.addEventListener('keydown', (e: any) => {
  if (e.key && e.key.toLowerCase() === 'q') {
    process.stdout.write('\x1b[?25h');
    tty[Symbol.dispose]();
    console.log('\n👋 Goodbye!');
    process.exit(0);
  }
});

process.stdout.write('\x1b[?25l');
tty.document.render();

console.log(`Button bounds: x=${button.bounds.x} y=${button.bounds.y} w=${button.bounds.width} h=${button.bounds.height}`);

// Auto-exit
setTimeout(() => {
  process.stdout.write('\x1b[?25h');
  tty[Symbol.dispose]();
  console.log('\nTimeout');
  process.exit(0);
}, 30000);