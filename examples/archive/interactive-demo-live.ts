/**
 * Live Interactive TOM Demo - with real keyboard input
 */

import { createTTYWindow } from '../src/index.js';

function interactiveDemoLive() {
  console.log('🎮 Starting Live Interactive TOM Demo...');
  console.log('⌨️  Controls: ↑↓ arrows to navigate, Enter to click, Q to quit');
  console.log('⏰ Auto-exits in 30 seconds\n');

  const tty = createTTYWindow();
  let selectedIndex = 0;
  let isRunning = true;

  // Set up timeout
  const timeout = setTimeout(() => {
    cleanup();
  }, 30000);

  // Cleanup function
  function cleanup() {
    if (!isRunning) return;
    isRunning = false;

    clearTimeout(timeout);
    
    // Restore stdin
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    
    tty[Symbol.dispose]();
    
    // Show cursor
    process.stdout.write('\x1b[?25h');
    console.log('\n✅ Demo complete');
    process.exit(0);
  }

  // Create main container
  const mainContainer = tty.document.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [1, 2, 1, 2];
  mainContainer.style.backgroundColor = 'blue';
  tty.document.body.appendChild(mainContainer);

  // Title
  const title = tty.document.createElement('text');
  title.textContent = '🎮 Interactive TOM Demo';
  title.style.textAlign = 'center';
  title.style.color = 'white';
  title.style.backgroundColor = 'darkBlue';
  title.style.padding = [0, 2, 0, 2];
  mainContainer.appendChild(title);

  // Button container
  const buttonContainer = tty.document.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(buttonContainer);

  // Create buttons
  const buttons = [
    { text: '🚀 Launch', action: () => updateStatus('🚀 Launching rockets!') },
    { text: '🎯 Target', action: () => updateStatus('🎯 Target acquired!') },
    { text: '📊 Stats', action: () => updateStatus('📊 Loading stats...') },
    { text: '❌ Exit', action: () => cleanup() }
  ];

  const buttonElements: any[] = [];
  buttons.forEach((btn, index) => {
    const button = tty.document.createElement('button');
    button.textContent = btn.text;
    button.style.padding = [0, 2, 0, 2];
    buttonContainer.appendChild(button);
    buttonElements.push(button);
  });

  // Status area
  const statusArea = tty.document.createElement('text');
  statusArea.textContent = '👆 Use arrows to select';
  statusArea.style.textAlign = 'center';
  statusArea.style.color = 'cyan';
  statusArea.style.padding = [1, 0, 0, 0];
  mainContainer.appendChild(statusArea);

  function updateStatus(text: string) {
    statusArea.textContent = text;
    tty.document.render();
  }

  function updateSelection() {
    buttonElements.forEach((btn, index) => {
      if (index === selectedIndex) {
        btn.style.backgroundColor = 'yellow';
        btn.style.color = 'black';
        btn.style.borderColor = 'green';
      } else {
        btn.style.backgroundColor = 'gray';
        btn.style.color = 'white';
        btn.style.borderColor = '#666';
      }
    });
    tty.document.render();
  }

  // Initialize selection
  updateSelection();

  // Hide cursor
  process.stdout.write('\x1b[?25l');

  // Set up keyboard input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  // Store partial escape sequences
  let escapeBuffer = '';

  process.stdin.on('data', (data: string) => {
    if (!isRunning) return;

    // Handle escape sequences
    if (escapeBuffer || data[0] === '\x1b') {
      escapeBuffer += data;
      
      // Check for complete arrow key sequences
      if (escapeBuffer === '\x1b[A' || escapeBuffer === '\x1b[D') { // Up or Left
        selectedIndex = Math.max(0, selectedIndex - 1);
        updateSelection();
        escapeBuffer = '';
      } else if (escapeBuffer === '\x1b[B' || escapeBuffer === '\x1b[C') { // Down or Right
        selectedIndex = Math.min(buttons.length - 1, selectedIndex + 1);
        updateSelection();
        escapeBuffer = '';
      } else if (escapeBuffer.length > 3) {
        // Unknown escape sequence, clear buffer
        escapeBuffer = '';
      }
      return;
    }

    // Handle regular keys
    const key = data.toString();
    
    if (key === 'q' || key === 'Q') {
      cleanup();
    } else if (key === '\r' || key === '\n') { // Enter
      buttons[selectedIndex].action();
    } else if (key === '\x03') { // Ctrl+C
      cleanup();
    }
  });

  // Handle SIGINT
  process.on('SIGINT', cleanup);

  // Initial render
  tty.document.render();
}

// Run the demo
interactiveDemoLive();