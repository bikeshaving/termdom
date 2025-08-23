#!/usr/bin/env bun

/**
 * Test inline-block elements specifically
 */

import { createTTYWindow } from '../src/index.js';

const tty = createTTYWindow();

// Simple container with inline-block button
const container = tty.document.createElement('container');
container.style.backgroundColor = 'blue';
container.style.padding = [1, 2, 1, 2];

// Add text before button
container.appendChild(tty.document.createTextNode('Before '));

// Add inline-block button
const button = tty.document.createElement('button');
button.textContent = 'CLICK';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minWidth = 6;
button.style.minHeight = 3;

console.log('Button info:');
console.log('  display:', button.style.display);
console.log('  textContent:', button.textContent);
console.log('  childNodes.length:', button.childNodes.length);

container.appendChild(button);

// Add text after button
container.appendChild(tty.document.createTextNode(' After'));

tty.document.body.appendChild(container);
tty.document.render();

// Debug actual layout after render
console.log('\n=== Layout Debug ===');
console.log('Container bounds:', container.bounds);
console.log('Container contentArea:', container.getContentArea());
console.log('Button bounds:', button.bounds);

// Calculate expected positions step by step
const contentArea = container.getContentArea();
const beforeText = 'Before ';
const afterText = ' After';

console.log('\n=== Position Calculation ===');
console.log('ContentArea start x:', contentArea.x);
console.log('"Before " text width:', Bun.stringWidth(beforeText));
console.log('Button actual width:', button.bounds.width);
console.log('Expected "After" x position:', contentArea.x + Bun.stringWidth(beforeText) + button.bounds.width);
console.log('"After" text starts with:', afterText.slice(0, 3));

setTimeout(() => {
  tty[Symbol.dispose]();
}, 3000);