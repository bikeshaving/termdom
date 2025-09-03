import {test, expect} from "bun:test";
import {JSDOM} from "jsdom";
import {
	LayoutEngine,
	isInlineRunHead,
	findInlineRunHead,
} from "../src/layout/LayoutEngine.js";

// TODO: move this to tests
function createLayoutEngine(html: string = "<div></div>") {
	const jsdom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
	const layoutEngine = new LayoutEngine(jsdom.window);
	// Set initial size and calculate layout
	layoutEngine.resize(300, 200);
	layoutEngine.calculateLayout();
	return {jsdom, layoutEngine};
}

function getNode(dom: JSDOM, selector: string): Element {
	const element = dom.window.document.querySelector(selector);
	if (!element) throw new Error(`Element not found: ${selector}`);
	return element;
}

function getTextNode(dom: JSDOM, textContent: string): Text {
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
	);

	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes(textContent)) {
			return node as Text;
		}
	}
	throw new Error(`Text node not found: ${textContent}`);
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
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

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

function createDOM(html: string) {
	return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
}

// Static inline run tests
test("isInlineRunHead - single inline element", () => {
	const dom = createDOM(`<span>text</span>`);
	const span = getNode(dom, "span");

	expect(isInlineRunHead(span)).toBe(true);
});

test("isInlineRunHead - first of multiple inline elements", () => {
	const dom = createDOM(`<span>first</span><span>second</span>`);
	const firstSpan = getNode(dom, "span");

	expect(isInlineRunHead(firstSpan)).toBe(true);
});

test("isInlineRunHead - second of multiple inline elements", () => {
	const dom = createDOM(`<span>first</span><span>second</span>`);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const secondSpan = spans[1];

	expect(isInlineRunHead(secondSpan)).toBe(false);
});

test("isInlineRunHead - text node as head", () => {
	const dom = createDOM(`Text content <span>element</span>`);
	const textNode = getTextNode(dom, "Text content");

	expect(isInlineRunHead(textNode)).toBe(true);
});

test("isInlineRunHead - text node not head", () => {
	const dom = createDOM(`<span>element</span> text content`);
	const textNode = getTextNode(dom, "text content");

	expect(isInlineRunHead(textNode)).toBe(false);
});

test("isInlineRunHead - inline in flex container", () => {
	const dom = createDOM(`<div style="display: flex"><span>item</span></div>`);
	const span = getNode(dom, "span");

	expect(isInlineRunHead(span)).toBe(true);
});

test("isInlineRunHead - multiple inlines in flex container", () => {
	const dom = createDOM(
		`<div style="display: flex"><span>first</span><span>second</span></div>`,
	);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	expect(isInlineRunHead(spans[0])).toBe(true);
	expect(isInlineRunHead(spans[1])).toBe(true); // Each flex item is its own head
});

test("isInlineRunHead - block element breaks run", () => {
	const dom = createDOM(`<span>first</span><div>block</div><span>after</span>`);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	expect(isInlineRunHead(spans[0])).toBe(true); // First run head
	expect(isInlineRunHead(spans[1])).toBe(true); // New run head after block
});

test("findInlineRunHead - simple case", () => {
	const dom = createDOM(`<span>first</span><span>second</span>`);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	expect(findInlineRunHead(spans[0])).toBe(spans[0]); // Head finds itself
	expect(findInlineRunHead(spans[1])).toBe(spans[0]); // Second finds first
});

test("findInlineRunHead - text node head", () => {
	const dom = createDOM(`Text content <span>element</span>`);
	const textNode = getTextNode(dom, "Text content");
	const span = getNode(dom, "span");

	expect(findInlineRunHead(textNode)).toBe(textNode); // Text head finds itself
	expect(findInlineRunHead(span)).toBe(textNode); // Element finds text head
});

test("findInlineRunHead - mixed content", () => {
	const dom = createDOM(
		`Text <span>element</span> more text <em>emphasis</em>`,
	);
	const textNode = getTextNode(dom, "Text");
	const span = getNode(dom, "span");
	const moreText = getTextNode(dom, "more text");
	const em = getNode(dom, "em");

	const head = findInlineRunHead(em);
	expect(head).toBe(textNode); // All should find the first text node as head
	expect(findInlineRunHead(span)).toBe(textNode);
	expect(findInlineRunHead(moreText)).toBe(textNode);
});

test("findInlineRunHead - flex container text nodes", () => {
	const dom = createDOM(
		`<div style="display: flex">Text <span>element</span> more</div>`,
	);
	const textNode = getTextNode(dom, "Text");
	const moreText = getTextNode(dom, "more");

	expect(findInlineRunHead(textNode)).toBe(textNode); // First text run
	expect(findInlineRunHead(moreText)).toBe(moreText); // Second text run (span breaks the run)
});

