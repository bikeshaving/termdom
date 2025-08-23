/**
 * Working Interactive Demo - ensures buttons have space
 */

import { createTTYWindow } from '../src/index.js';

function interactiveWorking() {
  console.log('🎮 Interactive TOM Demo');
  console.log('⌨️  Use arrow keys, Enter to select, Q to quit\n');

  const tty = createTTYWindow();
  let selectedIndex = 0;
  let isRunning = true;

  // Cleanup function
  function cleanup() {
    if (!isRunning) return;
    isRunning = false;
    
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    
    tty[Symbol.dispose]();
    process.stdout.write('\x1b[?25h'); // Show cursor
    console.log('\n👋 Goodbye!');
    process.exit(0);
  }

  // Simple layout - just buttons
  const container = tty.document.createElement('container');
  container.style.flexDirection = 'column';
  container.style.padding = [1, 2, 1, 2];
  container.style.backgroundColor = 'blue';
  tty.document.body.appendChild(container);

  // Create 3 buttons that will definitely fit
  const buttons = [
    { text: '🚀 Launch Demo', action: () => showMessage('🚀 Launching!') },
    { text: '📊 Show Stats', action: () => showMessage('📊 Stats: 100%') },
    { text: '❌ Exit', action: () => cleanup() }
  ];

  const buttonElements: any[] = [];
  buttons.forEach(btn => {
    const button = tty.document.createElement('button');
    button.textContent = btn.text;
    container.appendChild(button);
    buttonElements.push(button);
  });

  // Status text
  const status = tty.document.createElement('text');
  status.textContent = 'Ready...';
  status.style.color = 'yellow';
  status.style.textAlign = 'center';
  status.style.padding = [1, 0, 0, 0];
  container.appendChild(status);

  function showMessage(msg: string) {
    status.textContent = msg;
    tty.document.render();
    
    // Reset after 2 seconds
    setTimeout(() => {
      if (isRunning) {
        status.textContent = 'Ready...';
        tty.document.render();
      }
    }, 2000);
  }

  function updateSelection() {
    buttonElements.forEach((btn, i) => {
      if (i === selectedIndex) {
        btn.style.backgroundColor = 'yellow';
        btn.style.color = 'black';
      } else {
        btn.style.backgroundColor = 'gray';
        btn.style.color = 'white';
      }
    });
    tty.document.render();
  }

  // Initial render
  updateSelection();
  process.stdout.write('\x1b[?25l'); // Hide cursor

  // Keyboard input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let escBuffer = '';
  
  process.stdin.on('data', (data: string) => {
    if (!isRunning) return;

    // Build escape sequence
    if (escBuffer || data[0] === '\x1b') {
      escBuffer += data;
      
      // Arrow keys
      if (escBuffer === '\x1b[A') { // Up
        selectedIndex = Math.max(0, selectedIndex - 1);
        updateSelection();
        escBuffer = '';
      } else if (escBuffer === '\x1b[B') { // Down
        selectedIndex = Math.min(buttons.length - 1, selectedIndex + 1);
        updateSelection();
        escBuffer = '';
      } else if (escBuffer.length > 3) {
        escBuffer = '';
      }
      return;
    }

    // Regular keys
    if (data === 'q' || data === 'Q' || data === '\x03') {
      cleanup();
    } else if (data === '\r' || data === '\n') {
      buttons[selectedIndex].action();
    }
  });

  // Auto-exit after 60 seconds
  setTimeout(cleanup, 60000);
  
  // Handle Ctrl+C
  process.on('SIGINT', cleanup);
}

interactiveWorking();