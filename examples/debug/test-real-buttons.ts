/**
 * Test with actual button elements
 */

import { createTTYWindow } from '../src/index.js';

function testRealButtons() {
  console.log('🔍 Testing with actual button elements...\n');
  
  const tty = createTTYWindow();
  
  // Main container
  const mainContainer = tty.document.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [2, 4, 2, 4];
  mainContainer.style.backgroundColor = 'blue';
  tty.document.body.appendChild(mainContainer);
  
  // Add some buttons
  const buttons = ['Button 1', 'Button 2', 'Button 3'];
  
  buttons.forEach((text, i) => {
    const button = tty.document.createElement('button');
    button.textContent = text;
    button.style.backgroundColor = i === 0 ? 'yellow' : 'gray';
    button.style.color = i === 0 ? 'black' : 'white';
    mainContainer.appendChild(button);
  });
  
  tty.document.render();
  
  setTimeout(() => {
    tty[Symbol.dispose]();
    console.log('✅ Test complete');
  }, 3000);
}

testRealButtons();