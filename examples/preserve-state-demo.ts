/**
 * Demo showing how TTY preserves final UI state as static terminal output
 * 
 * This demonstrates how TTY applications feel integrated with terminal workflow
 * by leaving their final state visible in terminal history after exit.
 */

import { createTTYWindow } from '../src/index.js';

async function preserveStateDemo() {
  console.log('🎯 TTY Preserve State Demo');
  console.log('📊 This will show a data dashboard and preserve it after exit\n');
  
  using tty = createTTYWindow();
  
  // Create a data dashboard
  const dashboard = tty.document.createElement('container');
  dashboard.style = {
    backgroundColor: '#1a1a2e',
    padding: 2,
    border: 1,
    borderColor: '#16213e'
  };
  
  // Title
  const title = tty.document.createElement('text');
  title.textContent = '📊 System Dashboard - Final State';
  title.style = {
    color: '#4cc9f0',
    textAlign: 'center',
    marginBottom: 1
  };
  
  // Data section
  const dataContainer = tty.document.createElement('container');
  dataContainer.style = {
    flexDirection: 'row',
    gap: 2
  };
  
  // CPU info
  const cpuBox = tty.document.createElement('container');
  cpuBox.style = {
    backgroundColor: '#0f1c2e',
    padding: 1,
    border: 1,
    borderColor: '#2a4158',
    flex: 1
  };
  
  const cpuTitle = tty.document.createElement('text');
  cpuTitle.textContent = '🖥️  CPU Usage';
  cpuTitle.style = { color: '#7209b7', marginBottom: 1 };
  
  const cpuValue = tty.document.createElement('text');
  cpuValue.textContent = '▓▓▓▓▓▓▓░░░ 67%';
  cpuValue.style = { color: '#f72585' };
  
  cpuBox.appendChild(cpuTitle);
  cpuBox.appendChild(cpuValue);
  
  // Memory info
  const memBox = tty.document.createElement('container');
  memBox.style = {
    backgroundColor: '#0f1c2e',
    padding: 1,
    border: 1,
    borderColor: '#2a4158',
    flex: 1
  };
  
  const memTitle = tty.document.createElement('text');
  memTitle.textContent = '💾 Memory';
  memTitle.style = { color: '#7209b7', marginBottom: 1 };
  
  const memValue = tty.document.createElement('text');
  memValue.textContent = '▓▓▓▓▓░░░░░ 52%';
  memValue.style = { color: '#4cc9f0' };
  
  memBox.appendChild(memTitle);
  memBox.appendChild(memValue);
  
  // Status message
  const status = tty.document.createElement('text');
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
  
  tty.document.body.appendChild(dashboard);
  
  // Initial render
  tty.document.render();
  
  // Show the dashboard for a moment
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('\n📋 Dashboard will be preserved as static output when we exit...');
  
  // Automatic cleanup via `using` will preserve the final state
}

// Run the demo
preserveStateDemo().then(() => {
  console.log('✨ Notice how the dashboard remains visible in your terminal history!');
  console.log('🎯 This makes TTY apps feel like integrated terminal tools');
}).catch(console.error);