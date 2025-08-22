/**
 * Debug button container height issue
 */

import { createTOM } from '../src/index.js';

function debugButtonContainerHeight() {
  console.log('🔍 Debugging button container height distribution...\n');
  
  const tom = createTOM();
  
  // Main container with fixed height
  const mainContainer = tom.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.backgroundColor = 'blue';
  mainContainer.style.padding = [1, 2, 1, 2];
  tom.body.appendChild(mainContainer);
  
  // Title text (takes some height)
  const title = tom.createElement('text');
  title.textContent = 'Title Text';
  title.style.color = 'white';
  title.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(title);
  
  // Button container
  const buttonContainer = tom.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.backgroundColor = 'green';
  buttonContainer.style.padding = [1, 1, 1, 1];
  mainContainer.appendChild(buttonContainer);
  
  // Add 3 buttons
  for (let i = 0; i < 3; i++) {
    const button = tom.createElement('button');
    button.textContent = `Button ${i + 1}`;
    button.style.backgroundColor = 'yellow';
    button.style.color = 'black';
    button.style.padding = [0, 2, 0, 2]; // Minimal vertical padding
    buttonContainer.appendChild(button);
  }
  
  // Status text (takes some height)
  const status = tom.createElement('text');
  status.textContent = 'Status Text';
  status.style.color = 'white';
  status.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(status);
  
  // Render and check heights
  tom.render();
  
  console.log('\nAfter render:');
  console.log('Main container bounds:', mainContainer.bounds);
  console.log('Title bounds:', title.bounds);
  console.log('Button container bounds:', buttonContainer.bounds);
  console.log('Status bounds:', status.bounds);
  
  console.log('\nButton heights:');
  for (let i = 0; i < buttonContainer.children.length; i++) {
    const button = buttonContainer.children[i];
    console.log(`  Button ${i + 1} bounds:`, button.bounds);
  }
  
  // Calculate how height is distributed
  const mainHeight = mainContainer.bounds.height;
  const mainPadding = 2; // top + bottom
  const contentHeight = mainHeight - mainPadding;
  const numChildren = mainContainer.children.length;
  const heightPerChild = Math.floor(contentHeight / numChildren);
  
  console.log('\nHeight calculations:');
  console.log(`  Main container height: ${mainHeight}`);
  console.log(`  Content height (minus padding): ${contentHeight}`);
  console.log(`  Number of children: ${numChildren}`);
  console.log(`  Height per child: ${heightPerChild}`);
  
  setTimeout(() => {
    tom.destroy();
    console.log('✅ Debug complete');
  }, 3000);
}

debugButtonContainerHeight();