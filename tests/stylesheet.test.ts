import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, styleManagerFor} from "./test-utils.js";
import {
	pseudoElement,
	pseudoHostOf,
	pseudoNameOf,
} from "../src/internal/dom.js";

test("CSS specificity calculation", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Add CSS with different specificities
	const style = document.createElement("style");
	style.textContent = `
    div { color: red; }                    /* 000-000-001 */
    .class { color: green; }               /* 000-001-000 */  
    .class.other { color: blue; }          /* 000-002-000 */
    #id { color: purple; }                 /* 001-000-000 */
    #id.class { color: orange; }           /* 001-001-000 */
    div.class { color: yellow; }           /* 000-001-001 */
  `;
	document.head.appendChild(style);

	// Wait for MutationObserver to parse styles
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Specificity is verified through the cascade -- the most specific matching
	// rule wins in getComputedStyle -- rather than by reading the parser's table.
	const colorOf = (className: string, id: string): string => {
		const el = document.createElement("div");
		if (className) el.className = className;
		if (id) el.id = id;
		document.body.appendChild(el);
		return termdom.window.getComputedStyle(el).getPropertyValue("color");
	};

	expect(colorOf("", "")).toBe("rgb(255, 0, 0)"); // div (000-000-001)
	expect(colorOf("class", "")).toBe("rgb(255, 255, 0)"); // div.class (000-001-001) beats .class
	expect(colorOf("class other", "")).toBe("rgb(0, 0, 255)"); // .class.other (000-002-000)
	expect(colorOf("", "id")).toBe("rgb(128, 0, 128)"); // #id (001-000-000)
	expect(colorOf("class", "id")).toBe("rgb(255, 165, 0)"); // #id.class (001-001-000)

	termdom.dispose();
});

test("CSS cascade resolution", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Test cascade: inline > CSS rules by specificity > defaults
	const style = document.createElement("style");
	style.textContent = `
    div { color: red; }
    .high-specificity { color: green; }  
    #very-high { color: blue; }
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	// Test element with multiple applicable rules
	const div = document.createElement("div");
	div.className = "high-specificity";
	div.id = "very-high";
	document.body.appendChild(div);

	// Should resolve to blue (highest specificity: ID)
	let computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

	// Inline style should override everything
	div.style.color = "yellow";
	computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(255, 255, 0)");
});

test("Pseudo-element CSS support", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
    .test::before { 
      content: "Before: "; 
      color: blue; 
    }
    .test::after { 
      content: " :After"; 
      color: green; 
    }
    li::marker { 
      color: purple; 
    }
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	const div = document.createElement("div");
	div.className = "test";
	document.body.appendChild(div);

	// Test pseudo-element computed styles
	const beforeStyle = termdom.window.getComputedStyle(div, "::before");
	expect(beforeStyle.getPropertyValue("content")).toBe('"Before: "');
	expect(beforeStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

	const afterStyle = termdom.window.getComputedStyle(div, "::after");
	expect(afterStyle.getPropertyValue("content")).toBe('" :After"');
	expect(afterStyle.getPropertyValue("color")).toBe("rgb(0, 128, 0)");

	// Test list marker
	const li = document.createElement("li");
	document.body.appendChild(li);

	const markerStyle = termdom.window.getComputedStyle(li, "::marker");
	expect(markerStyle.getPropertyValue("color")).toBe("rgb(128, 0, 128)");
});

test("Pseudo-element specificity", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
    div::before { content: "div"; color: red; }        /* 000-000-002 */
    .class::before { content: "class"; color: green; } /* 000-001-001 */
    #id::before { content: "id"; color: blue; }        /* 001-000-001 */
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	const div = document.createElement("div");
	div.className = "class";
	div.id = "id";
	document.body.appendChild(div);

	// Should resolve to blue (ID has highest specificity)
	const beforeStyle = termdom.window.getComputedStyle(div, "::before");
	expect(beforeStyle.getPropertyValue("content")).toBe('"id"');
	expect(beforeStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");

	termdom.dispose();
});

test.todo("StyleManager auto-refresh on DOM changes", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const div = document.createElement("div");
	div.className = "test";
	document.body.appendChild(div);

	// Initially no styles
	let computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(0, 0, 0)"); // default

	// Add stylesheet dynamically
	const style = document.createElement("style");
	style.textContent = ".test { color: red; }";
	document.head.appendChild(style);

	// Wait for MutationObserver to trigger
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Should automatically pick up new styles
	computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(255, 0, 0)");

	// Modify stylesheet content
	style.textContent = ".test { color: blue; }";

	// Wait for change detection
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Should pick up modified styles
	computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("rgb(0, 0, 255)");
});

test("StyleManager createPseudoElementNode", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
    .test::before { content: "Hello World"; }
    .empty::before { content: none; }
    .normal::before { content: normal; }
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	const styleManager = styleManagerFor(termdom);

	// Test element with content
	const testDiv = document.createElement("div");
	testDiv.className = "test";

	styleManager.attachPseudoElementsToElement(testDiv);
	const pseudoNode = pseudoElement<Element>(testDiv, "::before");
	expect(pseudoNode).not.toBeNull();
	expect(pseudoNode!.textContent).toBe("Hello World");
	expect(pseudoNameOf(pseudoNode!)).toBe("::before");
	expect(pseudoHostOf(pseudoNode!)).toBe(testDiv);

	// Test element with no content
	const emptyDiv = document.createElement("div");
	emptyDiv.className = "empty";

	styleManager.attachPseudoElementsToElement(emptyDiv);
	expect(pseudoElement(emptyDiv, "::before")).toBeNull();

	// Test element with content: normal
	const normalDiv = document.createElement("div");
	normalDiv.className = "normal";

	styleManager.attachPseudoElementsToElement(normalDiv);
	expect(pseudoElement(normalDiv, "::before")).toBeNull();

	// Test shouldCreatePseudoElement
	expect(styleManager.shouldCreatePseudoElement(testDiv, "::before")).toBe(
		true,
	);
	expect(styleManager.shouldCreatePseudoElement(emptyDiv, "::before")).toBe(
		false,
	);
	expect(styleManager.shouldCreatePseudoElement(normalDiv, "::before")).toBe(
		false,
	);
});
