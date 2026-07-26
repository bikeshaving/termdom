#!/usr/bin/env bun
import {TermDOM} from "../src/_termdom.js";

if (!process.stdin.isTTY) {
	process.exit(1);
}

if (typeof process.stdin.setRawMode !== "function") {
	process.exit(1);
}

// Create TermDOM
const termdom = new TermDOM();
const {document} = termdom;

// Create a simple test UI
const container = document.createElement("div");
container.style.backgroundColor = "darkblue";
container.style.color = "white";
container.style.padding = "2";

const title = document.createElement("h2");
title.textContent = "🎯 Keyboard Test Active";
title.style.color = "yellow";
container.appendChild(title);

const instructions = document.createElement("p");
instructions.textContent = "Type any key to test keyboard events. 'q' to quit.";
instructions.style.color = "cyan";
container.appendChild(instructions);

const statusDiv = document.createElement("div");
statusDiv.style.marginTop = "1";
statusDiv.style.backgroundColor = "black";
statusDiv.style.padding = "1";

const statusText = document.createElement("p");
statusText.textContent = "Waiting for keypress...";
statusText.style.color = "lightgreen";
statusDiv.appendChild(statusText);

const eventDetails = document.createElement("pre");
eventDetails.textContent = "";
eventDetails.style.color = "lightgray";
eventDetails.style.fontSize = "12";
statusDiv.appendChild(eventDetails);

container.appendChild(statusDiv);
document.body.appendChild(container);

// Event tracking
let eventCount = 0;
let lastEventTime = Date.now();

const updateStatus = (event: KeyboardEvent, type: string) => {
	eventCount++;
	const now = Date.now();
	const timeSinceLastEvent = now - lastEventTime;
	lastEventTime = now;

	const eventInfo = {
		count: eventCount,
		type: type,
		key: event.key,
		code: event.code,
		keyCode: event.keyCode,
		charCode: event.charCode,
		timeSinceLastEvent: timeSinceLastEvent,
	};

	statusText.textContent = `✅ Event #${eventCount}: ${type.toUpperCase()} "${event.key}"`;
	eventDetails.textContent = JSON.stringify(eventInfo, null, 2);

	// Force re-render
	termdom.render();

	// Event logged to display only
};

// Add keyboard event listeners
document.body.addEventListener("keydown", (event: KeyboardEvent) => {
	updateStatus(event, "keydown");

	if (event.key === "q" || event.key === "Q") {
		process.exit(0);
	}
});

document.body.addEventListener("keypress", (event: KeyboardEvent) => {
	updateStatus(event, "keypress");
});

document.body.addEventListener("keyup", (event: KeyboardEvent) => {
	updateStatus(event, "keyup");
});

// Initial render
await termdom.render();

// Timeout after 30 seconds
setTimeout(() => {
	process.exit(eventCount > 0 ? 0 : 1);
}, 30000);

// Handle process termination
process.on("SIGINT", () => {
	process.exit(0);
});
