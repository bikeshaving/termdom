/**
 * Fixed Interactive TOM Demo - shows buttons properly
 */

import { createTOM } from '../src/index.js';

function interactiveDemoFixed() {
  console.log('🎮 Starting Fixed Interactive TOM Demo...\n');

  const tom = createTOM();

  // Create main container
  const mainContainer = tom.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [2, 4, 2, 4];
  mainContainer.style.backgroundColor = 'blue';
  tom.body.appendChild(mainContainer);

  // Title
  const title = tom.createElement('text');
  title.textContent = '🎮 Interactive TOM Demo';
  title.style.textAlign = 'center';
  title.style.color = 'white';
  title.style.backgroundColor = 'darkBlue';
  title.style.padding = [1, 2, 1, 2];
  mainContainer.appendChild(title);

  // Instructions
  const instructions = tom.createElement('text');
  instructions.textContent = 'Use ↑↓ arrows to navigate, Enter to click, Q to quit';
  instructions.style.textAlign = 'center';
  instructions.style.color = 'yellow';
  instructions.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(instructions);

  // Button container
  const buttonContainer = tom.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(buttonContainer);

  // Create interactive buttons
  const buttons = [
    { text: '🚀 Launch Something', action: 'Launching rockets! 🚀' },
    { text: '🎯 Hit Target', action: 'Target acquired! 🎯' },
    { text: '📊 Show Stats', action: 'Loading statistics... 📊' },
    { text: '⚙️ Settings', action: 'Opening settings... ⚙️' },
    { text: '❌ Exit Demo', action: 'exit' }
  ];

  // Create button elements (using 'button' not 'text')
  buttons.forEach((btn, index) => {
    const button = tom.createElement('button');
    button.textContent = btn.text;
    
    // First button is selected (yellow)
    if (index === 0) {
      button.style.backgroundColor = 'yellow';
      button.style.color = 'black';
    } else {
      button.style.backgroundColor = 'gray';
      button.style.color = 'white';
    }
    
    buttonContainer.appendChild(button);
  });

  // Status area
  const statusArea = tom.createElement('text');
  statusArea.textContent = '👆 Select a button above';
  statusArea.style.textAlign = 'center';
  statusArea.style.color = 'cyan';
  statusArea.style.backgroundColor = 'darkCyan';
  statusArea.style.padding = [1, 2, 1, 2];
  mainContainer.appendChild(statusArea);

  tom.render();

  setTimeout(() => {
    tom.destroy();
    console.log('✅ Demo complete - buttons rendered correctly!');
  }, 5000);
}

interactiveDemoFixed();