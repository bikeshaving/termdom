import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {TestTerminal} from "./test-utils";

test("custom element with anonymous slot", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Define a custom element with shadow DOM and anonymous slot
	class MyWrapper extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const wrapper = document.createElement("div");
			wrapper.textContent = "Wrapper: ";
			wrapper.style.cssText = "color: red;";

			const slot = document.createElement("slot");
			slot.textContent = "Default fallback";

			wrapper.appendChild(slot);
			shadow.appendChild(wrapper);
		}
	}

	// Register the custom element
	termdom.window.customElements.define("my-wrapper", MyWrapper as any);

	// Create instance with light DOM content
	const myWrapper = document.createElement("my-wrapper") as any;

	const content1 = document.createElement("span");
	content1.textContent = "Light content 1";
	content1.style.cssText = "color: green;";

	const content2 = document.createElement("span");
	content2.textContent = " and content 2";
	content2.style.cssText = "color: blue;";

	myWrapper.appendChild(content1);
	myWrapper.appendChild(content2);

	// Test the merged DOM tree creation
	const shadowRoot = myWrapper.shadowRoot;
	const mergedTree = (termdom as any).createMergedDOMTree(
		shadowRoot,
		myWrapper,
	);

	// Should have one child (the wrapper div)
	expect(mergedTree.childNodes.length).toBe(1);

	const mergedWrapper = mergedTree.firstChild as Element;
	expect(mergedWrapper.tagName).toBe("DIV");

	// Should contain "Wrapper: " text plus the two slotted spans
	expect(mergedWrapper.childNodes.length).toBe(3);
	expect(mergedWrapper.childNodes[0].textContent).toBe("Wrapper: ");
	expect(mergedWrapper.childNodes[1].textContent).toBe("Light content 1");
	expect(mergedWrapper.childNodes[2].textContent).toBe(" and content 2");
});

test("custom element with named slots", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Define a custom element with named slots
	class MyCard extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const card = document.createElement("div");
			card.style.cssText = "border: 1px solid; padding: 1ch;";

			// Header with named slot
			const header = document.createElement("div");
			header.textContent = "Title: ";
			header.style.cssText = "color: red; font-weight: bold;";
			const titleSlot = document.createElement("slot");
			titleSlot.setAttribute("name", "title");
			titleSlot.textContent = "Default Title";
			header.appendChild(titleSlot);

			// Body with anonymous slot
			const body = document.createElement("div");
			body.textContent = "Content: ";
			body.style.cssText = "color: green;";
			const contentSlot = document.createElement("slot");
			contentSlot.textContent = "Default Content";
			body.appendChild(contentSlot);

			// Footer with named slot
			const footer = document.createElement("div");
			footer.textContent = "Footer: ";
			footer.style.cssText = "color: blue;";
			const footerSlot = document.createElement("slot");
			footerSlot.setAttribute("name", "footer");
			footerSlot.textContent = "Default Footer";
			footer.appendChild(footerSlot);

			card.appendChild(header);
			card.appendChild(body);
			card.appendChild(footer);
			shadow.appendChild(card);
		}
	}

	termdom.window.customElements.define("my-card", MyCard as any);

	// Create instance with light DOM content
	const myCard = document.createElement("my-card") as any;

	// Add content for named slots
	const title = document.createElement("h1");
	title.textContent = "Custom Card Title";
	title.setAttribute("slot", "title");

	const footer = document.createElement("small");
	footer.textContent = "Custom Footer Text";
	footer.setAttribute("slot", "footer");

	// Add anonymous content
	const content1 = document.createElement("p");
	content1.textContent = "Main content paragraph 1";

	const content2 = document.createElement("p");
	content2.textContent = "Main content paragraph 2";

	myCard.appendChild(title);
	myCard.appendChild(content1);
	myCard.appendChild(content2);
	myCard.appendChild(footer);

	// Test the merged DOM tree creation
	const shadowRoot = myCard.shadowRoot;
	const mergedTree = (termdom as any).createMergedDOMTree(shadowRoot, myCard);

	// Should have one child (the card div)
	expect(mergedTree.childNodes.length).toBe(1);

	const mergedCard = mergedTree.firstChild as Element;
	expect(mergedCard.childNodes.length).toBe(3); // header, body, footer

	const mergedHeader = mergedCard.childNodes[0] as Element;
	const mergedBody = mergedCard.childNodes[1] as Element;
	const mergedFooter = mergedCard.childNodes[2] as Element;

	// Check title slot substitution
	expect(mergedHeader.childNodes.length).toBe(2); // "Title: " + slotted h1
	expect(mergedHeader.childNodes[0].textContent).toBe("Title: ");
	expect((mergedHeader.childNodes[1] as Element).textContent).toBe(
		"Custom Card Title",
	);
	expect((mergedHeader.childNodes[1] as Element).tagName).toBe("H1");

	// Check anonymous slot substitution (should have both paragraphs)
	expect(mergedBody.childNodes.length).toBe(3); // "Content: " + 2 paragraphs
	expect(mergedBody.childNodes[0].textContent).toBe("Content: ");
	expect((mergedBody.childNodes[1] as Element).textContent).toBe(
		"Main content paragraph 1",
	);
	expect((mergedBody.childNodes[1] as Element).tagName).toBe("P");
	expect((mergedBody.childNodes[2] as Element).textContent).toBe(
		"Main content paragraph 2",
	);
	expect((mergedBody.childNodes[2] as Element).tagName).toBe("P");

	// Check footer slot substitution
	expect(mergedFooter.childNodes.length).toBe(2); // "Footer: " + slotted small
	expect(mergedFooter.childNodes[0].textContent).toBe("Footer: ");
	expect((mergedFooter.childNodes[1] as Element).textContent).toBe(
		"Custom Footer Text",
	);
	expect((mergedFooter.childNodes[1] as Element).tagName).toBe("SMALL");
});

