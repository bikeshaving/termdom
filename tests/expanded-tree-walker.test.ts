import {test, expect} from "bun:test";
import {JSDOM} from "jsdom";
import {TermDOM} from "../src/termdom.js";
import {MockProcess} from "./test-utils.js";
import {
	createExpandedTreeWalker,
	NodeFilterExtended,
	setShadowRoot,
	setPseudoElement,
	createPseudoNode,
	isPseudoNode,
	getPseudoMetadata,
	getShadowRoot,
	getPseudoElement,
} from "../src/composition.js";

// Pure JSDOM Tests (no TermDOM dependency)

test("Pure JSDOM - ExpandedTreeWalker basic functionality", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const div = document.createElement("div");
	div.textContent = "Hello World";
	document.body.appendChild(div);

	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xffffffff | NodeFilterExtended.SHOW_SHADOW_DOM,
		null,
	);

	expect(walker).toBeDefined();
	expect(walker.root).toBe(document.body);
	expect(walker.currentNode).toBe(document.body);

	const firstNode = walker.nextNode();
	expect(firstNode).toBe(div);

	const secondNode = walker.nextNode();
	expect(secondNode?.nodeName).toBe("#text");
	expect(secondNode?.textContent).toBe("Hello World");
});

test("Pure JSDOM - ExpandedTreeWalker pseudo-element traversal", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const div = document.createElement("div");
	div.textContent = "Main content";
	div.className = "with-pseudo";
	document.body.appendChild(div);

	// Set up pseudo-elements using symbols
	const beforeNode = createPseudoNode(div, "::before", "Before: ");
	const afterNode = createPseudoNode(div, "::after", " :After");

	setPseudoElement(div, "::before", beforeNode);
	setPseudoElement(div, "::after", afterNode);

	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xffffffff | NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
		null,
	);

	const nodes: Array<{
		name: string;
		content: string;
		isPseudo: boolean;
		pseudoType?: string;
	}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		const metadata = getPseudoMetadata(node);
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			isPseudo: isPseudoNode(node),
			pseudoType: metadata?.pseudoType,
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

test("Pure JSDOM - ExpandedTreeWalker shadow DOM traversal", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const host = document.createElement("div");
	host.id = "shadow-host";
	document.body.appendChild(host);

	// Create shadow root mock
	const shadowRoot = {
		mode: "open",
		host: host,
		firstChild: null,
		lastChild: null,
		childNodes: [],
		nodeType: 11,
		nodeName: "#document-fragment",
	} as any;

	// Create shadow content
	const shadowDiv = document.createElement("div");
	shadowDiv.textContent = "Shadow content";
	shadowDiv.className = "shadow-element";

	// Set up shadow DOM structure
	shadowRoot.firstChild = shadowDiv;
	shadowRoot.lastChild = shadowDiv;
	shadowRoot.childNodes = [shadowDiv];
	Object.defineProperty(shadowDiv, "parentNode", {
		value: shadowRoot,
		writable: true,
		configurable: true,
	});

	setShadowRoot(host, shadowRoot);

	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xffffffff | NodeFilterExtended.SHOW_SHADOW_DOM,
		null,
	);

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

test("Pure JSDOM - ExpandedTreeWalker slot content traversal", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const host = document.createElement("div");
	host.innerHTML = `<span class="light-content">Light DOM content</span>`;
	document.body.appendChild(host);

	// Create shadow root with slot
	const shadowRoot = {
		mode: "open",
		host: host,
		firstChild: null,
		lastChild: null,
		childNodes: [],
		nodeType: 11,
	} as any;

	const slot = document.createElement("slot");
	slot.name = "content";

	// Mock assignedNodes for the slot
	const lightNodes = Array.from(host.childNodes);
	Object.defineProperty(slot, "assignedNodes", {
		value: () => lightNodes,
		writable: true,
		configurable: true,
	});

	shadowRoot.firstChild = slot;
	shadowRoot.lastChild = slot;
	shadowRoot.childNodes = [slot];
	Object.defineProperty(slot, "parentNode", {
		value: shadowRoot,
		writable: true,
		configurable: true,
	});

	setShadowRoot(host, shadowRoot);

	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xffffffff |
			NodeFilterExtended.SHOW_SHADOW_DOM |
			NodeFilterExtended.SHOW_SLOTS,
		null,
	);

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

	// Should find the slot element
	expect(nodes.some((n) => n.name === "SLOT")).toBe(true);

	// Should find slotted content
	expect(nodes.some((n) => n.className === "light-content")).toBe(true);
	expect(nodes.some((n) => n.content === "Light DOM content")).toBe(true);
});

