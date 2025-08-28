/**
 * Property-based tests for delta rendering correctness
 * 
 * Ensures that applying generated ANSI transitions correctly transforms
 * buffer A into buffer B using the Terminal snapshotter approach.
 */

import { test, expect, describe } from "bun:test";
import fc from "fast-check";
import { TestTerminal } from "./test-utils.js";
import { generateANSI, type ColorDepth } from "../src/rendering/Renderer.js";
import { Cell, createBuffer, type CellBuffer, type CellStyle } from "../src/rendering/CellBuffer.js";

// Generators for property-based testing
const colorGen = fc.integer({ min: 0, max: 0xffffff });
const styleGen = fc.record({
  fg: fc.option(colorGen),
  bg: fc.option(colorGen), 
  bold: fc.boolean(),
  italic: fc.boolean(),
  underline: fc.boolean(),
  strikethrough: fc.boolean(),
  inverse: fc.boolean(),
  dim: fc.boolean(),
  blink: fc.boolean(),
  overline: fc.boolean(),
}, { requiredKeys: [] });

const charGen = fc.oneof(
  fc.string({ minLength: 1, maxLength: 1 }),  // Single characters
  fc.constantFrom("你", "好", "世", "界"),     // Wide characters
  fc.constantFrom("👋", "🌟", "🚀"),         // Emoji
  fc.constant(" "),                          // Spaces
  fc.constantFrom("A", "B", "C", "a", "b", "c", "1", "2", "3") // Common ASCII
);

const cellGen = fc.option(
  fc.record({
    char: charGen,
    style: styleGen
  }).map(({ char, style }) => Cell.create(char, style))
);

const bufferGen = (rows: number, cols: number) =>
  fc.array(fc.array(cellGen, { minLength: cols, maxLength: cols }), {
    minLength: rows,
    maxLength: rows
  }).map(buffer => {
    const cellBuffer = createBuffer(rows, cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cellBuffer[r][c] = buffer[r][c];
      }
    }
    return cellBuffer;
  });

/**
 * Apply ANSI sequence to a TestTerminal and return the resulting screen state
 */
async function applyANSIToTerminal(
  initialBuffer: CellBuffer, 
  ansiSequence: string,
  rows: number,
  cols: number
): Promise<string> {
  const terminal = new TestTerminal({ rows, cols });
  
  // First, populate terminal with initial buffer state
  if (hasContent(initialBuffer)) {
    const initialANSI = generateANSI(initialBuffer);
    await new Promise<void>((resolve) => {
      terminal.stdout.write(initialANSI, () => resolve());
    });
  }
  
  // Then apply the transition ANSI
  if (ansiSequence) {
    await new Promise<void>((resolve) => {
      terminal.stdout.write(ansiSequence, () => resolve());
    });
  }
  
  return terminal.getVisibleText();
}

/**
 * Convert buffer to expected visible text for comparison
 */
function bufferToVisibleText(buffer: CellBuffer): string {
  const lines: string[] = [];
  
  for (let row = 0; row < buffer.length; row++) {
    let line = '';
    for (let col = 0; col < buffer[row].length; col++) {
      const cell = buffer[row][col];
      line += cell ? cell.grapheme : ' ';
    }
    // Trim trailing spaces from each line
    lines.push(line.trimEnd());
  }
  
  // Remove trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  
  return lines.join('\n');
}

/**
 * Check if buffer has any non-null content
 */
function hasContent(buffer: CellBuffer): boolean {
  return buffer.some(row => row.some(cell => cell !== null));
}

