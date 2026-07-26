import {test, expect} from "bun:test";
import {TermDOM} from "../src/_termdom.js";
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

test("a class change does not swallow later mutations in the same batch", async () => {
	// #handleMutationRecords returned from the whole function on an attributes or
	// characterData record instead of continuing to the next one, so a class flip
	// followed by a sibling's text change dropped the text change: the sibling's
	// new text node never entered the layout tree and the row rendered empty.
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;

	const header = document.createElement("div");
	header.textContent = "HEADER v1";
	const row = document.createElement("div");
	row.textContent = "row one";
	document.body.append(header, row);
	await dom.render();

	// The breaking order: attribute mutation first, then the text replacement.
	row.className = "selected";
	header.textContent = "HEADER v2";
	await dom.render();

	const buffer = (terminal as any).terminal.buffer.active;
	const line = (i: number): string =>
		(buffer.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, "");
	expect(line(0)).toBe("HEADER v2");
	expect(line(1)).toBe("row one");

	dom.dispose();
});
