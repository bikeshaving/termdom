#!/usr/bin/env bun

/**
 * Test display: 'block' implementation
 */

import { createTTY, BunTTYRuntime } from '../src/index.js';

const runtime = new BunTTYRuntime();
const { document, dispose } = createTTY({ runtime });

// Create a block container
const blockContainer = document.createElement('div');
blockContainer.style.setProperty('display', 'block'); // Should behave like flex column + stretch
blockContainer.style.setProperty('background-color', 'blue');
blockContainer.style.setProperty('padding', '5px');
blockContainer.style.setProperty('height', '10px');

// Add multiple children - they should stack vertically and stretch horizontally
const child1 = document.createElement('div');
child1.style.setProperty('background-color', 'red');
child1.style.setProperty('height', '2px');
child1.appendChild(document.createTextNode('Child 1'));

const child2 = document.createElement('div');
child2.style.setProperty('background-color', 'green');
child2.style.setProperty('height', '2px');
child2.appendChild(document.createTextNode('Child 2'));

const child3 = document.createElement('div');
child3.style.setProperty('background-color', 'yellow');
child3.style.setProperty('height', '2px');
child3.appendChild(document.createTextNode('Child 3'));

blockContainer.appendChild(child1);
blockContainer.appendChild(child2);
blockContainer.appendChild(child3);

document.body.appendChild(blockContainer);

console.log('Block display test:');
console.log('- Container should use flex column layout (vertical stack)');
console.log('- Children should stretch to full width');
console.log('- Should look like traditional CSS block layout');

// Layout renders automatically via MutationObserver!

setTimeout(() => {
  dispose();
}, 3000);