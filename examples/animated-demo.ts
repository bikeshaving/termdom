/**
 * Animated TOM Demo - Shows real-time updates with auto-timeout
 *
 * Features:
 * - Auto-exits after 15 seconds
 * - Real-time animations and updates
 * - Progress indicators
 * - Safe cleanup on Ctrl+C
 */

import { createTTY, BunTTYRuntime } from '../src/index.js';

async function animatedDemo() {
  console.log('🎬 Starting Animated TOM Demo...');
  console.log('⏰ Will auto-exit in 15 seconds (Ctrl+C to quit early)\n');

  const runtime = new BunTTYRuntime();
  const { document, dispose } = createTTY({ runtime });
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
    dispose();

    console.log('✅ Demo cleaned up');
    process.exit(0);
  }

  // Create main container
  const mainContainer = document.createElement('div');
  mainContainer.style.setProperty('display', 'flex');
  mainContainer.style.setProperty('flex-direction', 'column');
  mainContainer.style.setProperty('padding', '5px');
  mainContainer.style.setProperty('background-color', 'blue');
  document.body.appendChild(mainContainer);

  // Animated title
  const title = document.createElement('span');
  title.style.setProperty('text-align', 'center');
  title.style.setProperty('color', 'white');
  title.style.setProperty('background-color', 'darkBlue');
  title.style.setProperty('padding', '5px');
  mainContainer.appendChild(title);

  // Progress container
  const progressContainer = document.createElement('div');
  progressContainer.style.setProperty('display', 'flex');
  progressContainer.style.setProperty('flex-direction', 'row');
  progressContainer.style.setProperty('padding', '3px');
  progressContainer.style.setProperty('background-color', 'darkGray');
  mainContainer.appendChild(progressContainer);

  // Progress bar elements
  const progressBars: any[] = [];
  for (let i = 0; i < 20; i++) {
    const bar = document.createElement('span');
    bar.textContent = '█';
    bar.style.setProperty('color', 'gray');
    progressContainer.appendChild(bar);
    progressBars.push(bar);
  }

  // Status displays
  const statusContainer = document.createElement('div');
  statusContainer.style.setProperty('display', 'flex');
  statusContainer.style.setProperty('flex-direction', 'column');
  statusContainer.style.setProperty('padding', '3px');
  mainContainer.appendChild(statusContainer);

  // CPU Usage simulation
  const cpuStatus = document.createElement('span');
  cpuStatus.style.setProperty('color', 'green');
  cpuStatus.style.setProperty('background-color', 'black');
  cpuStatus.style.setProperty('padding', '1px 3px');
  statusContainer.appendChild(cpuStatus);

  // Memory Usage simulation
  const memoryStatus = document.createElement('span');
  memoryStatus.style.setProperty('color', 'yellow');
  memoryStatus.style.setProperty('background-color', 'black');
  memoryStatus.style.setProperty('padding', '1px 3px');
  statusContainer.appendChild(memoryStatus);

  // Network Status
  const networkStatus = document.createElement('span');
  networkStatus.style.setProperty('color', 'cyan');
  networkStatus.style.setProperty('background-color', 'black');
  networkStatus.style.setProperty('padding', '1px 3px');
  statusContainer.appendChild(networkStatus);

  // Activity feed
  const activityFeed = document.createElement('div');
  activityFeed.style.setProperty('display', 'flex');
  activityFeed.style.setProperty('flex-direction', 'column');
  activityFeed.style.setProperty('background-color', 'darkGreen');
  activityFeed.style.setProperty('padding', '3px');
  mainContainer.appendChild(activityFeed);

  const activityTitle = document.createElement('span');
  activityTitle.textContent = '📈 Activity Feed';
  activityTitle.style.setProperty('color', 'white');
  activityTitle.style.setProperty('text-align', 'center');
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
    const activity = document.createElement('span');
    activity.style.setProperty('color', 'lightGreen');
    activity.style.setProperty('padding', '1px 3px');
    activityFeed.appendChild(activity);
    activities.push(activity);
  }

  // Timer display
  const timerDisplay = document.createElement('span');
  timerDisplay.style.setProperty('text-align', 'center');
  timerDisplay.style.setProperty('color', 'white');
  timerDisplay.style.setProperty('background-color', 'red');
  timerDisplay.style.setProperty('padding', '3px 0');
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
        bar.style.setProperty('color', index < progressValue - 3 ? 'green' : 'yellow');
      } else {
        bar.style.setProperty('color', 'darkGray');
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

    // Check if demo should end
    if (secondsElapsed >= 15) {
      cleanup();
    }
  }, 100); // 10 FPS
}

animatedDemo();
