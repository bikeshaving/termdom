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

import { createTTYWindow } from '../src/index.js';

async function main() {
  using tty = createTTYWindow({
    viewport: {
      height: 10, // Fixed viewport height of 10 lines
      overflow: 'scroll'
    }
  });

  // Create content that exceeds viewport height
  const container = tty.document.createElement('container');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.padding = '1';
  container.style.backgroundColor = 'blue';
  
  // Add many items to create scrollable content
  for (let i = 1; i <= 30; i++) {
    const item = tty.document.createElement('container');
    item.style.display = 'flex';
    item.style.padding = '1';
    item.style.margin = '0 0 1 0';
    item.style.backgroundColor = i % 2 === 0 ? 'green' : 'yellow';
    item.style.color = i % 2 === 0 ? 'white' : 'black';
    item.textContent = `Item ${i} - This is scrollable content that extends beyond the viewport`;
    container.appendChild(item);
  }

  tty.document.body.appendChild(container);

  // Add instructions at the top
  const instructions = tty.document.createElement('container');
  instructions.style.display = 'flex';
  instructions.style.padding = '1';
  instructions.style.backgroundColor = 'cyan';
  instructions.style.color = 'black';
  instructions.textContent = '🚀 Use Arrow Keys, Page Up/Down, Mouse Wheel, Ctrl+Home/End to scroll. Ctrl+C to exit.';
  
  // Insert instructions at the beginning
  tty.document.body.insertBefore(instructions, container);
  
  tty.document.render();

  // Add scroll position indicator
  function updateScrollIndicator() {
    if (tty.viewport) {
      const doc = tty.viewport.getDocument();
      const viewport = tty.viewport.getViewport();
      const percentage = doc.height > viewport.height ? 
        Math.round((doc.scrollTop / (doc.height - viewport.height)) * 100) : 0;
      
      instructions.textContent = `🚀 Scroll: ${doc.scrollTop}/${doc.height - viewport.height} (${percentage}%) | Arrow Keys, PgUp/PgDn, Mouse Wheel, Ctrl+Home/End, Ctrl+C`;
      tty.document.render();
    }
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