test("Pure JSDOM - ExpandedTreeWalker utility functions", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	const div = document.createElement("div");
	document.body.appendChild(div);

	// Test shadow root storage
	const shadowRoot = {mode: "open", host: div} as any;
	setShadowRoot(div, shadowRoot);
	expect(getShadowRoot(div)).toBe(shadowRoot);

	// Test pseudo-element storage
	const beforeNode = createPseudoNode(div, "::before", "Before");
	setPseudoElement(div, "::before", beforeNode);
	expect(getPseudoElement(div, "::before")).toBe(beforeNode);
	expect(getPseudoElement(div, "::after")).toBe(null);

	// Test pseudo node creation
	const metadata = getPseudoMetadata(beforeNode);
	expect(metadata?.pseudoType).toBe("::before");
	expect(metadata?.hostElement).toBe(div);
	expect(beforeNode.textContent).toBe("Before");
	expect(isPseudoNode(beforeNode)).toBe(true);
	expect(isPseudoNode(div)).toBe(false);
});

test("Pure JSDOM - ExpandedTreeWalker ::marker pseudo-element traversal", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create list structure
	const ul = document.createElement("ul");
	const li = document.createElement("li");
	li.textContent = "List item content";
	ul.appendChild(li);
	document.body.appendChild(ul);

	// Set up all three pseudo-elements for proper order testing
	const markerNode = createPseudoNode(li, "::marker", "• ");
	const beforeNode = createPseudoNode(li, "::before", "[");
	const afterNode = createPseudoNode(li, "::after", "]");

	setPseudoElement(li, "::marker", markerNode);
	setPseudoElement(li, "::before", beforeNode);
	setPseudoElement(li, "::after", afterNode);

	const walker = createExpandedTreeWalker(
		window as any,
		ul,
		0xffffffff | NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
		null,
	);

	const nodes: Array<{
		name: string;
		content: string;
		isPseudo: boolean;
		pseudoType?: string;
	}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		const metadata = getPseudoMetadata(node);
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			isPseudo: isPseudoNode(node),
			pseudoType: metadata?.pseudoType,
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

test("Pure JSDOM - ExpandedTreeWalker nested shadow roots", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create outer custom element with shadow root
	const outerHost = document.createElement("outer-element");
	outerHost.className = "outer-host";
	document.body.appendChild(outerHost);

	// Create outer shadow root
	const outerShadowRoot = {
		mode: "open",
		host: outerHost,
		childNodes: [],
		nodeType: 11,
	} as any;

	// Create inner custom element inside outer shadow
	const innerHost = document.createElement("inner-element");
	innerHost.className = "inner-host";
	innerHost.textContent = "Inner host content";

	// Create inner shadow root
	const innerShadowRoot = {
		mode: "open",
		host: innerHost,
		childNodes: [],
		nodeType: 11,
	} as any;

	// Add content to inner shadow
	const deepContent = document.createElement("div");
	deepContent.className = "deep-content";
	deepContent.textContent = "Deep shadow content";

	// Set up inner shadow DOM structure
	innerShadowRoot.childNodes = [deepContent];
	innerShadowRoot.firstChild = deepContent;
	innerShadowRoot.lastChild = deepContent;
	Object.defineProperty(deepContent, "parentNode", {
		value: innerShadowRoot,
		writable: true,
		configurable: true,
	});

	// Set up outer shadow DOM structure with inner host
	outerShadowRoot.childNodes = [innerHost];
	outerShadowRoot.firstChild = innerHost;
	outerShadowRoot.lastChild = innerHost;
	Object.defineProperty(innerHost, "parentNode", {
		value: outerShadowRoot,
		writable: true,
		configurable: true,
	});

	setShadowRoot(outerHost, outerShadowRoot);
	setShadowRoot(innerHost, innerShadowRoot);

	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xffffffff | NodeFilterExtended.SHOW_SHADOW_DOM,
		null,
	);

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

test("Pure JSDOM - ExpandedTreeWalker shadow roots in slot assigned nodes", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
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

	// Create shadow root for the assigned element
	const assignedShadowRoot = {
		mode: "open",
		host: assignedElement,
		childNodes: [],
		nodeType: 11,
	} as any;

	const shadowContent = document.createElement("div");
	shadowContent.className = "shadow-in-assigned";
	shadowContent.textContent = "Shadow content in assigned node";

	assignedShadowRoot.childNodes = [shadowContent];
	assignedShadowRoot.firstChild = shadowContent;
	assignedShadowRoot.lastChild = shadowContent;
	Object.defineProperty(shadowContent, "parentNode", {
		value: assignedShadowRoot,
		writable: true,
		configurable: true,
	});

	setShadowRoot(assignedElement, assignedShadowRoot);

	document.body.appendChild(host);

	// Create host's shadow root with slot
	const hostShadowRoot = {
		mode: "open",
		host: host,
		childNodes: [],
		nodeType: 11,
	} as any;

	const slot = document.createElement("slot");
	slot.name = "content";
	const assignedNodes = [assignedElement];
	Object.defineProperty(slot, "assignedNodes", {
		value: () => assignedNodes,
		writable: true,
		configurable: true,
	});

	hostShadowRoot.childNodes = [slot];
	hostShadowRoot.firstChild = slot;
	hostShadowRoot.lastChild = slot;
	Object.defineProperty(slot, "parentNode", {
		value: hostShadowRoot,
		writable: true,
		configurable: true,
	});

	setShadowRoot(host, hostShadowRoot);

	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xffffffff |
			NodeFilterExtended.SHOW_SHADOW_DOM |
			NodeFilterExtended.SHOW_SLOTS,
		null,
	);

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

	// Should find the slot element
	expect(nodes.some((n) => n.name === "SLOT")).toBe(true);

	// Should find the assigned element
	expect(nodes.some((n) => n.className === "assigned-with-shadow")).toBe(true);

	// Should find the shadow content within the assigned element
	expect(nodes.some((n) => n.className === "shadow-in-assigned")).toBe(true);
	expect(
		nodes.some((n) => n.content === "Shadow content in assigned node"),
	).toBe(true);

	// Verify traversal order: host → slot → assigned element → assigned element's shadow content
	const hostIndex = nodes.findIndex((n) => n.className === "slot-host");
	const slotIndex = nodes.findIndex((n) => n.name === "SLOT");
	const assignedIndex = nodes.findIndex(
		(n) => n.className === "assigned-with-shadow",
	);
	const shadowInAssignedIndex = nodes.findIndex(
		(n) => n.className === "shadow-in-assigned",
	);

	expect(hostIndex).toBeLessThan(slotIndex);
	expect(slotIndex).toBeLessThan(assignedIndex);
	expect(assignedIndex).toBeLessThan(shadowInAssignedIndex);
});

