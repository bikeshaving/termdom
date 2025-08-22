#!/usr/bin/env bun

/**
 * Simple text wrapping test
 */

import { createTOM } from '../src/index.js';

const tom = createTOM();

// Simple container with text that should wrap
const container = tom.createElement('container');
container.style.backgroundColor = 'blue';
container.style.padding = [1, 1, 1, 1];
container.style.width = 20;
container.style.height = 8;
container.style.wordWrap = 'normal';

const text = 'This is a long line that should wrap to multiple lines.';
container.appendChild(tom.createTextNode(text));

tom.body.appendChild(container);

console.log(`Testing text wrapping:`);
console.log(`Text: "${text}"`);
console.log(`Container width: 20 (minus 2 for padding = 18 content width)`);
console.log(`Should break into multiple lines.`);

tom.render();

setTimeout(() => {
  tom.destroy();
}, 3000);