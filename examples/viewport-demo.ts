#!/usr/bin/env bun

/**
 * Demonstrate different viewport modes in TTY
 */

import { createTTY, BunTTYRuntime } from '../src/index.js';

// Example 1: Inline rendering demo
console.log('=== TTY Inline Demo ===');
console.log('This renders inline with your terminal content:\n');

const runtime1 = new BunTTYRuntime();
const { document: doc1, dispose: dispose1 } = createTTY({ runtime: runtime1 });

const progressBar = doc1.createElement('container');
progressBar.style.backgroundColor = 'green';
progressBar.style.padding = [1, 2, 1, 2];
progressBar.style.border = 1;

progressBar.appendChild(doc1.createTextNode('Progress: [████████████░░░░░░] 60%'));

doc1.body.appendChild(progressBar);

console.log('\nFlow mode rendered above - it flows with terminal output!');
console.log('You can continue using the terminal normally.\n');

// Clean up first demo
setTimeout(() => {
  dispose1();
  
  // Example 2: Window mode - fixed height box
  console.log('\n=== TTY Window Mode Demo ===');
  console.log('This creates a fixed-height window:\n');
  
  const runtime2 = new BunTTYRuntime();
  const { document: doc2, dispose: dispose2 } = createTTY({ runtime: runtime2 });
  
  const window = doc2.createElement('container');
  window.style.backgroundColor = 'blue';
  window.style.padding = [1, 2, 1, 2];
  window.style.border = 1;
  window.style.display = 'block'; // Use our new block display
  
  // Add scrollable content
  for (let i = 1; i <= 15; i++) {
    const item = doc2.createElement('container');
    item.style.setProperty('background-color', i % 2 === 0 ? 'cyan' : 'magenta');
    item.style.setProperty('padding', '1');
    item.appendChild(doc2.createTextNode(`Item ${i} - This is line ${i} of content`));
    window.appendChild(item);
  }
  
  doc2.body.appendChild(window);
  
  console.log('\nWindow mode rendered above - fixed 10-line height.');
  console.log('Content that exceeds height would need scrolling.\n');
  
  setTimeout(() => {
    dispose2();
    
    // Example 3: Full screen mode
    console.log('\n=== TTY Fullscreen Mode Demo ===');
    console.log('Press any key to see fullscreen mode...');
    
    process.stdin.setRawMode(true);
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      
      const runtime3 = new BunTTYRuntime();
      const { document: doc3, dispose: dispose3 } = createTTY({ runtime: runtime3 });
      
      const app = doc3.createElement('container');
      app.style.backgroundColor = 'darkblue';
      app.style.padding = [2, 4, 2, 4];
      
      const title = doc3.createElement('container');
      title.style.setProperty('background-color', 'yellow');
      title.style.setProperty('color', 'black');
      title.style.setProperty('padding', '2');
      title.appendChild(doc3.createTextNode('Fullscreen TTY Application'));
      
      const content = doc3.createElement('container');
      content.style.setProperty('margin-top', '2');
      content.appendChild(doc3.createTextNode(
        'This takes over the entire terminal screen.\n' +
        'Just like a traditional TUI application.\n\n' +
        'Press Escape to exit...'
      ));
      
      app.appendChild(title);
      app.appendChild(content);
      doc3.body.appendChild(app);
      
      
      // Exit on escape
      process.stdin.setRawMode(true);
      process.stdin.on('data', (data) => {
        if (data.toString() === '\x1b') {
          dispose3();
          process.exit(0);
        }
      });
    });
  }, 3000);
}, 2000);