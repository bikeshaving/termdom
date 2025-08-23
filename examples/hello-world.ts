/**
 * Hello World - TTY's first working demo
 */

import { createTTYWindow } from '../src/index.js';

function helloWorld() {
  console.log('🚀 Starting TTY Hello World...\n');
  
  // Create TTY window
  const tty = createTTYWindow();
  
  // Create a simple text element
  const text = tty.document.createElement('text');
  text.textContent = 'Hello, TTY Object Model! 🎯';
  
  // Add it to the document
  tty.document.body.appendChild(text);
  
  // Try to render
  console.log('📝 Created element:', text.tagName);
  console.log('📄 Text content:', text.textContent);
  console.log('🏗️  Element is instanceof TTYElement:', text.constructor.name);
  
  // Force render
  tty.document.render();
  
  console.log('\n✅ Hello World complete!');
  
  // Clean up
  tty[Symbol.dispose]();
}

helloWorld();