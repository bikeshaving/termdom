/**
 * Tests for nested inline-block element handling
 * Specifically testing fragment-walk logic
 */

import {expect, test} from "@b9g/libuild/test";

import {StyleManager} from "../src/internal/cssom.js";
import {createDocumentWindow} from "../src/internal/dom.js";
import {LayoutEngine} from "../src/internal/layout.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils";

/**
 * The breaker under test, over a document of the test's own: build the
 * tree, then lay it out with an engine the test constructs -- the same
 * two public classes the real engine wires together.
 */
function layOut(window: ReturnType<typeof createDocumentWindow>): LayoutEngine {
	const layoutEngine = new LayoutEngine(window);
	const styleManager = new StyleManager(window, layoutEngine);
	styleManager.refreshStylesheets();
	layoutEngine.calculateLayout();
	return layoutEngine;
}

test("line fragments should work for text nodes in nested inline-blocks", async () => {
	const window = createDocumentWindow("<!DOCTYPE html><body></body>");
	const {document} = window;

	const outer = document.createElement("div");
	outer.style.display = "inline-block";
	document.body.appendChild(outer);

	const span = document.createElement("span");
	span.textContent = "First ";
	outer.appendChild(span);

	const inner = document.createElement("div");
	inner.style.display = "inline-block";
	inner.textContent = "Second";
	outer.appendChild(inner);

	const layoutEngine = layOut(window);

	// Test the fragment walk on individual text nodes
	const spanTextNode = span.firstChild as Text;
	const innerTextNode = inner.firstChild as Text;

	const spanRects = layoutEngine.lineFragments(spanTextNode);
	const innerRects = layoutEngine.lineFragments(innerTextNode);

	// Both text nodes should return valid rects
	expect(spanRects).toHaveLength(1);
	expect(
		spanTextNode.data.slice(spanRects[0].startOffset, spanRects[0].endOffset),
	).toBe("First ");

	expect(innerRects).toHaveLength(1);
	expect(
		innerTextNode.data.slice(
			innerRects[0].startOffset,
			innerRects[0].endOffset,
		),
	).toBe("Second");

	// Positions should be different (side by side)
	expect(innerRects[0].rect.x).toBeGreaterThan(spanRects[0].rect.x);
});

test("nested inline-block should render both texts", async () => {
	const terminal = new MockProcess({cols: 50, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const outer = document.createElement("div");
	outer.style.display = "inline-block";
	outer.style.backgroundColor = "navy";
	outer.style.padding = "1px";
	document.body.appendChild(outer);

	const span = document.createElement("span");
	span.textContent = "Nested ";
	span.style.color = "white";
	outer.appendChild(span);

	const inner = document.createElement("div");
	inner.style.display = "inline-block";
	inner.style.backgroundColor = "red";
	inner.style.color = "white";
	inner.style.padding = "0 1px";
	inner.textContent = "block";
	outer.appendChild(inner);

	await nextFrame(dom);

	const output = terminal.getStaticANSI();
	const visibleText = terminal.getVisibleText();

	// Should contain both texts
	expect(visibleText).toContain("Nested");
	expect(visibleText).toContain("block");

	// Should have both background colors
	expect(output).toContain("48;2;0;0;128"); // navy background
	expect(output).toContain("48;2;255;0;0"); // red background

	dom.dispose();
});

test("deeply nested inline-blocks should work", async () => {
	const window = createDocumentWindow("<!DOCTYPE html><body></body>");
	const {document} = window;

	// Create: outer > middle > inner structure
	const outer = document.createElement("div");
	outer.style.display = "inline-block";
	document.body.appendChild(outer);

	const middle = document.createElement("div");
	middle.style.display = "inline-block";
	middle.textContent = "Middle ";
	outer.appendChild(middle);

	const inner = document.createElement("div");
	inner.style.display = "inline-block";
	inner.textContent = "Inner";
	middle.appendChild(inner);

	const layoutEngine = layOut(window);

	// Test the fragment walk on the deepest text node
	const innerTextNode = inner.firstChild as Text;
	const innerRects = layoutEngine.lineFragments(innerTextNode);

	expect(innerRects).toHaveLength(1);
	expect(
		innerTextNode.data.slice(
			innerRects[0].startOffset,
			innerRects[0].endOffset,
		),
	).toBe("Inner");
});

test("mixed content in nested inline-blocks", async () => {
	const terminal = new MockProcess({cols: 50, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	document.body.appendChild(container);

	// Mix of inline text and nested inline-blocks
	const text1 = document.createTextNode("Start ");
	container.appendChild(text1);

	const outer = document.createElement("div");
	outer.style.display = "inline-block";
	container.appendChild(outer);

	const span = document.createElement("span");
	span.textContent = "Outer ";
	outer.appendChild(span);

	const inner = document.createElement("div");
	inner.style.display = "inline-block";
	inner.textContent = "Inner";
	outer.appendChild(inner);

	const text2 = document.createTextNode(" End");
	container.appendChild(text2);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();

	// All text should be present in order
	expect(visibleText).toContain("Start");
	expect(visibleText).toContain("Outer");
	expect(visibleText).toContain("Inner");
	expect(visibleText).toContain("End");

	dom.dispose();
});

/**
 * The four below were found by a markup fuzzer whose invariant is simply
 * "every token in the document appears exactly once in the frame" -- each one
 * silently DROPPED content the browser paints, which is the failure mode no
 * snapshot catches, because a snapshot blesses whatever it was shown.
 */

test("a run continues past a nested inline-block, not just past its parent", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<span><span style=\"display: inline-block\">badge</span></span> and the rest";

	await nextFrame(dom);

	// The leaf walk used to stop at the inline-block's last-child position,
	// so everything after the wrapping span vanished.
	expect(terminal.getVisibleText()).toContain("badge and the rest");

	dom.dispose();
});

test("a run continues past a boxless child of a nested inline", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<span>lead<span style=\"display: none\">gone</span></span> tail";

	await nextFrame(dom);

	const text = terminal.getVisibleText();
	expect(text).toContain("lead tail");
	expect(text).not.toContain("gone");

	dom.dispose();
});

test("a widget alone inside an inline-block paints where the box measured it", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<div style=\"display: inline-block; padding: 0 2ch\"><input value=\"typed\"></div>";

	await nextFrame(dom);

	const input = dom.document.querySelector("input")!;
	const rect = input.getBoundingClientRect();
	// Its coordinates exist only inside the inline-block's own measurement;
	// read from the outer run it resolved to nothing and painted nowhere.
	expect(rect.x).toBe(2);
	expect(rect.width).toBeGreaterThan(0);
	expect(terminal.getVisibleText()).toContain("typed");

	dom.dispose();
});

test("a block between two runs does not blank the earlier one", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "heading<div>middle</div><input value=\"field\">";

	await nextFrame(dom);

	// Attaching the input's UA shadow tree cleared every break result in the
	// body -- including this text's, whose flex node stayed clean and so never
	// re-measured. It laid out at the right rect and painted nothing.
	const lines = terminal.getVisibleText().split("\n");
	expect(lines[0]).toContain("heading");
	expect(lines[1]).toContain("middle");
	expect(lines[2]).toContain("field");

	dom.dispose();
});
