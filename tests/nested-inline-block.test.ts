/**
 * Tests for nested inline-block element handling
 * Specifically testing findInlineRunHead and getRectTexts logic
 */

import {test, expect} from "@b9g/libuild/test";
import {MockProcess, nextFrame} from "./test-utils";
import {TermDOM, kLayoutEngine} from "../src/internal/termdom.js";

test("findInlineRunHead should find outer inline-block for nested text nodes", async () => {
	const terminal = new MockProcess({cols: 50, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Create nested structure: outer inline-block > span + inner inline-block
	const outer = document.createElement("div");
	outer.style.display = "inline-block";
	outer.style.backgroundColor = "navy";
	document.body.appendChild(outer);

	const span = document.createElement("span");
	span.textContent = "Nested ";
	outer.appendChild(span);

	const inner = document.createElement("div");
	inner.style.display = "inline-block";
	inner.style.backgroundColor = "red";
	inner.textContent = "block";
	outer.appendChild(inner);

	await nextFrame(dom);

	// Access layout engine internals for testing
	const layoutEngine = dom[kLayoutEngine];

	// Test findInlineRunHead for different nodes
	const spanTextNode = span.firstChild as Text;
	const innerTextNode = inner.firstChild as Text;

	const spanRunHead = layoutEngine.findInlineRunHead(spanTextNode);
	const innerRunHead = layoutEngine.findInlineRunHead(innerTextNode);

	// Both text nodes should have the outer inline-block as their run head
	expect(spanRunHead).toBe(outer);
	expect(innerRunHead).toBe(outer);

	dom.dispose();
});

test("getRectTexts should work for text nodes in nested inline-blocks", async () => {
	const terminal = new MockProcess({cols: 50, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

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

	await nextFrame(dom);

	const layoutEngine = dom[kLayoutEngine];

	// Test getRectTexts on individual text nodes
	const spanTextNode = span.firstChild as Text;
	const innerTextNode = inner.firstChild as Text;

	const spanRects = layoutEngine.getRectTexts(spanTextNode);
	const innerRects = layoutEngine.getRectTexts(innerTextNode);

	// Both text nodes should return valid rects
	expect(spanRects).toHaveLength(1);
	expect(spanRects[0].text).toBe("First ");

	expect(innerRects).toHaveLength(1);
	expect(innerRects[0].text).toBe("Second");

	// Positions should be different (side by side)
	expect(innerRects[0].rect.x).toBeGreaterThan(spanRects[0].rect.x);

	dom.dispose();
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
	const terminal = new MockProcess({cols: 50, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

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

	await nextFrame(dom);

	const layoutEngine = dom[kLayoutEngine];
	const visibleText = terminal.getVisibleText();

	// All text should be present
	expect(visibleText).toContain("Middle");
	expect(visibleText).toContain("Inner");

	// Test getRectTexts on the deepest text node
	const innerTextNode = inner.firstChild as Text;
	const innerRects = layoutEngine.getRectTexts(innerTextNode);

	expect(innerRects).toHaveLength(1);
	expect(innerRects[0].text).toBe("Inner");

	dom.dispose();
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
	dom.document.body.innerHTML = `<span><span style="display: inline-block">badge</span></span> and the rest`;

	await nextFrame(dom);

	// The leaf walk used to stop at the inline-block's last-child position,
	// so everything after the wrapping span vanished.
	expect(terminal.getVisibleText()).toContain("badge and the rest");

	dom.dispose();
});

test("a run continues past a boxless child of a nested inline", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<span>lead<span style="display: none">gone</span></span> tail`;

	await nextFrame(dom);

	const text = terminal.getVisibleText();
	expect(text).toContain("lead tail");
	expect(text).not.toContain("gone");

	dom.dispose();
});

test("a widget alone inside an inline-block paints where the box measured it", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = `<div style="display: inline-block; padding: 0 2ch"><input value="typed"></div>`;

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
	dom.document.body.innerHTML = `heading<div>middle</div><input value="field">`;

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
