#!/usr/bin/env bun

/**
 * Debug DrawingContext behavior
 */

import { TestTerminal } from "./tests/test-utils.js";
import { TermDOM } from "./src/termdom.js";

console.log("=== Debug DrawingContext ===\n");

const terminal = new TestTerminal({rows: 10, cols: 40});

// Position cursor at row 8  
await new Promise<void>((resolve) => {
    terminal.stdout.write("\x1b[8;1H", () => resolve());
});

const dom = new TermDOM({process: terminal});
await dom.detectCommandStart();

// Add content
dom.document.body.innerHTML = `<div>Test</div>`;

// Patch the renderer to add debugging
const renderer = (dom as any).renderer;
const originalRenderFrame = renderer.renderFrame.bind(renderer);

renderer.renderFrame = function(offset: number, drawCallback: any) {
    console.log("renderFrame called with offset:", offset);
    
    // Create mock drawing context with debugging
    const mockBuffer = Array(10).fill(null).map(() => Array(40).fill(null));
    const mockContext = {
        buffer: mockBuffer,
        rows: 10,
        cols: 40,
        viewportOffset: offset,
        setText: function(x: number, y: number, text: string, style?: any) {
            console.log(`setText called: x=${x}, y=${y}, text="${text}"`);
            console.log(`  - terminalRow = ${y} + ${offset} = ${y + offset}`);
            
            // Check bounds
            if (y + offset >= 0 && y + offset < 10 && x >= 0 && x < 40) {
                console.log(`  - Writing to terminal row ${y + offset}`);
            } else {
                console.log(`  - OUT OF BOUNDS! Row ${y + offset} not in range [0, 9]`);
            }
        },
        fillRect: function() {},
        drawBorder: function() {}
    };
    
    console.log("Calling drawCallback with mock context...");
    drawCallback(mockContext);
    
    // Call original method
    return originalRenderFrame(offset, drawCallback);
};

console.log("About to render...");
await dom.render();

console.log("Render complete");
dom.dispose();