test("custom element fallback content when no light DOM", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Define a custom element with fallback content
	class MyButton extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const button = document.createElement("div");
			button.style.cssText = "border: 1px solid; padding: 0.5ch;";
			button.textContent = "Button: ";

			const slot = document.createElement("slot");
			slot.textContent = "Click me"; // Fallback content

			button.appendChild(slot);
			shadow.appendChild(button);
		}
	}

	termdom.window.customElements.define("my-button", MyButton as any);

	// Create instance WITHOUT light DOM content
	const myButton = document.createElement("my-button") as any;
	// No children added - should use fallback

	// Test the merged DOM tree creation
	const shadowRoot = myButton.shadowRoot;
	const mergedTree = (termdom as any).createMergedDOMTree(shadowRoot, myButton);

	const mergedButton = mergedTree.firstChild as Element;
	expect(mergedButton.childNodes.length).toBe(2); // "Button: " + fallback text
	expect(mergedButton.childNodes[0].textContent).toBe("Button: ");
	expect(mergedButton.childNodes[1].textContent).toBe("Click me");
});

// Edge Cases and Mutation Tests

test("light DOM changes after initial render", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	class DynamicWrapper extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const wrapper = document.createElement("div");
			wrapper.textContent = "Content: ";

			const slot = document.createElement("slot");
			slot.textContent = "Empty";

			wrapper.appendChild(slot);
			shadow.appendChild(wrapper);
		}
	}

	termdom.window.customElements.define(
		"dynamic-wrapper",
		DynamicWrapper as any,
	);
	const element = document.createElement("dynamic-wrapper") as any;

	// Initial state - should use fallback
	let mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	let wrapper = mergedTree.firstChild as Element;
	expect(wrapper.childNodes.length).toBe(2); // "Content: " + fallback
	expect(wrapper.childNodes[1].textContent).toBe("Empty");

	// Add light DOM content
	const newContent = document.createElement("span");
	newContent.textContent = "Added content";
	element.appendChild(newContent);

	// Re-create merged tree (simulating render refresh)
	mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	wrapper = mergedTree.firstChild as Element;
	expect(wrapper.childNodes.length).toBe(2); // "Content: " + new content
	expect(wrapper.childNodes[1].textContent).toBe("Added content");
	expect((wrapper.childNodes[1] as Element).tagName).toBe("SPAN");

	// Remove light DOM content
	element.removeChild(newContent);

	// Should revert to fallback
	mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	wrapper = mergedTree.firstChild as Element;
	expect(wrapper.childNodes.length).toBe(2);
	expect(wrapper.childNodes[1].textContent).toBe("Empty"); // Back to fallback
});

