/**
 * Emoji Rendering Tests
 *
 * Tests proper handling of emojis in terminal rendering:
 * - Width calculation (most emojis are 2 characters wide)
 * - Mixed content with emojis and text
 * - Complex emoji sequences (skin tones, combinations)
 */

import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("renders single emoji correctly", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	const span = dom.document.createElement("span");
	span.textContent = "🚀";
	dom.document.body.appendChild(span);

	await nextFrame(dom);

	const output = terminal.getVisibleText();
	expect(output).toContain("🚀");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("single-emoji");
	dom.dispose();
});

test("renders emoji with text correctly", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	const span = dom.document.createElement("span");
	span.textContent = "Hello 🌍 World!";
	dom.document.body.appendChild(span);

	await nextFrame(dom);

	const output = terminal.getVisibleText();
	expect(output).toContain("Hello 🌍 World!");

	// Inline assertion: verify spaces after emojis are preserved
	const ansiOutput = terminal.getStaticANSI();
	expect(ansiOutput).toContain("Hello 🌍 World!"); // Space after emoji should be preserved
	expect(ansiOutput).not.toMatch(/🌍(?! )/); // Should not have emoji without following space

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("emoji-with-text");
	dom.dispose();
});

test("renders multiple emojis correctly", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	const container = dom.document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "column");

	const testCases = [
		"🚀🎯📄", // Multiple emojis together
		"🎉 Party 🎊", // Emojis with spaces
		"👨‍💻", // Complex emoji (man technologist)
		"🌈🦄✨", // Colorful sequence
		"📱💻⌨️🖱️", // Tech emojis
	];

	testCases.forEach((text) => {
		const span = dom.document.createElement("span");
		span.textContent = text;
		span.style.setProperty("padding", "2px");
		container.appendChild(span);
	});

	dom.document.body.appendChild(container);

	await nextFrame(dom);

	const output = terminal.getVisibleText();
	// Test that emojis are rendered
	expect(output).toContain("🚀");
	expect(output).toContain("🎯");
	expect(output).toContain("Party");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("multiple-emojis");
	dom.dispose();
});

test("renders emoji with colors correctly", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	const container = dom.document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "column");

	const emojiSpan = dom.document.createElement("span");
	emojiSpan.textContent = "🎨 Colorful Text 🌈";
	emojiSpan.style.setProperty("color", "magenta");
	emojiSpan.style.setProperty("background-color", "yellow");
	emojiSpan.style.setProperty("padding", "1px 2px");

	container.appendChild(emojiSpan);
	dom.document.body.appendChild(container);

	await nextFrame(dom);

	const output = terminal.getVisibleText();
	expect(output).toContain("🎨");
	expect(output).toContain("🌈");
	expect(output).toContain("Colorful Text");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("emoji-with-colors");
	dom.dispose();
});

test("preserves spaces after emojis", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	const span = dom.document.createElement("span");
	span.textContent = "A🌍B"; // Pattern that was failing before
	dom.document.body.appendChild(span);

	await nextFrame(dom);

	const output = terminal.getVisibleText();
	expect(output).toContain("A🌍B");

	// Critical inline assertions for the exact pattern that was broken
	const ansiOutput = terminal.getStaticANSI();
	expect(ansiOutput).toContain("A🌍B"); // All characters should be preserved
	expect(ansiOutput).not.toMatch(/A🌍(?!B)/); // Should not have emoji without the following "B"

	dom.dispose();
});

test("handles emoji width calculation", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	// Test that emojis are properly calculated for layout
	const container = dom.document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "row");
	container.style.setProperty("width", "40px"); // Increased width for full content

	const textSpan = dom.document.createElement("span");
	textSpan.textContent = "Text ";

	const emojiSpan = dom.document.createElement("span");
	emojiSpan.textContent = "🚀";

	const moreText = dom.document.createElement("span");
	moreText.textContent = " More";

	container.appendChild(textSpan);
	container.appendChild(emojiSpan);
	container.appendChild(moreText);
	dom.document.body.appendChild(container);

	await nextFrame(dom);

	const output = terminal.getVisibleText();
	// Each span is a flex item, so each is a box of its own with a line of its
	// own, and the spaces sit at the edges of those lines. They collapse away:
	// the emoji still measures two columns, and nothing separates it.
	expect(output).toContain("Text🚀More");

	expect(terminal.getStaticANSI()).toMatchSnapshot();
	terminal.writeANSI("emoji-width-layout");
	dom.dispose();
});

test("whitespace collapse affecting emoji rendering", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	// Test case that exposes whitespace/emoji interaction bugs
	const container = dom.document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("width", "20ch");

	// Each span has trailing/leading spaces that can get collapsed
	const span1 = dom.document.createElement("span");
	span1.textContent = "A   "; // Trailing spaces

	const span2 = dom.document.createElement("span");
	span2.textContent = "🚀🚀"; // Two emojis (4 visual width)

	const span3 = dom.document.createElement("span");
	span3.textContent = "   B"; // Leading spaces

	container.appendChild(span1);
	container.appendChild(span2);
	container.appendChild(span3);
	dom.document.body.appendChild(container);

	await nextFrame(dom);

	const output = terminal.getVisibleText();

	// This should contain all content without truncation
	expect(output).toContain("A");
	expect(output).toContain("🚀🚀");
	expect(output).toContain("B");

	// Each span is a flex item, so the trailing spaces of "A   " and the
	// leading spaces of "   B" are at the edges of their own lines and go.
	expect(output).toContain("A🚀🚀B");

	dom.dispose();
});

test("text after an emoji keeps its last character", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	// Specific test for the "Mor" truncation bug
	const container = dom.document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("width", "12ch"); // Constrained width

	const span1 = dom.document.createElement("span");
	span1.textContent = "Text ";

	const span2 = dom.document.createElement("span");
	span2.textContent = "🚀";

	const span3 = dom.document.createElement("span");
	span3.textContent = " More"; // This might get truncated to " Mor"

	container.appendChild(span1);
	container.appendChild(span2);
	container.appendChild(span3);
	dom.document.body.appendChild(container);

	await nextFrame(dom);

	const output = terminal.getVisibleText();

	// The critical test: "More" should not be truncated to "Mor"
	expect(output).toContain("More"); // Full word should be present
	expect(output).not.toContain("Mor\n"); // Should not be truncated
	expect(output).not.toMatch(/Mor(?!e)/); // "Mor" not followed by "e"

	dom.dispose();
});

test("emoji spacing with complex whitespace patterns", async () => {
	const terminal = new MockProcess();
	const dom = new TermDOM({transport: terminal.transport});

	// Test various whitespace patterns around emojis
	const testCases = [
		"🚀 text", // Space after emoji
		"text 🚀", // Space before emoji
		"🚀  text", // Multiple spaces after emoji
		"text  🚀", // Multiple spaces before emoji
		"🚀\ttext", // Tab after emoji
		"text\t🚀", // Tab before emoji
	];

	const container = dom.document.createElement("div");
	container.style.setProperty("display", "flex");
	container.style.setProperty("flex-direction", "column");

	testCases.forEach((testCase) => {
		const span = dom.document.createElement("span");
		span.textContent = testCase;
		container.appendChild(span);
	});

	dom.document.body.appendChild(container);
	await nextFrame(dom);

	const output = terminal.getVisibleText();

	// All emojis should be rendered
	expect(output.match(/🚀/g)?.length).toBe(testCases.length);

	// All "text" instances should be rendered (not truncated)
	expect(output.match(/text/g)?.length).toBe(testCases.length);

	dom.dispose();
});
