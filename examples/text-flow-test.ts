#!/usr/bin/env bun

/**
 * Test text flow with mixed content
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('Text Flow Test\n');

const tom = createTOM();

// Create a container with mixed text and elements
const container = tom.createElement('container');
container.style.padding = [2, 2, 2, 2];
container.style.backgroundColor = 'blue';

// Add mixed content: text node -> element -> text node
container.appendChild(tom.createTextNode('Before '));

const emphasis = tom.createElement('text');
emphasis.textContent = '[EMPHASIS]';
emphasis.style.fontWeight = 'bold';
emphasis.style.color = 'yellow';
container.appendChild(emphasis);

container.appendChild(tom.createTextNode(' After'));

tom.body.appendChild(container);

// Also test direct text on body
tom.body.appendChild(tom.createTextNode('Direct text on body'));

tom.render();

setTimeout(() => {
  tom.destroy();
  console.log('\nText flow test completed');
}, 2000);