test("Pure JSDOM - ExpandedTreeWalker complex nested scenario with pseudo-elements", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create a complex scenario:
	// List item with pseudo-elements → shadow root → slot with assigned content → assigned content has shadow root
	const li = document.createElement("li");
	li.className = "complex-list-item";
	li.textContent = "List item";

	// Add pseudo-elements to list item
	const markerNode = createPseudoNode(li, "::marker", "• ");
	const beforeNode = createPseudoNode(li, "::before", "[");
	const afterNode = createPseudoNode(li, "::after", "]");

	setPseudoElement(li, "::marker", markerNode);
	setPseudoElement(li, "::before", beforeNode);
	setPseudoElement(li, "::after", afterNode);

	// Create shadow root for list item
	const liShadowRoot = {
		mode: "open",
		host: li,
		childNodes: [],
		nodeType: 11,
	} as any;

	// Create slot in shadow root
	const slot = document.createElement("slot");
	slot.name = "content";

	// Create assigned content with its own shadow root
	const assignedContent = document.createElement("div");
	assignedContent.className = "assigned-content";
	assignedContent.setAttribute("slot", "content");
	assignedContent.textContent = "Assigned content";
	li.appendChild(assignedContent);

	const assignedShadowRoot = {
		mode: "open",
		host: assignedContent,
		childNodes: [],
		nodeType: 11,
	} as any;

	const deepShadowContent = document.createElement("span");
	deepShadowContent.className = "deep-shadow";
	deepShadowContent.textContent = "Deep shadow content";

	// Set up assigned element's shadow root
	assignedShadowRoot.childNodes = [deepShadowContent];
	assignedShadowRoot.firstChild = deepShadowContent;
	assignedShadowRoot.lastChild = deepShadowContent;
	Object.defineProperty(deepShadowContent, "parentNode", {
		value: assignedShadowRoot,
		writable: true,
		configurable: true,
	});

	setShadowRoot(assignedContent, assignedShadowRoot);

	// Set up slot assigned nodes
	Object.defineProperty(slot, "assignedNodes", {
		value: () => [assignedContent],
		writable: true,
		configurable: true,
	});

	// Set up list item's shadow root
	liShadowRoot.childNodes = [slot];
	liShadowRoot.firstChild = slot;
	liShadowRoot.lastChild = slot;
	Object.defineProperty(slot, "parentNode", {
		value: liShadowRoot,
		writable: true,
		configurable: true,
	});

	setShadowRoot(li, liShadowRoot);

	document.body.appendChild(li);

	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xffffffff |
			NodeFilterExtended.SHOW_PSEUDO_ELEMENTS |
			NodeFilterExtended.SHOW_SHADOW_DOM |
			NodeFilterExtended.SHOW_SLOTS,
		null,
	);

	const nodes: Array<{
		name: string;
		className?: string;
		content: string;
		isPseudo: boolean;
		pseudoType?: string;
	}> = [];

	let node = walker.nextNode();
	while (node && nodes.length < 20) {
		const metadata = getPseudoMetadata(node);
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || "",
			isPseudo: isPseudoNode(node),
			pseudoType: metadata?.pseudoType,
		});
		node = walker.nextNode();
	}

	// Should find all components in correct order
	expect(nodes.some((n) => n.className === "complex-list-item")).toBe(true);
	expect(nodes.some((n) => n.pseudoType === "::marker")).toBe(true);
	expect(nodes.some((n) => n.pseudoType === "::before")).toBe(true);
	expect(nodes.some((n) => n.pseudoType === "::after")).toBe(true);
	expect(nodes.some((n) => n.name === "SLOT")).toBe(true);
	expect(nodes.some((n) => n.className === "assigned-content")).toBe(true);
	expect(nodes.some((n) => n.className === "deep-shadow")).toBe(true);

	// Verify complex traversal order
	const liIndex = nodes.findIndex((n) => n.className === "complex-list-item");
	const markerIndex = nodes.findIndex((n) => n.pseudoType === "::marker");
	const beforeIndex = nodes.findIndex((n) => n.pseudoType === "::before");
	const slotIndex = nodes.findIndex((n) => n.name === "SLOT");
	const assignedIndex = nodes.findIndex(
		(n) => n.className === "assigned-content",
	);
	const deepShadowIndex = nodes.findIndex((n) => n.className === "deep-shadow");
	const afterIndex = nodes.findIndex((n) => n.pseudoType === "::after");

	// Verify the complex order: LI → ::marker → ::before → SLOT → assigned content → deep shadow → ::after
	expect(liIndex).toBeLessThan(markerIndex);
	expect(markerIndex).toBeLessThan(beforeIndex);
	expect(beforeIndex).toBeLessThan(slotIndex);
	expect(slotIndex).toBeLessThan(assignedIndex);
	expect(assignedIndex).toBeLessThan(deepShadowIndex);
	expect(deepShadowIndex).toBeLessThan(afterIndex);
});

