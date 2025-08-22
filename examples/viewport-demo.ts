#!/usr/bin/env bun

/**
 * Demonstrate different viewport modes in TOM
 */

import { createTOM, createTOMFlow, createTOMWindow } from '../src/core/createTOM.js';

// Example 1: Flow mode - renders inline with terminal content
console.log('=== TOM Flow Mode Demo ===');
console.log('This renders inline with your terminal content:\n');

const flowTOM = createTOMFlow({ width: 40 });

const progressBar = flowTOM.createElement('container');
progressBar.style.backgroundColor = 'green';
progressBar.style.padding = [1, 2, 1, 2];
progressBar.style.border = 1;

progressBar.appendChild(flowTOM.createTextNode('Progress: [████████████░░░░░░] 60%'));

flowTOM.body.appendChild(progressBar);
flowTOM.render();

console.log('\nFlow mode rendered above - it flows with terminal output!');
console.log('You can continue using the terminal normally.\n');

// Clean up flow
setTimeout(() => {
  flowTOM.destroy();
  
  // Example 2: Window mode - fixed height box
  console.log('\n=== TOM Window Mode Demo ===');
  console.log('This creates a fixed-height window:\n');
  
  const windowTOM = createTOMWindow({ height: 10, width: 50 });
  
  const window = windowTOM.createElement('container');
  window.style.backgroundColor = 'blue';
  window.style.padding = [1, 2, 1, 2];
  window.style.border = 1;
  window.style.display = 'block'; // Use our new block display
  
  // Add scrollable content
  for (let i = 1; i <= 15; i++) {
    const item = windowTOM.createElement('container');
    item.style.backgroundColor = i % 2 === 0 ? 'cyan' : 'magenta';
    item.style.padding = [0, 1, 0, 1];
    item.appendChild(windowTOM.createTextNode(`Item ${i} - This is line ${i} of content`));
    window.appendChild(item);
  }
  
  windowTOM.body.appendChild(window);
  windowTOM.render();
  
  console.log('\nWindow mode rendered above - fixed 10-line height.');
  console.log('Content that exceeds height would need scrolling.\n');
  
  setTimeout(() => {
    windowTOM.destroy();
    
    // Example 3: Full screen mode
    console.log('\n=== TOM Fullscreen Mode Demo ===');
    console.log('Press any key to see fullscreen mode...');
    
    process.stdin.setRawMode(true);
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      
      const fullTOM = createTOM();
      
      const app = fullTOM.createElement('container');
      app.style.backgroundColor = 'darkblue';
      app.style.padding = [2, 4, 2, 4];
      
      const title = fullTOM.createElement('container');
      title.style.backgroundColor = 'yellow';
      title.style.color = 'black';
      title.style.padding = [1, 2, 1, 2];
      title.appendChild(fullTOM.createTextNode('Fullscreen TOM Application'));
      
      const content = fullTOM.createElement('container');
      content.style.marginTop = 2;
      content.appendChild(fullTOM.createTextNode(
        'This takes over the entire terminal screen.\n' +
        'Just like a traditional TUI application.\n\n' +
        'Press Escape to exit...'
      ));
      
      app.appendChild(title);
      app.appendChild(content);
      fullTOM.body.appendChild(app);
      
      fullTOM.render();
      
      // Exit on escape
      process.stdin.setRawMode(true);
      process.stdin.on('data', (data) => {
        if (data.toString() === '\x1b') {
          fullTOM.destroy();
          process.exit(0);
        }
      });
    });
  }, 3000);
}, 2000);