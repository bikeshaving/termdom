/**
 * Debug HappyDOM element creation to see what has style property
 */

import { Window } from 'happy-dom';

const window = new Window();
const document = window.document;

console.log('=== Testing HappyDOM element types ===');

// Test standard HTML elements
const div = document.createElement('div');
console.log('div.style:', typeof div.style, div.style);

const span = document.createElement('span');  
console.log('span.style:', typeof span.style, span.style);

// Test our custom element
const custom = document.createElement('custom');
console.log('custom.style:', typeof custom.style, custom.style);

// Test getComputedStyle
const computedStyle = window.getComputedStyle(div);
console.log('getComputedStyle:', typeof computedStyle, computedStyle.constructor.name);

// Test if we can set properties
if (div.style && div.style.setProperty) {
  div.style.setProperty('color', 'red');
  console.log('div.style.getPropertyValue("color"):', div.style.getPropertyValue('color'));
}

window.close();