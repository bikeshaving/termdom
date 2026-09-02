import {expect, test} from "@b9g/libuild/test";

import {
	ensurePseudoElement,
	flatParentElement,
	getPseudoHost,
	getPseudoName,
	pseudoElement,
} from "../src/internal/dom.js";
import {flowContent, flowNext} from "../src/internal/layout.js";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

/** A rule the head carries, so a div can be a list item like an li. */
const LIST_ITEM_RULE =
	"<style>li, [data-list-item] { display: list-item; }</style>";

/**
 * A document of this DOM, from markup, with a cascade over it that knows what
 * a list item is. The walkers here come from layout, which dissolves
 * `display: contents`. The pseudo-elements are the test's own, put straight in
 * their slots; a cascade would own them instead.
 */
// The engine walks the flow through flowContent and flowNext. These tests
// were written against a walker over the same tree, and this is that
// walker, stated in terms of the two functions.
function flowWalker(root: Node): {
	root: Node;
	currentNode: Node;
	nextNode(): Node | null;
	firstChild(): Node | null;
	nextSibling(): Node | null;
	parentNode(): Node | null;
} {
	const walker = {
		root,
		currentNode: root,
		nextNode(): Node | null {
			const next = flowNext(walker.currentNode, root, false);
			if (next !== null) {
				walker.currentNode = next;
			}
			return next;
		},
		firstChild(): Node | null {
			for (const child of flowContent(walker.currentNode)) {
				walker.currentNode = child;
				return child;
			}
			return null;
		},
		nextSibling(): Node | null {
			if (walker.currentNode === root) {
				return null;
			}
			const parent = flatParentElement(walker.currentNode);
			if (parent === null) {
				return null;
			}
			let seen = false;
			for (const child of flowContent(parent)) {
				if (seen) {
					walker.currentNode = child;
					return child;
				}
				seen = child === walker.currentNode;
			}
			return null;
		},
		parentNode(): Node | null {
			if (walker.currentNode === root) {
				return null;
			}
			const parent = flatParentElement(walker.currentNode);
			if (parent !== null) {
				walker.currentNode = parent;
			}
			return parent;
		},
	};
	return walker;
}

function documentWindow(html: string): TermDOM {
	return new TermDOM({
		html: html.replace("<body>", `${LIST_ITEM_RULE}<body>`),
		transport: new MockProcess().transport,
	});
}

/**
 * Give an element the pseudo-element node the cascade would give it, holding
 * the text a `content` declaration would put there. The slots are the engine's
 * internal door to pseudo-elements; no author API reaches them.
 */
function attachPseudo(host: Element, name: string, content: string): Element {
	const node = ensurePseudoElement<Element>(host, name);
	node.textContent = content;
	return node;
}

// Tests over a bare document, with no TermDOM behind it.

test("A bare document - flat-tree walker basic functionality", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const div = document.createElement("div");
	div.textContent = "Hello World";
	document.body.appendChild(div);
	const walker = flowWalker(document.body);

	expect(walker).toBeDefined();
	expect(walker.root).toBe(document.body);
	expect(walker.currentNode).toBe(document.body);

	const firstNode = walker.nextNode();
	expect(firstNode).toBe(div);

	const secondNode = walker.nextNode();
	expect(secondNode?.nodeName).toBe("#text");
	expect(secondNode?.textContent).toBe("Hello World");
});

test("A bare document - flat-tree walker pseudo-element traversal", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const div = document.createElement("div");
	div.textContent = "Main content";
	div.className = "with-pseudo";
	document.body.appendChild(div);

	// Set up pseudo-elements using symbols
	attachPseudo(div, "::before", "Before: ");
	attachPseudo(div, "::after", " :After");

	const walker = flowWalker(document.body);

	const nodes: Array<{
		name: string;
		content: string;
		isPseudo: boolean;
		pseudoType?: string;
	}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		const metadata = getPseudoName(node);
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			isPseudo: getPseudoHost(node) !== null,
			pseudoType: metadata ?? undefined,
		});
		node = walker.nextNode();
	}

	// Should find the div
	expect(nodes.some((n) => n.name === "DIV")).toBe(true);

	// Should find main content
	expect(nodes.some((n) => n.content === "Main content" && !n.isPseudo)).toBe(
		true,
	);

	// Should find pseudo-elements
	expect(
		nodes.some(
			(n) =>
				n.content === "Before: " && n.isPseudo && n.pseudoType === "::before",
		),
	).toBe(true);
	expect(
		nodes.some(
			(n) =>
				n.content === " :After" && n.isPseudo && n.pseudoType === "::after",
		),
	).toBe(true);
});

