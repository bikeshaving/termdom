/**
 * Basic TTY Demo
 *
 * Demonstrates the core TTY functionality with a simple UI
 * containing containers, text, and buttons.
 */

import {TermDOM} from "../src/index.js";

async function basicDemo() {
	try {
		// Create TTY interface
		const dom = new TermDOM();
		const {document} = dom;

		// Create main container
		const container = document.createElement("container");
		container.style.setProperty("display", "flex");
		container.style.setProperty("flex-direction", "column");
		container.style.setProperty("background-color", "#1a1a1a");
		container.style.setProperty("padding", "2");
		container.style.setProperty("border", "1");
		container.style.setProperty("border-color", "#333");

		// Create title
		const title = document.createElement("text");
		title.textContent = "🎯 Terminal Typewriter Demo";
		title.style.setProperty("color", "#00ff00");
		title.style.setProperty("font-weight", "bold");
		title.style.setProperty("text-align", "center");

		// Create description
		const description = document.createElement("text");
		description.textContent =
			"Welcome to TTY - bringing DOM APIs to the terminal!";
		description.style.setProperty("color", "#888");
		description.style.setProperty("text-align", "center");

		// Create button container
		const buttonContainer = document.createElement("container");
		buttonContainer.style.setProperty("display", "flex");
		buttonContainer.style.setProperty("flex-direction", "row");
		buttonContainer.style.setProperty("justify-content", "center");

		// Create buttons
		const button1 = document.createElement("button");
		button1.textContent = "Click Me!";
		button1.style.setProperty("background-color", "#0066cc");
		button1.style.setProperty("color", "white");

		const button2 = document.createElement("button");
		button2.textContent = "Or Me!";
		button2.style.setProperty("background-color", "#cc6600");
		button2.style.setProperty("color", "white");

		// Add click handlers
		button1.addEventListener("click", () => {
			title.textContent = "🎉 Button 1 clicked!";
			title.style.setProperty("color", "#ff6600");
		});

		button2.addEventListener("click", () => {
			title.textContent = "✨ Button 2 clicked!";
			title.style.setProperty("color", "#6600ff");
		});

		// Build the DOM tree
		buttonContainer.appendChild(button1);
		buttonContainer.appendChild(button2);

		container.appendChild(title);
		container.appendChild(description);
		container.appendChild(buttonContainer);

		document.body.appendChild(container);

		await dom.render();

		// Setup exit handler
		process.on("SIGINT", () => {
			dom.dispose();
			process.exit(0);
		});
	} catch (error) {
		process.exit(1);
	}
}

// Handle unhandled errors
process.on("unhandledRejection", () => {
	process.exit(1);
});

process.on("uncaughtException", () => {
	process.exit(1);
});

// Run the demo
basicDemo();
