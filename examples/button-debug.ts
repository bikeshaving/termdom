/**
 * Button Debug - Test button rendering
 */

import { createTOM } from '../src/index.js';

function buttonDebugTest() {
  console.log('🔍 Testing button rendering...');
  
  const tom = createTOM();
  
  // Simple container
  const container = tom.createElement('container');
  container.style.flexDirection = 'column';
  container.style.backgroundColor = 'blue';
  container.style.padding = [2, 2, 2, 2];
  tom.body.appendChild(container);
  
  // Add a simple text element first
  const text = tom.createElement('text');
  text.textContent = 'This is a text element';
  text.style.color = 'white';
  text.style.backgroundColor = 'red';
  text.style.padding = [1, 1, 1, 1];
  container.appendChild(text);
  
  // Add a button
  const button = tom.createElement('button');
  button.textContent = 'Test Button';
  button.style.backgroundColor = 'green';
  button.style.color = 'white';
  button.style.padding = [1, 2, 1, 2];
  container.appendChild(button);
  
  // Add another text after
  const text2 = tom.createElement('text');
  text2.textContent = 'Text after button';
  text2.style.color = 'yellow';
  text2.style.backgroundColor = 'purple';
  text2.style.padding = [1, 1, 1, 1];
  container.appendChild(text2);
  
  console.log('Elements created:');
  console.log('- Text:', text.constructor.name);
  console.log('- Button:', button.constructor.name);
  console.log('- Text2:', text2.constructor.name);
  
  console.log('\nButton focusable:', button.tomIsFocusable());
  console.log('Button bounds:', button.bounds);
  
  tom.render();
  
  setTimeout(() => {
    tom.destroy();
    console.log('✅ Debug test complete');
  }, 3000);
}

buttonDebugTest();