test("A bare document - flat-tree walker shadow DOM traversal", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const host = document.createElement("div");
	host.id = "shadow-host";
	document.body.appendChild(host);

	const shadowRoot = host.attachShadow({mode: "open"});
	const shadowDiv = document.createElement("div");
	shadowDiv.textContent = "Shadow content";
	shadowDiv.className = "shadow-element";
	shadowRoot.appendChild(shadowDiv);
	const walker = flowWalker(document.body);

	const nodes: Array<{name: string; content: string; className?: string}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			className: (node as any).className || undefined,
		});
		node = walker.nextNode();
	}

	// Should find the host element
	expect(nodes.some((n) => n.name === "DIV" && !n.className)).toBe(true);

	// Should find shadow content
	expect(nodes.some((n) => n.content === "Shadow content")).toBe(true);

	// Should find the shadow element
	expect(nodes.some((n) => n.className === "shadow-element")).toBe(true);
});

test("A bare document - flat-tree walker slot content traversal", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const host = document.createElement("div");
	host.innerHTML = "<span class=\"light-content\">Light DOM content</span>";
	document.body.appendChild(host);

	const shadowRoot = host.attachShadow({mode: "open"});
	const slot = document.createElement("slot");
	shadowRoot.appendChild(slot);
	const walker = flowWalker(document.body);

	const nodes: Array<{name: string; content: string; className?: string}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			className: (node as any).className || undefined,
		});
		node = walker.nextNode();
	}

	// Should find the host element
	expect(nodes.some((n) => n.name === "DIV" && !n.className)).toBe(true);

	// A slot is display: contents, so it is never stopped on; its assigned
	// content is walked in its place.
	expect(nodes.some((n) => n.name === "SLOT")).toBe(false);
	expect(nodes.some((n) => n.className === "light-content")).toBe(true);
	expect(nodes.some((n) => n.content === "Light DOM content")).toBe(true);
});

test("A bare document - flat-tree walker utility functions", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const div = document.createElement("div");
	document.body.appendChild(div);

	// Test pseudo-element storage
	const beforeNode = attachPseudo(div, "::before", "Before");
	expect(pseudoElement<Element>(div, "::before")).toBe(beforeNode);
	expect(pseudoElement<Element>(div, "::after")).toBe(null);

	// Test pseudo node creation
	expect(getPseudoName(beforeNode)).toBe("::before");
	expect(getPseudoHost(beforeNode)).toBe(div);
	expect(beforeNode.textContent).toBe("Before");
	expect(getPseudoHost(beforeNode) !== null).toBe(true);
	expect(getPseudoHost(div) !== null).toBe(false);
});

test("A bare document - flat-tree walker ::marker pseudo-element traversal", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create list structure
	const ul = document.createElement("ul");
	const li = document.createElement("li");
	li.textContent = "List item content";
	ul.appendChild(li);
	document.body.appendChild(ul);

	// Set up all three pseudo-elements for proper order testing
	attachPseudo(li, "::marker", "• ");
	attachPseudo(li, "::before", "[");
	attachPseudo(li, "::after", "]");

	const walker = flowWalker(ul);

	const nodes: Array<{
		name: string;
		content: string;
		isPseudo: boolean;
		pseudoType?: string;
	}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		const metadata = getPseudoName(node);
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			isPseudo: getPseudoHost(node) !== null,
			pseudoType: metadata ?? undefined,
		});
		node = walker.nextNode();
	}

	// Should find the list item
	expect(nodes.some((n) => n.name === "LI" && !n.isPseudo)).toBe(true);

	// Should find all pseudo-elements in correct order
	const pseudoNodes = nodes.filter((n) => n.isPseudo);
	expect(pseudoNodes).toHaveLength(3);

	// Verify pseudo-element order: ::marker, ::before, ::after
	expect(pseudoNodes[0].pseudoType).toBe("::marker");
	expect(pseudoNodes[0].content).toBe("• ");

	expect(pseudoNodes[1].pseudoType).toBe("::before");
	expect(pseudoNodes[1].content).toBe("[");

	expect(pseudoNodes[2].pseudoType).toBe("::after");
	expect(pseudoNodes[2].content).toBe("]");

	// Verify document order in the full nodes array
	const markerIndex = nodes.findIndex((n) => n.pseudoType === "::marker");
	const beforeIndex = nodes.findIndex((n) => n.pseudoType === "::before");
	const afterIndex = nodes.findIndex((n) => n.pseudoType === "::after");
	const contentTextIndex = nodes.findIndex(
		(n) =>
			!n.isPseudo && n.name === "#text" && n.content === "List item content",
	);

	expect(markerIndex).toBeLessThan(beforeIndex);
	expect(beforeIndex).toBeLessThan(contentTextIndex);
	expect(contentTextIndex).toBeLessThan(afterIndex);
});

