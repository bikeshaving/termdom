/**
 * Comprehensive List Tests
 *
 * Tests for HTML lists (ul, ol, li) including:
 * - All list-style-type values with snapshots
 * - Nested list structures
 * - Integration with layout system
 * - Mixed content scenarios
 */

import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

// Test all unordered list style types
test("unordered list style types with snapshots", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	// Test each unordered list style type
	const unorderedStyles = [
		{name: "disc", symbol: "•"},
		{name: "circle", symbol: "◦"},
		{name: "square", symbol: "▪"},
	];

	for (const style of unorderedStyles) {
		const title = document.createElement("h3");
		title.textContent = `${style.name}:`;
		container.appendChild(title);

		const ul = document.createElement("ul");
		ul.style.listStyleType = style.name;

		// Add multiple items to test consistency
		["First item", "Second item", "Third item"].forEach((text) => {
			const li = document.createElement("li");
			li.textContent = text;
			ul.appendChild(li);
		});

		container.appendChild(ul);
	}

	await nextFrame(dom);
	const output = terminal.getStaticANSI();

	// Verify each style renders with correct symbol
	unorderedStyles.forEach((style) => {
		expect(output).toContain(style.symbol);
	});

	expect(output).toMatchSnapshot();
	terminal.writeANSI("lists-style-types-unordered");
	dom.dispose();
});

// Test all ordered list style types
test("ordered list style types with snapshots", async () => {
	const terminal = new MockProcess({cols: 40, rows: 25});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	// Test each ordered list style type
	const orderedStyles = [
		{name: "decimal", expected: ["1.", "2.", "3."]},
		{name: "lower-alpha", expected: ["a.", "b.", "c."]},
		{name: "upper-alpha", expected: ["A.", "B.", "C."]},
		{name: "lower-roman", expected: ["i.", "ii.", "iii."]},
		{name: "upper-roman", expected: ["I.", "II.", "III."]},
	];

	for (const style of orderedStyles) {
		const title = document.createElement("h3");
		title.textContent = `${style.name}:`;
		container.appendChild(title);

		const ol = document.createElement("ol");
		ol.style.listStyleType = style.name;

		// Add items to test numbering
		["First", "Second", "Third"].forEach((text) => {
			const li = document.createElement("li");
			li.textContent = text;
			ol.appendChild(li);
		});

		container.appendChild(ol);
	}

	await nextFrame(dom);
	const output = terminal.getStaticANSI();

	// Verify each style renders with correct numbering
	orderedStyles.forEach((style) => {
		style.expected.forEach((marker) => {
			expect(output).toContain(marker);
		});
	});

	expect(output).toMatchSnapshot();
	terminal.writeANSI("lists-style-types-ordered");
	dom.dispose();
});

// Test nested list structures
test("nested lists with proper indentation", async () => {
	const terminal = new MockProcess({cols: 50, rows: 15});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Create complex nested structure
	const container = document.createElement("div");
	container.innerHTML = `
		<h2>Nested Structure</h2>
		<ul>
			<li>Top level item 1</li>
			<li>Top level item 2
				<ul>
					<li>Second level A</li>
					<li>Second level B
						<ul>
							<li>Third level I</li>
							<li>Third level II</li>
						</ul>
					</li>
				</ul>
			</li>
			<li>Top level item 3</li>
		</ul>
	`;
	document.body.appendChild(container);

	await nextFrame(dom);
	const output = terminal.getStaticANSI();

	// Verify proper nesting symbols and indentation
	expect(output).toContain("• Top level item 1"); // Top level: •
	expect(output).toContain("◦ Second level A"); // Second level: ◦
	expect(output).toContain("▪ Third level I"); // Third level: ▪

	expect(output).toMatchSnapshot();
	terminal.writeANSI("lists-nesting-indentation");
	dom.dispose();
});

