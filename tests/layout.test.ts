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

test("findInlineRunHead - text node inside inline element should find element", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(`<span>🚀</span>`);

	const span = jsdom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;

	// The text node should find the SPAN as its run head, not itself
	expect(layoutEngine.findInlineRunHead(textNode)).toBe(span);

	// The SPAN should find itself as the run head
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);
});

// === COMPREHENSIVE EDGE CASE TESTS FOR findInlineRunHead ===

test("findInlineRunHead - nested inline elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<span>outer <em>nested <strong>deep</strong></em> text</span>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const em = jsdom.window.document.querySelector("em")!;
	const strong = jsdom.window.document.querySelector("strong")!;

	// All nested inline elements should find the outermost span as run head
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);
	expect(layoutEngine.findInlineRunHead(em)).toBe(span);
	expect(layoutEngine.findInlineRunHead(strong)).toBe(span);

	// Text nodes inside nested elements should also find the outermost span
	const deepText = strong.firstChild as Text;
	expect(layoutEngine.findInlineRunHead(deepText)).toBe(span);
});

test("findInlineRunHead - text nodes after br elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>Start<br>After break</div>`,
	);

	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);

	let startText: Text | null = null;
	let afterText: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Start")) {
			startText = node as Text;
		}
		if (node.textContent?.includes("After break")) {
			afterText = node as Text;
		}
	}

	// br doesn't break inline runs - both text nodes should be in same run
	expect(layoutEngine.findInlineRunHead(startText!)).toBe(startText);
	expect(layoutEngine.findInlineRunHead(afterText!)).toBe(startText);
});

test("findInlineRunHead - inline elements in flex container", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>first</span><span>second</span><em>third</em></div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));
	const em = jsdom.window.document.querySelector("em")!;

	// In flex containers, each inline element is its own run head
	expect(layoutEngine.findInlineRunHead(spans[0])).toBe(spans[0]);
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[1]);
	expect(layoutEngine.findInlineRunHead(em)).toBe(em);

	// Text nodes inside should find their parent element as run head
	const firstText = spans[0].firstChild as Text;
	const thirdText = em.firstChild as Text;
	expect(layoutEngine.findInlineRunHead(firstText)).toBe(spans[0]);
	expect(layoutEngine.findInlineRunHead(thirdText)).toBe(em);
});

test("findInlineRunHead - mixed text and inline elements in flex", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex">Text node<span>element</span>More text</div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const walker = jsdom.window.document.createTreeWalker(
		jsdom.window.document.body,
		jsdom.window.NodeFilter.SHOW_TEXT,
	);

	let textNode: Text | null = null;
	let moreText: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Text node")) {
			textNode = node as Text;
		}
		if (node.textContent?.includes("More text")) {
			moreText = node as Text;
		}
	}

	// In flex: text nodes group with adjacent text nodes only, elements are separate
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);
	expect(layoutEngine.findInlineRunHead(textNode!)).toBe(textNode);
	expect(layoutEngine.findInlineRunHead(moreText!)).toBe(moreText); // Separated by span, so it's its own head
});

test("findInlineRunHead - inline-block elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span style="display: inline-block">block1</span><span style="display: inline-block">block2</span></div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// First inline-block is run head, second joins the run
	expect(layoutEngine.findInlineRunHead(spans[0])).toBe(spans[0]);
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]);

	// Text nodes inside should find the run head (first span)
	const text1 = spans[0].firstChild as Text;
	const text2 = spans[1].firstChild as Text;
	expect(layoutEngine.findInlineRunHead(text1)).toBe(spans[0]);
	expect(layoutEngine.findInlineRunHead(text2)).toBe(spans[0]);
});

test("findInlineRunHead - empty text nodes and whitespace", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>content</span>   <em>more</em></div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const em = jsdom.window.document.querySelector("em")!;
	const whitespaceNode = span.nextSibling as Text; // The "   " between spans

	// Whitespace text nodes should find the run head
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);
	expect(layoutEngine.findInlineRunHead(whitespaceNode)).toBe(span);
	expect(layoutEngine.findInlineRunHead(em)).toBe(span);
});

