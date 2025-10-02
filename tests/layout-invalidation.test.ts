import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {MockProcess} from "./test-utils.js";

test("pseudo-elements render correctly after mutation observer fixes", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	// Create simple list
	const ul = document.createElement("ul");
	const li = document.createElement("li");
	li.textContent = "Item";

	ul.appendChild(li);
	document.body.appendChild(ul);

	await dom.render();

	// Wait for async writes to complete
	await new Promise((resolve) => setTimeout(resolve, 50));

	const output = terminal.getPlainText();

	// Should contain both marker and content
	expect(output).toContain("•");
	expect(output).toContain("Item");

	// Marker should appear before content
	const markerIndex = output.indexOf("•");
	const itemIndex = output.indexOf("Item");
	expect(markerIndex).toBeLessThan(itemIndex);

	dom.dispose();
});

test("multiple list items render correctly", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const ul = document.createElement("ul");

	const li1 = document.createElement("li");
	li1.textContent = "First";

	const li2 = document.createElement("li");
	li2.textContent = "Second";

	ul.appendChild(li1);
	ul.appendChild(li2);
	document.body.appendChild(ul);

	await dom.render();
	await new Promise((resolve) => setTimeout(resolve, 50));

	const output = terminal.getPlainText();

	// Should contain both items with markers
	expect(output).toContain("First");
	expect(output).toContain("Second");

	// Should have two bullet markers
	const bulletCount = (output.match(/•/g) || []).length;
	expect(bulletCount).toBe(2);

	dom.dispose();
});
