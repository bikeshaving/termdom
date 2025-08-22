/**
 * Unit tests for text breaking algorithms
 */

import { test, expect } from "bun:test";
import { SimpleGreedyTextBreaker } from '../src/text/SimpleGreedyTextBreaker.js';
import { GreedyTextBreaker } from '../src/text/GreedyTextBreaker.js';

test("SimpleGreedyTextBreaker - basic word wrapping", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "Hello world this is a test";
  const result = breaker.breakText(text, { maxWidth: 10 });
  
  expect(result.lines.length).toBe(3);
  expect(result.lines[0].text).toBe("Hello ");
  expect(result.lines[1].text).toBe("world this ");
  expect(result.lines[2].text).toBe("is a test");
});

test("SimpleGreedyTextBreaker - exact width fit", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "Fits exactly";
  const result = breaker.breakText(text, { maxWidth: 12 });
  
  expect(result.lines.length).toBe(1);
  expect(result.lines[0].text).toBe("Fits exactly");
  expect(result.lines[0].width).toBe(12);
});

test("SimpleGreedyTextBreaker - long word breaking", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "supercalifragilisticexpialidocious";
  const result = breaker.breakText(text, { maxWidth: 10, breakWords: true });
  
  expect(result.lines.length).toBeGreaterThan(1);
  result.lines.forEach(line => {
    expect(line.width).toBeLessThanOrEqual(10);
  });
  
  // Verify the word is fully reconstructed
  const reconstructed = result.lines.map(l => l.text).join('');
  expect(reconstructed).toBe(text);
});

test("SimpleGreedyTextBreaker - no word breaking when disabled", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "verylongword short";
  const result = breaker.breakText(text, { maxWidth: 10, breakWords: false });
  
  // The long word should be on its own line even if it exceeds width
  expect(result.lines.length).toBe(2);
  expect(result.lines[0].text).toBe("verylongword ");
  expect(result.lines[1].text).toBe("short");
});

test("SimpleGreedyTextBreaker - empty text", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const result = breaker.breakText("", { maxWidth: 10 });
  
  expect(result.lines.length).toBe(0);
  expect(result.totalHeight).toBe(0);
  expect(result.maxLineWidth).toBe(0);
});

test("SimpleGreedyTextBreaker - single character", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const result = breaker.breakText("A", { maxWidth: 1 });
  
  expect(result.lines.length).toBe(1);
  expect(result.lines[0].text).toBe("A");
  expect(result.lines[0].width).toBe(1);
});

test("SimpleGreedyTextBreaker - multiple spaces", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "Hello    world"; // Multiple spaces
  const result = breaker.breakText(text, { maxWidth: 20 });
  
  expect(result.lines.length).toBe(1);
  expect(result.lines[0].text).toBe("Hello    world");
});

test("SimpleGreedyTextBreaker - trailing spaces", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "Hello world   ";
  const result = breaker.breakText(text, { maxWidth: 20 });
  
  expect(result.lines.length).toBe(1);
  expect(result.lines[0].text).toBe("Hello world   ");
});

test("SimpleGreedyTextBreaker - text indices", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "First line second line";
  const result = breaker.breakText(text, { maxWidth: 10 });
  
  // Verify indices are correct
  result.lines.forEach(line => {
    const extracted = text.slice(line.startIndex, line.endIndex);
    expect(extracted).toBe(line.text);
  });
});

test("SimpleGreedyTextBreaker - unicode handling", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "Hello 👋 World 🌍 Test";
  const result = breaker.breakText(text, { maxWidth: 15 });
  
  // Emojis should be counted as 2 width each
  expect(result.lines.length).toBeGreaterThan(1);
  result.lines.forEach(line => {
    expect(line.width).toBeLessThanOrEqual(15);
  });
});

test("SimpleGreedyTextBreaker - CJK characters", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "你好世界 Hello"; // CJK chars are typically width 2
  const result = breaker.breakText(text, { maxWidth: 10 });
  
  expect(result.lines.length).toBe(2);
  expect(result.lines[0].width).toBeLessThanOrEqual(10);
  expect(result.lines[1].width).toBeLessThanOrEqual(10);
});

test("SimpleGreedyTextBreaker - real world example", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "This is a long line that should wrap to multiple lines.";
  const result = breaker.breakText(text, { maxWidth: 18 });
  
  // Should break at word boundaries
  expect(result.lines[0].text).toBe("This is a long ");
  expect(result.lines[1].text).toBe("line that should ");
  expect(result.lines[2].text).toBe("wrap to multiple ");
  expect(result.lines[3].text).toBe("lines.");
  
  // All lines should fit within width
  result.lines.forEach(line => {
    expect(line.width).toBeLessThanOrEqual(18);
  });
});

test("SimpleGreedyTextBreaker - preserve line structure", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "First line second line third line";
  const result = breaker.breakText(text, { maxWidth: 12 });
  
  // Reconstruct the text from lines
  const reconstructed = result.lines.map(l => l.text).join('');
  expect(reconstructed).toBe(text);
  
  // Verify no characters are lost
  expect(reconstructed.length).toBe(text.length);
});

test("SimpleGreedyTextBreaker - single long word", () => {
  const breaker = new SimpleGreedyTextBreaker();
  const text = "averylongwordthatdoesnotfit";
  const result = breaker.breakText(text, { maxWidth: 10, breakWords: true });
  
  // Should break the word
  expect(result.lines.length).toBeGreaterThan(1);
  
  // Each piece should fit
  result.lines.forEach(line => {
    expect(line.width).toBeLessThanOrEqual(10);
  });
  
  // Reconstruct to verify
  const reconstructed = result.lines.map(l => l.text).join('');
  expect(reconstructed).toBe(text);
});

test("SimpleGreedyTextBreaker - mixed content simulation", () => {
  const breaker = new SimpleGreedyTextBreaker();
  // Simulate text with inline elements by using placeholder
  const text = "Before [BUTTON] after text";
  const result = breaker.breakText(text, { maxWidth: 15 });
  
  expect(result.lines.length).toBeGreaterThan(1);
  // The algorithm should still break at word boundaries
  expect(result.lines[0].text).not.toContain("aft"); // Should not break "after"
});