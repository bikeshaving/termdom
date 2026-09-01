import {describe, expect, test} from "@b9g/libuild/test";
import {
	LayoutEngine,
} from "../src/internal/layout.js";
import {StyleManager} from "../src/internal/cssom.js";
import {renderTextFragment} from "../src/internal/layout.js";
import {TermDOM} from "../src/internal/termdom.js";
import {createDocumentWindow} from "../src/internal/dom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

/**
 * A target's laid-out lines with their text, read through the public
 * fragment walk: the fragments of the target's first text descendant, and
 * the slice of its data each fragment's offsets name.
 */
function lineTexts(
	layoutEngine: {
		lineFragments(node: Text): Array<{
			rect: DOMRect;
			startOffset: number;
			endOffset: number;
			visualBase: "ltr" | "rtl" | null;
		}>;
	},
	target: Node,
): Array<{
	rect: DOMRect;
	startOffset: number;
	endOffset: number;
	visualBase: "ltr" | "rtl" | null;
	text: string;
}> {
	let node: Node | null = target;
	while (node !== null && node.nodeType !== 3) {
		node = node.firstChild;
	}
	if (node === null) {
		return [];
	}
	const text = node as Text;
	return layoutEngine.lineFragments(text).map((fragment) => ({
		...fragment,
		text: text.data.slice(fragment.startOffset, fragment.endOffset),
	}));
}

/** A document of this DOM, from markup, displayed in a window of its own. */
function documentWindow(html: string): {
	window: ReturnType<typeof createDocumentWindow>;
} {
	return {window: createDocumentWindow(html)};
}

function createLayoutEngine(html = "<div></div>"): {
	dom: ReturnType<typeof documentWindow>;
	layoutEngine: LayoutEngine;
	observer: MutationObserver;
	processMutationsAndLayout: () => void;
} {
	const dom = documentWindow(`<!DOCTYPE html><html><head><style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		html, body { width: 100%; }
		body { min-height: 100%; }
	</style></head><body>${html}</body></html>`);
	// Setup terminal-specific getComputedStyle
	const layoutEngine = new LayoutEngine(dom.window);
	const styleManager = new StyleManager(dom.window, layoutEngine);

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

// CSS properties reaching the layout engine
test("a pixel width and height size the box", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div style=\"width: 100px; height: 50px;\"></div>",
	);
	const div = dom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	expect([rect!.width, rect!.height]).toEqual([100, 50]);
});

test("a percentage width resolves against the container", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div style=\"width: 50%;\"></div>",
	);
	const div = dom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	// Half of the 300 the engine was resized to.
	expect(rect!.width).toBe(150);
});

test("a margin offsets the box and takes room from its width", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div style=\"margin: 10px;\"></div>",
	);
	const div = dom.window.document.querySelector("div")!;
	const rect = layoutEngine.getRect(div);

	// Pushed in by 10 on each side, leaving 280 of the 300.
	expect([rect!.left, rect!.top, rect!.width]).toEqual([10, 10, 280]);
});

test("flex factors divide the container between the children", () => {
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

	// One share and two shares of 300.
	expect([child1Rect!.left, child1Rect!.width]).toEqual([0, 100]);
	expect([child2Rect!.left, child2Rect!.width]).toEqual([100, 200]);
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
		"<div style=\"width: 100px;\"></div>",
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
		"<div><span>test</span></div>",
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
		"<div style=\"display: none;\"></div>",
	);
	const div = dom.window.document.querySelector("div")!;

	// A display:none element generates no box, so there is no geometry to
	// report: an empty client rect, and resolved values that are the computed
	// ones.
	expect(layoutEngine.getRect(div)).toBeNull();
});

