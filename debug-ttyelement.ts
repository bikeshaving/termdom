/**
 * Debug TTYElement vs HappyDOM elements
 */

import { createTTYWindow } from './src/index.js';
import { Window } from 'happy-dom';

console.log('=== Testing TTYElement vs HappyDOM Element ===');

// Test with pure HappyDOM
const window = new Window();
const happyDiv = window.document.createElement('div');
console.log('HappyDOM div.style:', typeof happyDiv.style, !!happyDiv.style);

// Test with TTY
const tty = createTTYWindow();
const ttyDiv = tty.document.createElement('div');
console.log('TTY div:', ttyDiv.constructor.name);
console.log('TTY div.style:', typeof ttyDiv.style, !!ttyDiv.style);

// Check prototype chain
console.log('TTY div prototype chain:');
let proto = Object.getPrototypeOf(ttyDiv);
while (proto && proto.constructor.name !== 'Object') {
  console.log(' -', proto.constructor.name);
  proto = Object.getPrototypeOf(proto);
}

tty[Symbol.dispose]();
window.close();