test("A bare document - flat-tree walker nested shadow roots", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create outer custom element with shadow root
	const outerHost = document.createElement("outer-element");
	outerHost.className = "outer-host";
	document.body.appendChild(outerHost);

	const outerShadowRoot = outerHost.attachShadow({mode: "open"});

	// An inner custom element inside the outer shadow, hosting a tree of its own.
	const innerHost = document.createElement("inner-element");
	innerHost.className = "inner-host";
	innerHost.textContent = "Inner host content";
	outerShadowRoot.appendChild(innerHost);

	const innerShadowRoot = innerHost.attachShadow({mode: "open"});
	const deepContent = document.createElement("div");
	deepContent.className = "deep-content";
	deepContent.textContent = "Deep shadow content";
	innerShadowRoot.appendChild(deepContent);
	const walker = flowWalker(document.body);

	const nodes: Array<{name: string; className?: string; content: string}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 15) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || "",
		});
		node = walker.nextNode();
	}

	// Should find outer host
	expect(nodes.some((n) => n.className === "outer-host")).toBe(true);

	// Should find inner host (in outer shadow)
	expect(nodes.some((n) => n.className === "inner-host")).toBe(true);

	// Should find deep content (in inner shadow)
	expect(nodes.some((n) => n.className === "deep-content")).toBe(true);
	expect(nodes.some((n) => n.content === "Deep shadow content")).toBe(true);

	// Verify nested traversal order
	const outerIndex = nodes.findIndex((n) => n.className === "outer-host");
	const innerIndex = nodes.findIndex((n) => n.className === "inner-host");
	const deepIndex = nodes.findIndex((n) => n.className === "deep-content");

	expect(outerIndex).toBeLessThan(innerIndex);
	expect(innerIndex).toBeLessThan(deepIndex);
});

test("A bare document - flat-tree walker shadow roots in slot assigned nodes", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create host element with light DOM content that has shadow roots
	const host = document.createElement("div");
	host.className = "slot-host";

	// Create assigned element with its own shadow root
	const assignedElement = document.createElement("custom-element");
	assignedElement.className = "assigned-with-shadow";
	assignedElement.setAttribute("slot", "content");
	assignedElement.textContent = "Assigned element content";
	host.appendChild(assignedElement);

	const assignedShadowRoot = assignedElement.attachShadow({mode: "open"});
	const shadowContent = document.createElement("div");
	shadowContent.className = "shadow-in-assigned";
	shadowContent.textContent = "Shadow content in assigned node";
	assignedShadowRoot.appendChild(shadowContent);

	document.body.appendChild(host);

	const hostShadowRoot = host.attachShadow({mode: "open"});
	const slot = document.createElement("slot");
	slot.name = "content";
	hostShadowRoot.appendChild(slot);
	const walker = flowWalker(document.body);

	const nodes: Array<{name: string; className?: string; content: string}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 15) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || "",
		});
		node = walker.nextNode();
	}

	// Should find the slot host
	expect(nodes.some((n) => n.className === "slot-host")).toBe(true);

	// The slot itself is display: contents and never stopped on.
	expect(nodes.some((n) => n.name === "SLOT")).toBe(false);

	// Should find the assigned element
	expect(nodes.some((n) => n.className === "assigned-with-shadow")).toBe(true);

	// Should find the shadow content within the assigned element
	expect(nodes.some((n) => n.className === "shadow-in-assigned")).toBe(true);
	expect(
		nodes.some((n) => n.content === "Shadow content in assigned node"),
	).toBe(true);

	// Verify traversal order: host → assigned element → assigned element's shadow content
	const hostIndex = nodes.findIndex((n) => n.className === "slot-host");
	const assignedIndex = nodes.findIndex(
		(n) => n.className === "assigned-with-shadow",
	);
	const shadowInAssignedIndex = nodes.findIndex(
		(n) => n.className === "shadow-in-assigned",
	);

	expect(hostIndex).toBeLessThan(assignedIndex);
	expect(assignedIndex).toBeLessThan(shadowInAssignedIndex);
});