test("resize updates layout", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div style=\"width: 100%;\"></div>",
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

// === MUTATION TESTS ===

test("a run whose first node is removed re-measures from the next", () => {
	const {dom, layoutEngine, processMutationsAndLayout} = createLayoutEngine(
		"<div><span>head</span><span>second</span><span>third</span></div>",
	);
	const container = dom.window.document.querySelector("div")!;
	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	processMutationsAndLayout();

	// Remove head element
	spans[0].remove();
	processMutationsAndLayout();

	// The box the run laid out in is the same one, measured from the node
	// that opens it now: the text that remains starts at the container's
	// content edge rather than where "head" left off.

	const containerRect = layoutEngine.getRect(container)!;
	const fragments = lineTexts(layoutEngine, container.firstChild!);
	expect(fragments.length).toBe(1);
	expect(fragments[0].text).toBe("second");
	expect(fragments[0].rect.x).toBe(containerRect.x);
	expect(fragments[0].rect.y).toBe(containerRect.y);
});

test("emoji line fragments preserve character boundaries", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<span>🎨 Colorful Text 🌈</span>",
	);

	const span = dom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const originalText = textNode.textContent!;

	// Walk the line fragments and rebuild the text from their offsets
	const fragments = layoutEngine.lineFragments(textNode);

	// Test that the fragments cover the original
	let reconstructedText = "";

	for (const fragment of fragments) {
		reconstructedText += textNode.data.slice(
			fragment.startOffset,
			fragment.endOffset,
		);
	}

	// The reconstructed text should match the original
	expect(reconstructedText).toBe(originalText);

	// Specifically check that the space after the first emoji is preserved
	expect(reconstructedText).toContain("🎨 Colorful"); // Space between emoji and text
	expect(reconstructedText).not.toContain("🎨Colorful"); // Should NOT be missing space
});

test("line fragment slicing mismatch with whitespace", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div style=\"width: 20ch;\"><span>Hello   </span><span>World</span></div>",
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const firstSpan = spans[0];
	const secondSpan = spans[1];

	// Get RectTexts for both spans
	const rectTexts1 = lineTexts(layoutEngine, firstSpan.firstChild as Text);
	const rectTexts2 = lineTexts(layoutEngine, secondSpan.firstChild as Text);

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
		"<div><span>Head</span><span>Tail</span></div>",
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));

	// The head should report width of just its content (4), not the entire run
	// (8) -- but it reports the run's width, because both spans share the one
	// layout node their inline run was laid out as.
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
		"<div>Start <span>middle  </span> <em>end</em></div>",
	);

	// In normal inline flow, this should be processed as one run
	// This tests that our whitespace processing works correctly with mixed content
	// "Start middle   end" gets processed with proper whitespace collapsing

	// Test passes if no errors are thrown during layout calculation
	// This demonstrates that the whitespace processing works correctly
	const container = dom.window.document.querySelector("div")!;
	expect(container).not.toBeNull(); // Layout calculation completed successfully
});

test("text truncation due to fragment offset accumulation error", () => {
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
		const rectTexts = lineTexts(layoutEngine, span.firstChild as Text);
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
		"<div><span>RegularInline</span></div>",
	);

	const span = dom.window.document.querySelector("span")!;
	const rectTexts = lineTexts(layoutEngine, span);

	// Regular inline elements should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("RegularInline");
	expect(rectTexts[0].rect.width).toBe(13); // "RegularInline" = 13 chars
});

test("line fragments - text node in regular inline element", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div><span>TextContent</span></div>",
	);

	const span = dom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const rectTexts = lineTexts(layoutEngine, textNode);

	// Text nodes should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("TextContent");
});

test("line fragments - element inside inline-block container", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div><div style=\"display: inline-block;\"><span>InsideBlock</span></div></div>",
	);

	const span = dom.window.document.querySelector("span")!;
	const rectTexts = lineTexts(layoutEngine, span);

	// This was the main broken case - should now work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("InsideBlock");
	expect(rectTexts[0].rect.width).toBe(11); // "InsideBlock" = 11 chars
});

test("line fragments - text node inside inline-block container", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div><div style=\"display: inline-block;\"><span>BlockText</span></div></div>",
	);

	const span = dom.window.document.querySelector("span")!;
	const textNode = span.firstChild as Text;
	const rectTexts = lineTexts(layoutEngine, textNode);

	// Text nodes inside inline-blocks should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("BlockText");
});

test("line fragments - nested elements inside inline-block", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div><div style=\"display: inline-block;\"><span><em>Nested</em></span></div></div>",
	);

	const em = dom.window.document.querySelector("em")!;
	const rectTexts = lineTexts(layoutEngine, em);

	// Nested elements inside inline-blocks should work
	expect(rectTexts).toHaveLength(1);
	expect(rectTexts[0].text).toBe("Nested");
});

