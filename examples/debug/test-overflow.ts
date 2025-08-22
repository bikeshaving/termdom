/**
 * Test overflow scenario where content exceeds container
 */

import { createTOM } from '../src/index.js';

function testOverflow() {
  console.log('🔍 Testing overflow scenario...\n');
  
  const tom = createTOM();
  
  // Small container with many buttons
  const container = tom.createElement('container');
  container.style.flexDirection = 'column';
  container.style.backgroundColor = 'blue';
  container.style.padding = [1, 2, 1, 2];
  container.style.height = 15; // Very limited height
  tom.body.appendChild(container);
  
  // Add many buttons that won't fit
  for (let i = 1; i <= 8; i++) {
    const button = tom.createElement('button');
    button.textContent = `Button ${i}`;
    button.style.backgroundColor = i === 1 ? 'yellow' : 'gray';
    button.style.color = i === 1 ? 'black' : 'white';
    
    container.appendChild(button);
  }
  
  tom.render();
  
  console.log('\nLayout analysis:');
  console.log(`Container height: ${container.bounds.height}`);
  console.log(`Content area height: ${container.bounds.height - 2}`);
  
  let totalMinHeight = 0;
  let actualTotalHeight = 0;
  
  for (let i = 0; i < container.children.length; i++) {
    const child = container.children[i] as any;
    totalMinHeight += (child.style.minHeight || 0);
    actualTotalHeight += child.bounds.height;
    console.log(`  Button ${i + 1}: height=${child.bounds.height} (min=${child.style.minHeight})`);
  }
  
  console.log(`\nMinimum height needed: ${totalMinHeight}`);
  console.log(`Actual total height: ${actualTotalHeight}`);
  console.log(`Available space: ${container.bounds.height - 2}`);
  
  if (totalMinHeight > container.bounds.height - 2) {
    console.log('\n⚠️  Content minimum sizes exceed container!');
    console.log('   This is where we need scrolling support.');
  }
  
  setTimeout(() => {
    tom.destroy();
    console.log('\n✅ Test complete');
  }, 5000);
}

testOverflow();