test("shadow DOM structure changes", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	class ModifiableShadow extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			// Initial shadow DOM structure
			const container = document.createElement("div");
			container.textContent = "Original: ";
			const slot = document.createElement("slot");
			container.appendChild(slot);
			shadow.appendChild(container);
		}
	}

	termdom.window.customElements.define(
		"modifiable-shadow",
		ModifiableShadow as any,
	);
	const element = document.createElement("modifiable-shadow") as any;

	// Add light DOM content
	const content = document.createElement("span");
	content.textContent = "Light content";
	element.appendChild(content);

	// Initial merged tree
	let mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	let container = mergedTree.firstChild as Element;
	expect(container.childNodes[0].textContent).toBe("Original: ");
	expect(container.childNodes[1].textContent).toBe("Light content");

	// Modify shadow DOM structure
	const shadowContainer = element.shadowRoot.firstChild as Element;
	shadowContainer.childNodes[0].textContent = "Modified: "; // Change text

	// Re-create merged tree
	mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	container = mergedTree.firstChild as Element;
	expect(container.childNodes[0].textContent).toBe("Modified: ");
	expect(container.childNodes[1].textContent).toBe("Light content");

	// Add another slot to shadow DOM
	const newSlot = document.createElement("slot");
	newSlot.setAttribute("name", "extra");
	newSlot.textContent = "Extra fallback";
	shadowContainer.appendChild(newSlot);

	// Should now have the new slot with fallback content
	mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	container = mergedTree.firstChild as Element;
	expect(container.childNodes.length).toBe(3); // text + anonymous slot + named slot
	expect(container.childNodes[2].textContent).toBe("Extra fallback");
});

test("slot attribute changes on light DOM", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	class SlotSwitcher extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const header = document.createElement("div");
			header.textContent = "Header: ";
			const headerSlot = document.createElement("slot");
			headerSlot.setAttribute("name", "header");
			headerSlot.textContent = "Default Header";
			header.appendChild(headerSlot);

			const main = document.createElement("div");
			main.textContent = "Main: ";
			const mainSlot = document.createElement("slot");
			mainSlot.textContent = "Default Main";
			main.appendChild(mainSlot);

			shadow.appendChild(header);
			shadow.appendChild(main);
		}
	}

	termdom.window.customElements.define("slot-switcher", SlotSwitcher as any);
	const element = document.createElement("slot-switcher") as any;

	// Add content that will switch between slots
	const content = document.createElement("span");
	content.textContent = "Switching content";
	element.appendChild(content);

	// Initially no slot attribute - should go to anonymous slot (main)
	let mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	let headerDiv = mergedTree.childNodes[0] as Element;
	let mainDiv = mergedTree.childNodes[1] as Element;

	expect(headerDiv.childNodes[1].textContent).toBe("Default Header"); // fallback
	expect(mainDiv.childNodes[1].textContent).toBe("Switching content"); // slotted

	// Change to header slot
	content.setAttribute("slot", "header");

	mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	headerDiv = mergedTree.childNodes[0] as Element;
	mainDiv = mergedTree.childNodes[1] as Element;

	expect(headerDiv.childNodes[1].textContent).toBe("Switching content"); // now slotted here
	expect(mainDiv.childNodes[1].textContent).toBe("Default Main"); // back to fallback

	// Remove slot attribute - should go back to anonymous
	content.removeAttribute("slot");

	mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	headerDiv = mergedTree.childNodes[0] as Element;
	mainDiv = mergedTree.childNodes[1] as Element;

	expect(headerDiv.childNodes[1].textContent).toBe("Default Header"); // fallback again
	expect(mainDiv.childNodes[1].textContent).toBe("Switching content"); // back to anonymous
});

