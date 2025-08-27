#!/usr/bin/env bun

/**
 * Color Example - Test CSS colors in terminal output
 * 
 * This example tests various CSS color properties to verify
 * that they're properly converted to ANSI escape sequences.
 */

import { TermDOM } from '../src/index.js';

async function main() {
  const dom = new TermDOM();
  const { document } = dom;

  console.log('🎨 Testing CSS Colors in Terminal\n');

  // Create container
  const container = document.createElement('div');
  document.body.appendChild(container);

  // Test foreground colors
  const colors = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'white'];
  
  for (const color of colors) {
    const div = document.createElement('div');
    div.textContent = `This text should be ${color}`;
    div.style.setProperty('color', color);
    container.appendChild(div);
  }

  // Add separator
  const separator = document.createElement('div');
  separator.textContent = '\n--- Background Colors ---\n';
  container.appendChild(separator);

  // Test background colors
  const bgColors = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan'];
  
  for (const bgColor of bgColors) {
    const div = document.createElement('div');
    div.textContent = `Text on ${bgColor} background`;
    div.style.setProperty('background-color', bgColor);
    div.style.setProperty('color', 'white'); // White text for visibility
    div.style.setProperty('display', 'block'); // Ensure block display
    container.appendChild(div);
  }

  // Add separator
  const separator2 = document.createElement('div');
  separator2.textContent = '\n--- Mixed Styles ---\n';
  container.appendChild(separator2);

  // Test combined colors
  const mixed = document.createElement('div');
  mixed.textContent = 'Bold red text on yellow background';
  mixed.style.setProperty('color', 'red');
  mixed.style.setProperty('background-color', 'yellow');
  mixed.style.setProperty('font-weight', 'bold');
  container.appendChild(mixed);

  // Wait a moment for rendering
  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('\nIf you see colored text above, the color system is working!');
  console.log('If you see plain text, there may be an issue with color conversion.');

  dom.dispose();
}

if (import.meta.main) {
  main().catch(console.error);
}