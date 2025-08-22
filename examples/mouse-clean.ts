/**
 * Clean mouse test without logging spam
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('🖱️  Mouse Test');
console.log('Click the red button, press Q to quit\n');

const tom = createTOM();

tom.enableInputMode();
tom.enableMouse();

// Create button
const button = tom.createElement('button');
button.textContent = 'Click Me!';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minHeight = 5;
button.style.minWidth = 20;
button.style.padding = [1, 3, 1, 3];
tom.body.appendChild(button);

let clickCount = 0;

// Event listeners (only show important events)
button.addEventListener('click', (e: any) => {
  clickCount++;
  console.log(`✅ CLICKED #${clickCount}!`);
  
  // Flash green
  button.style.backgroundColor = 'green';
  tom.render();
  
  setTimeout(() => {
    button.style.backgroundColor = 'red';
    tom.render();
  }, 200);
});

// Debug: patch the mouse handler to see what element is found
const mouseHandler = (tom.document as any).mouseHandler;
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
  tom.render();
});

button.addEventListener('mouseleave', () => {
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

// Debug: show button bounds after render
console.log(`Button actual bounds: x=${button.bounds.x}, y=${button.bounds.y}, w=${button.bounds.width}, h=${button.bounds.height}`);

// Debug: check what body is
console.log('tom.body is:', tom.body.constructor.name);
console.log('tom.body instanceof TOMElement:', tom.body instanceof (await import('../src/core/TOMElement.js')).TOMElement);

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
  tom.destroy();
  console.log('\nTimeout');
  process.exit(0);
}, 60000);