test("multiple elements with same slot name", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	class MultiSlot extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const container = document.createElement("div");
			container.textContent = "Items: ";
			const slot = document.createElement("slot");
			slot.setAttribute("name", "item");
			container.appendChild(slot);
			shadow.appendChild(container);
		}
	}

	termdom.window.customElements.define("multi-slot", MultiSlot as any);
	const element = document.createElement("multi-slot") as any;

	// Add multiple elements with same slot name
	const item1 = document.createElement("span");
	item1.textContent = "Item 1";
	item1.setAttribute("slot", "item");

	const item2 = document.createElement("span");
	item2.textContent = "Item 2";
	item2.setAttribute("slot", "item");

	const item3 = document.createElement("span");
	item3.textContent = "Item 3";
	item3.setAttribute("slot", "item");

	element.appendChild(item1);
	element.appendChild(item2);
	element.appendChild(item3);

	// All should be slotted into the same named slot
	const mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);
	const container = mergedTree.firstChild as Element;

	expect(container.childNodes.length).toBe(4); // "Items: " + 3 items
	expect(container.childNodes[0].textContent).toBe("Items: ");
	expect(container.childNodes[1].textContent).toBe("Item 1");
	expect(container.childNodes[2].textContent).toBe("Item 2");
	expect(container.childNodes[3].textContent).toBe("Item 3");
});

test("empty slots and edge cases", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	class EdgeCase extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			// Slot with no fallback content
			const emptySlot = document.createElement("slot");
			emptySlot.setAttribute("name", "empty");

			// Slot with whitespace-only fallback
			const whitespaceSlot = document.createElement("slot");
			whitespaceSlot.setAttribute("name", "whitespace");
			whitespaceSlot.textContent = "   \n\t   ";

			// Anonymous slot
			const anonSlot = document.createElement("slot");

			shadow.appendChild(emptySlot);
			shadow.appendChild(whitespaceSlot);
			shadow.appendChild(anonSlot);
		}
	}

	termdom.window.customElements.define("edge-case", EdgeCase as any);
	const element = document.createElement("edge-case") as any;

	// Add some light DOM content but not for the named slots
	const textNode = document.createTextNode("Text node content");
	element.appendChild(textNode);

	const mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);

	// Should have 2 children - empty slot disappears, whitespace slot + anonymous slot remain
	expect(mergedTree.childNodes.length).toBe(2);

	// Empty slot with no fallback and no assigned content should be empty
	// Note: This might create an empty text node or nothing - implementation dependent

	// First child should be whitespace slot with fallback
	expect(mergedTree.childNodes[0].textContent).toBe("   \n\t   ");

	// Second child should be anonymous slot with the text node
	expect(mergedTree.childNodes[1].textContent).toBe("Text node content");
});

test("text nodes vs elements in slots", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	class MixedContent extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const slot = document.createElement("slot");
			shadow.appendChild(slot);
		}
	}

	termdom.window.customElements.define("mixed-content", MixedContent as any);
	const element = document.createElement("mixed-content") as any;

	// Mix of text nodes, elements, and whitespace
	element.appendChild(document.createTextNode("Start "));

	const span = document.createElement("span");
	span.textContent = "middle";
	element.appendChild(span);

	element.appendChild(document.createTextNode(" end"));
	element.appendChild(document.createTextNode("\n")); // whitespace-only

	const mergedTree = (termdom as any).createMergedDOMTree(
		element.shadowRoot,
		element,
	);

	// Should have all content slotted
	expect(mergedTree.childNodes.length).toBe(4); // 3 meaningful + 1 whitespace
	expect(mergedTree.childNodes[0].textContent).toBe("Start ");
	expect((mergedTree.childNodes[1] as Element).tagName).toBe("SPAN");
	expect(mergedTree.childNodes[1].textContent).toBe("middle");
	expect(mergedTree.childNodes[2].textContent).toBe(" end");
	// Note: whitespace-only text nodes are filtered out in our implementation
});
