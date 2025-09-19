import {test, expect} from "bun:test";
import {JSDOM} from "jsdom";
import {TermDOM} from "../src/termdom.js";
import {TestTerminal} from "./test-utils.js";
import {
	createExpandedTreeWalker,
	NodeFilterExtended,
	SHADOW_ROOT_SYMBOL,
	PSEUDO_ELEMENTS_SYMBOL,
	PSEUDO_METADATA_SYMBOL,
	setShadowRoot,
	setPseudoElement,
	createPseudoNode,
	isPseudoNode,
	getPseudoMetadata,
	getShadowRoot,
	getPseudoElement
} from "../src/expanded-tree-walker.js";

// Utility constant for tests
const SHOW_EXTENDED_ALL = 0xFFFFFFFF;

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
		0xFFFFFFFF | NodeFilterExtended.SHOW_SHADOW_DOM,
		null
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
		0xFFFFFFFF | NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
		null
	);
	
	const nodes: Array<{name: string; content: string; isPseudo: boolean; pseudoType?: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		const metadata = getPseudoMetadata(node);
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			isPseudo: isPseudoNode(node),
			pseudoType: metadata?.pseudoType
		});
		node = walker.nextNode();
	}
	
	// Should find the div
	expect(nodes.some(n => n.name === "DIV")).toBe(true);
	
	// Should find main content
	expect(nodes.some(n => n.content === "Main content" && !n.isPseudo)).toBe(true);
	
	// Should find pseudo-elements
	expect(nodes.some(n => n.content === "Before: " && n.isPseudo && n.pseudoType === "::before")).toBe(true);
	expect(nodes.some(n => n.content === " :After" && n.isPseudo && n.pseudoType === "::after")).toBe(true);
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
		nodeName: "#document-fragment"
	} as any;
	
	// Create shadow content
	const shadowDiv = document.createElement("div");
	shadowDiv.textContent = "Shadow content";
	shadowDiv.className = "shadow-element";
	
	// Set up shadow DOM structure
	shadowRoot.firstChild = shadowDiv;
	shadowRoot.lastChild = shadowDiv;
	shadowRoot.childNodes = [shadowDiv];
	Object.defineProperty(shadowDiv, 'parentNode', {
		value: shadowRoot,
		writable: true,
		configurable: true
	});
	
	setShadowRoot(host, shadowRoot);
	
	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xFFFFFFFF | NodeFilterExtended.SHOW_SHADOW_DOM,
		null
	);
	
	const nodes: Array<{name: string; content: string; className?: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			className: (node as any).className || undefined
		});
		node = walker.nextNode();
	}
	
	// Should find the host element
	expect(nodes.some(n => n.name === "DIV" && !n.className)).toBe(true);
	
	// Should find shadow content
	expect(nodes.some(n => n.content === "Shadow content")).toBe(true);
	
	// Should find the shadow element
	expect(nodes.some(n => n.className === "shadow-element")).toBe(true);
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
		nodeType: 11
	} as any;
	
	const slot = document.createElement("slot");
	slot.name = "content";
	
	// Mock assignedNodes for the slot
	const lightNodes = Array.from(host.childNodes);
	Object.defineProperty(slot, 'assignedNodes', {
		value: () => lightNodes,
		writable: true,
		configurable: true
	});
	
	shadowRoot.firstChild = slot;
	shadowRoot.lastChild = slot;
	shadowRoot.childNodes = [slot];
	Object.defineProperty(slot, 'parentNode', {
		value: shadowRoot,
		writable: true,
		configurable: true
	});
	
	setShadowRoot(host, shadowRoot);
	
	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xFFFFFFFF | NodeFilterExtended.SHOW_SHADOW_DOM | NodeFilterExtended.SHOW_SLOTS,
		null
	);
	
	const nodes: Array<{name: string; content: string; className?: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			className: (node as any).className || undefined
		});
		node = walker.nextNode();
	}
	
	// Should find the host element
	expect(nodes.some(n => n.name === "DIV" && !n.className)).toBe(true);
	
	// Should find the slot element
	expect(nodes.some(n => n.name === "SLOT")).toBe(true);
	
	// Should find slotted content
	expect(nodes.some(n => n.className === "light-content")).toBe(true);
	expect(nodes.some(n => n.content === "Light DOM content")).toBe(true);
});

