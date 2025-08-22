#!/usr/bin/env bun

/**
 * Debug what happens with textContent
 */

import { createTOM } from '../src/index.js';

const tom = createTOM();

// Check what methods are available
console.log('=== TOM Document Methods ===');
console.log('tom.document.createTextNode:', typeof tom.document.createTextNode);
console.log('tom.window.document.createTextNode:', typeof tom.window.document.createTextNode);

// Try creating a text node directly through HappyDOM
try {
  const textNode = tom.window.document.createTextNode('Hello from text node');
  console.log('✅ HappyDOM createTextNode works');
  console.log('Text node type:', textNode.constructor.name);
  console.log('Text node content:', textNode.textContent);
} catch (e) {
  console.log('❌ HappyDOM createTextNode failed:', e.message);
}

// Test what happens when we set textContent
const container = tom.createElement('container');
console.log('\n=== Before textContent ===');
console.log('Container children:', container.childNodes.length);

container.textContent = 'Hello World';
console.log('\n=== After textContent ===');
console.log('Container children:', container.childNodes.length);
console.log('First child type:', container.childNodes[0]?.constructor.name);
console.log('First child content:', container.childNodes[0]?.textContent);

tom.body.appendChild(container);
tom.render();