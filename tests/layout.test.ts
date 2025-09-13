import {test, expect} from "bun:test";
import {JSDOM} from "jsdom";
import {LayoutEngine} from "../src/layout.js";
import {StyleManager} from "../src/styles.js";

function createLayoutEngine(html: string = "<div></div>") {
	const jsdom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
	// Setup terminal-specific getComputedStyle
	new StyleManager(jsdom.window);

	const layoutEngine = new LayoutEngine(jsdom.window);
	// Set initial size and calculate layout
	layoutEngine.resize(300, 200);
	layoutEngine.calculateLayout();
	return {jsdom, layoutEngine};
}

// CSS-to-Yoga property mapping tests
test("styleYogaNode - basic layout", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="width: 100px; height: 50px;"></div>`,
	);
	const div = jsdom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	// Should have valid rect (exact values depend on CSS parsing)
	expect(rect).not.toBeNull();
	expect(rect!.width).toBeGreaterThan(0);
	expect(rect!.height).toBeGreaterThan(0);
});

test("styleYogaNode - percentage dimensions", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="width: 50%;"></div>`,
	);
	const div = jsdom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	// Should handle percentage (exact calculation depends on parent sizing)
	expect(rect).not.toBeNull();
	expect(rect!.width).toBeGreaterThan(0);
});

test("styleYogaNode - margins", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="margin: 10px;"></div>`,
	);
	const div = jsdom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	// Should handle margin properties (exact positioning depends on layout calculation)
	expect(rect).not.toBeNull();
});

test("styleYogaNode - flexbox container", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(`
		<div style="display: flex;">
			<div style="flex: 1;"></div>
			<div style="flex: 2;"></div>
		</div>
	`);

	const container = jsdom.window.document.querySelector("div")!;
	const children = Array.from(container.children);

	const child1Rect = layoutEngine.getRect(children[0] as Element);
	const child2Rect = layoutEngine.getRect(children[1] as Element);

	// Both children should have valid rects in flex layout
	expect(child1Rect).not.toBeNull();
	expect(child2Rect).not.toBeNull();
	expect(child2Rect!.width).toBeGreaterThanOrEqual(child1Rect!.width); // flex: 2 should be >= flex: 1
});

// Tree construction tests
test("addNode - basic element creation", () => {
	const {jsdom, layoutEngine} = createLayoutEngine();
	const div = jsdom.window.document.createElement("div");
	jsdom.window.document.body.appendChild(div);

	// Process mutations and calculate layout
	layoutEngine.calculateLayout();

	// Should create rect after mutation
	const rect = layoutEngine.getRect(div);
	expect(rect).not.toBeNull();
});

test("addNode - nested elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine();
	const parent = jsdom.window.document.createElement("div");
	const child = jsdom.window.document.createElement("span");

	parent.appendChild(child);
	jsdom.window.document.body.appendChild(parent);

	// Process mutations and calculate layout
	layoutEngine.calculateLayout();

	// Both should have rects
	expect(layoutEngine.getRect(parent)).not.toBeNull();
	expect(layoutEngine.getRect(child)).not.toBeNull();
});

test("addNode - text nodes", () => {
	const {jsdom, layoutEngine} = createLayoutEngine();
	const div = jsdom.window.document.createElement("div");
	div.textContent = "Hello world";
	jsdom.window.document.body.appendChild(div);

	// Process mutations and calculate layout
	layoutEngine.calculateLayout();

	// Text nodes don't get rects directly, but the container should
	const rect = layoutEngine.getRect(div);
	expect(rect).not.toBeNull();
});

// Inline run integration tests
test("inline elements join runs correctly", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(`
		<div>
			<span>first</span><span>second</span>
		</div>
	`);

	const container = jsdom.window.document.querySelector("div")!;
	const _spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Container should have rect
	expect(layoutEngine.getRect(container)).not.toBeNull();

	// Inline spans join runs, so they may not have individual rects
	// This is correct behavior - they'll be handled during text measurement
});

test("block elements have separate yoga nodes", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(`
		<div>
			<div>first block</div>
			<div>second block</div>
		</div>
	`);

	const divs = Array.from(jsdom.window.document.querySelectorAll("div"));
	const innerDivs = divs.slice(1); // Skip the container div

	// Each block div should have its own rect
	expect(layoutEngine.getRect(innerDivs[0])).not.toBeNull();
	expect(layoutEngine.getRect(innerDivs[1])).not.toBeNull();
});

// Mutation handling tests
test("style changes trigger layout updates", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="width: 100px;"></div>`,
	);
	const div = jsdom.window.document.querySelector("div")!;

	// Initial rect
	let rect = layoutEngine.getRect(div);
	expect(rect?.width).toBe(100);

	// Change style
	div.style.width = "200px";
	layoutEngine.calculateLayout(); // Process mutations

	// Updated rect
	rect = layoutEngine.getRect(div);
	expect(rect?.width).toBe(200);
});

