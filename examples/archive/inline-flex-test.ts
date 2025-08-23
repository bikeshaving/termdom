#!/usr/bin/env bun

/**
 * Test inline-flex display type
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('Inline-Flex Test\n');

const tty = createTTYWindow();

// Create a container with mixed content including inline-flex elements
const paragraph = tty.document.createElement('container');
paragraph.style.padding = [2, 2, 2, 2];
paragraph.style.backgroundColor = 'darkblue';

// Add text before
paragraph.appendChild(tty.document.createTextNode('Here is some text with '));

// Create an inline-flex container (like a button group)
const buttonGroup = tty.document.createElement('container');
buttonGroup.style.display = 'inline';
buttonGroup.style.flexDirection = 'row';
buttonGroup.style.gap = 1;
buttonGroup.style.backgroundColor = 'gray';
buttonGroup.style.padding = [0, 1, 0, 1];

// Add buttons to the inline-flex container
const btn1 = tty.document.createElement('button');
btn1.textContent = 'A';
btn1.style.backgroundColor = 'red';
btn1.style.color = 'white';
btn1.style.minWidth = 3;
btn1.style.minHeight = 1;

const btn2 = tty.document.createElement('button');
btn2.textContent = 'B';
btn2.style.backgroundColor = 'green';  
btn2.style.color = 'white';
btn2.style.minWidth = 3;
btn2.style.minHeight = 1;

buttonGroup.appendChild(btn1);
buttonGroup.appendChild(btn2);

paragraph.appendChild(buttonGroup);

// Add text after
paragraph.appendChild(tty.document.createTextNode(' inline buttons and more text.'));

tty.document.body.appendChild(paragraph);

// Test display values
console.log('Button group display:', buttonGroup.style.display);
console.log('Button display (default):', btn1.style.display);

tty.document.render();

setTimeout(() => {
  tty[Symbol.dispose]();
  console.log('\nInline-flex test completed');
}, 3000);