// TermDOM Integration Tests

test("TermDOM - ExpandedTreeWalker basic functionality", () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const div = document.createElement("div");
	div.textContent = "Hello World";
	document.body.appendChild(div);

	const expandedWalker = termdom.createExpandedTreeWalker(
		document.body,
		termdom.window.NodeFilter.SHOW_ALL,
	);

	expect(expandedWalker).toBeDefined();
	expect(expandedWalker.root).toBe(document.body);
	expect(expandedWalker.currentNode).toBe(document.body);

	const firstNode = expandedWalker.nextNode();
	expect(firstNode).toBe(div);

	const secondNode = expandedWalker.nextNode();
	expect(secondNode?.nodeName).toBe("#text");
	expect(secondNode?.textContent).toBe("Hello World");
});

test("TermDOM - ExpandedTreeWalker with shadow DOM", () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Create a custom element with shadow DOM
	class TestElement extends (termdom.window as any).HTMLElement {
		constructor() {
			super();
			const shadow = this.attachShadow({mode: "open"});

			const wrapper = document.createElement("div");
			wrapper.textContent = "Shadow content";
			wrapper.className = "shadow-wrapper";

			shadow.appendChild(wrapper);
		}
	}

	termdom.window.customElements.define("test-element", TestElement as any);

	const testEl = document.createElement("test-element") as any;
	testEl.textContent = "Light content";
	document.body.appendChild(testEl);

	const walker = termdom.createExpandedTreeWalker(
		document.body,
		termdom.window.NodeFilter.SHOW_ALL | NodeFilterExtended.SHOW_SHADOW_DOM,
		null,
	);

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

test("TermDOM - ExpandedTreeWalker filter and whatToShow", () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const div = document.createElement("div");
	div.textContent = "Hello";
	document.body.appendChild(div);

	// Test with text nodes only
	const textOnlyWalker = termdom.createExpandedTreeWalker(
		document.body,
		termdom.window.NodeFilter.SHOW_TEXT,
	);

	expect(textOnlyWalker.whatToShow).toBe(termdom.window.NodeFilter.SHOW_TEXT);

	// Test with custom filter
	const filteredWalker = termdom.createExpandedTreeWalker(
		document.body,
		termdom.window.NodeFilter.SHOW_ALL,
		(node) => {
			if (node.nodeName === "DIV") {
				return termdom.window.NodeFilter.FILTER_ACCEPT;
			}
			return termdom.window.NodeFilter.FILTER_SKIP;
		},
	);

	expect(filteredWalker.filter).toBeDefined();
});