// Test mixed ordered/unordered nesting
test("mixed ordered and unordered nesting", async () => {
	const terminal = new MockProcess({cols: 60, rows: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.innerHTML = `
		<h2>Mixed Nesting</h2>
		<ol>
			<li>Setup Process
				<ul>
					<li>Install dependencies</li>
					<li>Configure environment</li>
				</ul>
			</li>
			<li>Development
				<ul>
					<li>Write code</li>
					<li>Test thoroughly
						<ol>
							<li>Unit tests</li>
							<li>Integration tests</li>
						</ol>
					</li>
				</ul>
			</li>
			<li>Deploy</li>
		</ol>
	`;
	document.body.appendChild(container);

	await nextFrame(dom);
	const output = terminal.getStaticANSI();

	// Verify mixed numbering systems
	expect(output).toContain("1. Setup Process");
	expect(output).toContain("2. Development");
	expect(output).toContain("◦ Install dependencies");
	expect(output).toContain("1. Unit tests"); // Nested OL restarts numbering
	expect(output).toContain("2. Integration tests");

	expect(output).toMatchSnapshot();
	terminal.writeANSI("lists-nesting-mixed-types");
	dom.dispose();
});

// Test list counter behavior and start attribute
test("list counters and start attribute", async () => {
	const terminal = new MockProcess({cols: 40, rows: 15});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	// Test start attribute
	const ol1 = document.createElement("ol");
	ol1.setAttribute("start", "5");
	["Fifth item", "Sixth item"].forEach((text) => {
		const li = document.createElement("li");
		li.textContent = text;
		ol1.appendChild(li);
	});
	container.appendChild(ol1);

	// Test different list-style-type with start
	const ol2 = document.createElement("ol");
	ol2.style.listStyleType = "lower-alpha";
	ol2.setAttribute("start", "3");
	["Third alpha", "Fourth alpha"].forEach((text) => {
		const li = document.createElement("li");
		li.textContent = text;
		ol2.appendChild(li);
	});
	container.appendChild(ol2);

	await nextFrame(dom);
	const output = terminal.getStaticANSI();

	// Verify start attribute works
	expect(output).toContain("5. Fifth item");
	expect(output).toContain("6. Sixth item");
	expect(output).toContain("c. Third alpha"); // start=3 with lower-alpha
	expect(output).toContain("d. Fourth alpha");

	expect(output).toMatchSnapshot();
	terminal.writeANSI("lists-counters-start-attribute");
	dom.dispose();
});

// Test lists with mixed content
test("lists with mixed inline and block content", async () => {
	const terminal = new MockProcess({cols: 50, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.innerHTML = `
		<h2>Lists with Rich Content</h2>
		<ul>
			<li>Text with <strong>bold</strong> and <em>italic</em></li>
			<li>Item with code: <code>console.log('hello')</code></li>
			<li>
				Item with paragraph:
				<p>This is a paragraph inside a list item with some longer text that might wrap.</p>
			</li>
			<li>
				<div>Block content</div>
				<div>Multiple blocks</div>
			</li>
		</ul>
	`;
	document.body.appendChild(container);

	await nextFrame(dom);
	const output = terminal.getStaticANSI();

	// Verify mixed content renders properly
	expect(output).toContain("Text with");
	expect(output).toContain("console.log");
	expect(output).toContain("This is a paragraph");
	expect(output).toContain("Block content");

	expect(output).toMatchSnapshot();
	terminal.writeANSI("lists-content-mixed-inline-block");
	dom.dispose();
});

// Test edge cases and error conditions
test("list edge cases", async () => {
	const terminal = new MockProcess({cols: 40, rows: 15});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	// Empty list
	const emptyUl = document.createElement("ul");
	container.appendChild(emptyUl);

	// List with only empty items
	const ul = document.createElement("ul");
	const emptyLi = document.createElement("li");
	ul.appendChild(emptyLi);
	container.appendChild(ul);

	// List item outside of list (should still get marker)
	const orphanLi = document.createElement("li");
	orphanLi.textContent = "Orphan item";
	container.appendChild(orphanLi);

	// Custom display: list-item on non-li element
	const divListItem = document.createElement("div");
	divListItem.style.display = "list-item";
	divListItem.textContent = "Div as list item";
	container.appendChild(divListItem);

	await nextFrame(dom);
	const output = terminal.getStaticANSI();

	// Should handle edge cases gracefully
	expect(output).toContain("Orphan item");
	expect(output).toContain("Div as list item");

	expect(output).toMatchSnapshot();
	terminal.writeANSI("lists-edge-cases-empty-items");
	dom.dispose();
});

// Test list performance with many items
test("list performance with many items", async () => {
	const terminal = new MockProcess({cols: 60, rows: 120});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	// Create large list
	const ul = document.createElement("ul");
	for (let i = 1; i <= 100; i++) {
		const li = document.createElement("li");
		li.textContent = `Item ${i} with some content`;
		ul.appendChild(li);
	}
	container.appendChild(ul);

	await nextFrame(dom);

	const output = terminal.getStaticANSI();
	expect(output).toContain("Item 1 with");
	expect(output).toContain("Item 100 with");

	dom.dispose();
});

// Test list layout with flexbox
test("lists in flexbox containers", async () => {
	const terminal = new MockProcess({cols: 80, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexDirection = "row";
	container.style.gap = "2ch";
	document.body.appendChild(container);

	// First column - unordered list
	const column1 = document.createElement("div");
	column1.innerHTML = `
		<h3>Tasks</h3>
		<ul>
			<li>Task 1</li>
			<li>Task 2</li>
			<li>Task 3</li>
		</ul>
	`;
	container.appendChild(column1);

	// Second column - ordered list
	const column2 = document.createElement("div");
	column2.innerHTML = `
		<h3>Steps</h3>
		<ol>
			<li>First step</li>
			<li>Second step</li>
			<li>Third step</li>
		</ol>
	`;
	container.appendChild(column2);

	await nextFrame(dom);
	const output = terminal.getStaticANSI();

	// Verify both lists render in columns
	expect(output).toContain("Tasks");
	expect(output).toContain("Steps");
	expect(output).toContain("• Task 1");
	expect(output).toContain("1. First step");

	expect(output).toMatchSnapshot();
	terminal.writeANSI("lists-layout-flexbox-containers");
	dom.dispose();
});

test("list rerendering maintains correct layout", async () => {
	const terminal = new MockProcess({cols: 40, rows: 20});
	// Override isTTY to prevent cursor detection which interferes with the test
	(terminal.stdin as any).isTTY = false;
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Initial list
	document.body.innerHTML = `
		<h3>Dynamic List</h3>
		<ul>
			<li>Item 1</li>
			<li>Item 2</li>
		</ul>
	`;

	// First render
	await nextFrame(dom);
	const firstOutput = terminal.getPlainText();

	expect(firstOutput).toContain("Dynamic List");
	expect(firstOutput).toContain("• Item 1");
	expect(firstOutput).toContain("• Item 2");

	// Clear terminal for second render
	//terminal.clear();
	// Also clear TermDOM's renderer buffer to stay in sync
	//(dom as any).renderer.clearPreviousBuffer();

	// Modify the list
	const ul = document.querySelector("ul")!;
	ul.innerHTML = `
		<li>Modified Item 1</li>
		<li>Modified Item 2</li>
		<li>New Item 3</li>
	`;

	// Second render
	await nextFrame(dom);
	const secondOutput = terminal.getPlainText();

	expect(secondOutput).toContain("Dynamic List");
	expect(secondOutput).toContain("• Modified Item 1");
	expect(secondOutput).toContain("• Modified Item 2");
	expect(secondOutput).toContain("• New Item 3");

	// Verify layout integrity - text should not be garbled
	const lines = secondOutput.split("\n");
	const dynamicListLine = lines.find((line) => line.includes("Dynamic List"));
	expect(dynamicListLine).toBeDefined();
	expect(dynamicListLine!.trim()).toBe("Dynamic List");

	dom.dispose();
});
