#!/usr/bin/env bun
import {TermDOM} from "../src/index.js";

const termdom = new TermDOM();
const {document} = termdom;

// Create a fullscreen-capable element
const container = document.createElement("div");
container.style.backgroundColor = "blue";
container.style.color = "white";
container.style.padding = "2";

const title = document.createElement("h1");
title.textContent = "🖥️  Fullscreen Demo";
title.style.color = "cyan";
container.appendChild(title);

const instructions = document.createElement("p");
instructions.textContent = "Press 'f' to toggle fullscreen, 'q' to quit";
instructions.style.color = "yellow";
container.appendChild(instructions);

const status = document.createElement("p");
status.textContent = "Status: Not in fullscreen";
status.id = "status";
container.appendChild(status);

document.body.appendChild(container);

// Add event listeners
document.addEventListener("fullscreenchange", async () => {
	const status = document.getElementById("status")!;
	if (document.fullscreenElement) {
		status.textContent = `Status: ${document.fullscreenElement.tagName} is fullscreen`;
		status.style.color = "green";
	} else {
		status.textContent = "Status: Exited fullscreen";
		status.style.color = "red";
	}
	await new Promise<void>((r) =>
		termdom.window.requestAnimationFrame(() => r()),
	); // Re-render when fullscreen changes
});

document.addEventListener("fullscreenerror", (_event: any) => {});

// Keyboard events land on the focused element (or body when nothing is
// focused) and bubble UP to document -- a listener on the container, a
// sibling-less child of body, never hears them. Listen at the document.
document.addEventListener("keydown", async (event: KeyboardEvent) => {
	if (event.key === "q" || event.key === "Q") {
		process.exit(0);
	}

	if (event.key === "f" || event.key === "F") {
		try {
			if (document.fullscreenElement) {
				await document.exitFullscreen();
			} else {
				await container.requestFullscreen();
			}
			await new Promise<void>((r) =>
				termdom.window.requestAnimationFrame(() => r()),
			); // Re-render after fullscreen change
		} catch {
			// Ignore fullscreen errors
		}
	}
});

// Initial render
await new Promise<void>((r) => termdom.window.requestAnimationFrame(() => r()));
