/**
 * Hello World - HTML-to-Terminal Demo 🚀
 *
 * This demonstrates the revolutionary new approach:
 * Write standard HTML/CSS → Render to beautiful terminal output!
 */

import {TermDOM} from "../src/index.js";

async function helloWorld() {
	// Create a TermDOM instance (like JSDOM, but for terminals)
	const dom = new TermDOM();
	const {document} = dom;

	// Create standard HTML elements with CSS styling!
	const container = document.createElement("div");
	container.style.setProperty("background-color", "blue");
	container.style.setProperty("color", "white");
	container.style.setProperty("padding", "1");
	container.textContent = "🎯 Hello, HTML Terminal!";

	const subtitle = document.createElement("div");
	subtitle.style.setProperty("color", "yellow");
	subtitle.style.setProperty("margin-top", "1");
	subtitle.textContent = "Standard HTML/CSS → ANSI Terminal Output";

	// Add to document (just like web development!)
	document.body.appendChild(container);
	document.body.appendChild(subtitle);
}

helloWorld();
