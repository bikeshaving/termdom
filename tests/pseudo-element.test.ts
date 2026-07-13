import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {MockProcess} from "./test-utils.js";
import {getPseudoElement} from "../src/composition.js";

test("::before and ::after content rendering", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
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

	// Trigger stylesheet refresh to attach pseudo elements
	termdom.styleManager.refreshStylesheets();

	// Check the actual attached pseudo elements using the composition API
	const beforeQuoteNode = getPseudoElement(quote, "::before");
	const afterQuoteNode = getPseudoElement(quote, "::after");

	// Render to terminal
	await termdom.render();
	const output = terminal.getPlainText();

	// Verify that pseudo-element content appears in the rendered output
	expect(output).toContain('"Hello World"'); // Quote wrapping
	expect(output).toContain("Note: This is important information."); // Prefix
	expect(output).toContain("🎯 Achievement Unlocked ✨"); // Emoji decoration

	// Verify StyleManager is creating pseudo-element nodes
	expect(beforeQuoteNode).not.toBeNull();
	expect(beforeQuoteNode!.textContent).toBe('"');

	expect(afterQuoteNode).not.toBeNull();
	expect(afterQuoteNode!.textContent).toBe('"');

	const beforePrefixNode = termdom.styleManager.createPseudoElementNode(
		note,
		"::before",
	);
	expect(beforePrefixNode).not.toBeNull();
	expect(beforePrefixNode!.textContent).toBe("Note: ");
});

test("::marker pseudo-element with lists", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
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
	await termdom.render();
	const output = terminal.getPlainText();

	// Verify custom markers appear in output (outside positioning is the default)
	expect(output).toContain("→");
	expect(output).toContain("First item");
	expect(output).toContain("Second item");
	expect(output).toContain("🔥");
	expect(output).toContain("Fire item");

	// Verify StyleManager can get marker content for outside positioning
	const styleManager = termdom.styleManager;

	const markerContent = styleManager.getMarkerContent(item1);
	expect(markerContent).not.toBeNull();
	expect(markerContent).toBe("→ ");

	const emojiMarkerContent = styleManager.getMarkerContent(emojiItem);
	expect(emojiMarkerContent).not.toBeNull();
	expect(emojiMarkerContent).toBe("🔥 ");
});

test("Pseudo-element cascade and specificity in rendering", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
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
	await termdom.render();
	const output = terminal.getPlainText();

	// Should use highest specificity rule (ID selector)
	expect(output).toContain("special: Test message");
	expect(output).not.toContain("div: Test message");
	expect(output).not.toContain("content: Test message");

	// Verify StyleManager cascade resolution
	const _styleManager = termdom.styleManager;
	const beforeStyle = termdom.window.getComputedStyle(element, "::before");
	expect(beforeStyle.getPropertyValue("content")).toBe('"special: "');
});

test.todo(
	"Complex pseudo-element content with special characters",
	async () => {
		const terminal = new MockProcess();
		const termdom = new TermDOM({process: terminal});
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
		await termdom.render();
		const output = terminal.getPlainText();

		// Verify complex content rendering
		expect(output).toContain('He said: "Hello"Content');
		expect(output).toContain("★ Important");

		// Verify empty/none/normal don't create pseudo-elements
		const styleManager = termdom.styleManager;

		expect(styleManager.shouldCreatePseudoElement(emptyEl, "::before")).toBe(
			false,
		);
		expect(styleManager.shouldCreatePseudoElement(noneEl, "::before")).toBe(
			false,
		);

		const normalEl = document.createElement("div");
		normalEl.className = "normal";
		expect(styleManager.shouldCreatePseudoElement(normalEl, "::before")).toBe(
			false,
		);
	},
);

test("Pseudo-elements with inline styles override", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
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
	await termdom.render();
	const output = terminal.getPlainText();

	// Should contain pseudo-element content
	expect(output).toContain("CSS: Middle content [end]");

	// Verify pseudo-element styles are accessible
	const beforeStyle = termdom.window.getComputedStyle(element, "::before");
	const afterStyle = termdom.window.getComputedStyle(element, "::after");

	expect(beforeStyle.getPropertyValue("content")).toBe('"CSS: "');
	expect(beforeStyle.getPropertyValue("color")).toBe("red");
	expect(afterStyle.getPropertyValue("content")).toBe('" [end]"');
	expect(afterStyle.getPropertyValue("color")).toBe("blue");
});

test.todo(
	"ExpandedTreeWalker traverses pseudo-elements in document order",
	async () => {
		const terminal = new MockProcess();
		const termdom = new TermDOM({process: terminal});
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
		const walker = termdom.createExpandedTreeWalker(container);

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
		await termdom.render();
		const output = terminal.getPlainText();

		// The output should contain pseudo-element content in proper document order
		expect(output).toContain("BEFORE MIDDLE AFTER");
	},
);
