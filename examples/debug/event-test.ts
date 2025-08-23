/**
 * Simple event test to debug KeyboardEvent issue
 */

import { createTTYWindow } from '../src/index.js';

function eventTest() {
  console.log('🧪 Testing event creation...');
  
  const tty = createTTYWindow();
  
  try {
    // Test event creation
    console.log('Window:', typeof tty.document);
    console.log('KeyboardEvent:', typeof tty.document.window?.KeyboardEvent);
    
    // Create a button
    const button = tty.document.createElement('button');
    button.textContent = 'Test Button';
    tty.document.body.appendChild(button);
    
    // Add event listener
    button.addEventListener('click', () => {
      console.log('Button clicked!');
    });
    
    console.log('✅ Basic setup working');
    
    // Try to enable input mode
    tty.enableInputMode();
    console.log('✅ Input mode enabled');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    tty[Symbol.dispose]();
  }
}

eventTest();