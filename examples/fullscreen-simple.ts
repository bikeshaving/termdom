#!/usr/bin/env bun
import {TermDOM} from "../src/termdom.js";

async function _main() {
	const termdom = new TermDOM();
	const {document} = termdom;

	// Create content
	const container = document.createElement("div");
	container.textContent = "🖥️ Fullscreen Test - Press 'f' to go fullscreen!";
	container.style.backgroundColor = "blue";
	container.style.color = "white";
	container.style.padding = "1";

	document.body.appendChild(container);

	// Add event listener
	document.addEventListener("fullscreenchange", () => {});

	// Render
	await termdom.render();

	// Test the API programmatically

	try {
		await container.requestFullscreen();

		// Exit after 2 seconds
		setTimeout(async () => {
			try {
				await document.exitFullscreen();
				process.exit(0);
			} catch (error) {
				process.exit(1);
			}
		}, 2000);
	} catch (error) {
		process.exit(1);
	}
}

_main();
