#!/usr/bin/env bun

/**
 * Test display: 'block' implementation
 */

import { createTTYWindow } from '../src/index.js';

const tty = createTTYWindow();

// Create a block container
const blockContainer = tty.document.createElement('container');
blockContainer.style.display = 'block'; // Should behave like flex column + stretch
blockContainer.style.backgroundColor = 'blue';
blockContainer.style.padding = [1, 2, 1, 2];
blockContainer.style.height = 10;

// Add multiple children - they should stack vertically and stretch horizontally
const child1 = tty.document.createElement('container');
child1.style.backgroundColor = 'red';
child1.style.height = 2;
child1.appendChild(tty.document.createTextNode('Child 1'));

const child2 = tty.document.createElement('container');
child2.style.backgroundColor = 'green';
child2.style.height = 2;
child2.appendChild(tty.document.createTextNode('Child 2'));

const child3 = tty.document.createElement('container');
child3.style.backgroundColor = 'yellow';
child3.style.height = 2;
child3.appendChild(tty.document.createTextNode('Child 3'));

blockContainer.appendChild(child1);
blockContainer.appendChild(child2);
blockContainer.appendChild(child3);

tty.document.body.appendChild(blockContainer);

console.log('Block display test:');
console.log('- Container should use flex column layout (vertical stack)');
console.log('- Children should stretch to full width');
console.log('- Should look like traditional CSS block layout');

tty.document.render();

setTimeout(() => {
  tty[Symbol.dispose]();
}, 3000);