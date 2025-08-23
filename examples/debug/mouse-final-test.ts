/**
 * Final mouse test with fixed event creation
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('🖱️  Final Mouse Test');
console.log('Click the red button to test mouse events');
console.log('Press Q to quit\n');

const tty = createTTYWindow();

// Add more detailed debug logging to mouse handler
const mouseHandler = (tty.document as any).mouseHandler;

// Patch findElementAt to add logging
const originalFindElementAt = mouseHandler.findElementAt;
mouseHandler.findElementAt = function(x: number, y: number) {
  const element = originalFindElementAt.call(this, x, y);
  console.log(`🎯 Element at (${x}, ${y}):`, element ? element.tagName : 'null');
  return element;
};

// Patch handleMouseDown to add logging
const originalHandleMouseDown = mouseHandler.handleMouseDown;
mouseHandler.handleMouseDown = function(x: number, y: number, button: number) {
  console.log(`🖱️  MouseDown at (${x}, ${y}) button=${button}`);
  return originalHandleMouseDown.call(this, x, y, button);
};

// Patch handleMouseUp to add logging
const originalHandleMouseUp = mouseHandler.handleMouseUp;
mouseHandler.handleMouseUp = function(x: number, y: number, button: number) {
  console.log(`🖱️  MouseUp at (${x}, ${y}) button=${button}`);
  return originalHandleMouseUp.call(this, x, y, button);
};

tty.enableInputMode();
tty.enableMouse();

// Create button with specific size
const button = tty.document.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minHeight = 5;
button.style.minWidth = 20;
button.style.padding = [1, 3, 1, 3];
tty.document.body.appendChild(button);

let clickCount = 0;

// Add event listeners with detailed logging
button.addEventListener('mousedown', (e: any) => {
  console.log('✅ BUTTON MOUSEDOWN EVENT!', e.clientX, e.clientY);
});

button.addEventListener('mouseup', (e: any) => {
  console.log('✅ BUTTON MOUSEUP EVENT!', e.clientX, e.clientY);
});

button.addEventListener('click', (e: any) => {
  clickCount++;
  console.log(`✅ BUTTON CLICK EVENT #${clickCount}!`, e.clientX, e.clientY);
  
  // Visual feedback
  const originalBg = button.style.backgroundColor;
  button.style.backgroundColor = 'green';
  tty.document.render();
  
  setTimeout(() => {
    button.style.backgroundColor = originalBg;
    tty.document.render();
  }, 200);
});

button.addEventListener('mouseenter', (e: any) => {
  console.log('✅ BUTTON MOUSE ENTER!');
  button.style.backgroundColor = 'yellow';
  button.style.color = 'black';
  tty.document.render();
});

button.addEventListener('mouseleave', (e: any) => {
  console.log('✅ BUTTON MOUSE LEAVE!');
  button.style.backgroundColor = 'red';
  button.style.color = 'white';
  tty.document.render();
});

// Quit handler
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

console.log(`\nButton bounds: x=${button.bounds.x} y=${button.bounds.y} w=${button.bounds.width} h=${button.bounds.height}`);
console.log('Click anywhere on the red button area!');

setTimeout(() => {
  process.stdout.write('\x1b[?25h');
  tty[Symbol.dispose]();
  console.log('\nTimeout');
  process.exit(0);
}, 30000);