/**
 * Hello World - TOM's first working demo
 */

import { createTOM } from '../src/index.js';

function helloWorld() {
  console.log('🚀 Starting TOM Hello World...\n');
  
  // Create TOM document
  const tom = createTOM();
  
  // Create a simple text element
  const text = tom.createElement('text');
  text.textContent = 'Hello, Terminal Object Model! 🎯';
  
  // Add it to the document
  tom.body.appendChild(text);
  
  // Try to render
  console.log('📝 Created element:', text.tagName);
  console.log('📄 Text content:', text.textContent);
  console.log('🏗️  Element is instanceof TOMText:', text.constructor.name);
  
  // Force render
  tom.render();
  
  console.log('\n✅ Hello World complete!');
  
  // Clean up
  tom.destroy();
}

helloWorld();