#!/usr/bin/env bun

/**
 * Debug style application - where is 'block' coming from?
 */

import { createTTYWindow } from '../src/index.js';

const tty = createTTYWindow();

console.log('=== Style Debug Investigation ===\n');

// Test different elements
const button = tty.document.createElement('button');
const text = tty.document.createElement('text');
const container = tty.document.createElement('container');

console.log('1. Fresh elements (no style set):');
console.log('  Button display:', button.style.display);
console.log('  Text display:', text.style.display);
console.log('  Container display:', container.style.display);

console.log('\n2. After setting textContent:');
button.textContent = 'TEST';
console.log('  Button display after textContent:', button.style.display);

console.log('\n3. TOMButton default style check:');
// Check what the TOMButton constructor sets
const freshButton = tty.document.createElement('button');
console.log('  Fresh button internal _tomStyle:', (freshButton as any)._tomStyle);
console.log('  Fresh button style getter:', freshButton.style);

console.log('\n4. HappyDOM native style property check:');
console.log('  Button hasOwnProperty("style"):', button.hasOwnProperty('style'));
console.log('  Button native style:', (button as any).style); // Direct access bypassing getter
console.log('  Button instanceof Element:', button instanceof Element);

console.log('\n5. Check style inheritance chain:');
const proto = Object.getPrototypeOf(button);
console.log('  Button prototype:', proto.constructor.name);
console.log('  Button prototype style:', proto.style);

console.log('\n6. Check if HappyDOM Element has default styles:');
const rawElement = tty.document.createElement('div');
console.log('  Raw HappyDOM element style.display:', rawElement.style?.display);
console.log('  Raw HappyDOM element:', rawElement.constructor.name);