test("A bare document - flat-tree walker complex nested scenario with pseudo-elements", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create a complex scenario:
	// List item with pseudo-elements → shadow root → slot with assigned content → assigned content has shadow root
	const li = document.createElement("div");
	li.className = "complex-list-item";
	li.setAttribute("data-list-item", "");
	li.textContent = "List item";

	// Add pseudo-elements to list item
	attachPseudo(li, "::marker", "• ");
	attachPseudo(li, "::before", "[");
	attachPseudo(li, "::after", "]");

	// The assigned content carries a shadow tree of its own.
	const assignedContent = document.createElement("div");
	assignedContent.className = "assigned-content";
	assignedContent.setAttribute("slot", "content");
	assignedContent.textContent = "Assigned content";
	li.appendChild(assignedContent);

	const assignedShadowRoot = assignedContent.attachShadow({mode: "open"});
	const deepShadowContent = document.createElement("span");
	deepShadowContent.className = "deep-shadow";
	deepShadowContent.textContent = "Deep shadow content";
	assignedShadowRoot.appendChild(deepShadowContent);

	const liShadowRoot = li.attachShadow({mode: "open"});
	const slot = document.createElement("slot");
	slot.name = "content";
	liShadowRoot.appendChild(slot);

	document.body.appendChild(li);
	const walker = flowWalker(document.body);

	const nodes: Array<{
		name: string;
		className?: string;
		content: string;
		isPseudo: boolean;
		pseudoType?: string;
	}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 20) {
		const metadata = getPseudoName(node);
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || "",
			isPseudo: getPseudoHost(node) !== null,
			pseudoType: metadata ?? undefined,
		});
		node = walker.nextNode();
	}

	// Should find all components in correct order
	expect(nodes.some((n) => n.className === "complex-list-item")).toBe(true);
	expect(nodes.some((n) => n.pseudoType === "::marker")).toBe(true);
	expect(nodes.some((n) => n.pseudoType === "::before")).toBe(true);
	expect(nodes.some((n) => n.pseudoType === "::after")).toBe(true);
	expect(nodes.some((n) => n.name === "SLOT")).toBe(false);
	expect(nodes.some((n) => n.className === "assigned-content")).toBe(true);
	expect(nodes.some((n) => n.className === "deep-shadow")).toBe(true);

	// Verify complex traversal order
	const liIndex = nodes.findIndex((n) => n.className === "complex-list-item");
	const markerIndex = nodes.findIndex((n) => n.pseudoType === "::marker");
	const beforeIndex = nodes.findIndex((n) => n.pseudoType === "::before");
	const assignedIndex = nodes.findIndex(
		(n) => n.className === "assigned-content",
	);
	const deepShadowIndex = nodes.findIndex((n) => n.className === "deep-shadow");
	const afterIndex = nodes.findIndex((n) => n.pseudoType === "::after");

	// Verify the complex order: LI → ::marker → ::before → assigned content → deep shadow → ::after
	expect(liIndex).toBeLessThan(markerIndex);
	expect(markerIndex).toBeLessThan(beforeIndex);
	expect(beforeIndex).toBeLessThan(assignedIndex);
	expect(assignedIndex).toBeLessThan(deepShadowIndex);
	expect(deepShadowIndex).toBeLessThan(afterIndex);
});

// TermDOM Integration Tests

test("TermDOM - flat-tree walker basic functionality", () => {
	const {document} = documentWindow("<!DOCTYPE html><body></body>");

	const div = document.createElement("div");
	div.textContent = "Hello World";
	document.body.appendChild(div);

	const expandedWalker = flowWalker(document.body);

	expect(expandedWalker).toBeDefined();
	expect(expandedWalker.root).toBe(document.body);
	expect(expandedWalker.currentNode).toBe(document.body);

	const firstNode = expandedWalker.nextNode();
	expect(firstNode).toBe(div);

	const secondNode = expandedWalker.nextNode();
	expect(secondNode?.nodeName).toBe("#text");
	expect(secondNode?.textContent).toBe("Hello World");
});

