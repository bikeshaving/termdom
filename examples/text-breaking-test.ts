#!/usr/bin/env bun

/**
 * Test the TextBreaker interface and GreedyTextBreaker implementation
 */

import { GreedyTextBreaker } from '../src/text/GreedyTextBreaker.js';

const breaker = new GreedyTextBreaker();

console.log('=== Text Breaking Algorithm Test ===\n');

// Test 1: Simple text wrapping
console.log('Test 1: Simple text wrapping');
const text1 = 'This is a long line of text that should be wrapped to multiple lines when it exceeds the maximum width.';
const result1 = breaker.breakText(text1, { maxWidth: 20 });

console.log(`Original: "${text1}"`);
console.log(`Max width: 20`);
console.log('Wrapped lines:');
result1.lines.forEach((line, i) => {
  console.log(`  ${i + 1}: "${line.text}" (width: ${line.width})`);
});
console.log(`Total height: ${result1.totalHeight}`);
console.log(`Max line width: ${result1.maxLineWidth}\n`);

// Test 2: Text with inline elements (simulated)
console.log('Test 2: Text with inline elements');
const text2 = 'Before button after text';
const result2 = breaker.breakText(text2, { 
  maxWidth: 25,
  inlineElements: [
    {
      position: 7, // After "Before "
      width: 8,    // "[BUTTON]" width
      height: 1,
      breakable: false,
      element: { type: 'button', text: 'CLICK' }
    }
  ]
});

console.log(`Text: "${text2}"`);
console.log('With button at position 7 (width: 8)');
console.log(`Max width: 25`);
console.log('Wrapped lines:');
result2.lines.forEach((line, i) => {
  const elements = line.inlineElements.length > 0 ? ` [${line.inlineElements.length} elements]` : '';
  console.log(`  ${i + 1}: "${line.text}" (width: ${line.width})${elements}`);
});
console.log();

// Test 3: Word breaking
console.log('Test 3: Force word breaking');
const text3 = 'supercalifragilisticexpialidocious';
const result3 = breaker.breakText(text3, { maxWidth: 10, breakWords: true });

console.log(`Text: "${text3}"`);
console.log(`Max width: 10, breakWords: true`);
console.log('Wrapped lines:');
result3.lines.forEach((line, i) => {
  console.log(`  ${i + 1}: "${line.text}" (width: ${line.width})`);
});
console.log();

// Test 4: Edge cases
console.log('Test 4: Edge cases');
const emptyResult = breaker.breakText('', { maxWidth: 10 });
console.log(`Empty text: ${emptyResult.lines.length} lines`);

const singleCharResult = breaker.breakText('A', { maxWidth: 1 });
console.log(`Single char: ${singleCharResult.lines.length} lines, text: "${singleCharResult.lines[0]?.text}"`);

const spacesResult = breaker.breakText('   ', { maxWidth: 2 });
console.log(`Only spaces: ${spacesResult.lines.length} lines`);

console.log('\n=== Test Complete ===');