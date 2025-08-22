#!/usr/bin/env bun

/**
 * Rich Text Demo - Showcasing unified flex + inline layout
 */

import { createTOM } from '../src/index.js';

console.clear();
console.log('🎨 Rich Text Demo - Mixed Content & Inline\n');

const tom = createTOM();

// Main container
const main = tom.createElement('container');
main.style.padding = [2, 3, 2, 3];
main.style.backgroundColor = 'darkblue';
main.style.flexDirection = 'column';
main.style.gap = 3;

// Title
const title = tom.createElement('text');
title.textContent = '🎨 TOM Rich Text Demo';
title.style.color = 'yellow';
title.style.fontWeight = 'bold';
title.style.textAlign = 'center';
main.appendChild(title);

// Paragraph 1: Mixed text with inline-flex toolbar
const paragraph1 = tom.createElement('container');
paragraph1.style.backgroundColor = 'blue';
paragraph1.style.padding = [1, 2, 1, 2];

// Text before toolbar
paragraph1.appendChild(tom.createTextNode('Here is a paragraph with '));

// Inline toolbar with buttons
const toolbar = tom.createElement('container');
toolbar.style.display = 'inline';
toolbar.style.flexDirection = 'row';
toolbar.style.gap = 1;
toolbar.style.backgroundColor = 'gray';
toolbar.style.padding = [0, 1, 0, 1];

const boldBtn = tom.createElement('button');
boldBtn.textContent = 'B';
boldBtn.style.backgroundColor = 'red';
boldBtn.style.color = 'white';
boldBtn.style.fontWeight = 'bold';
boldBtn.style.minWidth = 3;
boldBtn.style.minHeight = 1;

const italicBtn = tom.createElement('button');
italicBtn.textContent = 'I';
italicBtn.style.backgroundColor = 'green';
italicBtn.style.color = 'white';
italicBtn.style.fontStyle = 'italic';
italicBtn.style.minWidth = 3;
italicBtn.style.minHeight = 1;

toolbar.appendChild(boldBtn);
toolbar.appendChild(italicBtn);
paragraph1.appendChild(toolbar);

// Text after toolbar
paragraph1.appendChild(tom.createTextNode(' formatting tools and more text that continues flowing.'));

main.appendChild(paragraph1);

// Paragraph 2: More complex mixed content
const paragraph2 = tom.createElement('container');
paragraph2.style.backgroundColor = 'purple';
paragraph2.style.padding = [1, 2, 1, 2];

paragraph2.appendChild(tom.createTextNode('This is '));

// Inline emphasis
const emphasis = tom.createElement('text');
emphasis.textContent = 'emphasized';
emphasis.style.color = 'yellow';
emphasis.style.fontWeight = 'bold';
emphasis.style.fontStyle = 'italic';
paragraph2.appendChild(emphasis);

paragraph2.appendChild(tom.createTextNode(' text with '));

// Another inline-flex container (icon + text)
const iconText = tom.createElement('container');
iconText.style.display = 'inline';
iconText.style.flexDirection = 'row';
iconText.style.alignItems = 'center';
iconText.style.gap = 1;
iconText.style.backgroundColor = 'darkgreen';
iconText.style.padding = [0, 1, 0, 1];

const icon = tom.createElement('text');
icon.textContent = '⚡';
icon.style.color = 'orange';
iconText.appendChild(icon);

const label = tom.createElement('text');
label.textContent = 'POWER';
label.style.color = 'white';
label.style.fontWeight = 'bold';
iconText.appendChild(label);

paragraph2.appendChild(iconText);

paragraph2.appendChild(tom.createTextNode(' inline components!'));

main.appendChild(paragraph2);

// Info footer
const footer = tom.createElement('text');
footer.textContent = '✨ This demonstrates DOM-like text flow with inline containers';
footer.style.color = 'cyan';
footer.style.fontStyle = 'italic';
footer.style.textAlign = 'center';
main.appendChild(footer);

tom.body.appendChild(main);

// Enable interaction
tom.enableInputMode();

// Add click handlers
boldBtn.addEventListener('click', () => {
  console.log('Bold button clicked!');
  boldBtn.style.backgroundColor = boldBtn.style.backgroundColor === 'darkred' ? 'red' : 'darkred';
  tom.render();
});

italicBtn.addEventListener('click', () => {
  console.log('Italic button clicked!');
  italicBtn.style.backgroundColor = italicBtn.style.backgroundColor === 'darkgreen' ? 'green' : 'darkgreen';
  tom.render();
});

tom.addEventListener('keydown', (e: any) => {
  if (e.key?.toLowerCase() === 'q') {
    console.log('\n🎉 Rich text demo completed!');
    console.log('Features demonstrated:');
    console.log('- ✅ Text nodes and elements mixed in DOM');
    console.log('- ✅ Inline-flex containers within text flow');
    console.log('- ✅ Style inheritance and text styling');
    console.log('- ✅ Interactive inline components');
    console.log('- ✅ Proper DOM architecture');
    tom.destroy();
    process.exit(0);
  }
});

tom.render();

console.log('🎮 Click buttons or press Q to exit');