test("TermDOM - flat-tree walker with shadow DOM", () => {
	const {document} = documentWindow("<!DOCTYPE html><body></body>");

	// Create a custom element with shadow DOM
	class TestElement extends (document.defaultView as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const wrapper = document.createElement("div");
			wrapper.textContent = "Shadow content";
			wrapper.className = "shadow-wrapper";

			shadow.appendChild(wrapper);
		}
	}

	(document.defaultView as any).customElements.define(
		"test-element",
		TestElement as any,
	);

	const testEl = document.createElement("test-element") as any;
	testEl.textContent = "Light content";
	document.body.appendChild(testEl);
	const walker = flowWalker(document.body);

	const nodes: Array<{name: string; content: string; className?: string}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			className: (node as any).className || undefined,
		});
		node = walker.nextNode();
	}

	// Should find the test-element
	expect(nodes.some((n) => n.name === "TEST-ELEMENT")).toBe(true);

	// Should find shadow content
	expect(nodes.some((n) => n.content === "Shadow content")).toBe(true);

	// Should find the shadow wrapper element
	expect(nodes.some((n) => n.className === "shadow-wrapper")).toBe(true);
});

test("TermDOM - flat-tree walker basic traversal", () => {
	const {document} = documentWindow("<!DOCTYPE html><body></body>");

	const div = document.createElement("div");
	div.textContent = "Hello";
	document.body.appendChild(div);

	// Test basic walker creation and traversal
	const walker = flowWalker(document.body);

	expect(walker.root).toBe(document.body);
	expect(walker.currentNode).toBe(document.body);

	// Test basic traversal
	const nextNode = walker.nextNode();
	expect(nextNode).toBe(div);
});

test("flat-tree walker flattens named slots into composed order", () => {
	// Native shadow DOM end-to-end: the DOM performs the real slot assignment,
	// and the walker's flat-tree layer dissolves the slots (UA default
	// `slot { display: contents }`) -- projected content appears at each
	// slot's position, unassigned-slot fallback stays hidden, and no SLOT
	// element ever surfaces as a box of its own.
	// Slot dissolution is the UA sheet's `slot { display: contents }`, so
	// this walk needs a document with the engine's cascade behind it.
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	const host = document.createElement("div");
	host.innerHTML =
		'<span slot="header" class="header-1">Header 1</span>' +
		'<span slot="header" class="header-2">Header 2</span>' +
		'<p slot="content" class="content-1">Content 1</p>' +
		'<span class="default-content">Default content</span>';
	const shadowRoot = host.attachShadow({mode: "open"});
	shadowRoot.innerHTML =
		'<div class="chrome-header"><slot name="header"></slot></div>' +
		'<div class="chrome-content"><slot name="content"></slot></div>' +
		"<slot></slot>";
	document.body.appendChild(host);
	const walker = flowWalker(host);
	const classNames: string[] = [];
	let sawSlot = false;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType === node.ELEMENT_NODE) {
			if (node.nodeName === "SLOT") {
				sawSlot = true;
			}
			const className = (node as Element).className;
			if (className) {
				classNames.push(className);
			}
		}
	}

	expect(sawSlot).toBe(false);
	expect(classNames).toEqual([
		"chrome-header",
		"header-1",
		"header-2",
		"chrome-content",
		"content-1",
		"default-content",
	]);
});

test("A bare document - flat-tree walker respects root boundary", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create DOM structure: body → div → p → span
	const div = document.createElement("div");
	div.className = "container";

	const p = document.createElement("p");
	p.className = "paragraph";

	const span = document.createElement("span");
	span.className = "span";
	span.textContent = "Span text";

	p.appendChild(span);
	div.appendChild(p);
	document.body.appendChild(div);

	// Walker rooted at paragraph (not body or div)
	const walker = flowWalker(p);

	const nodes: Array<{name: string; className?: string; content: string}> = [];
	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || "",
		});
		node = walker.nextNode();
	}

	// Should find span (within root) - note: nextNode() doesn't return the root itself
	expect(nodes.some((n) => n.className === "span")).toBe(true);

	// Should NOT find container (outside root) or body
	expect(nodes.some((n) => n.className === "container")).toBe(false);
	expect(nodes.some((n) => n.name === "BODY")).toBe(false);

	// Should not traverse beyond root
	expect(nodes.length).toBeLessThanOrEqual(3); // P, SPAN, #text
});

