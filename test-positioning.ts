import { createTTY, BunTTYRuntime } from './src/index.js';

async function testPositioning() {
  const runtime = new BunTTYRuntime();
  const { document, dispose } = createTTY({ runtime });

  // Create a container
  const container = document.createElement('div');
  container.style.setProperty('position', 'relative');
  container.style.setProperty('width', '20');
  container.style.setProperty('height', '10');
  container.style.setProperty('background-color', 'blue');

  // Test static positioning (default)
  const staticEl = document.createElement('div');
  staticEl.textContent = 'Static';
  staticEl.style.setProperty('background-color', 'red');

  // Test relative positioning
  const relativeEl = document.createElement('div');
  relativeEl.textContent = 'Relative';
  relativeEl.style.setProperty('position', 'relative');
  relativeEl.style.setProperty('top', '2');
  relativeEl.style.setProperty('left', '3');
  relativeEl.style.setProperty('background-color', 'green');

  // Test absolute positioning
  const absoluteEl = document.createElement('div');
  absoluteEl.textContent = 'Absolute';
  absoluteEl.style.setProperty('position', 'absolute');
  absoluteEl.style.setProperty('top', '1');
  absoluteEl.style.setProperty('right', '2');
  absoluteEl.style.setProperty('background-color', 'yellow');

  // Test display: none
  const hiddenEl = document.createElement('div');
  hiddenEl.textContent = 'Hidden (should not appear)';
  hiddenEl.style.setProperty('display', 'none');
  hiddenEl.style.setProperty('background-color', 'purple');

  // Add all elements
  container.appendChild(staticEl);
  container.appendChild(relativeEl);
  container.appendChild(absoluteEl);
  container.appendChild(hiddenEl);
  document.body.appendChild(container);

  // Wait for render
  await new Promise(resolve => setTimeout(resolve, 100));

  //console.log('Testing positioning and display:none...');
  //console.log('Container bounds:', container.getBoundingClientRect());
  //console.log('Static element bounds:', staticEl.getBoundingClientRect());
  //console.log('Relative element bounds:', relativeEl.getBoundingClientRect());
  //console.log('Absolute element bounds:', absoluteEl.getBoundingClientRect());
  //console.log('Hidden element bounds:', hiddenEl.getBoundingClientRect());

  dispose();
}

testPositioning();
