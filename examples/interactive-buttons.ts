#!/usr/bin/env bun
/**
 * Interactive Buttons Demo - Full HTML-to-Terminal Integration
 *
 * This example demonstrates the complete TTYOM system:
 * - HTML elements with CSS styling
 * - Yoga layout engine for positioning
 * - Mouse and keyboard event handling
 * - Real-time terminal rendering
 * - DOM events (click, keydown, etc.)
 */

import { createTTY, BunTTYRuntime } from '../src/index.js';
import { TTYEventTranslator } from '../src/events/TTYEventTranslator.js';

// Create terminal runtime and document
const runtime = new BunTTYRuntime();
const { document, dispose } = createTTY({ runtime });

// State
let counter = 0;

// Create HTML structure
const container = document.createElement('div');
container.style.setProperty('display', 'flex');
container.style.setProperty('flex-direction', 'column');
container.style.setProperty('align-items', 'center');
container.style.setProperty('gap', '2px');
container.style.setProperty('padding', '3px');

// Title
const title = document.createElement('h1');
title.textContent = '🎮 Interactive Button Demo';
title.style.setProperty('margin-bottom', '1px');
container.appendChild(title);

// Counter display
const counterDisplay = document.createElement('div');
counterDisplay.textContent = `Counter: ${counter}`;
counterDisplay.style.setProperty('margin-bottom', '2px');
container.appendChild(counterDisplay);

// Button container
const buttonContainer = document.createElement('div');
buttonContainer.style.setProperty('display', 'flex');
buttonContainer.style.setProperty('gap', '2px');
buttonContainer.style.setProperty('margin-bottom', '2px');

// Create buttons
const incrementButton = document.createElement('button');
incrementButton.textContent = '➕ +1';
incrementButton.style.setProperty('padding', '1px 2px');
incrementButton.style.setProperty('min-width', '8px');

const decrementButton = document.createElement('button');
decrementButton.textContent = '➖ -1';
decrementButton.style.setProperty('padding', '1px 2px');
decrementButton.style.setProperty('min-width', '8px');

const resetButton = document.createElement('button');
resetButton.textContent = '🔄 Reset';
resetButton.style.setProperty('padding', '1px 2px');
resetButton.style.setProperty('min-width', '10px');

buttonContainer.appendChild(incrementButton);
buttonContainer.appendChild(decrementButton);
buttonContainer.appendChild(resetButton);
container.appendChild(buttonContainer);

// Status display
const status = document.createElement('div');
status.textContent = 'Click buttons or use Tab to navigate, Enter to activate';
status.style.setProperty('font-size', '0.9em');
status.style.setProperty('color', '#666');
container.appendChild(status);

// Controls info
const controls = document.createElement('div');
controls.textContent = 'Controls: Mouse click, Tab/Shift+Tab navigation, Enter/Space, Ctrl+C to quit';
controls.style.setProperty('font-size', '0.8em');
controls.style.setProperty('color', '#444');
controls.style.setProperty('margin-top', '1px');
container.appendChild(controls);

// Add container to body
document.body.appendChild(container);

// Update counter display
function updateDisplay() {
  counterDisplay.textContent = `Counter: ${counter}`;
  if (counter > 0) {
    counterDisplay.style.setProperty('color', '#0a0');
  } else if (counter < 0) {
    counterDisplay.style.setProperty('color', '#a00');
  } else {
    counterDisplay.style.setProperty('color', '#000');
  }
}

// Button event handlers
incrementButton.addEventListener('click', () => {
  counter++;
  updateDisplay();
  status.textContent = `✅ Incremented! Counter is now ${counter}`;
  setTimeout(() => {
    status.textContent = 'Click buttons or use Tab to navigate, Enter to activate';
  }, 2000);
});

decrementButton.addEventListener('click', () => {
  counter--;
  updateDisplay();
  status.textContent = `✅ Decremented! Counter is now ${counter}`;
  setTimeout(() => {
    status.textContent = 'Click buttons or use Tab to navigate, Enter to activate';
  }, 2000);
});

resetButton.addEventListener('click', () => {
  counter = 0;
  updateDisplay();
  status.textContent = '✅ Counter reset to 0!';
  setTimeout(() => {
    status.textContent = 'Click buttons or use Tab to navigate, Enter to activate';
  }, 2000);
});

// Focus event handlers for visual feedback
const buttons = [incrementButton, decrementButton, resetButton];
buttons.forEach((button, index) => {
  button.addEventListener('focus', () => {
    status.textContent = `🎯 Focused: ${button.textContent} (${index + 1}/3)`;
  });
  
  button.addEventListener('blur', () => {
    status.textContent = 'Click buttons or use Tab to navigate, Enter to activate';
  });
});

// Keyboard shortcuts
document.addEventListener('keydown', (event) => {
  const ke = event as KeyboardEvent;
  
  if (ke.ctrlKey && ke.key === 'c') {
    cleanup();
    process.exit(0);
  }
  
  // Number key shortcuts
  if (ke.key === '1') {
    incrementButton.click();
  } else if (ke.key === '2') {
    decrementButton.click();
  } else if (ke.key === '0') {
    resetButton.click();
  }
});

// Initialize and start
async function initialize() {
  console.log('🚀 Starting Interactive Buttons Demo...');
  console.log('');
  console.log('Controls:');
  console.log('  🖱️  Mouse: Click buttons directly');
  console.log('  ⌨️  Keyboard: Tab/Shift+Tab to navigate, Enter/Space to activate');
  console.log('  🔢 Shortcuts: 1=increment, 2=decrement, 0=reset');
  console.log('  ⏹️  Exit: Ctrl+C');
  console.log('');

  // Set up event translation
  const eventTranslator = new TTYEventTranslator(runtime, document);
  eventTranslator.start();
  
  // Wait for initial render (DOM mutation observer will handle updates)
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Handle cleanup
  function cleanup() {
    console.log('\\n👋 Goodbye!');
    eventTranslator.stop();
    dispose();
  }
  
  // Handle process signals
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  console.log('✅ Demo running! Try clicking buttons or using keyboard navigation.');
}

// Global cleanup function
function cleanup() {
  dispose();
}

// Start the demo
await initialize();