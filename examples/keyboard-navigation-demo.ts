/**
 * Keyboard Navigation Demo - DOM Events and Focus Management
 * 
 * Features:
 * - Real keyboard navigation with arrow keys/tab
 * - HappyDOM KeyboardEvent and FocusEvent dispatching
 * - Focus states with visual feedback
 * - Click events on Enter key
 * - Safe exit with timeout and Ctrl+C
 */

import { createTTY, BunTTYRuntime } from '../src/index.js';

function keyboardNavigationDemo() {
  console.log('⌨️  Starting Keyboard Navigation Demo...');
  console.log('🎮 Controls: Tab/↓ = next, ↑ = previous, Enter = click, Q = quit');
  console.log('⏰ Auto-exits in 30 seconds\n');
  
  const runtime = new BunTTYRuntime();
  const { document, dispose } = createTTY({ runtime });
  let isRunning = true;
  
  // Set up timeout to auto-exit
  const timeout = setTimeout(() => {
    console.log('\n⏰ Demo timed out - exiting...');
    cleanup();
  }, 30000);
  
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
    // Runtime cleanup handled by dispose()
    dispose();
    
    // Restore terminal
    process.stdout.write('\x1b[?25h'); // Show cursor
    process.stdout.write('\x1b[0m');   // Reset colors
    
    console.log('✅ Demo cleaned up');
    process.exit(0);
  }
  
  // Create main layout
  const mainContainer = document.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [2, 4, 2, 4];
  mainContainer.style.backgroundColor = 'blue';
  document.body.appendChild(mainContainer);
  
  // Title
  const title = document.createElement('text');
  title.textContent = '⌨️  DOM Events & Navigation Demo';
  title.style.textAlign = 'center';
  title.style.color = 'white';
  title.style.backgroundColor = 'darkBlue';
  title.style.padding = [1, 2, 1, 2];
  mainContainer.appendChild(title);
  
  // Instructions
  const instructions = document.createElement('text');
  instructions.textContent = 'Tab/↓=Next ↑=Previous Enter=Click Q=Quit';
  instructions.style.textAlign = 'center';
  instructions.style.color = 'yellow';
  instructions.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(instructions);
  
  // Button container
  const buttonContainer = document.createElement('container');
  buttonContainer.style.flexDirection = 'column';
  buttonContainer.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(buttonContainer);
  
  // Status area (declare early for use in button handlers)
  const statusDisplay = document.createElement('text');
  statusDisplay.textContent = '👆 Use keyboard to navigate and interact';
  statusDisplay.style.textAlign = 'center';
  statusDisplay.style.color = 'white';
  statusDisplay.style.backgroundColor = 'darkGreen';
  statusDisplay.style.padding = [1, 2, 1, 2];
  
  // Focus info (declare early)
  const focusInfo = document.createElement('text');
  focusInfo.textContent = 'No element focused';
  focusInfo.style.textAlign = 'center';
  focusInfo.style.color = 'cyan';
  focusInfo.style.padding = [1, 0, 1, 0];
  
  // Create interactive buttons with event handlers
  const buttonData = [
    { text: '🚀 Launch Rocket', color: 'red', action: 'Rocket launched! 🚀' },
    { text: '🎯 Hit Target', color: 'green', action: 'Bullseye! Target hit! 🎯' },
    { text: '📊 Show Stats', color: 'blue', action: 'Stats: CPU 42%, RAM 67% 📊' },
    { text: '⚙️ Settings', color: 'purple', action: 'Settings menu opened ⚙️' },
    { text: '💾 Save Data', color: 'cyan', action: 'Data saved successfully! 💾' },
    { text: '❌ Exit Demo', color: 'red', action: 'exit' }
  ];
  
  const buttons: any[] = [];
  
  for (const btnData of buttonData) {
    const button = document.createElement('button');
    button.textContent = btnData.text;
    button.style.backgroundColor = btnData.color;
    button.style.color = 'white';
    button.style.margin = [0, 0, 1, 0]; // Bottom margin
    
    // Add click event listener using DOM APIs!
    button.addEventListener('click', (event) => {
      console.log('\n🎉 Button clicked!', btnData.text);
      console.log('Event type:', event.type);
      console.log('Target:', event.target?.constructor.name);
      
      if (btnData.action === 'exit') {
        statusDisplay.textContent = '👋 Goodbye! Exiting...';
        setTimeout(cleanup, 1000);
      } else {
        statusDisplay.textContent = btnData.action;
        
        // Reset status after 3 seconds
        setTimeout(() => {
          if (isRunning) {
            statusDisplay.textContent = '👆 Use keyboard to navigate and interact';
          }
        }, 3000);
      }
    });
    
    // Add focus event listeners
    button.addEventListener('focus', (event) => {
      console.log('\n🎯 Focus event:', btnData.text);
      console.log('Event type:', event.type);
      console.log('Target:', event.target?.constructor.name);
      
      focusInfo.textContent = `Focused: ${btnData.text}`;
    });
    
    button.addEventListener('blur', (event) => {
      console.log('\n😶‍🌫️ Blur event:', btnData.text);
      console.log('Event type:', event.type);
      
      if (document.activeElement === null) {
        focusInfo.textContent = 'No element focused';
      }
    });
    
    // Add keyboard event listeners
    button.addEventListener('keydown', (event) => {
      console.log('\n⌨️  Keyboard event on button:', event.key);
      
      // Custom behavior for specific keys
      if (event.key === 'Space' || event.key === ' ') {
        // Prevent default navigation and trigger click
        event.preventDefault();
        button.click();
      }
    });
    
    buttonContainer.appendChild(button);
    buttons.push(button);
  }
  
  // Add status and info to container
  mainContainer.appendChild(statusDisplay);
  mainContainer.appendChild(focusInfo);
  
  // Event counter
  let eventCount = 0;
  const eventCounter = document.createElement('text');
  eventCounter.textContent = 'Events fired: 0';
  eventCounter.style.textAlign = 'center';
  eventCounter.style.color = 'lightGray';
  eventCounter.style.padding = [1, 0, 0, 0];
  mainContainer.appendChild(eventCounter);
  
  // Document-level keyboard listener to show event bubbling
  document.addEventListener('keydown', (event) => {
    eventCount++;
    eventCounter.textContent = `Events fired: ${eventCount}`;
    
    console.log('\n📄 Document-level keyboard event:');
    console.log('Key:', event.key);
    console.log('Target:', event.target?.constructor.name);
    console.log('CurrentTarget:', event.currentTarget?.constructor.name);
    
    // Handle quit key
    if (event.key === 'q' || event.key === 'Q') {
      cleanup();
    }
    
  });
  
  // Set up initial focus and enable input
  buttons[0].focus();
  
  // Hide cursor and render
  process.stdout.write('\x1b[?25l'); // Hide cursor
  
  // Enable input mode handled by runtime automatically
  
  console.log('\n🎮 Input mode enabled - start navigating!');
  console.log('Watch the console for detailed event information!');
}

keyboardNavigationDemo();