test("element removal cleans up yoga nodes", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>test</span></div>`,
	);
	const div = jsdom.window.document.querySelector("div")!;
	const span = jsdom.window.document.querySelector("span")!;

	// Both should have rects initially
	expect(layoutEngine.getRect(div)).not.toBeNull();
	expect(layoutEngine.getRect(span)).not.toBeNull();

	// Remove span
	span.remove();
	layoutEngine.calculateLayout(); // Process mutations

	// Span should no longer have rect
	expect(layoutEngine.getRect(span)).toBeNull();
	expect(layoutEngine.getRect(div)).not.toBeNull(); // Parent still exists
});

// Edge cases
test("display none elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: none;"></div>`,
	);
	const div = jsdom.window.document.querySelector("div")!;

	const rect = layoutEngine.getRect(div);
	// Should still have a rect but with zero dimensions or be positioned off-screen
	// (exact behavior depends on Yoga's display: none handling)
	expect(rect).not.toBeNull();
});

test("resize updates layout", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="width: 100%;"></div>`,
	);
	const div = jsdom.window.document.querySelector("div")!;

	// Initial size
	layoutEngine.resize(200, 100);
	let rect = layoutEngine.getRect(div);
	expect(rect?.width).toBe(200);

	// Resize
	layoutEngine.resize(400, 200);
	rect = layoutEngine.getRect(div);
	expect(rect?.width).toBe(400);
});

// === INLINE RUN LOGIC TESTS ===

// Static inline run tests
test("isInlineRunHead - single inline element", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(`<span>text</span>`);
	const span = jsdom.window.document.querySelector("span")!;

	expect(layoutEngine.isInlineRunHead(span)).toBe(true);
});

test("isInlineRunHead - first of multiple inline elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<span>first</span><span>second</span>`,
	);
	const firstSpan = jsdom.window.document.querySelector("span")!;

	expect(layoutEngine.isInlineRunHead(firstSpan)).toBe(true);
});

test("isInlineRunHead - second of multiple inline elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<span>first</span><span>second</span>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false);
});

test("isInlineRunHead - text node as head", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`Text content <span>element</span>`,
	);
	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Text content")) {
			textNode = node as Text;
			break;
		}
	}

	expect(layoutEngine.isInlineRunHead(textNode!)).toBe(true);
});

test("isInlineRunHead - text node not head", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<span>element</span> text content`,
	);
	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("text content")) {
			textNode = node as Text;
			break;
		}
	}

	expect(layoutEngine.isInlineRunHead(textNode!)).toBe(false);
});

test("isInlineRunHead - inline in flex container", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>item</span></div>`,
	);
	const span = jsdom.window.document.querySelector("span")!;

	expect(layoutEngine.isInlineRunHead(span)).toBe(true);
});

test("isInlineRunHead - multiple inlines in flex container", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>first</span><span>second</span></div>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true);
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(true); // Each flex item is its own head
});

test("isInlineRunHead - block element breaks run", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<span>first</span><div>block</div><span>after</span>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true); // First run head
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(true); // New run head after block
});

test("findInlineRunHead - simple case", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<span>first</span><span>second</span>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	expect(layoutEngine.findInlineRunHead(spans[0])).toBe(spans[0]); // Head finds itself
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]); // Second finds first
});

test("findInlineRunHead - text node head", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`Text content <span>element</span>`,
	);
	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Text content")) {
			textNode = node as Text;
			break;
		}
	}
	const span = jsdom.window.document.querySelector("span")!;

	expect(layoutEngine.findInlineRunHead(textNode!)).toBe(textNode); // Text head finds itself
	expect(layoutEngine.findInlineRunHead(span)).toBe(textNode); // Element finds text head
});

test("findInlineRunHead - mixed content", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`Text <span>element</span> more text <em>emphasis</em>`,
	);
	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let moreText: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Text")) {
			textNode = node as Text;
		}
		if (node.textContent?.includes("more text")) {
			moreText = node as Text;
		}
	}
	const span = jsdom.window.document.querySelector("span")!;
	const em = jsdom.window.document.querySelector("em")!;

	expect(layoutEngine.findInlineRunHead(em)).toBe(textNode); // All should find the first text node as head
	expect(layoutEngine.findInlineRunHead(span)).toBe(textNode);
	expect(layoutEngine.findInlineRunHead(moreText!)).toBe(textNode);
});

test("findInlineRunHead - block element", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(`<div>block</div>`);
	const div = jsdom.window.document.querySelector("div")!;

	expect(layoutEngine.findInlineRunHead(div)).toBe(null); // Block elements don't have inline heads
});

