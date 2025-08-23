/**
 * Button Container Isolation Test
 * 
 * Test just the button container structure from the interactive demo
 * to see why text elements aren't rendering inside it.
 */

import { createTTYWindow } from '../src/index.js';

function buttonContainerTest() {
  console.log('🔍 Testing button container isolation...');
  
  const tty = createTTYWindow();
  
  // Main container (same as interactive demo)
  const mainContainer = tty.document.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [2, 4, 2, 4];
  mainContainer.style.backgroundColor = 'blue';
  tty.document.body.appendChild(mainContainer);
  
  // Before container - to prove main container works
  const beforeText = tty.document.createElement('text');
  beforeText.textContent = 'BEFORE: This text should show';
  beforeText.style.color = 'white';
  beforeText.style.backgroundColor = 'red';
  beforeText.style.padding = [1, 1, 1, 1];
  mainContainer.appendChild(beforeText);
  
  // Button container (exact copy from interactive demo)
  const buttonContainer = tty.document.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.padding = [1, 0, 1, 0];
  buttonContainer.style.backgroundColor = 'green'; // Add visible background
  mainContainer.appendChild(buttonContainer);
  
  console.log('Button container created');
  
  // Add text elements to button container (same as interactive demo)
  const buttons = [
    { text: '🚀 Launch Something' },
    { text: '🎯 Hit Target' },
    { text: '📊 Show Stats' }
  ];
  
  buttons.forEach((btn, index) => {
    const button = tty.document.createElement('text');
    button.textContent = btn.text;
    button.style.padding = [1, 2, 1, 2];
    button.style.textAlign = 'center';
    button.style.backgroundColor = 'yellow';
    button.style.color = 'black';
    
    console.log(`Adding button ${index}: "${btn.text}"`);
    console.log('Button bounds before adding:', button.bounds);
    
    buttonContainer.appendChild(button);
    
    console.log('Button added to container');
  });
  
  // After container - to prove main container still works
  const afterText = tty.document.createElement('text');
  afterText.textContent = 'AFTER: This text should show';
  afterText.style.color = 'white';
  afterText.style.backgroundColor = 'purple';
  afterText.style.padding = [1, 1, 1, 1];
  mainContainer.appendChild(afterText);
  
  console.log('All elements added');
  console.log('Main container children:', mainContainer.children.length);
  console.log('Button container children:', buttonContainer.children.length);
  
  // Render and check bounds
  tty.document.render();
  
  console.log('\nAfter render:');
  console.log('Button container bounds:', buttonContainer.bounds);
  
  buttons.forEach((btn, index) => {
    const buttonElement = buttonContainer.children[index];
    console.log(`Button ${index} bounds:`, buttonElement.bounds);
    console.log(`Button ${index} textContent:`, buttonElement.textContent);
  });
  
  setTimeout(() => {
    tty[Symbol.dispose]();
    console.log('✅ Button container test complete');
  }, 3000);
}

buttonContainerTest();