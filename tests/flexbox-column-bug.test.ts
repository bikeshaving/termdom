/**
 * Test to reproduce and fix the flexbox column positioning bug
 * Bug: In tight constrained layouts, child elements get same Y position
 */

import {test, expect} from "bun:test";
import {TestTerminal} from "./test-utils";
import {TermDOM} from "../src/termdom";

test.skip("flexbox column children should have different Y positions", async () => {
	const terminal = new TestTerminal({cols: 20, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Create tight constraints that trigger the bug
	const outerContainer = document.createElement("div");
	outerContainer.style.display = "flex";
	outerContainer.style.flexDirection = "column";
	outerContainer.style.height = "8px";
	outerContainer.style.padding = "1px";
	document.body.appendChild(outerContainer);

	// Add header to consume space
	const header = document.createElement("div");
	header.textContent = "Header";
	header.style.padding = "1px";
	outerContainer.appendChild(header);

	// Create row container
	const rowContainer = document.createElement("div");
	rowContainer.style.display = "flex";
	rowContainer.style.flexDirection = "row";
	rowContainer.style.flex = "1";
	outerContainer.appendChild(rowContainer);

	// Create the problematic flexbox column card
	const card = document.createElement("div");
	card.style.display = "flex";
	card.style.flexDirection = "column";
	card.style.flex = "1";
	card.style.padding = "1px";
	rowContainer.appendChild(card);

	const title = document.createElement("span");
	title.textContent = "Title";
	title.style.textAlign = "center";
	card.appendChild(title);

	const description = document.createElement("span");
	description.textContent = "Description";
	description.style.textAlign = "center";
	card.appendChild(description);

	await dom.render();

	// Test the bug: title and description should have different Y positions
	const titleRect = title.getBoundingClientRect();
	const descRect = description.getBoundingClientRect();

	// Debug info: In flex column, title and description should be at different Y positions
	// Currently both are at Y=5, which suggests they're positioned horizontally instead of vertically

	// The main assertion: title and description should NOT be at same Y position
	expect(titleRect.y).not.toBe(descRect.y);

	// Description should be positioned after title
	expect(descRect.y).toBeGreaterThan(titleRect.y);

	// There should be no gap larger than title height between them
	expect(descRect.y).toBeLessThanOrEqual(titleRect.y + titleRect.height);

	dom.dispose();
});
