/**
 * Emoji Width Test - Debug emoji rendering issues
 */

import { createTTYWindow } from '../src/index.js';

function emojiTest() {
  console.log('🧪 Testing emoji width handling...\n');
  
  const tty = createTTYWindow();
  
  // Test different emoji scenarios
  const testCases = [
    'Hello 🚀',
    '🎯 Target',
    '📄 Document',
    '🚀🎯📄',
    'Normal text only',
    'Mixed: 🚀 text 🎯 more 📄'
  ];
  
  for (let i = 0; i < testCases.length; i++) {
    const text = tty.document.createElement('text');
    text.textContent = testCases[i];
    text.style.backgroundColor = i % 2 === 0 ? 'blue' : 'green';
    text.style.color = 'white';
    text.style.padding = [0, 1, 0, 1];
    
    tty.document.body.appendChild(text);
    
    console.log(`Test ${i + 1}: "${testCases[i]}" (width: ${Bun.stringWidth(testCases[i])})`);
  }
  
  console.log('\n🎨 Rendering...\n');
  tty.document.render();
  
  console.log('\n✅ Emoji test complete!');
  
  setTimeout(() => {
    tty[Symbol.dispose]();
  }, 100);
}

emojiTest();