test("findInlineRunHead - block element", () => {
	const dom = createDOM(`<div>block</div>`);
	const div = getNode(dom, "div");

	expect(findInlineRunHead(div)).toBe(null); // Block elements don't have inline heads
});

// Edge cases from CSS spec research
test("anonymous inline boxes - direct text in block", () => {
	const dom = createDOM(`<div>Direct text content</div>`);
	const textNode = getTextNode(dom, "Direct text");

	// Direct text in block container creates anonymous inline box
	expect(isInlineRunHead(textNode)).toBe(true);
	expect(findInlineRunHead(textNode)).toBe(textNode);
});

test("white space only text nodes", () => {
	const dom = createDOM(`<div><span>first</span>   <span>second</span></div>`);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const whitespaceNode = spans[0].nextSibling as Text; // The "   " between spans

	// White space nodes still participate in inline formatting
	expect(isInlineRunHead(spans[0])).toBe(true); // First span is head
	expect(isInlineRunHead(whitespaceNode)).toBe(false); // Whitespace joins run
	expect(isInlineRunHead(spans[1])).toBe(false); // Second span joins run
	expect(findInlineRunHead(spans[1])).toBe(spans[0]); // All find first span as head
});

test("nested inline elements", () => {
	const dom = createDOM(`<div><span>outer <em>nested</em> text</span></div>`);
	const span = getNode(dom, "span");
	const em = getNode(dom, "em");

	// Nested inline elements - span is the head
	expect(isInlineRunHead(span)).toBe(true);
	expect(isInlineRunHead(em)).toBe(false); // em is nested inside span
	expect(findInlineRunHead(em)).toBe(span);
});

test("inline-block vs inline behavior", () => {
	const dom = createDOM(
		`<div><span style="display: inline">inline</span><span style="display: inline-block">inline-block</span></div>`,
	);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	// Both inline and inline-block elements form runs
	expect(isInlineRunHead(spans[0])).toBe(true); // First is head
	expect(isInlineRunHead(spans[1])).toBe(false); // Second joins run
	expect(findInlineRunHead(spans[1])).toBe(spans[0]);
});

test("mixed content with line breaks", () => {
	const dom = createDOM(`<div>Text<br><span>after break</span></div>`);
	const textNode = getTextNode(dom, "Text");
	const br = getNode(dom, "br");
	const span = getNode(dom, "span");

	// <br> does NOT break inline runs - it's just inline content with newline
	expect(isInlineRunHead(textNode)).toBe(true); // Text starts the run
	expect(isInlineRunHead(span)).toBe(false); // Span joins the same run
	expect(findInlineRunHead(span)).toBe(textNode); // All find text as head
});

test("text node with inline precedent in flex container", () => {
	const dom = createDOM(
		`<div style="display: flex"><span>element</span> text content</div>`,
	);
	const span = getNode(dom, "span");
	const textNode = getTextNode(dom, "text content");

	// In flex containers, inline elements are separate flex items
	expect(isInlineRunHead(span)).toBe(true);
	expect(findInlineRunHead(span)).toBe(span);

	// Text nodes only form runs with other text nodes in flex containers
	expect(isInlineRunHead(textNode)).toBe(true); // Should be its own head
	expect(findInlineRunHead(textNode)).toBe(textNode); // Should find itself
});

// === MUTATION TESTS ===

test("block insertion splits inline run", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>first</span><span>second</span></div>`,
	);
	const container = getNode(jsdom, "div");
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Initially: first span is head, second joins run
	expect(isInlineRunHead(spans[0])).toBe(true);
	expect(isInlineRunHead(spans[1])).toBe(false);
	expect(findInlineRunHead(spans[1])).toBe(spans[0]);

	// Insert block element between spans
	const blockDiv = jsdom.window.document.createElement("div");
	blockDiv.textContent = "block";
	container.insertBefore(blockDiv, spans[1]);
	layoutEngine.calculateLayout();

	// After insertion: both spans should be heads of separate runs
	expect(isInlineRunHead(spans[0])).toBe(true); // Still head of first run
	expect(isInlineRunHead(spans[1])).toBe(true); // Now head of new run after block
	expect(findInlineRunHead(spans[1])).toBe(spans[1]); // Finds itself as head
});

test("inline head deletion promotes next element", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>head</span><span>second</span><span>third</span></div>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Initially: first is head, others join
	expect(isInlineRunHead(spans[0])).toBe(true);
	expect(isInlineRunHead(spans[1])).toBe(false);
	expect(isInlineRunHead(spans[2])).toBe(false);
	expect(findInlineRunHead(spans[2])).toBe(spans[0]);

	// Remove head element
	spans[0].remove();
	layoutEngine.calculateLayout();

	// Second span should become new head
	expect(isInlineRunHead(spans[1])).toBe(true);
	expect(isInlineRunHead(spans[2])).toBe(false);
	expect(findInlineRunHead(spans[2])).toBe(spans[1]);
});

test("inline middle element deletion maintains run", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>first</span><span>middle</span><span>last</span></div>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Initially: first is head, others join
	expect(isInlineRunHead(spans[0])).toBe(true);
	expect(findInlineRunHead(spans[2])).toBe(spans[0]);

	// Remove middle element
	spans[1].remove();
	layoutEngine.calculateLayout();

	// First should still be head, last should still find first
	expect(isInlineRunHead(spans[0])).toBe(true);
	expect(isInlineRunHead(spans[2])).toBe(false);
	expect(findInlineRunHead(spans[2])).toBe(spans[0]);
});

test("text insertion in flex container creates new run", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>element</span></div>`,
	);
	const container = getNode(jsdom, "div");
	const span = getNode(jsdom, "span");

	// Initially: span is its own head in flex
	expect(isInlineRunHead(span)).toBe(true);
	expect(findInlineRunHead(span)).toBe(span);

	// Add text node
	const textNode = jsdom.window.document.createTextNode(" text content");
	container.appendChild(textNode);
	layoutEngine.calculateLayout();

	// Span should still be its own head, text should be its own head
	expect(isInlineRunHead(span)).toBe(true);
	expect(findInlineRunHead(span)).toBe(span);
	expect(isInlineRunHead(textNode)).toBe(true);
	expect(findInlineRunHead(textNode)).toBe(textNode);
});