test("Pure JSDOM - ExpandedTreeWalker options control", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;
	
	const div = document.createElement("div");
	div.textContent = "Content";
	document.body.appendChild(div);
	
	// Add pseudo-elements
	setPseudoElement(div, "::before", createPseudoNode(div, "::before", "Before"));
	
	// Add shadow root
	const shadowRoot = { firstChild: document.createTextNode("Shadow"), nodeType: 11 } as any;
	setShadowRoot(div, shadowRoot);
	
	// Test with all extended options disabled (just regular DOM traversal)
	// Use a mask that includes standard flags but excludes our extended flags
	const standardFlags = window.NodeFilter.SHOW_ALL & ~(NodeFilterExtended.SHOW_SHADOW_DOM | NodeFilterExtended.SHOW_PSEUDO_ELEMENTS | NodeFilterExtended.SHOW_SLOTS);
	const walkerDisabled = createExpandedTreeWalker(
		window as any,
		document.body,
		standardFlags, // Only standard flags, no extended flags
		null
	);
	
	const nodesDisabled: Array<{content: string; isPseudo: boolean; nodeName: string}> = [];
	let node = walkerDisabled.nextNode();
	while (node && nodesDisabled.length < 10) {
		nodesDisabled.push({
			content: node.textContent || "",
			isPseudo: isPseudoNode(node),
			nodeName: node.nodeName
		});
		node = walkerDisabled.nextNode();
	}
	
	// Should only find regular content
	expect(nodesDisabled.some(n => n.content === "Content")).toBe(true);
	expect(nodesDisabled.some(n => n.content === "Before")).toBe(false);
	expect(nodesDisabled.some(n => n.content === "Shadow")).toBe(false);
	expect(nodesDisabled.some(n => n.isPseudo)).toBe(false);
});

