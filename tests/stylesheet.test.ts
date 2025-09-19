import {test, expect} from "bun:test";
import {TermDOM} from "../src/termdom.js";
import {TestTerminal} from "./test-utils.js";

test("CSS specificity calculation", async () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
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

	// Get parsed rules to verify specificity ordering
	const styleManager = termdom.styleManager;
	const parsedRules = (styleManager as any).parsedRules;

	// Find specific rules to test specificity values
	const divRule = parsedRules.find((r: any) => r.selector === "div");
	const classRule = parsedRules.find((r: any) => r.selector === ".class");
	const multiClassRule = parsedRules.find(
		(r: any) => r.selector === ".class.other",
	);
	const idRule = parsedRules.find((r: any) => r.selector === "#id");
	const idClassRule = parsedRules.find((r: any) => r.selector === "#id.class");
	const divClassRule = parsedRules.find((r: any) => r.selector === "div.class");

	// Test specificity string format and ordering
	expect(divRule.specificity).toBe("000-000-001");
	expect(classRule.specificity).toBe("000-001-000");
	expect(multiClassRule.specificity).toBe("000-002-000");
	expect(idRule.specificity).toBe("001-000-000");
	expect(idClassRule.specificity).toBe("001-001-000");
	expect(divClassRule.specificity).toBe("000-001-001");

	// Test lexicographic ordering
	expect(divRule.specificity < classRule.specificity).toBe(true);
	expect(classRule.specificity < multiClassRule.specificity).toBe(true);
	expect(multiClassRule.specificity < idRule.specificity).toBe(true);
	expect(idRule.specificity < idClassRule.specificity).toBe(true);

	// Class + element should beat element alone, but lose to 2 classes
	expect(divRule.specificity < divClassRule.specificity).toBe(true);
	expect(divClassRule.specificity < multiClassRule.specificity).toBe(true);
});

test("CSS cascade resolution", async () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
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
	expect(computedStyle.getPropertyValue("color")).toBe("blue");

	// Inline style should override everything
	div.style.color = "yellow";
	computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("yellow");
});

test("Pseudo-element CSS support", async () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
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
	expect(beforeStyle.getPropertyValue("color")).toBe("blue");

	const afterStyle = termdom.window.getComputedStyle(div, "::after");
	expect(afterStyle.getPropertyValue("content")).toBe('" :After"');
	expect(afterStyle.getPropertyValue("color")).toBe("green");

	// Test list marker
	const li = document.createElement("li");
	document.body.appendChild(li);

	const markerStyle = termdom.window.getComputedStyle(li, "::marker");
	expect(markerStyle.getPropertyValue("color")).toBe("purple");
});

test("Pseudo-element specificity", async () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
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
	expect(beforeStyle.getPropertyValue("color")).toBe("blue");

	// Verify specificity strings for pseudo-elements
	const styleManager = termdom.styleManager;
	const parsedRules = (styleManager as any).parsedRules;

	const divPseudo = parsedRules.find(
		(r: any) => r.selector === "div" && r.pseudoElement === "::before",
	);
	const classPseudo = parsedRules.find(
		(r: any) => r.selector === ".class" && r.pseudoElement === "::before",
	);
	const idPseudo = parsedRules.find(
		(r: any) => r.selector === "#id" && r.pseudoElement === "::before",
	);

	expect(divPseudo.specificity).toBe("000-000-002");
	expect(classPseudo.specificity).toBe("000-001-001");
	expect(idPseudo.specificity).toBe("001-000-001");
});

test("StyleManager auto-refresh on DOM changes", async () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
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
	expect(computedStyle.getPropertyValue("color")).toBe("red");

	// Modify stylesheet content
	style.textContent = ".test { color: blue; }";

	// Wait for change detection
	await new Promise((resolve) => setTimeout(resolve, 10));

	// Should pick up modified styles
	computedStyle = termdom.window.getComputedStyle(div);
	expect(computedStyle.getPropertyValue("color")).toBe("blue");
});

test("StyleManager createPseudoElementNode", async () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const style = document.createElement("style");
	style.textContent = `
    .test::before { content: "Hello World"; }
    .empty::before { content: none; }
    .normal::before { content: normal; }
  `;
	document.head.appendChild(style);

	await new Promise((resolve) => setTimeout(resolve, 10));

	const styleManager = termdom.styleManager;

	// Test element with content
	const testDiv = document.createElement("div");
	testDiv.className = "test";

	const pseudoNode = styleManager.createPseudoElementNode(testDiv, "::before");
	expect(pseudoNode).not.toBeNull();
	expect(pseudoNode!.textContent).toBe("Hello World");
	expect((pseudoNode as any).pseudoMetadata.pseudoType).toBe("::before");
	expect((pseudoNode as any).pseudoMetadata.hostElement).toBe(testDiv);

	// Test element with no content
	const emptyDiv = document.createElement("div");
	emptyDiv.className = "empty";

	const emptyPseudo = styleManager.createPseudoElementNode(
		emptyDiv,
		"::before",
	);
	expect(emptyPseudo).toBeNull();

	// Test element with content: normal
	const normalDiv = document.createElement("div");
	normalDiv.className = "normal";

	const normalPseudo = styleManager.createPseudoElementNode(
		normalDiv,
		"::before",
	);
	expect(normalPseudo).toBeNull();

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
