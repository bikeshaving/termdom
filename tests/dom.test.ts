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
	createHTMLDocument,
	DOMParser,
	Event as DOMEvent,
	MutationObserver,
	NodeFilter,
	parseHTMLDocument,
	Text,
} from "../src/internal/dom.js";

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
			if (node.localName === "b") return NodeFilter.FILTER_REJECT;
			if (node.localName === "d") return NodeFilter.FILTER_SKIP;
			return NodeFilter.FILTER_ACCEPT;
		},
	);
	const seen: string[] = [];
	while (walker.nextNode()) seen.push(walker.currentNode.localName);
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
		for (const record of records) types.push(`${record.type}`);
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
