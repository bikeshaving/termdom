#!/usr/bin/env bun
/**
 * Final Working Interactive Demo
 */

import { createTOM } from '../src/index.js';

async function main() {
  console.clear();
  console.log('🎮 TOM Interactive Demo');
  console.log('Use ↑↓ arrows, Enter to select, Q to quit\n');

  const tom = createTOM();
  let selectedIndex = 0;
  let isRunning = true;

  // Hide cursor
  process.stdout.write('\x1b[?25l');

  // Cleanup
  function cleanup() {
    if (!isRunning) return;
    isRunning = false;
    
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write('\x1b[?25h'); // Show cursor
    
    tom.destroy();
    console.log('\n👋 Goodbye!');
    process.exit(0);
  }

  // Container - use full screen
  const container = tom.createElement('container');
  container.style.flexDirection = 'column';
  container.style.padding = [1, 2, 1, 2];
  container.style.backgroundColor = 'darkBlue';
  tom.body.appendChild(container);

  // Title
  const title = tom.createElement('text');
  title.textContent = '=== TOM Button Demo ===';
  title.style.color = 'yellow';
  title.style.textAlign = 'center';
  title.style.minHeight = 1;
  container.appendChild(title);

  // Spacer
  const spacer = tom.createElement('text');
  spacer.textContent = '';
  spacer.style.minHeight = 1;
  container.appendChild(spacer);

  // Buttons with actions
  const buttons = [
    { 
      text: '🚀 Launch Demo', 
      action: () => {
        status.textContent = '🚀 Launching... 3... 2... 1... Blast off!';
        status.style.color = 'green';
        tom.render();
      }
    },
    { 
      text: '📊 Show Stats', 
      action: () => {
        status.textContent = '📊 CPU: 42% | Memory: 1.21GB | FPS: 60';
        status.style.color = 'cyan';
        tom.render();
      }
    },
    { 
      text: '🎨 Change Theme', 
      action: () => {
        container.style.backgroundColor = container.style.backgroundColor === 'darkBlue' ? 'darkRed' : 'darkBlue';
        status.textContent = '🎨 Theme changed!';
        status.style.color = 'magenta';
        tom.render();
      }
    },
    { 
      text: '❌ Exit', 
      action: cleanup
    }
  ];

  const buttonElements: any[] = [];
  buttons.forEach((btn) => {
    const button = tom.createElement('button');
    button.textContent = btn.text;
    button.style.minHeight = 3;
    container.appendChild(button);
    buttonElements.push(button);
  });

  // Another spacer
  const spacer2 = tom.createElement('text');
  spacer2.textContent = '';
  spacer2.style.minHeight = 1;
  container.appendChild(spacer2);

  // Status
  const status = tom.createElement('text');
  status.textContent = 'Ready. Use arrow keys to navigate.';
  status.style.color = 'white';
  status.style.textAlign = 'center';
  status.style.minHeight = 1;
  container.appendChild(status);

  // Update selection
  function updateSelection() {
    buttonElements.forEach((btn, i) => {
      if (i === selectedIndex) {
        btn.style.backgroundColor = 'yellow';
        btn.style.color = 'black';
        btn.style.borderColor = 'white';
      } else {
        btn.style.backgroundColor = '#555';
        btn.style.color = 'white';
        btn.style.borderColor = '#666';
      }
    });
    tom.render();
  }

  // Initial render
  updateSelection();

  // Keyboard handling
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let escBuffer = '';
  
  process.stdin.on('data', (chunk: string) => {
    if (!isRunning) return;

    for (const char of chunk) {
      // Handle escape sequences
      if (escBuffer.length > 0 || char === '\x1b') {
        escBuffer += char;
        
        // Complete sequences
        if (escBuffer === '\x1b[A') { // Up
          selectedIndex = (selectedIndex - 1 + buttons.length) % buttons.length;
          updateSelection();
          escBuffer = '';
        } else if (escBuffer === '\x1b[B') { // Down
          selectedIndex = (selectedIndex + 1) % buttons.length;
          updateSelection();
          escBuffer = '';
        } else if (escBuffer.length > 6) {
          escBuffer = ''; // Reset if too long
        }
        continue;
      }

      // Regular keys
      if (char === 'q' || char === 'Q' || char === '\x03') {
        cleanup();
      } else if (char === '\r' || char === '\n') {
        buttons[selectedIndex].action();
      }
    }
  });

  // Handle exit
  process.on('SIGINT', cleanup);
  
  // Auto-exit after 2 minutes
  setTimeout(() => {
    status.textContent = 'Demo timeout - exiting...';
    tom.render();
    setTimeout(cleanup, 1000);
  }, 120000);
}

main().catch(console.error);