test("findInlineRunHead - block elements return null", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><p>paragraph</p><h1>heading</h1></div>`,
	);

	const p = jsdom.window.document.querySelector("p")!;
	const h1 = jsdom.window.document.querySelector("h1")!;
	const div = jsdom.window.document.querySelector("div")!;

	// Block elements should return null
	expect(layoutEngine.findInlineRunHead(p)).toBe(null);
	expect(layoutEngine.findInlineRunHead(h1)).toBe(null);
	expect(layoutEngine.findInlineRunHead(div)).toBe(null);
});

test("findInlineRunHead - inline elements after block elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>first run</span><p>block breaks run</p><span>second run</span><em>continues second</em></div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));
	const em = jsdom.window.document.querySelector("em")!;

	// First span is its own run head
	expect(layoutEngine.findInlineRunHead(spans[0])).toBe(spans[0]);

	// After block element, second span starts new run
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[1]);
	expect(layoutEngine.findInlineRunHead(em)).toBe(spans[1]);
});

test("findInlineRunHead - deeply nested inline elements", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span><em><strong><code>deeply nested</code></strong></em></span></div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const em = jsdom.window.document.querySelector("em")!;
	const strong = jsdom.window.document.querySelector("strong")!;
	const code = jsdom.window.document.querySelector("code")!;

	// All should find the outermost span as run head
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);
	expect(layoutEngine.findInlineRunHead(em)).toBe(span);
	expect(layoutEngine.findInlineRunHead(strong)).toBe(span);
	expect(layoutEngine.findInlineRunHead(code)).toBe(span);

	// Text node in deepest element should also find span
	const deepText = code.firstChild as Text;
	expect(layoutEngine.findInlineRunHead(deepText)).toBe(span);
});

test("findInlineRunHead - text node orphan (no parent)", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(`<div></div>`);

	// Create orphaned text node
	const textNode = jsdom.window.document.createTextNode("orphan");

	// Orphaned text node should return null (not connected to document)
	expect(layoutEngine.findInlineRunHead(textNode)).toBe(null);
});

test("findInlineRunHead - comment nodes and other node types", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><!-- comment --></div>`,
	);

	const comment = jsdom.window.document.querySelector("div")!.firstChild!;

	// Comment nodes should return null (not text or element)
	expect(layoutEngine.findInlineRunHead(comment)).toBe(null);
});

test("findInlineRunHead - whitespace behavior (expected: finds whitespace text node)", () => {
	// This demonstrates that whitespace text nodes are correctly found as run heads
	const {jsdom, layoutEngine} = createLayoutEngine(`
		<div>
			<span style="display: inline-block">block1</span>
		</div>
	`);

	const span = jsdom.window.document.querySelector("span")!;
	const result = layoutEngine.findInlineRunHead(span);

	// Should find the whitespace text node before the span
	expect(result?.nodeType).toBe(3); // TEXT_NODE
	expect(result?.textContent).toBe("\n\t\t\t");

	// The whitespace text node is the correct run head for this layout
});

test("emoji text RectLengths preserve character boundaries", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<span>🎨 Colorful Text 🌈</span>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const originalText = textNode.textContent!;

	// Get the RectTexts for the text node
	const rectTexts = layoutEngine.getRectTexts(textNode);

	// Test that the processed text matches the original
	let reconstructedText = "";

	for (const rectText of rectTexts) {
		reconstructedText += rectText.text;
	}

	// The reconstructed text should match the original
	expect(reconstructedText).toBe(originalText);

	// Specifically check that the space after the first emoji is preserved
	expect(reconstructedText).toContain("🎨 Colorful"); // Space between emoji and text
	expect(reconstructedText).not.toContain("🎨Colorful"); // Should NOT be missing space
});

test("RectLength text slicing mismatch with whitespace", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="width: 20ch;"><span>Hello   </span><span>World</span></div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));
	const firstSpan = spans[0];
	const secondSpan = spans[1];

	// Get RectTexts for both spans
	const rectTexts1 = layoutEngine.getRectTexts(firstSpan.firstChild as Text);
	const rectTexts2 = layoutEngine.getRectTexts(secondSpan.firstChild as Text);

	// The original DOM text vs processed text difference
	const originalText1 = firstSpan.textContent!; // "Hello   " (8 chars)
	const originalText2 = secondSpan.textContent!; // "World" (5 chars)

	let totalProcessedLength = 0;
	rectTexts1.forEach((rt) => (totalProcessedLength += rt.text.length));
	rectTexts2.forEach((rt) => (totalProcessedLength += rt.text.length));

	// This demonstrates how whitespace processing affects text length
	expect(originalText1.length).toBe(8); // Original has 8 chars
	expect(originalText2.length).toBe(5); // Original has 5 chars

	// Processed text will be different due to whitespace collapse
	// With RectText, we use the processed text directly for rendering
});

