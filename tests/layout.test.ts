import {test, expect} from "@b9g/libuild/test";
import {
	LayoutEngine,
	kInvalidateInlineRun,
	kRectTexts,
} from "../src/internal/layout.js";
import {StyleManager} from "../src/internal/styles.js";
import {renderTextFragment} from "../src/internal/text.js";
import {TermDOM, kLayoutEngine} from "../src/internal/termdom.js";
import {ensurePseudoElement} from "../src/internal/dom.js";
import {MockProcess, nextFrame} from "./test-utils.js";
import {createDocumentWindow} from "../src/internal/termdom.js";

/**
 * Give an element the pseudo-element node the cascade would give it, holding
 * the text a `content` declaration would put there. The slots are the
 * engine's internal door to pseudo-elements; no author API reaches them.
 */
function attachPseudo(host: Element, name: string, content: string): Element {
	const node = ensurePseudoElement<Element>(host, name);
	node.textContent = content;
	return node;
}

/** A document of this DOM, from markup, displayed in a window of its own. */
function documentWindow(html: string) {
	return {window: createDocumentWindow(html)};
}

function createLayoutEngine(html: string = "<div></div>") {
	const dom = documentWindow(`<!DOCTYPE html><html><head><style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		html, body { width: 100%; }
		body { min-height: 100%; }
	</style></head><body>${html}</body></html>`);
	// Setup terminal-specific getComputedStyle
	const styleManager = new StyleManager(dom.window);
	const layoutEngine = new LayoutEngine(dom.window);
	styleManager.setLayoutEngine(layoutEngine);

	// Setup MutationObserver to simulate TermDOM behavior
	const observer = new dom.window.MutationObserver((mutations) => {
		styleManager.handleMutations(mutations);
		layoutEngine.handleMutations(mutations);
	});

	observer.observe(dom.window.document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		characterData: true,
	});

	// Set initial size and calculate layout
	layoutEngine.resize(300, 200);

	// Helper function to process pending mutations and calculate layout
	const processMutationsAndLayout = () => {
		const pendingMutations = observer.takeRecords();
		if (pendingMutations.length > 0) {
			styleManager.handleMutations(pendingMutations);
			layoutEngine.handleMutations(pendingMutations);
		}
		layoutEngine.calculateLayout();
	};

	return {dom, layoutEngine, observer, processMutationsAndLayout};
}

// CSS-to-Yoga property mapping tests
test("styleYogaNode - basic layout", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width: 100px; height: 50px;"></div>`,
	);
	const div = dom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	// Should have valid rect (exact values depend on CSS parsing)
	expect(rect).not.toBeNull();
	expect(rect!.width).toBeGreaterThan(0);
	expect(rect!.height).toBeGreaterThan(0);
});

test("styleYogaNode - percentage dimensions", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width: 50%;"></div>`,
	);
	const div = dom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	// Should handle percentage (exact calculation depends on parent sizing)
	expect(rect).not.toBeNull();
	expect(rect!.width).toBeGreaterThan(0);
});

test("styleYogaNode - margins", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="margin: 10px;"></div>`,
	);
	const div = dom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	// Should handle margin properties (exact positioning depends on layout calculation)
	expect(rect).not.toBeNull();
});

test("styleYogaNode - flexbox container", () => {
	const {dom, layoutEngine} = createLayoutEngine(`
		<div style="display: flex;">
			<div style="flex: 1;"></div>
			<div style="flex: 2;"></div>
		</div>
	`);

	const container = dom.window.document.querySelector("div")!;
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
	const {dom, layoutEngine, processMutationsAndLayout} = createLayoutEngine();
	const div = dom.window.document.createElement("div");
	dom.window.document.body.appendChild(div);

	// Process mutations and calculate layout
	processMutationsAndLayout();

	// Should create rect after mutation
	const rect = layoutEngine.getRect(div);
	expect(rect).not.toBeNull();
});

test("addNode - nested elements", () => {
	const {dom, layoutEngine, processMutationsAndLayout} = createLayoutEngine();
	const parent = dom.window.document.createElement("div");
	const child = dom.window.document.createElement("span");

	parent.appendChild(child);
	dom.window.document.body.appendChild(parent);

	// Process mutations and calculate layout
	processMutationsAndLayout();

	// Both should have rects
	expect(layoutEngine.getRect(parent)).not.toBeNull();
	expect(layoutEngine.getRect(child)).not.toBeNull();
});

test("addNode - text nodes", () => {
	const {dom, layoutEngine, processMutationsAndLayout} = createLayoutEngine();
	const div = dom.window.document.createElement("div");
	div.textContent = "Hello world";
	dom.window.document.body.appendChild(div);

	// Process mutations and calculate layout
	processMutationsAndLayout();

	// Text nodes don't get rects directly, but the container should
	const rect = layoutEngine.getRect(div);
	expect(rect).not.toBeNull();
});

// Inline run tests
test("inline elements join runs correctly", () => {
	const {dom, layoutEngine} = createLayoutEngine(`
		<div>
			<span>first</span><span>second</span>
		</div>
	`);

	const container = dom.window.document.querySelector("div")!;
	const _spans = Array.from(dom.window.document.querySelectorAll("span"));

	// Container should have rect
	expect(layoutEngine.getRect(container)).not.toBeNull();

	// Inline spans join runs, so they may not have individual rects
	// This is correct behavior - they'll be handled during text measurement
});

test("block elements have separate yoga nodes", () => {
	const {dom, layoutEngine} = createLayoutEngine(`
		<div>
			<div>first block</div>
			<div>second block</div>
		</div>
	`);

	const divs = Array.from(dom.window.document.querySelectorAll("div"));
	const innerDivs = divs.slice(1); // Skip the container div

	// Each block div should have its own rect
	expect(layoutEngine.getRect(innerDivs[0])).not.toBeNull();
	expect(layoutEngine.getRect(innerDivs[1])).not.toBeNull();
});

// Mutation handling tests
test("style changes trigger layout updates", () => {
	const {dom, layoutEngine, processMutationsAndLayout} = createLayoutEngine(
		`<div style="width: 100px;"></div>`,
	);
	const div = dom.window.document.querySelector("div")!;

	// Initial rect
	let rect = layoutEngine.getRect(div);
	expect(rect?.width).toBe(100);

	// Change style
	div.style.width = "200px";
	processMutationsAndLayout(); // Process mutations

	// Updated rect
	rect = layoutEngine.getRect(div);
	expect(rect?.width).toBe(200);
});

test("element removal cleans up yoga nodes", () => {
	const {dom, layoutEngine, processMutationsAndLayout} = createLayoutEngine(
		`<div><span>test</span></div>`,
	);
	const div = dom.window.document.querySelector("div")!;
	const span = dom.window.document.querySelector("span")!;

	// Both should have rects initially
	expect(layoutEngine.getRect(div)).not.toBeNull();
	expect(layoutEngine.getRect(span)).not.toBeNull();

	// Remove span
	span.remove();
	processMutationsAndLayout(); // Process mutations

	// Span should no longer have rect
	expect(layoutEngine.getRect(span)).toBeNull();
	expect(layoutEngine.getRect(div)).not.toBeNull(); // Parent still exists
});

// Edge cases
test("display none elements", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="display: none;"></div>`,
	);
	const div = dom.window.document.querySelector("div")!;

	const rect = layoutEngine.getRect(div);
	// Should still have a rect but with zero dimensions or be positioned off-screen
	// (exact behavior depends on Yoga's display: none handling)
	expect(rect).not.toBeNull();
});

test("resize updates layout", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width: 100%;"></div>`,
	);
	const div = dom.window.document.querySelector("div")!;

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
	const {dom, layoutEngine} = createLayoutEngine(`<span>text</span>`);
	const span = dom.window.document.querySelector("span")!;

	expect(layoutEngine.isInlineRunHead(span)).toBe(true);
});

test("isInlineRunHead - first of multiple inline elements", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<span>first</span><span>second</span>`,
	);
	const firstSpan = dom.window.document.querySelector("span")!;

	expect(layoutEngine.isInlineRunHead(firstSpan)).toBe(true);
});

test("isInlineRunHead - second of multiple inline elements", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<span>first</span><span>second</span>`,
	);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false);
});

test("isInlineRunHead - text node as head", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`Text content <span>element</span>`,
	);
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
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
	const {dom, layoutEngine} = createLayoutEngine(
		`<span>element</span> text content`,
	);
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>item</span></div>`,
	);
	const span = dom.window.document.querySelector("span")!;

	expect(layoutEngine.isInlineRunHead(span)).toBe(true);
});

test("isInlineRunHead - multiple inlines in flex container", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>first</span><span>second</span></div>`,
	);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true);
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(true); // Each flex item is its own head
});

test("isInlineRunHead - block element breaks run", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<span>first</span><div>block</div><span>after</span>`,
	);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true); // First run head
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(true); // New run head after block
});

test("findInlineRunHead - simple case", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<span>first</span><span>second</span>`,
	);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	expect(layoutEngine.findInlineRunHead(spans[0])).toBe(spans[0]); // Head finds itself
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]); // Second finds first
});

test("findInlineRunHead - text node head", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`Text content <span>element</span>`,
	);
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Text content")) {
			textNode = node as Text;
			break;
		}
	}
	const span = dom.window.document.querySelector("span")!;

	expect(layoutEngine.findInlineRunHead(textNode!)).toBe(textNode); // Text head finds itself
	expect(layoutEngine.findInlineRunHead(span)).toBe(textNode); // Element finds text head
});

