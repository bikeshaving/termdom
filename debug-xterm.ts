#!/usr/bin/env bun

/**
 * Debug script to test xterm.js headless behavior directly
 */

import { Terminal } from "@xterm/headless";

console.log("=== Testing xterm.js headless directly ===\n");

// Create terminal
const terminal = new Terminal({
  cols: 80,
  rows: 24,
  allowProposedApi: true,
});

console.log("1. Created terminal:", {
  cols: terminal.cols,
  rows: terminal.rows,
});

// Test basic write
console.log("\n2. Testing basic write...");
terminal.write("Hello World");

// Check buffer immediately
console.log("Buffer after write:");
const buffer = terminal.buffer.active;
console.log("- Buffer rows:", buffer.length);
console.log("- First line content:", buffer.getLine(0)?.translateToString());

// Test with callback
console.log("\n3. Testing write with callback...");
terminal.write("Test with callback", () => {
  console.log("Write callback executed");
  console.log("- First line content:", buffer.getLine(0)?.translateToString());
});

// Test cursor query
console.log("\n4. Testing cursor position query...");
let cursorResponse = "";

terminal.onData((data) => {
  console.log("onData received:", JSON.stringify(data));
  cursorResponse += data;
});

terminal.write("\x1b[6n");
console.log("Sent cursor query, waiting for response...");

// Wait and check response
setTimeout(() => {
  console.log("After 100ms:");
  console.log("- Cursor response:", JSON.stringify(cursorResponse));
  console.log("- Buffer content:", buffer.getLine(0)?.translateToString());
  
  // Test positioning
  console.log("\n5. Testing cursor positioning...");
  terminal.write("\x1b[2;5H"); // Move to row 2, col 5
  terminal.write("POSITIONED");
  
  console.log("- Line 1:", buffer.getLine(1)?.translateToString());
  
  // Another cursor query
  terminal.write("\x1b[6n");
  
  setTimeout(() => {
    console.log("\nAfter positioning:");
    console.log("- Cursor response:", JSON.stringify(cursorResponse));
    console.log("- Line 0:", buffer.getLine(0)?.translateToString());
    console.log("- Line 1:", buffer.getLine(1)?.translateToString());
    
    // Test with newlines
    console.log("\n6. Testing newlines...");
    terminal.write("\r\nLine 1\r\nLine 2\r\nLine 3");
    
    setTimeout(() => {
      console.log("After newlines:");
      for (let i = 0; i < 5; i++) {
        const line = buffer.getLine(i)?.translateToString();
        if (line && line.trim()) {
          console.log(`- Line ${i}:`, JSON.stringify(line));
        }
      }
      
      console.log("\n=== Debug complete ===");
    }, 50);
  }, 50);
}, 100);