test("ExpandedTreeWalker supports named slots and multiple assigned elements", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create host with multiple elements for different slots
	const host = document.createElement("div");
	host.innerHTML = `
		<span slot="header" class="header-1">Header 1</span>
		<span slot="header" class="header-2">Header 2</span>
		<p slot="content" class="content-1">Content 1</p>
		<p slot="content" class="content-2">Content 2</p>
		<span class="default-content">Default content</span>
	`;
	document.body.appendChild(host);

	// Create shadow root with named slots
	const shadowRoot = {
		mode: "open",
		host: host,
		childNodes: [],
		nodeType: 11,
	} as any;

	// Create header slot
	const headerSlot = document.createElement("slot");
	headerSlot.name = "header";
	const headerNodes = Array.from(host.querySelectorAll('[slot="header"]'));
	Object.defineProperty(headerSlot, "assignedNodes", {
		value: () => headerNodes,
		writable: true,
		configurable: true,
	});

	// Create content slot
	const contentSlot = document.createElement("slot");
	contentSlot.name = "content";
	const contentNodes = Array.from(host.querySelectorAll('[slot="content"]'));
	Object.defineProperty(contentSlot, "assignedNodes", {
		value: () => contentNodes,
		writable: true,
		configurable: true,
	});

	// Create default slot
	const defaultSlot = document.createElement("slot");
	const defaultNodes = Array.from(host.childNodes).filter(
		(node) => node.nodeType === 1 && !(node as Element).hasAttribute("slot"),
	);
	Object.defineProperty(defaultSlot, "assignedNodes", {
		value: () => defaultNodes,
		writable: true,
		configurable: true,
	});

	// Set up shadow DOM structure with proper sibling links
	shadowRoot.childNodes = [headerSlot, contentSlot, defaultSlot];
	shadowRoot.firstChild = headerSlot;
	shadowRoot.lastChild = defaultSlot;

	// Link siblings properly
	Object.defineProperty(headerSlot, "nextSibling", {
		value: contentSlot,
		writable: true,
	});
	Object.defineProperty(contentSlot, "previousSibling", {
		value: headerSlot,
		writable: true,
	});
	Object.defineProperty(contentSlot, "nextSibling", {
		value: defaultSlot,
		writable: true,
	});
	Object.defineProperty(defaultSlot, "previousSibling", {
		value: contentSlot,
		writable: true,
	});

	[headerSlot, contentSlot, defaultSlot].forEach((slot) => {
		Object.defineProperty(slot, "parentNode", {
			value: shadowRoot,
			writable: true,
			configurable: true,
		});
	});

	setShadowRoot(host, shadowRoot);

	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xffffffff |
			NodeFilterExtended.SHOW_SHADOW_DOM |
			NodeFilterExtended.SHOW_SLOTS,
		null,
	);

	const nodes: Array<{name: string; className?: string; slotName?: string}> =
		[];

	let node = walker.nextNode();
	while (node && nodes.length < 20) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			slotName: (node as any).slot || undefined,
		});
		node = walker.nextNode();
	}

	// Should find all slot elements
	expect(nodes.filter((n) => n.name === "SLOT")).toHaveLength(3);

	// Should find elements assigned to header slot
	expect(nodes.some((n) => n.className === "header-1")).toBe(true);
	expect(nodes.some((n) => n.className === "header-2")).toBe(true);

	// Should find elements assigned to content slot
	expect(nodes.some((n) => n.className === "content-1")).toBe(true);
	expect(nodes.some((n) => n.className === "content-2")).toBe(true);

	// Should find elements assigned to default slot
	expect(nodes.some((n) => n.className === "default-content")).toBe(true);
});

