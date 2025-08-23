#!/usr/bin/env bun

/**
 * Debug inline-block width calculations
 */

import { createTTYWindow } from '../src/index.js';

const tty = createTTYWindow();

const container = tty.document.createElement('container');
container.style.backgroundColor = 'blue';
container.style.padding = [1, 2, 1, 2];

container.appendChild(tty.document.createTextNode('Before '));

const button = tty.document.createElement('button');
button.textContent = 'CLICK';
button.style.backgroundColor = 'red';
button.style.color = 'white';
button.style.minWidth = 6;
button.style.minHeight = 3;

container.appendChild(button);
container.appendChild(tty.document.createTextNode(' After'));

tty.document.body.appendChild(container);
tty.document.render();

// Debug after render
console.log('\n=== Debug Width Calculations ===');
console.log('Button bounds:', button.bounds);
console.log('Button textContent length:', button.textContent?.length);
console.log('Button style minWidth:', button.style.minWidth);
console.log('Button style padding:', button.style.padding);
console.log('Button style border:', button.style.border);

// Check what our width calculation method returns
const renderer = (tom as any)._document._renderer;
const buttonWidth = renderer.getElementWidth(button);
console.log('Calculated button width:', buttonWidth);

setTimeout(() => {
  tty[Symbol.dispose]();
}, 3000);