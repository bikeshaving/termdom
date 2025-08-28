/**
 * Flow Mode Test - Simple test to verify consistent line output
 *
 * This renders the same content 3 times to verify that:
 * 1. Each render outputs exactly the same number of lines
 * 2. The content updates properly in place
 * 3. No extra lines are added to the terminal
 */

import {TermDOM} from "../src/index.js";

async function flowTest() {
	// NO CONSOLE OUTPUT - pure TTYOM rendering only

	const {document, dispose} = TermDOM({runtime});

	// Create simple test content - NO BACKGROUND COLORS to avoid line wrapping
	const container = document.createElement("div");
	// Remove background-color, padding, width, height that cause long lines

	const title = document.createElement("div");
	title.textContent = "Flow Test";
	title.style.setProperty("color", "yellow");

	const counter = document.createElement("div");
	counter.style.setProperty("color", "green");

	container.appendChild(title);
	container.appendChild(counter);
	document.body.appendChild(container);

	// Change content 3 times - DOM will auto-render via MutationObserver
	for (let i = 1; i <= 3; i++) {
		counter.textContent = `Render count: ${i} | Some dynamic text here`;

		// Give DOM time to process the mutation and render
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (i < 3) {
			// Wait 1 second between renders
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	dom.dom.dispose();
}

flowTest().catch(console.error);
