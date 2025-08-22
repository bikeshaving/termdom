/**
 * Raw mouse input test - see what we're receiving
 */

console.log('🔍 Raw Mouse Input Test');
console.log('Move your mouse around, click buttons');
console.log('Press Q to quit\n');

// Enable mouse tracking
process.stdout.write('\x1b[?1003h'); // Mouse motion tracking
process.stdout.write('\x1b[?1006h'); // SGR extended mode

// Set raw mode
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let buffer = '';

process.stdin.on('data', (data: Buffer) => {
  const str = data.toString();
  
  // Show raw bytes
  const bytes = [];
  for (let i = 0; i < data.length; i++) {
    bytes.push(data[i].toString(16).padStart(2, '0'));
  }
  
  console.log(`Raw: [${bytes.join(' ')}] = "${str.replace(/\x1b/g, 'ESC')}"`);
  
  // Try to parse mouse
  if (str.includes('\x1b[<')) {
    const match = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (match) {
      const [, btn, x, y, action] = match;
      console.log(`  → Mouse: button=${btn} x=${x} y=${y} action=${action}`);
    }
  }
  
  // Quit on 'q'
  if (str === 'q' || str === 'Q') {
    // Disable mouse
    process.stdout.write('\x1b[?1003l');
    process.stdout.write('\x1b[?1006l');
    
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(0);
  }
});

// Timeout
setTimeout(() => {
  console.log('\nTimeout');
  process.stdout.write('\x1b[?1003l');
  process.stdout.write('\x1b[?1006l');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.exit(0);
}, 30000);