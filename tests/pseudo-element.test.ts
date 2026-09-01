import {expect, test} from "@b9g/libuild/test";

import {pseudoElement} from "../src/internal/dom.js";
import {flowWalker} from "../src/internal/layout.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame, styleManagerFor} from "./test-utils.js";

test("::before and ::after content rendering", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Add CSS with pseudo-element content
	const style = document.createElement("style");
	style.textContent = `
    .quote::before { 
      content: '"'; 
      color: red; 
    }
    .quote::after { 
      content: '"'; 
      color: red; 
    }
    .prefix::before { 
      content: "Note: "; 
      color: blue; 
      font-weight: bold;
    }
    .decorated::before { 
      content: "🎯 "; 
    }
    .decorated::after { 
      content: " ✨"; 
    }
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	// Test basic quote wrapper
	const quote = document.createElement("div");
	quote.className = "quote";
	quote.textContent = "Hello World";
	document.body.appendChild(quote);

	// Test prefix element
	const note = document.createElement("div");
	note.className = "prefix";
	note.textContent = "This is important information.";
	document.body.appendChild(note);

	// Test decorated element with emojis
	const decorated = document.createElement("span");
	decorated.className = "decorated";
	decorated.textContent = "Achievement Unlocked";
	document.body.appendChild(decorated);

	// Render to terminal
	await nextFrame(termdom);
	const output = terminal.getPlainText();

	// Verify that pseudo-element content appears in the rendered output
	expect(output).toContain('"Hello World"'); // Quote wrapping
	expect(output).toContain("Note: This is important information."); // Prefix
	expect(output).toContain("🎯 Achievement Unlocked ✨"); // Emoji decoration

	// The computed pseudo styles are the public record of what attached.
	const {window} = termdom;
	expect(
		window.getComputedStyle(quote, "::before").getPropertyValue("content"),
	).toBe('"\\""');
	expect(
		window.getComputedStyle(quote, "::after").getPropertyValue("content"),
	).toBe('"\\""');
	expect(
		window.getComputedStyle(note, "::before").getPropertyValue("content"),
	).toBe('"Note: "');
});

test("::marker pseudo-element with lists", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Add CSS for custom list markers
	const style = document.createElement("style");
	style.textContent = `
    .custom-list li::marker { 
      content: "→ "; 
      color: green;
    }
    .numbered-list li::marker { 
      content: counter(list-item) ". "; 
      color: blue;
    }
    .emoji-list li::marker { 
      content: "🔥 "; 
    }
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	// Test custom arrow markers
	const customList = document.createElement("ul");
	customList.className = "custom-list";

	const item1 = document.createElement("li");
	item1.textContent = "First item";
	customList.appendChild(item1);

	const item2 = document.createElement("li");
	item2.textContent = "Second item";
	customList.appendChild(item2);

	document.body.appendChild(customList);

	// Test emoji markers
	const emojiList = document.createElement("ul");
	emojiList.className = "emoji-list";

	const emojiItem = document.createElement("li");
	emojiItem.textContent = "Fire item";
	emojiList.appendChild(emojiItem);

	document.body.appendChild(emojiList);

	// Render to terminal
	await nextFrame(termdom);
	const output = terminal.getPlainText();

	// Verify custom markers appear in output (outside positioning is the default)
	expect(output).toContain("→");
	expect(output).toContain("First item");
	expect(output).toContain("Second item");
	expect(output).toContain("🔥");
	expect(output).toContain("Fire item");

	// Verify StyleManager can get marker content for outside positioning
	const styleManager = styleManagerFor(termdom);

	const markerContent = styleManager.getMarkerContent(item1);
	expect(markerContent).not.toBeNull();
	expect(markerContent).toBe("→ ");

	const emojiMarkerContent = styleManager.getMarkerContent(emojiItem);
	expect(emojiMarkerContent).not.toBeNull();
	expect(emojiMarkerContent).toBe("🔥 ");
});