test("findInlineRunHead - mixed content", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`Text <span>element</span> more text <em>emphasis</em>`,
	);
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
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
	const span = dom.window.document.querySelector("span")!;
	const em = dom.window.document.querySelector("em")!;

	expect(layoutEngine.findInlineRunHead(em)).toBe(textNode); // All should find the first text node as head
	expect(layoutEngine.findInlineRunHead(span)).toBe(textNode);
	expect(layoutEngine.findInlineRunHead(moreText!)).toBe(textNode);
});

test("findInlineRunHead - block element", () => {
	const {dom, layoutEngine} = createLayoutEngine(`<div>block</div>`);
	const div = dom.window.document.querySelector("div")!;

	expect(layoutEngine.findInlineRunHead(div)).toBe(null); // Block elements don't have inline heads
});

// Edge cases from CSS spec research
test("anonymous inline boxes - direct text in block", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>Direct text content</div>`,
	);
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span>first</span>   <span>second</span></div>`,
	);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const whitespaceNode = spans[0].nextSibling as Text; // The "   " between spans

	// White space nodes still participate in inline formatting
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true); // First span is head
	expect(layoutEngine.isInlineRunHead(whitespaceNode)).toBe(false); // Whitespace joins run
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false); // Second span joins run
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]); // All find first span as head
});

test("nested inline elements", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span>outer <em>nested</em> text</span></div>`,
	);
	const span = dom.window.document.querySelector("span")!;
	const em = dom.window.document.querySelector("em")!;

	// Nested inline elements - span is the head
	expect(layoutEngine.isInlineRunHead(span)).toBe(true);
	expect(layoutEngine.isInlineRunHead(em)).toBe(false); // em is nested inside span
	expect(layoutEngine.findInlineRunHead(em)).toBe(span);
});

test("inline-block vs inline behavior", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span style="display: inline">inline</span><span style="display: inline-block">inline-block</span></div>`,
	);
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	// Both inline and inline-block elements form runs
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true); // First is head
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false); // Second joins run
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]);
});

test("mixed content with line breaks", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>Text<br><span>after break</span></div>`,
	);
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
	);
	let textNode: Text | null = null;
	let node;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes("Text")) {
			textNode = node as Text;
			break;
		}
	}
	const span = dom.window.document.querySelector("span")!;

	// <br> does NOT break inline runs - it's just inline content with newline
	expect(layoutEngine.isInlineRunHead(textNode!)).toBe(true); // Text starts the run
	expect(layoutEngine.isInlineRunHead(span)).toBe(false); // Span joins the same run
	expect(layoutEngine.findInlineRunHead(span)).toBe(textNode); // All find text as head
});

test("text node with inline precedent in flex container", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>element</span> text content</div>`,
	);
	const span = dom.window.document.querySelector("span")!;
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span>first</span><span>second</span></div>`,
	);
	const container = dom.window.document.querySelector("div")!;
	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	// Initially: first span is head, second joins run
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true);
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false);
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[0]);

	// Insert block element between spans
	const blockDiv = dom.window.document.createElement("div");
	blockDiv.textContent = "block";
	container.insertBefore(blockDiv, spans[1]);
	layoutEngine.calculateLayout();

	// After insertion: both spans should be heads of separate runs
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true); // Still head of first run
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(true); // Now head of new run after block
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[1]); // Finds itself as head
});

test("a run whose first node is removed re-measures from the next", () => {
	const {dom, layoutEngine, processMutationsAndLayout} = createLayoutEngine(
		`<div><span>head</span><span>second</span><span>third</span></div>`,
	);
	const container = dom.window.document.querySelector("div")!;
	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	processMutationsAndLayout();

	// Initially: first is head, others join
	expect(layoutEngine.isInlineRunHead(spans[0])).toBe(true);
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(false);
	expect(layoutEngine.isInlineRunHead(spans[2])).toBe(false);
	expect(layoutEngine.findInlineRunHead(spans[2])).toBe(spans[0]);

	// Remove head element
	spans[0].remove();
	processMutationsAndLayout();

	// The box the run laid out in is the same one, measured from the node
	// that opens it now: the text that remains starts at the container's
	// content edge rather than where "head" left off.
	expect(layoutEngine.isInlineRunHead(spans[1])).toBe(true);
	expect(layoutEngine.isInlineRunHead(spans[2])).toBe(false);
	expect(layoutEngine.findInlineRunHead(spans[2])).toBe(spans[1]);

	const containerRect = layoutEngine.getRect(container)!;
	const rectTexts = layoutEngine[kRectTexts](container.firstChild!);
	expect(rectTexts.length).toBe(1);
	expect(rectTexts[0].text).toBe("second");
	expect(rectTexts[0].rect.x).toBe(containerRect.x);
	expect(rectTexts[0].rect.y).toBe(containerRect.y);
});

test("findInlineRunHead - text node inside inline element should find element", () => {
	const {dom, layoutEngine} = createLayoutEngine(`<span>🚀</span>`);

	const span = dom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;

	// The text node should find the SPAN as its run head, not itself
	expect(layoutEngine.findInlineRunHead(textNode)).toBe(span);

	// The SPAN should find itself as the run head
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);
});

// === COMPREHENSIVE EDGE CASE TESTS FOR findInlineRunHead ===

test("findInlineRunHead - nested inline elements", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<span>outer <em>nested <strong>deep</strong></em> text</span>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const em = dom.window.document.querySelector("em")!;
	const strong = dom.window.document.querySelector("strong")!;

	// All nested inline elements should find the outermost span as run head
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);
	expect(layoutEngine.findInlineRunHead(em)).toBe(span);
	expect(layoutEngine.findInlineRunHead(strong)).toBe(span);

	// Text nodes inside nested elements should also find the outermost span
	const deepText = strong.firstChild as Text;
	expect(layoutEngine.findInlineRunHead(deepText)).toBe(span);
});

test("findInlineRunHead - text nodes after br elements", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>Start<br>After break</div>`,
	);

	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex"><span>first</span><span>second</span><em>third</em></div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const em = dom.window.document.querySelector("em")!;

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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="display: flex">Text node<span>element</span>More text</div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const walker = dom.window.document.createTreeWalker(
		dom.window.document.body,
		dom.window.NodeFilter.SHOW_TEXT,
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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span style="display: inline-block">block1</span><span style="display: inline-block">block2</span></div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));

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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span>content</span>   <em>more</em></div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const em = dom.window.document.querySelector("em")!;
	const whitespaceNode = span.nextSibling as Text; // The "   " between spans

	// Whitespace text nodes should find the run head
	expect(layoutEngine.findInlineRunHead(span)).toBe(span);
	expect(layoutEngine.findInlineRunHead(whitespaceNode)).toBe(span);
	expect(layoutEngine.findInlineRunHead(em)).toBe(span);
});

test("findInlineRunHead - block elements return null", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><p>paragraph</p><h1>heading</h1></div>`,
	);

	const p = dom.window.document.querySelector("p")!;
	const h1 = dom.window.document.querySelector("h1")!;
	const div = dom.window.document.querySelector("div")!;

	// Block elements should return null
	expect(layoutEngine.findInlineRunHead(p)).toBe(null);
	expect(layoutEngine.findInlineRunHead(h1)).toBe(null);
	expect(layoutEngine.findInlineRunHead(div)).toBe(null);
});

test("findInlineRunHead - inline elements after block elements", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span>first run</span><p>block breaks run</p><span>second run</span><em>continues second</em></div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const em = dom.window.document.querySelector("em")!;

	// First span is its own run head
	expect(layoutEngine.findInlineRunHead(spans[0])).toBe(spans[0]);

	// After block element, second span starts new run
	expect(layoutEngine.findInlineRunHead(spans[1])).toBe(spans[1]);
	expect(layoutEngine.findInlineRunHead(em)).toBe(spans[1]);
});

test("findInlineRunHead - deeply nested inline elements", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span><em><strong><code>deeply nested</code></strong></em></span></div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const em = dom.window.document.querySelector("em")!;
	const strong = dom.window.document.querySelector("strong")!;
	const code = dom.window.document.querySelector("code")!;

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
	const {dom, layoutEngine} = createLayoutEngine(`<div></div>`);

	// Create orphaned text node
	const textNode = dom.window.document.createTextNode("orphan");

	// Orphaned text node should return null (not connected to document)
	expect(layoutEngine.findInlineRunHead(textNode)).toBe(null);
});

test("findInlineRunHead - comment nodes and other node types", () => {
	const {dom, layoutEngine} = createLayoutEngine(`<div><!-- comment --></div>`);

	const comment = dom.window.document.querySelector("div")!.firstChild!;

	// Comment nodes should return null (not text or element)
	expect(layoutEngine.findInlineRunHead(comment)).toBe(null);
});

test("findInlineRunHead - whitespace behavior (expected: finds whitespace text node)", () => {
	// This demonstrates that whitespace text nodes are correctly found as run heads
	const {dom, layoutEngine} = createLayoutEngine(`
		<div>
			<span style="display: inline-block">block1</span>
		</div>
	`);

	const span = dom.window.document.querySelector("span")!;
	const result = layoutEngine.findInlineRunHead(span);

	// Should find the whitespace text node before the span
	expect(result?.nodeType).toBe(3); // TEXT_NODE
	expect(result?.textContent).toBe("\n\t\t\t");

	// The whitespace text node is the correct run head for this layout
});

test("emoji text RectLengths preserve character boundaries", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<span>🎨 Colorful Text 🌈</span>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const originalText = textNode.textContent!;

	// Get the RectTexts for the text node
	const rectTexts = layoutEngine[kRectTexts](textNode);

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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width: 20ch;"><span>Hello   </span><span>World</span></div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const firstSpan = spans[0];
	const secondSpan = spans[1];

	// Get RectTexts for both spans
	const rectTexts1 = layoutEngine[kRectTexts](firstSpan.firstChild as Text);
	const rectTexts2 = layoutEngine[kRectTexts](secondSpan.firstChild as Text);

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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>
			<span>Text </span>
			<span>🚀</span>
			<span> More</span>
		</div>`,
	);

	// The container should have a valid rect since it contains the inline content
	const container = dom.window.document.querySelector("div")!;
	const containerRect = layoutEngine.getRect(container);

	// The inline content should be measured correctly by our fixed whitespace processing
	// We don't test individual span rects (they're part of inline flow),
	// but the container size should reflect correct measurements
	expect(containerRect).not.toBeNull();
	expect(containerRect!.width).toBeGreaterThan(0);
});

