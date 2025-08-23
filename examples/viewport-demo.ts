#!/usr/bin/env bun

/**
 * Demonstrate different viewport modes in TTY
 */

import { createTTYWindow, createTTYFlow } from '../src/core/createTTY.js';

// Example 1: Flow mode - renders inline with terminal content
console.log('=== TTY Flow Mode Demo ===');
console.log('This renders inline with your terminal content:\n');

const flowTTY = createTTYFlow({ width: 40 });

const progressBar = flowTTY.document.createElement('container');
progressBar.style.backgroundColor = 'green';
progressBar.style.padding = [1, 2, 1, 2];
progressBar.style.border = 1;

progressBar.appendChild(flowTTY.document.createTextNode('Progress: [████████████░░░░░░] 60%'));

flowTTY.document.body.appendChild(progressBar);
flowTTY.document.render();

console.log('\nFlow mode rendered above - it flows with terminal output!');
console.log('You can continue using the terminal normally.\n');

// Clean up flow
setTimeout(() => {
  flowTTY[Symbol.dispose]();
  
  // Example 2: Window mode - fixed height box
  console.log('\n=== TTY Window Mode Demo ===');
  console.log('This creates a fixed-height window:\n');
  
  const windowTTY = createTTYWindow({ height: 10, width: 50 });
  
  const window = windowTTY.document.createElement('container');
  window.style.backgroundColor = 'blue';
  window.style.padding = [1, 2, 1, 2];
  window.style.border = 1;
  window.style.display = 'block'; // Use our new block display
  
  // Add scrollable content
  for (let i = 1; i <= 15; i++) {
    const item = windowTTY.document.createElement('container');
    item.style.backgroundColor = i % 2 === 0 ? 'cyan' : 'magenta';
    item.style.padding = [0, 1, 0, 1];
    item.appendChild(windowTTY.document.createTextNode(`Item ${i} - This is line ${i} of content`));
    window.appendChild(item);
  }
  
  windowTTY.document.body.appendChild(window);
  windowTTY.document.render();
  
  console.log('\nWindow mode rendered above - fixed 10-line height.');
  console.log('Content that exceeds height would need scrolling.\n');
  
  setTimeout(() => {
    windowTTY[Symbol.dispose]();
    
    // Example 3: Full screen mode
    console.log('\n=== TTY Fullscreen Mode Demo ===');
    console.log('Press any key to see fullscreen mode...');
    
    process.stdin.setRawMode(true);
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      
      const fullTTY = createTTYWindow();
      
      const app = fullTTY.document.createElement('container');
      app.style.backgroundColor = 'darkblue';
      app.style.padding = [2, 4, 2, 4];
      
      const title = fullTTY.document.createElement('container');
      title.style.backgroundColor = 'yellow';
      title.style.color = 'black';
      title.style.padding = [1, 2, 1, 2];
      title.appendChild(fullTTY.document.createTextNode('Fullscreen TTY Application'));
      
      const content = fullTTY.document.createElement('container');
      content.style.marginTop = 2;
      content.appendChild(fullTTY.document.createTextNode(
        'This takes over the entire terminal screen.\n' +
        'Just like a traditional TUI application.\n\n' +
        'Press Escape to exit...'
      ));
      
      app.appendChild(title);
      app.appendChild(content);
      fullTTY.document.body.appendChild(app);
      
      fullTTY.document.render();
      
      // Exit on escape
      process.stdin.setRawMode(true);
      process.stdin.on('data', (data) => {
        if (data.toString() === '\x1b') {
          fullTTY[Symbol.dispose]();
          process.exit(0);
        }
      });
    });
  }, 3000);
}, 2000);