test("A bare document - flat-tree walker parentNode respects root boundary", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create: body → div → p → span
	const div = document.createElement("div");
	div.className = "container";

	const p = document.createElement("p");
	p.className = "paragraph";

	const span = document.createElement("span");
	span.className = "span";
	span.textContent = "content";

	p.appendChild(span);
	div.appendChild(p);
	document.body.appendChild(div);

	// Walker rooted at paragraph
	const walker = flowWalker(p);

	// Navigate to span
	walker.nextNode(); // span
	expect(walker.currentNode.nodeName).toBe("SPAN");

	// parentNode() should return paragraph
	const parent1 = walker.parentNode();
	expect(parent1?.nodeName).toBe("P");
	expect((parent1 as any)?.className).toBe("paragraph");

	// Another parentNode() should return null (can't go beyond root)
	const parent2 = walker.parentNode();
	expect(parent2).toBe(null);

	// Walker should still be at the root
	expect(walker.currentNode.nodeName).toBe("P");
	expect((walker.currentNode as any).className).toBe("paragraph");
});

test("flat-tree walker reaches ::after in the layout engine's pattern", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create structure that matches our failing test: div.quote with ::before and ::after
	const quote = document.createElement("div");
	quote.className = "quote";
	quote.textContent = "Hello World";
	document.body.appendChild(quote);

	// Set up pseudo-elements using Cascade pattern
	attachPseudo(quote, "::before", '"');
	attachPseudo(quote, "::after", '"');

	// Create walker that matches layout engine usage: start from quote element
	const walker = flowWalker(quote);

	// Simulate layout engine traversal: walker.firstChild() then walker.nextSibling()
	const foundNodes: Array<{
		type: string;
		content: string;
		pseudoType?: string;
	}> = [];

	let child = walker.firstChild();
	while (child) {
		const pseudoMeta = getPseudoName(child);
		foundNodes.push({
			type: child.nodeType === child.TEXT_NODE ? "TEXT" : "ELEMENT",
			content: child.textContent || "",
			pseudoType: pseudoMeta ?? undefined,
		});
		child = walker.nextSibling();
	}

	// Should find both ::before and ::after
	expect(foundNodes.some((n) => n.pseudoType === "::before")).toBe(true);
	expect(foundNodes.some((n) => n.pseudoType === "::after")).toBe(true);

	// Should find them in correct order: ::before, regular text, ::after
	const beforeIndex = foundNodes.findIndex((n) => n.pseudoType === "::before");
	const afterIndex = foundNodes.findIndex((n) => n.pseudoType === "::after");
	const textIndex = foundNodes.findIndex(
		(n) => n.content === "Hello World" && !n.pseudoType,
	);

	expect(beforeIndex).toBeLessThan(textIndex);
	expect(textIndex).toBeLessThan(afterIndex);
});

test("A bare document - flat-tree walker manual currentNode setting respects root", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create: body → div → p
	const div = document.createElement("div");
	div.className = "container";

	const p = document.createElement("p");
	p.className = "paragraph";
	p.textContent = "content";

	div.appendChild(p);
	document.body.appendChild(div);

	// Walker rooted at div
	const walker = flowWalker(div);

	// Try to manually set currentNode to body (outside root)
	walker.currentNode = document.body;

	// nextNode() should still respect the root boundary
	const nextNode = walker.nextNode();

	// Should not traverse outside the div subtree
	// Since body is outside root, traversal should behave correctly
	expect(nextNode).not.toBe(document.body);

	// Reset to valid position
	walker.currentNode = div;
	const validNext = walker.nextNode();
	expect(validNext?.nodeName).toBe("P");
});

// CSS-specific tests for ::marker pseudo-elements

