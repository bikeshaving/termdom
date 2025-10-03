import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {MockProcess} from "./test-utils.js";

test("list-style-position: inside (current behavior)", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Create a list with inside positioning (should be current behavior)
	const style = document.createElement("style");
	style.textContent = `
		ul {
			padding-left: 2ch;
			list-style-position: inside;
		}
		li::marker {
			content: "→ ";
		}
	`;
	document.head.appendChild(style);

	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	// Test single line
	const li1 = document.createElement("li");
	li1.textContent = "Short item";
	ul.appendChild(li1);

	// Test multi-line item
	const li2 = document.createElement("li");
	li2.textContent = "This is a very long item that should wrap to multiple lines to test inside positioning behavior";
	ul.appendChild(li2);

	await termdom.render();
	const output = terminal.getPlainText();

	// With inside positioning, wrapped lines should align with marker position
	const lines = output.split('\n').filter(line => line.trim());
	
	// First item should have marker + content
	expect(lines[0]).toMatch(/\s*→ Short item/);
	
	// Multi-line item: first line has marker
	expect(lines[1]).toMatch(/\s*→ This is a very long/);
	
	// In inside positioning, wrapped lines align with the content area start,
	// not with the text position after the marker
	if (lines.length > 2) {
		const firstLineContentStart = lines[1].search(/\S/); // Start of content area
		const secondLineContentStart = lines[2].search(/\S/); // Start of wrapped line
		
		// Wrapped lines should align with content area start (same indentation)
		expect(secondLineContentStart).toBe(firstLineContentStart);
	}
});

test("list-style-position: inside with wide marker", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		ul {
			padding-left: 2ch; /* Small padding */
			list-style-position: inside;
		}
		li::marker {
			content: "WIDE-MARKER: "; /* Much wider than padding */
		}
	`;
	document.head.appendChild(style);

	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	const li = document.createElement("li");
	li.textContent = "Content that should wrap and align with marker position when using inside positioning";
	ul.appendChild(li);

	await termdom.render();
	const output = terminal.getPlainText();

	// Marker should be present
	expect(output).toContain("WIDE-MARKER:");
	
	// Content should appear after marker
	expect(output).toContain("WIDE-MARKER: Content");
	
	// With inside positioning, everything flows together as inline content
	const lines = output.split('\n').filter(line => line.trim());
	expect(lines[0]).toMatch(/\s*WIDE-MARKER: Content/);
});

test("default list behavior is inside positioning", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// No explicit list-style-position set - should default to current behavior
	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	const li = document.createElement("li");
	li.textContent = "Default behavior item";
	ul.appendChild(li);

	await termdom.render();
	const output = terminal.getPlainText();

	// Should have default marker
	expect(output).toContain("• Default behavior item");
	
	// Current implementation should be inside positioning
	const lines = output.split('\n').filter(line => line.trim());
	expect(lines[0]).toMatch(/\s*• Default behavior item/);
});

test("list-style-position: outside with adequate space", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		li {
			margin-left: 1px;
			border-left-width: 1px;
			border-left-style: solid;
			border-left-color: transparent;
			padding-left: 2px; /* Total space: 4px */
			list-style-position: outside;
		}
		li::marker {
			content: "→ "; /* 2px - fits within available space */
		}
	`;
	document.head.appendChild(style);

	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	const li = document.createElement("li");
	li.textContent = "Content should start at padding position with marker outside";
	ul.appendChild(li);

	await termdom.render();
	const output = terminal.getPlainText();

	const lines = output.split('\n').filter(line => line.trim());
	
	// Marker should appear at margin box position (column 0 + margin)
	expect(lines[0]).toMatch(/^\s*→\s+Content should start/);
	
	// Content should start at its normal position
	// The actual position may include the marker width and spacing
	const contentStart = lines[0].indexOf("Content");
	expect(contentStart).toBeGreaterThanOrEqual(4); // At least margin + border + padding
});

