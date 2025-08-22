/**
 * Animated TOM Demo - Shows real-time updates with auto-timeout
 * 
 * Features:
 * - Auto-exits after 15 seconds
 * - Real-time animations and updates
 * - Progress indicators
 * - Safe cleanup on Ctrl+C
 */

import { createTOM } from '../src/index.js';

function animatedDemo() {
  console.log('🎬 Starting Animated TOM Demo...');
  console.log('⏰ Will auto-exit in 15 seconds (Ctrl+C to quit early)\n');
  
  const tom = createTOM();
  let isRunning = true;
  let frame = 0;
  
  // Set up timeout to auto-exit
  const timeout = setTimeout(() => {
    console.log('\n⏰ Demo completed - exiting...');
    cleanup();
  }, 15000);
  
  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('\n👋 Caught Ctrl+C - exiting gracefully...');
    cleanup();
  });
  
  // Cleanup function
  function cleanup() {
    if (!isRunning) return;
    isRunning = false;
    
    clearTimeout(timeout);
    clearInterval(animationLoop);
    tom.destroy();
    
    // Restore terminal
    process.stdout.write('\x1b[?25h'); // Show cursor
    process.stdout.write('\x1b[0m');   // Reset colors
    
    console.log('✅ Demo cleaned up');
    process.exit(0);
  }
  
  // Create main container
  const mainContainer = tom.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [1, 2, 1, 2];
  mainContainer.style.backgroundColor = 'blue';
  tom.body.appendChild(mainContainer);
  
  // Animated title
  const title = tom.createElement('text');
  title.style.textAlign = 'center';
  title.style.color = 'white';
  title.style.backgroundColor = 'darkBlue';
  title.style.padding = [1, 2, 1, 2];
  mainContainer.appendChild(title);
  
  // Progress container
  const progressContainer = tom.createElement('container');
  progressContainer.style.flexDirection = 'row';
  progressContainer.style.padding = [1, 1, 1, 1];
  progressContainer.style.backgroundColor = 'darkGray';
  mainContainer.appendChild(progressContainer);
  
  // Progress bar elements
  const progressBars: any[] = [];
  for (let i = 0; i < 20; i++) {
    const bar = tom.createElement('text');
    bar.textContent = '█';
    bar.style.color = 'gray';
    progressContainer.appendChild(bar);
    progressBars.push(bar);
  }
  
  // Status displays
  const statusContainer = tom.createElement('container');
  statusContainer.style.flexDirection = 'column';
  statusContainer.style.padding = [1, 1, 1, 1];
  mainContainer.appendChild(statusContainer);
  
  // CPU Usage simulation
  const cpuStatus = tom.createElement('text');
  cpuStatus.style.color = 'green';
  cpuStatus.style.backgroundColor = 'black';
  cpuStatus.style.padding = [0, 1, 0, 1];
  statusContainer.appendChild(cpuStatus);
  
  // Memory Usage simulation  
  const memoryStatus = tom.createElement('text');
  memoryStatus.style.color = 'yellow';
  memoryStatus.style.backgroundColor = 'black';
  memoryStatus.style.padding = [0, 1, 0, 1];
  statusContainer.appendChild(memoryStatus);
  
  // Network Status
  const networkStatus = tom.createElement('text');
  networkStatus.style.color = 'cyan';
  networkStatus.style.backgroundColor = 'black';
  networkStatus.style.padding = [0, 1, 0, 1];
  statusContainer.appendChild(networkStatus);
  
  // Activity feed
  const activityFeed = tom.createElement('container');
  activityFeed.style.flexDirection = 'column';
  activityFeed.style.backgroundColor = 'darkGreen';
  activityFeed.style.padding = [1, 1, 1, 1];
  mainContainer.appendChild(activityFeed);
  
  const activityTitle = tom.createElement('text');
  activityTitle.textContent = '📈 Activity Feed';
  activityTitle.style.color = 'white';
  activityTitle.style.textAlign = 'center';
  activityFeed.appendChild(activityTitle);
  
  const activities: any[] = [];
  const activityMessages = [
    '🚀 Launching new process...',
    '📦 Package downloaded',
    '⚡ Cache updated', 
    '🔍 Scanning files...',
    '✅ Task completed',
    '🌐 Network request sent',
    '💾 Data saved to disk',
    '🔄 Refreshing UI...'
  ];
  
  // Create activity items
  for (let i = 0; i < 4; i++) {
    const activity = tom.createElement('text');
    activity.style.color = 'lightGreen';
    activity.style.padding = [0, 1, 0, 1];
    activityFeed.appendChild(activity);
    activities.push(activity);
  }
  
  // Timer display
  const timerDisplay = tom.createElement('text');
  timerDisplay.style.textAlign = 'center';
  timerDisplay.style.color = 'white';
  timerDisplay.style.backgroundColor = 'red';
  timerDisplay.style.padding = [1, 0, 1, 0];
  mainContainer.appendChild(timerDisplay);
  
  // Animation state
  let secondsElapsed = 0;
  let progressValue = 0;
  
  // Animation loop
  const animationLoop = setInterval(() => {
    if (!isRunning) return;
    
    frame++;
    secondsElapsed = Math.floor(frame / 10); // 10 FPS = 1 second per 10 frames
    progressValue = Math.min(20, Math.floor((frame / 150) * 20)); // Complete in 15 seconds
    
    // Update animated title
    const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const spinner = spinners[frame % spinners.length];
    title.textContent = `${spinner} TOM Real-time Dashboard ${spinner}`;
    
    // Update progress bar
    progressBars.forEach((bar, index) => {
      if (index < progressValue) {
        bar.style.color = index < progressValue - 3 ? 'green' : 'yellow';
      } else {
        bar.style.color = 'darkGray';
      }
    });
    
    // Update system stats with random values
    const cpuUsage = Math.floor(Math.random() * 30) + 20;
    const memoryUsage = Math.floor(Math.random() * 40) + 30;
    const networkSpeed = Math.floor(Math.random() * 100) + 50;
    
    cpuStatus.textContent = `🖥️  CPU: ${cpuUsage.toString().padStart(2)}%`;
    memoryStatus.textContent = `💾 RAM: ${memoryUsage.toString().padStart(2)}%`;
    networkStatus.textContent = `🌐 NET: ${networkSpeed.toString().padStart(3)} Mbps`;
    
    // Update activity feed every 2 seconds
    if (frame % 20 === 0) {
      const newActivity = activityMessages[Math.floor(Math.random() * activityMessages.length)];
      // Shift activities up and add new one
      for (let i = activities.length - 1; i > 0; i--) {
        activities[i].textContent = activities[i - 1].textContent;
      }
      activities[0].textContent = newActivity;
    }
    
    // Update timer
    const remaining = 15 - secondsElapsed;
    timerDisplay.textContent = `⏰ ${remaining} seconds remaining`;
    
    // Render the frame
    tom.render();
    
    // Check if demo should end
    if (secondsElapsed >= 15) {
      cleanup();
    }
  }, 100); // 10 FPS
  
  // Hide cursor and start
  process.stdout.write('\x1b[?25l'); // Hide cursor
  tom.render();
}

animatedDemo();