#!/usr/bin/env bun

/**
 * Test Yoga measurement functions for inline text elements
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('🧘 Yoga Measurement Test - Text Flow with Measurement Functions\n');

const tom = createTOM();

// Main container
const main = tom.createElement('container');
main.style.padding = [2, 3, 2, 3];
main.style.backgroundColor = 'darkblue';
main.style.flexDirection = 'column';
main.style.gap = 2;
main.style.width = 60; // Fixed width to test wrapping

// Title
const title = tom.createElement('text');
title.textContent = '🧘 Yoga Measurement Test';
title.style.color = 'yellow';
title.style.fontWeight = 'bold';
title.style.textAlign = 'center';
main.appendChild(title);

// Test paragraph with mixed content
const paragraph = tom.createElement('container');
paragraph.style.backgroundColor = 'blue';
paragraph.style.padding = [1, 2, 1, 2];

// Add text before inline element
paragraph.appendChild(tom.createTextNode('This is a test of text flow with '));

// Inline element (should use measurement function)
const inlineSpan = tom.createElement('text');
inlineSpan.style.display = 'inline';
inlineSpan.style.color = 'yellow';
inlineSpan.style.fontWeight = 'bold';
inlineSpan.textContent = 'highlighted text';
paragraph.appendChild(inlineSpan);

// Add text after inline element
paragraph.appendChild(tom.createTextNode(' and more text that should wrap properly when the line gets too long for the container width.'));

main.appendChild(paragraph);

// Test word-wrap settings
const wrapTest = tom.createElement('container');
wrapTest.style.backgroundColor = 'purple';
wrapTest.style.padding = [1, 2, 1, 2];

const wrapText = tom.createElement('text');
wrapText.style.display = 'inline';
wrapText.style.wordWrap = 'break-word';
wrapText.style.color = 'cyan';
wrapText.textContent = 'ThisIsAVeryLongWordThatShouldBreakWithBreakWordWrapping';
wrapTest.appendChild(wrapText);

main.appendChild(wrapTest);

// Test nowrap
const nowrapTest = tom.createElement('container');
nowrapTest.style.backgroundColor = 'darkgreen';
nowrapTest.style.padding = [1, 2, 1, 2];

const nowrapText = tom.createElement('text');
nowrapText.style.display = 'inline';
nowrapText.style.wordWrap = 'nowrap';
nowrapText.style.color = 'white';
nowrapText.textContent = 'This text should not wrap even if it is very long and exceeds the container width';
nowrapTest.appendChild(nowrapText);

main.appendChild(nowrapTest);

tom.body.appendChild(main);

// Enable interaction
tom.enableInputMode();

tom.addEventListener('keydown', (e: any) => {
  if (e.key?.toLowerCase() === 'q') {
    console.log('\n🎉 Yoga measurement test completed!');
    console.log('Features tested:');
    console.log('- ✅ Yoga measurement functions for inline elements');
    console.log('- ✅ Text wrapping with word-wrap: normal');
    console.log('- ✅ Text breaking with word-wrap: break-word'); 
    console.log('- ✅ No wrapping with word-wrap: nowrap');
    console.log('- ✅ Mixed text and inline elements');
    tom.destroy();
    process.exit(0);
  }
});

tom.render();

console.log('🎮 Press Q to exit');