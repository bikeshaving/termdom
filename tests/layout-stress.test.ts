import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {TestTerminal} from "./test-utils.js";

/**
 * Stress tests for the layout system, focusing on inline run management
 * and dynamic DOM changes that affect layout calculations.
 *
 * Expected: Most of these tests will initially fail, revealing issues
 * with inline run invalidation and layout updates.
 */

test("Inline run head changes - text to element", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Initial text content";
	termdom.document.body.appendChild(div);

	// Initial render
	await termdom.render();
	const _initialOutput = terminal.getPlainText();

	// Change run head from text to span element
	div.innerHTML = "<span>New span content</span>";

	// Re-render and verify layout updates
	await termdom.render();
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("New span content");
	expect(updatedOutput).not.toContain("Initial text");
});

test("Inline run head changes - element to text", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "<span>Initial span</span>";
	termdom.document.body.appendChild(div);

	// Initial render
	await termdom.render();
	const _initialOutput = terminal.getPlainText();

	// Change run head from span to text
	div.innerHTML = "New text content";

	// Re-render and verify layout updates
	await termdom.render();
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("New text content");
	expect(updatedOutput).not.toContain("Initial span");
});

test.todo("Adding inline elements to existing run", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Start ";
	termdom.document.body.appendChild(div);

	// Initial render
	await termdom.render();

	// Add inline elements dynamically
	const span1 = termdom.document.createElement("span");
	span1.textContent = "middle ";
	div.appendChild(span1);

	const span2 = termdom.document.createElement("strong");
	span2.textContent = "end";
	div.appendChild(span2);

	// Re-render and verify all content appears on same line
	await termdom.render();
	const output = terminal.getPlainText();

	expect(output).toContain("Start middle end");
	// Verify they're on the same line (no unexpected line breaks)
	const lines = output.split("\n").filter((line) => line.trim());
	expect(lines[0]).toContain("Start middle end");
});

test.todo("Removing inline elements from run", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = 'Start <span id="remove">REMOVE</span> end';
	termdom.document.body.appendChild(div);

	// Initial render
	await termdom.render();
	const _initialOutput = terminal.getPlainText();
	expect(_initialOutput).toContain("Start REMOVE end");

	// Remove the middle element
	const elementToRemove = termdom.document.getElementById("remove")!;
	elementToRemove.remove();

	// Re-render and verify element is gone, run is updated
	await termdom.render();
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("Start end");
	expect(updatedOutput).not.toContain("REMOVE");
});

test.todo("Block element interrupting inline run", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const container = termdom.document.createElement("div");
	container.innerHTML = 'Before <span id="inline">inline</span> after';
	termdom.document.body.appendChild(container);

	// Initial render - should be on one line
	await termdom.render();
	const _initialOutput = terminal.getPlainText();

	// Insert block element in the middle
	const blockDiv = termdom.document.createElement("div");
	blockDiv.textContent = "BLOCK ELEMENT";
	blockDiv.style.display = "block";

	const inlineSpan = termdom.document.getElementById("inline")!;
	container.insertBefore(blockDiv, inlineSpan);

	// Re-render and verify block element creates line breaks
	await termdom.render();
	const updatedOutput = terminal.getPlainText();
	const lines = updatedOutput.split("\n").filter((line) => line.trim());

	// Should have multiple lines now
	expect(lines.length).toBeGreaterThan(1);
	expect(updatedOutput).toContain("Before");
	expect(updatedOutput).toContain("BLOCK ELEMENT");
	expect(updatedOutput).toContain("inline after");
});

test("Inline-block elements affecting run layout", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Text before ";
	termdom.document.body.appendChild(div);

	// Add inline-block element
	const inlineBlock = termdom.document.createElement("span");
	inlineBlock.style.display = "inline-block";
	inlineBlock.style.width = "10ch";
	inlineBlock.style.height = "2";
	inlineBlock.textContent = "Block";
	div.appendChild(inlineBlock);

	const textAfter = termdom.document.createTextNode(" text after");
	div.appendChild(textAfter);

	// Render and verify inline-block is treated as atomic unit
	await termdom.render();
	const output = terminal.getPlainText();

	expect(output).toContain("Text before");
	expect(output).toContain("Block");
	expect(output).toContain("text after");
});