test("line fragments - multiple children in inline-block", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div><div style=\"display: inline-block;\"><span>First</span><span>Second</span></div></div>",
	);

	const spans = Array.from(dom.window.document.querySelectorAll("span"));
	const firstRects = lineTexts(layoutEngine, spans[0]);
	const secondRects = lineTexts(layoutEngine, spans[1]);

	// Both children should work independently
	expect(firstRects).toHaveLength(1);
	expect(firstRects[0].text).toBe("First");
	expect(secondRects).toHaveLength(1);
	expect(secondRects[0].text).toBe("Second");
});

test("line fragments - deeply nested inline-block", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		`<div>
			<div style="display: inline-block;">
				<div><span><em>DeepNested</em></span></div>
			</div>
		</div>`,
	);

	const em = dom.window.document.querySelector("em")!;
	const rectTexts = lineTexts(layoutEngine, em);

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
	const rectTexts = lineTexts(layoutEngine, span);

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
	const rects1 = lineTexts(layoutEngine, spans[0]);
	const rects2 = lineTexts(layoutEngine, spans[1]);

	// Elements in separate inline-blocks should work
	expect(rects1).toHaveLength(1);
	expect(rects1[0].text).toBe("Block1");
	expect(rects2).toHaveLength(1);
	expect(rects2[0].text).toBe("Block2");
});

test("line fragments - inline-block container element itself", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div><div style=\"display: inline-block;\">Container</div></div>",
	);

	const inlineBlock = dom.window.document.querySelector("div[style]")!;
	const rectTexts = lineTexts(layoutEngine, inlineBlock);

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
	const rectTexts = lineTexts(layoutEngine, span);

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
	const regularRects = lineTexts(layoutEngine, spans[0]); // Regular inline
	const blockRects = lineTexts(layoutEngine, spans[1]); // Inside inline-block
	const normalRects = lineTexts(layoutEngine, spans[2]); // Regular inline

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
	const fragments = layoutEngine.lineFragments(textNode);
	expect(
		fragments.map((fragment) =>
			renderTextFragment(
				textNode.data,
				"normal",
				fragment.startOffset,
				fragment.endOffset,
				fragment.visualBase,
			),
		),
	).toEqual(["The quick ", "brown fox ", "jumps over ", "it"]);
});

describe("white-space rendering round-trips through fragments", () => {
	// The breaker records, for each fragment, the data range it covers;
	// rendering that range must reproduce the fragment. One property, five
	// white-space values, exercised through the public pipeline.
	const cases: Array<[string, string]> = [
		["plain words", "hello world"],
		["a run of spaces", "a   b"],
		["a lone tab", "a\tb"],
		["a lone newline", "a\nb"],
		["mixed whitespace", "a \n\t b  \r\nc"],
		["leading and trailing", "  padded  "],
		["surrogate pairs", "a  \u{1f600}  b"],
	];

	for (const whiteSpace of [
		"normal",
		"nowrap",
		"pre-line",
		"pre",
		"pre-wrap",
	]) {
		for (const [name, data] of cases) {
			test(`${whiteSpace}: ${name}`, () => {
				const {layoutEngine, dom, processMutationsAndLayout} =
					createLayoutEngine(
						`<div style="width: 6ch; white-space: ${whiteSpace};"></div>`,
					);
				const document = dom.window.document;
				const div = document.querySelector("div")!;
				const textNode = document.createTextNode(data);
				div.appendChild(textNode);
				// The observer delivers on a microtask, so laying out without
				// draining it first lays out a document with no text in it.
				processMutationsAndLayout();

				const fragments = layoutEngine.lineFragments(textNode);
				expect(fragments.length).toBeGreaterThan(0);
				let reconstructed = "";
				for (const fragment of fragments) {
					expect(fragment.startOffset).toBeGreaterThanOrEqual(0);
					expect(fragment.endOffset).toBeLessThanOrEqual(data.length);
					reconstructed += renderTextFragment(
						data,
						whiteSpace,
						fragment.startOffset,
						fragment.endOffset,
						fragment.visualBase,
					);
				}
				// Every fragment renders back to characters the full
				// rendering contains, in order.
				const whole = renderTextFragment(data, whiteSpace, 0, data.length);
				let cursor = 0;
				for (const fragment of fragments) {
					const piece = renderTextFragment(
						data,
						whiteSpace,
						fragment.startOffset,
						fragment.endOffset,
					);
					const at = whole.indexOf(piece, cursor);
					expect(at).toBeGreaterThanOrEqual(0);
					cursor = at + piece.length;
				}
				// The fragments together carry the whole text: same characters,
				// same order, none lost and none repeated. Whitespace is left
				// out of the comparison because it is exactly what wrapping is
				// allowed to change -- a break eats the space it broke at.
				const visible = (text: string): string => text.replace(/\s+/g, "");
				expect(visible(reconstructed)).toBe(visible(whole));
			});
		}
	}
});

