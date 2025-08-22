/**
 * Interactive TOM Demo - Keyboard navigation with auto-timeout
 * 
 * Features:
 * - Auto-exits after 20 seconds
 * - Press 'q' or Ctrl+C to quit
 * - Arrow keys to navigate
 * - Enter to "click" buttons
 */

import { createTOM } from '../src/index.js';

function interactiveDemo() {
  console.log('🎮 Starting Interactive TOM Demo...');
  console.log('⌨️  Controls: Arrow keys to navigate, Enter to click, Q to quit');
  console.log('⏰ Auto-exits in 20 seconds\n');
  
  const tom = createTOM();
  let selectedIndex = 0;
  let isRunning = true;
  
  // Set up timeout to auto-exit
  const timeout = setTimeout(() => {
    console.log('\n⏰ Demo timed out - exiting...');
    cleanup();
  }, 20000);
  
  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('\n👋 Caught Ctrl+C - exiting gracefully...');
    cleanup();
  });
  
  // Cleanup function
  function cleanup() {
    if (!isRunning) return;
    isRunning = false;
    
    clearTimeout(timeout);
    tom.destroy();
    
    // Restore terminal
    process.stdout.write('\x1b[?25h'); // Show cursor
    process.stdout.write('\x1b[0m');   // Reset colors
    
    console.log('✅ Demo cleaned up');
    process.exit(0);
  }
  
  // Create main container
  const mainContainer = tom.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [2, 4, 2, 4];
  mainContainer.style.backgroundColor = 'blue';
  tom.body.appendChild(mainContainer);
  
  // Title
  const title = tom.createElement('text');
  title.textContent = '🎮 Interactive TOM Demo';
  title.style.textAlign = 'center';
  title.style.color = 'white';
  title.style.backgroundColor = 'darkBlue';
  title.style.padding = [1, 2, 1, 2];
  mainContainer.appendChild(title);
  
  // Instructions
  const instructions = tom.createElement('text');
  instructions.textContent = 'Use ↑↓ arrows to navigate, Enter to click, Q to quit';
  instructions.style.textAlign = 'center';
  instructions.style.color = 'yellow';
  instructions.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(instructions);
  
  // Button container
  const buttonContainer = tom.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(buttonContainer);
  
  // Create interactive buttons
  const buttons = [
    { text: '🚀 Launch Something', action: 'Launching rockets! 🚀' },
    { text: '🎯 Hit Target', action: 'Target acquired! 🎯' },
    { text: '📊 Show Stats', action: 'Loading statistics... 📊' },
    { text: '⚙️ Settings', action: 'Opening settings... ⚙️' },
    { text: '❌ Exit Demo', action: 'exit' }
  ];
  
  const buttonElements = buttons.map((btn, index) => {
    const button = tom.createElement('text');
    button.textContent = btn.text;
    button.style.padding = [1, 2, 1, 2];
    button.style.textAlign = 'center';
    updateButtonStyle(button, index === selectedIndex);
    buttonContainer.appendChild(button);
    return button;
  });
  
  // Status area
  const statusArea = tom.createElement('text');
  statusArea.textContent = '👆 Select a button above';
  statusArea.style.textAlign = 'center';
  statusArea.style.color = 'cyan';
  statusArea.style.backgroundColor = 'darkCyan';
  statusArea.style.padding = [1, 2, 1, 2];
  mainContainer.appendChild(statusArea);
  
  // Timer display
  const timerDisplay = tom.createElement('text');
  timerDisplay.textContent = '⏰ 20 seconds remaining';
  timerDisplay.style.textAlign = 'center';
  timerDisplay.style.color = 'white';
  timerDisplay.style.padding = [1, 0, 0, 0];
  mainContainer.appendChild(timerDisplay);
  
  function updateButtonStyle(button: any, isSelected: boolean) {
    if (isSelected) {
      button.style.backgroundColor = 'yellow';
      button.style.color = 'black';
    } else {
      button.style.backgroundColor = 'gray';
      button.style.color = 'white';
    }
  }
  
  function updateSelection() {
    buttonElements.forEach((btn, index) => {
      updateButtonStyle(btn, index === selectedIndex);
    });
    tom.render();
  }
  
  function executeAction() {
    const action = buttons[selectedIndex].action;
    
    if (action === 'exit') {
      statusArea.textContent = '👋 Goodbye!';
      tom.render();
      setTimeout(cleanup, 1000);
      return;
    }
    
    statusArea.textContent = action;
    tom.render();
    
    // Reset status after 2 seconds
    setTimeout(() => {
      if (isRunning) {
        statusArea.textContent = '👆 Select a button above';
        tom.render();
      }
    }, 2000);
  }
  
  // Timer countdown
  let secondsRemaining = 20;
  const timerInterval = setInterval(() => {
    secondsRemaining--;
    if (secondsRemaining > 0 && isRunning) {
      timerDisplay.textContent = `⏰ ${secondsRemaining} seconds remaining`;
      tom.render();
    }
  }, 1000);
  
  // Set up keyboard input
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  
  process.stdin.on('data', (key: string) => {
    if (!isRunning) return;
    
    const byte = key.charCodeAt(0);
    
    if (key === 'q' || key === 'Q' || byte === 3) { // q or Ctrl+C
      cleanup();
      return;
    }
    
    if (byte === 27) { // Escape sequence (arrow keys)
      return; // Wait for full sequence
    }
    
    // Arrow key sequences
    if (key === '\u001b[A' || key === '\u001b[D') { // Up or Left
      selectedIndex = Math.max(0, selectedIndex - 1);
      updateSelection();
    } else if (key === '\u001b[B' || key === '\u001b[C') { // Down or Right
      selectedIndex = Math.min(buttons.length - 1, selectedIndex + 1);
      updateSelection();
    } else if (byte === 13) { // Enter
      executeAction();
    }
  });
  
  // Hide cursor and initial render
  process.stdout.write('\x1b[?25l'); // Hide cursor
  tom.render();
  
  // Clean up timer
  setTimeout(() => {
    clearInterval(timerInterval);
  }, 21000);
}

interactiveDemo();