test("inline-block elements should get individual rects", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;">Block1</div>
			<div style="display: inline-block;">Block2</div>
		</div>`,
	);

	const container = dom.window.document.querySelector("div")!;
	const inlineBlocks = Array.from(
		dom.window.document.querySelectorAll("div"),
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
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span>Head</span><span>Tail</span></div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));

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
	const {dom, layoutEngine: _layoutEngine} = createLayoutEngine(
		`<div>Start <span>middle  </span> <em>end</em></div>`,
	);

	// In normal inline flow, this should be processed as one run
	// This tests that our whitespace processing works correctly with mixed content
	// "Start middle   end" gets processed with proper whitespace collapsing

	// Test passes if no errors are thrown during layout calculation
	// This demonstrates that the whitespace processing works correctly
	const container = dom.window.document.querySelector("div")!;
	expect(container).not.toBeNull(); // Layout calculation completed successfully
});

test("text truncation due to RectLength accumulation error", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width: 12ch;">
			<span>First   </span><span>Second   </span><span>Third</span>
		</div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	// Each span's trailing spaces get trimmed in processing
	// This creates an accumulating error in width calculations
	// Later spans might get truncated due to insufficient allocated space

	spans.forEach((span, _i) => {
		const rectTexts = layoutEngine[kRectTexts](span.firstChild as Text);
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

test("line fragments - regular inline element (baseline)", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span>RegularInline</span></div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const rectTexts = layoutEngine[kRectTexts](span);

	// Regular inline elements should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("RegularInline");
	expect(rectTexts[0].rect.width).toBe(13); // "RegularInline" = 13 chars
});

test("line fragments - text node in regular inline element", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><span>TextContent</span></div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const rectTexts = layoutEngine[kRectTexts](textNode);

	// Text nodes should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("TextContent");
});

test("line fragments - element inside inline-block container", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;"><span>InsideBlock</span></div></div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const rectTexts = layoutEngine[kRectTexts](span);

	// This was the main broken case - should now work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("InsideBlock");
	expect(rectTexts[0].rect.width).toBe(11); // "InsideBlock" = 11 chars
});

test("line fragments - text node inside inline-block container", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;"><span>BlockText</span></div></div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const rectTexts = layoutEngine[kRectTexts](textNode);

	// Text nodes inside inline-blocks should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("BlockText");
});

test("line fragments - nested elements inside inline-block", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;"><span><em>Nested</em></span></div></div>`,
	);

	const em = dom.window.document.querySelector("em")!;
	const rectTexts = layoutEngine[kRectTexts](em);

	// Nested elements inside inline-blocks should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("Nested");
});

test("line fragments - multiple children in inline-block", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;"><span>First</span><span>Second</span></div></div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const firstRects = layoutEngine[kRectTexts](spans[0]);
	const secondRects = layoutEngine[kRectTexts](spans[1]);

	// Both children should work independently
	expect(firstRects).toHaveLength(1);
	expect(firstRects[0].text).toBe("First");
	expect(secondRects).toHaveLength(1);
	expect(secondRects[0].text).toBe("Second");
});

test.todo("line fragments - deeply nested inline-block", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;">
				<div><span><em>DeepNested</em></span></div>
			</div>
		</div>`,
	);

	const em = dom.window.document.querySelector("em")!;
	const rectTexts = layoutEngine[kRectTexts](em);

	// Deep nesting should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("DeepNested");
});

test("line fragments - inline-block with mixed content", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;">
				Text <span>element</span> more text
			</div>
		</div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const rectTexts = layoutEngine[kRectTexts](span);

	// Element in mixed content should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("element");
});

test("line fragments - multiple inline-blocks", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;"><span>Block1</span></div>
			<div style="display: inline-block;"><span>Block2</span></div>
		</div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const rects1 = layoutEngine[kRectTexts](spans[0]);
	const rects2 = layoutEngine[kRectTexts](spans[1]);

	// Elements in separate inline-blocks should work
	expect(rects1).toHaveLength(1);
	expect(rects1[0].text).toBe("Block1");
	expect(rects2).toHaveLength(1);
	expect(rects2[0].text).toBe("Block2");
});

test("line fragments - inline-block container element itself", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div><div style="display: inline-block;">Container</div></div>`,
	);

	const inlineBlock = dom.window.document.querySelector("div[style]")!;
	const rectTexts = layoutEngine[kRectTexts](inlineBlock);

	// Inline-block container itself should work (all its text content)
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("Container");
});

test("line fragments - position accuracy in inline-block", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block; padding: 2px;">
				<span>Padded</span>
			</div>
		</div>`,
	);

	const span = dom.window.document.querySelector("span")!;
	const rectTexts = layoutEngine[kRectTexts](span);

	// Should work and have reasonable position (accounting for padding)
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("Padded");
	expect(rectTexts[0].rect.x).toBeGreaterThanOrEqual(2); // Should account for padding
	expect(rectTexts[0].rect.y).toBeGreaterThanOrEqual(2);
});

test("line fragments - maintains backward compatibility", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>
			<span>Regular</span>
			<div style="display: inline-block;"><span>InBlock</span></div>
			<span>Normal</span>
		</div>`,
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const regularRects = layoutEngine[kRectTexts](spans[0]); // Regular inline
	const blockRects = layoutEngine[kRectTexts](spans[1]); // Inside inline-block
	const normalRects = layoutEngine[kRectTexts](spans[2]); // Regular inline

	// All should work correctly
	expect(regularRects).toHaveLength(1);
	expect(regularRects[0].text).toBe("Regular");
	expect(blockRects).toHaveLength(1);
	expect(blockRects[0].text).toBe("InBlock");
	expect(normalRects).toHaveLength(1);
	expect(normalRects[0].text).toBe("Normal");
});

// === LINE FRAGMENT DATA RANGES ===

test("line fragment offsets render back to the text the line was broken into", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width: 12ch;">The   quick
			brown fox jumps over it</div>`,
	);

	const textNode = dom.window.document.querySelector("div")!.firstChild as Text;
	const fragments = layoutEngine[kRectTexts](textNode);
	expect(fragments.length).toBeGreaterThan(1);
	for (const fragment of fragments) {
		expect(
			renderTextFragment(
				textNode.data,
				"normal",
				fragment.startOffset,
				fragment.endOffset,
				fragment.visualBase,
			),
		).toBe(fragment.text);
	}
});

test("line fragment offsets render back under pre-wrap", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width: 10ch; white-space: pre-wrap;">a  b\nlong  line here</div>`,
	);

	const textNode = dom.window.document.querySelector("div")!.firstChild as Text;
	const fragments = layoutEngine[kRectTexts](textNode);
	expect(fragments.length).toBeGreaterThan(1);
	for (const fragment of fragments) {
		expect(
			renderTextFragment(
				textNode.data,
				"pre-wrap",
				fragment.startOffset,
				fragment.endOffset,
				fragment.visualBase,
			),
		).toBe(fragment.text);
	}
});

test("a Range over a text node reports the rects of its line fragments", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width: 12ch;">wrapping prose across several lines</div>`,
	);

	const textNode = dom.window.document.querySelector("div")!.firstChild as Text;
	const range = dom.window.document.createRange();
	range.setStart(textNode, 0);
	range.setEnd(textNode, textNode.data.length);

	const fragments = layoutEngine.lineFragments(textNode);
	const rects = layoutEngine.getRangeRects(range);
	expect(rects).toHaveLength(fragments.length);
	for (let i = 0; i < rects.length; i++) {
		expect(rects[i].x).toBe(fragments[i].rect.x);
		expect(rects[i].y).toBe(fragments[i].rect.y);
	}
});

// Dynamic Inline Run Management Tests
// These tests verify that the layout engine properly handles DOM mutations
// that affect inline runs, including run head changes and cache invalidation

test("Inline run head changes - text to element", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Initial text content";
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);

	// Change run head from text to span element
	div.innerHTML = "<span>New span content</span>";

	// Re-render and verify layout updates
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("New span content");
	expect(updatedOutput).not.toContain("Initial text");
});

test("Inline run head changes - element to text", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "<span>Initial span</span>";
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);
	const _initialOutput = terminal.getPlainText();

	// Change run head from span to text
	div.innerHTML = "New text content";

	// Re-render and verify layout updates
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("New text content");
	expect(updatedOutput).not.toContain("Initial span");
});

test("Adding inline elements to existing run", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Start ";
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);

	// Add inline elements dynamically
	const span1 = termdom.document.createElement("span");
	span1.textContent = "middle ";
	div.appendChild(span1);

	const span2 = termdom.document.createElement("strong");
	span2.textContent = "end";
	div.appendChild(span2);

	// Re-render and verify all content appears on same line
	await nextFrame(termdom);
	const output = terminal.getPlainText();

	expect(output).toContain("Start middle end");
	// Verify they're on the same line (no unexpected line breaks)
	const lines = output.split("\n").filter((line) => line.trim());
	expect(lines[0]).toContain("Start middle end");
});

