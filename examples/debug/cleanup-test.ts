#!/usr/bin/env bun

/**
 * Simple test to verify cleanup works properly
 */

import { createTTYWindow } from '../src/index.js';

console.log('🧹 Testing cleanup functionality');

const tty = createTTYWindow();

// Enable mouse - this should be cleaned up on exit
tty.enableMouse();
tty.enableInputMode();

// Register cleanup handler
tty.document.registerCleanupHandler(() => {
  console.log('✅ Cleanup handler called');
});

// Listen for unload
tom.window.addEventListener('unload', () => {
  console.log('📦 Unload event fired');
});

// Create simple content
const text = tty.document.createElement('text');
text.textContent = 'Press Ctrl+C to exit cleanly';
text.style.color = 'green';
tty.document.body.appendChild(text);

tty.document.render();

console.log('\nMouse tracking enabled. Exit with Ctrl+C to test cleanup.');