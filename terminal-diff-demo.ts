import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

// Helper to promisify terminal write
function writeAsync(term: Terminal, data: string): Promise<void> {
  return new Promise(resolve => term.write(data, resolve));
}

async function main() {
  // Create terminals
  const term1 = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
  const term2 = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
  const diffTerm = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });

  // Write same content to both terminals initially
  await writeAsync(term1, '\x1b[31mHello\x1b[0m'); // Red
  await writeAsync(term1, '\r\n');
  await writeAsync(term1, '\x1b[32mWorld\x1b[0m'); // Green

  await writeAsync(term2, '\x1b[31mHello\x1b[0m'); // Red
  await writeAsync(term2, '\r\n');
  await writeAsync(term2, '\x1b[32mWorld\x1b[0m'); // Green

  // Now make surgical changes to term2's buffer:
  // 1. Change style of 'H' at (0,0) to bold red
  // 2. Change style of 'o' at (1,1) to italic green  
  // 3. Change character 'r' to 'R' at (1,2)

  // Access internal buffers
  const buffer1 = (term1.buffer.active as any)._buffer;
  const buffer2 = (term2.buffer.active as any)._buffer;
  const diffBuffer = (diffTerm.buffer.active as any)._buffer;
  
  if (!buffer1 || !buffer2 || !diffBuffer) {
    console.error('Could not access internal buffers');
    return;
  }

  // Make surgical edits to term2
  const line0 = buffer2.lines.get(0);
  const line1 = buffer2.lines.get(1);
  
  // 1. Make 'H' bold (row 0, col 0)
  const hCell = buffer2.getNullCell();
  line0.loadCell(0, hCell);
  hCell.fg |= 0x8000000; // BOLD flag
  hCell.content = 'H'.charCodeAt(0) | (1 << 22); // char + width
  line0.setCell(0, hCell);
  
  // 2. Make 'o' in "World" italic (row 1, col 1)
  const oCell = buffer2.getNullCell();
  line1.loadCell(1, oCell);
  oCell.bg |= 0x4000000; // ITALIC flag
  oCell.content = 'o'.charCodeAt(0) | (1 << 22); // char + width
  line1.setCell(1, oCell);
  
  // 3. Change 'r' to 'R' in "World" (row 1, col 2) AND make it underlined
  const rCell = buffer2.getNullCell();
  line1.loadCell(2, rCell);
  rCell.fg |= 0x10000000; // UNDERLINE flag
  rCell.content = 'R'.charCodeAt(0) | (1 << 22); // 'R' + width
  line1.setCell(2, rCell);
  
  // Create reusable cells for comparison
  const cell1 = buffer1.getNullCell();
  const cell2 = buffer2.getNullCell();
  
  // Compare terminals and copy only differences to diffTerm
  for (let row = 0; row < 5; row++) {
    const line1 = buffer1.lines.get(row);
    const line2 = buffer2.lines.get(row);
    const diffLine = diffBuffer.lines.get(row);
    
    if (!line1 || !line2 || !diffLine) continue;
    
    for (let col = 0; col < 10; col++) {
      // Load cells to compare
      line1.loadCell(col, cell1);
      line2.loadCell(col, cell2);
      
      // Compare raw cell data
      if (cell1.content !== cell2.content ||
          cell1.fg !== cell2.fg ||
          cell1.bg !== cell2.bg) {
        
        // Copy cell2 to diff buffer
        diffLine.setCell(col, cell2);
      }
    }
  }

  // Add serializers
  const term1Serializer = new SerializeAddon();
  term1.loadAddon(term1Serializer);

  const term2Serializer = new SerializeAddon();
  term2.loadAddon(term2Serializer);

  const diffSerializer = new SerializeAddon();
  diffTerm.loadAddon(diffSerializer);

  console.log('=== Original Terminal (term1) ===');
  console.log(term1Serializer.serialize());

  console.log('\n=== Updated Terminal (term2) ===');
  console.log(term2Serializer.serialize());

  console.log('\n=== Diff Terminal (only changed cells) ===');
  const diffOutput = diffSerializer.serialize();
  console.log(diffOutput);

  // Show what the diff looks like when applied
  console.log('\n=== Raw diff output for debugging ===');
  console.log(JSON.stringify(diffOutput));
  
  // Test: Let's put R at position 4 instead of 2
  console.log('\n=== Test: R at position 4 ===');
  const testTerm = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
  const testBuffer = (testTerm.buffer.active as any)._buffer;
  const testSerializer = new SerializeAddon();
  testTerm.loadAddon(testSerializer);
  
  // Put 'o' at position 1 and 'R' at position 4
  const testLine1 = testBuffer.lines.get(1);
  const testOCell = buffer2.getNullCell();
  const testRCell = buffer2.getNullCell();
  
  buffer2.lines.get(1).loadCell(1, testOCell); // Load 'o' 
  testLine1.setCell(1, testOCell);
  
  buffer2.lines.get(1).loadCell(2, testRCell); // Load 'R'
  testLine1.setCell(4, testRCell);  // Put at position 4 instead
  
  // Debug what's actually in the test buffer
  console.log('Test buffer contents:');
  const debugCell = testBuffer.getNullCell();
  for (let i = 0; i < 5; i++) {
    testLine1.loadCell(i, debugCell);
    console.log(`  [${i}]: "${String.fromCharCode(debugCell.content)}" (${debugCell.content})`);
  }
  
  const testOutput = testSerializer.serialize();
  console.log('Serialized:', testOutput);
  console.log('JSON:', JSON.stringify(testOutput));
  
  // Let's also manually check what changed
  console.log('\n=== Manual inspection of changes ===');
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 5; col++) {
      const line1 = buffer1.lines.get(row);
      const line2 = buffer2.lines.get(row);
      line1.loadCell(col, cell1);
      line2.loadCell(col, cell2);
      
      if (cell1.content !== cell2.content || cell1.fg !== cell2.fg || cell1.bg !== cell2.bg) {
        console.log(`Changed at (${row},${col}): "${String.fromCharCode(cell1.content)}" → "${String.fromCharCode(cell2.content)}", fg: 0x${cell1.fg.toString(16)} → 0x${cell2.fg.toString(16)}, bg: 0x${cell1.bg.toString(16)} → 0x${cell2.bg.toString(16)}`);
      }
    }
  }
  
  // Check what's in the diff buffer
  console.log('\n=== Diff buffer contents ===');
  const diffCell = diffBuffer.getNullCell();
  for (let row = 0; row < 2; row++) {
    const diffLine = diffBuffer.lines.get(row);
    let rowStr = '';
    for (let col = 0; col < 5; col++) {
      diffLine.loadCell(col, diffCell);
      if (diffCell.content !== 0) {
        rowStr += `[${String.fromCharCode(diffCell.content)}]`;
      } else {
        rowStr += '[ ]';
      }
    }
    console.log(`Row ${row}: ${rowStr}`);
  }

  // === SIMULATE SECOND RENDER ===
  console.log('\n\n=== SECOND RENDER CYCLE ===');
  
  // Try clear() instead of reset()
  diffTerm.clear();
  
  // Reuse the same diffBuffer and diffSerializer
  
  // Update term1 to be what term2 was (simulating previous frame becoming current)
  term1.reset();
  await writeAsync(term1, '\x1b[31;1mH\x1b[22mello'); // Bold H
  await writeAsync(term1, '\r\n');
  await writeAsync(term1, '\x1b[32mW\x1b[3mo\x1b[4;23mR\x1b[24mld\x1b[0m'); // Italic o, underlined R
  
  // Now make NEW changes to term2
  term2.reset();
  await writeAsync(term2, '\x1b[31;1mH\x1b[22mello'); // Keep bold H
  await writeAsync(term2, '\r\n');
  await writeAsync(term2, '\x1b[32mW\x1b[3mo\x1b[4;23mR\x1b[24mld\x1b[0m'); // Keep italic o, underlined R
  
  // Make new surgical changes to term2:
  // 1. Change 'e' at (0,1) to 'E' 
  // 2. Add inverse video to 'W' at (1,0)
  // 3. Remove underline from 'R' at (1,2)
  
  const line0_v2 = buffer2.lines.get(0);
  const line1_v2 = buffer2.lines.get(1);
  
  // 1. Change 'e' to 'E' at position 1
  const eCell = buffer2.getNullCell();
  line0_v2.loadCell(1, eCell);
  eCell.content = 'E'.charCodeAt(0) | (1 << 22); // Change to 'E'
  line0_v2.setCell(1, eCell);
  
  // 2. Add inverse video to 'W'
  const wCell = buffer2.getNullCell();
  line1_v2.loadCell(0, wCell);
  wCell.fg |= 0x2000000; // INVERSE flag (bit 26)
  line1_v2.setCell(0, wCell);
  
  // 3. Remove underline from 'R' (keep italic from 'o')
  const rCell2 = buffer2.getNullCell();
  line1_v2.loadCell(2, rCell2);
  rCell2.fg &= ~0x10000000; // Clear UNDERLINE flag
  rCell2.bg &= ~0x4000000; // Also clear italic that was on 'o'
  line1_v2.setCell(2, rCell2);
  
  // Run diff comparison again
  console.log('\n=== Comparing render 1 vs render 2 ===');
  for (let row = 0; row < 5; row++) {
    const line1 = buffer1.lines.get(row);
    const line2 = buffer2.lines.get(row);
    const diffLine = diffBuffer.lines.get(row);
    
    if (!line1 || !line2 || !diffLine) continue;
    
    for (let col = 0; col < 10; col++) {
      line1.loadCell(col, cell1);
      line2.loadCell(col, cell2);
      
      if (cell1.content !== cell2.content ||
          cell1.fg !== cell2.fg ||
          cell1.bg !== cell2.bg) {
        diffLine.setCell(col, cell2);
      }
    }
  }
  
  // Serialize the new diff
  console.log('\n=== New diff output ===');
  const newDiffOutput = diffSerializer.serialize();
  console.log(newDiffOutput);
  console.log('\nJSON:', JSON.stringify(newDiffOutput));
  
  // Show what changed this time
  console.log('\n=== Changes in second render ===');
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 5; col++) {
      const line1 = buffer1.lines.get(row);
      const line2 = buffer2.lines.get(row);
      line1.loadCell(col, cell1);
      line2.loadCell(col, cell2);
      
      if (cell1.content !== cell2.content || cell1.fg !== cell2.fg || cell1.bg !== cell2.bg) {
        console.log(`Changed at (${row},${col}): "${String.fromCharCode(cell1.content)}" → "${String.fromCharCode(cell2.content)}", fg: 0x${cell1.fg.toString(16)} → 0x${cell2.fg.toString(16)}, bg: 0x${cell1.bg.toString(16)} → 0x${cell2.bg.toString(16)}`);
      }
    }
  }
  
  // Check what's actually in the diff buffer after second render
  console.log('\n=== Diff buffer after second render ===');
  for (let row = 0; row < 2; row++) {
    const diffLine = diffBuffer.lines.get(row);
    let rowStr = '';
    for (let col = 0; col < 5; col++) {
      diffLine.loadCell(col, diffCell);
      if (diffCell.content !== 0) {
        rowStr += `[${String.fromCharCode(diffCell.content & 0x1FFFFF)}]`;
      } else {
        rowStr += '[ ]';
      }
    }
    console.log(`Row ${row}: ${rowStr}`);
  }
}

main().catch(console.error);