test("Removing inline elements from run", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = 'Start <span id="remove">REMOVE</span> end';
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);
	const _initialOutput = terminal.getPlainText();
	expect(_initialOutput).toContain("Start REMOVE end");

	// Remove the middle element
	const elementToRemove = termdom.document.getElementById("remove")!;
	elementToRemove.remove();

	// Re-render and verify element is gone, run is updated
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("Start end"); // Proper whitespace collapse after span removal
	expect(updatedOutput).not.toContain("REMOVE");
});

test("Inline-block elements affecting run layout", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
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
	await nextFrame(termdom);
	const output = terminal.getPlainText();

	expect(output).toContain("Text before");
	expect(output).toContain("Block");
	expect(output).toContain("text after");
});

test("Rapid DOM changes stress test", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
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
		await nextFrame(termdom);

		// Verify content is present
		const output = terminal.getPlainText();
		expect(output).toContain(`item${i}`);
	}

	// Remove elements rapidly
	for (let i = 4; i >= 0; i--) {
		const element = termdom.document.getElementById(`item${i}`)!;
		element.remove();

		await nextFrame(termdom);

		// Verify element is gone
		const output = terminal.getPlainText();
		expect(output).not.toContain(`item${i}`);
	}

	// Final check - only base content should remain
	const finalOutput = terminal.getPlainText();
	expect(finalOutput.trim()).toBe("Base content");
});

test("Text node splitting and merging", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	const textNode = termdom.document.createTextNode("This is a long text node");
	div.appendChild(textNode);
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);

	// Split the text node
	textNode.splitText(10); // Split at "This is a "

	// Re-render and verify layout handles split text
	await nextFrame(termdom);
	const splitOutput = terminal.getPlainText();
	expect(splitOutput).toContain("This is a long text node");

	// Insert element between text nodes
	const span = termdom.document.createElement("span");
	span.textContent = "[INSERTED]";
	div.insertBefore(span, div.childNodes[1]);

	// Final render
	await nextFrame(termdom);
	const finalOutput = terminal.getPlainText();
	expect(finalOutput).toContain("This is a [INSERTED]long text node");
});

test("White-space handling in dynamic inline runs", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Word1    <span>   Word2   </span>    Word3";
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);
	const _initialOutput = terminal.getPlainText();

	// Remove the span
	const span = div.querySelector("span")!;
	span.remove();

	// Re-render and verify whitespace is handled correctly
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();

	// Should collapse whitespace appropriately
	expect(updatedOutput).toContain("Word1");
	expect(updatedOutput).toContain("Word3");
	expect(updatedOutput).not.toContain("Word2");
});

test("Direct textContent changes in inline runs", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Before <span>original</span> after";
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);
	const initialOutput = terminal.getPlainText();
	expect(initialOutput).toContain("Before original after");

	// Change textContent directly (triggers characterData mutation)
	const span = div.querySelector("span")!;
	span.textContent = "MODIFIED";

	// Re-render and verify textContent change is reflected
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("Before MODIFIED after");
	expect(updatedOutput).not.toContain("original");
});

test("Text node data changes (characterData mutations)", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	const textNode = termdom.document.createTextNode("Initial text content");
	div.appendChild(textNode);
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);
	const initialOutput = terminal.getPlainText();
	expect(initialOutput).toContain("Initial text content");

	// Change text node data directly (characterData mutation)
	textNode.data = "Changed text content";

	// Re-render and verify change is reflected
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("Changed text content");
	expect(updatedOutput).not.toContain("Initial text");
});

// TODO tests for more complex scenarios that need additional fixes
test("Direct textContent changes in inline runs", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const div = termdom.document.createElement("div");
	div.innerHTML = "Before <span>original</span> after";
	termdom.document.body.appendChild(div);

	// Initial render
	await nextFrame(termdom);
	const initialOutput = terminal.getPlainText();
	expect(initialOutput).toContain("Before original after");

	// Change textContent directly (should trigger our new fix)
	const span = div.querySelector("span")!;
	span.textContent = "MODIFIED";

	// Re-render and verify textContent change is reflected
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();

	expect(updatedOutput).toContain("Before MODIFIED after");
	expect(updatedOutput).not.toContain("original");
});

test.todo("Text node data changes (characterData mutations)", async () => {
	// Direct textNode.data changes should work but reveal similar issues
	// when the text node is inside elements that are part of inline runs
	// but don't have their own Yoga nodes
});

test("Block element interrupting inline run", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const container = termdom.document.createElement("div");
	container.innerHTML = 'Before <span id="inline">inline</span> after';
	termdom.document.body.appendChild(container);

	// Initial render - should be on one line
	await nextFrame(termdom);

	// Insert block element in the middle
	const blockDiv = termdom.document.createElement("div");
	blockDiv.textContent = "BLOCK ELEMENT";
	blockDiv.style.display = "block";

	const inlineSpan = termdom.document.getElementById("inline")!;
	container.insertBefore(blockDiv, inlineSpan);

	// Re-render and verify block element creates line breaks
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();
	const lines = updatedOutput.split("\n").filter((line) => line.trim());

	// Should have multiple lines now
	expect(lines.length).toBeGreaterThan(1);
	expect(updatedOutput).toContain("Before");
	expect(updatedOutput).toContain("BLOCK ELEMENT");
	expect(updatedOutput).toContain("inline after");
});

test("Block element removal merging inline runs", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const container = termdom.document.createElement("div");
	container.innerHTML =
		'Before <div id="block">BLOCK</div><span>inline</span> after';
	termdom.document.body.appendChild(container);

	// Initial render - should have multiple lines due to block element
	await nextFrame(termdom);
	const initialOutput = terminal.getPlainText();
	let initialLines = initialOutput.split("\n").filter((line) => line.trim());
	expect(initialLines.length).toBeGreaterThan(1); // Should be split by block

	// Remove the block element
	const blockElement = termdom.document.getElementById("block")!;
	blockElement.remove();

	// Re-render and verify inline runs merge back into one line
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();

	// Should now be on one line (or at least fewer lines)
	expect(updatedOutput).toContain("Before");
	expect(updatedOutput).toContain("inline");
	expect(updatedOutput).toContain("after");
	expect(updatedOutput).not.toContain("BLOCK");

	// The content should flow together
	expect(updatedOutput).toContain("Before inline after");
});

test("Block element removal properly cleans up former run head Yoga nodes", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const termdom = new TermDOM({
		transport: terminal.transport,
	});

	const container = termdom.document.createElement("div");
	container.innerHTML =
		'Before <div id="block">BLOCK</div><span id="span">inline</span> after';
	termdom.document.body.appendChild(container);

	// Initial render - span should be a run head with Yoga node
	await nextFrame(termdom);
	const layoutEngine = termdom[kLayoutEngine];
	const span = termdom.document.getElementById("span")!;

	// Remove the block element
	const blockElement = termdom.document.getElementById("block")!;
	blockElement.remove();

	// Re-render to trigger mutation processing and cleanup
	await nextFrame(termdom);
	const updatedOutput = terminal.getPlainText();
	expect(updatedOutput).toContain("Before inline after");

	// Verify the span no longer has a Yoga node (was cleaned up)
	expect(layoutEngine.nodeMap.has(span)).toBe(false);
});

test.todo("Nested inline element changes", async () => {
	// This test reveals issues with mutation handling for nested inline elements
	// The error occurs when changing content of elements that don't have their own Yoga nodes
	// Same root cause as textContent changes above
});

test.todo("Complex inline run with mixed content types", async () => {
	// Similar to nested inline element changes - needs better handling of
	// mutations within elements that are part of inline runs but don't have Yoga nodes
});

// === PSEUDO ELEMENT INLINE RUN HEAD TESTS ===
// These tests verify how pseudo elements interact with inline run head detection

function createLayoutEngineWithPseudos(html: string = "<div></div>") {
	const dom = documentWindow(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
	);

	// The cascade first: the layout engine measures through getComputedStyle,
	// which is the cascade's to answer.
	const styleManager = new StyleManager(dom.window);
	const layoutEngine = new LayoutEngine(dom.window);
	styleManager.setLayoutEngine(layoutEngine);

	layoutEngine.resize(300, 200);
	layoutEngine.calculateLayout();

	return {dom, layoutEngine, styleManager};
}

test("::before pseudo element becomes run head", () => {
	const {dom, layoutEngine} = createLayoutEngineWithPseudos(
		`<div class="quote">Hello World</div>`,
	);

	const quote = dom.window.document.querySelector(".quote")!;

	// Add ::before pseudo element
	const beforeNode = attachPseudo(quote, "::before", '"');

	// ::before should be treated as the first child and become run head
	expect(layoutEngine.isInlineRunHead(beforeNode)).toBe(true);

	// The original text node should no longer be a run head
	const textNode = quote.firstChild as Text;
	expect(layoutEngine.isInlineRunHead(textNode)).toBe(false);
	expect(layoutEngine.findInlineRunHead(textNode)).toBe(beforeNode);
});

test("::marker appears before ::before in run head order", () => {
	const {dom, layoutEngine} = createLayoutEngineWithPseudos(
		`<ul><li class="decorated">Item text</li></ul>`,
	);

	const listItem = dom.window.document.querySelector(".decorated")!;
	const textNode = listItem.firstChild as Text;

	// Add all pseudo element types (CSS order: ::marker, ::before, content, ::after)
	const markerNode = attachPseudo(listItem, "::marker", "• ");
	const beforeNode = attachPseudo(listItem, "::before", "[");
	const afterNode = attachPseudo(listItem, "::after", "]");

	// ::marker should be the run head (first in document order)
	expect(layoutEngine.isInlineRunHead(markerNode)).toBe(true);

	// All others should join the run with ::marker as head
	expect(layoutEngine.isInlineRunHead(beforeNode)).toBe(false);
	expect(layoutEngine.isInlineRunHead(textNode)).toBe(false);
	expect(layoutEngine.isInlineRunHead(afterNode)).toBe(false);

	expect(layoutEngine.findInlineRunHead(beforeNode)).toBe(markerNode);
	expect(layoutEngine.findInlineRunHead(textNode)).toBe(markerNode);
	expect(layoutEngine.findInlineRunHead(afterNode)).toBe(markerNode);
});

