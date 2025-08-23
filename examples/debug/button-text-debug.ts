/**
 * Debug button text rendering specifically
 */

import { createTTYWindow } from '../src/index.js';

function buttonTextDebug() {
  console.log('🔍 Debug button text rendering...');
  
  const tty = createTTYWindow();
  
  // Simple setup
  const container = tty.document.createElement('container');
  container.style.backgroundColor = 'blue';
  container.style.padding = [2, 2, 2, 2];
  tty.document.body.appendChild(container);
  
  const button = tty.document.createElement('button');
  button.textContent = 'HELLO';
  button.style.backgroundColor = 'red';
  button.style.color = 'white';
  button.style.padding = [2, 4, 2, 4]; // Larger padding
  container.appendChild(button);
  
  console.log('Button textContent:', button.textContent);
  console.log('Button bounds after layout:', button.bounds);
  
  // Check what the button extends
  console.log('Button is TOMContainer:', button.constructor.name);
  console.log('Button style:', button.style);
  
  tty.document.render();
  
  setTimeout(() => {
    console.log('Button bounds after render:', button.bounds);
    tty[Symbol.dispose]();
  }, 2000);
}

buttonTextDebug();