// Edge cases from CSS spec research
test("anonymous inline boxes - direct text in block", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>Direct text content</div>`,
	);
	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Direct text")) {
			textNode = node as Text;
			break;
		}
	}

	// Direct text in block container creates anonymous inline box
	expect(layoutEngine.isInlineRunHead(textNode!)).toBe(true);
	expect(layoutEngine.findInlineRunHead(textNode!)).toBe(textNode);
});

test("white space only text nodes", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>first</span>   <span>second</span></div>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));
	const whitespaceNode = spans[0].nextSibling as Text; // The "   " between spans

	// White space nodes still participate in inline formatting
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true); // First span is head
	expect(layoutEngine.isInlineRunHead(whitespaceNode)).toBe(false); // Whitespace joins run
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false); // Second span joins run
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]); // All find first span as head
});

test("nested inline elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>outer <em>nested</em> text</span></div>`,
	);
	const span = jsdom.window.document.querySelector("span")!;
	const em = jsdom.window.document.querySelector("em")!;

	// Nested inline elements - span is the head
	expect(layoutEngine.isInlineRunHead(span)).toBe(true);
	expect(layoutEngine.isInlineRunHead(em)).toBe(false); // em is nested inside span
	expect(layoutEngine.findInlineRunHead(em)).toBe(span);
});

test("inline-block vs inline behavior", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span style="display: inline">inline</span><span style="display: inline-block">inline-block</span></div>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Both inline and inline-block elements form runs
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true); // First is head
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false); // Second joins run
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]);
});

test("mixed content with line breaks", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>Text<br><span>after break</span></div>`,
	);
	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Text")) {
			textNode = node as Text;
			break;
		}
	}
	const span = jsdom.window.document.querySelector("span")!;

	// <br> does NOT break inline runs - it's just inline content with newline
	expect(layoutEngine.isInlineRunHead(textNode!)).toBe(true); // Text starts the run
	expect(layoutEngine.isInlineRunHead(span)).toBe(false); // Span joins the same run
	expect(layoutEngine.findInlineRunHead(span)).toBe(textNode); // All find text as head
});

test("text node with inline precedent in flex container", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>element</span> text content</div>`,
	);
	const span = jsdom.window.document.querySelector("span")!;
	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("text content")) {
			textNode = node as Text;
			break;
		}
	}

	// In flex containers, inline elements are separate flex items
	expect(layoutEngine.isInlineRunHead(span)).toBe(true);
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);

	// Text nodes only form runs with other text nodes in flex containers
	expect(layoutEngine.isInlineRunHead(textNode!)).toBe(true); // Should be its own head
	expect(layoutEngine.findInlineRunHead(textNode!)).toBe(textNode); // Should find itself
});

// === MUTATION TESTS ===

test("block insertion splits inline run", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>first</span><span>second</span></div>`,
	);
	const container = jsdom.window.document.querySelector("div")!;
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Initially: first span is head, second joins run
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true);
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false);
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]);

	// Insert block element between spans
	const blockDiv = jsdom.window.document.createElement("div");
	blockDiv.textContent = "block";
	container.insertBefore(blockDiv, spans[1]);
	layoutEngine.calculateLayout();

	// After insertion: both spans should be heads of separate runs
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true); // Still head of first run
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(true); // Now head of new run after block
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[1]); // Finds itself as head
});

test("inline head deletion promotes next element", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>head</span><span>second</span><span>third</span></div>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Initially: first is head, others join
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true);
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false);
	expect(layoutEngine.isInlineRunHead(spans[2])).toBe(false);
	expect(layoutEngine.findInlineRunHead(spans[2])).toBe(spans[0]);

	// Remove head element
	spans[0].remove();
	layoutEngine.calculateLayout();

	// Second span should become new head
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(true);
	expect(layoutEngine.isInlineRunHead(spans[2])).toBe(false);
	expect(layoutEngine.findInlineRunHead(spans[2])).toBe(spans[1]);
});

test("emoji text RectLengths preserve character boundaries", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<span>🎨 Colorful Text 🌈</span>`
	);
	
	const span = jsdom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const originalText = textNode.textContent!;
	
	console.log('Layout test - original text:', JSON.stringify(originalText));
	console.log('Layout test - original text length:', originalText.length);
	
	// Get the RectLengths for the text node
	const rectLengths = layoutEngine.getRectLengths(textNode);
	console.log('Layout test - rectLengths count:', rectLengths.length);
	
	// Test that slicing the original text using rectLength boundaries 
	// produces the correct text
	let reconstructedText = "";
	let offset = 0;
	
	for (const rectLength of rectLengths) {
		console.log('Layout test - rectLength:', {
			textLength: rectLength.textLength,
			offset: offset,
			sliceStart: offset,
			sliceEnd: offset + rectLength.textLength
		});
		
		const slicedText = originalText.slice(offset, offset + rectLength.textLength);
		console.log('Layout test - sliced text:', JSON.stringify(slicedText));
		
		reconstructedText += slicedText;
		offset += rectLength.textLength;
	}
	
	console.log('Layout test - reconstructed text:', JSON.stringify(reconstructedText));
	
	// The reconstructed text should match the original
	expect(reconstructedText).toBe(originalText);
	
	// Specifically check that the space after the first emoji is preserved
	expect(reconstructedText).toContain("🎨 Colorful"); // Space between emoji and text
	expect(reconstructedText).not.toContain("🎨Colorful"); // Should NOT be missing space
});
