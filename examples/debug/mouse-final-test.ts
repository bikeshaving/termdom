/**
 * Final mouse test with fixed event creation
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('🖱️  Final Mouse Test');
console.log('Click the red button to test mouse events');
console.log('Press Q to quit\n');

const tom = createTOM();

// Add more detailed debug logging to mouse handler
const mouseHandler = (tom.document as any).mouseHandler;

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

tom.enableInputMode();
tom.enableMouse();

// Create button with specific size
const button = tom.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minHeight = 5;
button.style.minWidth = 20;
button.style.padding = [1, 3, 1, 3];
tom.body.appendChild(button);

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
  tom.render();
  
  setTimeout(() => {
    button.style.backgroundColor = originalBg;
    tom.render();
  }, 200);
});

button.addEventListener('mouseenter', (e: any) => {
  console.log('✅ BUTTON MOUSE ENTER!');
  button.style.backgroundColor = 'yellow';
  button.style.color = 'black';
  tom.render();
});

button.addEventListener('mouseleave', (e: any) => {
  console.log('✅ BUTTON MOUSE LEAVE!');
  button.style.backgroundColor = 'red';
  button.style.color = 'white';
  tom.render();
});

// Quit handler
tom.addEventListener('keydown', (e: any) => {
  if (e.key && e.key.toLowerCase() === 'q') {
    process.stdout.write('\x1b[?25h');
    tom.destroy();
    console.log('\n👋 Goodbye!');
    process.exit(0);
  }
});

process.stdout.write('\x1b[?25l');
tom.render();

console.log(`\nButton bounds: x=${button.bounds.x} y=${button.bounds.y} w=${button.bounds.width} h=${button.bounds.height}`);
console.log('Click anywhere on the red button area!');

setTimeout(() => {
  process.stdout.write('\x1b[?25h');
  tom.destroy();
  console.log('\nTimeout');
  process.exit(0);
}, 30000);