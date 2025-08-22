/**
 * Test with actual button elements
 */

import { createTOM } from '../src/index.js';

function testRealButtons() {
  console.log('🔍 Testing with actual button elements...\n');
  
  const tom = createTOM();
  
  // Main container
  const mainContainer = tom.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [2, 4, 2, 4];
  mainContainer.style.backgroundColor = 'blue';
  tom.body.appendChild(mainContainer);
  
  // Add some buttons
  const buttons = ['Button 1', 'Button 2', 'Button 3'];
  
  buttons.forEach((text, i) => {
    const button = tom.createElement('button');
    button.textContent = text;
    button.style.backgroundColor = i === 0 ? 'yellow' : 'gray';
    button.style.color = i === 0 ? 'black' : 'white';
    mainContainer.appendChild(button);
  });
  
  tom.render();
  
  setTimeout(() => {
    tom.destroy();
    console.log('✅ Test complete');
  }, 3000);
}

testRealButtons();