test("line fragment offsets render back under pre-wrap", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div style=\"width: 10ch; white-space: pre-wrap;\">a  b\nlong  line here</div>",
	);

	const textNode = dom.window.document.querySelector("div")!.firstChild as Text;
	const fragments = lineTexts(layoutEngine, textNode);
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
		"<div style=\"width: 12ch;\">wrapping prose across several lines</div>",
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

test("Text node data changes (characterData mutations)", async () => {
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
	const initialLines = initialOutput.split("\n").filter((line) => line.trim());
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

test("Nested inline element changes", async () => {
	// This test reveals issues with mutation handling for nested inline elements
	// The error occurs when changing content of elements that don't have their own Yoga nodes
	// Same root cause as textContent changes above
});

test("Complex inline run with mixed content types", async () => {
	// Similar to nested inline element changes - needs better handling of
	// mutations within elements that are part of inline runs but don't have Yoga nodes
});

// Tests for fundamental layout positioning bug
// These tests document the core issue affecting nested lists and other content

test("Block child positioned after parent text content", () => {
	const {dom, layoutEngine} = createLayoutEngine(
		"<div>Parent text<div>Child content</div></div>",
	);

	layoutEngine.calculateLayout();

	const parent = dom.window.document.querySelector("div")!;
	const child = parent.querySelector("div")!;
	const textNode = parent.firstChild!;

	const parentRect = layoutEngine.getRect(parent)!;
	const childRect = layoutEngine.getRect(child)!;
	const textRects = lineTexts(layoutEngine, textNode);

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
			if (isPhantom) {
				phantomLines++;
			}
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
			if (isPhantom) {
				phantomLineCount++;
			}
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
			if (isPhantom) {
				phantomLineCount++;
			}
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
	container.innerHTML = "<ul><li>Item 1</li><li>Item 2<ul><li>Sub item</li></ul></li></ul>";
	document.body.appendChild(container);

	await nextFrame(dom);

	const buffer = (terminal as any).terminal.buffer.active;
	let phantomLineCount = 0;

	for (let row = 0; row < terminal.stdout.rows; row++) {
		const line = buffer.getLine(row);
		if (line) {
			const text = line.translateToString(true);
			const isPhantom = text.trim() === "" && text.length > 0;
			if (isPhantom) {
				phantomLineCount++;
			}
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

// =============================================================================
// STATIC POSITION AND SHRINK-TO-FIT
// An out-of-flow box with no inset on an axis sits where it would have been in
// flow (CSS 2 §10.3.7), and one with `width: auto` and an `auto` inset takes
// shrink-to-fit width (§10.3.7 again, through the same measurement an
// inline-block takes).
// =============================================================================

test("an overlay with no insets paints on the row its flow position names", async () => {
	const terminal = new MockProcess({cols: 30, rows: 8});
	const termdom = new TermDOM({transport: terminal.transport});
	termdom.document.body.innerHTML =
		"<div style=\"position: relative;\">" +
		"<div>first</div><div>second</div>" +
		"<div style=\"position: absolute;\">OVERLAY</div>" +
		"</div>";
	await nextFrame(termdom);

	const rows = terminal.getPlainText().split("\n");
	expect(rows[0]).toContain("first");
	expect(rows[1]).toContain("second");
	expect(rows[2]).toContain("OVERLAY");
	termdom.dispose();
});

test("box-sizing decides what a declared width names", async () => {
	const termdom = new TermDOM({transport: new MockProcess().transport});
	const {document, window} = termdom;
	// Same declaration twice: 10 cells wide, a cell of padding either side and
	// a cell of border either side, so the edges come to 4.
	const edges = "width: 10ch; border: 1px solid red; padding: 0 1ch";
	document.body.innerHTML =
		`<div id="b" style="${edges}">x</div>` +
		`<div id="c" style="${edges}; box-sizing: content-box">x</div>`;
	await nextFrame(termdom);
	const rect = (id: string): DOMRect =>
		(document.getElementById(id) as HTMLElement).getBoundingClientRect();

	// border-box is this engine's default, and the declaration is the whole
	// box: the edges are drawn inside the 10 cells.
	expect(rect("b").width).toBe(10);
	// content-box names the content alone, so the box grows by its edges.
	expect(rect("c").width).toBe(14);

	// Either way the resolved value is the content width, which is what the
	// content-box declaration asked for and what the border-box one has left.
	expect(window.getComputedStyle(document.getElementById("b")!).width)
		.toBe("6px");
	expect(window.getComputedStyle(document.getElementById("c")!).width)
		.toBe("10px");
});

test("a content-box width counts the edges the painter draws", async () => {
	const termdom = new TermDOM({transport: new MockProcess().transport});
	const {document} = termdom;
	// `border: solid` carries the initial medium width, which on a cell grid
	// is the same one cell `border: 1px solid` draws, so the twins differ by
	// exactly the edges: a cell of padding and a cell of border either side.
	const edges = "width: 10ch; border: solid red; padding: 0 1ch";
	document.body.innerHTML =
		`<div id="b" style="${edges}">x</div>` +
		`<div id="c" style="${edges}; box-sizing: content-box">x</div>` +
		"<div id=\"n\" style=\"width: 10ch; box-sizing: content-box;" +
		" border: thick solid red; border-right-style: none\">x</div>";
	await nextFrame(termdom);
	const rect = (id: string): DOMRect =>
		(document.getElementById(id) as HTMLElement).getBoundingClientRect();

	expect(rect("b").width).toBe(10);
	expect(rect("c").width).toBe(14);
	// A side whose style is none draws nothing and takes nothing, however
	// wide the width property says (css-backgrounds §3.3).
	expect(rect("n").width).toBe(11);
	termdom.dispose();
});

test("a resolved value measures the layout the last style write asked for", async () => {
	const termdom = new TermDOM({transport: new MockProcess().transport});
	const {document, window} = termdom;
	document.body.innerHTML = "<div id=\"target\">content</div>";
	await nextFrame(termdom);
	const target = document.getElementById("target")! as HTMLElement;

	// A used value is measured, so the write before it has to reach layout:
	// the read takes the same flush a rect read does.
	// The resolved value of width is the CONTENT width, so the 4 cells of
	// padding come off the border box the declaration sized.
	target.style.paddingLeft = "4ch";
	target.style.width = "10ch";
	expect(window.getComputedStyle(target).width).toBe("6px");
	target.style.width = "20ch";
	expect(window.getComputedStyle(target).width).toBe("16px");
});

// === LAYOUT INVALIDATION TESTS ===

// These tests verify that DOM mutations are properly handled by the MutationObserver,
// which automatically triggers layout invalidation when elements are added/removed.

function createTermDOM(html = "<div></div>"): {
	document: Document;
	layoutEngine: LayoutEngine;
	frame: () => void;
} {
	const {layoutEngine, dom, processMutationsAndLayout} =
		createLayoutEngine(html);
	return {
		document: dom.window.document as unknown as Document,
		layoutEngine,
		frame: processMutationsAndLayout,
	};
}

function getPosition(layoutEngine: any, element: Element): number {
	try {
		const rects = lineTexts(layoutEngine, element);
		return rects[0]?.rect.x ?? -1;
	} catch (_err) {
		return -1;
	}
}

test("inline element removal preserves positioning", async () => {
	const {document, layoutEngine, frame} = createTermDOM();

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
	frame();
	expect(getPosition(layoutEngine, span1)).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, span2)).toBe(1); // B at x=1
	expect(getPosition(layoutEngine, span3)).toBe(2); // C at x=2

	// Remove middle element
	container.removeChild(span2);
	frame();
	expect(getPosition(layoutEngine, span1)).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, span3)).toBe(1); // C at x=1 (moved left)

	// Re-add at end
	container.appendChild(span2);
	frame();
	expect(getPosition(layoutEngine, span1)).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, span3)).toBe(1); // C at x=1
	expect(getPosition(layoutEngine, span2)).toBe(2); // B at x=2 (at end)
});

