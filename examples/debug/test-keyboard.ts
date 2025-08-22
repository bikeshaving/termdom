/**
 * Simple keyboard test to debug input
 */

console.log('🔍 Keyboard Input Test');
console.log('Press any key (Q to quit)\n');

// Set up raw mode
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding('utf8');

let buffer = '';

process.stdin.on('data', (data: string) => {
  // Show hex values
  const bytes = [];
  for (let i = 0; i < data.length; i++) {
    bytes.push('0x' + data.charCodeAt(i).toString(16));
  }
  
  console.log(`Received: "${data}" (${bytes.join(' ')})`);
  
  // Check for escape sequences
  if (data[0] === '\x1b') {
    buffer += data;
    console.log(`  Escape buffer: "${buffer}"`);
    
    if (buffer === '\x1b[A') console.log('  → UP ARROW');
    else if (buffer === '\x1b[B') console.log('  → DOWN ARROW');
    else if (buffer === '\x1b[C') console.log('  → RIGHT ARROW');
    else if (buffer === '\x1b[D') console.log('  → LEFT ARROW');
    
    if (buffer.length > 3) buffer = '';
  } else {
    buffer = '';
    
    if (data === 'q' || data === 'Q') {
      console.log('\nExiting...');
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.exit(0);
    }
  }
});

// Exit after 30 seconds
setTimeout(() => {
  console.log('\nTimeout - exiting...');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.exit(0);
}, 30000);