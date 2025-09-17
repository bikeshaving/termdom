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

import {test, expect} from "bun:test";
import {TestTerminal} from "./test-utils";
import {TermDOM} from "../src/termdom";

// ===== NOWRAP TESTS =====
// TODO: Add tests for other white-space values: normal, pre, pre-wrap, pre-line

test("white-space: nowrap in non-flex context should not wrap", async () => {
	const terminal = new TestTerminal({cols: 20, rows: 10});
	const dom = new TermDOM({process: terminal});
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

	await dom.render();

	const visibleText = terminal.getVisibleText();

	// With nowrap, text should either:
	// 1. Overflow the container (preferred CSS behavior)
	// 2. Not be broken across lines
	const lines = visibleText.split("\n");
	let foundFullText = false;

	for (const line of lines) {
		if (line.includes("This is a very long text")) {
			foundFullText = true;
			// The text should appear as one continuous string, not wrapped
			expect(line).toContain("This is a very long text that should not wrap");
		}
	}

	expect(foundFullText).toBe(true);

	dom.dispose();
});

test("white-space: nowrap in flex context - content should determine container size", async () => {
	const terminal = new TestTerminal({cols: 80, rows: 10});
	const dom = new TermDOM({process: terminal});
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

	await dom.render();

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
	const terminal = new TestTerminal({cols: 30, rows: 15});
	const dom = new TermDOM({process: terminal});
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

	await dom.render();

	const visibleText = terminal.getVisibleText();
	const lines = visibleText.split("\n");

	// Normal text should be broken across multiple lines
	let normalTextSpansLines = false;
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
	let nowrapLineCount = 0;
	let foundFullNowrap = false;

	for (const line of lines) {
		if (line.includes("This text should not wrap")) {
			nowrapLineCount++;
			foundFullNowrap = true;
		} else if (
			line.includes("This text should not") ||
			line.includes("text should not") ||
			line.includes("should not wrap")
		) {
			nowrapLineCount++;
		}
	}

	// Nowrap should either be:
	// 1. On exactly one line (preferred - overflow behavior)
	// 2. Not broken mid-word if it must break
	expect(foundFullNowrap).toBe(true);

	dom.dispose();
});

test("white-space: nowrap with emoji and unicode", async () => {
	const terminal = new TestTerminal({cols: 15, rows: 5});
	const dom = new TermDOM({process: terminal});
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

	await dom.render();

	const visibleText = terminal.getVisibleText();

	// The emoji text should not be broken in the middle
	// Either fully visible or gracefully truncated at boundaries
	expect(visibleText).toContain("📋");

	// Should not have broken emoji characters
	expect(visibleText).not.toContain("�"); // No replacement characters

	dom.dispose();
});

test("flexShrink 0 with white-space: nowrap should prevent shrinking entirely", async () => {
	const terminal = new TestTerminal({cols: 25, rows: 8});
	const dom = new TermDOM({process: terminal});
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

	await dom.render();

	const visibleText = terminal.getVisibleText();

	// The nowrap + flexShrink:0 text should be fully preserved
	expect(visibleText).toContain("Long Navigation");

	// The flexible content should also be present (may wrap)
	expect(visibleText).toContain("Flexible Content");

	// Ensure the first item's text isn't truncated due to incorrect shrinking
	const lines = visibleText.split("\n");
	let foundFullNavigation = false;

	for (const line of lines) {
		if (line.includes("Long Navigation")) {
			foundFullNavigation = true;
			// Should not be truncated to "Long Navig" or similar
			expect(line).toContain("Long Navigation");
		}
	}

	expect(foundFullNavigation).toBe(true);

	dom.dispose();
});
