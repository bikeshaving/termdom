#!/usr/bin/env bun

/**
 * Debug text wrapping algorithm
 */

import { GreedyTextBreaker } from '../src/text/GreedyTextBreaker.js';

const breaker = new GreedyTextBreaker();

const text = 'This is a long line that should wrap to multiple lines.';
const result = breaker.breakText(text, { maxWidth: 18 });

console.log('=== Text Breaking Debug ===');
console.log(`Original text: "${text}"`);
console.log(`Max width: 18`);
console.log('\nBroken lines:');

result.lines.forEach((line, i) => {
  console.log(`Line ${i + 1}:`);
  console.log(`  Text: "${line.text}"`);
  console.log(`  Start: ${line.startIndex}, End: ${line.endIndex}`);
  console.log(`  Width: ${line.width}`);
  console.log(`  Actual content: "${text.slice(line.startIndex, line.endIndex)}"`);
});

console.log('\nExpected vs Actual:');
console.log('Expected: "This is a long "');
console.log('Actual:   "' + result.lines[0].text + '"');