test("Pure JSDOM - ExpandedTreeWalker utility functions", () => {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
	const window = dom.window;
	const document = window.document;
	
	const div = document.createElement("div");
	document.body.appendChild(div);
	
	// Test shadow root storage
	const shadowRoot = { mode: "open", host: div } as any;
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
		0xFFFFFFFF | NodeFilterExtended.SHOW_PSEUDO_ELEMENTS,
		null
	);
	
	const nodes: Array<{name: string; content: string; isPseudo: boolean; pseudoType?: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		const metadata = getPseudoMetadata(node);
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			isPseudo: isPseudoNode(node),
			pseudoType: metadata?.pseudoType
		});
		node = walker.nextNode();
	}
	
	// Should find the list item
	expect(nodes.some(n => n.name === "LI" && !n.isPseudo)).toBe(true);
	
	// Should find all pseudo-elements in correct order
	const pseudoNodes = nodes.filter(n => n.isPseudo);
	expect(pseudoNodes).toHaveLength(3);
	
	// Verify pseudo-element order: ::marker, ::before, ::after
	expect(pseudoNodes[0].pseudoType).toBe("::marker");
	expect(pseudoNodes[0].content).toBe("• ");
	
	expect(pseudoNodes[1].pseudoType).toBe("::before");
	expect(pseudoNodes[1].content).toBe("[");
	
	expect(pseudoNodes[2].pseudoType).toBe("::after");
	expect(pseudoNodes[2].content).toBe("]");
	
	// Verify document order in the full nodes array
	const markerIndex = nodes.findIndex(n => n.pseudoType === "::marker");
	const beforeIndex = nodes.findIndex(n => n.pseudoType === "::before");
	const afterIndex = nodes.findIndex(n => n.pseudoType === "::after");
	const contentTextIndex = nodes.findIndex(n => !n.isPseudo && n.name === "#text" && n.content === "List item content");
	
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
		nodeType: 11
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
		nodeType: 11
	} as any;
	
	// Add content to inner shadow
	const deepContent = document.createElement("div");
	deepContent.className = "deep-content";
	deepContent.textContent = "Deep shadow content";
	
	// Set up inner shadow DOM structure
	innerShadowRoot.childNodes = [deepContent];
	innerShadowRoot.firstChild = deepContent;
	innerShadowRoot.lastChild = deepContent;
	Object.defineProperty(deepContent, 'parentNode', {
		value: innerShadowRoot,
		writable: true,
		configurable: true
	});
	
	// Set up outer shadow DOM structure with inner host
	outerShadowRoot.childNodes = [innerHost];
	outerShadowRoot.firstChild = innerHost;
	outerShadowRoot.lastChild = innerHost;
	Object.defineProperty(innerHost, 'parentNode', {
		value: outerShadowRoot,
		writable: true,
		configurable: true
	});
	
	setShadowRoot(outerHost, outerShadowRoot);
	setShadowRoot(innerHost, innerShadowRoot);
	
	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xFFFFFFFF | NodeFilterExtended.SHOW_SHADOW_DOM,
		null
	);
	
	const nodes: Array<{name: string; className?: string; content: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 15) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || ""
		});
		node = walker.nextNode();
	}
	
	// Should find outer host
	expect(nodes.some(n => n.className === "outer-host")).toBe(true);
	
	// Should find inner host (in outer shadow)
	expect(nodes.some(n => n.className === "inner-host")).toBe(true);
	
	// Should find deep content (in inner shadow)
	expect(nodes.some(n => n.className === "deep-content")).toBe(true);
	expect(nodes.some(n => n.content === "Deep shadow content")).toBe(true);
	
	// Verify nested traversal order
	const outerIndex = nodes.findIndex(n => n.className === "outer-host");
	const innerIndex = nodes.findIndex(n => n.className === "inner-host");  
	const deepIndex = nodes.findIndex(n => n.className === "deep-content");
	
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
		nodeType: 11
	} as any;
	
	const shadowContent = document.createElement("div");
	shadowContent.className = "shadow-in-assigned";
	shadowContent.textContent = "Shadow content in assigned node";
	
	assignedShadowRoot.childNodes = [shadowContent];
	assignedShadowRoot.firstChild = shadowContent;
	assignedShadowRoot.lastChild = shadowContent;
	Object.defineProperty(shadowContent, 'parentNode', {
		value: assignedShadowRoot,
		writable: true,
		configurable: true
	});
	
	setShadowRoot(assignedElement, assignedShadowRoot);
	
	document.body.appendChild(host);
	
	// Create host's shadow root with slot
	const hostShadowRoot = {
		mode: "open",
		host: host,
		childNodes: [],
		nodeType: 11
	} as any;
	
	const slot = document.createElement("slot");
	slot.name = "content";
	const assignedNodes = [assignedElement];
	Object.defineProperty(slot, 'assignedNodes', {
		value: () => assignedNodes,
		writable: true,
		configurable: true
	});
	
	hostShadowRoot.childNodes = [slot];
	hostShadowRoot.firstChild = slot;
	hostShadowRoot.lastChild = slot;
	Object.defineProperty(slot, 'parentNode', {
		value: hostShadowRoot,
		writable: true,
		configurable: true
	});
	
	setShadowRoot(host, hostShadowRoot);
	
	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xFFFFFFFF | NodeFilterExtended.SHOW_SHADOW_DOM | NodeFilterExtended.SHOW_SLOTS,
		null
	);
	
	const nodes: Array<{name: string; className?: string; content: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 15) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || ""
		});
		node = walker.nextNode();
	}
	
	// Should find the slot host
	expect(nodes.some(n => n.className === "slot-host")).toBe(true);
	
	// Should find the slot element
	expect(nodes.some(n => n.name === "SLOT")).toBe(true);
	
	// Should find the assigned element
	expect(nodes.some(n => n.className === "assigned-with-shadow")).toBe(true);
	
	
	// Should find the shadow content within the assigned element
	expect(nodes.some(n => n.className === "shadow-in-assigned")).toBe(true);
	expect(nodes.some(n => n.content === "Shadow content in assigned node")).toBe(true);
	
	// Verify traversal order: host → slot → assigned element → assigned element's shadow content
	const hostIndex = nodes.findIndex(n => n.className === "slot-host");
	const slotIndex = nodes.findIndex(n => n.name === "SLOT");
	const assignedIndex = nodes.findIndex(n => n.className === "assigned-with-shadow");
	const shadowInAssignedIndex = nodes.findIndex(n => n.className === "shadow-in-assigned");
	
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
		nodeType: 11
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
		nodeType: 11
	} as any;
	
	const deepShadowContent = document.createElement("span");
	deepShadowContent.className = "deep-shadow";
	deepShadowContent.textContent = "Deep shadow content";
	
	// Set up assigned element's shadow root
	assignedShadowRoot.childNodes = [deepShadowContent];
	assignedShadowRoot.firstChild = deepShadowContent;
	assignedShadowRoot.lastChild = deepShadowContent;
	Object.defineProperty(deepShadowContent, 'parentNode', {
		value: assignedShadowRoot,
		writable: true,
		configurable: true
	});
	
	setShadowRoot(assignedContent, assignedShadowRoot);
	
	// Set up slot assigned nodes
	Object.defineProperty(slot, 'assignedNodes', {
		value: () => [assignedContent],
		writable: true,
		configurable: true
	});
	
	// Set up list item's shadow root
	liShadowRoot.childNodes = [slot];
	liShadowRoot.firstChild = slot;
	liShadowRoot.lastChild = slot;
	Object.defineProperty(slot, 'parentNode', {
		value: liShadowRoot,
		writable: true,
		configurable: true
	});
	
	setShadowRoot(li, liShadowRoot);
	
	document.body.appendChild(li);
	
	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xFFFFFFFF | NodeFilterExtended.SHOW_PSEUDO_ELEMENTS | NodeFilterExtended.SHOW_SHADOW_DOM | NodeFilterExtended.SHOW_SLOTS,
		null
	);
	
	const nodes: Array<{name: string; className?: string; content: string; isPseudo: boolean; pseudoType?: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 20) {
		const metadata = getPseudoMetadata(node);
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || "",
			isPseudo: isPseudoNode(node),
			pseudoType: metadata?.pseudoType
		});
		node = walker.nextNode();
	}
	

	// Should find all components in correct order
	expect(nodes.some(n => n.className === "complex-list-item")).toBe(true);
	expect(nodes.some(n => n.pseudoType === "::marker")).toBe(true);
	expect(nodes.some(n => n.pseudoType === "::before")).toBe(true);
	expect(nodes.some(n => n.pseudoType === "::after")).toBe(true);
	expect(nodes.some(n => n.name === "SLOT")).toBe(true);
	expect(nodes.some(n => n.className === "assigned-content")).toBe(true);
	expect(nodes.some(n => n.className === "deep-shadow")).toBe(true);
	
	// Verify complex traversal order
	const liIndex = nodes.findIndex(n => n.className === "complex-list-item");
	const markerIndex = nodes.findIndex(n => n.pseudoType === "::marker");
	const beforeIndex = nodes.findIndex(n => n.pseudoType === "::before");
	const slotIndex = nodes.findIndex(n => n.name === "SLOT");
	const assignedIndex = nodes.findIndex(n => n.className === "assigned-content");
	const deepShadowIndex = nodes.findIndex(n => n.className === "deep-shadow");
	const afterIndex = nodes.findIndex(n => n.pseudoType === "::after");
	
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
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const div = document.createElement("div");
	div.textContent = "Hello World";
	document.body.appendChild(div);

	const expandedWalker = termdom.createExpandedTreeWalker(
		document.body,
		termdom.window.NodeFilter.SHOW_ALL
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
	const terminal = new TestTerminal();
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
		null
	);

	const nodes: Array<{name: string; content: string; className?: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			content: node.textContent || "",
			className: (node as any).className || undefined
		});
		node = walker.nextNode();
	}

	// Should find the test-element
	expect(nodes.some(n => n.name === "TEST-ELEMENT")).toBe(true);
	
	// Should find shadow content
	expect(nodes.some(n => n.content === "Shadow content")).toBe(true);
	
	// Should find the shadow wrapper element
	expect(nodes.some(n => n.className === "shadow-wrapper")).toBe(true);
});