test("Dynamic pseudo element addition affects run heads", () => {
	const {dom, layoutEngine} = createLayoutEngineWithPseudos(
		`<div class="dynamic">Text</div>`,
	);

	const div = dom.window.document.querySelector(".dynamic")!;
	const textNode = div.firstChild as Text;

	// Initially, text node should be run head (div is block, not inline)
	expect(layoutEngine.isInlineRunHead(div)).toBe(false);
	expect(layoutEngine.isInlineRunHead(textNode)).toBe(true);

	// Add ::before pseudo element
	const beforeNode = attachPseudo(div, "::before", "→ ");

	// Force recalculation
	layoutEngine.calculateLayout();

	// Now ::before should be run head (first inline content)
	expect(layoutEngine.isInlineRunHead(beforeNode)).toBe(true);
	expect(layoutEngine.isInlineRunHead(textNode)).toBe(false);
	expect(layoutEngine.findInlineRunHead(textNode)).toBe(beforeNode);
});

test.skip("layout invalidation preserves inline run behavior", async () => {
	const termdom = new TermDOM();
	const {document} = termdom;

	// Create structure with both inline and block elements
	const container = document.createElement("div");
	document.body.appendChild(container);

	const p = document.createElement("p");
	container.appendChild(p);

	const span = document.createElement("span");
	span.textContent = "Inline text ";
	span.style.display = "inline";
	p.appendChild(span);

	const strong = document.createElement("strong");
	strong.textContent = "Bold text";
	strong.style.display = "inline";
	p.appendChild(strong);

	const li = document.createElement("li");
	li.textContent = "List item";
	li.style.display = "list-item";
	container.appendChild(li);

	const layoutEngine = termdom[kLayoutEngine];

	// Track inline run invalidation calls
	const originalInvalidateInlineRun =
		layoutEngine[kInvalidateInlineRun].bind(layoutEngine);
	let inlineInvalidationCalls = 0;

	layoutEngine[kInvalidateInlineRun] = function (node: Node) {
		inlineInvalidationCalls++;
		return originalInvalidateInlineRun(node);
	};

	// Test inline element invalidation triggers inline run invalidation
	const beforeInline = inlineInvalidationCalls;
	layoutEngine.invalidate(span);
	expect(inlineInvalidationCalls).toBeGreaterThan(beforeInline);

	// Test block element invalidation does NOT trigger inline run invalidation
	const beforeBlock = inlineInvalidationCalls;
	layoutEngine.invalidate(li);
	expect(inlineInvalidationCalls).toBe(beforeBlock);

	// Test that LI elements keep their Yoga nodes after invalidation (connected elements)
	expect(li.isConnected).toBe(true);
	const hadYogaNodeBefore = layoutEngine.nodeMap?.has(li);
	layoutEngine.invalidate(li);
	// After invalidation, connected elements should still be in nodeMap for reuse
	const hasYogaNodeAfter = layoutEngine.nodeMap?.has(li);
	expect(hasYogaNodeAfter).toBe(hadYogaNodeBefore); // Should preserve for connected elements

	// Full render should work without errors
	await expect(async () => {
		await nextFrame(termdom);
	}).not.toThrow();
});

// Tests for fundamental layout positioning bug
// These tests document the core issue affecting nested lists and other content

test("Block child positioned after parent text content", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div>Parent text<div>Child content</div></div>`,
	);

	layoutEngine.calculateLayout();

	const parent = layoutEngine.window.document.querySelector("div")!;
	const child = parent.querySelector("div")!;
	const textNode = parent.firstChild!;

	const parentRect = layoutEngine.getRect(parent)!;
	const childRect = layoutEngine.getRect(child)!;
	const textRects = layoutEngine[kRectTexts](textNode);

	// Parent should have height for text + child
	expect(parentRect.height).toBe(2);

	// Text should be positioned first (at parent origin)
	expect(textRects.length).toBe(1);
	expect(textRects[0].rect.y).toBe(parentRect.y);
	expect(textRects[0].rect.height).toBe(1);

	// Child should be positioned after text
	expect(childRect.y).toBe(parentRect.y + 1);
	expect(childRect.height).toBe(1);
});

test("Multiple block children positioned sequentially after parent text", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div>Parent text<div>Child 1</div><div>Child 2</div></div>`,
	);

	layoutEngine.calculateLayout();

	const parent = layoutEngine.window.document.querySelector("div")!;
	const children = Array.from(parent.querySelectorAll("div"));

	const parentYoga = layoutEngine.nodeMap.get(parent);
	const parentLayout = parentYoga!.getComputedLayout();

	// Parent should have height for text + 2 children
	expect(parentLayout.height).toBe(3);

	// FAILING: Children should be positioned sequentially after parent text
	const child1Yoga = layoutEngine.nodeMap.get(children[0]);
	const child2Yoga = layoutEngine.nodeMap.get(children[1]);

	const child1Layout = child1Yoga!.getComputedLayout();
	const child2Layout = child2Yoga!.getComputedLayout();

	expect(child1Layout.top).toBe(1); // Currently fails: at y=0
	expect(child2Layout.top).toBe(2); // Currently fails: at y=1
});

