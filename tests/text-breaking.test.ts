/**
 * Unit tests for text breaking algorithms
 */

import { test, expect } from "bun:test";
import { TextBreaker } from '../src/text/TextBreaker.js';

test("TextBreaker - basic word wrapping", () => {
  const breaker = new TextBreaker();
  const text = "Hello world this is a test";
  const result = breaker.breakText(text, { maxWidth: 10 });
  
  expect(result.lines.length).toBe(3);
  expect(result.lines[0].text).toBe("Hello ");
  expect(result.lines[1].text).toBe("world this");
  expect(result.lines[2].text).toBe(" is a test");
});

test("TextBreaker - exact width fit", () => {
  const breaker = new TextBreaker();
  const text = "Fits exactly";
  const result = breaker.breakText(text, { maxWidth: 12 });
  
  expect(result.lines.length).toBe(1);
  expect(result.lines[0].text).toBe("Fits exactly");
  expect(result.lines[0].width).toBe(12);
});

test("TextBreaker - long word breaking", () => {
  const breaker = new TextBreaker();
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

test("TextBreaker - no word breaking when disabled", () => {
  const breaker = new TextBreaker();
  const text = "verylongword short";
  const result = breaker.breakText(text, { maxWidth: 10, breakWords: false });
  
  // The long word should be on its own line even if it exceeds width
  expect(result.lines.length).toBe(2);
  expect(result.lines[0].text).toBe("verylongword");
  expect(result.lines[1].text).toBe(" short");
});

test("TextBreaker - empty text", () => {
  const breaker = new TextBreaker();
  const result = breaker.breakText("", { maxWidth: 10 });
  
  expect(result.lines.length).toBe(0);
  expect(result.totalHeight).toBe(0);
  expect(result.maxLineWidth).toBe(0);
});

test("TextBreaker - single character", () => {
  const breaker = new TextBreaker();
  const result = breaker.breakText("A", { maxWidth: 1 });
  
  expect(result.lines.length).toBe(1);
  expect(result.lines[0].text).toBe("A");
  expect(result.lines[0].width).toBe(1);
});

test("TextBreaker - multiple spaces", () => {
  const breaker = new TextBreaker();
  const text = "Hello    world"; // Multiple spaces
  const result = breaker.breakText(text, { maxWidth: 20 });
  
  expect(result.lines.length).toBe(1);
  expect(result.lines[0].text).toBe("Hello    world");
});

test("TextBreaker - trailing spaces", () => {
  const breaker = new TextBreaker();
  const text = "Hello world   ";
  const result = breaker.breakText(text, { maxWidth: 20 });
  
  expect(result.lines.length).toBe(1);
  expect(result.lines[0].text).toBe("Hello world   ");
});

test("TextBreaker - text indices", () => {
  const breaker = new TextBreaker();
  const text = "First line second line";
  const result = breaker.breakText(text, { maxWidth: 10 });
  
  // Verify indices are correct
  result.lines.forEach(line => {
    const extracted = text.slice(line.startIndex, line.endIndex);
    expect(extracted).toBe(line.text);
  });
});

test("TextBreaker - unicode handling", () => {
  const breaker = new TextBreaker();
  const text = "Hello 👋 World 🌍 Test";
  const result = breaker.breakText(text, { maxWidth: 15 });
  
  // Emojis should be counted as 2 width each
  expect(result.lines.length).toBeGreaterThan(1);
  result.lines.forEach(line => {
    expect(line.width).toBeLessThanOrEqual(15);
  });
});

test("TextBreaker - CJK characters", () => {
  const breaker = new TextBreaker();
  const text = "你好世界 Hello"; // CJK chars are typically width 2
  const result = breaker.breakText(text, { maxWidth: 10 });
  
  expect(result.lines.length).toBe(2);
  expect(result.lines[0].width).toBeLessThanOrEqual(10);
  expect(result.lines[1].width).toBeLessThanOrEqual(10);
});

test("TextBreaker - real world example", () => {
  const breaker = new TextBreaker();
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

test("TextBreaker - preserve line structure", () => {
  const breaker = new TextBreaker();
  const text = "First line second line third line";
  const result = breaker.breakText(text, { maxWidth: 12 });
  
  // Reconstruct the text from lines
  const reconstructed = result.lines.map(l => l.text).join('');
  expect(reconstructed).toBe(text);
  
  // Verify no characters are lost
  expect(reconstructed.length).toBe(text.length);
});

test("TextBreaker - single long word", () => {
  const breaker = new TextBreaker();
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

test("TextBreaker - mixed content simulation", () => {
  const breaker = new TextBreaker();
  // Simulate text with inline elements by using placeholder
  const text = "Before [BUTTON] after text";
  const result = breaker.breakText(text, { maxWidth: 15 });
  
  expect(result.lines.length).toBeGreaterThan(1);
  // The algorithm should still break at word boundaries
  expect(result.lines[0].text).not.toContain("aft"); // Should not break "after"
});