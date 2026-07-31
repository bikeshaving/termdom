/**
 * Native Shadow DOM, end to end: attachShadow() content through layout and
 * paint. The walker understood shadow roots for years, but only via
 * termdom's private symbol -- native attachShadow content CRASHED layout
 * (a shadow child's parentElement is null; the inline-run machinery threw)
 * and the symbol path never rendered end-to-end at all. Now the two
 * mechanisms have distinct jobs: native attachShadow is the AUTHOR path
 * (standard web components), the symbol slot is reserved for UA-internal
 * widget trees (closed to DOM APIs, like a browser input's own internals).
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

test("attachShadow content renders, replacing the host's light children", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	host.textContent = "LIGHT";
	const root = host.attachShadow({mode: "open"});
	const inner = document.createElement("span");
	inner.textContent = "SHADOW-CONTENT";
	root.appendChild(inner);
	document.body.appendChild(host);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("SHADOW-CONTENT");
	expect(output).not.toContain("LIGHT"); // composed tree wins, as in a browser

	dom.dispose();
});

test("mutations inside a shadow root invalidate and repaint", async () => {
	// Per spec a document-rooted MutationObserver never sees into shadow
	// trees; each attached root is enrolled in the observer at attachShadow
	// time.
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	const inner = document.createElement("span");
	inner.textContent = "BEFORE";
	root.appendChild(inner);
	document.body.appendChild(host);
	await nextFrame(dom);
	expect(terminal.getPlainText()).toContain("BEFORE");

	inner.textContent = "AFTER";
	await nextFrame(dom);
	const output = terminal.getPlainText();
	expect(output).toContain("AFTER");
	expect(output).not.toContain("BEFORE");

	dom.dispose();
});

test("block structure inside a shadow root lays out normally", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<div>first row</div><div>second row</div>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["first row", "second row"]);

	dom.dispose();
});

// Slot projection: the composed tree interleaves shadow chrome with light
// children pulled through <slot>s. The walker's hops are stateless, so
// projection rides on jsdom's live slot assignment (assignedSlot /
// assignedNodes) rather than any cached mapping.

test("default slot projects light children between shadow siblings", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<div>HEADER</div><slot></slot><div>FOOTER</div>`;
	const light = document.createElement("div");
	light.textContent = "PROJECTED";
	host.appendChild(light);
	document.body.appendChild(host);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["HEADER", "PROJECTED", "FOOTER"]);

	dom.dispose();
});

test("named slots project by slot attribute, in shadow-tree order", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	// Shadow order reverses the light order: the slot's position wins.
	root.innerHTML = `<div><slot name="second"></slot></div><div><slot name="first"></slot></div>`;
	host.innerHTML = `<span slot="first">ALPHA</span><span slot="second">BETA</span>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	const lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["BETA", "ALPHA"]);

	dom.dispose();
});

test("a slot with nothing assigned renders its fallback content", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<slot>FALLBACK</slot>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("FALLBACK");

	dom.dispose();
});

test("assigned content replaces fallback; unassigned light children don't render", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<slot name="a">FALLBACK</slot>`;
	host.innerHTML = `<span slot="a">ASSIGNED</span><span slot="nowhere">ORPHAN</span>`;
	document.body.appendChild(host);
	await nextFrame(dom);

	const output = terminal.getPlainText();
	expect(output).toContain("ASSIGNED");
	expect(output).not.toContain("FALLBACK");
	expect(output).not.toContain("ORPHAN");

	dom.dispose();
});

test("bare text light children project through the default slot", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<span>[</span><slot></slot><span>]</span>`;
	host.appendChild(document.createTextNode("TEXTCHILD"));
	document.body.appendChild(host);
	await nextFrame(dom);

	expect(terminal.getPlainText()).toContain("[TEXTCHILD]");

	dom.dispose();
});

test("reassigning a slot attribute reprojects on the next frame", async () => {
	const terminal = new MockProcess({rows: 6, cols: 60});
	const dom = new TermDOM({process: terminal});
	const {document} = dom;
	const host = document.createElement("div");
	const root = host.attachShadow({mode: "open"});
	root.innerHTML = `<div>A:<slot name="a"></slot></div><div>B:<slot name="b"></slot></div>`;
	const item = document.createElement("span");
	item.setAttribute("slot", "a");
	item.textContent = "ITEM";
	host.appendChild(item);
	document.body.appendChild(host);
	await nextFrame(dom);
	let lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["A:ITEM", "B:"]);

	item.setAttribute("slot", "b");
	await nextFrame(dom);
	lines = terminal
		.getPlainText()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(lines).toEqual(["A:", "B:ITEM"]);

	dom.dispose();
});
