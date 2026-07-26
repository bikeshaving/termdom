#!/usr/bin/env bun

import {TermDOM} from "../src/internal/termdom.js";

const termdom = new TermDOM();
const {document} = termdom;

// Create a custom element with shadow DOM that uses both named and anonymous slots
const customElement = document.createElement("div");
customElement.style.cssText =
	"display: block; padding: 1ch; border: 1px solid; color: blue;";

// Create shadow root
const shadowRoot = customElement.attachShadow({mode: "open"});

// Add shadow DOM template with both named and anonymous slots
const headerDiv = document.createElement("div");
headerDiv.style.cssText = "color: red; font-weight: bold; display: block;";
headerDiv.textContent = "Header: ";
const headerSlot = document.createElement("slot");
headerSlot.setAttribute("name", "header");
headerSlot.textContent = "Default Header";
headerDiv.appendChild(headerSlot);

const contentDiv = document.createElement("div");
contentDiv.style.cssText = "color: green; display: block;";
contentDiv.textContent = "Content: ";
const contentSlot = document.createElement("slot");
contentSlot.textContent = "Default Content";
contentDiv.appendChild(contentSlot);

const footerDiv = document.createElement("div");
footerDiv.style.cssText = "color: yellow; display: block;";
footerDiv.textContent = "Footer: ";
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
headerContent.style.cssText = "color: cyan;";
headerContent.setAttribute("slot", "header");
customElement.appendChild(headerContent);

const mainContent1 = document.createElement("span");
mainContent1.textContent = "Anonymous content 1";
mainContent1.style.cssText = "color: magenta;";
customElement.appendChild(mainContent1);

const mainContent2 = document.createElement("span");
mainContent2.textContent = " and anonymous content 2";
mainContent2.style.cssText = "color: white;";
customElement.appendChild(mainContent2);

const footerContent = document.createElement("span");
footerContent.textContent = "Custom Footer from Light DOM";
footerContent.style.cssText = "color: orange;";
footerContent.setAttribute("slot", "footer");
customElement.appendChild(footerContent);

// Add elements to document
document.body.appendChild(customElement);

// Render
await termdom.render();

console.log("\n🎯 Named slots test:");
console.log("Expected:");
console.log("- Header: Custom Header from Light DOM (red + cyan)");
console.log(
	"- Content: Anonymous content 1 and anonymous content 2 (green + magenta + white)",
);
console.log("- Footer: Custom Footer from Light DOM (yellow + orange)");
console.log("Should NOT see any default/fallback content");
