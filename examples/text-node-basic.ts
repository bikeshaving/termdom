#!/usr/bin/env bun

/**
 * Test basic text node creation
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('Basic Text Node Test\n');

const tom = createTOM();

// Test createTextNode method
try {
  const textNode = tom.createTextNode('Hello from text node!');
  console.log('✅ createTextNode works');
  console.log('Text node type:', textNode.constructor.name);
  console.log('Text content:', textNode.textContent);
  console.log('Node type:', textNode.nodeType);
  
  // Try adding it to DOM
  tom.body.appendChild(textNode);
  console.log('✅ Text node added to DOM');
  console.log('Body children count:', tom.body.childNodes.length);
  
} catch (e) {
  console.log('❌ createTextNode failed:', e.message);
}

// Test mixed content
try {
  const container = tom.createElement('container');
  container.appendChild(tom.createTextNode('Start '));
  
  const boldText = tom.createElement('text');
  boldText.textContent = 'BOLD';
  boldText.style.fontWeight = 'bold';
  container.appendChild(boldText);
  
  container.appendChild(tom.createTextNode(' End'));
  tom.body.appendChild(container);
  
  console.log('✅ Mixed content created');
  console.log('Container children:', container.childNodes.length);
} catch (e) {
  console.log('❌ Mixed content failed:', e.message);
}

// Try to render (won't show text nodes yet, but shouldn't crash)
try {
  tom.render();
  console.log('✅ Render completed without errors');
} catch (e) {
  console.log('❌ Render failed:', e.message);
}

tom.destroy();