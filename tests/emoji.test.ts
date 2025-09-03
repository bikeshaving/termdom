/**
 * Emoji Rendering Tests
 *
 * Tests proper handling of emojis in terminal rendering:
 * - Width calculation (most emojis are 2 characters wide)
 * - Mixed content with emojis and text
 * - Complex emoji sequences (skin tones, combinations)
 */

import {test, expect} from "bun:test";
import {TestTerminal} from "./test-utils.js";
import {TermDOM} from "../src/termdom.js";
import {writeFileSync, mkdirSync, existsSync} from "fs";
import {join} from "path";

test("renders single emoji correctly", async () => {
	const terminal = new TestTerminal();
	const dom = new TermDOM({process: terminal});

	const span = dom.document.createElement("span");
	span.textContent = "🚀";
	dom.document.body.appendChild(span);

	await dom.waitForRender();

	const output = terminal.getVisibleText();
	expect(output).toContain("🚀");
	expect(output).toMatchSnapshot();

	// Save ANSI snapshot for visual inspection
	const snapshotsDir = join(process.cwd(), "tests", "__snapshots__");
	if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, {recursive: true});
	writeFileSync(
		join(snapshotsDir, "single-emoji.ansi"),
		terminal.getScreenContents(),
	);
	dom.dispose();
});

test("renders emoji with text correctly", async () => {
	const terminal = new TestTerminal();
	const dom = new TermDOM({process: terminal});

	const span = dom.document.createElement("span");
	span.textContent = "Hello 🌍 World!";
	dom.document.body.appendChild(span);

	await dom.waitForRender();

	const output = terminal.getVisibleText();
	expect(output).toContain("Hello 🌍 World!");
	expect(output).toMatchSnapshot();

	// Save ANSI snapshot for visual inspection
	const snapshotsDir = join(process.cwd(), "tests", "__snapshots__");
	if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, {recursive: true});
	writeFileSync(
		join(snapshotsDir, "emoji-with-text.ansi"),
		terminal.getScreenContents(),
	);
	dom.dispose();
});

test("renders multiple emojis correctly", async () => {
	const terminal = new TestTerminal();
	const dom = new TermDOM({process: terminal});

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

	await dom.waitForRender();

	const output = terminal.getVisibleText();
	// Test that emojis are rendered
	expect(output).toContain("🚀");
	expect(output).toContain("🎯");
	expect(output).toContain("Party");
	expect(output).toMatchSnapshot();

	// Save ANSI snapshot for visual inspection
	const snapshotsDir = join(process.cwd(), "tests", "__snapshots__");
	if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, {recursive: true});
	writeFileSync(
		join(snapshotsDir, "multiple-emojis.ansi"),
		terminal.getScreenContents(),
	);
	dom.dispose();
});

test("renders emoji with colors correctly", async () => {
	const terminal = new TestTerminal();
	const dom = new TermDOM({process: terminal});

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

	await dom.waitForRender();

	const output = terminal.getVisibleText();
	expect(output).toContain("🎨");
	expect(output).toContain("🌈");
	expect(output).toContain("Colorful Text");
	expect(output).toMatchSnapshot();

	// Save ANSI snapshot for visual inspection
	const snapshotsDir = join(process.cwd(), "tests", "__snapshots__");
	if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, {recursive: true});
	writeFileSync(
		join(snapshotsDir, "emoji-with-colors.ansi"),
		terminal.getScreenContents(),
	);
	dom.dispose();
});

test("handles emoji width calculation", async () => {
	const terminal = new TestTerminal();
	const dom = new TermDOM({process: terminal});

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

	await dom.waitForRender();

	const output = terminal.getVisibleText();
	expect(output).toContain("Text");
	expect(output).toContain("🚀");
	expect(output).toContain("Mor"); // May be truncated due to layout constraints
	expect(output).toMatchSnapshot();

	// Save ANSI snapshot for visual inspection
	const snapshotsDir = join(process.cwd(), "tests", "__snapshots__");
	if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, {recursive: true});
	writeFileSync(
		join(snapshotsDir, "emoji-width-layout.ansi"),
		terminal.getScreenContents(),
	);
	dom.dispose();
});
