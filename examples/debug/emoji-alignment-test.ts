/**
 * Emoji Alignment Test - Debug emoji positioning in containers
 */

import { createTTYWindow } from '../src/index.js';

function emojiAlignmentTest() {
  console.log('🔍 Testing emoji alignment in containers...\n');
  
  const tty = createTTYWindow();
  
  // Create a container with fixed width
  const container = tty.document.createElement('container');
  container.style.flexDirection = 'column';
  container.style.backgroundColor = 'blue';
  container.style.padding = [1, 1, 1, 1];
  tty.document.body.appendChild(container);
  
  // Test cases: with and without emojis
  const testCases = [
    { text: 'Normal text here', bg: 'red' },
    { text: '🚀 Emoji at start', bg: 'green' },
    { text: 'Emoji at end 🎯', bg: 'yellow' },
    { text: '🚀 Both ends 🎯', bg: 'cyan' },
    { text: 'Multiple 🚀🎯📄 emojis', bg: 'magenta' }
  ];
  
  for (const testCase of testCases) {
    const text = tty.document.createElement('text');
    text.textContent = testCase.text;
    text.style.backgroundColor = testCase.bg;
    text.style.color = 'black';
    text.style.padding = [0, 2, 0, 2]; // Extra padding to see alignment
    
    container.appendChild(text);
    
    console.log(`"${testCase.text}" - Width: ${Bun.stringWidth(testCase.text)}`);
  }
  
  console.log('\n🎨 Rendering with visible padding...\n');
  tty.document.render();
  
  console.log('\n📏 Each line should have equal padding on both sides');
  console.log('   If emojis cause misalignment, we\'ll see uneven edges');
  
  setTimeout(() => {
    tty[Symbol.dispose]();
  }, 100);
}

emojiAlignmentTest();