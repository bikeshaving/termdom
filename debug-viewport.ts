#!/usr/bin/env bun

/**
 * Debug viewport rendering issue
 */

import { TestTerminal } from "./tests/test-utils.js";
import { TermDOM } from "./src/termdom.js";

console.log("=== Debug Viewport Rendering ===\n");

const terminal = new TestTerminal({rows: 10, cols: 40});
console.log("1. Created terminal 10x40");

// Position cursor at row 8
await new Promise<void>((resolve) => {
    terminal.stdout.write("\x1b[8;1H", () => resolve());
});
console.log("2. Positioned cursor at row 8");

const dom = new TermDOM({process: terminal});
console.log("3. Created TermDOM");

// Test cursor detection
const row = await dom.detectCommandStart();
console.log("4. Cursor detection result:", row);
console.log("   - screenTop:", dom.window.screenTop);
console.log("   - scrollingManager.getScrollTop():", (dom as any).scrollingManager.getScrollTop());

// Check the scrolling state in detail
const scrollManager = (dom as any).scrollingManager;
console.log("   - scrolling details:");
console.log("     * screenTop:", scrollManager.getScreenTop());
console.log("     * scrollTop:", scrollManager.getScrollTop());
console.log("     * viewportOffset calculated:", -scrollManager.getScrollTop());

// Add content
dom.document.body.innerHTML = `<div>Content Line</div>`;
console.log("5. Added content to DOM");

// Patch stdout.write to capture ANSI output
let ansiOutput = '';
const originalWrite = terminal.stdout.write;
terminal.stdout.write = function(chunk: any, encoding?: any, callback?: any) {
    if (typeof chunk === 'string') {
        ansiOutput += chunk;
    }
    return originalWrite.call(this, chunk, encoding, callback);
};

// Render  
await dom.render();
console.log("6. Rendered content");
console.log("   - ANSI output:", JSON.stringify(ansiOutput));

// Debug: Check what's in the renderer buffer
const renderer = (dom as any).renderer;
const prevBuffer = renderer._prevBuffer || renderer['#prevBuffer'];
if (prevBuffer) {
    console.log("   - Renderer buffer state:");
    for (let row = 0; row < 10; row++) {
        let line = "";
        for (let col = 0; col < 40; col++) {
            const cell = prevBuffer[row][col];
            if (cell && cell.grapheme && cell.grapheme !== ' ') {
                line += cell.grapheme;
            } else {
                line += " ";
            }
        }
        if (line.trim()) {
            console.log(`     [${row}]: "${line.trimEnd()}"`);
        }
    }
}

// Check layout engine
const layoutEngine = (dom as any).layoutEngine;
const rect = layoutEngine.getRect(dom.document.body.firstElementChild);
console.log("   - Element rect:", rect);

const rectTexts = layoutEngine.getRectTexts(dom.document.body.firstElementChild.firstChild);
console.log("   - Text rects:", rectTexts);

// Check output
const lines = terminal.getPlainText().split("\n");
console.log("7. Terminal output:");
lines.forEach((line, i) => {
    console.log(`   [${i}]: "${line}"`);
});

console.log("\n8. Expected: 'Content Line' at index 7");
console.log(`   Actual: lines[7] = "${lines[7]}"`);

dom.dispose();