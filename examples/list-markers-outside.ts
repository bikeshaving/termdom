import {TermDOM} from "../src/termdom.js";

async function runDemo() {
	console.log("=== List Style Position: Outside Demo ===\n");

	const termdom = new TermDOM({
		process: process,
	});

	const {document} = termdom;

	// Add CSS for outside positioning
	const style = document.createElement("style");
	style.textContent = `
		body {
			margin: 5px;
		}

		h2 {
			color: blue;
			margin-bottom: 1px;
		}

		.outside-list {
			list-style-position: outside;
			padding: 0;
			margin: 0;
		}

		.inside-list {
			list-style-position: inside;
			padding: 0;
			margin: 0;
		}

		.custom-markers li::marker {
			content: "→ ";
			color: green;
		}

		.wide-markers {
			margin-left: 1px;
			padding-left: 2px; /* Only 3px total space */
			list-style-position: outside;
		}

		.wide-markers li::marker {
			content: "WIDE-MARKER: ";
			color: red;
		}
	`;
	document.head.appendChild(style);

	// Demo 1: Basic outside vs inside comparison
	const h1 = document.createElement("h2");
	h1.textContent = "1. Outside vs Inside Positioning";
	document.body.appendChild(h1);

	// Outside positioning
	const outsideList = document.createElement("ul");
	outsideList.className = "outside-list";
	document.body.appendChild(outsideList);

	const outsideItem1 = document.createElement("li");
	outsideItem1.textContent = "Outside: marker separate from content flow";
	outsideList.appendChild(outsideItem1);

	const outsideItem2 = document.createElement("li");
	outsideItem2.textContent = "Outside: wrapped lines align with content start, not marker";
	outsideList.appendChild(outsideItem2);

	// Inside positioning for comparison
	const insideList = document.createElement("ul");
	insideList.className = "inside-list";
	document.body.appendChild(insideList);

	const insideItem1 = document.createElement("li");
	insideItem1.textContent = "Inside: marker part of content flow";
	insideList.appendChild(insideItem1);

	const insideItem2 = document.createElement("li");
	insideItem2.textContent = "Inside: wrapped lines align with content area";
	insideList.appendChild(insideItem2);

	// Demo 2: Custom markers with outside positioning
	const h2 = document.createElement("h2");
	h2.textContent = "2. Custom Markers (Outside)";
	document.body.appendChild(h2);

	const customList = document.createElement("ul");
	customList.className = "outside-list custom-markers";
	document.body.appendChild(customList);

	const customItem1 = document.createElement("li");
	customItem1.textContent = "Custom arrow marker positioned outside";
	customList.appendChild(customItem1);

	const customItem2 = document.createElement("li");
	customItem2.textContent = "Another item with custom marker";
	customList.appendChild(customItem2);

	// Demo 3: Wide markers causing overflow
	const h3 = document.createElement("h2");
	h3.textContent = "3. Wide Markers (Overflow Handling)";
	document.body.appendChild(h3);

	const wideList = document.createElement("ul");
	wideList.className = "wide-markers";
	document.body.appendChild(wideList);

	const wideItem1 = document.createElement("li");
	wideItem1.textContent = "Wide marker wider than available space";
	wideList.appendChild(wideItem1);

	const wideItem2 = document.createElement("li");
	wideItem2.textContent = "Content gets pushed to avoid overlap";
	wideList.appendChild(wideItem2);

	// Demo 4: Multi-line content
	const h4 = document.createElement("h2");
	h4.textContent = "4. Multi-line Content (Outside)";
	document.body.appendChild(h4);

	const multilineList = document.createElement("ul");
	multilineList.className = "outside-list";
	document.body.appendChild(multilineList);

	const multilineItem = document.createElement("li");
	multilineItem.textContent = "This is a very long list item that should wrap to multiple lines to demonstrate how outside positioning affects text alignment and wrapping behavior";
	multilineList.appendChild(multilineItem);

	await termdom.render();

	console.log("\nKey Points:");
	console.log("- Outside: markers appear at margin box position");
	console.log("- Outside: content starts at consistent position");
	console.log("- Outside: wrapped lines align with content, not marker");
	console.log("- Overflow: content gets pushed when marker is too wide");
}

runDemo().catch(console.error);
