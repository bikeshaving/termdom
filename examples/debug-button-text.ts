/**
 * Debug why button text isn't rendering
 */

import { createTOM } from '../src/index.js';

function debugButtonText() {
  console.log('🔍 Debugging button text rendering...\n');
  
  const tom = createTOM();
  
  // Simple container
  const container = tom.createElement('container');
  container.style.backgroundColor = 'blue';
  container.style.padding = [2, 2, 2, 2];
  tom.body.appendChild(container);
  
  // Create a button and check its rendering
  const button = tom.createElement('button');
  button.textContent = 'Test Button';
  button.style.backgroundColor = 'yellow';
  button.style.color = 'black';
  
  // Patch renderContent to see if it's called
  const originalRenderContent = (button as any).renderContent;
  (button as any).renderContent = function(buffer: any) {
    console.log('Button.renderContent called!');
    console.log('  textContent:', this.textContent);
    console.log('  bounds:', this.bounds);
    console.log('  contentArea:', this.getContentArea());
    
    // Call original
    return originalRenderContent.call(this, buffer);
  };
  
  container.appendChild(button);
  
  console.log('Before render:');
  console.log('  button.textContent:', button.textContent);
  console.log('  button.style:', button.style);
  
  tom.render();
  
  console.log('\nAfter render:');
  console.log('  button.bounds:', button.bounds);
  
  setTimeout(() => {
    tom.destroy();
    console.log('\n✅ Debug complete');
  }, 2000);
}

debugButtonText();