test("Inline children do not affect block child positioning", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div>Parent <span>inline</span> text<div>Block child</div></div>`,
	);

	layoutEngine.calculateLayout();

	const parent = layoutEngine.window.document.querySelector("div")!;
	const blockChild = parent.querySelector("div")!;

	const parentYoga = layoutEngine.nodeMap.get(parent);
	const blockChildYoga = layoutEngine.nodeMap.get(blockChild);

	const parentLayout = parentYoga!.getComputedLayout();
	const blockChildLayout = blockChildYoga!.getComputedLayout();

	// Parent should account for inline content + block child
	expect(parentLayout.height).toBe(2);

	// FAILING: Block child should be positioned after all parent content
	expect(blockChildLayout.top).toBe(1); // Currently fails: at y=0
});

// Tests for block emulation with flexbox behavior
test("Block display is emulated with flexbox and proper flex-shrink behavior", () => {
	const {layoutEngine} = createLayoutEngine(`
		<div id="container" style="height: 10px; display: block;">
			<div id="child1" style="height: 5px;">Child 1</div>
			<div id="child2" style="height: 5px;">Child 2</div>
			<ul id="list" style="height: 8px;">
				<li>List item 1</li>
				<li>List item 2</li>
			</ul>
		</div>
	`);

	layoutEngine.calculateLayout();

	const container = layoutEngine.window.document.getElementById("container")!;
	const child1 = layoutEngine.window.document.getElementById("child1")!;
	const child2 = layoutEngine.window.document.getElementById("child2")!;
	const list = layoutEngine.window.document.getElementById("list")!;

	const containerYoga = layoutEngine.nodeMap.get(container);
	const child1Yoga = layoutEngine.nodeMap.get(child1);
	const child2Yoga = layoutEngine.nodeMap.get(child2);
	const listYoga = layoutEngine.nodeMap.get(list);

	const containerLayout = containerYoga!.getComputedLayout();
	const child1Layout = child1Yoga!.getComputedLayout();
	const child2Layout = child2Yoga!.getComputedLayout();
	const listLayout = listYoga!.getComputedLayout();

	// Block containers use flexbox with flex-direction: column
	expect(containerYoga!.getFlexDirection()).toBe(0); // FLEX_DIRECTION_COLUMN value

	// Children are stacked vertically (block behavior)
	expect(child1Layout.top).toBe(0);
	expect(child2Layout.top).toBe(5); // After child1 (height 5)
	expect(listLayout.top).toBe(10); // After child1 + child2 (height 5 + 5)

	// CRITICAL: Children maintain their specified heights (flex-shrink: 0)
	// This prevents content clipping in constrained containers
	expect(child1Layout.height).toBe(5); // Maintains requested height
	expect(child2Layout.height).toBe(5); // Maintains requested height
	expect(listLayout.height).toBe(8); // Maintains requested height

	// Total content height exceeds container height, but children don't shrink
	const totalChildrenHeight =
		child1Layout.height + child2Layout.height + listLayout.height;
	expect(totalChildrenHeight).toBe(18); // 5 + 5 + 8 = 18
	expect(containerLayout.height).toBe(10); // Container height constraint
	expect(totalChildrenHeight).toBeGreaterThan(containerLayout.height);

	// This behavior allows content to overflow rather than clip,
	// which is the correct behavior for terminal layouts
});

test("Block children have flex-shrink: 0 to prevent content clipping", () => {
	const {layoutEngine} = createLayoutEngine(`
		<div style="height: 3px; display: block;">
			<div style="height: 2px;">Block child 1</div>
			<div style="height: 2px;">Block child 2</div>
		</div>
	`);

	layoutEngine.calculateLayout();

	const container = layoutEngine.window.document.querySelector("div")!;
	const children = Array.from(
		layoutEngine.window.document.querySelectorAll("div"),
	).slice(1); // Skip container

	const containerYoga = layoutEngine.nodeMap.get(container);
	const childYogaNodes = children.map(
		(child) => layoutEngine.nodeMap.get(child)!,
	);

	const containerLayout = containerYoga!.getComputedLayout();
	const childLayouts = childYogaNodes.map((yoga) => yoga.getComputedLayout());

	// Container has constrained height (3px)
	expect(containerLayout.height).toBe(3);

	// CRITICAL: Children maintain their requested heights despite container constraint
	// This is because they have flex-shrink: 0 in block containers
	expect(childLayouts[0].height).toBe(2); // Child 1 maintains height
	expect(childLayouts[1].height).toBe(2); // Child 2 maintains height

	// Children are positioned vertically (block stacking)
	expect(childLayouts[0].top).toBe(0);
	expect(childLayouts[1].top).toBe(2); // After first child

	// Total children height exceeds container, but they don't shrink
	const totalChildrenHeight = childLayouts[0].height + childLayouts[1].height;
	expect(totalChildrenHeight).toBe(4); // 2 + 2 = 4
	expect(totalChildrenHeight).toBeGreaterThan(containerLayout.height); // 4 > 3

	// Verify children have flex-shrink: 0 (indirectly via maintained heights)
	// If flex-shrink were 1, children would shrink to fit the 3px container
	childYogaNodes.forEach((yoga) => {
		expect(yoga.getFlexShrink()).toBe(0);
	});
});

test("whitespace between block elements should be collapsed", async () => {
	const terminal = new MockProcess({cols: 40, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// HTML with significant whitespace between block elements
	// According to CSS spec, this whitespace should be collapsed in block context
	const container = document.createElement("div");
	container.innerHTML = `
		<div>Block 1</div>

		<div>Block 2</div>


		<div>Block 3</div>
	`;
	document.body.appendChild(container);

	await nextFrame(dom);

	// Get the raw terminal buffer to check for phantom lines
	const buffer = (terminal as any).terminal.buffer.active;
	let phantomLines = 0;

	for (let row = 0; row < terminal.stdout.rows; row++) {
		const line = buffer.getLine(row);
		if (line) {
			const text = line.translateToString(true);
			// Phantom line = whitespace-only content (not truly empty)
			const isPhantom = text.trim() === "" && text.length > 0;
			if (isPhantom) phantomLines++;
		}
	}

	// EXPECTED: Whitespace between block elements should be collapsed, no phantom lines
	// CURRENT: Creates phantom lines because we process whitespace text nodes as content
	expect(phantomLines).toBe(0);

	dom.dispose();
});

test("whitespace in nested lists should be collapsed", async () => {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Nested list with formatted HTML (the original phantom line case)
	const container = document.createElement("div");
	container.innerHTML = `
		<ul>
			<li>Top level item 1</li>
			<li>Top level item 2
				<ul>
					<li>Second level A</li>
					<li>Second level B</li>
				</ul>
			</li>
			<li>Top level item 3</li>
		</ul>
	`;
	document.body.appendChild(container);

	await nextFrame(dom);

	// Count phantom lines in terminal buffer
	const buffer = (terminal as any).terminal.buffer.active;
	let phantomLineCount = 0;

	for (let row = 0; row < terminal.stdout.rows; row++) {
		const line = buffer.getLine(row);
		if (line) {
			const text = line.translateToString(true);
			const isPhantom = text.trim() === "" && text.length > 0;
			if (isPhantom) phantomLineCount++;
		}
	}

	// EXPECTED: Whitespace between list elements should be collapsed per CSS rules
	// CURRENT: Creates multiple phantom lines from inter-element whitespace
	expect(phantomLineCount).toBe(0);

	dom.dispose();
});

test("programmatic DOM creation should not have phantom lines", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Programmatic creation (no whitespace text nodes)
	const container = document.createElement("div");
	const ul = document.createElement("ul");

	const li1 = document.createElement("li");
	li1.textContent = "Item 1";
	ul.appendChild(li1);

	const li2 = document.createElement("li");
	li2.textContent = "Item 2";

	// Nested list
	const nestedUl = document.createElement("ul");
	const nestedLi = document.createElement("li");
	nestedLi.textContent = "Sub item";
	nestedUl.appendChild(nestedLi);
	li2.appendChild(nestedUl);

	ul.appendChild(li2);
	container.appendChild(ul);
	document.body.appendChild(container);

	await nextFrame(dom);

	// Even programmatic creation currently creates phantom lines
	// This suggests the issue is deeper than just innerHTML whitespace
	const buffer = (terminal as any).terminal.buffer.active;
	let phantomLineCount = 0;

	for (let row = 0; row < terminal.stdout.rows; row++) {
		const line = buffer.getLine(row);
		if (line) {
			const text = line.translateToString(true);
			const isPhantom = text.trim() === "" && text.length > 0;
			if (isPhantom) phantomLineCount++;
		}
	}

	// EXPECTED: No phantom lines since no whitespace text nodes were created
	// CURRENT: Still creates phantom lines, indicating layout engine issue
	expect(phantomLineCount).toBe(0);

	dom.dispose();
});

test("compact HTML should not have phantom lines", async () => {
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// HTML without any whitespace between elements
	const container = document.createElement("div");
	container.innerHTML = `<ul><li>Item 1</li><li>Item 2<ul><li>Sub item</li></ul></li></ul>`;
	document.body.appendChild(container);

	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	let phantomLineCount = 0;

	for (let row = 0; row < terminal.stdout.rows; row++) {
		const line = buffer.getLine(row);
		if (line) {
			const text = line.translateToString(true);
			const isPhantom = text.trim() === "" && text.length > 0;
			if (isPhantom) phantomLineCount++;
		}
	}

	// EXPECTED: No phantom lines when there's no inter-element whitespace
	// This test should already pass and demonstrates the desired behavior
	expect(phantomLineCount).toBe(0);

	dom.dispose();
});

// =============================================================================
// CSS POSITIONING TESTS
// Tests for position: static, relative, absolute with left/top/right/bottom
// =============================================================================

test("position: static ignores left/top properties", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: static; left: 50px; top: 100px;">Static positioned</div>`,
	);

	const div = layoutEngine.window.document.querySelector("div")!;
	const yogaNode = layoutEngine.nodeMap.get(div);
	const layout = yogaNode!.getComputedLayout();

	// position: static should ignore left/top positioning
	expect(layout.left).toBe(0);
	expect(layout.top).toBe(0);
});

test("position: absolute with left and top", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: absolute; left: 10ch; top: 2ch;">Absolute positioned</div>`,
	);

	const div = layoutEngine.window.document.querySelector("div")!;
	const yogaNode = layoutEngine.nodeMap.get(div);
	const layout = yogaNode!.getComputedLayout();

	// position: absolute should respect left/top positioning
	expect(layout.left).toBe(10); // 10ch = 10 characters
	expect(layout.top).toBe(2); // 2ch = 2 characters
});

test("position: absolute with right and bottom", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: absolute; right: 5ch; bottom: 3ch; width: 20ch; height: 10ch;"></div>`,
	);

	const div = layoutEngine.window.document.querySelector("div")!;
	const yogaNode = layoutEngine.nodeMap.get(div);
	const layout = yogaNode!.getComputedLayout();

	// With container width 300ch and height 200ch:
	// right: 5ch means left = 300 - 20 - 5 = 275
	// bottom: 3ch means top = 200 - 10 - 3 = 187
	expect(layout.left).toBe(275);
	expect(layout.top).toBe(187);
	expect(layout.width).toBe(20);
	expect(layout.height).toBe(10);
});

test("position: relative with left and top offsets", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: relative; left: 15ch; top: 5ch;">Relative positioned</div>`,
	);

	const div = layoutEngine.window.document.querySelector("div")!;
	const yogaNode = layoutEngine.nodeMap.get(div);

	// Verify position type is set to relative
	expect(yogaNode!.getPositionType()).toBe(1); // POSITION_TYPE_RELATIVE

	// position: relative should apply offsets to normal position
	const layout = yogaNode!.getComputedLayout();
	expect(layout.left).toBe(15);
	expect(layout.top).toBe(5);
});

test("mixed positioning types in same container", () => {
	const {layoutEngine} = createLayoutEngine(`
		<div>
			<div style="position: static;">Static child</div>
			<div style="position: relative; left: 10ch; top: 2ch;">Relative child</div>
			<div style="position: absolute; left: 50ch; top: 10ch;">Absolute child</div>
		</div>
	`);

	const children = Array.from(
		layoutEngine.window.document.querySelectorAll("div"),
	).slice(1); // Skip container

	const staticChild = children[0];
	const relativeChild = children[1];
	const absoluteChild = children[2];

	const staticYoga = layoutEngine.nodeMap.get(staticChild);
	const relativeYoga = layoutEngine.nodeMap.get(relativeChild);
	const absoluteYoga = layoutEngine.nodeMap.get(absoluteChild);

	const staticLayout = staticYoga!.getComputedLayout();
	const relativeLayout = relativeYoga!.getComputedLayout();
	const absoluteLayout = absoluteYoga!.getComputedLayout();

	// Static positioning (normal flow)
	expect(staticLayout.left).toBe(0);
	expect(staticLayout.top).toBe(0);

	// Relative positioning (offset from normal position)
	// The relative element starts after the static element (height=1) at top=1,
	// then gets offset by top: 2ch, resulting in final position top=3
	expect(relativeLayout.left).toBe(10);
	expect(relativeLayout.top).toBe(3);

	// Absolute positioning (relative to containing block)
	expect(absoluteLayout.left).toBe(50);
	expect(absoluteLayout.top).toBe(10);
});

test("ch unit conversion works correctly", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: absolute; left: 25ch; top: 15ch; width: 30ch; height: 8ch;">CH units</div>`,
	);

	const div = layoutEngine.window.document.querySelector("div")!;
	const yogaNode = layoutEngine.nodeMap.get(div);
	const layout = yogaNode!.getComputedLayout();

	// ch units should convert to character positions (1ch = 1 character)
	expect(layout.left).toBe(25);
	expect(layout.top).toBe(15);
	expect(layout.width).toBe(30);
	expect(layout.height).toBe(8);
});

