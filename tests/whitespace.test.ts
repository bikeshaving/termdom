/**
 * CSS White-Space Property Tests
 *
 * Comprehensive tests for all CSS white-space values:
 * - normal: collapse whitespace, allow wrapping
 * - nowrap: collapse whitespace, no wrapping
 * - pre: preserve whitespace, no wrapping
 * - pre-wrap: preserve whitespace, allow wrapping
 * - pre-line: collapse whitespace except newlines, allow wrapping
 *
 * Tests both standalone behavior and interaction with flexbox containers.
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.ts";
import {MockProcess, nextFrame} from "./test-utils";

// ===== NOWRAP TESTS =====

test("white-space: nowrap in non-flex context should not wrap", async () => {
	const terminal = new MockProcess({cols: 60, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Simple block container (not flex) with constrained width
	const container = document.createElement("div");
	container.style.width = "10px"; // Force constraint smaller than text
	container.style.backgroundColor = "blue";
	document.body.appendChild(container);

	const text = document.createElement("span");
	text.textContent = "This is a very long text that should not wrap";
	text.style.whiteSpace = "nowrap";
	text.style.color = "white";
	container.appendChild(text);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();

	// With nowrap, text should not wrap to multiple lines
	const lines = visibleText.split("\n").filter((line) => line.trim());

	// Text should be on a single line (not wrapped)
	expect(lines.length).toBe(1);

	// Should see the full text on one line
	expect(lines[0]).toContain("This is a very long text that should not wrap");

	dom.dispose();
});

test("white-space: nowrap in flex context - content should determine container size", async () => {
	const terminal = new MockProcess({cols: 80, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Flex container with nowrap content
	const flexContainer = document.createElement("div");
	flexContainer.style.display = "flex";
	flexContainer.style.flexDirection = "row";
	flexContainer.style.backgroundColor = "darkblue";
	document.body.appendChild(flexContainer);

	// Item with nowrap text that should determine its own width
	const flexItem = document.createElement("div");
	flexItem.style.backgroundColor = "green";
	flexItem.style.flexShrink = "0"; // Should not shrink
	flexContainer.appendChild(flexItem);

	const nowrapText = document.createElement("span");
	nowrapText.textContent = "📋 Navigation Menu Items";
	nowrapText.style.whiteSpace = "nowrap";
	nowrapText.style.color = "white";
	flexItem.appendChild(nowrapText);

	// Second item to test positioning
	const flexItem2 = document.createElement("div");
	flexItem2.style.backgroundColor = "red";
	flexItem2.style.flexGrow = "1";
	flexContainer.appendChild(flexItem2);

	const secondText = document.createElement("span");
	secondText.textContent = "Second Item";
	secondText.style.color = "white";
	flexItem2.appendChild(secondText);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();

	// Both texts should be fully visible without truncation
	expect(visibleText).toContain("📋 Navigation Menu Items");
	expect(visibleText).toContain("Second Item");

	// Check that the full nowrap text is on one line and not truncated
	const lines = visibleText.split("\n");
	let foundFullNavigation = false;

	for (const line of lines) {
		if (line.includes("📋 Navigation")) {
			foundFullNavigation = true;
			expect(line).toContain("📋 Navigation Menu Items");
			// Should not be truncated
			expect(line).not.toMatch(/📋 Navigation Menu Item[^s]/);
		}
	}

	expect(foundFullNavigation).toBe(true);

	dom.dispose();
});

test("white-space: nowrap vs normal text wrapping comparison", async () => {
	const terminal = new MockProcess({cols: 30, rows: 15});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.display = "flex";
	container.style.flexDirection = "column";
	container.style.backgroundColor = "navy";
	container.style.padding = "1px";
	document.body.appendChild(container);

	// Normal wrapping text
	const normalDiv = document.createElement("div");
	normalDiv.style.backgroundColor = "darkgreen";
	normalDiv.style.width = "15px"; // Constrain width
	normalDiv.style.marginBottom = "1px";
	container.appendChild(normalDiv);

	const normalText = document.createElement("span");
	normalText.textContent = "This text should wrap normally";
	normalText.style.color = "white";
	normalText.style.whiteSpace = "normal"; // Default
	normalDiv.appendChild(normalText);

	// Nowrap text
	const nowrapDiv = document.createElement("div");
	nowrapDiv.style.backgroundColor = "darkred";
	nowrapDiv.style.width = "15px"; // Same constraint
	container.appendChild(nowrapDiv);

	const nowrapText = document.createElement("span");
	nowrapText.textContent = "This text should not wrap";
	nowrapText.style.color = "white";
	nowrapText.style.whiteSpace = "nowrap";
	nowrapDiv.appendChild(nowrapText);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();
	const lines = visibleText.split("\n");

	// Normal text should be broken across multiple lines
	let normalLineCount = 0;

	for (const line of lines) {
		if (
			line.includes("This text should wrap") ||
			line.includes("wrap normally") ||
			line.includes("should wrap") ||
			line.includes("text should")
		) {
			normalLineCount++;
		}
	}

	// Normal text should span multiple lines when constrained
	expect(normalLineCount).toBeGreaterThan(1);

	// Nowrap text should appear as one unit (either on one line or overflow)
	let _nowrapLineCount = 0;
	let foundFullNowrap = false;

	for (const line of lines) {
		if (line.includes("This text should not wrap")) {
			_nowrapLineCount++;
			foundFullNowrap = true;
		} else if (
			line.includes("This text should not") ||
			line.includes("text should not") ||
			line.includes("should not wrap")
		) {
			_nowrapLineCount++;
		}
	}

	// Nowrap should either be:
	// 1. On exactly one line (preferred - overflow behavior)
	// 2. Not broken mid-word if it must break
	expect(foundFullNowrap).toBe(true);

	dom.dispose();
});

test("white-space: nowrap with emoji and unicode", async () => {
	const terminal = new MockProcess({cols: 15, rows: 5});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.width = "8px"; // Very constrained
	container.style.backgroundColor = "purple";
	document.body.appendChild(container);

	const text = document.createElement("span");
	text.textContent = "📋🎨🚀 Emoji Text";
	text.style.whiteSpace = "nowrap";
	text.style.color = "white";
	container.appendChild(text);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();

	// The emoji text should not be broken in the middle
	// Either fully visible or gracefully truncated at boundaries
	expect(visibleText).toContain("📋");

	// Should not have broken emoji characters
	expect(visibleText).not.toContain("�"); // No replacement characters

	dom.dispose();
});

test("flexShrink 0 with white-space: nowrap should prevent shrinking entirely", async () => {
	const terminal = new MockProcess({cols: 50, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const flexContainer = document.createElement("div");
	flexContainer.style.display = "flex";
	flexContainer.style.flexDirection = "row";
	flexContainer.style.backgroundColor = "darkblue";
	document.body.appendChild(flexContainer);

	// First item: should not shrink due to flexShrink: 0 + nowrap
	const item1 = document.createElement("div");
	item1.style.backgroundColor = "green";
	item1.style.flexShrink = "0"; // Explicitly prevent shrinking
	item1.style.padding = "1px";
	flexContainer.appendChild(item1);

	const text1 = document.createElement("span");
	text1.textContent = "Long Navigation";
	text1.style.whiteSpace = "nowrap";
	text1.style.color = "white";
	item1.appendChild(text1);

	// Second item: flexible
	const item2 = document.createElement("div");
	item2.style.backgroundColor = "red";
	item2.style.flexGrow = "1";
	item2.style.padding = "1px";
	flexContainer.appendChild(item2);

	const text2 = document.createElement("span");
	text2.textContent = "Flexible Content That Can Shrink";
	text2.style.color = "white";
	// Note: normal wrapping, should adapt to available space
	item2.appendChild(text2);

	await nextFrame(dom);

	const visibleText = terminal.getVisibleText();

	// The nowrap + flexShrink:0 text should be fully preserved
	expect(visibleText).toContain("Long Navigation");

	// The flexible content should also be present (may wrap)
	expect(visibleText).toContain("Flexible Content");

	// Ensure the nowrap text is on a single line
	const lines = visibleText.split("\n");
	let foundFullNavigation = false;

	for (const line of lines) {
		if (line.includes("Long Navigation")) {
			foundFullNavigation = true;
			// Should not be truncated
			expect(line).toContain("Long Navigation");
		}
	}

	expect(foundFullNavigation).toBe(true);

	dom.dispose();
});

// ===== MIXED WHITE-SPACE PROPERTY TESTS =====

test("mixed white-space properties in single inline run", async () => {
	const terminal = new MockProcess({cols: 60, rows: 5});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Container with mixed white-space properties
	const container = document.createElement("div");
	container.style.width = "15ch";
	container.style.backgroundColor = "blue";
	document.body.appendChild(container);

	// Normal text that can wrap
	const normalText = document.createElement("span");
	normalText.textContent = "This text can wrap normally";
	normalText.style.whiteSpace = "normal";
	normalText.style.color = "white";
	container.appendChild(normalText);

	// Add a space between spans
	container.appendChild(document.createTextNode(" "));

	// Nowrap text that should not wrap
	const nowrapText = document.createElement("span");
	nowrapText.textContent = "but this should not wrap at all";
	nowrapText.style.whiteSpace = "nowrap";
	nowrapText.style.color = "yellow";
	container.appendChild(nowrapText);

	await nextFrame(dom);
	const visibleText = terminal.getVisibleText();

	// The nowrap span should appear on one line with spaces preserved
	// CSS white-space: nowrap collapses multiple spaces to one, but preserves single spaces
	expect(visibleText).toContain("but this should not wrap at all");

	// The important thing is that the nowrap text is not broken across lines
	const lines = visibleText.split("\n").filter((line) => line.trim());

	// The nowrap portion should be on one line
	let foundNowrapWithSpaces = false;
	for (const line of lines) {
		if (line.includes("but this should not wrap at all")) {
			foundNowrapWithSpaces = true;
		}
	}

	expect(foundNowrapWithSpaces).toBe(true);

	dom.dispose();
});

test("alternating white-space properties in inline run", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.width = "10ch";
	container.style.backgroundColor = "darkgreen";
	document.body.appendChild(container);

	// Mix of normal and nowrap spans
	const parts = [
		{text: "short", whiteSpace: "normal"},
		{text: " ", whiteSpace: "normal"},
		{text: "verylongwordthatshould", whiteSpace: "nowrap"},
		{text: " ", whiteSpace: "normal"},
		{text: "more", whiteSpace: "normal"},
	];

	parts.forEach((part) => {
		const span = document.createElement("span");
		span.textContent = part.text;
		span.style.whiteSpace = part.whiteSpace;
		span.style.color = "white";
		container.appendChild(span);
	});

	await nextFrame(dom);
	const visibleText = terminal.getVisibleText();

	// The nowrap word should not be broken
	expect(visibleText).toContain("verylongwordthatshould");

	dom.dispose();
});

test("nested elements with different white-space properties", async () => {
	const terminal = new MockProcess({cols: 50, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.width = "12ch";
	container.style.whiteSpace = "normal"; // Default wrapping
	document.body.appendChild(container);

	// Outer span with normal wrapping
	const outerSpan = document.createElement("span");
	outerSpan.style.whiteSpace = "normal";
	outerSpan.style.color = "white";
	container.appendChild(outerSpan);

	// Add some normal text
	outerSpan.appendChild(document.createTextNode("Some normal text "));

	// Inner span with nowrap
	const innerSpan = document.createElement("span");
	innerSpan.textContent = "this-should-not-wrap-anywhere";
	innerSpan.style.whiteSpace = "nowrap";
	innerSpan.style.backgroundColor = "red";
	outerSpan.appendChild(innerSpan);

	// More normal text
	outerSpan.appendChild(document.createTextNode(" and more text"));

	await nextFrame(dom);
	const visibleText = terminal.getVisibleText();

	// The inner nowrap span should stay together
	expect(visibleText).toContain("this-should-not-wrap-anywhere");

	dom.dispose();
});

test("pre and nowrap interaction in same run", async () => {
	const terminal = new MockProcess({cols: 40, rows: 5});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.width = "8ch";
	document.body.appendChild(container);

	// Pre text (preserves spaces and newlines)
	const preSpan = document.createElement("span");
	preSpan.textContent = "pre   text\nwith  newline";
	preSpan.style.whiteSpace = "pre";
	preSpan.style.color = "cyan";
	container.appendChild(preSpan);

	// Nowrap text
	const nowrapSpan = document.createElement("span");
	nowrapSpan.textContent = " plus nowrap text here";
	nowrapSpan.style.whiteSpace = "nowrap";
	nowrapSpan.style.color = "magenta";
	container.appendChild(nowrapSpan);

	await nextFrame(dom);
	const visibleText = terminal.getVisibleText();

	// Pre should preserve formatting, nowrap should not break
	// Nowrap should preserve single spaces between words
	expect(visibleText).toContain("plus nowrap text");

	// Check that pre preserved spaces (multiple spaces should be visible)
	expect(visibleText).toContain("pre   text");

	dom.dispose();
});

test("white-space inheritance and override", async () => {
	const terminal = new MockProcess({cols: 50, rows: 4});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	// Parent with nowrap
	const parent = document.createElement("div");
	parent.style.width = "10ch";
	parent.style.whiteSpace = "nowrap";
	parent.style.backgroundColor = "navy";
	document.body.appendChild(parent);

	// Child that inherits nowrap
	const inheritChild = document.createElement("span");
	inheritChild.textContent = "inherited nowrap behavior text";
	inheritChild.style.color = "white";
	// No explicit white-space - should inherit nowrap
	parent.appendChild(inheritChild);

	parent.appendChild(document.createTextNode(" "));

	// Child that overrides to normal
	const overrideChild = document.createElement("span");
	overrideChild.textContent = "but this overrides to normal wrapping";
	overrideChild.style.whiteSpace = "normal";
	overrideChild.style.color = "yellow";
	parent.appendChild(overrideChild);

	await nextFrame(dom);
	const visibleText = terminal.getVisibleText();

	// Inherited nowrap should not wrap
	expect(visibleText).toContain("inherited nowrap behavior text");

	// Override to normal should allow wrapping
	// The text might wrap, but should still be present
	expect(visibleText).toContain("overrides");

	dom.dispose();
});

test("complex mixed white-space with word-break properties", async () => {
	const terminal = new MockProcess({cols: 50, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	const {document} = dom;

	const container = document.createElement("div");
	container.style.width = "12ch";
	document.body.appendChild(container);

	// Normal wrapping text
	const normal = document.createElement("span");
	normal.textContent = "Normal text ";
	normal.style.whiteSpace = "normal";
	normal.style.color = "white";
	container.appendChild(normal);

	// Nowrap with word-break
	const nowrapBreak = document.createElement("span");
	nowrapBreak.textContent = "verylongwordthatcannotbreak ";
	nowrapBreak.style.whiteSpace = "nowrap";
	nowrapBreak.style.wordBreak = "break-all";
	nowrapBreak.style.color = "red";
	container.appendChild(nowrapBreak);

	// Pre-line text
	const preLine = document.createElement("span");
	preLine.textContent = "pre-line\ntext\nhere";
	preLine.style.whiteSpace = "pre-line";
	preLine.style.color = "green";
	container.appendChild(preLine);

	await nextFrame(dom);
	const visibleText = terminal.getVisibleText();

	// Nowrap should override word-break and stay on one line
	expect(visibleText).toContain("verylongwordthatcannotbreak");

	// Pre-line should preserve newlines
	// Terminal is 50 cols but all text may be on one line due to container constraints
	expect(visibleText).toContain("pre-line");
	expect(visibleText).toContain("text");

	dom.dispose();
});

test("a leading <br> keeps its line break and the whole run after it", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = "<br> abcdef";

	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));

	// The run's leading-whitespace trim used to eat the <br>'s newline (losing
	// the break) and shift every leaf's offsets without shifting the text those
	// offsets index into -- so the line measured one cell short of what it
	// painted and clipped the last character: " abcde".
	expect(lines[0]).toBe("");
	expect(lines[1]).toBe(" abcdef");

	dom.dispose();
});

test("white-space: pre suppresses wrapping but keeps newlines", async () => {
	const terminal = new MockProcess({cols: 40, rows: 12});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>
		#wrap { display: block; width: 10ch; white-space: pre; }
		#lines { white-space: pre; }
	</style>`;
	dom.document.body.innerHTML =
		"<div id=\"wrap\">the quick brown fox jumps over the lazy dog</div>" +
		"<div id=\"lines\">one\ntwo\nthree</div>";

	await nextFrame(dom);

	// `pre` does not wrap -- it overflows, like nowrap. This wrapped instead,
	// and the bug hid behind nowrap working correctly.
	expect(
		dom.document.getElementById("wrap")!.getBoundingClientRect().height,
	).toBe(1);
	// But a newline is a break the CONTENT demands, and suppressing every break
	// point to stop wrapping suppressed those too.
	expect(
		dom.document.getElementById("lines")!.getBoundingClientRect().height,
	).toBe(3);

	dom.dispose();
});

test("a comment node never collapses the block that holds it", async () => {
	// A non-rendering node (a comment) in the flow must not suppress the boxes
	// around it. A leading HTML comment -- how every generated Markdown file
	// starts -- collapsed its container to zero height, rendering blank.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();

	const height = async (html: string): Promise<number> => {
		dom.document.body.innerHTML = `<main>${html}</main>`;
		await nextFrame(dom);
		return dom.document.body.scrollHeight;
	};

	expect(await height("<h1>A</h1><p>B</p>")).toBe(2);
	// Same content, a comment in each position: height is unchanged.
	expect(await height("<!-- c --><h1>A</h1><p>B</p>")).toBe(2);
	expect(await height("<h1>A</h1><!-- c --><p>B</p>")).toBe(2);
	expect(await height("<h1>A</h1><p>B</p><!-- c -->")).toBe(2);
	// A comment inside an inline run leaves the line intact.
	expect(await height("<p>a<!-- c -->b</p>")).toBe(1);
	// A block whose only child is a comment still generates no content.
	expect(await height("<!-- only a comment -->")).toBe(0);

	dom.dispose();
});

test("a preserved space is content, and keeps its line", async () => {
	// White space collapses only where `white-space` says it may. A block
	// holding nothing but spaces is a line tall under `pre`, and nothing at all
	// under `normal` -- which is what makes a drawn row of blanks possible.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();

	const height = async (style: string): Promise<number> => {
		dom.document.body.innerHTML = `<main style="${style}"><div>ab</div><div>   </div><div>cd</div></main>`;
		await nextFrame(dom);
		return dom.document.body.scrollHeight;
	};

	expect(await height("white-space: normal")).toBe(2);
	expect(await height("white-space: pre")).toBe(3);
	expect(await height("white-space: pre-wrap")).toBe(3);
	expect(await height("white-space: break-spaces")).toBe(3);
	// pre-line collapses spaces, so a row of them is still nothing.
	expect(await height("white-space: pre-line")).toBe(2);

	dom.dispose();
});

test("preserved spaces survive inline element boundaries", async () => {
	// A bar chart's empty cells are single-space spans: under `pre` each is
	// one cell, and a run of them is as wide as it has spans.
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();
	dom.document.body.innerHTML =
		'<div style="white-space: pre">|<span> </span><span> </span><span> </span>X</div>' +
		'<div style="white-space: pre">|A<span> </span>B</div>' +
		"<div>|<span> </span><span> </span>collapsed</div>";
	await nextFrame(dom);
	const lines = terminal.getVisibleText().split("\n");
	expect(lines[0]).toContain("|   X");
	expect(lines[1]).toContain("|A B");
	// Under collapsing white-space the boundary rule still merges them.
	expect(lines[2]).toContain("| collapsed");
	dom.dispose();
});

test("break-spaces preserves every space", async () => {
	const terminal = new MockProcess({cols: 40, rows: 6});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML =
		'<div style="white-space: break-spaces">a  b   c</div>';
	await nextFrame(dom);
	expect(terminal.getVisibleText()).toContain("a  b   c");
	dom.dispose();
});

test("the spaces a line opens on collapse away, whatever follows them", async () => {
	// Found by fuzz/layout.test.ts, which noticed that taking a box out of
	// flow moved the boxes after it. Collapsible spaces at the start of a line
	// are removed (css-text-3 §4.1.1), and a line box left holding nothing but
	// an empty inline is treated as not existing (css2 §9.4.2) -- so the block
	// below sits on row 0 however the spaces before it are arranged.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();

	const top = async (markup: string): Promise<number> => {
		dom.document.body.innerHTML = markup;
		await nextFrame(dom);
		const target = dom.document.querySelector("#t")!;
		return target.getBoundingClientRect().y;
	};

	expect(await top("   <div id=t>x</div>")).toBe(0);
	expect(await top("<b></b><div id=t>x</div>")).toBe(0);
	// The pair is the case that failed: neither the spaces nor the empty
	// inline makes a line on its own, and together they made one.
	expect(await top("   <b></b><div id=t>x</div>")).toBe(0);
	expect(await top("   <b> </b><div id=t>x</div>")).toBe(0);
	// Text on the line is content, and keeps it.
	expect(await top("   <b>y</b><div id=t>x</div>")).toBe(1);

	dom.dispose();
});

test("a pre span keeps its own spaces, and only its own", async () => {
	// The trim used to ask whether ANYTHING in the run preserved spaces, which
	// spared the collapsible ones at both edges. A preserving leaf guards the
	// spaces it carries; the ones around it still go.
	const terminal = new MockProcess({cols: 40, rows: 8});
	const dom = new TermDOM({transport: terminal.transport});
	dom.attach();

	const left = async (markup: string): Promise<number> => {
		dom.document.body.innerHTML = markup;
		await nextFrame(dom);
		const target = dom.document.querySelector("#t")!;
		return target.getBoundingClientRect().x;
	};

	expect(await left('   <b id=t style="white-space: pre">ab</b>')).toBe(0);
	expect(await left('<b id=t style="white-space: pre">ab</b>   ')).toBe(0);
	// Its own spaces stay: the text starts one cell in.
	expect(await left('<b style="white-space: pre"> </b><b id=t>ab</b>')).toBe(1);

	dom.dispose();
});
