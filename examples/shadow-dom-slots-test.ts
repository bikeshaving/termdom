#!/usr/bin/env bun

import {TermDOM} from "../src/_termdom.js";

const termdom = new TermDOM();
const {document} = termdom;

// Create a custom element with shadow DOM that uses slots
const customElement = document.createElement("div");
customElement.style.cssText =
	"display: block; padding: 1ch; border: 1px solid; color: blue;";

// Create shadow root
const shadowRoot = customElement.attachShadow({mode: "open"});

// Add shadow DOM template with slots
// Create individual elements for cleaner testing
const headerDiv = document.createElement("div");
headerDiv.style.cssText = "color: red; font-weight: bold; display: block;";
headerDiv.textContent = "Shadow DOM Header: ";
const headerSlot = document.createElement("slot");
headerSlot.setAttribute("name", "header");
headerSlot.textContent = "Default Header";
headerDiv.appendChild(headerSlot);

const contentDiv = document.createElement("div");
contentDiv.style.cssText = "color: green; display: block;";
contentDiv.textContent = "Shadow DOM Content: ";
const contentSlot = document.createElement("slot");
contentSlot.textContent = "Default Content";
contentDiv.appendChild(contentSlot);

const footerDiv = document.createElement("div");
footerDiv.style.cssText = "color: yellow; display: block;";
footerDiv.textContent = "Shadow DOM Footer: ";
const footerSlot = document.createElement("slot");
footerSlot.setAttribute("name", "footer");
footerSlot.textContent = "Default Footer";
footerDiv.appendChild(footerSlot);

// Add to shadow root
shadowRoot.appendChild(headerDiv);
shadowRoot.appendChild(contentDiv);
shadowRoot.appendChild(footerDiv);

// Add light DOM content with slot assignments
const headerContent = document.createElement("span");
headerContent.textContent = "Custom Header from Light DOM";
headerContent.setAttribute("slot", "header");
customElement.appendChild(headerContent);

const mainContent = document.createElement("div");
mainContent.textContent = "Custom main content from Light DOM";
customElement.appendChild(mainContent);

const footerContent = document.createElement("span");
footerContent.textContent = "Custom Footer from Light DOM";
footerContent.setAttribute("slot", "footer");
customElement.appendChild(footerContent);

// Add elements to document
document.body.appendChild(customElement);

// Render
await termdom.render();

console.log("\n🔧 Current slot implementation status:");
console.log("✅ Slot detection and assignment working");
console.log("✅ Fallback content removal working");
console.log("❌ Light DOM content projection needs layout support");
console.log("Expected: Light DOM content should appear where slots are");