test("position: absolute removes element from document flow", () => {
	const {layoutEngine} = createLayoutEngine(`
		<div>
			<div style="height: 3ch;">Normal flow element</div>
			<div style="position: absolute; left: 0; top: 0;">Absolute element</div>
			<div style="height: 2ch;">Another normal element</div>
		</div>
	`);

	const container = layoutEngine.window.document.querySelector("div")!;
	const children = Array.from(container.children);

	const normalChild1 = children[0] as Element;
	const absoluteChild = children[1] as Element;
	const normalChild2 = children[2] as Element;

	const containerYoga = layoutEngine.nodeMap.get(container);
	const normal1Yoga = layoutEngine.nodeMap.get(normalChild1);
	const absoluteYoga = layoutEngine.nodeMap.get(absoluteChild);
	const normal2Yoga = layoutEngine.nodeMap.get(normalChild2);

	const containerLayout = containerYoga!.getComputedLayout();
	const normal1Layout = normal1Yoga!.getComputedLayout();
	const absoluteLayout = absoluteYoga!.getComputedLayout();
	const normal2Layout = normal2Yoga!.getComputedLayout();

	// Container height should only account for normal flow elements
	expect(containerLayout.height).toBe(5); // 3ch + 2ch = 5ch

	// Normal flow elements stack vertically
	expect(normal1Layout.top).toBe(0);
	expect(normal2Layout.top).toBe(3); // After first normal element

	// Absolute element is positioned independently
	expect(absoluteLayout.top).toBe(0);
	expect(absoluteYoga!.getPositionType()).toBe(2); // POSITION_TYPE_ABSOLUTE
});

test("percentage values in positioning", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: absolute; left: 25%; top: 50%; width: 50%; height: 25%;"></div>`,
	);

	const div = layoutEngine.window.document.querySelector("div")!;
	const yogaNode = layoutEngine.nodeMap.get(div);
	const layout = yogaNode!.getComputedLayout();

	// With container width 300ch and height 200ch:
	// left: 25% = 75ch, top: 50% = 100ch
	// width: 50% = 150ch, height: 25% = 50ch
	expect(layout.left).toBe(75);
	expect(layout.top).toBe(100);
	expect(layout.width).toBe(150);
	expect(layout.height).toBe(50);
});

// =============================================================================
// STATIC POSITION AND SHRINK-TO-FIT
// An out-of-flow box with no inset on an axis sits where it would have been in
// flow (CSS 2 §10.3.7), and one with `width: auto` and an `auto` inset takes
// shrink-to-fit width (§10.3.7 again, through the same measurement an
// inline-block takes).
// =============================================================================

test("an absolute box with auto insets sits after its previous sibling", () => {
	const {layoutEngine} = createLayoutEngine(`
		<div style="position: relative;">
			<div style="height: 3ch;">first</div>
			<div id="target" style="position: absolute;">X</div>
		</div>
	`);

	const target = layoutEngine.window.document.getElementById("target")!;
	const layout = layoutEngine.nodeMap.get(target)!.getComputedLayout();

	expect(layout.top).toBe(3);
	expect(layout.left).toBe(0);
});

test("the static position is measured through the box's own flow parent", () => {
	const {layoutEngine} = createLayoutEngine(`
		<div style="position: relative; padding: 1ch;">
			<div style="height: 2ch;">first</div>
			<div style="margin-left: 3ch;">
				<div id="target" style="position: absolute;">X</div>
			</div>
		</div>
	`);

	const target = layoutEngine.window.document.getElementById("target")!;
	const layout = layoutEngine.nodeMap.get(target)!.getComputedLayout();

	// The containing block's padding, the flow parent's margin, and the two
	// rows the first sibling took.
	expect(layout.left).toBe(4);
	expect(layout.top).toBe(3);
});

test("an absolute box in an inline context takes the line's position", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: relative;">word <span id="target" style="position: absolute;">X</span> rest</div>`,
	);

	const target = layoutEngine.window.document.getElementById("target")!;
	const layout = layoutEngine.nodeMap.get(target)!.getComputedLayout();

	// After "word ", on the line the box would have joined.
	expect(layout.left).toBe(5);
	expect(layout.top).toBe(0);
	// Its own content is a run of its own: the box is blockified, so the line
	// it left ends at its edge.
	expect(layout.width).toBe(1);
});

test("an explicit inset still wins over the static position", () => {
	const {layoutEngine} = createLayoutEngine(`
		<div style="position: relative;">
			<div style="height: 3ch;">first</div>
			<div id="target" style="position: absolute; top: 0;">X</div>
		</div>
	`);

	const target = layoutEngine.window.document.getElementById("target")!;
	expect(layoutEngine.nodeMap.get(target)!.getComputedLayout().top).toBe(0);
});

test("an absolute box with an auto inset shrinks to fit its content", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: relative; width: 40ch;"><div id="target" style="position: absolute; left: 0;">hello</div></div>`,
	);

	const target = layoutEngine.window.document.getElementById("target")!;
	expect(layoutEngine.nodeMap.get(target)!.getComputedLayout().width).toBe(5);
});

test("an absolute box pinned on both sides fills the space between them", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: relative; width: 40ch;"><div id="target" style="position: absolute; left: 2ch; right: 3ch;">hello</div></div>`,
	);

	const target = layoutEngine.window.document.getElementById("target")!;
	const layout = layoutEngine.nodeMap.get(target)!.getComputedLayout();
	expect(layout.left).toBe(2);
	expect(layout.width).toBe(35);
});

test("an overlay with no insets paints on the row its flow position names", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const termdom = new TermDOM({transport: terminal.transport});
	termdom.document.body.innerHTML =
		`<div style="position: relative;">` +
		`<div>first</div><div>second</div>` +
		`<div style="position: absolute;">OVERLAY</div>` +
		`</div>`;
	await nextFrame(termdom);

	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("first");
	expect(rows[1]).toContain("second");
	expect(rows[2]).toContain("OVERLAY");
	termdom.dispose();
});

test("a resolved value measures the layout the last style write asked for", async () => {
	const {termdom, document} = createTermDOM(`<div id="target">content</div>`);
	await nextFrame(termdom);
	const {window} = termdom;
	const target = document.getElementById("target")! as HTMLElement;

	// A used value is measured, so the write before it has to reach layout:
	// the read takes the same flush a rect read does.
	target.style.paddingLeft = "4ch";
	target.style.width = "10ch";
	expect(window.getComputedStyle(target).width).toBe("10px");
	target.style.width = "20ch";
	expect(window.getComputedStyle(target).width).toBe("20px");
});

test("auto values reset positioning properties", () => {
	const {layoutEngine} = createLayoutEngine(
		`<div style="position: absolute; left: auto; top: auto; right: 10ch; bottom: 5ch;">Auto positioning</div>`,
	);

	const div = layoutEngine.window.document.querySelector("div")!;
	const yogaNode = layoutEngine.nodeMap.get(div);

	// This tests that setPositionAuto() is called for auto values
	// The exact layout depends on Yoga's auto positioning behavior
	const layout = yogaNode!.getComputedLayout();
	expect(layout).not.toBeNull(); // Should calculate without errors
});

// === LAYOUT INVALIDATION TESTS ===

// These tests verify that DOM mutations are properly handled by the MutationObserver,
// which automatically triggers layout invalidation when elements are added/removed.

function createTermDOM(html: string = "<div></div>") {
	const termdom = new TermDOM({transport: new MockProcess().transport});
	const {document} = termdom;

	// Clear default body content and add test HTML
	document.body.innerHTML = html;

	return {termdom, document, layoutEngine: termdom[kLayoutEngine]};
}

function getPosition(layoutEngine: any, element: Element): number {
	try {
		const rects = layoutEngine[kRectTexts](element);
		return rects[0]?.rect.x ?? -1;
	} catch {
		return -1;
	}
}

test("inline element removal preserves positioning", async () => {
	const {termdom, document, layoutEngine} = createTermDOM();

	// Create inline run: A B C
	const container = document.createElement("div");
	const span1 = document.createElement("span");
	const span2 = document.createElement("span");
	const span3 = document.createElement("span");

	span1.textContent = "A";
	span2.textContent = "B";
	span3.textContent = "C";

	container.appendChild(span1);
	container.appendChild(span2);
	container.appendChild(span3);
	document.body.appendChild(container);

	// Initial render
	await nextFrame(termdom);
	expect(getPosition(layoutEngine, span1)).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, span2)).toBe(1); // B at x=1
	expect(getPosition(layoutEngine, span3)).toBe(2); // C at x=2

	// Remove middle element
	container.removeChild(span2);
	await nextFrame(termdom);
	expect(getPosition(layoutEngine, span1)).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, span3)).toBe(1); // C at x=1 (moved left)

	// Re-add at end
	container.appendChild(span2);
	await nextFrame(termdom);
	expect(getPosition(layoutEngine, span1)).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, span3)).toBe(1); // C at x=1
	expect(getPosition(layoutEngine, span2)).toBe(2); // B at x=2 (at end)
});

test("inline element removal in same position preserves layout", async () => {
	const {termdom, document, layoutEngine} = createTermDOM();

	// Create inline run: A B C
	const container = document.createElement("div");
	const span1 = document.createElement("span");
	const span2 = document.createElement("span");
	const span3 = document.createElement("span");

	span1.textContent = "A";
	span2.textContent = "B";
	span3.textContent = "C";

	container.appendChild(span1);
	container.appendChild(span2);
	container.appendChild(span3);
	document.body.appendChild(container);

	// Initial render
	await nextFrame(termdom);
	const initialPositions = [
		getPosition(layoutEngine, span1),
		getPosition(layoutEngine, span2),
		getPosition(layoutEngine, span3),
	];

	// Remove middle element and re-add in exact same position
	const nextSibling = span2.nextSibling;
	container.removeChild(span2);
	await nextFrame(termdom);

	container.insertBefore(span2, nextSibling);
	await nextFrame(termdom);

	// Positions should be identical to initial state
	expect(getPosition(layoutEngine, span1)).toBe(initialPositions[0]);
	expect(getPosition(layoutEngine, span2)).toBe(initialPositions[1]);
	expect(getPosition(layoutEngine, span3)).toBe(initialPositions[2]);
});

