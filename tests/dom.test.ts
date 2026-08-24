/**
 * TermDOM's own DOM: the mutation algorithms' edges.
 *
 * The web-platform-tests dom suites are the conformance referee (see
 * `scripts/wpt-dom.ts` and `docs/dom-conformance.md`). These cover the corners
 * those suites reach past: the order the algorithms run their steps in, what a
 * live collection sees mid-mutation, and the cases a browsing context would
 * normally be needed to set up.
 */
import {test, expect} from "@b9g/libuild/test";
import {
	CustomEvent as DOMCustomEvent,
	DOMParser,
	Event as DOMEvent,
	HTMLElement,
	MutationObserver,
	NodeFilter,
	type Document,
	parseHTMLDocument,
	Text,
	Window,
	installUAEngine,
} from "../src/internal/dom.js";

// The door a test document comes through. The parser is the one that hands
// a document the realm's custom element registry, as it does the engine's.
function createHTMLDocument(title?: string): Document {
	return parseHTMLDocument(
		title === undefined ?
			"<!doctype html>" :
			`<!doctype html><title>${title}</title>`,
	);
}

const customElements = new Window(createHTMLDocument()).customElements;

function make(): any {
	const document = createHTMLDocument("") as any;
	return document;
}

/* ------------------------------------------------------- pre-insert checks */

test("a node cannot be inserted into itself or its descendant", () => {
	const document = make();
	const outer = document.createElement("div");
	const inner = document.createElement("div");
	outer.appendChild(inner);
	expect(() => outer.appendChild(outer)).toThrow();
	expect(() => inner.appendChild(outer)).toThrow();
});

test("a document takes one element child and one doctype, in that order", () => {
	const document = new DOMParser().parseFromString("", "text/html") as any;
	const bare = document.implementation.createDocument(null, null, null);
	const first = bare.createElement("first");
	bare.appendChild(first);
	expect(() => bare.appendChild(bare.createElement("second"))).toThrow();
	const doctype = bare.implementation.createDocumentType("html", "", "");
	// A doctype cannot follow the document element.
	expect(() => bare.appendChild(doctype)).toThrow();
	expect(() => bare.insertBefore(doctype, first)).not.toThrow();
	expect(bare.doctype).toBe(doctype);
	expect(bare.documentElement).toBe(first);
});

test("a text node cannot be a document's child, a doctype only a document's", () => {
	const document = make();
	const bare = document.implementation.createDocument(null, null, null);
	expect(() => bare.appendChild(bare.createTextNode("x"))).toThrow();
	const doctype = document.implementation.createDocumentType("html", "", "");
	expect(() => document.createElement("div").appendChild(doctype)).toThrow();
});

test("inserting a fragment before its own reference child moves nothing", () => {
	const document = make();
	const parent = document.createElement("div");
	const child = document.createElement("span");
	parent.appendChild(child);
	expect(parent.insertBefore(child, child)).toBe(child);
	expect(parent.childNodes.length).toBe(1);
});

test("a fragment's children are inserted and the fragment is emptied", () => {
	const document = make();
	const fragment = document.createDocumentFragment();
	fragment.append("a", document.createElement("b"), "c");
	const parent = document.createElement("div");
	parent.appendChild(fragment);
	expect(fragment.childNodes.length).toBe(0);
	expect(parent.childNodes.length).toBe(3);
	expect(parent.textContent).toBe("ac");
});

test("an empty fragment inserts nothing and leaves the parent alone", () => {
	const document = make();
	const parent = document.createElement("div");
	parent.appendChild(document.createTextNode("keep"));
	parent.appendChild(document.createDocumentFragment());
	expect(parent.childNodes.length).toBe(1);
});

/* ------------------------------------------------------------ replace/adopt */

test("replaceChild with the node's own next sibling as the child", () => {
	const document = make();
	const parent = document.createElement("div");
	const one = document.createElement("one");
	const two = document.createElement("two");
	parent.append(one, two);
	expect(parent.replaceChild(one, two)).toBe(two);
	expect(parent.childNodes.length).toBe(1);
	expect(parent.firstChild).toBe(one);
});

test("insertion adopts a node out of another document", () => {
	const first = make();
	const second = createHTMLDocument("") as any;
	const node = first.createElement("div");
	node.appendChild(first.createElement("span"));
	second.body.appendChild(node);
	expect(node.ownerDocument).toBe(second);
	expect(node.firstChild.ownerDocument).toBe(second);
});

test("adoption carries an element's attribute nodes with it", () => {
	const first = make();
	const second = createHTMLDocument("") as any;
	const node = first.createElement("div");
	node.setAttribute("data-x", "1");
	second.adoptNode(node);
	expect(node.getAttributeNode("data-x").ownerDocument).toBe(second);
});

test("adopting a node removes it from its old parent", () => {
	const first = make();
	const second = createHTMLDocument("") as any;
	const parent = first.createElement("div");
	const node = first.createElement("span");
	parent.appendChild(node);
	second.adoptNode(node);
	expect(parent.childNodes.length).toBe(0);
	expect(node.parentNode).toBe(null);
});

/* ------------------------------------------------------------------ id map */

test("getElementById is a map hit that tracks id changes", () => {
	const document = make();
	const node = document.createElement("div");
	node.id = "target";
	expect(document.getElementById("target")).toBe(null);
	document.body.appendChild(node);
	expect(document.getElementById("target")).toBe(node);
	node.id = "moved";
	expect(document.getElementById("target")).toBe(null);
	expect(document.getElementById("moved")).toBe(node);
	node.remove();
	expect(document.getElementById("moved")).toBe(null);
});

test("duplicate ids resolve to the first element in tree order", () => {
	const document = make();
	const first = document.createElement("div");
	const second = document.createElement("div");
	first.id = "same";
	second.id = "same";
	document.body.append(second, first);
	expect(document.getElementById("same")).toBe(second);
	second.remove();
	expect(document.getElementById("same")).toBe(first);
});

test("an id map entry follows a whole subtree in and out", () => {
	const document = make();
	const wrapper = document.createElement("div");
	const deep = document.createElement("span");
	deep.id = "deep";
	wrapper.appendChild(deep);
	document.body.appendChild(wrapper);
	expect(document.getElementById("deep")).toBe(deep);
	wrapper.remove();
	expect(document.getElementById("deep")).toBe(null);
});

/* -------------------------------------------------------- live collections */

test("childNodes is one live object, indexed without an intervening read", () => {
	const document = make();
	const parent = document.createElement("div");
	const children = parent.childNodes;
	expect(parent.childNodes).toBe(children);
	const first = document.createElement("a");
	parent.appendChild(first);
	expect(children[0]).toBe(first);
	expect(children.length).toBe(1);
	const second = document.createElement("b");
	parent.insertBefore(second, first);
	expect(children[0]).toBe(second);
	expect(children[1]).toBe(first);
	parent.removeChild(second);
	expect(children[0]).toBe(first);
	expect(children[1]).toBe(undefined);
});

test("getElementsByTagName is live and identity-stable", () => {
	const document = make();
	const found = document.getElementsByTagName("p");
	expect(document.getElementsByTagName("p")).toBe(found);
	expect(found.length).toBe(0);
	const paragraph = document.createElement("p");
	document.body.appendChild(paragraph);
	expect(found.length).toBe(1);
	expect(found[0]).toBe(paragraph);
});

test("getElementsByClassName follows a class attribute change", () => {
	const document = make();
	const node = document.createElement("div");
	document.body.appendChild(node);
	const found = document.getElementsByClassName("hit");
	expect(found.length).toBe(0);
	node.classList.add("hit");
	expect(found[0]).toBe(node);
	node.className = "";
	expect(found.length).toBe(0);
});

test("children skips non-element children", () => {
	const document = make();
	const parent = document.createElement("div");
	parent.append(
		"text",
		document.createElement("i"),
		document.createComment("c"),
	);
	expect(parent.childNodes.length).toBe(3);
	expect(parent.children.length).toBe(1);
	expect(parent.children[0].localName).toBe("i");
});

/* ---------------------------------------------------------- character data */

test("normalize concatenates and drops empty text nodes", () => {
	const document = make();
	const parent = document.createElement("div");
	parent.append(
		document.createTextNode(""),
		document.createTextNode("a"),
		document.createTextNode(""),
		document.createTextNode("b"),
		document.createElement("br"),
		document.createTextNode("c"),
	);
	parent.normalize();
	expect(parent.childNodes.length).toBe(3);
	expect(parent.firstChild.data).toBe("ab");
	expect(parent.lastChild.data).toBe("c");
});

