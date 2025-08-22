/**
 * Final Interactive TOM Demo - with proper button elements and minimum sizes
 */

import { createTOM } from '../src/index.js';

function interactiveDemoFinal() {
  console.log('🎮 Interactive TOM Demo with Minimum Sizes\n');

  const tom = createTOM();

  // Create main container
  const mainContainer = tom.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [1, 2, 1, 2];
  mainContainer.style.backgroundColor = 'blue';
  tom.body.appendChild(mainContainer);

  // Title (compact)
  const title = tom.createElement('text');
  title.textContent = '🎮 Interactive TOM Demo';
  title.style.textAlign = 'center';
  title.style.color = 'white';
  title.style.backgroundColor = 'darkBlue';
  title.style.padding = [0, 2, 0, 2];
  mainContainer.appendChild(title);

  // Instructions (compact)
  const instructions = tom.createElement('text');
  instructions.textContent = 'Arrow keys: navigate | Enter: click | Q: quit';
  instructions.style.textAlign = 'center';
  instructions.style.color = 'yellow';
  instructions.style.padding = [0, 0, 1, 0];
  mainContainer.appendChild(instructions);

  // Button container
  const buttonContainer = tom.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.backgroundColor = 'darkBlue';
  buttonContainer.style.padding = [0, 0, 0, 0]; // No padding to maximize space
  mainContainer.appendChild(buttonContainer);

  // Create buttons with proper button elements
  const buttons = [
    { text: '🚀 Launch Something', action: 'Launching rockets! 🚀' },
    { text: '🎯 Hit Target', action: 'Target acquired! 🎯' },
    { text: '📊 Show Stats', action: 'Loading statistics... 📊' },
    { text: '❌ Exit Demo', action: 'exit' }
  ];

  buttons.forEach((btn, index) => {
    const button = tom.createElement('button');
    button.textContent = btn.text;
    button.style.padding = [0, 2, 0, 2]; // Minimal vertical padding
    
    // First button is selected
    if (index === 0) {
      button.style.backgroundColor = 'yellow';
      button.style.color = 'black';
      button.style.borderColor = 'green'; // Focus indicator
    } else {
      button.style.backgroundColor = 'gray';
      button.style.color = 'white';
    }
    
    buttonContainer.appendChild(button);
  });

  // Status area (compact)
  const statusArea = tom.createElement('text');
  statusArea.textContent = '👆 Ready';
  statusArea.style.textAlign = 'center';
  statusArea.style.color = 'cyan';
  statusArea.style.padding = [1, 0, 0, 0];
  mainContainer.appendChild(statusArea);

  tom.render();
  
  // Show layout info
  console.log('Layout info:');
  console.log(`- Terminal height: 24 cells (typical)`);
  console.log(`- Main container height: ${mainContainer.bounds.height} cells`);
  console.log(`- Buttons container height: ${buttonContainer.bounds.height} cells`);
  console.log(`- Each button min height: 3 cells`);
  
  // Note about future improvements
  console.log('\n📝 Note: With scrolling support, we could fit unlimited buttons!');

  setTimeout(() => {
    tom.destroy();
    console.log('\n✅ Demo complete - buttons rendered with minimum sizes!');
  }, 5000);
}

interactiveDemoFinal();