test.todo("Nested inline element changes", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML =
		'Start <span>outer <em id="nested">nested</em> content</span> end';
	termdom.document.body.appendChild(div);

	// Initial render
	await termdom.render();
	const _initialOutput = terminal.getPlainText();

	// Change nested element content
	const nested = termdom.document.getElementById("nested")!;
	nested.textContent = "CHANGED";

	// Re-render and verify nested change updates run
	await termdom.render();
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("Start outer CHANGED content end");
	expect(updatedOutput).not.toContain("nested");
});

test.todo("Rapid DOM changes stress test", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const container = termdom.document.createElement("div");
	container.innerHTML = "Base content";
	termdom.document.body.appendChild(container);

	// Perform rapid changes
	for (let i = 0; i < 5; i++) {
		// Add element
		const span = termdom.document.createElement("span");
		span.textContent = ` item${i}`;
		span.id = `item${i}`;
		container.appendChild(span);

		// Render after each change
		await termdom.render();

		// Verify content is present
		const output = terminal.getPlainText();
		expect(output).toContain(`item${i}`);
	}

	// Remove elements rapidly
	for (let i = 4; i >= 0; i--) {
		const element = termdom.document.getElementById(`item${i}`)!;
		element.remove();

		await termdom.render();

		// Verify element is gone
		const output = terminal.getPlainText();
		expect(output).not.toContain(`item${i}`);
	}

	// Final check - only base content should remain
	const finalOutput = terminal.getPlainText();
	expect(finalOutput.trim()).toBe("Base content");
});

test.todo("Complex inline run with mixed content types", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = `
		Text 
		<span>span</span>
		<strong>strong</strong>
		<em>em</em>
		<code>code</code>
		more text
	`
		.replace(/\s+/g, " ")
		.trim();

	termdom.document.body.appendChild(div);

	// Initial render
	await termdom.render();
	const _initialOutput = terminal.getPlainText();

	// Modify one element in the middle
	const strong = div.querySelector("strong")!;
	strong.textContent = "MODIFIED";

	// Re-render and verify entire run updates correctly
	await termdom.render();
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("Text span MODIFIED em code more text");
	expect(updatedOutput).not.toContain("strong");
});

test.todo("Text node splitting and merging", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	const textNode = termdom.document.createTextNode("This is a long text node");
	div.appendChild(textNode);
	termdom.document.body.appendChild(div);

	// Initial render
	await termdom.render();

	// Split the text node
	textNode.splitText(10); // Split at "This is a "

	// Re-render and verify layout handles split text
	await termdom.render();
	const splitOutput = terminal.getPlainText();
	expect(splitOutput).toContain("This is a long text node");

	// Insert element between text nodes
	const span = termdom.document.createElement("span");
	span.textContent = "[INSERTED]";
	div.insertBefore(span, div.childNodes[1]);

	// Final render
	await termdom.render();
	const finalOutput = terminal.getPlainText();
	expect(finalOutput).toContain("This is a [INSERTED]long text node");
});

test("White-space handling in dynamic inline runs", async () => {
	const terminal = new TestTerminal({cols: 40, rows: 10});
	const termdom = new TermDOM({
		width: 40,
		height: 10,
		process: terminal as any,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Word1    <span>   Word2   </span>    Word3";
	termdom.document.body.appendChild(div);

	// Initial render
	await termdom.render();
	const _initialOutput = terminal.getPlainText();

	// Remove the span
	const span = div.querySelector("span")!;
	span.remove();

	// Re-render and verify whitespace is handled correctly
	await termdom.render();
	const updatedOutput = terminal.getPlainText();

	// Should collapse whitespace appropriately
	expect(updatedOutput).toContain("Word1");
	expect(updatedOutput).toContain("Word3");
	expect(updatedOutput).not.toContain("Word2");
});