test("Pure JSDOM - ExpandedTreeWalker respects root boundary", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
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
	const walker = createExpandedTreeWalker(
		window as any,
		p, // Root is the paragraph
		0xffffffff,
		null,
	);

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

test("Pure JSDOM - ExpandedTreeWalker previousNode respects root boundary", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
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

	// Walker rooted at div
	const walker = createExpandedTreeWalker(window as any, div, 0xffffffff, null);

	// Navigate to the span (deepest node)
	walker.nextNode(); // p
	walker.nextNode(); // span
	walker.nextNode(); // #text

	expect(walker.currentNode.textContent).toBe("content");

	// Navigate backwards
	const nodes: Array<{name: string; className?: string}> = [];
	let node = walker.previousNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
		});
		node = walker.previousNode();
	}

	// Should find span, p, div (all within root)
	expect(nodes.some((n) => n.className === "span")).toBe(true);
	expect(nodes.some((n) => n.className === "paragraph")).toBe(true);
	expect(nodes.some((n) => n.className === "container")).toBe(true);

	// Should NOT find body (outside root)
	expect(nodes.some((n) => n.name === "BODY")).toBe(false);
});

test("Pure JSDOM - ExpandedTreeWalker parentNode respects root boundary", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
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
	const walker = createExpandedTreeWalker(
		window as any,
		p, // Root is paragraph
		0xffffffff,
		null,
	);

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

test("FAILING - ExpandedTreeWalker ::after elements in layout engine pattern", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;

	// Create structure that matches our failing test: div.quote with ::before and ::after
	const quote = document.createElement("div");
	quote.className = "quote";
	quote.textContent = "Hello World";
	document.body.appendChild(quote);

	// Set up pseudo-elements using StyleManager pattern
	const beforeNode = createPseudoNode(quote, "::before", '"');
	const afterNode = createPseudoNode(quote, "::after", '"');

	setPseudoElement(quote, "::before", beforeNode);
	setPseudoElement(quote, "::after", afterNode);

	// Create walker that matches layout engine usage: start from quote element
	const walker = createExpandedTreeWalker(
		window as any,
		quote, // Start from the element itself (like addElementNode does)
		window.NodeFilter.SHOW_ELEMENT |
			window.NodeFilter.SHOW_TEXT |
			NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
		null,
	);

	// Simulate layout engine traversal: walker.firstChild() then walker.nextSibling()
	const foundNodes: Array<{
		type: string;
		content: string;
		pseudoType?: string;
	}> = [];

	let child = walker.firstChild();
	while (child) {
		const pseudoMeta = getPseudoMetadata(child);
		foundNodes.push({
			type: child.nodeType === child.TEXT_NODE ? "TEXT" : "ELEMENT",
			content: child.textContent || "",
			pseudoType: pseudoMeta?.pseudoType,
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

test("Pure JSDOM - ExpandedTreeWalker manual currentNode setting respects root", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
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
	const walker = createExpandedTreeWalker(window as any, div, 0xffffffff, null);

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

test("TermDOM - ::marker pseudo-elements with display: list-item", () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Add CSS with ::marker pseudo-element content
	const style = document.createElement("style");
	style.textContent = `
		.marker-test::marker {
			content: '★ ';
		}
		.list-item {
			display: list-item;
		}
	`;
	document.head.appendChild(style);

	// Test 1: Regular LI element (should work with default display: list-item)
	const li = document.createElement("li");
	li.className = "marker-test";
	li.textContent = "List item";
	document.body.appendChild(li);

	// Test 2: DIV with display: list-item (should work)
	const divListItem = document.createElement("div");
	divListItem.className = "marker-test list-item";
	divListItem.textContent = "Div as list item";
	document.body.appendChild(divListItem);

	// Test 3: Regular DIV without display: list-item (should NOT work)
	const regularDiv = document.createElement("div");
	regularDiv.className = "marker-test";
	regularDiv.textContent = "Regular div";
	document.body.appendChild(regularDiv);

	// Trigger stylesheet refresh to attach pseudo elements
	termdom.styleManager.refreshStylesheets();

	// Check that pseudo elements were created correctly
	expect(getPseudoElement(li, "::marker")?.textContent).toBe("★ ");
	expect(getPseudoElement(divListItem, "::marker")?.textContent).toBe("★ ");
	expect(getPseudoElement(regularDiv, "::marker")).toBe(null);

	// Verify computed display values
	expect(termdom.window.getComputedStyle(li).getPropertyValue("display")).toBe(
		"list-item",
	);
	expect(
		termdom.window.getComputedStyle(divListItem).getPropertyValue("display"),
	).toBe("list-item");
	expect(
		termdom.window.getComputedStyle(regularDiv).getPropertyValue("display"),
	).toBe("block");
});

test("TermDOM - ::marker appears before ::before pseudo-elements", () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Add CSS with both ::marker and ::before pseudo-elements
	const style = document.createElement("style");
	style.textContent = `
		.test::marker {
			content: '★ ';
		}
		.test::before {
			content: '[';
		}
		.test::after {
			content: ']';
		}
		.list-item {
			display: list-item;
		}
	`;
	document.head.appendChild(style);

	// Test with DIV that has display: list-item
	const div = document.createElement("div");
	div.className = "test list-item";
	div.textContent = "Content";
	document.body.appendChild(div);

	// Trigger stylesheet refresh
	termdom.styleManager.refreshStylesheets();

	// Verify all pseudo elements exist
	expect(getPseudoElement(div, "::marker")?.textContent).toBe("★ ");
	expect(getPseudoElement(div, "::before")?.textContent).toBe("[");
	expect(getPseudoElement(div, "::after")?.textContent).toBe("]");

	// Use ExpandedTreeWalker to verify order
	const walker = termdom.createExpandedTreeWalker(
		div,
		termdom.window.NodeFilter.SHOW_ELEMENT |
			termdom.window.NodeFilter.SHOW_TEXT |
			NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
		null,
	);

	const foundNodes: Array<{
		type: string;
		content: string;
		pseudoType?: string;
	}> = [];

	let childNode = walker.firstChild();
	while (childNode && foundNodes.length < 10) {
		const pseudoMeta = getPseudoMetadata(childNode);
		foundNodes.push({
			type: childNode.nodeType === childNode.TEXT_NODE ? "TEXT" : "ELEMENT",
			content: childNode.textContent || "",
			pseudoType: pseudoMeta?.pseudoType,
		});
		childNode = walker.nextSibling();
	}

	// Should find all pseudo elements and content in correct order
	expect(foundNodes).toHaveLength(4);

	const markerIndex = foundNodes.findIndex((n) => n.pseudoType === "::marker");
	const beforeIndex = foundNodes.findIndex((n) => n.pseudoType === "::before");
	const contentIndex = foundNodes.findIndex(
		(n) => n.content === "Content" && !n.pseudoType,
	);
	const afterIndex = foundNodes.findIndex((n) => n.pseudoType === "::after");

	// Verify CSS specification order: ::marker → ::before → content → ::after
	expect(markerIndex).toBe(0);
	expect(beforeIndex).toBe(1);
	expect(contentIndex).toBe(2);
	expect(afterIndex).toBe(3);

	expect(foundNodes[0].content).toBe("★ ");
	expect(foundNodes[1].content).toBe("[");
	expect(foundNodes[2].content).toBe("Content");
	expect(foundNodes[3].content).toBe("]");
});

test("TermDOM - ::marker only on elements with display: list-item in walker traversal", () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Add CSS
	const style = document.createElement("style");
	style.textContent = `
		.test::marker { content: '• '; }
		.list-item { display: list-item; }
		.block { display: block; }
	`;
	document.head.appendChild(style);

	// Create different elements
	const li = document.createElement("li"); // Default display: list-item
	li.className = "test";
	li.textContent = "LI";

	const divList = document.createElement("div"); // display: list-item via CSS
	divList.className = "test list-item";
	divList.textContent = "DIV-LIST";

	const divBlock = document.createElement("div"); // display: block via CSS
	divBlock.className = "test block";
	divBlock.textContent = "DIV-BLOCK";

	const container = document.createElement("div");
	container.appendChild(li);
	container.appendChild(divList);
	container.appendChild(divBlock);
	document.body.appendChild(container);

	// Trigger stylesheet refresh
	termdom.styleManager.refreshStylesheets();

	// Use walker to traverse and find ::marker elements
	const walker = termdom.createExpandedTreeWalker(
		container,
		termdom.window.NodeFilter.SHOW_ELEMENT |
			termdom.window.NodeFilter.SHOW_TEXT |
			NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
		null,
	);

	const markerNodes: Array<{parentTag: string; content: string}> = [];
	let node = walker.nextNode();
	while (node) {
		const pseudoMeta = getPseudoMetadata(node);
		if (pseudoMeta?.pseudoType === "::marker") {
			markerNodes.push({
				parentTag: pseudoMeta.hostElement.tagName,
				content: node.textContent || "",
			});
		}
		node = walker.nextNode();
	}

	// Should find ::marker for LI and DIV with display: list-item, but not regular DIV
	expect(markerNodes).toHaveLength(2);
	expect(markerNodes.find((m) => m.parentTag === "LI")).toBeDefined();
	expect(
		markerNodes.find((m) => m.parentTag === "DIV" && m.content === "• "),
	).toBeDefined();

	// All markers should have the expected content
	markerNodes.forEach((marker) => {
		expect(marker.content).toBe("• ");
	});

	// Verify display values of host elements
	const liDisplay = termdom.window
		.getComputedStyle(li)
		.getPropertyValue("display");
	const divListDisplay = termdom.window
		.getComputedStyle(divList)
		.getPropertyValue("display");
	const divBlockDisplay = termdom.window
		.getComputedStyle(divBlock)
		.getPropertyValue("display");

	expect(liDisplay).toBe("list-item");
	expect(divListDisplay).toBe("list-item");
	expect(divBlockDisplay).toBe("block");
});

test("TermDOM - ::marker rendering test", async () => {
	const terminal = new MockProcess();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	// Add CSS with ::marker and other pseudo-elements
	const style = document.createElement("style");
	style.textContent = `
		.test::marker { content: '▶ '; }
		.test::before { content: '['; }
		.test::after { content: ']'; }
		.list-item { display: list-item; }
	`;
	document.head.appendChild(style);

	// Create test element
	const div = document.createElement("div");
	div.className = "test list-item";
	div.textContent = "Content";
	document.body.appendChild(div);

	// Trigger stylesheet refresh and render
	termdom.styleManager.refreshStylesheets();
	await termdom.render();

	// Check terminal output contains all pseudo-element content in correct order
	const output = terminal.getPlainText();
	expect(output).toContain("▶ [Content]");

	// Verify the exact order appears in output
	const expectedPattern = "▶ [Content]";
	expect(output.includes(expectedPattern)).toBe(true);
});
