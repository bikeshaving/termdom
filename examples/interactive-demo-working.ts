/**
 * Working Interactive Demo - with proper button sizing
 */

import { createTOM } from '../src/index.js';

function interactiveDemoWorking() {
  console.log('🎮 Interactive TOM Demo (Working Version)\n');

  const tom = createTOM();

  // Create main container with minimal padding to maximize space
  const mainContainer = tom.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [1, 2, 1, 2]; // Reduced padding
  mainContainer.style.backgroundColor = 'blue';
  tom.body.appendChild(mainContainer);

  // Title - keep it small
  const title = tom.createElement('text');
  title.textContent = '🎮 Interactive TOM Demo';
  title.style.textAlign = 'center';
  title.style.color = 'white';
  title.style.padding = [0, 0, 0, 0]; // No padding
  mainContainer.appendChild(title);

  // Button container gets all remaining space
  const buttonContainer = tom.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.padding = [1, 0, 1, 0]; // Minimal padding
  buttonContainer.style.backgroundColor = 'darkBlue';
  mainContainer.appendChild(buttonContainer);

  // Create fewer buttons with smaller padding
  const buttons = [
    { text: '🚀 Launch', action: 'Launching!' },
    { text: '🎯 Target', action: 'Hit!' },
    { text: '❌ Exit', action: 'exit' }
  ];

  buttons.forEach((btn, index) => {
    const button = tom.createElement('button');
    button.textContent = btn.text;
    button.style.padding = [0, 2, 0, 2]; // Minimal vertical padding
    
    // Style first button as selected
    if (index === 0) {
      button.style.backgroundColor = 'yellow';
      button.style.color = 'black';
    } else {
      button.style.backgroundColor = 'gray';
      button.style.color = 'white';
    }
    
    buttonContainer.appendChild(button);
  });

  tom.render();
  
  // Log the actual heights
  console.log('Layout results:');
  console.log('Main container height:', mainContainer.bounds.height);
  console.log('Button container height:', buttonContainer.bounds.height);
  buttons.forEach((_, i) => {
    const button = buttonContainer.children[i];
    console.log(`Button ${i + 1} height:`, button.bounds.height);
  });

  setTimeout(() => {
    tom.destroy();
    console.log('\n✅ Demo complete');
  }, 5000);
}

interactiveDemoWorking();