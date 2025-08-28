#!/usr/bin/env bun

/**
 * Simple text wrapping test
 */

import {TermDOM} from "../src/index.js";

const {document, dispose} = TermDOM({runtime});

// Simple container with text that should wrap
const container = document.createElement("container");
container.style.backgroundColor = "blue";
container.style.padding = [1, 1, 1, 1];
container.style.width = 20;
container.style.height = 8;
container.style.wordWrap = "normal";

const text = "This is a long line that should wrap to multiple lines.";
container.appendChild(document.createTextNode(text));

document.body.appendChild(container);

console.log(`Testing text wrapping:`);
console.log(`Text: "${text}"`);
console.log(`Container width: 20 (minus 2 for padding = 18 content width)`);
console.log(`Should break into multiple lines.`);

setTimeout(() => {
	dom.dom.dispose();
}, 3000);
