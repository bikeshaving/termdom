/**
 * Debug button layout issue
 */

import { createTOM } from '../src/index.js';

function debugButtonLayout() {
  console.log('🔍 Debugging button layout...\n');
  
  const tom = createTOM();
  
  // Simple container with visible background
  const container = tom.createElement('container');
  container.style.backgroundColor = 'blue';
  container.style.padding = [2, 2, 2, 2];
  container.style.flexDirection = 'column';
  tom.body.appendChild(container);
  
  // Add a single button
  const button = tom.createElement('button');
  button.textContent = 'Test Button';
  button.style.backgroundColor = 'yellow';
  button.style.color = 'black';
  console.log('Button before adding to container:', {
    textContent: button.textContent,
    style: button.style,
    bounds: button.bounds
  });
  
  container.appendChild(button);
  
  console.log('Container children:', container.children.length);
  console.log('Button parent:', button.parentElement?.tagName);
  
  // Force layout and render
  tom.render();
  
  console.log('\nAfter render:');
  console.log('Container bounds:', container.bounds);
  console.log('Button bounds:', button.bounds);
  console.log('Button textContent:', button.textContent);
  
  // Check if button's renderSelf is called
  const originalRenderSelf = button.renderSelf.bind(button);
  button.renderSelf = function(buffer: any) {
    console.log('Button.renderSelf called!');
    console.log('  bounds:', this.bounds);
    console.log('  textContent:', this.textContent);
    return originalRenderSelf(buffer);
  };
  
  // Re-render to see if renderSelf is called
  console.log('\n--- Re-rendering to check if renderSelf is called ---');
  tom.render();
  
  setTimeout(() => {
    tom.destroy();
    console.log('✅ Debug complete');
  }, 3000);
}

debugButtonLayout();