test("splitText leaves both halves in the parent and wholeText joins them", () => {
	const document = make();
	const parent = document.createElement("div");
	const text = document.createTextNode("abcdef");
	parent.appendChild(text);
	const tail = text.splitText(2);
	expect(text.data).toBe("ab");
	expect(tail.data).toBe("cdef");
	expect(text.nextSibling).toBe(tail);
	expect(text.wholeText).toBe("abcdef");
});

test("replaceData clamps a count that runs past the end", () => {
	const document = make();
	const text = document.createTextNode("abc");
	text.replaceData(1, 100, "X");
	expect(text.data).toBe("aX");
	expect(() => text.replaceData(10, 0, "")).toThrow();
});

/* ----------------------------------------------------------- attribute steps */

test("setAttribute keeps an existing attribute node and its prefix", () => {
	const document = make();
	const node = document.createElement("div");
	node.setAttributeNS("http://example.com/", "pre:name", "one");
	const attribute = node.getAttributeNodeNS("http://example.com/", "name");
	node.setAttributeNS("http://example.com/", "other:name", "two");
	expect(node.getAttributeNodeNS("http://example.com/", "name")).toBe(
		attribute,
	);
	expect(attribute.prefix).toBe("pre");
	expect(attribute.value).toBe("two");
});

test("an attribute node moved between elements throws while in use", () => {
	const document = make();
	const one = document.createElement("div");
	const two = document.createElement("div");
	const attribute = document.createAttribute("data-x");
	one.setAttributeNode(attribute);
	expect(() => two.setAttributeNode(attribute)).toThrow();
	one.removeAttributeNode(attribute);
	expect(() => two.setAttributeNode(attribute)).not.toThrow();
});

test("toggleAttribute honours force in both directions", () => {
	const document = make();
	const node = document.createElement("div");
	expect(node.toggleAttribute("hidden")).toBe(true);
	expect(node.toggleAttribute("hidden", true)).toBe(true);
	expect(node.toggleAttribute("hidden")).toBe(false);
	expect(node.toggleAttribute("hidden", false)).toBe(false);
	expect(node.hasAttribute("hidden")).toBe(false);
});

test("an HTML element in an HTML document lowercases attribute names", () => {
	const document = make();
	const node = document.createElement("div");
	node.setAttribute("DATA-X", "1");
	expect(node.getAttributeNames()).toEqual(["data-x"]);
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 1 1");
	expect(svg.getAttributeNames()).toEqual(["viewBox"]);
});

/* ------------------------------------------------------------------ cloning */

test("cloneNode copies attributes and, when deep, the subtree", () => {
	const document = make();
	const node = document.createElement("div");
	node.setAttribute("id", "x");
	node.appendChild(document.createTextNode("hello"));
	const shallow = node.cloneNode();
	expect(shallow.getAttribute("id")).toBe("x");
	expect(shallow.childNodes.length).toBe(0);
	const deep = node.cloneNode(true);
	expect(deep.textContent).toBe("hello");
	expect(deep.isEqualNode(node)).toBe(true);
	expect(deep.isSameNode(node)).toBe(false);
});

test("importNode clones into the importing document", () => {
	const first = make();
	const second = createHTMLDocument("") as any;
	const node = first.createElement("div");
	node.appendChild(first.createElement("span"));
	const imported = second.importNode(node, true);
	expect(imported.ownerDocument).toBe(second);
	expect(imported.firstChild.ownerDocument).toBe(second);
	expect(node.parentNode).toBe(null);
});

/* ---------------------------------------------------------------- traversal */

test("a NodeIterator's reference survives the removal of its own node", () => {
	const document = make();
	const parent = document.createElement("div");
	const first = document.createElement("a");
	const second = document.createElement("b");
	parent.append(first, second);
	document.body.appendChild(parent);
	const iterator = document.createNodeIterator(parent, NodeFilter.SHOW_ELEMENT);
	expect(iterator.nextNode()).toBe(parent);
	expect(iterator.nextNode()).toBe(first);
	first.remove();
	// The pointer was after `first`, so it falls back to what preceded it.
	expect(iterator.referenceNode).toBe(parent);
	expect(iterator.pointerBeforeReferenceNode).toBe(false);
	expect(iterator.nextNode()).toBe(second);
});

test("a NodeIterator whose pointer is before the removed node moves forward", () => {
	const document = make();
	const parent = document.createElement("div");
	const first = document.createElement("a");
	const second = document.createElement("b");
	parent.append(first, second);
	document.body.appendChild(parent);
	const iterator = document.createNodeIterator(parent, NodeFilter.SHOW_ELEMENT);
	iterator.nextNode();
	expect(iterator.nextNode()).toBe(first);
	// previousNode with the pointer after the reference only flips the pointer.
	expect(iterator.previousNode()).toBe(first);
	expect(iterator.pointerBeforeReferenceNode).toBe(true);
	first.remove();
	expect(iterator.referenceNode).toBe(second);
	expect(iterator.pointerBeforeReferenceNode).toBe(true);
});