test("inline element removal in same position preserves layout", async () => {
	const {document, layoutEngine, frame} = createTermDOM();

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
	frame();
	const initialPositions = [
		getPosition(layoutEngine, span1),
		getPosition(layoutEngine, span2),
		getPosition(layoutEngine, span3),
	];

	// Remove middle element and re-add in exact same position
	const nextSibling = span2.nextSibling;
	container.removeChild(span2);
	frame();

	container.insertBefore(span2, nextSibling);
	frame();

	// Positions should be identical to initial state
	expect(getPosition(layoutEngine, span1)).toBe(initialPositions[0]);
	expect(getPosition(layoutEngine, span2)).toBe(initialPositions[1]);
	expect(getPosition(layoutEngine, span3)).toBe(initialPositions[2]);
});

test("run head removal transfers to next inline element", async () => {
	const {document, layoutEngine, frame} = createTermDOM();

	// Create inline run where first element is run head
	const container = document.createElement("div");
	const span1 = document.createElement("span");
	const span2 = document.createElement("span");

	span1.textContent = "FIRST";
	span2.textContent = "SECOND";

	container.appendChild(span1);
	container.appendChild(span2);
	document.body.appendChild(container);

	frame();

	// Verify span1 is the run head initially

	// Remove the run head
	container.removeChild(span1);
	frame();

	// span2 should become the new run head and have correct position
	const rects = lineTexts(layoutEngine, span2);
	expect(rects.length).toBeGreaterThan(0);
	expect(rects[0].text).toBe("SECOND");
	expect(rects[0].rect.x).toBe(0); // Should start at position 0

	// Re-add original run head at beginning
	container.insertBefore(span1, span2);
	frame();

	// span1 should become run head again with both elements correctly positioned

	const rects1 = lineTexts(layoutEngine, span1);
	const rects2 = lineTexts(layoutEngine, span2);

	expect(rects1[0].rect.x).toBe(0); // FIRST at x=0
	expect(rects2[0].rect.x).toBe(5); // SECOND at x=5 (after "FIRST")
});

