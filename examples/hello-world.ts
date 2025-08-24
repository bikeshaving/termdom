/**
 * Hello World - HTML-to-Terminal Demo 🚀
 * 
 * This demonstrates the revolutionary new approach:
 * Write standard HTML/CSS → Render to beautiful terminal output!
 */

import { createTTY, BunTTYRuntime } from '../src/index.js';

async function helloWorld() {
  console.log('🚀 HTML-to-Terminal Hello World!\n');
  
  // Create a TTY document (like a browser, but for terminals)
  const runtime = new BunTTYRuntime();
  const { document, dispose } = createTTY({ runtime });
  
  // Create standard HTML elements with CSS styling!
  const container = document.createElement('div');
  container.style.setProperty('background-color', 'blue');
  container.style.setProperty('color', 'white');
  container.style.setProperty('padding', '1');
  container.textContent = '🎯 Hello, HTML Terminal!';
  
  const subtitle = document.createElement('div');
  subtitle.style.setProperty('color', 'yellow');
  subtitle.style.setProperty('margin-top', '1');
  subtitle.textContent = 'Standard HTML/CSS → ANSI Terminal Output';
  
  // Add to document (just like web development!)
  document.body.appendChild(container);
  document.body.appendChild(subtitle);
  
  console.log('✅ Created HTML elements');
  console.log('📝 Container tag:', container.tagName);
  console.log('🎨 Background color:', container.style.getPropertyValue('background-color'));
  
  // Rendering happens automatically via MutationObserver!
  // Wait for layout to compute
  setTimeout(() => {
    // Show layout information
    const rect = container.getBoundingClientRect();
    console.log('\n📐 Layout computed:');
    console.log(`   Size: ${rect.width} x ${rect.height}`);
    console.log(`   Position: (${rect.x}, ${rect.y})`);
    
    console.log('\n🎉 HTML-to-Terminal rendering complete!');
  }, 100);
  
  // Clean up
  setTimeout(() => {
    dispose();
  }, 2000);
}

helloWorld();