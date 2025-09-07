#!/usr/bin/env bun
import {TermDOM} from "../src/termdom.js";

if (!process.stdin.isTTY) {
	process.exit(1);
}

const termdom = new TermDOM();
const {document} = termdom;

// Create UI
const container = document.createElement("div");
container.style.backgroundColor = "navy";
container.style.color = "white";
container.style.padding = "2";

const title = document.createElement("h1");
title.textContent = "⌨️  Keyboard Test";
title.style.color = "cyan";
container.appendChild(title);

const instructions = document.createElement("div");
instructions.innerHTML = `
<p style="color: yellow">Press keys to test:</p>
<ul>
  <li style="color: lightgreen">Letters: a, b, c, etc.</li>
  <li style="color: lightgreen">Numbers: 1, 2, 3, etc.</li>
  <li style="color: lightgreen">Special: Enter, Tab, Backspace</li>
  <li style="color: lightgreen">Arrows: ↑ ↓ ← →</li>
  <li style="color: orange">q = quit</li>
</ul>
`;
container.appendChild(instructions);

// Status area
const status = document.createElement("div");
status.style.backgroundColor = "black";
status.style.color = "white";
status.style.padding = "1";
status.style.marginTop = "1";

const statusTitle = document.createElement("p");
statusTitle.textContent = "Last Event:";
statusTitle.style.color = "yellow";
statusTitle.style.marginBottom = "1";
status.appendChild(statusTitle);

const eventInfo = document.createElement("pre");
eventInfo.textContent = "Waiting for keypress...";
eventInfo.style.color = "lightgray";
eventInfo.style.fontSize = "14px";
status.appendChild(eventInfo);

container.appendChild(status);
document.body.appendChild(container);

// Event tracking
let eventCount = 0;
const events: any[] = [];

const updateDisplay = (event: KeyboardEvent, type: string) => {
	eventCount++;

	const eventData = {
		type,
		key: event.key,
		code: event.code,
		keyCode: event.keyCode,
		charCode: event.charCode,
		count: eventCount,
		timestamp: new Date().toISOString().split("T")[1].slice(0, -1),
	};

	events.push(eventData);

	// Keep only last 10 events
	if (events.length > 10) {
		events.shift();
	}

	// Update display
	statusTitle.textContent = `Last Event (#${eventCount}): ${type.toUpperCase()} "${event.key}"`;
	statusTitle.style.color =
		type === "keydown" ? "yellow" : type === "keypress" ? "green" : "orange";

	eventInfo.textContent = JSON.stringify(eventData, null, 2);

	termdom.render();
};

// Add event listeners
document.body.addEventListener("keydown", (event: KeyboardEvent) => {
	updateDisplay(event, "keydown");

	// Handle quit
	if (event.key === "q" || event.key === "Q") {
		process.exit(0);
	}
});

document.body.addEventListener("keypress", (event: KeyboardEvent) => {
	updateDisplay(event, "keypress");
});

document.body.addEventListener("keyup", (event: KeyboardEvent) => {
	updateDisplay(event, "keyup");
});

// Initial render
await termdom.render();

// Add global error handler
process.on("uncaughtException", (_error) => {
	process.exit(1);
});

process.on("unhandledRejection", (_reason) => {
	process.exit(1);
});

// Keep alive
setInterval(() => {
	// Just keep the process running
}, 1000);
