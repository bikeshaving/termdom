/**
 * Test HappyDOM's getComputedStyle functionality
 */

import { createTTYWindow } from './src/index.js';

const tty = createTTYWindow();

// Create an element
const element = tty.document.createElement('div');
element.style.setProperty('color', 'red');
element.style.setProperty('background-color', 'blue');

tty.document.body.appendChild(element);

// Test getComputedStyle
const computedStyle = tty.getComputedStyle(element);

console.log('✅ getComputedStyle works!');
console.log('Color:', computedStyle.getPropertyValue('color'));
console.log('Background:', computedStyle.getPropertyValue('background-color'));
console.log('Display (default):', computedStyle.getPropertyValue('display'));

tty[Symbol.dispose]();