test("a TreeWalker's filter rejects a subtree and skips a single node", () => {
	const document = make();
	document.body.innerHTML = "<a><b><c></c></b></a><d><e></e></d>";
	const walker = document.createTreeWalker(
		document.body,
		NodeFilter.SHOW_ELEMENT,
		(node: any) => {
			if (node.localName === "b") {
				return NodeFilter.FILTER_REJECT;
			}
			if (node.localName === "d") {
				return NodeFilter.FILTER_SKIP;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	);
	const seen: string[] = [];
	while (walker.nextNode()) {
		seen.push(walker.currentNode.localName);
	}
	expect(seen).toEqual(["a", "e"]);
});

test("a filter that re-enters its own walker throws", () => {
	const document = make();
	document.body.innerHTML = "<a></a>";
	const walker: any = document.createTreeWalker(
		document.body,
		NodeFilter.SHOW_ELEMENT,
		() => {
			walker.nextNode();
			return NodeFilter.FILTER_ACCEPT;
		},
	);
	expect(() => walker.nextNode()).toThrow();
});

/* ------------------------------------------------------ parsing and output */

test("innerHTML round-trips through the fragment parser", () => {
	const document = make();
	const node = document.createElement("div");
	node.innerHTML = "<p>one</p><p>two &amp; three</p>";
	expect(node.children.length).toBe(2);
	expect(node.innerHTML).toBe("<p>one</p><p>two &amp; three</p>");
	expect(node.textContent).toBe("onetwo & three");
});

test("innerHTML uses the context element's parsing rules", () => {
	const document = make();
	const table = document.createElement("table");
	table.innerHTML = "<tr><td>cell</td></tr>";
	expect(table.querySelector("td").textContent).toBe("cell");
});

test("outerHTML replaces the element in its parent", () => {
	const document = make();
	const parent = document.createElement("div");
	const child = document.createElement("span");
	parent.appendChild(child);
	child.outerHTML = "<i>a</i><i>b</i>";
	expect(parent.innerHTML).toBe("<i>a</i><i>b</i>");
	expect(child.parentNode).toBe(null);
});

test("a void element serializes without a closing tag", () => {
	const document = make();
	const node = document.createElement("div");
	node.innerHTML = "<br><img src=x>";
	expect(node.innerHTML).toBe('<br><img src="x">');
});

test("raw text children are not escaped", () => {
	const document = make();
	const node = document.createElement("div");
	node.innerHTML = "<style>a > b { }</style>";
	expect(node.innerHTML).toBe("<style>a > b { }</style>");
});

test("the parser puts a document in quirks mode without a doctype", () => {
	const noQuirks = parseHTMLDocument("<!doctype html><p>x");
	const quirks = parseHTMLDocument("<p>x");
	expect(noQuirks.compatMode).toBe("CSS1Compat");
	expect(quirks.compatMode).toBe("BackCompat");
});

test("insertAdjacentHTML places a fragment on all four sides", () => {
	const document = make();
	const parent = document.createElement("div");
	const node = document.createElement("span");
	parent.appendChild(node);
	node.insertAdjacentHTML("beforebegin", "<i>1</i>");
	node.insertAdjacentHTML("afterbegin", "<i>2</i>");
	node.insertAdjacentHTML("beforeend", "<i>3</i>");
	node.insertAdjacentHTML("afterend", "<i>4</i>");
	expect(parent.innerHTML).toBe(
		"<i>1</i><span><i>2</i><i>3</i></span><i>4</i>",
	);
});

/* ---------------------------------------------------------------- selectors */

test("querySelectorAll is static and querySelector reads the live tree", () => {
	const document = make();
	document.body.innerHTML = "<p class=x></p>";
	const found = document.querySelectorAll(".x");
	expect(found.length).toBe(1);
	document.body.appendChild(document.createElement("p")).className = "x";
	expect(found.length).toBe(1);
	expect(document.querySelectorAll(".x").length).toBe(2);
});

test("closest walks up from the element itself", () => {
	const document = make();
	document.body.innerHTML =
		"<div id=a><div id=b><span id=c></span></div></div>";
	const span = document.getElementById("c");
	expect(span.closest("span").id).toBe("c");
	expect(span.closest("div").id).toBe("b");
	expect(span.closest("#a").id).toBe("a");
	expect(span.closest("p")).toBe(null);
});

test("an invalid selector throws a SyntaxError", () => {
	const document = make();
	expect(() => document.querySelector("[")).toThrow();
	expect(() => document.body.matches("::")).toThrow();
});

/* --------------------------------------------------------------- namespaces */

test("lookupNamespaceURI and lookupPrefix read xmlns attributes", () => {
	const document = make();
	const bare = document.implementation.createDocument(
		"http://example.com/",
		"root",
		null,
	);
	const root = bare.documentElement;
	root.setAttributeNS(
		"http://www.w3.org/2000/xmlns/",
		"xmlns:x",
		"http://other.example/",
	);
	const child = bare.createElementNS("http://other.example/", "x:child");
	root.appendChild(child);
	expect(child.lookupNamespaceURI("x")).toBe("http://other.example/");
	expect(child.lookupPrefix("http://other.example/")).toBe("x");
	expect(root.isDefaultNamespace("http://example.com/")).toBe(true);
});

/* ------------------------------------------------------------------ events */

test("an event dispatched on a node walks its ancestors both ways", () => {
	const document = make();
	const outer = document.createElement("div");
	const inner = document.createElement("span");
	outer.appendChild(inner);
	document.body.appendChild(outer);
	const seen: string[] = [];
	outer.addEventListener("ping", () => seen.push("capture"), true);
	outer.addEventListener("ping", () => seen.push("bubble"));
	inner.addEventListener("ping", () => seen.push("target"));
	inner.dispatchEvent(new DOMEvent("ping", {bubbles: true}));
	expect(seen).toEqual(["capture", "target", "bubble"]);
});

test("a listener list is snapshotted, and a once listener is gone before it runs", () => {
	const document = make();
	const target = document.createElement("div");
	const seen: string[] = [];
	target.addEventListener("ping", () => {
		seen.push("first");
		target.addEventListener("ping", () => seen.push("added"));
	});
	target.addEventListener("ping", () => seen.push("second"), {once: true});
	target.dispatchEvent(new DOMEvent("ping"));
	expect(seen).toEqual(["first", "second"]);
	target.dispatchEvent(new DOMEvent("ping"));
	expect(seen).toEqual(["first", "second", "first", "added"]);
});

test("a stopped event stays stopped until it is initialized again", () => {
	const document = make();
	const target = document.createElement("div");
	let calls = 0;
	target.addEventListener("ping", () => calls++);
	const event = document.createEvent("Event");
	event.initEvent("ping", true, false);
	event.stopPropagation();
	target.dispatchEvent(event);
	expect(calls).toBe(0);
	event.initEvent("ping", true, false);
	target.dispatchEvent(event);
	expect(calls).toBe(1);
});

test("an uninitialized event cannot be dispatched", () => {
	const document = make();
	const target = document.createElement("div");
	const event = document.createEvent("Event");
	expect(() => target.dispatchEvent(event)).toThrow();
	event.initEvent("ping");
	expect(() => target.dispatchEvent(event)).not.toThrow();
});

test("a passive listener cannot cancel the event it hears", () => {
	const document = make();
	const target = document.createElement("div");
	target.addEventListener("ping", (event: any) => event.preventDefault(), {
		passive: true,
	});
	const passive = new DOMEvent("ping", {cancelable: true});
	expect(target.dispatchEvent(passive)).toBe(true);
	target.addEventListener("pong", (event: any) => event.preventDefault());
	const active = new DOMEvent("pong", {cancelable: true});
	expect(target.dispatchEvent(active)).toBe(false);
});

test("an aborted signal takes its listener with it", () => {
	const document = make();
	const target = document.createElement("div");
	const controller = new AbortController();
	let calls = 0;
	target.addEventListener("ping", () => calls++, {signal: controller.signal});
	target.dispatchEvent(new DOMEvent("ping"));
	controller.abort();
	target.dispatchEvent(new DOMEvent("ping"));
	expect(calls).toBe(1);
	expect(() =>
		target.addEventListener("ping", () => {}, {signal: {} as any}),
	).toThrow();
});

test("composedPath is the whole path while dispatching, and empty after", () => {
	const document = make();
	const outer = document.createElement("div");
	const inner = document.createElement("span");
	outer.appendChild(inner);
	document.body.appendChild(outer);
	let path: unknown[] = [];
	const event = new DOMEvent("ping", {bubbles: true});
	outer.addEventListener("ping", (e: any) => {
		path = e.composedPath();
	});
	inner.dispatchEvent(event);
	expect(path).toEqual([
		inner,
		outer,
		document.body,
		document.documentElement,
		document,
	]);
	expect(event.composedPath()).toEqual([]);
});

test("a listener object's handleEvent is looked up at every dispatch", () => {
	const document = make();
	const target = document.createElement("div");
	let lookups = 0;
	let calls = 0;
	target.addEventListener("ping", {
		get handleEvent() {
			lookups++;
			return () => calls++;
		},
	} as any);
	expect(lookups).toBe(0);
	target.dispatchEvent(new DOMEvent("ping"));
	target.dispatchEvent(new DOMEvent("ping"));
	expect(lookups).toBe(2);
	expect(calls).toBe(2);
});

/* ------------------------------------------------------- platform events */

test("an event here is a platform event, and a custom event here is both", () => {
	const event = new DOMEvent("ping");
	expect(event instanceof globalThis.Event).toBe(true);
	const custom = new DOMCustomEvent("ping", {detail: 1});
	expect(custom instanceof DOMEvent).toBe(true);
	expect(custom instanceof globalThis.Event).toBe(true);
	expect(custom.detail).toBe(1);
});

test("isTrusted reads false and cannot be redefined", () => {
	const event = new DOMEvent("ping");
	expect(event.isTrusted).toBe(false);
	expect(() =>
		Object.defineProperty(event, "isTrusted", {value: true}),
	).toThrow();
	expect(event.isTrusted).toBe(false);
});

test("the user agent's own events are trusted, click()'s is not", async () => {
	const document = make();
	const details = document.createElement("details");
	document.body.appendChild(details);
	let toggleTrusted: boolean | null = null;
	details.addEventListener("toggle", (event: any) => {
		toggleTrusted = event.isTrusted;
	});
	details.setAttribute("open", "");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(toggleTrusted).toBe(true);

	// click() fires a synthetic pointer event, which HTML says is untrusted:
	// a listener can tell it from a press the user made.
	const button = document.createElement("button");
	document.body.appendChild(button);
	let clickTrusted: boolean | null = null;
	button.addEventListener("click", (event: any) => {
		clickTrusted = event.isTrusted;
	});
	button.click();
	expect(clickTrusted).toBe(false);
});

test("a platform CustomEvent dispatches through the tree", () => {
	const document = make();
	const outer = document.createElement("div");
	const inner = document.createElement("span");
	outer.appendChild(inner);
	document.body.appendChild(outer);
	const seen: string[] = [];
	let path: unknown[] = [];
	let detail: unknown = null;
	let target: unknown = null;
	outer.addEventListener(
		"thing",
		(event: any) => {
			seen.push(`capture:${event.eventPhase}`);
			path = event.composedPath();
			target = event.target;
		},
		true,
	);
	inner.addEventListener("thing", (event: any) => {
		seen.push(`target:${event.eventPhase}`);
		detail = event.detail;
		expect(event.currentTarget).toBe(inner);
	});
	outer.addEventListener("thing", (event: any) => {
		seen.push(`bubble:${event.eventPhase}`);
		expect(event.currentTarget).toBe(outer);
	});
	const event = new globalThis.CustomEvent("thing", {
		bubbles: true,
		detail: {ok: true},
	});
	expect(inner.dispatchEvent(event as any)).toBe(true);
	expect(seen).toEqual(["capture:1", "target:2", "bubble:3"]);
	expect(detail).toEqual({ok: true});
	expect(target).toBe(inner);
	expect(path).toEqual([
		inner,
		outer,
		document.body,
		document.documentElement,
		document,
	]);
	expect(event.target).toBe(inner as any);
	expect(event.currentTarget).toBe(null);
	expect(event.eventPhase).toBe(0);
	expect(event.composedPath()).toEqual([]);
	expect(event.isTrusted).toBe(false);
});

test("preventDefault on a platform event is honored", () => {
	const document = make();
	const target = document.createElement("div");
	target.addEventListener("thing", (event: any) => event.preventDefault());
	const cancelable = new globalThis.CustomEvent("thing", {cancelable: true});
	expect(target.dispatchEvent(cancelable as any)).toBe(false);
	const uncancelable = new globalThis.CustomEvent("thing");
	expect(target.dispatchEvent(uncancelable as any)).toBe(true);
});

test("stopPropagation on a platform event ends the walk", () => {
	const document = make();
	const outer = document.createElement("div");
	const inner = document.createElement("span");
	outer.appendChild(inner);
	document.body.appendChild(outer);
	const seen: string[] = [];
	inner.addEventListener("thing", (event: any) => {
		seen.push("target");
		event.stopPropagation();
	});
	inner.addEventListener("thing", () => seen.push("also at target"));
	outer.addEventListener("thing", () => seen.push("bubble"));
	inner.dispatchEvent(
		new globalThis.CustomEvent("thing", {bubbles: true}) as any,
	);
	expect(seen).toEqual(["target", "also at target"]);
});

test("a subclass of the platform CustomEvent dispatches", () => {
	const document = make();
	const target = document.createElement("div");
	class ThingEvent extends globalThis.CustomEvent<{count: number}> {
		constructor(count: number) {
			super("thing", {bubbles: true, detail: {count}});
		}
	}
	let heard: unknown = null;
	document.body.appendChild(target);
	document.body.addEventListener("thing", (event: any) => {
		heard = event.detail;
		expect(event.target).toBe(target);
		expect(event instanceof ThingEvent).toBe(true);
	});
	target.dispatchEvent(new ThingEvent(3) as any);
	expect(heard).toEqual({count: 3});
});

test("dispatchEvent takes nothing but an event", () => {
	const document = make();
	const target = document.createElement("div");
	expect(() => target.dispatchEvent({type: "thing"} as any)).toThrow();
});

/* ------------------------------------------------------- mutation observers */

/** Let the mutation observer microtask run. */
function nextMicrotask(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(() => resolve()));
}

test("records arrive in a microtask, batched into one callback", async () => {
	const document = make();
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const batches: any[][] = [];
	const observer = new MutationObserver((records: any) =>
		batches.push(records),
	);
	observer.observe(parent, {childList: true, attributes: true});
	parent.appendChild(document.createElement("span"));
	parent.setAttribute("id", "x");
	expect(batches.length).toBe(0);
	await nextMicrotask();
	expect(batches.length).toBe(1);
	expect(batches[0].map((record: any) => record.type)).toEqual([
		"childList",
		"attributes",
	]);
	observer.disconnect();
});

test("takeRecords empties the queue, and the callback then has nothing to say", async () => {
	const document = make();
	const parent = document.createElement("div");
	const observer = new MutationObserver(() => {
		throw new Error("the callback must not run");
	});
	observer.observe(parent, {childList: true});
	parent.appendChild(document.createElement("span"));
	const records = observer.takeRecords();
	expect(records.length).toBe(1);
	expect(observer.takeRecords()).toEqual([]);
	await nextMicrotask();
	observer.disconnect();
});

test("disconnect drops the records queued before it", async () => {
	const document = make();
	const parent = document.createElement("div");
	let calls = 0;
	const observer = new MutationObserver(() => calls++);
	observer.observe(parent, {childList: true});
	parent.appendChild(document.createElement("span"));
	observer.disconnect();
	await nextMicrotask();
	expect(calls).toBe(0);
	expect(observer.takeRecords()).toEqual([]);
});

test("a removed subtree is still observed until the callback runs", async () => {
	const document = make();
	const parent = document.createElement("div");
	const child = document.createElement("span");
	parent.appendChild(child);
	document.body.appendChild(parent);
	const types: string[] = [];
	const observer = new MutationObserver((records: any) => {
		for (const record of records) {
			types.push(`${record.type}`);
		}
	});
	observer.observe(parent, {childList: true, subtree: true});
	parent.removeChild(child);
	// The removed child carries a transient registration, so what happens
	// inside it before the callback runs is still reported.
	child.appendChild(document.createElement("b"));
	await nextMicrotask();
	expect(types).toEqual(["childList", "childList"]);
	// The transient registration is dropped as the records are delivered.
	child.appendChild(document.createElement("i"));
	await nextMicrotask();
	expect(types).toEqual(["childList", "childList"]);
	observer.disconnect();
});

test("old values are recorded only where they were asked for", async () => {
	const document = make();
	const element = document.createElement("div");
	const text = document.createTextNode("one");
	element.appendChild(text);
	element.setAttribute("id", "before");
	const records: any[] = [];
	const observer = new MutationObserver((batch: any) => records.push(...batch));
	observer.observe(element, {
		attributes: true,
		attributeOldValue: true,
		attributeFilter: ["id"],
	});
	const plain = new MutationObserver((batch: any) => records.push(...batch));
	plain.observe(text, {characterData: true});
	element.setAttribute("id", "after");
	element.setAttribute("class", "ignored");
	text.data = "two";
	await nextMicrotask();
	expect(records.length).toBe(2);
	expect(records[0].attributeName).toBe("id");
	expect(records[0].oldValue).toBe("before");
	expect(records[1].type).toBe("characterData");
	expect(records[1].oldValue).toBe(null);
	observer.disconnect();
	plain.disconnect();
});

test("observe rejects options that ask for nothing, or for the impossible", () => {
	const document = make();
	const element = document.createElement("div");
	const observer = new MutationObserver(() => {});
	expect(() => observer.observe(element, {})).toThrow();
	expect(() => observer.observe(element, {subtree: true})).toThrow();
	expect(() =>
		observer.observe(element, {attributes: false, attributeOldValue: true}),
	).toThrow();
	expect(() =>
		observer.observe(element, {attributes: false, attributeFilter: ["id"]}),
	).toThrow();
	expect(() =>
		observer.observe(element, {
			characterData: false,
			characterDataOldValue: true,
		}),
	).toThrow();
	// An old value or a filter turns its own kind of observation on.
	expect(() =>
		observer.observe(element, {attributeOldValue: true}),
	).not.toThrow();
	observer.disconnect();
});

test("observing a node twice replaces the options it was observed with", async () => {
	const document = make();
	const element = document.createElement("div");
	const records: any[] = [];
	const observer = new MutationObserver((batch: any) => records.push(...batch));
	observer.observe(element, {attributes: true, attributeOldValue: true});
	observer.observe(element, {attributes: true});
	element.setAttribute("id", "x");
	element.setAttribute("id", "y");
	await nextMicrotask();
	expect(records.length).toBe(2);
	expect(records[1].oldValue).toBe(null);
	observer.disconnect();
});

/* -------------------------------------------------------------- serializing */

test("a document parsed from a string keeps its URL and content type", () => {
	const document = new DOMParser().parseFromString(
		"<!doctype html><title>t</title>",
		"text/html",
	);
	expect(document.contentType).toBe("text/html");
	expect(document.title).toBe("t");
});

test("a bare Text belongs to the document that made it", () => {
	const document = make();
	const text = document.createTextNode("x");
	expect(text.ownerDocument).toBe(document);
	expect(new Text("y") instanceof Text).toBe(true);
});

/* ------------------------------------------------------------ shadow trees */

test("a slot is assigned the host children whose name it carries", () => {
	const document = make();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shadow = host.attachShadow({mode: "open"});
	const named = document.createElement("slot");
	named.setAttribute("name", "a");
	const fallback = document.createElement("slot");
	shadow.appendChild(named);
	shadow.appendChild(fallback);
	const first = document.createElement("span");
	first.setAttribute("slot", "a");
	const second = document.createElement("span");
	host.appendChild(first);
	host.appendChild(second);
	expect(named.assignedNodes()).toEqual([first]);
	expect(fallback.assignedNodes()).toEqual([second]);
	expect(first.assignedSlot).toBe(named);
	first.removeAttribute("slot");
	expect(named.assignedNodes()).toEqual([]);
	expect(fallback.assignedNodes()).toEqual([first, second]);
});

test("only a host's own child is slotted, and only into the first slot of a name", () => {
	const document = make();
	const host = document.createElement("div");
	const shadow = host.attachShadow({mode: "open"});
	const first = document.createElement("slot");
	const second = document.createElement("slot");
	shadow.appendChild(first);
	shadow.appendChild(second);
	const wrapper = document.createElement("div");
	const grandchild = document.createElement("span");
	wrapper.appendChild(grandchild);
	host.appendChild(wrapper);
	expect(first.assignedNodes()).toEqual([wrapper]);
	expect(second.assignedNodes()).toEqual([]);
	expect(grandchild.assignedSlot).toBe(null);
});

test("a flattened assignment falls back to the slot's own children", () => {
	const document = make();
	const host = document.createElement("div");
	const shadow = host.attachShadow({mode: "open"});
	const slot = document.createElement("slot");
	const fallback = document.createElement("i");
	slot.appendChild(fallback);
	shadow.appendChild(slot);
	expect(slot.assignedNodes()).toEqual([]);
	expect(slot.assignedNodes({flatten: true})).toEqual([fallback]);
	const child = document.createElement("b");
	host.appendChild(child);
	expect(slot.assignedNodes({flatten: true})).toEqual([child]);
});

test("a manual slot takes the nodes it was handed, and only the host's own", () => {
	const document = make();
	const host = document.createElement("div");
	const shadow = host.attachShadow({mode: "open", slotAssignment: "manual"});
	const slot = document.createElement("slot");
	shadow.appendChild(slot);
	const inside = document.createElement("b");
	const outside = document.createElement("i");
	host.appendChild(inside);
	slot.assign(outside, inside);
	expect(slot.assignedNodes()).toEqual([inside]);
	host.appendChild(outside);
	expect(slot.assignedNodes()).toEqual([outside, inside]);
	expect(() => slot.assign(document.createComment("x"))).toThrow();
});

test("slotchange arrives on the microtask, after the observer's records", async () => {
	const document = make();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shadow = host.attachShadow({mode: "open"});
	const slot = document.createElement("slot");
	shadow.appendChild(slot);
	const order: string[] = [];
	const observer = new MutationObserver(() => order.push("records"));
	observer.observe(host, {childList: true});
	slot.addEventListener("slotchange", () => order.push("slotchange"));
	host.appendChild(document.createElement("b"));
	expect(order).toEqual([]);
	await nextMicrotask();
	expect(order).toEqual(["records", "slotchange"]);
	observer.disconnect();
});

test("an event leaves a shadow tree through the host, and only when composed", () => {
	const document = make();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shadow = host.attachShadow({mode: "open"});
	const inner = document.createElement("span");
	shadow.appendChild(inner);
	const seen: string[] = [];
	document.body.addEventListener("ping", (event: any) => {
		seen.push(event.target === host ? "host" : "other");
	});
	inner.dispatchEvent(new DOMEvent("ping", {bubbles: true, composed: true}));
	expect(seen).toEqual(["host"]);
	inner.dispatchEvent(new DOMEvent("ping", {bubbles: true}));
	expect(seen).toEqual(["host"]);
});

test("a closed tree is hidden from a composed path taken outside it", () => {
	const document = make();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shadow = host.attachShadow({mode: "closed"});
	const inner = document.createElement("span");
	shadow.appendChild(inner);
	let outside: any[] = [];
	let inside: any[] = [];
	document.body.addEventListener("ping", (event: any) => {
		outside = event.composedPath();
	});
	inner.addEventListener("ping", (event: any) => {
		inside = event.composedPath();
	});
	inner.dispatchEvent(new DOMEvent("ping", {bubbles: true, composed: true}));
	expect(inside[0]).toBe(inner);
	expect(inside.includes(host)).toBe(true);
	expect(outside.includes(inner)).toBe(false);
	expect(outside[0]).toBe(host);
});

test("a slotted node reaches its slot before its parent", () => {
	const document = make();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shadow = host.attachShadow({mode: "open"});
	const slot = document.createElement("slot");
	shadow.appendChild(slot);
	const child = document.createElement("b");
	host.appendChild(child);
	const path: string[] = [];
	slot.addEventListener("ping", () => path.push("slot"));
	shadow.addEventListener("ping", () => path.push("shadow"));
	host.addEventListener("ping", () => path.push("host"));
	child.dispatchEvent(new DOMEvent("ping", {bubbles: true, composed: true}));
	expect(path).toEqual(["slot", "shadow", "host"]);
});

test("a shadow root is cloned with its host only when it is clonable", () => {
	const document = make();
	const plain = document.createElement("div");
	plain.attachShadow({mode: "open"}).appendChild(document.createElement("b"));
	expect(plain.cloneNode(true).shadowRoot).toBe(null);
	const clonable = document.createElement("div");
	clonable
		.attachShadow({mode: "open", clonable: true})
		.appendChild(document.createElement("b"));
	const copy = clonable.cloneNode(true);
	expect(copy.shadowRoot.firstChild.localName).toBe("b");
	expect(copy.shadowRoot.clonable).toBe(true);
});

/* --------------------------------------------------------- custom elements */

test("a reaction runs after the mutation that enqueued it, in tree order", () => {
	const document = make();
	new Window(document);
	const order: string[] = [];
	customElements.define(
		"order-one",
		class extends HTMLElement {
			connectedCallback(): void {
				order.push(`connected ${(this as any).id}`);
			}
		},
	);
	const outer = document.createElement("div");
	const first = document.createElement("order-one");
	first.id = "first";
	const second = document.createElement("order-one");
	second.id = "second";
	outer.appendChild(first);
	outer.appendChild(second);
	expect(order).toEqual([]);
	document.body.appendChild(outer);
	expect(order).toEqual(["connected first", "connected second"]);
});

test("an attribute reaction is enqueued only for an observed name", () => {
	const document = make();
	new Window(document);
	const seen: unknown[][] = [];
	customElements.define(
		"order-two",
		class extends HTMLElement {
			static get observedAttributes(): string[] {
				return ["watched"];
			}

			attributeChangedCallback(...args: unknown[]): void {
				seen.push(args);
			}
		},
	);
	const element = document.createElement("order-two");
	element.setAttribute("ignored", "1");
	expect(seen).toEqual([]);
	element.setAttribute("watched", "1");
	expect(seen).toEqual([["watched", null, "1", null]]);
	element.removeAttribute("watched");
	expect(seen[1]).toEqual(["watched", "1", null, null]);
});

test("an upgrade replays the attributes and the connection it missed", () => {
	const document = make();
	new Window(document);
	const seen: string[] = [];
	const element = document.createElement("order-three");
	element.setAttribute("a", "1");
	document.body.appendChild(element);
	class OrderThree extends HTMLElement {
		static get observedAttributes(): string[] {
			return ["a"];
		}

		attributeChangedCallback(name: string): void {
			seen.push(`attribute ${name}`);
		}

		connectedCallback(): void {
			seen.push("connected");
		}
	}
	expect(element instanceof OrderThree).toBe(false);
	customElements.define("order-three", OrderThree);
	expect(element instanceof OrderThree).toBe(true);
	expect(seen).toEqual(["attribute a", "connected"]);
});

test("a definition is rejected by name and by a constructor already used", () => {
	expect(() =>
		customElements.define("nohyphen", class extends HTMLElement {}),
	).toThrow();
	const constructor = class extends HTMLElement {};
	customElements.define("order-four", constructor);
	expect(() => customElements.define("order-five", constructor)).toThrow();
	expect(() =>
		customElements.define("order-four", class extends HTMLElement {}),
	).toThrow();
	expect(customElements.get("order-four")).toBe(constructor);
	expect(customElements.getName(constructor)).toBe("order-four");
});

test("a constructor called on its own builds an element of its own name", () => {
	const document = make();
	new Window(document);
	class OrderSix extends HTMLElement {}
	customElements.define("order-six", OrderSix);
	const element: any = new OrderSix();
	expect(element.localName).toBe("order-six");
	expect(element.ownerDocument).toBe(document);
	expect(() => new HTMLElement()).toThrow();
});

/* ------------------------------------------ live range boundary adjustment */

/** A document with a paragraph of two text nodes, and a range over it. */
function withRange(): any {
	const document = make();
	new Window(document);
	const paragraph = document.createElement("p");
	paragraph.appendChild(document.createTextNode("abcdef"));
	paragraph.appendChild(document.createElement("b"));
	paragraph.appendChild(document.createTextNode("ghijkl"));
	document.body.appendChild(paragraph);
	return {document, paragraph, range: document.createRange()};
}

test("an insertion before a boundary point pushes it along by the count", () => {
	const {document, paragraph, range} = withRange();
	range.setStart(paragraph, 1);
	range.setEnd(paragraph, 3);
	paragraph.insertBefore(document.createElement("i"), paragraph.firstChild);
	expect(range.startOffset).toBe(2);
	expect(range.endOffset).toBe(4);
	const fragment = document.createDocumentFragment();
	fragment.appendChild(document.createElement("i"));
	fragment.appendChild(document.createElement("i"));
	paragraph.insertBefore(fragment, paragraph.firstChild);
	expect(range.startOffset).toBe(4);
	expect(range.endOffset).toBe(6);
	// An insertion after the boundary points leaves them where they are.
	paragraph.appendChild(document.createElement("i"));
	expect(range.startOffset).toBe(4);
	expect(range.endOffset).toBe(6);
});

test("a removal takes a boundary point inside it to the node's own place", () => {
	const {paragraph, range} = withRange();
	range.setStart(paragraph.firstChild, 2);
	range.setEnd(paragraph.lastChild, 2);
	paragraph.removeChild(paragraph.firstChild);
	expect(range.startContainer).toBe(paragraph);
	expect(range.startOffset).toBe(0);
	expect(range.endContainer).toBe(paragraph.lastChild);
	expect(range.endOffset).toBe(2);
});

test("a removal pulls back a boundary point after it in the same parent", () => {
	const {paragraph, range} = withRange();
	range.setStart(paragraph, 2);
	range.setEnd(paragraph, 3);
	paragraph.removeChild(paragraph.firstChild);
	expect(range.startOffset).toBe(1);
	expect(range.endOffset).toBe(2);
});

test("a removal takes a boundary point in a descendant with it", () => {
	const {document, paragraph, range} = withRange();
	const inner = paragraph.childNodes[1];
	inner.appendChild(document.createTextNode("deep"));
	range.setStart(inner.firstChild, 2);
	range.collapse(true);
	paragraph.removeChild(inner);
	expect(range.startContainer).toBe(paragraph);
	expect(range.startOffset).toBe(1);
	expect(range.collapsed).toBe(true);
});

test("replacing data moves the boundary points inside and after the run", () => {
	const {paragraph, range} = withRange();
	const text = paragraph.firstChild;
	range.setStart(text, 2);
	range.setEnd(text, 5);
	// A point inside the replaced run collapses onto its start.
	text.replaceData(1, 3, "");
	expect(range.startOffset).toBe(1);
	expect(range.endOffset).toBe(2);
	text.insertData(0, "xyz");
	expect(range.startOffset).toBe(4);
	expect(range.endOffset).toBe(5);
});

test("splitting a text node carries the boundary points past the split", () => {
	const {paragraph, range} = withRange();
	const text = paragraph.firstChild;
	range.setStart(text, 1);
	range.setEnd(text, 4);
	const rest = text.splitText(2);
	expect(range.startContainer).toBe(text);
	expect(range.startOffset).toBe(1);
	expect(range.endContainer).toBe(rest);
	expect(range.endOffset).toBe(2);
});

test("splitting a text node pushes a point that named its next sibling", () => {
	const {paragraph, range} = withRange();
	const text = paragraph.firstChild;
	range.setStart(paragraph, 1);
	range.setEnd(paragraph, 1);
	text.splitText(2);
	expect(range.startOffset).toBe(2);
	expect(range.endOffset).toBe(2);
});

test("normalize folds a boundary point into the node the data landed in", () => {
	const {document, paragraph, range} = withRange();
	paragraph.removeChild(paragraph.childNodes[1]);
	const first = paragraph.firstChild;
	const second = paragraph.lastChild;
	const third = document.createTextNode("mno");
	paragraph.appendChild(third);
	range.setStart(second, 2);
	range.setEnd(third, 1);
	paragraph.normalize();
	expect(range.startContainer).toBe(first);
	expect(range.startOffset).toBe(8);
	expect(range.endContainer).toBe(first);
	expect(range.endOffset).toBe(13);
});

test("normalize takes a point that named a folded node in its parent", () => {
	const {paragraph, range} = withRange();
	paragraph.removeChild(paragraph.childNodes[1]);
	range.setStart(paragraph, 1);
	range.setEnd(paragraph, 2);
	paragraph.normalize();
	expect(range.startContainer).toBe(paragraph.firstChild);
	expect(range.startOffset).toBe(6);
	expect(range.endContainer).toBe(paragraph);
	expect(range.endOffset).toBe(1);
});

/* -------------------------------------------------------- range extraction */

test("extracting a partially contained node clones it around the split", () => {
	const {document, paragraph, range} = withRange();
	const bold = paragraph.childNodes[1];
	bold.appendChild(document.createTextNode("BOLD"));
	range.setStart(paragraph.firstChild, 4);
	range.setEnd(bold.firstChild, 2);
	const fragment = range.extractContents();
	expect(fragment.childNodes.length).toBe(2);
	expect(fragment.firstChild.data).toBe("ef");
	expect(fragment.lastChild.localName).toBe("b");
	expect(fragment.lastChild.firstChild.data).toBe("BO");
	// What stays behind is the other side of both partial containments.
	expect(paragraph.firstChild.data).toBe("abcd");
	expect(bold.firstChild.data).toBe("LD");
	// The range collapses just after the child it started inside.
	expect(range.collapsed).toBe(true);
	expect(range.startContainer).toBe(paragraph);
	expect(range.startOffset).toBe(1);
});

test("cloning the contents leaves the tree alone", () => {
	const {document, paragraph, range} = withRange();
	const bold = paragraph.childNodes[1];
	bold.appendChild(document.createTextNode("BOLD"));
	range.setStart(paragraph.firstChild, 4);
	range.setEnd(bold.firstChild, 2);
	const fragment = range.cloneContents();
	expect(fragment.firstChild.data).toBe("ef");
	expect(fragment.lastChild.firstChild.data).toBe("BO");
	expect(paragraph.firstChild.data).toBe("abcdef");
	expect(bold.firstChild.data).toBe("BOLD");
	expect(range.collapsed).toBe(false);
});

test("a whole contained child moves into the fragment, a doctype throws", () => {
	const {document, paragraph, range} = withRange();
	const bold = paragraph.childNodes[1];
	range.setStart(paragraph, 1);
	range.setEnd(paragraph, 2);
	const fragment = range.extractContents();
	expect(fragment.firstChild).toBe(bold);
	expect(paragraph.childNodes.length).toBe(2);
	const bare = document.implementation.createDocument(null, null, null);
	bare.appendChild(bare.implementation.createDocumentType("html", "", ""));
	bare.appendChild(bare.createElement("html"));
	const over = bare.createRange();
	over.selectNodeContents(bare);
	expect(() => over.extractContents()).toThrow();
	expect(bare.doctype).not.toBe(null);
});

test("inserting into a range splits the text it starts inside", () => {
	const {document, paragraph, range} = withRange();
	range.setStart(paragraph.firstChild, 3);
	range.collapse(true);
	range.insertNode(document.createElement("i"));
	expect(paragraph.childNodes.length).toBe(5);
	expect(paragraph.firstChild.data).toBe("abc");
	expect(paragraph.childNodes[1].localName).toBe("i");
	expect(paragraph.childNodes[2].data).toBe("def");
	// A collapsed range grows to hold what was inserted into it.
	expect(range.endContainer).toBe(paragraph);
	expect(range.endOffset).toBe(2);
});

test("surrounding the contents refuses a partially contained element", () => {
	const {document, paragraph, range} = withRange();
	const bold = paragraph.childNodes[1];
	bold.appendChild(document.createTextNode("BOLD"));
	range.setStart(paragraph.firstChild, 2);
	range.setEnd(bold.firstChild, 2);
	expect(() => range.surroundContents(document.createElement("u"))).toThrow();
	range.setEnd(paragraph.firstChild, 4);
	range.surroundContents(document.createElement("u"));
	expect(paragraph.childNodes[1].localName).toBe("u");
	expect(paragraph.childNodes[1].textContent).toBe("cd");
	expect(range.toString()).toBe("cd");
});

/* --------------------------------------------------------------- selection */

test("the selection follows its range, and the range follows the tree", () => {
	const {document, paragraph, range} = withRange();
	const selection = document.getSelection();
	expect(selection.rangeCount).toBe(0);
	expect(selection.type).toBe("None");
	range.setStart(paragraph.firstChild, 1);
	range.setEnd(paragraph.firstChild, 4);
	selection.addRange(range);
	expect(selection.rangeCount).toBe(1);
	expect(selection.getRangeAt(0)).toBe(range);
	expect(selection.type).toBe("Range");
	expect(selection.anchorNode).toBe(paragraph.firstChild);
	expect(selection.anchorOffset).toBe(1);
	expect(selection.toString()).toBe("bcd");
	paragraph.firstChild.insertData(0, "xy");
	expect(selection.anchorOffset).toBe(3);
	expect(selection.toString()).toBe("bcd");
	selection.removeAllRanges();
	expect(selection.rangeCount).toBe(0);
	expect(selection.anchorNode).toBe(null);
});

test("a backward selection reports its anchor at the range's end", () => {
	const {document, paragraph} = withRange();
	const selection = document.getSelection();
	const text = paragraph.firstChild;
	selection.setBaseAndExtent(text, 4, text, 1);
	expect(selection.anchorOffset).toBe(4);
	expect(selection.focusOffset).toBe(1);
	expect(selection.direction).toBe("backward");
	expect(selection.getRangeAt(0).startOffset).toBe(1);
	selection.extend(text, 6);
	expect(selection.direction).toBe("forward");
	expect(selection.anchorOffset).toBe(4);
	expect(selection.focusOffset).toBe(6);
});

test("a selection that crosses a shadow boundary keeps composed points", () => {
	const {document, paragraph} = withRange();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = host.attachShadow({mode: "open"});
	root.appendChild(document.createTextNode("inside"));
	const selection = document.getSelection();
	selection.setBaseAndExtent(paragraph.firstChild, 1, root.firstChild, 3);
	// The range collapses where the two trees part; the composed range does not.
	expect(selection.getRangeAt(0).collapsed).toBe(true);
	const composed = selection.getComposedRanges({shadowRoots: [root]})[0];
	expect(composed.startContainer).toBe(paragraph.firstChild);
	expect(composed.startOffset).toBe(1);
	expect(composed.endContainer).toBe(root.firstChild);
	expect(composed.endOffset).toBe(3);
	// With no shadow root given, the end rescopes to the host's own place.
	const rescoped = selection.getComposedRanges()[0];
	expect(rescoped.endContainer).toBe(document.body);
	expect(rescoped.endOffset).toBe(2);
});

test("a selectionchange event is fired once a task, at the document", () => {
	const {document, paragraph} = withRange();
	const selection = document.getSelection();
	let fired = 0;
	document.addEventListener("selectionchange", () => fired++);
	selection.collapse(paragraph.firstChild, 1);
	selection.collapse(paragraph.firstChild, 2);
	expect(fired).toBe(0);
	return new Promise<void>((resolve) => {
		setTimeout(() => {
			expect(fired).toBe(1);
			resolve();
		}, 0);
	});
});

/* --------------------------------------------------- the input value model */

test("an input answers with its attribute until something writes a value", () => {
	const document = make();
	const input = document.createElement("input");
	input.setAttribute("value", "from the attribute");
	expect(input.value).toBe("from the attribute");
	expect(input.defaultValue).toBe("from the attribute");
	input.setAttribute("value", "still the attribute");
	expect(input.value).toBe("still the attribute");
	input.value = "written";
	expect(input.value).toBe("written");
	expect(input.defaultValue).toBe("still the attribute");
	input.setAttribute("value", "ignored now");
	expect(input.value).toBe("written");
	expect(input.defaultValue).toBe("ignored now");
});

test("a form reset puts a dirty input back to its attribute", () => {
	const document = make();
	document.body.innerHTML =
		"<form><input name=a value=default><input type=checkbox checked></form>";
	const form = document.querySelector("form");
	const [text, box] = form.elements;
	text.value = "typed";
	box.checked = false;
	expect(text.value).toBe("typed");
	expect(box.checked).toBe(false);
	form.reset();
	expect(text.value).toBe("default");
	expect(box.checked).toBe(true);
});

test("a checkbox's checked attribute stops moving once checked is written", () => {
	const document = make();
	const box = document.createElement("input");
	box.type = "checkbox";
	expect(box.checked).toBe(false);
	box.setAttribute("checked", "");
	expect(box.checked).toBe(true);
	box.checked = false;
	box.removeAttribute("checked");
	box.setAttribute("checked", "");
	expect(box.checked).toBe(false);
	expect(box.defaultChecked).toBe(true);
});

test("a clone carries the value and the checkedness that were written", () => {
	const document = make();
	const input = document.createElement("input");
	input.value = "typed";
	const box = document.createElement("input");
	box.type = "checkbox";
	box.checked = true;
	expect(input.cloneNode().value).toBe("typed");
	expect(box.cloneNode().checked).toBe(true);
	const plain = document.createElement("input");
	plain.setAttribute("value", "attribute");
	expect(plain.cloneNode().value).toBe("attribute");
});

test("checking one radio button unchecks the rest of its group", () => {
	const document = make();
	document.body.innerHTML =
		"<form><input type=radio name=g value=1><input type=radio name=g value=2>" +
		"<input type=radio name=other value=3></form>";
	const [first, second, other] = document.querySelectorAll("input");
	first.checked = true;
	other.checked = true;
	expect(first.checked).toBe(true);
	second.checked = true;
	expect(first.checked).toBe(false);
	expect(second.checked).toBe(true);
	expect(other.checked).toBe(true);
});

/* ------------------------------------------------------------- form owners */

test("a control's form owner is the form above it", () => {
	const document = make();
	document.body.innerHTML = "<form id=f><fieldset><input></fieldset></form>";
	const form = document.getElementById("f");
	const input = document.querySelector("input");
	expect(input.form).toBe(form);
	expect(form.elements.length).toBe(2);
});

test("a form attribute names the owner, and an unknown one leaves none", () => {
	const document = make();
	document.body.innerHTML =
		"<form id=outer><input id=a form=other></form><form id=other></form>" +
		"<input id=b form=missing>";
	const other = document.getElementById("other");
	expect(document.getElementById("a").form).toBe(other);
	expect(document.getElementById("b").form).toBe(null);
	expect(other.elements.length).toBe(1);
	expect(document.getElementById("outer").elements.length).toBe(0);
});

test("a disconnected control has no owner, and gains one on insertion", () => {
	const document = make();
	document.body.innerHTML = "<form id=f></form>";
	const form = document.getElementById("f");
	const input = document.createElement("input");
	expect(input.form).toBe(null);
	form.appendChild(input);
	expect(input.form).toBe(form);
	input.remove();
	expect(input.form).toBe(null);
});

test("a label reaches its control by for, and by containing it", () => {
	const document = make();
	document.body.innerHTML =
		"<label for=c>one</label><input id=c><label>two<input id=d></label>";
	const [byFor, byContent] = document.querySelectorAll("label");
	expect(byFor.control).toBe(document.getElementById("c"));
	expect(byContent.control).toBe(document.getElementById("d"));
	expect([...document.getElementById("c").labels]).toEqual([byFor]);
});

test("a label's click is its control's click", () => {
	const document = make();
	document.body.innerHTML = "<label><input type=checkbox></label>";
	const label = document.querySelector("label");
	const box = document.querySelector("input");
	label.click();
	expect(box.checked).toBe(true);
});

test("a disabled fieldset disables what its legend does not hold", () => {
	const document = make();
	document.body.innerHTML =
		"<fieldset disabled><legend><input id=inLegend></legend>" +
		"<input id=inBody></fieldset>";
	const inLegend = document.getElementById("inLegend");
	const inBody = document.getElementById("inBody");
	let clicked = 0;
	inBody.addEventListener("click", () => clicked++);
	inBody.click();
	expect(clicked).toBe(0);
	let allowed = 0;
	inLegend.addEventListener("click", () => allowed++);
	inLegend.click();
	expect(allowed).toBe(1);
});

/* -------------------------------------------------------- template content */

test("a template's children are parsed into its content, not into the tree", () => {
	const document = parseHTMLDocument(
		"<body><template><div id=inside>text</div></template></body>",
	) as any;
	const template = document.querySelector("template");
	expect(template.childNodes.length).toBe(0);
	expect(template.content.childNodes.length).toBe(1);
	expect(document.getElementById("inside")).toBe(null);
	expect(template.content.firstChild.id).toBe("inside");
});

test("cloning a template deep-clones the content it holds", () => {
	const document = make();
	const template = document.createElement("template");
	template.innerHTML = "<span>one</span><span>two</span>";
	const shallow = template.cloneNode();
	expect(shallow.content.childNodes.length).toBe(2);
	expect(shallow.content.firstChild).not.toBe(template.content.firstChild);
	expect(shallow.content.firstChild.textContent).toBe("one");
	const deep = template.cloneNode(true);
	expect(deep.childNodes.length).toBe(0);
	expect(deep.content.childNodes.length).toBe(2);
});

test("a template inside a template clones the whole nest", () => {
	const document = make();
	const template = document.createElement("template");
	template.innerHTML = "<template><b>deep</b></template>";
	const copy = template.cloneNode(true);
	const inner = copy.content.firstChild;
	expect(inner.content.firstChild.textContent).toBe("deep");
	expect(inner.content.firstChild).not.toBe(
		template.content.firstChild.content.firstChild,
	);
});

test("a template's content moves with it to another document", () => {
	const document = make();
	const other = createHTMLDocument("") as any;
	const template = document.createElement("template");
	template.innerHTML = "<i>moved</i>";
	other.adoptNode(template);
	expect(template.content.ownerDocument).toBe(other);
	expect(template.content.firstChild.ownerDocument).toBe(other);
});

/* ------------------------------------------- event handler IDL attributes */

test("the handler attributes answer `in` on the interfaces that carry them", () => {
	const document = make();
	const div = document.createElement("div");
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	// A framework picks property assignment over addEventListener by probing
	// exactly this, so a name the mixin defines has to be there before
	// anything is assigned to it.
	for (const name of ["onclick", "onkeydown", "oninput", "onwheel"]) {
		expect(name in div).toBe(true);
		expect(name in svg).toBe(true);
		expect(name in document).toBe(true);
	}
	// The mixin is the whole table, not the popular part of it.
	expect("onanimationstart" in div).toBe(true);
	expect("onpointerrawupdate" in div).toBe(true);
	expect("onsecuritypolicyviolation" in div).toBe(true);
	expect("oncopy" in div).toBe(true);
	// Document's own, and the Fullscreen API's.
	expect("onreadystatechange" in document).toBe(true);
	expect("onfullscreenchange" in document).toBe(true);
	// A handler attribute is a member of the interface, not of the instance.
	expect(Object.prototype.hasOwnProperty.call(div, "onclick")).toBe(false);
	// The window handlers are the window's; an ordinary element has none.
	expect("onhashchange" in div).toBe(false);
});

test("an assigned handler runs with the event, and reads back as itself", () => {
	const document = make();
	const div = document.createElement("div");
	expect(div.onclick).toBe(null);
	const seen: any[] = [];
	const handler = (event: any) => seen.push(event.type);
	div.onclick = handler;
	expect(div.onclick).toBe(handler);
	div.dispatchEvent(new DOMEvent("click"));
	expect(seen).toEqual(["click"]);
});

test("a handler keeps its place among the listeners around it", () => {
	const document = make();
	const div = document.createElement("div");
	const order: string[] = [];
	div.addEventListener("click", () => order.push("before"));
	div.onclick = () => order.push("first handler");
	div.addEventListener("click", () => order.push("after"));
	// Reassignment changes what runs, never when it runs.
	div.onclick = () => order.push("second handler");
	div.dispatchEvent(new DOMEvent("click"));
	expect(order).toEqual(["before", "second handler", "after"]);

	// Null removes the listener, so the next assignment starts a new place --
	// at the end, behind the listener that was added after it.
	order.length = 0;
	div.onclick = null;
	expect(div.onclick).toBe(null);
	div.dispatchEvent(new DOMEvent("click"));
	expect(order).toEqual(["before", "after"]);

	order.length = 0;
	div.onclick = () => order.push("third handler");
	div.dispatchEvent(new DOMEvent("click"));
	expect(order).toEqual(["before", "after", "third handler"]);
});

test("a handler that answers false cancels the event", () => {
	const document = make();
	const div = document.createElement("div");
	div.onclick = () => false;
	const canceled = new DOMEvent("click", {cancelable: true});
	expect(div.dispatchEvent(canceled)).toBe(false);
	expect(canceled.defaultPrevented).toBe(true);
	// Anything else is not an answer: only false cancels.
	div.onclick = () => 0;
	const uncanceled = new DOMEvent("click", {cancelable: true});
	expect(div.dispatchEvent(uncanceled)).toBe(true);
});

test("a handler that throws reports rather than throwing out of the dispatch", () => {
	const document = make();
	const div = document.createElement("div");
	const after: string[] = [];
	div.onclick = () => {
		throw new Error("handler");
	};
	div.addEventListener("click", () => after.push("ran"));
	const reported: unknown[] = [];
	const original = (globalThis as any).reportError;
	(globalThis as any).reportError = (error: unknown) => reported.push(error);
	try {
		expect(() => div.dispatchEvent(new DOMEvent("click"))).not.toThrow();
	} finally {
		(globalThis as any).reportError = original;
	}
	expect(reported.length).toBe(1);
	expect(after).toEqual(["ran"]);
});

test("a value that is not an object is null, per the callback's legacy rule", () => {
	const document = make();
	const div = document.createElement("div");
	div.onclick = () => {};
	div.onclick = 5 as any;
	expect(div.onclick).toBe(null);
	div.dispatchEvent(new DOMEvent("click"));
	// An object that is not callable is held, and throws when the event
	// arrives -- which is reported, not thrown.
	const object = {};
	div.onclick = object as any;
	expect(div.onclick).toBe(object);
});

test("a body's window handlers are its window's, and are dropped without one", () => {
	const document = make();
	const body = document.body as any;
	// The set that forwards; the rest of the mixin stays the element's own.
	expect("onload" in body).toBe(true);
	expect("onhashchange" in body).toBe(true);
	// A document with no window has no event handler target at all, so the
	// write goes nowhere and the read answers null.
	expect(body.onload).toBe(null);
	body.onload = () => {};
	expect(body.onload).toBe(null);

	const handler = () => {};
	const view: any = new Window(document);
	body.onload = handler;
	expect(view.onload).toBe(handler);
	expect(body.onload).toBe(handler);
});

test("one predicate names the elements that edit text", () => {
	// The paint, the caret scroll and the press-to-park default action all ask
	// this question, and a spelling that forgot `hidden` sent a press on a
	// hidden input down the field-drag path.
	const document = make();
	const toolkit = installUAEngine(document, {} as never);
	const field = (tag: string, type?: string) => {
		const element = document.createElement(tag);
		if (type !== undefined) {
			(element as any).type = type;
		}
		return toolkit.isTextField(element as any);
	};

	expect(field("textarea")).toBe(true);
	for (const type of [
		"text",
		"search",
		"url",
		"tel",
		"password",
		"number",
		"email",
		"date",
	]) {
		expect(field("input", type)).toBe(true);
	}
	for (const type of ["checkbox", "radio", "hidden"]) {
		expect(field("input", type)).toBe(false);
	}
	expect(field("div")).toBe(false);
});

test("the selection APIs answer null where they do not apply, and throw when set", () => {
	// HTML draws the line between reading and writing: a getter answers null
	// for an input whose type the selection APIs do not apply to, while the
	// setters and setSelectionRange throw.
	const document = make();
	const applies = ["text", "search", "url", "tel", "password"];
	const doesNot = ["email", "number", "checkbox", "radio", "submit"];

	for (const type of applies) {
		const input = document.createElement("input");
		input.type = type;
		input.value = "abc";
		expect(input.selectionStart).toBe(3);
		expect(input.selectionEnd).toBe(3);
		expect(input.selectionDirection).toBe("none");
		input.setSelectionRange(1, 2);
		expect(input.selectionStart).toBe(1);
		input.selectionStart = 0;
		expect(input.selectionStart).toBe(0);
	}

	for (const type of doesNot) {
		const input = document.createElement("input");
		input.type = type;
		input.value = "abc";
		expect(input.selectionStart).toBe(null);
		expect(input.selectionEnd).toBe(null);
		expect(input.selectionDirection).toBe(null);
		expect(() => {
			input.selectionStart = 1;
		}).toThrow();
		expect(() => {
			input.selectionEnd = 1;
		}).toThrow();
		expect(() => input.setSelectionRange(0, 1)).toThrow();
		// select() on an input it does not apply to is a no-op, not a throw.
		input.select();
	}
});

test("createContextualFragment parses in the range's context", () => {
	const document = make();
	const div = document.createElement("div");
	const text = document.createTextNode("anchor");
	div.appendChild(text);
	document.body.appendChild(div);

	const range = document.createRange();
	range.setStart(text, 0);
	const fragment = range.createContextualFragment("<b>bold</b> tail");
	expect(fragment.childNodes.length).toBe(2);
	expect((fragment.firstChild as Element).tagName).toBe("B");
	expect(fragment.lastChild!.textContent).toBe(" tail");

	// A range anchored at the document parses against the body.
	const documentRange = document.createRange();
	documentRange.setStart(document, 0);
	const fromDocument = documentRange.createContextualFragment("<i>x</i>");
	expect((fromDocument.firstChild as Element).tagName).toBe("I");
});

test("focus reaches into shadow trees, and each scope retargets", () => {
	const document = make();
	const host = document.createElement("div");
	host.id = "host";
	document.body.appendChild(host);
	const root = host.attachShadow({mode: "open"});
	const mid = document.createElement("div");
	root.appendChild(mid);
	const nested = mid.attachShadow({mode: "open"});
	const button = document.createElement("button");
	nested.appendChild(button);

	// Nothing focused: the roots answer null, not the document's body.
	expect(root.activeElement).toBe(null);
	expect(nested.activeElement).toBe(null);

	button.focus();
	// The document collapses shadow content to the host; each root
	// retargets to its own descendant on the chain.
	expect(document.activeElement).toBe(host);
	expect(root.activeElement).toBe(mid);
	expect(nested.activeElement).toBe(button);
});
