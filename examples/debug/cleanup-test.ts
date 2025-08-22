#!/usr/bin/env bun

/**
 * Simple test to verify cleanup works properly
 */

import { createTOM } from '../src/index.js';

console.log('🧹 Testing cleanup functionality');

const tom = createTOM();

// Enable mouse - this should be cleaned up on exit
tom.enableMouse();
tom.enableInputMode();

// Register cleanup handler
tom.document.registerCleanupHandler(() => {
  console.log('✅ Cleanup handler called');
});

// Listen for unload
tom.window.addEventListener('unload', () => {
  console.log('📦 Unload event fired');
});

// Create simple content
const text = tom.createElement('text');
text.textContent = 'Press Ctrl+C to exit cleanly';
text.style.color = 'green';
tom.body.appendChild(text);

tom.render();

console.log('\nMouse tracking enabled. Exit with Ctrl+C to test cleanup.');