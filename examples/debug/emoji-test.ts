/**
 * Emoji Width Test - Debug emoji rendering issues
 */

import { createTOM } from '../src/index.js';

function emojiTest() {
  console.log('🧪 Testing emoji width handling...\n');
  
  const tom = createTOM();
  
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
    const text = tom.createElement('text');
    text.textContent = testCases[i];
    text.style.backgroundColor = i % 2 === 0 ? 'blue' : 'green';
    text.style.color = 'white';
    text.style.padding = [0, 1, 0, 1];
    
    tom.body.appendChild(text);
    
    console.log(`Test ${i + 1}: "${testCases[i]}" (width: ${Bun.stringWidth(testCases[i])})`);
  }
  
  console.log('\n🎨 Rendering...\n');
  tom.render();
  
  console.log('\n✅ Emoji test complete!');
  
  setTimeout(() => {
    tom.destroy();
  }, 100);
}

emojiTest();