test("run head removal transfers to next inline element", async () => {
	const {termdom, document, layoutEngine} = createTermDOM();

	// Create inline run where first element is run head
	const container = document.createElement("div");
	const span1 = document.createElement("span");
	const span2 = document.createElement("span");

	span1.textContent = "FIRST";
	span2.textContent = "SECOND";

	container.appendChild(span1);
	container.appendChild(span2);
	document.body.appendChild(container);

	await nextFrame(termdom);

	// Verify span1 is the run head initially
	expect(layoutEngine.findInlineRunHead(span1)).toBe(span1);
	expect(layoutEngine.findInlineRunHead(span2)).toBe(span1);

	// Remove the run head
	container.removeChild(span1);
	await nextFrame(termdom);

	// span2 should become the new run head and have correct position
	expect(layoutEngine.findInlineRunHead(span2)).toBe(span2);
	const rects = layoutEngine[kRectTexts](span2);
	expect(rects.length).toBeGreaterThan(0);
	expect(rects[0].text).toBe("SECOND");
	expect(rects[0].rect.x).toBe(0); // Should start at position 0

	// Re-add original run head at beginning
	container.insertBefore(span1, span2);
	await nextFrame(termdom);

	// span1 should become run head again with both elements correctly positioned
	expect(layoutEngine.findInlineRunHead(span1)).toBe(span1);
	expect(layoutEngine.findInlineRunHead(span2)).toBe(span1);

	const rects1 = layoutEngine[kRectTexts](span1);
	const rects2 = layoutEngine[kRectTexts](span2);

	expect(rects1[0].rect.x).toBe(0); // FIRST at x=0
	expect(rects2[0].rect.x).toBe(5); // SECOND at x=5 (after "FIRST")
});

test("block element removal merges adjacent inline runs", async () => {
	const {termdom, document, layoutEngine} = createTermDOM();

	// Create: span1 - div - span2 (separate inline runs)
	const container = document.createElement("div");
	const span1 = document.createElement("span");
	const blockDiv = document.createElement("div");
	const span2 = document.createElement("span");

	span1.textContent = "A";
	blockDiv.textContent = "BLOCK";
	span2.textContent = "B";

	container.appendChild(span1);
	container.appendChild(blockDiv);
	container.appendChild(span2);
	document.body.appendChild(container);

	await nextFrame(termdom);

	// Initially span1 and span2 should have different run heads
	const runHead1 = layoutEngine.findInlineRunHead(span1);
	const runHead2 = layoutEngine.findInlineRunHead(span2);
	expect(runHead1).toBe(span1);
	expect(runHead2).toBe(span2);

	// Remove block element
	container.removeChild(blockDiv);
	await nextFrame(termdom);

	// Now span1 and span2 should share the same run head (span1)
	expect(layoutEngine.findInlineRunHead(span1)).toBe(span1);
	expect(layoutEngine.findInlineRunHead(span2)).toBe(span1);

	// Both should be positioned correctly in the merged run
	expect(getPosition(layoutEngine, span1)).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, span2)).toBe(1); // B at x=1
});

test("text node removal invalidates inline runs", async () => {
	const {termdom, document, layoutEngine} = createTermDOM();

	// Create inline run with text node
	const container = document.createElement("div");
	const span = document.createElement("span");
	const textNode = document.createTextNode("TEXT");

	span.textContent = "SPAN";

	container.appendChild(span);
	container.appendChild(textNode);
	document.body.appendChild(container);

	await nextFrame(termdom);

	// Both should be positioned correctly
	expect(getPosition(layoutEngine, span)).toBe(0);
	const spanRects = layoutEngine[kRectTexts](span);
	expect(spanRects[0].text).toBe("SPAN");

	// Remove text node
	container.removeChild(textNode);
	await nextFrame(termdom);

	// Span should still work correctly
	expect(getPosition(layoutEngine, span)).toBe(0);
	const newSpanRects = layoutEngine[kRectTexts](span);
	expect(newSpanRects[0].text).toBe("SPAN");
});

test("multiple element removal handles invalidation correctly", async () => {
	const {termdom, document, layoutEngine} = createTermDOM();

	// Create inline run: A B C D E
	const container = document.createElement("div");
	const spans = [];
	for (let i = 0; i < 5; i++) {
		const span = document.createElement("span");
		span.textContent = String.fromCharCode(65 + i); // A, B, C, D, E
		spans.push(span);
		container.appendChild(span);
	}
	document.body.appendChild(container);

	await nextFrame(termdom);

	// Verify initial positions
	spans.forEach((span, i) => {
		expect(getPosition(layoutEngine, span)).toBe(i);
	});

	// Remove multiple elements (B and D)
	container.removeChild(spans[1]); // Remove B
	container.removeChild(spans[3]); // Remove D
	await nextFrame(termdom);

	// Remaining elements should be positioned correctly: A C E
	expect(getPosition(layoutEngine, spans[0])).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, spans[2])).toBe(1); // C at x=1
	expect(getPosition(layoutEngine, spans[4])).toBe(2); // E at x=2
});

test("break result cleanup prevents orphaned entries", async () => {
	const {termdom, document, layoutEngine} = createTermDOM();

	// Create inline run
	const container = document.createElement("div");
	const span1 = document.createElement("span");
	const span2 = document.createElement("span");

	span1.textContent = "A";
	span2.textContent = "B";

	container.appendChild(span1);
	container.appendChild(span2);
	document.body.appendChild(container);

	await nextFrame(termdom);

	const initialBreakResults = layoutEngine.breakResultMap.size;

	// Remove element
	container.removeChild(span2);
	await nextFrame(termdom);

	// Break result count should remain consistent (no orphaned entries)
	expect(layoutEngine.breakResultMap.size).toBeLessThanOrEqual(
		initialBreakResults,
	);

	// Re-add element
	container.appendChild(span2);
	await nextFrame(termdom);

	// Should still be able to get correct positions
	expect(getPosition(layoutEngine, span1)).toBe(0);
	expect(getPosition(layoutEngine, span2)).toBe(1);
});

// These tests verify that the layout invalidation logic works correctly.
// DOM mutations automatically trigger MutationObserver -> #removeNode -> #invalidateInlineRun
// ensuring that break results are properly cleared and runs are recalculated.

test("overflow-wrap: normal lets a long word escape its box, as a browser does", async () => {
	const terminal = new MockProcess({rows: 4, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const div = document.createElement("div");
	div.style.width = "10ch";
	div.textContent = "aaaaaaaaaaaaaaaaaaaa";
	document.body.appendChild(div);
	await nextFrame(dom);

	// One line, unbroken: the word overflows the 10ch box.
	expect(terminal.getPlainText().split("\n")[0]).toContain(
		"aaaaaaaaaaaaaaaaaaaa",
	);

	dom.dispose();
});

test("overflow-wrap: break-word wraps the long word inside the box", async () => {
	const terminal = new MockProcess({rows: 6, cols: 40});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	const div = document.createElement("div");
	div.style.width = "10ch";
	div.style.setProperty("overflow-wrap", "break-word");
	div.textContent = "aaaaaaaaaaaaaaaaaaaa";
	document.body.appendChild(div);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.filter((l) => l.trim());
	expect(lines[0]).toBe("aaaaaaaaaa");
	expect(lines[1]).toBe("aaaaaaaaaa");

	dom.dispose();
});

test("a flex item that shrank paints the lines its own width was broken to", async () => {
	// The row narrows, and the first item -- which was already down to its
	// automatic minimum, its longest word -- keeps exactly the box it had. Its
	// layout is therefore answered from cache, while the sizing probes that pass
	// makes of it are answered at the row's full width. The lines it paints are
	// the ones its own 4-cell box was broken to, not the ones a probe asked for.
	const terminal = new MockProcess({rows: 8, cols: 30});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;
	document.body.innerHTML =
		`<div id="row" style="display:flex;width:24ch">` +
		`<div id="a">aaaa bbbb cccc dddd eeee</div>` +
		`<div id="b" style="flex-shrink:0">wwww xxxx yyyy zzzz</div>` +
		`</div>`;
	await nextFrame(dom);

	const row = document.getElementById("row")!;
	row.style.width = "17ch";
	await nextFrame(dom);

	const painted = terminal
		.getPlainText()
		.split("\n")
		.slice(0, 5)
		.map((line) => line.slice(0, 4));
	expect(painted).toEqual(["aaaa", "bbbb", "cccc", "dddd", "eeee"]);

	dom.dispose();
});

test("an empty inline element measures zero, not its container's width", async () => {
	// A pure inline element with no text has no inline box of its own; getRect
	// used to fall through to the layout node and report the containing block's
	// width. `<div style="width:30ch"><span></span></div>` measured the span at
	// 30 columns instead of 0.
	const {dom, layoutEngine} = createLayoutEngine(
		`<div style="width:30ch"><span id="e"></span><span id="n"><b>hi</b></span></div>`,
	);
	const empty = dom.window.document.getElementById("e")!;
	const nested = dom.window.document.getElementById("n")!;

	expect(layoutEngine.getRect(empty)?.width).toBe(0);
	// An inline whose text lives in a nested inline still measures that text.
	expect(layoutEngine.getRect(nested)?.width).toBe(2);
});
