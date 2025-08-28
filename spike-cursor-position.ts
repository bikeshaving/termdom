/**
 * Spike: Get current cursor position to determine commandStart
 */

async function getCursorPosition(): Promise<{ row: number; col: number }> {
  return new Promise((resolve, reject) => {
    // Check if we have TTY capabilities
    if (!process.stdin.isTTY) {
      reject(new Error('Not running in a TTY'));
      return;
    }

    // Set raw mode to capture escape sequences
    (process.stdin as any).setRawMode(true);
    process.stdin.resume();

    let response = '';

    const onData = (data: Buffer) => {
      response += data.toString();

      // Look for cursor position response: \x1b[{row};{col}R
      const match = response.match(/\x1b\[(\d+);(\d+)R/);
      if (match) {
        cleanup();
        const row = parseInt(match[1], 10);
        const col = parseInt(match[2], 10);
        resolve({ row, col });
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      (process.stdin as any).setRawMode(false);
      process.stdin.pause();
    };

    // Set timeout in case terminal doesn't respond
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Cursor position query timed out'));
    }, 1000);

    process.stdin.on('data', onData);

    // Query cursor position
    process.stdout.write('\x1b[6n');

    // Clear timeout when we get response
    const originalResolve = resolve;
    resolve = (value) => {
      clearTimeout(timeout);
      originalResolve(value);
    };
  });
}

// Test it
async function main() {
  const pos = await getCursorPosition();
  console.log(`Cursor is at row: ${pos.row}, col: ${pos.col}`);
  console.log(`Command would start at row: ${pos.row}`);
}

if (import.meta.main) {
  main();
}
