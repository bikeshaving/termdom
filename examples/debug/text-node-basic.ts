#!/usr/bin/env bun

/**
 * Test basic text node creation
 */

import { createTTYWindow } from '../src/index.js';

console.clear();
console.log('Basic Text Node Test\n');

const tty = createTTYWindow();

// Test createTextNode method
try {
  const textNode = tty.document.createTextNode('Hello from text node!');
  console.log('✅ createTextNode works');
  console.log('Text node type:', textNode.constructor.name);
  console.log('Text content:', textNode.textContent);
  console.log('Node type:', textNode.nodeType);
  
  // Try adding it to DOM
  tty.document.body.appendChild(textNode);
  console.log('✅ Text node added to DOM');
  console.log('Body children count:', tty.document.body.childNodes.length);
  
} catch (e) {
  console.log('❌ createTextNode failed:', e.message);
}

// Test mixed content
try {
  const container = tty.document.createElement('container');
  container.appendChild(tty.document.createTextNode('Start '));
  
  const boldText = tty.document.createElement('text');
  boldText.textContent = 'BOLD';
  boldText.style.fontWeight = 'bold';
  container.appendChild(boldText);
  
  container.appendChild(tty.document.createTextNode(' End'));
  tty.document.body.appendChild(container);
  
  console.log('✅ Mixed content created');
  console.log('Container children:', container.childNodes.length);
} catch (e) {
  console.log('❌ Mixed content failed:', e.message);
}

// Try to render (won't show text nodes yet, but shouldn't crash)
try {
  tty.document.render();
  console.log('✅ Render completed without errors');
} catch (e) {
  console.log('❌ Render failed:', e.message);
}

tty[Symbol.dispose]();