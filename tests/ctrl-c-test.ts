/**
 * Simple test for Ctrl+C handling - run manually to test
 */

import { TOMDocument } from '../src/core/TOMDocument.js';
import { TOMContainer } from '../src/elements/TOMContainer.js';

console.log('🧪 Testing Ctrl+C handling...');
console.log('Press Ctrl+C to test graceful exit');
console.log('Or wait 10 seconds for auto-exit\n');

const document = new TOMDocument();

// Create a simple UI
const container = document.createElement('container') as TOMContainer;
container.style = {
  'background-color': '#1a1a1a',
  padding: 2,
  border: 1,
  'border-color': '#333'
};
container.textContent = 'Press Ctrl+C to exit gracefully!';
document.body.appendChild(container);

// Render
document.render();

// Auto-exit after 10 seconds for testing
setTimeout(() => {
  console.log('\n⏰ 10 seconds elapsed, auto-exiting...');
  document.destroy();
  process.exit(0);
}, 10000);

// Keep the process alive
process.stdin.resume();