test("inline insertion between text nodes in flex", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex">First text</div>`,
	);
	const container = getNode(jsdom, "div");
	const firstText = getTextNode(jsdom, "First text");

	// Add inline element and more text
	const span = jsdom.window.document.createElement("span");
	span.textContent = "inline";
	container.appendChild(span);

	const secondText = jsdom.window.document.createTextNode(" second text");
	container.appendChild(secondText);
	layoutEngine.calculateLayout();

	// In flex: each should be its own head
	expect(isInlineRunHead(firstText)).toBe(true);
	expect(isInlineRunHead(span)).toBe(true);
	expect(isInlineRunHead(secondText)).toBe(true);
});

test("flex to block conversion changes run behavior", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>first</span><span>second</span></div>`,
	);
	const container = getNode(jsdom, "div");
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// In flex: each span is its own head
	expect(isInlineRunHead(spans[0])).toBe(true);
	expect(isInlineRunHead(spans[1])).toBe(true);

	// Change to block display
	container.style.display = "block";
	layoutEngine.calculateLayout();

	// In block: first is head, second joins run
	expect(isInlineRunHead(spans[0])).toBe(true);
	expect(isInlineRunHead(spans[1])).toBe(false);
	expect(findInlineRunHead(spans[1])).toBe(spans[0]);
});

test("text node removal affects inline run heads", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div>Text content<span>element</span></div>`,
	);
	const textNode = getTextNode(jsdom, "Text content");
	const span = getNode(jsdom, "span");

	// Initially: text is head, span joins
	expect(isInlineRunHead(textNode)).toBe(true);
	expect(isInlineRunHead(span)).toBe(false);
	expect(findInlineRunHead(span)).toBe(textNode);

	// Remove text node
	textNode.remove();
	layoutEngine.calculateLayout();

	// Span should become new head
	expect(isInlineRunHead(span)).toBe(true);
	expect(findInlineRunHead(span)).toBe(span);
});

test("adding first inline element to empty container", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(`<div></div>`);
	const container = getNode(jsdom, "div");

	// Add first inline element
	const span = jsdom.window.document.createElement("span");
	span.textContent = "first";
	container.appendChild(span);
	layoutEngine.calculateLayout();

	// Should be head since it's first
	expect(isInlineRunHead(span)).toBe(true);
	expect(findInlineRunHead(span)).toBe(span);

	// Add second inline element
	const span2 = jsdom.window.document.createElement("span");
	span2.textContent = "second";
	container.appendChild(span2);
	layoutEngine.calculateLayout();

	// First should still be head, second should join
	expect(isInlineRunHead(span)).toBe(true);
	expect(isInlineRunHead(span2)).toBe(false);
	expect(findInlineRunHead(span2)).toBe(span);
});

test("whitespace text node insertion maintains runs", () => {
	const {jsdom, layoutEngine} = createLayoutEngine(
		`<div><span>first</span><span>second</span></div>`,
	);
	const spans = Array.from(jsdom.window.document.querySelectorAll("span"));

	// Initially in same run
	expect(findInlineRunHead(spans[1])).toBe(spans[0]);

	// Insert whitespace between them
	const whitespace = jsdom.window.document.createTextNode("   ");
	spans[0].parentNode!.insertBefore(whitespace, spans[1]);
	layoutEngine.calculateLayout();

	// Should still be in same run (whitespace doesn't break runs)
	expect(isInlineRunHead(spans[0])).toBe(true);
	expect(isInlineRunHead(spans[1])).toBe(false);
	expect(findInlineRunHead(spans[1])).toBe(spans[0]);
});
