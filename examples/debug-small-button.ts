/**
 * Debug button text with minimal height
 */

import { createTOM } from '../src/index.js';

function debugSmallButton() {
  console.log('🔍 Debugging small button text...\n');
  
  const tom = createTOM();
  
  // Container with limited height
  const container = tom.createElement('container');
  container.style.backgroundColor = 'blue';
  container.style.padding = [1, 2, 1, 2];
  container.style.height = 10; // Limited height
  container.style.flexDirection = 'column';
  tom.body.appendChild(container);
  
  // Add 3 buttons to squeeze them
  for (let i = 0; i < 3; i++) {
    const button = tom.createElement('button');
    button.textContent = `Button ${i + 1}`;
    button.style.backgroundColor = i === 0 ? 'yellow' : 'gray';
    button.style.color = i === 0 ? 'black' : 'white';
    button.style.padding = [0, 2, 0, 2]; // Minimal vertical padding
    button.style.minHeight = 3; // Ensure min height
    container.appendChild(button);
  }
  
  tom.render();
  
  console.log('Container height:', container.bounds.height);
  console.log('Content area height:', container.bounds.height - 2);
  
  for (let i = 0; i < container.children.length; i++) {
    const button = container.children[i] as any;
    console.log(`\nButton ${i + 1}:`);
    console.log('  bounds:', button.bounds);
    console.log('  textContent:', button.textContent);
    console.log('  padding:', button.style.padding);
    console.log('  contentArea:', button.getContentArea());
  }
  
  setTimeout(() => {
    tom.destroy();
    console.log('\n✅ Debug complete');
  }, 3000);
}

debugSmallButton();