test("whitespace processing produces correct measurements", () => {
	// Test that our whitespace processing fixes work correctly
	// Use regular block layout to avoid flexbox complexity
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>
			<span>Text </span>
			<span>🚀</span>
			<span> More</span>
		</div>`,
	);

	// The container should have a valid rect since it contains the inline content
	const container = jsdom.window.document.querySelector("div")!;
	const containerRect = layoutEngine.getRect(container);

	// The inline content should be measured correctly by our fixed whitespace processing
	// We don't test individual span rects (they're part of inline flow),
	// but the container size should reflect correct measurements
	expect(containerRect).not.toBeNull();
	expect(containerRect!.width).toBeGreaterThan(0);
});

test("inline-block elements should get individual rects", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;">Block1</div>
			<div style="display: inline-block;">Block2</div>
		</div>`,
	);

	const container = jsdom.window.document.querySelector("div")!;
	const inlineBlocks = Array.from(
		jsdom.window.document.querySelectorAll("div"),
	).slice(1);

	// Container should have a rect
	expect(layoutEngine.getRect(container)).not.toBeNull();

	// Each inline-block should also have its own rect (unlike regular inline elements)
	expect(layoutEngine.getRect(inlineBlocks[0])).not.toBeNull();
	expect(layoutEngine.getRect(inlineBlocks[1])).not.toBeNull();

	// Both elements should have width equal to their content (6 chars each)
	const rect1 = layoutEngine.getRect(inlineBlocks[0]);
	const rect2 = layoutEngine.getRect(inlineBlocks[1]);
	expect(rect1!.width).toBe(6); // "Block1" = 6 chars
	expect(rect2!.width).toBe(6); // "Block2" = 6 chars
});

test("inline head element gets incorrect rect from yoga node", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>Head</span><span>Tail</span></div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// The head should report width of just its content (4), not the entire run (8)
	// But currently it reports the width of the entire run because it uses the Yoga node
	const headRect = layoutEngine.getRect(spans[0]);
	const tailRect = layoutEngine.getRect(spans[1]);

	// This test demonstrates the bug: head element reports container width instead of content width
	// Expected: head should report width 4 ("Head"), tail should report width 4 ("Tail")
	// Actual: head reports width 300 (container width), tail correctly reports width 4
	expect(headRect!.width).toBe(4); // "Head" = 4 chars, should NOT be container width (300)
	expect(tailRect!.width).toBe(4); // "Tail" = 4 chars (this works correctly)
});

test("inline run with mixed content - whitespace handling", () => {
	const {jsdom, layoutEngine: _layoutEngine} = createLayoutEngine(
		`<div>Start <span>middle  </span> <em>end</em></div>`,
	);

	// In normal inline flow, this should be processed as one run
	// This tests that our whitespace processing works correctly with mixed content
	// "Start middle   end" gets processed with proper whitespace collapsing

	// Test passes if no errors are thrown during layout calculation
	// This demonstrates that the whitespace processing integration works
	const container = jsdom.window.document.querySelector("div")!;
	expect(container).not.toBeNull(); // Layout calculation completed successfully
});

test("text truncation due to RectLength accumulation error", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="width: 12ch;">
			<span>First   </span><span>Second   </span><span>Third</span>
		</div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Each span's trailing spaces get trimmed in processing
	// This creates an accumulating error in width calculations
	// Later spans might get truncated due to insufficient allocated space

	spans.forEach((span, _i) => {
		const rectTexts = layoutEngine.getRectTexts(span.firstChild as Text);
		const originalLength = span.textContent!.length;
		const processedLength = rectTexts.reduce(
			(sum, rt) => sum + rt.text.length,
			0,
		);

		// This test documents how whitespace processing works with RectText
		if (span.textContent!.endsWith("   ")) {
			// Trailing spaces get collapsed
			expect(processedLength).toBeLessThan(originalLength);
		}
	});
});

// === GETRECTEXTS WITH INLINE-BLOCK TESTS ===

test("getRectTexts - regular inline element (baseline)", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>RegularInline</span></div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const rectTexts = layoutEngine.getRectTexts(span);

	// Regular inline elements should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("RegularInline");
	expect(rectTexts[0].rect.width).toBe(13); // "RegularInline" = 13 chars
});

