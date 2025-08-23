/**
 * Debug Text Rendering - Add logging to see where TOMText fails
 */

import { createTTYWindow } from '../src/index.js';

function debugTextRendering() {
  console.log('🐛 Debug text rendering with logging...');
  
  const tty = createTTYWindow();
  
  // Temporarily patch TOMText.renderSelf to add logging
  const TOMText = (tty.document.createElement('text') as any).constructor;
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
  const container = tty.document.createElement('container');
  container.style.backgroundColor = 'blue';
  container.style.padding = [2, 2, 2, 2];
  tty.document.body.appendChild(container);
  
  const subContainer = tty.document.createElement('container');
  subContainer.style.flexDirection = 'column';
  subContainer.style.backgroundColor = 'green';
  subContainer.style.padding = [1, 1, 1, 1];
  container.appendChild(subContainer);
  
  const text1 = tty.document.createElement('text');
  text1.textContent = 'Direct child text';
  text1.style.backgroundColor = 'red';
  text1.style.color = 'white';
  container.appendChild(text1);
  
  const text2 = tty.document.createElement('text');
  text2.textContent = 'Sub-container text';
  text2.style.backgroundColor = 'yellow';
  text2.style.color = 'black';
  subContainer.appendChild(text2);
  
  console.log('\n🎨 Starting render...');
  tty.document.render();
  
  setTimeout(() => {
    // Restore original method
    TOMText.prototype.renderSelf = originalRenderSelf;
    tty[Symbol.dispose]();
    console.log('✅ Debug complete');
  }, 2000);
}

debugTextRendering();