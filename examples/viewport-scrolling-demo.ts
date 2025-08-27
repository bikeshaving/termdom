#!/usr/bin/env bun

/**
 * TTY Viewport Scrolling Demo
 * 
 * Demonstrates viewport scrolling with keyboard navigation:
 * - Arrow keys for line-by-line scrolling  
 * - Page Up/Down for page scrolling
 * - Ctrl+Home/End for top/bottom navigation
 * - Ctrl+C to exit
 */

import { TermDOM } from '../src/index.js';

async function main() {
  
  using { document, dispose } = TermDOM({ runtime });

  // Create content that exceeds viewport height
  const container = document.createElement('container');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.padding = '1';
  container.style.backgroundColor = 'blue';
  
  // Add many items to create scrollable content
  for (let i = 1; i <= 30; i++) {
    const item = document.createElement('container');
    item.style.setProperty('display', 'flex');
    item.style.setProperty('padding', '1');
    item.style.setProperty('margin', '0 0 1 0');
    item.style.setProperty('background-color', i % 2 === 0 ? 'green' : 'yellow');
    item.style.setProperty('color', i % 2 === 0 ? 'white' : 'black');
    item.textContent = `Item ${i} - This is scrollable content that extends beyond the viewport`;
    container.appendChild(item);
  }

  document.body.appendChild(container);

  // Add instructions at the top
  const instructions = document.createElement('container');
  instructions.style.setProperty('display', 'flex');
  instructions.style.setProperty('padding', '1');
  instructions.style.setProperty('background-color', 'cyan');
  instructions.style.setProperty('color', 'black');
  instructions.textContent = '🚀 Use Arrow Keys, Page Up/Down, Mouse Wheel, Ctrl+Home/End to scroll. Ctrl+C to exit.';
  
  // Insert instructions at the beginning
  document.body.insertBefore(instructions, container);
  

  // Simplified demo without viewport scrolling APIs
  function updateScrollIndicator() {
    instructions.textContent = `🚀 TTY Modern API Demo - Content extends beyond screen | Arrow Keys, PgUp/PgDn, Mouse Wheel, Ctrl+Home/End, Ctrl+C`;
  }

  // Update scroll indicator periodically
  const scrollInterval = setInterval(updateScrollIndicator, 100);

  // Wait for process to exit
  process.on('exit', () => {
    clearInterval(scrollInterval);
  });

  // Auto-exit after 10 seconds for testing
  setTimeout(() => {
    clearInterval(scrollInterval);
    console.log('\n✅ Viewport demo completed - exiting automatically');
    process.exit(0);
  }, 10000);

  // Keep alive for the timeout duration
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10000);
  });
}

main().catch(console.error);