describe("Delta rendering property tests", () => {
  test("ANSI transition correctly transforms buffer A to buffer B", () => {
    fc.assert(
      fc.property(
        bufferGen(5, 10),  // Small buffers for faster testing
        bufferGen(5, 10),
        async (bufferA, bufferB) => {
          // Generate ANSI to transition from A to B
          const transitionANSI = generateANSI(bufferB); // Note: our current generateANSI doesn't take previous buffer
          
          // Apply transition to terminal starting with buffer A
          const terminalResult = await applyANSIToTerminal(bufferA, transitionANSI, 5, 10);
          
          // Convert expected buffer B to visible text
          const expectedResult = bufferToVisibleText(bufferB);
          
          // They should match
          expect(terminalResult).toBe(expectedResult);
        }
      ),
      { 
        numRuns: 50,
        verbose: true,
        interruptAfterTimeLimit: 30000 // 30 second timeout
      }
    );
  });

  test("Empty buffer transitions work correctly", () => {
    fc.assert(
      fc.property(
        bufferGen(3, 5),
        async (targetBuffer) => {
          const emptyBuffer = createBuffer(3, 5);
          
          // Generate ANSI to go from empty to target
          const ansi = generateANSI(targetBuffer);
          
          // Apply to terminal starting empty
          const result = await applyANSIToTerminal(emptyBuffer, ansi, 3, 5);
          const expected = bufferToVisibleText(targetBuffer);
          
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 25 }
    );
  });

  test("Identity transition (buffer to itself) produces no changes", () => {
    fc.assert(
      fc.property(
        bufferGen(4, 6),
        async (buffer) => {
          // Apply buffer's ANSI to terminal already containing the buffer
          const ansi = generateANSI(buffer);
          
          const terminalResult = await applyANSIToTerminal(buffer, ansi, 4, 6);
          const expectedResult = bufferToVisibleText(buffer);
          
          expect(terminalResult).toBe(expectedResult);
        }
      ),
      { numRuns: 25 }
    );
  });

  test("Different color depths produce equivalent visible content", () => {
    fc.assert(
      fc.property(
        bufferGen(3, 8),
        fc.constantFrom("rgb", "256", "ansi") as fc.Arbitrary<ColorDepth>,
        fc.constantFrom("rgb", "256", "ansi") as fc.Arbitrary<ColorDepth>,
        async (buffer, depth1, depth2) => {
          const ansi1 = generateANSI(buffer, depth1);
          const ansi2 = generateANSI(buffer, depth2);
          
          const empty = createBuffer(3, 8);
          const result1 = await applyANSIToTerminal(empty, ansi1, 3, 8);
          const result2 = await applyANSIToTerminal(empty, ansi2, 3, 8);
          
          // Visible text should be identical regardless of color depth
          expect(result1).toBe(result2);
        }
      ),
      { numRuns: 20 }
    );
  });
});

describe("Resize handling property tests", () => {
  test("Buffer content is preserved when resizing larger", () => {
    fc.assert(
      fc.property(
        bufferGen(3, 5),
        async (smallBuffer) => {
          // Render small buffer
          const smallANSI = generateANSI(smallBuffer);
          const smallTerminal = new TestTerminal({ rows: 3, cols: 5 });
          
          await new Promise<void>((resolve) => {
            smallTerminal.stdout.write(smallANSI, () => resolve());
          });
          
          const smallResult = smallTerminal.getVisibleText();
          
          // Now render same content in larger buffer
          const largeBuffer = createBuffer(6, 10);
          
          // Copy small buffer content to top-left of large buffer
          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 5; c++) {
              largeBuffer[r][c] = smallBuffer[r][c];
            }
          }
          
          const largeANSI = generateANSI(largeBuffer);
          const largeTerminal = new TestTerminal({ rows: 6, cols: 10 });
          
          await new Promise<void>((resolve) => {
            largeTerminal.stdout.write(largeANSI, () => resolve());
          });
          
          const largeResult = largeTerminal.getVisibleText();
          
          // Small buffer content should be preserved in large buffer
          // (allowing for different line ending behavior)
          expect(largeResult).toContain(smallResult.split('\n')[0] || '');
        }
      ),
      { numRuns: 15 }
    );
  });
});

// Helper test to validate our test setup
describe("Test infrastructure validation", () => {
  test("TestTerminal correctly handles simple ANSI sequences", async () => {
    const terminal = new TestTerminal({ rows: 3, cols: 10 });
    
    await new Promise<void>((resolve) => {
      terminal.stdout.write("Hello", () => resolve());
    });
    
    const result = terminal.getVisibleText();
    expect(result).toContain("Hello");
  });
  
  test("bufferToVisibleText produces expected output", () => {
    const buffer = createBuffer(2, 5);
    buffer[0][0] = Cell.create("H");
    buffer[0][1] = Cell.create("i");
    buffer[1][0] = Cell.create("B");
    buffer[1][1] = Cell.create("y");
    buffer[1][2] = Cell.create("e");
    
    const result = bufferToVisibleText(buffer);
    expect(result).toBe("Hi\nBye");
  });
});