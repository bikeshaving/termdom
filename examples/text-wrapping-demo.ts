#!/usr/bin/env bun

/**
 * Test text wrapping implementation
 */

import { createTTY, BunTTYRuntime } from '../src/index.js';

const runtime = new BunTTYRuntime();
const { document, dispose } = createTTY({ runtime });

// Test 1: Simple text wrapping in a narrow container
const container1 = document.createElement('container');
container1.style.backgroundColor = 'blue';
container1.style.padding = [1, 2, 1, 2];
container1.style.width = 25;
container1.style.height = 8;
container1.style.wordWrap = 'normal';

const longText = 'This is a very long line of text that should be wrapped to multiple lines when it exceeds the maximum width of the container.';
container1.appendChild(document.createTextNode(longText));

document.body.appendChild(container1);

// Test 2: Text wrapping with inline-block elements (mixed content)
const container2 = document.createElement('container');
container2.style.backgroundColor = 'green';
container2.style.padding = [1, 2, 1, 2];
container2.style.width = 30;
container2.style.height = 6;
container2.style.marginTop = 1;
container2.style.wordWrap = 'normal';

container2.appendChild(document.createTextNode('Before button '));

const button = document.createElement('button');
button.textContent = 'CLICK';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minWidth = 8;
button.style.minHeight = 1;
container2.appendChild(button);

container2.appendChild(document.createTextNode(' and after button some more text that should wrap around nicely.'));

document.body.appendChild(container2);

// Test 3: No wrapping test
const container3 = document.createElement('container');
container3.style.backgroundColor = 'yellow';
container3.style.color = 'black';
container3.style.padding = [1, 2, 1, 2];
container3.style.width = 40;
container3.style.height = 3;
container3.style.marginTop = 1;
container3.style.wordWrap = 'nowrap';

container3.appendChild(document.createTextNode('This text should not wrap and may overflow.'));

document.body.appendChild(container3);

console.log('Text Wrapping Demo:');
console.log('1. Blue container: Long text should wrap to multiple lines');
console.log('2. Green container: Text with button should wrap around inline element');
console.log('3. Yellow container: Text should not wrap (may overflow)');


setTimeout(() => {
  dispose();
}, 5000);