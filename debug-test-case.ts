import { createTTY, MockTTYRuntime } from './src/index.js';

async function debugTestCase() {
  const mockRuntime = new MockTTYRuntime();
  const { document, dispose } = createTTY({ runtime: mockRuntime });
  
  const element = document.createElement('div');
  document.body.appendChild(element);
  
  console.log('Initial bounds:', element.getBoundingClientRect());
  
  // Set dimensions via CSS and compute layout
  element.style.setProperty('width', '100ch');
  element.style.setProperty('height', '50ch');
  element.style.setProperty('margin-left', '10ch');
  element.style.setProperty('margin-top', '20ch');
  
  console.log('Immediately after setting styles:', element.getBoundingClientRect());
  console.log('Style values:', {
    marginLeft: element.style.getPropertyValue('margin-left'),
    marginTop: element.style.getPropertyValue('margin-top'),
    width: element.style.getPropertyValue('width'),
    height: element.style.getPropertyValue('height')
  });
  
  // Wait for MutationObserver to process DOM changes
  await new Promise(resolve => setTimeout(resolve));
  
  console.log('After timeout (should have applied styles):', element.getBoundingClientRect());
  
  dispose();
}

debugTestCase();