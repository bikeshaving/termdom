/**
 * Test minimum size constraints
 */

import { createTTYWindow } from '../src/index.js';

function testMinSizes() {
  console.log('🔍 Testing minimum size constraints...\n');
  
  const tty = createTTYWindow();
  
  // Container with limited height
  const container = tty.document.createElement('container');
  container.style.flexDirection = 'column';
  container.style.backgroundColor = 'blue';
  container.style.padding = [1, 2, 1, 2];
  container.style.height = 20; // Fixed height to test constraints
  tty.document.body.appendChild(container);
  
  // Add many elements to test squeezing
  const elements = [
    { type: 'text', content: 'Title Text', bg: 'darkBlue' },
    { type: 'button', content: 'Button 1', bg: 'red' },
    { type: 'button', content: 'Button 2', bg: 'green' },
    { type: 'button', content: 'Button 3', bg: 'yellow' },
    { type: 'text', content: 'Status Text', bg: 'darkCyan' },
    { type: 'button', content: 'Button 4', bg: 'purple' },
    { type: 'button', content: 'Button 5', bg: 'orange' }
  ];
  
  elements.forEach((elem, i) => {
    const element = tty.document.createElement(elem.type as any);
    element.textContent = elem.content;
    element.style.backgroundColor = elem.bg;
    element.style.color = elem.type === 'button' && elem.bg === 'yellow' ? 'black' : 'white';
    
    console.log(`Adding ${elem.type} "${elem.content}" with minHeight: ${element.style.minHeight}`);
    container.appendChild(element);
  });
  
  tty.document.render();
  
  console.log('\nLayout results:');
  console.log(`Container height: ${container.bounds.height}`);
  console.log(`Container content height: ${container.bounds.height - 2}`); // minus padding
  
  let totalHeight = 0;
  for (let i = 0; i < container.children.length; i++) {
    const child = container.children[i] as any;
    console.log(`  ${elements[i].type} "${elements[i].content}": height=${child.bounds.height} (min=${child.style.minHeight || 0})`);
    totalHeight += child.bounds.height;
  }
  
  console.log(`\nTotal children height: ${totalHeight}`);
  console.log(`Space needed vs available: ${totalHeight} vs ${container.bounds.height - 2}`);
  
  if (totalHeight > container.bounds.height - 2) {
    console.log('⚠️  Content exceeds container - scrolling needed!');
  }
  
  setTimeout(() => {
    tty[Symbol.dispose]();
    console.log('\n✅ Test complete');
  }, 5000);
}

testMinSizes();