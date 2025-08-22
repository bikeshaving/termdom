/**
 * Simple event test to debug KeyboardEvent issue
 */

import { createTOM } from '../src/index.js';

function eventTest() {
  console.log('🧪 Testing event creation...');
  
  const tom = createTOM();
  
  try {
    // Test event creation
    console.log('Window:', typeof tom.document);
    console.log('KeyboardEvent:', typeof tom.document.window?.KeyboardEvent);
    
    // Create a button
    const button = tom.createElement('button');
    button.textContent = 'Test Button';
    tom.body.appendChild(button);
    
    // Add event listener
    button.addEventListener('click', () => {
      console.log('Button clicked!');
    });
    
    console.log('✅ Basic setup working');
    
    // Try to enable input mode
    tom.enableInputMode();
    console.log('✅ Input mode enabled');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    tom.destroy();
  }
}

eventTest();