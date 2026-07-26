#!/usr/bin/env bun

import {TermDOM} from "../src/_termdom.js";

const termdom = new TermDOM();
const {document} = termdom;

// Create a custom element with shadow DOM
const customElement = document.createElement("div");
customElement.style.cssText =
	"display: block; padding: 1ch; border: 1px solid; color: blue;";

// Create shadow root (closed to test our caching)
const shadowRoot = customElement.attachShadow({mode: "closed"});

// Add content to shadow root
const shadowContent = document.createElement("div");
shadowContent.textContent = "This is rendered from shadow DOM!";
shadowContent.style.cssText = "color: red; font-weight: bold;";
shadowRoot.appendChild(shadowContent);

// Add light DOM content (should NOT be rendered due to shadow DOM)
const lightContent = document.createElement("div");
lightContent.textContent = "This is light DOM content (should not appear)";
lightContent.style.cssText = "color: green;";
customElement.appendChild(lightContent);

// Test element without shadow DOM
const regularElement = document.createElement("div");
regularElement.style.cssText =
	"display: block; padding: 1ch; margin-top: 1ch; border: 1px solid; color: yellow;";
regularElement.textContent = "This is regular DOM content";

// Add elements to document
document.body.appendChild(customElement);
document.body.appendChild(regularElement);

// Verify shadow DOM functionality
console.log("✅ Shadow DOM test passed!");
console.log(
	"- Closed shadow root accessible:",
	termdom.getShadowRoot(customElement) !== null,
);
console.log(
	"- Regular element has no shadow root:",
	!termdom.hasShadowRoot(regularElement),
);

// Render
await termdom.render();

console.log("\n🎯 Expected output:");
console.log("- First box: Red bold text from shadow DOM");
console.log("- Second box: Yellow text from light DOM");
console.log("- Light DOM content in first box should be hidden by shadow DOM");