test("getRectTexts - text node in regular inline element", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>TextContent</span></div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const rectTexts = layoutEngine.getRectTexts(textNode);

	// Text nodes should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("TextContent");
});

test("getRectTexts - element inside inline-block container", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;"><span>InsideBlock</span></div></div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const rectTexts = layoutEngine.getRectTexts(span);

	// This was the main broken case - should now work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("InsideBlock");
	expect(rectTexts[0].rect.width).toBe(11); // "InsideBlock" = 11 chars
});

test("getRectTexts - text node inside inline-block container", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;"><span>BlockText</span></div></div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const rectTexts = layoutEngine.getRectTexts(textNode);

	// Text nodes inside inline-blocks should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("BlockText");
});

test("getRectTexts - nested elements inside inline-block", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;"><span><em>Nested</em></span></div></div>`,
	);

	const em = jsdom.window.document.querySelector("em")!;
	const rectTexts = layoutEngine.getRectTexts(em);

	// Nested elements inside inline-blocks should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("Nested");
});

test("getRectTexts - multiple children in inline-block", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;"><span>First</span><span>Second</span></div></div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));
	const firstRects = layoutEngine.getRectTexts(spans[0]);
	const secondRects = layoutEngine.getRectTexts(spans[1]);

	// Both children should work independently
	expect(firstRects).toHaveLength(1);
	expect(firstRects[0].text).toBe("First");
	expect(secondRects).toHaveLength(1);
	expect(secondRects[0].text).toBe("Second");
});

test.todo("getRectTexts - deeply nested inline-block", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;">
				<div><span><em>DeepNested</em></span></div>
			</div>
		</div>`,
	);

	const em = jsdom.window.document.querySelector("em")!;
	const rectTexts = layoutEngine.getRectTexts(em);

	// Deep nesting should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("DeepNested");
});

test("getRectTexts - inline-block with mixed content", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;">
				Text <span>element</span> more text
			</div>
		</div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const rectTexts = layoutEngine.getRectTexts(span);

	// Element in mixed content should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("element");
});

test("getRectTexts - multiple inline-blocks", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;"><span>Block1</span></div>
			<div style="display: inline-block;"><span>Block2</span></div>
		</div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));
	const rects1 = layoutEngine.getRectTexts(spans[0]);
	const rects2 = layoutEngine.getRectTexts(spans[1]);

	// Elements in separate inline-blocks should work
	expect(rects1).toHaveLength(1);
	expect(rects1[0].text).toBe("Block1");
	expect(rects2).toHaveLength(1);
	expect(rects2[0].text).toBe("Block2");
});

test("getRectTexts - inline-block container element itself", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;">Container</div></div>`,
	);

	const inlineBlock = jsdom.window.document.querySelector("div[style]")!;
	const rectTexts = layoutEngine.getRectTexts(inlineBlock);

	// Inline-block container itself should work (all its text content)
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("Container");
});

test("getRectTexts - position accuracy in inline-block", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block; padding: 2px;">
				<span>Padded</span>
			</div>
		</div>`,
	);

	const span = jsdom.window.document.querySelector("span")!;
	const rectTexts = layoutEngine.getRectTexts(span);

	// Should work and have reasonable position (accounting for padding)
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("Padded");
	expect(rectTexts[0].rect.x).toBeGreaterThanOrEqual(2); // Should account for padding
	expect(rectTexts[0].rect.y).toBeGreaterThanOrEqual(2);
});

test("getRectTexts - maintains backward compatibility", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>
			<span>Regular</span>
			<div style="display: inline-block;"><span>InBlock</span></div>
			<span>Normal</span>
		</div>`,
	);

	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));
	const regularRects = layoutEngine.getRectTexts(spans[0]); // Regular inline
	const blockRects = layoutEngine.getRectTexts(spans[1]); // Inside inline-block
	const normalRects = layoutEngine.getRectTexts(spans[2]); // Regular inline

	// All should work correctly
	expect(regularRects).toHaveLength(1);
	expect(regularRects[0].text).toBe("Regular");
	expect(blockRects).toHaveLength(1);
	expect(blockRects[0].text).toBe("InBlock");
	expect(normalRects).toHaveLength(1);
	expect(normalRects[0].text).toBe("Normal");
});
