/**
 * Basic TTY Demo
 * 
 * Demonstrates the core TTY functionality with a simple UI
 * containing containers, text, and buttons.
 */

import { createTTYWindow } from '../src/index.js';

async function basicDemo() {
  console.log('🚀 Starting TTY Basic Demo...');
  
  try {
    // Create TTY document
    const tty = createTTYWindow();

    console.log('📱 TTY Document created successfully');
    console.log(`Terminal size: ${tty.innerWidth}x${tty.innerHeight}`);

    // Create main container
    const container = tty.document.createElement('container');
    container.style = {
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#1a1a1a',
      padding: 2,
      border: 1,
      borderColor: '#333'
    };

    // Create title
    const title = tty.document.createElement('text');
    title.textContent = '🎯 Terminal Typewriter Demo';
    title.style = {
      color: '#00ff00',
      fontWeight: 'bold',
      textAlign: 'center'
    };

    // Create description
    const description = tty.document.createElement('text');
    description.textContent = 'Welcome to TTY - bringing DOM APIs to the terminal!';
    description.style = {
      color: '#888',
      textAlign: 'center'
    };

    // Create button container
    const buttonContainer = tty.document.createElement('container');
    buttonContainer.style = {
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'center'
    };

    // Create buttons
    const button1 = tty.document.createElement('button');
    button1.textContent = 'Click Me!';
    button1.style = {
      backgroundColor: '#0066cc',
      color: 'white'
    };

    const button2 = tty.document.createElement('button');
    button2.textContent = 'Or Me!';
    button2.style = {
      backgroundColor: '#cc6600',
      color: 'white'
    };

    // Add click handlers
    button1.addEventListener('click', () => {
      title.textContent = '🎉 Button 1 clicked!';
      title.style = { ...title.style, color: '#ff6600' };
      tty.document.render(); // Force re-render to see changes
    });

    button2.addEventListener('click', () => {
      title.textContent = '✨ Button 2 clicked!';
      title.style = { ...title.style, color: '#6600ff' };
      tty.document.render(); // Force re-render to see changes
    });

    // Build the DOM tree
    buttonContainer.appendChild(button1);
    buttonContainer.appendChild(button2);
    
    container.appendChild(title);
    container.appendChild(description);
    container.appendChild(buttonContainer);
    
    tty.document.body.appendChild(container);

    console.log('🏗️  DOM tree constructed');

    // Initial render
    tty.document.render();
    console.log('🎨 Initial render complete');

    // Setup exit handler
    process.on('SIGINT', () => {
      console.log('\n👋 Shutting down TTY demo...');
      tty[Symbol.dispose]();
      process.exit(0);
    });

    console.log('\n✅ Demo running! Press Ctrl+C to exit.');
    console.log('💡 Try clicking the buttons or using keyboard navigation.');

  } catch (error) {
    console.error('❌ Demo failed:', error);
    process.exit(1);
  }
}

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Run the demo
basicDemo().catch(console.error);