test("::marker exists exactly where display is list-item", async () => {
	const terminal = new MockProcess({rows: 10, cols: 60});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document, window} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		.marker-test::marker { content: '★ '; }
		.list-item { display: list-item; list-style-position: inside; }
		li { list-style-position: inside; }
	`;
	document.head.appendChild(style);

	const li = document.createElement("li");
	li.className = "marker-test";
	li.textContent = "List item";
	document.body.appendChild(li);

	const divListItem = document.createElement("div");
	divListItem.className = "marker-test list-item";
	divListItem.textContent = "Div as list item";
	document.body.appendChild(divListItem);

	const regularDiv = document.createElement("div");
	regularDiv.className = "marker-test";
	regularDiv.textContent = "Regular div";
	document.body.appendChild(regularDiv);

	await nextFrame(termdom);

	expect(window.getComputedStyle(li, "::marker").getPropertyValue("content"))
		.toBe("\"★ \"");
	expect(
		window
			.getComputedStyle(divListItem, "::marker")
			.getPropertyValue("content"),
	).toBe("\"★ \"");
	expect(window.getComputedStyle(li).getPropertyValue("display")).toBe(
		"list-item",
	);
	expect(window.getComputedStyle(regularDiv).getPropertyValue("display")).toBe(
		"block",
	);

	// The screen is the arbiter of which hosts painted a marker.
	const output = terminal.getPlainText();
	expect(output).toContain("★ List item");
	expect(output).toContain("★ Div as list item");
	expect(output).toContain("Regular div");
	expect(output).not.toContain("★ Regular div");
	termdom.dispose();
});

test("::marker paints before ::before, content, then ::after", async () => {
	const terminal = new MockProcess({rows: 8, cols: 60});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document, window} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		.test::marker { content: '★ '; }
		.test::before { content: '['; }
		.test::after { content: ']'; }
		.list-item { display: list-item; list-style-position: inside; }
	`;
	document.head.appendChild(style);

	const div = document.createElement("div");
	div.className = "test list-item";
	div.textContent = "Content";
	document.body.appendChild(div);

	await nextFrame(termdom);

	expect(window.getComputedStyle(div, "::marker").getPropertyValue("content"))
		.toBe("\"★ \"");
	expect(window.getComputedStyle(div, "::before").getPropertyValue("content"))
		.toBe("\"[\"");
	expect(window.getComputedStyle(div, "::after").getPropertyValue("content"))
		.toBe("\"]\"");

	// CSS order, ::marker -> ::before -> content -> ::after, as one line.
	expect(terminal.getPlainText()).toContain("★ [Content]");
	termdom.dispose();
});

test("a container paints markers only for its list-items", async () => {
	const terminal = new MockProcess({rows: 10, cols: 60});
	const termdom = new TermDOM({transport: terminal.transport});
	const {document, window} = termdom;

	const style = document.createElement("style");
	style.textContent = `
		.test::marker { content: '• '; }
		.list-item { display: list-item; list-style-position: inside; }
		li { list-style-position: inside; }
		.block { display: block; }
	`;
	document.head.appendChild(style);

	const li = document.createElement("li");
	li.className = "test";
	li.textContent = "LI";
	const divList = document.createElement("div");
	divList.className = "test list-item";
	divList.textContent = "DIV-LIST";
	const divBlock = document.createElement("div");
	divBlock.className = "test block";
	divBlock.textContent = "DIV-BLOCK";

	const container = document.createElement("div");
	container.append(li, divList, divBlock);
	document.body.appendChild(container);

	await nextFrame(termdom);

	expect(window.getComputedStyle(li).getPropertyValue("display")).toBe(
		"list-item",
	);
	expect(window.getComputedStyle(divList).getPropertyValue("display")).toBe(
		"list-item",
	);
	expect(window.getComputedStyle(divBlock).getPropertyValue("display")).toBe(
		"block",
	);

	const output = terminal.getPlainText();
	expect(output).toContain("• LI");
	expect(output).toContain("• DIV-LIST");
	expect(output).toContain("DIV-BLOCK");
	expect(output).not.toContain("• DIV-BLOCK");
	termdom.dispose();
});

test("TermDOM - ::marker rendering test", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({transport: terminal.transport});
	const {document} = termdom;

	// Add CSS with ::marker and other pseudo-elements
	const style = document.createElement("style");
	style.textContent = `
		.test::marker { content: '▶ '; }
		.test::before { content: '['; }
		.test::after { content: ']'; }
		.list-item { display: list-item; list-style-position: inside; }
	`;
	document.head.appendChild(style);

	// Create test element
	const div = document.createElement("div");
	div.className = "test list-item";
	div.textContent = "Content";
	document.body.appendChild(div);

	await nextFrame(termdom);

	// Check terminal output contains all pseudo-element content in correct order
	const output = terminal.getPlainText();
	expect(output).toContain("▶ [Content]");

	// Verify the exact order appears in output
	const expectedPattern = "▶ [Content]";
	expect(output.includes(expectedPattern)).toBe(true);
});

