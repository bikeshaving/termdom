#!/usr/bin/env bun

/**
 * Debug cursor detection in TermDOM specifically
 */

import { TestTerminal } from "./tests/test-utils.js";
import { TermDOM } from "./src/termdom.js";

console.log("=== Debug TermDOM Cursor Detection ===\n");

const terminal = new TestTerminal();
console.log("1. Created TestTerminal");

// Listen to all stdin data
terminal.stdin.on("data", (data: Buffer) => {
  console.log("🎧 TestTerminal stdin received:", JSON.stringify(data.toString()));
});

console.log("2. Creating TermDOM...");
const dom = new TermDOM({ process: terminal });

console.log("3. TermDOM created, testing manual cursor detection...");

try {
  const result = await Promise.race([
    dom.detectCommandStart(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Manual timeout")), 2000))
  ]);
  console.log("✅ Cursor detection succeeded:", result);
} catch (error) {
  console.log("❌ Cursor detection failed:", error.message);
}

console.log("4. Testing render...");
const span = dom.document.createElement("span");
span.textContent = "Test";
dom.document.body.appendChild(span);

try {
  await dom.render();
  console.log("✅ Render succeeded");
} catch (error) {
  console.log("❌ Render failed:", error.message);
}

dom.dispose();
console.log("5. Disposed TermDOM");