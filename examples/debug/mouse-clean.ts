/**
 * Clean mouse test without logging spam
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('🖱️  Mouse Test');
console.log('Click the red button, press Q to quit\n');

const tty = createTTYWindow();

tty.enableInputMode();
tty.enableMouse();

// Create button
const button = tty.document.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minHeight = 5;
button.style.minWidth = 20;
button.style.padding = [1, 3, 1, 3];
tty.document.body.appendChild(button);

let clickCount = 0;

// Event listeners (only show important events)
button.addEventListener('click', (e: any) => {
  clickCount++;
  console.log(`✅ CLICKED #${clickCount}!`);
  
  // Flash green
  button.style.backgroundColor = 'green';
  tty.document.render();
  
  setTimeout(() => {
    button.style.backgroundColor = 'red';
    tty.document.render();
  }, 200);
});

// Debug: patch the mouse handler to see what element is found
const mouseHandler = (tty.document as any).mouseHandler;
const originalFindElementAt = mouseHandler.findElementAt;
mouseHandler.findElementAt = function(x, y) {
  const element = originalFindElementAt.call(this, x, y);
  console.log(`🎯 findElementAt(${x}, ${y}) = ${element ? element.tagName : 'null'}`);
  if (element) {
    console.log(`   Button bounds: ${element.bounds.x}, ${element.bounds.y}, ${element.bounds.width}x${element.bounds.height}`);
  }
  return element;
};

button.addEventListener('mouseenter', () => {
  button.style.backgroundColor = 'yellow';
  button.style.color = 'black';
  tty.document.render();
});

button.addEventListener('mouseleave', () => {
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

// Debug: show button bounds after render
console.log(`Button actual bounds: x=${button.bounds.x}, y=${button.bounds.y}, w=${button.bounds.width}, h=${button.bounds.height}`);

// Debug: check what body is
console.log('tty.document.body is:', tty.document.body.constructor.name);
console.log('tty.document.body instanceof TTYElement:', tty.document.body instanceof (await import('../src/core/TTYElement.js')).TTYElement);

// Debug: test containsPoint manually
const testX = 31, testY = 20;
console.log(`Testing containsPoint(${testX}, ${testY}) = ${button.containsPoint(testX, testY)}`);

// Debug: patch containsPoint to see what's happening
const originalContainsPoint = button.containsPoint;
button.containsPoint = function(x, y) {
  const result = originalContainsPoint.call(this, x, y);
  console.log(`containsPoint(${x}, ${y}): bounds=(${this.bounds.x}, ${this.bounds.y}, ${this.bounds.width}x${this.bounds.height}) result=${result}`);
  return result;
};

setTimeout(() => {
  process.stdout.write('\x1b[?25h');
  tty[Symbol.dispose]();
  console.log('\nTimeout');
  process.exit(0);
}, 60000);