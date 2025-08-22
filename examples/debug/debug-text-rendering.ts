/**
 * Debug Text Rendering - Add logging to see where TOMText fails
 */

import { createTOM } from '../src/index.js';

function debugTextRendering() {
  console.log('🐛 Debug text rendering with logging...');
  
  const tom = createTOM();
  
  // Temporarily patch TOMText.renderSelf to add logging
  const TOMText = (tom.createElement('text') as any).constructor;
  const originalRenderSelf = TOMText.prototype.renderSelf;
  
  TOMText.prototype.renderSelf = function(buffer: any) {
    const bounds = this.bounds;
    const content = this.textContent || '';
    
    console.log(`\n🔍 TOMText.renderSelf called:`);
    console.log(`  Content: "${content}"`);
    console.log(`  Bounds:`, bounds);
    console.log(`  Has content: ${!!content}`);
    console.log(`  Size valid: ${bounds.width > 0 && bounds.height > 0}`);
    
    if (!content || bounds.width <= 0 || bounds.height <= 0) {
      console.log(`  ❌ Skipping render: no content or invalid size`);
      return;
    }
    
    console.log(`  ✅ Proceeding with render...`);
    
    // Call original method
    return originalRenderSelf.call(this, buffer);
  };
  
  // Test setup
  const container = tom.createElement('container');
  container.style.backgroundColor = 'blue';
  container.style.padding = [2, 2, 2, 2];
  tom.body.appendChild(container);
  
  const subContainer = tom.createElement('container');
  subContainer.style.flexDirection = 'column';
  subContainer.style.backgroundColor = 'green';
  subContainer.style.padding = [1, 1, 1, 1];
  container.appendChild(subContainer);
  
  const text1 = tom.createElement('text');
  text1.textContent = 'Direct child text';
  text1.style.backgroundColor = 'red';
  text1.style.color = 'white';
  container.appendChild(text1);
  
  const text2 = tom.createElement('text');
  text2.textContent = 'Sub-container text';
  text2.style.backgroundColor = 'yellow';
  text2.style.color = 'black';
  subContainer.appendChild(text2);
  
  console.log('\n🎨 Starting render...');
  tom.render();
  
  setTimeout(() => {
    // Restore original method
    TOMText.prototype.renderSelf = originalRenderSelf;
    tom.destroy();
    console.log('✅ Debug complete');
  }, 2000);
}

debugTextRendering();