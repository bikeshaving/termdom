#!/usr/bin/env bun

/**
 * Debug xterm.js color behavior in headless mode
 */

import { Terminal } from "@xterm/headless";

console.log("=== Debug xterm.js Color Behavior ===\n");

const terminal = new Terminal({
  cols: 80,
  rows: 24,
  allowProposedApi: true
});

console.log("1. Created headless terminal");

// Test basic ANSI red
terminal.write("\x1b[31mBasic Red\x1b[0m");
console.log("2. Wrote basic red text");

// Check what's in the buffer
const buffer = terminal.buffer.active;
const line = buffer.getLine(0);

if (line) {
  const cell = line.getCell(0); // First character
  if (cell) {
    console.log("3. Cell analysis:");
    console.log("   - Characters:", JSON.stringify(cell.getChars()));
    console.log("   - FG Color Mode:", cell.getFgColorMode());
    console.log("   - FG Color:", cell.getFgColor());
    console.log("   - BG Color Mode:", cell.getBgColorMode());
    console.log("   - BG Color:", cell.getBgColor());
    console.log("   - Bold:", cell.isBold());
  }
}

// Test with explicit theme
console.log("\n4. Testing with explicit theme...");

const themedTerminal = new Terminal({
  cols: 80,
  rows: 24,
  allowProposedApi: true,
  theme: {
    red: '#ff0000',  // Explicit bright red
    foreground: '#ffffff',
    background: '#000000'
  }
});

themedTerminal.write("\x1b[31mThemed Red\x1b[0m");

const themedBuffer = themedTerminal.buffer.active;
const themedLine = themedBuffer.getLine(0);

if (themedLine) {
  const themedCell = themedLine.getCell(0);
  if (themedCell) {
    console.log("5. Themed cell analysis:");
    console.log("   - Characters:", JSON.stringify(themedCell.getChars()));
    console.log("   - FG Color Mode:", themedCell.getFgColorMode());
    console.log("   - FG Color:", themedCell.getFgColor());
    console.log("   - BG Color Mode:", themedCell.getBgColorMode());
    console.log("   - BG Color:", themedCell.getBgColor());
  }
}