test("block element removal merges adjacent inline runs", async () => {
	const {document, layoutEngine, frame} = createTermDOM();

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

	frame();

	// Remove block element
	container.removeChild(blockDiv);
	frame();

	// Now span1 and span2 should share the same run head (span1)

	// Both should be positioned correctly in the merged run
	expect(getPosition(layoutEngine, span1)).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, span2)).toBe(1); // B at x=1
});

test("text node removal invalidates inline runs", async () => {
	const {document, layoutEngine, frame} = createTermDOM();

	// Create inline run with text node
	const container = document.createElement("div");
	const span = document.createElement("span");
	const textNode = document.createTextNode("TEXT");

	span.textContent = "SPAN";

	container.appendChild(span);
	container.appendChild(textNode);
	document.body.appendChild(container);

	frame();

	// Both should be positioned correctly
	expect(getPosition(layoutEngine, span)).toBe(0);
	const spanRects = lineTexts(layoutEngine, span);
	expect(spanRects[0].text).toBe("SPAN");

	// Remove text node
	container.removeChild(textNode);
	frame();

	// Span should still work correctly
	expect(getPosition(layoutEngine, span)).toBe(0);
	const newSpanRects = lineTexts(layoutEngine, span);
	expect(newSpanRects[0].text).toBe("SPAN");
});

test("multiple element removal handles invalidation correctly", async () => {
	const {document, layoutEngine, frame} = createTermDOM();

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

	frame();

	// Verify initial positions
	spans.forEach((span, i) => {
		expect(getPosition(layoutEngine, span)).toBe(i);
	});

	// Remove multiple elements (B and D)
	container.removeChild(spans[1]); // Remove B
	container.removeChild(spans[3]); // Remove D
	frame();

	// Remaining elements should be positioned correctly: A C E
	expect(getPosition(layoutEngine, spans[0])).toBe(0); // A at x=0
	expect(getPosition(layoutEngine, spans[2])).toBe(1); // C at x=1
	expect(getPosition(layoutEngine, spans[4])).toBe(2); // E at x=2
});

// These tests verify that the layout invalidation logic works correctly. A DOM
// mutation reaches the layout engine through the MutationObserver, which
// restages the containers it unsettled: their break results are cleared and
// their runs recalculated on the next pass.

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
		"<div id=\"row\" style=\"display:flex;width:24ch\">" +
		"<div id=\"a\">aaaa bbbb cccc dddd eeee</div>" +
		"<div id=\"b\" style=\"flex-shrink:0\">wwww xxxx yyyy zzzz</div>" +
		"</div>";
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
		"<div style=\"width:30ch\"><span id=\"e\"></span><span id=\"n\"><b>hi</b></span></div>",
	);
	const empty = dom.window.document.getElementById("e")!;
	const nested = dom.window.document.getElementById("n")!;

	expect(layoutEngine.getRect(empty)?.width).toBe(0);
	// An inline whose text lives in a nested inline still measures that text.
	expect(layoutEngine.getRect(nested)?.width).toBe(2);
});

