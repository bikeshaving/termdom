/**
 * TOM Mouse Demo - Shows mouse event support
 */

import { createTOM } from '../src/index.js';

function mouseDemo() {
  console.clear();
  console.log('🖱️  TOM Mouse Demo');
  console.log('Move mouse over buttons, click to activate');
  console.log('Press Q to quit\n');

  const tom = createTOM();
  let clickCount = 0;

  // Enable both keyboard and mouse
  tom.enableInputMode();
  tom.enableMouse();

  // Hide cursor
  process.stdout.write('\x1b[?25l');

  // Cleanup
  function cleanup() {
    process.stdout.write('\x1b[?25h'); // Show cursor
    tom.destroy();
    console.log('\n✅ Demo complete');
    process.exit(0);
  }

  // Main container
  const container = tom.createElement('container');
  container.style.flexDirection = 'column';
  container.style.padding = [1, 2, 1, 2];
  container.style.backgroundColor = 'darkBlue';
  tom.body.appendChild(container);

  // Title
  const title = tom.createElement('text');
  title.textContent = '🖱️  Mouse Event Demo';
  title.style.color = 'yellow';
  title.style.textAlign = 'center';
  title.style.padding = [1, 0, 1, 0];
  container.appendChild(title);

  // Status text
  const status = tom.createElement('text');
  status.textContent = 'Move mouse over buttons...';
  status.style.color = 'cyan';
  status.style.textAlign = 'center';
  status.style.padding = [1, 0, 1, 0];
  container.appendChild(status);

  // Button container
  const buttonContainer = tom.createElement('container');
  buttonContainer.style.flexDirection = 'column'; // Change to column for now
  buttonContainer.style.padding = [1, 0, 1, 0];
  container.appendChild(buttonContainer);

  // Create interactive buttons
  const buttons = [
    { text: '🟢 Click Me!', color: 'green' },
    { text: '🔵 Click Me!', color: 'blue' },
    { text: '🟡 Click Me!', color: 'yellow' }
  ];

  buttons.forEach((btn, i) => {
    const button = tom.createElement('button');
    button.textContent = btn.text;
    button.style.backgroundColor = 'gray';
    button.style.color = 'white';
    button.style.minWidth = 15;
    button.style.minHeight = 3;
    
    // Mouse events
    button.addEventListener('mouseenter', () => {
      button.style.backgroundColor = btn.color;
      status.textContent = `Hovering over ${btn.text}`;
      tom.render();
    });
    
    button.addEventListener('mouseleave', () => {
      button.style.backgroundColor = 'gray';
      status.textContent = 'Move mouse over buttons...';
      tom.render();
    });
    
    button.addEventListener('click', () => {
      clickCount++;
      status.textContent = `${btn.text} clicked! Total clicks: ${clickCount}`;
      
      // Flash effect
      button.style.backgroundColor = 'white';
      button.style.color = 'black';
      tom.render();
      
      setTimeout(() => {
        button.style.backgroundColor = btn.color;
        button.style.color = 'white';
        tom.render();
      }, 100);
    });
    
    buttonContainer.appendChild(button);
  });

  // Mouse position display
  const mouseInfo = tom.createElement('text');
  mouseInfo.textContent = 'Mouse: ---, ---';
  mouseInfo.style.color = 'gray';
  mouseInfo.style.padding = [1, 0, 0, 0];
  container.appendChild(mouseInfo);

  // Track mouse movement on document
  tom.addEventListener('mousemove', (e: any) => {
    mouseInfo.textContent = `Mouse: ${e.clientX}, ${e.clientY}`;
    tom.render();
  });

  // Keyboard handler for quit
  tom.addEventListener('keydown', (e: any) => {
    if (e.key.toLowerCase() === 'q') {
      cleanup();
    }
  });

  // Initial render
  tom.render();

  // Auto-exit after 1 minute
  setTimeout(() => {
    status.textContent = 'Demo timeout...';
    tom.render();
    setTimeout(cleanup, 1000);
  }, 60000);
}

mouseDemo();