test("TermDOM - ExpandedTreeWalker filter and whatToShow", () => {
	const terminal = new TestTerminal();
	const termdom = new TermDOM({process: terminal});
	const {document} = termdom;

	const div = document.createElement("div");
	div.textContent = "Hello";
	document.body.appendChild(div);

	// Test with text nodes only
	const textOnlyWalker = termdom.createExpandedTreeWalker(
		document.body,
		termdom.window.NodeFilter.SHOW_TEXT
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
		}
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
		nodeType: 11
	} as any;
	
	// Create header slot
	const headerSlot = document.createElement("slot");
	headerSlot.name = "header";
	const headerNodes = Array.from(host.querySelectorAll('[slot="header"]'));
	Object.defineProperty(headerSlot, 'assignedNodes', {
		value: () => headerNodes,
		writable: true,
		configurable: true
	});
	
	// Create content slot  
	const contentSlot = document.createElement("slot");
	contentSlot.name = "content";
	const contentNodes = Array.from(host.querySelectorAll('[slot="content"]'));
	Object.defineProperty(contentSlot, 'assignedNodes', {
		value: () => contentNodes,
		writable: true,
		configurable: true
	});
	
	// Create default slot
	const defaultSlot = document.createElement("slot");
	const defaultNodes = Array.from(host.childNodes).filter(node => 
		node.nodeType === 1 && !(node as Element).hasAttribute('slot')
	);
	Object.defineProperty(defaultSlot, 'assignedNodes', {
		value: () => defaultNodes,
		writable: true,
		configurable: true
	});
	
	// Set up shadow DOM structure with proper sibling links
	shadowRoot.childNodes = [headerSlot, contentSlot, defaultSlot];
	shadowRoot.firstChild = headerSlot;
	shadowRoot.lastChild = defaultSlot;
	
	// Link siblings properly
	Object.defineProperty(headerSlot, 'nextSibling', { value: contentSlot, writable: true });
	Object.defineProperty(contentSlot, 'previousSibling', { value: headerSlot, writable: true });
	Object.defineProperty(contentSlot, 'nextSibling', { value: defaultSlot, writable: true });
	Object.defineProperty(defaultSlot, 'previousSibling', { value: contentSlot, writable: true });
	
	[headerSlot, contentSlot, defaultSlot].forEach(slot => {
		Object.defineProperty(slot, 'parentNode', {
			value: shadowRoot,
			writable: true,
			configurable: true
		});
	});
	
	setShadowRoot(host, shadowRoot);
	
	const walker = createExpandedTreeWalker(
		window as any,
		document.body,
		0xFFFFFFFF | NodeFilterExtended.SHOW_SHADOW_DOM | NodeFilterExtended.SHOW_SLOTS,
		null
	);
	
	const nodes: Array<{name: string; className?: string; slotName?: string}> = [];
	
	let node = walker.nextNode();
	while (node && nodes.length < 20) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			slotName: (node as any).slot || undefined
		});
		node = walker.nextNode();
	}
	
	// Should find all slot elements
	expect(nodes.filter(n => n.name === "SLOT")).toHaveLength(3);
	
	// Should find elements assigned to header slot
	expect(nodes.some(n => n.className === "header-1")).toBe(true);
	expect(nodes.some(n => n.className === "header-2")).toBe(true);
	
	// Should find elements assigned to content slot
	expect(nodes.some(n => n.className === "content-1")).toBe(true);
	expect(nodes.some(n => n.className === "content-2")).toBe(true);
	
	// Should find elements assigned to default slot
	expect(nodes.some(n => n.className === "default-content")).toBe(true);
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
		0xFFFFFFFF,
		null
	);
	
	const nodes: Array<{name: string; className?: string; content: string}> = [];
	let node = walker.nextNode();
	while (node && nodes.length < 10) {
		nodes.push({
			name: node.nodeName,
			className: (node as any).className || undefined,
			content: node.textContent || ""
		});
		node = walker.nextNode();
	}
	
	
	// Should find span (within root) - note: nextNode() doesn't return the root itself
	expect(nodes.some(n => n.className === "span")).toBe(true);
	
	// Should NOT find container (outside root) or body
	expect(nodes.some(n => n.className === "container")).toBe(false);
	expect(nodes.some(n => n.name === "BODY")).toBe(false);
	
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
	const walker = createExpandedTreeWalker(
		window as any,
		div,
		0xFFFFFFFF,
		null
	);
	
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
			className: (node as any).className || undefined
		});
		node = walker.previousNode();
	}
	
	
	// Should find span, p, div (all within root)
	expect(nodes.some(n => n.className === "span")).toBe(true);
	expect(nodes.some(n => n.className === "paragraph")).toBe(true);
	expect(nodes.some(n => n.className === "container")).toBe(true);
	
	// Should NOT find body (outside root)
	expect(nodes.some(n => n.name === "BODY")).toBe(false);
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
		0xFFFFFFFF,
		null
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
	const walker = createExpandedTreeWalker(
		window as any,
		div,
		0xFFFFFFFF,
		null
	);
	
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