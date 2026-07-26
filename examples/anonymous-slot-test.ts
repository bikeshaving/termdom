#!/usr/bin/env bun

import {TermDOM} from "../src/_termdom.js";

const termdom = new TermDOM();
const {document} = termdom;

// Create a custom element with shadow DOM that uses only anonymous slot
const customElement = document.createElement("div");
customElement.style.cssText =
	"display: block; padding: 1ch; border: 1px solid; color: blue;";

// Create shadow root
const shadowRoot = customElement.attachShadow({mode: "open"});

// Add simple shadow DOM template with anonymous slot
const wrapper = document.createElement("div");
wrapper.style.cssText = "color: red; font-weight: bold; display: block;";
wrapper.textContent = "Wrapper: ";

const slot = document.createElement("slot");
slot.textContent = "Default fallback content";
wrapper.appendChild(slot);

shadowRoot.appendChild(wrapper);

// Add light DOM content (no slot attributes needed)
const content1 = document.createElement("span");
content1.textContent = "Light DOM content 1";
content1.style.cssText = "color: green;";
customElement.appendChild(content1);

const content2 = document.createElement("span");
content2.textContent = " and content 2";
content2.style.cssText = "color: yellow;";
customElement.appendChild(content2);

// Add to document
document.body.appendChild(customElement);

// Render
await termdom.render();

console.log("\n🎯 Anonymous slot test:");
console.log(
	"Expected: 'Wrapper: Light DOM content 1 and content 2' in red wrapper",
);
console.log("Should NOT see: 'Default fallback content'");
