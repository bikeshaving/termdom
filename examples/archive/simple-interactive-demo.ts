/**
 * Simple Interactive Demo - Minimal version to debug layout
 */

import { createTOM } from '../src/index.js';

function simpleInteractiveDemo() {
  console.log('🎮 Simple Interactive Demo...');
  
  const tom = createTOM();
  
  // Main container
  const mainContainer = tom.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [2, 4, 2, 4];
  mainContainer.style.backgroundColor = 'blue';
  tom.body.appendChild(mainContainer);
  
  // Title
  const title = tom.createElement('text');
  title.textContent = '🎮 Simple Interactive Demo';
  title.style.textAlign = 'center';
  title.style.color = 'white';
  title.style.backgroundColor = 'darkBlue';
  title.style.padding = [1, 2, 1, 2];
  mainContainer.appendChild(title);
  
  // Button container
  const buttonContainer = tom.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.backgroundColor = 'darkGray'; // Add background to see the container
  buttonContainer.style.padding = [1, 1, 1, 1];
  mainContainer.appendChild(buttonContainer);
  
  // Create buttons
  const buttonData = [
    { text: '🚀 Button One', color: 'red' },
    { text: '🎯 Button Two', color: 'green' },
    { text: '📊 Button Three', color: 'blue' }
  ];
  
  for (const btnData of buttonData) {
    const button = tom.createElement('button');
    button.textContent = btnData.text;
    button.style.backgroundColor = btnData.color;
    button.style.color = 'white';
    button.style.margin = [0, 0, 1, 0]; // Bottom margin
    
    console.log('Adding button:', btnData.text);
    buttonContainer.appendChild(button);
  }
  
  // Status
  const status = tom.createElement('text');
  status.textContent = 'Status: Demo loaded';
  status.style.textAlign = 'center';
  status.style.color = 'yellow';
  status.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(status);
  
  console.log('Container children:', mainContainer.children.length);
  console.log('Button container children:', buttonContainer.children.length);
  
  tom.render();
  
  setTimeout(() => {
    tom.destroy();
    console.log('✅ Simple demo complete');
  }, 5000);
}

simpleInteractiveDemo();