test("list-style-position: outside with marker overflow", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		li {
			margin-left: 1px;
			border-left-width: 0px;
			padding-left: 2px; /* Total space: 3px */
			list-style-position: outside;
		}
		li::marker {
			content: "WIDE-MARKER: "; /* 13px - much wider than available 3px */
		}
	`;
	document.head.appendChild(style);

	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	const li = document.createElement("li");
	li.textContent = "Content should be pushed to avoid marker overlap";
	ul.appendChild(li);

	await termdom.render();
	const output = terminal.getPlainText();

	const lines = output.split('\n').filter(line => line.trim());
	
	// Marker should appear at margin box position (may be clipped due to overflow)
	expect(lines[0]).toMatch(/^\s*WIDE/);
	
	// Content should be positioned with some spacing to avoid complete overlap
	const contentStart = lines[0].indexOf("Content");
	expect(contentStart).toBeGreaterThan(4); // Content moved right from overflow handling
});

test("list-style-position: outside multi-line alignment", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		li {
			margin-left: 1px;
			padding-left: 2px;
			list-style-position: outside;
		}
		li::marker {
			content: "→ ";
		}
	`;
	document.head.appendChild(style);

	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	const li = document.createElement("li");
	li.textContent = "This is a very long line that should wrap to multiple lines and test outside positioning alignment behavior";
	ul.appendChild(li);

	await termdom.render();
	const output = terminal.getPlainText();

	const lines = output.split('\n').filter(line => line.trim());
	
	// First line: marker + content
	expect(lines[0]).toMatch(/^\s*→\s+This is a very long/);
	
	// Wrapped lines should align with content start, not marker
	if (lines.length > 1) {
		const firstLineContentStart = lines[0].indexOf("This");
		const secondLineContentStart = lines[1].search(/\S/);
		
		// In outside positioning, wrapped lines align with original content position
		expect(secondLineContentStart).toBe(firstLineContentStart);
	}
});

test("list-style-position: outside markers should not duplicate", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		li {
			list-style-position: outside;
			padding: 0;
			margin: 0;
		}
		li::marker {
			content: "→ ";
		}
	`;
	document.head.appendChild(style);

	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	const li = document.createElement("li");
	li.textContent = "Single marker test";
	ul.appendChild(li);

	await termdom.render();
	const output = terminal.getPlainText();

	// Should only have one arrow marker, not duplicated
	const arrowCount = (output.match(/→/g) || []).length;
	expect(arrowCount).toBe(1);

	// Should not have duplicated markers like "→ →"
	expect(output).not.toContain("→ →");
});

test("list-style-position: outside with custom content should not duplicate", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		li {
			list-style-position: outside;
			padding: 0;
			margin: 0;
		}
		li::marker {
			content: "CUSTOM-MARKER ";
		}
	`;
	document.head.appendChild(style);

	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	const li = document.createElement("li");
	li.textContent = "Custom marker test";
	ul.appendChild(li);

	await termdom.render();
	const output = terminal.getPlainText();

	// Should have custom marker content (may be clipped due to overflow)
	// Check for the beginning of the custom marker
	expect(output).toMatch(/^CU.*Custom marker test/);

	// Should not have duplicated markers
	expect(output).not.toContain("CUSTOM-MARKER CUSTOM-MARKER");
});

test("list-style-position: outside default bullet should not duplicate", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		li {
			list-style-position: outside;
			padding: 0;
			margin: 0;
		}
	`;
	document.head.appendChild(style);

	const ul = document.createElement("ul");
	document.body.appendChild(ul);

	const li = document.createElement("li");
	li.textContent = "Default bullet test";
	ul.appendChild(li);

	await termdom.render();
	const output = terminal.getPlainText();

	// Should only have one bullet marker
	const bulletCount = (output.match(/•/g) || []).length;
	expect(bulletCount).toBe(1);

	// Should not have duplicated bullets like "• •"
	expect(output).not.toContain("• •");
});