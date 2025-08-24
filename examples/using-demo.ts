/**
 * Demo showing new Symbol.dispose support with `using` syntax
 * 
 * The `using` statement automatically calls [Symbol.dispose]() when the scope exits,
 * ensuring proper terminal cleanup even if exceptions occur or the process exits unexpectedly.
 */

import { createTTY, BunTTYRuntime } from '../src/index.js';

async function usingDemo() {
  console.log('🎯 Demonstrating automatic resource management with `using`');
  
  // Using the new 'using' syntax ensures automatic cleanup
  const runtime = new BunTTYRuntime();
  using { document, dispose } = createTTY({ runtime });
  
  try {
    // Create a simple UI
    const container = document.createElement('container');
    container.style = {
      backgroundColor: '#1a1a1a',
      padding: 2,
      border: 1,
      borderColor: '#333'
    };
    container.textContent = 'This demo uses automatic resource management!';
    
    document.body.appendChild(container);
    
    console.log('✅ TTY UI rendered with automatic cleanup');
    console.log('💡 Terminal mouse tracking and styling will be cleaned up automatically');
    
    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Even if an exception occurs here, cleanup will still happen
    if (Math.random() > 0.5) {
      throw new Error('Random error for testing cleanup!');
    }
    
  } catch (error) {
    console.log('❌ Error occurred:', error.message);
    console.log('🛡️  But terminal will still be cleaned up properly!');
  }
  
  // TTY is automatically disposed here when leaving the using block
  console.log('✨ Using block ended - terminal should be clean!');
}

// Also demonstrate manual cleanup for comparison
async function manualDemo() {
  console.log('\n🔧 For comparison - manual cleanup approach:');
  
  const runtime = new BunTTYRuntime();
  const { document, dispose } = createTTY({ runtime });
  
  try {
    const container = document.createElement('container');
    container.style = {
      backgroundColor: '#2a2a2a',
      padding: 1,
      border: 1,
      borderColor: '#555'
    };
    container.textContent = 'This demo requires manual cleanup';
    
    document.body.appendChild(container);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
  } finally {
    // Must remember to manually call [Symbol.dispose]()
    dispose();
    console.log('🧹 Manually cleaned up');
  }
}

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// Run both demos
async function main() {
  await usingDemo();
  await manualDemo();
  
  console.log('\n🎉 Both demos completed - terminal should be fully reset!');
}

main().catch(console.error);