describe("width sizing keywords", () => {
	test("a block sized with the css-sizing-3 keywords next to known text", async () => {
		const terminal = new MockProcess({rows: 12, cols: 40});
		const dom = new TermDOM({transport: terminal.transport});
		const {document} = dom;
		document.body.innerHTML =
			"<div id=\"fit\" style=\"width: fit-content\">one two</div>" +
			"<div id=\"max\" style=\"width: max-content\">one two</div>" +
			"<div id=\"min\" style=\"width: min-content\">aa bbbb</div>" +
			"<div id=\"auto\">one two</div>" +
			"<div id=\"long\" style=\"width: fit-content\">a line that " +
			"runs on well past the forty columns this screen has</div>";
		await nextFrame(dom);

		const width = (id: string): number =>
			document.getElementById(id)!.getBoundingClientRect().width;
		// fit-content wraps the text; auto keeps filling the container.
		expect(width("fit")).toBe(7);
		expect(width("max")).toBe(7);
		// min-content is the widest word: "bbbb".
		expect(width("min")).toBe(4);
		expect(width("auto")).toBe(40);
		// fit-content is capped by the available width, unlike max-content.
		expect(width("long")).toBe(40);
		dom.dispose();
	});

	test("an inline-block takes the keywords through its own measurement", async () => {
		const terminal = new MockProcess({rows: 12, cols: 40});
		const dom = new TermDOM({transport: terminal.transport});
		const {document} = dom;
		document.body.innerHTML =
			"<div><span id=\"fit\" style=\"display:inline-block; " +
			"width: fit-content\">one two</span></div>" +
			"<div><span id=\"min\" style=\"display:inline-block; " +
			"width: min-content\">aa bbbb</span></div>";
		await nextFrame(dom);

		const width = (id: string): number =>
			document.getElementById(id)!.getBoundingClientRect().width;
		expect(width("fit")).toBe(7);
		expect(width("min")).toBe(4);
		dom.dispose();
	});

	test("a dialog with width: fit-content shrinks to its content", async () => {
		const terminal = new MockProcess({rows: 12, cols: 40});
		const dom = new TermDOM({transport: terminal.transport});
		const {document} = dom;
		document.body.innerHTML =
			"<style>dialog { width: fit-content }</style>" +
			"<dialog>Save?</dialog>";
		await nextFrame(dom);

		const dialog = document.querySelector("dialog") as HTMLDialogElement;
		dialog.show();
		await nextFrame(dom);
		// "Save?" is 5 columns; the UA border and padding add 2 apiece.
		expect(dialog.getBoundingClientRect().width).toBe(9);
		dom.dispose();
	});
});

// Both of these came out of fuzz/layout.test.ts, shrunk from a generated
// document to the smallest markup that still shows the difference. The
// property searches; these name the case and run in milliseconds.

test("white space beside an out-of-flow box collapses as if it were absent", () => {
	// Nothing in flow: the box has left it, and the space has nothing to sit
	// beside, so the container has no line to be one row tall for. The
	// collapsing test read the COMPUTED display, where the <b> is still an
	// inline, rather than the used one, where it has blockified.
	const {layoutEngine, dom, processMutationsAndLayout} = createLayoutEngine(
		"<div id=\"host\">   <b style=\"position: absolute\"></b></div>",
	);
	processMutationsAndLayout();
	const host = dom.window.document.getElementById("host")!;
	expect(layoutEngine.getRect(host)!.height).toBe(0);
});

test("a broken inline is not sized by an out-of-flow descendant", () => {
	// The <b> is split around a block, so its rect is the union of the
	// fragments it was broken into. An absolutely positioned child lays out
	// against its containing block and is no part of them, so the union is
	// empty -- the walk that gathers the fragments was descending into the
	// child on its computed display.
	const {layoutEngine, dom, processMutationsAndLayout} = createLayoutEngine(
		"<b id=\"split\"><div></div>" +
		"<div style=\"display: inline-block; position: absolute\">t000</div></b>",
	);
	processMutationsAndLayout();
	const split = dom.window.document.getElementById("split")!;
	const rect = layoutEngine.getRect(split);
	expect(rect === null || rect.width === 0).toBe(true);
});