test("A bare document - nextSibling/previousSibling at the root return null, per spec", () => {
	// The TreeWalker spec's traverse-siblings algorithm returns null when the
	// current node is the root: a walker never visits its root's siblings.
	// Without this guard, a walker rooted at an element whose subtree was
	// exhausted escaped into the root's DOM siblings -- concretely, an
	// inline-block flex item (its own inline-run head) "skipped its children"
	// via nextSibling() and swallowed the NEXT flex item's text into its own
	// measurement, misplacing every later sibling on the main axis.
	const dom = documentWindow(
		"<!DOCTYPE html><html><body><span id='a'>x</span><span id='b'>y</span></body></html>",
	);
	const window = dom.window;
	const a = window.document.getElementById("a")!;
	const walker = flowWalker(a);
	expect(walker.nextSibling()).toBe(null);
	expect(walker.currentNode).toBe(a); // unmoved

	// A child of the root still traverses siblings normally.
	walker.firstChild();
	expect(walker.nextSibling()).toBe(null); // lone text child, no sibling
});

test("flat-tree walker skips comments rather than halting on them", () => {
	// A rejected node (a comment) must not hide the accepted siblings behind
	// it: the traversal skips it, FILTER_SKIP as in a DOM TreeWalker. A
	// leading comment used to make firstChild() return null, collapsing the
	// whole container to nothing -- a Markdown file starting with an HTML
	// comment rendered blank.
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const names = (root: Node): string[] => {
		const walker = flowWalker(root);
		const out: string[] = [];
		for (let n = walker.firstChild(); n; n = walker.nextSibling()) {
			out.push(
				n.nodeType === n.ELEMENT_NODE
					? (n as Element).tagName
					: (n as Text).data,
			);
		}
		return out;
	};

	// Leading comment: the element behind it is still the first child.
	document.body.innerHTML = "<!-- c --><h1>A</h1>";
	expect(names(document.body)).toEqual(["H1"]);

	// Comment between two blocks: both are reached.
	document.body.innerHTML = "<h1>A</h1><!-- c --><h2>B</h2>";
	expect(names(document.body)).toEqual(["H1", "H2"]);

	// Trailing comment: no phantom node after the element.
	document.body.innerHTML = "<h1>A</h1><!-- c -->";
	expect(names(document.body)).toEqual(["H1"]);

	// A run of comments is skipped as one.
	document.body.innerHTML = "<!--x--><!--y--><h1>A</h1><!--z--><p>B</p>";
	expect(names(document.body)).toEqual(["H1", "P"]);

	// Comments interleaved with text and elements in an inline run.
	document.body.innerHTML = "<p>a<!-- c -->b</p>";
	const p = document.querySelector("p")!;
	expect(names(p)).toEqual(["a", "b"]);

	// A container whose only children are comments has no accepted children.
	document.body.innerHTML = "<div><!--a--><!--b--></div>";
	expect(names(document.querySelector("div")!)).toEqual([]);
});

test("the flat tree is not something a page can ask createTreeWalker for", () => {
	const dom = documentWindow("<!DOCTYPE html><html><body></body></html>");
	const document = dom.window.document;

	// The same element two ways: a light child, and a shadow child that only
	// the flat tree reaches.
	const host = document.createElement("div");
	host.innerHTML = "<span>light</span>";
	host.attachShadow({mode: "open"}).innerHTML = "<b>shadow</b>";
	document.body.appendChild(host);

	const names = (walker: {nextNode(): unknown}): string[] => {
		const seen: string[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			seen.push((n as Node).nodeName);
		}
		return seen;
	};

	// whatToShow defaults to every bit there is, the private one included. It
	// is masked off at this door, so the default walk stays on the node tree.
	expect(names(document.createTreeWalker(host) as never)).toEqual([
		"SPAN",
		"#text",
	]);

	// And a caller naming the bit outright gets it stripped rather than
	// honoured: what is left asks for no node type at all.
	expect(names(document.createTreeWalker(host, 0x1000) as never)).toEqual([]);

	// The engine's own walk does reach the shadow child, which is the
	// difference the bit makes.
	expect(names(flowWalker(host) as never)).toContain("B");
});

test("scrollingElement is the root outside quirks mode, and the body inside it", () => {
	// CSSOM View §7: the element that scrolls the viewport depends on the
	// document's mode, which a missing doctype decides.
	const standards = documentWindow(
		"<!DOCTYPE html><html><body><p>x</p></body></html>",
	);
	expect(standards.window.document.compatMode).toBe("CSS1Compat");
	expect(standards.window.document.scrollingElement).toBe(
		standards.window.document.documentElement,
	);

	const quirks = documentWindow("<html><body><p>x</p></body></html>");
	expect(quirks.window.document.compatMode).toBe("BackCompat");
	expect(quirks.window.document.scrollingElement).toBe(
		quirks.window.document.body,
	);
});
