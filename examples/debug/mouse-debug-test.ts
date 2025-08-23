/**
 * Debug mouse input handling
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('🔍 Mouse Debug Test');
console.log('Move mouse and click, press Q to quit\n');

const tty = createTTYWindow();

// Patch the handleInput method to add logging
const originalHandleInput = (tty.document as any).handleInput;
(tty.document as any).handleInput = function(data: string) {
  if (data.includes('\x1b[<')) {
    console.log('Got mouse data:', data.replace(/\x1b/g, 'ESC'));
  }
  return originalHandleInput.call(this, data);
};

// Patch the mouse handler to add logging
const mouseHandler = (tty.document as any).mouseHandler;
const originalHandle = mouseHandler.handleMouseInput;
mouseHandler.handleMouseInput = function(data: string) {
  console.log('Mouse handler called with:', data.replace(/\x1b/g, 'ESC'));
  const result = originalHandle.call(this, data);
  console.log('Mouse handler returned:', result);
  return result;
};

tty.enableInputMode();
tty.enableMouse();

process.stdout.write('\x1b[?25l');

// Simple button
const button = tty.document.createElement('button');
button.textContent = 'Test Button';
button.style.backgroundColor = 'red';
button.style.minHeight = 5;
tty.document.body.appendChild(button);

button.addEventListener('click', () => {
  console.log('BUTTON CLICKED!');
});

button.addEventListener('mouseenter', () => {
  console.log('BUTTON MOUSE ENTER!');
});

tty.addEventListener('keydown', (e: any) => {
  if (e.key.toLowerCase() === 'q') {
    process.stdout.write('\x1b[?25h');
    tty[Symbol.dispose]();
    process.exit(0);
  }
});

tty.document.render();

setTimeout(() => {
  process.stdout.write('\x1b[?25h');
  tty[Symbol.dispose]();
  process.exit(0);
}, 30000);