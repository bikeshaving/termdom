#!/usr/bin/env bun

/**
 * Debug textContent behavior
 */

import { createTOM } from '../src/index.js';

const tom = createTOM();

// Test textContent vs appendChild
const testContainer = tom.createElement('container');

const button1 = tom.createElement('button');
button1.textContent = 'Button1'; // Using textContent
console.log('Button1 after textContent:');
console.log('  childNodes.length:', button1.childNodes.length);
console.log('  children.length:', button1.children.length);
console.log('  textContent:', button1.textContent);

if (button1.childNodes.length > 0) {
  console.log('  First child node type:', button1.childNodes[0].nodeType);
  console.log('  First child textContent:', button1.childNodes[0].textContent);
}

const button2 = tom.createElement('button');
button2.appendChild(tom.createTextNode('Button2')); // Using appendChild
console.log('\nButton2 after appendChild:');
console.log('  childNodes.length:', button2.childNodes.length);
console.log('  children.length:', button2.children.length);
console.log('  textContent:', button2.textContent);

if (button2.childNodes.length > 0) {
  console.log('  First child node type:', button2.childNodes[0].nodeType);
  console.log('  First child textContent:', button2.childNodes[0].textContent);
}

// Test with text element too
const text1 = tom.createElement('text');
text1.textContent = 'Hello World';
console.log('\nText1 after textContent:');
console.log('  childNodes.length:', text1.childNodes.length);
console.log('  textContent:', text1.textContent);