test("Pseudo-element cascade and specificity in rendering", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Test CSS specificity with pseudo-elements
	const style = document.createElement("style");
	style.textContent = `
    div::before { content: "div: "; }           /* 000-000-002 */
    .content::before { content: "content: "; }  /* 000-001-001 */
    #special::before { content: "special: "; }  /* 001-000-001 */
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	// Element that matches all three selectors
	const element = document.createElement("div");
	element.className = "content";
	element.id = "special";
	element.textContent = "Test message";
	document.body.appendChild(element);

	// Render to terminal
	await nextFrame(termdom);
	const output = terminal.getPlainText();

	// Should use highest specificity rule (ID selector)
	expect(output).toContain("special: Test message");
	expect(output).not.toContain("div: Test message");
	expect(output).not.toContain("content: Test message");

	// Verify StyleManager cascade resolution
	const beforeStyle = termdom.window.getComputedStyle(element, "::before");
	expect(beforeStyle.getPropertyValue("content")).toBe('"special: "');
});

test.todo(
	"Complex pseudo-element content with special characters",
	async () => {
		const terminal = new MockProcess();
		const termdom = new TermDOM({transport: terminal.transport});
		const {document} = termdom;

		// Test various content types
		const style = document.createElement("style");
		style.textContent = `
    .quotes::before { content: "He said: \\"Hello\\""; }
    .unicode::before { content: "★ "; }
    .escaped::before { content: "\\A → "; white-space: pre; }
    .empty::before { content: ""; }
    .none::before { content: none; }
    .normal::before { content: normal; }
  `;
		document.head.appendChild(style);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Test different content scenarios
		const quotesEl = document.createElement("div");
		quotesEl.className = "quotes";
		quotesEl.textContent = "Content";
		document.body.appendChild(quotesEl);

		const unicodeEl = document.createElement("div");
		unicodeEl.className = "unicode";
		unicodeEl.textContent = "Important";
		document.body.appendChild(unicodeEl);

		// Test elements that shouldn't have pseudo-elements
		const emptyEl = document.createElement("div");
		emptyEl.className = "empty";
		emptyEl.textContent = "No prefix";
		document.body.appendChild(emptyEl);

		const noneEl = document.createElement("div");
		noneEl.className = "none";
		noneEl.textContent = "Also no prefix";
		document.body.appendChild(noneEl);

		// Render to terminal
		await nextFrame(termdom);
		const output = terminal.getPlainText();

		// Verify complex content rendering
		expect(output).toContain('He said: "Hello"Content');
		expect(output).toContain("★ Important");

		// Content of none, normal or nothing creates no pseudo-element.
		const normalEl = document.createElement("div");
		normalEl.className = "normal";
		document.body.appendChild(normalEl);
		await nextFrame(termdom);
		expect(pseudoElement(emptyEl, "::before")).toBeNull();
		expect(pseudoElement(noneEl, "::before")).toBeNull();
		expect(pseudoElement(normalEl, "::before")).toBeNull();
	},
);

test("Pseudo-elements with inline styles override", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Base CSS rules
	const style = document.createElement("style");
	style.textContent = `
    .base::before { content: "CSS: "; color: red; }
    .base::after { content: " [end]"; color: blue; }
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	const element = document.createElement("div");
	element.className = "base";
	element.textContent = "Middle content";
	document.body.appendChild(element);

	// Render to terminal
	await nextFrame(termdom);
	const output = terminal.getPlainText();

	// Should contain pseudo-element content
	expect(output).toContain("CSS: Middle content [end]");

	// Verify pseudo-element styles are accessible
	const beforeStyle = termdom.window.getComputedStyle(element, "::before");
	const afterStyle = termdom.window.getComputedStyle(element, "::after");

	expect(beforeStyle.getPropertyValue("content")).toBe('"CSS: "');
	expect(beforeStyle.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
	expect(afterStyle.getPropertyValue("content")).toBe('" [end]"');
	expect(afterStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");
});

test.todo(
	"ExpandedTreeWalker traverses pseudo-elements in document order",
	async () => {
		const terminal = new MockProcess();
		const termdom = new TermDOM({transport: terminal.transport});
		const {document} = termdom;

		// Add CSS for multiple pseudo-elements
		const style = document.createElement("style");
		style.textContent = `
    .test::before { content: "BEFORE "; }
    .test::after { content: " AFTER"; }
    li::marker { content: "• "; }
  `;
		document.head.appendChild(style);

		await new Promise((resolve) => setTimeout(resolve, 10));

		// Create test structure
		const container = document.createElement("div");
		document.body.appendChild(container);

		const testDiv = document.createElement("div");
		testDiv.className = "test";
		testDiv.textContent = "MIDDLE";
		container.appendChild(testDiv);

		const list = document.createElement("ul");
		container.appendChild(list);

		const listItem = document.createElement("li");
		listItem.className = "test";
		listItem.textContent = "ITEM";
		list.appendChild(listItem);

		// Use ExpandedTreeWalker to traverse and collect all content
		const walker = flowWalker(container);

		const traversedContent: string[] = [];
		let currentNode = walker.nextNode();

		while (currentNode) {
			if (currentNode.nodeType === currentNode.TEXT_NODE) {
				const textContent = currentNode.textContent || "";
				if (textContent.trim()) {
					traversedContent.push(textContent);
				}
			}
			currentNode = walker.nextNode();
		}

		// Verify pseudo-elements are included in traversal
		// Note: This depends on ExpandedTreeWalker being integrated with StyleManager
		// The exact order may vary based on implementation, but pseudo-element content should be present
		const allContent = traversedContent.join("");
		expect(allContent).toContain("BEFORE");
		expect(allContent).toContain("MIDDLE");
		expect(allContent).toContain("AFTER");

		// Render and verify final output
		await nextFrame(termdom);
		const output = terminal.getPlainText();

		// The output should contain pseudo-element content in proper document order
		expect(output).toContain("BEFORE MIDDLE AFTER");
	},
);

test("a block pseudo-element's resolved width and height are its used box", async () => {
	const terminal = new MockProcess({cols: 40, rows: 24});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		span.block::before { content: "BB"; display: block }
		span.sized::before { content: "BB"; display: block; width: 10px }
	`;
	document.head.appendChild(style);
	document.body.innerHTML =
		"<div><span class=\"block\">hello</span></div>" +
		"<div><span class=\"sized\">hello</span></div>";
	await nextFrame(termdom);
	const {window} = termdom;

	// A block box stretches to its containing block, and the resolved value
	// reports that used width -- not the computed "auto".
	const block = window.getComputedStyle(
		document.querySelector(".block")!,
		"::before",
	);
	expect(block.getPropertyValue("width")).toBe("40px");
	expect(block.getPropertyValue("height")).toBe("1px");

	// A declared width is the used width.
	const sized = window.getComputedStyle(
		document.querySelector(".sized")!,
		"::before",
	);
	expect(sized.getPropertyValue("width")).toBe("10px");
	expect(sized.getPropertyValue("height")).toBe("1px");
});

test("an inline pseudo-element measures as an element's inline box does", async () => {
	const terminal = new MockProcess({cols: 40, rows: 24});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = "span.inline::before { content: \"II\" }";
	document.head.appendChild(style);
	document.body.innerHTML =
		"<div><span class=\"inline\">yo</span><span class=\"bare\">yo</span></div>";
	await nextFrame(termdom);
	const {window} = termdom;

	// An inline box's resolved width is the union of its fragments, for a
	// pseudo-element exactly as for an element: the pseudo's two cells, the
	// bare span's two.
	const pseudo = window.getComputedStyle(
		document.querySelector(".inline")!,
		"::before",
	);
	const element = window.getComputedStyle(document.querySelector(".bare")!);
	expect(element.getPropertyValue("width")).toBe("2px");
	expect(pseudo.getPropertyValue("width")).toBe("2px");
	expect(pseudo.getPropertyValue("height")).toBe("1px");
});

test("a pseudo-element that generates no box keeps its computed value", async () => {
	const terminal = new MockProcess({cols: 40, rows: 24});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent =
		"span.none::before { content: \"NN\"; display: none; width: 10px }";
	document.head.appendChild(style);
	document.body.innerHTML = "<div><span class=\"none\">zz</span></div>";
	await nextFrame(termdom);

	const none = termdom.window.getComputedStyle(
		document.querySelector(".none")!,
		"::before",
	);
	expect(none.getPropertyValue("width")).toBe("10px");
	expect(none.getPropertyValue("height")).toBe("auto");
});

test("a pseudo-element's used box answers the read that asked for the layout", async () => {
	const terminal = new MockProcess({cols: 40, rows: 24});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = "span.block::before { content: \"BB\"; display: block }";
	document.head.appendChild(style);
	document.body.innerHTML = "<div><span class=\"block\">hello</span></div>";

	// No frame yet: the resolved read takes the same flush a rect read does,
	// so the box it measures is the one this DOM lays out.
	const cs = termdom.window.getComputedStyle(
		document.querySelector(".block")!,
		"::before",
	);
	expect(cs.getPropertyValue("width")).toBe("40px");
	expect(cs.getPropertyValue("height")).toBe("1px");
});

test("a slot's ::before and ::after wrap the content assigned to it", async () => {
	const terminal = new MockProcess({cols: 40, rows: 24});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const host = document.createElement("div");
	const shadow = host.attachShadow({mode: "open"});
	// A slot's own pseudo-elements sit around whatever it renders, which is
	// its assigned nodes when it has any and its fallback content otherwise.
	shadow.innerHTML =
		"<style>slot::before { content: \"PRE\" } " +
		"slot::after { content: \"END\" }</style><slot>FB</slot>";
	host.appendChild(document.createTextNode("ASSIGNED"));
	document.body.appendChild(host);
	await nextFrame(termdom);

	expect(terminal.getPlainText()).toContain("PREASSIGNEDEND");
});

test("a slot's ::after follows its fallback content when nothing is assigned", async () => {
	const terminal = new MockProcess({cols: 40, rows: 24});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const host = document.createElement("div");
	const shadow = host.attachShadow({mode: "open"});
	shadow.innerHTML =
		"<style>slot::after { content: \"END\" }</style><slot>FB</slot>";
	document.body.appendChild(host);
	await nextFrame(termdom);

	expect(terminal.getPlainText()).toContain("FBEND");
});
