/**
 * Demo showing how TOM preserves final UI state as static terminal output
 * 
 * This demonstrates how TOM applications feel integrated with terminal workflow
 * by leaving their final state visible in terminal history after exit.
 */

import { createTOM } from '../src/index.js';

async function preserveStateDemo() {
  console.log('🎯 TOM Preserve State Demo');
  console.log('📊 This will show a data dashboard and preserve it after exit\n');
  
  using tom = createTOM();
  
  // Create a data dashboard
  const dashboard = tom.createElement('container');
  dashboard.style = {
    backgroundColor: '#1a1a2e',
    padding: 2,
    border: 1,
    borderColor: '#16213e'
  };
  
  // Title
  const title = tom.createElement('text');
  title.textContent = '📊 System Dashboard - Final State';
  title.style = {
    color: '#4cc9f0',
    textAlign: 'center',
    marginBottom: 1
  };
  
  // Data section
  const dataContainer = tom.createElement('container');
  dataContainer.style = {
    flexDirection: 'row',
    gap: 2
  };
  
  // CPU info
  const cpuBox = tom.createElement('container');
  cpuBox.style = {
    backgroundColor: '#0f1c2e',
    padding: 1,
    border: 1,
    borderColor: '#2a4158',
    flex: 1
  };
  
  const cpuTitle = tom.createElement('text');
  cpuTitle.textContent = '🖥️  CPU Usage';
  cpuTitle.style = { color: '#7209b7', marginBottom: 1 };
  
  const cpuValue = tom.createElement('text');
  cpuValue.textContent = '▓▓▓▓▓▓▓░░░ 67%';
  cpuValue.style = { color: '#f72585' };
  
  cpuBox.appendChild(cpuTitle);
  cpuBox.appendChild(cpuValue);
  
  // Memory info
  const memBox = tom.createElement('container');
  memBox.style = {
    backgroundColor: '#0f1c2e',
    padding: 1,
    border: 1,
    borderColor: '#2a4158',
    flex: 1
  };
  
  const memTitle = tom.createElement('text');
  memTitle.textContent = '💾 Memory';
  memTitle.style = { color: '#7209b7', marginBottom: 1 };
  
  const memValue = tom.createElement('text');
  memValue.textContent = '▓▓▓▓▓░░░░░ 52%';
  memValue.style = { color: '#4cc9f0' };
  
  memBox.appendChild(memTitle);
  memBox.appendChild(memValue);
  
  // Status message
  const status = tom.createElement('text');
  status.textContent = '✅ All systems operational';
  status.style = {
    color: '#4cc9f0',
    textAlign: 'center',
    marginTop: 1
  };
  
  // Assemble the dashboard
  dataContainer.appendChild(cpuBox);
  dataContainer.appendChild(memBox);
  
  dashboard.appendChild(title);
  dashboard.appendChild(dataContainer);
  dashboard.appendChild(status);
  
  tom.body.appendChild(dashboard);
  
  // Initial render
  tom.render();
  
  // Show the dashboard for a moment
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('\n📋 Dashboard will be preserved as static output when we exit...');
  
  // Automatic cleanup via `using` will preserve the final state
}

// Run the demo
preserveStateDemo().then(() => {
  console.log('✨ Notice how the dashboard remains visible in your terminal history!');
  console.log('🎯 This makes TOM apps feel like integrated terminal tools');
}).catch(console.error);